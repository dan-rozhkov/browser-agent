import type { QaResult } from "./qaTypes.js";
import { BROWSE_AGENT_ANSWER_MAX_CHARS, BROWSE_AGENT_ERROR_MAX_CHARS } from "./limits.js";

export type BrowseAgentStatus = "done" | "error" | "aborted" | "step_limit" | "timeout" | "setup_failed";

/**
 * The result of one run. Serialize it with `JSON.stringify` to get the string
 * Pen Editor returns to its main model: the key order is `status`, `answer`,
 * `steps`, the extra fields of host tools (for example `captured`, and `qa` in QA mode), then `error`.
 */
export interface BrowseAgentResult {
  status: BrowseAgentStatus;
  /** The plain-text report of the model. */
  answer: string;
  /** Tool executions, including the pre-open. */
  steps: number;
  /** Set for status `error` and `setup_failed` (and by `goalRequiredResult`). */
  error?: string;
  /** Set for status `setup_failed` when the setup knows which part broke (for a fixture: the apply stage). */
  setupStage?: string;
  /** QA mode (`runBrowseAgent({ qa })`): outcome, verdict and the model's steps. */
  qa?: QaResult;
  /** Extra fields from host tools. */
  [extra: string]: unknown;
}

/** One part of a conversation message. A structural subset of the AI SDK `UIMessage` part. */
export interface BrowseAgentMessagePart {
  type: string;
  text?: string;
}

/** A conversation message. Structurally compatible with the AI SDK `UIMessage`. */
export interface BrowseAgentMessage {
  role: string;
  parts: readonly BrowseAgentMessagePart[];
}

function textOf(parts: readonly BrowseAgentMessagePart[]): string {
  return parts.map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : "")).join("");
}

/**
 * The report. For a finished run: the last assistant message's text after its
 * last tool part. For any other status the run was cut short, so the report
 * may not exist yet: return all assistant text of the session, in order,
 * keeping the END when over the cap.
 */
export function finalAnswer(messages: readonly BrowseAgentMessage[], status: BrowseAgentStatus): string {
  const max = BROWSE_AGENT_ANSWER_MAX_CHARS;
  if (status !== "done") {
    const all = messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.parts.map((p) => (p.type === "text" && typeof p.text === "string" ? p.text.trim() : "")))
      .filter(Boolean)
      .join("\n\n");
    return all.length > max ? all.slice(-max) : all;
  }
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  if (!last) return "";
  let lastToolIdx = -1;
  last.parts.forEach((p, i) => {
    if (p.type.startsWith("tool-") || p.type === "dynamic-tool") lastToolIdx = i;
  });
  return textOf(last.parts.slice(lastToolIdx + 1)).trim().slice(0, max);
}

/** An error as a short message (capped). */
export function browseAgentErrorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.slice(0, BROWSE_AGENT_ERROR_MAX_CHARS);
}

/** The result for a call without a goal. */
export function goalRequiredResult(): BrowseAgentResult {
  return { status: "error", answer: "", steps: 0, error: "goal is required" };
}

/**
 * The first user message when the browser already opened a start page: the
 * goal, then the result of `browse_open` (it holds a snapshot of the page).
 */
export function preOpenText(goal: string, url: string, openedResult: string): string {
  return `${goal}\n\nThe browser already opened ${url} for you (browse_open). Its result, with a snapshot of the page:\n${openedResult}`;
}

/**
 * The part of the first user message that follows the goal when the browser
 * state was prepared from a PageFixture: the safe summary (counts only) and a
 * snapshot of the page. The fixture itself never reaches the model.
 */
export function fixtureSetupBody(summary: string, snapshotResult: string): string {
  return `The browser state was prepared for you (${summary}). Snapshot of the page:\n${snapshotResult}`;
}
