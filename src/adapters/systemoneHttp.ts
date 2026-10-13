import { z } from "zod";
import {
  isOpenAIDecisions,
  SystemOneAuthError,
  SystemOneError,
  SystemOneRateLimitError,
  SystemOneRefusalError,
  SystemOneUpstreamError,
  SystemOneValidationError,
  type DecisionClient,
  type SystemOneAnswer,
  type SystemOneEvaluateParams,
  type SystemOneQuestion,
  type SystemOneResult,
} from "../policy/decisions.js";

// Small HTTP client for TypeSafe AI's "System One" evaluation model (Jev).
// No SDK dependency — global fetch is enough. A factory that takes an
// injectable `fetch` for testability. The types, errors and model predicates
// live in policy/decisions.ts.
//
// Vendor contract (verified live 2026-09):
//   POST {baseUrl}/systemone
//   Headers: Authorization: Bearer <key>, Content-Type: application/json
//   Body: { state, model, questions }
//   Response: { model, answers, usage: { input_tokens, output_tokens } }
// Answers are keyed by the SAME ids the caller used for `questions`.

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
// A vendor-supplied Retry-After longer than this means giving up rather than
// sleeping through it. Chat-path callers (skillRouting.ts) budget 1.5s total
// for the whole round trip, and even the 30s REQUEST_TIMEOUT_MS above is a
// ceiling on the ENTIRE call including every retry sleep — honoring an
// arbitrarily large Retry-After (a real vendor response, e.g. 60s) would blow
// through both. Deliberately well under REQUEST_TIMEOUT_MS so a capped sleep
// still leaves room for the retry's own fetch.
const MAX_RETRY_AFTER_MS = 10_000;
// OpenAI Decisions (e.g. openai/gpt-6-luna-decisions) speak the same
// System One contract on OpenRouter; see createSystemOneClient.
export const OPENROUTER_DECISIONS_BASE_URL = "https://openrouter.ai/api/v1";

// --- Response validation ------------------------------------------------

const answerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("noul"),
    noul: z.number(),
  }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    legend: z.record(z.string(), z.string()),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  }),
]);

const responseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
});

const errorBodySchema = z.object({
  detail: z.object({
    error_type: z.string().optional(),
    message: z.string().optional(),
  }),
});

// OpenRouter-hosted deployments (OpenAI Decisions) answer errors as
// `{ error: { message, code } }` instead of the documented `{ detail }`.
const openRouterErrorBodySchema = z.object({
  error: z.object({ message: z.string().optional() }),
});

// The first call, then up to three resends without the refused questions
// (a Decisions model can refuse several heads one at a time).
const MAX_ROUNDS = 4;

const REFUSAL_MESSAGE_RE = /^OpenAI refused to answer question "([^"]+)"$/;
const refusalBodySchema = z.object({
  error: z.object({ message: z.string(), code: z.number() }),
});

function parseRefusedQuestionId(status: number, text: string | undefined): string | undefined {
  if (status !== 502 || !text) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = refusalBodySchema.safeParse(json);
  if (!parsed.success || parsed.data.error.code !== 502) return undefined;
  return REFUSAL_MESSAGE_RE.exec(parsed.data.error.message)?.[1];
}

async function readBodyText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

async function extractDetailMessage(response: Response): Promise<string | undefined> {
  return detailFromText(await readBodyText(response));
}

function detailFromText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  try {
    const parsed = errorBodySchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data.detail.message;
    const alt = openRouterErrorBodySchema.safeParse(JSON.parse(text));
    if (alt.success && alt.data.error.message) return alt.data.error.message;
  } catch {
    // Not JSON, or didn't match the documented error shape — fall through
    // to returning the raw text below so the error still carries something
    // useful.
  }
  return text.slice(0, 300);
}

function parseRetryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds * 1000;
}

// Takes the signal so the pending setTimeout can be cleared on abort. In the
// chat path (skillRouting.ts) an abort mid-backoff is the NORMAL case, not
// an edge case: its 1.5s budget aborts during the 500ms/1000ms backoff on
// almost every rate-limited turn. Without clearTimeout here, abortableSleep
// below still rejects promptly (it races the signal independently), but the
// underlying timer stays pending and ref'd for up to MAX_RETRY_AFTER_MS —
// one leaked live timer per aborted retry under sustained rate limiting.
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Consuming or cancelling a response body before discarding it is required
// under undici: an unread body keeps the connection checked out of the pool
// until the Response is garbage-collected, not until it goes out of scope.
// On a retryable 429/529 we read only `response.headers` and loop, so
// without this a vendor that rate-limits repeatedly makes sockets
// accumulate across retries. Wrapped in try/catch because a throw here must
// never break the retry loop — losing one body is harmless, losing the
// retry isn't. Callers must not invoke this after already consuming the
// body (e.g. via extractDetailMessage's `.text()`) — cancelling a
// already-consumed body is a no-op in practice, but the oversized
// Retry-After branch below skips this call entirely to keep that
// consumed-once invariant explicit.
async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort — see comment above.
  }
}

// Races `sleepFn(ms)` against `signal` so a retry wait can never outlive the
// caller's budget (the combined per-request timeout/abort signal). Without
// this, a signal-unaware `await sleepFn(...)` would block for the full
// duration regardless of an outer abort — exactly the bug this guards
// against (a 429 with a long Retry-After consuming a 1.5s chat-path budget).
// Rejects with the signal's abort reason so the caller's existing fail-open
// try/catch handles it exactly like any other SystemOne failure.
function abortableSleep(
  ms: number,
  signal: AbortSignal,
  sleepFn: (ms: number, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error("aborted"));
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // This outer race stays even though defaultSleep now clears its own
    // timer on abort: sleepFn is injectable, and a test/caller-supplied
    // implementation that ignores `signal` (e.g. this file's own
    // "hanging" test fixture) must still be interruptible from the
    // caller's point of view.
    sleepFn(ms, signal).then(
      () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

export interface SystemOneClientOptions {
  apiKey: string;
  /** Default "jev-latest". An `openai/...` id routes to OpenRouter (see below). */
  model?: string;
  /** Default: the TypeSafe API URL. */
  baseUrl?: string;
  /** Used instead of `apiKey` when `model` is an OpenAI Decisions model. */
  openRouterApiKey?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const DEFAULT_SYSTEMONE_BASE_URL = "https://api.typesafe.ai/v1";
export const DEFAULT_SYSTEMONE_MODEL = "jev-latest";

export function createSystemOneClient(opts: SystemOneClientOptions): DecisionClient {
  if (!opts.apiKey) throw new Error("createSystemOneClient: apiKey is required");
  const fetchFn: typeof fetch = opts.fetch ?? fetch;
  const sleepFn: (ms: number, signal: AbortSignal) => Promise<void> = opts.sleep ?? defaultSleep;
  const decisionModel = opts.model ?? DEFAULT_SYSTEMONE_MODEL;
  const model = decisionModel;
  // OpenAI Decisions models are served by OpenRouter under the same
  // contract, so switching between Jev and Luna is `model` alone:
  // the TypeSafe key and base URL stay in place for the way back.
  const viaOpenRouter = isOpenAIDecisions(decisionModel);
  const apiKey = viaOpenRouter ? opts.openRouterApiKey : opts.apiKey;
  const url = `${viaOpenRouter ? OPENROUTER_DECISIONS_BASE_URL : (opts.baseUrl ?? DEFAULT_SYSTEMONE_BASE_URL)}/systemone`;

  return {
    async evaluate<Q extends Record<string, SystemOneQuestion>>({
      state,
      questions,
      signal,
    }: SystemOneEvaluateParams<Q>): Promise<SystemOneResult<Q>> {
      const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const combinedSignal = signal
        ? AbortSignal.any([timeoutSignal, signal])
        : timeoutSignal;

      // OpenAI Decisions compatibility: a choice with a single option is
      // answered locally (only OpenAI Decisions models 400 on < 2 choices;
      // Jev still receives it as before). A question the vendor refuses (its
      // exact 502 refusal error) is dropped — never answered with a made-up
      // value — and the rest resent, up to MAX_ROUNDS rounds in total.
      const localSingleOption = viaOpenRouter;
      const answers: Record<string, SystemOneAnswer> = {};
      let pending: Record<string, SystemOneQuestion> = {};
      for (const [id, q] of Object.entries(questions)) {
        const opts = q.type === "choice" ? Object.keys(q.criteria) : [];
        if (localSingleOption && q.type === "choice" && opts.length === 1) {
          answers[id] = {
            type: "choice",
            choice: opts[0]!,
            probabilities: { [opts[0]!]: 1 },
            confidence: 1,
          };
        } else {
          pending = { ...pending, [id]: q };
        }
      }

      let model = decisionModel;
      const usage = { input_tokens: 0, output_tokens: 0 };
      const refused: string[] = [];
      for (let round = 0; round < MAX_ROUNDS && Object.keys(pending).length > 0; round++) {
        try {
          const result = await sendQuestions(state, pending, combinedSignal);
          model = result.model;
          usage.input_tokens += result.usage.input_tokens;
          usage.output_tokens += result.usage.output_tokens;
          Object.assign(answers, result.answers);
          pending = {};
        } catch (err) {
          const id = err instanceof SystemOneRefusalError ? err.questionId : undefined;
          if (id === undefined || !(id in pending)) throw err;
          refused.push(id);
          const { [id]: _dropped, ...rest } = pending;
          pending = rest;
        }
      }
      // Still pending after the last round (every round ended in a refusal):
      // report them as refused too, so callers take their retry path instead
      // of the questions vanishing silently.
      refused.push(...Object.keys(pending));
      return { model, answers: answers as Partial<Record<keyof Q, SystemOneAnswer>>, refused, usage };
    },
  };

  async function sendQuestions(
    state: SystemOneEvaluateParams<Record<string, SystemOneQuestion>>["state"],
    questions: Record<string, SystemOneQuestion>,
    combinedSignal: AbortSignal,
  ): Promise<{ model: string; answers: Record<string, SystemOneAnswer>; usage: { input_tokens: number; output_tokens: number } }> {
      let lastError: SystemOneError | undefined;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const response = await fetchFn(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ state, model, questions }),
          signal: combinedSignal,
        });

        if (response.ok) {
          // A 200 with a truncated body, or an HTML error page served with
          // status 200 by a misconfigured proxy/CDN in front of the
          // vendor, makes `.json()` throw a raw SyntaxError here — without
          // this wrapper that escapes the SystemOneError hierarchy every
          // caller (and skillRouting.ts's fail-open catch) is written
          // against.
          let json: unknown;
          try {
            json = await response.json();
          } catch (err) {
            throw new SystemOneValidationError(
              `System One returned a non-JSON response: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
          const parsed = responseSchema.safeParse(json);
          if (!parsed.success) {
            throw new SystemOneValidationError(
              `System One returned a malformed response: ${parsed.error.message}`,
            );
          }
          for (const id of Object.keys(questions)) {
            if (!(id in parsed.data.answers)) {
              throw new SystemOneValidationError(
                `System One response is missing an answer for question "${id}".`,
              );
            }
          }
          return {
            model: parsed.data.model,
            answers: parsed.data.answers,
            usage: parsed.data.usage,
          };
        }

        const retryable = response.status === 429 || response.status === 529;
        if (retryable && attempt < MAX_RETRIES) {
          const retryAfterMs = parseRetryAfterMs(response);
          if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_AFTER_MS) {
            // Give up rather than sleeping through an oversized Retry-After —
            // see MAX_RETRY_AFTER_MS's comment. Falls through to the same
            // error mapping below instead of retrying.
            const detailMessage = await extractDetailMessage(response);
            const suffix = detailMessage ? `: ${detailMessage}` : "";
            throw new SystemOneRateLimitError(
              `System One requested a Retry-After of ${retryAfterMs}ms, exceeding the ` +
                `${MAX_RETRY_AFTER_MS}ms cap; giving up rather than blocking the request${suffix}`,
            );
          }
          // Discard the body before retrying — see discardResponseBody's
          // comment. The oversized-Retry-After branch above already
          // consumed it via extractDetailMessage's `.text()`, so it
          // deliberately skips this call rather than reading twice.
          await discardResponseBody(response);
          const backoffMs = RETRY_BASE_DELAY_MS * 2 ** attempt;
          await abortableSleep(retryAfterMs ?? backoffMs, combinedSignal, sleepFn);
          continue;
        }

        const bodyText = await readBodyText(response);
        const detailMessage = detailFromText(bodyText);
        const suffix = detailMessage ? `: ${detailMessage}` : "";
        const refusedId = parseRefusedQuestionId(response.status, bodyText);
        if (refusedId !== undefined) {
          throw new SystemOneRefusalError(`System One returned 502${suffix}`, refusedId);
        }
        if (response.status === 401) {
          throw new SystemOneAuthError(
            `System One authentication failed${suffix}`,
          );
        }
        if (response.status === 422) {
          throw new SystemOneValidationError(
            `System One rejected the request${suffix}`,
          );
        }
        if (response.status === 429) {
          lastError = new SystemOneRateLimitError(
            `System One rate limit exceeded after ${MAX_RETRIES} retries${suffix}`,
          );
          throw lastError;
        }
        throw new SystemOneUpstreamError(
          `System One returned ${response.status}${suffix}`,
        );
      }

      // Unreachable — the loop above always returns or throws — but kept
      // for exhaustiveness so this function's control flow type-checks.
      throw (
        lastError ??
        new SystemOneUpstreamError("System One request failed for an unknown reason.")
      );
  }
}
