import { vi } from "vitest";
import type { BrowserBridge } from "../../src/loop/bridge.js";
import {
  executeBrowseTool,
  runActionsBatch as runBatch,
  type ElementLocateOutcome,
  type ElementLocateRequest,
  type ExecuteBrowseToolOptions,
} from "../../src/agent/execute.js";

// Harness for the browse tool executor suites: a recording fake bridge (every
// call logged as {method, args}, results scripted per call) and a scripted
// element locator. The suites that use it are ported from Pen Editor's
// characterization suite (src/lib/tools/browser/__tests__/characterization/),
// which pins the host's exact output, so the package guards the same bytes.

export const BROWSER_NOT_AVAILABLE_ERROR = "The built-in browser is only available in the host app.";
export const BROWSER_BRIDGE_METHOD_MISSING_ERROR = "This browser command needs a newer version of the host app.";
export const COMMAND_FAILED = "Built-in browser command failed.";

export type BridgeMethod =
  | "open"
  | "act"
  | "snapshot"
  | "findImages"
  | "read"
  | "perform"
  | "screenshot"
  | "tabs"
  | "capture";

export interface BridgeCall {
  method: BridgeMethod;
  args: unknown[];
}

/** A scripted step that makes the bridge method reject with `error`. */
export class Throws {
  constructor(readonly error: unknown) {}
}
export const throws = (error: unknown) => new Throws(error);

type Step = unknown | Throws | ((...args: unknown[]) => unknown);
export type BridgeScript = Partial<Record<BridgeMethod, Step[]>>;

export interface RecordingBridge {
  browser: BrowserBridge;
  calls: BridgeCall[];
  callsTo(method: BridgeMethod): BridgeCall[];
  methods(): BridgeMethod[];
}

const ALL_METHODS: BridgeMethod[] = ["open", "act", "snapshot", "findImages", "read", "perform", "screenshot", "tabs", "capture"];

/**
 * Each method consumes its script in order; once exhausted it repeats the LAST
 * step; a method with no script resolves `{}`. A step may be a plain value, a
 * `throws(err)` or a function receiving the call's arguments. `omit` leaves
 * methods off the object (an older bridge).
 */
export function makeBridge(script: BridgeScript = {}, omit: BridgeMethod[] = []): RecordingBridge {
  const calls: BridgeCall[] = [];
  const cursors: Partial<Record<BridgeMethod, number>> = {};
  const browser: Record<string, unknown> = {};
  for (const method of ALL_METHODS) {
    if (omit.includes(method)) continue;
    browser[method] = async (...args: unknown[]) => {
      calls.push({ method, args: structuredClone(args) });
      const steps = script[method];
      if (!steps || steps.length === 0) return {};
      const at = cursors[method] ?? 0;
      cursors[method] = at + 1;
      const step = steps[Math.min(at, steps.length - 1)];
      if (step instanceof Throws) throw step.error;
      if (typeof step === "function") return (step as (...a: unknown[]) => unknown)(...args);
      return step;
    };
  }
  return {
    browser: browser as unknown as BrowserBridge,
    calls,
    callsTo: (method) => calls.filter((c) => c.method === method),
    methods: () => calls.map((c) => c.method),
  };
}

let current: RecordingBridge | undefined;
let locator: ((req: ElementLocateRequest) => Promise<ElementLocateOutcome>) | undefined;

/** Installs the bridge the adapters below run against. */
export function bridgeWith(script: BridgeScript = {}, omit: BridgeMethod[] = []): RecordingBridge {
  current = makeBridge(script, omit);
  return current;
}

export function noBridge(): void {
  current = undefined;
}

export function resetEnvironment(): void {
  current = undefined;
  locator = undefined;
  vi.useRealTimers();
}

export const PAGE_URL = "https://example.com/";

export function snap(
  snapshotId: string,
  elements: unknown[] = [{ index: 0, tag: "button", label: "Go", ops: ["CLICK"] }],
) {
  return { url: PAGE_URL, title: "Example", elements, snapshotId };
}

/** snapshot script for n calls that each do "pre-snapshot ok, trailing snapshot fails". */
export function snapThenFail(pre: unknown, n: number): unknown[] {
  return Array.from({ length: n * 2 }, (_, i) => (i % 2 === 0 ? pre : { error: "no trailing snapshot" }));
}

export const j = (value: unknown): string => JSON.stringify(value);

export const FOUND = (index: number, extra: Record<string, unknown> = {}) => ({
  outcome: "found" as const,
  index,
  label: "Go",
  confidence: 0.9,
  ...extra,
});

/** Scripts the locator: replies are consumed in order, the last repeats. */
export function stubLocate(replies: ElementLocateOutcome[]) {
  const requests: ElementLocateRequest[] = [];
  const fetchMock = vi.fn(async (req: ElementLocateRequest) => {
    requests.push(req);
    return replies[Math.min(requests.length - 1, replies.length - 1)];
  });
  locator = fetchMock;
  return { fetchMock, requests };
}

export const hostOptions = (): ExecuteBrowseToolOptions => ({
  // The host always has a locator; an unscripted one fails loudly.
  locateElement: (req) => (locator ? locator(req) : Promise.resolve({ outcome: "failed", message: "no locator scripted" })),
  texts: {
    notAvailable: BROWSER_NOT_AVAILABLE_ERROR,
    methodMissing: () => BROWSER_BRIDGE_METHOD_MISSING_ERROR,
    commandFailed: COMMAND_FAILED,
  },
});

const tool = (name: string) => (args: Record<string, unknown>, _ctx?: unknown) =>
  executeBrowseTool(current?.browser, name, args, hostOptions());

export const browseOpen = tool("browse_open");
export const browseSnapshot = tool("browse_snapshot");
export const browseTabs = tool("browse_tabs");
export const browseFindImages = tool("browse_find_images");
export const browseRead = tool("browse_read");
export const browseScreenshot = tool("browse_screenshot");
export const browseAct = tool("browse_act");

export const runActionsBatch = (
  browser: BrowserBridge | undefined,
  actions: unknown[],
  top: string | undefined,
  now?: () => number,
) => runBatch(browser, actions, top, now, hostOptions());
