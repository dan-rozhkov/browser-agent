import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { PlaywrightTarget } from "../src/browser/playwrightHandle.js";
import { connectOverCdp } from "../src/browser/connect.js";

vi.mock("playwright-core", () => ({
  chromium: {
    connectOverCDP: async (url: string) => { throw new Error(`connect failed for ${url}`); },
  },
}));

class FakeCdp extends EventEmitter {
  history = { currentIndex: 0, entries: [{}] as unknown[] };
  send = vi.fn(async (method: string) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.getNavigationHistory") return this.history;
    return {};
  });
}
function fakePage() {
  const page = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.assign(page, { url: () => "about:blank", title: async () => "", mainFrame: () => ({ childFrames: () => [] }) });
  return page;
}
function fakeContext(newCDPSession: () => Promise<unknown>, pages: unknown[] = []) {
  const ctx = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.assign(ctx, { pages: () => pages, newCDPSession, newPage: async () => fakePage() });
  return ctx;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("PlaywrightTarget", () => {
  it("drops a popup whose CDP init fails without an unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const ctx = fakeContext(async () => { throw new Error("Target closed"); });
    const target = new PlaywrightTarget(ctx as never);
    ctx.emit("page", fakePage());
    await tick();
    await tick();
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(await target.listPages()).toEqual([]);
  });

  it("answers canGoBack/canGoForward from the CDP navigation history", async () => {
    const cdp = new FakeCdp();
    const ctx = fakeContext(async () => cdp, [fakePage()]);
    const target = new PlaywrightTarget(ctx as never);
    const h = await target.ensurePage();
    expect([h.canGoBack(), h.canGoForward()]).toEqual([false, false]);
    cdp.history = { currentIndex: 1, entries: [{}, {}, {}] };
    cdp.emit("Page.frameNavigated", { frame: { id: "main" } });
    await tick();
    expect([h.canGoBack(), h.canGoForward()]).toEqual([true, true]);
    cdp.history = { currentIndex: 0, entries: [{}, {}, {}] };
    cdp.emit("Page.navigatedWithinDocument", { frameId: "main" });
    await tick();
    expect([h.canGoBack(), h.canGoForward()]).toEqual([false, true]);
  });

  it("re-reads the title after a script only when the page navigated since the last read", async () => {
    const cdp = new FakeCdp();
    const page = fakePage();
    let title = "First";
    const titleCalls = vi.fn(async () => title);
    Object.assign(page, { title: titleCalls, evaluate: async () => 1 });
    const target = new PlaywrightTarget(fakeContext(async () => cdp, [page]) as never);
    const h = await target.ensurePage();
    await h.executeJavaScript("1");
    const afterFirst = titleCalls.mock.calls.length;
    // Every script used to cost a second round trip to the remote browser
    // for page.title(); with no navigation there is nothing new to read.
    await h.executeJavaScript("1");
    await h.executeJavaScript("1");
    expect(titleCalls.mock.calls.length).toBe(afterFirst);
    title = "Second";
    cdp.emit("Page.navigatedWithinDocument", { frameId: "main" });
    await h.executeJavaScript("1");
    expect(h.getTitle()).toBe("Second");
  });
});

describe("connectOverCdp", () => {
  it("redacts the api key from connect errors and drops the original cause", async () => {
    const err = await connectOverCdp("wss://connect.steel.dev?apiKey=sk%2Fsecret&sessionId=s").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("apiKey=***");
    expect((err as Error).message).not.toContain("secret");
    expect((err as Error).stack).not.toContain("secret");
    expect((err as Error).cause).toBeUndefined();
  });
});
