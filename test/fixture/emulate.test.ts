import { describe, expect, it, vi } from "vitest";
import { applyFixture, fixtureBudgetMs } from "../../src/fixture/apply.js";
import { captureFixture } from "../../src/fixture/capture.js";
import { DEVICE_PRESETS, resolveEmulation } from "../../src/fixture/emulate.js";
import { parsePageFixture } from "../../src/fixture/parse.js";
import { BrowserController } from "../../src/controller/controller.js";
import { fakeTarget, type FakePage } from "./fakes.js";

const UA = "Mozilla/5.0 (X11; Linux x86_64) Chrome/126";
/** The environment read (user agent + client hints) is the one script that mentions getHighEntropyValues. */
const isEnvRead = (code: string) => code.includes("getHighEntropyValues");
/** A script answer that serves the fixture scripts; the environment read answers with the user agent only (no client hints). */
const exec = (code: string) => (isEnvRead(code) ? JSON.stringify({ ua: UA }) : { ok: true, found: true });
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

  /** Makes the fake page answer Page.addScriptToEvaluateOnNewDocument with an identifier, like Chromium. */
  const withScriptId = (page: FakePage) => {
    const base = page.sendCdp!;
    page.sendCdp = async (m, p) => {
      await base(m, p);
      return m === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: "script-7" } : undefined;
    };
  };

  it("a locale alone: header + init script, no user-agent read or override; release removes both", async () => {
    const t = fakeTarget({ exec });
    const page = t.pages.get(1)!;
    withScriptId(page);
    const r = await applyFixture(t, { version: 1, emulate: { locale: "de-DE", timezone: "Europe/Berlin", colorScheme: "dark", reducedMotion: true } });
    if (!r.ok || !r.release) throw new Error("expected a release");
    expect(methods(page)).not.toContain("Emulation.setUserAgentOverride");
    expect(page.keys.find((k) => k.method === "Network.setExtraHTTPHeaders")?.params).toEqual({ headers: { "Accept-Language": "de-DE,de;q=0.9" } });
    const script = String(page.keys.find((k) => k.method === "Page.addScriptToEvaluateOnNewDocument")?.params?.source);
    expect(script).toContain('"de-DE"');
    expect(script).toContain('["de-DE","de"]');
    expect(script).toContain("Navigator.prototype");
    expect(methods(page)).toEqual(expect.arrayContaining(["Emulation.setLocaleOverride", "Emulation.setTimezoneOverride", "Emulation.setEmulatedMedia"]));
    // exactly one script ran: the language script for the open document. No environment (user agent) read.
    const scripts = t.log.filter((l) => l === "main: js");
    expect(scripts).toHaveLength(1);
    expect(page.executed.filter(isEnvRead)).toEqual([]);
    expect(page.executed).toEqual([script]);
    page.keys.length = 0;
    await r.release();
    expect(page.keys).toContainEqual({ method: "Page.removeScriptToEvaluateOnNewDocument", params: { identifier: "script-7" } });
    expect(page.keys).toContainEqual({ method: "Network.setExtraHTTPHeaders", params: { headers: {} } });
    expect(methods(page)).not.toContain("Emulation.setUserAgentOverride");
  });

  it("a bare language subtag gives a plain Accept-Language value", async () => {
    const t = fakeTarget({ exec });
    await applyFixture(t, { version: 1, emulate: { locale: "de" } });
    const page = t.pages.get(1)!;
    expect(page.keys.find((k) => k.method === "Network.setExtraHTTPHeaders")?.params).toEqual({ headers: { "Accept-Language": "de" } });
    expect(String(page.keys.find((k) => k.method === "Page.addScriptToEvaluateOnNewDocument")?.params?.source)).toContain('["de"]');
  });

  /** Makes the named CDP method reject, like a target that refuses it. */
  const rejecting = (page: FakePage, method: string) => {
    const base = page.sendCdp!;
    page.sendCdp = async (m, p) => {
      await base(m, p);
      if (m === method) throw new Error(`no ${method}`);
      return m === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: "script-9" } : undefined;
    };
  };

  it("a locale alone with a rejecting setExtraHTTPHeaders rolls back (no script added, header set cleared)", async () => {
    const t = fakeTarget({ exec });
    const page = t.pages.get(1)!;
    rejecting(page, "Network.setExtraHTTPHeaders");
    const r = await applyFixture(t, { version: 1, emulate: { locale: "de-DE" } });
    expect(r.ok).toBe(false);
    expect(methods(page)).not.toContain("Page.addScriptToEvaluateOnNewDocument");
    expect(methods(page)).not.toContain("Emulation.setLocaleOverride");
    expect(page.keys.filter((k) => k.method === "Network.setExtraHTTPHeaders")).toEqual([
      { method: "Network.setExtraHTTPHeaders", params: { headers: { "Accept-Language": "de-DE,de;q=0.9" } } },
    ]);
  });

  it("a locale alone with a rejecting addScriptToEvaluateOnNewDocument rolls back the header", async () => {
    const t = fakeTarget({ exec });
    const page = t.pages.get(1)!;
    rejecting(page, "Page.addScriptToEvaluateOnNewDocument");
    const r = await applyFixture(t, { version: 1, emulate: { locale: "de-DE" } });
    expect(r.ok).toBe(false);
    expect(page.keys.filter((k) => k.method === "Network.setExtraHTTPHeaders")).toEqual([
      { method: "Network.setExtraHTTPHeaders", params: { headers: { "Accept-Language": "de-DE,de;q=0.9" } } },
      { method: "Network.setExtraHTTPHeaders", params: { headers: {} } },
    ]);
    expect(methods(page)).not.toContain("Emulation.setLocaleOverride");
  });

  it("a locale with a device preset puts acceptLanguage in the device user-agent override; one clear", async () => {
    const t = fakeTarget({ exec });
    const r = await applyFixture(t, { version: 1, emulate: { device: "iphone-15", locale: "fr-FR" } });
    if (!r.ok || !r.release) throw new Error("expected a release");
    const page = t.pages.get(1)!;
    const ua = page.keys.filter((k) => k.method === "Emulation.setUserAgentOverride");
    expect(ua).toHaveLength(1);
    expect(ua[0]!.params).toMatchObject({ acceptLanguage: "fr-FR,fr", platform: "iPhone" });
    expect(String(ua[0]!.params?.userAgent)).toContain("iPhone");
    expect(methods(page)).not.toContain("Network.setExtraHTTPHeaders");
    expect(methods(page)).not.toContain("Page.addScriptToEvaluateOnNewDocument");
    page.keys.length = 0;
    await r.release();
    expect(page.keys.filter((k) => k.method === "Emulation.setUserAgentOverride")).toEqual([{ method: "Emulation.setUserAgentOverride", params: { userAgent: "" } }]);
  });

  it("a locale with an explicit user agent sends both in one override; release clears it once", async () => {
    const t = fakeTarget({ exec });
    const r = await applyFixture(t, { version: 1, emulate: { userAgent: "Mine/1", locale: "fr-FR" } });
    if (!r.ok || !r.release) throw new Error("expected a release");
    const page = t.pages.get(1)!;
    const ua = page.keys.filter((k) => k.method === "Emulation.setUserAgentOverride");
    expect(ua).toHaveLength(1);
    expect(ua[0]!.params).toMatchObject({ userAgent: "Mine/1", acceptLanguage: "fr-FR,fr" });
    expect(ua[0]!.params).not.toHaveProperty("platform");
    // hints unreadable (the fake answers with the user agent only): no invented metadata
    expect(ua[0]!.params).not.toHaveProperty("userAgentMetadata");
    expect(methods(page)).not.toContain("Network.setExtraHTTPHeaders");
    page.keys.length = 0;
    await r.release();
    expect(page.keys.filter((k) => k.method === "Emulation.setUserAgentOverride")).toEqual([{ method: "Emulation.setUserAgentOverride", params: { userAgent: "" } }]);
  });

  const hintsJson = JSON.stringify({
    ua: "Mozilla/5.0 (Macintosh) Chrome/131.0.0.0 Safari/537.36",
    brands: [{ brand: "Chromium", version: "131" }, { brand: "Not_A Brand", version: "24" }],
    platform: "macOS",
    h: { fullVersionList: [{ brand: "Chromium", version: "131.0.6778.86" }], platformVersion: "14.5.0", architecture: "arm", bitness: "64", wow64: true },
  });
  const hintsExec = (code: string) => (isEnvRead(code) ? hintsJson : { ok: true, found: true });
  type Sent = { userAgent: string; platform?: string; acceptLanguage?: string; userAgentMetadata?: Record<string, unknown> };
  const sentUa = (t: ReturnType<typeof fakeTarget>) => t.pages.get(1)!.keys.find((k) => k.method === "Emulation.setUserAgentOverride")!.params as unknown as Sent;

  it("an iOS preset sends userAgent + platform and NO userAgentMetadata (Safari has no UA Client Hints)", async () => {
    for (const [device, platform] of [["iphone-15", "iPhone"], ["ipad", "iPad"]] as const) {
      const t = fakeTarget({ exec: hintsExec });
      await applyFixture(t, { version: 1, emulate: { device, locale: "fr-FR" } });
      const p = sentUa(t);
      expect(p.platform).toBe(platform);
      expect(p.userAgent).toContain(platform);
      expect(p.acceptLanguage).toBe("fr-FR,fr");
      expect(p).not.toHaveProperty("userAgentMetadata");
    }
  });

  it("the Android preset takes the real browser's Chrome version and brands as reported", async () => {
    const t = fakeTarget({ exec: hintsExec });
    await applyFixture(t, { version: 1, emulate: { device: "pixel-8" } });
    const p = sentUa(t);
    expect(p.userAgent).toContain("Android 14; Pixel 8");
    expect(p.userAgent).toContain("Chrome/131.0.0.0");
    expect(p.platform).toBe("Linux armv8l");
    expect(p.userAgentMetadata).toMatchObject({
      brands: [{ brand: "Chromium", version: "131" }, { brand: "Not_A Brand", version: "24" }],
      fullVersionList: [{ brand: "Chromium", version: "131.0.6778.86" }],
      platform: "Android",
      platformVersion: "14.0.0",
      model: "Pixel 8",
      mobile: true,
      wow64: true,
    });
  });

  it("the Android preset with unreadable hints builds metadata from the user agent's Chrome version only", async () => {
    const t = fakeTarget({ exec });
    await applyFixture(t, { version: 1, emulate: { device: "pixel-8" } });
    const p = sentUa(t);
    expect(p.platform).toBe("Linux armv8l");
    expect(p.userAgent).toContain("Chrome/126.0.0.0");
    expect(p.userAgentMetadata).toMatchObject({
      brands: [{ brand: "Chromium", version: "126" }, { brand: "Not.A/Brand", version: "8" }],
      platform: "Android",
      mobile: true,
    });
    expect(JSON.stringify(p.userAgentMetadata)).not.toContain("Google Chrome");
  });

  it("an explicit user agent keeps the real browser's platform and wow64; mobile follows viewport.mobile", async () => {
    const t = fakeTarget({ exec: hintsExec });
    await applyFixture(t, { version: 1, emulate: { userAgent: "Mine/1", viewport: { width: 400, height: 800, mobile: true } } });
    const p = sentUa(t);
    expect(p).not.toHaveProperty("platform");
    expect(p.userAgentMetadata).toMatchObject({ platform: "macOS", platformVersion: "14.5.0", architecture: "arm", mobile: true, wow64: true });
  });

  it("reads user agent and hints in one script; a page that never answers counts as unreadable after the timeout", async () => {
    const t = fakeTarget({ exec: hintsExec });
    await applyFixture(t, { version: 1, emulate: { userAgent: "Mine/1" } });
    expect(t.pages.get(1)!.executed.filter(isEnvRead)).toHaveLength(1);
    vi.useFakeTimers();
    try {
      const hang = fakeTarget({ exec: (code) => (isEnvRead(code) ? new Promise(() => {}) : { ok: true, found: true }) });
      const pending = applyFixture(hang, { version: 1, emulate: { userAgent: "Mine/1" } });
      await vi.advanceTimersByTimeAsync(2100);
      const r = await pending;
      expect(r.ok).toBe(true);
      expect(sentUa(hang)).toEqual({ userAgent: "Mine/1" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a desktop preset sends no user-agent override", async () => {
    const t = fakeTarget({ exec });
    await applyFixture(t, { version: 1, emulate: { device: "desktop-1440" } });
    expect(methods(t.pages.get(1)!)).not.toContain("Emulation.setUserAgentOverride");
  });

  it("sends time zone and media features without a locale", async () => {
    const t = fakeTarget({ exec });
    await applyFixture(t, { version: 1, emulate: { timezone: "Europe/Berlin", colorScheme: "dark", reducedMotion: true } });
    expect(t.pages.get(1)!.keys).toEqual([
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
    expect(shot).toMatchObject({ imageData: `data:image/jpeg;base64,${jpeg}`, width: 393, height: 852 });
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
