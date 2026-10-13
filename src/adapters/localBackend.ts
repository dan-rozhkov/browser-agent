import type { BrowseBackend, BrowseBackendResponse } from "../loop/backend.js";
import { locateTarget, planGoal, decideStep, type BrowsePolicyOptions } from "../policy/decide.js";
import { SystemOneError, SystemOneRateLimitError } from "../policy/decisions.js";
import {
  browseLocateBodySchema,
  browsePlanBodySchema,
  browseStepBodySchema,
} from "../policy/schemas.js";

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

function retryAfterOf(err: unknown): number | undefined {
  const v = (err as { retryAfterSec?: unknown } | null)?.retryAfterSec;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function failure(path: string, err: unknown): BrowseBackendResponse {
  if (err instanceof SystemOneRateLimitError) {
    const retryAfterSec = retryAfterOf(err);
    return {
      status: 429,
      ok: false,
      body: { error: err.message },
      ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
    };
  }
  if (err instanceof SystemOneError) {
    // The HTTP routes answered 502 with a fixed per-route message.
    return { status: 502, ok: false, body: { error: FAILURE_MESSAGE[path] ?? "browse request failed" } };
  }
  return { status: 500, ok: false, body: { error: err instanceof Error ? err.message : "internal error" } };
}

const FAILURE_MESSAGE: Record<string, string> = {
  "/api/browse/step": "failed to evaluate the next browsing step",
  "/api/browse/locate": "failed to locate the requested element",
};

/**
 * A `BrowseBackend` that runs the policy in-process (no HTTP): the same
 * validation, status codes and bodies as pen-editor-backend's
 * `/api/browse/{step,plan,locate}` routes, so the loop cannot tell it from
 * `createHttpBackend`. Never throws for a policy failure — only an abort
 * (or the request timeout) rejects, with an `AbortError` like `fetch`.
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
              () => decideStep(opts, parsed.data),
              timeoutMs,
              signal,
            );
            return ok(result);
          }
          case "/api/browse/plan": {
            const parsed = browsePlanBodySchema.safeParse(body);
            if (!parsed.success) return invalid(parsed.error.issues[0]?.message);
            const { subgoals } = await bounded(
              (s) => planGoal(opts, parsed.data, s),
              timeoutMs,
              signal,
            );
            return ok({ subgoals });
          }
          case "/api/browse/locate": {
            const parsed = browseLocateBodySchema.safeParse(body);
            if (!parsed.success) return invalid(parsed.error.issues[0]?.message);
            return ok(await bounded(() => locateTarget(opts, parsed.data), timeoutMs, signal));
          }
          default:
            return { status: 404, ok: false, body: { error: `unknown endpoint ${String(path)}` } };
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err;
        return failure(path, err);
      }
    },
  };
}
