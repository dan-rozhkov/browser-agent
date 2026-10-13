import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTION_CACHE_KILL_SWITCH_KEY,
  ACTION_CACHE_STORAGE_KEY,
  buildStepCacheKey,
  hashCachedLabel,
  lookupStepCache,
  writeStepCacheEntry,
} from "../../src/loop/actionCache.js";
import {
  browseTaskDeadlineMs,
  browseTaskInnerBoundMs,
  browseTaskOverallDeadlineMs,
  CLOUD_BROWSE_TASK_DEADLINE_MS,
  buildSubgoalGoal,
  capObservations,
  carryOverHistory,
  extractUrlFromGoal,
  runBrowseTask as runBrowseTaskPublic,
  runBrowseTaskCore,
  runBrowseTaskLoop as runBrowseTaskLoopImpl,
  wantsTextEntry,
  type BrowsePermissions,
  type LoopEnv,
  type RunBrowseTaskOptions,
} from "../../src/loop/browseTask.js";
import { createQuantityGate } from "../../src/loop/quantityGate.js";
import { fetchBrowseBackend, type SnapshotResult } from "../../src/loop/shared.js";
import { memoryStorage, type KeyValueStorage } from "../../src/loop/storage.js";
import { createHttpBackend } from "../../src/adapters/httpBackend.js";
import {
  stubBrowser as createBrowserStub,
  stubFetchSequence,
  type BrowserBridge,
} from "./helpers.js";

// Per-test host state, in place of what the pen-editor suite got from ambient
// globals: the Zustand permissions store -> `permissions`, localStorage ->
// `store` (an in-memory KeyValueStorage), window.penDesktop -> the `browser`
// argument. The backend is the real HTTP adapter over the stubbed global
// `fetch` (the /api/browse/* wire is stubbed exactly as before), so every
// request-shape assertion below is unchanged.
let store: KeyValueStorage;
let permissions: BrowsePermissions;
let stepScreenshots: boolean;
const backend = createHttpBackend({ baseUrl: "https://backend.test" });

beforeEach(() => {
  store = memoryStorage();
  permissions = { allowPasswordEntry: false, confirmIrreversible: true };
  stepScreenshots = false;
});

function envFor(browser: BrowserBridge): LoopEnv {
  return { browser, backend, permissions, storage: store, cloud: false, stepScreenshots };
}

type LoopRest = Parameters<typeof runBrowseTaskLoopImpl> extends [unknown, unknown, unknown, ...infer R] ? R : never;
type CoreRest = Parameters<typeof runBrowseTaskCore> extends [unknown, unknown, unknown, ...infer R] ? R : never;

/** The positional loop, with the host state above injected. */
function runBrowseTaskLoop(goal: string, maxSteps: number, browser: BrowserBridge, ...rest: LoopRest) {
  return runBrowseTaskLoopImpl(goal, maxSteps, envFor(browser), ...rest);
}

/** Options for the public `runBrowseTask`, with the host state above injected. */
function publicOpts(browser: BrowserBridge, extra: Partial<RunBrowseTaskOptions> = {}): RunBrowseTaskOptions {
  return { browser, backend, permissions, storage: store, stepScreenshots, ...extra };
}

/** The positional multi-sub-goal core, with the host state above injected. */
function runBrowseTask(goal: string, maxSteps: number, browser: BrowserBridge, ...rest: CoreRest) {
  return runBrowseTaskCore(goal, maxSteps, envFor(browser), ...rest);
}

const EXAMPLE_SNAPSHOT: SnapshotResult = {
  url: "https://example.com",
  title: "Example",
  elements: [{ index: 0, tag: "button", label: "Accept all", ops: ["CLICK"] }],
  snapshotId: "snap-1",
};

function stubBrowser(overrides: Partial<BrowserBridge>): BrowserBridge {
  return createBrowserStub(overrides, EXAMPLE_SNAPSHOT);
}

// Decisions reused verbatim across several scenarios below.
const CLICK_STEP = { outcome: "act", operation: "CLICK", index: 0, confidence: 0.9, model: "jev" };
const DONE = { outcome: "done", confidence: 1, model: "jev" };
const WAIT_LOW_CONFIDENCE_STEP = { outcome: "act", operation: "WAIT", confidence: 0.5, model: "jev" };
const TYPE_TEXT_STEP = {
  outcome: "act",
  operation: "TYPE_TEXT",
  index: 0,
  text: "headphones",
  confidence: 0.9,
  model: "jev",
};
const PRESS_ENTER_STEP = { outcome: "act", operation: "PRESS_ENTER", confidence: 0.9, model: "jev" };
const PRESS_ESCAPE_STEP = { outcome: "act", operation: "PRESS_ESCAPE", confidence: 0.9, model: "jev" };
const HOVER_STEP = { outcome: "act", operation: "HOVER", index: 0, confidence: 0.9, model: "jev" };

afterEach(() => {
  vi.unstubAllGlobals();
  // (The per-test `store` / `permissions` are re-created in beforeEach, so a
  // cache write in one test can't be replayed as a hit in another.)
});

describe("browse_task", () => {
  it("terminates on outcome:done and returns the documented transcript shape", async () => {
    stubFetchSequence([CLICK_STEP, { outcome: "done", confidence: 1, model: "jev", reason: "cookie banner dismissed" }]);

    const browser = stubBrowser({});
    const transcript = await runBrowseTaskLoop("accept cookies", 12, browser);

    expect(transcript.status).toBe("done");
    expect(transcript.reason).toBe("cookie banner dismissed");
    expect(transcript.url).toBe("https://example.com");
    expect(transcript.title).toBe("Example");
    expect(transcript.steps).toEqual([
      { operation: "CLICK", label: "Accept all", ok: true, index: 0 },
    ]);
  });

  it("terminates on outcome:blocked without performing the blocked step", async () => {
    const perform = vi.fn(async () => ({}));
    stubFetchSequence([{ outcome: "blocked", confidence: 0.2, model: "jev", reason: "confidence below threshold" }]);

    const browser = stubBrowser({ perform });
    const transcript = await runBrowseTaskLoop("log in", 12, browser);

    expect(transcript.status).toBe("blocked");
    expect(transcript.reason).toBe("confidence below threshold");
    expect(transcript.steps).toEqual([]);
    expect(perform).not.toHaveBeenCalled();
  });

  it("records outcome:retry as a step and continues the loop instead of ending the task", async () => {
    // A single transient Jev blip (timeout/malformed answer/no candidate
    // element) must not kill the whole task — addendum B's whole point.
    stubFetchSequence([
      { outcome: "retry", confidence: 0.4, model: "jev", reason: "no candidate element" },
      { outcome: "done", confidence: 1, model: "jev", reason: "goal met" },
    ]);

    const perform = vi.fn(async () => ({}));
    const browser = stubBrowser({ perform });
    const transcript = await runBrowseTaskLoop("find a red sneaker", 12, browser);

    expect(transcript.status).toBe("done");
    expect(transcript.steps).toEqual([
      { operation: "RETRY", label: "no candidate element", ok: false },
    ]);
    expect(perform).not.toHaveBeenCalled();
  });

  it("treats a missing/unrecognized outcome defensively — recorded and continued, not claimed as success", async () => {
    stubFetchSequence([
      { operation: "CLICK", index: 0, confidence: 0.9, model: "jev" }, // no `outcome` at all
      { outcome: "some_future_value", confidence: 0.9, model: "jev" },
    ]);

    const perform = vi.fn(async () => ({}));
    const browser = stubBrowser({ perform });
    const transcript = await runBrowseTaskLoop("wander forever", 2, browser);

    expect(transcript.status).toBe("budget");
    expect(perform).not.toHaveBeenCalled();
    expect(transcript.steps).toEqual([
      { operation: "CLICK", label: "unrecognized step outcome: undefined", ok: false },
      { operation: "UNKNOWN_OUTCOME", label: "unrecognized step outcome: some_future_value", ok: false },
    ]);
  });

  // Live bench finding (booking.com): browser.open returns at DOM-ready, so
  // the first snapshot is blank and used to reach Jev, which answered BLOCKED.
  describe("blank first snapshot (page not rendered yet)", () => {
    const BLANK_SNAPSHOT = { url: "https://www.booking.com", title: "", elements: [], text: "  ", snapshotId: "blank" };

    it("re-snapshots instead of asking Jev, then sends the first non-empty snapshot exactly once", async () => {
      const bodies: Array<{ elements: unknown[] }> = [];
      const fetchMock = stubFetchSequence([DONE], (init) => bodies.push(JSON.parse(String(init.body))));
      let calls = 0;
      const snapshot = vi.fn(async () => (++calls < 3 ? BLANK_SNAPSHOT : EXAMPLE_SNAPSHOT));
      const sleep = vi.fn(async () => {});

      const transcript = await runBrowseTaskLoop("look", 12, stubBrowser({ snapshot }), undefined, sleep);

      expect(transcript.status).toBe("done");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(bodies[0].elements.length).toBeGreaterThan(0);
      expect(sleep).toHaveBeenCalledWith(400);
      expect(transcript.steps).toEqual([]);
    });

    it("gives up after the bound and asks Jev once, as before", async () => {
      const fetchMock = stubFetchSequence([{ outcome: "blocked", confidence: 0.2, model: "jev", reason: "empty" }]);
      const snapshot = vi.fn(async () => BLANK_SNAPSHOT);
      const sleep = vi.fn(async () => {});

      const transcript = await runBrowseTaskLoop("look", 12, stubBrowser({ snapshot }), undefined, sleep);

      expect(transcript.status).toBe("blocked");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sleep).toHaveBeenCalledTimes(12);
      expect(sleep.mock.calls.length * 400).toBeLessThanOrEqual(5_000);
    });

    it("does not poll a snapshot without `text` (an older desktop build), only an empty one", async () => {
      const fetchMock = stubFetchSequence([DONE]);
      const { text: _omitted, ...noText } = BLANK_SNAPSHOT;
      const snapshot = vi.fn(async () => noText);
      const sleep = vi.fn(async () => {});

      await runBrowseTaskLoop("look", 12, stubBrowser({ snapshot }), undefined, sleep);

      expect(sleep).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("polls only the first snapshot, never a page that goes blank mid-task", async () => {
      const fetchMock = stubFetchSequence([{ outcome: "act", operation: "WAIT", confidence: 0.9, model: "jev" }, DONE]);
      let calls = 0;
      const snapshot = vi.fn(async () => (++calls === 1 ? EXAMPLE_SNAPSHOT : BLANK_SNAPSHOT));
      const sleep = vi.fn(async () => {});

      await runBrowseTaskLoop("look", 12, stubBrowser({ snapshot }), undefined, sleep);

      // One sleep: the WAIT itself — the blank second snapshot is not polled.
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  it("sleeps and re-snapshots on WAIT without ever calling perform", async () => {
    // Addendum A: WAIT never reaches `perform`; the loop handles it itself.
    stubFetchSequence([{ outcome: "act", operation: "WAIT", confidence: 0.9, model: "jev" }, DONE]);

    let snapshotCalls = 0;
    const snapshot = vi.fn(async () => {
      snapshotCalls++;
      return {
        url: "https://example.com",
        title: "Example",
        elements: [{ index: 0, tag: "button", label: "Accept all", ops: ["CLICK"] }],
        snapshotId: `snap-${snapshotCalls}`,
      };
    });
    const perform = vi.fn(async () => ({}));
    const sleep = vi.fn(async () => {});
    const browser = stubBrowser({ snapshot, perform });

    const transcript = await runBrowseTaskLoop(
      "wait for the page to load",
      12,
      browser,
      undefined,
      sleep
    );

    expect(transcript.status).toBe("done");
    expect(perform).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(400);
    // 2, not 3: the pre-loop "is a tab already open?" probe (requirement 1)
    // succeeds here (a real snapshot, not the "no tab" error) and is REUSED
    // as the first loop iteration's snapshot (finding: it used to be thrown
    // away, doubling the snapshot cost) — so only the WAIT's follow-up
    // snapshot is a second, genuinely new call.
    expect(snapshotCalls).toBe(2);
    expect(transcript.steps).toEqual([
      { operation: "WAIT", label: "waiting for the page to settle", ok: true },
    ]);
  });

  // Live bench finding (2026-09-24): Jev chose WAIT six times in a row at
  // low confidence before anything else happened. WAIT was always recorded
  // `ok: true`, which resets MAX_CONSECUTIVE_UNPRODUCTIVE_STEPS on every
  // cycle, so an unbroken run of WAITs could never trip the stall detector.
  describe("consecutive WAIT decisions on an unchanging page (MAX_CONSECUTIVE_SAME_URL_WAITS)", () => {
    // Same url on every snapshot — nothing ever navigates.
    const FIXED_URL_SNAPSHOT: SnapshotResult = {
      url: "https://example.com",
      title: "Example",
      elements: [{ index: 0, tag: "button", label: "Accept all", ops: ["CLICK"] }],
      snapshotId: "snap-fixed",
    };

    it("stops actually sleeping on the 3rd consecutive WAIT with the same url, and eventually stalls", async () => {
      stubFetchSequence([WAIT_LOW_CONFIDENCE_STEP]);

      const snapshot = vi.fn(async () => FIXED_URL_SNAPSHOT);
      const sleep = vi.fn(async () => {});
      const browser = stubBrowser({ snapshot });

      const transcript = await runBrowseTaskLoop(
        "wait for the page to load",
        12,
        browser,
        undefined,
        sleep
      );

      expect(transcript.status).toBe("stalled");
      // Two genuine sleeps (the pre-loop probe's snapshot is WAIT #1, the
      // follow-up snapshot is WAIT #2), then WAIT #3-#5 are all recorded
      // unproductive without sleeping again — three unproductive steps in a
      // row is what actually stalls the loop.
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(transcript.steps).toEqual([
        { operation: "WAIT", label: "waiting for the page to settle", ok: true },
        { operation: "WAIT", label: "waiting for the page to settle", ok: true },
        { operation: "WAIT", label: "(waited, nothing changed)", ok: false },
        { operation: "WAIT", label: "(waited, nothing changed)", ok: false },
        { operation: "WAIT", label: "(waited, nothing changed)", ok: false },
      ]);
    });

    it("keeps sleeping on every WAIT when the url changes between them (never caps)", async () => {
      stubFetchSequence([WAIT_LOW_CONFIDENCE_STEP]);

      let snapshotCalls = 0;
      const snapshot = vi.fn(async () => {
        snapshotCalls++;
        return {
          url: `https://example.com/page-${snapshotCalls}`,
          title: "Example",
          elements: [{ index: 0, tag: "button", label: "Accept all", ops: ["CLICK"] }],
          snapshotId: `snap-${snapshotCalls}`,
        };
      });
      const sleep = vi.fn(async () => {});
      const browser = stubBrowser({ snapshot });

      const transcript = await runBrowseTaskLoop(
        "wait for navigation",
        4,
        browser,
        undefined,
        sleep
      );

      expect(transcript.status).toBe("budget");
      expect(sleep).toHaveBeenCalledTimes(4);
      expect(transcript.steps.every((step) => step.ok)).toBe(true);
      expect(transcript.steps.every((step) => step.label === "waiting for the page to settle")).toBe(
        true
      );
    });

    it("resets the same-url WAIT streak once a non-WAIT operation lands in between", async () => {
      let stepCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          stepCalls++;
          // WAIT, WAIT, CLICK (lands), then WAIT, WAIT, WAIT again — the
          // CLICK in the middle must reset the streak so the next two WAITs
          // are treated as the start of a fresh streak, not a continuation.
          const sequence = ["WAIT", "WAIT", "CLICK", "WAIT", "WAIT", "WAIT"];
          const operation = sequence[Math.min(stepCalls - 1, sequence.length - 1)];
          return {
            ok: true,
            json: async () =>
              operation === "CLICK"
                ? { outcome: "act", operation: "CLICK", index: 0, confidence: 0.9, model: "jev" }
                : { outcome: "act", operation: "WAIT", confidence: 0.5, model: "jev" },
          };
        })
      );

      const snapshot = vi.fn(async () => FIXED_URL_SNAPSHOT);
      const sleep = vi.fn(async () => {});
      const perform = vi.fn(async () => ({}));
      const browser = stubBrowser({ snapshot, perform });

      const transcript = await runBrowseTaskLoop(
        "wait around a click",
        6,
        browser,
        undefined,
        sleep
      );

      // Two sleeps before the CLICK, then two more after it (the streak
      // reset) — the 6th and final decision (WAIT again) is the 3rd of that
      // fresh streak and is skipped, but the loop simply runs out of
      // maxSteps before enough unproductive steps accumulate to stall.
      expect(sleep).toHaveBeenCalledTimes(4);
      expect(transcript.status).toBe("budget");
      expect(transcript.steps.map((step) => `${step.operation}:${step.ok}`)).toEqual([
        "WAIT:true",
        "WAIT:true",
        "CLICK:true",
        "WAIT:true",
        "WAIT:true",
        "WAIT:false",
      ]);
    });
  });

  it("forwards a scroll decision to perform without an `index` key when none is given", async () => {
    stubFetchSequence([{ outcome: "act", operation: "SCROLL_DOWN", confidence: 0.9, model: "jev" }]);

    const perform = vi.fn(async (_args: Parameters<BrowserBridge["perform"]>[0]) => ({}));
    const browser = stubBrowser({ perform });
    const transcript = await runBrowseTaskLoop("scroll down", 1, browser);

    expect(perform).toHaveBeenCalledTimes(1);
    const performArgs = (perform.mock.calls as unknown as unknown[][])[0][0];
    expect(performArgs).not.toHaveProperty("index");
    expect(performArgs).toMatchObject({ operation: "SCROLL_DOWN", snapshotId: "snap-1" });
    expect(transcript.steps).toEqual([{ operation: "SCROLL_DOWN", label: "", ok: true }]);
  });

  it("records a CLICK decision missing its index as a failed step and never calls perform", async () => {
    stubFetchSequence([{ outcome: "act", operation: "CLICK", confidence: 0.9, model: "jev" }]);

    const perform = vi.fn(async () => ({}));
    const browser = stubBrowser({ perform });
    const transcript = await runBrowseTaskLoop("click something", 1, browser);

    expect(perform).not.toHaveBeenCalled();
    expect(transcript.steps).toEqual([
      { operation: "CLICK", label: "missing index for a non-scroll operation", ok: false },
    ]);
  });

  it("stops at maxSteps when the loop never resolves outcome:done/blocked", async () => {
    stubFetchSequence([CLICK_STEP]);

    const browser = stubBrowser({});
    const transcript = await runBrowseTaskLoop("wander forever", 3, browser);

    expect(transcript.status).toBe("budget");
    expect(transcript.reason).toBe("maxSteps reached");
    expect(transcript.steps).toHaveLength(3);
  });

  it("caps maxSteps at the hard cap of 25 even when a larger value is requested", async () => {
    stubFetchSequence([CLICK_STEP]);

    const browser = stubBrowser({});
    const transcript = await runBrowseTaskLoop("wander forever", 1000, browser);

    expect(transcript.steps).toHaveLength(25);
  });

  it("stops once the deadline is reached, before maxSteps", async () => {
    stubFetchSequence([{ operation: "CLICK", index: 0, confidence: 0.9, model: "jev" }]);

    const browser = stubBrowser({});
    let clock = 0;
    // Each loop iteration advances the fake clock past the 90s deadline
    // after the first step, so the loop must stop on the deadline check
    // rather than running out maxSteps.
    const now = () => {
      const value = clock;
      clock += 91_000;
      return value;
    };

    const transcript = await runBrowseTaskLoop("wander forever", 12, browser, now);

    expect(transcript.status).toBe("budget");
    expect(transcript.reason).toBe("deadline exceeded");
    expect(transcript.steps).toHaveLength(0);
  });

  it("runs past the desktop's 90s when given the cloud deadline", async () => {
    // Every landed action costs 40s of wall clock (a slow cloud click): the
    // desktop budget (90s, 35s reserve) stops after the first one, the cloud
    // budget reaches DONE.
    let clock = 0;
    const slowBrowser = () =>
      stubBrowser({
        perform: async () => {
          clock += 40_000;
          return {};
        },
      });
    const now = () => clock;

    stubFetchSequence([CLICK_STEP, CLICK_STEP, DONE]);
    const desktop = await runBrowseTaskLoop("fill the form", 12, slowBrowser(), now);
    expect(desktop.reason).toBe("deadline exceeded");

    clock = 0;
    store = memoryStorage(); // or the action cache replays the first run's steps
    stubFetchSequence([CLICK_STEP, CLICK_STEP, DONE]);
    const cloud = await runBrowseTaskLoop(
      "fill the form",
      12,
      slowBrowser(),
      now,
      undefined,
      undefined,
      CLOUD_BROWSE_TASK_DEADLINE_MS
    );
    expect(cloud.status).toBe("done");
  });

  it("gives the cloud browser the longer deadline and the desktop the original one", () => {
    expect(browseTaskDeadlineMs(true)).toBe(CLOUD_BROWSE_TASK_DEADLINE_MS);
    expect(browseTaskDeadlineMs(false)).toBe(90_000);
  });

  it("records a failing perform step without ending the task", async () => {
    stubFetchSequence([CLICK_STEP, DONE]);

    const perform = vi
      .fn()
      .mockRejectedValueOnce(new Error("stale snapshotId"))
      .mockResolvedValue({});
    const browser = stubBrowser({ perform });

    const transcript = await runBrowseTaskLoop("accept cookies", 12, browser);

    expect(transcript.status).toBe("done");
    expect(transcript.steps).toEqual([
      { operation: "CLICK", label: "stale snapshotId", ok: false, index: 0 },
    ]);
    expect(perform).toHaveBeenCalledTimes(1);
  });

  it("records a failing snapshot/step call without ending the task", async () => {
    let snapshotCalls = 0;
    const snapshot = vi.fn(async () => {
      snapshotCalls++;
      // Call 1 is the pre-loop "is a tab already open?" probe (requirement
      // 1) — it must succeed, and (finding: reused as the first loop
      // iteration's own snapshot) is then consumed by iteration 0 without a
      // second snapshot() call. Call 2 is iteration 1's own fresh snapshot,
      // taken after iteration 0's CLICK landed — that's the one this test
      // fails, to exercise a mid-LOOP snapshot failure.
      if (snapshotCalls === 2) {
        throw new Error("page navigating");
      }
      return {
        url: "https://example.com",
        title: "Example",
        elements: [{ index: 0, tag: "button", label: "Accept all", ops: ["CLICK"] }],
        snapshotId: "snap-2",
      };
    });
    stubFetchSequence([CLICK_STEP, DONE]);

    const perform = vi.fn(async () => ({}));
    const browser = stubBrowser({ snapshot, perform });
    const transcript = await runBrowseTaskLoop("accept cookies", 12, browser);

    expect(transcript.status).toBe("done");
    expect(transcript.steps).toEqual([
      { operation: "CLICK", label: "Accept all", ok: true, index: 0 },
      { operation: "SNAPSHOT", label: "page navigating", ok: false },
    ]);
  });

  it("runBrowseTask forwards goal and options and resolves a real, JSON-serializable transcript", async () => {
    let receivedBody: unknown;
    stubFetchSequence([DONE], (init) => {
      receivedBody = JSON.parse(init.body as string);
    });

    const result = await runBrowseTaskPublic("find a red sneaker", publicOpts(stubBrowser({}), { maxSteps: 5 }));

    expect(() => JSON.stringify(result)).not.toThrow();
    expect(result.status).toBe("done");
    expect(result).toHaveProperty("steps");
    expect(result).toHaveProperty("url");
    expect(result).toHaveProperty("title");
    expect(receivedBody).toMatchObject({ goal: "find a red sneaker" });
  });
  // Upstream jev-ultrafast PR #40, ported: a rejected act must be recorded
  // as a no-op (the bridge resolves `{ error }`, it never rejects), and
  // three consecutive steps that land nothing end the task instead of
  // spending a paid Jev call per cycle until maxSteps runs out.
  it("records a perform that resolved with { error } as a failed step, not a landed action", async () => {
    stubFetchSequence([CLICK_STEP, DONE]);

    const perform = vi
      .fn()
      .mockResolvedValueOnce({ error: "Stale or unknown snapshotId — the page may have changed." })
      .mockResolvedValue({});
    const browser = stubBrowser({ perform });

    const transcript = await runBrowseTaskLoop("accept cookies", 12, browser);

    expect(transcript.steps).toEqual([
      {
        operation: "CLICK",
        label: "Stale or unknown snapshotId — the page may have changed.",
        ok: false,
        index: 0,
      },
    ]);
  });

  it("stops with status:stalled after three consecutive steps that land nothing", async () => {
    const fetchMock = stubFetchSequence([CLICK_STEP]);

    // A persistently stale target: every act is rejected by the desktop
    // controller, so the loop would otherwise run all 12 steps.
    const perform = vi.fn(async () => ({ error: "target is gone or occluded" }));
    const browser = stubBrowser({ perform });

    const transcript = await runBrowseTaskLoop("click the popover", 12, browser);

    expect(transcript.status).toBe("stalled");
    expect(transcript.reason).toMatch(/no progress/i);
    expect(transcript.steps).toHaveLength(3);
    expect(perform).toHaveBeenCalledTimes(3);
    // Three decisions paid for, not twelve.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("resets the no-progress count on a step that did land", async () => {
    // Five CLICK decisions, then done — matched against the five perform
    // outcomes below (fail, fail, land, fail, fail).
    stubFetchSequence([CLICK_STEP, CLICK_STEP, CLICK_STEP, CLICK_STEP, CLICK_STEP, DONE]);

    // fail, fail, land, fail, fail — never three in a row, so the task runs
    // to its own conclusion.
    const perform = vi
      .fn()
      .mockResolvedValueOnce({ error: "target is gone" })
      .mockResolvedValueOnce({ error: "target is gone" })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ error: "target is gone" })
      .mockResolvedValue({ error: "target is gone" });
    const browser = stubBrowser({ perform });

    const transcript = await runBrowseTaskLoop("click something", 12, browser);

    expect(transcript.status).toBe("done");
    expect(transcript.steps.map((step) => step.ok)).toEqual([false, false, true, false, false]);
  });

  // Full browser use (docs/superpowers/specs/
  // 2026-09-23-full-browser-use-design.md): PRESS_ENTER/PRESS_ESCAPE and
  // HOVER dispatch through browser.act, not browser.perform.
  it("dispatches PRESS_ENTER as browser.act({action:'press', key:'Enter'}) right after a landed TYPE_TEXT", async () => {
    stubFetchSequence([TYPE_TEXT_STEP, PRESS_ENTER_STEP, DONE]);

    const act = vi.fn(async () => ({}));
    const perform = vi.fn(async () => ({}));
    const browser = stubBrowser({ act, perform });
    const transcript = await runBrowseTaskLoop("submit the form", 12, browser);

    expect(act).toHaveBeenCalledTimes(1);
    expect(act).toHaveBeenCalledWith({ action: "press", key: "Enter" });
    expect(perform).toHaveBeenCalledTimes(1);
    expect(transcript.steps).toEqual([
      { operation: "TYPE_TEXT", label: 'TYPE_TEXT "headphones" into "Accept all"', ok: true, index: 0 },
      { operation: "PRESS_ENTER", label: "press Enter", ok: true },
    ]);
  });

  it("refuses PRESS_ENTER without calling the bridge when the last landed step was not TYPE_TEXT", async () => {
    stubFetchSequence([PRESS_ENTER_STEP, DONE]);

    const act = vi.fn(async () => ({}));
    const browser = stubBrowser({ act });
    const transcript = await runBrowseTaskLoop("submit the form", 12, browser);

    expect(act).not.toHaveBeenCalled();
    expect(transcript.steps).toEqual([
      {
        operation: "PRESS_ENTER",
        label: "Enter is only pressed right after typing into a field",
        ok: false,
      },
    ]);
  });

  // The backend reads a <select>'s choice back out of this label when an
  // older desktop build doesn't report the select's value itself.
  it("records which option a SELECT chose in the step label", async () => {
    stubFetchSequence([{ outcome: "act", operation: "SELECT", index: 0, text: "Germany", confidence: 0.9, model: "jev" }, DONE]);
    const transcript = await runBrowseTaskLoop("pick Germany", 12, stubBrowser({}));

    expect(transcript.steps[0]).toEqual({ operation: "SELECT", label: 'SELECT "Germany" in "Accept all"', ok: true, index: 0 });
  });

  it("refuses a second PRESS_ENTER right after the first (a landed PRESS_ENTER is not TYPE_TEXT)", async () => {
    // TYPE_TEXT once, then PRESS_ENTER decided twice in a row (the loop
    // never reaches outcome:done here — maxSteps below is what ends it).
    stubFetchSequence([TYPE_TEXT_STEP, PRESS_ENTER_STEP]);

    const act = vi.fn(async () => ({}));
    const perform = vi.fn(async () => ({}));
    const browser = stubBrowser({ act, perform });
    const transcript = await runBrowseTaskLoop("submit the form", 3, browser);

    expect(act).toHaveBeenCalledTimes(1); // only the first PRESS_ENTER lands
    expect(transcript.steps[0]).toEqual({ operation: "TYPE_TEXT", label: 'TYPE_TEXT "headphones" into "Accept all"', ok: true, index: 0 });
    expect(transcript.steps[1]).toEqual({ operation: "PRESS_ENTER", label: "press Enter", ok: true });
    expect(transcript.steps[2]).toEqual({
      operation: "PRESS_ENTER",
      label: "Enter is only pressed right after typing into a field",
      ok: false,
    });
  });

  it("dispatches PRESS_ESCAPE as browser.act({action:'press', key:'Escape'})", async () => {
    stubFetchSequence([PRESS_ESCAPE_STEP, DONE]);

    const act = vi.fn(async () => ({}));
    const browser = stubBrowser({ act });
    const transcript = await runBrowseTaskLoop("close the modal", 12, browser);

    expect(act).toHaveBeenCalledTimes(1);
    expect(act).toHaveBeenCalledWith({ action: "press", key: "Escape" });
    expect(transcript.steps).toEqual([{ operation: "PRESS_ESCAPE", label: "press Escape", ok: true }]);
  });

  describe("closes an open popup before accepting DONE", () => {
    const pageWith = (elements: unknown[], extra: Record<string, unknown> = {}): SnapshotResult =>
      ({
        url: "https://example.com/list",
        title: "List",
        elements,
        snapshotId: "snap-popup",
        ...extra,
      }) as SnapshotResult;
    const OPTION = { index: 0, tag: "div", role: "option", label: "Red", ops: ["CLICK"] };
    const BUTTON = { index: 0, tag: "button", label: "Apply", ops: ["CLICK"] };
    const OPEN_MENU = { index: 1, tag: "button", role: "combobox", label: "Colors", expanded: true, ops: ["CLICK"] };
    const CLOSED_MENU = { ...OPEN_MENU, expanded: false };
    const escapeCalls = (act: ReturnType<typeof vi.fn>) =>
      act.mock.calls.filter((c) => (c[0] as { key?: string }).key === "Escape");

    it("presses Escape between a choice CLICK and DONE when a popup is still open, then accepts DONE", async () => {
      const fetchMock = stubFetchSequence([CLICK_STEP, DONE, DONE]);
      const act = vi.fn(async () => ({}));
      const browser = stubBrowser({ act, snapshot: async () => pageWith([OPTION, OPEN_MENU]) });
      const t = await runBrowseTaskLoop("filter by red", 12, browser);

      expect(t.status).toBe("done");
      expect(act).toHaveBeenCalledTimes(1);
      expect(act).toHaveBeenCalledWith({ action: "press", key: "Escape" });
      expect(t.steps.map((s) => s.operation)).toEqual(["CLICK", "PRESS_ESCAPE"]);
      expect(t.steps[1]).toMatchObject({ label: expect.stringContaining("close the open popup"), ok: true });
      // CLICK, first DONE (intercepted), second DONE (accepted).
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("presses Escape when the clicked option / menuitemcheckbox is still listed, without aria-expanded", async () => {
      for (const role of ["option", "menuitemcheckbox"]) {
        stubFetchSequence([CLICK_STEP, DONE, DONE]);
        const act = vi.fn(async () => ({}));
        const el = { index: 0, tag: "div", role, label: "Red", ops: ["CLICK"] };
        const browser = stubBrowser({ act, snapshot: async () => pageWith([el]) });
        const t = await runBrowseTaskLoop("filter by red", 12, browser);
        expect(t.status).toBe("done");
        expect(escapeCalls(act)).toHaveLength(1);
      }
    });

    it("does not press Escape when the clicked option is gone and nothing is expanded", async () => {
      stubFetchSequence([CLICK_STEP, DONE]);
      const act = vi.fn(async () => ({}));
      let n = 0;
      const nav = { index: 2, tag: "a", role: "menuitem", label: "Home", ops: ["CLICK"] };
      const browser = stubBrowser({ act, snapshot: async () => pageWith(n++ === 0 ? [OPTION, nav] : [nav]) });
      const t = await runBrowseTaskLoop("filter by red", 12, browser);
      expect(t.status).toBe("done");
      expect(escapeCalls(act)).toHaveLength(0);
    });

    it("does not press Escape after a checkbox click unless something is expanded", async () => {
      stubFetchSequence([CLICK_STEP, DONE]);
      const act = vi.fn(async () => ({}));
      const box = { index: 0, tag: "input", role: "checkbox", label: "Red", ops: ["CLICK"] };
      const browser = stubBrowser({ act, snapshot: async () => pageWith([box]) });
      await runBrowseTaskLoop("tick red", 12, browser);
      expect(escapeCalls(act)).toHaveLength(0);
    });

    it("does not press Escape when nothing is open", async () => {
      stubFetchSequence([CLICK_STEP, DONE]);
      const act = vi.fn(async () => ({}));
      const checkbox = { index: 0, tag: "input", role: "checkbox", label: "Red", ops: ["CLICK"] };
      const browser = stubBrowser({ act, snapshot: async () => pageWith([checkbox, CLOSED_MENU]) });
      const t = await runBrowseTaskLoop("tick red", 12, browser);
      expect(t.status).toBe("done");
      expect(act).not.toHaveBeenCalled();
    });

    it("presses Escape at most once per run: a second DONE is accepted", async () => {
      stubFetchSequence([CLICK_STEP, DONE]);
      const act = vi.fn(async () => ({}));
      const browser = stubBrowser({ act, snapshot: async () => pageWith([OPTION, OPEN_MENU]) });
      const t = await runBrowseTaskLoop("filter by red", 12, browser);
      expect(t.status).toBe("done");
      expect(escapeCalls(act)).toHaveLength(1);
    });

    it("does not press Escape when the preceding step was not a choice click", async () => {
      stubFetchSequence([CLICK_STEP, DONE]);
      const act = vi.fn(async () => ({}));
      const browser = stubBrowser({ act, snapshot: async () => pageWith([BUTTON, OPEN_MENU]) });
      const t = await runBrowseTaskLoop("press apply", 12, browser);
      expect(t.status).toBe("done");
      expect(act).not.toHaveBeenCalled();
    });

    it("does not press Escape when a dialog is open", async () => {
      stubFetchSequence([CLICK_STEP, DONE]);
      const act = vi.fn(async () => ({}));
      const browser = stubBrowser({
        act,
        snapshot: async () => pageWith([OPTION, OPEN_MENU], { modal: "Confirm your choice" }),
      });
      const t = await runBrowseTaskLoop("filter by red", 12, browser);
      expect(t.status).toBe("done");
      expect(act).not.toHaveBeenCalled();
    });
  });

  it("dispatches HOVER as browser.act({action:'hover', index, snapshotId}) using the current step's snapshotId", async () => {
    stubFetchSequence([HOVER_STEP, DONE]);

    const act = vi.fn(async () => ({}));
    const browser = stubBrowser({ act });
    const transcript = await runBrowseTaskLoop("reveal the menu", 12, browser);

    expect(act).toHaveBeenCalledTimes(1);
    expect(act).toHaveBeenCalledWith({ action: "hover", index: 0, snapshotId: "snap-1" });
    expect(transcript.steps).toEqual([{ operation: "HOVER", label: "Accept all", ok: true, index: 0 }]);
  });

  it("records a HOVER decision missing its index as a failed step and never calls act", async () => {
    stubFetchSequence([{ outcome: "act", operation: "HOVER", confidence: 0.9, model: "jev" }]);

    const act = vi.fn(async () => ({}));
    const browser = stubBrowser({ act });
    const transcript = await runBrowseTaskLoop("hover something", 1, browser);

    expect(act).not.toHaveBeenCalled();
    expect(transcript.steps).toEqual([
      { operation: "HOVER", label: "missing index for a non-scroll operation", ok: false },
    ]);
  });

  it("records a { error }-resolved act (PRESS_ENTER/HOVER) as a failed step, not a landed action", async () => {
    stubFetchSequence([TYPE_TEXT_STEP, PRESS_ENTER_STEP, DONE]);

    const act = vi.fn(async () => ({ error: "nothing is focused" }));
    const perform = vi.fn(async () => ({}));
    const browser = stubBrowser({ act, perform });
    const transcript = await runBrowseTaskLoop("submit", 12, browser);

    expect(transcript.steps).toEqual([
      { operation: "TYPE_TEXT", label: 'TYPE_TEXT "headphones" into "Accept all"', ok: true, index: 0 },
      { operation: "PRESS_ENTER", label: "nothing is focused", ok: false },
    ]);
  });

  describe("two-step cycle detection", () => {
    const THREE_BUTTONS: SnapshotResult = {
      url: "https://example.com",
      title: "Example",
      elements: [
        { index: 0, tag: "button", label: "Search field", ops: ["CLICK"] },
        { index: 1, tag: "button", label: "Close", ops: ["CLICK"] },
        { index: 2, tag: "button", label: "Other", ops: ["CLICK"] },
      ],
      snapshotId: "snap-1",
    };
    const hover = (index: number) => ({ ...HOVER_STEP, index });
    // Every act lands ("page updated"), so only the cycle rule can stop the loop.
    const updated = async () => ({ changed: false, pageChanged: true, appeared: ["dropdown"] });

    it("stalls at exactly the sixth step of an A,B,A,B,A,B pattern", async () => {
      const fetchMock = stubFetchSequence([hover(0), hover(1), hover(0), hover(1), hover(0), hover(1)]);
      const browser = stubBrowser({ act: updated, snapshot: async () => THREE_BUTTONS });
      const t = await runBrowseTaskLoop("open the menu", 20, browser);
      expect(t.status).toBe("stalled");
      expect(t.steps).toHaveLength(6);
      expect(fetchMock).toHaveBeenCalledTimes(6);
      expect(t.reason).toBe(
        'cycle — "Search field (page updated: "dropdown")" and "Close (page updated: "dropdown")" repeated 3 times'
      );
    });

    it("stalls on A,B,A,B,A,B where A and B are landed CLICKs with identical effects", async () => {
      const click = (index: number) => ({ ...HOVER_STEP, operation: "CLICK", index });
      stubFetchSequence([click(0), click(1), click(0), click(1), click(0), click(1), DONE]);
      const browser = stubBrowser({ act: updated, snapshot: async () => THREE_BUTTONS });
      const t = await runBrowseTaskLoop("open the menu", 20, browser);
      expect(t.status).toBe("stalled");
      expect(t.reason).toMatch(/^cycle — /);
      expect(t.steps).toHaveLength(6);
    });

    it("does not fire for A,B,A,B,A,C", async () => {
      stubFetchSequence([hover(0), hover(1), hover(0), hover(1), hover(0), hover(2), DONE]);
      const browser = stubBrowser({ act: updated, snapshot: async () => THREE_BUTTONS });
      const t = await runBrowseTaskLoop("open the menu", 20, browser);
      expect(t.status).toBe("done");
      expect(t.steps).toHaveLength(6);
    });

    it("does not fire when the effect text differs between repeats", async () => {
      stubFetchSequence([hover(0), hover(1), hover(0), hover(1), hover(0), hover(1), DONE]);
      let n = 0;
      const act = async () => ({ changed: false, pageChanged: true, appeared: [`item ${n++}`] });
      const browser = stubBrowser({ act, snapshot: async () => THREE_BUTTONS });
      const t = await runBrowseTaskLoop("open the menu", 20, browser);
      expect(t.status).toBe("done");
    });

    it("does not fire when the page url differs between repeats", async () => {
      stubFetchSequence([hover(0), hover(1), hover(0), hover(1), hover(0), hover(1), DONE]);
      let n = 0;
      const browser = stubBrowser({ act: updated, snapshot: async () => ({ ...THREE_BUTTONS, url: `https://example.com/p${n++}` }) });
      const t = await runBrowseTaskLoop("open the menu", 20, browser);
      expect(t.status).toBe("done");
    });
  });

  describe("scroll oscillation", () => {
    const scroll = (operation: "SCROLL_UP" | "SCROLL_DOWN") => ({ operation, outcome: "act", confidence: 0.9, model: "jev" });
    const D = scroll("SCROLL_DOWN");
    const U = scroll("SCROLL_UP");
    const PAGE: SnapshotResult = {
      url: "https://example.com/configure",
      title: "Configurator",
      elements: [{ index: 0, tag: "button", label: "Option", ops: ["CLICK"] }],
      snapshotId: "snap-1",
    };

    it("stalls after the sixth alternating scroll without a seventh step request", async () => {
      const fetchMock = stubFetchSequence([D, D, U, U, D, U, DONE]);
      const browser = stubBrowser({ snapshot: async () => PAGE });
      const t = await runBrowseTaskLoop("configure it", 20, browser);
      expect(t.status).toBe("stalled");
      expect(t.steps).toHaveLength(6);
      expect(fetchMock).toHaveBeenCalledTimes(6);
      expect(t.reason).toBe("scroll oscillation — scrolled back and forth 6 times without acting");
    });

    it.each([
      ["five down then one up", [D, D, D, D, D, U]],
      ["one up then five down", [U, D, D, D, D, D]],
    ])("does not fire on a single reversal: %s", async (_name, seq) => {
      stubFetchSequence([...seq, DONE]);
      const browser = stubBrowser({ snapshot: async () => PAGE });
      const t = await runBrowseTaskLoop("read the page", 20, browser);
      expect(t.status).toBe("done");
      expect(t.steps).toHaveLength(6);
    });

    it("stalls on D,D,D,U,U,D (two reversals)", async () => {
      const fetchMock = stubFetchSequence([D, D, D, U, U, D, DONE]);
      const browser = stubBrowser({ snapshot: async () => PAGE });
      const t = await runBrowseTaskLoop("configure it", 20, browser);
      expect(t.status).toBe("stalled");
      expect(fetchMock).toHaveBeenCalledTimes(6);
    });

    it("does not fire for eight scrolls in one direction", async () => {
      stubFetchSequence([D, D, D, D, D, D, D, D, DONE]);
      const browser = stubBrowser({ snapshot: async () => PAGE });
      const t = await runBrowseTaskLoop("read the page", 20, browser);
      expect(t.status).toBe("done");
      expect(t.steps).toHaveLength(8);
    });

    it("resets the window on a non-scroll step", async () => {
      stubFetchSequence([D, D, U, { ...HOVER_STEP, operation: "CLICK", index: 0 }, U, D, U, D, DONE]);
      const browser = stubBrowser({ snapshot: async () => PAGE });
      const t = await runBrowseTaskLoop("configure it", 20, browser);
      expect(t.status).toBe("done");
      expect(t.steps).toHaveLength(8);
    });

    it("does not fire when the url differs inside the window", async () => {
      stubFetchSequence([D, D, U, U, D, U, DONE]);
      let n = 0;
      const browser = stubBrowser({ snapshot: async () => ({ ...PAGE, url: `https://example.com/p${n++}` }) });
      const t = await runBrowseTaskLoop("configure it", 20, browser);
      expect(t.status).toBe("done");
    });
  });

  it("counts a changed:false act result (PRESS_ESCAPE/HOVER/PRESS_ENTER) as unproductive for stall detection", async () => {
    // Escape with nothing open to close: the act "succeeds" (no `{error}`)
    // but reports changed:false — must be treated like a rejected act for
    // the no-progress counter, or a persistently no-op Escape would run out
    // the whole step budget the same way a persistently stale CLICK target
    // used to before PR #40.
    const fetchMock = stubFetchSequence([PRESS_ESCAPE_STEP]);

    const act = vi.fn(async () => ({ changed: false }));
    const browser = stubBrowser({ act });
    const transcript = await runBrowseTaskLoop("close the modal", 12, browser);

    expect(transcript.status).toBe("stalled");
    expect(transcript.steps).toHaveLength(3);
    expect(act).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(transcript.steps.every((step) => step.ok === false)).toBe(true);
  });

  it("folds openedTab into the step label/history when an act or perform result carries one", async () => {
    stubFetchSequence([CLICK_STEP, DONE]);

    const perform = vi.fn(async () => ({
      openedTab: { tabId: 7, url: "https://example.com/new", title: "New Tab" },
    }));
    const browser = stubBrowser({ perform });
    const transcript = await runBrowseTaskLoop("open a link", 12, browser);

    expect(transcript.steps).toEqual([
      { operation: "CLICK", label: "Accept all → opened tab: New Tab", ok: true, index: 0 },
    ]);
  });

  it("folds dialogs into the step label/history when a result carries them", async () => {
    stubFetchSequence([PRESS_ESCAPE_STEP, DONE]);

    const act = vi.fn(async () => ({
      dialogs: [{ tabId: 1, type: "alert", message: "Saved!" }],
    }));
    const browser = stubBrowser({ act });
    const transcript = await runBrowseTaskLoop("submit", 12, browser);

    expect(transcript.steps).toEqual([
      { operation: "PRESS_ESCAPE", label: "press Escape (dialog auto-handled: alert: Saved!)", ok: true },
    ]);
  });

  it("truncates an over-long opened-tab title/dialog message so the resulting history label stays within the backend's 200-char cap", async () => {
    const receivedBodies: Array<{ history?: Array<{ label: string }> }> = [];
    const longTitle = "T".repeat(300);
    const longMessage = "M".repeat(300);
    stubFetchSequence([CLICK_STEP, DONE], (init) => {
      receivedBodies.push(JSON.parse(init.body as string));
    });

    const perform = vi.fn(async () => ({
      openedTab: { tabId: 7, url: "https://example.com/new", title: longTitle },
      dialogs: [{ type: "alert", message: longMessage }],
    }));
    const browser = stubBrowser({ perform });
    const transcript = await runBrowseTaskLoop("open a link", 12, browser);

    expect(transcript.status).toBe("done");
    expect(transcript.steps[0].label.length).toBeLessThanOrEqual(200);

    // The SECOND /api/browse/step request body carries the history entry
    // for step one — this is the request that would 400 against the
    // backend's `label: z.string().max(200)` schema if truncation didn't
    // happen.
    const secondRequestHistory = receivedBodies[1]?.history ?? [];
    expect(secondRequestHistory).toHaveLength(1);
    expect(secondRequestHistory[0]!.label.length).toBeLessThanOrEqual(200);
  });

  it("surfaces a snapshot that resolved with { error } (unrelated to \"no tab\") instead of reporting it as malformed", async () => {
    stubFetchSequence([DONE]);

    // Deliberately NOT the "no browser tab is open" message — that one is
    // now intercepted by the pre-loop probe (requirement 1, covered by its
    // own describe block below) and ends the task immediately instead of
    // reaching the loop's per-step SNAPSHOT handling this test exercises.
    const snapshot = vi.fn(async () => ({
      error: "Stale or unknown snapshotId — the page may have changed.",
    }));
    const browser = stubBrowser({ snapshot });

    const transcript = await runBrowseTaskLoop("accept cookies", 12, browser);

    expect(transcript.status).toBe("stalled");
    expect(transcript.steps).toEqual([
      { operation: "SNAPSHOT", label: "Stale or unknown snapshotId — the page may have changed.", ok: false },
      { operation: "SNAPSHOT", label: "Stale or unknown snapshotId — the page may have changed.", ok: false },
      { operation: "SNAPSHOT", label: "Stale or unknown snapshotId — the page may have changed.", ok: false },
    ]);
  });

  // browse-speed-contract.md, "Frontend" item 4.
  it("counts a perform CLICK/TYPE_TEXT/SELECT result with changed:false as unproductive, with an ok:false step and a 'no effect' reason", async () => {
    stubFetchSequence([CLICK_STEP]);

    const perform = vi.fn(async () => ({ changed: false }));
    const browser = stubBrowser({ perform });

    const transcript = await runBrowseTaskLoop("click the popover", 12, browser);

    expect(transcript.status).toBe("stalled");
    expect(transcript.steps).toHaveLength(3);
    expect(perform).toHaveBeenCalledTimes(3);
    expect(transcript.steps.every((step) => step.ok === false)).toBe(true);
    expect(transcript.steps[0]!.label).toMatch(/no effect/);
  });

  it("does not treat a perform result with no `changed` field as no-effect (backward compatible)", async () => {
    stubFetchSequence([CLICK_STEP, DONE]);

    const perform = vi.fn(async () => ({}));
    const browser = stubBrowser({ perform });

    const transcript = await runBrowseTaskLoop("accept cookies", 12, browser);

    expect(transcript.status).toBe("done");
    expect(transcript.steps).toEqual([
      { operation: "CLICK", label: "Accept all", ok: true, index: 0 },
    ]);
  });

  // browse-speed-contract.md, "Frontend" item 2: `changed: false` +
  // `pageChanged: true` (the "Add to Cart" shape — the button itself
  // doesn't change, but a separate #cart-status element does) is NOT
  // unproductive.
  it("treats a perform result with changed:false but pageChanged:true as productive, with the new text folded into the label", async () => {
    stubFetchSequence([CLICK_STEP, DONE]);

    const perform = vi.fn(async () => ({
      changed: false,
      pageChanged: true,
      appeared: ["Added to cart (1 item)", "Go to cart"],
    }));
    const browser = stubBrowser({ perform });

    const transcript = await runBrowseTaskLoop("add the item to the cart", 12, browser);

    expect(transcript.status).toBe("done");
    expect(transcript.steps).toEqual([
      {
        operation: "CLICK",
        label:
          'Accept all (page updated: "Added to cart (1 item)") → effect: appeared: "Added to cart (1 item)"; appeared: "Go to cart"',
        ok: true,
        index: 0,
      },
    ]);
  });

  it("treats an act result with changed:false but pageChanged:true as productive, with a plain '(page updated)' suffix when appeared is empty", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ outcome: "act", operation: "PRESS_ESCAPE", confidence: 0.9, model: "jev" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const act = vi.fn(async () => ({ changed: false, pageChanged: true, appeared: [] }));
    const browser = stubBrowser({ act });
    const transcript = await runBrowseTaskLoop("close the modal", 12, browser);

    expect(transcript.steps[0]!.ok).toBe(true);
    expect(transcript.steps[0]!.label).toContain("(page updated)");
  });

  it("still treats changed:false, pageChanged:false as unproductive — pageChanged must be explicitly true, not just missing", async () => {
    stubFetchSequence([CLICK_STEP]);

    const perform = vi.fn(async () => ({ changed: false, pageChanged: false, appeared: [] }));
    const browser = stubBrowser({ perform });

    const transcript = await runBrowseTaskLoop("click the popover", 12, browser);

    expect(transcript.status).toBe("stalled");
    expect(transcript.steps.every((step) => step.ok === false)).toBe(true);
    expect(transcript.steps[0]!.label).toMatch(/no effect/);
  });

  // browse-speed-contract.md, "Frontend" item 4.
  it("bails before starting a step once less than the per-step reserve remains, before the deadline is fully spent", async () => {
    stubFetchSequence([{ operation: "CLICK", index: 0, confidence: 0.9, model: "jev" }]);

    const browser = stubBrowser({});
    let clock = 0;
    // Deadline is now()+90_000 at start (clock 0 -> deadline 90_000). The
    // first loop-entry check consumes one `now()` call — advance the clock
    // by exactly enough that under 15s (STEP_DEADLINE_RESERVE_MS) remains,
    // without having crossed the deadline itself.
    const now = () => {
      const value = clock;
      clock += 80_000;
      return value;
    };

    const transcript = await runBrowseTaskLoop("wander forever", 12, browser, now);

    expect(transcript.status).toBe("budget");
    expect(transcript.reason).toBe("deadline exceeded");
    // Stopped before taking even one step: 90_000 - 80_000 = 10_000 remaining
    // on the very first check, under the 35s reserve (STEP_DEADLINE_RESERVE_MS).
    expect(transcript.steps).toHaveLength(0);
  });

  // Finding: STEP_DEADLINE_RESERVE_MS was raised from 15s to 35s — this
  // exercises a case that used to PROCEED (15s < remaining < 35s) and must
  // now bail instead, since a single step's own worst case (~61.5s) far
  // exceeds a 15s reserve.
  it("bails at the new 35s reserve even when the old 15s reserve would have let the step start", async () => {
    stubFetchSequence([{ outcome: "act", operation: "CLICK", index: 0, confidence: 0.9, model: "jev" }]);

    const browser = stubBrowser({});
    let clock = 0;
    // Deadline is now()+90_000 at start. Advance by exactly enough that
    // 20_000ms remain — under the new 35s reserve, but comfortably over the
    // old 15s one.
    const now = () => {
      const value = clock;
      clock += 70_000;
      return value;
    };

    const transcript = await runBrowseTaskLoop("accept cookies", 12, browser, now);

    expect(transcript.status).toBe("budget");
    expect(transcript.reason).toBe("deadline exceeded");
    expect(transcript.steps).toHaveLength(0);
  });

  // browse-speed-contract.md, "Frontend" item 4.
  it("caps the WAIT sleep by whatever remains of the deadline", async () => {
    let stepCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        stepCalls++;
        return {
          ok: true,
          json: async () =>
            stepCalls === 1
              ? { outcome: "act", operation: "WAIT", confidence: 0.9, model: "jev" }
              : { outcome: "done", confidence: 1, model: "jev" },
        };
      })
    );

    const browser = stubBrowser({});
    const sleep = vi.fn(async (_ms: number) => {});
    // now() is called 3 times before the sleep: (1) the initial deadline
    // calc (deadline = 0 + 90_000 = 90_000), (2) the per-step reserve check
    // (50_000 -> 40_000 remaining, comfortably over the 35s reserve, so the
    // loop proceeds), (3) the sleep's own remaining-time calc (89_900 ->
    // only 100ms left) — well under WAIT_SLEEP_MS (400ms).
    const nowValues = [0, 50_000, 89_900];
    let nowCalls = 0;
    const now = () => nowValues[Math.min(nowCalls++, nowValues.length - 1)]!;

    await runBrowseTaskLoop("wait for the page to load", 12, browser, now, sleep);

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]![0]).toBe(100);
  });

  // browse-speed-contract.md, "Backend" item 5 / "Frontend" item 4.
  it("forwards the snapshot's scroll position to /api/browse/step untouched", async () => {
    const receivedBodies: Array<{ scroll?: unknown }> = [];
    stubFetchSequence([DONE], (init) => {
      receivedBodies.push(JSON.parse(init.body as string));
    });

    const snapshot = vi.fn(async () => ({
      url: "https://example.com",
      title: "Example",
      elements: [],
      snapshotId: "snap-1",
      scroll: { y: 240, height: 1200, atBottom: false },
    }));
    const browser = stubBrowser({ snapshot });

    await runBrowseTaskLoop("scroll and read", 12, browser);

    expect(receivedBodies[0]!.scroll).toEqual({ y: 240, height: 1200, atBottom: false });
  });

  it.each([
    ["defaults", { allowPasswordEntry: false, confirmIrreversible: true }, { allowPasswordEntry: false, confirmIrreversible: true }],
    ["toggled values", { allowPasswordEntry: true, confirmIrreversible: false }, { allowPasswordEntry: true, confirmIrreversible: false }],
  ])("step body carries `permissions`: %s", async (_name, toggled, expected) => {
    permissions = toggled;
    const receivedBodies: Array<Record<string, unknown>> = [];
    stubFetchSequence([DONE], (init) => {
      receivedBodies.push(JSON.parse(init.body as string));
    });

    await runBrowseTaskLoop("accept cookies", 12, stubBrowser({}));

    expect(receivedBodies[0]!.permissions).toEqual(expected);
  });

  it("a permissions getter is read before each step, so a mid-run switch applies to the next step", async () => {
    let current: BrowsePermissions = { allowPasswordEntry: true, confirmIrreversible: false };
    const receivedBodies: Array<Record<string, unknown>> = [];
    stubFetchSequence([CLICK_STEP, DONE], (init) => {
      receivedBodies.push(JSON.parse(init.body as string));
      // The user flips both switches while the first step is in flight.
      current = { allowPasswordEntry: false, confirmIrreversible: true };
    });

    const browser = stubBrowser({});
    await runBrowseTaskLoopImpl("accept cookies", 12, { ...envFor(browser), permissions: () => current });

    const steps = receivedBodies.filter((b) => "elements" in b);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.permissions).toEqual({ allowPasswordEntry: true, confirmIrreversible: false });
    expect(steps[1]!.permissions).toEqual({ allowPasswordEntry: false, confirmIrreversible: true });
  });

  it("clamps oversized goal/title/url/history/pageText/modal fields in the step body", async () => {
    const receivedBodies: Array<{ goal: string; url: string; title: string }> = [];
    stubFetchSequence([DONE], (init) => {
      receivedBodies.push(JSON.parse(init.body as string));
    });
    const snapshot = vi.fn(async () => ({
      url: `https://example.com/${"u".repeat(5_000)}`,
      title: "t".repeat(900),
      elements: [],
      snapshotId: "snap-1",
    }));
    await runBrowseTaskLoop("g".repeat(3_000), 12, stubBrowser({ snapshot }));
    const body = receivedBodies[0]!;
    expect(body.goal.length).toBe(2_000);
    expect(body.url.length).toBe(4_000);
    expect(body.title.length).toBe(500);
  });

  it.each(["", "   \n"])("an empty goal (%j) never calls the backend", async (goal) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const transcript = await runBrowseTaskLoop(goal, 12, stubBrowser({}));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(transcript.status).toBe("blocked");
    expect(transcript.reason).toMatch(/goal is empty/);
  });

  it("caps the modal at 200 characters without splitting a surrogate pair", async () => {
    const receivedBodies: Array<{ modal?: string }> = [];
    stubFetchSequence([DONE], (init) => {
      receivedBodies.push(JSON.parse(init.body as string));
    });
    const snapshot = vi.fn(async () => ({
      url: "https://example.com", title: "t", elements: [], snapshotId: "snap-1",
      modal: `${"m".repeat(199)}😀tail`,
    }));
    await runBrowseTaskLoop("g", 12, stubBrowser({ snapshot }));
    expect(receivedBodies[0]!.modal).toBe("m".repeat(199));
  });

  it("omits `scroll` from the /api/browse/step body when the snapshot doesn't carry one", async () => {
    const receivedBodies: Array<Record<string, unknown>> = [];
    stubFetchSequence([DONE], (init) => {
      receivedBodies.push(JSON.parse(init.body as string));
    });

    const browser = stubBrowser({});
    await runBrowseTaskLoop("accept cookies", 12, browser);

    expect(receivedBodies[0]).not.toHaveProperty("scroll");
  });

  it.each([
    ["trimmed and capped at 200 chars", `  ${"x".repeat(300)}  `, "x".repeat(200)],
    ["omitted when undefined", undefined, undefined],
    ["omitted when empty", "", undefined],
    ["omitted when whitespace", "   ", undefined],
  ])("step body modal: %s", async (_name, modal, expected) => {
    const receivedBodies: Array<Record<string, unknown>> = [];
    stubFetchSequence([DONE], (init) => {
      receivedBodies.push(JSON.parse(init.body as string));
    });
    const snapshot = vi.fn(async () => ({
      url: "https://example.com",
      title: "Example",
      elements: [],
      snapshotId: "snap-1",
      ...(modal !== undefined ? { modal } : {}),
    }));
    await runBrowseTaskLoop("pick dates", 12, stubBrowser({ snapshot }));
    // Omitted means the key is absent, not merely undefined.
    expect("modal" in receivedBodies[0]!).toBe(expected !== undefined);
    expect(receivedBodies[0]!.modal).toBe(expected);
  });

  // The ultrafast step policy reads visible page text: from the snapshot on a
  // current desktop build, from one `read` on an older one, and a failing
  // read must never fail the step — it just goes without text.
  it.each([
    ["the snapshot's own text", { text: "Create your account" }, async () => ({ text: "unused" }), "Create your account", 0],
    ["a read fallback", {}, async () => ({ text: "Welcome back" }), "Welcome back", 1],
    ["nothing when the fallback read throws", {}, async () => { throw new Error("boom"); }, undefined, 1],
  ])("sends %s as pageText", async (_name, snapshotExtra, readImpl, expected, readCalls) => {
    const receivedBodies: Array<Record<string, unknown>> = [];
    stubFetchSequence([DONE], (init) => {
      receivedBodies.push(JSON.parse(init.body as string));
    });
    const read = vi.fn(readImpl);
    const snapshot = vi.fn(async () => ({
      url: "https://example.com",
      title: "Example",
      elements: [],
      snapshotId: "snap-1",
      ...snapshotExtra,
    }));
    await runBrowseTaskLoop("register", 12, stubBrowser({ snapshot, read }));

    expect(receivedBodies[0]!.pageText).toBe(expected);
    expect(read).toHaveBeenCalledTimes(readCalls);
  });

  // Requirement 1: browse_task opens a tab itself (via `url`, or a URL
  // sniffed out of the goal) instead of wasting Jev steps discovering there
  // is no tab open — bench finding A (3 wasted "no browser tab" steps on
  // every one of 3 live runs).
  describe("opening a tab before the loop starts (requirement 1)", () => {
    it("opens `url` before the loop starts, without any pre-loop snapshot probe", async () => {
      stubFetchSequence([{ outcome: "done", confidence: 1, model: "jev" }]);
      const open = vi.fn(async () => ({}));
      const snapshot = vi.fn(async () => ({
        url: "https://shop.example.com",
        title: "Shop",
        elements: [],
        snapshotId: "snap-1",
      }));
      const browser = stubBrowser({ open, snapshot });

      const transcript = await runBrowseTaskLoop(
        "search for headphones",
        12,
        browser,
        undefined,
        undefined,
        "https://shop.example.com"
      );

      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith({ url: "https://shop.example.com" });
      expect(transcript.status).toBe("done");
    });

    it("returns status:blocked immediately when open({url}) itself fails, without entering the loop", async () => {
      const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
      vi.stubGlobal("fetch", fetchMock);
      const open = vi.fn(async () => ({ error: "net::ERR_NAME_NOT_RESOLVED" }));
      const browser = stubBrowser({ open });

      const transcript = await runBrowseTaskLoop(
        "search for headphones",
        12,
        browser,
        undefined,
        undefined,
        "https://bad.example.invalid"
      );

      expect(transcript.status).toBe("blocked");
      expect(transcript.reason).toContain("net::ERR_NAME_NOT_RESOLVED");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns status:blocked with botCheck:true and never calls Jev when open({url}) lands on a bot-check wall", async () => {
      const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
      vi.stubGlobal("fetch", fetchMock);
      const open = vi.fn(async () => ({ botCheck: true }));
      const browser = stubBrowser({ open });

      const transcript = await runBrowseTaskLoop(
        "search for headphones",
        12,
        browser,
        undefined,
        undefined,
        "https://protected.example.com"
      );

      expect(transcript.status).toBe("blocked");
      expect(transcript.botCheck).toBe(true);
      expect(transcript.reason).toBe("bot check / CAPTCHA wall — hand over to the user");
      expect(transcript.steps).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns status:blocked with botCheck:true when the no-url probe path opens a goal URL that lands on a bot-check wall", async () => {
      const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
      vi.stubGlobal("fetch", fetchMock);
      const open = vi.fn(async () => ({ botCheck: true }));
      let snapshotCalls = 0;
      const snapshot = vi.fn(async () => {
        snapshotCalls++;
        return { error: "No browser tab is open — call browse_open first." };
      });
      const browser = stubBrowser({ open, snapshot });

      const transcript = await runBrowseTaskLoop(
        "open https://protected.example.com and search for headphones",
        12,
        browser
      );

      expect(open).toHaveBeenCalledTimes(1);
      expect(transcript.status).toBe("blocked");
      expect(transcript.botCheck).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      // Only the one pre-loop probe snapshot — the loop itself never starts.
      expect(snapshotCalls).toBe(1);
    });

    it("without `url`, probes for an already-open tab and proceeds normally when one is open (no extra open() call)", async () => {
      stubFetchSequence([{ outcome: "done", confidence: 1, model: "jev" }]);
      const open = vi.fn(async () => ({}));
      const browser = stubBrowser({ open });

      const transcript = await runBrowseTaskLoop("accept cookies", 12, browser);

      expect(open).not.toHaveBeenCalled();
      expect(transcript.status).toBe("done");
    });

    it("without `url` and no tab open, opens a URL found inside the goal text instead of wasting steps", async () => {
      stubFetchSequence([{ outcome: "done", confidence: 1, model: "jev" }]);
      const open = vi.fn(async () => ({}));
      let snapshotCalls = 0;
      const snapshot = vi.fn(async () => {
        snapshotCalls++;
        if (snapshotCalls === 1) {
          return { error: "No browser tab is open — call browse_open first." };
        }
        return {
          url: "https://shop.example.com",
          title: "Shop",
          elements: [],
          snapshotId: "snap-1",
        };
      });
      const browser = stubBrowser({ open, snapshot });

      const transcript = await runBrowseTaskLoop(
        "open https://shop.example.com and search for headphones",
        12,
        browser
      );

      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith({ url: "https://shop.example.com" });
      expect(transcript.status).toBe("done");
    });

    it("without `url`, no open tab, and no URL in the goal, returns status:blocked immediately without ANY /api/browse/step call", async () => {
      const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
      vi.stubGlobal("fetch", fetchMock);
      const snapshot = vi.fn(async () => ({
        error: "No browser tab is open — call browse_open first.",
      }));
      const browser = stubBrowser({ snapshot });

      const transcript = await runBrowseTaskLoop("search this site for headphones", 12, browser);

      expect(transcript).toEqual({
        status: "blocked",
        steps: [],
        url: "",
        title: "",
        reason: "No browser tab is open — pass url or call browse_open first",
      });
      expect(fetchMock).not.toHaveBeenCalled();
      // Exactly the one cheap probe call, not the three wasted Jev steps
      // bench finding A measured on main.
      expect(snapshot).toHaveBeenCalledTimes(1);
    });

    it("forwards the `url` option through to the loop", async () => {
      let receivedBody: unknown;
      stubFetchSequence([DONE], (init) => {
        receivedBody = JSON.parse(init.body as string);
      });
      const open = vi.fn(async () => ({}));

      const parsed = await runBrowseTaskPublic(
        "search for headphones",
        publicOpts(stubBrowser({ open }), { url: "https://shop.example.com" })
      );

      expect(open).toHaveBeenCalledWith({ url: "https://shop.example.com" });
      expect(parsed.status).toBe("done");
      expect(receivedBody).toBeDefined();
    });

    // Finding #5: a URL named in the goal used to be silently ignored
    // whenever ANY tab happened to be open, even on a totally unrelated
    // site — only the "no tab open at all" case checked the goal for a URL.
    it("navigates to a goal URL on a DIFFERENT origin even though a tab is already open elsewhere", async () => {
      stubFetchSequence([{ outcome: "done", confidence: 1, model: "jev" }]);
      const open = vi.fn(async () => ({}));
      const snapshot = vi.fn(async () => ({
        url: "https://unrelated.example.com/dashboard",
        title: "Unrelated",
        elements: [],
        snapshotId: "snap-1",
      }));
      const browser = stubBrowser({ open, snapshot });

      const transcript = await runBrowseTaskLoop(
        "open https://shop.example.com and search for headphones",
        12,
        browser
      );

      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith({ url: "https://shop.example.com" });
      expect(transcript.status).toBe("done");
    });

    it("does NOT navigate when the goal URL is on the SAME origin as the already-open tab (just a different path)", async () => {
      stubFetchSequence([{ outcome: "done", confidence: 1, model: "jev" }]);
      const open = vi.fn(async () => ({}));
      const snapshot = vi.fn(async () => ({
        url: "https://shop.example.com/cart",
        title: "Cart",
        elements: [],
        snapshotId: "snap-1",
      }));
      const browser = stubBrowser({ open, snapshot });

      const transcript = await runBrowseTaskLoop(
        "go to https://shop.example.com/checkout and finish the order",
        12,
        browser
      );

      expect(open).not.toHaveBeenCalled();
      expect(transcript.status).toBe("done");
    });

    it("does not navigate (and does not re-snapshot) when the goal names no URL and a tab is already open — reuses the probe as the loop's first snapshot (finding #7)", async () => {
      stubFetchSequence([{ outcome: "done", confidence: 1, model: "jev" }]);
      const open = vi.fn(async () => ({}));
      let snapshotCalls = 0;
      const snapshot = vi.fn(async () => {
        snapshotCalls++;
        return {
          url: "https://shop.example.com/cart",
          title: "Cart",
          // Non-empty: a blank snapshot would (correctly) be re-polled.
          elements: [{ index: 0, tag: "button", label: "Accept all", ops: ["CLICK"] }],
          snapshotId: "snap-1",
        };
      });
      const browser = stubBrowser({ open, snapshot });

      const transcript = await runBrowseTaskLoop("accept the cookie banner", 12, browser);

      expect(open).not.toHaveBeenCalled();
      expect(transcript.status).toBe("done");
      // Exactly one snapshot call: the pre-loop probe, reused directly as
      // the loop's first iteration snapshot rather than re-taken.
      expect(snapshotCalls).toBe(1);
    });
  });

  // Requirement 2: never re-type into the same search-like field twice in a
  // row — press Enter instead. Bench finding B: Jev re-typed the identical
  // query into the search box three times in a row and never submitted it.
  describe("TYPE_TEXT-dedup rule for search-like fields (requirement 2)", () => {
    function searchBoxSnapshot(): SnapshotResult {
      return {
        url: "https://shop.example.com",
        title: "Shop",
        elements: [{ index: 0, tag: "input", role: "searchbox", label: "Search products", ops: ["TYPE_TEXT"] }],
        snapshotId: "snap-1",
      };
    }

    it("overrides a repeat TYPE_TEXT into the same search-like element to PRESS_ENTER, tagged via:\"rule\"", async () => {
      let stepCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          stepCalls++;
          return {
            ok: true,
            json: async () => {
              if (stepCalls <= 2) {
                // Jev keeps deciding to type the same text into the same
                // field again — exactly the bench-B pattern.
                return {
                  outcome: "act",
                  operation: "TYPE_TEXT",
                  index: 0,
                  text: "headphones",
                  confidence: 0.9,
                  model: "jev",
                };
              }
              return { outcome: "done", confidence: 1, model: "jev" };
            },
          };
        })
      );

      const act = vi.fn(async () => ({}));
      const perform = vi.fn(async () => ({}));
      const browser = stubBrowser({ act, perform, snapshot: async () => searchBoxSnapshot() });
      const transcript = await runBrowseTaskLoop("search this site for headphones", 12, browser);

      expect(perform).toHaveBeenCalledTimes(1); // only the FIRST TYPE_TEXT actually lands
      expect(act).toHaveBeenCalledTimes(1); // the SECOND decision is overridden to PRESS_ENTER
      expect(act).toHaveBeenCalledWith({ action: "press", key: "Enter" });
      expect(transcript.steps[0]).toMatchObject({ operation: "TYPE_TEXT", ok: true });
      expect(transcript.steps[0].label).toContain('TYPE_TEXT "headphones" into "Search products"');
      expect(transcript.steps[1]).toMatchObject({ operation: "PRESS_ENTER", ok: true, via: "rule" });
    });

    it("does NOT override a repeat TYPE_TEXT into a non-search-like element", async () => {
      let stepCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          stepCalls++;
          return {
            ok: true,
            json: async () =>
              stepCalls <= 2
                ? { outcome: "act", operation: "TYPE_TEXT", index: 0, text: "John", confidence: 0.9, model: "jev" }
                : { outcome: "done", confidence: 1, model: "jev" },
          };
        })
      );

      const nameFieldSnapshot: SnapshotResult = {
        url: "https://shop.example.com",
        title: "Checkout",
        elements: [{ index: 0, tag: "input", label: "Full name", ops: ["TYPE_TEXT"] }],
        snapshotId: "snap-1",
      };
      const perform = vi.fn(async () => ({}));
      const browser = stubBrowser({ perform, snapshot: async () => nameFieldSnapshot });
      const transcript = await runBrowseTaskLoop("fill out the checkout form", 12, browser);

      expect(perform).toHaveBeenCalledTimes(2);
      expect(transcript.steps.every((s) => s.operation === "TYPE_TEXT")).toBe(true);
    });

    it("does NOT override to PRESS_ENTER when any element on the page isPassword, even into the same search-like field twice — mirrors the backend's hard credentials rule", async () => {
      let stepCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          stepCalls++;
          return {
            ok: true,
            json: async () =>
              stepCalls <= 2
                ? {
                    outcome: "act",
                    operation: "TYPE_TEXT",
                    index: 0,
                    text: "headphones",
                    confidence: 0.9,
                    model: "jev",
                  }
                : { outcome: "done", confidence: 1, model: "jev" },
          };
        })
      );

      const searchBoxWithPasswordSnapshot: SnapshotResult = {
        url: "https://shop.example.com/login",
        title: "Login",
        elements: [
          { index: 0, tag: "input", role: "searchbox", label: "Search products", ops: ["TYPE_TEXT"] },
          { index: 1, tag: "input", label: "Password", isPassword: true, ops: ["TYPE_TEXT"] },
        ],
        snapshotId: "snap-1",
      };
      const act = vi.fn(async () => ({}));
      const perform = vi.fn(async () => ({}));
      const browser = stubBrowser({
        act,
        perform,
        snapshot: async () => searchBoxWithPasswordSnapshot,
      });
      const transcript = await runBrowseTaskLoop("search this site for headphones", 12, browser);

      // No PRESS_ENTER override — both decisions land as plain TYPE_TEXT.
      expect(act).not.toHaveBeenCalled();
      expect(perform).toHaveBeenCalledTimes(2);
      expect(transcript.steps.every((s) => s.operation === "TYPE_TEXT")).toBe(true);
    });
  });

  // Requirement 3/4: the backend's BROWSE_CASCADE_MODEL cascade is surfaced to
  // the transcript as `via: "cascade"`, and to a terminal reason as
  // "(via cascade)".
  describe("cascade surfaced in the transcript (requirement 3/4)", () => {
    it("tags a cascade-decided act step with via:\"cascade\"", async () => {
      stubFetchSequence([
        {
          outcome: "act",
          operation: "CLICK",
          index: 0,
          confidence: 0.7,
          model: "openrouter:deepseek/deepseek-v4.1-flash",
          cascade: true,
        },
        DONE,
      ]);

      const perform = vi.fn(async () => ({}));
      const browser = stubBrowser({ perform });
      const transcript = await runBrowseTaskLoop("accept cookies", 12, browser);

      expect(transcript.steps[0]).toMatchObject({ operation: "CLICK", ok: true, via: "cascade" });
    });

    it("does not tag an ordinary Jev-decided step with any `via`", async () => {
      stubFetchSequence([CLICK_STEP, DONE]);

      const perform = vi.fn(async () => ({}));
      const browser = stubBrowser({ perform });
      const transcript = await runBrowseTaskLoop("accept cookies", 12, browser);

      expect(transcript.steps[0]).not.toHaveProperty("via");
    });

    it("marks a cascade-decided terminal done/blocked reason with \"(via cascade)\"", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          json: async () => ({
            outcome: "done",
            confidence: 0.7,
            model: "openrouter:deepseek/deepseek-v4.1-flash",
            reason: "cart already has the item",
            cascade: true,
          }),
        }))
      );

      const browser = stubBrowser({});
      const transcript = await runBrowseTaskLoop("add headphones to cart", 12, browser);

      expect(transcript.status).toBe("done");
      expect(transcript.reason).toBe("cart already has the item (via cascade)");
    });
  });

  // Finding #6: a URL embedded in prose commonly picks up trailing
  // punctuation that isn't part of the URL — must be stripped, but a
  // legitimately balanced trailing paren (e.g. a Wikipedia-style link) must
  // survive.
  describe("extractUrlFromGoal (finding #6)", () => {
    it("strips a trailing comma", () => {
      expect(extractUrlFromGoal("go to https://example.com/a, then search")).toBe(
        "https://example.com/a"
      );
    });

    it("strips a trailing period", () => {
      expect(extractUrlFromGoal("see https://example.com/a.")).toBe("https://example.com/a");
    });

    it("strips a trailing semicolon", () => {
      expect(extractUrlFromGoal("open https://example.com/a; do the thing")).toBe(
        "https://example.com/a"
      );
    });

    it("strips a trailing exclamation mark", () => {
      expect(extractUrlFromGoal("go to https://example.com/a!")).toBe("https://example.com/a");
    });

    it("strips an unbalanced trailing closing bracket", () => {
      expect(extractUrlFromGoal("see [https://example.com/a]")).toBe("https://example.com/a");
    });

    it("strips an unbalanced trailing closing brace", () => {
      expect(extractUrlFromGoal("see {https://example.com/a}")).toBe("https://example.com/a");
    });

    it("strips an unbalanced trailing closing paren", () => {
      expect(extractUrlFromGoal("see (https://example.com/a)")).toBe("https://example.com/a");
    });

    it("strips a trailing closing quote", () => {
      expect(extractUrlFromGoal("go to 'https://example.com/a' now")).toBe(
        "https://example.com/a"
      );
    });

    it("keeps a BALANCED trailing paren that is genuinely part of the URL", () => {
      expect(extractUrlFromGoal("see https://en.wikipedia.org/wiki/Foo_(bar) for details")).toBe(
        "https://en.wikipedia.org/wiki/Foo_(bar)"
      );
    });

    it("strips multiple trailing punctuation characters in one pass", () => {
      expect(extractUrlFromGoal("open https://example.com/a)., please")).toBe(
        "https://example.com/a"
      );
    });

    it.each([
      ["open (https://example.com/start):", "https://example.com/start"],
      ["is it https://example.com/a?", "https://example.com/a"],
      ["see (https://example.com/a).", "https://example.com/a"],
      ["go to https://example.com/a:", "https://example.com/a"],
      ["(see https://en.wikipedia.org/wiki/Foo_(bar)).", "https://en.wikipedia.org/wiki/Foo_(bar)"],
      ["open https://example.com/search?q=a", "https://example.com/search?q=a"],
    ])("strips mixed trailing punctuation: %s", (goal, expected) => {
      expect(extractUrlFromGoal(goal)).toBe(expected);
    });

    it("returns undefined when no URL is present", () => {
      expect(extractUrlFromGoal("just search this page")).toBeUndefined();
    });
  });

  describe("action cache", () => {
    // Builds a {labelHash, tag, role?} target the way the real write path
    // does (actionCache.ts's `hashCachedLabel`) — a cache entry never
    // persists a target's raw label, only its hash.
    const cachedTarget = (label: string, tag: string, role?: string) => ({
      labelHash: hashCachedLabel(label),
      tag,
      ...(role ? { role } : {}),
    });

    const cacheKeyFor = (goal: string, history: Array<{ operation: string; label: string }> = []) =>
      buildStepCacheKey(goal, EXAMPLE_SNAPSHOT.url, EXAMPLE_SNAPSHOT.title, EXAMPLE_SNAPSHOT.elements, history);

    it("replays a cached CLICK without ever calling /api/browse/step, tagged via:\"cache\"", async () => {
      const key = cacheKeyFor("accept cookies");
      writeStepCacheEntry(store, key, "accept cookies", EXAMPLE_SNAPSHOT.elements, {
        operation: "CLICK",
        target: cachedTarget("Accept all", "button"),
      });

      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const perform = vi.fn(async () => ({}));
      const browser = stubBrowser({ perform });

      const transcript = await runBrowseTaskLoop("accept cookies", 1, browser);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(perform).toHaveBeenCalledTimes(1);
      expect(perform).toHaveBeenCalledWith({ snapshotId: "snap-1", operation: "CLICK", text: undefined, index: 0 });
      expect(transcript.cacheHits).toBe(1);
      expect(transcript.steps).toEqual([
        { operation: "CLICK", label: "Accept all", ok: true, index: 0, via: "cache" },
      ]);
    });

    it("replays a cached TYPE_TEXT by reading the text back out of the goal via textRange, and persists neither the typed text nor the target label", async () => {
      const goal = 'search for "wireless headphones" under $50';
      const searchSnapshot: SnapshotResult = {
        url: "https://example.com",
        title: "Example",
        elements: [{ index: 0, tag: "input", label: "Search", ops: ["TYPE_TEXT"] }],
        snapshotId: "snap-1",
      };
      const key = buildStepCacheKey(goal, searchSnapshot.url, searchSnapshot.title, searchSnapshot.elements, []);
      const textStart = goal.indexOf("wireless headphones");
      writeStepCacheEntry(store, key, goal, searchSnapshot.elements, {
        operation: "TYPE_TEXT",
        target: cachedTarget("Search", "input"),
        textRange: [textStart, textStart + "wireless headphones".length],
      });

      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      let receivedText: unknown;
      const perform = vi.fn(async (args: { text?: string }) => {
        receivedText = args.text;
        return {};
      });
      const browser = stubBrowser({ perform, snapshot: async () => searchSnapshot });

      await runBrowseTaskLoop(goal, 1, browser);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(receivedText).toBe("wireless headphones");
      // Nothing about the actual localStorage-persisted entry carries the
      // raw text — only the offset used to derive it above — and nothing
      // carries the raw target label either, only its hash.
      const raw = store.getItem(ACTION_CACHE_STORAGE_KEY) ?? "";
      expect(raw).not.toContain("wireless headphones");
      expect(raw).not.toContain("Search");
    });

    it("self-heals when the cached element no longer resolves uniquely: deletes the entry and falls back to Jev without an extra snapshot", async () => {
      const key = cacheKeyFor("accept cookies");
      writeStepCacheEntry(store, key, "accept cookies", EXAMPLE_SNAPSHOT.elements, {
        operation: "CLICK",
        target: cachedTarget("Gone now", "button"),
      });

      stubFetchSequence([DONE]);
      const perform = vi.fn(async () => ({}));
      const snapshot = vi.fn(async () => EXAMPLE_SNAPSHOT);
      const browser = stubBrowser({ perform, snapshot });

      const transcript = await runBrowseTaskLoop("accept cookies", 12, browser);

      expect(perform).not.toHaveBeenCalled(); // no unique match — never even attempted
      expect(transcript.status).toBe("done");
      expect(transcript.cacheHits).toBe(0);
      expect(transcript.steps).toEqual([]); // the miss itself is not recorded as a step
      expect(lookupStepCache(store, key, "accept cookies", EXAMPLE_SNAPSHOT.elements)).toBeUndefined();
      // No attempt was dispatched, so nothing may have changed — the SAME
      // snapshot this iteration already took is reused, not re-fetched.
      expect(snapshot).toHaveBeenCalledTimes(1);
    });

    it("self-heals when the cached action lands with no effect: deletes the entry, RECORDS a failed step, and takes a FRESH snapshot before falling back to Jev", async () => {
      const key = cacheKeyFor("accept cookies");
      writeStepCacheEntry(store, key, "accept cookies", EXAMPLE_SNAPSHOT.elements, {
        operation: "CLICK",
        target: cachedTarget("Accept all", "button"),
      });

      stubFetchSequence([DONE]);
      const perform = vi.fn(async () => ({ changed: false }));
      const snapshot = vi.fn(async () => EXAMPLE_SNAPSHOT);
      const browser = stubBrowser({ perform, snapshot });

      const transcript = await runBrowseTaskLoop("accept cookies", 12, browser);

      expect(perform).toHaveBeenCalledTimes(1); // the replay attempt itself did run
      expect(transcript.status).toBe("done");
      expect(transcript.steps).toEqual([
        { operation: "CLICK", label: "cache replay failed: (no effect)", ok: false, index: 0, via: "cache" },
      ]);
      expect(lookupStepCache(store, key, "accept cookies", EXAMPLE_SNAPSHOT.elements)).toBeUndefined();
      // The dispatched-but-failed replay may have altered the page — a
      // fresh snapshot is taken (this iteration's own + one more for the
      // next loop iteration) rather than trusting the stale one.
      expect(snapshot).toHaveBeenCalledTimes(2);
    });

    it("self-heals when the cached action is rejected by the bridge, and records why", async () => {
      const key = cacheKeyFor("accept cookies");
      writeStepCacheEntry(store, key, "accept cookies", EXAMPLE_SNAPSHOT.elements, {
        operation: "CLICK",
        target: cachedTarget("Accept all", "button"),
      });

      stubFetchSequence([DONE]);
      const perform = vi.fn(async () => ({ error: "target is gone or occluded" }));
      const browser = stubBrowser({ perform });

      const transcript = await runBrowseTaskLoop("accept cookies", 12, browser);

      expect(transcript.status).toBe("done");
      expect(transcript.steps).toEqual([
        {
          operation: "CLICK",
          label: "cache replay failed: target is gone or occluded",
          ok: false,
          index: 0,
          via: "cache",
        },
      ]);
      expect(lookupStepCache(store, key, "accept cookies", EXAMPLE_SNAPSHOT.elements)).toBeUndefined();
    });

    it("a failed cache replay is visible to the NEXT /api/browse/step call's history", async () => {
      const key = cacheKeyFor("accept cookies");
      writeStepCacheEntry(store, key, "accept cookies", EXAMPLE_SNAPSHOT.elements, {
        operation: "CLICK",
        target: cachedTarget("Accept all", "button"),
      });

      // The cache replay attempt itself never calls fetch — the first (and,
      // since Jev then returns "done", only) /api/browse/step call is the
      // one whose body must already carry the failed replay in `history`.
      let requestBody: unknown;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: RequestInit) => {
          requestBody = JSON.parse(init.body as string);
          return { ok: true, json: async () => DONE };
        })
      );
      const perform = vi.fn(async () => ({ error: "target is gone or occluded" }));
      const browser = stubBrowser({ perform });

      await runBrowseTaskLoop("accept cookies", 12, browser);

      expect((requestBody as { history: unknown[] }).history).toEqual([
        { operation: "CLICK", label: "cache replay failed: target is gone or occluded", ok: false, index: 0 },
      ]);
    });

    it("writes a landed Jev-decided CLICK to the cache, replayable on a later identical run", async () => {
      stubFetchSequence([CLICK_STEP, DONE]);
      const perform = vi.fn(async () => ({}));
      const browser = stubBrowser({ perform });

      await runBrowseTaskLoop("accept cookies", 12, browser);

      const key = cacheKeyFor("accept cookies");
      expect(lookupStepCache(store, key, "accept cookies", EXAMPLE_SNAPSHOT.elements)).toEqual({
        operation: "CLICK",
        target: cachedTarget("Accept all", "button"),
      });
    });

    it("never writes a CLICK on an irreversible/sensitive-sounding target label", async () => {
      const checkoutSnapshot: SnapshotResult = {
        url: "https://example.com",
        title: "Cart",
        elements: [{ index: 0, tag: "button", label: "Place order", ops: ["CLICK"] }],
        snapshotId: "snap-1",
      };
      stubFetchSequence([
        { outcome: "act", operation: "CLICK", index: 0, confidence: 0.9, model: "jev" },
        DONE,
      ]);
      const perform = vi.fn(async () => ({}));
      const browser = stubBrowser({ perform, snapshot: async () => checkoutSnapshot });

      await runBrowseTaskLoop("place the order", 12, browser);

      const key = buildStepCacheKey(
        "place the order",
        checkoutSnapshot.url,
        checkoutSnapshot.title,
        checkoutSnapshot.elements,
        []
      );
      expect(lookupStepCache(store, key, "place the order", checkoutSnapshot.elements)).toBeUndefined();
    });

    it("never writes TYPE_TEXT into a password field to the cache", async () => {
      const passwordSnapshot: SnapshotResult = {
        url: "https://example.com",
        title: "Login",
        elements: [{ index: 0, tag: "input", label: "Password", isPassword: true, ops: ["TYPE_TEXT"] }],
        snapshotId: "snap-1",
      };
      stubFetchSequence([
        { outcome: "act", operation: "TYPE_TEXT", index: 0, text: "hunter2", confidence: 0.9, model: "jev" },
        DONE,
      ]);
      const perform = vi.fn(async () => ({}));
      const browser = stubBrowser({ perform, snapshot: async () => passwordSnapshot });

      await runBrowseTaskLoop("log in with password hunter2", 12, browser);

      const key = buildStepCacheKey(
        "log in with password hunter2",
        passwordSnapshot.url,
        passwordSnapshot.title,
        passwordSnapshot.elements,
        []
      );
      expect(lookupStepCache(store, key, "log in with password hunter2", passwordSnapshot.elements)).toBeUndefined();
      const raw = store.getItem(ACTION_CACHE_STORAGE_KEY) ?? "";
      expect(raw).not.toContain("hunter2");
    });

    it("never writes TYPE_TEXT/SELECT into an OTP/verification-code field even when it isn't flagged isPassword", async () => {
      const otpSnapshot: SnapshotResult = {
        url: "https://example.com",
        title: "Verify",
        elements: [{ index: 0, tag: "input", label: "Verification code", ops: ["TYPE_TEXT"] }],
        snapshotId: "snap-1",
      };
      stubFetchSequence([
        { outcome: "act", operation: "TYPE_TEXT", index: 0, text: "123456", confidence: 0.9, model: "jev" },
        DONE,
      ]);
      const perform = vi.fn(async () => ({}));
      const browser = stubBrowser({ perform, snapshot: async () => otpSnapshot });

      await runBrowseTaskLoop("enter code 123456", 12, browser);

      const key = buildStepCacheKey(
        "enter code 123456",
        otpSnapshot.url,
        otpSnapshot.title,
        otpSnapshot.elements,
        []
      );
      expect(lookupStepCache(store, key, "enter code 123456", otpSnapshot.elements)).toBeUndefined();
    });

    it("never writes card-number-shaped TYPE_TEXT text to the cache", async () => {
      const fieldSnapshot: SnapshotResult = {
        url: "https://example.com",
        title: "Checkout",
        elements: [{ index: 0, tag: "input", label: "Promo code", ops: ["TYPE_TEXT"] }],
        snapshotId: "snap-1",
      };
      stubFetchSequence([
        {
          outcome: "act",
          operation: "TYPE_TEXT",
          index: 0,
          text: "4111 1111 1111 1111",
          confidence: 0.9,
          model: "jev",
        },
        DONE,
      ]);
      const perform = vi.fn(async () => ({}));
      const browser = stubBrowser({ perform, snapshot: async () => fieldSnapshot });

      await runBrowseTaskLoop("check out with card 4111 1111 1111 1111", 12, browser);

      const key = buildStepCacheKey(
        "check out with card 4111 1111 1111 1111",
        fieldSnapshot.url,
        fieldSnapshot.title,
        fieldSnapshot.elements,
        []
      );
      expect(
        lookupStepCache(store, key, "check out with card 4111 1111 1111 1111", fieldSnapshot.elements)
      ).toBeUndefined();
    });

    it("never writes a TYPE_TEXT step whose text does not occur verbatim in the goal", async () => {
      const searchSnapshot: SnapshotResult = {
        url: "https://example.com",
        title: "Shop",
        elements: [{ index: 0, tag: "input", label: "Search", ops: ["TYPE_TEXT"] }],
        snapshotId: "snap-1",
      };
      // Jev's chosen text ("wireless earbuds") is a paraphrase, not a
      // substring of the goal itself — nothing to store an offset into.
      stubFetchSequence([
        {
          outcome: "act",
          operation: "TYPE_TEXT",
          index: 0,
          text: "wireless earbuds",
          confidence: 0.9,
          model: "jev",
        },
        DONE,
      ]);
      const perform = vi.fn(async () => ({}));
      const browser = stubBrowser({ perform, snapshot: async () => searchSnapshot });

      await runBrowseTaskLoop("find me some cheap earphones", 12, browser);

      const key = buildStepCacheKey(
        "find me some cheap earphones",
        searchSnapshot.url,
        searchSnapshot.title,
        searchSnapshot.elements,
        []
      );
      expect(lookupStepCache(store, key, "find me some cheap earphones", searchSnapshot.elements)).toBeUndefined();
    });

    it("REPLAY-time re-check: refuses a cached TYPE_TEXT whose fresh resolved element is now a password field, even though the fingerprint still matches", async () => {
      // A field with the SAME label/tag the entry was written against, but
      // now flagged isPassword — simulates the page having changed what
      // that label/tag combination actually is.
      const nowPasswordSnapshot: SnapshotResult = {
        url: "https://example.com",
        title: "Login",
        elements: [{ index: 0, tag: "input", label: "Field", isPassword: true, ops: ["TYPE_TEXT"] }],
        snapshotId: "snap-1",
      };
      const key = buildStepCacheKey(
        "log in",
        nowPasswordSnapshot.url,
        nowPasswordSnapshot.title,
        nowPasswordSnapshot.elements,
        []
      );
      writeStepCacheEntry(store, key, "log in", nowPasswordSnapshot.elements, {
        operation: "TYPE_TEXT",
        target: cachedTarget("Field", "input"),
        textRange: [0, 6],
      });
      stubFetchSequence([DONE]);
      const perform = vi.fn(async () => ({}));
      const browser = stubBrowser({ perform, snapshot: async () => nowPasswordSnapshot });

      const transcript = await runBrowseTaskLoop("log in", 12, browser);

      expect(perform).not.toHaveBeenCalled(); // treated as a miss, never attempted
      expect(transcript.status).toBe("done");
      expect(lookupStepCache(store, key, "log in", nowPasswordSnapshot.elements)).toBeUndefined();
    });

    it("REPLAY-time re-check: refuses a cached CLICK whose target label is irreversible-sounding, even though the fingerprint still matches", async () => {
      // A hand-written entry (bypassing the write-time guard entirely) —
      // stands in for an entry written before this guard existed, or one
      // written under a since-relaxed rule. The fresh snapshot's element
      // matches it uniquely by label+tag, so this exercises the REPLAY-time
      // re-check specifically, not the write-time one.
      const dangerousSnapshot: SnapshotResult = {
        url: "https://example.com",
        title: "Cart",
        elements: [{ index: 0, tag: "button", label: "Delete", ops: ["CLICK"] }],
        snapshotId: "snap-1",
      };
      const key = buildStepCacheKey(
        "clear the cart",
        dangerousSnapshot.url,
        dangerousSnapshot.title,
        dangerousSnapshot.elements,
        []
      );
      writeStepCacheEntry(store, key, "clear the cart", dangerousSnapshot.elements, {
        operation: "CLICK",
        target: cachedTarget("Delete", "button"),
      });
      const perform = vi.fn(async () => ({}));
      stubFetchSequence([DONE]);
      const browser = stubBrowser({ perform, snapshot: async () => dangerousSnapshot });

      const transcript = await runBrowseTaskLoop("clear the cart", 12, browser);

      expect(perform).not.toHaveBeenCalled(); // treated as a miss, never attempted
      expect(transcript.cacheHits).toBe(0);
      expect(lookupStepCache(store, key, "clear the cart", dangerousSnapshot.elements)).toBeUndefined();
    });

    it("never replays or writes WAIT", async () => {
      stubFetchSequence([{ outcome: "act", operation: "WAIT", confidence: 0.9, model: "jev" }, DONE]);
      const sleep = vi.fn(async () => {});
      const browser = stubBrowser({});

      const transcript = await runBrowseTaskLoop("wait for the page to load", 12, browser, undefined, sleep);

      const key = cacheKeyFor("wait for the page to load");
      expect(lookupStepCache(store, key, "wait for the page to load", EXAMPLE_SNAPSHOT.elements)).toBeUndefined();
      expect(transcript.cacheHits).toBe(0);
    });

    it("does not consult or write the cache when the kill switch is set", async () => {
      const key = cacheKeyFor("accept cookies");
      writeStepCacheEntry(store, key, "accept cookies", EXAMPLE_SNAPSHOT.elements, {
        operation: "CLICK",
        target: cachedTarget("Accept all", "button"),
      });
      store.setItem(ACTION_CACHE_KILL_SWITCH_KEY, "off");

      stubFetchSequence([CLICK_STEP, DONE]);
      const perform = vi.fn(async () => ({}));
      const browser = stubBrowser({ perform });

      const transcript = await runBrowseTaskLoop("accept cookies", 12, browser);

      // The pre-existing entry was never consulted (the loop went through
      // the ordinary Jev decision instead), and no cacheHits were recorded.
      expect(transcript.status).toBe("done");
      expect(transcript.cacheHits).toBe(0);
      expect(transcript.steps[0]).not.toHaveProperty("via");
    });

    it("no fixed point: the same page+goal never re-hits a stale entry, since history grows on every step", async () => {
      // Regression for the code-review finding: the OLD key only hashed
      // goal+host+path-pattern+last-3-history-entries, so a target that
      // kept landing "no effect" against the SAME page could re-derive the
      // exact same key forever. The new key folds in the FULL history, so
      // even a run that keeps failing against the same page/goal mints a
      // new key every single step.
      const key = cacheKeyFor("accept cookies");
      writeStepCacheEntry(store, key, "accept cookies", EXAMPLE_SNAPSHOT.elements, {
        operation: "CLICK",
        target: cachedTarget("Accept all", "button"),
      });

      stubFetchSequence([DONE]);
      // Every replay attempt fails the same way — if the key ever repeated,
      // this would loop forever re-hitting (and re-failing) the cache.
      const perform = vi.fn(async () => ({ error: "still gone" }));
      const browser = stubBrowser({ perform });

      const transcript = await runBrowseTaskLoop("accept cookies", 12, browser);

      // Exactly ONE cache attempt: after the first failed replay, the key
      // for the next iteration's (now longer) history no longer matches
      // anything in the store, so it falls straight through to Jev.
      expect(perform).toHaveBeenCalledTimes(1);
      expect(transcript.status).toBe("done");
    });

    // Code review item 5: a cache replay is just as real a "something
    // landed" step as an ordinary Jev/cascade/rule decision — the same-url
    // WAIT streak must reset after one, not just after a non-cached
    // decision (browseTask.ts's existing `sameUrlWaitStreak = 0` reset for
    // a landed non-WAIT decision).
    it("resets the same-url WAIT streak after a successful cache replay, same as any other non-WAIT decision", async () => {
      const FIXED_URL_SNAPSHOT: SnapshotResult = {
        url: "https://example.com",
        title: "Example",
        elements: [{ index: 0, tag: "button", label: "Accept all", ops: ["CLICK"] }],
        snapshotId: "snap-fixed",
      };
      const goal = "wait around a cached click";

      // The cache entry is written for the EXACT state after two landed
      // WAITs — the history a real run would have reached by step 3.
      const historyAfterTwoWaits = [
        { operation: "WAIT", label: "waiting for the page to settle" },
        { operation: "WAIT", label: "waiting for the page to settle" },
      ];
      const key = buildStepCacheKey(
        goal,
        FIXED_URL_SNAPSHOT.url,
        FIXED_URL_SNAPSHOT.title,
        FIXED_URL_SNAPSHOT.elements,
        historyAfterTwoWaits
      );
      writeStepCacheEntry(store, key, goal, FIXED_URL_SNAPSHOT.elements, {
        operation: "CLICK",
        target: cachedTarget("Accept all", "button"),
      });

      // Only 5 real /api/browse/step calls: step 3 (the CLICK) is served
      // entirely from the cache and never calls fetch at all.
      stubFetchSequence([
        { outcome: "act", operation: "WAIT", confidence: 0.5, model: "jev" },
        { outcome: "act", operation: "WAIT", confidence: 0.5, model: "jev" },
        { outcome: "act", operation: "WAIT", confidence: 0.5, model: "jev" },
        { outcome: "act", operation: "WAIT", confidence: 0.5, model: "jev" },
        { outcome: "act", operation: "WAIT", confidence: 0.5, model: "jev" },
      ]);

      const snapshot = vi.fn(async () => FIXED_URL_SNAPSHOT);
      const sleep = vi.fn(async () => {});
      const perform = vi.fn(async () => ({}));
      const browser = stubBrowser({ snapshot, perform });

      const transcript = await runBrowseTaskLoop(goal, 6, browser, undefined, sleep);

      // If the reset did NOT happen, the streak from the first two WAITs
      // would carry straight through the cache replay and the very next
      // WAIT (step 4) would already be the 3rd of an unbroken streak,
      // stalling the loop long before 6 steps. Reaching all 6 steps with 4
      // total sleeps (2 before the cache hit, 2 fresh ones after it) is
      // only possible if the streak was reset.
      expect(transcript.status).toBe("budget");
      expect(sleep).toHaveBeenCalledTimes(4);
      expect(transcript.cacheHits).toBe(1);
      expect(transcript.steps.map((step) => `${step.operation}:${step.ok}`)).toEqual([
        "WAIT:true",
        "WAIT:true",
        "CLICK:true",
        "WAIT:true",
        "WAIT:true",
        "WAIT:false",
      ]);
    });
  });
});

describe("browse_task step screenshot (the `stepScreenshots` option)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  const bodies: Array<Record<string, unknown>> = [];
  const run = async (
    screenshot: BrowserBridge["screenshot"] | undefined,
    sequence: unknown[] = [DONE],
    overrides: Partial<BrowserBridge> = {}
  ) => {
    bodies.length = 0;
    stubFetchSequence(sequence as Record<string, unknown>[], (init) => bodies.push(JSON.parse(String(init.body))));
    const browser = stubBrowser({ ...(screenshot ? { screenshot } : {}), ...overrides });
    const transcript = await runBrowseTaskLoop("accept cookies", 3, browser);
    return { body: bodies[0], transcript };
  };

  it("flag off: no screenshot call, body has no screenshot", async () => {
    stepScreenshots = false;
    const screenshot = vi.fn(async () => ({ imageData: "data:image/jpeg;base64,AAA", snapshotId: "snap-1" }));
    const { body } = await run(screenshot);
    expect(screenshot).not.toHaveBeenCalled();
    expect(body).not.toHaveProperty("screenshot");
  });

  it("flag on: captures with the loop's snapshotId and sends imageData untouched (trimmed)", async () => {
    stepScreenshots = true;
    const screenshot = vi.fn(async () => ({ imageData: "  QUJD\n", snapshotId: "snap-1" }));
    const { body } = await run(screenshot);
    expect(screenshot).toHaveBeenCalledWith({ annotate: true, snapshotId: "snap-1" });
    expect(body.screenshot).toBe("QUJD");
  });

  it.each<[string, BrowserBridge["screenshot"] | undefined]>([
    ["error result", vi.fn(async () => ({ error: "boom" }))],
    ["throw", vi.fn(async () => { throw new Error("x"); })],
    ["missing method", undefined],
  ])("%s: step still sent without screenshot", async (_name, screenshot) => {
    stepScreenshots = true;
    const { body } = await run(screenshot);
    expect(body).toBeDefined();
    expect(body).not.toHaveProperty("screenshot");
  });

  it("timeout: step is sent without screenshot", async () => {
    stepScreenshots = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = run(vi.fn(() => new Promise(() => {})) as BrowserBridge["screenshot"]);
    await vi.advanceTimersByTimeAsync(4_100);
    expect((await pending).body).not.toHaveProperty("screenshot");
  });

  it("marked 0: image is not sent and the transcript says unmarked", async () => {
    stepScreenshots = true;
    const screenshot = vi.fn(async () => ({ imageData: "AAA", snapshotId: "snap-1", marked: 0 }));
    const { body, transcript } = await run(screenshot, [CLICK_STEP, DONE], { perform: vi.fn(async () => ({})) });
    expect(body).not.toHaveProperty("screenshot");
    expect(transcript.steps[0]).toMatchObject({ screenshot: "unmarked", marked: 0 });
  });

  it("over-cap screenshot: not sent, transcript says too_large", async () => {
    stepScreenshots = true;
    const screenshot = vi.fn(async () => ({ imageData: "A".repeat(4_000_001), snapshotId: "snap-1", marked: 3 }));
    const { body, transcript } = await run(screenshot, [CLICK_STEP, DONE], { perform: vi.fn(async () => ({})) });
    expect(body).not.toHaveProperty("screenshot");
    expect(transcript.steps[0]).toMatchObject({ screenshot: "too_large", marked: 3 });
  });

  it("records the final step's capture info on a done terminal entry", async () => {
    stepScreenshots = true;
    const screenshot = vi.fn(async () => ({ imageData: "AAA", snapshotId: "snap-1", marked: 4 }));
    const { transcript } = await run(screenshot, [DONE]);
    expect(transcript.status).toBe("done");
    expect(transcript.steps).toHaveLength(1);
    expect(transcript.steps[0]).toMatchObject({ operation: "DONE", screenshot: "sent", marked: 4 });
  });

  it("records the capture outcome and marked on the step entry", async () => {
    stepScreenshots = true;
    const screenshot = vi.fn(async () => ({ imageData: "AAA", snapshotId: "snap-1", marked: 7 }));
    const { transcript } = await run(screenshot, [CLICK_STEP, DONE], { perform: vi.fn(async () => ({})) });
    expect(transcript.steps[0]).toMatchObject({ operation: "CLICK", screenshot: "sent", marked: 7 });
    expect(typeof transcript.steps[0].screenshotMs).toBe("number");
    expect(JSON.parse(JSON.stringify(transcript.steps))).toEqual(transcript.steps);
  });

  it("bridge ignoring snapshotId: image discarded, capture stops, snapshot re-taken", async () => {
    stepScreenshots = true;
    const screenshot = vi.fn(async () => ({ imageData: "AAA", snapshotId: "other" }));
    const snapshot = vi
      .fn()
      .mockResolvedValueOnce(EXAMPLE_SNAPSHOT)
      .mockResolvedValue({ ...EXAMPLE_SNAPSHOT, snapshotId: "snap-2" });
    const perform = vi.fn(async () => ({}));
    const { body, transcript } = await run(screenshot, [CLICK_STEP, CLICK_STEP, DONE], { snapshot, perform });
    expect(screenshot).toHaveBeenCalledTimes(1);
    expect(bodies.every((b) => !("screenshot" in b))).toBe(true);
    expect(body).not.toHaveProperty("screenshot");
    expect((perform.mock.calls as unknown as unknown[][])[0][0]).toMatchObject({ snapshotId: "snap-2" });
    expect(transcript.steps[0]).toMatchObject({ screenshot: "unsupported" });
  });

  it("result without snapshotId counts as ignored", async () => {
    stepScreenshots = true;
    const { body } = await run(vi.fn(async () => ({ imageData: "AAA" })));
    expect(body).not.toHaveProperty("screenshot");
  });

  it("action-cache hit: no capture", async () => {
    stepScreenshots = true;
    const key = buildStepCacheKey(
      "accept cookies", EXAMPLE_SNAPSHOT.url, EXAMPLE_SNAPSHOT.title, EXAMPLE_SNAPSHOT.elements, []
    );
    writeStepCacheEntry(store, key, "accept cookies", EXAMPLE_SNAPSHOT.elements, {
      operation: "CLICK",
      target: { labelHash: hashCachedLabel("Accept all"), tag: "button" },
    });
    vi.stubGlobal("fetch", vi.fn());
    const screenshot = vi.fn(async () => ({ imageData: "AAA", snapshotId: "snap-1" }));
    const transcript = await runBrowseTaskLoop("accept cookies", 1, stubBrowser({ screenshot, perform: vi.fn(async () => ({})) }));
    expect(transcript.cacheHits).toBe(1);
    expect(screenshot).not.toHaveBeenCalled();
  });
});

// Routes /api/browse/plan to `plan` ("fail" = 503) and every /api/browse/step
// call to the next payload of `steps` (last one repeats). Records bodies.
function stubPlanAndSteps(
  plan: string[] | "fail",
  steps: Array<Record<string, unknown>>,
  onStep?: () => void
) {
  const stepBodies: Array<Record<string, unknown>> = [];
  let calls = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (String(url).includes("/api/browse/plan")) {
      return plan === "fail"
        ? { ok: false, status: 503, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ subgoals: plan }) };
    }
    stepBodies.push(body);
    onStep?.();
    const payload = steps[Math.min(calls, steps.length - 1)];
    calls++;
    return { ok: true, status: 200, json: async () => payload };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, stepBodies };
}

const BLOCKED_LOGIN = { outcome: "blocked", confidence: 0.2, model: "jev", reason: "refusing to type into a password field — the user must log in themselves" };
const BLOCKED_OTHER = { outcome: "blocked", confidence: 0.2, model: "jev", reason: "no matching product" };

describe("browse_task sub-goal planning", () => {
  it("falls back to the single loop with the untouched goal when planning fails", async () => {
    const { stepBodies } = stubPlanAndSteps("fail", [DONE]);
    const t = await runBrowseTask("add a tent and a mat to the cart", 12, stubBrowser({}));
    expect(t.status).toBe("done");
    expect(t.subgoals).toBeUndefined();
    expect(stepBodies).toHaveLength(1);
    expect(stepBodies[0].goal).toBe("add a tent and a mat to the cart");
    expect(t.steps.every((st) => st.subgoal === undefined)).toBe(true);
  });

  it("treats a 1-entry plan as the single loop with the original goal", async () => {
    const { stepBodies } = stubPlanAndSteps(["something else entirely"], [DONE]);
    const t = await runBrowseTask("accept cookies", 12, stubBrowser({}));
    expect(stepBodies.map((b) => b.goal)).toEqual(["accept cookies"]);
    expect(t.subgoals).toBeUndefined();
  });

  it("runs a long (>600 chars) 1-entry fallback plan with the full original goal", async () => {
    const long = "buy ".concat("x".repeat(1500));
    const { stepBodies } = stubPlanAndSteps([long], [DONE]);
    await runBrowseTask(long, 12, stubBrowser({}));
    expect(stepBodies[0].goal).toBe(long);
  });

  it("runs one loop per sub-goal with step k of n and already-done context", async () => {
    const { stepBodies } = stubPlanAndSteps(["add a tent", "add a mat", "add a bag"], [CLICK_STEP, DONE, CLICK_STEP, DONE, CLICK_STEP, DONE]);
    const open = vi.fn(async () => ({}));
    const t = await runBrowseTask("buy camping gear", 12, stubBrowser({ open }), undefined, undefined, "https://shop.example");
    expect(t.status).toBe("done");
    expect(open).toHaveBeenCalledTimes(1); // url opened once, not per sub-goal
    const goals = stepBodies.map((b) => b.goal as string);
    // CLICK then DONE for each sub-goal -> 2 step calls per sub-goal
    expect(goals[0]).toContain("add a tent");
    expect(goals[0]).toBe("add a tent");
    const second = goals.find((g) => g.startsWith("add a mat"));
    expect(second).toBe("add a mat\n\nAlready done earlier (do not redo): add a tent.");
    expect(second).not.toContain("overall task");
    const third = goals.find((g) => g.startsWith("add a bag"));
    expect(third).toContain("Already done earlier (do not redo): add a tent; add a mat.");
    expect(goals.every((g) => g.length <= 2000)).toBe(true);
    expect(t.subgoals?.map((r) => r.status)).toEqual(["done", "done", "done"]);
    expect(new Set(t.steps.map((st) => st.subgoal))).toEqual(new Set([1, 2, 3]));
  });

  it("buildSubgoalGoal truncates the done list, never the sub-goal, within 2000 chars", () => {
    const sub = "s".repeat(1000);
    const done = Array.from({ length: 5 }, (_, i) => `done-${i}-${"d".repeat(200)}`);
    const g = buildSubgoalGoal(sub, done);
    expect(g.length).toBeLessThanOrEqual(2000);
    expect(g.startsWith(sub)).toBe(true);
    expect(g).not.toContain("step 6 of 12");
    expect(buildSubgoalGoal("only this", [])).toBe("only this");
  });

  it("continues past a sub-goal that ran out of budget and reports the worst status", async () => {
    stubPlanAndSteps(["one", "two"], [CLICK_STEP, DONE]);
    // maxSteps 1: sub-goal 1 clicks once then hits the cap -> budget; sub-goal 2 is done.
    const t = await runBrowseTask("do both", 1, stubBrowser({}));
    expect(t.subgoals?.map((r) => r.status)).toEqual(["budget", "done"]);
    expect(t.status).toBe("budget");
    expect(t.reason).toContain("1/2 sub-goals done");
  });

  it("continues after an ordinary blocked and ranks blocked above done-less statuses", async () => {
    stubPlanAndSteps(["one", "two"], [BLOCKED_OTHER, DONE]);
    const t = await runBrowseTask("do both", 12, stubBrowser({}));
    expect(t.subgoals?.map((r) => r.status)).toEqual(["blocked", "done"]);
    expect(t.status).toBe("blocked");
  });

  it("stops the whole task on a login wall", async () => {
    const { stepBodies } = stubPlanAndSteps(["one", "two", "three"], [DONE, BLOCKED_LOGIN]);
    const t = await runBrowseTask("do all", 12, stubBrowser({}));
    expect(t.status).toBe("blocked");
    expect(t.subgoals?.map((r) => r.status)).toEqual(["done", "blocked", "blocked"]);
    expect(t.subgoals?.[2].reason).toContain("not attempted");
    expect(stepBodies).toHaveLength(2);
  });

  it("bounds the whole call by the overall deadline", async () => {
    let clock = 0;
    const now = () => clock;
    stubPlanAndSteps(["one", "two", "three"], [DONE], () => {
      clock += 200_000;
    });
    const t = await runBrowseTask("do all", 12, stubBrowser({}), now, async () => {}, undefined, 90_000, 300_000);
    expect(t.subgoals?.map((r) => r.status)).toEqual(["done", "done", "budget"]);
    expect(t.subgoals?.[2].reason).toBe("overall deadline reached");
    expect(t.status).toBe("budget");
  });

  it.each([
    "dialog in the way",
    "catalog in stock only",
    "designing a layout",
    "logging output",
    "There is a Sign in link in the header",
    "Use login to get notified about price drops",
  ])(
    "continues after a blocked reason that is not a structured wall signal: %j",
    async (reason) => {
      const { stepBodies } = stubPlanAndSteps(["one", "two"], [{ ...BLOCKED_OTHER, reason }, DONE]);
      const t = await runBrowseTask("do both", 12, stubBrowser({}));
      expect(t.subgoals?.map((r) => r.status)).toEqual(["blocked", "done"]);
      expect(stepBodies).toHaveLength(2);
    }
  );

  it("fails fast, running no steps, when no tab is open and the goal has no URL", async () => {
    const { stepBodies } = stubPlanAndSteps(["one", "two"], [DONE]);
    const browser = stubBrowser({ snapshot: async () => ({ error: "No browser tab is open" }) });
    const t = await runBrowseTask("do both", 12, browser);
    expect(t.status).toBe("blocked");
    expect(t.subgoals).toBeUndefined();
    expect(stepBodies).toHaveLength(0);
  });

  it("stops the whole task when opening the url fails", async () => {
    const { stepBodies } = stubPlanAndSteps(["one", "two"], [DONE]);
    const browser = stubBrowser({ open: async () => ({ error: "net::ERR_NAME_NOT_RESOLVED" }) });
    const t = await runBrowseTask("do both", 12, browser, undefined, undefined, "https://nope.invalid");
    expect(t.status).toBe("blocked");
    expect(t.reason).toContain("failed to open");
    expect(stepBodies).toHaveLength(0);
  });

  it("opens the URL from the original goal exactly once", async () => {
    const order: string[] = [];
    const open = vi.fn(async () => {
      order.push("open");
      return {};
    });
    const browser = stubBrowser({ open, snapshot: async () => ({ error: "No browser tab is open" }) });
    stubPlanAndSteps(["one", "two"], [DONE]);
    await runBrowseTask("go to https://shop.example/x and do both", 12, browser);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({ url: "https://shop.example/x" });
    expect(order).toEqual(["open"]);
  });

  it("keeps only the last 5 steps per sub-goal and reports stepsTotal", async () => {
    const clicks = Array.from({ length: 7 }, () => CLICK_STEP);
    stubPlanAndSteps(["one", "two"], [...clicks, DONE, DONE]);
    const t = await runBrowseTask("do both", 12, stubBrowser({}));
    expect(t.stepsTotal).toBe(7);
    expect(t.steps).toHaveLength(5);
    expect(t.steps.every((st) => st.subgoal === 1)).toBe(true);
  });

  it("returns blocked/cancelled promptly when the signal aborts between sub-goals", async () => {
    const ac = new AbortController();
    const { stepBodies } = stubPlanAndSteps(["one", "two", "three"], [DONE], () => ac.abort());
    const t = await runBrowseTask("do all", 12, stubBrowser({}), undefined, undefined, undefined, 90_000, 600_000, ac.signal);
    expect(t.status).toBe("blocked");
    expect(t.reason).toBe("cancelled");
    expect(stepBodies).toHaveLength(1);
    expect(t.subgoals?.map((r) => r.status)).toEqual(["blocked", "blocked", "blocked"]);
  });

  it("never performs a decision that arrives after Stop", async () => {
    const ac = new AbortController();
    stubPlanAndSteps("fail", [CLICK_STEP], () => ac.abort());
    const perform = vi.fn(async () => ({}));
    const t = await runBrowseTask("one flow", 12, stubBrowser({ perform }), undefined, undefined, undefined, 90_000, 600_000, ac.signal);
    expect(t.reason).toBe("cancelled");
    expect(perform).not.toHaveBeenCalled();
  });

  it("stops on the backend's CAPTCHA wall wording", async () => {
    const reason =
      "the page is a CAPTCHA / bot check (captcha-url) — the user must solve it themselves; browse_task never interacts with CAPTCHAs";
    const { stepBodies } = stubPlanAndSteps(["one", "two"], [{ ...BLOCKED_OTHER, reason }, DONE]);
    const t = await runBrowseTask("do both", 12, stubBrowser({}));
    expect(t.subgoals?.map((r) => r.status)).toEqual(["blocked", "blocked"]);
    expect(stepBodies).toHaveLength(1);
  });

  it("opens a different site named in a later sub-goal before running it", async () => {
    stubPlanAndSteps(["one", "go to https://other.example/p and two"], [DONE]);
    const open = vi.fn(async () => ({}));
    await runBrowseTask("do both", 12, stubBrowser({ open }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({ url: "https://other.example/p" });
  });

  it("does not reopen a sub-goal URL on the same host as the current tab", async () => {
    stubPlanAndSteps(["one", "go to https://example.com/p and two"], [DONE]);
    const open = vi.fn(async () => ({}));
    await runBrowseTask("do both", 12, stubBrowser({ open }));
    expect(open).not.toHaveBeenCalled();
  });

  it("does not reuse the probe snapshot when the plan finished after it", async () => {
    const snapshot = vi.fn(async () => EXAMPLE_SNAPSHOT);
    stubPlanAndSteps("fail", [DONE]);
    // Slow plan: resolves after the (instant) probe.
    const base = globalThis.fetch;
    vi.stubGlobal("fetch", async (u: string, init?: RequestInit) => {
      if (String(u).includes("/plan")) await new Promise((r) => setTimeout(r, 20));
      return base(u, init);
    });
    await runBrowseTask("one flow", 12, stubBrowser({ snapshot }));
    // probe (1) + loop's own fresh snapshot (2)
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it("cancels the single loop between steps", async () => {
    const ac = new AbortController();
    stubPlanAndSteps("fail", [CLICK_STEP], () => ac.abort());
    const t = await runBrowseTask("one flow", 12, stubBrowser({}), undefined, undefined, undefined, 90_000, 600_000, ac.signal);
    expect(t.status).toBe("blocked");
    expect(t.reason).toBe("cancelled");
  });

  it("runBrowseTask returns a budget transcript at its own internal bound when the loop hangs", async () => {
    vi.useFakeTimers();
    try {
      stubPlanAndSteps("fail", [DONE]);
      const pending = runBrowseTaskPublic("hang forever", publicOpts(stubBrowser({ snapshot: () => new Promise(() => {}) })));
      await vi.advanceTimersByTimeAsync(browseTaskInnerBoundMs(false) + 1);
      expect(await pending).toMatchObject({ status: "budget", reason: "deadline exceeded" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("runBrowseTask derives its race bound from a larger overallDeadlineMs", async () => {
    vi.useFakeTimers();
    try {
      stubPlanAndSteps("fail", [DONE]);
      const overall = browseTaskOverallDeadlineMs(false) + 5 * 60_000;
      let settled = false;
      const pending = runBrowseTaskPublic(
        "hang forever",
        publicOpts(stubBrowser({ snapshot: () => new Promise(() => {}) }), { overallDeadlineMs: overall })
      ).then((t) => {
        settled = true;
        return t;
      });
      await vi.advanceTimersByTimeAsync(browseTaskInnerBoundMs(false) + 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(browseTaskInnerBoundMs(false, overall) - browseTaskInnerBoundMs(false));
      expect(await pending).toMatchObject({ status: "budget", reason: "deadline exceeded" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("runBrowseTask does not cut a single flow off at the overall bound when deadlineMs is longer", async () => {
    vi.useFakeTimers();
    try {
      stubPlanAndSteps("fail", [DONE]);
      let settled = false;
      const pending = runBrowseTaskPublic(
        "hang forever",
        publicOpts(stubBrowser({ snapshot: () => new Promise(() => {}) }), {
          overallDeadlineMs: 60_000,
          deadlineMs: 300_000,
        })
      ).then((t) => {
        settled = true;
        return t;
      });
      await vi.advanceTimersByTimeAsync(browseTaskInnerBoundMs(false, 60_000) + 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(browseTaskInnerBoundMs(false, 300_000) - browseTaskInnerBoundMs(false, 60_000));
      expect(await pending).toMatchObject({ status: "budget", reason: "deadline exceeded" });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([Infinity, NaN, -5, 0])("runBrowseTask ignores a non-positive/non-finite deadline (%s) instead of firing at once", async (bad) => {
    vi.useFakeTimers();
    try {
      stubPlanAndSteps("fail", [DONE]);
      let settled = false;
      const pending = runBrowseTaskPublic(
        "hang forever",
        publicOpts(stubBrowser({ snapshot: () => new Promise(() => {}) }), { overallDeadlineMs: bad, deadlineMs: bad })
      ).then((t) => {
        settled = true;
        return t;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(browseTaskInnerBoundMs(false) + 1);
      expect(await pending).toMatchObject({ status: "budget", reason: "deadline exceeded" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("runBrowseTask bounds a hanging cloud call by the longer cloud bound", async () => {
    vi.useFakeTimers();
    try {
      stubPlanAndSteps("fail", [DONE]);
      let settled = false;
      const pending = runBrowseTaskPublic(
        "hang forever",
        publicOpts(stubBrowser({ snapshot: () => new Promise(() => {}) }), { cloud: true })
      ).then((t) => {
        settled = true;
        return t;
      });
      await vi.advanceTimersByTimeAsync(browseTaskInnerBoundMs(false) + 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(browseTaskInnerBoundMs(true));
      expect(await pending).toMatchObject({ status: "budget", reason: "deadline exceeded" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("browse_task rate limiting and sub-goal reset", () => {
  // Step endpoint answers `statuses` in order (then 200 DONE); plan is a 1-entry fallback unless given.
  function stubRateLimited(statuses: Array<{ status: number; retryAfter?: string }>, plan: string[] = []) {
    let n = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/browse/plan")) {
        const r = statuses[Math.min(n, statuses.length)];
        if (plan.length === 0 && r) {
          n++;
          return { ok: false, status: r.status, headers: new Headers(r.retryAfter ? { "Retry-After": r.retryAfter } : {}), json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => ({ subgoals: plan }) };
      }
      const r = statuses[n++];
      if (r) return { ok: false, status: r.status, headers: new Headers(r.retryAfter ? { "Retry-After": r.retryAfter } : {}), json: async () => ({}) };
      return { ok: true, status: 200, json: async () => DONE };
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("retries a 429 step with exponential waits without adding history or a stall", async () => {
    const fetchMock = stubRateLimited([{ status: 429 }, { status: 429 }, { status: 429 }]);
    const sleeps: number[] = [];
    const t = await runBrowseTaskLoop("go", 12, stubBrowser({}), () => 0, async (ms) => void sleeps.push(ms));
    expect(t.status).toBe("done");
    expect(t.steps.filter((s) => s.operation === "STEP")).toHaveLength(0);
    expect(sleeps).toEqual([1000, 2000, 4000]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("honours Retry-After (up to 60s) when it fits the deadline, and records the failure once retries run out", async () => {
    stubRateLimited(Array.from({ length: 10 }, () => ({ status: 503, retryAfter: "30" })));
    const sleeps: number[] = [];
    const t = await runBrowseTaskLoop("go", 1, stubBrowser({}), () => 0, async (ms) => void sleeps.push(ms));
    expect(sleeps.slice(0, 4)).toEqual([30000, 30000, 30000, 30000]);
    expect(t.steps[0]?.label).toContain("503");
  });

  it("does not retry a 503 without Retry-After", async () => {
    const fetchMock = stubRateLimited([{ status: 503 }]);
    const sleeps: number[] = [];
    await runBrowseTaskLoop("go", 1, stubBrowser({}), () => 0, async (ms) => void sleeps.push(ms));
    expect(sleeps).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up at once when wait + request timeout + reserve does not fit the deadline", async () => {
    const fetchMock = stubRateLimited([{ status: 429 }, { status: 429 }]);
    const sleeps: number[] = [];
    const res = await fetchBrowseBackend(backend, "/api/browse/step", {}, 20_000, undefined, {
      now: () => 0,
      sleep: async (ms) => void sleeps.push(ms),
      deadline: 50_000,
      reserveMs: 35_000,
    });
    expect(res.status).toBe(429);
    expect(sleeps).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caps Retry-After at 60s and retries at most 4 times", async () => {
    const fetchMock = stubRateLimited(Array.from({ length: 10 }, () => ({ status: 429, retryAfter: "500" })));
    const sleeps: number[] = [];
    await fetchBrowseBackend(backend, "/api/browse/step", {}, 1000, undefined, { now: () => 0, sleep: async (ms) => void sleeps.push(ms) });
    expect(sleeps).toEqual([60000, 60000, 60000, 60000]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("returns promptly when the signal aborts during the backoff sleep", async () => {
    stubRateLimited([{ status: 429 }, { status: 429 }]);
    const ac = new AbortController();
    const res = await fetchBrowseBackend(backend, "/api/browse/step", {}, 1000, ac.signal, {
      now: () => 0,
      sleep: () => {
        setTimeout(() => ac.abort(), 0);
        return new Promise(() => {}); // never resolves
      },
    });
    expect(res.status).toBe(429);
  });

  it("does not retry the plan call on 429: falls back to the single loop", async () => {
    let planCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/api/browse/plan")) {
        planCalls++;
        return { ok: false, status: 429, headers: new Headers({ "Retry-After": "1" }), json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => DONE };
    }));
    const sleeps: number[] = [];
    const t = await runBrowseTask("a and b", 12, stubBrowser({}), undefined, async (ms) => void sleeps.push(ms));
    expect(planCalls).toBe(1);
    expect(sleeps).toEqual([]);
    expect(t.subgoals).toBeUndefined();
  });

  it("treats a scrolled inner container as not-at-top, and a container at 0 as top", async () => {
    for (const [containerY, expected] of [[300, 2], [0, 0]] as const) {
      stubPlanAndSteps(["one", "two", "three"], [DONE]);
      const act = vi.fn(async () => ({}));
      await runBrowseTask("x", 12, stubBrowser({
        act,
        snapshot: async () => ({ url: "u", title: "t", elements: [], snapshotId: "s", scroll: { y: 0, container: { index: 3, y: containerY, height: 900, atBottom: false } } }),
      }), undefined, async () => {});
      expect(act).toHaveBeenCalledTimes(expected);
    }
  });

  it("bounds scroll-to-top with a timeout when the bridge hangs", async () => {
    vi.useFakeTimers();
    try {
      let stepped = false;
      stubPlanAndSteps(["one", "two"], [DONE], () => { stepped = true; });
      let hung = 0;
      const browser = stubBrowser({
        snapshot: async () => {
          if (stepped && hung === 0) { hung++; return new Promise(() => {}); }
          return { url: "u", title: "t", elements: [], snapshotId: "s" };
        },
      });
      const pending = runBrowseTask("x", 12, browser, undefined, async () => {});
      await vi.advanceTimersByTimeAsync(9_000);
      const t = await pending;
      expect(hung).toBe(1);
      expect(t.subgoals).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("scrolls to the top before sub-goal 2+ unless already at y 0, never for a single flow", async () => {
    stubPlanAndSteps(["one", "two", "three"], [DONE]);
    const act = vi.fn(async () => ({}));
    const browser = stubBrowser({
      act,
      snapshot: async () => ({ url: "https://x.test", title: "t", elements: [], snapshotId: "s", scroll: { y: 500 } }),
    });
    await runBrowseTask("x", 12, browser, undefined, async () => {});
    expect(act.mock.calls).toEqual([[{ action: "scroll", amount: -1000 }], [{ action: "scroll", amount: -1000 }]]);

    const actTop = vi.fn(async () => ({}));
    stubPlanAndSteps(["one", "two"], [DONE]);
    await runBrowseTask("x", 12, stubBrowser({ act: actTop, snapshot: async () => ({ url: "u", title: "t", elements: [], snapshotId: "s", scroll: { y: 0 } }) }));
    expect(actTop).not.toHaveBeenCalled();

    stubPlanAndSteps(["only one"], [DONE]);
    const act2 = vi.fn(async () => ({}));
    await runBrowseTask("x", 12, stubBrowser({ act: act2, snapshot: async () => ({ url: "u", title: "t", elements: [], snapshotId: "s", scroll: { y: 900 } }) }));
    expect(act2).not.toHaveBeenCalled();
  });
});

describe("browse_task effect notes, history carry-over and recovery", () => {
  const withText = {
    url: "https://shop.test",
    title: "Shop",
    elements: [
      { index: 0, tag: "input", label: "Search", ops: ["TYPE_TEXT"] },
      { index: 1, tag: "button", label: "Add to cart", ops: ["CLICK"] },
    ],
    snapshotId: "s",
    scroll: { y: 0 },
  };

  it("appends the effect of a landed CLICK to its history label for the next request", async () => {
    const after = { ...withText, elements: [withText.elements[0], { index: 1, tag: "button", label: "Add to cart 1", ops: ["CLICK"] }] };
    const bodies: Array<{ history: Array<{ label: string }> }> = [];
    stubFetchSequence([{ ...CLICK_STEP, index: 1 }, DONE], (init) => bodies.push(JSON.parse(String(init.body))));
    const browser = stubBrowser({ snapshot: async () => after });
    const t = await runBrowseTaskLoop("add it", 5, browser, undefined, undefined, undefined, undefined, { initialSnapshot: withText });
    expect(bodies[1].history[0].label).toBe('Add to cart → effect: "Add to cart" became "Add to cart 1"');
    expect(t.steps[0].label).toBe(bodies[1].history[0].label);
  });

  describe("commit effect auto-confirm", () => {
    const CLICK1 = { ...CLICK_STEP, index: 1 };
    const page = (label: string, extra: Array<Record<string, unknown>> = []) => ({
      ...withText,
      elements: [withText.elements[0], { index: 1, tag: "button", label, ops: ["CLICK"] }, ...extra],
    });
    /** Two sub-goals; sub-goal 1 clicks element 1, whose page changes before -> after. */
    async function run(before: ReturnType<typeof page>, after: ReturnType<typeof page>) {
      const { stepBodies } = stubPlanAndSteps(["add the mat", "open the cart"], [CLICK1, DONE, DONE]);
      let clicked = false;
      const browser = stubBrowser({
        snapshot: async () => (clicked ? after : before),
        perform: vi.fn(async () => {
          clicked = true;
          return {};
        }),
      });
      const t = await runBrowseTask("add the mat then open the cart", 5, browser);
      return { t, stepBodies };
    }
    const synthetic = (t: Awaited<ReturnType<typeof run>>["t"]) => t.steps.filter((s) => String(s.label).startsWith("auto-confirmed by effect"));

    it("positive: a relabel adding one bare number ends the sub-goal as done", async () => {
      const { t, stepBodies } = await run(page("Add to cart"), page("Add to cart 1"));
      expect(t.subgoals?.[0]).toMatchObject({ status: "done" });
      expect(t.subgoals?.[0].reason).toContain("commit effect observed");
      expect(synthetic(t)).toHaveLength(1);
      // sub-goal 1: only the CLICK request; sub-goal 2 proceeds (its first step is DONE).
      expect(stepBodies).toHaveLength(2);
      expect(String(stepBodies[1].goal)).toContain("open the cart");
      expect(t.status).toBe("done");
    });

    it("the synthetic step does not count toward stepsTotal", async () => {
      const { t } = await run(page("Add to cart"), page("Add to cart 1"));
      expect(synthetic(t)).toHaveLength(1);
      expect(t.stepsTotal).toBe(t.steps.length - 1);
    });

    it.each([
      ["stepper Adults 2 -> 3", page("Adults 2"), page("Adults 3")],
      ["Load more -> Load more (24)", page("Load more"), page("Load more (24)")],
      ["mid-label number", page("Show results"), page("Show 245 results")],
    ])("negative: %s does not auto-finish", async (_name, before, after) => {
      const { t, stepBodies } = await run(before, after);
      expect(synthetic(t)).toHaveLength(0);
      expect(t.subgoals?.[0].reason ?? "").not.toContain("commit effect");
      // CLICK then the model's own DONE for sub-goal 1, then sub-goal 2.
      expect(stepBodies).toHaveLength(3);
    });

    it("negative: a counter moving 0 -> 1 elsewhere does not auto-finish", async () => {
      const { t, stepBodies } = await run(
        page("Add to cart", [{ index: 2, tag: "a", label: "Cart", ops: ["CLICK"] }]),
        page("Add to cart", [{ index: 2, tag: "a", label: "Cart 1", ops: ["CLICK"] }])
      );
      expect(synthetic(t)).toHaveLength(0);
      expect(stepBodies).toHaveLength(3);
    });

    it("single-goal run: the same effect does not auto-finish", async () => {
      const stepBodies: unknown[] = [];
      stubFetchSequence([CLICK1, DONE], (init) => stepBodies.push(JSON.parse(String(init.body))));
      const browser = stubBrowser({ snapshot: async () => page("Add to cart 1") });
      const t = await runBrowseTaskLoop("add it", 5, browser, undefined, undefined, undefined, undefined, { initialSnapshot: withText });
      expect(stepBodies).toHaveLength(2);
      expect(t.reason ?? "").not.toContain("commit effect");
    });
  });

  it("carryOverHistory keeps the last 2 entries, suffixed, within the cap, once", () => {
    const base = { operation: "CLICK", ok: true };
    const out = carryOverHistory([
      { ...base, label: "first" },
      { ...base, label: "second", index: 4 },
      { ...base, label: "x".repeat(200) },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ operation: "CLICK", label: "second (earlier sub-goal)", ok: true });
    expect(out[1].label).toHaveLength(200);
    expect(out[1].label.endsWith(" (earlier sub-goal)")).toBe(true);
    expect(carryOverHistory(out)[0].label).toBe("second (earlier sub-goal)");
  });

  it("seeds sub-goal 2 history with the previous sub-goal's last entries", async () => {
    const { stepBodies } = stubPlanAndSteps(["one", "two"], [CLICK_STEP, CLICK_STEP, DONE, DONE]);
    await runBrowseTask("g", 12, stubBrowser({ snapshot: async () => withText }), undefined, undefined, "https://shop.test");
    const first = (stepBodies[3].history as Array<{ label: string }>).map((h) => h.label);
    expect(first).toHaveLength(2);
    expect(first.every((l) => l.endsWith(" (earlier sub-goal)"))).toBe(true);
  });

  it("at sub-goal start: Escape on a dialog, then reopens the start URL if still no text field", async () => {
    stubPlanAndSteps(["one", "search for a product"], [DONE]);
    const act = vi.fn(async () => ({}));
    const open = vi.fn(async () => ({}));
    const blocked = { ...withText, elements: [withText.elements[1]], modal: "Your cart" };
    const t = await runBrowseTask("g", 12, stubBrowser({ snapshot: async () => blocked, act, open }), undefined, undefined, "https://shop.test");
    expect(act).toHaveBeenCalledWith({ action: "press", key: "Escape" });
    expect(open).toHaveBeenCalledTimes(2);
    expect(t.steps.filter((s) => s.subgoal === 2).map((s) => s.operation)).toEqual(expect.arrayContaining(["PRESS_ESCAPE", "OPEN"]));
  });

  describe("sub-goal start reset for consecutive searches", () => {
    const inSection = { ...withText, url: "https://shop.test/section/shoes" };
    const reopened = (t: { steps: Array<{ label: string; subgoal?: number }> }) =>
      t.steps.filter((s) => s.label.includes("sub-goal start: new search"));

    it("reopens the site URL when the sub-goal is a quoted search and the page moved", async () => {
      stubPlanAndSteps(['search for "shoes"', 'search for "hats"'], [DONE]);
      const open = vi.fn(async () => ({}));
      const act = vi.fn(async () => ({}));
      const t = await runBrowseTask("g", 12, stubBrowser({ snapshot: async () => inSection, open, act }), undefined, undefined, "https://shop.test");
      expect(open).toHaveBeenCalledTimes(2);
      expect(reopened(t)).toEqual([
        { operation: "OPEN", label: "reopened https://shop.test (sub-goal start: new search)", ok: true, subgoal: 2 },
      ]);
      // A fresh page needs no scroll-to-top.
      expect(act).not.toHaveBeenCalled();
    });

    it.each([
      [["open the hotels tab", 'search for "Paris"']],
      [["one", 'Find a suitable "tent" and add it to the cart']],
      [["one", "Search 'σκηνή camping'"]],
      [["one", "On Skroutz: search 'αδιάβροχο μπουφάν', click the first result"]],
      [["one", 'Search for "hats". Done when: results for "hats" are visible.']],
      [["one", 'Go to the search page and search for "hats". Done when: the search results show hats.']],
      [["one", 'Search for hats. Done when: results for "hats" are visible.']],
      [["one", 'Done when: search for "hats" is done']],
      [["one", "Do a search for 'red shoes'"]],
    ])("resets for %j", async (plan) => {
      stubPlanAndSteps(plan, [DONE]);
      const open = vi.fn(async () => ({}));
      const t = await runBrowseTask("g", 12, stubBrowser({ snapshot: async () => inSection, open }), undefined, undefined, "https://shop.test");
      expect(open).toHaveBeenCalledTimes(2);
      expect(reopened(t)).toHaveLength(1);
    });

    it.each([
      [["search for hotels in Paris", "find the cheapest one and open it"]],
      [['type "John" into the first name field', 'type "Smith" into the last name field']],
      [["search for shoes", "search for hats"]],
      [['search for "shoes"', "search for hats"]],
      [["search for shoes", "find the cheapest one and open it"]],
      [["one", "Don't stop, it's here: find it"]],
      [["one", 'type "John" into First name']],
      [['search for "shoes"', "add the first one to the cart"]],
      [["open the cart", "Find the 'Checkout' button and click it"]],
      [["one", 'Apply the filter Condition = Used. Done when: the search results are filtered by "Condition = Used".']],
      [["one", 'Apply the filter Buying format = Buy It Now only. Done when: the search results are filtered by "Buying format = Buy It Now only".']],
      [["one", 'Set the number of bedrooms to "2". Done when: the search results show properties with 2 bedrooms.']],
      [["one", 'Set the maximum price to "&pound;2,500 pcm". Done when: the search results show properties within the &pound;2,500 pcm limit.']],
      [["one", "Change the Sort dropdown to 'Price + Shipping: lowest first'. Done when: the search results are re-sorted by 'Price + Shipping: lowest first' and the first listing reflects this sorting."]],
      [["one", "Apply the search filter 'Preis' for '50 bis 100 EUR'. Done when: Search results are filtered by price range 50 to 100 EUR."]],
      [["one", 'Add the tent to the cart. Does not count: a search for "tent pegs"']],
      [["one", "Click the 'Nike Air' search suggestion. Done when: the product page is visible."]],
      [["one", "Open the first item in the search-results list ('Preis' filter applied)"]],
      [["one", "Откройте первый товар в результатах поиска 'X'"]],
      [["one", "Tick the 'Nur Direktverbindungen' filter and start the search. Done when: the search results page is loaded with direct connections displayed."]],
      [["one", "Click the search button. Done when: results are visible."]],
    ])("does not reset for %j", async (plan) => {
      stubPlanAndSteps(plan, [DONE]);
      const open = vi.fn(async () => ({}));
      const t = await runBrowseTask("g", 12, stubBrowser({ snapshot: async () => inSection, open }), undefined, undefined, "https://shop.test");
      expect(open).toHaveBeenCalledTimes(1);
      expect(reopened(t)).toHaveLength(0);
    });

    it.each([
      ["Open the first listing in the search results. Done when: the listing page is visible.", false],
      ["Apply the filter X. Done when: the search results show X.", false],
      ["Search for shoes. Done when: results are visible.", true],
      ['type "x" into the search box', true],
      ["start the search", false],
      ['Do a search for "red shoes"', true],
      ["Perform a new search for shoes", true],
    ])("wantsTextEntry(%j) is %s", (subGoal, expected) => {
      expect(wantsTextEntry(subGoal)).toBe(expected);
    });

    it("ignores a URL that appears only in the Done-when clause", async () => {
      stubPlanAndSteps(["one", "Apply the price filter. Done when: the URL https://other.test/s?price=50 is shown"], [DONE]);
      const open = vi.fn(async () => ({}));
      await runBrowseTask("g", 12, stubBrowser({ snapshot: async () => inSection, open }), undefined, undefined, "https://shop.test");
      expect(open).toHaveBeenCalledTimes(1);
    });

    it("counts the reopen in stepsTotal", async () => {
      stubPlanAndSteps(['search for "shoes"', 'search for "hats"'], [DONE]);
      const t = await runBrowseTask("g", 12, stubBrowser({ snapshot: async () => inSection }), undefined, undefined, "https://shop.test");
      expect(t.stepsTotal).toBeGreaterThanOrEqual(1);
      expect(t.steps.some((s) => s.operation === "OPEN" && s.subgoal === 2)).toBe(true);
    });

    it("does not reset when the page already is the site URL (hash ignored)", async () => {
      stubPlanAndSteps(['search for "shoes"', 'search for "hats"'], [DONE]);
      const open = vi.fn(async () => ({}));
      const atSite = { ...withText, url: "https://shop.test/#results" };
      await runBrowseTask("g", 12, stubBrowser({ snapshot: async () => atSite, open }), undefined, undefined, "https://shop.test/");
      expect(open).toHaveBeenCalledTimes(1);
    });

    it("falls back to the usual start (scroll-to-top) when the reopen fails", async () => {
      stubPlanAndSteps(['search for "shoes"', 'search for "hats"'], [DONE]);
      let opens = 0;
      const open = vi.fn(async () => (++opens === 1 ? {} : { error: "net::ERR" }));
      const snapshot = vi.fn(async () => ({ ...inSection, scroll: { y: 500 } }));
      const act = vi.fn(async () => ({}));
      const t = await runBrowseTask("g", 12, stubBrowser({ snapshot, open, act }), undefined, undefined, "https://shop.test");
      expect(reopened(t)).toEqual([expect.objectContaining({ ok: false, subgoal: 2 })]);
      expect(act).toHaveBeenCalledWith({ action: "scroll", amount: -1000 });
    });
  });

  it("does nothing at sub-goal start when a text field is present", async () => {
    stubPlanAndSteps(["one", "find the item"], [DONE]);
    const open = vi.fn(async () => ({}));
    await runBrowseTask("g", 12, stubBrowser({ snapshot: async () => withText, open }), undefined, undefined, "https://shop.test");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("reopens the start URL once and retries a sub-goal that stalled scrolling/refusing", async () => {
    const refuse = { outcome: "retry", operation: "CLICK", confidence: 0.1, model: "jev", reason: "BLOCKED: no candidate fits CLICK" };
    stubPlanAndSteps(["one", "two"], [refuse, refuse, refuse, DONE]);
    const open = vi.fn(async () => ({}));
    const t = await runBrowseTask("g", 12, stubBrowser({ snapshot: async () => withText, open }), undefined, undefined, "https://shop.test");
    expect(open).toHaveBeenCalledTimes(2);
    expect(t.subgoals?.[0].status).toBe("done");
  });

  it("does not reopen after a landed TYPE_TEXT: a reload would wipe the typed form", async () => {
    const refuse = { outcome: "retry", operation: "CLICK", confidence: 0.1, model: "jev", reason: "BLOCKED: no candidate fits CLICK" };
    stubPlanAndSteps(["one", "two"], [DONE, TYPE_TEXT_STEP, refuse, refuse, refuse, DONE]);
    const open = vi.fn(async () => ({}));
    const t = await runBrowseTask("g", 12, stubBrowser({ snapshot: async () => withText, open }), undefined, undefined, "https://shop.test");
    expect(open).toHaveBeenCalledTimes(1);
    expect(t.steps.some((s) => s.label.includes("stall recovery"))).toBe(false);
    expect(t.subgoals?.[1].status).toBe("stalled");
  });

  it("does not reopen after a landed CLICK on a choice control (role=option)", async () => {
    const refuse = { outcome: "retry", operation: "CLICK", confidence: 0.1, model: "jev", reason: "BLOCKED: no candidate fits CLICK" };
    const clickAt = (index: number) => ({ outcome: "act", operation: "CLICK", index, confidence: 0.9, model: "jev" });
    const withOption = { ...withText, elements: [...withText.elements, { index: 2, tag: "div", role: "option", label: "Acme Inc", ops: ["CLICK"] }] };
    stubPlanAndSteps(["one", "two"], [DONE, clickAt(2), refuse, refuse, refuse, DONE]);
    const open = vi.fn(async () => ({}));
    const t = await runBrowseTask("g", 12, stubBrowser({ snapshot: async () => withOption, open }), undefined, undefined, "https://shop.test");
    expect(open).toHaveBeenCalledTimes(1);
    expect(t.steps.some((s) => s.label.includes("stall recovery"))).toBe(false);
    expect(JSON.stringify(t.steps)).not.toMatch(/choice|setsState/i);
  });

  it("still reopens when the typed text was left behind on an earlier page (search submitted)", async () => {
    const refuse = { outcome: "retry", operation: "CLICK", confidence: 0.1, model: "jev", reason: "BLOCKED: no candidate fits CLICK" };
    stubPlanAndSteps(["one", "two"], [DONE, TYPE_TEXT_STEP, refuse, refuse, refuse, DONE]);
    const open = vi.fn(async () => ({}));
    let typed = false;
    const perform = vi.fn(async () => {
      typed = true;
      return {};
    });
    const results = { ...withText, url: "https://shop.test/search?q=headphones" };
    const snapshot = async () => (typed ? results : withText);
    await runBrowseTask("g", 12, stubBrowser({ snapshot, open, perform }), undefined, undefined, "https://shop.test");
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("still reopens after a landed CLICK on a tab (checked, but navigation, not a choice)", async () => {
    const refuse = { outcome: "retry", operation: "CLICK", confidence: 0.1, model: "jev", reason: "BLOCKED: no candidate fits CLICK" };
    const clickAt = (index: number) => ({ outcome: "act", operation: "CLICK", index, confidence: 0.9, model: "jev" });
    const withTab = { ...withText, elements: [...withText.elements, { index: 2, tag: "div", role: "tab", label: "Hotels", checked: false, ops: ["CLICK"] }] };
    stubPlanAndSteps(["one", "two"], [DONE, clickAt(2), refuse, refuse, refuse, DONE]);
    const open = vi.fn(async () => ({}));
    await runBrowseTask("g", 12, stubBrowser({ snapshot: async () => withTab, open }), undefined, undefined, "https://shop.test");
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("does not reopen after a landed CLICK on a native checkbox (no role, reports checked)", async () => {
    const refuse = { outcome: "retry", operation: "CLICK", confidence: 0.1, model: "jev", reason: "BLOCKED: no candidate fits CLICK" };
    const clickAt = (index: number) => ({ outcome: "act", operation: "CLICK", index, confidence: 0.9, model: "jev" });
    const withBox = { ...withText, elements: [...withText.elements, { index: 2, tag: "input", label: "I agree", checked: false, ops: ["CLICK"] }] };
    stubPlanAndSteps(["one", "two"], [DONE, clickAt(2), refuse, refuse, refuse, DONE]);
    const open = vi.fn(async () => ({}));
    await runBrowseTask("g", 12, stubBrowser({ snapshot: async () => withBox, open }), undefined, undefined, "https://shop.test");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("still reopens after a landed CLICK on a plain button", async () => {
    const refuse = { outcome: "retry", operation: "CLICK", confidence: 0.1, model: "jev", reason: "BLOCKED: no candidate fits CLICK" };
    const click = { outcome: "act", operation: "CLICK", index: 1, confidence: 0.9, model: "jev" };
    stubPlanAndSteps(["one", "two"], [DONE, click, refuse, refuse, refuse, DONE]);
    const open = vi.fn(async () => ({}));
    await runBrowseTask("g", 12, stubBrowser({ snapshot: async () => withText, open }), undefined, undefined, "https://shop.test");
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("leaves an open dialog alone when the sub-goal does not ask to search", async () => {
    stubPlanAndSteps(["one", "proceed to checkout"], [DONE]);
    const act = vi.fn(async () => ({}));
    const open = vi.fn(async () => ({}));
    const blocked = { ...withText, elements: [withText.elements[1]], modal: "Your cart" };
    await runBrowseTask("g", 12, stubBrowser({ snapshot: async () => blocked, act, open }), undefined, undefined, "https://shop.test");
    expect(act).not.toHaveBeenCalledWith({ action: "press", key: "Escape" });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("reopens the second site, not the start URL, when a stall happens there", async () => {
    const refuse = { outcome: "retry", operation: "CLICK", confidence: 0.1, model: "jev", reason: "BLOCKED: no candidate fits CLICK" };
    stubPlanAndSteps(["one", "go to https://other.example/p and two"], [DONE, refuse, refuse, refuse, DONE]);
    const open = vi.fn(async (_a: { url: string }) => ({}));
    await runBrowseTask("g", 12, stubBrowser({ snapshot: async () => withText, open }), undefined, undefined, "https://shop.test");
    expect(open.mock.calls.map((c) => c[0].url)).toEqual(["https://shop.test", "https://other.example/p", "https://other.example/p"]);
  });

  it("seeds the stall retry with the stalled attempt's entries, without the earlier-sub-goal mark", async () => {
    const refuse = { outcome: "retry", operation: "CLICK", confidence: 0.1, model: "jev", reason: "BLOCKED: no candidate fits CLICK" };
    const { stepBodies } = stubPlanAndSteps(["one", "two"], [refuse, refuse, refuse, DONE]);
    await runBrowseTask("g", 12, stubBrowser({ snapshot: async () => withText }), undefined, undefined, "https://shop.test");
    const retry = stepBodies[3].history as Array<{ label: string }>;
    expect(retry).toHaveLength(2);
    expect(retry.some((h) => h.label.includes("earlier sub-goal"))).toBe(false);
  });

  it("records the stall-recovery OPEN after the stalled steps, and counts it", async () => {
    const refuse = { outcome: "retry", operation: "CLICK", confidence: 0.1, model: "jev", reason: "BLOCKED: no candidate fits CLICK" };
    stubPlanAndSteps(["one", "two"], [refuse, refuse, refuse, DONE]);
    const t = await runBrowseTask("g", 12, stubBrowser({ snapshot: async () => withText }), undefined, undefined, "https://shop.test");
    const ops = t.steps.map((s) => s.operation);
    const openAt = ops.indexOf("OPEN");
    expect(openAt).toBeGreaterThan(0);
    expect(t.steps.slice(0, openAt).every((s) => s.operation !== "OPEN")).toBe(true);
    expect(t.stepsTotal).toBeGreaterThanOrEqual(4);
  });

  it("keeps the effect note whole when carrying a long label over", () => {
    const label = `${"x".repeat(150)} → effect: "Add to cart" became "Add to cart 1"`;
    const out = carryOverHistory([{ operation: "CLICK", label, ok: true }]);
    expect(out[0].label).toHaveLength(200);
    expect(out[0].label).toContain('became "Add to cart 1"');
    expect(out[0].label.endsWith(" (earlier sub-goal)")).toBe(true);
  });
});

describe("browse_task observations", () => {
  // The snapshot carries `text`, which keeps the step loop from calling
  // read() itself, so every read() call below is an end-of-loop read.
  const withText: SnapshotResult = { ...EXAMPLE_SNAPSHOT, text: "page" };
  type ReadAnswer = string | Error | { text: string; url?: string; truncated?: boolean };
  function readSequence(answers: ReadAnswer[]) {
    let i = 0;
    return vi.fn(async (_opts?: { maxChars?: number }) => {
      const next = answers[Math.min(i++, answers.length - 1)];
      if (next instanceof Error) throw next;
      return typeof next === "string" ? { text: next } : next;
    });
  }
  const run = (goal: string, browser: BrowserBridge, ...rest: unknown[]) =>
    (runBrowseTask as (...a: unknown[]) => ReturnType<typeof runBrowseTask>)(goal, 12, browser, ...rest);
  const CUT = " …[cut]";

  it("attaches one observation of the final page for a single flow", async () => {
    stubPlanAndSteps(["only one"], [DONE]);
    const read = readSequence(["Cafe A 4.7 Cafe B 4.5"]);
    const t = await run("list shops", stubBrowser({ read, snapshot: async () => withText }));
    expect(t.observations).toEqual([{ url: "https://example.com", text: "Cafe A 4.7 Cafe B 4.5" }]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith({ maxChars: 4_000 });
  });

  it("takes the url from the read result, falling back to the loop url", async () => {
    stubPlanAndSteps(["a", "b"], [DONE, DONE]);
    const read = readSequence([{ text: "first", url: "https://read.example/page" }, "second"]);
    const t = await run("g", stubBrowser({ read, snapshot: async () => withText }));
    expect(t.observations?.map((o) => o.url)).toEqual(["https://read.example/page", "https://example.com"]);
  });

  it("attaches one observation per sub-goal, numbered from 1, with a smaller budget for earlier ones", async () => {
    stubPlanAndSteps(["one", "two"], [DONE, DONE]);
    const read = readSequence(["first page", "second page"]);
    const t = await run("do both", stubBrowser({ read, snapshot: async () => withText }));
    expect(t.observations).toEqual([
      { subgoal: 1, url: "https://example.com", text: "first page" },
      { subgoal: 2, url: "https://example.com", text: "second page" },
    ]);
    expect(read.mock.calls.map((c) => c[0]?.maxChars)).toEqual([1_500, 4_000]);
  });

  it("marks text cut when the read reports truncated, or the page is longer than the budget", async () => {
    stubPlanAndSteps(["a", "b"], [DONE, DONE]);
    const read = readSequence([{ text: "partial page", truncated: true }, "y".repeat(5_000)]);
    const t = await run("g", stubBrowser({ read, snapshot: async () => withText }));
    expect(t.observations?.[0].text).toBe(`partial page${CUT}`);
    expect(t.observations?.[1].text).toBe("y".repeat(4_000) + CUT);
  });

  it("reads and keeps only the last 5 sub-goals", async () => {
    stubPlanAndSteps(["a", "b", "c", "d", "e", "f", "g", "h"], [DONE]);
    const read = readSequence(["p4", "p5", "p6", "p7", "p8"]);
    const t = await run("g", stubBrowser({ read, snapshot: async () => withText }));
    expect(read).toHaveBeenCalledTimes(5);
    expect(t.observations?.map((o) => o.subgoal)).toEqual([4, 5, 6, 7, 8]);
  });

  it("trims the oldest first to the 10000 total, marks it cut and drops stubs", () => {
    const entries = (last: number) =>
      "abcde".split("").map((c, i) => ({ subgoal: i + 1, url: "u", text: c.repeat(i === 4 ? last : 1_500) }));
    // 4 x 1500 + 5500 = 11500: excess 1500 cuts the oldest to 0, so it is dropped.
    expect(capObservations(entries(5_500))?.map((o) => o.subgoal)).toEqual([2, 3, 4, 5]);
    // Excess 700: the oldest keeps 800 chars plus the marker.
    const t = capObservations(entries(4_700));
    expect(t?.[0].text).toBe("a".repeat(800) + CUT);
    expect(t).toHaveLength(5);
  });

  it("does not treat two cut texts with the same prefix as the same page", async () => {
    stubPlanAndSteps(["a", "b", "c"], [DONE]);
    const read = readSequence([{ text: "header", truncated: true }, { text: "header", truncated: true }, "end"]);
    const t = await run("g", stubBrowser({ read, snapshot: async () => withText }));
    expect(t.observations?.map((o) => o.text)).toEqual([`header${CUT}`, `header${CUT}`, "end"]);
  });

  it("keeps a placeholder for a page identical to the previous one", async () => {
    stubPlanAndSteps(["a", "b", "c"], [DONE]);
    const read = readSequence(["same", "same", "other"]);
    const t = await run("g", stubBrowser({ read, snapshot: async () => withText }));
    expect(t.observations?.map((o) => [o.subgoal, o.text])).toEqual([
      [1, "same"],
      [2, "(same page as sub-goal 1)"],
      [3, "other"],
    ]);
  });

  it("omits the field when the read fails or returns no text", async () => {
    stubPlanAndSteps(["only one"], [DONE]);
    const failing = await run("g", stubBrowser({ read: readSequence([new Error("no tab")]), snapshot: async () => withText }));
    expect("observations" in failing).toBe(false);
    const empty = await run("g", stubBrowser({ read: readSequence(["   "]), snapshot: async () => withText }));
    expect("observations" in empty).toBe(false);
  });

  it("does not read the page when the task fails before the loop", async () => {
    stubPlanAndSteps(["a", "b"], [DONE]);
    const read = readSequence(["never"]);
    const open = vi.fn(async () => ({ error: "net::ERR_NAME_NOT_RESOLVED" }));
    const t = await run("g", stubBrowser({ read, open }), undefined, undefined, "https://shop.test");
    expect(t.status).toBe("blocked");
    expect(t.observations).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("does not read the page when the task was cancelled", async () => {
    stubPlanAndSteps(["only one"], [DONE]);
    const read = readSequence(["never"]);
    const ac = new AbortController();
    ac.abort();
    const t = await run("g", stubBrowser({ read, snapshot: async () => withText }), undefined, undefined, undefined, undefined, undefined, ac.signal);
    expect(t.observations).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("does not start a read with less than the read timeout left of the overall deadline", async () => {
    stubPlanAndSteps(["only one"], [DONE]);
    const read = readSequence(["never"]);
    // overallDeadlineMs 4000 < the 5000 ms read timeout
    const t = await run("g", stubBrowser({ read, snapshot: async () => withText }), undefined, undefined, undefined, undefined, 4_000);
    expect(t.status).toBe("done");
    expect(t.observations).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("stops waiting for a hung read as soon as the signal aborts", async () => {
    stubPlanAndSteps(["only one"], [DONE]);
    const ac = new AbortController();
    const read = vi.fn(() => {
      queueMicrotask(() => setTimeout(() => ac.abort(), 0));
      return new Promise<never>(() => {});
    });
    const t = await run("g", stubBrowser({ read, snapshot: async () => withText }), undefined, undefined, undefined, undefined, undefined, ac.signal);
    expect(read).toHaveBeenCalledTimes(1);
    expect(t.observations).toBeUndefined();
  });
});

describe("capObservations", () => {
  it("says so when the page a placeholder points to was dropped by the total cap", () => {
    const big = "x".repeat(1_500);
    const out = capObservations([
      { subgoal: 1, url: "u1", text: "y".repeat(1_500) },
      { subgoal: 2, url: "u2", text: "", sameAs: 1 },
      { subgoal: 3, url: "u3", text: big },
      { subgoal: 4, url: "u4", text: big },
      { subgoal: 5, url: "u5", text: big },
      { subgoal: 6, url: "u6", text: "z".repeat(5_500) },
    ]);
    expect(out?.some((o) => o.subgoal === 1)).toBe(false);
    expect(out?.find((o) => o.subgoal === 2)?.text).toBe("(same page as sub-goal 1; its text was not kept)");
  });
});

describe("runBrowseTask: optional host options", () => {
  it("with no storage the action cache is a silent no-op and the task still completes", async () => {
    const fetchMock = stubFetchSequence([CLICK_STEP, DONE]);
    const browser = stubBrowser({});
    // First run would write a cache entry (a landed CLICK on a labelled button).
    const first = await runBrowseTaskPublic("accept cookies", { browser, backend });
    expect(first.status).toBe("done");
    expect(first.cacheHits).toBe(0);

    // Second identical run: with a cache it would replay the CLICK and skip
    // the step request; with none it asks the backend again.
    fetchMock.mockClear();
    const second = await runBrowseTaskPublic("accept cookies", { browser, backend });
    expect(second.status).toBe("done");
    expect(second.cacheHits).toBe(0);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/api/browse/step")).length).toBeGreaterThan(0);
  });

  it("with no permissions the step body carries none (the backend defaults apply)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    stubFetchSequence([DONE], (init) => bodies.push(JSON.parse(String(init.body))));
    await runBrowseTaskPublic("accept cookies", { browser: stubBrowser({}), backend });
    const step = bodies.find((b) => "elements" in b);
    expect(step).toBeDefined();
    expect(step).not.toHaveProperty("permissions");
  });
});

describe("quantity-reached gate", () => {
  const ADD = "Add PAX wardrobe frame to cart";
  const OTHER = "Add shelf to cart";
  const pageWith = (bag: string | null) => ({
    url: "https://shop.test/p",
    title: "Product",
    elements: [
      { index: 0, tag: "button", label: ADD, ops: ["CLICK"] },
      { index: 1, tag: "button", label: OTHER, ops: ["CLICK"] },
      ...(bag ? [{ index: 2, tag: "a", label: bag, ops: ["CLICK"] }] : []),
    ],
    snapshotId: "s",
    scroll: { y: 0 },
  });
  const click = (index: number) => ({ ...CLICK_STEP, index });
  const SUBGOAL = (n: string) => `Add ${n} of the PAX wardrobe frame (100 cm wide, white) to the shopping bag. Done when: the shopping bag shows ${n} of the frame.`;

  /** `bags[k]` is the bag label on the page after k clicks (null = none). */
  async function run(goal: string, decisions: Array<Record<string, unknown>>, bags: Array<string | null>, firstAppeared?: string, single = false) {
    stubFetchSequence([...decisions, DONE]);
    let performs = 0;
    const perform = vi.fn(async () => {
      performs++;
      return performs === 1 && firstAppeared ? { changed: true, appeared: [firstAppeared] } : { changed: true };
    });
    const browser = stubBrowser({
      perform,
      snapshot: async () => pageWith(bags[Math.min(performs, bags.length - 1)]),
    });
    const t = await runBrowseTaskLoop(goal, 12, browser, undefined, undefined, undefined, undefined, { initialSnapshot: pageWith(bags[0]) }, undefined, single ? undefined : { isSubGoal: true });
    return { t, perform };
  }
  const IKEA_BAGS = [null, "Shopping bag, 1 items", "Shopping bag, 2 items", "Shopping bag, 3 items", "Shopping bag, 4 items"];

  it("N=2: stops after counter 1→2 instead of clicking a third time", async () => {
    const { t, perform } = await run(SUBGOAL("2 units"), [click(0), click(0), click(0), click(0)], IKEA_BAGS, "Shopping bag, 1 items");
    expect(perform).toHaveBeenCalledTimes(2);
    expect(t.status).toBe("done");
    expect(t.reason).toBe("quantity 2 reached (counter 1→2)");
    expect(t.steps[0].label).toContain('appeared: "Shopping bag, 1 items"');
    expect(t.steps[1].label).toContain("counter 1→2");
    expect(t.steps.at(-1)).toMatchObject({ operation: "DONE", ok: true });
    expect(t.steps.at(-1)?.label).toContain("quantity reached — not clicking again");
  });

  it("N=3 allows the third click and stops after it", async () => {
    const { t, perform } = await run(SUBGOAL("3 units"), [click(0), click(0), click(0), click(0)], IKEA_BAGS, "Shopping bag, 1 items");
    expect(perform).toHaveBeenCalledTimes(3);
    expect(t.reason).toBe("quantity 3 reached (counter 2→3)");
  });

  it("counts deltas: a counter that already held items (3→4 after an appeared click) adds 1", async () => {
    const bags = [null, "Shopping bag, 3 items", "Shopping bag, 4 items", "Shopping bag, 5 items"];
    const { t, perform } = await run(SUBGOAL("2 units"), [click(0), click(0), click(0)], bags, "Shopping bag, 3 items");
    expect(perform).toHaveBeenCalledTimes(2);
    expect(t.reason).toBe("quantity 2 reached (counter 3→4)");
  });

  it("reads the quantity from the Done-when part when the action names none", async () => {
    const goal = "Put the PAX wardrobe frame in the shopping bag. Done when: the shopping bag shows 2 units of it.";
    const { t, perform } = await run(goal, [click(0), click(0), click(0)], IKEA_BAGS, "Shopping bag, 1 items");
    expect(perform).toHaveBeenCalledTimes(2);
    expect(t.reason).toContain("quantity 2 reached");
  });

  it("no quantity in the goal: no guard", async () => {
    const { perform } = await run("Add the PAX wardrobe frame to the shopping bag. Done when: the bag is not empty.", [click(0), click(0), click(0), click(0)], IKEA_BAGS, "Shopping bag, 1 items");
    expect(perform).toHaveBeenCalledTimes(4);
  });

  it('"100 cm wide" alone is not a quantity: no guard', async () => {
    const goal = "Add the PAX wardrobe frame (100 cm wide, white) to the shopping bag. Done when: the shopping bag shows the frame.";
    const { perform } = await run(goal, [click(0), click(0), click(0), click(0)], IKEA_BAGS, "Shopping bag, 1 items");
    expect(perform).toHaveBeenCalledTimes(4);
  });

  it("a different target is not blocked", async () => {
    // Quantity is reached on target 0, but a click on target 1 still lands.
    const { perform } = await run(SUBGOAL("2 units"), [click(0), click(0), click(1)], IKEA_BAGS, "Shopping bag, 1 items");
    expect(perform).toHaveBeenCalledTimes(3);
  });

  it("without any counter effect and N>1 it stays silent", async () => {
    const { perform } = await run(SUBGOAL("2 units"), [click(0), click(0), click(0)], [null], "Added");
    expect(perform).toHaveBeenCalledTimes(3);
  });

  it("N=1 with a first click that showed a new element blocks the repeat", async () => {
    const { t, perform } = await run(SUBGOAL("1 unit"), [click(0), click(0)], [null, null], "Shopping bag, 1 items");
    expect(perform).toHaveBeenCalledTimes(1);
    expect(t.status).toBe("done");
    expect(t.reason).toContain("quantity 1 reached");
  });

  it("N=1: an appeared text without the number 1 does not arm the gate", async () => {
    const { perform } = await run(SUBGOAL("1 unit"), [click(0), click(0)], [null, null], "Please select a size");
    expect(perform).toHaveBeenCalledTimes(2);
  });

  it("an error click does not count as the first unit (error, then a real add)", async () => {
    // Bag already holds 3. Click 1 only shows a validation message; click 2 is the real add (3→4).
    const bags = ["Shopping bag, 3 items", "Shopping bag, 3 items", "Shopping bag, 4 items", "Shopping bag, 5 items", "Shopping bag, 6 items"];
    const { t, perform } = await run(SUBGOAL("2 units"), [click(0), click(0), click(0), click(0), click(0)], bags, "Please select a size");
    expect(perform).toHaveBeenCalledTimes(3);
    expect(t.reason).toBe("quantity 2 reached (counter 4→5)");
  });

  it("ignores a counter jump larger than N (a price, not units)", async () => {
    const bags = [null, "Shopping bag, 1 items", "Shopping bag, 41 items", "Shopping bag, 42 items", "Shopping bag, 43 items"];
    const { t, perform } = await run(SUBGOAL("2 units"), [click(0), click(0), click(0), click(0), click(0)], bags, "Shopping bag, 1 items");
    expect(perform).toHaveBeenCalledTimes(4);
    expect(t.reason).toBe("quantity 2 reached (counter 42→43)");
  });

  it("follows the target through a relabel (Add to bag → Add to bag (1) → Add to bag (2))", async () => {
    const bags = [null, "Shopping bag, 1 items", "Shopping bag, 2 items"];
    const page = (k: number) => ({
      url: "https://shop.test/p?variant=1#top",
      title: "Product",
      elements: [
        { index: 0, tag: "button", label: k === 0 ? "Add to bag" : `Add to bag (${k})`, ops: ["CLICK"] },
        ...(bags[Math.min(k, 2)] ? [{ index: 1, tag: "a", label: bags[Math.min(k, 2)], ops: ["CLICK"] }] : []),
      ],
      snapshotId: "s",
      scroll: { y: 0 },
    });
    stubFetchSequence([click(0), click(0), click(0), click(0), DONE]);
    let performs = 0;
    const perform = vi.fn(async () => {
      performs++;
      return performs === 1 ? { changed: true, appeared: ["Shopping bag, 1 items"] } : { changed: true };
    });
    const browser = stubBrowser({ perform, snapshot: async () => page(performs) });
    const t = await runBrowseTaskLoop(SUBGOAL("2 units"), 12, browser, undefined, undefined, undefined, undefined, { initialSnapshot: page(0) }, undefined, { isSubGoal: true });
    expect(perform).toHaveBeenCalledTimes(2);
    expect(t.reason).toBe("quantity 2 reached (counter 1→2)");
  });

  it("single-goal run: vetoes the click with a failed step and lets the policy continue", async () => {
    const { t, perform } = await run(SUBGOAL("2 units"), [click(0), click(0), click(0)], IKEA_BAGS, "Shopping bag, 1 items", true);
    expect(perform).toHaveBeenCalledTimes(2);
    expect(t.status).toBe("done");
    expect(t.reason).toBeUndefined();
    expect(t.steps.at(-1)).toMatchObject({ operation: "CLICK", ok: false, label: "quantity 2 reached — not clicking again" });
  });

  it("identifies the clicked element by its own index, not its array position", async () => {
    const sparse = (bag: string | null) => ({
      ...pageWith(bag),
      elements: [
        { index: 5, tag: "button", label: ADD, ops: ["CLICK"] },
        { index: 9, tag: "button", label: OTHER, ops: ["CLICK"] },
        ...(bag ? [{ index: 12, tag: "a", label: bag, ops: ["CLICK"] }] : []),
      ],
    });
    stubFetchSequence([click(5), click(5), click(5), DONE]);
    let performs = 0;
    const perform = vi.fn(async () => (++performs === 1 ? { changed: true, appeared: ["Shopping bag, 1 items"] } : { changed: true }));
    const browser = stubBrowser({ perform, snapshot: async () => sparse(IKEA_BAGS[performs]) });
    const t = await runBrowseTaskLoop(SUBGOAL("2 units"), 12, browser, undefined, undefined, undefined, undefined, { initialSnapshot: sparse(null) }, undefined, { isSubGoal: true });
    expect(perform).toHaveBeenCalledTimes(2);
    expect(t.reason).toBe("quantity 2 reached (counter 1→2)");
  });

  it('does not read a quantity from the "Does not count" clause', async () => {
    const goal = "Put the PAX wardrobe frame in the shopping bag. Done when: the bag shows the frame. Does not count: 2 units of the shelf.";
    const { perform } = await run(goal, [click(0), click(0), click(0), click(0)], IKEA_BAGS, "Shopping bag, 1 items");
    expect(perform).toHaveBeenCalledTimes(4);
  });

  it("keeps the gate across a stall-recovery retry of the same sub-goal", async () => {
    const refuse = { outcome: "retry", operation: "CLICK", confidence: 0.1, model: "jev", reason: "BLOCKED: no candidate fits CLICK" };
    stubPlanAndSteps([SUBGOAL("2 units"), "two"], [click(0), click(0), refuse, refuse, refuse, click(0), DONE]);
    let performs = 0;
    const perform = vi.fn(async () => (++performs === 1 ? { changed: true, appeared: ["Shopping bag, 1 items"] } : { changed: true }));
    const page = () => ({ ...pageWith(IKEA_BAGS[Math.min(performs, 4)]), url: "https://shop.test/p" });
    const open = vi.fn(async () => ({}));
    const t = await runBrowseTask("g", 12, stubBrowser({ perform, open, snapshot: async () => page() }), undefined, undefined, "https://shop.test/p");
    expect(open).toHaveBeenCalledTimes(2);
    expect(perform).toHaveBeenCalledTimes(2);
    expect(t.subgoals?.[0].status).toBe("done");
  });

  it("single-goal run: a policy that insists after two vetoes ends the run as done, never stalled", async () => {
    const { t, perform } = await run(SUBGOAL("2 units"), [click(0), click(0), click(0), click(0), click(0), click(0)], IKEA_BAGS, "Shopping bag, 1 items", true);
    expect(perform).toHaveBeenCalledTimes(2);
    expect(t.status).toBe("done");
    expect(t.reason).toMatch(/^quantity 2 reached/);
    expect(t.steps.filter((st) => st.label === "quantity 2 reached — not clicking again" && !st.ok)).toHaveLength(2);
  });

  it("Set quantity to 3 with a stepper 1→2→3: blocked at the third click (absolute target)", async () => {
    const page = (k: number) => ({
      url: "https://shop.test/cart",
      title: "Cart",
      elements: [
        { index: 0, tag: "button", label: "Increase", ops: ["CLICK"] },
        { index: 1, tag: "input", label: `Quantity ${k + 1}`, ops: ["TYPE_TEXT"] },
      ],
      snapshotId: "s",
      scroll: { y: 0 },
    });
    stubFetchSequence([click(0), click(0), click(0), click(0), DONE]);
    let performs = 0;
    const perform = vi.fn(async () => {
      performs++;
      return { changed: true };
    });
    const browser = stubBrowser({ perform, snapshot: async () => page(performs) });
    const goal = "Set quantity to 3. Done when: the quantity field shows 3.";
    const t = await runBrowseTaskLoop(goal, 12, browser, undefined, undefined, undefined, undefined, { initialSnapshot: page(0) }, undefined, { isSubGoal: true });
    expect(perform).toHaveBeenCalledTimes(2);
    expect(t.reason).toBe("quantity 3 reached (counter 2→3)");
  });

  it("a vetoed cache replay deletes the cached entry", async () => {
    const goal = SUBGOAL("2 units");
    const gate = createQuantityGate(2);
    const at = { url: "https://shop.test/p", label: ADD };
    gate.observe(at, `${ADD} → effect: appeared: "Shopping bag, 1 items"`);
    gate.observe(at, `${ADD} → effect: counter 1→2`);
    const snap = pageWith("Shopping bag, 2 items");
    const key = buildStepCacheKey(goal, snap.url, snap.title, snap.elements, [], snap.scroll, undefined);
    writeStepCacheEntry(store, key, goal, snap.elements, { operation: "CLICK", target: { labelHash: hashCachedLabel(ADD), tag: "button" } });
    expect(store.getItem(ACTION_CACHE_STORAGE_KEY)).toContain(key);
    stubFetchSequence([DONE]);
    const perform = vi.fn(async () => ({ changed: true }));
    const t = await runBrowseTaskLoop(goal, 5, stubBrowser({ perform, snapshot: async () => snap }), undefined, undefined, undefined, undefined, { initialSnapshot: snap }, undefined, { quantityGate: gate });
    expect(perform).not.toHaveBeenCalled();
    expect(t.status).toBe("done");
    expect(t.steps[0]).toMatchObject({ operation: "CLICK", ok: false });
    expect(store.getItem(ACTION_CACHE_STORAGE_KEY) ?? "").not.toContain(key);
  });
});
