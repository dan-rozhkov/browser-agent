// Deterministic checks of QA mode (docs/specs/2026-10-18-qa-diagnostics-design.md,
// section 2): the `qa_assert` executor and the host's final checks. The parser and
// the evaluation are in src/shared/qaChecks.ts (re-exported here).
// Zod-free and `ai`-free (exported from `agent/session` and `agent`). The zod
// schema of `qa_assert` is in qa.ts and must agree with `parseQaChecks`.
import { QA_ASSERT_TOOL, QA_FINAL_CHECKS_TIMEOUT_MS, REASON_MAX_CHARS, cut, describeQaCheckFailure, evaluateQaChecks, isObject, parseQaChecks } from "../shared/qaChecks.js";
import type { QaCheck, QaCheckRecord, QaCheckResult, QaResult } from "./qaTypes.js";
import type { QaDiagnosticsHistory } from "../shared/qaChecks.js";

export * from "../shared/qaChecks.js";

/** What a browser needs to run checks: the bridge `assert`. */
export interface QaAssertBrowser {
  assert?(args: { checks: QaCheck[] }): Promise<unknown>;
}

/** Where `executeQaAssert` and `runFinalChecks` read the history and write their records. A `StepRecorder` is one. */
export interface QaCheckSink extends QaDiagnosticsHistory {
  addChecks(records: QaCheckRecord[]): void;
}

/**
 * Runs `qa_assert` (zod-free): checks the input, calls `browser.assert`, evaluates with the
 * run history, records the results (source "agent") and returns the result string
 * `{ passed, results, consoleErrors?, failedRequests? }`. A failed check is a normal result, not an
 * error. The drained `consoleErrors` and `failedRequests` stay in the output, so the step
 * recorder harvests them.
 */
export async function executeQaAssert(input: unknown, browser: QaAssertBrowser, sink: QaCheckSink): Promise<string> {
  const parsed = parseQaChecks(isObject(input) ? input.checks : undefined);
  if (!parsed.ok) return JSON.stringify({ error: `${QA_ASSERT_TOOL}: ${parsed.errors.join("; ")}` });
  if (!browser.assert) return JSON.stringify({ error: `${QA_ASSERT_TOOL}: this browser does not support assertions.` });
  let answer: unknown;
  try {
    answer = await browser.assert({ checks: parsed.value });
  } catch (err) {
    return JSON.stringify({ error: `${QA_ASSERT_TOOL}: ${err instanceof Error ? err.message : String(err)}` });
  }
  const evaluated = evaluateQaChecks(answer, parsed.value, sink);
  if (!evaluated.ok) {
    // The error output carries no lists, so the recorder cannot harvest them: take them from the answer here.
    (sink as Partial<QaFinalSink>).addDiagnostics?.(diagnosticsOf(answer));
    return JSON.stringify({ error: `${QA_ASSERT_TOOL}: ${evaluated.error}` });
  }
  sink.addChecks(evaluated.results.map((r) => ({ source: "agent" as const, ...r })));
  return JSON.stringify({
    passed: evaluated.passed,
    results: evaluated.results,
    ...(evaluated.consoleErrors ? { consoleErrors: evaluated.consoleErrors } : {}),
    ...(evaluated.failedRequests ? { failedRequests: evaluated.failedRequests } : {}),
    ...(evaluated.consoleErrorsDropped ? { consoleErrorsDropped: evaluated.consoleErrorsDropped } : {}),
    ...(evaluated.failedRequestsDropped ? { failedRequestsDropped: evaluated.failedRequestsDropped } : {}),
  });
}

/** The outcomes a host's final checks apply to. They are skipped for `setup_failed`, `aborted` and `error`. */
export function finalChecksApply(qa: Pick<QaResult, "outcome">): boolean {
  return qa.outcome === "passed" || qa.outcome === "failed" || qa.outcome === "inconclusive";
}

/** The sink side `runFinalChecks` also writes: what the final `assert` drained. */
export interface QaFinalSink extends QaCheckSink {
  addDiagnostics(d: { consoleErrors?: readonly string[]; failedRequests?: readonly string[]; consoleErrorsDropped?: number; failedRequestsDropped?: number }): void;
}

/** The drained lists (and dropped counters) an `assert` answer carries, whatever else is wrong with it. */
function diagnosticsOf(answer: unknown): Parameters<QaFinalSink["addDiagnostics"]>[0] {
  if (!isObject(answer)) return {};
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    consoleErrors: strings(answer.consoleErrors).length > 0 ? strings(answer.consoleErrors) : undefined,
    failedRequests: strings(answer.failedRequests).length > 0 ? strings(answer.failedRequests) : undefined,
    consoleErrorsDropped: typeof answer.consoleErrorsDropped === "number" ? answer.consoleErrorsDropped : undefined,
    failedRequestsDropped: typeof answer.failedRequestsDropped === "number" ? answer.failedRequestsDropped : undefined,
  };
}

/**
 * Runs the host's final checks once through `browser.assert` and evaluates them with the run
 * history. Always returns one result per check: when the browser has no `assert`, throws, times out or
 * answers with an error, every check is a failed result that carries the reason. The drained
 * errors go to the sink (`addDiagnostics`) so the run lists them.
 */
export async function runFinalChecks(browser: QaAssertBrowser, checks: readonly QaCheck[], sink: QaFinalSink, timeoutMs = QA_FINAL_CHECKS_TIMEOUT_MS): Promise<QaCheckResult[]> {
  const failAll = (error: string): QaCheckResult[] => checks.map((check) => ({ check, passed: false, error }));
  if (!browser.assert) return failAll("this browser does not support assertions");
  let answer: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The drained lists are harvested from the answer whenever it arrives (even after a timeout, and
  // even when it is not a valid answer to the checks): the controller emptied its buffers, so they are
  // gone for good if nobody takes them. Late is harmless: the recorder only adds.
  const assertFn = browser.assert.bind(browser);
  const pending = (async () => assertFn({ checks: [...checks] }))();
  pending.then(
    (a) => sink.addDiagnostics(diagnosticsOf(a)),
    () => undefined,
  );
  try {
    answer = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the checks did not finish in ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } catch (err) {
    return failAll(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
  const evaluated = evaluateQaChecks(answer, checks, sink);
  if (!evaluated.ok) return failAll(evaluated.error);
  return evaluated.results;
}

/**
 * `Final check failed: <check>. Agent verdict: <reason>`, at most `REASON_MAX_CHARS` chars like every
 * `qa.reason`. The check description is cut first (to 200 chars); then the agent reason takes the room that is left.
 */
function finalFailureReason(failure: string, agentReason: string): string {
  const head = `Final check failed: ${cut(failure, 200)}. Agent verdict: `;
  return `${head}${cut(agentReason, REASON_MAX_CHARS - head.length)}`;
}

/**
 * Adds the host's final check results to a `qa` result (source "final"). Outcome `passed` with a
 * failed final check becomes `failed`, with reason `Final check failed: <first failure>. Agent
 * verdict: <reason>`. Other outcomes do not change; neither does a result the final checks do not apply to
 * (`setup_failed`, `aborted`, `error`): it comes back as is.
 */
export function applyFinalChecks(qa: QaResult, results: readonly QaCheckResult[]): QaResult {
  if (!finalChecksApply(qa) || results.length === 0) return qa;
  const records: QaCheckRecord[] = results.map((r) => ({ source: "final" as const, ...r }));
  const next: QaResult = { ...qa, checks: [...(qa.checks ?? []), ...records] };
  const firstFailure = results.find((r) => !r.passed);
  if (qa.outcome === "passed" && firstFailure) {
    next.outcome = "failed";
    next.reason = finalFailureReason(describeQaCheckFailure(firstFailure), qa.reason ?? "pass");
  }
  return next;
}
