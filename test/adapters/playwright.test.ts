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

describe("PlaywrightTarget cookies", () => {
  function cookieContext() {
    const ctx = fakeContext(async () => new FakeCdp()) as EventEmitter & Record<string, unknown>;
    const added: unknown[][] = [];
    const asked: unknown[] = [];
    Object.assign(ctx, {
      addCookies: async (c: unknown[]) => { added.push(c); },
      cookies: async (urls?: string[]) => {
        asked.push(urls);
        return [
          { name: "sid", value: "v", domain: ".a.test", path: "/", expires: 1900000000, httpOnly: true, secure: true, sameSite: "Lax" },
          { name: "s", value: "w", domain: "a.test", path: "/p", expires: -1, httpOnly: false, secure: false, sameSite: "None" },
        ];
      },
    });
    return { target: new PlaywrightTarget(ctx as never), added, asked };
  }

  it("setCookies maps a fixture cookie to addCookies input", async () => {
    const { target, added } = cookieContext();
    await target.setCookies!([
      { name: "a", value: "1", domain: "a.test" },
      { name: "b", value: "2", domain: "a.test", path: "/x", expires: 5, httpOnly: true, secure: true, sameSite: "Strict" },
      { name: "c", value: "3", url: "https://a.test/" },
      { name: "d", value: "4", url: "https://a.test/", domain: "ignored.test", path: "/ignored" },
    ]);
    expect(added).toEqual([[
      { name: "a", value: "1", domain: "a.test", path: "/" },
      { name: "b", value: "2", domain: "a.test", path: "/x", expires: 5, httpOnly: true, secure: true, sameSite: "Strict" },
      { name: "c", value: "3", url: "https://a.test/" },
      { name: "d", value: "4", url: "https://a.test/" },
    ]]);
  });

  it("getCookies maps back and drops the session-cookie expiry", async () => {
    const { target, asked } = cookieContext();
    expect(await target.getCookies!(["https://a.test/"])).toEqual([
      { name: "sid", value: "v", domain: ".a.test", path: "/", expires: 1900000000, httpOnly: true, secure: true, sameSite: "Lax" },
      { name: "s", value: "w", domain: "a.test", path: "/p", httpOnly: false, secure: false, sameSite: "None" },
    ]);
    expect(asked).toEqual([["https://a.test/"]]);
  });
});

// QA start: network mocks and session reset (docs/specs/2026-10-15-qa-start-design.md).
type FakeRoute = { request(): { url(): string; method(): string }; continue: ReturnType<typeof vi.fn>; fallback: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn>; fulfill: ReturnType<typeof vi.fn> };
function fakeRoute(url: string, method = "GET"): FakeRoute {
  return { request: () => ({ url: () => url, method: () => method }), continue: vi.fn(async () => {}), fallback: vi.fn(async () => {}), abort: vi.fn(async () => {}), fulfill: vi.fn(async () => {}) };
}

function routingContext() {
  const ctx = fakeContext(async () => new FakeCdp(), []);
  const routes: { pattern: string; handler: (r: unknown) => Promise<void> }[] = [];
  const unroute = vi.fn(async (pattern: string, handler: unknown) => {
    const i = routes.findIndex((r) => r.pattern === pattern && r.handler === handler);
    if (i >= 0) routes.splice(i, 1);
  });
  Object.assign(ctx, {
    route: async (pattern: string, handler: (r: unknown) => Promise<void>) => { routes.push({ pattern, handler }); },
    unroute,
  });
  return { ctx, routes, unroute };
}

describe("PlaywrightTarget.routeRequests", () => {
  it("routes every request of the context and answers by the handler", async () => {
    const { ctx, routes } = routingContext();
    const target = new PlaywrightTarget(ctx as never);
    const seen: unknown[] = [];
    await target.routeRequests((req) => {
      seen.push(req);
      return req.url.includes("/api/") ? { status: 503, headers: { "x-a": "b" }, body: "down" } : undefined;
    });
    expect(routes).toHaveLength(1);
    expect(routes[0].pattern).toBe("**/*");

    const mocked = fakeRoute("https://a.test/api/cart", "POST");
    await routes[0].handler(mocked);
    expect(mocked.fulfill).toHaveBeenCalledWith({ status: 503, headers: { "x-a": "b" }, body: "down" });
    expect(mocked.continue).not.toHaveBeenCalled();
    expect(seen[0]).toEqual({ url: "https://a.test/api/cart", method: "POST" });

    const passed = fakeRoute("https://a.test/page");
    await routes[0].handler(passed);
    // fallback, not continue: the host's other route handlers still run.
    expect(passed.fallback).toHaveBeenCalled();
    expect(passed.continue).not.toHaveBeenCalled();
    expect(passed.fulfill).not.toHaveBeenCalled();
  });

  it("fails a request on abort, and lets it through when the handler throws", async () => {
    const { ctx, routes } = routingContext();
    await new PlaywrightTarget(ctx as never).routeRequests((req) => {
      if (req.url.endsWith("/boom")) throw new Error("handler bug");
      return { status: 0, headers: {}, body: "", abort: true };
    });
    const aborted = fakeRoute("https://a.test/x");
    await routes[0].handler(aborted);
    expect(aborted.abort).toHaveBeenCalledWith("failed");
    expect(aborted.fulfill).not.toHaveBeenCalled();
    const thrown = fakeRoute("https://a.test/boom");
    await routes[0].handler(thrown);
    expect(thrown.fallback).toHaveBeenCalled();
    expect(thrown.continue).not.toHaveBeenCalled();
  });

  it("waits for delayMs before it answers", async () => {
    const { ctx, routes } = routingContext();
    await new PlaywrightTarget(ctx as never).routeRequests(() => ({ status: 200, headers: {}, body: "ok", delayMs: 60 }));
    const route = fakeRoute("https://a.test/slow");
    const started = Date.now();
    const pending = routes[0].handler(route);
    await tick();
    expect(route.fulfill).not.toHaveBeenCalled();
    await pending;
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(route.fulfill).toHaveBeenCalledTimes(1);
  });

  it("removal unroutes, wakes a delayed request at once and lets it through instead of a stale mock", async () => {
    const { ctx, routes, unroute } = routingContext();
    const remove = await new PlaywrightTarget(ctx as never).routeRequests(() => ({ status: 200, headers: {}, body: "ok", delayMs: 20_000 }));
    const route = fakeRoute("https://a.test/slow");
    const pending = routes[0].handler(route);
    await tick();
    const started = Date.now();
    await remove();
    await pending;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(route.fulfill).not.toHaveBeenCalled();
    expect(route.fallback).toHaveBeenCalled();
    expect(route.continue).not.toHaveBeenCalled();
    expect(unroute).toHaveBeenCalledWith("**/*", expect.any(Function));
    expect(routes).toHaveLength(0);
  });

  it("a request that arrives after removal passes through untouched", async () => {
    const { ctx, routes } = routingContext();
    const handler = vi.fn(() => ({ status: 200, headers: {}, body: "" }));
    const remove = await new PlaywrightTarget(ctx as never).routeRequests(handler);
    const [{ handler: onRoute }] = routes;
    await remove();
    const late = fakeRoute("https://a.test/late");
    await onRoute(late);
    expect(handler).not.toHaveBeenCalled();
    expect(late.fallback).toHaveBeenCalled();
    expect(late.continue).not.toHaveBeenCalled();
  });

  it("a route call on a closed page does not reject", async () => {
    const { ctx, routes } = routingContext();
    await new PlaywrightTarget(ctx as never).routeRequests(() => ({ status: 200, headers: {}, body: "" }));
    const route = fakeRoute("https://a.test/");
    route.fulfill.mockRejectedValue(new Error("Target closed"));
    await expect(routes[0].handler(route)).resolves.toBeUndefined();
  });
});

describe("PlaywrightTarget.routeRequests: failed answers never leave a request hanging", () => {
  async function installed(mock: object) {
    const { ctx, routes } = routingContext();
    await new PlaywrightTarget(ctx as never).routeRequests(() => mock as never);
    return routes[0].handler;
  }

  it("falls back when fulfill rejects", async () => {
    const route = fakeRoute("https://a.test/");
    route.fulfill.mockRejectedValue(new Error("invalid header"));
    await (await installed({ status: 200, headers: {}, body: "" }))(route);
    expect(route.fallback).toHaveBeenCalledTimes(1);
    expect(route.abort).not.toHaveBeenCalled();
  });

  it("falls back when abort rejects", async () => {
    const route = fakeRoute("https://a.test/");
    route.abort.mockRejectedValueOnce(new Error("gone"));
    await (await installed({ status: 0, headers: {}, body: "", abort: true }))(route);
    expect(route.fallback).toHaveBeenCalledTimes(1);
  });

  it("aborts as the last resort when the fallback fails too, and still resolves", async () => {
    const route = fakeRoute("https://a.test/");
    route.fulfill.mockRejectedValue(new Error("bad"));
    route.fallback.mockRejectedValue(new Error("already handled"));
    route.abort.mockRejectedValue(new Error("gone"));
    await expect((await installed({ status: 200, headers: {}, body: "" }))(route)).resolves.toBeUndefined();
    expect(route.abort).toHaveBeenCalledTimes(1);
  });
});

describe("PlaywrightTarget.resetSession", () => {
  type ResetPage = ReturnType<typeof fakePage> & { closed: boolean };
  function resetPage(url = "about:blank"): ResetPage {
    const page = fakePage() as ResetPage;
    page.closed = false;
    const main = { url: () => url, childFrames: () => [] };
    Object.assign(page, {
      mainFrame: () => main,
      url: () => url,
      goto: vi.fn(async (to: string) => { url = to; }),
      waitForLoadState: async () => {},
      close: vi.fn(async () => { page.closed = true; page.emit("close"); }),
    });
    return page;
  }
  function resetContext(pages: ResetPage[], cdp = new FakeCdp()) {
    const calls: string[] = [];
    const ctx = fakeContext(async () => cdp, pages);
    Object.assign(ctx, {
      clearCookies: vi.fn(async () => { calls.push("clearCookies"); }),
      clearPermissions: vi.fn(async () => { calls.push("clearPermissions"); }),
      newPage: vi.fn(async () => { const p = resetPage(); pages.push(p); return p; }),
    });
    return { ctx, cdp, calls };
  }
  const cleared = (cdp: FakeCdp) =>
    (cdp.send.mock.calls as unknown as unknown[][]).filter((c) => c[0] === "Storage.clearDataForOrigin").map((c) => c[1]);
  type SendFn = (method: string, params?: unknown) => Promise<unknown>;
  // The shared FakeCdp.send ignores params; wrap it to record them.
  function recordingCdp() {
    const cdp = new FakeCdp();
    const original = cdp.send as unknown as SendFn;
    cdp.send = vi.fn(async (method: string, params?: unknown) => original(method, params)) as never;
    return cdp;
  }

  it("clears cookies and permissions, closes every tab and opens one new blank tab", async () => {
    const a = resetPage("https://a.test/x");
    const b = resetPage("https://b.test/y");
    const c = resetPage("https://c.test/z");
    const { ctx, calls } = resetContext([a, b, c], recordingCdp());
    const target = new PlaywrightTarget(ctx as never);
    await target.ensurePage();
    await target.resetSession();
    expect(calls).toEqual(["clearCookies", "clearPermissions"]);
    // Even the current tab goes: its sessionStorage and history must not survive.
    expect([a, b, c].every((p) => p.closed)).toBe(true);
    expect(ctx.newPage).toHaveBeenCalledTimes(1);
    const tabs = await target.listPages();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].current).toBe(true);
  });

  it("a tab that is already closed mid-reset does not crash it", async () => {
    const a = resetPage("https://a.test/");
    (a.close as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Target closed"));
    const { ctx } = resetContext([a], recordingCdp());
    const target = new PlaywrightTarget(ctx as never);
    await target.ensurePage();
    await expect(target.resetSession()).resolves.toBeUndefined();
    expect(await target.listPages()).toHaveLength(1);
  });

  it("opens a page when there is none", async () => {
    const { ctx } = resetContext([], recordingCdp());
    const target = new PlaywrightTarget(ctx as never);
    await target.resetSession();
    expect(ctx.newPage).toHaveBeenCalledTimes(1);
    expect(await target.listPages()).toHaveLength(1);
  });

  it("clears the storage of every http(s) origin it saw, through CDP, and forgets them", async () => {
    const page = resetPage();
    const cdp = recordingCdp();
    const { ctx } = resetContext([page], cdp);
    const target = new PlaywrightTarget(ctx as never);
    await target.ensurePage();
    const main = (page.mainFrame as () => { url: () => string })();
    const nav = (frame: { url: () => string }) => page.emit("framenavigated", frame);
    const at = (url: string) => Object.create(main, { url: { value: () => url } }) as { url: () => string };
    const mainAt = (url: string) => { (main as { url: () => string }).url = () => url; nav(main); };
    mainAt("https://a.test/login?x=1");
    mainAt("https://a.test/other");
    mainAt("http://b.test:8080/");
    mainAt("about:blank");
    mainAt("data:text/html,hi");
    // A subframe (an ad iframe) is not tracked.
    nav(at("https://ads.test/frame"));
    await target.resetSession();
    expect(cleared(cdp)).toEqual([
      { origin: "https://a.test", storageTypes: "all" },
      { origin: "http://b.test:8080", storageTypes: "all" },
    ]);
    // A second reset has nothing left to clear.
    cdp.send.mockClear();
    await target.resetSession();
    expect(cleared(cdp)).toEqual([]);
  });

  it("learns the origin of a popup that opened later", async () => {
    const first = resetPage();
    const cdp = recordingCdp();
    const { ctx } = resetContext([first], cdp);
    const target = new PlaywrightTarget(ctx as never);
    await target.ensurePage();
    const popup = resetPage("https://pop.test/p");
    ctx.emit("page", popup);
    await tick();
    await target.resetSession();
    expect(cleared(cdp)).toEqual([{ origin: "https://pop.test", storageTypes: "all" }]);
  });

  it("fails when a storage clear fails, so a run is never called fresh by mistake", async () => {
    const page = resetPage("https://a.test/");
    const cdp = recordingCdp();
    const original = cdp.send as unknown as SendFn;
    cdp.send = vi.fn(async (method: string, params?: unknown) => {
      if (method === "Storage.clearDataForOrigin") throw new Error("denied");
      return original(method, params);
    }) as never;
    const { ctx } = resetContext([page], cdp);
    const target = new PlaywrightTarget(ctx as never);
    await target.ensurePage();
    await expect(target.resetSession()).rejects.toThrow("clearing the storage of 1 origin failed");
  });

  it("closes tabs and loads about:blank first, then clears cookies and permissions, then storage", async () => {
    const a = resetPage("https://a.test/x");
    const b = resetPage("https://b.test/y");
    const order: string[] = [];
    const cdp = recordingCdp();
    const original = cdp.send as unknown as SendFn;
    cdp.send = vi.fn(async (method: string, params?: unknown) => { if (method === "Storage.clearDataForOrigin") order.push("storage"); return original(method, params); }) as never;
    const { ctx } = resetContext([a, b], cdp);
    (b.close as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push("close b"); b.closed = true; b.emit("close"); });
    (a.close as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push("close a"); a.closed = true; a.emit("close"); });
    for (const p of [a, b]) (p.goto as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push("blank"); });
    (ctx.clearCookies as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push("cookies"); });
    (ctx.clearPermissions as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push("permissions"); });
    const target = new PlaywrightTarget(ctx as never);
    await target.ensurePage();
    await target.resetSession();
    expect(order.slice(0, 3).filter((x) => x.startsWith("close") || x === "blank")).toHaveLength(2);
    expect(order.indexOf("blank")).toBeLessThan(order.indexOf("cookies"));
    expect(order.indexOf("cookies")).toBeLessThan(order.indexOf("permissions"));
    expect(order.indexOf("permissions")).toBeLessThan(order.indexOf("storage"));
  });

  it("also clears the origins the fixture names, even when never seen", async () => {
    const page = resetPage();
    const cdp = recordingCdp();
    const { ctx } = resetContext([page], cdp);
    const target = new PlaywrightTarget(ctx as never);
    await target.ensurePage();
    await target.resetSession(["https://fixture.test", "not a url"]);
    expect(cleared(cdp)).toEqual([{ origin: "https://fixture.test", storageTypes: "all" }]);
  });

  it("clears at most 16 origins at a time", async () => {
    const page = resetPage();
    const cdp = recordingCdp();
    const original = cdp.send as unknown as SendFn;
    let active = 0;
    let peak = 0;
    cdp.send = vi.fn(async (method: string, params?: unknown) => {
      if (method !== "Storage.clearDataForOrigin") return original(method, params);
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      active -= 1;
      return {};
    }) as never;
    const { ctx } = resetContext([page], cdp);
    const target = new PlaywrightTarget(ctx as never);
    await target.ensurePage();
    await target.resetSession(Array.from({ length: 40 }, (_, i) => `https://o${i}.test`));
    expect(peak).toBe(16);
  });

  it("keeps the 500 newest origins and forgets the oldest", async () => {
    const page = resetPage();
    const cdp = recordingCdp();
    const { ctx } = resetContext([page], cdp);
    const target = new PlaywrightTarget(ctx as never);
    await target.ensurePage();
    const main = (page.mainFrame as () => { url: () => string })();
    for (let i = 0; i < 600; i++) {
      (main as { url: () => string }).url = () => `https://o${i}.test/`;
      page.emit("framenavigated", main);
    }
    await target.resetSession();
    const origins = cleared(cdp).map((c) => (c as { origin: string }).origin);
    expect(origins).toHaveLength(500);
    expect(origins).not.toContain("https://o99.test");
    expect(origins).toContain("https://o100.test");
    expect(origins).toContain("https://o599.test");
  });
});
