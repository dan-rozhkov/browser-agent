import { z } from "zod";
import { MAX_GOAL_CHARS } from "./browsePlan.js";

// Request-body schemas of the three browse policy entry points, copied
// verbatim from the backend routes (routes/browse{Step,Plan,Locate}.ts) so
// every host validates the same way. The HTTP routes answered 400 with
// `issues[0].message` on failure; hosts do the same with `safeParse`.

// `value`/`options` are bounded here only as a coarse sanity/DoS guard, not
// at the real limit (MAX_ELEMENT_VALUE_CHARS/MAX_ELEMENT_OPTIONS/
// MAX_OPTION_CHARS in browseStep.ts) — a long textarea or a 195-option
// country/state/year <select> is ordinary page content, and rejecting the
// request over it (as this used to at 500/200/100) 400s the whole step and
// burns the client loop's budget on identical failures. decideBrowseStep
// truncates these down to the real limits unconditionally, the same way it
// already re-caps `elements` regardless of what the client sent.
// Exported so the locate body schema (same element shape, same truncation
// rules) doesn't redeclare this schema.
export const elementSchema = z
  .object({
    index: z.number().int().nonnegative(),
    tag: z.string().min(1).max(40),
    role: z.string().max(60).optional(),
    label: z.string().max(200),
    value: z.string().max(20_000).optional(),
    // What the desktop sends INSTEAD of `value` for every element whose
    // content must not leave the page (addendum D) — a password input, an
    // autocomplete="cc-*" field, a <select>. Without it here zod would strip
    // the key silently and Jev would lose the only remaining signal that the
    // field is already filled, which is the whole reason `value` was dropped.
    hasValue: z.boolean().optional(),
    checked: z.boolean().optional(),
    // Native input type of a checkbox/radio input; a native radio comes
    // role-less, so this is how a group is recognised.
    inputType: z.string().max(20).optional(),
    // aria-expanded of a combobox/menu button: whether its list is open.
    expanded: z.boolean().optional(),
    isPassword: z.boolean().optional(),
    // Natively disabled control (desktop snapshot): shown to the model but
    // never offered as a target.
    disabled: z.boolean().optional(),
    // Browse-speed contract (2026-09-24), scroll containers: a scroll
    // container entry (`{index, tag, label, ops: [], scrollable: true}`) has
    // no CLICK/TYPE_TEXT/SELECT of its own — it exists only so browse_act's
    // scroll action can target it by index. A bare `.min(1)` here would
    // reject that legitimate shape (400ing every step on a page that has
    // one), so an empty `ops` is instead allowed below, in `.superRefine`,
    // gated on `scrollable: true` — a genuinely empty `ops` on a
    // non-scrollable element still fails validation.
    ops: z.array(z.enum(["CLICK", "TYPE_TEXT", "SELECT"])),
    options: z.array(z.string().max(2_000)).max(1_000).optional(),
    // Browse-speed contract (2026-09-24) item 5: the desktop snapshot now also
    // marks a scroll container (`scrollable`, pass this element's index to
    // browse_act's scroll action to scroll inside it) and, once
    // snapshot/perform pierce iframes, which one an element lives in
    // (`frame`). Both are cheap to fold into decideBrowseStep's per-element
    // digest line (elementDigestLine in ./browseStep.js) — optional here
    // so zod doesn't silently strip them from an older/non-conforming client.
    scrollable: z.boolean().optional(),
    frame: z.string().max(200).optional(),
  })
  .superRefine((el, ctx) => {
    if (el.ops.length === 0 && !el.scrollable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ops must contain at least 1 element(s) unless scrollable is true",
        path: ["ops"],
      });
    }
  });

const historyEntrySchema = z.object({
  operation: z.string().max(40),
  label: z.string().max(200),
  ok: z.boolean(),
  // Round 4 review #1/#9: the element index the step acted on, when the
  // client sends one — see BrowseStepHistoryEntry's own comment. Optional
  // so an older client that doesn't send it still validates.
  index: z.number().int().nonnegative().optional(),
});

// Browse-speed contract item 5: the client's own scroll position, sent
// alongside `elements` so a WAIT/SCROLL decision can see whether the page is
// already at the bottom rather than guessing. Optional — an older client
// that doesn't send it degrades to exactly today's behavior.
const scrollSchema = z.object({
  y: z.number(),
  height: z.number(),
  atBottom: z.boolean().optional(),
});

export const browseStepBodySchema = z.object({
  goal: z.string().min(1).max(2_000),
  url: z.string().max(4_000),
  title: z.string().max(500),
  // Not bounded here at the exact MAX_SNAPSHOT_ELEMENTS — decideBrowseStep
  // re-caps unconditionally regardless of what the client sent, so this is
  // only a coarse request-size guard against a pathological payload.
  elements: z.array(elementSchema).max(1_000),
  history: z.array(historyEntrySchema).max(50),
  scroll: scrollSchema.optional(),
  // Visible page text (the snapshot's own, or a browse_read fallback) —
  // used by the ultrafast policy only. Optional: an older client omits it.
  pageText: z.string().max(20_000).optional(),
  // Name of the open aria-modal dialog the snapshot is scoped to (the desktop
  // snapshot's `modal`). Optional: older clients omit it.
  modal: z.string().max(200).optional(),
  // Marked screenshot (experiment, opts.vision). A malformed value is
  // dropped by normalizeScreenshot, never a 400.
  screenshot: z.string().max(4_000_000).optional(),
  // User switches. Absent (older clients): allowPasswordEntry=false,
  // confirmIrreversible=true.
  permissions: z
    .object({
      allowPasswordEntry: z.boolean().optional(),
      confirmIrreversible: z.boolean().optional(),
    })
    .optional(),
});

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

// Was routes/browsePlan.ts' bodySchema.
export const browsePlanBodySchema = z.object({
  goal: z.string().min(1).max(MAX_GOAL_CHARS),
  url: z.string().max(4_000).optional(),
});

// Was routes/browseLocate.ts' bodySchema.
export const browseLocateBodySchema = z.object({
  description: z.string().min(1).max(300),
  operation: z.enum(["CLICK", "TYPE_TEXT", "SELECT", "HOVER", "FOCUS"]),
  url: z.string().max(4_000),
  title: z.string().max(500),
  // Not bounded here at the exact MAX_SNAPSHOT_ELEMENTS — decideBrowseLocate
  // (via capAndScrubElements) re-caps unconditionally regardless of what the
  // client sent, mirroring the step schema's own coarse guard.
  elements: z.array(elementSchema).max(1_000),
});

export type BrowseStepBody = z.infer<typeof browseStepBodySchema>;
export type BrowsePlanBody = z.infer<typeof browsePlanBodySchema>;
export type BrowseLocateBody = z.infer<typeof browseLocateBodySchema>;
