import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { runBrowseAgent } from "../../src/agent/aiSdk.js";
import { QA_PROMPT_SECTION } from "../../src/agent/qa.js";
import type { QaCheck, QaResult } from "../../src/agent/qaTypes.js";
import type { BrowserBridge } from "../../src/loop/bridge.js";

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 4, text: 4, reasoning: undefined },
};
type Step = { text?: string; calls?: { name: string; input: unknown }[] };

function scripted(steps: Step[]) {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const step = steps[Math.min(i, steps.length - 1)]!;
      i += 1;
      const content: unknown[] = [];
      if (step.text) content.push({ type: "text", text: step.text });
      for (const [k, c] of (step.calls ?? []).entries()) content.push({ type: "tool-call", toolCallId: `c${i}-${k}`, toolName: c.name, input: JSON.stringify(c.input) });
      return {
        finishReason: step.calls?.length ? { unified: "tool-calls" as const, raw: "tool_calls" } : { unified: "stop" as const, raw: "stop" },
        usage,
        warnings: [] as never[],
        content,
      } as never;
    },
  });
}

/** An `assert` that passes DOM checks unless the text is "missing", and drains the given lists once per call. */
function assertingBrowser(drains: { consoleErrors?: string[]; failedRequests?: string[] }[] = [], over: Partial<BrowserBridge> = {}) {
  const calls: unknown[] = [];
  const bridge: BrowserBridge = {
    open: async (a) => ({ url: a.url, title: "A" }),
    act: async () => ({ changed: true }),
    read: async () => ({ text: "page text" }),
    snapshot: async () => ({ snapshotId: "s1", url: "https://a.test/", title: "A", elements: [] }),
    perform: async () => ({}),
    assert: async (args) => {
      calls.push(args);
      const drain = drains.shift() ?? {};
      return {
        ok: true,
        results: (args.checks as QaCheck[]).map((c) => ({ passed: !(c.type === "text" && c.text === "missing"), ...(c.type === "text" && c.text === "missing" ? { actual: "not found" } : {}) })),
        ...drain,
      };
    },
    ...over,
  };
  return { bridge, calls };
}
const verdict = (v: "pass" | "fail", reason = "because"): Step => ({ calls: [{ name: "qa_verdict", input: { verdict: v, reason } }] });
const assertStep = (checks: QaCheck[]): Step => ({ calls: [{ name: "qa_assert", input: { checks } }] });
const qaOf = (r: unknown) => (r as { qa: QaResult }).qa;

describe("runBrowseAgent: qa_assert", () => {
  it("is not offered without qa, and offered with qa next to qa_verdict; the prompt names it", async () => {
    const plain = scripted([{ text: "ok" }]);
    await runBrowseAgent("goal", { model: plain, browser: assertingBrowser().bridge });
    expect((plain.doGenerateCalls[0]!.tools ?? []).map((t) => t.name)).not.toContain("qa_assert");
    const model = scripted([{ text: "ok" }]);
    await runBrowseAgent("goal", { model, browser: assertingBrowser().bridge, qa: true });
    const names = (model.doGenerateCalls[0]!.tools ?? []).map((t) => t.name);
    expect(names).toContain("qa_assert");
    expect(names).toContain("qa_verdict");
    expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).toContain(QA_PROMPT_SECTION.split("\n")[1]!.slice(0, 40));
  });

  it("downgrades pass to inconclusive when the last qa_assert call still has a failed check", async () => {
    const { bridge } = assertingBrowser();
    const model = scripted([assertStep([{ type: "text", text: "Done" }]), assertStep([{ type: "text", text: "missing" }]), verdict("pass", "saw Done"), { text: "fin" }]);
    const qa = qaOf(await runBrowseAgent("goal", { model, browser: bridge, qa: true }));
    expect(qa.outcome).toBe("inconclusive");
    expect(qa.reason).toContain('Agent said pass, but check failed: text "missing" present (not found). Agent reason: saw Done');
  });

  it("runs the checks, records them as agent checks, does not change the outcome when a later call passes, and may repeat", async () => {
    const { bridge, calls } = assertingBrowser();
    const model = scripted([assertStep([{ type: "text", text: "missing" }]), assertStep([{ type: "text", text: "Done" }]), verdict("pass", "saw Done"), { text: "fin" }]);
    const r = await runBrowseAgent("goal", { model, browser: bridge, qa: true });
    const qa = qaOf(r);
    expect(calls).toHaveLength(2);
    expect(qa.outcome).toBe("passed");
    expect(qa.checks).toEqual([
      { source: "agent", check: { type: "text", text: "missing" }, passed: false, actual: "not found" },
      { source: "agent", check: { type: "text", text: "Done" }, passed: true },
    ]);
    expect(qa.steps.map((s) => s.tool)).toEqual(["qa_assert", "qa_assert", "qa_verdict"]);
    expect(qa.steps.every((s) => s.ok)).toBe(true);
  });

  it("judges no_console_errors against the whole run: an error seen in an earlier act fails a later check", async () => {
    const { bridge } = assertingBrowser([{}], { act: async () => ({ changed: true, consoleErrors: ["TypeError: boom"] }) });
    const model = scripted([
      { calls: [{ name: "browse_act", input: { action: "wait", ms: 1 } }] },
      assertStep([{ type: "no_console_errors" }, { type: "no_console_errors", ignore: ["boom"] }]),
      verdict("pass"),
      { text: "fin" },
    ]);
    const qa = qaOf(await runBrowseAgent("goal", { model, browser: bridge, qa: true }));
    expect(qa.checks!.map((c) => c.passed)).toEqual([false, true]);
    expect(qa.consoleErrors).toEqual(["TypeError: boom"]);
  });

  it("a start page that throws on load: its errors reach qa.consoleErrors and fail a later no_console_errors check", async () => {
    const { bridge } = assertingBrowser([{}], { open: async (a) => ({ url: a.url, title: "A", consoleErrors: ["Uncaught: load boom"], failedRequests: ["GET 500 https://a.test/x.js"] }) });
    const model = scripted([assertStep([{ type: "no_console_errors" }, { type: "no_failed_requests" }]), verdict("pass"), { text: "fin" }]);
    const qa = qaOf(await runBrowseAgent("goal", { model, browser: bridge, url: "https://a.test/", qa: true }));
    expect(qa.consoleErrors).toEqual(["Uncaught: load boom"]);
    expect(qa.failedRequests).toEqual(["GET 500 https://a.test/x.js"]);
    expect(qa.checks!.map((c) => c.passed)).toEqual([false, false]);
    // The pre-open is still not a step.
    expect(qa.steps.map((s) => s.tool)).toEqual(["qa_assert", "qa_verdict"]);
  });

  it("puts the errors a qa_assert call drained into the run lists", async () => {
    const { bridge } = assertingBrowser([{ consoleErrors: ["E1"], failedRequests: ["GET 500 https://a.test/api"] }]);
    const model = scripted([assertStep([{ type: "no_failed_requests" }]), verdict("fail", "api failed"), { text: "fin" }]);
    const qa = qaOf(await runBrowseAgent("goal", { model, browser: bridge, qa: true }));
    expect(qa.outcome).toBe("failed");
    expect(qa.consoleErrors).toEqual(["E1"]);
    expect(qa.failedRequests).toEqual(["GET 500 https://a.test/api"]);
    expect(qa.checks![0]).toMatchObject({ passed: false });
  });

  it("gives the model an error for invalid checks and for a browser without assert, and records no check", async () => {
    const noAssert = assertingBrowser([], { assert: undefined }).bridge;
    const model = scripted([assertStep([{ type: "count", selector: "li" } as never]), assertStep([{ type: "text", text: "a" }]), verdict("pass"), { text: "fin" }]);
    const qa = qaOf(await runBrowseAgent("goal", { model, browser: noAssert, qa: true }));
    expect(qa.steps.filter((s) => s.tool === "qa_assert").map((s) => s.ok)).toEqual([false, false]);
    expect(qa).not.toHaveProperty("checks");
  });

  it("refuses a host tool named qa_assert", async () => {
    await expect(
      runBrowseAgent("goal", {
        model: scripted([{ text: "ok" }]),
        browser: assertingBrowser().bridge,
        qa: true,
        extraTools: { qa_assert: { description: "x", inputSchema: (await import("zod")).z.object({}), execute: async () => "{}" } },
      }),
    ).rejects.toThrow(/qa_assert/);
  });
});

describe("runBrowseAgent: qa.checks (final checks)", () => {
  const final: QaCheck[] = [{ type: "text", text: "Done" }];
  const failing: QaCheck[] = [{ type: "text", text: "missing" }];

  it("runs once after the loop, records source final, and keeps a passing outcome", async () => {
    const { bridge, calls } = assertingBrowser();
    const model = scripted([verdict("pass", "ok"), { text: "fin" }]);
    const qa = qaOf(await runBrowseAgent("goal", { model, browser: bridge, qa: { checks: final } }));
    expect(calls).toEqual([{ checks: final }]);
    expect(qa.outcome).toBe("passed");
    expect(qa.checks).toEqual([{ source: "final", check: final[0], passed: true }]);
  });

  it("carries an inferred type of an untyped final check into the call and the record", async () => {
    const { bridge, calls } = assertingBrowser();
    const model = scripted([verdict("pass", "ok"), { text: "fin" }]);
    const untyped = [{ selector: "#a", state: "visible" }] as unknown as QaCheck[];
    const qa = qaOf(await runBrowseAgent("goal", { model, browser: bridge, qa: { checks: untyped } }));
    expect(calls).toEqual([{ checks: [{ type: "element", selector: "#a", state: "visible" }] }]);
    expect(qa.checks?.[0]?.check).toEqual({ type: "element", selector: "#a", state: "visible" });
  });

  it("turns passed into failed when a final check fails", async () => {
    const model = scripted([verdict("pass", "looks fine"), { text: "fin" }]);
    const qa = qaOf(await runBrowseAgent("goal", { model, browser: assertingBrowser().bridge, qa: { checks: failing } }));
    expect(qa.outcome).toBe("failed");
    expect(qa.verdict).toBe("pass");
    expect(qa.reason).toBe('Final check failed: text "missing" present (not found). Agent verdict: looks fine');
  });

  it("does not change failed or inconclusive outcomes", async () => {
    const failed = qaOf(await runBrowseAgent("goal", { model: scripted([verdict("fail", "bad"), { text: "fin" }]), browser: assertingBrowser().bridge, qa: { checks: failing } }));
    expect(failed.outcome).toBe("failed");
    expect(failed.reason).toBe("bad");
    expect(failed.checks).toHaveLength(1);
    const inconclusive = qaOf(await runBrowseAgent("goal", { model: scripted([{ text: "blocked" }]), browser: assertingBrowser().bridge, qa: { checks: failing } }));
    expect(inconclusive.outcome).toBe("inconclusive");
  });

  it("is skipped for setup_failed, aborted and error", async () => {
    const { bridge, calls } = assertingBrowser();
    // A fixture on a bridge without applyFixture ends the run before the model starts.
    const setup = qaOf(await runBrowseAgent("goal", { model: scripted([{ text: "ok" }]), browser: bridge, qa: { checks: failing }, fixture: { version: 1, url: "https://a.test/" } }));
    expect(setup.outcome).toBe("setup_failed");
    expect(setup).not.toHaveProperty("checks");
    const controller = new AbortController();
    controller.abort();
    const aborted = qaOf(await runBrowseAgent("goal", { model: scripted([{ text: "ok" }]), browser: bridge, qa: { checks: failing }, signal: controller.signal }));
    expect(aborted.outcome).toBe("aborted");
    const errored = qaOf(
      await runBrowseAgent("goal", {
        model: new MockLanguageModelV3({ doGenerate: async () => { throw new Error("model down"); } }),
        browser: bridge,
        qa: { checks: failing },
      }),
    );
    expect(errored.outcome).toBe("error");
    expect(errored).not.toHaveProperty("checks");
    expect(calls).toEqual([]);
  });

  it("fails the run clearly when the browser cannot assert", async () => {
    const model = scripted([verdict("pass", "ok"), { text: "fin" }]);
    const qa = qaOf(await runBrowseAgent("goal", { model, browser: assertingBrowser([], { assert: undefined }).bridge, qa: { checks: final } }));
    expect(qa.outcome).toBe("failed");
    expect(qa.reason).toContain("does not support assertions");
  });

  it("lists the errors the final checks drained", async () => {
    const { bridge } = assertingBrowser([{ failedRequests: ["GET 404 https://a.test/late"] }]);
    const qa = qaOf(await runBrowseAgent("goal", { model: scripted([verdict("pass", "ok"), { text: "fin" }]), browser: bridge, qa: { checks: [{ type: "no_failed_requests" }] } }));
    expect(qa.outcome).toBe("failed");
    expect(qa.failedRequests).toEqual(["GET 404 https://a.test/late"]);
  });

  it("throws before any browser command when the checks are invalid", async () => {
    const { bridge, calls } = assertingBrowser();
    await expect(runBrowseAgent("goal", { model: scripted([{ text: "ok" }]), browser: bridge, qa: { checks: [{ type: "count", selector: "li" } as never] } })).rejects.toThrow(/qa\.checks/);
    expect(calls).toEqual([]);
  });
});
