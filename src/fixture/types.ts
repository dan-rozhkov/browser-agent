// PageFixture: the state of a browser before a task (cookies, storage, URL,
// tabs, setup steps). Zod-free and isomorphic. Design:
// docs/specs/2026-10-15-page-fixture-design.md
import type { BrowserPageHandle } from "../controller/controller.js";
import type { ParsedKeySpec } from "../controller/keys.js";

export interface FixtureCookie {
  name: string;
  value: string;
  /** A cookie needs `url`, or `domain` (with `path`, default "/"). */
  domain?: string;
  path?: string;
  url?: string;
  /** Unix time in seconds. Absent for a session cookie. */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface FixtureOrigin {
  /** For example "https://example.com". */
  origin: string;
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
}

export type FixtureStep =
  | { action: "goto"; url: string }
  | { action: "click"; selector: string }
  /** Native value setter, then `input` and `change` events. */
  | { action: "type"; selector: string; text: string }
  | { action: "press"; key: string; selector?: string }
  | { action: "waitFor"; selector: string; timeoutMs?: number }
  | { action: "wait"; ms: number };

export interface PageFixture {
  version: 1;
  /** Main tab start URL. Loaded after the storage is set. */
  url?: string;
  /** Extra tabs, opened after the main tab. The main tab stays current. */
  tabs?: string[];
  storage?: {
    cookies?: FixtureCookie[];
    origins?: FixtureOrigin[];
  };
  /** Deterministic steps on the main tab, run after `url` loads. No LLM. */
  steps?: FixtureStep[];
  /** Reserved. A non-empty list makes `applyFixture` fail ("not supported yet"). */
  network?: unknown[];
}

export type ParsePageFixtureResult = { ok: true; value: PageFixture } | { ok: false; error: string };

/** A JS dialog (`alert`, `confirm`, ...) the browser handled on its own during a command. */
export type FixtureDialog = Record<string, unknown>;

export type FixtureApplyResult =
  /** `summary` is safe for a model: counts only, no cookie or storage data.
   * `dialogs` lists the dialogs auto-handled while the fixture ran (controller path). */
  | { ok: true; url: string; title: string; summary: string; dialogs?: FixtureDialog[] }
  | { ok: false; error: string; dialogs?: FixtureDialog[] };

export interface FixtureApplyOptions {
  /** Checked between steps; aborts waits and loads. */
  signal?: AbortSignal;
}

export interface FixtureCaptureOptions {
  /** Keep only cookies and storage of these origins. Default: all. */
  origins?: string[];
}

export type FixtureCaptureResult =
  /** For the host only: the fixture holds secrets. */
  { ok: true; fixture: PageFixture } | { ok: false; error: string };

/** Longest `waitFor` timeout and `wait` delay a fixture may ask for. */
export const FIXTURE_MAX_WAIT_MS = 30_000;
/** `waitFor` timeout when a step gives none. */
export const FIXTURE_WAIT_FOR_DEFAULT_MS = 5_000;

/** Outcome of a hook: a failure carries a message for the host. `dialogs` are
 * the dialogs the command drained, which the apply result must still report. */
export type FixtureHookResult = { ok: true; dialogs?: FixtureDialog[] } | { ok: false; error: string; dialogs?: FixtureDialog[] };

/**
 * Internal seam for a host that already has its own navigation, tab and key
 * code (`BrowserController` supplies all of them, so a fixture behaves exactly
 * like `browse_open`, `browse_tabs` and `act press`/`click`). Without hooks,
 * `applyFixture` uses its own standalone versions.
 */
export interface FixtureHooks {
  /** Loads `url` in the current tab (bot-wall and aborted-navigation handling included). Must not start after `signal` aborted. */
  navigate?(url: string, signal?: AbortSignal): Promise<FixtureHookResult>;
  /** Opens a new tab that loads `url` and becomes current. Must not start after `signal` aborted, and must not leave a tab behind after it. */
  openTab?(url: string, signal?: AbortSignal): Promise<FixtureHookResult>;
  /** Sends a trusted key press. Resolve false to fall back to the standalone page-script version. */
  press?(page: BrowserPageHandle, key: ParsedKeySpec): Promise<boolean>;
  /** Runs a click or press `action` and settles after it like `act` does (navigation watcher, load stop, network quiet). */
  settled?<T>(page: BrowserPageHandle, action: () => Promise<T>): Promise<T>;
}
