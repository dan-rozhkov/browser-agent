import { describe, expect, it, vi } from "vitest";
import { BrowserController, type BrowserTarget } from "../../src/controller/controller.js";

// x, y, button and clicks are for a native desktop app window only. This controller drives a browser tab
// (built-in or cloud), so it refuses them before it touches the page.
const REFUSAL =
  'browse_act: "x" and "y" work only in a desktop app window in native mode. This browser tab does not accept them. Use "target" or "index" with "snapshotId".';

function makeTarget() {
  const currentPage = vi.fn(() => null);
  return { target: { currentPage } as unknown as BrowserTarget, currentPage };
}

describe("BrowserController.act: coordinates", () => {
  it.each([
    { action: "click", x: 10, y: 20 },
    { action: "type", text: "a", x: 10, y: 20 },
    { action: "click", target: "OK", button: "right" },
    { action: "click", target: "OK", clicks: 2 },
    { action: "click", x: 0, y: 0 },
  ])("refuses %j", async (args) => {
    const { target } = makeTarget();
    const result = await new BrowserController(target).act(args);
    expect(result).toMatchObject({ error: REFUSAL });
  });

  it("refuses a batch entry that carries coordinates", async () => {
    const { target } = makeTarget();
    const result = await new BrowserController(target).act({ action: "click", actions: [{ action: "click", x: 1, y: 2 }] });
    expect(result).toMatchObject({ error: REFUSAL });
  });

  it("does not refuse a call without them (it reaches the page lookup: no tab is open)", async () => {
    const { target, currentPage } = makeTarget();
    const result = await new BrowserController(target).act({ action: "click", target: "OK" });
    expect(result).not.toMatchObject({ error: REFUSAL });
    expect(currentPage).toHaveBeenCalled();
  });
});
