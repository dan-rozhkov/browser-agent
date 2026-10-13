import { describe, expect, it } from "vitest";
import { appendKeepingSuffix, describeEffect, describeEffectDetailed, EFFECT_NOTE_MAX_CHARS, fitLabel, isCommitEffect, stripVolatileLabelParts } from "../actionEffect";

const btn = (index: number, label: string, extra: Record<string, unknown> = {}) => ({
  index,
  tag: "button",
  label,
  ...extra,
});
const snap = (elements: unknown[], extra: Record<string, unknown> = {}) => ({ url: "https://shop.test/p", elements, ...extra });
const acted = (label: string, index = 0) => ({ index, tag: "button", label });

describe("describeEffect", () => {
  it("reports a relabelled acted element (count added)", () => {
    const note = describeEffect(snap([btn(0, "Add to cart")]), snap([btn(0, "Add to cart 1")]), acted("Add to cart"));
    expect(note).toBe(' → effect: "Add to cart" became "Add to cart 1"');
  });

  it("matches a count prefix and a moved index", () => {
    const note = describeEffect(snap([btn(0, "Add to cart")]), snap([btn(3, "1 Add to cart")]), acted("Add to cart"));
    expect(note).toBe(' → effect: "Add to cart" became "1 Add to cart"');
  });

  it("does not report a same-labelled element or a different role", () => {
    expect(describeEffect(snap([btn(0, "Add to cart")]), snap([btn(0, "Add to cart")]), acted("Add to cart"))).toBe("");
    expect(
      describeEffect(snap([btn(0, "Add to cart")]), snap([{ index: 0, tag: "a", label: "Add to cart 1" }]), acted("Add to cart"))
    ).not.toContain("became");
  });

  it("reports a counter whose digits changed", () => {
    const note = describeEffect(
      snap([btn(0, "Add"), { index: 1, tag: "a", label: "Cart 2" }]),
      snap([btn(0, "Add"), { index: 1, tag: "a", label: "Cart 3" }]),
      acted("Add")
    );
    expect(note).toBe(" → effect: counter 2→3");
  });

  it("reports a counter from appeared text and a 0 start", () => {
    const note = describeEffect(
      snap([btn(0, "Add"), { index: 1, tag: "a", label: "Cart" }]),
      snap([btn(0, "Add")]),
      acted("Add"),
      { changed: true, appeared: ["Cart 1"] }
    );
    expect(note).toContain("counter 0→1");
  });

  it("reports appeared text and a new modal, at most two items", () => {
    const note = describeEffect(snap([btn(0, "Add")]), snap([btn(0, "Add")], { modal: "Your cart" }), acted("Add"), {
      appeared: ["View your cart", "Close", "Third"],
    });
    expect(note).toBe(' → effect: appeared: "View your cart"; appeared: "Close"');
    const modalOnly = describeEffect(snap([btn(0, "Add")]), snap([btn(0, "Add")], { modal: "Your cart" }), acted("Add"));
    expect(modalOnly).toBe(' → effect: appeared: "Your cart"');
  });

  it("returns an empty string when nothing is visible or the page navigated", () => {
    expect(describeEffect(snap([btn(0, "Add")]), snap([btn(0, "Add")]), acted("Add"), { changed: true })).toBe("");
    expect(describeEffect(snap([btn(0, "Add")]), { ...snap([btn(0, "Add 1")]), url: "https://other.test" }, acted("Add"))).toBe("");
  });

  it("keeps the note within the cap and replaces double quotes", () => {
    const long = "x".repeat(200);
    const note = describeEffect(snap([btn(0, "Add")]), snap([btn(0, "Add 1")], { modal: `Say "${long}"` }), acted("Add"), {
      appeared: [long, long],
    });
    expect(note.length).toBeLessThanOrEqual(EFFECT_NOTE_MAX_CHARS);
    expect(note.startsWith(" → effect: ")).toBe(true);
    expect(note.slice(" → effect: ".length)).not.toMatch(/""/);
  });
});

describe("appendKeepingSuffix", () => {
  it("cuts the base, never the suffix", () => {
    const out = appendKeepingSuffix("b".repeat(300), " (earlier sub-goal)", 200);
    expect(out).toHaveLength(200);
    expect(out.endsWith(" (earlier sub-goal)")).toBe(true);
    expect(appendKeepingSuffix("ab", "!", 200)).toBe("ab!");
  });
});

describe("fitLabel / stripVolatileLabelParts", () => {
  it("cuts only the element label, keeping the effect note and page-updated part", () => {
    const label = `${"y".repeat(190)} (page updated: "Added") → effect: "A" became "A 1"`;
    const out = fitLabel(label, 200);
    expect(out).toHaveLength(200);
    expect(out).toContain(' (page updated: "Added") → effect: "A" became "A 1"');
  });

  it("shortens page-updated text first when the tail alone is too long", () => {
    const label = `Buy (page updated: "${"p".repeat(190)}") → effect: "A" became "A 1"`;
    const out = fitLabel(label, 120);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out).toContain('became "A 1"');
  });

  it("strips effect notes and page-updated text, keeps other suffixes", () => {
    expect(stripVolatileLabelParts('Add → effect: "A" became "A 1" (page updated: "x") (no effect)')).toBe("Add (no effect)");
  });
});

describe("isCommitEffect", () => {
  const b = (o: string, n: string) => ({ old: o, new: n });
  it("accepts one bare number at the very start or end", () => {
    expect(isCommitEffect(b("Add to cart", "Add to cart 1"))).toBe('"Add to cart" became "Add to cart 1"');
    expect(isCommitEffect(b("Add to cart", "1 Add to cart"))).not.toBeNull();
  });
  it.each([
    ["changed number", "Page 2", "Page 3"],
    ["old label has a number", "Adults 2", "Adults 2 3"],
    ["bracketed", "Load more", "Load more (24)"],
    ["mid-label", "Show results", "Show 245 results"],
    ["not a number", "Add", "Add now"],
    ["two numbers", "Add", "Add 1 2"],
  ])("rejects %s", (_n, o, n) => {
    expect(isCommitEffect(b(o, n))).toBeNull();
  });
  it("rejects a missing relabel", () => {
    expect(isCommitEffect(undefined)).toBeNull();
  });
});

describe("describeEffectDetailed", () => {
  it("returns the structured relabel only for the acted element", () => {
    const d = describeEffectDetailed(snap([btn(0, "Add to cart")]), snap([btn(0, "Add to cart 1")]), acted("Add to cart"));
    expect(d.became).toEqual({ old: "Add to cart", new: "Add to cart 1" });
    expect(describeEffectDetailed(snap([btn(0, "Add")]), snap([btn(0, "Add 1")]), undefined).became).toBeUndefined();
    expect(describeEffectDetailed(snap([btn(0, "Add")]), snap([btn(0, "Add")]), acted("Add")).became).toBeUndefined();
  });
});
