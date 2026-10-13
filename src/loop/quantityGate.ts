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
  units: number;
  effects: number;
  counterSeen: boolean;
  firstAppeared: boolean;
  lastCounter?: string;
}

const COUNTER = /counter (-?\d+)→(-?\d+)(?![\d,])/;

const keyOf = (label: string): string => label.replace(/\s+/g, " ").trim().toLowerCase();

export interface QuantityGate {
  /** Feed the final label of a landed CLICK once its effect note is known. */
  observe(targetLabel: string, stepLabel: string): void;
  /** A reason string when clicking `targetLabel` again must not happen. */
  blockedReason(targetLabel: string): string | null;
}

export function createQuantityGate(target: number): QuantityGate {
  const byTarget = new Map<string, TargetUnits>();
  return {
    observe(targetLabel, stepLabel) {
      const at = stepLabel.indexOf(EFFECT_PREFIX);
      const key = keyOf(targetLabel);
      if (at < 0 || !key) return;
      const effect = stepLabel.slice(at + EFFECT_PREFIX.length);
      const state = byTarget.get(key) ?? { units: 0, effects: 0, counterSeen: false, firstAppeared: false };
      const counter = COUNTER.exec(effect);
      const first = state.effects === 0;
      if (counter) {
        const delta = Number(counter[2]) - Number(counter[1]);
        state.counterSeen = true;
        state.lastCounter = `${counter[1]}→${counter[2]}`;
        // Deltas, not absolute values: the counter may hold older items.
        state.units += delta > 0 ? delta : first ? 1 : 0;
      } else if (first) {
        state.units = 1;
        state.firstAppeared = /appeared: /.test(effect);
      }
      state.effects++;
      byTarget.set(key, state);
    },
    blockedReason(targetLabel) {
      const state = byTarget.get(keyOf(targetLabel));
      if (!state || state.units < target) return null;
      if (state.counterSeen) return `quantity ${target} reached (counter ${state.lastCounter})`;
      if (target === 1 && state.firstAppeared) return "quantity 1 reached (first click showed a new element)";
      return null;
    },
  };
}
