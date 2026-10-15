import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

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
