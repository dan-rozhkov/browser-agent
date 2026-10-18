import { afterEach, describe, expect, it } from "vitest";
import {
  bridgeWith,
  BROWSER_NOT_AVAILABLE_ERROR,
  browseAct,
  FOUND,
  j,
  resetEnvironment,
  snap,
  snapThenFail,
  stubLocate,
  throws,
} from "./executeHarness.js";
import { executeBrowseTool } from "../../src/agent/execute.js";
import { makeBridge } from "./executeHarness.js";
import type { ElementLocateOutcome } from "../../src/agent/execute.js";

const S_OK = snap("ok");

afterEach(resetEnvironment);

const EL = [{ index: 2, tag: "button", label: "Search", ops: ["CLICK"] }];
const PRE = snap("pre-1", EL);
const POST = snap("post-2", EL);
const NOTE_STALE =
  "this call took a fresh snapshot to resolve `element` — earlier snapshotIds are now stale; use this snapshotId for further index-based browse_act calls";
const noteNewer = (id: string) =>
  `a newer snapshot was taken after this action settled — use snapshot.snapshotId ("${id}") for further index-based browse_act calls, not the snapshotId this "resolved" carried`;
const UNSUPPORTED = (a: string) =>
  `browse_act: "element" is only supported for click, type, select, hover, press, and upload actions (got "${a}"). Use target or index instead.`;

describe("browse_act element: locate success", () => {
  it("snapshot -> locate -> act(index, snapshotId) -> trailing snapshot; resolved is reconciled", async () => {
    const bridge = bridgeWith({ snapshot: [PRE, POST], act: [{ url: "u", title: "t", matched: "Search" }] });
    const locate = stubLocate([FOUND(2, { label: "Search", confidence: 0.87 })]);

    const out = await browseAct({ action: "click", element: "the search button" });

    expect(bridge.calls).toEqual([
      { method: "snapshot", args: [] },
      { method: "act", args: [{ action: "click", index: 2, snapshotId: "pre-1" }] },
      { method: "snapshot", args: [] },
    ]);
    expect(locate.requests).toHaveLength(1);
    expect(locate.requests[0]).toEqual({ element: "the search button", action: "click", snapshot: PRE });
    expect(out).toBe(
      j({
        url: "u",
        title: "t",
        matched: "Search",
        resolved: { index: 2, label: "Search", confidence: 0.87, note: noteNewer("post-2") },
        snapshot: POST,
      })
    );
  });

  it("keeps resolved.snapshotId and the original note when the trailing snapshot fails", async () => {
    bridgeWith({ snapshot: [PRE, { error: "gone" }], act: [{ url: "u" }] });
    stubLocate([FOUND(2)]);
    const out = await browseAct({ action: "click", element: "x" });
    expect(out).toBe(
      j({
        url: "u",
        resolved: { index: 2, label: "Go", confidence: 0.9, snapshotId: "pre-1", note: NOTE_STALE },
      })
    );
  });

  it("does not attach a snapshot when act reports changed:false; resolved keeps its snapshotId", async () => {
    const bridge = bridgeWith({ snapshot: [PRE, POST], act: [{ changed: false }] });
    stubLocate([FOUND(2)]);
    const out = await browseAct({ action: "click", element: "x" });
    expect(bridge.methods()).toEqual(["snapshot", "act"]);
    expect(out).toBe(
      j({
        changed: false,
        resolved: { index: 2, label: "Go", confidence: 0.9, snapshotId: "pre-1", note: NOTE_STALE },
      })
    );
  });

  it("includes resolved on an act error and reconciles it with the trailing snapshot", async () => {
    bridgeWith({ snapshot: [PRE, POST], act: [{ error: "element is covered" }] });
    stubLocate([FOUND(2)]);
    expect(await browseAct({ action: "click", element: "x" })).toBe(
      j({
        error: "element is covered",
        resolved: { index: 2, label: "Go", confidence: 0.9, note: noteNewer("post-2") },
        snapshot: POST,
      })
    );
  });

  it("includes resolved when act rejects", async () => {
    bridgeWith({ snapshot: [PRE, POST], act: [throws(new Error("timeout"))] });
    stubLocate([FOUND(2)]);
    expect(await browseAct({ action: "click", element: "x" })).toBe(
      j({
        error: "timeout",
        resolved: { index: 2, label: "Go", confidence: 0.9, note: noteNewer("post-2") },
        snapshot: POST,
      })
    );
  });

  it("omits label/confidence from resolved when the backend did not send them", async () => {
    bridgeWith({ snapshot: [PRE, { error: "x" }], act: [{}] });
    stubLocate([{ outcome: "found", index: 0 }]);
    expect(await browseAct({ action: "click", element: "x" })).toBe(
      j({ resolved: { index: 0, snapshotId: "pre-1", note: NOTE_STALE } })
    );
  });

  it("replaces a non-object act result by the malformed error; resolved cannot be merged into it", async () => {
    bridgeWith({ snapshot: [PRE, { error: "x" }], act: [[1]] });
    stubLocate([FOUND(2)]);
    expect(await browseAct({ action: "click", element: "x" })).toBe(
      j({ error: "browse_act: malformed result from the browser bridge." })
    );
  });

  it("an empty act result {} still carries resolved (callBrowserBridge coalesces undefined)", async () => {
    bridgeWith({ snapshot: [PRE, { error: "x" }], act: [undefined] });
    stubLocate([FOUND(2)]);
    const out = JSON.parse(await browseAct({ action: "click", element: "x" }));
    expect(Object.keys(out)).toEqual(["resolved"]);
  });

  it("passes extra args through, drops target:'' and element, and overrides a model-sent index/snapshotId", async () => {
    const bridge = bridgeWith({ snapshot: [PRE, POST], act: [{ changed: false }] });
    stubLocate([FOUND(2)]);
    await browseAct({
      action: "type",
      element: "the name field",
      target: "",
      index: null,
      snapshotId: "model-old",
      text: "Ada",
      submit: true,
    });
    expect(bridge.callsTo("act")[0].args).toEqual([
      { action: "type", index: 2, snapshotId: "pre-1", text: "Ada", submit: true },
    ]);
  });

  it("maps each supported action to its locate operation", async () => {
    const map: Array<[string, Record<string, unknown>, string]> = [
      ["click", {}, "CLICK"],
      ["type", { text: "a" }, "TYPE_TEXT"],
      ["select", { text: "a" }, "SELECT"],
      ["hover", {}, "HOVER"],
      ["press", { key: "Enter" }, "FOCUS"],
    ];
    for (const [action, extra, op] of map) {
      bridgeWith({ snapshot: [PRE], act: [{ changed: false }] });
      const locate = stubLocate([FOUND(2)]);
      await browseAct({ action, element: "e", ...extra });
      expect(locate.requests[0].action).toBe(action);
      void op;
    }
  });

  it("repeats the snapshot+locate for an identical second call (no local cache)", async () => {
    const bridge = bridgeWith({ snapshot: [PRE], act: [{ changed: false }] });
    const locate = stubLocate([FOUND(2)]);
    await browseAct({ action: "click", element: "x" });
    await browseAct({ action: "click", element: "x" });
    expect(locate.requests).toHaveLength(2);
    expect(bridge.methods()).toEqual(["snapshot", "act", "snapshot", "act"]);
  });

  it("does not call the backend when index or target is present", async () => {
    const bridge = bridgeWith({ act: [{ changed: false }] });
    const locate = stubLocate([FOUND(2)]);
    await browseAct({ action: "click", element: "x", index: 0, snapshotId: "s" });
    await browseAct({ action: "click", element: "x", target: "T" });
    expect(locate.fetchMock).not.toHaveBeenCalled();
    expect(bridge.callsTo("act").map((c) => c.args)).toEqual([
      [{ action: "click", index: 0, snapshotId: "s" }],
      [{ action: "click", target: "T" }],
    ]);
  });
});

describe("browse_act element: locate outcomes that do not resolve", () => {
  const TRAIL = snap("trail-9");

  it("not_found names the reason and points at browse_snapshot (no act, trailing snapshot taken)", async () => {
    const bridge = bridgeWith({ snapshot: [PRE, TRAIL] });
    stubLocate([{ outcome: "not_found", reason: "no such button" }]);
    const out = await browseAct({ action: "click", element: "the buy button" });
    expect(bridge.methods()).toEqual(["snapshot", "snapshot"]);
    expect(out).toBe(
      j({
        error: 'No element matched "the buy button": no such button. Call browse_snapshot to see the elements and act by index.',
        snapshot: TRAIL,
      })
    );
  });

  it("not_found without a reason says 'not found'", async () => {
    bridgeWith({ snapshot: [PRE, { error: "x" }] });
    stubLocate([{ outcome: "not_found" }]);
    expect(await browseAct({ action: "click", element: "e" })).toBe(
      j({ error: 'No element matched "e": not found. Call browse_snapshot to see the elements and act by index.' })
    );
  });

  const unsure = (el: string, why: string) =>
    j({ error: `browse_act: could not confidently resolve "${el}" (${why}). Use target or index instead.` });

  it("retry outcome, with and without a reason", async () => {
    bridgeWith({ snapshot: snapThenFail(PRE, 2) });
    stubLocate([{ outcome: "retry", reason: "ambiguous" }, { outcome: "retry" }]);
    expect(await browseAct({ action: "click", element: "e" })).toBe(unsure("e", "ambiguous"));
    expect(await browseAct({ action: "click", element: "e" })).toBe(unsure("e", "try again or be more specific"));
  });

  it("found without a numeric index is treated as unresolved", async () => {
    const bridge = bridgeWith({ snapshot: snapThenFail(PRE, 2) });
    stubLocate([{ outcome: "found", index: "2" } as never, { outcome: "found" } as never]);
    expect(await browseAct({ action: "click", element: "e" })).toBe(unsure("e", "try again or be more specific"));
    expect(await browseAct({ action: "click", element: "e" })).toBe(unsure("e", "try again or be more specific"));
    expect(bridge.callsTo("act")).toHaveLength(0);
  });

  it("found with index 0 resolves (0 is a number)", async () => {
    const bridge = bridgeWith({ snapshot: [PRE], act: [{ changed: false }] });
    stubLocate([FOUND(0)]);
    await browseAct({ action: "click", element: "e" });
    expect(bridge.callsTo("act")[0].args).toEqual([{ action: "click", index: 0, snapshotId: "pre-1" }]);
  });

  it("a failed outcome returns the locator's message as the error", async () => {
    bridgeWith({ snapshot: snapThenFail(PRE, 1) });
    stubLocate([{ outcome: "failed", message: "locator says no" }]);
    expect(await browseAct({ action: "click", element: "e" })).toBe(j({ error: "locator says no" }));
  });

  it("a failed outcome without a usable message gets a default error, never a silent success", async () => {
    const DEFAULT = 'browse_act: element lookup failed while resolving "e". Use target or index instead.';
    for (const bad of [{ outcome: "failed" }, { outcome: "failed", message: "" }, { outcome: "failed", message: "  " }, { outcome: "failed", message: 5 }]) {
      bridgeWith({ snapshot: snapThenFail(PRE, 1) });
      stubLocate([bad as unknown as ElementLocateOutcome]);
      expect(await browseAct({ action: "click", element: "e" })).toBe(j({ error: DEFAULT }));
    }
  });

  it("elementActions replaces the default set and is listed in the refusal", async () => {
    const bridge = makeBridge({ snapshot: snapThenFail(PRE, 2) });
    const locateElement = async () => ({ outcome: "found" as const, index: 2 });
    const opts = { locateElement, elementActions: ["click", "focus"] };
    const err = async (args: Record<string, unknown>, o: typeof opts) =>
      JSON.parse(await executeBrowseTool(bridge.browser, "browse_act", args, o)).error;
    expect(await err({ action: "type", text: "a", element: "e" }, opts)).toBe(
      'browse_act: "element" is only supported for click and focus actions (got "type"). Use target or index instead.',
    );
    const three = { locateElement, elementActions: ["a", "b", "c"] };
    expect(await err({ action: "x", element: "e" }, three)).toBe(
      'browse_act: "element" is only supported for a, b, and c actions (got "x"). Use target or index instead.',
    );
  });

  it("a locator that throws is reported with the element and the message", async () => {
    bridgeWith({ snapshot: snapThenFail(PRE, 2) });
    stubLocate([]);
    const out = await executeBrowseTool(
      (await import("./executeHarness.js")).makeBridge({ snapshot: snapThenFail(PRE, 2) }).browser,
      "browse_act",
      { action: "click", element: "e" },
      {
        locateElement: async () => {
          throw new Error("boom");
        },
      },
    );
    expect(out).toBe(
      j({ error: 'browse_act: element lookup failed while resolving "e" (boom). Use target or index instead.' }),
    );
  });
});

describe("browse_act element: no locator (runBrowseAgent)", () => {
  it("refuses an element-only call before anything else, and never calls the bridge for it", async () => {
    const bridge = makeBridge({ snapshot: [S_OK] });
    const out = await executeBrowseTool(bridge.browser, "browse_act", { action: "scroll", element: "the list" });
    expect(JSON.parse(out).error).toBe("browse_act: element targeting is not available here. Use target or index instead.");
    expect(bridge.methods()).toEqual(["snapshot"]);
  });

  it("a batch with an element entry stops at it (no stale-order pre-check without a locator)", async () => {
    const bridge = makeBridge({ act: [{}], snapshot: [S_OK] });
    const out = JSON.parse(
      await executeBrowseTool(bridge.browser, "browse_act", {
        actions: [{ action: "click", element: "a" }, { action: "click", index: 1 }],
      }),
    );
    expect(out.stoppedAt).toBe(0);
    expect(out.completed).toBe(0);
    expect(bridge.callsTo("act")).toHaveLength(0);
  });
});

describe("browse_act element: snapshot failures before locate", () => {
  const cases: Array<[string, unknown, string]> = [
    ["bridge error result", { error: "tab closed" }, "tab closed"],
    ["malformed snapshot", { url: "u" }, "Malformed snapshot result"],
    ["rejecting snapshot", throws(new Error("boom")), "boom"],
    ["rejecting snapshot (non-Error)", throws("str"), "str"],
  ];
  for (const [name, step, msg] of cases) {
    it(`reports ${name} without calling the backend`, async () => {
      const bridge = bridgeWith({ snapshot: [step] });
      const locate = stubLocate([FOUND(1)]);
      const out = await browseAct({ action: "click", element: "the thing" });
      expect(locate.fetchMock).not.toHaveBeenCalled();
      expect(bridge.methods()).toEqual(["snapshot", "snapshot"]);
      expect(out).toBe(j({ error: `browse_act: could not resolve "the thing" — snapshot failed: ${msg}` }));
    });
  }
});

describe("browse_act element: validation before any round trip", () => {
  it("rejects type/select without non-empty text (missing, blank, non-string)", async () => {
    for (const action of ["type", "select"]) {
      for (const text of [undefined, "", "   ", 5]) {
        const bridge = bridgeWith({ snapshot: [{ error: "x" }] });
        const locate = stubLocate([FOUND(1)]);
        const args: Record<string, unknown> = { action, element: "e" };
        if (text !== undefined) args.text = text;
        const out = await browseAct(args);
        expect(out).toBe(j({ error: `browse_act: action "${action}" requires a non-empty "text" field.` }));
        expect(locate.fetchMock).not.toHaveBeenCalled();
        // pinned as-is: no locate/act, but the generic trailing snapshot is still attempted.
        expect(bridge.methods()).toEqual(["snapshot"]);
      }
    }
  });

  it("rejects press without a non-empty key", async () => {
    for (const key of [undefined, "", "  ", 13]) {
      const bridge = bridgeWith({ snapshot: [{ error: "x" }] });
      const locate = stubLocate([FOUND(1)]);
      const args: Record<string, unknown> = { action: "press", element: "e" };
      if (key !== undefined) args.key = key;
      expect(await browseAct(args)).toBe(j({ error: 'browse_act: action "press" requires a non-empty "key" field.' }));
      expect(locate.fetchMock).not.toHaveBeenCalled();
      expect(bridge.methods()).toEqual(["snapshot"]);
    }
  });

  it("click/hover need no extra field", async () => {
    for (const action of ["click", "hover"]) {
      bridgeWith({ snapshot: [PRE], act: [{ changed: false }] });
      const locate = stubLocate([FOUND(2)]);
      await browseAct({ action, element: "e" });
      expect(locate.requests).toHaveLength(1);
    }
  });

  it("rejects unsupported actions (scroll/back/forward/reload/wait/missing/non-string) before touching anything but the trailing snapshot", async () => {
    for (const action of ["scroll", "back", "forward", "reload", "wait", "teleport", undefined, 7]) {
      const bridge = bridgeWith({ snapshot: [{ error: "x" }] });
      const locate = stubLocate([FOUND(1)]);
      const args: Record<string, unknown> = { element: "e" };
      if (action !== undefined) args.action = action;
      const out = await browseAct(args);
      expect(out).toBe(j({ error: UNSUPPORTED(typeof action === "string" ? action : "") }));
      expect(locate.fetchMock).not.toHaveBeenCalled();
      expect(bridge.callsTo("act")).toHaveLength(0);
    }
  });

  it("with no bridge the unsupported-action and validation errors still win over 'not available'", async () => {
    expect(await browseAct({ action: "scroll", element: "e" })).toBe(j({ error: UNSUPPORTED("scroll") }));
    expect(await browseAct({ action: "type", element: "e" })).toBe(
      j({ error: 'browse_act: action "type" requires a non-empty "text" field.' })
    );
    expect(await browseAct({ action: "click", element: "e" })).toBe(j({ error: BROWSER_NOT_AVAILABLE_ERROR }));
  });
});
