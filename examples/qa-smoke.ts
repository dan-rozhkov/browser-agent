/**
 * Live smoke test of the QA mode (`runBrowseAgent({ qa })`) in a real Chromium. No API keys, no network:
 * a local HTTP server, a real browser, and a model scripted per scenario.
 * The parallelism is this script's own: Promise.all over three runs, each in its own browser context:
 *   alpha  passes, beta fails, gamma has a fixture whose `expect` fails (setup_failed).
 * Each one sets its own cookie through its fixture and must never see another's.
 *
 *   npm run qa-smoke
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright-core";
import { MockLanguageModelV3 } from "ai/test";
import { playwrightContexts } from "../src/adapters/playwright.js";
import { runBrowseAgent } from "../src/agent/aiSdk.js";
import type { PageFixture } from "../src/fixture/index.js";

// The server prints the cookie header it got, and logs every one.
const cookieLog: string[] = [];
const server = createServer((req, res) => {
  const cookie = req.headers.cookie ?? "";
  if (req.url?.startsWith("/whoami")) cookieLog.push(cookie);
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><title>Who</title><h1>Account</h1><p id="who">cookie: ${cookie || "none"}</p><button type="button">Settings</button>`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 4, text: 4, reasoning: undefined },
};

/** What each scripted model saw in its browse_read result. */
const seenByModel = new Map<string, string>();
/** Both model-driven scenarios wait here for each other: this proves they run at the same time. */
let waiting = 0;
let bothArrived = false;
let release!: () => void;
const gate = new Promise<void>((r) => { release = r; });
async function barrier(): Promise<void> {
  waiting++;
  if (waiting === 2) { bothArrived = true; release(); }
  await Promise.race([gate, new Promise((r) => setTimeout(r, 10_000))]);
}

/** A model that finds out its scenario from the goal text in the prompt, then plays that scenario's script. */
const model = new MockLanguageModelV3({
  doGenerate: async (options: { prompt?: unknown }) => {
    const prompt = JSON.stringify(options.prompt);
    // Only what the tools returned (the goal text names the button too).
    const toolText = JSON.stringify((options.prompt as { role: string }[]).filter((m) => m.role === "tool"));
    const id = ["alpha", "beta", "gamma"].find((n) => prompt.includes(`[scenario ${n}]`)) ?? "unknown";
    const toolMessages = (options.prompt as { role: string }[]).filter((m) => m.role === "tool").length;
    const call = (name: string, input: unknown) => ({
      finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
      usage,
      warnings: [] as never[],
      content: [{ type: "tool-call", toolCallId: `${id}-${toolMessages}`, toolName: name, input: JSON.stringify(input) }],
    });
    if (toolMessages === 0) {
      await barrier();
      return call("browse_read", {}) as never;
    }
    if (toolMessages === 1) {
      seenByModel.set(id, toolText);
      const expectedButton = id === "alpha" ? "Settings" : "Checkout";
      const found = toolText.includes(expectedButton) && toolText.includes(`cookie: who=${id}`);
      return call("qa_verdict", found ? { verdict: "pass", reason: `The page shows the ${expectedButton} button for ${id}.` } : { verdict: "fail", reason: `There is no ${expectedButton} button on the account page.` }) as never;
    }
    return { finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] as never[], content: [{ type: "text", text: `Finished ${id}.` }] } as never;
  },
});

const cookieFixture = (id: string) => ({ version: 1 as const, fresh: true, storage: { cookies: [{ name: "who", value: id, url: base }] }, url: `${base}/whoami` });
interface Scenario {
  id: string;
  goal: string;
  fixture: PageFixture;
}
const scenarios: Scenario[] = [
  { id: "alpha", goal: "[scenario alpha] Open the account page and check the Settings button.", fixture: { ...cookieFixture("alpha"), expect: { selector: "#who" } } },
  { id: "beta", goal: "[scenario beta] Open the account page and check the Checkout button.", fixture: { ...cookieFixture("beta"), expect: { selector: "#who" } } },
  { id: "gamma", goal: "[scenario gamma] This never runs.", fixture: { ...cookieFixture("gamma"), expect: { selector: "#no-such-element", timeoutMs: 1000 } } },
];

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${JSON.stringify(detail)}`}`);
}

const browser = await chromium.launch();
try {
  const open = playwrightContexts(browser);
  const shots = new Map<string, { mediaType: string; base64: string }>();
  let maxOpen = 0;
  let nowOpen = 0;
  // One run per scenario, each in a new isolated context. The consumer decides how many run at once.
  const results = await Promise.all(
    scenarios.map(async (sc) => {
      const opened = await open();
      nowOpen++;
      maxOpen = Math.max(maxOpen, nowOpen);
      try {
        return await runBrowseAgent(sc.goal, {
          model,
          browser: opened.browser,
          fixture: sc.fixture,
          runId: sc.id,
          qa: { onScreenshot: (img) => { shots.set(sc.id, img); } },
        });
      } finally {
        nowOpen--;
        await opened.close();
      }
    }),
  );
  const byId = Object.fromEntries(scenarios.map((sc, i) => [sc.id, results[i]!]));
  const qa = (id: string) => byId[id]!.qa!;

  check("three runs, three results", results.length === 3);
  check("alpha passed", qa("alpha").outcome === "passed", byId.alpha);
  check("beta failed with a reason", qa("beta").outcome === "failed" && !!qa("beta").reason, byId.beta);
  check("gamma setup_failed at stage expect", qa("gamma").outcome === "setup_failed" && byId.gamma!.setupStage === "expect", byId.gamma);
  check("alpha and beta ran at the same time", bothArrived);
  check("three contexts were open at once or overlapped", maxOpen >= 2, maxOpen);

  // Isolation: each model saw only its own cookie, and the server never got a mixed cookie header.
  const alphaSeen = seenByModel.get("alpha") ?? "";
  const betaSeen = seenByModel.get("beta") ?? "";
  check("alpha saw its own cookie only", alphaSeen.includes("cookie: who=alpha") && !alphaSeen.includes("who=beta") && !alphaSeen.includes("who=gamma"));
  check("beta saw its own cookie only", betaSeen.includes("cookie: who=beta") && !betaSeen.includes("who=alpha") && !betaSeen.includes("who=gamma"));
  const sorted = [...new Set(cookieLog)].sort();
  check("server got exactly three separate cookies", sorted.join("|") === "who=alpha|who=beta|who=gamma", sorted);

  check("alpha steps are the model's tool calls", qa("alpha").steps.map((s) => s.tool).join() === "browse_read,qa_verdict", qa("alpha").steps);
  check("screenshots came through the callback for alpha and beta, not gamma", shots.has("alpha") && shots.has("beta") && !shots.has("gamma") && shots.get("alpha")!.base64.length > 100, [...shots.keys()]);
  const text = JSON.stringify(results);
  check("the results hold no base64 and no fixture data", !text.includes("base64") && !text.includes(shots.get("alpha")!.base64.slice(0, 40)) && !text.includes("who=") && !text.includes('"who"'));
  check("a result is JSON with qa before error", Object.keys(byId.gamma!).join() === "status,answer,steps,qa,error,setupStage", Object.keys(byId.gamma!));
} finally {
  await browser.close();
  server.close();
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exitCode = failed ? 1 : 0;
