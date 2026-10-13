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
import { z } from "zod";
import { chromium } from "playwright-core";
import { connectOverCdp, PlaywrightTarget } from "../src/adapters/playwright.js";
import { createSystemOneClient } from "../src/adapters/systemoneHttp.js";
import { controllerBridge } from "../src/adapters/controllerBridge.js";
import { createLocalBackend } from "../src/adapters/localBackend.js";
import { BrowserController } from "../src/controller/index.js";
import { memoryStorage, runBrowseTask } from "../src/loop/index.js";
import { TextModelInvalidObjectError, type TextModel, type TextModelMessage } from "../src/policy/index.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return v;
}

/**
 * A minimal `TextModel` over OpenRouter's chat completions endpoint (JSON
 * mode + zod validation). With the AI SDK installed you would rather use
 * `aiSdkTextModel(openrouter("..."))` from `adapters/ai-sdk`.
 */
function openRouterTextModel(apiKey: string, id: string): TextModel {
  return {
    id,
    async generateObject<T>(req: { schema: z.ZodType<T>; prompt: string | TextModelMessage[]; abortSignal?: AbortSignal }) {
      const messages =
        typeof req.prompt === "string" ? [{ role: "user", content: req.prompt }] : req.prompt;
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: id, messages, response_format: { type: "json_object" } }),
        signal: req.abortSignal,
      });
      if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = json.choices?.[0]?.message?.content ?? "";
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (cause) {
        throw new TextModelInvalidObjectError("model did not return JSON", { cause });
      }
      const parsed = req.schema.safeParse(raw);
      if (!parsed.success) throw new TextModelInvalidObjectError(parsed.error.message);
      return {
        object: parsed.data,
        usage: { inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens },
      };
    },
  };
}

async function openBrowser(): Promise<{ controller: BrowserController; close(): Promise<void> }> {
  const cdpUrl = process.env.CDP_URL;
  if (cdpUrl) return connectOverCdp(cdpUrl);
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== "0" });
  const context = await browser.newContext();
  return {
    controller: new BrowserController(new PlaywrightTarget(context)),
    close: () => browser.close(),
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

  const { controller, close } = await openBrowser();
  try {
    const transcript = await runBrowseTask(goal, {
      browser: controllerBridge(controller),
      backend: createLocalBackend(policy),
      storage: memoryStorage(),
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
