// The real BrowserConnector: CDP-connect to a Steel session with Playwright and
// drive it with the vendored BrowserController. Playwright is imported lazily so
// a deployment (or test) that never opens a cloud browser never loads it.
import { BrowserController } from "./vendor/controller.js";
import { PlaywrightTarget } from "./playwrightHandle.js";
import { redactedError } from "./redact.js";
import type { BrowserConnector, CommandRunner } from "./cloudSessions.js";

export const connectOverCdp: BrowserConnector = async (cdpUrl) => {
  try {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const controller = new BrowserController(new PlaywrightTarget(context));
    return {
      controller: controller as unknown as CommandRunner,
      close: () => browser.close(),
      onDisconnected: (cb) => { browser.on("disconnected", () => cb()); },
    };
  } catch (e) {
    // The URL (with the API key) is inside Playwright's error text.
    throw redactedError(e, cdpUrl);
  }
};
