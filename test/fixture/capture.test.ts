import { describe, expect, it, vi } from "vitest";
import { captureFixture } from "../../src/fixture/capture.js";
import { fakeTarget } from "./fakes.js";

const SECRET = "s3cr3t-value-XYZ";
const storageFor = (url: string) =>
  JSON.stringify({
    ok: true,
    localStorage: url.startsWith("https://a.test") ? { token: SECRET } : {},
    sessionStorage: url.startsWith("https://b.test") ? { s: "t" } : {},
  });

/** Answers the storage read of whichever page ran it. */
function target(opts: Parameters<typeof fakeTarget>[0] = {}) {
  const t = fakeTarget(opts);
  for (const page of t.pages.values()) page.executeJavaScript = async () => storageFor(page.url);
  return t;
}

describe("captureFixture", () => {
  it("captures cookies, storage, url and the other tabs", async () => {
    const t = target({ cookies: [{ name: "sid", value: "v", domain: "a.test", path: "/" }] });
    t.pages.get(1)!.url = "https://a.test/home";
    // A second tab opens and the first stays listed as the current one.
    t.currentId = 1;
    await t.newPage!("https://b.test/x");
    t.currentId = 1;
    t.pages.get(2)!.executeJavaScript = async () => storageFor("https://b.test/");
    const r = await captureFixture(t);
    expect(r).toEqual({
      ok: true,
      fixture: {
        version: 1,
        url: "https://a.test/home",
        tabs: ["https://b.test/x"],
        storage: {
          cookies: [{ name: "sid", value: "v", domain: "a.test", path: "/" }],
          origins: [
            { origin: "https://a.test", localStorage: { token: SECRET } },
            { origin: "https://b.test", sessionStorage: { s: "t" } },
          ],
        },
      },
    });
  });

  it("limits cookies and storage to the given origins", async () => {
    const t = target();
    t.pages.get(1)!.url = "https://a.test/";
    await t.newPage!("https://b.test/");
    t.currentId = 1;
    t.pages.get(2)!.executeJavaScript = async () => storageFor("https://b.test/");
    const r = await captureFixture(t, { origins: ["https://b.test/"] });
    expect(t.log).toContain('getCookies ["https://b.test/"]');
    expect(r.ok && r.fixture.storage?.origins).toEqual([{ origin: "https://b.test", sessionStorage: { s: "t" } }]);
  });

  it("works on a target without cookies or tab listing", async () => {
    const t = target({ withCookies: false, withTabs: false });
    t.pages.get(1)!.url = "https://a.test/";
    const r = await captureFixture(t);
    expect(r).toEqual({ ok: true, fixture: { version: 1, url: "https://a.test/", storage: { origins: [{ origin: "https://a.test", localStorage: { token: SECRET } }] } } });
  });

  it("skips pages that are not http(s) and pages whose storage cannot be read", async () => {
    const t = target();
    t.pages.get(1)!.url = "about:blank";
    expect(await captureFixture(t)).toEqual({ ok: true, fixture: { version: 1 } });
    t.pages.get(1)!.url = "https://a.test/";
    t.pages.get(1)!.executeJavaScript = async () => { throw new Error("denied"); };
    expect(await captureFixture(t)).toEqual({ ok: true, fixture: { version: 1, url: "https://a.test/" } });
  });

  it("fails when no page is open", async () => {
    const t = target();
    t.currentPage = () => null;
    expect(await captureFixture(t)).toEqual({ ok: false, error: "no open page to capture" });
  });

  it("a captured fixture applies again", async () => {
    const t = target({ cookies: [{ name: "sid", value: "v", domain: "a.test", path: "/", sameSite: "Lax" }] });
    t.pages.get(1)!.url = "https://a.test/home";
    const r = await captureFixture(t);
    expect(r.ok).toBe(true);
    const { parsePageFixture } = await import("../../src/fixture/parse.js");
    expect(parsePageFixture(r.ok && r.fixture).ok).toBe(true);
  });

  it("an empty origins filter returns no cookies and no storage and never asks for cookies", async () => {
    const t = target({ cookies: [{ name: "sid", value: "v", domain: "a.test" }] });
    t.pages.get(1)!.url = "https://a.test/";
    const r = await captureFixture(t, { origins: [] });
    expect(r).toEqual({ ok: true, fixture: { version: 1, url: "https://a.test/" } });
    expect(t.log.some((l) => l.startsWith("getCookies"))).toBe(false);
  });

  it("a storage read that never answers is skipped after the script timeout", async () => {
    vi.useFakeTimers();
    try {
      const t = target();
      t.pages.get(1)!.url = "https://a.test/";
      t.pages.get(1)!.executeJavaScript = () => new Promise(() => {});
      const run = captureFixture(t);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await run).toEqual({ ok: true, fixture: { version: 1, url: "https://a.test/" } });
    } finally {
      vi.useRealTimers();
    }
  });
});
