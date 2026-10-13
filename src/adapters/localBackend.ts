import type { BrowseBackend, BrowseBackendResponse } from "../loop/backend.js";
import { locateTarget, planGoal, decideStep, type BrowsePolicyOptions } from "../policy/decide.js";
import type { DecisionClient } from "../policy/decisions.js";
import {
  browseLocateBodySchema,
  browsePlanBodySchema,
  browseStepBodySchema,
} from "../policy/schemas.js";
import type { TextModel } from "../policy/textModel.js";

function abortError(): Error {
  const e = new Error("This operation was aborted");
  e.name = "AbortError";
  return e;
}

/** Rejects like `fetch` does when `signal` aborts (or `timeoutMs` passes);
 * already-aborted → rejects before any policy work starts. */
async function bounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  outer: AbortSignal | undefined,
): Promise<T> {
  if (outer?.aborted) throw abortError();
  const inner = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    const fire = () => {
      inner.abort();
      reject(abortError());
    };
    timer = setTimeout(fire, timeoutMs);
    onAbort = fire;
    outer?.addEventListener("abort", fire, { once: true });
  });
  try {
    const run = work(inner.signal);
    run.catch(() => undefined); // an abandoned run must not become an unhandled rejection
    return await Promise.race([run, aborted]);
  } finally {
    clearTimeout(timer);
    if (onAbort) outer?.removeEventListener("abort", onAbort);
  }
}

/** The routes (registerJevBrowseRoute) answered 502 with a fixed per-route
 * message for ANY thrown error; 429 came only from the HTTP rate-limit plugin,
 * which has no in-process equivalent. */
function failure(path: string): BrowseBackendResponse {
  return { status: 502, ok: false, body: { error: FAILURE_MESSAGE[path] ?? "browse request failed" } };
}

const FAILURE_MESSAGE: Record<string, string> = {
  "/api/browse/step": "failed to evaluate the next browsing step",
  "/api/browse/locate": "failed to locate the requested element",
};

function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  return a ? AbortSignal.any([a, b]) : b;
}

/** Per-request copy of the policy options whose clients also stop when
 * `signal` aborts (Stop, timeout), so the in-process policy does not keep
 * spending paid calls after the caller has given up. */
function withRequestSignal(opts: BrowsePolicyOptions, signal: AbortSignal): BrowsePolicyOptions {
  const wrapModel = (m: TextModel): TextModel => ({
    get id() {
      return m.id;
    },
    generateObject: (req) => m.generateObject({ ...req, abortSignal: mergeSignals(req.abortSignal, signal) }),
  });
  const decisions: DecisionClient = {
    get model() {
      return opts.decisions.model;
    },
    evaluate: (params) =>
      opts.decisions.evaluate({ ...params, signal: mergeSignals(params.signal, signal) }),
  };
  return {
    ...opts,
    decisions,
    models: { structured: wrapModel(opts.models.structured), cascade: wrapModel(opts.models.cascade) },
  };
}

/**
 * A `BrowseBackend` that runs the policy in-process (no HTTP): the same
 * validation, status codes and bodies as pen-editor-backend's
 * `/api/browse/{step,plan,locate}` routes, so the loop cannot tell it from
 * `createHttpBackend`. Never throws for a policy failure (any thrown error
 * answers 502 with the route's fixed message) — only an abort (or the request
 * timeout) rejects, with an `AbortError` like `fetch`.
 * `diag` (step) and `fallbackReason` (plan) are server-side and stripped.
 */
export function createLocalBackend(opts: BrowsePolicyOptions): BrowseBackend {
  return {
    async request(path, body, { timeoutMs, signal }): Promise<BrowseBackendResponse> {
      if (signal?.aborted) throw abortError();
      const invalid = (issue: string | undefined): BrowseBackendResponse => ({
        status: 400,
        ok: false,
        body: { error: issue ?? "invalid body" },
      });
      const ok = (b: unknown): BrowseBackendResponse => ({ status: 200, ok: true, body: b });
      try {
        switch (path) {
          case "/api/browse/step": {
            const parsed = browseStepBodySchema.safeParse(body);
            if (!parsed.success) return invalid(parsed.error.issues[0]?.message);
            const { diag: _diag, ...result } = await bounded(
              (s) => decideStep(withRequestSignal(opts, s), parsed.data),
              timeoutMs,
              signal,
            );
            return ok(result);
          }
          case "/api/browse/plan": {
            const parsed = browsePlanBodySchema.safeParse(body);
            if (!parsed.success) return invalid(parsed.error.issues[0]?.message);
            const { subgoals } = await bounded(
              (s) =>
                planGoal(withRequestSignal(opts, s), parsed.data, s),
              timeoutMs,
              signal,
            );
            return ok({ subgoals });
          }
          case "/api/browse/locate": {
            const parsed = browseLocateBodySchema.safeParse(body);
            if (!parsed.success) return invalid(parsed.error.issues[0]?.message);
            return ok(await bounded((s) => locateTarget(withRequestSignal(opts, s), parsed.data), timeoutMs, signal));
          }
          default:
            return { status: 404, ok: false, body: { error: `unknown endpoint ${String(path)}` } };
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err;
        return failure(path);
      }
    },
  };
}
