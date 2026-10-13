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
];

function quantitiesIn(text: string): Set<number> {
  const found = new Set<number>();
  for (const pattern of QUANTITY_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      const raw = m[1].toLowerCase();
      const n = WORD_NUMBERS[raw] ?? Number(raw);
      if (Number.isInteger(n)) found.add(n);
    }
  }
  return found;
}

/**
 * The one quantity a sub-goal asks for, or null. The action part wins; the
 * Done-when part is read only when the action part names none. More than one
 * distinct quantity, or a value outside 1..20, gives null.
 */
export function parseTargetQuantity(action: string, condition: string): number | null {
  for (const part of [action, condition]) {
    const found = quantitiesIn(part);
    if (found.size === 0) continue;
    if (found.size !== 1) return null;
    const [n] = found;
    return n >= 1 && n <= MAX_TARGET_QUANTITY ? n : null;
  }
  return null;
}

interface TargetUnits {
  /** Sum of the valid counter deltas seen on this target. */
  deltas: number;
  /** Appeared texts of earlier effects, kept until the first counter shows. */
  appeared: string[];
  /** The first valid counter's start value was named by an earlier appeared text: that click was the first add. */
  inferredFirst: boolean;
  counterSeen: boolean;
  lastCounter?: string;
  /** N=1 only: a first appeared text names the number 1. */
  firstShowedOne: boolean;
  effects: number;
}

const COUNTER = /counter (-?\d+)→(-?\d+)(?![\d,])/;
const APPEARED = /appeared: "([^"]*)"/g;

/** Origin + pathname: the same page across hash, query and SPA state. */
function pageKey(url: string | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split(/[?#]/)[0];
  }
}

const keyOf = (url: string | undefined, label: string): string =>
  `${pageKey(url)}\u0000${label.replace(/\s+/g, " ").trim().toLowerCase()}`;

const hasToken = (text: string, n: number): boolean => new RegExp(`(?<!\\d)${n}(?!\\d)`).test(text);

export interface QuantityGate {
  readonly target: number;
  /** Feed the final label of a landed CLICK once its effect note is known.
   * `became` is the target's relabel, if the effect showed one: state follows it. */
  observe(at: { url?: string; label: string }, stepLabel: string, became?: { old: string; new: string }): void;
  /** A reason string when clicking `label` on `url` again must not happen. */
  blockedReason(url: string | undefined, label: string): string | null;
}

export function createQuantityGate(target: number): QuantityGate {
  const byTarget = new Map<string, TargetUnits>();
  return {
    target,
    observe(at, stepLabel, became) {
      const key = keyOf(at.url, at.label);
      const idx = stepLabel.indexOf(EFFECT_PREFIX);
      if (idx < 0 || !at.label.trim()) return;
      const effect = stepLabel.slice(idx + EFFECT_PREFIX.length);
      const state = byTarget.get(key) ?? { deltas: 0, appeared: [], inferredFirst: false, counterSeen: false, firstShowedOne: false, effects: 0 };
      const counter = COUNTER.exec(effect);
      const a = counter ? Number(counter[1]) : NaN;
      const delta = counter ? Number(counter[2]) - a : 0;
      // A jump past N is a price or subtotal, not units.
      if (counter && delta > 0 && delta <= target) {
        if (!state.counterSeen) state.inferredFirst = state.appeared.some((t) => hasToken(t, a));
        state.counterSeen = true;
        state.deltas += delta;
        state.lastCounter = `${counter[1]}→${counter[2]}`;
      }
      const texts = [...effect.matchAll(APPEARED)].map((m) => m[1]);
      if (!state.counterSeen) state.appeared.push(...texts);
      if (state.effects === 0 && target === 1 && texts.some((t) => hasToken(t, 1))) state.firstShowedOne = true;
      state.effects++;
      byTarget.delete(key);
      byTarget.set(became?.new.trim() ? keyOf(at.url, became.new) : key, state);
    },
    blockedReason(url, label) {
      const state = byTarget.get(keyOf(url, label));
      if (!state) return null;
      if (state.counterSeen && state.deltas + (state.inferredFirst ? 1 : 0) >= target) {
        return `quantity ${target} reached (counter ${state.lastCounter})`;
      }
      if (target === 1 && state.firstShowedOne) return "quantity 1 reached (first click showed the number 1)";
      return null;
    },
  };
}
