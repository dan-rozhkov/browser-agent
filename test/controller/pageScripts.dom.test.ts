// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { ARGS_MARKER, CAPTURE_JS, SIGNATURE_JS, SNAPSHOT_JS } from "../../src/controller/pageScripts.js";
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

describe("CAPTURE_JS", () => {
  const doc = { snapshotId: null, index: null, maxChars: 3_000_000 };
  const capture = (args: unknown = doc) => run(CAPTURE_JS, args);

  it("turns <link rel=stylesheet> into an @import style and keeps style text with absolute urls", () => {
    document.head.innerHTML =
      '<link rel="stylesheet" href="/a.css"><style>.x{background:url(img/bg.png)}</style>';
    document.body.innerHTML = "<p>hi</p>";
    const res = capture();
    expect(res.error).toBeUndefined();
    expect(res.html).toContain("<!doctype html>");
    expect(res.html).toMatch(/<style>@import url\("[^"]*\/a\.css"\);<\/style>/);
    expect(res.html).toMatch(/background:url\("[^"]*\/img\/bg\.png"\)/);
    expect(res.html).not.toContain("<link");
    expect(res.html.indexOf("a.css")).toBeLessThan(res.html.indexOf("bg.png"));
    document.head.innerHTML = "";
  });

  it("removes scripts, noscript, iframes, on* attributes and javascript: hrefs", () => {
    document.body.innerHTML =
      '<script>alert(1)</script><noscript>n</noscript><iframe src="/f"></iframe>' +
      '<a href="javascript:alert(1)" onclick="x()" id="a1">bad</a><a href="/ok" id="a2">ok</a>';
    const html = capture().html as string;
    expect(html).not.toContain("<script");
    expect(html).not.toContain("noscript");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("javascript:");
    expect(html).toMatch(/<a href="http[^"]*\/ok"/);
  });

  it("makes src, poster and srcset absolute and keeps commas inside srcset urls", () => {
    document.body.innerHTML =
      '<img src="/p.png" srcset="/cdn/w_100,h_100/a.jpg 1x, /b.jpg 2x"><video poster="v.jpg"></video>';
    const html = capture().html as string;
    expect(html).toMatch(/src="http[^"]*\/p\.png"/);
    expect(html).toMatch(/poster="http[^"]*\/v\.jpg"/);
    const m = html.match(/srcset="([^"]*)"/);
    expect(m).not.toBeNull();
    const cands = (m as RegExpMatchArray)[1].split(/,\s+/);
    expect(cands).toHaveLength(2);
    expect(cands[0]).toMatch(/^http[^ ]*\/cdn\/w_100,h_100\/a\.jpg 1x$/);
    expect(cands[1]).toMatch(/^http[^ ]*\/b\.jpg 2x$/);
  });

  it("promotes data-src on a lazy image and drops loading", () => {
    document.body.innerHTML =
      '<img loading="lazy" src="data:image/gif;base64,R0lGOD" data-src="/real.jpg" id="lz">';
    const html = capture().html as string;
    expect(html).toMatch(/src="http[^"]*\/real\.jpg"/);
    expect(html).not.toContain("loading=");
  });

  it("freezes live form state into attributes", () => {
    document.body.innerHTML =
      '<input id="t" type="text"><input id="c" type="checkbox"><textarea id="ta"></textarea>' +
      '<select id="s"><option value="1">a</option><option value="2">b</option></select>';
    (document.getElementById("t") as HTMLInputElement).value = "typed";
    (document.getElementById("c") as HTMLInputElement).checked = true;
    (document.getElementById("ta") as HTMLTextAreaElement).value = "area text";
    (document.getElementById("s") as HTMLSelectElement).value = "2";
    const html = capture().html as string;
    expect(html).toContain('value="typed"');
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
    expect(html).toContain("area text");
    expect(html).toMatch(/<option value="2" selected/);
  });

  it("captures one element by data-pen-snap stamp inside a styled wrapper", () => {
    document.body.innerHTML =
      '<p>outside</p><div data-pen-snap="s7:3" id="card" style="padding:4px"><b>inside</b></div>';
    const res = capture({ snapshotId: "s7", index: 3, maxChars: 3_000_000 });
    expect(res.error).toBeUndefined();
    expect(res.html).toContain("<b>inside</b>");
    expect(res.html).not.toContain("outside");
    expect(res.html).toMatch(/<div style="width:100px;[^"]*font-size:/);
    expect(res.width).toBe(100);
    expect(res.height).toBe(20);
  });

  it("reports a missing stamp as an error", () => {
    document.body.innerHTML = '<div data-pen-snap="s7:3">x</div>';
    expect(capture({ snapshotId: "s7", index: 9, maxChars: 3_000_000 })).toEqual({
      error: "Element 9 of snapshot s7 not found \u2014 take a fresh browse_snapshot.",
    });
  });

  it("strips every data-pen-* attribute and the controller overlays", () => {
    document.body.innerHTML =
      '<div data-pen-snap="s1:0" data-pen-sig-target="1" id="k">keep</div>' +
      '<div data-pen-cursor="1">cursor</div><div data-pen-marks="1">marks</div>';
    const html = capture().html as string;
    expect(html).toContain("keep");
    expect(html).not.toContain("data-pen-");
    expect(html).not.toContain("cursor");
    expect(html).not.toContain("marks");
  });

  it("refuses a document over maxChars", () => {
    document.body.innerHTML = "<p>" + "x".repeat(5000) + "</p>";
    const res = capture({ snapshotId: null, index: null, maxChars: 1000 });
    expect(res.error).toMatch(/^Page is too large to capture \(\d+\.\dK characters, limit 1\.0K\)\.$/);
  });

  it("clones into an inert document: the live lazy image is untouched, the output has the promoted src", () => {
    document.body.innerHTML = '<img id="lz" src="data:image/gif;base64,R0lGOD" data-src="/real.jpg">';
    const live = document.getElementById("lz") as HTMLImageElement;
    const before = live.outerHTML;
    const html = capture().html as string;
    expect(html).toMatch(/src="http[^"]*\/real\.jpg"/);
    expect(live.outerHTML).toBe(before);
    expect(live.getAttribute("src")).toBe("data:image/gif;base64,R0lGOD");
    expect(document.querySelectorAll("img")).toHaveLength(1);
  });

  it("promotes data-srcset on img and picture sources, drops placeholder sources", () => {
    document.body.innerHTML =
      '<picture><source srcset="data:image/gif;base64,AAAA" data-srcset="/a.webp 1x, /b.webp 2x">' +
      '<source srcset="data:image/gif;base64,BBBB" media="(min-width:900px)">' +
      '<source data-src="/c.webp" type="image/webp">' +
      '<img src="data:image/gif;base64,R0lGOD" data-srcset="/i1.jpg 1x, /i2.jpg 2x"></picture>';
    const html = capture().html as string;
    expect(html).toMatch(/<source[^>]*srcset="http[^"]*\/a\.webp 1x, http[^"]*\/b\.webp 2x"/);
    expect(html).not.toContain("BBBB");
    expect(html).toMatch(/<source[^>]*srcset="http[^"]*\/c\.webp"/);
    expect(html).toMatch(/<img[^>]*srcset="http[^"]*\/i1\.jpg 1x, http[^"]*\/i2\.jpg 2x"/);
  });

  it("passes an empty-text <style> through its cssRules with absolute urls", () => {
    document.head.innerHTML = "<style></style>";
    const st = document.head.querySelector("style") as HTMLStyleElement;
    Object.defineProperty(st, "sheet", {
      value: { disabled: false, cssRules: [{ cssText: ".z{background:url(rel/z.png)}" }] },
      configurable: true,
    });
    document.body.innerHTML = "<p>x</p>";
    const html = capture().html as string;
    expect(html).toMatch(/\.z\{background:url\("http[^"]*\/rel\/z\.png"\)\}/);
    document.head.innerHTML = "";
  });

  it("flattens a shadow root and scopes its styles under data-capture-host with nesting", () => {
    document.body.innerHTML = '<div id="h"></div>';
    const host = document.getElementById("h") as HTMLElement;
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML =
      "<style>@font-face{font-family:F;src:url(f.woff2)} :host{display:block} :host(.on) b{color:red} b{color:blue}</style><b>in</b>";
    const html = capture().html as string;
    expect(html).toMatch(/<div id="h" data-capture-host="1">/);
    expect(html).toMatch(/<style>@font-face\{font-family:F;src:url\("http[^"]*\/f\.woff2"\)\}\n\[data-capture-host="1"\]\{/);
    expect(html).toContain("&{display:block}");
    expect(html).toContain("&:is(.on) b{color:red}");
    expect(html).toContain("<b>in</b>");
    // the shadow style is not hoisted into <head>
    expect(html.indexOf("data-capture-host")).toBeGreaterThan(html.indexOf("</head>"));
  });

  it("element mode inside a shadow root carries the enclosing root styles under the wrapper scope", () => {
    document.body.innerHTML = '<div id="h"></div>';
    const root = (document.getElementById("h") as HTMLElement).attachShadow({ mode: "open" });
    root.innerHTML = '<style>.c{color:green}</style><p class="c" data-pen-snap="s1:1">t</p>';
    const res = capture({ snapshotId: "s1", index: 1, maxChars: 3_000_000 });
    expect(res.error).toBeUndefined();
    expect(res.html).toMatch(/<div style="[^"]*" data-capture-host="1"><style>\[data-capture-host="1"\]\{\.c\{color:green\}\}<\/style><p class="c">t<\/p><\/div>/);
  });

  it("turns a canvas into an img keeping attributes, sized from its rect", () => {
    document.body.innerHTML = '<canvas id="cv" class="k" aria-label="chart" width="300" height="150" onclick="x()"></canvas>';
    const cv = document.getElementById("cv") as HTMLCanvasElement;
    cv.toDataURL = ((type?: string) => "data:" + (type || "image/png") + ";base64,QQ==") as any;
    const html = capture().html as string;
    expect(html).toMatch(/<img[^>]*class="k"/);
    expect(html).toContain('aria-label="chart"');
    expect(html).toContain('src="data:image/webp;base64,QQ=="');
    expect(html).toContain("width:100px;height:20px");
    expect(html).not.toMatch(/<img[^>]*\swidth=/);
    expect(html).not.toContain("onclick");
  });

  it("replaces an oversized canvas with an empty same-size placeholder", () => {
    document.body.innerHTML = '<canvas id="cv"></canvas>';
    (document.getElementById("cv") as HTMLCanvasElement).toDataURL = (() => "data:image/png;base64," + "A".repeat(500_001)) as any;
    const html = capture().html as string;
    expect(html).not.toContain("<img");
    expect(html).not.toContain("AAAA");
    expect(html).toContain('<div style="width:100px;height:20px"></div>');
  });

  it("keeps <html> attributes and bakes body custom properties into the body style", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    document.body.style.setProperty("--brand", "#123456");
    document.body.innerHTML = "<p>x</p>";
    const html = capture().html as string;
    expect(html).toMatch(/<html[^>]*data-theme="dark"/);
    expect(html).toMatch(/<body[^>]*style="[^"]*--brand:#123456/);
    document.documentElement.removeAttribute("data-theme");
    document.body.removeAttribute("style");
  });
});
