// The zod part of QA mode: the schema and definition of `qa_verdict`. The rest
// (hooks, outcome, recorder, prompt section) is the zod-free core in qaCore.ts,
// re-exported here so `agent` keeps one QA surface. Imports `zod` (no `ai`, no `node:*`).
import { z } from "zod";
import type { QaJudgeVerdict, QaVerdict } from "./qaCore.js";
import { QA_CHECKS_MAX, QA_CHECK_STRING_MAX_CHARS, REASON_MAX_CHARS, normalizeQaChecks } from "./qaCore.js";
import type { QaCheck } from "./qaTypes.js";

export * from "./qaCore.js";

export const qaVerdictSchema = z.object({
  verdict: z.enum(["pass", "fail"]).describe('"pass" when the app behaves as the scenario expects, "fail" when it does not.'),
  reason: z.string().trim().min(1).max(REASON_MAX_CHARS).describe("One or two sentences: what you expected and what you saw."),
});

// The schema and the hand check in qaCore.ts must describe the same type (type-only, no emitted code).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
type AssertTrue<T extends true> = T;
export type QaVerdictTypesAgree = AssertTrue<Same<QaVerdict, z.infer<typeof qaVerdictSchema>>>;

/** The answer of the QA judge model (`runBrowseAgent({ qa: { judge } })`). */
export const qaJudgeSchema = z.object({
  verdict: z.enum(["pass", "fail", "inconclusive"]).describe('"pass" when the evidence shows every expected result, "fail" when a result is absent or wrong, "inconclusive" when the evidence is not enough.'),
  // No max: a long reason is cut by `parseQaJudgeVerdict`, not rejected, so a verbose `fail` is not lost.
  reason: z.string().trim().min(1).describe("One or two sentences: what the scenario expects and what the evidence shows."),
});
export type QaJudgeTypesAgree = AssertTrue<Same<QaJudgeVerdict, z.infer<typeof qaJudgeSchema>>>;

/** The description and input schema of `qa_verdict`. */
export const qaVerdictDefinition = {
  description: "Give the verdict of this test scenario. Call it exactly once, at the end, after you checked the expected result on the page.",
  inputSchema: qaVerdictSchema,
};

const checkString = () => z.string().max(QA_CHECK_STRING_MAX_CHARS);
const selectorDescribe = "CSS selector of the element. Give this or `index`.";
const indexDescribe = "Element number from the latest browse_snapshot. Give this or `selector`.";
const ignoreDescribe = "Entries that contain one of these substrings do not count.";

/** One check of `qa_assert`. The strict rules (a locator, a comparator, a valid regex) are in `parseQaChecks`. */
export const qaCheckSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: checkString().min(1).describe("Text to look for in the visible text of the page. Case-insensitive."),
    absent: z.boolean().optional().describe("false (default): the text must be on the page. true: the text must NOT be on the page."),
  }),
  z.object({
    type: z.literal("element"),
    selector: checkString().optional().describe(selectorDescribe),
    index: z.number().int().min(0).optional().describe(indexDescribe),
    state: z.enum(["visible", "hidden", "exists", "absent", "enabled", "disabled", "checked", "unchecked"]).describe("The state the element must have."),
  }),
  z.object({
    type: z.literal("value"),
    selector: checkString().optional().describe(selectorDescribe),
    index: z.number().int().min(0).optional().describe(indexDescribe),
    equals: checkString().optional().describe("The exact value of the input, textarea or select."),
    contains: checkString().optional().describe("A part of the value."),
  }),
  z.object({
    type: z.literal("count"),
    selector: checkString().min(1).describe("CSS selector of the elements to count."),
    equals: z.number().int().min(0).optional().describe("The exact number of matches."),
    min: z.number().int().min(0).optional().describe("The least number of matches."),
    max: z.number().int().min(0).optional().describe("The most matches."),
  }),
  z.object({
    type: z.literal("url"),
    equals: checkString().optional().describe("The exact URL of the page."),
    contains: checkString().optional().describe("A part of the URL."),
    matches: checkString().optional().describe("A JavaScript regular expression source, for example `/orders/\\d+$`."),
  }),
  z.object({ type: z.literal("no_console_errors"), ignore: z.array(checkString()).max(50).optional().describe(ignoreDescribe) }),
  z.object({ type: z.literal("no_failed_requests"), ignore: z.array(checkString()).max(50).optional().describe(ignoreDescribe) }),
]);

export const qaAssertSchema = z.object({
  // Like browse_act: strict-mode placeholders ("", null, []) are removed before validation (`normalizeQaChecks`).
  checks: z.preprocess(normalizeQaChecks, z.array(qaCheckSchema).min(1).max(QA_CHECKS_MAX)).describe(`One to ${QA_CHECKS_MAX} checks. All of them run at once.`),
});

// The schema and the hand parser (`parseQaChecks`) must describe the same type (type-only, no emitted code).
export type QaCheckTypesAgree = AssertTrue<Same<QaCheck, z.infer<typeof qaCheckSchema>>>;

/** The description and input schema of `qa_assert`. */
export const qaAssertDefinition = {
  description:
    "Check the page against exact conditions. Use it to confirm an expected result before the verdict. A check is one of: `text` (visible text is present or absent), `element` (a CSS selector or a snapshot index is visible, hidden, exists, absent, enabled, disabled, checked or unchecked), `value` (the value of an input equals or contains a string), `count` (the number of elements that match a selector), `url` (the page URL equals, contains or matches), `no_console_errors` and `no_failed_requests` (nothing failed during the whole run). Returns `{ passed, results }`: one result per check, with `actual` when a check fails. A failed check does not end the test, so you can look at the page and try again. Does not change the page.",
  inputSchema: qaAssertSchema,
};
