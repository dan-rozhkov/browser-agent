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
}

export const DEVICE_PRESETS: Record<FixtureDevice, DevicePreset> = {
  "iphone-15": {
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  },
  "pixel-8": {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    touch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  },
  ipad: {
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    userAgent: "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  },
  "desktop-1440": { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, touch: false },
  "desktop-1920": { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, touch: false },
};

/** What `emulate` means after the preset and the explicit fields are merged. A field left out is not touched. */
export interface ResolvedEmulation {
  metrics?: { width: number; height: number; deviceScaleFactor: number; mobile: boolean };
  touch?: boolean;
  userAgent?: string;
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

async function readUserAgent(page: BrowserPageHandle): Promise<string> {
  try {
    const value: unknown = await page.executeJavaScript("navigator.userAgent");
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
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
      const original = await readUserAgent(page);
      await send("Emulation.setUserAgentOverride", { userAgent: resolved.userAgent });
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
