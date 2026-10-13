import type { BrowseBackend, BrowseBackendResponse } from "../loop/backend.js";

export interface HttpBackendOptions {
  /** Backend origin (and optional path prefix), e.g. `https://api.example.com`. */
  baseUrl: string;
  /** Defaults to `globalThis.fetch`, resolved at call time. */
  fetch?: typeof fetch;
  /** Extra request headers (an auth token, say); a function is called per request. */
  headers?: Record<string, string> | (() => Record<string, string>);
  /** Fetch credentials mode (`"include"` sends cookies cross-origin, as an
   * accounts-enabled host needs); a function is called per request. */
  credentials?: RequestCredentials | (() => RequestCredentials | undefined);
}

/**
 * A `BrowseBackend` that POSTs to a `/api/browse/*` server (pen-editor's
 * backend, or anything speaking the same routes). This is the old
 * `fetchBrowseBackendOnce` with the URL resolution injected.
 *
 * The timeout bounds `res.json()` too, not just the fetch — it used to only
 * wrap the `fetch()` call, clearing the abort timer as soon as headers
 * arrived; a backend that sent headers promptly but then stalled writing
 * (or streamed) the body could hang `res.json()` indefinitely with no
 * timeout protecting it at all. Doing the parse here, inside the same
 * try/finally, means `timeoutMs` bounds the WHOLE round trip — connect
 * through body-read.
 */
export function createHttpBackend(opts: HttpBackendOptions): BrowseBackend {
  const base = opts.baseUrl.replace(/\/+$/, "");
  return {
    async request(path, body, { timeoutMs, signal }): Promise<BrowseBackendResponse> {
      const doFetch = opts.fetch ?? globalThis.fetch;
      const extra = typeof opts.headers === "function" ? opts.headers() : (opts.headers ?? {});
      const credentials = typeof opts.credentials === "function" ? opts.credentials() : opts.credentials;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      if (signal?.aborted) controller.abort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const res = await doFetch(`${base}${path}`, {
          method: "POST",
          headers: { ...extra, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
          ...(credentials !== undefined ? { credentials } : {}),
        });
        let parsedBody: unknown = null;
        try {
          parsedBody = await res.json();
        } catch {
          // Non-JSON body — report as `null` rather than throwing, same as an
          // unrecognized/missing field elsewhere on these responses.
          parsedBody = null;
        }
        const rawRetry = res.headers?.get?.("Retry-After");
        const retryAfterSec = rawRetry != null && rawRetry.trim() !== "" ? Number(rawRetry) : NaN;
        return {
          status: res.status,
          ok: res.ok,
          body: parsedBody,
          ...(Number.isFinite(retryAfterSec) && retryAfterSec >= 0 ? { retryAfterSec } : {}),
        };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
