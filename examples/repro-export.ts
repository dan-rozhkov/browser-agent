// End-to-end check of the Playwright export (docs/specs/2026-10-26-playwright-spec-export-design.md),
// with no LLM key and no network: a scripted model drives the REAL agent loop (runBrowseAgent with
// `trace.repro`) in Chromium against a local cart page with a planted bug. The trace becomes a
// `.spec.ts`. With `--run <playwright CLI>` the spec then runs twice against the same page:
// buggy (it must fail on the failed check) and fixed (it must pass).
//   npx tsx examples/repro-export.ts [--out <dir>] [--run <path to node_modules/.bin/playwright> --cwd <dir with @playwright/test>]
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { chromium } from "playwright-core";
import { runBrowseAgent } from "../src/agent/aiSdk.js";
import { PlaywrightTarget } from "../src/adapters/playwright.js";
import { controllerBridge } from "../src/adapters/controllerBridge.js";
import { BrowserController } from "../src/controller/index.js";
import { browseTraceToPlaywrightSpec } from "../src/shared/playwrightSpec.js";
import type { BrowseTrace } from "../src/shared/trace.js";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

// ---------------------------------------------------------------- the app under test

let fixed = false;
const page = (): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>Tiny shop</title></head>
<body>
  <h1>Cart</h1>
  <label for="qty">Quantity</label> <input id="qty" type="number" value="1">
  <label for="pwd">Password</label> <input id="pwd" type="password">
  <button type="button" onclick="add()">Add to cart</button>
  <p id="items">Items: 0</p>
  <script>
    var items = 0;
    function add() {
      var qty = Number(document.getElementById("qty").value) || 0;
      items += ${fixed ? "qty" : "Math.max(qty - 1, 1)"}; // the planted bug: one item short
      document.getElementById("items").textContent = "Items: " + items;
    }
  </script>
</body></html>`;

const server = createServer((req, res) => {
  if (req.url === "/favicon.ico") return void res.writeHead(204).end();
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page());
});

// ---------------------------------------------------------------- scripted model

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 4, text: 4, reasoning: undefined },
};
type Step = { text?: string; calls?: { name: string; input: unknown }[] };

function scripted(steps: Step[]): MockLanguageModelV3 {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const step = steps[Math.min(i, steps.length - 1)]!;
      i += 1;
      const content: unknown[] = [];
      if (step.text) content.push({ type: "text", text: step.text });
      for (const [k, c] of (step.calls ?? []).entries()) {
        content.push({ type: "tool-call", toolCallId: `c${i}-${k}`, toolName: c.name, input: JSON.stringify(c.input) });
      }
      return {
        finishReason: step.calls?.length ? { unified: "tool-calls" as const, raw: "tool_calls" } : { unified: "stop" as const, raw: "stop" },
        usage,
        warnings: [] as never[],
        content,
      } as never;
    },
  });
}
const call = (name: string, input: Record<string, unknown>): Step => ({ calls: [{ name, input }] });

const SECRET = "hunter2-secret";
const STEPS: Step[] = [
  call("browse_act", { action: "type", target: "#qty", text: "2" }),
  call("browse_act", { action: "type", target: "#pwd", text: SECRET }),
  call("browse_act", { action: "click", target: "Add to cart" }),
  call("qa_assert", { checks: [{ type: "text", text: "Items: 2" }, { type: "url", contains: "127.0.0.1" }] }),
  call("qa_verdict", { verdict: "fail", reason: "Two items were added, the cart shows one." }),
  { text: "done" },
];

// ---------------------------------------------------------------- run

async function main(): Promise<void> {
  const out = resolve(arg("out") ?? "repro-export-out");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const browser = await chromium.launch({ headless: true });
  let trace: BrowseTrace | undefined;
  try {
    const context = await browser.newContext();
    const controller = new BrowserController(new PlaywrightTarget(context));
    const result = await runBrowseAgent("Add two items to the cart and check that the cart shows 2 items.", {
      model: scripted(STEPS),
      browser: controllerBridge(controller),
      url,
      qa: true,
      trace: { repro: true, dom: true, capture: false, onTrace: (t) => void (trace = t) },
    });
    console.log(`run: status ${result.status}, qa outcome ${result.qa?.outcome}`);
  } finally {
    await browser.close().catch(() => undefined);
  }
  if (!trace) throw new Error("no trace");
  const traceJson = JSON.stringify(trace, null, 2);
  writeFileSync(join(out, "trace.json"), traceJson);
  if (traceJson.includes(SECRET)) throw new Error("the typed secret is in the trace");
  // The failed qa_assert step keeps a DOM snapshot of the page as the run saw it (docs/specs/2026-10-26-trace-dom-snapshot-design.md).
  const dom = trace.doms?.[0];
  if (!dom || dom.kind !== "html") throw new Error("no html DOM snapshot for the failed check");
  const html = Buffer.from(dom.src.slice(dom.src.indexOf(",") + 1), "base64").toString("utf8");
  if (!html.includes("Items: 1")) throw new Error("the DOM snapshot does not show the bug");
  if (html.includes(SECRET)) throw new Error("the typed secret is in the DOM snapshot");
  writeFileSync(join(out, "dom-0.html"), html);
  console.log(`dom: step ${dom.stepIndex}, ${dom.bytes} bytes, shows "Items: 1", no secret`);
  const spec = browseTraceToPlaywrightSpec(trace);
  if (!spec.ok) throw new Error(spec.error);
  if (spec.code.includes(SECRET)) throw new Error("the typed secret is in the spec");
  writeFileSync(join(out, spec.fileName), spec.code);
  console.log(`spec: ${spec.fileName}, ${spec.actions} actions, ${spec.gaps} gaps, ${spec.failingChecks} failing checks\n`);
  console.log(spec.code);

  const cli = arg("run");
  if (cli) {
    const cwd = resolve(arg("cwd") ?? process.cwd());
    const dir = join(cwd, ".repro-export-run");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, spec.fileName), spec.code);
    writeFileSync(join(dir, "playwright.config.mjs"), `export default { testDir: ".", reporter: "list", use: { headless: true } };\n`);
    // Async on purpose: the page server lives in this process, so a blocking spawn would starve it.
    const runSpec = (label: string): Promise<number> =>
      new Promise((done) => {
        const child = spawn(cli, ["test", "--config", join(dir, "playwright.config.mjs")], { cwd, env: { ...process.env, QA_SECRET_1: SECRET } });
        let text = "";
        child.stdout.on("data", (d: Buffer) => (text += d.toString()));
        child.stderr.on("data", (d: Buffer) => (text += d.toString()));
        child.on("close", (code) => {
          console.log(`\n===== ${label}: exit ${code}\n${text}`);
          writeFileSync(join(out, `run-${label}.txt`), text);
          done(code ?? -1);
        });
      });
    // The page server serves the buggy page first, then the fixed one.
    const buggy = await runSpec("buggy");
    fixed = true;
    const fixedRun = await runSpec("fixed");
    rmSync(dir, { recursive: true, force: true });
    console.log(`\nbuggy exit ${buggy} (want 1), fixed exit ${fixedRun} (want 0)`);
    if (buggy === 0 || fixedRun !== 0) process.exitCode = 1;
  }
  server.close();
}

main().catch((e: unknown) => {
  console.error(e);
  server.close();
  process.exit(1);
});
