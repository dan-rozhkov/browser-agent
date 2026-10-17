import { MockLanguageModelV3 } from "ai/test";
import type { BrowserBridge } from "../../src/loop/bridge.js";
import type { QaBrowser, QaScenario } from "../../src/qa/types.js";

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 4, text: 4, reasoning: undefined },
};

export type Step = { text?: string; calls?: { name: string; input: unknown }[]; delayMs?: number };

/**
 * A model that plays a script per scenario. The scenario is found by its goal text in
 * the prompt (the goal is the user message). `script(goal, n)` gives step `n`
 * (0-based, n = tool-result messages so far).
 */
export function scriptedModel(script: (goal: string, n: number) => Step, goals: string[]) {
  return new MockLanguageModelV3({
    doGenerate: async (options: { prompt?: unknown }) => {
      const prompt = options.prompt as { role: string }[];
      const text = JSON.stringify(prompt);
      const goal = goals.find((g) => text.includes(g)) ?? "";
      const n = prompt.filter((m) => m.role === "tool").length;
      const step = script(goal, n);
      if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
      const content: unknown[] = [];
      if (step.text) content.push({ type: "text", text: step.text });
      for (const [k, c] of (step.calls ?? []).entries()) {
        content.push({ type: "tool-call", toolCallId: `${goal}-${n}-${k}`, toolName: c.name, input: JSON.stringify(c.input) });
      }
      return {
        finishReason: step.calls?.length ? { unified: "tool-calls" as const, raw: "tool_calls" } : { unified: "stop" as const, raw: "stop" },
        usage,
        warnings: [] as never[],
        content,
      } as never;
    },
  });
}

export const verdictStep = (verdict: "pass" | "fail", reason = "because"): Step => ({ calls: [{ name: "qa_verdict", input: { verdict, reason } }] });

/** read, then the verdict, then a final text. */
export function readThenVerdict(verdict: "pass" | "fail", reason = "because"): (goal: string, n: number) => Step {
  return (_g, n) => (n === 0 ? { calls: [{ name: "browse_read", input: {} }] } : n === 1 ? verdictStep(verdict, reason) : { text: "All checked." });
}

const SNAP = { snapshotId: "s1", url: "https://a.test/", title: "A", elements: [] };

export function fakeBridge(over: Partial<BrowserBridge> = {}): BrowserBridge {
  return {
    open: async () => ({ url: "https://a.test/", title: "A" }),
    act: async () => ({ changed: true }),
    read: async () => ({ text: "page text" }),
    snapshot: async () => SNAP,
    perform: async () => ({}),
    ...over,
  };
}

export const scenario = (id: string, over: Partial<QaScenario> = {}): QaScenario => ({ id, goal: `goal ${id}`, ...over });

/** An `openBrowser` that counts opens and closes, and how many browsers are open at once. */
export function browserFactory(make: (s: QaScenario) => Partial<BrowserBridge> = () => ({}), opts: { closeThrows?: boolean } = {}) {
  const state = { opened: [] as string[], closed: [] as string[], active: 0, peak: 0 };
  const openBrowser = async (s: QaScenario): Promise<QaBrowser> => {
    state.opened.push(s.id);
    state.active++;
    state.peak = Math.max(state.peak, state.active);
    return {
      browser: fakeBridge(make(s)),
      close: async () => {
        state.active--;
        state.closed.push(s.id);
        if (opts.closeThrows) throw new Error("close boom");
      },
    };
  };
  return { state, openBrowser };
}
