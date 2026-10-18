import { asSchema } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { createBrowseActInputSchema, createBrowseToolDefinitions, normalizeBrowseActInput } from "../../src/agent/index.js";
import { runBrowseAgent } from "../../src/agent/aiSdk.js";
import type { BrowserBridge } from "../../src/loop/bridge.js";
import { bridgeWith, browseAct, FOUND, resetEnvironment, snap, stubLocate } from "./executeHarness.js";

afterEach(resetEnvironment);

const schema = createBrowseActInputSchema({ elementTargeting: true });
const parse = (v: unknown) => schema.safeParse(v);

describe("browse_act viewport: schema", () => {
  it("accepts each device and a custom size, single or in a batch", () => {
    for (const device of ["iphone-15", "pixel-8", "ipad", "desktop-1440", "desktop-1920", "reset"]) {
      expect(parse({ action: "viewport", device }).success, device).toBe(true);
    }
    expect(parse({ action: "viewport", device: "custom", width: 800, height: 600, mobile: true }).success).toBe(true);
    expect(parse({ actions: [{ action: "viewport", device: "ipad" }, { action: "reload" }] }).success).toBe(true);
  });

  it("rejects an unknown device and a size out of range", () => {
    expect(parse({ action: "viewport", device: "watch" }).success).toBe(false);
    expect(parse({ action: "viewport", device: "custom", width: 199, height: 600 }).success).toBe(false);
    expect(parse({ action: "viewport", device: "custom", width: 800, height: 4001 }).success).toBe(false);
    expect(parse({ action: "viewport", device: "custom", width: 800.5, height: 600 }).success).toBe(false);
  });

  it("strips strict-mode placeholders: 0 size and false mobile are absent next to a preset", () => {
    expect(normalizeBrowseActInput({ action: "viewport", device: "iphone-15", width: 0, height: 0, mobile: false, index: 0, target: "", text: "", files: [] })).toEqual({
      action: "viewport",
      device: "iphone-15",
    });
    expect(parse({ action: "viewport", device: "reset", width: 0, height: 0, mobile: false, amount: 0, ms: 0, index: 0, snapshotId: "" }).success).toBe(true);
    // The one-entry copy of the same call folds into a single call.
    expect(normalizeBrowseActInput({ action: "viewport", device: "ipad", width: 0, actions: [{ action: "viewport", device: "ipad", width: 0 }] })).toEqual({ action: "viewport", device: "ipad" });
  });

  it("keeps a 0 size with device custom, so it is an error", () => {
    expect(normalizeBrowseActInput({ action: "viewport", device: "custom", width: 0, height: 600 })).toEqual({ action: "viewport", device: "custom", width: 0, height: 600 });
    expect(parse({ action: "viewport", device: "custom", width: 0, height: 600 }).success).toBe(false);
  });

  it("puts viewport and its fields in the published JSON schema and the description", () => {
    const tool = createBrowseToolDefinitions().browse_act;
    const json = JSON.stringify(asSchema(tool.inputSchema).jsonSchema);
    for (const piece of ['"viewport"', '"device"', '"width"', '"height"', '"mobile"']) expect(json).toContain(piece);
    expect(tool.description).toContain("`viewport`");
    expect(tool.description).toContain("reloaded: true");
  });
});

describe("browse_act viewport: executor", () => {
  it("forwards a valid call to the bridge untouched and attaches a snapshot", async () => {
    const args = { action: "viewport", device: "custom", width: 800, height: 600, mobile: true };
    const bridge = bridgeWith({ act: [{ ok: true, device: "custom", reloaded: true }], snapshot: [snap("s-1")] });
    const out = JSON.parse(await browseAct(args));
    expect(bridge.callsTo("act").map((c) => c.args)).toEqual([[args]]);
    expect(out.snapshot.snapshotId).toBe("s-1");
  });

  it("refuses a bad call before the bridge", async () => {
    const bridge = bridgeWith({});
    expect(JSON.parse(await browseAct({ action: "viewport" })).error).toContain('requires "device"');
    expect(JSON.parse(await browseAct({ action: "viewport", device: "custom", width: 0, height: 600 })).error).toContain("requires integer");
    expect(JSON.parse(await browseAct({ action: "viewport", device: "custom", width: 800, height: 99999 })).error).toContain("200 to 4000");
    expect(bridge.callsTo("act")).toHaveLength(0);
  });

  it("is not an element action", async () => {
    const bridge = bridgeWith({});
    const locate = stubLocate([FOUND(1)]);
    const out = JSON.parse(await browseAct({ action: "viewport", device: "ipad", element: "the page" }));
    expect(out.error).toContain('"element" is only supported for');
    expect(locate.requests).toHaveLength(0);
    expect(bridge.callsTo("act")).toHaveLength(0);
  });

  it("refuses an index entry after a viewport entry before anything runs", async () => {
    const bridge = bridgeWith({ act: [{ ok: true }], snapshot: [snap("s-1")] });
    const out = JSON.parse(await browseAct({ actions: [{ action: "viewport", device: "ipad" }, { action: "click", index: 2 }], snapshotId: "s-0" }));
    expect(out.error).toContain("Put viewport last in a batch, or take a new snapshot after it.");
    expect(bridge.callsTo("act")).toHaveLength(0);
  });

  it("allows viewport last, or before target-based entries", async () => {
    bridgeWith({ act: [{ ok: true }, { ok: true }], snapshot: [snap("s-1")] });
    const out = JSON.parse(await browseAct({ actions: [{ action: "click", index: 2 }, { action: "viewport", device: "ipad" }], snapshotId: "s-0" }));
    expect(out.error).toBeUndefined();
  });

  it("runs inside a batch and stops the batch on a bad entry", async () => {
    const bridge = bridgeWith({ act: [{ ok: true }], snapshot: [snap("s-1")] });
    const out = JSON.parse(await browseAct({ actions: [{ action: "viewport", device: "ipad" }, { action: "viewport", device: "custom" }] }));
    expect(out.completed).toBe(1);
    expect(out.stoppedAt).toBe(1);
    expect(bridge.callsTo("act")).toHaveLength(1);
  });
});

describe("runBrowseAgent clears the viewport emulation at the end", () => {
  const usage = {
    inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 4, text: 4, reasoning: undefined },
  };
  const model = () =>
    new MockLanguageModelV3({
      doGenerate: async () =>
        ({ finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] as never[], content: [{ type: "text", text: "done" }] }) as never,
    });
  const bridge = (log: string[], over: Partial<BrowserBridge> = {}): BrowserBridge => ({
    open: async () => ({}),
    act: async () => ({}),
    read: async () => ({}),
    snapshot: async () => ({ snapshotId: "s1", url: "https://a.test/", title: "A", elements: [] }),
    perform: async () => ({}),
    clearActEmulation: async () => { log.push("clear"); },
    ...over,
  });

  it("calls it once with no fixture", async () => {
    const log: string[] = [];
    await runBrowseAgent("goal", { model: model(), browser: bridge(log), url: "https://a.test/" });
    expect(log).toEqual(["clear"]);
  });

  it("calls it after the fixture release", async () => {
    const log: string[] = [];
    await runBrowseAgent("goal", {
      model: model(),
      browser: bridge(log, {
        applyFixture: async () => ({ ok: true, url: "https://a.test/", title: "A", summary: "applied", fixtureToken: "t1" }),
        releaseFixture: async () => { log.push("release"); },
      }),
      fixture: { version: 1, url: "https://a.test/" },
    });
    expect(log).toEqual(["release", "clear"]);
  });

  it("still runs when the host callback or the release throws, and a rejecting clear does not fail the run", async () => {
    const log: string[] = [];
    const r = await runBrowseAgent("goal", {
      model: model(),
      browser: bridge(log, {
        applyFixture: async () => ({ ok: true, url: "https://a.test/", title: "A", summary: "applied", fixtureToken: "t1" }),
        releaseFixture: async () => { throw new Error("release failed"); },
        clearActEmulation: async () => { log.push("clear"); throw new Error("gone"); },
      }),
      fixture: { version: 1, url: "https://a.test/" },
    });
    expect(log).toEqual(["clear"]);
    expect(r.status).toBeDefined();
  });

  it("works with a bridge that has no clearActEmulation", async () => {
    const r = await runBrowseAgent("goal", { model: model(), browser: bridge([], { clearActEmulation: undefined }), url: "https://a.test/" });
    expect(r.status).toBeDefined();
  });
});
