// Secret placeholders: the model types a password without seeing it. The host
// keeps `{ name: value }`; the model writes `{{secret:<name>}}` in the `text` of
// a `browse_act` `type` action. The executor substitutes the value right before
// the bridge call and redacts every value out of what it returns to the model.
// Zod-free and isomorphic (no node:* imports).

/** A legal secret name. Hosts should validate names they accept with it. */
export const SECRET_NAME_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * Values shorter than this are never redacted: replacing a 1-3 character value
 * everywhere would mangle unrelated text ("a", "12"). Hosts should refuse such
 * values; the executor refuses to substitute one.
 */
export const MIN_REDACTED_SECRET_LENGTH = 4;

/**
 * A value longer than this is also redacted by any prefix of at least this length: page scripts cut
 * values and labels, but only at 40 chars or more (`slice` 40, 50, 80, 100, 200). Shorter prefixes are
 * not matched: a prefix of "Password123!" would mangle the label "Password".
 */
const MIN_REDACTED_PREFIX_LENGTH = 40;
/** Longest prefix chain built into one pattern (nested groups); the full value is matched on its own. */
const MAX_PREFIX_CHAIN = 256;
/** Base64 screenshots are never touched. */
const DATA_IMAGE_RE = /^data:image\/[a-z0-9.+-]+;base64,/i;

/** Matches one `{{secret:<name>}}` (the name in group 1). Not global: no `lastIndex` state. */
export const SECRET_PLACEHOLDER_PATTERN = /\{\{secret:([A-Za-z0-9_-]{1,40})\}\}/;
const PLACEHOLDER_GLOBAL = new RegExp(SECRET_PLACEHOLDER_PATTERN.source, "g");

export function hasSecretPlaceholder(text: string): boolean {
  return text.indexOf("{{secret:") !== -1 && SECRET_PLACEHOLDER_PATTERN.test(text);
}

/** True when any string anywhere in `input` (depth-bounded) holds a placeholder. */
export function inputHasSecretPlaceholder(input: unknown, depth = 0): boolean {
  if (typeof input === "string") return hasSecretPlaceholder(input);
  if (!input || typeof input !== "object" || depth >= 8) return false;
  const values = Array.isArray(input) ? input : Object.values(input as Record<string, unknown>);
  return values.some((v) => inputHasSecretPlaceholder(v, depth + 1));
}

export type ResolveSecretsResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * Replaces every placeholder in `text` with its value. An unknown name is an error, and so is a value that
 * `redactSecrets` could not hide (not a string, or shorter than `MIN_REDACTED_SECRET_LENGTH`). An error never holds a value.
 */
export function resolveSecretPlaceholders(text: string, secrets: Readonly<Record<string, string>>): ResolveSecretsResult {
  const known = Object.keys(secrets);
  for (const match of text.matchAll(PLACEHOLDER_GLOBAL)) {
    const name = match[1];
    if (!Object.prototype.hasOwnProperty.call(secrets, name)) {
      return {
        ok: false,
        error:
          known.length === 0
            ? "No secrets are set. Ask the user to add one."
            : `Unknown secret "${name}". Known secrets: ${known.join(", ")}.`,
      };
    }
    const value: unknown = secrets[name];
    if (typeof value !== "string" || value.length < MIN_REDACTED_SECRET_LENGTH) {
      return {
        ok: false,
        error: `Secret "${name}" cannot be used: its value must be a string of at least ${MIN_REDACTED_SECRET_LENGTH} characters.`,
      };
    }
  }
  return { ok: true, text: text.replace(PLACEHOLDER_GLOBAL, (_m, name: string) => secrets[name]) };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `v0..v39(?:v40(?:v41)?)?`: every prefix of `value` from `MIN_REDACTED_PREFIX_LENGTH` chars up (to the chain cap), greedy. */
function prefixPattern(value: string): string {
  const chars = Array.from(value).slice(0, MAX_PREFIX_CHAIN);
  let tail = "";
  for (let i = chars.length - 1; i >= MIN_REDACTED_PREFIX_LENGTH; i--) tail = `(?:${escapeRe(chars[i])}${tail})?`;
  return chars.slice(0, MIN_REDACTED_PREFIX_LENGTH).map(escapeRe).join("") + tail;
}

/** `application/x-www-form-urlencoded`: spaces as +, and the characters encodeURIComponent leaves alone encoded. */
function formEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, "+")
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface SecretRedactor {
  /** Redacts a plain string. */
  text(s: string): string;
  /** Redacts the string values AND keys of a JSON-like value (never `imageData` or base64 `data:image/` strings); returns a copy. */
  value<T>(v: T): T;
  /** A tool result string. Nothing to redact: the same string back. JSON: redacted structurally. Else: as plain text. */
  output(s: string): string;
}

const IDENTITY: SecretRedactor = { text: (s) => s, value: (v) => v, output: (s) => s };
const MAX_DEPTH = 64;
class TooDeep extends Error {}

/**
 * Builds the redactor for `secrets` once (the regex is the costly part). Forms redacted for each value of
 * `MIN_REDACTED_SECRET_LENGTH`+ chars: raw, JSON-escaped, `encodeURIComponent`, form-urlencoded; for a value longer
 * than 40 chars also every prefix of 40+ chars (case-sensitive). The alternation lists every exact form (longest
 * first) before any prefix pattern, so a prefix of one secret never cuts another one short.
 */
export function createSecretRedactor(secrets: Readonly<Record<string, string>>): SecretRedactor {
  const exact: { pattern: string; name: string; weight: number }[] = [];
  const prefixes: { pattern: string; name: string; weight: number }[] = [];
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(secrets)) {
    if (typeof value !== "string" || value.length < MIN_REDACTED_SECRET_LENGTH) continue;
    const escaped = JSON.stringify(value).slice(1, -1);
    for (const form of [value, escaped, encodeURIComponent(value), formEncode(value)]) {
      if (seen.has(form)) continue;
      seen.add(form);
      exact.push({ pattern: escapeRe(form), name, weight: form.length });
    }
    if (value.length > MIN_REDACTED_PREFIX_LENGTH) {
      prefixes.push({ pattern: prefixPattern(value), name, weight: value.length });
      if (escaped !== value && escaped.length > MIN_REDACTED_PREFIX_LENGTH) {
        prefixes.push({ pattern: prefixPattern(escaped), name, weight: escaped.length });
      }
    }
  }
  if (exact.length === 0) return IDENTITY;
  exact.sort((a, b) => b.weight - a.weight);
  prefixes.sort((a, b) => b.weight - a.weight);
  const alts = [...exact, ...prefixes];
  const source = alts.map((a) => `(${a.pattern})`).join("|");
  const re = new RegExp(source, "g");
  const probe = new RegExp(source);
  const text = (s: string): string =>
    s.replace(re, (...m: unknown[]) => {
      for (let i = 0; i < alts.length; i++) if (m[i + 1] !== undefined) return `{{secret:${alts[i].name}}}`;
      return m[0] as string;
    });
  const walk = (v: unknown, key: string | undefined, depth: number): unknown => {
    if (typeof v === "string") return key === "imageData" || DATA_IMAGE_RE.test(v) ? v : text(v);
    if (!v || typeof v !== "object") return v;
    if (depth >= MAX_DEPTH) throw new TooDeep();
    if (Array.isArray(v)) return v.map((x) => walk(x, key, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      // defineProperty: a plain assignment of "__proto__" would set the prototype instead of a key.
      Object.defineProperty(out, text(k), { value: walk(x, k, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return out;
  };
  return {
    text,
    value<T>(v: T): T {
      try {
        return walk(v, undefined, 0) as T;
      } catch (e) {
        if (!(e instanceof TooDeep)) throw e;
        // Never hand back a subtree raw: redact the serialized whole.
        return JSON.parse(text(JSON.stringify(v))) as T;
      }
    },
    output(s) {
      if (s.search(probe) === -1) return s;
      const head = s.trimStart()[0];
      if (head === "{" || head === "[" || head === '"') {
        try {
          return JSON.stringify(walk(JSON.parse(s), undefined, 0));
        } catch {
          // not JSON, or too deep: the whole string as text below
        }
      }
      return text(s);
    },
  };
}

/** Replaces every form of every secret value in `output` with `{{secret:<name>}}`; see `createSecretRedactor`. */
export function redactSecrets(output: string, secrets: Readonly<Record<string, string>>): string {
  return createSecretRedactor(secrets).output(output);
}
