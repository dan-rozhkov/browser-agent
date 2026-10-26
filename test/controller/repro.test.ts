import { describe, expect, it, vi } from "vitest";
import { BrowserController, type BrowserPageHandle, type BrowserTarget } from "../../src/controller/controller.js";
import { REPRO_KEY } from "../../src/shared/trace.js";

function fakePage(over: Partial<BrowserPageHandle> = {}): BrowserPageHandle {
  return {
    loadURL: vi.fn(() => Promise.resolve()),
    executeJavaScript: vi.fn(() => Promise.resolve({ ok: true })),
    getURL: vi.fn(() => "https://example.com/"),
    getTitle: vi.fn(() => "Example"),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
    isLoading: vi.fn(() => false),
    onceDomReady: vi.fn(() => Promise.resolve()),
    ...over,
  };
}
const targetOf = (page: BrowserPageHandle): BrowserTarget => ({ ensurePage: async () => page, currentPage: () => page });

type Args = Record<string, unknown>;

/** A page that answers LOCATOR_JS with `locator(args)` (or throws when it returns undefined) and records the calls. */
function rig(locator: (args: Args) => unknown) {
  const locatorCalls: Args[] = [];
  const page = fakePage({
    executeJavaScript: vi.fn((code: string) => {
      if (code.includes("function locatorFor")) {
        const args = JSON.parse(/var args = (\{.*\});/.exec(code)![1]!) as Args;
        locatorCalls.push(args);
        const answer = locator(args);
        return answer === undefined ? Promise.reject(new Error("page gone")) : Promise.resolve(answer);
      }
      if (code.includes("function checkElement")) return Promise.resolve({ results: [{ passed: true }, { passed: true }] });
      if (code.includes("focused: true")) return Promise.resolve({ focused: true });
      if (code.includes("data-pen-sig-mainimg")) {
        return Promise.resolve({ url: "https://example.com/", title: "Example", nodeCount: 1, textLength: 0, textHash: 0, mainImageSrc: "", scrollY: 0, focusedValueLength: 0 });
      }
      return Promise.resolve({ matched: "Go" });
    }),
  });
  return { page, controller: new BrowserController(targetOf(page), { cursor: false }), locatorCalls };
}

const found = { ok: true, locator: { kind: "role", role: "button", name: "Go" } };

describe("act with repro", () => {
  it("without repro: no __repro and no locator script", async () => {
    const r = rig(() => found);
    const result = await r.controller.act({ action: "click", target: "Go" });
    expect(result).not.toHaveProperty(REPRO_KEY);
    expect(result).not.toHaveProperty("error");
    expect(r.locatorCalls).toEqual([]);
    const off = await r.controller.act({ action: "click", target: "Go", repro: false });
    expect(off).not.toHaveProperty(REPRO_KEY);
    expect(r.locatorCalls).toEqual([]);
  });

  it("with repro: adds the script's locator, found before the action", async () => {
    const r = rig(() => found);
    const result = await r.controller.act({ action: "click", target: "Go", repro: true });
    expect(result).not.toHaveProperty("error");
    expect(result[REPRO_KEY]).toEqual({ locator: found.locator });
    expect(r.locatorCalls).toEqual([{ target: "Go", op: "click" }]);
    // The same result as without the flag, apart from the key.
    const plain = await r.controller.act({ action: "click", target: "Go" });
    const { [REPRO_KEY]: _repro, ...rest } = result;
    expect(rest).toEqual(plain);
  });

  it("carries secret and the chosen option value", async () => {
    const r = rig((args) => (args.op === "select" ? { ...found, value: "v2" } : { ...found, secret: true }));
    const typed = await r.controller.act({ action: "type", target: "Password", text: "hunter2", repro: true });
    expect(typed[REPRO_KEY]).toEqual({ locator: found.locator, secret: true });
    const snap = (await r.controller.snapshot()) as { snapshotId: string };
    const picked = await r.controller.act({ action: "select", index: 0, snapshotId: snap.snapshotId, text: "Two", repro: true });
    expect(picked[REPRO_KEY]).toEqual({ locator: found.locator, value: "v2" });
    expect(r.locatorCalls[1]).toMatchObject({ index: 0, snapshotId: snap.snapshotId, op: "select", optionText: "Two" });
  });

  it("hover and press with a target ask for the locator; a key-only press and wait do not", async () => {
    const r = rig(() => found);
    // The fake tab has no CDP session, so the hover itself fails (and then carries no __repro); the locator was still asked for first.
    await r.controller.act({ action: "hover", target: "Menu", repro: true });
    expect(r.locatorCalls).toEqual([{ target: "Menu", op: "hover" }]);
    await r.controller.act({ action: "press", key: "Enter", target: "Go", repro: true });
    expect(r.locatorCalls[1]).toEqual({ target: "Go", op: "press" });
    expect(await r.controller.act({ action: "press", key: "Enter", repro: true })).not.toHaveProperty(REPRO_KEY);
    expect(r.locatorCalls).toHaveLength(2);
    expect(await r.controller.act({ action: "wait", ms: 1, repro: true })).not.toHaveProperty(REPRO_KEY);
  });

  it("a script failure or a not-ok answer becomes a gap, never an error", async () => {
    const thrown = rig(() => undefined);
    const a = await thrown.controller.act({ action: "click", target: "Go", repro: true });
    expect(a).not.toHaveProperty("error");
    expect(a[REPRO_KEY]).toEqual({ gap: "not-found" });
    const shadow = rig(() => ({ ok: false, reason: "shadow" }));
    expect((await shadow.controller.act({ action: "click", target: "Go", repro: true }))[REPRO_KEY]).toEqual({ gap: "shadow" });
  });

  it("a failed action gets no __repro", async () => {
    const r = rig(() => found);
    const result = await r.controller.act({ action: "click", repro: true });
    expect(result).toHaveProperty("error");
    expect(result).not.toHaveProperty(REPRO_KEY);
  });
});

describe("assert with repro", () => {
  it("without repro the result has no __repro", async () => {
    const r = rig(() => found);
    expect(await r.controller.assert({ checks: [{ type: "text", text: "x" }] })).not.toHaveProperty(REPRO_KEY);
  });

  it("one entry per check: a locator for an index check, a gap when the page cannot name it, null otherwise", async () => {
    const r = rig((args) => (args.index === 1 ? { ok: false, reason: "no-unique" } : found));
    const snap = (await r.controller.snapshot()) as { snapshotId: string };
    const result = await r.controller.assert({
      snapshotId: snap.snapshotId,
      repro: true,
      checks: [
        { type: "element", index: 0, state: "visible" },
        { type: "text", text: "x" },
        { type: "value", index: 1, equals: "a" },
      ],
    });
    expect(result[REPRO_KEY]).toEqual({ checks: [{ locator: found.locator }, null, { gap: "no-unique" }] });
    expect(result).toMatchObject({ ok: true });
  });

  it("a stale snapshot gives a gap, not a throw", async () => {
    const r = rig(() => found);
    await r.controller.snapshot();
    const result = await r.controller.assert({ repro: true, snapshotId: "nope", checks: [{ type: "element", index: 0, state: "visible" }] });
    expect(result[REPRO_KEY]).toEqual({ checks: [{ gap: "not-found" }] });
  });
});
