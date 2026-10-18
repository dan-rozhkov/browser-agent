// Neutral core of the QA checks (docs/specs/2026-10-18-qa-diagnostics-design.md,
// section 2): the check parser and the evaluation of an `assert` result against
// the run history. Lives in src/shared so the controller layer and the agent layer
// both import it (the controller must not depend on the agent). Zod-free, imports types only.
import type { QaCheck, QaCheckResult, QaElementState } from "./qaTypes.js";

export const QA_ASSERT_TOOL = "qa_assert";
/** `qa_verdict` reason: 1 to this many chars. Every `qa.reason` stays within it. */
export const REASON_MAX_CHARS = 500;
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

/**
 * Strict-mode placeholder stripping (the QA twin of `normalizeBrowseActInput` in
 * agent/schemas.ts). OpenAI models in strict mode fill EVERY key of the schema, so unused
 * fields arrive as "", null or []. The rule, applied to each check object:
 * - `null` and `""` are absent, except `equals: ""` of a `value` check when no other
 *   comparator is given (an input that must be empty is a real check);
 * - an empty `ignore` array is absent;
 * - `index: 0` next to a non-empty `selector` is the placeholder zero: the selector wins.
 * - `false` is the safe default of a boolean (`absent` of a `text` check), so it needs no rule.
 * - `count` with more than one comparator: a 0 that conflicts is a placeholder and is dropped.
 *   `min: 0` always goes (it is a no-op). `equals: 0` goes when `min` or `max` is non-zero.
 *   `max: 0` goes when `min` is above 0 or `equals` is above 0.
 * - `value`: `equals: ""` next to a non-empty `contains` goes (see the first rule).
 * Nothing else is touched: `equals: 0` of `count` alone and `index: 0` alone are real values.
 * Entries that are not objects, and non-arrays, come back unchanged.
 */
export function normalizeQaChecks(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  return input.map((raw) => {
    if (!isObject(raw)) return raw;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (value === null || value === "") continue;
      if (key === "ignore" && Array.isArray(value) && value.length === 0) continue;
      out[key] = value;
    }
    if (raw.type === "value" && raw.equals === "" && out.contains === undefined) out.equals = "";
    if (raw.type === "count") dropCountPlaceholders(out);
    if (out.index === 0 && typeof out.selector === "string" && out.selector.trim() !== "") delete out.index;
    return out;
  });
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
    const at = `checks[${i}]`;
    const fail = (msg: string) => errors.push(`${at}: ${msg}`);
    if (!isObject(raw)) return fail("expected an object");
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
        if (errors.length === before) value.push({ type: "text", text: text as string, ...(typeof raw.absent === "boolean" ? { absent: raw.absent } : {}) });
        break;
      }
      case "element": {
        const loc = locator();
        const state = raw.state;
        if (typeof state !== "string" || !QA_ELEMENT_STATES.includes(state as QaElementState)) fail(`state: expected one of ${QA_ELEMENT_STATES.join(", ")}`);
        if (errors.length === before) value.push({ type: "element", ...loc, state: state as QaElementState });
        break;
      }
      case "value": {
        const loc = locator();
        const equals = str("equals");
        const contains = str("contains");
        if (equals === undefined && contains === undefined && errors.length === before) fail('give "equals" or "contains"');
        if (errors.length === before) value.push({ type: "value", ...loc, ...(equals !== undefined ? { equals } : {}), ...(contains !== undefined ? { contains } : {}) });
        break;
      }
      case "count": {
        const selector = str("selector");
        if (selector === undefined || selector.trim() === "") fail('"selector" is required and must not be empty');
        const equals = num("equals");
        const min = num("min");
        const max = num("max");
        if (equals === undefined && min === undefined && max === undefined && errors.length === before) fail('give "equals", "min" or "max"');
        if (min !== undefined && max !== undefined && min > max && errors.length === before) fail("min: must not be above max");
        if (errors.length === before) {
          value.push({ type: "count", selector: selector as string, ...(equals !== undefined ? { equals } : {}), ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) });
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
          value.push({ type: "url", ...(equals !== undefined ? { equals } : {}), ...(contains !== undefined ? { contains } : {}), ...(matches !== undefined ? { matches } : {}) });
        }
        break;
      }
      case "no_console_errors":
      case "no_failed_requests": {
        const ignore = ignoreList();
        if (errors.length === before) value.push({ type: raw.type, ...(ignore ? { ignore } : {}) });
        break;
      }
      default:
        fail('type: expected "text", "element", "value", "count", "url", "no_console_errors" or "no_failed_requests"');
    }
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
      return `count of ${check.selector}${check.equals !== undefined ? ` equals ${check.equals}` : ""}${check.min !== undefined ? ` min ${check.min}` : ""}${check.max !== undefined ? ` max ${check.max}` : ""}`;
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

