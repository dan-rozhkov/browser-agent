// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { ARGS_MARKER, ASSERT_JS } from "../../src/controller/pageScripts.js";
import type { QaCheck } from "../../src/agent/qaTypes.js";

type R = { passed: boolean; actual?: string; error?: string };
function run(checks: QaCheck[], extra: Record<string, unknown> = {}): R[] {
  const code = ASSERT_JS.replace(ARGS_MARKER, () => JSON.stringify({ checks, fingerprints: {}, ...extra }));
  return ((0, eval)(code) as { results: R[] }).results;
}
const one = (check: QaCheck, extra?: Record<string, unknown>): R => run([check], extra)[0]!;

beforeEach(() => {
  document.body.innerHTML = "";
  // happy-dom has no layout: a box for every element except the ones marked hidden.
  Element.prototype.getBoundingClientRect = function () {
    const hidden = (this as Element).hasAttribute("data-nobox");
    return { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20, width: hidden ? 0 : 100, height: hidden ? 0 : 20, toJSON() {} } as DOMRect;
  };
});

describe("ASSERT_JS text", () => {
  it("finds visible text case-insensitively, present by default", () => {
    document.body.innerHTML = "<p>Welcome back, Ann</p>";
    expect(one({ type: "text", text: "WELCOME BACK" }).passed).toBe(true);
    expect(one({ type: "text", text: "Goodbye" })).toMatchObject({ passed: false, actual: "not found" });
  });
  it("absent true passes when the text is missing and fails when found; absent false is the default", () => {
    document.body.innerHTML = "<p>Error: card declined</p>";
    expect(one({ type: "text", text: "card declined", absent: true })).toMatchObject({ passed: false, actual: "found" });
    expect(one({ type: "text", text: "all good", absent: true }).passed).toBe(true);
    expect(one({ type: "text", text: "card declined", absent: false }).passed).toBe(true);
  });
});

describe("ASSERT_JS element", () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<button id="go">Go</button><button id="off" disabled>Off</button><div id="gone" data-nobox>x</div>' +
      '<input id="c1" type="checkbox" checked><input id="c2" type="checkbox"><div id="aria" role="checkbox" aria-checked="true"></div>';
  });
  it.each([
    ["#go", "visible", true],
    ["#gone", "visible", false],
    ["#gone", "hidden", true],
    ["#go", "hidden", false],
    ["#nope", "hidden", true],
    ["#nope", "visible", false],
    ["#go", "exists", true],
    ["#nope", "exists", false],
    ["#nope", "absent", true],
    ["#go", "absent", false],
    ["#go", "enabled", true],
    ["#off", "enabled", false],
    ["#off", "disabled", true],
    ["#go", "disabled", false],
    ["#c1", "checked", true],
    ["#c2", "checked", false],
    ["#c2", "unchecked", true],
    ["#c1", "unchecked", false],
    ["#aria", "checked", true],
  ] as const)("%s is %s -> %s", (selector, state, passed) => {
    expect(one({ type: "element", selector, state }).passed).toBe(passed);
  });
  it("explains a failure in actual", () => {
    expect(one({ type: "element", selector: "#gone", state: "visible" })).toMatchObject({ passed: false, actual: "hidden" });
    expect(one({ type: "element", selector: "#nope", state: "visible" })).toMatchObject({ passed: false, actual: "not found" });
    expect(one({ type: "element", selector: "#off", state: "enabled" })).toMatchObject({ passed: false, actual: "disabled" });
  });
  it("gives an error, not a throw, for an invalid selector", () => {
    const r = one({ type: "element", selector: "((", state: "exists" });
    expect(r.passed).toBe(false);
    expect(r.error).toContain("Invalid selector");
  });
  it("finds an element by snapshot index", () => {
    document.getElementById("go")!.setAttribute("data-pen-snap", "s1:4");
    expect(one({ type: "element", index: 4, state: "visible" }, { snapshotId: "s1" }).passed).toBe(true);
    expect(one({ type: "element", index: 5, state: "exists" }, { snapshotId: "s1" })).toMatchObject({ passed: false, actual: "not found" });
  });
});

describe("ASSERT_JS value", () => {
  it("compares equals and contains, and never prints a password", () => {
    document.body.innerHTML = '<input id="n" value="Ann Lee"><input id="p" type="password" value="hunter2"><select id="s"><option value="a">A</option><option value="b" selected>B</option></select>';
    expect(one({ type: "value", selector: "#n", equals: "Ann Lee" }).passed).toBe(true);
    expect(one({ type: "value", selector: "#n", contains: "Lee" }).passed).toBe(true);
    expect(one({ type: "value", selector: "#s", equals: "b" }).passed).toBe(true);
    expect(one({ type: "value", selector: "#n", equals: "Bob" })).toMatchObject({ passed: false, actual: 'value "Ann Lee"' });
    const secret = one({ type: "value", selector: "#p", equals: "x" });
    expect(secret.passed).toBe(false);
    expect(JSON.stringify(secret)).not.toContain("hunter2");
  });
  it("errors on an element without a value and on a missing element", () => {
    document.body.innerHTML = "<div id='d'>x</div>";
    expect(one({ type: "value", selector: "#d", equals: "x" }).error).toContain("no value");
    expect(one({ type: "value", selector: "#zz", equals: "x" })).toMatchObject({ passed: false, actual: "not found" });
  });
});

describe("ASSERT_JS count", () => {
  beforeEach(() => {
    document.body.innerHTML = "<ul><li>a</li><li>b</li><li>c</li></ul>";
  });
  it("checks equals, min and max", () => {
    expect(one({ type: "count", selector: "li", equals: 3 }).passed).toBe(true);
    expect(one({ type: "count", selector: "li", min: 2, max: 3 }).passed).toBe(true);
    expect(one({ type: "count", selector: "li", equals: 2 })).toMatchObject({ passed: false, actual: "3 matches" });
    expect(one({ type: "count", selector: "li", max: 2 }).passed).toBe(false);
    expect(one({ type: "count", selector: "li", min: 4 }).passed).toBe(false);
    expect(one({ type: "count", selector: "li.none", equals: 0 }).passed).toBe(true);
  });
  it("gives an error for an invalid selector", () => {
    expect(one({ type: "count", selector: "li[", min: 1 }).error).toContain("Invalid selector");
  });
  it("does not stop at a failing check: results keep their order", () => {
    const r = run([{ type: "count", selector: "li", equals: 9 }, { type: "text", text: "a" }]);
    expect(r.map((x) => x.passed)).toEqual([false, true]);
  });
});
