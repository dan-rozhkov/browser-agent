import { describe, expect, it, vi } from "vitest";
import { asSchema } from "ai";
import {
  browseOpenInputSchema,
  createBrowseOpenInputSchema,
  createBrowseToolDefinitions,
  describeBrowseOpen,
  executeBrowseTool,
} from "../../src/agent/index.js";
import { BrowserController, type BrowserPageHandle, type BrowserTarget } from "../../src/controller/controller.js";

describe("createBrowseOpenInputSchema", () => {
  it("without appLaunch returns the neutral schema itself", () => {
    expect(createBrowseOpenInputSchema()).toBe(browseOpenInputSchema);
    expect(createBrowseOpenInputSchema({ appLaunch: false })).toBe(browseOpenInputSchema);
    expect(browseOpenInputSchema.safeParse({}).success).toBe(false);
  });

  const schema = createBrowseOpenInputSchema({ appLaunch: true });

  it("accepts url alone or app alone", () => {
    expect(schema.safeParse({ url: "https://a.test/" }).success).toBe(true);
    expect(schema.safeParse({ app: "/Applications/Orca.app" }).success).toBe(true);
  });

  it("rejects both, neither and over-long app", () => {
    expect(schema.safeParse({ url: "https://a.test/", app: "/Applications/Orca.app" }).success).toBe(false);
    const none = schema.safeParse({});
    expect(none.success).toBe(false);
    expect(JSON.stringify(none.error?.issues)).toContain("exactly one");
    expect(schema.safeParse({ app: "x".repeat(1025) }).success).toBe(false);
  });

  it("strips strict-mode placeholders", () => {
    expect(schema.parse({ url: "", app: "/Applications/Orca.app" })).toEqual({ app: "/Applications/Orca.app" });
    expect(schema.parse({ url: "https://a.test/", app: "" })).toEqual({ url: "https://a.test/" });
    expect(schema.safeParse({ url: "", app: "" }).success).toBe(false);
  });

  it("describes app in the JSON schema", () => {
    const json = JSON.stringify(asSchema(schema as never).jsonSchema);
    expect(json).toContain("app");
    expect(json).toContain("macOS .app");
  });
});

describe("browse_open description", () => {
  it("adds the openApp text only with appLaunch", () => {
    const neutral = describeBrowseOpen();
    expect(neutral).not.toContain("Desktop apps");
    expect(describeBrowseOpen({ appLaunch: false })).toBe(neutral);
    const withApp = describeBrowseOpen({ appLaunch: true });
    expect(withApp).toContain("/Applications/Orca.app");
  });

  it("honors a custom openApp slot, and ignores it without appLaunch", () => {
    expect(describeBrowseOpen({ appLaunch: true, openApp: "CUSTOM APP TEXT" })).toContain("CUSTOM APP TEXT");
    expect(describeBrowseOpen({ openApp: "CUSTOM APP TEXT" })).toBe(describeBrowseOpen());
  });
});

describe("createBrowseToolDefinitions appLaunch", () => {
  it("passes appLaunch to browse_open's schema and description", () => {
    const on = createBrowseToolDefinitions({ appLaunch: true }).browse_open;
    expect(on.inputSchema.safeParse({ app: "/Applications/Orca.app" }).success).toBe(true);
    expect(on.description).toContain("Desktop apps");
    const off = createBrowseToolDefinitions().browse_open;
    expect(off.inputSchema.safeParse({ app: "/Applications/Orca.app" }).success).toBe(false);
    expect(off.inputSchema).toBe(browseOpenInputSchema);
  });
});

describe("BrowserController.open with app (unchanged)", () => {
  it("ignores `app` and opens the url like on main", async () => {
    const page = {
      loadURL: vi.fn(async () => {}),
      onceDomReady: () => Promise.resolve(),
      getURL: () => "https://example.com/",
      getTitle: () => "T",
    } as unknown as BrowserPageHandle;
    const target = { ensurePage: async () => page, currentPage: () => page } as unknown as BrowserTarget;
    await new BrowserController(target).open({ url: "https://example.com", app: "/Applications/Orca.app" });
    expect(page.loadURL).toHaveBeenCalledWith("https://example.com");
  });
});

describe("whitespace placeholders", () => {
  const schema = createBrowseOpenInputSchema({ appLaunch: true });
  it("drops whitespace-only url/app", () => {
    expect(schema.parse({ url: "   ", app: "/Applications/Orca.app" })).toEqual({ app: "/Applications/Orca.app" });
    expect(schema.safeParse({ url: " ", app: "\t" }).success).toBe(false);
  });
});

describe("appLaunch description lead", () => {
  it("says url or app, not url only", () => {
    const d = describeBrowseOpen({ appLaunch: true });
    expect(d).toContain("or starts the desktop app in `app`");
    expect(d).toContain("Pass `url` or `app`, not both.");
  });
});

describe("executeBrowseTool browse_open with app", () => {
  const SNAP = { snapshotId: "s1", url: "https://a.test/", title: "A", elements: [], scroll: { y: 0, height: 1, atBottom: true } };
  const base = {
    open: async () => ({ url: "https://a.test/", title: "A" }),
    act: async () => ({}),
    read: async () => ({}),
    snapshot: async () => SNAP,
    perform: async () => ({}),
  };
  it("forwards app to launchApp and attaches the snapshot", async () => {
    const launchApp = vi.fn(async () => ({ url: "app://x", title: "X" }));
    const open = vi.fn(base.open);
    const r = JSON.parse(await executeBrowseTool({ ...base, open, launchApp }, "browse_open", { app: " /Applications/Orca.app " }));
    expect(launchApp).toHaveBeenCalledWith({ app: "/Applications/Orca.app" });
    expect(open).not.toHaveBeenCalled();
    expect(r.title).toBe("X");
    expect(r.snapshot.snapshotId).toBe("s1");
  });
  it("returns a neutral, overridable error without launchApp", async () => {
    const r = JSON.parse(await executeBrowseTool(base, "browse_open", { app: "/A.app" }));
    expect(r.error).toBe("Launching a desktop app is not available in this browser.");
    const c = JSON.parse(await executeBrowseTool(base, "browse_open", { app: "/A.app" }, { texts: { appLaunchMissing: "nope" } }));
    expect(c.error).toBe("nope");
  });
  it("keeps the url path when app is empty", async () => {
    const launchApp = vi.fn();
    const r = JSON.parse(await executeBrowseTool({ ...base, launchApp }, "browse_open", { url: "https://a.test/", app: "" }));
    expect(launchApp).not.toHaveBeenCalled();
    expect(r.title).toBe("A");
  });
});
