import { describe, expect, it, vi } from "vitest";
import { BrowserController } from "../../src/controller/controller.js";
import { dispatchKeyPair } from "../../src/controller/keys.js";
import { BOT_CHECK_JS } from "../../src/controller/pageScripts.js";
import { applyFixture, applyParsedFixture, fixtureBudgetMs } from "../../src/fixture/apply.js";
import { fakePage, fakeTarget, type FakeTarget } from "./fakes.js";

const OK = { ok: true, found: true };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A page whose Enter key starts a navigation that finishes after `ms`; a click only works on the new page. */
function navigatingTarget(ms = 120) {
  const t = fakeTarget({
    exec: (code) => {
      if (code.includes("el.click()")) return JSON.stringify(state.page === "new" ? { ok: true } : { ok: false, error: "element not found" });
      return OK;
    },
  });
  const page = t.pages.get(1)!;
  const state = { page: "old", loading: false };
  let ready: Promise<void> = Promise.resolve();
  page.isLoading = () => state.loading;
  page.onceDomReady = () => ready;
  page.sendCdp = async (method, params) => {
    page.keys.push({ method, params });
    if (params?.type === "keyUp") {
      state.loading = true;
      page.url = "https://a.test/next";
      ready = sleep(ms).then(() => {
        state.loading = false;
        state.page = "new";
      });
    }
  };
  return { t, state };
}

describe("item 1: navigation budget", () => {
  it("fixtureBudgetMs uses the host's navigation budget and never cuts one navigation", () => {
    const f = { version: 1 as const, url: "https://a.test/" };
    expect(fixtureBudgetMs(f, { navigationMs: 65_000 })).toBe(75_000);
    expect(fixtureBudgetMs(f, { navigationMs: 400_000 })).toBe(410_000);
  });

  it("the controller lets a navigation run for its openTimeoutMs, not for the standalone 30 s", async () => {
    vi.useFakeTimers();
    try {
      const t = fakeTarget({ exec: () => OK });
      const page = t.pages.get(1)!;
      const done = sleep(40_000);
      page.loadURL = async () => { await done; };
      page.onceDomReady = () => done;
      const run = new BrowserController(t, { openTimeoutMs: 60_000 }).applyFixture({ version: 1, url: "https://a.test/" });
      await vi.advanceTimersByTimeAsync(40_100);
      expect(await run).toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("item 2: dialogs", () => {
  it("reports each auto-handled dialog once: from a nested open and from the outer drain", async () => {
    const t = fakeTarget({ exec: () => OK });
    const page = t.pages.get(1)!;
    const queue: { type: string; message: string }[] = [];
    page.drainDialogs = () => queue.splice(0);
    const load = page.loadURL;
    page.loadURL = async (url) => {
      queue.push({ type: "alert", message: "during load" });
      await load(url);
    };
    const exec = page.executeJavaScript;
    page.executeJavaScript = async (code) => {
      if (code.includes("el.click()")) queue.push({ type: "confirm", message: "during click" });
      return exec(code);
    };
    const r = await new BrowserController(t).applyFixture({ version: 1, url: "https://a.test/", steps: [{ action: "click", selector: "#a" }] });
    expect(r.ok).toBe(true);
    expect((r.dialogs ?? []).map((d) => d.message)).toEqual(["during load", "during click"]);
  });
});

describe("item 3: bot check", () => {
  const exec = (code: string) => (code.includes(BOT_CHECK_JS.slice(0, 60)) ? { botCheck: true } : OK);

  it("the controller path fails with a clear error and no query", async () => {
    const r = await new BrowserController(fakeTarget({ exec })).applyFixture({ version: 1, url: "https://a.test/p?token=SECRETQ" });
    expect(r).toEqual({ ok: false, stage: "url", error: "start page: https://a.test/p shows a bot check" });
  });

  it("the standalone path is unaffected", async () => {
    const r = await applyFixture(fakeTarget({ exec: (code) => (code.includes(BOT_CHECK_JS.slice(0, 60)) ? { botCheck: true } : OK) }), { version: 1, url: "https://a.test/p" });
    expect(r.ok).toBe(true);
  });
});

describe("item 4: settle after click and press", () => {
  it("standalone: type, press Enter (navigates), click on the new page", async () => {
    const { t, state } = navigatingTarget();
    const r = await applyFixture(t, {
      version: 1,
      steps: [
        { action: "type", selector: "input", text: "q" },
        { action: "press", key: "Enter", selector: "input" },
        { action: "click", selector: "#go" },
      ],
    });
    expect(r).toMatchObject({ ok: true });
    expect(state.page).toBe("new");
  });

  it("the controller: the same steps settle through the navigation watcher", async () => {
    const { t } = navigatingTarget();
    const r = await new BrowserController(t).applyFixture({
      version: 1,
      steps: [
        { action: "press", key: "Enter", selector: "input" },
        { action: "click", selector: "#go" },
      ],
    });
    expect(r).toMatchObject({ ok: true });
  });

  it("without the settle, the click would have hit the old page", async () => {
    const { t, state } = navigatingTarget(10_000);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 400);
    const r = await applyFixture(t, { version: 1, steps: [{ action: "press", key: "Enter" }, { action: "click", selector: "#go" }] }, { signal: ctl.signal });
    // Still loading at 400 ms: the run waited (and was aborted) instead of clicking at once.
    expect(r).toEqual({ ok: false, stage: "steps", error: "aborted" });
    expect(state.page).toBe("old");
  });
});

describe("items 5 and 6: tab identity", () => {
  function popupTarget() {
    const t = fakeTarget({ exec: () => OK });
    const main = t.pages.get(1)!;
    const load = main.loadURL;
    main.loadURL = async (url) => {
      await load(url);
      // A popup opens during the load and becomes current.
      const log: string[] = [];
      const popup = fakePage(log, "popup", () => OK);
      t.pages.set(9, popup);
      t.currentId = 9;
    };
    return t;
  }

  it("standalone: steps run on the main tab even when a popup became current", async () => {
    const t = popupTarget();
    const r = await applyFixture(t, { version: 1, url: "https://a.test/", steps: [{ action: "click", selector: "#a" }] });
    expect(r).toMatchObject({ ok: true, url: "https://a.test/" });
    expect(t.currentId).toBe(1);
    expect(t.log).toContain("select 1");
    expect(t.log.at(-1)).toBe("main: js");
  });

  it("the controller path does the same", async () => {
    const t = popupTarget();
    const r = await new BrowserController(t).applyFixture({ version: 1, url: "https://a.test/", steps: [{ action: "click", selector: "#a" }] });
    expect(r).toMatchObject({ ok: true });
    expect(t.currentId).toBe(1);
  });

  it("fails clearly when the target lists no current tab", async () => {
    const t = fakeTarget({ exec: () => OK });
    t.listPages = async () => [];
    expect(await applyFixture(t, { version: 1, url: "https://a.test/" })).toEqual({ ok: false, stage: "prepare", error: "the browser reports no current tab" });
  });

  it("fails clearly when the main tab is gone", async () => {
    const t = fakeTarget({ exec: () => OK });
    t.pages.get(1)!.loadURL = async () => {
      t.pages.set(2, fakePage([], "other", () => OK));
      t.currentId = 2;
    };
    t.selectPage = async () => false;
    expect(await applyFixture(t, { version: 1, url: "https://a.test/" })).toEqual({ ok: false, stage: "url", error: "start page: the main tab is gone" });
  });
});

describe("item 7: abort", () => {
  it("after an abort inside a hook, no further navigation or tab starts", async () => {
    const ctl = new AbortController();
    const calls: string[] = [];
    const t = fakeTarget({ exec: () => OK });
    const r = await applyFixture(
      t,
      { version: 1, url: "https://a.test/", tabs: ["https://b.test/"] },
      { signal: ctl.signal },
      {
        navigate: async (url) => { calls.push(`navigate ${url}`); ctl.abort(); return { ok: true }; },
        openTab: async (url) => { calls.push(`tab ${url}`); return { ok: true }; },
      },
    );
    expect(r).toEqual({ ok: false, stage: "url", error: "aborted" });
    expect(calls).toEqual(["navigate https://a.test/"]);
  });

  it("standalone: a tab that appears after the abort is closed and the main tab is current again", async () => {
    const ctl = new AbortController();
    const t = fakeTarget({ exec: () => OK, newPageIgnoresUrl: true });
    const origNew = t.newPage!;
    t.newPage = async (url) => {
      const info = await origNew(url);
      ctl.abort();
      return info;
    };
    const r = await applyFixture(t, { version: 1, tabs: ["https://b.test/"] }, { signal: ctl.signal });
    expect(r).toEqual({ ok: false, stage: "tabs", error: "aborted" });
    expect(t.pages.has(2)).toBe(false);
    expect(t.currentId).toBe(1);
  });

  it("the controller: a tab created after the abort is closed and the previous tab stays current", async () => {
    const ctl = new AbortController();
    const t: FakeTarget = fakeTarget({ exec: () => OK, newPageIgnoresUrl: true });
    const origNew = t.newPage!;
    t.newPage = async (url) => {
      const info = await origNew(url);
      ctl.abort();
      return info;
    };
    const r = await new BrowserController(t).applyFixture({ version: 1, tabs: ["https://b.test/"] }, { signal: ctl.signal });
    expect(r).toMatchObject({ ok: false, error: "aborted" });
    expect(t.pages.has(2)).toBe(false);
    expect(t.currentId).toBe(1);
  });

  it("a nested command's timeout keeps the outer pending overrun", async () => {
    const c = new BrowserController(fakeTarget({ exec: () => OK })) as unknown as {
      overrun: Promise<void> | null;
      withCommandTimeout(fn: () => Promise<Record<string, unknown>>, ms: number): Promise<unknown>;
    };
    let releaseOuter!: () => void;
    c.overrun = new Promise<void>((resolve) => (releaseOuter = resolve));
    let releaseWork!: () => void;
    await c.withCommandTimeout(() => new Promise((resolve) => (releaseWork = () => resolve({}))), 20);
    let settled = false;
    void c.overrun!.then(() => { settled = true; });
    releaseWork();
    await sleep(50);
    expect(settled).toBe(false); // the outer overrun still holds it
    releaseOuter();
    await sleep(20);
    expect(settled).toBe(true);
  });
});

describe("item 8: waitFor timeoutMs 0", () => {
  it("checks once and succeeds when the element is there", async () => {
    let calls = 0;
    const t = fakeTarget({ exec: () => (calls++, JSON.stringify({ ok: true, found: true })) });
    expect((await applyFixture(t, { version: 1, steps: [{ action: "waitFor", selector: ".x", timeoutMs: 0 }] })).ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("checks once and times out when it is not", async () => {
    let calls = 0;
    const t = fakeTarget({ exec: () => (calls++, JSON.stringify({ ok: true, found: false })) });
    const r = await applyFixture(t, { version: 1, steps: [{ action: "waitFor", selector: ".x", timeoutMs: 0 }] });
    expect(r).toEqual({ ok: false, stage: "steps", error: "step 1 (waitFor .x) failed: timed out after 0ms" });
    expect(calls).toBe(1);
  });
});

describe("item 9: shared key dispatch", () => {
  it("sends a keyDown with text or a rawKeyDown without, then keyUp", async () => {
    const sent: { method: string; params?: Record<string, unknown> }[] = [];
    const page = { sendCdp: async (method: string, params?: Record<string, unknown>) => void sent.push({ method, params }) };
    await dispatchKeyPair(page, { key: "a", code: "KeyA", windowsVirtualKeyCode: 65 }, { modifiers: 2, commands: ["selectAll"] });
    await dispatchKeyPair(page, { key: "a", code: "KeyA", windowsVirtualKeyCode: 65 }, { text: "a" });
    expect(sent.map((s) => s.params?.type)).toEqual(["rawKeyDown", "keyUp", "keyDown", "keyUp"]);
    expect(sent[0].params).toMatchObject({ modifiers: 2, commands: ["selectAll"], text: undefined });
  });

  it("throws without a CDP session", async () => {
    await expect(dispatchKeyPair({}, { key: "a", code: "KeyA", windowsVirtualKeyCode: 65 })).rejects.toThrow("requires a CDP session");
  });
});

describe("item 10: validate once", () => {
  it("applyParsedFixture does not validate again", async () => {
    // An invalid version would fail parsePageFixture; the parsed entry point trusts its caller.
    expect(await applyParsedFixture(fakeTarget({ exec: () => OK }), { version: 2 } as never)).toMatchObject({ ok: true });
    expect(await applyFixture(fakeTarget({ exec: () => OK }), { version: 2 } as never)).toEqual({ ok: false, stage: "validate", error: "fixture.version must be 1" });
  });
});
