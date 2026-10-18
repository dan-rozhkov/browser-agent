import { describe, expect, it } from "vitest";
import { applyFixture, fixtureBudgetMs } from "../../src/fixture/apply.js";
import { captureFixture } from "../../src/fixture/capture.js";
import { DEVICE_PRESETS, resolveEmulation } from "../../src/fixture/emulate.js";
import { parsePageFixture } from "../../src/fixture/parse.js";
import { BrowserController } from "../../src/controller/controller.js";
import { fakeTarget, type FakePage } from "./fakes.js";

const UA = "Mozilla/5.0 (X11; Linux x86_64) Chrome/126";
/** A script answer that serves the fixture scripts and the user-agent read. */
const exec = (code: string) => (code === "navigator.userAgent" ? UA : { ok: true, found: true });
const methods = (page: FakePage) => page.keys.map((k) => k.method);

describe("parsePageFixture emulate", () => {
  it("accepts every field and a preset", () => {
    const emulate = {
      device: "pixel-8",
      viewport: { width: 500, height: 900, deviceScaleFactor: 2, mobile: true },
      touch: true,
      userAgent: "UA",
      locale: "de-DE",
      timezone: "Europe/Berlin",
      colorScheme: "dark",
      reducedMotion: true,
    };
    expect(parsePageFixture({ version: 1, emulate, extra: 1 })).toEqual({ ok: true, value: { version: 1, emulate } });
    expect(parsePageFixture({ version: 1, emulate: {} })).toEqual({ ok: true, value: { version: 1, emulate: {} } });
    for (const device of Object.keys(DEVICE_PRESETS)) expect(parsePageFixture({ version: 1, emulate: { device } }).ok).toBe(true);
  });

  it("accepts a fractional deviceScaleFactor", () => {
    expect(parsePageFixture({ version: 1, emulate: { viewport: { width: 400, height: 800, deviceScaleFactor: 2.625 } } }).ok).toBe(true);
  });

  it("drops unknown fields inside emulate", () => {
    const r = parsePageFixture({ version: 1, emulate: { locale: "en-US", geolocation: { lat: 1 } } });
    expect(r).toEqual({ ok: true, value: { version: 1, emulate: { locale: "en-US" } } });
  });

  it.each([
    [{ device: "nokia" }, "fixture.emulate.device"],
    [{ viewport: { width: 199, height: 800 } }, "fixture.emulate.viewport.width"],
    [{ viewport: { width: 800, height: 4001 } }, "fixture.emulate.viewport.height"],
    [{ viewport: { width: 800 } }, "fixture.emulate.viewport.height"],
    [{ viewport: { width: 800.5, height: 800 } }, "fixture.emulate.viewport.width"],
    [{ viewport: { width: 800, height: 600.25 } }, "fixture.emulate.viewport.height"],
    [{ viewport: { width: 800, height: 800, deviceScaleFactor: 0.4 } }, "deviceScaleFactor"],
    [{ viewport: { width: 800, height: 800, deviceScaleFactor: 5 } }, "deviceScaleFactor"],
    [{ userAgent: "x".repeat(513) }, "fixture.emulate.userAgent"],
    [{ locale: "not a locale" }, "fixture.emulate.locale"],
    [{ timezone: "Berlin time" }, "fixture.emulate.timezone"],
    [{ colorScheme: "sepia" }, "fixture.emulate.colorScheme"],
    [{ reducedMotion: "yes" }, "fixture.emulate.reducedMotion"],
    ["phone", "fixture.emulate"],
  ])("rejects %j", (emulate, path) => {
    const r = parsePageFixture({ version: 1, emulate });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(path);
  });
});

describe("resolveEmulation", () => {
  it("takes the preset and lets explicit fields override it", () => {
    expect(resolveEmulation({ device: "iphone-15" })).toMatchObject({ metrics: { width: 393, height: 852, deviceScaleFactor: 3, mobile: true }, touch: true });
    const r = resolveEmulation({ device: "iphone-15", viewport: { width: 500, height: 600 }, touch: false, userAgent: "mine" });
    expect(r.metrics).toEqual({ width: 500, height: 600, deviceScaleFactor: 3, mobile: true });
    expect(r.touch).toBe(false);
    expect(r.userAgent).toBe("mine");
  });

  it("touches nothing that is not asked for", () => {
    expect(resolveEmulation({ locale: "fr-FR" })).toEqual({ locale: "fr-FR" });
    expect(resolveEmulation({ device: "desktop-1440" }).userAgent).toBeUndefined();
  });
});

describe("applyFixture emulate", () => {
  it("applies after fresh and before the start page", async () => {
    const t = fakeTarget({ exec, withReset: true });
    const r = await applyFixture(t, { version: 1, fresh: true, url: "https://a.test/", emulate: { device: "iphone-15" } });
    expect(r.ok).toBe(true);
    const page = t.pages.get(1)!;
    expect(methods(page)).toEqual(["Emulation.setDeviceMetricsOverride", "Emulation.setTouchEmulationEnabled", "Emulation.setUserAgentOverride"]);
    expect(page.keys[0]!.params).toEqual({ width: 393, height: 852, deviceScaleFactor: 3, mobile: true });
    const log = t.log;
    expect(log.indexOf("reset")).toBeLessThan(log.indexOf("main: load https://a.test/"));
    // the user agent was read before it was overridden
    expect(log.indexOf("main: js")).toBeGreaterThanOrEqual(0);
    if (r.ok) expect(r.summary).toContain("emulation (iphone-15)");
  });

  it("sends locale, time zone and media features", async () => {
    const t = fakeTarget({ exec });
    await applyFixture(t, { version: 1, emulate: { locale: "de-DE", timezone: "Europe/Berlin", colorScheme: "dark", reducedMotion: true } });
    const page = t.pages.get(1)!;
    expect(page.keys).toEqual([
      { method: "Emulation.setLocaleOverride", params: { locale: "de-DE" } },
      { method: "Emulation.setTimezoneOverride", params: { timezoneId: "Europe/Berlin" } },
      { method: "Emulation.setEmulatedMedia", params: { features: [{ name: "prefers-color-scheme", value: "dark" }, { name: "prefers-reduced-motion", value: "reduce" }] } },
    ]);
  });

  it("fails with stage emulate when the page has no sendCdp", async () => {
    const t = fakeTarget({ exec });
    delete t.pages.get(1)!.sendCdp;
    const r = await applyFixture(t, { version: 1, url: "https://a.test/", emulate: { device: "pixel-8" } });
    expect(r).toEqual({ ok: false, stage: "emulate", error: "This browser does not support emulation." });
    expect(t.log.some((l) => l.includes("load"))).toBe(false);
  });

  it("emulates the fixture's extra tabs too", async () => {
    const t = fakeTarget({ exec });
    const r = await applyFixture(t, { version: 1, url: "https://a.test/", tabs: ["https://b.test/"], emulate: { viewport: { width: 600, height: 800 } } });
    expect(r.ok).toBe(true);
    expect(methods(t.pages.get(1)!)).toEqual(["Emulation.setDeviceMetricsOverride"]);
    expect(methods(t.pages.get(2)!)).toEqual(["Emulation.setDeviceMetricsOverride"]);
  });

  it("emulates an extra tab BEFORE its first load", async () => {
    for (const hooks of [undefined, { navigate: async () => ({ ok: true as const }) }]) {
      const t = fakeTarget({ exec });
      const original = t.newPage!;
      t.newPage = async (url) => {
        const info = await original(url);
        const tab = t.pages.get(info.tabId)!;
        const record = tab.sendCdp!;
        tab.sendCdp = async (method, params) => {
          t.log.push(`tab: ${method}`);
          return record(method, params);
        };
        return info;
      };
      if (hooks) hooks.navigate = async () => { t.log.push("tab: hook navigate"); return { ok: true as const }; };
      const r = await applyFixture(t, { version: 1, tabs: ["https://b.test/"], emulate: { viewport: { width: 600, height: 800 } } }, {}, hooks);
      expect(r.ok).toBe(true);
      const emulated = t.log.indexOf("tab: Emulation.setDeviceMetricsOverride");
      const loaded = t.log.findIndex((l) => l === "tab: hook navigate" || l.includes("load https://b.test/"));
      expect(emulated).toBeGreaterThanOrEqual(0);
      expect(loaded).toBeGreaterThan(emulated);
    }
  });

  it("legacy host: a deprecated openTab hook (no newTab) opens and loads the tab, which is emulated afterwards", async () => {
    const t = fakeTarget({ exec });
    const opened: string[] = [];
    const hooks = {
      openTab: async (url: string) => {
        opened.push(url);
        await t.newPage!(url);
        t.log.push("hook openTab done");
        return { ok: true as const };
      },
    };
    const record = (id: number) => t.pages.get(id)!;
    const r = await applyFixture(t, { version: 1, tabs: ["https://b.test/"], emulate: { viewport: { width: 600, height: 800 } } }, {}, hooks);
    expect(r.ok).toBe(true);
    expect(opened).toEqual(["https://b.test/"]);
    expect(t.newPageArgs).toEqual(["https://b.test/"]);
    expect(methods(record(2))).toEqual(["Emulation.setDeviceMetricsOverride"]);
  });

  it("newTab wins over a deprecated openTab when a host gives both", async () => {
    const t = fakeTarget({ exec });
    const calls: string[] = [];
    const hooks = {
      openTab: async () => { calls.push("openTab"); return { ok: true as const }; },
      newTab: async () => { calls.push("newTab"); await t.newPage!(); return { ok: true as const }; },
      navigate: async () => { calls.push("navigate"); return { ok: true as const }; },
    };
    const r = await applyFixture(t, { version: 1, tabs: ["https://b.test/"] }, {}, hooks);
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["newTab", "navigate"]);
  });

  it("fails an extra tab without sendCdp at stage emulate", async () => {
    const t = fakeTarget({ exec });
    const original = t.newPage!;
    t.newPage = async (url) => {
      const info = await original(url);
      delete t.pages.get(info.tabId)!.sendCdp;
      return info;
    };
    const r = await applyFixture(t, { version: 1, tabs: ["https://b.test/"], emulate: { touch: true } });
    expect(r).toMatchObject({ ok: false, stage: "emulate" });
    // the main tab was cleared by the error path
    expect(methods(t.pages.get(1)!)).toEqual(["Emulation.setTouchEmulationEnabled", "Emulation.setTouchEmulationEnabled"]);
  });

  it("release clears every override once, and removes the user agent override with an empty string", async () => {
    const t = fakeTarget({ exec });
    const r = await applyFixture(t, {
      version: 1,
      emulate: { device: "pixel-8", locale: "de-DE", timezone: "Europe/Berlin", colorScheme: "light", reducedMotion: false },
    });
    if (!r.ok || !r.release) throw new Error("expected a release");
    const page = t.pages.get(1)!;
    page.keys.length = 0;
    await Promise.all([r.release(), r.release()]);
    await r.release();
    expect(page.keys).toEqual([
      { method: "Emulation.setEmulatedMedia", params: { features: [{ name: "prefers-color-scheme", value: "" }, { name: "prefers-reduced-motion", value: "" }] } },
      { method: "Emulation.setTimezoneOverride", params: { timezoneId: "" } },
      { method: "Emulation.setLocaleOverride", params: {} },
      { method: "Emulation.setUserAgentOverride", params: { userAgent: "" } },
      { method: "Emulation.setTouchEmulationEnabled", params: { enabled: false } },
      { method: "Emulation.clearDeviceMetricsOverride", params: undefined },
    ]);
  });

  it("release falls back to the original user agent when the empty override is rejected", async () => {
    const t = fakeTarget({ exec });
    const r = await applyFixture(t, { version: 1, emulate: { device: "pixel-8" } });
    if (!r.ok || !r.release) throw new Error("expected a release");
    const page = t.pages.get(1)!;
    const record = page.sendCdp!;
    page.keys.length = 0;
    page.sendCdp = async (method, params) => {
      if (method === "Emulation.setUserAgentOverride" && params?.userAgent === "") throw new Error("empty UA rejected");
      return record(method, params);
    };
    await r.release();
    expect(page.keys.filter((k) => k.method === "Emulation.setUserAgentOverride")).toEqual([{ method: "Emulation.setUserAgentOverride", params: { userAgent: UA } }]);
  });

  it("composes with the network release", async () => {
    const t = fakeTarget({ exec, withNetwork: true });
    const r = await applyFixture(t, { version: 1, network: [{ url: "https://x.test/*" }], emulate: { touch: true } }, { allowNetworkMocks: true });
    if (!r.ok || !r.release) throw new Error("expected a release");
    const page = t.pages.get(1)!;
    await r.release();
    await r.release();
    expect(t.unrouted).toBe(1);
    expect(methods(page)).toEqual(["Emulation.setTouchEmulationEnabled", "Emulation.setTouchEmulationEnabled"]);
  });

  it("keeps a release for a fixture with only emulate", async () => {
    const t = fakeTarget({ exec });
    const r = await applyFixture(t, { version: 1, emulate: { colorScheme: "dark" } });
    expect(r.ok && typeof r.release).toBe("function");
  });

  it("a release on a closed tab does not throw", async () => {
    const t = fakeTarget({ exec });
    const r = await applyFixture(t, { version: 1, emulate: { device: "ipad" } });
    if (!r.ok || !r.release) throw new Error("expected a release");
    t.pages.get(1)!.sendCdp = async () => {
      throw new Error("Target closed");
    };
    await expect(r.release()).resolves.toBeUndefined();
  });

  it("the error path releases the emulation", async () => {
    const t = fakeTarget({ exec });
    const r = await applyFixture(t, { version: 1, emulate: { touch: true }, steps: [{ action: "click", selector: "#x" }], expect: { text: "never", timeoutMs: 0 } });
    expect(r.ok).toBe(false);
    expect(methods(t.pages.get(1)!).slice(-1)).toEqual(["Emulation.setTouchEmulationEnabled"]);
    expect(t.pages.get(1)!.keys.at(-1)!.params).toEqual({ enabled: false });
  });

  it("a failed override clears the ones set before it", async () => {
    const t = fakeTarget({ exec });
    const page = t.pages.get(1)!;
    const record = page.sendCdp!;
    page.sendCdp = async (method, params) => {
      if (method === "Emulation.setLocaleOverride") throw new Error("bad locale");
      return record(method, params);
    };
    const r = await applyFixture(t, { version: 1, emulate: { touch: true, locale: "de-DE" } });
    expect(r).toMatchObject({ ok: false, stage: "emulate" });
    expect(page.keys.at(-1)).toEqual({ method: "Emulation.setTouchEmulationEnabled", params: { enabled: false } });
  });

  it("counts emulation in the budget", () => {
    const base = fixtureBudgetMs({ version: 1 });
    expect(fixtureBudgetMs({ version: 1, emulate: { touch: true } })).toBeGreaterThan(base);
  });
});

describe("captureFixture emulate", () => {
  it("includes the emulation the host passes", async () => {
    const t = fakeTarget({ exec: () => JSON.stringify({ ok: true, localStorage: {}, sessionStorage: {} }) });
    const r = await captureFixture(t, { emulate: { device: "ipad" } });
    expect(r).toEqual({ ok: true, fixture: { version: 1, emulate: { device: "ipad" } } });
  });
});

describe("BrowserController emulation", () => {
  const jpeg = Buffer.from("fake-jpeg").toString("base64");

  function emulatedTarget() {
    const t = fakeTarget({ exec });
    const page = t.pages.get(1)!;
    let plainCaptures = 0;
    page.capture = async () => {
      plainCaptures += 1;
      return { imageData: "plain", width: 10, height: 10 };
    };
    const record = page.sendCdp!;
    page.sendCdp = async (method, params) => {
      await record(method, params);
      return method === "Page.captureScreenshot" ? { data: jpeg } : undefined;
    };
    return { t, page, plain: () => plainCaptures };
  }

  it("screenshots with Page.captureScreenshot while emulation is active", async () => {
    const { t, page, plain } = emulatedTarget();
    const c = new BrowserController(t);
    expect((await c.applyFixture({ version: 1, url: "https://a.test/", emulate: { device: "iphone-15" } })).ok).toBe(true);
    const shot = await c.screenshot({});
    expect(shot).toMatchObject({ imageData: jpeg, width: 393, height: 852 });
    const call = page.keys.find((k) => k.method === "Page.captureScreenshot")!;
    expect(call.params).toMatchObject({ format: "jpeg", quality: 70, clip: { width: 393, height: 852, scale: 1 / 3 } });
    expect(plain()).toBe(0);
  });

  it("clips from the visible viewport (cssVisualViewport), not the document origin, when the page is scrolled", async () => {
    const { t, page } = emulatedTarget();
    const record = page.sendCdp!;
    page.sendCdp = async (method, params) => {
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 1200, clientWidth: 393, clientHeight: 852 } };
      return record(method, params);
    };
    const c = new BrowserController(t);
    await c.applyFixture({ version: 1, url: "https://a.test/", emulate: { device: "iphone-15" } });
    const shot = await c.screenshot({});
    expect(shot).toMatchObject({ width: 393, height: 852 });
    expect(page.keys.find((k) => k.method === "Page.captureScreenshot")!.params).toMatchObject({ clip: { x: 0, y: 1200, width: 393, height: 852 } });
  });

  it("clips the whole 980 px layout of a mobile page without a meta viewport, not the emulated 393 px", async () => {
    const { t, page } = emulatedTarget();
    const record = page.sendCdp!;
    page.sendCdp = async (method, params) => {
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 980, clientHeight: 2100 } };
      return record(method, params);
    };
    const c = new BrowserController(t);
    await c.applyFixture({ version: 1, url: "https://a.test/", emulate: { device: "iphone-15" } });
    const shot = await c.screenshot({});
    expect(shot).toMatchObject({ width: 980, height: 2100 });
    expect(page.keys.find((k) => k.method === "Page.captureScreenshot")!.params).toMatchObject({ clip: { width: 980, height: 2100, scale: 1 / 3 } });
  });

  it("still caps a wide visual viewport at 1280 output px", async () => {
    const { t, page } = emulatedTarget();
    const record = page.sendCdp!;
    page.sendCdp = async (method, params) => {
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 2560, clientHeight: 1000 } };
      return record(method, params);
    };
    const c = new BrowserController(t);
    await c.applyFixture({ version: 1, emulate: { device: "iphone-15" } });
    expect(await c.screenshot({})).toMatchObject({ width: 1280, height: 500 });
  });

  it("caps the width at 1280", async () => {
    const { t, page } = emulatedTarget();
    const c = new BrowserController(t);
    await c.applyFixture({ version: 1, emulate: { viewport: { width: 2560, height: 1000 } } });
    const shot = await c.screenshot({});
    expect(shot).toMatchObject({ width: 1280, height: 500 });
    expect(page.keys.find((k) => k.method === "Page.captureScreenshot")!.params).toMatchObject({ clip: { width: 2560, height: 1000, scale: 0.5 } });
  });

  it("goes back to page.capture() after releaseFixture", async () => {
    const { t, page, plain } = emulatedTarget();
    const c = new BrowserController(t);
    await c.applyFixture({ version: 1, emulate: { device: "pixel-8" } });
    await c.releaseFixture();
    const shot = await c.screenshot({});
    expect(shot).toMatchObject({ imageData: "plain" });
    expect(plain()).toBe(1);
    expect(page.keys.some((k) => k.method === "Page.captureScreenshot")).toBe(false);
    expect(methods(page)).toContain("Emulation.clearDeviceMetricsOverride");
  });

  it("uses page.capture() when no emulation is active", async () => {
    const { t, plain } = emulatedTarget();
    const shot = await new BrowserController(t).screenshot({});
    expect(shot).toMatchObject({ imageData: "plain" });
    expect(plain()).toBe(1);
  });

  it("falls back to page.capture() when the CDP screenshot fails", async () => {
    const { t, page, plain } = emulatedTarget();
    const c = new BrowserController(t);
    await c.applyFixture({ version: 1, emulate: { device: "ipad" } });
    const record = page.sendCdp!;
    page.sendCdp = async (method, params) => {
      if (method === "Page.captureScreenshot") throw new Error("no");
      return record(method, params);
    };
    expect(await c.screenshot({})).toMatchObject({ imageData: "plain" });
    expect(plain()).toBe(1);
  });

  it("captureFixture reports the active emulation, and not after release", async () => {
    const t = fakeTarget({ exec: (code) => (code === "navigator.userAgent" ? UA : JSON.stringify({ ok: true, localStorage: {}, sessionStorage: {} })) });
    const c = new BrowserController(t);
    await c.applyFixture({ version: 1, emulate: { device: "pixel-8", colorScheme: "dark" } });
    const withEmulation = await c.captureFixture();
    expect(withEmulation).toMatchObject({ ok: true, fixture: { emulate: { device: "pixel-8", colorScheme: "dark" } } });
    await c.releaseFixture();
    const after = await c.captureFixture();
    expect(after.ok && "emulate" in after.fixture).toBe(false);
  });

  it("a new fixture without emulate replaces the old emulation", async () => {
    const { t, page } = emulatedTarget();
    const c = new BrowserController(t);
    await c.applyFixture({ version: 1, emulate: { device: "pixel-8" } });
    await c.applyFixture({ version: 1, url: "https://a.test/" });
    expect(methods(page)).toContain("Emulation.clearDeviceMetricsOverride");
    expect(await c.screenshot({})).toMatchObject({ imageData: "plain" });
  });
});
