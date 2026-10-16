import { afterEach, describe, expect, it, vi } from "vitest";
import { CHECKPOINT_NOT_STARTED_ERROR, CHECKPOINT_SETTLE_CAP_MS, CHECKPOINT_START_WAIT_MS, CHECKPOINT_STOP_WAIT_MS, createRunCheckpoint } from "../../src/agent/checkpoint.js";
import type { BrowserBridge } from "../../src/loop/bridge.js";
import { stubBrowser } from "../loop/helpers.js";

const GOOD = { ok: true, fixture: { version: 1, url: "https://a.test/" }, complete: true, summary: "checkpoint taken" };

/** stubBrowser with the journal methods; every call is logged. `over` replaces any of them. */
function bridge(log: string[], over: Partial<BrowserBridge> = {}): BrowserBridge {
  return stubBrowser({
    startJournal: () => { log.push("start"); return "tok"; },
    stopJournal: (t?: string) => { log.push(`stop:${t}`); },
    captureCheckpoint: async () => { log.push("capture"); return GOOD; },
    ...over,
  });
}

const RUN = { status: "completed", steps: 2 };
const never = () => new Promise<never>(() => undefined);

afterEach(() => vi.useRealTimers());

describe("createRunCheckpoint begin", () => {
  it("is true when the start answers in time", async () => {
    const log: string[] = [];
    expect(await createRunCheckpoint(bridge(log)).begin()).toBe(true);
    expect(log).toEqual(["start"]);
  });

  it("is false after startWaitMs, and the late start is stopped by its token", async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    let answer!: (t: string) => void;
    const cp = createRunCheckpoint(bridge(log, { startJournal: () => new Promise<string>((r) => { answer = r; }) }));
    const p = cp.begin();
    await vi.advanceTimersByTimeAsync(CHECKPOINT_START_WAIT_MS + 1);
    expect(await p).toBe(false);
    answer("late");
    await vi.advanceTimersByTimeAsync(0);
    await cp.settled;
    expect(log).toEqual(["stop:late"]);
    expect(await cp.finish(RUN)).toEqual({ ok: false, error: "Starting the checkpoint journal timed out." });
    expect(log).toEqual(["stop:late"]);
  });

  it("settled waits for the stop of a start that answered after timeoutMs", async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    let answer!: (t: string) => void;
    let releaseStop!: () => void;
    const cp = createRunCheckpoint(bridge(log, {
      startJournal: () => new Promise<string>((r) => { answer = r; }),
      stopJournal: (t?: string) => new Promise<void>((r) => { log.push(`stop:${t}`); releaseStop = r; }),
    }));
    const p = cp.begin();
    await vi.advanceTimersByTimeAsync(CHECKPOINT_START_WAIT_MS + 1);
    expect(await p).toBe(false);
    let settled = false;
    void cp.settled.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    answer("late");
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(["stop:late"]);
    expect(settled).toBe(false);
    releaseStop();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
  });

  it("settled waits for a stop that merely timed out, until it really answers", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const cp = createRunCheckpoint(bridge([], { stopJournal: () => new Promise<void>((r) => { release = r; }) }), { timeoutMs: 1_000, settleCapMs: 60_000 });
    await cp.begin();
    const fin = cp.finish(RUN);
    await vi.advanceTimersByTimeAsync(1_001);
    await fin;
    let settled = false;
    void cp.settled.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
  });

  it("begin after finish does not start a journal", async () => {
    const log: string[] = [];
    const cp = createRunCheckpoint(bridge(log));
    expect(await cp.finish(RUN)).toEqual({ ok: false, error: CHECKPOINT_NOT_STARTED_ERROR });
    expect(await cp.begin()).toBe(false);
    await cp.settled;
    expect(log).toEqual([]);
  });

  it("is false on an abort during the start; the late start is stopped by its token", async () => {
    const log: string[] = [];
    const ac = new AbortController();
    let answer!: (t: string) => void;
    const cp = createRunCheckpoint(bridge(log, { startJournal: () => new Promise<string>((r) => { answer = r; }) }), { signal: ac.signal });
    const p = cp.begin();
    ac.abort();
    expect(await p).toBe(false);
    answer("t1");
    await cp.settled;
    expect(log).toEqual(["stop:t1"]);
  });

  it("is false for an already aborted signal WITHOUT calling the browser, and settled resolves", async () => {
    const log: string[] = [];
    const ac = new AbortController();
    ac.abort();
    const cp = createRunCheckpoint(bridge(log), { signal: ac.signal });
    expect(await cp.begin()).toBe(false);
    await cp.settled;
    expect(log).toEqual([]);
  });

  it("one start timeout: the smaller of timeoutMs and startWaitMs", async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const cp = createRunCheckpoint(bridge(log, { startJournal: never }), { timeoutMs: 100, startWaitMs: 5_000 });
    const p = cp.begin();
    await vi.advanceTimersByTimeAsync(101);
    expect(await p).toBe(false);
    expect(await cp.finish(RUN)).toEqual({ ok: false, error: "Starting the checkpoint journal timed out." });
    expect(log).not.toContain("capture");
  });

  it("is false for a failed start, and finish returns the recorder's error without a capture", async () => {
    const log: string[] = [];
    const cp = createRunCheckpoint(bridge(log, { startJournal: () => { throw new Error("no journal today"); } }));
    expect(await cp.begin()).toBe(false);
    expect(await cp.finish(RUN)).toEqual({ ok: false, error: "Starting the checkpoint journal failed: no journal today" });
    expect(log).not.toContain("capture");
  });

  it("is false when the bridge has no journal", async () => {
    const cp = createRunCheckpoint(stubBrowser());
    expect(await cp.begin()).toBe(false);
    expect(await cp.finish(RUN)).toMatchObject({ ok: false, error: expect.stringContaining("does not support checkpoints") });
  });
});

describe("createRunCheckpoint finish", () => {
  it("captures, runs beforeStop with the capture, then stops, in that order", async () => {
    const log: string[] = [];
    const cp = createRunCheckpoint(bridge(log));
    await cp.begin();
    const r = await cp.finish(RUN, { beforeStop: (c) => { log.push(`before:${c?.ok}`); } });
    expect(r).toMatchObject({ ok: true });
    expect(log).toEqual(["start", "capture", "before:true", "stop:tok"]);
  });

  it.each([
    ["setup_failed", { status: "setup_failed", steps: 3 }],
    ["aborted", { status: "aborted", steps: 3 }],
    ["no steps", { status: "completed", steps: 0 }],
  ])("takes no capture for %s, still releases and stops", async (_n, res) => {
    const log: string[] = [];
    const cp = createRunCheckpoint(bridge(log));
    await cp.begin();
    expect(await cp.finish(res, { beforeStop: () => { log.push("before"); } })).toBeUndefined();
    expect(log).toEqual(["start", "before", "stop:tok"]);
  });

  it("keeps a capture taken while the signal aborted (the host checks its own signal)", async () => {
    const log: string[] = [];
    const ac = new AbortController();
    const cp = createRunCheckpoint(bridge(log, { captureCheckpoint: async () => { ac.abort(); return GOOD; } }), { signal: ac.signal });
    await cp.begin();
    let seen: unknown;
    expect(await cp.finish(RUN, { beforeStop: (c) => { seen = c; } })).toMatchObject({ ok: true });
    expect(seen).toMatchObject({ ok: true });
    expect(log).toEqual(["start", "stop:tok"]);
  });

  it("without begin: finish reports the journal did not start, beforeStop runs, settled resolves", async () => {
    const log: string[] = [];
    const cp = createRunCheckpoint(bridge(log));
    let seen: unknown;
    expect(await cp.finish(RUN, { beforeStop: (c) => { log.push("before"); seen = c; } })).toEqual({ ok: false, error: CHECKPOINT_NOT_STARTED_ERROR });
    expect(seen).toEqual({ ok: false, error: CHECKPOINT_NOT_STARTED_ERROR });
    await cp.settled;
    expect(log).toEqual(["before"]);
  });

  it("a throwing capture still stops the journal and gives { ok: false }", async () => {
    const log: string[] = [];
    const cp = createRunCheckpoint(bridge(log, { captureCheckpoint: async () => { throw new Error("gone"); } }));
    await cp.begin();
    expect(await cp.finish(RUN)).toMatchObject({ ok: false });
    expect(log).toEqual(["start", "stop:tok"]);
    await cp.settled;
  });

  it("settled read before finish stays pending until the journal is stopped, and is one promise", async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    let release!: () => void;
    const cp = createRunCheckpoint(bridge(log, { stopJournal: () => new Promise<void>((r) => { release = r; }) }));
    const early = cp.settled;
    expect(cp.settled).toBe(early);
    let settled = false;
    void early.then(() => { settled = true; });
    await cp.begin();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    void cp.finish(RUN);
    await vi.advanceTimersByTimeAsync(CHECKPOINT_STOP_WAIT_MS + 1);
    expect(settled).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect(cp.settled).toBe(early);
  });

  it("disabled: begin is false without touching the browser, finish runs beforeStop(undefined), settled resolves", async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const cp = createRunCheckpoint(bridge(log), { enabled: false });
    expect(vi.getTimerCount()).toBe(0);
    expect(await cp.begin()).toBe(false);
    let seen: unknown = "unset";
    expect(await cp.finish(RUN, { beforeStop: (c) => { log.push("before"); seen = c; } })).toBeUndefined();
    expect(seen).toBeUndefined();
    await cp.settled;
    expect(vi.getTimerCount()).toBe(0);
    expect(log).toEqual(["before"]);
  });

  it("swallows a beforeStop throw and rejection, and still stops", async () => {
    for (const before of [() => { throw new Error("x"); }, () => Promise.reject(new Error("y"))]) {
      const log: string[] = [];
      const cp = createRunCheckpoint(bridge(log));
      await cp.begin();
      expect(await cp.finish(RUN, { beforeStop: before })).toMatchObject({ ok: true });
      expect(log).toContain("stop:tok");
    }
  });

  it("is idempotent", async () => {
    const log: string[] = [];
    const cp = createRunCheckpoint(bridge(log));
    await cp.begin();
    const a = await cp.finish(RUN, { beforeStop: () => { log.push("before"); } });
    const b = await cp.finish(RUN, { beforeStop: () => { log.push("before2"); } });
    expect(b).toBe(a);
    expect(log).toEqual(["start", "capture", "before", "stop:tok"]);
  });

  it("returns within stopWaitMs when the stop hangs; settled resolves once the stop ends", async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    let release!: () => void;
    const cp = createRunCheckpoint(bridge(log, { stopJournal: () => new Promise<void>((r) => { release = r; }) }));
    await cp.begin();
    let done = false;
    const p = cp.finish(RUN).then((r) => { done = true; return r; });
    await vi.advanceTimersByTimeAsync(CHECKPOINT_STOP_WAIT_MS + 1);
    expect(done).toBe(true);
    expect(await p).toMatchObject({ ok: true });
    let settled = false;
    void cp.settled.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
  });

  it("a stop that never answers: settled resolves at the cap, not before", async () => {
    vi.useFakeTimers();
    const cp = createRunCheckpoint(bridge([], { stopJournal: never }), { timeoutMs: 1_000 });
    await cp.begin();
    const p = cp.finish(RUN);
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(p).resolves.toMatchObject({ ok: true });
    let settled = false;
    void cp.settled.then(() => { settled = true; });
    // The cap is 2 x timeoutMs = 2 s from the stop request.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(true);
    expect(CHECKPOINT_SETTLE_CAP_MS).toBe(30_000);
  });

  it("skips when steps is NaN", async () => {
    const log: string[] = [];
    const cp = createRunCheckpoint(bridge(log));
    await cp.begin();
    expect(await cp.finish({ status: "done", steps: Number.NaN })).toBeUndefined();
  });
});
