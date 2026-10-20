import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { BrowserBridge } from "../../src/loop/bridge.js";
import { runBrowseAgent, screenshotToModelOutput } from "../../src/agent/aiSdk.js";
import { singleUseTool } from "../../src/agent/index.js";
import type { BrowseTrace } from "../../src/shared/trace.js";

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 4, text: 4, reasoning: undefined },
};

type Step = { text?: string; calls?: { name: string; input: unknown }[] };

/** A model that plays the given steps in order, and records every prompt it got. */
function scripted(steps: Step[], seen: { prompts: unknown[]; tools: unknown[]; system: unknown[]; providerOptions: unknown[] } = { prompts: [], tools: [], system: [], providerOptions: [] }) {
  let i = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (options: { prompt?: unknown; tools?: unknown; providerOptions?: unknown }) => {
      seen.prompts.push(options.prompt);
      seen.tools.push(options.tools);
      seen.providerOptions.push(options.providerOptions);
      const step = steps[Math.min(i, steps.length - 1)];
      i += 1;
      const content: unknown[] = [];
      if (step.text) content.push({ type: "text", text: step.text });
      for (const [k, c] of (step.calls ?? []).entries()) {
        content.push({ type: "tool-call", toolCallId: `c${i}-${k}`, toolName: c.name, input: JSON.stringify(c.input) });
      }
      return {
        finishReason: step.calls?.length ? { unified: "tool-calls" as const, raw: "tool_calls" } : { unified: "stop" as const, raw: "stop" },
        usage,
        warnings: [] as never[],
        content,
      } as never;
    },
  });
  return { model, seen };
}

const SNAP = { snapshotId: "s1", url: "https://a.test/", title: "A", elements: [], scroll: { y: 0, height: 1, atBottom: true } };

function fakeBrowser(log: string[] = []): BrowserBridge {
  return {
    open: async (a) => { log.push(`open ${a.url}`); return { url: a.url, title: "A" }; },
    act: async (a) => { log.push(`act ${JSON.stringify(a)}`); return { changed: true }; },
    read: async () => { log.push("read"); return { text: "Price 5" }; },
    snapshot: async () => SNAP,
    perform: async () => ({}),
    screenshot: async () => ({ imageData: "data:image/jpeg;base64,QUJD", width: 1, height: 1 }),
  };
}

describe("runBrowseAgent", () => {
  it("runs tools through the bridge, then returns the final answer", async () => {
    const log: string[] = [];
    const { model } = scripted([
      { text: "looking", calls: [{ name: "browse_read", input: {} }] },
      { text: "The price is 5." },
    ]);
    const r = await runBrowseAgent("find the price", { model, browser: fakeBrowser(log) });
    expect(log).toEqual(["read"]);
    expect(JSON.stringify(r)).toBe('{"status":"done","answer":"The price is 5.","steps":1}');
  });

  it("opens the start page first and tells the model", async () => {
    const log: string[] = [];
    const { model, seen } = scripted([{ text: "ok" }]);
    const r = await runBrowseAgent("goal", { model, browser: fakeBrowser(log), url: "https://a.test/" });
    expect(log).toEqual(["open https://a.test/"]);
    expect(r.steps).toBe(1);
    expect(JSON.stringify(seen.prompts[0])).toContain("The browser already opened https://a.test/ for you (browse_open).");
  });

  it("sends the built prompt, the seven tools and the provider options", async () => {
    const { model, seen } = scripted([{ text: "ok" }]);
    await runBrowseAgent("goal", {
      model,
      browser: fakeBrowser(),
      prompt: { principal: "Acme" },
      providerOptions: { openrouter: { reasoning: { effort: "none" } } },
    });
    const prompt = seen.prompts[0] as { role: string; content: unknown }[];
    expect(prompt[0].role).toBe("system");
    expect(String(prompt[0].content)).toContain("working for Acme.");
    expect((seen.tools[0] as { name: string }[]).map((t) => t.name)).toEqual([
      "browse_open", "browse_snapshot", "browse_screenshot", "browse_act", "browse_tabs", "browse_find_images", "browse_read",
    ]);
    expect(seen.providerOptions[0]).toEqual({ openrouter: { reasoning: { effort: "none" } } });
  });

  it("leaves out browse_screenshot when screenshots is false", async () => {
    const { model, seen } = scripted([{ text: "ok" }]);
    await runBrowseAgent("goal", { model, browser: fakeBrowser(), screenshots: false });
    expect((seen.tools[0] as { name: string }[]).map((t) => t.name)).not.toContain("browse_screenshot");
  });

  it("request cap gives step_limit", async () => {
    const { model } = scripted([{ calls: [{ name: "browse_read", input: {} }] }]);
    const r = await runBrowseAgent("goal", { model, browser: fakeBrowser(), maxRequests: 3 });
    expect(r.status).toBe("step_limit");
    expect(r.steps).toBe(3);
  });

  it("deadline gives timeout", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async (options: { abortSignal?: AbortSignal }) =>
        new Promise((_res, rej) => options.abortSignal?.addEventListener("abort", () => rej(new Error("aborted")))) as never,
    });
    const r = await runBrowseAgent("goal", { model, browser: fakeBrowser(), deadlineMs: 30 });
    expect(r.status).toBe("timeout");
  });

  it("an abort signal gives aborted", async () => {
    const ctl = new AbortController();
    const model = new MockLanguageModelV3({
      doGenerate: async (options: { abortSignal?: AbortSignal }) =>
        new Promise((_res, rej) => options.abortSignal?.addEventListener("abort", () => rej(new Error("aborted")))) as never,
    });
    const run = runBrowseAgent("goal", { model, browser: fakeBrowser(), signal: ctl.signal });
    setTimeout(() => ctl.abort(), 20);
    expect((await run).status).toBe("aborted");
  });

  it("a model error gives error", async () => {
    const model = new MockLanguageModelV3({ doGenerate: async () => { throw new Error("rate limited"); } });
    const r = await runBrowseAgent("goal", { model, browser: fakeBrowser() });
    expect(r).toMatchObject({ status: "error", error: "rate limited" });
  });

  it("an unknown tool call does not stop the run", async () => {
    const { model } = scripted([{ calls: [{ name: "get_screenshot", input: {} }] }, { text: "recovered" }]);
    const r = await runBrowseAgent("goal", { model, browser: fakeBrowser() });
    expect(r).toMatchObject({ status: "done", answer: "recovered" });
  });

  it("runs a host tool once and adds its field to the result", async () => {
    const extra = {
      description: "Copy the page.",
      inputSchema: z.object({}),
      execute: async () => JSON.stringify({ nodeId: "n1" }),
      ...singleUseTool({
        name: "browse_capture",
        isSuccess: (p) => typeof p.nodeId === "string",
        fields: (p) => ({ captured: { nodeId: p.nodeId } }),
      }),
    };
    const { model } = scripted([
      { calls: [{ name: "browse_capture", input: {} }] },
      { calls: [{ name: "browse_capture", input: {} }] },
      { text: "copied" },
    ]);
    const r = await runBrowseAgent("goal", { model, browser: fakeBrowser(), extraTools: { browse_capture: extra } });
    expect(JSON.stringify(r)).toBe('{"status":"done","answer":"copied","steps":1,"captured":{"nodeId":"n1"}}');
  });
});

describe("screenshotToModelOutput", () => {
  const raw = JSON.stringify({ url: "u", imageData: "data:image/jpeg;base64,QUJD" });

  it("default: text only, no base64, says the image is not attached", () => {
    const out = screenshotToModelOutput(raw);
    expect(out.type).toBe("text");
    const text = (out as { value: string }).value;
    expect(text).not.toContain("QUJD");
    expect(text).not.toContain("imageData");
    expect(JSON.parse(text)).toMatchObject({ url: "u", imageNote: expect.stringContaining("not attached") });
  });

  it("attachImage: splits the picture from the rest", () => {
    expect(screenshotToModelOutput(raw, { attachImage: true })).toEqual({
      type: "content",
      value: [{ type: "text", text: '{"url":"u"}' }, { type: "image-data", data: "QUJD", mediaType: "image/jpeg" }],
    });
  });

  it("strips an imageData that is not a data URL, even with attachImage", () => {
    const out = screenshotToModelOutput(JSON.stringify({ imageData: "http://x/y.png" }), { attachImage: true });
    expect(out.type).toBe("text");
    expect((out as { value: string }).value).not.toContain("http://x/y.png");
  });

  it("keeps an error result as text", () => {
    expect(screenshotToModelOutput('{"error":"x"}')).toEqual({ type: "text", value: '{"error":"x"}' });
  });
});

describe("screenshot in the tool loop", () => {
  const shotStep = [{ calls: [{ name: "browse_screenshot", input: {} }] }, { text: "seen" }];
  const lastPrompt = (seen: { prompts: unknown[] }) => JSON.stringify(seen.prompts[seen.prompts.length - 1]);

  it("by default no base64 and no image part reach the next request", async () => {
    const { model, seen } = scripted(shotStep);
    await runBrowseAgent("goal", { model, browser: fakeBrowser() });
    const p = lastPrompt(seen);
    expect(p).not.toContain("QUJD");
    expect(p).toContain("not attached");
  });

  it("toolResultImages: true gives the next request an image part", async () => {
    const { model, seen } = scripted(shotStep);
    await runBrowseAgent("goal", { model, browser: fakeBrowser(), toolResultImages: true });
    expect(lastPrompt(seen)).toContain("QUJD");
  });

  it("reusing one singleUseTool across two runs works", async () => {
    const extra = {
      description: "Copy the page.",
      inputSchema: z.object({}),
      execute: async () => JSON.stringify({ nodeId: "n1" }),
      ...singleUseTool({ name: "browse_capture", isSuccess: (p) => typeof p.nodeId === "string", fields: (p) => ({ captured: p.nodeId }) }),
    };
    for (let run = 0; run < 2; run++) {
      const { model } = scripted([{ calls: [{ name: "browse_capture", input: {} }] }, { text: "copied" }]);
      const r = await runBrowseAgent("goal", { model, browser: fakeBrowser(), extraTools: { browse_capture: extra } });
      expect(JSON.stringify(r)).toBe('{"status":"done","answer":"copied","steps":1,"captured":"n1"}');
    }
  });
});

describe("runBrowseAgent: onToolCall", () => {
  it("reports each execution at start and at end, also the pre-open, and ignores throws", async () => {
    const events: string[] = [];
    const { model } = scripted([{ calls: [{ name: "browse_read", input: {} }] }, { text: "done" }]);
    const r = await runBrowseAgent("goal", {
      model,
      browser: fakeBrowser(),
      url: "https://a.test/",
      runId: "run",
      onToolCall(call) {
        events.push(`start ${call.toolName} ${call.toolCallId} ${call.preOpen === true}`);
        return (result) => {
          events.push(`end ${call.toolName} ${typeof result.output}`);
          throw new Error("observer bug");
        };
      },
    });
    expect(r.status).toBe("done");
    expect(events).toEqual(["start browse_open run:open true", "end browse_open string", expect.stringMatching(/^start browse_read .* false$/), "end browse_read string"]);
  });

  it("reports a throw of a host tool and a throwing start hook does not break the run", async () => {
    const ends: unknown[] = [];
    const extra = { description: "x", inputSchema: z.object({}), execute: async () => { throw new Error("tool broke"); } };
    const { model } = scripted([{ calls: [{ name: "host_tool", input: {} }] }, { text: "done" }]);
    let first = true;
    const r = await runBrowseAgent("goal", {
      model,
      browser: fakeBrowser(),
      extraTools: { host_tool: extra },
      onToolCall() {
        if (first) { first = false; throw new Error("start bug"); }
      },
    });
    expect(r.status).toBe("done");
    const { model: m2 } = scripted([{ calls: [{ name: "host_tool", input: {} }] }, { text: "done" }]);
    await runBrowseAgent("goal", { model: m2, browser: fakeBrowser(), extraTools: { host_tool: extra }, onToolCall: () => (res) => { ends.push((res.error as Error).message); } });
    expect(ends).toEqual(["tool broke"]);
  });
});

describe("runBrowseAgent: trace", () => {
  const JPG_BASE64 = "QUJD".repeat(40);
  const ACT = { action: "click", target: "x" };
  const shotBrowser = (log: string[] = []): BrowserBridge => ({
    ...fakeBrowser(),
    open: async (a) => ({ url: a.url, title: "A" }),
    act: async () => ({ changed: true, consoleErrors: ["TypeError: x"] }),
    screenshot: async () => {
      log.push("screenshot");
      return { imageData: `data:image/jpeg;base64,${JPG_BASE64}`, width: 10, height: 20 };
    },
  });
  /** Runs with `trace` and returns the result and the trace that onTrace got. */
  async function traced(steps: Step[], browser: BrowserBridge, extra: Record<string, unknown> = {}, trace: Record<string, unknown> = {}) {
    const got: BrowseTrace[] = [];
    const r = await runBrowseAgent("goal", { model: scripted(steps).model, browser, ...extra, trace: { ...trace, onTrace: (t: BrowseTrace) => { got.push(t); } } });
    expect(got).toHaveLength(1);
    return { r, t: got[0]! };
  }

  it("calls onTrace once with steps and frames; the model-facing JSON is the same as without trace", async () => {
    const steps: Step[] = [{ calls: [{ name: "browse_act", input: ACT }] }, { text: "done" }];
    const plain = await runBrowseAgent("goal", { model: scripted(steps).model, browser: shotBrowser(), url: "https://a.test/" });
    const { r, t } = await traced(steps, shotBrowser(), { url: "https://a.test/" }, { labels: { browser: "test" } });
    expect(JSON.stringify(r)).toBe(JSON.stringify(plain));
    expect("trace" in r).toBe(false);
    expect(JSON.stringify(r)).not.toContain("base64");
    expect(t.format).toBe("sideform.browse-trace");
    expect(t.goal).toBe("goal");
    expect(t.status).toBe("done");
    expect(t.answer).toBe("done");
    expect(t.labels).toEqual({ browser: "test" });
    expect(t.steps.map((s) => s.tool)).toEqual(["browse_open", "browse_act"]);
    expect(t.steps[1]!.args).toEqual(ACT);
    expect(t.frames.map((f) => [f.kind, f.stepIndex, f.width, f.height])).toEqual([["step", 0, 10, 20], ["step", 1, 10, 20]]);
    expect(t.frames[0]!.src).toBe(`data:image/jpeg;base64,${JPG_BASE64}`);
    expect(t.console.map((e) => e.text)).toEqual(["TypeError: x"]);
  });

  it("the trace is not in the prompt the model gets", async () => {
    const { model, seen } = scripted([{ calls: [{ name: "browse_act", input: ACT }] }, { text: "done" }]);
    await runBrowseAgent("goal", { model, browser: shotBrowser(), trace: {} });
    expect(JSON.stringify(seen.prompts)).not.toContain(JPG_BASE64);
  });

  it("an onTrace that throws, rejects or hangs does not break the run", async () => {
    const steps: Step[] = [{ text: "done" }];
    for (const onTrace of [() => { throw new Error("x"); }, async () => { throw new Error("x"); }]) {
      const r = await runBrowseAgent("g", { model: scripted(steps).model, browser: shotBrowser(), trace: { onTrace } });
      expect(r.status).toBe("done");
    }
  });

  it("capture: false and a browser without screenshot give a trace without step frames", async () => {
    const log: string[] = [];
    const steps: Step[] = [{ calls: [{ name: "browse_act", input: ACT }] }, { text: "done" }];
    const off = await traced(steps, shotBrowser(log), {}, { capture: false });
    expect(off.t.steps).toHaveLength(1);
    expect(off.t.frames).toEqual([]);
    expect(log).toEqual([]);
    const none = await traced(steps, { ...shotBrowser(), screenshot: undefined });
    expect(none.t.frames).toEqual([]);
  });

  it("a failing screenshot does not fail the run", async () => {
    const browser: BrowserBridge = { ...shotBrowser(), screenshot: async () => { throw new Error("no gpu"); } };
    const { r, t } = await traced([{ calls: [{ name: "browse_act", input: ACT }] }, { text: "done" }], browser);
    expect(r.status).toBe("done");
    expect(t.frames).toEqual([]);
    expect(t.steps[0]!.ok).toBe(true);
  });

  it("a browse_screenshot call becomes a screenshot frame, also for raw base64; its stored output has no image", async () => {
    const raw: BrowserBridge = { ...shotBrowser(), screenshot: async () => ({ imageData: `/9j/${JPG_BASE64}`, width: 1, height: 1 }) };
    const { t } = await traced([{ calls: [{ name: "browse_screenshot", input: {} }] }, { text: "done" }], raw, {}, { capture: false });
    expect(t.frames.map((f) => [f.kind, f.src.slice(0, 22)])).toEqual([["screenshot", "data:image/jpeg;base64"]]);
    expect(t.steps[0]!.output).not.toContain(JPG_BASE64);
  });

  it("QA: the final screenshot is a final frame and is taken once, shared with onScreenshot", async () => {
    const log: string[] = [];
    const got: unknown[] = [];
    const steps: Step[] = [{ calls: [{ name: "qa_verdict", input: { verdict: "pass", reason: "ok" } }] }];
    const { r, t } = await traced(steps, shotBrowser(log), { qa: { onScreenshot: (img: unknown) => { got.push(img); } } });
    expect(log).toEqual(["screenshot"]);
    expect(got).toHaveLength(1);
    expect(t.frames.at(-1)).toMatchObject({ kind: "final", src: `data:image/jpeg;base64,${JPG_BASE64}` });
    expect(t.qa?.outcome).toBe("passed");
    expect(t.steps.map((s) => s.tool)).toEqual(["qa_verdict"]);
    expect("trace" in r).toBe(false);
    // Without onScreenshot the trace still gets the final frame.
    const log2: string[] = [];
    const r2 = await traced(steps, shotBrowser(log2), { qa: true });
    expect(log2).toEqual(["screenshot"]);
    expect(r2.t.frames.at(-1)!.kind).toBe("final");
  });

  it("without trace there is no screenshot for QA without onScreenshot", async () => {
    const log: string[] = [];
    await runBrowseAgent("g", { model: scripted([{ calls: [{ name: "qa_verdict", input: { verdict: "pass", reason: "ok" } }] }]).model, browser: shotBrowser(log), qa: true });
    expect(log).toEqual([]);
  });

  it("a dialog the trace screenshot drained is still in the output the model gets", async () => {
    const dialog = { type: "alert", message: "Saved!" };
    const browser: BrowserBridge = {
      ...shotBrowser(),
      screenshot: async () => ({ imageData: `data:image/jpeg;base64,${JPG_BASE64}`, dialogs: [dialog] }),
    };
    const steps: Step[] = [{ calls: [{ name: "browse_act", input: ACT }] }, { text: "done" }];
    const withTrace = scripted(steps);
    await runBrowseAgent("goal", { model: withTrace.model, browser, trace: {} });
    // Without tracing the act result carries the dialog itself; with tracing it arrives through the carry.
    const without = scripted(steps);
    await runBrowseAgent("goal", { model: without.model, browser: { ...browser, act: async () => ({ changed: true, consoleErrors: ["TypeError: x"], dialogs: [dialog] }) } });
    const secondPrompt = (m: typeof withTrace) => JSON.stringify(m.seen.prompts[1]);
    expect(secondPrompt(withTrace)).toContain("Saved!");
    expect(secondPrompt(without)).toContain("Saved!");
    expect(secondPrompt(withTrace).split("Saved!")).toHaveLength(2);
    // Same dialog entry, same text; only the position of the key in the result may differ.
    expect(secondPrompt(withTrace)).toContain('\\"dialogs\\":[{\\"type\\":\\"alert\\",\\"message\\":\\"Saved!\\"}]');
  });

  it("no step screenshot after an abort", async () => {
    const ac = new AbortController();
    const log: string[] = [];
    const browser: BrowserBridge = { ...shotBrowser(log), act: async () => { ac.abort(); return { changed: true }; } };
    const { t } = await traced([{ calls: [{ name: "browse_act", input: ACT }] }, { text: "done" }], browser, { signal: ac.signal });
    expect(log).toEqual([]);
    expect(t.status).toBe("aborted");
  });
});
