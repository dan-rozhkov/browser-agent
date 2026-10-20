import { describe, expect, it } from "vitest";
import { createBrowseTraceRecorder, type BrowseTraceRecorderOptions } from "../../src/agent/traceRecorder.js";
import type { QaResult } from "../../src/agent/qaTypes.js";
import { parseBrowseTrace } from "../../src/shared/trace.js";

const IMG = `data:image/jpeg;base64,${"QUJD".repeat(40)}`;

function clock() {
  let t = 1000;
  return () => (t += 10);
}

function make(extra: Partial<BrowseTraceRecorderOptions> = {}) {
  return createBrowseTraceRecorder({ goal: "find it", now: clock(), ...extra });
}

describe("createBrowseTraceRecorder", () => {
  it("records steps with timing and redacted args, and a step frame from capture", async () => {
    let shots = 0;
    const r = make({ id: "run-1", labels: { browser: "desktop" }, capture: async () => ({ imageData: IMG, width: 3, height: 4 }) });
    const end = r.onToolCall({ toolName: "browse_act", input: { text: "hi", password: "secret" } });
    shots += 1;
    await end({ output: '{"changed":true}' });
    const end2 = r.onToolCall({ toolName: "browse_read", input: {} });
    await end2({ output: '{"text":"x"}' });
    const t = r.finish({ status: "done", answer: "ok" });
    expect(t.id).toBe("run-1");
    expect(t.labels).toEqual({ browser: "desktop" });
    expect(t.steps.map((s) => [s.index, s.tool, s.ok])).toEqual([[0, "browse_act", true], [1, "browse_read", true]]);
    expect(t.steps[0]!.args).toEqual({ text: "hi", password: "[redacted]" });
    expect(t.steps[0]!.endedAt).toBeGreaterThan(t.steps[0]!.startedAt);
    // browse_act is captured by default; browse_read is not.
    expect(t.frames).toEqual([{ id: 0, at: expect.any(Number), stepIndex: 0, kind: "step", src: IMG, width: 3, height: 4 }]);
    expect(shots).toBe(1);
    expect(parseBrowseTrace(JSON.parse(JSON.stringify(t)))).toEqual({ trace: t });
  });

  it("makes a random valid id by default, and replaces an invalid one", () => {
    expect(make().id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(make({ id: "bad id!" }).id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(make().id).not.toBe(make().id);
  });

  it("captureAfter decides which calls get a frame; failed calls get none by default", async () => {
    let n = 0;
    const r = make({ capture: async () => (n++, { imageData: IMG }) });
    await r.onToolCall({ toolName: "browse_open", input: {} })({ output: '{"url":"u"}' });
    await r.onToolCall({ toolName: "browse_tabs", input: { action: "switch" } })({ output: "{}" });
    await r.onToolCall({ toolName: "browse_act", input: {} })({ output: '{"error":"no such element"}' });
    await r.onToolCall({ toolName: "browse_act", input: {} })({ error: new Error("boom") });
    expect(n).toBe(2);
    const r2 = make({ capture: async () => ({ imageData: IMG }), captureAfter: (tool) => tool === "browse_read" });
    await r2.onToolCall({ toolName: "browse_read", input: {} })({ output: "{}" });
    expect(r2.finish({ status: "done" }).frames).toHaveLength(1);
  });

  it("a screenshot output becomes a screenshot frame and the stored output has no image", async () => {
    const r = make();
    await r.onToolCall({ toolName: "browse_screenshot", input: {} })({ output: JSON.stringify({ imageData: IMG, width: 5, height: 6, elements: [{ i: 1 }] }) });
    const t = r.finish({ status: "done" });
    expect(t.frames).toEqual([{ id: 0, at: expect.any(Number), stepIndex: 0, kind: "screenshot", src: IMG, width: 5, height: 6 }]);
    const out = t.steps[0]!.output!;
    expect(out).not.toContain("QUJD");
    expect(out).not.toContain("imageData");
    expect(JSON.parse(out).elements).toEqual([{ i: 1 }]);
  });

  it("an output with an error field or a thrown error is a failed step", async () => {
    const r = make();
    await r.onToolCall({ toolName: "browse_act", input: {} })({ output: '{"error":"stale snapshot"}' });
    await r.onToolCall({ toolName: "browse_act", input: {} })({ error: new Error("x".repeat(3000)) });
    const t = r.finish({ status: "error", error: "bad" });
    expect(t.steps[0]).toMatchObject({ ok: false, error: "stale snapshot" });
    expect(t.steps[1]!.ok).toBe(false);
    expect(t.steps[1]!.error).toHaveLength(2000);
    expect(t.error).toBe("bad");
  });

  it("takes console errors and failed requests from outputs, also batch entries and object outputs, with dedupe", async () => {
    const r = make();
    await r.onToolCall({ toolName: "browse_act", input: {} })({ output: JSON.stringify({ consoleErrors: ["e1", "e2"], failedRequests: ["GET 500 https://a.test/x"] }) });
    await r.onToolCall({ toolName: "browse_act", input: {} })({ output: JSON.stringify({ results: [{ consoleErrors: ["e2", "e3"] }, { failedRequests: ["GET 500 https://a.test/x", "POST 404 https://a.test/y"] }] }) });
    await r.onToolCall({ toolName: "qa_assert", input: {} })({ output: { consoleErrors: ["e4"] } });
    const t = r.finish({ status: "done", qa: { outcome: "passed", steps: [], consoleErrors: ["e4", "e5"], failedRequests: ["PUT 1 https://a.test/z"] } satisfies QaResult });
    expect(t.console.map((e) => e.text)).toEqual(["e1", "e2", "e3", "e4", "e5"]);
    expect(t.console[0]!.stepIndex).toBe(0);
    expect(t.console[2]!.stepIndex).toBe(1);
    expect(t.console[4]!.stepIndex).toBeUndefined();
    expect(t.network.map((e) => e.text)).toEqual(["GET 500 https://a.test/x", "POST 404 https://a.test/y", "PUT 1 https://a.test/z"]);
    expect(t.qa?.outcome).toBe("passed");
  });

  it("caps: steps and logs are dropped from the end, frames from the oldest (the first stays), all counted", async () => {
    const r = make({ maxSteps: 2, maxFrames: 3, maxLogEntries: 2, capture: async () => ({ imageData: IMG }) });
    for (let i = 0; i < 5; i++) {
      await r.onToolCall({ toolName: "browse_act", input: { i } })({ output: JSON.stringify({ consoleErrors: [`c${i}`], failedRequests: [`n${i}`] }) });
    }
    const t = r.finish({ status: "done" });
    expect(t.steps.map((s) => s.index)).toEqual([0, 1]);
    expect(t.console.map((e) => e.text)).toEqual(["c0", "c1"]);
    expect(t.network.map((e) => e.text)).toEqual(["n0", "n1"]);
    // Frames: steps 0..4 captured, but the dropped steps' frames carry no stepIndex.
    expect(t.frames).toHaveLength(3);
    expect(t.frames.map((f) => f.id)).toEqual([0, 3, 4]);
    expect(t.frames[0]!.stepIndex).toBe(0);
    expect(t.frames[2]!.stepIndex).toBeUndefined();
    expect(t.dropped).toEqual({ steps: 3, frames: 2, console: 3, network: 3 });
  });

  it("one capture timeout stops all later step captures; skipped captures are counted", async () => {
    let n = 0;
    const r = make({ capture: () => (n++, new Promise<never>(() => undefined)), captureTimeoutMs: 10 });
    for (let i = 0; i < 3; i++) await r.onToolCall({ toolName: "browse_act", input: {} })({ output: "{}" });
    expect(n).toBe(1);
    const t = r.finish({ status: "done" });
    expect(t.frames).toEqual([]);
    expect(t.steps).toHaveLength(3);
    expect(t.dropped).toEqual({ frames: 3 });
  });

  it("takes no capture when the signal is aborted", async () => {
    let n = 0;
    const ac = new AbortController();
    const r = make({ capture: async () => (n++, { imageData: IMG }) });
    await r.onToolCall({ toolName: "browse_act", input: {} }, { signal: ac.signal })({ output: "{}" });
    ac.abort();
    await r.onToolCall({ toolName: "browse_act", input: {} }, { signal: ac.signal })({ output: "{}" });
    expect(n).toBe(1);
  });

  it("calls pending at finish become unfinished steps, in call order, parallel calls included", async () => {
    const r = make({ maxSteps: 3 });
    const e0 = r.onToolCall({ toolName: "a", input: {} });
    const e1 = r.onToolCall({ toolName: "b", input: {} });
    r.onToolCall({ toolName: "c", input: {} });
    r.onToolCall({ toolName: "d", input: {} });
    await e1({ output: "{}" });
    await e0({ output: "{}" });
    const t = r.finish({ status: "timeout" });
    expect(t.steps.map((s) => [s.index, s.tool, s.ok, s.error])).toEqual([[0, "a", true, undefined], [1, "b", true, undefined], [2, "c", false, "unfinished"]]);
    expect(t.steps[2]!.endedAt).toBe(t.endedAt);
    expect(t.dropped).toEqual({ steps: 1 });
  });

  it("raw base64 from a screenshot output becomes a data URL frame", async () => {
    const r = make();
    await r.onToolCall({ toolName: "browse_screenshot", input: {} })({ output: JSON.stringify({ imageData: `iVBOR${"A".repeat(120)}` }) });
    const t = r.finish({ status: "done" });
    expect(t.frames[0]!.src.startsWith("data:image/png;base64,iVBOR")).toBe(true);
    expect(t.steps[0]!.output).not.toContain("iVBOR");
  });

  it("capture dialogs are handed back by the end function, once", async () => {
    const dialogs = [{ type: "alert", message: "hi" }];
    const r = make({ capture: async () => ({ imageData: IMG, dialogs }) });
    expect(await r.onToolCall({ toolName: "browse_act", input: {} })({ output: "{}" })).toEqual({ dialogs });
    expect(await r.onToolCall({ toolName: "browse_read", input: {} })({ output: "{}" })).toEqual({});
  });

  it("default captureAfter: act except wait, tabs only for switch/close/new, open; never a failed call", async () => {
    const taken: string[] = [];
    const r = make({ capture: async () => (taken.push("x"), { imageData: IMG }) });
    const run = async (tool: string, input: unknown) => { const n = taken.length; await r.onToolCall({ toolName: tool, input })({ output: "{}" }); return taken.length > n; };
    expect(await run("browse_act", { action: "click", target: "a" })).toBe(true);
    expect(await run("browse_act", { action: "wait", ms: 10 })).toBe(false);
    expect(await run("browse_act", { actions: [{ action: "wait" }, { action: "click", target: "a" }] })).toBe(true);
    expect(await run("browse_act", { actions: [{ action: "wait" }] })).toBe(false);
    expect(await run("browse_tabs", { action: "list" })).toBe(false);
    expect(await run("browse_tabs", { action: "close", tabId: 1 })).toBe(true);
    expect(await run("browse_open", { url: "u" })).toBe(true);
    expect(await run("browse_read", {})).toBe(false);
  });

  it("a step that typed a secret gets no frame; the redaction remembers a click on a secret field", async () => {
    let n = 0;
    const r = make({ capture: async () => (n++, { imageData: IMG }) });
    await r.onToolCall({ toolName: "browse_act", input: { action: "click", target: "Password" } })({ output: "{}" });
    expect(n).toBe(1);
    await r.onToolCall({ toolName: "browse_act", input: { action: "type", text: "hunter2" } })({ output: "{}" });
    await r.onToolCall({ toolName: "browse_act", input: { action: "type", target: "Search", text: "shoes" } })({ output: "{}" });
    await r.onToolCall({ toolName: "browse_act", input: { action: "type", text: "more shoes" } })({ output: "{}" });
    await r.onToolCall({ toolName: "browse_act", input: { action: "click", target: "Card number" } })({ output: "{}" });
    await r.onToolCall({ toolName: "browse_act", input: { actions: [{ action: "type", text: "4111" }] } })({ output: "{}" });
    await r.onToolCall({ toolName: "browse_act", input: { action: "click", index: 3 } })({ output: "{}" });
    await r.onToolCall({ toolName: "browse_act", input: { action: "type", text: "visible" } })({ output: "{}" });
    const t = r.finish({ status: "done" });
    expect(t.steps.map((s) => (s.args as any).text ?? (s.args as any).actions?.[0].text)).toEqual([undefined, "[redacted]", "shoes", "more shoes", undefined, "[redacted]", undefined, "visible"]);
    // Frames: click Password, search type, type more shoes, click Card, click index, type visible. Not the two secret types.
    expect(t.frames.map((f) => f.stepIndex)).toEqual([0, 2, 3, 4, 6, 7]);
  });

  it("an abort during a capture ends the wait at once and stops the captures", async () => {
    const ac = new AbortController();
    const r = make({ capture: () => new Promise<never>(() => undefined), captureTimeoutMs: 60_000 });
    const p = r.onToolCall({ toolName: "browse_act", input: {} }, { signal: ac.signal })({ output: "{}" });
    setTimeout(() => ac.abort(), 10);
    await expect(p).resolves.toEqual({});
    expect(r.finish({ status: "aborted" }).dropped).toEqual({ frames: 1 });
  });

  it("raw base64 that is not an image, or a short payload, is no frame", () => {
    const r = make();
    r.addFrame({ imageData: "data:image/jpeg;base64,QUJD" });
    r.addFrame({ imageData: "data:image/png;base64,!!!!" });
    expect(r.finish({ status: "done" }).frames).toEqual([]);
  });

  it("logs are a full seen-set: a repeat is not recorded again, controller dropped counts are added", async () => {
    const r = make({ maxLogEntries: 100 });
    for (let i = 0; i < 70; i++) await r.onToolCall({ toolName: "browse_act", input: {} })({ output: JSON.stringify({ consoleErrors: [`e${i}`] }) });
    await r.onToolCall({ toolName: "browse_act", input: {} })({ output: JSON.stringify({ consoleErrors: ["e0", "new"], consoleErrorsDropped: 4 }) });
    const t = r.finish({ status: "done", qa: { outcome: "passed", steps: [], consoleErrors: ["e1", "from-qa"], consoleErrorsDropped: 4 } });
    expect(t.console.map((e) => e.text).filter((x) => x === "e0" || x === "e1")).toHaveLength(2);
    expect(t.console.at(-2)!.text).toBe("new");
    expect(t.console.at(-1)!.text).toBe("from-qa");
    expect(t.console).toHaveLength(72);
    expect(t.dropped).toEqual({ console: 4 });
  });

  it("a capture that throws, rejects or times out gives no frame and no error", async () => {
    const calls: string[] = [];
    for (const [name, capture] of [
      ["throws", () => { throw new Error("x"); }],
      ["rejects", async () => { throw new Error("x"); }],
      ["hangs", () => new Promise<never>(() => undefined)],
      ["empty", async () => undefined],
      ["junk", async () => ({ imageData: "not an image" })],
    ] as const) {
      calls.push(name);
      const r = make({ capture: capture as never, captureTimeoutMs: 20 });
      await expect(r.onToolCall({ toolName: "browse_open", input: {} })({ output: "{}" })).resolves.toEqual({});
      const t = r.finish({ status: "done" });
      expect(t.frames, name).toEqual([]);
      expect(t.steps[0]!.ok, name).toBe(true);
    }
    expect(calls).toHaveLength(5);
  });

  it("a throwing redactArgs or captureAfter never reaches the host", async () => {
    const r = make({ redactArgs: () => { throw new Error("no"); }, captureAfter: () => { throw new Error("no"); }, capture: async () => ({ imageData: IMG }) });
    await expect(r.onToolCall({ toolName: "browse_open", input: {} })({ output: "{}" })).resolves.toEqual({});
    const t = r.finish({ status: "done" });
    expect(t.steps[0]!.args).toBe("[unavailable]");
    expect(t.frames).toEqual([]);
  });

  it("addFrame adds a final frame and ignores non-image data", () => {
    const r = make();
    r.addFrame({ imageData: IMG, kind: "final" });
    r.addFrame({ imageData: "https://x/y.png" });
    r.addFrame({ imageData: "data:text/html;base64,AAAA" });
    const t = r.finish({ status: "done" });
    expect(t.frames).toEqual([{ id: 0, at: expect.any(Number), kind: "final", src: IMG }]);
  });

  it("caps the output, goal, answer and error", async () => {
    const r = make({ goal: "g".repeat(5000) });
    await r.onToolCall({ toolName: "browse_read", input: {} })({ output: "y".repeat(9000) });
    const t = r.finish({ status: "done", answer: "a".repeat(5000), error: "e".repeat(5000) });
    expect(t.goal).toHaveLength(4000);
    expect(t.answer).toHaveLength(4000);
    expect(t.error).toHaveLength(2000);
    expect(t.steps[0]!.output).toHaveLength(4000);
  });

  it("finish is idempotent and later events are ignored", async () => {
    const r = make({ capture: async () => ({ imageData: IMG }) });
    const end = r.onToolCall({ toolName: "browse_open", input: {} });
    const a = r.finish({ status: "done" });
    await end({ output: "{}" });
    r.addFrame({ imageData: IMG });
    const b = r.finish({ status: "error", error: "later" });
    expect(b).toBe(a);
    // The pending call is an unfinished step; its late end changed nothing.
    expect(a.steps.map((x) => [x.tool, x.ok, x.error])).toEqual([["browse_open", false, "unfinished"]]);
    expect(a.frames).toEqual([]);
    expect(a.status).toBe("done");
  });
});
