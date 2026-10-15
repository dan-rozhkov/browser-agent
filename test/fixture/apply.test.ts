import { describe, expect, it, vi } from "vitest";
import { applyFixture, fixtureBudgetMs } from "../../src/fixture/apply.js";
import type { PageFixture } from "../../src/fixture/types.js";
import { fakePage, fakeTarget } from "./fakes.js";

const SECRET = "s3cr3t-value-XYZ";
const OK = JSON.stringify({ ok: true, found: true });

describe("applyFixture", () => {
  it("applies in order: cookies, storage per origin, url, tabs, steps", async () => {
    const target = fakeTarget();
    const fixture: PageFixture = {
      version: 1,
      url: "https://a.test/home",
      tabs: ["https://b.test/", "https://c.test/"],
      storage: {
        cookies: [{ name: "sid", value: "v", domain: "a.test" }],
        origins: [
          { origin: "https://a.test", localStorage: { k: "v" } },
          { origin: "https://z.test/", sessionStorage: { s: "t" } },
        ],
      },
      steps: [{ action: "click", selector: "#go" }],
    };
    const r = await applyFixture(target, fixture);
    expect(r).toEqual({
      ok: true,
      url: "https://a.test/home",
      title: "title of https://a.test/home",
      summary: "start page https://a.test/home; 1 cookie; storage for 2 origins; 2 extra tabs; 1 setup step",
    });
    expect(target.log).toEqual([
      "cookies",
      "main: load https://a.test/",
      "main: js",
      "main: load https://z.test/",
      "main: js",
      "main: load https://a.test/home",
      "tab2: load https://b.test/",
      "tab3: load https://c.test/",
      "select 1",
      "main: js",
    ]);
    // The main tab is current again after the extra tabs opened.
    expect(target.currentId).toBe(1);
    expect(target.cookiesSet).toEqual([[{ name: "sid", value: "v", domain: "a.test" }]]);
  });

  it("writes localStorage and sessionStorage with the given pairs", async () => {
    const scripts: string[] = [];
    const target = fakeTarget({ exec: (code) => (scripts.push(code), OK) });
    await applyFixture(target, {
      version: 1,
      storage: { origins: [{ origin: "https://a.test", localStorage: { "k\"1": "v " }, sessionStorage: { s: "t" } }] },
    });
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('{"k\\"1":"v\\u2028"}');
    expect(scripts[0]).not.toContain(" ");
    expect(scripts[0]).toContain('{"s":"t"}');
  });

  it("fails clearly when cookies are given but the target cannot set them", async () => {
    const target = fakeTarget({ withCookies: false });
    const r = await applyFixture(target, { version: 1, storage: { cookies: [{ name: "a", value: SECRET, domain: "a.test" }] } });
    expect(r).toEqual({ ok: false, error: "this browser target cannot set cookies (setCookies is missing)" });
    expect(target.log).toEqual([]);
  });

  it("fails clearly when tabs are given but the target cannot open them", async () => {
    const r = await applyFixture(fakeTarget({ withTabs: false }), { version: 1, tabs: ["https://b.test/"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("cannot open extra tabs");
  });

  it("rejects network mocks", async () => {
    const target = fakeTarget();
    const r = await applyFixture(target, { version: 1, network: [{ url: "x" }] });
    expect(r).toEqual({ ok: false, error: "PageFixture.network is not supported yet" });
    expect(target.log).toEqual([]);
  });

  it("accepts an empty network list", async () => {
    const r = await applyFixture(fakeTarget(), { version: 1, network: [] });
    expect(r.ok).toBe(true);
  });

  it("rejects an invalid fixture with the parse error", async () => {
    const r = await applyFixture(fakeTarget(), { version: 2 } as never);
    expect(r).toEqual({ ok: false, error: "fixture.version must be 1" });
  });

  it("reports a failed step as `step N (<action> <selector>) failed: <reason>` and stops", async () => {
    const target = fakeTarget({
      exec: (code) => (code.includes("#missing") ? JSON.stringify({ ok: false, error: "element not found" }) : OK),
    });
    const r = await applyFixture(target, {
      version: 1,
      steps: [
        { action: "click", selector: "#a" },
        { action: "click", selector: "#missing" },
        { action: "click", selector: "#never" },
      ],
    });
    expect(r).toEqual({ ok: false, error: "step 2 (click #missing) failed: element not found" });
    expect(target.log.filter((l) => l.endsWith("js"))).toHaveLength(2);
  });

  it("a type step failure names the selector, never the text", async () => {
    const target = fakeTarget({ exec: () => JSON.stringify({ ok: false, error: "element not found" }) });
    const r = await applyFixture(target, { version: 1, steps: [{ action: "type", selector: "#pw", text: SECRET }] });
    expect(r).toEqual({ ok: false, error: "step 1 (type #pw) failed: element not found" });
  });

  it("does not repeat a page error message that may quote storage data", async () => {
    const target = fakeTarget({ exec: () => JSON.stringify({ ok: false, name: "QuotaExceededError", message: `Setting the value of '${SECRET}' exceeded the quota` }) });
    const r = await applyFixture(target, { version: 1, storage: { origins: [{ origin: "https://a.test", localStorage: { [SECRET]: SECRET } }] } });
    expect(r).toEqual({ ok: false, error: "storage origin 1: writing storage failed (QuotaExceededError)" });
  });

  it("does not repeat a thrown script or cookie error", async () => {
    const throwing = fakeTarget({ exec: () => { throw new Error(`boom ${SECRET}`); } });
    const r1 = await applyFixture(throwing, { version: 1, storage: { origins: [{ origin: "https://a.test", localStorage: { k: SECRET } }] } });
    expect(JSON.stringify(r1)).not.toContain(SECRET);
    expect(r1.ok).toBe(false);

    const cookies = fakeTarget();
    cookies.setCookies = async () => { throw new Error(`bad cookie ${SECRET}`); };
    const r2 = await applyFixture(cookies, { version: 1, storage: { cookies: [{ name: "a", value: SECRET, domain: "a.test" }] } });
    expect(r2).toEqual({ ok: false, error: "setting cookies failed" });
  });

  it("fails when the origin redirects elsewhere", async () => {
    const target = fakeTarget();
    target.pages.get(1)!.loadURL = async () => { target.pages.get(1)!.url = "https://other.test/"; };
    const r = await applyFixture(target, { version: 1, storage: { origins: [{ origin: "https://a.test", localStorage: { k: "v" } }] } });
    expect(r).toEqual({ ok: false, error: "storage origin 1: the page redirected to another origin" });
  });

  it("fails when the start page does not load", async () => {
    const target = fakeTarget();
    target.pages.get(1)!.loadURL = async () => { throw new Error("ERR_NAME_NOT_RESOLVED"); };
    const r = await applyFixture(target, { version: 1, url: "https://a.test/" });
    expect(r).toEqual({ ok: false, error: "start page: loading failed: ERR_NAME_NOT_RESOLVED" });
  });

  it("a goto step loads the URL", async () => {
    const target = fakeTarget();
    const r = await applyFixture(target, { version: 1, steps: [{ action: "goto", url: "https://a.test/next" }] });
    expect(r.ok && r.url).toBe("https://a.test/next");
  });

  it("press sends trusted CDP key events with the key's modifiers", async () => {
    const target = fakeTarget();
    const r = await applyFixture(target, { version: 1, steps: [{ action: "press", key: "Enter", selector: "input" }] });
    expect(r.ok).toBe(true);
    const keys = target.pages.get(1)!.keys;
    expect(keys.map((k) => k.params?.type)).toEqual(["keyDown", "keyUp"]);
    expect(keys[0].params).toMatchObject({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0 });
    // The selector was focused first.
    expect(target.log.filter((l) => l.endsWith("js"))).toHaveLength(1);
  });

  it("press falls back to a KeyboardEvent script without a CDP session", async () => {
    const scripts: string[] = [];
    const log: string[] = [];
    const page = fakePage(log, "main", (code) => (scripts.push(code), OK), false);
    const target = fakeTarget();
    target.pages.set(1, page);
    const r = await applyFixture(target, { version: 1, steps: [{ action: "press", key: "Escape" }] });
    expect(r.ok).toBe(true);
    expect(scripts[0]).toContain('new KeyboardEvent("keydown"');
    expect(scripts[0]).toContain('key: "Escape"');
  });

  it("press fails on an unknown key", async () => {
    const r = await applyFixture(fakeTarget(), { version: 1, steps: [{ action: "press", key: "NoSuchKey" }] });
    expect(r).toEqual({ ok: false, error: "step 1 (press NoSuchKey) failed: unsupported key" });
  });

  it("waitFor polls until the selector appears", async () => {
    let calls = 0;
    const target = fakeTarget({ exec: () => JSON.stringify({ ok: true, found: ++calls >= 3 }) });
    const r = await applyFixture(target, { version: 1, steps: [{ action: "waitFor", selector: ".ready", timeoutMs: 2000 }] });
    expect(r.ok).toBe(true);
    expect(calls).toBe(3);
  });

  it("waitFor times out", async () => {
    const target = fakeTarget({ exec: () => JSON.stringify({ ok: true, found: false }) });
    const r = await applyFixture(target, { version: 1, steps: [{ action: "waitFor", selector: ".ready", timeoutMs: 150 }] });
    expect(r).toEqual({ ok: false, error: "step 1 (waitFor .ready) failed: timed out after 150ms" });
  });

  it("a wait step sleeps", async () => {
    const t0 = Date.now();
    const r = await applyFixture(fakeTarget(), { version: 1, steps: [{ action: "wait", ms: 60 }] });
    expect(r.ok).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
  });

  it("honors the abort signal between steps and during a wait", async () => {
    const ctl = new AbortController();
    const target = fakeTarget({ exec: () => { ctl.abort(); return OK; } });
    const r = await applyFixture(target, { version: 1, steps: [{ action: "click", selector: "#a" }, { action: "click", selector: "#b" }] }, { signal: ctl.signal });
    expect(r).toEqual({ ok: false, error: "aborted" });
    expect(target.log.filter((l) => l.endsWith("js"))).toHaveLength(1);

    const ctl2 = new AbortController();
    setTimeout(() => ctl2.abort(), 20);
    const t0 = Date.now();
    const r2 = await applyFixture(fakeTarget(), { version: 1, steps: [{ action: "wait", ms: 10_000 }] }, { signal: ctl2.signal });
    expect(r2).toEqual({ ok: false, error: "aborted" });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("an already aborted signal does nothing", async () => {
    const target = fakeTarget();
    const r = await applyFixture(target, { version: 1, url: "https://a.test/" }, { signal: AbortSignal.abort() });
    expect(r).toEqual({ ok: false, error: "aborted" });
    expect(target.log).toEqual([]);
  });

  it("the summary holds counts only", async () => {
    const r = await applyFixture(fakeTarget(), {
      version: 1,
      storage: {
        cookies: [{ name: SECRET, value: SECRET, domain: "a.test" }],
        origins: [{ origin: "https://a.test", localStorage: { [SECRET]: SECRET } }],
      },
    });
    expect(r.ok && r.summary).toBe("1 cookie; storage for 1 origin");
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});

describe("applyFixture review fixes", () => {
  const TOKEN = "TOKEN-SECRET-123";

  it("standalone: never passes a url to newPage, loads it on the new tab, and reports a load failure", async () => {
    const target = fakeTarget({ newPageIgnoresUrl: true });
    const r = await applyFixture(target, { version: 1, tabs: ["https://b.test/x"] });
    expect(r.ok).toBe(true);
    expect(target.newPageArgs).toEqual([undefined]);
    expect(target.log).toContain("tab2: load https://b.test/x");
    expect(target.currentId).toBe(1);

    const failing = fakeTarget({ newPageIgnoresUrl: true });
    const origNew = failing.newPage!;
    failing.newPage = async (url) => {
      const info = await origNew(url);
      failing.pages.get(info.tabId)!.loadURL = async () => { throw new Error("ERR_CONNECTION_REFUSED"); };
      return info;
    };
    const r2 = await applyFixture(failing, { version: 1, tabs: ["https://b.test/x"] });
    expect(r2).toEqual({ ok: false, error: "extra tab 1: loading failed: ERR_CONNECTION_REFUSED" });
  });

  it("default press skips text and sends the editing command for a Ctrl/Meta combo", async () => {
    const target = fakeTarget();
    await applyFixture(target, { version: 1, steps: [{ action: "press", key: "Ctrl+a" }, { action: "press", key: "a" }] });
    const keys = target.pages.get(1)!.keys;
    expect(keys[0].params).toMatchObject({ type: "rawKeyDown", key: "a", modifiers: 2, text: undefined, commands: ["selectAll"] });
    expect(keys[2].params).toMatchObject({ type: "keyDown", text: "a", modifiers: 0 });
  });

  it("press accepts a lone space", async () => {
    const target = fakeTarget();
    const r = await applyFixture(target, { version: 1, steps: [{ action: "press", key: " " }] });
    expect(r.ok).toBe(true);
    expect(target.pages.get(1)!.keys[0].params).toMatchObject({ key: " ", code: "Space", text: " " });
  });

  it("waitFor retries when the script rejects (context destroyed by a navigation)", async () => {
    let calls = 0;
    const target = fakeTarget({
      exec: () => {
        calls += 1;
        if (calls < 3) throw new Error("Execution context was destroyed");
        return JSON.stringify({ ok: true, found: true });
      },
    });
    const r = await applyFixture(target, { version: 1, steps: [{ action: "waitFor", selector: ".x", timeoutMs: 2000 }] });
    expect(r.ok).toBe(true);
    expect(calls).toBe(3);
  });

  it("waitFor that only ever rejects ends at its deadline with a timeout", async () => {
    const target = fakeTarget({ exec: () => { throw new Error("gone"); } });
    const r = await applyFixture(target, { version: 1, steps: [{ action: "waitFor", selector: ".x", timeoutMs: 200 }] });
    expect(r).toEqual({ ok: false, error: "step 1 (waitFor .x) failed: timed out after 200ms" });
  });

  it("a page script that never answers fails the step instead of hanging", async () => {
    vi.useFakeTimers();
    try {
      const target = fakeTarget({ exec: () => new Promise(() => {}) });
      const run = applyFixture(target, { version: 1, steps: [{ action: "click", selector: "#a" }] });
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await run).toEqual({ ok: false, error: "step 1 (click #a) failed: the page script failed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("no URL query or hash reaches the summary or an error", async () => {
    const url = `https://a.test/p?token=${TOKEN}#${TOKEN}`;
    const ok = await applyFixture(fakeTarget(), { version: 1, url, steps: [{ action: "goto", url }] });
    expect(ok.ok && ok.summary).toBe("start page https://a.test/p; 1 setup step");
    expect(JSON.stringify(ok.ok ? ok.summary : ok)).not.toContain(TOKEN);

    const bad = fakeTarget();
    bad.pages.get(1)!.loadURL = async () => { throw new Error(`net::ERR_FAILED at ${url}`); };
    const r1 = await applyFixture(bad, { version: 1, steps: [{ action: "goto", url }] });
    expect(r1.ok).toBe(false);
    expect(JSON.stringify(r1)).not.toContain(TOKEN);
    expect(!r1.ok && r1.error).toContain("https://a.test/p");
    const r2 = await applyFixture(bad, { version: 1, url });
    expect(JSON.stringify(r2)).not.toContain(TOKEN);
  });

  it("fixtureBudgetMs sums loads, waits and scripts, and is capped", () => {
    expect(fixtureBudgetMs({ version: 1 })).toBe(10_000);
    expect(fixtureBudgetMs({ version: 1, url: "https://a.test/", steps: [{ action: "wait", ms: 1000 }, { action: "click", selector: "a" }] })).toBe(30_000 + 10_000 + 1000 + 10_000 + 10_000);
    expect(fixtureBudgetMs({ version: 1, steps: Array.from({ length: 50 }, () => ({ action: "goto" as const, url: "https://a.test/" })) })).toBe(300_000);
  });
});
