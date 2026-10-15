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
  /** Network mocks. Need the host flag `allowNetworkMocks` and a target with `routeRequests`. */
  network?: FixtureNetworkRule[];
  /** Check, after `steps`, that the page is the right one. A failure is stage "expect". */
  expect?: FixtureExpect;
  /** Reset the browser session (cookies, storage, extra tabs) before anything else. Default false. */
  fresh?: boolean;
}

/** All given conditions must hold at once, on the main tab. At least one of `selector`, `text`, `url`. */
export interface FixtureExpect {
  /** An element matching it exists and is visible. */
  selector?: string;
  /** The visible text of the page contains it. */
  text?: string;
  /** URL pattern: the same matcher as `FixtureNetworkRule.url`. */
  url?: string;
  /** Polling time. Default 5000, max 30000. */
  timeoutMs?: number;
}

export interface FixtureNetworkRule {
  /** Full URL with `*` wildcards (`*` = any characters), for example "https://api.shop.test/cart*". */
  url: string;
  /** Default: any method. Case-insensitive. */
  method?: string;
  /** Default 200. */
  status?: number;
  headers?: Record<string, string>;
  /** An object is sent as JSON (content-type application/json unless given). */
  body?: string | object;
  /** Max 30000. */
  delayMs?: number;
  /** Fail the request (network error) instead of answering. */
  abort?: boolean;
  /** Apply at most N times, then let requests through. */
  times?: number;
}

/** What a target sends back for a mocked request. */
export interface FixtureMockResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  delayMs?: number;
  /** Fail the request instead of answering. */
  abort?: boolean;
}

/** A request a target gives to its `routeRequests` handler. */
export interface FixtureRequestInfo {
  url: string;
  method: string;
}

/** Where `applyFixture` stopped. */
export type FixtureStage = "validate" | "prepare" | "network" | "reset" | "cookies" | "storage" | "url" | "tabs" | "steps" | "expect";

export type ParsePageFixtureResult = { ok: true; value: PageFixture } | { ok: false; error: string };

/** A JS dialog (`alert`, `confirm`, ...) the browser handled on its own during a command. */
export type FixtureDialog = Record<string, unknown>;

export type FixtureApplyResult =
  /** `summary` is safe for a model: counts only, no cookie or storage data.
   * `dialogs` lists the dialogs auto-handled while the fixture ran (controller path). */
  | {
      ok: true;
      url: string;
      title: string;
      summary: string;
      dialogs?: FixtureDialog[];
      /** Present when the apply installed network mocks: removes them. Idempotent. Call it when the task ends. */
      release?: () => Promise<void>;
      /** Set by `BrowserController.applyFixture` when mocks are installed: hand it to `releaseFixture(token)`. Opaque, no secrets. */
      fixtureToken?: string;
    }
  /** `stage` is the part of the apply that failed. */
  | { ok: false; stage: FixtureStage; error: string; dialogs?: FixtureDialog[] };

export interface FixtureApplyOptions {
  /** Checked between steps; aborts waits and loads. */
  signal?: AbortSignal;
  /** Host gate: without it a non-empty `network` fails with stage "network". Default false. */
  allowNetworkMocks?: boolean;
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
  /** Called when the apply enters a stage, so a host that cuts the run short can still name the stage. */
  onStage?(stage: FixtureStage): void;
  /** Runs a click or press `action` and settles after it like `act` does (navigation watcher, load stop, network quiet). */
  settled?<T>(page: BrowserPageHandle, action: () => Promise<T>): Promise<T>;
}
