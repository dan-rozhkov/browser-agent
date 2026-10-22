import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { runBrowseAgent } from "../../src/agent/aiSdk.js";
import * as sessionEntry from "../../src/agent/sessionEntry.js";
import { createFixtureSetup, createBrowseAgentSession, SetupError, unmatchedMocks } from "../../src/agent/sessionEntry.js";
import type { BrowserBridge } from "../../src/loop/bridge.js";
import type { PageFixture } from "../../src/fixture/types.js";

const fixture: PageFixture = { version: 1, url: "https://a.test/", network: [{ url: "https://a.test/api", status: 200, body: "{}" }] };
const noNet: PageFixture = { version: 1, url: "https://a.test/" };
const sig = () => new AbortController().signal;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function bridge(over: Partial<BrowserBridge> = {}): BrowserBridge {
  return {
    open: async () => ({}),
    act: async () => ({}),
    read: async () => ({}),
    snapshot: async () => ({ snapshotId: "s1", url: "https://a.test/", title: "A", elements: [] }),
    perform: async () => ({}),
    applyFixture: async () => ({ ok: true, summary: "1 mock", fixtureToken: "tok" }),
    releaseFixture: async () => ({}),
    ...over,
  };
}

const opts = (extra: object = {}) => ({ allowNetworkMocks: true, snapshot: async () => "SNAP", ...extra });

describe("createFixtureSetup", () => {
  it("applies, reports mockCount and releases the token once", async () => {
    const releaseFixture = vi.fn(async () => ({}));
    const onApplied = vi.fn();
    const fs = createFixtureSetup(bridge({ releaseFixture }), fixture, opts({ onApplied }));
    const text = await fs.setup({ signal: sig() });
    expect(text).toContain("1 mock");
    expect(text).toContain("SNAP");
    expect(onApplied).toHaveBeenCalledWith({ mockCount: 1 });
    await fs.release();
    await fs.release();
    expect(releaseFixture).toHaveBeenCalledTimes(1);
    expect(releaseFixture).toHaveBeenCalledWith("tok");
  });

  it("mockCount is 0 without network rules", async () => {
    const onApplied = vi.fn();
    await createFixtureSetup(bridge(), noNet, opts({ onApplied })).setup({ signal: sig() });
    expect(onApplied).toHaveBeenCalledWith({ mockCount: 0 });
  });

  it("an apply failure throws SetupError(stage) and nothing is released", async () => {
    const releaseFixture = vi.fn(async () => ({}));
    const onApplied = vi.fn();
    const fs = createFixtureSetup(bridge({ releaseFixture, applyFixture: async () => ({ ok: false, stage: "cookies", error: "bad" }) }), fixture, opts({ onApplied }));
    const err = await fs.setup({ signal: sig() }).catch((e) => e);
    expect(err).toBeInstanceOf(SetupError);
    expect(err.stage).toBe("cookies");
    await fs.release();
    expect(releaseFixture).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("refuses missing applyFixture and mocks without releaseFixture", async () => {
    const a = await createFixtureSetup(bridge({ applyFixture: undefined }), noNet, opts()).setup({ signal: sig() }).catch((e) => e);
    expect(a).toBeInstanceOf(SetupError);
    expect(a.stage).toBeUndefined();
    const b = await createFixtureSetup(bridge({ releaseFixture: undefined }), fixture, opts()).setup({ signal: sig() }).catch((e) => e);
    expect(b.stage).toBe("network");
  });

  it("release before setup is a no-op", async () => {
    const releaseFixture = vi.fn(async () => ({}));
    await createFixtureSetup(bridge({ releaseFixture }), fixture, opts()).release();
    expect(releaseFixture).not.toHaveBeenCalled();
  });

  it("a late apply is released right away and onApplied is not called", async () => {
    const d = deferred<unknown>();
    const releaseFixture = vi.fn(async () => ({}));
    const onApplied = vi.fn();
    const fs = createFixtureSetup(bridge({ releaseFixture, applyFixture: () => d.promise }), fixture, opts({ onApplied }));
    const pending = fs.setup({ signal: sig() });
    await fs.release(); // does not wait for the apply
    expect(releaseFixture).not.toHaveBeenCalled();
    d.resolve({ ok: true, summary: "s", fixtureToken: "late" });
    await pending;
    expect(releaseFixture).toHaveBeenCalledTimes(1);
    expect(releaseFixture).toHaveBeenCalledWith("late");
    expect(onApplied).not.toHaveBeenCalled();
    await fs.release();
    expect(releaseFixture).toHaveBeenCalledTimes(1);
  });

  it("release is bounded on a hanging bridge", async () => {
    const fs = createFixtureSetup(bridge({ releaseFixture: () => new Promise(() => {}) }), fixture, opts({ releaseTimeoutMs: 20 }));
    await fs.setup({ signal: sig() });
    const t0 = Date.now();
    await fs.release();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("release never throws", async () => {
    const fs = createFixtureSetup(bridge({ releaseFixture: async () => { throw new Error("x"); } }), fixture, opts());
    await fs.setup({ signal: sig() });
    await expect(fs.release()).resolves.toBeUndefined();
  });

  it("session level: abort while apply is in flight, then the token is released once", async () => {
    const d = deferred<unknown>();
    const releaseFixture = vi.fn(async () => ({}));
    const onApplied = vi.fn();
    const ac = new AbortController();
    const fs = createFixtureSetup(bridge({ releaseFixture, applyFixture: () => d.promise }), fixture, opts({ onApplied }));
    const session = createBrowseAgentSession({ signal: ac.signal, executeTool: async () => "{}" });
    const run = session.run("g", { async send() {}, stop() {}, messages: () => [] }, { setup: fs.setup });
    await tick();
    ac.abort();
    const result = await run;
    await fs.release();
    expect(result.status).toBe("aborted");
    d.resolve({ ok: true, summary: "s", fixtureToken: "late" });
    await tick();
    expect(releaseFixture).toHaveBeenCalledTimes(1);
    expect(releaseFixture).toHaveBeenCalledWith("late");
    expect(onApplied).not.toHaveBeenCalled();
  });
});

describe("runBrowseAgent abort leak", () => {
  it("releases the token of an apply that resolves after the abort", async () => {
    const d = deferred<unknown>();
    const releaseFixture = vi.fn(async () => ({}));
    const ac = new AbortController();
    const model = new MockLanguageModelV3({});
    const run = runBrowseAgent("g", {
      model,
      browser: bridge({ releaseFixture, applyFixture: () => d.promise }),
      fixture,
      allowNetworkMocks: true,
      signal: ac.signal,
    });
    await tick();
    ac.abort();
    expect((await run).status).toBe("aborted");
    d.resolve({ ok: true, summary: "s", fixtureToken: "late" });
    await tick();
    expect(releaseFixture).toHaveBeenCalledExactlyOnceWith("late");
  });
});

describe("unmatchedMocks and mockHits", () => {
  const hits = [
    { url: "https://a.test/hit", hits: 2 },
    { method: "GET", url: "https://a.test/miss", hits: 0 },
    { url: "https://a.test/miss2", hits: 0 },
  ];

  it("unmatchedMocks lists the rules with zero hits, method only when the rule had one", () => {
    expect(unmatchedMocks(hits)).toEqual([{ method: "GET", url: "https://a.test/miss" }, { url: "https://a.test/miss2" }]);
    expect(unmatchedMocks([{ url: "u", hits: 1 }])).toEqual([]);
    expect(unmatchedMocks(undefined)).toEqual([]);
  });

  it("is exported by the light session entry", () => {
    expect(sessionEntry.unmatchedMocks).toBe(unmatchedMocks);
  });

  it("release keeps the hit counts the bridge reports; none before the release", async () => {
    const fs = createFixtureSetup(bridge({ releaseFixture: async () => ({ mockHits: hits }) }), fixture, opts());
    await fs.setup({ signal: sig() });
    expect(fs.mockHits()).toBeUndefined();
    await fs.release();
    expect(fs.mockHits()).toEqual(hits);
    await fs.release();
    expect(fs.mockHits()).toEqual(hits);
  });

  it("a bridge that reports nothing or something malformed gives undefined", async () => {
    for (const reported of [undefined, { ok: true }, { mockHits: "x" }, { mockHits: [{ url: 1, hits: 0 }] }, { mockHits: [{ url: "u" }] }]) {
      const fs = createFixtureSetup(bridge({ releaseFixture: async () => reported }), fixture, opts());
      await fs.setup({ signal: sig() });
      await fs.release();
      expect(fs.mockHits()).toBeUndefined();
    }
  });
});
