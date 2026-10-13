import { describe, expect, it } from "vitest";
import { decideBrowseLocate } from "../src/ai/browseLocate.js";
import { PEAK_THRESHOLD_TARGET, type BrowseStepElement } from "../src/ai/browseStep.js";
import type {
  SystemOneAnswer,
  SystemOneClient,
  SystemOneEvaluateParams,
  SystemOneQuestion,
} from "../src/services/systemone.js";
import { fakeClient as fakeSystemOneClient, choice } from "./browseFakes.js";

// Mirrors test/browse-step.test.ts's fixtures — decideBrowseLocate is a
// one-shot sibling of decideBrowseStep, sharing element caps/scrubbing and
// target-criterion rendering with it (see browseLocate.ts's header). Unlike
// browse-step, decideBrowseLocate only ever asks a single `locate`
// question, so this thin adapter wraps the shared multi-answer fake.
function fakeClient(
  answer: SystemOneAnswer,
  opts: {
    model?: string;
    capture?: (params: SystemOneEvaluateParams<Record<string, SystemOneQuestion>>) => void;
    throwError?: Error;
  } = {},
): SystemOneClient {
  return fakeSystemOneClient({ locate: answer }, opts);
}

const continueButton: BrowseStepElement = {
  index: 3,
  tag: "button",
  label: "Continue",
  ops: ["CLICK"],
};
const searchBox: BrowseStepElement = {
  index: 5,
  tag: "input",
  label: "Search",
  ops: ["TYPE_TEXT"],
};
const passwordInput: BrowseStepElement = {
  index: 9,
  tag: "input",
  label: "Password",
  isPassword: true,
  ops: ["TYPE_TEXT"],
};
const menuTrigger: BrowseStepElement = {
  index: 11,
  tag: "a",
  label: "Account",
  ops: ["CLICK"],
};

function baseInput(
  elements: BrowseStepElement[],
  overrides: Partial<{
    description: string;
    operation: "CLICK" | "TYPE_TEXT" | "SELECT" | "HOVER" | "FOCUS";
  }> = {},
) {
  return {
    description: overrides.description ?? "the Continue button",
    operation: overrides.operation ?? ("CLICK" as const),
    url: "https://example.com",
    title: "Example",
    elements,
  };
}

describe("decideBrowseLocate", () => {
  it("resolves to the found element's index/label/confidence on a confident match", async () => {
    const client = fakeClient(choice("3", 0.9));
    const result = await decideBrowseLocate(client, baseInput([continueButton]));
    expect(result).toMatchObject({ outcome: "found", index: 3, label: "Continue", confidence: 0.9 });
  });

  it("sends a single Choice question keyed by element index, with the description in its instructions", async () => {
    let captured: SystemOneEvaluateParams<Record<string, SystemOneQuestion>> | undefined;
    const client = fakeClient(choice("3", 0.9), { capture: (p) => (captured = p) });
    await decideBrowseLocate(
      client,
      baseInput([continueButton, searchBox], { description: "the Continue button" }),
    );
    expect(captured).toBeDefined();
    const questions = captured!.questions as Record<string, { type: string; instructions: string; criteria: Record<string, unknown> }>;
    expect(Object.keys(questions)).toEqual(["locate"]);
    expect(questions.locate!.type).toBe("choice");
    expect(questions.locate!.instructions).toContain("the Continue button");
    // Only CLICK-capable candidates for a CLICK lookup.
    expect(questions.locate!.criteria).toHaveProperty("3");
    expect(questions.locate!.criteria).not.toHaveProperty("5");
  });

  it("HOVER reuses the CLICK candidate set (elements never carry a HOVER op)", async () => {
    let captured: SystemOneEvaluateParams<Record<string, SystemOneQuestion>> | undefined;
    const client = fakeClient(choice("11", 0.9), { capture: (p) => (captured = p) });
    const result = await decideBrowseLocate(
      client,
      baseInput([menuTrigger, searchBox], { operation: "HOVER", description: "the account menu" }),
    );
    expect(result).toMatchObject({ outcome: "found", index: 11 });
    const questions = captured!.questions as Record<string, { criteria: Record<string, unknown> }>;
    expect(questions.locate!.criteria).toHaveProperty("11");
    expect(questions.locate!.criteria).not.toHaveProperty("5");
  });

  it("returns not_found with zero candidates, without calling evaluate()", async () => {
    let called = false;
    const client: SystemOneClient = {
      async evaluate(_params) {
        called = true;
        throw new Error("should not be called");
      },
    };
    const result = await decideBrowseLocate(
      client,
      baseInput([searchBox], { operation: "CLICK", description: "a button that doesn't exist" }),
    );
    expect(result.outcome).toBe("not_found");
    expect(called).toBe(false);
  });

  it("returns not_found when the peak probability is below PEAK_THRESHOLD_TARGET", async () => {
    const belowTarget = PEAK_THRESHOLD_TARGET - 0.05;
    const client = fakeClient(choice("3", belowTarget));
    const result = await decideBrowseLocate(client, baseInput([continueButton, menuTrigger]));
    expect(result.outcome).toBe("not_found");
    expect((result as { confidence: number }).confidence).toBeCloseTo(belowTarget);
  });

  it("refuses to resolve a TYPE_TEXT description to a password field", async () => {
    const client = fakeClient(choice("9", 0.9));
    const result = await decideBrowseLocate(
      client,
      baseInput([passwordInput], { operation: "TYPE_TEXT", description: "the password field" }),
    );
    expect(result.outcome).toBe("not_found");
    expect((result as { reason: string }).reason).toContain("password");
  });

  it("resolves to retry on a Jev transport failure", async () => {
    const client = fakeClient(choice("3", 0.9), { throwError: new Error("ECONNRESET") });
    const result = await decideBrowseLocate(client, baseInput([continueButton]));
    expect(result.outcome).toBe("retry");
  });

  it("resolves to retry on a malformed answer type", async () => {
    const client = fakeClient({ type: "noul", noul: 0.9 } as SystemOneAnswer);
    const result = await decideBrowseLocate(client, baseInput([continueButton]));
    expect(result.outcome).toBe("retry");
  });

  it("resolves to retry when Jev picks an unknown element index", async () => {
    const client = fakeClient(choice("999", 0.9));
    const result = await decideBrowseLocate(client, baseInput([continueButton]));
    expect(result.outcome).toBe("retry");
  });

  describe("FOCUS", () => {
    it("accepts elements with ANY of CLICK/TYPE_TEXT/SELECT as candidates", async () => {
      let captured: SystemOneEvaluateParams<Record<string, SystemOneQuestion>> | undefined;
      const client = fakeClient(choice("5", 0.9), { capture: (p) => (captured = p) });
      const result = await decideBrowseLocate(
        client,
        baseInput([continueButton, searchBox], { operation: "FOCUS", description: "the search box" }),
      );
      expect(result).toMatchObject({ outcome: "found", index: 5 });
      const questions = captured!.questions as Record<string, { criteria: Record<string, unknown> }>;
      expect(questions.locate!.criteria).toHaveProperty("3");
      expect(questions.locate!.criteria).toHaveProperty("5");
    });

    it("refuses to resolve a FOCUS description onto a password field", async () => {
      const client = fakeClient(choice("9", 0.9));
      const result = await decideBrowseLocate(
        client,
        baseInput([passwordInput], { operation: "FOCUS", description: "the password field" }),
      );
      expect(result.outcome).toBe("not_found");
      expect((result as { reason: string }).reason).toContain("password");
    });
  });

  describe("the 'none' criterion", () => {
    it("includes a 'none' criterion alongside the element indices", async () => {
      let captured: SystemOneEvaluateParams<Record<string, SystemOneQuestion>> | undefined;
      const client = fakeClient(choice("3", 0.9), { capture: (p) => (captured = p) });
      await decideBrowseLocate(client, baseInput([continueButton]));
      const questions = captured!.questions as Record<string, { criteria: Record<string, unknown> }>;
      expect(questions.locate!.criteria).toHaveProperty("none");
      expect(questions.locate!.criteria).not.toHaveProperty("3", undefined);
    });

    it("resolves to not_found when 'none' wins the Choice, even above the peak threshold", async () => {
      const client = fakeClient(choice("none", 0.9));
      const result = await decideBrowseLocate(
        client,
        baseInput([continueButton, menuTrigger], { description: "a button that doesn't exist" }),
      );
      expect(result.outcome).toBe("not_found");
    });

    it("resolves to not_found (not retry) when 'none' wins a small candidate set", async () => {
      const client = fakeClient(choice("none", 0.75, { probabilities: { "3": 0.25, none: 0.75 } }));
      const result = await decideBrowseLocate(client, baseInput([continueButton]));
      expect(result.outcome).toBe("not_found");
    });
  });
});

describe("disabled elements", () => {
  it("never treats a disabled element as a candidate", async () => {
    let called = false;
    const client = fakeClient(choice("3", 0.9), { capture: () => (called = true) });
    const result = await decideBrowseLocate(client, baseInput([{ ...continueButton, disabled: true }]));
    expect(result.outcome).toBe("not_found");
    expect(called).toBe(false);
  });
});
