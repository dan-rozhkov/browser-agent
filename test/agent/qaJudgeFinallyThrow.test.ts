import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import type { BrowserBridge } from "../../src/loop/bridge.js";

// `checkpoint.finish` normally swallows its own failures. This test makes it throw, to pin that a judge request
// that was started is aborted when the `finally` work fails (nobody awaits it then).
vi.mock("../../src/agent/checkpoint.js", () => ({
  createRunCheckpoint: () => ({
    begin: async () => false,
    finish: async () => {
      throw new Error("finish failed");
    },
  }),
}));

const { runBrowseAgent } = await import("../../src/agent/aiSdk.js");

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 4, text: 4, reasoning: undefined },
};

describe("runBrowseAgent: qa.judge when the finally work throws", () => {
  it("aborts the started judge request and rejects with the error", async () => {
    let seen: AbortSignal | undefined;
    const judge = new MockLanguageModelV3({
      doGenerate: (async (options: { abortSignal?: AbortSignal }) => {
        seen = options.abortSignal;
        return new Promise((_resolve, reject) => options.abortSignal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }) as never,
    });
    let i = 0;
    const acting = new MockLanguageModelV3({
      doGenerate: async () => {
        i += 1;
        return {
          finishReason: i === 1 ? { unified: "tool-calls" as const, raw: "tool_calls" } : { unified: "stop" as const, raw: "stop" },
          usage,
          warnings: [] as never[],
          content: i === 1 ? [{ type: "tool-call", toolCallId: "c1", toolName: "qa_verdict", input: JSON.stringify({ verdict: "pass", reason: "r" }) }] : [{ type: "text", text: "fin" }],
        } as never;
      },
    });
    const browser: BrowserBridge = {
      open: async (a) => ({ url: a.url, title: "A" }),
      act: async () => ({}),
      read: async () => ({ text: "t", url: "https://a.test/" }),
      snapshot: async () => ({ snapshotId: "s", url: "https://a.test/", title: "A", elements: [] }),
      perform: async () => ({}),
    };
    await expect(runBrowseAgent("goal", { model: acting, browser, qa: { judge: { model: judge } } })).rejects.toThrow(/finish failed/);
    await new Promise((r) => setTimeout(r, 10));
    expect(seen?.aborted).toBe(true);
  });
});
