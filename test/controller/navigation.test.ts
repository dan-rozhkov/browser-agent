import { describe, it, expect, vi } from "vitest";
import {
  decideNavigation,
  decideBrowserNavigation,
  attachNavigationPolicy,
  attachBrowserTabPolicy,
  attachOfflineFallback,
  attachLocalOnlyPolicy,
  shouldDropMcpRegistration,
  shouldForwardNavigationEvent,
} from "../src/main/navigation";

const ORIGIN = "https://pen-editor.onrender.com";

describe("decideNavigation", () => {
  it("allows same-origin", () => {
    expect(decideNavigation(`${ORIGIN}/some/path?x=1`, ORIGIN)).toBe("allow");
  });
  it("sends other http(s) origins external", () => {
    expect(decideNavigation("https://example.com/docs", ORIGIN)).toBe("external");
    expect(decideNavigation("http://localhost:9999/", ORIGIN)).toBe("external");
  });
  it("denies non-http schemes and garbage", () => {
    expect(decideNavigation("file:///etc/passwd", ORIGIN)).toBe("deny");
    expect(decideNavigation("javascript:alert(1)", ORIGIN)).toBe("deny");
    expect(decideNavigation("%%%", ORIGIN)).toBe("deny");
  });
});

type Handler = (...args: unknown[]) => void;

function fakeContents() {
  const handlers = new Map<string, Handler>();
  let openHandler: ((details: { url: string }) => { action: string }) | undefined;
  return {
    on: vi.fn((event: string, cb: Handler) => handlers.set(event, cb)),
    setWindowOpenHandler: vi.fn((cb: (details: { url: string }) => { action: string }) => {
      openHandler = cb;
    }),
    loadFile: vi.fn(),
    getURL: vi.fn(() => `${ORIGIN}/`),
    emit(event: string, ...args: unknown[]) {
      handlers.get(event)?.(...args);
    },
    open(url: string) {
      return openHandler!({ url });
    },
  };
}

describe("attachNavigationPolicy", () => {
  it("prevents will-navigate to foreign origins and opens externally", () => {
    const contents = fakeContents();
    const openExternal = vi.fn();
    attachNavigationPolicy(contents as never, ORIGIN, openExternal);
    const ev = { preventDefault: vi.fn() };
    contents.emit("will-navigate", ev, "https://example.com/x");
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith("https://example.com/x");
  });

  it("lets same-origin will-navigate through", () => {
    const contents = fakeContents();
    const openExternal = vi.fn();
    attachNavigationPolicy(contents as never, ORIGIN, openExternal);
    const ev = { preventDefault: vi.fn() };
    contents.emit("will-navigate", ev, `${ORIGIN}/inner`);
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("window.open goes external for http(s), denied otherwise, same-origin denied in-window", () => {
    const contents = fakeContents();
    const openExternal = vi.fn();
    attachNavigationPolicy(contents as never, ORIGIN, openExternal);
    expect(contents.open("https://example.com/x")).toEqual({ action: "deny" });
    expect(openExternal).toHaveBeenCalledWith("https://example.com/x");
    openExternal.mockClear();
    expect(contents.open("javascript:alert(1)")).toEqual({ action: "deny" });
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe("decideBrowserNavigation", () => {
  it("allows http(s), regardless of origin", () => {
    expect(decideBrowserNavigation("https://pinterest.com/search")).toBe("allow");
    expect(decideBrowserNavigation("http://example.com/")).toBe("allow");
    expect(decideBrowserNavigation("https://totally-unrelated-domain.test/x")).toBe("allow");
  });
  it("denies non-http schemes and garbage", () => {
    expect(decideBrowserNavigation("file:///etc/passwd")).toBe("deny");
    expect(decideBrowserNavigation("javascript:alert(1)")).toBe("deny");
    expect(decideBrowserNavigation("%%%")).toBe("deny");
  });
});

describe("attachBrowserTabPolicy", () => {
  it("lets in-place http(s) navigation through", () => {
    const contents = fakeContents();
    const openInNewBrowserTab = vi.fn();
    attachBrowserTabPolicy(contents as never, openInNewBrowserTab);
    const ev = { preventDefault: vi.fn() };
    contents.emit("will-navigate", ev, "https://example.com/x");
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(openInNewBrowserTab).not.toHaveBeenCalled();
  });

  it("denies in-place navigation to non-http(s) schemes", () => {
    const contents = fakeContents();
    const openInNewBrowserTab = vi.fn();
    attachBrowserTabPolicy(contents as never, openInNewBrowserTab);
    const ev = { preventDefault: vi.fn() };
    contents.emit("will-navigate", ev, "file:///etc/passwd");
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(openInNewBrowserTab).not.toHaveBeenCalled();
  });

  it("popups open as a new browser tab (never shell.openExternal) for http(s), and are always denied in-window", () => {
    const contents = fakeContents();
    const openInNewBrowserTab = vi.fn();
    attachBrowserTabPolicy(contents as never, openInNewBrowserTab);
    expect(contents.open("https://example.com/x")).toEqual({ action: "deny" });
    expect(openInNewBrowserTab).toHaveBeenCalledWith("https://example.com/x");
  });

  it("popups to non-http(s) schemes are denied without opening a new browser tab", () => {
    const contents = fakeContents();
    const openInNewBrowserTab = vi.fn();
    attachBrowserTabPolicy(contents as never, openInNewBrowserTab);
    expect(contents.open("javascript:alert(1)")).toEqual({ action: "deny" });
    expect(openInNewBrowserTab).not.toHaveBeenCalled();
  });
});

describe("attachLocalOnlyPolicy", () => {
  it("prevents will-navigate to any URL, local or remote", () => {
    const contents = fakeContents();
    attachLocalOnlyPolicy(contents as never);
    const ev = { preventDefault: vi.fn() };
    contents.emit("will-navigate", ev, "https://example.com/x");
    expect(ev.preventDefault).toHaveBeenCalled();
    ev.preventDefault.mockClear();
    contents.emit("will-navigate", ev, "file:///app/dist/tabbar/tabbar.html");
    expect(ev.preventDefault).toHaveBeenCalled();
  });

  it("always denies window.open", () => {
    const contents = fakeContents();
    attachLocalOnlyPolicy(contents as never);
    expect(contents.open("https://example.com/x")).toEqual({ action: "deny" });
    expect(contents.open("javascript:alert(1)")).toEqual({ action: "deny" });
  });
});

describe("shouldDropMcpRegistration", () => {
  it("drops registration on a real cross-document main-frame navigation (page reload)", () => {
    expect(shouldDropMcpRegistration({ isMainFrame: true, isSameDocument: false })).toBe(true);
  });

  it("does NOT drop registration on a same-document main-frame navigation (SPA pushState/replaceState/hash)", () => {
    expect(shouldDropMcpRegistration({ isMainFrame: true, isSameDocument: true })).toBe(false);
  });

  it("ignores subframe navigations regardless of same-document-ness", () => {
    expect(shouldDropMcpRegistration({ isMainFrame: false, isSameDocument: false })).toBe(false);
    expect(shouldDropMcpRegistration({ isMainFrame: false, isSameDocument: true })).toBe(false);
  });
});

describe("shouldForwardNavigationEvent", () => {
  it("forwards main-frame navigation events", () => {
    expect(shouldForwardNavigationEvent({ isMainFrame: true })).toBe(true);
  });

  it("does NOT forward subframe navigation events (finding 1: ad/embed iframe navigating during the click-settle grace window)", () => {
    expect(shouldForwardNavigationEvent({ isMainFrame: false })).toBe(false);
  });
});

describe("attachOfflineFallback", () => {
  it("loads the offline page on main-frame failure, with the failed url as target", () => {
    const contents = fakeContents();
    attachOfflineFallback(contents as never, "/app/dist/assets/offline.html");
    contents.emit("did-fail-load", {}, -106, "ERR_INTERNET_DISCONNECTED", `${ORIGIN}/`, true);
    expect(contents.loadFile).toHaveBeenCalledWith("/app/dist/assets/offline.html", {
      query: { target: `${ORIGIN}/` },
    });
  });

  it("ignores subframe failures and ERR_ABORTED", () => {
    const contents = fakeContents();
    attachOfflineFallback(contents as never, "/x/offline.html");
    contents.emit("did-fail-load", {}, -106, "x", `${ORIGIN}/`, false);
    contents.emit("did-fail-load", {}, -3, "ERR_ABORTED", `${ORIGIN}/`, true);
    expect(contents.loadFile).not.toHaveBeenCalled();
  });

  it("ignores failures whose validatedURL is a file: URL, to avoid re-triggering itself", () => {
    const contents = fakeContents();
    attachOfflineFallback(contents as never, "/app/dist/assets/offline.html");
    contents.emit(
      "did-fail-load",
      {},
      -6,
      "ERR_FILE_NOT_FOUND",
      "file:///app/dist/assets/offline.html",
      true,
    );
    expect(contents.loadFile).not.toHaveBeenCalled();
  });
});
