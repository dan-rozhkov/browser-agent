import { describe, expect, it } from "vitest";
import { mergeCarriedDialogs } from "../../src/shared/dialogs.js";
import {
  BROWSE_TRACE_ASSET_PATH,
  BROWSE_TRACE_ID,
  mapTraceFrames,
  parseBrowseTrace,
  redactTraceArgs,
  splitTraceAssets,
  type BrowseTrace,
} from "../../src/shared/trace.js";

const JPG = "data:image/jpeg;base64,QUJD";
const PNG = "data:image/png;base64,QUJD";

function sample(): BrowseTrace {
  return {
    format: "sideform.browse-trace",
    version: 1,
    id: "abc_123-X",
    goal: "g",
    startedAt: 1,
    endedAt: 2,
    status: "done",
    steps: [{ index: 0, tool: "browse_open", args: {}, startedAt: 1, endedAt: 2, ok: true }],
    frames: [
      { id: 0, at: 1, kind: "step", src: JPG, stepIndex: 0 },
      { id: 1, at: 2, kind: "final", src: PNG },
      { id: 2, at: 2, kind: "step", src: "https://cdn.test/x.png" },
    ],
    console: [{ at: 1, text: "boom" }],
    network: [],
  };
}

describe("redactTraceArgs", () => {
  it("redacts secret-looking keys, recursively, and cuts long strings", () => {
    const out = redactTraceArgs({ text: "hi", password: "p", nested: { apiKey: "k", "api-key": "k", items: [{ otp: "1", ok: "x" }] }, card_number: "4", long: "x".repeat(3000) }) as Record<string, any>;
    expect(out.text).toBe("hi");
    expect(out.password).toBe("[redacted]");
    expect(out.nested.apiKey).toBe("[redacted]");
    expect(out.nested["api-key"]).toBe("[redacted]");
    expect(out.nested.items[0]).toEqual({ otp: "[redacted]", ok: "x" });
    expect(out.card_number).toBe("[redacted]");
    expect(out.long).toHaveLength(2000);
  });

  it("redacts typed text for password-like fields, also in batches, and keeps search queries", () => {
    const r = (a: unknown) => redactTraceArgs(a) as any;
    expect(r({ action: "type", target: "Password", text: "hunter2" }).text).toBe("[redacted]");
    expect(r({ action: "type", element: "input[name=otp]", text: "123456" }).text).toBe("[redacted]");
    expect(r({ action: "fill", target: "Card number", text: "4111" }).text).toBe("[redacted]");
    expect(r({ action: "type", target: "Search", text: "red shoes" }).text).toBe("red shoes");
    expect(r({ action: "click", target: "Password", text: "x" }).text).toBe("x");
    const batch = r({ actions: [{ action: "type", target: "Email", text: "a@b.c" }, { action: "type", target: "Your PIN", text: "1234" }] });
    expect(batch.actions[0].text).toBe("a@b.c");
    expect(batch.actions[1].text).toBe("[redacted]");
    expect(r({ action: "type", target: "Field", inputType: "password", text: "s" }).text).toBe("[redacted]");
    expect(r({ type: "password", value: "s", other: "o" })).toEqual({ type: "password", value: "[redacted]", other: "o" });
  });

  it("does not change the input and survives a cycle", () => {
    const input: Record<string, unknown> = { token: "t" };
    input.self = input;
    const out = redactTraceArgs(input) as Record<string, unknown>;
    expect(input.token).toBe("t");
    expect(out.token).toBe("[redacted]");
  });
});

describe("splitTraceAssets / mapTraceFrames / parseBrowseTrace", () => {
  it("moves data-URL frames to asset paths and leaves other sources", () => {
    const trace = sample();
    const { manifest, assets } = splitTraceAssets(trace);
    expect(manifest.frames.map((f) => f.src)).toEqual(["frames/0.jpg", "frames/1.png", "https://cdn.test/x.png"]);
    expect(assets).toEqual([
      { path: "frames/0.jpg", dataUrl: JPG, contentType: "image/jpeg" },
      { path: "frames/1.png", dataUrl: PNG, contentType: "image/png" },
    ]);
    for (const a of assets) expect(a.path).toMatch(BROWSE_TRACE_ASSET_PATH);
    expect(trace.frames[0]!.src).toBe(JPG);
  });

  it("round-trips: split, map to URLs, parse", () => {
    const { manifest } = splitTraceAssets(sample());
    const mapped = mapTraceFrames(manifest, (src) => (src.startsWith("frames/") ? `https://r2.test/t/${src}` : src));
    expect(mapped.frames[0]!.src).toBe("https://r2.test/t/frames/0.jpg");
    expect(manifest.frames[0]!.src).toBe("frames/0.jpg");
    const reparsed = parseBrowseTrace(JSON.parse(JSON.stringify(mapped)));
    expect(reparsed).toEqual({ trace: mapped });
  });

  it("parse accepts a valid trace with extra fields", () => {
    const r = parseBrowseTrace({ ...sample(), owner: "u1", labels: { browser: "cloud" }, dropped: { frames: 2 } });
    expect("trace" in r).toBe(true);
  });

  it("parse rejects bad shapes", () => {
    const bad: [string, unknown][] = [
      ["not an object", null],
      ["array", []],
      ["format", { ...sample(), format: "x" }],
      ["version", { ...sample(), version: 2 }],
      ["id chars", { ...sample(), id: "a/b" }],
      ["id long", { ...sample(), id: "a".repeat(65) }],
      ["goal", { ...sample(), goal: 3 }],
      ["startedAt", { ...sample(), startedAt: "1" }],
      ["steps not array", { ...sample(), steps: {} }],
      ["step ok", { ...sample(), steps: [{ index: 0, tool: "t", args: 1, startedAt: 1, endedAt: 1 }] }],
      ["frame kind", { ...sample(), frames: [{ id: 0, at: 1, kind: "other", src: "x" }] }],
      ["frame src", { ...sample(), frames: [{ id: 0, at: 1, kind: "step" }] }],
      ["console entry", { ...sample(), console: [{ at: 1 }] }],
      ["network missing", { ...sample(), network: undefined }],
      ["frame src javascript", { ...sample(), frames: [{ id: 0, at: 1, kind: "step", src: "javascript:alert(1)" }] }],
      ["frame src file", { ...sample(), frames: [{ id: 0, at: 1, kind: "step", src: "file:///etc/passwd" }] }],
      ["frame src html data", { ...sample(), frames: [{ id: 0, at: 1, kind: "step", src: "data:text/html;base64,AAAA" }] }],
      ["frame src svg data", { ...sample(), frames: [{ id: 0, at: 1, kind: "step", src: "data:image/svg+xml;base64,AAAA" }] }],
      ["frame src traversal", { ...sample(), frames: [{ id: 0, at: 1, kind: "step", src: "frames/../x.jpg" }] }],
      ["frame src http remote", { ...sample(), frames: [{ id: 0, at: 1, kind: "step", src: "http://evil.test/x.png" }] }],
      ["labels", { ...sample(), labels: { a: 1 } }],
      ["qa", { ...sample(), qa: { outcome: "passed" } }],
      ["dropped", { ...sample(), dropped: { steps: "x" } }],
    ];
    for (const [name, value] of bad) {
      const r = parseBrowseTrace(value);
      expect("error" in r, name).toBe(true);
    }
  });

  it("parse accepts data URLs, asset paths, https and localhost frame sources", () => {
    const srcs = [JPG, PNG, "frames/3.webp", "https://cdn.test/a.png", "http://localhost:8787/a.png", "http://127.0.0.1/a.png"];
    const frames = srcs.map((src, id) => ({ id, at: 1, kind: "step" as const, src }));
    expect("trace" in parseBrowseTrace({ ...sample(), frames })).toBe(true);
  });

  it("exports the id and asset patterns", () => {
    expect(BROWSE_TRACE_ID.test("abc-_9")).toBe(true);
    expect(BROWSE_TRACE_ID.test("")).toBe(false);
    expect(BROWSE_TRACE_ASSET_PATH.test("frames/12.webp")).toBe(true);
    expect(BROWSE_TRACE_ASSET_PATH.test("frames/../1.jpg")).toBe(false);
    expect(BROWSE_TRACE_ASSET_PATH.test("frames/1.gif")).toBe(false);
  });
});

describe("mergeCarriedDialogs", () => {
  const d = [{ type: "alert", message: "hi" }];
  it("appends to an output without dialogs, at the end", () => {
    expect(mergeCarriedDialogs('{"a":1}', d)).toBe('{"a":1,"dialogs":[{"type":"alert","message":"hi"}]}');
  });
  it("keeps the output's own dialogs first and their key position", () => {
    expect(mergeCarriedDialogs('{"dialogs":[{"type":"confirm","message":"x"}],"b":2}', d)).toBe('{"dialogs":[{"type":"confirm","message":"x"},{"type":"alert","message":"hi"}],"b":2}');
  });
  it("returns anything else as it is", () => {
    expect(mergeCarriedDialogs("not json", d)).toBe("not json");
    expect(mergeCarriedDialogs("[1]", d)).toBe("[1]");
    expect(mergeCarriedDialogs('{"a":1}', [])).toBe('{"a":1}');
    expect(mergeCarriedDialogs('{"a":1}', undefined)).toBe('{"a":1}');
  });
});
