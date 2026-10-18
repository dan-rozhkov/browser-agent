import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as sessionEntry from "../../src/agent/sessionEntry.js";
import { qaVerdictSchema } from "../../src/agent/qa.js";

// `agent/session` is the entry a browser bundle uses. Its JS (the TypeScript
// output of its import graph) must not reach zod, the schemas or the
// descriptions.
const dir = join(import.meta.dirname, "../../src/agent");

function importsOf(file: string): string[] {
  const js = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return [...js.matchAll(/(?:^|\n)\s*(?:import|export)\s[^"';]*?from\s*"([^"]+)"|import\s*"([^"]+)"/g)].map((m) => m[1] ?? m[2]);
}

function graph(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const walk = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const spec of importsOf(file)) {
      if (!spec.startsWith(".")) {
        bare.add(spec);
        continue;
      }
      walk(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
    }
  };
  walk(entry);
  return { files, bare };
}

describe("agent/session entry", () => {
  const { files, bare } = graph(join(dir, "sessionEntry.ts"));
  const names = [...files].map((f) => f.slice(dir.length + 1));

  it("imports nothing from outside the package", () => {
    expect([...bare]).toEqual([]);
  });

  it("does not reach zod, schemas, descriptions or tool definitions", () => {
    for (const banned of ["schemas.ts", "descriptions.ts", "tools.ts", "execute.ts", "prompt.ts", "aiSdk.ts"]) {
      expect(names, banned).not.toContain(banned);
    }
    expect(names).toContain("session.ts");
    expect(names).toContain("fixtureSetup.ts");
    expect(names).toContain("qaCore.ts");
  });

  it("exports the QA core", () => {
    for (const n of ["QA_VERDICT_TOOL", "QA_PRINCIPAL", "QA_PROMPT_SECTION", "QA_IRREVERSIBLE_LINE", "QA_AGENT_CLOSING", "QA_VERDICT_FIELD", "qaVerdictHooks", "executeQaVerdict", "qaOutcome", "qaResultOf", "createStepRecorder", "QA_ASSERT_TOOL", "parseQaChecks", "evaluateQaChecks", "executeQaAssert", "runFinalChecks", "applyFinalChecks"]) {
      expect(sessionEntry, n).toHaveProperty(n);
    }
    expect(sessionEntry).not.toHaveProperty("qaVerdictSchema");
    expect(sessionEntry).not.toHaveProperty("qaAssertDefinition");
  });

  it("a successful qa_verdict ends the run: continueRequest is false; a failed one does not", async () => {
    const { createBrowseAgentSession, qaVerdictHooks, executeQaVerdict } = sessionEntry;
    const s = createBrowseAgentSession({ extraTools: { qa_verdict: { ...qaVerdictHooks() } }, executeTool: async (c) => executeQaVerdict(c.input) });
    await s.runTool({ toolName: "qa_verdict", input: { verdict: "maybe", reason: "x" }, toolCallId: "1" });
    expect(s.continueRequest()).toBe(true);
    await s.runTool({ toolName: "qa_verdict", input: { verdict: "fail", reason: "broken" }, toolCallId: "2" });
    expect(s.continueRequest()).toBe(false);
  });

  it("the run stays ended after a guard-refused second verdict, with no extra step", async () => {
    const { createBrowseAgentSession, qaVerdictHooks, executeQaVerdict } = sessionEntry;
    const s = createBrowseAgentSession({ extraTools: { qa_verdict: qaVerdictHooks() }, executeTool: async (c) => executeQaVerdict(c.input) });
    await s.runTool({ toolName: "qa_verdict", input: { verdict: "pass", reason: "ok" }, toolCallId: "1" });
    expect(await s.runTool({ toolName: "qa_verdict", input: { verdict: "fail", reason: "x" }, toolCallId: "2" })).toContain("already called");
    expect(s.continueRequest()).toBe(false);
    expect(s.steps).toBe(1);
  });

  it("a verdict at the request cap ends the run as done, not step_limit", async () => {
    const { createBrowseAgentSession, qaVerdictHooks, executeQaVerdict } = sessionEntry;
    const s = createBrowseAgentSession({ maxRequests: 1, extraTools: { qa_verdict: qaVerdictHooks() }, executeTool: async (c) => executeQaVerdict(c.input) });
    const driver = {
      send: async () => {
        await s.runTool({ toolName: "qa_verdict", input: { verdict: "pass", reason: "ok" }, toolCallId: "1" });
        s.continueRequest();
      },
      stop() {},
      messages: () => [],
    };
    expect((await s.run("goal", driver)).status).toBe("done");
  });

  it("endsRun survives a fork (the session forks the hooks)", async () => {
    const { createBrowseAgentSession, singleUseTool } = sessionEntry;
    const hooks = singleUseTool({ name: "t", isSuccess: (p) => p.ok === true, endsRun: true });
    const s = createBrowseAgentSession({ extraTools: { t: hooks }, executeTool: async () => '{"ok":true}' });
    await s.runTool({ toolName: "t", input: {}, toolCallId: "1" });
    expect(s.continueRequest()).toBe(false);
    // The shared hooks object is untouched: a new session starts open.
    const s2 = createBrowseAgentSession({ extraTools: { t: hooks }, executeTool: async () => '{"ok":false}' });
    await s2.runTool({ toolName: "t", input: {}, toolCallId: "1" });
    expect(s2.continueRequest()).toBe(true);
  });

  it("the hand check of qa_verdict agrees with qaVerdictSchema", () => {
    const inputs: unknown[] = [
      { verdict: "pass", reason: " ok " }, { verdict: "fail", reason: "x".repeat(500) }, { verdict: "fail", reason: "x".repeat(501) },
      { verdict: "pass", reason: "   " }, { verdict: "maybe", reason: "x" }, { verdict: "pass" }, { reason: "x" },
      { verdict: "pass", reason: 5 }, null, "pass", [], undefined,
    ];
    for (const input of inputs) {
      const ok = JSON.parse(sessionEntry.executeQaVerdict(input)).ok === true;
      expect(ok, JSON.stringify(input)).toBe(qaVerdictSchema.safeParse(input).success);
    }
  });

  it("the package maps the subpath to the built entry", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf8"));
    expect(pkg.exports["./agent/session"].default).toBe("./dist/agent/sessionEntry.js");
    expect(pkg.typesVersions["*"]["agent/session"]).toEqual(["dist/agent/sessionEntry.d.ts"]);
  });

  it("the built JS, when present, imports no zod", () => {
    const built = join(import.meta.dirname, "../../dist/agent");
    const entry = join(built, "sessionEntry.js");
    if (!existsSync(entry)) return;
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const js = readFileSync(file, "utf8");
      for (const m of js.matchAll(/from\s*"([^"]+)"/g)) {
        expect(m[1], file).not.toMatch(/zod/);
        if (m[1].startsWith(".")) walk(resolve(dirname(file), m[1]));
      }
    };
    walk(entry);
    expect([...seen].map((f) => f.slice(built.length + 1))).not.toContain("schemas.js");
    expect([...seen].map((f) => f.slice(built.length + 1))).not.toContain("descriptions.js");
  });
});
