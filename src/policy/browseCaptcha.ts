import type { BrowseStepInput, BrowseStepResult } from "./browseStep.js";

// Deterministic CAPTCHA / bot-wall guard for browse_task. Production
// finding: Google serves cloud-browser IPs a /sorry/ reCAPTCHA about 1 run in
// 3, and the loop used to CLICK "I'm not a robot" itself. Touching a CAPTCHA
// is never acceptable, so this runs BEFORE any policy call. It lives in its
// own module and is applied at the route's `decide` (routes/browseStep.ts) so
// both the ultrafast and the legacy policy are covered by one call site and
// no Jev/LLM call is spent on a page we will refuse anyway.
//
// Rules. One STRONG signal is enough; WEAK signals need two distinct ones.
//  strong: URL host google.<tld> with path /sorry/…; URL path segment
//          /cdn-cgi/challenge-platform;
//          an interactive element labelled "I'm not a robot" / "I am not a
//          robot" / "Verify you are human" — but ONLY on a wall-like page
//          (<= WALL_MAX_ELEMENTS non-frame elements). Ordinary contact/signup
//          forms embed the reCAPTCHA v2 checkbox; on a bigger page the same
//          control is a weak signal that shares the "captcha-widget" name
//          with the widget signal, so the embedded checkbox alone never
//          reaches two distinct weak signals;
//          page text "unusual traffic from your computer network" or
//          "our systems have detected unusual traffic".
//  weak:   an element labelled "Press and hold" (voice-record buttons);
//          URL path segment `captcha`/`recaptcha`/`hcaptcha` (weak because
//          an article URL like /wiki/CAPTCHA is legitimate); page text "verify you are human", "complete the security check",
//          "are you a robot", "checking your browser before accessing";
//          title "Just a moment..." / "Attention Required! | Cloudflare";
//          an element label or frame mentioning recaptcha/hcaptcha/turnstile.
// A page that merely mentions the word "captcha" matches none of these.

type BotWallInput = Pick<BrowseStepInput, "url" | "title" | "elements" | "pageText">;

const HUMAN_CHECK_ELEMENT =
  /\bi\s*(?:'|’)?\s*(?:am|m)\s+not\s+a\s+(?:robot|bot)\b|\bverify\s+(?:that\s+)?you(?:\s+are|'re|’re)\s+(?:a\s+)?human\b/i;
const PRESS_HOLD_ELEMENT = /\bpress\s*(?:&|and)\s*hold\b/i;
/** A bot wall is nearly empty; a real page has many controls. Frame elements
 * (the widget's own iframe contents) are not counted. */
const WALL_MAX_ELEMENTS = 15;
const STRONG_TEXT =
  /unusual traffic from your computer network|our systems have detected unusual traffic/i;
const WEAK_TEXT: Array<[string, RegExp]> = [
  ["verify-human-text", /verify\s+(?:that\s+)?you(?:\s+are|'re|’re)\s+(?:a\s+)?human/i],
  ["security-check-text", /complete the security check/i],
  ["are-you-a-robot-text", /are you a (?:robot|bot)\b/i],
  ["browser-check-text", /checking your browser before accessing/i],
];
const WEAK_TITLE = /^\s*(?:just a moment\.{0,3}|attention required!.*cloudflare)\s*$/i;
const WEAK_WIDGET = /\b(?:re|h)captcha\b|\bturnstile\b/i;

const CAPTCHA_SEGMENT = new Set(["captcha", "recaptcha", "hcaptcha"]);

function hasCaptchaSegment(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).pathname.toLowerCase().split("/").some((s) => CAPTCHA_SEGMENT.has(s));
  } catch {
    return false;
  }
}

function urlSignal(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const path = u.pathname.toLowerCase();
  if (/(^|\.)google\.[a-z.]+$/i.test(u.hostname) && path.startsWith("/sorry/")) {
    return "google /sorry/ page";
  }
  if (path.startsWith("/cdn-cgi/challenge-platform")) return "cloudflare challenge URL";
  return null;
}

/** Returns null for a normal page, else a short reason naming the signal. */
export function detectBotWall(input: BotWallInput): string | null {
  const strongUrl = urlSignal(input.url);
  if (strongUrl) return strongUrl;

  // Reasons use fixed signal names only — the route logs them, and raw page
  // text must never reach the log.
  const isWall = input.elements.filter((el) => !el.frame).length <= WALL_MAX_ELEMENTS;
  const weak = new Set<string>();
  for (const el of input.elements) {
    if (HUMAN_CHECK_ELEMENT.test(el.label)) {
      if (isWall) return `"I'm not a robot" control`;
      weak.add("captcha-widget");
    }
    if (PRESS_HOLD_ELEMENT.test(el.label)) weak.add("press-and-hold-control");
  }
  const text = input.pageText ?? "";
  if (STRONG_TEXT.test(text)) return "unusual-traffic text";

  for (const [name, re] of WEAK_TEXT) if (re.test(text)) weak.add(name);
  if (hasCaptchaSegment(input.url)) weak.add("captcha-url");
  if (WEAK_TITLE.test(input.title)) weak.add("challenge-title");
  if (input.elements.some((el) => WEAK_WIDGET.test(el.label) || WEAK_WIDGET.test(el.frame ?? ""))) {
    weak.add("captcha-widget");
  }
  if (weak.size >= 2) return [...weak].join(" + ");
  return null;
}

/** The terminal `blocked` result for a bot wall (same shape as the policies'
 * own blocked results; no model was called, so model is empty). */
export function botWallResult(reason: string): BrowseStepResult {
  return {
    outcome: "blocked",
    operation: "BLOCKED",
    confidence: 1,
    model: "",
    reason: `the page is a CAPTCHA / bot check (${reason}) — the user must solve it themselves; browse_task never interacts with CAPTCHAs`,
  };
}
