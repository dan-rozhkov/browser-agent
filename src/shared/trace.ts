// Browse run trace, format v1 (docs/specs/2026-10-20-browse-run-trace-design.md):
// types, constants and pure helpers. Zod-free, no imports except types, so the
// zod-free `agent/session` entry and any consumer (viewer, backend, desktop
// main) can use them. The recorder is in src/agent/traceRecorder.ts.
import type { QaCheck, QaResult } from "./qaTypes.js";
import type { FixtureEmulate, FixtureNetworkRule } from "../fixture/types.js";

export const BROWSE_TRACE_FORMAT = "sideform.browse-trace";
export const BROWSE_TRACE_VERSION = 1;

/** Valid trace ids. */
export const BROWSE_TRACE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Valid published paths of frame assets (`splitTraceAssets` makes them). */
export const BROWSE_TRACE_ASSET_PATH = /^frames\/\d{1,4}\.(jpg|png|webp)$/;

export const BROWSE_TRACE_GOAL_MAX_CHARS = 4000;
export const BROWSE_TRACE_ANSWER_MAX_CHARS = 4000;
export const BROWSE_TRACE_ERROR_MAX_CHARS = 2000;
export const BROWSE_TRACE_OUTPUT_MAX_CHARS = 4000;
/** Strings longer than this are cut in the recorded `args`. */
export const BROWSE_TRACE_ARG_STRING_MAX_CHARS = 2000;

/** The body of a request in the log is cut to this many chars. */
export const BROWSE_TRACE_REQUEST_BODY_MAX_CHARS = 4000;
/** The url of a request in the log is cut to this many chars. */
export const BROWSE_TRACE_REQUEST_URL_MAX_CHARS = 2000;
const REQUEST_HEADER_VALUE_MAX_CHARS = 500;
const REQUEST_HEADERS_MAX = 60;

/** A step lists at most this many `actions`. */
export const BROWSE_TRACE_MAX_ACTIONS = 100;

/** One entry of a batched `browse_act`: an action that ran or was skipped. */
export interface BrowseTraceAction {
  /** `action` of the entry, "act" when missing. */
  action: string;
  ok: boolean;
  /** Capped at 2000 chars. */
  error?: string;
}

export interface BrowseTraceStep {
  /** 0-based, call order. */
  index: number;
  tool: string;
  /** Redacted. */
  args: unknown;
  startedAt: number;
  endedAt: number;
  ok: boolean;
  /** Capped at 2000 chars. */
  error?: string;
  /** JSON/text of the result with the image data removed, capped at 4000 chars. */
  output?: string;
  /**
   * A batched `browse_act`: one entry per action that ran (ok), and the one that stopped the batch (not ok).
   * Actions after it never ran and are not listed (a viewer counts them from `args.actions`). Absent when
   * the call failed before the batch ran, and for every other tool.
   */
  actions?: BrowseTraceAction[];
  /** Replayable actions of this step (docs/specs/2026-10-26-playwright-spec-export-design.md). Absent when recording was off, the step failed, or the tool does nothing replayable. */
  repro?: BrowseTraceReproAction[];
}

export interface BrowseTraceFrame {
  /** 0-based, unique in the trace. */
  id: number;
  /** Epoch ms. */
  at: number;
  /** The step the frame belongs to. */
  stepIndex?: number;
  kind: "step" | "screenshot" | "final";
  /** A data URL in memory; an asset path or URL after storage. */
  src: string;
  width?: number;
  height?: number;
}

export interface BrowseTraceLogEntry {
  at: number;
  stepIndex?: number;
  text: string;
}

/**
 * A Playwright locator, computed in the live page BEFORE the action
 * (docs/specs/2026-10-26-playwright-spec-export-design.md, "Locator").
 */
export type ReproLocator =
  | { kind: "testid"; value: string }
  | { kind: "attr"; name: "data-test" | "data-qa"; value: string }
  | { kind: "role"; role: string; name?: string }
  | { kind: "placeholder"; value: string }
  | { kind: "label"; value: string }
  | { kind: "alt"; value: string }
  | { kind: "text"; value: string }
  | { kind: "title"; value: string }
  | { kind: "css"; value: string };

/** Why a step cannot be replayed (the page script's reasons, plus the recorder's). */
export type ReproGapReason = "iframe" | "shadow" | "not-found" | "no-unique" | string;

/** What the controller adds to an `act` / `assert` result when `args.repro` is true. Never reaches the model. */
export interface ReproCapture {
  /** `act`: the target element. */
  locator?: ReproLocator;
  /** `act`: the element could not be named. */
  gap?: ReproGapReason;
  /** `act` select: the value of the chosen option. */
  value?: string;
  /** `act` type: the field is a secret field (password, OTP, card); the text must not be recorded. */
  secret?: true;
  /** `act` viewport: the size after the action. */
  viewport?: { width: number; height: number };
  /** `assert`: one entry per check, in order; null for a check without an `index`. */
  checks?: Array<{ locator: ReproLocator } | { gap: ReproGapReason } | null>;
}

/** The result key that carries a `ReproCapture`. */
export const REPRO_KEY = "__repro";

export type ReproOp = "goto" | "click" | "fill" | "select" | "press" | "hover" | "back" | "forward" | "reload" | "viewport" | "expect" | "gap";

/** One replayable action of a trace step. */
export interface BrowseTraceReproAction {
  op: ReproOp;
  locator?: ReproLocator;
  /** goto: redacted url. */
  url?: string;
  /** fill: the typed text. Absent when `secret`. */
  text?: string;
  secret?: true;
  /** select: the option value. */
  value?: string;
  /** press: the key. */
  key?: string;
  viewport?: { width: number; height: number };
  /** expect: the check as the agent gave it. */
  check?: QaCheck;
  /** expect: the live result in the run. */
  passed?: boolean;
  /** expect: why it failed in the run (the check's `actual`). */
  actual?: string;
  /** expect with an `index`: the element as a locator. */
  checkLocator?: ReproLocator;
  /** gap: why this step cannot be replayed. */
  gap?: ReproGapReason;
  /** goto: a secret query value was removed from `url` by redaction. */
  urlRedacted?: true;
  /** expect: the check could not run in the run (a tool error: invalid selector, refused value, ...). */
  error?: string;
  /** A short human text for the comment line. */
  note?: string;
}

/** A fixture step as the trace stores it: typed text of a secret field is not kept. */
export type ReproFixtureStep =
  | { action: "goto"; url: string; urlRedacted?: true }
  | { action: "click"; selector: string }
  | { action: "type"; selector: string; text?: string; secret?: true }
  | { action: "select"; selector: string; value: string }
  | { action: "press"; key: string; selector?: string }
  | { action: "waitFor"; selector: string; timeoutMs?: number }
  | { action: "wait"; ms: number };

/** A network mock rule as the trace stores it. */
export interface ReproNetworkRule extends FixtureNetworkRule {
  /** The rule cannot be exported (secret in the url, body too large or secret-looking). The renderer emits a GAP with this text. */
  gap?: string;
  /** A secret-named key of the body had its value replaced by "[redacted]". */
  bodyRedacted?: true;
  /** A secret header was removed. */
  headersRedacted?: true;
}

/** Run-level data of a Playwright export. */
export interface BrowseTraceRepro {
  setup?: {
    /** Network mocks of the QA setup. Bodies: secret-named keys lose their value; url and headers see `ReproNetworkRule`. */
    network?: ReproNetworkRule[];
    /** The fixture start url (redacted). The session runs the fixture instead of a pre-open, so there is no second goto. */
    url?: string;
    urlRedacted?: true;
    /** The fixture's deterministic steps on the main tab. */
    steps?: ReproFixtureStep[];
    /** The fixture opened this many extra tabs: not exported. */
    tabs?: number;
    emulate?: FixtureEmulate;
    /** The run started an Electron app: a Playwright web test cannot replay it. */
    app?: true;
    /** The setup had storage or cookies; they are NOT exported. */
    storage?: true;
  };
}

/** One network request of the run (docs/specs/2026-10-20-browse-run-trace-design.md, "v1 additions"). */
export interface BrowseTraceRequest {
  /** Epoch ms when the request started. */
  at: number;
  stepIndex?: number;
  method: string;
  /** Redacted (secret-looking query values), capped at 2000 chars. */
  url: string;
  /** CDP resource type, lower case: document, xhr, fetch, script, stylesheet, image, font, media, other... */
  type?: string;
  status?: number;
  /** Network error text (net::ERR_...). */
  error?: string;
  durationMs?: number;
  /** Encoded bytes received. */
  size?: number;
  mimeType?: string;
  /** Redacted. */
  requestHeaders?: Record<string, string>;
  /** Redacted. */
  responseHeaders?: Record<string, string>;
  /** fetch/xhr text responses only (json, text, xml, javascript, form), redacted, capped. */
  responseBody?: string;
  bodyTruncated?: boolean;
}

export interface BrowseTrace {
  format: typeof BROWSE_TRACE_FORMAT;
  version: typeof BROWSE_TRACE_VERSION;
  /** `BROWSE_TRACE_ID`. */
  id: string;
  /** Capped at 4000 chars. */
  goal: string;
  /** Epoch ms. */
  startedAt: number;
  endedAt: number;
  /** `BrowseAgentResult.status`. */
  status: string;
  /** Capped at 4000 chars. */
  answer?: string;
  /** Capped at 2000 chars. */
  error?: string;
  /** Free-form host labels, for example `{ browser: "cloud" }`. */
  labels?: Record<string, string>;
  steps: BrowseTraceStep[];
  frames: BrowseTraceFrame[];
  /** Console errors. */
  console: BrowseTraceLogEntry[];
  /** Failed requests (`<METHOD> <status|error> <origin><path>`). */
  network: BrowseTraceLogEntry[];
  qa?: QaResult;
  /** Every network request of the run, when the recorder had a `requests` source. */
  requests?: BrowseTraceRequest[];
  /** How many entries the recorder's caps left out. */
  dropped?: { steps?: number; frames?: number; console?: number; network?: number; requests?: number };
  /** Present when the run was recorded for a Playwright export (`repro` on steps). */
  repro?: BrowseTraceRepro;
}

/** Cuts `text` to `max` chars. */
export function capTraceText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|otp|cvv|card/i;
/** Words in the target of a type/fill action that mark a secret field (a password, a code, a card number). Over-matching is on purpose: a redacted search query costs less than a leaked password. */
const SECRET_FIELD = /pass|pwd|secret|otp|one.?time|code|pin|cvv|cvc|card|token|key|ssn/i;
const TARGET_KEYS = ["target", "element", "label", "selector", "name", "placeholder"] as const;
const TYPED_ACTIONS: readonly string[] = ["type", "fill"];
const FOCUS_ACTIONS: readonly string[] = ["click", "focus"];
const MAX_ARG_DEPTH = 8;

/** What a redactor remembers between calls: whether the field the last click/focus/type went to looked like a secret. */
export interface TraceRedactionState {
  secretFocus: boolean;
}

/**
 * `redactTraceArgs` with memory, for one run. `typedSecret` is true when a typed text was redacted because it
 * goes into a secret-looking field: a screenshot of the page would show it, so the recorder takes no frame for that step.
 */
export function redactTraceArgsTracked(args: unknown, state: TraceRedactionState): { value: unknown; typedSecret: boolean } {
  let typedSecret = false;
  const visit = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return capTraceText(value, BROWSE_TRACE_ARG_STRING_MAX_CHARS);
    if (!value || typeof value !== "object") return value;
    if (depth >= MAX_ARG_DEPTH) return Array.isArray(value) ? [] : {};
    if (Array.isArray(value)) return value.map((v) => visit(v, depth + 1));
    const record = value as Record<string, unknown>;
    const names = TARGET_KEYS.map((k) => record[k]).filter((v): v is string => typeof v === "string");
    const named = names.length > 0;
    const matches = names.some((n) => SECRET_FIELD.test(n));
    const action = typeof record.action === "string" ? record.action : undefined;
    let secretField = record.inputType === "password" || record.type === "password";
    if (action !== undefined && TYPED_ACTIONS.includes(action)) {
      // Typing without a target goes into the field the last click/focus (or type) reached.
      secretField ||= named ? matches : state.secretFocus;
      state.secretFocus = named ? matches : state.secretFocus;
    } else if (action !== undefined && FOCUS_ACTIONS.includes(action)) {
      // A click by index moves the focus to a field we cannot name: the memory resets.
      state.secretFocus = named && matches;
    }
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(record)) {
      if (secretField && (key === "text" || key === "value") && typeof v === "string") {
        typedSecret = true;
        out[key] = "[redacted]";
      } else {
        out[key] = SECRET_KEY.test(key) ? "[redacted]" : visit(v, depth + 1);
      }
    }
    return out;
  };
  const value = visit(args, 0);
  return { value, typedSecret };
}

/**
 * The default redaction of tool `args`. Returns a copy; strings over 2000 chars are cut. Depth is bounded, so an
 * odd value cannot loop.
 * - The value of every object key that matches /pass(word)?|secret|token|api[-_]?key|otp|cvv|card/i becomes "[redacted]".
 * - Typed text: in an object with `action` "type" or "fill" (a `browse_act` call, also each entry of `actions`),
 *   `text` and `value` become "[redacted]" when its `target`, `element`, `label`, `selector`, `name` or `placeholder`
 *   matches /pass|pwd|secret|otp|one.?time|code|pin|cvv|cvc|card|token|key|ssn/i, or when the object has
 *   `inputType` or `type` "password". Other typed text (a search query) stays. This function has no memory: a
 *   type without a target, after a click on a secret field, is redacted only by `redactTraceArgsTracked` (the
 *   recorder's default). A call that names its field only by `index` has no word to match, so its text stays visible.
 */
export function redactTraceArgs(args: unknown): unknown {
  return redactTraceArgsTracked(args, { secretFocus: false }).value;
}

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token)$/i;
const SECRET_PART = new Set(["session", "sid", "auth", "code", "sig", "signature"]);
const REDACTED = "[redacted]";

/**
 * The one key rule of the request log (body keys, header names, query params): the args rule (`SECRET_KEY`, a
 * substring), or a name that has `session`, `sid`, `auth`, `code`, `sig` or `signature` as a whole part. Parts are
 * split at `_`, `-`, `.` and camelCase boundaries: `sessionId`, `x-session-id`, `auth`, `code` match; `zipcode`,
 * `author`, `design` do not.
 */
function isSecretName(name: string): boolean {
  if (SECRET_KEY.test(name) || /^(session|signature)/i.test(name)) return true;
  return name.split(/[_\-.\s]+|(?<=[a-z0-9])(?=[A-Z])/).some((part) => SECRET_PART.has(part.toLowerCase()));
}

/** True when `name` is a secret-named key, header or query param (the one key rule of the request log). */
export function isSecretKeyName(name: string): boolean {
  return isSecretName(name);
}

/** True when the typed text of a field named `name` (a selector, a label) must not be stored: the `SECRET_FIELD` rule. */
export function isSecretFieldName(name: string): boolean {
  return SECRET_FIELD.test(name);
}

/** True when `text` holds a secret-looking word (the args key rule, anywhere in the text). */
export function hasSecretWord(text: string): boolean {
  return SECRET_KEY.test(text);
}

/** True when a header name is secret (the request-log rule). */
export function isSecretHeaderName(name: string): boolean {
  return SECRET_HEADER.test(name) || isSecretName(name);
}

function paramsHaveSecret(params: string): boolean {
  return params.split("&").some((part) => {
    const eq = part.indexOf("=");
    if (eq < 0) return false;
    let name = part.slice(0, eq);
    try {
      name = decodeURIComponent(name);
    } catch {
      // keep the raw name
    }
    return isSecretName(name);
  });
}

/** True when `redactTraceUrl` would change `url` for a secret reason: userinfo, or a secret-named query or fragment param. (The length cap does not count.) */
export function urlHasSecret(url: string): boolean {
  const hash = url.indexOf("#");
  const base = hash < 0 ? url : url.slice(0, hash);
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#@]*@/i.test(base)) return true;
  const q = base.indexOf("?");
  if (q >= 0 && paramsHaveSecret(base.slice(q + 1))) return true;
  const frag = hash < 0 ? "" : url.slice(hash);
  return frag.includes("=") && paramsHaveSecret(frag.slice(1));
}

/** `a=1&b=2` with the value of each secret-named param replaced. */
function redactParams(params: string): string {
  return params
    .split("&")
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq < 0) return part;
      let name = part.slice(0, eq);
      try {
        name = decodeURIComponent(name);
      } catch {
        // keep the raw name
      }
      return isSecretName(name) ? `${part.slice(0, eq + 1)}${REDACTED}` : part;
    })
    .join("&");
}

/** Redacts the userinfo and the secret-looking query values (and fragment params) of a url, then caps it. */
export function redactTraceUrl(url: string): string {
  const hash = url.indexOf("#");
  // `user:pass@` in front of the host goes.
  const base = (hash < 0 ? url : url.slice(0, hash)).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, "$1");
  const frag = hash < 0 ? "" : url.slice(hash);
  const q = base.indexOf("?");
  const out = q < 0 ? base : `${base.slice(0, q + 1)}${redactParams(base.slice(q + 1))}`;
  // A fragment that looks like `#access_token=...&x=1` is redacted the same way.
  const fragOut = frag.includes("=") ? `#${redactParams(frag.slice(1))}` : frag;
  return capTraceText(out + fragOut, BROWSE_TRACE_REQUEST_URL_MAX_CHARS);
}

/** Headers whose value is a url (a query in it can hold a token). */
const URL_HEADER = /^(referer|location|content-location|origin)$/i;

function redactHeaders(headers: unknown): Record<string, string> | undefined {
  if (!isObject(headers)) return undefined;
  const out: Record<string, string> = {};
  let n = 0;
  for (const [name, value] of Object.entries(headers)) {
    if (n >= REQUEST_HEADERS_MAX) break;
    if (typeof value !== "string") continue;
    const isUrl = URL_HEADER.test(name) || /^https?:\/\//i.test(value);
    out[name] = SECRET_HEADER.test(name) || isSecretName(name) ? REDACTED : capTraceText(isUrl ? redactTraceUrl(value) : value, REQUEST_HEADER_VALUE_MAX_CHARS);
    n++;
  }
  return out;
}

function redactJsonKeys(value: unknown, depth: number): unknown {
  if (!value || typeof value !== "object") return value;
  if (depth >= MAX_ARG_DEPTH) return Array.isArray(value) ? [] : {};
  if (Array.isArray(value)) return value.map((v) => redactJsonKeys(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) out[key] = isSecretName(key) ? REDACTED : redactJsonKeys(v, depth + 1);
  return out;
}

const UNPARSED_BODY = "[redacted: unparsed body with a secret-looking key]";

/**
 * Redacts a text body. JSON (after a BOM and an anti-XSSI prefix): secret-named keys lose their whole subtree. Form
 * bodies: secret-named fields. Any other text (cut JSON, JSONP, script, plain text) that has a secret-looking word
 * anywhere is replaced as a whole; else it is kept. Then caps it.
 */
function redactBody(body: string, mimeType: string | undefined, alreadyCut: boolean): { text: string; truncated: boolean } {
  const cleaned = body.replace(/^\uFEFF/, "").replace(/^\)\]\}',?\s*/, "").trim();
  let text: string | undefined;
  try {
    if (cleaned !== "") text = JSON.stringify(redactJsonKeys(JSON.parse(cleaned), 0));
  } catch {
    // Not JSON.
  }
  if (text === undefined) {
    if (mimeType !== undefined && /x-www-form-urlencoded/i.test(mimeType)) text = redactParams(body);
    else if (SECRET_KEY.test(body)) return { text: UNPARSED_BODY, truncated: false };
    else text = body;
  }
  const cut = text.length > BROWSE_TRACE_REQUEST_BODY_MAX_CHARS;
  return { text: capTraceText(text, BROWSE_TRACE_REQUEST_BODY_MAX_CHARS), truncated: cut || alreadyCut };
}

/**
 * Turns a raw request entry (the controller's `PageRequestEntry`, or the JSON of one) into a trace entry: the url,
 * header values and body are redacted and capped. Returns undefined for a value that is not a request (no finite
 * `at`, no string `method` or `url`). Never throws.
 * - Headers named authorization, proxy-authorization, cookie, set-cookie, x-api-key, x-auth-token, x-csrf-token or
 *   matching the args key rule: "[redacted]". Values are cut to 500 chars, at most 60 headers.
 * - Header values that are urls (`referer`, `location`, `content-location`, `origin`, or any absolute http(s) value) go
 *   through `redactTraceUrl`.
 * - Url: `user:pass@` is removed; query (and fragment) params with a secret name (`isSecretName`) are "[redacted]".
 * - A JSON `body` is parsed, a secret-named key loses its whole subtree and it is stringified again. A body that is not
 *   JSON and has a secret-looking word (the args key rule) anywhere is replaced by a fixed text; a form body keeps
 *   its field redaction; other text is kept. Cut to `BROWSE_TRACE_REQUEST_BODY_MAX_CHARS`; `bodyTruncated` is set
 *   when anything was cut.
 */
export function redactTraceRequest(raw: unknown): BrowseTraceRequest | undefined {
  try {
    if (!isObject(raw) || !isNum(raw.at) || !isStr(raw.method) || !isStr(raw.url)) return undefined;
    const out: BrowseTraceRequest = { at: raw.at, method: capTraceText(raw.method, 16), url: redactTraceUrl(raw.url) };
    if (isStr(raw.type)) out.type = capTraceText(raw.type.toLowerCase(), 32);
    if (isNum(raw.status)) out.status = raw.status;
    if (isStr(raw.error)) out.error = capTraceText(raw.error, BROWSE_TRACE_ERROR_MAX_CHARS);
    if (isNum(raw.durationMs)) out.durationMs = raw.durationMs;
    if (isNum(raw.size)) out.size = raw.size;
    if (isStr(raw.mimeType)) out.mimeType = capTraceText(raw.mimeType, 200);
    const reqHeaders = redactHeaders(raw.requestHeaders);
    if (reqHeaders) out.requestHeaders = reqHeaders;
    const resHeaders = redactHeaders(raw.responseHeaders);
    if (resHeaders) out.responseHeaders = resHeaders;
    const body = isStr(raw.body) ? raw.body : isStr(raw.responseBody) ? raw.responseBody : undefined;
    if (body !== undefined) {
      const { text, truncated } = redactBody(body, out.mimeType, raw.bodyTruncated === true);
      out.responseBody = text;
      if (truncated) out.bodyTruncated = true;
    } else if (raw.bodyTruncated === true) out.bodyTruncated = true;
    return out;
  } catch {
    return undefined;
  }
}

const DATA_URL = /^data:image\/(jpeg|png|webp);base64,/i;

/**
 * Moves data-URL frames out of the manifest. `frame.src` becomes
 * `frames/<id>.<ext>`. A frame whose `src` is not a jpeg, png or webp data URL
 * is left as it is. Returns a copy; the input is not changed.
 */
export function splitTraceAssets(trace: BrowseTrace): { manifest: BrowseTrace; assets: { path: string; dataUrl: string; contentType: string }[] } {
  const assets: { path: string; dataUrl: string; contentType: string }[] = [];
  const frames = trace.frames.map((frame) => {
    const match = DATA_URL.exec(frame.src);
    if (!match) return { ...frame };
    const type = match[1]!.toLowerCase();
    const path = `frames/${frame.id}.${type === "jpeg" ? "jpg" : type}`;
    assets.push({ path, dataUrl: frame.src, contentType: `image/${type}` });
    return { ...frame, src: path };
  });
  return { manifest: { ...trace, frames }, assets };
}

/** Maps each `frame.src` through `resolve` (for a stored manifest). Returns a copy. */
export function mapTraceFrames(trace: BrowseTrace, resolve: (src: string) => string): BrowseTrace {
  return { ...trace, frames: trace.frames.map((frame) => ({ ...frame, src: resolve(frame.src) })) };
}

const MAX_ENTRIES = 2000;
const SAFE_SRC = /^(?:data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+|https:\/\/[^\s]+|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:[/?#][^\s]*)?)$/i;
/** A frame source a consumer may put into an `<img>`: an image data URL, a stored asset path, an `https:` URL, or `http://localhost` / `127.0.0.1`. */
function isFrameSrc(src: string): boolean {
  return BROWSE_TRACE_ASSET_PATH.test(src) || SAFE_SRC.test(src);
}

const FRAME_KINDS: readonly string[] = ["step", "screenshot", "final"];

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const optNum = (v: unknown) => v === undefined || isNum(v);
const optStr = (v: unknown) => v === undefined || isStr(v);

const isStrRecord = (v: unknown) => isObject(v) && Object.values(v).every(isStr);
const isAction = (a: unknown) => isObject(a) && isStr(a.action) && typeof a.ok === "boolean" && optStr(a.error);

function listProblem(name: string, list: unknown, check: (entry: Record<string, unknown>) => boolean): string | undefined {
  if (!Array.isArray(list)) return `${name}: expected an array`;
  if (list.length > MAX_ENTRIES) return `${name}: too many entries`;
  for (const [i, entry] of list.entries()) {
    if (!isObject(entry) || !check(entry)) return `${name}[${i}]: invalid`;
  }
  return undefined;
}

/**
 * Structural check of an unknown JSON value (the trust boundary of every
 * consumer): `format`, `version`, `id`, the arrays and their entry fields. A `frame.src` must be an image data
 * URL (jpeg, png, webp), an asset path (`BROWSE_TRACE_ASSET_PATH`), an `https:` URL or `http://localhost`;
 * anything else (`javascript:`, `file:`, another data type) is an error.
 * Extra fields (for example a stored `owner`) are kept. Returns the same value
 * typed as a trace, or an error text.
 */
export function parseBrowseTrace(value: unknown): { trace: BrowseTrace } | { error: string } {
  if (!isObject(value)) return { error: "trace: expected an object" };
  if (value.format !== BROWSE_TRACE_FORMAT) return { error: `format: expected "${BROWSE_TRACE_FORMAT}"` };
  if (value.version !== BROWSE_TRACE_VERSION) return { error: `version: expected ${BROWSE_TRACE_VERSION}` };
  if (!isStr(value.id) || !BROWSE_TRACE_ID.test(value.id)) return { error: "id: invalid" };
  if (!isStr(value.goal)) return { error: "goal: expected a string" };
  if (!isNum(value.startedAt) || !isNum(value.endedAt)) return { error: "startedAt, endedAt: expected numbers" };
  if (!isStr(value.status)) return { error: "status: expected a string" };
  if (!optStr(value.answer) || !optStr(value.error)) return { error: "answer, error: expected strings" };
  if (value.labels !== undefined && (!isObject(value.labels) || !Object.values(value.labels).every(isStr))) return { error: "labels: expected string values" };
  if (value.qa !== undefined && (!isObject(value.qa) || !isStr(value.qa.outcome) || !Array.isArray(value.qa.steps))) return { error: "qa: invalid" };
  if (value.qa !== undefined && value.qa.unmatchedMocks !== undefined && !(Array.isArray(value.qa.unmatchedMocks) && value.qa.unmatchedMocks.every((m) => isObject(m) && isStr(m.url) && optStr(m.method)))) return { error: "qa.unmatchedMocks: invalid" };
  if (value.dropped !== undefined && (!isObject(value.dropped) || !Object.values(value.dropped).every(isNum))) return { error: "dropped: expected numbers" };
  const problem =
    listProblem("steps", value.steps, (s) => isNum(s.index) && isStr(s.tool) && isNum(s.startedAt) && isNum(s.endedAt) && typeof s.ok === "boolean" && optStr(s.error) && optStr(s.output) && (s.actions === undefined || (Array.isArray(s.actions) && s.actions.length <= BROWSE_TRACE_MAX_ACTIONS && s.actions.every(isAction)))) ??
    listProblem("frames", value.frames, (f) => isNum(f.id) && isNum(f.at) && optNum(f.stepIndex) && isStr(f.kind) && FRAME_KINDS.includes(f.kind) && isStr(f.src) && isFrameSrc(f.src) && optNum(f.width) && optNum(f.height)) ??
    listProblem("console", value.console, (e) => isNum(e.at) && optNum(e.stepIndex) && isStr(e.text)) ??
    listProblem("network", value.network, (e) => isNum(e.at) && optNum(e.stepIndex) && isStr(e.text)) ??
    (value.requests === undefined
      ? undefined
      : listProblem(
          "requests",
          value.requests,
          (r) =>
            isNum(r.at) && optNum(r.stepIndex) && isStr(r.method) && isStr(r.url) && optStr(r.type) && optNum(r.status) && optStr(r.error) && optNum(r.durationMs) && optNum(r.size) && optStr(r.mimeType) &&
            (r.requestHeaders === undefined || isStrRecord(r.requestHeaders)) && (r.responseHeaders === undefined || isStrRecord(r.responseHeaders)) && optStr(r.responseBody) && (r.bodyTruncated === undefined || typeof r.bodyTruncated === "boolean"),
        ));
  if (problem) return { error: problem };
  return { trace: value as unknown as BrowseTrace };
}
