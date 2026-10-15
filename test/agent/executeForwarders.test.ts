import { afterEach, describe, expect, it } from "vitest";
import {
  bridgeWith,
  BROWSER_BRIDGE_METHOD_MISSING_ERROR,
  BROWSER_NOT_AVAILABLE_ERROR,
  browseFindImages,
  browseOpen,
  browseRead,
  browseSnapshot,
  browseTabs,
  COMMAND_FAILED,
  j,
  noBridge,
  resetEnvironment,
  snap,
  throws,
  type BridgeMethod,
} from "./executeHarness.js";

afterEach(resetEnvironment);

const NOT_AVAILABLE = j({ error: BROWSER_NOT_AVAILABLE_ERROR });
const S = snap("open-1");

describe("browse_open", () => {
  it("forwards args verbatim to open, then attaches one fresh snapshot", async () => {
    const bridge = bridgeWith({ open: [{ url: "https://a.com/", title: "A" }], snapshot: [S] });
    const out = await browseOpen({ url: "https://a.com", newTab: true, extra: [1] }, { sessionId: "chat-1" });
    expect(bridge.calls).toEqual([
      { method: "open", args: [{ url: "https://a.com", newTab: true, extra: [1] }] },
      { method: "snapshot", args: [] },
    ]);
    expect(out).toBe(j({ url: "https://a.com/", title: "A", snapshot: S }));
  });

  it("forwards an empty args object (validation is the desktop side's job)", async () => {
    const bridge = bridgeWith({ open: [{ error: "url required" }] });
    expect(await browseOpen({})).toBe(j({ error: "url required" }));
    expect(bridge.calls).toEqual([{ method: "open", args: [{}] }]);
  });

  it("does not attach a snapshot to an { error } result", async () => {
    const bridge = bridgeWith({ open: [{ error: "net::ERR_NAME_NOT_RESOLVED", url: "u" }], snapshot: [S] });
    expect(await browseOpen({ url: "u" })).toBe(j({ error: "net::ERR_NAME_NOT_RESOLVED", url: "u" }));
    expect(bridge.methods()).toEqual(["open"]);
  });

  it("an EMPTY error string is not an error: the snapshot is attached", async () => {
    // pinned as-is: resultError() ignores "" so { error: "" } counts as success.
    bridgeWith({ open: [{ error: "", url: "u" }], snapshot: [S] });
    expect(await browseOpen({ url: "u" })).toBe(j({ error: "", url: "u", snapshot: S }));
  });

  it("returns the open result untouched when the follow-up snapshot fails, is malformed or rejects", async () => {
    for (const step of [{ error: "x" }, { url: "u" }, throws(new Error("boom"))]) {
      bridgeWith({ open: [{ url: "u" }], snapshot: [step] });
      expect(await browseOpen({ url: "u" })).toBe(j({ url: "u" }));
    }
  });

  it("returns the raw string for a non-object open result (array)", async () => {
    // pinned as-is: safeParseObject turns "[1]" into a malformed-result error,
    // resultError() then sees it and the ORIGINAL "[1]" string is returned.
    const bridge = bridgeWith({ open: [[1]], snapshot: [S] });
    expect(await browseOpen({ url: "u" })).toBe("[1]");
    expect(bridge.methods()).toEqual(["open"]);
  });

  it("returns the raw JSON string for a primitive open result", async () => {
    bridgeWith({ open: ["done", 5], snapshot: [S] });
    expect(await browseOpen({ url: "u" })).toBe('"done"');
    expect(await browseOpen({ url: "u" })).toBe("5");
  });

  it("coalesces an undefined / null result to {} and attaches the snapshot", async () => {
    bridgeWith({ open: [undefined, null], snapshot: [S] });
    expect(await browseOpen({ url: "u" })).toBe(j({ snapshot: S }));
    expect(await browseOpen({ url: "u" })).toBe(j({ snapshot: S }));
  });

  it("reports a rejecting open as { error } with no snapshot", async () => {
    const bridge = bridgeWith({ open: [throws(new Error("timed out")), throws(42)], snapshot: [S] });
    expect(await browseOpen({ url: "u" })).toBe(j({ error: "timed out" }));
    expect(await browseOpen({ url: "u" })).toBe(j({ error: COMMAND_FAILED }));
    expect(bridge.methods()).toEqual(["open", "open"]);
  });

  it("returns the not-available error without a bridge", async () => {
    expect(await browseOpen({ url: "u" })).toBe(NOT_AVAILABLE);
  });
});

describe("browse_snapshot", () => {
  it("calls snapshot with no arguments, ignoring the tool args, and returns the raw result", async () => {
    const bridge = bridgeWith({ snapshot: [S] });
    expect(await browseSnapshot({ ignored: true }, { sessionId: "c" })).toBe(j(S));
    expect(bridge.calls).toEqual([{ method: "snapshot", args: [] }]);
  });

  it("does not validate the shape: an error or odd result passes straight through", async () => {
    bridgeWith({ snapshot: [{ error: "no tab" }, { anything: 1 }, undefined, [1]] });
    expect(await browseSnapshot({})).toBe(j({ error: "no tab" }));
    expect(await browseSnapshot({})).toBe(j({ anything: 1 }));
    expect(await browseSnapshot({})).toBe("{}");
    expect(await browseSnapshot({})).toBe("[1]");
  });

  it("does not truncate a large snapshot", async () => {
    const big = snap("big", Array.from({ length: 300 }, (_, i) => ({ index: i, tag: "a", label: "x".repeat(500), ops: ["CLICK"] })));
    bridgeWith({ snapshot: [big] });
    expect(await browseSnapshot({})).toBe(j(big));
  });

  it("reports a rejecting snapshot and the missing bridge", async () => {
    bridgeWith({ snapshot: [throws(new Error("dead"))] });
    expect(await browseSnapshot({})).toBe(j({ error: "dead" }));
    noBridge();
    expect(await browseSnapshot({})).toBe(NOT_AVAILABLE);
  });
});

describe("browse_tabs", () => {
  it("forwards every action verbatim and returns the bridge result", async () => {
    const argsList = [
      { action: "list" },
      { action: "switch", tabId: 3 },
      { action: "close", tabId: 3 },
      { action: "new", url: "https://a.com" },
      { action: "new" },
      { action: "bogus", tabId: "x" },
      {},
    ];
    const bridge = bridgeWith({ tabs: [{ tabs: [{ id: 1 }], current: 1 }] });
    for (const args of argsList) {
      expect(await browseTabs(args)).toBe(j({ tabs: [{ id: 1 }], current: 1 }));
    }
    expect(bridge.callsTo("tabs").map((c) => c.args)).toEqual(argsList.map((a) => [a]));
    expect(bridge.methods().every((m) => m === "tabs")).toBe(true);
  });

  it("does not attach a snapshot, and passes an { error } through", async () => {
    const bridge = bridgeWith({ tabs: [{ error: "no such tab" }] });
    expect(await browseTabs({ action: "switch", tabId: 9 })).toBe(j({ error: "no such tab" }));
    expect(bridge.methods()).toEqual(["tabs"]);
  });

  it("coalesces undefined to {}", async () => {
    bridgeWith({ tabs: [undefined] });
    expect(await browseTabs({ action: "list" })).toBe("{}");
  });

  it("returns the needs-a-newer-app error when the bridge lacks tabs", async () => {
    const bridge = bridgeWith({}, ["tabs"]);
    expect(await browseTabs({ action: "list" })).toBe(j({ error: BROWSER_BRIDGE_METHOD_MISSING_ERROR }));
    expect(bridge.calls).toEqual([]);
  });

  it("returns the not-available error without any bridge", async () => {
    expect(await browseTabs({ action: "list" })).toBe(NOT_AVAILABLE);
  });

  it("reports a rejecting tabs call", async () => {
    bridgeWith({ tabs: [throws(new Error("closed")), throws({})] });
    expect(await browseTabs({ action: "close", tabId: 1 })).toBe(j({ error: "closed" }));
    expect(await browseTabs({ action: "close", tabId: 1 })).toBe(j({ error: COMMAND_FAILED }));
  });
});

// browse_find_images and browse_read are identical thin forwarders.
const plainForwarders: Array<[string, (args: Record<string, unknown>) => Promise<string>, BridgeMethod]> = [
  ["browse_find_images", browseFindImages, "findImages"],
  ["browse_read", browseRead, "read"],
];

for (const [name, handler, method] of plainForwarders) {
  describe(`${name} plain forwarder`, () => {
    it("forwards args verbatim (extra and odd fields included) and returns the result", async () => {
      const bridge = bridgeWith({ [method]: [{ ok: 1 }] });
      expect(await handler({ minWidth: 100, minHeight: 50, limit: 5, selector: "main", junk: null })).toBe(j({ ok: 1 }));
      expect(await handler({})).toBe(j({ ok: 1 }));
      expect(bridge.calls).toEqual([
        { method, args: [{ minWidth: 100, minHeight: 50, limit: 5, selector: "main", junk: null }] },
        { method, args: [{}] },
      ]);
    });

    it("does not truncate or sanitize large output and attaches no snapshot", async () => {
      const big = { text: "x".repeat(200_000), images: Array.from({ length: 500 }, (_, i) => ({ url: `u${i}` })) };
      const bridge = bridgeWith({ [method]: [big] });
      expect(await handler({})).toBe(j(big));
      expect(bridge.methods()).toEqual([method]);
    });

    it("passes bridge errors through and coalesces undefined/null to {}", async () => {
      bridgeWith({ [method]: [{ error: "no page" }, undefined, null] });
      expect(await handler({})).toBe(j({ error: "no page" }));
      expect(await handler({})).toBe("{}");
      expect(await handler({})).toBe("{}");
    });

    it("reports a rejecting call and the missing bridge", async () => {
      bridgeWith({ [method]: [throws(new Error("kaput")), throws(null)] });
      expect(await handler({})).toBe(j({ error: "kaput" }));
      expect(await handler({})).toBe(j({ error: COMMAND_FAILED }));
      noBridge();
      expect(await handler({})).toBe(NOT_AVAILABLE);
    });
  });
}
