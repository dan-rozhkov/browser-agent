import { describe, expect, it } from "vitest";
import { buildMockResponse, createNetworkHandler, matchUrlPattern, pickNetworkRule } from "../../src/fixture/network.js";
import type { FixtureNetworkRule } from "../../src/fixture/types.js";

describe("matchUrlPattern", () => {
  it("matches the whole URL, with `*` as any run of characters", () => {
    expect(matchUrlPattern("https://api.shop.test/cart*", "https://api.shop.test/cart")).toBe(true);
    expect(matchUrlPattern("https://api.shop.test/cart*", "https://api.shop.test/cart/1?x=2")).toBe(true);
    expect(matchUrlPattern("https://api.shop.test/cart", "https://api.shop.test/cart?x=1")).toBe(false);
    expect(matchUrlPattern("*/cart", "https://a.test/cart")).toBe(true);
    expect(matchUrlPattern("https://*.test/*/items", "https://a.test/v1/items")).toBe(true);
    expect(matchUrlPattern("https://a.test/*", "https://b.test/x")).toBe(false);
    expect(matchUrlPattern("*", "anything at all")).toBe(true);
  });

  it("treats every other character as literal", () => {
    expect(matchUrlPattern("https://a.test/a.b", "https://a.test/aXb")).toBe(false);
    expect(matchUrlPattern("https://a.test/a.b", "https://a.test/a.b")).toBe(true);
    expect(matchUrlPattern("https://a.test/?q=(1)+[2]", "https://a.test/?q=(1)+[2]")).toBe(true);
    expect(matchUrlPattern("https://a.test/a|b", "https://a.test/a")).toBe(false);
  });

  it("is linear: a pathological pattern on a long URL answers fast", () => {
    const pattern = `*${"a*".repeat(60)}b`;
    const url = `https://a.test/${"a".repeat(50_000)}`;
    const t0 = Date.now();
    expect(matchUrlPattern(pattern, url)).toBe(false);
    expect(matchUrlPattern(`*${"a*".repeat(60)}`, url)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("needs the inner parts in order and not overlapping the ends", () => {
    expect(matchUrlPattern("a*b*c", "abc")).toBe(true);
    expect(matchUrlPattern("a*b*c", "acb")).toBe(false);
    expect(matchUrlPattern("ab*bc", "abc")).toBe(false);
    expect(matchUrlPattern("ab*bc", "abbc")).toBe(true);
    expect(matchUrlPattern("a**b", "ab")).toBe(true);
    expect(matchUrlPattern("*a*", "xax")).toBe(true);
    expect(matchUrlPattern("a*b*b", "abb")).toBe(true);
    expect(matchUrlPattern("a*b*b", "ab")).toBe(false);
  });

  it("lowercases the scheme and the host of a pattern, not the path", () => {
    expect(matchUrlPattern("HTTPS://API.Shop.TEST/cart*", "https://api.shop.test/cart/1")).toBe(true);
    expect(matchUrlPattern("https://api.shop.test/Cart", "https://api.shop.test/cart")).toBe(false);
    expect(matchUrlPattern("HTTPS://*.shop.test/x", "https://a.shop.test/x")).toBe(true);
  });

  it("reads a bare origin as origin + '/'", () => {
    expect(matchUrlPattern("https://a.test", "https://a.test/")).toBe(true);
    expect(matchUrlPattern("https://A.test:8080", "https://a.test:8080/")).toBe(true);
    expect(matchUrlPattern("https://a.test", "https://a.test/x")).toBe(false);
    expect(matchUrlPattern("https://a.test*", "https://a.test/x")).toBe(true);
  });

  it("does not normalize percent-encoding: a pattern matches the encoded URL", () => {
    expect(matchUrlPattern("https://a.test/a%20b", "https://a.test/a%20b")).toBe(true);
    expect(matchUrlPattern("https://a.test/a b", "https://a.test/a%20b")).toBe(false);
  });

  it("matches across newlines in the wildcard", () => {
    expect(matchUrlPattern("https://a.test/*", "https://a.test/a\nb")).toBe(true);
  });
});

describe("pickNetworkRule", () => {
  const rules: FixtureNetworkRule[] = [
    { url: "https://a.test/api/*", method: "post", status: 201 },
    { url: "https://a.test/api/*", status: 202, times: 1 },
    { url: "https://a.test/*", status: 203 },
  ];
  const req = (method: string, url = "https://a.test/api/x") => ({ method, url });

  it("is first match wins, with the method compared case-insensitively", () => {
    expect(pickNetworkRule(rules, [0, 0, 0], req("POST"))).toBe(0);
    expect(pickNetworkRule(rules, [0, 0, 0], req("GET"))).toBe(1);
  });

  it("skips a rule whose `times` is used up", () => {
    expect(pickNetworkRule(rules, [0, 1, 0], req("GET"))).toBe(2);
    expect(pickNetworkRule(rules, [0, 0, 0], req("GET", "https://other.test/"))).toBe(-1);
  });
});

describe("buildMockResponse", () => {
  it("defaults to status 200 and an empty body", () => {
    expect(buildMockResponse({ url: "x" })).toEqual({ status: 200, headers: {}, body: "" });
  });

  it("sends an object as JSON and adds the content type unless one is given", () => {
    expect(buildMockResponse({ url: "x", body: { a: 1 } })).toEqual({ status: 200, headers: { "content-type": "application/json" }, body: '{"a":1}' });
    expect(buildMockResponse({ url: "x", body: { a: 1 }, headers: { "Content-Type": "application/vnd.api+json" } }).headers).toEqual({ "Content-Type": "application/vnd.api+json" });
    expect(buildMockResponse({ url: "x", body: "plain", status: 404 })).toEqual({ status: 404, headers: {}, body: "plain" });
  });

  it("carries the delay and the abort flag", () => {
    expect(buildMockResponse({ url: "x", delayMs: 50 })).toMatchObject({ delayMs: 50 });
    expect(buildMockResponse({ url: "x", abort: true, delayMs: 5 })).toMatchObject({ abort: true, delayMs: 5 });
  });
});

describe("createNetworkHandler", () => {
  it("counts uses per rule, so `times` ends the mock and later requests pass through", () => {
    const handler = createNetworkHandler([
      { url: "https://a.test/*", status: 503, times: 2 },
      { url: "https://a.test/ok", status: 200 },
    ]);
    const req = { method: "GET", url: "https://a.test/ok" };
    expect(handler(req)?.status).toBe(503);
    expect(handler(req)?.status).toBe(503);
    // The first rule is used up: the second one is next in fixture order.
    expect(handler(req)?.status).toBe(200);
    expect(handler({ method: "GET", url: "https://b.test/" })).toBeUndefined();
  });

  it("lets a request through when no rule matches", () => {
    expect(createNetworkHandler([{ url: "https://a.test/x", times: 1 }])({ method: "GET", url: "https://a.test/y" })).toBeUndefined();
  });
});

describe("createNetworkHandler hits", () => {
  const req = (url: string, method = "GET") => ({ url, method });

  it("counts answers per rule, in fixture order, with the rule's own method", () => {
    const handler = createNetworkHandler([
      { url: "https://a.test/one" },
      { url: "https://a.test/two", method: "post" },
      { url: "https://a.test/never" },
    ]);
    expect(handler.hits()).toEqual([
      { url: "https://a.test/one", hits: 0 },
      { method: "post", url: "https://a.test/two", hits: 0 },
      { url: "https://a.test/never", hits: 0 },
    ]);
    handler(req("https://a.test/one"));
    handler(req("https://a.test/one"));
    handler(req("https://a.test/two", "POST"));
    handler(req("https://a.test/two", "GET"));
    handler(req("https://a.test/other"));
    expect(handler.hits().map((h) => h.hits)).toEqual([2, 1, 0]);
  });

  it("a rule with `times` stops counting at N and the next matching rule takes over", () => {
    const handler = createNetworkHandler([{ url: "https://a.test/x", times: 2 }, { url: "https://a.test/*" }]);
    for (let i = 0; i < 5; i += 1) handler(req("https://a.test/x"));
    expect(handler.hits().map((h) => h.hits)).toEqual([2, 3]);
  });
});
