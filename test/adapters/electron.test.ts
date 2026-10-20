import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { findRunningElectronApp, launchElectronApp, macQuitScript, quitElectronApp, resolveElectronExecutable, type ElectronChild, type ElectronLaunchDeps } from "../../src/adapters/electron.js";
import { APP_MODE_LOCK_MESSAGE, BrowserController, type BrowserPageHandle, type BrowserTarget } from "../../src/controller/index.js";

/** A child process that can be told to ignore SIGTERM. */
class FakeChild extends EventEmitter implements ElectronChild {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: string[] = [];
  constructor(private readonly ignoreTerm = false) { super(); }
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (signal === "SIGKILL" || !this.ignoreTerm) this.die(signal);
    return true;
  }
  die(signal: NodeJS.Signals | null = null, code: number | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

function fakeFs() {
  const removed: string[] = [];
  return {
    removed,
    fs: {
      mkdtemp: vi.fn(async (prefix: string) => `${prefix}XYZ`),
      rm: vi.fn(async (p: string) => { removed.push(p); }),
      readdir: vi.fn(async () => ["Only"]),
    },
  };
}

function fakeController(opts?: ConstructorParameters<typeof BrowserController>[1]) {
  const page = { getURL: () => "app://x", getTitle: () => "A" } as unknown as BrowserPageHandle;
  const target: BrowserTarget = {
    ensurePage: async () => page,
    currentPage: () => page,
    listPages: async () => [{ tabId: 1, url: "app://x", title: "A", current: true }],
    selectPage: async () => true,
    closePage: async () => true,
    newPage: async () => ({ tabId: 2, url: "", title: "", current: true }),
  };
  return new BrowserController(target, { cursor: false, ...opts });
}

function makeDeps(child: FakeChild, over: Partial<ElectronLaunchDeps> = {}) {
  const f = fakeFs();
  const spawn = vi.fn((_cmd: string, _args: string[], _o: { env?: NodeJS.ProcessEnv }) => child);
  const disconnect = vi.fn(async () => undefined);
  const deps: ElectronLaunchDeps = {
    spawn,
    fetchJson: async (url: string) => {
      if (url.endsWith("/json/version")) throw new Error("ECONNREFUSED");
      return [{ type: "page", url: "file:///app/index.html" }];
    },
    freePort: async () => 9333,
    readPlistExecutable: async () => "Orca Helper",
    fs: f.fs,
    connect: async () => ({ controller: fakeController(), close: disconnect, onDisconnected: () => undefined }),
    onParentExit: () => () => undefined,
    pollIntervalMs: 1,
    termGraceMs: 15,
    // Never reach a real process: the graceful quit sees the fake child only.
    platform: "darwin",
    isAlive: () => child.exitCode === null && child.signalCode === null,
    runOsascript: async () => "true",
    appQuitMs: 15,
    ...over,
  };
  return { deps, spawn, disconnect, removed: f.removed, fs: f.fs };
}

describe("resolveElectronExecutable", () => {
  it("reads CFBundleExecutable from Info.plist of a .app bundle", async () => {
    const read = vi.fn(async () => "Orca");
    const exe = await resolveElectronExecutable("/Applications/Orca.app/", { readPlistExecutable: read });
    expect(exe).toBe("/Applications/Orca.app/Contents/MacOS/Orca");
    expect(read).toHaveBeenCalledWith("/Applications/Orca.app/Contents/Info.plist");
  });

  it("falls back to the only file in Contents/MacOS", async () => {
    const f = fakeFs();
    const exe = await resolveElectronExecutable("/A/B.app", { readPlistExecutable: async () => null, fs: f.fs });
    expect(exe).toBe("/A/B.app/Contents/MacOS/Only");
  });

  it("throws when the fallback is ambiguous", async () => {
    const f = fakeFs();
    f.fs.readdir.mockResolvedValue(["a", "b"]);
    await expect(resolveElectronExecutable("/A/B.app", { readPlistExecutable: async () => null, fs: f.fs })).rejects.toThrow(/Cannot tell/);
  });

  it("returns a direct executable path unchanged", async () => {
    expect(await resolveElectronExecutable("/usr/bin/app")).toBe("/usr/bin/app");
  });
});

describe("launchElectronApp placeholder grace", () => {
  const PH = "data:text/html,<html><body></body></html>";
  const REAL = "file:///Applications/Qure.app/index.html";
  const listFetch = (lists: unknown[][]) => {
    let n = 0;
    const polls = { count: 0 };
    return {
      polls,
      fetchJson: async (url: string) => {
        if (url.endsWith("/json/version")) throw new Error("ECONNREFUSED");
        polls.count++;
        return lists[Math.min(n++, lists.length - 1)];
      },
    };
  };

  it("keeps polling past a placeholder page until a real page appears", async () => {
    const f = listFetch([[{ type: "page", url: PH }], [{ type: "page", url: PH }], [{ type: "page", url: PH }, { type: "page", url: REAL }]]);
    const connect = vi.fn(async () => ({ controller: fakeController(), close: async () => undefined, onDisconnected: () => undefined }));
    const t = makeDeps(new FakeChild(), { fetchJson: f.fetchJson, connect });
    await launchElectronApp({ app: "/x/Orca", placeholderGraceMs: 5000 }, t.deps);
    expect(f.polls.count).toBe(3);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("connects anyway when only placeholders exist after the grace", async () => {
    const f = listFetch([[{ type: "page", url: "about:blank" }]]);
    const connect = vi.fn(async () => ({ controller: fakeController(), close: async () => undefined, onDisconnected: () => undefined }));
    const t = makeDeps(new FakeChild(), { fetchJson: f.fetchJson, connect });
    const start = Date.now();
    await launchElectronApp({ app: "/x/Orca", placeholderGraceMs: 40 }, t.deps);
    expect(Date.now() - start).toBeGreaterThanOrEqual(35);
    expect(f.polls.count).toBeGreaterThan(1);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("passes { skipPlaceholderPages: true } to the default-style connect call", async () => {
    const connect = vi.fn(async (_u: string, _c?: unknown, _t?: unknown) => ({ controller: fakeController(), close: async () => undefined, onDisconnected: () => undefined }));
    const t = makeDeps(new FakeChild(), { connect });
    await launchElectronApp({ app: "/x/Orca" }, t.deps);
    expect(connect.mock.calls[0][2]).toEqual({ skipPlaceholderPages: true });
  });

  it("treats NaN as the default grace and a negative grace as none", async () => {
    for (const [grace, maxMs] of [[Number.NaN, 5000], [-5, 500]] as const) {
      const f = listFetch([[{ type: "page", url: "about:blank" }]]);
      const connect = vi.fn(async () => ({ controller: fakeController(), close: async () => undefined, onDisconnected: () => undefined }));
      const t = makeDeps(new FakeChild(), { fetchJson: f.fetchJson, connect });
      const start = Date.now();
      await launchElectronApp({ app: "/x/Orca", placeholderGraceMs: grace, timeoutMs: 800 }, t.deps);
      expect(connect).toHaveBeenCalledTimes(1);
      if (grace < 0) expect(Date.now() - start).toBeLessThan(maxMs);
      else expect(f.polls.count).toBeGreaterThan(5); // kept polling: a grace, not zero
    }
  });

  it("connects, not fails, when a page was seen and the last polls error out", async () => {
    let n = 0;
    const connect = vi.fn(async () => ({ controller: fakeController(), close: async () => undefined, onDisconnected: () => undefined }));
    const t = makeDeps(new FakeChild(), {
      connect,
      fetchJson: async (url: string) => {
        if (url.endsWith("/json/version")) throw new Error("ECONNREFUSED");
        if (n++ === 0) return [{ type: "page", url: "about:blank" }];
        throw new Error("transient");
      },
    });
    await launchElectronApp({ app: "/x/Orca", placeholderGraceMs: 30, timeoutMs: 2000 }, t.deps);
    expect(connect).toHaveBeenCalledTimes(1);
    const t2 = makeDeps(new FakeChild(), {
      connect,
      fetchJson: async (url: string) => {
        if (url.endsWith("/json/version")) throw new Error("ECONNREFUSED");
        if (n++ % 1000 === 0) return [{ type: "page", url: "about:blank" }];
        throw new Error("transient");
      },
    });
    n = 0;
    await launchElectronApp({ app: "/x/Orca", placeholderGraceMs: 60_000, timeoutMs: 40 }, t2.deps);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("never waits past the overall deadline", async () => {
    const f = listFetch([[{ type: "page", url: PH }]]);
    const t = makeDeps(new FakeChild(), { fetchJson: f.fetchJson });
    const start = Date.now();
    await launchElectronApp({ app: "/x/Orca", timeoutMs: 30, placeholderGraceMs: 60_000 }, t.deps);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("launchElectronApp", () => {
  it("spawns the executable with the debug port, a fresh profile and extra args", async () => {
    const child = new FakeChild();
    const t = makeDeps(child);
    const app = await launchElectronApp({ app: "/Applications/Orca.app", args: ["--foo"], env: { X: "1" } }, t.deps);
    const [cmd, args, o] = t.spawn.mock.calls[0];
    expect(cmd).toBe("/Applications/Orca.app/Contents/MacOS/Orca Helper");
    expect(args).toEqual(["--remote-debugging-port=9333", expect.stringMatching(/^--user-data-dir=.*browser-agent-electron-XYZ$/), "--foo"]);
    expect(o.env?.X).toBe("1");
    expect(app.cdpUrl).toBe("http://127.0.0.1:9333");
    expect(app.pid).toBe(4242);
    await app.close();
  });

  it("uses a given port and userDataDir and does not create a temp dir", async () => {
    const child = new FakeChild();
    const t = makeDeps(child);
    const app = await launchElectronApp({ app: "/bin/app", port: 7001, userDataDir: "/keep/me" }, t.deps);
    expect(t.spawn.mock.calls[0][1]).toEqual(["--remote-debugging-port=7001", "--user-data-dir=/keep/me"]);
    expect(t.fs.mkdtemp).not.toHaveBeenCalled();
    await app.close();
    expect(t.removed).toEqual([]);
  });

  it("waits until a page target exists", async () => {
    const child = new FakeChild();
    let calls = 0;
    const t = makeDeps(child, {
      fetchJson: async (url: string) => {
        if (url.endsWith("/json/version")) throw new Error("ECONNREFUSED");
        calls++;
        if (calls === 1) throw new Error("ECONNREFUSED");
        if (calls === 2) return [{ type: "service_worker" }];
        return [{ type: "service_worker" }, { type: "page", url: "file:///app/index.html" }];
      },
    });
    const app = await launchElectronApp({ app: "/bin/app" }, t.deps);
    expect(calls).toBe(3);
    await app.close();
  });

  it("throws a clear error, kills the child and removes the profile when the child exits first", async () => {
    const child = new FakeChild();
    const t = makeDeps(child, {
      fetchJson: async (url: string) => {
        if (url.endsWith("/json/version")) throw new Error("ECONNREFUSED");
        child.die(null, 1);
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(launchElectronApp({ app: "/bin/app" }, t.deps)).rejects.toThrow(/did not open a CDP port.*--remote-debugging-port/);
    expect(t.removed).toHaveLength(1);
    expect(t.removed[0]).toMatch(/browser-agent-electron-XYZ$/);
  });

  it("throws on timeout and kills the child", async () => {
    const child = new FakeChild();
    const t = makeDeps(child, { fetchJson: async () => { throw new Error("ECONNREFUSED"); } });
    await expect(launchElectronApp({ app: "/bin/app", timeoutMs: 30 }, t.deps)).rejects.toThrow(/did not open a CDP port.*no window after 30 ms/);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(t.removed).toHaveLength(1);
  });

  it("kills the child and throws when spawn reports an error", async () => {
    const child = new FakeChild();
    const t = makeDeps(child, {
      fetchJson: async (url: string) => {
        if (url.endsWith("/json/version")) throw new Error("ECONNREFUSED");
        child.emit("error", new Error("ENOENT"));
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(launchElectronApp({ app: "/bin/app" }, t.deps)).rejects.toThrow(/spawn failed: ENOENT/);
  });

  it("close escalates SIGTERM to SIGKILL, removes only its own temp profile, and is idempotent", async () => {
    const child = new FakeChild(true);
    const t = makeDeps(child);
    const app = await launchElectronApp({ app: "/bin/app" }, t.deps);
    await Promise.all([app.close(), app.close()]);
    await app.close();
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(t.disconnect).toHaveBeenCalledTimes(1);
    expect(t.removed).toHaveLength(1);
    expect(t.removed[0]).toMatch(/browser-agent-electron-XYZ$/);
  });

  it("close does not throw for an already dead process and sends no signal", async () => {
    const child = new FakeChild();
    const t = makeDeps(child, { connect: async () => ({ controller: fakeController(), close: async () => { throw new Error("closed"); }, onDisconnected: () => undefined }) });
    const app = await launchElectronApp({ app: "/bin/app" }, t.deps);
    child.die(null, 0);
    await expect(app.close()).resolves.toBeUndefined();
    expect(child.signals).toEqual([]);
  });

  it("passes a locked controller config to connect and keeps a custom lock string", async () => {
    for (const [given, want] of [[undefined, true], ["custom lock", "custom lock"]] as const) {
      const child = new FakeChild();
      const connect = vi.fn(async () => ({ controller: fakeController(), close: async () => undefined, onDisconnected: () => undefined }));
      const t = makeDeps(child, { connect });
      const app = await launchElectronApp({ app: "/bin/app", controllerOptions: given ? { lockNavigation: given } : undefined }, t.deps);
      expect(connect).toHaveBeenCalledWith("http://127.0.0.1:9333", expect.objectContaining({ lockNavigation: want }), { skipPlaceholderPages: true });
      await app.close();
    }
  });

  it("exposes onDisconnected from the connection", async () => {
    const child = new FakeChild();
    const onDisconnected = vi.fn();
    const t = makeDeps(child, { connect: async () => ({ controller: fakeController(), close: async () => undefined, onDisconnected }) });
    const app = await launchElectronApp({ app: "/bin/app" }, t.deps);
    const cb = () => undefined;
    app.onDisconnected(cb);
    expect(onDisconnected).toHaveBeenCalledWith(cb);
    await app.close();
  });

  it("strips ELECTRON_RUN_AS_NODE and ELECTRON_NO_ATTACH_CONSOLE from the child env", async () => {
    process.env.ELECTRON_RUN_AS_NODE = "1";
    process.env.ELECTRON_NO_ATTACH_CONSOLE = "1";
    try {
      const child = new FakeChild();
      const t = makeDeps(child);
      const app = await launchElectronApp({ app: "/bin/app" }, t.deps);
      const env = t.spawn.mock.calls[0][2].env!;
      expect(env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
      expect(env).not.toHaveProperty("ELECTRON_NO_ATTACH_CONSOLE");
      expect(env.PATH).toBe(process.env.PATH);
      await app.close();
    } finally {
      delete process.env.ELECTRON_RUN_AS_NODE;
      delete process.env.ELECTRON_NO_ATTACH_CONSOLE;
    }
  });

  it("refuses a busy port without spawning or creating a profile", async () => {
    const child = new FakeChild();
    const t = makeDeps(child, { fetchJson: async () => ({ Browser: "Chrome" }) });
    await expect(launchElectronApp({ app: "/bin/app", port: 9222 }, t.deps)).rejects.toThrow(/port 9222 is already in use by another debugger endpoint/i);
    expect(t.spawn).not.toHaveBeenCalled();
    expect(t.fs.mkdtemp).not.toHaveBeenCalled();
  });

  it("explains a clean exit (code 0) as a single-instance hand-off", async () => {
    const child = new FakeChild();
    const t = makeDeps(child, {
      fetchJson: async (url: string) => {
        if (url.endsWith("/json/version")) throw new Error("ECONNREFUSED");
        child.die(null, 0);
        throw new Error("ECONNREFUSED");
      },
    });
    const err = await launchElectronApp({ app: "/bin/app" }, t.deps).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/exited cleanly.*already-running instance/);
    expect((err as Error).message).not.toMatch(/may block/);
  });

  it("includes a non-zero exit code in the message", async () => {
    const child = new FakeChild();
    const t = makeDeps(child, {
      fetchJson: async (url: string) => {
        if (url.endsWith("/json/version")) throw new Error("ECONNREFUSED");
        child.die(null, 3);
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(launchElectronApp({ app: "/bin/app" }, t.deps)).rejects.toThrow(/exited with 3.*may block/);
  });

  it("on parent exit kills the child and removes only an owned profile; close unregisters it", async () => {
    let handler: (() => void) | undefined;
    const off = vi.fn();
    const rm = vi.fn();
    const child = new FakeChild(true);
    const t = makeDeps(child, { rmSync: rm, onParentExit: (fn) => { handler = fn; return off; } });
    const app = await launchElectronApp({ app: "/bin/app" }, t.deps);
    handler!();
    expect(child.signals).toEqual(["SIGKILL"]);
    expect(rm).toHaveBeenCalledWith(expect.stringMatching(/browser-agent-electron-XYZ$/));
    await app.close();
    expect(off).toHaveBeenCalled();

    const rm2 = vi.fn();
    const child2 = new FakeChild();
    const t2 = makeDeps(child2, { rmSync: rm2, onParentExit: (fn) => { handler = fn; return () => undefined; } });
    const app2 = await launchElectronApp({ app: "/bin/app", userDataDir: "/keep" }, t2.deps);
    handler!();
    expect(rm2).not.toHaveBeenCalled();
    await app2.close();
  });
});

describe("lockNavigation", () => {
  function setup(lock?: boolean | string) {
    const page = {
      loadURL: vi.fn(() => Promise.resolve()),
      onceDomReady: vi.fn(() => Promise.resolve()),
      executeJavaScript: vi.fn(() => Promise.resolve({ ok: true })),
      getURL: () => "https://example.com/",
      getTitle: () => "Example",
    } as unknown as BrowserPageHandle;
    const tabs = [{ tabId: 1, url: "app://x", title: "A", current: true }, { tabId: 2, url: "app://y", title: "B", current: false }];
    const target: BrowserTarget = {
      ensurePage: vi.fn(async () => page),
      currentPage: () => page,
      listPages: vi.fn(async () => tabs),
      selectPage: vi.fn(async () => true),
      closePage: vi.fn(async () => true),
      newPage: vi.fn(async () => ({ tabId: 3, url: "", title: "", current: true })),
    };
    return { page, target, controller: new BrowserController(target, { cursor: false, lockNavigation: lock }) };
  }

  it("refuses open with a url and a new tab, without touching the page", async () => {
    const { page, target, controller } = setup(true);
    expect(await controller.open({ url: "http://localhost:3000" })).toEqual({ error: APP_MODE_LOCK_MESSAGE });
    expect(await controller.tabs({ action: "new", url: "https://example.com" })).toEqual({ error: APP_MODE_LOCK_MESSAGE });
    expect(await controller.tabs({ action: "new" })).toEqual({ error: APP_MODE_LOCK_MESSAGE });
    expect(page.loadURL).not.toHaveBeenCalled();
    expect(target.newPage).not.toHaveBeenCalled();
  });

  it("refuses fixtures that need a new tab or a fresh session, without touching the target", async () => {
    const { target, controller } = setup(true);
    for (const fx of [{ version: 1, fresh: true }, { version: 1, tabs: ["https://example.com"] }]) {
      const r = await controller.applyFixture(fx as never);
      expect(r).toMatchObject({ ok: false, error: APP_MODE_LOCK_MESSAGE });
    }
    expect(target.newPage).not.toHaveBeenCalled();
    expect(target.closePage).not.toHaveBeenCalled();
  });

  it("refuses to close the last window but allows closing one of several", async () => {
    const { target, controller } = setup(true);
    const one = [{ tabId: 1, url: "app://x", title: "A", current: true }];
    (target.listPages as ReturnType<typeof vi.fn>).mockResolvedValueOnce(one);
    const r = await controller.tabs({ action: "close", tabId: 1 });
    expect(r.error).toContain(APP_MODE_LOCK_MESSAGE);
    expect(target.closePage).not.toHaveBeenCalled();
  });

  it("accepts a custom message", async () => {
    const { controller } = setup("no navigation");
    expect(await controller.open({ url: "https://example.com" })).toEqual({ error: "no navigation" });
  });

  it("still lists, switches and closes tabs when locked", async () => {
    const { target, controller } = setup(true);
    expect(await controller.tabs({ action: "list" })).toMatchObject({ current: 1 });
    expect(await controller.tabs({ action: "switch", tabId: 2 })).not.toHaveProperty("error");
    expect(target.selectPage).toHaveBeenCalledWith(2);
    expect(await controller.tabs({ action: "close", tabId: 2 })).not.toHaveProperty("error");
  });

  it("changes nothing when the lock is off", async () => {
    const { page, target, controller } = setup();
    expect(await controller.open({ url: "https://example.com" })).not.toHaveProperty("error");
    expect(page.loadURL).toHaveBeenCalledWith("https://example.com");
    expect(await controller.tabs({ action: "new" })).not.toHaveProperty("error");
    expect(target.newPage).toHaveBeenCalled();
  });
});

describe("launchElectronApp useAppProfile", () => {
  it("spawns without --user-data-dir, makes no temp dir and removes nothing", async () => {
    const child = new FakeChild();
    const { deps, spawn, fs, removed } = makeDeps(child);
    const app = await launchElectronApp({ app: "/x/Orca", useAppProfile: true }, deps);
    const args = spawn.mock.calls[0][1];
    expect(args).toEqual(["--remote-debugging-port=9333"]);
    expect(fs.mkdtemp).not.toHaveBeenCalled();
    await app.close();
    expect(removed).toEqual([]);
    expect(fs.rm).not.toHaveBeenCalled();
  });

  it("close() asks the app to quit before any signal", async () => {
    const child = new FakeChild();
    const runOsascript = vi.fn(async (script: string) => {
      expect(script).toContain("runningApplicationWithProcessIdentifier(4242)");
      child.die(null, 0);
      return "true";
    });
    const { deps } = makeDeps(child, { runOsascript });
    const app = await launchElectronApp({ app: "/x/Orca", useAppProfile: true }, deps);
    await app.close();
    expect(runOsascript).toHaveBeenCalledTimes(1);
    expect(child.signals).toEqual([]);
  });

  it("close() sends no signal when the graceful quit times out (the app keeps running)", async () => {
    const child = new FakeChild();
    const { deps } = makeDeps(child);
    const app = await launchElectronApp({ app: "/x/Orca", useAppProfile: true }, deps);
    await app.close();
    expect(child.signals).toEqual([]);
    expect(child.exitCode).toBeNull();
  });

  it("a failed launch asks the app to quit and sends no signal", async () => {
    const child = new FakeChild();
    const runOsascript = vi.fn(async () => "true");
    const { deps } = makeDeps(child, {
      runOsascript,
      fetchJson: async (url: string) => {
        if (url.endsWith("/json/version")) throw new Error("ECONNREFUSED");
        return [];
      },
    });
    await expect(launchElectronApp({ app: "/x/Orca", useAppProfile: true, timeoutMs: 5 }, deps)).rejects.toThrow(/did not open a CDP port/);
    expect(runOsascript).toHaveBeenCalledTimes(1);
    expect(child.signals).toEqual([]);
  });

  it("a failed connect asks the app to quit and sends no signal", async () => {
    const child = new FakeChild();
    const { deps } = makeDeps(child, { connect: async () => { throw new Error("connect failed"); } });
    await expect(launchElectronApp({ app: "/x/Orca", useAppProfile: true }, deps)).rejects.toThrow(/connect failed/);
    expect(child.signals).toEqual([]);
  });

  it("host exit does not kill the app", async () => {
    const child = new FakeChild();
    let exit: () => void = () => undefined;
    const { deps } = makeDeps(child, { onParentExit: (fn) => { exit = fn; return () => undefined; } });
    await launchElectronApp({ app: "/x/Orca", useAppProfile: true }, deps);
    exit();
    expect(child.signals).toEqual([]);
  });

  it("macQuitScript names the pid and rejects a bad one", () => {
    expect(macQuitScript(77)).toContain("runningApplicationWithProcessIdentifier(77)");
    expect(() => macQuitScript(0)).toThrow();
    expect(() => macQuitScript(1.5)).toThrow();
  });

  it("a temp profile close() does not run the graceful quit", async () => {
    const child = new FakeChild();
    const runOsascript = vi.fn(async () => "true");
    const { deps } = makeDeps(child, { runOsascript });
    const app = await launchElectronApp({ app: "/x/Orca" }, deps);
    await app.close();
    expect(runOsascript).not.toHaveBeenCalled();
  });

  it("an empty userDataDir is passed as is, not read as the app profile", async () => {
    const child = new FakeChild();
    const { deps, spawn } = makeDeps(child);
    await launchElectronApp({ app: "/x/Orca", userDataDir: "" }, deps);
    expect(spawn.mock.calls[0][1]).toContain("--user-data-dir=");
    await expect(launchElectronApp({ app: "/x/Orca", useAppProfile: true, userDataDir: "" }, makeDeps(new FakeChild()).deps)).rejects.toThrow(/cannot be used together/);
  });

  it("removes nothing on parent exit", async () => {
    const child = new FakeChild();
    let exit: () => void = () => undefined;
    const rmSync = vi.fn();
    const { deps } = makeDeps(child, { onParentExit: (fn) => { exit = fn; return () => undefined; }, rmSync });
    await launchElectronApp({ app: "/x/Orca", useAppProfile: true }, deps);
    exit();
    expect(rmSync).not.toHaveBeenCalled();
  });

  it("throws with userDataDir before spawning", async () => {
    const { deps, spawn } = makeDeps(new FakeChild());
    await expect(launchElectronApp({ app: "/x/Orca", useAppProfile: true, userDataDir: "/p" }, deps)).rejects.toThrow(/cannot be used together/);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("findRunningElectronApp", () => {
  const exe = "/Applications/Visual Studio Code.app/Contents/MacOS/Electron";
  const find = (procs: { pid: number; args: string }[]) =>
    findRunningElectronApp("/Applications/Visual Studio Code.app", { readPlistExecutable: async () => "Electron", listProcesses: async () => procs });

  it("matches the main process, skips helpers, --type= and its own pid", async () => {
    const res = await find([
      { pid: 10, args: exe },
      { pid: 11, args: `${exe} --remote-debugging-port=9222 --user-data-dir=/Users/a b/Profile --foo` },
      { pid: 12, args: `${exe} --type=renderer --remote-debugging-port=9222` },
      { pid: 13, args: "/Applications/Visual Studio Code.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper" },
      { pid: 14, args: `${exe}-other` },
      { pid: process.pid, args: exe },
    ]);
    expect(res).toEqual([
      { pid: 10, debugPort: null, userDataDir: null },
      { pid: 11, debugPort: 9222, userDataDir: "/Users/a b/Profile" },
    ]);
  });

  it("returns [] when ps fails", async () => {
    const res = await findRunningElectronApp("/x/App", {
      listProcesses: async () => { throw new Error("no ps"); },
    });
    expect(res).toEqual([]);
  });
});

describe("quitElectronApp", () => {
  function setup(opts: { platform?: NodeJS.Platform; aliveFor?: number; alive?: boolean } = {}) {
    let polls = 0;
    const runOsascript = vi.fn(async () => "true");
    const isAlive = vi.fn(() => {
      if (opts.alive !== undefined) return opts.alive;
      return ++polls <= (opts.aliveFor ?? 0);
    });
    return { runOsascript, isAlive, deps: { platform: opts.platform ?? "darwin", runOsascript, isAlive, sleep: async () => undefined, pollIntervalMs: 1 } as ElectronLaunchDeps };
  }

  it("on darwin runs osascript with the pid and waits for exit", async () => {
    const s = setup({ aliveFor: 3 });
    expect(await quitElectronApp(321, {}, s.deps)).toBe(true);
    expect(s.runOsascript).toHaveBeenCalledTimes(1);
    const script = (s.runOsascript.mock.calls[0] as unknown as [string])[0];
    expect(script).toContain("runningApplicationWithProcessIdentifier(321)");
    expect(script).toContain("terminate");
  });

  it("returns false when the app is still alive after the timeout", async () => {
    const s = setup({ alive: true });
    expect(await quitElectronApp(321, { timeoutMs: 20 }, { ...s.deps, sleep: (ms) => new Promise((r) => setTimeout(r, ms + 5)) })).toBe(false);
  });

  it("uses SIGTERM on Linux", async () => {
    const signal = vi.fn();
    const s = setup({ platform: "linux", aliveFor: 2 });
    expect(await quitElectronApp(321, {}, { ...s.deps, signal })).toBe(true);
    expect(signal).toHaveBeenCalledWith(321, "SIGTERM");
    expect(s.runOsascript).not.toHaveBeenCalled();
  });

  it("does nothing on Windows, where a signal is a hard kill", async () => {
    const signal = vi.fn();
    const s = setup({ platform: "win32", alive: true });
    expect(await quitElectronApp(321, {}, { ...s.deps, signal })).toBe(false);
    expect(signal).not.toHaveBeenCalled();
    expect(s.runOsascript).not.toHaveBeenCalled();
  });

  it("returns false at once when macOS has no running application for the pid", async () => {
    const s = setup({ alive: true });
    const sleep = vi.fn(async () => undefined);
    expect(await quitElectronApp(321, {}, { ...s.deps, runOsascript: async () => "nil", sleep })).toBe(false);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rejects an invalid pid", async () => {
    const s = setup({ alive: true });
    for (const pid of [0, -5, 1.5, Number.NaN]) expect(await quitElectronApp(pid, {}, s.deps)).toBe(false);
    expect(s.runOsascript).not.toHaveBeenCalled();
  });

  it("returns true at once for a pid that is already gone", async () => {
    const s = setup({ alive: false });
    expect(await quitElectronApp(321, {}, s.deps)).toBe(true);
    expect(s.runOsascript).not.toHaveBeenCalled();
  });
});
