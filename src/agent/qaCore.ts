// QA mode core of the browse agent (docs/specs/2026-10-17-qa-suite-design.md): the
// model checks a web app against a scenario and gives a verdict with the
// `qa_verdict` tool. These are the parts a host on the session core can
// assemble itself; `runBrowseAgent({ qa })` does it for the AI SDK loop.
// This is the zod-free core (exported from `agent/session` and `agent`); the zod
// schema of `qa_verdict` is in qa.ts. Imports the session and result only.
import { browseAgentErrorMessage, type BrowseAgentStatus } from "./result.js";
import { QA_ASSERT_TOOL, QA_VERDICT_TOOL, REASON_MAX_CHARS, type QaFinalSink } from "./qaChecks.js";
import type { QaCheckRecord, QaOutcome, QaResult, QaStep } from "./qaTypes.js";
import { createSeenList, harvestDiagnostics } from "../shared/diagnostics.js";
import { parseJsonObject, singleUseTool, type BrowseAgentExtraToolHooks, type BrowseAgentToolCall } from "./session.js";

export * from "./qaChecks.js";
export * from "./qaJudge.js";

/** The principal of the QA prompt ("You are a browsing subagent working for a QA engineer"). */
export const QA_PRINCIPAL = "a QA engineer";
/** `qa.steps` of a result keeps this many steps (the last ones). */
export const QA_RESULT_MAX_STEPS = 30;
/** `text` values longer than this are cut in the recorded args. */
export const QA_STEP_TEXT_MAX_CHARS = 200;

/** The prompt section of a QA run. A host with its own full prompt text must include it. */
export const QA_PROMPT_SECTION = `You test a web app. The user message is one test scenario: do what it says in the browser, then check the expected result on the page.
To confirm an expected result, call \`${QA_ASSERT_TOOL}\`. It runs exact checks on the page: visible text, the state of an element, the value of an input, the number of matching elements, the page URL, console errors and failed requests. Use it for each result the scenario expects, before the verdict. A failed check does not end the test: look at the page, then decide.
When you have checked the result, call \`${QA_VERDICT_TOOL}\` exactly once, at the end. Use verdict \`pass\` when the app behaves as the scenario expects. Use verdict \`fail\` when it does not, and give the reason in one or two sentences: what you expected and what you saw. Give verdict \`pass\` only when the checks you rely on passed. Base the verdict only on what you saw on the page.
A blocked step (a CAPTCHA, a login wall, a missing page) is not a fail. Do not call \`${QA_VERDICT_TOOL}\` then: explain in your final answer what blocked you.`;

/** The input of `qa_verdict`. */
export interface QaVerdict {
  verdict: "pass" | "fail";
  reason: string;
}

export type { QaAssertResult, QaCheck, QaCheckRecord, QaCheckResult, QaElementState, QaOutcome, QaResult, QaStep } from "./qaTypes.js";

/**
 * Checks `qa_verdict` input by hand (no zod). The rules are those of
 * `qaVerdictSchema`: verdict "pass" or "fail"; reason a string, trimmed, 1 to 500 chars.
 */
export function parseQaVerdict(input: unknown): { ok: true; value: QaVerdict } | { ok: false; errors: string[] } {
  const obj = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
  const errors: string[] = [];
  const verdict: "pass" | "fail" | undefined = obj?.verdict === "pass" || obj?.verdict === "fail" ? obj.verdict : undefined;
  if (verdict === undefined) errors.push('verdict: expected "pass" or "fail"');
  const reason = typeof obj?.reason === "string" ? obj.reason.trim() : undefined;
  if (reason === undefined) errors.push("reason: expected a string");
  else if (reason.length < 1) errors.push("reason: must not be empty");
  else if (reason.length > REASON_MAX_CHARS) errors.push(`reason: must be at most ${REASON_MAX_CHARS} characters`);
  if (errors.length > 0 || verdict === undefined || reason === undefined) return { ok: false, errors };
  return { ok: true, value: { verdict, reason } };
}

/** QA variant of the irreversible-step rule: the scenario asks for submits and test data, so the subagent rule ("stop") does not apply. */
export const QA_IRREVERSIBLE_LINE =
  "- Do the steps the scenario asks for, including submitting forms and creating or deleting test data on the app under test. Never pay with a real payment method, never send messages to real people outside the app, and never enter real personal data: use the test data the scenario gives or obvious fake data.";

/** The closing paragraph of a QA prompt. It names `qa_verdict`, so it is the last thing the model reads. */
export const QA_AGENT_CLOSING = `When you have checked the expected result, call \`${QA_VERDICT_TOOL}\` once, unless a blocked step (a CAPTCHA, a login or anti-bot wall, a missing page) stopped you. Then give a short final answer in plain text: what you checked, what you saw, and the final URL. Do not add facts you did not see. Do not open other pages after the verdict.`;

/** The result field the verdict tool hooks fill (`qaResultOf` folds it into `qa`). */
export const QA_VERDICT_FIELD = "qaVerdict";

/**
 * Hooks of `qa_verdict`: a second call is refused by the guard before it runs,
 * the first success ends the run (`endsRun`: the session stops asking the model),
 * and puts `{ verdict, reason }` into the run result field
 * `qaVerdict`. A call with bad input is an error and does not use up the one
 * verdict. State is per session (`fork`).
 */
export function qaVerdictHooks(): BrowseAgentExtraToolHooks {
  return singleUseTool({
    name: QA_VERDICT_TOOL,
    isSuccess: (parsed) => parsed.ok === true,
    fields: (parsed) => ({ [QA_VERDICT_FIELD]: { verdict: parsed.verdict, reason: parsed.reason } }),
    endsRun: true,
    doneMessage: (parsed) => `${QA_VERDICT_TOOL} was already called. The first verdict stays: ${String(parsed.verdict)}.`,
  });
}

/** Runs `qa_verdict` (zod-free): checks the input and returns the result string. */
export function executeQaVerdict(input: unknown): string {
  const parsed = parseQaVerdict(input);
  if (!parsed.ok) return JSON.stringify({ error: `${QA_VERDICT_TOOL}: ${parsed.errors.join("; ")}` });
  return JSON.stringify({ ok: true, ...parsed.value });
}

/** The outcome of a run. A verdict wins over a later `step_limit` or `timeout`. */
export function qaOutcome(status: BrowseAgentStatus, verdict: QaVerdict | undefined): QaOutcome {
  if (status === "setup_failed") return "setup_failed";
  if (status === "aborted") return "aborted";
  if (verdict?.verdict === "pass") return "passed";
  if (verdict?.verdict === "fail") return "failed";
  return status === "done" ? "inconclusive" : "error";
}

const STATUS_REASONS: Partial<Record<BrowseAgentStatus, string>> = {
  step_limit: "request limit reached",
  timeout: "deadline reached",
};

function verdictOf(fields: Record<string, unknown>): QaVerdict | undefined {
  // The hooks put validated data here; a host on the session core may put anything.
  const parsed = parseQaVerdict(fields[QA_VERDICT_FIELD]);
  return parsed.ok ? parsed.value : undefined;
}

/** The run-level lists a step recorder collects (`StepRecorder.extras()`): console errors, failed requests, check records. */
export type QaRunExtras = Pick<QaResult, "consoleErrors" | "consoleErrorsDropped" | "failedRequests" | "failedRequestsDropped" | "checks">;

/**
 * Builds the `qa` field from a run result (any object with `status`, `error`
 * and the `qaVerdict` field) and the recorded steps. `extras` (from the step
 * recorder) adds the console errors, failed requests and checks.
 */
export function qaResultOf(result: { status: BrowseAgentStatus; error?: unknown; [k: string]: unknown }, steps: readonly QaStep[], extras?: QaRunExtras): QaResult {
  const verdict = verdictOf(result);
  const outcome = qaOutcome(result.status, verdict);
  // The run's own `error` is on the result already; `reason` does not copy it.
  const reason = verdict?.reason ?? (outcome === "error" && typeof result.error !== "string" ? (STATUS_REASONS[result.status] ?? `the run ended with status ${result.status}`) : undefined);
  const kept = steps.slice(-QA_RESULT_MAX_STEPS);
  return {
    outcome,
    ...(verdict ? { verdict: verdict.verdict } : {}),
    ...(reason !== undefined ? { reason } : {}),
    steps: kept.map(({ ms: _ms, ...step }) => step),
    ...(steps.length > kept.length ? { stepsDropped: steps.length - kept.length } : {}),
    ...(extras ?? {}),
  };
}

const MAX_DEPTH = 6;

/** A copy of `value` with every long `text` string cut. Bounded depth, so an odd value cannot loop. */
function cutText(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return depth >= MAX_DEPTH ? [] : value.map((v) => cutText(v, depth + 1));
  if (!value || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return {};
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = key === "text" && typeof v === "string" && v.length > QA_STEP_TEXT_MAX_CHARS ? v.slice(0, QA_STEP_TEXT_MAX_CHARS) : cutText(v, depth + 1);
  }
  return out;
}

/** At most this many console errors (and as many failed requests) go into a `QaResult`. */
export const QA_RESULT_MAX_DIAGNOSTICS = 20;
/** The recorder remembers this many distinct entries per list (for check evaluation). */
const DIAGNOSTICS_MEMORY = 200;

export interface StepRecorder extends QaFinalSink {
  /** Pass this as `onToolCall`. */
  onToolCall(call: BrowseAgentToolCall): (result: { output?: string; error?: unknown }) => void;
  /** The steps so far in call order. A call that has not ended is not ok. */
  steps(): QaStep[];
  /** The run-level lists for `qaResultOf`: deduped, first-seen order, capped, with dropped counters. Empty lists are absent. */
  extras(): QaRunExtras;
}

/**
 * The trail of a run: one step per tool the model called. It holds what the
 * MODEL asked (tool name and input), not the bridge calls the tool made, and
 * not the session's own pre-open. The fixture is applied outside the model's
 * tools, so its data cannot get here.
 */
export function createStepRecorder(now: () => number = Date.now): StepRecorder {
  // One record per call, in call order: the step, when it started, and whether it is still running.
  const slots: { step: QaStep; started: number; open: boolean }[] = [];
  const consoleErrors = createSeenList(DIAGNOSTICS_MEMORY, QA_RESULT_MAX_DIAGNOSTICS);
  const failedRequests = createSeenList(DIAGNOSTICS_MEMORY, QA_RESULT_MAX_DIAGNOSTICS);
  const checks: QaCheckRecord[] = [];
  return {
    seenConsoleErrors: () => consoleErrors.list(),
    seenFailedRequests: () => failedRequests.list(),
    addChecks(records) {
      checks.push(...records);
    },
    addDiagnostics(d) {
      consoleErrors.add(d.consoleErrors);
      consoleErrors.lose(d.consoleErrorsDropped);
      failedRequests.add(d.failedRequests);
      failedRequests.lose(d.failedRequestsDropped);
    },
    extras() {
      return {
        ...(consoleErrors.list().length > 0 ? { consoleErrors: consoleErrors.kept() } : {}),
        ...(consoleErrors.dropped() > 0 ? { consoleErrorsDropped: consoleErrors.dropped() } : {}),
        ...(failedRequests.list().length > 0 ? { failedRequests: failedRequests.kept() } : {}),
        ...(failedRequests.dropped() > 0 ? { failedRequestsDropped: failedRequests.dropped() } : {}),
        ...(checks.length > 0 ? { checks: [...checks] } : {}),
      };
    },
    onToolCall(call) {
      if (call.preOpen) return () => undefined;
      // The slot is taken when the call starts, so parallel calls keep their order.
      const slot = { step: { index: slots.length + 1, tool: call.toolName, args: cutText(call.input), ok: false, error: "did not finish", ms: 0 } as QaStep, started: now(), open: true };
      slots.push(slot);
      return (result) => {
        const step: QaStep = { index: slot.step.index, tool: call.toolName, args: slot.step.args, ok: true, ms: Math.max(0, now() - slot.started) };
        if (result.error !== undefined) {
          step.ok = false;
          step.error = browseAgentErrorMessage(result.error);
        } else {
          const parsed = parseJsonObject(result.output ?? "");
          harvestDiagnostics(parsed, consoleErrors, failedRequests);
          const error = parsed.error;
          if (typeof error === "string") {
            step.ok = false;
            step.error = browseAgentErrorMessage(error);
          }
        }
        slot.step = step;
        slot.open = false;
      };
    },
    steps() {
      return slots.map((s) => (s.open ? { ...s.step, ms: Math.max(0, now() - s.started) } : s.step));
    },
  };
}
