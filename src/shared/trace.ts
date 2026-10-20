// Browse run trace, format v1 (docs/specs/2026-10-20-browse-run-trace-design.md):
// types, constants and pure helpers. Zod-free, no imports except types, so the
// zod-free `agent/session` entry and any consumer (viewer, backend, desktop
// main) can use them. The recorder is in src/agent/traceRecorder.ts.
import type { QaResult } from "./qaTypes.js";

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
  /** How many entries the recorder's caps left out. */
  dropped?: { steps?: number; frames?: number; console?: number; network?: number };
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
  if (value.dropped !== undefined && (!isObject(value.dropped) || !Object.values(value.dropped).every(isNum))) return { error: "dropped: expected numbers" };
  const problem =
    listProblem("steps", value.steps, (s) => isNum(s.index) && isStr(s.tool) && isNum(s.startedAt) && isNum(s.endedAt) && typeof s.ok === "boolean" && optStr(s.error) && optStr(s.output)) ??
    listProblem("frames", value.frames, (f) => isNum(f.id) && isNum(f.at) && optNum(f.stepIndex) && isStr(f.kind) && FRAME_KINDS.includes(f.kind) && isStr(f.src) && isFrameSrc(f.src) && optNum(f.width) && optNum(f.height)) ??
    listProblem("console", value.console, (e) => isNum(e.at) && optNum(e.stepIndex) && isStr(e.text)) ??
    listProblem("network", value.network, (e) => isNum(e.at) && optNum(e.stepIndex) && isStr(e.text));
  if (problem) return { error: problem };
  return { trace: value as unknown as BrowseTrace };
}
