import { describe, expect, it } from "vitest";
import { hasPlaywrightSelectorSyntax } from "../../src/shared/qaChecks.js";

describe("hasPlaywrightSelectorSyntax", () => {
  it.each([
    "text=Save",
    "  TEXT=Save",
    "css=.a",
    "xpath=//a",
    "role=button",
    "id=x",
    "data-testid=x",
    "internal:role=button",
    "div text=Save",
    "div > text=Save",
    "a, text=Save",
    'button:has-text("Save")',
    "a:text(x)",
    "a:text-is(x)",
    "a:text-matches(x)",
    "li:nth-match(.a, 2)",
    "button:visible",
    ".a >> .b",
    ".a>>.b",
  ])("rejects %s", (selector) => {
    expect(hasPlaywrightSelectorSyntax(selector)).toBe(true);
  });

  it.each([
    "[ role=dialog]",
    "[role=dialog]",
    'div[role="dialog"] .title',
    '[data-x="a>>b"]',
    "[data-x='text=y']",
    '[data-x="a:visible"]',
    "button.primary:not(:disabled)",
    "ul > li + li ~ li",
    "#text",
    ".role",
  ])("keeps valid CSS %s", (selector) => {
    expect(hasPlaywrightSelectorSyntax(selector)).toBe(false);
  });
});
