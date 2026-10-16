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
import { browseAgentErrorMessage } from "./result.js";

const DEFAULT_TIMEOUT_MS = 15_000;

export interface CheckpointRecorderOptions extends CheckpointJournalOptions {
  /** Bound for one journal call (start, capture, stop). Default 15 s: a hung browser must not hold the result of a finished run. */
  timeoutMs?: number;
}

export interface CheckpointRecorder {
  /** Starts the journal. Never throws: a failure is kept and `capture()` reports it. Idempotent. */
  start(): Promise<void>;
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
  let startError: string | undefined;
  let started = false;
  /** startJournal was called: only then is there a journal to stop. */
  let journalCalled = false;
  /** startJournal resolved. `token` is undefined for a bridge that predates tokens. */
  let startSettled = false;
  let startRejected = false;
  let token: string | undefined;
  let stopped = false;

  /** Stops with `t` (no token: whatever runs, the old bridges' behavior). Bounded, never throws. */
  async function stopWith(t: string | undefined): Promise<void> {
    try {
      await boundedCall(() => browser.stopJournal!(t), timeoutMs);
    } catch {
      // A failed stop cannot change the result of the run.
    }
  }

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    if (!browser.startJournal || !browser.stopJournal || !browser.captureCheckpoint) {
      startError = "This browser does not support checkpoints (BrowserBridge.startJournal, stopJournal or captureCheckpoint is missing).";
      return;
    }
    journalCalled = true;
    const origins = opts.origins ? { origins: opts.origins } : undefined;
    const call = Promise.resolve().then(() => browser.startJournal!(origins));
    // A start that answers AFTER the timeout or after stop() must not leave its journal running: it is stopped with its own token.
    call.then(
      (t) => {
        startSettled = true;
        if (typeof t === "string") token = t;
        if (stopped) void stopWith(typeof t === "string" ? t : undefined);
      },
      () => { startRejected = true; },
    );
    try {
      const outcome = await boundedCall(() => call, timeoutMs);
      if (!outcome.done) startError = "Starting the checkpoint journal timed out.";
    } catch (err) {
      startError = `Starting the checkpoint journal failed: ${browseAgentErrorMessage(err)}`;
    }
  }

  async function capture(): Promise<CheckpointResult> {
    if (!started) await start();
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

  return { start, capture, stop };
}
