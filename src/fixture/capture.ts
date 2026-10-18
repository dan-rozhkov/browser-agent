// captureFixture: read the state of a live browser as a PageFixture. The
// result is for the host only: it holds cookie and storage values.
// It captures storage, URL and tabs. The DOM and JS state of a page cannot be
// serialized, so a modal or a half-filled form is not part of it.
import type { BrowserPageHandle, BrowserTarget } from "../controller/controller.js";
import { httpOrigin, redactUrls, runScript, toMessage, withTimeout } from "./util.js";
import type { FixtureCaptureOptions, FixtureCaptureResult, FixtureCookie, FixtureOrigin, PageFixture } from "./types.js";

const READ_STORAGE_JS = `(() => {
  const dump = (store) => { const out = {}; for (let i = 0; i < store.length; i++) { const k = store.key(i); out[k] = store.getItem(k); } return out; };
  try { return JSON.stringify({ ok: true, localStorage: dump(localStorage), sessionStorage: dump(sessionStorage) }); }
  catch { return JSON.stringify({ ok: false }); }
})()`;

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v;
  }
  return out;
}

export async function readStorage(page: BrowserPageHandle): Promise<{ localStorage: Record<string, string>; sessionStorage: Record<string, string> } | null> {
  try {
    const rec = await runScript(page, READ_STORAGE_JS);
    if (rec.ok !== true) return null;
    return { localStorage: stringRecord(rec.localStorage), sessionStorage: stringRecord(rec.sessionStorage) };
  } catch {
    return null;
  }
}

/** What `readBaseState` found. Never holds an error text: the caller decides what a failure means. */
export interface BaseState {
  cookies: FixtureCookie[];
  origins: FixtureOrigin[];
  /** `getCookies` threw or timed out. `cookies` is then empty. */
  cookieError?: unknown;
  /** The current page's origin is wanted, and the page did not answer the storage read. */
  currentReadFailed: boolean;
}

export interface ReadBaseStateOptions {
  /** Bound for the `getCookies` call. Default: none (the caller's command budget bounds it). */
  cookieTimeoutMs?: number;
}

function safeOrigin(page: BrowserPageHandle): string | undefined {
  try {
    return httpOrigin(page.getURL());
  } catch {
    return undefined;
  }
}

/**
 * The ONE reader of cookies and per-origin storage, shared by `captureFixture`
 * and the checkpoint journal. `origins` limits both; `undefined` means no limit
 * (every open tab's origin, every cookie `getCookies(undefined)` returns). An
 * EMPTY array asks for no origin at all: no cookies and no storage (and
 * `getCookies([])` is never called: a target may read it as "every cookie").
 * The current page is read first (sessionStorage is per tab, so another tab on
 * the same origin holds another one); other origins come from the other tabs.
 * An origin without storage is left out.
 */
export async function readBaseState(
  target: BrowserTarget,
  current: BrowserPageHandle,
  origins?: string[],
  opts: ReadBaseStateOptions = {},
): Promise<BaseState> {
  const state: BaseState = { cookies: [], origins: [], currentReadFailed: false };
  if (origins !== undefined && origins.length === 0) return state;
  const wanted = origins ? new Set(origins.map((o) => httpOrigin(o) ?? o)) : undefined;

  if (target.getCookies) {
    try {
      const read = target.getCookies(origins);
      state.cookies = opts.cookieTimeoutMs === undefined ? await read : await withTimeout(read, opts.cookieTimeoutMs, "the read timed out");
    } catch (err) {
      state.cookieError = err;
    }
  }

  const seen = new Set<string>();
  const add = async (page: BrowserPageHandle, origin: string): Promise<boolean> => {
    const storage = await readStorage(page);
    if (!storage) return false;
    const local = Object.keys(storage.localStorage).length > 0;
    const session = Object.keys(storage.sessionStorage).length > 0;
    if (local || session) {
      state.origins.push({ origin, ...(local ? { localStorage: storage.localStorage } : {}), ...(session ? { sessionStorage: storage.sessionStorage } : {}) });
    }
    return true;
  };

  const currentOrigin = safeOrigin(current);
  if (currentOrigin && (!wanted || wanted.has(currentOrigin))) {
    seen.add(currentOrigin);
    if (!(await add(current, currentOrigin))) state.currentReadFailed = true;
  }
  let handles: { page: BrowserPageHandle }[] = [];
  if (target.pageHandles) {
    try {
      handles = await target.pageHandles();
    } catch {
      handles = [];
    }
  }
  for (const { page } of handles) {
    if (page === current) continue;
    const origin = safeOrigin(page);
    if (!origin || seen.has(origin) || (wanted && !wanted.has(origin))) continue;
    seen.add(origin);
    // Another tab that does not answer is skipped.
    await add(page, origin);
  }
  return state;
}

/**
 * Capture cookies (when the target has `getCookies`), local and session
 * storage of the current page's origin and of every open tab's origin (when
 * the target lists its pages), the current tab's URL, and the other tabs' URLs.
 * `origins` limits cookies and storage to those origins.
 */
export async function captureFixture(target: BrowserTarget, opts: FixtureCaptureOptions = {}): Promise<FixtureCaptureResult> {
  try {
    const current = target.currentPage();
    if (!current) return { ok: false, error: "no open page to capture" };
    const fixture: PageFixture = { version: 1 };

    const tabInfos = target.listPages ? await target.listPages() : [];
    const currentUrl = tabInfos.find((t) => t.current)?.url ?? current.getURL();
    if (httpOrigin(currentUrl)) fixture.url = currentUrl;
    const others = tabInfos.filter((t) => !t.current && httpOrigin(t.url)).map((t) => t.url);
    if (others.length > 0) fixture.tabs = others;

    const state = await readBaseState(target, current, opts.origins);
    if (state.cookieError !== undefined) throw state.cookieError;
    if (state.cookies.length > 0) fixture.storage = { cookies: state.cookies };
    if (state.origins.length > 0) fixture.storage = { ...fixture.storage, origins: state.origins };
    // The host knows which emulation is active (the controller passes it): a resumed run gets the same device.
    if (opts.emulate) fixture.emulate = structuredClone(opts.emulate);
    return { ok: true, fixture };
  } catch (err) {
    return { ok: false, error: redactUrls(`capturing the fixture failed: ${toMessage(err)}`) };
  }
}
