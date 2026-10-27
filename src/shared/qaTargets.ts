// Names the element an index-based QA check points at (docs/specs/2026-10-19-qa-judge-design.md, "Targets").
// `describeElement` is the one format: the package's controller uses it to fill `target` in its `assert` answer,
// and a host with its own controller can mirror it. The tracker is the fallback for an answer without `target`.
// Zod-free. Imports nothing from qaChecks.ts (that file imports this one).
import { redactUrl } from "./redactUrl.js";

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A `target` text is at most this many characters (docs/specs/2026-10-19-qa-judge-design.md, "Targets"). */
export const QA_TARGET_MAX_CHARS = 80;

/** The ONE one-line form of a text: whitespace (newlines too) collapsed, trimmed; undefined when not a string or blank. */
export const oneLine = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.replace(/\s+/g, " ").trim() : undefined);

/** Cuts `text` to `max` chars (the last three become "..."), but never inside a surrogate pair. `max` below 3 gives "...". */
export function cutWhole(text: string, max: number): string {
  if (text.length <= max) return text;
  const body = text.slice(0, Math.max(0, max - 3));
  const last = body.charCodeAt(body.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? `${body.slice(0, -1)}...` : `${body}...`;
}

/** A `target` from an untrusted value: one line, at most `QA_TARGET_MAX_CHARS`; undefined when blank. */
export function normalizeTarget(v: unknown): string | undefined {
  const t = oneLine(v);
  return t !== undefined ? cutWhole(t, QA_TARGET_MAX_CHARS) : undefined;
}

/**
 * True for a check that names its element by snapshot index: a numeric `index` and no `selector` (absent, or blank
 * after trim). `parseQaChecks` already rejects a blank selector and drops the placeholder `index: 0` next to a
 * real one, so for a parsed check this means "selector absent". The controller and the recorder both use this rule.
 */
export function isIndexCheck(check: unknown): check is { index: number } {
  if (!isObject(check) || typeof check.index !== "number") return false;
  return !(typeof check.selector === "string" && check.selector.trim() !== "");
}

/**
 * `role "label"` of a snapshot element, at most `QA_TARGET_MAX_CHARS` (80) chars in total, or undefined when the
 * element has neither. The role falls back to `tag`; the label to `name`, `text`, `placeholder`. Only the LABEL is cut
 * (with "...", never inside a surrogate pair), then quoted: a `"` inside the label becomes `'`, so the result
 * is well formed. With a role only the result is the role; with a label only it is the quoted label.
 */
export function describeElement(el: unknown): string | undefined {
  if (!isObject(el)) return undefined;
  const role = oneLine(el.role) ?? oneLine(el.tag);
  const label = oneLine(el.label) ?? oneLine(el.name) ?? oneLine(el.text) ?? oneLine(el.placeholder);
  const cutRole = role !== undefined ? cutWhole(role, 40) : undefined;
  if (label === undefined) return cutRole;
  const room = QA_TARGET_MAX_CHARS - (cutRole !== undefined ? cutRole.length + 1 : 0) - 2;
  const quoted = `"${cutWhole(label.replace(/"/g, "'"), Math.max(3, room))}"`;
  return cutRole !== undefined ? `${cutRole} ${quoted}` : quoted;
}

/** `index -> description` of every element of an element list that has one. A copy: later changes to the list do not reach it. */
export function describeElements(elements: unknown): Map<number, string> {
  const out = new Map<number, string>();
  if (!Array.isArray(elements)) return out;
  for (const el of elements) {
    if (!isObject(el) || typeof el.index !== "number") continue;
    const d = describeElement(el);
    if (d !== undefined) out.set(el.index, d);
  }
  return out;
}

/** The page URL and title at the latest tool output. */
export interface QaSnapshotPage {
  url: string;
  title: string;
}

/** Tools whose output can change the page. Their output without a snapshot drops the element map. */
export const PAGE_CHANGING_TOOLS: ReadonlySet<string> = new Set(["browse_open", "browse_act", "browse_tabs"]);

export interface SnapshotTracker {
  /**
   * Takes a tool output: the latest element list (`{ elements }` or `{ snapshot: { elements } }`) and the top-level
   * `url`/`title`. `tool` is the name of the tool that gave it. A new URL without a snapshot, or the output of a
   * page-changing tool (`browse_open`, `browse_act`, `browse_tabs`) without one, drops the element map: its indices
   * no longer apply. The output of a read-only tool (`browse_read`, `browse_screenshot`, `qa_assert`, ...) keeps it.
   */
  observe(output: unknown, tool?: string): void;
  /** The target of an element index in the latest snapshot, or undefined. */
  describe(index: number): string | undefined;
  /** URL (origin and path only) and title of the latest output that carried a URL. */
  page(): QaSnapshotPage | undefined;
}

/**
 * Fallback for an `assert` answer that carries neither `target` nor a top-level `url`/`title` (a host with an old
 * controller). Best effort: it names the element in the latest snapshot the MODEL received, so with parallel tool
 * calls it can be wrong or empty. The authoritative source is the answer. Stores only index -> description and the
 * page (URL redacted), not the outputs.
 */
export function createSnapshotTracker(): SnapshotTracker {
  let described = new Map<number, string>();
  let page: QaSnapshotPage | undefined;
  return {
    observe(output, tool) {
      if (!isObject(output)) return;
      const snap = isObject(output.snapshot) && Array.isArray(output.snapshot.elements) ? output.snapshot : Array.isArray(output.elements) ? output : undefined;
      const rawUrl = oneLine(output.url) ?? oneLine(snap?.url);
      const url = rawUrl !== undefined ? redactUrl(rawUrl) : undefined;
      if (!snap && ((tool !== undefined && PAGE_CHANGING_TOOLS.has(tool)) || (url !== undefined && url !== page?.url))) described = new Map();
      if (url !== undefined) page = { url, title: oneLine(output.title) ?? oneLine(snap?.title) ?? (url === page?.url ? page.title : "") };
      if (snap) described = describeElements(snap.elements);
    },
    describe: (index) => described.get(index),
    page: () => (page ? { ...page } : undefined),
  };
}
