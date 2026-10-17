// Run QA scenarios with a real model, each in its own browser context. The parallelism
// (a small pool, written here) is this script's own: the package runs ONE scenario per
// runBrowseAgent call:
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
import { runBrowseAgent } from "../src/agent/aiSdk.js";
import type { PageFixture } from "../src/fixture/index.js";

interface QaScenario {
  id: string;
  title?: string;
  goal: string;
  url?: string;
  fixture?: PageFixture;
  allowNetworkMocks?: boolean;
}

/** Run `fn` over `items` with at most `limit` at once. Results keep the input order. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

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
  const ids = scenarios.map((s) => s.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup !== undefined) {
    console.error(`duplicate scenario id "${dup}"`);
    process.exit(1);
  }
  const concurrency = process.env.CONCURRENCY === undefined ? 3 : Number(process.env.CONCURRENCY);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    console.error(`CONCURRENCY must be an integer of at least 1 (got "${process.env.CONCURRENCY}")`);
    process.exit(1);
  }
  const openrouter = createOpenAICompatible({ name: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKey });
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== "0" });
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());
  try {
    const open = playwrightContexts(browser);
    const model = openrouter(process.env.AGENT_MODEL ?? "deepseek/deepseek-v4.1-flash");
    const results = await pool(scenarios, concurrency, async (sc) => {
      // A failure of one scenario (also opening its browser) is that scenario's error line, not a pool rejection.
      let opened: Awaited<ReturnType<typeof open>> | undefined;
      try {
        opened = await open();
        const result = await runBrowseAgent(sc.goal, {
          model,
          browser: opened.browser,
          ...(sc.url !== undefined ? { url: sc.url } : {}),
          ...(sc.fixture !== undefined ? { fixture: sc.fixture } : {}),
          ...(sc.allowNetworkMocks !== undefined ? { allowNetworkMocks: sc.allowNetworkMocks } : {}),
          runId: sc.id,
          signal: abort.signal,
          // The fast mode needs reasoning OFF (see run-agent.ts).
          providerOptions: { openrouter: { reasoning: { effort: "none" } } },
          qa: true,
        });
        const outcome = result.qa?.outcome ?? "error";
        console.log(`${outcome.padEnd(12)} ${sc.id}  ${result.qa?.reason ?? result.error ?? result.answer.slice(0, 120)}`);
        return outcome;
      } catch (e) {
        console.log(`${"error".padEnd(12)} ${sc.id}  ${e instanceof Error ? e.message : String(e)}`);
        return "error";
      } finally {
        await opened?.close().catch(() => undefined);
      }
    });
    process.exitCode = results.every((o) => o === "passed") ? 0 : 1;
  } finally {
    await browser.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
