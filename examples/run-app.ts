// Drive an Electron desktop app with the browse agent:
//   APP=/Applications/Orca.app OPENROUTER_API_KEY=... npx tsx examples/run-app.ts "<goal>"
//
// Env:
//   APP                 required; a macOS .app bundle or an executable path
//   OPENROUTER_API_KEY  required
//   AGENT_MODEL         optional; OpenRouter model id, default "deepseek/deepseek-v4.1-flash"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { runBrowseAgent } from "../src/agent/aiSdk.js";
import { launchElectronApp } from "../src/adapters/electron.js";

async function main(): Promise<void> {
  const goal = process.argv.slice(2).join(" ").trim();
  const apiKey = process.env.OPENROUTER_API_KEY;
  const app = process.env.APP;
  if (!goal || !apiKey || !app) {
    console.error('usage: APP=/Applications/Foo.app OPENROUTER_API_KEY=... npx tsx examples/run-app.ts "<goal>"');
    process.exit(1);
  }
  const openrouter = createOpenAICompatible({ name: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKey });
  const started = Date.now();
  const electron = await launchElectronApp({ app });
  try {
    const result = await runBrowseAgent(goal, {
      model: openrouter(process.env.AGENT_MODEL ?? "deepseek/deepseek-v4.1-flash"),
      browser: electron.browser,
      // Host prompt text: the existing `sections` slot of the system prompt.
      prompt: {
        sections: [
          "You drive a desktop application, not a website. Each tab is a window of the app. Opening URLs and new tabs is off: use the elements in the snapshot. Native menus and file dialogs are not visible to you.",
        ],
      },
      // The same model routing as Pen Editor's browse subagent: BROWSE_AGENT_MODEL
      // with reasoning off, on Together first (OPENROUTER_PROVIDER_ORDER).
      providerOptions: {
        openrouter: { reasoning: { effort: "none" }, provider: { order: ["together"], allow_fallbacks: true } },
      },
    });
    console.log(JSON.stringify({ status: result.status, answer: result.answer, steps: result.steps, ms: Date.now() - started }, null, 2));
  } finally {
    await electron.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
