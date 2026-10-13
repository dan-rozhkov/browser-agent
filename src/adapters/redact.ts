// The Steel CDP URL carries the account API key (`?apiKey=…`), and Playwright
// echoes that URL into connectOverCDP error messages — which routes log. Every
// error crossing the connect boundary goes through here first.

/** Extracts the apiKey query value from a CDP URL, if any. */
function apiKeyOf(cdpUrl: string): string | null {
  try {
    return new URL(cdpUrl).searchParams.get("apiKey");
  } catch {
    return null;
  }
}

export function redactApiKey(text: string, cdpUrl: string): string {
  let out = text;
  const key = apiKeyOf(cdpUrl);
  if (key) {
    for (const variant of new Set([key, encodeURIComponent(key)])) out = out.split(variant).join("***");
  }
  return out.replace(/apiKey=[^&\s"']+/gi, "apiKey=***");
}

/** A fresh Error with message/stack redacted; the original is deliberately NOT kept as `cause`. */
export function redactedError(e: unknown, cdpUrl: string): Error {
  const src = e instanceof Error ? e : new Error(String(e));
  const out = new Error(redactApiKey(src.message, cdpUrl));
  out.name = src.name;
  if (src.stack) out.stack = redactApiKey(src.stack, cdpUrl);
  return out;
}
