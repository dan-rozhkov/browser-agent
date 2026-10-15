// Run the fast browse agent (a non-reasoning chat model drives the browse tools):
//   OPENROUTER_API_KEY=... npx tsx examples/run-agent.ts "open example.com and read the main heading"
//
// Env:
//   OPENROUTER_API_KEY  required
//   AGENT_MODEL         optional; OpenRouter model id, default "deepseek/deepseek-v4.1-flash"
//   START_URL           optional; the browser opens it before the first request
//   CDP_URL             optional; attach to a running browser instead of launching one
//   HEADLESS=0          show the launched browser window
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { chromium } from "playwright-core";
import { runBrowseAgent } from "../src/agent/aiSdk.js";
import { connectOverCdp, PlaywrightTarget } from "../src/adapters/playwright.js";
import { controllerBridge } from "../src/adapters/controllerBridge.js";
import { BrowserController } from "../src/controller/index.js";

async function openBrowser(): Promise<{ controller: BrowserController; close(): Promise<void> }> {
  const cdpUrl = process.env.CDP_URL;
  if (cdpUrl) return connectOverCdp(cdpUrl);
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== "0" });
  const context = await browser.newContext();
  return { controller: new BrowserController(new PlaywrightTarget(context)), close: () => browser.close() };
}

async function main(): Promise<void> {
  const goal = process.argv.slice(2).join(" ").trim();
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!goal || !apiKey) {
    console.error('usage: OPENROUTER_API_KEY=... npx tsx examples/run-agent.ts "<goal>"');
    process.exit(1);
  }
  const openrouter = createOpenAICompatible({ name: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKey });
  const { controller, close } = await openBrowser();
  try {
    const result = await runBrowseAgent(goal, {
      model: openrouter(process.env.AGENT_MODEL ?? "deepseek/deepseek-v4.1-flash"),
      browser: controllerBridge(controller),
      url: process.env.START_URL,
      // The default: screenshot results are text only. @ai-sdk/openai-compatible
      // would print an image part as base64 text into every later request.
      // toolResultImages: true is only for providers that carry such images natively.
      // The fast mode needs reasoning OFF. OpenRouter reads this switch from the
      // provider options under the provider name ("openrouter").
      providerOptions: { openrouter: { reasoning: { effort: "none" } } },
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
