// The control flow of one browse-agent run, independent of how the model is
// driven. Two drivers sit on it: the package's own AI SDK loop
// (`agent/ai-sdk`) and Pen Editor's nested `Chat`. The host plugs in
//  (a) `executeTool`: how a tool call runs, and
//  (b) a `BrowseAgentDriver`: how the model conversation is sent and stopped.
// The core owns: the deadline timer, the abort signal (parent + deadline),
// the request cap, the step counter, the allowlist, host tool guards, the
// status choice, and the result object.
import { BROWSE_AGENT_DEADLINE_MS, BROWSE_AGENT_MAX_REQUESTS } from "./limits.js";
import {
  browseAgentErrorMessage,
  finalAnswer,
  goalRequiredResult,
  preOpenText,
  type BrowseAgentMessage,
  type BrowseAgentResult,
  type BrowseAgentStatus,
} from "./result.js";
import { BROWSE_AGENT_TOOL_NAMES } from "./toolNames.js";

export interface BrowseAgentToolCall {
  toolName: string;
  input: unknown;
  toolCallId: string;
}

/**
 * Hooks of a host tool (a tool outside the seven, for example Pen Editor's
 * `browse_capture`). The tool is allowed because it is listed in
 * `extraTools`: a host lists it per call, when the user asked for it.
 */
export interface BrowseAgentExtraToolHooks {
  /** Return a message to refuse the call. The message goes to the model as
   * `{ error }`, the tool does not run and no step is counted. */
  guard?(): string | undefined;
  /** Called after the guard passed, just before the tool runs. */
  begin?(): void;
  /** Called with the tool output (also when the tool threw: the output is then
   * the error JSON). The returned fields are merged into the run result. */
  end?(output: string): Record<string, unknown> | void;
  /**
   * Make a fresh copy of these hooks with their own state. A session calls it
   * once, at creation, so a host that reuses one hooks object across runs
   * (or runs two sessions at once) does not share state between them. Hooks
   * with state (`singleUseTool`) provide it; stateless hooks omit it.
   */
  fork?(): BrowseAgentExtraToolHooks;
}

export interface BrowseAgentSessionOptions {
  /** Aborts the run (status `aborted`). */
  signal?: AbortSignal;
  /** Own deadline in ms. Default `BROWSE_AGENT_DEADLINE_MS`. Must be a positive
   * number, else session creation throws. A value above 2^31-1 ms (about 24.8
   * days, the largest delay a timer takes) or `Infinity` means no deadline. */
  deadlineMs?: number;
  /** Max model requests. Default `BROWSE_AGENT_MAX_REQUESTS`. Must be a
   * positive number, else session creation throws. `Infinity` means no cap. */
  maxRequests?: number;
  /** The tools of the run. Default the seven browse tools. */
  baseTools?: readonly string[];
  /** Host tools, allowed for this run, with their hooks. */
  extraTools?: Readonly<Record<string, BrowseAgentExtraToolHooks>>;
  /** Runs one tool call and returns the result string. May throw: the session
   * turns a throw into `{ error }`. `signal` aborts on deadline or parent abort. */
  executeTool(call: BrowseAgentToolCall, ctx: { signal: AbortSignal }): Promise<string>;
}

/** How the host drives the model conversation. */
export interface BrowseAgentDriver {
  /** Send the first user message. Resolves when the whole tool loop has ended. */
  send(text: string): Promise<void>;
  /** Stop the conversation (abort the request). Idempotent, must not throw. */
  stop(): void;
  /** The messages so far, for the final answer. */
  messages(): readonly BrowseAgentMessage[];
  /** An error the conversation reported on its own, if any. */
  error?(): unknown;
}

export interface BrowseAgentRunOptions {
  /** Start URL: the session runs `browse_open` before the first request. */
  url?: string;
  /** Id of the parent tool call. The pre-open call gets `${toolCallId}:open`. Default "browse_agent". */
  toolCallId?: string;
}

export interface BrowseAgentSession {
  /** Abort signal for tool execution: parent abort or deadline. */
  readonly signal: AbortSignal;
  /** The tools this run allows (base + extra). */
  readonly allowedTools: ReadonlySet<string>;
  /** Number of tool executions so far. */
  readonly steps: number;
  /** True after a stop (parent abort, deadline) . */
  readonly stopped: boolean;
  /**
   * Ask for the next automatic model request. Call it when the last assistant
   * turn ended with tool results and the conversation could continue. Returns
   * false when the run is stopped or the request cap is reached (then the
   * status becomes `step_limit`).
   */
  continueRequest(): boolean;
  /** Record an error the model transport reported (the last one counts). */
  recordError(err: unknown): void;
  /**
   * Run one tool call of the model: allowlist, host guard, step count, then
   * `executeTool`. Always resolves to a result string. `deliver` gets the
   * output (hand it to the conversation there): the run waits for it.
   */
  runTool(call: BrowseAgentToolCall, deliver?: (output: string) => void): Promise<string>;
  /** Run the whole task. */
  run(goal: string, driver: BrowseAgentDriver, opts?: BrowseAgentRunOptions): Promise<BrowseAgentResult>;
}

const noop = () => {};
/** The largest delay `setTimeout` takes; a bigger one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** Keys the session owns. A host field with one of these names cannot replace them. */
const CORE_KEYS: ReadonlySet<string> = new Set(["status", "answer", "steps", "error"]);

function positiveNumber(name: string, value: number): number {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number (got ${String(value)}).`);
  }
  return value;
}

export function createBrowseAgentSession(opts: BrowseAgentSessionOptions): BrowseAgentSession {
  const maxRequests = positiveNumber("maxRequests", opts.maxRequests ?? BROWSE_AGENT_MAX_REQUESTS);
  const deadlineMs = positiveNumber("deadlineMs", opts.deadlineMs ?? BROWSE_AGENT_DEADLINE_MS);
  // Fork stateful hooks: state belongs to this session, not to the host's object.
  const extraTools: Record<string, BrowseAgentExtraToolHooks> = Object.fromEntries(
    Object.entries(opts.extraTools ?? {}).map(([name, hooks]) => [name, hooks.fork?.() ?? hooks]),
  );
  const allowed: ReadonlySet<string> = new Set<string>([
    ...(opts.baseTools ?? BROWSE_AGENT_TOOL_NAMES),
    ...Object.keys(extraTools),
  ]);

  const parentSignal = opts.signal;
  const deadline = new AbortController();
  const signal = parentSignal ? AbortSignal.any([parentSignal, deadline.signal]) : deadline.signal;

  let requests = 1;
  let steps = 0;
  let stopped = false;
  let timedOut = false;
  let stepLimit = false;
  let streamError: unknown;
  let hasError = false;
  const fields: Record<string, unknown> = {};
  const pending = new Set<Promise<void>>();

  async function execute(call: BrowseAgentToolCall): Promise<string> {
    try {
      return await opts.executeTool(call, { signal });
    } catch (err) {
      return JSON.stringify({ error: browseAgentErrorMessage(err) });
    }
  }

  function runTool(call: BrowseAgentToolCall, deliver?: (output: string) => void): Promise<string> {
    const run = (async () => {
      let output: string;
      const hooks = extraTools[call.toolName];
      const refusal = allowed.has(call.toolName) ? hooks?.guard?.() : undefined;
      if (!allowed.has(call.toolName)) {
        output = JSON.stringify({
          error: `Tool ${call.toolName} is not available to the browse agent. Use only: ${[...allowed].join(", ")}.`,
        });
      } else if (refusal !== undefined) {
        output = JSON.stringify({ error: refusal });
      } else {
        hooks?.begin?.();
        steps += 1;
        output = await execute(call);
        const extra = hooks?.end?.(output);
        if (extra) {
          for (const [key, value] of Object.entries(extra)) if (!CORE_KEYS.has(key)) fields[key] = value;
        }
      }
      deliver?.(output);
      return output;
    })();
    const tracked: Promise<void> = run.then(noop, noop).finally(() => pending.delete(tracked));
    pending.add(tracked);
    return run;
  }

  async function runAll(goal: string, driver: BrowseAgentDriver, runOpts: BrowseAgentRunOptions): Promise<BrowseAgentResult> {
    const result = (status: BrowseAgentStatus, error?: string): BrowseAgentResult => ({
      status,
      answer: finalAnswer(driver.messages(), status),
      steps,
      ...fields,
      ...(error !== undefined ? { error } : {}),
    });

    const stop = () => {
      stopped = true;
      driver.stop();
    };
    if (parentSignal?.aborted) stopped = true;
    else parentSignal?.addEventListener("abort", stop, { once: true });

    let onDeadline!: () => void;
    const deadlineHit = new Promise<void>((resolve) => {
      onDeadline = resolve;
    });
    // A deadline past the timer maximum (or Infinity) means no deadline.
    const timer =
      deadlineMs > MAX_TIMER_MS
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            deadline.abort();
            stop();
            onDeadline();
          }, deadlineMs);

    try {
      if (stopped) return result("aborted");
      // Open the start page before the first model request: the model starts
      // on its snapshot instead of spending a whole request on browse_open.
      let text = goal;
      if (runOpts.url) {
        steps += 1;
        const opened = await execute({
          toolName: "browse_open",
          input: { url: runOpts.url },
          toolCallId: `${runOpts.toolCallId ?? "browse_agent"}:open`,
        });
        if (stopped || timedOut) return result(timedOut ? "timeout" : "aborted");
        text = preOpenText(goal, runOpts.url, opened);
      }
      // `send` resolves after the whole tool loop; the deadline race is the
      // backstop for a hung stream.
      await Promise.race([
        Promise.resolve()
          .then(() => driver.send(text))
          .catch((err: unknown) => {
            if (!hasError) {
              streamError = err;
              hasError = true;
            }
          }),
        deadlineHit,
      ]);
      if (timedOut) return result("timeout");
      await Promise.allSettled([...pending]);
      if (timedOut) return result("timeout");
      if (stopped || parentSignal?.aborted) return result("aborted");
      const failure = hasError ? streamError : driver.error?.();
      if (failure) return result("error", browseAgentErrorMessage(failure));
      if (stepLimit) return result("step_limit");
      return result("done");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      parentSignal?.removeEventListener("abort", stop);
    }
  }

  return {
    signal,
    allowedTools: allowed,
    get steps() {
      return steps;
    },
    get stopped() {
      return stopped;
    },
    continueRequest() {
      if (stopped) return false;
      if (requests >= maxRequests) {
        stepLimit = true;
        return false;
      }
      requests += 1;
      return true;
    },
    recordError(err) {
      streamError = err;
      hasError = true;
    },
    runTool,
    run(goal, driver, runOpts = {}) {
      const trimmed = goal.trim();
      if (!trimmed) return Promise.resolve(goalRequiredResult());
      return runAll(trimmed, driver, runOpts);
    },
  };
}

/**
 * Hooks for a host tool that may succeed once per run (Pen Editor's
 * `browse_capture`): it refuses a second call while the first runs and after
 * the first succeeded. A failed run does not use up the one allowed try.
 * The state is per session (see `fork`): reuse the result for every run.
 */
export function singleUseTool(opts: {
  name: string;
  /** True when the (parsed) output is a success. */
  isSuccess(parsed: Record<string, unknown>): boolean;
  /** Fields to add to the run result after the success. */
  fields?(parsed: Record<string, unknown>): Record<string, unknown>;
  /** Message while the first call still runs. */
  inFlightMessage?: string;
  /** Message after the first success. */
  doneMessage?(parsed: Record<string, unknown>): string;
}): BrowseAgentExtraToolHooks {
  const make = (): BrowseAgentExtraToolHooks => {
    let state: "idle" | "in-flight" | "done" = "idle";
    let doneParsed: Record<string, unknown> = {};
    return {
      guard() {
        if (state === "in-flight") {
          return opts.inFlightMessage ?? `${opts.name} is already running in this task; wait for its result.`;
        }
        if (state === "done") {
          return opts.doneMessage?.(doneParsed) ?? `${opts.name} already ran in this task.`;
        }
        return undefined;
      },
      begin() {
        state = "in-flight";
      },
      end(output) {
        const parsed = parseJsonObject(output);
        if (!opts.isSuccess(parsed)) {
          state = "idle";
          return;
        }
        state = "done";
        doneParsed = parsed;
        return opts.fields?.(parsed);
      },
    };
  };
  // The returned object works on its own, and each session forks its own state
  // from it, so a host can reuse it across runs.
  return { ...make(), fork: make };
}

/** Parse a tool output into an object. Anything else gives `{}`. */
export function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  return {};
}
