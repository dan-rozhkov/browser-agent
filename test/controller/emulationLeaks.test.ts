import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserController } from "../../src/controller/controller.js";
import { fakeTarget, type FakePage } from "../fixture/fakes.js";

const REAL_UA = "Mozilla/5.0 (Macintosh) Chrome/126.0.0.0 Safari/537.36";

interface Overrides {
  metrics?: { width: number; height: number };
  touch?: boolean;
  userAgent?: string;
  media: Record<string, string>;
  timezone?: string;
  locale?: string;
  extraHeaders: boolean;
  /** Init scripts added and not yet removed. */
  scripts: Set<string>;
}
const clean = (): Overrides => ({ media: {}, extraHeaders: false, scripts: new Set() });

function track(page: FakePage, state: Overrides): void {
  let n = 0;
  page.sendCdp = async (method, params) => {
    page.keys.push({ method, params });
    const p = (params ?? {}) as Record<string, any>;
    if (method === "Emulation.setDeviceMetricsOverride") state.metrics = { width: p.width, height: p.height };
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
    } else if (method === "Emulation.setLocaleOverride") {
      if (p.locale) state.locale = p.locale;
      else delete state.locale;
    } else if (method === "Network.setExtraHTTPHeaders") state.extraHeaders = Object.keys(p.headers ?? {}).length > 0;
    else if (method === "Page.addScriptToEvaluateOnNewDocument") {
      const identifier = `script-${++n}`;
      state.scripts.add(identifier);
      return { identifier };
    } else if (method === "Page.removeScriptToEvaluateOnNewDocument") state.scripts.delete(p.identifier);
    return undefined;
  };
}

function rig(opts: { timeoutMs?: number } = {}) {
  const state = clean();
  const target = fakeTarget({
    withNetwork: true,
    exec: (code) => {
      if (code.includes("userAgentData")) return JSON.stringify({ ua: REAL_UA });
      if (code.includes("innerWidth")) return JSON.stringify({ width: state.metrics?.width ?? 1280, height: state.metrics?.height ?? 800, dpr: 1 });
      return { ok: true, found: true };
    },
  });
  const page = target.pages.get(1)!;
  track(page, state);
  const controller = new BrowserController(target, opts);
  return { controller, target, page, state };
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}
const act = (c: BrowserController, args: Record<string, unknown>) => c.act({ action: "viewport", ...args }) as Promise<Record<string, any>>;
const tokenOf = (r: unknown): string => (r as { fixtureToken: string }).fixtureToken;

afterEach(() => vi.useRealTimers());

describe("emulation registry and final sweep", () => {
  const fixture = { version: 1 as const, url: "https://a.test/", emulate: { locale: "de-DE", timezone: "Europe/Berlin", colorScheme: "dark" as const } };

  it("fixture locale + viewport + reset x3 + run end leaves no override and no init script", async () => {
    const { controller, state } = rig();
    const applied = await controller.applyFixture(fixture);
    expect(applied.ok).toBe(true);
    expect(state.scripts.size).toBe(1);
    await act(controller, { device: "custom", width: 800, height: 600 });
    for (let i = 0; i < 3; i++) await act(controller, { device: "reset" });
    await controller.clearActEmulation();
    await controller.releaseFixture(tokenOf(applied));
    expect(state.scripts.size).toBe(0);
    expect(state).toEqual(clean());
  });

  it("clearActEmulation with a fixture does not stack a second locale script per call", async () => {
    const { controller, state } = rig();
    const applied = await controller.applyFixture(fixture);
    await act(controller, { device: "custom", width: 800, height: 600 });
    for (let i = 0; i < 3; i++) {
      await controller.clearActEmulation();
      await act(controller, { device: "custom", width: 700, height: 500 });
    }
    await controller.clearActEmulation();
    // The fixture's own script plus the one restore of the fixture state: never more.
    expect(state.scripts.size).toBeLessThanOrEqual(2);
    await controller.releaseFixture(tokenOf(applied));
    expect(state.scripts.size).toBe(0);
    expect(state).toEqual(clean());
  });

  it("run end without a fixture sweeps what a viewport layer with a locale-free emulation left", async () => {
    const { controller, state } = rig();
    await act(controller, { device: "iphone-15" });
    await controller.clearActEmulation();
    expect(state).toEqual(clean());
  });
});

describe("a stale viewport step never resurrects or records", () => {
  const fixture = { version: 1 as const, url: "https://a.test/", emulate: { locale: "de-DE", colorScheme: "dark" as const } };

  it("a timed-out action that wakes after the fixture release does not re-install the released fixture", async () => {
    const { controller, page, state } = rig({ timeoutMs: 1 });
    const applied = await controller.applyFixture(fixture);
    vi.useFakeTimers();
    const g = gate();
    const send = page.sendCdp!;
    let armed = true;
    // The device clear that precedes the install of the new layer is where the action stalls.
    page.sendCdp = async (method, params) => {
      if (armed && method === "Emulation.setTouchEmulationEnabled" && (params as { enabled?: boolean }).enabled === false) {
        armed = false;
        await g.promise;
      }
      return send(method, params);
    };
    const acting = act(controller, { device: "desktop-1440" });
    await vi.advanceTimersByTimeAsync(6_000);
    expect((await acting).error).toContain("timed out");
    const releasing = controller.releaseFixture(tokenOf(applied));
    await vi.advanceTimersByTimeAsync(10);
    g.open();
    await vi.advanceTimersByTimeAsync(100);
    await releasing;
    await vi.advanceTimersByTimeAsync(100);
    expect(state).toEqual(clean());
  });

  it("the error recovery of an action that failed after the run ended records no layer", async () => {
    const { controller, page, state } = rig({ timeoutMs: 1 });
    await act(controller, { device: "ipad" });
    vi.useFakeTimers();
    const g = gate();
    const send = page.sendCdp!;
    page.sendCdp = async (method, params) => {
      if (method === "Emulation.setTouchEmulationEnabled" && (params as { enabled?: boolean }).enabled === true && (state.metrics?.width === 393)) {
        await g.promise;
        throw new Error("boom");
      }
      return send(method, params);
    };
    const acting = act(controller, { device: "iphone-15" });
    await vi.advanceTimersByTimeAsync(6_000);
    expect((await acting).error).toContain("timed out");
    const clearing = controller.clearActEmulation();
    // The clear waits out the grace of the abandoned action, then ends; only then does the action fail.
    await vi.advanceTimersByTimeAsync(10_500);
    await clearing;
    g.open();
    await vi.advanceTimersByTimeAsync(500);
    expect(state).toEqual(clean());
  });
});

describe("clearActEmulation timeout", () => {
  it("a clear that outlives its bound holds the next command until it settles", async () => {
    const { controller, page } = rig();
    await act(controller, { device: "desktop-1440" });
    vi.useFakeTimers();
    const g = gate();
    const send = page.sendCdp!;
    page.sendCdp = async (method, params) => {
      if (method === "Emulation.clearDeviceMetricsOverride") await g.promise;
      return send(method, params);
    };
    const clearing = controller.clearActEmulation();
    await vi.advanceTimersByTimeAsync(10_500);
    await clearing;
    const installs = () => page.keys.filter((k) => k.method === "Emulation.setDeviceMetricsOverride").length;
    const before = installs();
    const next = act(controller, { device: "custom", width: 700, height: 500 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(installs()).toBe(before);
    g.open();
    await vi.advanceTimersByTimeAsync(200);
    expect((await next).ok).toBe(true);
    expect(installs()).toBe(before + 1);
  });

  it("the abandoned clear does not restore the fixture state after the fixture was released", async () => {
    const { controller, page, state } = rig();
    const applied = await controller.applyFixture({ version: 1, url: "https://a.test/", emulate: { colorScheme: "dark", device: "iphone-15" } });
    await act(controller, { device: "desktop-1440" });
    vi.useFakeTimers();
    const g = gate();
    const send = page.sendCdp!;
    let metricsClears = 0;
    let stalled = false;
    page.sendCdp = async (method, params) => {
      if (method === "Emulation.clearDeviceMetricsOverride") metricsClears += 1;
      // The second metrics clear is the restore's own device clear: it stalls on the touch reset that follows.
      if (!stalled && metricsClears >= 2 && method === "Emulation.setTouchEmulationEnabled" && (params as { enabled?: boolean }).enabled === false) {
        stalled = true;
        await g.promise;
      }
      return send(method, params);
    };
    const clearing = controller.clearActEmulation();
    await vi.advanceTimersByTimeAsync(10_500);
    await clearing;
    // The release queues behind the abandoned clear (an overrun) and cancels what is left of it.
    const releasing = controller.releaseFixture(tokenOf(applied));
    await vi.advanceTimersByTimeAsync(10);
    g.open();
    await vi.advanceTimersByTimeAsync(500);
    await releasing;
    expect(stalled).toBe(true);
    expect(state).toEqual(clean());
  });
});

describe("apply token", () => {
  const withCookie = { version: 1 as const, url: "https://a.test/", storage: { cookies: [{ name: "a", value: "b", domain: "a.test" }] } };

  it("a late settle of an abandoned apply does not hide a newer hung apply from releaseFixture", async () => {
    vi.useFakeTimers();
    const { controller, target } = rig();
    const gates = [gate(), gate()];
    let calls = 0;
    target.setCookies = async () => { await gates[calls++]!.promise; };
    const a = controller.applyFixture(withCookie);
    await vi.advanceTimersByTimeAsync(400_000);
    expect(await a).toMatchObject({ ok: false });
    const b = controller.applyFixture(withCookie);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toBe(2);
    // The abandoned apply A settles while B still hangs.
    gates[0]!.open();
    await vi.advanceTimersByTimeAsync(100);
    let released = false;
    const releasing = controller.releaseFixture().then(() => { released = true; });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(released).toBe(true);
    await releasing;
    gates[1]!.open();
    await vi.advanceTimersByTimeAsync(400_000);
    await b;
  });
});
