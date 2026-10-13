import { describe, it, expect } from "vitest";
import { CURSOR_PLAN_JS } from "../../src/controller/pageScripts.js";

type Plan = { arrivalT: number; snapT: number | null; motionEndMs: number; samples: { t: number }[] };
type Opts = { style: string; from: { x: number; y: number }; to: { x: number; y: number }; w: number | null; reduce?: boolean; rot0?: number };

// The planner is a pure fragment; evaluate it in isolation.
const build = (src: string) => new Function("window", `${src}; return planMove;`)({}) as (o: Opts) => Plan;
const planMove = build(CURSOR_PLAN_JS);
// The same planner with the agent speed-up and the arrival cap neutralised:
// the cua timing, used as the baseline for the MOTION_TIME_SCALE check.
const UNSCALED_JS = CURSOR_PLAN_JS.replace("var MOTION_TIME_SCALE = 0.4;", "var MOTION_TIME_SCALE = 1;").replace(
  "var ARRIVAL_CAP_MS = 300;",
  "var ARRIVAL_CAP_MS = 1e9;"
);
const planUnscaled = build(UNSCALED_JS);

const STYLES = ["signature_arc", "spring_settle", "comet_swoop", "magnetic", "classic"];

describe("cursor plan timing", () => {
  for (const style of STYLES) {
    it(`${style}: a long move to a small target arrives within 300ms`, () => {
      const p = planMove({ style, from: { x: 20, y: 20 }, to: { x: 1220, y: 20 }, w: 12, rot0: 0 });
      expect(p.arrivalT).toBeGreaterThan(0);
      expect(p.arrivalT).toBeLessThanOrEqual(300);
      if (p.snapT !== null) expect(p.snapT).toBeLessThanOrEqual(p.arrivalT + 1);
    });

    it(`${style}: a short move is faster than the cua timing`, () => {
      const p = planMove({ style, from: { x: 100, y: 100 }, to: { x: 220, y: 160 }, w: 40, rot0: 0 });
      expect(p.arrivalT).toBeLessThanOrEqual(300);
    });
  }

  for (const style of STYLES) {
    it(`${style}: a move under the cap plays at MOTION_TIME_SCALE (0.4x) of the cua timing`, () => {
      const o = { style, from: { x: 100, y: 100 }, to: { x: 260, y: 160 }, w: 60, rot0: 0 };
      expect(UNSCALED_JS).not.toBe(CURSOR_PLAN_JS); // the replacements matched
      const base = planUnscaled(o);
      const fast = planMove(o);
      expect(base.arrivalT).toBeLessThan(700); // well under the cap once scaled
      expect(fast.arrivalT / base.arrivalT).toBeCloseTo(0.4, 2);
      if (base.snapT !== null) expect(fast.snapT! / base.snapT).toBeCloseTo(0.4, 2);
    });
  }

  it("classic: the overshoot and correction samples stay at least one 60 Hz frame apart", () => {
    const p = planMove({ style: "classic", from: { x: 20, y: 20 }, to: { x: 1220, y: 20 }, w: 12, rot0: 0 });
    // The tail is the last 3 samples of the motion proper: path end, overshoot (+8ms), correction (+25ms).
    const ts = p.samples.map((q) => q.t);
    const iEnd = ts.findIndex((t) => Math.abs(t - p.motionEndMs) < 1e-6);
    expect(iEnd).toBeGreaterThan(1);
    expect(ts[iEnd] - ts[iEnd - 1]).toBeGreaterThanOrEqual(16);
    expect(ts[iEnd - 1] - ts[iEnd - 2]).toBeGreaterThanOrEqual(8);
  });

  it("reduced motion keeps its 120ms glide", () => {
    const p = planMove({ style: "signature_arc", from: { x: 0, y: 0 }, to: { x: 800, y: 0 }, w: 12, reduce: true });
    expect(p.arrivalT).toBeGreaterThan(100);
    expect(p.arrivalT).toBeLessThanOrEqual(125);
  });
});
