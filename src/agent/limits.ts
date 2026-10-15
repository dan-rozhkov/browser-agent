// Limits of one browse-agent run. Same values Pen Editor's browse_agent uses.

/** Chat-side timeout of a host that wraps the run in a tool call (Pen Editor: useDesignChat). */
export const BROWSE_AGENT_OUTER_TIMEOUT_MS = 15 * 60_000;
/** How far below the outer timeout the run's own deadline sits, so the run
 * returns a partial result before the outer layer discards everything. */
export const BROWSE_AGENT_DEADLINE_MARGIN_MS = 60_000;
/** The run's own deadline (derived, so the two cannot drift). */
export const BROWSE_AGENT_DEADLINE_MS =
  BROWSE_AGENT_OUTER_TIMEOUT_MS - BROWSE_AGENT_DEADLINE_MARGIN_MS;
/** Max model requests (first send + automatic continuations) per run. */
export const BROWSE_AGENT_MAX_REQUESTS = 60;
/** Max characters of the answer. */
export const BROWSE_AGENT_ANSWER_MAX_CHARS = 8000;
/** Max characters of an error message. */
export const BROWSE_AGENT_ERROR_MAX_CHARS = 300;
