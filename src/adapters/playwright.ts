// Playwright-backed BrowserTarget / BrowserPageHandle for the BrowserController.
// Wraps an EXISTING BrowserContext (from chromium.connectOverCDP to a Steel session) —
// there is no launch path: no Chromium runs on this host.
// Implemented optional methods: getCookies/setCookies/routeRequests/resetSession (PageFixture), isVisible, capture, fetchText, sendCdp, drainDialogs, drainConsoleErrors,
// onNavigationEvent, networkStats, listFrames, executeJavaScriptInFrame, listPages/selectPage/closePage/newPage/pageHandles.
import { isPlaceholderPageUrl } from "../shared/placeholderUrl.js";
import type { Browser, BrowserContext, BrowserContextOptions, Page, CDPSession, Frame, Route } from "playwright-core";
import { promises as dns } from "node:dns";
import http from "node:http";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import zlib from "node:zlib";
import type { Readable } from "node:stream";
import { BrowserController } from "../controller/index.js";
import { controllerBridge } from "./controllerBridge.js";
import type { OpenedBrowser } from "../loop/bridge.js";
import { isBlockedIp, isFetchableStylesheetUrl } from "../controller/captureCss.js";
import type { BrowserPageHandle, BrowserTarget, BrowserTabInfo, PageRequestEntry } from "../controller/index.js";
import { sleep } from "../fixture/apply.js";
import { httpOrigin } from "../fixture/util.js";
import type { FixtureCookie, FixtureMockResponse, FixtureRequestInfo } from "../fixture/types.js";

const MAX_FETCH_REDIRECTS = 3;

type Resolved = { address: string; family: number }[];
type LookupCallback = (err: Error | null, address?: string | Resolved, family?: number) => void;

/** A `lookup` for `http.request` that resolves ALL addresses and REJECTS if
 * any is private/loopback/link-local/...: the address that was checked is the
 * address the socket connects to, so a DNS answer cannot change in between
 * (DNS rebinding). */
export function guardedLookup(lookupAll: (host: string) => Promise<Resolved>) {
  return (hostname: string, options: { all?: boolean; family?: number } | number, cb: LookupCallback): void => {
    const opts = typeof options === "object" && options ? options : {};
    lookupAll(hostname).then(
      (addrs) => {
        if (addrs.length === 0 || addrs.some((a) => isBlockedIp(a.address))) {
          cb(new Error("blocked address"));
          return;
        }
        const usable = opts.family === 4 || opts.family === 6 ? addrs.filter((a) => a.family === opts.family) : addrs;
        if (usable.length === 0) cb(new Error("no address of the requested family"));
        else if (opts.all) cb(null, usable);
        else cb(null, usable[0].address, usable[0].family);
      },
      (err: Error) => cb(err),
    );
  };
}

type GuardedLookup = ReturnType<typeof guardedLookup>;

/** Seams for tests: how a hostname is resolved and how one request is made. */
export interface StylesheetFetchDeps {
  lookupAll?: (host: string) => Promise<Resolved>;
  request?: (
    url: URL,
    init: { headers: Record<string, string>; signal: AbortSignal; lookup: GuardedLookup },
  ) => Promise<IncomingMessage>;
}

const defaultLookupAll = (host: string): Promise<Resolved> => dns.lookup(host, { all: true });

function realRequest(
  url: URL,
  init: { headers: Record<string, string>; signal: AbortSignal; lookup: GuardedLookup },
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || undefined,
        path: url.pathname + url.search,
        method: "GET",
        headers: init.headers,
        lookup: init.lookup as never,
        signal: init.signal,
      },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
}

/** Stylesheet fetch for `capture` v2, run from THIS host (the cloud runs on
 * our backend network), so it is SSRF-hardened: Node `http`/`https` with a
 * connection-time address check (`guardedLookup`), redirects followed by hand
 * (at most 3, each Location re-checked with `isFetchableStylesheetUrl`), gzip /
 * deflate / br decoded with the cap applied to the DECODED bytes, a streaming
 * size cap and an abort signal. It is cookie-less, and sends only the page
 * origin as referer. */
export async function fetchStylesheet(
  url: string,
  opts: { timeoutMs: number; maxBytes: number; signal?: AbortSignal },
  ctx: { referer?: string; userAgent?: string; deps?: StylesheetFetchDeps } = {},
): Promise<{ status: number; text: string; contentType?: string }> {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const lookup = guardedLookup(ctx.deps?.lookupAll ?? defaultLookupAll);
  const request = ctx.deps?.request ?? realRequest;
  const headers: Record<string, string> = {
    accept: "text/css,*/*;q=0.1",
    "accept-encoding": "gzip, deflate, br",
    ...(ctx.referer ? { referer: ctx.referer } : {}),
    // Some hosts (Wikimedia) answer 403 to a request without a user agent.
    ...(ctx.userAgent ? { "user-agent": ctx.userAgent } : {}),
  };
  let current = url;
  for (let hop = 0; hop <= MAX_FETCH_REDIRECTS; hop++) {
    if (!isFetchableStylesheetUrl(current)) throw new Error("blocked url");
    const res = await request(new URL(current), { headers, signal, lookup });
    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (status >= 300 && status < 400 && location) {
      res.resume();
      current = new URL(location, current).href;
      continue;
    }
    const declared = Number(res.headers["content-length"]);
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      res.destroy();
      throw new Error("response too large");
    }
    const encoding = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
    let body: Readable = res;
    if (encoding === "gzip" || encoding === "x-gzip") body = res.pipe(zlib.createGunzip());
    else if (encoding === "deflate") body = res.pipe(zlib.createInflate());
    else if (encoding === "br") body = res.pipe(zlib.createBrotliDecompress());
    if (body !== res) res.on("error", (e) => body.destroy(e));
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buf.length;
      if (size > opts.maxBytes) {
        res.destroy();
        body.destroy();
        throw new Error("response too large");
      }
      chunks.push(buf);
    }
    const contentType = res.headers["content-type"];
    return { status, text: Buffer.concat(chunks).toString("utf8"), contentType: typeof contentType === "string" ? contentType : undefined };
  }
  throw new Error("too many redirects");
}

/** Only the origin, like a browser's strict-origin-when-cross-origin referer. */
function refererOrigin(pageUrl: string): string | undefined {
  try {
    const origin = new URL(pageUrl).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}

/** A request being tracked for `drainRequests`. */
interface ReqRecord { requestId: string; startMono?: number; mimeType?: string; error?: string; redirect?: boolean; entry: PageRequestEntry }
const MAX_REQUEST_RING = 300;
const MAX_BODY_FETCHES = 30;
const MAX_BODY_CHARS = 16 * 1024;
/** All body fetches of one drain together. */
const BODY_PHASE_MS = 2000;
const TEXT_MIME = /json|^text\/|xml|javascript|x-www-form-urlencoded/i;

class PwPage implements BrowserPageHandle {
  private loading = false;
  private title = "";
  private dialogs: { type: string; message: string }[] = [];
  private consoleErrors: string[] = [];
  private failedRequests: string[] = [];
  // requestId -> method + redacted URL, for the requests worth reporting if they fail (bounded).
  private requestInfo = new Map<string, { method: string; url: string }>();
  // Request log for `drainRequests`: in-flight records by requestId, and the finished ring (<= 300).
  private reqActive = new Map<string, ReqRecord>();
  private reqDone: ReqRecord[] = [];
  private reqDropped = 0;
  private navCbs = new Set<() => void>();
  private domReadyWaiters: (() => void)[] = [];
  private pending = new Map<string, { startedAt: number; generation: number }>();
  private gen = 0;
  private frames = new Map<number, Frame>();
  private frameSeq = 1;
  private cdp!: CDPSession;
  ready: Promise<void>;

  constructor(readonly page: Page, private readonly ctx: BrowserContext) {
    this.ready = this.init();
    // Popup pages registered from the context 'page' event are never awaited; without
    // this a failing init (page closed instantly) is an unhandled rejection. Awaiters
    // still observe the rejection on `ready` itself.
    this.ready.catch(() => {});
  }

  private fireNav() {
    this.markTitleDirty();
    for (const cb of this.navCbs) {
      try { cb(); } catch { /* ignore */ }
    }
  }

  private async init() {
    const page = this.page;
    this.cdp = await this.ctx.newCDPSession(page);
    const cdp = this.cdp;
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    cdp.on("Page.frameStartedLoading", (p) => {
      if (p.frameId === this.mainFrameId) { this.loading = true; this.fireNav(); }
    });
    cdp.on("Page.frameStoppedLoading", (p) => {
      if (p.frameId === this.mainFrameId) this.loading = false;
    });
    cdp.on("Page.frameNavigated", (p) => {
      if (!p.frame.parentId) { this.mainFrameId = p.frame.id; void this.refreshHistory(); this.fireNav(); }
    });
    cdp.on("Page.navigatedWithinDocument", (p: { frameId?: string }) => {
      if (!p.frameId || p.frameId === this.mainFrameId) void this.refreshHistory();
      this.fireNav();
    });
    cdp.on("Page.domContentEventFired", () => {
      const w = this.domReadyWaiters.splice(0);
      for (const f of w) f();
    });
    cdp.on("Network.requestWillBeSent", (p) => {
      if (["WebSocket", "EventSource", "Ping"].includes(p.type ?? "")) return;
      this.gen += 1;
      this.pending.set(p.requestId, { startedAt: Date.now(), generation: this.gen });
      this.rememberRequest(p.requestId, p.request?.method, p.request?.url);
      this.trackRequest(p);
    });
    const done = (p: { requestId: string }) => this.pending.delete(p.requestId);
    cdp.on("Network.loadingFinished", (p) => { done(p); this.requestInfo.delete(p.requestId); this.finishRequest(p.requestId, p.timestamp, undefined, p.encodedDataLength); });
    cdp.on("Network.responseReceived", (p) => {
      this.noteResponse(p.requestId, p.type, p.response);
      const status = p.response?.status;
      if (typeof status === "number" && status >= 400) this.recordFailedRequest(p.requestId, String(status));
    });
    cdp.on("Network.loadingFailed", (p) => {
      done(p);
      // A request the page canceled itself (an aborted fetch, a navigation away) is not a failure.
      if (!p.canceled && p.errorText !== "net::ERR_ABORTED") this.recordFailedRequest(p.requestId, p.errorText || "failed");
      this.requestInfo.delete(p.requestId);
      this.finishRequest(p.requestId, p.timestamp, p.errorText || "failed");
    });
    try {
      const tree = await cdp.send("Page.getFrameTree");
      this.mainFrameId = tree.frameTree.frame.id;
    } catch { /* ignore */ }
    await this.refreshHistory();

    // Dialog policy copied from desktop CLAUDE.md: alert/beforeunload accept, confirm/prompt dismiss.
    page.on("dialog", (d) => {
      const type = d.type();
      this.dialogs.push({ type, message: d.message().slice(0, 200) });
      if (this.dialogs.length > 10) this.dialogs.shift();
      const accept = type === "alert" || type === "beforeunload";
      (accept ? d.accept() : d.dismiss()).catch(() => {});
    });
    page.on("console", (m) => {
      if (m.type() === "error") {
        this.consoleErrors.push(m.text().slice(0, 200));
        if (this.consoleErrors.length > 50) this.consoleErrors.shift();
      }
    });
    page.on("pageerror", (e) => {
      this.consoleErrors.push(String(e.message).slice(0, 200));
      if (this.consoleErrors.length > 50) this.consoleErrors.shift();
    });
    const refreshTitle = () => { void this.refreshTitle(); };
    page.on("domcontentloaded", refreshTitle);
    page.on("load", refreshTitle);
    page.on("framenavigated", refreshTitle);
  }

  // getTitle() is synchronous in BrowserPageHandle, so it can only serve a cache. The
  // spike's cache was refreshed by events alone and went stale (a command that resolves
  // right after a navigation read the PREVIOUS title). The fix: every operation that can
  // change the title re-reads it from the live page before resolving (loadURL,
  // executeJavaScript); the cache is only what getTitle() falls back to when that read
  // fails mid-navigation.
  //
  // Only after a navigation, though: page.title() is a full round trip to the remote
  // browser, and paying it after EVERY script doubled the cost of each command on a
  // real Steel session (a perform is ~10 scripts, ~0.3-0.5 s per trip). fireNav() — every
  // main-frame navigation, same-document ones included — marks the cached title stale.
  private titleDirty = true;
  /** Bumped by every navigation: a read that started before a newer navigation must not write its title. */
  private titleGen = 0;
  /** The one title read in flight for this page, and the `titleGen` it started at. */
  private titleRead: Promise<void> | null = null;
  private titleReadGen = -1;
  private markTitleDirty(): void {
    this.titleGen += 1;
    this.titleDirty = true;
  }
  /** One read at a time: a running read is reused while no navigation happened since it started. */
  private refreshTitle(): Promise<void> {
    if (this.titleRead && this.titleReadGen === this.titleGen) return this.titleRead;
    const gen = this.titleGen;
    const read: Promise<void> = (async () => {
      try {
        const title = await this.page.title();
        // A read that a navigation overtook is abandoned: it must not overwrite a fresher title.
        if (gen === this.titleGen) { this.title = title; this.titleDirty = false; }
      } catch { /* navigating / closed: keep the last known title */ }
    })().finally(() => { if (this.titleRead === read) this.titleRead = null; });
    this.titleRead = read;
    this.titleReadGen = gen;
    return read;
  }
  /** Await a refresh only when the title is stale and no read is already running (a running read never blocks a command). */
  private async refreshIfIdle(): Promise<void> {
    if (this.titleDirty && !this.titleRead) await this.refreshTitle();
  }
  /**
   * The title for a tab list: re-read when stale, at most `maxWaitMs` (a busy page keeps the cached title).
   * Without it a page no command touched yet (an Electron window, a popup) is listed with an empty title.
   */
  async listedTitle(maxWaitMs = 1000): Promise<string> {
    if (this.titleDirty) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.refreshTitle(),
          new Promise<void>((r) => { timer = setTimeout(r, maxWaitMs); timer.unref?.(); }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    return this.title;
  }
  private mainFrameId = "";

  // canGoBack()/canGoForward() are synchronous, so they answer from a cache that is
  // refreshed from CDP after every main-frame navigation. Unknown (before the first
  // fetch) reads as "no history", so the controller reports a clear "can't go back".
  private histIndex = -1;
  private histLength = 0;
  private async refreshHistory(): Promise<void> {
    try {
      const h = await this.cdp.send("Page.getNavigationHistory");
      this.histIndex = h.currentIndex;
      this.histLength = h.entries.length;
    } catch { /* closed / navigating: keep the last known history */ }
  }

  async loadURL(url: string): Promise<void> {
    await this.ready;
    try {
      await this.page.goto(url, { waitUntil: "load", timeout: 60_000 });
      await this.refreshTitle();
      await this.refreshHistory();
    } catch (e) {
      // ERR_ABORTED is what a JS-challenge redirect/reload racing the first navigation produces
      // (skroutz); wait for the superseding navigation to load instead of failing.
      if (/ERR_ABORTED/.test(String(e))) {
        await this.page.waitForLoadState("load", { timeout: 20_000 }).catch(() => {});
        await this.refreshTitle();
        return;
      }
      throw e;
    }
  }
  async executeJavaScript(code: string): Promise<unknown> {
    try {
      return await this.page.evaluate(code);
    } finally {
      await this.refreshIfIdle();
    }
  }
  getURL() { return this.page.url(); }
  getTitle() { return this.title; }
  goBack() { this.page.goBack({ waitUntil: "commit" }).catch(() => {}); }
  goForward() { this.page.goForward({ waitUntil: "commit" }).catch(() => {}); }
  reload() { this.page.reload({ waitUntil: "commit" }).catch(() => {}); }
  canGoBack() { return this.histIndex > 0; }
  canGoForward() { return this.histIndex >= 0 && this.histIndex < this.histLength - 1; }
  isLoading() { return this.loading; }
  // Electron semantics: resolves on the NEXT dom-ready (armed before loadURL). No readyState shortcut.
  onceDomReady(): Promise<void> {
    return new Promise<void>((r) => this.domReadyWaiters.push(r));
  }
  isVisible() { return true; }
  async capture() {
    try {
      const buf = await this.page.screenshot({ type: "jpeg", quality: 70, scale: "css" });
      const vp = this.page.viewportSize() ?? { width: 1280, height: 800 };
      return { imageData: `data:image/jpeg;base64,${buf.toString("base64")}`, width: vp.width, height: vp.height };
    } catch { return null; }
  }
  /** See `fetchStylesheet`: SSRF-hardened and cookie-less. */
  private userAgent: Promise<string | undefined> | undefined;
  async fetchText(url: string, opts: { timeoutMs: number; maxBytes: number; signal?: AbortSignal }) {
    // The page's own user agent (read once), so the fetch looks like the browser's.
    this.userAgent ??= (async () => {
      try {
        return await this.page.evaluate(() => navigator.userAgent);
      } catch {
        return undefined;
      }
    })();
    return fetchStylesheet(url, opts, { referer: refererOrigin(this.page.url()), userAgent: await this.userAgent });
  }
  async sendCdp(method: string, params?: Record<string, unknown>) {
    await this.ready;
    return (this.cdp.send as (m: string, p?: Record<string, unknown>) => Promise<unknown>)(method, params);
  }
  drainDialogs() { return this.dialogs.splice(0); }
  drainConsoleErrors() { return this.consoleErrors.splice(0); }
  drainFailedRequests() { return this.failedRequests.splice(0); }
  async drainRequests(): Promise<PageRequestEntry[]> {
    const records = this.reqDone.splice(0);
    let bodies = 0;
    // Past the phase limit the entries go out as they are; a late body is not written.
    let over = false;
    const fetches = Promise.all(records.map(async (r) => {
      if (bodies >= MAX_BODY_FETCHES || r.redirect || r.error !== undefined || !r.mimeType || !TEXT_MIME.test(r.mimeType) || !["fetch", "xhr"].includes(r.entry.type ?? "")) return;
      bodies++;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const res = await Promise.race([
          (this.cdp.send as (m: string, p?: Record<string, unknown>) => Promise<{ body?: string; base64Encoded?: boolean }>)("Network.getResponseBody", { requestId: r.requestId }),
          new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 1000); }),
        ]);
        if (over || !res || res.base64Encoded || typeof res.body !== "string") return;
        r.entry.body = res.body.slice(0, MAX_BODY_CHARS);
        if (res.body.length > MAX_BODY_CHARS) r.entry.bodyTruncated = true;
      } catch { /* the body is gone: no body */ } finally { clearTimeout(timer); }
    }));
    let phase: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([fetches, new Promise<void>((resolve) => { phase = setTimeout(resolve, BODY_PHASE_MS); })]);
    clearTimeout(phase);
    over = true;
    return records.map((r) => r.entry);
  }
  droppedRequests() { const n = this.reqDropped; this.reqDropped = 0; return n; }
  /** What a closing tab leaves: its finished entries (no bodies: the session is gone) and the drop count. */
  takeClosedRequests(): { requests: PageRequestEntry[]; dropped: number } {
    return { requests: this.reqDone.splice(0).map((r) => r.entry), dropped: this.droppedRequests() };
  }
  private trackRequest(p: { requestId: string; timestamp?: number; wallTime?: number; type?: string; request?: { url?: string; method?: string; headers?: Record<string, string> }; redirectResponse?: { status?: number; mimeType?: string; headers?: Record<string, string> } }) {
    const url = p.request?.url;
    if (!url || url.startsWith("data:") || ["WebSocket", "EventSource", "Ping"].includes(p.type ?? "")) return;
    // A redirect reuses the requestId: the earlier hop ends here.
    if (p.redirectResponse && this.reqActive.has(p.requestId)) {
      this.noteResponse(p.requestId, undefined, p.redirectResponse);
      // The hop shares its requestId with the final one: a body fetch would return the final body.
      this.reqActive.get(p.requestId)!.redirect = true;
      this.finishRequest(p.requestId, p.timestamp, undefined, undefined);
    }
    const entry: PageRequestEntry = {
      at: typeof p.wallTime === "number" ? Math.round(p.wallTime * 1000) : Date.now(),
      method: p.request?.method || "GET",
      url,
    };
    if (p.type) entry.type = p.type.toLowerCase();
    if (p.request?.headers) entry.requestHeaders = { ...p.request.headers };
    this.reqActive.set(p.requestId, { requestId: p.requestId, startMono: p.timestamp, entry });
    if (this.reqActive.size > 500) { this.reqActive.delete(this.reqActive.keys().next().value as string); this.reqDropped += 1; }
  }
  private noteResponse(requestId: string, type: string | undefined, response: { status?: number; mimeType?: string; headers?: Record<string, string> } | undefined) {
    const r = this.reqActive.get(requestId);
    if (!r || !response) return;
    if (type && !r.entry.type) r.entry.type = type.toLowerCase();
    if (typeof response.status === "number") r.entry.status = response.status;
    if (response.mimeType) { r.entry.mimeType = response.mimeType; r.mimeType = response.mimeType; }
    if (response.headers) r.entry.responseHeaders = { ...response.headers };
  }
  private finishRequest(requestId: string, timestamp: number | undefined, error: string | undefined, size?: number) {
    const r = this.reqActive.get(requestId);
    if (!r) return;
    this.reqActive.delete(requestId);
    if (error !== undefined) { r.error = error; r.entry.error = error; }
    if (typeof size === "number") r.entry.size = size;
    if (typeof timestamp === "number" && typeof r.startMono === "number") r.entry.durationMs = Math.max(0, Math.round((timestamp - r.startMono) * 1000));
    this.reqDone.push(r);
    if (this.reqDone.length > MAX_REQUEST_RING) { this.reqDone.shift(); this.reqDropped += 1; }
  }
  private rememberRequest(requestId: string, method: string | undefined, url: string | undefined) {
    if (!url || url.startsWith("data:")) return;
    let shown: string;
    try {
      const u = new URL(url);
      shown = `${u.origin}${u.pathname}`;
    } catch {
      return;
    }
    if (shown.startsWith("null")) return;
    this.requestInfo.set(requestId, { method: method || "GET", url: shown });
    if (this.requestInfo.size > 500) this.requestInfo.delete(this.requestInfo.keys().next().value as string);
  }
  private recordFailedRequest(requestId: string, what: string) {
    const info = this.requestInfo.get(requestId);
    if (!info) return;
    this.failedRequests.push(`${info.method} ${what} ${info.url}`.slice(0, 200));
    if (this.failedRequests.length > 50) this.failedRequests.shift();
  }
  onNavigationEvent(cb: () => void) { this.navCbs.add(cb); return () => { this.navCbs.delete(cb); }; }
  networkStats(dropAfterMs: number, sinceGeneration?: number) {
    const now = Date.now();
    let pending = 0;
    for (const [id, r] of this.pending) {
      if (now - r.startedAt > dropAfterMs) { this.pending.delete(id); continue; }
      if (sinceGeneration === undefined || r.generation > sinceGeneration) pending++;
    }
    return { pending, generation: this.gen };
  }
  listFrames() {
    this.frames.clear();
    return this.page.mainFrame().childFrames().map((f) => {
      const id = this.frameSeq++;
      this.frames.set(id, f);
      return { frameId: id, url: f.url(), name: f.name() };
    });
  }
  async executeJavaScriptInFrame(frameId: number, code: string, timeoutMs: number) {
    const f = this.frames.get(frameId);
    if (!f || f.isDetached()) throw new Error("frame gone");
    return Promise.race([
      f.evaluate(code),
      new Promise((_, rej) => setTimeout(() => rej(new Error("frame timeout")), timeoutMs)),
    ]);
  }
}

type PwCookie = Awaited<ReturnType<BrowserContext["cookies"]>>[number];
type PwCookieInput = Parameters<BrowserContext["addCookies"]>[0][number];

/** Playwright's cookie as a fixture cookie. `expires` -1 is a session cookie. */
function toFixtureCookie(c: PwCookie): FixtureCookie {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    ...(c.expires > 0 ? { expires: c.expires } : {}),
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
  };
}

/** A fixture cookie as `addCookies` input: it takes `url`, or `domain` + `path`, never both. */
function toPlaywrightCookie(c: FixtureCookie): PwCookieInput {
  const common = {
    name: c.name,
    value: c.value,
    ...(c.expires !== undefined ? { expires: c.expires } : {}),
    ...(c.httpOnly !== undefined ? { httpOnly: c.httpOnly } : {}),
    ...(c.secure !== undefined ? { secure: c.secure } : {}),
    ...(c.sameSite !== undefined ? { sameSite: c.sameSite } : {}),
  };
  if (c.url) return { ...common, url: c.url };
  return { ...common, domain: c.domain!, path: c.path ?? "/" };
}

const MAX_SEEN_ORIGINS = 500;

/** How many origins `resetSession` clears at once. */
const RESET_CLEAR_CONCURRENCY = 16;

export { isPlaceholderPageUrl };

export interface PlaywrightTargetOptions {
  /**
   * App mode: pages with a placeholder URL (see `isPlaceholderPageUrl`) never take the current tab from a real page,
   * and become current only when no real page exists. A current placeholder gives way when a page navigates to a real URL.
   * Default false: every new page becomes current (a popup that starts at `about:blank` is the page the agent wants).
   */
  skipPlaceholderPages?: boolean;
  /** Clock for the late-window rule; tests inject one. */
  now?: () => number;
}

/** How long after it appeared a placeholder page may still take over by loading real content. */
const AWAITING_MS = 10_000;

export class PlaywrightTarget implements BrowserTarget {
  private readonly ctx: BrowserContext;
  private readonly skipPlaceholders: boolean;
  /** App mode: placeholder pages that appeared while a real page was current, with the time they did. Their first real navigation, within AWAITING_MS and with nothing pinned, makes them current. */
  private awaiting = new Map<number, number>();
  private readonly now: () => number;
  /** The page the agent made current on purpose (selectPage / newPage): the placeholder hand-off does not displace it. */
  private explicitId: number | null = null;
  private pages = new Map<number, PwPage>();
  private ids = new Map<Page, number>();
  private seq = 1;
  private currentId: number | null = null;
  /** Origins the main frame of any page navigated to, oldest first: `resetSession` clears their storage. */
  private seenOrigins = new Set<string>();

  constructor(existing: BrowserContext, opts: PlaywrightTargetOptions = {}) {
    this.ctx = existing;
    this.skipPlaceholders = opts.skipPlaceholderPages === true;
    existing.on("page", (p) => this.register(p));
    this.now = opts.now ?? Date.now;
    for (const p of existing.pages()) this.register(p);
    // A placeholder that sits beside a real current page (a main window still at about:blank) may load later.
    if (this.skipPlaceholders && !this.isPlaceholderId(this.currentId)) {
      for (const id of this.pages.keys()) if (id !== this.currentId && this.isPlaceholderId(id)) this.awaiting.set(id, this.now());
    }
  }

  private noteOrigin(url: string) {
    const origin = httpOrigin(url);
    if (!origin) return;
    // Re-noting moves an origin to the newest end; the oldest is forgotten past the cap.
    this.seenOrigins.delete(origin);
    this.seenOrigins.add(origin);
    if (this.seenOrigins.size > MAX_SEEN_ORIGINS) this.seenOrigins.delete(this.seenOrigins.values().next().value as string);
  }

  /** Finished request entries of closed tabs, until the controller drains them (at most 300). */
  private closedRequests: PageRequestEntry[] = [];
  private closedDropped = 0;
  drainClosedRequests(): { requests: PageRequestEntry[]; dropped?: number } {
    const requests = this.closedRequests.splice(0);
    const dropped = this.closedDropped;
    this.closedDropped = 0;
    return dropped > 0 ? { requests, dropped } : { requests };
  }

  private drop(id: number, p: Page) {
    const taken = this.pages.get(id)?.takeClosedRequests();
    if (taken) {
      this.closedRequests.push(...taken.requests);
      this.closedDropped += taken.dropped;
      if (this.closedRequests.length > MAX_REQUEST_RING) {
        this.closedDropped += this.closedRequests.length - MAX_REQUEST_RING;
        this.closedRequests.splice(0, this.closedRequests.length - MAX_REQUEST_RING);
      }
    }
    this.pages.delete(id);
    this.ids.delete(p);
    this.awaiting.delete(id);
    if (this.explicitId === id) this.explicitId = null;
    if (this.currentId === id) this.currentId = this.pickCurrent();
  }
  private isPlaceholderId(id: number | null): boolean {
    const h = id === null ? undefined : this.pages.get(id);
    return !h || isPlaceholderPageUrl(h.page.url());
  }
  /** The newest page; in app mode the newest real page, else the newest page. */
  private pickCurrent(): number | null {
    const ids = [...this.pages.keys()];
    if (this.skipPlaceholders) {
      for (let i = ids.length - 1; i >= 0; i--) if (!this.isPlaceholderId(ids[i])) return ids[i];
    }
    return ids.pop() ?? null;
  }
  private register(p: Page): PwPage {
    const existing = this.ids.get(p);
    if (existing) return this.pages.get(existing)!;
    const id = this.seq++;
    const h = new PwPage(p, this.ctx);
    this.pages.set(id, h);
    this.ids.set(p, id);
    // Popups / new pages become current. App mode: a placeholder only takes over from nothing or another placeholder.
    const placeholder = isPlaceholderPageUrl(p.url());
    if (!this.skipPlaceholders || !placeholder || this.isPlaceholderId(this.currentId)) {
      this.currentId = id;
    } else {
      this.awaiting.set(id, this.now());
    }
    p.on("close", () => this.drop(id, p));
    this.noteOrigin(p.url());
    // Only the main frame: an ad iframe's origin has no storage the next run could notice, and would crowd the list.
    p.on("framenavigated", (frame: Frame) => {
      if (frame !== p.mainFrame()) return;
      this.noteOrigin(frame.url());
      if (!this.skipPlaceholders || isPlaceholderPageUrl(frame.url())) return;
      const since = this.awaiting.get(id);
      if (since !== undefined) {
        this.awaiting.delete(id);
        if (this.explicitId === null && this.now() - since <= AWAITING_MS) this.currentId = id;
      } else if (this.currentId !== id && this.isPlaceholderId(this.currentId) && this.explicitId !== this.currentId) {
        this.currentId = id;
      }
    });
    // A page whose CDP init failed is unusable: forget it (ensurePage makes a fresh one).
    h.ready.catch(() => this.drop(id, p));
    return h;
  }
  async ensurePage(): Promise<BrowserPageHandle> {
    const ctx = this.ctx;
    let h = this.currentId ? this.pages.get(this.currentId) : undefined;
    if (!h) {
      const p = await ctx.newPage();
      h = this.register(p);
    }
    await h.ready;
    return h;
  }
  currentPage() { return this.currentId ? this.pages.get(this.currentId) ?? null : null; }
  async listPages(opts?: { freshTitles?: boolean }): Promise<BrowserTabInfo[]> {
    const entries = [...this.pages];
    // Live titles cost a page.title() round trip per stale page: only the tab list the agent reads asks for them.
    const titles = opts?.freshTitles ? await Promise.all(entries.map(([, h]) => h.listedTitle())) : entries.map(([, h]) => h.getTitle());
    return entries.map(([tabId, h], i) => ({ tabId, url: h.getURL(), title: titles[i], current: tabId === this.currentId }));
  }
  async selectPage(tabId: number) {
    const h = this.pages.get(tabId);
    if (!h) return false;
    this.currentId = tabId;
    this.explicitId = tabId;
    await h.page.bringToFront().catch(() => {});
    return true;
  }
  async closePage(tabId: number) {
    const h = this.pages.get(tabId);
    if (!h) return false;
    await h.page.close().catch(() => {});
    return true;
  }
  async newPage(url?: string): Promise<BrowserTabInfo> {
    const ctx = this.ctx;
    const p = await ctx.newPage();
    const h = this.register(p);
    // The agent opened this tab on purpose: it is current even in app mode, so a follow-up open loads into it.
    const newId = this.ids.get(p);
    if (newId !== undefined) { this.currentId = newId; this.explicitId = newId; this.awaiting.delete(newId); }
    await h.ready;
    if (url) await h.loadURL(url).catch(() => {});
    const tabId = this.ids.get(p)!;
    return { tabId, url: h.getURL(), title: h.getTitle(), current: true };
  }
  async pageHandles() {
    return [...this.pages].map(([tabId, page]) => ({ tabId, page }));
  }
  // Cookies live on the context, so Steel (which connects through this target) gets them too.
  async getCookies(urls?: string[]): Promise<FixtureCookie[]> {
    return (await this.ctx.cookies(urls)).map(toFixtureCookie);
  }
  async setCookies(cookies: FixtureCookie[]): Promise<void> {
    await this.ctx.addCookies(cookies.map(toPlaywrightCookie));
  }

  // Network mocks for the whole context (every tab, popup included). The rules
  // live in `handler`; this method only answers. A request nobody mocks goes to
  // `route.fallback()`, so the host's own route handlers still see it. After
  // removal, a request that waits for its delay falls back too, instead of
  // getting a stale mock.
  async routeRequests(handler: (req: FixtureRequestInfo) => FixtureMockResponse | undefined): Promise<() => Promise<void>> {
    const removal = new AbortController();
    const onRoute = async (route: Route): Promise<void> => {
      const request = route.request();
      let mock: FixtureMockResponse | undefined;
      try {
        mock = removal.signal.aborted ? undefined : handler({ url: request.url(), method: request.method() });
      } catch {
        mock = undefined;
      }
      try {
        if (!mock) return await route.fallback();
        if (mock.delayMs) {
          try {
            await sleep(mock.delayMs, removal.signal);
          } catch {
            return await route.fallback();
          }
        }
        if (mock.abort) return await route.abort("failed");
        await route.fulfill({ status: mock.status, headers: mock.headers, body: mock.body });
      } catch {
        // The answer failed (a bad header, a closed page). A request left unanswered would hang
        // the page until the route is removed: hand it on, and fail it as the last resort.
        try {
          await route.fallback();
        } catch {
          await route.abort().catch(() => {});
        }
      }
    };
    await this.ctx.route("**/*", onRoute);
    return async () => {
      removal.abort();
      await this.ctx.unroute("**/*", onRoute);
    };
  }

  // PageFixture `fresh`. Everything the next task could notice from the last one is cleared.
  // Every tab goes (sessionStorage and history live in a tab) and one new blank tab replaces them,
  // before cookies and storage are cleared: an open page could write storage again afterwards.
  async resetSession(origins: string[] = []): Promise<void> {
    await Promise.all(
      [...this.pages].map(async ([id, h]) => {
        await h.page.close().catch(() => {});
        this.drop(id, h.page);
      }),
    );
    const kept = (await this.ensurePage()) as PwPage;
    await kept.loadURL("about:blank");
    await this.ctx.clearCookies();
    await this.ctx.clearPermissions();
    const all = new Set(this.seenOrigins);
    for (const url of origins) {
      const origin = httpOrigin(url);
      if (origin) all.add(origin);
    }
    const queue = [...all];
    let failed = 0;
    const worker = async () => {
      for (let origin = queue.shift(); origin !== undefined; origin = queue.shift()) {
        try {
          await kept.sendCdp("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
        } catch { failed += 1; }
      }
    };
    await Promise.all(Array.from({ length: RESET_CLEAR_CONCURRENCY }, worker));
    if (failed > 0) throw new Error(`clearing the storage of ${failed} origin${failed === 1 ? "" : "s"} failed`);
    this.seenOrigins.clear();
  }
}

// The Steel CDP URL carries the account API key (`?apiKey=…`), and Playwright
// echoes that URL into connectOverCDP error messages — which routes log. Every
// error crossing the connect boundary goes through here first.

/** Extracts the apiKey query value from a CDP URL, if any. */
function apiKeyOf(cdpUrl: string): string | null {
  try {
    return new URL(cdpUrl).searchParams.get("apiKey");
  } catch {
    return null;
  }
}

function redactApiKey(text: string, cdpUrl: string): string {
  let out = text;
  const key = apiKeyOf(cdpUrl);
  if (key) {
    for (const variant of new Set([key, encodeURIComponent(key)])) out = out.split(variant).join("***");
  }
  return out.replace(/apiKey=[^&\s"']+/gi, "apiKey=***");
}

/** A fresh Error with message/stack redacted; the original is deliberately NOT kept as `cause`. */
export function redactedError(e: unknown, secret: string): Error {
  const src = e instanceof Error ? e : new Error(String(e));
  const out = new Error(redactApiKey(src.message, secret));
  out.name = src.name;
  if (src.stack) out.stack = redactApiKey(src.stack, secret);
  return out;
}

// CDP-connect to a remote browser (e.g. a Steel session) with Playwright and
// drive it with the BrowserController. Playwright is imported lazily so
// a deployment (or test) that never opens a cloud browser never loads it.
export async function connectOverCdp(
  cdpUrl: string,
  controllerOptions?: ConstructorParameters<typeof BrowserController>[1],
  targetOptions?: PlaywrightTargetOptions,
): Promise<{ controller: BrowserController; close(): Promise<void>; onDisconnected(cb: () => void): void }> {
  try {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const controller = new BrowserController(new PlaywrightTarget(context, targetOptions), controllerOptions);
    return {
      controller,
      close: () => browser.close(),
      onDisconnected: (cb) => { browser.on("disconnected", () => cb()); },
    };
  } catch (e) {
    // The URL (with the API key) is inside Playwright's error text.
    throw redactedError(e, cdpUrl);
  }
}

/**
 * A factory of isolated browsers: each call makes a new `BrowserContext`, so
 * cookies, storage and network mocks (`context.route`) are per run (for parallel QA runs).
 * `close` closes the context, not the browser: the host owns the browser.
 * `controllerOptions` go to each `BrowserController` (default: its defaults, cursor on).
 */
export function playwrightContexts(
  browser: Browser,
  contextOptions?: BrowserContextOptions,
  controllerOptions?: ConstructorParameters<typeof BrowserController>[1],
): () => Promise<OpenedBrowser> {
  return async () => {
    const context = await browser.newContext(contextOptions);
    try {
      await context.newPage();
      return { browser: controllerBridge(new BrowserController(new PlaywrightTarget(context), controllerOptions)), close: () => context.close() };
    } catch (e) {
      await context.close().catch(() => undefined);
      throw e;
    }
  };
}
