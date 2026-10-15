import { describe, expect, it, vi } from "vitest";
import { parse } from "postcss";
import selectorParser from "postcss-selector-parser";
import {
  importStatement,
  sheetCss,
  isBlockedIp,
  isFetchableStylesheetUrl,
  v1Shape,
  type ResolvedSheet,
  absolutizeCss,
  applyQueryResults,
  collectQueries,
  renderStyleTag,
  resolveImports as resolveSheets,
  serialize,
  type CaptureSource,
  type FetchText,
} from "../../src/controller/captureCss.js";

const BASE = "https://example.com/a/b/page.html";
const squash = (s: string) => s.replace(/\s+/g, " ").replace(/ ?([{}]) ?/g, "$1").trim();

function fakeFetch(files: Record<string, string | { status: number; text: string; contentType?: string } | Error>) {
  const calls: string[] = [];
  const fn: FetchText = async (url) => {
    calls.push(url);
    const f = files[url];
    if (f === undefined) return { status: 404, text: "" };
    if (f instanceof Error) throw f;
    if (typeof f === "string") return { status: 200, text: f, contentType: "text/css" };
    return f;
  };
  return { fn, calls };
}

/** Old-style view of a sheet: its fallback imports then its css. */
const flat = (r: ResolvedSheet) => [...r.fallbacks.map(importStatement), sheetCss(r)].filter(Boolean).join("");
const resolveImports = async (
  sources: CaptureSource[],
  fn: FetchText | undefined,
  limits: Partial<import("../../src/controller/captureCss.js").ImportLimits> = {},
) => (await resolveSheets(sources, fn, { limits })).map(flat);

const link = (href: string, media = ""): CaptureSource => ({ kind: "link", href, media });
const inline = (text: string, media = "", baseUrl = BASE): CaptureSource => ({ kind: "inline", text, baseUrl, media });

describe("absolutizeCss", () => {
  it("absolutizes quoted, single-quoted and unquoted url()", () => {
    const out = absolutizeCss(`a{background:url(i.png)} b{background:url("../j.png")} c{background:url('/k.png')}`, BASE);
    expect(out).toContain('url("https://example.com/a/b/i.png")');
    expect(out).toContain('url("https://example.com/a/j.png")');
    expect(out).toContain('url("https://example.com/k.png")');
  });

  it("leaves data:, #fragment, absolute and protocol-less-var urls alone", () => {
    const css = `a{background:url(data:image/png;base64,AAA)} b{filter:url(#f)} c{background:url(https://x.test/y.png)} d{background:url(var(--u))}`;
    expect(absolutizeCss(css, BASE)).toBe(css);
  });

  it("resolves protocol-relative urls and multiple urls in one value", () => {
    const out = absolutizeCss(`a{background:url(//cdn.test/a.png), url(b.png)}`, BASE);
    expect(out).toContain('url("https://cdn.test/a.png")');
    expect(out).toContain('url("https://example.com/a/b/b.png")');
  });

  it("rewrites @import strings and url() forms to absolute url()", () => {
    const out = absolutizeCss(`@import "x.css"; @import url(y.css) screen; @import url('/z.css');`, BASE);
    expect(out).toContain('@import url("https://example.com/a/b/x.css");');
    expect(out).toContain('@import url("https://example.com/a/b/y.css") screen;');
    expect(out).toContain('@import url("https://example.com/z.css");');
  });

  it("covers @font-face src and url() inside @media", () => {
    const out = absolutizeCss(`@font-face{font-family:F;src:url(f.woff2) format("woff2")} @media print{a{background:url(p.png)}}`, BASE);
    expect(out).toContain('url("https://example.com/a/b/f.woff2") format("woff2")');
    expect(out).toContain('url("https://example.com/a/b/p.png")');
  });

  it("does not touch url( inside strings", () => {
    const css = `a::after{content:"url(x.png)"}`;
    expect(absolutizeCss(css, BASE)).toBe(css);
  });

  it("falls back to regexes on css postcss cannot parse", () => {
    const out = absolutizeCss(`a{background:url(i.png)`, BASE);
    expect(out).toContain('url("https://example.com/a/b/i.png")');
  });
});

describe("resolveImports", () => {
  it("refuses a loopback stylesheet by default, and fetches it when isAllowed widens the policy", async () => {
    const { fn } = fakeFetch({ "http://127.0.0.1:5173/app.css": ".app{color:red}" });
    const [strict] = await resolveImports([link("http://127.0.0.1:5173/app.css")], fn);
    expect(strict).not.toContain(".app");
    const [wide] = (
      await resolveSheets([link("http://127.0.0.1:5173/app.css")], fn, {
        isAllowed: (u) => u.startsWith("http://127.0.0.1:5173/"),
      })
    ).map(flat);
    expect(wide).toContain(".app");
  });

  it("fetches a link and absolutizes its urls against the file url", async () => {
    const { fn } = fakeFetch({ "https://cdn.test/css/site.css": "a{background:url(../img/x.png)}" });
    const [out] = await resolveImports([link("https://cdn.test/css/site.css")], fn);
    expect(out).toContain('url("https://cdn.test/img/x.png")');
  });

  it("inlines @import recursively, resolving each against its own file", async () => {
    const { fn } = fakeFetch({
      "https://cdn.test/a/main.css": '@import "sub/one.css"; .m{color:red}',
      "https://cdn.test/a/sub/one.css": "@import url(two.css); .one{background:url(o.png)}",
      "https://cdn.test/a/sub/two.css": ".two{color:blue}",
    });
    const [out] = await resolveImports([link("https://cdn.test/a/main.css")], fn);
    const s = squash(out);
    expect(s).not.toContain("@import");
    expect(s.indexOf(".two")).toBeLessThan(s.indexOf(".one"));
    expect(s.indexOf(".one")).toBeLessThan(s.indexOf(".m"));
    expect(s).toContain('url("https://cdn.test/a/sub/o.png")');
  });

  it("inlines an @import with media / layer / supports inside the matching blocks", async () => {
    const { fn } = fakeFetch({
      "https://cdn.test/m.css": ".m{color:red}",
      "https://cdn.test/l.css": ".l{color:red}",
      "https://cdn.test/s.css": ".s{color:red}",
      "https://cdn.test/all.css": ".all{color:red}",
      "https://cdn.test/anon.css": ".anon{color:red}",
    });
    const [out] = await resolveImports(
      [
        inline(
          '@import url("https://cdn.test/m.css") screen and (min-width:600px);' +
            '@import url("https://cdn.test/l.css") layer(base);' +
            '@import url("https://cdn.test/s.css") supports(display:grid);' +
            '@import url("https://cdn.test/anon.css") layer;' +
            '@import url("https://cdn.test/all.css") layer(a) supports(not (display:grid)) print;',
        ),
      ],
      fn,
    );
    const s = squash(out);
    expect(s).toContain("@media screen and (min-width:600px){.m{color:red}");
    expect(s).toContain("@layer base{.l{color:red}");
    expect(s).toContain("@supports (display:grid){.s{color:red}");
    expect(s).toContain("@layer{.anon{color:red}");
    expect(s).toMatch(/@layer a\{@supports not \(display:grid\)\{@media print\{\.all\{color:red\}/);
  });

  it("wraps a link media (not all) in @media", async () => {
    const { fn } = fakeFetch({ "https://cdn.test/p.css": "a{color:red}", "https://cdn.test/q.css": "b{color:red}" });
    const [a, b] = await resolveImports([link("https://cdn.test/p.css", "print"), link("https://cdn.test/q.css", "all")], fn);
    expect(squash(a)).toBe("@media print{a{color:red}}");
    expect(squash(b)).toBe("b{color:red}");
  });

  it("wraps an inline <style media> in @media", async () => {
    const [out] = await resolveImports([inline("a{color:red}", "(max-width:600px)")], undefined);
    expect(squash(out)).toBe("@media (max-width:600px){a{color:red}}");
  });

  it("falls back to the literal @import when the fetch fails (status, throw, html)", async () => {
    const { fn } = fakeFetch({
      "https://cdn.test/404.css": { status: 404, text: "x" },
      "https://cdn.test/boom.css": new Error("net"),
      "https://cdn.test/html.css": { status: 200, text: "<html>", contentType: "text/html" },
    });
    const out = await resolveImports([link("https://cdn.test/404.css"), link("https://cdn.test/boom.css"), link("https://cdn.test/html.css", "print")], fn);
    expect(out[0]).toBe('@import url("https://cdn.test/404.css");');
    expect(out[1]).toBe('@import url("https://cdn.test/boom.css");');
    expect(out[2]).toBe('@import url("https://cdn.test/html.css") print;');
  });

  it("falls back to @import for every link when fetchText is missing, keeping order", async () => {
    const out = await resolveImports([link("https://a.test/1.css"), inline(".x{color:red}"), link("https://a.test/2.css")], undefined);
    expect(out).toEqual(['@import url("https://a.test/1.css");', ".x{color:red}", '@import url("https://a.test/2.css");']);
  });

  it("emits every failed nested @import as its own fallback, before the sheet, in order", async () => {
    const { fn } = fakeFetch({
      "https://cdn.test/main.css": "@import url(a.css); @import url(b.css) print; .m{color:red}",
      "https://cdn.test/a.css": ".a{color:red}",
      "https://cdn.test/b.css": "@import url(missing.css) layer(x) supports(display:grid); .b{color:red}",
    });
    const [sheet] = await resolveSheets([link("https://cdn.test/main.css")], fn);
    expect(sheet.fallbacks).toEqual(['url("https://cdn.test/missing.css") layer(x) supports((display:grid)) print']);
    expect(sheetCss(sheet)).not.toContain("@import");
    const s = squash(sheetCss(sheet));
    expect(s.indexOf(".a{")).toBeLessThan(s.indexOf(".b{"));
    expect(s).toContain("@media print{.b{color:red}}");
    expect(s).toContain(".m{color:red}");
  });

  it("a failed link keeps its media in the fallback and has no css of its own", async () => {
    const [sheet] = await resolveSheets([link("https://cdn.test/x.css", "print")], fakeFetch({}).fn);
    expect(sheet).toEqual({ root: null, text: "", fallbacks: ['url("https://cdn.test/x.css") print'], dropped: 0 });
  });

  it("refuses unsafe urls without calling fetchText (falls back to @import)", async () => {
    const { fn, calls } = fakeFetch({ "http://127.0.0.1/a.css": "a{}" });
    const out = await resolveSheets(
      [link("http://127.0.0.1/a.css"), inline('@import url("http://169.254.169.254/x.css"); .k{color:red}')],
      fn,
    );
    expect(calls).toEqual([]);
    expect(out[0].fallbacks).toEqual(['url("http://127.0.0.1/a.css")']);
    expect(out[1].fallbacks).toEqual(['url("http://169.254.169.254/x.css")']);
  });

  describe("deadline", () => {
    const at = (t: number) => ({ deadlineAt: 100_000, now: () => t });
    it("starts no request with under 8 s left; the sheet falls back", async () => {
      const { fn, calls } = fakeFetch({ "https://cdn.test/a.css": "a{}" });
      const [sheet] = await resolveSheets([link("https://cdn.test/a.css")], fn, at(92_500));
      expect(calls).toEqual([]);
      expect(sheet.fallbacks).toHaveLength(1);
    });
    it("fetches with enough time left and caps the file timeout at deadline - 3 s", async () => {
      const seen: { timeoutMs: number }[] = [];
      const fn: FetchText = async (_u, o) => {
        seen.push(o);
        return { status: 200, text: "a{}" };
      };
      await resolveSheets([link("https://cdn.test/a.css")], fn, at(88_000)); // 12 s left
      expect(seen[0].timeoutMs).toBe(8_000);
      await resolveSheets([link("https://cdn.test/b.css")], fn, at(90_000)); // 10 s left
      expect(seen[1].timeoutMs).toBe(7_000);
    });
    it("aborts a pending request at deadline - 3 s and falls back", async () => {
      vi.useFakeTimers();
      try {
        let aborted = false;
        const fn: FetchText = (_u, o) =>
          new Promise(() => {
            o.signal?.addEventListener("abort", () => (aborted = true));
          });
        const pending = resolveSheets([link("https://cdn.test/a.css")], fn, { deadlineAt: 100_000, now: () => 90_000 });
        await vi.advanceTimersByTimeAsync(6_999);
        expect(aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(2);
        expect(aborted).toBe(true);
        expect((await pending)[0].fallbacks).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("v1Shape: links become fallback imports, inline text is absolutized, nothing inlined", () => {
    const out = v1Shape([link("https://cdn.test/a.css", "print"), inline(".x{background:url(i.png)}", "screen")]);
    expect(out[0]).toEqual({ root: null, text: "", fallbacks: ['url("https://cdn.test/a.css") print'], dropped: 0 });
    expect(out[1].fallbacks).toEqual([]);
    expect(squash(sheetCss(out[1]))).toBe('@media screen{.x{background:url("https://example.com/a/b/i.png")}}');
  });
});

describe("fallback conditions, leftover statements, unparseable text", () => {
  const sheetOf = async (src: CaptureSource, files: Record<string, string> = {}) =>
    (await resolveSheets([src], fakeFetch(files).fn))[0];

  it("a failing nested import keeps the media of its print link", async () => {
    const s = await sheetOf(link("https://cdn.test/main.css", "print"), { "https://cdn.test/main.css": "@import url(gone.css); .m{color:red}" });
    expect(s.fallbacks).toEqual(['url("https://cdn.test/gone.css") print']);
    expect(squash(sheetCss(s))).toBe("@media print{.m{color:red}}");
  });

  it("a failing nested import keeps the layer(base) it was imported under", async () => {
    const s = await sheetOf(inline('@import url("https://cdn.test/sub.css") layer(base);'), {
      "https://cdn.test/sub.css": "@import url(gone.css); .s{color:red}",
    });
    expect(s.fallbacks).toEqual(['url("https://cdn.test/gone.css") layer(base)']);
  });

  it("combines media chains with and, supports and layer ride on the @import", async () => {
    const s = await sheetOf(link("https://cdn.test/main.css", "print"), {
      "https://cdn.test/main.css": '@import url("https://cdn.test/a.css") layer(x) supports(display:grid) (min-width:600px);',
      "https://cdn.test/a.css": "@import url(gone.css);",
    });
    expect(s.fallbacks).toEqual(['url("https://cdn.test/gone.css") layer(x) supports((display:grid)) print and (min-width:600px)']);
  });

  it("drops a fallback whose conditions cannot be expressed, and counts it", async () => {
    const cases: [CaptureSource, Record<string, string>][] = [
      // two media types
      [link("https://cdn.test/m.css", "print"), { "https://cdn.test/m.css": '@import url("https://cdn.test/n.css") screen;', "https://cdn.test/n.css": "@import url(gone.css);" }],
      // a media list with a top-level comma next to another media
      [link("https://cdn.test/m.css", "print"), { "https://cdn.test/m.css": '@import url("https://cdn.test/n.css") screen, tv;', "https://cdn.test/n.css": "@import url(gone.css);" }],
      // two layers
      [inline('@import url("https://cdn.test/n.css") layer(a);'), { "https://cdn.test/n.css": '@import url("https://cdn.test/o.css") layer(b);', "https://cdn.test/o.css": "@import url(gone.css);" }],
      // two supports
      [inline('@import url("https://cdn.test/n.css") supports(display:grid);'), { "https://cdn.test/n.css": '@import url("https://cdn.test/o.css") supports(color:red);', "https://cdn.test/o.css": "@import url(gone.css);" }],
      // not/only cannot be and-ed
      [link("https://cdn.test/m.css", "print"), { "https://cdn.test/m.css": '@import url("https://cdn.test/n.css") not screen;', "https://cdn.test/n.css": "@import url(gone.css);" }],
    ];
    for (const [src, files] of cases) {
      const s = await sheetOf(src, files);
      expect(s.fallbacks).toEqual([]);
      expect(s.dropped).toBe(1);
    }
  });

  it("hoists leftover @charset / @import / @namespace to the top, outside the media wrapper", async () => {
    const [s] = await resolveSheets(
      [
        inline(
          '@charset "utf-8"; @namespace svg url("http://www.w3.org/2000/svg"); .x{color:red} @import url(data:text/css;base64,YXtjb2xvcjpyZWR9);',
          "print",
        ),
      ],
      undefined,
    );
    expect(squash(sheetCss(s))).toBe(
      '@charset "utf-8";@import url("data:text/css;base64,YXtjb2xvcjpyZWR9") print;@namespace svg url("http://www.w3.org/2000/svg");@media print{.x{color:red}}',
    );
  });

  it("hoists a @namespace out of an inlined import's wrapper, and a data: @import with its conditions", async () => {
    const s = await sheetOf(inline('@import url("https://cdn.test/sub.css") screen;'), {
      "https://cdn.test/sub.css": '@namespace svg url("http://www.w3.org/2000/svg"); @import url(data:text/css;base64,YQ==); .s{color:red}',
    });
    const css = squash(sheetCss(s));
    expect(css.startsWith('@import url("data:text/css;base64,YQ==") screen;')).toBe(true);
    expect(css).toContain('@namespace svg url("http://www.w3.org/2000/svg");');
    expect(css.indexOf("@namespace")).toBeLessThan(css.indexOf("@media screen"));
    expect(css).toContain("@media screen{.s{color:red}}");
  });

  it("drops a leftover import whose wrapper conditions are inexpressible", async () => {
    const s = await sheetOf(inline("@container (min-width:1px){@import url(data:text/css;base64,YQ==);} .k{color:red}"));
    expect(sheetCss(s)).not.toContain("@import");
    expect(s.dropped).toBe(1);
  });

  it("absolutizes an unparseable inline sheet with the regex path", async () => {
    const [s] = await resolveSheets([inline(".a{background:url(rel/x.png)", "", "https://example.com/p/")], undefined);
    expect(sheetCss(s)).toBe('.a{background:url("https://example.com/p/rel/x.png")');
  });
});

describe("isFetchableStylesheetUrl / isBlockedIp", () => {
  const ok = [
    "https://cdn.test/a.css",
    "http://example.com/a.css",
    "https://93.184.216.34/a.css",
    "https://[2606:4700:4700::1111]/a.css",
    "https://100.63.255.255/a.css",
    "https://172.32.0.1/a.css",
    "https://notlocal.test/a.css",
    "https://[2001:4860:4860::8888]/a.css",
    "https://[2606:4700::1]/a.css",
  ];
  const bad = [
    "ftp://cdn.test/a.css",
    "file:///etc/passwd",
    "data:text/css,a{}",
    "javascript:1",
    "not a url",
    "https://user:pw@cdn.test/a.css",
    "https://user@cdn.test/a.css",
    "http://localhost/a.css",
    "http://LOCALHOST./a.css",
    "http://foo.localhost/a.css",
    "http://printer.local/a.css",
    "http://db.internal/a.css",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://127.0.0.1/a.css",
    "http://127.1.2.3/a.css",
    "http://2130706433/a.css", // decimal 127.0.0.1
    "http://0x7f.0.0.1/a.css",
    "http://0.0.0.0/a.css",
    "http://10.1.2.3/a.css",
    "http://172.16.0.1/a.css",
    "http://172.31.255.255/a.css",
    "http://192.168.1.1/a.css",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/a.css",
    "http://100.127.255.255/a.css",
    "http://224.0.0.1/a.css",
    "http://255.255.255.255/a.css",
    "http://[::1]/a.css",
    "http://[::]/a.css",
    "http://[::ffff:127.0.0.1]/a.css",
    "http://[::ffff:10.0.0.1]/a.css",
    "http://[::ffff:a9fe:a9fe]/a.css", // mapped 169.254.169.254
    "http://[fc00::1]/a.css",
    "http://[fd12:3456::1]/a.css",
    "http://[fe80::1]/a.css",
    "http://[febf::1]/a.css",
    "http://[ff02::1]/a.css",
    "http://[64:ff9b::7f00:1]/a.css",
    "http://[2002:7f00:1::]/a.css",
    "http://[::ffff:93.184.216.34]/a.css", // whole ::ffff:0:0/96 is refused, even for a public IPv4
    "http://[::ffff:0:93.184.216.34]/a.css", // IPv4-translated
    "http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/a.css", // Teredo
    "http://[64:ff9b:1::1]/a.css", // NAT64 local-use
    "http://192.0.2.1/a.css",
    "http://198.51.100.7/a.css",
    "http://203.0.113.9/a.css",
  ];
  it.each(ok)("allows %s", (u) => expect(isFetchableStylesheetUrl(u)).toBe(true));
  it.each(bad)("refuses %s", (u) => expect(isFetchableStylesheetUrl(u)).toBe(false));

  it("isBlockedIp judges bare and bracketed literals, and never blocks host names", () => {
    expect(isBlockedIp("10.0.0.1")).toBe(true);
    expect(isBlockedIp("[::1]")).toBe(true);
    expect(isBlockedIp("fe80::1%eth0")).toBe(true);
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    expect(isBlockedIp("2001:4860:4860::8888")).toBe(false);
    expect(isBlockedIp("example.com")).toBe(false);
  });
});

describe("resolveImports (more)", () => {
  it("(placeholder to keep numbering)", () => {
    expect(true).toBe(true);
  });
  it("breaks an @import cycle", async () => {
    const { fn, calls } = fakeFetch({
      "https://cdn.test/a.css": '@import "b.css"; .a{color:red}',
      "https://cdn.test/b.css": '@import "a.css"; .b{color:red}',
    });
    const [out] = await resolveImports([link("https://cdn.test/a.css")], fn);
    expect(out).toContain(".a{color:red}");
    expect(out).toContain(".b{color:red}");
    expect(out).not.toContain("@import");
    expect(calls).toEqual(["https://cdn.test/a.css", "https://cdn.test/b.css"]);
  });

  it("caps the import depth: deeper files fall back to a literal @import", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= 6; i++) files[`https://cdn.test/${i}.css`] = `@import "${i + 1}.css"; .d${i}{color:red}`;
    const { fn, calls } = fakeFetch(files);
    const [out] = await resolveImports([link("https://cdn.test/0.css")], fn);
    expect(calls).toHaveLength(5); // depth 0..4
    expect(out).toContain(".d4{color:red}");
    expect(out).not.toContain(".d5");
    expect(out).toContain('@import url("https://cdn.test/5.css");');
  });

  it("caps the number of files", async () => {
    const files: Record<string, string> = {};
    const sources: CaptureSource[] = [];
    for (let i = 0; i < 8; i++) {
      files[`https://cdn.test/${i}.css`] = `.f${i}{color:red}`;
      sources.push(link(`https://cdn.test/${i}.css`));
    }
    const { fn, calls } = fakeFetch(files);
    const out = await resolveImports(sources, fn, { maxFiles: 5 });
    expect(calls).toHaveLength(5);
    expect(out.filter((o) => o.startsWith("@import"))).toHaveLength(3);
  });

  it("enforces the per-file and total size caps", async () => {
    const { fn } = fakeFetch({
      "https://cdn.test/big.css": "a{color:red}".repeat(100),
      "https://cdn.test/s1.css": "a{color:red}",
      "https://cdn.test/s2.css": "b{color:red}",
    });
    const [big] = await resolveImports([link("https://cdn.test/big.css")], fn, { fileMaxBytes: 100 });
    expect(big).toBe('@import url("https://cdn.test/big.css");');
    const out = await resolveImports([link("https://cdn.test/s1.css"), link("https://cdn.test/s2.css")], fn, { totalMaxBytes: 15 });
    expect(out[0]).toBe("a{color:red}");
    expect(out[1]).toBe('@import url("https://cdn.test/s2.css");');
  });

  it("passes the limits to fetchText and times a hung fetch out", async () => {
    const seen: unknown[] = [];
    const hung: FetchText = (_u, opts) => {
      seen.push(opts);
      return new Promise(() => {});
    };
    const [out] = await resolveImports([link("https://cdn.test/h.css")], hung, { fileTimeoutMs: 20 });
    expect(out).toBe('@import url("https://cdn.test/h.css");');
    expect(seen[0]).toMatchObject({ timeoutMs: 20, maxBytes: 3_000_000 });
  });

  it("runs at most 6 fetches at once", async () => {
    let active = 0;
    let peak = 0;
    const fn: FetchText = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { status: 200, text: "a{color:red}" };
    };
    await resolveImports(Array.from({ length: 20 }, (_, i) => link(`https://cdn.test/${i}.css`)), fn);
    expect(peak).toBeLessThanOrEqual(6);
    expect(peak).toBeGreaterThan(1);
  });

  it("fetches a shared file once", async () => {
    const { fn, calls } = fakeFetch({ "https://cdn.test/shared.css": ".s{color:red}" });
    await resolveImports([link("https://cdn.test/shared.css"), inline('@import "https://cdn.test/shared.css";')], fn);
    expect(calls).toEqual(["https://cdn.test/shared.css"]);
  });

  it("absolutizes inline and adopted text against their baseUrl", async () => {
    const out = await resolveImports(
      [inline(".x{background:url(i.png)}"), { kind: "adopted", text: ".y{background:url(j.png)}", baseUrl: "https://other.test/q/" }],
      undefined,
    );
    expect(out[0]).toContain('url("https://example.com/a/b/i.png")');
    expect(out[1]).toContain('url("https://other.test/q/j.png")');
  });

  it("emits unparseable css as it came", async () => {
    const [out] = await resolveImports([inline("a{color:red")], undefined);
    expect(out).toBe("a{color:red");
  });
});

function run(css: string, opts: { root?: string[]; existing?: string[]; unparseable?: string[] } = {}) {
  const root = parse(css);
  applyQueryResults(root, new Set(opts.root ?? []), new Set(opts.existing ?? []), new Set(opts.unparseable ?? []));
  return squash(serialize(root));
}

describe("collectQueries", () => {
  it("collects existence tests for every complex selector in a list and dedupes", () => {
    const q = collectQueries(parse(".a, .b > .c {x:1} .a{y:1}"));
    expect(q.selectors.sort()).toEqual([".a", ".b > .c", ":root > .c"]);
    expect(q.rootCompounds.sort()).toEqual([".a", ".b"]);
  });

  it("collects classless first compounds and the reduced existence test", () => {
    const q = collectQueries(parse(".vec:not(.x) .y{x:1} [data-theme=dark] > .z{x:1} a .w{x:1}"));
    expect(q.rootCompounds.sort()).toEqual([".vec:not(.x)", "[data-theme=dark]"].sort());
    expect(q.selectors).toContain(".y");
    expect(q.selectors).toContain(":root > .z");
    expect(q.selectors).toContain("[data-theme=dark] > .z");
    expect(q.selectors).not.toContain("a");
  });

  it("strips user-action and element pseudos, an emptied compound becomes *", () => {
    const q = collectQueries(parse("a:hover::before{x:1} :focus-visible{x:1} .x:active > b:visited{x:1} p::-webkit-scrollbar{x:1} input:-moz-placeholder{x:1} li:first-letter{x:1}"));
    expect(q.selectors.sort()).toEqual(expect.arrayContaining(["*", ".x > b", "a", "input", "li", "p"]));
  });

  it("collects the root compound of html / :root selectors, stripped", () => {
    const q = collectQueries(parse("html.dark body{x:1} :root{x:1} html:hover .x{x:1} .x html{x:1}"));
    expect(q.rootCompounds.sort()).toEqual([".x", ":root", "html", "html.dark"].sort());
    expect(q.selectors).toContain("html.dark body");
    expect(q.selectors).toContain("html .x");
  });

  it("keeps :is()/:not()/:has() intact in the existence test", () => {
    const q = collectQueries(parse(".a:not(.b) :is(.c, .d) > e:has(> f){x:1}"));
    expect(q.selectors).toContain(".a:not(.b) :is(.c, .d) > e:has(> f)");
  });

  it("does not test selectors with a user-action pseudo nested in a functional pseudo", () => {
    expect(collectQueries(parse("a:not(:hover){x:1}")).selectors).toEqual([]);
  });

  it("skips @keyframes, nested rules, :host and unparseable selectors", () => {
    const q = collectQueries(
      parse("@keyframes k{from{x:1} 50%{x:1}} .p{ .n{x:1} &:hover{x:1} } :host(.a) b{x:1}"),
    );
    expect(q.selectors).toEqual([".p"]);
  });

  it("walks into @media / @supports / @layer / @container", () => {
    const q = collectQueries(parse("@media print{.m{x:1}} @supports (display:grid){.s{x:1}} @layer l{.l{x:1}} @container (min-width:1px){.c{x:1}}"));
    expect(q.selectors.sort()).toEqual([".c", ".l", ".m", ".s"]);
  });

  it("accepts several roots", () => {
    const q = collectQueries([parse(".a{x:1}"), parse(".b{x:1}")]);
    expect(q.selectors.sort()).toEqual([".a", ".b"]);
  });
});

describe("applyQueryResults", () => {
  it("rewrites a matched root compound to :is(:root,:host)", () => {
    expect(run("html.dark body .x{color:red}", { root: ["html.dark"], existing: ["html.dark body .x"] })).toBe(
      ":is(:where(:root,:host),html.dark:not(*)) body .x{color:red}",
    );
    expect(run(":root{--a:1}", { root: [":root"] })).toBe(":is(:where(:root,:host),:root:not(*)){--a:1}");
    expect(run("html > body{x:1}", { root: ["html"], existing: ["html > body"] })).toBe(":is(:where(:root,:host),html:not(*)) > body{x:1}");
  });

  it("keeps stripped pseudos on the rewritten root compound", () => {
    expect(run("html:hover .x{x:1}", { root: ["html"], existing: ["html .x"] })).toBe(":is(:where(:root,:host),html:not(*)):hover .x{x:1}");
    expect(run("html::selection{x:1}", { root: ["html"], existing: ["html"] })).toBe(":is(:where(:root,:host),html:not(*))::selection{x:1}");
  });

  it("drops a selector whose root compound did not match, and the rule when none is left", () => {
    expect(run("html.light .x{x:1}", { root: [], existing: ["html.light .x"] })).toBe("");
    expect(run("html.light .x, .y{x:1}", { root: [], existing: ["html.light .x", ".y"] })).toBe(".y{x:1}");
  });

  it("does not run the existence test for a root-only selector (element mode)", () => {
    expect(run(":root{--a:1}", { root: [":root"], existing: [] })).toBe(":is(:where(:root,:host),:root:not(*)){--a:1}");
  });

  it("drops selectors without a match and keeps the rest of the list", () => {
    expect(run(".a, .b, .c{x:1}", { existing: [".b"] })).toBe(".b{x:1}");
    expect(run(".a{x:1} .b{y:1}", { existing: [".b"] })).toBe(".b{y:1}");
  });

  it("keeps a selector the page could not parse", () => {
    expect(run(".a, .weird{x:1}", { unparseable: [".weird"] })).toBe(".weird{x:1}");
  });

  it("keeps :is()/:not()/:has() selectors untouched when they exist", () => {
    const css = ".a:not(.b) :is(.c, .d) > e:has(> f){x:1}";
    expect(run(css, { existing: [".a:not(.b) :is(.c, .d) > e:has(> f)"] })).toBe(css);
  });

  it("tests a stripped selector by its stripped form but keeps the original text", () => {
    expect(run("a:hover::before{x:1}", { existing: ["a"] })).toBe("a:hover::before{x:1}");
    expect(run("a:hover::before{x:1}", { existing: [] })).toBe("");
  });

  it("never prunes @keyframes steps, @font-face, @property, @page, @counter-style, @namespace, @charset, @layer statements", () => {
    const css =
      '@charset "utf-8"; @namespace svg url(http://www.w3.org/2000/svg); @layer a, b; @font-face{font-family:F;src:url(f.woff2)} ' +
      "@keyframes k{from{opacity:0} 50%{opacity:.5} to{opacity:1}} @-webkit-keyframes k{from{opacity:0}} " +
      '@property --x{syntax:"<length>";inherits:false;initial-value:0px} @page{margin:1cm} @counter-style c{system:cyclic;symbols:"*"}';
    expect(run(css)).toBe(squash(css));
  });

  it("prunes nested @media and drops blocks that end up empty", () => {
    const out = run("@media screen{@media (min-width:1px){.gone{x:1}} .keep{x:1}} @media print{.gone2{x:1}} @supports (display:grid){.gone3{x:1}}", {
      existing: [".keep"],
    });
    expect(out).toBe("@media screen{.keep{x:1}}");
  });

  it("keeps @font-face inside an otherwise emptied @media", () => {
    const out = run("@media screen{@font-face{font-family:F;src:url(f.woff2)} .gone{x:1}}", {});
    expect(out).toBe("@media screen{@font-face{font-family:F;src:url(f.woff2)}}");
  });

  it("turns an emptied named @layer block into a statement so the layer order survives", () => {
    expect(run("@layer base{.gone{x:1}} @layer anon2{.keep{x:1}}", { existing: [".keep"] })).toBe("@layer base; @layer anon2{.keep{x:1}}");
    expect(run("@layer{.gone{x:1}}", {})).toBe("");
  });

  it("leaves nested style rules and their parent alone", () => {
    const css = ".p{color:red; .n{x:1} &:hover{x:1}}";
    expect(run(css, { existing: [".p"] })).toBe(squash(css));
    expect(run(css, { existing: [] })).toBe("");
  });

  it("leaves :host and unparseable-by-postcss-selector-parser rules alone", () => {
    expect(run(":host(.a) b{x:1}")).toBe(":host(.a) b{x:1}");
  });
});

describe("classless root compounds", () => {
  it("rewrites a matched classless first compound and keeps the rule", () => {
    expect(run(".vec .x{y:1}", { root: [".vec"], existing: [".x"] })).toBe(":is(.vec,:where(:root,:host)) .x{y:1}");
    expect(run(".dark:not(.k) .x{y:1}", { root: [".dark:not(.k)"], existing: [".x"] })).toBe(
      ":is(.dark:not(.k),:where(:root,:host)) .x{y:1}",
    );
    expect(run("[data-theme=dark]{--a:1}", { root: ["[data-theme=dark]"] })).toBe(
      ":is([data-theme=dark],:where(:root,:host)){--a:1}",
    );
  });

  it("leaves the selector untouched when <html> does not match (never drops it)", () => {
    expect(run(".card .x{y:1}", { root: [], existing: [".card .x"] })).toBe(".card .x{y:1}");
  });

  it("handles the child combinator with :root > reduced test", () => {
    expect(run(".vec > .x{y:1}", { root: [".vec"], existing: [":root > .x"] })).toBe(":is(.vec,:where(:root,:host)) > .x{y:1}");
    expect(run(".vec > .x{y:1}", { root: [".vec"], existing: [".x"] })).toBe("");
  });

  it("rewrites only the matching member of a selector list", () => {
    expect(run(".vec .a, .other .b{y:1}", { root: [".vec"], existing: [".a", ".other .b"] })).toBe(
      ":is(.vec,:where(:root,:host)) .a, .other .b{y:1}",
    );
  });

  it("keeps a matched selector when EITHER the reduced or the original test matches", () => {
    expect(run(".vec .x{y:1}", { root: [".vec"], existing: [".x"] })).toContain(":is(.vec");
    expect(run(".vec .x{y:1}", { root: [".vec"], existing: [".vec .x"] })).toContain(":is(.vec");
    expect(run(".vec .x{y:1}", { root: [".vec"], existing: [] })).toBe("");
    expect(run(".vec > .x{y:1}", { root: [".vec"], existing: [".vec > .x"] })).toContain(":is(.vec");
    expect(run(".vec > .x{y:1}", { root: [".vec"], existing: [":root > .x"] })).toContain(":is(.vec");
  });

  it("keeps stripped pseudos and skips typed or empty first compounds", () => {
    expect(run(".vec:hover .x{y:1}", { root: [".vec"], existing: [".x"] })).toBe(":is(.vec,:where(:root,:host)):hover .x{y:1}");
    expect(collectQueries(parse("div .x{y:1} :hover .x{y:1}")).rootCompounds).toEqual([]);
  });
});

/** (ids, classes+attributes+pseudo-classes, types) of one selector. */
function specificity(selector: string): [number, number, number] {
  const sp = (sel: selectorParser.Selector): [number, number, number] => {
    const t: [number, number, number] = [0, 0, 0];
    for (const n of sel.nodes) {
      if (n.type === "id") t[0]++;
      else if (n.type === "class" || n.type === "attribute") t[1]++;
      else if (n.type === "tag") t[2]++;
      else if (n.type === "pseudo") {
        const v = n.value.toLowerCase();
        if (v.startsWith("::")) t[2]++;
        else if (v === ":is" || v === ":not" || v === ":has") {
          const best = n.nodes.map(sp).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]).pop() ?? [0, 0, 0];
          t[0] += best[0];
          t[1] += best[1];
          t[2] += best[2];
        } else if (v === ":where") {
          // zero
        } else t[1]++;
      }
    }
    return t;
  };
  return sp(selectorParser().astSync(selector).nodes[0]);
}

describe("specificity of rewritten root selectors", () => {
  it("keeps :root[data-theme=dark] at (0,2,0) so it still beats a later :root", () => {
    const out = run(":root[data-theme=dark]{--a:1} :root{--a:2}", { root: [":root[data-theme=dark]", ":root"] });
    const [dark, plain] = parse(out).nodes.map((n) => (n as { selector: string }).selector);
    expect(dark).toBe(":is(:where(:root,:host),:root[data-theme=dark]:not(*))");
    expect(specificity(dark)).toEqual([0, 2, 0]);
    expect(specificity(":root")).toEqual([0, 1, 0]);
    expect(specificity(plain)).toEqual([0, 1, 0]);
  });
  it("html body stays (0,0,2); :root (0,1,0) still beats a later html (0,0,1)", () => {
    const out = run("html body{a:1} :root{b:1} html{c:1}", { root: ["html", ":root"], existing: ["html body"] });
    const sels = parse(out).nodes.map((n) => (n as { selector: string }).selector);
    expect(sels.map(specificity)).toEqual([[0, 0, 2], [0, 1, 0], [0, 0, 1]]);
  });
  it("a classless matched compound keeps its own specificity", () => {
    expect(specificity(":is(.vec,:where(:root,:host)) .x")).toEqual([0, 2, 0]);
  });
  it("html.dark keeps (0,1,1)", () => {
    expect(specificity(":is(:where(:root,:host),html.dark:not(*))")).toEqual([0, 1, 1]);
  });
});

describe("serialize / renderStyleTag", () => {
  it("round-trips untouched css", () => {
    const css = "a { color : red }\n/* c */\nb{x:1}";
    expect(serialize(parse(css))).toBe(css);
  });

  it("escapes every < as the CSS escape so </style cannot close the tag and svg data urls survive sanitizers", () => {
    const tag = renderStyleTag('a::after{content:"</style><script>x()</script>"} b{background:url("data:image/svg+xml,<svg/>")}');
    expect(tag).toBe(
      '<style>a::after{content:"\\3c /style>\\3c script>x()\\3c /script>"} b{background:url("data:image/svg+xml,\\3c svg/>")}</style>',
    );
    expect(tag.indexOf("</style")).toBe(tag.length - "</style>".length);
  });
});

describe("pipeline sanity", () => {
  it("link + root rewrite + prune end to end", async () => {
    const fetchText = vi.fn(async () => ({
      status: 200,
      text: "html.dark{--bg:#000} .used{background:url(i.png)} .unused{color:red}",
      contentType: "text/css",
    }));
    const [css] = await resolveImports([link("https://cdn.test/css/s.css")], fetchText);
    const root = parse(css);
    const q = collectQueries(root);
    expect(q.rootCompounds).toEqual(expect.arrayContaining(["html.dark"]));
    applyQueryResults(root, new Set(["html.dark"]), new Set([".used"]), new Set());
    const out = squash(serialize(root));
    expect(out).toContain(":is(:where(:root,:host),html.dark:not(*)){--bg:#000}");
    expect(out).toContain('.used{background:url("https://cdn.test/css/i.png")}');
    expect(out).not.toContain(".unused");
  });
});
