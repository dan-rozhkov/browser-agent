import { describe, expect, it, vi } from "vitest";
import { BrowserController, type BrowserPageHandle, type BrowserTarget, type PageRequestEntry } from "../../src/controller/controller.js";

const entry = (at: number, url = "https://a.test/"): PageRequestEntry => ({ at, method: "GET", url });
const page = (drain?: () => Promise<PageRequestEntry[]>) => ({ drainRequests: drain }) as unknown as BrowserPageHandle;

describe("BrowserController.requests", () => {
  it("drains every tab the target knows, merged by start time", async () => {
    const a = page(async () => [entry(30), entry(10)]);
    const b = page(async () => [entry(20)]);
    const target = { ensurePage: async () => a, currentPage: () => a, pageHandles: async () => [{ tabId: 1, page: a }, { tabId: 2, page: b }] } as BrowserTarget;
    const out = await new BrowserController(target).requests();
    expect(out.requests.map((r) => r.at)).toEqual([10, 20, 30]);
    expect(out.dropped).toBeUndefined();
  });

  it("falls back to the current page and returns an empty list when no page supports it", async () => {
    const a = page(async () => [entry(1)]);
    const t1 = { ensurePage: async () => a, currentPage: () => a } as BrowserTarget;
    expect((await new BrowserController(t1).requests()).requests).toHaveLength(1);
    const bare = page();
    const t2 = { ensurePage: async () => bare, currentPage: () => bare } as BrowserTarget;
    expect(await new BrowserController(t2).requests()).toEqual({ requests: [] });
    const t3 = { ensurePage: async () => bare, currentPage: () => null } as BrowserTarget;
    expect(await new BrowserController(t3).requests()).toEqual({ requests: [] });
  });

  it("never throws: a throwing drain only loses its tab", async () => {
    const bad = page(async () => { throw new Error("x"); });
    const good = page(async () => [entry(5)]);
    const target = { ensurePage: async () => good, currentPage: () => good, pageHandles: async () => [{ tabId: 1, page: bad }, { tabId: 2, page: good }] } as BrowserTarget;
    expect((await new BrowserController(target).requests()).requests).toHaveLength(1);
    const broken = { ensurePage: async () => good, currentPage: () => good, pageHandles: async () => { throw new Error("y"); } } as BrowserTarget;
    expect((await new BrowserController(broken).requests()).requests).toHaveLength(1);
  });

  it("counts entries beyond the cap as dropped and keeps the newest", async () => {
    const many = Array.from({ length: 650 }, (_, i) => entry(i));
    const a = page(async () => many);
    const out = await new BrowserController({ ensurePage: async () => a, currentPage: () => a } as BrowserTarget).requests();
    expect(out.requests).toHaveLength(600);
    expect(out.requests[0]!.at).toBe(50);
    expect(out.dropped).toBe(50);
  });

  it("does not wait for the command lock and gives up after 3 s", async () => {
    vi.useFakeTimers();
    try {
      const hung = page(() => new Promise(() => {}));
      const target = { ensurePage: async () => hung, currentPage: () => hung } as BrowserTarget;
      const p = new BrowserController(target).requests();
      await vi.advanceTimersByTimeAsync(3100);
      expect(await p).toEqual({ requests: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds the closed tabs' entries and every dropped count", async () => {
    const a = { drainRequests: async () => [entry(20)], droppedRequests: () => 4 } as unknown as BrowserPageHandle;
    const target = {
      ensurePage: async () => a, currentPage: () => a,
      drainClosedRequests: () => ({ requests: [entry(10)], dropped: 2 }),
    } as BrowserTarget;
    const out = await new BrowserController(target).requests();
    expect(out.requests.map((r) => r.at)).toEqual([10, 20]);
    expect(out.dropped).toBe(6);
    const throwing = { ensurePage: async () => a, currentPage: () => a, drainClosedRequests: () => { throw new Error("x"); } } as BrowserTarget;
    expect((await new BrowserController(throwing).requests()).requests.map((r) => r.at)).toEqual([20]);
  });
});
