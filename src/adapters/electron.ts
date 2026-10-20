// Launch an Electron desktop app with a CDP port and drive its windows with the BrowserController.
// Node only. `playwright-core` is a peer dependency, imported lazily (like `connectOverCdp`).
// Each BrowserWindow is a tab. App mode locks navigation: `open` with a url and a new tab return an
// error, because navigating the only window to a URL destroys the app UI.
import { spawn, execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { promises as fsp, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { BrowserController } from "../controller/index.js";
import type { OpenedBrowser } from "../loop/bridge.js";
import { controllerBridge } from "./controllerBridge.js";
import { connectOverCdp } from "./playwright.js";

export interface LaunchElectronAppOptions {
  /** A macOS `.app` bundle, or a direct executable path (Windows, Linux). */
  app: string;
  /** Extra command-line arguments, after the debug port and profile arguments. */
  args?: string[];
  env?: NodeJS.ProcessEnv;
  /** Profile dir. Omitted: a fresh temp dir (clean state), deleted on `close()`. Given: kept. */
  userDataDir?: string;
  /**
   * Use the app's own profile (its logins and data): `--user-data-dir` is not passed, no temp dir is made,
   * and nothing is removed on `close()` or on parent exit. Cannot be combined with `userDataDir`.
   */
  useAppProfile?: boolean;
  /** Debug port. Default: a free port. */
  port?: number;
  /** How long to wait for the first page target. Default 30000. */
  timeoutMs?: number;
  /** Options for the `BrowserController` (navigation lock is always on). */
  controllerOptions?: ConstructorParameters<typeof BrowserController>[1];
}

export interface ElectronApp extends OpenedBrowser {
  controller: BrowserController;
  cdpUrl: string;
  pid: number;
  /** Calls `cb` when Playwright loses the connection (the app quit or crashed). */
  onDisconnected(cb: () => void): void;
  /** Idempotent: disconnect Playwright, SIGTERM, wait up to 3 s, then SIGKILL, then remove our temp profile. */
  close(): Promise<void>;
}

/** The child process as the launcher uses it. */
export interface ElectronChild {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", cb: () => void): unknown;
  once(event: "error", cb: (e: Error) => void): unknown;
}

export interface ElectronConnection {
  controller: BrowserController;
  close(): Promise<void>;
  onDisconnected(cb: () => void): void;
}

/** Seams for tests. */
export interface ElectronLaunchDeps {
  spawn?: (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => ElectronChild;
  /** GET json; resolves the parsed body or rejects. */
  fetchJson?: (url: string) => Promise<unknown>;
  freePort?: () => Promise<number>;
  /** Reads CFBundleExecutable from an Info.plist; null when it cannot. */
  readPlistExecutable?: (plistPath: string) => Promise<string | null>;
  fs?: {
    mkdtemp(prefix: string): Promise<string>;
    rm(p: string): Promise<void>;
    readdir(p: string): Promise<string[]>;
  };
  /** Connects to the CDP url and returns a controller (default: `connectOverCdp`). */
  connect?: (cdpUrl: string, controllerOptions?: LaunchElectronAppOptions["controllerOptions"]) => Promise<ElectronConnection>;
  /** Synchronous cleanup used by the parent-exit handler. */
  rmSync?: (p: string) => void;
  /** Registers the parent-exit handler; returns the remover. Default: `process.once("exit")`. */
  onParentExit?: (fn: () => void) => () => void;
  sleep?: (ms: number) => Promise<void>;
  /** With `useAppProfile`: how long `close()` waits for a graceful quit before SIGTERM. Default 10000. */
  appQuitMs?: number;
  /** Sends a signal (default: `process.kill`). */
  signal?: (pid: number, sig: NodeJS.Signals) => void;
  /** How long `close()` waits after SIGTERM before SIGKILL. Default 3000. */
  termGraceMs?: number;
  pollIntervalMs?: number;
  /** Lists running processes (default: `ps -A -ww -o pid=,args=`). */
  listProcesses?: () => Promise<{ pid: number; args: string }[]>;
  /** Platform for `quitElectronApp` (default: `process.platform`). */
  platform?: NodeJS.Platform;
  /** Returns true while the pid runs (default: `process.kill(pid, 0)`). */
  isAlive?: (pid: number) => boolean;
  /** Runs a JXA script with `osascript -l JavaScript -e`; resolves stdout. */
  runOsascript?: (script: string) => Promise<string>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("could not get a free port"))));
    });
  });
}

function readPlistExecutable(plist: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", plist], (err, stdout) => {
      const v = String(stdout ?? "").trim();
      resolve(err || !v ? null : v);
    });
  });
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const realFs: NonNullable<ElectronLaunchDeps["fs"]> = {
  mkdtemp: (prefix) => fsp.mkdtemp(prefix),
  rm: (p) => fsp.rm(p, { recursive: true, force: true }),
  readdir: (p) => fsp.readdir(p),
};

/** Resolves the executable of a `.app` bundle (or returns a direct path as is). */
export async function resolveElectronExecutable(app: string, deps: ElectronLaunchDeps = {}): Promise<string> {
  const fs = deps.fs ?? realFs;
  if (!app.endsWith(".app") && !app.endsWith(".app/")) return app;
  const bundle = app.replace(/\/+$/, "");
  const macos = path.join(bundle, "Contents", "MacOS");
  const name = await (deps.readPlistExecutable ?? readPlistExecutable)(path.join(bundle, "Contents", "Info.plist"));
  if (name) return path.join(macos, name);
  let files: string[];
  try {
    files = await fs.readdir(macos);
  } catch {
    throw new Error(`Not a macOS app bundle: ${app} (no Contents/MacOS).`);
  }
  if (files.length === 1) return path.join(macos, files[0]);
  throw new Error(`Cannot tell which file starts ${app}: Info.plist has no CFBundleExecutable and Contents/MacOS holds ${files.length} files.`);
}

function exited(c: ElectronChild): boolean {
  return c.exitCode !== null || c.signalCode !== null;
}

function waitExit(c: ElectronChild, ms: number, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  if (exited(c)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    c.once("exit", () => finish(true));
    void sleep(ms).then(() => finish(exited(c)));
  });
}

async function killChild(c: ElectronChild, graceMs: number, sleep: (ms: number) => Promise<void>): Promise<void> {
  if (exited(c)) return;
  try {
    c.kill("SIGTERM");
  } catch {
    return;
  }
  if (await waitExit(c, graceMs, sleep)) return;
  try {
    c.kill("SIGKILL");
  } catch {
    return;
  }
  await waitExit(c, 2000, sleep);
}

/**
 * Starts an Electron app with `--remote-debugging-port` and a profile dir, waits for a window, and
 * returns a controller locked to app mode. The app is spawned directly (we own the pid).
 * Some apps strip the debug port (Figma is a known example); then no port opens and this throws.
 */
export async function launchElectronApp(opts: LaunchElectronAppOptions, deps: ElectronLaunchDeps = {}): Promise<ElectronApp> {
  if (opts.useAppProfile && opts.userDataDir !== undefined) {
    throw new Error('"useAppProfile" and "userDataDir" cannot be used together: the app profile is chosen by the app itself.');
  }
  const fs = deps.fs ?? realFs;
  const sleep = deps.sleep ?? realSleep;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = deps.pollIntervalMs ?? 200;
  const termGraceMs = deps.termGraceMs ?? 3000;
  const appQuitMs = deps.appQuitMs ?? 10_000;

  const executable = await resolveElectronExecutable(opts.app, deps);
  const port = opts.port ?? (await (deps.freePort ?? freePort)());
  const useAppProfile = opts.useAppProfile === true;
  const ownsProfile = opts.userDataDir === undefined && !useAppProfile;
  const cdpUrl = `http://127.0.0.1:${port}`;
  const fetchFn = deps.fetchJson ?? fetchJson;
  // Port ownership: something that already answers is not our app.
  const occupied = await fetchFn(`${cdpUrl}/json/version`).then(() => true, () => false);
  if (occupied) throw new Error(`Port ${port} is already in use by another debugger endpoint. Pick another port or omit "port".`);
  const userDataDir: string | null = useAppProfile ? null : (opts.userDataDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "browser-agent-electron-"))));
  const removeProfile = async () => {
    if (ownsProfile && userDataDir !== null) await fs.rm(userDataDir).catch(() => undefined);
  };

  let child: ElectronChild;
  try {
    child = (deps.spawn ?? defaultSpawn)(executable, [`--remote-debugging-port=${port}`, ...(userDataDir !== null ? [`--user-data-dir=${userDataDir}`] : []), ...(opts.args ?? [])], {
      env: childEnv(opts.env),
    });
  } catch (e) {
    await removeProfile();
    throw e;
  }
  const parentExit = () => {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    if (ownsProfile && userDataDir !== null) { try { (deps.rmSync ?? ((p) => rmSync(p, { recursive: true, force: true })))(userDataDir); } catch { /* best effort */ } }
  };
  const offParentExit = (deps.onParentExit ?? ((fn) => { process.once("exit", fn); return () => { process.off("exit", fn); }; }))(parentExit);
  let spawnError: Error | null = null;
  child.once("error", (e) => { spawnError = e; });

  const fail = async (why: string, cleanExit = false): Promise<never> => {
    offParentExit();
    await killChild(child, termGraceMs, sleep);
    await removeProfile();
    if (cleanExit) {
      throw new Error(
        `The app exited cleanly (code 0) before a window opened. It most likely handed off to an already-running instance (single-instance lock). Quit the other instance and retry. App: ${opts.app}.`,
      );
    }
    throw new Error(
      `The app did not open a CDP port (${why}). It may block --remote-debugging-port. App: ${opts.app}. Port: ${port}.`,
    );
  };

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (spawnError) return fail(`spawn failed: ${(spawnError as Error).message}`);
    if (exited(child)) {
      return child.exitCode === 0
        ? fail("exit code 0", true)
        : fail(`the app exited with ${child.exitCode ?? child.signalCode} before a window opened`);
    }
    try {
      const list = await fetchFn(`${cdpUrl}/json/list`);
      if (Array.isArray(list) && list.some((t) => (t as { type?: string } | null)?.type === "page")) break;
    } catch {
      // Port not open yet.
    }
    if (Date.now() >= deadline) return fail(`no window after ${timeoutMs} ms`);
    await sleep(pollMs);
  }

  const lock = opts.controllerOptions?.lockNavigation || true;
  let conn: ElectronConnection;
  try {
    conn = await (deps.connect ?? connectOverCdp)(cdpUrl, { ...opts.controllerOptions, lockNavigation: lock });
  } catch (e) {
    offParentExit();
    await killChild(child, termGraceMs, sleep);
    await removeProfile();
    throw e;
  }
  const controller = conn.controller;

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      offParentExit();
      await conn.close().catch(() => undefined);
      // The user's real profile: ask the app to quit (Cmd+Q) before any signal, so it can save.
      if (useAppProfile && !exited(child) && child.pid) await quitElectronApp(child.pid, { timeoutMs: appQuitMs }, deps).catch(() => false);
      await killChild(child, termGraceMs, sleep);
      await removeProfile();
    })());

  return { controller, browser: controllerBridge(controller), cdpUrl, pid: child.pid ?? -1, onDisconnected: (cb) => conn.onDisconnected(cb), close };
}

/** The parent env plus `extra`, without the vars that would start an Electron app as plain Node. */
function childEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base = { ...process.env };
  delete base.ELECTRON_RUN_AS_NODE;
  delete base.ELECTRON_NO_ATTACH_CONSOLE;
  return { ...base, ...extra };
}

function defaultSpawn(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }): ChildProcess {
  return spawn(cmd, args, { stdio: "ignore", env: opts.env, detached: false });
}

export interface RunningElectronApp {
  pid: number;
  /** From `--remote-debugging-port=N`; null when the app runs without one. */
  debugPort: number | null;
  /** From `--user-data-dir=PATH`; null when the app uses its default profile. */
  userDataDir: string | null;
}

function defaultListProcesses(): Promise<{ pid: number; args: string }[]> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-A", "-ww", "-o", "pid=,args="], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      const out: { pid: number; args: string }[] = [];
      for (const line of String(stdout).split("\n")) {
        const m = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (m) out.push({ pid: Number(m[1]), args: m[2] });
      }
      resolve(out);
    });
  });
}

/** Value of `--name=...` that runs until the next " --" or the end of the command line. */
function flagValue(args: string, name: string): string | null {
  const key = `--${name}=`;
  const at = args.startsWith(key) ? 0 : args.indexOf(` ${key}`) + 1;
  if (at <= 0 && !args.startsWith(key)) return null;
  const rest = args.slice(at + key.length);
  const end = rest.indexOf(" --");
  const v = (end === -1 ? rest : rest.slice(0, end)).trim();
  return v || null;
}

/**
 * Finds running main processes of an Electron app (not Chromium helpers). Mechanism only: it reports
 * the pid, the debug port and the profile dir; the caller decides what to do. Returns [] if `ps` fails.
 */
export async function findRunningElectronApp(app: string, deps: ElectronLaunchDeps = {}): Promise<RunningElectronApp[]> {
  const executable = path.resolve(await resolveElectronExecutable(app, deps));
  let procs: { pid: number; args: string }[];
  try {
    procs = await (deps.listProcesses ?? defaultListProcesses)();
  } catch {
    return [];
  }
  const found: RunningElectronApp[] = [];
  for (const p of procs) {
    if (p.pid === process.pid) continue;
    if (p.args !== executable && !p.args.startsWith(`${executable} `)) continue;
    if (/(^| )--type=/.test(p.args)) continue;
    const port = flagValue(p.args, "remote-debugging-port");
    const n = port && /^\d+$/.test(port) ? Number(port) : null;
    found.push({ pid: p.pid, debugPort: n, userDataDir: flagValue(p.args, "user-data-dir") });
  }
  return found;
}

function defaultRunOsascript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-l", "JavaScript", "-e", script], { timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())));
  });
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but is not ours.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Asks an app to quit the way Cmd+Q does, then waits for the process to exit. Never kills it.
 * macOS: `NSRunningApplication.terminate`. Linux: SIGTERM. Windows: not supported (a signal there is
 * a hard kill), resolves false.
 * Resolves true when the process is gone. Resolves false when the pid is invalid, when macOS has no
 * running application for the pid (nothing was asked to quit), or when the process still runs after
 * `timeoutMs` (for example the app shows a "save changes?" dialog). `timeoutMs` counts from the call.
 */
export async function quitElectronApp(pid: number, opts: { timeoutMs?: number } = {}, deps: ElectronLaunchDeps = {}): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const isAlive = deps.isAlive ?? defaultIsAlive;
  if (!isAlive(pid)) return true;
  const sleep = deps.sleep ?? realSleep;
  const pollMs = deps.pollIntervalMs ?? 200;
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") return false;
  try {
    if (platform === "darwin") {
      const script = `ObjC.import('AppKit'); var a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); a.isNil() ? 'nil' : String(a.terminate)`;
      const out = await (deps.runOsascript ?? defaultRunOsascript)(script);
      if (out.trim() === "nil") return !isAlive(pid);
    } else {
      (deps.signal ?? ((p, sig) => process.kill(p, sig)))(pid, "SIGTERM");
    }
  } catch {
    // Fall through: the poll decides whether the process is gone.
  }
  for (;;) {
    if (!isAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}
