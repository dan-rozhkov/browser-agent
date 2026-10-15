import type { BrowserController } from "../controller/controller.js";
import type { BrowserBridge } from "../loop/bridge.js";

/** Adapts an in-process `BrowserController` to the loop's `BrowserBridge`:
 * each method forwards to the same-named controller method. */
export function controllerBridge(c: BrowserController): BrowserBridge {
  return {
    open: (args) => c.open(args),
    act: (args) => c.act(args),
    read: (args) => c.read(args),
    snapshot: () => c.snapshot(),
    perform: (args) => c.perform(args),
    findImages: (args) => c.findImages(args),
    screenshot: (args) => c.screenshot(args),
    tabs: (args) => c.tabs(args),
    capture: (args) => c.capture(args),
    applyFixture: (fixture, opts) => c.applyFixture(fixture, opts),
    captureFixture: (opts) => c.captureFixture(opts),
    releaseFixture: (token) => c.releaseFixture(token),
  };
}
