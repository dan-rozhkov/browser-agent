// The one URL redaction of the package. A URL may carry a token in its query or hash, so no text a model or a judge
// can read ever holds more than origin + pathname. Isomorphic, no imports.

/** `origin + pathname` of a URL ("[url]" when it does not parse). */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // A non-special scheme (macos-app://bundle/pid of a desktop app) has the origin "null": keep scheme + host instead.
    const origin = parsed.origin === "null" ? `${parsed.protocol}//${parsed.host}` : parsed.origin;
    return `${origin}${parsed.pathname}`;
  } catch {
    return "[url]";
  }
}
