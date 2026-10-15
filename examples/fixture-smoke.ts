/**
 * Live smoke test of PageFixture + QA start in a real Chromium. No API keys, no network:
 * a local HTTP server, a real browser, and a model that fails the run if it is ever called.
 *
 *   npm run fixture-smoke
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright-core";
import { MockLanguageModelV3 } from "ai/test";
import { PlaywrightTarget } from "../src/adapters/playwright.js";
import { controllerBridge } from "../src/adapters/controllerBridge.js";
import { BrowserController } from "../src/controller/index.js";
import { runBrowseAgent } from "../src/agent/aiSdk.js";
import type { PageFixture } from "../src/fixture/index.js";

const CART_PAGE = `<!doctype html><title>Cart</title><h1>Cart</h1><p id="who"></p><p id="cart">loading</p>
<script>
  document.getElementById("who").textContent = "theme=" + localStorage.getItem("theme") + "; cookie=" + document.cookie;
  fetch("/api/cart").then((r) => r.json()).then((d) => { document.getElementById("cart").textContent = d.items.length + " items"; })
    .catch(() => { document.getElementById("cart").textContent = "api failed"; });
</script>`;

const server = createServer((req, res) => {
  if (req.url?.startsWith("/api/cart")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ items: [] })); // the real server: an empty cart
    return;
  }
  res.setHeader("content-type", "text/html");
  res.end(req.url?.startsWith("/cart") ? CART_PAGE : "<!doctype html><title>Home</title><h1>Home</h1>");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.newPage();
const controller = new BrowserController(new PlaywrightTarget(context), { cursor: false });
const pageText = async () => (await context.pages()[0]!.textContent("body"))?.replace(/\s+/g, " ").trim();

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${JSON.stringify(detail)}`}`);
}

const shop: PageFixture = {
  version: 1,
  storage: {
    cookies: [{ name: "session", value: "s3cret-cookie", url: base }],
    origins: [{ origin: base, localStorage: { theme: "dark" } }],
  },
  url: `${base}/cart`,
  network: [{ url: `${base}/api/cart*`, body: { items: [1, 2, 3] } }],
  expect: { text: "3 items", url: `${base}/cart*` },
};

try {
  // 1. Cookies + localStorage + start URL + network mock + expect, all together.
  const r1 = await controller.applyFixture(shop, { allowNetworkMocks: true });
  check("apply: ok", r1.ok, r1);
  const t1 = await pageText();
  check("page sees the mocked API (3 items)", !!t1?.includes("3 items"), t1);
  check("page sees localStorage theme=dark", !!t1?.includes("theme=dark"), t1);
  check("page sees the cookie", !!t1?.includes("session=s3cret-cookie"), t1);
  check("summary has no secrets", r1.ok && !r1.summary.includes("s3cret") && !r1.summary.includes("dark"), r1.ok && r1.summary);

  // 2. Capture gives the state back (for the host; it holds secrets).
  const cap = await controller.captureFixture();
  check("capture has the cookie and localStorage", cap.ok && JSON.stringify(cap.fixture).includes("s3cret-cookie") && JSON.stringify(cap.fixture).includes("dark"), cap);

  // 3. Release removes the mock: the real server answers again.
  await controller.releaseFixture(r1.ok ? r1.fixtureToken : undefined);
  await context.pages()[0]!.reload();
  await context.pages()[0]!.waitForFunction(() => document.getElementById("cart")?.textContent !== "loading");
  const t3 = await pageText();
  check("after release the real API answers (0 items)", !!t3?.includes("0 items"), t3);

  // 4. Network mocks without the host flag are refused.
  const r4 = await controller.applyFixture(shop);
  check("no allowNetworkMocks: stage network", !r4.ok && r4.stage === "network", r4);

  // 5. A failed expect is a setup failure, not an agent result.
  const r5 = await controller.applyFixture({ version: 1, url: `${base}/cart`, expect: { text: "no such text", timeoutMs: 1000 } });
  check("wrong expect: stage expect", !r5.ok && r5.stage === "expect", r5);

  // 6. fresh: cookies and localStorage are gone.
  const r6 = await controller.applyFixture({ version: 1, fresh: true, url: `${base}/cart`, expect: { text: "theme=null" } });
  const t6 = await pageText();
  check("fresh: storage and cookies cleared", r6.ok && !!t6?.includes("theme=null; cookie=") && !t6.includes("s3cret"), { r6, t6 });
  check("fresh: one tab left", context.pages().length === 1, context.pages().length);

  // 7. runBrowseAgent: a failed setup ends with setup_failed and the model is never called.
  let modelCalls = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => { modelCalls++; throw new Error("the model must not run"); },
    doStream: async () => { modelCalls++; throw new Error("the model must not run"); },
  });
  const r7 = await runBrowseAgent("buy the item", {
    model,
    browser: controllerBridge(controller),
    fixture: { version: 1, url: `${base}/cart`, expect: { selector: "#checkout", timeoutMs: 1000 } },
  });
  check("agent: status setup_failed, stage expect", r7.status === "setup_failed" && r7.setupStage === "expect", { status: r7.status, stage: r7.setupStage, error: r7.error });
  check("agent: the model was never called", modelCalls === 0, modelCalls);
} finally {
  await browser.close();
  server.close();
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exitCode = failed ? 1 : 0;
