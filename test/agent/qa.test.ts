import { describe, expect, it } from "vitest";
import {
  QA_PROMPT_SECTION,
  QA_RESULT_MAX_STEPS,
  QA_VERDICT_FIELD,
  createStepRecorder,
  executeQaVerdict,
  qaOutcome,
  qaResultOf,
  qaVerdictHooks,
  type QaStep,
} from "../../src/agent/qa.js";
import { BROWSE_AGENT_ERROR_MAX_CHARS } from "../../src/agent/limits.js";
import { buildBrowseAgentPrompt, BROWSE_AGENT_CLOSING, SUBAGENT_IRREVERSIBLE_LINE } from "../../src/agent/prompt.js";
import { QA_AGENT_CLOSING, QA_IRREVERSIBLE_LINE } from "../../src/agent/qaCore.js";
import { createBrowseAgentSession } from "../../src/agent/session.js";

const call = (toolName: string, input: unknown, toolCallId = "c1", preOpen?: true) => ({ toolName, input, toolCallId, ...(preOpen ? { preOpen } : {}) });
const pass = { verdict: "pass" as const, reason: "ok" };
const fail = { verdict: "fail" as const, reason: "bad" };

describe("qaOutcome", () => {
  it.each([
    ["setup_failed", undefined, "setup_failed"],
    ["setup_failed", pass, "setup_failed"],
    ["aborted", pass, "aborted"],
    ["done", pass, "passed"],
    ["step_limit", pass, "passed"],
    ["timeout", fail, "failed"],
    ["done", undefined, "inconclusive"],
    ["error", undefined, "error"],
    ["timeout", undefined, "error"],
    ["step_limit", undefined, "error"],
  ] as const)("%s with %j gives %s", (status, verdict, outcome) => {
    expect(qaOutcome(status, verdict)).toBe(outcome);
  });
});

describe("qaOutcome with a failed agent check", () => {
  const pass = { verdict: "pass" as const, reason: "all fine" };
  const rec = (text: string, passed: boolean, source: "agent" | "final" = "agent") => ({ source, check: { type: "text" as const, text }, passed, ...(passed ? {} : { error: "bad" }) });
  it("downgrades pass to inconclusive when the last qa_assert call had a failed check", () => {
    expect(qaOutcome("done", pass, rec("a", false))).toBe("inconclusive");
    const qa = qaResultOf({ status: "done", qaVerdict: pass }, [], { checks: [rec("a", false)] }, [rec("a", false)]);
    expect(qa.outcome).toBe("inconclusive");
    expect(qa.reason).toBe('Agent said pass, but check failed: text "a" present (bad). Agent reason: all fine');
  });
  it("keeps passed when the last call passed (an earlier failed call was replaced), and fail stays failed", () => {
    const checks = [rec("a", false), rec("b", true)];
    expect(qaResultOf({ status: "done", qaVerdict: pass }, [], { checks }, [rec("b", true)]).outcome).toBe("passed");
    expect(qaResultOf({ status: "done", qaVerdict: pass }, [], { checks }, []).outcome).toBe("passed");
    expect(qaResultOf({ status: "done", qaVerdict: { verdict: "fail", reason: "x" } }, [], { checks }, [rec("a", false)]).outcome).toBe("failed");
  });
});

describe("QA_IRREVERSIBLE_LINE", () => {
  it("allows a destructive step only when the scenario names it", () => {
    expect(QA_IRREVERSIBLE_LINE).toContain("only when the scenario names that step");
    expect(QA_IRREVERSIBLE_LINE).toContain("Close it or cancel it");
  });
});

describe("qaResultOf", () => {
  const step = (i: number): QaStep => ({ index: i, tool: `t${i}`, args: {}, ok: true, ms: 9 });

  it("takes the verdict from the result field and drops ms from the steps", () => {
    const r = qaResultOf({ status: "done", [QA_VERDICT_FIELD]: pass }, [step(1)]);
    expect(r).toEqual({ outcome: "passed", verdict: "pass", reason: "ok", steps: [{ index: 1, tool: "t1", args: {}, ok: true }] });
  });

  it("gives a status reason for an error outcome without a verdict and without a run error", () => {
    expect(qaResultOf({ status: "step_limit" }, []).reason).toBe("request limit reached");
    expect(qaResultOf({ status: "timeout" }, []).reason).toBe("deadline reached");
    expect(qaResultOf({ status: "error" }, []).reason).toBe("the run ended with status error");
    // The run's own error is on the result already: not copied.
    expect(qaResultOf({ status: "error", error: "provider down" }, []).reason).toBeUndefined();
    expect(qaResultOf({ status: "done" }, []).reason).toBeUndefined();
    expect(qaResultOf({ status: "aborted" }, []).reason).toBeUndefined();
  });

  it("keeps the last steps and counts the dropped ones", () => {
    const steps = Array.from({ length: QA_RESULT_MAX_STEPS + 5 }, (_, i) => step(i + 1));
    const r = qaResultOf({ status: "done" }, steps);
    expect(r.steps).toHaveLength(QA_RESULT_MAX_STEPS);
    expect(r.steps[0]!.index).toBe(6);
    expect(r.stepsDropped).toBe(5);
    expect(qaResultOf({ status: "done" }, [step(1)]).stepsDropped).toBeUndefined();
    expect(Object.keys(r)).toEqual(["outcome", "steps", "stepsDropped"]);
    expect(Object.keys(qaResultOf({ status: "done", [QA_VERDICT_FIELD]: pass }, steps))).toEqual(["outcome", "verdict", "reason", "steps", "stepsDropped"]);
  });

  it("ignores a malformed verdict field", () => {
    expect(qaResultOf({ status: "done", [QA_VERDICT_FIELD]: { verdict: "maybe", reason: "x" } }, []).outcome).toBe("inconclusive");
    expect(qaResultOf({ status: "done", [QA_VERDICT_FIELD]: "pass" }, []).outcome).toBe("inconclusive");
  });
});

describe("qa_verdict", () => {
  const session = () => createBrowseAgentSession({ extraTools: { qa_verdict: qaVerdictHooks() }, executeTool: async (c) => executeQaVerdict(c.input) });

  it("the first success fills the result field, a repeat is refused before it runs", async () => {
    const s = session();
    expect(JSON.parse(await s.runTool({ toolName: "qa_verdict", input: { verdict: "pass", reason: " fine " }, toolCallId: "1" }))).toEqual({ ok: true, verdict: "pass", reason: "fine" });
    expect(await s.runTool({ toolName: "qa_verdict", input: { verdict: "fail", reason: "x" }, toolCallId: "2" })).toContain("already called");
    const r = await s.run("goal", { send: async () => {}, stop() {}, messages: () => [] });
    expect(r[QA_VERDICT_FIELD]).toEqual({ verdict: "pass", reason: "fine" });
  });

  it("bad input is an error and does not use up the verdict; state is per session", async () => {
    const hooks = qaVerdictHooks();
    const make = () => createBrowseAgentSession({ extraTools: { qa_verdict: hooks }, executeTool: async (c) => executeQaVerdict(c.input) });
    const a = make();
    expect(await a.runTool({ toolName: "qa_verdict", input: { verdict: "pass", reason: "  " }, toolCallId: "1" })).toContain("error");
    expect(await a.runTool({ toolName: "qa_verdict", input: { verdict: "maybe", reason: "x" }, toolCallId: "2" })).toContain("error");
    expect(JSON.parse(await a.runTool({ toolName: "qa_verdict", input: { verdict: "fail", reason: "r" }, toolCallId: "3" })).ok).toBe(true);
    // A second session of the same hooks starts clean.
    expect(JSON.parse(await make().runTool({ toolName: "qa_verdict", input: { verdict: "pass", reason: "r" }, toolCallId: "4" })).ok).toBe(true);
  });

  it("the prompt section names the tool, the items and the boundary rule", () => {
    expect(QA_PROMPT_SECTION).toContain("qa_verdict");
    expect(QA_PROMPT_SECTION).toContain("Sign in once and keep the session.");
    expect(QA_PROMPT_SECTION).toContain("`blocked` is not a fail.");
    expect(QA_PROMPT_SECTION).toContain("only when you are about to give `fail` because a feature or an element is missing");
    expect(QA_PROMPT_SECTION).toContain("Do not guess URLs.");
    expect(QA_PROMPT_SECTION).toContain("A 404 on a URL you guessed is not a defect.");
    expect(QA_PROMPT_SECTION.indexOf("Do not guess URLs.")).toBeGreaterThan(QA_PROMPT_SECTION.indexOf("Otherwise, mark it as missing"));
    expect(QA_PROMPT_SECTION.indexOf("Do not guess URLs.")).toBeLessThan(QA_PROMPT_SECTION.indexOf("A blocked step"));
    expect(QA_PROMPT_SECTION).toContain("When the scenario has items, mark the item that the blocked step stops as `blocked`.");
  });
});

describe("qa_verdict items", () => {
  const it1 = (id: string, result: "pass" | "fail" | "blocked", reason = "r") => ({ id, result, reason });
  const errorsOf = (input: unknown) => {
    const out = JSON.parse(executeQaVerdict(input)) as { error?: string };
    return out.error;
  };

  it("accepts valid items, trims them, and echoes them in the output", () => {
    const out = JSON.parse(executeQaVerdict({ verdict: "fail", reason: "x", items: [{ id: " A1 ", result: "pass", reason: " ok " }, it1("A2", "fail"), it1("A3", "blocked")] }));
    expect(out).toEqual({ ok: true, verdict: "fail", reason: "x", items: [it1("A1", "pass", "ok"), it1("A2", "fail"), it1("A3", "blocked")] });
  });

  it("items null and [] are absent", () => {
    for (const items of [null, []]) expect(JSON.parse(executeQaVerdict({ ...pass, items }))).toEqual({ ok: true, ...pass });
  });

  it("rejects a pass verdict with a failed item, and allows a fail verdict without a failed item", () => {
    expect(errorsOf({ ...pass, items: [it1("A", "pass"), it1("B", "fail")] })).toContain('verdict: must be "fail"');
    expect(errorsOf({ ...fail, items: [it1("A", "pass"), it1("B", "blocked")] })).toBeUndefined();
    expect(errorsOf({ ...fail, items: [it1("A", "pass")] })).toBeUndefined();
  });

  it("rejects items that are all blocked and tells the model not to call the tool", () => {
    const e = errorsOf({ ...pass, items: [it1("A", "blocked")] });
    expect(e).toContain("every item is blocked");
    expect(e).toContain("Do not call qa_verdict");
  });

  it("rejects duplicate ids, too many items, a long id, a long reason and a bad result", () => {
    expect(errorsOf({ ...pass, items: [it1("A", "pass"), it1(" A", "pass")] })).toContain("ids must be unique");
    expect(errorsOf({ ...pass, items: Array.from({ length: 21 }, (_, i) => it1(`i${i}`, "pass")) })).toContain("at most 20");
    expect(errorsOf({ ...pass, items: [it1("x".repeat(41), "pass")] })).toContain("items[0].id");
    expect(errorsOf({ ...pass, items: [it1("A", "pass", "x".repeat(301))] })).toContain("items[0].reason");
    expect(errorsOf({ ...pass, items: [it1("A", "ok" as never)] })).toContain("items[0].result");
  });

  it("a rejected items call does not use up the verdict", async () => {
    const s = createBrowseAgentSession({ extraTools: { qa_verdict: qaVerdictHooks() }, executeTool: async (c) => executeQaVerdict(c.input) });
    expect(await s.runTool({ toolName: "qa_verdict", input: { ...pass, items: [it1("A", "fail")] }, toolCallId: "1" })).toContain("error");
    expect(JSON.parse(await s.runTool({ toolName: "qa_verdict", input: { ...fail, items: [it1("A", "fail")] }, toolCallId: "2" })).ok).toBe(true);
  });

  it("the hooks put items into the result field, and qaResultOf carries them", async () => {
    const items = [it1("A", "pass"), it1("B", "blocked")];
    const s = createBrowseAgentSession({ extraTools: { qa_verdict: qaVerdictHooks() }, executeTool: async (c) => executeQaVerdict(c.input) });
    await s.runTool({ toolName: "qa_verdict", input: { ...pass, items }, toolCallId: "1" });
    const r = await s.run("goal", { send: async () => {}, stop() {}, messages: () => [] });
    expect(r[QA_VERDICT_FIELD]).toEqual({ ...pass, items });
    expect(qaResultOf(r, []).items).toEqual(items);
  });

  it("qaResultOf has no items key when the verdict had none, and carries items when it has them", () => {
    expect("items" in qaResultOf({ status: "done", qaVerdict: pass }, [])).toBe(false);
    const items = [it1("A", "pass")];
    const qa = qaResultOf({ status: "done", qaVerdict: { ...pass, items } }, []);
    expect(qa.items).toEqual(items);
  });

  it("downgrades a pass without items for a failed check in the last qa_assert call", () => {
    const rec = { source: "agent" as const, check: { type: "text" as const, text: "a" }, passed: false, error: "bad" };
    expect(qaResultOf({ status: "done", qaVerdict: pass }, [], undefined, [rec]).outcome).toBe("inconclusive");
  });

  it("does not downgrade a pass with items for a failed check in the last qa_assert call", () => {
    const rec = { source: "agent" as const, check: { type: "text" as const, text: "a" }, passed: false, error: "bad" };
    const items = [it1("A", "pass"), it1("B", "blocked")];
    const qa = qaResultOf({ status: "done", qaVerdict: { ...pass, items } }, [], undefined, [rec]);
    expect(qa.outcome).toBe("passed");
    expect(qa.reason).toBe(pass.reason);
    expect(qa.items).toEqual(items);
  });
});

describe("createStepRecorder", () => {
  it("takes the index and slot when the call starts, so parallel calls keep their order", () => {
    const rec = createStepRecorder();
    const endA = rec.onToolCall(call("browse_read", {}, "a"));
    const endB = rec.onToolCall(call("browse_open", { url: "u" }, "b"));
    endB({ output: "{}" });
    endA({ output: "{}" });
    expect(rec.steps().map((s) => [s.index, s.tool])).toEqual([[1, "browse_read"], [2, "browse_open"]]);
  });

  it("harvests console errors and failed requests from the entries of a batched browse_act", () => {
    const rec = createStepRecorder();
    rec.onToolCall(call("browse_act", { actions: [] }))({
      output: JSON.stringify({
        results: [{ ok: true, consoleErrors: ["E1"] }, { ok: true, failedRequests: ["GET 500 https://a.test/x"] }, { consoleErrors: ["E1", "E2"] }],
        completed: 3,
        consoleErrors: ["E0"],
      }),
    });
    expect(rec.extras()).toMatchObject({ consoleErrors: ["E0", "E1", "E2"], failedRequests: ["GET 500 https://a.test/x"] });
  });

  it("ok is false for an error result string, a throw, and a call that did not end", () => {
    const rec = createStepRecorder();
    rec.onToolCall(call("browse_read", {}))({ output: '{"error":"page is gone"}' });
    rec.onToolCall(call("browse_act", {}))({ error: new Error("boom") });
    rec.onToolCall(call("browse_open", {}))({ output: '{"url":"x"}' });
    rec.onToolCall(call("browse_tabs", {}));
    expect(rec.steps()).toMatchObject([{ ok: false, error: "page is gone" }, { ok: false, error: "boom" }, { ok: true }, { ok: false, error: "did not finish" }]);
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

  it("caps the error text of a step, thrown or parsed from the output", () => {
    const rec = createStepRecorder();
    rec.onToolCall(call("a", {}))({ error: new Error("e".repeat(1000)) });
    rec.onToolCall(call("b", {}))({ output: JSON.stringify({ error: "f".repeat(1000) }) });
    expect(rec.steps().map((s) => s.error!.length)).toEqual([BROWSE_AGENT_ERROR_MAX_CHARS, BROWSE_AGENT_ERROR_MAX_CHARS]);
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

describe("buildBrowseAgentPrompt({ qa })", () => {
  const text = buildBrowseAgentPrompt({ qa: true, sections: ["Host section."] });

  it("uses the QA irreversible line, not the subagent one", () => {
    expect(text).toContain(QA_IRREVERSIBLE_LINE);
    expect(text).not.toContain(SUBAGENT_IRREVERSIBLE_LINE);
  });

  it("puts the QA section after the host sections and ends with the QA closing, which names qa_verdict", () => {
    expect(text.indexOf("Host section.")).toBeLessThan(text.indexOf(QA_PROMPT_SECTION));
    expect(text.endsWith(QA_AGENT_CLOSING)).toBe(true);
    expect(QA_AGENT_CLOSING).toContain("qa_verdict");
    expect(text).not.toContain(BROWSE_AGENT_CLOSING);
  });

  it("the principal defaults to the QA engineer; a host principal wins", () => {
    expect(text).toContain("working for a QA engineer.");
    expect(buildBrowseAgentPrompt({ qa: true, principal: "Acme CI" })).toContain("working for Acme CI.");
  });

  it("without qa the prompt is the subagent one", () => {
    const plain = buildBrowseAgentPrompt();
    expect(plain).toContain(SUBAGENT_IRREVERSIBLE_LINE);
    expect(plain.endsWith(BROWSE_AGENT_CLOSING)).toBe(true);
  });
});
