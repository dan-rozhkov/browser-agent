// Regex PII scrubber — layer (a) of the three-layer defense described in the
// spec. Order matters: data URLs and URL credentials are matched before the
// generic email/token/blob rules would mangle them. All regexes use /g and are
// applied via String.replace (never .test, which is stateful for /g).
// `kind` names the bracket tag each rule leaves behind (minus the brackets)
// — shared by findPiiSpans below and browseStep.ts's candidatePiiKind (which
// derives the same names by scrubbing a candidate and reading which tag came
// back), so the two can never name a kind differently for the same rule.
const RULES: Array<{ re: RegExp; replacement: string; kind: string }> = [
  { re: /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{50,}/gi, replacement: "[DATA_URL]", kind: "data URL" },
  { re: /(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, replacement: "$1[CREDENTIALS]@", kind: "credentials" },
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replacement: "[EMAIL]", kind: "email" },
  // Canonical fixed-format keys shorter than the 64-char BLOB threshold:
  // AWS access key IDs, Google API keys, GitHub fine-grained PATs
  { re: /\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{35}|github_pat_[A-Za-z0-9_]{20,})\b/g, replacement: "[TOKEN]", kind: "token" },
  // Common secret prefixes (OpenAI/Stripe-style sk-, GitHub ghp_/gho_/ghs_, Slack xox*)
  { re: /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|xox[bpas])[-_][A-Za-z0-9_-]{16,}\b/g, replacement: "[TOKEN]", kind: "token" },
  // Long unbroken base64-ish blobs (embedded images, signatures, keys)
  { re: /\b[A-Za-z0-9+/]{64,}={0,2}\b/g, replacement: "[BLOB]", kind: "blob" },
  // Phone numbers: 10+ digits with separators, not part of a larger number/decimal
  { re: /(?<![\d.])\+?\d[\d ().-]{8,}\d(?![\d.])/g, replacement: "[PHONE]", kind: "phone" },
];

export function scrubPii(text: string): string {
  return RULES.reduce((acc, rule) => acc.replace(rule.re, rule.replacement), text);
}

/** Every distinct `kind` name RULES can produce — the single source of truth
 * for "what placeholder kinds does scrubbing actually emit," so a consumer
 * that needs to recognize a scrubbed/placeholder tag (browseStep.ts's
 * UNMAPPED_PLACEHOLDER_RE) can derive its list from here instead of
 * hardcoding a parallel copy that could silently drift from RULES. */
export const PII_KINDS: readonly string[] = [...new Set(RULES.map((r) => r.kind))];

export function containsPii(text: string): boolean {
  return scrubPii(text) !== text;
}

export interface PiiSpan {
  start: number;
  end: number;
  kind: string;
}

/** Locates each PII match's position in `text` using the SAME regexes
 * scrubPii redacts with (RULES above) — a span-finding variant exposed so a
 * caller that needs to know WHERE a PII value sits (browseStep.ts's
 * extractTextCandidates, review finding #1: a goal-derived candidate that
 * merely OVERLAPS a PII span, without being that whole span, must be
 * dropped rather than offered to the vendor as an unflagged fragment) does
 * not have to duplicate the pattern set to get it. Never redacts or mutates
 * `text` itself — that's still scrubPii's job everywhere else. */
export function findPiiSpans(text: string): PiiSpan[] {
  const spans: PiiSpan[] = [];
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      if (m.index === undefined) continue;
      spans.push({ start: m.index, end: m.index + m[0].length, kind: rule.kind });
    }
  }
  return spans;
}
