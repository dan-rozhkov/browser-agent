import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { BrowserController } from "../../src/controller/controller.js";
import { controllerBridge } from "../../src/adapters/controllerBridge.js";
import { runBrowseAgent } from "../../src/agent/aiSdk.js";
import { fixtureSetupBody, type BrowseAgentDriver } from "../../src/agent/index.js";
import { createBrowseAgentSession } from "../../src/agent/session.js";
import type { BrowserBridge } from "../../src/loop/bridge.js";
import type { PageFixture } from "../../src/fixture/types.js";
import { fakeTarget } from "../fixture/fakes.js";

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 4, text: 4, reasoning: undefined },
};

/** A model that answers once, and records every prompt it got. */
function recordingModel(text = "done") {
  const prompts: unknown[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options: { prompt?: unknown }) => {
      prompts.push(options.prompt);
      return {
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage,
        warnings: [] as never[],
        content: [{ type: "text", text }],
      } as never;
    },
  });
  return { model, prompts };
}

const SNAP = { snapshotId: "s1", url: "https://a.test/", title: "A", elements: [] };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const driver = (send: (t: string) => Promise<void>): BrowseAgentDriver => ({ send, stop() {}, messages: () => [] });

function bridge(log: string[], over: Partial<BrowserBridge> = {}): BrowserBridge {
  return {
    open: async (a) => { log.push(`open ${a.url}`); return {}; },
    act: async () => ({}),
    read: async () => ({}),
    snapshot: async () => { log.push("snapshot"); return SNAP; },
    perform: async () => ({}),
    applyFixture: async () => { log.push("apply"); return { ok: true, url: "https://a.test/", title: "A", summary: "start page https://a.test/; 1 cookie" }; },
    ...over,
  };
}

describe("session setup hook", () => {
  const session = () => createBrowseAgentSession({ executeTool: async () => "{}" });

  it("runs before the first request, counts one step, and the model gets goal + its text", async () => {
    let sent = "";
    const order: string[] = [];
    const r = await session().run("goal", driver(async (t) => { order.push("send"); sent = t; }), {
      setup: async () => { order.push("setup"); return "prepared"; },
    });
    expect(order).toEqual(["setup", "send"]);
    expect(sent).toBe("goal\n\nprepared");
    expect(r).toMatchObject({ status: "done", steps: 1 });
  });

  it("url and setup together are an error and nothing runs", async () => {
    let ran = false;
    const r = await session().run("goal", driver(async () => { ran = true; }), { url: "https://a.test/", setup: async () => { ran = true; return ""; } });
    expect(r).toEqual({ status: "error", answer: "", steps: 0, error: "url and setup cannot be used together" });
    expect(ran).toBe(false);
  });

  it("a throwing setup gives status error and no request", async () => {
    let sent = false;
    const r = await session().run("goal", driver(async () => { sent = true; }), { setup: async () => { throw new Error("no cookies"); } });
    expect(r).toMatchObject({ status: "error", error: "no cookies", steps: 1 });
    expect(sent).toBe(false);
  });

  it("the deadline stops a setup that ignores the signal", async () => {
    const s = createBrowseAgentSession({ executeTool: async () => "{}", deadlineMs: 20 });
    let sent = false;
    const r = await s.run("goal", driver(async () => { sent = true; }), { setup: () => sleep(500).then(() => "late") });
    expect(r.status).toBe("timeout");
    expect(sent).toBe(false);
  });

  it("a parent abort stops the setup and gives the signal to it", async () => {
    const ctl = new AbortController();
    const s = createBrowseAgentSession({ executeTool: async () => "{}", signal: ctl.signal });
    let seen: AbortSignal | undefined;
    const run = s.run("goal", driver(async () => {}), {
      setup: ({ signal }) => { seen = signal; return new Promise(() => {}); },
    });
    setTimeout(() => ctl.abort(), 10);
    expect((await run).status).toBe("aborted");
    expect(seen?.aborted).toBe(true);
  });
});

describe("fixtureSetupBody", () => {
  it("is the summary and the snapshot", () => {
    expect(fixtureSetupBody("1 cookie", '{"a":1}')).toBe(
      'The browser state was prepared for you (1 cookie). Snapshot of the page:\n{"a":1}',
    );
  });
});

describe("runBrowseAgent with a fixture", () => {
  const fixture: PageFixture = { version: 1, url: "https://a.test/", storage: { cookies: [{ name: "sid", value: "v", domain: "a.test" }] } };

  it("applies the fixture, snapshots, and tells the model the summary", async () => {
    const log: string[] = [];
    const { model, prompts } = recordingModel();
    const r = await runBrowseAgent("goal", { model, browser: bridge(log), fixture });
    expect(log).toEqual(["apply", "snapshot"]);
    expect(r).toMatchObject({ status: "done", steps: 1 });
    const user = JSON.stringify(prompts[0]);
    expect(user).toContain("The browser state was prepared for you (start page https://a.test/; 1 cookie). Snapshot of the page:");
    expect(user).toContain('\\"snapshotId\\":\\"s1\\"');
  });

  it("passes the fixture and an abort signal to the bridge", async () => {
    let got: { fixture?: unknown; signal?: AbortSignal } = {};
    const { model } = recordingModel();
    await runBrowseAgent("goal", {
      model,
      browser: bridge([], { applyFixture: async (f, o) => { got = { fixture: f, signal: o?.signal }; return { ok: true, summary: "s" }; } }),
      fixture,
    });
    expect(got.fixture).toEqual(fixture);
    expect(got.signal).toBeInstanceOf(AbortSignal);
  });

  it("a bridge without applyFixture gives status error and no model request", async () => {
    const { model, prompts } = recordingModel();
    const b = bridge([]);
    delete b.applyFixture;
    const r = await runBrowseAgent("goal", { model, browser: b, fixture });
    expect(r.status).toBe("error");
    expect(r.error).toContain("does not support page fixtures");
    expect(prompts).toHaveLength(0);
  });

  it("a failed apply gives status error with its message", async () => {
    const { model, prompts } = recordingModel();
    const r = await runBrowseAgent("goal", {
      model,
      browser: bridge([], { applyFixture: async () => ({ ok: false, error: "step 1 (click #a) failed: element not found" }) }),
      fixture,
    });
    expect(r).toMatchObject({ status: "error", error: "step 1 (click #a) failed: element not found" });
    expect(prompts).toHaveLength(0);
  });

  it("url and fixture together are an error", async () => {
    const log: string[] = [];
    const { model } = recordingModel();
    const r = await runBrowseAgent("goal", { model, browser: bridge(log), fixture, url: "https://a.test/" });
    expect(r).toMatchObject({ status: "error", error: "url and setup cannot be used together" });
    expect(log).toEqual([]);
  });

  it("the url-only path still opens the page and never calls applyFixture", async () => {
    const log: string[] = [];
    const { model, prompts } = recordingModel();
    await runBrowseAgent("goal", { model, browser: bridge(log), url: "https://a.test/" });
    expect(log).toEqual(["open https://a.test/", "snapshot"]);
    expect(JSON.stringify(prompts[0])).toContain("The browser already opened https://a.test/ for you (browse_open).");
  });
});

describe("secrets never reach the model", () => {
  const SECRET = "ZZ-secret-sentinel-ZZ";
  const secretFixture: PageFixture = {
    version: 1,
    url: "https://a.test/home",
    storage: {
      cookies: [{ name: `cookie-${SECRET}`, value: `cookie-val-${SECRET}`, domain: "a.test" }],
      origins: [{ origin: "https://a.test", localStorage: { [`lk-${SECRET}`]: `lv-${SECRET}` }, sessionStorage: { [`sk-${SECRET}`]: `sv-${SECRET}` } }],
    },
    steps: [{ action: "type", selector: "#pw", text: `typed-${SECRET}` }],
  };

  async function run(target: ReturnType<typeof fakeTarget>) {
    const { model, prompts } = recordingModel();
    const result = await runBrowseAgent("goal", { model, browser: controllerBridge(new BrowserController(target)), fixture: secretFixture });
    return { text: JSON.stringify([prompts, result]), result };
  }

  it("success: no message, summary or result holds a cookie or storage value", async () => {
    const target = fakeTarget({ exec: () => ({ ok: true, found: true }) });
    const { text, result } = await run(target);
    expect(result.status).toBe("done");
    expect(text).toContain("1 cookie; storage for 1 origin"); // the summary is there, with counts only
    expect(text).not.toContain(SECRET);
    // The secrets did reach the browser, so the check above is not vacuous.
    expect(JSON.stringify(target.cookiesSet)).toContain(SECRET);
  });

  it("failure of a step, the cookie call, the storage write and the load: no secret in the error", async () => {
    const cases: ReturnType<typeof fakeTarget>[] = [];
    cases.push(fakeTarget({ exec: () => ({ ok: false, error: "element not found" }) }));
    const cookieFail = fakeTarget();
    cookieFail.setCookies = async () => { throw new Error(`cookie ${SECRET} rejected`); };
    cases.push(cookieFail);
    cases.push(fakeTarget({ exec: () => { throw new Error(`quota for lk-${SECRET}`); } }));
    const loadFail = fakeTarget();
    loadFail.pages.get(1)!.loadURL = async () => { throw new Error("ERR_CONNECTION_REFUSED"); };
    cases.push(loadFail);
    for (const target of cases) {
      const { text, result } = await run(target);
      expect(result.status).toBe("error");
      expect(typeof result.error).toBe("string");
      expect(text).not.toContain(SECRET);
    }
  });

  it("a rejected parse error does not repeat the secret either", async () => {
    const bad = { version: 1, storage: { origins: [{ origin: "https://a.test", localStorage: { [`lk-${SECRET}`]: 5 } }] } } as unknown as PageFixture;
    const { model, prompts } = recordingModel();
    const r = await runBrowseAgent("goal", { model, browser: controllerBridge(new BrowserController(fakeTarget())), fixture: bad });
    expect(r.status).toBe("error");
    expect(JSON.stringify([prompts, r])).not.toContain(SECRET);
  });

  it("network mocks give 'not supported yet'", async () => {
    const { model } = recordingModel();
    const r = await runBrowseAgent("goal", {
      model,
      browser: controllerBridge(new BrowserController(fakeTarget())),
      fixture: { version: 1, network: [{ match: "x" }] },
    });
    expect(r).toMatchObject({ status: "error", error: "PageFixture.network is not supported yet" });
  });
});
