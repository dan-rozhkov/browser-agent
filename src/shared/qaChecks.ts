// Neutral core of the QA checks (docs/specs/2026-10-18-qa-diagnostics-design.md,
// section 2): the check parser and the evaluation of an `assert` result against
// the run history. Lives in src/shared so the controller layer and the agent layer
// both import it (the controller must not depend on the agent). Zod-free, imports types only.
import type { QaCheck, QaCheckResult, QaElementState } from "./qaTypes.js";

export const QA_ASSERT_TOOL = "qa_assert";
export const QA_VERDICT_TOOL = "qa_verdict";
/** `qa_verdict` reason: 1 to this many chars. Every `qa.reason` stays within it. */
export const REASON_MAX_CHARS = 500;
/** `qa_verdict` `items`: at most this many entries. */
export const QA_ITEMS_MAX = 20;
/** One `qa_verdict` item: `id` is 1 to this many chars. */
export const QA_ITEM_ID_MAX_CHARS = 40;
/** One `qa_verdict` item: `reason` is 1 to this many chars. */
export const QA_ITEM_REASON_MAX_CHARS = 300;
/** One `qa_assert` call (and the `checks` option) takes at most this many checks. */
export const QA_CHECKS_MAX = 10;
/** `actual` texts are cut to this length. */
export const QA_CHECK_ACTUAL_MAX_CHARS = 120;
/** The longest string a check holds (text, selector, URL part). */
export const QA_CHECK_STRING_MAX_CHARS = 1000;
/** How long the host's final checks may take before they count as failed. */
export const QA_FINAL_CHECKS_TIMEOUT_MS = 30_000;

export const QA_ELEMENT_STATES: readonly QaElementState[] = ["visible", "hidden", "exists", "absent", "enabled", "disabled", "checked", "unchecked"];

export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Playwright-only selector syntax. The page script uses `document.querySelector`, so these fail there. */
const PLAYWRIGHT_SELECTOR =
  /(?:^|[\s>+~,(])(?:text|css|xpath|role|id|data-testid|internal:[a-z-]+)\s*=|:has-text\(|:text\(|:text-is\(|:text-matches\(|:nth-match\(|:visible\b|>>/i;

/**
 * True when `selector` holds Playwright pseudo syntax that plain CSS does not know. Best effort: quoted
 * strings and bracketed attribute selectors are removed first, so `[role=dialog]` and `[data-x="a>>b"]`
 * (valid CSS) pass.
 */
export const hasPlaywrightSelectorSyntax = (selector: string): boolean =>
  PLAYWRIGHT_SELECTOR.test(selector.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "").replace(/\[[^\]]*\]/g, ""));

export const QA_SELECTOR_SYNTAX_ERROR =
  'selector: Playwright syntax (text=, css=, xpath=, role=, :has-text(), :text(), :visible, >>) is not supported; use a plain CSS selector, or {type:"text", text} for text on the page, or an "index" from the latest snapshot for an element';

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** Drops the conflicting zero comparators of a `count` check in place. */
function dropCountPlaceholders(out: Record<string, unknown>): void {
  const { equals, min, max } = out;
  const given = [equals, min, max].filter((v) => typeof v === "number").length;
  if (given < 2) return;
  const nonZero = (v: unknown) => typeof v === "number" && v !== 0;
  if (equals === 0 && (nonZero(min) || nonZero(max))) delete out.equals;
  if (max === 0 && ((typeof min === "number" && min > 0) || (typeof equals === "number" && equals > 0))) delete out.max;
  if (min === 0) delete out.min;
}

/** The check types, in the order the messages list them. The single source of the type list. */
export const QA_CHECK_TYPES = ["text", "element", "value", "count", "url", "no_console_errors", "no_failed_requests"] as const satisfies readonly QaCheck["type"][];
type QaCheckTypeName = (typeof QA_CHECK_TYPES)[number];
// Compile-time: every `QaCheck["type"]` is in QA_CHECK_TYPES (the `satisfies` above covers the other direction).
type AssertNever<T extends never> = T;
export type QaCheckTypesComplete = AssertNever<Exclude<QaCheck["type"], QaCheckTypeName>>;

const QA_CHECK_TYPE_LIST = `${QA_CHECK_TYPES.slice(0, -1)
  .map((t) => `"${t}"`)
  .join(", ")} or "${QA_CHECK_TYPES[QA_CHECK_TYPES.length - 1]}"`;
/** The error text of a check that has no `type` and none can be inferred (no field name: the caller adds the path). */
export const QA_CHECK_TYPE_MISSING_ERROR = `missing; set "type" to ${QA_CHECK_TYPE_LIST}`;
/** The error text of a check with an unknown `type`. */
export const QA_CHECK_TYPE_UNKNOWN_ERROR = `expected ${QA_CHECK_TYPE_LIST}`;

/** Per type: the keys it knows. Membership only; the value rules live in `validateQaCheck`. */
const QA_TYPE_KEYS = {
  text: ["text", "absent"],
  element: ["selector", "index", "state"],
  value: ["selector", "index", "equals", "contains"],
  count: ["selector", "visible", "equals", "min", "max"],
  url: ["equals", "contains", "matches"],
  no_console_errors: ["ignore"],
  no_failed_requests: ["ignore"],
} as const satisfies Record<QaCheckTypeName, readonly string[]>;
// Compile-time, both directions: the key list of each type equals the keys of its `QaCheck` member minus `type`.
type KeysOf<K extends QaCheckTypeName> = Exclude<keyof Extract<QaCheck, { type: K }>, "type">;
type ListedKeys<K extends QaCheckTypeName> = (typeof QA_TYPE_KEYS)[K][number];
export type QaTypeKeysComplete = AssertNever<{ [K in QaCheckTypeName]: Exclude<KeysOf<K>, ListedKeys<K>> | Exclude<ListedKeys<K>, KeysOf<K>> }[QaCheckTypeName]>;
const QA_KNOWN_KEYS: ReadonlySet<string> = new Set(Object.values(QA_TYPE_KEYS).flat());
/** The types a check without `type` may be given. `value` is never inferred: see `inferQaCheckType`. */
const QA_INFERABLE_TYPES: readonly QaCheckTypeName[] = ["element", "count", "url", "text"];
/** The boolean keys for which `false` means "not given". */
const QA_BOOLEAN_KEYS: readonly string[] = ["visible", "absent"];

/** The type-gated placeholder rules, on a copy of `out`. `emptyEquals`: restore `equals: ""` of a `value` check. */
function applyTypeRules(type: unknown, out: Record<string, unknown>, emptyEquals: boolean): Record<string, unknown> {
  const o = { ...out };
  if (type === "value" && emptyEquals && o.contains === undefined) o.equals = "";
  if (type === "count") dropCountPlaceholders(o);
  return o;
}

/**
 * The type of a check that has none, or undefined. `view` has the type-independent placeholders removed. Rules:
 * - a `false` value of the boolean keys `visible` and `absent` counts as not given; any other `false` is a given key;
 * - the check needs a type-specific key (any known key except `selector`/`index`); `{selector}` alone,
 *   `{selector, visible:false}`, `ignore` alone and `{}` stay untyped;
 * - a type passes the key filter when it knows every given key; a `url` also needs `matches`
 *   (a bare `equals`/`contains` is too vague);
 * - exactly one type passes: it is chosen when it is inferable, and `validateQaCheck` then reports its
 *   field errors (`{text:"Hi", absent:"yes"}` is a `text` check with "absent: expected a boolean");
 * - several types pass: the single inferable one whose check validates is chosen, else the check stays untyped;
 * - inferable types: element, count, url, text. `value` is never inferred (and the `ignore` types neither): a
 *   `selector`/`index` with a string `equals`/`contains` could be a value or the element's text, so it stays
 *   untyped and the model must name the type.
 * Unknown keys are ignored.
 */
function inferQaCheckType(view: Record<string, unknown>): QaCheckTypeName | undefined {
  const given = Object.keys(view).filter((k) => QA_KNOWN_KEYS.has(k) && view[k] !== undefined && !(view[k] === false && QA_BOOLEAN_KEYS.includes(k)));
  if (!given.some((k) => k !== "selector" && k !== "index")) return undefined;
  const passing = QA_CHECK_TYPES.filter((t) => given.every((k) => (QA_TYPE_KEYS[t] as readonly string[]).includes(k)) && (t !== "url" || given.includes("matches")));
  const inferable = passing.filter((t) => QA_INFERABLE_TYPES.includes(t));
  if (passing.length === 1) return inferable[0];
  const valid = inferable.filter((t) => {
    const candidate: Record<string, unknown> = { type: t };
    for (const k of given) candidate[k] = view[k];
    return validateQaCheck(applyTypeRules(t, candidate, false)).ok;
  });
  return valid.length === 1 ? valid[0] : undefined;
}

/**
 * Strict-mode placeholder stripping (the QA twin of `normalizeBrowseActInput` in
 * agent/schemas.ts). OpenAI models in strict mode fill EVERY key of the schema, so unused
 * fields arrive as "", null or []. The rule, applied to each check object:
 * 1. Type-independent (also before inference):
 *    - `null` and `""` are absent, except `equals: ""` of a `value` check (see 3);
 *    - an empty `ignore` array is absent;
 *    - `index: 0` next to a non-empty `selector` is the placeholder zero: the selector wins.
 * 2. A check without `type` (also a `""` or null placeholder) gets a type only when it is unambiguous
 *    (`inferQaCheckType`; the rules are there), so an untyped check normalizes like the same check with
 *    that type. `value` is never inferred. An ambiguous or conflicting check stays untyped and fails validation.
 * 3. Type-gated, with the final type:
 *    - `value`: `equals: ""` stays when no `contains` is given (an input that must be empty is a real check);
 *    - `count` with more than one comparator: a 0 that conflicts is a placeholder and is dropped.
 *      `min: 0` always goes (it is a no-op). `equals: 0` goes when `min` or `max` is non-zero.
 *      `max: 0` goes when `min` is above 0 or `equals` is above 0.
 * Nothing else is touched: `equals: 0` of `count` alone and `index: 0` alone are real values.
 * Entries that are not objects, and non-arrays, come back unchanged.
 */
export function normalizeQaChecks(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  return input.map((raw) => {
    if (!isObject(raw)) return raw;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (value === null || value === "" || (key === "ignore" && Array.isArray(value) && value.length === 0)) continue;
      out[key] = value;
    }
    if (out.index === 0 && typeof out.selector === "string" && out.selector.trim() !== "") delete out.index;
    const type: unknown = out.type ?? inferQaCheckType(out);
    const result = applyTypeRules(type, out, raw.equals === "");
    if (result.type === undefined && type !== undefined) {
      delete result.type; // a `type: undefined` key would otherwise shadow the inferred one
      return { type, ...result };
    }
    return result;
  });
}

/**
 * Validates ONE already-normalized check object by hand (the per-type rules `parseQaChecks` and the
 * type inference of `normalizeQaChecks` share). Errors carry no `checks[i]:` prefix. Unknown keys are dropped.
 */
export function validateQaCheck(raw: Record<string, unknown>): { ok: true; value: QaCheck } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const pushed: QaCheck[] = [];
  const fail = (msg: string) => errors.push(msg);
  const str = (key: string): string | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string") {
      fail(`${key}: expected a string`);
      return undefined;
    }
    if (v.length > QA_CHECK_STRING_MAX_CHARS) {
      fail(`${key}: must be at most ${QA_CHECK_STRING_MAX_CHARS} characters`);
      return undefined;
    }
    return v;
  };
  const num = (key: string): number | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (!isCount(v)) {
      fail(`${key}: expected a non-negative integer`);
      return undefined;
    }
    return v;
  };
  const before = errors.length;
  const locator = (): { selector?: string; index?: number } => {
    const selector = str("selector");
    const index = num("index");
    if (selector !== undefined && selector.trim() === "") fail("selector: must not be empty");
    else if (selector !== undefined && hasPlaywrightSelectorSyntax(selector)) fail(QA_SELECTOR_SYNTAX_ERROR);
    if (selector === undefined && index === undefined && errors.length === before) fail('give a "selector" or an "index"');
    return { ...(selector !== undefined ? { selector } : {}), ...(index !== undefined ? { index } : {}) };
  };
  const ignoreList = (): string[] | undefined => {
    const v = raw.ignore;
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.length > QA_CHECK_STRING_MAX_CHARS) || v.length > 50) {
      fail("ignore: expected an array of strings");
      return undefined;
    }
    return v as string[];
  };
  switch (raw.type) {
    case "text": {
      const text = str("text");
      if (text === undefined || text === "") fail('"text" is required and must not be empty');
      if (raw.absent !== undefined && typeof raw.absent !== "boolean") fail("absent: expected a boolean");
      if (errors.length === before) pushed.push({ type: "text", text: text as string, ...(typeof raw.absent === "boolean" ? { absent: raw.absent } : {}) });
      break;
    }
    case "element": {
      const loc = locator();
      const state = raw.state;
      if (typeof state !== "string" || !QA_ELEMENT_STATES.includes(state as QaElementState)) fail(`state: expected one of ${QA_ELEMENT_STATES.join(", ")}`);
      if (errors.length === before) pushed.push({ type: "element", ...loc, state: state as QaElementState });
      break;
    }
    case "value": {
      const loc = locator();
      const equals = str("equals");
      const contains = str("contains");
      if (equals === undefined && contains === undefined && errors.length === before) fail('give "equals" or "contains"');
      if (errors.length === before) pushed.push({ type: "value", ...loc, ...(equals !== undefined ? { equals } : {}), ...(contains !== undefined ? { contains } : {}) });
      break;
    }
    case "count": {
      const selector = str("selector");
      if (selector === undefined || selector.trim() === "") fail('"selector" is required and must not be empty');
      else if (hasPlaywrightSelectorSyntax(selector)) fail(QA_SELECTOR_SYNTAX_ERROR);
      if (raw.visible !== undefined && typeof raw.visible !== "boolean") fail("visible: expected a boolean");
      const equals = num("equals");
      const min = num("min");
      const max = num("max");
      if (equals === undefined && min === undefined && max === undefined && errors.length === before) fail('give "equals", "min" or "max"');
      if (min !== undefined && max !== undefined && min > max && errors.length === before) fail("min: must not be above max");
      if (errors.length === before) {
        pushed.push({ type: "count", selector: selector as string, ...(raw.visible === true ? { visible: true } : {}), ...(equals !== undefined ? { equals } : {}), ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) });
      }
      break;
    }
    case "url": {
      const equals = str("equals");
      const contains = str("contains");
      const matches = str("matches");
      if (equals === undefined && contains === undefined && matches === undefined && errors.length === before) fail('give "equals", "contains" or "matches"');
      if (matches !== undefined) {
        try {
          new RegExp(matches);
        } catch {
          fail("matches: not a valid regular expression");
        }
      }
      if (errors.length === before) {
        pushed.push({ type: "url", ...(equals !== undefined ? { equals } : {}), ...(contains !== undefined ? { contains } : {}), ...(matches !== undefined ? { matches } : {}) });
      }
      break;
    }
    case "no_console_errors":
    case "no_failed_requests": {
      const ignore = ignoreList();
      if (errors.length === before) pushed.push({ type: raw.type, ...(ignore ? { ignore } : {}) });
      break;
    }
    default:
      fail(`type: ${raw.type === undefined ? QA_CHECK_TYPE_MISSING_ERROR : QA_CHECK_TYPE_UNKNOWN_ERROR}`);
  }
  return errors.length > 0 || pushed.length === 0 ? { ok: false, errors } : { ok: true, value: pushed[0] };
}

/**
 * Checks the `checks` array of `qa_assert` (or of the `checks` option) by hand
 * (no zod). One to `QA_CHECKS_MAX` entries. A check with a missing locator
 * (`selector` or `index` where one is needed), a missing comparator, an unknown
 * type or a bad regex is a parse error. Unknown keys are dropped.
 */
export function parseQaChecks(rawInput: unknown): { ok: true; value: QaCheck[] } | { ok: false; errors: string[] } {
  const input = normalizeQaChecks(rawInput);
  if (!Array.isArray(input)) return { ok: false, errors: ["checks: expected an array"] };
  if (input.length < 1) return { ok: false, errors: ["checks: give at least one check"] };
  if (input.length > QA_CHECKS_MAX) return { ok: false, errors: [`checks: at most ${QA_CHECKS_MAX} checks per call`] };
  const errors: string[] = [];
  const value: QaCheck[] = [];
  input.forEach((raw, i) => {
    if (!isObject(raw)) return errors.push(`checks[${i}]: expected an object`);
    const r = validateQaCheck(raw);
    if (r.ok) value.push(r.value);
    else errors.push(...r.errors.map((e) => `checks[${i}]: ${e}`));
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/** A short text for one check, for messages. */
export function describeQaCheck(check: QaCheck): string {
  const where = (c: { selector?: string; index?: number }) => (c.selector !== undefined ? c.selector : `element ${c.index}`);
  switch (check.type) {
    case "text":
      return `text "${check.text}" ${check.absent === true ? "absent" : "present"}`;
    case "element":
      return `${where(check)} is ${check.state}`;
    case "value":
      return `value of ${where(check)} ${check.equals !== undefined ? `equals "${check.equals}"` : `contains "${check.contains}"`}`;
    case "count":
      return `count of ${check.visible === true ? "visible " : ""}${check.selector}${check.equals !== undefined ? ` equals ${check.equals}` : ""}${check.min !== undefined ? ` min ${check.min}` : ""}${check.max !== undefined ? ` max ${check.max}` : ""}`;
    case "url":
      return `url ${check.equals !== undefined ? `equals ${check.equals}` : check.contains !== undefined ? `contains ${check.contains}` : `matches ${check.matches}`}`;
    case "no_console_errors":
      return "no console errors";
    case "no_failed_requests":
      return "no failed requests";
  }
}

/** The failure of one check as a sentence part: the check, then the actual value or the error. */
export function describeQaCheckFailure(r: QaCheckResult): string {
  const detail = r.error ?? r.actual;
  return `${describeQaCheck(r.check)}${detail ? ` (${detail})` : ""}`;
}

/** Cuts `text` to `max` chars (the last three become "..."). `max` below 3 gives "...". */
export const cut = (text: string, max = QA_CHECK_ACTUAL_MAX_CHARS): string => (text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text);

/** The entries (deduped, first-seen order) minus those that hold an `ignore` substring. */
function remaining(history: readonly string[], now: readonly string[], ignore: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of [...history, ...now]) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    if (ignore?.some((s) => s !== "" && entry.includes(s))) continue;
    out.push(entry);
  }
  return out;
}

/** The part of the run history `evaluateQaChecks` needs. A `StepRecorder` is one. */
export interface QaDiagnosticsHistory {
  /** Console errors seen earlier in the run (deduped). */
  seenConsoleErrors(): readonly string[];
  /** Failed requests seen earlier in the run (deduped). */
  seenFailedRequests(): readonly string[];
}

export type QaEvaluation =
  | { ok: true; passed: boolean; results: QaCheckResult[]; consoleErrors?: string[]; failedRequests?: string[]; consoleErrorsDropped?: number; failedRequestsDropped?: number }
  | { ok: false; error: string };

/**
 * Turns the result of the bridge `assert` call into check results. `no_console_errors`
 * and `no_failed_requests` look at the run history plus what this call drained (the
 * controller saw only the latter); the other checks keep the controller's answer.
 * `checks` are the checks that were sent. An `{ error }` or an odd shape gives `{ ok: false }`.
 */
export function evaluateQaChecks(result: unknown, checks: readonly QaCheck[], history?: Partial<QaDiagnosticsHistory>): QaEvaluation {
  if (!isObject(result)) return { ok: false, error: "the browser gave no answer to the checks" };
  if (typeof result.error === "string") return { ok: false, error: result.error };
  const raw = result.results;
  if (!Array.isArray(raw) || raw.length !== checks.length) return { ok: false, error: "the browser gave a malformed answer to the checks" };
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const consoleNow = strings(result.consoleErrors);
  const requestsNow = strings(result.failedRequests);
  const results: QaCheckResult[] = checks.map((check, i) => {
    const r = isObject(raw[i]) ? (raw[i] as Record<string, unknown>) : {};
    if (check.type === "no_console_errors" || check.type === "no_failed_requests") {
      const isConsole = check.type === "no_console_errors";
      const bad = remaining(isConsole ? (history?.seenConsoleErrors?.() ?? []) : (history?.seenFailedRequests?.() ?? []), isConsole ? consoleNow : requestsNow, check.ignore);
      return bad.length === 0
        ? { check, passed: true }
        : { check, passed: false, actual: cut(`${bad.length} ${isConsole ? "console error" : "failed request"}${bad.length === 1 ? "" : "s"}: ${bad[0]}`) };
    }
    return {
      check,
      passed: r.passed === true,
      ...(typeof r.actual === "string" ? { actual: cut(r.actual) } : {}),
      ...(typeof r.error === "string" ? { error: cut(r.error, 200) } : {}),
    };
  });
  const dropped = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : 0);
  const consoleDropped = dropped(result.consoleErrorsDropped);
  const requestsDropped = dropped(result.failedRequestsDropped);
  return {
    ok: true,
    passed: results.every((r) => r.passed),
    results,
    ...(consoleNow.length > 0 ? { consoleErrors: consoleNow } : {}),
    ...(requestsNow.length > 0 ? { failedRequests: requestsNow } : {}),
    ...(consoleDropped > 0 ? { consoleErrorsDropped: consoleDropped } : {}),
    ...(requestsDropped > 0 ? { failedRequestsDropped: requestsDropped } : {}),
  };
}

