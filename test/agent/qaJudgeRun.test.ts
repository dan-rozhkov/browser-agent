import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { runBrowseAgent } from "../../src/agent/aiSdk.js";
import { QA_JUDGE_CONTEXT_MAX_CHARS, QA_JUDGE_SYSTEM } from "../../src/agent/qaJudge.js";
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

/** A judge model that answers with `answer` (a JSON value or a function that throws). */
function judgeModel(answer: unknown | (() => unknown), onCall?: () => void) {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      onCall?.();
      const value = typeof answer === "function" ? (answer as () => unknown)() : answer;
      return {
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage,
        warnings: [] as never[],
        content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
      } as never;
    },
  });
}

const PAGE_TEXT = "Task list: Buy milk";
function browser(over: Partial<BrowserBridge> = {}, log?: string[]): BrowserBridge {
  return {
    open: async (a) => ({ url: a.url, title: "A" }),
    act: async () => ({ changed: true }),
    read: async () => ({ text: "page text" }),
    snapshot: async () => {
      log?.push("snapshot");
      return { snapshotId: "s1", url: "https://a.test/list", title: "Inbox", elements: [], text: PAGE_TEXT };
    },
    perform: async () => ({}),
    assert: async (args) => ({ ok: true, results: (args.checks as QaCheck[]).map((c) => ({ passed: !(c.type === "text" && c.text === "missing") })) }),
    ...over,
  };
}
const verdict = (v: "pass" | "fail", reason = "AGENT-REASON"): Step => ({ text: "ACTING-TEXT", calls: [{ name: "qa_verdict", input: { verdict: v, reason } }] });
const qaOf = (r: unknown) => (r as { qa: QaResult }).qa;
const GOAL = "Add a task and see it in the list";
const promptText = (m: MockLanguageModelV3) => JSON.stringify(m.doGenerateCalls[0]!.prompt);

describe("runBrowseAgent: qa.judge", () => {
  it("is not called without the option, and the result has no judge", async () => {
    const judge = judgeModel({ verdict: "fail", reason: "x" });
    const r = await runBrowseAgent(GOAL, { model: scripted([verdict("pass"), { text: "fin" }]), browser: browser(), qa: { checks: [{ type: "text", text: "Done" }] } });
    expect(judge.doGenerateCalls).toHaveLength(0);
    expect(qaOf(r).outcome).toBe("passed");
    expect(qaOf(r)).not.toHaveProperty("judge");
  });

  it("result bytes without the option equal the bytes with an unused judge on a failed run", async () => {
    const run = (qa: Parameters<typeof runBrowseAgent>[1]["qa"]) => runBrowseAgent(GOAL, { model: scripted([verdict("fail", "r"), { text: "fin" }]), browser: browser(), qa });
    const judge = judgeModel({ verdict: "pass", reason: "x" });
    expect(JSON.stringify(await run({ judge: { model: judge } }))).toBe(JSON.stringify(await run(true)));
    expect(judge.doGenerateCalls).toHaveLength(0);
  });

  it("is not called for failed, inconclusive, or a failed final check", async () => {
    const judge = judgeModel({ verdict: "pass", reason: "x" });
    const failed = await runBrowseAgent(GOAL, { model: scripted([verdict("fail"), { text: "fin" }]), browser: browser(), qa: { judge: { model: judge } } });
    expect(qaOf(failed).outcome).toBe("failed");
    const inconclusive = await runBrowseAgent(GOAL, { model: scripted([{ text: "blocked" }]), browser: browser(), qa: { judge: { model: judge } } });
    expect(qaOf(inconclusive).outcome).toBe("inconclusive");
    const finalFailed = await runBrowseAgent(GOAL, {
      model: scripted([verdict("pass"), { text: "fin" }]),
      browser: browser(),
      qa: { checks: [{ type: "text", text: "missing" }], judge: { model: judge } },
    });
    expect(qaOf(finalFailed).outcome).toBe("failed");
    expect(qaOf(finalFailed).reason).toMatch(/^Final check failed/);
    for (const r of [failed, inconclusive, finalFailed]) expect(qaOf(r)).not.toHaveProperty("judge");
    expect(judge.doGenerateCalls).toHaveLength(0);
  });

  it("reads no evidence and records an error when the signal is already aborted", async () => {
    const judge = judgeModel({ verdict: "fail", reason: "x" });
    const controller = new AbortController();
    const calls: string[] = [];
    const b = browser({
      // The final check runs after the outcome is `passed`: the abort lands between the checks and the judge.
      assert: async () => {
        controller.abort();
        return { ok: true, results: [{ passed: true }] };
      },
      read: async () => (calls.push("read"), { text: "t", url: "u" }),
      snapshot: async () => (calls.push("snapshot"), { snapshotId: "s", url: "u", title: "t", elements: [] }),
    });
    const r = await runBrowseAgent(GOAL, { model: scripted([verdict("pass"), { text: "fin" }]), browser: b, signal: controller.signal, qa: { checks: [{ type: "text", text: "Done" }], judge: { model: judge } } });
    expect(qaOf(r).outcome).toBe("passed");
    expect(qaOf(r).judge).toEqual({ error: "aborted" });
    expect(judge.doGenerateCalls).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  it("is called once for passed; a pass keeps the outcome", async () => {
    const judge = judgeModel({ verdict: "pass", reason: "The list shows it." });
    const r = await runBrowseAgent(GOAL, { model: scripted([verdict("pass"), { text: "fin" }]), browser: browser(), qa: { judge: { model: judge } } });
    expect(judge.doGenerateCalls).toHaveLength(1);
    expect(qaOf(r)).toMatchObject({ outcome: "passed", verdict: "pass", reason: "AGENT-REASON", judge: { verdict: "pass", reason: "The list shows it." } });
  });

  it("maps fail to failed and inconclusive to inconclusive", async () => {
    const fail = await runBrowseAgent(GOAL, { model: scripted([verdict("pass"), { text: "fin" }]), browser: browser(), qa: { judge: { model: judgeModel({ verdict: "fail", reason: "No error shown" }) } } });
    expect(qaOf(fail)).toMatchObject({ outcome: "failed", verdict: "pass", reason: "Judge: No error shown. Agent verdict: AGENT-REASON", judge: { verdict: "fail" } });
    const inc = await runBrowseAgent(GOAL, { model: scripted([verdict("pass"), { text: "fin" }]), browser: browser(), qa: { judge: { model: judgeModel({ verdict: "inconclusive", reason: "Too little" }) } } });
    expect(qaOf(inc)).toMatchObject({ outcome: "inconclusive", reason: "Judge: Too little. Agent verdict: AGENT-REASON", judge: { verdict: "inconclusive" } });
  });

  it("keeps passed and records the error when the judge fails", async () => {
    const thrown = await runBrowseAgent(GOAL, { model: scripted([verdict("pass"), { text: "fin" }]), browser: browser(), qa: { judge: { model: judgeModel(() => { throw new Error("provider down"); }) } } });
    expect(qaOf(thrown)).toMatchObject({ outcome: "passed", reason: "AGENT-REASON" });
    expect((qaOf(thrown).judge as { error: string }).error).toContain("provider down");
    const invalid = await runBrowseAgent(GOAL, { model: scripted([verdict("pass"), { text: "fin" }]), browser: browser(), qa: { judge: { model: judgeModel({ verdict: "maybe", reason: "" }) } } });
    expect(qaOf(invalid).outcome).toBe("passed");
    expect(qaOf(invalid).judge).toHaveProperty("error");
  });

  it("keeps passed and records the error when the snapshot fails, and does not call the judge", async () => {
    const judge = judgeModel({ verdict: "fail", reason: "x" });
    const r = await runBrowseAgent(GOAL, { model: scripted([verdict("pass"), { text: "fin" }]), browser: browser({ snapshot: async () => ({ error: "page crashed" }) }), qa: { judge: { model: judge } } });
    expect(qaOf(r).outcome).toBe("passed");
    expect(qaOf(r).judge).toEqual({ error: "page read failed: page crashed" });
    expect(judge.doGenerateCalls).toHaveLength(0);
  });

  it("times out: the request is aborted and the error is recorded", async () => {
    const hanging = new MockLanguageModelV3({
      doGenerate: (async (options: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener("abort", () => reject(new Error("judge timed out")));
        })) as never,
    });
    const r = await runBrowseAgent(GOAL, { model: scripted([verdict("pass"), { text: "fin" }]), browser: browser(), qa: { judge: { model: hanging, timeoutMs: 20 } } });
    expect(qaOf(r).outcome).toBe("passed");
    expect(qaOf(r).judge).toHaveProperty("error");
  });

  const snapLog: string[] = [];
  it("gives the judge the evidence and never the acting model's text, verdict or reason", async () => {
    const judge = judgeModel({ verdict: "pass", reason: "ok" });
    const model = scripted([
      { text: "ACTING-THINKING", calls: [{ name: "browse_act", input: { action: "click", index: 1 } }] },
      verdict("pass", "AGENT-REASON"),
      { text: "ACTING-FINAL" },
    ]);
    await runBrowseAgent(GOAL, {
      model,
      browser: browser({ read: async () => ({ text: "FULL-PAGE-TEXT", url: "https://a.test/list", title: "Inbox", truncated: true }) }, snapLog),
      qa: { checks: [{ type: "text", text: "Done" }], judge: { model: judge, context: "Inbox is the list screen.", providerOptions: { test: { x: 1 } } } },
    });
    const text = promptText(judge);
    expect(judge.doGenerateCalls[0]!.providerOptions).toEqual({ test: { x: 1 } });
    expect(text).toContain(QA_JUDGE_SYSTEM.slice(0, 40));
    expect(text).toContain(GOAL);
    expect(text).toContain("Inbox is the list screen.");
    expect(text).toContain("browse_act");
    expect(text).toContain("FULL-PAGE-TEXT");
    expect(text).not.toContain(PAGE_TEXT);
    expect(text).toContain("cut to the first");
    // The read had the text and the URL: the judge took no snapshot. The one logged call is the one the browse_act step attaches.
    expect(snapLog).toEqual(["snapshot"]);
    expect(text).toContain("https://a.test/list");
    expect(text).toContain("final");
    for (const secret of ["ACTING-THINKING", "ACTING-FINAL", "ACTING-TEXT", "AGENT-REASON", "qa_verdict"]) expect(text).not.toContain(secret);
  });

  it("falls back to the snapshot text when the read fails", async () => {
    const judge = judgeModel({ verdict: "pass", reason: "ok" });
    await runBrowseAgent(GOAL, { model: scripted([verdict("pass"), { text: "fin" }]), browser: browser({ read: async () => ({ error: "no read" }) }), qa: { judge: { model: judge } } });
    expect(promptText(judge)).toContain(PAGE_TEXT);
  });

  it("does not turn a long judge reason into an error", async () => {
    const r = await runBrowseAgent(GOAL, { model: scripted([verdict("pass"), { text: "fin" }]), browser: browser(), qa: { judge: { model: judgeModel({ verdict: "fail", reason: "w".repeat(3000) }) } } });
    expect(qaOf(r).outcome).toBe("failed");
    expect(qaOf(r).reason!.length).toBeLessThanOrEqual(500);
    expect(qaOf(r).reason).toContain("Agent verdict: AGENT-REASON");
    expect((qaOf(r).judge as { reason: string }).reason).toHaveLength(500);
  });

  it("does not hold the screenshot and the fixture release for the judge request", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowJudge = new MockLanguageModelV3({
      doGenerate: (async () => {
        order.push("judge-start");
        await gate;
        order.push("judge-end");
        return { finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [], content: [{ type: "text", text: JSON.stringify({ verdict: "fail", reason: "no" }) }] };
      }) as never,
    });
    const b = browser({
      screenshot: async () => {
        order.push("shot");
        return { imageData: "data:image/png;base64,AAAA" };
      },
      applyFixture: async () => ({ ok: true, summary: "x", fixtureToken: "t" }),
      releaseFixture: async () => {
        order.push("release");
        release();
      },
    });
    const r = await runBrowseAgent(GOAL, {
      model: scripted([verdict("pass"), { text: "fin" }]),
      browser: b,
      qa: { onScreenshot: () => void order.push("callback"), judge: { model: slowJudge } },
      fixture: { version: 1, network: [{ url: "https://x.test/*" }] },
      allowNetworkMocks: true,
    });
    // `release()` opens the gate: the run would hang if the judge request were awaited before the release.
    expect(order.indexOf("shot")).toBeLessThan(order.indexOf("judge-end"));
    expect(order.indexOf("release")).toBeLessThan(order.indexOf("judge-end"));
    expect(qaOf(r).outcome).toBe("failed");
  });

  it("an abort during the judge gives an error and keeps passed", async () => {
    const controller = new AbortController();
    const hanging = new MockLanguageModelV3({
      doGenerate: (async (options: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")));
          queueMicrotask(() => controller.abort());
        })) as never,
    });
    const r = await runBrowseAgent(GOAL, { model: scripted([verdict("pass"), { text: "fin" }]), browser: browser(), signal: controller.signal, qa: { judge: { model: hanging } } });
    expect(qaOf(r).outcome).toBe("passed");
    expect(qaOf(r).judge).toHaveProperty("error");
  });

  it("validates the judge options before any browser command", async () => {
    const calls: string[] = [];
    const spy = browser({ open: async (a) => (calls.push("open"), { url: a.url, title: "A" }) });
    const run = (judge: unknown) => runBrowseAgent(GOAL, { model: scripted([verdict("pass")]), browser: spy, url: "https://a.test/", qa: { judge: judge as never } });
    await expect(run({})).rejects.toThrow(/qa\.judge\.model/);
    for (const timeoutMs of [0, -5, Number.NaN, Infinity, "10" as never, 1500.5, 3e9]) {
      await expect(run({ model: judgeModel({}), timeoutMs })).rejects.toThrow(/qa\.judge\.timeoutMs/);
    }
    expect(calls).toEqual([]);
  });

  it("reads the judge evidence before the fixture release", async () => {
    const order: string[] = [];
    const b = browser(
      {
        applyFixture: async () => ({ ok: true, summary: "x", fixtureToken: "t" }),
        releaseFixture: async () => {
          order.push("release");
        },
      },
      order,
    );
    const judge = judgeModel({ verdict: "pass", reason: "ok" }, () => order.push("judge"));
    await runBrowseAgent(GOAL, {
      model: scripted([verdict("pass"), { text: "fin" }]),
      browser: b,
      qa: { judge: { model: judge } },
      fixture: { version: 1, network: [{ url: "https://x.test/*" }] },
      allowNetworkMocks: true,
    });
    expect(order.lastIndexOf("snapshot")).toBeLessThan(order.indexOf("release"));
    expect(order).toContain("judge");
  });

  it("throws before any browser command for a context over 16 KiB, and accepts exactly 16 KiB", async () => {
    const calls: string[] = [];
    const spy = browser({
      open: async (a) => {
        calls.push("open");
        return { url: a.url, title: "A" };
      },
      snapshot: async () => {
        calls.push("snapshot");
        return { snapshotId: "s", url: "u", title: "t", elements: [] };
      },
    });
    await expect(
      runBrowseAgent(GOAL, { model: scripted([verdict("pass")]), browser: spy, url: "https://a.test/", qa: { judge: { model: judgeModel({}), context: "x".repeat(QA_JUDGE_CONTEXT_MAX_CHARS + 1) } } }),
    ).rejects.toThrow(/qa\.judge\.context/);
    expect(calls).toEqual([]);
    const ok = await runBrowseAgent(GOAL, {
      model: scripted([verdict("pass"), { text: "fin" }]),
      browser: browser(),
      qa: { judge: { model: judgeModel({ verdict: "pass", reason: "ok" }), context: "x".repeat(QA_JUDGE_CONTEXT_MAX_CHARS) } },
    });
    expect(qaOf(ok).judge).toMatchObject({ verdict: "pass" });
  });
});
