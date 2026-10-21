import type {
  CheckpointJournalOptions,
  FixtureApplyOptions,
  FixtureCaptureOptions,
  PageFixture,
} from "../fixture/types.js";

/**
 * The browser the loop drives. The shape is pen-editor's preload surface
 * (`window.penDesktop.browser`, docs/superpowers/specs/
 * 2026-09-18-builtin-browser-design.md §5), so the desktop shell's bridge, the
 * cloud-browser bridge and `controllerBridge()` all satisfy it as is. A host
 * passes one in as the `browser` option of `runBrowseTask`.
 *
 * Each call always resolves (the controller reports refusals as `{ error }`),
 * never rejects with anything the loop needs to catch specially — but the
 * loop still wraps every call in try/catch defensively.
 */
export interface BrowserBridge {
  open(args: { url: string }): Promise<unknown>;
  act(args: Record<string, unknown>): Promise<unknown>;
  findImages?(args: Record<string, unknown>): Promise<unknown>;
  /**
   * browse_read (docs/superpowers/specs/2026-09-18-browse-task-jev-loop-
   * design.md, Addendum 2 §2) — a readable digest of the current page:
   * headings, capped visible text, and links.
   */
  read(args: Record<string, unknown>): Promise<unknown>;
  /**
   * browse_task loop internals (docs/superpowers/specs/
   * 2026-09-18-browse-task-jev-loop-design.md §1/§3). `snapshot` returns the
   * page's element table stamped with a `snapshotId`, and `perform` acts by
   * index against that same snapshot, rejecting a stale id. Only the
   * browse_task loop calls these; the model never sees them directly.
   */
  snapshot(): Promise<unknown>;
  perform(args: {
    snapshotId: string;
    index?: number;
    operation: string;
    text?: string;
  }): Promise<unknown>;
  /**
   * browse_screenshot (docs/superpowers/specs/
   * 2026-09-23-full-browser-use-design.md, "Desktop bridge") — a viewport
   * capture of the current browser tab, downscaled and JPEG-encoded on
   * the main-process side. `annotate: true` additionally takes a fresh
   * snapshot and overlays numbered labels (set-of-marks), returning
   * `snapshotId`/`elements` alongside the image so a following
   * `browse_act`/`browse_snapshot` call can act by index against it.
   * Optional — absent on bridges older than this feature.
   */
  screenshot?(args?: { annotate?: boolean; snapshotId?: string }): Promise<unknown>;
  /**
   * browse_tabs (same design doc) — list/switch/close/open the shell's
   * browser tabs. `new` optionally loads `url` with `open`'s semantics and
   * makes the new tab the agent's current tab. Optional — absent on bridges
   * older than this feature.
   */
  /**
   * browse_open with `app` (opt-in `appLaunch` tool variant) — start a desktop
   * app and make its window the current tab. Resolves like `open`
   * (`{ url, title }` or `{ error }`). Optional: a bridge that cannot launch
   * apps leaves it out, and the executor answers with a neutral error.
   */
  launchApp?(args: { app: string }): Promise<unknown>;
  tabs?(args: {
    action: "list" | "switch" | "close" | "new";
    tabId?: number;
    url?: string;
  }): Promise<unknown>;
  /**
   * browse_capture (browse-capture design, 2026-10-15) — the page, or one
   * snapshot-stamped element, as a self-contained HTML document:
   * `{ html, width, height, url, title }`. Optional — absent on bridges
   * older than this feature.
   */
  capture?(args?: { index?: number; snapshotId?: string }): Promise<unknown>;
  /**
   * QA assertions (docs/specs/2026-10-18-qa-diagnostics-design.md, section 2): runs
   * `checks` (see `QaCheck`) against the current page and resolves to a `QaAssertResult`
   * (`{ ok: true, passed, results, consoleErrors?, failedRequests? }`) or `{ error }`.
   * Read-only. `snapshotId` names the snapshot an `index` check belongs to (default: the
   * current one). Optional - absent on bridges older than this feature; QA `qa_assert` and
   * `qa.checks` then fail clearly.
   */
  assert?(args: { checks: unknown[]; snapshotId?: string }): Promise<unknown>;
  /**
   * PageFixture (docs/specs/2026-10-15-page-fixture-design.md) — prepare the
   * browser state before a task, or read it back. `applyFixture` resolves to a
   * `FixtureApplyResult` (`{ ok, summary }` or `{ ok: false, error }`),
   * `captureFixture` to a `FixtureCaptureResult`. Optional — absent on bridges
   * older than this feature; `runBrowseAgent({ fixture })` then fails clearly.
   */
  applyFixture?(fixture: PageFixture, opts?: FixtureApplyOptions): Promise<unknown>;
  captureFixture?(opts?: FixtureCaptureOptions): Promise<unknown>;
  /**
   * Removes what `applyFixture` installed and must not outlive the task
   * (network mocks). Idempotent. `token` is the `fixtureToken` of this run's
   * `applyFixture` result: with it, only that fixture is released. A bridge that can apply a fixture with
   * `network` must have it: `runBrowseAgent` refuses such a bridge otherwise.
   */
  releaseFixture?(token?: string): Promise<unknown>;
  /**
   * Ends the device emulation that browse_act `viewport` set (docs/specs/2026-10-18-qa-diagnostics-design.md,
   * section 6): the pages go back to the state the fixture gave them, or to the real browser. Idempotent.
   * `runBrowseAgent` calls it when a run ends, also when it applied no fixture. A host that drives the
   * browser without `runBrowseAgent` must call it itself at the end of its run. Optional - a bridge that
   * has it must forward it; one without it leaves the emulation to the host.
   */
  clearActEmulation?(): Promise<unknown>;
  /**
   * Mid-task checkpoint (docs/specs/2026-10-16-checkpoint-design.md).
   * `startJournal` makes the browser record the agent's state-changing actions
   * (off by default, no cost while off) and returns the OWNER TOKEN of that
   * journal; `stopJournal(token)` ends it and `captureCheckpoint(token)` resolves
   * to a `CheckpointResult`: a `PageFixture` that `applyFixture` rebuilds (host
   * use: it holds secrets). A token that is not the running journal's (it was
   * replaced by another `startJournal`) stops nothing and takes no checkpoint.
   * Without a token they act on whatever journal runs (bridges that predate
   * tokens return nothing from `startJournal`). Optional - absent on bridges
   * older than this feature; `runBrowseAgent({ checkpoint })` then gives
   * `{ ok: false, error }` to `onCapture`.
   */
  startJournal?(opts?: CheckpointJournalOptions): string | void | Promise<string | void>;
  stopJournal?(token?: string): unknown;
  captureCheckpoint?(token?: string): Promise<unknown>;
  /**
   * Run trace request log (docs/specs/2026-10-20-browse-run-trace-design.md, "v1 additions"): drains the requests
   * all tabs finished since the last call. Resolves to the JSON text of `{ requests, dropped? }` (raw entries, see
   * the controller's `PageRequestEntry`). Read-only; never blocks behind a running command. Optional - absent on
   * bridges older than this feature; the recorder then has no `requests` source.
   */
  requests?(): Promise<string>;
}


/** A browser a host opened for one task: the bridge, and how to close it. */
export interface OpenedBrowser {
  browser: BrowserBridge;
  close(): Promise<void>;
}
