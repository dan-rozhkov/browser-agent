import { describe, expect, it } from "vitest";
import {
  QA_ASSERT_TOOL,
  QA_CHECKS_MAX,
  QA_RESULT_MAX_DIAGNOSTICS,
  applyFinalChecks,
  createStepRecorder,
  describeQaCheck,
  evaluateQaChecks,
  executeQaAssert,
  finalChecksApply,
  normalizeQaChecks,
  parseQaChecks,
  qaResultOf,
  runFinalChecks,
  type QaCheck,
  type QaCheckResult,
  type QaResult,
} from "../../src/agent/qaCore.js";
import { qaAssertDefinition, qaAssertSchema } from "../../src/agent/qa.js";

const call = (toolName: string, input: unknown, toolCallId = "c1") => ({ toolName, input, toolCallId });
const parse = (v: unknown) => parseQaChecks(v);

describe("parseQaChecks selector guard", () => {
  const bad = ["text=Delete", "css=.a", "xpath=//a", "role=button", 'button:has-text("Delete")', "a:text(x)", "a:text-is(x)", "button:visible", ".a >> .b", ".a>>.b"];
  it.each(bad)("rejects %s in element, value and count", (selector) => {
    for (const check of [{ type: "element", selector, state: "visible" }, { type: "value", selector, equals: "x" }, { type: "count", selector, min: 1 }]) {
      const r = parse([check]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0]).toContain("Playwright syntax");
    }
  });
  it("keeps valid CSS that only looks like Playwright syntax", () => {
    for (const selector of ["[ role=dialog]", "[role=dialog]", '[data-x="a>>b"]']) {
      expect(parse([{ type: "count", selector, min: 1 }]).ok, selector).toBe(true);
    }
  });
  it("keeps plain CSS, and executeQaAssert returns the error to the agent", async () => {
    expect(parse([{ type: "element", selector: "button.primary[data-x='text=y']", state: "visible" }]).ok).toBe(true);
    const out = JSON.parse(await executeQaAssert({ checks: [{ type: "element", selector: "text=Delete", state: "visible" }] }, { assert: async () => ({}) }, createStepRecorder()));
    expect(out.error).toContain("Playwright syntax");
  });
});

describe("count visible option", () => {
  it("describes a visible count", () => {
    expect(describeQaCheck({ type: "count", selector: "tbody tr", visible: true, equals: 2 })).toBe("count of visible tbody tr equals 2");
  });
  it("parses visible, drops a false or non-true value, rejects a non-boolean", () => {
    expect(parse([{ type: "count", selector: "tr", visible: true, min: 1 }])).toEqual({ ok: true, value: [{ type: "count", selector: "tr", visible: true, min: 1 }] });
    expect(parse([{ type: "count", selector: "tr", visible: false, min: 1 }])).toEqual({ ok: true, value: [{ type: "count", selector: "tr", min: 1 }] });
    expect(parse([{ type: "count", selector: "tr", visible: "yes", min: 1 }]).ok).toBe(false);
  });
});

describe("parseQaChecks", () => {
  it("accepts every check type and drops unknown keys", () => {
    const r = parse([
      { type: "text", text: "Hi", absent: true, junk: 1 },
      { type: "element", selector: "#a", state: "visible" },
      { type: "element", index: 3, state: "checked" },
      { type: "value", selector: "input", contains: "x" },
      { type: "count", selector: "li", min: 1, max: 4 },
      { type: "url", matches: "orders/\\d+" },
      { type: "no_console_errors", ignore: ["favicon"] },
      { type: "no_failed_requests" },
    ]);
    expect(r).toEqual({
      ok: true,
      value: [
        { type: "text", text: "Hi", absent: true },
        { type: "element", selector: "#a", state: "visible" },
        { type: "element", index: 3, state: "checked" },
        { type: "value", selector: "input", contains: "x" },
        { type: "count", selector: "li", min: 1, max: 4 },
        { type: "url", matches: "orders/\\d+" },
        { type: "no_console_errors", ignore: ["favicon"] },
        { type: "no_failed_requests" },
      ],
    });
  });

  it.each([
    ["not an array", { type: "text", text: "a" }, "expected an array"],
    ["empty", [], "at least one"],
    ["too many", Array.from({ length: QA_CHECKS_MAX + 1 }, () => ({ type: "no_console_errors" })), "at most 10"],
    ["not an object", ["x"], "checks[0]: expected an object"],
    ["unknown type", [{ type: "title" }], "type: expected"],
    ["text empty", [{ type: "text", text: "" }], "text"],
    ["element without locator", [{ type: "element", state: "visible" }], 'give a "selector" or an "index"'],
    ["element bad state", [{ type: "element", selector: "a", state: "open" }], "state: expected one of"],
    ["element negative index", [{ type: "element", index: -1, state: "visible" }], "index"],
    ["value without comparator", [{ type: "value", selector: "a" }], 'give "equals" or "contains"'],
    ["value without locator", [{ type: "value", equals: "a" }], 'give a "selector" or an "index"'],
    ["count without selector", [{ type: "count", equals: 1 }], "selector"],
    ["count without comparator", [{ type: "count", selector: "li" }], 'give "equals", "min" or "max"'],
    ["count min above max", [{ type: "count", selector: "li", min: 3, max: 1 }], "min"],
    ["url without comparator", [{ type: "url" }], "give"],
    ["url bad regex", [{ type: "url", matches: "(" }], "regular expression"],
    ["ignore not strings", [{ type: "no_console_errors", ignore: [1] }], "ignore"],
  ])("rejects %s", (_name, input, message) => {
    const r = parse(input);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.errors.join("|")).toContain(message);
  });

  it("strips strict-mode placeholders (\"\", null, [], index 0 next to a selector)", () => {
    const r = parse([
      { type: "element", selector: "#a", index: 0, state: "visible", text: "", equals: null },
      { type: "value", selector: "input", equals: "", contains: "x", index: null },
      { type: "url", equals: "", contains: "/a", matches: "" },
      { type: "no_failed_requests", ignore: [] },
      { type: "count", selector: "li", equals: 0, min: null, max: null },
    ]);
    expect(r).toEqual({
      ok: true,
      value: [
        { type: "element", selector: "#a", state: "visible" },
        { type: "value", selector: "input", contains: "x" },
        { type: "url", contains: "/a" },
        { type: "no_failed_requests" },
        { type: "count", selector: "li", equals: 0 },
      ],
    });
  });

  it("treats absent:false as the safe default and keeps absent:true", () => {
    expect(parse([{ type: "text", text: "Hi", absent: false }])).toEqual({ ok: true, value: [{ type: "text", text: "Hi", absent: false }] });
    expect(describeQaCheck({ type: "text", text: "Hi", absent: false })).toBe('text "Hi" present');
    expect(describeQaCheck({ type: "text", text: "Hi", absent: true })).toBe('text "Hi" absent');
    expect(parse([{ type: "text", text: "Hi", absent: "no" }]).ok).toBe(false);
    expect(qaAssertSchema.safeParse({ checks: [{ type: "text", text: "Hi", absent: false }] }).success).toBe(true);
  });

  it.each([
    ["equals 0 + min", { equals: 0, min: 2 }, { min: 2 }],
    ["equals 0 + max", { equals: 0, max: 5 }, { max: 5 }],
    ["max 0 + min", { min: 1, max: 0 }, { min: 1 }],
    ["max 0 + equals", { equals: 3, max: 0 }, { equals: 3 }],
    ["min 0 + equals", { equals: 3, min: 0 }, { equals: 3 }],
    ["min 0 + max", { min: 0, max: 4 }, { max: 4 }],
    ["all placeholders around equals", { equals: 2, min: 0, max: 0 }, { equals: 2 }],
    ["equals 0 alone", { equals: 0 }, { equals: 0 }],
    ["min 0 alone", { min: 0 }, { min: 0 }],
    ["max 0 alone", { max: 0 }, { max: 0 }],
    ["equals 0 + max 0", { equals: 0, max: 0 }, { equals: 0, max: 0 }],
  ])("count placeholder zeros: %s", (_name, given, kept) => {
    expect(parse([{ type: "count", selector: "li", ...given }])).toEqual({ ok: true, value: [{ type: "count", selector: "li", ...kept }] });
  });

  it("keeps an empty equals when contains is empty too, drops it next to a real contains", () => {
    expect(parse([{ type: "value", selector: "i", equals: "", contains: "" }])).toEqual({ ok: true, value: [{ type: "value", selector: "i", equals: "" }] });
    expect(parse([{ type: "value", selector: "i", equals: "", contains: "x" }])).toEqual({ ok: true, value: [{ type: "value", selector: "i", contains: "x" }] });
  });

  it("keeps real zeros and empties: index 0 alone, an empty expected input value", () => {
    expect(parse([{ type: "element", index: 0, state: "visible" }])).toEqual({ ok: true, value: [{ type: "element", index: 0, state: "visible" }] });
    expect(parse([{ type: "value", selector: "input", equals: "" }])).toEqual({ ok: true, value: [{ type: "value", selector: "input", equals: "" }] });
    expect(parse([{ type: "text", text: "" }]).ok).toBe(false);
  });

  it("names the failing entry", () => {
    const r = parse([{ type: "text", text: "a" }, { type: "count", selector: "li" }]);
    expect(r.ok ? "" : r.errors[0]).toMatch(/^checks\[1\]:/);
  });
});

describe("qaAssertSchema", () => {
  it("accepts what the hand parser accepts and has a described definition", () => {
    const input = { checks: [{ type: "element", selector: "#a", state: "visible" }, { type: "no_console_errors" }] };
    expect(qaAssertSchema.safeParse(input).success).toBe(true);
    expect(qaAssertSchema.safeParse({ checks: [] }).success).toBe(false);
    expect(qaAssertSchema.safeParse({ checks: [{ type: "element", selector: "a", state: "open" }] }).success).toBe(false);
    expect(qaAssertDefinition.description).toContain("results");
  });

  it("accepts strict-mode placeholders and strips them before validation", () => {
    const r = qaAssertSchema.safeParse({ checks: [{ type: "element", selector: "#a", index: 0, state: "visible", text: "", equals: null, ignore: [] }] });
    expect(r.success).toBe(true);
    expect(r.success && r.data.checks).toEqual([{ type: "element", selector: "#a", state: "visible" }]);
  });
});

const sinkOf = (consoleErrors: string[] = [], failedRequests: string[] = []) => {
  const added: unknown[] = [];
  return { seenConsoleErrors: () => consoleErrors, seenFailedRequests: () => failedRequests, addChecks: (r: unknown[]) => added.push(...r), addDiagnostics: () => undefined, added };
};

describe("evaluateQaChecks", () => {
  const checks: QaCheck[] = [{ type: "text", text: "a" }, { type: "no_console_errors" }, { type: "no_failed_requests", ignore: ["/favicon"] }];

  it("keeps the controller's DOM answers and judges the two history checks with the run history", () => {
    const answer = { ok: true, results: [{ passed: false, actual: "not found" }, { passed: true }, { passed: true }] };
    const r = evaluateQaChecks(answer, checks, { seenConsoleErrors: () => ["TypeError: boom"], seenFailedRequests: () => ["GET 404 https://a.test/favicon.ico"] });
    expect(r.ok && r.results.map((x) => x.passed)).toEqual([false, false, true]);
    expect(r.ok && r.results[0]!.actual).toBe("not found");
    expect(r.ok && r.results[1]!.actual).toContain("1 console error: TypeError: boom");
    expect(r.ok && r.passed).toBe(false);
  });

  it("adds what this call drained and passes when nothing is left after ignore", () => {
    const answer = { results: [{ passed: true }, { passed: true }, { passed: true }], consoleErrors: ["x"], failedRequests: ["GET 404 https://a.test/favicon.ico"] };
    const r = evaluateQaChecks(answer, checks);
    expect(r.ok && r.results.map((x) => x.passed)).toEqual([true, false, true]);
    expect(r.ok && r.consoleErrors).toEqual(["x"]);
  });

  it("does not double count an entry in the history and the drain", () => {
    const answer = { results: [{ passed: true }, { passed: true }, { passed: true }], consoleErrors: ["x"] };
    const r = evaluateQaChecks(answer, checks, { seenConsoleErrors: () => ["x"] });
    expect(r.ok && r.results[1]!.actual).toContain("1 console error");
  });

  it("cuts a long actual to 120 chars", () => {
    const r = evaluateQaChecks({ results: [{ passed: false, actual: "z".repeat(500) }] }, [{ type: "text", text: "a" }]);
    expect(r.ok && r.results[0]!.actual!.length).toBeLessThanOrEqual(120);
  });

  it("returns an error for { error }, a missing answer and a result list of the wrong length", () => {
    expect(evaluateQaChecks({ error: "No browser tab" }, checks)).toEqual({ ok: false, error: "No browser tab" });
    expect(evaluateQaChecks(undefined, checks).ok).toBe(false);
    expect(evaluateQaChecks({ results: [] }, checks).ok).toBe(false);
  });
});

describe("executeQaAssert", () => {
  const checks = [{ type: "text", text: "Done" }, { type: "no_console_errors" }];

  it("calls the browser, evaluates with history, records the results as agent checks and returns the drained lists", async () => {
    const sink = sinkOf(["old error"]);
    const browser = { assert: async () => ({ ok: true, passed: true, results: [{ passed: true }, { passed: true }], failedRequests: ["GET 500 https://a.test/x"] }) };
    const out = JSON.parse(await executeQaAssert({ checks }, browser, sink));
    expect(out.passed).toBe(false);
    expect(out.results[0].passed).toBe(true);
    expect(out.results[1].passed).toBe(false);
    expect(out.failedRequests).toEqual(["GET 500 https://a.test/x"]);
    expect(out).not.toHaveProperty("consoleErrors");
    expect(sink.added).toHaveLength(2);
    expect(sink.added[0]).toMatchObject({ source: "agent", passed: true, check: { type: "text" } });
  });

  it("hands the drained lists of an answer it cannot evaluate to the sink", async () => {
    const diag: unknown[] = [];
    const sink = { ...sinkOf(), addDiagnostics: (d: unknown) => diag.push(d) };
    const out = JSON.parse(await executeQaAssert({ checks }, { assert: async () => ({ results: [], consoleErrors: ["boom"], failedRequestsDropped: 2 }) }, sink));
    expect(out.error).toContain("malformed");
    expect(diag).toEqual([{ consoleErrors: ["boom"], failedRequestsDropped: 2 }]);
  });

  it("passes the dropped counters of the controller's drain on in its output", async () => {
    const out = JSON.parse(await executeQaAssert({ checks }, { assert: async () => ({ results: [{ passed: true }, { passed: true }], consoleErrors: ["a"], consoleErrorsDropped: 4 }) }, sinkOf()));
    expect(out).toMatchObject({ consoleErrors: ["a"], consoleErrorsDropped: 4 });
  });

  it("returns { error } for bad input, a browser without assert, a throw and an error answer, and records nothing", async () => {
    const sink = sinkOf();
    expect(JSON.parse(await executeQaAssert({ checks: [] }, { assert: async () => ({}) }, sink)).error).toContain(`${QA_ASSERT_TOOL}: checks`);
    expect(JSON.parse(await executeQaAssert({}, { assert: async () => ({}) }, sink)).error).toContain("expected an array");
    expect(JSON.parse(await executeQaAssert({ checks }, {}, sink)).error).toContain("does not support");
    expect(JSON.parse(await executeQaAssert({ checks }, { assert: async () => { throw new Error("gone"); } }, sink)).error).toContain("gone");
    expect(JSON.parse(await executeQaAssert({ checks }, { assert: async () => ({ error: "No browser tab is open" }) }, sink)).error).toContain("No browser tab");
    expect(sink.added).toEqual([]);
  });
});

describe("runFinalChecks", () => {
  const checks: QaCheck[] = [{ type: "text", text: "a" }];
  const drained: unknown[] = [];
  const sink = () => ({ ...sinkOf(), addDiagnostics: (d: unknown) => drained.push(d) });

  it("returns one result per check and hands the drained lists to the sink", async () => {
    drained.length = 0;
    const r = await runFinalChecks({ assert: async () => ({ results: [{ passed: true }], consoleErrors: ["e"] }) }, checks, sink());
    expect(r).toEqual([{ check: checks[0], passed: true }]);
    expect(drained).toEqual([{ consoleErrors: ["e"], failedRequests: undefined }]);
  });

  it.each([
    ["no assert", {}, "does not support"],
    ["a throw", { assert: async () => { throw new Error("boom"); } }, "boom"],
    ["an error answer", { assert: async () => ({ error: "No browser tab" }) }, "No browser tab"],
  ])("fails every check on %s", async (_n, browser, text) => {
    const r = await runFinalChecks(browser, [...checks, { type: "url", contains: "x" }], sink());
    expect(r.map((x) => x.passed)).toEqual([false, false]);
    expect(r[0]!.error).toContain(text);
  });

  it("harvests the drained lists even when the answer is not valid for the checks", async () => {
    drained.length = 0;
    const r = await runFinalChecks({ assert: async () => ({ results: [], consoleErrors: ["e1"], failedRequests: ["f1"], consoleErrorsDropped: 3 }) }, checks, sink());
    expect(r[0]).toMatchObject({ passed: false, error: expect.stringContaining("malformed") });
    expect(drained).toEqual([{ consoleErrors: ["e1"], failedRequests: ["f1"], consoleErrorsDropped: 3 }]);
  });

  it("harvests a late answer after the timeout, once it arrives", async () => {
    drained.length = 0;
    let release: (v: unknown) => void = () => undefined;
    const late = new Promise((resolve) => (release = resolve));
    const r = await runFinalChecks({ assert: () => late }, checks, sink(), 10);
    expect(r[0]).toMatchObject({ passed: false, error: expect.stringContaining("did not finish") });
    expect(drained).toEqual([]);
    release({ results: [{ passed: true }], failedRequests: ["GET 500 https://a.test/late"] });
    await late;
    await Promise.resolve();
    expect(drained).toEqual([{ failedRequests: ["GET 500 https://a.test/late"] }]);
  });

  it("fails every check when the browser does not answer in time", async () => {
    const r = await runFinalChecks({ assert: () => new Promise(() => undefined) }, checks, sink(), 20);
    expect(r[0]).toMatchObject({ passed: false, error: expect.stringContaining("did not finish") });
  });
});

describe("step recorder dropped counters", () => {
  const run = (rec: ReturnType<typeof createStepRecorder>, output: unknown) => rec.onToolCall(call("browse_act", {}))({ output: JSON.stringify(output) });

  it("adds the controller's dropped counters (top level and batched entries) to the run's", () => {
    const rec = createStepRecorder();
    run(rec, { consoleErrors: ["a"], consoleErrorsDropped: 3, failedRequests: ["GET 500 x"], failedRequestsDropped: 1 });
    run(rec, { results: [{ consoleErrors: ["b"], consoleErrorsDropped: 2 }, { failedRequestsDropped: 4 }] });
    rec.addDiagnostics({ consoleErrors: ["c"], consoleErrorsDropped: 1 });
    expect(rec.extras()).toMatchObject({ consoleErrors: ["a", "b", "c"], consoleErrorsDropped: 6, failedRequests: ["GET 500 x"], failedRequestsDropped: 5 });
  });
});

describe("step recorder lastAgentCall", () => {
  it("holds the records of the most recent agent batch", () => {
    const rec = createStepRecorder();
    const r = (text: string, passed: boolean) => ({ source: "agent" as const, check: { type: "text" as const, text }, passed });
    expect(rec.lastAgentCall()).toEqual([]);
    rec.addChecks([r("a", false)]);
    rec.addChecks([r("b", true), r("c", true)]);
    expect(rec.lastAgentCall().map((x) => x.check)).toEqual([{ type: "text", text: "b" }, { type: "text", text: "c" }]);
    rec.addChecks([{ source: "final", check: { type: "text", text: "z" }, passed: false }]);
    expect(rec.lastAgentCall()).toHaveLength(2);
  });
});

describe("applyFinalChecks", () => {
  const base = (over: Partial<QaResult>): QaResult => ({ outcome: "passed", verdict: "pass", reason: "badge says 2", steps: [], ...over });
  const ok: QaCheckResult = { check: { type: "text", text: "a" }, passed: true };
  const bad: QaCheckResult = { check: { type: "element", selector: "#x", state: "visible" }, passed: false, actual: "hidden" };

  it("turns passed into failed with the first failure and the agent's reason, and records the checks", () => {
    const r = applyFinalChecks(base({ checks: [{ source: "agent", ...ok }] }), [ok, bad]);
    expect(r.outcome).toBe("failed");
    expect(r.verdict).toBe("pass");
    expect(r.reason).toBe("Final check failed: #x is visible (hidden). Agent verdict: badge says 2");
    expect(r.checks!.map((c) => c.source)).toEqual(["agent", "final", "final"]);
  });

  it("caps the reason at 500 chars: the check text is cut first, then the agent reason", () => {
    const long: QaCheckResult = { check: { type: "text", text: "t".repeat(900) }, passed: false, actual: "a".repeat(100) };
    const r = applyFinalChecks(base({ reason: "v".repeat(500) }), [long]);
    expect(r.reason!.length).toBeLessThanOrEqual(500);
    expect(r.reason).toMatch(/^Final check failed: /);
    expect(r.reason).toContain("Agent verdict: vvv");
    expect(r.reason).toContain("...");
  });

  it("keeps a passed outcome when every final check passed", () => {
    const r = applyFinalChecks(base({}), [ok]);
    expect(r.outcome).toBe("passed");
    expect(r.reason).toBe("badge says 2");
    expect(r.checks).toHaveLength(1);
  });

  it("fails a pass that the agent-check rule downgraded to inconclusive when a final check failed", () => {
    const r = applyFinalChecks(base({ outcome: "inconclusive", reason: "Agent said pass, but check failed: x" }), [bad]);
    expect(r.outcome).toBe("failed");
    expect(r.reason).toMatch(/^Final check failed: #x is visible \(hidden\)\. Agent verdict: /);
  });

  it.each(["failed", "inconclusive"] as const)("does not change outcome %s on a failed final check, but records it", (outcome) => {
    const { verdict: _v, ...noVerdict } = base({});
    const r = applyFinalChecks({ ...noVerdict, outcome, reason: "r" }, [bad]);
    expect(r.outcome).toBe(outcome);
    expect(r.reason).toBe("r");
    expect(r.checks).toHaveLength(1);
  });

  it.each(["setup_failed", "aborted", "error"] as const)("skips outcome %s", (outcome) => {
    const qa = base({ outcome });
    expect(finalChecksApply(qa)).toBe(false);
    expect(applyFinalChecks(qa, [bad])).toBe(qa);
  });
});

describe("createStepRecorder: diagnostics", () => {
  const done = (rec: ReturnType<typeof createStepRecorder>, tool: string, output: unknown, id = "c") => rec.onToolCall(call(tool, {}, id))({ output: JSON.stringify(output) });

  it("harvests consoleErrors and failedRequests from tool outputs, deduped, in first-seen order", () => {
    const rec = createStepRecorder();
    done(rec, "browse_act", { consoleErrors: ["a", "b"], failedRequests: ["GET 404 https://x.test/1"] }, "1");
    done(rec, "browse_act", { consoleErrors: ["b", "c"] }, "2");
    done(rec, "browse_read", { text: "no lists" }, "3");
    expect(rec.extras()).toEqual({ consoleErrors: ["a", "b", "c"], failedRequests: ["GET 404 https://x.test/1"] });
    expect(rec.seenConsoleErrors()).toEqual(["a", "b", "c"]);
  });

  it("caps each list at 20 and counts the rest as dropped", () => {
    const rec = createStepRecorder();
    done(rec, "browse_act", { consoleErrors: Array.from({ length: 25 }, (_, i) => `e${i}`), failedRequests: Array.from({ length: QA_RESULT_MAX_DIAGNOSTICS }, (_, i) => `r${i}`) });
    const extras = rec.extras();
    expect(extras.consoleErrors).toHaveLength(20);
    expect(extras.consoleErrors![0]).toBe("e0");
    expect(extras.consoleErrorsDropped).toBe(5);
    expect(extras).not.toHaveProperty("failedRequestsDropped");
  });

  it("ignores non-string entries and a non-array", () => {
    const rec = createStepRecorder();
    done(rec, "browse_act", { consoleErrors: [1, null, "ok"], failedRequests: "nope" });
    expect(rec.extras()).toEqual({ consoleErrors: ["ok"] });
  });

  it("has no extras when nothing was seen, and qaResultOf adds them", () => {
    const rec = createStepRecorder();
    expect(rec.extras()).toEqual({});
    rec.addChecks([{ source: "agent", check: { type: "text", text: "a" }, passed: true }]);
    rec.addDiagnostics({ failedRequests: ["GET 500 https://a.test/x"] });
    const qa = qaResultOf({ status: "done" }, rec.steps(), rec.extras());
    expect(qa).toMatchObject({ outcome: "inconclusive", failedRequests: ["GET 500 https://a.test/x"], checks: [{ source: "agent" }] });
    expect(qaResultOf({ status: "done" }, [])).not.toHaveProperty("checks");
  });

  it("a qa_assert step with a failed check is still an ok step", () => {
    const rec = createStepRecorder();
    done(rec, QA_ASSERT_TOOL, { passed: false, results: [] });
    expect(rec.steps()[0]).toMatchObject({ tool: "qa_assert", ok: true });
  });
});

describe("normalizeQaChecks type inference", () => {
  const one = (c: unknown) => (normalizeQaChecks([c]) as Array<Record<string, unknown>>)[0];
  it.each([
    [{ selector: "#a", state: "visible" }, "element"],
    [{ index: 2, state: "checked" }, "element"],
    [{ matches: "orders/\\d+" }, "url"],
    [{ selector: "tr", visible: true, min: 1 }, "count"],
    [{ selector: "tr", equals: 3 }, "count"],
    [{ selector: "tr", max: 0 }, "count"],
    [{ matches: "x", contains: "/orders" }, "url"],
    [{ text: "Hi", absent: "yes" }, "text"],
    [{ selector: "tr", visible: true, equals: "3" }, "count"],
    [{ selector: "tr", min: 1.5 }, "count"],
    [{ matches: "(" }, "url"],
    [{ selector: "a", state: "bogus" }, "element"],
    [{ selector: "tr", equals: 0, min: 2 }, "count"],
    [{ text: "Hello" }, "text"],
    [{ text: "Hello", absent: true }, "text"],
    [{ type: "", selector: "#a", state: "hidden" }, "element"],
    [{ type: null, text: "Hi", absent: "" }, "text"],
  ])("infers the type of %j as %s", (check, type) => {
    expect(one(check).type).toBe(type);
  });
  it.each([[{}], [{ ignore: ["x"] }], [{ ignore: [] }], [{ selector: "#a" }], [{ state: "visible", matches: "x" }], [{ text: "a", selector: "#a" }], [{ junk: 1 }], [{ contains: "Welcome back" }], [{ equals: "https://a.b/" }], [{ selector: "h1", contains: "Welcome" }], [{ selector: "input", equals: "x" }], [{ index: 1, contains: "x" }], [{ selector: "input#q", equals: "" }], [{ selector: "#a", state: "visible", equals: false }], [{ selector: "tr", equals: 1.5 }], [{ selector: "tr", equals: -1 }], [{ selector: "text=Hi", equals: "x" }]])(
    "leaves %j untyped",
    (check) => {
      expect(one(check).type).toBeUndefined();
    },
  );
  it("does not change a typed check", () => {
    expect(one({ type: "url", selector: "#a", state: "visible" })).toEqual({ type: "url", selector: "#a", state: "visible" });
    expect(one({ type: "no_console_errors" })).toEqual({ type: "no_console_errors" });
  });
  it("normalizes an untyped check like the typed one", () => {
    expect(one({ selector: "tr", equals: 0, min: 2 })).toEqual(one({ type: "count", selector: "tr", equals: 0, min: 2 }));
    expect(one({ selector: "tr", equals: 0, min: 2 })).toEqual({ type: "count", selector: "tr", min: 2 });
    expect(one({ type: "value", selector: "a", equals: "", contains: "x" })).toEqual({ type: "value", selector: "a", contains: "x" });
  });
  it("the inferred type wins over a type: undefined key", () => {
    const r = one({ type: undefined, selector: "#a", state: "visible" });
    expect(r.type).toBe("element");
    expect(Object.keys(r)[0]).toBe("type");
  });
  it("a bare contains stays untyped with a type: missing error", () => {
    const r = parse([{ contains: "Welcome back" }]);
    expect(JSON.stringify(r)).toContain("type: missing");
  });
  it("parseQaChecks and qaAssertSchema accept an untyped check", () => {
    expect(parse([{ selector: "#a", state: "visible" }])).toEqual({ ok: true, value: [{ type: "element", selector: "#a", state: "visible" }] });
    expect(qaAssertSchema.parse({ checks: [{ selector: "#a", state: "visible" }] }).checks).toEqual([{ type: "element", selector: "#a", state: "visible" }]);
  });
  it("names the missing type and the allowed values", () => {
    const r = parse([{ ignore: ["x"] }]);
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).toContain('set \\"type\\"');
    expect(JSON.stringify(r)).toContain("no_failed_requests");
    const z1 = qaAssertSchema.safeParse({ checks: [{ ignore: [] }] });
    expect(z1.success).toBe(false);
    const msg = JSON.stringify(z1.success ? "" : z1.error.issues);
    expect(msg).toContain('set \\"type\\"');
    expect(msg).toContain("no_failed_requests");
    const z2 = qaAssertSchema.safeParse({ checks: [{ type: "bogus" }] });
    const issues = z2.success ? [] : z2.error.issues;
    expect(JSON.stringify(issues)).toContain("expected \\\"text\\\"");
    expect(issues.every((i) => !i.message.startsWith("type:"))).toBe(true);
    const z3 = qaAssertSchema.safeParse({ checks: [{ ignore: [] }] });
    expect((z3.success ? [] : z3.error.issues).every((i) => !i.message.startsWith("type:"))).toBe(true);
  });
  it("hand parser keeps the field name in its message", () => {
    expect(JSON.stringify(parse([{ ignore: ["x"] }]))).toContain("checks[0]: type: missing");
  });
});

describe("normalizeQaChecks strict-mode placeholders and inference", () => {
  const one = (c: unknown) => (normalizeQaChecks([c]) as Array<Record<string, unknown>>)[0];
  it("index:0 next to a selector does not block inference", () => {
    expect(one({ selector: "tr", index: 0, min: 1 })).toEqual(one({ type: "count", selector: "tr", index: 0, min: 1 }));
    expect(one({ selector: "tr", index: 0, min: 1 })).toEqual({ type: "count", selector: "tr", min: 1 });
    expect(one({ selector: "#a", index: 0, state: "visible" }).type).toBe("element");
  });
  it("an all-placeholder object stays untyped", () => {
    const c = { selector: "", index: 0, equals: "", contains: "", state: "" };
    expect(one(c).type).toBeUndefined();
    expect(JSON.stringify(parse([c]))).toContain("type: missing");
  });
  it("false booleans do not make a check ambiguous", () => {
    expect(one({ selector: "#a", visible: false, state: "visible" })).toEqual(one({ type: "element", selector: "#a", visible: false, state: "visible" }));
    expect(one({ selector: "#a", visible: false, state: "visible" }).type).toBe("element");
    expect(one({ text: "Hi", absent: false, visible: false })).toEqual(one({ type: "text", text: "Hi", absent: false, visible: false }));
    expect(one({ text: "Hi", absent: false, visible: false }).type).toBe("text");
  });
  it("a selector with only visible:false stays untyped", () => {
    expect(one({ selector: "#a", visible: false }).type).toBeUndefined();
    expect(one({ selector: "#a" }).type).toBeUndefined();
  });
  it("value is never inferred; an empty equals is a placeholder without a type", () => {
    expect(one({ selector: "i", index: 0, equals: "", contains: "", state: "" }).type).toBeUndefined();
    expect(one({ index: 2, equals: "" }).type).toBeUndefined();
    expect(one({ equals: "" })).toEqual({});
  });
  it("one type passing the key filter is chosen and validation reports the field error", () => {
    expect(JSON.stringify(parse([{ text: "Hi", absent: "yes" }]))).toContain("checks[0]: absent: expected a boolean");
    expect(JSON.stringify(parse([{ selector: "tr", min: 1.5 }]))).toContain("min: expected a non-negative integer");
    expect(JSON.stringify(parse([{ matches: "(" }]))).toContain("matches: not a valid regular expression");
  });
  it("false is absent only for visible and absent", () => {
    expect(one({ selector: "#a", state: "visible", equals: false }).type).toBeUndefined();
    expect(JSON.stringify(parse([{ selector: "#a", state: "visible", equals: false }]))).toContain("type: missing");
  });
  it("an explicitly typed value check keeps equals: ''", () => {
    expect(one({ type: "value", selector: "a", equals: "" })).toEqual({ type: "value", selector: "a", equals: "" });
  });
  it("typed checks normalize as before", () => {
    expect(one({ type: "count", selector: "tr", index: 0, equals: 0, min: 2, max: 0 })).toEqual({ type: "count", selector: "tr", min: 2 });
    expect(one({ type: "value", selector: "a", equals: "" })).toEqual({ type: "value", selector: "a", equals: "" });
    expect(one({ type: "text", text: "Hi", absent: false, selector: "" })).toEqual({ type: "text", text: "Hi", absent: false });
    expect(one({ type: "element", index: 0, state: "visible" })).toEqual({ type: "element", index: 0, state: "visible" });
    expect(one({ type: "element", selector: "#a", index: 0, state: "visible" })).toEqual({ type: "element", selector: "#a", state: "visible" });
  });
});
