import { afterEach, describe, expect, it } from "vitest";
import { executeBrowseTool } from "../../src/agent/execute.js";
import {
  bridgeWith,
  BROWSER_BRIDGE_METHOD_MISSING_ERROR,
  BROWSER_NOT_AVAILABLE_ERROR,
  browseScreenshot,
  COMMAND_FAILED,
  hostOptions,
  j,
  resetEnvironment,
  throws,
} from "./executeHarness.js";

afterEach(resetEnvironment);

const DATA = "data:image/jpeg;base64,AAAA";
const SHOT = { imageData: DATA, width: 800, height: 600, url: "https://example.com/page", title: "Example" };

describe("browse_screenshot", () => {
  it("forwards the args minus placeOnCanvas, x and y, and returns the raw result", async () => {
    const bridge = bridgeWith({ screenshot: [SHOT] });
    expect(await browseScreenshot({ annotate: true, fullPage: false, placeOnCanvas: false, x: 1, y: 2 })).toBe(j(SHOT));
    expect(bridge.calls).toEqual([{ method: "screenshot", args: [{ annotate: true, fullPage: false }] }]);
  });

  it("strips the three host fields whatever the flag's value is", async () => {
    const bridge = bridgeWith({ screenshot: [SHOT] });
    for (const flag of [false, "true", 1, undefined]) await browseScreenshot({ placeOnCanvas: flag, x: 5, y: 6, annotate: false });
    expect(bridge.callsTo("screenshot").map((c) => c.args)).toEqual(Array(4).fill([{ annotate: false }]));
  });

  it("reports no bridge, a bridge without screenshot, and a rejecting call", async () => {
    expect(await browseScreenshot({})).toBe(j({ error: BROWSER_NOT_AVAILABLE_ERROR }));
    const bridge = bridgeWith({}, ["screenshot"]);
    expect(await browseScreenshot({ placeOnCanvas: true })).toBe(j({ error: BROWSER_BRIDGE_METHOD_MISSING_ERROR }));
    expect(bridge.calls).toEqual([]);
    bridgeWith({ screenshot: [throws(new Error("gpu lost")), throws("x")] });
    expect(await browseScreenshot({})).toBe(j({ error: "gpu lost" }));
    expect(await browseScreenshot({})).toBe(j({ error: COMMAND_FAILED }));
  });

  it("uses the neutral default texts without opts", async () => {
    expect(await executeBrowseTool(undefined, "browse_screenshot", {})).toBe(j({ error: "The browser is not available." }));
    const bridge = bridgeWith({}, ["screenshot", "tabs", "findImages"]);
    for (const tool of ["browse_screenshot", "browse_tabs"]) {
      expect(await executeBrowseTool(bridge.browser, tool, {})).toBe(j({ error: `${tool} is not supported by this browser.` }));
    }
    // findImages is deliberately unguarded (Pen Editor never checked it): the TypeError message is the error.
    expect(await executeBrowseTool(bridge.browser, "browse_find_images", {})).toBe(j({ error: "browser.findImages is not a function" }));
  });

  it("without an afterScreenshot hook placeOnCanvas has no effect", async () => {
    bridgeWith({ screenshot: [SHOT] });
    expect(await browseScreenshot({ placeOnCanvas: true, x: 1 })).toBe(j(SHOT));
  });
});

describe("browse_screenshot afterScreenshot hook", () => {
  it("runs only for placeOnCanvas === true and receives the capture context", async () => {
    const bridge = bridgeWith({ screenshot: [SHOT, SHOT, { ...SHOT, imageData: "data:plain" }] });
    const seen: unknown[] = [];
    const opts = {
      ...hostOptions(),
      afterScreenshot: async (ctx: Parameters<NonNullable<ReturnType<typeof hostOptions>["afterScreenshot"]>>[0]) => {
        const plain = await ctx.capture({ annotate: false });
        seen.push({ raw: ctx.raw, result: ctx.result, args: ctx.args, bridgeArgs: ctx.bridgeArgs, plain });
        return "hooked";
      },
    };
    expect(await executeBrowseTool(bridge.browser, "browse_screenshot", { annotate: true, placeOnCanvas: false }, opts)).toBe(j(SHOT));
    expect(seen).toEqual([]);
    const out = await executeBrowseTool(bridge.browser, "browse_screenshot", { annotate: true, placeOnCanvas: true, x: 1, y: 2 }, opts);
    expect(out).toBe("hooked");
    expect(seen).toEqual([
      {
        raw: j(SHOT),
        result: SHOT,
        args: { annotate: true, placeOnCanvas: true, x: 1, y: 2 },
        bridgeArgs: { annotate: true },
        plain: j({ ...SHOT, imageData: "data:plain" }),
      },
    ]);
    // call log: the annotated capture, then the plain one
    expect(bridge.callsTo("screenshot").slice(-2).map((c) => c.args)).toEqual([[{ annotate: true }], [{ annotate: false }]]);
  });

  it("gets a malformed result as an error object and the raw string", async () => {
    const bridge = bridgeWith({ screenshot: [[1]] });
    let got: unknown;
    await executeBrowseTool(bridge.browser, "browse_screenshot", { placeOnCanvas: true }, {
      afterScreenshot: async ({ raw, result }) => {
        got = { raw, result };
        return raw;
      },
    });
    expect(got).toEqual({ raw: "[1]", result: { error: "browse_act: malformed result from the browser bridge." } });
  });
});
