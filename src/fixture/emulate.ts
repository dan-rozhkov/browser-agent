// Environment emulation of a PageFixture (`emulate`): device presets, the
// resolved settings and the CDP calls that install and clear them. Isomorphic
// and zod-free. Design: docs/specs/2026-10-18-qa-diagnostics-design.md (section 3).
import type { BrowserPageHandle } from "../controller/controller.js";
import type { FixtureDevice, FixtureEmulate } from "./types.js";

interface DevicePreset {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  touch: boolean;
  /** Absent for a desktop preset: the real browser already sends a matching user agent. */
  userAgent?: string;
  /** Client-hints profile that goes with `userAgent` (absent with it). */
  profile?: UaProfile;
}

/** What a mobile preset says about the platform: `navigator.platform` and the `userAgentMetadata` fields. */
export interface UaProfile {
  /** `navigator.platform`. */
  platform: string;
  /** `userAgentMetadata.platform` (`navigator.userAgentData.platform`). */
  uaPlatform: string;
  platformVersion: string;
  model: string;
}

export const DEVICE_PRESETS: Record<FixtureDevice, DevicePreset> = {
  "iphone-15": {
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    profile: { platform: "iPhone", uaPlatform: "iOS", platformVersion: "17.5.0", model: "iPhone" },
  },
  "pixel-8": {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    touch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
    profile: { platform: "Linux armv8l", uaPlatform: "Android", platformVersion: "14.0.0", model: "Pixel 8" },
  },
  ipad: {
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    userAgent: "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    profile: { platform: "iPad", uaPlatform: "iOS", platformVersion: "17.5.0", model: "iPad" },
  },
  "desktop-1440": { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, touch: false },
  "desktop-1920": { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, touch: false },
};

/** What `emulate` means after the preset and the explicit fields are merged. A field left out is not touched. */
export interface ResolvedEmulation {
  metrics?: { width: number; height: number; deviceScaleFactor: number; mobile: boolean };
  touch?: boolean;
  userAgent?: string;
  /** Set only when `userAgent` comes from a device preset (an explicit user agent keeps the real browser's platform). */
  profile?: UaProfile;
  locale?: string;
  timezone?: string;
  colorScheme?: "light" | "dark";
  reducedMotion?: boolean;
}

/** Merges the preset with the explicit fields. An explicit field wins; the viewport merges per field. */
export function resolveEmulation(emulate: FixtureEmulate): ResolvedEmulation {
  const preset = emulate.device ? DEVICE_PRESETS[emulate.device] : undefined;
  const out: ResolvedEmulation = {};
  const vp = emulate.viewport;
  if (vp || preset) {
    out.metrics = {
      width: vp?.width ?? preset!.width,
      height: vp?.height ?? preset!.height,
      deviceScaleFactor: vp?.deviceScaleFactor ?? preset?.deviceScaleFactor ?? 1,
      mobile: vp?.mobile ?? preset?.mobile ?? false,
    };
  }
  const touch = emulate.touch ?? preset?.touch ?? (vp?.mobile !== undefined ? vp.mobile : undefined);
  if (touch !== undefined) out.touch = touch;
  const userAgent = emulate.userAgent ?? preset?.userAgent;
  if (userAgent !== undefined) out.userAgent = userAgent;
  if (emulate.userAgent === undefined && preset?.profile) out.profile = preset.profile;
  if (emulate.locale !== undefined) out.locale = emulate.locale;
  if (emulate.timezone !== undefined) out.timezone = emulate.timezone;
  if (emulate.colorScheme !== undefined) out.colorScheme = emulate.colorScheme;
  if (emulate.reducedMotion !== undefined) out.reducedMotion = emulate.reducedMotion;
  return out;
}

/** Counts only: safe for a model. */
export function summarizeEmulation(emulate: FixtureEmulate): string {
  const parts: string[] = [];
  if (emulate.device) parts.push(emulate.device);
  else if (emulate.viewport) parts.push(`${emulate.viewport.width}x${emulate.viewport.height}`);
  const extra = [emulate.touch !== undefined, emulate.userAgent !== undefined, emulate.locale !== undefined, emulate.timezone !== undefined, emulate.colorScheme !== undefined, emulate.reducedMotion !== undefined].filter(Boolean).length;
  if (extra > 0) parts.push(`${extra} override${extra === 1 ? "" : "s"}`);
  return `emulation (${parts.join(", ") || "none"})`;
}

type Cdp = NonNullable<BrowserPageHandle["sendCdp"]>;

interface Brand {
  brand: string;
  version: string;
}

interface ClientHints {
  brands: Brand[];
  fullVersionList: Brand[];
  platform: string;
  platformVersion: string;
  architecture: string;
  bitness: string;
  wow64: boolean;
}

/** The real browser, read before the override: its user agent and (Chromium only) its client hints. */
interface PageEnvironment {
  userAgent: string;
  /** Absent when `navigator.userAgentData` cannot be read (insecure context, non-Chromium, timeout). */
  hints?: ClientHints;
}

const ENVIRONMENT_TIMEOUT_MS = 2000;

const brandList = (v: unknown): Brand[] =>
  Array.isArray(v) ? v.filter((b): b is Brand => typeof b?.brand === "string" && typeof b?.version === "string").map((b) => ({ brand: b.brand, version: b.version })) : [];

/** Reads user agent and client hints in ONE round-trip; a page that does not answer within 2 s counts as unreadable. */
async function readEnvironment(page: BrowserPageHandle): Promise<PageEnvironment> {
  const script = `(async () => { const ua = navigator.userAgent; const d = navigator.userAgentData; if (!d) return JSON.stringify({ ua }); `
    + `const h = await d.getHighEntropyValues(["fullVersionList","platformVersion","architecture","bitness","wow64"]).catch(() => ({})); `
    + `return JSON.stringify({ ua, brands: d.brands, platform: d.platform, h }); })()`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw: unknown = await Promise.race([
      page.executeJavaScript(script),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ENVIRONMENT_TIMEOUT_MS);
      }),
    ]);
    if (typeof raw !== "string" || raw === "") return { userAgent: "" };
    const parsed = JSON.parse(raw) as { ua?: unknown; brands?: unknown; platform?: unknown; h?: Record<string, unknown> };
    const userAgent = typeof parsed.ua === "string" ? parsed.ua : "";
    const brands = brandList(parsed.brands);
    if (brands.length === 0 || typeof parsed.platform !== "string" || parsed.platform === "") return { userAgent };
    const h = parsed.h ?? {};
    const fullVersionList = brandList(h.fullVersionList);
    return {
      userAgent,
      hints: {
        brands,
        fullVersionList: fullVersionList.length > 0 ? fullVersionList : brands,
        platform: parsed.platform,
        platformVersion: typeof h.platformVersion === "string" ? h.platformVersion : "",
        architecture: typeof h.architecture === "string" ? h.architecture : "",
        bitness: typeof h.bitness === "string" ? h.bitness : "",
        wow64: h.wow64 === true,
      },
    };
  } catch {
    return { userAgent: "" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The real browser's Chrome major version: from the hints (Chromium, else Google Chrome), else from its user agent. */
function chromeMajor(env: PageEnvironment): string | undefined {
  const fromHints = env.hints?.brands.find((b) => b.brand === "Chromium") ?? env.hints?.brands.find((b) => b.brand === "Google Chrome");
  return fromHints?.version.split(".")[0] || /Chrome\/(\d+)/.exec(env.userAgent)?.[1];
}

/** Full version for `fullVersionList` of a metadata built from the user agent alone. */
const chromeFullFromUa = (userAgent: string, major: string): string => /Chrome\/([\d.]+)/.exec(userAgent)?.[1] ?? `${major}.0.0.0`;

/** `Accept-Language` HEADER value (`Network.setExtraHTTPHeaders`): `de-DE` gives `de-DE,de;q=0.9`; a bare `de` stays `de`. */
export function acceptLanguageFor(locale: string): string {
  const base = locale.split("-")[0]!;
  return base === locale ? locale : `${locale},${base};q=0.9`;
}

/**
 * The `acceptLanguage` FIELD of `Emulation.setUserAgentOverride`: a plain list (`de-DE,de`). Chromium parses it as a
 * language list, derives `navigator.languages` from it and adds the `;q=` weights to the header itself, so the
 * header value `acceptLanguageFor` builds must NOT be sent here (found live: it yields `de-DE,de;q=0.9;q=0.9`
 * and `navigator.languages` of `["de-DE","de;q=0.9"]`). Both paths end in the same header and the same languages.
 */
export function acceptLanguageList(locale: string): string {
  const base = locale.split("-")[0]!;
  return base === locale ? locale : `${locale},${base}`;
}

/** Defines navigator.language and navigator.languages (Navigator.prototype getters, configurable). */
function languageScript(locale: string): string {
  const base = locale.split("-")[0]!;
  const languages = base === locale ? [locale] : [locale, base];
  return `(() => { const l = ${JSON.stringify(locale)}; const ls = Object.freeze(${JSON.stringify(languages)}); `
    + `Object.defineProperty(Navigator.prototype, "language", { get: () => l, configurable: true, enumerable: true }); `
    + `Object.defineProperty(Navigator.prototype, "languages", { get: () => ls, configurable: true, enumerable: true }); })()`;
}

/**
 * Installs the emulation on one page and returns the function that clears it
 * (never throws: a page that is already closed has nothing to clear). Throws
 * when an override cannot be set; the overrides set before it are cleared first.
 */
export async function installEmulation(page: BrowserPageHandle, resolved: ResolvedEmulation): Promise<() => Promise<void>> {
  const send: Cdp = (method, params) => page.sendCdp!(method, params);
  const undo: Array<() => Promise<unknown>> = [];
  const clear = async (): Promise<void> => {
    // Reverse order; each step on its own, so one failure leaves the others cleared.
    for (const step of undo.splice(0).reverse()) {
      try {
        await step();
      } catch {
        // The tab is closed or its session is gone: nothing is left to clear.
      }
    }
  };
  try {
    if (resolved.metrics) {
      const m = resolved.metrics;
      await send("Emulation.setDeviceMetricsOverride", { width: m.width, height: m.height, deviceScaleFactor: m.deviceScaleFactor, mobile: m.mobile });
      undo.push(() => send("Emulation.clearDeviceMetricsOverride"));
    }
    if (resolved.touch !== undefined) {
      await send("Emulation.setTouchEmulationEnabled", { enabled: resolved.touch, ...(resolved.touch ? { maxTouchPoints: 5 } : {}) });
      undo.push(() => send("Emulation.setTouchEmulationEnabled", { enabled: false }));
    }
    if (resolved.userAgent !== undefined) {
      const env = await readEnvironment(page);
      const original = env.userAgent;
      const profile = resolved.profile;
      // `Emulation.setLocaleOverride` changes Intl only; the Accept-Language header follows this call's
      // `acceptLanguage`, so with a locale it travels in the same override (no extra call).
      const acceptLanguage = resolved.locale !== undefined ? { acceptLanguage: acceptLanguageList(resolved.locale) } : {};
      let params: Record<string, unknown>;
      if (profile?.uaPlatform === "iOS") {
        // Real iOS Safari has no UA Client Hints. An override WITHOUT `userAgentMetadata` makes Chromium disable
        // them too, which matches Safari; sending Chromium brands here would contradict the iPhone/iPad UA.
        params = { userAgent: resolved.userAgent, platform: profile.platform, ...acceptLanguage };
      } else if (profile) {
        // Android preset: the preset UA string is a template. Its Chrome version is replaced by the real browser's,
        // so the UA string and the brands agree. Brands are used as reported (no "Google Chrome" is invented).
        const major = chromeMajor(env) ?? /Chrome\/(\d+)/.exec(resolved.userAgent!)?.[1] ?? "126";
        const userAgent = resolved.userAgent!.replace(/Chrome\/[\d.]+/, `Chrome/${major}.0.0.0`);
        const hints = env.hints;
        const brands = hints?.brands ?? [{ brand: "Chromium", version: major }, { brand: "Not.A/Brand", version: "8" }];
        const fullVersionList = hints?.fullVersionList ?? [{ brand: "Chromium", version: chromeFullFromUa(env.userAgent, major) }, { brand: "Not.A/Brand", version: "8.0.0.0" }];
        params = {
          userAgent,
          platform: profile.platform,
          ...acceptLanguage,
          userAgentMetadata: {
            brands,
            fullVersionList,
            platform: profile.uaPlatform,
            platformVersion: profile.platformVersion,
            architecture: "",
            model: profile.model,
            mobile: true,
            bitness: hints?.bitness ?? "",
            wow64: hints?.wow64 ?? false,
          },
        };
      } else if (env.hints) {
        // Explicit user agent: the real browser's hints, `mobile` from the viewport.
        const h = env.hints;
        params = {
          userAgent: resolved.userAgent,
          ...acceptLanguage,
          userAgentMetadata: {
            brands: h.brands,
            fullVersionList: h.fullVersionList,
            platform: h.platform,
            platformVersion: h.platformVersion,
            architecture: h.architecture,
            model: "",
            mobile: resolved.metrics?.mobile ?? false,
            bitness: h.bitness,
            wow64: h.wow64,
          },
        };
      } else {
        // Explicit user agent and the hints cannot be read: send no metadata rather than invent a platform or brand.
        params = { userAgent: resolved.userAgent, ...acceptLanguage };
      }
      await send("Emulation.setUserAgentOverride", params);
      // An empty string removes the override (Chromium). If a target rejects that, restore the string read before.
      // Known limit: the clear also removes a UA override the HOST set through CDP before the fixture
      // (CDP has one UA override per session, and `original` read here is the overridden string only on
      // the fallback path). A host that relies on its own CDP UA override must not use `emulate.userAgent`
      // or a mobile device preset, or must re-apply its override after `release()`.
      undo.push(async () => {
        try {
          await send("Emulation.setUserAgentOverride", { userAgent: "" });
        } catch {
          await send("Emulation.setUserAgentOverride", { userAgent: original });
        }
      });
    }
    if (resolved.locale !== undefined) {
      if (resolved.userAgent === undefined) {
        // A locale without a user-agent override must not touch the UA (an override without `userAgentMetadata`
        // disables UA Client Hints, and clearing it would drop a host's own override). So: the header through
        // `Network.setExtraHTTPHeaders`, and `navigator.language(s)` through an init script.
        // Limit: this covers the tab's top document session only. Out-of-process iframes and workers keep the
        // real browser language.
        try {
          // Left enabled on purpose (no matching disable): both shipped hosts already enable Network on their tabs.
          await send("Network.enable");
        } catch {
          // Already enabled by the adapter, or not needed: setExtraHTTPHeaders is the real test.
        }
        // CDP keeps ONE extra-header set per session, so this call replaces the session's whole set for the whole
        // run, not only at release: any extra header the host set through CDP is dropped from apply on, and
        // `{ headers: {} }` at release drops everything again. A host that sets its own extra headers must
        // re-apply them after `release()` and must not rely on them during the run.
        await send("Network.setExtraHTTPHeaders", { headers: { "Accept-Language": acceptLanguageFor(resolved.locale) } });
        undo.push(() => send("Network.setExtraHTTPHeaders", { headers: {} }));
        const script = languageScript(resolved.locale);
        const added = await send("Page.addScriptToEvaluateOnNewDocument", { source: script });
        const identifier = (added as { identifier?: unknown } | undefined)?.identifier;
        if (typeof identifier === "string") undo.push(() => send("Page.removeScriptToEvaluateOnNewDocument", { identifier }));
        // The init script covers the documents loaded from now on; run it once for the one open now. The
        // already-loaded document keeps these values after release until it navigates.
        try {
          await page.executeJavaScript(script);
        } catch {
          // No script context yet (nothing is loaded): the init script handles the next document.
        }
      }
      await send("Emulation.setLocaleOverride", { locale: resolved.locale });
      undo.push(() => send("Emulation.setLocaleOverride", {}));
    }
    if (resolved.timezone !== undefined) {
      await send("Emulation.setTimezoneOverride", { timezoneId: resolved.timezone });
      undo.push(() => send("Emulation.setTimezoneOverride", { timezoneId: "" }));
    }
    const features: Array<{ name: string; value: string }> = [];
    if (resolved.colorScheme !== undefined) features.push({ name: "prefers-color-scheme", value: resolved.colorScheme });
    if (resolved.reducedMotion !== undefined) features.push({ name: "prefers-reduced-motion", value: resolved.reducedMotion ? "reduce" : "no-preference" });
    if (features.length > 0) {
      await send("Emulation.setEmulatedMedia", { features });
      undo.push(() => send("Emulation.setEmulatedMedia", { features: features.map((f) => ({ name: f.name, value: "" })) }));
    }
  } catch (err) {
    await clear();
    throw err;
  }
  let done: Promise<void> | undefined;
  return () => (done ??= clear());
}
