/**
 * Live smoke test of the QA diagnostics features in a real Chromium (docs/specs/2026-10-18-qa-diagnostics-design.md):
 * failed requests + console errors in results, `assert`, `PageFixture.emulate`, `act upload` and `act viewport`.
 * No API keys, no network: a local HTTP server and the real BrowserController + Playwright adapter.
 *
 *   npm run qa-diagnostics-smoke
 */
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import type { AddressInfo, Server as TcpServer } from "node:net";
import { chromium } from "playwright-core";
import type { Page } from "playwright-core";
import { PlaywrightTarget } from "../src/adapters/playwright.js";
import { BrowserController } from "../src/controller/index.js";
import { UPLOAD_SAMPLES } from "../src/controller/uploadSamples.js";

let deadPort = 0;
const failPage = () => FAIL_PAGE.replace("__DEAD__", String(deadPort));
const FAIL_PAGE = `<!doctype html><title>Fail</title><h1>Fail</h1><button id="go" type="button">Go</button>
<script>
  document.getElementById("go").addEventListener("click", () => {
    fetch("/api/500?token=secret").catch(() => {});
    fetch("/api/404?token=secret", { method: "POST" }).catch(() => {});
    fetch("http://127.0.0.1:__DEAD__/refused?token=secret").catch(() => {});
    console.error("boom-console");
    setTimeout(() => { throw new Error("boom-uncaught"); }, 0);
  });
</script>`;

const ASSERT_PAGE = `<!doctype html><title>Assert</title><h1>Checkout</h1><p>Thanks for your order</p>
<input id="name" value="Ada Lovelace"><input id="empty" value="">
<input type="checkbox" id="on" checked><input type="checkbox" id="off">
<button id="dis" disabled>Disabled</button><button id="en">Enabled</button>
<div id="hid" style="display:none">secret panel</div><ul><li>a</li><li>b</li><li>c</li></ul>`;

const EMU_PAGE = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Emu</title>
<style>body{margin:0;height:3000px;background:#fff}#block{position:absolute;left:0;right:0;top:1600px;height:800px;background:#f00}</style>
<div id="block"></div><pre id="report" style="position:fixed;top:0;left:0;margin:0"></pre>
<script>
  document.getElementById("report").textContent = JSON.stringify({
    innerWidth: window.innerWidth, dpr: window.devicePixelRatio, dark: matchMedia("(prefers-color-scheme: dark)").matches,
    lang: navigator.language, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, ua: navigator.userAgent,
  });
</script>`;

const NOMETA_PAGE = `<!doctype html><title>NoMeta</title><style>body{margin:0;height:2000px;background:#fff}</style><h1>No meta viewport</h1>`;

const UPLOAD_PAGE = `<!doctype html><title>Upload</title>
<input type="file" id="multi" multiple><input type="file" id="single">
<div><button id="pick" type="button">Choose a file</button><input type="file" id="hid" style="display:none"></div>
<div id="drop" style="width:200px;height:100px;border:1px dashed #000">Drop here</div>
<div id="plain" style="width:200px;height:50px">Nothing here</div>
<pre id="out"></pre>
<script>
  const out = document.getElementById("out");
  const show = (tag, files) => { out.textContent = tag + ":" + [...files].map((f) => f.name + "=" + f.size + "/" + f.type).join(","); };
  for (const id of ["multi", "single", "hid"]) document.getElementById(id).addEventListener("change", (e) => show(id, e.target.files));
  const drop = document.getElementById("drop");
  drop.addEventListener("dragover", (e) => e.preventDefault());
  drop.addEventListener("drop", (e) => { e.preventDefault(); show("drop", e.dataTransfer.files); });
</script>`;

/** User-Agent of every request, by path (the extra-tab check reads the first one for /ua). */
const uaLog: { path: string; ua: string; al: string }[] = [];
const server = createServer((req, res) => {
  const path = (req.url ?? "").split("?")[0]!;
  uaLog.push({ path, ua: String(req.headers["user-agent"] ?? ""), al: String(req.headers["accept-language"] ?? "") });
  if (path === "/api/500") { res.statusCode = 500; res.end("err"); return; }
  if (path === "/api/404") { res.statusCode = 404; res.end("nope"); return; }
  res.setHeader("content-type", "text/html");
  const pages: Record<string, string> = { "/fail": failPage(), "/assert": ASSERT_PAGE, "/emu": EMU_PAGE, "/nometa": NOMETA_PAGE, "/upload": UPLOAD_PAGE, "/ua": "<!doctype html><title>UA</title><h1>UA</h1>" };
  res.end(pages[path] ?? "<!doctype html><title>Home</title><h1>Home</h1>");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
// A port whose server accepts and immediately destroys the socket: a network error (ERR_EMPTY_RESPONSE / CONNECTION_RESET).
const dead: TcpServer = createTcpServer((socket) => { socket.on("error", () => {}); socket.destroy(); });
await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
deadPort = (dead.address() as AddressInfo).port;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.newPage();
const target = new PlaywrightTarget(context);
const controller = new BrowserController(target, { cursor: false });
const mainPage = (): Page => context.pages()[0]!;

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${JSON.stringify(detail)}`}`);
}
const asRecord = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
const strings = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

/** Decodes a JPEG in a separate page: its size and the colour of some pixels. */
const decoder = await (await browser.newContext()).newPage();
async function decode(dataUrl: string, points: [number, number][]): Promise<{ w: number; h: number; px: number[][] }> {
  return decoder.evaluate(
    async ({ src, pts }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext("2d")!;
      g.drawImage(img, 0, 0);
      return { w: img.naturalWidth, h: img.naturalHeight, px: pts.map(([x, y]) => [...g.getImageData(x, y, 1, 1).data]) };
    },
    { src: dataUrl, pts: points },
  );
}

try {
  // ---------------------------------------------------------------- 1. failed requests + console errors
  await controller.open({ url: `${base}/fail` });
  await controller.act({ action: "wait", ms: 300 }); // drain whatever the page load produced
  const r1 = asRecord(await controller.act({ action: "click", target: "#go" }));
  let failedReqs = strings(r1.failedRequests);
  let consoleErrs = strings(r1.consoleErrors);
  // The uncaught exception and the refused request can land after the click settles: drain again until all show up.
  for (let i = 0; i < 6 && (!consoleErrs.some((e) => e.includes("boom-uncaught")) || failedReqs.length < 3); i++) {
    const more = asRecord(await controller.act({ action: "wait", ms: 300 }));
    failedReqs = [...failedReqs, ...strings(more.failedRequests)];
    consoleErrs = [...consoleErrs, ...strings(more.consoleErrors)];
  }
  check("failedRequests: GET 500 entry", failedReqs.includes(`GET 500 ${base}/api/500`), failedReqs);
  check("failedRequests: POST 404 entry", failedReqs.includes(`POST 404 ${base}/api/404`), failedReqs);
  check("failedRequests: dropped connection (loadingFailed, net:: error)", failedReqs.some((e) => e.startsWith("GET net::") && e.endsWith(`http://127.0.0.1:${deadPort}/refused`)), failedReqs);
  check("failedRequests: no query string leaks", !JSON.stringify([r1, failedReqs]).includes("secret"), failedReqs);
  check("consoleErrors: console.error", consoleErrs.some((e) => e.includes("boom-console")), consoleErrs);
  check("consoleErrors: uncaught exception", consoleErrs.some((e) => e.includes("boom-uncaught")), consoleErrs);
  const r1b = asRecord(await controller.act({ action: "wait", ms: 100 }));
  check("failedRequests: drained (absent on the next result)", r1b.failedRequests === undefined && r1b.consoleErrors === undefined, r1b);

  // ---------------------------------------------------------------- 2. assert
  await controller.open({ url: `${base}/assert` });
  await controller.act({ action: "wait", ms: 100 });
  type Row = { passed: boolean; error?: string; actual?: string };
  const run = async (checks: unknown[]): Promise<{ passed: boolean; results: Row[]; raw: Record<string, unknown> }> => {
    const raw = asRecord(await controller.assert({ checks }));
    return { passed: raw.passed as boolean, results: (raw.results as Row[]) ?? [], raw };
  };
  const one = async (c: unknown): Promise<Row & { raw: Record<string, unknown> }> => {
    const r = await run([c]);
    return { ...(r.results[0] ?? { passed: false, error: JSON.stringify(r.raw) }), raw: r.raw };
  };
  const expectPass = async (name: string, c: unknown, want = true) => {
    const r = await one(c);
    check(`assert: ${name}`, r.passed === want, r);
  };
  await expectPass("text present", { type: "text", text: "thanks for your ORDER" });
  await expectPass("text absent (not there)", { type: "text", text: "refund", absent: true });
  await expectPass("text absent fails when present", { type: "text", text: "Checkout", absent: true }, false);
  await expectPass("text present fails when missing", { type: "text", text: "refund" }, false);
  await expectPass("element visible", { type: "element", selector: "h1", state: "visible" });
  await expectPass("element hidden", { type: "element", selector: "#hid", state: "hidden" });
  await expectPass("element visible fails on hidden", { type: "element", selector: "#hid", state: "visible" }, false);
  await expectPass("element checked", { type: "element", selector: "#on", state: "checked" });
  await expectPass("element unchecked", { type: "element", selector: "#off", state: "unchecked" });
  await expectPass("element checked fails on unchecked", { type: "element", selector: "#off", state: "checked" }, false);
  await expectPass("element disabled", { type: "element", selector: "#dis", state: "disabled" });
  await expectPass("element enabled", { type: "element", selector: "#en", state: "enabled" });
  await expectPass("element absent", { type: "element", selector: "#nope", state: "absent" });
  await expectPass("element exists", { type: "element", selector: "#hid", state: "exists" });
  await expectPass("value equals", { type: "value", selector: "#name", equals: "Ada Lovelace" });
  await expectPass("value contains", { type: "value", selector: "#name", contains: "Love" });
  await expectPass("value equals wrong fails", { type: "value", selector: "#name", equals: "Grace" }, false);
  await expectPass("value equals empty", { type: "value", selector: "#empty", equals: "" });
  await expectPass("count equals", { type: "count", selector: "li", equals: 3 });
  await expectPass("count min/max", { type: "count", selector: "li", min: 2, max: 3 });
  await expectPass("count equals wrong fails", { type: "count", selector: "li", equals: 2 }, false);
  await expectPass("url contains", { type: "url", contains: "/assert" });
  await expectPass("url matches", { type: "url", matches: "/assert$" });
  await expectPass("url equals", { type: "url", equals: `${base}/assert` });
  await expectPass("url contains wrong fails", { type: "url", contains: "/other" }, false);
  const bad = await one({ type: "element", selector: "div[", state: "visible" });
  check("assert: invalid selector -> per-check error", bad.passed === false && typeof bad.error === "string" && bad.error.length > 0, bad);
  const multi = await run([{ type: "text", text: "Checkout" }, { type: "count", selector: "li", equals: 9 }]);
  check("assert: overall passed is false when one fails, rows in order", multi.passed === false && multi.results[0]?.passed === true && multi.results[1]?.passed === false, multi);

  // no_console_errors / no_failed_requests: errors come from the /fail page.
  await controller.open({ url: `${base}/fail` });
  await controller.act({ action: "wait", ms: 200 });
  await controller.assert({ checks: [{ type: "text", text: "Fail" }] }); // drain page-load noise
  await controller.act({ action: "click", target: "#go" }).catch(() => {});
  // act drained its own errors, so trigger them again straight from the page and let the ASSERT drain.
  const trigger = async () => {
    await mainPage().evaluate(() => (document.getElementById("go") as HTMLButtonElement).click());
    await mainPage().waitForTimeout(700);
  };
  await trigger();
  const nc = await run([{ type: "no_console_errors" }, { type: "no_failed_requests" }]);
  check("assert: no_console_errors fails when errors present", nc.results[0]?.passed === false, nc);
  check("assert: no_failed_requests fails when requests failed", nc.results[1]?.passed === false, nc);
  check("assert: merges consoleErrors/failedRequests into the result", strings(nc.raw.consoleErrors).length > 0 && strings(nc.raw.failedRequests).length > 0, nc.raw);
  await trigger();
  const ig = await run([
    { type: "no_console_errors", ignore: ["boom-console", "boom-uncaught", "Failed to load resource"] },
    { type: "no_failed_requests", ignore: ["/api/500", "/api/404", "/refused"] },
  ]);
  check("assert: no_console_errors honours ignore", ig.results[0]?.passed === true, ig);
  check("assert: no_failed_requests honours ignore", ig.results[1]?.passed === true, ig);
  const clean = await run([{ type: "no_console_errors" }, { type: "no_failed_requests" }]);
  check("assert: both pass when nothing new happened", clean.passed === true, clean);

  // ---------------------------------------------------------------- 3. emulate
  const cdpLog: { method: string; params?: Record<string, unknown> }[] = [];
  const pageHandle = target.currentPage() as unknown as { sendCdp: (m: string, p?: Record<string, unknown>) => Promise<unknown> };
  const originalSend = pageHandle.sendCdp.bind(pageHandle);
  pageHandle.sendCdp = async (m, p) => { cdpLog.push({ method: m, params: p }); return originalSend(m, p); };

  await controller.open({ url: `${base}/emu` });
  const before = await mainPage().evaluate(() => ({ w: window.innerWidth, dpr: window.devicePixelRatio, dark: matchMedia("(prefers-color-scheme: dark)").matches, ua: navigator.userAgent, lang: navigator.language, mobile: (navigator as unknown as { userAgentData?: { mobile: boolean } }).userAgentData?.mobile ?? null }));
  uaLog.length = 0;
  const applied = await controller.applyFixture({
    version: 1,
    emulate: { device: "iphone-15", colorScheme: "dark", locale: "de-DE", timezone: "Europe/Berlin" },
    url: `${base}/emu`,
    tabs: [`${base}/ua`],
    expect: { selector: "#block" },
  });
  check("emulate: apply ok", applied.ok, applied);
  const rep = JSON.parse((await mainPage().textContent("#report")) ?? "{}") as { innerWidth: number; dpr: number; dark: boolean; lang: string; tz: string; ua: string };
  check("emulate: innerWidth 393", rep.innerWidth === 393, rep);
  check("emulate: devicePixelRatio 3", rep.dpr === 3, rep);
  check("emulate: prefers-color-scheme dark", rep.dark === true, rep);
  check("emulate: navigator.language de-DE", rep.lang === "de-DE", rep);
  check("emulate: timezone Europe/Berlin", rep.tz === "Europe/Berlin", rep);
  check("emulate: UA contains iPhone", rep.ua.includes("iPhone"), rep.ua);
  const emuFirst = uaLog.find((e) => e.path === "/emu");
  console.log(`accept-language on the emulated page request: ${emuFirst?.al}; extra tab first request: ${uaLog.find((e) => e.path === "/ua")?.al}`);
  check("emulate: Accept-Language of the page request starts with de-DE", !!emuFirst && emuFirst.al.startsWith("de-DE"), uaLog);
  const tabFirst = uaLog.find((e) => e.path === "/ua");
  check("emulate: extra tab's FIRST request carries the iPhone UA", !!tabFirst && tabFirst.ua.includes("iPhone"), uaLog);
  check("emulate: extra tab's first request Accept-Language starts with de-DE", !!tabFirst && tabFirst.al.startsWith("de-DE"), uaLog);

  const hintsNow = await mainPage().evaluate(() => {
    const d = (navigator as unknown as { userAgentData?: { mobile: boolean; brands: unknown[]; platform: string } }).userAgentData;
    return { present: d !== undefined, mobile: d?.mobile, brands: d?.brands.length ?? 0, platform: d?.platform, navPlatform: navigator.platform };
  });
  console.log(`iphone-15 hints as Chromium reports them: ${JSON.stringify(hintsNow)}`);
  check("emulate: iphone-15 -> no UA Client Hints (userAgentData undefined or empty brands), like Safari", !hintsNow.present || hintsNow.brands === 0, hintsNow);
  check("emulate: iphone-15 -> navigator.platform iPhone", hintsNow.navPlatform === "iPhone", hintsNow);

  const shot = asRecord(await controller.screenshot({}));
  check("emulate: screenshot imageData is a data URL", typeof shot.imageData === "string" && shot.imageData.startsWith("data:image/"), String(shot.imageData).slice(0, 30));
  check("emulate: screenshot returns an image", typeof shot.imageData === "string" && shot.width === 393 && shot.height === 852, { w: shot.width, h: shot.height, err: shot.error });
  const dec = await decode(String(shot.imageData), [[200, 400]]);
  check("emulate: decoded image is 393x852 (ratio of the device)", dec.w === 393 && dec.h === 852, dec);
  check("emulate: unscrolled shot has no red block", dec.px[0]![0]! > 200 && dec.px[0]![1]! > 200, dec.px);
  await mainPage().evaluate(() => window.scrollTo(0, 1500));
  await mainPage().waitForTimeout(200);
  cdpLog.length = 0;
  const shot2 = asRecord(await controller.screenshot({}));
  const clip = cdpLog.find((e) => e.method === "Page.captureScreenshot")?.params?.clip as { x: number; y: number; width: number; height: number } | undefined;
  check("emulate: scrolled shot clip.y is ~1500", !!clip && Math.abs(clip.y - 1500) <= 2, clip);
  const dec2 = await decode(String(shot2.imageData), [[200, 400], [200, 20]]);
  const [r, g, b] = dec2.px[0]!;
  check("emulate: scrolled shot shows the red block (pixel)", r! > 200 && g! < 80 && b! < 80, dec2.px);
  check("emulate: scrolled shot top (y=20) is white (red starts at y=100)", dec2.px[1]![0]! > 200 && dec2.px[1]![1]! > 200, dec2.px);

  const ann = asRecord(await controller.screenshot({ annotate: true }));
  check("emulate: annotated screenshot works under emulation", typeof ann.imageData === "string" && ann.imageData.startsWith("data:image/") && ann.error === undefined, { err: ann.error, head: String(ann.imageData).slice(0, 30) });

  // A page WITHOUT a meta viewport: 980 px layout under mobile emulation.
  await controller.open({ url: `${base}/nometa` });
  cdpLog.length = 0;
  const shot3 = asRecord(await controller.screenshot({}));
  const clip3 = cdpLog.find((e) => e.method === "Page.captureScreenshot")?.params?.clip as { width: number } | undefined;
  check("emulate: no meta viewport -> clip width ~980", !!clip3 && Math.abs(clip3.width - 980) <= 2, clip3);
  check("emulate: no meta viewport -> image width ~980", typeof shot3.width === "number" && Math.abs(shot3.width - 980) <= 2, { w: shot3.width, h: shot3.height });

  // Release restores everything.
  await controller.releaseFixture(applied.ok ? applied.fixtureToken : undefined);
  await controller.open({ url: `${base}/emu` });
  const after = await mainPage().evaluate(() => ({ w: window.innerWidth, dpr: window.devicePixelRatio, dark: matchMedia("(prefers-color-scheme: dark)").matches, ua: navigator.userAgent, lang: navigator.language, mobile: (navigator as unknown as { userAgentData?: { mobile: boolean } }).userAgentData?.mobile ?? null }));
  check("release: innerWidth back", after.w === before.w, { before, after });
  check("release: devicePixelRatio back", after.dpr === before.dpr, { before, after });
  check("release: UA back to the original", after.ua === before.ua && !after.ua.includes("iPhone"), { before: before.ua, after: after.ua });
  check("release: colour scheme back", after.dark === before.dark, { before, after });
  check("release: userAgentData.mobile back to false", after.mobile === before.mobile && after.mobile !== true, { before: before.mobile, after: after.mobile });
  check("release: locale back", after.lang === before.lang, { before, after });

  // Locale alone (no device, no UA override): header + navigator.language, client hints stay intact.
  const probe = () => mainPage().evaluate(() => {
    const uad = (navigator as unknown as { userAgentData?: { brands: unknown[] } }).userAgentData;
    return { lang: navigator.language, langs: [...navigator.languages], brands: uad ? uad.brands.length : -1, ua: navigator.userAgent };
  });
  const probeBefore = await probe();
  uaLog.length = 0;
  await controller.open({ url: `${base}/emu` });
  const alBefore = uaLog.find((e) => e.path === "/emu")?.al ?? "";
  const loc = await controller.applyFixture({ version: 1, emulate: { locale: "de-DE" }, url: `${base}/emu`, expect: { selector: "#block" } });
  check("locale only: apply ok", loc.ok, loc);
  const locAl = uaLog.filter((e) => e.path === "/emu").at(-1)?.al ?? "";
  const locNow = await probe();
  console.log(`locale only: accept-language ${locAl}; navigator.language ${locNow.lang}; brands ${locNow.brands}`);
  check("locale only: navigator.language de-DE", locNow.lang === "de-DE" && locNow.langs[0] === "de-DE", locNow);
  check("locale only: Accept-Language starts with de-DE", locAl.startsWith("de-DE"), locAl);
  check("locale only: UA unchanged", locNow.ua === probeBefore.ua, { before: probeBefore.ua, now: locNow.ua });
  check("locale only: userAgentData.brands still non-empty (client hints intact)", locNow.brands > 0, locNow);
  await controller.releaseFixture(loc.ok ? loc.fixtureToken : undefined);
  uaLog.length = 0;
  await controller.open({ url: `${base}/emu` });
  const locAfter = await probe();
  const alAfter = uaLog.find((e) => e.path === "/emu")?.al ?? "";
  check("locale only release: navigator.language back", locAfter.lang === probeBefore.lang, { before: probeBefore.lang, after: locAfter.lang });
  check("locale only release: Accept-Language back", alAfter === alBefore, { before: alBefore, after: alAfter });
  check("locale only release: client hints still non-empty", locAfter.brands > 0, locAfter);

  // Locale + pixel-8: Accept-Language (acceptLanguage field) and navigator.languages must match the locale-only path.
  uaLog.length = 0;
  const px = await controller.applyFixture({ version: 1, emulate: { device: "pixel-8", locale: "de-DE" }, url: `${base}/emu`, expect: { selector: "#block" } });
  check("pixel-8 + locale: apply ok", px.ok, px);
  const pxAl = uaLog.filter((e) => e.path === "/emu").at(-1)?.al ?? "";
  const pxNow = await mainPage().evaluate(() => {
    const d = (navigator as unknown as { userAgentData?: { mobile: boolean; brands: { brand: string; version: string }[]; platform: string } }).userAgentData;
    return { langs: [...navigator.languages], ua: navigator.userAgent, mobile: d?.mobile, brands: d?.brands ?? [], platform: d?.platform };
  });
  console.log(`locale only: ${locAl} ${JSON.stringify(locNow.langs)}; pixel-8 + locale: ${pxAl} ${JSON.stringify(pxNow.langs)}; ua ${pxNow.ua}; brands ${JSON.stringify(pxNow.brands)}`);
  check("pixel-8 + locale: Accept-Language equals the locale-only value", pxAl === locAl && locAl === "de-DE,de;q=0.9", { locAl, pxAl });
  check("pixel-8 + locale: navigator.languages equals the locale-only value", JSON.stringify(pxNow.langs) === JSON.stringify(locNow.langs) && locNow.langs.join() === "de-DE,de", { loc: locNow.langs, px: pxNow.langs });
  check("pixel-8: userAgentData.mobile true, platform Android", pxNow.mobile === true && pxNow.platform === "Android", pxNow);
  const chromiumBrand = pxNow.brands.find((b) => b.brand === "Chromium");
  check("pixel-8: UA Chrome version agrees with the Chromium brand", !!chromiumBrand && pxNow.ua.includes(`Chrome/${chromiumBrand.version}.`), pxNow);
  await controller.releaseFixture(px.ok ? px.fixtureToken : undefined);

  // ---------------------------------------------------------------- 4. upload
  await controller.applyFixture({ version: 1, fresh: true, url: `${base}/upload`, expect: { selector: "#multi" } });
  const out = async () => (await mainPage().textContent("#out")) ?? "";
  const pngSize = Buffer.from(UPLOAD_SAMPLES.png.base64, "base64").length;
  const up1 = asRecord(await controller.act({
    action: "upload",
    target: "#multi",
    files: [{ name: "a.txt", text: "hello" }, { name: "b.bin", base64: "AQID" }, { name: "c.png", sample: "png" }],
  }));
  check("upload: input ok, via input", up1.ok === true && up1.via === "input" && strings(up1.uploaded).join() === "a.txt,b.bin,c.png", up1);
  check("upload: page shows names and sizes", (await out()) === `multi:a.txt=5/text/plain,b.bin=3/application/octet-stream,c.png=${pngSize}/image/png`, await out());

  const up2 = asRecord(await controller.act({ action: "upload", target: "#pick", files: [{ name: "doc.txt", text: "abcd" }] }));
  check("upload: button finds the sibling hidden input", up2.ok === true && up2.via === "input" && (await out()) === "hid:doc.txt=4/text/plain", { up2, out: await out() });

  const up3 = asRecord(await controller.act({ action: "upload", target: "#drop", files: [{ name: "d.txt", text: "xyz" }] }));
  check("upload: drop zone gets via drop", up3.ok === true && up3.via === "drop" && (await out()) === "drop:d.txt=3/text/plain", { up3, out: await out() });

  const up4 = asRecord(await controller.act({ action: "upload", target: "#plain", files: [{ name: "p.txt", text: "x" }] }));
  check("upload: plain div without handlers -> error", typeof up4.error === "string" && up4.ok !== true, up4);
  check("upload: plain div error carries the noEffect tag", Object.getOwnPropertySymbols(up4).some((s) => s.description === "noEffect"), Object.getOwnPropertySymbols(up4).map(String));

  const up5 = asRecord(await controller.act({ action: "upload", target: "#single", files: [{ name: "1.txt", text: "1" }, { name: "2.txt", text: "2" }] }));
  check('upload: >1 file to a single input -> "This input takes one file"', typeof up5.error === "string" && up5.error.includes("This input takes one file"), up5);

  // ---------------------------------------------------------------- 5. viewport
  await controller.open({ url: `${base}/emu` });
  const readReport = async () => JSON.parse((await mainPage().textContent("#report")) ?? "{}") as { innerWidth: number; ua: string };
  const original = await readReport();
  await mainPage().evaluate(() => { (window as unknown as { __marker: number }).__marker = 1; });
  const vp1 = asRecord(await controller.act({ action: "viewport", device: "iphone-15" }));
  const afterPhone = await readReport();
  check("viewport: iphone-15 ok, reloaded", vp1.ok === true && vp1.reloaded === true && vp1.device === "iphone-15", vp1);
  check("viewport: iphone-15 innerWidth 393 in the result and on the page", asRecord(vp1.viewport).width === 393 && afterPhone.innerWidth === 393, { vp1, afterPhone });
  check("viewport: iphone-15 UA is the iPhone one after the reload", afterPhone.ua.includes("iPhone"), afterPhone.ua);
  check("viewport: the page really reloaded (marker gone)", (await mainPage().evaluate(() => (window as unknown as { __marker?: number }).__marker)) === undefined);
  const vpShot = asRecord(await controller.screenshot({}));
  check("viewport: screenshot under the action is a data URL", typeof vpShot.imageData === "string" && vpShot.imageData.startsWith("data:image/jpeg;base64,"), String(vpShot.imageData).slice(0, 30));
  const vpDec = await decode(String(vpShot.imageData), [[10, 10]]);
  check("viewport: screenshot has the aspect of the phone (393x852)", vpDec.w === 393 && vpDec.h === 852, vpDec);

  const vp2 = asRecord(await controller.act({ action: "viewport", device: "custom", width: 800, height: 600 }));
  const afterCustom = await readReport();
  check("viewport: custom 800x600 -> 800 in result and on the page", vp2.ok === true && asRecord(vp2.viewport).width === 800 && asRecord(vp2.viewport).height === 600 && afterCustom.innerWidth === 800, { vp2, afterCustom });
  check("viewport: custom (desktop) drops the iPhone UA, page reloaded", vp2.reloaded === true && !afterCustom.ua.includes("iPhone"), { vp2, ua: afterCustom.ua });
  const vp3 = asRecord(await controller.act({ action: "viewport", device: "custom", width: 700, height: 500 }));
  check("viewport: a pure size change does not reload", vp3.ok === true && vp3.reloaded === false && asRecord(vp3.viewport).width === 700, vp3);

  const vp4 = asRecord(await controller.act({ action: "viewport", device: "reset" }));
  // A pure size change does not reload, so the report written at load is stale: read the live values.
  const afterReset = await mainPage().evaluate(() => ({ innerWidth: window.innerWidth, ua: navigator.userAgent }));
  check("viewport: reset -> original width and UA", vp4.ok === true && asRecord(vp4.viewport).width === original.innerWidth && afterReset.innerWidth === original.innerWidth && afterReset.ua === original.ua, { vp4, original, afterReset });

  await controller.act({ action: "viewport", device: "pixel-8" });
  await controller.clearActEmulation();
  await controller.act({ action: "reload" });
  const afterClear = await readReport();
  check("viewport: clearActEmulation leaves the real browser (width and UA back)", afterClear.innerWidth === original.innerWidth && afterClear.ua === original.ua, { original, afterClear });
} catch (e) {
  failed++;
  console.log(`FAIL  smoke crashed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
} finally {
  await browser.close();
  server.close();
  dead.close();
}

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
