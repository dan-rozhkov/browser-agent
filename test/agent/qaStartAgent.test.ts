import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { BrowserController } from "../../src/controller/controller.js";
import { controllerBridge } from "../../src/adapters/controllerBridge.js";
import { runBrowseAgent } from "../../src/agent/aiSdk.js";
import { createBrowseAgentSession, SetupError, type BrowseAgentDriver } from "../../src/agent/session.js";
import * as sessionEntry from "../../src/agent/sessionEntry.js";
import type { BrowserBridge } from "../../src/loop/bridge.js";
import type { PageFixture } from "../../src/fixture/types.js";
import { fakeTarget } from "../fixture/fakes.js";

const SECRET = "qa-agent-secret-QQ";
const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 4, text: 4, reasoning: undefined },
};

function okModel() {
  return new MockLanguageModelV3({
    doGenerate: async () =>
      ({ finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] as never[], content: [{ type: "text", text: "done" }] }) as never,
  });
}
/** A model that never answers until its request is aborted. */
function hangingModel() {
  return new MockLanguageModelV3({
    doGenerate: async (options: { abortSignal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }) as never,
  });
}
function failingModel() {
  return new MockLanguageModelV3({ doGenerate: async () => { throw new Error("provider down"); } });
}

const SNAP = { snapshotId: "s1", url: "https://a.test/", title: "A", elements: [] };

function bridge(log: string[], over: Partial<BrowserBridge> = {}): BrowserBridge {
  return {
    open: async () => ({}),
    act: async () => ({}),
    read: async () => ({}),
    snapshot: async () => SNAP,
    perform: async () => ({}),
    applyFixture: async () => { log.push("apply"); return { ok: true, summary: "1 network mock", fixtureToken: "t1" }; },
    releaseFixture: async (token) => { log.push(`release ${token}`); },
    ...over,
  };
}

const withMock: PageFixture = { version: 1, network: [{ url: "https://api.a.test/*" }] };
const driver = (send: () => Promise<void>): BrowseAgentDriver => ({ send, stop() {}, messages: () => [] });

describe("SetupError and setup_failed", () => {
  it("is exported by the light session entry", () => {
    expect(sessionEntry.SetupError).toBe(SetupError);
    const err = new SetupError("expect", "boom");
    expect(err).toBeInstanceOf(Error);
    expect([err.stage, err.message, err.name]).toEqual(["expect", "boom", "SetupError"]);
  });

  it("a SetupError from setup gives setup_failed with its stage and no request", async () => {
    let sent = false;
    const s = createBrowseAgentSession({ executeTool: async () => "{}" });
    const r = await s.run("goal", driver(async () => { sent = true; }), { setup: async () => { throw new SetupError("cookies", "no cookies"); } });
    expect(r).toEqual({ status: "setup_failed", answer: "", steps: 1, error: "no cookies", setupStage: "cookies" });
    expect(sent).toBe(false);
  });

  it("a SetupError without a stage leaves setupStage out", async () => {
    const s = createBrowseAgentSession({ executeTool: async () => "{}" });
    const r = await s.run("goal", driver(async () => {}), { setup: async () => { throw new SetupError(undefined, "x"); } });
    expect(r.status).toBe("setup_failed");
    expect("setupStage" in r).toBe(false);
  });

  it("a deadline or an abort during setup is still timeout or aborted", async () => {
    const s = createBrowseAgentSession({ executeTool: async () => "{}", deadlineMs: 20 });
    const r = await s.run("goal", driver(async () => {}), { setup: () => new Promise(() => {}) });
    expect(r.status).toBe("timeout");
  });
});

describe("runBrowseAgent: setup failures", () => {
  it("a failed apply gives setup_failed with the stage, and the model never runs", async () => {
    const model = okModel();
    const b = bridge([], { applyFixture: async () => ({ ok: false, stage: "expect", error: "expect failed after 0ms: element #a is not visible" }) });
    const r = await runBrowseAgent("goal", { model, browser: b, fixture: { version: 1, expect: { selector: "#a" } } });
    expect(r).toMatchObject({ status: "setup_failed", setupStage: "expect", error: "expect failed after 0ms: element #a is not visible" });
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(JSON.stringify(r)).toContain('"setupStage":"expect"');
  });

  it("an apply result without a stage gives setup_failed without setupStage", async () => {
    const model = okModel();
    const r = await runBrowseAgent("goal", { model, browser: bridge([], { applyFixture: async () => ({ ok: false, error: "x" }) }), fixture: withMock });
    expect(r.status).toBe("setup_failed");
    expect("setupStage" in r).toBe(false);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("refuses a bridge that could leave mocks behind", async () => {
    const log: string[] = [];
    const model = okModel();
    const b = bridge(log);
    delete b.releaseFixture;
    const r = await runBrowseAgent("goal", { model, browser: b, fixture: withMock, allowNetworkMocks: true });
    expect(r).toMatchObject({ status: "setup_failed", setupStage: "network" });
    expect(r.error).toContain("releaseFixture is missing");
    expect(log).toEqual([]);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("a bridge without releaseFixture is fine for a fixture with no mocks", async () => {
    const b = bridge([]);
    delete b.releaseFixture;
    const r = await runBrowseAgent("goal", { model: okModel(), browser: b, fixture: { version: 1, url: "https://a.test/" } });
    expect(r.status).toBe("done");
  });

  it("passes the host gate to the bridge (off by default)", async () => {
    const seen: unknown[] = [];
    const b = bridge([], { applyFixture: async (_f, o) => { seen.push(o?.allowNetworkMocks); return { ok: true, summary: "s" }; } });
    await runBrowseAgent("goal", { model: okModel(), browser: b, fixture: withMock });
    await runBrowseAgent("goal", { model: okModel(), browser: b, fixture: withMock, allowNetworkMocks: true });
    expect(seen).toEqual([false, true]);
  });
});

describe("runBrowseAgent: release in finally", () => {
  it("after done", async () => {
    const log: string[] = [];
    const r = await runBrowseAgent("goal", { model: okModel(), browser: bridge(log), fixture: withMock });
    expect(r.status).toBe("done");
    expect(log).toEqual(["apply", "release t1"]);
  });

  it("after a model error", async () => {
    const log: string[] = [];
    const r = await runBrowseAgent("goal", { model: failingModel(), browser: bridge(log), fixture: withMock });
    expect(r.status).toBe("error");
    expect(log).toEqual(["apply", "release t1"]);
  });

  it("after the deadline", async () => {
    const log: string[] = [];
    const r = await runBrowseAgent("goal", { model: hangingModel(), browser: bridge(log), fixture: withMock, deadlineMs: 40 });
    expect(r.status).toBe("timeout");
    expect(log).toEqual(["apply", "release t1"]);
  });

  it("after an abort", async () => {
    const log: string[] = [];
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 30);
    const r = await runBrowseAgent("goal", { model: hangingModel(), browser: bridge(log), fixture: withMock, signal: ctl.signal });
    expect(r.status).toBe("aborted");
    expect(log).toEqual(["apply", "release t1"]);
  });

  it("a failed apply releases nothing (it cleaned up itself)", async () => {
    const log: string[] = [];
    const b = bridge(log, { applyFixture: async () => { log.push("apply"); return { ok: false, stage: "steps", error: "x" }; } });
    const r = await runBrowseAgent("goal", { model: okModel(), browser: b, fixture: withMock });
    expect(r.status).toBe("setup_failed");
    expect(log).toEqual(["apply"]);
  });

  it("a deadline during the apply releases nothing (no token), and the abort reaches the bridge", async () => {
    const log: string[] = [];
    let signal: AbortSignal | undefined;
    const b = bridge(log, { applyFixture: async (_f, o) => { signal = o?.signal; return new Promise(() => {}); } });
    const r = await runBrowseAgent("goal", { model: okModel(), browser: b, fixture: withMock, deadlineMs: 30 });
    expect(r.status).toBe("timeout");
    expect(signal?.aborted).toBe(true);
    expect(log).toEqual([]);
  });

  it("a throwing release does not change the result", async () => {
    const b = bridge([], { releaseFixture: async () => { throw new Error("unroute failed"); } });
    expect((await runBrowseAgent("goal", { model: okModel(), browser: b, fixture: withMock })).status).toBe("done");
  });

  it("without a fixture the run never releases (the host owns what it applied)", async () => {
    const log: string[] = [];
    await runBrowseAgent("goal", { model: okModel(), browser: bridge(log), url: "https://a.test/" });
    expect(log).toEqual([]);
  });
});

describe("runBrowseAgent through a real controller", () => {
  const exec = () => ({ ok: true, found: true });
  const secretFixture: PageFixture = {
    version: 1,
    url: "https://a.test/",
    network: [{ url: `https://api.a.test/cart?token=${SECRET}`, headers: { "x-key": `h-${SECRET}` }, body: { v: SECRET }, status: 503 }],
  };

  it("gate off: setup_failed at stage network, nothing installed, no secret in the result", async () => {
    const t = fakeTarget({ withNetwork: true, exec });
    const model = okModel();
    const r = await runBrowseAgent("goal", { model, browser: controllerBridge(new BrowserController(t)), fixture: secretFixture });
    expect(r).toMatchObject({ status: "setup_failed", setupStage: "network", error: "network mocks are disabled (allowNetworkMocks is off)" });
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(t.log).not.toContain("route");
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("gate on: the mocks are installed for the run and removed at its end; the model prompt holds no secret", async () => {
    const t = fakeTarget({ withNetwork: true, exec });
    const model = okModel();
    const r = await runBrowseAgent("goal", { model, browser: controllerBridge(new BrowserController(t)), fixture: secretFixture, allowNetworkMocks: true });
    expect(r.status).toBe("done");
    expect(t.log).toContain("route");
    expect(t.unrouted).toBe(1);
    const seen = JSON.stringify([model.doGenerateCalls, r]);
    expect(seen).toContain("1 network mock");
    expect(seen).not.toContain(SECRET);
  });

  it("a target that cannot mock gives setup_failed at stage network", async () => {
    const r = await runBrowseAgent("goal", {
      model: okModel(),
      browser: controllerBridge(new BrowserController(fakeTarget({ exec }))),
      fixture: secretFixture,
      allowNetworkMocks: true,
    });
    expect(r).toMatchObject({ status: "setup_failed", setupStage: "network", error: "this browser cannot mock network requests" });
  });

  it("a target that cannot reset gives setup_failed at stage reset", async () => {
    const r = await runBrowseAgent("goal", { model: okModel(), browser: controllerBridge(new BrowserController(fakeTarget({ exec }))), fixture: { version: 1, fresh: true } });
    expect(r).toMatchObject({ status: "setup_failed", setupStage: "reset", error: "this browser cannot reset its session" });
  });

  it("controllerBridge forwards releaseFixture", async () => {
    const t = fakeTarget({ withNetwork: true, exec });
    const c = new BrowserController(t);
    const b = controllerBridge(c);
    await b.applyFixture!({ version: 1, network: [{ url: "x" }] }, { allowNetworkMocks: true });
    await b.releaseFixture!();
    expect(t.unrouted).toBe(1);
  });

  it("two runs on one controller: run A's end does not remove run B's mocks", async () => {
    const t = fakeTarget({ withNetwork: true, exec });
    const c = new BrowserController(t);
    const bridgeA = controllerBridge(c);
    const gateA: { open?: () => void } = {};
    const modelA = new MockLanguageModelV3({
      doGenerate: async () => { await new Promise<void>((resolve) => { gateA.open = resolve; }); return { finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] as never[], content: [{ type: "text", text: "a" }] } as never; },
    });
    const runA = runBrowseAgent("goal", { model: modelA, browser: bridgeA, fixture: withMock, allowNetworkMocks: true });
    await new Promise((r) => setTimeout(r, 50));
    // Run B applies on the same controller: A's mocks are replaced by B's.
    const b = await c.applyFixture(withMock, { allowNetworkMocks: true });
    const tokenB = b.ok ? b.fixtureToken : undefined;
    expect(t.unrouted).toBe(1);
    gateA.open!();
    expect((await runA).status).toBe("done");
    // A's finally must not touch B's interception.
    expect(t.unrouted).toBe(1);
    await c.releaseFixture(tokenB);
    expect(t.unrouted).toBe(2);
  });

  it("a run whose apply never returned a token releases nothing", async () => {
    const t = fakeTarget({ withNetwork: true, exec });
    const c = new BrowserController(t);
    await c.applyFixture(withMock, { allowNetworkMocks: true }); // someone else's mocks
    const r = await runBrowseAgent("goal", { model: okModel(), browser: controllerBridge(c), fixture: { version: 1, fresh: true }, allowNetworkMocks: true });
    expect(r).toMatchObject({ status: "setup_failed", setupStage: "reset" });
    expect(t.unrouted).toBe(1); // only the replace by the new apply; the failed run released none
  });
});

describe("runBrowseAgent: unmatchedMocks", () => {
  const two: PageFixture = { version: 1, network: [{ url: "https://api.a.test/hit" }, { method: "GET", url: "https://api.a.test/v1/contacts" }] };
  const reported = { mockHits: [{ url: "https://api.a.test/hit", hits: 3 }, { method: "GET", url: "https://api.a.test/v1/contacts", hits: 0 }] };
  const qaBridge = (release: () => Promise<unknown>) => bridge([], { releaseFixture: release, applyFixture: async () => ({ ok: true, summary: "2 network mocks", fixtureToken: "t1" }) });

  it("puts the rules that answered nothing into qa.unmatchedMocks (and into the trace qa)", async () => {
    let trace: { qa?: { unmatchedMocks?: unknown } } | undefined;
    const r = await runBrowseAgent("goal", {
      model: okModel(),
      browser: qaBridge(async () => reported),
      fixture: two,
      allowNetworkMocks: true,
      qa: true,
      trace: { onTrace: (tr) => { trace = tr; } },
    });
    expect(r.qa?.unmatchedMocks).toEqual([{ method: "GET", url: "https://api.a.test/v1/contacts" }]);
    expect(trace?.qa?.unmatchedMocks).toEqual([{ method: "GET", url: "https://api.a.test/v1/contacts" }]);
  });

  it("is absent when every rule matched, when the bridge reports no counts, and without a fixture", async () => {
    const all = { mockHits: [{ url: "https://api.a.test/hit", hits: 1 }] };
    for (const [release, fixture] of [[async () => all, two], [async () => undefined, two], [async () => reported, undefined]] as const) {
      const r = await runBrowseAgent("goal", { model: okModel(), browser: qaBridge(release), ...(fixture ? { fixture } : {}), allowNetworkMocks: true, qa: true });
      expect(r.qa).toBeDefined();
      expect("unmatchedMocks" in r.qa!).toBe(false);
    }
  });

  it("a failed run still reports them", async () => {
    const r = await runBrowseAgent("goal", { model: failingModel(), browser: qaBridge(async () => reported), fixture: two, allowNetworkMocks: true, qa: true });
    expect(r.qa?.unmatchedMocks).toHaveLength(1);
  });
});
