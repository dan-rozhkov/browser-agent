import { MockLanguageModelV3 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import { planGoal } from "../../src/policy/decide.js";
import { browsePlanBodySchema } from "../../src/policy/schemas.js";
import { makeOptions } from "./browseFakes.js";
import { textModelCalls, jsonModel, mockJsonModelOnce } from "./structuredModelFakes.js";
const { MAX_SUBGOALS, MAX_SUBGOAL_CHARS, MAX_GOAL_CHARS, buildPlanPrompt, normalizeSubgoals, isReadOnlySubgoal, dropReadOnlySubgoals } = await import("../../src/policy/browsePlan.js");

const GOAL = "Add a tent, a sleeping bag and a pad to the cart";

beforeEach(() => {
  textModelCalls.mockReset();
});

// What POST /api/browse/plan did around planBrowseGoal: validate the body
// (400 on failure), plan, answer { subgoals } without `fallbackReason`.
async function postPlan(payload: Record<string, unknown>, opts = makeOptions()) {
  const parsed = browsePlanBodySchema.safeParse(payload);
  if (!parsed.success) {
    return { statusCode: 400, json: () => ({ error: parsed.error.issues[0]?.message ?? "invalid body" }) as { subgoals: string[]; error?: string } };
  }
  const { subgoals } = await planGoal(opts, parsed.data);
  return { statusCode: 200, json: () => ({ subgoals }) };
}

describe("planGoal (was POST /api/browse/plan)", () => {
  it.each([
    ["an empty goal", { goal: "" }],
    ["a goal over the limit", { goal: "a".repeat(MAX_GOAL_CHARS + 1) }],
    ["a url over 4000 characters", { goal: GOAL, url: "u".repeat(4_001) }],
    ["a missing goal", {}],
  ])("400s on %s", async (_name, payload) => {
    expect((await postPlan(payload)).statusCode).toBe(400);
    expect(textModelCalls).not.toHaveBeenCalled();
  });

  it("lets the planner choose the items when the goal asks it to, but never personal data", () => {
    const prompt = buildPlanPrompt("Build a cart with everything needed for a 2-day hike", undefined);
    expect(prompt).toMatch(/goal may ask you to choose them/);
    expect(prompt).toMatch(/Never invent personal data/);
  });

  it("asks for typed text in the site's language, in double quotes", () => {
    const prompt = buildPlanPrompt("Find milk", "https://shop.example.gr");
    expect(prompt).toContain("Text the agent will TYPE into the site");
    expect(prompt).toContain(".gr means Greek");
    expect(prompt).toContain("double quotes");
    expect(prompt).toContain("Never translate or transliterate proper names");
    expect(prompt).not.toContain("otherwise write it in English");
  });

  it("asks for a checkable Done when / Does not count clause per sub-goal", () => {
    const prompt = buildPlanPrompt("Add three different items to a cart", undefined);
    expect(prompt).toContain("Done when:");
    expect(prompt).toContain("Does not count:");
  });

  it("strips Does not count, then Done when, from an over-long sub-goal", () => {
    const base = "Add a tent to the cart.";
    const dwhen = " Done when: the tent is in the cart.";
    const dnc = ` Does not count: ${"x".repeat(MAX_SUBGOAL_CHARS)}`;
    expect(normalizeSubgoals([base + dwhen + dnc])).toEqual([base + dwhen]);
    const longDone = ` Done when: ${"y".repeat(MAX_SUBGOAL_CHARS)}`;
    expect(normalizeSubgoals([base + longDone + " Does not count: z"])).toEqual([base]);
    expect(normalizeSubgoals(["w".repeat(MAX_SUBGOAL_CHARS + 1)])).toBeNull();
  });

  it("never asks for a read-only or final-report sub-goal", () => {
    const prompt = buildPlanPrompt("Find the first three results and report their prices", undefined);
    expect(prompt).not.toMatch(/final report[^\n]*own LAST sub-goal/);
    expect(prompt).toMatch(/reporting values is NEVER a sub-goal/);
    expect(prompt).toMatch(/several results of ONE search or list[^\n]*single flow/);
    // A report that needs a page no sub-goal reaches gets an action that opens it.
    expect(prompt).toMatch(/LAST sub-goal an action that opens that page/);
    expect(prompt).not.toMatch(/starts with[^\n]*Reply/);
  });

  it("tests only the first word for a read-only verb", () => {
    for (const s of [
      "Report: the 3 shops",
      "note the name of the first result",
      "Read the first listing. Report its price.",
      "Write down the total",
      "  - Extract the prices",
      "Reply with the title",
      "1. Report the prices",
      "2) Note the first price",
      "Step 3: Summarize the reviews",
      "Identify the second restaurant from the search results that has a free slot",
    ]) {
      expect(isReadOnlySubgoal(s), s).toBe(true);
    }
    for (const s of [
      "Open the first listing. Report its price.",
      "Reply to the message",
      "Answer the survey question",
      "Return to the results",
      "List the bike for sale",
      "State/Province: select California",
      "Note: accept cookies first, then add the tent to the cart",
      "Read and accept the terms, then tick the checkbox",
      "Writer filter: pick Tolkien",
      "1. Search for flats",
      "Identify and open the cheapest listing",
    ]) {
      expect(isReadOnlySubgoal(s), s).toBe(false);
    }
  });

  it("drops read-only sub-goals and keeps a real split", async () => {
    const plan = ["Add a tent to the cart.", "Add a pad to the cart.", "Report the cart total."];
    expect(dropReadOnlySubgoals(plan)).toEqual(plan.slice(0, 2));
    textModelCalls.mockImplementationOnce(() => jsonModel({ subgoals: plan }));
    const res = await postPlan({ goal: GOAL });
    expect(res.json()).toEqual({ subgoals: plan.slice(0, 2) });
  });

  it("falls back to the whole goal when one action sub-goal is left", async () => {
    const goal = "Search for flats near the station and list the first three prices";
    textModelCalls.mockImplementationOnce(() =>
      jsonModel({ subgoals: ["Search for flats near the station.", "Note the first price.", "Note the second price.", "Report the prices."] }),
    );
    const res = await postPlan({ goal });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ subgoals: [goal] });
  });

  it("returns a single-flow goal unchanged", async () => {
    textModelCalls.mockImplementationOnce(() => jsonModel({ subgoals: ["Book one hotel in Rome"] }));
    const res = await postPlan({ goal: "Book one hotel in Rome" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ subgoals: ["Book one hotel in Rome"] });
  });

  it("passes multi-item output through, trimmed, deduped and capped", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ` item ${i} `);
    const probe = mockJsonModelOnce({
      subgoals: ["", "  ", "  second  ", "second", ...many],
    });
    const res = await postPlan({ goal: GOAL, url: "https://shop.example" });
    const { subgoals } = res.json();
    expect(res.statusCode).toBe(200);
    expect(subgoals).toHaveLength(MAX_SUBGOALS);
    expect(subgoals[0]).toBe("second");
    expect(subgoals[1]).toBe("item 0");
    expect(probe.seenPrompt()).toContain("https://shop.example");
    expect(probe.seenSignal()).toBeDefined();
  });

  it("falls back to [goal] when the model throws", async () => {
    textModelCalls.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const res = await postPlan({ goal: GOAL });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ subgoals: [GOAL] });
  });

  it("falls back to [goal] when the output is empty", async () => {
    textModelCalls.mockImplementationOnce(() => jsonModel({ subgoals: ["", " "] }));
    expect((await postPlan({ goal: GOAL })).json()).toEqual({ subgoals: [GOAL] });
  });

  it("falls back to [goal] when the abort signal fires mid-call", async () => {
    // The fake model only settles when the signal it was handed aborts, so
    // this hangs (and times out) if planBrowseGoal stops passing abortSignal.
    textModelCalls.mockImplementationOnce(
      () =>
        new MockLanguageModelV3({
          doGenerate: (options: { abortSignal?: AbortSignal }) =>
            new Promise((_, reject) => {
              options.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")));
            }),
        }),
    );
    const { planBrowseGoal } = await import("../../src/policy/browsePlan.js");
    const result = await planBrowseGoal(makeOptions(), { goal: GOAL }, AbortSignal.timeout(50));
    expect(result.subgoals).toEqual([GOAL]);
    expect(result.fallbackReason).toBe("aborted");
  });

  it("falls back to [goal] instead of cutting an over-long sub-goal", async () => {
    textModelCalls.mockImplementationOnce(() =>
      jsonModel({ subgoals: ["ok", "x".repeat(MAX_SUBGOAL_CHARS + 1)] }),
    );
    expect((await postPlan({ goal: GOAL })).json()).toEqual({ subgoals: [GOAL] });
  });

  it("passes irreversible tags from the goal through, and scrubs the url", async () => {
    const goal = "Pay with card 4111 1111 1111 1111 for a tent and a stove";
    const { buildNumberedPlaceholderGoal } = await import("../../src/policy/browseStep.js");
    const tag = buildNumberedPlaceholderGoal(goal).text.match(/\[[A-Z_]+\]/)?.[0];
    expect(tag).toBeDefined();
    const probe = mockJsonModelOnce({ subgoals: [`Buy a tent, pay with ${tag}`, `Buy a stove, pay with ${tag}`] });
    const res = await postPlan({ goal, url: "https://shop.example/?e=ann@example.com" });
    expect(res.json().subgoals[0]).toContain(tag);
    expect(probe.seenPrompt()).not.toContain("ann@example.com");
  });

  it("sends PII as tokens and restores them in the output", async () => {
    const goal = "Sign up two accounts, one with ann@example.com and one with bob@example.com";
    const probe = mockJsonModelOnce({
      subgoals: ["Sign up with [EMAIL_1]", "Sign up with [EMAIL_2]"],
    });
    const res = await postPlan({ goal });
    expect(probe.seenPrompt()).not.toContain("ann@example.com");
    expect(probe.seenPrompt()).toContain("[EMAIL_1]");
    expect(res.json()).toEqual({
      subgoals: ["Sign up with ann@example.com", "Sign up with bob@example.com"],
    });
  });

  it("falls back when the model invents an unknown token", async () => {
    textModelCalls.mockImplementationOnce(() => jsonModel({ subgoals: ["Use [EMAIL_9]"] }));
    expect((await postPlan({ goal: GOAL })).json()).toEqual({ subgoals: [GOAL] });
  });
});
