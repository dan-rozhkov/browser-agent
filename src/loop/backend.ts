/**
 * The loop's remote policy: where `/api/browse/step`, `/plan` and `/locate`
 * requests go. The HTTP-response shape is kept on purpose — the loop's retry
 * rules (429, 503 + Retry-After) and error branches stay as they were when
 * the loop POSTed to the backend directly. `createHttpBackend` (adapters)
 * talks to a remote server; `createLocalBackend` runs the policy in-process.
 */
export type BrowseEndpoint = "/api/browse/step" | "/api/browse/plan" | "/api/browse/locate";

/**
 * A backend answer: the parsed body alongside `status`/`ok` — callers still
 * own status-code and JSON-shape handling (browse/step's "any non-ok status
 * is a hard failure" differs from browse/locate's "503 means no fast model
 * configured, everything else is a retry-and-fall-back signal"). `body` is
 * `null` when the response wasn't valid JSON (an error page from a proxy in
 * front of the backend, say) — callers already treat a response they can't
 * make sense of as a failure, so this is reported the same way a
 * missing/unrecognized field would be, not as a thrown error.
 */
export interface BrowseBackendResponse {
  status: number;
  ok: boolean;
  body: unknown;
  /** `Retry-After` header in seconds, when present and numeric. */
  retryAfterSec?: number;
}

export interface BrowseBackend {
  /**
   * One request. `timeoutMs` bounds the WHOLE round trip (connect through
   * body-read), `signal` aborts it in flight (Stop / cancelled browse_task).
   */
  request(
    path: BrowseEndpoint,
    body: Record<string, unknown>,
    opts: { timeoutMs: number; signal?: AbortSignal }
  ): Promise<BrowseBackendResponse>;
}
