// Renders a recorded QA run (`BrowseTrace` with `repro` data) as a Playwright `.spec.ts` file
// (docs/specs/2026-10-26-playwright-spec-export-design.md, "Renderer"). Pure and zod-free: it
// imports only types and `describeQaCheck`. Every string that ends up in code goes through
// `JSON.stringify`; every string that ends up in a comment goes through `oneLine` (or is split
// per line and prefixed with `//`), so no run text can break out of a comment or a literal.
import { normalizePattern } from "../fixture/network.js";
import type { FixtureEmulate } from "../fixture/types.js";
import { describeQaCheck, validateQaCheck } from "./qaChecks.js";
import type { QaCheck } from "./qaTypes.js";
import type { BrowseTrace, BrowseTraceReproAction, ReproLocator, ReproNetworkRule } from "./trace.js";

export type PlaywrightSpecResult =
  | { ok: true; code: string; fileName: string; actions: number; gaps: number; failingChecks: number }
  | { ok: false; error: string };

/** The ARIA roles `page.getByRole` accepts (Playwright's `AriaRole` type). */
export const PLAYWRIGHT_ARIA_ROLES: ReadonlySet<string> = new Set(
  (
    "alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary " +
    "contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img " +
    "insertion link list listbox listitem log main marquee math meter menu menubar menuitem menuitemcheckbox menuitemradio navigation " +
    "none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox " +
    "separator slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time timer toolbar " +
    "tooltip tree treegrid treeitem"
  ).split(" "),
);

const LINE_BREAK = /\r\n|[\n\r\u2028\u2029\u0085]/;
const TITLE_MAX = 100;
const FILE_STEM_MAX = 60;
const COMMENT_MAX = 300;

/** A string literal. JSON.stringify, plus the two line separators older parsers reject inside a literal. */
const q = (s: string): string => JSON.stringify(s).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
/** One line of comment text: line breaks become spaces, long text is cut. */
const oneLine = (s: string, max = COMMENT_MAX): string => {
  const t = s.split(LINE_BREAK).join(" ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}...` : t;
};
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const regexExpr = (source: string): string => `new RegExp(${q(source)})`;
const cssString = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').split(LINE_BREAK).join("\\a ");

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const LOCATOR_STRING_KINDS = new Set(["testid", "placeholder", "label", "alt", "text", "title", "css"]);
const OPS = new Set(["goto", "click", "fill", "select", "press", "hover", "back", "forward", "reload", "viewport", "expect", "gap"]);

/** True when `l` has the shape of a `ReproLocator` (untrusted JSON). */
function isLocator(l: unknown): l is ReproLocator {
  if (!isRec(l) || !isStr(l.kind)) return false;
  if (LOCATOR_STRING_KINDS.has(l.kind)) return isStr(l.value);
  if (l.kind === "attr") return (l.name === "data-test" || l.name === "data-qa") && isStr(l.value);
  if (l.kind === "role") return isStr(l.role) && (l.name === undefined || isStr(l.name));
  return false;
}

type Rendered = { ok: true; expr: string } | { ok: false; gap: string };

/** The `page.…` expression of a locator, or a gap reason. */
function renderLocator(l: ReproLocator | undefined): Rendered {
  if (l === undefined) return { ok: false, gap: "missing locator" };
  if (!isLocator(l)) return { ok: false, gap: "invalid recorded action" };
  const exact = (fn: string, v: string) => ({ ok: true as const, expr: `page.${fn}(${q(v)}, { exact: true })` });
  switch (l.kind) {
    case "testid":
      return { ok: true, expr: `page.getByTestId(${q(l.value)})` };
    case "attr":
      return { ok: true, expr: `page.locator(${q(`[${l.name}="${cssString(l.value)}"]`)})` };
    case "role":
      if (!PLAYWRIGHT_ARIA_ROLES.has(l.role)) return { ok: false, gap: `unknown role ${oneLine(String(l.role), 60)}` };
      return { ok: true, expr: l.name !== undefined ? `page.getByRole(${q(l.role)}, { name: ${q(l.name)}, exact: true })` : `page.getByRole(${q(l.role)})` };
    case "placeholder":
      return exact("getByPlaceholder", l.value);
    case "label":
      return exact("getByLabel", l.value);
    case "alt":
      return exact("getByAltText", l.value);
    case "text":
      return exact("getByText", l.value);
    case "title":
      return exact("getByTitle", l.value);
    case "css":
      return { ok: true, expr: `page.locator(${q(l.value)})` };
    default:
      return { ok: false, gap: "invalid recorded action" };
  }
}

/** A short human text of a locator, for comment lines. */
function describeLocator(l: ReproLocator | undefined): string {
  if (!isLocator(l)) return "";
  switch (l.kind) {
    case "role":
      return l.name !== undefined ? `${l.role} "${l.name}"` : l.role;
    case "testid":
      return `test id "${l.value}"`;
    case "attr":
      return `[${l.name}="${l.value}"]`;
    case "css":
      return l.value;
    default:
      return `${l.kind} "${l.value}"`;
  }
}

function describeAction(a: BrowseTraceReproAction): string {
  if (!isRec(a)) return "";
  if (isStr(a.note) && a.note !== "") return a.note;
  const on = describeLocator(a.locator);
  switch (a.op) {
    case "goto":
      return `goto ${isStr(a.url) ? a.url : ""}`.trim();
    case "fill":
      return `fill ${on}`.trim();
    case "press":
      return `press ${isStr(a.key) ? a.key : ""}${on ? ` on ${on}` : ""}`.trim();
    case "expect": {
      const v = isRec(a.check) ? validateQaCheck(a.check) : undefined;
      return v?.ok ? `check ${describeQaCheck(v.value)}` : "check";
    }
    case "gap":
      return "";
    default:
      return `${String(a.op)} ${on}`.trim();
  }
}

type EmitCtx = { secret: number; consoleErrors: boolean; failedRequests: boolean };

interface Piece {
  lines: string[];
  kind: "action" | "gap";
  failing?: boolean;
  /** The step is exported but differs from the run (a removed secret): it counts as a gap too. */
  alsoGap?: true;
}

const URL_NOTE = "// NOTE: a secret query value was removed from this URL";

const gapPiece = (reason: string): Piece => ({ kind: "gap", lines: [`// GAP: ${oneLine(reason)}`] });

function ignoreFilter(list: string[] | undefined, name: string): string {
  const ignore = (list ?? []).filter((s) => s !== "");
  if (ignore.length === 0) return `expect(${name}).toEqual([]);`;
  return `expect(${name}.filter((e) => !${JSON.stringify(ignore)}.some((i) => e.includes(i)))).toEqual([]);`;
}

/** Renders one check. `locator` is the check locator the recorder stored for an `index` check. */
function renderCheck(check: QaCheck, checkLocator: ReproLocator | undefined): string[] | { gap: string } {
  if (checkLocator !== undefined && !isLocator(checkLocator)) return { gap: "invalid recorded action" };
  const target = (c: { selector?: string; index?: number }): Rendered => {
    if (c.selector !== undefined) return { ok: true, expr: `page.locator(${q(c.selector)}).first()` };
    if (c.index !== undefined && !checkLocator) return { ok: false, gap: `check on element ${c.index}: no locator was recorded` };
    return renderLocator(checkLocator);
  };
  switch (check.type) {
    case "text":
      return [`await expect(page.locator("body"))${check.absent === true ? ".not" : ""}.toContainText(${q(check.text)}, { ignoreCase: true, useInnerText: true });`];
    case "element": {
      const t = target(check);
      if (!t.ok) return { gap: t.gap };
      const call: Record<string, string> = {
        visible: ".toBeVisible()",
        hidden: ".toBeHidden()",
        exists: ".toBeAttached()",
        absent: ".not.toBeAttached()",
        enabled: ".toBeEnabled()",
        disabled: ".toBeDisabled()",
        checked: ".toBeChecked()",
        unchecked: ".not.toBeChecked()",
      };
      const c = call[check.state];
      if (c === undefined) return { gap: `unknown element state ${oneLine(String(check.state), 40)}` };
      return [`await expect(${t.expr})${c};`];
    }
    case "value": {
      const t = target(check);
      if (!t.ok) return { gap: t.gap };
      const out: string[] = [];
      if (check.equals !== undefined) out.push(`await expect(${t.expr}).toHaveValue(${q(check.equals)});`);
      if (check.contains !== undefined) out.push(`await expect(${t.expr}).toHaveValue(${regexExpr(escapeRegex(check.contains))}); // case-sensitive, like the run`);
      return out.length > 0 ? out : { gap: "value check without equals or contains" };
    }
    case "count": {
      const loc = `page.locator(${q(check.selector)})${check.visible === true ? ".filter({ visible: true })" : ""}`;
      const out: string[] = [];
      if (check.equals !== undefined) out.push(`await expect(${loc}).toHaveCount(${check.equals});`);
      if (check.min !== undefined) out.push(`await expect.poll(() => ${loc}.count()).toBeGreaterThanOrEqual(${check.min});`);
      if (check.max !== undefined) out.push(`await expect.poll(() => ${loc}.count()).toBeLessThanOrEqual(${check.max});`);
      return out.length > 0 ? out : { gap: "count check without equals, min or max" };
    }
    case "url": {
      const out: string[] = [];
      if (check.equals !== undefined) out.push(`await expect(page).toHaveURL(${q(check.equals)});`);
      if (check.contains !== undefined) out.push(`await expect(page).toHaveURL(${regexExpr(escapeRegex(check.contains))}); // case-sensitive, like the run`);
      if (check.matches !== undefined) out.push(`await expect(page).toHaveURL(${regexExpr(check.matches)});`);
      return out.length > 0 ? out : { gap: "url check without equals, contains or matches" };
    }
    case "no_console_errors":
      return [ignoreFilter(check.ignore, "consoleErrors")];
    case "no_failed_requests":
      return [ignoreFilter(check.ignore, "failedRequests")];
    default:
      return { gap: `unknown check type ${oneLine(String((check as { type?: unknown }).type), 40)}` };
  }
}

const INVALID = "invalid recorded action";

function gotoPiece(url: string, redacted: boolean): Piece {
  const isRedacted = redacted || url.includes("[redacted]");
  const lines = [`await page.goto(${q(url)});`];
  return isRedacted ? { kind: "action", lines: [URL_NOTE, ...lines], alsoGap: true } : { kind: "action", lines };
}

/** One check (an agent `qa_assert` entry, a `waitFor` text, or a final check) as a piece. */
function expectPiece(a: { check?: unknown; passed?: unknown; actual?: unknown; error?: unknown; checkLocator?: unknown }, ctx: EmitCtx): Piece {
  if (isStr(a.error) && a.error !== "") return gapPiece(`check could not run in the run: ${oneLine(a.error)}`);
  if (!isRec(a.check)) return gapPiece(INVALID);
  const v = validateQaCheck(a.check);
  if (!v.ok) return gapPiece(INVALID);
  const check = v.value;
  const r = renderCheck(check, a.checkLocator as ReproLocator | undefined);
  if (!Array.isArray(r)) return gapPiece(r.gap);
  if (check.type === "no_console_errors") ctx.consoleErrors = true;
  if (check.type === "no_failed_requests") ctx.failedRequests = true;
  const failing = a.passed === false;
  const lines = failing ? [`// FAILED in the run: ${oneLine(isStr(a.actual) ? a.actual : "no details")}`, ...r] : r;
  return { kind: "action", lines, failing };
}

/** The steps of the QA fixture (start url, setup steps, extra tabs) as pieces. */
function setupPieces(setup: NonNullable<BrowseTrace["repro"]>["setup"], ctx: EmitCtx): Piece[] {
  const out: Piece[] = [];
  if (!setup) return out;
  const sel = (st: Record<string, unknown>) => (isStr(st.selector) && st.selector !== "" ? `page.locator(${q(st.selector)}).first()` : undefined);
  if (isStr(setup.url) && setup.url !== "") out.push(gotoPiece(setup.url, setup.urlRedacted === true));
  const steps: unknown[] = Array.isArray(setup.steps) ? setup.steps : [];
  for (const raw of steps) {
    if (!isRec(raw) || !isStr(raw.action)) {
      out.push(gapPiece(`fixture step: ${INVALID}`));
      continue;
    }
    const loc = sel(raw);
    const one = (line: string): Piece => ({ kind: "action", lines: [line] });
    switch (raw.action) {
      case "goto":
        out.push(isStr(raw.url) && raw.url !== "" ? gotoPiece(raw.url, raw.urlRedacted === true) : gapPiece("fixture goto without url"));
        break;
      case "click":
        out.push(loc ? one(`await ${loc}.click();`) : gapPiece(`fixture click: ${INVALID}`));
        break;
      case "type":
        if (!loc) out.push(gapPiece(`fixture type: ${INVALID}`));
        else if (raw.secret === true) {
          ctx.secret += 1;
          out.push(one(`await ${loc}.fill(process.env.QA_SECRET_${ctx.secret} ?? "");`));
        } else out.push(isStr(raw.text) ? one(`await ${loc}.fill(${q(raw.text)});`) : gapPiece("fixture type without text"));
        break;
      case "select":
        out.push(loc && isStr(raw.value) ? one(`await ${loc}.selectOption(${q(raw.value)});`) : gapPiece(`fixture select: ${INVALID}`));
        break;
      case "press":
        if (!isStr(raw.key) || raw.key === "") out.push(gapPiece("fixture press without key"));
        else if (raw.selector !== undefined) out.push(loc ? one(`await ${loc}.press(${q(raw.key)});`) : gapPiece(`fixture press: ${INVALID}`));
        else out.push(one(`await page.keyboard.press(${q(raw.key)});`));
        break;
      case "waitFor": {
        if (!loc) {
          out.push(gapPiece(`fixture waitFor: ${INVALID}`));
          break;
        }
        // The fixture polls for the element to exist (not to be visible), 5000 ms by default.
        const timeout = isNum(raw.timeoutMs) ? Math.round(raw.timeoutMs) : 5000;
        out.push(one(`await expect(${loc}).toBeAttached({ timeout: ${timeout} });`));
        break;
      }
      case "wait":
        out.push(isNum(raw.ms) ? one(`await page.waitForTimeout(${Math.round(raw.ms)}); // fixed wait of the fixture`) : gapPiece("fixture wait without ms"));
        break;
      default:
        out.push(gapPiece(`fixture step: ${INVALID}`));
    }
  }
  if (isNum(setup.tabs) && setup.tabs > 0) out.push(gapPiece(`fixture opened ${Math.trunc(setup.tabs)} extra tab(s): not exported`));
  return out;
}

function renderAction(a: BrowseTraceReproAction, ctx: EmitCtx): Piece {
  if (!isRec(a) || !isStr(a.op) || !OPS.has(a.op)) return gapPiece(INVALID);
  if (a.locator !== undefined && !isLocator(a.locator)) return gapPiece(INVALID);
  const loc = () => renderLocator(a.locator);
  const act = (method: string, withArg?: string): Piece => {
    const l = loc();
    if (!l.ok) return gapPiece(`${a.op}: ${l.gap}`);
    return { kind: "action", lines: [`await ${l.expr}.${method}(${withArg ?? ""});`] };
  };
  switch (a.op) {
    case "goto":
      return isStr(a.url) && a.url !== "" ? gotoPiece(a.url, a.urlRedacted === true) : gapPiece("goto without url");
    case "click":
      return act("click");
    case "hover":
      return act("hover");
    case "fill": {
      if (a.secret === true) {
        const l = loc();
        if (!l.ok) return gapPiece(`fill: ${l.gap}`);
        ctx.secret += 1;
        return { kind: "action", lines: [`await ${l.expr}.fill(process.env.QA_SECRET_${ctx.secret} ?? "");`] };
      }
      if (!isStr(a.text)) return gapPiece("fill without text");
      return act("fill", q(a.text));
    }
    case "select":
      return isStr(a.value) ? act("selectOption", q(a.value)) : gapPiece("select without value");
    case "press": {
      if (!isStr(a.key) || a.key === "") return gapPiece("press without key");
      if (a.locator) return act("press", q(a.key));
      return { kind: "action", lines: [`await page.keyboard.press(${q(a.key)});`] };
    }
    case "back":
      return { kind: "action", lines: ["await page.goBack();"] };
    case "forward":
      return { kind: "action", lines: ["await page.goForward();"] };
    case "reload":
      return { kind: "action", lines: ["await page.reload();"] };
    case "viewport": {
      const v = a.viewport;
      if (!isRec(v) || !isNum(v.width) || !isNum(v.height)) return gapPiece(INVALID);
      return { kind: "action", lines: [`await page.setViewportSize({ width: ${Math.round(v.width)}, height: ${Math.round(v.height)} });`] };
    }
    case "expect":
      return expectPiece(a, ctx);
    case "gap":
      return gapPiece(isStr(a.gap) ? a.gap : "unknown");
    default:
      return gapPiece(INVALID);
  }
}

/** The `test.use` options of an emulation, and whether they use `devices`. */
function renderEmulate(e: FixtureEmulate): { entries: string[]; usesDevices: boolean } {
  const entries: string[] = [];
  let usesDevices = false;
  if (!isRec(e)) return { entries, usesDevices };
  const vp = e.viewport;
  const ownViewport = isRec(vp) && isNum(vp.width) && isNum(vp.height);
  switch (e.device) {
    case "iphone-15":
      entries.push('...devices["iPhone 15"]');
      usesDevices = true;
      break;
    case "pixel-8":
      entries.push('...devices["Pixel 7"]'); // closest in Playwright's list
      usesDevices = true;
      break;
    case "ipad":
      entries.push('...devices["iPad (gen 7)"]');
      usesDevices = true;
      break;
    case "desktop-1440":
      if (!ownViewport) entries.push("viewport: { width: 1440, height: 900 }");
      break;
    case "desktop-1920":
      if (!ownViewport) entries.push("viewport: { width: 1920, height: 1080 }");
      break;
    default:
      break;
  }
  if (isRec(vp) && isNum(vp.width) && isNum(vp.height)) {
    entries.push(`viewport: { width: ${Math.round(vp.width)}, height: ${Math.round(vp.height)} }`);
    if (isNum(vp.deviceScaleFactor)) entries.push(`deviceScaleFactor: ${vp.deviceScaleFactor}`);
    if (typeof vp.mobile === "boolean") entries.push(`isMobile: ${vp.mobile}`);
  }
  if (typeof e.touch === "boolean") entries.push(`hasTouch: ${e.touch}`);
  if (isStr(e.userAgent)) entries.push(`userAgent: ${q(e.userAgent)}`);
  if (isStr(e.locale)) entries.push(`locale: ${q(e.locale)}`);
  if (isStr(e.timezone)) entries.push(`timezoneId: ${q(e.timezone)}`);
  if (e.colorScheme === "light" || e.colorScheme === "dark") entries.push(`colorScheme: ${q(e.colorScheme)}`);
  if (typeof e.reducedMotion === "boolean") entries.push(`reducedMotion: ${q(e.reducedMotion ? "reduce" : "no-preference")}`);
  return { entries, usesDevices };
}

/** A `page.route` call for one mock rule. `n` is the 1-based position in the fixture (unique variable names). */
function renderMock(rule: ReproNetworkRule, n: number): { lines: string[]; gap?: true } | null {
  if (!isRec(rule) || !isStr(rule.url) || rule.url === "") return null;
  if (rule.method !== undefined && !isStr(rule.method)) return null;
  if (rule.status !== undefined && !(isNum(rule.status) && Number.isInteger(rule.status) && rule.status >= 100 && rule.status <= 599)) return null;
  if (rule.delayMs !== undefined && !isNum(rule.delayMs)) return null;
  if (rule.times !== undefined && !isNum(rule.times)) return null;
  if (rule.abort !== undefined && typeof rule.abort !== "boolean") return null;
  if (rule.headers !== undefined && !(isRec(rule.headers) && Object.values(rule.headers).every(isStr))) return null;
  if (rule.body !== undefined && !isStr(rule.body) && !isRec(rule.body) && !Array.isArray(rule.body)) return null;
  if (rule.gap !== undefined && !isStr(rule.gap)) return null;
  if (isStr(rule.gap) && rule.gap !== "") return { lines: [`  // GAP: ${oneLine(rule.gap)}`], gap: true };
  // The run's matcher (`matchUrlPattern`): the same normalized pattern, `*` is any run of characters, the whole URL, case-sensitive.
  const pattern = normalizePattern(rule.url).split("*").map(escapeRegex).join("[\\s\\S]*");
  const hasType = Object.keys(rule.headers ?? {}).some((k) => k.toLowerCase() === "content-type");
  const method = rule.method ? rule.method.toUpperCase() : undefined;
  const times = rule.times !== undefined ? Math.round(rule.times) : undefined;
  // Playwright's `times` counts a route the handler passed on with `fallback()` too, so with a method filter we count ourselves.
  const counter = method !== undefined && times !== undefined ? `mockHits${n}` : undefined;
  const handler: string[] = [];
  if (method !== undefined) {
    const over = counter ? ` || ${counter} >= ${times}` : "";
    handler.push(`    if (route.request().method() !== ${q(method)}${over}) return route.fallback();`);
  }
  if (counter) handler.push(`    ${counter}++;`);
  if (rule.delayMs) handler.push(`    await new Promise((r) => setTimeout(r, ${Math.round(rule.delayMs)}));`);
  if (rule.abort === true) {
    handler.push("    await route.abort();");
  } else {
    const fields = [`status: ${rule.status ?? 200}`];
    if (rule.headers && Object.keys(rule.headers).length > 0) fields.push(`headers: ${JSON.stringify(rule.headers)}`);
    if (rule.body !== undefined) {
      if (typeof rule.body === "string") {
        if (!hasType && isJsonContainer(rule.body)) fields.push('contentType: "application/json"');
        fields.push(`body: ${q(rule.body)}`);
      } else {
        if (!hasType) fields.push('contentType: "application/json"');
        fields.push(`body: ${q(JSON.stringify(rule.body))}`);
      }
    }
    handler.push(`    await route.fulfill({ ${fields.join(", ")} });`);
  }
  const option = !counter && times !== undefined ? `, { times: ${times} }` : "";
  const notes: string[] = [];
  if (rule.bodyRedacted === true) notes.push("  // NOTE: secret values in this mock body were replaced");
  if (rule.headersRedacted === true) notes.push("  // NOTE: secret headers of this mock were removed");
  return {
    lines: [...notes, ...(counter ? [`  let ${counter} = 0;`] : []), `  await page.route(${regexExpr(`^${pattern}$`)}, async (route) => {`, ...handler, `  }${option});`],
  };
}

/** True when `text` parses as a JSON object or array. */
function isJsonContainer(text: string): boolean {
  try {
    const v: unknown = JSON.parse(text);
    return !!v && typeof v === "object";
  } catch {
    return false;
  }
}

function slug(s: string): string {
  const base = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, FILE_STEM_MAX).replace(/-+$/, "");
  return base === "" ? "browse-run" : base;
}

/** Renders a Playwright spec file from a QA run trace that was recorded with `repro`. */
export function browseTraceToPlaywrightSpec(trace: BrowseTrace, opts?: { title?: string }): PlaywrightSpecResult {
  try {
    return build(trace, opts);
  } catch {
    return { ok: false, error: "The trace is malformed: it cannot be exported as a Playwright test." };
  }
}

function build(trace: BrowseTrace, opts?: { title?: string }): PlaywrightSpecResult {
  if (!isRec(trace)) return { ok: false, error: "The trace is malformed: it cannot be exported as a Playwright test." };
  const steps = (Array.isArray(trace.steps) ? trace.steps : []).filter(isRec);
  if (!isRec(trace.repro) && !steps.some((s) => s.repro !== undefined)) {
    return { ok: false, error: "This trace has no repro data: it was recorded without repro, so it cannot be exported as a Playwright test." };
  }
  const rawSetup: unknown = isRec(trace.repro) ? trace.repro.setup : undefined;
  const setup = isRec(rawSetup) ? (rawSetup as NonNullable<NonNullable<BrowseTrace["repro"]>["setup"]>) : undefined;
  const ctx: EmitCtx = { secret: 0, consoleErrors: false, failedRequests: false };
  let actions = 0;
  let gaps = 0;
  let failingChecks = 0;

  const take = (pieces: Piece[], into: string[]) => {
    for (const piece of pieces) {
      if (piece.kind === "gap") gaps += 1;
      else actions += 1;
      if (piece.alsoGap) gaps += 1;
      if (piece.failing) failingChecks += 1;
      for (const l of piece.lines) into.push(`  ${l}`);
    }
  };
  const setupLines: string[] = [];
  const setupList = setupPieces(setup, ctx);
  if (setupList.length > 0) {
    setupLines.push("  // Setup from the QA fixture");
    take(setupList, setupLines);
  }
  const stepLines: string[] = [];
  for (const step of steps) {
    const list = step.repro;
    if (!Array.isArray(list) || list.length === 0) continue;
    const notes = list.map(describeAction).filter((n) => n !== "");
    const note = notes.length > 0 ? ` ${oneLine(notes.join("; "), 120)}` : "";
    const stepNo = isNum(step.index) ? Math.trunc(step.index) + 1 : stepLines.length + 1;
    stepLines.push(`  // Step ${stepNo}: ${oneLine(String(step.tool), 60)}${note}`);
    take(list.map((a) => renderAction(a, ctx)), stepLines);
  }

  const finalLines: string[] = [];
  const finals = (isRec(trace.qa) && Array.isArray(trace.qa.checks) ? trace.qa.checks : []).filter((c): c is NonNullable<typeof c> => isRec(c) && c.source === "final");
  if (finals.length > 0) {
    finalLines.push("  // Final checks of the QA run");
    take(finals.map((c) => expectPiece(c, ctx)), finalLines);
  }

  const mocks: unknown[] = Array.isArray(setup?.network) ? setup.network : [];
  const mockLines: string[] = [];
  if (mocks.length > 0) {
    // Playwright tries the route registered last first; our rules are first-match, so register in reverse.
    mockLines.push("  // Mocks from the QA setup (registered in reverse: Playwright tries the last route first).");
    for (let i = mocks.length - 1; i >= 0; i--) {
      const m = renderMock(mocks[i] as ReproNetworkRule, i + 1);
      if (m) {
        mockLines.push(...m.lines);
        if (m.gap) gaps += 1;
        else actions += 1;
      } else {
        gaps += 1;
        mockLines.push(`  // GAP: ${INVALID} (network mock)`);
      }
    }
  }

  const goal = isStr(trace.goal) ? trace.goal : "";
  const goalLines = goal.split(LINE_BREAK);
  const firstGoalLine = goalLines.map((l) => l.trim()).find((l) => l !== "") ?? "";
  const rawTitle = isStr(opts?.title) ? opts.title : firstGoalLine;
  const title = oneLine(rawTitle, 100_000).slice(0, TITLE_MAX).trimEnd() || "browse run";
  const fileName = `${slug(rawTitle.split(LINE_BREAK)[0] ?? "")}.spec.ts`;

  const header: string[] = [`// Generated by @sideform/browser-agent from browse trace ${oneLine(String(trace.id), 80)}.`];
  header.push(`// Scenario: ${goalLines[0] ?? ""}`.trimEnd());
  for (const l of goalLines.slice(1)) header.push(`// ${l}`.trimEnd());
  if (isRec(trace.qa)) {
    const reason = isStr(trace.qa.reason) && trace.qa.reason !== "" ? ` Reason: ${oneLine(trace.qa.reason)}` : "";
    header.push(`// QA outcome: ${oneLine(String(trace.qa.outcome), 40)}.${reason}`);
  }
  if (failingChecks > 0) header.push(`// ${failingChecks} check(s) failed in the run: this test fails until the bug is fixed.`);
  if (gaps > 0) header.push(`// ${gaps} step(s) could not be exported: see the GAP comments.`);
  if (ctx.secret > 0) {
    const names = Array.from({ length: ctx.secret }, (_, i) => `QA_SECRET_${i + 1}`).join(", ");
    header.push(`// Secret values were not recorded. Set these environment variables before you run the test: ${names}.`);
  }
  if (setup?.storage === true) header.push("// The cookies and storage of the QA setup are not exported.");
  if (setup?.app === true) header.push("// Electron app run: not replayable in a Playwright web test.");

  const emulate = setup?.emulate ? renderEmulate(setup.emulate) : { entries: [] as string[], usesDevices: false };
  const usesExpect = [...setupLines, ...stepLines, ...finalLines].some((l) => /^\s*(await )?expect[.(]/.test(l));
  const imports = ["test", ...(usesExpect ? ["expect"] : []), ...(emulate.usesDevices ? ["devices"] : [])];

  const out: string[] = [...header, `import { ${imports.join(", ")} } from "@playwright/test";`, ""];
  if (emulate.entries.length > 0) out.push(`test.use({ ${emulate.entries.join(", ")} });`, "");
  out.push(`test(${q(title)}, async ({ page }) => {`);
  if (setup?.app === true) out.push('  test.skip(true, "Electron app run: not replayable in a Playwright web test.");');
  out.push(...mockLines);
  if (ctx.consoleErrors) {
    out.push(
      "  const consoleErrors: string[] = [];",
      "  // Same text as the run: console.error text and uncaught page errors (the message), cut to 200 chars.",
      '  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });',
      '  page.on("pageerror", (e) => consoleErrors.push(String(e.message).slice(0, 200)));',
    );
  }
  if (ctx.failedRequests) {
    out.push(
      "  const failedRequests: string[] = [];",
      '  // Same entries as the run: "<METHOD> <status|errorText> <origin><path>" (no query, no hash), cut to 200 chars.',
      "  // The run skips requests the page canceled, data: URLs, WebSocket and EventSource. Playwright has no",
      '  // "canceled" flag, so net::ERR_ABORTED is skipped instead; a beacon (CDP "Ping") cannot be told apart.',
      '  const recordFailure = (r: import("@playwright/test").Request, what: string) => {',
      '    if (r.resourceType() === "websocket" || r.resourceType() === "eventsource") return;',
      "    let where: string;",
      "    try {",
      "      const u = new URL(r.url());",
      "      where = `${u.origin}${u.pathname}`;",
      "    } catch {",
      "      return;",
      "    }",
      '    if (where.startsWith("null")) return; // data: and other opaque origins',
      "    failedRequests.push(`${r.method()} ${what} ${where}`.slice(0, 200));",
      "  };",
      '  page.on("requestfailed", (r) => {',
      '    const what = r.failure()?.errorText || "failed";',
      '    if (what !== "net::ERR_ABORTED") recordFailure(r, what);',
      "  });",
      '  page.on("response", (r) => { if (r.status() >= 400) recordFailure(r.request(), String(r.status())); });',
    );
  }
  const preamble = out[out.length - 1] !== `test(${q(title)}, async ({ page }) => {`;
  const sections = [setupLines, stepLines, finalLines].filter((l) => l.length > 0);
  sections.forEach((lines, i) => {
    if (i > 0 || preamble) out.push("");
    out.push(...lines);
  });
  out.push("});", "");

  return { ok: true, code: out.join("\n"), fileName, actions, gaps, failingChecks };
}
