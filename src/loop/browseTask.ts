import type { BrowserBridge } from "./bridge.js";
import type { BrowseBackend } from "./backend.js";
import type { KeyValueStorage } from "./storage.js";
import {
  appendKeepingSuffix,
  describeEffectDetailed,
  isCommitEffect,
  type BecameLabel,
  EARLIER_SUBGOAL_SUFFIX,
  fitLabel,
  stripVolatileLabelParts,
  type ActedElement,
} from "./actionEffect.js";
import {
  buildStepCacheKey,
  deleteCacheEntry,
  findTextRangeInGoal,
  hashCachedLabel,
  isActionCacheEnabled,
  isCacheableStepOperation,
  isUnsafeCachedTarget,
  looksSensitive,
  lookupStepCache,
  readTextFromRange,
  resolveCachedIndex,
  touchCacheEntry,
  writeStepCacheEntry,
  type CachedStep,
  type CachedStepTarget,
} from "./actionCache.js";
import {
  fetchBrowseBackend,
  type RetryClock,
  BACKEND_MAX_GOAL,
  BACKEND_MAX_SCREENSHOT_CHARS,
  sanitizedPageBody,
  sliceToChars,
  truncateToChars,
  findElementByIndex,
  resultError,
  takeSnapshot,
  type SnapshotResult,
} from "./shared.js";

/**
 * What the browse_task loop was told about its host, threaded through the
 * loop in place of what pen-editor read from ambient state (the Zustand
 * permissions store, `window.penDesktop`, `localStorage`, Vite env). Built
 * once by `runBrowseTask` from its options.
 */
export interface LoopEnv {
  /** The browser being driven (was `window.penDesktop.browser` / the cloud bridge). */
  browser: BrowserBridge;
  /** Where `/api/browse/{step,plan}` requests go. */
  backend: BrowseBackend;
  /** User switches sent with every step; omitted from the body when absent.
   * A getter is called before each step, so a switch the user flips mid-run
   * applies from the next step. */
  permissions?: BrowsePermissions | (() => BrowsePermissions);
  /** Action cache storage (was `localStorage`); absent = cache off. */
  storage?: KeyValueStorage;
  /** The browser is a remote (cloud) one: longer deadlines (was
   * `!isDesktopBrowserAvailable()`). */
  cloud: boolean;
  /** Send a marked screenshot of the step's snapshot to the backend (was
   * `VITE_BROWSE_STEP_SCREENSHOT === "true"`). */
  stepScreenshots: boolean;
}

/**
 * User switches that gate what the browser agent may do — the shape of
 * pen-editor's `BrowserAgentPermissions` (store/browserAgentSettingsStore.ts),
 * copied here so the loop does not depend on the policy layer or the host.
 */
export interface BrowsePermissions {
  /** The agent may type a password, but only one the user gave in the chat. */
  allowPasswordEntry: boolean;
  /** The agent stops and asks before irreversible actions it was not told to do. */
  confirmIrreversible: boolean;
}

/**
 * browse_task — a Jev-driven browsing loop
 * (docs/superpowers/specs/2026-09-18-browse-task-jev-loop-design.md §3, as
 * corrected by the "Addendum, 2026-09-18: contract corrections after
 * review" at the end of that doc). Unlike browse_open/browse_act/
 * browse_find_images, this handler does not just forward one call to the
 * desktop bridge: it *is* the loop. Per cycle it takes a fresh
 * element-table snapshot from the page (`BrowserBridge.snapshot()`),
 * POSTs it plus a short history to the backend's `/api/browse/step`
 * (stateless — Jev picks the next operation/target), and applies the
 * decision with `BrowserBridge.perform(...)`. It repeats until
 * the backend answers `outcome: "done"` or `"blocked"`, or the budget
 * (`maxSteps`/deadline) runs out.
 *
 * One chat tool call therefore drives a whole multi-step task without the
 * design model in the loop at all — see the design doc's "Where the loop
 * runs" section for why this lives here rather than on the backend.
 */

/** design doc §3 had "default 12, hard cap 25"; the default is now the cap:
 * the chat agent hands the user's WHOLE goal to one call (backend Browser
 * tasks rule), and a model that omits maxSteps must not stop at 12. */
const DEFAULT_MAX_STEPS = 25;
const HARD_MAX_STEPS = 25;

/** design doc §3: BROWSE_TASK_DEADLINE_MS = 90_000. */
const BROWSE_TASK_DEADLINE_MS = 90_000;

/**
 * The cloud browser (web build, Steel) gets twice the desktop budget. Every
 * snapshot/perform there is a round trip web → backend → Steel, and a click
 * measured 3-10 s against ~1 s on the desktop (a remote page script alone is
 * ~0.2 s, and a heavy page stalls single calls for 4-8 s). With the desktop's
 * 90 s — 55 s of step starts after STEP_DEADLINE_RESERVE_MS — a real form
 * (Google Flights, ~11 steps) ran out after 3 steps, every one of them right.
 * browse_task's cloud tool-call timeout (useDesignChat.ts,
 * CLOUD_BROWSE_TASK_TIMEOUT_MS) covers 180 - 35 + ~61.5 s plus a cold session.
 */
export const CLOUD_BROWSE_TASK_DEADLINE_MS = 180_000;

/** The loop budget for whichever browser is driving this call (`cloud`: a
 * remote browser rather than the local desktop one). */
export function browseTaskDeadlineMs(cloud: boolean): number {
  return cloud ? CLOUD_BROWSE_TASK_DEADLINE_MS : BROWSE_TASK_DEADLINE_MS;
}

/**
 * browse-speed-contract.md, "Frontend" item 4: how much of the deadline
 * must remain before STARTING a new step (snapshot → step → perform). A
 * step that begins with too little left can still burn most of a step's
 * own worst case before this loop's own deadline check would have caught
 * it on the NEXT iteration — reserving a margin means the loop bails before
 * starting a step it likely can't finish, rather than after.
 *
 * Finding: 15s was far short of one step's real worst case. A single step
 * is takeSnapshot (up to the desktop's 20s command budget) + requestStep
 * (up to shared.ts's BROWSE_BACKEND_REQUEST_TIMEOUT_MS = 20s) + the
 * act/perform call itself (up to 20s plus ~1.5s cursor-move budget) —
 * ~61.5s worst case, not the 15s this reserve assumed. 35s is the
 * documented middle-ground fix: it does not fully close the gap (a step
 * starting at deadline-35s could still finish around deadline+26.5s), but
 * it cuts the overrun from ~46.5s to ~26.5s, and — combined with raising
 * browse_task's client-side tool-call timeout from 100s to 150s
 * (useDesignChat.ts) — the worst-case total (BROWSE_TASK_DEADLINE_MS - this
 * reserve + one step's worst case = 90 - 35 + 61.5 = 116.5s) now lands
 * comfortably inside that 150s budget with margin to spare, so
 * BROWSE_TASK_DEADLINE_MS itself does not need to move.
 */
const STEP_DEADLINE_RESERVE_MS = 35_000;

const CANCELLED_REASON = "cancelled";

/** design doc §3: "keeping a short history" / backend request shape: last 10 steps. */
const HISTORY_LIMIT = 10;

/**
 * Upstream jev-ultrafast PR #40 ("record stale executions so undecidable
 * stale loops can stop"), ported: how many consecutive steps may land
 * nothing before the loop gives up. A target that is persistently stale
 * between the snapshot and the act (a live-updating popover, a list that
 * re-renders on a timer) otherwise loops snapshot → step → rejected act
 * until maxSteps runs out, spending a paid Jev call per cycle without a
 * single executed action. Any step that lands — including a WAIT, which is
 * a deliberate decision, not a failure — resets the count.
 */
const MAX_CONSECUTIVE_UNPRODUCTIVE_STEPS = 3;

/**
 * Live run finding: CLICK on a search field (opens a dropdown, recorded ok
 * with "page updated: …") then PRESS_ESCAPE (closes it, ok:false) repeated
 * ~70 times. The unproductive counter never fires because every other step is
 * ok. A two-step cycle is the last CYCLE_PERIOD_REPEATS * 2 recorded steps
 * reading A,B,A,B,A,B (A≠B) with byte-identical keys (operation + FULL label
 * + page url). The effect text stays in the key on purpose: a legit repeated
 * "Load more" shows different appeared text each time, a true cycle does not.
 */
const CYCLE_PERIOD_REPEATS = 3;

/** Consecutive landed scrolls on one url, with 2+ direction reversals, that count as oscillation. */
const SCROLL_OSCILLATION_WINDOW = 6;

/**
 * Addendum A: "the loop sleeps ~400 ms itself, takes a fresh snapshot and
 * continues" when the decision is WAIT.
 */
const WAIT_SLEEP_MS = 400;

/**
 * Live bench finding (booking.com): `browser.open` can return at DOM-ready
 * with `loaded: false`, so the first snapshot of a heavy page is empty — the
 * step request went out with `elements: []` and no page text, Jev answered
 * BLOCKED, and browse_task ended `blocked` after 0 steps. A snapshot with no
 * elements AND no page text is therefore treated as "not rendered yet": the
 * loop polls for a real one (every EMPTY_SNAPSHOT_POLL_MS, at most
 * EMPTY_SNAPSHOT_MAX_POLLS times, ~5 s) before spending a paid step request.
 * Polls consume neither the step budget nor the unproductive-step count. If
 * the page is still empty afterwards, the last snapshot is used as before.
 * Only the FIRST snapshot is polled (review): a page that genuinely has no
 * controls or text mid-task (a canvas app, an image) would otherwise pay ~5 s
 * on every step and break STEP_DEADLINE_RESERVE_MS's per-step worst case.
 */
const EMPTY_SNAPSHOT_POLL_MS = 400;
const EMPTY_SNAPSHOT_MAX_POLLS = 12;

/**
 * Live bench finding (2026-09-24, fixture-shop run): Jev chose WAIT six
 * times in a row at low confidence (0.37-0.57) before anything else
 * happened. WAIT never reaches `perform`/`act` (addendum A), so it carries
 * no `changed`/`pageChanged` signal of its own and always used to be
 * recorded `ok: true` — the one signal that resets the
 * MAX_CONSECUTIVE_UNPRODUCTIVE_STEPS counter — so an unbroken run of WAITs
 * could never trip the stall detector no matter how long it went on.
 * Consecutive WAIT decisions landing on the SAME url (nothing navigated
 * between them, the only "did anything change" signal a targetless WAIT
 * has) are capped at this many BEFORE a WAIT stops actually sleeping: the
 * (N+1)th such WAIT is recorded as an unproductive step instead of being
 * executed, so the general unproductive-step counter (`note`, above) starts
 * advancing toward `stalled` rather than resetting on every idle WAIT.
 */
const MAX_CONSECUTIVE_SAME_URL_WAITS = 2;

/**
 * pen-editor-backend/src/routes/browseStep.ts's `historyEntrySchema` caps
 * `label` at 200 chars (`label: z.string().max(200)`) — every step this
 * loop records is appended to `history` and sent right back up on the
 * NEXT /api/browse/step call, so a label over that limit 400s that next
 * request and silently stalls the whole task (the loop's own error
 * handling treats a non-ok response as a thrown error, so this looked like
 * "the backend broke" rather than "our own label was too long"). The two
 * repos don't share code, so this is a plain mirrored constant, not an
 * import — keep it in sync with the backend schema if that cap ever moves.
 */
const HISTORY_LABEL_MAX_CHARS = 200;

/**
 * Per-fragment cap for a side-effect description folded into a step label
 * (an opened tab's title, an auto-handled dialog's message — both are
 * page-derived text with no length guarantee of their own). Generous
 * enough to stay informative while leaving room for the base label plus
 * whichever OTHER side-effect fragment rides along, so two long fragments
 * together still can't blow past HISTORY_LABEL_MAX_CHARS on their own —
 * recordStep's hard truncation is the final backstop regardless.
 */
const SIDE_EFFECT_FRAGMENT_MAX_CHARS = 60;

/** The operations `perform` actually accepts (addendum A: WAIT never reaches it). */
type PerformOperation = "CLICK" | "TYPE_TEXT" | "SELECT" | "SCROLL_UP" | "SCROLL_DOWN";

/**
 * The operations dispatched through `browser.act` instead of `browser.perform`
 * (docs/superpowers/specs/2026-09-23-full-browser-use-design.md, "act gains
 * actions and index targeting"). PRESS_ENTER/PRESS_ESCAPE act on whatever
 * currently has focus — right after TYPE_TEXT that's the field just typed
 * into — and carry no index; HOVER targets an element by index like CLICK
 * does.
 */
type ActOperation = "PRESS_ENTER" | "PRESS_ESCAPE" | "HOVER";

/** Everything a step response's `operation` may name. */
type StepOperation = PerformOperation | ActOperation | "WAIT";

/** Addendum B: the step response's explicit terminal/transient signal. */
type StepOutcome = "act" | "done" | "blocked" | "retry";

/** How a step's operation was decided — omitted for an ordinary confident
 * Jev decision (the common case), so existing transcripts/history entries
 * stay exactly as small as before. "cascade": the backend's
 * BROWSE_CASCADE_MODEL second opinion decided it after Jev's own peak
 * probability gate failed (see pen-editor-backend's cascadeStep). "rule": a
 * deterministic client-side guard overrode the decision entirely — e.g.
 * refusing to retype into the same search box twice in a row and pressing
 * Enter instead (see the TYPE_TEXT-dedup rule below `note`). "cache": the
 * local action cache (actionCache.ts) replayed a previously-successful
 * step against a fresh snapshot without ever calling /api/browse/step. */
type StepVia = "cascade" | "rule" | "cache";

export interface StepHistoryEntry {
  operation: string;
  label: string;
  ok: boolean;
  via?: StepVia;
  /** The element the step acted on, when it had one — the backend's repeat
   * guard keys on it to tell "same element, still no effect" apart from two
   * different elements that happen to share a label. */
  index?: number;
}

interface StepResponse {
  /**
   * Addendum B. Optional in the type only because we must treat a
   * missing/unrecognized value defensively at runtime, the same as an
   * explicit "retry" — never as success.
   */
  outcome?: StepOutcome;
  /** Present for `outcome: "act"`; absent for done/blocked/retry. */
  operation?: StepOperation;
  index?: number;
  text?: string;
  confidence: number;
  model: string;
  reason?: string;
  /** Set by the backend cascade (see pen-editor-backend's browseStep.ts
   * `cascadeStep`) when a low-confidence Jev head was overridden by a
   * BROWSE_CASCADE_MODEL second opinion — surfaced to the transcript as
   * `via: "cascade"`. */
  cascade?: boolean;
}

/** How the per-step screenshot capture went (the `stepScreenshots` option). */
type StepScreenshotOutcome = "sent" | "unsupported" | "failed" | "timeout" | "unmarked" | "too_large";

/** Capture outcome recorded on the step entry the bench reads. JSON-plain. */
interface StepScreenshotInfo {
  screenshot: StepScreenshotOutcome;
  screenshotMs: number;
  marked?: number | boolean;
}

export type TranscriptStep = StepHistoryEntry & Partial<StepScreenshotInfo> & {
  /** 1-based sub-goal this step belongs to — only set when the task was
   * split into more than one sub-goal. */
  subgoal?: number;
};

/** Per-sub-goal outcome, reported only when the plan had more than one. */
export interface SubgoalResult {
  goal: string;
  status: "done" | "blocked" | "budget" | "stalled";
  reason?: string;
}

/** The visible text of the page where a loop ended. */
export interface Observation {
  /** 1-based sub-goal; absent for a single-flow task. */
  subgoal?: number;
  url: string;
  text: string;
}

export interface Transcript {
  /** Page text captured when the task (or each sub-goal) ended, so the chat
   * model reads the values the user asked for from here, not from memory.
   * Omitted when nothing was captured. */
  observations?: Observation[];
  /** Only when the plan had more than one sub-goal (see runBrowseTask). */
  subgoals?: SubgoalResult[];
  /** Multi-sub-goal only: the real number of steps run — `steps` keeps just
   * the last MULTI_SUBGOAL_STEPS_KEPT of each sub-goal. */
  stepsTotal?: number;
  status: "done" | "blocked" | "budget" | "stalled";
  steps: TranscriptStep[];
  url: string;
  title: string;
  reason?: string;
  /** Set when `openBeforeLoop`'s open() call reported `botCheck: true` —
   * surfaced so the caller/model knows this `blocked` is a CAPTCHA/bot-check
   * wall specifically, not an ordinary open failure or a Jev refusal. */
  botCheck?: true;
  /** How many steps this run resolved from the local action cache
   * (actionCache.ts) instead of calling /api/browse/step — only present once
   * the loop actually starts (the pre-loop "no tab open"/open-failure/
   * bot-check returns end the task before any step, cached or not, could
   * happen). */
  cacheHits?: number;
}

function labelForElement(elements: unknown[], index: number | undefined): string {
  if (index == null) return "";
  const el = elements[index] as { label?: unknown } | undefined;
  return el && typeof el.label === "string" ? el.label : "";
}

/** Requirement 2's "search-like field" test — a native search input, a
 * combobox/searchbox role, or a label/placeholder that reads like a search
 * box (the desktop snapshot already folds placeholder text into `label`).
 * Deliberately permissive: false positives just mean an ordinary text field
 * gets Enter pressed after a repeat TYPE_TEXT, which is a harmless no-op at
 * worst, not a destructive one. */
const SEARCH_LABEL_PATTERN = /search|find|query|поиск/i;

/** Mirrors the backend's hard credentials rule (browseStep.ts's
 * `operation === "PRESS_ENTER" && elements.some((el) => el.isPassword)`
 * gate): the client cannot know which element currently has focus, only
 * that a password field exists SOMEWHERE on the page — same reasoning the
 * PRESS_ENTER-after-TYPE_TEXT guard above already applies. Used to refuse
 * the TYPE_TEXT-dedup rule below on any page carrying a password field, so
 * this client-side override can never produce the PRESS_ENTER the backend
 * itself would have refused. */
function hasPasswordElement(elements: unknown[]): boolean {
  return elements.some((el) => (el as { isPassword?: unknown } | undefined)?.isPassword === true);
}

function isSearchLikeElement(elements: unknown[], index: number): boolean {
  const el = elements[index] as
    | { role?: unknown; label?: unknown; type?: unknown }
    | undefined;
  if (!el) return false;
  const role = typeof el.role === "string" ? el.role.toLowerCase() : "";
  const type = typeof el.type === "string" ? el.type.toLowerCase() : "";
  const label = typeof el.label === "string" ? el.label : "";
  return (
    type === "search" ||
    role === "searchbox" ||
    role === "combobox" ||
    SEARCH_LABEL_PATTERN.test(label)
  );
}

/**
 * Bench finding A (fixture-shop live run, all 3 runs): the very first
 * browse_task call was made before any tab was open, and burned three
 * whole Jev steps re-discovering "No browser tab is open — call
 * browse_open first" before finally giving up (MAX_CONSECUTIVE_UNPRODUCTIVE_STEPS).
 * Matches the bridge's own `browser.snapshot()` refusal message
 * (pen-editor-desktop's BrowserController) — kept as a substring match
 * rather than an exact string so a wording tweak on the desktop side
 * doesn't silently stop this from firing.
 */
const NO_TAB_OPEN_PATTERN = /no browser tab is open/i;

/** First http(s) URL literally present in the goal text, if any — used
 * when the model didn't pass `url` explicitly but phrased the goal as
 * "open https://... and do X". Deliberately simple (no goal parsing beyond
 * a URL regex): this is a convenience fallback, not the primary path — the
 * tool description asks the model to pass `url` directly. */
export function extractUrlFromGoal(goal: string): string | undefined {
  // `)` is deliberately NOT excluded here (unlike `"`/`'`/`<`/`>`, which
  // never legitimately appear in a bare URL) — a matched `)` can be part of
  // the URL itself (a Wikipedia-style path segment) or trailing punctuation
  // from the surrounding prose ("see https://x.com/a)."); the balance check
  // below tells the two apart instead of the character class blanket-
  // excluding it (finding: that used to cut off a genuinely balanced
  // trailing paren along with an unbalanced one).
  const match = goal.match(/https?:\/\/[^\s"'<>]+/i);
  if (!match) return undefined;
  // Finding: a URL embedded in prose commonly picks up trailing punctuation
  // that isn't part of the URL itself ("...go to https://x.com/a, then
  // search" or "see https://x.com/a]." from bracketed/quoted phrasing) — a
  // literal trailing char is stripped repeatedly, and a closing `)`/`]`/`}`
  // is only kept when it actually balances an opening one earlier in the
  // match (a URL can legitimately end with a balanced paren, e.g. a
  // Wikipedia-style link).
  let url = match[0];
  const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  while (url.length > 0) {
    const last = url[url.length - 1]!;
    if (",.;!:?".includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === "'" || last === '"') {
      url = url.slice(0, -1);
      continue;
    }
    const opener = CLOSERS[last];
    if (opener) {
      const opens = url.split(opener).length - 1;
      const closes = url.split(last).length - 1;
      if (closes > opens) {
        url = url.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return url.length > 0 ? url : undefined;
}

/** True when `a` and `b` are both parseable URLs sharing the same origin
 * (scheme + host + port). Used by finding #5's cross-origin navigation
 * check — defensively returns `true` (i.e. "don't navigate") when either
 * fails to parse, since staying on the current page is the safer default
 * over an unplanned open() call driven by a malformed URL. */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return true;
  }
}

/**
 * Opens `targetUrl` via the desktop bridge before the loop starts, folding
 * any failure into the same `{ status: "blocked", reason }` shape a step
 * failure would use. Returns `null` on success (caller proceeds into the
 * loop as normal).
 */
async function openBeforeLoop(
  browser: BrowserBridge,
  targetUrl: string
): Promise<Transcript | null> {
  try {
    const opened = await browser.open({ url: targetUrl });
    const err = resultError(opened);
    if (err) {
      return { status: "blocked", steps: [], url: "", title: "", reason: `failed to open ${targetUrl}: ${err}` };
    }
    // Finding: a successful open() can still land on a bot-check/CAPTCHA
    // wall (pen-editor-desktop's BrowserController.checkBotWall merges
    // `{ botCheck: true }` into an otherwise-successful open result). That
    // is not something Jev can click through, so treat it as an immediate
    // `blocked` and hand over to the user rather than burning steps against
    // a wall the step loop has no way to pass.
    if (opened && typeof opened === "object" && (opened as { botCheck?: unknown }).botCheck === true) {
      return {
        status: "blocked",
        steps: [],
        url: "",
        title: "",
        reason: "bot check / CAPTCHA wall — hand over to the user",
        botCheck: true,
      };
    }
    return null;
  } catch (err) {
    return {
      status: "blocked",
      steps: [],
      url: "",
      title: "",
      reason: `failed to open ${targetUrl}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** How much page text a step request carries — the backend's own cap
 * (browseStepUltrafast.ts MAX_PAGE_TEXT_CHARS). */
const PAGE_TEXT_MAX_CHARS = 6_000;

/**
 * The visible page text sent with each step, so Jev sees what a user sees —
 * a validation error, "Account created" — not only the controls
 * (jev-ultrafast's snapshot carries it the same way). The snapshot carries it
 * on a current desktop build; an older build gets one `read` instead. Never
 * fails the step: no text is just a poorer decision, not an error.
 */
async function pageTextFor(browser: BrowserBridge, snapshot: SnapshotResult): Promise<string | undefined> {
  if (typeof snapshot.text === "string") return snapshot.text.slice(0, PAGE_TEXT_MAX_CHARS);
  return (await readPageText(browser, PAGE_TEXT_MAX_CHARS))?.text;
}

/** One `read` of the page text, cut to `maxChars`; `url` and `truncated` are
 * what the desktop's read result reports. Any failure gives undefined. */
async function readPageText(
  browser: BrowserBridge,
  maxChars: number
): Promise<{ text: string; url?: string; truncated: boolean } | undefined> {
  try {
    const read = await browser.read({ maxChars });
    if (!read || typeof read !== "object") return undefined;
    const r = read as { text?: unknown; url?: unknown; truncated?: unknown };
    if (typeof r.text !== "string") return undefined;
    return {
      text: r.text.slice(0, maxChars),
      ...(typeof r.url === "string" && r.url ? { url: r.url } : {}),
      truncated: r.truncated === true || r.text.length > maxChars,
    };
  } catch {
    return undefined;
  }
}

/** Most characters the FINAL page's observation keeps. */
const OBSERVATION_LAST_MAX_CHARS = 4_000;
/** Most characters every earlier observation keeps. */
const OBSERVATION_EARLIER_MAX_CHARS = 1_500;
/** Most observations a transcript keeps — the last ones. */
const OBSERVATIONS_KEPT = 5;
/** Most characters all observations keep together; the oldest are trimmed first. */
const OBSERVATIONS_TOTAL_MAX_CHARS = 10_000;
/** An observation trimmed below this many characters is dropped, not kept as a stub. */
const OBSERVATION_MIN_CHARS = 100;
/** Ends every observation text that is partial. */
const OBSERVATION_CUT_MARKER = " …[cut]";
/** Longest wait for one end-of-loop page read, so a hung tab never blocks the
 * tool. At most OBSERVATIONS_KEPT reads run, all inside the overall deadline
 * (a read starts only with this much of it left), so they fit in
 * browseTaskInnerBoundMs()'s margin. */
const OBSERVATION_READ_TIMEOUT_MS = 5_000;

/** An observation before the caps: `cut` marks text already partial;
 * `sameAs` marks a page identical to that sub-goal's (its text is a pointer). */
type RawObservation = Observation & { cut?: boolean; sameAs?: number };

/**
 * Reads the visible page text once, bounded by a timeout, an abort and
 * `maxChars`. Any failure (no tab, bridge error, timeout, empty page) means
 * no observation. `url` is the page the read result reports.
 */
async function readObservation(
  browser: BrowserBridge,
  fallbackUrl: string,
  subgoal: number | undefined,
  signal: AbortSignal | undefined,
  maxChars: number
): Promise<RawObservation | undefined> {
  if (signal?.aborted) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const read = await Promise.race([
      readPageText(browser, maxChars),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), OBSERVATION_READ_TIMEOUT_MS);
        onAbort = () => resolve(undefined);
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    if (!read || signal?.aborted) return undefined;
    const text = read.text.trim();
    if (!text) return undefined;
    return {
      ...(subgoal !== undefined ? { subgoal } : {}),
      url: read.url ?? fallbackUrl,
      text,
      ...(read.truncated ? { cut: true } : {}),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

function lastReal(list: RawObservation[]): RawObservation | undefined {
  for (let i = list.length - 1; i >= 0; i--) if (list[i].sameAs === undefined) return list[i];
  return undefined;
}

/**
 * Applies the caps to the captured observations: keeps the last
 * OBSERVATIONS_KEPT, then trims the oldest until the total fits. Every cut
 * text ends with OBSERVATION_CUT_MARKER; one trimmed below
 * OBSERVATION_MIN_CHARS is dropped. A `sameAs` entry keeps its pointer text
 * and is exempt from both. Returns undefined when nothing is left.
 */
export function capObservations(all: RawObservation[]): Observation[] | undefined {
  const kept = all.slice(-OBSERVATIONS_KEPT).map((o) => ({ ...o }));
  const real = (o: RawObservation) => o.sameAs === undefined;
  let excess = kept.filter(real).reduce((n, o) => n + o.text.length, 0) - OBSERVATIONS_TOTAL_MAX_CHARS;
  for (const o of kept) {
    if (excess <= 0) break;
    if (!real(o)) continue;
    const room = o.text.length - excess;
    if (room < OBSERVATION_MIN_CHARS) {
      excess -= o.text.length;
      o.text = "";
    } else {
      o.text = o.text.slice(0, room);
      o.cut = true;
      excess = 0;
    }
  }
  const out: Observation[] = [];
  for (const o of kept) {
    if (real(o)) {
      if (!o.text) continue;
      out.push({ ...(o.subgoal !== undefined ? { subgoal: o.subgoal } : {}), url: o.url, text: o.cut ? o.text + OBSERVATION_CUT_MARKER : o.text });
    } else {
      // The entry it points to may have been dropped by the caps above.
      const shown = out.some((p) => p.subgoal === o.sameAs);
      const text = shown ? `(same page as sub-goal ${o.sameAs})` : `(same page as sub-goal ${o.sameAs}; its text was not kept)`;
      out.push({ ...(o.subgoal !== undefined ? { subgoal: o.subgoal } : {}), url: o.url, text });
    }
  }
  return out.length > 0 ? out : undefined;
}

const STEP_SCREENSHOT_TIMEOUT_MS = 4_000;

interface StepCapture {
  info: StepScreenshotInfo;
  /** Image exactly as the bridge returned it (trimmed); the backend normalizes. */
  image?: string;
  /** The bridge ignored `snapshotId` and minted a new snapshot, so the
   * loop's id is stale and must be re-taken. */
  staleSnapshot?: boolean;
}

/**
 * Captures a marked screenshot of THE GIVEN snapshot (no new snapshot).
 * Never throws: any error, timeout or malformed result yields an outcome
 * without an image so the step is sent without one.
 *
 * Old shells / old cloud vendors ignore `snapshotId` and mint a fresh
 * snapshot; the result's `snapshotId` then differs (or is missing). The image
 * is discarded and `staleSnapshot` tells the caller to stop capturing and
 * re-take its snapshot.
 *
 * The timeout is client-side only: the bridge command may still hold the
 * controller lock after we give up (desktop `withCommandTimeout` bounds it).
 */
export async function captureStepScreenshot(
  browser: BrowserBridge,
  snapshotId: string
): Promise<StepCapture> {
  const started = Date.now();
  const done = (screenshot: StepScreenshotOutcome, extra: Partial<StepCapture> & { marked?: unknown } = {}): StepCapture => {
    const { marked, ...rest } = extra;
    return {
      info: {
        screenshot,
        screenshotMs: Date.now() - started,
        ...(typeof marked === "number" || typeof marked === "boolean" ? { marked } : {}),
      },
      ...rest,
    };
  };
  if (typeof browser.screenshot !== "function") return done("unsupported");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      browser.screenshot({ annotate: true, snapshotId }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("screenshot timeout")), STEP_SCREENSHOT_TIMEOUT_MS);
      }),
    ]);
    if (resultError(raw) || !raw || typeof raw !== "object") return done("failed");
    const result = raw as { imageData?: unknown; snapshotId?: unknown; marked?: unknown };
    if (result.snapshotId !== snapshotId) return done("unsupported", { staleSnapshot: true });
    const data = typeof result.imageData === "string" ? result.imageData.trim() : "";
    if (data === "") return done("failed");
    // Nothing was outlined: the prompt note would promise numbered boxes that
    // are not there, so the image is not sent.
    if (result.marked === 0) return done("unmarked", { marked: 0 });
    // Over the step schema's cap: sending it would 400 the whole step.
    if (data.length > BACKEND_MAX_SCREENSHOT_CHARS) return done("too_large", { marked: result.marked });
    return done("sent", { image: data, marked: result.marked });
  } catch (err) {
    return done(err instanceof Error && err.message === "screenshot timeout" ? "timeout" : "failed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const MODAL_MAX_CHARS = 200;

function modalFor(snapshot: SnapshotResult): string | undefined {
  if (typeof snapshot.modal !== "string") return undefined;
  const modal = sliceToChars(snapshot.modal.trim(), MODAL_MAX_CHARS);
  return modal || undefined;
}

async function requestStep(
  env: LoopEnv,
  goal: string,
  snapshot: SnapshotResult,
  history: StepHistoryEntry[],
  pageText: string | undefined,
  screenshot: string | undefined,
  signal: AbortSignal | undefined,
  clock: RetryClock
): Promise<StepResponse> {
  // 429 / 503+Retry-After retries happen inside, invisible to the loop: no
  // history entry, no stall count, no step budget.
  const modal = modalFor(snapshot);
  const res = await fetchBrowseBackend(env.backend, "/api/browse/step", {
    goal: truncateToChars(goal, BACKEND_MAX_GOAL),
    ...sanitizedPageBody(snapshot),
    history: history.slice(-HISTORY_LIMIT),
    // browse-speed-contract.md, "Frontend" item 4 / "Backend" item 5: the
    // snapshot's scroll position, forwarded untouched so Jev's state digest
    // can mention it. Omitted entirely (rather than sent as `undefined`,
    // which JSON.stringify would drop from the body anyway) when the
    // snapshot doesn't carry one — an older desktop bridge, say.
    ...(snapshot.scroll !== undefined ? { scroll: snapshot.scroll } : {}),
    // Name of an open aria-modal dialog the element table was scoped to, so
    // the backend knows a dialog covers the page. Trimmed and capped; omitted
    // when absent/empty. An older backend's zod object strips unknown keys.
    ...(modal !== undefined ? { modal } : {}),
    ...(pageText !== undefined ? { pageText } : {}),
    ...(screenshot !== undefined ? { screenshot } : {}),
    // User switches (password entry / confirm irreversible), passed in by the
    // host (`permissions` option) and sent as given. An older backend's zod
    // object strips it. Omitted when the host gave none.
    ...(env.permissions !== undefined
      ? { permissions: { ...(typeof env.permissions === "function" ? env.permissions() : env.permissions) } }
      : {}),
  }, undefined, signal, clock);
  if (!res.ok) {
    throw new Error(`/api/browse/step responded ${res.status}`);
  }
  return res.body as StepResponse;
}

/**
 * `openedTab`/`dialogs` (docs/superpowers/specs/
 * 2026-09-23-full-browser-use-design.md, "Desktop bridge") can ride along on
 * any `act`/`perform` result. Folded into the step's label (and therefore
 * into both the transcript and the history Jev sees on the next request) so
 * a tab switch or an auto-handled JS dialog isn't silently invisible to the
 * next decision — Jev needs to know the page it's driving just changed out
 * from under it.
 */
function describeSideEffects(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const parts: string[] = [];

  const openedTab = (value as { openedTab?: unknown }).openedTab;
  if (openedTab && typeof openedTab === "object") {
    const title = (openedTab as { title?: unknown }).title;
    const url = (openedTab as { url?: unknown }).url;
    const name =
      typeof title === "string" && title ? title : typeof url === "string" ? url : "new tab";
    parts.push(`→ opened tab: ${truncateToChars(name, SIDE_EFFECT_FRAGMENT_MAX_CHARS)}`);
  }

  const dialogs = (value as { dialogs?: unknown }).dialogs;
  if (Array.isArray(dialogs) && dialogs.length > 0) {
    const summary = dialogs
      .map((d: unknown) => {
        const type = d && typeof d === "object" && typeof (d as { type?: unknown }).type === "string"
          ? (d as { type: string }).type
          : "dialog";
        const message =
          d && typeof d === "object" && typeof (d as { message?: unknown }).message === "string"
            ? truncateToChars((d as { message: string }).message, SIDE_EFFECT_FRAGMENT_MAX_CHARS)
            : "";
        return message ? `${type}: ${message}` : type;
      })
      .join("; ");
    parts.push(`(dialog auto-handled: ${summary})`);
  }

  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

/** True when a `browser.act` result explicitly reports `changed: false` —
 * the action ran (no `{ error }`) but altered nothing. See its call site's
 * comment for why that must count as an unproductive step for stall
 * detection, same as a rejected act. A result with no `changed` field at
 * all (a bridge that predates the `{ changed, changes }` diff, or a result
 * shape that doesn't carry it) is NOT treated as no-effect — only an
 * explicit `false` is, so this stays a strict tightening rather than a
 * behavior change for bridges that don't report it. */
function isNoEffectResult(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return (value as { changed?: unknown }).changed === false;
}

/** Browse-speed contract (2026-09-24), frontend item 2: a `changed: false`
 * result (see isNoEffectResult above) is NOT actually unproductive when it
 * also reports `pageChanged: true` — the acted-on element's own signature
 * didn't move, but something a user would see elsewhere on the page did
 * (the canonical case: "Add to Cart" POSTs, then updates a separate
 * `#cart-status` element's text — the button itself never changes). Without
 * this, browse_task's loop recorded "(no effect)" and re-clicked the same
 * control repeatedly until it stalled, even though the click worked. Only
 * an explicit `pageChanged: true` counts — a missing field (a bridge that
 * predates it) stays "(no effect)", same conservative default
 * isNoEffectResult already uses for `changed`. Returns the label suffix to
 * record in place of "(no effect)", or `null` when the result doesn't
 * qualify. */
function describePageUpdate(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { pageChanged?: unknown; appeared?: unknown };
  if (v.pageChanged !== true) return null;
  const appeared = Array.isArray(v.appeared) ? v.appeared.filter((s): s is string => typeof s === "string") : [];
  const first = appeared[0];
  return first ? `(page updated: "${truncateToChars(first, SIDE_EFFECT_FRAGMENT_MAX_CHARS)}")` : "(page updated)";
}

/** Outcome of a single cache-replay attempt (`replayCachedStep`). `ok:
 * false` always means the replay was actually DISPATCHED to `browser.
 * perform` (rejected, landed no effect, or threw/timed out) — the caller
 * must treat the page as possibly changed and take a fresh snapshot before
 * falling back to Jev, not just delete the entry and reuse the snapshot it
 * already had (see the cache-lookup block below). `label` is either the
 * landed step's display label (ok: true) or a short failure reason (ok:
 * false), suitable for recording straight into the transcript/history
 * either way. */
interface CacheReplayResult {
  ok: boolean;
  label: string;
  /** The raw `perform` result of a landed replay — feeds the effect note. */
  result?: unknown;
}

/**
 * Replays a cached step (actionCache.ts) via `browser.perform` — the
 * action-cache equivalent of the ordinary perform dispatch further down
 * this file. Deliberately scoped to `PerformOperation` only: the cache
 * never stores WAIT (see `isCacheableStepOperation`) or the `browser.act`
 * operations (PRESS_ENTER/PRESS_ESCAPE/HOVER) — those are comparatively
 * rare, cheap follow-ups (PRESS_ENTER in particular is only ever valid
 * right after a landed TYPE_TEXT, a piece of state this replay path has no
 * way to check), so the cache targets the common, high-value case
 * (CLICK/TYPE_TEXT/SELECT/SCROLL_*) rather than reproducing every dispatch
 * rule for a marginal extra hit rate. `goal` is used to read a TYPE_TEXT/
 * SELECT entry's text back out of its stored `textRange` — the cache never
 * persists raw typed text (see `CachedStep.textRange`'s doc comment).
 * `targetLabel` is the FRESH element's own label (from this iteration's
 * snapshot), not anything read back off `cached` — the cache never persists
 * a target's raw label either (see `CachedStepTarget.labelHash`'s comment),
 * only a hash of it, so the caller must hand this in for display purposes.
 */
async function replayCachedStep(
  browser: BrowserBridge,
  cached: CachedStep,
  index: number | undefined,
  snapshotId: string,
  goal: string,
  targetLabel: string | undefined
): Promise<CacheReplayResult> {
  const text = readTextFromRange(goal, cached.textRange);
  const performArgs: {
    snapshotId: string;
    index?: number;
    operation: PerformOperation;
    text?: string;
  } = {
    snapshotId,
    operation: cached.operation as PerformOperation,
    text,
  };
  if (index != null) performArgs.index = index;

  try {
    const performed = await browser.perform(performArgs);
    const rejected = resultError(performed);
    if (rejected) return { ok: false, label: rejected };
    const noEffectRaw = isNoEffectResult(performed);
    const pageUpdate = noEffectRaw ? describePageUpdate(performed) : null;
    if (noEffectRaw && !pageUpdate) return { ok: false, label: "(no effect)" };
    const baseLabel = targetLabel ?? "";
    const displayLabel =
      cached.operation === "TYPE_TEXT" && text
        ? `TYPE_TEXT "${truncateToChars(text, 60)}" into "${baseLabel}"`
        : baseLabel;
    return {
      ok: true,
      label: `${displayLabel}${describeSideEffects(performed)}${pageUpdate ? ` ${pageUpdate}` : ""}`,
      result: performed,
    };
  } catch (err) {
    return { ok: false, label: err instanceof Error ? err.message : "cache replay failed" };
  }
}

/**
 * Writes a just-landed perform step to the action cache, when it's safe to.
 * `cacheKey` is `undefined` when the cache is disabled (kill switch) —
 * checked once, at the call site, so this stays a plain no-op rather than
 * re-deriving that. Looks the acted-on element up by its own `.index`
 * field (`findElementByIndex`), NOT array position — the snapshot's
 * element list is not guaranteed dense/positional. Refuses to cache:
 * irreversible/sensitive-sounding target labels, typing into a
 * password/OTP/card/IBAN-shaped field (`isUnsafeCachedTarget` — checks the
 * matched element's own `isPassword` plus its label/type), and TYPE_TEXT/
 * SELECT text that `looksSensitive` (a card-number/password-shaped
 * string) OR does not occur verbatim in `goal` (`findTextRangeInGoal` —
 * the cache never persists raw typed text, only an offset into the goal;
 * when the text isn't literally present in the goal there is no offset to
 * store, so the step is simply not cached) — see actionCache.ts's header
 * comment for why a false-positive refusal here is always the safe
 * direction.
 */
function maybeWriteStepCache(
  storage: KeyValueStorage | undefined,
  cacheKey: string | undefined,
  operation: PerformOperation,
  index: number | undefined,
  text: string | undefined,
  goal: string,
  elements: unknown[]
): void {
  if (!cacheKey || !isCacheableStepOperation(operation)) return;

  let target: CachedStepTarget | undefined;
  if (index != null) {
    const el = findElementByIndex(elements, index) as
      | { label?: unknown; tag?: unknown; role?: unknown; type?: unknown; isPassword?: unknown; disabled?: unknown }
      | undefined;
    if (!el || typeof el.tag !== "string") return;
    const label = typeof el.label === "string" ? el.label : "";
    if (isUnsafeCachedTarget(operation, label, el.type, el.isPassword, el.disabled)) return;
    target = {
      labelHash: hashCachedLabel(label),
      tag: el.tag,
      ...(typeof el.role === "string" ? { role: el.role } : {}),
    };
  }

  let textRange: [number, number] | undefined;
  if (operation === "TYPE_TEXT" || operation === "SELECT") {
    if (looksSensitive(text)) return;
    textRange = text ? findTextRangeInGoal(goal, text) : undefined;
    if (!textRange) return;
  }

  writeStepCacheEntry(storage, cacheKey, goal, elements, {
    operation,
    target,
    ...(textRange ? { textRange } : {}),
  });
}

/**
 * Records a step and appends it to the running history in one go —
 * hard-truncating `label` to HISTORY_LABEL_MAX_CHARS first. This is the
 * backstop, not describeSideEffects' per-fragment truncation above: the
 * BASE label (an element's own text, or an error message from the bridge/
 * backend) has no length guarantee either, so the cap has to apply here,
 * after everything is concatenated, not just to the side-effect fragments.
 */
function recordStep(
  steps: TranscriptStep[],
  history: StepHistoryEntry[],
  entry: TranscriptStep
): { step: TranscriptStep; hist: StepHistoryEntry } {
  const truncated: TranscriptStep = {
    ...entry,
    label: fitLabel(entry.label, HISTORY_LABEL_MAX_CHARS),
  };
  steps.push(truncated);
  const hist: StepHistoryEntry = {
    operation: truncated.operation,
    label: truncated.label,
    ok: truncated.ok,
    ...(truncated.index !== undefined ? { index: truncated.index } : {}),
  };
  history.push(hist);
  return { step: truncated, hist };
}

export { EARLIER_SUBGOAL_SUFFIX };
/** How many trailing history entries the next sub-goal inherits. */
const CARRYOVER_ENTRIES = 2;

/**
 * Seed history for sub-goal k>1: the last CARRYOVER_ENTRIES entries of the
 * previous one, each label suffixed EARLIER_SUBGOAL_SUFFIX (the base is cut to
 * keep the 200-char cap, never the suffix). `index` is dropped: it points into
 * a snapshot that no longer exists.
 */
export function carryOverHistory(previous: StepHistoryEntry[]): StepHistoryEntry[] {
  return previous.slice(-CARRYOVER_ENTRIES).map((e) => ({
    operation: e.operation,
    label: e.label.endsWith(EARLIER_SUBGOAL_SUFFIX)
      ? e.label
      : appendKeepingSuffix(e.label, EARLIER_SUBGOAL_SUFFIX, HISTORY_LABEL_MAX_CHARS),
    ok: e.ok,
    ...(e.via ? { via: e.via } : {}),
  }));
}

/** Retry of the SAME sub-goal: its stalled attempt's last entries, without the
 * "earlier sub-goal" marker (they belong to this sub-goal). */
export function sameGoalSeed(previous: StepHistoryEntry[]): StepHistoryEntry[] {
  return previous.slice(-CARRYOVER_ENTRIES).map((e) => ({
    operation: e.operation,
    label: e.label.split(EARLIER_SUBGOAL_SUFFIX).join(""),
    ok: e.ok,
    ...(e.via ? { via: e.via } : {}),
  }));
}

/** History as the step-cache key sees it: no volatile effect notes, no
 * carried-over entries (they differ across runs). */
function cacheKeyHistory(history: StepHistoryEntry[]): StepHistoryEntry[] {
  return history
    .filter((e) => !e.label.endsWith(EARLIER_SUBGOAL_SUFFIX))
    .map((e) => ({ ...e, label: stripVolatileLabelParts(e.label) }));
}

/** A landed CLICK waiting for the next snapshot to learn what it did. */
interface PendingEffect {
  prev: SnapshotResult;
  acted: ActedElement | undefined;
  result: unknown;
  step: TranscriptStep;
  hist: StepHistoryEntry;
}

function actedElementOf(snapshot: SnapshotResult, index: number | undefined): ActedElement | undefined {
  if (index == null) return undefined;
  const el = findElementByIndex(snapshot.elements, index) as
    | { label?: unknown; tag?: unknown; role?: unknown }
    | undefined;
  if (!el || typeof el.label !== "string") return undefined;
  return {
    index,
    label: el.label,
    ...(typeof el.tag === "string" ? { tag: el.tag } : {}),
    ...(typeof el.role === "string" ? { role: el.role } : {}),
  };
}

/** Appends the effect note to the recorded CLICK (transcript + history). */
function applyPendingEffect(pending: PendingEffect, next: SnapshotResult): BecameLabel | undefined {
  const { note, became } = describeEffectDetailed(pending.prev, next, pending.acted, pending.result);
  if (!note) return undefined;
  const label = appendKeepingSuffix(pending.step.label, note, HISTORY_LABEL_MAX_CHARS);
  pending.step.label = label;
  pending.hist.label = label;
  return became;
}

/** Sub-goal bookkeeping shared with the caller: `seed` goes in front of the
 * loop's history, `final` receives the (live) history array. */
export interface HistoryShare {
  seed?: StepHistoryEntry[];
  final?: StepHistoryEntry[];
  /** Multi-sub-goal runs only: a CLICK whose effect shows a commit (see
   * isCommitEffect) ends the sub-goal as done without another step request. */
  autoConfirmCommit?: boolean;
}

/** Label prefix of the synthetic DONE step the auto-confirm records. It is not
 * an action, so multi-sub-goal step accounting skips it (see actionSteps). */
const AUTO_CONFIRM_LABEL = "auto-confirmed by effect";
const actionSteps = (steps: TranscriptStep[]): number =>
  steps.filter((s) => !(s.operation === "DONE" && s.label.startsWith(AUTO_CONFIRM_LABEL))).length;

/** Blank = no elements AND page text that is present but empty. A missing
 * `text` means an older desktop build that never sends it (pageTextFor falls
 * back to `read`), not a blank page — never polled. */
function isEmptySnapshot(snapshot: SnapshotResult): boolean {
  return snapshot.elements.length === 0 && typeof snapshot.text === "string" && snapshot.text.trim() === "";
}

/** Re-snapshots (bounded) while the page is still blank — see EMPTY_SNAPSHOT_POLL_MS.
 * A snapshot error during polling is returned as-is (existing error handling). */
async function settleEmptySnapshot(
  browser: BrowserBridge,
  first: Awaited<ReturnType<typeof takeSnapshot>>,
  sleep: (ms: number) => Promise<void>,
  signal?: AbortSignal
): Promise<Awaited<ReturnType<typeof takeSnapshot>>> {
  let current = first;
  for (let i = 0; i < EMPTY_SNAPSHOT_MAX_POLLS; i++) {
    if (signal?.aborted) return current;
    if ("error" in current || !isEmptySnapshot(current)) return current;
    await sleep(EMPTY_SNAPSHOT_POLL_MS);
    current = await takeSnapshot(browser);
  }
  return current;
}

/** Result of the pre-loop open/probe: a terminal `failure` transcript, or the
 * snapshot to reuse as the loop's first iteration (when a tab was already
 * open on the right page). */
interface Preamble {
  failure?: Transcript;
  initialSnapshot?: SnapshotResult;
}

/**
 * The cheap pre-loop work (see the long comment inside): open `url` / the
 * URL named in the ORIGINAL goal, or probe for an open tab. Extracted from
 * runBrowseTaskLoop so runBrowseTask can run it BEFORE the paid plan call.
 */
async function runPreamble(
  goal: string,
  browser: BrowserBridge,
  url?: string
): Promise<Preamble> {
  let initialSnapshot: SnapshotResult | undefined;
  if (url) {
    const openFailure = await openBeforeLoop(browser, url);
    if (openFailure) return { failure: openFailure };
  } else {
    const probe = await takeSnapshot(browser);
    if ("error" in probe) {
      if (NO_TAB_OPEN_PATTERN.test(probe.error)) {
        const goalUrl = extractUrlFromGoal(goal);
        if (!goalUrl) {
          return {
            failure: {
              status: "blocked",
              steps: [],
              url: "",
              title: "",
              reason: "No browser tab is open — pass url or call browse_open first",
            },
          };
        }
        const openFailure = await openBeforeLoop(browser, goalUrl);
        if (openFailure) return { failure: openFailure };
      }
      // Any other probe error (unrelated to "no tab") is deliberately
      // discarded here — the loop's own first iteration takes its own
      // fresh snapshot below, keeping this probe a pure pre-check with no
      // effect on the loop's normal state machine.
    } else {
      // Finding: a tab is already open, but the goal may name a URL on a
      // DIFFERENT origin — that used to be silently ignored whenever any
      // tab happened to be open, even on an unrelated site. Only navigate
      // when the goal's URL and the current tab disagree on origin; same
      // origin (or no URL in the goal at all) means stay put and reuse this
      // snapshot as the loop's first iteration (see `initialSnapshot`
      // above).
      const goalUrl = extractUrlFromGoal(goal);
      if (goalUrl && !sameOrigin(goalUrl, probe.url)) {
        const openFailure = await openBeforeLoop(browser, goalUrl);
        if (openFailure) return { failure: openFailure };
        // The page just navigated — `probe` is now stale, do NOT reuse it.
      } else {
        initialSnapshot = probe;
      }
    }
  }
  return { initialSnapshot };
}

/**
 * Runs the snapshot → step → perform loop. Exported separately from the
 * `ToolHandler` wrapper so tests can drive it directly and so the deadline
 * check and the WAIT sleep each have a single injectable seam — real time
 * (`Date.now`) and a real `setTimeout` in production, a fake clock and an
 * instrumented no-op sleep in tests exercising those branches without a
 * real wait.
 */
export async function runBrowseTaskLoop(
  goal: string,
  maxSteps: number,
  env: LoopEnv,
  now: () => number = () => Date.now(),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  url?: string,
  deadlineMs: number = BROWSE_TASK_DEADLINE_MS,
  /** When given, the pre-loop open/probe was already done by the caller
   * (runBrowseTask) — skip it and reuse its snapshot. */
  preamble?: { initialSnapshot?: SnapshotResult },
  /** Aborts on Stop / tool-call timeout: checked at the top of every step. */
  signal?: AbortSignal,
  /** Sub-goal history carry-over (see carryOverHistory). */
  share?: HistoryShare
): Promise<Transcript> {
  const { browser, storage } = env;
  // An empty goal would 400 /api/browse/step (goal min 1) on every cycle.
  if (goal.trim() === "") {
    return { status: "blocked", steps: [], url: "", title: "", reason: "browse_task: the goal is empty — describe what to do in the browser." };
  }
  const cappedMaxSteps = Math.min(Math.max(1, Math.floor(maxSteps)), HARD_MAX_STEPS);
  const deadline = now() + deadlineMs;
  const steps: TranscriptStep[] = [];
  const history: StepHistoryEntry[] = share?.seed ? [...share.seed] : [];
  if (share) share.final = history;
  let pendingEffect: PendingEffect | null = null;

  let lastUrl = "";
  let lastTitle = "";

  // Bench finding A: don't spend paid Jev steps discovering there is no
  // browser tab open. Either an explicit `url` (open it first, always) or,
  // absent that, a cheap local snapshot probe: if the bridge reports no
  // tab, look for an http(s) URL inside the goal and open THAT; only if
  // neither is available do we give up immediately, before the loop
  // (and before any /api/browse/step call) even starts.
  //
  // Finding: a snapshot taken here that turns out to still be current (the
  // happy path below, where a tab is already open on the right origin) used
  // to be thrown away, only for the loop's own first iteration to take an
  // identical fresh one immediately after — doubling the snapshot cost of
  // every browse_task call that starts with a tab already open. Captured
  // here and handed to the loop as `initialSnapshot` instead.
  let initialSnapshot: SnapshotResult | undefined;
  if (preamble) {
    initialSnapshot = preamble.initialSnapshot;
  } else {
    const pre = await runPreamble(goal, browser, url);
    if (pre.failure) return pre.failure;
    initialSnapshot = pre.initialSnapshot;
  }

  // PR #40: a step that landed nothing is still recorded (Jev needs to see
  // the no-op in `history`, or it re-picks the same dead target), but three
  // in a row end the task instead of grinding out the whole budget.
  let unproductive = 0;
  /** The most recent SUCCESSFULLY landed step's `operation` — used to gate
   * PRESS_ENTER (see its dispatch below: Enter is only pressed right after
   * a TYPE_TEXT that landed, since a perform CLICK never moves focus, and a
   * WAIT/SCROLL in between means Enter would submit whatever the page
   * happens to have focus on, not the field Jev meant). `null` until the
   * first step lands. */
  let lastLandedOperation: string | null = null;
  /** True while the most recent landed step was a CLICK on a choice control
   * (see isChoiceElement) — a menu-style picker may still be open and apply
   * its selection only once closed. Any other landed step clears it. */
  let lastLandedChoiceClick = false;
  /** One-shot guard: the loop closes an open popup at most once before
   * accepting DONE (a second DONE is taken as is). */
  let popupCloseTried = false;
  /** Bench finding B: Jev kept re-typing the same query into the search box
   * instead of pressing Enter to submit it. Tracks the index (and text) of
   * the element a landed TYPE_TEXT just filled, so the very next decision
   * can be checked for the degenerate "type into the same field again"
   * pattern — see the TYPE_TEXT-dedup rule below, right after `operation`
   * is read out of the next decision. Cleared implicitly: the rule only
   * fires when `lastLandedOperation === "TYPE_TEXT"` too, so a landed
   * CLICK/SCROLL/etc. in between makes this stale value irrelevant even
   * though it isn't reset. */
  let lastTypeText: { index: number; text: string } | null = null;
  /** How many consecutive WAIT decisions have landed on the SAME url as the
   * previous WAIT (see MAX_CONSECUTIVE_SAME_URL_WAITS) — reset to 0 the
   * moment the url changes or a non-WAIT operation is decided. `null` url
   * means no WAIT has happened yet in the current streak. */
  let sameUrlWaitStreak = 0;
  let waitStreakUrl: string | null = null;
  /** How many steps this run resolved from the local action cache instead of
   * calling /api/browse/step — see the cache-replay block at the top of the
   * loop below, and Transcript.cacheHits' doc comment. */
  let cacheHits = 0;
  /** Per-task: set once a capture shows the bridge can't do snapshot-bound
   * screenshots (no method, or it ignored `snapshotId`); no more calls. */
  let screenshotsUnsupported = false;
  /** Capture outcome of the current iteration, merged into the next note(). */
  let pendingShot: StepScreenshotInfo | undefined;
  /** recordStep plus the no-progress check. Returns the transcript to
   * return when the loop has stalled, or null to carry on. */
  let lastRecorded: { step: TranscriptStep; hist: StepHistoryEntry } | null = null;
  /** Page url each recorded step ran on, for the two-step cycle check. */
  const stepUrls = new WeakMap<TranscriptStep, string>();
  const stepKey = (st: TranscriptStep): string => `${st.operation}\u0000${st.label}\u0000${stepUrls.get(st) ?? ""}`;
  /** Live run finding: SCROLL_DOWN/SCROLL_UP alternating for 30-40 steps on a long
   * page. Fires when the last SCROLL_OSCILLATION_WINDOW steps are all landed
   * scrolls on one url with at least 2 direction reversals; any other step resets it. */
  const detectScrollOscillation = (): Transcript | null => {
    if (steps.length < SCROLL_OSCILLATION_WINDOW) return null;
    const tail = steps.slice(-SCROLL_OSCILLATION_WINDOW);
    if (!tail.every((st) => st.ok && (st.operation === "SCROLL_UP" || st.operation === "SCROLL_DOWN"))) return null;
    // A lone reversal is reading then overshoot, not oscillation.
    const reversals = tail.filter((st, j) => j > 0 && st.operation !== tail[j - 1].operation).length;
    if (reversals < 2) return null;
    if (new Set(tail.map((st) => comparableUrl(stepUrls.get(st) ?? ""))).size > 1) return null;
    return {
      status: "stalled",
      steps,
      url: lastUrl,
      title: lastTitle,
      reason: `scroll oscillation — scrolled back and forth ${SCROLL_OSCILLATION_WINDOW} times without acting`,
      cacheHits,
    };
  };
  /** The stalled transcript when the last steps repeat A,B,A,B,A,B, else null.
   * Keys are read now, not at record time: a CLICK's effect text is appended
   * to its label one snapshot later. */
  const detectCycle = (): Transcript | null => {
    const oscillation = detectScrollOscillation();
    if (oscillation) return oscillation;
    const len = CYCLE_PERIOD_REPEATS * 2;
    if (steps.length < len) return null;
    const tail = steps.slice(-len);
    const keys = tail.map(stepKey);
    if (keys[0] === keys[1]) return null;
    if (!keys.every((key, j) => key === keys[j % 2])) return null;
    return {
      status: "stalled",
      steps,
      url: lastUrl,
      title: lastTitle,
      reason: `cycle — "${tail[0].label}" and "${tail[1].label}" repeated ${CYCLE_PERIOD_REPEATS} times`,
      cacheHits,
    };
  };
  const note = (entry: TranscriptStep): Transcript | null => {
    // The step screenshot capture outcome rides on the first entry recorded
    // after it (the bench reads the transcript).
    lastRecorded = recordStep(steps, history, pendingShot ? { ...entry, ...pendingShot } : entry);
    pendingShot = undefined;
    stepUrls.set(lastRecorded.step, lastUrl);
    const cycle = detectCycle();
    if (cycle) return cycle;
    if (entry.ok) {
      unproductive = 0;
      lastLandedOperation = entry.operation;
      lastLandedChoiceClick = false;
      return null;
    }
    unproductive++;
    if (unproductive < MAX_CONSECUTIVE_UNPRODUCTIVE_STEPS) return null;
    return {
      status: "stalled",
      steps,
      url: lastUrl,
      title: lastTitle,
      reason: `no progress — ${MAX_CONSECUTIVE_UNPRODUCTIVE_STEPS} consecutive steps landed nothing (last: ${entry.operation}: ${entry.label})`,
      cacheHits,
    };
  };

  const cancelledResult = (): Transcript => ({
    status: "blocked",
    steps,
    url: lastUrl,
    title: lastTitle,
    reason: CANCELLED_REASON,
    cacheHits,
  });

  for (let stepCount = 0; stepCount < cappedMaxSteps; stepCount++) {
    if (signal?.aborted) return cancelledResult();
    // browse-speed-contract.md, "Frontend" item 4: bail before STARTING a
    // step once less than STEP_DEADLINE_RESERVE_MS remains, not only once
    // the deadline itself has passed — a step begun with too little budget
    // left can still burn most of a desktop command timeout before the
    // loop gets back here to notice.
    if (deadline - now() < STEP_DEADLINE_RESERVE_MS) {
      return { status: "budget", steps, url: lastUrl, title: lastTitle, reason: "deadline exceeded", cacheHits };
    }

    // Finding: reuse the pre-loop probe as this first iteration's snapshot
    // (when one was captured — see `initialSnapshot`'s comment above)
    // instead of immediately re-taking an identical one.
    const freshSnapshot = stepCount === 0 && initialSnapshot ? initialSnapshot : await takeSnapshot(browser);
    const snapshotResult = stepCount === 0 ? await settleEmptySnapshot(browser, freshSnapshot, sleep, signal) : freshSnapshot;
    if (signal?.aborted) return cancelledResult();
    if ("error" in snapshotResult) {
      pendingEffect = null;
      const stalled = note({
        operation: "SNAPSHOT",
        label: snapshotResult.error,
        ok: false,
      });
      if (stalled) return stalled;
      continue;
    }
    let snapshot: SnapshotResult = snapshotResult;
    pendingShot = undefined;
    let effectApplied = false;
    if (pendingEffect) {
      const became = applyPendingEffect(pendingEffect, snapshot);
      pendingEffect = null;
      effectApplied = true;
      const commit = share?.autoConfirmCommit ? isCommitEffect(became) : null;
      if (commit) {
        const reason = `commit effect observed: ${commit}`;
        recordStep(steps, history, {
          operation: "DONE",
          label: `${AUTO_CONFIRM_LABEL} — ${commit}`,
          ok: true,
        });
        return { status: "done", steps, url: snapshot.url, title: snapshot.title, reason, cacheHits };
      }
    }

    lastUrl = snapshot.url;
    lastTitle = snapshot.title;

    // The landed CLICK's effect suffix is now part of its label, so a cycle
    // ending in a CLICK only shows here. A cycle already reported by note()
    // never reaches this point (the run returned).
    if (effectApplied) {
      const cycle = detectCycle();
      if (cycle) return cycle;
    }

    // Action cache (Stagehand-style EXACT-INPUT MEMO, see actionCache.ts's
    // header comment): computed once per iteration and reused both for the
    // lookup below and, further down, for writing a freshly-landed Jev/
    // cascade/rule decision — `history` hasn't been mutated by THIS
    // iteration yet, so the key reflects "exact goal + exact url + exact
    // title + exact element set + full history so far + bucketed scroll",
    // exactly what a future identical run would see at the same point (and
    // never anything less exact than that — see the module header for why).
    let stepCacheKey = isActionCacheEnabled(storage)
      ? buildStepCacheKey(goal, snapshot.url, snapshot.title, snapshot.elements, cacheKeyHistory(history), snapshot.scroll, modalFor(snapshot))
      : undefined;
    if (stepCacheKey) {
      const cached = lookupStepCache(storage, stepCacheKey, goal, snapshot.elements);
      if (cached) {
        const cachedIndex = cached.target ? resolveCachedIndex(snapshot.elements, cached.target) : undefined;
        const resolvedElement =
          cachedIndex != null
            ? (findElementByIndex(snapshot.elements, cachedIndex) as
                | { label?: unknown; type?: unknown; isPassword?: unknown; disabled?: unknown }
                | undefined)
            : undefined;
        // Replay-time re-check (on top of the write-time check
        // maybeWriteStepCache already applied): the FRESH element a cached
        // fingerprint resolves to today might not be the same kind of
        // control it was when the entry was written (a page could reuse a
        // label for a different, now-sensitive field). Treat that exactly
        // like "no unique match" below — no attempt is made at all.
        const unsafeAtReplay =
          resolvedElement !== undefined &&
          isUnsafeCachedTarget(
            cached.operation,
            typeof resolvedElement.label === "string" ? resolvedElement.label : undefined,
            resolvedElement.type,
            resolvedElement.isPassword,
            resolvedElement.disabled
          );
        // A target-bearing entry with no unique match (the element is gone,
        // or the page now has more than one candidate), or one that is now
        // unsafe to replay, can't be attempted at all — self-heal
        // immediately, same as an executed-but-failed replay below. A
        // targetless entry (none was ever cached) always proceeds to the
        // attempt.
        if (!unsafeAtReplay && (!cached.target || cachedIndex !== undefined)) {
          if (signal?.aborted) return cancelledResult();
          const replay = await replayCachedStep(
            browser,
            cached,
            cachedIndex,
            snapshot.snapshotId,
            goal,
            typeof resolvedElement?.label === "string" ? resolvedElement.label : undefined
          );
          if (replay.ok) {
            const recorded = recordStep(steps, history, {
              operation: cached.operation,
              label: replay.label,
              ok: true,
              index: cachedIndex,
              via: "cache",
            });
            stepUrls.set(recorded.step, lastUrl);
            markPageState(recorded.step, cached.operation, snapshot, cachedIndex, lastUrl);
            if (cached.operation === "CLICK") {
              pendingEffect = {
                prev: snapshot,
                acted: actedElementOf(snapshot, cachedIndex),
                result: replay.result,
                step: recorded.step,
                hist: recorded.hist,
              };
            }
            unproductive = 0;
            lastLandedOperation = cached.operation;
            lastLandedChoiceClick = cached.operation === "CLICK" && isChoiceElement(snapshot, cachedIndex);
            if (cached.operation === "TYPE_TEXT" && cachedIndex != null) {
              lastTypeText = { index: cachedIndex, text: readTextFromRange(goal, cached.textRange) ?? "" };
            }
            // Same reset a landed non-WAIT Jev/cascade/rule decision gets
            // below (item 5, code review): a cache replay is just as real a
            // step as one Jev itself decided, so a WAIT streak building up
            // before it must not carry over as if nothing happened.
            sameUrlWaitStreak = 0;
            waitStreakUrl = null;
            cacheHits++;
            touchCacheEntry(storage, stepCacheKey);
            const cycle = detectCycle();
            if (cycle) return cycle;
            continue;
          }
          // The replay was actually DISPATCHED to `browser.perform` and
          // failed (rejected, landed no effect, or threw/timed out) — the
          // page may have changed underneath us as a side effect, so this
          // is recorded as a failed step (Jev's next `history` needs to see
          // it, and it counts toward the stall detector the same way any
          // other rejected/no-effect action does) and the loop moves on to
          // its NEXT iteration, which takes a FRESH snapshot before falling
          // back to Jev rather than reusing this now-possibly-stale one.
          deleteCacheEntry(storage, stepCacheKey);
          const stalled = note({
            operation: cached.operation,
            label: `cache replay failed: ${replay.label}`,
            ok: false,
            index: cachedIndex,
            via: "cache",
          });
          if (stalled) return stalled;
          continue;
        }
        // No attempt was made — either no unique fresh match (element gone/
        // ambiguous) or the re-checked element is now unsafe to touch.
        // Nothing was dispatched, so nothing may have changed: it's safe to
        // just drop the entry and fall through to a normal Jev decision
        // using the SAME snapshot this iteration already has.
        deleteCacheEntry(storage, stepCacheKey);
      }
    }

    let decision: StepResponse;
    try {
      const capturing = env.stepScreenshots && !screenshotsUnsupported;
      let [pageText, capture] = await Promise.all([
        pageTextFor(browser, snapshot),
        capturing ? captureStepScreenshot(browser, snapshot.snapshotId) : undefined,
      ]);
      if (capture) {
        pendingShot = capture.info;
        if (capture.info.screenshot === "unsupported") screenshotsUnsupported = true;
        if (capture.staleSnapshot) {
          // The bridge minted a new snapshot behind our back, so the loop's
          // snapshotId is stale for the perform below. Re-take it.
          const retaken = await takeSnapshot(browser);
          if ("error" in retaken) {
            const stalled = note({ operation: "SNAPSHOT", label: retaken.error, ok: false });
            if (stalled) return stalled;
            continue;
          }
          snapshot = retaken;
          lastUrl = snapshot.url;
          lastTitle = snapshot.title;
          if (stepCacheKey) {
            stepCacheKey = buildStepCacheKey(goal, snapshot.url, snapshot.title, snapshot.elements, cacheKeyHistory(history), snapshot.scroll, modalFor(snapshot));
          }
          pageText = await pageTextFor(browser, snapshot);
          capture = undefined;
        }
      }
      decision = await requestStep(env, goal, snapshot, history, pageText, capture?.image, signal, { now, sleep, deadline, reserveMs: STEP_DEADLINE_RESERVE_MS });
    } catch (err) {
      const stalled = note({
        operation: "STEP",
        label: err instanceof Error ? err.message : "/api/browse/step failed",
        ok: false,
      });
      if (signal?.aborted) return cancelledResult();
      if (stalled) return stalled;
      continue;
    }
    // A decision that arrives after Stop must never be performed.
    if (signal?.aborted) return cancelledResult();

    // Addendum B: outcome is the explicit terminal/transient signal. `done`
    // and `blocked` end the task; `retry` (Jev timeout/malformed answer/no
    // candidate element) and anything unrecognized or missing are recorded
    // and the loop continues — treating an unknown outcome as a silent
    // success would be exactly the bug the addendum corrects.
    // Requirement 4: keep `reason` on terminal statuses, and say when the
    // BROWSE_CASCADE_MODEL cascade (not Jev itself) is what decided it — the
    // bench reads these.
    const terminalReason = decision.cascade
      ? `${decision.reason ?? ""}${decision.reason ? " " : ""}(via cascade)`
      : decision.reason;
    // A choice click can leave a menu-style picker open that applies its
    // selection only once closed; finishing now would lose it. Close the
    // popup first (once), then let the policy decide again on a fresh
    // snapshot. Skipped when a dialog is in play (Escape could dismiss it).
    if (
      decision.outcome === "done" &&
      lastLandedChoiceClick &&
      !popupCloseTried &&
      modalFor(snapshot) === undefined &&
      hasOpenPopup(snapshot)
    ) {
      popupCloseTried = true;
      if (signal?.aborted) return cancelledResult();
      let escLabel = "close the open popup before finishing";
      let escOk = true;
      try {
        const acted = await browser.act({ action: "press", key: "Escape" });
        const rejected = resultError(acted);
        if (rejected) {
          escLabel = rejected;
          escOk = false;
        } else {
          escLabel = `${escLabel}${describeSideEffects(acted)}`;
        }
      } catch (err) {
        escLabel = err instanceof Error ? err.message : "act failed";
        escOk = false;
      }
      const stalled = note({ operation: "PRESS_ESCAPE", label: escLabel, ok: escOk, via: "rule" });
      if (stalled) return stalled;
      continue;
    }
    // The final step's capture info would otherwise be dropped (no note()).
    if ((decision.outcome === "done" || decision.outcome === "blocked") && pendingShot) {
      steps.push({
        operation: decision.operation ?? (decision.outcome === "done" ? "DONE" : "BLOCKED"),
        label: truncateToChars(terminalReason ?? decision.outcome, HISTORY_LABEL_MAX_CHARS),
        ok: decision.outcome === "done",
        ...pendingShot,
      });
      pendingShot = undefined;
    }
    if (decision.outcome === "done") {
      return { status: "done", steps, url: lastUrl, title: lastTitle, reason: terminalReason, cacheHits };
    }
    if (decision.outcome === "blocked") {
      return { status: "blocked", steps, url: lastUrl, title: lastTitle, reason: terminalReason, cacheHits };
    }
    if (decision.outcome === "retry") {
      const stalled = note({
        operation: decision.operation ?? "RETRY",
        label: decision.reason ?? "transient step failure, retrying",
        ok: false,
      });
      if (stalled) return stalled;
      continue;
    }
    if (decision.outcome !== "act") {
      const stalled = note({
        operation: decision.operation ?? "UNKNOWN_OUTCOME",
        label: decision.reason ?? `unrecognized step outcome: ${String(decision.outcome)}`,
        ok: false,
      });
      if (stalled) return stalled;
      continue;
    }

    // outcome === "act" from here on.
    const cascadeVia: StepVia | undefined = decision.cascade ? "cascade" : undefined;

    if (decision.operation === "WAIT") {
      const sameUrlAsLastWait = waitStreakUrl !== null && snapshot.url === waitStreakUrl;
      sameUrlWaitStreak = sameUrlAsLastWait ? sameUrlWaitStreak + 1 : 1;
      waitStreakUrl = snapshot.url;

      if (sameUrlWaitStreak > MAX_CONSECUTIVE_SAME_URL_WAITS) {
        // A 3rd (or later) consecutive WAIT landing on the same url as the
        // last one is not executed — nothing changed the last two times we
        // slept, so sleeping again is treated as the unproductive step it
        // actually is (see MAX_CONSECUTIVE_SAME_URL_WAITS), letting the
        // general no-progress counter advance instead of resetting.
        const stalled = note({
          operation: "WAIT",
          label: "(waited, nothing changed)",
          ok: false,
          ...(cascadeVia ? { via: cascadeVia } : {}),
        });
        if (stalled) return stalled;
        continue;
      }

      // Addendum A: WAIT never reaches `perform` — the loop sleeps itself
      // and takes a fresh snapshot on the next iteration.
      note({
        operation: "WAIT",
        label: "waiting for the page to settle",
        ok: true,
        ...(cascadeVia ? { via: cascadeVia } : {}),
      });
      // browse-speed-contract.md, "Frontend" item 4: cap the sleep by
      // whatever's actually left of the deadline, so a WAIT decided with
      // little budget remaining can't itself blow past it.
      await sleep(Math.max(0, Math.min(WAIT_SLEEP_MS, deadline - now())));
      continue;
    }
    sameUrlWaitStreak = 0;
    waitStreakUrl = null;

    let operation = decision.operation;
    if (!operation) {
      const stalled = note({
        operation: "MALFORMED",
        label: decision.reason ?? "act outcome with no operation",
        ok: false,
      });
      if (stalled) return stalled;
      continue;
    }

    // Requirement 2 / bench finding B: Jev (or the cascade) kept re-typing
    // the same query into the search box instead of submitting it. If the
    // step JUST landed a TYPE_TEXT into a search-like field and the very
    // next decision is TYPE_TEXT into that SAME element again, override to
    // PRESS_ENTER instead of repeating the type — a deterministic rule, not
    // a threshold, so it applies regardless of which head/model chose the
    // repeat. Must run before the targetless/index checks below, since
    // PRESS_ENTER (unlike TYPE_TEXT) needs no index.
    let via: StepVia | undefined = cascadeVia;
    if (
      operation === "TYPE_TEXT" &&
      lastLandedOperation === "TYPE_TEXT" &&
      decision.index != null &&
      lastTypeText !== null &&
      lastTypeText.index === decision.index &&
      isSearchLikeElement(snapshot.elements, decision.index) &&
      !hasPasswordElement(snapshot.elements)
    ) {
      operation = "PRESS_ENTER";
      via = "rule";
    }

    // Full browser use (docs/superpowers/specs/
    // 2026-09-23-full-browser-use-design.md): PRESS_ENTER/PRESS_ESCAPE are
    // targetless (they act on whatever already has focus — right after
    // TYPE_TEXT that's the field just typed into), same as a scroll. HOVER
    // targets an element by index, same as CLICK.
    const isTargetless =
      operation === "SCROLL_UP" ||
      operation === "SCROLL_DOWN" ||
      operation === "PRESS_ENTER" ||
      operation === "PRESS_ESCAPE";
    const label = labelForElement(snapshot.elements, decision.index);

    // Addendum A / item 3: CLICK/TYPE_TEXT/SELECT/HOVER require an index; a
    // scroll or a targetless press legitimately carries none. A non-scroll,
    // non-targetless decision arriving without an index is recorded as a
    // failed step rather than forwarded to `perform`/`act`.
    if (!isTargetless && decision.index == null) {
      const stalled = note({
        operation,
        label: label || "missing index for a non-scroll operation",
        ok: false,
      });
      if (stalled) return stalled;
      continue;
    }

    if (operation === "PRESS_ENTER" || operation === "PRESS_ESCAPE" || operation === "HOVER") {
      // Full browser use follow-up (finding: Enter is only meaningful right
      // after typing into a field). The backend already refuses PRESS_ENTER
      // when a password field is anywhere on the page, but it has no way to
      // know WHICH element currently has focus — that's client-side state.
      // A perform CLICK never moves focus, so the only step that reliably
      // leaves the right field focused is a just-landed TYPE_TEXT; anything
      // else (including a WAIT/SCROLL taken in between) means Enter would
      // submit whatever the page happens to have focus on, not the field
      // Jev meant. Refused without ever calling the bridge — recorded as a
      // failed (not stale-target) step so Jev sees why and picks something
      // else next cycle.
      if (operation === "PRESS_ENTER" && lastLandedOperation !== "TYPE_TEXT") {
        const stalled = note({
          operation,
          label: "Enter is only pressed right after typing into a field",
          ok: false,
          index: decision.index,
        });
        if (stalled) return stalled;
        continue;
      }

      const actArgs: Record<string, unknown> =
        operation === "HOVER"
          ? { action: "hover", index: decision.index, snapshotId: snapshot.snapshotId }
          : { action: "press", key: operation === "PRESS_ENTER" ? "Enter" : "Escape" };
      const actLabel =
        operation === "HOVER"
          ? label
          : operation === "PRESS_ENTER"
            ? via === "rule"
              ? "press Enter (avoided retyping into the same field)"
              : "press Enter"
            : "press Escape";

      if (signal?.aborted) return cancelledResult();
      try {
        const acted = await browser.act(actArgs);
        // Same PR #40 contract as `perform`: the bridge resolves `{ error }`
        // rather than rejecting.
        const rejected = resultError(acted);
        // Finding: a `changed: false` result (see the desktop bridge's
        // `{ changed, changes }` diff) landed with no error but altered
        // nothing — e.g. Escape with nothing open to close, or hovering an
        // element that has no hover-revealed state. That is exactly the
        // "no progress" case the consecutive-unproductive-steps counter
        // exists to catch, so it must count the same way a rejected act
        // does, not as a landed action.
        const noEffectRaw = !rejected && isNoEffectResult(acted);
        const pageUpdate = noEffectRaw ? describePageUpdate(acted) : null;
        const noEffect = noEffectRaw && !pageUpdate;
        const stalled = note(
          rejected
            ? { operation, label: rejected, ok: false, index: decision.index }
            : {
                operation,
                label: `${actLabel}${describeSideEffects(acted)}${pageUpdate ? ` ${pageUpdate}` : ""}`,
                ok: !noEffect,
                index: decision.index,
                ...(via ? { via } : {}),
              }
        );
        if (stalled) return stalled;
      } catch (err) {
        const stalled = note({
          operation,
          label: err instanceof Error ? err.message : "act failed",
          ok: false,
          index: decision.index,
        });
        if (stalled) return stalled;
      }
      continue;
    }

    const performArgs: {
      snapshotId: string;
      index?: number;
      operation: PerformOperation;
      text?: string;
    } = {
      snapshotId: snapshot.snapshotId,
      operation,
      text: decision.text,
    };
    // Only forward `index` when it is genuinely present — never
    // `index: undefined` for a scroll, per addendum A.
    if (decision.index != null) {
      performArgs.index = decision.index;
    }

    if (signal?.aborted) return cancelledResult();
    try {
      const performed = await browser.perform(performArgs);
      // PR #40: `perform` resolves with `{ error }` rather than rejecting
      // (see resultError) — a stale snapshotId, a target that is gone or
      // occluded. Recording that as a landed action is what let a
      // persistently stale target loop forever while the transcript
      // claimed success on every cycle.
      const rejected = resultError(performed);
      // browse-speed-contract.md, "Frontend" item 4: a CLICK/TYPE_TEXT/
      // SELECT that resolved with no error but `changed: false` still
      // landed nothing — same "no progress" case the act path already
      // counts via isNoEffectResult (see that function's comment), now
      // applied to perform too.
      const noEffectRaw = !rejected && isNoEffectResult(performed);
      // browse-speed-contract.md, "Frontend" item 2: `changed: false` +
      // `pageChanged: true` (see describePageUpdate's doc comment) is not
      // the "no progress" case — something the user would see did happen,
      // just not on the acted-on element itself.
      const pageUpdate = noEffectRaw ? describePageUpdate(performed) : null;
      const noEffect = noEffectRaw && !pageUpdate;
      // Requirement 2 (typed-state awareness): a plain element label
      // ("Search") tells the NEXT decision nothing about what was already
      // typed there — the history sent back to /api/browse/step must say
      // what was typed where, or Jev has no signal that the field is
      // already filled with its own prior guess.
      // Same for SELECT: "Country" alone never said WHICH option was chosen,
      // and a desktop build that doesn't report a <select>'s value left the
      // history as the only record of it — Jev re-selected Country until
      // the loop stalled. The backend reads the choice back out of this
      // exact `SELECT "<option>" in "<label>"` shape (browseStepUltrafast.ts).
      const displayLabel =
        operation === "TYPE_TEXT" && decision.text
          ? `TYPE_TEXT "${truncateToChars(decision.text, 60)}" into "${label}"`
          : operation === "SELECT" && decision.text
            ? `SELECT "${truncateToChars(decision.text, 60)}" in "${label}"`
            : label;
      const stalled = note(
        rejected
          ? { operation, label: rejected, ok: false, index: decision.index }
          : {
              operation,
              label: noEffect
                ? `${displayLabel}${describeSideEffects(performed)} (no effect)`
                : `${displayLabel}${describeSideEffects(performed)}${pageUpdate ? ` ${pageUpdate}` : ""}`,
              ok: !noEffect,
              index: decision.index,
              ...(via ? { via } : {}),
            }
      );
      if (stalled) return stalled;
      if (!rejected && !noEffect && lastRecorded) {
        markPageState((lastRecorded as { step: TranscriptStep }).step, operation, snapshot, decision.index, lastUrl);
        lastLandedChoiceClick = operation === "CLICK" && isChoiceElement(snapshot, decision.index);
      }
      // A landed CLICK: the next snapshot tells what it did (effect note).
      if (operation === "CLICK" && !rejected && !noEffect && (lastRecorded as { step: TranscriptStep; hist: StepHistoryEntry } | null)) {
        const rec = lastRecorded as unknown as { step: TranscriptStep; hist: StepHistoryEntry };
        pendingEffect = {
          prev: snapshot,
          acted: actedElementOf(snapshot, decision.index),
          result: performed,
          step: rec.step,
          hist: rec.hist,
        };
      }
      // Track the just-landed TYPE_TEXT for the next iteration's dedup
      // rule above — only on a genuinely landed (not rejected, not
      // no-effect) TYPE_TEXT.
      if (operation === "TYPE_TEXT" && !rejected && !noEffect && decision.index != null) {
        lastTypeText = { index: decision.index, text: decision.text ?? "" };
      }
      // Action cache write: a step Jev/cascade/rule (never the cache itself
      // — `via` is only ever "cascade"/"rule" here) just decided LANDED
      // productively. Store it under the key computed at the top of this
      // iteration so a future identical run can skip straight to replaying
      // it. maybeWriteStepCache owns every "must not cache this" rule
      // (WAIT — moot here, WAIT never reaches `perform` — password fields,
      // card-number/password-shaped text).
      if (!rejected && !noEffect) {
        maybeWriteStepCache(storage, stepCacheKey, operation, decision.index, decision.text, goal, snapshot.elements);
      }
    } catch (err) {
      // A failing step (design doc §3/§4: "a failing step is recorded and
      // does not abort the whole task") is recorded in the transcript and
      // the loop continues — only a done/blocked outcome, the no-progress
      // check, maxSteps or the deadline end the task.
      const stalled = note({
        operation,
        label: err instanceof Error ? err.message : "perform failed",
        ok: false,
        index: decision.index,
      });
      if (stalled) return stalled;
    }
  }

  return { status: "budget", steps, url: lastUrl, title: lastTitle, reason: "maxSteps reached", cacheHits };
}

/** Overall wall-clock bound for a multi-sub-goal browse_task call. Each
 * sub-goal still gets browseTaskDeadlineMs(); this caps the sum. The chat-side
 * tool-call timeout (useDesignChat.ts) is derived from these two. */
export const MULTI_SUBGOAL_DEADLINE_MS = 12 * 60_000;
export const CLOUD_MULTI_SUBGOAL_DEADLINE_MS = 15 * 60_000;
/** Overall cap on loop iterations across all sub-goals of one call. */
export const MULTI_SUBGOAL_MAX_STEPS = 150;

export function browseTaskOverallDeadlineMs(cloud: boolean): number {
  return cloud ? CLOUD_MULTI_SUBGOAL_DEADLINE_MS : MULTI_SUBGOAL_DEADLINE_MS;
}

/** Hard bound on one browse_task call, enforced inside the handler: the
 * longer of the overall deadline (`overallDeadlineMs`, else the browser's default;
 * the multi-sub-goal budget) and the per-sub-goal deadline (`deadlineMs`; the
 * single-sub-goal flow runs to it) + one step-start reserve + settleEmptySnapshot's worst case. The
 * chat-side timeout is a margin above this. The end-of-loop observation reads
 * (<= OBSERVATIONS_KEPT x OBSERVATION_READ_TIMEOUT_MS) add nothing: each one
 * starts only with OBSERVATION_READ_TIMEOUT_MS left of the overall deadline,
 * so it ends inside it. */
export function browseTaskInnerBoundMs(
  cloud: boolean,
  overallDeadlineMs: number = browseTaskOverallDeadlineMs(cloud),
): number {
  return overallDeadlineMs + STEP_DEADLINE_RESERVE_MS + BROWSE_SETTLE_WORST_CASE_MS;
}

// Above the backend model budget (BROWSE_PLAN_TIMEOUT_MS = 20 s): the plan runs
// in parallel with the preamble, so headroom costs nothing on a fast answer.
const PLAN_REQUEST_TIMEOUT_MS = 25_000;
// Mirror pen-editor-backend src/ai/browsePlan.ts (MAX_SUBGOALS / MAX_SUBGOAL_CHARS = 12 / 1000).
const PLAN_MAX_SUBGOALS = 12;
const PLAN_SUBGOAL_MAX_CHARS = 1_000;
/** Steps kept per sub-goal in a multi-sub-goal transcript (see stepsTotal). */
const MULTI_SUBGOAL_STEPS_KEPT = 5;
/** settleEmptySnapshot's worst case: EMPTY_SNAPSHOT_MAX_POLLS x (poll sleep +
 * a 20s desktop snapshot command). Only hit on a page that stays blank; the
 * chat-side browse_task timeout (useDesignChat.ts) includes it. */
export const BROWSE_SETTLE_WORST_CASE_MS = EMPTY_SNAPSHOT_MAX_POLLS * (EMPTY_SNAPSHOT_POLL_MS + 20_000);
/** Hard cap on the goal string sent to /api/browse/step for a sub-goal. */
const SUBGOAL_GOAL_MAX_CHARS = 2_000;
const DONE_LIST_MAX_CHARS = 400;
const DONE_ITEM_MAX_CHARS = 80;

/**
 * Asks the backend to split `goal` into ordered sub-goals. ANY failure
 * (network, non-200, 503, malformed body) yields `[goal]`, as does a plan of
 * one entry — the caller then runs today's single loop unchanged.
 */
async function planSubgoals(
  backend: BrowseBackend,
  goal: string,
  url: string | undefined,
  signal: AbortSignal | undefined
): Promise<string[]> {
  if (!goal) return [goal];
  try {
    const res = await fetchBrowseBackend(
      backend,
      "/api/browse/plan",
      { goal, ...(url ? { url } : {}) },
      PLAN_REQUEST_TIMEOUT_MS,
      signal
    );
    const list = res.ok && res.body && typeof res.body === "object" ? (res.body as { subgoals?: unknown }).subgoals : undefined;
    if (!Array.isArray(list)) return [goal];
    const subgoals = list
      .filter((g): g is string => typeof g === "string")
      .map((g) => g.trim().slice(0, PLAN_SUBGOAL_MAX_CHARS))
      .filter((g) => g.length > 0)
      .slice(0, PLAN_MAX_SUBGOALS);
    return subgoals.length > 1 ? subgoals : [goal];
  } catch {
    return [goal];
  }
}

/**
 * The goal string for a sub-goal: the sub-goal text ONLY, then (if any) what
 * is already done. The overall task and the step position are deliberately
 * NOT included — they made the step model wander into later sub-goals and
 * never answer DONE. Capped at SUBGOAL_GOAL_MAX_CHARS; the done list is
 * truncated first and the sub-goal is never cut (unless it alone exceeds the cap).
 */
export function buildSubgoalGoal(subgoal: string, doneGoals: string[]): string {
  let doneStr = "";
  if (doneGoals.length > 0) {
    const list = truncateToChars(
      doneGoals.map((g) => truncateToChars(g, DONE_ITEM_MAX_CHARS)).join("; "),
      DONE_LIST_MAX_CHARS
    );
    doneStr = `\n\nAlready done earlier (do not redo): ${list}.`;
  }
  return `${subgoal}${doneStr}`.slice(0, SUBGOAL_GOAL_MAX_CHARS);
}

const SCROLL_TO_TOP_TIMEOUT_MS = 8_000;

/**
 * Brings the page to the top before a later sub-goal starts, so the site
 * header (search box) is inside the snapshot again. Not a step: no history
 * entry, no Jev call. One snapshot to read the scroll position, then one
 * `act` scroll of a huge negative amount (viewport heights) unless already
 * at top. "Top" = window y 0 AND no auto-picked scroll container, or that
 * container at y 0 (app-shell pages scroll an inner container; `act` scroll
 * targets it when the window cannot scroll). Best effort: bounded by
 * SCROLL_TO_TOP_TIMEOUT_MS in total, every failure swallowed.
 */
async function scrollToTop(
  browser: BrowserBridge
): Promise<void> {
  const work = (async () => {
    const snap = (await browser.snapshot()) as SnapshotResult | undefined;
    const scroll = snap?.scroll as { y?: unknown; container?: { y?: unknown } | null } | undefined;
    const containerY = scroll?.container?.y;
    if (scroll?.y === 0 && (containerY === undefined || containerY === 0)) return;
    await browser.act({ action: "scroll", amount: -1000 });
  })().catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, SCROLL_TO_TOP_TIMEOUT_MS);
  });
  try {
    await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** True when the snapshot offers a text-entry element (any op list with TYPE_TEXT). */
function hasTextEntry(snapshot: SnapshotResult): boolean {
  return snapshot.elements.some((el) => {
    const ops = (el as { ops?: unknown } | undefined)?.ops;
    return Array.isArray(ops) && ops.includes("TYPE_TEXT");
  });
}

/**
 * Sub-goal start recovery (k>1, same site). Finding: an unclosed overlay can
 * hide the site's only text field, and the sub-goal then stalls scrolling or
 * clicking nothing. If the snapshot has no text-entry element: close an open
 * dialog with Escape; if there is still none, reopen the start URL. At most
 * once per sub-goal; every action lands in `records` (transcript, not history).
 * Returns the last snapshot when nothing acted after it (the loop reuses it).
 */
async function recoverTextEntry(
  browser: BrowserBridge,
  siteUrl: string | undefined,
  k: number,
  records: TranscriptStep[],
  canContinue: () => boolean
): Promise<SnapshotResult | undefined> {
  try {
    if (!canContinue()) return undefined;
    const snap = await takeSnapshot(browser);
    if ("error" in snap) return undefined;
    if (hasTextEntry(snap)) return snap;
    // Only a snapshot that reports an open dialog is treated as "text field
    // hidden behind an overlay"; a page that simply has no text field is left be.
    if (modalFor(snap) === undefined) return snap;
    if (canContinue()) {
      const acted = await browser.act({ action: "press", key: "Escape" });
      records.push({
        operation: "PRESS_ESCAPE",
        label: "press Escape (sub-goal start: no text field, dialog open)",
        ok: !resultError(acted),
        subgoal: k,
      });
      if (!canContinue()) return undefined;
      const after = await takeSnapshot(browser);
      if (!("error" in after) && hasTextEntry(after)) return after;
    }
    if (!siteUrl || !canContinue()) return undefined;
    const failure = await openBeforeLoop(browser, siteUrl);
    records.push({
      operation: "OPEN",
      label: `reopened ${truncateToChars(siteUrl, 100)} (sub-goal start: no text field)`,
      ok: !failure,
      subgoal: k,
    });
  } catch {
    // best effort: the sub-goal runs on whatever page there is
  }
  return undefined;
}

/** The action part of a sub-goal: the text before the first "Done when:" /
 * "Does not count:" marker (the whole string without one). The planner writes
 * "<action>. Done when: <visible condition>", and the condition describes the
 * results page, so its nouns ("the search results are filtered by ...") must
 * not read as an action. */
const SUBGOAL_CONDITION_MARKER = /\b(?:done\s+when|does\s+not\s+count)\s*:/i;
function subGoalAction(subGoal: string): string {
  const m = SUBGOAL_CONDITION_MARKER.exec(subGoal);
  const action = m ? subGoal.slice(0, m.index) : subGoal;
  // A sub-goal that starts with the marker has no action part to read.
  return action.trim() === "" ? subGoal : action;
}

/** "search" as a noun is not a verb: a noun head before it ("the search",
 * "a new search") or a noun tail after it ("search results", "search filter"). */
const SEARCH_NOUN_HEAD = String.raw`(?<!(?<!\p{L})(?:the|a|an|your|my|this|that|new)\s+)`;
const SEARCH_NOUN_TAIL = String.raw`(?![\s-]+(?:results?|filters?|page|criteria|settings|options|history|suggestions?|hits?|listings?|list)(?!\p{L}))`;

/** "search" as a verb: "search for X" / "search 'X'" always counts ("do a
 * search for X" included); otherwise a noun head or tail rules it out. */
const SEARCH_WORD = String.raw`search(?=\s+(?:for(?!\p{L})|["“«']))|${SEARCH_NOUN_HEAD}search${SEARCH_NOUN_TAIL}`;

/** Sub-goal text that asks to search / find / type into a field. Verbs only.
 * Reads only the action part: the "Done when" clause describes the results
 * page, and a reset triggered by its nouns would throw the page state away. */
const SEARCH_INTENT = new RegExp(String.raw`(?<!\p{L})(?:${SEARCH_WORD}|find|look\s+(?:for|up)|type\b[^.]{0,60}?\binto|найди|найти|поиск(?!\p{L})|ищи)`, "iu");
function actionWantsTextEntry(action: string): boolean {
  return SEARCH_INTENT.test(action);
}
export function wantsTextEntry(subGoal: string): boolean {
  return actionWantsTextEntry(subGoalAction(subGoal));
}

/** Narrow check for the sub-goal start reset: a quoted phrase after an
 * explicit search / find verb (never "type ... into": a multi-page form step
 * must not reset). The planner puts the text to type in double quotes and
 * control labels in single ones ("Find the 'Checkout' button" must not leave
 * the cart), so a single-quoted phrase counts only with a search verb, and
 * only at word edges (an apostrophe, as in don't, opens none). Only the action
 * part is read (see subGoalAction): the "Done when" clause describes the
 * results page, so its nouns must not trigger a reset that throws the page
 * state (filters, sort) away. */
const SEARCH_VERB = new RegExp(String.raw`(?<!\p{L})(?:${SEARCH_WORD}|look\s+up|поиск(?!\p{L})|ищи|искать)`, "iu");
const FIND_VERB = /(?<!\p{L})(?:find|найди|найти)/iu;
const DOUBLE_QUOTED = /"[^"]+"|“[^”]+”|«[^»]+»/u;
const SINGLE_QUOTED = /(?<![\p{L}\p{N}])'[^']+'(?![\p{L}\p{N}])/u;
function isQuotedSearch(action: string, subGoal: string): boolean {
  // The verb must be in the action; the quoted phrase may sit anywhere in the sub-goal.
  if (SEARCH_VERB.test(action)) return DOUBLE_QUOTED.test(subGoal) || SINGLE_QUOTED.test(subGoal);
  return FIND_VERB.test(action) && DOUBLE_QUOTED.test(subGoal);
}

/** The tail of a stalled run shows a page the sub-goal cannot work on: only
 * no-effect scrolls and "no candidate fits" refusals. */
function isRecoverableStall(steps: TranscriptStep[]): boolean {
  const tail = steps.slice(-MAX_CONSECUTIVE_UNPRODUCTIVE_STEPS);
  if (tail.length < MAX_CONSECUTIVE_UNPRODUCTIVE_STEPS) return false;
  return tail.every(
    (st) =>
      /no candidate fits/i.test(st.label) ||
      (st.operation.startsWith("SCROLL_") && /\(no effect\)/.test(st.label))
  );
}

/** Landed steps that left state on their page (typed text, a picked
 * option, a ticked box), with the url they ran on. A side table, not a
 * TranscriptStep field: the transcript is serialized to the model and the
 * bench, and this is internal bookkeeping. */
const pageStateSteps = new WeakMap<TranscriptStep, string>();
const CHOICE_ROLES = new Set([
  "option", "menuitemradio", "menuitemcheckbox", "checkbox", "radio", "switch", "treeitem", "gridcell",
]);

function elementRole(el: { role?: unknown } | undefined): string {
  return typeof el?.role === "string" ? el.role.toLowerCase() : "";
}

/** The element at `index` is a choice control (see CHOICE_ROLES). */
function isChoiceElement(snapshot: SnapshotResult, index: number | undefined): boolean {
  if (index == null) return false;
  return CHOICE_ROLES.has(elementRole(findElementByIndex(snapshot.elements, index) as { role?: unknown } | undefined));
}

/** The snapshot shows an open popup: an element reporting `expanded: true`,
 * or a listed option / menu item. */
function hasOpenPopup(snapshot: SnapshotResult): boolean {
  return snapshot.elements.some((raw) => {
    const el = raw as { role?: unknown; expanded?: unknown } | null;
    if (!el || typeof el !== "object") return false;
    if (el.expanded === true) return true;
    const role = elementRole(el);
    return role === "option" || role.startsWith("menuitem");
  });
}

/** Record `step` in pageStateSteps when it set a value or a choice: TYPE_TEXT,
 * SELECT, or a CLICK on a choice control — a choice role, or a role-less
 * element the snapshot reports an on/off `checked` for (a native
 * checkbox/radio; a role=tab also reports `checked` but is navigation). */
function markPageState(
  step: TranscriptStep,
  operation: string,
  snapshot: SnapshotResult,
  index: number | undefined,
  url: string
): void {
  let sets = operation === "TYPE_TEXT" || operation === "SELECT";
  if (operation === "CLICK" && index != null) {
    const el = findElementByIndex(snapshot.elements, index) as { role?: unknown; checked?: unknown } | undefined;
    const role = typeof el?.role === "string" ? el.role.toLowerCase() : "";
    sets = CHOICE_ROLES.has(role) || (!role && typeof el?.checked === "boolean");
  }
  if (sets) pageStateSteps.set(step, url);
}

/** The stalled attempt left state on the page it is still on (a landed
 * TYPE_TEXT / SELECT / choice CLICK that ran on `currentUrl`). A reload would
 * wipe it: open modal forms and filled fields do not survive, and the retry
 * would start on an empty form. State entered on a page the attempt has since
 * left (a search typed, then submitted) is already gone, so it does not count. */
function hasPageStateToLose(steps: TranscriptStep[], currentUrl: string | undefined): boolean {
  if (!currentUrl) return false;
  const here = comparableUrl(currentUrl);
  return steps.some((st) => {
    const at = st.ok ? pageStateSteps.get(st) : undefined;
    return at !== undefined && comparableUrl(at) === here;
  });
}

/** A `blocked` the remaining sub-goals cannot get past either. ONLY the
 * loop's / backend's own structured wall signals count — never free-form
 * wording in a model's reason (a "Sign in link in the header" is not a wall):
 *  - `botCheck: true` (the client open path),
 *  - browseCaptcha.ts botWallResult: "the page is a CAPTCHA / bot check (...)
 *    — the user must solve it themselves; ...",
 *  - browseStepUltrafast.ts password refusals: "... the user must log in
 *    themselves". */
const AUTH_WALL_PATTERN = /the page is a CAPTCHA \/ bot check|the user must (?:solve it|log in) themselves/;

function isAuthWall(t: Transcript): boolean {
  return t.botCheck === true || (typeof t.reason === "string" && AUTH_WALL_PATTERN.test(t.reason));
}

/** origin + pathname + search: a url compared without its hash. Unparseable
 * input is returned as is. */
function comparableUrl(u: string): string {
  try {
    const p = new URL(u);
    return p.origin + p.pathname + p.search;
  } catch {
    return u;
  }
}

function hostOf(u: string | undefined): string | undefined {
  try {
    return u ? new URL(u).host : undefined;
  } catch {
    return undefined;
  }
}

/** Top-level status of a multi-sub-goal call when not every sub-goal is
 * done: the first present of blocked > stalled > budget. */
const STATUS_PRIORITY: Transcript["status"][] = ["blocked", "stalled", "budget"];

/**
 * The positional core of `runBrowseTask`: opens/probes the tab (cheap, before
 * any paid call), plans, then runs runBrowseTaskLoop once (single flow,
 * byte-for-byte as before) or once per sub-goal on the same tab. Exported for
 * tests that need its positional clock/deadline seams; hosts call
 * `runBrowseTask`.
 *
 * `maxSteps` is PER SUB-GOAL (capped at 25); a multi-sub-goal call is further
 * bounded by MULTI_SUBGOAL_MAX_STEPS (150) loop iterations in total and by
 * `overallDeadlineMs`. `signal` aborts the whole call ("cancelled").
 */
export async function runBrowseTaskCore(
  goal: string,
  maxSteps: number,
  env: LoopEnv,
  now: () => number = () => Date.now(),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  url?: string,
  deadlineMs: number = BROWSE_TASK_DEADLINE_MS,
  overallDeadlineMs: number = MULTI_SUBGOAL_DEADLINE_MS,
  signal?: AbortSignal
): Promise<Transcript> {
  const { browser } = env;
  const overallEnd = now() + overallDeadlineMs;
  // The preamble uses the ORIGINAL goal (its URL), never a composed sub-goal
  // string. A failure ends the whole task before any paid plan call.
  // The plan call runs IN PARALLEL with it; if the preamble fails the plan is
  // discarded and its request aborted.
  const planAbort = new AbortController();
  const unlink = () => planAbort.abort();
  if (signal?.aborted) planAbort.abort();
  else signal?.addEventListener("abort", unlink, { once: true });
  let seq = 0;
  let probeSeq = 0;
  let planSeq = 0;
  const planPromise = planSubgoals(env.backend, goal, url, planAbort.signal).then((r) => {
    planSeq = ++seq;
    return r;
  });
  let preamble: Preamble;
  let plan: string[];
  try {
    preamble = await runPreamble(goal, browser, url);
    probeSeq = ++seq;
    if (preamble.failure) {
      planAbort.abort();
      return preamble.failure;
    }
    plan = await planPromise;
  } finally {
    signal?.removeEventListener("abort", unlink);
  }
  if (signal?.aborted) {
    return { status: "blocked", steps: [], url: "", title: "", reason: CANCELLED_REASON };
  }
  // A plan that finished after the probe snapshot was taken (the page may
  // have moved since): do not reuse that snapshot — the loop takes a fresh one.
  const freshPreamble: Preamble = planSeq > probeSeq ? {} : preamble;
  if (plan.length <= 1) {
    const single = await runBrowseTaskLoop(goal, maxSteps, env, now, sleep, url, deadlineMs, freshPreamble, signal);
    if (single.reason === CANCELLED_REASON || signal?.aborted || overallEnd - now() < OBSERVATION_READ_TIMEOUT_MS) return single;
    const observation = await readObservation(browser, single.url, undefined, signal, OBSERVATION_LAST_MAX_CHARS);
    const observations = observation ? capObservations([observation]) : undefined;
    return observations ? { ...single, observations } : single;
  }

  const n = plan.length;
  const results: SubgoalResult[] = [];
  const steps: TranscriptStep[] = [];
  let stepsTotal = 0;
  const doneGoals: string[] = [];
  let lastUrl = "";
  let lastTitle = "";
  let cacheHits = 0;
  const observed: RawObservation[] = [];
  let abortedBy: string | undefined;
  let cancelled = false;
  // The URL most recently opened for the CURRENT site: the start URL until a
  // sub-goal opens another domain.
  let siteUrl: string | undefined = url ?? extractUrlFromGoal(goal) ?? freshPreamble.initialSnapshot?.url ?? preamble.initialSnapshot?.url;
  let previousHistory: StepHistoryEntry[] = [];

  for (let i = 0; i < n; i++) {
    const k = i + 1;
    if (signal?.aborted) {
      cancelled = true;
      abortedBy = CANCELLED_REASON;
    }
    const remainingMs = overallEnd - now();
    const remainingSteps = MULTI_SUBGOAL_MAX_STEPS - stepsTotal;
    if (abortedBy || remainingMs < STEP_DEADLINE_RESERVE_MS || remainingSteps <= 0) {
      results.push({
        goal: plan[i],
        status: abortedBy ? "blocked" : "budget",
        reason: abortedBy ? `not attempted — ${abortedBy}` : remainingSteps <= 0 ? "overall step cap reached" : "overall deadline reached",
      });
      continue;
    }
    // A sub-goal that names a different site: open it first (same open path
    // as the preamble) so the loop does not start on the wrong page.
    let recoveredSnapshot: SnapshotResult | undefined;
    const action = subGoalAction(plan[i]);
    const subUrl = i > 0 ? extractUrlFromGoal(action) : undefined;
    if (subUrl && hostOf(subUrl) !== undefined && hostOf(subUrl) !== hostOf(lastUrl)) {
      const openFailure = await openBeforeLoop(browser, subUrl);
      if (openFailure) {
        results.push({ goal: plan[i], status: "blocked", ...(openFailure.reason ? { reason: openFailure.reason } : {}) });
        if (isAuthWall(openFailure)) abortedBy = `sub-goal ${k} hit a login/CAPTCHA wall`;
        continue;
      }
      lastUrl = subUrl;
      siteUrl = subUrl;
    } else if (i > 0 && !signal?.aborted) {
      // A quoted search sub-goal: an earlier sub-goal may have left the page
      // inside a site section or a non-root page, where the search box
      // searches only within it or the type loop stalls. Start from the site
      // URL instead (a fresh page needs no scroll-to-top / text-entry
      // recovery). A failed open falls through.
      let reset = false;
      if (
        siteUrl &&
        isQuotedSearch(action, plan[i]) &&
        comparableUrl(lastUrl) !== comparableUrl(siteUrl)
      ) {
        const failure = await openBeforeLoop(browser, siteUrl);
        steps.push({
          operation: "OPEN",
          label: `reopened ${truncateToChars(siteUrl, 100)} (sub-goal start: new search)`,
          ok: !failure,
          subgoal: k,
        });
        stepsTotal += 1;
        if (!failure) {
          lastUrl = siteUrl;
          reset = true;
        }
      }
      // Same site: the previous sub-goal may have left the page scrolled far down.
      if (!reset) await scrollToTop(browser);
      if (!reset && actionWantsTextEntry(action)) {
        const records: TranscriptStep[] = [];
        recoveredSnapshot = await recoverTextEntry(
          browser,
          siteUrl,
          k,
          records,
          () => !signal?.aborted && overallEnd - now() >= STEP_DEADLINE_RESERVE_MS
        );
        steps.push(...records);
        stepsTotal += records.length;
      }
    }
    const subGoalText = buildSubgoalGoal(plan[i], doneGoals);
    const subMaxSteps = Math.min(maxSteps, Math.max(1, MULTI_SUBGOAL_MAX_STEPS - stepsTotal));
    const subStart = now();
    const share: HistoryShare = { seed: i > 0 ? carryOverHistory(previousHistory) : undefined, autoConfirmCommit: true };
    let t = await runBrowseTaskLoop(
      subGoalText,
      subMaxSteps,
      env,
      now,
      sleep,
      undefined,
      // Recomputed: the open / scroll-to-top above may have used time.
      Math.min(deadlineMs, overallEnd - now()),
      // Sub-goal 1 reuses the probe snapshot; later ones take their own.
      i === 0 ? freshPreamble : recoveredSnapshot ? { initialSnapshot: recoveredSnapshot } : {},
      signal,
      share
    );
    // Stall safety net: ONE reopen of the current site's URL and a retry on
    // the remaining budget (no fresh step allowance) before reporting stalled.
    const attempts: Array<{ steps: TranscriptStep[]; record?: TranscriptStep }> = [{ steps: t.steps }];
    if (t.status === "stalled" && siteUrl && !signal?.aborted && isRecoverableStall(t.steps) && !hasPageStateToLose(t.steps, t.url)) {
      const capLeft = MULTI_SUBGOAL_MAX_STEPS - stepsTotal - t.steps.length - 1;
      const leftSteps = Math.min(Math.min(subMaxSteps, HARD_MAX_STEPS) - t.steps.length, capLeft);
      const leftMs = Math.min(deadlineMs - (now() - subStart), overallEnd - now());
      if (leftSteps > 0 && leftMs >= STEP_DEADLINE_RESERVE_MS) {
        const failure = await openBeforeLoop(browser, siteUrl);
        const record: TranscriptStep = {
          operation: "OPEN",
          label: `reopened ${truncateToChars(siteUrl, 100)} (stall recovery)`,
          ok: !failure,
          subgoal: k,
        };
        if (!failure) {
          const retryShare: HistoryShare = { seed: sameGoalSeed(share.final ?? []), autoConfirmCommit: true };
          const t2 = await runBrowseTaskLoop(
            subGoalText,
            leftSteps,
            env,
            now,
            sleep,
            undefined,
            Math.min(leftMs, overallEnd - now()),
            {},
            signal,
            retryShare
          );
          share.final = retryShare.final;
          attempts.push({ steps: t2.steps, record });
          t = { ...t2, steps: [...t.steps, ...t2.steps], cacheHits: (t.cacheHits ?? 0) + (t2.cacheHits ?? 0) };
        } else {
          attempts.push({ steps: [], record });
        }
      }
    }
    previousHistory = share.final ?? [];
    // Chronological: stalled attempt, recovery OPEN, retry. The OPEN counts as a step.
    stepsTotal += actionSteps(t.steps);
    for (const att of attempts) {
      if (att.record) {
        steps.push(att.record);
        stepsTotal += 1;
      }
      for (const s of att.steps.slice(-MULTI_SUBGOAL_STEPS_KEPT)) steps.push({ ...s, subgoal: k });
    }
    if (t.url) lastUrl = t.url;
    if (t.title) lastTitle = t.title;
    if (
      i >= n - OBSERVATIONS_KEPT &&
      !(t.status === "blocked" && t.reason === CANCELLED_REASON) &&
      !signal?.aborted &&
      overallEnd - now() >= OBSERVATION_READ_TIMEOUT_MS
    ) {
      const observation = await readObservation(
        browser,
        lastUrl,
        k,
        signal,
        i === n - 1 ? OBSERVATION_LAST_MAX_CHARS : OBSERVATION_EARLIER_MAX_CHARS
      );
      if (observation) {
        // Same page only when the whole text matched: two cut texts share a
        // prefix (site header, filters) even on different pages.
        const same = lastReal(observed);
        const isSame = same && same.url === observation.url && !same.cut && !observation.cut && same.text === observation.text;
        observed.push(isSame ? { ...observation, text: "", sameAs: same.subgoal } : observation);
      }
    }
    cacheHits += t.cacheHits ?? 0;
    results.push({ goal: plan[i], status: t.status, ...(t.reason ? { reason: t.reason } : {}) });
    if (t.status === "done") doneGoals.push(plan[i]);
    else if (t.status === "blocked" && t.reason === CANCELLED_REASON) {
      cancelled = true;
      abortedBy = CANCELLED_REASON;
    } else if (t.status === "blocked" && isAuthWall(t)) abortedBy = `sub-goal ${k} hit a login/CAPTCHA wall`;
  }

  const doneCount = results.filter((r) => r.status === "done").length;
  const status = cancelled
    ? "blocked"
    : doneCount === n
      ? "done"
      : (STATUS_PRIORITY.find((s) => results.some((r) => r.status === s)) ?? "budget");
  const problems = results
    .map((r, i) => (r.status === "done" ? null : `#${i + 1} ${r.status}${r.reason ? `: ${truncateToChars(r.reason, 120)}` : ""}`))
    .filter((x): x is string => x !== null);
  const summary = `${doneCount}/${n} sub-goals done${problems.length ? `; ${problems.join("; ")}` : ""}`;
  const observations = capObservations(observed);
  return {
    status,
    steps,
    stepsTotal,
    url: lastUrl,
    title: lastTitle,
    reason: cancelled ? CANCELLED_REASON : truncateToChars(summary, 1_000),
    cacheHits,
    subgoals: results,
    ...(observations ? { observations } : {}),
  };
}

/** Options of `runBrowseTask` (docs/design.md, "Loop entry point"). */
export interface RunBrowseTaskOptions {
  /** The browser to drive. */
  browser: BrowserBridge;
  /** Where the step / plan requests go (`createHttpBackend` / `createLocalBackend`). */
  backend: BrowseBackend;
  /** Steps PER SUB-GOAL, capped at 25 (default 25). */
  maxSteps?: number;
  /** Open this URL before the loop starts. */
  url?: string;
  /** Aborts the whole call ("cancelled"). */
  signal?: AbortSignal;
  /** User switches sent with every step (was the Zustand settings store).
   * Pass a getter to read them before each step, as pen-editor did ("read
   * now rather than cached"): a switch flipped mid-run then applies from the
   * next step. A plain object is fixed for the whole call. */
  permissions?: BrowsePermissions | (() => BrowsePermissions);
  /** Action cache storage (pen-editor passes `localStorage`); omitted = cache off. */
  storage?: KeyValueStorage;
  /** The browser is remote (was `isDesktopBrowserAvailable() === false`):
   * cloud deadlines. Default false. */
  cloud?: boolean;
  /** Send a marked screenshot of each step's snapshot to the backend (was a
   * Vite env flag). Default false. */
  stepScreenshots?: boolean;
  /** Clock (default `Date.now`). */
  now?: () => number;
  /** Sleep (default `setTimeout`). */
  sleep?: (ms: number) => Promise<void>;
  /** Per-sub-goal loop budget (default by `cloud`). */
  deadlineMs?: number;
  /** Overall budget of a multi-sub-goal call (default by `cloud`). */
  overallDeadlineMs?: number;
}

/**
 * browse_task entry point: drives `opts.browser` towards `goal` and resolves
 * with a `Transcript`. The call is bounded by `browseTaskInnerBoundMs(cloud)`
 * — the REAL bound on it; a host's own tool-call timeout is only a margin
 * above it. Exceeding it aborts the loop and resolves a `budget` transcript
 * ("deadline exceeded"). Never throws for a browser or backend failure (the
 * loop turns them into a `Transcript`); a host wrapper that wants pen-editor's
 * `{"error": ...}` JSON contract can catch what remains.
 */
/** setTimeout fires at ~1 ms for a delay above this (a 32-bit signed int). */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** A finite number above zero, else undefined (so the default applies). */
function positiveFinite(v: number | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

export async function runBrowseTask(goal: string, opts: RunBrowseTaskOptions): Promise<Transcript> {
  const cloud = opts.cloud === true;
  const env: LoopEnv = {
    browser: opts.browser,
    backend: opts.backend,
    ...(opts.permissions !== undefined ? { permissions: opts.permissions } : {}),
    ...(opts.storage !== undefined ? { storage: opts.storage } : {}),
    cloud,
    stepScreenshots: opts.stepScreenshots === true,
  };
  const maxSteps =
    typeof opts.maxSteps === "number" && Number.isFinite(opts.maxSteps) ? opts.maxSteps : DEFAULT_MAX_STEPS;
  const url = typeof opts.url === "string" && opts.url.length > 0 ? opts.url : undefined;

  const overallDeadlineMs = positiveFinite(opts.overallDeadlineMs) ?? browseTaskOverallDeadlineMs(cloud);
  const deadlineMs = positiveFinite(opts.deadlineMs) ?? browseTaskDeadlineMs(cloud);
  // The single-sub-goal flow runs to `deadlineMs`, a multi-sub-goal call to
  // `overallDeadlineMs`: the race must outlast whichever is longer.
  const boundMs = Math.min(
    browseTaskInnerBoundMs(cloud, Math.max(overallDeadlineMs, deadlineMs)),
    MAX_TIMER_DELAY_MS
  );
  // The race below is the REAL bound on this call.
  const inner = new AbortController();
  const outer = opts.signal;
  const onOuterAbort = () => inner.abort();
  if (outer?.aborted) inner.abort();
  else outer?.addEventListener("abort", onOuterAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const bound = new Promise<Transcript>((resolve) => {
      timer = setTimeout(() => {
        inner.abort();
        resolve({ status: "budget", steps: [], url: "", title: "", reason: "deadline exceeded" });
      }, boundMs);
    });
    return await Promise.race([
      runBrowseTaskCore(
        goal,
        maxSteps,
        env,
        opts.now,
        opts.sleep,
        url,
        deadlineMs,
        overallDeadlineMs,
        inner.signal
      ),
      bound,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}
