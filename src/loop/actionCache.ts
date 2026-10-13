import { hashString } from "./loopGuard";

/**
 * Local action cache for browse_task's step loop (Stagehand-style: replay a
 * known action against the current page with zero inference, self-heal by
 * deleting the entry the moment a replay turns out wrong): skip a paid
 * /api/browse/step (Jev) call when the same goal has already been solved,
 * at this exact point in the flow (same page identity + same element set +
 * same history + same scroll position), on this exact page before.
 *
 * (browse_act's separate `element` natural-language-targeting cache was
 * removed — a code review found it duplicated most of this module's
 * machinery for a much lower-value, harder-to-verify-safe path; `element`
 * now always resolves through /api/browse/locate.)
 *
 * EXACT-INPUT MEMO, not a fuzzy lookup: a code review found a previous
 * normalized/truncated key unsafe (a stale entry could keep matching a page
 * whose element set or history had actually moved on, since the key ignored
 * both), and a live bench found it almost never hit anyway (goal wording
 * varies enough that lowercasing/URL-stripping alone rarely produced a
 * repeat key). Trying to fuzzy-match text that varies unpredictably is a
 * losing trade: it buys a few extra hits at the cost of occasionally
 * replaying the WRONG action against a page that only superficially
 * resembles the one the entry was learned on. This cache instead only ever
 * hits on a byte-identical replay of the same goal against the same page at
 * the same point in the flow — a narrower but SAFE cache, which is the
 * point: see `buildStepCacheKey` below for exactly what "identical" means.
 *
 * The *value* is never the answer itself — it's a {labelHash, tag, role?}
 * fingerprint of the element that worked, re-resolved against a FRESH
 * snapshot every time by requiring an exact, UNIQUE labelHash+tag(+role)
 * match (`resolveCachedIndex`). That's what makes a stale entry self-heal
 * instead of silently misfiring: an ambiguous or absent match is treated as
 * a cache miss, and an entry whose replay actually runs but fails (rejected,
 * or landed no effect) is deleted by the caller before falling back to the
 * normal Jev path. Typed text is never stored verbatim either — see
 * `CachedStep.textRange`'s doc comment — and neither is the element's own
 * label: only its hash is kept (see "no raw text persisted" below).
 *
 * COLLISION SAFETY: `buildStepCacheKey` combines TWO independently-seeded
 * FNV-1a hashes (the canonical key string, and the same string reversed —
 * see `secondHash`) into one 64-bit-ish key, which makes an accidental key
 * collision between two genuinely different contexts astronomically
 * unlikely but not literally impossible for a 32-bit-per-hash scheme run
 * over enough entries. Belt-and-suspenders: every entry also stores a
 * `verify` block — hashes of the goal and of the element-set fingerprint,
 * computed with the SECOND seed only (so a `key` collision, which already
 * required both hashes to collide, would additionally need both `verify`
 * hashes to collide too) — and `lookupStepCache` recomputes and compares
 * both against the CURRENT goal/elements before returning a hit; either
 * mismatching is treated as a miss and the entry is deleted rather than
 * risked. Collisions here are self-healing, not "guaranteed" impossible —
 * the verify check is what makes a false hit non-catastrophic, not a claim
 * that hashing can't collide.
 *
 * Storage: a single localStorage blob (key `pen.browseActionCache.v1`),
 * capped at MAX_ENTRIES total entries (LRU eviction by `lastUsed`) and
 * TTL_MS old. Every access is wrapped in try/catch and degrades to a no-op
 * — private browsing, a quota error, `localStorage` missing entirely (SSR/
 * non-browser test environments) all just mean "no cache today", never a
 * thrown error. Kill switch: `localStorage.pen.browseActionCache = "off"`.
 */

export const ACTION_CACHE_STORAGE_KEY = "pen.browseActionCache.v1";
export const ACTION_CACHE_KILL_SWITCH_KEY = "pen.browseActionCache";
export const ACTION_CACHE_MAX_ENTRIES = 500;
export const ACTION_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

interface StoredEntry {
  value: unknown;
  hits: number;
  lastUsed: number;
}
type StoredCache = Record<string, StoredEntry>;

export function isActionCacheEnabled(): boolean {
  try {
    return localStorage.getItem(ACTION_CACHE_KILL_SWITCH_KEY) !== "off";
  } catch {
    // No localStorage at all (SSR, some test environments) — the read/write
    // helpers below independently no-op in that case too, so treating the
    // cache as "not disabled" here is harmless; nothing will ever actually
    // be read or written.
    return true;
  }
}

/** Reads the store, dropping any entry older than ACTION_CACHE_TTL_MS. */
function readStore(): StoredCache {
  try {
    const raw = localStorage.getItem(ACTION_CACHE_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const now = Date.now();
    const fresh: StoredCache = {};
    for (const [key, entry] of Object.entries(parsed as StoredCache)) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof entry.lastUsed === "number" &&
        now - entry.lastUsed < ACTION_CACHE_TTL_MS
      ) {
        fresh[key] = entry;
      }
    }
    return fresh;
  } catch {
    return {};
  }
}

/** Writes the store, evicting the least-recently-used entries first when
 * over ACTION_CACHE_MAX_ENTRIES. */
function writeStore(store: StoredCache): void {
  try {
    const entries = Object.entries(store).sort((a, b) => b[1].lastUsed - a[1].lastUsed);
    const trimmed: StoredCache = {};
    for (const [key, entry] of entries.slice(0, ACTION_CACHE_MAX_ENTRIES)) {
      trimmed[key] = entry;
    }
    localStorage.setItem(ACTION_CACHE_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Quota exceeded, private mode, no localStorage — degrade to a no-op
    // write rather than throwing out of a browse_* tool handler.
  }
}

function getRawEntry(key: string): StoredEntry | undefined {
  if (!isActionCacheEnabled()) return undefined;
  return readStore()[key];
}

function setRawEntry(key: string, value: unknown): void {
  if (!isActionCacheEnabled()) return;
  const store = readStore();
  store[key] = { value, hits: 0, lastUsed: Date.now() };
  writeStore(store);
}

/** Deletes one entry — the self-heal path used the moment a replay turns
 * out to be wrong, or a `verify` check fails at lookup time. Never
 * throws. */
export function deleteCacheEntry(key: string): void {
  try {
    const store = readStore();
    if (key in store) {
      delete store[key];
      writeStore(store);
    }
  } catch {
    // no-op
  }
}

/** Bumps `hits`/`lastUsed` on a successful replay — the first successful
 * replay of a freshly-written entry (hits: 0) takes it to hits: 1. */
export function touchCacheEntry(key: string): void {
  if (!isActionCacheEnabled()) return;
  const store = readStore();
  const entry = store[key];
  if (!entry) return;
  entry.hits += 1;
  entry.lastUsed = Date.now();
  writeStore(store);
}

// --- key normalization -----------------------------------------------

/**
 * Case/whitespace-insensitive text compare — used ONLY for matching a
 * cached element's label against a fresh snapshot's element
 * (`resolveCachedIndex`/`hashCachedLabel`), never for building a cache key.
 * Key inputs (goal, URL, element fingerprints) are hashed EXACTLY as given —
 * see this module's header comment for why normalizing the key itself was
 * the unsafe/low-hit-rate design this replaces.
 */
function normalizedLabelText(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/\s+/g, " ").trim() : "";
}

/** `origin + pathname + search` of `url` — i.e. the full address MINUS the
 * fragment, which never affects what's actually rendered/requested. Used
 * for the step-cache key ("full current URL including query") so two pages
 * that only differ by hash (an anchor link, a client-side router using `#`)
 * still share an entry, but anything that changes the query string — a
 * different search, a different page of results — does not. Falls back to
 * the raw string when `url` doesn't parse, same conservative default the
 * rest of this module uses. */
function urlIdentity(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

/** Reverses a string — used only to derive a SECOND, independently-seeded
 * hash from `hashString` (see `secondHash`) without duplicating the FNV-1a
 * algorithm itself (check:dup). Reversing scrambles the byte order enough
 * that a collision on the forward hash gives no leg up on the reversed one:
 * two different strings that happen to hash equal forwards would need to
 * ALSO hash equal reversed, an unrelated coincidence. */
function reverseString(value: string): string {
  return value.split("").reverse().join("");
}

/** The "second seed" hash used throughout this module wherever collision
 * safety needs two independent hashes of the same input (the combined key,
 * and each `verify` field) — see this module's header comment. Exported so
 * tests can assert independence directly instead of only through key
 * behavior. */
export function secondHash(value: string): string {
  return hashString(reverseString(value));
}

function hashParts(parts: string[]): string {
  // Reuses loopGuard.ts's exported FNV-1a (same algorithm, same
  // "not a security hash" reasoning) instead of a second copy — check:dup.
  const canonical = parts.join("\u0000");
  // Two independently-seeded 32-bit hashes concatenated into one ~64-bit
  // key — see this module's header comment ("COLLISION SAFETY").
  return `${hashString(canonical)}${secondHash(canonical)}`;
}

/**
 * Per-element fingerprint fragment for the step-cache key: every field Jev's
 * own digest (`elementDigestLine` in pen-editor-backend's `browseStep.ts`)
 * can see or act on for this element — `tag|role|label|ops|isPassword|
 * checked|hasValue|value|scrollable|frame|options|disabled` — so a page whose
 * element gained/lost ANY signal Jev would itself notice mints a different
 * key rather than silently matching a since-mutated page. Deliberately
 * excludes the element's own `index` — two pages with an identical set of
 * elements can still assign different indices to them (DOM order, upstream
 * filtering in `filterElementsForBackend`), and the whole point of a
 * fingerprint here is page CONTENT identity, not a specific index
 * assignment (indices are re-resolved fresh on every replay by
 * `resolveCachedIndex` anyway). `value` is only ever present on an element
 * whose content is safe to send at all (the backend never sends it for a
 * password/card/select field — see `BrowseStepElement.hasValue`'s
 * comment) — this fingerprint just forwards whatever the snapshot already
 * decided was safe to expose, unchanged.
 */
function elementFingerprintRow(el: unknown): string {
  if (!el || typeof el !== "object") return "";
  const e = el as {
    tag?: unknown;
    role?: unknown;
    label?: unknown;
    ops?: unknown;
    isPassword?: unknown;
    checked?: unknown;
    hasValue?: unknown;
    value?: unknown;
    scrollable?: unknown;
    frame?: unknown;
    options?: unknown;
    disabled?: unknown;
  };
  const tag = typeof e.tag === "string" ? e.tag : "";
  const role = typeof e.role === "string" ? e.role : "";
  const label = typeof e.label === "string" ? e.label : "";
  const ops = Array.isArray(e.ops) ? e.ops.filter((o): o is string => typeof o === "string").join(",") : "";
  const isPassword = e.isPassword === true ? "1" : "0";
  const checked = e.checked === true ? "1" : "0";
  const hasValue = e.hasValue === true ? "1" : "0";
  const value = typeof e.value === "string" ? e.value : "";
  const scrollable = e.scrollable === true ? "1" : "0";
  const frame = typeof e.frame === "string" ? e.frame : "";
  const options = Array.isArray(e.options)
    ? e.options.filter((o): o is string => typeof o === "string").join(",")
    : "";
  const disabled = e.disabled === true ? "1" : "0";
  return [tag, role, label, ops, isPassword, checked, hasValue, value, scrollable, frame, options, disabled].join("|");
}

/** Sorted (order-independent) fingerprint of EVERY element in the snapshot
 * — part of what makes the step-cache key exact-input: a page whose
 * elements changed at all (something appeared/disappeared, or any field on
 * an existing one changed) mints a different key rather than silently
 * matching a since-mutated page. Exported so `lookupStepCache`'s `verify`
 * check can recompute the same fingerprint against the CURRENT elements. */
function elementSetFingerprint(elements: unknown[]): string {
  return elements.map(elementFingerprintRow).sort().join("\n");
}

/** Full, untruncated history signature: every entry's exact operation+label
 * (side-effect suffixes like "(page updated: ...)"/"(no effect)" kept, not
 * stripped) — not just the last 3. `history` grows by one entry every step,
 * so folding the WHOLE thing into the key is what makes "the same key
 * forever" structurally impossible: a loop that keeps landing on the same
 * page+goal necessarily has a longer, different history on every
 * iteration, so it can never re-hit a stale entry from an earlier point in
 * the same loop. */
function historySignature(history: Array<{ operation: string; label: string }>): string {
  return history.map((entry) => `${entry.operation}\u0001${entry.label}`).join("\u0002");
}

/**
 * The client's own scroll position, folded into the step-cache key —
 * browse-speed-contract item 5 / a code review flag: two otherwise-
 * identical pages scrolled to different places can present different
 * elements or a different "is there more below" state, so scroll position
 * is part of what "identical" means here, same as everything else in this
 * key. `y` is bucketed to the nearest 100px rather than compared exactly —
 * unlike goal/URL/elements/history (deliberately exact so nothing there can
 * silently drift), scroll position jitters by a few pixels between two
 * genuinely-identical visits (sub-pixel rendering, a sticky header's
 * resize) for reasons that have nothing to do with page state actually
 * differing; bucketing absorbs that jitter without giving up the
 * "meaningfully different scroll position ⇒ different key" property
 * `atBottom` alone can't fully capture (mid-page position still matters
 * even when neither state is at the bottom). Accepts `unknown` since the
 * desktop bridge's snapshot type only guarantees `scroll` exists, not its
 * shape (`SnapshotResult.scroll?: unknown` in shared.ts) — a malformed or
 * missing scroll degrades to a stable empty fragment rather than throwing.
 */
function scrollFingerprint(scroll: unknown): string {
  if (!scroll || typeof scroll !== "object") return "";
  const s = scroll as { y?: unknown; atBottom?: unknown };
  const yBucket = typeof s.y === "number" && Number.isFinite(s.y) ? Math.round(s.y / 100) * 100 : "";
  const atBottom = s.atBottom === true ? "1" : s.atBottom === false ? "0" : "";
  return `${yBucket}|${atBottom}`;
}

/**
 * Step-cache key: exact goal string, full current URL (including query),
 * the page title, a sorted fingerprint of every element in the current
 * snapshot (every field Jev's own digest can see — see
 * `elementFingerprintRow`), the full (untruncated) history, and a bucketed
 * scroll position — see this module's header comment for why an exact,
 * un-normalized key replaces the previous fuzzy one, and `scrollFingerprint`
 * for why scroll is bucketed rather than exact. Identical page + identical
 * goal + identical history + identical (bucketed) scroll ⇒ identical Jev
 * input ⇒ a safely memoized decision; anything that actually differs mints
 * a new key rather than risking a wrong replay.
 */
export function buildStepCacheKey(
  goal: string,
  url: string,
  title: string,
  elements: unknown[],
  history: Array<{ operation: string; label: string }>,
  scroll?: unknown,
  modal?: string
): string {
  return `step:${hashParts([
    goal,
    urlIdentity(url),
    title,
    elementSetFingerprint(elements),
    historySignature(history),
    scrollFingerprint(scroll),
    // Appended only when a dialog is open, so keys for modal-free pages are
    // unchanged. The element table is already modal-scoped, but the same
    // table could in principle appear with and without the dialog.
    ...(modal ? [`modal:${modal}`] : []),
  ])}`;
}

// --- step cache (browse_task) -----------------------------------------

export interface CachedStepTarget {
  /** Hash of the element's normalized label — never the raw label text (a
   * code review requirement: no raw page text persisted to localStorage).
   * See `hashCachedLabel`. */
  labelHash: string;
  tag: string;
  role?: string;
}

export interface CachedStep {
  operation: string;
  target?: CachedStepTarget;
  /**
   * For TYPE_TEXT/SELECT only: an [start, end) OFFSET into the GOAL string,
   * never the raw typed text itself. Replay reads the text back out with
   * `goal.slice(...)` against the CURRENT goal. Only ever written when the
   * text occurs verbatim in the goal (see `findTextRangeInGoal`); when it
   * doesn't, that step is not cached at all rather than falling back to
   * storing the text some other way.
   */
  textRange?: [number, number];
}

/** The persisted shape of a step-cache entry: `CachedStep` plus the
 * collision-safety `verify` block (see this module's header comment,
 * "COLLISION SAFETY"). Internal — callers only ever see `CachedStep` back
 * out of `lookupStepCache`, never `verify` itself. */
interface StoredCachedStep extends CachedStep {
  verify: {
    goal: string;
    elements: string;
  };
}

function isStoredCachedStep(value: unknown): value is StoredCachedStep {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as StoredCachedStep).operation === "string" &&
    !!(value as StoredCachedStep).verify &&
    typeof (value as StoredCachedStep).verify.goal === "string" &&
    typeof (value as StoredCachedStep).verify.elements === "string"
  );
}

/**
 * Hash of an element's normalized label — the only form a target label is
 * ever persisted in (write or read). Used both when WRITING a
 * `CachedStepTarget` (browseTask.ts's `maybeWriteStepCache`) and when
 * MATCHING one against a fresh snapshot (`resolveCachedIndex`), so the two
 * sides always compute it the same way. Exported for that second use.
 */
export function hashCachedLabel(label: string): string {
  return hashString(normalizedLabelText(label));
}

/**
 * Looks up a step-cache entry AND verifies it before returning it —
 * collision safety (this module's header comment): `key` alone is a hash
 * and could, astronomically rarely, collide between two genuinely different
 * (goal, elements) contexts. `goal`/`elements` here are the CURRENT
 * context's, and must match the entry's own stored `verify` hashes
 * (computed with the second, independently-seeded hash — see `secondHash`)
 * or the entry is treated as a miss and deleted outright, never returned.
 * A malformed/pre-migration entry (no `verify` block at all) fails the same
 * check and is deleted the same way — never trusted just because it's old.
 */
export function lookupStepCache(key: string, goal: string, elements: unknown[]): CachedStep | undefined {
  const entry = getRawEntry(key);
  if (!entry) return undefined;
  if (!isStoredCachedStep(entry.value)) {
    deleteCacheEntry(key);
    return undefined;
  }
  const { verify, ...cachedStep } = entry.value;
  const expectedGoal = secondHash(goal);
  const expectedElements = secondHash(elementSetFingerprint(elements));
  if (verify.goal !== expectedGoal || verify.elements !== expectedElements) {
    deleteCacheEntry(key);
    return undefined;
  }
  return cachedStep;
}

/**
 * Writes a step-cache entry, attaching the `verify` block `lookupStepCache`
 * later checks — `goal`/`elements` here must be the SAME ones `key` (from
 * `buildStepCacheKey`) was built from, so a future lookup with an identical
 * key also has identical verify hashes.
 */
export function writeStepCacheEntry(
  key: string,
  goal: string,
  elements: unknown[],
  value: CachedStep
): void {
  const stored: StoredCachedStep = {
    ...value,
    verify: {
      goal: secondHash(goal),
      elements: secondHash(elementSetFingerprint(elements)),
    },
  };
  setRawEntry(key, stored);
}

/** Slices `text` back out of `goal` by offset, or `undefined` when the
 * entry carries no `textRange` (a non-text operation) or the range is out
 * of bounds for the current goal (defensive — should be unreachable since
 * the goal is part of the key, but a hand-edited/corrupted localStorage
 * blob must not throw or read garbage). */
export function readTextFromRange(goal: string, textRange: [number, number] | undefined): string | undefined {
  if (!textRange) return undefined;
  const [start, end] = textRange;
  if (start < 0 || end > goal.length || start >= end) return undefined;
  return goal.slice(start, end);
}

/** Finds the [start, end) offset of `text` inside `goal`, for writing a
 * TYPE_TEXT/SELECT step's `textRange`. Returns `undefined` when `text`
 * doesn't occur verbatim in `goal` (or is empty) — the caller must then
 * skip caching that step entirely rather than store the raw text some
 * other way (see `CachedStep.textRange`'s doc comment). */
export function findTextRangeInGoal(goal: string, text: string): [number, number] | undefined {
  if (!text) return undefined;
  const start = goal.indexOf(text);
  return start === -1 ? undefined : [start, start + text.length];
}

// --- replaying a cached target against a fresh snapshot -----------------

/**
 * Resolves a cached {labelHash, tag, role?} fingerprint against a FRESH
 * snapshot's elements. Returns the matching element's `index` field
 * (NEVER its array position — the snapshot's element list is not
 * guaranteed dense/positional, e.g. after `filterElementsForBackend`-style
 * upstream filtering) only when EXACTLY ONE element matches — zero matches
 * (the element is gone) or more than one (the page grew a second element
 * with the same label/tag, e.g. a list that now has two "Delete" buttons)
 * are both treated as a miss, never a guess. A cache entry never persists
 * an element's raw label (see `CachedStepTarget.labelHash`'s comment), so
 * matching hashes each fresh candidate's normalized label with
 * `hashCachedLabel` and compares THAT — a false-positive hash collision
 * here just means an unrelated element occasionally gets treated as a
 * uniqueness-breaking duplicate (the safe direction: it turns a would-be
 * hit into a miss, never a wrong replay), never the reverse. Deliberately
 * does not also filter by which ops an element declares support for: the
 * op is exactly what the caller is about to replay, and a genuine mismatch
 * there surfaces immediately as a rejected act/perform, which the caller
 * already treats as a self-heal signal (see this module's header comment).
 */
export function resolveCachedIndex(
  elements: unknown[],
  target: CachedStepTarget
): number | undefined {
  const matches: number[] = [];
  elements.forEach((el, position) => {
    if (!el || typeof el !== "object") return;
    const candidate = el as { index?: unknown; label?: unknown; tag?: unknown; role?: unknown };
    if (typeof candidate.tag !== "string" || candidate.tag !== target.tag) return;
    if (target.role !== undefined && candidate.role !== target.role) return;
    if (hashCachedLabel(typeof candidate.label === "string" ? candidate.label : "") !== target.labelHash) return;
    matches.push(typeof candidate.index === "number" ? candidate.index : position);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

// --- cacheability guards -------------------------------------------------

/** Step operations that must never be cached regardless of how they land —
 * WAIT carries no target and is a "keep looking" decision, not a repeatable
 * action; `done`/`blocked` never reach the step-cache write site at all
 * (they return from the loop before any target/operation is recorded), so
 * this set only needs WAIT to make that invariant explicit and testable. */
const NEVER_CACHE_STEP_OPERATIONS = new Set(["WAIT"]);
export function isCacheableStepOperation(operation: string): boolean {
  return !NEVER_CACHE_STEP_OPERATIONS.has(operation);
}

/** A crude but deliberately permissive card-number/password heuristic —
 * false positives just mean an ordinary value doesn't get cached (a
 * harmless miss on the next run, re-learned the same way), which is the
 * safe direction for a check guarding what we write to localStorage. This
 * checks the VALUE a step is about to type; `isUnsafeCachedTarget` below
 * separately checks the FIELD it's about to type into. */
const CARD_NUMBER_PATTERN = /(?:\d[ -]?){13,19}/;
const PASSWORD_LOOKALIKE_PATTERN = /\b(password|passwd|pwd|cvv|cvc|ssn)\b/i;
export function looksSensitive(text: string | undefined): boolean {
  if (!text) return false;
  return CARD_NUMBER_PATTERN.test(text) || PASSWORD_LOOKALIKE_PATTERN.test(text);
}

/** Target/field labels naming an irreversible or otherwise sensitive
 * real-world action — never cached (write OR replay), for ANY operation,
 * since a stale/ambiguous replay landing on the wrong "Delete"/"Place
 * order"/"Log out" button is exactly the kind of mistake a step cache must
 * never risk. Covers English and a few common Russian stems (a goal/label
 * may be in either). Deliberately broad — a false positive just means an
 * ordinary control doesn't get cached. */
const IRREVERSIBLE_LABEL_PATTERN =
  /place order|pay|buy now|purchase|checkout|confirm|submit order|delete|remove|cancel|refund|send|transfer|unsubscribe|log ?out|sign ?out|оплат|плат|купить|купи|покуп|удал|отправ|подтверд|заказ|оформ|выйти|выход|отмен|перевод|перевест|подпис/i;

/** Commit-control labels (reserve / buy / send), a port of the backend's
 * browseCommitGuard.ts `commitKind` prefilter (en/ru/de, Unicode-aware
 * boundaries, marketing and nav-link stripping, punctuation-stripped bare
 * verbs). A replay would skip /api/browse/step and therefore the backend
 * guard, so these are never cached nor replayed. Pinned to the backend by
 * src/lib/__tests__/commitLabelContract.test.ts. */
const word = (src: string): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${src})(?![\\p{L}\\p{N}])`, "iu");
const TAIL = "[\\p{L}]*";

const COMMIT_LABEL_RES: RegExp[] = [
  word(
    [
      "reserve",
      "(?:book|reserve) (?:tickets?|seats?|now|it|this|online)",
      "book (?:now|this)",
      "book (?:a |an )?(?:table|room|seat|ticket|flight|stay|appointment)",
      "(?:confirm|complete) (?:booking|reservation)",
      "hold (?:this |the )?(?:table|seat|room)",
      `(?:за)?бронировать|(?:за)?бронируй(?:те)?|зарезервировать|зарезервируйте|забронир${TAIL}|брониру${TAIL}`,
      `reservier${TAIL}|jetzt buchen|buchen|reservieren`,
    ].join("|")
  ),
  word(
    [
      "buy now",
      "place (?:your |an )?order",
      "submit order",
      "pay",
      "(?:complete|confirm) (?:purchase|order|payment)",
      "proceed to (?:checkout|payment)",
      "check ?out",
      "purchase",
      "(?:buy|order|purchase) (?:tickets?|seats?|now|it|this|online)",
      "(?:continue|go) to (?:payment|checkout)",
      `купить|оплатить|оформить заказ|перейти к оплате|оформление заказа|оплат${TAIL}|заказать`,
      "kaufen|bezahlen|zahlungspflichtig bestellen|zur kasse|bestellen",
    ].join("|")
  ),
  word(
    [
      "(?:send|submit) (?:application|request|message|form|enquiry|inquiry)",
      "confirm and send",
      "sign (?:and|&) submit",
      "отправить заявку|отправить запрос",
      "absenden|anfrage senden",
    ].join("|")
  ),
];

const COMMIT_MARKETING_RE = word(
  "reserve now,? pay (?:later|at the \\p{L}+)|pay later|pay at the \\p{L}+|pay on arrival|pay when you stay|pay in store"
);
const COMMIT_NOUN_LINK_RE = word(
  "(?:purchase|checkout|check out|reserve|reservation|booking|book|buy|pay|order)s? (?:history|policy|guide|options|methods|terms|protection|details|info|list|management)"
);

/** A label that is only a bare commit verb ("Book", "Confirm", "Оплатить"). */
const BARE_COMMIT_LABELS = new Set([
  "book", "book it", "reserve", "забронировать", "buchen", "reservieren",
  "submit", "confirm", "send", "отправить", "подтвердить", "absenden", "bestätigen",
  "order", "pay", "buy", "purchase", "checkout", "check out",
  "оплатить", "купить", "заказать", "bezahlen", "kaufen", "bestellen",
]);

function isCommitLabel(label: string): boolean {
  const bare = label.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").trim().toLowerCase();
  if (BARE_COMMIT_LABELS.has(bare)) return true;
  const clean = label
    .replace(/[’]/g, "'")
    .replace(new RegExp(COMMIT_MARKETING_RE.source, "giu"), " ")
    .replace(new RegExp(COMMIT_NOUN_LINK_RE.source, "giu"), " ");
  return COMMIT_LABEL_RES.some((re) => re.test(clean));
}

export function isIrreversibleLabel(label: string | undefined): boolean {
  return !!label && (IRREVERSIBLE_LABEL_PATTERN.test(label) || isCommitLabel(label));
}

/** Field label/type patterns that must never have TYPE_TEXT/SELECT cached
 * into them (write or replay) — on top of the resolved element's own
 * `isPassword` flag, which `isUnsafeCachedTarget` checks separately.
 * Covers password fields under any of their common labels/`type`
 * attributes, one-time/verification codes, and payment-credential fields
 * (card number, CVV/CVC, IBAN). */
const SENSITIVE_FIELD_PATTERN =
  /password|passwd|pwd|cvv|cvc|otp|verification|2fa|card|iban|парол|код подтвержд|код из смс|смс|карт/i;

export function isSensitiveField(label: string | undefined, type: string | undefined): boolean {
  return (!!label && SENSITIVE_FIELD_PATTERN.test(label)) || (!!type && SENSITIVE_FIELD_PATTERN.test(type));
}

/**
 * The single combined "must this element/operation never be cached" check —
 * used identically at WRITE time (`maybeWriteStepCache` in browseTask.ts,
 * right after a step lands) and at REPLAY time (browseTask.ts's loop, right
 * after a cached target resolves to a fresh element), so a page whose
 * element gained an irreversible-sounding label or turned into a password
 * field between the write and a later replay is caught either way — not
 * just once at write time.
 */
export function isUnsafeCachedTarget(
  operation: string,
  label: string | undefined,
  type: unknown,
  isPassword: unknown,
  disabled?: unknown
): boolean {
  // A disabled control cannot act: replaying a step onto it would be a no-op
  // the loop might misread as success.
  if (disabled === true) return true;
  if (isIrreversibleLabel(label)) return true;
  if (operation === "TYPE_TEXT" || operation === "SELECT") {
    if (isPassword === true) return true;
    if (isSensitiveField(label, typeof type === "string" ? type : undefined)) return true;
  }
  return false;
}
