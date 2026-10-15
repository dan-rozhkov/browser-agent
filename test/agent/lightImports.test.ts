import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Pen Editor's frontend contract tests import the backend tools.ts, which will
// import `@sideform/browser-agent/agent`. That graph must not reach `ai`.
describe("src/agent import graph", () => {
  const dir = join(import.meta.dirname, "../../src/agent");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "aiSdk.ts")) {
    it(`${file} does not import "ai" or node built-ins`, () => {
      const source = readFileSync(join(dir, file), "utf8");
      expect(source).not.toMatch(/from "ai"|from "ai\/|from "node:|from "playwright/);
    });
  }
});
