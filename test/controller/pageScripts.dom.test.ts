// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { ARGS_MARKER, SIGNATURE_JS, SNAPSHOT_JS } from "../../src/controller/pageScripts.js";
import { BrowserController } from "../../src/controller/controller.js";

/** Runs a page script in the happy-dom document, like page.evaluate would. */
function run(script: string, args: unknown): any {
  const code = script.replace(ARGS_MARKER, () => JSON.stringify(args));
  try {
    return (0, eval)(code);
  } catch (e) {
    console.log((e as Error).stack);
    throw e;
  }
}

beforeEach(() => {
  document.body.innerHTML = "";
  (window as any).__penSigObserver = null;
  (window as any).__penSigState = null;
  // happy-dom lacks document.images.
  if (!document.images) {
    Object.defineProperty(document, "images", { get: () => document.querySelectorAll("img"), configurable: true });
  }
  // happy-dom has no layout: give every element a box so isVisible passes.
  Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20, toJSON() {} } as DOMRect;
  };
});

function signature(phase: "before" | "after") {
  return run(SIGNATURE_JS, { phase });
}

function diff(before: any, after: any): { changed: boolean; changes: string[] } {
  const c = new BrowserController({ ensurePage: async () => null } as any) as any;
  return c.diffSignatures(before, after);
}

describe("SIGNATURE_JS controlsHash", () => {
  it("moves when a sibling input changes value with the same length", () => {
    document.body.innerHTML = '<input id="h" value="06"><button>+</button>';
    const before = signature("before");
    (document.getElementById("h") as HTMLInputElement).value = "07";
    const after = signature("after");
    expect(after.controlsHash).not.toBe(before.controlsHash);
    const ev = diff(before, after);
    expect(ev.changed).toBe(true);
    expect(ev.changes).toContain("controls");
  });

  it("is stable when nothing changed", () => {
    document.body.innerHTML = '<input value="06"><input type="checkbox" checked>';
    const before = signature("before");
    const after = signature("after");
    expect(after.controlsHash).toBe(before.controlsHash);
    expect(diff(before, after).changed).toBe(false);
  });

  it("tracks the focused field's same-length edit through focusedValueHash", () => {
    document.body.innerHTML = '<input id="h" value="06">';
    const input = document.getElementById("h") as HTMLInputElement;
    input.focus();
    const before = signature("before");
    input.value = "08";
    const after = signature("after");
    expect(after.focusedValueLength).toBe(before.focusedValueLength);
    expect(after.focusedValueHash).not.toBe(before.focusedValueHash);
    const ev = diff(before, after);
    expect(ev.changed).toBe(true);
    expect(ev.changes).toContain("value");
  });

  it("excludes password fields from both hashes", () => {
    document.body.innerHTML = '<input id="p" type="password" value="abc">';
    const input = document.getElementById("p") as HTMLInputElement;
    input.focus();
    const before = signature("before");
    input.value = "xyz";
    const after = signature("after");
    expect(after.controlsHash).toBe(before.controlsHash);
    expect(after.focusedValueHash).toBe(0);
    expect(diff(before, after).changed).toBe(false);
  });

  it("only leaks numbers, never the value", () => {
    document.body.innerHTML = '<input value="secret-value">';
    const json = JSON.stringify(signature("before"));
    expect(json).not.toContain("secret-value");
  });

  it("scopes to a visible modal dialog", () => {
    document.body.innerHTML = '<input id="out" value="1"><div role="dialog" aria-modal="true"><input value="2"></div>';
    const before = signature("before");
    (document.getElementById("out") as HTMLInputElement).value = "9";
    expect(signature("after").controlsHash).toBe(before.controlsHash);
  });

  it("does not narrow to a non-modal dialog (cookie banner, chat bubble)", () => {
    document.body.innerHTML = '<input id="out" value="1"><div role="dialog"><input value="2"></div>';
    const before = signature("before");
    (document.getElementById("out") as HTMLInputElement).value = "9";
    expect(signature("after").controlsHash).not.toBe(before.controlsHash);
  });

  it("scopes to a big overlay-positioned dialog without aria-modal, not to a small one", () => {
    const orig = Element.prototype.getBoundingClientRect;
    const rectFor = (el: Element) => {
      const big = el.id === "big";
      const w = big ? window.innerWidth : 100;
      const h = big ? window.innerHeight : 20;
      return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, toJSON() {} } as DOMRect;
    };
    Element.prototype.getBoundingClientRect = function () {
      return rectFor(this);
    };
    try {
      document.body.innerHTML =
        '<input id="out" value="1"><div id="big" role="dialog" style="position:fixed"><input value="2"></div>';
      const before = signature("before");
      (document.getElementById("out") as HTMLInputElement).value = "9";
      expect(signature("after").controlsHash).toBe(before.controlsHash);

      document.body.innerHTML =
        '<input id="out" value="1"><div id="small" role="dialog" style="position:fixed"><input value="2"></div>';
      const b2 = signature("before");
      (document.getElementById("out") as HTMLInputElement).value = "9";
      expect(signature("after").controlsHash).not.toBe(b2.controlsHash);
    } finally {
      Element.prototype.getBoundingClientRect = orig;
    }
  });

  it("ignores ambient aria state: slider progress, tab selection, range input", () => {
    document.body.innerHTML =
      '<div id="s" role="slider" aria-valuenow="10"></div><div id="t" role="tab" aria-selected="true"></div><input id="r" type="range" value="3">';
    const before = signature("before");
    document.getElementById("s")!.setAttribute("aria-valuenow", "55");
    document.getElementById("t")!.setAttribute("aria-selected", "false");
    (document.getElementById("r") as HTMLInputElement).value = "7";
    expect(signature("after").controlsHash).toBe(before.controlsHash);
  });

  it("tracks aria-valuenow on a spinbutton and aria-checked on a switch", () => {
    document.body.innerHTML = '<div id="n" role="spinbutton" aria-valuenow="1"></div><div id="w" role="switch" aria-checked="false"></div>';
    const b1 = signature("before");
    document.getElementById("n")!.setAttribute("aria-valuenow", "2");
    expect(signature("after").controlsHash).not.toBe(b1.controlsHash);
    const b2 = signature("before");
    document.getElementById("w")!.setAttribute("aria-checked", "true");
    expect(signature("after").controlsHash).not.toBe(b2.controlsHash);
  });

  it("applies the 150 cap after the visibility filter", () => {
    const hidden = Array.from({ length: 160 }, () => '<input value="h" hidden-test>').join("");
    document.body.innerHTML = hidden + '<input id="late" value="1">';
    const orig = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      const zero = this.hasAttribute("hidden-test");
      return { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20, width: zero ? 0 : 100, height: zero ? 0 : 20, toJSON() {} } as DOMRect;
    };
    try {
      const before = signature("before");
      (document.getElementById("late") as HTMLInputElement).value = "2";
      expect(signature("after").controlsHash).not.toBe(before.controlsHash);
    } finally {
      Element.prototype.getBoundingClientRect = orig;
    }
  });
});

describe("diffSignatures with older signature shapes", () => {
  const old = {
    url: "u",
    title: "t",
    nodeCount: 0,
    textLength: 0,
    textHash: 0,
    mainImageSrc: "",
    scrollY: 0,
    focusedValueLength: 0,
  };
  it("treats missing hash fields as no change", () => {
    expect(diff(old, { ...old })).toMatchObject({ changed: false, changes: [] });
  });
  it("compares scoped signatures without valueHash safely", () => {
    const c = new BrowserController({ ensurePage: async () => null } as any) as any;
    const scoped = {
      nodeCount: 1,
      textHash: 0,
      src: "",
      valueLength: 2,
      ariaExpanded: "",
      ariaSelected: "",
      checked: false,
    };
    const ev = c.diffSignatures(old, { ...old, scopedAfter: { ...scoped } }, { scopedBefore: { ...scoped } });
    expect(ev.changed).toBe(false);
    const ev2 = c.diffSignatures(
      old,
      { ...old, scopedAfter: { ...scoped, valueHash: 5 } },
      { scopedBefore: { ...scoped, valueHash: 6 } },
    );
    expect(ev2.changed).toBe(true);
    expect(ev2.changes).toContain("target");
  });
});

describe("SNAPSHOT_JS table headers", () => {
  function labels(): string[] {
    const res = run(SNAPSHOT_JS, { snapshotId: "s1", maxElements: 100 });
    return (res.elements as { label: string }[]).map((e) => e.label);
  }

  it("lists a header with aria-sort or a pointer cursor, not a plain one", () => {
    document.body.innerHTML = `<table><thead><tr>
      <th aria-sort="none">Price</th>
      <th style="cursor:pointer">Date</th>
      <th>Plain</th>
    </tr></thead></table>`;
    const l = labels();
    expect(l).toContain("Price");
    expect(l).toContain("Date");
    expect(l).not.toContain("Plain");
  });

  it("lists role=columnheader[aria-sort]", () => {
    document.body.innerHTML = '<div role="columnheader" aria-sort="ascending">Name</div><div role="columnheader">Id</div>';
    const l = labels();
    expect(l).toContain("Name");
    expect(l).not.toContain("Id");
  });

  it("targets the inner button, not the header, without duplicates", () => {
    document.body.innerHTML = '<table><tr><th aria-sort="none"><button>Sort size</button></th></tr></table>';
    const res = run(SNAPSHOT_JS, { snapshotId: "s2", maxElements: 100 });
    const els = res.elements as { tag: string; label: string }[];
    expect(els.filter((e) => e.label.includes("Sort size"))).toHaveLength(1);
    expect(els.some((e) => e.tag === "th")).toBe(false);
  });
});

describe("SNAPSHOT_JS inputType", () => {
  it("exposes inputType for native radio and checkbox inputs only", () => {
    document.body.innerHTML =
      '<label>Std <input type="radio" name="g"></label><label>Opt <input type="checkbox"></label><input type="text" aria-label="Name">';
    const res = run(SNAPSHOT_JS, { snapshotId: "s9", maxElements: 100 });
    const els = res.elements as { tag: string; inputType?: string; label: string }[];
    expect(els.filter((e) => e.inputType === "radio")).toHaveLength(1);
    expect(els.filter((e) => e.inputType === "checkbox")).toHaveLength(1);
    expect(els.filter((e) => e.tag === "input" && e.inputType === undefined)).toHaveLength(1);
  });
});
