// Hand-written validation of a PageFixture (no zod, so a browser bundle stays
// light). An error names the field path only: it never repeats a cookie value,
// a storage key or a storage value, because the caller may show it to a model.
import {
  FIXTURE_MAX_WAIT_MS,
  type FixtureCookie,
  type FixtureExpect,
  type FixtureNetworkRule,
  type FixtureOrigin,
  type FixtureStep,
  type PageFixture,
  type ParsePageFixtureResult,
} from "./types.js";

class FixtureParseError extends Error {}

function fail(path: string, problem: string): never {
  throw new FixtureParseError(`${path} ${problem}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(path, "must be an object");
  return value;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  return value;
}

function string(value: unknown, path: string, opts: { allowEmpty?: boolean } = {}): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (!opts.allowEmpty && value.trim() === "") fail(path, "must not be empty");
  return value;
}

function httpUrl(value: unknown, path: string): string {
  const text = string(value, path);
  let protocol: string;
  try {
    protocol = new URL(text).protocol;
  } catch {
    return fail(path, "must be an absolute URL");
  }
  if (protocol !== "http:" && protocol !== "https:") fail(path, "must be an http(s) URL");
  return text;
}

/** A bare origin: http(s), no path (a lone "/" is fine), no query, no hash. Returns `URL.origin`. */
function originUrl(value: unknown, path: string): string {
  const text = httpUrl(value, path);
  const parsed = new URL(text);
  if ((parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search !== "" || parsed.hash !== "") {
    fail(path, "must be an origin only (scheme and host, with no path, query or hash)");
  }
  return parsed.origin;
}

function optional<T>(obj: Record<string, unknown>, key: string, read: (value: unknown) => T): T | undefined {
  return obj[key] === undefined ? undefined : read(obj[key]);
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be a finite number");
  return value;
}

function waitMs(value: unknown, path: string): number {
  const n = finiteNumber(value, path);
  if (n < 0 || n > FIXTURE_MAX_WAIT_MS) fail(path, `must be between 0 and ${FIXTURE_MAX_WAIT_MS}`);
  return n;
}

function stringMap(value: unknown, path: string): Record<string, string> {
  const obj = record(value, path);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(obj)) {
    // The key is data (it may be a secret): the path never includes it.
    if (typeof entry !== "string") fail(path, "must map strings to strings");
    out[key] = entry;
  }
  return out;
}

const SAME_SITE = ["Strict", "Lax", "None"] as const;

function cookie(value: unknown, path: string): FixtureCookie {
  const obj = record(value, path);
  const out: FixtureCookie = {
    name: string(obj.name, `${path}.name`),
    value: string(obj.value, `${path}.value`, { allowEmpty: true }),
  };
  const domain = optional(obj, "domain", (v) => string(v, `${path}.domain`));
  const url = optional(obj, "url", (v) => httpUrl(v, `${path}.url`));
  if (domain === undefined && url === undefined) fail(path, "needs url or domain");
  if (domain !== undefined) out.domain = domain;
  const cookiePath = optional(obj, "path", (v) => string(v, `${path}.path`));
  if (cookiePath !== undefined) out.path = cookiePath;
  if (url !== undefined) out.url = url;
  const expires = optional(obj, "expires", (v) => finiteNumber(v, `${path}.expires`));
  if (expires !== undefined) out.expires = expires;
  const httpOnly = optional(obj, "httpOnly", (v) => boolean(v, `${path}.httpOnly`));
  if (httpOnly !== undefined) out.httpOnly = httpOnly;
  const secure = optional(obj, "secure", (v) => boolean(v, `${path}.secure`));
  if (secure !== undefined) out.secure = secure;
  const sameSite = optional(obj, "sameSite", (v) => v);
  if (sameSite !== undefined) {
    if (!SAME_SITE.includes(sameSite as (typeof SAME_SITE)[number])) fail(`${path}.sameSite`, `must be one of ${SAME_SITE.join(", ")}`);
    out.sameSite = sameSite as FixtureCookie["sameSite"];
  }
  return out;
}

function origin(value: unknown, path: string): FixtureOrigin {
  const obj = record(value, path);
  const out: FixtureOrigin = { origin: originUrl(obj.origin, `${path}.origin`) };
  const local = optional(obj, "localStorage", (v) => stringMap(v, `${path}.localStorage`));
  if (local !== undefined) out.localStorage = local;
  const session = optional(obj, "sessionStorage", (v) => stringMap(v, `${path}.sessionStorage`));
  if (session !== undefined) out.sessionStorage = session;
  return out;
}

function step(value: unknown, path: string): FixtureStep {
  const obj = record(value, path);
  const action = obj.action;
  switch (action) {
    case "goto":
      return { action, url: httpUrl(obj.url, `${path}.url`) };
    case "click":
      return { action, selector: string(obj.selector, `${path}.selector`) };
    case "type":
      return {
        action,
        selector: string(obj.selector, `${path}.selector`),
        text: string(obj.text, `${path}.text`, { allowEmpty: true }),
      };
    case "select":
      return { action, selector: string(obj.selector, `${path}.selector`), value: string(obj.value, `${path}.value`, { allowEmpty: true }) };
    case "press": {
      const selector = optional(obj, "selector", (v) => string(v, `${path}.selector`));
      const key = string(obj.key, `${path}.key`, { allowEmpty: true });
      // A key may be a lone space (Space); only the empty string is refused.
      if (key.length === 0) fail(`${path}.key`, "must not be empty");
      return { action, key, ...(selector !== undefined ? { selector } : {}) };
    }
    case "waitFor": {
      const timeoutMs = optional(obj, "timeoutMs", (v) => waitMs(v, `${path}.timeoutMs`));
      return { action, selector: string(obj.selector, `${path}.selector`), ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
    }
    case "wait":
      return { action, ms: waitMs(obj.ms, `${path}.ms`) };
    default:
      return fail(`${path}.action`, "must be one of goto, click, type, select, press, waitFor, wait");
  }
}

function integer(value: unknown, path: string, min: number, max: number): number {
  const n = finiteNumber(value, path);
  if (!Number.isInteger(n) || n < min || n > max) fail(path, `must be an integer between ${min} and ${max}`);
  return n;
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Header names are HTTP tokens, values hold no CR or LF. An error names the header's index, never its name or value. */
function headerMap(value: unknown, path: string): Record<string, string> {
  const map = stringMap(value, path);
  for (const [i, [name, entry]] of Object.entries(map).entries()) {
    if (!HEADER_NAME.test(name)) fail(`${path}[${i}]`, "has an invalid header name");
    if (/[\r\n]/.test(entry)) fail(`${path}[${i}]`, "has a header value with a line break");
  }
  return map;
}

function jsonBody(value: unknown, path: string): string | object {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) fail(path, "must be a string or an object");
  try {
    JSON.stringify(value);
  } catch {
    return fail(path, "must be JSON-serializable");
  }
  return value;
}

function networkRule(value: unknown, path: string): FixtureNetworkRule {
  const obj = record(value, path);
  const out: FixtureNetworkRule = { url: string(obj.url, `${path}.url`) };
  const method = optional(obj, "method", (v) => string(v, `${path}.method`));
  if (method !== undefined) out.method = method;
  const status = optional(obj, "status", (v) => integer(v, `${path}.status`, 200, 599));
  if (status !== undefined) out.status = status;
  const headers = optional(obj, "headers", (v) => headerMap(v, `${path}.headers`));
  if (headers !== undefined) out.headers = headers;
  const body = optional(obj, "body", (v) => jsonBody(v, `${path}.body`));
  if (body !== undefined) out.body = body;
  const delayMs = optional(obj, "delayMs", (v) => waitMs(v, `${path}.delayMs`));
  if (delayMs !== undefined) out.delayMs = delayMs;
  const abort = optional(obj, "abort", (v) => boolean(v, `${path}.abort`));
  if (abort !== undefined) out.abort = abort;
  const times = optional(obj, "times", (v) => integer(v, `${path}.times`, 1, Number.MAX_SAFE_INTEGER));
  if (times !== undefined) out.times = times;
  return out;
}

function expectation(value: unknown, path: string): FixtureExpect {
  const obj = record(value, path);
  const out: FixtureExpect = {};
  const selector = optional(obj, "selector", (v) => string(v, `${path}.selector`));
  if (selector !== undefined) out.selector = selector;
  const text = optional(obj, "text", (v) => string(v, `${path}.text`));
  if (text !== undefined) out.text = text;
  const url = optional(obj, "url", (v) => string(v, `${path}.url`));
  if (url !== undefined) out.url = url;
  if (out.selector === undefined && out.text === undefined && out.url === undefined) fail(path, "needs selector, text or url");
  const timeoutMs = optional(obj, "timeoutMs", (v) => waitMs(v, `${path}.timeoutMs`));
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;
  return out;
}

function parseOrThrow(input: unknown): PageFixture {
  const obj = record(input, "fixture");
  if (obj.version !== 1) fail("fixture.version", "must be 1");
  const out: PageFixture = { version: 1 };
  const url = optional(obj, "url", (v) => httpUrl(v, "fixture.url"));
  if (url !== undefined) out.url = url;
  const tabs = optional(obj, "tabs", (v) => array(v, "fixture.tabs").map((t, i) => httpUrl(t, `fixture.tabs[${i}]`)));
  if (tabs !== undefined) out.tabs = tabs;
  const storage = optional(obj, "storage", (v) => record(v, "fixture.storage"));
  if (storage !== undefined) {
    const cookies = optional(storage, "cookies", (v) => array(v, "fixture.storage.cookies").map((c, i) => cookie(c, `fixture.storage.cookies[${i}]`)));
    const origins = optional(storage, "origins", (v) => array(v, "fixture.storage.origins").map((o, i) => origin(o, `fixture.storage.origins[${i}]`)));
    out.storage = { ...(cookies !== undefined ? { cookies } : {}), ...(origins !== undefined ? { origins } : {}) };
  }
  const steps = optional(obj, "steps", (v) => array(v, "fixture.steps").map((s, i) => step(s, `fixture.steps[${i}]`)));
  if (steps !== undefined) out.steps = steps;
  const network = optional(obj, "network", (v) => array(v, "fixture.network").map((r, i) => networkRule(r, `fixture.network[${i}]`)));
  if (network !== undefined) out.network = network;
  const expect = optional(obj, "expect", (v) => expectation(v, "fixture.expect"));
  if (expect !== undefined) out.expect = expect;
  const fresh = optional(obj, "fresh", (v) => boolean(v, "fixture.fresh"));
  if (fresh !== undefined) out.fresh = fresh;
  return out;
}

/**
 * Validate untrusted input (parsed JSON) as a `PageFixture`. The value is a
 * clean copy: unknown fields are dropped. The error text names a field path
 * and never holds a cookie value, a storage key or a storage value.
 */
export function parsePageFixture(input: unknown): ParsePageFixtureResult {
  try {
    return { ok: true, value: parseOrThrow(input) };
  } catch (err) {
    if (err instanceof FixtureParseError) return { ok: false, error: err.message };
    throw err;
  }
}
