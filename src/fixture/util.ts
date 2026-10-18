// Shared helpers of apply and capture: a bounded page-script call and URL
// redaction. A URL may carry a token in its query or hash, so no text a model
// can read ever holds more than origin + pathname.
import type { BrowserPageHandle } from "../controller/controller.js";
import { summarizeEmulation } from "./emulate.js";
import type { FixtureEmulate } from "./types.js";

/** Longest wait for one page script of a fixture. */
export const SCRIPT_TIMEOUT_MS = 10_000;

export function toMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

/** `origin + pathname` of a URL ("[url]" when it does not parse). */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[url]";
  }
}

/** `URL.origin` of an http(s) URL; undefined for anything else (about:blank, data:, a non-URL). */
export function httpOrigin(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Replaces every http(s) URL inside `text` with its origin + pathname. */
export function redactUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>`]+/gi, (match) => redactUrl(match));
}

/**
 * The ONE race of a call against a timer (isomorphic; used by the controller,
 * the fixture code and the agent layer). Runs `call` now. Resolves
 * `{ done: true, value }` when it settles first (a rejection rejects) and
 * `{ done: false }` when `ms` pass first. The timer is always cleared. The
 * losing `call` promise stays handled, so a late rejection never becomes an
 * unhandled one, and a late answer is dropped.
 */
export async function boundedCall<T>(call: () => Promise<T> | T, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<T>((resolve) => resolve(call())).then((value) => ({ done: true as const, value })),
      new Promise<{ done: false }>((resolve) => { timer = setTimeout(() => resolve({ done: false }), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** `boundedCall` for a caller that wants a rejection: `message` after `ms`. A non-`Error` rejection becomes an `Error`. */
export async function withTimeout<T>(call: Promise<T> | (() => Promise<T> | T), ms: number, message: string): Promise<T> {
  let outcome: Awaited<ReturnType<typeof boundedCall<T>>>;
  try {
    outcome = await boundedCall(typeof call === "function" ? call : () => call, ms);
  } catch (err) {
    throw err instanceof Error ? err : new Error(toMessage(err));
  }
  if (!outcome.done) throw new Error(message);
  return outcome.value;
}

/**
 * Runs a script that returns `JSON.stringify(value)` and parses the answer
 * (a string survives every target's transport). Rejects after `timeoutMs`, so
 * a hung page can never hold the caller (and the controller lock) forever.
 */
export async function runScript(page: BrowserPageHandle, code: string, timeoutMs = SCRIPT_TIMEOUT_MS): Promise<Record<string, unknown>> {
  const raw = await withTimeout(() => page.executeJavaScript(code), timeoutMs, `the page script timed out after ${timeoutMs}ms`);
  const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * The state part of a fixture summary: start page, cookie count, storage origin
 * count, extra tab count. Counts and origin + pathname only: no cookie name, no
 * storage key, no value. Shared by the apply summary and the checkpoint summary.
 */
export function fixtureStateParts(fixture: { url?: string; storage?: { cookies?: unknown[]; origins?: unknown[] }; tabs?: unknown[]; emulate?: FixtureEmulate }): string[] {
  const parts: string[] = [];
  if (fixture.url) parts.push(`start page ${redactUrl(fixture.url)}`);
  const cookies = fixture.storage?.cookies?.length ?? 0;
  if (cookies) parts.push(plural(cookies, "cookie"));
  const origins = fixture.storage?.origins?.length ?? 0;
  if (origins) parts.push(`storage for ${plural(origins, "origin")}`);
  const tabs = fixture.tabs?.length ?? 0;
  if (tabs) parts.push(plural(tabs, "extra tab"));
  if (fixture.emulate) parts.push(summarizeEmulation(fixture.emulate));
  return parts;
}
