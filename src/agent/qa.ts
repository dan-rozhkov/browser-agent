// The zod part of QA mode: the schema and definition of `qa_verdict`. The rest
// (hooks, outcome, recorder, prompt section) is the zod-free core in qaCore.ts,
// re-exported here so `agent` keeps one QA surface. Imports `zod` (no `ai`, no `node:*`).
import { z } from "zod";
import type { QaVerdict } from "./qaCore.js";
import { REASON_MAX_CHARS } from "./qaCore.js";

export * from "./qaCore.js";

export const qaVerdictSchema = z.object({
  verdict: z.enum(["pass", "fail"]).describe('"pass" when the app behaves as the scenario expects, "fail" when it does not.'),
  reason: z.string().trim().min(1).max(REASON_MAX_CHARS).describe("One or two sentences: what you expected and what you saw."),
});

// The schema and the hand check in qaCore.ts must describe the same type (type-only, no emitted code).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
type AssertTrue<T extends true> = T;
export type QaVerdictTypesAgree = AssertTrue<Same<QaVerdict, z.infer<typeof qaVerdictSchema>>>;

/** The description and input schema of `qa_verdict`. */
export const qaVerdictDefinition = {
  description: "Give the verdict of this test scenario. Call it exactly once, at the end, after you checked the expected result on the page.",
  inputSchema: qaVerdictSchema,
};
