// Run QA scenarios in parallel with a real model, each in its own browser context:
//   OPENROUTER_API_KEY=... npx tsx examples/qa-suite.ts examples/qa-scenarios.example.json
//
// Env:
//   OPENROUTER_API_KEY  required
//   AGENT_MODEL         optional; OpenRouter model id, default "deepseek/deepseek-v4.1-flash"
//   CONCURRENCY         optional; parallel scenarios, default 3
//   HEADLESS=0          show the browser windows
// It prints one line per scenario. The package returns the report object; what to do with it is up to the host.
// The exit code is 1 when any scenario did not pass.
import { readFileSync } from "node:fs";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { chromium } from "playwright-core";
import { playwrightContexts } from "../src/adapters/playwright.js";
import { parsePageFixture } from "../src/fixture/index.js";
import { runQaSuite, type QaScenario } from "../src/qa/index.js";

/** Read the scenarios file. A fixture is checked with `parsePageFixture`. */
function loadScenarios(path: string): QaScenario[] {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) throw new Error(`${path}: expected a JSON array of scenarios`);
  return raw.map((entry: QaScenario) => {
    if (entry.fixture === undefined) return entry;
    const parsed = parsePageFixture(entry.fixture);
    if (!parsed.ok) throw new Error(`${path}: scenario "${entry.id}": ${parsed.error}`);
    return { ...entry, fixture: parsed.value };
  });
}

async function main(): Promise<void> {
  const [scenariosPath] = process.argv.slice(2);
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!scenariosPath || !apiKey) {
    console.error("usage: OPENROUTER_API_KEY=... npx tsx examples/qa-suite.ts <scenarios.json>");
    process.exit(1);
  }
  const scenarios = loadScenarios(scenariosPath);
  const openrouter = createOpenAICompatible({ name: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKey });
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== "0" });
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());
  try {
    const report = await runQaSuite(scenarios, {
      model: openrouter(process.env.AGENT_MODEL ?? "deepseek/deepseek-v4.1-flash"),
      openBrowser: playwrightContexts(browser),
      concurrency: Number(process.env.CONCURRENCY) || 3,
      signal: abort.signal,
      // The fast mode needs reasoning OFF (see run-agent.ts).
      providerOptions: { openrouter: { reasoning: { effort: "none" } } },
      onScenarioDone: (s) => console.log(`${s.outcome.padEnd(12)} ${s.id}${s.verdictReason ? `  ${s.verdictReason}` : ""}`),
    });
    console.log(`\n${JSON.stringify(report.summary)}`);
    for (const s of report.scenarios) console.log(`${s.outcome.padEnd(12)} ${s.id}  ${s.verdictReason || s.error || s.answer.slice(0, 120)}`);
    process.exitCode = report.summary.passed === report.summary.total ? 0 : 1;
  } finally {
    await browser.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
