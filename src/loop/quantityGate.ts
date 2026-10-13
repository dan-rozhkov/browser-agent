import { EFFECT_PREFIX } from "./actionEffect.js";

/**
 * "Quantity reached" gate. A sub-goal such as "Add 2 units of X to the bag"
 * is satisfied by two landed clicks, yet a step policy that sees only the
 * button (which never changes) can keep clicking until the page counter reads
 * 4. This module reads the target quantity N from the sub-goal text and
 * counts the units that clicks on one target produced (from the effect notes
 * the loop appends to click labels). The loop asks `blockedReason` before it
 * repeats such a click. Pure and isomorphic: no site, class or shop words.
 *
 * It prefers silence: the gate fires only when the evidence is clear (see
 * `blockedReason`).
 */

const MAX_TARGET_QUANTITY = 20;

const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

const NUM = String.raw`(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)`;
/** What may follow "add N" without N being a size, price or similar. */
const NOT_MEASURE = String.raw`(?!\s*(?:cm|mm|m|km|kg|g|mg|lb|lbs|oz|in|inch|inches|ft|ml|l|gb|mb|tb|px|pt|%|°|[$€£₽]|\d|[.,:/-]\d))`;
const QUANTITY_PATTERNS: RegExp[] = [
  new RegExp(String.raw`(?<![\p{L}\p{N}])add\s+${NUM}(?![\p{L}\p{N}])${NOT_MEASURE}`, "giu"),
  new RegExp(String.raw`(?<![\p{L}\p{N}.,$€£])${NUM}\s*(?:units?|items?|pieces?|pcs|copies|copy)(?![\p{L}\p{N}])`, "giu"),
  new RegExp(String.raw`(?<![\p{L}\p{N}.,$€£])${NUM}\s*[x×](?![\p{L}\p{N}])`, "giu"),
  new RegExp(String.raw`(?<![\p{L}\p{N}])(?:quantity|qty)\s*(?:of|to|=|:)?\s*${NUM}(?![\p{L}\p{N}])${NOT_MEASURE}`, "giu"),
  new RegExp(String.raw`(?<![\p{L}\p{N}])set\b(?=[^.]{0,40}?(?:quantity|qty|units?|items?|amount|number|count))[^.]{0,40}?\bto\s+${NUM}(?![\p{L}\p{N}])${NOT_MEASURE}`, "giu"),
];
/** "quantity to N" / "qty = N" / "set … to N": N is the final count shown, not an increment. */
const ABSOLUTE_PATTERNS: RegExp[] = [QUANTITY_PATTERNS[3], QUANTITY_PATTERNS[4]].map(
  (re) => new RegExp(re.source.replace(String.raw`\s*(?:of|to|=|:)?\s*`, String.raw`\s*(?:of|to|=|:)\s*`), "giu")
);

function valueOf(raw: string): number {
  const lower = raw.toLowerCase();
  return WORD_NUMBERS[lower] ?? Number(lower);
}

function quantitiesIn(text: string, patterns: RegExp[] = QUANTITY_PATTERNS): Set<number> {
  const found = new Set<number>();
  for (const pattern of patterns) {
    for (const m of text.matchAll(pattern)) {
      const n = valueOf(m[1]);
      if (Number.isInteger(n)) found.add(n);
    }
  }
  return found;
}

export interface TargetQuantity {
  quantity: number;
  /** The text names the final count ("quantity to 3"), so a counter ending at it also counts. */
  absolute: boolean;
}

/**
 * The one quantity a sub-goal asks for, or null. The action part wins; the
 * Done-when part is read only when the action part names none. More than one
 * distinct quantity, or a value outside 1..20, gives null.
 */
export function parseTarget(action: string, condition: string): TargetQuantity | null {
  for (const part of [action, condition]) {
    const found = quantitiesIn(part);
    if (found.size === 0) continue;
    if (found.size !== 1) return null;
    const [n] = found;
    if (n < 1 || n > MAX_TARGET_QUANTITY) return null;
    return { quantity: n, absolute: quantitiesIn(part, ABSOLUTE_PATTERNS).has(n) };
  }
  return null;
}

export function parseTargetQuantity(action: string, condition: string): number | null {
  return parseTarget(action, condition)?.quantity ?? null;
}

interface TargetUnits {
  /** Sum of the valid counter deltas seen on this target. */
  deltas: number;
  /** Appeared texts of the click on this target that came right before the current one. */
  prevAppeared: string[];
  /** The first valid counter's start value was named by the previous click's appeared text: that click was the first add. */
  inferredFirst: boolean;
  counterSeen: boolean;
  lastCounter?: string;
  /** Absolute targets only: a counter on this target ended at N. */
  reachedAbsolute: boolean;
  /** N=1 only: the first effect showed a count-like "1". */
  firstShowedOne: boolean;
  effects: number;
}

const COUNTER = /counter (-?\d+)→(-?\d+)(?![\d,])/;
const APPEARED = /appeared: "([^"]*)"/g;

/** Origin + pathname + query (variants live in the query); the hash is dropped. */
function pageKey(url: string | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return url.split("#")[0];
  }
}

const keyOf = (url: string | undefined, label: string): string =>
  `${pageKey(url)}\u0000${label.replace(/\s+/g, " ").trim().toLowerCase()}`;

const hasToken = (text: string, n: number): boolean => new RegExp(`(?<!\\d)${n}(?!\\d)`).test(text);

/** "1 item(s)", "(1)", "1 ×" / "× 1": a count, unlike "Only 1 left". */
const COUNT_ONE = /(?<![\d.,])1\s*(?:items?|units?|products?|articles?)(?![\p{L}\p{N}])|\(1\)|(?<![\d.,])1\s*[x×](?![\p{L}\p{N}])|[x×]\s*1(?![\d.,])/iu;

export interface QuantityGate {
  readonly target: number;
  /** Feed the final label of a landed CLICK once its effect note is known.
   * `became` is the target's relabel, if any: the new label aliases the same state. */
  observe(at: { url?: string; label: string }, stepLabel: string, became?: { old: string; new: string }): void;
  /** A reason string when clicking `label` on `url` again must not happen. */
  blockedReason(url: string | undefined, label: string): string | null;
}

export function createQuantityGate(target: number, absolute = false): QuantityGate {
  const byTarget = new Map<string, TargetUnits>();
  return {
    target,
    observe(at, stepLabel, became) {
      if (!at.label.trim()) return;
      const key = keyOf(at.url, at.label);
      const idx = stepLabel.indexOf(EFFECT_PREFIX);
      if (idx < 0) {
        const old = byTarget.get(key);
        if (old) old.prevAppeared = [];
        return;
      }
      const effect = stepLabel.slice(idx + EFFECT_PREFIX.length);
      const state = byTarget.get(key) ?? {
        deltas: 0,
        prevAppeared: [],
        inferredFirst: false,
        counterSeen: false,
        reachedAbsolute: false,
        firstShowedOne: false,
        effects: 0,
      };
      const counter = COUNTER.exec(effect);
      const a = counter ? Number(counter[1]) : NaN;
      const b = counter ? Number(counter[2]) : NaN;
      // A jump past N is a price or subtotal, not units.
      if (counter && b - a > 0 && b - a <= target) {
        if (!state.counterSeen) state.inferredFirst = state.prevAppeared.some((t) => hasToken(t, a));
        state.counterSeen = true;
        state.deltas += b - a;
        state.lastCounter = `${a}→${b}`;
        if (absolute && b === target) state.reachedAbsolute = true;
      }
      const texts = [...effect.matchAll(APPEARED)].map((m) => m[1]);
      state.prevAppeared = texts;
      if (state.effects === 0 && target === 1 && texts.some((t) => COUNT_ONE.test(t))) state.firstShowedOne = true;
      state.effects++;
      byTarget.set(key, state);
      // A relabel aliases the state: the old label may come back.
      if (became?.new.trim()) byTarget.set(keyOf(at.url, became.new), state);
    },
    blockedReason(url, label) {
      const state = byTarget.get(keyOf(url, label));
      if (!state) return null;
      if (state.counterSeen && state.reachedAbsolute) return `quantity ${target} reached (counter ${state.lastCounter})`;
      if (state.counterSeen && state.deltas + (state.inferredFirst ? 1 : 0) >= target) {
        return `quantity ${target} reached (counter ${state.lastCounter})`;
      }
      if (target === 1 && state.firstShowedOne) return "quantity 1 reached (first click showed a count of 1)";
      return null;
    },
  };
}
