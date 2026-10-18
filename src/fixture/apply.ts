// applyFixture: put a browser into the state a PageFixture describes.
// Isomorphic: it drives a BrowserTarget (types only) and runs every page step
// through `executeJavaScript`. Order: session reset, network mocks, cookies,
// emulation, storage per origin, start URL, extra tabs, steps, expect. Error text never repeats cookie or storage data: page
// errors are reported with fixed words, not with the message the page gave.
import type { BrowserPageHandle, BrowserTarget } from "../controller/controller.js";
import { dispatchKeyPair, keyDispatchOptions, parseKeySpec } from "../controller/keys.js";
import { installEmulation, resolveEmulation } from "./emulate.js";
import { createNetworkHandler, matchUrlPattern } from "./network.js";
import { parsePageFixture } from "./parse.js";
import {
  FIXTURE_MAX_WAIT_MS,
  FIXTURE_WAIT_FOR_DEFAULT_MS,
  type FixtureApplyOptions,
  type FixtureApplyResult,
  type FixtureDialog,
  type FixtureHookResult,
  type FixtureHooks,
  type FixtureStage,
  type FixtureStep,
  type PageFixture,
} from "./types.js";
import { fixtureStateParts, httpOrigin, plural, redactUrl, redactUrls, runScript, SCRIPT_TIMEOUT_MS, toMessage } from "./util.js";

/** What one apply run shares between its helpers. */
interface Ctx {
  target: BrowserTarget;
  signal: AbortSignal | undefined;
  hooks: FixtureHooks | undefined;
  /** Id of the tab the fixture works on; undefined when the target lists no tabs (then there is one). */
  mainId: number | undefined;
  /** Dialogs the host hooks drained. */
  dialogs: FixtureDialog[];
  allowNetworkMocks: boolean;
  /** The part of the apply that runs now: a failure is reported with it. */
  stage: FixtureStage;
  /** Removes the installed network mocks and clears the emulation (idempotent); undefined when none. */
  release: (() => Promise<void>) | undefined;
  /** What `release` undoes, in install order. Filled through `addCleanup`. */
  cleanups: Array<() => Promise<void>>;
}

/**
 * Registers something `release` must undo. All cleanups share ONE release: it runs them in reverse
 * order, every one even when an earlier one fails, and rethrows the first failure (the network
 * removal's, as before; an emulation clear never throws).
 */
function addCleanup(ctx: Ctx, cleanup: () => Promise<void>): void {
  ctx.cleanups.push(cleanup);
  ctx.release ??= once(async () => {
    let failure: unknown;
    let failed = false;
    for (const fn of ctx.cleanups.splice(0).reverse()) {
      try {
        await fn();
      } catch (err) {
        if (!failed) {
          failed = true;
          failure = err;
        }
      }
    }
    if (failed) throw failure;
  });
}

/**
 * Emulates `page` as `fixture.emulate` says and registers the clear. Popups and tabs opened later
 * by the page are NOT emulated: only the main tab and the fixture's `tabs` are.
 */
async function emulatePage(ctx: Ctx, page: BrowserPageHandle, fixture: PageFixture, label: string): Promise<void> {
  const emulate = fixture.emulate!;
  if (!page.sendCdp) throw new FixtureError(EMULATION_UNSUPPORTED);
  let clear: () => Promise<void>;
  try {
    clear = await installEmulation(page, resolveEmulation(emulate));
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    throw new FixtureError(`${label}: setting emulation failed: ${toMessage(err)}`);
  }
  // Registered before the abort check: a failure from here on clears it. The host hook sees the clear first
  // (a host registry may wrap it), and the cleanup runs whatever the hook returns.
  let registered: (() => Promise<void>) | void = undefined;
  try {
    registered = ctx.hooks?.onEmulated?.(page, emulate, clear);
  } finally {
    addCleanup(ctx, registered ?? clear);
  }
  throwIfAborted(ctx.signal);
}

const EMULATION_UNSUPPORTED = "This browser does not support emulation.";

function enter(ctx: Ctx, stage: FixtureStage): void {
  ctx.stage = stage;
  ctx.hooks?.onStage?.(stage);
}

/** Longest wait for one navigation of a fixture. */
const LOAD_TIMEOUT_MS = 30_000;
/** Longest wait for a page to finish a navigation a click or key press started (standalone). */
const SETTLE_TIMEOUT_MS = 10_000;
/** How long a click or key press may take to start a navigation (standalone). */
const SETTLE_START_MS = 150;
const WAIT_FOR_POLL_MS = 100;
/** Time `fresh` may take besides one navigation: cookies, tabs, storage of every origin. */
const RESET_BUDGET_MS = 15_000;
/** Overall cap of `fixtureBudgetMs`. */
const MAX_BUDGET_MS = 5 * 60_000;

class FixtureError extends Error {}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new FixtureError("aborted");
}

/** Sleeps `ms`; rejects at once when `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new FixtureError("aborted"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new FixtureError("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Loads `url` and waits for the DOM (like `BrowserController.open`): the
 * subresources of a heavy page do not have to finish. */
async function load(page: BrowserPageHandle, url: string, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  const domReady = page.onceDomReady();
  const loaded = page.loadURL(url);
  // A load failure after DOM-ready is not a failure of this call.
  const loadOutcome = loaded.then(
    () => undefined,
    (err: unknown) => new FixtureError(`loading failed: ${toMessage(err)}`),
  );
  const stop = new AbortController();
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new FixtureError(`loading timed out after ${LOAD_TIMEOUT_MS}ms`)), LOAD_TIMEOUT_MS);
    stop.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  });
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new FixtureError("aborted"));
    if (signal?.aborted) onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    stop.signal.addEventListener("abort", () => signal?.removeEventListener("abort", onAbort), { once: true });
  });
  try {
    const first = await Promise.race([domReady.then(() => undefined), loadOutcome, timeout, aborted]);
    if (first) throw first;
  } finally {
    stop.abort();
    // The timeout and abort promises settle unobserved when they lose.
    timeout.catch(() => {});
    aborted.catch(() => {});
  }
}

/** Makes the main tab current and returns its page. Re-resolved before every
 * navigation and step, because a popup can become current at any time. */
async function mainPage(ctx: Ctx): Promise<BrowserPageHandle> {
  throwIfAborted(ctx.signal);
  const { target } = ctx;
  if (ctx.mainId !== undefined) {
    const tabs = await target.listPages!();
    const current = tabs.find((t) => t.current);
    if (!current) throw new FixtureError("the browser reports no current tab");
    if (current.tabId !== ctx.mainId) {
      throwIfAborted(ctx.signal);
      if (!target.selectPage || !(await target.selectPage(ctx.mainId))) throw new FixtureError("the main tab is gone");
    }
    const page = target.currentPage();
    if (!page) throw new FixtureError("the main tab has no page");
    return page;
  }
  return target.ensurePage();
}

function takeHookResult(ctx: Ctx, done: FixtureHookResult): void {
  if (done.dialogs) ctx.dialogs.push(...done.dialogs);
  if (!done.ok) throw new FixtureError(done.error);
}

/** Loads `url` in the main tab: through the host hook when it has one, else standalone. Returns the main page. */
async function navigate(ctx: Ctx, url: string): Promise<BrowserPageHandle> {
  const page = await mainPage(ctx);
  if (ctx.hooks?.navigate) {
    takeHookResult(ctx, await ctx.hooks.navigate(url, ctx.signal));
  } else {
    await load(page, url, ctx.signal);
  }
  return mainPage(ctx);
}

/** After a click, select or key press: wait for a navigation it started (standalone version of `settled`). */
async function settleStandalone(page: BrowserPageHandle, signal: AbortSignal | undefined): Promise<void> {
  const begin = Date.now();
  while (!page.isLoading() && Date.now() - begin < SETTLE_START_MS) await sleep(25, signal);
  if (!page.isLoading()) return;
  const stop = new AbortController();
  const timeout = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, SETTLE_TIMEOUT_MS);
    stop.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  });
  const aborted = new Promise<void>((resolve) => {
    signal?.addEventListener("abort", () => resolve(), { once: true });
    if (signal?.aborted) resolve();
  });
  try {
    await Promise.race([page.onceDomReady().catch(() => {}), timeout, aborted]);
  } finally {
    stop.abort();
  }
  throwIfAborted(signal);
}

/** Runs a click, select or key `action` and lets the page settle: the host's way when it has one. */
async function settled(ctx: Ctx, page: BrowserPageHandle, action: () => Promise<StepOutcome>): Promise<StepOutcome> {
  if (ctx.hooks?.settled) return ctx.hooks.settled(page, action);
  const outcome = await action();
  // A failed action started nothing worth waiting for.
  if (outcome.ok) await settleStandalone(page, ctx.signal);
  return outcome;
}

/** A value as a JS literal. `JSON.stringify` output is valid JS except for the
 * line separators U+2028 and U+2029 in older engines, so those are escaped. */
function lit(value: unknown): string {
  return JSON.stringify(value).replace(/[\u2028\u2029]/g, (c) => (c === "\u2028" ? "\\u2028" : "\\u2029"));
}

const FIND = (selector: string) => `(() => { try { return document.querySelector(${lit(selector)}); } catch { return undefined; } })()`;

function storageScript(local: Record<string, string>, session: Record<string, string>): string {
  // The page error is not reported: its message may quote a key.
  return `(() => {
  try {
    const set = (store, entries) => { for (const [k, v] of Object.entries(entries)) store.setItem(k, v); };
    set(localStorage, ${lit(local)});
    set(sessionStorage, ${lit(session)});
    return JSON.stringify({ ok: true });
  } catch (e) {
    return JSON.stringify({ ok: false, name: String((e && e.name) || "Error") });
  }
})()`;
}

function clickScript(selector: string): string {
  return `(() => {
  const el = ${FIND(selector)};
  if (el === undefined) return JSON.stringify({ ok: false, error: "invalid selector" });
  if (!el) return JSON.stringify({ ok: false, error: "element not found" });
  if (el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "center" });
  el.click();
  return JSON.stringify({ ok: true });
})()`;
}

function typeScript(selector: string, text: string): string {
  return `(() => {
  const el = ${FIND(selector)};
  if (el === undefined) return JSON.stringify({ ok: false, error: "invalid selector" });
  if (!el) return JSON.stringify({ ok: false, error: "element not found" });
  const isArea = el instanceof HTMLTextAreaElement;
  if (!isArea && !(el instanceof HTMLInputElement)) return JSON.stringify({ ok: false, error: "element is not a text field" });
  if (el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "center" });
  el.focus();
  const proto = isArea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, ${lit(text)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return JSON.stringify({ ok: true });
})()`;
}

function selectScript(selector: string, value: string): string {
  return `(() => {
  const el = ${FIND(selector)};
  if (el === undefined) return JSON.stringify({ ok: false, error: "invalid selector" });
  if (!el) return JSON.stringify({ ok: false, error: "element not found" });
  if (!(el instanceof HTMLSelectElement)) return JSON.stringify({ ok: false, error: "element is not a select" });
  // The error never repeats the value: it may be data of the user.
  if (!Array.from(el.options).some((o) => o.value === ${lit(value)})) return JSON.stringify({ ok: false, error: "no option has the given value" });
  if (el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "center" });
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
  setter.call(el, ${lit(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return JSON.stringify({ ok: true });
})()`;
}

/** Focuses the target of a `press` step (when it has a selector). */
function focusScript(selector: string): string {
  return `(() => {
  const el = ${FIND(selector)};
  if (el === undefined) return JSON.stringify({ ok: false, error: "invalid selector" });
  if (!el) return JSON.stringify({ ok: false, error: "element not found" });
  if (el.focus) el.focus();
  return JSON.stringify({ ok: true });
})()`;
}

/** Fallback of `press` for a page without a CDP session. */
function keyEventScript(key: string, code: string, mods: { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean }): string {
  return `(() => {
  const el = document.activeElement || document.body;
  const init = { key: ${lit(key)}, code: ${lit(code)}, bubbles: true, cancelable: true, altKey: ${mods.alt}, ctrlKey: ${mods.ctrl}, metaKey: ${mods.meta}, shiftKey: ${mods.shift} };
  el.dispatchEvent(new KeyboardEvent("keydown", init));
  el.dispatchEvent(new KeyboardEvent("keyup", init));
  return JSON.stringify({ ok: true });
})()`;
}

function existsScript(selector: string): string {
  return `(() => {
  const el = ${FIND(selector)};
  if (el === undefined) return JSON.stringify({ ok: false, error: "invalid selector" });
  return JSON.stringify({ ok: true, found: !!el });
})()`;
}

type StepOutcome = { ok: true } | { ok: false; error: string };

async function pageStep(page: BrowserPageHandle, code: string): Promise<StepOutcome> {
  let result: Record<string, unknown>;
  try {
    result = await runScript(page, code);
  } catch {
    return { ok: false, error: "the page script failed" };
  }
  return result.ok === true ? { ok: true } : { ok: false, error: typeof result.error === "string" ? result.error : "the page script failed" };
}

async function press(ctx: Ctx, page: BrowserPageHandle, step: Extract<FixtureStep, { action: "press" }>): Promise<StepOutcome> {
  const parsed = parseKeySpec(step.key);
  if (!parsed) return { ok: false, error: "unsupported key" };
  if (step.selector !== undefined) {
    const focused = await pageStep(page, focusScript(step.selector));
    if (!focused.ok) return focused;
  }
  const { descriptor, modifiers } = parsed;
  return settled(ctx, page, async () => {
    if (ctx.hooks?.press) {
      try {
        if (await ctx.hooks.press(page, parsed)) return { ok: true };
      } catch {
        return { ok: false, error: "the key press failed" };
      }
    }
    if (page.sendCdp) {
      // Trusted input, like `act press`: reaches the real key handlers.
      try {
        await dispatchKeyPair(page, descriptor, keyDispatchOptions(parsed));
        return { ok: true };
      } catch {
        return { ok: false, error: "the key press failed" };
      }
    }
    // The selector was focused above, so the event goes to the active element.
    return pageStep(page, keyEventScript(descriptor.key, descriptor.code, modifiers));
  });
}

/** One try of a poll: done, or why not. `fatal` ends the poll at once. */
type PollAttempt = { done: true } | { done: false; fatal?: boolean; detail: string };

/**
 * Tries `attempt` until it is done or `timeoutMs` passes (`0` tries once), with
 * a short pause between tries. Shared by `waitFor` steps and `expect`.
 */
async function poll(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  attempt: () => Promise<PollAttempt>,
): Promise<{ ok: true } | { ok: false; fatal: boolean; detail: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    throwIfAborted(signal);
    const outcome = await attempt();
    if (outcome.done) return { ok: true };
    const remaining = deadline - Date.now();
    if (outcome.fatal || remaining <= 0) return { ok: false, fatal: outcome.fatal === true, detail: outcome.detail };
    await sleep(Math.min(WAIT_FOR_POLL_MS, remaining), signal);
  }
}

/** Polls for `selector` until `timeoutMs` passes. `timeoutMs` 0 checks once. */
async function waitFor(page: BrowserPageHandle, selector: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<StepOutcome> {
  const outcome = await poll(signal, timeoutMs, async () => {
    let result: Record<string, unknown> | undefined;
    try {
      result = await runScript(page, existsScript(selector));
    } catch {
      // The context can be destroyed by a navigation under the poll: retry until the deadline.
    }
    if (!result) return { done: false, detail: "" };
    if (result.ok !== true) return { done: false, fatal: true, detail: typeof result.error === "string" ? result.error : "the page script failed" };
    return result.found === true ? { done: true } : { done: false, detail: "" };
  });
  if (outcome.ok) return { ok: true };
  return { ok: false, error: outcome.fatal ? outcome.detail : `timed out after ${timeoutMs}ms` };
}

async function runStep(ctx: Ctx, step: FixtureStep): Promise<StepOutcome> {
  const { signal } = ctx;
  if (step.action === "goto") {
    try {
      await navigate(ctx, step.url);
      return { ok: true };
    } catch (err) {
      if (signal?.aborted) throw err;
      return { ok: false, error: toMessage(err) };
    }
  }
  if (step.action === "wait") {
    await sleep(step.ms, signal);
    return { ok: true };
  }
  const page = await mainPage(ctx);
  switch (step.action) {
    case "click":
      return settled(ctx, page, () => pageStep(page, clickScript(step.selector)));
    case "type":
      return pageStep(page, typeScript(step.selector, step.text));
    case "select":
      // A select can fire a handler that navigates or loads (a country picker): settle like a click.
      return settled(ctx, page, () => pageStep(page, selectScript(step.selector, step.value)));
    case "press":
      return press(ctx, page, step);
    case "waitFor":
      return waitFor(page, step.selector, step.timeoutMs ?? FIXTURE_WAIT_FOR_DEFAULT_MS, signal);
  }
}

function expectScript(selector: string | undefined, text: string | undefined): string {
  return `(() => {
  const out = { ok: true };
  ${selector === undefined ? "" : `const el = ${FIND(selector)};
  if (el === undefined) return JSON.stringify({ ok: false, error: "invalid selector" });
  let visible = false;
  if (el) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    visible = r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  }
  out.selector = visible;`}
  ${text === undefined ? "" : `const body = document.body;
  out.text = !!body && String(body.innerText || "").includes(${lit(text)});`}
  return JSON.stringify(out);
})()`;
}

const EXPECT_TEXT_MAX = 80;

/** Polls until every condition of `expect` holds, or fails naming the ones that do not. */
async function checkExpect(ctx: Ctx, expectation: NonNullable<PageFixture["expect"]>): Promise<void> {
  const timeoutMs = expectation.timeoutMs ?? FIXTURE_WAIT_FOR_DEFAULT_MS;
  const needsScript = expectation.selector !== undefined || expectation.text !== undefined;
  const outcome = await poll(ctx.signal, timeoutMs, async () => {
    const page = await mainPage(ctx);
    const failed: string[] = [];
    if (needsScript) {
      let result: Record<string, unknown> | undefined;
      try {
        result = await runScript(page, expectScript(expectation.selector, expectation.text));
      } catch {
        // The context can be destroyed by a navigation under the poll: retry until the deadline.
      }
      if (!result) failed.push("the page could not be read");
      else if (result.ok !== true) return { done: false, fatal: true, detail: typeof result.error === "string" ? result.error : "the page script failed" };
      else {
        if (expectation.selector !== undefined && result.selector !== true) failed.push(`element ${expectation.selector} is not visible`);
        if (expectation.text !== undefined && result.text !== true) {
          const quoted = expectation.text.length > EXPECT_TEXT_MAX ? `${expectation.text.slice(0, EXPECT_TEXT_MAX)}...` : expectation.text;
          failed.push(`text "${quoted}" is not on the page`);
        }
      }
    }
    if (expectation.url !== undefined) {
      const actual = page.getURL();
      if (!matchUrlPattern(expectation.url, actual)) failed.push(`URL ${redactUrl(actual)} does not match the expected pattern`);
    }
    return failed.length === 0 ? { done: true } : { done: false, detail: failed.join("; ") };
  });
  if (outcome.ok) return;
  throw new FixtureError(outcome.fatal ? `expect failed: ${outcome.detail}` : `expect failed after ${timeoutMs}ms: ${outcome.detail}`);
}

/** http(s) origins the fixture itself navigates to: `fresh` must clear their storage whatever the target saw. */
function fixtureOrigins(fixture: PageFixture): string[] {
  const urls = [
    ...(fixture.url ? [fixture.url] : []),
    ...(fixture.tabs ?? []),
    ...(fixture.storage?.origins ?? []).map((o) => o.origin),
    ...(fixture.steps ?? []).flatMap((step) => (step.action === "goto" ? [step.url] : [])),
  ];
  const origins = new Set<string>();
  for (const url of urls) {
    const origin = httpOrigin(url);
    if (origin) origins.add(origin);
  }
  return [...origins];
}

function once(fn: () => Promise<void>): () => Promise<void> {
  let done: Promise<void> | undefined;
  return () => (done ??= fn());
}

/** Counts only: no cookie name, no storage key, no value. */
function summarize(fixture: PageFixture): string {
  const parts = fixtureStateParts(fixture);
  const steps = fixture.steps?.length ?? 0;
  if (steps) parts.push(plural(steps, "setup step"));
  const mocks = fixture.network?.length ?? 0;
  if (mocks) parts.push(plural(mocks, "network mock"));
  if (fixture.fresh) parts.push("fresh session");
  if (fixture.expect) parts.push("expect checked");
  return parts.length ? parts.join("; ") : "no state to prepare";
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** Closes a tab opened after an abort and gives the current-tab role back, so a
 * late tab never changes what the next command acts on. Best effort. */
async function abandonTab(ctx: Ctx, tabId: number): Promise<void> {
  try {
    await ctx.target.closePage?.(tabId);
    if (ctx.mainId !== undefined) await ctx.target.selectPage?.(ctx.mainId);
  } catch {
    // Nothing more can be done for a tab the target no longer lets us touch.
  }
}

/** Opens a blank new tab that becomes current. `newPage()` takes no url (the desktop target
 * ignores it), so the tab is created first and the caller loads it: this order lets the
 * emulation be installed BEFORE the first load of the tab. */
async function openBlankTab(ctx: Ctx): Promise<void> {
  throwIfAborted(ctx.signal);
  if (ctx.hooks?.newTab) {
    takeHookResult(ctx, await ctx.hooks.newTab(ctx.signal));
    return;
  }
  const info = await ctx.target.newPage!();
  if (ctx.signal?.aborted) {
    await abandonTab(ctx, info.tabId);
    throw new FixtureError("aborted");
  }
}

/** Loads `url` in the tab that is current now (the new tab, not the main tab). */
async function loadCurrentTab(ctx: Ctx, tab: BrowserPageHandle, url: string): Promise<void> {
  throwIfAborted(ctx.signal);
  if (ctx.hooks?.navigate) takeHookResult(ctx, await ctx.hooks.navigate(url, ctx.signal));
  else await load(tab, url, ctx.signal);
}

async function run(ctx: Ctx, fixture: PageFixture): Promise<FixtureApplyResult> {
  const { target, signal } = ctx;
  const rules = fixture.network ?? [];
  const cookies = fixture.storage?.cookies ?? [];
  const origins = fixture.storage?.origins ?? [];
  const tabs = fixture.tabs ?? [];
  throwIfAborted(signal);
  // Every capability is checked before anything changes, under the stage of the feature checked.
  enter(ctx, "prepare");
  if (fixture.fresh) {
    enter(ctx, "reset");
    if (!target.resetSession) throw new FixtureError("this browser cannot reset its session");
  }
  if (rules.length > 0) {
    enter(ctx, "network");
    if (!ctx.allowNetworkMocks) throw new FixtureError("network mocks are disabled (allowNetworkMocks is off)");
    if (!target.routeRequests) throw new FixtureError("this browser cannot mock network requests");
  }
  if (cookies.length > 0) {
    enter(ctx, "cookies");
    if (!target.setCookies) throw new FixtureError("this browser target cannot set cookies (setCookies is missing)");
  }
  if (fixture.emulate) {
    enter(ctx, "emulate");
    // A page that exists now is checked up front; one that is created later is checked when it is emulated.
    const existing = target.currentPage();
    if (existing && !existing.sendCdp) throw new FixtureError(EMULATION_UNSUPPORTED);
  }
  if (tabs.length > 0) {
    enter(ctx, "tabs");
    if (!(target.newPage && target.listPages && target.selectPage)) {
      throw new FixtureError("this browser target cannot open extra tabs (newPage, listPages or selectPage is missing)");
    }
  }
  // An abort here is not the fault of any feature: it reports `prepare`.
  enter(ctx, "prepare");
  throwIfAborted(signal);

  if (fixture.fresh) {
    enter(ctx, "reset");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tooLong = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new FixtureError("resetting the session took too long")), RESET_BUDGET_MS);
    });
    try {
      await Promise.race([target.resetSession!(fixtureOrigins(fixture)), tooLong]);
    } catch (err) {
      if (signal?.aborted || err instanceof FixtureError) throw err;
      throw new FixtureError(`resetting the session failed: ${toMessage(err)}`);
    } finally {
      clearTimeout(timer);
      tooLong.catch(() => {});
    }
    throwIfAborted(signal);
  }

  if (rules.length > 0) {
    enter(ctx, "network");
    let remove: () => Promise<void>;
    try {
      remove = await target.routeRequests!(createNetworkHandler(rules));
    } catch (err) {
      // The target's message may quote a rule.
      if (signal?.aborted) throw err;
      throw new FixtureError("installing network mocks failed");
    }
    // Set before the abort check: a failure from here on removes the mocks.
    addCleanup(ctx, remove);
    throwIfAborted(signal);
  }

  if (cookies.length > 0) {
    enter(ctx, "cookies");
    try {
      await target.setCookies!(cookies);
    } catch {
      // The target's message may quote a cookie.
      throw new FixtureError("setting cookies failed");
    }
  }

  // The main tab: the one that is current now. A target that lists no tabs has one.
  enter(ctx, "prepare");
  await target.ensurePage();
  if (target.listPages) {
    const current = (await target.listPages()).find((t) => t.current);
    if (!current) throw new FixtureError("the browser reports no current tab");
    ctx.mainId = current.tabId;
  }

  if (fixture.emulate) {
    enter(ctx, "emulate");
    await emulatePage(ctx, await mainPage(ctx), fixture, "main tab");
  }

  for (const [i, entry] of origins.entries()) {
    const label = `storage origin ${i + 1}`;
    if (!entry.localStorage && !entry.sessionStorage) continue;
    enter(ctx, "storage");
    let page: BrowserPageHandle;
    try {
      page = await navigate(ctx, `${entry.origin}/`);
    } catch (err) {
      throw new FixtureError(`${label}: ${toMessage(err)}`);
    }
    if (!sameOrigin(page.getURL(), entry.origin)) throw new FixtureError(`${label}: the page redirected to another origin`);
    let result: Record<string, unknown>;
    try {
      result = await runScript(page, storageScript(entry.localStorage ?? {}, entry.sessionStorage ?? {}));
    } catch {
      throw new FixtureError(`${label}: the storage script failed`);
    }
    if (result.ok !== true) {
      const name = typeof result.name === "string" ? result.name.slice(0, 40) : "Error";
      throw new FixtureError(`${label}: writing storage failed (${name})`);
    }
  }

  if (fixture.url) {
    enter(ctx, "url");
    try {
      await navigate(ctx, fixture.url);
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new FixtureError(`start page: ${toMessage(err)}`);
    }
  }

  if (tabs.length > 0) enter(ctx, "tabs");
  for (const [i, url] of tabs.entries()) {
    // Blank tab first, then emulation, then the first load: the page never loads without the emulation.
    // Legacy host (deprecated `openTab` hook, no `newTab`): the hook opens AND loads the tab, so the
    // emulation below comes after the first load. That load is not emulated.
    const legacyOpen = !ctx.hooks?.newTab ? ctx.hooks?.openTab : undefined;
    try {
      if (legacyOpen) {
        throwIfAborted(signal);
        takeHookResult(ctx, await legacyOpen(url, signal));
      } else {
        await openBlankTab(ctx);
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new FixtureError(`extra tab ${i + 1}: ${toMessage(err)}`);
    }
    const tab = target.currentPage();
    if (!tab) throw new FixtureError(`extra tab ${i + 1}: the new tab has no page`);
    if (fixture.emulate) {
      enter(ctx, "emulate");
      await emulatePage(ctx, tab, fixture, `extra tab ${i + 1}`);
      enter(ctx, "tabs");
    }
    if (legacyOpen) continue;
    try {
      await loadCurrentTab(ctx, tab, url);
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new FixtureError(`extra tab ${i + 1}: ${toMessage(err)}`);
    }
  }

  const steps = fixture.steps ?? [];
  if (steps.length > 0) enter(ctx, "steps");
  for (const [i, step] of steps.entries()) {
    throwIfAborted(signal);
    const outcome = await runStep(ctx, step);
    if (!outcome.ok) {
      const subject = "selector" in step ? step.selector : "url" in step ? redactUrl(step.url) : "key" in step ? step.key : "";
      throw new FixtureError(`step ${i + 1} (${step.action}${subject ? ` ${subject}` : ""}) failed: ${outcome.error}`);
    }
  }

  if (fixture.expect) {
    enter(ctx, "expect");
    await checkExpect(ctx, fixture.expect);
  }

  // A new tab became current: the agent works on the main tab. This read is `prepare`, not the stage of the last feature.
  enter(ctx, "prepare");
  const page = await mainPage(ctx);
  return { ok: true, url: page.getURL(), title: page.getTitle(), summary: summarize(fixture), ...(ctx.release ? { release: ctx.release } : {}) };
}

/** Per-navigation and per-settle budgets a host may know better than the standalone defaults. */
export interface FixtureBudgetOptions {
  /** Longest one navigation may take. Default 30 s. */
  navigationMs?: number;
  /** Longest a click or key press may take to settle. Default 10 s. */
  settleMs?: number;
}

/**
 * Upper bound of the time `applyFixture` may take, for a host that wants one
 * overall deadline (the controller does): every navigation, script and settle
 * at its own cap, every wait at its length. Capped at five minutes, but the
 * cap never cuts below one navigation plus two scripts.
 */
export function fixtureBudgetMs(fixture: PageFixture, opts: FixtureBudgetOptions = {}): number {
  const nav = opts.navigationMs ?? LOAD_TIMEOUT_MS;
  const settle = opts.settleMs ?? SETTLE_TIMEOUT_MS;
  const loads = (fixture.storage?.origins?.length ?? 0) + (fixture.url ? 1 : 0) + (fixture.tabs?.length ?? 0);
  let total = loads * nav + SCRIPT_TIMEOUT_MS;
  if (fixture.fresh) total += nav + RESET_BUDGET_MS;
  if (fixture.network?.length) total += SCRIPT_TIMEOUT_MS;
  if (fixture.emulate) total += (1 + (fixture.tabs?.length ?? 0)) * SCRIPT_TIMEOUT_MS;
  if (fixture.expect) total += Math.min(fixture.expect.timeoutMs ?? FIXTURE_WAIT_FOR_DEFAULT_MS, FIXTURE_MAX_WAIT_MS) + SCRIPT_TIMEOUT_MS;
  for (const step of fixture.steps ?? []) {
    if (step.action === "goto") total += nav;
    else if (step.action === "wait") total += step.ms;
    else if (step.action === "waitFor") total += Math.min(step.timeoutMs ?? FIXTURE_WAIT_FOR_DEFAULT_MS, FIXTURE_MAX_WAIT_MS) + SCRIPT_TIMEOUT_MS;
    else if (step.action === "click" || step.action === "press" || step.action === "select") total += SCRIPT_TIMEOUT_MS + settle;
    else total += SCRIPT_TIMEOUT_MS;
  }
  return Math.min(total, Math.max(MAX_BUDGET_MS, nav + 2 * SCRIPT_TIMEOUT_MS));
}

/**
 * `applyFixture` for a fixture that `parsePageFixture` already validated (the
 * controller parses once, to size its deadline). Same result, same redaction.
 */
export async function applyParsedFixture(
  target: BrowserTarget,
  fixture: PageFixture,
  opts: FixtureApplyOptions = {},
  hooks?: FixtureHooks,
): Promise<FixtureApplyResult> {
  const ctx: Ctx = {
    target,
    signal: opts.signal,
    hooks,
    mainId: undefined,
    dialogs: [],
    allowNetworkMocks: opts.allowNetworkMocks === true,
    stage: "validate",
    release: undefined,
    cleanups: [],
  };
  const withDialogs = <T extends FixtureApplyResult>(result: T): T => (ctx.dialogs.length > 0 ? { ...result, dialogs: ctx.dialogs } : result);
  try {
    const result = await run(ctx, fixture);
    // An apply that finishes after its signal aborted (the host stopped waiting) has no owner: its mocks go now.
    if (opts.signal?.aborted && ctx.release) throw new FixtureError("aborted");
    return withDialogs(result);
  } catch (err) {
    // Mocks of a failed apply must not outlive it.
    try {
      await ctx.release?.();
    } catch {
      // Nothing more can be done for a route the target no longer lets us remove.
    }
    const message = err instanceof FixtureError ? err.message : `applying the fixture failed: ${toMessage(err)}`;
    return withDialogs({ ok: false, stage: ctx.stage, error: redactUrls(message) });
  }
}

/**
 * Put `target` into the state `fixture` describes. Never rejects: a failure is
 * `{ ok: false, error }`. The error holds no cookie or storage data and no URL
 * query or hash. A failed step stops the apply with
 * `step N (<action> <selector>) failed: <reason>`. The caller serializes it
 * against other browser commands (the controller does). `hooks` is for a host
 * that has its own navigation, tab and key code (see `FixtureHooks`).
 */
export async function applyFixture(
  target: BrowserTarget,
  fixture: PageFixture,
  opts: FixtureApplyOptions = {},
  hooks?: FixtureHooks,
): Promise<FixtureApplyResult> {
  const parsed = parsePageFixture(fixture);
  if (!parsed.ok) return { ok: false, stage: "validate", error: parsed.error };
  return applyParsedFixture(target, parsed.value, opts, hooks);
}
