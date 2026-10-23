// `@sideform/browser-agent/agent/ai-sdk` — runs the browse subagent with the
// AI SDK (v6) on top of the session core. Peer dependency: `ai`.
//
// The model is a plain tool loop: `generateText` with the seven browse tools
// (each has an `execute` that maps onto a `BrowserBridge`), so there is no
// transport and no UI layer. The host owns the model choice, the provider
// routing and the provider options. For the fast mode the model must be a
// NON-reasoning one and reasoning must be off: pass the provider's switch in
// `providerOptions` (for example `{ openrouter: { reasoning: { effort: "none" } } }`
// or the `reasoningEffort` of an OpenAI-compatible provider).
import { generateText, Output, tool, type LanguageModel, type ToolSet } from "ai";
import type { ZodTypeAny } from "zod";
import type { CheckpointResult, PageFixture } from "../fixture/types.js";
import type { BrowserBridge } from "../loop/bridge.js";
import { executeBrowseTool } from "./execute.js";
import {
  buildBrowseAgentPrompt,
  type BuildBrowseAgentPromptOptions,
} from "./prompt.js";
import { boundedCall } from "../fixture/util.js";
import { normalizeScreenshot } from "../shared/image.js";
import {
  QA_ASSERT_TOOL,
  QA_JUDGE_CONTEXT_MAX_CHARS,
  QA_JUDGE_PAGE_MAX_CHARS,
  QA_JUDGE_SYSTEM,
  QA_JUDGE_TIMEOUT_MS,
  QA_VERDICT_FIELD,
  QA_VERDICT_TOOL,
  applyFinalChecks,
  applyQaJudge,
  buildQaJudgePrompt,
  createStepRecorder,
  executeQaAssert,
  executeQaVerdict,
  finalChecksApply,
  judgePageOf,
  parseQaJudgeVerdict,
  parseQaChecks,
  qaJudgeApplies,
  qaJudgeError,
  qaResultOf,
  qaVerdictHooks,
  runFinalChecks,
  type QaCheck,
  type QaJudgePage,
  type QaJudgeResult,
  type QaResult,
} from "./qaCore.js";
import { qaAssertDefinition, qaJudgeSchema, qaVerdictDefinition } from "./qa.js";
import { mergeCarriedDialogs } from "../shared/dialogs.js";
import { createBrowseTraceRecorder, type BrowseTraceRecorder } from "./traceRecorder.js";
import type { BrowseTrace } from "../shared/trace.js";
import { createRunCheckpoint } from "./checkpoint.js";
import { createFixtureSetup, unmatchedMocks } from "./fixtureSetup.js";
import { browseAgentErrorMessage, type BrowseAgentMessage, type BrowseAgentMessagePart, type BrowseAgentResult } from "./result.js";
import {
  createBrowseAgentSession,
  parseJsonObject,
  type BrowseAgentExtraToolHooks,
  type BrowseAgentSession,
  type BrowseAgentToolCall,
} from "./session.js";
import {
  BROWSE_AGENT_TOOL_NAMES,
  browseToolDefinitions,
  type BrowseToolDefinitions,
} from "./tools.js";

/** A host tool the model may call next to the seven browse tools. */
export interface BrowseAgentExtraTool extends BrowseAgentExtraToolHooks {
  description: string;
  inputSchema: ZodTypeAny;
  /** Runs the call. Returns the result string (JSON by convention). */
  execute(input: unknown, ctx: { toolCallId: string; signal: AbortSignal }): Promise<string>;
}

/** The final QA screenshot may take this long. */
const QA_SCREENSHOT_MS = 10_000;
/** Each page read for the QA judge may take this long. */
const QA_JUDGE_READ_MS = 10_000;
/** The largest delay `AbortSignal.timeout` accepts (a 32-bit signed integer of ms). */
const QA_JUDGE_TIMEOUT_MAX_MS = 2_147_483_647;
/** The host's `onScreenshot` may take this long. */
const QA_SCREENSHOT_CALLBACK_MS = 15_000;

/** The screenshot of a trace step may take this long (the recorder's own timeout is shorter and stops waiting first). */
const TRACE_CAPTURE_MS = 10_000;
/** The host's `onTrace` may take this long. */
const TRACE_CALLBACK_MS = 15_000;

/** The host's `onCapture` may take this long before the result is returned without it. */
const CHECKPOINT_CALLBACK_MS = 15_000;
/** Longest the run end waits for `clearActEmulation`. */
const ACT_EMULATION_CLEAR_MS = 5_000;

/** `qa.judge` of `runBrowseAgent`. */
export interface QaJudgeOptions {
  /** The judge model. Any AI SDK `LanguageModel` that supports structured output. */
  model: LanguageModel;
  /** App vocabulary: screen names, menu names, domain terms. Only the judge reads it. Max 16 KiB. */
  context?: string;
  /** Provider options for the judge request. */
  providerOptions?: Record<string, Record<string, unknown>>;
  /** Deadline of the judge request in ms. An integer from 1 to 2147483647. Default 60_000. It is its own budget, outside `deadlineMs`. */
  timeoutMs?: number;
}

export interface RunBrowseAgentOptions {
  /** The chat model. Use a non-reasoning model, or switch reasoning off in `providerOptions`. */
  model: LanguageModel;
  /** The browser. `controllerBridge(controller)` from `adapters/controller-bridge` fits. */
  browser: BrowserBridge;
  /** Start URL: the browser opens it before the first request. */
  url?: string;
  /**
   * Page state to prepare before the first request (cookies, storage, start
   * URL, extra tabs, setup steps; see `@sideform/browser-agent/fixture`). The
   * browser applies it through `browser.applyFixture`, then the run takes a
   * snapshot. The model gets a summary with counts only: never a cookie or a
   * storage key or value. Counts as one step. A bridge without `applyFixture`
   * gives status `setup_failed`, and so does a failed apply (the stage is in
   * `result.setupStage`; the model never runs). `url` and `fixture` together are
   * an error. When the browser's apply returned a `fixtureToken`, the run calls
   * `browser.releaseFixture(token)`
   * at the end, in every outcome.
   */
  fixture?: PageFixture;
  /**
   * Host gate for `fixture.network`. Without it a fixture with network mocks
   * fails with status `setup_failed` (stage "network"). The mocks are removed
   * when the run ends, in every outcome. Default false.
   */
  allowNetworkMocks?: boolean;
  /**
   * Take a checkpoint of the browser (docs/specs/2026-10-16-checkpoint-design.md):
   * the browser records the agent's state-changing actions from before the
   * setup or start URL. When the run ends (any status except `setup_failed` and `aborted`, and not when no browser command ran),
   * `onCapture` is called ONCE with a `CheckpointResult`: a `PageFixture` that
   * `applyFixture` rebuilds, or `{ ok: false, error }`. A browser without
   * `startJournal`, `stopJournal` and `captureCheckpoint` gives
   * `{ ok: false, error }`, not a failed run. `origins` limits the cookies and
   * storage of the base state (default: the base page's origin). The checkpoint
   * holds secrets, so it reaches the host ONLY through this callback: it is not a
   * field of the result, and `JSON.stringify(result)` cannot leak it. A throw or a
   * rejection in `onCapture` is ignored; an async callback is awaited for at most 15 s. The journal is
   * stopped when the run ends, in every outcome; the result waits for the stop at most 2 s.
   */
  checkpoint?: { origins?: string[]; onCapture(result: CheckpointResult): void | Promise<void> };
  /** Aborts the run (status `aborted`). */
  signal?: AbortSignal;
  /** Provider options for every request (the reasoning switch goes here). */
  providerOptions?: Record<string, Record<string, unknown>>;
  /** Host tools, allowed for this run. */
  extraTools?: Record<string, BrowseAgentExtraTool>;
  /** The system prompt: a full string, or options for `buildBrowseAgentPrompt`. */
  prompt?: string | BuildBrowseAgentPromptOptions;
  /** Tool definitions (descriptions and schemas). Default `browseToolDefinitions`.
   * A host with its own text builds them with `createBrowseToolDefinitions(slots)`. */
  toolDefinitions?: BrowseToolDefinitions;
  /** Set false to leave out `browse_screenshot` (a model that cannot read images). Default true. */
  screenshots?: boolean;
  /**
   * Give the screenshot to the model as an image part of the tool result.
   * Default false: the result is text only (the JSON without `imageData`, plus
   * a note that an image was taken but is not attached). Turn it on ONLY for a
   * provider whose AI SDK integration carries tool-result images natively
   * (for example `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`).
   * OpenAI-compatible providers (`@ai-sdk/openai-compatible`, OpenRouter
   * through it) turn the part into JSON text, so the base64 would land in the
   * prompt of every later request.
   */
  toolResultImages?: boolean;
  /** Max model requests. Default `BROWSE_AGENT_MAX_REQUESTS`. */
  maxRequests?: number;
  /** Own deadline in ms. Default `BROWSE_AGENT_DEADLINE_MS`. */
  deadlineMs?: number;
  /** Id of the run, for the pre-open call id and tracing. Default "browse_agent". */
  runId?: string;
  /** Max output tokens per request. */
  maxOutputTokens?: number;
  /**
   * QA mode (docs/specs/2026-10-17-qa-suite-design.md). The model gets the
   * `qa_verdict` tool, and the result gets a `qa` field:
   * `{ outcome, verdict?, reason?, steps, stepsDropped? }` (an extra field, so it
   * comes before `error` in `JSON.stringify(result)`). `steps` is the model's tool
   * calls (the last 30), taken from the `onToolCall` mechanism; your own
   * `onToolCall` is still called. The prompt: with `prompt` unset or an options
   * object, `buildBrowseAgentPrompt({ ...prompt, qa: true })` builds it: principal "a QA
   * engineer" (unless you set one), a QA irreversible-step rule, the QA section after
   * your sections, and a closing that names `qa_verdict`. With `prompt` as a string
   * the text is yours and is NOT touched: include `QA_PROMPT_SECTION` and end with
   * `QA_AGENT_CLOSING`. Use `qa: true` or `qa: { onScreenshot }`.
   * `onScreenshot` gets the final screenshot (jpeg, png or webp). It is TAKEN once at
   * the end, before the fixture release, bounded to 10 s; the callback runs after the release
   * and the journal stop, so a slow callback holds neither the mocks nor the browser. It is never put into
   * the result. Not taken for `setup_failed`, `aborted` or `timeout`. A throw or
   * a rejection in it is ignored; an async callback is awaited for at most 15 s.
   * The run ends right after a successful `qa_verdict` (no more model request), so the final
   * answer text can be empty; the verdict reason is in `qa`. With `qa` on, a host extra tool
   * named `qa_verdict` makes the call throw (before any browser command), and result fields
   * named `qa` or `qaVerdict` from a host tool's `end` hook are dropped.
   * The model also gets `qa_assert` (exact checks on the page, not single-use; it does not end
   * the run, and a failed check does not change the outcome). Each call is recorded in
   * `qa.checks` with source "agent". `qa.checks`: final checks (`QaCheck[]`) the host runs ONCE
   * after the loop, through `browser.assert`, when the outcome is `passed`, `failed` or
   * `inconclusive` (not for `setup_failed`, `aborted`, `error`). They are recorded with source
   * "final"; a `passed` run with a failed final check becomes `failed` (see `applyFinalChecks`).
   * Invalid `checks` make the call throw before any browser command. With `qa` on, a host extra
   * tool named `qa_assert` makes the call throw too. The result's `qa` also lists the console
   * errors and failed requests the run saw (`consoleErrors`, `failedRequests`, deduped, at most 20).
   * `qa.judge`: a second model reviews a `passed` outcome (docs/specs/2026-10-19-qa-judge-design.md).
   * It runs once after the loop and the final checks, and only when the outcome is
   * `passed` (not for `failed`, `inconclusive`, `error`, `setup_failed`, `aborted`).
   * It sees the scenario (`goal`), your `context`, the steps (without `qa_verdict`), the checks, the console errors
   * and failed requests, and the final page (URL, title, text). It does not see the acting
   * model's text, reasoning or verdict. `model` must support structured output. `context` is your app vocabulary
   * (screen names, menu names, terms): only the judge reads it, at most 16 KiB, else the call throws before any
   * browser command. `timeoutMs` (an integer from 1 to 2147483647 ms, default 60 s) bounds the judge request.
   * The judge can only lower the outcome:
   * `fail` makes it `failed`, `inconclusive` makes it `inconclusive`, with reason `Judge: <reason>. Agent verdict: <reason>`.
   * The page (final URL, title, full page text from `browse_read`, with `browse_snapshot` as the fallback) is read while
   * the page is live. The model request starts then, but the run does not wait for it before the QA screenshot, the
   * checkpoint capture and the fixture release: the result waits for the judge after those. The request has its own
   * budget `timeoutMs`, outside `deadlineMs`. An abort of `signal` before or during the judge gives `judge: { error }`
   * and leaves the outcome as it was.
   * `qa.judge` in the result holds the judge's answer. A judge error (timeout, provider error, invalid answer, failed
   * page read) does not fail the run: the outcome stays `passed` and `qa.judge` is `{ error }`. You decide whether
   * a pass without a working judge counts. Without `qa.judge` nothing changes.
   * To run several scenarios in parallel, call `runBrowseAgent` several times,
   * each with its own browser: the package does not orchestrate.
   */
  qa?:
    | boolean
    | {
        onScreenshot?(img: { mediaType: string; base64: string }): void | Promise<void>;
        checks?: QaCheck[];
        judge?: QaJudgeOptions;
      };
  /**
   * Record the run as a trace (docs/specs/2026-10-20-browse-run-trace-design.md).
   * When the run has ended, `onTrace` is called ONCE with a `BrowseTrace`: steps with timing and redacted args,
   * a screenshot after `browse_open`, `browse_act` and `browse_tabs` calls (taken with `browser.screenshot`,
   * bounded to 4 s; a failure gives no frame; after one timeout no more step screenshots; none after an abort),
   * every `browse_screenshot` result as a frame, console errors and failed requests. In QA mode the final
   * screenshot is added as a "final" frame (the same image `qa.onScreenshot` gets; it is taken once). The trace is
   * NOT a field of the result: `JSON.stringify(result)`, the string for the model, cannot carry it. The host stores it
   * (`splitTraceAssets` moves the frames out). It comes after the fixture release and the journal stop, like
   * `qa.onScreenshot`: a throw or a rejection is ignored; an async callback is awaited for at most 15 s. It is not
   * called when the run throws. `labels` are free-form host labels. `capture: false` records no step frames and no
   * final frame. Without `browser.screenshot` the trace has no step frames.
   */
  trace?: { labels?: Record<string, string>; capture?: boolean; onTrace?(trace: BrowseTrace): void | Promise<void> };
  /**
   * Observe every tool execution: the browse tools and the host tools, also the
   * pre-open of `url` (`call.preOpen` is true; the id is `${runId}:open`). Called when the
   * execution STARTS with the model's tool name and input; the function it
   * returns (if any) is called once when it ends, with the result string or
   * with the error that was thrown. Calls the guard refuses or the allow-list
   * rejects never start, so they are not reported. A throw in the hook or in
   * the returned function is ignored. Use it for a trail of what the model did.
   */
  onToolCall?(call: BrowseAgentToolCall): ((result: { output?: string; error?: unknown }) => void) | void;
}

/** Matches an image data URL: group 1 is the media type, group 2 the base64. */
export const IMAGE_DATA_URL = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/;

type ModelOutput =
  | { type: "content"; value: ({ type: "text"; text: string } | { type: "image-data"; data: string; mediaType: string })[] }
  | { type: "text"; value: string };

/**
 * `browse_screenshot` results carry the picture as a data URL in `imageData`.
 * Default (`attachImage` false): text only. `imageData` is removed from the
 * JSON and `imageNote` says an image was taken but is not attached, so the
 * base64 never reaches a provider that would print it into the prompt. With
 * `attachImage: true`, the picture becomes an image part and the rest of the
 * JSON stays text, so the model sees the picture and the element table.
 */
export function screenshotToModelOutput(output: unknown, opts: { attachImage?: boolean } = {}): ModelOutput {
  const raw = typeof output === "string" ? output : JSON.stringify(output);
  const parsed = parseJsonObject(raw);
  if (typeof parsed.imageData !== "string") return { type: "text", value: raw };
  const { imageData, ...rest } = parsed;
  const match = IMAGE_DATA_URL.exec(imageData);
  if (opts.attachImage && match) {
    return {
      type: "content",
      value: [
        { type: "text", text: JSON.stringify(rest) },
        { type: "image-data", data: match[2], mediaType: match[1] },
      ],
    };
  }
  return {
    type: "text",
    value: JSON.stringify({ ...rest, imageNote: "A screenshot was taken but the image is not attached to this result. Use annotate: true for the element table, or browse_snapshot." }),
  };
}

function buildTools(
  session: BrowseAgentSession,
  opts: RunBrowseAgentOptions,
  defs: BrowseToolDefinitions,
  names: readonly string[],
  extras: Record<string, BrowseAgentExtraTool>,
): ToolSet {
  const tools: ToolSet = {};
  for (const name of names) {
    const def = defs[name as keyof BrowseToolDefinitions];
    tools[name] = tool({
      description: def.description,
      inputSchema: def.inputSchema as never,
      execute: (input: unknown, { toolCallId }: { toolCallId: string }) => session.runTool({ toolName: name, input, toolCallId }),
      ...(name === "browse_screenshot" ? { toModelOutput: ({ output }: { output: unknown }) => screenshotToModelOutput(output, { attachImage: opts.toolResultImages === true }) } : {}),
    } as never);
  }
  for (const [name, extra] of Object.entries(extras)) {
    tools[name] = tool({
      description: extra.description,
      inputSchema: extra.inputSchema as never,
      execute: (input: unknown, { toolCallId }: { toolCallId: string }) => session.runTool({ toolName: name, input, toolCallId }),
    } as never);
  }
  return tools;
}

/** The result fields QA mode owns. A host tool's `end` cannot set them. */
const QA_RESERVED_FIELDS: readonly string[] = ["qa", QA_VERDICT_FIELD];

/** A copy of the hooks whose `end` cannot set QA fields. Applies to forked copies too. */
function reservedFieldsDropped(hooks: BrowseAgentExtraToolHooks): BrowseAgentExtraToolHooks {
  const end = hooks.end?.bind(hooks);
  const fork = hooks.fork?.bind(hooks);
  return {
    guard: hooks.guard?.bind(hooks),
    begin: hooks.begin?.bind(hooks),
    endsRun: hooks.endsRun?.bind(hooks),
    end: end
      ? (output) => {
          const fields = end(output);
          return fields ? Object.fromEntries(Object.entries(fields).filter(([k]) => !QA_RESERVED_FIELDS.includes(k))) : fields;
        }
      : undefined,
    fork: fork ? () => reservedFieldsDropped(fork()) : undefined,
  };
}

/** A normalized page screenshot: a data URL (jpeg, png or webp), the size when known, and the JS dialogs the command drained. Bounded; undefined for anything else. Never throws. */
async function takeScreenshot(browser: BrowserBridge, ms: number): Promise<{ imageData: string; width?: number; height?: number; dialogs?: unknown[] } | undefined> {
  if (!browser.screenshot) return undefined;
  try {
    const out = await boundedCall(() => browser.screenshot!({}), ms);
    if (!out.done) return undefined;
    const value = out.value as { imageData?: string; width?: unknown; height?: unknown; dialogs?: unknown } | null | undefined;
    const imageData = normalizeScreenshot(value?.imageData);
    if (!imageData) return undefined;
    return {
      imageData,
      ...(typeof value?.width === "number" ? { width: value.width } : {}),
      ...(typeof value?.height === "number" ? { height: value.height } : {}),
      ...(Array.isArray(value?.dialogs) && value.dialogs.length > 0 ? { dialogs: value.dialogs } : {}),
    };
  } catch {
    return undefined;
  }
}

/** The final QA image: after a timeout the controller may still hold its lock, so no image then. */
async function captureQaScreenshot(browser: BrowserBridge, status: string): Promise<string | undefined> {
  if (status === "setup_failed" || status === "aborted" || status === "timeout") return undefined;
  return (await takeScreenshot(browser, QA_SCREENSHOT_MS))?.imageData;
}

/** One tool call, bounded. The result string, or undefined when it failed or ran out of time. */
async function boundedTool(opts: RunBrowseAgentOptions, name: string, args: Record<string, unknown>): Promise<string | undefined> {
  try {
    const out = await boundedCall(() => executeBrowseTool(opts.browser, name, args), QA_JUDGE_READ_MS);
    return out.done ? out.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads the final page for the judge. Never throws: a failure is `{ error }`. One command at a time (the controller
 * serializes them): `browse_read` first, `browse_snapshot` only when the read gave no text or no URL.
 */
async function readJudgePage(opts: RunBrowseAgentOptions): Promise<QaJudgePage | { error: string }> {
  if (opts.signal?.aborted) return { error: "aborted" };
  try {
    // The controller clamps the read to the same cap, and its `truncated` flag says when text was left out.
    const read = await boundedTool(opts, "browse_read", { maxChars: QA_JUDGE_PAGE_MAX_CHARS });
    const parsed = read === undefined ? {} : parseJsonObject(read);
    const complete = typeof parsed.text === "string" && parsed.text !== "" && typeof parsed.url === "string" && parsed.url !== "";
    const snapshot = complete ? undefined : await boundedTool(opts, "browse_snapshot", {});
    return judgePageOf(read, snapshot);
  } catch (error) {
    return qaJudgeError(error);
  }
}

/** Starts the judge request. The returned promise never rejects: a failure is `{ error }`. */
async function askJudge(goal: string, qa: QaResult, page: QaJudgePage, judge: QaJudgeOptions, signals: (AbortSignal | undefined)[]): Promise<QaJudgeResult> {
  try {
    const timeout = AbortSignal.timeout(judge.timeoutMs ?? QA_JUDGE_TIMEOUT_MS);
    const { output: object } = await generateText({
      model: judge.model,
      output: Output.object({ schema: qaJudgeSchema }),
      system: QA_JUDGE_SYSTEM,
      prompt: buildQaJudgePrompt({ scenario: goal, ...(judge.context ? { context: judge.context } : {}), qa, page }),
      providerOptions: judge.providerOptions as never,
      abortSignal: AbortSignal.any([timeout, ...signals.filter((s): s is AbortSignal => s !== undefined)]),
    });
    // The schema has no length cap: the hand parser cuts a long reason.
    const parsed = parseQaJudgeVerdict(object);
    return parsed.ok ? parsed.value : { error: browseAgentErrorMessage(`invalid judge answer: ${parsed.errors.join("; ")}`) };
  } catch (error) {
    return qaJudgeError(error);
  }
}

/**
 * Run a browse task with a non-reasoning chat model driving the browse tools.
 * Resolves to the run result (never rejects for a model or browser failure:
 * those are statuses). `JSON.stringify(result)` is the string Pen Editor
 * returns to its main model.
 *
 * Status: `done` (the model gave its final answer), `step_limit` (request cap),
 * `timeout` (own deadline), `aborted` (`signal`), `error` (model or transport error).
 */
export async function runBrowseAgent(goal: string, opts: RunBrowseAgentOptions): Promise<BrowseAgentResult> {
  const defs = opts.toolDefinitions ?? browseToolDefinitions;
  const baseTools = BROWSE_AGENT_TOOL_NAMES.filter((n) => opts.screenshots !== false || n !== "browse_screenshot");
  const qaOn = opts.qa !== undefined && opts.qa !== false;
  const onScreenshot = typeof opts.qa === "object" ? opts.qa.onScreenshot : undefined;
  if (qaOn && opts.extraTools?.[QA_VERDICT_TOOL]) throw new Error(`runBrowseAgent: qa mode owns the tool name ${QA_VERDICT_TOOL}; rename your extra tool.`);
  if (qaOn && opts.extraTools?.[QA_ASSERT_TOOL]) throw new Error(`runBrowseAgent: qa mode owns the tool name ${QA_ASSERT_TOOL}; rename your extra tool.`);
  const rawFinalChecks = typeof opts.qa === "object" && opts.qa.checks && opts.qa.checks.length > 0 ? opts.qa.checks : undefined;
  let finalChecks: QaCheck[] | undefined; // the parsed checks: an inferred `type` is carried
  if (rawFinalChecks) {
    const parsedChecks = parseQaChecks(rawFinalChecks);
    if (!parsedChecks.ok) throw new Error(`runBrowseAgent: qa.checks: ${parsedChecks.errors.join("; ")}`);
    finalChecks = parsedChecks.value;
  }
  const judge = typeof opts.qa === "object" ? opts.qa.judge : undefined;
  if (judge) {
    if (!judge.model) throw new Error("runBrowseAgent: qa.judge.model: required");
    if (judge.timeoutMs !== undefined && !(Number.isInteger(judge.timeoutMs) && judge.timeoutMs >= 1 && judge.timeoutMs <= QA_JUDGE_TIMEOUT_MAX_MS)) {
      throw new Error(`runBrowseAgent: qa.judge.timeoutMs: must be an integer from 1 to ${QA_JUDGE_TIMEOUT_MAX_MS}`);
    }
    if (judge.context !== undefined && (typeof judge.context !== "string" || judge.context.length > QA_JUDGE_CONTEXT_MAX_CHARS)) {
      throw new Error(`runBrowseAgent: qa.judge.context: must be a string of at most ${QA_JUDGE_CONTEXT_MAX_CHARS} characters`);
    }
  }
  const trail = qaOn ? createStepRecorder() : undefined;
  const traceCapture = opts.trace !== undefined && opts.trace.capture !== false && !!opts.browser.screenshot;
  const recorder: BrowseTraceRecorder | undefined = opts.trace
    ? createBrowseTraceRecorder({
        goal,
        ...(opts.trace.labels ? { labels: opts.trace.labels } : {}),
        ...(traceCapture ? { capture: () => takeScreenshot(opts.browser, TRACE_CAPTURE_MS) } : {}),
        ...(opts.browser.requests ? { requests: () => opts.browser.requests!() } : {}),
      })
    : undefined;
  const extras: Record<string, BrowseAgentExtraTool> = {
    ...opts.extraTools,
    ...(qaOn && trail
      ? {
          [QA_VERDICT_TOOL]: { ...qaVerdictHooks(), ...qaVerdictDefinition, execute: async (input: unknown) => executeQaVerdict(input) },
          [QA_ASSERT_TOOL]: { ...qaAssertDefinition, execute: async (input: unknown) => executeQaAssert(input, opts.browser, trail) },
        }
      : {}),
  };
  const executeTool = async (call: BrowseAgentToolCall, ctx: { signal: AbortSignal }) => {
    // Observers must not change the run: a throw in one is ignored.
    const finishers: ((result: { output?: string; error?: unknown }) => void)[] = [];
    for (const observe of [trail?.onToolCall, opts.onToolCall]) {
      try {
        const f = observe?.(call);
        if (typeof f === "function") finishers.push(f);
      } catch {
        // Ignored.
      }
    }
    // The recorder's end is async (the step frame): it is awaited before the result goes back. It never rejects.
    let traceEnd: ReturnType<BrowseTraceRecorder["onToolCall"]> | undefined;
    try {
      traceEnd = recorder?.onToolCall(call, { signal: ctx.signal });
    } catch {
      // Ignored.
    }
    const ended = (result: { output?: string; error?: unknown }) => {
      for (const f of finishers) {
        try {
          f(result);
        } catch {
          // Ignored.
        }
      }
    };
    try {
      const extra = extras[call.toolName];
      const output = extra
        ? await extra.execute(call.input, { toolCallId: call.toolCallId, signal: ctx.signal })
        : await executeBrowseTool(opts.browser, call.toolName, call.input);
      ended({ output });
      // The trace screenshot drained the page's JS dialogs: the model gets them in this output, as without tracing.
      const carried = await traceEnd?.({ output }).catch(() => undefined);
      return carried?.dialogs ? mergeCarriedDialogs(output, carried.dialogs) : output;
    } catch (error) {
      ended({ error });
      await traceEnd?.({ error }).catch(() => undefined);
      throw error;
    }
  };
  const session = createBrowseAgentSession({
    signal: opts.signal,
    deadlineMs: opts.deadlineMs,
    maxRequests: opts.maxRequests,
    baseTools,
    extraTools: Object.fromEntries(Object.entries(extras).map(([n, e]) => [n, qaOn && n !== QA_VERDICT_TOOL && n !== QA_ASSERT_TOOL ? reservedFieldsDropped(e) : { guard: e.guard?.bind(e), begin: e.begin?.bind(e), endsRun: e.endsRun?.bind(e), end: e.end?.bind(e), fork: e.fork?.bind(e) }])),
    executeTool,
  });

  const system =
    typeof opts.prompt === "string"
      ? opts.prompt
      : buildBrowseAgentPrompt(
          qaOn ? { ...opts.prompt, qa: true } : opts.prompt,
        );
  // One assistant message, like the UI message the tool loop builds in a chat.
  const parts: BrowseAgentMessagePart[] = [];
  const messages: BrowseAgentMessage[] = [{ role: "assistant", parts }];
  // The release covers the token of THIS run's apply only, also when the apply resolves after the run ended.
  const fixtureSetup = opts.fixture
    ? createFixtureSetup(opts.browser, opts.fixture, {
        allowNetworkMocks: opts.allowNetworkMocks === true,
        snapshot: () => executeBrowseTool(opts.browser, "browse_snapshot", {}),
      })
    : undefined;

  const checkpoint = createRunCheckpoint(opts.browser, {
    enabled: !!opts.checkpoint,
    signal: opts.signal,
    ...(opts.checkpoint?.origins ? { origins: opts.checkpoint.origins } : {}),
  });
  const onCapture = opts.checkpoint?.onCapture;
  let finalStatus: { status: string; steps: number } = { status: "error", steps: 0 };
  let shot: string | undefined;
  // Set on every path of the try block (tsc checks it). It is awaited after the `finally` work, so a judge request does not delay that work.
  let finish: () => Promise<BrowseAgentResult>;
  // Stops a started judge request when the `finally` work throws: nobody awaits it then.
  const judgeAbort = new AbortController();

  try {
    // Before the setup or the start URL: the journal must see the page the run starts on.
    await checkpoint.begin();
    const result = await session.run(
      goal,
      {
        async send(text) {
          await generateText({
            model: opts.model,
            system,
            prompt: text,
            tools: buildTools(session, opts, defs, [...baseTools], extras),
            // Called after a step that ended with tool results. False ends the loop.
            stopWhen: () => !session.continueRequest(),
            abortSignal: session.signal,
            providerOptions: opts.providerOptions as never,
            maxOutputTokens: opts.maxOutputTokens,
            onStepFinish: (step) => {
              for (const part of step.content) {
                if (part.type === "text") parts.push({ type: "text", text: part.text });
                else if (part.type === "tool-call") parts.push({ type: `tool-${part.toolName}` });
              }
            },
          });
        },
        stop() {
          // The abort signal given to generateText stops the request.
        },
        messages: () => messages,
      },
      {
        url: opts.url,
        toolCallId: opts.runId,
        ...(fixtureSetup ? { setup: fixtureSetup.setup } : {}),
      },
    );
    finalStatus = result;
    if (!trail) {
      finish = async () => result;
    } else {
      // `qa` is an extra field: it goes before `error` and `setupStage`, and the verdict field is folded into it.
      const { error, setupStage, [QA_VERDICT_FIELD]: _verdict, ...rest } = result;
      let qa = qaResultOf(result, trail.steps(), trail.extras(), trail.lastAgentCall());
      if (finalChecks && finalChecksApply(qa)) {
        // The mocks live until the release in `finally`. The checks run bounded; a failure to run them fails every check.
        const finalResults = await runFinalChecks(opts.browser, finalChecks, trail);
        // The final assert drained more errors into the recorder: refresh the run-level lists (the steps did not change).
        qa = applyFinalChecks({ ...qa, ...trail.extras() }, finalResults);
      }
      const withUnmatchedMocks = (q: QaResult): QaResult => {
        const unmatched = unmatchedMocks(fixtureSetup?.mockHits());
        return unmatched.length > 0 ? { ...q, unmatchedMocks: unmatched } : q;
      };
      const assemble = (q: QaResult) =>
        ({
          ...rest,
          // Read at assembly time, after the release in `finally` has handed the mocks' hit counts over.
          qa: withUnmatchedMocks(q),
          ...(error !== undefined ? { error } : {}),
          ...(setupStage !== undefined ? { setupStage } : {}),
        }) as BrowseAgentResult;
      if (judge && qaJudgeApplies(qa)) {
        // The evidence is read while the mocks live and the page is as the run left it. The model request is NOT awaited
        // here: the `finally` work (screenshot, capture, release) must not wait for it. `job` never rejects.
        const page = await readJudgePage(opts);
        const job: Promise<QaJudgeResult> = "error" in page ? Promise.resolve(page) : askJudge(goal, qa, page, judge, [opts.signal, judgeAbort.signal]);
        const judged = qa;
        finish = async () => assemble(applyQaJudge(judged, await job));
      } else {
        const plain = qa;
        finish = async () => assemble(plain);
      }
    }
  } finally {
    try {
      // Capture conditions live in the helper. The order is capture, host callback, fixture release (the mocks live
      // until the task ends, whatever the outcome), stop. The stop wait is bounded, so a hung browser cannot hold a finished run.
      await checkpoint.finish(finalStatus, {
        async beforeStop(captured) {
          try {
            // The final image first: the fixture's mocks are still live, and the page is as the run left it.
            // The host callback waits until the release and the stop are done.
            if (onScreenshot || (recorder && qaOn && traceCapture)) shot = await captureQaScreenshot(opts.browser, finalStatus.status);
            // A rejecting async callback must not become an unhandled rejection; a slow one is awaited for a bounded time only.
            if (captured && onCapture) await boundedCall(() => onCapture(captured), CHECKPOINT_CALLBACK_MS).catch(() => undefined);
            await fixtureSetup?.release();
          } finally {
            // The emulation of browse_act `viewport` must not outlive the run, with or without a fixture.
            await boundedCall(async () => opts.browser.clearActEmulation?.(), ACT_EMULATION_CLEAR_MS).catch(() => undefined);
          }
        },
      });
      const match = shot && onScreenshot ? IMAGE_DATA_URL.exec(shot) : null;
      if (match && onScreenshot) {
        const img = { mediaType: match[1]!, base64: match[2]! };
        // A throw or a rejection is ignored; a slow callback is awaited for a bounded time only.
        await boundedCall(() => onScreenshot(img), QA_SCREENSHOT_CALLBACK_MS).catch(() => undefined);
      }
    } catch (error) {
      judgeAbort.abort();
      // Rethrown on purpose, as before the judge existed: a failing `finally` work replaces the outcome of the try block.
      // eslint-disable-next-line no-unsafe-finally
      throw error;
    }
  }
  const result = await finish();
  if (recorder) {
    if (shot && qaOn && traceCapture) recorder.addFrame({ imageData: shot, kind: "final" });
    await recorder.flush(opts.signal);
    const trace: BrowseTrace = recorder.finish({
      status: result.status,
      answer: result.answer,
      ...(typeof result.error === "string" ? { error: result.error } : {}),
      ...(result.qa ? { qa: result.qa } : {}),
    });
    const onTrace = opts.trace?.onTrace;
    if (onTrace) await boundedCall(() => onTrace(trace), TRACE_CALLBACK_MS).catch(() => undefined);
  }
  return result;
}
