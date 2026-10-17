// The QA suite: N browse agents in parallel, each in its own browser with its
// own fixture and one scenario (docs/specs/2026-10-17-qa-suite-design.md).
import { z } from "zod";
import { IMAGE_DATA_URL, runBrowseAgent, type BrowseAgentExtraTool } from "../agent/aiSdk.js";
import { boundedCall } from "../fixture/util.js";
import { browseAgentErrorMessage, type BrowseAgentResult } from "../agent/result.js";
import { positiveNumber, singleUseTool } from "../agent/session.js";
import { normalizeScreenshot } from "../policy/schemas.js";
import { checkQaIds } from "./ids.js";
import { createStepRecorder } from "./steps.js";
import type {
  QaBrowser,
  QaOutcome,
  QaScenario,
  QaScenarioReport,
  QaScreenshot,
  QaSuiteReport,
  RunQaSuiteOptions,
} from "./types.js";

const DEFAULT_CONCURRENCY = 3;
/** The final screenshot may take this long. */
const FINAL_SCREENSHOT_MS = 10_000;
const REASON_MAX_CHARS = 500;

export const QA_VERDICT_TOOL = "qa_verdict";

/** The prompt section of a QA run. */
export const QA_PROMPT_SECTION = `You test a web app. The user message is one test scenario: do what it says in the browser, then check the expected result on the page.
When you have checked the result, call \`${QA_VERDICT_TOOL}\` exactly once, at the end. Use verdict \`pass\` when the app behaves as the scenario expects. Use verdict \`fail\` when it does not, and give the reason in one or two sentences: what you expected and what you saw. Base the verdict only on what you saw on the page.
A blocked step (a CAPTCHA, a login wall, a missing page) is not a fail. Do not call \`${QA_VERDICT_TOOL}\` then: explain in your final answer what blocked you.`;

const verdictSchema = z.object({
  verdict: z.enum(["pass", "fail"]).describe('"pass" when the app behaves as the scenario expects, "fail" when it does not.'),
  reason: z.string().trim().min(1).max(REASON_MAX_CHARS).describe("One or two sentences: what you expected and what you saw."),
});

interface Verdict {
  verdict: "pass" | "fail";
  reason: string;
}

/** The run result field that carries the verdict (set by the tool's hooks). */
const VERDICT_FIELD = "qaVerdict";

/**
 * The verdict tool. `singleUseTool` gives it per-run state: a second call is
 * refused by the guard before it runs, and the first success puts the verdict
 * into the run result. A call with bad input is an error and does not use up
 * the one allowed verdict.
 */
function createVerdictTool(): BrowseAgentExtraTool {
  const hooks = singleUseTool({
    name: QA_VERDICT_TOOL,
    isSuccess: (parsed) => parsed.ok === true,
    fields: (parsed) => ({ [VERDICT_FIELD]: { verdict: parsed.verdict, reason: parsed.reason } }),
    doneMessage: (parsed) => `${QA_VERDICT_TOOL} was already called. The first verdict stays: ${String(parsed.verdict)}.`,
  });
  return {
    ...hooks,
    description: "Give the verdict of this test scenario. Call it exactly once, at the end, after you checked the expected result on the page.",
    inputSchema: verdictSchema,
    async execute(input) {
      const parsed = verdictSchema.safeParse(input);
      if (!parsed.success) return JSON.stringify({ error: `${QA_VERDICT_TOOL}: ${parsed.error.issues.map((i) => i.message).join("; ")}` });
      return JSON.stringify({ ok: true, ...parsed.data });
    },
  };
}

function verdictOf(result: BrowseAgentResult): Verdict | undefined {
  const v = result[VERDICT_FIELD] as Partial<Verdict> | undefined;
  return (v?.verdict === "pass" || v?.verdict === "fail") && typeof v.reason === "string" ? { verdict: v.verdict, reason: v.reason } : undefined;
}

function validate(scenarios: QaScenario[], opts: RunQaSuiteOptions): void {
  if (opts.agent?.maxRequests !== undefined) positiveNumber("agent.maxRequests", opts.agent.maxRequests);
  if (opts.agent?.deadlineMs !== undefined) positiveNumber("agent.deadlineMs", opts.agent.deadlineMs);
  const c = opts.concurrency;
  if (c !== undefined && (typeof c !== "number" || Number.isNaN(c) || c < 1)) {
    throw new Error(`runQaSuite: concurrency must be a number of at least 1 (got ${String(c)})`);
  }
  if (!Array.isArray(scenarios) || scenarios.length === 0) throw new Error("runQaSuite: no scenarios");
  checkQaIds(scenarios.map((s) => s?.id), "runQaSuite");
  for (const s of scenarios) {
    if (typeof s.goal !== "string" || s.goal.trim() === "") throw new Error(`runQaSuite: scenario "${s.id}" has an empty goal`);
    if (s.url !== undefined && s.fixture !== undefined) throw new Error(`runQaSuite: scenario "${s.id}" has both url and fixture; put the start URL in the fixture`);
  }
}

/** The error text of an `error` outcome when the run gave none. */
const STATUS_ERRORS: Partial<Record<string, string>> = {
  step_limit: "request limit reached",
  timeout: "deadline reached",
};

function outcomeOf(result: BrowseAgentResult, verdict: Verdict | undefined): QaOutcome {
  if (result.status === "setup_failed") return "setup_failed";
  if (result.status === "aborted") return "aborted";
  if (verdict?.verdict === "pass") return "passed";
  if (verdict?.verdict === "fail") return "failed";
  return result.status === "done" ? "inconclusive" : "error";
}

/** `imageData` (a data URL, or bare base64 as `PlaywrightTarget` gives) as `{ mediaType, base64 }`. Only jpeg, png and webp; anything else gives no screenshot. */
function parseImageData(imageData: unknown): QaScreenshot | undefined {
  const match = typeof imageData === "string" ? IMAGE_DATA_URL.exec(normalizeScreenshot(imageData) ?? "") : null;
  return match ? { mediaType: match[1], base64: match[2] } : undefined;
}

/** The final screenshot of the browser as `{ mediaType, base64 }`. Bounded, and a failure gives undefined. */
async function finalScreenshot(browser: QaBrowser["browser"]): Promise<QaScreenshot | undefined> {
  if (!browser.screenshot) return undefined;
  try {
    const out = await boundedCall(() => browser.screenshot!({}), FINAL_SCREENSHOT_MS);
    if (!out.done) return undefined;
    return parseImageData((out.value as { imageData?: unknown } | null | undefined)?.imageData);
  } catch {
    return undefined;
  }
}

/** Close what `openBrowser` gave, whatever it is. Never throws and never rejects. */
async function closeQuietly(opened: unknown): Promise<void> {
  try {
    await (opened as { close?: () => unknown } | null | undefined)?.close?.();
  } catch {
    // Nothing more to do.
  }
}

function isOpened(value: unknown): value is QaBrowser {
  const v = value as Partial<QaBrowser> | null | undefined;
  return !!v && typeof v === "object" && !!v.browser && typeof v.browser === "object" && typeof v.close === "function";
}

/**
 * Call `openBrowser` so that an abort ends the wait. When the signal wins the
 * race, the browser that arrives later is closed (close errors are ignored)
 * and the result is undefined.
 */
async function openAbortable(scenario: QaScenario, opts: RunQaSuiteOptions): Promise<QaBrowser | undefined> {
  const signal = opts.signal;
  const opening = Promise.resolve().then(() => opts.openBrowser(scenario, { signal }));
  if (!signal) return opening;
  let onAbort!: () => void;
  const aborted = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const winner = await Promise.race([opening, aborted]);
    if (winner || !signal.aborted) return winner;
    // Aborted first. A late browser must not leak, and a bad one must not reject unhandled.
    void opening.then(closeQuietly, () => undefined).catch(() => undefined);
    return undefined;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function runScenario(scenario: QaScenario, opts: RunQaSuiteOptions, now: () => number): Promise<QaScenarioReport> {
  const started = now();
  const base = {
    id: scenario.id,
    ...(scenario.title !== undefined ? { title: scenario.title } : {}),
    goal: scenario.goal,
    startedAt: new Date(started).toISOString(),
  };
  const done = (rest: Omit<QaScenarioReport, keyof typeof base | "durationMs">): QaScenarioReport => ({ ...base, ...rest, durationMs: Math.max(0, now() - started) });
  // The trail is kept outside the try, so a bug guard can still report what happened.
  // The pre-open of `url` is not a tool call of the model, so it is not a step.
  const trail = createStepRecorder(now);

  try {
    if (opts.signal?.aborted) return done({ outcome: "aborted", answer: "", steps: [] });

    let opened: QaBrowser | undefined;
    try {
      opened = await openAbortable(scenario, opts);
    } catch (e) {
      return done({ outcome: "error", answer: "", error: `openBrowser failed: ${browseAgentErrorMessage(e)}`, steps: [] });
    }
    if (!isOpened(opened)) {
      // Not a browser. If the signal fired, the scenario was aborted; else openBrowser is wrong.
      await closeQuietly(opened);
      return opts.signal?.aborted ? done({ outcome: "aborted", answer: "", steps: [] }) : done({ outcome: "error", answer: "", error: "openBrowser returned no browser", steps: [] });
    }
    const qa: QaBrowser = opened;

    try {
      const result = await runBrowseAgent(scenario.goal, {
        ...opts.agent,
        model: opts.model,
        browser: qa.browser,
        ...(scenario.url !== undefined ? { url: scenario.url } : {}),
        ...(scenario.fixture !== undefined ? { fixture: scenario.fixture } : {}),
        ...(scenario.allowNetworkMocks !== undefined ? { allowNetworkMocks: scenario.allowNetworkMocks } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.providerOptions ? { providerOptions: opts.providerOptions } : {}),
        extraTools: { [QA_VERDICT_TOOL]: createVerdictTool() },
        prompt: { principal: "a QA engineer", sections: [QA_PROMPT_SECTION] },
        runId: scenario.id,
        onToolCall: trail.onToolCall,
      });
      const given = verdictOf(result);
      const outcome = outcomeOf(result, given);
      // Not after a timeout: the controller may still hold its lock, and the screenshot would wait for it.
      const screenshot = outcome === "setup_failed" || outcome === "aborted" || result.status === "timeout" ? undefined : await finalScreenshot(qa.browser);
      const error = typeof result.error === "string" ? result.error : outcome === "error" ? STATUS_ERRORS[result.status] ?? `the run ended with status ${result.status}` : undefined;
      return done({
        outcome,
        ...(given ? { verdictReason: given.reason } : {}),
        answer: result.answer,
        status: result.status,
        ...(error !== undefined ? { error } : {}),
        ...(typeof result.setupStage === "string" ? { setupStage: result.setupStage } : {}),
        steps: trail.steps(),
        ...(screenshot ? { screenshot } : {}),
      });
    } finally {
      try {
        await qa.close();
      } catch {
        // A close error does not change the result.
      }
    }
  } catch (e) {
    // runBrowseAgent reports failures as statuses; this is a bug guard. One scenario must never reject the suite.
    return done({ outcome: "error", answer: "", error: browseAgentErrorMessage(e), steps: trail.steps() });
  }
}

/**
 * Run the scenarios in parallel, each in its own browser (`openBrowser`), and
 * return one report in input order. Throws `Error` for an invalid list or
 * option before anything runs; after that it does not reject for a scenario failure.
 */
export async function runQaSuite(scenarios: QaScenario[], opts: RunQaSuiteOptions): Promise<QaSuiteReport> {
  validate(scenarios, opts);
  const now = opts.now ?? Date.now;
  const requested = opts.concurrency === undefined ? DEFAULT_CONCURRENCY : Math.floor(opts.concurrency);
  const concurrency = Math.min(requested, scenarios.length);
  const started = now();

  const reports: QaScenarioReport[] = new Array(scenarios.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < scenarios.length) {
      const i = next++;
      const report = await runScenario(scenarios[i]!, opts, now);
      reports[i] = report;
      try {
        // Fire and forget: a slow or rejecting callback must not hold or break the suite.
        void Promise.resolve(opts.onScenarioDone?.(report)).catch(() => undefined);
      } catch {
        // Progress callback errors are ignored.
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const summary: QaSuiteReport["summary"] = { total: reports.length, passed: 0, failed: 0, inconclusive: 0, error: 0, setup_failed: 0, aborted: 0 };
  for (const r of reports) summary[r.outcome] += 1;
  return {
    startedAt: new Date(started).toISOString(),
    durationMs: Math.max(0, now() - started),
    concurrency,
    summary,
    scenarios: reports,
  };
}
