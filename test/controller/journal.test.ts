import { describe, expect, it } from "vitest";
import { BrowserController } from "../../src/controller/controller.js";
import { CheckpointJournal, JournalSession } from "../../src/controller/journal.js";
import { CHECKPOINT_GAPS, summarizeCheckpoint } from "../../src/fixture/checkpoint.js";
import { CHECKPOINT_MAX_STEPS, type CheckpointResult, type FixtureCookie } from "../../src/fixture/types.js";
import { fakeTarget, type FakePage, type FakeTarget } from "../fixture/fakes.js";

// Sentinels: none of these may appear in a summary, a gap or any model-visible text.
const COOKIE = "sentinel-cookie-7a1";
const STORE = "sentinel-storage-3c9";
const TYPED = "sentinel-typed-text-5e2";

type Args = Record<string, unknown>;

interface Rig {
  controller: BrowserController;
  target: FakeTarget;
  state: {
    local: Record<string, string>;
    cookies: FixtureCookie[];
    selectorCalls: Args[];
    /** What SELECTOR_JS answers; default: a selector built from the target. */
    selector: (args: Args) => Record<string, unknown>;
    /** Runs when an action script (click, type, select) executes. */
    onAction?: (code: string) => void;
    cookieCalls: (string[] | undefined)[];
    storageReads: number;
    /** Counts action scripts; the page signature moves with it, so a click has an effect and settles fast. */
    actions: number;
    /** The document marker per page: deleting it is a NEW document (open, reload, a link, a form POST, back/forward). */
    docs: Map<FakePage, string>;
    /** The marker script fails (a page that cannot be asked). */
    markerFails: boolean;
    /** The hover target script finds its element. */
    hoverFound: boolean;
    markerReads: number;
    /** Loads a new document at `url` in `page`. A pushState is just `page.url = ...`. */
    navigate(page: FakePage, url: string): void;
  };
  page: ReturnType<typeof fakeTarget>["pages"] extends Map<number, infer P> ? P : never;
}

function rig(url = "https://shop.test/cart", opts: { timeoutMs?: number } = {}): Rig {
  const state: Rig["state"] = {
    local: {},
    cookies: [{ name: "sid", value: COOKIE, domain: "shop.test" }],
    selectorCalls: [],
    selector: (args) => args.op === "active" ? { ok: true, none: true } : ({ ok: true, selector: `#${String(args.target ?? `idx${String(args.index)}`).replace(/\W+/g, "-")}`, ...(args.op === "select" ? { optionValue: "opt-" + String(args.optionText) } : {}) }),
    cookieCalls: [],
    storageReads: 0,
    actions: 0,
    docs: new Map(),
    markerFails: false,
    hoverFound: true,
    markerReads: 0,
    navigate: (p, u) => {
      p.url = u;
      state.docs.delete(p);
    },
  };
  let docSeq = 0;
  /** The marker of the page's document (planted when absent), like the page script; null when the page cannot be asked. */
  const readMarker = (self: FakePage): string | null => {
    state.markerReads += 1;
    if (state.markerFails) return null;
    if (!state.docs.has(self)) state.docs.set(self, `doc-${++docSeq}`);
    return state.docs.get(self)!;
  };
  const target = fakeTarget({
    exec: (code, self) => {
      // SELECTOR_JS carries the marker code too, so it is matched first; its answer holds the document marker.
      if (code.includes("function selectorFor")) {
        const args = JSON.parse(/var args = (\{.*\});/.exec(code)![1]!) as Args;
        state.selectorCalls.push(args);
        const answer = state.selector(args);
        const marker = readMarker(self);
        return marker === null ? answer : { ...answer, marker };
      }
      if (code.includes("__penJournalDoc")) {
        const marker = readMarker(self);
        return marker === null ? { ok: false } : { ok: true, marker };
      }
      if (code.includes("data-pen-sig-mainimg")) {
        return { url: page.getURL(), title: "t", nodeCount: 1, textLength: state.actions, textHash: state.actions, mainImageSrc: "", scrollY: 0, focusedValueLength: 0, pageChanged: code.includes('"phase":"after"') };
      }
      if (code.includes("const dump")) {
        state.storageReads += 1;
        return JSON.stringify({ ok: true, localStorage: state.local, sessionStorage: {} });
      }
      if (code.includes("var hoverResult")) return state.hoverFound ? { found: true, x: 5, y: 5 } : { found: false, hidden: false };
      if (code.includes("__penReveal")) return { found: true, hitOk: true };
      if (code.includes("focused: true")) return { focused: true };
      if (code.includes("el.click()") || code.includes("setter.call") || code.includes("selectedIndex")) { state.actions += 1; state.onAction?.(code); }
      return { ok: true, url: page.getURL(), title: "t" };
    },
  });
  delete target.pages.get(1)!.sendCdp;
  const page = target.pages.get(1)!;
  page.url = url;
  // Every load of a document is a new document, like in a browser.
  for (const method of ["reload", "goBack", "goForward"] as const) page[method] = () => { state.docs.delete(page); };
  const load = page.loadURL;
  page.loadURL = async (u) => { await load(u); state.docs.delete(page); };
  target.getCookies = async (urls) => {
    state.cookieCalls.push(urls);
    return state.cookies;
  };
  const controller = new BrowserController(target, { cursor: false, ...opts });
  return { controller, target, state, page } as Rig;
}

const wf = (selector: string) => ({ action: "waitFor", selector }) as const;

const ok = (r: CheckpointResult) => {
  if (!r.ok) throw new Error(`checkpoint failed: ${r.error}`);
  return r;
};

describe("journal off (default)", () => {
  it("costs nothing: no selector script, no cookie or storage read; capture says it is not running", async () => {
    const { controller, state, target } = rig();
    await controller.act({ action: "click", target: "Buy" });
    await controller.act({ action: "type", target: "q", text: TYPED });
    expect(state.selectorCalls).toEqual([]);
    expect(state.cookieCalls).toEqual([]);
    expect(state.storageReads).toBe(0);
    expect(target.log.filter((l) => l.startsWith("getCookies"))).toEqual([]);
    expect(await controller.captureCheckpoint()).toEqual({ ok: false, error: "the journal is not running (call startJournal first)" });
  });

  it("stopJournal drops the journal: nothing is recorded or computed afterwards", async () => {
    const { controller, state } = rig();
    controller.startJournal();
    await controller.act({ action: "click", target: "Buy" });
    controller.stopJournal();
    state.selectorCalls.length = 0;
    await controller.act({ action: "click", target: "Buy" });
    expect(state.selectorCalls).toEqual([]);
    expect((await controller.captureCheckpoint()).ok).toBe(false);
  });
});

describe("base state", () => {
  it("is read at the first command, from the page's origin only by default", async () => {
    const { controller, state } = rig();
    state.local = { theme: STORE };
    controller.startJournal();
    await controller.act({ action: "click", target: "Buy" });
    expect(state.cookieCalls).toEqual([["https://shop.test"]]);
    const r = ok(await controller.captureCheckpoint());
    expect(r.fixture).toMatchObject({
      version: 1,
      url: "https://shop.test/cart",
      storage: { cookies: [{ name: "sid", value: COOKIE }], origins: [{ origin: "https://shop.test", localStorage: { theme: STORE } }] },
      steps: [wf("#Buy"), { action: "click", selector: "#Buy" }],
    });
    expect(r.complete).toBe(true);
    expect(r.gap).toBeUndefined();
  });

  it("is read at the page change, NOT at capture: a step that writes storage does not leak into the base (add to cart)", async () => {
    const { controller, state } = rig();
    state.local = { theme: "dark" };
    state.onAction = () => {
      state.local = { ...state.local, cart: `[${STORE}]` };
    };
    controller.startJournal();
    await controller.act({ action: "click", target: "Add to cart" });
    // The page now holds the cart; the base must not.
    expect(state.local.cart).toBe(`[${STORE}]`);
    const r = ok(await controller.captureCheckpoint());
    expect(r.fixture.storage?.origins).toEqual([{ origin: "https://shop.test", localStorage: { theme: "dark" } }]);
    expect(JSON.stringify(r.fixture.storage)).not.toContain(STORE);
    expect(r.fixture.steps).toEqual([wf("#Add-to-cart"), { action: "click", selector: "#Add-to-cart" }]);
  });

  it("the origins option scopes cookies, and storage of the tabs on those origins", async () => {
    const { controller, state, target } = rig();
    controller.startJournal({ origins: ["https://shop.test/ignored/path", "https://pay.test"] });
    await controller.act({ action: "click", target: "Buy" });
    expect(state.cookieCalls).toEqual([["https://shop.test", "https://pay.test"]]);
    expect(target.pages.size).toBe(1);
  });

  it("a failing cookie read does not fail the command: the base has no cookies and the gap says so", async () => {
    const { controller, target } = rig();
    target.getCookies = async () => {
      throw new Error(`boom ${COOKIE}`);
    };
    controller.startJournal();
    const click = await controller.act({ action: "click", target: "Buy" });
    expect(click).not.toHaveProperty("error");
    const r = ok(await controller.captureCheckpoint());
    expect(r.complete).toBe(false);
    expect(r.gap).toBe(CHECKPOINT_GAPS.base);
    expect(r.fixture.storage?.cookies).toBeUndefined();
    expect(r.summary).not.toContain(COOKIE);
  });

  it("a target without getCookies just has no cookies", async () => {
    const { controller, target } = rig();
    delete target.getCookies;
    controller.startJournal();
    await controller.act({ action: "click", target: "Buy" });
    const r = ok(await controller.captureCheckpoint());
    expect(r.fixture.storage).toBeUndefined();
    expect(r.complete).toBe(true);
  });
});

describe("recorded actions", () => {
  it("records click, type, press (with and without a target) from act, in order", async () => {
    const { controller, state, page } = rig();
    page.sendCdp = async () => {};
    controller.startJournal();
    await controller.act({ action: "click", target: "Buy" });
    await controller.act({ action: "type", target: "email", text: TYPED });
    await controller.act({ action: "press", key: "Tab" });
    await controller.act({ action: "press", key: "Enter", target: "email" });
    // A key-only press records the focused element (op "active"), a press with a target looks that target up.
    expect(state.selectorCalls.map((c) => c.op)).toEqual(["click", "type", "active", "press"]);
    const r = ok(await controller.captureCheckpoint());
    expect(r.fixture.steps).toEqual([
      wf("#Buy"), { action: "click", selector: "#Buy" },
      wf("#email"), { action: "type", selector: "#email", text: TYPED },
      { action: "press", key: "Tab" },
      wf("#email"), { action: "press", key: "Enter", selector: "#email" },
    ]);
  });

  it("records the index+snapshotId paths: act click/type/select and perform CLICK/TYPE_TEXT/SELECT", async () => {
    const { controller, state } = rig();
    controller.startJournal();
    const { snapshotId } = (await controller.snapshot()) as { snapshotId: string };
    await controller.act({ action: "click", index: 1, snapshotId });
    await controller.act({ action: "type", index: 2, snapshotId, text: "a" });
    await controller.act({ action: "select", index: 3, snapshotId, text: "Large" });
    await controller.perform({ snapshotId, index: 4, operation: "CLICK" });
    await controller.perform({ snapshotId, index: 5, operation: "TYPE_TEXT", text: "b" });
    await controller.perform({ snapshotId, index: 6, operation: "SELECT", text: "Small" });
    expect(state.selectorCalls.map((c) => [c.op, c.index, c.snapshotId === snapshotId])).toEqual([
      ["click", 1, true], ["type", 2, true], ["select", 3, true], ["click", 4, true], ["type", 5, true], ["select", 6, true],
    ]);
    const r = ok(await controller.captureCheckpoint());
    expect(r.fixture.steps).toEqual([
      wf("#idx1"), { action: "click", selector: "#idx1" },
      wf("#idx2"), { action: "type", selector: "#idx2", text: "a" },
      wf("#idx3"), { action: "select", selector: "#idx3", value: "opt-Large" },
      wf("#idx4"), { action: "click", selector: "#idx4" },
      wf("#idx5"), { action: "type", selector: "#idx5", text: "b" },
      wf("#idx6"), { action: "select", selector: "#idx6", value: "opt-Small" },
    ]);
  });

  it("the selector is computed BEFORE the action runs", async () => {
    const { controller, state } = rig();
    const order: string[] = [];
    const inner = state.selector;
    state.selector = (args) => {
      order.push("selector");
      return inner(args);
    };
    state.onAction = () => order.push("action");
    controller.startJournal();
    await controller.act({ action: "click", target: "Buy" });
    expect(order).toEqual(["selector", "action"]);
  });

  it("does not record scroll, wait, snapshot, read, screenshot or findImages, and they are no gap (a hover is a gap: see item 5 of round 3)", async () => {
    const { controller, state, page } = rig();
    page.sendCdp = async () => {};
    controller.startJournal();
    const { snapshotId } = (await controller.snapshot()) as { snapshotId: string };
    await controller.act({ action: "scroll" });
    await controller.act({ action: "wait", ms: 1 });
    await controller.perform({ snapshotId, operation: "SCROLL_DOWN" });
    await controller.read({});
    await controller.findImages({});
    expect(state.selectorCalls).toEqual([]);
    const r = ok(await controller.captureCheckpoint());
    expect(r.fixture.steps).toBeUndefined();
    expect(r.complete).toBe(true);
  });

  it("a command rejected by argument validation before any page effect leaves no trace", async () => {
    const { controller } = rig();
    controller.startJournal();
    const stale = await controller.act({ action: "click", index: 1, snapshotId: "stale" });
    expect(stale).toHaveProperty("error");
    expect(await controller.act({ action: "click" })).toHaveProperty("error");
    expect(await controller.act({ action: "type", target: "q" })).toHaveProperty("error");
    const r = ok(await controller.captureCheckpoint());
    expect(r.fixture.steps).toBeUndefined();
    expect(r.complete).toBe(true);
  });

  it("a waitFor is recorded before each click, type, select and press-with-selector (item 8), and is not counted", async () => {
    const { controller, page } = rig();
    page.sendCdp = async () => {};
    controller.startJournal();
    await controller.act({ action: "type", target: "city", text: "Ber" });
    await controller.act({ action: "click", target: "Berlin" });
    await controller.act({ action: "press", key: "Enter", target: "city" });
    await controller.act({ action: "press", key: "Tab" });
    const r = ok(await controller.captureCheckpoint());
    expect(r.fixture.steps).toEqual([
      wf("#city"), { action: "type", selector: "#city", text: "Ber" },
      wf("#Berlin"), { action: "click", selector: "#Berlin" },
      wf("#city"), { action: "press", key: "Enter", selector: "#city" },
      { action: "press", key: "Tab" },
    ]);
    // 4 actions, not 7 steps.
    expect(r.summary).toContain("4 replayable steps (1 type, 1 click, 2 press)");
    expect(r.summary).not.toContain("waitFor");
  });

  it("the cap counts actions, not the waitFor steps", () => {
    const j = new CheckpointJournal();
    j.reset({ marker: "m", url: "https://a.test/", cookies: [], origins: [] }, false);
    for (let i = 0; i < CHECKPOINT_MAX_STEPS; i++) j.record({ steps: [wf(`#b${i}`), { action: "click", selector: `#b${i}` }] });
    expect(j.complete).toBe(true);
    expect(j.steps).toHaveLength(2 * CHECKPOINT_MAX_STEPS);
    j.record({ steps: [wf("#x"), { action: "click", selector: "#x" }] });
    expect(j.complete).toBe(false);
    expect(j.gap).toBe(CHECKPOINT_GAPS.cap);
  });

  it("item 1: a selector lookup that finds nothing is a gap, not a silent drop (the action can still succeed)", async () => {
    const { controller, state } = rig();
    state.selector = () => ({ ok: false, reason: "not-found" });
    controller.startJournal();
    const click = await controller.act({ action: "click", target: "Buy" });
    expect(click).not.toHaveProperty("error");
    const r = ok(await controller.captureCheckpoint());
    expect(r.complete).toBe(false);
    expect(r.gap).toBe(CHECKPOINT_GAPS.noSelector);
    expect(r.fixture.steps).toBeUndefined();
  });

  it("item 2: a command that failed after it staged something is a gap; the threw branch is live", async () => {
    const { controller, state, target } = rig();
    // The click script itself reports an error: the element may have changed anyway.
    const page = target.pages.get(1)!;
    const inner = page.executeJavaScript.bind(page);
    page.executeJavaScript = async (code: string) => (code.includes("el.click()") ? { error: "boom" } : inner(code));
    controller.startJournal();
    const failed = await controller.act({ action: "click", target: "Buy" });
    expect(failed).toHaveProperty("error");
    let r = ok(await controller.captureCheckpoint());
    expect(r.complete).toBe(false);
    expect(r.gap).toBe(CHECKPOINT_GAPS.failed);
    expect(r.summary).not.toContain("boom");
    // An exception out of the command (not a result with an error) is the same.
    controller.startJournal();
    state.onAction = undefined;
    page.executeJavaScript = inner;
    ok(await controller.captureCheckpoint());
    const session = (controller as unknown as { journal: JournalSession }).journal;
    await expect(
      (controller as unknown as { runJournaled(fn: () => Promise<unknown>): Promise<unknown> }).runJournaled(async () => {
        // A command declares itself first (withCommandTimeout does), then stages.
        session.declare(session.current!, "action", page);
        session.stage(session.current!, page, { steps: [{ action: "click", selector: "#x" }] });
        throw new Error("thrown");
      }),
    ).rejects.toThrow("thrown");
    r = ok(await controller.captureCheckpoint());
    expect(r.gap).toBe(CHECKPOINT_GAPS.failed);
  });
});

describe("new document = reset (item 6 and 10)", () => {
  it("a click that loads a new document is not recorded; the new page is the base with fresh cookies and storage", async () => {
    const { controller, state, page } = rig();
    controller.startJournal();
    await controller.act({ action: "click", target: "Buy" });
    state.local = { step: "2" };
    state.cookies = [{ name: "sid2", value: "v2", domain: "shop.test" }];
    state.onAction = () => state.navigate(page, "https://shop.test/checkout");
    await controller.act({ action: "click", target: "Checkout" });
    const r = ok(await controller.captureCheckpoint());
    expect(r.fixture.url).toBe("https://shop.test/checkout");
    expect(r.fixture.steps).toBeUndefined();
    expect(r.fixture.storage).toEqual({ cookies: [{ name: "sid2", value: "v2", domain: "shop.test" }], origins: [{ origin: "https://shop.test", localStorage: { step: "2" } }] });
    // The journal records on the new page again.
    state.onAction = undefined;
    await controller.act({ action: "click", target: "Pay" });
    expect(ok(await controller.captureCheckpoint()).fixture.steps).toEqual([wf("#Pay"), { action: "click", selector: "#Pay" }]);
  });

  it("a pushState / hash change is NOT a reset: the steps continue on the old base", async () => {
    const { controller, state, page } = rig();
    controller.startJournal();
    state.onAction = () => {
      page.url = "https://shop.test/cart#details";
    };
    await controller.act({ action: "click", target: "Details" });
    state.onAction = () => {
      page.url = "https://shop.test/cart/shipping";
    };
    await controller.act({ action: "click", target: "Next" });
    state.onAction = undefined;
    await controller.act({ action: "type", target: "zip", text: "10115" });
    const r = ok(await controller.captureCheckpoint());
    expect(r.fixture.url).toBe("https://shop.test/cart");
    expect(r.fixture.steps).toEqual([
      wf("#Details"), { action: "click", selector: "#Details" },
      wf("#Next"), { action: "click", selector: "#Next" },
      wf("#zip"), { action: "type", selector: "#zip", text: "10115" },
    ]);
    expect(r.complete).toBe(true);
  });

  it("a same-URL new document (a form POST, location.reload()) resets", async () => {
    const { controller, state, page } = rig();
    controller.startJournal();
    await controller.act({ action: "click", target: "Buy" });
    state.onAction = () => state.docs.delete(page); // the URL stays the same
    await controller.act({ action: "click", target: "Submit" });
    state.onAction = undefined;
    const r = ok(await controller.captureCheckpoint());
    expect(r.fixture.url).toBe("https://shop.test/cart");
    expect(r.fixture.steps).toBeUndefined();
  });

  it("open, back, forward and reload reset, even for the same URL, with no hand-set flag", { timeout: 30_000 }, async () => {
    const { controller, page } = rig();
    controller.startJournal();
    for (const run of [
      () => controller.open({ url: "https://shop.test/cart" }),
      () => controller.act({ action: "reload" }),
      () => controller.act({ action: "back" }),
      () => controller.act({ action: "forward" }),
    ]) {
      await controller.act({ action: "click", target: "Buy" });
      expect(ok(await controller.captureCheckpoint()).fixture.steps).toEqual([wf("#Buy"), { action: "click", selector: "#Buy" }]);
      page.canGoBack = () => true;
      page.canGoForward = () => true;
      await run();
      expect(ok(await controller.captureCheckpoint()).fixture.steps).toBeUndefined();
    }
  });

  it("a back/forward that restores ANOTHER document resets; the restored marker differs from the base's", async () => {
    const { controller, state, page } = rig();
    controller.startJournal();
    await controller.act({ action: "click", target: "Buy" });
    // The user (or a bfcache restore) puts back a document the journal never saw.
    state.docs.set(page, "restored-old-doc");
    await controller.act({ action: "click", target: "Next" });
    const r = ok(await controller.captureCheckpoint());
    expect(r.fixture.steps).toEqual([wf("#Next"), { action: "click", selector: "#Next" }]);
  });

  it("a new tab gets its own journal; switching away and back CONTINUES the first tab's journal (typed value kept)", async () => {
    const { controller, target } = rig();
    controller.startJournal();
    await controller.act({ action: "type", target: "email", text: TYPED });
    await controller.tabs({ action: "new", url: "https://docs.test/help" });
    let r = ok(await controller.captureCheckpoint());
    expect(r.fixture.url).toBe("https://docs.test/help");
    expect(r.fixture.tabs).toEqual(["https://shop.test/cart"]);
    expect(r.fixture.steps).toBeUndefined();
    await controller.tabs({ action: "switch", tabId: 1 });
    r = ok(await controller.captureCheckpoint());
    expect(r.fixture.url).toBe("https://shop.test/cart");
    expect(r.fixture.tabs).toEqual(["https://docs.test/help"]);
    expect(r.fixture.steps).toEqual([wf("#email"), { action: "type", selector: "#email", text: TYPED }]);
    expect(r.complete).toBe(true);
    expect(target.currentId).toBe(1);
  });

  it("a page the user moved between commands resets before the next command", async () => {
    const { controller, state, page } = rig();
    controller.startJournal();
    await controller.act({ action: "click", target: "Buy" });
    state.navigate(page, "https://shop.test/elsewhere");
    await controller.act({ action: "click", target: "Other" });
    const r = ok(await controller.captureCheckpoint());
    expect(r.fixture.url).toBe("https://shop.test/elsewhere");
    expect(r.fixture.steps).toEqual([wf("#Other"), { action: "click", selector: "#Other" }]);
  });

  it("a page that cannot be asked for its marker is a gap (never falsely complete)", async () => {
    const { controller, state } = rig();
    controller.startJournal();
    await controller.act({ action: "click", target: "Buy" });
    state.markerFails = true;
    await controller.act({ action: "click", target: "Next" });
    const r = ok(await controller.captureCheckpoint());
    expect(r.complete).toBe(false);
    expect(r.gap).toBe(CHECKPOINT_GAPS.unknownDocument);
  });

  it("non-http pages have no URL, cookies or storage in the checkpoint", async () => {
    const { controller, state } = rig("about:blank");
    controller.startJournal();
    await controller.act({ action: "wait", ms: 1 });
    const r = ok(await controller.captureCheckpoint());
    expect(r.fixture).toEqual({ version: 1 });
    expect(state.cookieCalls).toEqual([]);
  });

  it("item 4: steps recorded on a base without an http(s) URL are a gap (they have no page to start on)", async () => {
    const { controller } = rig("about:blank");
    controller.startJournal();
    await controller.act({ action: "click", target: "Buy" });
    const r = ok(await controller.captureCheckpoint());
    expect(r.fixture).not.toHaveProperty("url");
    expect(r.fixture.steps).toEqual([wf("#Buy"), { action: "click", selector: "#Buy" }]);
    expect(r.complete).toBe(false);
    expect(r.gap).toBe(CHECKPOINT_GAPS.noStartUrl);
    expect(r.summary).toContain("incomplete");
    // Unit: the same on the journal, and an existing gap stays the first one.
    const j = new CheckpointJournal();
    j.reset({ marker: "m", url: "chrome://newtab", cookies: [], origins: [] }, false);
    j.record({ steps: [{ action: "click", selector: "#a" }] });
    expect(j.build([])).toMatchObject({ complete: false, gap: CHECKPOINT_GAPS.noStartUrl });
    j.addGap(CHECKPOINT_GAPS.iframe);
    expect(j.build([]).gap).toBe(CHECKPOINT_GAPS.iframe);
  });
});

describe("a late stage from a timed-out command (item 3)", () => {
  it("end to end: a lookup that outlives its own bound is ignored when it answers late; the tab gets a gap", async () => {
    const { controller } = rig("https://shop.test/cart");
    controller.startJournal();
    await controller.act({ action: "wait", ms: 1 });
    let first = true;
    const page = (controller as unknown as { target: { currentPage(): { executeJavaScript(code: string): Promise<unknown> } } }).target.currentPage();
    const exec = page.executeJavaScript.bind(page);
    // The first selector lookup answers only after its bound (3 s) ran out.
    page.executeJavaScript = (code: string) => {
      if (code.includes("function selectorFor") && first) {
        first = false;
        return new Promise((resolve) => setTimeout(() => resolve({ ok: true, selector: "#STALE", marker: "doc-late" }), 3_400));
      }
      return exec(code);
    };
    // The lookup is the journal's, outside the action's budget: the click itself still works.
    const slow = await controller.act({ action: "click", target: "Slow" });
    expect(slow).not.toHaveProperty("error");
    await controller.act({ action: "click", target: "Fresh" });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const r = ok(await controller.captureCheckpoint());
    expect(JSON.stringify(r.fixture.steps ?? [])).not.toContain("STALE");
    expect(r.complete).toBe(false);
    expect(r.gap).toBe(CHECKPOINT_GAPS.unknownDocument);
  }, 15_000);

  it("a journalPreAction of an ended command, landing during the next command, does not overwrite its staged step", async () => {
    const { controller, target } = rig();
    controller.startJournal();
    ok(await controller.captureCheckpoint());
    const ctrl = controller as unknown as {
      journal: JournalSession;
      runJournaled(fn: () => Promise<unknown>): Promise<unknown>;
      journalPreAction(...a: unknown[]): Promise<void>;
    };
    const page = target.pages.get(1)!;
    const stale = ctrl.journal.begin();
    ctrl.journal.end(stale);
    let staged: unknown;
    await ctrl.runJournaled(async () => {
      const now = ctrl.journal.current!;
      ctrl.journal.declare(now, "action", page);
      ctrl.journal.stage(now, page, { steps: [{ action: "click", selector: "#now" }] });
      await ctrl.journalPreAction(ctrl.journal, stale, page, { op: "click", locate: { target: "Slow" }, frameId: null }, () => true);
      staged = now.staged?.action;
      return {};
    });
    expect(staged).toEqual({ steps: [{ action: "click", selector: "#now" }] });
    expect(ok(await controller.captureCheckpoint()).fixture.steps).toEqual([{ action: "click", selector: "#now" }]);
  });

  it("a stage or settle by an ended command changes nothing (unit)", () => {
    const session = new JournalSession();
    const first = session.begin();
    session.end(first);
    const second = session.begin();
    const page = {} as never;
    expect(session.stage(first, page, { steps: [{ action: "click", selector: "#late" }] })).toBe(false);
    expect(first.staged).toBeNull();
    expect(session.stage(second, page, { steps: [{ action: "click", selector: "#now" }] })).toBe(true);
    expect(second.staged?.action).toEqual({ steps: [{ action: "click", selector: "#now" }] });
  });
});

describe("a retargeted type (item 4)", () => {
  it("is a gap: the text went into a different element than the one recorded", async () => {
    const { controller, target } = rig();
    controller.startJournal();
    const page = target.pages.get(1)!;
    const inner = page.executeJavaScript.bind(page);
    // dispatchType reports the retarget in its result; here a script answer that flags it.
    page.executeJavaScript = async (code: string) => {
      const out = await inner(code);
      return code.includes("setter.call") || code.includes("el.value") ? { ...(out as object), retargeted: true } : out;
    };
    const ctrl = controller as unknown as { dispatchType(...a: unknown[]): Promise<unknown> };
    const real = ctrl.dispatchType.bind(controller);
    ctrl.dispatchType = async (...a: unknown[]) => ({ ...((await real(...a)) as object), retargeted: true });
    const result = await controller.act({ action: "type", target: "city", text: TYPED });
    expect(result).toMatchObject({ retargeted: true });
    const r = ok(await controller.captureCheckpoint());
    expect(r.complete).toBe(false);
    expect(r.gap).toBe(CHECKPOINT_GAPS.retargeted);
    expect(JSON.stringify(r.fixture.steps ?? [])).not.toContain(TYPED);
    expect(r.gap).not.toContain(TYPED);
  });
});

describe("base storage of the current page first (item 5)", () => {
  it("sessionStorage comes from the CURRENT tab, not the first tab on the origin", async () => {
    const { controller, target, state } = rig();
    // Tab 1 and tab 2 are on the same origin; each tab has its own sessionStorage.
    const tab2 = await target.newPage!("https://shop.test/other");
    void tab2;
    const sessions = new Map<unknown, Record<string, string>>([[target.pages.get(1), { who: "tab-1" }], [target.pages.get(2), { who: "tab-2" }]]);
    for (const [, p] of target.pages) {
      const inner = p.executeJavaScript.bind(p);
      p.executeJavaScript = async (code: string) => (code.includes("const dump") ? JSON.stringify({ ok: true, localStorage: state.local, sessionStorage: sessions.get(p) ?? {} }) : inner(code));
    }
    controller.startJournal();
    await controller.act({ action: "wait", ms: 1 });
    const r = ok(await controller.captureCheckpoint());
    expect(target.currentId).toBe(2);
    expect(r.fixture.storage?.origins).toEqual([{ origin: "https://shop.test", sessionStorage: { who: "tab-2" } }]);
  });

  it("a failed read of the current page is a base gap", async () => {
    const { controller, target } = rig();
    const page = target.pages.get(1)!;
    const inner = page.executeJavaScript.bind(page);
    page.executeJavaScript = async (code: string) => (code.includes("const dump") ? JSON.stringify({ ok: false }) : inner(code));
    controller.startJournal();
    await controller.act({ action: "wait", ms: 1 });
    const r = ok(await controller.captureCheckpoint());
    expect(r.complete).toBe(false);
    expect(r.gap).toBe(CHECKPOINT_GAPS.base);
  });
});

describe("applyFixture with the journal on (item 7)", () => {
  const FIX = {
    version: 1 as const,
    url: "https://shop.test/form",
    storage: { cookies: [{ name: "sid", value: COOKIE, domain: "shop.test" }], origins: [{ origin: "https://shop.test", localStorage: { theme: STORE } }] },
    steps: [{ action: "click" as const, selector: "#cookie-ok" }],
    fresh: true,
    expect: { selector: "#anything" },
    network: [] as never[],
  };

  it("a successful apply makes the fixture the base on top of the state the profile held before: url, storage and steps survive a reset on the same document", async () => {
    const { controller, state } = rig();
    state.local = { live: "profile-key", theme: "light" };
    state.cookies = [{ name: "sid", value: "old-sid", domain: "shop.test" }, { name: "other", value: "kept", domain: "shop.test" }];
    controller.startJournal();
    const applied = await controller.applyFixture({ version: 1, url: FIX.url, storage: FIX.storage, steps: FIX.steps });
    expect(applied.ok).toBe(true);
    await controller.act({ action: "click", target: "Buy" });
    const r = ok(await controller.captureCheckpoint());
    expect(r.complete).toBe(true);
    expect(r.fixture.url).toBe(FIX.url);
    // Read BEFORE the apply, for the journal's origin and the fixture's: the profile's cookie "other" and key "live" stay; the fixture wins per cookie and per key.
    expect(state.cookieCalls[0]).toEqual(["https://shop.test"]);
    expect(r.fixture.storage?.cookies).toEqual([{ name: "sid", value: COOKIE, domain: "shop.test" }, { name: "other", value: "kept", domain: "shop.test" }]);
    expect(r.fixture.storage?.origins).toEqual([{ origin: "https://shop.test", localStorage: { live: "profile-key", theme: STORE } }]);
    expect(r.fixture).not.toHaveProperty("fresh");
    expect(r.fixture.steps).toEqual([{ action: "click", selector: "#cookie-ok" }, wf("#Buy"), { action: "click", selector: "#Buy" }]);
    // The fixture's steps are the base's, not the agent's: they do not count toward the cap, and not as replayable agent steps twice.
    expect(r.summary).toContain("2 replayable steps (2 click)");
  });

  it("a fresh fixture ignores the profile's earlier state, is not read, and the checkpoint says fresh: true", async () => {
    const { controller, state, target } = rig();
    target.resetSession = async () => {};
    state.local = { live: "profile-key" };
    controller.startJournal();
    const applied = await controller.applyFixture({ version: 1, url: FIX.url, storage: FIX.storage, fresh: true });
    expect(applied.ok).toBe(true);
    // No pre-apply read at all (the only cookie read is none: the base is the fixture's).
    expect(state.cookieCalls).toEqual([]);
    const r = ok(await controller.captureCheckpoint());
    expect(r.complete).toBe(true);
    expect(r.fixture.fresh).toBe(true);
    expect(r.fixture.storage).toEqual(FIX.storage);
  });

  it("a pre-apply read that fails is a base gap; origins [] reads nothing before the apply", async () => {
    const { controller, state, target } = rig();
    target.getCookies = async () => {
      throw new Error(`boom ${COOKIE}`);
    };
    controller.startJournal();
    await controller.applyFixture({ version: 1, url: FIX.url, storage: FIX.storage });
    const r = ok(await controller.captureCheckpoint());
    expect(r.complete).toBe(false);
    expect(r.gap).toBe(CHECKPOINT_GAPS.base);
    expect(r.fixture.storage).toEqual(FIX.storage);
    const reads = state.storageReads;
    controller.startJournal({ origins: [] });
    await controller.applyFixture({ version: 1, url: FIX.url, storage: FIX.storage });
    expect(state.storageReads).toBe(reads);
    expect(ok(await controller.captureCheckpoint()).fixture.storage).toEqual(FIX.storage);
  });

  it("network, fresh and expect are not copied into the checkpoint (the host owns them)", async () => {
    const { controller } = rig();
    controller.startJournal();
    await controller.applyFixture({ version: 1, url: FIX.url, fresh: true, steps: [{ action: "wait", ms: 1 }] });
    const r = ok(await controller.captureCheckpoint());
    expect(r.fixture).not.toHaveProperty("fresh");
    expect(r.fixture).not.toHaveProperty("expect");
    expect(r.fixture).not.toHaveProperty("network");
  });

  it("the base steps do not count toward the cap", async () => {
    const { controller } = rig();
    controller.startJournal();
    const many = Array.from({ length: CHECKPOINT_MAX_STEPS + 5 }, () => ({ action: "wait" as const, ms: 0 }));
    await controller.applyFixture({ version: 1, url: FIX.url, steps: many });
    await controller.act({ action: "click", target: "Buy" });
    const r = ok(await controller.captureCheckpoint());
    expect(r.complete).toBe(true);
    expect(r.fixture.steps).toHaveLength(many.length + 2);
  });

  it("a fixture with steps and no URL cannot be replayed from the page it ended on: a gap", async () => {
    const { controller } = rig();
    controller.startJournal();
    await controller.applyFixture({ version: 1, steps: [{ action: "wait", ms: 1 }] });
    const r = ok(await controller.captureCheckpoint());
    expect(r.complete).toBe(false);
    expect(r.gap).toBe(CHECKPOINT_GAPS.fixtureNoUrl);
  });

  it("a failed apply is a normal reset on the current page plus a gap", async () => {
    const { controller, target } = rig();
    controller.startJournal();
    await controller.act({ action: "click", target: "Buy" });
    const page = target.pages.get(1)!;
    const inner = page.executeJavaScript.bind(page);
    page.executeJavaScript = async (code: string) => (code.includes("#boom") ? JSON.stringify({ ok: false, error: "element not found" }) : inner(code));
    const bad = await controller.applyFixture({ version: 1, url: FIX.url, steps: [{ action: "click", selector: "#boom" }] });
    expect(bad.ok).toBe(false);
    const r = ok(await controller.captureCheckpoint());
    expect(r.complete).toBe(false);
    expect(r.gap).toBe(CHECKPOINT_GAPS.fixtureFailed);
    expect(r.fixture.steps).toBeUndefined();
  });
});

describe("gaps", () => {
  it("no unique selector: complete=false, a model-safe gap, recording stops until the next reset", async () => {
    const { controller, state, page } = rig();
    controller.startJournal();
    await controller.act({ action: "click", target: "First" });
    state.selector = () => ({ ok: false, reason: "no-unique" });
    await controller.act({ action: "click", target: "Weird" });
    state.selector = (args) => ({ ok: true, selector: `#${String(args.target)}` });
    await controller.act({ action: "click", target: "Later" });
    let r = ok(await controller.captureCheckpoint());
    expect(r.complete).toBe(false);
    expect(r.gap).toBe(CHECKPOINT_GAPS.noSelector);
    expect(r.fixture.steps).toEqual([wf("#First"), { action: "click", selector: "#First" }]);
    expect(r.summary).toBe(summarizeCheckpoint(r.fixture, false, r.gap));
    expect(r.summary).toContain("1 replayable step (1 click)");
    expect(r.summary).toContain(`incomplete: ${CHECKPOINT_GAPS.noSelector}`);
    // A page change clears the gap.
    state.navigate(page, "https://shop.test/next");
    await controller.act({ action: "wait", ms: 1 });
    r = ok(await controller.captureCheckpoint());
    expect(r.complete).toBe(true);
    expect(r.gap).toBeUndefined();
  });

  it("an unsupported element (a type into a non-text field) is a gap", async () => {
    const { controller, state } = rig();
    state.selector = () => ({ ok: false, reason: "unsupported" });
    controller.startJournal();
    await controller.act({ action: "type", target: "volume", text: "5" });
    expect(ok(await controller.captureCheckpoint()).gap).toBe(CHECKPOINT_GAPS.unsupported);
  });

  it("an element in a child frame is a gap, and no selector is computed for it", async () => {
    const { controller, state, page } = rig();
    page.executeJavaScriptInFrame = async () => ({ url: "https://frame.test/", title: "f" });
    controller.startJournal();
    const { snapshotId } = (await controller.snapshot()) as { snapshotId: string };
    (controller as unknown as { lastSnapshot: { frameMap: Map<number, unknown> } }).lastSnapshot.frameMap.set(7, { frameId: 42, localIndex: 0 });
    const r0 = await controller.perform({ snapshotId, index: 7, operation: "CLICK" });
    expect(r0).not.toHaveProperty("error");
    expect(state.selectorCalls).toEqual([]);
    const r = ok(await controller.captureCheckpoint());
    expect(r.complete).toBe(false);
    expect(r.gap).toBe(CHECKPOINT_GAPS.iframe);
  });

  it(`more than ${CHECKPOINT_MAX_STEPS} steps since the base is a gap; the first ${CHECKPOINT_MAX_STEPS} stay`, () => {
    const j = new CheckpointJournal();
    j.reset({ marker: "m", url: "https://a.test/", cookies: [], origins: [] }, false);
    for (let i = 0; i < CHECKPOINT_MAX_STEPS + 3; i++) j.record({ steps: [{ action: "click", selector: `#b${i}` }] });
    const r = j.build([]);
    expect(r.fixture.steps).toHaveLength(CHECKPOINT_MAX_STEPS);
    expect(r.fixture.steps![CHECKPOINT_MAX_STEPS - 1]).toEqual({ action: "click", selector: `#b${CHECKPOINT_MAX_STEPS - 1}` });
    expect(r.complete).toBe(false);
    expect(r.gap).toBe(CHECKPOINT_GAPS.cap);
    expect(r.summary).toContain(`${CHECKPOINT_MAX_STEPS} replayable steps`);
  });

  it("the controller records through the cap the same way (the 101st action is a gap)", async () => {
    const { controller } = rig();
    controller.startJournal();
    const session = (controller as unknown as { journal: JournalSession }).journal;
    ok(await controller.captureCheckpoint());
    const journal = session.forPage((controller as unknown as { target: { currentPage(): never } }).target.currentPage())!;
    for (let i = 0; i < CHECKPOINT_MAX_STEPS; i++) journal.record({ steps: [{ action: "click", selector: `#b${i}` }] });
    await controller.act({ action: "click", target: "One more" });
    const r = ok(await controller.captureCheckpoint());
    expect(r.fixture.steps).toHaveLength(CHECKPOINT_MAX_STEPS);
    expect(r.gap).toBe(CHECKPOINT_GAPS.cap);
  });

  it("a command that timed out may have acted: that is a gap", async () => {
    const { controller, state } = rig("https://shop.test/cart", { timeoutMs: 40 });
    controller.startJournal();
    state.onAction = () => {
      throw new Error("not used");
    };
    const page = (controller as unknown as { target: { currentPage(): { executeJavaScript(code: string): Promise<unknown> } } }).target.currentPage();
    const inner = page.executeJavaScript.bind(page);
    // The abandoned click settles later, so the next command does not wait out the overrun grace.
    page.executeJavaScript = (code: string) => (code.includes("el.click()") ? new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 150)) : inner(code));
    const result = await controller.act({ action: "click", target: "Slow" });
    expect(String((result as { error: string }).error)).toMatch(/timed out/);
    expect(ok(await controller.captureCheckpoint()).gap).toBe(CHECKPOINT_GAPS.timeout);
  });
});

describe("secrets stay out of summary and gap", () => {
  it("cookie value, storage value and typed text appear only in the fixture", async () => {
    const { controller, state } = rig();
    state.local = { token: STORE };
    controller.startJournal();
    await controller.act({ action: "type", target: "pw", text: TYPED });
    state.selector = () => ({ ok: false, reason: "no-unique" });
    await controller.act({ action: "click", target: "Odd" });
    const r = ok(await controller.captureCheckpoint());
    const json = JSON.stringify(r.fixture);
    expect(json).toContain(COOKIE);
    expect(json).toContain(STORE);
    expect(json).toContain(TYPED);
    for (const text of [r.summary, r.gap ?? ""]) {
      for (const secret of [COOKIE, STORE, TYPED, "sid", "token", "#pw"]) expect(text).not.toContain(secret);
    }
    expect(r.summary).toBe("checkpoint: start page https://shop.test/cart; 1 cookie; storage for 1 origin; 1 replayable step (1 type); incomplete: " + CHECKPOINT_GAPS.noSelector);
  });

  it("the summary keeps origin + pathname only (no query, no hash)", () => {
    const summary = summarizeCheckpoint({ version: 1, url: "https://a.test/p?token=abc#frag" }, true);
    expect(summary).toBe("checkpoint: start page https://a.test/p; 0 replayable steps");
  });
});

describe("CheckpointJournal", () => {
  it("a gap sticks (the first reason wins) and reset clears it", () => {
    const j = new CheckpointJournal();
    j.reset({ marker: "m", url: "https://a.test/", cookies: [], origins: [] }, false);
    j.record({ steps: [{ action: "click", selector: "#a" }] });
    j.record({ gap: CHECKPOINT_GAPS.iframe });
    j.record({ gap: CHECKPOINT_GAPS.cap });
    j.record({ steps: [{ action: "click", selector: "#b" }] });
    expect(j.build([]).gap).toBe(CHECKPOINT_GAPS.iframe);
    expect(j.steps).toHaveLength(1);
    j.reset({ marker: "m", url: "https://a.test/", cookies: [], origins: [] }, false);
    expect(j.build([]).complete).toBe(true);
  });

  it("build copies the steps and drops non-http tab URLs", () => {
    const j = new CheckpointJournal();
    j.reset({ marker: "m", url: "https://a.test/", cookies: [], origins: [] }, false);
    j.record({ steps: [{ action: "click", selector: "#a" }] });
    const built = j.build(["about:blank", "https://b.test/"]);
    expect(built.fixture.tabs).toEqual(["https://b.test/"]);
    built.fixture.steps!.push({ action: "wait", ms: 1 });
    expect(j.steps).toHaveLength(1);
  });
});

describe("review round 2", () => {
  it("item 1: origins [] reads no cookie and no storage; another origin's cookie never gets in (not even through getCookies([]))", async () => {
    const { controller, state, target } = rig();
    const OTHER = "sentinel-other-origin-cookie-9d4";
    // A real target reads getCookies([]) as "every cookie of the profile".
    target.getCookies = async (urls) => {
      state.cookieCalls.push(urls);
      return urls === undefined || urls.length === 0 ? [{ name: "bank", value: OTHER, domain: "bank.test" }, ...state.cookies] : state.cookies;
    };
    state.local = { theme: STORE };
    controller.startJournal({ origins: [] });
    await controller.act({ action: "click", target: "Buy" });
    expect(state.cookieCalls).toEqual([]);
    expect(state.storageReads).toBe(0);
    const r = ok(await controller.captureCheckpoint());
    expect(r.fixture.storage).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain(OTHER);
    expect(JSON.stringify(r.fixture)).not.toContain(STORE);
    expect(r.complete).toBe(true);
  });

  it("item 2: a back inside the same document (an SPA popstate) is a gap; a back to a new document is a normal reset", async () => {
    const { controller, page, state } = rig();
    page.canGoBack = () => true;
    page.canGoForward = () => true;
    controller.startJournal();
    await controller.act({ action: "click", target: "Buy" });
    // Same document: the marker survives, only the URL moves.
    page.goBack = () => { page.url = "https://shop.test/cart#prev"; };
    const back = await controller.act({ action: "back" });
    expect(back).not.toHaveProperty("error");
    let r = ok(await controller.captureCheckpoint());
    expect(r.complete).toBe(false);
    expect(r.gap).toBe(CHECKPOINT_GAPS.history);
    expect(r.summary).not.toContain("#prev");
    // The same for forward.
    controller.startJournal();
    await controller.act({ action: "click", target: "Buy" });
    page.goForward = () => { page.url = "https://shop.test/cart#next"; };
    await controller.act({ action: "forward" });
    expect(ok(await controller.captureCheckpoint()).gap).toBe(CHECKPOINT_GAPS.history);
    // A new document: the steps reset, the new page is the base.
    controller.startJournal();
    await controller.act({ action: "click", target: "Buy" });
    page.goBack = () => { state.docs.delete(page); page.url = "https://shop.test/old"; };
    await controller.act({ action: "back" });
    r = ok(await controller.captureCheckpoint());
    expect(r.complete).toBe(true);
    expect(r.fixture.url).toBe("https://shop.test/old");
    expect(r.fixture.steps).toBeUndefined();
  });

  it("item 2: a back that was refused (no history) changes nothing and is no gap", async () => {
    const { controller } = rig();
    controller.startJournal();
    const refused = await controller.act({ action: "back" });
    expect(refused).toHaveProperty("error");
    const r = ok(await controller.captureCheckpoint());
    expect(r.complete).toBe(true);
  });

  it("item 5: a key-only press records the focused element, so the replay focuses it first", async () => {
    const { controller, state, page } = rig();
    page.sendCdp = async () => {};
    state.selector = (args) => (args.op === "active" ? { ok: true, selector: "#search" } : { ok: true, selector: "#x" });
    controller.startJournal();
    await controller.act({ action: "press", key: "Enter" });
    expect(state.selectorCalls.map((c) => c.op)).toEqual(["active"]);
    expect(ok(await controller.captureCheckpoint()).fixture.steps).toEqual([wf("#search"), { action: "press", key: "Enter", selector: "#search" }]);
  });

  it("item 5: nothing focused but the body records the bare press; an iframe or an element without a selector is a gap", async () => {
    const { controller, state, page } = rig();
    page.sendCdp = async () => {};
    controller.startJournal();
    await controller.act({ action: "press", key: "Escape" });
    expect(ok(await controller.captureCheckpoint()).fixture.steps).toEqual([{ action: "press", key: "Escape" }]);
    state.selector = () => ({ ok: false, reason: "iframe" });
    controller.startJournal();
    await controller.act({ action: "press", key: "Tab" });
    expect(ok(await controller.captureCheckpoint()).gap).toBe(CHECKPOINT_GAPS.iframe);
    state.selector = () => ({ ok: false, reason: "no-unique" });
    controller.startJournal();
    await controller.act({ action: "press", key: "Tab" });
    const r = ok(await controller.captureCheckpoint());
    expect(r.gap).toBe(CHECKPOINT_GAPS.noSelector);
    expect(r.fixture.steps).toBeUndefined();
  });

  it("item 7: a read-only command reads no marker, no cookie and no storage", async () => {
    const { controller, state, page } = rig();
    page.sendCdp = async () => {};
    controller.startJournal();
    ok(await controller.captureCheckpoint());
    const markers = state.markerReads;
    const cookies = state.cookieCalls.length;
    const storage = state.storageReads;
    expect(markers).toBeGreaterThan(0);
    const { snapshotId } = (await controller.snapshot()) as { snapshotId: string };
    await controller.act({ action: "scroll" });
    await controller.act({ action: "wait", ms: 1 });
    await controller.perform({ snapshotId, operation: "SCROLL_DOWN" });
    await controller.read({});
    await controller.findImages({});
    await controller.tabs({ action: "list" });
    await controller.screenshot({}).catch(() => {});
    expect(state.markerReads).toBe(markers);
    expect(state.cookieCalls.length).toBe(cookies);
    expect(state.storageReads).toBe(storage);
    // A command that may change the page does read it.
    await controller.act({ action: "click", target: "Buy" });
    expect(state.markerReads).toBeGreaterThan(markers);
  });

  it("round 3, item 4: the sync before an action runs OUTSIDE the command's budget, bounded by the journal's own: a marker that never answers is a gap, the click still works", async () => {
    const { controller, page } = rig("https://shop.test/cart", { timeoutMs: 5_000 });
    controller.startJournal();
    await controller.act({ action: "click", target: "Buy" });
    const inner = page.executeJavaScript.bind(page);
    page.executeJavaScript = (code: string) => (code.includes("__penJournalDoc") ? new Promise(() => {}) : inner(code));
    const started = Date.now();
    const click = await controller.act({ action: "click", target: "Again" });
    // The journal's lookup is bound to 3 s and the settle check to 3 s more; none of it is the action's budget.
    expect(Date.now() - started).toBeLessThan(9_000);
    expect(click).not.toHaveProperty("error");
    page.executeJavaScript = inner;
    const r = ok(await controller.captureCheckpoint());
    expect(r.complete).toBe(false);
    expect(r.gap).toBe(CHECKPOINT_GAPS.unknownDocument);
  }, 15_000);

  it("item 8: startJournal returns an owner token; a stale token neither stops nor reads the new owner's journal", async () => {
    const { controller } = rig();
    const first = controller.startJournal();
    expect(typeof first).toBe("string");
    const second = controller.startJournal();
    expect(second).not.toBe(first);
    expect(controller.stopJournal(first)).toBe(false);
    const stale = await controller.captureCheckpoint(first);
    expect(stale).toMatchObject({ ok: false });
    expect((stale as { error: string }).error).toContain("another owner");
    await controller.act({ action: "click", target: "Buy" });
    expect(ok(await controller.captureCheckpoint(second)).fixture.steps).toBeDefined();
    expect(controller.stopJournal(second)).toBe(true);
    expect(await controller.captureCheckpoint(second)).toEqual({ ok: false, error: "the journal is not running (call startJournal first)" });
  });

  it("item 8: no token = back-compat, it acts on whatever journal runs", async () => {
    const { controller } = rig();
    controller.startJournal();
    await controller.act({ action: "click", target: "Buy" });
    expect(ok(await controller.captureCheckpoint()).fixture.steps).toBeDefined();
    expect(controller.stopJournal()).toBe(true);
    expect(controller.stopJournal()).toBe(false);
    expect((await controller.captureCheckpoint()).ok).toBe(false);
  });

  it("a capture with no earlier command reads the base then (read-only commands read no marker)", async () => {
    const { controller, state } = rig();
    state.local = { theme: "dark" };
    controller.startJournal();
    await controller.snapshot();
    const r = ok(await controller.captureCheckpoint());
    expect(r.fixture.url).toBe("https://shop.test/cart");
    expect(r.fixture.storage?.origins).toEqual([{ origin: "https://shop.test", localStorage: { theme: "dark" } }]);
  });

  it("a page that moved by itself after the last command is caught at capture (a delayed redirect)", async () => {
    const { controller, state, page } = rig();
    controller.startJournal();
    await controller.act({ action: "click", target: "Buy" });
    await controller.snapshot();
    state.navigate(page, "https://shop.test/after-redirect");
    const r = ok(await controller.captureCheckpoint());
    expect(r.fixture.url).toBe("https://shop.test/after-redirect");
    expect(r.fixture.steps).toBeUndefined();
  });
});

describe("review round 3", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** The page script answers `answer` for an action script (code containing `marker`) and runs the normal fake otherwise. */
  const failAction = (page: Rig["page"], marker: string, answer: Record<string, unknown>) => {
    const inner = page.executeJavaScript.bind(page);
    page.executeJavaScript = async (code: string) => (code.includes(marker) ? answer : inner(code));
  };

  describe("item 1: a miss that dispatched nothing is no gap", () => {
    it("lookup not-found + the click refuses with no match (nothing dispatched): no step, no gap, and the host does not see the marker", async () => {
      const { controller, state, page } = rig();
      state.selector = () => ({ ok: false, reason: "not-found" });
      failAction(page, "el.click()", { error: "No element matched: Buy", noEffect: true });
      controller.startJournal();
      const click = await controller.act({ action: "click", target: "Buy" });
      expect(click).toMatchObject({ error: "No element matched: Buy" });
      expect(click).not.toHaveProperty("noEffect");
      expect(Object.getOwnPropertySymbols(click)).not.toEqual([]); // the tag is a symbol: never serialized
      expect(JSON.stringify(click)).not.toContain("noEffect");
      const r = ok(await controller.captureCheckpoint());
      expect(r.complete).toBe(true);
      expect(r.gap).toBeUndefined();
      expect(r.fixture.steps).toBeUndefined();
    });

    it("the same error WITHOUT the no-effect proof stays a gap (a failed command that may have changed the page)", async () => {
      const { controller, state, page } = rig();
      state.selector = () => ({ ok: false, reason: "not-found" });
      failAction(page, "el.click()", { error: "No element matched: Buy" });
      controller.startJournal();
      expect(await controller.act({ action: "click", target: "Buy" })).toHaveProperty("error");
      expect(ok(await controller.captureCheckpoint()).gap).toBe(CHECKPOINT_GAPS.failed);
    });

    it("lookup not-found but the click succeeds anyway: still a gap (the action found an element the lookup missed)", async () => {
      const { controller, state } = rig();
      state.selector = () => ({ ok: false, reason: "not-found" });
      controller.startJournal();
      expect(await controller.act({ action: "click", target: "Buy" })).not.toHaveProperty("error");
      expect(ok(await controller.captureCheckpoint()).gap).toBe(CHECKPOINT_GAPS.noSelector);
    });

    it("a found selector and a refusal before the page was touched (a disabled control) leave no trace either", async () => {
      const { controller, page } = rig();
      failAction(page, "el.click()", { error: "the control is disabled", noEffect: true });
      controller.startJournal();
      expect(await controller.act({ action: "click", target: "Buy" })).toHaveProperty("error");
      const r = ok(await controller.captureCheckpoint());
      expect(r.complete).toBe(true);
      expect(r.fixture.steps).toBeUndefined();
    });

    it("a select with no matching option: nothing dispatched, no gap", async () => {
      const { controller, state, page } = rig();
      state.selector = () => ({ ok: false, reason: "not-found" });
      failAction(page, "selectedIndex", { error: 'No option matching "Nope" in element at index 3.', noEffect: true });
      controller.startJournal();
      const { snapshotId } = (await controller.snapshot()) as { snapshotId: string };
      expect(await controller.act({ action: "select", index: 3, snapshotId, text: "Nope" })).toHaveProperty("error");
      expect(await controller.perform({ snapshotId, index: 3, operation: "SELECT", text: "Nope" })).toHaveProperty("error");
      const r = ok(await controller.captureCheckpoint());
      expect(r.complete).toBe(true);
      expect(r.fixture.steps).toBeUndefined();
    });
  });

  describe("item 2: navigation inside the same document", () => {
    it("open to a hash-only change keeps the document: it is a gap (neither recorded nor silently dropped)", async () => {
      const { controller, page } = rig("https://app.test/");
      controller.startJournal();
      await controller.act({ action: "click", target: "Buy" });
      // A hash change loads no new document: the marker stays.
      page.loadURL = async (u: string) => { page.url = u; };
      const opened = await controller.open({ url: "https://app.test/#/settings" });
      expect(opened).not.toHaveProperty("error");
      const r = ok(await controller.captureCheckpoint());
      expect(r.complete).toBe(false);
      expect(r.gap).toBe(CHECKPOINT_GAPS.sameDocumentNav);
      expect(r.fixture.url).toBe("https://app.test/");
    });

    it("no false gap: an open that loads a new document, a tab switch and a tab list change nothing", async () => {
      const { controller } = rig("https://app.test/");
      controller.startJournal();
      await controller.act({ action: "click", target: "Buy" });
      await controller.open({ url: "https://app.test/other" });
      await controller.tabs({ action: "new", url: "https://docs.test/" });
      await controller.tabs({ action: "switch", tabId: 1 });
      await controller.tabs({ action: "list" });
      expect(ok(await controller.captureCheckpoint()).complete).toBe(true);
    });
  });

  describe("item 3: a timed-out action whose page navigated", () => {
    it("the new document is the base, and the overrun still adds the timeout gap to it", async () => {
      const { controller, state, page } = rig("https://shop.test/cart", { timeoutMs: 40 });
      controller.startJournal();
      state.onAction = () => state.navigate(page, "https://shop.test/after");
      const inner = page.executeJavaScript.bind(page);
      // The click navigates at once but answers late: the command times out while the page already moved.
      page.executeJavaScript = (code: string) => {
        const answer = inner(code);
        return code.includes("el.click()") ? new Promise((resolve) => setTimeout(() => resolve(answer), 200)) : answer;
      };
      const result = await controller.act({ action: "click", target: "Go" });
      expect(String((result as { error: string }).error)).toMatch(/timed out/);
      page.executeJavaScript = inner;
      const r = ok(await controller.captureCheckpoint());
      expect(r.fixture.url).toBe("https://shop.test/after");
      expect(r.complete).toBe(false);
      expect(r.gap).toBe(CHECKPOINT_GAPS.timeout);
    });
  });

  describe("item 4: the journal's sync runs before the action's own budget", () => {
    it("a slow first base read does not time out an action that works with the journal off", async () => {
      // A click settles in a few hundred ms in this fake; the base read takes longer than the whole budget.
      const { controller, target } = rig("https://shop.test/cart", { timeoutMs: 1_500 });
      target.getCookies = async () => {
        await sleep(2_000);
        return [];
      };
      controller.startJournal();
      const started = Date.now();
      const click = await controller.act({ action: "click", target: "Buy" });
      expect(Date.now() - started).toBeGreaterThan(1_900); // the read was waited for, outside the budget
      expect(click).not.toHaveProperty("error");
      const r = ok(await controller.captureCheckpoint());
      expect(r.complete).toBe(true);
      expect(r.fixture.steps).toEqual([wf("#Buy"), { action: "click", selector: "#Buy" }]);
    }, 15_000);

    it("a reset that outruns the journal's own budget is a gap, and the action still gets its full budget", async () => {
      const { controller, target, page } = rig("https://shop.test/cart");
      let hung = 0;
      // The first base read hangs on both reads (cookies: bounded to 5 s, storage: 10 s), so the journal's 10 s budget runs out.
      const cookies = target.getCookies!;
      target.getCookies = (urls) => (hung++ === 0 ? new Promise(() => {}) : cookies(urls));
      const inner = page.executeJavaScript.bind(page);
      let storageHung = false;
      page.executeJavaScript = (code: string) => (code.includes("const dump") && !storageHung && (storageHung = true) ? new Promise(() => {}) : inner(code));
      controller.startJournal();
      const click = await controller.act({ action: "click", target: "Buy" });
      expect(click).not.toHaveProperty("error");
      const r = ok(await controller.captureCheckpoint());
      expect(r.complete).toBe(false);
      expect(r.gap).toBe(CHECKPOINT_GAPS.unknownDocument);
    }, 30_000);
  });

  describe("item 5: hover", () => {
    it("a successful hover is a gap (it opened state no step replays); scroll stays unrecorded and no gap", async () => {
      const { controller, page } = rig();
      page.sendCdp = async () => {};
      controller.startJournal();
      await controller.act({ action: "scroll" });
      expect(ok(await controller.captureCheckpoint()).complete).toBe(true);
      const hover = await controller.act({ action: "hover", target: "Menu" });
      expect(hover).not.toHaveProperty("error");
      const r = ok(await controller.captureCheckpoint());
      expect(r.complete).toBe(false);
      expect(r.gap).toBe(CHECKPOINT_GAPS.hover);
      expect(r.summary).toContain(CHECKPOINT_GAPS.hover);
    });

    it("a later click on an element only the hover revealed is not reported as complete", async () => {
      const { controller, page } = rig();
      page.sendCdp = async () => {};
      controller.startJournal();
      await controller.act({ action: "hover", target: "Menu" });
      await controller.act({ action: "click", target: "Submenu item" });
      const r = ok(await controller.captureCheckpoint());
      expect(r.complete).toBe(false);
      expect(r.gap).toBe(CHECKPOINT_GAPS.hover);
    });

    it("a hover that found nothing changed nothing: no gap", async () => {
      const { controller, state, page } = rig();
      page.sendCdp = async () => {};
      state.hoverFound = false;
      controller.startJournal();
      expect(await controller.act({ action: "hover", target: "Nothing" })).toHaveProperty("error");
      expect(ok(await controller.captureCheckpoint()).complete).toBe(true);
    });

    it("a hover as the very first command still ends in a gap (the tab gets its base before the hover)", async () => {
      const { controller, page } = rig();
      page.sendCdp = async () => {};
      controller.startJournal();
      await controller.act({ action: "hover", target: "Menu" });
      expect(ok(await controller.captureCheckpoint()).gap).toBe(CHECKPOINT_GAPS.hover);
    });
  });

  describe("item 7: select", () => {
    it("an option whose value is shared with another option is a gap (the replay would pick the first one)", async () => {
      const { controller, state } = rig();
      state.selector = (args) => (args.op === "select" ? { ok: false, reason: "option-not-unique" } : { ok: true, selector: "#x" });
      controller.startJournal();
      const { snapshotId } = (await controller.snapshot()) as { snapshotId: string };
      expect(await controller.act({ action: "select", index: 3, snapshotId, text: "Large" })).not.toHaveProperty("error");
      const r = ok(await controller.captureCheckpoint());
      expect(r.complete).toBe(false);
      expect(r.gap).toBe(CHECKPOINT_GAPS.optionNotUnique);
      expect(r.fixture.steps).toBeUndefined();
    });
  });

  describe("item 8: page round trips", () => {
    it("a journaled click on a tab with a base costs the journal 2 page calls (selector + marker, then the settle check), not 3", async () => {
      const { controller, page } = rig();
      controller.startJournal();
      await controller.act({ action: "click", target: "Buy" });
      const inner = page.executeJavaScript.bind(page);
      const calls: string[] = [];
      page.executeJavaScript = (code: string) => {
        if (code.includes("__penJournalDoc")) calls.push(code.includes("function selectorFor") ? "selector+marker" : "marker");
        return inner(code);
      };
      await controller.act({ action: "click", target: "Again" });
      expect(calls).toEqual(["selector+marker", "marker"]);
    });

    it("the folded marker still detects a new document before the action: the old steps are dropped, the click is recorded on the new base", async () => {
      const { controller, state, page } = rig();
      controller.startJournal();
      await controller.act({ action: "click", target: "Buy" });
      state.navigate(page, "https://shop.test/elsewhere");
      await controller.act({ action: "click", target: "Other" });
      const r = ok(await controller.captureCheckpoint());
      expect(r.fixture.url).toBe("https://shop.test/elsewhere");
      expect(r.fixture.steps).toEqual([wf("#Other"), { action: "click", selector: "#Other" }]);
    });
  });

  describe("item 10: one owner of the command flags", () => {
    it("JournalSession.declare / skipSettle are the writers; stage no longer sets mutating", () => {
      const session = new JournalSession();
      const command = session.begin();
      const page = {} as never;
      session.stage(command, page, { steps: [] });
      expect(command.mutating).toBe(false);
      session.declare(command, "hover", page);
      expect(command).toMatchObject({ mutating: true, successGap: CHECKPOINT_GAPS.hover, actedPage: page });
      session.skipSettle(command);
      expect(command.mutating).toBe(false);
      session.end(command);
      const late = session.begin();
      session.end(late);
      session.declare(late, "action", page);
      expect(late.mutating).toBe(false);
    });
  });
});

describe("emulation", () => {
  it("the checkpoint carries the active emulation, and drops it after release", async () => {
    const { controller, page } = rig();
    page.sendCdp = async () => undefined;
    controller.startJournal();
    const applied = await controller.applyFixture({ version: 1, url: "https://shop.test/cart", emulate: { device: "iphone-15", colorScheme: "dark" } });
    expect(applied.ok, JSON.stringify(applied)).toBe(true);
    const withEmulation = ok(await controller.captureCheckpoint());
    expect(withEmulation.fixture.emulate).toEqual({ device: "iphone-15", colorScheme: "dark" });
    expect(withEmulation.summary).toContain("emulation (iphone-15");
    await controller.releaseFixture();
    expect("emulate" in ok(await controller.captureCheckpoint()).fixture).toBe(false);
  });
});

describe("upload", () => {
  const files = [{ name: "a.txt", text: "hi" }];

  it("a successful upload is a gap (the bytes cannot replay)", async () => {
    const { controller } = rig();
    controller.startJournal();
    const up = await controller.act({ action: "upload", target: "#f", files });
    expect(up).not.toHaveProperty("error");
    const r = ok(await controller.captureCheckpoint());
    expect(r.complete).toBe(false);
    expect(r.gap).toBe(CHECKPOINT_GAPS.upload);
    expect(r.summary).toContain(CHECKPOINT_GAPS.upload);
  });

  it("a refusal before the page is touched leaves no gap", async () => {
    const { controller, state } = rig();
    controller.startJournal();
    const bad = await controller.act({ action: "upload", target: "#f", files: [{ name: "a/b", text: "x" }] });
    expect(bad).toHaveProperty("error");
    const none = await controller.act({ action: "upload", target: "#f" });
    expect(none).toHaveProperty("error");
    expect(state.selectorCalls).toEqual([]);
    expect(ok(await controller.captureCheckpoint()).complete).toBe(true);
  });
});
