// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ARGS_MARKER, CLICK_JS, DOC_MARKER_JS, PERFORM_JS, SELECTOR_JS, SNAPSHOT_JS, TYPE_JS } from "../../src/controller/pageScripts.js";

/** Runs a page script in the happy-dom document, like page.evaluate would. */
function run(script: string, args: unknown): any {
  return (0, eval)(script.replace(ARGS_MARKER, () => JSON.stringify(args)));
}

/** SELECTOR_JS also returns the document marker (the journal's check before an action rides on it): checked here, stripped for the rest. */
function lookup(args: unknown): any {
  const { marker, ...rest } = run(SELECTOR_JS, args);
  expect(typeof marker).toBe("string");
  return rest;
}

const selectorOf = (args: Record<string, unknown>) => lookup({ op: "click", ...args });

beforeEach(() => {
  document.body.innerHTML = "";
  Element.prototype.scrollIntoView = function () {};
  // happy-dom has no layout: give every element a box so the text finder sees it.
  Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20, toJSON() {} } as DOMRect;
  };
});

/** Resolves the answer and checks that the selector finds exactly the wanted element. */
function expectUnique(answer: any, el: Element): string {
  expect(answer.ok).toBe(true);
  const found = document.querySelectorAll(answer.selector);
  expect(found.length).toBe(1);
  expect(found[0]).toBe(el);
  return answer.selector;
}

describe("SELECTOR_JS preference order", () => {
  it("1. a stable unique #id", () => {
    document.body.innerHTML = '<div><button id="buy">Buy</button><button>Other</button></div>';
    expect(expectUnique(selectorOf({ target: "Buy" }), document.getElementById("buy")!)).toBe("#buy");
  });

  it("an id that looks generated is skipped (digits, hex, framework prefix)", () => {
    for (const id of ["btn-123456", "a1b2c3d4e5f6", ":r1:", "radix-7"]) {
      document.body.innerHTML = `<button id="${id}" data-testid="go">Go</button>`;
      const sel = expectUnique(selectorOf({ target: "Go" }), document.querySelector("button")!);
      expect(sel).toBe('button[data-testid="go"]');
    }
  });

  it("2. data-testid, data-test, data-qa", () => {
    for (const attr of ["data-testid", "data-test", "data-qa"]) {
      document.body.innerHTML = `<button ${attr}="x y">Go</button>`;
      expect(expectUnique(selectorOf({ target: "Go" }), document.querySelector("button")!)).toBe(`button[${attr}="x\\ y"]`);
    }
  });

  it("3. name, then aria-label", () => {
    document.body.innerHTML = '<input name="q" aria-label="Search">';
    expect(expectUnique(selectorOf({ target: "[name=q]" }), document.querySelector("input")!)).toBe('input[name="q"]');
    document.body.innerHTML = '<button aria-label="Close dialog">x</button>';
    expect(expectUnique(selectorOf({ target: "[aria-label]" }), document.querySelector("button")!)).toBe('button[aria-label="Close\\ dialog"]');
  });

  it("an attribute that is not unique is skipped", () => {
    document.body.innerHTML = '<input name="size" type="radio"><input name="size" type="radio">';
    const second = document.querySelectorAll("input")[1]!;
    second.setAttribute("data-x", "1");
    const sel = expectUnique(selectorOf({ target: "[data-x]" }), second);
    expect(sel).toContain(":nth-of-type(2)");
  });

  it("4. an nth-of-type path from the nearest ancestor with a stable id", () => {
    document.body.innerHTML = '<div id="app"><ul><li><a>one</a></li><li><a>two</a></li></ul></div>';
    const second = document.querySelectorAll("a")[1]!;
    second.setAttribute("data-pick", "1");
    const sel = expectUnique(selectorOf({ target: "[data-pick]" }), second);
    expect(sel).toBe("#app > ul:nth-of-type(1) > li:nth-of-type(2) > a:nth-of-type(1)");
  });

  it("4. an nth-of-type path from body when no ancestor has an id", () => {
    document.body.innerHTML = '<div><span>a</span><span data-pick="1">b</span></div>';
    const el = document.querySelector("[data-pick]")!;
    expect(expectUnique(selectorOf({ target: "[data-pick]" }), el)).toBe("body > div:nth-of-type(1) > span:nth-of-type(2)");
  });

  it("a value with quotes and backslashes is escaped and still unique", () => {
    document.body.innerHTML = "<button>Go</button>";
    document.querySelector("button")!.setAttribute("data-testid", 'a"b\\c');
    // Whatever candidate wins, it must find exactly this element.
    expectUnique(selectorOf({ target: "Go" }), document.querySelector("button")!);
  });
});

describe("SELECTOR_JS element resolution", () => {
  it("finds the element by index + snapshotId through the snapshot stamp (the same resolution the actions use)", () => {
    document.body.innerHTML = '<button data-pen-snap="s1:3" data-testid="stamped">Stamped</button><button>Plain</button>';
    const el = document.querySelector("[data-pen-snap]")!;
    expect(expectUnique(selectorOf({ index: 3, snapshotId: "s1" }), el)).toBe('button[data-testid="stamped"]');
  });

  it("a real snapshot stamp resolves to a selector for that element", () => {
    document.body.innerHTML = '<main><button id="ok">Confirm</button></main>';
    const snap = run(SNAPSHOT_JS, { snapshotId: "s7", maxElements: 100 });
    const entry = (snap.elements as any[]).find((e) => e.label === "Confirm");
    expect(entry).toBeTruthy();
    expect(expectUnique(selectorOf({ index: entry.index, snapshotId: "s7" }), document.getElementById("ok")!)).toBe("#ok");
  });

  it("an unknown element is not-found", () => {
    document.body.innerHTML = "<button>Go</button>";
    expect(selectorOf({ index: 9, snapshotId: "nope" })).toEqual({ ok: false, reason: "not-found" });
    expect(selectorOf({ target: "zzz-not-there" })).toEqual({ ok: false, reason: "not-found" });
  });

  it("an element in a shadow tree has no selector (no-unique)", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = '<button data-pen-snap="s1:0">Inside</button>';
    expect(selectorOf({ index: 0, snapshotId: "s1" })).toEqual({ ok: false, reason: "no-unique" });
  });

  it("does not scroll or change the page", () => {
    document.body.innerHTML = '<button id="b">Go</button>';
    let scrolled = 0;
    Element.prototype.scrollIntoView = function () { scrolled++; };
    const before = document.body.innerHTML;
    selectorOf({ target: "Go" });
    expect(scrolled).toBe(0);
    expect(document.body.innerHTML).toBe(before);
  });
});

describe("SELECTOR_JS per operation", () => {
  it("type: only a text field has a step", () => {
    document.body.innerHTML = '<input id="a"><textarea id="b"></textarea><input id="c" type="range"><input id="d" type="file"><button id="e">B</button>';
    expect(lookup({ op: "type", target: "#a" })).toMatchObject({ ok: true, selector: "#a" });
    expect(lookup({ op: "type", target: "#b" })).toMatchObject({ ok: true, selector: "#b" });
    for (const id of ["#c", "#d", "#e"]) expect(lookup({ op: "type", target: id })).toEqual({ ok: false, reason: "unsupported" });
  });

  it("select: returns the option value of the option whose visible text matches", () => {
    document.body.innerHTML = '<select id="size"><option value="s">Small</option><option value="l">Large</option></select><input id="x">';
    expect(lookup({ op: "select", target: "#size", optionText: "Large" })).toEqual({ ok: true, optionValue: "l", selector: "#size" });
    expect(lookup({ op: "select", target: "#size", optionText: "Huge" })).toEqual({ ok: false, reason: "not-found" });
    expect(lookup({ op: "select", target: "#x", optionText: "Large" })).toEqual({ ok: false, reason: "unsupported" });
  });
});

describe("SELECTOR_JS op active (a key-only press)", () => {
  it("nothing focused, or the body: no element (ok, none)", () => {
    document.body.innerHTML = '<input id="a">';
    expect(lookup({ op: "active" })).toEqual({ ok: true, none: true });
    (document.body as HTMLElement).focus();
    expect(lookup({ op: "active" })).toEqual({ ok: true, none: true });
  });

  it("a focused element gets the same selector the actions use", () => {
    document.body.innerHTML = '<input id="a"><input name="q">';
    (document.querySelector("[name=q]") as HTMLElement).focus();
    expect(lookup({ op: "active" })).toEqual({ ok: true, selector: 'input[name="q"]' });
    (document.getElementById("a") as HTMLElement).focus();
    expect(lookup({ op: "active" })).toEqual({ ok: true, selector: "#a" });
  });

  it("an iframe holding the focus is reason iframe", () => {
    // Not attached: happy-dom would try to load a connected iframe page.
    const frame = document.createElement("iframe");
    const spy = vi.spyOn(document, "activeElement", "get").mockReturnValue(frame);
    try {
      expect(lookup({ op: "active" })).toEqual({ ok: false, reason: "iframe" });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("DOC_MARKER_JS (document marker)", () => {
  it("plants a token once and returns the same one on every later run in the same document", () => {
    const first = run(DOC_MARKER_JS, {});
    expect(first.ok).toBe(true);
    expect(typeof first.marker).toBe("string");
    expect(first.marker.length).toBeGreaterThan(8);
    expect(run(DOC_MARKER_JS, {}).marker).toBe(first.marker);
  });

  it("is invisible to the page: non-enumerable, not writable, not removable", () => {
    const { marker } = run(DOC_MARKER_JS, {});
    expect(Object.keys(window)).not.toContain("__penJournalDoc");
    const desc = Object.getOwnPropertyDescriptor(window, "__penJournalDoc")!;
    expect(desc.enumerable).toBe(false);
    expect(desc.configurable).toBe(false);
    expect(desc.writable).toBe(false);
    expect(desc.value).toBe(marker);
  });

  it("a pushState or hash change keeps the document, so it keeps the marker", () => {
    const { marker } = run(DOC_MARKER_JS, {});
    history.pushState({}, "", "/spa/route");
    window.location.hash = "#details";
    expect(run(DOC_MARKER_JS, {}).marker).toBe(marker);
  });
});

describe("round 3: select with a shared option value", () => {
  it("a value that more than one option has is reason option-not-unique (the replay picks the first such option)", () => {
    document.body.innerHTML = '<select id="s"><option value="x">Alpha</option><option value="x">Beta</option><option value="y">Gamma</option></select>';
    expect(lookup({ op: "select", target: "#s", optionText: "Beta" })).toEqual({ ok: false, reason: "option-not-unique" });
    expect(lookup({ op: "select", target: "#s", optionText: "Alpha" })).toEqual({ ok: false, reason: "option-not-unique" });
    expect(lookup({ op: "select", target: "#s", optionText: "Gamma" })).toEqual({ ok: true, optionValue: "y", selector: "#s" });
  });
});

describe("round 3: the marker rides along with SELECTOR_JS", () => {
  it("is the same token DOC_MARKER_JS returns on this document, also when the lookup fails", () => {
    document.body.innerHTML = "<button>Go</button>";
    const missed = run(SELECTOR_JS, { op: "click", target: "Nothing here" });
    expect(missed).toMatchObject({ ok: false, reason: "not-found" });
    expect(typeof missed.marker).toBe("string");
    expect(run(DOC_MARKER_JS, {})).toEqual({ ok: true, marker: missed.marker });
    expect(run(SELECTOR_JS, { op: "click", target: "Go" }).marker).toBe(missed.marker);
  });
});

describe("round 3: scripts mark a refusal that touched nothing with noEffect", () => {
  it("CLICK_JS and TYPE_JS: no element matched, a disabled control", () => {
    document.body.innerHTML = '<button id="off" disabled>Off</button><button id="on">On</button>';
    expect(run(CLICK_JS, { target: "Nothing here" })).toEqual({ error: "No element matched: Nothing here", noEffect: true });
    expect(run(TYPE_JS, { target: "Nothing here", text: "x" })).toEqual({ error: "No element matched: Nothing here", noEffect: true });
    expect(run(CLICK_JS, { target: "#off" })).toMatchObject({ error: "the control is disabled", noEffect: true });
  });

  it("PERFORM_JS: no such option, not a select; a real action carries no noEffect", () => {
    document.body.innerHTML = '<select id="s"><option value="a">A</option></select><button id="b">B</button>';
    const snap = run(SNAPSHOT_JS, { snapshotId: "s9", maxElements: 100 });
    const index = (label: string) => (snap.elements as any[]).find((e) => e.label === label || e.tag === label)?.index;
    const select = (snap.elements as any[]).find((e) => String(e.tag ?? e.role ?? "").includes("select") || e.type === "select");
    expect(select).toBeTruthy();
    expect(run(PERFORM_JS, { snapshotId: "s9", index: select.index, operation: "SELECT", text: "Nope" })).toMatchObject({ noEffect: true });
    expect(run(PERFORM_JS, { snapshotId: "s9", index: 999, operation: "CLICK" })).toMatchObject({ noEffect: true });
    expect(index("B")).toBeDefined();
    expect(run(PERFORM_JS, { snapshotId: "s9", index: select.index, operation: "SELECT", text: "A" })).not.toHaveProperty("noEffect");
  });
});
