// The "ax" DOM entry of a browse trace (docs/specs/2026-10-26-trace-dom-snapshot-design.md, "Desktop apps"):
// the element list of `BrowserBridge.snapshot()` as text, for a target that has no DOM (a native app) or that
// refuses `capture`. Zod-free (exported from `agent/session` and `agent`).

import { isSecretFieldName } from "../shared/trace.js";

const MAX_LINE_CHARS = 300;
const MAX_ELEMENTS = 500;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const oneLine = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
};

/**
 * Formats the `elements` of a snapshot result as text, one line per element:
 * `[index] role-or-tag "label" value="..." (flags)`. The value of a password field is never written
 * (`isPassword`, `inputType`/`type` "password", `masked`, or a label/name/id that `isSecretFieldName` matches); an element that reports only `hasValue` shows `filled`.
 * Elements past 500 are left out with a last line saying how many. Returns "" for a value without elements.
 * Never throws.
 */
export function formatSnapshotForTrace(snapshot: unknown): string {
  try {
    if (!isObject(snapshot) || !Array.isArray(snapshot.elements)) return "";
    const lines: string[] = [];
    const elements = snapshot.elements;
    for (const el of elements.slice(0, MAX_ELEMENTS)) {
      if (!isObject(el)) continue;
      const index = typeof el.index === "number" ? el.index : lines.length;
      const kind = typeof el.role === "string" && el.role !== "" ? el.role : typeof el.tag === "string" ? el.tag : "element";
      const label = typeof el.label === "string" ? oneLine(el.label, 120) : "";
      let line = `[${index}] ${kind} "${label}"`;
      const names = [el.label, el.name, el.id].filter((n): n is string => typeof n === "string");
      const secret =
        el.isPassword === true || el.inputType === "password" || el.type === "password" || el.masked === true || names.some((n) => isSecretFieldName(n));
      if (!secret && typeof el.value === "string" && el.value !== "") line += ` value="${oneLine(el.value, 120)}"`;
      else if (!secret && el.hasValue === true) line += " filled";
      if (el.disabled === true) line += " disabled";
      if (typeof el.checked === "boolean") line += el.checked ? " checked" : " unchecked";
      if (typeof el.expanded === "boolean") line += el.expanded ? " expanded" : " collapsed";
      if (typeof el.frame === "string" && el.frame !== "") line += ` in frame ${oneLine(el.frame, 60)}`;
      lines.push(oneLine(line, MAX_LINE_CHARS));
    }
    if (elements.length > MAX_ELEMENTS) lines.push(`... ${elements.length - MAX_ELEMENTS} more elements`);
    return lines.join("\n");
  } catch {
    return "";
  }
}
