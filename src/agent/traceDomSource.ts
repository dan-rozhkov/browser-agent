import type { BrowserBridge } from "../loop/bridge.js";

/**
 * Time box passed to the controller for a trace DOM capture. The recorder's own bound is 5000 ms
 * (`DOM_TIMEOUT_MS` in traceRecorder.ts): the controller needs the budget PLUS the round trip of the bridge call and
 * the wait for the controller lock, so the controller gives up first and the recorder's timer stays the backstop
 * (a recorder timeout disables DOM capture for the rest of the run).
 */
export const TRACE_DOM_BUDGET_MS = 3500;

type TraceDomResult = { html: string; url?: string; title?: string; width?: number; height?: number };

/**
 * The ONE `captureDom` source of the trace recorder (docs/specs/2026-10-26-trace-dom-snapshot-design.md), for any
 * host. It calls `capture({ budgetMs, forTrace: true })` and returns the page as html, or `undefined` when the signal
 * is aborted, `capture` is missing, the call throws, or it answers `{ error }`.
 *
 * It REQUIRES proof that the redaction ran: the controller echoes `forTrace: true` in its answer when it applied the
 * trace redaction. An answer without the echo comes from an older controller that ignored the arg, and its html may
 * hold hidden-input values or secret URL params: it is discarded, and the source disables itself for the rest of its
 * life, so an old controller is asked at most once.
 *
 * An abort resolves `undefined` at once, but the bridge call itself cannot be cancelled: it runs on until the
 * controller's own `budgetMs` ends it, and its result is dropped.
 *
 * An older controller (one that ignores `budgetMs`) runs its single probe call under its own 45 s budget and holds
 * the controller lock for that time. That call cannot be cancelled either: the source asks such a controller only
 * once, and the lock is free again only when the 45 s end.
 */
export function createTraceDomSource(bridge: Pick<BrowserBridge, "capture">): (signal: AbortSignal) => Promise<TraceDomResult | undefined> {
  let disabled = false;
  return async (signal) => {
    if (disabled || signal.aborted || !bridge.capture) return undefined;
    let onAbort: (() => void) | undefined;
    try {
      const gone = Symbol("gone");
      const out = await Promise.race([
        bridge.capture({ budgetMs: TRACE_DOM_BUDGET_MS, forTrace: true }) as Promise<unknown>,
        new Promise<typeof gone>((resolve) => {
          onAbort = () => resolve(gone);
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      if (out === gone || signal.aborted) return undefined;
      const r = out as { html?: unknown; width?: unknown; height?: unknown; url?: unknown; title?: unknown; error?: unknown; forTrace?: unknown } | null | undefined;
      if (!r || typeof r !== "object" || r.error !== undefined) return undefined;
      if (r.forTrace !== true) {
        // An older controller ignored `forTrace`: never trust this html, and do not ask again.
        disabled = true;
        return undefined;
      }
      if (typeof r.html !== "string") return undefined;
      return {
        html: r.html,
        ...(typeof r.url === "string" ? { url: r.url } : {}),
        ...(typeof r.title === "string" ? { title: r.title } : {}),
        ...(typeof r.width === "number" ? { width: r.width } : {}),
        ...(typeof r.height === "number" ? { height: r.height } : {}),
      };
    } catch {
      return undefined;
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  };
}
