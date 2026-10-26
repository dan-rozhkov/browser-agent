import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import type { BrowserBridge } from "../../src/loop/bridge.js";
import { runBrowseAgent } from "../../src/agent/aiSdk.js";
import { createBrowseTraceRecorder, type BrowseTraceRecorderOptions } from "../../src/agent/traceRecorder.js";
import { createTraceDomSource, formatSnapshotForTrace, TRACE_DOM_BUDGET_MS } from "../../src/agent/sessionEntry.js";
import {
  BROWSE_TRACE_ASSET_PATH,
  domTextToDataUrl,
  mapTraceFrames,
  parseBrowseTrace,
  redactCssUrls,
  splitTraceAssets,
  type BrowseTrace,
} from "../../src/shared/trace.js";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

function clock() {
  let t = 1000;
  return () => (t += 10);
}
function make(extra: Partial<BrowseTraceRecorderOptions> = {}) {
  return createBrowseTraceRecorder({ goal: "g", now: clock(), ...extra });
}
const HTML = "<html><body>héllo ✓</body></html>";
const okDom = async () => ({ html: HTML, url: "https://a.test/p?token=abc", title: "T".repeat(400), width: 10, height: 20 });

async function step(r: ReturnType<typeof make>, tool: string, input: unknown, out: { output?: unknown; error?: unknown }, signal?: AbortSignal) {
  await r.onToolCall({ toolName: tool, input }, signal ? { signal } : undefined)(out);
}
const FAIL = { output: '{"error":"element not found"}' };
const ACT = { action: "click", target: "x" };

describe("trace DOM format", () => {
  const base = (): BrowseTrace => ({
    format: "sideform.browse-trace",
    version: 1,
    id: "t1",
    goal: "g",
    startedAt: 1,
    endedAt: 2,
    status: "done",
    steps: [],
    frames: [],
    console: [],
    network: [],
  });

  it("allows dom asset paths", () => {
    expect(BROWSE_TRACE_ASSET_PATH.test("dom/3.html")).toBe(true);
    expect(BROWSE_TRACE_ASSET_PATH.test("dom/3.txt")).toBe(true);
    expect(BROWSE_TRACE_ASSET_PATH.test("dom/3.png")).toBe(false);
    expect(BROWSE_TRACE_ASSET_PATH.test("frames/3.jpg")).toBe(true);
  });

  it("splits html and ax doms into assets, and maps them back", () => {
    const t = base();
    t.doms = [
      { id: 0, at: 1, stepIndex: 0, kind: "html", src: domTextToDataUrl("html", HTML), bytes: 1 },
      { id: 1, at: 1, stepIndex: 0, kind: "ax", src: domTextToDataUrl("ax", "[0] button \"Ok\""), bytes: 1 },
      { id: 2, at: 1, stepIndex: 0, kind: "html", src: "https://cdn.test/x.html", bytes: 1 },
    ];
    const { manifest, assets } = splitTraceAssets(t);
    expect(manifest.doms!.map((d) => d.src)).toEqual(["dom/0.html", "dom/1.txt", "https://cdn.test/x.html"]);
    expect(assets).toEqual([
      { path: "dom/0.html", dataUrl: t.doms[0]!.src, contentType: "text/plain; charset=utf-8" },
      { path: "dom/1.txt", dataUrl: t.doms[1]!.src, contentType: "text/plain; charset=utf-8" },
    ]);
    expect(t.doms[0]!.src).toContain("data:"); // input untouched
    expect(t.doms[0]!.src).toBe(`data:text/html;base64,${b64(HTML)}`);
    const mapped = mapTraceFrames(manifest, (s) => `https://r2.test/${s}`);
    expect(mapped.doms![0]!.src).toBe("https://r2.test/dom/0.html");
    expect(parseBrowseTrace(manifest)).toEqual({ trace: manifest });
  });

  it("splits a data url whatever the case of its prefix and normalises the stored header", () => {
    const t = base();
    t.doms = [
      { id: 0, at: 1, stepIndex: 0, kind: "html", src: `DATA:Text/HTML;BASE64,${b64(HTML)}`, bytes: 1 },
      { id: 1, at: 1, stepIndex: 0, kind: "ax", src: `Data:text/plain;base64,${b64("x")}`, bytes: 1 },
    ];
    const { manifest, assets } = splitTraceAssets(t);
    expect(manifest.doms!.map((d) => d.src)).toEqual(["dom/0.html", "dom/1.txt"]);
    expect(assets.map((a) => a.dataUrl)).toEqual([`data:text/html;base64,${b64(HTML)}`, `data:text/plain;base64,${b64("x")}`]);
    expect(assets.every((a) => a.contentType === "text/plain; charset=utf-8")).toBe(true);
    // parse agrees with split: the same upper-case source is accepted
    expect("trace" in parseBrowseTrace({ ...base(), doms: [t.doms[0]] })).toBe(true);
  });

  it("parse checks the dom id (integer 0..9999, unique) and url (http or https)", () => {
    const dom = { id: 0, at: 1, stepIndex: 0, kind: "html", src: "dom/0.html", bytes: 5 };
    const withDoms = (...d: unknown[]) => ({ ...base(), doms: d });
    expect("trace" in parseBrowseTrace(withDoms({ ...dom, url: "https://a.test/x" }, { ...dom, id: 9999, src: "dom/9999.html", url: "http://a.test/" }))).toBe(true);
    for (const bad of [
      withDoms({ ...dom, id: -1 }),
      withDoms({ ...dom, id: 1.5 }),
      withDoms({ ...dom, id: 10000 }),
      withDoms(dom, { ...dom }),
      withDoms({ ...dom, url: "javascript:alert(1)" }),
      withDoms({ ...dom, url: "file:///etc/passwd" }),
      withDoms({ ...dom, url: "not a url" }),
    ]) {
      expect("error" in parseBrowseTrace(bad)).toBe(true);
    }
  });

  it("a trace without doms is unchanged by split and map", () => {
    const t = base();
    expect(splitTraceAssets(t).manifest).not.toHaveProperty("doms");
    expect(mapTraceFrames(t, (s) => s)).not.toHaveProperty("doms");
    expect(parseBrowseTrace(t)).toEqual({ trace: t });
  });

  it("parse accepts valid and rejects invalid doms", () => {
    const dom = { id: 0, at: 1, stepIndex: 0, kind: "html", src: "dom/0.html", bytes: 5 };
    const withDoms = (d: unknown) => ({ ...base(), doms: [d] });
    expect("trace" in parseBrowseTrace(withDoms(dom))).toBe(true);
    expect("trace" in parseBrowseTrace(withDoms({ ...dom, kind: "ax", src: "dom/0.txt" }))).toBe(true);
    expect("trace" in parseBrowseTrace(withDoms({ ...dom, src: "https://x.test/a.html" }))).toBe(true);
    expect("trace" in parseBrowseTrace(withDoms({ ...dom, src: "http://localhost:5173/a" }))).toBe(true);
    expect("trace" in parseBrowseTrace(withDoms({ ...dom, src: `data:text/html;base64,${b64(HTML)}` }))).toBe(true);
    for (const bad of [
      { ...dom, src: "dom/0.txt" },
      { ...dom, kind: "ax" },
      { ...dom, src: "javascript:alert(1)" },
      { ...dom, src: "http://evil.test/a" },
      { ...dom, src: "data:image/png;base64,AAAA" },
      { ...dom, src: `data:text/plain;base64,${b64("x")}` },
      { ...dom, kind: "svg" },
      { ...dom, bytes: "5" },
    ]) {
      expect("error" in parseBrowseTrace(withDoms(bad))).toBe(true);
    }
    expect("error" in parseBrowseTrace({ ...base(), doms: "x" })).toBe(true);
  });

  it("a frame cannot point at a dom path", () => {
    const t = { ...base(), frames: [{ id: 0, at: 1, kind: "step", src: "dom/0.html" }] };
    expect("error" in parseBrowseTrace(t)).toBe(true);
  });
});

describe("recorder captureDom", () => {
  it("takes one DOM for a failed act, with redacted url, capped title and utf-8 bytes", async () => {
    const r = make({ captureDom: okDom });
    await step(r, "browse_act", ACT, FAIL);
    await r.flush();
    const t = r.finish({ status: "done" });
    expect(t.doms).toHaveLength(1);
    const d = t.doms![0]!;
    expect(d).toMatchObject({ id: 0, stepIndex: 0, kind: "html", width: 10, height: 20, bytes: new TextEncoder().encode(HTML).length });
    expect(d.src).toBe(`data:text/html;base64,${b64(HTML)}`);
    expect(d.url).toBe("https://a.test/p?token=[redacted]");
    expect(d.title).toHaveLength(300);
    expect(parseBrowseTrace(JSON.parse(JSON.stringify(t)))).toEqual({ trace: t });
  });

  const SNAP = '{"snapshotId":"s1","url":"https://a.test/?token=zz","title":"App","elements":[{"index":0,"tag":"button","label":"Go"}]}';

  it("falls back to the latest snapshot of any step output as an ax DOM", async () => {
    const captureDom = vi.fn(async () => undefined);
    const r = make({ captureDom });
    await step(r, "browse_snapshot", {}, { output: SNAP });
    await step(r, "qa_assert", { checks: [] }, { output: '{"ok":true,"passed":false,"results":[]}' }); // read-only: the snapshot is fresh
    await r.flush();
    expect(captureDom).toHaveBeenCalledTimes(1);
    const d = r.finish({ status: "done" }).doms![0]!;
    expect(d.kind).toBe("ax");
    expect(d.sourceStepIndex).toBe(0);
    expect(d.stepIndex).toBe(1);
    expect(d.src).toBe(`data:text/plain;base64,${b64('[0] button "Go"')}`);
    expect(d.url).toBe("https://a.test/?token=[redacted]");
    expect(d.title).toBe("App");
  });

  it("reads the snapshot nested in a browse_act / browse_open output too, and the newest wins", async () => {
    const r = make({ captureDom: async () => undefined });
    await step(r, "browse_open", { url: "https://a.test" }, { output: JSON.stringify({ url: "https://a.test", snapshot: { elements: [{ index: 0, tag: "a", label: "Old" }] } }) });
    await step(r, "browse_act", { action: "click", target: "x" }, { output: JSON.stringify({ changed: true, snapshot: { elements: [{ index: 0, tag: "a", label: "New" }] } }) });
    await step(r, "qa_assert", { checks: [] }, { output: '{"passed":false}' });
    const d = r.finish({ status: "done" }).doms![0]!;
    expect(d.src).toBe(`data:text/plain;base64,${b64('[0] a "New"')}`);
    expect(d.sourceStepIndex).toBe(1);
  });

  it("html wins over the fallback; domFallback:false turns the fallback off and counts the miss", async () => {
    const r = make({ captureDom: okDom });
    await step(r, "browse_snapshot", {}, { output: SNAP });
    await step(r, "browse_act", ACT, FAIL);
    const html = r.finish({ status: "done" }).doms![0]!;
    expect(html.kind).toBe("html");
    expect(html.sourceStepIndex).toBeUndefined();
    const off = make({ captureDom: async () => undefined, domFallback: false });
    await step(off, "browse_snapshot", {}, { output: SNAP });
    await step(off, "qa_assert", { checks: [] }, { output: '{"passed":false}' });
    const t = off.finish({ status: "done" });
    expect(t.doms).toBeUndefined();
    expect(t.dropped).toEqual({ doms: 1 });
  });

  it("never stores a fallback from a step that typed a secret, and has none without a snapshot", async () => {
    const r = make({ captureDom: async () => undefined });
    await step(r, "browse_act", ACT, FAIL); // no snapshot seen yet
    await step(r, "browse_snapshot", {}, { output: SNAP });
    await step(r, "browse_act", { action: "type", target: "Password", text: "hunter2" }, { output: JSON.stringify({ error: "x", snapshot: { elements: [{ index: 0, tag: "a", label: "Z" }] } }) });
    const t = r.finish({ status: "done" });
    expect(t.doms).toBeUndefined();
    expect(t.dropped).toEqual({ doms: 1 });
  });

  it("takes one DOM for a failed qa_assert, none for a passed one", async () => {
    const captureDom = vi.fn(okDom);
    const r = make({ captureDom });
    await step(r, "qa_assert", { checks: [] }, { output: '{"ok":true,"passed":true,"results":[]}' });
    await r.flush();
    expect(captureDom).not.toHaveBeenCalled();
    await step(r, "qa_assert", { checks: [] }, { output: '{"ok":true,"passed":false,"results":[]}' });
    await r.flush();
    expect(captureDom).toHaveBeenCalledTimes(1);
    expect(r.finish({ status: "done" }).doms![0]!.stepIndex).toBe(1);
  });

  it("takes none for a successful step, a lone wait failure, a pre-execution refusal, or a second failure in a row", async () => {
    const captureDom = vi.fn(okDom);
    const r = make({ captureDom, capture: async () => ({ imageData: `data:image/jpeg;base64,${"QUJD".repeat(40)}` }) });
    await step(r, "browse_act", ACT, { output: '{"changed":true}' });
    await step(r, "browse_act", { action: "wait", ms: 10 }, FAIL);
    await step(r, "browse_read", {}, FAIL);
    await step(r, "browse_act", { actions: "bad" }, { output: '{"error":"browse_act: \\"actions\\" must be an array"}' });
    await r.flush();
    expect(captureDom).not.toHaveBeenCalled();
    await step(r, "browse_act", ACT, FAIL);
    await step(r, "browse_act", ACT, FAIL); // second in a row
    await r.flush();
    expect(captureDom).toHaveBeenCalledTimes(1);
  });

  it("takes none for a step with redacted typed text", async () => {
    const captureDom = vi.fn(okDom);
    const r = make({ captureDom });
    await step(r, "browse_act", { action: "type", target: "Password", text: "hunter2" }, FAIL);
    await r.flush();
    expect(captureDom).not.toHaveBeenCalled();
    expect(r.finish({ status: "done" }).doms).toBeUndefined();
  });

  it("caps at maxDoms and counts the rest", async () => {
    const r = make({ captureDom: okDom, maxDoms: 2 });
    for (let i = 0; i < 4; i++) {
      await step(r, "qa_assert", { checks: [] }, { output: '{"passed":false}' });
    }
    await r.flush();
    const t = r.finish({ status: "done" });
    expect(t.doms).toHaveLength(2);
    expect(t.dropped).toEqual({ doms: 2 });
  });

  it("skips a snapshot over maxDomBytes and counts it", async () => {
    const r = make({ captureDom: okDom, maxDomBytes: 10 });
    await step(r, "qa_assert", { checks: [] }, { output: '{"passed":false}' });
    await r.flush();
    const t = r.finish({ status: "done" });
    expect(t.doms).toBeUndefined();
    expect(t.dropped).toEqual({ doms: 1 });
  });

  it("measures bytes in UTF-8, not chars", async () => {
    const r = make({ captureDom: async () => ({ html: "é".repeat(10) }), maxDomBytes: 15 });
    await step(r, "qa_assert", { checks: [] }, { output: '{"passed":false}' });
    await r.flush();
    expect(r.finish({ status: "done" }).dropped).toEqual({ doms: 1 });
  });

  it("a throw or undefined gives no entry and is counted as dropped", async () => {
    let n = 0;
    const r = make({
      captureDom: async () => {
        if (n++ === 0) throw new Error("x");
        return undefined;
      },
    });
    await step(r, "qa_assert", { checks: [] }, { output: '{"passed":false}' });
    await step(r, "qa_assert", { checks: [] }, { output: '{"passed":false}' });
    await r.flush();
    const t = r.finish({ status: "done" });
    expect(n).toBe(2);
    expect(t.doms).toBeUndefined();
    expect(t.dropped).toEqual({ doms: 2 });
  });

  it("one timeout stops html capture for the run, and every wanted DOM that is not stored is counted", async () => {
    vi.useFakeTimers();
    try {
      const captureDom = vi.fn(() => new Promise<never>(() => {}));
      const r = make({ captureDom });
      const first = step(r, "qa_assert", { checks: [] }, { output: '{"passed":false}' });
      await vi.advanceTimersByTimeAsync(5001);
      await first;
      await step(r, "qa_assert", { checks: [] }, { output: '{"passed":false}' });
      expect(captureDom).toHaveBeenCalledTimes(1);
      expect(r.finish({ status: "done" }).dropped?.doms).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the timeout aborts the signal the source got", async () => {
    vi.useFakeTimers();
    try {
      let seen: AbortSignal | undefined;
      const r = make({
        captureDom: (signal) => {
          seen = signal;
          return new Promise<never>(() => {});
        },
      });
      const p = step(r, "qa_assert", { checks: [] }, { output: '{"passed":false}' });
      await vi.advanceTimersByTimeAsync(5001);
      await p;
      expect(seen!.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is taken inline: after the step frame, before the step result returns", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const r = make({
      capture: async () => {
        order.push("frame");
        return { imageData: `data:image/jpeg;base64,${"QUJD".repeat(40)}` };
      },
      captureDom: async () => {
        order.push("dom-start");
        await gate;
        order.push("dom-end");
        return { html: HTML };
      },
    });
    let returned = false;
    const p = step(r, "browse_act", ACT, FAIL).then(() => (returned = true));
    await new Promise((res) => setTimeout(res, 20));
    expect(order).toEqual(["frame", "dom-start"]);
    expect(returned).toBe(false);
    release();
    await p;
    expect(order).toEqual(["frame", "dom-start", "dom-end"]);
    expect(r.finish({ status: "done" }).doms).toHaveLength(1);
  });

  it("flush does not wait for a DOM", async () => {
    const r = make({ captureDom: okDom });
    await step(r, "qa_assert", { checks: [] }, { output: '{"passed":false}' });
    await r.flush();
    expect(r.finish({ status: "done" }).doms).toHaveLength(1);
  });

  it("a step aborted before its end schedules no capture and counts it", async () => {
    const captureDom = vi.fn(okDom);
    const r = make({ captureDom });
    const ac = new AbortController();
    ac.abort();
    await step(r, "qa_assert", { checks: [] }, { output: '{"passed":false}' }, ac.signal);
    await r.flush();
    expect(captureDom).not.toHaveBeenCalled();
    expect(r.finish({ status: "done" }).dropped).toEqual({ doms: 1 });
  });

  it("an abort during the capture ends the wait and aborts the source signal", async () => {
    let seen: AbortSignal | undefined;
    const r = make({
      captureDom: (signal) => {
        seen = signal;
        return new Promise<never>(() => {});
      },
    });
    const ac = new AbortController();
    const p = step(r, "qa_assert", { checks: [] }, { output: '{"passed":false}' }, ac.signal);
    await new Promise((res) => setTimeout(res, 10));
    ac.abort();
    await p;
    expect(seen!.aborted).toBe(true);
    expect(r.finish({ status: "done" }).dropped).toEqual({ doms: 1 });
  });

  it("without captureDom the trace has no doms", async () => {
    const r = make();
    await step(r, "qa_assert", { checks: [] }, { output: '{"passed":false}' });
    expect(r.finish({ status: "done" })).not.toHaveProperty("doms");
  });
});

describe("formatSnapshotForTrace", () => {
  it("formats one line per element and never writes a password value", () => {
    const text = formatSnapshotForTrace({
      elements: [
        { index: 0, tag: "button", role: "button", label: "  Save\n now ", ops: ["CLICK"] },
        { index: 1, tag: "input", label: "Email", value: "a@b.c" },
        { index: 2, tag: "input", label: "Password", value: "hunter2", isPassword: true },
        { index: 3, tag: "input", label: "Nickname", hasValue: true },
        { index: 4, tag: "input", label: "Pw2", value: "zzz", inputType: "password" },
        { index: 5, tag: "input", label: "Agree", checked: true, disabled: true },
      ],
    });
    expect(text.split("\n")).toEqual([
      '[0] button "Save now"',
      '[1] input "Email" value="a@b.c"',
      '[2] input "Password"',
      '[3] input "Nickname" filled',
      '[4] input "Pw2"',
      '[5] input "Agree" disabled checked',
    ]);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("zzz");
  });

  it("omits the value of a field whose label, name or id looks secret", () => {
    const text = formatSnapshotForTrace({
      elements: [
        { index: 0, tag: "input", label: "Verification code", value: "123456" },
        { index: 1, tag: "input", label: "Field", name: "api_key", value: "sk-1" },
        { index: 2, tag: "input", label: "Field", id: "cardNumber", value: "4111", hasValue: true },
        { index: 3, tag: "input", label: "Email", value: "a@b.c" },
      ],
    });
    expect(text).not.toMatch(/123456|sk-1|4111|filled/);
    expect(text).toContain('value="a@b.c"');
  });

  it("returns empty text for a value without elements", () => {
    expect(formatSnapshotForTrace(undefined)).toBe("");
    expect(formatSnapshotForTrace({ error: "x" })).toBe("");
  });
});

describe("runBrowseAgent trace.dom", () => {
  const usage = {
    inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 4, text: 4, reasoning: undefined },
  };
  function scripted(calls: { name: string; input: unknown }[]) {
    let i = 0;
    return new MockLanguageModelV3({
      doGenerate: async () => {
        const first = i++ === 0;
        const content: unknown[] = first
          ? calls.map((c, k) => ({ type: "tool-call", toolCallId: `c${k}`, toolName: c.name, input: JSON.stringify(c.input) }))
          : [{ type: "text", text: "done" }];
        return { finishReason: first ? { unified: "tool-calls", raw: "tool_calls" } : { unified: "stop", raw: "stop" }, usage, warnings: [], content } as never;
      },
    });
  }
  const browser = (extra: Partial<BrowserBridge> = {}): BrowserBridge => ({
    open: async (a) => ({ url: a.url, title: "A" }),
    act: async () => ({ error: "element not found" }),
    read: async () => ({}),
    snapshot: async () => ({ snapshotId: "s1", url: "https://a.test/", title: "A", elements: [{ index: 0, tag: "button", label: "Go" }] }),
    perform: async () => ({}),
    ...extra,
  });
  async function run(b: BrowserBridge, dom = true) {
    const got: BrowseTrace[] = [];
    await runBrowseAgent("goal", { model: scripted([{ name: "browse_act", input: ACT }]), browser: b, trace: { dom, onTrace: (t) => void got.push(t) } });
    return got[0]!;
  }

  /** A model that makes one tool call per turn, then answers. */
  function turns(calls: { name: string; input: unknown }[]) {
    let i = 0;
    return new MockLanguageModelV3({
      doGenerate: async () => {
        const c = calls[i++];
        const content: unknown[] = c ? [{ type: "tool-call", toolCallId: `c${i}`, toolName: c.name, input: JSON.stringify(c.input) }] : [{ type: "text", text: "done" }];
        return { finishReason: c ? { unified: "tool-calls", raw: "tool_calls" } : { unified: "stop", raw: "stop" }, usage, warnings: [], content } as never;
      },
    });
  }
  async function runTurns(b: BrowserBridge, dom = true) {
    const got: BrowseTrace[] = [];
    await runBrowseAgent("goal", {
      model: turns([{ name: "browse_snapshot", input: {} }, { name: "browse_act", input: ACT }]),
      browser: b,
      trace: { dom, onTrace: (t) => void got.push(t) },
    });
    return got[0]!;
  }

  it("uses capture as html, with a 3500 ms budget and forTrace", async () => {
    const capture = vi.fn(async (_a?: unknown) => ({ html: HTML, width: 5, height: 6, url: "https://a.test/", title: "A", forTrace: true }));
    const t = await run(browser({ capture }));
    expect(capture).toHaveBeenCalledWith({ budgetMs: 3500, forTrace: true });
    expect(t.doms).toHaveLength(1);
    expect(t.doms![0]).toMatchObject({ kind: "html", width: 5, height: 6, url: "https://a.test/", title: "A" });
  });

  it("falls back to the latest snapshot the model saw when capture answers an error, with no extra snapshot call", async () => {
    const snapshot = vi.fn(async () => ({ snapshotId: "s1", url: "https://a.test/", title: "A", elements: [{ index: 0, tag: "button", label: "Go" }] }));
    const t = await runTurns(browser({ snapshot, capture: async () => ({ error: "not available for apps" }) }));
    const withDom = snapshot.mock.calls.length;
    snapshot.mockClear();
    await runTurns(browser({ snapshot, capture: async () => ({ error: "x" }) }), false);
    expect(withDom).toBe(snapshot.mock.calls.length); // the executor's own calls only: the recorder adds none
    expect(t.doms).toHaveLength(1);
    expect(t.doms![0]!.kind).toBe("ax");
    expect(t.doms![0]!.src).toBe(`data:text/plain;base64,${b64('[0] button "Go"')}`);
    expect(t.doms![0]!.url).toBe("https://a.test/");
  });

  it("falls back to the snapshot text when capture throws or the bridge has no capture", async () => {
    expect((await runTurns(browser())).doms![0]!.kind).toBe("ax");
    expect((await runTurns(browser({ capture: async () => Promise.reject(new Error("x")) }))).doms![0]!.kind).toBe("ax");
  });

  it("stores nothing when there is neither html nor a snapshot the model saw", async () => {
    const t = await run(browser({ snapshot: async () => ({ error: "no snapshot" }) }));
    expect(t.doms).toBeUndefined();
    expect(t.dropped).toEqual({ doms: 1 });
  });

  it("takes no DOM without trace.dom", async () => {
    const capture = vi.fn(async () => ({ html: HTML, forTrace: true }));
    const t = await run(browser({ capture }), false);
    expect(capture).not.toHaveBeenCalled();
    expect(t.doms).toBeUndefined();
  });
});

describe("recorder: parallel steps", () => {
  const QA_FAIL = { output: '{"ok":true,"passed":false,"results":[]}' };

  it("skips the DOM when another call is still open, and counts it", async () => {
    const captureDom = vi.fn(okDom);
    const r = make({ captureDom });
    const endA = r.onToolCall({ toolName: "qa_assert", input: { checks: [] } });
    const endB = r.onToolCall({ toolName: "browse_act", input: ACT });
    await endA(QA_FAIL);
    expect(captureDom).not.toHaveBeenCalled();
    await endB({ output: '{"changed":true}' });
    const t = r.finish({ status: "done" });
    expect(t.doms).toBeUndefined();
    expect(t.dropped).toEqual({ doms: 1 });
  });

  it("skips the DOM when a step that typed a secret ended after this step started", async () => {
    const captureDom = vi.fn(okDom);
    const r = make({ captureDom });
    const endA = r.onToolCall({ toolName: "qa_assert", input: { checks: [] } });
    const endB = r.onToolCall({ toolName: "browse_act", input: { action: "type", target: "Password", text: "hunter2" } });
    await endB({ output: '{"changed":true}' });
    await endA(QA_FAIL);
    expect(captureDom).not.toHaveBeenCalled();
    expect(r.finish({ status: "done" }).dropped).toEqual({ doms: 1 });
  });

  it("still captures a sequential step after a secret step and after overlapping calls ended", async () => {
    const captureDom = vi.fn(okDom);
    const r = make({ captureDom });
    await step(r, "browse_act", { action: "type", target: "Password", text: "hunter2" }, { output: '{"changed":true}' });
    await step(r, "qa_assert", { checks: [] }, QA_FAIL);
    expect(captureDom).toHaveBeenCalledTimes(1);
    const endA = r.onToolCall({ toolName: "browse_act", input: ACT });
    const endB = r.onToolCall({ toolName: "browse_read", input: {} });
    await endA({ output: '{"changed":true}' });
    await endB({ output: "{}" });
    await step(r, "qa_assert", { checks: [] }, QA_FAIL);
    expect(captureDom).toHaveBeenCalledTimes(2);
  });
});

describe("recorder: ax fallback freshness", () => {
  const SNAP2 = '{"snapshotId":"s1","elements":[{"index":0,"tag":"button","label":"Go"}]}';
  const QA_FAIL = { output: '{"passed":false}' };
  const none = async () => undefined;

  it("uses a snapshot after read-only tools only, and records its source step", async () => {
    const r = make({ captureDom: none });
    await step(r, "browse_snapshot", {}, { output: SNAP2 });
    await step(r, "browse_read", {}, { output: "{}" });
    await step(r, "browse_find_images", {}, { output: "{}" });
    await step(r, "qa_assert", { checks: [] }, QA_FAIL);
    const d = r.finish({ status: "done" }).doms![0]!;
    expect(d).toMatchObject({ kind: "ax", sourceStepIndex: 0, stepIndex: 3 });
  });

  it("a page-changing step since the snapshot makes it stale: no fallback, counted", async () => {
    for (const tool of ["browse_act", "browse_open", "browse_tabs", "browse_fill_login", "some_host_tool"]) {
      const r = make({ captureDom: none });
      await step(r, "browse_snapshot", {}, { output: SNAP2 });
      await step(r, tool, {}, { output: "{}" });
      await step(r, "qa_assert", { checks: [] }, QA_FAIL);
      const t = r.finish({ status: "done" });
      expect(t.doms, tool).toBeUndefined();
      expect(t.dropped, tool).toEqual({ doms: 1 });
    }
  });

  it("a snapshot in the step's own output is fresh even for a page-changing tool", async () => {
    const r = make({ captureDom: none });
    await step(r, "browse_act", ACT, { output: JSON.stringify({ error: "x", snapshot: { elements: [{ index: 0, tag: "a", label: "Own" }] } }) });
    const d = r.finish({ status: "done" }).doms![0]!;
    expect(d).toMatchObject({ kind: "ax", sourceStepIndex: 0, stepIndex: 0 });
  });

  it("parse validates sourceStepIndex as an optional non-negative integer", () => {
    const t = (extra: object) => ({
      format: "sideform.browse-trace", version: 1, id: "t1", goal: "g", startedAt: 1, endedAt: 2, status: "done", steps: [], frames: [], console: [], network: [],
      doms: [{ id: 0, at: 1, stepIndex: 1, kind: "ax", src: "dom/0.txt", bytes: 1, ...extra }],
    });
    expect("trace" in parseBrowseTrace(t({ sourceStepIndex: 0 }))).toBe(true);
    expect("trace" in parseBrowseTrace(t({}))).toBe(true);
    for (const bad of [-1, 1.5, "1", null]) expect("error" in parseBrowseTrace(t({ sourceStepIndex: bad })), String(bad)).toBe(true);
  });
});

describe("redactCssUrls", () => {
  it("removes userinfo and secret params from url() and @import, keeps data: and fragments", () => {
    const css = '.a{background:url(https://u:p@a.test/b.png?token=T1&w=1)} @import "https://a.test/x.css?api_key=T2"; .b{mask:url(#m)} .c{background:url(data:image/png;base64,AAAA)}';
    const out = redactCssUrls(css);
    expect(out).not.toMatch(/T1|T2|u:p@/);
    expect(out).toContain("w=1");
    expect(out).toContain("url(#m)");
    expect(out).toContain("data:image/png;base64,AAAA");
  });
});

describe("createTraceDomSource", () => {
  const ok = { html: HTML, url: "https://a.test/", title: "T", width: 1, height: 2, forTrace: true };
  const sig = () => new AbortController().signal;

  it("exports the budget", () => {
    expect(TRACE_DOM_BUDGET_MS).toBe(3500);
  });

  it("returns the page when the controller confirms the redaction", async () => {
    const capture = vi.fn(async (_a?: unknown) => ok);
    expect(await createTraceDomSource({ capture })(sig())).toEqual({ html: HTML, url: "https://a.test/", title: "T", width: 1, height: 2 });
    expect(capture).toHaveBeenCalledWith({ budgetMs: 3500, forTrace: true });
  });

  it("returns undefined at once for an aborted signal, without calling capture", async () => {
    const capture = vi.fn(async () => ok);
    const c = new AbortController();
    c.abort();
    expect(await createTraceDomSource({ capture })(c.signal)).toBeUndefined();
    expect(capture).not.toHaveBeenCalled();
  });

  it("returns undefined when capture is missing", async () => {
    expect(await createTraceDomSource({})(sig())).toBeUndefined();
  });

  it("an abort during the call resolves undefined at once", async () => {
    const capture = vi.fn(() => new Promise<never>(() => {}));
    const c = new AbortController();
    const p = createTraceDomSource({ capture })(c.signal);
    c.abort();
    expect(await p).toBeUndefined();
  });

  it("returns undefined for a throw, a rejection, an error answer, and an answer without html", async () => {
    expect(await createTraceDomSource({ capture: () => { throw new Error("x"); } })(sig())).toBeUndefined();
    expect(await createTraceDomSource({ capture: async () => Promise.reject(new Error("x")) })(sig())).toBeUndefined();
    expect(await createTraceDomSource({ capture: async () => ({ error: "app", forTrace: true }) })(sig())).toBeUndefined();
    expect(await createTraceDomSource({ capture: async () => ({ forTrace: true }) })(sig())).toBeUndefined();
    expect(await createTraceDomSource({ capture: async () => null })(sig())).toBeUndefined();
  });

  it("old controller (no echo) -> undefined, and capture is not called again", async () => {
    const capture = vi.fn(async (_a?: unknown) => ({ html: HTML }));
    const source = createTraceDomSource({ capture });
    expect(await source(sig())).toBeUndefined();
    expect(await source(sig())).toBeUndefined();
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("a throw does not disable the source", async () => {
    let n = 0;
    const capture = vi.fn(async () => {
      if (n++ === 0) throw new Error("once");
      return ok;
    });
    const source = createTraceDomSource({ capture });
    expect(await source(sig())).toBeUndefined();
    expect(await source(sig())).toMatchObject({ html: HTML });
  });
});
