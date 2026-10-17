/**
 * Live smoke test of the QA suite in a real Chromium. No API keys, no network:
 * a local HTTP server, a real browser, and a model scripted per scenario.
 * Three scenarios run in parallel, each in its own browser context:
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
import { runQaSuite, type QaScenario } from "../src/qa/index.js";

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
const scenarios: QaScenario[] = [
  { id: "alpha", title: "Settings is visible", goal: "[scenario alpha] Open the account page and check the Settings button.", fixture: { ...cookieFixture("alpha"), expect: { selector: "#who" } } },
  { id: "beta", title: "Checkout is visible", goal: "[scenario beta] Open the account page and check the Checkout button.", fixture: { ...cookieFixture("beta"), expect: { selector: "#who" } } },
  { id: "gamma", title: "Broken fixture", goal: "[scenario gamma] This never runs.", fixture: { ...cookieFixture("gamma"), expect: { selector: "#no-such-element", timeoutMs: 1000 } } },
];

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${JSON.stringify(detail)}`}`);
}

const browser = await chromium.launch();
try {
  const open = playwrightContexts(browser);
  const report = await runQaSuite(scenarios, { model, openBrowser: open, concurrency: 3 });
  const byId = Object.fromEntries(report.scenarios.map((s) => [s.id, s]));

  check("three scenarios in input order", report.scenarios.map((s) => s.id).join() === "alpha,beta,gamma", report.scenarios.map((s) => s.id));
  check("alpha passed", byId.alpha?.outcome === "passed", byId.alpha);
  check("beta failed with a reason", byId.beta?.outcome === "failed" && !!byId.beta.verdictReason, byId.beta);
  check("gamma setup_failed at stage expect", byId.gamma?.outcome === "setup_failed" && byId.gamma.setupStage === "expect", byId.gamma);
  check("summary counts", report.summary.total === 3 && report.summary.passed === 1 && report.summary.failed === 1 && report.summary.setup_failed === 1, report.summary);
  check("concurrency 3", report.concurrency === 3, report.concurrency);
  check("alpha and beta ran at the same time", bothArrived);

  // Isolation: each model saw only its own cookie, and the server never got a mixed cookie header.
  const alphaSeen = seenByModel.get("alpha") ?? "";
  const betaSeen = seenByModel.get("beta") ?? "";
  check("alpha saw its own cookie only", alphaSeen.includes("cookie: who=alpha") && !alphaSeen.includes("who=beta") && !alphaSeen.includes("who=gamma"));
  check("beta saw its own cookie only", betaSeen.includes("cookie: who=beta") && !betaSeen.includes("who=alpha") && !betaSeen.includes("who=gamma"));
  const sorted = [...new Set(cookieLog)].sort();
  check("server got exactly three separate cookies", sorted.join("|") === "who=alpha|who=beta|who=gamma", sorted);

  check("alpha steps recorded (read, no fixture data)", byId.alpha!.steps.some((s) => s.tool === "browse_read") && !JSON.stringify(byId.alpha!.steps).includes("who"), byId.alpha!.steps);
  check("alpha has a final screenshot", !!byId.alpha?.screenshot && byId.alpha.screenshot.base64.length > 100, byId.alpha?.screenshot?.mediaType);
  check("gamma has no screenshot", !byId.gamma?.screenshot);

  check("beta has a final screenshot", !!byId.beta?.screenshot);
  check("the report holds no fixture data (cookie name and value)", !JSON.stringify(report).includes("who=") && !JSON.stringify(report).includes('"who"'));
  check("steps are tool calls of the model", byId.alpha!.steps.map((s) => s.tool).join() === "browse_read,qa_verdict", byId.alpha!.steps.map((s) => s.tool));
} finally {
  await browser.close();
  server.close();
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exitCode = failed ? 1 : 0;
