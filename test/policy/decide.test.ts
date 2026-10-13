import { describe, expect, it, vi } from "vitest";
import { decideStep, locateTarget, planGoal } from "../../src/policy/decide.js";
import type { SystemOneEvaluateParams, SystemOneQuestion } from "../../src/policy/decisions.js";
import {
  browseLocateBodySchema,
  browsePlanBodySchema,
  browseStepBodySchema,
  normalizeScreenshot,
} from "../../src/policy/schemas.js";
import { choice, fakeClient, makeOptions } from "./browseFakes.js";
import { mockJsonModelOnce, textModelCalls } from "./structuredModelFakes.js";

type Captured = SystemOneEvaluateParams<Record<string, SystemOneQuestion>>;

// A plausible JPEG screenshot payload (>= 100 base64 chars, jpeg magic bytes).
const RAW_JPEG = "/9j/" + "A".repeat(120);
const SHOT = `data:image/jpeg;base64,${RAW_JPEG}`;

const stepBody = (overrides: Record<string, unknown> = {}) =>
  browseStepBodySchema.parse({
    goal: "Search for headphones",
    url: "https://shop.example/",
    title: "Shop",
    elements: [{ index: 0, tag: "button", label: "Search", ops: ["CLICK"] }],
    history: [],
    pageText: "Welcome to the shop",
    ...overrides,
  });

const answers = { operation: choice("CLICK", 0.9), click_target: choice("0", 0.9) };

async function run(opts: ReturnType<typeof makeOptions>, bodyOverrides: Record<string, unknown> = {}) {
  let captured: Captured | undefined;
  const result = await decideStep(
    { ...opts, decisions: fakeClient(answers, { capture: (p) => (captured = p) }) },
    stepBody(bodyOverrides),
  );
  return { result, captured };
}

describe("decideStep vision gate", () => {
  it("drops the screenshot for a jev* decision model even with vision: true", async () => {
    const { captured } = await run(makeOptions({ vision: true, decisionModel: "jev-latest" }), {
      screenshot: SHOT,
    });
    // Without an image the ultrafast state is a plain object, not [json, image].
    expect(Array.isArray(captured!.state)).toBe(false);
    expect(JSON.stringify(captured!.state)).not.toContain("image_url");
    for (const q of Object.values(captured!.questions)) {
      expect(q.instructions).not.toHaveProperty("screenshot_note");
    }
  });

  it("matches the jev prefix case-insensitively", async () => {
    const { captured } = await run(makeOptions({ vision: true, decisionModel: "Jev-Ultrafast" }), {
      screenshot: SHOT,
    });
    expect(Array.isArray(captured!.state)).toBe(false);
  });

  it("keeps the screenshot for a vision-capable decision model", async () => {
    const { captured, result } = await run(
      makeOptions({ vision: true, decisionModel: "some-vision-model" }),
      { screenshot: SHOT },
    );
    expect(Array.isArray(captured!.state)).toBe(true);
    const [, image] = captured!.state as [string, unknown];
    expect(image).toEqual({ type: "image_url", image_url: { url: SHOT } });
    expect(result.diag).toMatchObject({ vision: true });
  });

  it("normalises a raw base64 screenshot to a data URL before the policy sees it", async () => {
    const { captured } = await run(makeOptions({ vision: true, decisionModel: "some-vision-model" }), {
      screenshot: RAW_JPEG,
    });
    const [, image] = captured!.state as [string, { image_url: { url: string } }];
    expect(image.image_url.url).toBe(SHOT);
  });

  it("drops a malformed screenshot instead of failing", async () => {
    const { captured, result } = await run(
      makeOptions({ vision: true, decisionModel: "some-vision-model" }),
      { screenshot: "not an image" },
    );
    expect(Array.isArray(captured!.state)).toBe(false);
    expect(result.outcome).toBe("act");
  });

  it("sends no screenshot when vision is off (default)", async () => {
    const { captured } = await run(makeOptions({ decisionModel: "some-vision-model" }), { screenshot: SHOT });
    expect(Array.isArray(captured!.state)).toBe(false);
  });
});

describe("decideStep bot wall", () => {
  it("answers blocked without any decision or text-model call", async () => {
    textModelCalls.mockClear();
    const evaluate = vi.fn();
    const result = await decideStep(
      makeOptions({ decisions: { evaluate } }),
      stepBody({
        url: "https://www.google.com/sorry/index?continue=x",
        elements: [{ index: 2, tag: "div", label: "I'm not a robot", ops: ["CLICK"] }],
        pageText: "Our systems have detected unusual traffic from your computer network.",
      }),
    );
    expect(result.outcome).toBe("blocked");
    expect(result.operation).toBe("BLOCKED");
    expect(result.reason).toMatch(/CAPTCHA/);
    expect(evaluate).not.toHaveBeenCalled();
    expect(textModelCalls).not.toHaveBeenCalled();
  });
});

describe("decideStep policy selection", () => {
  it("defaults to the ultrafast policy", async () => {
    const { captured } = await run(makeOptions());
    expect(Object.keys(captured!.questions)).toContain("operation");
    expect(Object.keys(captured!.questions)).not.toContain("op");
  });

  it("runs the ultrafast policy when asked for it explicitly", async () => {
    const { captured } = await run(makeOptions({ policy: "ultrafast" }));
    expect(Object.keys(captured!.questions)).toContain("operation");
  });

  it("runs the legacy policy for policy: 'legacy'", async () => {
    const { captured } = await run(makeOptions({ policy: "legacy" }));
    expect(Object.keys(captured!.questions)).toContain("op");
    expect(Object.keys(captured!.questions)).not.toContain("operation");
  });

  it("caps the elements it hands to the policy at MAX_SNAPSHOT_ELEMENTS", async () => {
    const elements = Array.from({ length: 150 }, (_, i) => ({
      index: i,
      tag: "button",
      label: `Button ${i}`,
      ops: ["CLICK"],
    }));
    const { captured } = await run(makeOptions({ policy: "legacy" }), { elements });
    expect(JSON.stringify(captured!.state)).not.toContain("Button 149");
  });
});

describe("planGoal / locateTarget", () => {
  it("planGoal plans through the cascade model", async () => {
    const probe = mockJsonModelOnce({ subgoals: ["Add a tent to the cart.", "Add a stove to the cart."] });
    const result = await planGoal(makeOptions(), browsePlanBodySchema.parse({ goal: "Add a tent and a stove" }));
    expect(result.subgoals).toEqual(["Add a tent to the cart.", "Add a stove to the cart."]);
    expect(probe.seenPrompt()).toContain("tent");
  });

  it("locateTarget resolves a description through the decisions client", async () => {
    const body = browseLocateBodySchema.parse({
      description: "the search button",
      operation: "CLICK",
      url: "https://shop.example/",
      title: "Shop",
      elements: [
        { index: 0, tag: "a", label: "Home", ops: ["CLICK"] },
        { index: 1, tag: "button", label: "Search", ops: ["CLICK"] },
      ],
    });
    const result = await locateTarget(
      makeOptions({ decisions: fakeClient({ locate: choice("1", 0.95) }) }),
      body,
    );
    expect(result).toMatchObject({ outcome: "found", index: 1 });
  });
});

describe("schemas", () => {
  it("rejects what the routes rejected", () => {
    expect(browseStepBodySchema.safeParse({ ...stepBody(), goal: "" }).success).toBe(false);
    expect(
      browseStepBodySchema.safeParse({
        ...stepBody(),
        elements: Array.from({ length: 1_001 }, (_, i) => ({ index: i, tag: "a", label: "x", ops: ["CLICK"] })),
      }).success,
    ).toBe(false);
    expect(browsePlanBodySchema.safeParse({ goal: "" }).success).toBe(false);
    expect(browseLocateBodySchema.safeParse({ description: "", operation: "CLICK", url: "u", title: "t", elements: [] }).success).toBe(false);
  });

  it("normalizeScreenshot canonicalises or drops", () => {
    expect(normalizeScreenshot(undefined)).toBeUndefined();
    expect(normalizeScreenshot(RAW_JPEG)).toBe(SHOT);
    expect(normalizeScreenshot(`data:image/PNG;charset=x;base64,${"B".repeat(120)}`)).toBe(
      `data:image/png;base64,${"B".repeat(120)}`,
    );
    expect(normalizeScreenshot("data:image/gif;base64," + "A".repeat(120))).toBeUndefined();
    expect(normalizeScreenshot("short")).toBeUndefined();
  });
});
