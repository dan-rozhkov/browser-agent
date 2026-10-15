import { describe, expect, it, vi } from "vitest";
import { BrowserController } from "../../src/controller/controller.js";
import { applyFixture, fixtureBudgetMs } from "../../src/fixture/apply.js";
import { parsePageFixture } from "../../src/fixture/parse.js";
import type { PageFixture } from "../../src/fixture/types.js";
import { fakeTarget } from "./fakes.js";

const SECRET = "qa-secret-sentinel-QQ";
const OK = JSON.stringify({ ok: true, found: true });
const allow = { allowNetworkMocks: true };

/** Answers the expect script with the given flags and every other script with success. */
function expectExec(flags: { selector?: boolean; text?: boolean; error?: string }) {
  return (code: string) => {
    if (!code.includes("getBoundingClientRect") && !code.includes("innerText")) return OK;
    if (flags.error) return JSON.stringify({ ok: false, error: flags.error });
    return JSON.stringify({ ok: true, ...(code.includes("getBoundingClientRect") ? { selector: flags.selector ?? true } : {}), ...(code.includes("innerText") ? { text: flags.text ?? true } : {}) });
  };
}

describe("parsePageFixture: expect, network, fresh", () => {
  it("accepts and copies the new fields", () => {
    const input = {
      version: 1,
      fresh: true,
      expect: { selector: "#ok", text: "Welcome", url: "https://a.test/*", timeoutMs: 1000, extra: 1 },
      network: [
        { url: "https://a.test/api*", method: "POST", status: 500, headers: { "x-a": "b" }, body: { e: 1 }, delayMs: 10, abort: false, times: 2, extra: 1 },
        { url: "https://a.test/s", body: "text" },
      ],
    };
    const r = parsePageFixture(input);
    expect(r).toEqual({
      ok: true,
      value: {
        version: 1,
        fresh: true,
        expect: { selector: "#ok", text: "Welcome", url: "https://a.test/*", timeoutMs: 1000 },
        network: [
          { url: "https://a.test/api*", method: "POST", status: 500, headers: { "x-a": "b" }, body: { e: 1 }, delayMs: 10, abort: false, times: 2 },
          { url: "https://a.test/s", body: "text" },
        ],
      },
    });
  });

  const bad: [string, unknown, string][] = [
    ["an empty expect", { version: 1, expect: {} }, "fixture.expect needs selector, text or url"],
    ["an expect with only a timeout", { version: 1, expect: { timeoutMs: 10 } }, "fixture.expect needs selector, text or url"],
    ["a long expect timeout", { version: 1, expect: { text: "a", timeoutMs: 30001 } }, "fixture.expect.timeoutMs must be between 0 and 30000"],
    ["an empty expect text", { version: 1, expect: { text: " " } }, "fixture.expect.text must not be empty"],
    ["a non-boolean fresh", { version: 1, fresh: "yes" }, "fixture.fresh must be a boolean"],
    ["a rule without url", { version: 1, network: [{ status: 200 }] }, "fixture.network[0].url must be a string"],
    ["a non-object rule", { version: 1, network: ["x"] }, "fixture.network[0] must be an object"],
    ["a bad status", { version: 1, network: [{ url: "x", status: 199 }] }, "fixture.network[0].status must be an integer between 200 and 599"],
    ["a fractional status", { version: 1, network: [{ url: "x", status: 200.5 }] }, "fixture.network[0].status must be an integer"],
    ["a long delay", { version: 1, network: [{ url: "x", delayMs: 30001 }] }, "fixture.network[0].delayMs must be between 0 and 30000"],
    ["zero times", { version: 1, network: [{ url: "x", times: 0 }] }, "fixture.network[0].times must be an integer"],
    ["a number body", { version: 1, network: [{ url: "x", body: 5 }] }, "fixture.network[0].body must be a string or an object"],
    ["a non-string header", { version: 1, network: [{ url: "x", headers: { a: 1 } }] }, "fixture.network[0].headers must map strings to strings"],
    ["a header name with a space", { version: 1, network: [{ url: "x", headers: { "a b": "c" } }] }, "fixture.network[0].headers[0] has an invalid header name"],
    ["a header name with a colon", { version: 1, network: [{ url: "x", headers: { ok: "1", "a:b": "c" } }] }, "fixture.network[0].headers[1] has an invalid header name"],
    ["an empty header name", { version: 1, network: [{ url: "x", headers: { "": "c" } }] }, "fixture.network[0].headers[0] has an invalid header name"],
    ["a header value with CRLF", { version: 1, network: [{ url: "x", headers: { a: "b\r\nSet-Cookie: x=1" } }] }, "fixture.network[0].headers[0] has a header value with a line break"],
    ["a non-boolean abort", { version: 1, network: [{ url: "x", abort: 1 }] }, "fixture.network[0].abort must be a boolean"],
  ];
  for (const [name, input, message] of bad) {
    it(`rejects ${name}`, () => {
      const r = parsePageFixture(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(message);
    });
  }

  it("a header error names the index, never the name or the value", () => {
    const r = parsePageFixture({ version: 1, network: [{ url: "x", headers: { [`bad name ${SECRET}`]: "v" } }] });
    const r2 = parsePageFixture({ version: 1, network: [{ url: "x", headers: { ok: `v\n${SECRET}` } }] });
    for (const x of [r, r2]) {
      expect(x.ok).toBe(false);
      if (!x.ok) expect(x.error).not.toContain(SECRET);
    }
  });

  it("a parse error never repeats a header value or a body", () => {
    const r = parsePageFixture({ version: 1, network: [{ url: "x", headers: { [`h-${SECRET}`]: 3 }, body: `b-${SECRET}` }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain(SECRET);
  });
});

describe("applyFixture: fresh, network, order", () => {
  it("runs reset, then network, then cookies, then the start page, then expect", async () => {
    const target = fakeTarget({ withNetwork: true, withReset: true, exec: expectExec({}) });
    const r = await applyFixture(
      target,
      {
        version: 1,
        fresh: true,
        url: "https://a.test/home",
        network: [{ url: "https://api.a.test/*", status: 500 }],
        storage: { cookies: [{ name: "sid", value: "v", domain: "a.test" }] },
        expect: { selector: "#ok" },
      },
      allow,
    );
    expect(r.ok).toBe(true);
    expect(target.log.slice(0, 4)).toEqual(["reset", "route", "cookies", "main: load https://a.test/home"]);
    expect(target.log.at(-1)).toBe("main: js");
    if (r.ok) {
      expect(r.summary).toBe("start page https://a.test/home; 1 cookie; 1 network mock; fresh session; expect checked");
      expect(typeof r.release).toBe("function");
    }
  });

  it("installs a handler that answers by the rules", async () => {
    const target = fakeTarget({ withNetwork: true });
    await applyFixture(target, { version: 1, network: [{ url: "https://api.a.test/cart*", method: "GET", status: 418, body: { a: 1 }, times: 1 }] }, allow);
    expect(target.handler!({ url: "https://api.a.test/cart?x=1", method: "get" })).toEqual({ status: 418, headers: { "content-type": "application/json" }, body: '{"a":1}' });
    expect(target.handler!({ url: "https://api.a.test/cart", method: "GET" })).toBeUndefined();
  });

  it("release removes the mocks once, however often it is called", async () => {
    const target = fakeTarget({ withNetwork: true });
    const r = await applyFixture(target, { version: 1, network: [{ url: "x" }] }, allow);
    if (!r.ok || !r.release) throw new Error("expected a release");
    await Promise.all([r.release(), r.release()]);
    await r.release();
    expect(target.unrouted).toBe(1);
  });

  it("a fixture without mocks has no release", async () => {
    const r = await applyFixture(fakeTarget(), { version: 1, url: "https://a.test/" });
    expect(r.ok && "release" in r).toBe(false);
    const empty = await applyFixture(fakeTarget({ withNetwork: true }), { version: 1, network: [] }, allow);
    expect(empty.ok && "release" in empty).toBe(false);
  });

  const refusals: [string, ReturnType<typeof fakeTarget>, PageFixture, object, string, string][] = [
    ["the gate is off", fakeTarget({ withNetwork: true }), { version: 1, network: [{ url: "x" }] }, {}, "network", "network mocks are disabled (allowNetworkMocks is off)"],
    ["the gate is false", fakeTarget({ withNetwork: true }), { version: 1, network: [{ url: "x" }] }, { allowNetworkMocks: false }, "network", "network mocks are disabled (allowNetworkMocks is off)"],
    ["the target cannot route", fakeTarget(), { version: 1, network: [{ url: "x" }] }, allow, "network", "this browser cannot mock network requests"],
    ["the target cannot reset", fakeTarget(), { version: 1, fresh: true }, allow, "reset", "this browser cannot reset its session"],
  ];
  for (const [name, target, fixture, opts, stage, error] of refusals) {
    it(`fails with stage ${stage} when ${name}, before anything changes`, async () => {
      expect(await applyFixture(target, fixture, opts)).toEqual({ ok: false, stage, error });
      expect(target.log).toEqual([]);
    });
  }

  it("a refusal late in the order leaves nothing changed: fresh is not run when the gate is off", async () => {
    const target = fakeTarget({ withReset: true, withNetwork: true });
    const r = await applyFixture(target, { version: 1, fresh: true, network: [{ url: "x" }] });
    expect(r).toMatchObject({ ok: false, stage: "network" });
    expect(target.log).toEqual([]);
  });

  it("a failing reset has stage reset and installs no mocks", async () => {
    const target = fakeTarget({ withNetwork: true, withReset: true });
    target.resetSession = async () => { throw new Error("cdp closed"); };
    const r = await applyFixture(target, { version: 1, fresh: true, network: [{ url: "x" }] }, allow);
    expect(r).toEqual({ ok: false, stage: "reset", error: "resetting the session failed: cdp closed" });
    expect(target.log).toEqual([]);
  });

  it("a failing install is reported without the target's text (it may quote a rule)", async () => {
    const target = fakeTarget({ withNetwork: true });
    target.routeRequests = async () => { throw new Error(`bad pattern ${SECRET}`); };
    const r = await applyFixture(target, { version: 1, network: [{ url: "x" }] }, allow);
    expect(r).toEqual({ ok: false, stage: "network", error: "installing network mocks failed" });
  });

  it("removes the mocks when a later stage fails", async () => {
    const target = fakeTarget({ withNetwork: true, exec: () => JSON.stringify({ ok: false, error: "element not found" }) });
    const r = await applyFixture(target, { version: 1, network: [{ url: "x" }], steps: [{ action: "click", selector: "#a" }] }, allow);
    expect(r).toMatchObject({ ok: false, stage: "steps" });
    expect("release" in r).toBe(false);
    expect(target.log).toContain("unroute");
    expect(target.unrouted).toBe(1);
  });

  it("removes the mocks when the apply is aborted", async () => {
    const ctl = new AbortController();
    const target = fakeTarget({ withNetwork: true });
    const route = target.routeRequests!;
    target.routeRequests = async (h) => { const remove = await route(h); ctl.abort(); return remove; };
    const r = await applyFixture(target, { version: 1, network: [{ url: "x" }], url: "https://a.test/" }, { ...allow, signal: ctl.signal });
    expect(r).toMatchObject({ ok: false, stage: "network", error: "aborted" });
    expect(target.unrouted).toBe(1);
  });

  it("removes the mocks when the expect fails", async () => {
    const target = fakeTarget({ withNetwork: true, exec: expectExec({ selector: false }) });
    const r = await applyFixture(target, { version: 1, network: [{ url: "x" }], expect: { selector: "#x", timeoutMs: 0 } }, allow);
    expect(r).toMatchObject({ ok: false, stage: "expect" });
    expect(target.unrouted).toBe(1);
  });
});

describe("applyFixture: fresh passes the fixture's own origins", () => {
  it("collects url, tabs, storage origins and goto steps (http(s) only, once each)", async () => {
    const target = fakeTarget({ withReset: true, exec: expectExec({}) });
    await applyFixture(target, {
      version: 1,
      fresh: true,
      url: "https://a.test/home?x=1",
      tabs: ["https://b.test/p", "https://a.test/other"],
      storage: { origins: [{ origin: "https://c.test", localStorage: { k: "v" } }] },
      steps: [{ action: "goto", url: "http://d.test:81/z" }],
    });
    expect(target.resetArgs).toEqual([["https://a.test", "https://b.test", "https://c.test", "http://d.test:81"]]);
  });

  it("budgets fresh as one navigation plus a fixed reset budget", () => {
    expect(fixtureBudgetMs({ version: 1, fresh: true }) - fixtureBudgetMs({ version: 1 })).toBe(30_000 + 15_000);
  });
});

describe("stage prepare", () => {
  it("an expect URL pattern is normalized like a network one (case and bare origin)", async () => {
    const target = fakeTarget({ exec: expectExec({}) });
    target.pages.get(1)!.url = "https://a.test/";
    expect((await applyFixture(target, { version: 1, expect: { url: "HTTPS://A.test", timeoutMs: 0 } })).ok).toBe(true);
  });

  it("an abort between the prechecks and the first feature reports prepare", async () => {
    const ctl = new AbortController();
    const target = fakeTarget({ withNetwork: true });
    // The last precheck looks at `newPage`; aborting there is "between prechecks and the first feature".
    Object.defineProperty(target, "setCookies", { get: () => { ctl.abort(); return async () => {}; } });
    const r = await applyFixture(target, { version: 1, storage: { cookies: [{ name: "a", value: "b", domain: "a.test" }] } }, { signal: ctl.signal });
    expect(r).toEqual({ ok: false, stage: "prepare", error: "aborted" });
  });

  it("the stages tabs and steps are entered only when the fixture has tabs or steps", async () => {
    const seen: string[] = [];
    const target = fakeTarget({ exec: expectExec({ selector: false }) });
    // An expect failure is reported with its own stage, whatever ran before.
    const hooks = { onStage: (s: string) => seen.push(s) };
    const { applyParsedFixture } = await import("../../src/fixture/apply.js");
    await applyParsedFixture(target, { version: 1, url: "https://a.test/", expect: { selector: "#a", timeoutMs: 0 } }, {}, hooks);
    expect(seen).not.toContain("tabs");
    expect(seen).not.toContain("steps");
    expect(seen).toEqual(expect.arrayContaining(["prepare", "url", "expect"]));
  });

  it("a late failure after the last feature reports prepare for the final page read", async () => {
    const target = fakeTarget({ exec: () => OK });
    let reads = 0;
    const original = target.listPages!;
    target.listPages = async () => (++reads >= 2 ? [] : original());
    const r = await applyFixture(target, { version: 1, steps: [{ action: "wait", ms: 0 }] });
    expect(r).toMatchObject({ ok: false, stage: "prepare", error: "the browser reports no current tab" });
  });

  it("a reset that takes longer than its budget fails with a clear error", async () => {
    vi.useFakeTimers();
    try {
      const target = fakeTarget({ withReset: true });
      target.resetSession = () => new Promise(() => {});
      const run = applyFixture(target, { version: 1, fresh: true });
      await vi.advanceTimersByTimeAsync(15_001);
      expect(await run).toEqual({ ok: false, stage: "reset", error: "resetting the session took too long" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("prechecks are entered only for the features the fixture uses", async () => {
    // No fresh, no network: an unrelated refusal is not blamed on them.
    const r = await applyFixture(fakeTarget({ withCookies: false }), { version: 1, storage: { cookies: [{ name: "a", value: "b", domain: "a.test" }] } });
    expect(r).toMatchObject({ ok: false, stage: "cookies" });
  });

  it("main-tab detection fails with stage prepare", async () => {
    const target = fakeTarget();
    target.listPages = async () => [];
    expect(await applyFixture(target, { version: 1, url: "https://a.test/" })).toEqual({ ok: false, stage: "prepare", error: "the browser reports no current tab" });
  });
});

describe("applyFixture: expect", () => {
  it("passes when every condition holds, and runs after the steps", async () => {
    const target = fakeTarget({ exec: expectExec({}) });
    target.pages.get(1)!.url = "https://a.test/done?token=1";
    const r = await applyFixture(target, { version: 1, steps: [{ action: "click", selector: "#go" }], expect: { selector: "#ok", text: "Done", url: "https://a.test/done*" } });
    expect(r.ok).toBe(true);
    // click, then the expect poll
    expect(target.log.filter((l) => l.endsWith("js"))).toHaveLength(2);
  });

  it("fails with stage expect and names the selector", async () => {
    const r = await applyFixture(fakeTarget({ exec: expectExec({ selector: false }) }), { version: 1, expect: { selector: "#cart .item", timeoutMs: 0 } });
    expect(r).toEqual({ ok: false, stage: "expect", error: "expect failed after 0ms: element #cart .item is not visible" });
  });

  it("names the text, quoted up to 80 characters", async () => {
    const long = "x".repeat(200);
    const r = await applyFixture(fakeTarget({ exec: expectExec({ text: false }) }), { version: 1, expect: { text: long, timeoutMs: 0 } });
    expect(r).toEqual({ ok: false, stage: "expect", error: `expect failed after 0ms: text "${"x".repeat(80)}..." is not on the page` });
  });

  it("names the actual URL as origin + pathname", async () => {
    const target = fakeTarget({ exec: expectExec({}) });
    target.pages.get(1)!.url = `https://a.test/login?token=${SECRET}#frag`;
    const r = await applyFixture(target, { version: 1, expect: { url: "https://a.test/home*", timeoutMs: 0 } });
    expect(r).toEqual({ ok: false, stage: "expect", error: "expect failed after 0ms: URL https://a.test/login does not match the expected pattern" });
  });

  it("reports every failed condition", async () => {
    const r = await applyFixture(fakeTarget({ exec: expectExec({ selector: false, text: false }) }), { version: 1, expect: { selector: "#a", text: "hi", timeoutMs: 0 } });
    expect(r).toMatchObject({ ok: false, error: 'expect failed after 0ms: element #a is not visible; text "hi" is not on the page' });
  });

  it("polls until the page gets there", async () => {
    let calls = 0;
    const target = fakeTarget({ exec: (code) => (code.includes("getBoundingClientRect") ? JSON.stringify({ ok: true, selector: ++calls >= 3 }) : OK) });
    const t0 = Date.now();
    const r = await applyFixture(target, { version: 1, expect: { selector: "#late", timeoutMs: 3000 } });
    expect(r.ok).toBe(true);
    expect(calls).toBe(3);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("waits for the default 5000 ms at most (the timeout is part of the message)", async () => {
    const r = await applyFixture(fakeTarget({ exec: expectExec({ selector: false }) }), { version: 1, expect: { selector: "#a", timeoutMs: 150 } });
    expect(r).toMatchObject({ ok: false, error: "expect failed after 150ms: element #a is not visible" });
  });

  it("an invalid selector fails at once", async () => {
    const r = await applyFixture(fakeTarget({ exec: expectExec({ error: "invalid selector" }) }), { version: 1, expect: { selector: "##", timeoutMs: 5000 } });
    expect(r).toEqual({ ok: false, stage: "expect", error: "expect failed: invalid selector" });
  });

  it("a url-only expect needs no page script", async () => {
    const target = fakeTarget({ exec: () => { throw new Error("no script expected"); } });
    target.pages.get(1)!.url = "https://a.test/x";
    expect((await applyFixture(target, { version: 1, expect: { url: "https://a.test/x" } })).ok).toBe(true);
  });

  it("honors the abort signal while polling", async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 30);
    const r = await applyFixture(fakeTarget({ exec: expectExec({ selector: false }) }), { version: 1, expect: { selector: "#a", timeoutMs: 20000 } }, { signal: ctl.signal });
    expect(r).toEqual({ ok: false, stage: "expect", error: "aborted" });
  });

  it("is part of the controller's deadline budget", () => {
    const base = fixtureBudgetMs({ version: 1 });
    expect(fixtureBudgetMs({ version: 1, expect: { text: "a", timeoutMs: 2000 } })).toBe(base + 2000 + 10_000);
    expect(fixtureBudgetMs({ version: 1, fresh: true })).toBeGreaterThan(base);
  });
});

describe("stage on every failure", () => {
  const cases: [string, PageFixture, Parameters<typeof fakeTarget>[0], string][] = [
    ["cookies", { version: 1, storage: { cookies: [{ name: "a", value: "b", domain: "a.test" }] } }, { withCookies: false }, "cookies"],
    ["tabs", { version: 1, tabs: ["https://b.test/"] }, { withTabs: false }, "tabs"],
    ["steps", { version: 1, steps: [{ action: "press", key: "NoSuchKey" }] }, {}, "steps"],
    ["storage", { version: 1, storage: { origins: [{ origin: "https://a.test", localStorage: { k: "v" } }] } }, { exec: () => JSON.stringify({ ok: false, name: "QuotaExceededError" }) }, "storage"],
  ];
  for (const [name, fixture, opts, stage] of cases) {
    it(`reports ${name}`, async () => {
      const r = await applyFixture(fakeTarget(opts), fixture);
      expect(r).toMatchObject({ ok: false, stage });
    });
  }
  it("reports validate for a parse error", async () => {
    expect(await applyFixture(fakeTarget(), { version: 1, expect: {} })).toEqual({ ok: false, stage: "validate", error: "fixture.expect needs selector, text or url" });
  });
});

describe("no secret in a summary or an error", () => {
  const fixture: PageFixture = {
    version: 1,
    fresh: true,
    network: [{ url: `https://api.a.test/cart?token=${SECRET}`, headers: { "x-key": `h-${SECRET}` }, body: `b-${SECRET}` }],
    expect: { selector: "#ok", timeoutMs: 0 },
  };

  it("the summary holds counts only", async () => {
    const r = await applyFixture(fakeTarget({ withNetwork: true, withReset: true, exec: expectExec({}) }), fixture, allow);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.summary).toBe("1 network mock; fresh session; expect checked");
    expect(JSON.stringify(r, (_k, v: unknown) => (typeof v === "function" ? "fn" : v))).not.toContain(SECRET);
  });

  it("errors of every network stage hold none of it", async () => {
    const targets = [
      fakeTarget({ withReset: true }),
      fakeTarget({ withNetwork: true, withReset: true }),
      (() => { const t = fakeTarget({ withReset: true, withNetwork: true }); t.routeRequests = async () => { throw new Error(`${SECRET}`); }; return t; })(),
      fakeTarget({ withReset: true, withNetwork: true, exec: expectExec({ selector: false }) }),
    ];
    for (const [i, target] of targets.entries()) {
      const r = await applyFixture(target, fixture, i === 0 ? {} : allow);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain(SECRET);
    }
  });
});

describe("BrowserController: release lifetime", () => {
  const delayedLoad = (t: ReturnType<typeof fakeTarget>) => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    t.pages.get(1)!.loadURL = async () => { await gate; };
    return open;
  };

  const withMock: PageFixture = { version: 1, network: [{ url: "https://api.a.test/*", status: 500 }] };
  const exec = () => ({ ok: true, found: true });

  it("keeps the release: the result carries none, releaseFixture removes the mocks once", async () => {
    const t = fakeTarget({ withNetwork: true, exec });
    const c = new BrowserController(t);
    const r = await c.applyFixture(withMock, allow);
    expect(r.ok).toBe(true);
    expect("release" in r).toBe(false);
    expect(t.unrouted).toBe(0);
    await c.releaseFixture();
    await c.releaseFixture();
    expect(t.unrouted).toBe(1);
  });

  it("a new applyFixture releases the previous mocks first", async () => {
    const t = fakeTarget({ withNetwork: true, exec });
    const c = new BrowserController(t);
    await c.applyFixture(withMock, allow);
    await c.applyFixture({ version: 1, url: "https://a.test/" });
    expect(t.log.indexOf("unroute")).toBeGreaterThan(-1);
    expect(t.unrouted).toBe(1);
    // Nothing is left to release.
    await c.releaseFixture();
    expect(t.unrouted).toBe(1);
  });

  it("re-applying a fixture with mocks swaps the interception", async () => {
    const t = fakeTarget({ withNetwork: true, exec });
    const c = new BrowserController(t);
    await c.applyFixture(withMock, allow);
    await c.applyFixture(withMock, allow);
    expect(t.log.filter((l) => l === "route")).toHaveLength(2);
    expect(t.log.indexOf("unroute")).toBeLessThan(t.log.lastIndexOf("route"));
    expect(t.unrouted).toBe(1);
  });

  it("a failed apply installs nothing that stays", async () => {
    const t = fakeTarget({ withNetwork: true, exec: () => ({ ok: false, error: "element not found" }) });
    const c = new BrowserController(t);
    const r = await c.applyFixture({ ...withMock, steps: [{ action: "click", selector: "#a" }] }, allow);
    expect(r).toMatchObject({ ok: false, stage: "steps" });
    expect(t.unrouted).toBe(1);
    await c.releaseFixture();
    expect(t.unrouted).toBe(1);
  });

  it("the gate and the stage reach the controller result", async () => {
    const c = new BrowserController(fakeTarget({ withNetwork: true, exec }));
    expect(await c.applyFixture(withMock)).toEqual({ ok: false, stage: "network", error: "network mocks are disabled (allowNetworkMocks is off)" });
    expect(await c.applyFixture({ version: 1, expect: {} })).toMatchObject({ ok: false, stage: "validate" });
  });

  it("an expect failure through the controller has stage expect", async () => {
    const c = new BrowserController(fakeTarget({ exec: (code) => (code.includes("getBoundingClientRect") ? { ok: true, selector: false } : { ok: true, found: true }) }));
    expect(await c.applyFixture({ version: 1, expect: { selector: "#a", timeoutMs: 0 } })).toMatchObject({ ok: false, stage: "expect" });
  });

  it("releaseFixture during an in-flight apply waits for it and removes the mocks it installed", async () => {
    const t = fakeTarget({ withNetwork: true, exec });
    const open = delayedLoad(t);
    const c = new BrowserController(t);
    const applying = c.applyFixture({ ...withMock, url: "https://a.test/" }, allow);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.log).toContain("route");
    let released = false;
    const releasing = c.releaseFixture().then(() => { released = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(released).toBe(false);
    open();
    await Promise.all([applying, releasing]);
    expect(t.unrouted).toBe(1);
    await c.releaseFixture();
    expect(t.unrouted).toBe(1);
  });

  it("an apply that finishes after the deadline removes its mocks itself", async () => {
    vi.useFakeTimers();
    try {
      const t = fakeTarget({ withNetwork: true, exec });
      let open!: () => void;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      // The cookie call hangs (past the deadline) and then succeeds: the apply goes on and finishes late.
      t.setCookies = async () => { await gate; };
      const c = new BrowserController(t);
      const run = c.applyFixture({ ...withMock, storage: { cookies: [{ name: "a", value: "b", domain: "a.test" }] } }, allow);
      await vi.advanceTimersByTimeAsync(400_000);
      expect(await run).toMatchObject({ ok: false });
      open();
      await vi.advanceTimersByTimeAsync(100);
      await c.releaseFixture();
      expect(t.unrouted).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an apply whose signal aborted before it finished does not leave mocks even without the controller", async () => {
    const ctl = new AbortController();
    const t = fakeTarget({ withNetwork: true, exec });
    const route = t.routeRequests!;
    // Aborting after the last abort check of `run` but before it returns: the late-finish guard decides.
    t.routeRequests = async (h) => route(h);
    t.pages.get(1)!.getURL = () => { ctl.abort(); return "https://a.test/"; };
    const r = await applyFixture(t, withMock, { ...allow, signal: ctl.signal });
    expect(r).toMatchObject({ ok: false, error: "aborted" });
    expect(t.unrouted).toBe(1);
  });

  it("a failing release of the previous fixture never rejects the next apply", async () => {
    const t = fakeTarget({ withNetwork: true, exec });
    const c = new BrowserController(t);
    await c.applyFixture(withMock, allow);
    t.routeRequests = async () => async () => {};
    // Make the stored release fail: the old context is gone.
    (c as unknown as { fixtureActive: unknown }).fixtureActive = { token: "x", release: async () => { throw new Error("context closed"); } };
    const r = await c.applyFixture({ version: 1, url: "https://a.test/" });
    expect(r.ok).toBe(true);
    // The failed release was marked released: it is not tried again.
    await expect(c.releaseFixture()).resolves.toBeUndefined();
  });

  it("an invalid new fixture still releases the previous mocks and keeps its stage", async () => {
    const t = fakeTarget({ withNetwork: true, exec });
    const c = new BrowserController(t);
    await c.applyFixture(withMock, allow);
    const r = await c.applyFixture({ version: 1, expect: {} });
    expect(r).toEqual({ ok: false, stage: "validate", error: "fixture.expect needs selector, text or url" });
    expect(t.unrouted).toBe(1);
  });

  it("a capture timeout has no stage", async () => {
    vi.useFakeTimers();
    try {
      const t = fakeTarget({ exec });
      t.getCookies = () => new Promise(() => {});
      const run = new BrowserController(t).captureFixture();
      await vi.advanceTimersByTimeAsync(400_000);
      const r = await run;
      expect(r.ok).toBe(false);
      expect("stage" in r).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releaseFixture does not wait forever for an apply that hangs; the late apply cleans up itself", async () => {
    vi.useFakeTimers();
    try {
      const t = fakeTarget({ withNetwork: true, exec });
      let open!: () => void;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      t.setCookies = async () => { await gate; };
      const c = new BrowserController(t);
      const run = c.applyFixture({ ...withMock, storage: { cookies: [{ name: "a", value: "b", domain: "a.test" }] } }, allow);
      await vi.advanceTimersByTimeAsync(100);
      let released = false;
      const releasing = c.releaseFixture().then(() => { released = true; });
      await vi.advanceTimersByTimeAsync(5_001);
      await releasing;
      expect(released).toBe(true);
      // The abandoned apply ends later and removes its own mocks.
      await vi.advanceTimersByTimeAsync(400_000);
      await run;
      open();
      await vi.advanceTimersByTimeAsync(100);
      expect(t.unrouted).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a token releases only its own fixture: run A's late release leaves run B's mocks", async () => {
    const t = fakeTarget({ withNetwork: true, exec });
    const c = new BrowserController(t);
    const a = await c.applyFixture(withMock, allow);
    const tokenA = a.ok ? a.fixtureToken : undefined;
    expect(typeof tokenA).toBe("string");
    const b = await c.applyFixture(withMock, allow);
    const tokenB = b.ok ? b.fixtureToken : undefined;
    expect(tokenB).not.toBe(tokenA);
    expect(t.unrouted).toBe(1); // A was replaced by B's apply
    await c.releaseFixture(tokenA);
    expect(t.unrouted).toBe(1); // B untouched
    await c.releaseFixture(tokenB);
    expect(t.unrouted).toBe(2);
    await c.releaseFixture(tokenB);
    expect(t.unrouted).toBe(2);
  });

  it("a fixture without mocks has no token", async () => {
    const r = await new BrowserController(fakeTarget({ exec })).applyFixture({ version: 1, url: "https://a.test/" });
    expect(r.ok && "fixtureToken" in r).toBe(false);
  });
});
