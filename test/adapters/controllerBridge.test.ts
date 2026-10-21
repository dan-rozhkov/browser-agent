import { describe, expect, it, vi } from "vitest";
import { controllerBridge } from "../../src/adapters/controllerBridge.js";
import type { BrowserController } from "../../src/controller/controller.js";

const METHODS = ["open", "act", "read", "snapshot", "perform", "findImages", "screenshot", "tabs"] as const;

describe("controllerBridge", () => {
  it("forwards each call to the same-named controller method and returns its result", async () => {
    const fake: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const m of METHODS) fake[m] = vi.fn(async () => ({ from: m }));
    const bridge = controllerBridge(fake as unknown as BrowserController);

    expect(await bridge.open({ url: "https://a.test" })).toEqual({ from: "open" });
    expect(fake.open).toHaveBeenCalledWith({ url: "https://a.test" });
    expect(await bridge.act({ action: "click" })).toEqual({ from: "act" });
    expect(fake.act).toHaveBeenCalledWith({ action: "click" });
    expect(await bridge.read({})).toEqual({ from: "read" });
    expect(await bridge.snapshot()).toEqual({ from: "snapshot" });
    expect(fake.snapshot).toHaveBeenCalledWith();
    const perform = { snapshotId: "s", index: 1, operation: "CLICK" };
    expect(await bridge.perform(perform)).toEqual({ from: "perform" });
    expect(fake.perform).toHaveBeenCalledWith(perform);
    expect(await bridge.findImages?.({ q: 1 })).toEqual({ from: "findImages" });
    expect(await bridge.screenshot?.({ annotate: true })).toEqual({ from: "screenshot" });
    expect(fake.screenshot).toHaveBeenCalledWith({ annotate: true });
    expect(await bridge.tabs?.({ action: "list" })).toEqual({ from: "tabs" });
    expect(fake.tabs).toHaveBeenCalledWith({ action: "list" });
  });

  it("forwards assert", async () => {
    const fake = { assert: vi.fn(async () => ({ ok: true, passed: true, results: [] })) };
    const bridge = controllerBridge(fake as unknown as BrowserController);
    const args = { checks: [{ type: "text", text: "a" }] };
    expect(await bridge.assert?.(args)).toEqual({ ok: true, passed: true, results: [] });
    expect(fake.assert).toHaveBeenCalledWith(args);
  });

  it("requests resolves to the JSON of the controller's requests()", async () => {
    const fake = { requests: vi.fn(async () => ({ requests: [{ at: 1, method: "GET", url: "https://a.test" }], dropped: 2 })) };
    const bridge = controllerBridge(fake as unknown as BrowserController);
    expect(JSON.parse((await bridge.requests?.()) ?? "")).toEqual({ requests: [{ at: 1, method: "GET", url: "https://a.test" }], dropped: 2 });
  });

  it("forwards the checkpoint journal methods", async () => {
    const fake = {
      startJournal: vi.fn(() => "journal-7"),
      stopJournal: vi.fn(),
      captureCheckpoint: vi.fn(async () => ({ ok: true })),
    };
    const bridge = controllerBridge(fake as unknown as BrowserController);
    expect(bridge.startJournal?.({ origins: ["https://a.test"] })).toBe("journal-7");
    bridge.stopJournal?.("journal-7");
    expect(await bridge.captureCheckpoint?.("journal-7")).toEqual({ ok: true });
    expect(fake.startJournal).toHaveBeenCalledWith({ origins: ["https://a.test"] });
    expect(fake.stopJournal).toHaveBeenCalledWith("journal-7");
    expect(fake.captureCheckpoint).toHaveBeenCalledWith("journal-7");
  });

  it("propagates the controller's rejection", async () => {
    const fake = { snapshot: vi.fn(async () => Promise.reject(new Error("gone"))) };
    const bridge = controllerBridge(fake as unknown as BrowserController);
    await expect(bridge.snapshot()).rejects.toThrow("gone");
  });
});
