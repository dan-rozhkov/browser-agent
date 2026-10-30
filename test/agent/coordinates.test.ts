import { asSchema } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBrowseActInputSchema,
  createBrowseToolDefinitions,
  describeBrowseAct,
  normalizeBrowseActInput,
} from "../../src/agent/index.js";
import golden from "./golden/coordinate-actions.json" with { type: "json" };
import { bridgeWith, browseAct, resetEnvironment, snap } from "./executeHarness.js";

afterEach(resetEnvironment);

const off = createBrowseActInputSchema();
const on = createBrowseActInputSchema({ coordinates: true });
const jsonOf = (schema: unknown) => asSchema(schema as never).jsonSchema as Record<string, any>;

describe("browse_act coordinates: schema", () => {
  it("flag off: no x, y, button or clicks, at the top level or in a batch entry", () => {
    const json = JSON.stringify(jsonOf(off));
    for (const key of ["\"x\"", "\"y\"", "\"button\"", "\"clicks\""]) expect(json).not.toContain(key);
    expect(createBrowseActInputSchema({ coordinates: false })).toBeDefined();
    expect(JSON.stringify(jsonOf(createBrowseActInputSchema({ coordinates: false })))).toBe(json);
  });

  it("flag on: the four fields come after `mobile` and before `actions`, top level and batch entry", () => {
    const top = jsonOf(on);
    const keys = Object.keys(top.properties);
    expect(keys.slice(keys.indexOf("mobile"))).toEqual(["mobile", "x", "y", "button", "clicks", "actions"]);
    const entryKeys = Object.keys(top.properties.actions.items.properties);
    expect(entryKeys.slice(entryKeys.indexOf("mobile"))).toEqual(["mobile", "x", "y", "button", "clicks"]);
    expect(top.properties.x.maximum).toBe(10000);
    expect(top.properties.clicks.maximum).toBe(2);
    expect(top.properties.button.enum).toEqual(["left", "right"]);
  });

  it("flag off refuses nothing new: an x key is dropped by the object schema, flag on keeps it", () => {
    expect(on.safeParse({ action: "click", x: 10, y: 20, button: "right", clicks: 2 }).success).toBe(true);
    expect(on.safeParse({ action: "click", x: -1, y: 20 }).success).toBe(false);
    expect(on.safeParse({ action: "click", x: 10, y: 20, button: "middle" }).success).toBe(false);
    expect(on.safeParse({ action: "click", x: 10, y: 20, clicks: 3 }).success).toBe(false);
    expect(on.safeParse({ actions: [{ action: "click", x: 10, y: 20 }, { action: "type", text: "a" }] }).success).toBe(true);
    const parsed = off.safeParse({ action: "click", x: 10, y: 20 });
    expect(parsed.success && "x" in (parsed.data as object)).toBe(false);
  });

  it("normalizes strict-mode placeholders: (0,0) pair, clicks 0 or 1, button empty", () => {
    expect(normalizeBrowseActInput({ action: "click", index: 3, snapshotId: "s", x: 0, y: 0, button: "", clicks: 0 })).toEqual({
      action: "click",
      index: 3,
      snapshotId: "s",
    });
    expect(normalizeBrowseActInput({ action: "click", x: 5, y: 6, clicks: 1, button: null })).toEqual({ action: "click", x: 5, y: 6 });
    // A lone 0 is a real edge, kept so the pair check can refuse it.
    expect(normalizeBrowseActInput({ action: "click", x: 0, y: 40 })).toEqual({ action: "click", x: 0, y: 40 });
    expect(normalizeBrowseActInput({ action: "click", x: 0, y: 0 })).toEqual({ action: "click" });
    expect(normalizeBrowseActInput({ action: "click", clicks: 2, x: 1, y: 2, actions: [{ action: "click", clicks: 2, x: 1, y: 2 }] })).toEqual({
      action: "click",
      clicks: 2,
      x: 1,
      y: 2,
    });
  });

  it("strict-mode batch: index 0 beside a real x/y pair is the placeholder, even with a snapshotId", () => {
    const out = normalizeBrowseActInput({
      snapshotId: "s5",
      actions: [{ action: "click", index: 0, x: 400, y: 300, button: "left", clicks: 1, target: "" }],
    }) as any;
    expect(out.actions[0]).toEqual({ action: "click", x: 400, y: 300, button: "left" });
    expect(normalizeBrowseActInput({ action: "click", snapshotId: "s5", index: 0, x: 4, y: 3 })).toEqual({ action: "click", snapshotId: "s5", x: 4, y: 3 });
    // Without a pair, index 0 beside a snapshotId is a real element.
    expect(normalizeBrowseActInput({ action: "click", snapshotId: "s5", index: 0 })).toEqual({ action: "click", snapshotId: "s5", index: 0 });
  });

  it("drops the single-call coordinate fields when a batch is given beside them", () => {
    const out = normalizeBrowseActInput({ action: "click", x: 1, y: 2, button: "left", clicks: 2, actions: [{ action: "reload" }, { action: "reload" }] }) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["actions"]);
  });
});

describe("browse_act coordinates: description", () => {
  it("is unchanged without the flag, and the passage is the last part with it", () => {
    const base = describeBrowseAct();
    expect(describeBrowseAct({ coordinateActions: false })).toBe(base);
    const withFlag = describeBrowseAct({ coordinateActions: true });
    expect(withFlag.startsWith(base + " ")).toBe(true);
    expect(withFlag.slice(base.length + 1)).toBe(golden.passage);
  });

  it("matches the pinned golden for coordinateActions: true", () => {
    const def = createBrowseToolDefinitions({ coordinateActions: true }).browse_act;
    expect(def.description).toBe(golden.description);
    expect(JSON.stringify(jsonOf(def.inputSchema))).toBe(JSON.stringify(golden.jsonSchema));
  });

  it("the other six definitions do not change with the flag", () => {
    const a = createBrowseToolDefinitions();
    const b = createBrowseToolDefinitions({ coordinateActions: true });
    for (const name of ["browse_open", "browse_snapshot", "browse_screenshot", "browse_tabs", "browse_find_images", "browse_read"] as const) {
      expect(b[name].description).toBe(a[name].description);
      expect(JSON.stringify(jsonOf(b[name].inputSchema))).toBe(JSON.stringify(jsonOf(a[name].inputSchema)));
    }
  });
});

describe("browse_act coordinates: executor pair check", () => {
  const PAIR = 'browse_act: "x" and "y" must be given together.';
  const EXCLUSIVE = 'browse_act: use either "index"/"target"/"element" or "x" and "y", not both.';
  const ONLY = 'browse_act: "x" and "y" work only with "click" and "type".';

  async function errorOf(args: Record<string, unknown>) {
    const bridge = bridgeWith({ act: [{ ok: 1 }], snapshot: [snap("s")] });
    const out = JSON.parse(await browseAct(args));
    return { out, bridge };
  }

  it("refuses x without y and y without x, single and in a batch", async () => {
    for (const args of [
      { action: "click", x: 5 },
      { action: "click", y: 5 },
      { actions: [{ action: "click", x: 5 }] },
    ]) {
      const { out, bridge } = await errorOf(args);
      expect(out.error).toBe(PAIR);
      expect(bridge.callsTo("act")).toEqual([]);
    }
  });

  it('refuses "button" or "clicks" without x and y, single and in a batch', async () => {
    const MSG = 'browse_act: "button" and "clicks" work only with "x" and "y".';
    for (const args of [
      { action: "click", target: "OK", button: "right" },
      { action: "click", target: "OK", clicks: 2 },
      { actions: [{ action: "click", index: 1, snapshotId: "s", clicks: 2 }] },
    ]) {
      const { out, bridge } = await errorOf(args);
      expect(out.error).toBe(MSG);
      expect(bridge.callsTo("act")).toEqual([]);
    }
  });

  it("a top-level snapshotId beside x and y is not refused", async () => {
    const bridge = bridgeWith({ act: [{ ok: 1 }], snapshot: [snap("s")] });
    const out = JSON.parse(await browseAct({ action: "click", x: 5, y: 6, snapshotId: "s" }));
    expect(out.error).toBeUndefined();
    expect(bridge.callsTo("act")).toHaveLength(1);
  });

  it("refuses x and y together with index, target or element", async () => {
    for (const extra of [{ index: 1 }, { target: "OK" }, { element: "the OK button" }]) {
      const { out, bridge } = await errorOf({ action: "click", x: 5, y: 6, snapshotId: "s", ...extra });
      expect(out.error).toBe(EXCLUSIVE);
      expect(bridge.callsTo("act")).toEqual([]);
    }
  });

  it("refuses x and y on an action other than click and type", async () => {
    for (const action of ["hover", "scroll", "press", "select", "wait"]) {
      const { out, bridge } = await errorOf({ action, x: 5, y: 6, text: "a", key: "Enter" });
      expect(out.error).toBe(ONLY);
      expect(bridge.callsTo("act")).toEqual([]);
    }
  });

  it("passes click and type at a point on to the bridge", async () => {
    const bridge = bridgeWith({ act: [{ ok: 1 }, { ok: 2 }], snapshot: [snap("s")] });
    await browseAct({ action: "click", x: 5, y: 6, button: "right", clicks: 2 });
    await browseAct({ action: "type", text: "hi", x: 5, y: 6 });
    expect(bridge.callsTo("act").map((c) => c.args)).toEqual([
      [{ action: "click", x: 5, y: 6, button: "right", clicks: 2 }],
      [{ action: "type", text: "hi", x: 5, y: 6 }],
    ]);
  });

  it("a batch stops at the first refused entry", async () => {
    const bridge = bridgeWith({ act: [{ ok: 1 }], snapshot: [snap("s")] });
    const out = JSON.parse(await browseAct({ actions: [{ action: "click", x: 1, y: 2 }, { action: "hover", x: 1, y: 2 }, { action: "click", x: 3, y: 4 }] }));
    expect(out.completed).toBe(1);
    expect(out.stoppedAt).toBe(1);
    expect(out.error).toBe(ONLY);
    expect(bridge.callsTo("act")).toHaveLength(1);
  });
});
