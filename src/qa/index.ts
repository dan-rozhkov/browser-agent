// `@sideform/browser-agent/qa` — run QA scenarios with parallel browse agents
// and return one typed report. Imports `ai` (through `runBrowseAgent`) but no `node:*`:
// the suite writes no files: what to do with the report is the host's choice. Playwright is NOT imported here:
// build `openBrowser` with `playwrightContexts` from `adapters/playwright`.
export { runQaSuite, QA_PROMPT_SECTION, QA_VERDICT_TOOL } from "./suite.js";
export { QA_STEP_TEXT_MAX_CHARS } from "./steps.js";
export { QA_ID_PATTERN, checkQaIds } from "./ids.js";
export type * from "./types.js";
