import type { BrowserBridge } from "./bridge.js";
import type { BrowseBackend, BrowseBackendResponse, BrowseEndpoint } from "./backend.js";

/**
 * Shared plumbing for the browse_task loop (docs/superpowers/specs/
 * 2026-09-18-builtin-browser-design.md §4/§6 and the browse_read addendum in
 * 2026-09-18-browse-task-jev-loop-design.md). The loop reaches the page
 * through the injected `BrowserBridge` (the `browser` option of
 * `runBrowseTask`; in pen-editor's desktop shell that is
 * `window.penDesktop.browser`, whose real work happens in the Electron main
 * process's `BrowserController`).
 */

/**
 * The shape `BrowserBridge.snapshot()` resolves with on success
 * (docs/superpowers/specs/2026-09-18-browse-task-jev-loop-design.md §1).
 * Shared between browseTask.ts (the Jev loop) and browseAct.ts (the
 * `element` natural-language targeting path, docs/superpowers/specs/
 * 2026-09-23-full-browser-use-design.md) — both need to take a snapshot and
 * validate its shape before acting on it by index.
 */
export interface SnapshotResult {
  url: string;
  title: string;
  elements: unknown[];
  snapshotId: string;
  /**
   * Full browser use follow-up (browse-speed-contract.md 2026-09-24,
   * "Frontend" item 4 / "Backend" item 5): the page's scroll position.
   * Forwarded untouched by browseTask.ts's `requestStep` to
   * `/api/browse/step` so Jev's digest can mention it — this side never
   * inspects the shape, only passes it through.
   */
  scroll?: unknown;
  /** Present when the element table was capped — passed through untouched,
   * same as `scroll`. */
  truncated?: boolean;
  /** Visible text inside the viewport (≤6000 chars) — a desktop build that
   * predates it omits the field. */
  text?: string;
  /** Name (≤80 chars) of an open aria-modal dialog the element table was
   * scoped to — desktop and cloud (Steel) snapshots share this shape. Absent
   * when no dialog is open or on a build that predates it. */
  modal?: string;
}

/**
 * Finds a snapshot element by its own `index` field, NOT its position in
 * the array — the element list is not guaranteed dense/positional (e.g.
 * after `filterElementsForBackend`-style upstream filtering). Used by
 * browseTask.ts's action-cache write AND replay paths, which need to
 * resolve "the element a cached fingerprint points at" or "the element
 * that was just acted on" back out of a snapshot by index, not by array
 * offset (finding: an `elements[index]` array-position lookup would
 * silently resolve the wrong element once anything upstream filtered the
 * list). (browse_act's own `element` targeting used to have a matching
 * local cache and write path here too — removed by a code review, see
 * browseAct.ts's module comment — so this is now browseTask.ts-only.)
 */
export function findElementByIndex(elements: unknown[], index: number): Record<string, unknown> | undefined {
  return elements.find(
    (el) => el && typeof el === "object" && (el as { index?: unknown }).index === index
  ) as Record<string, unknown> | undefined;
}

export function isSnapshotResult(value: unknown): value is SnapshotResult {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as SnapshotResult).url === "string" &&
    typeof (value as SnapshotResult).title === "string" &&
    Array.isArray((value as SnapshotResult).elements) &&
    typeof (value as SnapshotResult).snapshotId === "string"
  );
}

/**
 * The bridge never rejects: `BrowserBridge.*` resolves
 * with `{ error: "..." }` for every refusal the controller makes, including
 * the stale-snapshotId guard that fires when the page re-rendered between
 * snapshot and perform/act. Read as a bare success, such a result would be
 * recorded as ok — telling a caller an action landed when nothing happened
 * at all. Shared between browseTask.ts and browseAct.ts for the same reason
 * as `isSnapshotResult` above.
 */
export function resultError(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const err = (value as { error?: unknown }).error;
  return typeof err === "string" && err !== "" ? err : null;
}

/**
 * Takes a fresh snapshot and validates its shape/checks for a bridge
 * refusal, returning either a real `SnapshotResult` or `{ error }` — never
 * throws. Shared by browseTask.ts's loop and browseAct.ts's `element`
 * resolution path, which each used to hand-roll the identical
 * try/snapshot/resultError/isSnapshotResult sequence (finding: the two
 * copies had already started to drift in what they returned on a malformed
 * result). Callers still own how they PHRASE the failure to the model —
 * browseTask records it as a step, browseAct wraps it with "could not
 * resolve \"...\"" — this only owns the snapshot-taking and validation
 * itself.
 */
export async function takeSnapshot(
  browser: BrowserBridge
): Promise<SnapshotResult | { error: string }> {
  try {
    const raw = await browser.snapshot();
    const bridgeError = resultError(raw);
    if (bridgeError) {
      return { error: bridgeError };
    }
    if (!isSnapshotResult(raw)) {
      return { error: "Malformed snapshot result" };
    }
    return raw;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The desktop snapshot now also emits scroll-container entries shaped
 * `{index, tag, label, ops: [], scrollable: true}` (so the agent can scroll
 * inside modals/lists by index). `/api/browse/step`'s and
 * `/api/browse/locate`'s zod schemas require a non-empty `ops` array per
 * element, so forwarding a scroll-container entry verbatim would 400 the
 * request on any page that has one — this is defense in depth alongside the
 * backend's own carve-out for `scrollable` elements (the deployed backend
 * may lag the client that just started sending these). Every `/api/browse/*`
 * forwarding site filters its `elements` payload through this before
 * POSTing.
 */
export function filterElementsForBackend(elements: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const el of elements) {
    const clean = sanitizeElementForBackend(el);
    if (clean) out.push(clean);
    if (out.length >= BACKEND_MAX_ELEMENTS) break;
  }
  return out;
}

/**
 * Backend limits. The ELEMENT caps are the backend's EFFECTIVE ones
 * (pen-editor-backend src/ai/browseStep.ts: MAX_SNAPSHOT_ELEMENTS,
 * MAX_ELEMENT_VALUE_CHARS, MAX_ELEMENT_OPTIONS, MAX_OPTION_CHARS) — it
 * truncates to them anyway, so sending more only inflates the request. The
 * rest are the zod maxima of routes/browseStep.ts and browseLocate.ts, where
 * no tighter effective cap exists. One oversized field 400s the whole step.
 */
export const BACKEND_MAX_ELEMENTS = 120;
const ELEMENT_CAPS = { tag: 40, role: 60, label: 200, value: 500, frame: 200 } as const;
const OPTIONS_MAX_ITEMS = 100;
const OPTION_MAX_CHARS = 200;
export const BACKEND_MAX_GOAL = 2_000;
export const BACKEND_MAX_URL = 4_000;
export const BACKEND_MAX_TITLE = 500;
export const BACKEND_MAX_DESCRIPTION = 300;
/** Marked-screenshot data URL cap in the step schema. */
export const BACKEND_MAX_SCREENSHOT_CHARS = 4_000_000;
const ELEMENT_BOOLEANS = ["hasValue", "checked", "expanded", "isPassword", "scrollable"] as const;
const VALID_OPS = new Set(["CLICK", "TYPE_TEXT", "SELECT"]);

/** Cuts to at most `max` UTF-16 units without splitting a surrogate pair. */
export function sliceToChars(value: string, max: number): string {
  if (value.length <= max) return value;
  const end = max > 0 && isHighSurrogate(value.charCodeAt(max - 1)) ? max - 1 : max;
  return value.slice(0, end);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Truncates to at most `max` characters, ending in a single "…" when it
 * cut; never splits a surrogate pair. */
export function truncateToChars(value: string, max: number): string {
  return value.length > max ? `${sliceToChars(value, Math.max(0, max - 1))}…` : value;
}

/**
 * One element, clamped to the backend's elementSchema; `null` when a required
 * field is unusable (non-object, bad index, empty tag) or it has no usable
 * ops and is not a scroll container (`ops: []` + `scrollable: true` is kept —
 * the backend accepts it). `disabled` survives only when `true`.
 */
export function sanitizeElementForBackend(el: unknown): Record<string, unknown> | null {
  if (!el || typeof el !== "object") return null;
  const e = el as Record<string, unknown>;
  if (typeof e.index !== "number" || !Number.isInteger(e.index) || e.index < 0) return null;
  if (typeof e.tag !== "string" || e.tag.length === 0) return null;
  if (!Array.isArray(e.ops)) return null;
  const ops = e.ops.filter((o): o is string => typeof o === "string" && VALID_OPS.has(o));
  if (ops.length === 0 && e.scrollable !== true) return null;

  const out: Record<string, unknown> = {
    ...e,
    tag: truncateToChars(e.tag, ELEMENT_CAPS.tag),
    label: typeof e.label === "string" ? truncateToChars(e.label, ELEMENT_CAPS.label) : "",
    ops,
  };
  for (const key of ["role", "value", "frame"] as const) {
    if (typeof e[key] === "string") out[key] = truncateToChars(e[key], ELEMENT_CAPS[key]);
    else delete out[key];
  }
  for (const key of ELEMENT_BOOLEANS) {
    if (typeof e[key] !== "boolean") delete out[key];
  }
  if (e.disabled !== true) delete out.disabled;
  if (Array.isArray(e.options)) {
    out.options = e.options
      .filter((o): o is string => typeof o === "string")
      .slice(0, OPTIONS_MAX_ITEMS)
      .map((o) => truncateToChars(o, OPTION_MAX_CHARS));
  } else {
    delete out.options;
  }
  return out;
}

/**
 * The page-identity fields shared by every `/api/browse/*` request body
 * (step and locate): url, title and the sanitized element table. Every
 * forwarding site builds its body from this so none can send an oversized or
 * malformed field.
 */
export function sanitizedPageBody(snapshot: { url: string; title?: string; elements: unknown[] }): {
  url: string;
  title: string;
  elements: unknown[];
} {
  return {
    url: truncateToChars(snapshot.url, BACKEND_MAX_URL),
    title: truncateToChars(snapshot.title ?? "", BACKEND_MAX_TITLE),
    elements: filterElementsForBackend(snapshot.elements),
  };
}

/**
 * How long a request to a `/api/browse/*` backend route (Jev's `step`
 * decision, or the `element` natural-language `locate` lookup) is allowed to
 * run before this client gives up on it. Both routes call a fast model with
 * a short prompt — 20s is generous headroom over their expected latency
 * without eating too far into the calling tool's own
 * TOOL_CALL_TIMEOUT_MS_OVERRIDES budget (useDesignChat.ts).
 */
const BROWSE_BACKEND_REQUEST_TIMEOUT_MS = 20_000;

/**
 * POSTs `body` to a `/api/browse/*` backend route and returns its parsed
 * result. Centralizes what's genuinely identical between the two `/api/
 * browse/*` routes: the 429 / 503+Retry-After retry loop. The transport (base
 * URL, JSON content-type header, the abort timeout so a hung backend fails
 * fast instead of riding out the calling tool's whole timeout budget in
 * silence) lives in the injected `BrowseBackend`; `timeoutMs` bounds the
 * WHOLE round trip — connect through body-read — and the backend adapter
 * (adapters/httpBackend.ts) enforces it.
 */
export async function fetchBrowseBackend(
  backend: BrowseBackend,
  path: BrowseEndpoint,
  body: Record<string, unknown>,
  timeoutMs: number = BROWSE_BACKEND_REQUEST_TIMEOUT_MS,
  /** Aborts the request in flight (Stop / cancelled browse_task). */
  signal?: AbortSignal,
  /** Opt-in: wait and re-send the SAME request on 429 / 503+Retry-After. */
  retry?: RetryClock
): Promise<BrowseBackendResponse> {
  let res = await backend.request(path, body, { timeoutMs, signal });
  if (!retry) return res;
  for (let attempt = 0; attempt < RATE_LIMIT_MAX_RETRIES && isRetryableStatus(res); attempt++) {
    if (signal?.aborted) break;
    const waitMs =
      res.retryAfterSec !== undefined
        ? Math.min(RATE_LIMIT_MAX_RETRY_AFTER_MS, res.retryAfterSec * 1000)
        : Math.min(RATE_LIMIT_MAX_BACKOFF_MS, 1000 * 2 ** attempt);
    // The wait AND the retried request's own worst case must still fit.
    if (retry.deadline !== undefined && retry.now() + waitMs + timeoutMs + (retry.reserveMs ?? 0) > retry.deadline) break;
    await abortableSleep(retry.sleep(waitMs), signal);
    if (signal?.aborted) break;
    res = await backend.request(path, body, { timeoutMs, signal });
  }
  return res;
}

/** Clock + budget for fetchBrowseBackend's opt-in rate-limit retry. */
export interface RetryClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Absolute `now()` time the caller must finish by; no limit when absent. */
  deadline?: number;
  /** Headroom the caller needs after the request (STEP_DEADLINE_RESERVE_MS). */
  reserveMs?: number;
}

const RATE_LIMIT_MAX_RETRIES = 4;
const RATE_LIMIT_MAX_BACKOFF_MS = 8_000;
const RATE_LIMIT_MAX_RETRY_AFTER_MS = 60_000;

/** 429, or 503 that carries a Retry-After: a transient "come back later". */
function isRetryableStatus(res: BrowseBackendResponse): boolean {
  return res.status === 429 || (res.status === 503 && res.retryAfterSec !== undefined);
}

/** Resolves when `wait` does or `signal` aborts, whichever is first. */
function abortableSleep(wait: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return wait;
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      signal.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    void wait.then(done, done);
  });
}
