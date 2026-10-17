import { describe, expect, it } from "vitest";
import { runQaSuite } from "../../src/qa/suite.js";
import type { QaScenario } from "../../src/qa/types.js";
import { browserFactory, fakeBridge, readThenVerdict, scenario, scriptedModel, verdictStep, type Step } from "./helpers.js";

const goalsOf = (list: QaScenario[]) => list.map((s) => s.goal);
// normalizeScreenshot wants at least 100 base64 chars.
const PNG = `iVBORw0KGgo${"A".repeat(120)}`;

async function run(list: QaScenario[], script: (g: string, n: number) => Step, over: Parameters<typeof browserFactory>[0] = undefined, extra: Partial<Parameters<typeof runQaSuite>[1]> = {}) {
  const f = browserFactory(over);
  const model = scriptedModel(script, goalsOf(list));
  const report = await runQaSuite(list, { model, openBrowser: f.openBrowser, ...extra });
  return { report, f, model };
}

describe("runQaSuite: validation", () => {
  const opts = { model: scriptedModel(() => ({ text: "x" }), []), openBrowser: browserFactory().openBrowser };
  it.each([
    ["an empty list", [], /no scenarios/],
    ["a duplicate id", [scenario("a"), scenario("a")], /duplicate scenario id "a"/],
    ["an id with a slash", [scenario("a/b")], /invalid scenario id/],
    ["an empty id", [scenario("")], /invalid scenario id/],
    ["a 65-char id", [scenario("a".repeat(65))], /invalid scenario id/],
    ["an empty goal", [scenario("a", { goal: "  " })], /empty goal/],
    ["url and fixture together", [scenario("a", { url: "https://a.test/", fixture: { version: 1 } })], /both url and fixture/],
  ] as const)("throws for %s, before anything opens", async (_name, list, message) => {
    const f = browserFactory();
    await expect(runQaSuite([...list], { ...opts, openBrowser: f.openBrowser })).rejects.toThrow(message);
    expect(f.state.opened).toEqual([]);
  });

  it.each([
    ["concurrency 0", { concurrency: 0 }, /concurrency/],
    ["concurrency NaN", { concurrency: NaN }, /concurrency/],
    ["a string concurrency", { concurrency: "3" as unknown as number }, /concurrency/],
    ["deadlineMs 0", { agent: { deadlineMs: 0 } }, /agent.deadlineMs/],
    ["maxRequests NaN", { agent: { maxRequests: NaN } }, /agent.maxRequests/],
    ["a negative maxRequests", { agent: { maxRequests: -1 } }, /agent.maxRequests/],
  ] as const)("throws for %s, before any browser opens", async (_name, extra, message) => {
    const f = browserFactory();
    await expect(runQaSuite([scenario("a")], { ...opts, openBrowser: f.openBrowser, ...extra })).rejects.toThrow(message);
    expect(f.state.opened).toEqual([]);
  });

  it("accepts Infinity for the agent limits", async () => {
    const { report } = await run([scenario("a")], () => ({ text: "ok" }), undefined, { agent: { maxRequests: Infinity, deadlineMs: Infinity } });
    expect(report.scenarios[0]!.outcome).toBe("inconclusive");
  });

  it("accepts a 64-char id with _ and -", async () => {
    const { report } = await run([scenario("A_b-9".padEnd(64, "x"))], () => ({ text: "ok" }));
    expect(report.scenarios).toHaveLength(1);
  });
});

describe("runQaSuite: outcomes", () => {
  it("pass verdict gives passed with the reason (trimmed)", async () => {
    const { report } = await run([scenario("a")], readThenVerdict("pass", "  looks right  "));
    expect(report.scenarios[0]).toMatchObject({ id: "a", outcome: "passed", verdictReason: "looks right", status: "done", answer: "All checked." });
    expect(report.summary).toEqual({ total: 1, passed: 1, failed: 0, inconclusive: 0, error: 0, setup_failed: 0, aborted: 0 });
  });

  it("fail verdict gives failed", async () => {
    const { report } = await run([scenario("a", { title: "T" })], readThenVerdict("fail", "no badge"));
    expect(report.scenarios[0]).toMatchObject({ outcome: "failed", verdictReason: "no badge", title: "T" });
  });

  it("done without a verdict is inconclusive", async () => {
    const { report } = await run([scenario("a")], () => ({ text: "blocked by a CAPTCHA" }));
    expect(report.scenarios[0]).toMatchObject({ outcome: "inconclusive", status: "done", answer: "blocked by a CAPTCHA" });
    expect(report.scenarios[0]!.verdictReason).toBeUndefined();
  });

  it("a model error without a verdict is error", async () => {
    const f = browserFactory();
    const { MockLanguageModelV3 } = await import("ai/test");
    const model = new MockLanguageModelV3({ doGenerate: async () => { throw new Error("provider down"); } });
    const report = await runQaSuite([scenario("a")], { model, openBrowser: f.openBrowser });
    expect(report.scenarios[0]).toMatchObject({ outcome: "error", status: "error" });
    expect(report.scenarios[0]!.error).toContain("provider down");
  });

  it("a verdict wins over a later step limit", async () => {
    const list = [scenario("a")];
    const { report } = await run(list, (_g, n) => (n === 0 ? verdictStep("pass") : { calls: [{ name: "browse_read", input: {} }] }), undefined, { agent: { maxRequests: 3 } });
    expect(report.scenarios[0]).toMatchObject({ outcome: "passed", status: "step_limit" });
  });

  it("step_limit without a verdict is error with a text", async () => {
    const { report } = await run([scenario("a")], () => ({ calls: [{ name: "browse_read", input: {} }] }), undefined, { agent: { maxRequests: 2 } });
    expect(report.scenarios[0]).toMatchObject({ outcome: "error", status: "step_limit", error: "request limit reached" });
  });

  it("a failed fixture is setup_failed with its stage, no model call and no screenshot", async () => {
    const list = [scenario("a", { fixture: { version: 1, expect: { selector: "#x" } } })];
    const { report, model } = await run(list, () => ({ text: "never" }), () => ({
      applyFixture: async () => ({ ok: false, stage: "expect", error: "expect failed" }),
      screenshot: async () => ({ imageData: `data:image/png;base64,${PNG}` }),
    }));
    expect(report.scenarios[0]).toMatchObject({ outcome: "setup_failed", status: "setup_failed", setupStage: "expect", error: "expect failed" });
    expect(report.scenarios[0]!.screenshot).toBeUndefined();
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("openBrowser throwing gives error without a status, and the others still run", async () => {
    const f = browserFactory();
    const list = [scenario("a"), scenario("b")];
    const model = scriptedModel(readThenVerdict("pass"), goalsOf(list));
    const report = await runQaSuite(list, {
      model,
      concurrency: 1,
      openBrowser: async (s) => {
        if (s.id === "a") throw new Error("no browser");
        return f.openBrowser(s);
      },
    });
    expect(report.scenarios[0]).toMatchObject({ id: "a", outcome: "error", steps: [] });
    expect(report.scenarios[0]!.error).toContain("no browser");
    expect("status" in report.scenarios[0]!).toBe(false);
    expect(report.scenarios[1]!.outcome).toBe("passed");
    expect(f.state.closed).toEqual(["b"]);
  });

  it("an abort during the run gives aborted, not a verdict outcome", async () => {
    const ctrl = new AbortController();
    const f = browserFactory();
    const { MockLanguageModelV3 } = await import("ai/test");
    const model = new MockLanguageModelV3({
      doGenerate: async (o: { abortSignal?: AbortSignal }) => {
        setTimeout(() => ctrl.abort(), 5);
        return new Promise((_r, reject) => o.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) as never;
      },
    });
    const report = await runQaSuite([scenario("a")], { model, openBrowser: f.openBrowser, signal: ctrl.signal });
    expect(report.scenarios[0]).toMatchObject({ outcome: "aborted", status: "aborted" });
    expect(report.scenarios[0]!.screenshot).toBeUndefined();
    expect(f.state.closed).toEqual(["a"]);
  });
});

describe("runQaSuite: concurrency and order", () => {
  const list = ["a", "b", "c", "d", "e"].map((id) => scenario(id));

  it("never runs more than `concurrency` at once, and reports in input order", async () => {
    // Earlier scenarios are slower, so they finish last.
    const delays: Record<string, number> = { "goal a": 40, "goal b": 30, "goal c": 20, "goal d": 10, "goal e": 0 };
    const finished: string[] = [];
    const script = (g: string, n: number): Step => (n === 0 ? { delayMs: delays[g], calls: [{ name: "browse_read", input: {} }] } : n === 1 ? verdictStep("pass") : { text: "ok" });
    const { report, f } = await run(list, script, undefined, { concurrency: 2, onScenarioDone: (s) => { finished.push(s.id); } });
    expect(f.state.peak).toBe(2);
    expect(report.concurrency).toBe(2);
    expect(report.scenarios.map((s) => s.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(finished).not.toEqual(["a", "b", "c", "d", "e"]);
    expect([...finished].sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("clamps concurrency to the scenario count (Infinity means all at once); default is 3", async () => {
    const two = list.slice(0, 2);
    expect((await run(two, readThenVerdict("pass"), undefined, { concurrency: 10 })).report.concurrency).toBe(2);
    expect((await run(two, readThenVerdict("pass"), undefined, { concurrency: Infinity })).report.concurrency).toBe(2);
    expect((await run(two, readThenVerdict("pass"), undefined, { concurrency: 1.9 })).report.concurrency).toBe(1);
    expect((await run(list, readThenVerdict("pass"))).report.concurrency).toBe(3);
  });

  it("each scenario has its own verdict (no shared state)", async () => {
    const two = [scenario("a"), scenario("b")];
    const script = (g: string, n: number): Step => (n === 0 ? { delayMs: 5, calls: [{ name: "browse_read", input: {} }] } : n === 1 ? verdictStep(g === "goal a" ? "pass" : "fail", g) : { text: "ok" });
    const { report } = await run(two, script, undefined, { concurrency: 2 });
    expect(report.scenarios.map((s) => [s.outcome, s.verdictReason])).toEqual([["passed", "goal a"], ["failed", "goal b"]]);
  });
});

describe("runQaSuite: abortable openBrowser", () => {
  it("passes the signal to openBrowser", async () => {
    const ctrl = new AbortController();
    const seen: unknown[] = [];
    const f = browserFactory();
    await runQaSuite([scenario("a")], {
      model: scriptedModel(readThenVerdict("pass"), ["goal a"]),
      signal: ctrl.signal,
      openBrowser: async (s, ctx) => { seen.push(ctx.signal); return f.openBrowser(s); },
    });
    expect(seen).toEqual([ctrl.signal]);
  });

  it("an abort ends the wait for a never-resolving openBrowser: outcome aborted", async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5);
    const report = await runQaSuite([scenario("a")], { model: scriptedModel(() => ({ text: "x" }), []), signal: ctrl.signal, openBrowser: () => new Promise(() => {}) });
    expect(report.scenarios[0]).toMatchObject({ outcome: "aborted", steps: [] });
  });

  it("a browser that arrives after the abort is closed (a close error is ignored)", async () => {
    const ctrl = new AbortController();
    const closed: string[] = [];
    let arrive!: () => void;
    const late = new Promise<void>((r) => { arrive = r; });
    setTimeout(() => ctrl.abort(), 5);
    const report = await runQaSuite([scenario("a")], {
      model: scriptedModel(() => ({ text: "x" }), []),
      signal: ctrl.signal,
      openBrowser: async () => {
        await late;
        return { browser: fakeBridge(), close: async () => { closed.push("a"); throw new Error("close boom"); } };
      },
    });
    expect(report.scenarios[0]!.outcome).toBe("aborted");
    arrive();
    await new Promise((r) => setTimeout(r, 10));
    expect(closed).toEqual(["a"]);
  });
});

describe("runQaSuite: bad openBrowser results", () => {
  it.each([["undefined", undefined], ["null", null], ["an empty object", {}], ["no close", { browser: fakeBridge() }]])("%s gives error, not aborted", async (_n, value) => {
    const report = await runQaSuite([scenario("a")], { model: scriptedModel(() => ({ text: "x" }), []), openBrowser: (async () => value) as never });
    expect(report.scenarios[0]).toMatchObject({ outcome: "error", error: "openBrowser returned no browser", steps: [] });
  });

  it("a bad result after an abort is aborted, and a late bad result never rejects unhandled", async () => {
    const unhandled: unknown[] = [];
    const on = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", on);
    try {
      for (const late of [{ browser: fakeBridge(), close: () => { throw new Error("sync boom"); } }, { browser: fakeBridge() }, undefined, { browser: fakeBridge(), close: async () => { throw new Error("async boom"); } }]) {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 5);
        const report = await runQaSuite([scenario("a")], {
          model: scriptedModel(() => ({ text: "x" }), []),
          signal: ctrl.signal,
          openBrowser: () => new Promise((r) => setTimeout(() => r(late as never), 20)),
        });
        expect(report.scenarios[0]!.outcome).toBe("aborted");
        await new Promise((r) => setTimeout(r, 40));
      }
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", on);
    }
  });
});

describe("runQaSuite: close and abort", () => {
  it("close runs in every outcome and a close error is ignored", async () => {
    const f = browserFactory(undefined, { closeThrows: true });
    const list = [scenario("pass"), scenario("setup", { fixture: { version: 1, expect: { selector: "#x" } } }), scenario("none")];
    const model = scriptedModel((g, n) => (g === "goal pass" ? readThenVerdict("pass")(g, n) : { text: "no verdict" }), goalsOf(list));
    const report = await runQaSuite(list, {
      model,
      openBrowser: async (s) => {
        const b = await f.openBrowser(s);
        if (s.id === "setup") b.browser.applyFixture = async () => ({ ok: false, error: "x" });
        return b;
      },
    });
    expect(report.scenarios.map((s) => s.outcome)).toEqual(["passed", "setup_failed", "inconclusive"]);
    expect([...f.state.closed].sort()).toEqual(["none", "pass", "setup"]);
  });

  it("a signal aborted before the start gives aborted for all, without openBrowser", async () => {
    const f = browserFactory();
    const ctrl = new AbortController();
    ctrl.abort();
    const list = [scenario("a"), scenario("b")];
    const report = await runQaSuite(list, { model: scriptedModel(() => ({ text: "x" }), []), openBrowser: f.openBrowser, signal: ctrl.signal });
    expect(report.scenarios.map((s) => s.outcome)).toEqual(["aborted", "aborted"]);
    expect(f.state.opened).toEqual([]);
    expect(report.summary.aborted).toBe(2);
  });

  it("scenarios not started when the signal aborts get aborted", async () => {
    const ctrl = new AbortController();
    const list = [scenario("a"), scenario("b"), scenario("c")];
    const { report, f } = await run(list, readThenVerdict("pass"), undefined, { concurrency: 1, signal: ctrl.signal, onScenarioDone: () => ctrl.abort() });
    expect(report.scenarios.map((s) => s.outcome)).toEqual(["passed", "aborted", "aborted"]);
    expect(f.state.opened).toEqual(["a"]);
  });

  it("a throwing onScenarioDone is ignored", async () => {
    const { report } = await run([scenario("a")], readThenVerdict("pass"), undefined, { onScenarioDone: () => { throw new Error("cb"); } });
    expect(report.scenarios[0]!.outcome).toBe("passed");
  });
});

describe("runQaSuite: failures stay inside the scenario", () => {
  it("a failure after openBrowser still closes the browser and gives an error report", async () => {
    const f = browserFactory();
    const list = [scenario("a"), scenario("b")];
    const model = scriptedModel(readThenVerdict("pass"), goalsOf(list));
    const o = { model, openBrowser: f.openBrowser, concurrency: 2 };
    Object.defineProperty(o, "providerOptions", { get() { throw new Error("options boom"); } });
    const report = await runQaSuite(list, o);
    expect(report.scenarios.map((s) => s.outcome)).toEqual(["error", "error"]);
    expect(report.scenarios[0]!.error).toContain("options boom");
    expect([...f.state.closed].sort()).toEqual(["a", "b"]);
  });

  it("an async onScenarioDone that rejects is ignored and does not wait", async () => {
    const unhandled: unknown[] = [];
    const on = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", on);
    try {
      const { report } = await run([scenario("a")], readThenVerdict("pass"), undefined, { onScenarioDone: async () => { throw new Error("late"); } });
      await new Promise((r) => setTimeout(r, 10));
      expect(report.scenarios[0]!.outcome).toBe("passed");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", on);
    }
  });
});

describe("runQaSuite: verdict tool", () => {
  it("a second qa_verdict returns an error string and the first verdict stays", async () => {
    const results: string[] = [];
    const f = browserFactory();
    const model = scriptedModel((_g, n) => (n === 0 ? verdictStep("pass", "first") : n === 1 ? verdictStep("fail", "second") : { text: "done" }), ["goal a"]);
    const report = await runQaSuite([scenario("a")], { model, openBrowser: f.openBrowser });
    for (const call of model.doGenerateCalls) results.push(JSON.stringify(call.prompt));
    expect(report.scenarios[0]).toMatchObject({ outcome: "passed", verdictReason: "first" });
    expect(results[2]).toContain("already called");
  });

  it("the model gets the QA prompt and the verdict tool", async () => {
    const { model } = await run([scenario("a")], readThenVerdict("pass"));
    const first = model.doGenerateCalls[0]!;
    expect(JSON.stringify(first.prompt)).toContain("You are a browsing subagent working for a QA engineer");
    expect(JSON.stringify(first.prompt)).toContain("You test a web app");
    expect((first.tools ?? []).map((t) => t.name)).toContain("qa_verdict");
  });

  it("passes agent options on", async () => {
    const { model } = await run([scenario("a")], () => ({ text: "x" }), undefined, { agent: { screenshots: false } });
    expect((model.doGenerateCalls[0]!.tools ?? []).map((t) => t.name)).not.toContain("browse_screenshot");
  });
});

describe("runQaSuite: steps and secrets", () => {
  const SECRET = "fixture-secret-ZZ";

  it("records the model's browser calls, not the fixture calls, and the report never holds the secret", async () => {
    const list = [scenario("a", { fixture: { version: 1, storage: { cookies: [{ name: "s", value: SECRET, url: "https://a.test/" }] } } })];
    const calls: string[] = [];
    const { report } = await run(list, (_g, n) => (n === 0 ? { calls: [{ name: "browse_read", input: {} }] } : n === 1 ? verdictStep("pass") : { text: "ok" }), () => ({
      applyFixture: async () => { calls.push("apply"); return { ok: true, summary: "1 cookie", fixtureToken: "tok" }; },
      releaseFixture: async () => { calls.push("release"); },
      captureFixture: async () => ({ ok: true, fixture: { secret: SECRET } }),
    }));
    expect(calls).toEqual(["apply", "release"]);
    const steps = report.scenarios[0]!.steps;
    // The model's read and its verdict. Never apply/release, and not the setup snapshot.
    expect(steps.map((s) => s.tool)).toEqual(["browse_read", "qa_verdict"]);
    expect(steps.map((s) => s.index)).toEqual([1, 2]);
    expect(steps.every((s) => s.ok)).toBe(true);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it("marks a step with an error result as not ok", async () => {
    const { report } = await run([scenario("a")], readThenVerdict("pass"), () => ({ read: async () => ({ error: "page is gone" }) }));
    expect(report.scenarios[0]!.steps.find((s) => s.tool === "browse_read")).toMatchObject({ ok: false, error: "page is gone" });
  });

  it("the pre-open of the start url is not a step", async () => {
    const { report } = await run([scenario("a", { url: "https://a.test/" })], readThenVerdict("pass"));
    expect(report.scenarios[0]!.steps.map((s) => s.tool)).toEqual(["browse_read", "qa_verdict"]);
  });

  it("records the args the model gave, not the bridge calls", async () => {
    const { report } = await run([scenario("a")], (_g, n) => (n === 0 ? { calls: [{ name: "browse_open", input: { url: "https://b.test/" } }] } : n === 1 ? verdictStep("pass", "fine") : { text: "ok" }));
    expect(report.scenarios[0]!.steps).toMatchObject([
      { index: 1, tool: "browse_open", args: { url: "https://b.test/" }, ok: true },
      { index: 2, tool: "qa_verdict", args: { verdict: "pass", reason: "fine" }, ok: true },
    ]);
  });

  it("a second verdict is refused before it runs, so it is not a step", async () => {
    const model = scriptedModel((_g, n) => (n === 0 ? verdictStep("pass") : n === 1 ? verdictStep("fail") : { text: "x" }), ["goal a"]);
    const f = browserFactory();
    const report = await runQaSuite([scenario("a")], { model, openBrowser: f.openBrowser });
    expect(report.scenarios[0]!.steps.map((s) => [s.tool, s.ok])).toEqual([["qa_verdict", true]]);
    expect(report.scenarios[0]!.outcome).toBe("passed");
  });

  it("a verdict with an empty reason is an error and does not use up the one verdict", async () => {
    const model = scriptedModel((_g, n) => (n === 0 ? verdictStep("pass", "   ") : n === 1 ? verdictStep("fail", "real reason") : { text: "x" }), ["goal a"]);
    const f = browserFactory();
    const report = await runQaSuite([scenario("a")], { model, openBrowser: f.openBrowser });
    expect(report.scenarios[0]).toMatchObject({ outcome: "failed", verdictReason: "real reason" });
    // The AI SDK rejects the bad input before the tool runs, so only the good call is a step.
    expect(report.scenarios[0]!.steps.map((s) => s.ok)).toEqual([true]);
  });

  it("cuts a long typed text to 200 chars in the step args", async () => {
    const long = "x".repeat(500);
    const { report } = await run([scenario("a")], (_g, n) => (n === 0 ? { calls: [{ name: "browse_act", input: { action: "type", target: "#q", text: long } }] } : n === 1 ? verdictStep("pass") : { text: "ok" }));
    const act = report.scenarios[0]!.steps.find((s) => s.tool === "browse_act")!;
    expect((act.args as { text: string }).text).toHaveLength(200);
  });
});

describe("runQaSuite: final screenshot", () => {
  it("parses a data URL into mediaType and base64", async () => {
    const { report } = await run([scenario("a")], readThenVerdict("pass"), () => ({ screenshot: async () => ({ imageData: `data:image/png;base64,${PNG}`, width: 1, height: 1 }) }));
    expect(report.scenarios[0]!.screenshot).toEqual({ mediaType: "image/png", base64: PNG });
  });

  it("an unknown format gives no screenshot, not a mislabeled jpeg", async () => {
    const gif = `R0lGODlh${"A".repeat(120)}`;
    const { report } = await run([scenario("a")], readThenVerdict("pass"), () => ({ screenshot: async () => ({ imageData: gif }) }));
    expect(report.scenarios[0]!.screenshot).toBeUndefined();
    const junk = await run([scenario("a")], readThenVerdict("pass"), () => ({ screenshot: async () => ({ imageData: "short" }) }));
    expect(junk.report.scenarios[0]!.screenshot).toBeUndefined();
  });

  it("sniffs jpeg and webp from bare base64", async () => {
    const jpg = `/9j/${"A".repeat(120)}`;
    const webp = `UklGR${"A".repeat(120)}`;
    expect((await run([scenario("a")], readThenVerdict("pass"), () => ({ screenshot: async () => ({ imageData: jpg }) }))).report.scenarios[0]!.screenshot).toEqual({ mediaType: "image/jpeg", base64: jpg });
    expect((await run([scenario("a")], readThenVerdict("pass"), () => ({ screenshot: async () => ({ imageData: webp }) }))).report.scenarios[0]!.screenshot).toEqual({ mediaType: "image/webp", base64: webp });
  });

  it("is not taken after a timeout (the controller may still hold its lock)", async () => {
    const { MockLanguageModelV3 } = await import("ai/test");
    const model = new MockLanguageModelV3({
      doGenerate: async (o: { abortSignal?: AbortSignal }) => new Promise((_r, reject) => o.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) as never,
    });
    let shots = 0;
    const f = browserFactory(() => ({ screenshot: async () => { shots++; return { imageData: PNG }; } }));
    const report = await runQaSuite([scenario("a")], { model, openBrowser: f.openBrowser, agent: { deadlineMs: 20 } });
    expect(report.scenarios[0]).toMatchObject({ outcome: "error", status: "timeout", error: "deadline reached" });
    expect(shots).toBe(0);
  });

  it("takes bare base64 too (the Playwright target) and guesses the type", async () => {
    const { report } = await run([scenario("a")], readThenVerdict("pass"), () => ({ screenshot: async () => ({ imageData: PNG }) }));
    expect(report.scenarios[0]!.screenshot).toEqual({ mediaType: "image/png", base64: PNG });
  });

  it("is taken after the run, before close, and not recorded as a step", async () => {
    const order: string[] = [];
    const f = browserFactory(() => ({ screenshot: async () => { order.push("shot"); return { imageData: PNG }; } }));
    const close = f.openBrowser;
    const model = scriptedModel(readThenVerdict("pass"), ["goal a"]);
    const report = await runQaSuite([scenario("a")], {
      model,
      openBrowser: async (s) => {
        const b = await close(s);
        const c = b.close;
        b.close = async () => { order.push("close"); await c(); };
        return b;
      },
    });
    expect(order).toEqual(["shot", "close"]);
    expect(report.scenarios[0]!.steps.map((s) => s.tool)).not.toContain("browse_screenshot");
  });

  it("failures and junk are ignored", async () => {
    const throwing = await run([scenario("a")], readThenVerdict("pass"), () => ({ screenshot: async () => { throw new Error("no gpu"); } }));
    expect(throwing.report.scenarios[0]!.screenshot).toBeUndefined();
    expect(throwing.report.scenarios[0]!.outcome).toBe("passed");
    const junk = await run([scenario("a")], readThenVerdict("pass"), () => ({ screenshot: async () => ({ error: "nope" }) }));
    expect(junk.report.scenarios[0]!.screenshot).toBeUndefined();
  });

  it("is bounded to 10 s", async () => {
    const { vi } = await import("vitest");
    vi.useFakeTimers();
    try {
      const f = browserFactory(() => ({ screenshot: () => new Promise(() => {}) }));
      const model = scriptedModel(readThenVerdict("pass"), ["goal a"]);
      const p = runQaSuite([scenario("a")], { model, openBrowser: f.openBrowser });
      await vi.advanceTimersByTimeAsync(10_001);
      const report = await p;
      expect(report.scenarios[0]).toMatchObject({ outcome: "passed" });
      expect(report.scenarios[0]!.screenshot).toBeUndefined();
      expect(f.state.closed).toEqual(["a"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runQaSuite: clock", () => {
  it("uses the now seam for times", async () => {
    let t = 1_000;
    const { report } = await run([scenario("a")], readThenVerdict("pass"), undefined, { now: () => (t += 10) });
    expect(report.startedAt).toBe(new Date(1_010).toISOString());
    expect(report.durationMs).toBeGreaterThan(0);
    expect(report.scenarios[0]!.startedAt).toMatch(/^1970-01-01T/);
  });
});
