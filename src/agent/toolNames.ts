// The seven tool names. Kept apart from tools.ts so the zod-free
// `agent/session` entry can use them without pulling schemas.

/** The seven tools the browse agent drives the browser with. */
export const BROWSE_AGENT_TOOL_NAMES = [
  "browse_open",
  "browse_snapshot",
  "browse_screenshot",
  "browse_act",
  "browse_tabs",
  "browse_find_images",
  "browse_read",
] as const;

export type BrowseAgentToolName = (typeof BROWSE_AGENT_TOOL_NAMES)[number];
