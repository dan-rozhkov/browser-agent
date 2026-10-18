import { afterEach, describe, expect, it } from "vitest";
import {
  bridgeWith,
  BROWSER_NOT_AVAILABLE_ERROR,
  browseAct,
  COMMAND_FAILED,
  j,
  resetEnvironment,
  snap,
  throws,
} from "./executeHarness.js";

afterEach(resetEnvironment);

const S1 = snap("s-1");
const NOT_AVAILABLE = j({ error: BROWSER_NOT_AVAILABLE_ERROR });

describe("browse_act: forwarding every action kind", () => {
  // Argument validation lives on the desktop side — the handler forwards the
  // args object untouched (same key order) and then attaches a snapshot.
  const cases: Array<[string, Record<string, unknown>]> = [
    ["click by index + snapshotId", { action: "click", index: 3, snapshotId: "s-0" }],
    ["click by target", { action: "click", target: "Search" }],
    ["type by index", { action: "type", index: 1, snapshotId: "s-0", text: "hello", submit: true }],
    ["type by target", { action: "type", target: "#q", text: "hello" }],
    ["scroll with amount", { action: "scroll", amount: 2 }],
    ["scroll by index", { action: "scroll", index: 4, snapshotId: "s-0", amount: -1 }],
    ["back", { action: "back" }],
    ["forward", { action: "forward" }],
    ["press with key", { action: "press", key: "Enter" }],
    ["press by index", { action: "press", key: "Tab", index: 2, snapshotId: "s-0" }],
    ["hover by index", { action: "hover", index: 5, snapshotId: "s-0" }],
    ["hover by target", { action: "hover", target: "Menu" }],
    ["select by index", { action: "select", index: 6, snapshotId: "s-0", text: "Blue" }],
    ["reload", { action: "reload" }],
    ["wait with ms", { action: "wait", ms: 1500 }],
  ];

  for (const [name, args] of cases) {
    it(`forwards ${name} untouched, then attaches a snapshot`, async () => {
      const bridge = bridgeWith({ act: [{ url: "u", title: "t" }], snapshot: [S1] });
      const out = await browseAct(args);
      expect(bridge.calls).toEqual([
        { method: "act", args: [args] },
        { method: "snapshot", args: [] },
      ]);
      expect(out).toBe(j({ url: "u", title: "t", snapshot: S1 }));
    });
  }

  it("forwards an unknown action to the bridge (no local validation)", async () => {
    const bridge = bridgeWith({ act: [{ error: 'unknown action "teleport"' }], snapshot: [S1] });
    const out = await browseAct({ action: "teleport" });
    expect(bridge.calls).toEqual([
      { method: "act", args: [{ action: "teleport" }] },
      { method: "snapshot", args: [] },
    ]);
    // pinned as-is: the error result still gets a trailing snapshot.
    expect(out).toBe(j({ error: 'unknown action "teleport"', snapshot: S1 }));
  });

  it("forwards an empty args object and a non-string action as-is", async () => {
    const bridge = bridgeWith({ act: [{ error: "bad" }], snapshot: [{ error: "x" }] });
    expect(await browseAct({})).toBe(j({ error: "bad" }));
    expect(await browseAct({ action: 5 })).toBe(j({ error: "bad" }));
    expect(bridge.callsTo("act").map((c) => c.args)).toEqual([[{}], [{ action: 5 }]]);
  });

  it("forwards type/select/press with no text or key (validation is the bridge's job)", async () => {
    const bridge = bridgeWith({ act: [{ error: "text required" }], snapshot: [S1] });
    await browseAct({ action: "type", target: "Name" });
    await browseAct({ action: "select", index: 1, snapshotId: "s-0" });
    await browseAct({ action: "press" });
    expect(bridge.callsTo("act").map((c) => c.args)).toEqual([
      [{ action: "type", target: "Name" }],
      [{ action: "select", index: 1, snapshotId: "s-0" }],
      [{ action: "press" }],
    ]);
  });

  it("forwards both index and target together, index 0 included", async () => {
    const bridge = bridgeWith({ act: [{}], snapshot: [S1] });
    await browseAct({ action: "click", index: 0, target: "Go", snapshotId: "s-0" });
    expect(bridge.callsTo("act")[0].args).toEqual([
      { action: "click", index: 0, target: "Go", snapshotId: "s-0" },
    ]);
  });

  it("drops a blank/non-string `element` when no element route applies and forwards the rest", async () => {
    const bridge = bridgeWith({ act: [{}], snapshot: [S1] });
    await browseAct({ action: "click", target: "Go", element: "ignored" });
    await browseAct({ action: "click", target: "Go", element: "   " });
    await browseAct({ action: "back", element: 7 });
    expect(bridge.callsTo("act").map((c) => c.args)).toEqual([
      [{ action: "click", target: "Go" }],
      [{ action: "click", target: "Go" }],
      [{ action: "back" }],
    ]);
    expect(bridge.callsTo("snapshot")).toHaveLength(3);
  });

  it("treats a blank-string element with no target like a plain call, even for unsupported actions", async () => {
    const bridge = bridgeWith({ act: [{ ok: 1 }], snapshot: [S1] });
    const out = await browseAct({ action: "scroll", element: "" });
    expect(bridge.callsTo("act")[0].args).toEqual([{ action: "scroll" }]);
    expect(out).toBe(j({ ok: 1, snapshot: S1 }));
  });

  it("treats an empty-string target as no target for the element route", async () => {
    // hasTarget is false for "" so `element` wins; see browseAct.element.test.ts
    // for the full flow. Here only the validation short-circuit is observed.
    const bridge = bridgeWith({ snapshot: [S1] });
    const out = await browseAct({ action: "scroll", target: "", element: "the list" });
    expect(out).toBe(
      j({
        error:
          'browse_act: "element" is only supported for click, type, select, hover, press, and upload actions (got "scroll"). Use target or index instead.',
        snapshot: S1,
      })
    );
    expect(bridge.methods()).toEqual(["snapshot"]);
  });
});

describe("browse_act: result passthrough and key order", () => {
  it("keeps the bridge's key order and appends snapshot last", async () => {
    bridgeWith({ act: [{ z: 1, a: 2, changed: true }], snapshot: [S1] });
    expect(await browseAct({ action: "click", target: "x" })).toBe(
      '{"z":1,"a":2,"changed":true,"snapshot":' + j(S1) + "}"
    );
  });

  it("passes the whole bridge snapshot object through unfiltered", async () => {
    const rich = { ...S1, extra: { nested: [1, 2] }, scrollY: 40 };
    bridgeWith({ act: [{}], snapshot: [rich] });
    expect(await browseAct({ action: "back" })).toBe(j({ snapshot: rich }));
  });

  it("coalesces an undefined / null bridge result to {} before attaching", async () => {
    bridgeWith({ act: [undefined, null], snapshot: [S1] });
    expect(await browseAct({ action: "back" })).toBe(j({ snapshot: S1 }));
    expect(await browseAct({ action: "back" })).toBe(j({ snapshot: S1 }));
  });

  it("turns a non-object bridge result into the malformed-result error (and still snapshots)", async () => {
    const bridge = bridgeWith({ act: [[1, 2], "text", 42], snapshot: [S1] });
    const malformed = { error: "browse_act: malformed result from the browser bridge.", snapshot: S1 };
    expect(await browseAct({ action: "back" })).toBe(j(malformed));
    expect(await browseAct({ action: "back" })).toBe(j(malformed));
    expect(await browseAct({ action: "back" })).toBe(j(malformed));
    expect(bridge.callsTo("snapshot")).toHaveLength(3);
  });
});

describe("browse_act: snapshot attachment rules", () => {
  it("attaches when changed is true", async () => {
    bridgeWith({ act: [{ changed: true }], snapshot: [S1] });
    expect(await browseAct({ action: "click", target: "x" })).toBe(j({ changed: true, snapshot: S1 }));
  });

  it("attaches when changed is missing", async () => {
    bridgeWith({ act: [{ url: "u" }], snapshot: [S1] });
    expect(await browseAct({ action: "click", target: "x" })).toBe(j({ url: "u", snapshot: S1 }));
  });

  it("attaches when changed is a non-false falsy value (null, 0)", async () => {
    // pinned as-is: only the strict value `false` suppresses the snapshot.
    bridgeWith({ act: [{ changed: null }, { changed: 0 }], snapshot: [S1] });
    expect(await browseAct({ action: "click", target: "x" })).toBe(j({ changed: null, snapshot: S1 }));
    expect(await browseAct({ action: "click", target: "x" })).toBe(j({ changed: 0, snapshot: S1 }));
  });

  it("does not attach when changed is false for click/type/hover/press/select/back/forward/reload", async () => {
    for (const action of ["click", "type", "hover", "press", "select", "back", "forward", "reload", "other"]) {
      const bridge = bridgeWith({ act: [{ changed: false }], snapshot: [S1] });
      expect(await browseAct({ action, target: "x" })).toBe(j({ changed: false }));
      expect(bridge.methods()).toEqual(["act"]);
    }
  });

  it("always attaches for wait and scroll, even with changed: false", async () => {
    for (const action of ["wait", "scroll"]) {
      const bridge = bridgeWith({ act: [{ changed: false }], snapshot: [S1] });
      expect(await browseAct({ action })).toBe(j({ changed: false, snapshot: S1 }));
      expect(bridge.methods()).toEqual(["act", "snapshot"]);
    }
  });

  it("attaches to an { error } result (errs toward giving a fresh read)", async () => {
    bridgeWith({ act: [{ error: "stale snapshotId" }], snapshot: [S1] });
    expect(await browseAct({ action: "click", index: 1, snapshotId: "old" })).toBe(
      j({ error: "stale snapshotId", snapshot: S1 })
    );
  });

  it("does not attach to an error result that also says changed:false (non wait/scroll)", async () => {
    bridgeWith({ act: [{ error: "e", changed: false }], snapshot: [S1] });
    expect(await browseAct({ action: "click", target: "x" })).toBe(j({ error: "e", changed: false }));
  });

  it("returns the result unchanged when the trailing snapshot errors", async () => {
    bridgeWith({ act: [{ ok: true }], snapshot: [{ error: "tab closed" }] });
    expect(await browseAct({ action: "click", target: "x" })).toBe(j({ ok: true }));
  });

  it("returns the result unchanged when the trailing snapshot is malformed", async () => {
    bridgeWith({ act: [{ ok: true }], snapshot: [{ url: "u" }] });
    expect(await browseAct({ action: "click", target: "x" })).toBe(j({ ok: true }));
  });

  it("returns the result unchanged when the trailing snapshot rejects", async () => {
    bridgeWith({ act: [{ ok: true }], snapshot: [throws(new Error("boom"))] });
    expect(await browseAct({ action: "click", target: "x" })).toBe(j({ ok: true }));
  });

  it("does not touch a snapshot key the bridge result already had when no new snapshot is attached", async () => {
    bridgeWith({ act: [{ changed: false, snapshot: "mine" }], snapshot: [S1] });
    expect(await browseAct({ action: "click", target: "x" })).toBe(j({ changed: false, snapshot: "mine" }));
  });

  it("overwrites a bridge-provided snapshot key with the fresh one, keeping its key position", async () => {
    bridgeWith({ act: [{ snapshot: "mine", after: 1 }], snapshot: [S1] });
    expect(await browseAct({ action: "click", target: "x" })).toBe(j({ snapshot: S1, after: 1 }));
  });
});

describe("browse_act: bridge failure modes", () => {
  it("returns the not-available error when there is no bridge, with no calls possible", async () => {
    expect(await browseAct({ action: "click", target: "x" })).toBe(NOT_AVAILABLE);
    expect(await browseAct({ action: "click", target: "x", element: "y" })).toBe(NOT_AVAILABLE);
    expect(await browseAct({ action: "click", element: "y" }, { sessionId: "chat-1" })).toBe(NOT_AVAILABLE);
  });

  it("converts a rejecting act (Error) into { error: message } and still snapshots", async () => {
    const bridge = bridgeWith({ act: [throws(new Error("no browser tab open"))], snapshot: [S1] });
    expect(await browseAct({ action: "back" })).toBe(j({ error: "no browser tab open", snapshot: S1 }));
    expect(bridge.methods()).toEqual(["act", "snapshot"]);
  });

  it("converts a rejecting act (non-Error) into the generic failure message", async () => {
    bridgeWith({ act: [throws("string failure")], snapshot: [{ error: "x" }] });
    expect(await browseAct({ action: "back" })).toBe(j({ error: COMMAND_FAILED }));
  });

  it("passes a bridge { ok:false, error } result through (error text kept, other keys kept)", async () => {
    bridgeWith({ act: [{ ok: false, error: "element not found" }], snapshot: [S1] });
    expect(await browseAct({ action: "click", target: "x" })).toBe(
      j({ ok: false, error: "element not found", snapshot: S1 })
    );
  });

  it("forwards a result that is { ok:false } without an error string as a plain result", async () => {
    bridgeWith({ act: [{ ok: false }], snapshot: [S1] });
    expect(await browseAct({ action: "click", target: "x" })).toBe(j({ ok: false, snapshot: S1 }));
  });

  it("does not sanitize or truncate large bridge output", async () => {
    const big = "x".repeat(50_000);
    bridgeWith({ act: [{ text: big, changed: false }] });
    expect(await browseAct({ action: "back" })).toBe(j({ text: big, changed: false }));
  });

  it("treats a non-array `actions` value as a plain call and forwards it to the bridge", async () => {
    // pinned as-is: the destructured `actions` is dropped for the routing
    // decision, but performOne receives the ORIGINAL args, so the odd field
    // reaches the desktop bridge.
    const bridge = bridgeWith({ act: [{ changed: false }] });
    await browseAct({ action: "back", actions: "nope" });
    expect(bridge.callsTo("act")[0].args).toEqual([{ action: "back", actions: "nope" }]);
  });
});
