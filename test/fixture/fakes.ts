import type { BrowserPageHandle, BrowserTarget, BrowserTabInfo } from "../../src/controller/controller.js";
import type { FixtureCookie } from "../../src/fixture/types.js";

export interface FakePage extends BrowserPageHandle {
  url: string;
  keys: { method: string; params?: Record<string, unknown> }[];
}

/** A page handle that logs into `log`. `exec` answers `executeJavaScript` (default: every script succeeds). */
export function fakePage(
  log: string[],
  name = "main",
  exec: (code: string) => unknown = () => JSON.stringify({ ok: true, found: true }),
  withCdp = true,
): FakePage {
  const page: FakePage = {
    url: "about:blank",
    keys: [],
    async loadURL(url) {
      log.push(`${name}: load ${url}`);
      page.url = url;
    },
    async executeJavaScript(code) {
      log.push(`${name}: js`);
      return exec(code);
    },
    getURL: () => page.url,
    getTitle: () => `title of ${page.url}`,
    goBack() {},
    goForward() {},
    reload() {},
    canGoBack: () => false,
    canGoForward: () => false,
    isLoading: () => false,
    onceDomReady: async () => {},
  };
  if (withCdp) {
    page.sendCdp = async (method, params) => {
      page.keys.push({ method, params });
    };
  }
  return page;
}

export interface FakeTarget extends BrowserTarget {
  log: string[];
  pages: Map<number, FakePage>;
  currentId: number;
  cookiesSet: FixtureCookie[][];
  /** The argument of every `newPage` call. */
  newPageArgs: (string | undefined)[];
}

/** A target with tabs, `setCookies` and `getCookies`. */
export function fakeTarget(opts: { exec?: (code: string) => unknown; cookies?: FixtureCookie[]; withCookies?: boolean; withTabs?: boolean; newPageIgnoresUrl?: boolean } = {}): FakeTarget {
  const log: string[] = [];
  const pages = new Map<number, FakePage>([[1, fakePage(log, "main", opts.exec)]]);
  let seq = 1;
  const target: FakeTarget = {
    log,
    pages,
    currentId: 1,
    cookiesSet: [],
    newPageArgs: [],
    async ensurePage() {
      return pages.get(target.currentId)!;
    },
    currentPage: () => pages.get(target.currentId) ?? null,
  };
  if (opts.withCookies !== false) {
    target.setCookies = async (cookies) => {
      log.push("cookies");
      target.cookiesSet.push(cookies);
    };
    target.getCookies = async (urls) => {
      log.push(`getCookies ${JSON.stringify(urls ?? null)}`);
      return opts.cookies ?? [];
    };
  }
  if (opts.withTabs !== false) {
    const info = (id: number, p: FakePage): BrowserTabInfo => ({ tabId: id, url: p.url, title: p.getTitle(), current: id === target.currentId });
    target.listPages = async () => [...pages].map(([id, p]) => info(id, p));
    target.selectPage = async (id) => {
      log.push(`select ${id}`);
      if (!pages.has(id)) return false;
      target.currentId = id;
      return true;
    };
    target.closePage = async (id) => {
      log.push(`close ${id}`);
      const existed = pages.delete(id);
      if (existed && target.currentId === id) target.currentId = [...pages.keys()].pop() ?? 0;
      return existed;
    };
    target.newPage = async (url) => {
      seq += 1;
      const p = fakePage(log, `tab${seq}`, opts.exec);
      pages.set(seq, p);
      target.currentId = seq;
      target.newPageArgs.push(url);
      // Like the desktop target: `url` is ignored when asked to.
      if (url && !opts.newPageIgnoresUrl) await p.loadURL(url);
      return info(seq, p);
    };
    target.pageHandles = async () => [...pages].map(([tabId, page]) => ({ tabId, page }));
  }
  return target;
}
