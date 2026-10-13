// Run one browse task end to end:
//   TYPESAFE_API_KEY=... OPENROUTER_API_KEY=... npm run example -- "open example.com and find the heading"
//
// Env:
//   TYPESAFE_API_KEY    required; System One (Jev) decisions
//   TYPESAFE_MODEL      optional; default "jev-latest" (an `openai/...` id routes to OpenRouter)
//   OPENROUTER_API_KEY  required; the two small text models (and Luna decisions)
//   STRUCTURED_MODEL    optional; OpenRouter model id for TYPE_TEXT / SELECT text
//   CASCADE_MODEL       optional; OpenRouter model id for the cascade, plan and field text
//   CDP_URL             optional; attach to a running browser instead of launching one
//   HEADLESS=0          show the launched browser window
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { chromium } from "playwright-core";
import { connectOverCdp, PlaywrightTarget } from "../src/adapters/playwright.js";
import { aiSdkTextModel } from "../src/adapters/aiSdk.js";
import { createSystemOneClient } from "../src/adapters/systemoneHttp.js";
import { controllerBridge } from "../src/adapters/controllerBridge.js";
import { createLocalBackend } from "../src/adapters/localBackend.js";
import { BrowserController } from "../src/controller/index.js";
import { memoryStorage, runBrowseTask } from "../src/loop/index.js";
import type { TextModel } from "../src/policy/index.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return v;
}

/** OpenRouter through the AI SDK: `generateObject` sends the schema (as a
 * structured-output `json_schema` response format), so replies validate. */
function openRouterTextModel(apiKey: string, id: string): TextModel {
  const openrouter = createOpenAICompatible({
    name: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKey,
    supportsStructuredOutputs: true,
  });
  return aiSdkTextModel(openrouter(id));
}

async function openBrowser(): Promise<{ controller: BrowserController; close(): Promise<void>; cloud: boolean }> {
  const cdpUrl = process.env.CDP_URL;
  // A remote browser: cloud deadlines.
  if (cdpUrl) return { ...(await connectOverCdp(cdpUrl)), cloud: true };
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== "0" });
  const context = await browser.newContext();
  return {
    controller: new BrowserController(new PlaywrightTarget(context)),
    close: () => browser.close(),
    cloud: false,
  };
}

async function main(): Promise<void> {
  const goal = process.argv.slice(2).join(" ").trim();
  if (!goal) {
    console.error('usage: npm run example -- "<goal>"');
    process.exit(1);
  }
  const openRouterKey = requireEnv("OPENROUTER_API_KEY");
  const decisionModel = process.env.TYPESAFE_MODEL;
  const decisions = createSystemOneClient({
    apiKey: requireEnv("TYPESAFE_API_KEY"),
    ...(decisionModel ? { model: decisionModel } : {}),
    openRouterApiKey: openRouterKey,
  });
  const policy = {
    decisions,
    models: {
      structured: openRouterTextModel(openRouterKey, process.env.STRUCTURED_MODEL ?? "google/gemini-2.5-flash"),
      cascade: openRouterTextModel(openRouterKey, process.env.CASCADE_MODEL ?? "google/gemini-2.5-flash"),
    },
    ...(decisionModel ? { decisionModel } : {}),
  };

  const { controller, close, cloud } = await openBrowser();
  try {
    const transcript = await runBrowseTask(goal, {
      browser: controllerBridge(controller),
      backend: createLocalBackend(policy),
      storage: memoryStorage(),
      cloud,
    });
    console.log(JSON.stringify(transcript, null, 2));
  } finally {
    await close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
