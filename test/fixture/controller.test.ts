import { describe, expect, it, vi } from "vitest";
import { BrowserController } from "../../src/controller/controller.js";
import { controllerBridge } from "../../src/adapters/controllerBridge.js";
import { fakeTarget } from "./fakes.js";

/** An object answer serves the fixture scripts (they accept an object or a JSON string) and the controller's own. */
const exec = () => ({ ok: true, found: true });

describe("BrowserController fixtures", () => {
  it("applyFixture runs and returns the result", async () => {
    const t = fakeTarget({ exec });
    const c = new BrowserController(t);
    const r = await c.applyFixture({ version: 1, url: "https://a.test/", storage: { cookies: [{ name: "a", value: "b", domain: "a.test" }] } });
    expect(r).toEqual({ ok: true, url: "https://a.test/", title: "title of https://a.test/", summary: "start page https://a.test/; 1 cookie" });
  });

  it("serializes applyFixture with other commands", async () => {
    const t = fakeTarget({ exec });
    const page = t.pages.get(1)!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    page.loadURL = async () => gate;
    page.onceDomReady = async () => {
      t.log.push("dom wait");
      await gate;
      t.log.push("dom ready");
    };
    const original = page.executeJavaScript;
    page.executeJavaScript = async (code) => {
      t.log.push("script");
      return original(code);
    };
    const c = new BrowserController(t);
    const applying = c.applyFixture({ version: 1, url: "https://a.test/" });
    const snap = c.snapshot();
    await new Promise((r) => setTimeout(r, 30));
    expect(t.log).toEqual(["dom wait"]);
    release();
    await Promise.all([applying, snap]);
    expect(t.log.slice(0, 2)).toEqual(["dom wait", "dom ready"]);
    expect(t.log).toContain("script");
  });

  it("drops the last snapshot: a perform against it is stale", async () => {
    const t = fakeTarget({ exec });
    const c = new BrowserController(t);
    const snapshot = (await c.snapshot()) as { snapshotId: string };
    await c.applyFixture({ version: 1, url: "https://a.test/" });
    const result = await c.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });
    expect(String((result as { error: string }).error)).toMatch(/stale|unknown/i);
  });

  it("captureFixture reads the browser through the controller", async () => {
    const t = fakeTarget({ exec: () => JSON.stringify({ ok: true, localStorage: {}, sessionStorage: {} }) });
    t.pages.get(1)!.url = "https://a.test/";
    const r = await new BrowserController(t).captureFixture();
    expect(r).toEqual({ ok: true, fixture: { version: 1, url: "https://a.test/" } });
  });

  it("controllerBridge forwards both", async () => {
    const t = fakeTarget({ exec });
    const bridge = controllerBridge(new BrowserController(t));
    expect(await bridge.applyFixture!({ version: 1 })).toMatchObject({ ok: true });
    expect(await bridge.captureFixture!()).toMatchObject({ ok: true });
  });

  it("loads an extra tab through the tabs-new path even when newPage ignores the url", async () => {
    const t = fakeTarget({ exec, newPageIgnoresUrl: true });
    const r = await new BrowserController(t).applyFixture({ version: 1, tabs: ["https://b.test/x"] });
    expect(r.ok).toBe(true);
    expect(t.newPageArgs).toEqual([undefined]);
    expect(t.log).toContain("tab2: load https://b.test/x");
    expect(t.currentId).toBe(1);
  });

  it("navigates through open(): a failed load is an error with the open() wording", async () => {
    const t = fakeTarget({ exec });
    t.pages.get(1)!.loadURL = async () => { throw new Error("net::ERR_NAME_NOT_RESOLVED"); };
    const r = await new BrowserController(t).applyFixture({ version: 1, url: "https://a.test/?token=SECRETQ" });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("SECRETQ");
  });

  it("a hung load ends with an error and releases the lock", async () => {
    const t = fakeTarget({ exec });
    const page = t.pages.get(1)!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    page.loadURL = () => gate;
    page.onceDomReady = () => gate;
    const c = new BrowserController(t, { openTimeoutMs: 50 });
    const r = await c.applyFixture({ version: 1, url: "https://a.test/" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("timed out");
    // The abandoned load settles; the next command then runs.
    release();
    expect(await c.snapshot()).toBeTruthy();
  });

  it("a press step sends a textless edit combo with its command", async () => {
    const t = fakeTarget({ exec });
    await new BrowserController(t).applyFixture({ version: 1, steps: [{ action: "press", key: "Meta+a" }] });
    const keys = t.pages.get(1)!.keys;
    expect(keys[0].params).toMatchObject({ type: "rawKeyDown", modifiers: 4, commands: ["selectAll"] });
    expect(keys[0].params?.text).toBeUndefined();
  });

  it("the overall deadline and the script cap free the lock when the page hangs", async () => {
    vi.useFakeTimers();
    try {
      const t = fakeTarget({ exec: () => new Promise(() => {}) });
      const c = new BrowserController(t);
      const run = c.applyFixture({ version: 1, steps: [{ action: "click", selector: "#a" }] });
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await run).toMatchObject({ ok: false, error: "step 1 (click #a) failed: the page script failed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a timed-out command returns the fixture error shape", async () => {
    vi.useFakeTimers();
    try {
      const t = fakeTarget({ exec });
      // The target hangs before any script runs, so only the overall deadline can end it.
      t.setCookies = () => new Promise(() => {});
      const run = new BrowserController(t).applyFixture({ version: 1, storage: { cookies: [{ name: "a", value: "b", domain: "a.test" }] } });
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await run).toEqual({ ok: false, error: "Browser command timed out after 10000ms." });
    } finally {
      vi.useRealTimers();
    }
  });
});
