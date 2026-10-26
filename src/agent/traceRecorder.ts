// Records a browse run as a trace (docs/specs/2026-10-20-browse-run-trace-design.md).
// A host-side object fed from the same `executeTool` seam as the QA step
// recorder. Mechanism only: it builds the object; the host stores it.
// Zod-free (exported from `agent/session` and `agent`).
import { createSeenList, harvestDiagnostics, type SeenList } from "../shared/diagnostics.js";
import { normalizeScreenshot } from "../shared/image.js";
import type { QaResult } from "../shared/qaTypes.js";
import {
  BROWSE_TRACE_ANSWER_MAX_CHARS,
  BROWSE_TRACE_MAX_ACTIONS,
  BROWSE_TRACE_ERROR_MAX_CHARS,
  BROWSE_TRACE_FORMAT,
  BROWSE_TRACE_GOAL_MAX_CHARS,
  BROWSE_TRACE_ID,
  BROWSE_TRACE_OUTPUT_MAX_CHARS,
  BROWSE_TRACE_VERSION,
  REPRO_KEY,
  capTraceText,
  hasSecretWord,
  isSecretFieldName,
  isSecretHeaderName,
  isSecretKeyName,
  redactTraceArgsTracked,
  redactTraceRequest,
  redactTraceUrl,
  urlHasSecret,
  type BrowseTrace,
  type BrowseTraceAction,
  type BrowseTraceFrame,
  type BrowseTraceRepro,
  type BrowseTraceReproAction,
  type ReproCapture,
  type ReproFixtureStep,
  type ReproLocator,
  type ReproNetworkRule,
  type BrowseTraceLogEntry,
  type BrowseTraceRequest,
  type BrowseTraceStep,
} from "../shared/trace.js";
import type { QaCheck } from "../shared/qaTypes.js";
import { parseQaChecks } from "../shared/qaChecks.js";
import type { FixtureEmulate, FixtureNetworkRule, FixtureStep } from "../fixture/types.js";
import { parseJsonObject } from "./session.js";

type FrameKind = BrowseTraceFrame["kind"];

export interface BrowseTraceRecorderOptions {
  /** Default: a random 22-char id. An id that is not a `BROWSE_TRACE_ID` is replaced. */
  id?: string;
  goal: string;
  /** Default `Date.now`. */
  now?: () => number;
  labels?: Record<string, string>;
  /**
   * Takes a screenshot of the current page. Returns a data URL (or raw base64 of a jpeg, png or webp).
   * Every controller command drains the pending JS dialogs, a screenshot too: return them as `dialogs`
   * and the function that `onToolCall` returns hands them back to you, to merge into the tool output
   * (`mergeCarriedDialogs`). Otherwise tracing would hide them from the model.
   */
  capture?: () => Promise<{ imageData: string; width?: number; height?: number; dialogs?: unknown[] } | undefined>;
  /**
   * Which finished calls get a "step" frame. Default: `browse_open`; `browse_act`, except a lone `wait` (or a batch
   * of only `wait`); `browse_tabs` for `switch`, `close` and `new` (not `list`). A failed call gets a frame too (the
   * viewer shows the page at the failure; with the default only: not after a call refused by argument validation, and
   * not for a second failure in a row that already got a failure frame). A step whose typed text was redacted never gets a frame (the screenshot
   * would show it).
   */
  captureAfter?: (tool: string, args: unknown, ok: boolean) => boolean;
  /**
   * Default 4000. A timeout or a throw gives no frame and never an error. After ONE timeout the recorder takes no
   * more step captures in this run (a timed-out screenshot may still hold the browser), and every capture it
   * skips or loses is counted in `dropped.frames`.
   */
  captureTimeoutMs?: number;
  /** Default: the redaction of `redactTraceArgsTracked`, with memory of the last focused field for this run. */
  redactArgs?: (args: unknown) => unknown;
  /** Default 300. */
  maxSteps?: number;
  /** Default 150. */
  maxFrames?: number;
  /** Default 300, per log. */
  maxLogEntries?: number;
  /**
   * Source of the network request log (the host passes `() => bridge.requests()`). Resolves to the JSON text or
   * the object `{ requests, dropped? }` (`PageRequestEntry[]`, raw). Drained at the end of every finished step
   * (in the background, after the step frame: the step never waits for it; drains never overlap) and by `flush()`.
   * Each call is limited to 5000 ms; after ONE timeout the recorder stops calling it. Not called when `ctx.signal` is aborted. A throw gives no
   * entries. Without this option the trace has no `requests`.
   */
  requests?: () => Promise<unknown>;
  /** Default 500. Entries past it are counted in `dropped.requests`. */
  maxRequests?: number;
  /**
   * Playwright export recording (docs/specs/2026-10-26-playwright-spec-export-design.md). Default false. When true,
   * steps get `repro` and `finish()` writes `trace.repro`. The host also passes `repro: true` to the executor.
   * Without it a `__repro` key in an output is still removed from the recorded output, but nothing is stored.
   */
  repro?: boolean;
}

/** The browse_agent setup as `setRepro` reads it (a `PageFixture` or a bit more). Unknown fields are ignored. */
export interface BrowseTraceReproSetup {
  network?: FixtureNetworkRule[];
  url?: unknown;
  steps?: unknown;
  tabs?: unknown;
  emulate?: FixtureEmulate;
  storage?: unknown;
  cookies?: unknown;
  app?: unknown;
}

export interface BrowseTraceRecorder {
  readonly id: string;
  /**
   * Same shape as `StepRecorder.onToolCall`. The returned function is async:
   * await it before the result goes back to the model, so the step frame shows
   * the page right after this step. It never rejects. It resolves to `{ dialogs }` when the capture drained
   * JS dialogs: merge them into the output the model gets (`mergeCarriedDialogs`). No step frame is taken when `ctx.signal` is aborted
   * (the run was aborted or is past its deadline), and an abort during a capture ends the wait at once. Calls still pending at `finish()` become steps with
   * `ok: false` and `error: "unfinished"`.
   */
  onToolCall(call: { toolName: string; input: unknown }, ctx?: { signal?: AbortSignal }): (end: { output?: unknown; error?: unknown }) => Promise<{ dialogs?: unknown[] }>;
  /** Adds a frame (a data URL of a jpeg, png or webp). Anything else is ignored. */
  addFrame(frame: { imageData: string; kind?: FrameKind; width?: number; height?: number; stepIndex?: number }): void;
  /**
   * Waits for the background drains, then drains once more, limited to 2000 ms (the host awaits it before `finish`).
   * An abort does not stop it: an aborted run still gets its last requests. The entries get a `stepIndex`
   * only when their start lies inside a step. No-op without the option, or after `finish`. Never rejects.
   */
  flush(signal?: AbortSignal): Promise<void>;
  /** Stores the run setup for the Playwright export. No-op unless the `repro` option is on. Never throws. */
  setRepro(repro: { setup?: BrowseTraceReproSetup }): void;
  /** Builds the trace. Idempotent: a second call returns the same object. Never throws. */
  finish(end: { status: string; answer?: string; error?: string; qa?: QaResult }): BrowseTrace;
}

/** What `qa.steps[].args` holds in a trace. */
const QA_ARGS_OMITTED = "[omitted]";

const TAB_CAPTURE_ACTIONS: readonly string[] = ["switch", "close", "new"];

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** The default `captureAfter`: calls that can change what the page shows. */
function defaultCaptureAfter(tool: string, args: unknown, _ok: boolean): boolean {
  if (tool === "browse_open") return true;
  const input = isObject(args) ? args : {};
  if (tool === "browse_act") {
    const entries = Array.isArray(input.actions) ? input.actions : [input];
    return entries.some((e) => !isObject(e) || e.action !== "wait");
  }
  if (tool === "browse_tabs") return typeof input.action === "string" && TAB_CAPTURE_ACTIONS.includes(input.action);
  return false;
}

/** The per-action entries of a batched `browse_act` from its parsed result; undefined when the batch did not run. */
function batchActions(args: unknown, input: unknown, parsed: Record<string, unknown>): BrowseTraceAction[] | undefined {
  if (!isObject(input) || !Array.isArray(input.actions) || !Array.isArray(parsed.results) || typeof parsed.completed !== "number") return undefined;
  const named = isObject(args) && Array.isArray(args.actions) ? args.actions : [];
  const nameAt = (i: number): string => {
    const entry = named[i];
    return isObject(entry) && typeof entry.action === "string" && entry.action !== "" ? entry.action.slice(0, 64) : "act";
  };
  const out: BrowseTraceAction[] = [];
  const completed = Math.max(0, Math.min(Math.floor(parsed.completed), BROWSE_TRACE_MAX_ACTIONS));
  for (let i = 0; i < completed; i++) out.push({ action: nameAt(i), ok: true });
  if (typeof parsed.stoppedAt === "number" && parsed.stoppedAt >= 0 && parsed.stoppedAt < BROWSE_TRACE_MAX_ACTIONS) {
    const at = Math.floor(parsed.stoppedAt);
    const result = parsed.results[at];
    const error = isObject(result) && typeof result.error === "string" ? result.error : typeof parsed.error === "string" ? parsed.error : undefined;
    out.push({ action: nameAt(at), ok: false, ...(error !== undefined ? { error: capTraceText(error, BROWSE_TRACE_ERROR_MAX_CHARS) } : {}) });
  }
  return out;
}


// ---- Playwright export (repro) ----

function describeLocator(l: ReproLocator): string {
  switch (l.kind) {
    case "role":
      return l.name !== undefined ? `${l.role} "${l.name}"` : l.role;
    case "attr":
      return `${l.name} "${l.value}"`;
    default:
      return `${l.kind} "${l.value}"`;
  }
}

function note(text: string): string {
  return capTraceText(text, 120);
}

function asCapture(v: unknown): ReproCapture | undefined {
  return isObject(v) ? (v as ReproCapture) : undefined;
}

/** The repro actions of ONE `browse_act` entry. `redacted` is the entry as the (redacted) step args hold it. */
function actReproOf(entry: Record<string, unknown>, redacted: Record<string, unknown> | undefined, cap: ReproCapture | undefined): BrowseTraceReproAction[] {
  const action = typeof entry.action === "string" ? entry.action : "";
  const hasTarget = (typeof entry.target === "string" && entry.target !== "") || entry.index != null || (typeof entry.element === "string" && entry.element.trim() !== "");
  const gap = (reason: string, n?: string): BrowseTraceReproAction[] => [{ op: "gap", gap: reason, ...(n ? { note: note(n) } : {}) }];
  const targeted = (op: "click" | "hover" | "fill" | "select" | "press", extra: Partial<BrowseTraceReproAction>): BrowseTraceReproAction[] => {
    if (cap?.gap !== undefined) return gap(String(cap.gap), `${action} (${String(cap.gap)})`);
    if (!cap?.locator) return gap("not-found", `${action} (no locator)`);
    const where = describeLocator(cap.locator);
    return [{ op, locator: cap.locator, ...extra, note: note(`${op} ${where}`) }];
  };
  switch (action) {
    case "click":
    case "hover":
      return targeted(action, {});
    case "type": {
      // The text is kept only when the host's redacted args hold exactly the same text at the same place.
      // Anything else (masked, dropped, changed, no redacted copy) is a secret.
      const text = typeof entry.text === "string" ? entry.text : "";
      const secret = cap?.secret === true || (typeof entry.text === "string" && redacted?.text !== entry.text);
      return targeted("fill", secret ? { secret: true } : { text });
    }
    case "select":
      if (cap?.gap === undefined && cap?.locator && typeof cap.value !== "string") return gap("not-found", "select (no option value)");
      return targeted("select", typeof cap?.value === "string" ? { value: cap.value } : {});
    case "press": {
      const key = typeof entry.key === "string" ? entry.key : "";
      if (!hasTarget) return [{ op: "press", key, note: note(`press ${key}`) }];
      return targeted("press", { key });
    }
    case "back":
    case "forward":
    case "reload":
      return [{ op: action, note: action }];
    case "viewport":
      return cap?.viewport ? [{ op: "viewport", viewport: cap.viewport, note: "viewport" }] : [];
    case "upload":
      return gap("upload", "upload");
    default:
      return [];
  }
}

/** The repro actions of the completed entries of a batched `browse_act`; `partial` adds a gap for the entry it stopped at. */
function batchRepro(list: unknown[], red: Record<string, unknown>, parsed: Record<string, unknown>, capture: unknown, partial: boolean): BrowseTraceReproAction[] {
  const cap = isObject(capture) ? capture : {};
  const caps = Array.isArray(cap.batch) ? cap.batch : [];
  const redList = Array.isArray(red.actions) ? red.actions : [];
  const completed = typeof parsed.completed === "number" ? Math.max(0, Math.min(Math.floor(parsed.completed), BROWSE_TRACE_MAX_ACTIONS)) : 0;
  const out: BrowseTraceReproAction[] = [];
  for (let i = 0; i < completed; i++) {
    const entry = list[i];
    if (!isObject(entry)) continue;
    out.push(...actReproOf(entry, isObject(redList[i]) ? redList[i] : undefined, asCapture(caps[i])));
  }
  if (partial) {
    const at = typeof parsed.stoppedAt === "number" && parsed.stoppedAt >= 0 ? Math.floor(parsed.stoppedAt) : completed;
    const result = Array.isArray(parsed.results) ? parsed.results[at] : undefined;
    const error = isObject(result) && typeof result.error === "string" ? result.error : typeof parsed.error === "string" ? parsed.error : "unknown error";
    out.push({ op: "gap", gap: `batch stopped at action ${at + 1}: ${capTraceText(error.replace(/\s+/g, " ").trim(), 120)}` });
  }
  return out;
}

/** The repro actions of a batched `browse_act` that stopped part-way (the step failed), or undefined when nothing completed. */
function partialBatchRepro(input: unknown, redactedArgs: unknown, parsed: Record<string, unknown>, capture: unknown): BrowseTraceReproAction[] | undefined {
  if (!isObject(input) || !Array.isArray(input.actions)) return undefined;
  if (typeof parsed.completed !== "number" || parsed.completed <= 0) return undefined;
  return batchRepro(input.actions, isObject(redactedArgs) ? redactedArgs : {}, parsed, capture, true);
}

/** Maps a finished, ok step to repro actions. Returns undefined for read-only tools (nothing to record). */
function reproOfStep(tool: string, input: unknown, redactedArgs: unknown, parsed: Record<string, unknown>, capture: unknown): BrowseTraceReproAction[] | undefined {
  const inp = isObject(input) ? input : {};
  switch (tool) {
    case "browse_open": {
      if (typeof inp.app === "string" && inp.app.trim() !== "") return [{ op: "gap", gap: "electron app", note: "open app" }];
      const url = typeof parsed.url === "string" && parsed.url !== "" ? parsed.url : typeof inp.url === "string" ? inp.url : undefined;
      if (url === undefined) return [{ op: "gap", gap: "not-found", note: "open (no url)" }];
      return [{ op: "goto", url: redactTraceUrl(url), ...(urlHasSecret(url) ? { urlRedacted: true as const } : {}), note: "goto" }];
    }
    case "browse_act": {
      const red = isObject(redactedArgs) ? redactedArgs : {};
      if (Array.isArray(inp.actions)) return batchRepro(inp.actions, red, parsed, capture, false);
      return actReproOf(inp, red, asCapture(capture));
    }
    case "browse_screenshot": {
      const waitFor = inp.waitFor;
      if (isObject(waitFor) && typeof waitFor.text === "string" && waitFor.text !== "") {
        const check: QaCheck = { type: "text", text: waitFor.text } as QaCheck;
        return [{ op: "expect", check, passed: parsed.waitTimedOut !== true, note: note(`wait for text "${waitFor.text}"`) }];
      }
      return undefined;
    }
    case "qa_assert": {
      const parsedChecks = parseQaChecks(inp.checks);
      const checks: unknown[] = parsedChecks.ok ? parsedChecks.value : Array.isArray(inp.checks) ? inp.checks : [];
      const results = Array.isArray(parsed.results) ? parsed.results : [];
      const caps = isObject(capture) && Array.isArray(capture.checks) ? capture.checks : [];
      const out: BrowseTraceReproAction[] = [];
      checks.forEach((check, i) => {
        const r = isObject(results[i]) ? results[i] : {};
        const c = caps[i];
        const checkLocator = isObject(c) && isObject(c.locator) ? (c.locator as unknown as ReproLocator) : undefined;
        out.push({
          op: "expect",
          check: check as QaCheck,
          passed: r.passed === true,
          ...(typeof r.error === "string" && r.error !== "" ? { error: capTraceText(r.error, 200) } : {}),
          ...(typeof r.actual === "string" ? { actual: capTraceText(r.actual, 200) } : {}),
          ...(checkLocator ? { checkLocator } : {}),
          note: note(`assert ${isObject(check) && typeof check.type === "string" ? check.type : "check"}`),
        });
      });
      return out;
    }
    case "browse_tabs": {
      const a = typeof inp.action === "string" ? inp.action : "";
      return a === "new" || a === "switch" || a === "close" ? [{ op: "gap", gap: "tabs", note: `tabs ${a}` }] : undefined;
    }
    case "browse_snapshot":
    case "browse_read":
    case "browse_find_images":
    case "browse_capture":
    case "qa_verdict":
      return undefined;
    default:
      return [{ op: "gap", gap: tool, note: note(tool) }];
  }
}

const MOCK_BODY_MAX_CHARS = 200_000;
const MOCK_BODY_MAX_DEPTH = 40;
const REDACTED_VALUE = "[redacted]";

/** Deep copy of a JSON value; the value of a secret-named key becomes "[redacted]". Throws when too deep. */
function redactMockJson(value: unknown, depth: number, hit: { redacted: boolean }): unknown {
  if (!value || typeof value !== "object") return value;
  if (depth >= MOCK_BODY_MAX_DEPTH) throw new Error("too deep");
  if (Array.isArray(value)) return value.map((v) => redactMockJson(v, depth + 1, hit));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (isSecretKeyName(key)) {
      out[key] = REDACTED_VALUE;
      hit.redacted = true;
    } else out[key] = redactMockJson(v, depth + 1, hit);
  }
  return out;
}

/**
 * A mock rule of the setup as the trace keeps it. Never throws.
 * - url: kept as given (a pattern must stay a pattern). A secret query value, fragment value or userinfo marks the rule
 *   `gap` and the stored url is the redacted one.
 * - body: an object, or a string that parses as a JSON object or array: deep copy, secret-named keys lose their value
 *   (`bodyRedacted`); over 200 KB of JSON: `gap`. Any other string stays unless it holds a secret-looking word (`gap`).
 * - headers: a secret-named header is removed (`headersRedacted`).
 */
function redactRule(rule: FixtureNetworkRule): ReproNetworkRule {
  const out: ReproNetworkRule = { ...rule };
  try {
    delete out.headers;
    delete out.body;
    const url = String(rule.url);
    if (urlHasSecret(url)) {
      out.url = redactTraceUrl(url);
      out.gap = "mock url had a secret query value";
    } else out.url = url;
    if (rule.headers && typeof rule.headers === "object") {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(rule.headers)) {
        if (typeof value !== "string") continue;
        if (isSecretHeaderName(name)) out.headersRedacted = true;
        else headers[name] = value;
      }
      out.headers = headers;
    }
    if (rule.body === undefined) return out;
    let json: unknown;
    let isJsonString = false;
    if (typeof rule.body === "string") {
      try {
        const parsed: unknown = JSON.parse(rule.body.replace(/^\uFEFF/, ""));
        if (parsed && typeof parsed === "object") {
          json = parsed;
          isJsonString = true;
        }
      } catch {
        // Not JSON.
      }
      if (!isJsonString) {
        if (hasSecretWord(rule.body)) out.gap ??= "mock body has a secret-looking word";
        else if (rule.body.length > MOCK_BODY_MAX_CHARS) out.gap ??= "mock body too large";
        else out.body = rule.body;
        return out;
      }
    } else json = rule.body;
    const hit = { redacted: false };
    const copy = redactMockJson(json, 0, hit);
    const text = JSON.stringify(copy);
    if (text.length > MOCK_BODY_MAX_CHARS) out.gap ??= "mock body too large";
    else {
      out.body = isJsonString ? text : (copy as object);
      if (hit.redacted) out.bodyRedacted = true;
    }
  } catch {
    out.gap ??= "mock rule could not be recorded";
    delete out.body;
  }
  return out;
}

const FIXTURE_STEP_ACTIONS = new Set(["goto", "click", "type", "select", "press", "waitFor", "wait"]);

/** The fixture steps as the trace keeps them: urls redacted, the text typed into a secret-looking field dropped. */
function reproFixtureSteps(steps: unknown): ReproFixtureStep[] | undefined {
  if (!Array.isArray(steps)) return undefined;
  const out: ReproFixtureStep[] = [];
  for (const raw of steps.slice(0, 100)) {
    if (!isObject(raw) || typeof raw.action !== "string" || !FIXTURE_STEP_ACTIONS.has(raw.action)) continue;
    const st = raw as unknown as FixtureStep;
    switch (st.action) {
      case "goto":
        if (typeof st.url === "string") out.push({ action: "goto", url: redactTraceUrl(st.url), ...(urlHasSecret(st.url) ? { urlRedacted: true as const } : {}) });
        break;
      case "type":
        if (typeof st.selector === "string") {
          const secret = isSecretFieldName(st.selector) || typeof st.text !== "string";
          out.push({ action: "type", selector: st.selector, ...(secret ? { secret: true as const } : { text: st.text }) });
        }
        break;
      case "click":
        if (typeof st.selector === "string") out.push({ action: "click", selector: st.selector });
        break;
      case "waitFor":
        if (typeof st.selector === "string") out.push({ action: "waitFor", selector: st.selector, ...(typeof st.timeoutMs === "number" ? { timeoutMs: st.timeoutMs } : {}) });
        break;
      case "select":
        if (typeof st.selector === "string" && typeof st.value === "string") out.push({ action: "select", selector: st.selector, value: st.value });
        break;
      case "press":
        if (typeof st.key === "string") out.push({ action: "press", key: st.key, ...(typeof st.selector === "string" ? { selector: st.selector } : {}) });
        break;
      case "wait":
        if (typeof st.ms === "number") out.push({ action: "wait", ms: st.ms });
        break;
    }
  }
  return out;
}

/** Reads the `requests` source value: a JSON string or an object `{ requests, dropped? }` (or a bare array). */
function readRequestSource(value: unknown): { entries: unknown[]; dropped: number } {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return { entries: [], dropped: 0 };
    }
  }
  if (Array.isArray(v)) return { entries: v, dropped: 0 };
  if (!isObject(v) || !Array.isArray(v.requests)) return { entries: [], dropped: 0 };
  const dropped = typeof v.dropped === "number" && Number.isFinite(v.dropped) && v.dropped > 0 ? Math.floor(v.dropped) : 0;
  return { entries: v.requests, dropped };
}

/** More than the controller's own 3000 ms for `requests()`, so its answer is not cut. */
const REQUESTS_TIMEOUT_MS = 5000;
/** The time box of the last drain in `flush` (the run may already be over). */
const FLUSH_TIMEOUT_MS = 2000;

/** True when a `browse_act` result shows that no action ran: no `results` array, or at most the refused first entry. */
function nothingRan(parsed: Record<string, unknown>): boolean {
  return !Array.isArray(parsed.results) || (parsed.completed === 0 && parsed.results.length <= 1);
}
/** Errors of a call refused before it touched the page (execute.ts argument checks): a failure frame would repeat the last one. */
const PRE_EXECUTION_ERROR = /^(?:browse_act: (?:"actions" (?:must|accepts)|action "[^"]*" requires|actions\[\d+\] (?:is a viewport|uses "element"|must be))|Unknown browse tool)/;

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

function randomId(): string {
  const bytes = new Uint8Array(22);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
}

function textOfError(error: unknown): string {
  try {
    return capTraceText(error instanceof Error ? error.message : String(error), BROWSE_TRACE_ERROR_MAX_CHARS);
  } catch {
    return "error";
  }
}

/** A capped log of distinct texts (a full seen-set). Entries past the cap are counted, with the controller's own dropped counts. */
function createLog(max: number) {
  const entries: BrowseTraceLogEntry[] = [];
  const seen: SeenList = createSeenList(max, max);
  return {
    entries,
    seen,
    /** Records the new texts of `texts`. */
    add(fresh: readonly string[], at: number, stepIndex: number | undefined): void {
      for (const text of fresh) entries.push({ at, ...(stepIndex !== undefined ? { stepIndex } : {}), text });
    },
  };
}

export function createBrowseTraceRecorder(opts: BrowseTraceRecorderOptions): BrowseTraceRecorder {
  const now = opts.now ?? Date.now;
  const id = opts.id !== undefined && BROWSE_TRACE_ID.test(opts.id) ? opts.id : randomId();
  const redactState = { secretFocus: false };
  const captureAfter = opts.captureAfter ?? defaultCaptureAfter;
  const captureTimeoutMs = opts.captureTimeoutMs ?? 4000;
  const maxSteps = opts.maxSteps ?? 300;
  const maxFrames = opts.maxFrames ?? 150;
  const maxLog = opts.maxLogEntries ?? 300;
  const maxRequests = opts.maxRequests ?? 500;
  const startedAt = now();
  // One slot per call, taken when the call starts (index = call order); a call past `maxSteps` has no slot.
  const slots: { step: BrowseTraceStep; open: boolean }[] = [];
  const frames: BrowseTraceFrame[] = [];
  const consoleLog = createLog(maxLog);
  const networkLog = createLog(maxLog);
  let calls = 0;
  let nextFrameId = 0;
  let droppedSteps = 0;
  let droppedFrames = 0;
  let captureDisabled = false;
  const requestLog: BrowseTraceRequest[] = [];
  let droppedRequests = 0;
  let requestsDisabled = false;
  // Background drains run one after another, in step order. A drain never rejects.
  let requestQueue: Promise<void> = Promise.resolve();
  // The last recorded step failed and got a frame (consecutive failures get one).
  let prevFailureFramed = false;
  const scheduleDrain = (signal: AbortSignal | undefined, fallback: number | undefined) => {
    if (!opts.requests) return;
    // An aborted run schedules nothing new; a drain already queued still runs.
    if (signal?.aborted) return;
    requestQueue = requestQueue.then(() => drainRequests(fallback, REQUESTS_TIMEOUT_MS));
  };
  let finished: BrowseTrace | undefined;
  const reproOn = opts.repro === true;
  let reproSetup: BrowseTraceRepro["setup"];

  const addFrame: BrowseTraceRecorder["addFrame"] = (frame) => {
    try {
      if (finished || typeof frame.imageData !== "string") return;
      // A data URL, or raw base64 by its magic bytes. Anything `parseBrowseTrace` would reject is not a frame.
      const src = normalizeScreenshot(frame.imageData);
      if (!src) return;
      if (frames.length >= maxFrames) {
        droppedFrames += 1;
        // The oldest frame goes, the first one stays.
        if (maxFrames < 2) return;
        frames.splice(1, 1);
      }
      frames.push({
        id: nextFrameId++,
        at: now(),
        ...(frame.stepIndex !== undefined ? { stepIndex: frame.stepIndex } : {}),
        kind: frame.kind ?? "step",
        src,
        ...(frame.width !== undefined ? { width: frame.width } : {}),
        ...(frame.height !== undefined ? { height: frame.height } : {}),
      });
    } catch {
      // Ignored: the recorder never throws into the host.
    }
  };

  /** Takes the step frame. Returns the dialogs the screenshot drained. */
  async function capturePage(stepIndex: number | undefined, signal: AbortSignal | undefined): Promise<unknown[] | undefined> {
    if (!opts.capture) return undefined;
    // After a timeout the screenshot may still hold the browser: no more captures. An aborted run takes none either.
    if (captureDisabled || signal?.aborted) {
      droppedFrames += 1;
      return undefined;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const gone = Symbol("gone");
      const shot = await Promise.race([
        Promise.resolve().then(() => opts.capture!()),
        new Promise<typeof gone>((resolve) => {
          timer = setTimeout(() => {
            captureDisabled = true;
            resolve(gone);
          }, captureTimeoutMs);
          onAbort = () => resolve(gone);
          signal?.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      if (shot === gone) {
        droppedFrames += 1;
        return undefined;
      }
      if (!shot) return undefined;
      addFrame({ imageData: shot.imageData, kind: "step", width: shot.width, height: shot.height, stepIndex });
      return Array.isArray(shot.dialogs) && shot.dialogs.length > 0 ? shot.dialogs : undefined;
    } catch {
      // No frame, no error.
      return undefined;
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  /** The step whose [startedAt, endedAt] holds `at` (a step still open runs until now). */
  function stepAt(at: number): number | undefined {
    const t = now();
    for (const s of slots) {
      const end = s.open ? t : s.step.endedAt;
      if (at >= s.step.startedAt && at <= end) return s.step.index;
    }
    return undefined;
  }

  /** Drains the `requests` source into the log. `fallback`: the step of entries that lie in no step. Never throws. */
  async function drainRequests(fallback: number | undefined, timeoutMs: number): Promise<void> {
    if (!opts.requests || requestsDisabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const gone = Symbol("gone");
      const got = await Promise.race([
        Promise.resolve().then(() => opts.requests!()),
        new Promise<typeof gone>((resolve) => {
          timer = setTimeout(() => {
            requestsDisabled = true;
            resolve(gone);
          }, timeoutMs);
        }),
      ]);
      if (got === gone || finished) return;
      const { entries, dropped } = readRequestSource(got);
      droppedRequests += dropped;
      for (const raw of entries) {
        const entry = redactTraceRequest(raw);
        if (!entry) continue;
        if (requestLog.length >= maxRequests) {
          droppedRequests += 1;
          continue;
        }
        const stepIndex = stepAt(entry.at) ?? fallback;
        delete entry.stepIndex;
        requestLog.push(stepIndex !== undefined ? { ...entry, stepIndex } : entry);
      }
    } catch {
      // No entries, no error.
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The trace carries no QA step args: the QA step recorder keeps the raw input (a typed password included), and
   * `steps` already holds the redacted args of every call. Each step keeps index, tool, ok, error and ms; `args` is
   * a fixed placeholder (the `QaStep` type requires the field). Never throws.
   */
  function qaWithoutArgs(qa: QaResult): QaResult {
    try {
      const steps = Array.isArray(qa.steps) ? qa.steps : [];
      return { ...qa, steps: steps.map((st) => ({ ...st, args: QA_ARGS_OMITTED })) };
    } catch {
      return { ...qa, steps: [] };
    }
  }

  return {
    id,
    addFrame,
    onToolCall(call, ctx) {
      const index = calls++;
      const stepStartedAt = now();
      let args: unknown;
      let typedSecret = false;
      try {
        if (opts.redactArgs) args = opts.redactArgs(call.input);
        else {
          const tracked = redactTraceArgsTracked(call.input, redactState);
          args = tracked.value;
          typedSecret = tracked.typedSecret;
        }
      } catch {
        args = "[unavailable]";
      }
      // The slot is taken now, so parallel calls keep call order and cannot pass `maxSteps`.
      const slot = index < maxSteps ? { step: { index, tool: call.toolName, args, startedAt: stepStartedAt, endedAt: stepStartedAt, ok: false, error: "unfinished" } as BrowseTraceStep, open: true } : undefined;
      if (slot) slots.push(slot);
      else droppedSteps += 1;
      const frameStep = slot ? index : undefined;
      return async (end) => {
        try {
          if (finished || (slot && !slot.open)) return {};
          const endedAt = now();
          const step: BrowseTraceStep = { index, tool: call.toolName, args, startedAt: stepStartedAt, endedAt, ok: true };
          let parsed: Record<string, unknown> = {};
          let reproCapture: unknown;
          if (end.error !== undefined) {
            step.ok = false;
            step.error = textOfError(end.error);
          } else if (typeof end.output === "string") {
            parsed = parseJsonObject(end.output);
            step.output = end.output;
          } else if (end.output && typeof end.output === "object" && !Array.isArray(end.output)) {
            parsed = end.output as Record<string, unknown>;
            step.output = JSON.stringify(end.output);
          } else if (end.output !== undefined) {
            step.output = String(end.output);
          }
          // The capture is read, then removed from the recorded output: it is not part of what the model saw.
          if (REPRO_KEY in parsed) {
            reproCapture = parsed[REPRO_KEY];
            const { [REPRO_KEY]: _capture, ...withoutRepro } = parsed;
            parsed = withoutRepro;
            step.output = JSON.stringify(withoutRepro);
          }
          if (typeof parsed.error === "string") {
            step.ok = false;
            step.error = capTraceText(parsed.error, BROWSE_TRACE_ERROR_MAX_CHARS);
          }
          if (typeof parsed.imageData === "string") {
            const { imageData, ...rest } = parsed;
            step.output = JSON.stringify(rest);
            addFrame({
              imageData,
              kind: "screenshot",
              stepIndex: frameStep,
              ...(typeof parsed.width === "number" ? { width: parsed.width } : {}),
              ...(typeof parsed.height === "number" ? { height: parsed.height } : {}),
            });
          }
          if (call.toolName === "browse_act") {
            const actions = batchActions(args, call.input, parsed);
            if (actions) step.actions = actions;
          }
          if (reproOn && step.ok) {
            const repro = reproOfStep(call.toolName, call.input, args, parsed, reproCapture);
            if (repro) step.repro = repro;
          } else if (reproOn && call.toolName === "browse_act") {
            // A batch that stopped part-way: its completed actions did run. A single failed action is a dead end.
            const repro = partialBatchRepro(call.input, args, parsed, reproCapture);
            if (repro) step.repro = repro;
          }
          if (step.output !== undefined) step.output = capTraceText(step.output, BROWSE_TRACE_OUTPUT_MAX_CHARS);
          const fresh = harvestDiagnostics(parsed, consoleLog.seen, networkLog.seen);
          consoleLog.add(fresh.consoleErrors, endedAt, frameStep);
          networkLog.add(fresh.failedRequests, endedAt, frameStep);
          if (slot) {
            slot.step = step;
            slot.open = false;
          }
          let wanted = false;
          try {
            wanted = captureAfter(call.toolName, call.input, step.ok);
          } catch {
            // A throwing predicate means no frame.
          }
          // A failure frame needs a reason: not a call refused before it ran, not a second one in a row.
          if (wanted && !step.ok && !opts.captureAfter && (prevFailureFramed || (PRE_EXECUTION_ERROR.test(step.error ?? "") && nothingRan(parsed)))) wanted = false;
          let dialogs: unknown[] | undefined;
          // The screenshot of a step that typed a secret would show it.
          if (wanted && !typedSecret) {
            const framesBefore = nextFrameId;
            dialogs = await capturePage(frameStep, ctx?.signal);
            prevFailureFramed = !step.ok && nextFrameId > framesBefore;
          } else prevFailureFramed = false;
          scheduleDrain(ctx?.signal, frameStep);
          if (dialogs) return { dialogs };
        } catch {
          // Ignored: the recorder never throws into the host.
        }
        return {};
      };
    },
    setRepro(repro) {
      try {
        if (!reproOn || finished) return;
        const setup = repro?.setup;
        const out: NonNullable<BrowseTraceRepro["setup"]> = {};
        if (setup && Array.isArray(setup.network) && setup.network.length > 0) out.network = setup.network.map(redactRule);
        if (setup && typeof setup.url === "string" && setup.url !== "") {
          out.url = redactTraceUrl(setup.url);
          if (urlHasSecret(setup.url)) out.urlRedacted = true;
        }
        const steps = setup ? reproFixtureSteps(setup.steps) : undefined;
        if (steps && steps.length > 0) out.steps = steps;
        if (setup && Array.isArray(setup.tabs) && setup.tabs.length > 0) out.tabs = setup.tabs.length;
        if (setup && isObject(setup.emulate)) out.emulate = { ...(setup.emulate as FixtureEmulate) };
        if (setup && setup.app) out.app = true;
        if (setup && (setup.storage || setup.cookies)) out.storage = true;
        reproSetup = out;
      } catch {
        // Ignored: the recorder never throws into the host.
      }
    },
    async flush() {
      try {
        await requestQueue;
        // Also after an abort: the last requests of an aborted run are the ones worth reading.
        if (!finished) await drainRequests(undefined, FLUSH_TIMEOUT_MS);
      } catch {
        // Ignored: the recorder never throws into the host.
      }
    },
    finish(end) {
      if (finished) return finished;
      const endedAt = now();
      try {
        consoleLog.add(consoleLog.seen.add(end.qa?.consoleErrors), endedAt, undefined);
        networkLog.add(networkLog.seen.add(end.qa?.failedRequests), endedAt, undefined);
        // `qa.*Dropped` is not added: it repeats the counts the outputs already gave.
      } catch {
        // Ignored.
      }
      const dropped = {
        ...(droppedSteps > 0 ? { steps: droppedSteps } : {}),
        ...(droppedFrames > 0 ? { frames: droppedFrames } : {}),
        ...(consoleLog.seen.dropped() > 0 ? { console: consoleLog.seen.dropped() } : {}),
        ...(networkLog.seen.dropped() > 0 ? { network: networkLog.seen.dropped() } : {}),
        ...(droppedRequests > 0 ? { requests: droppedRequests } : {}),
      };
      finished = {
        format: BROWSE_TRACE_FORMAT,
        version: BROWSE_TRACE_VERSION,
        id,
        goal: capTraceText(String(opts.goal ?? ""), BROWSE_TRACE_GOAL_MAX_CHARS),
        startedAt,
        endedAt,
        status: String(end.status),
        ...(end.answer !== undefined ? { answer: capTraceText(String(end.answer), BROWSE_TRACE_ANSWER_MAX_CHARS) } : {}),
        ...(end.error !== undefined ? { error: capTraceText(String(end.error), BROWSE_TRACE_ERROR_MAX_CHARS) } : {}),
        ...(opts.labels ? { labels: { ...opts.labels } } : {}),
        // Calls still pending are steps that did not finish.
        steps: slots.map((s) => (s.open ? { ...s.step, endedAt } : s.step)),
        frames,
        console: consoleLog.entries,
        network: networkLog.entries,
        ...(opts.requests ? { requests: requestLog } : {}),
        ...(end.qa ? { qa: qaWithoutArgs(end.qa) } : {}),
        ...(reproOn ? { repro: reproSetup ? { setup: reproSetup } : {} } : {}),
        ...(Object.keys(dropped).length > 0 ? { dropped } : {}),
      };
      for (const s of slots) s.open = false;
      return finished;
    },
  };
}
