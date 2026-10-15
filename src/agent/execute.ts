// Runs the seven browse tools against a `BrowserBridge`. The same mapping Pen
// Editor's frontend handlers (src/lib/tools/browser/*) apply, minus the
// host-only parts (canvas placement, natural-language `element` targeting).
import type { BrowserBridge } from "../loop/bridge.js";
import { resultError, takeSnapshot } from "../loop/shared.js";
import { parseJsonObject } from "./session.js";

const MAX_BATCH_ACTIONS = 10;
/** A batch may start no new entry after this time. */
const BATCH_DEADLINE_MS = 60_000;

const ELEMENT_UNAVAILABLE =
  'browse_act: element targeting is not available here. Use target or index instead.';

const missing = (tool: string) => JSON.stringify({ error: `${tool} is not supported by this browser.` });

async function callBridge(call: () => Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify((await call()) ?? {});
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : "Browser command failed." });
  }
}

/** Merge a fresh snapshot into a result. Best effort: a failed snapshot leaves the result as it is. */
async function attachSnapshot(browser: BrowserBridge, result: Record<string, unknown>): Promise<Record<string, unknown>> {
  const snap = await takeSnapshot(browser);
  return "error" in snap ? result : { ...result, snapshot: snap };
}

function hasElementOnly(entry: Record<string, unknown>): boolean {
  const hasTarget = typeof entry.target === "string" && entry.target !== "";
  return typeof entry.element === "string" && entry.element.trim() !== "" && entry.index == null && !hasTarget;
}

async function actOne(browser: BrowserBridge, entry: Record<string, unknown>): Promise<string> {
  const { element: _element, ...rest } = entry;
  if (hasElementOnly(entry)) return JSON.stringify({ error: ELEMENT_UNAVAILABLE });
  return callBridge(() => browser.act(rest));
}

async function actBatch(
  browser: BrowserBridge,
  entries: unknown[],
  topSnapshotId: string | undefined,
  now: () => number,
): Promise<string> {
  if (entries.length === 0) return JSON.stringify({ error: 'browse_act: "actions" must contain at least 1 entry.' });
  if (entries.length > MAX_BATCH_ACTIONS) {
    return JSON.stringify({ error: `browse_act: "actions" accepts at most ${MAX_BATCH_ACTIONS} entries.` });
  }
  const deadline = now() + BATCH_DEADLINE_MS;
  const results: unknown[] = [];
  let completed = 0;
  let stoppedAt: number | undefined;
  let batchError: string | undefined;
  for (let i = 0; i < entries.length; i++) {
    if (now() >= deadline) {
      batchError = "browse_act: batch deadline reached.";
      stoppedAt = i;
      break;
    }
    const raw = entries[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      batchError = `browse_act: actions[${i}] must be an object.`;
      results.push({ error: batchError });
      stoppedAt = i;
      break;
    }
    const entry: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    // The bridge reads any snapshotId as index mode: copy it only into entries with an index.
    if (entry.snapshotId == null && topSnapshotId != null && entry.index != null) entry.snapshotId = topSnapshotId;
    const parsed = parseJsonObject(await actOne(browser, entry));
    results.push(parsed);
    const err = resultError(parsed);
    if (err) {
      batchError = err;
      stoppedAt = i;
      break;
    }
    completed++;
  }
  const out: Record<string, unknown> = {
    results,
    completed,
    ...(stoppedAt != null ? { stoppedAt } : {}),
    ...(batchError ? { error: batchError } : {}),
  };
  return JSON.stringify(now() >= deadline ? out : await attachSnapshot(browser, out));
}

async function browseAct(browser: BrowserBridge, input: Record<string, unknown>, now: () => number): Promise<string> {
  const { actions, ...top } = input;
  if (Array.isArray(actions)) {
    return actBatch(browser, actions, typeof top.snapshotId === "string" ? top.snapshotId : undefined, now);
  }
  const action = typeof input.action === "string" ? input.action : "";
  const parsed = parseJsonObject(await actOne(browser, input));
  // A snapshot follows a change; wait and scroll always get one. A result
  // without `changed` (an error too) counts as "may have changed".
  const attach = action === "wait" || action === "scroll" || parsed.changed !== false;
  return JSON.stringify(attach ? await attachSnapshot(browser, parsed) : parsed);
}

/**
 * Run one of the seven browse tools. Always resolves to a JSON string: a
 * refusal or a failure is `{ "error": "..." }`. A successful `browse_open` and
 * a page-changing `browse_act` carry a fresh `snapshot`, as in Pen Editor.
 *
 * `browse_screenshot` passes only `annotate` to the bridge: the host-only
 * fields of a widened schema (`placeOnCanvas`, `x`, `y`) are dropped. A host
 * that supports them handles the tool itself.
 */
export async function executeBrowseTool(
  browser: BrowserBridge,
  toolName: string,
  input: unknown,
  opts: { now?: () => number } = {},
): Promise<string> {
  const args: Record<string, unknown> = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  switch (toolName) {
    case "browse_open": {
      const raw = await callBridge(() => browser.open({ url: String(args.url ?? "") }));
      const parsed = parseJsonObject(raw);
      if (resultError(parsed)) return raw;
      return JSON.stringify(await attachSnapshot(browser, parsed));
    }
    case "browse_snapshot":
      return callBridge(() => browser.snapshot());
    case "browse_screenshot": {
      const shot = browser.screenshot?.bind(browser);
      if (!shot) return missing(toolName);
      return callBridge(() => shot(args.annotate === true ? { annotate: true } : {}));
    }
    case "browse_act":
      return browseAct(browser, args, opts.now ?? (() => Date.now()));
    case "browse_tabs": {
      const tabs = browser.tabs?.bind(browser);
      if (!tabs) return missing(toolName);
      return callBridge(() => tabs(args as Parameters<NonNullable<BrowserBridge["tabs"]>>[0]));
    }
    case "browse_find_images": {
      const find = browser.findImages?.bind(browser);
      if (!find) return missing(toolName);
      return callBridge(() => find(args));
    }
    case "browse_read":
      return callBridge(() => browser.read(args));
    default:
      return JSON.stringify({ error: `Unknown browse tool: ${toolName}.` });
  }
}
