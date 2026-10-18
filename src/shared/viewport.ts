// The `viewport` action of browse_act (docs/specs/2026-10-18-qa-diagnostics-design.md, section 6).
// Neutral and zod-free: the schema, the executor and the controller all read the same rules here.

/** The values of `device`. `custom` takes `width` and `height`; `reset` goes back to the start state. */
export const VIEWPORT_DEVICES = ["iphone-15", "pixel-8", "ipad", "desktop-1440", "desktop-1920", "custom", "reset"] as const;
export type ViewportDevice = (typeof VIEWPORT_DEVICES)[number];

export const VIEWPORT_MIN = 200;
export const VIEWPORT_MAX = 4000;

export type ViewportRequest =
  | { device: "iphone-15" | "pixel-8" | "ipad" | "desktop-1440" | "desktop-1920" | "reset" }
  | { device: "custom"; width: number; height: number; mobile: boolean };

const isDevice = (v: unknown): v is ViewportDevice => typeof v === "string" && (VIEWPORT_DEVICES as readonly string[]).includes(v);
const inRange = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= VIEWPORT_MIN && v <= VIEWPORT_MAX;

/**
 * Checks the fields of a `viewport` action. Placeholders of strict-mode models are removed before
 * this (`width` 0 next to a preset is gone), so a 0 here is a real error. `width`, `height` and
 * `mobile` are ignored for a preset or `reset`.
 */
export function parseViewportArgs(args: Record<string, unknown>): { ok: true; value: ViewportRequest } | { ok: false; error: string } {
  if (!isDevice(args.device)) {
    return { ok: false, error: `browse_act "viewport" requires "device": one of ${VIEWPORT_DEVICES.join(", ")}.` };
  }
  if (args.device !== "custom") return { ok: true, value: { device: args.device } };
  if (!inRange(args.width) || !inRange(args.height)) {
    return { ok: false, error: `browse_act "viewport" with device "custom" requires integer "width" and "height" from ${VIEWPORT_MIN} to ${VIEWPORT_MAX}.` };
  }
  if (args.mobile !== undefined && typeof args.mobile !== "boolean") {
    return { ok: false, error: 'browse_act "viewport" requires "mobile" to be true or false when provided.' };
  }
  return { ok: true, value: { device: "custom", width: args.width, height: args.height, mobile: args.mobile === true } };
}
