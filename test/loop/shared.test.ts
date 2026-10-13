import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { filterElementsForBackend, sanitizedPageBody, truncateToChars } from "../shared";

describe("filterElementsForBackend", () => {
  it("keeps elements with a non-empty ops array", () => {
    const elements = [
      { index: 0, tag: "button", label: "Accept all", ops: ["CLICK"] },
      { index: 1, tag: "input", label: "Search", ops: ["TYPE_TEXT"] },
    ];
    expect(filterElementsForBackend(elements)).toEqual(elements);
  });

  it("keeps scroll-container entries (empty ops + scrollable) but drops non-scrollable empty-ops ones", () => {
    const clickable = { index: 0, tag: "button", label: "Accept all", ops: ["CLICK"] };
    const scrollContainer = {
      index: 1,
      tag: "div",
      label: "Comments list",
      ops: [],
      scrollable: true,
    };
    expect(filterElementsForBackend([clickable, scrollContainer])).toEqual([clickable, scrollContainer]);
    const inert = { index: 2, tag: "div", label: "Inert", ops: [] };
    expect(filterElementsForBackend([clickable, inert])).toEqual([clickable]);
  });

  it("drops entries where ops is missing entirely", () => {
    const clickable = { index: 0, tag: "button", label: "Accept all", ops: ["CLICK"] };
    const noOpsField = { index: 1, tag: "div", label: "Sidebar", scrollable: true };
    expect(filterElementsForBackend([clickable, noOpsField])).toEqual([clickable]);
  });

  it("preserves each surviving element's original index field", () => {
    const elements = [
      { index: 5, tag: "button", label: "Save", ops: ["CLICK"] },
      { index: 6, tag: "div", label: "List", ops: [], scrollable: true },
      { index: 7, tag: "select", label: "Country", ops: ["SELECT"] },
    ];
    expect(filterElementsForBackend(elements)).toEqual([
      { index: 5, tag: "button", label: "Save", ops: ["CLICK"] },
      { index: 6, tag: "div", label: "List", ops: [], scrollable: true },
      { index: 7, tag: "select", label: "Country", ops: ["SELECT"] },
    ]);
  });

  it("returns an empty array unchanged", () => {
    expect(filterElementsForBackend([])).toEqual([]);
  });

  it("drops non-object entries: the body must be valid by construction", () => {
    expect(filterElementsForBackend(["a string element", 42, null])).toEqual([]);
  });

  it("passes `disabled: true` through and omits any other disabled value", () => {
    const out = filterElementsForBackend([
      { index: 0, tag: "b", label: "", ops: ["CLICK"], disabled: true },
      { index: 1, tag: "b", label: "", ops: ["CLICK"], disabled: false },
      { index: 2, tag: "b", label: "", ops: ["CLICK"] },
    ]);
    expect(out).toEqual([
      { index: 0, tag: "b", label: "", ops: ["CLICK"], disabled: true },
      { index: 1, tag: "b", label: "", ops: ["CLICK"] },
      { index: 2, tag: "b", label: "", ops: ["CLICK"] },
    ]);
  });
});

const BACKEND_STEP_ROUTE = resolve(process.cwd(), "../pen-editor-backend/src/routes/browseStep.ts");

describe("filterElementsForBackend: valid by construction", () => {
  const oversized = {
    index: 3,
    tag: "t".repeat(100),
    role: "r".repeat(500),
    label: "l".repeat(5_000),
    frame: "f".repeat(45_000),
    value: "v".repeat(30_000),
    options: Array.from({ length: 1_500 }, () => "o".repeat(3_000)),
    ops: ["CLICK", "BOGUS"],
    disabled: false,
    checked: "yes",
  };

  it("truncates oversized strings and arrays with an ellipsis inside the cap", () => {
    const [el] = filterElementsForBackend([oversized]) as Array<Record<string, unknown>>;
    expect((el!.frame as string).length).toBe(200);
    expect((el!.frame as string).endsWith("…")).toBe(true);
    expect((el!.label as string).length).toBe(200);
    expect((el!.role as string).length).toBe(60);
    expect((el!.tag as string).length).toBe(40);
    expect((el!.value as string).length).toBe(500);
    expect((el!.options as string[]).length).toBe(100);
    expect((el!.options as string[])[0]!.length).toBe(200);
    expect(el!.ops).toEqual(["CLICK"]);
    expect(el).not.toHaveProperty("disabled");
    expect(el).not.toHaveProperty("checked");
  });

  it("caps the element table at the backend's effective 120", () => {
    const many = Array.from({ length: 300 }, (_, index) => ({ index, tag: "a", label: "x", ops: ["CLICK"] }));
    expect(filterElementsForBackend(many)).toHaveLength(120);
  });

  it("sanitizedPageBody clamps url/title and sanitizes elements (shared by step and locate)", () => {
    const body = sanitizedPageBody({
      url: "u".repeat(5_000),
      title: "t".repeat(900),
      elements: [{ index: 0, tag: "a", label: "x", ops: ["CLICK"], frame: "f".repeat(45_000) }],
    });
    expect(body.url).toHaveLength(4_000);
    expect(body.title).toHaveLength(500);
    expect((body.elements[0] as { frame: string }).frame).toHaveLength(200);
  });

  it.each([
    ["negative index", { ...oversized, index: -1 }],
    ["empty tag", { ...oversized, tag: "" }],
    ["no valid ops", { ...oversized, ops: ["BOGUS"] }],
    ["non-object", "nope"],
  ])("drops an element with %s", (_name, el) => {
    expect(filterElementsForBackend([el])).toEqual([]);
  });

  it.skipIf(!existsSync(BACKEND_STEP_ROUTE))("passes the backend's zod bodySchema", async () => {
    // Variable path: keeps `tsc` from type-checking the backend sources.
    const { bodySchema } = (await import(/* @vite-ignore */ BACKEND_STEP_ROUTE)) as {
      bodySchema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } };
    };
    const body = {
      goal: "g",
      url: "https://example.com",
      title: "t",
      elements: filterElementsForBackend([oversized, { ...oversized, index: 4, frame: "x" }]),
      history: [],
    };
    const parsed = bodySchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error)).toBe(true);
  });
});

describe("truncateToChars", () => {
  it("leaves short strings alone and ends a cut with one ellipsis inside the cap", () => {
    expect(truncateToChars("abc", 5)).toBe("abc");
    expect(truncateToChars("abcdefgh", 5)).toBe("abcd…");
  });

  it("never splits a surrogate pair", () => {
    // "ab" + 😀 (two UTF-16 units): a cut after 3 units would strand the high half.
    const cut = truncateToChars("ab😀cd", 4);
    expect(cut).toBe("ab…");
    expect(cut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});
