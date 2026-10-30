import { describe, expect, it, vi } from "vitest";
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

  it("captureAfter decides which calls get a frame; a failed call gets one too", async () => {
    let n = 0;
    const r = make({ capture: async () => (n++, { imageData: IMG }) });
    await r.onToolCall({ toolName: "browse_open", input: {} })({ output: '{"url":"u"}' });
    await r.onToolCall({ toolName: "browse_tabs", input: { action: "switch" } })({ output: "{}" });
    await r.onToolCall({ toolName: "browse_act", input: {} })({ output: '{"error":"no such element"}' });
    await r.onToolCall({ toolName: "browse_act", input: {} })({ error: new Error("boom") });
    // The second failure in a row gets no frame.
    expect(n).toBe(3);
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

  it("default captureAfter: act except wait, tabs only for switch/close/new, open; a failed call too", async () => {
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

  it("default captureAfter: failed open, act, tabs switch get a frame; a failed lone wait and tabs list do not", async () => {
    const taken: string[] = [];
    const r = make({ capture: async () => (taken.push("x"), { imageData: IMG }) });
    const ok = () => r.onToolCall({ toolName: "browse_read", input: {} })({ output: "{}" });
    const fail = async (tool: string, input: unknown) => { const n = taken.length; await r.onToolCall({ toolName: tool, input })({ output: '{"error":"nope"}' }); const got = taken.length > n; await ok(); return got; };
    expect(await fail("browse_open", { url: "u" })).toBe(true);
    expect(await fail("browse_act", { action: "click", target: "a" })).toBe(true);
    expect(await fail("browse_act", { action: "wait" })).toBe(false);
    expect(await fail("browse_tabs", { action: "switch", tabId: 3 })).toBe(true);
    expect(await fail("browse_tabs", { action: "list" })).toBe(false);
    expect(await fail("browse_read", {})).toBe(false);
  });

  it("consecutive failures get one frame; a success or an unframed step resets it; validation refusals get none", async () => {
    const taken: string[] = [];
    const r = make({ capture: async () => (taken.push("x"), { imageData: IMG }) });
    const run = async (tool: string, input: unknown, output: unknown) => { const n = taken.length; await r.onToolCall({ toolName: tool, input })({ output: JSON.stringify(output) }); return taken.length > n; };
    expect(await run("browse_act", { action: "click" }, { error: "no element" })).toBe(true);
    expect(await run("browse_act", { action: "click" }, { error: "no element" })).toBe(false);
    expect(await run("browse_act", { action: "click" }, { ok: true })).toBe(true);
    expect(await run("browse_act", { action: "click" }, { error: "no element" })).toBe(true);
    for (const error of ['browse_act: "actions" accepts at most 10 entries.', 'browse_act: "actions" must contain at least 1 entry.', 'browse_act: action "type" requires a non-empty "text" field.', "browse_act: actions[2] must be an object.", "Unknown browse tool: x."]) {
      expect(await run("browse_act", { action: "click" }, { ok: true })).toBe(true);
      expect(await run("browse_act", { action: "type" }, { error })).toBe(false);
    }
    // A custom captureAfter decides alone.
    const custom: string[] = [];
    const r2 = make({ capture: async () => (custom.push("x"), { imageData: IMG }), captureAfter: () => true });
    await r2.onToolCall({ toolName: "browse_act", input: {} })({ output: '{"error":"a"}' });
    await r2.onToolCall({ toolName: "browse_act", input: {} })({ output: '{"error":"a"}' });
    expect(custom).toHaveLength(2);
  });

  it("a failed step that typed a secret still gets no frame; one timeout still disables captures", async () => {
    let n = 0;
    const r = make({ capture: () => (n++, new Promise(() => {})), captureTimeoutMs: 5 });
    await r.onToolCall({ toolName: "browse_act", input: { action: "type", target: "Password", text: "p" } })({ output: '{"error":"x"}' });
    expect(n).toBe(0);
    await r.onToolCall({ toolName: "browse_open", input: { url: "u" } })({ output: '{"error":"x"}' });
    await r.onToolCall({ toolName: "browse_open", input: { url: "u" } })({ output: '{"error":"x"}' });
    expect(n).toBe(1);
  });

  it("a batched browse_act records one entry per action that ran, with the failing one", async () => {
    const r = make();
    const input = { actions: [{ action: "click", target: "a" }, { action: "type", target: "Password", text: "p" }, { target: "b" }, { action: "press", key: "Enter" }] };
    await r.onToolCall({ toolName: "browse_act", input })({ output: JSON.stringify({ results: [{ ok: true }, { ok: true }, { error: "not found" }], completed: 2, stoppedAt: 2, error: "not found" }) });
    await r.onToolCall({ toolName: "browse_act", input: { actions: [{ action: "click" }, { action: "wait" }] } })({ output: JSON.stringify({ results: [{}, {}], completed: 2 }) });
    await r.onToolCall({ toolName: "browse_act", input })({ output: JSON.stringify({ error: 'browse_act: "actions" accepts at most 10 entries.' }) });
    await r.onToolCall({ toolName: "browse_act", input })({ error: new Error("boom") });
    await r.onToolCall({ toolName: "browse_act", input: { action: "click" } })({ output: "{}" });
    await r.onToolCall({ toolName: "browse_act", input: { actions: [{ action: "click" }, { action: "click" }] } })({ output: JSON.stringify({ results: [{}], completed: 0, stoppedAt: 0, error: "batch deadline reached." }) });
    const t = r.finish({ status: "done" });
    expect(t.steps[0]!.ok).toBe(false);
    expect(t.steps[0]!.actions).toEqual([{ action: "click", ok: true }, { action: "type", ok: true }, { action: "act", ok: false, error: "not found" }]);
    expect(t.steps[1]!.actions).toEqual([{ action: "click", ok: true }, { action: "wait", ok: true }]);
    expect(t.steps[2]!.actions).toBeUndefined();
    expect(t.steps[3]!.actions).toBeUndefined();
    expect(t.steps[4]!.actions).toBeUndefined();
    expect(t.steps[5]!.actions).toEqual([{ action: "click", ok: false, error: "batch deadline reached." }]);
    expect(parseBrowseTrace(JSON.parse(JSON.stringify(t)))).toEqual({ trace: t });
  });

  it("a validation error in the middle of a batch (after actions ran) still gets its failure frame", async () => {
    const taken: string[] = [];
    const r = make({ capture: async () => (taken.push("x"), { imageData: IMG }) });
    const run = async (output: unknown) => { const n = taken.length; await r.onToolCall({ toolName: "browse_act", input: { actions: [{}, {}] } })({ output: JSON.stringify(output) }); const got = taken.length > n; await r.onToolCall({ toolName: "browse_read", input: {} })({ output: "{}" }); return got; };
    const error = "browse_act: actions[1] must be an object.";
    expect(await run({ results: [{ ok: true }, { error }], completed: 1, stoppedAt: 1, error })).toBe(true);
    expect(await run({ results: [{ error }], completed: 0, stoppedAt: 0, error })).toBe(false);
    expect(await run({ error: 'browse_act: "actions" accepts at most 10 entries.' })).toBe(false);
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
    expect(t.steps.map((s) => (s.args as any).text ?? (s.args as any).actions?.[0].text)).toEqual([undefined, "[redacted]", "shoes", "[redacted]", undefined, "[redacted]", undefined, "[redacted]"]);
    // A blind type is always redacted (a Tab may have moved the focus to a password field), even after a named non-secret target.
    // Frames: click Password, search type, click Card, click index. Not the four secret types.
    expect(t.frames.map((f) => f.stepIndex)).toEqual([0, 2, 4, 6]);
  });

  it("coordinates: x and y stay in the args; text typed at a point or into the unknown focus is redacted", async () => {
    const r = make();
    await r.onToolCall({ toolName: "browse_act", input: { action: "click", x: 120, y: 80, button: "right", clicks: 2 } })({ output: "{}" });
    await r.onToolCall({ toolName: "browse_act", input: { action: "type", text: "hunter2", x: 30, y: 40 } })({ output: "{}" });
    // The run starts with a blind type: nothing named the focused field, so it may be a password.
    await r.onToolCall({ toolName: "browse_act", input: { action: "type", text: "blind" } })({ output: "{}" });
    await r.onToolCall({ toolName: "browse_act", input: { actions: [{ action: "click", x: 1, y: 2 }, { action: "type", text: "batch" }] } })({ output: "{}" });
    // Even after a click on a named, non-secret field, a blind type stays redacted.
    await r.onToolCall({ toolName: "browse_act", input: { action: "click", target: "Search" } })({ output: "{}" });
    await r.onToolCall({ toolName: "browse_act", input: { action: "type", text: "shoes" } })({ output: "{}" });
    const t = r.finish({ status: "done" });
    const args = t.steps.map((s) => s.args as any);
    expect(args[0]).toEqual({ action: "click", x: 120, y: 80, button: "right", clicks: 2 });
    expect(args[1]).toEqual({ action: "type", text: "[redacted]", x: 30, y: 40 });
    expect(args[2].text).toBe("[redacted]");
    expect(args[3].actions[0]).toEqual({ action: "click", x: 1, y: 2 });
    expect(args[3].actions[1].text).toBe("[redacted]");
    expect(args[5].text).toBe("[redacted]");
  });

  it("a blind type after click Email, press Tab is redacted (the Tab moved the focus to the password field)", async () => {
    const r = make();
    await r.onToolCall({ toolName: "browse_act", input: { action: "click", target: "Email" } })({ output: "{}" });
    await r.onToolCall({ toolName: "browse_act", input: { action: "type", target: "Email", text: "a@b.c" } })({ output: "{}" });
    await r.onToolCall({ toolName: "browse_act", input: { action: "press", key: "Tab" } })({ output: "{}" });
    await r.onToolCall({ toolName: "browse_act", input: { action: "type", text: "hunter2" } })({ output: "{}" });
    const t = r.finish({ status: "done" });
    const args = t.steps.map((s) => s.args as any);
    expect(args[1].text).toBe("a@b.c");
    expect(args[3].text).toBe("[redacted]");
    expect(JSON.stringify(t)).not.toContain("hunter2");
  });

  it("coordinates: a repro of click and type at a point does not throw and holds no text", async () => {
    const r = make({ repro: true } as Partial<BrowseTraceRecorderOptions>);
    const out = JSON.stringify({ changed: true, __repro: { gap: "not-found" } });
    await r.onToolCall({ toolName: "browse_act", input: { action: "click", x: 5, y: 6 } })({ output: out });
    await r.onToolCall({ toolName: "browse_act", input: { action: "type", text: "hunter2", x: 5, y: 6 } })({ output: out });
    await r.onToolCall({ toolName: "browse_act", input: { actions: [{ action: "click", x: 1, y: 2 }, { action: "type", text: "x", x: 1, y: 2 }] } })({
      output: JSON.stringify({ results: [{}, {}], completed: 2 }),
    });
    const t = r.finish({ status: "done" });
    expect(JSON.stringify(t)).not.toContain("hunter2");
    expect(t.steps).toHaveLength(3);
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

  describe("the trace carries no QA step args", () => {
    const step = (index: number, args: unknown) => ({ index, tool: "browse_act", args, ok: true, error: undefined as string | undefined });
    const qaOf = (steps: QaResult["steps"]): QaResult => ({ outcome: "passed", steps, stepsDropped: 2 });

    it("stateful click-then-type, #password, a raw string, more than 30 steps, a host-built qa: no secret; the host qa is unchanged", async () => {
      const r = make();
      await r.onToolCall({ toolName: "browse_act", input: { action: "click", target: "Password" } })({ output: "{}" });
      await r.onToolCall({ toolName: "browse_act", input: { action: "type", text: "hunter2" } })({ output: "{}" });
      const many = Array.from({ length: 35 }, (_, i) => step(i + 3, { action: "type", text: "hunter2" }));
      const qa = qaOf([
        step(1, { action: "click", target: "Password" }),
        step(2, { action: "type", text: "hunter2" }),
        step(3, { action: "type", target: "#password", text: "hunter2" }),
        step(4, '{"action":"type","text":"hunter2"}'),
        ...many,
      ]);
      const before = JSON.stringify(qa);
      const t = r.finish({ status: "done", qa });
      expect(JSON.stringify(t)).not.toContain("hunter2");
      expect(t.qa!.steps).toHaveLength(qa.steps.length);
      expect(t.qa!.steps[0]).toMatchObject({ index: 1, tool: "browse_act", ok: true, args: "[omitted]" });
      expect(t.qa!.stepsDropped).toBe(2);
      expect(JSON.stringify(qa)).toBe(before);
      expect(parseBrowseTrace(JSON.parse(JSON.stringify(t)))).toEqual({ trace: t });
    });

    it("keeps error and ms of a step", () => {
      const t = make().finish({ status: "done", qa: qaOf([{ index: 1, tool: "browse_read", args: {}, ok: false, error: "boom", ms: 5 } as never]) });
      expect(t.qa!.steps[0]).toEqual({ index: 1, tool: "browse_read", args: "[omitted]", ok: false, error: "boom", ms: 5 });
    });
  });

  describe("requests", () => {
    const req = (at: number, extra: Record<string, unknown> = {}) => ({ at, method: "GET", url: `https://a.test/${at}`, ...extra });

    it("has no requests field without the option", () => {
      expect(make().finish({ status: "done" }).requests).toBeUndefined();
    });

    it("drains at the end of each step, redacts, and assigns stepIndex by time, else the finishing step", async () => {
      // clock: start 1010, each now() call +10.
      const batches: unknown[] = [
        JSON.stringify({ requests: [req(1025, { url: "https://a.test/x?token=s", requestHeaders: { Cookie: "c" } })], dropped: 1 }),
        { requests: [req(1, { stepIndex: 99 }), { bad: true }] },
      ];
      const r = make({ requests: async () => batches.shift() });
      await r.onToolCall({ toolName: "browse_open", input: {} })({ output: "{}" });
      await r.onToolCall({ toolName: "browse_read", input: {} })({ output: "{}" });
      await r.flush();
      const t = r.finish({ status: "done" });
      expect(t.requests).toHaveLength(2);
      expect(t.requests![0]).toMatchObject({ stepIndex: 0, url: "https://a.test/x?token=[redacted]", requestHeaders: { Cookie: "[redacted]" } });
      // at=1 lies in no step: the finishing step (1).
      expect(t.requests![1]).toMatchObject({ at: 1, stepIndex: 1 });
      expect(t.dropped).toEqual({ requests: 1 });
      expect(parseBrowseTrace(JSON.parse(JSON.stringify(t)))).toEqual({ trace: t });
    });

    it("drains before the step frame is taken", async () => {
      const order: string[] = [];
      const r = make({ requests: async () => (order.push("requests"), []), capture: async () => (order.push("capture"), { imageData: IMG }) });
      await r.onToolCall({ toolName: "browse_open", input: {} })({ output: "{}" });
      await r.flush();
      expect(order.slice(0, 2)).toEqual(["capture", "requests"]);
    });

    it("the step does not wait for a slow drain, and drains never overlap, in step order", async () => {
      let running = 0;
      let maxRunning = 0;
      const seen: number[] = [];
      let n = 0;
      const r = make({ requests: async () => { const i = n++; running++; maxRunning = Math.max(maxRunning, running); await new Promise((res) => setTimeout(res, 20)); running--; seen.push(i); return []; } });
      const t0 = Date.now();
      for (let i = 0; i < 3; i++) await r.onToolCall({ toolName: "browse_read", input: {} })({ output: "{}" });
      expect(Date.now() - t0).toBeLessThan(40);
      await r.flush();
      expect(maxRunning).toBe(1);
      expect(seen).toEqual([0, 1, 2, 3]);
    });

    it("caps with maxRequests and counts the overflow", async () => {
      let n = 0;
      const r = make({ maxRequests: 2, requests: async () => ({ requests: n++ === 0 ? [req(1), req(2), req(3)] : [] }) });
      await r.onToolCall({ toolName: "browse_read", input: {} })({ output: "{}" });
      await r.flush();
      const t = r.finish({ status: "done" });
      expect(t.requests).toHaveLength(2);
      expect(t.dropped).toEqual({ requests: 1 });
    });

    it("flush drains once more; entries outside every step get no stepIndex", async () => {
      let calls = 0;
      const r = make({ requests: async () => (calls++ === 0 ? [] : [req(1), req(1025)]) });
      await r.onToolCall({ toolName: "browse_read", input: {} })({ output: "{}" });
      await r.flush();
      const t = r.finish({ status: "done" });
      expect(t.requests!.map((e) => e.stepIndex)).toEqual([undefined, 0]);
    });

    it("stops calling after one timeout, and is not called when the signal is aborted", async () => {
      let calls = 0;
      const hung = make({ requests: () => (calls++, new Promise(() => {})) });
      vi.useFakeTimers();
      try {
        await hung.onToolCall({ toolName: "browse_read", input: {} })({ output: "{}" });
        const f = hung.flush();
        await vi.advanceTimersByTimeAsync(5100);
        await f;
        await hung.onToolCall({ toolName: "browse_read", input: {} })({ output: "{}" });
        await hung.flush();
      } finally {
        vi.useRealTimers();
      }
      expect(calls).toBe(1);
      expect(hung.finish({ status: "done" }).requests).toEqual([]);
      // An aborted run schedules no drain at a step end, but flush still drains once.
      let called = 0;
      const ac = new AbortController();
      ac.abort();
      const r = make({ requests: async () => (called++, [{ at: 1, method: "GET", url: "https://a.test/last" }]) });
      await r.onToolCall({ toolName: "browse_read", input: {} }, { signal: ac.signal })({ output: "{}" });
      expect(called).toBe(0);
      await r.flush(ac.signal);
      expect(called).toBe(1);
      expect(r.finish({ status: "aborted" }).requests).toHaveLength(1);
    });

    it("a drain already queued still runs after an abort", async () => {
      const ac = new AbortController();
      let release!: () => void;
      let called = 0;
      const r = make({ requests: async () => { called++; if (called === 1) await new Promise<void>((res) => { release = res; }); return []; } });
      await r.onToolCall({ toolName: "browse_read", input: {} }, { signal: ac.signal })({ output: "{}" });
      await r.onToolCall({ toolName: "browse_read", input: {} }, { signal: ac.signal })({ output: "{}" });
      ac.abort();
      await new Promise((res) => setTimeout(res, 5));
      release();
      await r.flush(ac.signal);
      expect(called).toBe(3);
    });

    it("the flush drain has its own 2 s time box", async () => {
      vi.useFakeTimers();
      try {
        const r = make({ requests: () => new Promise(() => {}) });
        const f = r.flush();
        await vi.advanceTimersByTimeAsync(2100);
        await f;
        expect(r.finish({ status: "done" }).requests).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a throwing or malformed source never reaches the host", async () => {
      for (const src of [async () => { throw new Error("x"); }, async () => "not json", async () => 5]) {
        const r = make({ requests: src });
        await r.onToolCall({ toolName: "browse_read", input: {} })({ output: "{}" });
        await r.flush();
        expect(r.finish({ status: "done" }).requests).toEqual([]);
      }
    });
  });
});
