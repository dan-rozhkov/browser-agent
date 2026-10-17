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
import { generateText, tool, type LanguageModel, type ToolSet } from "ai";
import type { ZodTypeAny } from "zod";
import type { CheckpointResult, PageFixture } from "../fixture/types.js";
import type { BrowserBridge } from "../loop/bridge.js";
import { executeBrowseTool } from "./execute.js";
import {
  buildBrowseAgentPrompt,
  type BuildBrowseAgentPromptOptions,
} from "./prompt.js";
import { boundedCall } from "../fixture/util.js";
import { normalizeScreenshot } from "../policy/schemas.js";
import {
  QA_PRINCIPAL,
  QA_PROMPT_SECTION,
  QA_VERDICT_FIELD,
  QA_VERDICT_TOOL,
  createStepRecorder,
  executeQaVerdict,
  qaResultOf,
  qaVerdictDefinition,
  qaVerdictHooks,
} from "./qa.js";
import { createRunCheckpoint } from "./checkpoint.js";
import { createFixtureSetup } from "./fixtureSetup.js";
import { type BrowseAgentMessage, type BrowseAgentMessagePart, type BrowseAgentResult } from "./result.js";
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
/** The host's `onScreenshot` may take this long. */
const QA_SCREENSHOT_CALLBACK_MS = 15_000;

/** The host's `onCapture` may take this long before the result is returned without it. */
const CHECKPOINT_CALLBACK_MS = 15_000;

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
   * object, the principal is "a QA engineer" (unless you set one) and the QA
   * section is added. With `prompt` as a string the text is yours and is NOT
   * touched: include `QA_PROMPT_SECTION` in it. Use `qa: true` or `qa: { onScreenshot }`.
   * `onScreenshot` gets the final screenshot (jpeg, png or webp). It is TAKEN once at
   * the end, before the fixture release, bounded to 10 s; the callback runs after the release
   * and the journal stop, so a slow callback holds neither the mocks nor the browser. It is never put into
   * the result. Not taken for `setup_failed`, `aborted` or `timeout`. A throw or
   * a rejection in it is ignored; an async callback is awaited for at most 15 s.
   * The run ends right after a successful `qa_verdict` (no more model request), so the final
   * answer text can be empty; the verdict reason is in `qa`. With `qa` on, a host extra tool
   * named `qa_verdict` makes the call throw (before any browser command), and result fields
   * named `qa` or `qaVerdict` from a host tool's `end` hook are dropped.
   * To run several scenarios in parallel, call `runBrowseAgent` several times,
   * each with its own browser: the package does not orchestrate.
   */
  qa?: boolean | { onScreenshot?(img: { mediaType: string; base64: string }): void | Promise<void> };
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

function reservedFieldsDropped(end: BrowseAgentExtraToolHooks["end"]): BrowseAgentExtraToolHooks["end"] {
  if (!end) return undefined;
  return (output) => {
    const fields = end(output);
    return fields ? Object.fromEntries(Object.entries(fields).filter(([k]) => !QA_RESERVED_FIELDS.includes(k))) : fields;
  };
}

/** The final QA image. Never throws; bounded; undefined for statuses where it would not help or when the image is not jpeg, png or webp. */
async function captureQaScreenshot(browser: BrowserBridge, status: string): Promise<{ mediaType: string; base64: string } | undefined> {
  // After a timeout the controller may still hold its lock.
  if (status === "setup_failed" || status === "aborted" || status === "timeout" || !browser.screenshot) return undefined;
  try {
    const out = await boundedCall(() => browser.screenshot!({}), QA_SCREENSHOT_MS);
    if (!out.done) return undefined;
    const match = IMAGE_DATA_URL.exec(normalizeScreenshot((out.value as { imageData?: unknown } | null | undefined)?.imageData as string | undefined) ?? "");
    return match ? { mediaType: match[1]!, base64: match[2]! } : undefined;
  } catch {
    return undefined;
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
  // The verdict is set once qa_verdict succeeded; the tool loop ends then (the verdict is the last step).
  let verdictSet = false;
  const extras: Record<string, BrowseAgentExtraTool> = {
    ...opts.extraTools,
    ...(qaOn ? { [QA_VERDICT_TOOL]: { ...qaVerdictHooks(), ...qaVerdictDefinition, execute: async (input: unknown) => { const out = executeQaVerdict(input); if (parseJsonObject(out).ok === true) verdictSet = true; return out; } } } : {}),
  };
  const trail = qaOn ? createStepRecorder() : undefined;
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
      return output;
    } catch (error) {
      ended({ error });
      throw error;
    }
  };
  const session = createBrowseAgentSession({
    signal: opts.signal,
    deadlineMs: opts.deadlineMs,
    maxRequests: opts.maxRequests,
    baseTools,
    extraTools: Object.fromEntries(Object.entries(extras).map(([n, e]) => [n, { guard: e.guard?.bind(e), begin: e.begin?.bind(e), end: qaOn && n !== QA_VERDICT_TOOL ? reservedFieldsDropped(e.end?.bind(e)) : e.end?.bind(e), fork: e.fork?.bind(e) }])),
    executeTool,
  });

  const system =
    typeof opts.prompt === "string"
      ? opts.prompt
      : buildBrowseAgentPrompt(
          qaOn ? { ...opts.prompt, principal: opts.prompt?.principal ?? QA_PRINCIPAL, sections: [...(opts.prompt?.sections ?? []), QA_PROMPT_SECTION] } : opts.prompt,
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
  let shot: { mediaType: string; base64: string } | undefined;

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
            stopWhen: () => verdictSet || !session.continueRequest(),
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
    if (!trail) return result;
    // `qa` is an extra field: it goes before `error` and `setupStage`, and the verdict field is folded into it.
    const { error, setupStage, [QA_VERDICT_FIELD]: _verdict, ...rest } = result;
    return {
      ...rest,
      qa: qaResultOf(result, trail.steps()),
      ...(error !== undefined ? { error } : {}),
      ...(setupStage !== undefined ? { setupStage } : {}),
    } as BrowseAgentResult;
  } finally {
    // Capture conditions live in the helper. The order is capture, host callback, fixture release (the mocks live
    // until the task ends, whatever the outcome), stop. The stop wait is bounded, so a hung browser cannot hold a finished run.
    await checkpoint.finish(finalStatus, {
      async beforeStop(captured) {
        // The final image first: the fixture's mocks are still live, and the page is as the run left it.
        // The host callback waits until the release and the stop are done.
        if (onScreenshot) shot = await captureQaScreenshot(opts.browser, finalStatus.status);
        // A rejecting async callback must not become an unhandled rejection; a slow one is awaited for a bounded time only.
        if (captured && onCapture) await boundedCall(() => onCapture(captured), CHECKPOINT_CALLBACK_MS).catch(() => undefined);
        await fixtureSetup?.release();
      },
    });
    if (shot && onScreenshot) {
      const img = shot;
      // A throw or a rejection is ignored; a slow callback is awaited for a bounded time only.
      await boundedCall(() => onScreenshot(img), QA_SCREENSHOT_CALLBACK_MS).catch(() => undefined);
    }
  }
}
