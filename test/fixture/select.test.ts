// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { applyFixture, applyParsedFixture, fixtureBudgetMs } from "../../src/fixture/apply.js";
import { parsePageFixture } from "../../src/fixture/parse.js";
import { fakeTarget } from "./fakes.js";

const SECRET = "sentinel-option-value-9f3";

beforeEach(() => {
  document.body.innerHTML = "";
  Element.prototype.scrollIntoView = function () {};
});

function domTarget() {
  const target = fakeTarget({ exec: (code) => (0, eval)(code) });
  delete target.pages.get(1)!.sendCdp;
  return target;
}

describe("FixtureStep select: parse", () => {
  it("accepts selector + value (the value may be empty)", () => {
    expect(parsePageFixture({ version: 1, steps: [{ action: "select", selector: "#s", value: "l" }, { action: "select", selector: "#s", value: "" }] })).toEqual({
      ok: true,
      value: { version: 1, steps: [{ action: "select", selector: "#s", value: "l" }, { action: "select", selector: "#s", value: "" }] },
    });
  });

  it("rejects a missing selector or a non-string value, naming the path and not the value", () => {
    expect(parsePageFixture({ version: 1, steps: [{ action: "select", value: "l" }] })).toEqual({ ok: false, error: "fixture.steps[0].selector must be a string" });
    expect(parsePageFixture({ version: 1, steps: [{ action: "select", selector: "#s", value: 3 }] })).toEqual({ ok: false, error: "fixture.steps[0].value must be a string" });
  });

  it("the unknown-action error lists select", () => {
    const r = parsePageFixture({ version: 1, steps: [{ action: "drag" }] });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain("select");
  });
});

describe("FixtureStep select: apply", () => {
  it("sets the option by value through the native setter and fires input then change", async () => {
    document.body.innerHTML = '<select id="size"><option value="s">Small</option><option value="l">Large</option></select>';
    const select = document.getElementById("size") as HTMLSelectElement;
    const events: string[] = [];
    for (const type of ["input", "change"]) select.addEventListener(type, () => events.push(`${type}:${select.value}`));
    const r = await applyFixture(domTarget(), { version: 1, steps: [{ action: "select", selector: "#size", value: "l" }] });
    expect(r.ok).toBe(true);
    expect(select.value).toBe("l");
    expect(events).toEqual(["input:l", "change:l"]);
  });

  it("fails when the element is not a select, with no value in the error", async () => {
    document.body.innerHTML = '<input id="x">';
    const r = await applyFixture(domTarget(), { version: 1, steps: [{ action: "select", selector: "#x", value: SECRET }] });
    expect(r).toEqual({ ok: false, stage: "steps", error: "step 1 (select #x) failed: element is not a select" });
  });

  it("fails when no option has the value, with no value in the error", async () => {
    document.body.innerHTML = '<select id="size"><option value="s">Small</option></select>';
    const r = await applyFixture(domTarget(), { version: 1, steps: [{ action: "select", selector: "#size", value: SECRET }] });
    expect(r).toEqual({ ok: false, stage: "steps", error: "step 1 (select #size) failed: no option has the given value" });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect((document.getElementById("size") as HTMLSelectElement).value).toBe("s");
  });

  it("a missing element and a bad selector fail like the other steps", async () => {
    expect(await applyFixture(domTarget(), { version: 1, steps: [{ action: "select", selector: "#nope", value: "a" }] })).toEqual({
      ok: false, stage: "steps", error: "step 1 (select #nope) failed: element not found",
    });
    expect(await applyFixture(domTarget(), { version: 1, steps: [{ action: "select", selector: "##", value: "a" }] })).toMatchObject({ ok: false, error: "step 1 (select ##) failed: invalid selector" });
  });

  it("the success summary counts the step and never shows the value", async () => {
    document.body.innerHTML = `<select id="size"><option value="${SECRET}">X</option></select>`;
    const r = await applyFixture(domTarget(), { version: 1, steps: [{ action: "select", selector: "#size", value: SECRET }] });
    expect(r).toMatchObject({ ok: true, summary: "1 setup step" });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("is part of the budget like a script step", () => {
    const base = fixtureBudgetMs({ version: 1, steps: [] });
    expect(fixtureBudgetMs({ version: 1, steps: [{ action: "select", selector: "#a", value: "b" }] })).toBeGreaterThan(base);
  });
});

describe("FixtureStep select: settle and budget", () => {
  it("runs through the host's settled hook, like a click and a key press", async () => {
    document.body.innerHTML = '<select id="size"><option value="s">Small</option><option value="l">Large</option></select>';
    const parsed = parsePageFixture({ version: 1, steps: [{ action: "select", selector: "#size", value: "l" }] });
    if (!parsed.ok) throw new Error(parsed.error);
    const seen: string[] = [];
    const r = await applyParsedFixture(domTarget(), parsed.value, {}, {
      settled: async (_page, action) => {
        seen.push("settle:start");
        const outcome = await action();
        seen.push("settle:end");
        return outcome;
      },
    });
    expect(r.ok).toBe(true);
    expect((document.getElementById("size") as HTMLSelectElement).value).toBe("l");
    expect(seen).toEqual(["settle:start", "settle:end"]);
  });

  it("the budget counts a settle for a select step, like for a click", () => {
    const select = { version: 1 as const, steps: [{ action: "select" as const, selector: "#s", value: "l" }] };
    const click = { version: 1 as const, steps: [{ action: "click" as const, selector: "#s" }] };
    expect(fixtureBudgetMs(select)).toBe(fixtureBudgetMs(click));
    expect(fixtureBudgetMs(select, { settleMs: 40_000 })).toBe(fixtureBudgetMs({ version: 1 }) + 10_000 + 40_000);
  });
});
