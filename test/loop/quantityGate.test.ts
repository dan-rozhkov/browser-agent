import { describe, expect, it } from "vitest";
import { createQuantityGate, parseTarget } from "../../src/loop/quantityGate.js";

const eff = (body: string) => `Add → effect: ${body}`;
const appeared = (t: string) => eff(`appeared: "${t}"`);
const RED = "https://shop.test/p?color=red#top";
const BLUE = "https://shop.test/p?color=blue";

describe("quantity gate state", () => {
  it("keeps the query string (variants are separate targets) and drops the hash", () => {
    const gate = createQuantityGate(2);
    const at = { url: RED, label: "Add" };
    gate.observe(at, appeared("Bag, 1 items"));
    gate.observe(at, eff("counter 1→2"));
    expect(gate.blockedReason("https://shop.test/p?color=red", "Add")).not.toBeNull();
    expect(gate.blockedReason(BLUE, "Add")).toBeNull();
  });

  it("aliases a relabel: the old label finds the state again", () => {
    const gate = createQuantityGate(2);
    gate.observe({ url: RED, label: "Add to bag" }, appeared("Bag, 1 items"));
    gate.observe({ url: RED, label: "Add to bag" }, eff("counter 1→2"), { old: "Add to bag", new: "Add to bag ✓" });
    expect(gate.blockedReason(RED, "Add to bag ✓")).not.toBeNull();
    expect(gate.blockedReason(RED, "Add to bag")).not.toBeNull();
  });

  it("infers the first unit only from the click right before the first counter", () => {
    const stale = createQuantityGate(2);
    const at = { url: RED, label: "Add" };
    stale.observe(at, appeared("Bag, 1 items"));
    stale.observe(at, appeared("Please select a size"));
    stale.observe(at, eff("counter 1→2"));
    expect(stale.blockedReason(RED, "Add")).toBeNull();

    const direct = createQuantityGate(2);
    direct.observe(at, appeared("Please select a size"));
    direct.observe(at, appeared("Bag, 1 items"));
    direct.observe(at, eff("counter 1→2"));
    expect(direct.blockedReason(RED, "Add")).toBe("quantity 2 reached (counter 1→2)");
  });

  it.each([
    ["Only 1 left — choose a size", false],
    ["Bag (1)", true],
    ["Bag, 1 items", true],
    ["Cart 1 product", true],
    ["Qty × 1", true],
    ["Step 1 of 3", false],
  ])("N=1 first appeared %j arms the gate: %s", (text, armed) => {
    const gate = createQuantityGate(1);
    gate.observe({ url: RED, label: "Add" }, appeared(text));
    expect(gate.blockedReason(RED, "Add") !== null).toBe(armed);
  });

  it("absolute target: a counter ending at N counts even without earlier units", () => {
    const gate = createQuantityGate(3, true);
    const at = { url: RED, label: "Increase" };
    gate.observe(at, eff("counter 2→3"));
    expect(gate.blockedReason(RED, "Increase")).toBe("quantity 3 reached (counter 2→3)");
    const delta = createQuantityGate(3, false);
    delta.observe(at, eff("counter 2→3"));
    expect(delta.blockedReason(RED, "Increase")).toBeNull();
  });
});

describe("parseTarget", () => {
  it("marks absolute phrases", () => {
    expect(parseTarget("Set quantity to 3", "")).toEqual({ quantity: 3, absolute: true });
    expect(parseTarget("Set the number of units to 4", "")).toEqual({ quantity: 4, absolute: true });
    expect(parseTarget("Add 2 units", "")).toEqual({ quantity: 2, absolute: false });
    expect(parseTarget("Add a quantity of 3", "")).toEqual({ quantity: 3, absolute: false });
  });
});
