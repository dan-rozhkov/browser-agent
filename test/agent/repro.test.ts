import { describe, expect, it } from "vitest";
import { executeBrowseTool } from "../../src/agent/execute.js";
import { executeQaAssert } from "../../src/agent/qaChecks.js";
import { createStepRecorder } from "../../src/agent/qaCore.js";
import { createBrowseAgentSession, stripRepro } from "../../src/agent/session.js";
import { createBrowseTraceRecorder } from "../../src/agent/traceRecorder.js";
import type { BrowseTrace } from "../../src/shared/trace.js";
import { makeBridge } from "./executeHarness.js";

const LOC = { kind: "role", role: "button", name: "Save" } as const;

describe("executor repro option", () => {
  it("adds repro: true to act args only with the option", async () => {
    const off = makeBridge({ act: [{ changed: false }] });
    await executeBrowseTool(off.browser, "browse_act", { action: "click", target: "Save" });
    expect(off.callsTo("act")[0]!.args[0]).toEqual({ action: "click", target: "Save" });

    const on = makeBridge({ act: [{ changed: false, __repro: { locator: LOC } }] });
    const out = await executeBrowseTool(on.browser, "browse_act", { action: "click", target: "Save" }, { repro: true });
    expect(on.callsTo("act")[0]!.args[0]).toEqual({ action: "click", target: "Save", repro: true });
    expect(JSON.parse(out).__repro).toEqual({ locator: LOC });
  });

  it("adds repro: true to element-resolved acts", async () => {
    const b = makeBridge({ act: [{ changed: false }], snapshot: [{ url: "u", title: "t", elements: [], snapshotId: "s1" }] });
    await executeBrowseTool(b.browser, "browse_act", { action: "click", element: "the save button" }, {
      repro: true,
      locateElement: async () => ({ outcome: "found", index: 0 }),
    });
    expect(b.callsTo("act")[0]!.args[0]).toMatchObject({ action: "click", index: 0, repro: true });
  });

  it("batch: repro on every entry, captures in a top-level __repro.batch, none in results", async () => {
    const b = makeBridge({ act: [{ changed: false, __repro: { locator: LOC } }, { changed: false }, { error: "boom", __repro: { gap: "x" } }] });
    const out = JSON.parse(
      await executeBrowseTool(
        b.browser,
        "browse_act",
        { actions: [{ action: "click", target: "a" }, { action: "wait" }, { action: "click", target: "b" }] },
        { repro: true },
      ),
    );
    for (const c of b.callsTo("act")) expect((c.args[0] as Record<string, unknown>).repro).toBe(true);
    expect(out.completed).toBe(2);
    expect(out.__repro).toEqual({ batch: [{ locator: LOC }, null] });
    expect(JSON.stringify(out.results)).not.toContain("__repro");
  });

  it("batch without the option has no __repro", async () => {
    const b = makeBridge({ act: [{ changed: false }] });
    const out = JSON.parse(await executeBrowseTool(b.browser, "browse_act", { actions: [{ action: "click", target: "a" }] }));
    expect(out).not.toHaveProperty("__repro");
  });
});

describe("executeQaAssert repro", () => {
  const checks = [{ type: "text", text: "Hi" }];
  const answer = { ok: true, passed: true, results: [{ check: checks[0], passed: true }], __repro: { checks: [null] } };
  it("passes repro and keeps __repro in the output", async () => {
    const seen: unknown[] = [];
    const browser = { assert: async (a: unknown) => (seen.push(a), answer) };
    const out = JSON.parse(await executeQaAssert({ checks }, browser, createStepRecorder(), { repro: true }));
    expect(seen[0]).toMatchObject({ repro: true });
    expect(out.__repro).toEqual({ checks: [null] });
  });
  it("is unchanged without the option", async () => {
    const seen: unknown[] = [];
    const browser = { assert: async (a: unknown) => (seen.push(a), answer) };
    const out = JSON.parse(await executeQaAssert({ checks }, browser, createStepRecorder()));
    expect(seen[0]).toEqual({ checks });
    expect(out).not.toHaveProperty("__repro");
  });
});

describe("stripRepro", () => {
  it("returns the same string without the key", () => {
    const s = '{"a": 1,  "b":[1,2]}';
    expect(stripRepro(s)).toBe(s);
    expect(stripRepro("not json")).toBe("not json");
    expect(stripRepro('["__repro"]')).toBe('["__repro"]');
    expect(stripRepro('{"x":"__repro"}')).toBe('{"x":"__repro"}');
  });
  it("removes the top-level key", () => {
    expect(JSON.parse(stripRepro('{"a":1,"__repro":{"locator":{"kind":"css","value":"a"}}}'))).toEqual({ a: 1 });
  });
  it("leaves non-JSON text that mentions the key", () => {
    expect(stripRepro('oops "__repro"')).toBe('oops "__repro"');
  });
});

describe("session strips before the model", () => {
  it("the host's executeTool output has __repro; runTool and deliver do not", async () => {
    let hostOutput = "";
    const s = createBrowseAgentSession({
      executeTool: async () => {
        hostOutput = '{"changed":true,"__repro":{"gap":"iframe"}}';
        return hostOutput;
      },
    });
    let delivered = "";
    const out = await s.runTool({ toolName: "browse_act", input: {}, toolCallId: "1" }, (o) => (delivered = o));
    expect(hostOutput).toContain("__repro");
    expect(out).toBe('{"changed":true}');
    expect(delivered).toBe('{"changed":true}');
  });
  it("no __repro: byte-identical", async () => {
    const text = '{ "changed" : true }';
    const s = createBrowseAgentSession({ executeTool: async () => text });
    expect(await s.runTool({ toolName: "browse_act", input: {}, toolCallId: "1" })).toBe(text);
  });
});

// ---- trace recorder ----

async function record(
  steps: { tool: string; input: unknown; output?: unknown; error?: unknown }[],
  opts: { repro?: boolean } = { repro: true },
): Promise<BrowseTrace> {
  let t = 0;
  const r = createBrowseTraceRecorder({ goal: "g", now: () => (t += 10), ...opts });
  for (const st of steps) {
    const end = r.onToolCall({ toolName: st.tool, input: st.input });
    await end(st.error !== undefined ? { error: st.error } : { output: typeof st.output === "string" ? st.output : JSON.stringify(st.output ?? {}) });
  }
  return r.finish({ status: "done" });
}
const reproOf = (t: BrowseTrace, i = 0) => t.steps[i]!.repro;

describe("trace recorder repro", () => {
  it("browse_open: goto with the result url, redacted; app is a gap", async () => {
    const t = await record([
      { tool: "browse_open", input: { url: "https://a.test/" }, output: { url: "https://a.test/home?token=abc&q=1" } },
      { tool: "browse_open", input: { url: "https://b.test/" }, output: {} },
      { tool: "browse_open", input: { app: "Notes" }, output: {} },
    ]);
    expect(reproOf(t, 0)).toEqual([expect.objectContaining({ op: "goto", url: "https://a.test/home?token=[redacted]&q=1" })]);
    expect(reproOf(t, 1)![0]).toMatchObject({ op: "goto", url: "https://b.test/" });
    expect(reproOf(t, 2)![0]).toMatchObject({ op: "gap", gap: "electron app" });
  });

  it("browse_act ops with captures", async () => {
    const act = (input: Record<string, unknown>, cap?: unknown) => ({ tool: "browse_act", input, output: { changed: true, ...(cap ? { __repro: cap } : {}) } });
    const t = await record([
      act({ action: "click", target: "Save" }, { locator: LOC }),
      act({ action: "hover", index: 2 }, { locator: LOC }),
      act({ action: "type", target: "Email", text: "a@b.c" }, { locator: { kind: "label", value: "Email" } }),
      act({ action: "select", target: "Country", text: "Norway" }, { locator: { kind: "label", value: "Country" }, value: "no" }),
      act({ action: "select", target: "Country", text: "Norway" }, { locator: { kind: "label", value: "Country" } }),
      act({ action: "press", key: "Enter" }),
      act({ action: "press", key: "Enter", target: "Email" }, { locator: { kind: "label", value: "Email" } }),
      act({ action: "back" }),
      act({ action: "forward" }),
      act({ action: "reload" }),
      act({ action: "viewport", width: 400, height: 800 }, { viewport: { width: 400, height: 800 } }),
      act({ action: "viewport", width: 400, height: 800 }),
      act({ action: "scroll" }),
      act({ action: "wait" }),
      act({ action: "upload", target: "File", files: ["/a"] }),
      act({ action: "click", target: "X" }, { gap: "iframe" }),
      act({ action: "click", target: "X" }),
    ]);
    const r = (i: number) => reproOf(t, i);
    expect(r(0)).toEqual([{ op: "click", locator: LOC, note: 'click button "Save"' }]);
    expect(r(1)![0]).toMatchObject({ op: "hover", locator: LOC });
    expect(r(2)![0]).toMatchObject({ op: "fill", text: "a@b.c", locator: { kind: "label" } });
    expect(r(3)![0]).toMatchObject({ op: "select", value: "no" });
    expect(r(4)![0]).toMatchObject({ op: "gap", gap: "not-found" });
    expect(r(5)![0]).toEqual({ op: "press", key: "Enter", note: "press Enter" });
    expect(r(6)![0]).toMatchObject({ op: "press", key: "Enter", locator: { kind: "label" } });
    expect(r(7)![0].op).toBe("back");
    expect(r(8)![0].op).toBe("forward");
    expect(r(9)![0].op).toBe("reload");
    expect(r(10)![0]).toMatchObject({ op: "viewport", viewport: { width: 400, height: 800 } });
    expect(r(11)).toEqual([]);
    expect(r(12)).toEqual([]);
    expect(r(13)).toEqual([]);
    expect(r(14)![0]).toMatchObject({ op: "gap", gap: "upload" });
    expect(r(15)![0]).toMatchObject({ op: "gap", gap: "iframe" });
    expect(r(16)![0]).toMatchObject({ op: "gap", gap: "not-found" });
  });

  it("batch: one entry per completed action; captures aligned; __repro removed from output", async () => {
    const t = await record([
      {
        tool: "browse_act",
        input: { actions: [{ action: "click", target: "a" }, { action: "wait" }, { action: "type", target: "b", text: "hello" }, { action: "click", target: "c" }] },
        output: {
          results: [{}, {}, {}, { error: "no" }],
          completed: 3,
          stoppedAt: 3,
          error: "no",
          __repro: { batch: [{ locator: LOC }, null, { locator: { kind: "label", value: "B" } }] },
        },
      },
    ]);
    // The batch failed at entry 3, so the step is not ok: the completed actions are recorded, then a gap.
    expect(t.steps[0]!.ok).toBe(false);
    expect(reproOf(t)!.map((a) => a.op)).toEqual(["click", "fill", "gap"]);
    expect(reproOf(t)![2]).toMatchObject({ gap: "batch stopped at action 4: no" });
    const t2 = await record([
      {
        tool: "browse_act",
        input: { actions: [{ action: "click", target: "a" }, { action: "wait" }, { action: "type", target: "b", text: "hello" }] },
        output: { results: [{}, {}, {}], completed: 3, __repro: { batch: [{ locator: LOC }, null, { locator: { kind: "label", value: "B" } }] } },
      },
    ]);
    expect(reproOf(t2)!.map((a) => a.op)).toEqual(["click", "fill"]);
    expect(reproOf(t2)![1]).toMatchObject({ text: "hello", locator: { kind: "label", value: "B" } });
    expect(t2.steps[0]!.output).not.toContain("__repro");
  });

  it("secrets: capture.secret and a password-like target never store the text", async () => {
    const t = await record([
      { tool: "browse_act", input: { action: "type", target: "Card", text: "4111111111111111" }, output: { __repro: { locator: { kind: "label", value: "Card" }, secret: true } } },
      { tool: "browse_act", input: { action: "type", target: "Password", text: "hunter2" }, output: { __repro: { locator: { kind: "label", value: "Password" } } } },
      { tool: "browse_act", input: { actions: [{ action: "type", target: "Password", text: "hunter3" }] }, output: { results: [{}], completed: 1, __repro: { batch: [{ locator: LOC }] } } },
    ]);
    expect(reproOf(t, 0)![0]).toMatchObject({ op: "fill", secret: true });
    expect(reproOf(t, 1)![0]).toMatchObject({ op: "fill", secret: true });
    expect(reproOf(t, 2)![0]).toMatchObject({ op: "fill", secret: true });
    const json = JSON.stringify(t);
    for (const v of ["4111111111111111", "hunter2", "hunter3"]) expect(json).not.toContain(v);
    expect(reproOf(t, 1)![0]).not.toHaveProperty("text");
  });

  it("screenshot waitFor.text, qa_assert, tabs, other tools, read-only tools", async () => {
    const check = { type: "text", text: "1 item" };
    const t = await record([
      { tool: "browse_screenshot", input: { waitFor: { text: "Done" } }, output: {} },
      { tool: "browse_screenshot", input: {}, output: {} },
      {
        tool: "qa_assert",
        input: { checks: [check, { type: "element", selector: "#a", state: "visible" }] },
        output: {
          passed: false,
          results: [{ check, passed: false, actual: "0 items" }, { check: {}, passed: true }],
          __repro: { checks: [null, { locator: LOC }] },
        },
      },
      { tool: "browse_tabs", input: { action: "new" }, output: {} },
      { tool: "browse_tabs", input: { action: "list" }, output: {} },
      { tool: "browse_fill_login", input: {}, output: {} },
      { tool: "browse_snapshot", input: {}, output: {} },
      { tool: "browse_read", input: {}, output: {} },
      { tool: "browse_find_images", input: {}, output: {} },
      { tool: "browse_capture", input: {}, output: {} },
      { tool: "qa_verdict", input: {}, output: {} },
    ]);
    expect(reproOf(t, 0)![0]).toMatchObject({ op: "expect", check: { type: "text", text: "Done" }, passed: true });
    expect(reproOf(t, 1)).toBeUndefined();
    const q = reproOf(t, 2)!;
    expect(q).toHaveLength(2);
    expect(q[0]).toMatchObject({ op: "expect", check, passed: false, actual: "0 items" });
    expect(q[0]).not.toHaveProperty("checkLocator");
    expect(q[1]).toMatchObject({ passed: true, checkLocator: LOC });
    expect(reproOf(t, 3)![0]).toMatchObject({ op: "gap", gap: "tabs" });
    expect(reproOf(t, 4)).toBeUndefined();
    expect(reproOf(t, 5)![0]).toMatchObject({ op: "gap", gap: "browse_fill_login" });
    for (let i = 6; i <= 10; i++) expect(reproOf(t, i)).toBeUndefined();
    expect(t.steps[2]!.output).not.toContain("__repro");
  });

  it("a failed step has no repro", async () => {
    const t = await record([
      { tool: "browse_act", input: { action: "click", target: "a" }, output: { error: "nope", __repro: { locator: LOC } } },
      { tool: "browse_act", input: { action: "click", target: "a" }, error: new Error("x") },
    ]);
    expect(reproOf(t, 0)).toBeUndefined();
    expect(reproOf(t, 1)).toBeUndefined();
  });

  it("repro off: no repro fields, output stripped of the key only", async () => {
    const t = await record([{ tool: "browse_act", input: { action: "click", target: "a" }, output: { changed: true, __repro: { locator: LOC } } }], {});
    expect(JSON.stringify(t)).not.toContain('"repro"');
    expect(t.steps[0]!.output).toBe('{"changed":true}');
  });

  it("an output without __repro stays byte-identical", async () => {
    const raw = '{ "changed" :  true }';
    const t = await record([{ tool: "browse_act", input: { action: "click", target: "a" }, output: raw }]);
    expect(t.steps[0]!.output).toBe(raw);
  });
});

describe("trace.repro setup", () => {
  it("is {} when on without setup, absent when off", () => {
    const on = createBrowseTraceRecorder({ goal: "g", repro: true });
    expect(on.finish({ status: "done" }).repro).toEqual({});
    const off = createBrowseTraceRecorder({ goal: "g" });
    expect(off.finish({ status: "done" })).not.toHaveProperty("repro");
  });
  it("stores redacted network rules, emulate, app and storage flags", () => {
    const r = createBrowseTraceRecorder({ goal: "g", repro: true });
    r.setRepro({
      setup: {
        network: [{ url: "https://api.test/cart*", status: 500, body: { error: "x", token: "sekret", nested: { ok: 1 } } }],
        emulate: { colorScheme: "dark" },
        cookies: [{ name: "s" }],
        app: true,
      },
    });
    const t = r.finish({ status: "done" });
    expect(t.repro!.setup).toMatchObject({ emulate: { colorScheme: "dark" }, app: true, storage: true });
    expect(t.repro!.setup!.network![0]).toMatchObject({ url: "https://api.test/cart*", status: 500, body: { error: "x", token: "[redacted]", nested: { ok: 1 } } });
    expect(JSON.stringify(t)).not.toContain("sekret");
  });
  it("setRepro is a no-op when repro is off", () => {
    const r = createBrowseTraceRecorder({ goal: "g" });
    r.setRepro({ setup: { app: true } });
    expect(r.finish({ status: "done" })).not.toHaveProperty("repro");
  });
});

describe("repro fixes", () => {
  const recordWith = async (steps: Parameters<typeof record>[0], redactArgs?: (a: unknown) => unknown): Promise<BrowseTrace> => {
    let t = 0;
    const r = createBrowseTraceRecorder({ goal: "g", now: () => (t += 10), repro: true, ...(redactArgs ? { redactArgs } : {}) });
    for (const st of steps) {
      const end = r.onToolCall({ toolName: st.tool, input: st.input });
      await end({ output: JSON.stringify(st.output ?? {}) });
    }
    return r.finish({ status: "done" });
  };
  const mask = (a: unknown): unknown => JSON.parse(JSON.stringify(a, (k, v) => (k === "text" ? "***" : v)));

  it("fixture setup: url (redacted), steps (secret text dropped), tabs", () => {
    const r = createBrowseTraceRecorder({ goal: "g", repro: true });
    r.setRepro({
      setup: {
        url: "https://shop.test/?sid=abc&q=1",
        tabs: ["https://x.test/"],
        steps: [
          { action: "type", selector: "#email", text: "a@b.c" },
          { action: "type", selector: "input[name=password]", text: "hunter2" },
          { action: "goto", url: "https://shop.test/two?token=zzz" },
          { action: "waitFor", selector: "#x", timeoutMs: 100 },
          { action: "wait", ms: 5 },
          { action: "click", selector: "#c" },
          { action: "select", selector: "#s", value: "v" },
          { action: "press", key: "Enter" },
          { action: "bogus" },
        ],
      },
    });
    const t = r.finish({ status: "done" });
    const setup = t.repro!.setup!;
    expect(setup).toMatchObject({ url: "https://shop.test/?sid=[redacted]&q=1", urlRedacted: true, tabs: 1 });
    expect(setup.steps).toEqual([
      { action: "type", selector: "#email", text: "a@b.c" },
      { action: "type", selector: "input[name=password]", secret: true },
      { action: "goto", url: "https://shop.test/two?token=[redacted]", urlRedacted: true },
      { action: "waitFor", selector: "#x", timeoutMs: 100 },
      { action: "wait", ms: 5 },
      { action: "click", selector: "#c" },
      { action: "select", selector: "#s", value: "v" },
      { action: "press", key: "Enter" },
    ]);
    expect(JSON.stringify(t)).not.toContain("hunter2");
  });

  it("goto flags a removed secret", async () => {
    const t = await recordWith([{ tool: "browse_open", input: { url: "https://a.test/?token=1" }, output: {} }]);
    expect(reproOf(t)![0]).toMatchObject({ op: "goto", url: "https://a.test/?token=[redacted]", urlRedacted: true });
  });

  it("a partial batch records the completed actions, then a gap; a single failed action stays unrecorded", async () => {
    const t = await recordWith([
      {
        tool: "browse_act",
        input: { actions: [{ action: "click", target: "a" }, { action: "type", target: "Name", text: "Bo" }, { action: "click", target: "c" }] },
        output: { results: [{}, {}, { error: "element not found\nreally" }], completed: 2, stoppedAt: 2, error: "element not found", __repro: { batch: [{ locator: LOC }, { locator: { kind: "label", value: "Name" } }, { gap: "not-found" }] } },
      },
      { tool: "browse_act", input: { actions: [{ action: "click", target: "a" }] }, output: { results: [{ error: "x" }], completed: 0, stoppedAt: 0, error: "x" } },
      { tool: "browse_act", input: { action: "click", target: "a" }, output: { error: "nope", completed: 1, __repro: { locator: LOC } } },
    ]);
    expect(t.steps[0]!.ok).toBe(false);
    expect(reproOf(t)!.map((a) => a.op)).toEqual(["click", "fill", "gap"]);
    expect(reproOf(t)![1]).toMatchObject({ text: "Bo" });
    expect(reproOf(t)![2]).toMatchObject({ gap: "batch stopped at action 3: element not found really" });
    expect(reproOf(t, 1)).toBeUndefined();
    expect(reproOf(t, 2)).toBeUndefined();
  });

  it("fill text is kept only when the host-redacted args hold the same text at the same place", async () => {
    const input = { action: "type", target: "Search", text: "shoes" };
    const out = { __repro: { locator: { kind: "label", value: "Search" } } };
    // Default redactor: the text survives.
    expect(reproOf(await recordWith([{ tool: "browse_act", input, output: out }]))![0]).toMatchObject({ text: "shoes" });
    // A custom redactor masks it.
    const masked = await recordWith([{ tool: "browse_act", input, output: out }], mask);
    expect(reproOf(masked)![0]).toMatchObject({ op: "fill", secret: true });
    expect(reproOf(masked)![0]).not.toHaveProperty("text");
    expect(JSON.stringify(masked)).not.toContain("shoes");
    // Dropped, changed or throwing redactors are secrets too.
    for (const red of [() => ({}), (a: unknown) => ({ ...(a as object), text: "shoe" }), () => { throw new Error("x"); }]) {
      expect(reproOf(await recordWith([{ tool: "browse_act", input, output: out }], red))![0]).toMatchObject({ secret: true });
    }
    // Batch entries: same rule, position by position.
    const batch = { actions: [{ action: "type", target: "A", text: "one" }, { action: "type", target: "B", text: "zebra-secret" }] };
    const bout = { results: [{}, {}], completed: 2, __repro: { batch: [{ locator: LOC }, { locator: LOC }] } };
    const keepFirst = (a: unknown) => {
      const c = JSON.parse(JSON.stringify(a)) as { actions: { text: string }[] };
      c.actions[1]!.text = "***";
      return c;
    };
    const tb = await recordWith([{ tool: "browse_act", input: batch, output: bout }], keepFirst);
    expect(reproOf(tb)![0]).toMatchObject({ text: "one" });
    expect(reproOf(tb)![1]).toMatchObject({ secret: true });
    expect(JSON.stringify(tb)).not.toContain("zebra-secret");
  });

  it("qa_assert results with an error keep the error", async () => {
    const check = { type: "element", selector: "(((", state: "visible" };
    const t = await recordWith([{ tool: "qa_assert", input: { checks: [check] }, output: { passed: false, results: [{ check, passed: false, error: "invalid selector" }], __repro: { checks: [null] } } }]);
    expect(reproOf(t)![0]).toMatchObject({ op: "expect", error: "invalid selector" });
  });

  describe("mock rules", () => {
    const rules = (network: unknown[]) => {
      const r = createBrowseTraceRecorder({ goal: "g", repro: true });
      r.setRepro({ setup: { network: network as never } });
      return r.finish({ status: "done" }).repro!.setup!.network!;
    };
    it("keeps a clean url as given (no cap, no change)", () => {
      const long = `https://a.test/${"x".repeat(2500)}*`;
      expect(rules([{ url: long }, { url: "HTTPS://A.test" }]).map((x) => x.url)).toEqual([long, "HTTPS://A.test"]);
    });
    it("marks a secret query value or userinfo as a gap", () => {
      const [a, b] = rules([{ url: "https://a.test/x?access_token=abc&y=1*" }, { url: "https://u:p@a.test/" }]);
      expect(a).toMatchObject({ gap: "mock url had a secret query value", url: "https://a.test/x?access_token=[redacted]&y=1*" });
      expect(b!.gap).toBe("mock url had a secret query value");
      expect(JSON.stringify([a, b])).not.toMatch(/abc|u:p/);
    });
    it("deep-copies object bodies, replacing secret-named keys only; no 4000 char cap", () => {
      const big = "z".repeat(10_000);
      const [r] = rules([{ url: "https://a/", body: { list: [{ password: "p", name: big }], auth: { x: 1 }, ok: true } }]);
      expect(r!.body).toEqual({ list: [{ password: "[redacted]", name: big }], auth: "[redacted]", ok: true });
      expect(r!.bodyRedacted).toBe(true);
    });
    it("a JSON string body stays a JSON string; other strings stay unless they hold a secret word", () => {
      const [a, b, c, d] = rules([
        { url: "https://a/", body: '{"token":"t","n":1}' },
        { url: "https://a/", body: '{"n":1}' },
        { url: "https://a/", body: "hello world" },
        { url: "https://a/", body: "password=hunter2" },
      ]);
      expect(typeof a!.body).toBe("string");
      expect(JSON.parse(a!.body as string)).toEqual({ token: "[redacted]", n: 1 });
      expect(a!.bodyRedacted).toBe(true);
      expect(b).not.toHaveProperty("bodyRedacted");
      expect(c!.body).toBe("hello world");
      expect(d!.gap).toBeTruthy();
      expect(d).not.toHaveProperty("body");
    });
    it("a body over 200 KB is a gap", () => {
      const [a, b] = rules([{ url: "https://a/", body: { v: "x".repeat(200_001) } }, { url: "https://a/", body: "y".repeat(200_001) }]);
      expect(a!.gap).toBe("mock body too large");
      expect(a).not.toHaveProperty("body");
      expect(b!.gap).toBe("mock body too large");
    });
    it("removes secret headers and flags it", () => {
      const [a] = rules([{ url: "https://a/", headers: { "Set-Cookie": "s=1", "Content-Type": "text/plain" } }]);
      expect(a!.headers).toEqual({ "Content-Type": "text/plain" });
      expect(a!.headersRedacted).toBe(true);
    });
  });
});
