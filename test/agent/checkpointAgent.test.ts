import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { runBrowseAgent } from "../../src/agent/aiSdk.js";
import { createCheckpointRecorder, normalizeCheckpoint } from "../../src/agent/checkpoint.js";
import type { BrowserBridge } from "../../src/loop/bridge.js";
import type { CheckpointResult, PageFixture } from "../../src/fixture/types.js";

const COOKIE = "sentinel-cookie-ag1";
const STORE = "sentinel-storage-ag2";
const TYPED = "sentinel-typed-ag3";

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 4, text: 4, reasoning: undefined },
};

function recordingModel(opts: { fail?: boolean } = {}) {
  const prompts: unknown[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options: { prompt?: unknown }) => {
      prompts.push(options.prompt);
      if (opts.fail) throw new Error("model down");
      return {
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage,
        warnings: [] as never[],
        content: [{ type: "text", text: "done" }],
      } as never;
    },
  });
  return { model, prompts };
}

const SECRET_FIXTURE: PageFixture = {
  version: 1,
  url: "https://shop.test/cart",
  storage: {
    cookies: [{ name: "sid", value: COOKIE, domain: "shop.test" }],
    origins: [{ origin: "https://shop.test", localStorage: { token: STORE } }],
  },
  steps: [{ action: "type", selector: "#pw", text: TYPED }, { action: "click", selector: "#buy" }],
};

const GOOD = {
  ok: true,
  fixture: SECRET_FIXTURE,
  complete: true,
  summary: "checkpoint: start page https://shop.test/cart; 1 cookie; storage for 1 origin; 2 replayable steps (1 type, 1 click)",
  // Fields a bridge adds on its own are dropped.
  dialogs: [{ type: "alert" }],
};

function bridge(log: string[], over: Partial<BrowserBridge> = {}): BrowserBridge {
  return {
    open: async (a) => { log.push("open"); return { url: a.url }; },
    act: async () => ({}),
    read: async () => ({}),
    snapshot: async () => ({ snapshotId: "s1", url: "https://shop.test/cart", title: "Cart", elements: [] }),
    perform: async () => ({}),
    applyFixture: async () => { log.push("apply"); return { ok: true, url: "https://shop.test/cart", title: "Cart", summary: "1 cookie" }; },
    startJournal: () => { log.push("startJournal"); },
    stopJournal: () => { log.push("stopJournal"); },
    captureCheckpoint: async () => { log.push("captureCheckpoint"); return GOOD; },
    ...over,
  };
}

/** Runs the agent with the checkpoint callback; `captured` holds every call. */
async function runWith(
  browser: BrowserBridge,
  model: ReturnType<typeof recordingModel>["model"],
  extra: Record<string, unknown> = {},
  origins?: string[],
) {
  const captured: CheckpointResult[] = [];
  const result = await runBrowseAgent("buy it", {
    model,
    browser,
    checkpoint: { ...(origins ? { origins } : {}), onCapture: (r) => { captured.push(r); } },
    ...extra,
  });
  return { result, captured };
}

describe("runBrowseAgent({ checkpoint: { onCapture } })", () => {
  it("starts the journal before the start URL, captures at the end, stops in finally", async () => {
    const log: string[] = [];
    const { model } = recordingModel();
    const { result, captured } = await runWith(bridge(log), model, { url: "https://shop.test/cart" });
    expect(log).toEqual(["startJournal", "open", "captureCheckpoint", "stopJournal"]);
    expect(result.status).toBe("done");
    expect(captured).toEqual([{ ok: true, fixture: SECRET_FIXTURE, complete: true, summary: GOOD.summary }]);
  });

  it("starts before a fixture setup too", async () => {
    const log: string[] = [];
    const { model } = recordingModel();
    const { result, captured } = await runWith(bridge(log), model, { fixture: { version: 1, url: "https://shop.test/cart" } });
    expect(log.slice(0, 2)).toEqual(["startJournal", "apply"]);
    expect(result.status).toBe("done");
    expect(captured[0]?.ok).toBe(true);
  });

  it("passes { origins } to the journal", async () => {
    let seen: unknown = "unset";
    const { model } = recordingModel();
    await runWith(bridge([], { startJournal: (o) => { seen = o; } }), model, {}, ["https://shop.test"]);
    expect(seen).toEqual({ origins: ["https://shop.test"] });
  });

  it("never puts the checkpoint into text the model reads, and not into the result at all (item 11)", async () => {
    const log: string[] = [];
    const { model, prompts } = recordingModel();
    const { result, captured } = await runWith(bridge(log), model, { url: "https://shop.test/cart" });
    expect(captured[0]?.ok).toBe(true);
    const seen = JSON.stringify(prompts);
    for (const secret of [COOKIE, STORE, TYPED, "checkpoint", "replayable"]) expect(seen).not.toContain(secret);
    // One JSON.stringify(result) away from the model is too close: the result holds no checkpoint field and no secret.
    expect("checkpoint" in result).toBe(false);
    for (const secret of [COOKIE, STORE, TYPED]) expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("onCapture is called exactly once, and a throwing callback does not change the result", async () => {
    const { model } = recordingModel();
    let calls = 0;
    const result = await runBrowseAgent("buy it", {
      model,
      browser: bridge([]),
      url: "https://shop.test/cart",
      checkpoint: { onCapture: () => { calls += 1; throw new Error("host bug"); } },
    });
    expect(result.status).toBe("done");
    expect(calls).toBe(1);
  });

  it("is captured after an error status too", async () => {
    const log: string[] = [];
    const { model } = recordingModel({ fail: true });
    const { result, captured } = await runWith(bridge(log), model, { url: "https://shop.test/cart" });
    expect(result.status).toBe("error");
    expect(captured[0]?.ok).toBe(true);
    expect(log.at(-1)).toBe("stopJournal");
  });

  it("is NOT taken after an abort (the host walked away), but the journal is stopped", async () => {
    const log: string[] = [];
    const { model } = recordingModel();
    const controller = new AbortController();
    controller.abort();
    const { result, captured } = await runWith(bridge(log), model, { signal: controller.signal });
    expect(result.status).toBe("aborted");
    expect(captured).toEqual([]);
    // A signal aborted before the run starts nothing: the browser is not called.
    expect(log).toEqual([]);
  });

  it("an abort DURING the run takes no capture, but the journal is stopped", async () => {
    const log: string[] = [];
    const { model } = recordingModel();
    const controller = new AbortController();
    const { result, captured } = await runWith(
      bridge(log, { open: async (a) => { log.push("open"); controller.abort(); return { url: a.url }; } }),
      model,
      { signal: controller.signal, url: "https://shop.test/cart" },
    );
    expect(result.status).toBe("aborted");
    expect(captured).toEqual([]);
    expect(log).toEqual(["startJournal", "open", "stopJournal"]);
  });

  it("is NOT taken when no browser command ran (a call without a goal): the journal is still stopped", async () => {
    const log: string[] = [];
    const { model } = recordingModel();
    const captured: CheckpointResult[] = [];
    const result = await runBrowseAgent("   ", { model, browser: bridge(log), checkpoint: { onCapture: (r) => { captured.push(r); } } });
    expect(result).toMatchObject({ status: "error", error: "goal is required", steps: 0 });
    expect(captured).toEqual([]);
    expect(log).toEqual(["startJournal", "stopJournal"]);
  });

  it("a hung stopJournal does not hold the result of the run for more than a moment", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { model } = recordingModel();
      const log: string[] = [];
      const hang = () => new Promise<never>(() => {});
      const controller = new AbortController();
      let done = false;
      const run = runWith(bridge(log, { stopJournal: hang, open: async (a) => { controller.abort(); return { url: a.url }; } }), model, { signal: controller.signal, url: "https://shop.test/cart" }).then((r) => { done = true; return r; });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(done).toBe(true);
      expect((await run).result.status).toBe("aborted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a rejecting async onCapture is not an unhandled rejection, and does not change the result", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", listener);
    try {
      const { model } = recordingModel();
      let calls = 0;
      const result = await runBrowseAgent("buy it", {
        model,
        browser: bridge([]),
        url: "https://shop.test/cart",
        checkpoint: { onCapture: async () => { calls += 1; throw new Error("async host bug"); } },
      });
      // Give a stray rejection the time to surface.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(result.status).toBe("done");
      expect(calls).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("is NOT taken after setup_failed, but the journal is still stopped", async () => {
    const log: string[] = [];
    const { model } = recordingModel();
    const { result, captured } = await runWith(bridge(log, { applyFixture: async () => ({ ok: false, stage: "expect", error: "expect failed" }) }), model, {
      fixture: { version: 1, url: "https://shop.test/cart" },
    });
    expect(result.status).toBe("setup_failed");
    expect(captured).toEqual([]);
    expect(log).toEqual(["startJournal", "stopJournal"]);
  });

  it("a bridge without the journal methods gives { ok: false, error }, not a failed run", async () => {
    const log: string[] = [];
    const { model } = recordingModel();
    const b = bridge(log);
    delete b.captureCheckpoint;
    const { result, captured } = await runWith(b, model, { url: "https://shop.test/cart" });
    expect(result.status).toBe("done");
    expect(captured[0]).toMatchObject({ ok: false });
    expect((captured[0] as { error: string }).error).toContain("does not support checkpoints");
    expect(log).toEqual(["open"]);
  });

  it("a journal that fails to start gives { ok: false, error } and the run goes on", async () => {
    const { model } = recordingModel();
    const { result, captured } = await runWith(bridge([], { startJournal: () => { throw new Error("no journal today"); } }), model, { url: "https://shop.test/cart" });
    expect(result.status).toBe("done");
    expect(captured[0]).toEqual({ ok: false, error: "Starting the checkpoint journal failed: no journal today" });
  });

  it("a failing capture gives { ok: false, error }", async () => {
    const { model } = recordingModel();
    const { result, captured } = await runWith(bridge([], { captureCheckpoint: async () => { throw new Error("browser gone"); } }), model, { url: "https://shop.test/cart" });
    expect(result.status).toBe("done");
    expect(captured[0]).toEqual({ ok: false, error: "Taking the checkpoint failed: browser gone" });
  });

  it("a start slower than the wait still reaches onCapture as { ok: false }", async () => {
    vi.useFakeTimers();
    try {
      const { model } = recordingModel();
      const captured: CheckpointResult[] = [];
      const p = runBrowseAgent("buy it", {
        model,
        browser: bridge([], { startJournal: () => new Promise<string>(() => undefined) }),
        url: "https://shop.test/cart",
        checkpoint: { onCapture: (r) => { captured.push(r); } },
      });
      await vi.advanceTimersByTimeAsync(6_000);
      await p;
      expect(captured).toEqual([{ ok: false, error: "Starting the checkpoint journal timed out." }]);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("fixture release", () => {
    const fixture: PageFixture = { version: 1, url: "https://shop.test/cart" };
    const withRelease = (log: string[]) => bridge(log, {
      applyFixture: async () => ({ ok: true, summary: "s", fixtureToken: "ft" }),
      releaseFixture: async () => { log.push("release"); },
    });

    it("without checkpoint the fixture is released exactly once", async () => {
      const log: string[] = [];
      const { model } = recordingModel();
      await runBrowseAgent("buy it", { model, browser: withRelease(log), fixture });
      expect(log.filter((l) => l === "release")).toHaveLength(1);
      expect(log).not.toContain("startJournal");
    });

    it("with checkpoint the order is capture, onCapture, release, stop", async () => {
      const log: string[] = [];
      const { model } = recordingModel();
      await runBrowseAgent("buy it", {
        model,
        browser: withRelease(log),
        fixture,
        checkpoint: { onCapture: () => { log.push("onCapture"); } },
      });
      expect(log.filter((l) => l !== "apply" && l !== "open")).toEqual(["startJournal", "captureCheckpoint", "onCapture", "release", "stopJournal"]);
    });
  });

  it("without the option nothing about the journal runs and the result has no checkpoint field", async () => {
    const log: string[] = [];
    const { model } = recordingModel();
    const result = await runBrowseAgent("buy it", { model, browser: bridge(log), url: "https://shop.test/cart" });
    expect(log).toEqual(["open"]);
    expect(Object.keys(result)).toEqual(["status", "answer", "steps"]);
  });
});

describe("createCheckpointRecorder", () => {
  it("a capture that never answers times out; a stop that never answers is dropped", async () => {
    const hang = () => new Promise<never>(() => {});
    const rec = createCheckpointRecorder(bridge([], { captureCheckpoint: hang, stopJournal: hang }), { timeoutMs: 20 });
    await rec.start();
    expect(await rec.capture()).toEqual({ ok: false, error: "Taking the checkpoint timed out." });
    await rec.stop();
  });

  it("stop is idempotent and does nothing before start", async () => {
    const log: string[] = [];
    const rec = createCheckpointRecorder(bridge(log));
    await rec.stop();
    await rec.start();
    await rec.stop();
    await rec.stop();
    expect(log).toEqual(["startJournal", "stopJournal"]);
  });
});

describe("createCheckpointRecorder owns its journal (item 8)", () => {
  it("keeps the token startJournal returned and passes it to capture and stop", async () => {
    const seen: string[] = [];
    const rec = createCheckpointRecorder(bridge([], {
      startJournal: () => "tok-1",
      captureCheckpoint: async (t) => { seen.push(`capture ${String(t)}`); return GOOD; },
      stopJournal: (t) => { seen.push(`stop ${String(t)}`); },
    }));
    await rec.start();
    expect((await rec.capture()).ok).toBe(true);
    await rec.stop();
    expect(seen).toEqual(["capture tok-1", "stop tok-1"]);
  });

  it("a bridge that returns no token (older) is stopped without one", async () => {
    const seen: unknown[] = [];
    const rec = createCheckpointRecorder(bridge([], { stopJournal: (t) => { seen.push(t); } }));
    await rec.start();
    await rec.stop();
    expect(seen).toEqual([undefined]);
  });

  it("a start that answers after the timeout and after stop() is stopped with its own token at once", async () => {
    const stops: unknown[] = [];
    let answer!: (t: string) => void;
    const rec = createCheckpointRecorder(
      bridge([], {
        startJournal: () => new Promise<string>((resolve) => { answer = resolve; }),
        stopJournal: (t) => { stops.push(t); },
      }),
      { timeoutMs: 20 },
    );
    await rec.start();
    expect(await rec.capture()).toEqual({ ok: false, error: "Starting the checkpoint journal timed out." });
    await rec.stop();
    // Not yet: there is no token to stop (and stopping without one could kill another owner's journal).
    expect(stops).toEqual([]);
    answer("late-token");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stops).toEqual(["late-token"]);
  });

  it("a start that failed leaves nothing to stop", async () => {
    const stops: unknown[] = [];
    const rec = createCheckpointRecorder(bridge([], { startJournal: () => { throw new Error("no"); }, stopJournal: (t) => { stops.push(t); } }));
    await rec.start();
    await rec.stop();
    expect(stops).toEqual([]);
  });
});

describe("normalizeCheckpoint", () => {
  it("keeps only the checkpoint fields and validates the fixture", () => {
    expect(normalizeCheckpoint(GOOD)).toEqual({ ok: true, fixture: SECRET_FIXTURE, complete: true, summary: GOOD.summary });
    expect(normalizeCheckpoint({ ...GOOD, complete: false, gap: "g" })).toMatchObject({ complete: false, gap: "g" });
  });

  it("turns anything else into { ok: false, error }", () => {
    expect(normalizeCheckpoint(null)).toMatchObject({ ok: false });
    expect(normalizeCheckpoint({ ok: false, error: "nope" })).toEqual({ ok: false, error: "nope" });
    const bad = normalizeCheckpoint({ ok: true, fixture: { version: 2 }, complete: true, summary: "s" });
    expect(bad).toMatchObject({ ok: false });
    // The parse error names a path, never a value.
    expect(JSON.stringify(normalizeCheckpoint({ ok: true, fixture: { version: 1, storage: { cookies: [{ name: "a", value: COOKIE }] } }, summary: "s" }))).not.toContain(COOKIE);
  });
});
