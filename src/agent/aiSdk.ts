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
import type { BrowserBridge } from "../loop/bridge.js";
import { executeBrowseTool } from "./execute.js";
import {
  buildBrowseAgentPrompt,
  type BuildBrowseAgentPromptOptions,
} from "./prompt.js";
import type { BrowseAgentMessage, BrowseAgentMessagePart, BrowseAgentResult } from "./result.js";
import {
  createBrowseAgentSession,
  parseJsonObject,
  type BrowseAgentExtraToolHooks,
  type BrowseAgentSession,
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

export interface RunBrowseAgentOptions {
  /** The chat model. Use a non-reasoning model, or switch reasoning off in `providerOptions`. */
  model: LanguageModel;
  /** The browser. `controllerBridge(controller)` from `adapters/controller-bridge` fits. */
  browser: BrowserBridge;
  /** Start URL: the browser opens it before the first request. */
  url?: string;
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
}

const DATA_URL = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/;

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
  const match = DATA_URL.exec(imageData);
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
  for (const [name, extra] of Object.entries(opts.extraTools ?? {})) {
    tools[name] = tool({
      description: extra.description,
      inputSchema: extra.inputSchema as never,
      execute: (input: unknown, { toolCallId }: { toolCallId: string }) => session.runTool({ toolName: name, input, toolCallId }),
    } as never);
  }
  return tools;
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
  const extras = opts.extraTools ?? {};
  const executeTool = async (call: { toolName: string; input: unknown; toolCallId: string }, ctx: { signal: AbortSignal }) => {
    const extra = extras[call.toolName];
    if (extra) return extra.execute(call.input, { toolCallId: call.toolCallId, signal: ctx.signal });
    return executeBrowseTool(opts.browser, call.toolName, call.input);
  };
  const session = createBrowseAgentSession({
    signal: opts.signal,
    deadlineMs: opts.deadlineMs,
    maxRequests: opts.maxRequests,
    baseTools,
    extraTools: Object.fromEntries(Object.entries(extras).map(([n, e]) => [n, { guard: e.guard?.bind(e), begin: e.begin?.bind(e), end: e.end?.bind(e), fork: e.fork?.bind(e) }])),
    executeTool,
  });

  const system = typeof opts.prompt === "string" ? opts.prompt : buildBrowseAgentPrompt(opts.prompt);
  // One assistant message, like the UI message the tool loop builds in a chat.
  const parts: BrowseAgentMessagePart[] = [];
  const messages: BrowseAgentMessage[] = [{ role: "assistant", parts }];

  return session.run(
    goal,
    {
      async send(text) {
        await generateText({
          model: opts.model,
          system,
          prompt: text,
          tools: buildTools(session, opts, defs, [...baseTools]),
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
    { url: opts.url, toolCallId: opts.runId },
  );
}
