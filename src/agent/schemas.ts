// Input schemas of the seven browse tools, moved as-is from Pen Editor's
// backend (src/ai/tools.ts). The JSON schemas the model sees must stay
// byte-identical, so field order, descriptions and limits do not change.
//
// browse_screenshot is split: the package owns `annotate`; a host that lets
// the model place the capture somewhere (Pen Editor: `placeOnCanvas`, `x`,
// `y`) adds those fields with `.extend({...})`. Extended keys come after
// `annotate`, which is the order Pen Editor's schema has today.
import { z } from "zod";
import { VIEWPORT_DEVICES, VIEWPORT_MAX, VIEWPORT_MIN } from "../shared/viewport.js";

// Shared by browse_act's top-level fields and its `actions` batch entries
// (see the tool below) — one place for the action enum so both stay in
// sync, and one entry schema so an `actions` element is provably "the same
// shape as a single browse_act call minus snapshotId" rather than a second,
// independently-maintained copy.
export const browseActionEnum = z.enum([
  "click",
  "type",
  "scroll",
  "back",
  "forward",
  "press",
  "hover",
  "select",
  "upload",
  "reload",
  "wait",
  "viewport",
]);

const BROWSE_ACT_SINGLE_FIELDS = [
  "action",
  "target",
  "index",
  "element",
  "text",
  "amount",
  "key",
  "ms",
  "files",
  "device",
  "width",
  "height",
  "mobile",
] as const;

const BROWSE_ACT_NO_ELEMENT_ACTIONS = new Set([
  "back",
  "forward",
  "reload",
  "wait",
  "viewport",
]);

// A strict-mode placeholder: null or "" (with `trim`, a whitespace-only string too).
function isPlaceholder(value: unknown, trim = false): boolean {
  return value === null || value === "" || (trim && typeof value === "string" && value.trim() === "");
}

// One file of an `upload` batch: the same strict-mode placeholders ("" / null) are removed.
function stripUploadFilePlaceholders(file: unknown): unknown {
  if (!file || typeof file !== "object" || Array.isArray(file)) return file;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(file)) {
    if (isPlaceholder(value)) continue;
    out[key] = value;
  }
  return out;
}

// OpenAI models on OpenRouter answer in strict mode: they fill EVERY key of
// the schema, so unused fields arrive as "" / 0 / null, and a single action
// arrives as `action` plus a one-entry `actions` copy of itself. Before this,
// every gpt-6-luna browse_act call failed the exactly-one check below and
// never reached the browser. Strips those placeholders so the call means
// what a model that omits unused keys would have sent.
function stripBrowseActPlaceholders(
  entry: Record<string, unknown>,
  hasSnapshotId: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (isPlaceholder(value)) continue;
    // An empty `files` array is the strict-mode placeholder for "no files".
    if (key === "files" && Array.isArray(value) && value.length === 0) continue;
    if (key === "files" && Array.isArray(value)) {
      out[key] = value.map(stripUploadFilePlaceholders);
      continue;
    }
    if ((key === "amount" || key === "ms") && value === 0) continue;
    // `viewport`: width and height 0 mean "absent", except with device "custom" (there 0 is an error).
    if ((key === "width" || key === "height") && value === 0 && entry.device !== "custom") continue;
    // `mobile: false` is the default of a custom viewport, so dropping it loses nothing.
    if (key === "mobile" && value === false) continue;
    out[key] = value;
  }
  // index 0 is a real element, but next to an explicit target/element (or
  // with no snapshotId to resolve it against) it is the placeholder zero.
  // Strict-mode models also send index 0 for a window scroll and for actions
  // that take no element: kept, it scrolled INSIDE element 0 instead of the
  // page (gpt-6-luna, OM2W 2026-10-14).
  if (
    out.index === 0 &&
    (!hasSnapshotId ||
      out.target !== undefined ||
      out.element !== undefined ||
      out.action === "scroll")
  ) {
    delete out.index;
  }
  if (
    typeof out.action === "string" &&
    BROWSE_ACT_NO_ELEMENT_ACTIONS.has(out.action)
  ) {
    delete out.index;
  }
  return out;
}

export function normalizeBrowseActInput(val: unknown): unknown {
  if (!val || typeof val !== "object" || Array.isArray(val)) return val;
  const raw = val as Record<string, unknown>;
  const hasSnapshotId =
    typeof raw.snapshotId === "string" && raw.snapshotId !== "";
  const top = stripBrowseActPlaceholders(raw, hasSnapshotId);
  if (Array.isArray(top.actions)) {
    top.actions = top.actions.map((e) =>
      e && typeof e === "object" && !Array.isArray(e)
        ? stripBrowseActPlaceholders(
            e as Record<string, unknown>,
            hasSnapshotId,
          )
        : e,
    );
  }
  const actions = top.actions as unknown[] | undefined;
  if (actions !== undefined && actions.length === 0) delete top.actions;
  if (top.action !== undefined && Array.isArray(top.actions)) {
    if (top.actions.length === 1) {
      // One entry duplicating the top-level call: fold it into a single call.
      const entry = top.actions[0];
      delete top.actions;
      if (entry && typeof entry === "object")
        return { ...(entry as object), ...top };
    } else {
      for (const key of BROWSE_ACT_SINGLE_FIELDS) delete top[key];
    }
  }
  return top;
}

const ELEMENT_DESCRIPTION =
  "Describe the element in words instead of passing target/index, e.g. \"the Continue button in the cookie banner\" or \"the site search box\". A fast model picks it from a fresh snapshot of the page in one quick call — cheaper than a browse_snapshot round trip. That snapshot becomes the new current one, so any snapshotId you already had goes stale; use the result's `resolved.snapshotId` for further index-based calls. Works for click/type/select/hover/upload and for press's optional focus target — press resolves `element` against any focusable candidate (button, text input, or select), not click-only, so it can match a text input too.";

export interface BrowseActSchemaOptions {
  /**
   * Add the natural-language `element` field. Default false. Only a host that
   * resolves `element` itself (Pen Editor: a fast model picks the node from a
   * snapshot) turns it on, and then handles browse_act itself:
   * `executeBrowseTool` always refuses an element-only call.
   */
  elementTargeting?: boolean;
}

/**
 * One file for the `upload` action: a name, an optional MIME type and exactly
 * one source. Flat on purpose (not a union): OpenAI strict mode fills every
 * key, and `stripUploadFilePlaceholders` removes the empty ones.
 */
export const uploadFileSchema = z
  .object({
    name: z.string().min(1).max(100).describe("File name the page sees, e.g. \"avatar.png\". Up to 100 characters, no / or \\."),
    mimeType: z.string().optional().describe("MIME type. Default: from the sample kind, else from the name."),
    text: z.string().optional().describe("UTF-8 text content. Give exactly one of text, base64 or sample."),
    base64: z.string().optional().describe("Raw bytes as base64. Give exactly one of text, base64 or sample."),
    sample: z
      .enum(["png", "jpg", "pdf", "txt", "csv"])
      .optional()
      .describe("A built-in tiny valid file. Give exactly one of text, base64 or sample."),
  })
  .superRefine((val, ctx) => {
    const sources = [val.text, val.base64, val.sample].filter((v) => v !== undefined).length;
    if (sources !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Give exactly one of `text`, `base64` or `sample` for each file.",
      });
    }
  });

const FILES_DESCRIPTION =
  "Files for upload: 1-5 entries, 2 MB decoded in total. Each is { name, mimeType?, and one of text | base64 | sample }.";

const viewportSize = z.number().int().min(VIEWPORT_MIN).max(VIEWPORT_MAX);

const DEVICE_DESCRIPTION =
  "Device for the viewport action: iphone-15, pixel-8, ipad, desktop-1440, desktop-1920, custom (needs width and height), or reset (back to the start state).";

/** One entry of browse_act's `actions` batch. */
export function createBrowseActEntrySchema(opts: BrowseActSchemaOptions = {}) {
  return z.object({
    action: browseActionEnum,
    target: z.string().optional(),
    index: z.number().int().min(0).optional(),
    ...(opts.elementTargeting ? { element: z.string().max(300).optional() } : {}),
    text: z.string().optional(),
    amount: z.number().optional(),
    key: z.string().optional(),
    ms: z.number().max(15000).optional(),
    files: z.array(uploadFileSchema).min(1).max(5).optional(),
    device: z.enum(VIEWPORT_DEVICES).optional(),
    width: viewportSize.optional(),
    height: viewportSize.optional(),
    mobile: z.boolean().optional(),
  });
}

/** browse_act input. Wrapped in `z.preprocess` so the placeholders that
 * OpenAI strict mode fills in are removed before validation. */
export function createBrowseActInputSchema(opts: BrowseActSchemaOptions = {}) {
  return z.preprocess(
    normalizeBrowseActInput,
    z
      .object({
        action: browseActionEnum
          .optional()
          .describe("Which action to perform. Omit when `actions` is given instead."),
        target: z
          .string()
          .optional()
          .describe("Visible text or CSS selector to act on. Used by click/type/press (to focus first)/hover."),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Element index from a browse_snapshot or annotated browse_screenshot call, used instead of `target`. Requires `snapshotId` from that same call. Also used by `scroll` to scroll inside that element instead of the window.",
          ),
        snapshotId: z
          .string()
          .optional()
          .describe("The snapshotId that `index` refers to — from the browse_snapshot/browse_screenshot call that produced it (or a previous browse_act/browse_open result's `snapshot`). Stale once a newer snapshot has been taken. Also the snapshotId every entry in `actions` resolves its own `index` against."),
        ...(opts.elementTargeting
          ? { element: z.string().max(300).optional().describe(ELEMENT_DESCRIPTION) }
          : {}),
        text: z
          .string()
          .optional()
          .describe("Text to type (action: type), or the option label/value to choose (action: select)."),
        amount: z
          .number()
          .optional()
          .describe("Scroll distance in viewport heights. Used by scroll, default 1."),
        key: z
          .string()
          .optional()
          .describe('Key to press, e.g. "Enter", "Escape", "Tab", "ArrowDown", "Meta+a". Used by press.'),
        ms: z
          .number()
          .max(15000)
          .optional()
          .describe("Milliseconds to wait. Used by wait, default 3000, hard cap 15000."),
        files: z.array(uploadFileSchema).min(1).max(5).optional().describe(FILES_DESCRIPTION),
        device: z.enum(VIEWPORT_DEVICES).optional().describe(DEVICE_DESCRIPTION),
        width: viewportSize.optional().describe(`Viewport width in CSS pixels, ${VIEWPORT_MIN} to ${VIEWPORT_MAX}. Used by viewport with device custom.`),
        height: viewportSize.optional().describe(`Viewport height in CSS pixels, ${VIEWPORT_MIN} to ${VIEWPORT_MAX}. Used by viewport with device custom.`),
        mobile: z.boolean().optional().describe("Set true for a phone-like viewport (touch, mobile layout). Used by viewport with device custom, default false."),
        actions: z
          .array(createBrowseActEntrySchema(opts))
          .min(1)
          .max(10)
          .optional()
          .describe(
            "Run up to 10 steps in one call instead of a single `action` — see the description above. Each entry has the same fields as this call except `snapshotId` (they all share the top-level one).",
          ),
      })
      .superRefine((val, ctx) => {
        const hasAction = val.action !== undefined;
        const hasActions = val.actions !== undefined && val.actions.length > 0;
        if (hasAction === hasActions) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["action"],
            message: "Provide exactly one of `action` or `actions`.",
          });
        }
      }),
  );
}

/** Neutral entry schema: no `element` field. */
export const browseActEntrySchema = createBrowseActEntrySchema();

/** Neutral browse_act input: no `element` field (see `createBrowseActInputSchema`). */
export const browseActInputSchema = createBrowseActInputSchema();

export const browseOpenInputSchema = z.object({
  url: z.string().describe("The URL to navigate the browser tab to."),
});

export interface BrowseOpenSchemaOptions {
  /** Let the model pass `app` (a macOS .app path) instead of `url`. Default false. */
  appLaunch?: boolean;
}

// Strict-mode models send "" for every key they do not use, so an empty `url`
// or `app` means "absent" (same idea as `stripBrowseActPlaceholders`).
function stripBrowseOpenPlaceholders(entry: unknown): unknown {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if ((key === "url" || key === "app") && isPlaceholder(value, true)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * browse_open input. Without `appLaunch` this is exactly `browseOpenInputSchema`.
 * With it, `url` is optional and `app` is added; exactly one of the two must be
 * non-empty.
 */
export function createBrowseOpenInputSchema(opts: BrowseOpenSchemaOptions = {}): z.ZodTypeAny {
  if (opts.appLaunch !== true) return browseOpenInputSchema;
  return z.preprocess(
    stripBrowseOpenPlaceholders,
    z
      .object({
        url: z.string().optional().describe("The URL to navigate the browser tab to."),
        app: z
          .string()
          .max(1024)
          .optional()
          .describe("The path of a macOS .app of an Electron desktop app to launch, for example /Applications/Orca.app. Use instead of `url`."),
      })
      .superRefine((value, ctx) => {
        const hasUrl = typeof value.url === "string" && value.url.trim() !== "";
        const hasApp = typeof value.app === "string" && value.app.trim() !== "";
        if (hasUrl === hasApp) {
          ctx.addIssue({
            code: "custom",
            message: "Provide exactly one of a non-empty `url` or a non-empty `app`.",
          });
        }
      }),
  );
}

export const browseSnapshotInputSchema = z.object({});

/** browse_screenshot input without host-only fields (see the file header). */
export const browseScreenshotInputSchema = z.object({
  annotate: z
    .boolean()
    .optional()
    .describe(
      "If true, overlays numbered labels on interactive elements and also returns snapshotId + elements for acting by index. Default false (plain screenshot).",
    ),
});

export const browseTabsInputSchema = z.object({
  action: z.enum(["list", "switch", "close", "new"]).describe("Which tab operation to perform."),
  tabId: z
    .number()
    .int()
    .optional()
    .describe("Target tab id. Required for switch/close; ignored for list; optional for new (rare)."),
  url: z
    .string()
    .optional()
    .describe("URL to load in the newly created tab. Used only by action: new."),
});

export const browseFindImagesInputSchema = z.object({
  minWidth: z.number().optional().describe("Minimum rendered width in px to include. Default 200."),
  minHeight: z.number().optional().describe("Minimum rendered height in px to include. Default 200."),
  limit: z.number().optional().describe("Maximum number of images to return. Default 30, hard cap 100."),
});

export const browseReadInputSchema = z.object({
  maxChars: z
    .number()
    .int()
    .positive()
    .max(20000)
    .optional()
    .describe("Maximum characters of visible text to return. Default 6000, hard cap 20000."),
  selector: z
    .string()
    .optional()
    .describe("CSS selector to narrow the read to one subtree of the page. Omit to read the whole page."),
});
