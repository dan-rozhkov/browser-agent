import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bridgeWith,
  BROWSER_NOT_AVAILABLE_ERROR,
  browseAct,
  FOUND,
  j,
  resetEnvironment,
  runActionsBatch,
  snap,
  stubLocate,
  throws,
  makeBridge,
} from "./executeHarness.js";
import { runActionsBatch as runBatch, type ElementLocateOutcome } from "../../src/agent/execute.js";

afterEach(resetEnvironment);

const FINAL = snap("final-1");
const NOTE_STALE =
  "this call took a fresh snapshot to resolve `element` — earlier snapshotIds are now stale; use this snapshotId for further index-based browse_act calls";

describe("browse_act batch: order, results shape, snapshot", () => {
  it("runs entries in order and attaches exactly one trailing snapshot", async () => {
    const bridge = bridgeWith({
      act: [{ n: 1 }, { n: 2, changed: false }, { n: 3 }],
      snapshot: [FINAL],
    });
    const out = await browseAct({
      snapshotId: "top",
      actions: [
        { action: "click", index: 1 },
        { action: "type", index: 2, text: "hi" },
        { action: "scroll", amount: 1 },
      ],
    });
    expect(bridge.calls).toEqual([
      { method: "act", args: [{ action: "click", index: 1, snapshotId: "top" }] },
      { method: "act", args: [{ action: "type", index: 2, text: "hi", snapshotId: "top" }] },
      { method: "act", args: [{ action: "scroll", amount: 1 }] },
      { method: "snapshot", args: [] },
    ]);
    // Key order: results, completed, snapshot. No per-entry snapshots.
    expect(out).toBe(j({ results: [{ n: 1 }, { n: 2, changed: false }, { n: 3 }], completed: 3, snapshot: FINAL }));
  });

  it("ignores every other top-level field (action, index, target...) when actions is an array", async () => {
    const bridge = bridgeWith({ act: [{}], snapshot: [FINAL] });
    await browseAct({ action: "back", index: 9, actions: [{ action: "reload" }] });
    expect(bridge.callsTo("act").map((c) => c.args)).toEqual([[{ action: "reload" }]]);
  });

  it("only copies the top-level snapshotId into entries carrying an index (index 0 counts; targets/press do not)", async () => {
    const bridge = bridgeWith({ act: [{}], snapshot: [FINAL] });
    await browseAct({
      snapshotId: "top",
      actions: [
        { action: "click", index: 0 },
        { action: "click", target: "T" },
        { action: "press", key: "Enter" },
        { action: "click", index: null },
        { action: "click", index: 4, snapshotId: "own" },
        { action: "click", index: 5, snapshotId: null },
      ],
    });
    expect(bridge.callsTo("act").map((c) => c.args[0])).toEqual([
      { action: "click", index: 0, snapshotId: "top" },
      { action: "click", target: "T" },
      { action: "press", key: "Enter" },
      { action: "click", index: null },
      { action: "click", index: 4, snapshotId: "own" },
      { action: "click", index: 5, snapshotId: "top" },
    ]);
  });

  it("does not inject anything when the top-level snapshotId is absent or not a string", async () => {
    const bridge = bridgeWith({ act: [{}], snapshot: [FINAL] });
    await browseAct({ actions: [{ action: "click", index: 1 }] });
    await browseAct({ snapshotId: 7, actions: [{ action: "click", index: 1 }] });
    expect(bridge.callsTo("act").map((c) => c.args[0])).toEqual([
      { action: "click", index: 1 },
      { action: "click", index: 1 },
    ]);
  });

  it("omits the snapshot key when the trailing snapshot fails, keeping the rest", async () => {
    bridgeWith({ act: [{ ok: 1 }], snapshot: [{ error: "x" }] });
    expect(await browseAct({ actions: [{ action: "back" }] })).toBe(j({ results: [{ ok: 1 }], completed: 1 }));
  });

  it("does not apply the per-action wait/scroll/changed snapshot rules inside a batch", async () => {
    const bridge = bridgeWith({ act: [{ changed: true }, { changed: false }], snapshot: [FINAL] });
    await browseAct({ actions: [{ action: "wait" }, { action: "scroll" }] });
    expect(bridge.methods()).toEqual(["act", "act", "snapshot"]);
  });

  it("keeps resolved.snapshotId in element entries (no reconcile inside a batch)", async () => {
    const pre = snap("pre", [{ index: 2, tag: "button", label: "B", ops: ["CLICK"] }]);
    const bridge = bridgeWith({ snapshot: [pre, FINAL], act: [{ url: "u" }] });
    stubLocate([FOUND(2)]);
    const out = await browseAct({ actions: [{ action: "click", element: "the b" }] });
    expect(bridge.methods()).toEqual(["snapshot", "act", "snapshot"]);
    expect(out).toBe(
      j({
        results: [
          { url: "u", resolved: { index: 2, label: "Go", confidence: 0.9, snapshotId: "pre", note: NOTE_STALE } },
        ],
        completed: 1,
        snapshot: FINAL,
      })
    );
  });
});

describe("browse_act batch: stopping on errors", () => {
  it("stops at the first { error } entry, keeps it in results, reports stoppedAt/completed/error, still snapshots", async () => {
    const bridge = bridgeWith({
      act: [{ ok: 1 }, { error: "stale snapshotId" }, { ok: 3 }],
      snapshot: [FINAL],
    });
    const out = await browseAct({
      actions: [{ action: "back" }, { action: "reload" }, { action: "forward" }],
    });
    expect(bridge.methods()).toEqual(["act", "act", "snapshot"]);
    expect(out).toBe(
      j({
        results: [{ ok: 1 }, { error: "stale snapshotId" }],
        completed: 1,
        stoppedAt: 1,
        error: "stale snapshotId",
        snapshot: FINAL,
      })
    );
  });

  it("stops at index 0 with completed 0", async () => {
    bridgeWith({ act: [{ error: "e0" }], snapshot: [{ error: "x" }] });
    expect(await browseAct({ actions: [{ action: "back" }, { action: "back" }] })).toBe(
      j({ results: [{ error: "e0" }], completed: 0, stoppedAt: 0, error: "e0" })
    );
  });

  it("treats a rejecting act as an entry error", async () => {
    bridgeWith({ act: [throws(new Error("tab crashed"))], snapshot: [{ error: "x" }] });
    expect(await browseAct({ actions: [{ action: "back" }] })).toBe(
      j({ results: [{ error: "tab crashed" }], completed: 0, stoppedAt: 0, error: "tab crashed" })
    );
  });

  it("treats a non-object entry result as a malformed-result error", async () => {
    bridgeWith({ act: [[1]], snapshot: [{ error: "x" }] });
    const e = "browse_act: malformed result from the browser bridge.";
    expect(await browseAct({ actions: [{ action: "back" }] })).toBe(
      j({ results: [{ error: e }], completed: 0, stoppedAt: 0, error: e })
    );
  });

  it("does not stop on { ok:false } without an error string", async () => {
    bridgeWith({ act: [{ ok: false }], snapshot: [{ error: "x" }] });
    expect(await browseAct({ actions: [{ action: "back" }] })).toBe(j({ results: [{ ok: false }], completed: 1 }));
  });

  it("rejects a non-object entry (null, string, array, number) at its position", async () => {
    for (const bad of [null, "click", [1], 5]) {
      const bridge = bridgeWith({ act: [{ ok: 1 }], snapshot: [FINAL] });
      const out = await browseAct({ actions: [{ action: "back" }, bad, { action: "back" }] });
      const e = "browse_act: actions[1] must be an object.";
      expect(bridge.methods()).toEqual(["act", "snapshot"]);
      expect(out).toBe(j({ results: [{ ok: 1 }, { error: e }], completed: 1, stoppedAt: 1, error: e, snapshot: FINAL }));
    }
  });

  it("validation errors of an element entry stop the batch like any other error", async () => {
    const bridge = bridgeWith({ snapshot: [{ error: "x" }] });
    const out = await browseAct({ actions: [{ action: "type", element: "field" }] });
    const e = 'browse_act: action "type" requires a non-empty "text" field.';
    expect(bridge.methods()).toEqual(["snapshot"]);
    expect(out).toBe(j({ results: [{ error: e }], completed: 0, stoppedAt: 0, error: e }));
  });

  it("an unsupported element action inside a batch stops it with the same message as a single call", async () => {
    bridgeWith({ snapshot: [FINAL] });
    const e =
      'browse_act: "element" is only supported for click, type, select, hover, press, and upload actions (got "scroll"). Use target or index instead.';
    expect(await browseAct({ actions: [{ action: "scroll", element: "x" }] })).toBe(
      j({ results: [{ error: e }], completed: 0, stoppedAt: 0, error: e, snapshot: FINAL })
    );
  });
});

describe("browse_act batch: limits and guards", () => {
  it("accepts exactly 10 entries and rejects 11 before any bridge call", async () => {
    const ten = Array.from({ length: 10 }, () => ({ action: "back" }));
    const bridge = bridgeWith({ act: [{}], snapshot: [FINAL] });
    const ok = JSON.parse(await browseAct({ actions: ten }));
    expect(ok.completed).toBe(10);
    expect(bridge.callsTo("act")).toHaveLength(10);

    const bridge2 = bridgeWith();
    expect(await browseAct({ actions: [...ten, { action: "back" }] })).toBe(
      j({ error: 'browse_act: "actions" accepts at most 10 entries.' })
    );
    expect(bridge2.calls).toEqual([]);
  });

  it("rejects an empty actions array before any bridge call", async () => {
    const bridge = bridgeWith();
    expect(await browseAct({ actions: [] })).toBe(j({ error: 'browse_act: "actions" must contain at least 1 entry.' }));
    expect(bridge.calls).toEqual([]);
  });

  it("size errors win over 'bridge not available'; availability is checked after them", async () => {
    expect(await browseAct({ actions: [] })).toBe(j({ error: 'browse_act: "actions" must contain at least 1 entry.' }));
    expect(await browseAct({ actions: new Array(11).fill({}) })).toBe(
      j({ error: 'browse_act: "actions" accepts at most 10 entries.' })
    );
    expect(await browseAct({ actions: [{ action: "back" }] })).toBe(j({ error: BROWSER_NOT_AVAILABLE_ERROR }));
  });

  it("rejects an index-based entry after an element entry, naming the element entry, without calling the bridge", async () => {
    const bridge = bridgeWith();
    const out = await browseAct({
      actions: [{ action: "back" }, { action: "click", element: "a" }, { action: "click", target: "t" }, { action: "click", index: 3 }],
    });
    expect(bridge.calls).toEqual([]);
    expect(out).toBe(
      j({
        error:
          'browse_act: actions[1] uses "element", which re-snapshots the page and makes the batch\'s snapshotId stale for every index-based entry after it — element entries re-snapshot the page; put them last or split the batch.',
      })
    );
  });

  it("index 0 after an element entry also violates; so does an element+index entry", async () => {
    for (const later of [{ action: "click", index: 0 }, { action: "click", element: "b", index: 1 }]) {
      const bridge = bridgeWith();
      const out = JSON.parse(await browseAct({ actions: [{ action: "click", element: "a" }, later] }));
      expect(out.error).toContain("actions[0] uses \"element\"");
      expect(bridge.calls).toEqual([]);
    }
  });

  it("allows index entries BEFORE an element entry, element entries last, and element followed by target/press/element entries", async () => {
    const pre = snap("pre", [{ index: 2, tag: "button", label: "B", ops: ["CLICK"] }]);
    const bridge = bridgeWith({ snapshot: [pre, pre, pre, FINAL], act: [{}] });
    stubLocate([FOUND(2)]);
    const out = JSON.parse(
      await browseAct({
        snapshotId: "top",
        actions: [
          { action: "click", index: 1 },
          { action: "click", element: "a" },
          { action: "click", target: "t" },
          { action: "press", key: "Enter" },
          { action: "click", element: "b" },
        ],
      })
    );
    expect(out.completed).toBe(5);
    expect(bridge.methods()).toEqual(["act", "snapshot", "act", "act", "act", "snapshot", "act", "snapshot"]);
  });

  it("a non-object entry is skipped by the order check (and then rejected at run time)", async () => {
    const pre = snap("pre", [{ index: 2, tag: "button", label: "B", ops: ["CLICK"] }]);
    bridgeWith({ snapshot: [pre, FINAL], act: [{}] });
    stubLocate([FOUND(2)]);
    const out = JSON.parse(await browseAct({ actions: [{ action: "click", element: "a" }, null, [1]] }));
    expect(out.stoppedAt).toBe(1);
    expect(out.error).toBe("browse_act: actions[1] must be an object.");
  });

  it("a blank element does not count as an element entry for the order check", async () => {
    const bridge = bridgeWith({ act: [{}], snapshot: [FINAL] });
    const out = JSON.parse(
      await browseAct({ actions: [{ action: "click", element: "  ", target: "x" }, { action: "click", index: 1 }] })
    );
    expect(out.completed).toBe(2);
    expect(bridge.callsTo("act").map((c) => c.args[0])).toEqual([
      { action: "click", target: "x" },
      { action: "click", index: 1 },
    ]);
  });
});

describe("browse_act batch: locator failed without a message", () => {
  it("stops the batch with the default error instead of counting a silent success", async () => {
    const bridge = bridgeWith({ act: [{ n: 1 }], snapshot: [snap("pre-1", [{ index: 2, tag: "b", label: "L", ops: ["CLICK"] }]), FINAL] });
    stubLocate([{ outcome: "failed" } as unknown as ElementLocateOutcome]);
    const out = JSON.parse(
      await browseAct({ actions: [{ action: "click", index: 1 }, { action: "click", element: "e" }] }),
    );
    const msg = 'browse_act: element lookup failed while resolving "e". Use target or index instead.';
    expect(out.completed).toBe(1);
    expect(out.stoppedAt).toBe(1);
    expect(out.error).toBe(msg);
    expect(out.results[1]).toEqual({ error: msg });
    expect(bridge.callsTo("act")).toHaveLength(1);
  });
});

describe("browse_act batch: one clock", () => {
  it("the positional now wins over opts.now, which wins over Date.now", async () => {
    const mk = (t: { v: number }) => () => t.v;
    // opts.now alone is honoured: an already-passed deadline stops at entry 0.
    bridgeWith({ act: [{}], snapshot: [FINAL] });
    let n = 0;
    const optsClock = () => (n++ === 0 ? 0 : 60_000);
    const viaOpts = JSON.parse(await runBatch(makeBridge({}).browser, [{ action: "back" }], undefined, undefined, { now: optsClock }));
    expect(viaOpts.error).toBe("browse_act: batch deadline reached.");
    // the positional clock beats opts.now
    const fixed = { v: 0 };
    const viaBoth = JSON.parse(
      await runBatch(makeBridge({ act: [{}], snapshot: [FINAL] }).browser, [{ action: "back" }], undefined, mk(fixed), { now: optsClock }),
    );
    expect(viaBoth.completed).toBe(1);
  });
});

describe("browse_act batch: deadline (injected clock)", () => {
  function clockedBridge(stepMs: number[]) {
    const clock = { t: 1_000 };
    let i = 0;
    const bridge = bridgeWith({
      act: [
        () => {
          clock.t += stepMs[Math.min(i++, stepMs.length - 1)];
          return { done: i };
        },
      ],
      snapshot: [FINAL],
    });
    return { clock, bridge, now: () => clock.t };
  }
  const entries = (n: number) => Array.from({ length: n }, () => ({ action: "back" }));

  it("stops before starting an entry once 60 s have passed; no trailing snapshot", async () => {
    const { bridge, now, clock } = clockedBridge([30_000, 30_000, 30_000]);
    const out = await runActionsBatch(bridge.browser, entries(3), undefined, now);
    expect(clock.t).toBe(61_000);
    expect(bridge.methods()).toEqual(["act", "act"]);
    expect(out).toBe(
      j({
        results: [{ done: 1 }, { done: 2 }],
        completed: 2,
        stoppedAt: 2,
        error: "browse_act: batch deadline reached.",
      })
    );
  });

  it("the deadline is inclusive (now >= deadline stops)", async () => {
    const { bridge, now } = clockedBridge([60_000]);
    const out = JSON.parse(await runActionsBatch(bridge.browser, entries(2), undefined, now));
    expect(out.stoppedAt).toBe(1);
    expect(out.snapshot).toBeUndefined();
  });

  it("one second under the deadline still runs the next entry", async () => {
    const { bridge, now } = clockedBridge([59_999, 1]);
    const out = JSON.parse(await runActionsBatch(bridge.browser, entries(2), undefined, now));
    expect(out.completed).toBe(2);
    // the second entry pushed the clock to the deadline -> trailing snapshot skipped.
    expect(out.snapshot).toBeUndefined();
    expect(out.stoppedAt).toBeUndefined();
  });

  it("an entry finishing exactly at the deadline skips only the trailing snapshot", async () => {
    const { bridge, now } = clockedBridge([60_000]);
    const out = await runActionsBatch(bridge.browser, entries(1), undefined, now);
    expect(out).toBe(j({ results: [{ done: 1 }], completed: 1 }));
    expect(bridge.methods()).toEqual(["act"]);
  });

  it("finishing inside the deadline attaches the snapshot", async () => {
    const { bridge, now } = clockedBridge([10, 10]);
    const out = await runActionsBatch(bridge.browser, entries(2), undefined, now);
    expect(out).toBe(j({ results: [{ done: 1 }, { done: 2 }], completed: 2, snapshot: FINAL }));
  });

  it("an error entry that also crosses the deadline reports the error and skips the snapshot", async () => {
    const clock = { t: 0 };
    const bridge = bridgeWith({
      act: [
        () => {
          clock.t += 70_000;
          return { error: "late failure" };
        },
      ],
      snapshot: [FINAL],
    });
    const out = await runActionsBatch(bridge.browser, entries(2), undefined, () => clock.t);
    expect(out).toBe(j({ results: [{ error: "late failure" }], completed: 0, stoppedAt: 0, error: "late failure" }));
  });

  it("works with the real clock by default (no injected now)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5);
    const bridge = bridgeWith({ act: [{}], snapshot: [FINAL] });
    const out = await runActionsBatch(bridge.browser, entries(1), "s");
    expect(JSON.parse(out).completed).toBe(1);
  });

  it("returns the not-available error for an undefined browser (after size checks)", async () => {
    expect(await runActionsBatch(undefined, entries(1), undefined)).toBe(j({ error: BROWSER_NOT_AVAILABLE_ERROR }));
  });
});
