import { describe, expect, it } from "vitest";
import {
  createSecretRedactor,
  inputHasSecretPlaceholder,
  MIN_REDACTED_SECRET_LENGTH,
  SECRET_NAME_PATTERN,
  hasSecretPlaceholder,
  redactSecrets,
  resolveSecretPlaceholders,
} from "../../src/shared/secrets.js";

describe("hasSecretPlaceholder", () => {
  it("is exact", () => {
    expect(hasSecretPlaceholder("a {{secret:pw}} b")).toBe(true);
    expect(hasSecretPlaceholder("{{ secret:pw }}")).toBe(false);
    expect(hasSecretPlaceholder("{{secret:}}")).toBe(false);
    expect(hasSecretPlaceholder("{{secret:a b}}")).toBe(false);
    expect(hasSecretPlaceholder("plain")).toBe(false);
  });
  it("name pattern", () => {
    expect(SECRET_NAME_PATTERN.test("my_pw-1")).toBe(true);
    expect(SECRET_NAME_PATTERN.test("a".repeat(41))).toBe(false);
    expect(SECRET_NAME_PATTERN.test("a b")).toBe(false);
  });
});

describe("resolveSecretPlaceholders", () => {
  it("replaces known placeholders, several times", () => {
    expect(resolveSecretPlaceholders("{{secret:a}}-{{secret:b}}-{{secret:a}}", { a: "AAAA", b: "B$&B" })).toEqual({
      ok: true,
      text: "AAAA-B$&B-AAAA",
    });
  });
  it("leaves text without placeholders alone", () => {
    expect(resolveSecretPlaceholders("hi", { a: "x" })).toEqual({ ok: true, text: "hi" });
  });
  it("errors on an unknown name and lists names, never values", () => {
    const r = resolveSecretPlaceholders("{{secret:zz}}", { a: "value-a", b: "value-b" });
    expect(r).toEqual({ ok: false, error: 'Unknown secret "zz". Known secrets: a, b.' });
    expect(JSON.stringify(r)).not.toContain("value-");
  });
  it("errors when none are set", () => {
    expect(resolveSecretPlaceholders("{{secret:zz}}", {})).toEqual({
      ok: false,
      error: "No secrets are set. Ask the user to add one.",
    });
  });
  it("refuses a value that cannot be redacted, naming the secret and never the value", () => {
    const short = resolveSecretPlaceholders("{{secret:s}}", { s: "abc" });
    expect(short.ok).toBe(false);
    expect(short).toMatchObject({ error: expect.stringContaining('"s"') });
    expect(JSON.stringify(short)).not.toContain("abc");
    expect(resolveSecretPlaceholders("{{secret:n}}", { n: 12345678 as unknown as string }).ok).toBe(false);
  });
  it("does not treat inherited keys as secrets", () => {
    expect(resolveSecretPlaceholders("{{secret:constructor}}", {}).ok).toBe(false);
  });
});

describe("redactSecrets", () => {
  it("replaces raw values everywhere", () => {
    expect(redactSecrets("a hunter22 b hunter22", { pw: "hunter22" })).toBe("a {{secret:pw}} b {{secret:pw}}");
  });
  it("replaces the JSON-escaped form", () => {
    const value = 'p"w\\x\n1';
    const out = redactSecrets(JSON.stringify({ text: value, snapshot: "raw " + value }), { pw: value });
    expect(out).not.toContain("p\\\"w");
    expect(out).toBe(JSON.stringify({ text: "{{secret:pw}}", snapshot: "raw {{secret:pw}}" }).replace(/"raw /, '"raw '));
  });
  it("handles a value that contains another one (longest first)", () => {
    expect(redactSecrets("x abcdWXYZ y", { short: "abcd", long: "abcdWXYZ" })).toBe("x {{secret:long}} y");
  });
  it("skips values shorter than the minimum", () => {
    expect(MIN_REDACTED_SECRET_LENGTH).toBe(4);
    expect(redactSecrets("a abc b", { s: "abc" })).toBe("a abc b");
    expect(redactSecrets("a abcd b", { s: "abcd" })).toBe("a {{secret:s}} b");
  });
  it("does not rewrite a placeholder it wrote", () => {
    expect(redactSecrets("secret hunter22", { pw: "hunter22", w: "secret" })).toBe("{{secret:w}} {{secret:pw}}");
  });
  it("redacts a prefix (40+ chars) of a long value, case-sensitively; short prefixes stay", () => {
    const v = "Zq".repeat(80);
    const cut = v.slice(0, 100);
    expect(redactSecrets(`label: ${cut}`, { pw: v })).toBe("label: {{secret:pw}}");
    expect(redactSecrets(`label: ${v.slice(0, 40)}.`, { pw: v })).toBe("label: {{secret:pw}}.");
    expect(redactSecrets(`label: ${v.slice(0, 39)}`, { pw: v })).toBe(`label: ${v.slice(0, 39)}`);
    expect(redactSecrets(`label: ${cut.toLowerCase()}`, { pw: v })).toBe(`label: ${cut.toLowerCase()}`);
  });
  it("does not touch a label that is a prefix of a short secret", () => {
    expect(redactSecrets("Password and Password123 text", { pw: "Password123!" })).toBe("Password and Password123 text");
    expect(redactSecrets(JSON.stringify({ label: "Password" }), { pw: "Password123!" })).toBe('{"label":"Password"}');
  });
  it("exact forms win over prefix patterns of other forms", () => {
    expect(redactSecrets("typed Passw0rd\\Secret here", { pw: "Passw0rd\\Secret" })).toBe("typed {{secret:pw}} here");
    expect(redactSecrets('abcdefgh"tail', { pw: 'abcdefgh"tail' })).toBe("{{secret:pw}}");
    expect(redactSecrets('{"t":"abcdefgh\\"tail"}', { pw: 'abcdefgh"tail' })).toBe('{"t":"{{secret:pw}}"}');
  });
  it("handles two secrets that share a prefix", () => {
    const base = "k".repeat(45);
    const out = redactSecrets(`a ${base}AAAA b ${base}BBBBBB c`, { one: `${base}AAAA`, two: `${base}BBBBBB` });
    expect(out).toBe("a {{secret:one}} b {{secret:two}} c");
  });
  it("returns the original string when nothing matches (no JSON round trip)", () => {
    const big = '{"id":12345678901234567890,"a":"x"}';
    expect(redactSecrets(big, { pw: "hunter22" })).toBe(big);
  });
  it("redacts keys, keeps __proto__ keys, and never returns a deep subtree raw", () => {
    const keyed = redactSecrets('{"hunter22":1,"__proto__":{"a":"hunter22"}}', { pw: "hunter22" });
    const parsed = JSON.parse(keyed);
    expect(keyed).not.toContain("hunter22");
    expect(Object.keys(parsed)).toEqual(["{{secret:pw}}", "__proto__"]);
    let deep: unknown = "hunter22";
    for (let i = 0; i < 100; i++) deep = { n: deep };
    expect(redactSecrets(JSON.stringify(deep), { pw: "hunter22" })).not.toContain("hunter22");
    expect(JSON.stringify(createSecretRedactor({ pw: "hunter22" }).value(deep))).not.toContain("hunter22");
  });
  it("redacts the URL-encoded and form-urlencoded forms", () => {
    const v = "p@ss w/rd!1";
    const url = encodeURIComponent(v);
    const form = url.replace(/%20/g, "+").replace(/!/g, "%21");
    expect(redactSecrets(`q=${url}`, { pw: v })).toBe("q={{secret:pw}}");
    expect(redactSecrets(`q=${form}&x=1`, { pw: v })).toBe("q={{secret:pw}}&x=1");
  });
  it("redacts structurally: values and keys are redacted, imageData and data:image base64 stay, JSON tokens are never corrupted", () => {
    const secrets = { pw: "true-secret-null" };
    const input = JSON.stringify({
      "true-secret-null": 1,
      flag: true,
      none: null,
      label: "x true-secret-null y",
      imageData: "data:image/png;base64,true-secret-null",
      other: "data:text/plain,true-secret-null",
      img: "data:image/png;base64,true-secret-null",
      nested: [{ a: "true-secret-null" }],
    });
    const out = JSON.parse(redactSecrets(input, secrets));
    expect(out["{{secret:pw}}"]).toBe(1);
    expect(out.flag).toBe(true);
    expect(out.none).toBeNull();
    expect(out.label).toBe("x {{secret:pw}} y");
    expect(out.imageData).toContain("true-secret-null");
    expect(out.other).toBe("data:text/plain,{{secret:pw}}");
    expect(out.img).toContain("true-secret-null");
    expect(out.nested[0].a).toBe("{{secret:pw}}");
  });
  it("value() returns a redacted copy and leaves the input alone", () => {
    const r = createSecretRedactor({ pw: "hunter22" });
    const src = { a: ["hunter22"] };
    expect(r.value(src)).toEqual({ a: ["{{secret:pw}}"] });
    expect(src.a[0]).toBe("hunter22");
  });
  it("is a no-op without usable secrets", () => {
    expect(redactSecrets("abc", {})).toBe("abc");
  });
});

describe("inputHasSecretPlaceholder", () => {
  it("looks through nested input", () => {
    expect(inputHasSecretPlaceholder({ actions: [{ text: "{{secret:a}}" }] })).toBe(true);
    expect(inputHasSecretPlaceholder({ actions: [{ text: "x" }] })).toBe(false);
  });
});
