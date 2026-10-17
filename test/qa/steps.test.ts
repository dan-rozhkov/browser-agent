import { describe, expect, it } from "vitest";
import { createStepRecorder } from "../../src/qa/steps.js";

const call = (toolName: string, input: unknown, toolCallId = "c1", preOpen?: true) => ({ toolName, input, toolCallId, ...(preOpen ? { preOpen } : {}) });

describe("createStepRecorder", () => {
  it("takes the index and slot when the call starts, so parallel calls keep their order", () => {
    const rec = createStepRecorder();
    const endA = rec.onToolCall(call("browse_read", {}, "a"));
    const endB = rec.onToolCall(call("browse_open", { url: "u" }, "b"));
    endB({ output: "{}" });
    endA({ output: "{}" });
    expect(rec.steps().map((s) => [s.index, s.tool])).toEqual([[1, "browse_read"], [2, "browse_open"]]);
  });

  it("ok is false for an error result string, a throw, and a call that did not end", () => {
    const rec = createStepRecorder();
    rec.onToolCall(call("browse_read", {}))({ output: '{"error":"page is gone"}' });
    rec.onToolCall(call("browse_act", {}))({ error: new Error("boom") });
    rec.onToolCall(call("browse_open", {}))({ output: '{"url":"x"}' });
    rec.onToolCall(call("browse_tabs", {}));
    expect(rec.steps()).toMatchObject([
      { ok: false, error: "page is gone" },
      { ok: false, error: "boom" },
      { ok: true },
      { ok: false, error: "did not finish" },
    ]);
    expect(rec.steps()[2]!.error).toBeUndefined();
  });

  it("a non-JSON or non-object result is ok", () => {
    const rec = createStepRecorder();
    rec.onToolCall(call("a", {}))({ output: "plain" });
    rec.onToolCall(call("b", {}))({ output: "[1]" });
    expect(rec.steps().map((s) => s.ok)).toEqual([true, true]);
  });

  it("cuts text over 200 chars, also nested, and keeps the input intact", () => {
    const rec = createStepRecorder();
    const input = { text: "z".repeat(201), actions: [{ text: "y".repeat(300) }], other: "w".repeat(300) };
    rec.onToolCall(call("browse_act", input))({ output: "{}" });
    const args = rec.steps()[0]!.args as typeof input;
    expect(args.text).toHaveLength(200);
    expect(args.actions[0]!.text).toHaveLength(200);
    expect(args.other).toHaveLength(300);
    expect(input.text).toHaveLength(201);
  });

  it("measures ms with the clock and skips the pre-open", () => {
    let t = 0;
    const rec = createStepRecorder(() => (t += 7));
    rec.onToolCall(call("browse_open", {}, "run:open", true))({ output: "{}" });
    rec.onToolCall(call("browse_read", {}))({ output: "{}" });
    expect(rec.steps()).toHaveLength(1);
    expect(rec.steps()[0]).toMatchObject({ index: 1, ms: 7 });
  });
});
