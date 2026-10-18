import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  BrowserController,
  AUTOCOMPLETE_SETTLE_MS,
  DIALOG_DISMISS_SETTLE_MS,
  LATE_CLICK_EFFECT_MS,
  SETTLE_HEADROOM_MS,
  BROWSER_COMMAND_TIMEOUT_MS,
  BROWSER_OPEN_TIMEOUT_MS,
  MAX_SNAPSHOT_ELEMENTS,
  type BrowserPageHandle,
  type BrowserTarget,
} from "../../src/controller/controller.js";
// "Addendum 2, 2026-09-19" §1: act/perform now capture a page signature via
// SIGNATURE_JS before an action and again after its settle, diffing them
// into `{ changed, changes }`. Review finding 4 made SIGNATURE_JS take a
// `phase` argument (via the same ARGS_MARKER substitution every other
// script uses, so it can coordinate identity markers across the two
// calls — see its doc comment), so a signature call's code no longer
// equals the SIGNATURE_JS constant verbatim; "data-pen-sig-mainimg" is a
// string that appears only in SIGNATURE_JS's own body (not in any other
// script, even though "data-pen-sig-target" is shared with
// CLICK_JS/TYPE_JS/PERFORM_JS), so it reliably identifies a signature call
// regardless of which phase it was run for.
function isSignatureCall(code: unknown): boolean {
  return typeof code === "string" && code.includes("data-pen-sig-mainimg");
}

/** The human-cursor overlay (CURSOR_JS, controller.ts's moveCursor) runs
 * before every click/type/scroll/perform action's before-signature capture
 * — see CURSOR_JS's doc comment (pageScripts.ts). Its code references
 * `window.__penCursor` (the overlay's own state global), which no other
 * script does — SNAPSHOT_JS/FIND_IMAGES_JS both now reference the overlay's
 * *marker attribute* `data-pen-cursor` too (to skip it), so that string
 * alone is no longer unique to this script, unlike `__penCursor`. Every
 * existing assertion below that counts or indexes executeJavaScript calls
 * excludes cursor calls, exactly like signature calls, so this addition
 * doesn't change what those tests were already asserting about the action
 * scripts themselves. */
function isCursorCall(code: unknown): boolean {
  return typeof code === "string" && code.includes("__penCursor");
}

/** REVEAL_TARGET_JS (controller.ts's revealTarget) runs before the cursor
 * move and the before-signature capture on every click/type path, and is
 * marked by its own `__penReveal` local. Excluded from the action-script
 * helpers below exactly like the cursor call, so the existing call-count /
 * script-lookup assertions keep describing the action scripts themselves;
 * the ordering tests further down look at it explicitly. */
function isRevealCall(code: unknown): boolean {
  return typeof code === "string" && code.includes("__penReveal");
}

/** Finds the one non-signature, non-cursor executeJavaScript call whose code
 * contains `needle` — the action script's call, not one of the SIGNATURE_JS
 * calls bracketing it or the CURSOR_JS call preceding all of them. */
function findScriptCall(mock: ReturnType<typeof vi.fn>, needle: string): string {
  const call = mock.mock.calls.find((c) => !isSignatureCall(c[0]) && !isCursorCall(c[0]) && !isRevealCall(c[0]) && (c[0] as string).includes(needle));
  expect(call, `no executeJavaScript call contained ${JSON.stringify(needle)}`).toBeTruthy();
  return call![0] as string;
}

/** Count of executeJavaScript calls, excluding the cursor call — for
 * assertions written before the cursor overlay existed that count the
 * action-script-plus-signature-capture calls only. */
function nonCursorCallCount(mock: ReturnType<typeof vi.fn>): number {
  return mock.mock.calls.filter((c) => !isCursorCall(c[0]) && !isRevealCall(c[0])).length;
}

// A real goBack()/goForward() is fire-and-forget but the URL does change —
// this fake mutates its own url/title synchronously on goBack/goForward so
// BrowserController's post-navigation URL-change poll (waitForUrlChange)
// resolves on its very first check, keeping these tests fast.
//
// The default executeJavaScript is signature-aware: a SIGNATURE_JS call
// (captureSignature) gets a real signature reflecting the page's *current*
// getURL()/getTitle() (so a navigating action's before/after diff correctly
// shows `changed: true` on "url"/"title" even under the default fake),
// while every other script gets the generic `{ ok: true }` most tests never
// inspect. A test that overrides executeJavaScript entirely takes on the
// responsibility of handling SIGNATURE_JS itself (see the "evidence of
// effect" describe block below for the pattern).
function makeFakePage(overrides: Partial<BrowserPageHandle> = {}): BrowserPageHandle {
  let url = "https://example.com/";
  let title = "Example";
  const page: BrowserPageHandle = {
    loadURL: vi.fn(() => Promise.resolve()),
    executeJavaScript: vi.fn((code: string) => {
      if (isSignatureCall(code)) {
        return Promise.resolve({
          url: page.getURL(),
          title: page.getTitle(),
          nodeCount: 1,
          textLength: 0,
          textHash: 0,
          mainImageSrc: "",
          scrollY: 0,
          focusedValueLength: 0,
        });
      }
      return Promise.resolve({ ok: true });
    }),
    getURL: vi.fn(() => url),
    getTitle: vi.fn(() => title),
    goBack: vi.fn(() => {
      url = "https://example.com/back";
      title = "Example (back)";
    }),
    goForward: vi.fn(() => {
      url = "https://example.com/forward";
      title = "Example (forward)";
    }),
    reload: vi.fn(),
    canGoBack: vi.fn(() => true),
    canGoForward: vi.fn(() => true),
    isLoading: vi.fn(() => false),
    // DOM-readiness fix (`open`'s doc comment): resolves immediately by
    // default, modeling the common case where the DOM becomes ready (and,
    // for these instant fakes, the full load also settles) essentially
    // synchronously. Tests exercising the "DOM ready, full load still
    // pending/failing" split override this and/or `loadURL` explicitly.
    onceDomReady: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
  return page;
}

function makeFakeTarget(page: BrowserPageHandle | null): BrowserTarget & { ensurePage: ReturnType<typeof vi.fn> } {
  const ensurePage = vi.fn(async () => {
    if (!page) throw new Error("no page to create");
    return page;
  });
  return {
    ensurePage,
    currentPage: () => page,
  };
}

describe("BrowserController", () => {
  describe("open", () => {
    it("navigates the ensured page and returns its final url/title, with loaded: true once the full load settles", async () => {
      const page = makeFakePage({ getURL: vi.fn(() => "https://example.com/final") });
      const target = makeFakeTarget(page);
      const controller = new BrowserController(target);
      const result = await controller.open({ url: "https://example.com" });
      expect(target.ensurePage).toHaveBeenCalled();
      expect(page.loadURL).toHaveBeenCalledWith("https://example.com");
      // Old behavior asserted `{ url, title }` alone, encoding "open always
      // means fully loaded" — no longer true (that's the defect this fix
      // addresses), so the expectation now includes `loaded`.
      expect(result).toEqual({ url: "https://example.com/final", title: "Example", loaded: true });
    });

    it("resolves promptly with loaded: false when the DOM becomes ready but the full load never settles", async () => {
      vi.useFakeTimers();
      try {
        const page = makeFakePage({
          getURL: vi.fn(() => "https://example.com/heavy"),
          getTitle: vi.fn(() => "Heavy Page"),
          // Models webContents.loadURL() resolving only at did-finish-load,
          // which on a heavy page (ads/trackers/video) may never happen
          // within any reasonable bound — the promise here just never
          // settles.
          loadURL: vi.fn(() => new Promise<void>(() => {})),
          onceDomReady: vi.fn(() => Promise.resolve()),
        });
        const controller = new BrowserController(makeFakeTarget(page));
        const promise = controller.open({ url: "https://example.com" });
        // Only the bounded grace period elapses — nowhere near
        // BROWSER_COMMAND_TIMEOUT_MS — proving `open` doesn't wait for the
        // full load at all.
        await vi.advanceTimersByTimeAsync(1_600);
        const result = await promise;
        expect(result).toEqual({ url: "https://example.com/heavy", title: "Heavy Page", loaded: false });
      } finally {
        vi.useRealTimers();
      }
    });

    it("reports loaded: true when the full load settles within the grace period after DOM-ready", async () => {
      vi.useFakeTimers();
      try {
        let resolveLoad!: () => void;
        const page = makeFakePage({
          getURL: vi.fn(() => "https://example.com/final"),
          loadURL: vi.fn(
            () =>
              new Promise<void>((resolve) => {
                resolveLoad = resolve;
              }),
          ),
          onceDomReady: vi.fn(() => Promise.resolve()),
        });
        const controller = new BrowserController(makeFakeTarget(page));
        const promise = controller.open({ url: "https://example.com" });
        // Let the dom-ready branch win the initial race, then let the full
        // load settle well within OPEN_LOAD_GRACE_MS.
        await vi.advanceTimersByTimeAsync(0);
        resolveLoad();
        await vi.advanceTimersByTimeAsync(100);
        const result = await promise;
        expect(result).toEqual({ url: "https://example.com/final", title: "Example", loaded: true });
      } finally {
        vi.useRealTimers();
      }
    });

    it("surfaces a genuine navigation error that happens before DOM-ready as {error}, not swallowed", async () => {
      const page = makeFakePage({
        loadURL: vi.fn(() => Promise.reject(new Error("net::ERR_NAME_NOT_RESOLVED"))),
        // DOM-ready never fires for a navigation that fails outright.
        onceDomReady: vi.fn(() => new Promise<void>(() => {})),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.open({ url: "https://example.com" });
      expect(result).toHaveProperty("error");
      expect(String((result as { error: string }).error)).toMatch(/ERR_NAME_NOT_RESOLVED/);
    });

    it("does not produce an unhandled rejection when DOM-ready wins and loadURL rejects afterwards — the successful result stands", async () => {
      vi.useFakeTimers();
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        let rejectLoad!: (err: Error) => void;
        const page = makeFakePage({
          getURL: vi.fn(() => "https://example.com/heavy"),
          loadURL: vi.fn(
            () =>
              new Promise<void>((_resolve, reject) => {
                rejectLoad = reject;
              }),
          ),
          onceDomReady: vi.fn(() => Promise.resolve()),
        });
        const controller = new BrowserController(makeFakeTarget(page));
        const promise = controller.open({ url: "https://example.com" });
        // Nothing but the bounded grace period elapses before `open`
        // returns — the load promise is still pending at that point.
        await vi.advanceTimersByTimeAsync(1_600);
        const result = await promise;
        expect(result).toEqual({ url: "https://example.com/heavy", title: "Example", loaded: false });
        // The load promise settles (rejects) only after `open` already
        // returned — this must not surface as an unhandled rejection.
        rejectLoad(new Error("net::ERR_CONNECTION_RESET"));
        await vi.advanceTimersByTimeAsync(0);
        expect(unhandled).toEqual([]);
      } finally {
        process.removeListener("unhandledRejection", onUnhandled);
        vi.useRealTimers();
      }
    });

    it("arms the DOM-ready listener before calling loadURL", async () => {
      const callOrder: string[] = [];
      const page = makeFakePage({
        onceDomReady: vi.fn(() => {
          callOrder.push("onceDomReady");
          return Promise.resolve();
        }),
        loadURL: vi.fn(() => {
          callOrder.push("loadURL");
          return Promise.resolve();
        }),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      await controller.open({ url: "https://example.com" });
      expect(callOrder).toEqual(["onceDomReady", "loadURL"]);
    });

    it("rejects missing url", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      const result = await controller.open({});
      expect(result).toHaveProperty("error");
    });

    it("rejects a non-string url", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      const result = await controller.open({ url: 123 });
      expect(result).toHaveProperty("error");
    });

    it("rejects an empty-string url", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      const result = await controller.open({ url: "   " });
      expect(result).toHaveProperty("error");
    });

    it("rejects non-http(s) schemes", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      const result = await controller.open({ url: "file:///etc/passwd" });
      expect(result).toHaveProperty("error");
      expect(String((result as { error: string }).error)).toMatch(/http/i);
    });

    it("rejects entirely malformed arguments (array, string, null)", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      expect(await controller.open(["https://example.com"])).toHaveProperty("error");
      expect(await controller.open("https://example.com")).toHaveProperty("error");
      expect(await controller.open(null)).toHaveProperty("error");
      expect(await controller.open(undefined)).toHaveProperty("error");
    });

    it("never rejects when ensurePage throws — resolves to an error result instead", async () => {
      const target = makeFakeTarget(null);
      const controller = new BrowserController(target);
      await expect(controller.open({ url: "https://example.com" })).resolves.toHaveProperty("error");
    });

    it("times out and resolves an error result if ensurePage never settles", async () => {
      vi.useFakeTimers();
      try {
        const target: BrowserTarget = {
          ensurePage: () => new Promise<BrowserPageHandle>(() => {}),
          currentPage: () => null,
        };
        const controller = new BrowserController(target, { timeoutMs: 50 });
        const promise = controller.open({ url: "https://example.com" });
        await vi.advanceTimersByTimeAsync(60);
        const result = await promise;
        expect(result).toHaveProperty("error");
        expect(String((result as { error: string }).error)).toMatch(/timed out/i);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("act", () => {
    it("rejects a missing/unknown action", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      expect(await controller.act({})).toHaveProperty("error");
      expect(await controller.act({ action: "teleport" })).toHaveProperty("error");
      expect(await controller.act(null)).toHaveProperty("error");
      expect(await controller.act("click")).toHaveProperty("error");
    });

    it("errors cleanly when no browser tab is open", async () => {
      const controller = new BrowserController(makeFakeTarget(null));
      const result = await controller.act({ action: "click", target: "Buy now" });
      expect(result).toHaveProperty("error");
    });

    describe("click", () => {
      it("requires a non-empty string target", async () => {
        const controller = new BrowserController(makeFakeTarget(makeFakePage()));
        expect(await controller.act({ action: "click" })).toHaveProperty("error");
        expect(await controller.act({ action: "click", target: "" })).toHaveProperty("error");
        expect(await controller.act({ action: "click", target: 42 })).toHaveProperty("error");
      });

      it("runs the click script against the current page and returns its result", async () => {
        // getURL/getTitle deliberately match what the script itself reports —
        // this exercises the non-navigating case (no url change), so the
        // post-click settle wait (finding 7) resolves immediately and the
        // page's own url/title are used, consistent with the script's.
        const page = makeFakePage({
          getURL: vi.fn(() => "https://x/"),
          getTitle: vi.fn(() => "X"),
          executeJavaScript: vi.fn(() => Promise.resolve({ url: "https://x/", title: "X", matched: "Buy now" })),
        });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = await controller.act({ action: "click", target: "Buy now" });
        // 4 calls: captureSignature (before), CLICK_RESOLVE_JS (Wave 2's
        // trusted-click resolve step — this fake's canned response has no
        // `hitOk`/`found`, so it always falls back to the DOM path below),
        // CLICK_JS, captureSignature (after) — see "Addendum 2" §1. This
        // fake's executeJavaScript returns the same canned CLICK_JS-shaped
        // object for every call (including the two signature calls), which
        // is not a valid signature, so evidence capture degrades to
        // changed: false rather than throwing — covered on its own in the
        // "evidence of effect" block below.
        // 4 non-cursor calls (a 5th, the cursor overlay's CURSOR_JS, runs
        // before all of them — see isCursorCall's doc comment).
        expect(nonCursorCallCount(page.executeJavaScript as ReturnType<typeof vi.fn>)).toBe(4);
        const code = findScriptCall(page.executeJavaScript as ReturnType<typeof vi.fn>, JSON.stringify("Buy now"));
        expect(code).not.toContain("PEN_BROWSER_ARGS");
        expect(result).toEqual({
          url: "https://x/",
          title: "X",
          matched: "Buy now",
          via: "dom",
          changed: false,
          changes: [],
        });
      });

      it("finding 7: settles to the post-navigation url/title when a click starts a navigation, rather than trusting the script's stale pre-navigation read", async () => {
        vi.useFakeTimers();
        try {
          let url = "https://example.com/";
          let title = "Example";
          const page = makeFakePage({
            getURL: vi.fn(() => url),
            getTitle: vi.fn(() => title),
            executeJavaScript: vi.fn(() => {
              // The real page: the script's own synchronous location.href
              // read reports the page it was on when the click ran, but the
              // click actually kicks off a navigation that lands shortly
              // after the script returns.
              setTimeout(() => {
                url = "https://example.com/next";
                title = "Next";
              }, 50);
              return Promise.resolve({ url: "https://example.com/", title: "Example", matched: "Go" });
            }),
          });
          const controller = new BrowserController(makeFakeTarget(page));
          const promise = controller.act({ action: "click", target: "Go" });
          await vi.advanceTimersByTimeAsync(300);
          const result = await promise;
          // This fake's executeJavaScript is not signature-aware — it
          // returns the same click-shaped object for every call, including
          // the two signature captures — so before/after both fail
          // isPageSignature and captureSignature degrades to null for both.
          // Review finding 2: that must not silently report "no change" when
          // the URL plainly did (exactly the case a rejecting/malformed
          // signature capture during a cross-origin navigation swap is meant
          // to model) — diffSignatures falls back to the previousUrl/
          // currentUrl runClick already tracks, which is enough to report
          // "url" (title has no equivalent fallback, so it's not reported).
          expect(result).toEqual({
            url: "https://example.com/next",
            title: "Next",
            matched: "Go",
            via: "dom",
            changed: true,
            changes: ["url"],
          });
        } finally {
          vi.useRealTimers();
        }
      });

      it("finding 7: does not misreport when a click does not navigate", async () => {
        vi.useFakeTimers();
        try {
          const page = makeFakePage({
            getURL: vi.fn(() => "https://example.com/"),
            getTitle: vi.fn(() => "Example"),
            executeJavaScript: vi.fn(() =>
              Promise.resolve({ url: "https://example.com/", title: "Example", matched: "Go" }),
            ),
          });
          const controller = new BrowserController(makeFakeTarget(page));
          const promise = controller.act({ action: "click", target: "Go" });
          await vi.advanceTimersByTimeAsync(300);
          const result = await promise;
          expect(result).toEqual({
            url: "https://example.com/",
            title: "Example",
            matched: "Go",
            via: "dom",
            changed: false,
            changes: [],
          });
        } finally {
          vi.useRealTimers();
        }
      });

      // Finding 4 / addendum F ("Load, not commit"): the old settle wait
      // returned as soon as getURL() changed (navigation commit), not once
      // the document actually finished loading — a following
      // browse_find_images would then measure an unlaid-out document (every
      // getBoundingClientRect() 0x0) and a slow-to-commit navigation (>300ms)
      // would time out before ever seeing the new url/title at all.
      it("finding 4: waits for the navigated page to finish loading, not just for the url to change, before trusting the result", async () => {
        vi.useFakeTimers();
        try {
          let url = "https://example.com/";
          let title = "Example";
          let loading = false;
          const page = makeFakePage({
            getURL: vi.fn(() => url),
            getTitle: vi.fn(() => title),
            isLoading: vi.fn(() => loading),
            executeJavaScript: vi.fn(() => {
              // Commit happens quickly (well within the 300ms settle bound),
              // but the document keeps loading for a while after that.
              setTimeout(() => {
                url = "https://example.com/next";
                title = "Next (loading)";
                loading = true;
              }, 50);
              setTimeout(() => {
                title = "Next";
                loading = false;
              }, 1_000);
              return Promise.resolve({ url: "https://example.com/", title: "Example" });
            }),
          });
          const controller = new BrowserController(makeFakeTarget(page));
          const promise = controller.act({ action: "click", target: "Go" });
          await vi.advanceTimersByTimeAsync(1_050);
          const result = await promise;
          // Must trust the settled post-load title, not the mid-load one, and
          // not the pre-navigation one either. Review finding 2: as above,
          // this fake's executeJavaScript isn't signature-aware, so the diff
          // comes from the previousUrl/currentUrl fallback — it correctly
          // reports the navigation ("url") rather than "no change".
          expect(result).toEqual({
            url: "https://example.com/next",
            title: "Next",
            via: "dom",
            changed: true,
            changes: ["url"],
          });
        } finally {
          vi.useRealTimers();
        }
      });

      it("finding 4: a navigation whose url commit takes longer than the 300ms detection bound is still not misreported, because isLoading() flips true immediately", async () => {
        // Models real Electron: did-start-loading (isLoading() -> true) fires
        // essentially as soon as the navigation is requested, well before a
        // slow network response actually commits the new URL. Relying on
        // getURL() alone (the pre-fix behavior) would miss this navigation
        // entirely and return the stale pre-click url/title — the exact
        // "commit takes longer than 300ms" case from addendum F.
        vi.useFakeTimers();
        try {
          let url = "https://example.com/";
          let title = "Example";
          let loading = true; // isLoading() flips true right away
          const page = makeFakePage({
            getURL: vi.fn(() => url),
            getTitle: vi.fn(() => title),
            isLoading: vi.fn(() => loading),
            executeJavaScript: vi.fn(() => {
              // Commit (url/title change) doesn't land until 500ms — later
              // than CLICK_SETTLE_TIMEOUT_MS (300ms) — but the load finishes
              // (isLoading -> false) shortly after that.
              setTimeout(() => {
                url = "https://example.com/next";
                title = "Next";
              }, 500);
              setTimeout(() => {
                loading = false;
              }, 600);
              return Promise.resolve({ url: "https://example.com/", title: "Example" });
            }),
          });
          const controller = new BrowserController(makeFakeTarget(page));
          const promise = controller.act({ action: "click", target: "Go" });
          await vi.advanceTimersByTimeAsync(650);
          const result = await promise;
          // Review finding 2: see the comment on the first "finding 7" test
          // above — this fake's executeJavaScript isn't signature-aware
          // either, so the diff again comes from the previousUrl/currentUrl
          // fallback.
          expect(result).toEqual({
            url: "https://example.com/next",
            title: "Next",
            via: "dom",
            changed: true,
            changes: ["url"],
          });
        } finally {
          vi.useRealTimers();
        }
      });

      it("surfaces a page-reported error (element not found) as the result", async () => {
        const page = makeFakePage({
          executeJavaScript: vi.fn(() => Promise.resolve({ error: "No element matched: Buy now" })),
        });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = await controller.act({ action: "click", target: "Buy now" });
        expect(result).toEqual({ error: "No element matched: Buy now" });
      });

      it("resolves an error result when the page script throws", async () => {
        const page = makeFakePage({ executeJavaScript: vi.fn(() => Promise.reject(new Error("boom"))) });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = await controller.act({ action: "click", target: "Buy now" });
        expect(result).toHaveProperty("error");
        expect(String((result as { error: string }).error)).toContain("boom");
      });

      it("resolves an error when executeJavaScript returns a non-object", async () => {
        const page = makeFakePage({ executeJavaScript: vi.fn(() => Promise.resolve("not an object")) });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = await controller.act({ action: "click", target: "Buy now" });
        expect(result).toHaveProperty("error");
      });
    });

    describe("type", () => {
      it("requires target and text", async () => {
        const controller = new BrowserController(makeFakeTarget(makeFakePage()));
        expect(await controller.act({ action: "type", target: "Search" })).toHaveProperty("error");
        expect(await controller.act({ action: "type", text: "hello" })).toHaveProperty("error");
        expect(await controller.act({ action: "type", target: "Search", text: 5 })).toHaveProperty("error");
      });

      it("embeds target and text as JSON in the script", async () => {
        const page = makeFakePage();
        const controller = new BrowserController(makeFakeTarget(page));
        await controller.act({ action: "type", target: "Search", text: 'a "quoted" value' });
        const code = findScriptCall(page.executeJavaScript as ReturnType<typeof vi.fn>, JSON.stringify("Search"));
        expect(code).toContain(JSON.stringify("Search"));
        expect(code).toContain(JSON.stringify('a "quoted" value'));
      });

      // Finding 2: String.prototype.replace's *string* replacement form
      // treats $&, $`, $' and $$ as special patterns. A plain
      // `.replace(ARGS_MARKER, JSON.stringify(args))` call would silently
      // mangle (or, for $', truncate/splice) any of these sequences inside
      // a target/text value that came from an LLM tool call.
      it("does not interpret $& in text as a replacement pattern", async () => {
        const page = makeFakePage();
        const controller = new BrowserController(makeFakeTarget(page));
        await controller.act({ action: "type", target: "Price", text: "price is $&" });
        const code = findScriptCall(
          page.executeJavaScript as ReturnType<typeof vi.fn>,
          JSON.stringify({ target: "Price", text: "price is $&" }),
        );
        expect(code).toContain(JSON.stringify({ target: "Price", text: "price is $&" }));
      });

      it("does not interpret $` in target as a replacement pattern", async () => {
        const page = makeFakePage();
        const controller = new BrowserController(makeFakeTarget(page));
        await controller.act({ action: "click", target: "a$`b" });
        const code = findScriptCall(
          page.executeJavaScript as ReturnType<typeof vi.fn>,
          JSON.stringify({ target: "a$`b" }),
        );
        expect(code).toContain(JSON.stringify({ target: "a$`b" }));
      });

      it("does not let $' in target splice page source into the script (never breaks out of the JSON literal)", async () => {
        const page = makeFakePage();
        const controller = new BrowserController(makeFakeTarget(page));
        await controller.act({ action: "click", target: "$'" });
        const code = findScriptCall(page.executeJavaScript as ReturnType<typeof vi.fn>, JSON.stringify({ target: "$'" }));
        expect(code).toContain(JSON.stringify({ target: "$'" }));
        // The rest of the script (e.g. the findByText helper) must still be
        // present intact after the substitution point.
        expect(code).toContain("findByText");
      });

      it("does not interpret $$ in text as an escaped-dollar pattern", async () => {
        const page = makeFakePage();
        const controller = new BrowserController(makeFakeTarget(page));
        await controller.act({ action: "type", target: "Amount", text: "$$100" });
        const code = findScriptCall(
          page.executeJavaScript as ReturnType<typeof vi.fn>,
          JSON.stringify({ target: "Amount", text: "$$100" }),
        );
        expect(code).toContain(JSON.stringify({ target: "Amount", text: "$$100" }));
      });
    });

    describe("scroll", () => {
      it("defaults amount to 1", async () => {
        const page = makeFakePage();
        const controller = new BrowserController(makeFakeTarget(page));
        await controller.act({ action: "scroll" });
        const code = findScriptCall(page.executeJavaScript as ReturnType<typeof vi.fn>, JSON.stringify({ amount: 1 }));
        expect(code).toContain(JSON.stringify({ amount: 1 }));
      });

      it("rejects a non-number amount", async () => {
        const controller = new BrowserController(makeFakeTarget(makeFakePage()));
        const result = await controller.act({ action: "scroll", amount: "a lot" });
        expect(result).toHaveProperty("error");
      });

      it("passes a numeric amount through", async () => {
        const page = makeFakePage();
        const controller = new BrowserController(makeFakeTarget(page));
        await controller.act({ action: "scroll", amount: 2.5 });
        const code = findScriptCall(page.executeJavaScript as ReturnType<typeof vi.fn>, JSON.stringify({ amount: 2.5 }));
        expect(code).toContain(JSON.stringify({ amount: 2.5 }));
      });
    });

    describe("back / forward", () => {
      it("back calls goBack and reports the post-navigation url/title, with changed evidence for the navigation", async () => {
        const page = makeFakePage({ canGoBack: vi.fn(() => true) });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = await controller.act({ action: "back" });
        expect(page.goBack).toHaveBeenCalled();
        // The default fake's signature capture reflects the page's live
        // getURL()/getTitle(), so a real navigation is real evidence here —
        // "Addendum 2" §1.
        expect(result).toEqual({
          url: "https://example.com/back",
          title: "Example (back)",
          changed: true,
          changes: ["url", "title"],
          pageChanged: false,
          appeared: [],
        });
      });

      it("back errors cleanly when there is no history", async () => {
        const page = makeFakePage({ canGoBack: vi.fn(() => false) });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = await controller.act({ action: "back" });
        expect(page.goBack).not.toHaveBeenCalled();
        expect(result).toHaveProperty("error");
      });

      it("forward calls goForward when there is forward history, and reports the post-navigation url/title with changed evidence", async () => {
        const page = makeFakePage({ canGoForward: vi.fn(() => true) });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = await controller.act({ action: "forward" });
        expect(page.goForward).toHaveBeenCalled();
        expect(result).toEqual({
          url: "https://example.com/forward",
          title: "Example (forward)",
          changed: true,
          changes: ["url", "title"],
          pageChanged: false,
          appeared: [],
        });
      });

      // Finding 4: forward had no equivalent to back's canGoBack() guard —
      // with no forward history, goForward() silently no-ops, and
      // waitForUrlChange would burn its full wait before reporting success
      // on an unchanged page.
      it("forward errors cleanly when there is no forward history, without calling goForward", async () => {
        const page = makeFakePage({ canGoForward: vi.fn(() => false) });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = await controller.act({ action: "forward" });
        expect(page.goForward).not.toHaveBeenCalled();
        expect(result).toHaveProperty("error");
      });
    });

    it("times out a hung page script and resolves an error result", async () => {
      vi.useFakeTimers();
      try {
        const page = makeFakePage({ executeJavaScript: vi.fn(() => new Promise(() => {})) });
        // cursor: false — this test is about the plain command timeout, not
        // the cursor's budget extension (see the "cursor budget extension
        // (finding 1)" describe block below for that).
        const controller = new BrowserController(makeFakeTarget(page), { timeoutMs: 50, cursor: false });
        const promise = controller.act({ action: "click", target: "x" });
        await vi.advanceTimersByTimeAsync(60);
        const result = await promise;
        expect(result).toHaveProperty("error");
        expect(String((result as { error: string }).error)).toMatch(/timed out/i);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // jev-loop design doc "Addendum 2, 2026-09-19" §1: act/perform must
  // report `{ changed, changes }` alongside their existing return shape,
  // and `changed: false` must be a normal, reportable answer — never an
  // error. These use a signature-aware executeJavaScript override so the
  // before/after diff reflects a real (or genuinely absent) page change,
  // unlike most of the tests above whose fakes return a fixed shape for
  // every script and so always degrade to changed: false.
  // Browse-speed contract (2026-09-24): "pageChanged"/"appeared" — a
  // click can mutate a *different* element than the one it acted on (e.g.
  // "Add to Cart" updates a separate #cart-status text node after a fetch,
  // never the button itself), which is exactly the case `changed` reports
  // false for (the scoped/target signature is unaffected) even though the
  // page plainly did something a user would see. These fields are a
  // separate, report-only signal for that case, computed from the same
  // MutationObserver evidence SIGNATURE_JS already collects.
  describe("evidence of effect ('pageChanged'/'appeared')", () => {
    it("click reports pageChanged: true with the new text when a different element's text changes, even though changed is false", async () => {
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) =>
          isSignatureCall(code)
            ? Promise.resolve({
                url: "https://example.com/",
                title: "Example",
                nodeCount: 1,
                textLength: 1,
                textHash: 1,
                mainImageSrc: "",
                scrollY: 0,
                focusedValueLength: 0,
                pageChanged: true,
                appeared: ["Added to cart (1 item)", "Go to cart"],
              })
            : Promise.resolve({ url: "https://example.com/", title: "Example", matched: "Add to Cart" }),
        ),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.act({ action: "click", target: "Add to Cart" });
      expect(result).toMatchObject({
        changed: false,
        pageChanged: true,
        appeared: ["Added to cart (1 item)", "Go to cart"],
      });
    });

    it("click reports pageChanged: false, appeared: [] when nothing meaningful mutated", async () => {
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) =>
          isSignatureCall(code)
            ? Promise.resolve({
                url: "https://example.com/",
                title: "Example",
                nodeCount: 1,
                textLength: 0,
                textHash: 0,
                mainImageSrc: "",
                scrollY: 0,
                focusedValueLength: 0,
                pageChanged: false,
                appeared: [],
              })
            : Promise.resolve({ url: "https://example.com/", title: "Example", matched: "Go" }),
        ),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.act({ action: "click", target: "Go" });
      expect(result).toMatchObject({ changed: false, pageChanged: false, appeared: [] });
    });

    it("perform CLICK also carries pageChanged/appeared, computed the same way as act's click", async () => {
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) =>
          isSignatureCall(code)
            ? Promise.resolve({
                url: "https://example.com/",
                title: "Example",
                nodeCount: 1,
                textLength: 1,
                textHash: 1,
                mainImageSrc: "",
                scrollY: 0,
                focusedValueLength: 0,
                pageChanged: true,
                appeared: ["Order placed"],
              })
            : Promise.resolve({ url: "https://example.com/", title: "Example" }),
        ),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      const result = await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });
      expect(result).toMatchObject({ pageChanged: true, appeared: ["Order placed"] });
    });

    it("defaults pageChanged to false and appeared to [] when a legacy-shaped signature (predating these fields) is captured", async () => {
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) =>
          isSignatureCall(code)
            ? Promise.resolve({
                url: "https://example.com/",
                title: "Example",
                nodeCount: 1,
                textLength: 0,
                textHash: 0,
                mainImageSrc: "",
                scrollY: 0,
                focusedValueLength: 0,
              })
            : Promise.resolve({ url: "https://example.com/", title: "Example", matched: "Go" }),
        ),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.act({ action: "click", target: "Go" });
      expect(result).toMatchObject({ pageChanged: false, appeared: [] });
    });
  });

  describe("evidence of effect ('changed'/'changes')", () => {
    it("click reports changed: false, changes: [] when nothing about the page changed — not an error", async () => {
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) =>
          isSignatureCall(code)
            ? Promise.resolve({
                url: "https://example.com/",
                title: "Example",
                nodeCount: 42,
                textLength: 100,
                textHash: 555,
                mainImageSrc: "https://example.com/same.jpg",
                scrollY: 0,
                focusedValueLength: 0,
              })
            : Promise.resolve({ url: "https://example.com/", title: "Example", matched: "Go" }),
        ),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.act({ action: "click", target: "Go" });
      expect(result).not.toHaveProperty("error");
      expect(result).toMatchObject({ changed: false, changes: [] });
    });

    it("click reports changed: true with 'main-image' when the largest visible image swaps and nothing else does", async () => {
      let signatureCalls = 0;
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) => {
          if (isSignatureCall(code)) {
            signatureCalls += 1;
            return Promise.resolve({
              url: "https://example.com/",
              title: "Example",
              nodeCount: 42,
              textLength: 100,
              textHash: 555,
              mainImageSrc: signatureCalls === 1 ? "https://example.com/before.jpg" : "https://example.com/after.jpg",
              scrollY: 0,
              focusedValueLength: 0,
            });
          }
          return Promise.resolve({ url: "https://example.com/", title: "Example", matched: "Next" });
        }),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.act({ action: "click", target: "Next" });
      expect(result).toMatchObject({ changed: true, changes: ["main-image"] });
    });

    // Review finding 4: a whole-document text delta used to gate `changed`
    // on its own, but that's exactly the noise finding 4 exists to filter
    // out — a rotating carousel, a live price, or an injected ad moves
    // nodeCount/textLength/textHash between two captures milliseconds apart
    // with nothing the agent did causing it. "text" (and "dom") are still
    // reported in `changes` as useful context, but no longer set `changed`
    // by themselves; only url/title/main-image (identity-guarded)/scroll/
    // focused-value/the acted-on element's own scoped signature do. This
    // test used to assert the opposite (changed: true) — updated to match
    // the corrected semantics.
    it("click reports changed: false even though 'text' is in `changes`, when only the whole-document text delta moved (no navigation, no image change, no scoped-element change)", async () => {
      let signatureCalls = 0;
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) => {
          if (isSignatureCall(code)) {
            signatureCalls += 1;
            return Promise.resolve({
              url: "https://example.com/",
              title: "Example",
              nodeCount: 42,
              textLength: signatureCalls === 1 ? 100 : 140,
              textHash: signatureCalls === 1 ? 555 : 777,
              mainImageSrc: "",
              scrollY: 0,
              focusedValueLength: 0,
            });
          }
          return Promise.resolve({ url: "https://example.com/", title: "Example", matched: "Add to cart" });
        }),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.act({ action: "click", target: "Add to cart" });
      expect(result).toMatchObject({ changed: false, changes: ["text"] });
    });

    it("perform CLICK also carries changed evidence, computed the same way as act's click", async () => {
      let signatureCalls = 0;
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) => {
          if (isSignatureCall(code)) {
            signatureCalls += 1;
            return Promise.resolve({
              url: "https://example.com/",
              title: signatureCalls === 1 ? "Example" : "Example (after)",
              nodeCount: 10,
              textLength: 10,
              textHash: 10,
              mainImageSrc: "",
              scrollY: 0,
              focusedValueLength: 0,
            });
          }
          return Promise.resolve({ url: "https://example.com/", title: "Example" });
        }),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      const result = await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });
      expect(result).toMatchObject({ changed: true, changes: ["title"] });
    });

    it("perform SCROLL_DOWN with no real page change reports changed: false, not an error", async () => {
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) =>
          isSignatureCall(code)
            ? Promise.resolve({
                url: "https://example.com/",
                title: "Example",
                nodeCount: 10,
                textLength: 10,
                textHash: 10,
                mainImageSrc: "",
                scrollY: 0,
                focusedValueLength: 0,
              })
            : Promise.resolve({ url: "https://example.com/", title: "Example" }),
        ),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      const result = await controller.perform({ snapshotId: snapshot.snapshotId, operation: "SCROLL_DOWN" });
      expect(result).not.toHaveProperty("error");
      expect(result).toMatchObject({ changed: false, changes: [] });
    });

    it("a signature-capture failure (executeJavaScript rejects) degrades to changed: false rather than turning a successful action into an error", async () => {
      let signatureCalls = 0;
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) => {
          if (isSignatureCall(code)) {
            signatureCalls += 1;
            return Promise.reject(new Error("signature capture boom"));
          }
          return Promise.resolve({ url: "https://example.com/", title: "Example", matched: "Go" });
        }),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.act({ action: "click", target: "Go" });
      expect(result).not.toHaveProperty("error");
      expect(result).toMatchObject({ changed: false, changes: [] });
      expect(signatureCalls).toBeGreaterThan(0);
    });

    // Review finding 4: the acted-on element's own scoped signature (via
    // CLICK_JS's `__scopedBefore` + SIGNATURE_JS's `scopedAfter`) must gate
    // `changed` even while the whole-document dom/text noise moves too —
    // dom/text alone (asserted above) must not, but a real per-element
    // change must, regardless of what else is moving around it.
    it("click reports changed: true via the scoped target signature (aria-expanded flip) even while dom/text noise moves around it", async () => {
      let signatureCalls = 0;
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) => {
          if (isSignatureCall(code)) {
            signatureCalls += 1;
            return Promise.resolve({
              url: "https://example.com/",
              title: "Example",
              // Whole-document noise moves on every call — a carousel/ad —
              // but must not by itself set changed (see the "text" test
              // above); it's the scopedAfter diff that should.
              nodeCount: signatureCalls,
              textLength: signatureCalls,
              textHash: signatureCalls,
              mainImageSrc: "",
              scrollY: 0,
              focusedValueLength: 0,
              scopedAfter:
                signatureCalls === 1
                  ? undefined
                  : { nodeCount: 3, textHash: 9, src: "", valueLength: 0, ariaExpanded: "true", ariaSelected: "", checked: false },
            });
          }
          return Promise.resolve({
            url: "https://example.com/",
            title: "Example",
            matched: "Menu",
            __scopedBefore: { nodeCount: 3, textHash: 9, src: "", valueLength: 0, ariaExpanded: "false", ariaSelected: "", checked: false },
          });
        }),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.act({ action: "click", target: "Menu" });
      expect(result).toMatchObject({ changed: true, changes: expect.arrayContaining(["dom", "text", "target"]) });
      // The internal marker field must never leak into the caller-visible result.
      expect(result).not.toHaveProperty("__scopedBefore");
    });

    // Review finding 4 (main-image identity guard): the largest visible
    // image can change identity between captures (an ad finishes loading
    // and is now bigger than the real photo) without the *original* image's
    // own src having changed at all — that must not be reported as
    // "main-image" changed, since nothing the click did moved that element.
    it("click does not report 'main-image' when a newly-loaded element becomes the largest visible image but the originally-tracked image's own src is unchanged", async () => {
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) =>
          isSignatureCall(code)
            ? Promise.resolve({
                url: "https://example.com/",
                title: "Example",
                nodeCount: 10,
                textLength: 10,
                textHash: 10,
                // SIGNATURE_JS's own identity marker means "after" always
                // re-reads the *same* element "before" marked as largest —
                // this fake models that directly: the src never changes.
                mainImageSrc: "https://example.com/original.jpg",
                scrollY: 0,
                focusedValueLength: 0,
              })
            : Promise.resolve({ url: "https://example.com/", title: "Example", matched: "Load ad" }),
        ),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.act({ action: "click", target: "Load ad" });
      expect(result).toMatchObject({ changed: false, changes: [] });
    });

    // Review finding 3: scroll used to have no field in the signature that
    // moved when it succeeded, and no settle before the after-capture —
    // indistinguishable from scrolling a dead page. scrollY is now part of
    // the signature and gates `changed` on its own (it doesn't drift on its
    // own the way dom/text can, so it's trustworthy evidence, not noise).
    it("act scroll reports changed: true via scrollY moving, and waits for the settle before capturing 'after'", async () => {
      let signatureCalls = 0;
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) =>
          isSignatureCall(code)
            ? Promise.resolve({
                url: "https://example.com/",
                title: "Example",
                nodeCount: 10,
                textLength: 10,
                textHash: 10,
                mainImageSrc: "",
                scrollY: signatureCalls++ === 0 ? 0 : 600,
                focusedValueLength: 0,
              })
            : Promise.resolve({ url: "https://example.com/", title: "Example" }),
        ),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.act({ action: "scroll", amount: 1 });
      expect(result).toMatchObject({ changed: true, changes: ["scroll"] });
    });

    it("act scroll with no real scroll movement reports changed: false, not an error", async () => {
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) =>
          isSignatureCall(code)
            ? Promise.resolve({
                url: "https://example.com/",
                title: "Example",
                nodeCount: 10,
                textLength: 10,
                textHash: 10,
                mainImageSrc: "",
                scrollY: 0,
                focusedValueLength: 0,
              })
            : Promise.resolve({ url: "https://example.com/", title: "Example" }),
        ),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.act({ action: "scroll", amount: 1 });
      expect(result).not.toHaveProperty("error");
      expect(result).toMatchObject({ changed: false, changes: [] });
    });

    // Review finding 3: typing into a field used to report changed: false
    // unconditionally (nothing in the signature moved for it) — the scoped
    // target signature (TYPE_JS marks the field and reports its own
    // valueLength, same mechanism as CLICK_JS) is what now makes a
    // successful type distinguishable from typing into a dead field.
    it("act type reports changed: true via the scoped target's valueLength, even with no document-wide change", async () => {
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) =>
          isSignatureCall(code)
            ? Promise.resolve({
                url: "https://example.com/",
                title: "Example",
                nodeCount: 10,
                textLength: 10,
                textHash: 10,
                mainImageSrc: "",
                scrollY: 0,
                focusedValueLength: 0,
                scopedAfter: { nodeCount: 1, textHash: 0, src: "", valueLength: 5, ariaExpanded: "", ariaSelected: "", checked: false },
              })
            : Promise.resolve({
                url: "https://example.com/",
                title: "Example",
                matched: "Search",
                __scopedBefore: { nodeCount: 1, textHash: 0, src: "", valueLength: 0, ariaExpanded: "", ariaSelected: "", checked: false },
              }),
        ),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.act({ action: "type", target: "Search", text: "hello" });
      expect(result).toMatchObject({ changed: true, changes: ["target"] });
    });
  });

  describe("findImages", () => {
    let page: BrowserPageHandle;
    let controller: BrowserController;

    beforeEach(() => {
      page = makeFakePage({
        executeJavaScript: vi.fn(() =>
          Promise.resolve({
            images: [{ url: "https://x/a.jpg", alt: "", width: 400, height: 300 }],
            count: 1,
            pageUrl: "https://example.com/",
          }),
        ),
      });
      controller = new BrowserController(makeFakeTarget(page));
    });

    it("uses default minWidth/minHeight/limit when no args are given", async () => {
      await controller.findImages(undefined);
      const code = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(code).toContain(JSON.stringify({ minWidth: 200, minHeight: 200, limit: 30 }));
    });

    it("passes through provided minWidth/minHeight/limit", async () => {
      await controller.findImages({ minWidth: 50, minHeight: 60, limit: 5 });
      const code = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(code).toContain(JSON.stringify({ minWidth: 50, minHeight: 60, limit: 5 }));
    });

    it("hard-caps limit at 100 even if a larger value is requested", async () => {
      await controller.findImages({ limit: 5000 });
      const code = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(code).toContain(JSON.stringify({ minWidth: 200, minHeight: 200, limit: 100 }));
    });

    it("rejects a non-numeric minWidth", async () => {
      const result = await controller.findImages({ minWidth: "big" });
      expect(result).toHaveProperty("error");
    });

    it("rejects a negative minHeight", async () => {
      const result = await controller.findImages({ minHeight: -1 });
      expect(result).toHaveProperty("error");
    });

    it("rejects array/string arguments", async () => {
      expect(await controller.findImages([1, 2])).toHaveProperty("error");
      expect(await controller.findImages("nope")).toHaveProperty("error");
    });

    it("returns the page script's result on success", async () => {
      const result = await controller.findImages({});
      expect(result).toEqual({
        images: [{ url: "https://x/a.jpg", alt: "", width: 400, height: 300 }],
        count: 1,
        pageUrl: "https://example.com/",
      });
    });

    it("errors cleanly when no browser tab is open", async () => {
      const noPageController = new BrowserController(makeFakeTarget(null));
      const result = await noPageController.findImages({});
      expect(result).toHaveProperty("error");
    });
  });

  // jev-loop design doc "Addendum 2, 2026-09-19" §2.
  describe("read", () => {
    it("rejects array/string arguments", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      expect(await controller.read([1, 2])).toHaveProperty("error");
      expect(await controller.read("nope")).toHaveProperty("error");
    });

    it("rejects a non-positive or non-numeric maxChars", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      expect(await controller.read({ maxChars: 0 })).toHaveProperty("error");
      expect(await controller.read({ maxChars: -5 })).toHaveProperty("error");
      expect(await controller.read({ maxChars: "big" })).toHaveProperty("error");
    });

    it("rejects an empty/non-string selector", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      expect(await controller.read({ selector: "" })).toHaveProperty("error");
      expect(await controller.read({ selector: "   " })).toHaveProperty("error");
      expect(await controller.read({ selector: 5 })).toHaveProperty("error");
    });

    it("defaults maxChars to 6000 and selector to null when no args are given", async () => {
      const page = makeFakePage();
      const controller = new BrowserController(makeFakeTarget(page));
      await controller.read(undefined);
      const code = findScriptCall(
        page.executeJavaScript as ReturnType<typeof vi.fn>,
        JSON.stringify({ maxChars: 6000, selector: null }),
      );
      expect(code).toContain(JSON.stringify({ maxChars: 6000, selector: null }));
    });

    it("passes a provided selector through", async () => {
      const page = makeFakePage();
      const controller = new BrowserController(makeFakeTarget(page));
      await controller.read({ selector: "#main" });
      const code = findScriptCall(
        page.executeJavaScript as ReturnType<typeof vi.fn>,
        JSON.stringify({ maxChars: 6000, selector: "#main" }),
      );
      expect(code).toContain(JSON.stringify({ maxChars: 6000, selector: "#main" }));
    });

    // Hard cap: 20000, regardless of what the caller asks for.
    it("clamps a requested maxChars above the 20000 hard cap", async () => {
      const page = makeFakePage();
      const controller = new BrowserController(makeFakeTarget(page));
      await controller.read({ maxChars: 999_999 });
      const code = findScriptCall(
        page.executeJavaScript as ReturnType<typeof vi.fn>,
        JSON.stringify({ maxChars: 20_000, selector: null }),
      );
      expect(code).toContain(JSON.stringify({ maxChars: 20_000, selector: null }));
    });

    it("accepts a requested maxChars under the hard cap unchanged", async () => {
      const page = makeFakePage();
      const controller = new BrowserController(makeFakeTarget(page));
      await controller.read({ maxChars: 500 });
      const code = findScriptCall(
        page.executeJavaScript as ReturnType<typeof vi.fn>,
        JSON.stringify({ maxChars: 500, selector: null }),
      );
      expect(code).toContain(JSON.stringify({ maxChars: 500, selector: null }));
    });

    it("returns the page script's digest on success", async () => {
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) =>
          isSignatureCall(code)
            ? Promise.resolve({ ok: true })
            : Promise.resolve({
                url: "https://example.com/",
                title: "Example",
                headings: ["Welcome"],
                text: "Hello world",
                links: [{ label: "Home", href: "https://example.com/" }],
                truncated: false,
              }),
        ),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.read({});
      expect(result).toEqual({
        url: "https://example.com/",
        title: "Example",
        headings: ["Welcome"],
        text: "Hello world",
        links: [{ label: "Home", href: "https://example.com/" }],
        truncated: false,
      });
    });

    // "A selector that matches nothing is an error, not a silent whole-page
    // read" — the page script itself decides this (READ_JS returns
    // { error } rather than falling back), and the controller must surface
    // it verbatim rather than widening the read.
    it("surfaces the page script's selector-miss error rather than falling back to a whole-page read", async () => {
      const page = makeFakePage({
        executeJavaScript: vi.fn(() =>
          Promise.resolve({ error: 'browse_read: no element matched selector "#nope"' }),
        ),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.read({ selector: "#nope" });
      expect(result).toEqual({ error: 'browse_read: no element matched selector "#nope"' });
    });

    it("errors cleanly when no browser tab is open", async () => {
      const controller = new BrowserController(makeFakeTarget(null));
      const result = await controller.read({});
      expect(result).toHaveProperty("error");
    });
  });

  describe("snapshot", () => {
    it("runs SNAPSHOT_JS and returns the page's result with a freshly minted snapshotId", async () => {
      const page = makeFakePage({
        executeJavaScript: vi.fn(() =>
          Promise.resolve({
            url: "https://example.com/",
            title: "Example",
            elements: [{ index: 0, tag: "button", label: "Go", ops: ["CLICK"] }],
            scroll: { y: 0, height: 1000, atBottom: false },
          }),
        ),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = (await controller.snapshot()) as { snapshotId: string; elements: unknown[] };
      expect(page.executeJavaScript).toHaveBeenCalledTimes(1);
      const code = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(code).not.toContain("PEN_BROWSER_ARGS");
      expect(typeof result.snapshotId).toBe("string");
      expect(result.snapshotId.length).toBeGreaterThan(0);
      expect(result.elements).toEqual([{ index: 0, tag: "button", label: "Go", ops: ["CLICK"] }]);
    });

    it("embeds the generated snapshotId and MAX_SNAPSHOT_ELEMENTS as the script's args", async () => {
      const page = makeFakePage();
      const controller = new BrowserController(makeFakeTarget(page));
      const result = (await controller.snapshot()) as { snapshotId: string };
      const code = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(code).toContain(JSON.stringify(result.snapshotId));
      expect(code).toContain(JSON.stringify({ snapshotId: result.snapshotId, maxElements: 120 }));
    });

    it("errors cleanly when no browser tab is open", async () => {
      const controller = new BrowserController(makeFakeTarget(null));
      const result = await controller.snapshot();
      expect(result).toHaveProperty("error");
    });

    it("times out and resolves an error result if the page script never settles", async () => {
      vi.useFakeTimers();
      try {
        const page = makeFakePage({ executeJavaScript: vi.fn(() => new Promise(() => {})) });
        const controller = new BrowserController(makeFakeTarget(page), { timeoutMs: 50 });
        const promise = controller.snapshot();
        await vi.advanceTimersByTimeAsync(60);
        const result = await promise;
        expect(result).toHaveProperty("error");
        expect(String((result as { error: string }).error)).toMatch(/timed out/i);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("perform", () => {
    it("rejects malformed arguments", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      expect(await controller.perform(undefined)).toHaveProperty("error");
      expect(await controller.perform(null)).toHaveProperty("error");
      expect(await controller.perform("nope")).toHaveProperty("error");
      expect(await controller.perform([1])).toHaveProperty("error");
    });

    it("rejects a missing/non-string snapshotId", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      const result = await controller.perform({ index: 0, operation: "CLICK" });
      expect(result).toHaveProperty("error");
      expect(String((result as { error: string }).error)).toMatch(/snapshotId/i);
    });

    it("rejects a non-integer or negative index", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      expect(
        await controller.perform({ snapshotId: snapshot.snapshotId, index: -1, operation: "CLICK" }),
      ).toHaveProperty("error");
      expect(
        await controller.perform({ snapshotId: snapshot.snapshotId, index: 1.5, operation: "CLICK" }),
      ).toHaveProperty("error");
      expect(
        await controller.perform({ snapshotId: snapshot.snapshotId, index: "0", operation: "CLICK" }),
      ).toHaveProperty("error");
    });

    it("rejects an unknown operation", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      const result = await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "TELEPORT" });
      expect(result).toHaveProperty("error");
    });

    it("requires text for TYPE_TEXT and SELECT", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      expect(
        await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "TYPE_TEXT" }),
      ).toHaveProperty("error");
      expect(
        await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "SELECT" }),
      ).toHaveProperty("error");
    });

    // Finding 6 / addendum A: index is required only for CLICK/TYPE_TEXT/
    // SELECT — SCROLL_UP/SCROLL_DOWN act on the page itself and must be
    // accepted with no index at all, or scrolling always fails at the
    // bridge, breaking the advertised infinite-scroll-grid mechanism.
    it("finding 6: accepts SCROLL_UP/SCROLL_DOWN with no index at all", async () => {
      const page = makeFakePage({ executeJavaScript: vi.fn(() => Promise.resolve({ url: "https://x/", title: "X" })) });
      const controller = new BrowserController(makeFakeTarget(page));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      const down = await controller.perform({ snapshotId: snapshot.snapshotId, operation: "SCROLL_DOWN" });
      expect(down).not.toHaveProperty("error");
      const up = await controller.perform({ snapshotId: snapshot.snapshotId, operation: "SCROLL_UP" });
      expect(up).not.toHaveProperty("error");
      // The script args sent must not carry a garbage/undefined index.
      const lastCode = findScriptCall(
        page.executeJavaScript as ReturnType<typeof vi.fn>,
        JSON.stringify({ snapshotId: snapshot.snapshotId, operation: "SCROLL_UP" }),
      );
      expect(lastCode).toContain(JSON.stringify({ snapshotId: snapshot.snapshotId, operation: "SCROLL_UP" }));
    });

    it("still requires index for CLICK/TYPE_TEXT/SELECT", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      expect(await controller.perform({ snapshotId: snapshot.snapshotId, operation: "CLICK" })).toHaveProperty("error");
      expect(
        await controller.perform({ snapshotId: snapshot.snapshotId, operation: "TYPE_TEXT", text: "hi" }),
      ).toHaveProperty("error");
      expect(
        await controller.perform({ snapshotId: snapshot.snapshotId, operation: "SELECT", text: "hi" }),
      ).toHaveProperty("error");
    });

    it("rejects a stale snapshotId (never having taken a snapshot)", async () => {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      const result = await controller.perform({ snapshotId: "made-up-id", index: 0, operation: "CLICK" });
      expect(result).toHaveProperty("error");
      expect(String((result as { error: string }).error)).toMatch(/stale|unknown/i);
    });

    it("rejects a snapshotId superseded by a newer snapshot() call — the one way the indexed design can go quietly wrong", async () => {
      const page = makeFakePage();
      const controller = new BrowserController(makeFakeTarget(page));
      const firstSnapshot = (await controller.snapshot()) as { snapshotId: string };
      await controller.snapshot(); // supersedes firstSnapshot's id
      const result = await controller.perform({
        snapshotId: firstSnapshot.snapshotId,
        index: 0,
        operation: "CLICK",
      });
      expect(result).toHaveProperty("error");
      expect(String((result as { error: string }).error)).toMatch(/stale|unknown/i);
      // Must not have even attempted to run a page script for the stale call.
      expect(page.executeJavaScript).toHaveBeenCalledTimes(2); // the two snapshot() calls only
    });

    it("runs PERFORM_JS with the validated args once the snapshotId matches", async () => {
      // CLICK's settle logic (below) always trusts page.getURL()/getTitle()
      // for the final result over the script's own report, so this fake's
      // getURL/getTitle are set to match what the script returns.
      const page = makeFakePage({
        getURL: vi.fn(() => "https://x/"),
        getTitle: vi.fn(() => "X"),
        executeJavaScript: vi.fn(() => Promise.resolve({ url: "https://x/", title: "X" })),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      const result = await controller.perform({ snapshotId: snapshot.snapshotId, index: 3, operation: "CLICK" });
      // This fake's executeJavaScript ignores which script it was called
      // with, so neither before/after signature capture (see makeFakePage's
      // doc comment) sees a valid signature here — changed stays false. The
      // canned response also has no `hitOk`, so dispatchClick falls back to
      // the DOM path (PERFORM_JS's CLICK branch) — via: "dom".
      expect(result).toEqual({ url: "https://x/", title: "X", via: "dom", changed: false, changes: [] });
      const code = findScriptCall(
        page.executeJavaScript as ReturnType<typeof vi.fn>,
        JSON.stringify({ snapshotId: snapshot.snapshotId, index: 3, operation: "CLICK" }),
      );
      // JSON.stringify drops an `undefined` property (text is omitted for CLICK).
      expect(code).toContain(JSON.stringify({ snapshotId: snapshot.snapshotId, index: 3, operation: "CLICK" }));
    });

    it("passes the snapshot fingerprint in CLICK's resolve/perform script args — none for a positional-label or scroll-container entry", async () => {
      const snapshotResult = {
        url: "https://x/",
        title: "X",
        elements: [
          { index: 0, tag: "button", label: "Find", ops: ["CLICK"], role: "button" },
          { index: 1, tag: "div", label: "div #1", ops: ["CLICK"] },
          { index: 2, tag: "div", label: "Results list", ops: [], scrollable: true },
        ],
        scroll: { y: 0, height: 1000, atBottom: false },
      };
      let snapshotId = "";
      const exec = vi.fn((code: string) =>
        Promise.resolve(code.includes("scrollContainerBudget") ? snapshotResult : { url: "https://x/", title: "X" }),
      );
      const page = makeFakePage({
        getURL: vi.fn(() => "https://x/"),
        getTitle: vi.fn(() => "X"),
        executeJavaScript: exec as unknown as BrowserPageHandle["executeJavaScript"],
      });
      const controller = new BrowserController(makeFakeTarget(page));
      snapshotId = ((await controller.snapshot()) as { snapshotId: string }).snapshotId;
      const fpJson = '"fingerprint":{"tag":"button","label":"Find","role":"button"}';
      const callsFor = (index: number) =>
        exec.mock.calls.map((c) => c[0] as string).filter((c) => c.includes(`"index":${index}`) && c.includes('"snapshotId"'));

      await controller.perform({ snapshotId, index: 0, operation: "CLICK" });
      const zero = callsFor(0);
      // Both the resolve step (CLICK_RESOLVE_JS) and the DOM fallback (PERFORM_JS) carry it.
      expect(zero.filter((c) => c.includes(fpJson)).length).toBeGreaterThanOrEqual(2);

      exec.mockClear();
      await controller.perform({ snapshotId, index: 1, operation: "CLICK" });
      await controller.perform({ snapshotId, index: 2, operation: "CLICK" });
      const later = [...callsFor(1), ...callsFor(2)];
      expect(later.length).toBeGreaterThan(0);
      expect(later.every((c) => !c.includes('"fingerprint":'))).toBe(true);
    });

    it("stores no fingerprint for entries whose tag/label/role occurs more than once in the snapshot", async () => {
      const snapshotResult = {
        url: "https://x/",
        title: "X",
        elements: [
          { index: 0, tag: "button", label: "Remove", ops: ["CLICK"] },
          { index: 1, tag: "button", label: "Remove", ops: ["CLICK"] },
          { index: 2, tag: "button", label: "Save", ops: ["CLICK"] },
        ],
        scroll: { y: 0, height: 1000, atBottom: false },
      };
      const exec = vi.fn((code: string) =>
        Promise.resolve(code.includes("scrollContainerBudget") ? snapshotResult : { url: "https://x/", title: "X" }),
      );
      const page = makeFakePage({
        getURL: vi.fn(() => "https://x/"),
        getTitle: vi.fn(() => "X"),
        executeJavaScript: exec as unknown as BrowserPageHandle["executeJavaScript"],
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const { snapshotId } = (await controller.snapshot()) as { snapshotId: string };
      await controller.perform({ snapshotId, index: 0, operation: "CLICK" });
      await controller.perform({ snapshotId, index: 1, operation: "CLICK" });
      const withIdx = (i: number) =>
        exec.mock.calls.map((c) => c[0] as string).filter((c) => c.includes(`"index":${i}`) && c.includes('"snapshotId"'));
      expect(withIdx(0).length + withIdx(1).length).toBeGreaterThan(0);
      expect([...withIdx(0), ...withIdx(1)].every((c) => !c.includes('"fingerprint":'))).toBe(true);
      await controller.perform({ snapshotId, index: 2, operation: "CLICK" });
      expect(withIdx(2).some((c) => c.includes('"fingerprint":{"tag":"button","label":"Save"}'))).toBe(true);
    });

    it("CLICK reuses the click-settle wait: trusts the post-navigation url/title over the script's stale pre-navigation read", async () => {
      vi.useFakeTimers();
      try {
        let url = "https://example.com/";
        let title = "Example";
        const page = makeFakePage({
          getURL: vi.fn(() => url),
          getTitle: vi.fn(() => title),
          executeJavaScript: vi.fn(() => {
            setTimeout(() => {
              url = "https://example.com/next";
              title = "Next";
            }, 50);
            return Promise.resolve({ url: "https://example.com/", title: "Example" });
          }),
        });
        const controller = new BrowserController(makeFakeTarget(page));
        const snapshot = (await controller.snapshot()) as { snapshotId: string };
        const promise = controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });
        await vi.advanceTimersByTimeAsync(300);
        const result = await promise;
        // Review finding 2: this fake's executeJavaScript isn't
        // signature-aware, so before/after both degrade to null and the
        // diff comes from the previousUrl/currentUrl fallback — see the
        // "finding 7"/"finding 4" comments in the act/click tests above for
        // the full explanation.
        expect(result).toEqual({
          url: "https://example.com/next",
          title: "Next",
          via: "dom",
          changed: true,
          changes: ["url"],
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("surfaces a page-reported error (element not found) as the result", async () => {
      // Five executeJavaScript calls before PERFORM_JS's error is reached:
      // snapshot()'s SNAPSHOT_JS, perform()'s reveal call, its cursor call,
      // its before-signature capture, then PERFORM_JS itself — an error result
      // short-circuits before the after-signature capture, so no fifth
      // call/entry is needed.
      const executeJavaScript = vi
        .fn()
        .mockResolvedValueOnce({
          url: "https://example.com/",
          title: "Example",
          elements: [],
          scroll: { y: 0, height: 0, atBottom: true },
        })
        .mockResolvedValueOnce({ found: false }) // REVEAL_TARGET_JS (best-effort; harmless)
        .mockResolvedValueOnce({ moved: false }) // cursor call (no valid x/y; harmless)
        .mockResolvedValueOnce({ url: "https://example.com/", title: "Example" }) // before-signature (not a valid one; harmless)
        .mockResolvedValueOnce({ error: "No element at index 0 for this snapshot." });
      const page = makeFakePage({ executeJavaScript });
      const controller = new BrowserController(makeFakeTarget(page));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      const result = await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });
      expect(result).toEqual({ error: "No element at index 0 for this snapshot." });
    });

    // Finding 5: lastSnapshotId used to be a bare string, justified by
    // "there is only ever one browser tab" — but File ▸ New Browser Tab and
    // popups both make more than one possible. If the active/most-recent
    // browser tab changes between snapshot() and perform(), a cross-tab
    // perform must fail with an accurate error instead of passing the
    // staleness check (same id) and only then failing in-page against the
    // wrong tab's DOM with a misleading "no element" message.
    it("finding 5 (two-browser-tab case): a perform against a different tab than the one snapshot() ran on fails with an accurate cross-tab error", async () => {
      const pageA = makeFakePage({ getURL: vi.fn(() => "https://a.example/") });
      const pageB = makeFakePage({ getURL: vi.fn(() => "https://b.example/") });
      let current: BrowserPageHandle | null = pageA;
      const target: BrowserTarget = {
        ensurePage: async () => current!,
        currentPage: () => current,
      };
      const controller = new BrowserController(target);
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      expect(pageA.executeJavaScript).toHaveBeenCalledTimes(1);

      // The user (or a popup handler) switches the active/most-recent
      // browser tab to B before the agent's perform() call lands.
      current = pageB;
      const result = await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });

      expect(result).toHaveProperty("error");
      expect(String((result as { error: string }).error)).toMatch(/tab/i);
      // Must never have attempted to run PERFORM_JS against tab B's DOM —
      // the failure is the controller's staleness check, not an in-page
      // "no element" lookup miss.
      expect(pageB.executeJavaScript).not.toHaveBeenCalled();
    });

    it("finding 5: a perform against the same tab snapshot() ran on still succeeds when a second browser tab exists", async () => {
      const pageA = makeFakePage({
        getURL: vi.fn(() => "https://a.example/"),
        getTitle: vi.fn(() => "A"),
        executeJavaScript: vi.fn(() => Promise.resolve({ url: "https://a.example/", title: "A" })),
      });
      const pageB = makeFakePage({ getURL: vi.fn(() => "https://b.example/") });
      const current: BrowserPageHandle | null = pageA;
      const target: BrowserTarget = {
        ensurePage: async () => current!,
        currentPage: () => current,
      };
      const controller = new BrowserController(target);
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      void pageB; // exists in the strip but is never the active/current page here
      const result = await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "SCROLL_DOWN" });
      expect(result).not.toHaveProperty("error");
    });

    it("errors cleanly when no browser tab is open at perform time, even with a valid snapshotId", async () => {
      const page = makeFakePage();
      const target = makeFakeTarget(page);
      const controller = new BrowserController(target);
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      // Simulate the tab having gone away between snapshot() and perform().
      target.currentPage = () => null;
      const result = await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });
      expect(result).toHaveProperty("error");
    });

    it("times out a hung page script and resolves an error result", async () => {
      vi.useFakeTimers();
      try {
        const page = makeFakePage({ executeJavaScript: vi.fn(() => Promise.resolve({ ok: true })) });
        // cursor: false — see the sibling "act" timeout test's comment above.
        const controller = new BrowserController(makeFakeTarget(page), { timeoutMs: 50, cursor: false });
        const snapshot = (await controller.snapshot()) as { snapshotId: string };
        (page.executeJavaScript as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));
        const promise = controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "SCROLL_DOWN" });
        await vi.advanceTimersByTimeAsync(60);
        const result = await promise;
        expect(result).toHaveProperty("error");
        expect(String((result as { error: string }).error)).toMatch(/timed out/i);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("open's own timeout budget", () => {
  // Measured against the live site 2026-09-19: an amazon.com search stalled
  // past the 20s command budget in roughly one run in four, while the rest
  // finished in ~2s. The DOM-ready race cannot help there — when the server
  // is slow the document itself hasn't arrived, so `dom-ready` hasn't fired
  // and there is nothing to race. A navigation simply needs longer than a
  // script evaluation against an existing page.
  it("gives open a longer default budget than every other command", () => {
    expect(BROWSER_OPEN_TIMEOUT_MS).toBeGreaterThan(BROWSER_COMMAND_TIMEOUT_MS);
  });

  it("uses that longer budget for open by default", async () => {
    vi.useFakeTimers();
    try {
      const page = makeFakePage({
        // Neither ever settles: the command can only end by timing out.
        loadURL: vi.fn(() => new Promise<void>(() => {})),
        onceDomReady: vi.fn(() => new Promise<void>(() => {})),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const pending = controller.open({ url: "https://example.com/" });
      await vi.advanceTimersByTimeAsync(BROWSER_COMMAND_TIMEOUT_MS + 1_000);
      // Still running well past the ordinary command budget.
      let settled = false;
      void pending.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(BROWSER_OPEN_TIMEOUT_MS);
      const result = await pending;
      expect(JSON.stringify(result)).toMatch(String(BROWSER_OPEN_TIMEOUT_MS));
    } finally {
      vi.useRealTimers();
    }
  });

  it("an explicitly supplied timeoutMs still bounds open — a caller asking for a short budget means it", async () => {
    vi.useFakeTimers();
    try {
      const page = makeFakePage({
        loadURL: vi.fn(() => new Promise<void>(() => {})),
        onceDomReady: vi.fn(() => new Promise<void>(() => {})),
      });
      const controller = new BrowserController(makeFakeTarget(page), { timeoutMs: 5_000 });
      const pending = controller.open({ url: "https://example.com/" });
      await vi.advanceTimersByTimeAsync(5_100);
      expect(JSON.stringify(await pending)).toMatch("5000");
    } finally {
      vi.useRealTimers();
    }
  });
});

// Upstream jev-ultrafast PR #58, ported: a control that disables itself
// while its handler runs used to defeat the very next observation — the
// acted control is `:disabled` (so SNAPSHOT_JS skips it), the controls the
// handler will enable are not there yet, and the model is offered neither.
// The acting script now reports `__targetSelfDisabled` and the action waits
// (bounded) for the control to come back before capturing "after".
describe("self-disabling control", () => {
  /** TARGET_BUSY_JS is the only script whose body contains this literal. */
  function isBusyCall(code: unknown): boolean {
    return typeof code === "string" && code.includes("present: false");
  }

  function makeBusyPage(busyAnswers: boolean[], selfDisabled = true) {
    const order: string[] = [];
    let busyCalls = 0;
    const page = makeFakePage({
      executeJavaScript: vi.fn((code: string) => {
        if (isSignatureCall(code)) {
          order.push("signature");
          return Promise.resolve({
            url: "https://example.com/",
            title: "Example",
            nodeCount: 1,
            textLength: 0,
            textHash: 0,
            mainImageSrc: "",
            scrollY: 0,
            focusedValueLength: 0,
          });
        }
        if (isBusyCall(code)) {
          const busy = busyAnswers[Math.min(busyCalls, busyAnswers.length - 1)];
          busyCalls++;
          order.push(`busy:${busy}`);
          return Promise.resolve({ present: true, busy });
        }
        order.push("action");
        return Promise.resolve({
          url: "https://example.com/",
          title: "Example",
          __targetSelfDisabled: selfDisabled,
        });
      }),
    });
    return { page, order, busyCalls: () => busyCalls };
  }

  it("waits for the acted control to stop being busy before capturing the after state", async () => {
    vi.useFakeTimers();
    try {
      const { page, order } = makeBusyPage([true, true, false]);
      const controller = new BrowserController(makeFakeTarget(page));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      const promise = controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });
      // Past the busy polls AND the late-effect re-check (nothing changes in
      // this fake, so the click keeps re-capturing until that cap).
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await promise;

      // The busy polls sit between the action and the after-capture, and the
      // after-capture only runs once the control reported itself free.
      expect(order.slice(order.lastIndexOf("action"), order.lastIndexOf("action") + 5)).toEqual([
        "action",
        "busy:true",
        "busy:true",
        "busy:false",
        "signature",
      ]);
      // The internal flag never reaches the caller (same rule as
      // __scopedBefore).
      expect(result).not.toHaveProperty("__targetSelfDisabled");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not poll at all when the action did not make the control busy", async () => {
    const { page, order } = makeBusyPage([false], false);
    const controller = new BrowserController(makeFakeTarget(page));
    const snapshot = (await controller.snapshot()) as { snapshotId: string };
    await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "TYPE_TEXT", text: "hi" });

    expect(order.filter((o) => o.startsWith("busy:"))).toEqual([]);
  });

  it("gives up after the 3s bound when the control never comes back, rather than hanging the command", async () => {
    vi.useFakeTimers();
    try {
      const { page, order } = makeBusyPage([true]);
      const controller = new BrowserController(makeFakeTarget(page));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      const promise = controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });
      await vi.advanceTimersByTimeAsync(BROWSER_COMMAND_TIMEOUT_MS);
      const result = await promise;

      expect(result).not.toHaveProperty("error");
      expect(order[order.length - 1]).toBe("signature");
      // 3s bound at a 50ms poll interval — bounded, and well under the 20s
      // command timeout that would otherwise turn this into an error.
      expect(order.filter((o) => o === "busy:true").length).toBeLessThanOrEqual(61);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the wait when the element disappears (re-render or navigation)", async () => {
    vi.useFakeTimers();
    try {
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) => {
          if (isSignatureCall(code)) {
            return Promise.resolve({
              url: "https://example.com/",
              title: "Example",
              nodeCount: 1,
              textLength: 0,
              textHash: 0,
              mainImageSrc: "",
              scrollY: 0,
              focusedValueLength: 0,
            });
          }
          if (isBusyCall(code)) return Promise.resolve({ present: false, busy: false });
          return Promise.resolve({ url: "https://example.com/", title: "Example", __targetSelfDisabled: true });
        }),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      const promise = controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(await promise).not.toHaveProperty("error");
    } finally {
      vi.useRealTimers();
    }
  });
});

// Reveal-scroll ordering (code review): scrolling the target into view must
// never land between the before- and after-signature captures, or a click
// that did nothing reports changed: true, changes: ["scroll"].
describe("reveal-scroll ordering", () => {
  function orderedPage() {
    const order: string[] = [];
    const page = makeFakePage({
      executeJavaScript: vi.fn((code: string) => {
        if (isRevealCall(code)) {
          order.push("reveal");
          return Promise.resolve({ found: true, hitOk: true });
        }
        if (isCursorCall(code)) order.push("cursor");
        else if (isSignatureCall(code)) {
          order.push("signature");
          return Promise.resolve({
            url: "https://example.com/",
            title: "Example",
            nodeCount: 1,
            textLength: 0,
            textHash: 0,
            mainImageSrc: "",
            scrollY: 0,
            focusedValueLength: 0,
          });
        } else order.push("action");
        return Promise.resolve({ url: "https://example.com/", title: "Example", matched: "x" });
      }),
    });
    return { order, page };
  }

  function expectRevealFirst(order: string[]) {
    expect(order.indexOf("reveal")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("reveal")).toBeLessThan(order.indexOf("signature"));
    // Exactly one reveal, and none after the before-capture.
    expect(order.filter((o) => o === "reveal")).toHaveLength(1);
  }

  it("act click (by text) reveals before the before-signature capture", async () => {
    const { order, page } = orderedPage();
    await new BrowserController(makeFakeTarget(page)).act({ action: "click", target: "Buy now" });
    expectRevealFirst(order);
  });

  it("act type (by text) reveals before the before-signature capture", async () => {
    const { order, page } = orderedPage();
    await new BrowserController(makeFakeTarget(page)).act({ action: "type", target: "Search", text: "hi" });
    expectRevealFirst(order);
  });

  it("perform CLICK and TYPE_TEXT reveal before the before-signature capture, carrying index + snapshotId", async () => {
    for (const operation of ["CLICK", "TYPE_TEXT"] as const) {
      const { order, page } = orderedPage();
      const controller = new BrowserController(makeFakeTarget(page));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      order.length = 0;
      await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation, text: "hi" });
      expectRevealFirst(order);
      const revealCall = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls.find((c) => isRevealCall(c[0]));
      expect(revealCall![0] as string).toContain(JSON.stringify({ index: 0, snapshotId: snapshot.snapshotId, operation }));
    }
  });

  it("a rejecting reveal script never fails the action", async () => {
    const page = makeFakePage({
      executeJavaScript: vi.fn((code: string) => {
        if (isRevealCall(code)) return Promise.reject(new Error("boom"));
        return Promise.resolve({ url: "https://example.com/", title: "Example", matched: "x" });
      }),
    });
    const result = await new BrowserController(makeFakeTarget(page)).act({ action: "click", target: "Buy now" });
    expect(result).not.toHaveProperty("error");
  });
});

// The visible cursor overlay (design: a human watching the browser tab must
// see the agent's clicks/typing land somewhere, not appear instantly and
// invisibly). CURSOR_JS runs before every click/type/scroll/perform action's
// before-signature capture — see its doc comment in pageScripts.ts.
describe("human cursor", () => {
  it("runs a cursor script carrying the target before CLICK_JS", async () => {
    const order: string[] = [];
    const page = makeFakePage({
      executeJavaScript: vi.fn((code: string) => {
        if (isCursorCall(code)) order.push("cursor");
        else if (isRevealCall(code)) order.push("reveal");
        else if (isSignatureCall(code)) order.push("signature");
        else order.push("action");
        return Promise.resolve({ url: "https://example.com/", title: "Example", matched: "Buy now" });
      }),
    });
    const controller = new BrowserController(makeFakeTarget(page));
    await controller.act({ action: "click", target: "Buy now" });

    // The reveal-scroll runs first (before the cursor move and the
    // before-signature capture), then the cursor, then the signature.
    expect(order[0]).toBe("reveal");
    expect(order[1]).toBe("cursor");
    expect(order.indexOf("cursor")).toBeLessThan(order.indexOf("signature"));

    const cursorCall = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      isCursorCall(c[0] as string),
    );
    expect(cursorCall, "no cursor call was made").toBeTruthy();
    const code = cursorCall![0] as string;
    expect(code).toContain(JSON.stringify("Buy now"));
    expect(code).toContain(JSON.stringify({ action: "click", target: "Buy now", from: null }));
  });

  it("perform with CLICK passes the snapshotId/index to the cursor call", async () => {
    const page = makeFakePage();
    const controller = new BrowserController(makeFakeTarget(page));
    const snapshot = (await controller.snapshot()) as { snapshotId: string };
    await controller.perform({ snapshotId: snapshot.snapshotId, index: 3, operation: "CLICK" });

    const cursorCall = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      isCursorCall(c[0] as string),
    );
    expect(cursorCall, "no cursor call was made").toBeTruthy();
    const code = cursorCall![0] as string;
    expect(code).toContain(JSON.stringify({ action: "click", snapshotId: snapshot.snapshotId, index: 3, from: null }));
  });

  it("feeds the position a cursor call returns back as 'from' on the next cursor call", async () => {
    const page = makeFakePage({
      executeJavaScript: vi.fn((code: string) => {
        if (isCursorCall(code)) return Promise.resolve({ moved: true, x: 111, y: 222 });
        if (isSignatureCall(code)) return Promise.resolve({ ok: true });
        return Promise.resolve({ url: "https://example.com/", title: "Example", matched: "Go" });
      }),
    });
    const controller = new BrowserController(makeFakeTarget(page));
    await controller.act({ action: "click", target: "Go" });
    await controller.act({ action: "click", target: "Go again" });

    const cursorCalls = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      isCursorCall(c[0] as string),
    );
    expect(cursorCalls.length).toBe(2);
    expect(cursorCalls[0][0] as string).toContain(JSON.stringify({ action: "click", target: "Go", from: null }));
    expect(cursorCalls[1][0] as string).toContain(
      JSON.stringify({ action: "click", target: "Go again", from: { x: 111, y: 222 } }),
    );
  });

  it("a cursor script that rejects leaves the command's result unchanged and successful", async () => {
    const page = makeFakePage({
      executeJavaScript: vi.fn((code: string) => {
        if (isCursorCall(code)) return Promise.reject(new Error("cursor boom"));
        if (isSignatureCall(code)) return Promise.resolve({ ok: true });
        return Promise.resolve({ url: "https://x/", title: "X", matched: "Buy now" });
      }),
      getURL: vi.fn(() => "https://x/"),
      getTitle: vi.fn(() => "X"),
    });
    const controller = new BrowserController(makeFakeTarget(page));
    const result = await controller.act({ action: "click", target: "Buy now" });
    expect(result).not.toHaveProperty("error");
    expect(result).toMatchObject({ url: "https://x/", title: "X", matched: "Buy now" });
  });

  it("a cursor script that times out leaves the command's result unchanged and successful", async () => {
    vi.useFakeTimers();
    try {
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) => {
          if (isCursorCall(code)) return new Promise(() => {}); // never settles
          if (isSignatureCall(code)) return Promise.resolve({ ok: true });
          return Promise.resolve({ url: "https://x/", title: "X", matched: "Buy now" });
        }),
        getURL: vi.fn(() => "https://x/"),
        getTitle: vi.fn(() => "X"),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const promise = controller.act({ action: "click", target: "Buy now" });
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await promise;
      expect(result).not.toHaveProperty("error");
      expect(result).toMatchObject({ url: "https://x/", title: "X", matched: "Buy now" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("issues no cursor call at all when constructed with cursor: false", async () => {
    const page = makeFakePage();
    const controller = new BrowserController(makeFakeTarget(page), { cursor: false });
    await controller.act({ action: "click", target: "Go" });
    await controller.act({ action: "type", target: "Search", text: "hi" });
    await controller.act({ action: "scroll" });
    const snapshot = (await controller.snapshot()) as { snapshotId: string };
    await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });

    const calls = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((c) => isCursorCall(c[0] as string))).toBe(false);
  });

  // Finding 1: the cursor's own bound must be ADDED to a command's budget,
  // not spent out of it — moveCursor runs inside the same withCommandTimeout
  // closure the action itself needs, so a short caller-supplied timeoutMs
  // used to leave less than timeoutMs available for the actual action.
  describe("cursor budget extension (finding 1)", () => {
    it("extends the command budget by the cursor's own bound, so a slow action script still gets its full timeoutMs", async () => {
      vi.useFakeTimers();
      try {
        const page = makeFakePage({
          executeJavaScript: vi.fn((code: string) => {
            if (isCursorCall(code)) return Promise.resolve({ moved: false, x: 0, y: 0 });
            if (isSignatureCall(code)) return Promise.resolve({ ok: true });
            // The action script itself never resolves — models a slow page.
            return new Promise(() => {});
          }),
        });
        const controller = new BrowserController(makeFakeTarget(page), { timeoutMs: 1_000 });
        const promise = controller.act({ action: "click", target: "Buy now" });

        // Just under timeoutMs alone: if the cursor's bound were carved out
        // of the budget instead of added to it, the command would already
        // have timed out by here.
        await vi.advanceTimersByTimeAsync(900);
        let settled = false;
        void promise.then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);

        // Push well past timeoutMs alone but still under timeoutMs +
        // cursorBudgetMs (1000 + min(1000, 900) = 1900) — still not timed out.
        await vi.advanceTimersByTimeAsync(900);
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);

        // Now past the full extended budget — the command must time out,
        // and the reported budget in the error message is the extended one.
        await vi.advanceTimersByTimeAsync(300);
        const result = await promise;
        expect(result).toMatchObject({ error: expect.stringContaining("1900ms") });
      } finally {
        vi.useRealTimers();
      }
    });

    it("perform also extends its budget by the cursor's own bound", async () => {
      vi.useFakeTimers();
      try {
        const page = makeFakePage({
          executeJavaScript: vi.fn((code: string) => {
            if (isCursorCall(code)) return Promise.resolve({ moved: false, x: 0, y: 0 });
            if (isSignatureCall(code)) return Promise.resolve({ ok: true });
            // SNAPSHOT_JS itself must resolve normally (its own budget carries
            // no cursor step) — only the subsequent PERFORM_JS call hangs.
            if (code.includes("scrollContainerBudget")) return Promise.resolve({ elements: [] });
            return new Promise(() => {}); // PERFORM_JS hangs
          }),
        });
        const controller = new BrowserController(makeFakeTarget(page), { timeoutMs: 1_000 });
        const snapshot = (await controller.snapshot()) as { snapshotId: string };
        const promise = controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });

        await vi.advanceTimersByTimeAsync(1_500);
        let settled = false;
        void promise.then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(600);
        const result = await promise;
        expect(result).toMatchObject({ error: expect.stringContaining("1900ms") });
      } finally {
        vi.useRealTimers();
      }
    });

    it("back/forward, which never run a cursor step, keep the plain timeoutMs budget", async () => {
      vi.useFakeTimers();
      try {
        const page = makeFakePage({
          canGoBack: vi.fn(() => true),
          getURL: vi.fn(() => "https://example.com/"), // never changes -> waitForUrlChange never resolves early
          executeJavaScript: vi.fn(() => new Promise(() => {})), // signature capture hangs too
        });
        const controller = new BrowserController(makeFakeTarget(page), { timeoutMs: 1_000 });
        const promise = controller.act({ action: "back" });
        await vi.advanceTimersByTimeAsync(1_000);
        const result = await promise;
        expect(result).toMatchObject({ error: expect.stringContaining("1000ms") });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // Finding 2: a browser tab that exists but isn't the visible one (e.g. a
  // popup opened in the background) never fires requestAnimationFrame, so
  // the cursor step should be skipped outright rather than burning its full
  // backstop for an overlay nobody can see.
  describe("visibility gate (finding 2)", () => {
    it("skips the cursor call when the page reports isVisible() === false", async () => {
      const page = makeFakePage({ isVisible: vi.fn(() => false) });
      const controller = new BrowserController(makeFakeTarget(page));
      await controller.act({ action: "click", target: "Buy now" });

      const calls = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some((c) => isCursorCall(c[0] as string))).toBe(false);
    });

    it("still runs the cursor call when the page reports isVisible() === true", async () => {
      const page = makeFakePage({ isVisible: vi.fn(() => true) });
      const controller = new BrowserController(makeFakeTarget(page));
      await controller.act({ action: "click", target: "Buy now" });

      const calls = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some((c) => isCursorCall(c[0] as string))).toBe(true);
    });

    it("still runs the cursor call when the page doesn't implement isVisible at all", async () => {
      const page = makeFakePage();
      expect(page.isVisible).toBeUndefined();
      const controller = new BrowserController(makeFakeTarget(page));
      await controller.act({ action: "click", target: "Buy now" });

      const calls = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some((c) => isCursorCall(c[0] as string))).toBe(true);
    });
  });
});

// --- Full browser use (design doc `2026-09-23-full-browser-use-design.md`) ---

describe("screenshot", () => {
  it("errors when no browser tab is open", async () => {
    const controller = new BrowserController(makeFakeTarget(null));
    const result = await controller.screenshot(undefined);
    expect(result).toHaveProperty("error");
  });

  it("errors when the page doesn't implement capture()", async () => {
    const page = makeFakePage();
    expect(page.capture).toBeUndefined();
    const controller = new BrowserController(makeFakeTarget(page));
    const result = await controller.screenshot(undefined);
    expect(String((result as { error: string }).error)).toMatch(/not supported/i);
  });

  it("returns imageData/width/height/url/title on a successful capture", async () => {
    const page = makeFakePage({
      capture: vi.fn(() => Promise.resolve({ imageData: "data:image/jpeg;base64,AAAA", width: 400, height: 800 })),
    });
    const controller = new BrowserController(makeFakeTarget(page));
    const result = await controller.screenshot(undefined);
    expect(result).toEqual({
      imageData: "data:image/jpeg;base64,AAAA",
      width: 400,
      height: 800,
      url: page.getURL(),
      title: page.getTitle(),
    });
  });

  it("reports an error (not a blank image) when capture() resolves null", async () => {
    const page = makeFakePage({ capture: vi.fn(() => Promise.resolve(null)) });
    const controller = new BrowserController(makeFakeTarget(page));
    const result = await controller.screenshot(undefined);
    expect(result).toHaveProperty("error");
    expect(String((result as { error: string }).error)).toMatch(/empty image/i);
  });

  it("validates 'annotate' is a boolean when provided", async () => {
    const controller = new BrowserController(makeFakeTarget(makeFakePage({ capture: vi.fn(() => Promise.resolve(null)) })));
    const result = await controller.screenshot({ annotate: "yes" });
    expect(result).toHaveProperty("error");
  });

  it("rejects snapshotId without annotate, and a non-string snapshotId", async () => {
    const capture = vi.fn(() => Promise.resolve({ imageData: "data:image/jpeg;base64,AA", width: 1, height: 1 }));
    const controller = new BrowserController(makeFakeTarget(makeFakePage({ capture })));
    expect(await controller.screenshot({ snapshotId: "abc" })).toHaveProperty("error");
    expect(await controller.screenshot({ annotate: false, snapshotId: "abc" })).toHaveProperty("error");
    expect(await controller.screenshot({ annotate: true, snapshotId: 5 })).toHaveProperty("error");
    expect(await controller.screenshot({ annotate: true, snapshotId: "  " })).toHaveProperty("error");
    expect(capture).not.toHaveBeenCalled();
  });

  describe("annotate with a caller-supplied snapshotId", () => {
    function setup(marked: number) {
      let snapshots = 0;
      const executeJavaScript = vi.fn((code: string) => {
        if (isSignatureCall(code) || isCursorCall(code) || isRevealCall(code)) return Promise.resolve({ ok: true });
        if (code.includes("maxElements")) {
          snapshots++;
          return Promise.resolve({
            url: "https://example.com/",
            title: "Example",
            elements: [{ index: 0, tag: "button", label: "Go", ops: ["CLICK"] }],
            scroll: { y: 0, height: 100, atBottom: true },
          });
        }
        if (code.includes("position:fixed;left:0;top:0")) return Promise.resolve({ marked });
        return Promise.resolve({ ok: true });
      });
      const capture = vi.fn(() => Promise.resolve({ imageData: "data:image/jpeg;base64,CC", width: 10, height: 20 }));
      const page = makeFakePage({ executeJavaScript, capture });
      const controller = new BrowserController(makeFakeTarget(page));
      return { controller, executeJavaScript, capture, snapshotCount: () => snapshots };
    }

    it("marks the given snapshot without taking a new one, returns that id, and keeps it valid for perform", async () => {
      const { controller, executeJavaScript, capture, snapshotCount } = setup(1);
      const snap = (await controller.snapshot()) as { snapshotId: string };
      expect(snapshotCount()).toBe(1);

      const shot = (await controller.screenshot({ annotate: true, snapshotId: snap.snapshotId })) as {
        snapshotId: string;
        imageData: string;
      };
      expect(shot.snapshotId).toBe(snap.snapshotId);
      expect(shot.imageData).toBe("data:image/jpeg;base64,CC");
      expect((shot as { marked?: number }).marked).toBe(1);
      expect(snapshotCount()).toBe(1);
      const marksCall = executeJavaScript.mock.calls.map((c) => c[0] as string).find((c) => c.includes("position:fixed;left:0;top:0"));
      expect(marksCall).toContain(snap.snapshotId);
      expect(capture).toHaveBeenCalledTimes(1);

      const performed = (await controller.perform({ snapshotId: snap.snapshotId, index: 0, operation: "CLICK" })) as {
        error?: string;
      };
      expect(performed.error ?? "").not.toMatch(/stale/i);
    });

    it("refuses an unknown or superseded snapshotId without capturing", async () => {
      const { controller, capture } = setup(1);
      const old = (await controller.snapshot()) as { snapshotId: string };
      await controller.snapshot();
      for (const id of ["nope", old.snapshotId]) {
        const r = (await controller.screenshot({ annotate: true, snapshotId: id })) as { error?: string };
        expect(r.error).toMatch(/stale|unknown/i);
      }
      expect(capture).not.toHaveBeenCalled();
    });

    it("a current snapshot that marks 0 (iframe/off-screen) still returns the image, with marked: 0, and removes marks", async () => {
      const { controller, executeJavaScript, capture } = setup(0);
      const snap = (await controller.snapshot()) as { snapshotId: string };
      const r = (await controller.screenshot({ annotate: true, snapshotId: snap.snapshotId })) as {
        error?: string;
        imageData?: string;
        marked?: number;
        snapshotId?: string;
      };
      expect(r.error).toBeUndefined();
      expect(r.imageData).toBe("data:image/jpeg;base64,CC");
      expect(r.marked).toBe(0);
      expect(r.snapshotId).toBe(snap.snapshotId);
      expect(capture).toHaveBeenCalledTimes(1);
      const calls = executeJavaScript.mock.calls.map((c) => c[0] as string);
      expect(calls.filter((c) => c.includes("data-pen-marks")).length).toBeGreaterThanOrEqual(2);
      const performed = (await controller.perform({ snapshotId: snap.snapshotId, index: 0, operation: "CLICK" })) as {
        error?: string;
      };
      expect(performed.error ?? "").not.toMatch(/stale/i);
    });
  });

  it("annotate: true takes a fresh snapshot first, marks it, captures, and always removes the marks overlay", async () => {
    const executeJavaScript = vi.fn((code: string) => {
      if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
      if (code.includes("data-pen-snap")) {
        // SNAPSHOT_JS's own body — return one element.
        return Promise.resolve({
          url: "https://example.com/",
          title: "Example",
          elements: [{ index: 0, tag: "button", label: "Go", ops: ["CLICK"] }],
          scroll: { y: 0, height: 100, atBottom: true },
        });
      }
      return Promise.resolve({ marked: 1 });
    });
    const page = makeFakePage({
      executeJavaScript,
      capture: vi.fn(() => Promise.resolve({ imageData: "data:image/jpeg;base64,BBBB", width: 100, height: 200 })),
    });
    const controller = new BrowserController(makeFakeTarget(page));
    const result = (await controller.screenshot({ annotate: true })) as {
      imageData: string;
      snapshotId: string;
      elements: unknown[];
    };
    expect(result.imageData).toBe("data:image/jpeg;base64,BBBB");
    expect(typeof result.snapshotId).toBe("string");
    expect(result.elements).toHaveLength(1);

    const calls = executeJavaScript.mock.calls.map((c) => c[0] as string);
    // The overlay must both have been installed (data-pen-marks-carrying
    // call after the snapshot) and removed afterward (finally) — checked via
    // call count of scripts referencing "data-pen-marks", which both
    // MARKS_JS and REMOVE_MARKS_JS contain.
    const marksRelatedCalls = calls.filter((c) => c.includes("data-pen-marks"));
    expect(marksRelatedCalls.length).toBeGreaterThanOrEqual(2);
  });

  describe("annotate composes marks onto the image (no visible DOM overlay)", () => {
    const layout = {
      marked: 1,
      placement: {},
      marks: [{ text: "0", box: { l: 1, t: 2, w: 3, h: 4 }, label: { l: 0, t: 0, w: 15, h: 16 }, inside: false, font: 10, padX: 4, bg: "#0d99ff" }],
      viewportWidth: 800,
      viewportHeight: 600,
    };
    function makePage(composeResult: unknown, captureImg = "data:image/jpeg;base64,CLEAN", isolated = true) {
      const executeJavaScript = vi.fn((code: string) => {
        if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
        if (code.includes("maxElements")) {
          return Promise.resolve({
            url: "https://example.com/",
            title: "Example",
            elements: [{ index: 0, tag: "button", label: "Go", ops: ["CLICK"] }],
            scroll: { y: 0, height: 100, atBottom: true },
          });
        }
        if (code.includes("requestAnimationFrame")) return Promise.resolve(true);
        if (code.includes('"draw":false')) return Promise.resolve(layout);
        if (code.includes("data-pen-marks") && code.includes("removeChild") && !code.includes("createElement")) {
          return Promise.resolve({ removed: false });
        }
        return Promise.resolve({ marked: 1 });
      });
      const capture = vi.fn(() => Promise.resolve({ imageData: captureImg, width: 100, height: 200 }));
      const executeJavaScriptIsolated = vi.fn((code: string) =>
        composeResult === "hang" ? new Promise(() => {}) : Promise.resolve(composeResult && code ? composeResult : null),
      );
      return {
        page: makeFakePage(isolated ? { executeJavaScript, capture, executeJavaScriptIsolated } : { executeJavaScript, capture }),
        executeJavaScript,
        executeJavaScriptIsolated,
        capture,
      };
    }

    it("returns the composed image and never runs the DOM-drawing MARKS_JS", async () => {
      const { page, executeJavaScript, executeJavaScriptIsolated, capture } = makePage({
        imageData: "data:image/jpeg;base64,COMPOSED",
        width: 100,
        height: 200,
      });
      const result = (await new BrowserController(makeFakeTarget(page)).screenshot({ annotate: true })) as {
        imageData: string;
        marked: number;
        snapshotId: string;
      };
      expect(result.imageData).toBe("data:image/jpeg;base64,COMPOSED");
      expect(result.marked).toBe(1);
      expect(typeof result.snapshotId).toBe("string");
      expect(capture).toHaveBeenCalledTimes(1);
      const calls = executeJavaScript.mock.calls.map((c) => c[0] as string);
      // No call runs MARKS_JS in drawing mode: the drawing branch is in the
      // template, so a draw call is a MARKS_JS body WITHOUT the draw:false arg
      // (the REMOVE_MARKS_JS cleanup has no setAttribute).
      const drawCalls = calls.filter((c) => c.includes('setAttribute("data-pen-marks"') && !c.includes('"draw":false'));
      expect(drawCalls).toHaveLength(0);
      // The compose script received the CLEAN capture.
      // Compose ran only in the isolated world, with the CLEAN capture; the
      // main world never saw it.
      expect(calls.some((c) => c.includes("createImageBitmap"))).toBe(false);
      expect(executeJavaScriptIsolated).toHaveBeenCalledTimes(1);
      expect(executeJavaScriptIsolated.mock.calls[0]![0]).toContain("data:image/jpeg;base64,CLEAN");
    });

    it("falls back to the visible DOM overlay when the handle has no isolated world", async () => {
      const { page, executeJavaScript } = makePage({ imageData: "data:image/jpeg;base64,COMPOSED", width: 1, height: 1 }, undefined, false);
      const result = (await new BrowserController(makeFakeTarget(page)).screenshot({ annotate: true })) as { imageData: string };
      expect(result.imageData).toBe("data:image/jpeg;base64,CLEAN");
      const calls = executeJavaScript.mock.calls.map((c) => c[0] as string);
      expect(calls.some((c) => c.includes("createImageBitmap"))).toBe(false);
      expect(calls.some((c) => c.includes('setAttribute("data-pen-marks"') && !c.includes('"draw":false'))).toBe(true);
    });

    it("falls back within the bound when compose hangs", async () => {
      vi.useFakeTimers();
      try {
        const { page } = makePage("hang");
        const pending = new BrowserController(makeFakeTarget(page)).screenshot({ annotate: true });
        await vi.advanceTimersByTimeAsync(3_000);
        const result = (await pending) as { imageData: string; marked: number };
        expect(result.imageData).toBe("data:image/jpeg;base64,CLEAN");
        expect(result.marked).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("falls back to the visible DOM overlay (and removes it) when compose fails", async () => {
      const { page, executeJavaScript, capture } = makePage({ error: "createImageBitmap unavailable" });
      const result = (await new BrowserController(makeFakeTarget(page)).screenshot({ annotate: true })) as {
        imageData: string;
        marked: number;
      };
      expect(result.imageData).toBe("data:image/jpeg;base64,CLEAN");
      expect(result.marked).toBe(1);
      // clean capture (discarded) + capture after the overlay was drawn
      expect(capture).toHaveBeenCalledTimes(2);
      const calls = executeJavaScript.mock.calls.map((c) => c[0] as string);
      const drawIdx = calls.findIndex((c) => c.includes("setAttribute(\"data-pen-marks\"") && !c.includes('"draw":false'));
      expect(drawIdx).toBeGreaterThan(-1);
      expect(calls[calls.length - 1]).toContain("data-pen-marks");
      expect(calls[calls.length - 1]).not.toContain("createElement");
    });
  });

  it("removes the marks overlay even when capture() throws", async () => {
    const executeJavaScript = vi.fn((code: string) => {
      if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
      if (code.includes("data-pen-snap")) {
        return Promise.resolve({
          url: "https://example.com/",
          title: "Example",
          elements: [],
          scroll: { y: 0, height: 0, atBottom: true },
        });
      }
      return Promise.resolve({ marked: 0 });
    });
    const page = makeFakePage({
      executeJavaScript,
      capture: vi.fn(() => Promise.reject(new Error("capture blew up"))),
    });
    const controller = new BrowserController(makeFakeTarget(page));
    // withCommandTimeout catches the rejection and reports it as {error}.
    const result = await controller.screenshot({ annotate: true });
    expect(result).toHaveProperty("error");
    const marksCalls = executeJavaScript.mock.calls.map((c) => c[0] as string).filter((c) => c.includes("data-pen-marks"));
    expect(marksCalls.length).toBeGreaterThanOrEqual(2);
  });

  // Second-pass review finding 7: MARKS_JS's own result is now checked
  // before capturing — a failure there is reported as the command's error
  // (with the overlay cleaned up), instead of silently proceeding to a
  // capture with no marks and no explanation.
  it("finding 7: reports MARKS_JS's own error and removes any partial marks, without capturing", async () => {
    const executeJavaScript = vi.fn((code: string) => {
      if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
      // SNAPSHOT_JS is matched by its own unique "maxElements" arg, not by
      // "data-pen-snap" — MARKS_JS's body also contains "data-pen-snap"
      // (it reads back the snapshot's own stamped elements), so matching on
      // that string alone would misidentify the MARKS_JS call below as a
      // second snapshot call.
      if (code.includes("maxElements")) {
        return Promise.resolve({
          url: "https://example.com/",
          title: "Example",
          elements: [{ index: 0, tag: "button", label: "Go", ops: ["CLICK"] }],
          scroll: { y: 0, height: 100, atBottom: true },
        });
      }
      if (code.includes("data-pen-marks")) {
        return Promise.resolve({ error: "MARKS_JS blew up" });
      }
      return Promise.resolve({ ok: true });
    });
    const capture = vi.fn(() => Promise.resolve({ imageData: "data:image/jpeg;base64,X", width: 1, height: 1 }));
    const page = makeFakePage({ executeJavaScript, capture });
    const controller = new BrowserController(makeFakeTarget(page));
    const result = await controller.screenshot({ annotate: true });
    expect(result).toEqual({ error: "MARKS_JS blew up" });
    expect(capture).not.toHaveBeenCalled();
    const marksCalls = executeJavaScript.mock.calls.map((c) => c[0] as string).filter((c) => c.includes("data-pen-marks"));
    // MARKS_JS's own call, plus the cleanup REMOVE_MARKS_JS call.
    expect(marksCalls.length).toBeGreaterThanOrEqual(2);
  });

  // Second-pass review finding 7: capture is preceded by an in-page
  // double-requestAnimationFrame wait so a just-applied overlay has actually
  // painted before capturePage() runs.
  it("finding 7: waits for a paint (double requestAnimationFrame) after marking, before capturing", async () => {
    const executeJavaScript = vi.fn((code: string) => {
      if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
      // See the previous test's comment: SNAPSHOT_JS is matched by its
      // unique "maxElements" arg, since "data-pen-snap" also appears in
      // MARKS_JS's body.
      if (code.includes("maxElements")) {
        return Promise.resolve({
          url: "https://example.com/",
          title: "Example",
          elements: [],
          scroll: { y: 0, height: 0, atBottom: true },
        });
      }
      if (code.includes("requestAnimationFrame")) return Promise.resolve(true);
      return Promise.resolve({ marked: 1 });
    });
    const capture = vi.fn(() => Promise.resolve({ imageData: "data:image/jpeg;base64,Y", width: 1, height: 1 }));
    const page = makeFakePage({ executeJavaScript, capture });
    const controller = new BrowserController(makeFakeTarget(page));
    const result = await controller.screenshot({ annotate: true });
    expect(result).toHaveProperty("imageData", "data:image/jpeg;base64,Y");
    const calls = executeJavaScript.mock.calls.map((c) => c[0] as string);
    const paintCallIndex = calls.findIndex((c) => c.includes("requestAnimationFrame"));
    const marksCallIndex = calls.findIndex((c) => c.includes("data-pen-marks") && !c.includes("removeChild"));
    const captureCallOrder = capture.mock.invocationCallOrder[0];
    expect(paintCallIndex).toBeGreaterThan(-1);
    // The paint wait runs after marking and before capture.
    expect(executeJavaScript.mock.invocationCallOrder[paintCallIndex]).toBeGreaterThan(
      executeJavaScript.mock.invocationCallOrder[marksCallIndex],
    );
    expect(executeJavaScript.mock.invocationCallOrder[paintCallIndex]).toBeLessThan(captureCallOrder);
  });

  // Second-pass review finding 7: a hidden tab whose requestAnimationFrame
  // never ticks (executeJavaScript's promise never settles) must not hang
  // the whole command — the paint wait times out and the capture proceeds.
  it("finding 7: proceeds to capture even if the paint wait itself never settles", async () => {
    const executeJavaScript = vi.fn((code: string) => {
      if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
      if (code.includes("maxElements")) {
        return Promise.resolve({
          url: "https://example.com/",
          title: "Example",
          elements: [],
          scroll: { y: 0, height: 0, atBottom: true },
        });
      }
      if (code.includes("requestAnimationFrame")) return new Promise(() => {}); // never resolves
      return Promise.resolve({ marked: 1 });
    });
    const capture = vi.fn(() => Promise.resolve({ imageData: "data:image/jpeg;base64,Z", width: 1, height: 1 }));
    const page = makeFakePage({ executeJavaScript, capture });
    const controller = new BrowserController(makeFakeTarget(page));
    const result = await controller.screenshot({ annotate: true });
    expect(result).toHaveProperty("imageData", "data:image/jpeg;base64,Z");
  });
});

describe("tabs", () => {
  function makeTabsTarget(page: BrowserPageHandle | null, tabs: { tabId: number; url: string; title: string; current: boolean }[]) {
    const target = makeFakeTarget(page);
    return {
      ...target,
      listPages: vi.fn(() => Promise.resolve(tabs)),
      selectPage: vi.fn((id: number) => Promise.resolve(tabs.some((t) => t.tabId === id))),
      closePage: vi.fn((id: number) => Promise.resolve(tabs.some((t) => t.tabId === id))),
      newPage: vi.fn((url?: string) => Promise.resolve({ tabId: 99, url: url ?? "", title: "New Tab", current: true })),
    };
  }

  it("rejects an unknown action", async () => {
    const controller = new BrowserController(makeFakeTarget(makeFakePage()));
    const result = await controller.tabs({ action: "teleport" });
    expect(result).toHaveProperty("error");
  });

  it("reports 'not supported' when the target doesn't implement tab management", async () => {
    const controller = new BrowserController(makeFakeTarget(makeFakePage()));
    const result = await controller.tabs({ action: "list" });
    expect(String((result as { error: string }).error)).toMatch(/not supported/i);
  });

  it("list reports every tab and the current one", async () => {
    const tabsData = [
      { tabId: 1, url: "https://a.example/", title: "A", current: false },
      { tabId: 2, url: "https://b.example/", title: "B", current: true },
    ];
    const target = makeTabsTarget(makeFakePage(), tabsData);
    const controller = new BrowserController(target);
    const result = await controller.tabs({ action: "list" });
    expect(result).toEqual({ tabs: tabsData, current: 2 });
  });

  it("switch requires a tabId, calls selectPage, and errors on an unknown tabId", async () => {
    const tabsData = [{ tabId: 1, url: "https://a.example/", title: "A", current: true }];
    const target = makeTabsTarget(makeFakePage(), tabsData);
    const controller = new BrowserController(target);

    const missingTabId = await controller.tabs({ action: "switch" });
    expect(missingTabId).toHaveProperty("error");

    const unknown = await controller.tabs({ action: "switch", tabId: 999 });
    expect(unknown).toHaveProperty("error");
    expect(target.selectPage).toHaveBeenCalledWith(999);

    const ok = await controller.tabs({ action: "switch", tabId: 1 });
    expect(ok).not.toHaveProperty("error");
    expect(target.selectPage).toHaveBeenCalledWith(1);
  });

  it("close requires a tabId, calls closePage, and errors when it reports false (editor tab / unknown id)", async () => {
    const tabsData = [{ tabId: 1, url: "https://a.example/", title: "A", current: true }];
    const target = makeTabsTarget(makeFakePage(), tabsData);
    const controller = new BrowserController(target);

    expect(await controller.tabs({ action: "close" })).toHaveProperty("error");

    const failure = await controller.tabs({ action: "close", tabId: 42 });
    expect(failure).toHaveProperty("error");

    const ok = await controller.tabs({ action: "close", tabId: 1 });
    expect(ok).not.toHaveProperty("error");
    expect(target.closePage).toHaveBeenCalledWith(1);
  });

  // Review finding 9: newPage() itself never takes a url anymore — it used
  // to await a full loadURL() (did-finish-load), so "new" with a url blocked
  // for as long as the whole page took to load. Loading a url now reuses
  // open()'s own DOM-ready-plus-grace-period wait.
  it("new calls newPage() with no url, and loads a given url via open()'s semantics", async () => {
    const tabsData: { tabId: number; url: string; title: string; current: boolean }[] = [];
    const page = makeFakePage();
    const target = makeTabsTarget(page, tabsData);
    const controller = new BrowserController(target);

    await controller.tabs({ action: "new" });
    expect(target.newPage).toHaveBeenCalledWith();
    expect(page.loadURL).not.toHaveBeenCalled();

    await controller.tabs({ action: "new", url: "https://example.com" });
    expect(target.newPage).toHaveBeenCalledTimes(2);
    expect(target.newPage).toHaveBeenLastCalledWith();
    expect(page.loadURL).toHaveBeenCalledWith("https://example.com");
  });

  it("finding 9: on open() failure, reports the error alongside the tab listing (the tab already exists — no reason to retry into a duplicate)", async () => {
    const tabsData = [{ tabId: 99, url: "", title: "New Tab", current: true }];
    const page = makeFakePage({
      loadURL: vi.fn(() => Promise.reject(new Error("net::ERR_FAILED"))),
      // Never resolves — forces open()'s race to settle via the (rejecting)
      // full-load path, not the DOM-ready one.
      onceDomReady: vi.fn(() => new Promise<void>(() => {})),
    });
    const target = makeTabsTarget(page, tabsData);
    const controller = new BrowserController(target);
    const result = (await controller.tabs({ action: "new", url: "https://broken.example" })) as {
      error?: string;
      tabs?: unknown[];
    };
    expect(result.error).toMatch(/ERR_FAILED/);
    expect(result.tabs).toEqual(tabsData);
  });

  it("rejects a non-http(s) url for new", async () => {
    const target = makeTabsTarget(makeFakePage(), []);
    const controller = new BrowserController(target);
    const result = await controller.tabs({ action: "new", url: "javascript:alert(1)" });
    expect(result).toHaveProperty("error");
    expect(target.newPage).not.toHaveBeenCalled();
  });

  // Second-pass review finding 6: the outer `tabs({action:"new", url})`
  // command used to budget itself the same `openTimeoutMs` as the nested
  // `open()` call, but started its own clock strictly earlier (before
  // `newPage()` even runs) — so its timeout always fired first, reporting a
  // bare "Browser command timed out" with no tab listing at all, instead of
  // the nested `open()` call's own (equally-budgeted, but later-starting)
  // timeout, which at least still runs `listTabsResult()` afterward and
  // reports a tab listing alongside the error.
  it("finding 6: the nested open() call's own timeout fires first, still reporting the tab listing", async () => {
    vi.useFakeTimers();
    try {
      const page = makeFakePage({
        // Neither ever settles — forces open()'s own BROWSER_OPEN_TIMEOUT_MS
        // (here, the controller's configured openTimeoutMs) to be what ends
        // the command.
        loadURL: vi.fn(() => new Promise<void>(() => {})),
        onceDomReady: vi.fn(() => new Promise<void>(() => {})),
      });
      const tabsData = [{ tabId: 99, url: "", title: "New Tab", current: true }];
      const target = makeTabsTarget(page, tabsData);
      const controller = new BrowserController(target, { openTimeoutMs: 100 });
      const promise = controller.tabs({ action: "new", url: "https://example.com" });
      await vi.advanceTimersByTimeAsync(100);
      const result = (await promise) as { error?: string; tabs?: unknown[] };
      // The nested open() call's own 100ms timeout produced this error, not
      // a bare timeout from the outer command (which would report no `tabs`
      // field at all).
      expect(result.error).toMatch(/Browser command timed out after 100ms/);
      expect(result.tabs).toEqual(tabsData);
    } finally {
      vi.useRealTimers();
    }
  });

  // Second-pass review finding 6: mergeDialogs used to overwrite
  // `result.dialogs` outright whenever it found anything of its own to
  // drain, discarding whatever the nested open() call had already merged in.
  it("finding 6: dialogs merged by the nested open() call survive the outer tabs() command's own dialog merge", async () => {
    const tabA = makeFakePage({ drainDialogs: vi.fn(() => [{ type: "alert", message: "from tabA (outer only)" }]) });
    const tabB = makeFakePage({ drainDialogs: vi.fn(() => [{ type: "confirm", message: "from tabB (inner only)" }]) });
    let pageHandlesCall = 0;
    const tabsData = [{ tabId: 99, url: "https://example.com/", title: "Example", current: true }];
    const target = {
      ...makeTabsTarget(tabB, tabsData),
      currentPage: () => tabB,
      // Outer's own capture (before newPage() runs) sees only tabA; the
      // nested open() call's own capture (after newPage() runs) sees only
      // tabB — two genuinely different snapshots of "every open browser
      // tab", taken at two different moments, each with its own dialog to
      // report.
      pageHandles: vi.fn(async () => {
        pageHandlesCall += 1;
        return pageHandlesCall === 1 ? [{ tabId: 1, page: tabA }] : [{ tabId: 2, page: tabB }];
      }),
    };
    const controller = new BrowserController(target);
    const result = (await controller.tabs({ action: "new", url: "https://example.com" })) as {
      dialogs?: unknown[];
    };
    expect(result.dialogs).toEqual(
      expect.arrayContaining([
        { tabId: 1, type: "alert", message: "from tabA (outer only)" },
        { tabId: 2, type: "confirm", message: "from tabB (inner only)" },
      ]),
    );
    expect(result.dialogs).toHaveLength(2);
  });
});

describe("act: press", () => {
  it("errors on a missing/empty key", async () => {
    const controller = new BrowserController(makeFakeTarget(makeFakePage({ sendCdp: vi.fn() })));
    expect(await controller.act({ action: "press" })).toHaveProperty("error");
    expect(await controller.act({ action: "press", key: "" })).toHaveProperty("error");
  });

  it("errors on an unrecognized key spec", async () => {
    const controller = new BrowserController(makeFakeTarget(makeFakePage({ sendCdp: vi.fn() })));
    const result = await controller.act({ action: "press", key: "Fn+Whatever" });
    expect(result).toHaveProperty("error");
  });

  it("errors clearly when the page has no CDP session (debugger attach failed)", async () => {
    const page = makeFakePage();
    expect(page.sendCdp).toBeUndefined();
    const controller = new BrowserController(makeFakeTarget(page));
    const result = await controller.act({ action: "press", key: "Enter" });
    expect(String((result as { error: string }).error)).toMatch(/CDP/i);
  });

  it("dispatches a keyDown+keyUp pair via CDP with the resolved key/modifiers", async () => {
    const sendCdp = vi.fn((_method: string, _params?: Record<string, unknown>) => Promise.resolve({}));
    const page = makeFakePage({ sendCdp });
    const controller = new BrowserController(makeFakeTarget(page));
    const result = await controller.act({ action: "press", key: "Shift+a" });
    expect(result).not.toHaveProperty("error");

    const calls = sendCdp.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe("Input.dispatchKeyEvent");
    // Review finding 2: Shift+letter reports the uppercase text a real
    // keyboard would produce, not the lowercase spelling of the spec.
    expect(calls[0][1]).toMatchObject({ type: "keyDown", key: "A", modifiers: 8, text: "A" });
    expect(calls[1][0]).toBe("Input.dispatchKeyEvent");
    expect(calls[1][1]).toMatchObject({ type: "keyUp", key: "A", modifiers: 8 });
  });

  // Review finding 2: on macOS Chromium a CDP-synthesized Meta/Ctrl-modified
  // keydown doesn't run the browser's native editing-command table the way
  // a genuine OS-level shortcut would, so Cmd+A previously did nothing at
  // all. `commands` (Puppeteer's own fix for the same limitation) plus no
  // `text` (a modified shortcut must never also insert a literal character)
  // is the fix.
  it("Meta/Ctrl combos send no text and pass the matching editing command", async () => {
    const sendCdp = vi.fn((_method: string, _params?: Record<string, unknown>) => Promise.resolve({}));
    const page = makeFakePage({ sendCdp });
    const controller = new BrowserController(makeFakeTarget(page));

    await controller.act({ action: "press", key: "Meta+a" });
    expect(sendCdp.mock.calls[0][1]).toMatchObject({ key: "a", modifiers: 4, text: undefined, commands: ["selectAll"] });

    sendCdp.mockClear();
    await controller.act({ action: "press", key: "Ctrl+c" });
    expect(sendCdp.mock.calls[0][1]).toMatchObject({ text: undefined, commands: ["copy"] });

    sendCdp.mockClear();
    await controller.act({ action: "press", key: "Ctrl+x" });
    expect(sendCdp.mock.calls[0][1]).toMatchObject({ text: undefined, commands: ["cut"] });

    sendCdp.mockClear();
    await controller.act({ action: "press", key: "Ctrl+v" });
    expect(sendCdp.mock.calls[0][1]).toMatchObject({ text: undefined, commands: ["paste"] });

    sendCdp.mockClear();
    await controller.act({ action: "press", key: "Meta+z" });
    expect(sendCdp.mock.calls[0][1]).toMatchObject({ text: undefined, commands: ["undo"] });

    sendCdp.mockClear();
    await controller.act({ action: "press", key: "Meta+Shift+z" });
    expect(sendCdp.mock.calls[0][1]).toMatchObject({ text: undefined, commands: ["redo"] });

    sendCdp.mockClear();
    await controller.act({ action: "press", key: "Meta+y" });
    expect(sendCdp.mock.calls[0][1]).toMatchObject({ text: undefined, commands: ["redo"] });
  });

  it("Shift+digit and Shift+punctuation send the shifted US-layout symbol as text", async () => {
    const sendCdp = vi.fn((_method: string, _params?: Record<string, unknown>) => Promise.resolve({}));
    const page = makeFakePage({ sendCdp });
    const controller = new BrowserController(makeFakeTarget(page));

    await controller.act({ action: "press", key: "Shift+1" });
    expect(sendCdp.mock.calls[0][1]).toMatchObject({ key: "!", text: "!", code: "Digit1" });

    sendCdp.mockClear();
    await controller.act({ action: "press", key: "Shift+-" });
    expect(sendCdp.mock.calls[0][1]).toMatchObject({ key: "_", text: "_", code: "Minus" });
  });

  it("uses rawKeyDown for a non-printable named key (no 'text')", async () => {
    const sendCdp = vi.fn((_method: string, _params?: Record<string, unknown>) => Promise.resolve({}));
    const page = makeFakePage({ sendCdp });
    const controller = new BrowserController(makeFakeTarget(page));
    await controller.act({ action: "press", key: "Escape" });
    expect(sendCdp.mock.calls[0][1]).toMatchObject({ type: "rawKeyDown", key: "Escape" });
  });

  it("surfaces a rejecting sendCdp as a clear error", async () => {
    const page = makeFakePage({ sendCdp: vi.fn((_method: string, _params?: Record<string, unknown>) => Promise.reject(new Error("debugger detached"))) });
    const controller = new BrowserController(makeFakeTarget(page));
    const result = await controller.act({ action: "press", key: "Enter" });
    expect(result).toHaveProperty("error");
    expect(String((result as { error: string }).error)).toMatch(/debugger detached/);
  });

  it("focuses a target first when 'target' is given", async () => {
    const executeJavaScript = vi.fn((code: string) =>
      isSignatureCall(code) || isCursorCall(code) ? Promise.resolve({ ok: true }) : Promise.resolve({ focused: true }),
    );
    const page = makeFakePage({ sendCdp: vi.fn((_method: string, _params?: Record<string, unknown>) => Promise.resolve({})), executeJavaScript });
    const controller = new BrowserController(makeFakeTarget(page));
    await controller.act({ action: "press", key: "Enter", target: "Search" });
    const focusCalls = executeJavaScript.mock.calls.filter(
      (c) => !isSignatureCall(c[0] as string) && !isCursorCall(c[0] as string),
    );
    expect(focusCalls.length).toBeGreaterThanOrEqual(1);
  });

  // Review finding 5: before this, a failed/no-match focus was best-effort —
  // the key was still sent to whatever already had focus. Now an explicitly
  // requested focus target that FOCUS_JS couldn't find is a hard error, and
  // the key is never dispatched.
  it("errors (without dispatching the key) when an explicit focus target isn't found", async () => {
    const executeJavaScript = vi.fn((code: string) =>
      isSignatureCall(code) || isCursorCall(code) ? Promise.resolve({ ok: true }) : Promise.resolve({ focused: false }),
    );
    const sendCdp = vi.fn((_method: string, _params?: Record<string, unknown>) => Promise.resolve({}));
    const page = makeFakePage({ sendCdp, executeJavaScript });
    const controller = new BrowserController(makeFakeTarget(page));
    const result = await controller.act({ action: "press", key: "Enter", target: "Nope" });
    expect(result).toHaveProperty("error");
    expect(sendCdp).not.toHaveBeenCalled();
  });

  it("finding 5: an index+snapshotId focus target goes through the same staleness guard perform() uses", async () => {
    const executeJavaScript = vi.fn((code: string) =>
      isSignatureCall(code) || isCursorCall(code) ? Promise.resolve({ ok: true }) : Promise.resolve({ focused: true }),
    );
    const sendCdp = vi.fn((_method: string, _params?: Record<string, unknown>) => Promise.resolve({}));
    const page = makeFakePage({ sendCdp, executeJavaScript });
    const controller = new BrowserController(makeFakeTarget(page));

    const stale = await controller.act({ action: "press", key: "Enter", index: 0, snapshotId: "never-taken" });
    expect(stale).toHaveProperty("error");
    expect(String((stale as { error: string }).error)).toMatch(/stale|unknown/i);
    expect(sendCdp).not.toHaveBeenCalled();

    const snapshot = (await controller.snapshot()) as { snapshotId: string };
    const ok = await controller.act({ action: "press", key: "Enter", index: 0, snapshotId: snapshot.snapshotId });
    expect(ok).not.toHaveProperty("error");
  });

  it("validates index requires snapshotId and vice versa", async () => {
    const controller = new BrowserController(makeFakeTarget(makeFakePage({ sendCdp: vi.fn((_method: string, _params?: Record<string, unknown>) => Promise.resolve({})) })));
    expect(await controller.act({ action: "press", key: "Enter", index: 0 })).toHaveProperty("error");
    expect(await controller.act({ action: "press", key: "Enter", snapshotId: "abc" })).toHaveProperty("error");
  });

  it("carries evidence of effect and reports openedTab when a new tab appears", async () => {
    let listCalls = 0;
    const target = {
      ...makeFakeTarget(makeFakePage({ sendCdp: vi.fn((_method: string, _params?: Record<string, unknown>) => Promise.resolve({})) })),
      listPages: vi.fn(() => {
        listCalls += 1;
        return Promise.resolve(
          listCalls === 1
            ? [{ tabId: 1, url: "https://a/", title: "A", current: true }]
            : [
                { tabId: 1, url: "https://a/", title: "A", current: true },
                { tabId: 2, url: "https://b/", title: "B", current: false },
              ],
        );
      }),
    };
    const controller = new BrowserController(target);
    const result = (await controller.act({ action: "press", key: "Enter" })) as {
      changed: boolean;
      openedTab?: { tabId: number; url: string; title: string };
    };
    expect(result).toHaveProperty("changed");
    expect(result.openedTab).toEqual({ tabId: 2, url: "https://b/", title: "B" });
  });

  it("waits for a just-opened popup's url instead of reporting it blank", async () => {
    // A popup is listed the moment it is created, before its first
    // navigation lands: the first listings after the click carry url "".
    let listCalls = 0;
    const target = {
      ...makeFakeTarget(makeFakePage({ sendCdp: vi.fn((_method: string, _params?: Record<string, unknown>) => Promise.resolve({})) })),
      listPages: vi.fn(() => {
        listCalls += 1;
        const popupUrl = listCalls >= 5 ? "https://b/" : "";
        return Promise.resolve(
          listCalls === 1
            ? [{ tabId: 1, url: "https://a/", title: "A", current: true }]
            : [
                { tabId: 1, url: "https://a/", title: "A", current: true },
                { tabId: 2, url: popupUrl, title: popupUrl ? "B" : "New Tab", current: false },
              ],
        );
      }),
    };
    const controller = new BrowserController(target);
    const result = (await controller.act({ action: "press", key: "Enter" })) as {
      openedTab?: { tabId: number; url: string; title: string };
    };
    expect(result.openedTab).toEqual({ tabId: 2, url: "https://b/", title: "B" });
  });

  it("drops openedTab when the popup closes itself while its url is still blank", async () => {
    let listCalls = 0;
    const target = {
      ...makeFakeTarget(makeFakePage({ sendCdp: vi.fn((_method: string, _params?: Record<string, unknown>) => Promise.resolve({})) })),
      listPages: vi.fn(() => {
        listCalls += 1;
        const opener = { tabId: 1, url: "https://a/", title: "A", current: true };
        // First listing: before the press. Then the blank popup shows up for
        // a moment, and is gone on the next re-list.
        if (listCalls === 1 || listCalls >= 5) return Promise.resolve([opener]);
        return Promise.resolve([opener, { tabId: 2, url: "", title: "New Tab", current: false }]);
      }),
    };
    const controller = new BrowserController(target);
    const result = (await controller.act({ action: "press", key: "Enter" })) as { openedTab?: unknown };
    expect(result.openedTab).toBeUndefined();
  });
});

describe("act: hover", () => {
  it("errors when neither target nor index+snapshotId is given", async () => {
    const controller = new BrowserController(makeFakeTarget(makeFakePage({ sendCdp: vi.fn() })));
    const result = await controller.act({ action: "hover" });
    expect(result).toHaveProperty("error");
  });

  it("errors clearly when the page has no CDP session", async () => {
    const controller = new BrowserController(makeFakeTarget(makeFakePage()));
    const result = await controller.act({ action: "hover", target: "Menu" });
    expect(String((result as { error: string }).error)).toMatch(/CDP/i);
  });

  it("errors when the target script reports no match", async () => {
    const executeJavaScript = vi.fn((code: string) =>
      isSignatureCall(code) || isCursorCall(code) ? Promise.resolve({ ok: true }) : Promise.resolve({ found: false }),
    );
    const page = makeFakePage({ sendCdp: vi.fn((_method: string, _params?: Record<string, unknown>) => Promise.resolve({})), executeJavaScript });
    const controller = new BrowserController(makeFakeTarget(page));
    const result = await controller.act({ action: "hover", target: "Nope" });
    expect(result).toHaveProperty("error");
  });

  it("dispatches Input.dispatchMouseEvent mouseMoved at the located element's centre", async () => {
    const executeJavaScript = vi.fn((code: string) =>
      isSignatureCall(code) || isCursorCall(code)
        ? Promise.resolve({ ok: true })
        : Promise.resolve({ found: true, x: 42, y: 84 }),
    );
    const sendCdp = vi.fn((_method: string, _params?: Record<string, unknown>) => Promise.resolve({}));
    const page = makeFakePage({ sendCdp, executeJavaScript });
    const controller = new BrowserController(makeFakeTarget(page));
    const result = await controller.act({ action: "hover", target: "Menu" });
    expect(result).not.toHaveProperty("error");
    expect(sendCdp).toHaveBeenCalledWith("Input.dispatchMouseEvent", { type: "mouseMoved", x: 42, y: 84, button: "none" });
  });

  it("accepts index+snapshotId instead of target", async () => {
    const executeJavaScript = vi.fn((code: string) =>
      isSignatureCall(code) || isCursorCall(code)
        ? Promise.resolve({ ok: true })
        : Promise.resolve({ found: true, x: 1, y: 2 }),
    );
    const sendCdp = vi.fn((_method: string, _params?: Record<string, unknown>) => Promise.resolve({}));
    const page = makeFakePage({ sendCdp, executeJavaScript });
    const controller = new BrowserController(makeFakeTarget(page));
    // Review finding 5: an index+snapshotId hover now goes through the same
    // staleness/cross-tab guard perform() uses, so a real (current)
    // snapshotId is required — a bare "abc" is correctly rejected as stale.
    const snapshot = (await controller.snapshot()) as { snapshotId: string };
    const result = await controller.act({ action: "hover", index: 0, snapshotId: snapshot.snapshotId });
    expect(result).not.toHaveProperty("error");
  });

  it("finding 5: rejects a stale/unknown snapshotId with the same error perform() gives, without running HOVER_TARGET_JS", async () => {
    const executeJavaScript = vi.fn((code: string) =>
      isSignatureCall(code) || isCursorCall(code)
        ? Promise.resolve({ ok: true })
        : Promise.resolve({ found: true, x: 1, y: 2 }),
    );
    const page = makeFakePage({ sendCdp: vi.fn(() => Promise.resolve({})), executeJavaScript });
    const controller = new BrowserController(makeFakeTarget(page));
    const result = await controller.act({ action: "hover", index: 0, snapshotId: "never-taken" });
    expect(result).toHaveProperty("error");
    expect(String((result as { error: string }).error)).toMatch(/stale|unknown/i);
    expect(executeJavaScript.mock.calls.some((c) => (c[0] as string).includes("HOVER_TARGET"))).toBe(false);
  });

  it("finding 8: scrolls the target into view before the before-signature capture, not after", async () => {
    const callOrder: string[] = [];
    const executeJavaScript = vi.fn((code: string) => {
      if (isCursorCall(code)) return Promise.resolve({ ok: true });
      if (isSignatureCall(code)) {
        callOrder.push("signature");
        return Promise.resolve({
          url: "https://example.com/",
          title: "Example",
          nodeCount: 1,
          textLength: 0,
          textHash: 0,
          mainImageSrc: "",
          scrollY: 40,
          focusedValueLength: 0,
        });
      }
      callOrder.push("hover-target");
      return Promise.resolve({ found: true, x: 1, y: 2 });
    });
    const page = makeFakePage({ sendCdp: vi.fn(() => Promise.resolve({})), executeJavaScript });
    const controller = new BrowserController(makeFakeTarget(page));
    const result = await controller.act({ action: "hover", target: "Menu" });
    expect(result).not.toHaveProperty("error");
    // The locate-and-scroll call (HOVER_TARGET_JS) must precede the first
    // (before) signature capture — reversed, a hover that only needed to
    // scroll to reach its target would misreport a scrollY change caused by
    // locating the element, not by the hover itself.
    expect(callOrder[0]).toBe("hover-target");
    expect(callOrder.indexOf("signature")).toBeGreaterThan(callOrder.indexOf("hover-target"));
  });

  it("finding 8 (regression): a hover that needs to scroll to reach its target still reports changed: false when nothing else changed", async () => {
    // Models HOVER_TARGET_JS's real scrollIntoView side effect: locating
    // the target scrolls the page. With the fix (locate-and-scroll before
    // the before-capture), the before-capture already reflects the scrolled
    // position, so before/after scrollY match and changed stays false. With
    // the old (broken) ordering — before-capture, then locate+scroll, then
    // after-capture — this would incorrectly report changed: true, blaming
    // the hover for a scroll that only happened because the target needed
    // locating.
    let scrolled = false;
    const executeJavaScript = vi.fn((code: string) => {
      if (isCursorCall(code)) return Promise.resolve({ ok: true });
      if (isSignatureCall(code)) {
        return Promise.resolve({
          url: "https://example.com/",
          title: "Example",
          nodeCount: 1,
          textLength: 0,
          textHash: 0,
          mainImageSrc: "",
          scrollY: scrolled ? 500 : 0,
          focusedValueLength: 0,
        });
      }
      // HOVER_TARGET_JS: locating the below-the-fold target scrolls to it.
      scrolled = true;
      return Promise.resolve({ found: true, x: 1, y: 2 });
    });
    const page = makeFakePage({ sendCdp: vi.fn(() => Promise.resolve({})), executeJavaScript });
    const controller = new BrowserController(makeFakeTarget(page));
    const result = await controller.act({ action: "hover", target: "Below the fold" });
    expect(result).toMatchObject({ changed: false });
  });

  it("carries evidence of effect", async () => {
    let signatureCalls = 0;
    const executeJavaScript = vi.fn((code: string) => {
      if (isCursorCall(code)) return Promise.resolve({ ok: true });
      if (isSignatureCall(code)) {
        signatureCalls += 1;
        return Promise.resolve({
          url: "https://example.com/",
          title: "Example",
          nodeCount: 1,
          textLength: 1,
          textHash: 1,
          mainImageSrc: "",
          scrollY: signatureCalls === 1 ? 0 : 40,
          focusedValueLength: 0,
        });
      }
      return Promise.resolve({ found: true, x: 1, y: 2 });
    });
    const page = makeFakePage({ sendCdp: vi.fn((_method: string, _params?: Record<string, unknown>) => Promise.resolve({})), executeJavaScript });
    const controller = new BrowserController(makeFakeTarget(page));
    const result = await controller.act({ action: "hover", target: "Menu" });
    expect(result).toMatchObject({ changed: true, changes: ["scroll"] });
  });
});

describe("act: select (routes to perform SELECT)", () => {
  it("requires index+snapshotId and text", async () => {
    const controller = new BrowserController(makeFakeTarget(makeFakePage()));
    expect(await controller.act({ action: "select", text: "Option" })).toHaveProperty("error");
    const snapshot = (await controller.snapshot()) as { snapshotId: string };
    expect(await controller.act({ action: "select", index: 0, snapshotId: snapshot.snapshotId })).toHaveProperty("error");
  });

  it("dispatches PERFORM_JS with operation SELECT against the caller's snapshot", async () => {
    const executeJavaScript = vi.fn((code: string) => {
      if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
      if (code.includes("data-pen-snap")) {
        return Promise.resolve({
          url: "https://example.com/",
          title: "Example",
          elements: [{ index: 0, tag: "select", label: "Color", ops: ["SELECT"] }],
          scroll: { y: 0, height: 0, atBottom: true },
        });
      }
      return Promise.resolve({ url: "https://example.com/", title: "Example" });
    });
    const page = makeFakePage({ executeJavaScript });
    const controller = new BrowserController(makeFakeTarget(page));
    const snapshot = (await controller.snapshot()) as { snapshotId: string };
    const result = await controller.act({ action: "select", index: 0, snapshotId: snapshot.snapshotId, text: "Blue" });
    expect(result).not.toHaveProperty("error");
    const performCall = executeJavaScript.mock.calls.find((c) => (c[0] as string).includes('"operation":"SELECT"'));
    expect(performCall).toBeTruthy();
  });

  it("rejects a stale snapshotId, same as perform() itself", async () => {
    const controller = new BrowserController(makeFakeTarget(makeFakePage()));
    const result = await controller.act({ action: "select", index: 0, snapshotId: "not-a-real-snapshot", text: "Blue" });
    expect(result).toHaveProperty("error");
  });
});

describe("act: click/type by index (routes to perform CLICK/TYPE_TEXT)", () => {
  it("validates index requires snapshotId and vice versa", async () => {
    const controller = new BrowserController(makeFakeTarget(makeFakePage()));
    expect(await controller.act({ action: "click", index: 0 })).toHaveProperty("error");
    expect(await controller.act({ action: "click", snapshotId: "abc" })).toHaveProperty("error");
  });

  it("type by index requires text", async () => {
    const controller = new BrowserController(makeFakeTarget(makeFakePage()));
    const snapshot = (await controller.snapshot()) as { snapshotId: string };
    const result = await controller.act({ action: "type", index: 0, snapshotId: snapshot.snapshotId });
    expect(result).toHaveProperty("error");
  });

  it("click by index reuses perform()'s staleness check", async () => {
    const controller = new BrowserController(makeFakeTarget(makeFakePage()));
    const result = await controller.act({ action: "click", index: 0, snapshotId: "stale" });
    expect(result).toHaveProperty("error");
  });

  it("click by index succeeds against the caller's own snapshot and can report openedTab", async () => {
    let listCalls = 0;
    const page = makeFakePage();
    const target = {
      ...makeFakeTarget(page),
      listPages: vi.fn(() => {
        listCalls += 1;
        return Promise.resolve(
          listCalls === 1
            ? [{ tabId: 1, url: "https://a/", title: "A", current: true }]
            : [
                { tabId: 1, url: "https://a/", title: "A", current: true },
                { tabId: 2, url: "https://popup/", title: "Popup", current: false },
              ],
        );
      }),
    };
    const controller = new BrowserController(target);
    const snapshot = (await controller.snapshot()) as { snapshotId: string };
    const result = (await controller.act({ action: "click", index: 0, snapshotId: snapshot.snapshotId })) as {
      openedTab?: { tabId: number };
    };
    expect(result.openedTab).toEqual({ tabId: 2, url: "https://popup/", title: "Popup" });
  });
});

describe("act: reload", () => {
  it("errors when no browser tab is open", async () => {
    const controller = new BrowserController(makeFakeTarget(null));
    const result = await controller.act({ action: "reload" });
    expect(result).toHaveProperty("error");
  });

  it("calls page.reload() and returns url/title once loading settles", async () => {
    const page = makeFakePage();
    const controller = new BrowserController(makeFakeTarget(page));
    const result = await controller.act({ action: "reload" });
    expect(page.reload).toHaveBeenCalled();
    expect(result).toEqual({ url: page.getURL(), title: page.getTitle() });
  });
});

describe("act: wait", () => {
  it("validates 'text' and 'ms'", async () => {
    const controller = new BrowserController(makeFakeTarget(makeFakePage()));
    expect(await controller.act({ action: "wait", text: "" })).toHaveProperty("error");
    expect(await controller.act({ action: "wait", ms: -1 })).toHaveProperty("error");
    expect(await controller.act({ action: "wait", ms: "soon" })).toHaveProperty("error");
  });

  it("without text, sleeps roughly `ms` and returns found: true", async () => {
    const controller = new BrowserController(makeFakeTarget(makeFakePage()));
    const start = Date.now();
    const result = await controller.act({ action: "wait", ms: 20 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
    expect(result).toMatchObject({ found: true });
  });

  it("clamps ms to the 15s hard cap rather than sleeping for whatever a caller asks", async () => {
    vi.useFakeTimers();
    try {
      const controller = new BrowserController(makeFakeTarget(makeFakePage()));
      let resolved = false;
      void controller.act({ action: "wait", ms: 999_999 }).then(() => {
        resolved = true;
      });
      // If the 999,999ms request weren't clamped to WAIT_MAX_MS (15s), this
      // would not have resolved yet.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("with text, polls until WAIT_TEXT_JS reports a match", async () => {
    let calls = 0;
    const executeJavaScript = vi.fn((code: string) => {
      if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
      calls += 1;
      return Promise.resolve({ found: calls >= 2 });
    });
    const page = makeFakePage({ executeJavaScript });
    const controller = new BrowserController(makeFakeTarget(page));
    const result = await controller.act({ action: "wait", text: "Loaded", ms: 2_000 });
    expect(result).toMatchObject({ found: true });
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("with text, reports found: false (not an error) when the deadline passes", async () => {
    const executeJavaScript = vi.fn((code: string) =>
      isSignatureCall(code) || isCursorCall(code) ? Promise.resolve({ ok: true }) : Promise.resolve({ found: false }),
    );
    const page = makeFakePage({ executeJavaScript });
    const controller = new BrowserController(makeFakeTarget(page));
    const result = await controller.act({ action: "wait", text: "Never appears", ms: 150 });
    expect(result).toEqual({ found: false, url: page.getURL(), title: page.getTitle() });
  });

  // Second-pass review finding 9: with `text` and a `ms` of 0, the previous
  // `while (Date.now() < deadline)` loop's condition could already be false
  // before the body ever ran once (the deadline is `Date.now() + 0`, i.e.
  // "now"), so the page was never actually polled at all — `found` reported
  // `false` regardless of what was already on the page. The wait must always
  // check at least once.
  it("with text and ms: 0, still polls WAIT_TEXT_JS at least once", async () => {
    const executeJavaScript = vi.fn((code: string) =>
      isSignatureCall(code) || isCursorCall(code) ? Promise.resolve({ ok: true }) : Promise.resolve({ found: true }),
    );
    const page = makeFakePage({ executeJavaScript });
    const controller = new BrowserController(makeFakeTarget(page));
    const result = await controller.act({ action: "wait", text: "Already here", ms: 0 });
    expect(result).toEqual({ found: true, url: page.getURL(), title: page.getTitle() });
    const waitTextCalls = executeJavaScript.mock.calls.filter(
      (c) => !isSignatureCall(c[0]) && !isCursorCall(c[0]),
    );
    expect(waitTextCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("dialogs merging (design doc's dialog policy)", () => {
  it("merges non-empty dialogs into a successful command's result", async () => {
    const page = makeFakePage({
      drainDialogs: vi.fn(() => [{ type: "alert", message: "Hello" }]),
    });
    const controller = new BrowserController(makeFakeTarget(page));
    const result = await controller.open({ url: "https://example.com" });
    expect(result).toMatchObject({ dialogs: [{ type: "alert", message: "Hello" }] });
  });

  it("does not add a dialogs field when there are none", async () => {
    const page = makeFakePage({ drainDialogs: vi.fn(() => []) });
    const controller = new BrowserController(makeFakeTarget(page));
    const result = await controller.open({ url: "https://example.com" });
    expect(result).not.toHaveProperty("dialogs");
  });

  it("merges dialogs even into an error result", async () => {
    const page = makeFakePage({ drainDialogs: vi.fn(() => [{ type: "confirm", message: "Sure?" }]) });
    const controller = new BrowserController(makeFakeTarget(page));
    const result = await controller.act({ action: "click", target: "" }); // validation error, before withCommandTimeout even runs
    // Validation errors return before withCommandTimeout — this only proves
    // such an early error never crashes; the real "error + dialogs" case is
    // exercised by the next test, whose failure happens inside the timeout
    // wrapper.
    expect(result).toHaveProperty("error");
  });

  it("a throwing drainDialogs degrades to no dialogs rather than breaking the command", async () => {
    const page = makeFakePage({
      drainDialogs: vi.fn(() => {
        throw new Error("boom");
      }),
    });
    const controller = new BrowserController(makeFakeTarget(page));
    const result = await controller.open({ url: "https://example.com" });
    expect(result).not.toHaveProperty("error");
    expect(result).not.toHaveProperty("dialogs");
  });

  // Review finding 6: dialogs used to be drained only from currentPage(),
  // so a dialog raised on a tab other than the one a command acts on (a
  // popup that raised its own dialog while the command ran elsewhere) was
  // silently dropped. `pageHandles()` (when the target implements it) is now
  // drained in full, each entry tagged with its tabId.
  it("drains dialogs from every browser page reported by pageHandles(), tagged with tabId", async () => {
    const acted = makeFakePage({ drainDialogs: vi.fn(() => [{ type: "alert", message: "on the acted tab" }]) });
    const other = makeFakePage({ drainDialogs: vi.fn(() => [{ type: "confirm", message: "on another tab" }]) });
    const target: BrowserTarget = {
      ensurePage: async () => acted,
      currentPage: () => acted,
      pageHandles: async () => [
        { tabId: 1, page: acted },
        { tabId: 2, page: other },
      ],
    };
    const controller = new BrowserController(target);
    const result = await controller.open({ url: "https://example.com" });
    expect(result).toMatchObject({
      dialogs: [
        { tabId: 1, type: "alert", message: "on the acted tab" },
        { tabId: 2, type: "confirm", message: "on another tab" },
      ],
    });
  });

  it("finding 6: still reports a dialog from the acted-on page's own handle even if that page's tab closes during the command", async () => {
    // pageHandles is captured *before* fn() runs — its BrowserPageHandle
    // objects (plain closures over a dialog queue array) remain drainable
    // even once the real tab behind them is gone, since drainDialogs never
    // touches the underlying (possibly destroyed) webContents.
    let closed = false;
    const acted = makeFakePage({
      drainDialogs: vi.fn(() => (closed ? [{ type: "beforeunload", message: "closing" }] : [])),
    });
    const target: BrowserTarget = {
      ensurePage: async () => acted,
      currentPage: () => acted,
      pageHandles: async () => (closed ? [] : [{ tabId: 1, page: acted }]),
    };
    const controller = new BrowserController(target);
    const openPromise = controller.open({ url: "https://example.com" });
    closed = true; // simulate the command itself closing the acted-on tab
    const result = await openPromise;
    expect(result).toMatchObject({ dialogs: [{ tabId: 1, type: "beforeunload", message: "closing" }] });
  });

  it("falls back to draining only currentPage() when the target doesn't implement pageHandles", async () => {
    const page = makeFakePage({ drainDialogs: vi.fn(() => [{ type: "alert", message: "Hello" }]) });
    const controller = new BrowserController(makeFakeTarget(page)); // makeFakeTarget has no pageHandles
    const result = await controller.open({ url: "https://example.com" });
    expect(result).toMatchObject({ dialogs: [{ type: "alert", message: "Hello" }] });
  });
});

// Second-pass review finding 8: nothing previously serialized concurrent
// BrowserController calls — two commands the frontend fired without waiting
// for each other could interleave (a screenshot's marks overlay landing
// mid another command's own signature capture, lastSnapshot being replaced
// mid-perform by a racing snapshot()). A FIFO mutex (`runExclusive`) now
// makes every public command run to completion before the next one starts.
describe("command concurrency (finding 8)", () => {
  it("two concurrent commands run one at a time, never interleaved", async () => {
    const order: string[] = [];
    let resolveFirst!: (value: { text: string }) => void;
    const executeJavaScript = vi.fn((code: string) => {
      if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
      if (order.length === 0) {
        order.push("first-start");
        return new Promise((resolve) => {
          resolveFirst = (value) => {
            order.push("first-end");
            resolve(value);
          };
        });
      }
      order.push("second-start");
      return Promise.resolve({ text: "second" });
    });
    const page = makeFakePage({ executeJavaScript });
    const controller = new BrowserController(makeFakeTarget(page));

    const firstPromise = controller.read(undefined);
    const secondPromise = controller.read(undefined);

    // Flush a handful of microtasks — if the second command weren't
    // actually queued behind the first, it would have started executing its
    // own script by now.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(order).toEqual(["first-start"]);

    resolveFirst({ text: "first" });
    const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);

    expect(order).toEqual(["first-start", "first-end", "second-start"]);
    expect(firstResult).toMatchObject({ text: "first" });
    expect(secondResult).toMatchObject({ text: "second" });
  });

  // Third-pass review: a TIMED-OUT command's work keeps running (promises
  // can't be cancelled), so the queue must not hand the page to the next
  // command until that abandoned work settles — bounded by the overrun grace.
  it("a timed-out command's abandoned work finishes before the next command starts", async () => {
    const order: string[] = [];
    let resolveFirst!: (value: { text: string }) => void;
    const executeJavaScript = vi.fn((code: string) => {
      if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
      if (order.length === 0) {
        order.push("first-start");
        return new Promise((resolve) => {
          resolveFirst = (value) => {
            order.push("first-end");
            resolve(value);
          };
        });
      }
      order.push("second-start");
      return Promise.resolve({ text: "second" });
    });
    const page = makeFakePage({ executeJavaScript });
    const controller = new BrowserController(makeFakeTarget(page), { timeoutMs: 20 });

    const first = await controller.read(undefined);
    expect(first).toHaveProperty("error");
    const secondPromise = controller.read(undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(order).toEqual(["first-start"]);

    resolveFirst({ text: "late" });
    const second = await secondPromise;
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
    expect(second).toMatchObject({ text: "second" });
  });

  it("a rejecting command still lets the next queued command run", async () => {
    let calls = 0;
    const executeJavaScript = vi.fn((code: string) => {
      if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("boom"));
      return Promise.resolve({ text: "ok" });
    });
    const page = makeFakePage({ executeJavaScript });
    const controller = new BrowserController(makeFakeTarget(page));
    const first = await controller.read(undefined);
    const second = await controller.read(undefined);
    expect(first).toHaveProperty("error");
    expect(second).toMatchObject({ text: "ok" });
  });

  // `act`'s index-based click/type/select branches call `performUnlocked`
  // directly (not the public `perform`), and `tabs`'s "new"+url case calls
  // `openUnlocked` directly (not the public `open`) — calling back into the
  // public, queue-wrapped method from inside an already-queued command would
  // deadlock forever (enqueued behind itself). These must resolve promptly.
  it("act's index-routed click does not deadlock by calling back into the public perform()", async () => {
    const executeJavaScript = vi.fn((code: string) => {
      if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
      if (code.includes("maxElements")) {
        return Promise.resolve({
          url: "https://example.com/",
          title: "Example",
          elements: [{ index: 0, tag: "button", label: "Go", ops: ["CLICK"] }],
          scroll: { y: 0, height: 0, atBottom: true },
        });
      }
      return Promise.resolve({ url: "https://example.com/", title: "Example" });
    });
    const page = makeFakePage({ executeJavaScript });
    const controller = new BrowserController(makeFakeTarget(page));
    const snap = (await controller.snapshot()) as { snapshotId: string };
    const result = await controller.act({ action: "click", index: 0, snapshotId: snap.snapshotId });
    expect(result).not.toHaveProperty("error");
  });

  it("tabs new+url does not deadlock by calling back into the public open()", async () => {
    const page = makeFakePage();
    const target = {
      ...makeFakeTarget(page),
      listPages: vi.fn(() => Promise.resolve([{ tabId: 1, url: "", title: "New Tab", current: true }])),
      selectPage: vi.fn(() => Promise.resolve(true)),
      closePage: vi.fn(() => Promise.resolve(true)),
      newPage: vi.fn(() => Promise.resolve({ tabId: 1, url: "", title: "New Tab", current: true })),
    };
    const controller = new BrowserController(target);
    const result = await controller.tabs({ action: "new", url: "https://example.com" });
    expect(result).not.toHaveProperty("error");
  });
});

// Wave 1 speed (`2026-09-24-browse-speed-contract.md`): event-driven
// navigation detection and CDP network-quiet settle. Every test here fakes
// `onNavigationEvent`/`networkStats` — every `makeFakePage()` test above this
// point deliberately leaves both undefined, exercising the legacy polling
// fallback instead (see `armNavigationWatcher`'s doc comment), which is why
// none of it needed to change.
describe("BrowserController — Wave 1 speed", () => {
  /** A fake `onNavigationEvent`/`networkStats` pair modeling a real desktop
   * tab: `fireNavigation()` lets a test simulate a navigation-lifecycle
   * event firing at a chosen moment; `startRequest()`/`finishRequest()`
   * model in-flight CDP-tracked network requests, each carrying its own
   * per-request generation the way `window.ts`'s `pendingNetworkRequests`
   * does — `networkStats`'s optional `sinceGeneration` filters `pending`
   * down to only requests started after it (code review finding 2), same as
   * the real implementation. */
  function makeNetworkFakes() {
    const navListeners = new Set<() => void>();
    let generation = 0;
    const pendingRequests = new Map<number, number>(); // requestId -> generation
    let nextRequestId = 0;
    return {
      onNavigationEvent: (cb: () => void): (() => void) => {
        navListeners.add(cb);
        return () => navListeners.delete(cb);
      },
      networkStats: vi.fn((_dropAfterMs: number, sinceGeneration?: number) => {
        let pending = 0;
        for (const reqGeneration of pendingRequests.values()) {
          if (sinceGeneration === undefined || reqGeneration > sinceGeneration) pending += 1;
        }
        return { pending, generation };
      }),
      fireNavigation: () => {
        for (const cb of navListeners) cb();
      },
      /** Returns the started request's id, for a matching `finishRequest()`. */
      startRequest: (): number => {
        generation += 1;
        const id = nextRequestId++;
        pendingRequests.set(id, generation);
        return id;
      },
      finishRequest: (id?: number) => {
        if (id !== undefined) {
          pendingRequests.delete(id);
          return;
        }
        // No id given: finish an arbitrary (oldest) pending request — kept
        // for existing single-request tests that don't need to track one.
        const first = pendingRequests.keys().next();
        if (!first.done) pendingRequests.delete(first.value);
      },
    };
  }

  it("a non-navigating, no-network click settles well under the old 300ms fixed probe", async () => {
    vi.useFakeTimers();
    try {
      const net = makeNetworkFakes();
      const page = makeFakePage({
        onNavigationEvent: net.onNavigationEvent,
        networkStats: net.networkStats,
        executeJavaScript: vi.fn((code: string) =>
          isSignatureCall(code) || isCursorCall(code) ? Promise.resolve({ ok: true }) : Promise.resolve({ matched: "Go" }),
        ),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const promise = controller.act({ action: "click", target: "Go" });
      let settled = false;
      void promise.then(() => {
        settled = true;
      });
      // No navigation event ever fires and no request ever starts — the
      // click should resolve once the navigation-start grace elapses
      // (well under the old 300ms fixed probe), with no additional
      // network-quiet wait on top (networkStats reports nothing new).
      await vi.advanceTimersByTimeAsync(150);
      expect(settled).toBe(true);
      const result = await promise;
      expect(result).not.toHaveProperty("error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("code review finding 2: a no-network click settles immediately even with requests already pending from BEFORE the action (Pinterest-style lazy images)", async () => {
    vi.useFakeTimers();
    try {
      const net = makeNetworkFakes();
      // A request already in flight before the click ever runs — e.g. a
      // lazy-loading image grid still fetching from an earlier scroll.
      // Never finished, so it would keep `pending` above zero forever if it
      // weren't excluded by baseline generation.
      net.startRequest();
      const page = makeFakePage({
        onNavigationEvent: net.onNavigationEvent,
        networkStats: net.networkStats,
        executeJavaScript: vi.fn((code: string) =>
          isSignatureCall(code) || isCursorCall(code) ? Promise.resolve({ ok: true }) : Promise.resolve({ matched: "Go" }),
        ),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const promise = controller.act({ action: "click", target: "Go" });
      let settled = false;
      void promise.then(() => {
        settled = true;
      });
      // The click itself starts no new request — it should settle after the
      // navigation-start grace alone, not wait on the pre-existing pending
      // request (which never finishes in this test).
      await vi.advanceTimersByTimeAsync(150);
      expect(settled).toBe(true);
      const result = await promise;
      expect(result).not.toHaveProperty("error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a click that fires a fetch (no navigation) waits for network to go quiet before settling", async () => {
    vi.useFakeTimers();
    try {
      const net = makeNetworkFakes();
      const page = makeFakePage({
        onNavigationEvent: net.onNavigationEvent,
        networkStats: net.networkStats,
        executeJavaScript: vi.fn((code: string) => {
          if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
          // Models a click handler firing a fetch() synchronously — the
          // request "starts" (networkStats' generation bumps) before this
          // resolves, same as a real CDP requestWillBeSent would arrive
          // before executeJavaScript's own promise settles.
          net.startRequest();
          setTimeout(() => net.finishRequest(), 1_200);
          return Promise.resolve({ matched: "Load" });
        }),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const promise = controller.act({ action: "click", target: "Load" });
      let settled = false;
      void promise.then(() => {
        settled = true;
      });

      // Not yet quiet at 1000ms — the request is still in flight.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false);

      // The request finishes at 1200ms; quiet needs to hold for the
      // network-quiet window afterward before the command settles.
      await vi.advanceTimersByTimeAsync(1_500);
      expect(settled).toBe(true);
      const result = await promise;
      expect(result).not.toHaveProperty("error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("press: a single settle, not a double — a non-navigating, no-network press resolves without an extra fixed sleep on top", async () => {
    vi.useFakeTimers();
    try {
      const net = makeNetworkFakes();
      const sendCdp = vi.fn(() => Promise.resolve({}));
      const page = makeFakePage({
        sendCdp,
        onNavigationEvent: net.onNavigationEvent,
        networkStats: net.networkStats,
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const promise = controller.act({ action: "press", key: "Tab" });
      let settled = false;
      void promise.then(() => {
        settled = true;
      });
      // Old behavior: settleAfterClick's 300ms fixed probe *plus* a
      // separate settleShort() (50ms) — 350ms total. Wave 1 speed's
      // event-driven grace plus an instant "nothing to wait for"
      // network-quiet check settles well before that combined bound.
      await vi.advanceTimersByTimeAsync(200);
      expect(settled).toBe(true);
      const result = await promise;
      expect(result).not.toHaveProperty("error");
    } finally {
      vi.useRealTimers();
    }
  });

  // Follow-up rule: `wait` exists precisely because the caller expects
  // something — often a client-side timer with no network at all — to
  // still be in flight, so it must never return early just because nothing
  // has happened *yet*. It only returns early once something DID happen and
  // has since gone quiet.

  it("act wait (no text): nothing ever happens (no DOM mutation, no network) — waits the full ms, exactly like the original fixed sleep", async () => {
    vi.useFakeTimers();
    try {
      const page = makeFakePage(); // no networkStats; executeJavaScript's
      // generic { ok: true } response for WAIT_DOM_ACTIVITY_JS never
      // reports a mutation.
      const controller = new BrowserController(makeFakeTarget(page));
      const promise = controller.act({ action: "wait", ms: 500 });
      let settled = false;
      void promise.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(400);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(settled).toBe(true);
      const result = await promise;
      expect(result).toMatchObject({ found: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("act wait (no text): a spinner-style DOM mutation with no network activity — waits for the mutation, then the quiet window, not the full default", async () => {
    vi.useFakeTimers();
    try {
      // Models WAIT_DOM_ACTIVITY_JS: "install" arms a mutation that lands at
      // t=1500ms (a spinner resolving into a button, no network involved at
      // all); "check" reports { mutated, ageMs } from that same clock,
      // exactly like the real page script would via its MutationObserver.
      let mutatedAt: number | null = null;
      const executeJavaScript = vi.fn((code: string) => {
        if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
        if (code.includes('"action":"install"')) {
          setTimeout(() => {
            mutatedAt = Date.now();
          }, 1_500);
          return Promise.resolve({ installed: true });
        }
        if (code.includes('"action":"uninstall"')) return Promise.resolve({ uninstalled: true });
        // "check"
        if (mutatedAt === null) return Promise.resolve({ mutated: false, ageMs: null });
        return Promise.resolve({ mutated: true, ageMs: Date.now() - mutatedAt });
      });
      const page = makeFakePage({ executeJavaScript });
      const controller = new BrowserController(makeFakeTarget(page));
      const promise = controller.act({ action: "wait" }); // default ms (3000)
      let settled = false;
      void promise.then(() => {
        settled = true;
      });

      // Not settled before the mutation even happens.
      await vi.advanceTimersByTimeAsync(1_400);
      expect(settled).toBe(false);

      // Mutation lands at 1500ms; must not settle immediately — it needs to
      // observe quiet (no further mutation) for the quiet window first.
      await vi.advanceTimersByTimeAsync(200); // now at ~1600ms
      expect(settled).toBe(false);

      // By ~1500 + 300 (quiet window) + a little poll slack, it should have
      // settled — well before the 3000ms default.
      await vi.advanceTimersByTimeAsync(600); // now at ~2200ms
      expect(settled).toBe(true);
      const result = await promise;
      expect(result).toMatchObject({ found: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("act wait (no text): network-only activity (no DOM mutation) is also waited for, then settled", async () => {
    vi.useFakeTimers();
    try {
      const net = makeNetworkFakes();
      const page = makeFakePage({ networkStats: net.networkStats });
      const controller = new BrowserController(makeFakeTarget(page));
      const promise = controller.act({ action: "wait" }); // default ms (3000)
      let settled = false;
      void promise.then(() => {
        settled = true;
      });

      // Nothing pending yet — must not settle immediately just because
      // pending is currently 0 (no activity has been observed at all yet).
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);

      net.startRequest();
      await vi.advanceTimersByTimeAsync(500);
      expect(settled).toBe(false); // still in flight

      net.finishRequest();
      await vi.advanceTimersByTimeAsync(400); // past the quiet window
      expect(settled).toBe(true);
      const result = await promise;
      expect(result).toMatchObject({ found: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("act wait (no text): second-pass review finding 2 — a request already pending from BEFORE the wait started must not keep it 'active' for the whole ms budget", async () => {
    vi.useFakeTimers();
    try {
      const net = makeNetworkFakes();
      // A request already in flight before `act wait` is even called — e.g.
      // a lazy-loading image grid still fetching from an earlier scroll.
      // Never finishes in this test, so an unscoped `pending` count (no
      // baseline generation passed to networkStats) would report it forever
      // and the wait would never see quiet, burning the entire `ms` budget.
      const staleId = net.startRequest();
      const page = makeFakePage({ networkStats: net.networkStats });
      const controller = new BrowserController(makeFakeTarget(page));
      const promise = controller.act({ action: "wait", ms: 3_000 });
      let settled = false;
      void promise.then(() => {
        settled = true;
      });

      // Flush the DOM-activity install + baseline capture (both awaited
      // before the poll loop starts) before starting the "new" request —
      // otherwise it would race into the same baseline generation as the
      // stale one above instead of landing strictly after it.
      await vi.advanceTimersByTimeAsync(0);
      const newId = net.startRequest();
      await vi.advanceTimersByTimeAsync(100);
      net.finishRequest(newId);
      // Past the quiet window, well under the 3000ms budget — only possible
      // if the still-pending `staleId` request is excluded from `pending`.
      await vi.advanceTimersByTimeAsync(400);
      expect(settled).toBe(true);
      const result = await promise;
      expect(result).toMatchObject({ found: true });
      // Sanity: the stale request genuinely never finished.
      expect(staleId).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a genuine navigation still waits for load-stop, event-driven, instead of the network-quiet path", async () => {
    vi.useFakeTimers();
    try {
      const net = makeNetworkFakes();
      let loading = false;
      const page = makeFakePage({
        onNavigationEvent: net.onNavigationEvent,
        networkStats: net.networkStats,
        isLoading: vi.fn(() => loading),
        executeJavaScript: vi.fn((code: string) => {
          if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
          loading = true;
          net.fireNavigation();
          setTimeout(() => {
            loading = false;
          }, 1_000);
          return Promise.resolve({ matched: "Go" });
        }),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const promise = controller.act({ action: "click", target: "Go" });
      let settled = false;
      void promise.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(600);
      expect(settled).toBe(true);
      // networkStats is called exactly once, to capture the baseline before
      // the action runs — the network-quiet *wait* loop must never run once
      // a navigation was observed (it would keep polling networkStats
      // otherwise).
      expect(net.networkStats).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Wave 2 reliability (desktop/src/main/browser/controller.ts,
  // pageScripts.ts) — trusted CDP click/type, hidden-target text resolution,
  // and scroll-container targeting. `CLICK_RESOLVE_JS`'s code always
  // contains "__busyBefore: busyBefore" (unique to that script);
  // `SELECT_ALL_CONTENT_JS`'s always contains "Target element not found for
  // typing." (its own error message); `READ_TARGET_VALUE_JS`'s always
  // contains "penReadText(moved) === expected" (its retarget comparison) — used below to give each script call a distinct canned
  // response without depending on call order.
  describe("Wave 2 reliability", () => {
    function isResolveCall(code: unknown): boolean {
      // CLICK_RESOLVE_JS (`__busyBefore`) or REVEAL_TARGET_JS — NOT every
      // script that merely interpolates the hit-test helper (LOCATE_TARGET_JS
      // and CLICK_JS/TYPE_JS/PERFORM_JS carry it for penRevealIfNeeded).
      return typeof code === "string" && (code.includes("__busyBefore: busyBefore") || code.includes("var __penReveal = true"));
    }
    function isSelectAllCall(code: unknown): boolean {
      return typeof code === "string" && code.includes("Target element not found for typing.");
    }
    function isReadValueCall(code: unknown): boolean {
      return typeof code === "string" && code.includes("penReadText(moved) === expected");
    }
    function isBusyCall(code: unknown): boolean {
      return typeof code === "string" && code.includes("present: true, busy: penTargetIsBusy(el)");
    }

    describe("dispatchClick (act click / perform CLICK)", () => {
      it("act click: dispatches a trusted CDP mouseMoved/mousePressed/mouseReleased triple when the hit-test passes, and reports via: \"cdp\"", async () => {
        const sendCdp = vi.fn((_method: string, _params?: Record<string, unknown>) => Promise.resolve({}));
        const page = makeFakePage({
          getURL: vi.fn(() => "https://x/"),
          getTitle: vi.fn(() => "X"),
          sendCdp,
          executeJavaScript: vi.fn((code: string) => {
            if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
            if (isResolveCall(code)) {
              return Promise.resolve({ found: true, x: 12, y: 34, hitOk: true, matched: "Buy now" });
            }
            if (isBusyCall(code)) return Promise.resolve({ present: true, busy: false });
            return Promise.resolve({ ok: true });
          }),
        });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = await controller.act({ action: "click", target: "Buy now" });
        expect(result).toMatchObject({ via: "cdp", matched: "Buy now" });
        const calls = sendCdp.mock.calls.filter((c) => c[0] === "Input.dispatchMouseEvent");
        expect(calls.map((c) => (c[1] as Record<string, unknown>).type)).toEqual([
          "mouseMoved",
          "mousePressed",
          "mouseReleased",
        ]);
        for (const call of calls) {
          expect(call[1]).toMatchObject({ x: 12, y: 34 });
        }
        expect(calls[1][1]).toMatchObject({ button: "left", clickCount: 1 });
        expect(calls[2][1]).toMatchObject({ button: "left", clickCount: 1 });
        // The DOM-fallback script (CLICK_JS, which always calls el.click())
        // must never run on the trusted path — every executeJavaScript call
        // seen is cursor/signature/resolve/busy, never CLICK_JS itself. (A
        // plain substring check for CLICK_JS's own error text is not viable
        // here: CLICK_RESOLVE_JS's *source* also contains that same string
        // as its own not-found message, even when its canned mock response
        // never triggers that branch.)
        for (const call of (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls) {
          const code = call[0] as string;
          expect(isCursorCall(code) || isSignatureCall(code) || isResolveCall(code) || isBusyCall(code)).toBe(true);
        }
      });

      it("act click: falls back to the DOM el.click() path (CLICK_JS) when the hit-test fails, reporting via: \"dom\"", async () => {
        const sendCdp = vi.fn((_method: string, _params?: Record<string, unknown>) => Promise.resolve({}));
        const page = makeFakePage({
          getURL: vi.fn(() => "https://x/"),
          getTitle: vi.fn(() => "X"),
          sendCdp,
          executeJavaScript: vi.fn((code: string) => {
            if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
            if (isResolveCall(code)) {
              // Covered/offscreen after scroll — hitOk: false.
              return Promise.resolve({ found: true, x: 12, y: 34, hitOk: false, matched: "Buy now" });
            }
            // CLICK_JS itself.
            return Promise.resolve({ url: "https://x/", title: "X", matched: "Buy now" });
          }),
        });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = await controller.act({ action: "click", target: "Buy now" });
        expect(result).toMatchObject({ via: "dom", matched: "Buy now" });
        expect(sendCdp).not.toHaveBeenCalledWith("Input.dispatchMouseEvent", expect.anything());
      });

      it("code review finding 8: a CDP failure BEFORE mousePressed (mouseMoved rejects) still falls back to the DOM click", async () => {
        const sendCdp = vi.fn((method: string, _params?: Record<string, unknown>) => {
          if (method === "Input.dispatchMouseEvent") {
            // Only the very first dispatchMouseEvent call (mouseMoved) is
            // made to fail here — asserted below.
            if (sendCdp.mock.calls.filter((c) => c[0] === "Input.dispatchMouseEvent").length === 1) {
              return Promise.reject(new Error("debugger detached"));
            }
          }
          return Promise.resolve({});
        });
        const page = makeFakePage({
          getURL: vi.fn(() => "https://x/"),
          getTitle: vi.fn(() => "X"),
          sendCdp,
          executeJavaScript: vi.fn((code: string) => {
            if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
            if (isResolveCall(code)) {
              return Promise.resolve({ found: true, x: 12, y: 34, hitOk: true, matched: "Buy now" });
            }
            // CLICK_JS itself (the DOM fallback).
            return Promise.resolve({ url: "https://x/", title: "X", matched: "Buy now" });
          }),
        });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = await controller.act({ action: "click", target: "Buy now" });
        expect(result).toMatchObject({ via: "dom", matched: "Buy now" });
        // mousePressed was never reached.
        const pressedCalls = sendCdp.mock.calls.filter(
          (c) => c[0] === "Input.dispatchMouseEvent" && (c[1] as Record<string, unknown>).type === "mousePressed",
        );
        expect(pressedCalls).toHaveLength(0);
      });

      it("code review finding 8: a CDP failure AFTER mousePressed was sent (mouseReleased rejects) reports an error instead of risking a double click via the DOM fallback", async () => {
        const sendCdp = vi.fn((method: string, params?: Record<string, unknown>) => {
          if (method === "Input.dispatchMouseEvent" && (params as { type?: string })?.type === "mouseReleased") {
            return Promise.reject(new Error("debugger detached"));
          }
          return Promise.resolve({});
        });
        const clickJs = vi.fn();
        const page = makeFakePage({
          getURL: vi.fn(() => "https://x/"),
          getTitle: vi.fn(() => "X"),
          sendCdp,
          executeJavaScript: vi.fn((code: string) => {
            if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
            if (isResolveCall(code)) {
              return Promise.resolve({ found: true, x: 12, y: 34, hitOk: true, matched: "Buy now" });
            }
            clickJs();
            return Promise.resolve({ url: "https://x/", title: "X", matched: "Buy now" });
          }),
        });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = (await controller.act({ action: "click", target: "Buy now" })) as { error?: string };
        expect(result.error).toBeTruthy();
        expect(result.error).toMatch(/double click/i);
        // CLICK_JS (the DOM el.click() fallback) must never have run — that
        // would be a second click on top of a press that may have already
        // landed.
        expect(clickJs).not.toHaveBeenCalled();
        expect(sendCdp).toHaveBeenCalledWith(
          "Input.dispatchMouseEvent",
          expect.objectContaining({ type: "mousePressed" }),
        );
      });

      it("act click: falls back to the DOM path outright when the tab has no CDP session", async () => {
        const page = makeFakePage({
          getURL: vi.fn(() => "https://x/"),
          getTitle: vi.fn(() => "X"),
          // No sendCdp at all — models a tab whose debugger never attached.
          executeJavaScript: vi.fn((code: string) => {
            if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
            if (isResolveCall(code)) {
              return Promise.resolve({ found: true, x: 12, y: 34, hitOk: true, matched: "Buy now" });
            }
            return Promise.resolve({ url: "https://x/", title: "X", matched: "Buy now" });
          }),
        });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = await controller.act({ action: "click", target: "Buy now" });
        expect(result).toMatchObject({ via: "dom" });
      });

      it("perform CLICK: routes an index-based click through the same trusted-CDP resolve/dispatch path", async () => {
        const sendCdp = vi.fn((_method: string, _params?: Record<string, unknown>) => Promise.resolve({}));
        const page = makeFakePage({
          getURL: vi.fn(() => "https://x/"),
          getTitle: vi.fn(() => "X"),
          sendCdp,
          executeJavaScript: vi.fn((code: string) => {
            if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
            if (isResolveCall(code)) return Promise.resolve({ found: true, x: 1, y: 2, hitOk: true });
            if (isBusyCall(code)) return Promise.resolve({ present: false, busy: false });
            return Promise.resolve({ ok: true });
          }),
        });
        const controller = new BrowserController(makeFakeTarget(page));
        const snapshot = (await controller.snapshot()) as { snapshotId: string };
        const result = await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });
        expect(result).toMatchObject({ via: "cdp" });
        expect(sendCdp).toHaveBeenCalledWith("Input.dispatchMouseEvent", expect.objectContaining({ type: "mousePressed" }));
      });

      it("target text resolving to only a hidden element is refused, not clicked", async () => {
        const page = makeFakePage({
          executeJavaScript: vi.fn((code: string) => {
            if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
            if (isResolveCall(code)) return Promise.resolve({ error: "target is not visible (hidden element)" });
            return Promise.resolve({ ok: true });
          }),
        });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = await controller.act({ action: "click", target: "Hidden menu item" });
        expect(result).toEqual({ error: "target is not visible (hidden element)" });
      });
    });

    describe("dispatchType (act type / perform TYPE_TEXT)", () => {
      it("act type: focuses via a trusted CDP click, selects existing content, and types via Input.insertText, reporting via: \"cdp\"", async () => {
        const sendCdp = vi.fn((_method: string, _params?: Record<string, unknown>) => Promise.resolve({}));
        const page = makeFakePage({
          getURL: vi.fn(() => "https://x/"),
          getTitle: vi.fn(() => "X"),
          sendCdp,
          executeJavaScript: vi.fn((code: string) => {
            if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
            if (isResolveCall(code)) return Promise.resolve({ found: true, x: 5, y: 6, hitOk: true, matched: "Email", editable: true });
            if (isSelectAllCall(code)) return Promise.resolve({ editable: true });
            if (isReadValueCall(code)) return Promise.resolve({ matches: true, present: true });
            if (isBusyCall(code)) return Promise.resolve({ present: false, busy: false });
            return Promise.resolve({ ok: true });
          }),
        });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = await controller.act({ action: "type", target: "Email", text: "hi@example.com" });
        expect(result).toMatchObject({ via: "cdp", matched: "Email" });
        expect(sendCdp).toHaveBeenCalledWith("Input.dispatchMouseEvent", expect.objectContaining({ type: "mousePressed" }));
        // First char fires a real keyDown/keyUp so key listeners see it —
        // carrying no `text` (a raw key event, not an inserted character).
        const firstCharCall = sendCdp.mock.calls.find(
          (c) => c[0] === "Input.dispatchKeyEvent" && (c[1] as Record<string, unknown>).type === "rawKeyDown",
        );
        expect(firstCharCall).toBeTruthy();
        expect((firstCharCall![1] as Record<string, unknown>).text).toBeUndefined();
        expect(sendCdp).toHaveBeenCalledWith("Input.insertText", { text: "hi@example.com" });
      });

      it("act type: passes followFocus: true to SELECT_ALL_CONTENT_JS only after a trusted click landed", async () => {
        async function run(hitOk: boolean): Promise<string> {
          let selectCode = "";
          const page = makeFakePage({
            getURL: vi.fn(() => "https://x/"),
            getTitle: vi.fn(() => "X"),
            sendCdp: vi.fn((_method: string, _params?: Record<string, unknown>) => Promise.resolve({})),
            executeJavaScript: vi.fn((code: string) => {
              if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
              if (isResolveCall(code)) return Promise.resolve({ found: true, x: 5, y: 6, hitOk, matched: "Email", editable: true });
              if (isSelectAllCall(code)) {
                selectCode = code;
                return Promise.resolve({ editable: true });
              }
              if (isReadValueCall(code)) return Promise.resolve({ matches: true, present: true });
              if (isBusyCall(code)) return Promise.resolve({ present: false, busy: false });
              return Promise.resolve({ ok: true });
            }),
          });
          await new BrowserController(makeFakeTarget(page)).act({ action: "type", target: "Email", text: "a" });
          return selectCode;
        }
        expect(await run(true)).toMatch(/"followFocus":\s*true/);
        expect(await run(false)).toMatch(/"followFocus":\s*false/);
      });

      it("act type: a retargeted select (click moved focus to an overlay input) types there, reports retargeted, and uses the new field's before-signature", async () => {
        const sendCdp = vi.fn((_method: string, _params?: Record<string, unknown>) => Promise.resolve({}));
        const sig = { nodeCount: 1, textHash: 0, src: "", valueLength: 0, ariaExpanded: "", ariaSelected: "", ariaValueNow: "", checked: false };
        const page = makeFakePage({
          getURL: vi.fn(() => "https://x/"),
          getTitle: vi.fn(() => "X"),
          sendCdp,
          executeJavaScript: vi.fn((code: string) => {
            if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
            if (isResolveCall(code)) return Promise.resolve({ found: true, x: 5, y: 6, hitOk: true, matched: "Where from?", editable: true });
            if (isSelectAllCall(code)) return Promise.resolve({ editable: true, retargeted: true, __scopedBefore: sig });
            if (isReadValueCall(code)) return Promise.resolve({ matches: true, present: true });
            if (isBusyCall(code)) return Promise.resolve({ present: false, busy: false });
            // Anything else would be the legacy TYPE_JS fallback.
            return Promise.resolve({ url: "https://x/", title: "X", legacy: true });
          }),
        });
        const result = await new BrowserController(makeFakeTarget(page)).act({ action: "type", target: "Where from?", text: "Berlin" });
        expect(result).toMatchObject({ via: "cdp", retargeted: true });
        expect(result).not.toHaveProperty("legacy");
        expect(sendCdp).toHaveBeenCalledWith("Input.insertText", { text: "Berlin" });
      });

      it("act type: a retargeted VERIFY (focus moved after the select step) succeeds via cdp without the legacy fallback", async () => {
        const sendCdp = vi.fn((_method: string, _params?: Record<string, unknown>) => Promise.resolve({}));
        const legacy = vi.fn();
        const page = makeFakePage({
          getURL: vi.fn(() => "https://x/"),
          getTitle: vi.fn(() => "X"),
          sendCdp,
          executeJavaScript: vi.fn((code: string) => {
            if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
            if (isResolveCall(code)) return Promise.resolve({ found: true, x: 5, y: 6, hitOk: true, matched: "Where from?", editable: true });
            if (isSelectAllCall(code)) return Promise.resolve({ editable: true });
            if (isReadValueCall(code)) return Promise.resolve({ matches: true, present: true, retargeted: true });
            if (isBusyCall(code)) return Promise.resolve({ present: false, busy: false });
            if (typeof code === "string" && code.includes("autocomplete: false")) return Promise.resolve({ autocomplete: false });
            legacy();
            return Promise.resolve({ url: "https://x/", title: "X" });
          }),
        });
        const result = await new BrowserController(makeFakeTarget(page)).act({ action: "type", target: "Where from?", text: "Berlin" });
        expect(result).toMatchObject({ via: "cdp", retargeted: true });
        expect(legacy).not.toHaveBeenCalled();
      });

      it("act type: verifies the typed value and falls back to the native-setter path (TYPE_JS) on a mismatch", async () => {
        const sendCdp = vi.fn((_method: string, _params?: Record<string, unknown>) => Promise.resolve({}));
        const page = makeFakePage({
          getURL: vi.fn(() => "https://x/"),
          getTitle: vi.fn(() => "X"),
          sendCdp,
          executeJavaScript: vi.fn((code: string) => {
            if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
            if (isResolveCall(code)) return Promise.resolve({ found: true, x: 5, y: 6, hitOk: true, matched: "Card", editable: true });
            if (isSelectAllCall(code)) return Promise.resolve({ editable: true });
            // A masked/formatted input rewrote what was inserted.
            if (isReadValueCall(code)) return Promise.resolve({ matches: false, present: true });
            // TYPE_JS itself (the legacy fallback).
            return Promise.resolve({ url: "https://x/", title: "X", matched: "Card" });
          }),
        });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = await controller.act({ action: "type", target: "Card", text: "4242 4242 4242 4242" });
        expect(result).toMatchObject({ via: "dom" });
      });

      it("act type: falls back to TYPE_JS outright when there is no CDP session", async () => {
        const page = makeFakePage({
          getURL: vi.fn(() => "https://x/"),
          getTitle: vi.fn(() => "X"),
          executeJavaScript: vi.fn(() => Promise.resolve({ url: "https://x/", title: "X", matched: "Search" })),
        });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = await controller.act({ action: "type", target: "Search", text: "shoes" });
        expect(result).toMatchObject({ via: "dom" });
      });

      it("perform TYPE_TEXT: routes an index-based type through the trusted-CDP path too", async () => {
        const sendCdp = vi.fn((_method: string, _params?: Record<string, unknown>) => Promise.resolve({}));
        const page = makeFakePage({
          getURL: vi.fn(() => "https://x/"),
          getTitle: vi.fn(() => "X"),
          sendCdp,
          executeJavaScript: vi.fn((code: string) => {
            if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
            if (isResolveCall(code)) return Promise.resolve({ found: true, x: 1, y: 2, hitOk: true, editable: true });
            if (isSelectAllCall(code)) return Promise.resolve({ editable: true });
            if (isReadValueCall(code)) return Promise.resolve({ matches: true, present: true });
            if (isBusyCall(code)) return Promise.resolve({ present: false, busy: false });
            return Promise.resolve({ ok: true });
          }),
        });
        const controller = new BrowserController(makeFakeTarget(page));
        const snapshot = (await controller.snapshot()) as { snapshotId: string };
        const result = await controller.perform({
          snapshotId: snapshot.snapshotId,
          index: 0,
          operation: "TYPE_TEXT",
          text: "hello",
        });
        expect(result).toMatchObject({ via: "cdp" });
        expect(sendCdp).toHaveBeenCalledWith("Input.insertText", { text: "hello" });
      });

      it("code review finding 4: a text match that resolves to a non-editable element (a link/button) is never trusted-clicked — it goes straight to the legacy 'not editable' error", async () => {
        const sendCdp = vi.fn((_method: string, _params?: Record<string, unknown>) => Promise.resolve({}));
        const page = makeFakePage({
          getURL: vi.fn(() => "https://x/"),
          getTitle: vi.fn(() => "X"),
          sendCdp,
          executeJavaScript: vi.fn((code: string) => {
            if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
            if (isResolveCall(code)) {
              // A text match found and hittable, but it's a link, not a
              // text field — CLICK_RESOLVE_JS's own read-only editable check.
              return Promise.resolve({ found: true, x: 5, y: 6, hitOk: true, matched: "Checkout", editable: false });
            }
            // TYPE_JS's legacy path — reached without ever clicking.
            return Promise.resolve({ error: "Element is not editable: Checkout" });
          }),
        });
        const controller = new BrowserController(makeFakeTarget(page));
        const result = await controller.act({ action: "type", target: "Checkout", text: "hi" });
        expect(result).toEqual({ error: "Element is not editable: Checkout" });
        // The whole point: no mouse event of any kind was ever dispatched —
        // clicking a link/button as a side effect of typing is the bug.
        expect(sendCdp).not.toHaveBeenCalledWith("Input.dispatchMouseEvent", expect.anything());
      });
    });

    describe("scroll targeting", () => {
      it("act scroll: a target is passed through to SCROLL_JS for the page script to resolve", async () => {
        const page = makeFakePage({
          executeJavaScript: vi.fn((code: string) => {
            if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
            return Promise.resolve({ url: "https://x/", title: "X" });
          }),
        });
        const controller = new BrowserController(makeFakeTarget(page));
        await controller.act({ action: "scroll", target: "Reviews list" });
        const code = findScriptCall(page.executeJavaScript as ReturnType<typeof vi.fn>, JSON.stringify("Reviews list"));
        expect(code).toContain(JSON.stringify({ amount: 1, target: "Reviews list" }));
      });

      it("act scroll: index+snapshotId is passed through to SCROLL_JS", async () => {
        const page = makeFakePage({
          executeJavaScript: vi.fn((code: string) => {
            if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
            return Promise.resolve({ url: "https://x/", title: "X" });
          }),
        });
        const controller = new BrowserController(makeFakeTarget(page));
        const snapshot = (await controller.snapshot()) as { snapshotId: string };
        (page.executeJavaScript as ReturnType<typeof vi.fn>).mockClear();
        await controller.act({ action: "scroll", index: 2, snapshotId: snapshot.snapshotId });
        const code = findScriptCall(page.executeJavaScript as ReturnType<typeof vi.fn>, JSON.stringify(snapshot.snapshotId));
        expect(code).toContain(JSON.stringify({ amount: 1, index: 2, snapshotId: snapshot.snapshotId }));
      });

      it("perform SCROLL_DOWN: an index+snapshotId targets that container's own scroll, same as act scroll", async () => {
        const page = makeFakePage({
          executeJavaScript: vi.fn((code: string) => {
            if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
            return Promise.resolve({ url: "https://x/", title: "X" });
          }),
        });
        const controller = new BrowserController(makeFakeTarget(page));
        const snapshot = (await controller.snapshot()) as { snapshotId: string };
        (page.executeJavaScript as ReturnType<typeof vi.fn>).mockClear();
        await controller.perform({ snapshotId: snapshot.snapshotId, index: 4, operation: "SCROLL_DOWN" });
        const code = findScriptCall(page.executeJavaScript as ReturnType<typeof vi.fn>, JSON.stringify(snapshot.snapshotId));
        expect(code).toContain(
          JSON.stringify({ snapshotId: snapshot.snapshotId, index: 4, operation: "SCROLL_DOWN", text: undefined }),
        );
      });
    });
  });
});

// Wave 3 reliability (2026-09-24): shadow-DOM piercing is entirely inside
// the page scripts themselves (deepQueryAll) — covered by e2e only, a fake
// executeJavaScript can't prove a real shadow root was traversed. This
// section covers what a unit test *can* prove: frame discovery/routing,
// the console-error ring buffer merge, and the botCheck heuristic wiring.
describe("BrowserController — Wave 3 reliability", () => {
  function isIframeRectsCall(code: unknown): boolean {
    return typeof code === "string" && code.includes('deepQueryAll(document, "iframe")');
  }
  function isBotCheckCall(code: unknown): boolean {
    return typeof code === "string" && code.includes("just a moment");
  }
  function isSnapshotCall(code: unknown): boolean {
    return typeof code === "string" && code.includes("scrollContainerBudget");
  }
  function isReadCall(code: unknown): boolean {
    return typeof code === "string" && code.includes("headingsTruncated");
  }
  function isFindImagesCall(code: unknown): boolean {
    return typeof code === "string" && code.includes("pickLargestSrcsetCandidate");
  }

  const oneChildFrame = { frameId: 7, url: "https://frame.example/", name: "checkout" };
  const frameRect = { url: "https://frame.example/", name: "checkout", x: 10, y: 20, width: 300, height: 150 };

  /** A page with one matched child frame — `listFrames`/`executeJavaScriptInFrame`
   * wired, and the top document's own `IFRAME_RECTS_JS` call reporting a
   * single visible iframe that matches it by url. `frameScript` answers
   * every call actually routed into the frame (SNAPSHOT_JS/READ_JS/
   * FIND_IMAGES_JS/PERFORM_JS); it defaults to a stock response for each. */
  function makeFramedPage(opts: {
    frameScript?: (code: string) => unknown;
    executeJavaScriptInFrame?: (frameId: number, code: string, timeoutMs: number) => Promise<unknown>;
  } = {}) {
    const executeJavaScriptInFrame = vi.fn((frameId: number, code: string, timeoutMs: number) => {
        if (opts.executeJavaScriptInFrame) return opts.executeJavaScriptInFrame(frameId, code, timeoutMs);
        if (opts.frameScript) return Promise.resolve(opts.frameScript(code));
        if (isSnapshotCall(code)) {
          return Promise.resolve({
            url: frameRect.url,
            title: "Checkout Frame",
            elements: [{ index: 0, tag: "button", label: "Pay", ops: ["CLICK"] }],
            scroll: { y: 0, height: 100, atBottom: true },
          });
        }
        if (isReadCall(code)) {
          return Promise.resolve({
            url: frameRect.url,
            title: "Checkout Frame",
            headings: [],
            text: "Pay now",
            links: [],
            truncated: false,
            headingsTruncated: false,
            linksTruncated: false,
          });
        }
        if (isFindImagesCall(code)) {
          return Promise.resolve({ images: [{ url: "https://frame.example/a.png", alt: "", width: 400, height: 400 }], count: 1, pageUrl: frameRect.url });
        }
        return Promise.resolve({ url: frameRect.url, title: "Checkout Frame", __scopedBefore: null, __targetSelfDisabled: false });
      });
    const page = makeFakePage({
      listFrames: vi.fn(() => [oneChildFrame]),
      executeJavaScriptInFrame,
      executeJavaScript: vi.fn((code: string) => {
        if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
        if (isIframeRectsCall(code)) return Promise.resolve({ frames: [frameRect] });
        if (isBotCheckCall(code)) return Promise.resolve({ botCheck: false });
        if (isSnapshotCall(code)) {
          return Promise.resolve({
            url: "https://example.com/",
            title: "Top",
            elements: [],
            scroll: { y: 0, height: 100, atBottom: true },
          });
        }
        if (isReadCall(code)) {
          return Promise.resolve({
            url: "https://example.com/",
            title: "Top",
            headings: [],
            text: "Top text",
            links: [],
            truncated: false,
            headingsTruncated: false,
            linksTruncated: false,
          });
        }
        if (isFindImagesCall(code)) {
          return Promise.resolve({ images: [], count: 0, pageUrl: "https://example.com/" });
        }
        return Promise.resolve({ ok: true });
      }),
    });
    return { page, executeJavaScriptInFrame };
  }

  describe("iframe discovery and routing", () => {
    it("snapshot merges a matched child frame's elements, global-indexed and frame-labeled", async () => {
      const { page } = makeFramedPage();
      const controller = new BrowserController(makeFakeTarget(page));
      const result = (await controller.snapshot()) as { elements: { index: number; frame?: string; label: string }[] };
      expect(result.elements).toHaveLength(1);
      expect(result.elements[0]).toMatchObject({ index: 0, frame: "Checkout Frame", label: "Pay" });
    });

    it("a modal snapshot merges only the child frames whose <iframe> is inside the modal", async () => {
      const inFrame = { frameId: 7, url: "https://in.example/", name: "inside" };
      const outFrame = { frameId: 8, url: "https://out.example/", name: "outside" };
      const executeJavaScriptInFrame = vi.fn((frameId: number) =>
        Promise.resolve({
          url: frameId === 7 ? inFrame.url : outFrame.url,
          title: frameId === 7 ? "In" : "Out",
          elements: [{ index: 0, tag: "button", label: frameId === 7 ? "InsideBtn" : "OutsideBtn", ops: ["CLICK"] }],
        }),
      );
      const page = makeFakePage({
        listFrames: vi.fn(() => [inFrame, outFrame]),
        executeJavaScriptInFrame,
        executeJavaScript: vi.fn((code: string) => {
          if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
          if (isIframeRectsCall(code)) {
            return Promise.resolve({
              frames: [
                { ...frameRect, url: inFrame.url, name: inFrame.name },
                { ...frameRect, url: outFrame.url, name: outFrame.name, y: 400 },
              ],
            });
          }
          if (isSnapshotCall(code)) {
            return Promise.resolve({
              url: "https://example.com/",
              title: "Top",
              modal: "Sign in offer",
              __modalFrames: [{ url: inFrame.url, name: inFrame.name }],
              elements: [{ index: 0, tag: "button", label: "Close", ops: ["CLICK"] }],
              scroll: { y: 0, height: 100, atBottom: true },
            });
          }
          return Promise.resolve({ ok: true });
        }),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = (await controller.snapshot()) as Record<string, unknown> & { elements: { label: string }[] };
      expect(result.modal).toBe("Sign in offer");
      expect(result.elements.map((e) => e.label)).toEqual(["Close", "InsideBtn"]);
      expect(executeJavaScriptInFrame.mock.calls.map((c) => c[0])).toEqual([7]);
      // Internal plumbing never reaches callers.
      expect(result).not.toHaveProperty("__modalFrames");
    });

    it("code review finding 7: a top document reporting the full MAX_SNAPSHOT_ELEMENTS never drives a negative frame budget", async () => {
      // Models the FIXED SNAPSHOT_JS: it never reports more than the
      // maxElements it was given, even on a busy page with scroll
      // containers — so the top document here reports exactly
      // MAX_SNAPSHOT_ELEMENTS elements, never MAX_SNAPSHOT_ELEMENTS + 10
      // (what the pre-fix script could produce by appending containers
      // unconditionally on top of an already-full interactive-element cap).
      const manyElements = Array.from({ length: MAX_SNAPSHOT_ELEMENTS }, (_, i) => ({
        index: i,
        tag: "button",
        label: "Many " + i,
        ops: ["CLICK"],
      }));
      const executeJavaScriptInFrame = vi.fn(() => Promise.resolve({ url: "https://frame.example/", title: "Frame", elements: [] }));
      const page = makeFakePage({
        listFrames: vi.fn(() => [oneChildFrame]),
        executeJavaScriptInFrame,
        executeJavaScript: vi.fn((code: string) => {
          if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
          if (isIframeRectsCall(code)) return Promise.resolve({ frames: [frameRect] });
          if (isSnapshotCall(code)) {
            return Promise.resolve({
              url: "https://example.com/",
              title: "Top",
              elements: manyElements,
              scroll: { y: 0, height: 100, atBottom: true },
            });
          }
          return Promise.resolve({ ok: true });
        }),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = (await controller.snapshot()) as { elements: unknown[] };
      expect(result).not.toHaveProperty("error");
      // The whole point: never more than the documented hard cap, and no
      // exception/negative-argument fallout from a would-be-negative
      // `remaining` — the frame is correctly skipped (budget genuinely
      // exhausted by the top document alone), not crashed past.
      expect(result.elements.length).toBe(MAX_SNAPSHOT_ELEMENTS);
      expect(executeJavaScriptInFrame).not.toHaveBeenCalled();
    });

    it("frame labels never carry a page-controlled blob: a 45KB JSON name is ignored, titles are capped", async () => {
      const bigName = JSON.stringify({ ad: "x".repeat(45_000) });
      const cases = [
        { url: "https://ads.example/slot", name: bigName, title: "", expect: (l: string) => l === "ads.example" },
        { url: "about:blank", name: bigName, title: "", expect: (l: string) => l.length <= 80 && !l.startsWith("{") },
        { url: "https://ads.example/slot", name: "short_name", title: "T".repeat(500), expect: (l: string) => l === "T".repeat(80) },
        { url: "about:blank", name: "checkout frame", title: "", expect: (l: string) => l === "checkout frame" },
        { url: "about:blank", name: "https://x.example/a", title: "", expect: (l: string) => !l.includes("://x.example") },
        // A short name wins over the host, so sibling frames on one host stay distinct.
        { url: "https://ads.example/a", name: "left", title: "", expect: (l: string) => l === "left" },
        { url: "https://ads.example/b", name: "right", title: "", expect: (l: string) => l === "right" },
        { url: "https://ads.example/c", name: "1", title: "", expect: (l: string) => l === "1" },
      ];
      for (const c of cases) {
        const frame = { frameId: 9, url: c.url, name: c.name };
        const rect = { url: c.url, name: c.name, x: 0, y: 0, width: 300, height: 150 };
        const page = makeFakePage({
          listFrames: vi.fn(() => [frame]),
          executeJavaScriptInFrame: vi.fn(() =>
            Promise.resolve({
              url: c.url,
              title: c.title,
              elements: [{ index: 0, tag: "button", label: "Pay", ops: ["CLICK"] }],
              scroll: { y: 0, height: 100, atBottom: true },
            }),
          ),
          executeJavaScript: vi.fn((code: string) => {
            if (isSignatureCall(code) || isCursorCall(code)) return Promise.resolve({ ok: true });
            if (isIframeRectsCall(code)) return Promise.resolve({ frames: [rect] });
            if (isSnapshotCall(code)) {
              return Promise.resolve({ url: "https://example.com/", title: "Top", elements: [], scroll: { y: 0, height: 100, atBottom: true } });
            }
            return Promise.resolve({ ok: true });
          }),
        });
        const result = (await new BrowserController(makeFakeTarget(page)).snapshot()) as { elements: { frame?: string }[] };
        const label = result.elements[0]?.frame ?? "";
        expect(label.length).toBeLessThanOrEqual(80);
        expect(c.expect(label)).toBe(true);
      }
    });

    it("perform CLICK on a frame-routed index runs PERFORM_JS inside that frame, not the top page", async () => {
      const { page, executeJavaScriptInFrame } = makeFramedPage();
      const controller = new BrowserController(makeFakeTarget(page));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      const result = await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });
      expect(result).not.toHaveProperty("error");
      expect(result).toMatchObject({ via: "dom" });
      const frameCall = executeJavaScriptInFrame.mock.calls.find((c) => typeof c[1] === "string" && c[1].includes('"operation":"CLICK"'));
      expect(frameCall).toBeTruthy();
      expect(frameCall![0]).toBe(oneChildFrame.frameId);
      // The frame's own SNAPSHOT_JS numbered its one element "0" — the
      // frameMap must translate the caller's global index (also 0, since
      // it's the only element) back to that same local index.
      expect(frameCall![1]).toContain('"index":0');
    });

    // Code review finding 6: `act`'s scroll/hover/press by index used to
    // always run their page script against the TOP document — ignoring the
    // frame map `snapshot()` built entirely — so any of them targeting an
    // element that actually lived in a child frame failed with "No element
    // matched: index N" (or the operation's own equivalent) instead of
    // acting on it. All three now resolve through the same frame map
    // perform's CLICK/TYPE_TEXT/SELECT already used.

    it("act scroll on a frame-routed index runs SCROLL_JS inside that frame, not the top page", async () => {
      const frameScript = vi.fn((code: string) => {
        if (code.includes("scrollContainerBudget")) {
          return {
            url: frameRect.url,
            title: "Checkout Frame",
            elements: [{ index: 0, tag: "div", label: "Order summary", ops: [], scrollable: true }],
            scroll: { y: 0, height: 100, atBottom: false },
          };
        }
        // SCROLL_JS itself.
        return { url: frameRect.url, title: "Checkout Frame" };
      });
      const { page, executeJavaScriptInFrame } = makeFramedPage({ frameScript });
      const controller = new BrowserController(makeFakeTarget(page));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      const result = await controller.act({ action: "scroll", index: 0, snapshotId: snapshot.snapshotId });
      expect(result).not.toHaveProperty("error");
      const frameCall = executeJavaScriptInFrame.mock.calls.find(
        (c) => typeof c[1] === "string" && c[1].includes("No scrollable container found for that target."),
      );
      expect(frameCall).toBeTruthy();
      expect(frameCall![0]).toBe(oneChildFrame.frameId);
      expect(frameCall![1]).toContain('"index":0');
    });

    it("act hover on a frame-routed index runs HOVER_TARGET_JS inside that frame, and adds the frame's own viewport offset to the trusted mouseMoved coordinates", async () => {
      const sendCdp = vi.fn((_method: string, _params?: Record<string, unknown>) => Promise.resolve({}));
      const frameScript = vi.fn((code: string) => {
        if (code.includes("scrollContainerBudget")) {
          return {
            url: frameRect.url,
            title: "Checkout Frame",
            elements: [{ index: 0, tag: "button", label: "Pay", ops: ["CLICK"] }],
            scroll: { y: 0, height: 100, atBottom: true },
          };
        }
        if (code.includes("y: rect.top + rect.height / 2,")) {
          // HOVER_TARGET_JS itself — coordinates local to the frame's own
          // document (frameRect is { x: 10, y: 20, width: 300, height: 150 }).
          return { found: true, x: 15, y: 25 };
        }
        return { url: frameRect.url, title: "Checkout Frame" };
      });
      const { page, executeJavaScriptInFrame } = makeFramedPage({ frameScript });
      const pageWithCdp = { ...page, sendCdp };
      const controller = new BrowserController(makeFakeTarget(pageWithCdp));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      const result = await controller.act({ action: "hover", index: 0, snapshotId: snapshot.snapshotId });
      expect(result).not.toHaveProperty("error");
      const frameCall = executeJavaScriptInFrame.mock.calls.find(
        (c) => typeof c[1] === "string" && c[1].includes("y: rect.top + rect.height / 2,"),
      );
      expect(frameCall).toBeTruthy();
      expect(frameCall![0]).toBe(oneChildFrame.frameId);
      // Frame-local (15, 25) + the frame's own top-level-viewport offset
      // (10, 20) from frameRect = (25, 45).
      expect(sendCdp).toHaveBeenCalledWith(
        "Input.dispatchMouseEvent",
        expect.objectContaining({ type: "mouseMoved", x: 25, y: 45 }),
      );
    });

    it("act press with a frame-routed focus index focuses FOCUS_JS inside that frame before dispatching the key", async () => {
      const sendCdp = vi.fn((_method: string, _params?: Record<string, unknown>) => Promise.resolve({}));
      const frameScript = vi.fn((code: string) => {
        if (code.includes("scrollContainerBudget")) {
          return {
            url: frameRect.url,
            title: "Checkout Frame",
            elements: [{ index: 0, tag: "input", label: "Card number", ops: ["TYPE_TEXT"] }],
            scroll: { y: 0, height: 100, atBottom: true },
          };
        }
        if (code.includes("focused: true")) {
          // FOCUS_JS itself.
          return { focused: true };
        }
        return { url: frameRect.url, title: "Checkout Frame" };
      });
      const { page, executeJavaScriptInFrame } = makeFramedPage({ frameScript });
      const pageWithCdp = { ...page, sendCdp };
      const controller = new BrowserController(makeFakeTarget(pageWithCdp));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      const result = await controller.act({ action: "press", key: "Tab", index: 0, snapshotId: snapshot.snapshotId });
      expect(result).not.toHaveProperty("error");
      const frameCall = executeJavaScriptInFrame.mock.calls.find(
        (c) => typeof c[1] === "string" && c[1].includes("focused: true"),
      );
      expect(frameCall).toBeTruthy();
      expect(frameCall![0]).toBe(oneChildFrame.frameId);
      expect(frameCall![1]).toContain('"index":0');
      // The key dispatch itself needs no frame routing — CDP keyboard
      // input targets whichever frame currently holds focus.
      expect(sendCdp).toHaveBeenCalledWith("Input.dispatchKeyEvent", expect.objectContaining({ code: "Tab" }));
    });

    it("a frame whose script call rejects (electron#5183 timeout) is skipped, not fatal", async () => {
      const executeJavaScriptInFrame = vi.fn(() => Promise.reject(new Error("Frame script timed out after 1500ms.")));
      const { page } = makeFramedPage({ executeJavaScriptInFrame });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = (await controller.snapshot()) as { elements: unknown[] };
      expect(result).not.toHaveProperty("error");
      expect(result.elements).toHaveLength(0);
    });

    it("findImages merges a child frame's images with the top document's own", async () => {
      const { page } = makeFramedPage();
      const controller = new BrowserController(makeFakeTarget(page));
      const result = (await controller.findImages({})) as { images: { url: string }[]; count: number };
      expect(result.count).toBe(1);
      expect(result.images[0].url).toBe("https://frame.example/a.png");
    });

    it("read appends a child frame's text with a [frame: X] header", async () => {
      const { page } = makeFramedPage();
      const controller = new BrowserController(makeFakeTarget(page));
      const result = (await controller.read({})) as { text: string };
      expect(result.text).toContain("Top text");
      expect(result.text).toContain("[frame: Checkout Frame]");
      expect(result.text).toContain("Pay now");
    });

    it("read with a selector does not descend into frames", async () => {
      const { page, executeJavaScriptInFrame } = makeFramedPage();
      const controller = new BrowserController(makeFakeTarget(page));
      await controller.read({ selector: "h1" });
      expect(executeJavaScriptInFrame).not.toHaveBeenCalled();
    });

    it("a page/target with no frame support behaves exactly as before Wave 3", async () => {
      const page = makeFakePage();
      const controller = new BrowserController(makeFakeTarget(page));
      const result = (await controller.snapshot()) as { elements: unknown[] };
      expect(result).not.toHaveProperty("error");
    });
  });

  describe("console error ring buffer", () => {
    it("act attaches consoleErrors (max 20) when the tab reports new ones", async () => {
      const drainConsoleErrors = vi.fn(() => ["TypeError: boom", "ReferenceError: x is not defined"]);
      const page = makeFakePage({
        drainConsoleErrors,
        executeJavaScript: vi.fn((code: string) =>
          isSignatureCall(code) || isCursorCall(code) ? Promise.resolve({ ok: true }) : Promise.resolve({ matched: "Go" }),
        ),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.act({ action: "click", target: "Go" });
      expect(result).toMatchObject({ consoleErrors: ["TypeError: boom", "ReferenceError: x is not defined"] });
      expect(drainConsoleErrors).toHaveBeenCalledTimes(1);
    });

    it("act keeps the last 20 distinct consoleErrors and counts the older ones", async () => {
      const drainConsoleErrors = vi.fn(() => Array.from({ length: 25 }, (_, i) => `Error ${i}`));
      const page = makeFakePage({
        drainConsoleErrors,
        executeJavaScript: vi.fn((code: string) =>
          isSignatureCall(code) || isCursorCall(code) ? Promise.resolve({ ok: true }) : Promise.resolve({ matched: "Go" }),
        ),
      });
      const result = (await new BrowserController(makeFakeTarget(page)).act({ action: "click", target: "Go" })) as { consoleErrors: string[]; consoleErrorsDropped: number };
      expect(result.consoleErrors).toHaveLength(20);
      expect(result.consoleErrors[19]).toBe("Error 24");
      expect(result.consoleErrorsDropped).toBe(5);
    });

    it("perform omits consoleErrors entirely when there are none", async () => {
      const page = makeFakePage({ drainConsoleErrors: vi.fn(() => []) });
      const controller = new BrowserController(makeFakeTarget(page));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      const result = await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "SCROLL_DOWN" });
      expect(result).not.toHaveProperty("consoleErrors");
    });

    it("a page with no drainConsoleErrors (unit-test fakes predating Wave 3) is unaffected", async () => {
      const page = makeFakePage();
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.act({ action: "wait", ms: 1 });
      expect(result).not.toHaveProperty("consoleErrors");
    });
  });

  describe("botCheck on open", () => {
    it("open reports botCheck: true when the page looks like a challenge wall", async () => {
      const page = makeFakePage({
        getTitle: vi.fn(() => "Just a moment..."),
        executeJavaScript: vi.fn((code: string) => {
          if (isBotCheckCall(code)) return Promise.resolve({ botCheck: true });
          return Promise.resolve({ ok: true });
        }),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.open({ url: "https://example.com/" });
      expect(result).toMatchObject({ botCheck: true });
    });

    it("open omits botCheck entirely on an ordinary page", async () => {
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) => {
          if (isBotCheckCall(code)) return Promise.resolve({ botCheck: false });
          return Promise.resolve({ ok: true });
        }),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.open({ url: "https://example.com/" });
      expect(result).not.toHaveProperty("botCheck");
    });

    it("a botCheck script that throws never fails a successful open", async () => {
      const page = makeFakePage({
        executeJavaScript: vi.fn((code: string) => {
          if (isBotCheckCall(code)) return Promise.reject(new Error("boom"));
          return Promise.resolve({ ok: true });
        }),
      });
      const controller = new BrowserController(makeFakeTarget(page));
      const result = await controller.open({ url: "https://example.com/" });
      expect(result).not.toHaveProperty("error");
      expect(result).not.toHaveProperty("botCheck");
    });
  });
});

// Autocomplete settle: a type into a combobox returned after the 50ms settle,
// before the debounced suggestions existed, so the next snapshot had no
// `role=option` to offer. The controller now waits (bounded) for the field's
// visible options to appear and stop changing.
describe("autocomplete settle after typing", () => {
  /** AUTOCOMPLETE_STATE_JS is the only script containing this literal. */
  function isAutocompleteCall(code: unknown): boolean {
    return typeof code === "string" && code.includes("autocomplete: false");
  }

  /** The pre-typing baseline probe is the only AUTOCOMPLETE_STATE_JS call carrying this arg. */
  function isBaselineCall(code: unknown): boolean {
    return typeof code === "string" && code.includes('"baseline":true');
  }

  function makeTypePage(answer: (call: number) => unknown, baselineAnswer: () => unknown = () => ({ docOptions: 0, docHash: 0 })) {
    const order: string[] = [];
    let calls = 0;
    const page = makeFakePage({
      executeJavaScript: vi.fn((code: string) => {
        if (isSignatureCall(code)) {
          order.push("signature");
          return Promise.resolve({
            url: "https://example.com/",
            title: "Example",
            nodeCount: 1,
            textLength: 0,
            textHash: 0,
            mainImageSrc: "",
            scrollY: 0,
            focusedValueLength: 0,
          });
        }
        if (isAutocompleteCall(code) && isBaselineCall(code)) {
          order.push("baseline");
          return Promise.resolve(baselineAnswer());
        }
        if (isAutocompleteCall(code)) {
          const n = calls++;
          order.push("probe");
          const value = answer(n);
          return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
        }
        order.push("action");
        return Promise.resolve({ url: "https://example.com/", title: "Example" });
      }),
    });
    return { page, order, probes: () => calls };
  }

  async function typeInto(controller: BrowserController, advanceMs: number) {
    const snapshot = (await controller.snapshot()) as { snapshotId: string };
    const promise = controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "TYPE_TEXT", text: "Barcelona" });
    await vi.advanceTimersByTimeAsync(advanceMs);
    return promise;
  }

  it("polls an autocomplete field until its options are present and unchanged across two polls, before the after-capture", async () => {
    vi.useFakeTimers();
    try {
      const answers = [
        { autocomplete: true, options: 0, hash: 0 },
        { autocomplete: true, options: 3, hash: 11 },
        { autocomplete: true, options: 5, hash: 22 },
        { autocomplete: true, options: 5, hash: 22 },
      ];
      const { page, order, probes } = makeTypePage((n) => answers[Math.min(n, answers.length - 1)]);
      const result = await typeInto(new BrowserController(makeFakeTarget(page)), 1_000);

      expect(probes()).toBe(4);
      expect(order.slice(order.lastIndexOf("action"))).toEqual(["action", "probe", "probe", "probe", "probe", "signature"]);
      // The baseline is taken before the text goes in (before the action).
      expect(order.indexOf("baseline")).toBeGreaterThan(-1);
      expect(order.indexOf("baseline")).toBeLessThan(order.lastIndexOf("action"));
      expect(result).not.toHaveProperty("error");
      expect(result).not.toHaveProperty("autocomplete");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a plain field costs one baseline probe before, one probe after, and no wait", async () => {
    const { page, probes, order } = makeTypePage(() => ({ autocomplete: false }));
    const controller = new BrowserController(makeFakeTarget(page));
    const snapshot = (await controller.snapshot()) as { snapshotId: string };
    // Real timers: anything beyond the 50ms settle would be a poll interval.
    await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "TYPE_TEXT", text: "hi" });
    expect(probes()).toBe(1);
    expect(order.filter((o) => o === "baseline")).toHaveLength(1);
  });

  it("does not take a stale focus-time list for the settled suggestions", async () => {
    vi.useFakeTimers();
    try {
      const stale = { autocomplete: true, options: 3, hash: 5, docOptions: 3, docHash: 5 };
      const real = { autocomplete: true, options: 4, hash: 9, docOptions: 4, docHash: 9 };
      // Three stale polls (stable, yet the same as the baseline), then the real list.
      const { page, probes } = makeTypePage((n) => (n < 3 ? stale : real), () => ({ docOptions: 3, docHash: 5 }));
      const result = await typeInto(new BrowserController(makeFakeTarget(page)), 1_500);
      expect(result).not.toHaveProperty("error");
      // 3 stale + 2 real (changed, then stable across two polls).
      expect(probes()).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits out the cap when the list never differs from the baseline", async () => {
    vi.useFakeTimers();
    try {
      const stale = { autocomplete: true, options: 3, hash: 5, docOptions: 3, docHash: 5 };
      const { page, probes } = makeTypePage(() => stale, () => ({ docOptions: 3, docHash: 5 }));
      await typeInto(new BrowserController(makeFakeTarget(page)), AUTOCOMPLETE_SETTLE_MS + 500);
      expect(probes()).toBeGreaterThan(10);
      expect(probes()).toBeLessThanOrEqual(AUTOCOMPLETE_SETTLE_MS / 100 + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the wait entirely when the command deadline has no headroom left", async () => {
    vi.useFakeTimers();
    try {
      const { page, probes } = makeTypePage(() => ({ autocomplete: true, options: 0, hash: 0 }));
      const controller = new BrowserController(makeFakeTarget(page), { timeoutMs: SETTLE_HEADROOM_MS - 200, cursor: false });
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      const promise = controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "TYPE_TEXT", text: "hi" });
      await vi.advanceTimersByTimeAsync(3_000);
      const result = await promise;
      expect(result).not.toHaveProperty("error");
      expect(probes()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up at the cap when no suggestion ever shows up, rather than hanging the command", async () => {
    vi.useFakeTimers();
    try {
      const { page, probes } = makeTypePage(() => ({ autocomplete: true, options: 0, hash: 0 }));
      const promise = typeInto(new BrowserController(makeFakeTarget(page)), AUTOCOMPLETE_SETTLE_MS + 500);
      const result = await promise;
      expect(result).not.toHaveProperty("error");
      // ~100ms interval inside a 2s cap: bounded, and more than one poll.
      expect(probes()).toBeGreaterThan(1);
      expect(probes()).toBeLessThanOrEqual(AUTOCOMPLETE_SETTLE_MS / 100 + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a throwing or error-returning probe never turns a successful type into an error", async () => {
    for (const answer of [() => new Error("boom"), () => ({ error: "nope" })]) {
      const { page } = makeTypePage(answer);
      const controller = new BrowserController(makeFakeTarget(page));
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      const result = await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "TYPE_TEXT", text: "hi" });
      expect(result).not.toHaveProperty("error");
      expect(result).toMatchObject({ url: "https://example.com/" });
    }
  });

  // Plain text fields (no ARIA autocomplete hints): wait only for activity
  // that starts after the text went in; see settleAutocomplete.
  describe("plain field suggestions", () => {
    function makePlainPage(opts: {
      probe: (call: number, elapsedMs: number) => unknown;
      domActivityAtMs?: number;
      networkAtMs?: number;
      failActionsAfterBaseline?: boolean;
    }) {
      const t0 = Date.now();
      let calls = 0;
      let baselineSeen = false;
      const log = { uninstall: 0, install: 0 };
      const page = makeFakePage({
        networkStats: vi.fn(() => ({
          pending: 0,
          generation: opts.networkAtMs !== undefined && Date.now() - t0 >= opts.networkAtMs ? 1 : 0,
        })),
        executeJavaScript: vi.fn((code: string) => {
          if (isSignatureCall(code)) {
            return Promise.resolve({ url: "https://example.com/", title: "Example", nodeCount: 1, textLength: 0, textHash: 0, mainImageSrc: "", scrollY: 0, focusedValueLength: 0 });
          }
          if (typeof code === "string" && code.includes("__penSuggestDom")) {
            if (code.includes('"action":"install"')) log.install++;
            if (code.includes('"action":"uninstall"')) log.uninstall++;
            if (code.includes('"action":"check"')) {
              const at = opts.domActivityAtMs;
              const now = Date.now() - t0;
              return Promise.resolve(at !== undefined && now >= at ? { mutated: true, ageMs: now - at } : { mutated: false, ageMs: null });
            }
            return Promise.resolve({ ok: true });
          }
          if (isAutocompleteCall(code) && isBaselineCall(code)) {
            baselineSeen = true;
            return Promise.resolve({ docOptions: 0, docHash: 0, plain: true });
          }
          if (isAutocompleteCall(code)) return Promise.resolve(opts.probe(calls++, Date.now() - t0));
          if (baselineSeen && opts.failActionsAfterBaseline) return Promise.resolve({ error: "boom" });
          return Promise.resolve({ url: "https://example.com/", title: "Example" });
        }),
      });
      return { page, log, probes: () => calls };
    }

    const eligible = { autocomplete: false, plainEligible: true };
    const shown = { autocomplete: true, options: 2, hash: 9, docOptions: 2, docHash: 9 };

    it("waits for the list once typing started a request, returning when it is stable across two polls", async () => {
      vi.useFakeTimers();
      try {
        const { page, probes } = makePlainPage({
          networkAtMs: 0,
          probe: (_n, ms) => (ms < 500 ? eligible : shown),
        });
        const result = await typeInto(new BrowserController(makeFakeTarget(page)), 2_000);
        expect(result).not.toHaveProperty("error");
        // eligible polls until the list shows, then two equal polls.
        expect(probes()).toBeGreaterThanOrEqual(3);
        expect(probes()).toBeLessThanOrEqual(30);
      } finally {
        vi.useRealTimers();
      }
    });

    it("leaves after the activity window when nothing happened (a plain field stays fast)", async () => {
      vi.useFakeTimers();
      try {
        const { page, probes } = makePlainPage({ probe: () => eligible });
        const started = Date.now();
        await typeInto(new BrowserController(makeFakeTarget(page)), 2_000);
        // ~400ms window at 50ms polls; well under the 1200ms cap.
        expect(probes()).toBeLessThanOrEqual(12);
        expect(Date.now() - started).toBeGreaterThanOrEqual(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops once activity has been quiet for 300ms with no popup, long before the cap", async () => {
      vi.useFakeTimers();
      try {
        const { page, probes } = makePlainPage({ domActivityAtMs: 0, probe: () => eligible });
        await typeInto(new BrowserController(makeFakeTarget(page)), 3_000);
        // Quiet since t=0 (ageMs grows): done after ~300ms, i.e. ~7 polls, far below 1200/50.
        expect(probes()).toBeLessThan(12);
      } finally {
        vi.useRealTimers();
      }
    });

    it("never accepts a list identical to the pre-type one", async () => {
      vi.useFakeTimers();
      try {
        const stale = { autocomplete: true, options: 2, hash: 9, docOptions: 2, docHash: 9 };
        const { page } = makePlainPage({ networkAtMs: 0, probe: () => stale });
        let probeCount = 0;
        const probes = () => probeCount;
        // baseline for this page reports plain with an empty doc digest, so
        // freshness passes; give it a matching baseline instead:
        (page.executeJavaScript as ReturnType<typeof vi.fn>).mockImplementation((code: string) => {
          if (isSignatureCall(code)) {
            return Promise.resolve({ url: "https://example.com/", title: "Example", nodeCount: 1, textLength: 0, textHash: 0, mainImageSrc: "", scrollY: 0, focusedValueLength: 0 });
          }
          if (typeof code === "string" && code.includes("__penSuggestDom")) return Promise.resolve({ ok: true });
          if (isAutocompleteCall(code) && isBaselineCall(code)) return Promise.resolve({ docOptions: 2, docHash: 9, plain: true });
          if (isAutocompleteCall(code)) {
            probeCount++;
            return Promise.resolve(stale);
          }
          return Promise.resolve({ url: "https://example.com/", title: "Example" });
        });
        await typeInto(new BrowserController(makeFakeTarget(page)), 3_000);
        // Identical to the baseline: polled until the 1200ms plain cap.
        expect(probes()).toBeGreaterThan(5);
        expect(probes()).toBeLessThanOrEqual(1_200 / 100 + 2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("always uninstalls the activity observer, even when the type fails", async () => {
      for (const failActionsAfterBaseline of [false, true]) {
        const { page, log } = makePlainPage({ probe: () => ({ autocomplete: false }), failActionsAfterBaseline });
        const controller = new BrowserController(makeFakeTarget(page));
        const snapshot = (await controller.snapshot()) as { snapshotId: string };
        const result = await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "TYPE_TEXT", text: "hi" });
        if (failActionsAfterBaseline) expect(result).toHaveProperty("error");
        expect(log.install).toBe(1);
        expect(log.uninstall).toBe(1);
      }
    });
  });
});

// Late click effects: a site that animates a change behind a CSS transition
// (Google Flights' calendar "Done") changes the page AFTER the settle, so the
// single after-capture reported "no effect". A same-URL `changed: false` click
// now re-captures (bounded); a click on a dialog-dismissing control also waits
// for that dialog to close first.
describe("late click effects", () => {
  /** DISMISS_DIALOG_STATE_JS is the only script containing this literal. */
  function isDialogStateCall(code: unknown): boolean {
    return typeof code === "string" && code.includes("return { closed: true }");
  }

  function sig(extra: Record<string, unknown> = {}) {
    return {
      url: "https://example.com/",
      title: "Example",
      nodeCount: 0,
      textLength: 0,
      textHash: 0,
      mainImageSrc: "",
      scrollY: 0,
      focusedValueLength: 0,
      ...extra,
    };
  }

  /** `afterAnswer(n)` answers the n-th "after" capture (0-based). */
  function makeClickPage(opts: {
    afterAnswer?: (n: number) => Record<string, unknown>;
    dismissDialog?: boolean;
    dialogClosedAt?: (probe: number) => boolean;
  }) {
    const order: string[] = [];
    let afters = 0;
    let dialogProbes = 0;
    const keeps: boolean[] = [];
    const page = makeFakePage({
      executeJavaScript: vi.fn((code: string) => {
        if (isSignatureCall(code)) {
          if (code.includes('"phase":"after"')) {
            keeps.push(code.includes('"keep":true'));
            order.push("after");
            const n = afters++;
            return Promise.resolve(sig(opts.afterAnswer ? opts.afterAnswer(n) : {}));
          }
          order.push("before");
          return Promise.resolve(sig());
        }
        if (isRevealCall(code)) return Promise.resolve({ found: true, hitOk: true, dismissDialog: opts.dismissDialog === true });
        if (isDialogStateCall(code)) {
          order.push("dialog");
          return Promise.resolve({ closed: opts.dialogClosedAt ? opts.dialogClosedAt(dialogProbes++) : true });
        }
        if (isCursorCall(code)) return Promise.resolve({ ok: true });
        order.push("action");
        return Promise.resolve({ url: "https://example.com/", title: "Example" });
      }),
    });
    return { page, order, keeps, afters: () => afters, dialogProbes: () => dialogProbes };
  }

  async function clickWith(page: BrowserPageHandle, advanceMs: number) {
    const controller = new BrowserController(makeFakeTarget(page));
    const snapshot = (await controller.snapshot()) as { snapshotId: string };
    const promise = controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });
    await vi.advanceTimersByTimeAsync(advanceMs);
    return promise;
  }

  it("re-captures until a late effect shows up and reports it as changed", async () => {
    vi.useFakeTimers();
    try {
      const { page, keeps } = makeClickPage({ afterAnswer: (n) => (n >= 2 ? sig({ scrollY: 40 }) : sig()) });
      const result = await clickWith(page, 2_000);
      expect(result).toMatchObject({ changed: true });
      expect((result as { changes: string[] }).changes).toContain("scroll");
      // The observer is kept across the peeks so the final capture still has the dom/text evidence.
      expect(keeps.slice(0, 2)).toEqual([true, true]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns changed:false after the cap when nothing ever changes", async () => {
    vi.useFakeTimers();
    try {
      const { page, keeps, afters } = makeClickPage({});
      const result = await clickWith(page, LATE_CLICK_EFFECT_MS + 1_000);
      expect(result).toMatchObject({ changed: false, changes: [] });
      expect(afters()).toBeGreaterThan(2);
      expect(afters()).toBeLessThanOrEqual(LATE_CLICK_EFFECT_MS / 150 + 2);
      // The last capture releases the observer.
      expect(keeps[keeps.length - 1]).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops re-checking as soon as pageChanged shows up, even though changed stays false", async () => {
    vi.useFakeTimers();
    try {
      const { page, afters } = makeClickPage({ afterAnswer: (n) => (n >= 1 ? sig({ pageChanged: true, appeared: ["Added"] }) : sig()) });
      const result = await clickWith(page, 2_000);
      expect(result).toMatchObject({ changed: false, pageChanged: true });
      expect(afters()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start the late loop when a tab already opened", async () => {
    const { page, afters } = makeClickPage({});
    let listings = 0;
    const target = makeFakeTarget(page);
    target.listPages = vi.fn(async () => {
      const tabs = [{ tabId: 1, url: "https://example.com/", title: "Example", current: true }];
      return listings++ === 0 ? tabs : [...tabs, { tabId: 2, url: "https://popup/", title: "Popup", current: false }];
    });
    const controller = new BrowserController(target);
    const snapshot = (await controller.snapshot()) as { snapshotId: string };
    const result = await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });
    expect(result).toMatchObject({ openedTab: { tabId: 2 } });
    expect(afters()).toBe(1);
  });

  it("the late loop and the dialog wait stop before the command deadline (headroom) instead of timing the click out", async () => {
    vi.useFakeTimers();
    try {
      const { page, dialogProbes } = makeClickPage({ dismissDialog: true, dialogClosedAt: () => false });
      const controller = new BrowserController(makeFakeTarget(page), { timeoutMs: SETTLE_HEADROOM_MS + 600, cursor: false });
      const snapshot = (await controller.snapshot()) as { snapshotId: string };
      const promise = controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });
      await vi.advanceTimersByTimeAsync(SETTLE_HEADROOM_MS + 2_000);
      const result = await promise;
      expect(result).not.toHaveProperty("error");
      // The dialog wait was capped at ~600ms minus what the click settle used.
      expect(dialogProbes()).toBeLessThanOrEqual(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands the before-capture's id to every after-capture, and sends none when the before failed", async () => {
    const codes: string[] = [];
    let failBefore = false;
    const base = makeClickPage({ afterAnswer: () => sig({ scrollY: 5 }) });
    const impl = (base.page.executeJavaScript as ReturnType<typeof vi.fn>).getMockImplementation() as (c: string) => Promise<unknown>;
    (base.page.executeJavaScript as ReturnType<typeof vi.fn>).mockImplementation((code: string) => {
      if (isSignatureCall(code)) {
        codes.push(code);
        if (failBefore && !code.includes('"phase":"after"')) return Promise.reject(new Error("boom"));
        if (!code.includes('"phase":"after"')) return Promise.resolve(sig({ captureId: "cap-1" }));
      }
      return impl(code);
    });
    const controller = new BrowserController(makeFakeTarget(base.page));
    const snapshot = (await controller.snapshot()) as { snapshotId: string };
    await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });
    expect(codes[codes.length - 1]).toContain('"captureId":"cap-1"');
    // A later action whose own before fails must not reuse cap-1's state.
    failBefore = true;
    await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });
    expect(codes[codes.length - 1]).not.toContain('"captureId":');
  });

  it("an ordinary immediate change costs one capture and no extra wait", async () => {
    const { page, afters } = makeClickPage({ afterAnswer: () => sig({ scrollY: 10 }) });
    const controller = new BrowserController(makeFakeTarget(page));
    const snapshot = (await controller.snapshot()) as { snapshotId: string };
    // Real timers: a re-check poll would add 150 ms and a second capture.
    const result = await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });
    expect(result).toMatchObject({ changed: true });
    expect(afters()).toBe(1);
  });

  it("waits for a dismissed dialog to close before the after-capture", async () => {
    vi.useFakeTimers();
    try {
      const { page, order, dialogProbes } = makeClickPage({
        dismissDialog: true,
        dialogClosedAt: (n) => n >= 3,
      });
      const result = await clickWith(page, 2_000);
      expect(dialogProbes()).toBe(4);
      const actionAt = order.lastIndexOf("action");
      expect(order.slice(actionAt, actionAt + 6)).toEqual(["action", "dialog", "dialog", "dialog", "dialog", "after"]);
      // Nothing else moved (the hidden button's own signature is unchanged):
      // the closed dialog itself is the reported effect, with no late polling.
      expect(result).toMatchObject({ changed: true, changes: ["dialog"] });
      expect(order.filter((o) => o === "after")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a dialog that never closes at the cap", async () => {
    vi.useFakeTimers();
    try {
      const { page, dialogProbes } = makeClickPage({ dismissDialog: true, dialogClosedAt: () => false });
      await clickWith(page, DIALOG_DISMISS_SETTLE_MS + LATE_CLICK_EFFECT_MS + 1_000);
      expect(dialogProbes()).toBeGreaterThan(1);
      expect(dialogProbes()).toBeLessThanOrEqual(DIALOG_DISMISS_SETTLE_MS / 100 + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a click inside a dialog that is not dismissing (a day cell) never probes the dialog", async () => {
    vi.useFakeTimers();
    try {
      const { page, dialogProbes } = makeClickPage({ dismissDialog: false, afterAnswer: () => sig({ scrollY: 5 }) });
      await clickWith(page, 500);
      expect(dialogProbes()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failing dialog probe never turns the click into an error", async () => {
    const { page } = makeClickPage({ dismissDialog: true, afterAnswer: () => sig({ scrollY: 5 }) });
    const original = page.executeJavaScript as ReturnType<typeof vi.fn>;
    const impl = original.getMockImplementation()!;
    original.mockImplementation((code: string) => (isDialogStateCall(code) ? Promise.reject(new Error("boom")) : (impl as (c: string) => Promise<unknown>)(code)));
    const controller = new BrowserController(makeFakeTarget(page));
    const snapshot = (await controller.snapshot()) as { snapshotId: string };
    const result = await controller.perform({ snapshotId: snapshot.snapshotId, index: 0, operation: "CLICK" });
    expect(result).not.toHaveProperty("error");
    expect(result).toMatchObject({ changed: true });
  });
});

describe("human cursor motion style and live settings", () => {
  const cursorCodes = (page: BrowserPageHandle) =>
    (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as string)
      .filter((code) => isCursorCall(code));

  it("passes the configured style through in the CURSOR_JS args", async () => {
    const page = makeFakePage();
    const controller = new BrowserController(makeFakeTarget(page), { cursorMotion: "comet_swoop" });
    await controller.act({ action: "click", target: "Buy now" });
    expect(cursorCodes(page)[0]).toContain(
      JSON.stringify({ action: "click", target: "Buy now", from: null, style: "comet_swoop" }),
    );
  });

  it("omits style entirely when none is configured", async () => {
    const page = makeFakePage();
    const controller = new BrowserController(makeFakeTarget(page));
    await controller.act({ action: "click", target: "Buy now" });
    expect(cursorCodes(page)[0]).not.toContain('"style"');
  });

  it("re-reads a style getter on every move", async () => {
    const page = makeFakePage();
    let style: string | undefined = "magnetic";
    const controller = new BrowserController(makeFakeTarget(page), { cursorMotion: () => style });
    await controller.act({ action: "click", target: "One" });
    style = "classic";
    await controller.act({ action: "click", target: "Two" });
    style = undefined;
    await controller.act({ action: "click", target: "Three" });
    const codes = cursorCodes(page);
    expect(codes[0]).toContain('"style":"magnetic"');
    expect(codes[1]).toContain('"style":"classic"');
    expect(codes[2]).not.toContain('"style"');
  });

  it("reads the enabled getter ONCE per command: a flip mid-command cannot desync budget and cursor step", async () => {
    // true on the first read, false on any later one. A command that read it
    // twice (budget, then cursor step) would grant the budget but skip the step.
    const page = makeFakePage();
    let reads = 0;
    const controller = new BrowserController(makeFakeTarget(page), {
      cursor: () => ++reads === 1,
    });
    await controller.act({ action: "click", target: "One" });
    expect(cursorCodes(page).length).toBe(1);
    expect(reads).toBe(1);

    // And the opposite flip: false first (no budget) -> the cursor step is skipped too.
    const page2 = makeFakePage();
    let reads2 = 0;
    const controller2 = new BrowserController(makeFakeTarget(page2), { cursor: () => ++reads2 !== 1 });
    await controller2.act({ action: "click", target: "One" });
    expect(cursorCodes(page2).length).toBe(0);
    expect(reads2).toBe(1);
  });

  it("re-reads an enabled getter: toggling it off stops cursor calls, on resumes them", async () => {
    const page = makeFakePage();
    let enabled = true;
    const controller = new BrowserController(makeFakeTarget(page), { cursor: () => enabled });
    await controller.act({ action: "click", target: "One" });
    enabled = false;
    await controller.act({ action: "click", target: "Two" });
    expect(cursorCodes(page).length).toBe(1);
    enabled = true;
    await controller.act({ action: "click", target: "Three" });
    expect(cursorCodes(page).length).toBe(2);
  });
});

describe("cursor overlay around screenshots and menu toggles", () => {
  const isVisibilityCall = (code: unknown) => typeof code === "string" && code.includes("wasHidden");
  const shotPage = (order: string[], changed = true) =>
    makeFakePage({
      executeJavaScript: vi.fn((code: string) => {
        if (isVisibilityCall(code)) {
          order.push(code.includes('"hidden":true') ? "hide" : "restore");
          return Promise.resolve({ changed });
        }
        return Promise.resolve({ ok: true });
      }),
      capture: vi.fn(() => {
        order.push("capture");
        return Promise.resolve({ imageData: "data:image/jpeg;base64,X", width: 1, height: 1 });
      }),
    });

  it("hides the overlay around the capture and restores it after", async () => {
    const order: string[] = [];
    const controller = new BrowserController(makeFakeTarget(shotPage(order)));
    await controller.screenshot(undefined);
    expect(order).toEqual(["hide", "capture", "restore"]);
  });

  it("skips the hide step entirely when the cursor is disabled", async () => {
    const order: string[] = [];
    const controller = new BrowserController(makeFakeTarget(shotPage(order)), { cursor: false });
    await controller.screenshot(undefined);
    expect(order).toEqual(["capture"]);
  });

  it("does not restore when the overlay reported no change (absent or already faded)", async () => {
    const order: string[] = [];
    const controller = new BrowserController(makeFakeTarget(shotPage(order, false)));
    await controller.screenshot(undefined);
    expect(order).toEqual(["hide", "capture"]);
  });

  it("hideCursorOverlay hides on the current page, never throws, and tolerates no page", async () => {
    const order: string[] = [];
    const page = shotPage(order);
    await new BrowserController(makeFakeTarget(page)).hideCursorOverlay();
    expect(order).toEqual(["hide"]);
    await expect(new BrowserController(makeFakeTarget(null)).hideCursorOverlay()).resolves.toBeUndefined();
    const bad = makeFakePage({ executeJavaScript: vi.fn(() => Promise.reject(new Error("boom"))) });
    await expect(new BrowserController(makeFakeTarget(bad)).hideCursorOverlay()).resolves.toBeUndefined();
  });
});

describe("capture", () => {
  // v2: CAPTURE_JS returns the parts, the controller assembles the document.
  const okResult = {
    sources: [],
    htmlOpen: "<html>",
    bodyOpen: "<body>",
    bodyHtml: "<p>hi</p>",
    width: 800,
    height: 1200,
    url: "https://example.com/",
    title: "Example",
  };
  const pageReturning = (result: unknown, extra: Partial<BrowserPageHandle> = {}) =>
    makeFakePage({
      executeJavaScript: vi.fn((code: string) =>
        isSignatureCall(code) ? Promise.resolve({ ok: true }) : Promise.resolve(result),
      ),
      ...extra,
    });
  const isCssQuery = (code: string) => code.includes("CSS query failed");
  /** A page whose CAPTURE_JS reports `sources` and whose CSS_QUERY_JS answers
   * from `answer(args)`; records every CSS query's args. */
  const cssPage = (
    sources: unknown[],
    answer: (args: { rootCompounds: string[]; selectors: string[] }) => unknown,
    extra: Partial<BrowserPageHandle> = {},
  ) => {
    const queries: { rootCompounds: string[]; selectors: string[] }[] = [];
    const page = makeFakePage({
      executeJavaScript: vi.fn((code: string) => {
        if (isSignatureCall(code)) return Promise.resolve({ ok: true });
        if (isCssQuery(code)) {
          const m = /var args = (\{[\s\S]*?\});\n/.exec(code);
          const args = JSON.parse((m as RegExpExecArray)[1]);
          queries.push(args);
          return Promise.resolve(answer(args));
        }
        return Promise.resolve({ ...okResult, sources });
      }),
      ...extra,
    });
    return { page, queries };
  };
  const fetching = (files: Record<string, string>) =>
    vi.fn(async (url: string) =>
      url in files ? { status: 200, text: files[url], contentType: "text/css" } : { status: 404, text: "" },
    );

  const seedSnapshot = (
    controller: BrowserController,
    page: unknown,
    id: string,
    frameMap: Map<number, { frameId: number | null; localIndex: number }> = new Map(),
  ) => {
    (controller as unknown as { lastSnapshot: unknown }).lastSnapshot = { id, page, frameMap, frameRects: new Map(), fingerprints: new Map() };
  };

  it("rejects a stale or unknown snapshotId without running the script", async () => {
    const page = pageReturning(okResult);
    const controller = new BrowserController(makeFakeTarget(page));
    const unknown = await controller.capture({ index: 1, snapshotId: "nope" });
    expect(unknown).toHaveProperty("error");
    expect((unknown as { error: string }).error).toMatch(/Stale or unknown snapshotId/);
    seedSnapshot(controller, page, "s-new");
    const stale = await controller.capture({ index: 1, snapshotId: "s-old" });
    expect((stale as { error: string }).error).toMatch(/Stale or unknown snapshotId/);
    seedSnapshot(controller, makeFakePage(), "s-new");
    const cross = await controller.capture({ index: 1, snapshotId: "s-new" });
    expect((cross as { error: string }).error).toMatch(/different browser tab/);
    expect(page.executeJavaScript).not.toHaveBeenCalled();
  });

  it("refuses an index inside a child frame without running the script", async () => {
    const page = pageReturning(okResult);
    const controller = new BrowserController(makeFakeTarget(page));
    seedSnapshot(controller, page, "s1", new Map([[7, { frameId: 3, localIndex: 2 }]]));
    expect(await controller.capture({ index: 7, snapshotId: "s1" })).toEqual({
      error:
        "Element 7 is inside a frame; browse_capture copies the top document only. Capture the whole page or open the frame URL with browse_open.",
    });
    expect(page.executeJavaScript).not.toHaveBeenCalled();
  });

  it("rejects non-object args", async () => {
    const controller = new BrowserController(makeFakeTarget(makeFakePage()));
    expect(await controller.capture("nope")).toHaveProperty("error");
    expect(await controller.capture([1])).toHaveProperty("error");
  });

  it("rejects a bad index, a bad snapshotId, and a lone index or snapshotId", async () => {
    const controller = new BrowserController(makeFakeTarget(makeFakePage()));
    expect(await controller.capture({ index: -1, snapshotId: "s1" })).toHaveProperty("error");
    expect(await controller.capture({ index: 1.5, snapshotId: "s1" })).toHaveProperty("error");
    expect(await controller.capture({ index: "2", snapshotId: "s1" })).toHaveProperty("error");
    expect(await controller.capture({ index: 2, snapshotId: 7 })).toHaveProperty("error");
    expect(await controller.capture({ index: 2 })).toHaveProperty("error");
    expect(await controller.capture({ snapshotId: "s1" })).toHaveProperty("error");
  });

  it("errors cleanly when no browser tab is open", async () => {
    const controller = new BrowserController(makeFakeTarget(null));
    expect(await controller.capture({})).toEqual({ error: "No browser tab is open — call browse_open first." });
  });

  it("injects whole-document args and passes the script result through", async () => {
    const page = pageReturning(okResult);
    const controller = new BrowserController(makeFakeTarget(page));
    const result = await controller.capture(undefined);
    expect(result).toEqual({
      html: '<!doctype html><html><head><meta charset="utf-8"></head><body><p>hi</p></body></html>',
      width: 800,
      height: 1200,
      url: "https://example.com/",
      title: "Example",
    });
    const args = JSON.stringify({ snapshotId: null, index: null, maxChars: 3_000_000 });
    expect(findScriptCall(page.executeJavaScript as ReturnType<typeof vi.fn>, args)).toContain(args);
  });

  it("injects element args when index and snapshotId are given", async () => {
    const page = pageReturning(okResult);
    const controller = new BrowserController(makeFakeTarget(page));
    seedSnapshot(controller, page, "snap-9");
    await controller.capture({ index: 4, snapshotId: "snap-9" });
    const args = JSON.stringify({ snapshotId: "snap-9", index: 4, maxChars: 3_000_000 });
    expect(findScriptCall(page.executeJavaScript as ReturnType<typeof vi.fn>, args)).toContain(args);
  });

  it("inlines a linked stylesheet, rewrites root rules, prunes unused rules (fetchText present)", async () => {
    const fetchText = fetching({
      "https://cdn.test/css/site.css": "html.dark{--bg:#000} html.light{--bg:#fff} .used{background:url(i.png)} .unused{color:red} .a, .b{x:1}",
    });
    const { page, queries } = cssPage(
      [
        { kind: "link", href: "https://cdn.test/css/site.css", media: "" },
        { kind: "inline", text: ".inl{color:red} .gone{color:blue}", baseUrl: "https://example.com/", media: "" },
      ],
      () => ({ rootMatches: ["html.dark"], existing: [".used", ".a", ".inl"], unparseable: [] }),
      { fetchText },
    );
    const result = (await new BrowserController(makeFakeTarget(page)).capture({})) as { html: string };
    expect(fetchText).toHaveBeenCalledWith("https://cdn.test/css/site.css", expect.objectContaining({ timeoutMs: 8000, maxBytes: 3_000_000 }));
    expect(queries).toHaveLength(1);
    expect(queries[0].rootCompounds).toEqual(expect.arrayContaining(["html.dark", "html.light"]));
    expect(queries[0].selectors).toContain(".unused");
    const styles = [...result.html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
    expect(styles).toHaveLength(2);
    expect(styles[0]).toContain(":is(:where(:root,:host),html.dark:not(*)){--bg:#000}");
    expect(styles[0]).not.toContain("html.light");
    expect(styles[0]).toContain('.used{background:url("https://cdn.test/css/i.png")}');
    expect(styles[0]).not.toContain(".unused");
    expect(styles[0]).toContain(".a{x:1}");
    expect(styles[0]).not.toContain(".b");
    expect(styles[1]).toBe(".inl{color:red}");
    expect(result.html).toMatch(/^<!doctype html><html><head><meta charset="utf-8"><style>/);
    expect(result.html).toMatch(/<\/head><body><p>hi<\/p><\/body><\/html>$/);
  });

  it("falls back to the literal @import when the stylesheet cannot be fetched", async () => {
    const { page } = cssPage(
      [{ kind: "link", href: "https://cdn.test/missing.css", media: "print" }],
      () => ({ rootMatches: [], existing: [], unparseable: [] }),
      { fetchText: fetching({}) },
    );
    const result = (await new BrowserController(makeFakeTarget(page)).capture({})) as { html: string };
    expect(result.html).toContain('<style>@import url("https://cdn.test/missing.css") print;</style>');
  });

  it("without fetchText every link becomes a literal @import, inline sheets are still pruned", async () => {
    const { page } = cssPage(
      [
        { kind: "link", href: "https://cdn.test/a.css", media: "" },
        { kind: "inline", text: ".keep{x:1} .drop{x:1}", baseUrl: "https://example.com/", media: "" },
      ],
      () => ({ rootMatches: [], existing: [".keep"], unparseable: [] }),
    );
    expect(page.fetchText).toBeUndefined();
    const result = (await new BrowserController(makeFakeTarget(page)).capture({})) as { html: string };
    expect(result.html).toContain('<style>@import url("https://cdn.test/a.css");</style>');
    expect(result.html).toContain("<style>.keep{x:1}</style>");
  });

  it("emits a sheet postcss cannot parse as-is, and skips the page query when nothing needs testing", async () => {
    const { page, queries } = cssPage(
      [{ kind: "inline", text: "a{color:red", baseUrl: "https://example.com/", media: "" }],
      () => ({ rootMatches: [], existing: [], unparseable: [] }),
    );
    const result = (await new BrowserController(makeFakeTarget(page)).capture({})) as { html: string };
    expect(result.html).toContain("<style>a{color:red</style>");
    expect(queries).toHaveLength(0);
  });

  it("keeps the unpruned css when the page query fails", async () => {
    const { page } = cssPage(
      [{ kind: "inline", text: "html.dark{x:1} .a{x:1}", baseUrl: "https://example.com/", media: "" }],
      () => ({ error: "CSS query failed: boom" }),
    );
    const result = (await new BrowserController(makeFakeTarget(page)).capture({})) as { html: string };
    expect(result.html).toContain("<style>html.dark{x:1} .a{x:1}</style>");
  });

  it("batches the selector and root-compound queries in chunks of 5000", async () => {
    const css = Array.from({ length: 12_000 }, (_, i) => `.s${i}{x:1}`).join("") + "html.dark{x:1}";
    const { page, queries } = cssPage(
      [{ kind: "inline", text: css, baseUrl: "https://example.com/", media: "" }],
      (args) => ({ rootMatches: args.rootCompounds.filter((c) => c === "html.dark"), existing: args.selectors, unparseable: [] }),
    );
    const result = (await new BrowserController(makeFakeTarget(page)).capture({})) as { html: string };
    expect(queries.map((q) => q.selectors.length)).toEqual([5000, 5000, 2001]);
    // 12 000 classless first compounds (.sN) plus html.dark
    expect(queries.map((q) => q.rootCompounds.length)).toEqual([5000, 5000, 2001]);
    expect(result.html).toContain(".s11999{x:1}");
    expect(result.html).toContain(":is(:where(:root,:host),html.dark:not(*)){x:1}");
  });

  it("passes the element target to the css query in element mode", async () => {
    const { page } = cssPage(
      [{ kind: "inline", text: ".a{x:1}", baseUrl: "https://example.com/", media: "" }],
      () => ({ rootMatches: [], existing: [".a"], unparseable: [] }),
    );
    const controller = new BrowserController(makeFakeTarget(page));
    seedSnapshot(controller, page, "snap-3");
    await controller.capture({ index: 5, snapshotId: "snap-3" });
    const call = (page.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls.find((c) => isCssQuery(c[0] as string));
    expect(call?.[0]).toContain('"snapshotId":"snap-3","index":5');
  });

  it("escapes </style inside css text", async () => {
    const { page } = cssPage(
      [{ kind: "inline", text: '.a::after{content:"</style><b>"}', baseUrl: "https://example.com/", media: "" }],
      () => ({ rootMatches: [], existing: [".a"], unparseable: [] }),
    );
    const result = (await new BrowserController(makeFakeTarget(page)).capture({})) as { html: string };
    expect(result.html.match(/<\/style/g)).toHaveLength(1);
    expect(result.html).toContain("\\3c /style>\\3c b>");
  });

  it("escapes </style in a sheet postcss could not parse", async () => {
    const { page } = cssPage(
      [{ kind: "inline", text: 'a{content:"</style><b>"', baseUrl: "https://example.com/", media: "" }],
      () => ({}),
    );
    const result = (await new BrowserController(makeFakeTarget(page)).capture({})) as { html: string };
    expect(result.html.match(/<\/style/g)).toHaveLength(1);
    expect(result.html).toContain("\\3c /style>\\3c b>");
  });

  it("puts every failed nested @import in its own <style> before the sheet's, never mid-sheet", async () => {
    const fetchText = fetching({
      "https://cdn.test/main.css": "@import url(a.css); @import url(b.css); .m{color:red}",
      "https://cdn.test/a.css": ".a{color:red}",
      "https://cdn.test/b.css": "@import url(gone.css) print; .b{color:red}",
    });
    const { page } = cssPage(
      [
        { kind: "link", href: "https://cdn.test/main.css", media: "" },
        { kind: "link", href: "https://cdn.test/nope.css", media: "print" },
      ],
      () => ({ rootMatches: [], existing: [".a", ".b", ".m"], unparseable: [] }),
      { fetchText },
    );
    const result = (await new BrowserController(makeFakeTarget(page)).capture({})) as { html: string };
    const styles = [...result.html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
    expect(styles).toHaveLength(3);
    expect(styles[0]).toBe('@import url("https://cdn.test/gone.css") print;');
    expect(styles[1]).toContain(".a{color:red}");
    expect(styles[1]).not.toContain("@import");
    expect(styles[2]).toBe('@import url("https://cdn.test/nope.css") print;');
  });

  it("retries with the v1 shape when the inlined document is over the cap", async () => {
    const huge = ".x{color:red}".repeat(250_000); // > 3M chars once inlined
    const fetchText = fetching({ "https://cdn.test/big.css": huge });
    const { page } = cssPage(
      [
        { kind: "link", href: "https://cdn.test/big.css", media: "" },
        { kind: "inline", text: ".y{background:url(i.png)}", baseUrl: "https://example.com/p/", media: "" },
      ],
      () => ({ rootMatches: [], existing: [".x", ".y"], unparseable: [] }),
      { fetchText },
    );
    const result = (await new BrowserController(makeFakeTarget(page)).capture({})) as { html: string };
    expect(result.html.length).toBeLessThan(10_000);
    expect(result.html).toContain('<style>@import url("https://cdn.test/big.css");</style>');
    expect(result.html).toContain('url("https://example.com/p/i.png")');
  });

  it("falls back to the v1 shape (never an empty style list) when the css phase throws", async () => {
    const { page } = cssPage(
      [
        { kind: "link", href: "https://cdn.test/a.css", media: "" },
        { kind: "inline", text: ".y{x:1}", baseUrl: "https://example.com/", media: "" },
      ],
      () => ({ rootMatches: [], existing: [".y"], unparseable: [] }),
    );
    // a throwing fetchText is contained per file; make the whole phase throw instead
    (page as { fetchText?: unknown }).fetchText = {
      bind() {
        throw new Error("bind boom");
      },
    };
    const result = (await new BrowserController(makeFakeTarget(page)).capture({})) as { html: string };
    expect(result.html).toContain('<style>@import url("https://cdn.test/a.css");</style>');
    expect(result.html).toContain("<style>.y{x:1}</style>");
  });

  describe("query phase deadline", () => {
    const manySelectors = Array.from({ length: 6_000 }, (_, i) => `.s${i}{x:1}`).join("");
    const src = [{ kind: "inline", text: manySelectors, baseUrl: "https://example.com/", media: "" }];

    it("checks the budget before EACH chunk: unpruned css once under 3 s remain", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const queries: unknown[] = [];
        const { page } = cssPage(src, (args) => {
          queries.push(args);
          vi.setSystemTime(Date.now() + 43_000); // the first chunk eats the budget
          return { rootMatches: [], existing: [], unparseable: [] }; // would prune everything
        });
        const result = (await new BrowserController(makeFakeTarget(page)).capture({})) as { html: string };
        expect(queries).toHaveLength(1);
        expect(result.html).toContain(".s5999{x:1}"); // unpruned: nothing was applied
      } finally {
        vi.useRealTimers();
      }
    });

    it("races each query against deadline - 2 s and keeps the unpruned css on timeout", async () => {
      vi.useFakeTimers();
      try {
        const page = makeFakePage({
          executeJavaScript: vi.fn((code: string) => {
            if (isSignatureCall(code)) return Promise.resolve({ ok: true });
            if (isCssQuery(code)) return new Promise(() => {}); // never answers
            return Promise.resolve({ ...okResult, sources: [{ kind: "inline", text: ".a{x:1} .b{x:1}", baseUrl: "https://example.com/", media: "" }] });
          }),
        });
        const pending = new BrowserController(makeFakeTarget(page)).capture({});
        await vi.advanceTimersByTimeAsync(42_999);
        let settled = false;
        void pending.then(() => (settled = true));
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(2);
        const result = (await pending) as { html: string };
        expect(result.html).toContain("<style>.a{x:1} .b{x:1}</style>");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("command deadline", () => {
    const sources = [
      { kind: "link", href: "https://cdn.test/a.css", media: "" },
      { kind: "inline", text: ".keep{x:1} .drop{x:1}", baseUrl: "https://example.com/", media: "" },
    ];
    const run = async (elapsedMs: number) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const fetchText = fetching({ "https://cdn.test/a.css": ".fetched{x:1}" });
        const { page, queries } = cssPage(sources, () => ({ rootMatches: [], existing: [".keep", ".fetched"], unparseable: [] }), { fetchText });
        const original = page.executeJavaScript as ReturnType<typeof vi.fn>;
        const impl = original.getMockImplementation()!;
        original.mockImplementation((code: string) => {
          const r = (impl as (c: string) => unknown)(code);
          if (!isSignatureCall(code) && !isCssQuery(code)) vi.setSystemTime(Date.now() + elapsedMs); // time spent by CAPTURE_JS
          return r;
        });
        const result = (await new BrowserController(makeFakeTarget(page)).capture({})) as { html: string };
        return { result, fetchText, queries };
      } finally {
        vi.useRealTimers();
      }
    };
    it("with plenty of time fetches and queries", async () => {
      const { result, fetchText, queries } = await run(1_000);
      expect(fetchText).toHaveBeenCalledTimes(1);
      expect(queries.length).toBe(1);
      expect(result.html).toContain(".fetched{x:1}");
    });
    it("under 8 s left starts no fetch (fallback @import) but still queries", async () => {
      const { result, fetchText, queries } = await run(38_000); // 7 s left
      expect(fetchText).not.toHaveBeenCalled();
      expect(result.html).toContain('<style>@import url("https://cdn.test/a.css");</style>');
      expect(queries.length).toBe(1);
      expect(result.html).not.toContain(".drop");
    });
    it("under 3 s left skips the page query: unpruned css", async () => {
      const { result, queries } = await run(43_000); // 2 s left
      expect(queries.length).toBe(0);
      expect(result.html).toContain(".keep{x:1} .drop{x:1}");
    });
  });

  it("refuses a final document over the cap and keeps the message", async () => {
    const big = "x".repeat(3_000_001);
    const { page } = cssPage([], () => ({}));
    (page.executeJavaScript as ReturnType<typeof vi.fn>).mockImplementation((code: string) =>
      Promise.resolve(isSignatureCall(code) ? { ok: true } : { ...okResult, bodyHtml: big }),
    );
    const result = await new BrowserController(makeFakeTarget(page)).capture({});
    expect(result).toEqual({ error: "Page is too large to capture (3.0M characters, limit 3.0M)." });
  });

  it("rejects a malformed page-script response", async () => {
    const page = pageReturning({ html: "<html></html>" });
    expect(await new BrowserController(makeFakeTarget(page)).capture({})).toEqual({
      error: "Unexpected response from the page script.",
    });
  });

  it("formats the page's tooLarge report with the controller's single message", async () => {
    const controller = new BrowserController(makeFakeTarget(pageReturning({ tooLarge: 3_400_000 })));
    expect(await controller.capture({})).toEqual({ error: "Page is too large to capture (3.4M characters, limit 3.0M)." });
  });

});

describe("BrowserController act upload", () => {
  const uploadCalls = (mock: ReturnType<typeof vi.fn>) => mock.mock.calls.filter((c) => (c[0] as string).includes("var viaInput"));

  function uploadRig(answer: Record<string, unknown> = { ok: true, uploaded: ["a.txt"], via: "input" }) {
    const executeJavaScript = vi.fn((code: string) => {
      if (isSignatureCall(code)) {
        return Promise.resolve({ url: "https://example.com/", title: "Example", nodeCount: 1, textLength: 0, textHash: 0, mainImageSrc: "", scrollY: 0, focusedValueLength: 0 });
      }
      if ((code as string).includes("var viaInput")) return Promise.resolve(answer);
      return Promise.resolve({ ok: true });
    });
    const page = makeFakePage({ executeJavaScript });
    return { controller: new BrowserController(makeFakeTarget(page), { cursor: false }), executeJavaScript };
  }

  it("runs UPLOAD_JS with base64 files and returns ok, uploaded, via and the change evidence", async () => {
    const { controller, executeJavaScript } = uploadRig();
    const result = await controller.act({ action: "upload", target: "#f", files: [{ name: "a.txt", text: "hi" }] });
    expect(result).toMatchObject({ ok: true, uploaded: ["a.txt"], via: "input", url: "https://example.com/" });
    expect(result).toHaveProperty("changed");
    const code = uploadCalls(executeJavaScript)[0]![0] as string;
    expect(code).toContain('"base64":"aGk="');
    expect(code).toContain('"mimeType":"text/plain"');
  });

  it("refuses bad files before the page is touched", async () => {
    const { controller, executeJavaScript } = uploadRig();
    const cases: Array<[unknown, RegExp]> = [
      [undefined, /non-empty "files"/],
      [Array.from({ length: 6 }, (_, i) => ({ name: `f${i}`, text: "x" })), /at most 5/],
      [[{ name: "a/b.txt", text: "x" }], /must not contain/],
      [[{ name: "a.bin", base64: "%%%" }], /not valid base64/],
      [[{ name: "big.bin", base64: Buffer.alloc(2 * 1024 * 1024 + 3).toString("base64") }], /larger than 2 MB/],
    ];
    for (const [files, message] of cases) {
      const result = (await controller.act({ action: "upload", target: "#f", files })) as { error: string };
      expect(result.error).toMatch(message);
    }
    expect(executeJavaScript).not.toHaveBeenCalled();
  });

  it("requires a target, or an index with a snapshotId", async () => {
    const { controller, executeJavaScript } = uploadRig();
    const files = [{ name: "a.txt", text: "x" }];
    expect(await controller.act({ action: "upload", files })).toHaveProperty("error");
    expect(await controller.act({ action: "upload", index: 0, files })).toHaveProperty("error");
    expect(executeJavaScript).not.toHaveBeenCalled();
  });

  it("rejects a stale snapshotId without running the script", async () => {
    const { controller, executeJavaScript } = uploadRig();
    const result = (await controller.act({ action: "upload", index: 0, snapshotId: "never-taken", files: [{ name: "a", text: "x" }] })) as { error: string };
    expect(result.error).toMatch(/stale|unknown/i);
    expect(uploadCalls(executeJavaScript)).toHaveLength(0);
  });

  it("passes the page script's refusal and drop result through", async () => {
    const refused = uploadRig({ error: "This input takes one file", noEffect: true });
    const r = await refused.controller.act({ action: "upload", target: "#f", files: [{ name: "a", text: "x" }, { name: "b", text: "y" }] });
    expect((r as { error: string }).error).toBe("This input takes one file");
    const dropped = uploadRig({ ok: true, uploaded: ["a"], via: "drop" });
    const d = await dropped.controller.act({ action: "upload", target: "#zone", files: [{ name: "a", text: "x" }] });
    expect(d).toMatchObject({ ok: true, via: "drop" });
  });
});
