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
  /** Console errors seen during the run (deduped, at most 20). Absent when none. */
  consoleErrors?: string[];
  /** How many more console errors were left out. Absent when none. */
  consoleErrorsDropped?: number;
  /** Failed requests seen during the run (deduped, at most 20). Absent when none. */
  failedRequests?: string[];
  /** How many more failed requests were left out. Absent when none. */
  failedRequestsDropped?: number;
  /** Assertion results, in order: the agent's `qa_assert` calls, then the host's final checks. Absent when none ran. */
  checks?: QaCheckRecord[];
}

/** One deterministic check of the page (docs/specs/2026-10-18-qa-diagnostics-design.md, section 2). */
export type QaElementState = "visible" | "hidden" | "exists" | "absent" | "enabled" | "disabled" | "checked" | "unchecked";

export type QaCheck =
  /** Visible text of the top document, case-insensitive substring. The text must be on the page, unless `absent` is true (default false: a strict-mode `false` placeholder is the safe default). */
  | { type: "text"; text: string; absent?: boolean }
  /** An element by CSS `selector` or snapshot `index`. */
  | { type: "element"; selector?: string; index?: number; state: QaElementState }
  /** The value of an input, textarea or select. */
  | { type: "value"; selector?: string; index?: number; equals?: string; contains?: string }
  | { type: "count"; selector: string; equals?: number; min?: number; max?: number }
  /** Against the full page URL. `matches` is a JS regex source. */
  | { type: "url"; equals?: string; contains?: string; matches?: string }
  /** `ignore` lists substrings of entries to skip. */
  | { type: "no_console_errors"; ignore?: string[] }
  | { type: "no_failed_requests"; ignore?: string[] };

/** The result of one check. `actual` is a short text (at most 120 chars) that explains a failure. */
export interface QaCheckResult {
  check: QaCheck;
  passed: boolean;
  actual?: string;
  error?: string;
}

/** What the controller command `assert` returns. */
export interface QaAssertResult {
  ok: true;
  passed: boolean;
  results: QaCheckResult[];
  consoleErrors?: string[];
  failedRequests?: string[];
}

/** A check result as recorded in `QaResult.checks`. */
export interface QaCheckRecord {
  source: "agent" | "final";
  check: QaCheck;
  passed: boolean;
  actual?: string;
  error?: string;
}
