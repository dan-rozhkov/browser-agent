import { describe, expect, it } from "vitest";
import {
  BROWSE_AGENT_ANSWER_MAX_CHARS,
  BROWSE_AGENT_DEADLINE_MARGIN_MS,
  BROWSE_AGENT_DEADLINE_MS,
  BROWSE_AGENT_ERROR_MAX_CHARS,
  BROWSE_AGENT_MAX_REQUESTS,
  BROWSE_AGENT_OUTER_TIMEOUT_MS,
  browseAgentErrorMessage,
  finalAnswer,
  goalRequiredResult,
  preOpenText,
  type BrowseAgentMessage,
} from "../../src/agent/index.js";

const assistant = (...parts: BrowseAgentMessage["parts"][number][]): BrowseAgentMessage => ({ role: "assistant", parts });
const text = (t: string) => ({ type: "text", text: t });

describe("limits", () => {
  it("keep today's values", () => {
    expect(BROWSE_AGENT_OUTER_TIMEOUT_MS).toBe(900_000);
    expect(BROWSE_AGENT_DEADLINE_MARGIN_MS).toBe(60_000);
    expect(BROWSE_AGENT_DEADLINE_MS).toBe(840_000);
    expect(BROWSE_AGENT_MAX_REQUESTS).toBe(60);
    expect(BROWSE_AGENT_ANSWER_MAX_CHARS).toBe(8000);
    expect(BROWSE_AGENT_ERROR_MAX_CHARS).toBe(300);
  });
});

describe("finalAnswer", () => {
  it("done: the text after the last tool part of the last assistant message", () => {
    const messages: BrowseAgentMessage[] = [
      { role: "user", parts: [text("goal")] },
      assistant(text("let me look"), { type: "tool-browse_open" }, text("middle"), { type: "dynamic-tool" }, text("  The answer.  ")),
    ];
    expect(finalAnswer(messages, "done")).toBe("The answer.");
  });

  it("done: no assistant message gives an empty answer", () => {
    expect(finalAnswer([{ role: "user", parts: [text("x")] }], "done")).toBe("");
  });

  it("done: caps the answer at the start", () => {
    const long = "a".repeat(BROWSE_AGENT_ANSWER_MAX_CHARS + 50);
    expect(finalAnswer([assistant(text(long))], "done")).toHaveLength(BROWSE_AGENT_ANSWER_MAX_CHARS);
  });

  it("other status: all assistant text joined, tool parts skipped", () => {
    const messages = [assistant(text("one "), { type: "tool-browse_act" }, text(" two")), assistant(text("three"))];
    for (const status of ["error", "aborted", "step_limit", "timeout"] as const) {
      expect(finalAnswer(messages, status)).toBe("one\n\ntwo\n\nthree");
    }
  });

  it("other status: keeps the END when over the cap", () => {
    const long = "x".repeat(BROWSE_AGENT_ANSWER_MAX_CHARS) + "END";
    const out = finalAnswer([assistant(text(long))], "timeout");
    expect(out).toHaveLength(BROWSE_AGENT_ANSWER_MAX_CHARS);
    expect(out.endsWith("END")).toBe(true);
  });
});

describe("preOpenText", () => {
  it("is today's string", () => {
    expect(preOpenText("Find X", "https://a.test/", '{"url":"https://a.test/"}')).toBe(
      'Find X\n\nThe browser already opened https://a.test/ for you (browse_open). Its result, with a snapshot of the page:\n{"url":"https://a.test/"}',
    );
  });
});

describe("helpers", () => {
  it("caps error messages", () => {
    expect(browseAgentErrorMessage(new Error("e".repeat(500)))).toHaveLength(300);
    expect(browseAgentErrorMessage("plain")).toBe("plain");
  });

  it("goalRequiredResult", () => {
    expect(JSON.stringify(goalRequiredResult())).toBe('{"status":"error","answer":"","steps":0,"error":"goal is required"}');
  });
});
