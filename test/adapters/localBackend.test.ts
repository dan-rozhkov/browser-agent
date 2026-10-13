import { describe, expect, it, vi } from "vitest";
import { createLocalBackend } from "../../src/adapters/localBackend.js";
import { runBrowseTask } from "../../src/loop/browseTask.js";
import { memoryStorage } from "../../src/loop/storage.js";
import {
  SystemOneAuthError,
  SystemOneRateLimitError,
  SystemOneUpstreamError,
  type SystemOneClient,
} from "../../src/policy/decisions.js";
import { choice, fakeClient, makeOptions } from "../policy/browseFakes.js";
import { jsonModel, textModelCalls } from "../policy/structuredModelFakes.js";
import type { TextModel } from "../../src/policy/textModel.js";
import { stubBrowser } from "../loop/helpers.js";

// The policy fails open on its own (a throwing DecisionClient becomes a
// `retry` decision), so the error branches need the entry points to throw.
const failNext = vi.hoisted(() => ({ err: undefined as unknown }));
vi.mock("../../src/policy/decide.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/policy/decide.js")>();
  return {
    ...actual,
    locateTarget: (...args: Parameters<typeof actual.locateTarget>) => {
      if (failNext.err !== undefined) {
        const err = failNext.err;
        failNext.err = undefined;
        return Promise.reject(err);
      }
      return actual.locateTarget(...args);
    },
  };
});

const REQ = { timeoutMs: 5_000 };

const STEP_BODY = {
  goal: "Dismiss the cookie banner",
  url: "https://example.com",
  title: "Example",
  elements: [{ index: 0, tag: "button", label: "Accept all", ops: ["CLICK"] }],
  history: [],
};

const LOCATE_BODY = {
  description: "the accept button",
  operation: "CLICK",
  url: "https://example.com",
  title: "Example",
  elements: STEP_BODY.elements,
};

/** Options whose next locate call rejects with `err`. */
function throwing(err: unknown) {
  failNext.err = err;
  return fakeClient({});
}

describe("createLocalBackend: validation", () => {
  const backend = createLocalBackend(makeOptions());

  it.each([
    ["/api/browse/step", {}],
    ["/api/browse/plan", { goal: "" }],
    ["/api/browse/locate", { description: "x" }],
  ] as const)("%s answers 400 with the first issue", async (path, body) => {
    const res = await backend.request(path, body, REQ);
    expect(res.status).toBe(400);
    expect(res.ok).toBe(false);
    expect(typeof (res.body as { error: string }).error).toBe("string");
    expect((res.body as { error: string }).error.length).toBeGreaterThan(0);
  });

  it("answers 404 for an unknown path", async () => {
    const res = await backend.request("/api/browse/nope" as never, {}, REQ);
    expect(res.status).toBe(404);
    expect(res.ok).toBe(false);
  });
});

describe("createLocalBackend: success", () => {
  it("step returns the decision without diag", async () => {
    const backend = createLocalBackend(
      makeOptions({ decisions: fakeClient({ operation: choice("DONE", 0.9) }) }),
    );
    const res = await backend.request("/api/browse/step", STEP_BODY, REQ);
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.body).toMatchObject({ outcome: "done" });
    expect(res.body).not.toHaveProperty("diag");
  });

  it("locate returns the located index", async () => {
    const backend = createLocalBackend(
      makeOptions({ decisions: fakeClient({ locate: choice("0", 0.9) }) }),
    );
    const res = await backend.request("/api/browse/locate", LOCATE_BODY, REQ);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ index: 0 });
  });

  it("plan sends only { subgoals }, dropping fallbackReason", async () => {
    textModelCalls.mockImplementationOnce(() => {
      throw new Error("model down");
    });
    const backend = createLocalBackend(makeOptions());
    const res = await backend.request("/api/browse/plan", { goal: "Find a laptop" }, REQ);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ subgoals: ["Find a laptop"] });
  });

  it("plan returns the model's subgoals", async () => {
    textModelCalls.mockImplementationOnce(() =>
      jsonModel({ subgoals: ["Find a laptop on site A", "Find a phone on site B"] }),
    );
    const backend = createLocalBackend(makeOptions());
    const res = await backend.request(
      "/api/browse/plan",
      { goal: "Find a laptop on site A and a phone on site B" },
      REQ,
    );
    expect(res.status).toBe(200);
    expect(Object.keys(res.body as object)).toEqual(["subgoals"]);
  });
});

describe("createLocalBackend: policy failures never throw", () => {
  it.each([
    ["SystemOneRateLimitError", new SystemOneRateLimitError("slow down")],
    ["SystemOneUpstreamError", new SystemOneUpstreamError("boom")],
    ["SystemOneAuthError", new SystemOneAuthError("nope")],
    ["an unknown error", new TypeError("bug")],
  ])("maps %s to 502 with the route's fixed message (no raw message, no 429/500)", async (_n, err) => {
    const backend = createLocalBackend(makeOptions({ decisions: throwing(err) }));
    const res = await backend.request("/api/browse/locate", LOCATE_BODY, REQ);
    expect(res).toEqual({
      status: 502,
      ok: false,
      body: { error: "failed to locate the requested element" },
    });
  });
});

describe("createLocalBackend: plan budget", () => {
  it("keeps the 20 s plan budget: a stalled plan model answers 200 with the fallback, not AbortError", async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    // Shrink only the plan budget so the test does not wait 20 s.
    const spy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms: number) => realTimeout(ms === 20_000 ? 10 : ms));
    try {
      const stalled: TextModel = {
        id: "stalled",
        generateObject: ({ abortSignal }) =>
          new Promise((_, reject) => {
            abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      };
      const backend = createLocalBackend(
        makeOptions({ models: { structured: stalled, cascade: stalled } }),
      );
      const res = await backend.request(
        "/api/browse/plan",
        { goal: "Find a laptop" },
        { timeoutMs: 5_000 },
      );
      expect(res).toMatchObject({ status: 200, ok: true, body: { subgoals: ["Find a laptop"] } });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("createLocalBackend: request signal reaches the policy's clients", () => {
  it("aborting the request aborts the signal the decision client sees", async () => {
    let seen: AbortSignal | undefined;
    const decisions: SystemOneClient = {
      evaluate: (params) => {
        seen = params.signal;
        return new Promise(() => undefined);
      },
    };
    const backend = createLocalBackend(makeOptions({ decisions }));
    const ac = new AbortController();
    const p = backend.request("/api/browse/locate", LOCATE_BODY, { ...REQ, signal: ac.signal });
    await vi.waitFor(() => expect(seen).toBeDefined());
    expect(seen!.aborted).toBe(false);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(seen!.aborted).toBe(true);
  });

  it("merges the request signal into a signal the policy already passes", async () => {
    let seen: AbortSignal | undefined;
    const decisions: SystemOneClient = {
      evaluate: (params) => {
        seen = params.signal;
        return new Promise(() => undefined);
      },
    };
    const backend = createLocalBackend(makeOptions({ decisions }));
    const ac = new AbortController();
    const p = backend.request("/api/browse/step", STEP_BODY, { ...REQ, signal: ac.signal });
    await vi.waitFor(() => expect(seen).toBeDefined());
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(seen!.aborted).toBe(true);
  });

  it("aborting the request aborts the signal the plan text model sees", async () => {
    let seen: AbortSignal | undefined;
    const model: TextModel = {
      id: "m",
      generateObject: ({ abortSignal }) => {
        seen = abortSignal;
        return new Promise(() => undefined);
      },
    };
    const backend = createLocalBackend(makeOptions({ models: { structured: model, cascade: model } }));
    const ac = new AbortController();
    const p = backend.request("/api/browse/plan", { goal: "Find a laptop" }, { ...REQ, signal: ac.signal });
    await vi.waitFor(() => expect(seen).toBeDefined());
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(seen!.aborted).toBe(true);
  });
});

describe("createLocalBackend: abort", () => {
  it("rejects with an AbortError when the signal is already aborted", async () => {
    const decisions = fakeClient({ locate: choice("0", 0.9) });
    const spy = vi.spyOn(decisions, "evaluate");
    const backend = createLocalBackend(makeOptions({ decisions }));
    await expect(
      backend.request("/api/browse/locate", LOCATE_BODY, { ...REQ, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects with an AbortError when aborted in flight", async () => {
    const hang: SystemOneClient = { evaluate: () => new Promise(() => undefined) };
    const backend = createLocalBackend(makeOptions({ decisions: hang }));
    const ac = new AbortController();
    const p = backend.request("/api/browse/locate", LOCATE_BODY, { ...REQ, signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects with an AbortError when timeoutMs passes", async () => {
    const hang: SystemOneClient = { evaluate: () => new Promise(() => undefined) };
    const backend = createLocalBackend(makeOptions({ decisions: hang }));
    await expect(
      backend.request("/api/browse/locate", LOCATE_BODY, { timeoutMs: 10 }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("createLocalBackend: end to end with runBrowseTask", () => {
  it("finishes the goal through the in-process policy", async () => {
    textModelCalls.mockImplementation(() => {
      throw new Error("no text model in this test");
    });
    const backend = createLocalBackend(
      makeOptions({ decisions: fakeClient({ operation: choice("DONE", 0.9) }) }),
    );
    const browser = stubBrowser(
      {},
      {
        url: "https://example.com",
        title: "Example",
        elements: STEP_BODY.elements,
        snapshotId: "snap-1",
      },
    );
    const transcript = await runBrowseTask("Dismiss the cookie banner", {
      browser,
      backend,
      storage: memoryStorage(),
    });
    expect(transcript.status).toBe("done");
  });
});
