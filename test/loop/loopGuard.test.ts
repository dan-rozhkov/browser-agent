import { describe, expect, it } from "vitest";
import { applyLoopGuard, resetLoopGuard } from "@/lib/tools/browser/loopGuard";

describe("applyLoopGuard", () => {
  it("does not warn on the first two identical calls, only the third", () => {
    resetLoopGuard("chat-1");
    const args = { action: "click", index: 0 };
    const result = '{"error":"target is gone"}';

    const r1 = applyLoopGuard("browse_act", args, result, "chat-1");
    const r2 = applyLoopGuard("browse_act", args, result, "chat-1");
    const r3 = applyLoopGuard("browse_act", args, result, "chat-1");

    expect(JSON.parse(r1)).not.toHaveProperty("loopWarning");
    expect(JSON.parse(r2)).not.toHaveProperty("loopWarning");
    expect(JSON.parse(r3)).toHaveProperty("loopWarning");
  });

  it("does not warn when three calls to the same tool differ in args", () => {
    resetLoopGuard("chat-1");
    const result = '{"matched":"ok"}';

    applyLoopGuard("browse_act", { action: "click", index: 0 }, result, "chat-1");
    applyLoopGuard("browse_act", { action: "click", index: 1 }, result, "chat-1");
    const r3 = applyLoopGuard("browse_act", { action: "click", index: 2 }, result, "chat-1");

    expect(JSON.parse(r3)).not.toHaveProperty("loopWarning");
  });

  it("does not warn when three calls to the same tool+args differ in result", () => {
    resetLoopGuard("chat-1");
    const args = { action: "click", index: 0 };

    applyLoopGuard("browse_act", args, '{"matched":"a"}', "chat-1");
    applyLoopGuard("browse_act", args, '{"matched":"b"}', "chat-1");
    const r3 = applyLoopGuard("browse_act", args, '{"matched":"c"}', "chat-1");

    expect(JSON.parse(r3)).not.toHaveProperty("loopWarning");
  });

  it("treats argument key order as irrelevant (canonical/stable args key)", () => {
    resetLoopGuard("chat-1");
    const result = '{"matched":"ok"}';

    applyLoopGuard("browse_act", { action: "click", index: 0 }, result, "chat-1");
    applyLoopGuard("browse_act", { index: 0, action: "click" }, result, "chat-1");
    const r3 = applyLoopGuard("browse_act", { action: "click", index: 0 }, result, "chat-1");

    expect(JSON.parse(r3)).toHaveProperty("loopWarning");
  });

  it("detects an A,B,A,B cycle of two different idempotent reads with identical results", () => {
    resetLoopGuard("chat-1");
    const snapResult = '{"elements":[]}';
    const readResult = '{"text":"hello"}';

    applyLoopGuard("browse_snapshot", {}, snapResult, "chat-1");
    applyLoopGuard("browse_read", {}, readResult, "chat-1");
    applyLoopGuard("browse_snapshot", {}, snapResult, "chat-1");
    const r4 = applyLoopGuard("browse_read", {}, readResult, "chat-1");

    expect(JSON.parse(r4)).toHaveProperty("loopWarning");
  });

  it("does not detect an A,B,A,B cycle when the second occurrence of A has a different result", () => {
    resetLoopGuard("chat-1");

    applyLoopGuard("browse_snapshot", {}, '{"elements":[]}', "chat-1");
    applyLoopGuard("browse_read", {}, '{"text":"hello"}', "chat-1");
    applyLoopGuard("browse_snapshot", {}, '{"elements":["changed"]}', "chat-1");
    const r4 = applyLoopGuard("browse_read", {}, '{"text":"hello"}', "chat-1");

    expect(JSON.parse(r4)).not.toHaveProperty("loopWarning");
  });

  it("a mutating call landing a different result resets the ring, clearing the prior loop context", () => {
    resetLoopGuard("chat-1");
    const args = { action: "click", index: 0 };

    // Two identical failed mutating calls (would be the 3rd next)...
    applyLoopGuard("browse_act", args, '{"error":"stale"}', "chat-1");
    applyLoopGuard("browse_act", args, '{"error":"stale"}', "chat-1");
    // ...but this third call lands something new (real progress) — resets.
    const r3 = applyLoopGuard("browse_act", args, '{"matched":"ok","changed":true}', "chat-1");
    // A fourth call identical to the third is now only the 2nd in the new
    // window, so no warning yet.
    const r4 = applyLoopGuard("browse_act", args, '{"matched":"ok","changed":true}', "chat-1");

    expect(JSON.parse(r3)).not.toHaveProperty("loopWarning");
    expect(JSON.parse(r4)).not.toHaveProperty("loopWarning");
  });

  it("a non-mutating (read) call repeated identically still accumulates toward the 3-in-a-row warning", () => {
    resetLoopGuard("chat-1");
    const result = '{"elements":[]}';

    applyLoopGuard("browse_snapshot", {}, result, "chat-1");
    applyLoopGuard("browse_snapshot", {}, result, "chat-1");
    const r3 = applyLoopGuard("browse_snapshot", {}, result, "chat-1");

    expect(JSON.parse(r3)).toHaveProperty("loopWarning");
  });

  it("keeps separate rings per chatId", () => {
    resetLoopGuard("chat-a");
    resetLoopGuard("chat-b");
    const args = { action: "click", index: 0 };
    const result = '{"error":"target is gone"}';

    applyLoopGuard("browse_act", args, result, "chat-a");
    applyLoopGuard("browse_act", args, result, "chat-a");
    // chat-b's ring is independent — its first call must not warn even
    // though chat-a is one call away from the threshold.
    const rB = applyLoopGuard("browse_act", args, result, "chat-b");

    expect(JSON.parse(rB)).not.toHaveProperty("loopWarning");
  });

  it("falls back to a module-level ring when no chatId is given, and resetLoopGuard(undefined) clears it", () => {
    resetLoopGuard();
    const args = { action: "click", index: 0 };
    const result = '{"error":"target is gone"}';

    applyLoopGuard("browse_act", args, result);
    applyLoopGuard("browse_act", args, result);
    const r3 = applyLoopGuard("browse_act", args, result);
    expect(JSON.parse(r3)).toHaveProperty("loopWarning");

    resetLoopGuard();
    const afterReset = applyLoopGuard("browse_act", args, result);
    expect(JSON.parse(afterReset)).not.toHaveProperty("loopWarning");
  });

  it("passes a non-JSON-object result through untouched even when a loop is detected", () => {
    resetLoopGuard("chat-1");
    const args = { action: "click", index: 0 };

    applyLoopGuard("browse_act", args, "not json", "chat-1");
    applyLoopGuard("browse_act", args, "not json", "chat-1");
    const r3 = applyLoopGuard("browse_act", args, "not json", "chat-1");

    expect(r3).toBe("not json");
  });

  it("warns on the 3rd identical no-effect browse_act click even when each result carries a fresh, changing snapshotId", () => {
    resetLoopGuard("chat-1");
    const args = { action: "click", index: 0, snapshotId: "top-1" };

    // Same click, same matched element, same "nothing happened" outcome —
    // but a brand-new random snapshotId attached every time, the way a
    // real no-op browse_act(changed:false) result does.
    const r1 = applyLoopGuard(
      "browse_act",
      args,
      JSON.stringify({ matched: "Search", changed: false, snapshot: { snapshotId: "snap-a", elements: [] } }),
      "chat-1"
    );
    const r2 = applyLoopGuard(
      "browse_act",
      args,
      JSON.stringify({ matched: "Search", changed: false, snapshot: { snapshotId: "snap-b", elements: [] } }),
      "chat-1"
    );
    const r3 = applyLoopGuard(
      "browse_act",
      args,
      JSON.stringify({ matched: "Search", changed: false, snapshot: { snapshotId: "snap-c", elements: [] } }),
      "chat-1"
    );

    expect(JSON.parse(r1)).not.toHaveProperty("loopWarning");
    expect(JSON.parse(r2)).not.toHaveProperty("loopWarning");
    expect(JSON.parse(r3)).toHaveProperty("loopWarning");
  });

  it("still resets the ring for a mutating call whose NORMALIZED result genuinely differs, ignoring snapshotId churn", () => {
    resetLoopGuard("chat-1");
    const args = { action: "click", index: 0 };

    applyLoopGuard(
      "browse_act",
      args,
      JSON.stringify({ error: "stale", snapshot: { snapshotId: "snap-a" } }),
      "chat-1"
    );
    applyLoopGuard(
      "browse_act",
      args,
      JSON.stringify({ error: "stale", snapshot: { snapshotId: "snap-b" } }),
      "chat-1"
    );
    // Real progress — a different `matched` value, not just a different
    // snapshotId — must still reset the ring.
    const r3 = applyLoopGuard(
      "browse_act",
      args,
      JSON.stringify({ matched: "ok", changed: true, snapshot: { snapshotId: "snap-c" } }),
      "chat-1"
    );
    const r4 = applyLoopGuard(
      "browse_act",
      args,
      JSON.stringify({ matched: "ok", changed: true, snapshot: { snapshotId: "snap-d" } }),
      "chat-1"
    );

    expect(JSON.parse(r3)).not.toHaveProperty("loopWarning");
    expect(JSON.parse(r4)).not.toHaveProperty("loopWarning");
  });

  it("normalizes resolved.snapshotId too, not just the top-level/snapshot ones", () => {
    resetLoopGuard("chat-1");
    const args = { action: "click", element: "the search button" };

    const r1 = applyLoopGuard(
      "browse_act",
      args,
      JSON.stringify({
        error: "target is gone or occluded",
        resolved: { index: 2, label: "Search", confidence: 0.9, snapshotId: "snap-a", note: "n" },
      }),
      "chat-1"
    );
    const r2 = applyLoopGuard(
      "browse_act",
      args,
      JSON.stringify({
        error: "target is gone or occluded",
        resolved: { index: 2, label: "Search", confidence: 0.9, snapshotId: "snap-b", note: "n" },
      }),
      "chat-1"
    );
    const r3 = applyLoopGuard(
      "browse_act",
      args,
      JSON.stringify({
        error: "target is gone or occluded",
        resolved: { index: 2, label: "Search", confidence: 0.9, snapshotId: "snap-c", note: "n" },
      }),
      "chat-1"
    );

    expect(JSON.parse(r1)).not.toHaveProperty("loopWarning");
    expect(JSON.parse(r2)).not.toHaveProperty("loopWarning");
    expect(JSON.parse(r3)).toHaveProperty("loopWarning");
  });

  it("browse_tabs with action:list is treated as a non-mutating read for reset purposes", () => {
    resetLoopGuard("chat-1");

    // Two identical browse_tabs(list) calls, then a differing browse_tabs
    // list result — since list is non-mutating, this must NOT reset the
    // ring (only a differing MUTATING call resets it), so three identical
    // calls in a row still accumulate correctly across the window.
    applyLoopGuard("browse_tabs", { action: "list" }, '{"tabs":[]}', "chat-1");
    const differing = applyLoopGuard(
      "browse_tabs",
      { action: "list" },
      '{"tabs":["one"]}',
      "chat-1"
    );
    expect(JSON.parse(differing)).not.toHaveProperty("loopWarning");
  });
});
