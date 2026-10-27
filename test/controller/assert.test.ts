import { describe, expect, it, vi } from "vitest";
import { BrowserController, type BrowserPageHandle, type BrowserTarget } from "../../src/controller/controller.js";
import { controllerBridge } from "../../src/adapters/controllerBridge.js";

function fakePage(over: Partial<BrowserPageHandle> = {}): BrowserPageHandle {
  return {
    loadURL: vi.fn(() => Promise.resolve()),
    executeJavaScript: vi.fn(() => Promise.resolve({ ok: true })),
    getURL: vi.fn(() => "https://example.com/orders/42?token=secret#frag"),
    getTitle: vi.fn(() => "Example"),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
    isLoading: vi.fn(() => false),
    onceDomReady: vi.fn(() => Promise.resolve()),
    ...over,
  };
}
const targetOf = (page: BrowserPageHandle | null): BrowserTarget => ({ ensurePage: async () => page as BrowserPageHandle, currentPage: () => page });
/** Answers ASSERT_JS with `answers` (one per DOM check) and records its args. */
function domAnswers(answers: unknown[]) {
  const args: unknown[] = [];
  const run = vi.fn((code: string) => {
    if (code.includes("function checkElement")) {
      const m = /var args = (\{.*\});\n/.exec(code);
      args.push(m ? JSON.parse(m[1]!) : undefined);
      return Promise.resolve({ results: answers });
    }
    return Promise.resolve({ ok: true });
  });
  return { run, args };
}

describe("controller.assert", () => {
  it("passes and fails DOM checks and keeps the order of the results", async () => {
    const dom = domAnswers([{ passed: true }, { passed: false, actual: "hidden" }, { passed: false, actual: "3 matches" }]);
    const c = new BrowserController(targetOf(fakePage({ executeJavaScript: dom.run })));
    const r = (await c.assert({
      checks: [
        { type: "text", text: "Welcome" },
        { type: "element", selector: "#a", state: "visible" },
        { type: "count", selector: "li", equals: 2 },
      ],
    })) as { ok: boolean; passed: boolean; results: { passed: boolean; actual?: string }[] };
    expect(r.ok).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.results.map((x) => x.passed)).toEqual([true, false, false]);
    expect(r.results[1]!.actual).toBe("hidden");
    expect(r.results[2]!.actual).toBe("3 matches");
  });

  it("sends only the DOM checks to the page and answers url and history checks itself", async () => {
    const dom = domAnswers([{ passed: true }]);
    const c = new BrowserController(
      targetOf(fakePage({ executeJavaScript: dom.run, drainConsoleErrors: () => ["TypeError: boom"], drainFailedRequests: () => ["GET 500 https://example.com/api/x"] })),
    );
    const r = (await c.assert({
      checks: [
        { type: "url", contains: "/orders/42" },
        { type: "url", equals: "https://example.com/other" },
        { type: "url", matches: "orders/\\d+" },
        { type: "text", text: "x" },
        { type: "no_console_errors" },
        { type: "no_console_errors", ignore: ["boom"] },
        { type: "no_failed_requests" },
      ],
    })) as { passed: boolean; results: { passed: boolean; actual?: string }[]; consoleErrors?: string[]; failedRequests?: string[] };
    expect(r.results.map((x) => x.passed)).toEqual([true, false, true, true, false, true, false]);
    // No query or hash in the reported URL.
    expect(r.results[1]!.actual).toBe("url https://example.com/orders/42");
    expect(JSON.stringify(r)).not.toContain("secret");
    expect(r.consoleErrors).toEqual(["TypeError: boom"]);
    expect(r.failedRequests).toEqual(["GET 500 https://example.com/api/x"]);
    expect((dom.args[0] as { checks: unknown[] }).checks).toEqual([{ type: "text", text: "x" }]);
  });

  it("does not run a page script when no check needs the DOM, and omits empty lists", async () => {
    const page = fakePage({ drainConsoleErrors: () => [], drainFailedRequests: () => [] });
    const c = new BrowserController(targetOf(page));
    const r = await c.assert({ checks: [{ type: "url", contains: "example.com" }, { type: "no_console_errors" }] });
    expect(r).toMatchObject({ ok: true, passed: true });
    expect(r).not.toHaveProperty("consoleErrors");
    expect(r).not.toHaveProperty("failedRequests");
    expect(page.executeJavaScript).not.toHaveBeenCalledWith(expect.stringContaining("function checkElement"));
  });

  it("reports an invalid selector as a failed check with an error", async () => {
    const dom = domAnswers([{ passed: false, error: "Invalid selector: ((" }]);
    const c = new BrowserController(targetOf(fakePage({ executeJavaScript: dom.run })));
    const r = (await c.assert({ checks: [{ type: "count", selector: "((", min: 1 }] })) as { passed: boolean; results: { error?: string }[] };
    expect(r.passed).toBe(false);
    expect(r.results[0]!.error).toContain("Invalid selector");
  });

  it("fails every DOM check with the script error when the page script fails", async () => {
    const c = new BrowserController(targetOf(fakePage({ executeJavaScript: vi.fn(() => Promise.reject(new Error("page gone"))) })));
    const r = (await c.assert({ checks: [{ type: "text", text: "a" }, { type: "count", selector: "li", min: 1 }] })) as { results: { passed: boolean; error?: string }[] };
    expect(r.results.map((x) => x.passed)).toEqual([false, false]);
    expect(r.results[0]!.error).toContain("page gone");
  });

  it("returns { error } for a bad checks array and for no tab", async () => {
    const c = new BrowserController(targetOf(fakePage()));
    expect(await c.assert({ checks: [{ type: "element", state: "visible" }] })).toHaveProperty("error");
    expect(await c.assert({})).toHaveProperty("error");
    expect(await c.assert("x")).toHaveProperty("error");
    const none = new BrowserController(targetOf(null));
    expect(await none.assert({ checks: [{ type: "text", text: "a" }] })).toMatchObject({ error: expect.stringContaining("No browser tab") });
  });

  it("resolves an index check against the current snapshot and refuses a stale snapshotId", async () => {
    const dom = domAnswers([{ passed: true }]);
    const page = fakePage({
      executeJavaScript: vi.fn((code: string) => {
        if (code.includes("data-pen-snap") && code.includes("function snap")) return Promise.resolve({});
        return dom.run(code);
      }),
    });
    const c = new BrowserController(targetOf(page));
    // No snapshot yet: the index check is an error, not a throw.
    const early = (await c.assert({ checks: [{ type: "element", index: 0, state: "visible" }] })) as { results: { error?: string }[] };
    expect(early.results[0]!.error).toContain("snapshot");
    const stale = (await c.assert({ snapshotId: "nope", checks: [{ type: "element", index: 0, state: "visible" }] })) as { results: { error?: string }[] };
    expect(stale.results[0]!.error).toContain("snapshot");
  });

  it("names the element of an index check (target), not of a selector check, and adds url and title", async () => {
    const dom = domAnswers([{ passed: true }, { passed: true }]);
    const page = fakePage({
      executeJavaScript: vi.fn((code: string) => {
        if (code.includes("function checkElement")) return dom.run(code);
        if (code.includes("data-pen-snap")) return Promise.resolve({ title: "Example", url: "u", elements: [{ index: 0, tag: "input", role: "textbox", label: "Email" }] });
        return Promise.resolve({ ok: true });
      }),
    });
    const c = new BrowserController(targetOf(page));
    await c.snapshot();
    const r = (await c.assert({
      checks: [
        { type: "value", index: 0, equals: "" },
        { type: "value", selector: "#email", equals: "" },
      ],
    })) as { results: { target?: string }[]; url: string; title: string };
    expect(r.results[0]!.target).toBe('textbox "Email"');
    expect(r.results[1]).not.toHaveProperty("target");
    expect(r.url).toBe("https://example.com/orders/42");
    expect(r.title).toBe("Example");
  });

  const snapPage = (dom: ReturnType<typeof domAnswers>) =>
    fakePage({
      executeJavaScript: vi.fn((code: string) => {
        if (code.includes("function checkElement")) return dom.run(code);
        if (code.includes("data-pen-snap")) return Promise.resolve({ title: "Example", url: "u", elements: [{ index: 0, tag: "input", role: "textbox", label: "Email" }] });
        return Promise.resolve({ ok: true });
      }),
    });

  it("gives no target to an index check that did not run on its element (not found, stale, no snapshot)", async () => {
    const notFound = new BrowserController(targetOf(snapPage(domAnswers([{ passed: false, error: "Element 0 was not found." }]))));
    await notFound.snapshot();
    const r = (await notFound.assert({ checks: [{ type: "value", index: 0, equals: "" }] })) as { results: { target?: string; error?: string }[] };
    expect(r.results[0]!.error).toBeDefined();
    expect(r.results[0]).not.toHaveProperty("target");
    const stale = new BrowserController(targetOf(snapPage(domAnswers([{ passed: true }]))));
    await stale.snapshot();
    const s = (await stale.assert({ snapshotId: "old", checks: [{ type: "value", index: 0, equals: "" }] })) as { results: { target?: string; error?: string }[] };
    expect(s.results[0]!.error).toBeDefined();
    expect(s.results[0]).not.toHaveProperty("target");
    const none = new BrowserController(targetOf(snapPage(domAnswers([{ passed: true }]))));
    const n = (await none.assert({ checks: [{ type: "value", index: 0, equals: "" }] })) as { results: { target?: string }[] };
    expect(n.results[0]).not.toHaveProperty("target");
  });

  it("is not affected by a caller changing the elements of the returned snapshot", async () => {
    const c = new BrowserController(targetOf(snapPage(domAnswers([{ passed: true }]))));
    const snap = (await c.snapshot()) as { elements: { label: string }[] };
    snap.elements[0]!.label = "Changed";
    snap.elements.length = 0;
    const r = (await c.assert({ checks: [{ type: "value", index: 0, equals: "" }] })) as { results: { target?: string }[] };
    expect(r.results[0]!.target).toBe('textbox "Email"');
  });

  it("is forwarded by controllerBridge", async () => {
    const dom = domAnswers([{ passed: true }]);
    const c = new BrowserController(targetOf(fakePage({ executeJavaScript: dom.run })));
    const bridge = controllerBridge(c);
    expect(await bridge.assert!({ checks: [{ type: "text", text: "a" }] })).toMatchObject({ ok: true, passed: true });
  });

  it("dedupes and caps the drained lists at 20 with dropped counters, like act and perform", async () => {
    const many = [...Array.from({ length: 27 }, (_, i) => `GET 500 https://example.com/api/${i}`), "GET 500 https://example.com/api/3"];
    const errors = Array.from({ length: 22 }, (_, i) => `Error ${i}`);
    const c = new BrowserController(targetOf(fakePage({ drainFailedRequests: () => many, drainConsoleErrors: () => errors })));
    const r = (await c.assert({ checks: [{ type: "no_failed_requests" }] })) as Record<string, string[] | number>;
    expect((r.failedRequests as string[]).length).toBe(20);
    expect(r.failedRequests).toEqual(Array.from({ length: 20 }, (_, i) => `GET 500 https://example.com/api/${i + 7}`));
    expect(r.failedRequestsDropped).toBe(7);
    expect((r.consoleErrors as string[]).length).toBe(20);
    expect(r.consoleErrorsDropped).toBe(2);
  });

  it("writes nothing to the journal and drains the lists once", async () => {
    const drainConsole = vi.fn(() => ["e"]);
    const drainFailed = vi.fn(() => ["GET 404 https://example.com/x"]);
    const c = new BrowserController(targetOf(fakePage({ drainConsoleErrors: drainConsole, drainFailedRequests: drainFailed })));
    await c.assert({ checks: [{ type: "no_console_errors" }] });
    expect(drainConsole).toHaveBeenCalledTimes(1);
    expect(drainFailed).toHaveBeenCalledTimes(1);
  });
});

describe("failedRequests in act and perform results", () => {
  const clickPage = (over: Partial<BrowserPageHandle>) =>
    fakePage({
      executeJavaScript: vi.fn((code: string) => {
        if (code.includes("data-pen-sig-mainimg")) {
          return Promise.resolve({ url: "https://example.com/", title: "Example", nodeCount: 1, textLength: 0, textHash: 0, mainImageSrc: "", scrollY: 0, focusedValueLength: 0 });
        }
        return Promise.resolve({ matched: "Go" });
      }),
      ...over,
    });

  it("act attaches the last 20 distinct failed requests and counts the older ones", async () => {
    const drain = vi.fn(() => [...Array.from({ length: 27 }, (_, i) => `GET 500 https://example.com/api/${i}`), "GET 500 https://example.com/api/3"]);
    const c = new BrowserController(targetOf(clickPage({ drainFailedRequests: drain })));
    const r = (await c.act({ action: "click", target: "Go" })) as { failedRequests: string[]; failedRequestsDropped: number };
    expect(r.failedRequests).toHaveLength(20);
    expect(r.failedRequests[19]).toBe("GET 500 https://example.com/api/26");
    expect(r.failedRequests[0]).toBe("GET 500 https://example.com/api/7");
    expect(r.failedRequestsDropped).toBe(7);
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it("act keeps all entries and no dropped counter when there are 20 or fewer", async () => {
    const drain = vi.fn(() => Array.from({ length: 7 }, (_, i) => `GET 500 https://example.com/api/${i}`));
    const c = new BrowserController(targetOf(clickPage({ drainFailedRequests: drain })));
    const r = (await c.act({ action: "click", target: "Go" })) as { failedRequests: string[] };
    expect(r.failedRequests).toHaveLength(7);
    expect(r).not.toHaveProperty("failedRequestsDropped");
  });

  it("act omits the field when there are none, or when the page has no drain", async () => {
    const none = new BrowserController(targetOf(clickPage({ drainFailedRequests: () => [] })));
    expect(await none.act({ action: "click", target: "Go" })).not.toHaveProperty("failedRequests");
    const absent = new BrowserController(targetOf(clickPage({})));
    expect(await absent.act({ action: "wait", ms: 1 })).not.toHaveProperty("failedRequests");
  });

  it("perform attaches failedRequests", async () => {
    const page = clickPage({ drainFailedRequests: () => ["POST net::ERR_FAILED https://example.com/save"] });
    const c = new BrowserController(targetOf(page));
    const snap = (await c.snapshot()) as { snapshotId: string };
    const r = await c.perform({ snapshotId: snap.snapshotId, index: 0, operation: "SCROLL_DOWN" });
    expect(r).toMatchObject({ failedRequests: ["POST net::ERR_FAILED https://example.com/save"] });
  });

  it("a throwing drain never fails the command", async () => {
    const c = new BrowserController(targetOf(clickPage({ drainFailedRequests: () => { throw new Error("x"); } })));
    const r = await c.act({ action: "wait", ms: 1 });
    expect(r).not.toHaveProperty("error");
  });
});
