// The one implementation of the seven browse tools, run against a
// `BrowserBridge`. Pen Editor's frontend handlers (src/lib/tools/browser/*) are
// thin wrappers over this: they plug in what only the host has (the
// natural-language `element` locator, its own "not available" texts and the
// canvas placement after a screenshot). Imports only ../loop/* and ../shared/*, so it stays
// zod-free (entry: `agent/execute`); ../shared/* is zod-free too, which is what the
// boundary allows next to ../loop/*.
import type { BrowserBridge } from "../loop/bridge.js";
import { parseViewportArgs } from "../shared/viewport.js";
import { resultError, takeSnapshot, type SnapshotResult } from "../loop/shared.js";
import { REPRO_KEY, type ReproCapture } from "../shared/trace.js";

const MAX_BATCH_ACTIONS = 10;
/** A batch may start no new entry after this time (the client-side tool-call budget is 120 s). */
export const BATCH_DEADLINE_MS = 60_000;

const ELEMENT_UNAVAILABLE = "browse_act: element targeting is not available here. Use target or index instead.";

/** Default for `ExecuteBrowseToolOptions.elementActions`. */
const DEFAULT_ELEMENT_ACTIONS: readonly string[] = ["click", "type", "select", "hover", "press", "upload"];

/** "a", "a and b", "a, b, and c": the list as the refusal text prints it. */
function listActions(actions: readonly string[]): string {
  if (actions.length <= 2) return actions.join(" and ");
  return `${actions.slice(0, -1).join(", ")}, and ${actions[actions.length - 1]}`;
}

export interface ElementLocateRequest {
  element: string;
  action: string;
  snapshot: SnapshotResult;
}

export type ElementLocateOutcome =
  | { outcome: "found"; index: number; label?: string; confidence?: number }
  | { outcome: "not_found"; reason?: string }
  | { outcome: "retry"; reason?: string }
  | { outcome: "failed"; message: string };

/** Resolves a natural-language element description to a snapshot index. */
export type ElementLocator = (req: ElementLocateRequest) => Promise<ElementLocateOutcome>;

export interface AfterScreenshotContext {
  /** The screenshot result string, as the bridge call produced it. */
  raw: string;
  /** `raw` parsed (a malformed result becomes an `{ error }` object). */
  result: Record<string, unknown>;
  /** The tool input. */
  args: Record<string, unknown>;
  /** The input without `placeOnCanvas`, `x` and `y`: what the bridge got. */
  bridgeArgs: Record<string, unknown>;
  /** Takes another capture with `extra` merged over `bridgeArgs`; resolves to the result string. */
  capture: (extra: Record<string, unknown>) => Promise<string>;
}

export interface ExecuteBrowseToolOptions {
  /** The clock for the batch deadline. `runActionsBatch`'s positional `now` wins over this; the default is `Date.now`. */
  now?: () => number;
  /** Without it, an `element`-only `browse_act` is refused. */
  locateElement?: ElementLocator;
  /**
   * The actions an `element` description can be resolved for: the host's
   * locator must know each one. Default: click, type, select, hover, press, upload.
   * The refusal text for any other action lists these.
   */
  elementActions?: readonly string[];
  texts?: {
    /** No bridge at all. */
    notAvailable?: string;
    /** The bridge threw something that is not an Error. */
    commandFailed?: string;
    /** The bridge lacks `screenshot` or `tabs`. (A missing `findImages` is not guarded: the call throws and its message is the error.) */
    methodMissing?: (tool: string) => string;
    /** browse_open got `app` but the bridge has no `launchApp`. */
    appLaunchMissing?: string;
  };
  /**
   * Playwright export recording: add `repro: true` to the args of every `browser.act` (single, element-resolved and
   * each batch entry). The controller then answers with `__repro` (a `ReproCapture`), which stays in the tool output
   * (top level of the JSON) for the trace recorder; the session strips it before the model sees it.
   * A batch output carries `__repro: { batch: (ReproCapture | null)[] }`: one entry per COMPLETED action, in order
   * (`null` when the action gave no capture). The per-entry `__repro` is removed from `results`.
   */
  repro?: boolean;
  /** Runs after `browse_screenshot` when the input has `placeOnCanvas: true`. */
  afterScreenshot?: (ctx: AfterScreenshotContext) => Promise<string>;
}

const NOT_AVAILABLE_DEFAULT = "The browser is not available.";
const APP_LAUNCH_MISSING_DEFAULT = "Launching a desktop app is not available in this browser.";
const COMMAND_FAILED_DEFAULT = "Browser command failed.";
const methodMissingDefault = (tool: string) => `${tool} is not supported by this browser.`;

const err = (error: string) => JSON.stringify({ error });
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** Parses a tool result string back to an object. A non-object is reported as an `{ error }` object. */
export function parseResultObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  return { error: "browse_act: malformed result from the browser bridge." };
}

/** Runs a bridge call and stringifies it; a throw becomes `{ error }`. Never rejects. */
export async function callBridge(call: () => Promise<unknown>, opts: ExecuteBrowseToolOptions): Promise<string> {
  try {
    // `undefined` would stringify to `undefined`, not a string.
    return JSON.stringify((await call()) ?? {});
  } catch (e) {
    return err(e instanceof Error ? e.message : (opts.texts?.commandFailed ?? COMMAND_FAILED_DEFAULT));
  }
}

/** Merge a fresh snapshot into a result. Best effort: a failed snapshot leaves the result as it is. */
export async function attachSnapshot(browser: BrowserBridge, result: Record<string, unknown>): Promise<Record<string, unknown>> {
  const snap = await takeSnapshot(browser);
  if ("error" in snap) return result;
  return { ...result, snapshot: snap };
}

/** A non-empty `element` with neither an `index` nor a non-empty `target`: it must be resolved. */
function routesToElement(entry: Record<string, unknown>): boolean {
  const hasTarget = typeof entry.target === "string" && entry.target !== "";
  return isNonEmptyString(entry.element) && entry.index == null && !hasTarget;
}

/** Cheap local checks, made before a snapshot and a locate round trip are spent on a call the bridge would refuse. */
function validateActionArgs(action: string, rest: Record<string, unknown>): string | null {
  if ((action === "type" || action === "select") && !isNonEmptyString(rest.text)) {
    return `browse_act: action "${action}" requires a non-empty "text" field.`;
  }
  if (action === "press" && !isNonEmptyString(rest.key)) {
    return `browse_act: action "press" requires a non-empty "key" field.`;
  }
  if (action === "upload" && !(Array.isArray(rest.files) && rest.files.length > 0)) {
    return `browse_act: action "upload" requires a non-empty "files" array.`;
  }
  if (action === "viewport") {
    const viewport = parseViewportArgs(rest);
    if (!viewport.ok) return viewport.error;
  }
  return null;
}

const COORDINATE_ACTIONS = ["click", "type"];

/** Cheap check of the `x`/`y` fields of one entry; the controller still refuses them outside a native app window. */
function validateCoordinates(entry: Record<string, unknown>): string | null {
  const hasX = entry.x != null;
  const hasY = entry.y != null;
  if (!hasX && !hasY) {
    if (entry.button != null || entry.clicks != null) return 'browse_act: "button" and "clicks" work only with "x" and "y".';
    return null;
  }
  if (hasX !== hasY) return 'browse_act: "x" and "y" must be given together.';
  if (entry.index != null || entry.element != null || (typeof entry.target === "string" && entry.target !== "")) {
    return 'browse_act: use either "index"/"target"/"element" or "x" and "y", not both.';
  }
  if (typeof entry.action !== "string" || !COORDINATE_ACTIONS.includes(entry.action)) {
    return 'browse_act: "x" and "y" work only with "click" and "type".';
  }
  return null;
}

async function resolveByElement(
  browser: BrowserBridge,
  locate: ElementLocator,
  action: string,
  element: string,
  rest: Record<string, unknown>,
  opts: ExecuteBrowseToolOptions,
): Promise<string> {
  const snapshotResult = await takeSnapshot(browser);
  if ("error" in snapshotResult) {
    return err(`browse_act: could not resolve "${element}" — snapshot failed: ${snapshotResult.error}`);
  }
  const snapshot = snapshotResult;

  let located: ElementLocateOutcome;
  try {
    located = await locate({ element, action, snapshot });
  } catch (e) {
    return err(
      `browse_act: element lookup failed while resolving "${element}" (${e instanceof Error ? e.message : String(e)}). Use target or index instead.`,
    );
  }

  if (located.outcome === "failed") {
    return err(
      isNonEmptyString(located.message)
        ? located.message
        : `browse_act: element lookup failed while resolving "${element}". Use target or index instead.`,
    );
  }

  if (located.outcome === "found" && typeof located.index === "number") {
    const actArgs: Record<string, unknown> = { ...rest, action, index: located.index, snapshotId: snapshot.snapshotId, ...(opts.repro ? { repro: true } : {}) };
    delete actArgs.target;

    const result = await callBridge(() => browser.act(actArgs), opts);
    // The lookup took a FRESH snapshot, so any snapshotId the model already had
    // is stale. `resolved` carries the new one, whether the act succeeded or not.
    const resolved = {
      index: located.index,
      label: located.label,
      confidence: located.confidence,
      snapshotId: snapshot.snapshotId,
      note: "this call took a fresh snapshot to resolve `element` — earlier snapshotIds are now stale; use this snapshotId for further index-based browse_act calls",
    };
    try {
      const parsed: unknown = JSON.parse(result);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return JSON.stringify({ ...parsed, resolved });
      }
    } catch {
      // not JSON: hand back the raw result
    }
    return result;
  }

  if (located.outcome === "not_found") {
    return err(
      `No element matched "${element}": ${located.reason ?? "not found"}. Call browse_snapshot to see the elements and act by index.`,
    );
  }

  // "retry", or anything else unrecognized: never a silent success.
  const reason = "reason" in located ? located.reason : undefined;
  return err(
    `browse_act: could not confidently resolve "${element}" (${reason ?? "try again or be more specific"}). Use target or index instead.`,
  );
}

/** One action entry, a top-level call or one entry of a batch. */
async function performOne(
  browser: BrowserBridge | undefined,
  entryArgs: Record<string, unknown>,
  opts: ExecuteBrowseToolOptions,
): Promise<string> {
  const { element, ...rest } = entryArgs;

  const coordinateError = validateCoordinates(entryArgs);
  if (coordinateError) return err(coordinateError);

  if (routesToElement(entryArgs)) {
    if (!opts.locateElement) return err(ELEMENT_UNAVAILABLE);
    const action = typeof rest.action === "string" ? rest.action : "";
    const elementActions = opts.elementActions ?? DEFAULT_ELEMENT_ACTIONS;
    if (!elementActions.includes(action)) {
      return err(
        `browse_act: "element" is only supported for ${listActions(elementActions)} actions (got "${action}"). Use target or index instead.`,
      );
    }
    const validationError = validateActionArgs(action, rest);
    if (validationError) return err(validationError);
    if (!browser) return err(opts.texts?.notAvailable ?? NOT_AVAILABLE_DEFAULT);
    return resolveByElement(browser, opts.locateElement, action, element as string, rest, opts);
  }

  // `element` beside an index/target, or absent: it is dropped, the bridge does not know the field.
  // `viewport` takes no element: a bad call is refused here, before the bridge.
  if (rest.action === "viewport") {
    const refusal = validateActionArgs("viewport", rest);
    if (refusal) return err(refusal);
  }
  if (!browser) return err(opts.texts?.notAvailable ?? NOT_AVAILABLE_DEFAULT);
  return callBridge(() => browser.act(opts.repro ? { ...rest, repro: true } : rest), opts);
}

/**
 * A single call attaches a fresh `snapshot` when the action changed the page
 * (`changed !== false`), and always for `wait` and `scroll`. A result without
 * `changed`, an error too, counts as "may have changed".
 */
async function maybeAttachSnapshot(
  browser: BrowserBridge | undefined,
  action: string,
  result: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!browser) return result;
  const shouldAttach = action === "wait" || action === "scroll" || result.changed !== false;
  return shouldAttach ? attachSnapshot(browser, result) : result;
}

/**
 * Element resolution takes its own snapshot and tells the model to use that
 * `resolved.snapshotId`; the snapshot attached after the act is newer. With
 * both present, drop the stale id and point the note at `snapshot.snapshotId`.
 */
function reconcileResolvedSnapshot(result: Record<string, unknown>): Record<string, unknown> {
  const snapshot = result.snapshot;
  const resolved = result.resolved;
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    typeof (snapshot as { snapshotId?: unknown }).snapshotId !== "string" ||
    !resolved ||
    typeof resolved !== "object" ||
    Array.isArray(resolved)
  ) {
    return result;
  }
  const freshSnapshotId = (snapshot as { snapshotId: string }).snapshotId;
  const { snapshotId: _stale, ...restResolved } = resolved as Record<string, unknown>;
  return {
    ...result,
    resolved: {
      ...restResolved,
      note: `a newer snapshot was taken after this action settled — use snapshot.snapshotId ("${freshSnapshotId}") for further index-based browse_act calls, not the snapshotId this "resolved" carried`,
    },
  };
}

/**
 * An `element` entry re-snapshots the page, and a `viewport` entry changes the layout: both make the
 * batch's `snapshotId` stale for every index-based entry after them. Returns the offending entry
 * (the first one of either kind), or `undefined` when the order is fine. `elements` false: only
 * `viewport` entries count (the host cannot locate elements).
 */
function findStaleOrderViolation(entries: unknown[], elements: boolean): { at: number; kind: "element" | "viewport" } | undefined {
  let breaker: { at: number; kind: "element" | "viewport" } | undefined;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    if (breaker === undefined) {
      if (obj.action === "viewport") breaker = { at: i, kind: "viewport" };
      else if (elements && routesToElement(obj)) breaker = { at: i, kind: "element" };
      continue;
    }
    if (obj.index != null) return breaker;
  }
  return undefined;
}

/**
 * Runs `actions` in order, stopping at the first entry that returns `{ error }`.
 * Index entries without their own `snapshotId` get `topSnapshotId`. Result:
 * `{ results, completed, stoppedAt?, error?, snapshot? }`; the trailing
 * snapshot is skipped once the 60 s deadline has passed. A batch result is not
 * reconciled (`resolved` keeps its snapshotId).
 */
export async function runActionsBatch(
  browser: BrowserBridge | undefined,
  actions: unknown[],
  topSnapshotId: string | undefined,
  now?: () => number,
  opts: ExecuteBrowseToolOptions = {},
): Promise<string> {
  // One clock: the positional `now`, else `opts.now`, else Date.now.
  const clock = now ?? opts.now ?? (() => Date.now());
  if (actions.length === 0) return err('browse_act: "actions" must contain at least 1 entry.');
  if (actions.length > MAX_BATCH_ACTIONS) return err(`browse_act: "actions" accepts at most ${MAX_BATCH_ACTIONS} entries.`);
  if (!browser) return err(opts.texts?.notAvailable ?? NOT_AVAILABLE_DEFAULT);

  const staleOrder = findStaleOrderViolation(actions, Boolean(opts.locateElement));
  if (staleOrder) {
    if (staleOrder.kind === "viewport") {
      return err(
        `browse_act: actions[${staleOrder.at}] is a viewport action, which changes the layout and makes the batch's ` +
          "snapshotId stale for every index-based entry after it. Put viewport last in a batch, or take a new snapshot after it.",
      );
    }
    return err(
      `browse_act: actions[${staleOrder.at}] uses "element", which re-snapshots the page and ` +
        "makes the batch's snapshotId stale for every index-based entry after it — element entries " +
        "re-snapshot the page; put them last or split the batch.",
    );
  }

  const deadline = clock() + BATCH_DEADLINE_MS;
  const results: unknown[] = [];
  const reproBatch: (ReproCapture | null)[] = [];
  let completed = 0;
  let stoppedAt: number | undefined;
  let batchError: string | undefined;

  for (let i = 0; i < actions.length; i++) {
    if (clock() >= deadline) {
      batchError = "browse_act: batch deadline reached.";
      stoppedAt = i;
      break;
    }
    const raw = actions[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      batchError = `browse_act: actions[${i}] must be an object.`;
      results.push({ error: batchError });
      stoppedAt = i;
      break;
    }
    const entry: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    // The bridge reads any snapshotId as index mode: copy it only into entries with an index.
    if (entry.snapshotId == null && topSnapshotId != null && entry.index != null) entry.snapshotId = topSnapshotId;

    const parsed = parseResultObject(await performOne(browser, entry, opts));
    // The capture is kept once, in the top-level `__repro.batch`, not in each result.
    const capture = parsed[REPRO_KEY];
    delete parsed[REPRO_KEY];
    results.push(parsed);
    const entryError = resultError(parsed);
    if (entryError) {
      batchError = entryError;
      stoppedAt = i;
      break;
    }
    reproBatch.push(capture && typeof capture === "object" && !Array.isArray(capture) ? (capture as ReproCapture) : null);
    completed++;
  }

  const out: Record<string, unknown> = {
    results,
    completed,
    ...(stoppedAt != null ? { stoppedAt } : {}),
    ...(batchError ? { error: batchError } : {}),
    ...(opts.repro ? { [REPRO_KEY]: { batch: reproBatch } } : {}),
  };
  return JSON.stringify(clock() >= deadline ? out : await attachSnapshot(browser, out));
}

async function browseAct(
  browser: BrowserBridge | undefined,
  input: Record<string, unknown>,
  opts: ExecuteBrowseToolOptions,
): Promise<string> {
  const { actions, ...top } = input;
  if (Array.isArray(actions)) {
    return runActionsBatch(browser, actions, typeof top.snapshotId === "string" ? top.snapshotId : undefined, opts.now, opts);
  }
  const action = typeof input.action === "string" ? input.action : "";
  const resultStr = await performOne(browser, input, opts);
  if (!browser) return resultStr;
  const withSnapshot = await maybeAttachSnapshot(browser, action, parseResultObject(resultStr));
  return JSON.stringify(reconcileResolvedSnapshot(withSnapshot));
}

async function browseScreenshot(
  browser: BrowserBridge | undefined,
  args: Record<string, unknown>,
  opts: ExecuteBrowseToolOptions,
): Promise<string> {
  const { placeOnCanvas, x: _x, y: _y, ...bridgeArgs } = args;
  const shot = browser?.screenshot?.bind(browser);
  const take = async (extra: Record<string, unknown>): Promise<string> => {
    if (!browser) return err(opts.texts?.notAvailable ?? NOT_AVAILABLE_DEFAULT);
    if (!shot) return err((opts.texts?.methodMissing ?? methodMissingDefault)("browse_screenshot"));
    return callBridge(() => shot({ ...bridgeArgs, ...extra }), opts);
  };
  const raw = await take({});
  if (placeOnCanvas !== true || !opts.afterScreenshot) return raw;
  return opts.afterScreenshot({
    raw,
    result: parseResultObject(raw),
    args,
    bridgeArgs,
    capture: take,
  });
}

/**
 * Run one of the seven browse tools. Always resolves to a string: a refusal or
 * a failure is `{ "error": "..." }`. A successful `browse_open` and a
 * page-changing `browse_act` carry a fresh `snapshot`.
 *
 * `browse_act` accepts `element` (a description of the target) only when
 * `opts.locateElement` is given; without it an element-only call is refused.
 */
export async function executeBrowseTool(
  browser: BrowserBridge | undefined,
  toolName: string,
  input: unknown,
  opts: ExecuteBrowseToolOptions = {},
): Promise<string> {
  const args: Record<string, unknown> =
    input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const notAvailable = () => err(opts.texts?.notAvailable ?? NOT_AVAILABLE_DEFAULT);
  switch (toolName) {
    case "browse_open": {
      if (!browser) return notAvailable();
      const app = typeof args.app === "string" ? args.app.trim() : "";
      if (app !== "") {
        if (!browser.launchApp) return err(opts.texts?.appLaunchMissing ?? APP_LAUNCH_MISSING_DEFAULT);
        const launched = await callBridge(() => browser.launchApp!({ app }), opts);
        const parsedLaunch = parseResultObject(launched);
        if (resultError(parsedLaunch)) return launched;
        return JSON.stringify(await attachSnapshot(browser, parsedLaunch));
      }
      const raw = await callBridge(() => browser.open(args as { url: string }), opts);
      const parsed = parseResultObject(raw);
      if (resultError(parsed)) return raw;
      return JSON.stringify(await attachSnapshot(browser, parsed));
    }
    case "browse_snapshot":
      return browser ? callBridge(() => browser.snapshot(), opts) : notAvailable();
    case "browse_screenshot":
      return browseScreenshot(browser, args, opts);
    case "browse_act":
      return browseAct(browser, args, opts);
    case "browse_tabs": {
      if (!browser) return notAvailable();
      const tabs = browser.tabs?.bind(browser);
      if (!tabs) return err((opts.texts?.methodMissing ?? methodMissingDefault)(toolName));
      return callBridge(() => tabs(args as Parameters<NonNullable<BrowserBridge["tabs"]>>[0]), opts);
    }
    case "browse_find_images": {
      if (!browser) return notAvailable();
      // Not guarded, as Pen Editor's handler never was: a bridge without
      // `findImages` throws, and the TypeError message is the error.
      return callBridge(() => browser.findImages!(args), opts);
    }
    case "browse_read":
      return browser ? callBridge(() => browser.read(args), opts) : notAvailable();
    default:
      return err(`Unknown browse tool: ${toolName}.`);
  }
}
