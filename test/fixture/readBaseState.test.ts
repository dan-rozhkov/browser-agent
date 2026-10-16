import { describe, expect, it } from "vitest";
import { readBaseState } from "../../src/fixture/capture.js";
import { mergeStorage } from "../../src/fixture/checkpoint.js";
import { fakeTarget } from "./fakes.js";

const OTHER = "sentinel-cookie-of-another-origin-4b7";

function target() {
  const t = fakeTarget({ cookies: [{ name: "bank", value: OTHER, domain: "bank.test" }] });
  t.pages.get(1)!.url = "https://a.test/";
  const stores: Record<number, { local: Record<string, string>; session: Record<string, string> }> = { 1: { local: { k: "main" }, session: { s: "main-tab" } } };
  for (const [id, page] of t.pages) {
    page.executeJavaScript = async () => JSON.stringify({ ok: true, localStorage: stores[id]?.local ?? {}, sessionStorage: stores[id]?.session ?? {} });
  }
  return { t, stores };
}

describe("readBaseState", () => {
  it("origins [] reads nothing: no getCookies call (a target may read [] as every cookie), no storage", async () => {
    const { t } = target();
    const state = await readBaseState(t, t.pages.get(1)!, []);
    expect(state).toEqual({ cookies: [], origins: [], currentReadFailed: false });
    expect(t.log.some((l) => l.startsWith("getCookies"))).toBe(false);
    expect(t.log.some((l) => l.endsWith("js"))).toBe(false);
  });

  it("reads the current page first, then other tabs on other wanted origins; one entry per origin", async () => {
    const { t, stores } = target();
    await t.newPage!("https://b.test/x");
    stores[2] = { local: { b: "1" }, session: {} };
    t.pages.get(2)!.executeJavaScript = async () => JSON.stringify({ ok: true, localStorage: stores[2]!.local, sessionStorage: {} });
    // Another tab on the current origin holds another sessionStorage: it must not win.
    await t.newPage!("https://a.test/other");
    t.pages.get(3)!.executeJavaScript = async () => JSON.stringify({ ok: true, localStorage: { k: "other-tab" }, sessionStorage: { s: "other-tab" } });
    const state = await readBaseState(t, t.pages.get(1)!, ["https://a.test", "https://b.test"]);
    expect(state.origins).toEqual([
      { origin: "https://a.test", localStorage: { k: "main" }, sessionStorage: { s: "main-tab" } },
      { origin: "https://b.test", localStorage: { b: "1" } },
    ]);
    expect(t.log).toContain('getCookies ["https://a.test","https://b.test"]');
  });

  it("reports a cookie error and an unanswering current page without throwing", async () => {
    const { t } = target();
    t.getCookies = async () => {
      throw new Error("nope");
    };
    t.pages.get(1)!.executeJavaScript = async () => {
      throw new Error("page gone");
    };
    const state = await readBaseState(t, t.pages.get(1)!, ["https://a.test"]);
    expect(state.cookieError).toBeInstanceOf(Error);
    expect(state.currentReadFailed).toBe(true);
    expect(state.cookies).toEqual([]);
  });

  it("a cookie read that never answers is cut at cookieTimeoutMs", async () => {
    const { t } = target();
    t.getCookies = () => new Promise(() => {});
    const state = await readBaseState(t, t.pages.get(1)!, ["https://a.test"], { cookieTimeoutMs: 20 });
    expect(state.cookieError).toBeInstanceOf(Error);
  });
});

describe("mergeStorage", () => {
  it("the fixture wins per cookie (name + domain + path) and per storage key; the rest of the profile stays", () => {
    const merged = mergeStorage(
      {
        cookies: [{ name: "sid", value: "old", domain: "a.test", path: "/" }, { name: "sid", value: "other-path", domain: "a.test", path: "/x" }, { name: "keep", value: "k", domain: "a.test" }],
        origins: [{ origin: "https://a.test", localStorage: { a: "old", b: "keep" }, sessionStorage: { s: "keep" } }, { origin: "https://z.test", localStorage: { z: "1" } }],
      },
      { cookies: [{ name: "sid", value: "new", domain: "a.test", path: "/" }], origins: [{ origin: "https://a.test", localStorage: { a: "new", c: "add" } }] },
    );
    expect(merged.cookies).toEqual([
      { name: "sid", value: "new", domain: "a.test", path: "/" },
      { name: "sid", value: "other-path", domain: "a.test", path: "/x" },
      { name: "keep", value: "k", domain: "a.test" },
    ]);
    expect(merged.origins).toEqual([
      { origin: "https://a.test", localStorage: { a: "new", b: "keep", c: "add" }, sessionStorage: { s: "keep" } },
      { origin: "https://z.test", localStorage: { z: "1" } },
    ]);
  });

  it("a host-only cookie and a .domain cookie of the same name and path are two cookies (the leading dot counts)", () => {
    const hostOnly = { name: "sid", value: "host", domain: "a.test", path: "/" };
    const dotted = { name: "sid", value: "dot", domain: ".a.test", path: "/" };
    // The fixture's host-only cookie must not replace the profile's .domain one, nor the other way round.
    expect(mergeStorage({ cookies: [dotted], origins: [] }, { cookies: [hostOnly] }).cookies).toEqual([dotted, hostOnly]);
    expect(mergeStorage({ cookies: [hostOnly], origins: [] }, { cookies: [dotted] }).cookies).toEqual([hostOnly, dotted]);
    // The same exact form still replaces; case does not matter; a url-only cookie is host-only.
    expect(mergeStorage({ cookies: [{ ...dotted }], origins: [] }, { cookies: [{ ...dotted, value: "new", domain: ".A.test" }] }).cookies).toEqual([{ ...dotted, value: "new", domain: ".A.test" }]);
    const byUrl = { name: "sid", value: "url", url: "https://a.test/" };
    expect(mergeStorage({ cookies: [hostOnly], origins: [] }, { cookies: [byUrl] }).cookies).toEqual([byUrl]);
  });

  it("no pre-apply state: just the fixture's storage", () => {
    expect(mergeStorage({ cookies: [], origins: [] }, undefined)).toEqual({ cookies: [], origins: [] });
  });
});
