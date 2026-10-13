// Playwright-backed BrowserTarget / BrowserPageHandle for the vendored BrowserController.
// Wraps an EXISTING BrowserContext (from chromium.connectOverCDP to a Steel session) —
// there is no launch path: no Chromium runs on this host.
// Implemented optional methods: isVisible, capture, sendCdp, drainDialogs, drainConsoleErrors,
// onNavigationEvent, networkStats, listFrames, executeJavaScriptInFrame, listPages/selectPage/closePage/newPage/pageHandles.
import type { BrowserContext, Page, CDPSession, Frame } from "playwright-core";
import type { BrowserPageHandle, BrowserTarget, BrowserTabInfo } from "./vendor/controller.js";

class PwPage implements BrowserPageHandle {
  private loading = false;
  private title = "";
  private dialogs: { type: string; message: string }[] = [];
  private consoleErrors: string[] = [];
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
    this.titleDirty = true;
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
    });
    const done = (p: { requestId: string }) => this.pending.delete(p.requestId);
    cdp.on("Network.loadingFinished", done);
    cdp.on("Network.loadingFailed", done);
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
  private async refreshTitle(): Promise<void> {
    this.titleDirty = false;
    try {
      this.title = await this.page.title();
    } catch { /* navigating / closed: keep the last known title */ }
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
      if (this.titleDirty) await this.refreshTitle();
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
      return { imageData: buf.toString("base64"), width: vp.width, height: vp.height };
    } catch { return null; }
  }
  async sendCdp(method: string, params?: Record<string, unknown>) {
    await this.ready;
    return (this.cdp.send as (m: string, p?: Record<string, unknown>) => Promise<unknown>)(method, params);
  }
  drainDialogs() { return this.dialogs.splice(0); }
  drainConsoleErrors() { return this.consoleErrors.splice(0); }
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

export class PlaywrightTarget implements BrowserTarget {
  private readonly ctx: BrowserContext;
  private pages = new Map<number, PwPage>();
  private ids = new Map<Page, number>();
  private seq = 1;
  private currentId: number | null = null;

  constructor(existing: BrowserContext) {
    this.ctx = existing;
    existing.on("page", (p) => this.register(p));
    for (const p of existing.pages()) this.register(p);
  }

  private drop(id: number, p: Page) {
    this.pages.delete(id);
    this.ids.delete(p);
    if (this.currentId === id) this.currentId = [...this.pages.keys()].pop() ?? null;
  }
  private register(p: Page): PwPage {
    const existing = this.ids.get(p);
    if (existing) return this.pages.get(existing)!;
    const id = this.seq++;
    const h = new PwPage(p, this.ctx);
    this.pages.set(id, h);
    this.ids.set(p, id);
    this.currentId = id; // popups / new pages become current
    p.on("close", () => this.drop(id, p));
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
  async listPages(): Promise<BrowserTabInfo[]> {
    return [...this.pages].map(([tabId, h]) => ({ tabId, url: h.getURL(), title: h.getTitle(), current: tabId === this.currentId }));
  }
  async selectPage(tabId: number) {
    const h = this.pages.get(tabId);
    if (!h) return false;
    this.currentId = tabId;
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
    await h.ready;
    if (url) await h.loadURL(url).catch(() => {});
    const tabId = this.ids.get(p)!;
    return { tabId, url: h.getURL(), title: h.getTitle(), current: true };
  }
  async pageHandles() {
    return [...this.pages].map(([tabId, page]) => ({ tabId, page }));
  }
}
