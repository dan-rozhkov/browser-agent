// Checkpoint recording for a browse run (docs/specs/2026-10-16-checkpoint-design.md):
// starts the browser's journal, takes the checkpoint when the run ends, stops
// the journal. Zod-free, `ai`-free and isomorphic, so a host that drives
// `createBrowseAgentSession` itself uses the same logic as `runBrowseAgent`.
// The checkpoint holds secrets (cookie and storage values, typed text): it
// goes to the host (the `onCapture` callback, or the return value of `capture()`) and never into
// model-visible text: `BrowseAgentResult` has no checkpoint field.
import { parsePageFixture } from "../fixture/parse.js";
import type { CheckpointJournalOptions, CheckpointResult } from "../fixture/types.js";
import type { BrowserBridge } from "../loop/bridge.js";
import { boundedCall } from "../fixture/util.js";
import { browseAgentErrorMessage, type BrowseAgentStatus } from "./result.js";

const DEFAULT_TIMEOUT_MS = 15_000;

export interface CheckpointRecorderOptions extends CheckpointJournalOptions {
  /** Bound for one journal call (start, capture, stop). Default 15 s: a hung browser must not hold the result of a finished run. */
  timeoutMs?: number;
  /** Bound for the journal start only. Default `timeoutMs`. */
  startTimeoutMs?: number;
}

export interface CheckpointRecorder {
  /** Starts the journal. Never throws: a failure is kept and `capture()` reports it. Idempotent. */
  start(): Promise<void>;
  /** True only after `start()` finished with a running journal: not before it answered, not after a timeout, a failure or an unsupported browser. */
  started(): boolean;
  /** The recorder's own reason why the journal did not start (unsupported browser, failed or timed-out start), or undefined. */
  startError(): string | undefined;
  /**
   * Resolves when every journal call this recorder made (start, the stop of a late start, stop) has really settled,
   * not merely timed out. Unbounded: a browser that never answers never lets it resolve, so bound it at the caller. Never rejects.
   */
  idle(): Promise<void>;
  /** The checkpoint, or `{ ok: false, error }`. Never throws, bounded. */
  capture(): Promise<CheckpointResult>;
  /**
   * Stops the journal this recorder started, by its owner token: a journal another owner started
   * after it is left alone. Idempotent, never throws, bounded. A start that answers after `stop()`
   * is stopped as soon as it answers.
   */
  stop(): Promise<void>;
}

/** The bridge answer as a clean `CheckpointResult`: the fixture is validated, unknown fields are dropped. */
export function normalizeCheckpoint(raw: unknown): CheckpointResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "the browser returned no checkpoint" };
  const r = raw as Record<string, unknown>;
  if (r.ok !== true) return { ok: false, error: typeof r.error === "string" ? r.error.slice(0, 300) : "the checkpoint could not be taken" };
  const parsed = parsePageFixture(r.fixture);
  if (!parsed.ok) return { ok: false, error: `the browser returned an invalid checkpoint (${parsed.error.slice(0, 200)})` };
  const complete = r.complete !== false;
  const gap = typeof r.gap === "string" ? r.gap : undefined;
  const summary = typeof r.summary === "string" ? r.summary : "checkpoint taken";
  return { ok: true, fixture: parsed.value, complete, ...(gap !== undefined ? { gap } : {}), summary };
}

export function createCheckpointRecorder(browser: BrowserBridge, opts: CheckpointRecorderOptions = {}): CheckpointRecorder {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startTimeoutMs = opts.startTimeoutMs ?? timeoutMs;
  let startError: string | undefined;
  /** `start()` was called (it runs once). */
  let startCalled = false;
  /** `start()` ended with a running journal (see `CheckpointRecorder.started`). */
  let running = false;
  /** startJournal was called: only then is there a journal to stop. */
  let journalCalled = false;
  /** startJournal resolved. `token` is undefined for a bridge that predates tokens. */
  let startSettled = false;
  let startRejected = false;
  let token: string | undefined;
  let stopped = false;
  /** The real (not timeout-bounded) journal calls that have not settled yet. */
  const inflight = new Set<Promise<unknown>>();

  function track<T>(p: Promise<T>): Promise<T> {
    const done = p.then(() => undefined, () => undefined);
    inflight.add(done);
    void done.then(() => inflight.delete(done));
    return p;
  }

  /** Stops with `t` (no token: whatever runs, the old bridges' behavior). The wait is bounded, the call is tracked, never throws. */
  async function stopWith(t: string | undefined): Promise<void> {
    try {
      const real = track(Promise.resolve().then(() => browser.stopJournal!(t)));
      await boundedCall(() => real, timeoutMs);
    } catch {
      // A failed stop cannot change the result of the run.
    }
  }

  async function start(): Promise<void> {
    if (startCalled) return;
    startCalled = true;
    if (!browser.startJournal || !browser.stopJournal || !browser.captureCheckpoint) {
      startError = "This browser does not support checkpoints (BrowserBridge.startJournal, stopJournal or captureCheckpoint is missing).";
      return;
    }
    journalCalled = true;
    const origins = opts.origins ? { origins: opts.origins } : undefined;
    const call = Promise.resolve().then(() => browser.startJournal!(origins));
    // A start that answers AFTER the timeout or after stop() must not leave its journal running: it is stopped with its own token.
    // The handler runs before the tracked promise settles, so the late stop is in `inflight` before `idle()` can see the start as done.
    track(call.then(
      (t) => {
        startSettled = true;
        if (typeof t === "string") token = t;
        if (stopped) void stopWith(typeof t === "string" ? t : undefined);
      },
      () => { startRejected = true; },
    ));
    try {
      const outcome = await boundedCall(() => call, startTimeoutMs);
      if (!outcome.done) startError = "Starting the checkpoint journal timed out.";
    } catch (err) {
      startError = `Starting the checkpoint journal failed: ${browseAgentErrorMessage(err)}`;
    }
    running = startError === undefined;
  }

  async function capture(): Promise<CheckpointResult> {
    if (!startCalled) await start();
    if (startError !== undefined) return { ok: false, error: startError };
    try {
      const outcome = await boundedCall(() => browser.captureCheckpoint!(token), timeoutMs);
      if (!outcome.done) return { ok: false, error: "Taking the checkpoint timed out." };
      return normalizeCheckpoint(outcome.value);
    } catch (err) {
      return { ok: false, error: `Taking the checkpoint failed: ${browseAgentErrorMessage(err)}` };
    }
  }

  async function stop(): Promise<void> {
    if (stopped || !journalCalled) return;
    stopped = true;
    // A start that failed has no journal. A start still pending stops itself when it answers (see `start`).
    if (startRejected || !startSettled) return;
    await stopWith(token);
  }

  async function idle(): Promise<void> {
    while (inflight.size > 0) await Promise.all([...inflight]);
  }

  return { start, started: () => running, startError: () => startError, capture, stop, idle };
}

/** Longest wait for the journal start before the run goes on without a checkpoint. */
export const CHECKPOINT_START_WAIT_MS = 5_000;
/** Longest wait for the journal stop at the end of a run. The stop itself goes on in the background, bounded by the recorder. */
export const CHECKPOINT_STOP_WAIT_MS = 2_000;
/** Hard cap for `RunCheckpoint.settled`: 2 x the default journal call bound. A browser that never answers cannot hold a host longer. */
export const CHECKPOINT_SETTLE_CAP_MS = 2 * DEFAULT_TIMEOUT_MS;
/** The model-safe error of `finish()` when the journal did not start without a recorder error (begin timeout or abort). */
export const CHECKPOINT_NOT_STARTED_ERROR = "the checkpoint journal did not start";

/** Statuses that take no checkpoint. Typed on the status union: a renamed status fails to compile. */
const NON_CAPTURABLE_STATUSES: readonly BrowseAgentStatus[] = ["setup_failed", "aborted"];

export interface RunCheckpointOptions extends CheckpointRecorderOptions {
  /** False: no checkpoint mode. No recorder and no timer exist; `begin()` resolves false; `finish()` only runs `beforeStop(undefined)`. Default true. */
  enabled?: boolean;
  /** Host abort signal: an abort during `begin()` gives up the start; an already aborted signal starts nothing. */
  signal?: AbortSignal;
  /** Default `CHECKPOINT_START_WAIT_MS`. The journal start is bounded by the smaller of this and `timeoutMs`. */
  startWaitMs?: number;
  /** Default `CHECKPOINT_STOP_WAIT_MS`. */
  stopWaitMs?: number;
  /** Hard cap for `settled`. Default 2 x `timeoutMs` (`CHECKPOINT_SETTLE_CAP_MS` for the default timeout). */
  settleCapMs?: number;
}

export interface RunCheckpoint {
  /**
   * Starts the journal. Resolves true only when the journal runs: the start answered without error, within
   * `startWaitMs` and before an abort. Resolves false on a timeout, an abort, a failed start, when the signal was
   * already aborted (the browser is not called at all), when `finish()` was already called (the browser is not called),
   * and when the helper is disabled. The run then goes on WITHOUT a checkpoint, and a late start is stopped by its own
   * token in the background. Never throws. Call before the run touches the browser.
   */
  begin(): Promise<boolean>;
  /**
   * Ends recording. Returns `undefined` ONLY for a deliberate skip: the helper is disabled, the status is
   * `setup_failed` or `aborted`, or `steps` is not above 0. Otherwise it returns a `CheckpointResult`: the capture, or
   * `{ ok: false, error }`. When the journal did not start, `error` is the recorder's own reason (unsupported browser,
   * failed or timed-out start), or `CHECKPOINT_NOT_STARTED_ERROR` for a begin abort or a missing `begin()`; so a host
   * callback always hears that the run ended without a checkpoint. A capture already taken is returned even when the
   * signal aborted meanwhile: a host that must not keep a checkpoint after an abort checks its signal after `finish()`.
   * Then runs `beforeStop(captured)` (for example the host callback that receives the capture and the fixture
   * release: capture, callback, release, stop), always stops the journal, and waits for the stop at most
   * `stopWaitMs`. Never throws. Idempotent: a second call returns the first answer.
   */
  finish(
    result: { status: BrowseAgentStatus | string; steps: number },
    opts?: { beforeStop?: (captured: CheckpointResult | undefined) => Promise<unknown> | unknown },
  ): Promise<CheckpointResult | undefined>;
  /**
   * One promise, the same object every time, readable before `finish()`. Resolves exactly once, when the journal's
   * calls (start, the stop of a late start, stop) have settled, or at the latest `settleCapMs` (default
   * `CHECKPOINT_SETTLE_CAP_MS`) after the stop was requested when the browser does not answer (best effort). Resolves at
   * once when nothing was ever started (disabled, pre-aborted). Never rejects.
   */
  readonly settled: Promise<void>;
}

/**
 * The run-end checkpoint lifecycle in ONE place, used by `runBrowseAgent` and by hosts that drive
 * `createBrowseAgentSession` themselves: bounded start, the capture conditions, release before stop, bounded stop wait.
 */
export function createRunCheckpoint(browser: BrowserBridge, opts: RunCheckpointOptions = {}): RunCheckpoint {
  const { enabled = true, signal, startWaitMs = CHECKPOINT_START_WAIT_MS, stopWaitMs = CHECKPOINT_STOP_WAIT_MS, settleCapMs, ...recorderOpts } = opts;
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => { settle = resolve; });

  if (!enabled) {
    // No recorder, no timer: nothing is ever started.
    settle();
    return {
      begin: async () => false,
      async finish(_result, fopts = {}) {
        try {
          await fopts.beforeStop?.(undefined);
        } catch {
          // A failing release or callback cannot change the result of the run.
        }
        return undefined;
      },
      settled,
    };
  }

  const timeoutMs = recorderOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const recorder = createCheckpointRecorder(browser, { ...recorderOpts, startTimeoutMs: Math.min(timeoutMs, startWaitMs) });
  const settleCap = settleCapMs ?? 2 * timeoutMs;
  let stopP: Promise<void> | undefined;
  let beginP: Promise<boolean> | undefined;
  let finishP: Promise<CheckpointResult | undefined> | undefined;
  let finishCalled = false;

  const stopOnce = (): Promise<void> => (stopP ??= recorder.stop().catch(() => undefined));
  /** Requests the stop, then waits for every journal call to really settle, but no longer than the cap. Resolves `settled`. */
  const markStopped = (): void => {
    void stopOnce()
      .then(() => boundedCall(() => recorder.idle(), settleCap))
      .then(() => settle(), () => settle());
  };

  function begin(): Promise<boolean> {
    return (beginP ??= (async () => {
      if (finishCalled || signal?.aborted) {
        if (signal?.aborted) markStopped();
        return false;
      }
      const startP = recorder.start().catch(() => undefined);
      let onAbort: (() => void) | undefined;
      try {
        const aborted = new Promise<"aborted">((resolve) => {
          if (!signal) return;
          onAbort = () => resolve("aborted");
          signal.addEventListener("abort", onAbort, { once: true });
        });
        // The recorder bounds the start itself (min of timeoutMs and startWaitMs): only the abort is raced here.
        const outcome = await Promise.race([startP, aborted]);
        if (outcome !== "aborted" && !signal?.aborted && recorder.started()) return true;
      } catch {
        // fall through: no checkpoint
      } finally {
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      }
      // A start that answers later is stopped by its token (the recorder does it once stop() ran).
      markStopped();
      return false;
    })());
  }

  function finish(
    result: { status: BrowseAgentStatus | string; steps: number },
    fopts: { beforeStop?: (captured: CheckpointResult | undefined) => Promise<unknown> | unknown } = {},
  ): Promise<CheckpointResult | undefined> {
    finishCalled = true;
    return (finishP ??= (async () => {
      let captured: CheckpointResult | undefined;
      try {
        const began = beginP ? await beginP : false;
        const skip = (NON_CAPTURABLE_STATUSES as readonly string[]).includes(result.status) || !(result.steps > 0);
        if (!skip) {
          captured = began ? await recorder.capture() : { ok: false, error: recorder.startError() ?? CHECKPOINT_NOT_STARTED_ERROR };
        }
        try {
          await fopts.beforeStop?.(captured);
        } catch {
          // A failing release or callback cannot change the result of the run, and the stop must still run.
        }
      } finally {
        try {
          // The RESULT waits for the stop only a moment: a hung browser must not hold a finished run.
          await boundedCall(() => stopOnce(), stopWaitMs);
        } catch {
          // ignore
        }
        markStopped();
      }
      return captured;
    })());
  }

  return { begin, finish, settled };
}
