// Types of the QA mode result. Types only (no runtime code), so `result.ts` can
// name `QaResult` without pulling zod into the zod-free `agent/session` graph.
export type QaOutcome = "passed" | "failed" | "inconclusive" | "error" | "setup_failed" | "aborted";

export interface QaStep {
  /** 1-based, in call order. */
  index: number;
  /** The tool the model called (`browse_read`, `browse_act`, ..., `qa_verdict`). */
  tool: string;
  /** The input the model gave; `text` values over 200 chars are cut. */
  args: unknown;
  ok: boolean;
  /** The error text, capped like the run's `error`. */
  error?: string;
  ms: number;
}

/** The `qa` field of a run result. */
export interface QaResult {
  outcome: QaOutcome;
  /** Absent when the model gave no verdict. */
  verdict?: "pass" | "fail";
  /** The verdict reason. Without a verdict and without a run `error`, for outcome `error`: why the run ended ("request limit reached" or "deadline reached"). */
  reason?: string;
  /** The last `QA_RESULT_MAX_STEPS` steps. */
  steps: Omit<QaStep, "ms">[];
  /** How many earlier steps were left out. Absent when none. */
  stepsDropped?: number;
}
