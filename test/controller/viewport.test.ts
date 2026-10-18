import { describe, expect, it } from "vitest";
import { BrowserController } from "../../src/controller/controller.js";
import { controllerBridge } from "../../src/adapters/controllerBridge.js";
import { fakeTarget, type FakePage, type FakeTarget } from "../fixture/fakes.js";

const REAL_UA = "Mozilla/5.0 (Macintosh) Chrome/126.0.0.0 Safari/537.36";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

interface Overrides {
  metrics?: { width: number; height: number; deviceScaleFactor: number; mobile: boolean };
  touch?: boolean;
  userAgent?: string;
  media: Record<string, string>;
  timezone?: string;
}

/** A CDP session that keeps what the emulation methods set, so a test can ask "what is still overridden". */
function track(page: FakePage, state: Overrides): void {
  const calls = page.keys;
  page.sendCdp = async (method, params) => {
    calls.push({ method, params });
    const p = (params ?? {}) as Record<string, any>;
    if (method === "Emulation.setDeviceMetricsOverride") state.metrics = { width: p.width, height: p.height, deviceScaleFactor: p.deviceScaleFactor, mobile: p.mobile };
    else if (method === "Emulation.clearDeviceMetricsOverride") delete state.metrics;
    else if (method === "Emulation.setTouchEmulationEnabled") {
      if (p.enabled) state.touch = true;
      else delete state.touch;
    } else if (method === "Emulation.setUserAgentOverride") {
      if (p.userAgent) state.userAgent = p.userAgent;
      else delete state.userAgent;
    } else if (method === "Emulation.setEmulatedMedia") {
      for (const f of p.features as { name: string; value: string }[]) {
        if (f.value) state.media[f.name] = f.value;
        else delete state.media[f.name];
      }
    } else if (method === "Emulation.setTimezoneOverride") {
      if (p.timezoneId) state.timezone = p.timezoneId;
      else delete state.timezone;
    }
    return undefined;
  };
}

function rig() {
  const state: Overrides = { media: {} };
  const target: FakeTarget = fakeTarget({
    exec: (code) => {
      if (code.includes("userAgentData")) return JSON.stringify({ ua: REAL_UA });
      if (code.includes("innerWidth")) {
        const m = state.metrics;
        return JSON.stringify({ width: m?.width ?? 1280, height: m?.height ?? 800, dpr: m?.deviceScaleFactor ?? 1 });
      }
      return { ok: true, found: true };
    },
  });
  const page = target.pages.get(1)!;
  track(page, state);
  let reloads = 0;
  page.reload = () => {
    reloads += 1;
  };
  const controller = new BrowserController(target);
  const methods = () => page.keys.map((k) => k.method);
  return { controller, target, page, state, reloads: () => reloads, methods };
}

const act = (c: BrowserController, args: Record<string, unknown>) => c.act({ action: "viewport", ...args }) as Promise<Record<string, any>>;
const CLEAN: Overrides = { media: {} };

describe("act viewport", () => {
  it("applies a desktop preset without a reload and reads the real size", async () => {
    const { controller, state, reloads } = rig();
    const r = await act(controller, { device: "desktop-1920" });
    expect(r).toEqual({ ok: true, viewport: { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false }, device: "desktop-1920", reloaded: false });
    expect(state.metrics).toEqual({ width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    expect(state.userAgent).toBeUndefined();
    expect(reloads()).toBe(0);
  });

  it("a phone preset sets the user agent and reloads", async () => {
    const { controller, state, reloads } = rig();
    const r = await act(controller, { device: "iphone-15" });
    expect(r.reloaded).toBe(true);
    expect(r.viewport).toEqual({ width: 393, height: 852, deviceScaleFactor: 3, mobile: true });
    expect(state.userAgent).toBe(IPHONE_UA);
    expect(state.touch).toBe(true);
    expect(reloads()).toBe(1);
  });

  it("a new action clears the previous one: metrics change, no stale user agent", async () => {
    const { controller, state, reloads, methods } = rig();
    await act(controller, { device: "iphone-15" });
    const r = await act(controller, { device: "custom", width: 800, height: 600 });
    expect(r).toMatchObject({ ok: true, viewport: { width: 800, height: 600, deviceScaleFactor: 1, mobile: false }, device: "custom", reloaded: true });
    expect(state.userAgent).toBeUndefined();
    expect(state.touch).toBeUndefined();
    expect(state.metrics).toEqual({ width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
    expect(reloads()).toBe(2);
    expect(methods()).toContain("Emulation.clearDeviceMetricsOverride");
  });

  it("reloads only when the user agent or the mobile flag changes", async () => {
    const { controller, reloads } = rig();
    expect((await act(controller, { device: "desktop-1440" })).reloaded).toBe(false);
    expect((await act(controller, { device: "custom", width: 700, height: 500 })).reloaded).toBe(false);
    expect((await act(controller, { device: "custom", width: 700, height: 500, mobile: true })).reloaded).toBe(true);
    expect((await act(controller, { device: "custom", width: 600, height: 500, mobile: true })).reloaded).toBe(false);
    expect((await act(controller, { device: "pixel-8" })).reloaded).toBe(true);
    expect((await act(controller, { device: "ipad" })).reloaded).toBe(true);
    expect(reloads()).toBe(3);
  });

  it("reset without a fixture clears everything the action set", async () => {
    const { controller, state } = rig();
    await act(controller, { device: "pixel-8" });
    const r = await act(controller, { device: "reset" });
    expect(r).toMatchObject({ ok: true, device: "reset", reloaded: true, viewport: { width: 1280, height: 800 } });
    expect(state).toEqual(CLEAN);
  });

  it("reset on a page nothing emulated is a no-op without a reload", async () => {
    const { controller, state, reloads } = rig();
    const r = await act(controller, { device: "reset" });
    expect(r.reloaded).toBe(false);
    expect(state).toEqual(CLEAN);
    expect(reloads()).toBe(0);
  });

  it("refuses bad arguments before the page is touched", async () => {
    const { controller, page } = rig();
    for (const args of [{}, { device: "watch" }, { device: "custom" }, { device: "custom", width: 0, height: 600 }, { device: "custom", width: 199, height: 600 }, { device: "custom", width: 800, height: 4001 }, { device: "custom", width: 800.5, height: 600 }]) {
      expect(await act(controller, args), JSON.stringify(args)).toHaveProperty("error");
    }
    expect(page.keys).toEqual([]);
  });

  it("a page without sendCdp gets the emulation error", async () => {
    const { controller, page } = rig();
    delete page.sendCdp;
    expect((await act(controller, { device: "iphone-15" })).error).toBe("This browser does not support emulation.");
  });

  it("a failed install reports the error and leaves the page clean", async () => {
    const { controller, page, state } = rig();
    const send = page.sendCdp!;
    page.sendCdp = async (method, params) => {
      if (method === "Emulation.setTouchEmulationEnabled" && (params as { enabled?: boolean })?.enabled) throw new Error("boom");
      return send(method, params);
    };
    const r = await act(controller, { device: "iphone-15" });
    expect(r.error).toBe("Setting the viewport failed: boom");
    expect(state).toEqual(CLEAN);
  });

  it("takes screenshots through the emulated path while the layer is active", async () => {
    const { controller, page } = rig();
    const send = page.sendCdp!;
    page.sendCdp = async (method, params) => {
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 } };
      if (method === "Page.captureScreenshot") return { data: "QUJD" };
      return send(method, params);
    };
    await act(controller, { device: "custom", width: 800, height: 600 });
    const shot = (await controller.screenshot({})) as Record<string, any>;
    expect(shot.error).toBeUndefined();
    expect(JSON.stringify(shot)).toContain("data:image/jpeg;base64,QUJD");
    expect(shot).toMatchObject({ width: 800, height: 600 });
  });
});

describe("act viewport over a fixture", () => {
  const fixture = { version: 1 as const, url: "https://a.test/", emulate: { device: "iphone-15" as const, colorScheme: "dark" as const, timezone: "Europe/Berlin" } };

  it("keeps the fixture's colour scheme and time zone, replaces its device, and reset gives the fixture back", async () => {
    const { controller, state } = rig();
    expect((await controller.applyFixture(fixture)).ok).toBe(true);
    expect(state.userAgent).toBe(IPHONE_UA);
    const r = await act(controller, { device: "desktop-1440" });
    expect(r).toMatchObject({ ok: true, reloaded: true, viewport: { width: 1440 } });
    expect(state.userAgent).toBeUndefined();
    expect(state.touch).toBeUndefined();
    expect(state.media).toEqual({ "prefers-color-scheme": "dark" });
    expect(state.timezone).toBe("Europe/Berlin");
    const back = await act(controller, { device: "reset" });
    expect(back).toMatchObject({ ok: true, reloaded: true, device: "reset", viewport: { width: 393, mobile: true } });
    expect(state.userAgent).toBe(IPHONE_UA);
    expect(state.media).toEqual({ "prefers-color-scheme": "dark" });
  });

  it("releaseFixture after an action leaves no override", async () => {
    const { controller, state } = rig();
    const applied = await controller.applyFixture(fixture);
    await act(controller, { device: "custom", width: 900, height: 700 });
    await act(controller, { device: "ipad" });
    await controller.releaseFixture((applied as { fixtureToken: string }).fixtureToken);
    expect(state).toEqual(CLEAN);
  });

  it("releaseFixture without a token clears a layer left by a run with no fixture", async () => {
    const { controller, state } = rig();
    await act(controller, { device: "pixel-8" });
    await controller.releaseFixture();
    expect(state).toEqual(CLEAN);
  });

  it("clearActEmulation without a fixture clears everything and is idempotent", async () => {
    const { controller, state } = rig();
    await act(controller, { device: "pixel-8" });
    await controller.clearActEmulation();
    expect(state).toEqual(CLEAN);
    await controller.clearActEmulation();
    expect(state).toEqual(CLEAN);
  });

  it("clearActEmulation with a fixture returns the page to the fixture's state", async () => {
    const { controller, state } = rig();
    await controller.applyFixture(fixture);
    await act(controller, { device: "desktop-1920" });
    await controller.clearActEmulation();
    expect(state.userAgent).toBe(IPHONE_UA);
    expect(state.metrics).toMatchObject({ width: 393 });
    expect(state.media).toEqual({ "prefers-color-scheme": "dark" });
  });

  it("controllerBridge forwards clearActEmulation", async () => {
    const { controller, state } = rig();
    await act(controller, { device: "ipad" });
    await controllerBridge(controller).clearActEmulation!();
    expect(state).toEqual(CLEAN);
  });
});

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

describe("act viewport: concurrency and cleanup", () => {
  it("clearActEmulation waits for a viewport action in flight and leaves nothing behind", async () => {
    const { controller, page, state } = rig();
    const g = gate();
    const send = page.sendCdp!;
    page.sendCdp = async (method, params) => {
      if (method === "Emulation.setDeviceMetricsOverride") await g.promise;
      return send(method, params);
    };
    const acting = act(controller, { device: "desktop-1440" });
    await new Promise((r) => setTimeout(r, 10));
    const clearing = controller.clearActEmulation();
    setTimeout(g.open, 20);
    await Promise.all([acting, clearing]);
    expect(state).toEqual(CLEAN);
  });

  it("a timed-out viewport action does not install after the run ended, and says the change may still apply", async () => {
    const state: Overrides = { media: {} };
    const target = fakeTarget({ exec: (code) => (code.includes("innerWidth") ? JSON.stringify({ width: 1280, height: 800, dpr: 1 }) : { ok: true, found: true }) });
    const page = target.pages.get(1)!;
    track(page, state);
    const send = page.sendCdp!;
    const g = gate();
    page.sendCdp = async (method, params) => {
      if (method === "Emulation.setDeviceMetricsOverride") await g.promise;
      return send(method, params);
    };
    const controller = new BrowserController(target, { timeoutMs: 1 });
    const r = await act(controller, { device: "desktop-1440" });
    expect(r.error).toBe("Setting the viewport timed out; the page may have changed. Take a snapshot.");
    const clearing = controller.clearActEmulation();
    setTimeout(g.open, 20);
    await clearing;
    await new Promise((res) => setTimeout(res, 30));
    expect(state).toEqual(CLEAN);
  }, 20_000);

  it("a newer viewport action wins over an abandoned older one", async () => {
    const { controller, page, state } = rig();
    const g = gate();
    const send = page.sendCdp!;
    let first = true;
    page.sendCdp = async (method, params) => {
      if (method === "Emulation.setDeviceMetricsOverride" && first) {
        first = false;
        await g.promise;
      }
      return send(method, params);
    };
    const older = act(controller, { device: "desktop-1440" });
    await new Promise((r) => setTimeout(r, 10));
    const newer = act(controller, { device: "desktop-1920" });
    setTimeout(g.open, 20);
    await Promise.all([older, newer]);
    expect(state.metrics).toMatchObject({ width: 1920 });
  });

  it("clearActEmulation with a fixture does not record the fixture as an act layer: the second call sends nothing", async () => {
    const { controller, page, state } = rig();
    const applied = await controller.applyFixture({ version: 1, url: "https://a.test/", emulate: { device: "iphone-15", colorScheme: "dark" } });
    await act(controller, { device: "desktop-1920" });
    await controller.clearActEmulation();
    expect(state.userAgent).toBe(IPHONE_UA);
    const calls = page.keys.length;
    await controller.clearActEmulation();
    expect(page.keys.length).toBe(calls);
    await controller.releaseFixture((applied as { fixtureToken: string }).fixtureToken);
    expect(state).toEqual(CLEAN);
  });

  it("clearActEmulation with nothing to clear sends nothing", async () => {
    const { controller, page } = rig();
    await controller.clearActEmulation();
    expect(page.keys).toEqual([]);
  });

  it("drops layers of closed pages without any CDP call", async () => {
    const { controller, target } = rig();
    await controller.tabs({ action: "new" });
    const second = target.pages.get(2)!;
    track(second, { media: {} });
    await act(controller, { device: "ipad" });
    const before = second.keys.length;
    await target.closePage!(2);
    await controller.clearActEmulation();
    expect(second.keys.length).toBe(before);
  });
});

describe("act viewport: user agent clear fallback and failures", () => {
  const fixture = { version: 1 as const, url: "https://a.test/", emulate: { device: "iphone-15" as const } };

  it("restores the original user agent when the empty override is refused", async () => {
    const { controller, page, state } = rig();
    await controller.applyFixture(fixture);
    const send = page.sendCdp!;
    page.sendCdp = async (method, params) => {
      if (method === "Emulation.setUserAgentOverride" && (params as { userAgent?: string })?.userAgent === "") throw new Error("refused");
      return send(method, params);
    };
    const r = await act(controller, { device: "desktop-1440" });
    expect(r.ok).toBe(true);
    expect(state.userAgent).toBe(REAL_UA);
  });

  it("reports an error when the user agent cannot be cleared at all", async () => {
    const { controller, page } = rig();
    await controller.applyFixture(fixture);
    const send = page.sendCdp!;
    page.sendCdp = async (method, params) => {
      if (method === "Emulation.setUserAgentOverride") throw new Error("refused");
      return send(method, params);
    };
    const r = await act(controller, { device: "desktop-1440" });
    expect(r.error).toContain("Setting the viewport failed");
    expect(r.ok).toBeUndefined();
  });

  it("a failed install goes back to the previous layer and drops the snapshot", async () => {
    const { controller, page, state } = rig();
    await act(controller, { device: "ipad" });
    const ipad = { ...state.metrics! };
    const snapshot = (await controller.snapshot()) as Record<string, any>;
    const send = page.sendCdp!;
    page.sendCdp = async (method, params) => {
      if (method === "Emulation.setTouchEmulationEnabled" && (params as { enabled?: boolean })?.enabled && (page.keys.filter((k) => k.method === "Emulation.setDeviceMetricsOverride").at(-1)?.params as { width?: number })?.width === 393) throw new Error("boom");
      return send(method, params);
    };
    const r = await act(controller, { device: "iphone-15" });
    expect(r.error).toContain("Setting the viewport failed: boom");
    expect(state.metrics).toEqual(ipad);
    const stale = (await controller.perform({ index: 0, snapshotId: snapshot.snapshotId, action: "click" } as never)) as Record<string, any>;
    expect(String(stale.error)).toContain("snapshotId");
  });

  it("reloads when a failed attempt could not be put back and the identity changed", async () => {
    const { controller, page, reloads } = rig();
    await act(controller, { device: "iphone-15" });
    const before = reloads();
    const send = page.sendCdp!;
    page.sendCdp = async (method, params) => {
      if (method === "Emulation.setDeviceMetricsOverride") throw new Error("boom");
      return send(method, params);
    };
    const r = await act(controller, { device: "desktop-1440" });
    expect(r.error).toContain("Setting the viewport failed");
    expect(reloads()).toBe(before + 1);
  });
});
