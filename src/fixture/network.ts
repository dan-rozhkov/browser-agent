// Network mock rules of a PageFixture: the URL matcher, rule choice with
// `times` counting, and the response a target sends. Isomorphic and zod-free.
// Docs: docs/specs/2026-10-15-qa-start-design.md (part 2).
import type { FixtureMockHit, FixtureMockResponse, FixtureNetworkRule, FixtureRequestInfo } from "./types.js";

const SCHEME_AND_HOST = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#*]*)([\s\S]*)$/;

/**
 * Scheme and host are case-insensitive, so the scheme is lowercased, and the host
 * too when no `*` touches it, and a bare origin ("https://a.test") means origin + "/"
 * (a browser URL always has a path). The rest of the pattern is literal: no
 * percent-encoding is normalized, a pattern matches the URL as the browser
 * sends it (encoded).
 */
export function normalizePattern(pattern: string): string {
  const m = SCHEME_AND_HOST.exec(pattern);
  if (!m) return pattern;
  if (m[3].startsWith("*")) return `${m[1].toLowerCase()}://${m[2]}${m[3]}`;
  const rest = m[3] === "" ? "/" : m[3];
  return `${m[1].toLowerCase()}://${m[2].toLowerCase()}${rest}`;
}

/**
 * True when the whole `url` matches `pattern`. `*` is any run of characters
 * (also none); everything else is literal. Linear glob matching, no regular
 * expression: a pattern from a fixture cannot make it backtrack.
 */
export function matchUrlPattern(rawPattern: string, url: string): boolean {
  const pattern = normalizePattern(rawPattern);
  const parts = pattern.split("*");
  if (parts.length === 1) return url === pattern;
  const first = parts[0];
  const last = parts[parts.length - 1];
  const end = url.length - last.length;
  if (!url.startsWith(first) || end < first.length || !url.endsWith(last)) return false;
  // Leftmost placement of each inner part leaves the most room for the next ones.
  let pos = first.length;
  for (const part of parts.slice(1, -1)) {
    if (part === "") continue;
    const at = url.indexOf(part, pos);
    if (at < 0 || at + part.length > end) return false;
    pos = at + part.length;
  }
  return true;
}

/**
 * Index of the first rule (fixture order) that matches `req` and still has uses
 * left, or -1. `used[i]` counts how often rule i answered. This function does
 * not change `used`; the caller does when it takes the rule.
 */
export function pickNetworkRule(rules: readonly FixtureNetworkRule[], used: readonly number[], req: FixtureRequestInfo): number {
  const method = req.method.toUpperCase();
  for (const [i, rule] of rules.entries()) {
    if (rule.times !== undefined && (used[i] ?? 0) >= rule.times) continue;
    if (rule.method !== undefined && rule.method.toUpperCase() !== method) continue;
    if (matchUrlPattern(rule.url, req.url)) return i;
  }
  return -1;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

/** The response a rule describes. */
export function buildMockResponse(rule: FixtureNetworkRule): FixtureMockResponse {
  const delay = rule.delayMs !== undefined ? { delayMs: rule.delayMs } : {};
  if (rule.abort) return { status: 0, headers: {}, body: "", abort: true, ...delay };
  const headers = { ...rule.headers };
  let body = "";
  if (typeof rule.body === "string") body = rule.body;
  else if (rule.body !== undefined) {
    body = JSON.stringify(rule.body);
    if (!hasHeader(headers, "content-type")) headers["content-type"] = "application/json";
  }
  return { status: rule.status ?? 200, headers, body, ...delay };
}

/** A `routeRequests` handler that also reports how often each rule answered. */
export type NetworkHandler = ((req: FixtureRequestInfo) => FixtureMockResponse | undefined) & {
  /** Hit count per rule, in fixture order. Readable at any time, also after the mocks were removed. */
  hits(): FixtureMockHit[];
};

/** A `routeRequests` handler for `rules`: counts uses, so a rule with `times` stops after N answers. */
export function createNetworkHandler(rules: readonly FixtureNetworkRule[]): NetworkHandler {
  const used = rules.map(() => 0);
  const handler = (req: FixtureRequestInfo): FixtureMockResponse | undefined => {
    const i = pickNetworkRule(rules, used, req);
    if (i < 0) return undefined;
    used[i] += 1;
    return buildMockResponse(rules[i]);
  };
  return Object.assign(handler, {
    hits: (): FixtureMockHit[] => rules.map((rule, i) => ({ ...(rule.method !== undefined ? { method: rule.method } : {}), url: rule.url, hits: used[i] ?? 0 })),
  });
}
