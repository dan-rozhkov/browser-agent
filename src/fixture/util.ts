// Shared helpers of apply and capture: a bounded page-script call and URL
// redaction. A URL may carry a token in its query or hash, so no text a model
// can read ever holds more than origin + pathname.
import type { BrowserPageHandle } from "../controller/controller.js";

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

/** Replaces every http(s) URL inside `text` with its origin + pathname. */
export function redactUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>`]+/gi, (match) => redactUrl(match));
}

/**
 * Runs a script that returns `JSON.stringify(value)` and parses the answer
 * (a string survives every target's transport). Rejects after `timeoutMs`, so
 * a hung page can never hold the caller (and the controller lock) forever.
 */
export async function runScript(page: BrowserPageHandle, code: string, timeoutMs = SCRIPT_TIMEOUT_MS): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the page script timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    const raw = await Promise.race([Promise.resolve().then(() => page.executeJavaScript(code)), timeout]);
    const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } finally {
    clearTimeout(timer);
  }
}
