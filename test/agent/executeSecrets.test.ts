import { afterEach, describe, expect, it } from "vitest";
import { executeBrowseTool, runActionsBatch } from "../../src/agent/execute.js";
import { bridgeWith, FOUND, j, resetEnvironment, snap, stubLocate } from "./executeHarness.js";

afterEach(resetEnvironment);

const SECRETS = { pw: "hunter22", quoted: 'a"b\\c-1234' };
const withSecrets = { secrets: () => SECRETS };
const S1 = snap("s-1");

describe("browse_act secret placeholders", () => {
  it("substitutes the value into browser.act and redacts it from the result", async () => {
    const b = bridgeWith({
      act: [(a: unknown) => ({ ok: true, echo: (a as { text: string }).text })],
      snapshot: [{ ...S1, elements: [{ index: 0, tag: "input", value: "hunter22" }] }],
    });
    const out = await executeBrowseTool(b.browser, "browse_act", { action: "type", target: "#p", text: "{{secret:pw}}" }, withSecrets);
    expect((b.callsTo("act")[0]!.args[0] as { text: string }).text).toBe("hunter22");
    expect(out).not.toContain("hunter22");
    expect(out).toContain("{{secret:pw}}");
  });

  it("redacts a JSON-escaped value echoed in an error", async () => {
    const b = bridgeWith({ act: [{ error: 'could not type a"b\\c-1234 into field' }] });
    const out = await executeBrowseTool(b.browser, "browse_act", { action: "type", target: "#p", text: "{{secret:quoted}}" }, withSecrets);
    expect((b.callsTo("act")[0]!.args[0] as { text: string }).text).toBe(SECRETS.quoted);
    expect(out).not.toContain("c-1234");
    expect(out).toContain("{{secret:quoted}}");
  });

  it("redacts the output of other tools too", async () => {
    const b = bridgeWith({ read: [{ text: "the password is hunter22" }] });
    const out = await executeBrowseTool(b.browser, "browse_read", {}, withSecrets);
    expect(out).not.toContain("hunter22");
  });

  it("works in a batch entry and redacts the batch result", async () => {
    const b = bridgeWith({ act: [{ ok: true }, (a: unknown) => ({ ok: true, echo: (a as { text: string }).text })], snapshot: [S1] });
    const out = await executeBrowseTool(
      b.browser,
      "browse_act",
      { actions: [{ action: "click", index: 0 }, { action: "type", index: 1, text: "{{secret:pw}}" }], snapshotId: "s-1" },
      withSecrets,
    );
    expect((b.callsTo("act")[1]!.args[0] as { text: string }).text).toBe("hunter22");
    expect(out).not.toContain("hunter22");
    expect(JSON.parse(out).completed).toBe(2);
  });

  it("refuses a placeholder in a non-type action, bridge not called", async () => {
    const b = bridgeWith({});
    const out = await executeBrowseTool(b.browser, "browse_act", { action: "select", target: "#s", text: "{{secret:pw}}" }, withSecrets);
    expect(JSON.parse(out).error).toContain('can only be used in the text of a "type" action');
    expect(b.callsTo("act")).toHaveLength(0);
  });

  it("refuses a placeholder without the secrets option, bridge not called", async () => {
    const b = bridgeWith({});
    const out = await executeBrowseTool(b.browser, "browse_act", { action: "type", target: "#p", text: "{{secret:pw}}" });
    expect(out).toBe(j({ error: "browse_act: secret placeholders are not available here." }));
    expect(b.callsTo("act")).toHaveLength(0);
  });

  it("refuses an unknown name without leaking values, bridge not called", async () => {
    const b = bridgeWith({});
    const out = await executeBrowseTool(b.browser, "browse_act", { action: "type", target: "#p", text: "{{secret:nope}}" }, withSecrets);
    expect(JSON.parse(out).error).toContain('Unknown secret "nope". Known secrets: pw, quoted.');
    expect(out).not.toContain("hunter22");
    expect(b.callsTo("act")).toHaveLength(0);
  });

  it("does not substitute placeholders in other fields", async () => {
    const b = bridgeWith({ act: [{ ok: true }], snapshot: [S1] });
    await executeBrowseTool(b.browser, "browse_act", { action: "type", target: "{{secret:pw}}", text: "x" }, withSecrets);
    expect((b.callsTo("act")[0]!.args[0] as { target: string }).target).toBe("{{secret:pw}}");
  });

  it("element route: the locator never gets the value, the bridge does", async () => {
    const b = bridgeWith({ snapshot: [S1], act: [{ ok: true }] });
    const { requests, fetchMock } = stubLocate([FOUND(0)]);
    const out = await executeBrowseTool(
      b.browser,
      "browse_act",
      { action: "type", element: "password field", text: "{{secret:pw}}" },
      { ...withSecrets, locateElement: fetchMock },
    );
    expect(JSON.stringify(requests)).not.toContain("hunter22");
    expect((b.callsTo("act")[0]!.args[0] as { text: string }).text).toBe("hunter22");
    expect(out).not.toContain("hunter22");
  });

  it("reads the secrets once per call", async () => {
    const b = bridgeWith({ act: [{ ok: true }], snapshot: [S1] });
    let reads = 0;
    await executeBrowseTool(
      b.browser,
      "browse_act",
      { actions: [{ action: "type", index: 0, text: "{{secret:pw}}" }, { action: "type", index: 0, text: "{{secret:pw}}" }], snapshotId: "s-1" },
      { secrets: () => (reads++, SECRETS) },
    );
    expect(reads).toBe(1);
  });

  it("element route: the locator gets a snapshot with the value redacted", async () => {
    const echo = snap("s-1", [{ index: 0, tag: "input", label: "Password", value: "hunter22" }]);
    const b = bridgeWith({ snapshot: [echo], act: [{ ok: true }] });
    const { requests, fetchMock } = stubLocate([FOUND(0)]);
    await executeBrowseTool(
      b.browser,
      "browse_act",
      { action: "type", element: "password field", text: "{{secret:pw}}" },
      { ...withSecrets, locateElement: fetchMock },
    );
    expect(JSON.stringify(requests)).not.toContain("hunter22");
    expect(JSON.stringify(requests)).toContain("{{secret:pw}}");
  });

  it("runActionsBatch (public) redacts its own result", async () => {
    const b = bridgeWith({ act: [(a: unknown) => ({ ok: true, echo: (a as { text: string }).text })], snapshot: [S1] });
    const out = await runActionsBatch(b.browser, [{ action: "type", index: 0, text: "{{secret:pw}}" }], "s-1", undefined, withSecrets);
    expect(out).not.toContain("hunter22");
    expect(out).toContain("{{secret:pw}}");
  });

  it("refuses to substitute a value that cannot be redacted, bridge not called", async () => {
    const b = bridgeWith({});
    const out = await executeBrowseTool(
      b.browser,
      "browse_act",
      { action: "type", target: "#p", text: "{{secret:tiny}}" },
      { secrets: () => ({ tiny: "abc" }) },
    );
    expect(JSON.parse(out).error).toContain('Secret "tiny" cannot be used');
    expect(out).not.toContain("abc\"");
    expect(b.callsTo("act")).toHaveLength(0);
  });
});
