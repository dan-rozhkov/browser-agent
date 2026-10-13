// Ported from pen-editor-desktop/src/main/navigation.ts (decideBrowserNavigation only).
/**
 * Pure policy for browser tabs (design doc `2026-09-18-builtin-browser-design.md`
 * §1): any http(s) navigation is allowed in place — a browser tab is a real
 * browser, so there is no origin clamp — and anything else (file:, custom
 * schemes, javascript:, garbage) is denied.
 */
export function decideBrowserNavigation(targetUrl: string): "allow" | "deny" {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return "deny";
  }
  return url.protocol === "http:" || url.protocol === "https:" ? "allow" : "deny";
}
