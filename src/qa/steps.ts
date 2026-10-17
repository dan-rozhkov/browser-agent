// The trail of a scenario: one step per tool the model called. It is built
// from the `onToolCall` hook of `runBrowseAgent`, so it holds what the MODEL
// asked (its tool name and input), not the bridge calls the tool made. The
// fixture is applied outside the model's tools, so its data cannot get here.
import { parseJsonObject, type BrowseAgentToolCall } from "../agent/session.js";
import type { QaStep } from "./types.js";

/** `text` values longer than this are cut in the recorded args. */
export const QA_STEP_TEXT_MAX_CHARS = 200;

const MAX_DEPTH = 6;

/** A copy of `value` with every long `text` string cut. Bounded depth, so an odd value cannot loop. */
function cutText(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return depth >= MAX_DEPTH ? [] : value.map((v) => cutText(v, depth + 1));
  if (!value || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return {};
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = key === "text" && typeof v === "string" && v.length > QA_STEP_TEXT_MAX_CHARS ? v.slice(0, QA_STEP_TEXT_MAX_CHARS) : cutText(v, depth + 1);
  }
  return out;
}

export interface StepRecorder {
  /** Pass this as `onToolCall`. */
  onToolCall(call: BrowseAgentToolCall): (result: { output?: string; error?: unknown }) => void;
  /** The steps so far in call order. A call that has not ended is not ok. */
  steps(): QaStep[];
}

export function createStepRecorder(now: () => number = Date.now): StepRecorder {
  // One record per call, in call order: the step, when it started, and whether it is still running.
  const slots: { step: QaStep; started: number; open: boolean }[] = [];
  return {
    onToolCall(call) {
      // The pre-open of `url` is the session's own call, not the model's.
      if (call.preOpen) return () => undefined;
      // The slot is taken when the call starts, so parallel calls keep their order.
      const slot = { step: { index: slots.length + 1, tool: call.toolName, args: cutText(call.input), ok: false, error: "did not finish", ms: 0 } as QaStep, started: now(), open: true };
      slots.push(slot);
      return (result) => {
        const step: QaStep = { index: slot.step.index, tool: call.toolName, args: slot.step.args, ok: true, ms: Math.max(0, now() - slot.started) };
        if (result.error !== undefined) {
          step.ok = false;
          step.error = result.error instanceof Error ? result.error.message : String(result.error);
        } else {
          const error = parseJsonObject(result.output ?? "").error;
          if (typeof error === "string") {
            step.ok = false;
            step.error = error;
          }
        }
        slot.step = step;
        slot.open = false;
      };
    },
    steps() {
      return slots.map((s) => (s.open ? { ...s.step, ms: Math.max(0, now() - s.started) } : s.step));
    },
  };
}
