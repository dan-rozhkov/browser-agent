import { describe, expect, it, vi } from "vitest";
import type { BrowserBridge } from "../../src/loop/bridge.js";
import { executeBrowseTool } from "../../src/agent/index.js";

const SNAP = { snapshotId: "s1", url: "https://a.test/", title: "A", elements: [{ index: 0, tag: "a", label: "Go", ops: ["CLICK"] }], scroll: { y: 0, height: 1, atBottom: true } };

function fakeBrowser(over: Partial<BrowserBridge> = {}): BrowserBridge & { acts: Record<string, unknown>[] } {
  const acts: Record<string, unknown>[] = [];
  return {
    acts,
    open: async () => ({ url: "https://a.test/", title: "A" }),
    act: async (a) => {
      acts.push(a);
      return { url: "https://a.test/", title: "A", matched: true, changed: true };
    },
    read: async () => ({ text: "hello" }),
    snapshot: async () => SNAP,
    perform: async () => ({}),
    ...over,
  };
}

const run = async (b: BrowserBridge, name: string, input: unknown) => JSON.parse(await executeBrowseTool(b, name, input));

describe("executeBrowseTool", () => {
  it("browse_open attaches a snapshot", async () => {
    const r = await run(fakeBrowser(), "browse_open", { url: "https://a.test/" });
    expect(r.title).toBe("A");
    expect(r.snapshot.snapshotId).toBe("s1");
  });

  it("browse_open keeps an error as it is", async () => {
    const r = await run(fakeBrowser({ open: async () => ({ error: "blocked" }) }), "browse_open", { url: "x" });
    expect(r).toEqual({ error: "blocked" });
  });

  it("a bridge that throws becomes { error }", async () => {
    const r = await run(fakeBrowser({ snapshot: async () => { throw new Error("gone"); } }), "browse_snapshot", {});
    expect(r).toEqual({ error: "gone" });
  });

  it("forwards read, tabs and find_images", async () => {
    const b = fakeBrowser({ tabs: async (a) => ({ tabs: [], current: a.action }), findImages: async () => ({ images: [] }) });
    expect((await run(b, "browse_read", { maxChars: 10 })).text).toBe("hello");
    expect((await run(b, "browse_tabs", { action: "list" })).current).toBe("list");
    expect(await run(b, "browse_find_images", {})).toEqual({ images: [] });
  });

  it("browse_find_images on a bridge without findImages reports the TypeError message (no guard)", async () => {
    const r = await run(fakeBrowser(), "browse_find_images", {});
    expect(r.error).toMatch(/findImages/);
    expect(r.error).not.toMatch(/not supported/);
  });

  it("reports a missing optional bridge method", async () => {
    const r = await run(fakeBrowser(), "browse_tabs", { action: "list" });
    expect(r.error).toMatch(/browse_tabs is not supported/);
  });

  it("browse_screenshot forwards everything except placeOnCanvas, x and y", async () => {
    const screenshot = vi.fn(async () => ({ imageData: "data:image/jpeg;base64,AAAA" }));
    await run(fakeBrowser({ screenshot }), "browse_screenshot", { annotate: true, fullPage: true, placeOnCanvas: true, x: 1, y: 2 });
    expect(screenshot).toHaveBeenCalledWith({ annotate: true, fullPage: true });
  });

  it("browse_act: one action gets a snapshot when the page changed", async () => {
    const b = fakeBrowser();
    const r = await run(b, "browse_act", { action: "click", index: 0, snapshotId: "s1" });
    expect(b.acts).toEqual([{ action: "click", index: 0, snapshotId: "s1" }]);
    expect(r.snapshot.snapshotId).toBe("s1");
  });

  it("browse_act: no snapshot when nothing changed, except for scroll and wait", async () => {
    const b = fakeBrowser({ act: async () => ({ changed: false }) });
    expect((await run(b, "browse_act", { action: "click", target: "x" })).snapshot).toBeUndefined();
    expect((await run(b, "browse_act", { action: "scroll" })).snapshot).toBeDefined();
  });

  it("browse_act: element targeting is not available", async () => {
    const r = await run(fakeBrowser(), "browse_act", { action: "click", element: "the Go button" });
    expect(r.error).toMatch(/element targeting is not available/);
  });

  it("browse_act: a batch copies the snapshotId only into index entries and stops at an error", async () => {
    let n = 0;
    const b = fakeBrowser({
      act: async (a) => {
        n += 1;
        return n === 3 ? { error: "stale" } : { changed: true, got: a };
      },
    });
    const r = await run(b, "browse_act", {
      snapshotId: "s1",
      actions: [
        { action: "type", index: 0, text: "hi" },
        { action: "press", key: "Enter" },
        { action: "click", index: 1 },
        { action: "wait", ms: 1 },
      ],
    });
    expect(r.results[0].got).toEqual({ action: "type", index: 0, text: "hi", snapshotId: "s1" });
    expect(r.results[1].got).toEqual({ action: "press", key: "Enter" });
    expect(r.completed).toBe(2);
    expect(r.stoppedAt).toBe(2);
    expect(r.error).toBe("stale");
    expect(r.snapshot.snapshotId).toBe("s1");
  });

  it("browse_act: a batch past its deadline stops and skips the snapshot", async () => {
    let t = 0;
    const b = fakeBrowser();
    const out = JSON.parse(
      await executeBrowseTool(b, "browse_act", { actions: [{ action: "wait" }, { action: "wait" }] }, { now: () => (t += 40_000) }),
    );
    expect(out.error).toBe("browse_act: batch deadline reached.");
    expect(out.snapshot).toBeUndefined();
  });

  it("an unknown tool is an error", async () => {
    expect((await run(fakeBrowser(), "browse_capture", {})).error).toMatch(/Unknown browse tool/);
  });
});
