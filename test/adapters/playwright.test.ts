import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { PlaywrightTarget, connectOverCdp, fetchStylesheet, guardedLookup } from "../../src/adapters/playwright.js";

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

  it("fetchText refuses a blocked url without touching the network", async () => {
    const h = await new PlaywrightTarget(fakeContext(async () => new FakeCdp(), [fakePage()]) as never).ensurePage();
    for (const u of ["http://127.0.0.1/a.css", "http://localhost/a.css", "file:///etc/passwd"]) {
      await expect(h.fetchText!(u, { timeoutMs: 1000, maxBytes: 100 })).rejects.toThrow(/blocked url/);
    }
  });
});

const sheetOpts = { timeoutMs: 5000, maxBytes: 100 };

function fakeRes(status: number, chunks: (string | Buffer)[], headers: Record<string, string> = {}) {
  const res = Readable.from(chunks.map((c) => (typeof c === "string" ? Buffer.from(c) : c))) as Readable & {
    statusCode: number;
    headers: Record<string, string>;
  };
  res.statusCode = status;
  res.headers = headers;
  return res as unknown as IncomingMessage;
}

function seam(handler: (url: URL, n: number) => IncomingMessage, addresses: Record<string, string[]> = {}) {
  const calls: { url: string; headers: Record<string, string>; signal: AbortSignal }[] = [];
  const lookupAll = vi.fn(async (host: string) =>
    (addresses[host] ?? ["93.184.216.34"]).map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
  );
  const request = vi.fn(async (url: URL, init: { headers: Record<string, string>; signal: AbortSignal }) => {
    calls.push({ url: url.href, headers: init.headers, signal: init.signal });
    return handler(url, calls.length);
  });
  return { deps: { lookupAll, request } as never, calls, lookupAll, request };
}

describe("fetchStylesheet", () => {
  it("fetches, decodes the streamed body and sends accept-encoding plus an origin-only referer", async () => {
    const { deps, calls } = seam(() => fakeRes(200, ["a{color", ":red}"], { "content-type": "text/css" }));
    const out = await fetchStylesheet("https://cdn.test/a.css", sheetOpts, { deps, referer: "https://page.test", userAgent: "UA/1" });
    expect(out).toEqual({ status: 200, text: "a{color:red}", contentType: "text/css" });
    expect(calls[0].headers["accept-encoding"]).toBe("gzip, deflate, br");
    expect(calls[0].headers.referer).toBe("https://page.test");
    expect(calls[0].headers["user-agent"]).toBe("UA/1");
    expect(calls[0].headers.cookie).toBeUndefined();
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("decodes gzip, deflate and br, capping the DECODED size", async () => {
    const css = "a{color:red}";
    for (const [enc, buf] of [
      ["gzip", zlib.gzipSync(css)],
      ["deflate", zlib.deflateSync(css)],
      ["br", zlib.brotliCompressSync(css)],
    ] as const) {
      const { deps } = seam(() => fakeRes(200, [buf], { "content-encoding": enc }));
      expect((await fetchStylesheet("https://cdn.test/a.css", sheetOpts, { deps })).text).toBe(css);
    }
    const bomb = zlib.gzipSync("x".repeat(10_000));
    expect(bomb.length).toBeLessThan(100);
    const { deps } = seam(() => fakeRes(200, [bomb], { "content-encoding": "gzip" }));
    await expect(fetchStylesheet("https://cdn.test/a.css", sheetOpts, { deps })).rejects.toThrow(/too large/);
  });

  it("returns a non-2xx status instead of throwing", async () => {
    const { deps } = seam(() => fakeRes(404, ["nope"]));
    expect((await fetchStylesheet("https://cdn.test/x.css", sheetOpts, { deps })).status).toBe(404);
  });

  it("aborts a chunked body past maxBytes (no content-length)", async () => {
    let destroyed = false;
    const res = new Readable({
      read() {
        this.push(Buffer.alloc(40));
      },
      destroy(err, cb) {
        destroyed = true;
        cb(err);
      },
    }) as Readable & { statusCode: number; headers: Record<string, string> };
    res.statusCode = 200;
    res.headers = {};
    const { deps } = seam(() => res as unknown as IncomingMessage);
    await expect(fetchStylesheet("https://cdn.test/b.css", sheetOpts, { deps })).rejects.toThrow(/too large/);
    expect(destroyed).toBe(true);
  });

  it("rejects a declared content-length over maxBytes", async () => {
    const { deps } = seam(() => fakeRes(200, ["x"], { "content-length": "999" }));
    await expect(fetchStylesheet("https://cdn.test/c.css", sheetOpts, { deps })).rejects.toThrow(/too large/);
  });

  it("refuses blocked urls before any request", async () => {
    const { deps, request } = seam(() => fakeRes(200, ["x"]));
    for (const u of ["http://127.0.0.1/a.css", "http://[::1]/a.css", "http://localhost/a", "ftp://x.test/a", "https://u:p@cdn.test/a"]) {
      await expect(fetchStylesheet(u, sheetOpts, { deps })).rejects.toThrow(/blocked url/);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("follows at most 3 redirects", async () => {
    const { deps, request } = seam((_u, n) => fakeRes(302, [], { location: `/r${n}` }));
    await expect(fetchStylesheet("https://cdn.test/a.css", sheetOpts, { deps })).rejects.toThrow(/too many redirects/);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("re-checks every Location, resolving relative ones", async () => {
    const bad = seam((u) => fakeRes(302, [], { location: u.pathname.endsWith("a.css") ? "http://169.254.169.254/meta" : "/x" }));
    await expect(fetchStylesheet("https://cdn.test/a.css", sheetOpts, { deps: bad.deps })).rejects.toThrow(/blocked url/);
    expect(bad.request).toHaveBeenCalledTimes(1);
    const ok = seam((u) => (u.pathname.endsWith("a.css") ? fakeRes(301, [], { location: "b.css" }) : fakeRes(200, ["done"])));
    expect((await fetchStylesheet("https://cdn.test/dir/a.css", sheetOpts, { deps: ok.deps })).text).toBe("done");
    expect(ok.calls[1].url).toBe("https://cdn.test/dir/b.css");
  });
});

describe("guardedLookup (connection-time address check)", () => {
  const run = (addrs: { address: string; family: number }[], options: object = {}) =>
    new Promise<{ err: Error | null; address?: unknown; family?: number }>((resolve) =>
      guardedLookup(async () => addrs)("h.test", options, (err, address, family) => resolve({ err, address, family })),
    );

  it("resolves a public answer, in single and all form", async () => {
    const addrs = [{ address: "93.184.216.34", family: 4 }];
    expect(await run(addrs)).toMatchObject({ err: null, address: "93.184.216.34", family: 4 });
    expect(await run(addrs, { all: true })).toMatchObject({ err: null, address: addrs });
  });

  it("REJECTS when ANY address is blocked, so the connected address is the checked one", async () => {
    const r = await run([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    expect(r.err?.message).toMatch(/blocked address/);
    expect((await run([{ address: "::ffff:7f00:1", family: 6 }])).err).toBeTruthy();
  });

  it("filters by requested family and passes resolver errors on", async () => {
    const addrs = [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700::1", family: 6 },
    ];
    expect(await run(addrs, { family: 6 })).toMatchObject({ address: "2606:4700::1", family: 6 });
    const failing = await new Promise<Error | null>((resolve) =>
      guardedLookup(async () => {
        throw new Error("ENOTFOUND");
      })("h.test", {}, (err) => resolve(err)),
    );
    expect(failing?.message).toBe("ENOTFOUND");
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
