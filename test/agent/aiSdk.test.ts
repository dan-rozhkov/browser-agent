import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { BrowserBridge } from "../../src/loop/bridge.js";
import { runBrowseAgent, screenshotToModelOutput } from "../../src/agent/aiSdk.js";
import { singleUseTool } from "../../src/agent/index.js";

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
