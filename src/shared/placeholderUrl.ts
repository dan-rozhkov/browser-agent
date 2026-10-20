// Neutral and dependency-free: the controller (app-mode close guard) and the Playwright adapter share one rule.

/**
 * True for the URL of an empty service window: no URL, any `about:` URL (`about:blank`, `about:blank#x`, `about:srcdoc`)
 * or a `data:` URL (case-insensitive). `chrome-error://` is NOT a placeholder: an error page is content the agent must see.
 * Electron apps often keep such windows beside the real one.
 */
export function isPlaceholderPageUrl(url: string | null | undefined): boolean {
  const u = (url ?? "").trim().toLowerCase();
  return u === "" || u.startsWith("about:") || u.startsWith("data:");
}
