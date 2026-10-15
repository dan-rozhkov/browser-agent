import { describe, expect, it } from "vitest";
import { parsePageFixture } from "../../src/fixture/parse.js";

const SECRET = "s3cr3t-value-XYZ";

describe("parsePageFixture", () => {
  it("accepts a full fixture and returns a clean copy", () => {
    const input = {
      version: 1,
      url: "https://a.test/home",
      tabs: ["https://b.test/"],
      storage: {
        cookies: [
          { name: "sid", value: "v", domain: ".a.test", path: "/", expires: 1, httpOnly: true, secure: true, sameSite: "Lax" },
          { name: "n", value: "", url: "https://a.test/" },
        ],
        origins: [{ origin: "https://a.test", localStorage: { k: "v" }, sessionStorage: { s: "t" } }],
      },
      steps: [
        { action: "goto", url: "https://a.test/x" },
        { action: "click", selector: "#go" },
        { action: "type", selector: "input", text: "" },
        { action: "press", key: "Enter" },
        { action: "press", key: "Tab", selector: "input" },
        { action: "waitFor", selector: ".ready", timeoutMs: 1000 },
        { action: "wait", ms: 10 },
      ],
      network: [],
      extra: "dropped",
    };
    const r = parsePageFixture(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ ...input, extra: undefined });
      expect("extra" in r.value).toBe(false);
    }
  });

  it("accepts a bare version-1 fixture", () => {
    expect(parsePageFixture({ version: 1 })).toEqual({ ok: true, value: { version: 1 } });
  });

  const bad: [string, unknown, string][] = [
    ["a non-object", "x", "fixture must be an object"],
    ["a wrong version", { version: 2 }, "fixture.version must be 1"],
    ["a non-http url", { version: 1, url: "file:///etc/passwd" }, "fixture.url must be an http(s) URL"],
    ["a relative url", { version: 1, url: "/x" }, "fixture.url must be an absolute URL"],
    ["a bad tab", { version: 1, tabs: ["https://a.test/", 3] }, "fixture.tabs[1] must be a string"],
    ["a cookie without url or domain", { version: 1, storage: { cookies: [{ name: "a", value: "b" }] } }, "fixture.storage.cookies[0] needs url or domain"],
    ["a bad sameSite", { version: 1, storage: { cookies: [{ name: "a", value: "b", domain: "a.test", sameSite: "x" }] } }, "fixture.storage.cookies[0].sameSite must be one of Strict, Lax, None"],
    ["a bad origin", { version: 1, storage: { origins: [{ origin: "ftp://a" }] } }, "fixture.storage.origins[0].origin must be an http(s) URL"],
    ["a non-string storage value", { version: 1, storage: { origins: [{ origin: "https://a.test", localStorage: { k: 1 } }] } }, "fixture.storage.origins[0].localStorage must map strings to strings"],
    ["an unknown action", { version: 1, steps: [{ action: "boom" }] }, "fixture.steps[0].action must be one of"],
    ["a step without selector", { version: 1, steps: [{ action: "click" }] }, "fixture.steps[0].selector must be a string"],
    ["a long wait", { version: 1, steps: [{ action: "wait", ms: 999999 }] }, "fixture.steps[0].ms must be between 0 and 30000"],
    ["a non-array network", { version: 1, network: {} }, "fixture.network must be an array"],
  ];
  for (const [name, input, message] of bad) {
    it(`rejects ${name}`, () => {
      const r = parsePageFixture(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(message);
    });
  }

  it("never repeats a cookie value, a storage key or a storage value in an error", () => {
    const inputs = [
      { version: 1, storage: { cookies: [{ name: SECRET, value: SECRET }] } },
      { version: 1, storage: { cookies: [{ name: "n", value: SECRET, domain: "a.test", sameSite: SECRET }] } },
      { version: 1, storage: { cookies: [{ name: "n", value: SECRET, domain: "a.test", expires: SECRET }] } },
      { version: 1, storage: { origins: [{ origin: "https://a.test", localStorage: { [SECRET]: 5 } }] } },
      { version: 1, storage: { origins: [{ origin: "https://a.test", sessionStorage: { k: { [SECRET]: SECRET } } }] } },
      { version: 1, storage: { origins: [{ origin: SECRET, localStorage: { [SECRET]: SECRET } }] } },
      { version: 1, steps: [{ action: SECRET }] },
    ];
    for (const input of inputs) {
      const r = parsePageFixture(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).not.toContain(SECRET);
    }
  });
});

describe("parsePageFixture review fixes", () => {
  it("normalizes a storage origin to URL.origin", () => {
    const r = parsePageFixture({ version: 1, storage: { origins: [{ origin: "HTTPS://A.test:443/", localStorage: { k: "v" } }, { origin: "http://b.test" }] } });
    expect(r.ok && r.value.storage?.origins?.map((o) => o.origin)).toEqual(["https://a.test", "http://b.test"]);
  });

  it("rejects an origin with a path, query or hash", () => {
    for (const origin of ["https://a.test/app", "https://a.test/?x=1", "https://a.test/#h"]) {
      const r = parsePageFixture({ version: 1, storage: { origins: [{ origin }] } });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain("fixture.storage.origins[0].origin must be an origin only");
        expect(r.error).not.toContain("x=1");
      }
    }
  });

  it("accepts a lone space as a press key and rejects the empty string", () => {
    expect(parsePageFixture({ version: 1, steps: [{ action: "press", key: " " }] }).ok).toBe(true);
    const r = parsePageFixture({ version: 1, steps: [{ action: "press", key: "" }] });
    expect(r).toEqual({ ok: false, error: "fixture.steps[0].key must not be empty" });
  });
});
