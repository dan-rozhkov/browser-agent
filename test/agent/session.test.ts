import { describe, expect, it } from "vitest";
import {
  BROWSE_AGENT_TOOL_NAMES,
  createBrowseAgentSession,
  singleUseTool,
  type BrowseAgentDriver,
  type BrowseAgentMessage,
  type BrowseAgentSessionOptions,
} from "../../src/agent/index.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const assistantText = (t: string): BrowseAgentMessage => ({ role: "assistant", parts: [{ type: "text", text: t }] });

function driver(send: (text: string) => Promise<void>, messages: BrowseAgentMessage[] = [], stops: { n: number } = { n: 0 }): BrowseAgentDriver {
  return {
    send,
    stop: () => {
      stops.n += 1;
    },
    messages: () => messages,
  };
}

function session(over: Partial<BrowseAgentSessionOptions> = {}, calls: string[] = []) {
  return createBrowseAgentSession({
    executeTool: async (call) => {
      calls.push(call.toolName);
      return JSON.stringify({ ok: call.toolName });
    },
    ...over,
  });
}

describe("session core", () => {
  it("done: returns status, answer, steps in this key order", async () => {
    const s = session();
    const r = await s.run("goal", driver(async () => {
      await s.runTool({ toolName: "browse_snapshot", input: {}, toolCallId: "1" });
    }, [assistantText("final")]));
    expect(JSON.stringify(r)).toBe('{"status":"done","answer":"final","steps":1}');
  });

  it("rejects an empty goal", async () => {
    const r = await session().run("   ", driver(async () => {}));
    expect(r).toEqual({ status: "error", answer: "", steps: 0, error: "goal is required" });
  });

  it("runs the pre-open and gives the model the pre-open text", async () => {
    const calls: string[] = [];
    let sent = "";
    const s = session({}, calls);
    const r = await s.run("goal", driver(async (t) => { sent = t; }), { url: "https://a.test/" });
    expect(calls).toEqual(["browse_open"]);
    expect(sent).toBe('goal\n\nThe browser already opened https://a.test/ for you (browse_open). Its result, with a snapshot of the page:\n{"ok":"browse_open"}');
    expect(r.steps).toBe(1);
  });

  it("deadline gives timeout, aborts the tool signal and stops the driver", async () => {
    const stops = { n: 0 };
    const s = session({ deadlineMs: 20 });
    const r = await s.run("goal", driver(() => new Promise<void>(() => {}), [assistantText("partial")], stops));
    expect(r.status).toBe("timeout");
    expect(r.answer).toBe("partial");
    expect(s.signal.aborted).toBe(true);
    expect(stops.n).toBe(1);
  });

  it("parent abort gives aborted", async () => {
    const parent = new AbortController();
    const s = session({ signal: parent.signal });
    const run = s.run("goal", driver(async () => { await sleep(200); }));
    await sleep(10);
    parent.abort();
    expect((await run).status).toBe("aborted");
  });

  it("an already aborted parent returns aborted at once", async () => {
    const parent = new AbortController();
    parent.abort();
    let sent = false;
    const r = await session({ signal: parent.signal }).run("goal", driver(async () => { sent = true; }));
    expect(r.status).toBe("aborted");
    expect(sent).toBe(false);
  });

  it("abort during the pre-open gives aborted without a request", async () => {
    const parent = new AbortController();
    let sent = false;
    const s = session({
      signal: parent.signal,
      executeTool: async () => {
        parent.abort();
        return "{}";
      },
    });
    const r = await s.run("goal", driver(async () => { sent = true; }), { url: "https://a.test/" });
    expect(r.status).toBe("aborted");
    expect(sent).toBe(false);
  });

  it("request cap gives step_limit", async () => {
    const s = session({ maxRequests: 3 });
    const granted: boolean[] = [];
    const r = await s.run("goal", driver(async () => {
      for (let i = 0; i < 5; i++) granted.push(s.continueRequest());
    }));
    expect(granted).toEqual([true, true, false, false, false]);
    expect(r.status).toBe("step_limit");
  });

  it("no more requests once stopped", async () => {
    const s = session({ deadlineMs: 10 });
    await s.run("goal", driver(() => sleep(50)));
    expect(s.continueRequest()).toBe(false);
  });

  it("a transport error gives error with a capped message", async () => {
    const s = session();
    const r = await s.run("goal", driver(async () => { throw new Error("boom ".repeat(100)); }));
    expect(r.status).toBe("error");
    expect(r.error).toHaveLength(300);
  });

  it("an error recorded by the transport callback gives error", async () => {
    const s = session();
    const r = await s.run("goal", driver(async () => { s.recordError(new Error("stream failed")); }));
    expect(r).toMatchObject({ status: "error", error: "stream failed" });
  });

  it("an error from driver.error() gives error", async () => {
    const s = session();
    const d = { ...driver(async () => {}), error: () => new Error("chat error") };
    expect(await s.run("goal", d)).toMatchObject({ status: "error", error: "chat error" });
  });

  it("allowlist: refuses other tools with today's text and counts no step", async () => {
    const calls: string[] = [];
    const s = session({}, calls);
    const out = await s.runTool({ toolName: "get_screenshot", input: {}, toolCallId: "1" });
    expect(JSON.parse(out)).toEqual({
      error: `Tool get_screenshot is not available to the browse agent. Use only: ${BROWSE_AGENT_TOOL_NAMES.join(", ")}.`,
    });
    expect(calls).toEqual([]);
    expect(s.steps).toBe(0);
  });

  it("a tool that throws becomes an error result", async () => {
    const s = session({ executeTool: async () => { throw new Error("tool broke"); } });
    const out = await s.runTool({ toolName: "browse_read", input: {}, toolCallId: "1" });
    expect(JSON.parse(out)).toEqual({ error: "tool broke" });
    expect(s.steps).toBe(1);
  });

  it("deliver gets the output, and the run waits for tools still running", async () => {
    const delivered: string[] = [];
    const s = session({
      executeTool: async () => {
        await sleep(30);
        return '{"late":true}';
      },
    });
    const r = await s.run("goal", driver(async () => {
      void s.runTool({ toolName: "browse_read", input: {}, toolCallId: "1" }, (o) => delivered.push(o));
    }));
    expect(delivered).toEqual(['{"late":true}']);
    expect(r.steps).toBe(1);
  });
});

describe("extra tools", () => {
  function capture() {
    return singleUseTool({
      name: "browse_capture",
      isSuccess: (p) => typeof p.nodeId === "string",
      fields: (p) => ({ captured: { nodeId: p.nodeId, width: p.width } }),
      doneMessage: (p) => `browse_capture already ran in this task; the page is on the canvas as ${String(p.nodeId)}.`,
    });
  }

  it("is refused when the host did not list it for this run", async () => {
    const out = await session().runTool({ toolName: "browse_capture", input: {}, toolCallId: "1" });
    expect(JSON.parse(out).error).toMatch(/not available to the browse agent/);
  });

  it("allowlist text lists the extra tool last", async () => {
    const s = session({ extraTools: { browse_capture: capture() } });
    const out = await s.runTool({ toolName: "nope", input: {}, toolCallId: "1" });
    expect(JSON.parse(out).error.endsWith(`${BROWSE_AGENT_TOOL_NAMES.join(", ")}, browse_capture.`)).toBe(true);
  });

  it("allows one success, adds the field after the base fields, refuses the second call", async () => {
    const s = session({
      extraTools: { browse_capture: capture() },
      executeTool: async () => JSON.stringify({ nodeId: "n1", width: 100 }),
    });
    const r = await s.run("goal", driver(async () => {
      const first = await s.runTool({ toolName: "browse_capture", input: {}, toolCallId: "1" });
      expect(JSON.parse(first).nodeId).toBe("n1");
      const second = await s.runTool({ toolName: "browse_capture", input: {}, toolCallId: "2" });
      expect(JSON.parse(second)).toEqual({ error: "browse_capture already ran in this task; the page is on the canvas as n1." });
    }, [assistantText("ok")]));
    expect(JSON.stringify(r)).toBe('{"status":"done","answer":"ok","steps":1,"captured":{"nodeId":"n1","width":100}}');
  });

  it("refuses a parallel call while the first runs, with no step", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const s = session({
      extraTools: { browse_capture: capture() },
      executeTool: async () => { await gate; return JSON.stringify({ nodeId: "n1" }); },
    });
    const first = s.runTool({ toolName: "browse_capture", input: {}, toolCallId: "1" });
    const second = await s.runTool({ toolName: "browse_capture", input: {}, toolCallId: "2" });
    expect(JSON.parse(second)).toEqual({ error: "browse_capture is already running in this task; wait for its result." });
    release();
    await first;
    expect(s.steps).toBe(1);
  });

  it("a failed run does not use up the one try", async () => {
    let n = 0;
    const s = session({
      extraTools: { browse_capture: capture() },
      executeTool: async () => (++n === 1 ? JSON.stringify({ error: "no page" }) : JSON.stringify({ nodeId: "n2" })),
    });
    await s.runTool({ toolName: "browse_capture", input: {}, toolCallId: "1" });
    const again = await s.runTool({ toolName: "browse_capture", input: {}, toolCallId: "2" });
    expect(JSON.parse(again).nodeId).toBe("n2");
    expect(s.steps).toBe(2);
  });
});

describe("hooks reused across sessions", () => {
  it("one singleUseTool object gives each session its own one try", async () => {
    const hooks = singleUseTool({ name: "browse_capture", isSuccess: (p) => typeof p.nodeId === "string" });
    for (const n of ["n1", "n2"]) {
      const s = session({ extraTools: { browse_capture: hooks }, executeTool: async () => JSON.stringify({ nodeId: n }) });
      const first = await s.runTool({ toolName: "browse_capture", input: {}, toolCallId: "1" });
      expect(JSON.parse(first).nodeId).toBe(n);
      const second = await s.runTool({ toolName: "browse_capture", input: {}, toolCallId: "2" });
      expect(JSON.parse(second).error).toMatch(/already ran/);
    }
  });

  it("two sessions at once do not share the in-flight state", async () => {
    const hooks = singleUseTool({ name: "browse_capture", isSuccess: (p) => typeof p.nodeId === "string" });
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const a = session({ extraTools: { browse_capture: hooks }, executeTool: async () => { await gate; return '{"nodeId":"a"}'; } });
    const b = session({ extraTools: { browse_capture: hooks }, executeTool: async () => '{"nodeId":"b"}' });
    const first = a.runTool({ toolName: "browse_capture", input: {}, toolCallId: "1" });
    expect(JSON.parse(await b.runTool({ toolName: "browse_capture", input: {}, toolCallId: "2" })).nodeId).toBe("b");
    release();
    await first;
  });
});

describe("result keys", () => {
  it("host fields cannot overwrite status, answer, steps or error; extras keep their place", async () => {
    const hooks = {
      end: () => ({ status: "evil", answer: "evil", steps: 99, error: "evil", extra: 1 }),
    };
    const s = session({ extraTools: { host_tool: hooks } });
    const r = await s.run("goal", driver(async () => {
      await s.runTool({ toolName: "host_tool", input: {}, toolCallId: "1" });
    }, [assistantText("fine")]));
    expect(JSON.stringify(r)).toBe('{"status":"done","answer":"fine","steps":1,"extra":1}');
  });

  it("error stays last and the core error wins", async () => {
    const s = session({ extraTools: { host_tool: { end: () => ({ error: "evil", extra: 1 }) } } });
    const r = await s.run("goal", driver(async () => {
      await s.runTool({ toolName: "host_tool", input: {}, toolCallId: "1" });
      throw new Error("boom");
    }));
    expect(JSON.stringify(r)).toBe('{"status":"error","answer":"","steps":1,"extra":1,"error":"boom"}');
  });
});

describe("limit validation", () => {
  it.each([0, -5, Number.NaN])("deadlineMs %s throws at creation", (v) => {
    expect(() => session({ deadlineMs: v })).toThrow(/deadlineMs must be a positive number/);
  });

  it.each([0, -1, Number.NaN])("maxRequests %s throws at creation", (v) => {
    expect(() => session({ maxRequests: v })).toThrow(/maxRequests must be a positive number/);
  });

  it.each([Infinity, 2 ** 31, 1e12])("deadlineMs %s sets no timer (the run does not time out at once)", async (v) => {
    const s = session({ deadlineMs: v });
    const r = await s.run("goal", driver(async () => { await sleep(30); }, [assistantText("ok")]));
    expect(r.status).toBe("done");
  });

  it("the largest timer delay still works as a deadline", async () => {
    const s = session({ deadlineMs: 2 ** 31 - 1 });
    const r = await s.run("goal", driver(async () => {}, [assistantText("ok")]));
    expect(r.status).toBe("done");
  });

  it("maxRequests Infinity means no cap", () => {
    const s = session({ maxRequests: Infinity });
    for (let i = 0; i < 200; i++) expect(s.continueRequest()).toBe(true);
  });
});
