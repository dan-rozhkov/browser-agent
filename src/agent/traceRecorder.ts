// Records a browse run as a trace (docs/specs/2026-10-20-browse-run-trace-design.md).
// A host-side object fed from the same `executeTool` seam as the QA step
// recorder. Mechanism only: it builds the object; the host stores it.
// Zod-free (exported from `agent/session` and `agent`).
import { createSeenList, harvestDiagnostics, type SeenList } from "../shared/diagnostics.js";
import { normalizeScreenshot } from "../shared/image.js";
import type { QaResult } from "../shared/qaTypes.js";
import {
  BROWSE_TRACE_ANSWER_MAX_CHARS,
  BROWSE_TRACE_MAX_ACTIONS,
  BROWSE_TRACE_ERROR_MAX_CHARS,
  BROWSE_TRACE_FORMAT,
  BROWSE_TRACE_GOAL_MAX_CHARS,
  BROWSE_TRACE_ID,
  BROWSE_TRACE_OUTPUT_MAX_CHARS,
  BROWSE_TRACE_VERSION,
  capTraceText,
  redactTraceArgsTracked,
  redactTraceRequest,
  type BrowseTrace,
  type BrowseTraceAction,
  type BrowseTraceFrame,
  type BrowseTraceLogEntry,
  type BrowseTraceRequest,
  type BrowseTraceStep,
} from "../shared/trace.js";
import { parseJsonObject } from "./session.js";

type FrameKind = BrowseTraceFrame["kind"];

export interface BrowseTraceRecorderOptions {
  /** Default: a random 22-char id. An id that is not a `BROWSE_TRACE_ID` is replaced. */
  id?: string;
  goal: string;
  /** Default `Date.now`. */
  now?: () => number;
  labels?: Record<string, string>;
  /**
   * Takes a screenshot of the current page. Returns a data URL (or raw base64 of a jpeg, png or webp).
   * Every controller command drains the pending JS dialogs, a screenshot too: return them as `dialogs`
   * and the function that `onToolCall` returns hands them back to you, to merge into the tool output
   * (`mergeCarriedDialogs`). Otherwise tracing would hide them from the model.
   */
  capture?: () => Promise<{ imageData: string; width?: number; height?: number; dialogs?: unknown[] } | undefined>;
  /**
   * Which finished calls get a "step" frame. Default: `browse_open`; `browse_act`, except a lone `wait` (or a batch
   * of only `wait`); `browse_tabs` for `switch`, `close` and `new` (not `list`). A failed call gets a frame too (the
   * viewer shows the page at the failure; with the default only: not after a call refused by argument validation, and
   * not for a second failure in a row that already got a failure frame). A step whose typed text was redacted never gets a frame (the screenshot
   * would show it).
   */
  captureAfter?: (tool: string, args: unknown, ok: boolean) => boolean;
  /**
   * Default 4000. A timeout or a throw gives no frame and never an error. After ONE timeout the recorder takes no
   * more step captures in this run (a timed-out screenshot may still hold the browser), and every capture it
   * skips or loses is counted in `dropped.frames`.
   */
  captureTimeoutMs?: number;
  /** Default: the redaction of `redactTraceArgsTracked`, with memory of the last focused field for this run. */
  redactArgs?: (args: unknown) => unknown;
  /** Default 300. */
  maxSteps?: number;
  /** Default 150. */
  maxFrames?: number;
  /** Default 300, per log. */
  maxLogEntries?: number;
  /**
   * Source of the network request log (the host passes `() => bridge.requests()`). Resolves to the JSON text or
   * the object `{ requests, dropped? }` (`PageRequestEntry[]`, raw). Drained at the end of every finished step
   * (in the background, after the step frame: the step never waits for it; drains never overlap) and by `flush()`.
   * Each call is limited to 5000 ms; after ONE timeout the recorder stops calling it. Not called when `ctx.signal` is aborted. A throw gives no
   * entries. Without this option the trace has no `requests`.
   */
  requests?: () => Promise<unknown>;
  /** Default 500. Entries past it are counted in `dropped.requests`. */
  maxRequests?: number;
}

export interface BrowseTraceRecorder {
  readonly id: string;
  /**
   * Same shape as `StepRecorder.onToolCall`. The returned function is async:
   * await it before the result goes back to the model, so the step frame shows
   * the page right after this step. It never rejects. It resolves to `{ dialogs }` when the capture drained
   * JS dialogs: merge them into the output the model gets (`mergeCarriedDialogs`). No step frame is taken when `ctx.signal` is aborted
   * (the run was aborted or is past its deadline), and an abort during a capture ends the wait at once. Calls still pending at `finish()` become steps with
   * `ok: false` and `error: "unfinished"`.
   */
  onToolCall(call: { toolName: string; input: unknown }, ctx?: { signal?: AbortSignal }): (end: { output?: unknown; error?: unknown }) => Promise<{ dialogs?: unknown[] }>;
  /** Adds a frame (a data URL of a jpeg, png or webp). Anything else is ignored. */
  addFrame(frame: { imageData: string; kind?: FrameKind; width?: number; height?: number; stepIndex?: number }): void;
  /**
   * Waits for the background drains, then drains once more, limited to 2000 ms (the host awaits it before `finish`).
   * An abort does not stop it: an aborted run still gets its last requests. The entries get a `stepIndex`
   * only when their start lies inside a step. No-op without the option, or after `finish`. Never rejects.
   */
  flush(signal?: AbortSignal): Promise<void>;
  /** Builds the trace. Idempotent: a second call returns the same object. Never throws. */
  finish(end: { status: string; answer?: string; error?: string; qa?: QaResult }): BrowseTrace;
}

/** What `qa.steps[].args` holds in a trace. */
const QA_ARGS_OMITTED = "[omitted]";

const TAB_CAPTURE_ACTIONS: readonly string[] = ["switch", "close", "new"];

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** The default `captureAfter`: calls that can change what the page shows. */
function defaultCaptureAfter(tool: string, args: unknown, _ok: boolean): boolean {
  if (tool === "browse_open") return true;
  const input = isObject(args) ? args : {};
  if (tool === "browse_act") {
    const entries = Array.isArray(input.actions) ? input.actions : [input];
    return entries.some((e) => !isObject(e) || e.action !== "wait");
  }
  if (tool === "browse_tabs") return typeof input.action === "string" && TAB_CAPTURE_ACTIONS.includes(input.action);
  return false;
}

/** The per-action entries of a batched `browse_act` from its parsed result; undefined when the batch did not run. */
function batchActions(args: unknown, input: unknown, parsed: Record<string, unknown>): BrowseTraceAction[] | undefined {
  if (!isObject(input) || !Array.isArray(input.actions) || !Array.isArray(parsed.results) || typeof parsed.completed !== "number") return undefined;
  const named = isObject(args) && Array.isArray(args.actions) ? args.actions : [];
  const nameAt = (i: number): string => {
    const entry = named[i];
    return isObject(entry) && typeof entry.action === "string" && entry.action !== "" ? entry.action.slice(0, 64) : "act";
  };
  const out: BrowseTraceAction[] = [];
  const completed = Math.max(0, Math.min(Math.floor(parsed.completed), BROWSE_TRACE_MAX_ACTIONS));
  for (let i = 0; i < completed; i++) out.push({ action: nameAt(i), ok: true });
  if (typeof parsed.stoppedAt === "number" && parsed.stoppedAt >= 0 && parsed.stoppedAt < BROWSE_TRACE_MAX_ACTIONS) {
    const at = Math.floor(parsed.stoppedAt);
    const result = parsed.results[at];
    const error = isObject(result) && typeof result.error === "string" ? result.error : typeof parsed.error === "string" ? parsed.error : undefined;
    out.push({ action: nameAt(at), ok: false, ...(error !== undefined ? { error: capTraceText(error, BROWSE_TRACE_ERROR_MAX_CHARS) } : {}) });
  }
  return out;
}

/** Reads the `requests` source value: a JSON string or an object `{ requests, dropped? }` (or a bare array). */
function readRequestSource(value: unknown): { entries: unknown[]; dropped: number } {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return { entries: [], dropped: 0 };
    }
  }
  if (Array.isArray(v)) return { entries: v, dropped: 0 };
  if (!isObject(v) || !Array.isArray(v.requests)) return { entries: [], dropped: 0 };
  const dropped = typeof v.dropped === "number" && Number.isFinite(v.dropped) && v.dropped > 0 ? Math.floor(v.dropped) : 0;
  return { entries: v.requests, dropped };
}

/** More than the controller's own 3000 ms for `requests()`, so its answer is not cut. */
const REQUESTS_TIMEOUT_MS = 5000;
/** The time box of the last drain in `flush` (the run may already be over). */
const FLUSH_TIMEOUT_MS = 2000;

/** True when a `browse_act` result shows that no action ran: no `results` array, or at most the refused first entry. */
function nothingRan(parsed: Record<string, unknown>): boolean {
  return !Array.isArray(parsed.results) || (parsed.completed === 0 && parsed.results.length <= 1);
}
/** Errors of a call refused before it touched the page (execute.ts argument checks): a failure frame would repeat the last one. */
const PRE_EXECUTION_ERROR = /^(?:browse_act: (?:"actions" (?:must|accepts)|action "[^"]*" requires|actions\[\d+\] (?:is a viewport|uses "element"|must be))|Unknown browse tool)/;

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

function randomId(): string {
  const bytes = new Uint8Array(22);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
}

function textOfError(error: unknown): string {
  try {
    return capTraceText(error instanceof Error ? error.message : String(error), BROWSE_TRACE_ERROR_MAX_CHARS);
  } catch {
    return "error";
  }
}

/** A capped log of distinct texts (a full seen-set). Entries past the cap are counted, with the controller's own dropped counts. */
function createLog(max: number) {
  const entries: BrowseTraceLogEntry[] = [];
  const seen: SeenList = createSeenList(max, max);
  return {
    entries,
    seen,
    /** Records the new texts of `texts`. */
    add(fresh: readonly string[], at: number, stepIndex: number | undefined): void {
      for (const text of fresh) entries.push({ at, ...(stepIndex !== undefined ? { stepIndex } : {}), text });
    },
  };
}

export function createBrowseTraceRecorder(opts: BrowseTraceRecorderOptions): BrowseTraceRecorder {
  const now = opts.now ?? Date.now;
  const id = opts.id !== undefined && BROWSE_TRACE_ID.test(opts.id) ? opts.id : randomId();
  const redactState = { secretFocus: false };
  const captureAfter = opts.captureAfter ?? defaultCaptureAfter;
  const captureTimeoutMs = opts.captureTimeoutMs ?? 4000;
  const maxSteps = opts.maxSteps ?? 300;
  const maxFrames = opts.maxFrames ?? 150;
  const maxLog = opts.maxLogEntries ?? 300;
  const maxRequests = opts.maxRequests ?? 500;
  const startedAt = now();
  // One slot per call, taken when the call starts (index = call order); a call past `maxSteps` has no slot.
  const slots: { step: BrowseTraceStep; open: boolean }[] = [];
  const frames: BrowseTraceFrame[] = [];
  const consoleLog = createLog(maxLog);
  const networkLog = createLog(maxLog);
  let calls = 0;
  let nextFrameId = 0;
  let droppedSteps = 0;
  let droppedFrames = 0;
  let captureDisabled = false;
  const requestLog: BrowseTraceRequest[] = [];
  let droppedRequests = 0;
  let requestsDisabled = false;
  // Background drains run one after another, in step order. A drain never rejects.
  let requestQueue: Promise<void> = Promise.resolve();
  // The last recorded step failed and got a frame (consecutive failures get one).
  let prevFailureFramed = false;
  const scheduleDrain = (signal: AbortSignal | undefined, fallback: number | undefined) => {
    if (!opts.requests) return;
    // An aborted run schedules nothing new; a drain already queued still runs.
    if (signal?.aborted) return;
    requestQueue = requestQueue.then(() => drainRequests(fallback, REQUESTS_TIMEOUT_MS));
  };
  let finished: BrowseTrace | undefined;

  const addFrame: BrowseTraceRecorder["addFrame"] = (frame) => {
    try {
      if (finished || typeof frame.imageData !== "string") return;
      // A data URL, or raw base64 by its magic bytes. Anything `parseBrowseTrace` would reject is not a frame.
      const src = normalizeScreenshot(frame.imageData);
      if (!src) return;
      if (frames.length >= maxFrames) {
        droppedFrames += 1;
        // The oldest frame goes, the first one stays.
        if (maxFrames < 2) return;
        frames.splice(1, 1);
      }
      frames.push({
        id: nextFrameId++,
        at: now(),
        ...(frame.stepIndex !== undefined ? { stepIndex: frame.stepIndex } : {}),
        kind: frame.kind ?? "step",
        src,
        ...(frame.width !== undefined ? { width: frame.width } : {}),
        ...(frame.height !== undefined ? { height: frame.height } : {}),
      });
    } catch {
      // Ignored: the recorder never throws into the host.
    }
  };

  /** Takes the step frame. Returns the dialogs the screenshot drained. */
  async function capturePage(stepIndex: number | undefined, signal: AbortSignal | undefined): Promise<unknown[] | undefined> {
    if (!opts.capture) return undefined;
    // After a timeout the screenshot may still hold the browser: no more captures. An aborted run takes none either.
    if (captureDisabled || signal?.aborted) {
      droppedFrames += 1;
      return undefined;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const gone = Symbol("gone");
      const shot = await Promise.race([
        Promise.resolve().then(() => opts.capture!()),
        new Promise<typeof gone>((resolve) => {
          timer = setTimeout(() => {
            captureDisabled = true;
            resolve(gone);
          }, captureTimeoutMs);
          onAbort = () => resolve(gone);
          signal?.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      if (shot === gone) {
        droppedFrames += 1;
        return undefined;
      }
      if (!shot) return undefined;
      addFrame({ imageData: shot.imageData, kind: "step", width: shot.width, height: shot.height, stepIndex });
      return Array.isArray(shot.dialogs) && shot.dialogs.length > 0 ? shot.dialogs : undefined;
    } catch {
      // No frame, no error.
      return undefined;
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  /** The step whose [startedAt, endedAt] holds `at` (a step still open runs until now). */
  function stepAt(at: number): number | undefined {
    const t = now();
    for (const s of slots) {
      const end = s.open ? t : s.step.endedAt;
      if (at >= s.step.startedAt && at <= end) return s.step.index;
    }
    return undefined;
  }

  /** Drains the `requests` source into the log. `fallback`: the step of entries that lie in no step. Never throws. */
  async function drainRequests(fallback: number | undefined, timeoutMs: number): Promise<void> {
    if (!opts.requests || requestsDisabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const gone = Symbol("gone");
      const got = await Promise.race([
        Promise.resolve().then(() => opts.requests!()),
        new Promise<typeof gone>((resolve) => {
          timer = setTimeout(() => {
            requestsDisabled = true;
            resolve(gone);
          }, timeoutMs);
        }),
      ]);
      if (got === gone || finished) return;
      const { entries, dropped } = readRequestSource(got);
      droppedRequests += dropped;
      for (const raw of entries) {
        const entry = redactTraceRequest(raw);
        if (!entry) continue;
        if (requestLog.length >= maxRequests) {
          droppedRequests += 1;
          continue;
        }
        const stepIndex = stepAt(entry.at) ?? fallback;
        delete entry.stepIndex;
        requestLog.push(stepIndex !== undefined ? { ...entry, stepIndex } : entry);
      }
    } catch {
      // No entries, no error.
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The trace carries no QA step args: the QA step recorder keeps the raw input (a typed password included), and
   * `steps` already holds the redacted args of every call. Each step keeps index, tool, ok, error and ms; `args` is
   * a fixed placeholder (the `QaStep` type requires the field). Never throws.
   */
  function qaWithoutArgs(qa: QaResult): QaResult {
    try {
      const steps = Array.isArray(qa.steps) ? qa.steps : [];
      return { ...qa, steps: steps.map((st) => ({ ...st, args: QA_ARGS_OMITTED })) };
    } catch {
      return { ...qa, steps: [] };
    }
  }

  return {
    id,
    addFrame,
    onToolCall(call, ctx) {
      const index = calls++;
      const stepStartedAt = now();
      let args: unknown;
      let typedSecret = false;
      try {
        if (opts.redactArgs) args = opts.redactArgs(call.input);
        else {
          const tracked = redactTraceArgsTracked(call.input, redactState);
          args = tracked.value;
          typedSecret = tracked.typedSecret;
        }
      } catch {
        args = "[unavailable]";
      }
      // The slot is taken now, so parallel calls keep call order and cannot pass `maxSteps`.
      const slot = index < maxSteps ? { step: { index, tool: call.toolName, args, startedAt: stepStartedAt, endedAt: stepStartedAt, ok: false, error: "unfinished" } as BrowseTraceStep, open: true } : undefined;
      if (slot) slots.push(slot);
      else droppedSteps += 1;
      const frameStep = slot ? index : undefined;
      return async (end) => {
        try {
          if (finished || (slot && !slot.open)) return {};
          const endedAt = now();
          const step: BrowseTraceStep = { index, tool: call.toolName, args, startedAt: stepStartedAt, endedAt, ok: true };
          let parsed: Record<string, unknown> = {};
          if (end.error !== undefined) {
            step.ok = false;
            step.error = textOfError(end.error);
          } else if (typeof end.output === "string") {
            parsed = parseJsonObject(end.output);
            step.output = end.output;
          } else if (end.output && typeof end.output === "object" && !Array.isArray(end.output)) {
            parsed = end.output as Record<string, unknown>;
            step.output = JSON.stringify(end.output);
          } else if (end.output !== undefined) {
            step.output = String(end.output);
          }
          if (typeof parsed.error === "string") {
            step.ok = false;
            step.error = capTraceText(parsed.error, BROWSE_TRACE_ERROR_MAX_CHARS);
          }
          if (typeof parsed.imageData === "string") {
            const { imageData, ...rest } = parsed;
            step.output = JSON.stringify(rest);
            addFrame({
              imageData,
              kind: "screenshot",
              stepIndex: frameStep,
              ...(typeof parsed.width === "number" ? { width: parsed.width } : {}),
              ...(typeof parsed.height === "number" ? { height: parsed.height } : {}),
            });
          }
          if (call.toolName === "browse_act") {
            const actions = batchActions(args, call.input, parsed);
            if (actions) step.actions = actions;
          }
          if (step.output !== undefined) step.output = capTraceText(step.output, BROWSE_TRACE_OUTPUT_MAX_CHARS);
          const fresh = harvestDiagnostics(parsed, consoleLog.seen, networkLog.seen);
          consoleLog.add(fresh.consoleErrors, endedAt, frameStep);
          networkLog.add(fresh.failedRequests, endedAt, frameStep);
          if (slot) {
            slot.step = step;
            slot.open = false;
          }
          let wanted = false;
          try {
            wanted = captureAfter(call.toolName, call.input, step.ok);
          } catch {
            // A throwing predicate means no frame.
          }
          // A failure frame needs a reason: not a call refused before it ran, not a second one in a row.
          if (wanted && !step.ok && !opts.captureAfter && (prevFailureFramed || (PRE_EXECUTION_ERROR.test(step.error ?? "") && nothingRan(parsed)))) wanted = false;
          let dialogs: unknown[] | undefined;
          // The screenshot of a step that typed a secret would show it.
          if (wanted && !typedSecret) {
            const framesBefore = nextFrameId;
            dialogs = await capturePage(frameStep, ctx?.signal);
            prevFailureFramed = !step.ok && nextFrameId > framesBefore;
          } else prevFailureFramed = false;
          scheduleDrain(ctx?.signal, frameStep);
          if (dialogs) return { dialogs };
        } catch {
          // Ignored: the recorder never throws into the host.
        }
        return {};
      };
    },
    async flush() {
      try {
        await requestQueue;
        // Also after an abort: the last requests of an aborted run are the ones worth reading.
        if (!finished) await drainRequests(undefined, FLUSH_TIMEOUT_MS);
      } catch {
        // Ignored: the recorder never throws into the host.
      }
    },
    finish(end) {
      if (finished) return finished;
      const endedAt = now();
      try {
        consoleLog.add(consoleLog.seen.add(end.qa?.consoleErrors), endedAt, undefined);
        networkLog.add(networkLog.seen.add(end.qa?.failedRequests), endedAt, undefined);
        // `qa.*Dropped` is not added: it repeats the counts the outputs already gave.
      } catch {
        // Ignored.
      }
      const dropped = {
        ...(droppedSteps > 0 ? { steps: droppedSteps } : {}),
        ...(droppedFrames > 0 ? { frames: droppedFrames } : {}),
        ...(consoleLog.seen.dropped() > 0 ? { console: consoleLog.seen.dropped() } : {}),
        ...(networkLog.seen.dropped() > 0 ? { network: networkLog.seen.dropped() } : {}),
        ...(droppedRequests > 0 ? { requests: droppedRequests } : {}),
      };
      finished = {
        format: BROWSE_TRACE_FORMAT,
        version: BROWSE_TRACE_VERSION,
        id,
        goal: capTraceText(String(opts.goal ?? ""), BROWSE_TRACE_GOAL_MAX_CHARS),
        startedAt,
        endedAt,
        status: String(end.status),
        ...(end.answer !== undefined ? { answer: capTraceText(String(end.answer), BROWSE_TRACE_ANSWER_MAX_CHARS) } : {}),
        ...(end.error !== undefined ? { error: capTraceText(String(end.error), BROWSE_TRACE_ERROR_MAX_CHARS) } : {}),
        ...(opts.labels ? { labels: { ...opts.labels } } : {}),
        // Calls still pending are steps that did not finish.
        steps: slots.map((s) => (s.open ? { ...s.step, endedAt } : s.step)),
        frames,
        console: consoleLog.entries,
        network: networkLog.entries,
        ...(opts.requests ? { requests: requestLog } : {}),
        ...(end.qa ? { qa: qaWithoutArgs(end.qa) } : {}),
        ...(Object.keys(dropped).length > 0 ? { dropped } : {}),
      };
      for (const s of slots) s.open = false;
      return finished;
    },
  };
}
