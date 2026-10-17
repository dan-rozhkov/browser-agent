import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = join(import.meta.dirname, "../../src");

/** The local files `entry` imports, directly or not (relative imports, `.js` mapped to `.ts`). */
function localGraph(entry: string): Map<string, string> {
  const files = new Map<string, string>();
  const todo = [entry];
  while (todo.length) {
    const file = todo.pop()!;
    if (files.has(file)) continue;
    const source = readFileSync(file, "utf8");
    files.set(file, source);
    for (const m of source.matchAll(/(?:from|import)\s*\(?\s*"(\.[^"]+)"/g)) {
      const target = join(dirname(file), m[1]!.replace(/\.js$/, ".ts"));
      if (existsSync(target)) todo.push(target);
    }
  }
  return files;
}

// `src/qa` must not pull Playwright in (the helper is in adapters/playwright),
// and nothing in it may use node built-ins (the suite writes no files).
describe("src/qa import graph", () => {
  const dir = join(srcDir, "qa");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    it(`${file} does not import playwright or node built-ins`, () => {
      const source = readFileSync(join(dir, file), "utf8");
      expect(source).not.toMatch(/from "playwright/);
      expect(source).not.toMatch(/from "node:/);
    });
  }

  it("the qa barrel reaches no node: built-in and no playwright through any local import", () => {
    const graph = localGraph(join(dir, "index.ts"));
    expect(graph.size).toBeGreaterThan(5);
    for (const [file, source] of graph) {
      expect(source, file).not.toMatch(/from "node:|from "playwright/);
    }
  });
});
