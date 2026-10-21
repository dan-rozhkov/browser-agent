import { describe, expect, it } from "vitest";
import { mergeCarriedDialogs } from "../../src/shared/dialogs.js";
import {
  BROWSE_TRACE_ASSET_PATH,
  BROWSE_TRACE_REQUEST_BODY_MAX_CHARS,
  redactTraceRequest,
  redactTraceUrl,
  BROWSE_TRACE_ID,
  mapTraceFrames,
  parseBrowseTrace,
  redactTraceArgs,
  redactTraceArgsTracked,
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

describe("redactTraceRequest", () => {
  it("redacts secret headers, url params and JSON body keys, and caps values", () => {
    const out = redactTraceRequest({
      at: 5, method: "POST", url: "https://a.test/x?token=abc&q=hi&Session=1&code=9#access_token=zz&a=1",
      type: "XHR", status: 200, mimeType: "application/json", size: 10, durationMs: 4,
      requestHeaders: { Authorization: "Bearer s", "X-Api-Key": "k", Accept: "a".repeat(900), "x-my-token": "t" },
      responseHeaders: { "Set-Cookie": "sid=1", "content-type": "application/json" },
      body: JSON.stringify({ user: "u", password: "p", nested: [{ apiKey: "k", ok: 1 }] }),
    })!;
    expect(out.url).toBe("https://a.test/x?token=[redacted]&q=hi&Session=[redacted]&code=[redacted]#access_token=[redacted]&a=1");
    expect(out.type).toBe("xhr");
    expect(out.requestHeaders).toEqual({ Authorization: "[redacted]", "X-Api-Key": "[redacted]", Accept: "a".repeat(500), "x-my-token": "[redacted]" });
    expect(out.responseHeaders).toEqual({ "Set-Cookie": "[redacted]", "content-type": "application/json" });
    expect(JSON.parse(out.responseBody!)).toEqual({ user: "u", password: "[redacted]", nested: [{ apiKey: "[redacted]", ok: 1 }] });
    expect(out.bodyTruncated).toBeUndefined();
  });

  it("cuts long bodies and urls, limits headers to 60, and marks a source cut", () => {
    const headers = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`h${i}`, "v"]));
    const out = redactTraceRequest({ at: 1, method: "GET", url: `https://a.test/${"p".repeat(3000)}`, requestHeaders: headers, body: "z".repeat(5000) })!;
    expect(out.url).toHaveLength(2000);
    expect(Object.keys(out.requestHeaders!)).toHaveLength(60);
    expect(out.responseBody).toHaveLength(BROWSE_TRACE_REQUEST_BODY_MAX_CHARS);
    expect(out.bodyTruncated).toBe(true);
    const cut = redactTraceRequest({ at: 1, method: "GET", url: "u", body: "short", bodyTruncated: true })!;
    expect(cut).toMatchObject({ responseBody: "short", bodyTruncated: true });
    // Form bodies lose secret fields; non-JSON text stays.
    expect(redactTraceRequest({ at: 1, method: "POST", url: "u", mimeType: "application/x-www-form-urlencoded", body: "a=1&password=2" })!.responseBody).toBe("a=1&password=[redacted]");
  });

  it("JSON bodies: a secret-named key loses its whole subtree, after a BOM or XSSI prefix", () => {
    const body = (b: string, mimeType = "application/json") => redactTraceRequest({ at: 1, method: "GET", url: "u", mimeType, body: b })!.responseBody!;
    expect(body(JSON.stringify({ user: "u", auth: { a: 1, list: [1, 2] }, sessionId: "s", zipcode: "1", n: [{ code: 7 }] }))).toBe('{"user":"u","auth":"[redacted]","sessionId":"[redacted]","zipcode":"1","n":[{"code":"[redacted]"}]}');
    expect(body(`\uFEFF{"apiKey":"k1","a":1}`)).toBe('{"apiKey":"[redacted]","a":1}');
    expect(body(`)]}',\n{"secret":"s","a":1}`, "text/plain")).toBe('{"secret":"[redacted]","a":1}');
  });

  it("a body that does not parse and has a secret-looking word is replaced as a whole; else it is kept", () => {
    const r = (b: string, mimeType = "application/json") => redactTraceRequest({ at: 1, method: "GET", url: "u", mimeType, body: b })!;
    for (const b of ['{"user":"u","accessToken":"abc.def.gh","data":{"n":12', 'cb({"password":"p"})', "[INFO] token=abc", "var apiKey = 'x';"]) {
      const out = r(b);
      expect(out.responseBody).toBe("[redacted: unparsed body with a secret-looking key]");
      expect(out.bodyTruncated).toBeUndefined();
    }
    expect(r('{"user":"u","n":12,"x":[1').responseBody).toBe('{"user":"u","n":12,"x":[1');
    expect(r("hello world", "text/plain").responseBody).toBe("hello world");
    expect(r("a=1&password=2", "application/x-www-form-urlencoded").responseBody).toBe("a=1&password=[redacted]");
  });

  it("one key rule: secret words as whole parts (snake, kebab, camel), not inside other words", () => {
    const u = (q: string) => redactTraceUrl(`https://a.test/?${q}`);
    expect(u("design=1&zipcode=2&author=3&sig=4&code=5&auth=6&auth_code=7&x-sig=8&Signature=9&sessionid=10&sessionId=11&x-session-id=12&userSid=13&Code=14")).toBe(
      "https://a.test/?design=1&zipcode=2&author=3&sig=[redacted]&code=[redacted]&auth=[redacted]&auth_code=[redacted]&x-sig=[redacted]&Signature=[redacted]&sessionid=[redacted]&sessionId=[redacted]&x-session-id=[redacted]&userSid=[redacted]&Code=[redacted]",
    );
    const h = redactTraceRequest({ at: 1, method: "GET", url: "u", requestHeaders: { "X-Session-Id": "s", "x-sig": "1", "x-author": "me" } })!.requestHeaders;
    expect(h).toEqual({ "X-Session-Id": "[redacted]", "x-sig": "[redacted]", "x-author": "me" });
  });

  it("strips userinfo from urls and redacts url-valued headers", () => {
    expect(redactTraceUrl("https://user:pw@a.test/p?token=1")).toBe("https://a.test/p?token=[redacted]");
    const out = redactTraceRequest({
      at: 1, method: "GET", url: "https://u:p@a.test/",
      requestHeaders: { Referer: "https://a.test/x?code=1&q=2", Origin: "https://a.test", "x-next": "https://b.test/?auth=z", "x-plain": "no url?auth=z" },
      responseHeaders: { Location: "/cb?access_token=zz", "Content-Location": "https://a.test/?sig=1" },
    })!;
    expect(out.url).toBe("https://a.test/");
    expect(out.requestHeaders).toEqual({ Referer: "https://a.test/x?code=[redacted]&q=2", Origin: "https://a.test", "x-next": "https://b.test/?auth=[redacted]", "x-plain": "no url?auth=z" });
    // A relative Location is a url header too.
    expect(out.responseHeaders).toEqual({ Location: "/cb?access_token=[redacted]", "Content-Location": "https://a.test/?sig=[redacted]" });
  });

  it("returns undefined for a value that is not a request, and never throws", () => {
    expect(redactTraceRequest(null)).toBeUndefined();
    expect(redactTraceRequest({ at: "1", method: "GET", url: "u" })).toBeUndefined();
    expect(redactTraceRequest({ at: 1, method: "GET" })).toBeUndefined();
  });
});

describe("parseBrowseTrace: actions and requests", () => {
  const base = { format: "sideform.browse-trace", version: 1, id: "t1", goal: "g", startedAt: 1, endedAt: 2, status: "done", steps: [], frames: [], console: [], network: [] };
  const step = { index: 0, tool: "browse_act", startedAt: 1, endedAt: 2, ok: true };
  it("accepts valid actions and requests", () => {
    const t = { ...base, steps: [{ ...step, actions: [{ action: "click", ok: true }, { action: "type", ok: false, error: "x" }] }], requests: [{ at: 1, method: "GET", url: "u", status: 200, requestHeaders: { a: "b" }, bodyTruncated: false }], extra: 1 };
    expect(parseBrowseTrace(t)).toEqual({ trace: t });
  });
  it("rejects malformed actions", () => {
    for (const actions of ["x", [null], [{ action: 1, ok: true }], [{ action: "a", ok: "yes" }], [{ action: "a", ok: true, error: 3 }]]) {
      expect(parseBrowseTrace({ ...base, steps: [{ ...step, actions }] })).toEqual({ error: "steps[0]: invalid" });
    }
  });
  it("rejects malformed requests", () => {
    const bad = [{ at: 1, method: "GET" }, { at: 1, method: "GET", url: "u", requestHeaders: { a: 1 } }, { at: 1, method: "GET", url: "u", status: "200" }, { at: 1, method: "GET", url: "u", bodyTruncated: 1 }];
    for (const r of bad) expect(parseBrowseTrace({ ...base, requests: [r] })).toEqual({ error: "requests[0]: invalid" });
    expect(parseBrowseTrace({ ...base, requests: "x" })).toEqual({ error: "requests: expected an array" });
    expect(parseBrowseTrace({ ...base, requests: Array.from({ length: 2001 }, () => ({ at: 1, method: "GET", url: "u" })) })).toEqual({ error: "requests: too many entries" });
  });
});

describe("redactTraceArgsTracked: secret placeholders", () => {
  it("sets typedSecret for a placeholder in text or value and keeps the placeholder visible", () => {
    const state = { secretFocus: false };
    const a = redactTraceArgsTracked({ action: "type", target: "Email", text: "{{secret:pw}}" }, state);
    expect(a.typedSecret).toBe(true);
    expect((a.value as any).text).toBe("{{secret:pw}}");
    expect(redactTraceArgsTracked({ value: "x{{secret:a-1}}" }, state).typedSecret).toBe(true);
    expect(redactTraceArgsTracked({ action: "type", target: "Email", text: "plain" }, state).typedSecret).toBe(false);
  });
  it("sets typedSecret for a placeholder inside a batch entry", () => {
    const r = redactTraceArgsTracked(
      { actions: [{ action: "click", index: 1 }, { action: "type", index: 2, text: "{{secret:pw}}" }] },
      { secretFocus: false },
    );
    expect(r.typedSecret).toBe(true);
  });
  it("a placeholder typed into a password field stays redacted", () => {
    const r = redactTraceArgsTracked({ action: "type", target: "Password", text: "{{secret:pw}}" }, { secretFocus: false });
    expect((r.value as any).text).toBe("[redacted]");
    expect(r.typedSecret).toBe(true);
  });
});
