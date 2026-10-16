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

const FORM_PAGE = `<!doctype html><title>Form</title><h1>Order</h1>
<input id="name" aria-label="Your name"><select id="size"><option value="s">Small</option><option value="l">Large</option></select>
<label><input type="checkbox" id="gift"> Gift</label>
<button id="add" type="button">Add to cart</button><p id="out"></p>
<script>
  document.getElementById("add").addEventListener("click", () => {
    localStorage.setItem("cart", (localStorage.getItem("cart") || "") + "x");
    document.getElementById("out").textContent = "cart=" + localStorage.getItem("cart");
  });
</script>`;

const SPA_PAGE = `<!doctype html><title>Spa</title><h1 id="route">list</h1>
<button id="open" type="button">Open details</button>
<div id="details" hidden><input id="note" aria-label="Note"></div>
<script>
  function show() { document.getElementById("route").textContent = "details"; document.getElementById("details").hidden = false; }
  document.getElementById("open").addEventListener("click", () => { history.pushState({}, "", "/spa/details"); show(); });
  if (location.pathname === "/spa/details") show();
</script>`;

const AUTO_PAGE = `<!doctype html><title>Auto</title>
<input id="city" aria-label="City" autocomplete="off"><div id="list"></div><p id="out"></p>
<script>
  const city = document.getElementById("city"), list = document.getElementById("list");
  city.addEventListener("input", () => {
    list.innerHTML = "";
    if (city.value.length < 2) return;
    setTimeout(() => { list.innerHTML = '<ul><li data-testid="opt-berlin">Berlin</li></ul>'; }, 400);
  });
  list.addEventListener("click", (e) => {
    if (e.target.matches("li")) { city.value = e.target.textContent; document.getElementById("out").textContent = "picked " + city.value; list.innerHTML = ""; }
  });
</script>`;

const KEYS_PAGE = `<!doctype html><title>Keys</title>
<input id="q" aria-label="Search"><p id="out">idle</p>
<script>
  const out = document.getElementById("out");
  document.addEventListener("keydown", (e) => { if (e.key === "Enter") out.textContent = (e.target.id === "q" ? "enter-in-q:" : "enter-on-body:") + document.getElementById("q").value; });
</script>`;

const server = createServer((req, res) => {
  if (req.url?.startsWith("/api/cart")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ items: [] })); // the real server: an empty cart
    return;
  }
  res.setHeader("content-type", "text/html");
  const u = req.url ?? "";
  res.end(u.startsWith("/cart") ? CART_PAGE : u.startsWith("/form") ? FORM_PAGE : u.startsWith("/spa") ? SPA_PAGE : u.startsWith("/auto") ? AUTO_PAGE : u.startsWith("/keys") ? KEYS_PAGE : "<!doctype html><title>Home</title><h1>Home</h1>");
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

  // 8. Mid-task checkpoint: the journal records the agent's actions, the checkpoint rebuilds the form in a NEW context.
  const start = await controller.applyFixture({
    version: 1,
    fresh: true,
    storage: { cookies: [{ name: "session", value: "cp-cookie-secret", url: base }], origins: [{ origin: base, localStorage: { theme: "dark" } }] },
    url: `${base}/form`,
    expect: { selector: "#add" },
  });
  check("checkpoint: start page ready", start.ok, start);
  controller.startJournal();
  await controller.act({ action: "type", target: "#name", text: "Ada Lovelace" });
  const snap = (await controller.snapshot()) as { snapshotId: string; elements: { index: number; tag: string; inputType?: string }[] };
  const sizeIdx = snap.elements.find((e) => e.tag === "select")?.index;
  const giftIdx = snap.elements.find((e) => e.inputType === "checkbox")?.index;
  check("checkpoint: snapshot lists the select and the checkbox", sizeIdx !== undefined && giftIdx !== undefined, snap.elements);
  await controller.perform({ snapshotId: snap.snapshotId, index: sizeIdx!, operation: "SELECT", text: "Large" });
  await controller.perform({ snapshotId: snap.snapshotId, index: giftIdx!, operation: "CLICK" });
  await controller.act({ action: "click", target: "Add to cart" });
  const formState = (page: import("playwright-core").Page) =>
    page.evaluate(() => ({
      name: (document.getElementById("name") as HTMLInputElement).value,
      size: (document.getElementById("size") as HTMLSelectElement).value,
      gift: (document.getElementById("gift") as HTMLInputElement).checked,
      out: document.getElementById("out")!.textContent,
      cart: localStorage.getItem("cart"),
      theme: localStorage.getItem("theme"),
      cookie: document.cookie,
    }));
  const live = await formState(context.pages()[0]!);
  check("checkpoint: the live form has the agent's state", live.name === "Ada Lovelace" && live.size === "l" && live.gift && live.cart === "x", live);
  const cp = await controller.captureCheckpoint();
  controller.stopJournal();
  check("checkpoint: ok and complete, 4 actions (each after a waitFor)", cp.ok && cp.complete && cp.fixture.steps?.filter((st) => st.action !== "waitFor").length === 4 && cp.fixture.steps?.filter((st) => st.action === "waitFor").length === 4, cp);
  if (cp.ok) {
    check("checkpoint: base storage was read before the steps (no cart in it)", !JSON.stringify(cp.fixture.storage).includes("cart"), cp.fixture.storage);
    check("checkpoint: summary has no secrets", !cp.summary.includes("cp-cookie-secret") && !cp.summary.includes("Ada"), cp.summary);
    console.log(`      ${cp.summary}`);
    const context2 = await browser.newContext();
    try {
      await context2.newPage();
      const controller2 = new BrowserController(new PlaywrightTarget(context2), { cursor: false });
      const applied = await controller2.applyFixture(JSON.parse(JSON.stringify(cp.fixture)));
      check("checkpoint: apply in a new context ok", applied.ok, applied);
      const restored = await formState(context2.pages()[0]!);
      check("checkpoint: the form state is back (name, size, gift, cart once, storage, cookie)", restored.name === "Ada Lovelace" && restored.size === "l" && restored.gift && restored.cart === "x" && restored.out === "cart=x" && restored.theme === "dark" && restored.cookie.includes("session=cp-cookie-secret"), restored);
    } finally {
      await context2.close();
    }
  }

  // 9. SPA pushState is not a reset: the click that pushed the state replays, then the typed value.
  {
    const ready = await controller.applyFixture({ version: 1, fresh: true, url: `${base}/spa`, expect: { selector: "#open" } });
    check("spa: start page ready", ready.ok, ready);
    controller.startJournal();
    await controller.act({ action: "click", target: "#open" });
    await controller.act({ action: "wait", text: "details" });
    await controller.act({ action: "type", target: "#note", text: "pushState note" });
    const cpSpa = await controller.captureCheckpoint();
    controller.stopJournal();
    check("spa: complete, base is the pre-pushState URL, click + type recorded", cpSpa.ok && cpSpa.complete && cpSpa.fixture.url === `${base}/spa` && cpSpa.fixture.steps?.filter((st) => st.action !== "waitFor").map((st) => st.action).join() === "click,type", cpSpa);
    if (cpSpa.ok) {
      const ctx = await browser.newContext();
      try {
        await ctx.newPage();
        const c2 = new BrowserController(new PlaywrightTarget(ctx), { cursor: false });
        const applied = await c2.applyFixture(JSON.parse(JSON.stringify(cpSpa.fixture)));
        const got = await ctx.pages()[0]!.evaluate(() => ({ path: location.pathname, note: (document.getElementById("note") as HTMLInputElement).value }));
        check("spa: replay reproduces the route and the typed value", applied.ok && got.path === "/spa/details" && got.note === "pushState note", { applied, got });
      } finally {
        await ctx.close();
      }
    }
  }

  // 10. A tab switch away and back keeps the first tab's journal (the typed value is not lost).
  {
    const ready = await controller.applyFixture({ version: 1, fresh: true, url: `${base}/form`, expect: { selector: "#add" } });
    check("tabs: start page ready", ready.ok, ready);
    controller.startJournal();
    await controller.act({ action: "type", target: "#name", text: "Tab Keeper" });
    const first = (await controller.tabs({ action: "list" })) as { tabs: { tabId: number; current: boolean }[] };
    const firstId = first.tabs.find((t) => t.current)!.tabId;
    await controller.tabs({ action: "new", url: `${base}/` });
    const onOther = await controller.captureCheckpoint();
    check("tabs: the other tab has its own journal (no steps)", onOther.ok && !onOther.fixture.steps?.length, onOther);
    await controller.tabs({ action: "switch", tabId: firstId });
    const cpTab = await controller.captureCheckpoint();
    controller.stopJournal();
    check("tabs: switching back continues the first tab's journal", cpTab.ok && cpTab.complete && cpTab.fixture.url === `${base}/form` && JSON.stringify(cpTab.fixture.steps).includes("Tab Keeper"), cpTab);
    if (cpTab.ok) {
      const ctx = await browser.newContext();
      try {
        await ctx.newPage();
        const c2 = new BrowserController(new PlaywrightTarget(ctx), { cursor: false });
        const applied = await c2.applyFixture(JSON.parse(JSON.stringify({ ...cpTab.fixture, tabs: undefined })));
        const value = await ctx.pages()[0]!.evaluate(() => (document.getElementById("name") as HTMLInputElement).value);
        check("tabs: replay brings the typed value back", applied.ok && value === "Tab Keeper", { applied, value });
      } finally {
        await ctx.close();
      }
    }
  }

  // 11. Async content: the option list appears 400 ms after typing. The recorded waitFor makes the replay wait for it.
  {
    const ready = await controller.applyFixture({ version: 1, fresh: true, url: `${base}/auto`, expect: { selector: "#city" } });
    check("autocomplete: start page ready", ready.ok, ready);
    controller.startJournal();
    await controller.act({ action: "type", target: "#city", text: "Ber" });
    await controller.act({ action: "wait", text: "Berlin" });
    await controller.act({ action: "click", target: "Berlin" });
    const cpAuto = await controller.captureCheckpoint();
    controller.stopJournal();
    const waits = cpAuto.ok ? cpAuto.fixture.steps?.filter((st) => st.action === "waitFor").length : 0;
    check("autocomplete: complete, a waitFor before the type and before the option click", cpAuto.ok && cpAuto.complete && waits === 2, cpAuto);
    if (cpAuto.ok) {
      const ctx = await browser.newContext();
      try {
        await ctx.newPage();
        const c2 = new BrowserController(new PlaywrightTarget(ctx), { cursor: false });
        const applied = await c2.applyFixture(JSON.parse(JSON.stringify(cpAuto.fixture)));
        const out = await ctx.pages()[0]!.evaluate(() => document.getElementById("out")!.textContent);
        check("autocomplete: the replayed click waited for the async list", applied.ok && out === "picked Berlin", { applied, out });
      } finally {
        await ctx.close();
      }
    }
  }

  // 12. A key-only press goes to the focused element: the journal records that element, the replay focuses it before the key.
  {
    const ready = await controller.applyFixture({ version: 1, fresh: true, url: `${base}/keys`, expect: { selector: "#q" } });
    check("keys: start page ready", ready.ok, ready);
    controller.startJournal();
    await controller.act({ action: "click", target: "#q" });
    await controller.act({ action: "press", key: "a" });
    await controller.act({ action: "press", key: "Enter" });
    const live = await context.pages()[0]!.evaluate(() => document.getElementById("out")!.textContent);
    check("keys: live, the key went to the focused input", live === "enter-in-q:a", live);
    const cpKeys = await controller.captureCheckpoint();
    controller.stopJournal();
    const presses = cpKeys.ok ? cpKeys.fixture.steps?.filter((st) => st.action === "press") : [];
    check("keys: complete, both presses carry the focused element's selector", cpKeys.ok && cpKeys.complete && presses?.length === 2 && presses.every((st) => st.action === "press" && st.selector === "#q"), cpKeys);
    if (cpKeys.ok) {
      const ctx = await browser.newContext();
      try {
        await ctx.newPage();
        const c2 = new BrowserController(new PlaywrightTarget(ctx), { cursor: false });
        const applied = await c2.applyFixture(JSON.parse(JSON.stringify(cpKeys.fixture)));
        const out = await ctx.pages()[0]!.evaluate(() => ({ out: document.getElementById("out")!.textContent, q: (document.getElementById("q") as HTMLInputElement).value }));
        check("keys: the replay sends the keys to the input, not to the body", applied.ok && out.out === "enter-in-q:a" && out.q === "a", { applied, out });
      } finally {
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exitCode = failed ? 1 : 0;
