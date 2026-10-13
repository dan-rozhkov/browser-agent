/**
 * Effect notes for CLICK history labels.
 *
 * The step model only sees the history label of a click ("Add to cart"). When
 * the click worked, the NEXT snapshot shows what it did: the same button now
 * reads "Add to cart 1", a counter moved, a panel appeared. Without that the
 * model repeats the click. `describeEffect` turns the before/after pair into a
 * short note appended to the label.
 *
 * Output contract (the backend parses it — keep the format EXACT):
 *   ` → effect: ` + parts joined by `; `, each part one of
 *     "<old>" became "<new>"
 *     counter <a>→<b>
 *     appeared: "<text>"
 * The note never exceeds EFFECT_NOTE_MAX_CHARS. The element label stays before
 * the first " → " of the final label (the backend cuts there).
 */

export const EFFECT_PREFIX = " → effect: ";
export const EFFECT_NOTE_MAX_CHARS = 90;
const FRAGMENT_MAX_CHARS = 28;
const MAX_APPEARED = 2;

interface SnapshotLike {
  url?: string;
  elements: unknown[];
  modal?: string;
}

export interface ActedElement {
  index?: number;
  tag?: string;
  role?: string;
  label: string;
}

interface Labeled {
  index?: unknown;
  tag?: unknown;
  role?: unknown;
  label?: unknown;
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").replace(/"/g, "'").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Label with digits removed and whitespace collapsed — the "skeleton". */
function skeleton(text: string): string {
  return text.replace(/\d+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function digitsOf(text: string): string {
  const groups = text.match(/\d+/g);
  return groups ? groups.join(",") : "0";
}

/** A skeleton counts as a counter label only with a real word in it, so
 * prices and bare numbers never pair up across unrelated list items. */
function isWordy(sk: string): boolean {
  return /\p{L}{2,}/u.test(sk);
}

function labelsOf(elements: unknown[]): string[] {
  const out: string[] = [];
  for (const el of elements) {
    const label = (el as Labeled | undefined)?.label;
    if (typeof label === "string" && label.trim()) out.push(label.trim());
  }
  return out;
}

function sameKind(el: Labeled, acted: ActedElement): boolean {
  const tag = typeof el.tag === "string" ? el.tag : undefined;
  const role = typeof el.role === "string" ? el.role : undefined;
  return tag === acted.tag && role === acted.role;
}

function findBecame(next: SnapshotLike, acted: ActedElement): string | undefined {
  const oldLabel = acted.label.trim();
  const sk = skeleton(oldLabel);
  if (!oldLabel || !sk) return undefined;
  const candidates: string[] = [];
  let sameIndexLabel: string | undefined;
  for (const raw of next.elements) {
    const el = raw as Labeled | undefined;
    if (!el || typeof el.label !== "string" || !sameKind(el, acted)) continue;
    const label = el.label.trim();
    if (skeleton(label) !== sk) continue;
    if (el.index === acted.index) sameIndexLabel = label;
    if (label !== oldLabel) candidates.push(label);
  }
  if (sameIndexLabel !== undefined) return sameIndexLabel !== oldLabel ? sameIndexLabel : undefined;
  return candidates.length === 1 ? candidates[0] : undefined;
}

function findCounter(prev: SnapshotLike, next: SnapshotLike, appeared: string[], skipLabel: string | undefined): string | undefined {
  const bySkeleton = (labels: string[]): Map<string, string[]> => {
    const map = new Map<string, string[]>();
    for (const label of labels) {
      const sk = skeleton(label);
      if (!isWordy(sk)) continue;
      map.set(sk, [...(map.get(sk) ?? []), label]);
    }
    return map;
  };
  const before = bySkeleton(labelsOf(prev.elements));
  const after = bySkeleton([...labelsOf(next.elements), ...appeared]);
  for (const [sk, nowLabels] of after) {
    const wasLabels = before.get(sk);
    if (!wasLabels || wasLabels.length !== 1 || nowLabels.length !== 1) continue;
    const was = wasLabels[0];
    const now = nowLabels[0];
    if (was === now || (skipLabel !== undefined && now === skipLabel)) continue;
    const a = digitsOf(was);
    const b = digitsOf(now);
    if (a !== b) return `counter ${a}→${b}`;
  }
  return undefined;
}

/**
 * Describes what a landed click changed, comparing the snapshots around it.
 * Returns "" when nothing worth telling was found (or the page navigated —
 * the new URL already says so), else the ` → effect: …` suffix.
 */
export function describeEffect(
  prev: SnapshotLike,
  next: SnapshotLike,
  acted: ActedElement | undefined,
  result?: unknown
): string {
  return describeEffectDetailed(prev, next, acted, result).note;
}

/** The acted element's relabel, unclipped (the note itself clips fragments). */
export interface BecameLabel {
  old: string;
  new: string;
}

/**
 * Same as `describeEffect`, plus the structured relabel when the note kept it.
 * `became` is only ever produced for the acted element: `findBecame` matches
 * on the acted element's own kind and label skeleton (no acted element, no
 * relabel).
 */
export function describeEffectDetailed(
  prev: SnapshotLike,
  next: SnapshotLike,
  acted: ActedElement | undefined,
  result?: unknown
): { note: string; became?: BecameLabel } {
  if (prev.url !== undefined && next.url !== undefined && prev.url !== next.url) return { note: "" };

  const appeared = (() => {
    const raw = result && typeof result === "object" ? (result as { appeared?: unknown }).appeared : undefined;
    return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string" && s.trim() !== "") : [];
  })();

  const parts: string[] = [];
  const became = acted ? findBecame(next, acted) : undefined;
  if (acted && became) parts.push(`"${clip(acted.label, FRAGMENT_MAX_CHARS)}" became "${clip(became, FRAGMENT_MAX_CHARS)}"`);
  const becameIsFirst = parts.length === 1 && Boolean(acted && became);

  const counter = findCounter(prev, next, appeared, became);
  if (counter) parts.push(counter);

  const items = appeared.slice(0, MAX_APPEARED).map((s) => clip(s, FRAGMENT_MAX_CHARS));
  const nextModal = typeof next.modal === "string" ? next.modal.trim() : "";
  const prevModal = typeof prev.modal === "string" ? prev.modal.trim() : "";
  if (nextModal && nextModal !== prevModal && items.length < MAX_APPEARED) {
    const modal = clip(nextModal, FRAGMENT_MAX_CHARS);
    if (!items.includes(modal)) items.push(modal);
  }
  for (const item of items) parts.push(`appeared: "${item}"`);

  // Greedy fit under the cap; later (less important) parts are dropped.
  const kept: string[] = [];
  for (const part of parts) {
    const candidate = EFFECT_PREFIX + [...kept, part].join("; ");
    if (candidate.length <= EFFECT_NOTE_MAX_CHARS) kept.push(part);
  }
  if (kept.length === 0) return { note: "" };
  const note = EFFECT_PREFIX + kept.join("; ");
  return becameIsFirst && acted && became && kept[0] === parts[0] ? { note, became: { old: acted.label, new: became } } : { note };
}

const collapse = (t: string): string => t.replace(/\s+/g, " ").trim();

/**
 * Does the acted element's relabel show a COMMIT of the click? Only when the
 * new label is the old label plus ONE bare number, separated by whitespace, at
 * the very start or very end ("Add to cart" → "Add to cart 1" / "1 Add to
 * cart"), and the old label has no number of its own. Bracketed counts
 * ("Load more (24)"), mid-label numbers ("Show 245 results") and changed
 * numbers ("Adults 2" → "Adults 3") do not count. Page-wide counters are
 * deliberately NOT considered: they are not tied to the clicked element
 * (wizard "Step 1→2", live badges). Works on the structured relabel from
 * `describeEffectDetailed`, not on the clipped note text.
 */
export function isCommitEffect(became: BecameLabel | undefined): string | null {
  if (!became) return null;
  const oldLabel = collapse(became.old);
  const newLabel = collapse(became.new);
  if (!oldLabel || /\d/.test(oldLabel)) return null;
  const tail = newLabel.startsWith(oldLabel + " ") ? newLabel.slice(oldLabel.length + 1) : null;
  const head = newLabel.endsWith(" " + oldLabel) ? newLabel.slice(0, newLabel.length - oldLabel.length - 1) : null;
  const isNum = (x: string | null): boolean => x !== null && /^\d+$/.test(x);
  return isNum(tail) || isNum(head) ? `"${clip(oldLabel, FRAGMENT_MAX_CHARS)}" became "${clip(newLabel, FRAGMENT_MAX_CHARS)}"` : null;
}

export const EARLIER_SUBGOAL_SUFFIX = " (earlier sub-goal)";

/** Where the element label ends: the earliest known suffix marker. */
const SUFFIX_MARKERS = [EFFECT_PREFIX, " (page updated", " (no effect)", EARLIER_SUBGOAL_SUFFIX, " (dialog auto-handled", " → "];
const MIN_BASE_CHARS = 24;

function suffixStart(label: string): number {
  let best = -1;
  for (const marker of SUFFIX_MARKERS) {
    const at = label.indexOf(marker);
    if (at > 0 && (best === -1 || at < best)) best = at;
  }
  return best;
}

/**
 * Fits `label` into `max` chars by cutting ONLY the element-label part (before
 * the first suffix marker). The effect note, page-updated part and carried
 * suffix survive; if they alone are too long, the page-updated text shrinks
 * first. Labels without a suffix are cut plainly.
 */
export function fitLabel(label: string, max: number): string {
  if (label.length <= max) return label;
  const at = suffixStart(label);
  if (at < 0) return `${label.slice(0, max - 1)}…`;
  const base = label.slice(0, at);
  let tail = label.slice(at);
  if (MIN_BASE_CHARS + tail.length > max) {
    const excess = MIN_BASE_CHARS + tail.length - max;
    tail = tail.replace(/ \(page updated: "(.*?)"\)/, (_m, inner: string) => {
      const keep = inner.length - excess - 1;
      return keep > 0 ? ` (page updated: "${inner.slice(0, keep)}…")` : " (page updated)";
    });
  }
  const room = max - tail.length - 1;
  if (room < 1) return `${base.slice(0, 1)}…${tail}`.slice(0, max);
  return `${base.slice(0, room)}…${tail}`;
}

/** Appends `suffix` to `label`, cutting the element label (never the suffix). */
export function appendKeepingSuffix(label: string, suffix: string, max: number): string {
  return fitLabel(label + suffix, max);
}

/** Label without volatile parts (effect note, page-updated text) — for cache keys. */
export function stripVolatileLabelParts(label: string): string {
  return label
    .replace(/ → effect: .*?(?= \(page updated| \(no effect\)| \(earlier sub-goal\)| → |$)/gs, "")
    .replace(/ \(page updated(?:: ".*?")?\)/g, "");
}
