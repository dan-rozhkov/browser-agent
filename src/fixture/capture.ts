// captureFixture: read the state of a live browser as a PageFixture. The
// result is for the host only: it holds cookie and storage values.
// It captures storage, URL and tabs. The DOM and JS state of a page cannot be
// serialized, so a modal or a half-filled form is not part of it.
import type { BrowserPageHandle, BrowserTarget } from "../controller/controller.js";
import { httpOrigin, redactUrls, runScript, toMessage } from "./util.js";
import type { FixtureCaptureOptions, FixtureCaptureResult, FixtureOrigin, PageFixture } from "./types.js";

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

async function readStorage(page: BrowserPageHandle): Promise<{ localStorage: Record<string, string>; sessionStorage: Record<string, string> } | null> {
  try {
    const rec = await runScript(page, READ_STORAGE_JS);
    if (rec.ok !== true) return null;
    return { localStorage: stringRecord(rec.localStorage), sessionStorage: stringRecord(rec.sessionStorage) };
  } catch {
    return null;
  }
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
    const wanted = opts.origins ? new Set(opts.origins.map((o) => httpOrigin(o) ?? o)) : undefined;
    // An empty filter asks for no origin at all: no cookies and no storage.
    const noOrigins = opts.origins !== undefined && opts.origins.length === 0;
    const fixture: PageFixture = { version: 1 };

    const tabInfos = target.listPages ? await target.listPages() : [];
    const currentUrl = tabInfos.find((t) => t.current)?.url ?? current.getURL();
    if (httpOrigin(currentUrl)) fixture.url = currentUrl;
    const others = tabInfos.filter((t) => !t.current && httpOrigin(t.url)).map((t) => t.url);
    if (others.length > 0) fixture.tabs = others;

    const cookies = target.getCookies && !noOrigins ? await target.getCookies(opts.origins) : [];
    if (cookies.length > 0) fixture.storage = { cookies };

    const handles = target.pageHandles && !noOrigins ? await target.pageHandles() : [];
    const pages = noOrigins ? [] : handles.length > 0 ? handles.map((h) => h.page) : [current];
    const seen = new Set<string>();
    const origins: FixtureOrigin[] = [];
    for (const page of pages) {
      const origin = httpOrigin(page.getURL());
      if (!origin || seen.has(origin) || (wanted && !wanted.has(origin))) continue;
      seen.add(origin);
      const storage = await readStorage(page);
      if (!storage) continue;
      if (Object.keys(storage.localStorage).length === 0 && Object.keys(storage.sessionStorage).length === 0) continue;
      origins.push({
        origin,
        ...(Object.keys(storage.localStorage).length > 0 ? { localStorage: storage.localStorage } : {}),
        ...(Object.keys(storage.sessionStorage).length > 0 ? { sessionStorage: storage.sessionStorage } : {}),
      });
    }
    if (origins.length > 0) fixture.storage = { ...fixture.storage, origins };
    return { ok: true, fixture };
  } catch (err) {
    return { ok: false, error: redactUrls(`capturing the fixture failed: ${toMessage(err)}`) };
  }
}
