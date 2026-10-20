// Screenshot normalizer shared by the policy schemas and the trace recorder. Zod-free, no imports.

const DATA_IMAGE_PREFIX_RE = /^data:image\/(jpeg|png|webp)(?:;[^,;]+)*;base64,/i;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MIN_SCREENSHOT_BASE64_CHARS = 100;
// Leading base64 characters of each format's magic bytes.
const RAW_MAGIC: ReadonlyArray<readonly [string, string]> = [
  ["/9j/", "jpeg"],
  ["iVBOR", "png"],
  ["UklGR", "webp"],
];

/** Canonical `data:image/<fmt>;base64,<payload>` for a data URL (extra media
 * type parameters such as charset tolerated and dropped, whitespace in the
 * payload stripped) or for raw base64 whose magic bytes name jpeg/png/webp.
 * Anything else — too short, wrong alphabet, unknown format — is undefined. */
export function normalizeScreenshot(raw: string | undefined): string | undefined {
  const s = raw?.trim();
  if (!s) return undefined;
  const prefix = DATA_IMAGE_PREFIX_RE.exec(s);
  const payload = (prefix ? s.slice(prefix[0].length) : s).replace(/\s+/g, "");
  if (payload.length < MIN_SCREENSHOT_BASE64_CHARS || !BASE64_RE.test(payload)) return undefined;
  if (prefix) return `data:image/${prefix[1]!.toLowerCase()};base64,${payload}`;
  const format = RAW_MAGIC.find(([magic]) => payload.startsWith(magic))?.[1];
  return format ? `data:image/${format};base64,${payload}` : undefined;
}
