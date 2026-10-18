// The built-in browser's command surface (design doc
// `2026-09-18-builtin-browser-design.md` §3). Electron-free, in the style of
// ../mcp/dispatcher.ts: the page is injected via BrowserTarget so this stays
// unit-testable under plain Node/vitest. window.ts adapts a real
// WebContentsView (via TabManager.browserHandle()/newTab("browser")) into
// BrowserTarget/BrowserPageHandle.
//
// Every method below takes `unknown` and validates it before touching
// anything — these arguments arrive from an LLM through a renderer, so
// neither their shape nor their types can be trusted. Every method resolves;
// a failure comes back as `{ error: string }`, never a rejection, matching
// how pen-editor's own toolHandlers behave everywhere else in this project
// (and how dispatcher.ts's ToolCallResult never rejects either).

import { decideBrowserNavigation } from "./navigation.js";
import { evaluateQaChecks, parseQaChecks } from "../shared/qaChecks.js";
import type { QaCheckResult } from "../shared/qaTypes.js";
import { applyParsedFixture, fixtureBudgetMs } from "../fixture/apply.js";
import { boundedCall, httpOrigin, redactUrl, redactUrls, withTimeout } from "../fixture/util.js";
import { parsePageFixture } from "../fixture/parse.js";
import { captureFixture, readBaseState, type BaseState } from "../fixture/capture.js";
import { CHECKPOINT_GAPS, mergeStorage } from "../fixture/checkpoint.js";
import { clearDeviceEmulation, emulationIdentity, installEmulation, layerViewport, resolveEmulation } from "../fixture/emulate.js";
import { parseViewportArgs } from "../shared/viewport.js";
import { JournalSession, type JournalBase, type JournalCommand, type StagedAction } from "./journal.js";
import type {
  CheckpointJournalOptions,
  CheckpointResult,
  FixtureApplyOptions,
  FixtureApplyResult,
  FixtureCaptureOptions,
  FixtureEmulate,
  FixtureCaptureResult,
  FixtureCookie,
  FixtureOrigin,
  FixtureHookResult,
  FixtureHooks,
  FixtureMockResponse,
  FixtureRequestInfo,
  FixtureStage,
  FixtureStep,
  PageFixture,
} from "../fixture/types.js";
import {
  applyQueryResults,
  collectQueries,
  renderStyleTag,
  resolveImports,
  sheetCss,
  importStatement,
  type CaptureSource,
  type ResolvedSheet,
  v1Shape,
} from "./captureCss.js";
import { validateUploadFiles, type UploadPayloadFile } from "./uploadFiles.js";
import { parseKeySpec, resolveNamedKey, keyDispatchOptions, dispatchKeyPair as dispatchKeyPairShared } from "./keys.js";
import {
  ARGS_MARKER,
  FIND_IMAGES_JS,
  CLICK_JS,
  TYPE_JS,
  SCROLL_JS,
  SNAPSHOT_JS,
  PERFORM_JS,
  SIGNATURE_JS,
  READ_JS,
  CAPTURE_JS,
  CSS_QUERY_JS,
  TARGET_BUSY_JS,
  AUTOCOMPLETE_STATE_JS,
  DISMISS_DIALOG_STATE_JS,
  CURSOR_JS,
  MARKS_JS,
  COMPOSE_MARKS_JS,
  REMOVE_MARKS_JS,
  CURSOR_VISIBILITY_JS,
  HOVER_TARGET_JS,
  ASSERT_JS,
  UPLOAD_JS,
  FOCUS_JS,
  WAIT_TEXT_JS,
  WAIT_DOM_ACTIVITY_JS,
  SUGGEST_ACTIVITY_JS,
  CLICK_RESOLVE_JS,
  REVEAL_TARGET_JS,
  SELECT_ALL_CONTENT_JS,
  READ_TARGET_VALUE_JS,
  SLIDER_READ_JS,
  SLIDER_SCROLL_JS,
  BOT_CHECK_JS,
  IFRAME_RECTS_JS,
  SELECTOR_JS,
  DOC_MARKER_JS,
} from "./pageScripts.js";

const randomUUID = () => globalThis.crypto.randomUUID();

export interface BrowserTabInfo {
  tabId: number;
  url: string;
  title: string;
  current: boolean;
}

const SCRIPT_TEMPLATES = {
  FIND_IMAGES_JS,
  CLICK_JS,
  TYPE_JS,
  SCROLL_JS,
  SNAPSHOT_JS,
  PERFORM_JS,
  READ_JS,
  CAPTURE_JS,
  CSS_QUERY_JS,
  TARGET_BUSY_JS,
  AUTOCOMPLETE_STATE_JS,
  DISMISS_DIALOG_STATE_JS,
  CURSOR_JS,
  MARKS_JS,
  REMOVE_MARKS_JS,
  CURSOR_VISIBILITY_JS,
  HOVER_TARGET_JS,
  ASSERT_JS,
  UPLOAD_JS,
  FOCUS_JS,
  WAIT_TEXT_JS,
  WAIT_DOM_ACTIVITY_JS,
  SUGGEST_ACTIVITY_JS,
  CLICK_RESOLVE_JS,
  REVEAL_TARGET_JS,
  SELECT_ALL_CONTENT_JS,
  READ_TARGET_VALUE_JS,
  SLIDER_READ_JS,
  SLIDER_SCROLL_JS,
  BOT_CHECK_JS,
  IFRAME_RECTS_JS,
  SELECTOR_JS,
  DOC_MARKER_JS,
} as const;

type ScriptName = keyof typeof SCRIPT_TEMPLATES;

/** Hard bounds on `driveSlider`: total trusted key presses (what a
 * misbehaving widget can cost; large ranges are covered by Home/End and page
 * keys, not by raising this), and the margin subtracted from the controller's
 * command timeout to get the loop's own deadline, so it ends itself before
 * the command timeout abandons it mid-flight. */
const SLIDER_MAX_PRESSES = 300;
const SLIDER_TIME_MARGIN_MS = 3_000;

/** jev-loop design doc "Addendum 2, 2026-09-19" §2: default/hard-cap for
 * browse_read's `maxChars`. */
const READ_MAX_CHARS_DEFAULT = 6_000;
const READ_MAX_CHARS_HARD_CAP = 20_000;

/** How long a command result waits for a just-opened popup's url (see
 * resolveOpenedTab), and how often it re-lists the tabs meanwhile. Short on
 * purpose: a popup that stays on about:blank (window.open('') + document.write)
 * pays this on every click that opens it. */
const OPENED_TAB_URL_WAIT_MS = 1_000;
const OPENED_TAB_URL_POLL_MS = 50;
/** browse-capture design (2026-10-15): the serialized HTML document of a
 * `capture` over this many characters is refused. */
const CAPTURE_MAX_CHARS = 3_000_000;
/** v2: capture fetches stylesheets, so it gets its own budget instead of the
 * default command timeout (the editor's tool timeout is above it). */
const CAPTURE_BUDGET_MS = 45_000;
/** Below this much remaining command time the page-query phase is skipped. */
const CSS_QUERY_MIN_REMAINING_MS = 3_000;
/** Each page query is abandoned this long before the command deadline. */
const CSS_QUERY_DEADLINE_MARGIN_MS = 2_000;
/** Selectors per CSS_QUERY_JS call (keeps the injected args JSON small). */
const CSS_QUERY_CHUNK = 5_000;

/** The one "Page is too large" message (the page script only reports `tooLarge`). */
function tooLargeMessage(chars: number): string {
  return `Page is too large to capture (${formatCaptureSize(chars)} characters, limit ${formatCaptureSize(CAPTURE_MAX_CHARS)}).`;
}

function formatCaptureSize(v: number): string {
  return v >= 1_000_000 ? (v / 1_000_000).toFixed(1) + "M" : v >= 1000 ? (v / 1000).toFixed(1) + "K" : String(v);
}

/** The `{ changed, changes }` signature diffed before/after an action —
 * "Addendum 2" §1. `changes` entries are stable, documented category names
 * ("url" | "title" | "dom" | "text" | "main-image"), not raw field names. */
export interface EffectEvidence {
  changed: boolean;
  changes: string[];
  /** Browse-speed contract (2026-09-24), report-only: whether a real,
   * visible-content mutation happened during the action window — a stricter
   * signal than `changes.includes("dom"|"text")`, which counts whole-
   * document noise (carousels, lazy images) on purpose to stay useful as
   * context. `pageChanged` ignores the cursor/marks overlay, script/style/
   * link/meta churn and attribute-only mutations, so a caller can trust it
   * as "something a user would see actually changed" even when `changed` is
   * false (e.g. a click that mutated a status element elsewhere on the page
   * rather than the clicked element itself). Present whenever an "after"
   * signature capture succeeded; absent when it didn't (see diffSignatures). */
  pageChanged?: boolean;
  /** Up to 3 short (<=80 char) snippets of visible text that newly appeared
   * or changed during the action window — never input/password values.
   * Present (possibly empty) whenever `pageChanged` is present. */
  appeared?: string[];
}

/** A single element's own signature — SCOPED_SIGNATURE_JS in pageScripts.ts.
 * Review finding 4: the element actually acted on, not the whole document,
 * is the real evidence on a live page. */
interface ScopedSignature {
  nodeCount: number;
  textHash: number;
  src: string;
  valueLength: number;
  /** Numeric hash of the value (0 for a password field); optional so older shapes still validate. */
  valueHash?: number;
  ariaExpanded: string;
  ariaSelected: string;
  /** Optional: a slider's only moving property (see SCOPED_SIGNATURE_JS). */
  ariaValueNow?: string;
  checked: boolean;
}

function isScopedSignature(value: unknown): value is ScopedSignature {
  return (
    isRecord(value) &&
    typeof value.nodeCount === "number" &&
    typeof value.textHash === "number" &&
    typeof value.src === "string" &&
    typeof value.valueLength === "number" &&
    (value.valueHash === undefined || typeof value.valueHash === "number") &&
    typeof value.ariaExpanded === "string" &&
    typeof value.ariaSelected === "string" &&
    (value.ariaValueNow === undefined || typeof value.ariaValueNow === "string") &&
    typeof value.checked === "boolean"
  );
}

interface PageSignature {
  url: string;
  title: string;
  nodeCount: number;
  textLength: number;
  textHash: number;
  mainImageSrc: string;
  /** Review finding 3: absent from the original signature, so a successful
   * scroll and a scroll on a dead page were indistinguishable. */
  scrollY: number;
  /** Review finding 3: a *length*, never the focused field's content — see
   * SCOPED_SIGNATURE_JS's doc comment for the same reasoning applied to the
   * scoped-target signature. */
  focusedValueLength: number;
  /** Numeric hash of the focused field's value (never the value). Optional: older shapes lack it. */
  focusedValueHash?: number;
  /** Numeric hash of the visible form controls' live state. Optional: older shapes lack it. */
  controlsHash?: number;
  /** Only present on a `phase: "after"` capture, and only when the acting
   * script stamped a target element — review finding 4. */
  scopedAfter?: ScopedSignature | null;
  /** Browse-speed contract (2026-09-24) — see EffectEvidence's doc comment.
   * `false`/`[]` on a "before" capture (SIGNATURE_JS only tracks real
   * mutations while the observer runs, i.e. between "before" and "after").
   * Optional on the type (rather than required) only so isPageSignature
   * keeps validating pre-2026-09-24 fixtures/mocks that predate these
   * fields — a real SIGNATURE_JS capture always includes both; diffSignatures
   * defaults a missing value to false/[]. */
  pageChanged?: boolean;
  appeared?: string[];
  /** Only on a "before" capture: the id SIGNATURE_JS minted for the observer
   * state it just created. The matching "after" sends it back; a mismatch
   * makes the page discard whatever state is stored (see SIGNATURE_JS). */
  captureId?: string;
}

/** See BrowserController.autocompleteBaseline. */
interface AutocompleteBaseline {
  key: string | null;
  /** The field's OWN list (aria-controls/aria-owns) digest, when it named one
   * with visible options at baseline time. */
  ownKey: string | null;
  /** A plain text field (no ARIA autocomplete hints): see settlePlainSuggestions. */
  plain: boolean;
  /** networkStats generation when the baseline was taken (plain fields only). */
  netGen: number | null;
  taken: boolean;
  take(): Promise<void>;
  /** Undoes what a plain field's baseline left on the page (the activity
   * observer). The pre-type layer stamps stay on purpose: the next snapshot
   * needs them (see penStampPreType). Idempotent; owners call it in a finally
   * around the whole type path. */
  release(): Promise<void>;
}

function isPageSignature(value: unknown): value is PageSignature {
  return (
    isRecord(value) &&
    typeof value.url === "string" &&
    typeof value.title === "string" &&
    typeof value.nodeCount === "number" &&
    typeof value.textLength === "number" &&
    typeof value.textHash === "number" &&
    typeof value.mainImageSrc === "string" &&
    typeof value.scrollY === "number" &&
    typeof value.focusedValueLength === "number" &&
    (value.focusedValueHash === undefined || typeof value.focusedValueHash === "number") &&
    (value.controlsHash === undefined || typeof value.controlsHash === "number") &&
    (value.scopedAfter === undefined || value.scopedAfter === null || isScopedSignature(value.scopedAfter)) &&
    (value.captureId === undefined || typeof value.captureId === "string") &&
    (value.pageChanged === undefined || typeof value.pageChanged === "boolean") &&
    (value.appeared === undefined || (Array.isArray(value.appeared) && value.appeared.every((s) => typeof s === "string")))
  );
}

/** Review finding 3: type/scroll (and perform's TYPE_TEXT/SELECT/SCROLL_*)
 * had no settle at all between the action and the after-capture, and the
 * fields that would show they worked (scrollY, a focused input's value
 * length) weren't even in the signature — a successful type/scroll and a
 * dead one both reported changed: false. Short, because unlike a click
 * there is no navigation to wait for, just a paint/reflow. */
const NON_CLICK_SETTLE_MS = 50;

/** After a type into an autocomplete-style field (role=combobox,
 * aria-autocomplete, aria-haspopup=listbox): the suggestions are fetched
 * asynchronously behind a debounce, so the 50ms settle above returns before
 * any `role=option` exists and the next snapshot never offers the
 * suggestion (Google Flights "Where to?"). `settleAutocomplete` polls every
 * AUTOCOMPLETE_POLL_INTERVAL_MS until the visible options are present and
 * unchanged across two polls — and, when a list was already on screen
 * BEFORE the text went in (Google Flights shows "popular destinations" on
 * focus), different from that baseline, so the stale list is not taken for
 * the settled suggestions. Bounded by AUTOCOMPLETE_SETTLE_MS (and the
 * command deadline minus SETTLE_HEADROOM_MS) so a field that never suggests
 * anything costs at most that much. Plain fields pay one baseline probe
 * before and one probe after, and no wait. */
export const AUTOCOMPLETE_SETTLE_MS = 2_000;
const AUTOCOMPLETE_POLL_INTERVAL_MS = 100;
/** Plain-field suggestions: activity window, overall cap, activity poll. */
const PLAIN_SUGGEST_ACTIVITY_MS = 400;
const PLAIN_SUGGEST_MAX_MS = 1_200;
const PLAIN_SUGGEST_POLL_MS = 50;
/** Activity must have been quiet this long, with no popup, to stop waiting. */
const PLAIN_SUGGEST_QUIET_MS = 300;

/** The optional waits above (autocomplete, dialog dismissal, the late-click
 * re-check) used to be capped by the command's own `deadlineAt`, so a wait
 * that ran to its cap left nothing for what follows — the after-capture,
 * `detectOpenedTab`, `settleWhileTargetBusy` — and `withCommandTimeout`
 * reported a timeout for an action that had landed. They now stop at
 * `deadlineAt - SETTLE_HEADROOM_MS` (and are skipped once already past it);
 * the headroom covers those follow-ups on a slow page. */
export const SETTLE_HEADROOM_MS = 1_500;

/** A click whose effect lands after the settle: the site animates the
 * change behind a CSS transition / `setTimeout` (Google Flights' calendar
 * "Done" hides its dialog ~300 ms after the click), so the after-capture
 * taken at ~540 ms saw nothing and the step was recorded "(no effect)".
 * When a same-URL click diffs as `changed: false`, `captureClickEffect`
 * re-captures every LATE_CLICK_POLL_MS until something changed or
 * LATE_CLICK_EFFECT_MS elapsed (also bounded by the command deadline minus
 * SETTLE_HEADROOM_MS). A click that changes anything at once — or shows any
 * other effect the browse_task loop counts (`pageChanged`, an opened tab) —
 * pays no extra wait. */
export const LATE_CLICK_EFFECT_MS = 800;
const LATE_CLICK_POLL_MS = 150;

/** After a click on a dialog-dismissing control (REVEAL_TARGET_JS's
 * `dismissDialog`), `settleDialogDismiss` polls every DIALOG_DISMISS_POLL_MS
 * until the dialog is hidden/detached, capped by DIALOG_DISMISS_SETTLE_MS:
 * while a closing dialog is still mounted the next snapshot scopes to it as
 * `modal` and hides the page behind it. A click that dismisses nothing (a
 * day cell, anything outside a dialog) never polls. */
export const DIALOG_DISMISS_SETTLE_MS = 1_000;
const DIALOG_DISMISS_POLL_MS = 100;

/** Spec `2026-09-18-browse-task-jev-loop-design.md` §1: the element table is
 * the whole request payload for /api/browse/step, so an uncapped snapshot on
 * a big page is both slow and expensive. */
export const MAX_SNAPSHOT_ELEMENTS = 120;

/** Wave 3 reliability, item 2: at most this many child frames are ever
 * descended into for one snapshot/read/findImages call — a page with dozens
 * of ad/tracker iframes must not turn one command into dozens of extra
 * round trips. */
export const MAX_BROWSER_FRAMES = 8;

/** Wave 3 reliability, item 2: electron/electron#5183 — a child frame's own
 * `executeJavaScript` only resolves once THAT frame stops loading, so a
 * frame that never finishes (a slow/broken ad iframe) must not hang the
 * whole command. Short on purpose: this bounds one frame's script call, not
 * the whole multi-frame command. */
export const FRAME_SCRIPT_TIMEOUT_MS = 1_500;

/** Wave 3 reliability, item 4: bounds `checkBotWall`'s own script call,
 * independent of `open`'s own DOM-ready/grace-period timing — see
 * `checkBotWall`'s doc comment for why this has to be its own short budget
 * rather than inheriting whatever's left of the command's timeout. */
export const BOT_CHECK_TIMEOUT_MS = 400;
/** `act`/`perform` results keep this many (deduped, newest) console errors and failed requests; the drain empties the buffer. */
const MAX_DRAINED_DIAGNOSTICS = 20;

/** A top-document `<iframe>` matched to its `WebFrameMain` child frame — see
 * `resolveVisibleFrames`'s doc comment. */
interface ResolvedFrame {
  frameId: number;
  url: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Below the frontend's own per-tool timeout, so the agent gets a real "the
 * browser command timed out" message rather than a generic tool-loop
 * timeout with no detail. */
export const BROWSER_COMMAND_TIMEOUT_MS = 20_000;

/** Added to the command budget for the signature observer's self-disconnect
 * timer (SIGNATURE_JS `ttlMs`), so it never fires before the command's final
 * capture. */
export const SIGNATURE_OBSERVER_MARGIN_MS = 5_000;

/** `open`'s own, longer budget.
 *
 * Every other command evaluates a script against a page that already
 * exists, so 20s is generous. `open` is a NAVIGATION: it waits on a remote
 * server, and measured against the live site (2026-09-19, 8 runs) an
 * amazon.com search stalled past 20s in roughly one run in four while the
 * rest finished in ~2s. The DOM-ready race below does not help those: when
 * Amazon is slow it is slow at the document level, so `dom-ready` has not
 * fired either and there is nothing to race against — the request simply
 * needs longer than a script call ever should.
 *
 * Deliberately not unbounded: a command that never returns is worse than
 * one that fails, and the frontend loop's own per-step budget still has to
 * fit several of these. */
export const BROWSER_OPEN_TIMEOUT_MS = 45_000;

/** How long a click is given to show *any* sign of having started a
 * navigation — either `getURL()` moving away from its pre-click value, or
 * `isLoading()` going true — before concluding it didn't navigate at all
 * (see runClick's doc comment / finding 7 and settleAfterClick below).
 * `isLoading()` is the signal that actually keeps this bound usable: real
 * Electron navigations flip it true essentially as soon as the navigation is
 * requested (`did-start-loading`), long before a slow commit would move
 * `getURL()` — relying on the URL alone is what made addendum F's "commit
 * takes longer than 300ms" case possible.
 *
 * Wave 1 speed (`2026-09-24-browse-speed-contract.md`): this is now only the
 * *fallback* bound, used when a `BrowserPageHandle` doesn't implement
 * `onNavigationEvent` (every unit-test fake, notably) and this file has to
 * fall back to the original polling behaviour. A real desktop page settles
 * via `NAV_START_GRACE_MS` instead — see `armNavigationWatcher`. */
const CLICK_SETTLE_TIMEOUT_MS = 300;

/** Wave 1 speed: how long `armNavigationWatcher` waits, event-driven, for a
 * `did-start-navigation`/`did-navigate`/`did-navigate-in-page`/
 * `did-start-loading` event on the acted-on tab before concluding the action
 * didn't navigate at all — the event-driven replacement for polling
 * `getURL()`/`isLoading()` for up to CLICK_SETTLE_TIMEOUT_MS (300ms). A real
 * Electron navigation fires `did-start-loading` essentially synchronously
 * with the click handler that triggers it, so this only has to be "long
 * enough for that event to be delivered", not "long enough to catch a slow
 * commit" — hence much shorter than the 300ms polling bound it replaces.
 * Picked to match the contract's own suggested 60–100ms range; 80ms leaves
 * comfortable margin over a same-process event dispatch while still cutting
 * a non-navigating click's settle time roughly 4x versus the old fixed
 * probe. */
const NAV_START_GRACE_MS = 80;

/** Wave 1 speed: CDP network-quiet settle (Stagehand's
 * `waitForDomNetworkQuiet`), used by `settleAfterClick` once a click/press is
 * known NOT to have navigated — a click that triggers a `fetch()` without a
 * full navigation (the common SPA case) previously got no wait at all beyond
 * the fixed 300ms probe, so a slow-network render (e.g. 1.2s) was routinely
 * missed by the very next read. "Quiet" means zero relevant in-flight
 * requests (tracked via CDP `Network.*` events, `BrowserPageHandle.
 * networkStats`) continuously for this long. 300ms — long enough that a
 * request chain (one fetch kicking off another) doesn't get cut off between
 * requests, short enough that it doesn't meaningfully slow down an action
 * whose network traffic has genuinely settled; the same order of magnitude
 * as CLICK_SETTLE_TIMEOUT_MS/NAV_START_GRACE_MS above. */
const NETWORK_QUIET_WINDOW_MS = 300;

/** Wave 1 speed: absolute upper bound on how long `settleAfterClick`/`act`'s
 * `wait` will wait for network quiet, regardless of how much traffic keeps
 * arriving — a page that never goes network-quiet (analytics beacons aside,
 * which are already filtered — see `networkStats`) must not be able to stall
 * a command past this. Comfortably under BROWSER_COMMAND_TIMEOUT_MS's
 * default headroom for act/press (`this.timeoutMs + this.cursorBudgetMs`). */
const NETWORK_QUIET_HARD_CAP_MS = 5_000;

/** Wave 1 speed: a single tracked request still "in flight" this long after
 * it started is force-dropped from the pending count — a long-poll or SSE
 * connection that never completes would otherwise keep `networkStats().
 * pending` above zero forever and defeat the quiet check entirely. */
const NETWORK_REQUEST_DROP_MS = 2_000;

/** Wave 1 speed: how often `waitForNetworkQuiet`'s loop polls
 * `page.networkStats()` — a cheap, synchronous, in-process call (no
 * `executeJavaScript` round trip), so a short interval costs nothing. */
const NETWORK_POLL_INTERVAL_MS = 20;

/** Addendum F ("Load, not commit"): once a click is seen to have started a
 * navigation (settleAfterClick's first phase), how long to wait for the
 * document to actually finish loading (`isLoading()` back to false) before
 * trusting the result's url/title. Navigation *commit* — the point
 * `getURL()` changes — is not the same as laid out: a following
 * browse_find_images measures an unlaid-out document at commit, where every
 * getBoundingClientRect() is 0x0, so the size filter drops every image and
 * the tool reports count: 0. This is a separate, longer budget than
 * CLICK_SETTLE_TIMEOUT_MS because a real page load is routinely slower than
 * the time it takes just to observe that a navigation started at all. */
const CLICK_LOAD_SETTLE_TIMEOUT_MS = 8_000;

/** How long an action may wait for a control that disabled *itself* while
 * its handler runs (see pageScripts.ts's TARGET_BUSY_HELPER_JS for the
 * case, from upstream jev-ultrafast PR #58). Paid only when the acting
 * script reports `__targetSelfDisabled` — a control that was already
 * disabled before the action, or one that never goes busy, waits zero. The
 * bound is what keeps a control that never re-enables (a button disabled
 * for good after submit) from burning the whole command timeout: after it,
 * the observation proceeds anyway, exactly as it did before this wait
 * existed. */
const BUSY_SETTLE_TIMEOUT_MS = 3_000;
const BUSY_POLL_INTERVAL_MS = 50;
/** How long a CLICK/TYPE_TEXT on a natively disabled target waits for it to
 * re-enable (a busy control) before refusing it as locked. */
const DISABLED_WAIT_MS = 1_500;

/** Bounds `moveCursor`'s own CURSOR_JS call — a margin above CURSOR_JS's own
 * internal 600ms backstop (arrival itself is capped at 300ms), so that backstop (which always resolves with a
 * best-effort position rather than hanging) is what normally fires, not
 * this outer timeout.
 *
 * The cursor step runs *inside* the same closure `withCommandTimeout` bounds
 * (see `moveCursor`'s own call sites in `act`/`perform`), so its own bound
 * is added to that command's budget rather than carved out of it (see
 * `BrowserController.cursorBudgetMs`) — a cosmetic overlay must never be
 * what pushes a slow-but-working command over its timeout. `moveCursor`'s
 * own call to `withTimeout` is still independently bounded by
 * `Math.min(this.timeoutMs, CURSOR_TIMEOUT_MS)`, so a short caller-supplied
 * `timeoutMs` still gets a correspondingly short-bounded cursor call. */
const CURSOR_TIMEOUT_MS = 900;

/** How long the command queue waits for a TIMED-OUT command's abandoned work
 * to settle before letting the next command run anyway — see
 * `BrowserController.overrun`. */
const OVERRUN_GRACE_MS = 10_000;
/** Widest image of a screenshot taken under emulation (the same bound `capture()` applies). */
const EMULATED_SCREENSHOT_MAX_WIDTH = 1280;
/** Longest `releaseFixture` waits for an apply that is still running. */
const FIXTURE_RELEASE_WAIT_MS = 5_000;

/** `open`'s DOM-ready-not-full-load fix: `webContents.loadURL()` resolves
 * only at `did-finish-load` — every subresource, including ads/trackers on a
 * heavy commercial page, which routinely blows past
 * BROWSER_COMMAND_TIMEOUT_MS. `open` instead resolves once the DOM is ready
 * (see `BrowserPageHandle.onceDomReady`) and gives the page this short,
 * bounded grace period to finish the *full* load too, so the common fast
 * page still reports `loaded: true`. Well under BROWSER_COMMAND_TIMEOUT_MS —
 * this is a courtesy wait, not a correctness requirement, so a slow page
 * simply returns with `loaded: false` instead of blocking the command. */
const OPEN_LOAD_GRACE_MS = 1_500;

/** Second-pass review finding 6: extra budget `tabs({action:"new", url})`
 * gives its own outer command on top of `openTimeoutMs`, so its nested
 * `open()` call's identically-`openTimeoutMs`-budgeted timeout always
 * resolves first — see the doc comment where this is used, in `tabs()`. */
const OPEN_COMMAND_MARGIN_MS = 5_000;

/** `act`'s `wait` action (design doc `2026-09-23-full-browser-use-design.md`):
 * default and hard cap for `ms`, mirroring `browse_read`'s
 * default/hard-cap-for-a-numeric-arg shape (`READ_MAX_CHARS_DEFAULT`/
 * `_HARD_CAP` above) — validated and clamped here, not left to whatever a
 * caller asks for, since this is untrusted LLM input. */
const WAIT_DEFAULT_MS = 3_000;
const WAIT_MAX_MS = 15_000;
/** How often `runWait` polls the page for `text` while waiting. */
const WAIT_POLL_INTERVAL_MS = 100;

/** Second-pass review finding 7: bounds `screenshot({ annotate: true })`'s
 * post-MARKS_JS paint wait (`waitForPaint`) — a double requestAnimationFrame
 * normally resolves within a frame or two (well under this), but a hidden
 * `WebContentsView` never ticks `requestAnimationFrame` at all, so this is
 * what keeps that case from hanging the whole screenshot command. */
const PAINT_WAIT_TIMEOUT_MS = 100;

/** Bound on the isolated-world compose of an annotated screenshot; a hang
 * falls back to the DOM overlay instead of timing out the whole command. */
const COMPOSE_MARKS_TIMEOUT_MS = 2_000;

/** The real viewport of a page (`innerWidth`, `innerHeight`, `devicePixelRatio`), or undefined when it cannot be read. */
async function readViewportSize(page: BrowserPageHandle): Promise<{ width: number; height: number; dpr: number } | undefined> {
  try {
    const raw: unknown = await page.executeJavaScript("JSON.stringify({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio })");
    const read: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (isRecord(read) && typeof read.width === "number" && read.width > 0 && typeof read.height === "number" && read.height > 0 && typeof read.dpr === "number" && read.dpr > 0) {
      return { width: read.width, height: read.height, dpr: read.dpr };
    }
  } catch {
    // The caller falls back to the emulated metrics.
  }
  return undefined;
}

/** A browser tab's page, as the controller needs to drive it. Electron-free
 * — window.ts supplies the real implementation over a WebContentsView. */
export interface BrowserPageHandle {
  loadURL(url: string): Promise<void>;
  executeJavaScript(code: string): Promise<unknown>;
  getURL(): string;
  getTitle(): string;
  goBack(): void;
  goForward(): void;
  reload(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  /**
   * True while the page is mid-navigation (Electron's
   * `webContents.isLoading()`). Addendum F: the post-click settle wait uses
   * this to wait for the document to actually finish loading rather than
   * merely for `getURL()` to change at navigation commit — see
   * CLICK_LOAD_SETTLE_TIMEOUT_MS's doc comment.
   */
  isLoading(): boolean;
  /**
   * Resolves once the current navigation's DOM is ready — see
   * `TabViewHandle.onceDomReady`'s doc comment (tabManager.ts) for the full
   * rationale. `open` races this against `loadURL()` so a heavy page's
   * subresources don't have to finish before the command returns.
   */
  onceDomReady(): Promise<void>;
  /**
   * Optional: true while this page's view is actually being drawn (Electron's
   * `View#getVisible()`). A hidden `WebContentsView` stops firing
   * `requestAnimationFrame`, so CURSOR_JS's animation never starts and the
   * script only settles via its internal backstop — burning ~1.15s per
   * click/type/select for an overlay nobody is looking at (this repo has
   * been bitten by rAF-in-a-hidden-tab before — get_screenshot). `moveCursor`
   * skips the cursor step entirely when this returns false. A handle that
   * doesn't implement it (every fake page in the test suite, notably) behaves
   * as before — the cursor always runs.
   */
  isVisible?(): boolean;
  /**
   * Optional: full browser use (design doc `2026-09-23-full-browser-use-design.md`).
   * Captures the tab's current viewport as a downscaled JPEG — window.ts's
   * real implementation is `webContents.capturePage()` resized to ≤1280px
   * wide and encoded via `nativeImage.toJPEG(70)`. Returns `null` (not a
   * rejection) on an empty capture (`image.isEmpty()`) or any other capture
   * failure — `screenshot()` turns that into a `{ error }` result rather
   * than handing back a blank image.
   */
  capture?(): Promise<{ imageData: string; width: number; height: number } | null>;
  /**
   * Optional: fetches a text resource (a stylesheet) OUTSIDE the page's CORS
   * and origin rules. Desktop uses the browser partition's `session.fetch`
   * (which carries that partition's cookies); the Playwright adapter uses
   * Node's `http`/`https` and is COOKIE-LESS (it also refuses private
   * addresses, see the adapter). `capture` v2 uses it to inline
   * `<link>`/`@import` CSS; a handle without it falls back to literal
   * `@import url(...)` lines. Must reject past `maxBytes` and on timeout, and
   * must never be pointed at an address the page could not reach publicly
   * (`isFetchAllowed`, else `isFetchableStylesheetUrl`, is checked before the call).
   */
  /**
   * Optional: the URL policy for `fetchText`. Without it only public
   * http(s) URLs are fetched (`isFetchableStylesheetUrl`). The desktop shell
   * also allows the page's own origin (a local dev server); a server-side
   * adapter must NOT widen it, since its requests leave from the server.
   */
  isFetchAllowed?(url: string): boolean;
  fetchText?(
    url: string,
    opts: { timeoutMs: number; maxBytes: number; signal?: AbortSignal },
  ): Promise<{ status: number; text: string; contentType?: string }>;
  /**
   * Optional: sends a raw Chrome DevTools Protocol command against this
   * tab's attached debugger session (`webContents.debugger` in window.ts,
   * attached once per browser tab at creation — see CLAUDE.md's "Full
   * browser use" section). Backs `act`'s `press` (`Input.dispatchKeyEvent`)
   * and `hover` (`Input.dispatchMouseEvent`) — both are trusted, OS-level
   * input events, unlike a page-script `dispatchEvent`, which is what makes
   * `press` reach an app's real keydown handlers and `hover` genuinely
   * trigger `:hover`/`mouseover`. Absent (or rejecting) when the debugger
   * failed to attach (e.g. real DevTools already attached to this tab) —
   * `press`/`hover` report a clear `{ error }` in that case rather than
   * silently doing nothing.
   */
  sendCdp?(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /**
   * Optional: drains (and clears) the JS dialogs (`alert`/`confirm`/
   * `prompt`/`beforeunload`) this tab's CDP session auto-handled since the
   * last drain — see CLAUDE.md's dialog policy. `withCommandTimeout` calls
   * this after every command and merges a non-empty result into that
   * command's own `{ dialogs }` field, so a dialog raised mid-action is
   * reported back to the agent instead of just silently vanishing.
   */
  drainDialogs?(): { type: string; message: string }[];
  /**
   * Optional: Wave 3 reliability, item 3 (revised by code review finding
   * 3). Drains (and clears) this tab's console-error ring buffer — JS
   * exceptions and explicit `console.error(...)` calls, both reported via
   * Electron's `webContents.on("console-message", ...)` with `level ===
   * "error"` — since the last drain. Deliberately NOT sourced from the CDP
   * `Runtime` domain: `Runtime.enable` is a common automation fingerprint,
   * and a browser tab is the user's own real, logged-in session, not a
   * disposable scraping target. Each entry is already truncated to ≤200
   * chars at capture time (window.ts); the ring buffer itself caps at 50
   * entries (oldest dropped first) so a page that spams errors can't grow
   * it unboundedly between drains. Merged into `act`/`perform` results only
   * (never `open`/`read`/etc, which have no "since the previous command"
   * window to report against) — present for any browser tab regardless of
   * whether its CDP debugger session attached, unlike `sendCdp`/
   * `drainDialogs`, since it needs no debugger session at all.
   */
  drainConsoleErrors?(): string[];
  /**
   * Optional: drains (and clears) the requests that failed since the last drain
   * (QA diagnostics, docs/specs/2026-10-18-qa-diagnostics-design.md). Each entry is
   * "<METHOD> <status|errorText> <origin><pathname>" (no query, no hash), at most
   * 200 chars; the ring buffer caps at 50. It records HTTP status >= 400 and
   * network failures, not requests the page canceled, and skips data: URLs,
   * WebSocket, EventSource and beacons. Merged into `act`/`perform`/`assert`
   * results as `failedRequests`, like `drainConsoleErrors`.
   */
  drainFailedRequests?(): string[];
  /**
   * Optional: Wave 1 speed (`2026-09-24-browse-speed-contract.md`).
   * Subscribes to this tab's navigation lifecycle (`did-start-navigation`,
   * `did-navigate`, `did-navigate-in-page`, `did-start-loading`) — fired
   * once per event, with no payload, since `armNavigationWatcher` only ever
   * needs "did *something* just start", not which event it was. Returns an
   * unsubscribe function. Absent on every unit-test fake, notably — callers
   * fall back to polling `getURL()`/`isLoading()` (the pre-Wave-1 behavior)
   * when this is undefined, so behavior is unchanged wherever a page handle
   * doesn't implement it.
   */
  onNavigationEvent?(cb: () => void): () => void;
  /**
   * Optional: Wave 1 speed. A cheap, synchronous snapshot of this tab's
   * CDP-tracked network activity (`Network.enable`'d once at tab creation
   * alongside `Page.enable` — see CLAUDE.md's "Network-quiet settle"
   * section). `dropAfterMs` force-drops (and stops counting) any request
   * still outstanding longer than that — a long-poll/SSE connection must
   * never keep `pending` above zero forever. `generation` increments once
   * per *new* relevant request seen (WebSocket/EventSource/Ping —
   * covering beacons — are never counted at all), so a caller can detect
   * "did any request start since I last checked" without needing to track
   * individual completed requests, which vanish from the live pending set
   * the moment they finish. Absent when the debugger failed to attach, same
   * as `sendCdp`.
   *
   * `sinceGeneration`, when given, scopes `pending` down to only requests
   * whose own per-request generation is greater than it (code review
   * finding 2) — omitted (the default, used by `runWaitForActivityThenQuiet`)
   * counts every currently-pending request regardless of when it started, as
   * before. Without this, a request already in flight *before* the acted-on
   * command (a lazy-loading image grid still fetching from a prior scroll,
   * say) kept `pending` above zero for `waitForNetworkQuiet`, making a
   * genuinely no-network action (a baseline-unchanged click) wait out the
   * full quiet window/hard cap for a request it never caused and has no
   * bearing on.
   */
  networkStats?(dropAfterMs: number, sinceGeneration?: number): { pending: number; generation: number };
  /**
   * Optional: Wave 3 reliability, item 2. Every direct child frame of the
   * top document (Electron's `webContents.mainFrame.frames` — one level
   * deep, same-origin AND cross-origin/OOPIF frames alike; WebFrameMain
   * abstracts over the process boundary so both look identical here).
   * `frameId` is Electron's `frameTreeNodeId` — stable for the frame's
   * lifetime, unlike the deprecated `routingId`. Absent on every unit-test
   * fake — `snapshot`/`read`/`findImages` degrade to top-document-only, the
   * pre-Wave-3 behavior.
   */
  listFrames?(): { frameId: number; url: string; name: string }[];
  /**
   * Optional: Wave 3 reliability, item 2. Runs `code` inside the named
   * child frame (by `frameId`, from `listFrames()`) and races it against
   * `timeoutMs` — electron/electron#5183 means a child frame's own
   * `executeJavaScript` only resolves once THAT frame stops loading, so a
   * frame that never finishes loading must not hang the whole snapshot; a
   * timed-out or failed frame is simply skipped by the caller. Rejects if
   * the frame no longer exists (closed/navigated away) between `listFrames`
   * and this call.
   */
  /** Runs `code` in an ISOLATED world of the top document (own globals, same
   * DOM), awaiting a returned promise. Optional: only COMPOSE_MARKS_JS uses
   * it, and without it the annotated screenshot uses the DOM-overlay fallback —
   * compose NEVER runs in the page's main world (page scripts could patch
   * decoders and read cross-origin iframe pixels, or forge the result). */
  executeJavaScriptIsolated?(code: string): Promise<unknown>;
  executeJavaScriptInFrame?(frameId: number, code: string, timeoutMs: number): Promise<unknown>;
}

// BrowserTabInfo is declared once, in tabManager.ts (second-pass review
// finding 10) — before this, controller.ts and tabManager.ts each declared
// their own structurally-identical copy (one comment even said so:
// tabManager.ts's used to read "structurally identical to BrowserTarget's
// own BrowserTabInfo there"), which is exactly the kind of pair that can
// silently drift. Re-exported here (imported at the top of this file) so
// every existing `import { BrowserTabInfo } from "./controller"` keeps
// working.
export interface BrowserTarget {
  /** Resolves the tab to drive, creating one if none exists. */
  ensurePage(): Promise<BrowserPageHandle>;
  /** Null when no browser tab is open — read-only commands fail cleanly. */
  currentPage(): BrowserPageHandle | null;
  /**
   * Optional: full browser use's `tabs` command. All four are present or
   * all four are absent in practice (window.ts implements them together
   * over TabManager) — `tabs()` reports "not supported" up front if any is
   * missing, rather than failing action-by-action.
   */
  listPages?(): Promise<BrowserTabInfo[]>;
  selectPage?(tabId: number): Promise<boolean>;
  closePage?(tabId: number): Promise<boolean>;
  newPage?(url?: string): Promise<BrowserTabInfo>;
  /**
   * Optional: review finding 6. Every currently open browser tab's own
   * `BrowserPageHandle`, tagged with its `tabId` — used by `mergeDialogs` to
   * drain dialogs from *every* browser tab, not just `currentPage()`. Without
   * this, a dialog on a tab that isn't the one a command happens to act on
   * (a popup that raised its own dialog, or the tab a command just switched
   * away from) was silently dropped instead of surfacing on the next command
   * that could report it. Absent on any `BrowserTarget` that predates this
   * (every unit-test fake, notably) — `mergeDialogs` degrades to draining
   * only `currentPage()`, the previous behavior.
   */
  pageHandles?(): Promise<{ tabId: number; page: BrowserPageHandle }[]>;
  /**
   * Optional: PageFixture cookies (docs/specs/2026-10-15-page-fixture-design.md).
   * Cookies live on the browser context, not on a page, so they are target
   * methods. `urls` limits the result to cookies that apply to those URLs.
   * `applyFixture` with cookies fails clearly on a target without `setCookies`.
   */
  getCookies?(urls?: string[]): Promise<FixtureCookie[]>;
  setCookies?(cookies: FixtureCookie[]): Promise<void>;
  /**
   * Optional: QA start network mocks (docs/specs/2026-10-15-qa-start-design.md).
   * `handler` runs for every request of every tab of the browser context; it
   * returns the mock response, or `undefined` to let the request through. The
   * returned function removes the interception. A fixture with `network` fails
   * clearly on a target without it. A target that runs in the user's own
   * profile (desktop) must not implement it without scoping the rules to the
   * agent's tabs.
   */
  routeRequests?(handler: (req: FixtureRequestInfo) => FixtureMockResponse | undefined): Promise<() => Promise<void>>;
  /**
   * Optional: `PageFixture.fresh`. Closes ALL tabs and opens one new blank
   * tab (so sessionStorage and history are gone), then clears cookies, permissions and the storage of every origin the
   * target saw (main-frame navigations) plus `origins` (the fixture's own). NEVER implement it on a profile shared with the user: it
   * would log the user out of everything.
   */
  resetSession?(origins?: string[]): Promise<void>;
}

export type BrowserCommandResult = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A fixture command's result as the fixture shape: a timeout comes back from
 * `withCommandTimeout` as a bare `{ error }`. */
function fixtureResult<T>(result: BrowserCommandResult, stage?: FixtureStage): T {
  if (typeof result.ok === "boolean") return result as unknown as T;
  return { ok: false, ...(stage !== undefined ? { stage } : {}), error: String(result.error ?? "The fixture command failed.") } as unknown as T;
}

function errorResult(message: string): BrowserCommandResult {
  return { error: message };
}

/**
 * Set on an error result whose page script refused BEFORE it touched the page
 * (no element matched, a disabled control, no such option). The checkpoint journal
 * reads it to tell "nothing was dispatched" (no trace) from "it may have changed
 * something" (a gap). A symbol key survives the object spreads the result goes
 * through and is never serialized, so a host does not see it.
 */
const NO_EFFECT = Symbol("noEffect");

/** A page script's answer: the script's `noEffect` marker on an error becomes the `NO_EFFECT` tag, and never reaches the host. */
function scriptAnswer(result: Record<string, unknown>): BrowserCommandResult {
  if (!("noEffect" in result)) return result;
  const { noEffect, ...rest } = result;
  return noEffect === true && "error" in rest ? Object.assign(rest, { [NO_EFFECT]: true }) : rest;
}

const FRAME_LABEL_MAX = 80;
const FRAME_NAME_MAX = 60;

/** Wave 3 reliability, item 2: the `frame: "…"` label stamped onto every
 * element/text-digest entry that came from a child frame. Order: the frame's
 * own `document.title` (from its own SNAPSHOT_JS/READ_JS/FIND_IMAGES_JS
 * result, when non-blank), else the iframe's `name` when it is a VALID name
 * (<= FRAME_NAME_MAX chars, not starting with `{` or `[`, no "://" — the
 * `name` attribute is page-controlled and an ad iframe's was a 45 KB JSON
 * blob; short digit-only names are fine), else its URL's host, else the raw
 * url. Always whitespace-collapsed and capped at FRAME_LABEL_MAX, since it
 * travels in every element-table entry. */
function frameLabel(frame: { url: string; name: string }, title?: string): string {
  const cap = (value: string): string => value.trim().replace(/\s+/g, " ").slice(0, FRAME_LABEL_MAX);
  if (title && title.trim()) return cap(title);
  const name = (frame.name ?? "").trim();
  if (name && name.length <= FRAME_NAME_MAX && !/^[{[]/.test(name) && !name.includes("://")) return cap(name);
  try {
    const host = new URL(frame.url).host;
    if (host) return cap(host);
  } catch {
    // fall through
  }
  return cap(frame.url || "") || "frame";
}

/** Longest wait for the base cookies of the checkpoint journal. */
const JOURNAL_READ_TIMEOUT_MS = 5_000;
/** Longest wait for one document-marker check (a command that may change the page runs one before the action and one after). */
const JOURNAL_MARKER_TIMEOUT_MS = 3_000;
/**
 * The journal's work after a command that may change the page (marker check,
 * new base) is bounded to this share, beyond the command's own budget. When it
 * runs out, the tab gets a gap (`unknownDocument`) and the late work is not allowed to write.
 * A read-only command (snapshot, read, screenshot, findImages, tabs list...) runs none of it.
 */
const JOURNAL_SETTLE_BUDGET_MS = 10_000;
/** Added to an `applyFixture` budget when the journal reads the pre-apply state (inside that command's deadline). */
const JOURNAL_PRE_APPLY_BUDGET_MS = JOURNAL_READ_TIMEOUT_MS + JOURNAL_MARKER_TIMEOUT_MS;

/** What a command declares so the journal can stage it (see `journalPreAction`). */
interface JournalAction {
  op: "click" | "type" | "select" | "press";
  locate: { target?: string; index?: number; snapshotId?: string };
  /** Non-null: the element is in a child frame. */
  frameId: number | null;
  text?: string;
  optionText?: string;
  key?: string;
}

/** What `SELECTOR_JS` found: the staged action and the document marker (null: it could not be read). */
interface JournalLookup {
  staged: StagedAction;
  marker: string | null;
}

/**
 * What a command that may change the page declares to `withCommandTimeout`:
 * an action to stage, a navigation (`nav`: open, reload, tabs new/switch/close:
 * the settle step checks the document), or a `history` move (back, forward: a
 * move inside the same document is a gap, a new document a reset), or a `hover`
 * (lasting page state no step replays: a gap when it succeeds).
 */
type JournalDeclare = JournalAction | { op: "nav" } | { op: "history" } | { op: "hover" } | { op: "upload" };

/** The state read before an `applyFixture` changes anything (see `journalAfterApply`). */
interface PreApply {
  /** The journal had to read it (journal on, no `fresh`, an origin to read). */
  needed: boolean;
  state?: BaseState;
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function validateOpenArgs(args: unknown): { ok: true; url: string } | { ok: false; error: string } {
  if (!isRecord(args) || typeof args.url !== "string" || args.url.trim() === "") {
    return { ok: false, error: 'browse_open requires a non-empty string "url".' };
  }
  const url = args.url.trim();
  if (decideBrowserNavigation(url) !== "allow") {
    return { ok: false, error: `browse_open only supports http(s) URLs, got: ${url}` };
  }
  return { ok: true, url };
}

interface ValidatedReadArgs {
  maxChars: number;
  selector?: string;
}

function validateReadArgs(args: unknown): { ok: true; value: ValidatedReadArgs } | { ok: false; error: string } {
  if (args !== undefined && !isRecord(args)) {
    return { ok: false, error: "browse_read requires an object (or no arguments)." };
  }
  const raw = isRecord(args) ? args : {};

  let maxChars = READ_MAX_CHARS_DEFAULT;
  if (raw.maxChars !== undefined) {
    if (typeof raw.maxChars !== "number" || !Number.isFinite(raw.maxChars) || raw.maxChars <= 0) {
      return { ok: false, error: 'browse_read requires "maxChars" to be a positive number when provided.' };
    }
    // Hard cap regardless of what the caller asked for — the default (6000)
    // is a courtesy, the cap (20000) is not negotiable.
    maxChars = Math.min(raw.maxChars, READ_MAX_CHARS_HARD_CAP);
  }

  let selector: string | undefined;
  if (raw.selector !== undefined) {
    if (typeof raw.selector !== "string" || raw.selector.trim() === "") {
      return { ok: false, error: 'browse_read requires "selector" to be a non-empty string when provided.' };
    }
    selector = raw.selector;
  }

  return { ok: true, value: { maxChars, selector } };
}

interface ValidatedCaptureArgs {
  snapshotId: string | null;
  index: number | null;
}

function validateCaptureArgs(args: unknown): { ok: true; value: ValidatedCaptureArgs } | { ok: false; error: string } {
  if (args !== undefined && !isRecord(args)) {
    return { ok: false, error: "browse_capture requires an object (or no arguments)." };
  }
  const raw = isRecord(args) ? args : {};
  const hasIndex = raw.index !== undefined && raw.index !== null;
  const hasSnapshot = raw.snapshotId !== undefined && raw.snapshotId !== null;
  if (hasIndex && !isNonNegativeInteger(raw.index)) {
    return { ok: false, error: 'browse_capture requires "index" to be a non-negative integer when provided.' };
  }
  if (hasSnapshot && (typeof raw.snapshotId !== "string" || raw.snapshotId === "")) {
    return { ok: false, error: 'browse_capture requires "snapshotId" to be a non-empty string when provided.' };
  }
  if (hasIndex && !hasSnapshot) {
    return { ok: false, error: 'browse_capture requires "snapshotId" (from browse_snapshot) alongside "index".' };
  }
  if (hasSnapshot && !hasIndex) {
    return { ok: false, error: 'browse_capture requires "index" alongside "snapshotId".' };
  }
  return {
    ok: true,
    value: {
      snapshotId: hasSnapshot ? (raw.snapshotId as string) : null,
      index: hasIndex ? (raw.index as number) : null,
    },
  };
}

// Full browser use (design doc `2026-09-23-full-browser-use-design.md`)
// added select/press/hover/reload/wait to the original five.
type ActAction = "click" | "type" | "select" | "press" | "hover" | "upload" | "scroll" | "back" | "forward" | "reload" | "wait" | "viewport";

const ACT_ACTIONS: readonly ActAction[] = [
  "click",
  "type",
  "select",
  "press",
  "hover",
  "upload",
  "scroll",
  "back",
  "forward",
  "reload",
  "wait",
  "viewport",
];

function isActAction(value: unknown): value is ActAction {
  return typeof value === "string" && (ACT_ACTIONS as readonly string[]).includes(value);
}

/** Shared by `act`'s click/type/select/press/hover: an `index` requires a
 * `snapshotId` alongside it (and vice versa) — this only validates the
 * *shape*, the staleness/cross-tab check happens where `perform()` already
 * does it, for the actions that route there. */
function validateIndexSnapshot(
  args: Record<string, unknown>,
  actionLabel: string,
): { ok: true; index: number; snapshotId: string } | { ok: false; error: string } {
  if (!isNonNegativeInteger(args.index)) {
    return {
      ok: false,
      error: `browse_act "${actionLabel}" requires a non-negative integer "index" (with "snapshotId") or a string "target".`,
    };
  }
  if (typeof args.snapshotId !== "string" || args.snapshotId.trim() === "") {
    return {
      ok: false,
      error: `browse_act "${actionLabel}" with "index" also requires a non-empty string "snapshotId".`,
    };
  }
  return { ok: true, index: args.index, snapshotId: args.snapshotId };
}

function validateScreenshotArgs(
  args: unknown,
): { ok: true; value: { annotate: boolean; snapshotId?: string } } | { ok: false; error: string } {
  if (args !== undefined && !isRecord(args)) {
    return { ok: false, error: "browse_screenshot requires an object (or no arguments)." };
  }
  const raw = isRecord(args) ? args : {};
  if (raw.annotate !== undefined && typeof raw.annotate !== "boolean") {
    return { ok: false, error: 'browse_screenshot requires "annotate" to be a boolean when provided.' };
  }
  if (raw.snapshotId !== undefined) {
    if (raw.annotate !== true) {
      return { ok: false, error: 'browse_screenshot accepts "snapshotId" only together with "annotate": true.' };
    }
    if (typeof raw.snapshotId !== "string" || raw.snapshotId.trim() === "") {
      return { ok: false, error: 'browse_screenshot requires "snapshotId" to be a non-empty string when provided.' };
    }
    return { ok: true, value: { annotate: true, snapshotId: raw.snapshotId } };
  }
  return { ok: true, value: { annotate: raw.annotate === true } };
}

type TabsAction = "list" | "switch" | "close" | "new";

function isTabsAction(value: unknown): value is TabsAction {
  return value === "list" || value === "switch" || value === "close" || value === "new";
}

interface ValidatedTabsArgs {
  action: TabsAction;
  tabId?: number;
  url?: string;
}

function validateTabsArgs(args: unknown): { ok: true; value: ValidatedTabsArgs } | { ok: false; error: string } {
  if (!isRecord(args) || !isTabsAction(args.action)) {
    return {
      ok: false,
      error: `browse_tabs requires an "action" of "list", "switch", "close", or "new" (got ${
        isRecord(args) ? JSON.stringify(args.action) : JSON.stringify(args)
      }).`,
    };
  }
  const action = args.action;
  let tabId: number | undefined;
  if (args.tabId !== undefined) {
    if (!isNonNegativeInteger(args.tabId)) {
      return { ok: false, error: 'browse_tabs requires "tabId" to be a non-negative integer when provided.' };
    }
    tabId = args.tabId;
  }
  if ((action === "switch" || action === "close") && tabId === undefined) {
    return { ok: false, error: `browse_tabs "${action}" requires a "tabId".` };
  }
  let url: string | undefined;
  if (args.url !== undefined) {
    if (typeof args.url !== "string" || args.url.trim() === "") {
      return { ok: false, error: 'browse_tabs requires "url" to be a non-empty string when provided.' };
    }
    const trimmed = args.url.trim();
    if (decideBrowserNavigation(trimmed) !== "allow") {
      return { ok: false, error: `browse_tabs only supports http(s) URLs, got: ${trimmed}` };
    }
    url = trimmed;
  }
  return { ok: true, value: { action, tabId, url } };
}

type PerformOperation = "CLICK" | "TYPE_TEXT" | "SELECT" | "SCROLL_UP" | "SCROLL_DOWN";

const PERFORM_OPERATIONS: readonly PerformOperation[] = ["CLICK", "TYPE_TEXT", "SELECT", "SCROLL_UP", "SCROLL_DOWN"];

// Addendum A: index is required only for these three — SCROLL_UP/SCROLL_DOWN
// act on the page itself and must be accepted with no index at all (they
// used to always fail at the bridge because index was unconditionally
// required). WAIT is not a member of PerformOperation/PERFORM_OPERATIONS at
// all — it is never sent to perform(); the frontend loop handles it locally
// by sleeping and taking a fresh snapshot.
const INDEXED_OPERATIONS: readonly PerformOperation[] = ["CLICK", "TYPE_TEXT", "SELECT"];

function isPerformOperation(value: unknown): value is PerformOperation {
  return typeof value === "string" && (PERFORM_OPERATIONS as readonly string[]).includes(value);
}

interface ValidatedPerformArgs {
  /** Present only for CLICK/TYPE_TEXT/SELECT — see INDEXED_OPERATIONS. */
  index?: number;
  operation: PerformOperation;
  text?: string;
  snapshotId: string;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function validatePerformArgs(args: unknown): { ok: true; value: ValidatedPerformArgs } | { ok: false; error: string } {
  if (!isRecord(args)) {
    return { ok: false, error: "browse perform requires an object." };
  }
  if (typeof args.snapshotId !== "string" || args.snapshotId.trim() === "") {
    return { ok: false, error: 'browse perform requires a non-empty string "snapshotId".' };
  }
  if (!isPerformOperation(args.operation)) {
    return {
      ok: false,
      error: `browse perform requires an "operation" of ${PERFORM_OPERATIONS.join(", ")} (got ${JSON.stringify(args.operation)}).`,
    };
  }
  const operation = args.operation;
  const indexRequired = (INDEXED_OPERATIONS as readonly string[]).includes(operation);
  let index: number | undefined;
  if (indexRequired) {
    if (!isNonNegativeInteger(args.index)) {
      return { ok: false, error: `browse perform "${operation}" requires a non-negative integer "index".` };
    }
    index = args.index;
  } else if (args.index !== undefined) {
    // Not required for SCROLL_UP/SCROLL_DOWN, but if the caller passed one
    // anyway, it must still be well-formed rather than silently ignored.
    if (!isNonNegativeInteger(args.index)) {
      return { ok: false, error: `browse perform "${operation}" requires "index" to be a non-negative integer when provided.` };
    }
    index = args.index;
  }
  if (args.text !== undefined && typeof args.text !== "string") {
    return { ok: false, error: 'browse perform requires "text" to be a string when provided.' };
  }
  if ((operation === "TYPE_TEXT" || operation === "SELECT") && typeof args.text !== "string") {
    return { ok: false, error: `browse perform "${operation}" requires a string "text".` };
  }
  return {
    ok: true,
    value: { index, operation, text: args.text, snapshotId: args.snapshotId },
  };
}

export class BrowserController {
  private readonly timeoutMs: number;
  private readonly openTimeoutMs: number;

  // The most recent snapshot() call's id, together with the exact page it
  // was taken against — perform() compares its caller-supplied snapshotId
  // (and the *current* page) against this single slot and hard-errors on
  // either mismatch — see "Credentials"/§1 of the jev-loop design doc: a
  // page that re-rendered between snapshot and perform must never be
  // silently acted on, so this is a rejection, not a best-effort lookup.
  //
  // Finding 5: this used to be a bare snapshotId string, justified by "there
  // is only ever one browser tab" — but File ▸ New Browser Tab and popups
  // both make more than one possible, and `browserHandle()` (window.ts)
  // picks active-if-browser else last-created, so which tab a command hits
  // depends on what the user clicked. Without the page identity check, a
  // snapshot on tab A followed by a perform after the user switched to tab B
  // would pass this staleness check (the id matches) and only then fail
  // in-page against tab B's DOM with a misleading "no element at index N"
  // error, instead of an accurate cross-tab message. Comparing the page
  // reference itself needs no new "tab id" concept in the Electron-free
  // BrowserPageHandle — window.ts hands back the same object for a given tab
  // on every call, and a different object for a different tab.
  // Wave 3 reliability, item 2: `frameMap` records, for every global element
  // index this snapshot minted, which frame it actually lives in —
  // `frameId: null` means the top document, using SNAPSHOT_JS's own index
  // directly; a non-null `frameId` means a child frame, and `localIndex` is
  // the index *that frame's own* SNAPSHOT_JS call stamped its element with
  // (each frame numbers its own elements from 0 — see takeSnapshot). perform()
  // looks a caller's global index up here to decide whether to run the
  // follow-up script against the top page or a specific child frame.
  private lastSnapshot: {
    id: string;
    page: BrowserPageHandle;
    frameMap: Map<number, { frameId: number | null; localIndex: number }>;
    // Wave 3 reliability, item 2: each frame's own content-box offset/size
    // in top-level viewport CSS px, keyed by frameId — used to move the
    // cursor overlay (which lives in the top document) to a best-effort
    // point over a frame-routed element (the frame's own center — see
    // performUnlocked) since the overlay can't resolve or scroll to an
    // element inside a frame's own document.
    frameRects: Map<number, { x: number; y: number; width: number; height: number }>;
    // Re-mount recovery (booking.com finding): for each TOP-document
    // interactive element, the `{ tag, label, role? }` the snapshot's element
    // table reported (label already truncated by SNAPSHOT_JS). Every
    // index-based top-document page-script call carries it (see
    // `executeScript`) so FIND_BY_SNAPSHOT_JS can re-find a node the page
    // re-mounted after the stamp was set — only by a unique exact match.
    // Absent for positional-fallback labels ("<tag> #<n>"), scroll-container
    // entries, and frame-routed elements.
    fingerprints: Map<number, ElementFingerprint>;
  } | null = null;

  /** Set by `executeScript` when a page script reports `relocated: true`
   * (a re-mounted target re-found by fingerprint); read and cleared by the
   * public `act`/`perform` entry points, which surface it on their result. */
  private relocatedThisCommand = false;

  /** Second-pass review finding 8: a FIFO queue every public command
   * (open/act/findImages/snapshot/perform/read/screenshot/tabs) runs
   * through, via `runExclusive` — nothing previously serialized concurrent
   * `BrowserController` calls, so two tool calls the frontend fired without
   * waiting for each other could interleave (a `screenshot({annotate:true})`
   * overlaying marks in the middle of an unrelated command's signature
   * capture; `lastSnapshot` being replaced mid-`perform` by a `snapshot()`
   * that raced it). Each command's own `withCommandTimeout` bound already
   * guarantees it eventually settles, so a plain FIFO — no separate queue
   * timeout — is enough: nothing can wedge the queue forever short of a
   * command hanging past its own timeout, which `withCommandTimeout` doesn't
   * allow. Each command's timeout starts only once it actually begins
   * running `fn` (inside `runExclusive`'s callback), not while it's still
   * waiting in the queue — a command queued behind a slow one is not charged
   * for time it spent waiting.
   *
   * A command that itself calls another public command internally (`tabs`'s
   * "new"+url case calling `open`; `act`'s index-based branches calling
   * `perform`) must call that command's `*Unlocked` implementation directly,
   * never the public method — calling back into `runExclusive` while already
   * inside it would enqueue behind itself and deadlock forever, since the
   * outer call can't finish (and let the queue advance) until the inner call
   * it's waiting on does.
   *
   * `runExclusive` starts `fn` synchronously (no `.then()` hop at all) when
   * the queue is idle, rather than always chaining onto `mutexTail` — this
   * matters beyond micro-optimization: several existing behaviors (e.g.
   * `withCommandTimeout` capturing `pageHandles`/`currentPage()` "before
   * `fn()` runs") were written, and tested, assuming a command begins
   * executing in the same synchronous tick it's called in, up to its own
   * first `await`. Always deferring the start by one `Promise.then()` hop
   * (even for the common, uncontended case of one in-flight command at a
   * time) would push that capture one microtask later than callers observe
   * — silently changing what "before" means relative to code that runs
   * right after the call, with no queueing actually needed to explain it. */
  private mutexBusy = false;
  private mutexTail: Promise<void> = Promise.resolve();
  /** Set by `withCommandTimeout` when a command TIMES OUT: its `fn()` keeps
   * running in the background (a promise can't be cancelled), so releasing
   * the queue the moment the timeout fires would let the next command start
   * while the late click/type/`REMOVE_MARKS_JS` still lands mid-way through
   * its before/after captures (third-pass review). The next command waits
   * for that work to settle — bounded by OVERRUN_GRACE_MS, since the work
   * may be blocked forever (a page script behind a dialog). */
  private overrun: Promise<void> | null = null;

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const start = (): Promise<T> => {
      this.mutexBusy = true;
      // Checked here, inside `start`, not at enqueue time: a command already
      // waiting in the queue when its predecessor timed out must wait out
      // that predecessor's abandoned work too (see `overrun`).
      const pendingOverrun = this.overrun;
      this.overrun = null;
      // The latch is reset INSIDE the chained fn, after any pending overrun
      // has settled — an abandoned (timed-out) command that is still running
      // must not leave its latched value to this one, nor have this one reset
      // it out from under it.
      const run = (): Promise<T> => {
        this.latchedCursorEnabled = null;
        // The journal is off by default: then the command starts exactly as before, in this tick.
        return this.journal ? this.runJournaled(fn) : fn();
      };
      const p = pendingOverrun ? pendingOverrun.then(run) : run();
      p.then(
        () => {
          this.mutexBusy = false;
          this.latchedCursorEnabled = null;
        },
        () => {
          this.mutexBusy = false;
          this.latchedCursorEnabled = null;
        },
      );
      return p;
    };
    const result = this.mutexBusy ? this.mutexTail.then(start, start) : start();
    // Chained regardless of `result`'s outcome — a rejecting command must
    // still let the next queued one run, and this tail itself must never
    // reject (an unhandled rejection here would break every future queue
    // entry), so both branches resolve.
    this.mutexTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Same staleness/cross-tab guard `perform()` applies to its own
   * `snapshotId`, factored out (review finding 5) so `runPress`/`runHover`
   * can apply it too when they're given `index`+`snapshotId` — before this,
   * those two skipped the guard entirely and went straight to a page-script
   * lookup, so a stale or cross-tab snapshotId silently failed with "no
   * element" instead of the same clear staleness error `perform()` gives.
   * Returns an error result on mismatch, `null` when `snapshotId` is current
   * for `page`. */
  private checkSnapshotStale(snapshotId: string, page: BrowserPageHandle): BrowserCommandResult | null {
    if (!this.lastSnapshot || snapshotId !== this.lastSnapshot.id || page !== this.lastSnapshot.page) {
      return errorResult(
        this.lastSnapshot && snapshotId === this.lastSnapshot.id
          ? "Stale snapshotId — a different browser tab is now active. Call browser snapshot again on this tab before perform."
          : "Stale or unknown snapshotId — the page may have changed since that snapshot. Call browser snapshot again before perform.",
      );
    }
    return null;
  }

  // The last known viewport position CURSOR_JS's overlay landed at — fed
  // back as `from` on the next moveCursor call so consecutive moves chain
  // from where the cursor actually is rather than resetting to a default
  // start point every command. Updated only when a cursor call reports
  // finite numeric x/y; a failed or no-op cursor call leaves it as-is.
  private cursorPosition: { x: number; y: number } | null = null;
  // Both options may be getters so a settings menu can change them at
  // runtime: they are read per move / per command, never cached.
  private readonly cursorEnabledSource: boolean | (() => boolean);
  private readonly cursorMotionSource: string | undefined | (() => string | undefined);

  // The enabled flag is latched on its FIRST read in a command (the budget
  // read at command entry) and cleared when the command ends, so the budget
  // and the cursor step that spends it always agree even if the user flips
  // the setting mid-command. Commands are serialized (runExclusive), so one
  // field is enough.
  private latchedCursorEnabled: boolean | null = null;

  private get cursorEnabled(): boolean {
    if (this.latchedCursorEnabled !== null) return this.latchedCursorEnabled;
    const src = this.cursorEnabledSource;
    let value = true;
    try {
      value = typeof src === "function" ? src() : src;
    } catch {
      value = true;
    }
    this.latchedCursorEnabled = value;
    return value;
  }

  private get cursorMotion(): string | undefined {
    const src = this.cursorMotionSource;
    try {
      const v = typeof src === "function" ? src() : src;
      return typeof v === "string" && v !== "" ? v : undefined;
    } catch {
      return undefined;
    }
  }

  /** The cursor step runs inside the command closure `withCommandTimeout`
   * bounds, so its own bound is added to that command's budget rather than
   * taken out of it — a cosmetic overlay must never be what pushes a
   * slow-but-working command over its timeout. Zero when the cursor is
   * disabled, since no cursor step runs at all. */
  private get cursorBudgetMs(): number {
    return this.cursorEnabled ? Math.min(this.timeoutMs, CURSOR_TIMEOUT_MS) : 0;
  }

  constructor(
    private readonly target: BrowserTarget,
    opts?: {
      timeoutMs?: number;
      openTimeoutMs?: number;
      /** Cursor overlay on/off; a getter is re-read on every command. */
      cursor?: boolean | (() => boolean);
      /** CURSOR_JS motion style (see its doc comment); a getter is re-read on every move. */
      cursorMotion?: string | undefined | (() => string | undefined);
    },
  ) {
    this.timeoutMs = opts?.timeoutMs ?? BROWSER_COMMAND_TIMEOUT_MS;
    // An explicitly supplied timeoutMs bounds EVERY command including
    // open — a caller (or a test) that asks for a short budget means it.
    // open only gets its own longer default when nothing was specified.
    this.openTimeoutMs =
      opts?.openTimeoutMs ?? opts?.timeoutMs ?? BROWSER_OPEN_TIMEOUT_MS;
    this.cursorEnabledSource = opts?.cursor ?? true;
    this.cursorMotionSource = opts?.cursorMotion;
  }

  /** Runs CURSOR_JS to move the built-in browser's visible cursor overlay
   * toward the target of an upcoming action, before that action's own
   * before-signature capture — see CURSOR_JS's doc comment (pageScripts.ts)
   * for why the ordering matters. A no-op when `cursorEnabled` is false
   * (PEN_DESKTOP_BROWSER_CURSOR=off — config.ts's
   * `resolveBrowserCursorEnabled`), and also a no-op when the driven page
   * reports itself not visible (`page.isVisible?.() === false`) — a hidden
   * `WebContentsView` never fires `requestAnimationFrame`, so the animation
   * would only ever settle via its internal backstop, paying ~1.15s for an
   * overlay nobody can see. Every failure — a rejecting/throwing
   * executeJavaScript, a timeout, a malformed response — is swallowed: the
   * cursor is cosmetic, and must never turn a working browser command into
   * an error or a timeout of its own.
   *
   * Runs inside the same command closure `withCommandTimeout` bounds — see
   * `cursorBudgetMs`'s doc comment for why callers extend that budget by the
   * cursor's own bound rather than letting this eat into it. */
  private async moveCursor(
    page: BrowserPageHandle,
    spec: {
      action: "click" | "type" | "select" | "scroll" | "hover" | "press";
      target?: string;
      snapshotId?: string;
      index?: number;
      /** Wave 3 reliability, item 2: an explicit top-level-viewport point,
       * used instead of target/snapshotId+index for an element that lives
       * inside a child frame — see CURSOR_JS's doc comment for why the
       * overlay (which lives in the top document) can't resolve one of
       * those itself. */
      point?: { x: number; y: number };
    },
  ): Promise<void> {
    if (!this.cursorEnabled) return;
    if (page.isVisible?.() === false) return;
    try {
      const style = this.cursorMotion;
      // `style` is omitted entirely when unset so CURSOR_JS applies its own default.
      const scriptArgs = { ...spec, from: this.cursorPosition, ...(style ? { style } : {}) };
      // Bounded by the smaller of CURSOR_TIMEOUT_MS and this controller's
      // own configured timeoutMs — same convention as
      // settleWhileTargetBusy/waitForUrlChange/waitForLoadStop above, so a
      // caller (or a test) that asks for a short overall budget also gets a
      // short-bounded cursor call rather than one that can outlive the
      // command it's decorating.
      const result = await withTimeout(
        this.executeScript(page, "CURSOR_JS", scriptArgs),
        Math.min(this.timeoutMs, CURSOR_TIMEOUT_MS),
        "Cursor animation timed out.",
      );
      if (
        isRecord(result) &&
        typeof result.x === "number" &&
        Number.isFinite(result.x) &&
        typeof result.y === "number" &&
        Number.isFinite(result.y)
      ) {
        this.cursorPosition = { x: result.x, y: result.y };
      }
    } catch {
      // Cosmetic only — see this method's doc comment.
    }
  }

  /** Hides the agent-cursor overlay on the current browser page right away
   * (the View menu's "Show Agent Cursor" was just unticked). Best effort and
   * deliberately outside the command queue: it never throws, is bounded by a
   * short timeout, and does nothing without a current page. The next cursor
   * move's show() makes the overlay visible again if the cursor is re-enabled. */
  async hideCursorOverlay(): Promise<void> {
    try {
      const page = this.target.currentPage();
      if (!page) return;
      await withTimeout(
        this.executeScript(page, "CURSOR_VISIBILITY_JS", { hidden: true }),
        Math.min(this.timeoutMs, 1000),
        "Cursor hide timed out.",
      );
    } catch {
      // cosmetic only
    }
  }

  /** Resolves once the DOM is ready, not once every subresource has
   * finished — `webContents.loadURL()`'s own promise resolves at
   * `did-finish-load`, which on a heavy commercial page (ads, trackers,
   * video) routinely exceeds BROWSER_COMMAND_TIMEOUT_MS even though the page
   * is perfectly usable well before that. The DOM-ready listener
   * (`page.onceDomReady()`) is armed *before* `loadURL` is called — arming
   * it after risks missing an event that fires while `loadURL` is still
   * synchronously setting up the navigation.
   *
   * Both promises are raced. If the full load settles first (fast page, or a
   * genuine navigation error before the DOM ever became ready), that result
   * is trusted outright — a rejection here is surfaced as `{ error }`, same
   * as before this fix. If DOM-ready wins, the page gets a short, bounded
   * grace period (OPEN_LOAD_GRACE_MS) to finish the full load too, so the
   * common fast page still comes back `loaded: true`; if the grace period
   * expires first, the command returns with `loaded: false` and the load
   * promise's eventual settlement (success or failure) is one that already
   * has both a resolve and a reject handler attached below, so it can never
   * become an unhandled rejection — a subresource failing after the page is
   * usable is not treated as this command failing.
   *
   * Second-pass review finding 8: this public method just serializes onto
   * the command queue (`runExclusive`) and delegates to `openUnlocked` for
   * the actual work — see `runExclusive`'s doc comment for why `tabs()`'s
   * internal "new"+url case calls `openUnlocked` directly instead of this. */
  async open(args: unknown): Promise<BrowserCommandResult> {
    return this.runExclusive(() => this.openUnlocked(args));
  }

  private async openUnlocked(args: unknown): Promise<BrowserCommandResult> {
    const validated = validateOpenArgs(args);
    if (!validated.ok) return errorResult(validated.error);
    return this.withCommandTimeout(async () => {
      const page = await this.target.ensurePage();

      // Armed before loadURL() is called — see the doc comment above.
      const domReadyPromise = page.onceDomReady();
      const loadPromise = page.loadURL(validated.url);

      type Outcome = { via: "dom-ready" } | { via: "load"; error: Error | null };
      // .then's reject handler here consumes loadPromise's rejection into a
      // resolved value — this is what keeps a late load failure from ever
      // reaching Node as an unhandled rejection, regardless of which branch
      // below is taken or how long after this function returns it settles.
      const loadOutcome: Promise<Outcome> = loadPromise.then(
        () => ({ via: "load", error: null }),
        (err: unknown) => ({ via: "load", error: err instanceof Error ? err : new Error(toMessage(err)) }),
      );
      const domReadyOutcome: Promise<Outcome> = domReadyPromise.then(() => ({ via: "dom-ready", error: null }));

      const first = await Promise.race([domReadyOutcome, loadOutcome]);

      if (first.via === "load") {
        // The full load settled before the DOM even became ready — either a
        // fast page (nothing left to wait for) or a genuine navigation
        // failure. Either way there is no "DOM ready but still loading"
        // state to report, so this is the whole answer.
        if (first.error) throw first.error;
        return { url: page.getURL(), title: page.getTitle(), loaded: true, ...(await this.checkBotWall(page)) };
      }

      const graceOutcome = await Promise.race([
        loadOutcome,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), OPEN_LOAD_GRACE_MS)),
      ]);
      // A load failure that happens *after* DOM-ready already succeeded is
      // not a command failure (e.g. a stalled subresource) — it just means
      // the full load never completed, so `loaded` stays false.
      const loaded = graceOutcome !== "timeout" && graceOutcome.via === "load" && graceOutcome.error === null;
      return { url: page.getURL(), title: page.getTitle(), loaded, ...(await this.checkBotWall(page)) };
    }, this.openTimeoutMs, this.journal ? { op: "nav" } : undefined);
  }

  /**
   * PageFixture (docs/specs/2026-10-15-page-fixture-design.md): puts the
   * browser into the state `fixture` describes, under the same exclusive lock
   * as every other command. Navigation, extra tabs and key presses reuse this
   * controller's own code (`openUnlocked`, the `tabs` "new" path,
   * `dispatchKeyPair`), so a fixture behaves like `browse_open`, `browse_tabs`
   * and `act press`. The whole run has one deadline sized for the fixture
   * (`fixtureBudgetMs`) and drains dialogs like any command. It navigates and
   * may switch tabs, so the last snapshot is dropped (a `perform` against it
   * is refused as stale). Never rejects: a failure is `{ ok: false, error }`.
   */
  async applyFixture(fixture: PageFixture, opts?: FixtureApplyOptions): Promise<FixtureApplyResult> {
    return this.runExclusive(async () => {
      // This apply owns the "in flight" mark from its first line: a `releaseFixture()` that arrives during the
      // early phase (the wait for a previous apply, the journal pre-read) must reach it too, not queue behind it.
      const applyToken = Symbol("fixture-apply");
      this.fixtureApplyInFlight = applyToken;
      let finishApply!: () => void;
      const applyDone = new Promise<void>((resolve) => { finishApply = resolve; });
      const previousInFlight = this.fixtureInFlight;
      this.fixtureInFlight = applyDone;
      let workSettled: Promise<void> | null = null;
      try {
        return await this.applyFixtureOwned(fixture, opts, previousInFlight, (settled) => { workSettled = settled; });
      } finally {
        if (this.fixtureApplyInFlight === applyToken) this.fixtureApplyInFlight = null;
        finishApply();
        // An apply the deadline abandoned may still run its work: a release keeps waiting for that (bounded).
        if (this.fixtureInFlight === applyDone) this.fixtureInFlight = workSettled;
      }
    });
  }

  private async applyFixtureOwned(
    fixture: PageFixture,
    opts: FixtureApplyOptions | undefined,
    previousInFlight: Promise<void> | null,
    onWork: (settled: Promise<void>) => void,
  ): Promise<FixtureApplyResult> {
    {
      // One generation step for the whole replacement: a `viewport` action still running must not install into the new fixture.
      this.actGeneration += 1;
      // A new fixture replaces the previous one, mocks included, even when the new one is invalid.
      // A release that fails (the old context is likely gone) is already marked released: it never fails this apply.
      await this.releaseFixtureUnlocked(undefined, previousInFlight).catch(() => {});
      const parsed = parsePageFixture(fixture);
      if (!parsed.ok) return { ok: false as const, stage: "validate" as const, error: parsed.error };
      let stage: FixtureStage = "validate";
      const journalSession = this.journal;
      const journalCommand = journalSession?.current ?? null;
      // The deadline abandons the work, not stops it: this signal stops it.
      const stop = new AbortController();
      const signal = opts?.signal ? AbortSignal.any([opts.signal, stop.signal]) : stop.signal;
      const aborted = { ok: false as const, error: "aborted" };
      // Pages this apply emulated; handed to `fixtureActive` only when the apply succeeds.
      const emulatedPages = new Set<BrowserPageHandle>();
      const hooksBase: FixtureHooks = {
        onStage: (reached) => { stage = reached; },
        // The registry holds the clear too, so the final sweep reaches it; the apply's own cleanup uses the wrapped one.
        onEmulated: (page, _emulate, clear) => {
          emulatedPages.add(page);
          return this.registerEmulationClear(page, clear);
        },
      };
      // What a nested `open` reports, as a hook result: its drained dialogs travel up
      // (the outer drain would not see them again), and a bot-check wall fails the fixture.
      const opened = (url: string, result: BrowserCommandResult): FixtureHookResult => {
        const dialogs = Array.isArray(result.dialogs) ? (result.dialogs as Record<string, unknown>[]) : undefined;
        const extra = dialogs ? { dialogs } : {};
        if ("error" in result) return { ok: false, error: String(result.error), ...extra };
        if (result.botCheck === true) return { ok: false, error: `${redactUrl(url)} shows a bot check`, ...extra };
        return { ok: true, ...extra };
      };
      const hooks: FixtureHooks = {
        ...hooksBase,
        navigate: async (url, abortSignal) => {
          if (abortSignal?.aborted) return aborted;
          return opened(url, await this.openUnlocked({ url }));
        },
        // The first half of `tabs({ action: "new", url })`: the tab is created empty. The apply emulates it,
        // then loads it through the `navigate` hook (`open`), so the emulation is there before the first load.
        newTab: async (abortSignal) => {
          if (abortSignal?.aborted) return aborted;
          const before = (await this.listPagesSafe()).find((t) => t.current)?.tabId;
          const tab = await this.target.newPage!();
          if (abortSignal?.aborted) {
            // The lock is released (or about to be): the late tab must not stay current.
            try {
              await this.target.closePage?.(tab.tabId);
              if (before !== undefined) await this.target.selectPage?.(before);
            } catch {
              // Best effort.
            }
            return aborted;
          }
          return { ok: true };
        },
        press: async (page, key) => {
          if (!page.sendCdp) return false;
          await this.dispatchKeyPair(page, key.descriptor, keyDispatchOptions(key));
          return true;
        },
        // A click or key press settles like `act` does: navigation watcher, load stop, network quiet.
        settled: async (page, action) => {
          const navWatcher = this.armNavigationWatcher(page, page.getURL());
          const networkBaseline = this.captureNetworkBaseline(page);
          try {
            const outcome = await action();
            // A failed action started nothing worth waiting for.
            if ((outcome as { ok?: unknown } | null)?.ok === false) navWatcher.dispose();
            else await this.settleAfterClick(page, navWatcher, networkBaseline);
            return outcome;
          } catch (err) {
            navWatcher.dispose();
            throw err;
          }
        },
      };
      // The pre-apply state is read INSIDE the apply's deadline, before anything changes; a `fresh` fixture ignores it.
      const preApply: PreApply = { needed: false };
      const readsPreState = journalSession !== null && journalCommand !== null && parsed.value.fresh !== true;
      try {
        const result = await this.withCommandTimeout(
          async () => {
            if (readsPreState && journalSession) {
              const before = this.target.currentPage();
              const list = before ? this.journalPreApplyOrigins(journalSession, before, parsed.value) : null;
              if (before && list) {
                preApply.needed = true;
                try {
                  preApply.state = await readBaseState(this.target, before, list, { cookieTimeoutMs: JOURNAL_READ_TIMEOUT_MS });
                } catch {
                  // Left unset: the base gets a gap.
                }
              }
            }
            const work = applyParsedFixture(this.target, parsed.value, { signal, allowNetworkMocks: opts?.allowNetworkMocks }, hooks);
            onWork(work.then(() => undefined, () => undefined));
            const applied = await work;
            if (!applied.ok || !applied.release) return applied as BrowserCommandResult;
            // Owned here, inside the work itself: a command the deadline abandoned still hands its mocks over.
            // (The apply releases them on its own when its signal aborted first.)
            const token = `fixture-${++this.fixtureSeq}`;
            this.fixtureActive = {
              release: applied.release,
              token,
              ...(parsed.value.emulate && emulatedPages.size > 0 ? { emulation: { emulate: parsed.value.emulate, pages: emulatedPages } } : {}),
            };
            const rest = { ...applied, fixtureToken: token };
            delete rest.release;
            return rest as BrowserCommandResult;
          },
          fixtureBudgetMs(parsed.value, {
            navigationMs: this.openTimeoutMs + OPEN_COMMAND_MARGIN_MS,
            settleMs: CLICK_LOAD_SETTLE_TIMEOUT_MS + NETWORK_QUIET_HARD_CAP_MS,
          }) + (readsPreState ? JOURNAL_PRE_APPLY_BUDGET_MS : 0),
        );
        if (journalSession && journalCommand) {
          await this.journalAfterApply(journalSession, journalCommand, parsed.value, result, preApply);
          // The apply made the base itself: the nested `open`s it ran must not make the settle step re-check the page.
          journalSession.skipSettle(journalCommand);
        }
        return fixtureResult<FixtureApplyResult>(result, stage);
      } finally {
        stop.abort();
        this.lastSnapshot = null;
      }
    }
  }

  /**
   * Network mocks and emulation of the last applied fixture, until `releaseFixture`. `emulation` lists
   * the pages that carry it (the main tab and the fixture's tabs; popups are not emulated).
   */
  private fixtureActive: {
    release: () => Promise<void>;
    token: string;
    emulation?: { emulate: FixtureEmulate; pages: Set<BrowserPageHandle> };
  } | null = null;
  private fixtureSeq = 0;
  /** Settles when the apply that runs now ends (and, once it was abandoned, when its work ends): what a release waits for. */
  private fixtureInFlight: Promise<void> | null = null;
  /**
   * The mark of the `applyFixture` that holds the command queue now (null: none). Set at the first line of the apply
   * and cleared only by the same apply, so an abandoned apply that ends late cannot clear the mark of a newer one.
   * While it is set, a release without a token does not queue behind the apply (it may hang until its deadline).
   */
  private fixtureApplyInFlight: symbol | null = null;

  /**
   * Removes the network mocks the last `applyFixture` installed. Idempotent.
   * Call it when the task ends (`runBrowseAgent({ fixture })` does). A new
   * `applyFixture` calls it first. An apply still running (or abandoned by its
   * deadline) is waited for (at most `FIXTURE_RELEASE_WAIT_MS`), so the mocks
   * it installs are removed too; past the bound the abandoned apply removes its
   * own mocks when it ends (its signal is aborted).
   *
   * `token` is the `fixtureToken` of an `applyFixture` result. With a token the
   * call releases only the fixture that token names, and does nothing when a
   * newer apply replaced it (a late finally of run A must not remove the mocks
   * of run B). Without a token it releases whatever is active.
   *
   * Ends with a sweep: every emulation clear the controller registered runs, so no override, init script or
   * extra header the controller installed is left on any page.
   */
  async releaseFixture(token?: string): Promise<void> {
    // One generation step per release: a `viewport` action still running (a timed-out one keeps going) must not install after it.
    if (token === undefined || this.fixtureActive?.token === token) this.actGeneration += 1;
    // An apply holds the queue (and may hang until its deadline): a release without a token must reach it, not wait behind it.
    if (token === undefined && this.fixtureApplyInFlight !== null) return this.releaseFixtureUnlocked(token);
    return this.runExclusive(() => this.releaseFixtureUnlocked(token));
  }

  /** `releaseFixture` inside the command queue (`applyFixture` already holds it). `waitFor` replaces the in-flight apply to wait for. */
  private async releaseFixtureUnlocked(token?: string, waitFor?: Promise<void> | null): Promise<void> {
    if (token !== undefined && this.fixtureActive?.token !== token) return;
    if (token === undefined) {
      const inFlight = waitFor !== undefined ? waitFor : this.fixtureInFlight;
      if (inFlight) {
        await boundedCall(() => inFlight, FIXTURE_RELEASE_WAIT_MS);
        if (this.fixtureInFlight === inFlight) this.fixtureInFlight = null;
      }
    }
    const active = this.fixtureActive;
    if (!active || (token !== undefined && active.token !== token)) {
      // No fixture to release, but a `viewport` layer may be left from a run without one.
      if (token === undefined) {
        await this.dropActLayers();
        await this.sweepEmulations();
      }
      return;
    }
    this.fixtureActive = null;
    try {
      // The layers hold the whole emulation they installed: they go first, then the fixture's own clear.
      await this.dropActLayers();
      await active.release();
    } finally {
      await this.sweepEmulations();
    }
  }

  /**
   * Checkpoint journal (docs/specs/2026-10-16-checkpoint-design.md). Off by
   * default; while it is off no command pays for it. While on, the controller
   * keeps ONE journal per tab: a base state (URL, cookies, storage), read at the
   * tab's last new document, and the successful state-changing actions since
   * (click, type, select, press) as deterministic `FixtureStep`s with a CSS
   * selector computed BEFORE the action. A new DOCUMENT resets that tab's
   * journal; it is detected by a marker planted in the page at base time (open,
   * reload, a link, a form POST and a back/forward that restores another
   * document all give a different marker; a `pushState` or hash change keeps it).
   * The journal follows the current tab; switching away and back continues that
   * tab's journal. `origins` limits the cookies and storage of the base (default:
   * the base page's origin only, so a shared profile's other logins are never
   * read; `[]` reads nothing).
   *
   * Returns the OWNER TOKEN of this journal. Starting again while a journal runs
   * REPLACES it: the old token is stale, and its owner's `captureCheckpoint(token)`
   * gets an error while its `stopJournal(token)` does nothing, so one owner can
   * never stop or read another owner's journal. `stopJournal()` and
   * `captureCheckpoint()` without a token act on whatever journal runs (hosts
   * that predate tokens).
   */
  startJournal(opts?: CheckpointJournalOptions): string {
    const token = `journal-${++this.journalSeq}`;
    this.journal = new JournalSession(opts, token);
    return token;
  }

  /**
   * Stops the journal and drops what it holds. With a `token`, only when it is
   * the running journal's token (a stale token does nothing). Returns whether a journal was stopped.
   */
  stopJournal(token?: string): boolean {
    if (!this.journal) return false;
    if (token !== undefined && token !== this.journal.token) return false;
    this.journal = null;
    return true;
  }

  /**
   * The checkpoint of the CURRENT tab as a `PageFixture`: the base URL, base
   * cookies and storage (read at the last new document, NOT now: a replayed
   * step would apply a storage change twice), the other tabs' URLs and the
   * recorded steps. For the host only: it holds cookie values, storage values
   * and typed text. `summary` and `gap` are safe for a model. Never rejects.
   * With a `token`, a journal that belongs to another owner is refused.
   */
  async captureCheckpoint(token?: string): Promise<CheckpointResult> {
    return this.runExclusive(async () => {
      const session = this.journal;
      if (!session) return { ok: false as const, error: "the journal is not running (call startJournal first)" };
      if (token !== undefined && token !== session.token) {
        return { ok: false as const, error: "the journal was restarted by another owner, so this checkpoint is not yours to take" };
      }
      const page = this.target.currentPage();
      // No command that could change the page ran on this tab yet (read-only commands read no marker), or the page moved on
      // by itself since the last one (a delayed redirect): check it now, bounded, so the base is the page as it is.
      if (page) await this.journalBounded(session, [page], (canWrite) => this.journalSync(session, page, canWrite));
      const tab = page ? session.forPage(page) : undefined;
      if (!tab || !tab.base) return { ok: false as const, error: "the journal has no page to checkpoint (no browser tab is open)" };
      try {
        const tabs = (await this.listPagesSafe()).filter((t) => !t.current).map((t) => t.url);
        return { ok: true as const, ...tab.build(tabs, this.activeEmulation()) };
      } catch (err) {
        return { ok: false as const, error: redactUrls(`capturing the checkpoint failed: ${toMessage(err)}`) };
      }
    });
  }

  private journal: JournalSession | null = null;
  private journalSeq = 0;

  /**
   * Runs a command with the journal on. A command that may change the page
   * declares it (`withCommandTimeout`'s third argument): only then does the
   * journal sync before it (inside the command's budget) and settle after it
   * (bounded by `JOURNAL_SETTLE_BUDGET_MS`). A read-only command does no marker read.
   */
  private async runJournaled<T>(fn: () => Promise<T>): Promise<T> {
    const session = this.journal;
    if (!session) return fn();
    const command = session.begin();
    let result: T | undefined;
    let error: unknown;
    let threw = false;
    try {
      result = await fn();
    } catch (err) {
      threw = true;
      error = err;
    }
    if (command.mutating) await this.journalSettle(session, command, result, threw);
    else session.end(command);
    if (threw) throw error;
    return result as T;
  }

  /**
   * Runs the journal's own page work against a budget. On a timeout the late work
   * may not write (`canWrite` turns false) and the given tabs get a gap: the journal
   * cannot be sure what the page holds. Never throws. Returns whether the budget ran out.
   */
  private async journalBounded(
    session: JournalSession,
    pages: (BrowserPageHandle | null | undefined)[],
    work: (canWrite: () => boolean) => Promise<void>,
  ): Promise<boolean> {
    let open = true;
    const outcome = await boundedCall(
      () => work(() => open && this.journal === session).then(() => undefined, () => undefined),
      JOURNAL_SETTLE_BUDGET_MS,
    );
    if (outcome.done) return false;
    open = false;
    for (const page of pages) if (page) session.forPage(page)?.addGap(CHECKPOINT_GAPS.unknownDocument);
    return true;
  }

  /**
   * Ties a tab to its journal: a tab the journal has not seen gets a fresh base
   * now; a tab whose document is not the base's resets; a tab whose document
   * cannot be checked gets a gap. Never throws. `canWrite` false: a late call
   * must not touch the journal.
   */
  private async journalSync(session: JournalSession, page: BrowserPageHandle | null, canWrite: () => boolean = () => true): Promise<void> {
    try {
      if (!page) return;
      const tab = session.forPage(page);
      if (!tab || !tab.base) {
        await this.journalReset(session, page, canWrite);
        return;
      }
      const state = await this.journalDocState(page, tab.base);
      if (!canWrite()) return;
      if (state === "new") await this.journalReset(session, page, canWrite);
      else if (state === "unknown") tab.addGap(CHECKPOINT_GAPS.unknownDocument);
    } catch {
      // The journal must never fail the command it rides on.
    }
  }

  /** The document marker of a page (planted when absent); null when the page cannot be asked. */
  private async journalReadMarker(page: BrowserPageHandle): Promise<string | null> {
    try {
      const found = await withTimeout(this.executeScript(page, "DOC_MARKER_JS", {}), JOURNAL_MARKER_TIMEOUT_MS, "the marker read timed out");
      return found.ok === true && typeof found.marker === "string" ? found.marker : null;
    } catch {
      return null;
    }
  }

  /** `new`: the page holds another document than the base's (or the base had no marker and one is plantable now). */
  private async journalDocState(page: BrowserPageHandle, base: JournalBase): Promise<"same" | "new" | "unknown"> {
    const marker = await this.journalReadMarker(page);
    if (marker === null) return "unknown";
    if (base.marker === null) return "new";
    return marker === base.marker ? "same" : "new";
  }

  /**
   * A new document: plants the marker and reads the base (URL, cookies, storage)
   * of this tab, by the same reader `captureFixture` uses. Never throws.
   */
  private async journalReset(session: JournalSession, page: BrowserPageHandle, canWrite: () => boolean = () => true): Promise<void> {
    let url = "";
    try {
      url = page.getURL();
    } catch {
      // A page that went away reads as no URL.
    }
    const marker = await this.journalReadMarker(page);
    let readFailed = marker === null;
    let cookies: FixtureCookie[] = [];
    let origins: FixtureOrigin[] = [];
    const origin = httpOrigin(url);
    if (origin) {
      try {
        const list = [...new Set((session.opts.origins ?? [origin]).map((o) => httpOrigin(o) ?? o))];
        const state = await readBaseState(this.target, page, list, { cookieTimeoutMs: JOURNAL_READ_TIMEOUT_MS });
        cookies = state.cookies;
        origins = state.origins;
        // The current page failing to answer is a gap; another tab doing so is just skipped.
        if (state.cookieError !== undefined || state.currentReadFailed) readFailed = true;
      } catch {
        readFailed = true;
      }
    }
    if (!canWrite()) return;
    session.ensure(page).reset({ marker, url, cookies, origins }, readFailed);
  }

  /**
   * After a command that may change the page, bounded by `JOURNAL_SETTLE_BUDGET_MS`.
   * On the tab the action ran on: a new document resets its journal (the action that
   * caused it is not recorded: the new page is the base); a document that cannot be
   * checked is a gap; a back/forward inside the same document is a gap; otherwise a
   * timed-out action, a failed command that staged something, or a retargeted `type`
   * is a gap, and a successful staged action is recorded. A command rejected before
   * it staged anything (argument validation) leaves no trace. Then the current tab
   * is synced (it may be another tab now, or have no base yet).
   */
  private async journalSettle(session: JournalSession, command: JournalCommand, result: unknown, threw: boolean): Promise<void> {
    const staged = command.staged;
    // Ends the command first: a late stage from it (after a timeout) is ignored from here on.
    session.end(command);
    const acted = staged?.page ?? command.actedPage;
    // A timed-out command keeps running: its overrun may still change the page, also a NEW document.
    const timeoutGap = command.timedOut && (command.expectsAction || command.history || command.successGap !== undefined);
    await this.journalBounded(session, [acted, this.target.currentPage()], async (canWrite) => {
      try {
        if (this.journal !== session) return;
        const failedResult = threw || (isRecord(result) && "error" in result);
        // A page script refused before it touched the page (no element, a disabled control, no such option): nothing changed.
        const untouched = failedResult && isRecord(result) && (result as Record<symbol, unknown>)[NO_EFFECT] === true;
        if (acted) {
          const tab = session.forPage(acted);
          if (tab && tab.base) {
            const state = await this.journalDocState(acted, tab.base);
            if (!canWrite()) return;
            if (state === "new") {
              await this.journalReset(session, acted, canWrite);
              // The new base is read now, but the overrun of a timed-out action may still mutate the new page.
              if (timeoutGap && canWrite()) session.forPage(acted)?.addGap(CHECKPOINT_GAPS.timeout);
            } else if (state === "unknown") {
              tab.addGap(CHECKPOINT_GAPS.unknownDocument);
            } else if (timeoutGap) {
              tab.addGap(CHECKPOINT_GAPS.timeout);
            } else if (command.history) {
              // The same document after a history move: a popstate inside the page. The page state changed, and no step can replay it.
              // A move the command refused (no history to go to) changed nothing.
              if (!failedResult) tab.addGap(CHECKPOINT_GAPS.history);
            } else if (command.successGap !== undefined) {
              if (!failedResult) tab.addGap(command.successGap);
            } else if (untouched) {
              // Nothing was dispatched: no step and no gap, whatever the lookup staged.
            } else if (staged) {
              const typed = "steps" in staged.action && staged.action.steps.some((s) => s.action === "type");
              if (failedResult) tab.addGap(CHECKPOINT_GAPS.failed);
              else if (typed && isRecord(result) && result.retargeted === true) tab.addGap(CHECKPOINT_GAPS.retargeted);
              else tab.record(staged.action);
            } else if (command.expectsAction) {
              // A declared action succeeded and nothing was staged: never drop a possibly-effective action silently.
              if (!failedResult) tab.addGap(CHECKPOINT_GAPS.noSelector);
            } else if (command.navUrlBefore !== undefined && !failedResult && this.pageUrl(acted) !== command.navUrlBefore) {
              // The URL changed and the document stayed (a hash-only open): no step replays it.
              tab.addGap(CHECKPOINT_GAPS.sameDocumentNav);
            }
          } else if (command.preOverrun) {
            // The sync before the action ran out and left no base: the base read now comes after the action.
            await this.journalReset(session, acted, canWrite);
            if (canWrite()) session.forPage(acted)?.addGap(CHECKPOINT_GAPS.unknownDocument);
          }
        }
        const current = this.target.currentPage();
        if (current && (current !== acted || !session.forPage(current)?.base)) await this.journalSync(session, current, canWrite);
      } catch {
        // The journal must never fail the command it rides on.
      }
    });
  }

  /** The URL of a page; undefined when it went away. */
  private pageUrl(page: BrowserPageHandle): string | undefined {
    try {
      return page.getURL();
    } catch {
      return undefined;
    }
  }

  /**
   * The origins to read BEFORE a fixture is applied: the journal's own origins
   * (default: the current page's origin) plus the fixture's (its start page and
   * storage origins). `null`: nothing to read (the host asked for no origin at all
   * with `origins: []`, or there is no http origin).
   */
  private journalPreApplyOrigins(session: JournalSession, page: BrowserPageHandle, fixture: PageFixture): string[] | null {
    const own = session.opts.origins;
    if (own && own.length === 0) return null;
    let current: string | undefined;
    try {
      current = httpOrigin(page.getURL());
    } catch {
      current = undefined;
    }
    const list = new Set<string>();
    for (const o of own ?? (current ? [current] : [])) list.add(httpOrigin(o) ?? o);
    const start = fixture.url ? httpOrigin(fixture.url) : undefined;
    if (start) list.add(start);
    for (const o of fixture.storage?.origins ?? []) list.add(httpOrigin(o.origin) ?? o.origin);
    return list.size > 0 ? [...list] : null;
  }

  /**
   * After `applyFixture` with the journal on: the fixture IS the base of the
   * current tab. A successful apply gives base URL = `fixture.url`, base steps =
   * the fixture's steps (not counted toward the cap), complete. The base storage is
   * the state read BEFORE the apply (the profile's cookies and storage, for the
   * journal's origins and the fixture's) with the fixture's storage on top (the
   * fixture wins per cookie and per key): an apply without `fresh` leaves the rest
   * of the profile in place. A `fresh` fixture ignores the earlier state, and the
   * checkpoint says `fresh: true`. `network` and `expect` are not copied (the host
   * owns them). A fixture with steps and no URL cannot be replayed from the page
   * it ended on: normal reset plus a gap. A failed apply is a normal reset on the
   * current page plus a gap (it may have run some steps).
   */
  private async journalAfterApply(session: JournalSession, command: JournalCommand, fixture: PageFixture, result: unknown, pre: PreApply): Promise<void> {
    // An abandoned apply that ends late must not touch the journal.
    if (this.journal !== session || session.current !== command) return;
    const page = this.target.currentPage();
    await this.journalBounded(session, [page], async (canWrite) => {
      try {
        if (!page) return;
        const applied = isRecord(result) && result.ok === true && !("error" in result);
        if (!applied) {
          await this.journalReset(session, page, canWrite);
          if (canWrite()) session.forPage(page)?.addGap(CHECKPOINT_GAPS.fixtureFailed);
          return;
        }
        const marker = fixture.url ? await this.journalReadMarker(page) : null;
        if (!fixture.url || marker === null) {
          await this.journalReset(session, page, canWrite);
          if (canWrite() && !fixture.url && (fixture.steps?.length ?? 0) > 0) session.forPage(page)?.addGap(CHECKPOINT_GAPS.fixtureNoUrl);
          return;
        }
        const fresh = fixture.fresh === true;
        let storage = { cookies: [...(fixture.storage?.cookies ?? [])], origins: [...(fixture.storage?.origins ?? [])] };
        let readFailed = false;
        if (!fresh) {
          const before = pre.state;
          // The pre-apply read was needed and did not come back clean: the base may lack what the profile held.
          if (pre.needed && (!before || before.cookieError !== undefined || before.currentReadFailed)) readFailed = true;
          storage = mergeStorage({ cookies: before?.cookies ?? [], origins: before?.origins ?? [] }, fixture.storage);
        }
        if (!canWrite()) return;
        session.ensure(page).reset(
          {
            marker,
            url: fixture.url,
            cookies: storage.cookies,
            origins: storage.origins,
            ...(fixture.steps ? { steps: [...fixture.steps] } : {}),
            ...(fresh ? { fresh: true } : {}),
          },
          readFailed,
        );
      } catch {
        // The journal must never fail the command it rides on.
      }
    });
  }

  /**
   * What a command that may change the page does BEFORE its own budget starts
   * (`withCommandTimeout` calls it): it declares itself to the journal, and the
   * journal syncs the tab (a new tab gets its base, a new document resets) and, for
   * an action, stages it. All of it is bounded by `JOURNAL_SETTLE_BUDGET_MS`, a share
   * of its own: a slow base read (cookies and storage of several tabs) must never make
   * an action that works with the journal off time out. On overrun the tab gets a
   * gap and the action runs with its full budget. Never throws.
   */
  private async journalPrepare(
    session: JournalSession,
    command: JournalCommand,
    declare: JournalDeclare,
    page: BrowserPageHandle | null,
  ): Promise<void> {
    if (declare.op === "nav") {
      session.declare(command, "nav", page, page ? this.pageUrl(page) : undefined);
      return;
    }
    const kind =
      declare.op === "history" ? "history" : declare.op === "hover" ? "hover" : declare.op === "upload" ? "upload" : "action";
    session.declare(command, kind, page);
    if (!page) return;
    const action = declare.op === "history" || declare.op === "hover" || declare.op === "upload" ? null : declare;
    const overrun = await this.journalBounded(session, [page], (canWrite) =>
      action ? this.journalPreAction(session, command, page, action, canWrite) : this.journalSync(session, page, canWrite),
    );
    if (overrun) session.markPreOverrun(command);
  }

  /**
   * The sync and the staging of an action in ONE page round trip. `SELECTOR_JS` computes
   * the selector of the element the action is about to act on AND reads the document
   * marker, so the check "is this still the document the base was read from" costs no
   * second call. It computes the selector BEFORE the action (a click can remove the
   * element), by the same resolution the action uses (snapshot stamp + fingerprint, or
   * text target), and stages the steps (a `waitFor` for the element, then the action).
   * A key-only press records the focused element (`activeElement`): the replayed
   * `click` does not focus, so a bare `press` would go to the body. Anything it cannot
   * record is staged as a GAP: nothing possibly effective is dropped. A stage from a
   * command that is no longer the current one, or after the budget ran out, is ignored.
   */
  private async journalPreAction(
    session: JournalSession,
    command: JournalCommand,
    page: BrowserPageHandle,
    a: JournalAction,
    canWrite: () => boolean,
  ): Promise<void> {
    if (session.current !== command) return;
    const hadBase = session.forPage(page)?.base != null;
    // A tab new to the journal gets its base now, before the action.
    if (!hadBase) {
      await this.journalReset(session, page, canWrite);
      if (!canWrite()) return;
    }
    const { index, snapshotId } = a.locate;
    // The command refuses a stale or foreign snapshot itself, before any page effect.
    const stale = snapshotId !== undefined && index !== undefined && Boolean(this.checkSnapshotStale(snapshotId, page));
    // No lookup when it cannot matter: the journal already has a gap (it records nothing more), the element is in a frame, or the command refuses.
    let lookup: JournalLookup | undefined;
    if (!stale && a.frameId === null && session.forPage(page)?.complete !== false) lookup = await this.journalLookup(page, a);
    if (!canWrite()) return;
    const tab = session.forPage(page);
    if (!tab?.base) return;
    if (lookup) {
      if (lookup.marker === null) tab.addGap(CHECKPOINT_GAPS.unknownDocument);
      // A base without a marker is re-based as soon as one can be planted.
      else if (tab.base.marker === null || lookup.marker !== tab.base.marker) await this.journalReset(session, page, canWrite);
    } else if (hadBase) {
      await this.journalSync(session, page, canWrite);
    }
    if (!canWrite() || stale) return;
    // A gap (also one the sync just made) records nothing more; a reset clears it.
    if (session.forPage(page)?.complete === false) return;
    if (a.frameId !== null) {
      session.stage(command, page, { gap: CHECKPOINT_GAPS.iframe });
      return;
    }
    // The journal had a gap that the sync cleared by a reset: the lookup is still due.
    lookup ??= await this.journalLookup(page, a);
    if (!canWrite()) return;
    session.stage(command, page, lookup.staged);
  }

  /** One `SELECTOR_JS` call (bounded): the staged action for the element and the document marker (null: it could not be read). */
  private async journalLookup(page: BrowserPageHandle, a: JournalAction): Promise<JournalLookup> {
    const keyOnly = a.op === "press" && a.locate.target === undefined && a.locate.index === undefined;
    let found: Record<string, unknown> | undefined;
    try {
      const outcome = await boundedCall(
        () => this.executeScript(page, "SELECTOR_JS", { ...a.locate, op: keyOnly ? "active" : a.op, optionText: a.optionText }),
        JOURNAL_MARKER_TIMEOUT_MS,
      );
      if (outcome.done) found = outcome.value;
    } catch {
      // Treated like a page that cannot be asked.
    }
    if (!found) return { staged: { gap: CHECKPOINT_GAPS.noSelector }, marker: null };
    const marker = typeof found.marker === "string" ? found.marker : null;
    let staged: StagedAction;
    if (found.ok === true && found.none === true && keyOnly) {
      // Nothing but the body has focus: the key goes to the page, and so does the replayed one.
      staged = { steps: [{ action: "press", key: a.key ?? "" }] };
    } else if (found.ok === true && typeof found.selector === "string") {
      const selector = found.selector;
      let step: FixtureStep;
      if (a.op === "click") step = { action: "click", selector };
      else if (a.op === "type") step = { action: "type", selector, text: a.text ?? "" };
      else if (a.op === "select") step = { action: "select", selector, value: typeof found.optionValue === "string" ? found.optionValue : "" };
      else step = { action: "press", key: a.key ?? "", selector };
      // Async content (an autocomplete list) is not there yet when the replay runs back to back.
      staged = { steps: [{ action: "waitFor", selector }, step] };
    } else if (found.reason === "iframe") {
      staged = { gap: CHECKPOINT_GAPS.iframe };
    } else if (found.reason === "option-not-unique") {
      staged = { gap: CHECKPOINT_GAPS.optionNotUnique };
    } else {
      // `not-found` too: the action may still find and act on an element this lookup missed. If it fails
      // before it touched the page, the settle step drops this gap (nothing changed).
      staged = { gap: found.reason === "unsupported" ? CHECKPOINT_GAPS.unsupported : CHECKPOINT_GAPS.noSelector };
    }
    return { staged, marker };
  }

  /** The emulation the last applied fixture left active, or undefined. */
  private activeEmulation(): FixtureEmulate | undefined {
    // The `viewport` action's layer of the current page is the emulation as it is now; else the fixture's.
    const page = this.target.currentPage();
    return (page ? this.actLayers.get(page)?.emulate : undefined) ?? this.fixtureActive?.emulation?.emulate;
  }

  private withActiveEmulation(opts?: FixtureCaptureOptions): FixtureCaptureOptions | undefined {
    const emulate = this.activeEmulation();
    return emulate ? { ...opts, emulate } : opts;
  }

  /** Reads the browser state as a `PageFixture` (host use: it holds secrets). Bounded like any command. */
  async captureFixture(opts?: FixtureCaptureOptions): Promise<FixtureCaptureResult> {
    return this.runExclusive(async () =>
      fixtureResult<FixtureCaptureResult>(await this.withCommandTimeout(async () => (await captureFixture(this.target, this.withActiveEmulation(opts))) as BrowserCommandResult)),
    );
  }

  /** Second-pass review finding 8: public entry point — serializes onto the
   * command queue and delegates to `actUnlocked`. */
  async act(args: unknown): Promise<BrowserCommandResult> {
    return this.runExclusive(async () => {
      this.relocatedThisCommand = false;
      const result = this.withRelocated(await this.actUnlocked(args));
      // Wave 3 reliability, item 3: drained once, at the outermost public
      // entry point — see mergeDiagnostics's doc comment.
      return this.mergeDiagnostics(result, this.target.currentPage());
    });
  }

  private async actUnlocked(args: unknown): Promise<BrowserCommandResult> {
    if (!isRecord(args) || !isActAction(args.action)) {
      return errorResult(
        `browse_act requires an "action" of "click", "type", "select", "press", "hover", "upload", "scroll", "back", ` +
          `"forward", "reload", "wait", or "viewport" (got ${
            isRecord(args) ? JSON.stringify(args.action) : JSON.stringify(args)
          }).`,
      );
    }
    const action = args.action;

    if (action === "reload") {
      return this.withCommandTimeout(async () => {
        const page = this.target.currentPage();
        if (!page) return errorResult("No browser tab is open — call browse_open first.");
        await this.reloadAndSettle(page);
        return { url: page.getURL(), title: page.getTitle() };
      }, undefined, this.journal ? { op: "nav" } : undefined);
    }

    if (action === "wait") {
      if (args.text !== undefined && (typeof args.text !== "string" || args.text.trim() === "")) {
        return errorResult('browse_act "wait" requires "text" to be a non-empty string when provided.');
      }
      if (args.ms !== undefined && (typeof args.ms !== "number" || !Number.isFinite(args.ms) || args.ms < 0)) {
        return errorResult('browse_act "wait" requires "ms" to be a non-negative number when provided.');
      }
      const ms = Math.min(typeof args.ms === "number" ? args.ms : WAIT_DEFAULT_MS, WAIT_MAX_MS);
      const text = typeof args.text === "string" ? args.text : undefined;
      // Own budget, not this.timeoutMs — a caller waiting up to WAIT_MAX_MS
      // (15s) must not be cut off by the default 20s command timeout minus
      // whatever else this closure does; a little headroom on top of `ms`
      // covers the poll/script round trips themselves.
      return this.withCommandTimeout(() => this.runWait(text, ms), ms + 5_000);
    }

    if (action === "press") {
      if (typeof args.key !== "string" || args.key.trim() === "") {
        return errorResult('browse_act "press" requires a non-empty string "key".');
      }
      const key = args.key;
      let focusTarget: string | undefined;
      let focusIndex: number | undefined;
      let focusSnapshotId: string | undefined;
      if (args.target !== undefined) {
        if (typeof args.target !== "string" || args.target.trim() === "") {
          return errorResult('browse_act "press" requires "target" to be a non-empty string when provided.');
        }
        focusTarget = args.target;
      }
      if (args.index !== undefined || args.snapshotId !== undefined) {
        const validated = validateIndexSnapshot(args, "press");
        if (!validated.ok) return errorResult(validated.error);
        focusIndex = validated.index;
        focusSnapshotId = validated.snapshotId;
      }
      const hasIndexTarget = focusIndex !== undefined && focusSnapshotId !== undefined;
      return this.withCommandTimeout(
        () => this.runPress(key, { target: focusTarget, index: focusIndex, snapshotId: focusSnapshotId }),
        this.timeoutMs + this.cursorBudgetMs,
        // An unparsable key is refused before any page effect: nothing to stage.
        this.journal && parseKeySpec(key)
          ? {
              op: "press",
              locate: { target: focusTarget, ...(hasIndexTarget ? { index: focusIndex, snapshotId: focusSnapshotId } : {}) },
              frameId: hasIndexTarget ? this.resolveFrameRoute(focusIndex!).frameId : null,
              key,
            }
          : undefined,
      );
    }

    if (action === "hover") {
      let hoverTarget: string | undefined;
      let hoverIndex: number | undefined;
      let hoverSnapshotId: string | undefined;
      if (typeof args.target === "string" && args.target.trim() !== "") {
        hoverTarget = args.target;
      } else if (args.index !== undefined || args.snapshotId !== undefined) {
        const validated = validateIndexSnapshot(args, "hover");
        if (!validated.ok) return errorResult(validated.error);
        hoverIndex = validated.index;
        hoverSnapshotId = validated.snapshotId;
      } else {
        return errorResult('browse_act "hover" requires a "target" string, or "index" with "snapshotId".');
      }
      return this.withCommandTimeout(
        () => this.runHover({ target: hoverTarget, index: hoverIndex, snapshotId: hoverSnapshotId }),
        this.timeoutMs + this.cursorBudgetMs,
        // A hover opens menus and tooltips: state that only the live page holds and no recorded step replays.
        this.journal ? { op: "hover" } : undefined,
      );
    }

    if (action === "upload") return this.actUpload(args);

    if (action === "viewport") return this.actViewport(args);

    if (action === "select") {
      const validated = validateIndexSnapshot(args, "select");
      if (!validated.ok) return errorResult(validated.error);
      if (typeof args.text !== "string") {
        return errorResult('browse_act "select" requires a string "text".');
      }
      // Routes to the same perform() path the jev loop uses — see the
      // design doc's table ("select | index+snapshotId, text | perform
      // SELECT"). perform() already applies the staleness/cross-tab
      // snapshotId check and produces evidence for SELECT. `performUnlocked`
      // (not the public `perform`) — see `runExclusive`'s doc comment: this
      // call is already running inside the queue, from `act`'s own turn.
      return this.performUnlocked({ operation: "SELECT", index: validated.index, snapshotId: validated.snapshotId, text: args.text });
    }

    if (action === "back" || action === "forward") {
      return this.withCommandTimeout(async () => {
        const page = this.target.currentPage();
        if (!page) return errorResult("No browser tab is open — call browse_open first.");
        if (action === "back" && !page.canGoBack()) {
          return errorResult("Cannot go back: no previous page in this tab's history.");
        }
        if (action === "forward" && !page.canGoForward()) {
          return errorResult("Cannot go forward: no next page in this tab's history.");
        }
        // goBack()/goForward() are fire-and-forget (BrowserPageHandle has no
        // navigation-complete signal) — wait for the URL to actually change
        // before reading it back, so the result reflects the page the user
        // lands on rather than a stale pre-navigation URL.
        const previousUrl = page.getURL();
        const before = await this.captureSignature(page, "before");
        if (action === "back") page.goBack();
        else page.goForward();
        await this.waitForUrlChange(page, previousUrl);
        const after = await this.captureSignature(page, "after");
        const currentUrl = page.getURL();
        return {
          url: currentUrl,
          title: page.getTitle(),
          ...this.diffSignatures(before, after, { previousUrl, currentUrl }),
        };
      }, undefined, this.journal ? { op: "history" } : undefined);
    }

    if (action === "scroll") {
      if (args.amount !== undefined && (typeof args.amount !== "number" || !Number.isFinite(args.amount))) {
        return errorResult('browse_act "scroll" requires "amount" to be a number when provided.');
      }
      const amount = typeof args.amount === "number" ? args.amount : 1;
      // Wave 2 reliability item 4: optional target/index+snapshotId scrolls
      // that element (or its nearest scrollable ancestor) instead of the
      // window — see SCROLL_JS's own doc comment for the full auto-pick
      // rule when neither is given.
      let scrollTarget: string | undefined;
      let scrollIndex: number | undefined;
      let scrollSnapshotId: string | undefined;
      if (typeof args.target === "string" && args.target.trim() !== "") {
        scrollTarget = args.target;
      } else if (args.index !== undefined || args.snapshotId !== undefined) {
        const validated = validateIndexSnapshot(args, "scroll");
        if (!validated.ok) return errorResult(validated.error);
        scrollIndex = validated.index;
        scrollSnapshotId = validated.snapshotId;
      }
      return this.withCommandTimeout(
        () =>
          this.runOnPageWithEvidence("SCROLL_JS", {
            amount,
            target: scrollTarget,
            index: scrollIndex,
            snapshotId: scrollSnapshotId,
          }),
        this.timeoutMs + this.cursorBudgetMs,
      );
    }

    // click / type — target OR index+snapshotId (design doc's table: "click
    // / type | target or index+snapshotId (+text) | index → existing
    // perform CLICK/TYPE_TEXT path"). Index-based routes straight to
    // perform(), which already carries the staleness/cross-tab check,
    // evidence, and (for CLICK) openedTab detection.
    if (args.index !== undefined || args.snapshotId !== undefined) {
      const validated = validateIndexSnapshot(args, action);
      if (!validated.ok) return errorResult(validated.error);
      if (action === "type" && typeof args.text !== "string") {
        return errorResult('browse_act "type" requires a string "text" when using "index".');
      }
      // `performUnlocked`, not the public `perform` — see `runExclusive`'s
      // doc comment.
      return this.performUnlocked({
        operation: action === "click" ? "CLICK" : "TYPE_TEXT",
        index: validated.index,
        snapshotId: validated.snapshotId,
        text: args.text,
      });
    }

    if (typeof args.target !== "string" || args.target.trim() === "") {
      return errorResult(`browse_act "${action}" requires a non-empty string "target" (or "index" with "snapshotId").`);
    }
    // Captured as a local const, not read as `args.target` again below: TS
    // narrowing of a property access does not survive into the closures
    // passed to withCommandTimeout, so `runClick`'s `target: string`
    // parameter needs an already-narrowed value.
    const target = args.target;
    if (action === "type") {
      if (typeof args.text !== "string") {
        return errorResult('browse_act "type" requires a string "text".');
      }
      const text = args.text;
      // Wave 2 reliability item 2: trusted CDP typing (dispatchType), with
      // its own DOM fallback baked in — see runTypeWithEvidence.
      return this.withCommandTimeout(
        (deadlineAt) => this.runTypeWithEvidence({ target }, text, deadlineAt),
        this.timeoutMs + this.cursorBudgetMs,
        this.journal ? { op: "type", locate: { target }, frameId: null, text } : undefined,
      );
    }
    return this.withCommandTimeout(
      (deadlineAt) => this.runClick(target, deadlineAt),
      this.timeoutMs + this.cursorBudgetMs,
      this.journal ? { op: "click", locate: { target }, frameId: null } : undefined,
    );
  }

  /** Wave 2 reliability, item 1: performs a click via trusted CDP mouse
   * events when it safely can, falling back to the existing `el.click()`
   * page-script path (CLICK_JS for a `target`, PERFORM_JS's CLICK branch for
   * an `index`+`snapshotId`) otherwise. `locateArgs` carries exactly one of
   * the two the way LOCATE_TARGET_JS's `locateTarget` already expects.
   *
   * `CLICK_RESOLVE_JS` finds and stamps the element and hit-tests its centre
   * point (`document.elementFromPoint`, recursing into open shadow roots)
   * *without acting on it* — see its own doc comment for what `hitOk` means.
   * When `hitOk` is true and this tab has a CDP session (`page.sendCdp`), a
   * `mouseMoved`/`mousePressed`/`mouseReleased` triple lands a real,
   * OS-trusted click (`event.isTrusted === true` on the page, unlike a
   * page-script `el.click()`) at that point, and the busy state of the
   * stamped element is re-read (`TARGET_BUSY_JS`) to compute
   * `__targetSelfDisabled` the same way the DOM path does inline. Reports
   * `via: "cdp"`.
   *
   * Any other outcome — the hit-test failed (covered, zero-size, offscreen
   * after scroll), no CDP session, or the trusted dispatch itself threw —
   * falls back to the pre-existing DOM click entirely (a fresh resolve, not
   * a reuse of CLICK_RESOLVE_JS's own stamp), reporting `via: "dom"`. `via`
   * is deliberately optional on the result (not every caller needs it) but
   * always present here — see CLAUDE.md's "Trusted input" section. */
  /** Wave 3 reliability, item 2: the frame-routed counterpart of
   * `dispatchClick`/`dispatchType` — runs `PERFORM_JS`'s CLICK/TYPE_TEXT
   * branch directly inside the given child frame via `executeScriptInFrame`,
   * skipping the trusted-CDP path entirely (see the call sites' doc
   * comments for why that skip is the design's own sanctioned fallback, not
   * a shortcut). Reports `via: "dom"` on success, matching the shape both
   * `dispatchClick`/`dispatchType`'s own DOM-fallback branches already
   * report, so a caller can't tell "top-level DOM fallback" from
   * "frame-routed" from `via` alone — that distinction is exactly what the
   * result's `frame` field (set by takeSnapshot/mergeFrameEntries) is for. */
  private async frameClickOrType(
    page: BrowserPageHandle,
    frameId: number,
    operation: "CLICK" | "TYPE_TEXT",
    localIndex: number,
    snapshotId: string,
    deadlineAt: number,
    text?: string,
  ): Promise<BrowserCommandResult> {
    const result = await this.executeScriptInFrame(page, frameId, "PERFORM_JS", {
      snapshotId,
      index: localIndex,
      operation,
      text,
    });
    if ("error" in result) return result;
    // A role=slider comes back prepared (focused, target parsed) but not yet
    // moved: the trusted key presses go to whichever frame holds focus.
    if (operation === "TYPE_TEXT") return this.completeSliderResult(page, frameId, { ...result, via: "dom" }, deadlineAt);
    return { ...result, via: "dom" };
  }

  /** Scrolls the click/type target into view (REVEAL_TARGET_JS) BEFORE the
   * caller's before-signature capture — see that script's doc comment and
   * runHover's finding 8. Best-effort: a failure here is never an error (the
   * action script reports a genuinely missing target itself). */
  private async revealTarget(
    page: BrowserPageHandle,
    locateArgs: { target?: string; index?: number; snapshotId?: string },
    operation: "CLICK" | "TYPE_TEXT",
    deadlineAt?: number,
  ): Promise<{ dismissDialog: boolean; error?: string }> {
    // A natively disabled target is refused by REVEAL_TARGET_JS itself,
    // before any scroll/stamp. A merely BUSY one (a handler disabling it for
    // a moment) gets a short chance to re-enable first: re-run the reveal
    // every BUSY_POLL_INTERVAL_MS up to DISABLED_WAIT_MS (and the command
    // deadline minus SETTLE_HEADROOM_MS), same cadence as settleWhileTargetBusy.
    const budget = Math.min(
      DISABLED_WAIT_MS,
      deadlineAt === undefined ? this.timeoutMs : deadlineAt - SETTLE_HEADROOM_MS - Date.now(),
    );
    const until = Date.now() + Math.max(0, budget);
    while (true) {
      try {
        const revealed = await this.executeScript(page, "REVEAL_TARGET_JS", { ...locateArgs, operation });
        if (revealed.disabled !== true) return { dismissDialog: revealed.dismissDialog === true };
        if (Date.now() + BUSY_POLL_INTERVAL_MS >= until) {
          return { dismissDialog: false, error: typeof revealed.error === "string" ? revealed.error : "the control is disabled" };
        }
      } catch {
        // Best-effort.
        return { dismissDialog: false };
      }
      await new Promise((resolve) => setTimeout(resolve, BUSY_POLL_INTERVAL_MS));
    }
  }

  /** Waits for the dialog a dismissing click (REVEAL_TARGET_JS's
   * `dismissDialog`) is closing — see DIALOG_DISMISS_SETTLE_MS. Probes at
   * once (an already-closed dialog costs one probe), then every
   * DIALOG_DISMISS_POLL_MS. Best-effort: a throwing/malformed probe, the cap
   * or the command deadline just ends the wait. Returns true only when the
   * probe saw the dialog closed — the caller then reports that as the click's
   * effect (the dismissed button's own signature rarely moves once hidden). */
  private async settleDialogDismiss(page: BrowserPageHandle, deadlineAt: number): Promise<boolean> {
    const until = Math.min(Date.now() + DIALOG_DISMISS_SETTLE_MS, deadlineAt - SETTLE_HEADROOM_MS);
    if (Date.now() >= until) return false;
    while (true) {
      try {
        const state = await this.executeScript(page, "DISMISS_DIALOG_STATE_JS", {});
        if ("error" in state) return false;
        if (state.closed !== false) return state.closed === true;
      } catch {
        return false;
      }
      if (Date.now() + DIALOG_DISMISS_POLL_MS >= until) return false;
      await new Promise((resolve) => setTimeout(resolve, DIALOG_DISMISS_POLL_MS));
    }
  }

  /** The click's after-capture + diff, with the late-effect re-check (see
   * LATE_CLICK_EFFECT_MS). The first capture is a `keep` peek whenever the
   * click stayed on the same URL, so SIGNATURE_JS's MutationObserver keeps
   * accumulating dom/text evidence across re-checks; the last capture (the
   * one that found a change, or the final poll at the cap) is non-`keep`
   * and tears it down. `dialogClosed` (settleDialogDismiss saw the dismissed
   * dialog go away) is itself the effect: the capture is then final, and a
   * diff that found nothing else is reported `changed` with a "dialog" entry. A click that already changed something, or navigated,
   * returns after the single capture it always did — and leaves the observer
   * running only until the next "before" capture replaces it. `hasOtherEffect`
   * (an opened tab) is consulted before each re-poll, so a click that
   * already opened a tab never starts the late loop. */
  private async captureClickEffect(
    page: BrowserPageHandle,
    before: PageSignature | null,
    previousUrl: string,
    scopedBefore: ScopedSignature | null,
    deadlineAt: number,
    dialogClosed = false,
    hasOtherEffect?: () => Promise<boolean>,
  ): Promise<EffectEvidence> {
    const until = Math.min(Date.now() + LATE_CLICK_EFFECT_MS, deadlineAt - SETTLE_HEADROOM_MS);
    while (true) {
      const currentUrl = page.getURL();
      const keep = !dialogClosed && currentUrl === previousUrl && Date.now() + LATE_CLICK_POLL_MS < until;
      const after = await this.captureSignature(page, "after", keep);
      const evidence = this.diffSignatures(before, after, { previousUrl, currentUrl: page.getURL(), scopedBefore });
      if (dialogClosed && !evidence.changed) return { ...evidence, changed: true, changes: [...evidence.changes, "dialog"] };
      // No "before" (or "after") evidence to re-compare against: nothing a
      // re-check could add.
      // Anything the browse_task loop already counts as an effect ends the
      // re-check too: `pageChanged` (a separate element updated), or an
      // opened tab (`hasOtherEffect`, only asked when about to poll).
      if (evidence.changed || evidence.pageChanged === true || !keep || !before || !after) return evidence;
      if (hasOtherEffect && (await hasOtherEffect())) return evidence;
      await new Promise((resolve) => setTimeout(resolve, LATE_CLICK_POLL_MS));
    }
  }

  private async dispatchClick(
    page: BrowserPageHandle,
    locateArgs: { target?: string; index?: number; snapshotId?: string },
  ): Promise<BrowserCommandResult> {
    const located = await this.executeScript(page, "CLICK_RESOLVE_JS", locateArgs);
    if ("error" in located) return located;
    const scopedBefore = extractScopedBefore(located);
    const busyBefore = extractBusyBefore(located);

    if (located.hitOk === true && page.sendCdp) {
      const x = located.x as number;
      const y = located.y as number;
      // Code review finding 8: whether `Input.dispatchMouseEvent`'s
      // "mousePressed" was actually issued — set true right before that
      // call, not after it resolves, since a rejecting `sendCdp` promise
      // doesn't prove the underlying mouse-down was never delivered to the
      // page. Once it's true, a failure must NOT fall through to the DOM
      // `el.click()` path below: that would risk a genuine, physically
      // dispatched mouse-down (or a full press+release that just failed to
      // report success) PLUS a synthetic click landing on the same target —
      // a double click. A failure before mousePressed was ever attempted
      // (only "mouseMoved" ran) carries no such risk, so that case still
      // falls through exactly as before.
      let mousePressedSent = false;
      try {
        await page.sendCdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
        mousePressedSent = true;
        await page.sendCdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await page.sendCdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        let busyAfter = busyBefore;
        try {
          const busyResult = await this.executeScript(page, "TARGET_BUSY_JS", {});
          busyAfter = busyResult.present === true && busyResult.busy === true;
        } catch {
          // Best-effort — see TARGET_BUSY_JS's own polling use elsewhere.
        }
        return {
          url: page.getURL(),
          title: page.getTitle(),
          matched: located.matched,
          via: "cdp",
          __scopedBefore: scopedBefore,
          __targetSelfDisabled: !busyBefore && busyAfter,
        };
      } catch (err) {
        if (mousePressedSent) {
          return errorResult(
            `Trusted click failed after the mouse-down was dispatched — refusing to fall back to a DOM click (possible double click): ${toMessage(err)}`,
          );
        }
        // Fall through to the DOM path below — a trusted dispatch that
        // failed before any mouse-down was sent (e.g. the debugger session
        // dropped mid-command) must not turn a click that would otherwise
        // have worked via el.click() into a hard failure.
      }
    }

    // DOM fallback — re-resolves independently (CLICK_JS/PERFORM_JS already
    // do their own find+stamp+scopedBefore) rather than reusing the state
    // captured above, keeping this path identical to pre-Wave-2 behavior.
    if (locateArgs.target !== undefined) {
      const domResult = await this.executeScript(page, "CLICK_JS", { target: locateArgs.target });
      if ("error" in domResult) return domResult;
      return { ...domResult, via: "dom" };
    }
    const domResult = await this.executeScript(page, "PERFORM_JS", {
      snapshotId: locateArgs.snapshotId,
      index: locateArgs.index,
      operation: "CLICK",
    });
    if ("error" in domResult) return domResult;
    return { ...domResult, via: "dom" };
  }

  /** Wave 2 reliability, item 2: types via trusted CDP input when it safely
   * can, falling back to the existing native-setter + input/change path
   * (TYPE_JS/PERFORM_JS's TYPE_TEXT branch) otherwise — mirrors
   * `dispatchClick`'s structure and reasoning.
   *
   * Typing follows the focus the click moved: when the trusted click opens
   * an overlay and focuses a *different* editable, SELECT_ALL_CONTENT_JS
   * (`followFocus`) and READ_TARGET_VALUE_JS re-stamp that field as the
   * target instead of pulling focus back; the result then carries
   * `retargeted: true` (still `via: "cdp"`, no legacy fallback).
   *
   * Focus is attempted two ways in sequence, not either/or: a trusted CDP
   * click at the resolved point (when the hit-test passed and a CDP session
   * exists) *and then* `SELECT_ALL_CONTENT_JS`'s own `el.focus()` — the CDP
   * click can land on a non-focusable wrapper that merely delegates focus on
   * `click`, so the explicit `el.focus()` call is what actually guarantees
   * the target field itself ends up focused before typing. Existing content
   * is then selected (native `el.select()`/`setSelectionRange`, or a DOM
   * Range for `contenteditable`) so the inserted text *replaces* it, the way
   * a real keyboard-driven fill would.
   *
   * The actual typing is one `keyDown`+`keyUp` pair for the first character
   * — carrying no `text`, so it fires `keydown`/`keyup` listeners without
   * itself inserting anything — followed by a single `Input.insertText` for
   * the *entire* string, which fires `beforeinput`/`input` the same way a
   * real paste/IME commit would (React-compatible, unlike a raw `.value =`
   * assignment). Sending one `dispatchKeyEvent` pair per character (matching
   * a real keystroke-by-keystroke type) was considered and rejected here as
   * too slow for anything but a short string — see the shared contract doc.
   *
   * The result is verified (`READ_TARGET_VALUE_JS`, comparing on the page,
   * never returning the raw value itself) before being trusted: a
   * masked/formatted input that rejects or rewrites what was inserted falls
   * back to the legacy path rather than reporting a false success. Never
   * types into anything `SELECT_ALL_CONTENT_JS` doesn't itself recognize as
   * editable — this file's existing password-field/value-privacy rules
   * (SNAPSHOT_JS's addendum D, SCOPED_SIGNATURE_JS's `valueLength`) are
   * untouched by this path: it never reads or reports a field's content,
   * only a boolean match. */
  private async dispatchType(
    page: BrowserPageHandle,
    locateArgs: { target?: string; index?: number; snapshotId?: string },
    text: string,
    deadlineAt: number,
    baseline?: AutocompleteBaseline,
  ): Promise<BrowserCommandResult> {
    if (!page.sendCdp) {
      return this.legacyTypeFallback(page, locateArgs, text, deadlineAt, baseline);
    }
    const located = await this.executeScript(page, "CLICK_RESOLVE_JS", { ...locateArgs, operation: "TYPE_TEXT" });
    if ("error" in located) return located;

    // Code review finding 4: check editability BEFORE any trusted click —
    // a trusted CDP click was previously sent to "focus" the target first,
    // so typing into a text match that was actually a link/button clicked
    // it. `located.editable` (CLICK_RESOLVE_JS) is a read-only check with no
    // side effect, so it's safe to consult ahead of any click; a
    // non-editable target goes straight to the legacy path, which reports
    // the same "not a text field" style error TYPE_JS/PERFORM_JS always
    // have, without ever touching the mouse.
    if (located.editable !== true) {
      return this.legacyTypeFallback(page, locateArgs, text, deadlineAt, baseline);
    }

    let scopedBefore = extractScopedBefore(located);
    const busyBefore = extractBusyBefore(located);

    // "Typing follows the focus the click moved": only a click that really
    // landed can have moved focus (e.g. opened an overlay with its own
    // input), so only then may SELECT_ALL_CONTENT_JS / the verify adopt a
    // different focused field. Without a trusted click behaviour is unchanged.
    let clickDispatched = false;
    if (located.hitOk === true) {
      try {
        const x = located.x as number;
        const y = located.y as number;
        await page.sendCdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
        await page.sendCdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await page.sendCdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        clickDispatched = true;
      } catch {
        // Fall through — SELECT_ALL_CONTENT_JS's own el.focus() below is
        // still attempted even if the trusted click itself failed.
      }
    }

    let selectResult: BrowserCommandResult;
    try {
      selectResult = await this.executeScript(page, "SELECT_ALL_CONTENT_JS", { followFocus: clickDispatched });
    } catch (err) {
      return errorResult(`Failed to focus target before typing: ${toMessage(err)}`);
    }
    if ("error" in selectResult) return selectResult;
    // The click opened a different field and focus is there: the stamp moved
    // with it, so the change is measured against THAT field's own
    // before-signature (the original's is meaningless for the diff).
    let retargeted = selectResult.retargeted === true;
    const retargetedBefore = extractScopedBefore(selectResult);
    if (retargeted && retargetedBefore) scopedBefore = retargetedBefore;
    if (selectResult.editable !== true) {
      return this.legacyTypeFallback(page, locateArgs, text, deadlineAt, baseline);
    }

    // Focus has settled (a focus-time suggestion list is on screen by now):
    // the last moment to record what was visible before the text goes in.
    await baseline?.take();
    try {
      if (text.length > 0) {
        const firstKey = resolveNamedKey(text[0]);
        if (firstKey) await this.dispatchKeyPair(page, firstKey);
      }
      await page.sendCdp("Input.insertText", { text });
    } catch {
      return this.legacyTypeFallback(page, locateArgs, text, deadlineAt, baseline);
    }

    let verify: BrowserCommandResult;
    try {
      verify = await this.executeScript(page, "READ_TARGET_VALUE_JS", { text });
    } catch {
      return this.legacyTypeFallback(page, locateArgs, text, deadlineAt, baseline);
    }
    if ("error" in verify || verify.matches !== true) {
      return this.legacyTypeFallback(page, locateArgs, text, deadlineAt, baseline);
    }
    // Focus moved AFTER the select step (slow overlay): the text landed in
    // the new field and the verify adopted it — same outcome, no legacy
    // fallback (which would write into the original covered field too).
    if (verify.retargeted === true) {
      retargeted = true;
      const verifyBefore = extractScopedBefore(verify);
      if (verifyBefore) scopedBefore = verifyBefore;
    }

    let busyAfter = busyBefore;
    try {
      const busyResult = await this.executeScript(page, "TARGET_BUSY_JS", {});
      busyAfter = busyResult.present === true && busyResult.busy === true;
    } catch {
      // Best-effort — see TARGET_BUSY_JS's own polling use elsewhere.
    }

    return {
      url: page.getURL(),
      title: page.getTitle(),
      matched: located.matched,
      via: "cdp",
      ...(retargeted ? { retargeted: true } : {}),
      __scopedBefore: scopedBefore,
      __targetSelfDisabled: !busyBefore && busyAfter,
    };
  }

  /** `dispatchType`'s fallback — the pre-Wave-2 native-setter + input/change
   * path, re-resolving independently (TYPE_JS/PERFORM_JS already do their
   * own find+stamp+scopedBefore) rather than reusing whatever
   * `dispatchType`'s trusted attempt already captured. */
  private async legacyTypeFallback(
    page: BrowserPageHandle,
    locateArgs: { target?: string; index?: number; snapshotId?: string },
    text: string,
    deadlineAt: number,
    baseline?: AutocompleteBaseline,
  ): Promise<BrowserCommandResult> {
    await baseline?.take();
    if (locateArgs.target !== undefined) {
      const domResult = await this.executeScript(page, "TYPE_JS", { target: locateArgs.target, text });
      if ("error" in domResult) return domResult;
      return this.completeSliderResult(page, null, { ...domResult, via: "dom" }, deadlineAt);
    }
    const domResult = await this.executeScript(page, "PERFORM_JS", {
      snapshotId: locateArgs.snapshotId,
      index: locateArgs.index,
      operation: "TYPE_TEXT",
      text,
    });
    if ("error" in domResult) return domResult;
    return this.completeSliderResult(page, null, { ...domResult, via: "dom" }, deadlineAt);
  }

  /** TYPE_JS/PERFORM_JS answer a role=slider target with `__slider`
   * ({ min, max, target }) instead of typing: the element is focused and the
   * number parsed, but a custom slider keeps its value in its own state, so
   * nothing a page script could set would stick. This finishes the job with
   * trusted key presses (`driveSlider`) and folds the outcome into the
   * result. A result without `__slider` (every other target) passes through
   * untouched.
   *
   * A drive that fails AFTER moving the slider still carries evidence: the
   * error plus url/title and the target's own before-signature
   * (`__scopedBefore`) with `__sliderPartial`, which the two callers that
   * compute `{ changed, changes }` (perform TYPE_TEXT, act type) treat as
   * "diff it anyway". The agent then learns the value moved
   * (`slider stopped at 300 (target 900)` + changed: true) instead of
   * retrying blind. */
  private async completeSliderResult(
    page: BrowserPageHandle,
    frameId: number | null,
    result: BrowserCommandResult,
    deadlineAt: number,
  ): Promise<BrowserCommandResult> {
    const raw = result.__slider;
    delete result.__slider;
    if ("error" in result || raw === undefined) return result;
    const bound = (v: unknown): number | null | undefined => (v === null || typeof v === "number" ? v : undefined);
    const min = isRecord(raw) ? bound(raw.min) : undefined;
    const max = isRecord(raw) ? bound(raw.max) : undefined;
    if (!isRecord(raw) || min === undefined || max === undefined || typeof raw.target !== "number") {
      return errorResult("Unexpected slider description from the page script.");
    }
    // The command's own absolute deadline (captured when it started), not a
    // fresh budget from here: the cursor move, snapshots and page scripts
    // before this point have already spent part of it.
    const margin = Math.min(SLIDER_TIME_MARGIN_MS, this.timeoutMs / 4);
    const deadline = deadlineAt - margin;
    const requested = typeof raw.requested === "number" ? raw.requested : raw.target;
    const outcome = await this.driveSlider(page, frameId, { min, max, target: raw.target }, deadline);
    // Clamping is honest too: a request beyond a bound by more than 5% of
    // the range (any excess when only one bound is known) did NOT get set to
    // the number asked for, though the drive to the bound itself succeeded.
    if ("value" in outcome && requested !== raw.target) {
      const fivePercent = min !== null && max !== null && max >= min ? (max - min) * 0.05 + 1e-9 : 0;
      if (Math.abs(requested - raw.target) > fivePercent) {
        const dir = requested > raw.target ? "above" : "below";
        return {
          error: `slider can't go ${dir} ${raw.target} (target ${requested}) \u2014 it is now at ${outcome.value}`,
          url: page.getURL(),
          title: page.getTitle(),
          __scopedBefore: result.__scopedBefore,
          __sliderPartial: true,
        };
      }
    }
    if ("error" in outcome) {
      if (!outcome.moved) return errorResult(outcome.error);
      return {
        error: outcome.error,
        url: page.getURL(),
        title: page.getTitle(),
        __scopedBefore: result.__scopedBefore,
        __sliderPartial: true,
      };
    }
    return { ...result, via: "cdp", sliderValue: outcome.value };
  }

  /** One trusted key press (`rawKeyDown` + `keyUp` via
   * `Input.dispatchKeyEvent`), shared by typing's first key, `press` and the
   * slider loop. `text` makes the down event a `keyDown` that also inserts
   * it; `modifiers`/`commands` are `press`'s modifier bitmask and editing
   * command. Throws if the tab has no CDP session or a dispatch rejects. */
  private async dispatchKeyPair(
    page: BrowserPageHandle,
    key: { key: string; code: string; windowsVirtualKeyCode: number },
    opts?: { modifiers?: number; text?: string; commands?: string[] },
  ): Promise<void> {
    await dispatchKeyPairShared(page, key, opts);
  }

  /** Moves a focused ARIA slider to `target` with trusted CDP key presses
   * (the WAI-ARIA slider keyboard contract). Trusted, not synthesized: many
   * widgets read `keyCode`/`which`, which a constructed KeyboardEvent leaves
   * at 0, and ignore attribute writes entirely.
   *
   * ARIA has no step attribute, so the step is learned and kept current:
   * two single arrow presses (the first can be a partial step off an
   * off-grid start, 137 -> 140), and after EVERY batch the step is
   * re-estimated as |moved| / presses. The remaining distance goes out as
   * round(|distance| / step) arrow presses, so an overshoot is corrected by
   * the next batch with the fresh estimate; three batches in a row that get
   * no closer stop the loop (no oscillation). It succeeds within half an
   * arrow step of the target, inclusive (a target exactly between two grid
   * points is as close as the widget can get, and pressing again would only
   * swing back).
   *
   * A long distance (> 20 arrow steps) first tries Home/End when a KNOWN
   * bound is much closer than the current value (an unstated aria-valuemin/
   * max is unknown, never a default), then PageUp/PageDown once to measure
   * their step: if it beats the arrow step, whole pages (floored, never
   * overshooting) do the bulk and arrows finish.
   *
   * A key the widget does not handle falls through to the browser, which
   * scrolls the page. SLIDER_SCROLL_JS guards against it: a window keydown
   * listener cancels the default of any such key the widget left un-prevented,
   * and the scroll position saved once at the start is restored (instantly,
   * only if it moved) after every batch, for widgets that swallow the key
   * without preventing it.
   *
   * Direction keys are learned too (ArrowRight/Left, else ArrowUp/Down; a
   * value moving against the intent swaps them, e.g. RTL). Every read also
   * checks the slider still holds keyboard focus (SLIDER_READ_JS). Document
   * focus is not required, since Chromium reports none whenever the window
   * is not OS-focused although CDP keys still arrive: a press that lands
   * elsewhere shows up as an unchanged value, which stops the drive.
   *
   * Bounded by SLIDER_MAX_PRESSES and `deadline` (the command's own absolute
   * deadline minus a margin), checked before EVERY press: `withCommandTimeout`
   * abandons but never cancels the work, so an abandoned loop must be unable
   * to keep pressing keys into the page after the caller was told it timed
   * out. Once any key was sent the slider may have moved, so every failure
   * after that reports `moved` and keeps its evidence. */
  private async driveSlider(
    page: BrowserPageHandle,
    frameId: number | null,
    slider: { min: number | null; max: number | null; target: number },
    deadline: number,
  ): Promise<{ value: number } | { error: string; moved: boolean }> {
    if (!page.sendCdp) {
      return {
        error: "Setting a slider requires a CDP session (trusted key input), which is unavailable for this browser tab.",
        moved: false,
      };
    }
    const { min, max, target } = slider;
    let presses = 0;
    let now = NaN;
    /** Every value read so far: the reachable set as far as we know it. */
    const seen: number[] = [];
    // Success is 'as close as a normal step grid gets': half a step, but never
    // more than 5% of the range. A jump of 25 on a 0-100 slider whose only
    // stops are 0/26/37/100 is not 'within half a step' (delta 63) — it is a
    // different number, and reporting it as done made the agent tell the
    // user the slider shows 75. A reversed or half-known range gives no cap.
    const range = min !== null && max !== null && max >= min ? max - min : null;
    const cap = range !== null ? range * 0.05 + 1e-9 : Infinity;
    const tolerance = (step: number) => Math.min(step / 2, cap);
    const fail = (error: string) => ({ error, moved: presses > 0 });
    const stopped = () =>
      fail(
        `slider stopped at ${now} (target ${target})` +
          (presses >= SLIDER_MAX_PRESSES ? " after the press limit" : Date.now() > deadline ? " at the time limit" : ""),
      );

    const script = (name: "SLIDER_READ_JS" | "SLIDER_SCROLL_JS", args: Record<string, unknown>) =>
      frameId === null ? this.executeScript(page, name, args) : this.executeScriptInFrame(page, frameId, name, args);
    const read = async (): Promise<void> => {
      const r = await script("SLIDER_READ_JS", {});
      if ("error" in r) throw new Error(String(r.error));
      if (r.present !== true) throw new Error("The slider disappeared from the page.");
      if (r.focused !== true) throw new Error("Could not focus the slider, so key presses would not reach it.");
      if (typeof r.now !== "number") throw new Error("The slider no longer reports a numeric aria-valuenow.");
      now = r.now;
      seen.push(now);
    };
    /** Presses `name` up to `times` times, stopping early at the press cap
     * or the deadline; returns how many were actually sent. */
    const press = async (name: string, times: number): Promise<number> => {
      const key = resolveNamedKey(name);
      if (!key) throw new Error(`Unsupported key: ${name}`);
      let sent = 0;
      while (sent < times && presses < SLIDER_MAX_PRESSES && Date.now() <= deadline) {
        await this.dispatchKeyPair(page, key);
        presses++;
        sent++;
      }
      return sent;
    };
    /** One batch's read-back: reads aria-valuenow, then puts back any scroll
     * a key the widget swallowed without preventing still caused. */
    const settle = async (): Promise<void> => {
      await read();
      await script("SLIDER_SCROLL_JS", { op: "restore" });
    };
    /** One press + read. True when aria-valuenow changed. */
    const probe = async (name: string): Promise<boolean> => {
      const before = now;
      await press(name, 1);
      await settle();
      return now !== before;
    };
    let guarded = false;
    try {
      await read();
      if (now === target) return { value: now };
      // Unhandled keys must not scroll the page (see SLIDER_SCROLL_JS): the
      // guard stops the default action, and the scroll position saved once
      // here is restored after every batch for widgets that swallow keys
      // without preventing them.
      await script("SLIDER_SCROLL_JS", { op: "guard" });
      guarded = true;
      await script("SLIDER_SCROLL_JS", { op: "save" });

      let boundTried = false;
      const boundKey = target <= (min ?? -Infinity) ? "Home" : target >= (max ?? Infinity) ? "End" : null;
      if (boundKey) {
        // Home/End land exactly on a bound, whatever the step. A widget that
        // ignores them leaves the value alone and the arrows take over.
        boundTried = true;
        await probe(boundKey);
        if (now === target) return { value: now };
      }

      // Learn the direction keys and the arrow step.
      let inc = "ArrowRight";
      let dec = "ArrowLeft";
      let delta = 0;
      for (const pair of [
        ["ArrowRight", "ArrowLeft"],
        ["ArrowUp", "ArrowDown"],
      ]) {
        const wantUp = target > now;
        const before = now;
        if (await probe(wantUp ? pair[0] : pair[1])) {
          delta = Math.abs(now - before);
          [inc, dec] = now > before === wantUp ? pair : [pair[1], pair[0]];
          break;
        }
        if (presses >= SLIDER_MAX_PRESSES || Date.now() > deadline) break;
      }
      if (delta === 0) return stopped();
      if (Math.abs(target - now) >= delta) {
        // A second press: the first may have been a partial step from an
        // off-grid start, the second is a whole one.
        const before = now;
        await press(target > now ? inc : dec, 1);
        await settle();
        if (now !== before) delta = Math.abs(now - before);
      }

      /** The loop cannot get closer by pressing more (within half a step yet
       * outside tolerance, or swinging without progress). In order:
       * 1. once, an off-grid start (a widget that does not snap): realign
       *    from the known bound nearest the target (Home/End, then whole
       *    steps) and re-evaluate;
       * 2. if the target is BRACKETED — values seen on both sides of it, one
       *    step apart, neither within tolerance — it genuinely sits between
       *    two stops: press once toward the nearer, re-check tolerance, and
       *    report 'nearest reachable' honestly;
       * 3. anything else keeps the plain 'slider stopped at X' wording: that
       *    is not evidence that the target is unreachable. */
      //
      // A stall (fromStall) skips the realignment: on a non-linear scale the
      // local step estimate would land Home/End + n steps far from where the
      // loop already got, so it stops where it stalled instead.
      let realigned = false;
      const conclude = async (fromStall = false): Promise<{ value: number } | { error: string; moved: boolean }> => {
        if (!realigned && !fromStall) {
          realigned = true;
          const toMin = min === null ? Infinity : Math.abs(target - min);
          const toMax = max === null ? Infinity : Math.abs(max - target);
          if (toMin !== Infinity || toMax !== Infinity) {
            const home = toMin <= toMax;
            const bound = (home ? min : max) as number;
            await probe(home ? "Home" : "End");
            if (Math.abs(now - bound) <= tolerance(delta)) {
              const n = Math.round(Math.abs(target - bound) / delta);
              if (n > 0) {
                await press(home ? inc : dec, n);
                await settle();
              }
              if (Math.abs(target - now) <= tolerance(delta)) return { value: now };
            }
          }
        }
        const tol = tolerance(delta);
        const lo = Math.max(-Infinity, ...seen.filter((v) => v < target));
        const hi = Math.min(Infinity, ...seen.filter((v) => v > target));
        const bracketed =
          Number.isFinite(lo) && Number.isFinite(hi) && target - lo > tol && hi - target > tol && hi - lo <= delta * 1.5;
        if (!bracketed) return stopped();
        const nearest = target - lo <= hi - target ? lo : hi;
        // One press only moves between neighbours when the slider sits on one
        // of the two bracketing stops; after an off-grid realignment it may sit
        // elsewhere, and a press from there is a guess that can move it away.
        if (now !== lo && now !== hi) return stopped();
        if (nearest !== now) {
          await press(nearest > now ? inc : dec, 1);
          await settle();
          if (Math.abs(target - now) <= tol) return { value: now };
        }
        return fail(`slider can't be set to exactly ${target}; nearest reachable value is ${nearest} \u2014 it is now at ${now}`);
      };

      let pageDelta: number | undefined; // undefined = untried, 0 = no use
      let pageInc = "PageUp";
      let pageDec = "PageDown";
      let bestError = Math.abs(target - now);
      let stalls = 0;
      for (;;) {
        const remaining = target - now;
        const distance = Math.abs(remaining);
        if (distance <= tolerance(delta)) return { value: now };
        // Closer than one step could get, yet not close: no press helps.
        if (distance <= delta / 2) return await conclude();
        if (presses >= SLIDER_MAX_PRESSES || Date.now() > deadline) return stopped();
        const up = remaining > 0;

        let key = up ? inc : dec;
        let count = Math.max(1, Math.round(distance / delta));
        let isPage = false;
        if (distance / delta > 20) {
          if (!boundTried) {
            boundTried = true;
            const toMin = min === null ? Infinity : Math.abs(target - min);
            const toMax = max === null ? Infinity : Math.abs(max - target);
            if (Math.min(toMin, toMax) < distance / 2) {
              await probe(toMin <= toMax ? "Home" : "End");
              continue;
            }
          }
          if (pageDelta === undefined) {
            // Probe once: does a page key move it, which way, how far?
            const before = now;
            if (await probe(up ? pageInc : pageDec)) {
              pageDelta = Math.abs(now - before);
              if (now > before !== up) [pageInc, pageDec] = [pageDec, pageInc];
            } else {
              pageDelta = 0; // ignored: never used again this drive
            }
            continue;
          }
          if (pageDelta > delta * 1.5 && Math.floor(distance / pageDelta) >= 1) {
            // Floored: bulk by pages never overshoots, arrows finish.
            key = up ? pageInc : pageDec;
            count = Math.floor(distance / pageDelta);
            isPage = true;
          }
        }

        const before = now;
        const sent = await press(key, count);
        await settle();
        const moved = Math.abs(now - before);
        if (moved === 0) {
          if (!isPage) return stopped(); // at a bound or ignoring the key
          pageDelta = 0;
        } else if (sent > 0) {
          // Re-estimate: covers off-grid starts, non-linear scales, page steps.
          if (isPage) pageDelta = moved / sent;
          else delta = moved / sent;
        }
        const error = Math.abs(target - now);
        if (error < bestError) {
          bestError = error;
          stalls = 0;
        } else if (++stalls >= 3) {
          // Swinging between grid points that are both too far off.
          return await conclude(true);
        }
      }
    } catch (err) {
      return fail(toMessage(err));
    } finally {
      // settle() restores only after a successful read; a drive that threw
      // mid-batch (thumb re-mounted, focus lost) must not leave the page
      // scrolled by a key the widget stopped without preventing — and
      // unguard drops the saved position, so restore has to come first.
      if (guarded) await script("SLIDER_SCROLL_JS", { op: "restore" }).catch(() => undefined);
      if (guarded) await script("SLIDER_SCROLL_JS", { op: "unguard" }).catch(() => undefined);
    }
  }

  /** Runs CLICK_JS and, if the click actually started a navigation, waits
   * briefly for it to land before trusting the result's url/title — see
   * CLICK_SETTLE_TIMEOUT_MS's doc comment. CLICK_JS itself reads
   * location.href/document.title synchronously, so on its own it reports
   * whatever page the agent was just on, not the one the click navigated
   * to, and a following browse_find_images would then race the new page's
   * load (finding 7).
   *
   * "Addendum 2" §1: a signature is captured before the click and again
   * after the settle, and the diff is merged into the result as
   * `{ changed, changes }` — the whole point being that `changed: false` is
   * a normal, reportable answer (a click on a wrapper that did nothing),
   * never an error.
   *
   * Review finding 4: CLICK_JS also stamps the element it actually clicked
   * and returns that element's own before-signature (`__scopedBefore`) —
   * extracted here (and stripped from the result, see extractScopedBefore)
   * so diffSignatures can compare it against the same element's after
   * state, the real evidence on a page whose whole-document dom/text moves
   * on its own. */
  private async runClick(target: string, deadlineAt: number): Promise<BrowserCommandResult> {
    const page = this.target.currentPage();
    if (!page) return errorResult("No browser tab is open — call browse_open first.");
    const previousUrl = page.getURL();
    // Full browser use: a click may open a popup as a new browser tab
    // (attachBrowserTabPolicy in window.ts) — listed before the action so
    // detectOpenedTab can diff against it after, the same before/after
    // shape captureSignature already uses.
    const tabsBefore = await this.listPagesSafe();
    // Before the before-signature capture, deliberately — see CURSOR_JS's
    // doc comment (pageScripts.ts) for why the overlay's own DOM/scroll
    // footprint must never land between the two evidence-of-effect captures.
    const reveal = await this.revealTarget(page, { target }, "CLICK", deadlineAt);
    if (reveal.error) return errorResult(reveal.error);
    const dismissDialog = reveal.dismissDialog;
    await this.moveCursor(page, { action: "click", target });
    const before = await this.captureSignature(page, "before");
    // Armed/captured before CLICK_JS runs — Wave 1 speed: a navigation, or a
    // fetch/XHR the click handler fires synchronously, can start inside that
    // very call, so listening/marking has to happen before it, not after.
    const navWatcher = this.armNavigationWatcher(page, previousUrl);
    const networkBaseline = this.captureNetworkBaseline(page);
    // Wave 2 reliability item 1: trusted CDP click, falling back to CLICK_JS
    // internally — see dispatchClick's doc comment.
    const result = await this.dispatchClick(page, { target });
    if ("error" in result) {
      navWatcher.dispose();
      return result;
    }
    const scopedBefore = extractScopedBefore(result);
    const selfDisabled = extractTargetSelfDisabled(result);
    await this.settleAfterClick(page, navWatcher, networkBaseline);
    if (selfDisabled) {
      await this.settleWhileTargetBusy(page);
      // A handler that disables its button and *then* navigates finishes
      // after the busy wait, not before it — so the load wait is redone
      // here. It returns immediately when nothing is loading.
      await this.waitForLoadStop(page, CLICK_LOAD_SETTLE_TIMEOUT_MS);
    }
    const dialogClosed = dismissDialog && (await this.settleDialogDismiss(page, deadlineAt));
    const evidence = await this.captureClickEffect(page, before, previousUrl, scopedBefore, deadlineAt, dialogClosed, async () =>
      (await this.detectOpenedTab(tabsBefore)) !== undefined,
    );
    const currentUrl = page.getURL();
    const openedTab = await this.resolveOpenedTab(tabsBefore, deadlineAt);
    const merged: BrowserCommandResult = {
      ...result,
      url: currentUrl,
      title: page.getTitle(),
      ...evidence,
    };
    if (openedTab) merged.openedTab = openedTab;
    return merged;
  }

  /** `act`'s `press` — a trusted CDP `Input.dispatchKeyEvent` key press,
   * optionally focusing a target first (FOCUS_JS). Reports `{ error }`
   * outright when this tab's CDP session never attached (`page.sendCdp`
   * absent) — degrading gracefully per the design doc rather than silently
   * doing nothing. Reuses the same click-settle/openedTab machinery as
   * runClick/perform's CLICK, since Enter routinely submits a form (a real
   * navigation) and can just as easily open a popup.
   *
   * Review finding 5: an `index`+`snapshotId` focus target now goes through
   * the same staleness/cross-tab guard `perform()` uses (previously it went
   * straight to FOCUS_JS, so a stale snapshotId just failed to find an
   * element with no explanation), and a focus that was explicitly requested
   * but fails is now a hard error rather than best-effort — sending the key
   * to whatever happens to already have focus when the caller asked for a
   * specific element is worse than reporting the failure. */
  private async runPress(
    keySpec: string,
    focus: { target?: string; index?: number; snapshotId?: string },
  ): Promise<BrowserCommandResult> {
    const page = this.target.currentPage();
    if (!page) return errorResult("No browser tab is open — call browse_open first.");
    const parsed = parseKeySpec(keySpec);
    if (!parsed) return errorResult(`Unsupported key: ${JSON.stringify(keySpec)}`);
    if (!page.sendCdp) {
      return errorResult("Keyboard input (press) requires a CDP session, which is unavailable for this browser tab.");
    }

    const hasIndexTarget = focus.index !== undefined && focus.snapshotId !== undefined;
    // Code review finding 6: an index-based focus target routes FOCUS_JS
    // into whichever document it actually lives in — it used to always run
    // against the top document, so pressing a key against an element inside
    // a child frame failed to focus it at all ("No element matched: index
    // N") instead of pressing the key. The key dispatch itself
    // (`page.sendCdp("Input.dispatchKeyEvent", ...)` below) needs no frame
    // routing of its own: CDP keyboard input targets whichever frame
    // currently holds focus in the renderer, regardless of which document
    // FOCUS_JS ran in to get it there.
    const { frameRoute, cursorPoint } = this.resolveFrameRouteWithCursorPoint(focus.index);
    if (focus.target || hasIndexTarget) {
      if (hasIndexTarget) {
        const staleError = this.checkSnapshotStale(focus.snapshotId!, page);
        if (staleError) return staleError;
      }
      let focusResult: BrowserCommandResult;
      try {
        const focusArgs = { target: focus.target, index: frameRoute.localIndex, snapshotId: focus.snapshotId };
        focusResult =
          frameRoute.frameId === null
            ? await this.executeScript(page, "FOCUS_JS", focusArgs)
            : await this.executeScriptInFrame(page, frameRoute.frameId, "FOCUS_JS", focusArgs);
      } catch (err) {
        return errorResult(`Failed to focus target before press: ${toMessage(err)}`);
      }
      if ("error" in focusResult) return focusResult;
      if (focusResult.focused !== true) {
        // Item 3: FOCUS_JS reports `hidden: true` when the only text match
        // it found was hidden (see LOCATE_TARGET_JS's doc comment) — a
        // distinct, more actionable error than "nothing matched at all".
        if (focusResult.hidden === true) {
          return errorResult(`target is not visible (hidden element): ${focus.target ?? `index ${focus.index}`}`);
        }
        return errorResult(`No element matched to focus before press: ${focus.target ?? `index ${focus.index}`}`);
      }
    }

    await this.moveCursor(page, {
      action: "press",
      target: focus.target,
      snapshotId: focus.snapshotId,
      index: focus.index,
      point: cursorPoint,
    });

    const previousUrl = page.getURL();
    const tabsBefore = await this.listPagesSafe();
    const before = await this.captureSignature(page, "before");

    // Armed/captured before the key is dispatched — Wave 1 speed: Enter can
    // submit a form (navigation) or fire a synchronous fetch/XHR handler,
    // either of which can start inside the dispatchKeyEvent calls below.
    const navWatcher = this.armNavigationWatcher(page, previousUrl);
    const networkBaseline = this.captureNetworkBaseline(page);

    const { descriptor } = parsed;
    // Review finding 2: a Meta/Ctrl-modified combo (Cmd+A, Ctrl+C, …) is
    // sent as a *textless* event with CDP's `commands` field naming the
    // editing command (see `keyDispatchOptions`) — Chromium doesn't run its
    // native accelerator table off a CDP-synthesized modified keydown the
    // way it would a genuine OS-level shortcut, and `text` alongside a
    // modified combo would insert the literal character "a" on Cmd+A.
    const dispatchOpts = keyDispatchOptions(parsed);
    try {
      await this.dispatchKeyPair(page, descriptor, dispatchOpts);
    } catch (err) {
      navWatcher.dispose();
      return errorResult(`Failed to dispatch key "${keySpec}": ${toMessage(err)}`);
    }

    // Wave 1 speed: Enter routinely submits a form — the same event-driven
    // navigation-then-load-stop settle a click uses — and every other key
    // now gets the network-quiet settle instead of an unconditional extra
    // fixed sleep (`settleShort` used to always run here too, on top of
    // settleAfterClick, i.e. a double settle for every single press). A key
    // that neither navigates nor triggers network activity still repaints
    // synchronously, so this is not a regression versus the old
    // NON_CLICK_SETTLE_MS sleep — it's strictly bounded by the same
    // near-instant "nothing to wait for" path settleAfterClick already
    // takes for a non-navigating click.
    await this.settleAfterClick(page, navWatcher, networkBaseline);
    const after = await this.captureSignature(page, "after");
    const currentUrl = page.getURL();
    const openedTab = await this.resolveOpenedTab(tabsBefore);
    const result: BrowserCommandResult = {
      url: currentUrl,
      title: page.getTitle(),
      ...this.diffSignatures(before, after, { previousUrl, currentUrl }),
    };
    if (openedTab) result.openedTab = openedTab;
    return result;
  }

  /** `act`'s `hover` — locates the target (HOVER_TARGET_JS), then dispatches
   * a trusted CDP `Input.dispatchMouseEvent` `mouseMoved` at its centre. A
   * page-script `dispatchEvent("mouseover")` would not trigger the
   * browser's own `:hover` CSS pseudo-class, which is the entire point of
   * this action existing separately from a page script.
   *
   * Review finding 8: HOVER_TARGET_JS itself scrolls the target into view
   * while locating it (a target below the fold has to be scrolled to before
   * its coordinates mean anything) — that scroll must happen *before* the
   * before-signature capture, per CLAUDE.md's before/after-capture ordering
   * rule (the same rule runClick's cursor-move-before-capture comment
   * documents), otherwise the before-capture's scrollY reflects the
   * pre-scroll page and the diff reports a `scrollY` change caused by
   * locating the target, not by the hover itself. Locate (and scroll) runs
   * first now, then the cursor overlay move, then the before-capture.
   *
   * Review finding 5: an `index`+`snapshotId` target now goes through the
   * same staleness/cross-tab guard `perform()` uses, instead of skipping
   * straight to a page-script lookup that would just report "not found" on
   * a stale snapshot. */
  private async runHover(spec: { target?: string; index?: number; snapshotId?: string }): Promise<BrowserCommandResult> {
    const page = this.target.currentPage();
    if (!page) return errorResult("No browser tab is open — call browse_open first.");
    if (!page.sendCdp) {
      return errorResult("Hover requires a CDP session, which is unavailable for this browser tab.");
    }
    if (spec.index !== undefined && spec.snapshotId !== undefined) {
      const staleError = this.checkSnapshotStale(spec.snapshotId, page);
      if (staleError) return staleError;
    }
    // Code review finding 6: an index-based hover target routes
    // HOVER_TARGET_JS into whichever document it actually lives in — it
    // used to always run against the top document, so hovering an element
    // inside a child frame failed with "No element matched for hover:
    // index N" instead of hovering it. Unlike press's keyboard dispatch,
    // the trusted `Input.dispatchMouseEvent` below DOES need frame-aware
    // coordinates: `located.x`/`located.y` from a frame-routed
    // HOVER_TARGET_JS call are relative to that frame's own document, so
    // the iframe's own content-box offset (`frameRect`, the same one
    // `resolveVisibleFrames` computed for the cursor overlay) is added to
    // get back to top-level-viewport coordinates, the space CDP mouse
    // events are always expressed in.
    const { frameRoute, frameRect, cursorPoint } = this.resolveFrameRouteWithCursorPoint(spec.index);
    const located =
      frameRoute.frameId === null
        ? await this.executeScript(page, "HOVER_TARGET_JS", {
            target: spec.target,
            index: spec.index,
            snapshotId: spec.snapshotId,
          })
        : await this.executeScriptInFrame(page, frameRoute.frameId, "HOVER_TARGET_JS", {
            target: spec.target,
            index: frameRoute.localIndex,
            snapshotId: spec.snapshotId,
          });
    if ("error" in located) return located;
    if (located.found !== true || typeof located.x !== "number" || typeof located.y !== "number") {
      // Item 3: see runPress's identical hidden-vs-not-found distinction.
      if (located.hidden === true) {
        return errorResult(`target is not visible (hidden element): ${spec.target ?? `index ${spec.index}`}`);
      }
      return errorResult(`No element matched for hover: ${spec.target ?? `index ${spec.index}`}`);
    }
    const hoverX = frameRect ? frameRect.x + located.x : located.x;
    const hoverY = frameRect ? frameRect.y + located.y : located.y;
    await this.moveCursor(page, {
      action: "hover",
      target: spec.target,
      snapshotId: spec.snapshotId,
      index: spec.index,
      point: cursorPoint,
    });
    const before = await this.captureSignature(page, "before");
    try {
      await page.sendCdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: hoverX, y: hoverY, button: "none" });
    } catch (err) {
      return errorResult(`Failed to dispatch hover: ${toMessage(err)}`);
    }
    await this.settleShort();
    const after = await this.captureSignature(page, "after");
    return { url: page.getURL(), title: page.getTitle(), ...this.diffSignatures(before, after, {}) };
  }

  /** The reload of the `reload` action: armed before the call, then the two-phase settle of a navigation. */
  private async reloadAndSettle(page: BrowserPageHandle): Promise<void> {
    const previousUrl = page.getURL();
    // Armed before reload() — Wave 1 speed's event-driven equivalent of
    // the old fixed-probe wait. Same two-phase settle as a click's
    // navigation (addendum F) — reload() is fire-and-forget just like
    // goBack()/goForward(), so "did it even start" and "has it
    // finished" are separate questions. reload() always intends to
    // navigate, so the load-stop wait below runs unconditionally,
    // regardless of what the watcher observed (same as before this
    // change) — it just resolves immediately if isLoading() never went
    // true.
    const navWatcher = this.armNavigationWatcher(page, previousUrl);
    page.reload();
    await navWatcher.wait();
    navWatcher.dispose();
    await this.waitForLoadStop(page, CLICK_LOAD_SETTLE_TIMEOUT_MS);
  }

  /**
   * Emulation the `viewport` action installed, per page. Each entry holds the emulation as it is NOW (the
   * fixture's locale, time zone and media settings plus the device of the action) and the function that clears
   * all of it. `releaseFixture` and `clearActEmulation` clear the entries, so nothing outlives the run.
   */
  private actLayers = new Map<BrowserPageHandle, { emulate: FixtureEmulate; clear: () => Promise<void> }>();

  /** The clear of the fixture state `clearActEmulation` / `reset` put back on a page (not an act layer). The next swap clears it first. */
  private fixtureRestores = new Map<BrowserPageHandle, () => Promise<void>>();

  /**
   * Every emulation clear the controller owns, per page: the fixture apply, the act layers and the fixture restores
   * all register here, and a clear removes itself from the set when it is called. Nothing installs without
   * registering. `sweepEmulations` calls what is left, so a clear that a swap lost track of (a stale install, a
   * discarded restore) is still run at the end of the run.
   */
  private emulationClears = new Map<BrowserPageHandle, Set<() => Promise<void>>>();

  /** Registers `clear` for `page`; returns the registered form (it forgets itself when it runs). */
  private registerEmulationClear(page: BrowserPageHandle, clear: () => Promise<void>): () => Promise<void> {
    let set = this.emulationClears.get(page);
    if (!set) this.emulationClears.set(page, (set = new Set()));
    const owner = set;
    const registered = async (): Promise<void> => {
      owner.delete(registered);
      await clear();
    };
    owner.add(registered);
    return registered;
  }

  /** `installEmulation` plus registration: the one way the controller installs an emulation itself. */
  private async installRegistered(page: BrowserPageHandle, emulate: FixtureEmulate): Promise<() => Promise<void>> {
    return this.registerEmulationClear(page, await installEmulation(page, resolveEmulation(emulate)));
  }

  /**
   * Runs every registered clear of every open page (idempotent, never throws). After it no override, init script
   * or extra header the controller installed remains. Closed pages are dropped without a CDP call.
   */
  private async sweepEmulations(): Promise<void> {
    await this.pruneClosedLayers();
    const clears = [...this.emulationClears.values()].flatMap((set) => [...set]);
    this.emulationClears.clear();
    this.fixtureRestores.clear();
    for (const clear of clears) {
      try {
        await clear();
      } catch {
        // The tab is gone or refuses: nothing more to do.
      }
    }
  }

  /** The emulation the last applied fixture put on this page, if any. */
  private fixtureEmulationOf(page: BrowserPageHandle): FixtureEmulate | undefined {
    const emulation = this.fixtureActive?.emulation;
    return emulation?.pages.has(page) ? emulation.emulate : undefined;
  }

  /** The emulation this page carries now: the `viewport` action's layer, else the fixture's. */
  private emulationOf(page: BrowserPageHandle): FixtureEmulate | undefined {
    return this.actLayers.get(page)?.emulate ?? this.fixtureEmulationOf(page);
  }

  /**
   * Counts the operations that end or replace a `viewport` state: every `viewport` action, `clearActEmulation`,
   * `releaseFixture` and `applyFixture` takes ONE step when it starts. An operation keeps the number it started with
   * and checks it right before each step that installs, restores or records; once the number moved it undoes what it
   * installed and stops. A timed-out action keeps running in the background, and its late steps must not outlive
   * the run end or a newer operation. (A step already sent to the page cannot be recalled: it is undone afterwards.)
   */
  private actGeneration = 0;

  /** Forgets the layers (and registered clears) of pages that are closed (no CDP call: their session is gone). */
  private async pruneClosedLayers(): Promise<void> {
    if (this.actLayers.size === 0 && this.fixtureRestores.size === 0 && this.emulationClears.size === 0) return;
    if (!this.target.pageHandles) return;
    let handles: { tabId: number; page: BrowserPageHandle }[];
    try {
      handles = await this.target.pageHandles();
    } catch {
      return;
    }
    const live = new Set(handles.map((h) => h.page));
    for (const map of [this.actLayers, this.fixtureRestores, this.emulationClears]) {
      for (const page of [...map.keys()]) if (!live.has(page)) map.delete(page);
    }
  }

  /**
   * Puts the emulation the fixture gives this page back, as the fixture's own state (not an act layer; its clear is
   * kept in `fixtureRestores`). The fixture is read NOW, at restore time: a fixture that was released or replaced
   * since `token` was read, or a generation that moved, restores nothing. Returns "superseded" in that case, and
   * undoes what it installed when the check fails after the install.
   */
  private async restoreFixtureState(page: BrowserPageHandle, token: string | undefined, isCurrent: () => boolean): Promise<"done" | "superseded"> {
    const stale = (): boolean => !isCurrent() || this.fixtureActive?.token !== token;
    if (stale()) return "superseded";
    const base = this.fixtureEmulationOf(page);
    if (!base) return "done";
    if (!(await clearDeviceEmulation(page))) throw new Error("the device emulation of the page could not be cleared");
    if (stale()) return "superseded";
    const clear = await this.installRegistered(page, base);
    if (stale()) {
      await clear();
      return "superseded";
    }
    this.fixtureRestores.set(page, clear);
    return "done";
  }

  /**
   * Replaces the emulation of `page` with `next` (undefined: back to the fixture's state, or none). The previous
   * layer is cleared first, and the device layer of the fixture too (its own clear is all or nothing), so the real
   * user agent and hints are read clean. `next` is installed whole, locale and media settings included, and is what
   * the next swap clears. Every step checks `isCurrent` right before it acts. Returns "superseded" (and leaves
   * nothing of its own installed) when `isCurrent` turned false.
   */
  private async swapActEmulation(page: BrowserPageHandle, next: FixtureEmulate | undefined, isCurrent: () => boolean): Promise<"done" | "superseded"> {
    if (!isCurrent()) return "superseded";
    const previous = this.actLayers.get(page);
    this.actLayers.delete(page);
    const restored = this.fixtureRestores.get(page);
    this.fixtureRestores.delete(page);
    if (previous) await previous.clear();
    if (restored) await restored();
    const token = this.fixtureActive?.token;
    if (!next) return this.restoreFixtureState(page, token, isCurrent);
    const base = this.fixtureEmulationOf(page);
    if (!isCurrent()) return "superseded";
    if (base && !(await clearDeviceEmulation(page))) throw new Error("the device emulation of the page could not be cleared");
    if (!isCurrent() || this.fixtureActive?.token !== token) return "superseded";
    const clear = await this.installRegistered(page, next);
    if (!isCurrent() || this.fixtureActive?.token !== token) {
      // Abandoned while installing. A newer layer on the page owns the overrides now (our clear stays registered and
      // runs in the final sweep); otherwise undo ours.
      if (!this.actLayers.has(page)) await clear();
      return "superseded";
    }
    this.actLayers.set(page, { emulate: next, clear });
    return "done";
  }

  /** Drops every `viewport` layer without restoring anything (the fixture release or the run end follows). */
  private async dropActLayers(): Promise<void> {
    await this.pruneClosedLayers();
    const clears = [...this.actLayers.values()].map((layer) => layer.clear).concat([...this.fixtureRestores.values()]);
    this.actLayers.clear();
    this.fixtureRestores.clear();
    for (const clear of clears) {
      try {
        await clear();
      } catch {
        // The tab is gone: nothing is left to clear.
      }
    }
  }

  /**
   * Ends what the `viewport` action set: the pages go back to the state the fixture gave them, or to the real
   * browser when there is no fixture. Idempotent (a page with no layer gets no CDP call), never rejects, no reload.
   * Runs in the command queue, after any `viewport` action still in flight. `runBrowseAgent` calls it when a run
   * ends (the emulation must not outlive the run), also when no fixture was applied; a host that drives the
   * controller itself calls it at the end of its own run. `releaseFixture` clears the same state. With no fixture
   * left it ends with the same sweep as `releaseFixture`.
   *
   * It is bounded by `OVERRUN_GRACE_MS`. A clear that outlives the bound keeps running, so it is registered as an
   * overrun (the next command waits for it, within the grace) and its remaining steps are cancelled.
   */
  async clearActEmulation(): Promise<void> {
    const generation = (this.actGeneration += 1);
    const isCurrent = (): boolean => this.actGeneration === generation;
    await this.runExclusive(async () => {
      const work = this.clearActEmulationUnlocked(isCurrent);
      const outcome = await boundedCall(() => work, OVERRUN_GRACE_MS);
      if (!outcome.done) {
        // Cancel what is left of the clear (its next step sees a moved generation and undoes itself), and make the queue wait for it.
        this.actGeneration += 1;
        this.registerOverrun(work.then(() => undefined, () => undefined));
      }
    }).catch(() => undefined);
  }

  private async clearActEmulationUnlocked(isCurrent: () => boolean): Promise<void> {
    await this.pruneClosedLayers();
    for (const page of [...this.actLayers.keys()]) {
      if (!isCurrent()) return;
      try {
        await this.swapActEmulation(page, undefined, isCurrent);
      } catch {
        // Best effort: the page is gone or refuses the override.
      }
    }
    // With a fixture the pages keep its state; without one nothing the controller installed may remain.
    if (isCurrent() && !this.fixtureActive) await this.sweepEmulations();
  }

  /** The next queued command waits for `settled` (bounded by `OVERRUN_GRACE_MS`): abandoned work must not overlap it. */
  private registerOverrun(settled: Promise<void>): void {
    const next = boundedCall(() => settled, OVERRUN_GRACE_MS).then(() => undefined);
    // Merged, not replaced: a command nested in another one (a fixture's navigation) must not drop the outer command's pending overrun.
    this.overrun = this.overrun ? Promise.all([this.overrun, next]).then(() => undefined) : next;
  }

  /**
   * `act`'s `viewport`: sets the device emulation of the current page (docs/specs/2026-10-18-qa-diagnostics-design.md,
   * section 6). The arguments are checked before the page is touched. A change of the user agent or the mobile flag
   * reloads the page.
   */
  private async actViewport(args: Record<string, unknown>): Promise<BrowserCommandResult> {
    const parsed = parseViewportArgs(args);
    if (!parsed.ok) return errorResult(parsed.error);
    const request = parsed.value;
    const page = this.target.currentPage();
    if (!page) return errorResult("No browser tab is open — call browse_open first.");
    if (!page.sendCdp) return Object.assign(errorResult("This browser does not support emulation."), { [NO_EFFECT]: true });
    const before = this.emulationOf(page);
    const previousLayer = this.actLayers.get(page)?.emulate;
    // `reset` gives back the fixture's emulation, but only on a page the fixture emulated.
    const next = layerViewport(this.fixtureEmulationOf(page), request);
    const reload = emulationIdentity(before) !== emulationIdentity(next);
    const generation = (this.actGeneration += 1);
    const isCurrent = (): boolean => this.actGeneration === generation;
    const superseded = (): BrowserCommandResult => errorResult("Setting the viewport was cancelled: the run ended or a newer viewport change came first. Take a snapshot.");
    const result = await this.withCommandTimeout(
      async () => {
        // The page is touched from here on: an index of the last snapshot may point at another element now.
        this.lastSnapshot = null;
        await this.pruneClosedLayers();
        let outcome: "done" | "superseded";
        try {
          outcome = await this.swapActEmulation(page, next, isCurrent);
        } catch (err) {
          // The failed install cleared itself: put the page back to the previous layer, else to the fixture's state.
          // Both steps check the generation, so a run that ended meanwhile gets no layer recorded.
          this.lastSnapshot = null;
          let restored = true;
          try {
            if ((await this.swapActEmulation(page, previousLayer, isCurrent)) === "superseded") return superseded();
          } catch {
            restored = false;
            await this.swapActEmulation(page, undefined, isCurrent).catch(() => undefined);
          }
          if (!isCurrent()) return superseded();
          const now = restored ? before : this.fixtureEmulationOf(page);
          // The failed attempt never reloaded, so the DOM matches `before`: reload when the page now shows another identity.
          const mismatch = emulationIdentity(now) !== emulationIdentity(before);
          if (mismatch) await this.reloadAndSettle(page).catch(() => undefined);
          return errorResult(
            `Setting the viewport failed: ${toMessage(err)}` +
              (restored ? "" : `. The previous viewport could not be put back${mismatch ? " (the page was reloaded)" : ""}; take a snapshot.`),
          );
        }
        if (outcome === "superseded") return superseded();
        this.lastSnapshot = null;
        if (reload) {
          await this.reloadAndSettle(page);
          if (!isCurrent()) return superseded();
        }
        const metrics = next ? resolveEmulation(next).metrics : undefined;
        const size = await readViewportSize(page);
        const width = size?.width ?? metrics?.width;
        const height = size?.height ?? metrics?.height;
        const deviceScaleFactor = size?.dpr ?? metrics?.deviceScaleFactor;
        return {
          ok: true,
          ...(width !== undefined && height !== undefined && deviceScaleFactor !== undefined
            ? { viewport: { width, height, deviceScaleFactor, mobile: metrics?.mobile ?? false } }
            : {}),
          device: request.device,
          reloaded: reload,
        };
      },
      this.timeoutMs + 5_000,
      reload && this.journal ? { op: "nav" } : undefined,
    );
    if (typeof result.error === "string" && result.error.startsWith("Browser command timed out")) {
      this.lastSnapshot = null;
      return { ...result, error: "Setting the viewport timed out; the page may have changed. Take a snapshot." };
    }
    return result;
  }

  /**
   * `act`'s `upload`: limits and file shapes are checked here, before the page
   * is touched (a refusal leaves no journal trace); then UPLOAD_JS sets the
   * files. A successful upload is a checkpoint gap (the bytes cannot replay).
   */
  private async actUpload(args: Record<string, unknown>): Promise<BrowserCommandResult> {
    let target: string | undefined;
    let index: number | undefined;
    let snapshotId: string | undefined;
    if (typeof args.target === "string" && args.target.trim() !== "") {
      target = args.target;
    } else if (args.index !== undefined || args.snapshotId !== undefined) {
      const validated = validateIndexSnapshot(args, "upload");
      if (!validated.ok) return errorResult(validated.error);
      index = validated.index;
      snapshotId = validated.snapshotId;
    } else {
      return errorResult('browse_act "upload" requires a "target" string, or "index" with "snapshotId".');
    }
    const files = validateUploadFiles(args.files);
    if (!files.ok) return errorResult(files.error);
    return this.withCommandTimeout(
      () => this.runUpload({ target, index, snapshotId, files: files.files }),
      this.timeoutMs + this.cursorBudgetMs,
      this.journal ? { op: "upload" } : undefined,
    );
  }

  private async runUpload(spec: {
    target?: string;
    index?: number;
    snapshotId?: string;
    files: UploadPayloadFile[];
  }): Promise<BrowserCommandResult> {
    const page = this.target.currentPage();
    if (!page) return errorResult("No browser tab is open — call browse_open first.");
    if (spec.index !== undefined && spec.snapshotId !== undefined) {
      const staleError = this.checkSnapshotStale(spec.snapshotId, page);
      if (staleError) return staleError;
    }
    const { frameRoute } = this.resolveFrameRouteWithCursorPoint(spec.index);
    const before = await this.captureSignature(page, "before");
    const result =
      frameRoute.frameId === null
        ? await this.executeScript(page, "UPLOAD_JS", {
            target: spec.target,
            index: spec.index,
            snapshotId: spec.snapshotId,
            files: spec.files,
          })
        : await this.executeScriptInFrame(page, frameRoute.frameId, "UPLOAD_JS", {
            target: spec.target,
            index: frameRoute.localIndex,
            snapshotId: spec.snapshotId,
            files: spec.files,
          });
    if ("error" in result) return result;
    await this.settleShort();
    const after = await this.captureSignature(page, "after");
    return {
      url: page.getURL(),
      title: page.getTitle(),
      ok: true,
      uploaded: result.uploaded,
      via: result.via,
      ...(result.unconfirmed === true ? { unconfirmed: true } : {}),
      ...(result.relocated === true ? { relocated: true } : {}),
      ...this.diffSignatures(before, after, {}),
    };
  }

  /** `act`'s `wait` — without `text`, Wave 1 speed's follow-up rule: `wait`
   * exists precisely because the caller expects *something* — often a
   * client-side timer with no network involvement at all (a spinner
   * resolving into a button, say) — to still be in flight, so returning
   * early just because nothing has happened *yet* would defeat the whole
   * point. The rule is therefore "wait for activity, then for it to settle",
   * not "wait for quiet from the start": this polls both DOM mutations
   * (`WAIT_DOM_ACTIVITY_JS`, a `MutationObserver` installed on
   * `document.body` for the duration of this call) and network activity
   * (`page.networkStats`, the same CDP tracking `settleAfterClick`'s
   * network-quiet settle uses) every WAIT_POLL_INTERVAL_MS, and returns
   * once *some* activity has been observed (a DOM mutation, or a new
   * network request) AND that activity has since been quiet — no pending
   * network requests and no DOM mutation within the last
   * NETWORK_QUIET_WINDOW_MS — continuously for NETWORK_QUIET_WINDOW_MS. If
   * nothing at all happens for the whole call, it waits out the full `ms`
   * exactly as the original fixed-sleep behavior did — this is not a
   * "return as soon as quiet" wait, only a "don't keep waiting once
   * whatever was happening has finished" one. Falls back to a plain bounded
   * sleep when neither signal is available (no CDP session *and* the DOM
   * observer failed to install) — see the loop below.
   *
   * With `text`, polls WAIT_TEXT_JS every WAIT_POLL_INTERVAL_MS until it
   * reports a case-insensitive substring match or `ms` runs out. Never
   * errors on a miss — `found: false` is a normal, reportable answer (see
   * the design doc's table), the same "not finding something is not a
   * failure" convention `diffSignatures`'s `changed: false` already
   * established.
   *
   * Second-pass review finding 9: a do/while, not a `while` — with `text`
   * and a `ms` of 0 (or small enough that the deadline has already passed by
   * the time `Date.now()` is checked), the previous `while (Date.now() <
   * deadline)` loop's condition could be false before the body ever ran even
   * once, so the page was never actually checked at all and the call simply
   * reported `found: false` no matter what was already on the page. The text
   * is now always polled at least once, regardless of `ms`. */
  private async runWait(text: string | undefined, ms: number): Promise<BrowserCommandResult> {
    const page = this.target.currentPage();
    if (!page) return errorResult("No browser tab is open — call browse_open first.");
    if (!text) {
      await this.runWaitForActivityThenQuiet(page, ms);
      return { found: true, url: page.getURL(), title: page.getTitle() };
    }
    const deadline = Date.now() + ms;
    let found = false;
    do {
      try {
        const result = await this.executeScript(page, "WAIT_TEXT_JS", { text });
        if (isRecord(result) && result.found === true) {
          found = true;
        }
      } catch {
        // Keep polling — a transient executeJavaScript failure (mid
        // navigation, say) shouldn't end the wait early.
      }
      if (found || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_INTERVAL_MS));
    // eslint-disable-next-line no-constant-condition -- do/while is deliberate (runs at least once), see doc comment above
    } while (true);
    return { found, url: page.getURL(), title: page.getTitle() };
  }

  /** `runWait`'s no-`text` engine — see its doc comment for the rule. Installs
   * `WAIT_DOM_ACTIVITY_JS`'s `MutationObserver` for the duration of the call
   * (best-effort: a failed install just means the DOM half of the signal
   * never fires, degrading gracefully to network-only, or to a plain sleep
   * if network is unavailable too), captures a network-activity baseline the
   * same way `captureNetworkBaseline` does for click/press, then polls both
   * every WAIT_POLL_INTERVAL_MS. `quietSince` accumulates only once *some*
   * activity (DOM or network) has actually been observed — before that, it
   * is deliberately left `null` on every iteration, which is what makes
   * "nothing ever happened" wait out the full `ms` rather than exiting
   * immediately (a DOM/network signal that starts at `pending === 0`/
   * `ageMs === null` looks identical to "never happened" until something
   * actually does). */
  private async runWaitForActivityThenQuiet(page: BrowserPageHandle, ms: number): Promise<void> {
    let domInstalled = false;
    try {
      const installed = await this.executeScript(page, "WAIT_DOM_ACTIVITY_JS", { action: "install" });
      domInstalled = !("error" in installed);
    } catch {
      domInstalled = false;
    }
    const networkBaseline = page.networkStats ? page.networkStats(NETWORK_REQUEST_DROP_MS).generation : undefined;

    try {
      const deadline = Date.now() + ms;
      let sawActivity = false;
      let quietSince: number | null = null;
      while (Date.now() < deadline) {
        let domAgeMs: number | null = null;
        if (domInstalled) {
          try {
            const domResult = await this.executeScript(page, "WAIT_DOM_ACTIVITY_JS", { action: "check" });
            if (!("error" in domResult) && domResult.mutated === true && typeof domResult.ageMs === "number") {
              domAgeMs = domResult.ageMs;
            }
          } catch {
            // Keep polling — a transient executeJavaScript failure (mid
            // navigation, say) shouldn't end the wait early.
          }
        }
        let networkPending = 0;
        let networkStarted = false;
        if (page.networkStats) {
          // Second-pass review finding 2: scope `pending` to requests that
          // started AFTER `networkBaseline` — same fix as
          // `waitForNetworkQuiet` (see its own comment). Without the
          // baseline, a request already in flight before this wait started
          // kept `pending > 0` — and therefore `currentlyActive` — for the
          // whole `ms` budget, even after it had genuinely gone quiet.
          const stats = page.networkStats(NETWORK_REQUEST_DROP_MS, networkBaseline);
          networkPending = stats.pending;
          networkStarted = networkBaseline !== undefined && stats.generation !== networkBaseline;
        }

        if (domAgeMs !== null || networkStarted) sawActivity = true;
        const domRecentlyActive = domAgeMs !== null && domAgeMs < NETWORK_QUIET_WINDOW_MS;
        const currentlyActive = networkPending > 0 || domRecentlyActive;

        if (sawActivity && !currentlyActive) {
          if (quietSince === null) quietSince = Date.now();
          if (Date.now() - quietSince >= NETWORK_QUIET_WINDOW_MS) return;
        } else {
          quietSince = null;
        }
        await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_INTERVAL_MS));
      }
    } finally {
      if (domInstalled) {
        try {
          await this.executeScript(page, "WAIT_DOM_ACTIVITY_JS", { action: "uninstall" });
        } catch {
          // Best-effort cleanup — a stray observer on the page is harmless
          // (the next "install" call disconnects it anyway) and must never
          // mask the wait's own result.
        }
      }
    }
  }

  /** Second-pass review finding 8: public entry point — serializes onto the
   * command queue and delegates to `findImagesUnlocked`. */
  async findImages(args: unknown): Promise<BrowserCommandResult> {
    return this.runExclusive(() => this.findImagesUnlocked(args));
  }

  private async findImagesUnlocked(args: unknown): Promise<BrowserCommandResult> {
    if (args !== undefined && !isRecord(args)) {
      return errorResult("browse_find_images requires an object (or no arguments).");
    }
    const raw = isRecord(args) ? args : {};
    const minWidth = normalizeNonNegativeNumber(raw.minWidth, 200);
    if (minWidth.error) return errorResult(`"minWidth" ${minWidth.error}`);
    const minHeight = normalizeNonNegativeNumber(raw.minHeight, 200);
    if (minHeight.error) return errorResult(`"minHeight" ${minHeight.error}`);
    const limitField = normalizeNonNegativeNumber(raw.limit, 30);
    if (limitField.error) return errorResult(`"limit" ${limitField.error}`);
    const limit = Math.max(1, Math.min(limitField.value, 100));

    return this.withCommandTimeout(async () => {
      const page = this.target.currentPage();
      if (!page) return errorResult("No browser tab is open — call browse_open first.");
      const top = await this.executeScript(page, "FIND_IMAGES_JS", {
        minWidth: minWidth.value,
        minHeight: minHeight.value,
        limit,
      });
      if ("error" in top) return top;
      // Wave 3 reliability, item 2: merge in every visible child frame's own
      // images, then re-apply the same "largest first, capped at limit"
      // rule FIND_IMAGES_JS itself uses — a frame's images are otherwise
      // invisible to browse_find_images entirely.
      const images: Record<string, unknown>[] = Array.isArray(top.images) ? [...(top.images as Record<string, unknown>[])] : [];
      const frames = await this.resolveVisibleFrames(page);
      for (const frame of frames) {
        let frameResult: BrowserCommandResult;
        try {
          frameResult = await this.executeScriptInFrame(page, frame.frameId, "FIND_IMAGES_JS", {
            minWidth: minWidth.value,
            minHeight: minHeight.value,
            limit,
          });
        } catch {
          continue; // electron#5183 — a stuck frame is skipped, not fatal.
        }
        if ("error" in frameResult || !Array.isArray(frameResult.images)) continue;
        for (const img of frameResult.images as Record<string, unknown>[]) images.push(img);
      }
      images.sort((a, b) => {
        const areaA = (typeof a.width === "number" ? a.width : 0) * (typeof a.height === "number" ? a.height : 0);
        const areaB = (typeof b.width === "number" ? b.width : 0) * (typeof b.height === "number" ? b.height : 0);
        return areaB - areaA;
      });
      const capped = images.slice(0, limit);
      return { ...top, images: capped, count: capped.length };
    });
  }

  /** A readable digest of the current page — jev-loop design doc "Addendum
   * 2, 2026-09-19" §2. Read-only, so unlike act/perform it carries no
   * `{ changed, changes }` evidence. A `selector` that matches nothing is a
   * page-script `{ error }`, surfaced here exactly like any other page
   * error, not silently widened to a whole-page read. */
  async read(args: unknown): Promise<BrowserCommandResult> {
    return this.runExclusive(() => this.readUnlocked(args));
  }

  private async readUnlocked(args: unknown): Promise<BrowserCommandResult> {
    const validated = validateReadArgs(args);
    if (!validated.ok) return errorResult(validated.error);
    const { maxChars, selector } = validated.value;
    return this.withCommandTimeout(async () => {
      const page = this.target.currentPage();
      if (!page) return errorResult("No browser tab is open — call browse_open first.");
      const top = await this.executeScript(page, "READ_JS", { maxChars, selector: selector ?? null });
      if ("error" in top) return top;
      // Wave 3 reliability, item 2: a `selector` scopes the read to a part
      // of the TOP document only — descending into frames as well wouldn't
      // even mean anything (a frame is never inside the selector's scope),
      // so frame text is only appended for a plain, whole-page read.
      if (selector) return top;
      const frames = await this.resolveVisibleFrames(page);
      if (frames.length === 0) return top;
      let text = typeof top.text === "string" ? top.text : "";
      for (const frame of frames) {
        if (text.length >= maxChars) break;
        let frameResult: BrowserCommandResult;
        try {
          frameResult = await this.executeScriptInFrame(page, frame.frameId, "READ_JS", {
            maxChars: maxChars - text.length,
            selector: null,
          });
        } catch {
          continue; // electron#5183 — a stuck frame is skipped, not fatal.
        }
        if ("error" in frameResult || typeof frameResult.text !== "string" || !frameResult.text) continue;
        const label = frameLabel(frame, typeof frameResult.title === "string" ? frameResult.title : undefined);
        text += ` [frame: ${label}] ${frameResult.text}`;
      }
      const truncated = text.length > maxChars || top.truncated === true;
      return { ...top, text: text.length > maxChars ? text.slice(0, maxChars) : text, truncated };
    });
  }

  /** Serializes the current page (or one snapshot-stamped element) into a
   * self-contained HTML document for the editor canvas (browse-capture design,
   * 2026-10-15). Read-only, top document only (no frames). Success is
   * `{ html, width, height, url, title }`. */
  async capture(args?: unknown): Promise<BrowserCommandResult> {
    return this.runExclusive(() => this.captureUnlocked(args));
  }

  private async captureUnlocked(args: unknown): Promise<BrowserCommandResult> {
    const validated = validateCaptureArgs(args);
    if (!validated.ok) return errorResult(validated.error);
    const { snapshotId, index } = validated.value;
    return this.withCommandTimeout(async (deadlineAt) => {
      const page = this.target.currentPage();
      if (!page) return errorResult("No browser tab is open — call browse_open first.");
      if (snapshotId !== null && index !== null) {
        const staleError = this.checkSnapshotStale(snapshotId, page);
        if (staleError) return staleError;
        // The capture script reads the top document only: an index that
        // belongs to a child frame cannot be found there.
        const route = this.lastSnapshot?.frameMap.get(index);
        if (route && route.frameId !== null) {
          return errorResult(
            `Element ${index} is inside a frame; browse_capture copies the top document only. Capture the whole page or open the frame URL with browse_open.`,
          );
        }
      }
      const captured = await this.executeScript(page, "CAPTURE_JS", { snapshotId, index, maxChars: CAPTURE_MAX_CHARS });
      if ("error" in captured) return captured;
      // The page's own pre-check (it sees the document before any CSS work).
      if (typeof captured.tooLarge === "number") return errorResult(tooLargeMessage(captured.tooLarge));
      const { sources, htmlOpen, bodyOpen, bodyHtml } = captured;
      if (
        !Array.isArray(sources) ||
        typeof htmlOpen !== "string" ||
        typeof bodyOpen !== "string" ||
        typeof bodyHtml !== "string"
      ) {
        return errorResult("Unexpected response from the page script.");
      }
      const assemble = (sheets: ResolvedSheet[]): string =>
        "<!doctype html>" + htmlOpen + '<head><meta charset="utf-8">' +
        sheets
          .flatMap((sh) => [...sh.fallbacks.map(importStatement), ...(sheetCss(sh).trim() ? [sheetCss(sh)] : [])])
          .map(renderStyleTag)
          .join("") +
        "</head>" + bodyOpen + bodyHtml + "</body></html>";
      const v1 = (): string => assemble(v1Shape(sources as CaptureSource[]));
      let html: string;
      try {
        html = assemble(await this.buildCaptureCss(page, sources as CaptureSource[], snapshotId, index, deadlineAt));
        // Inlined imports can push a page over the cap that the v1 shape fits.
        if (html.length > CAPTURE_MAX_CHARS) html = v1();
      } catch {
        html = v1(); // any CSS-phase failure: the v1 shape, never an empty style list
      }
      if (html.length > CAPTURE_MAX_CHARS) {
        return errorResult(tooLargeMessage(html.length));
      }
      return { html, width: captured.width, height: captured.height, url: captured.url, title: captured.title };
    }, CAPTURE_BUDGET_MS);
  }

  /** capture v2: one finished sheet per source (imports inlined, urls
   * absolute, root rules rewritten, unused rules pruned). Throws on an
   * unexpected failure (the caller falls back to the v1 shape); a failing
   * page query only degrades to the unpruned CSS. */
  private async buildCaptureCss(
    page: BrowserPageHandle,
    sources: CaptureSource[],
    snapshotId: string | null,
    index: number | null,
    deadlineAt: number,
  ): Promise<ResolvedSheet[]> {
    const sheets = await resolveImports(sources, page.fetchText ? page.fetchText.bind(page) : undefined, {
      deadlineAt,
      isAllowed: page.isFetchAllowed ? page.isFetchAllowed.bind(page) : undefined,
    });
    const remainingMs = () => deadlineAt - Date.now();
    if (remainingMs() < CSS_QUERY_MIN_REMAINING_MS) return sheets;
    try {
      const roots = sheets.map((sh) => sh.root);
      const { rootCompounds, selectors } = collectQueries(roots.filter((r): r is NonNullable<typeof r> => r !== null));
      if (rootCompounds.length === 0 && selectors.length === 0) return sheets;
      const rootMatches = new Set<string>();
      const existing = new Set<string>();
      const unparseable = new Set<string>();
      const total = Math.max(rootCompounds.length, selectors.length);
      for (let at = 0; at === 0 || at < total; at += CSS_QUERY_CHUNK) {
        // Budget is checked before EVERY chunk and each query is raced against
        // the deadline; on either, the CSS stays unpruned (roots are only
        // rewritten once every answer is in).
        if (remainingMs() < CSS_QUERY_MIN_REMAINING_MS) return sheets;
        const query = this.executeScript(page, "CSS_QUERY_JS", {
          rootCompounds: rootCompounds.slice(at, at + CSS_QUERY_CHUNK),
          selectors: selectors.slice(at, at + CSS_QUERY_CHUNK),
          snapshotId,
          index,
        });
        query.catch(() => undefined);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const answer = await Promise.race([
          query,
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), Math.max(0, remainingMs() - CSS_QUERY_DEADLINE_MARGIN_MS));
          }),
        ]).finally(() => clearTimeout(timer));
        if (answer === null || "error" in answer) return sheets;
        for (const [key, set] of [["rootMatches", rootMatches], ["existing", existing], ["unparseable", unparseable]] as const) {
          const list = answer[key];
          if (Array.isArray(list)) for (const v of list) if (typeof v === "string") set.add(v);
        }
      }
      for (const root of roots) if (root) applyQueryResults(root, rootMatches, existing, unparseable);
      return sheets;
    } catch {
      return sheets;
    }
  }

  /** Walks the current page and returns an indexed element table (jev-loop
   * design doc §1). Generates a fresh snapshotId every call — the id is
   * both embedded in the page (SNAPSHOT_JS stamps each surviving element
   * with `data-pen-snap="<id>:<index>"`) and returned to the caller, and
   * becomes the *only* snapshotId perform() will accept until the next
   * snapshot() call. */
  async snapshot(): Promise<BrowserCommandResult> {
    return this.runExclusive(() => this.snapshotUnlocked());
  }

  private async snapshotUnlocked(): Promise<BrowserCommandResult> {
    return this.withCommandTimeout(async () => {
      const page = this.target.currentPage();
      if (!page) return errorResult("No browser tab is open — call browse_open first.");
      return this.takeSnapshot(page);
    });
  }

  /** The actual snapshot() work, factored out so `screenshot({ annotate:
   * true })` can take one against a page it already resolved, without a
   * second `currentPage()` lookup (and the TOCTOU risk of that lookup
   * returning a different tab than the one already being screenshotted). */
  private async takeSnapshot(page: BrowserPageHandle): Promise<BrowserCommandResult> {
    const snapshotId = randomUUID();
    const result = await this.executeScript(page, "SNAPSHOT_JS", {
      snapshotId,
      maxElements: MAX_SNAPSHOT_ELEMENTS,
    });
    if ("error" in result) return result;

    // Wave 3 reliability, item 2: indices are global and stable within one
    // snapshot — the top document's own elements keep the indices
    // SNAPSHOT_JS already assigned them (0..N-1), and every visible child
    // frame's own elements are appended after them, renumbered globally.
    // frameMap records how to route perform() back to the right document
    // for each global index (see its own doc comment).
    const elements: Record<string, unknown>[] = Array.isArray(result.elements)
      ? [...(result.elements as Record<string, unknown>[])]
      : [];
    const frameMap = new Map<number, { frameId: number | null; localIndex: number }>();
    const frameRects = new Map<number, { x: number; y: number; width: number; height: number }>();
    for (const el of elements) {
      if (typeof el.index === "number") frameMap.set(el.index, { frameId: null, localIndex: el.index });
    }

    let remaining = MAX_SNAPSHOT_ELEMENTS - elements.length;
    // A modal scope on the top document (`result.modal`) makes child frames
    // outside the modal unreachable too — SNAPSHOT_JS scopes only its own
    // document, so only frames whose <iframe> is inside the modal are merged
    // (it reports them as `__modalFrames`, identified by src/name the way
    // IFRAME_RECTS_JS does; matched below the way resolveVisibleFrames does).
    const modalFrames = extractModalFrames(result);
    if (remaining > 0) {
      const frames = (await this.resolveVisibleFrames(page)).filter(
        (f) =>
          !modalFrames || modalFrames.some((m) => (m.url !== "" && m.url === f.url) || (m.name !== "" && m.name === f.name)),
      );
      for (const frame of frames) {
        frameRects.set(frame.frameId, { x: frame.x, y: frame.y, width: frame.width, height: frame.height });
        if (remaining <= 0) break;
        let frameResult: BrowserCommandResult;
        try {
          frameResult = await this.executeScriptInFrame(page, frame.frameId, "SNAPSHOT_JS", {
            snapshotId,
            maxElements: Math.min(MAX_SNAPSHOT_ELEMENTS, remaining),
          });
        } catch {
          // electron#5183: a frame that never finishes loading (or one that
          // navigated away between resolveVisibleFrames and here) must not
          // hang or fail the whole snapshot — it's simply skipped.
          continue;
        }
        if ("error" in frameResult || !Array.isArray(frameResult.elements)) continue;
        const label = frameLabel(frame, typeof frameResult.title === "string" ? frameResult.title : undefined);
        for (const el of frameResult.elements as Record<string, unknown>[]) {
          if (remaining <= 0) break;
          const localIndex = typeof el.index === "number" ? el.index : 0;
          const globalIndex = elements.length;
          frameMap.set(globalIndex, { frameId: frame.frameId, localIndex });
          elements.push({ ...el, index: globalIndex, frame: label });
          remaining--;
        }
      }
    }

    const fingerprints = new Map<number, ElementFingerprint>();
    const candidatesFp: [number, ElementFingerprint][] = [];
    for (const el of (Array.isArray(result.elements) ? result.elements : []) as Record<string, unknown>[]) {
      const fp = fingerprintOf(el);
      if (fp) candidatesFp.push([el.index as number, fp]);
    }
    // A fingerprint shared by several entries of this table is ambiguous by
    // construction (two "Remove" buttons) — relocation could hand one index
    // the other's node — so none of them keeps one.
    const fpKey = (f: ElementFingerprint) => JSON.stringify([f.tag, f.label, f.role ?? ""]);
    const fpCounts = new Map<string, number>();
    for (const [, f] of candidatesFp) fpCounts.set(fpKey(f), (fpCounts.get(fpKey(f)) ?? 0) + 1);
    for (const [i, f] of candidatesFp) if (fpCounts.get(fpKey(f)) === 1) fingerprints.set(i, f);

    this.lastSnapshot = { id: snapshotId, page, frameMap, frameRects, fingerprints };
    const { __modalFrames: _internal, ...publicResult } = result;
    void _internal;
    return { ...publicResult, elements, snapshotId };
  }

  /** Annotated capture. Preferred: lay the marks out with MARKS_JS
   * `draw:false` (no visible DOM change), capture the CLEAN page, paint the
   * marks onto the image in an isolated world (COMPOSE_MARKS_JS). Any failure
   * — or a handle without `executeJavaScriptIsolated` — falls back to the
   * visible `[data-pen-marks]` overlay + capture (`overlay.drawn` tells the
   * caller to run REMOVE_MARKS_JS). Returns the image and mark count, or an
   * `{ error }` result. */
  private async captureAnnotated(
    page: BrowserPageHandle,
    snapshotId: string,
    cursorHidden: boolean,
    overlay: { drawn: boolean },
  ): Promise<{ captured: { imageData: string; width: number; height: number } | null; marked: number } | { error: string }> {
    const composed = await this.captureComposedMarks(page, snapshotId, cursorHidden);
    if (composed) return composed;
    overlay.drawn = true;
    // MARKS_JS's own result is checked: a failed overlay must not produce a
    // mark-less screenshot with no indication why.
    const marksResult = await this.executeScript(page, "MARKS_JS", { snapshotId });
    if ("error" in marksResult) return { error: String(marksResult.error) };
    const marked = isRecord(marksResult) && typeof marksResult.marked === "number" ? marksResult.marked : 0;
    // Capturing right after MARKS_JS can miss the overlay: wait for a paint
    // (double rAF raced against a timeout — a hidden view never fires rAF).
    await this.waitForPaint(page);
    return { captured: await this.captureImage(page), marked };
  }

  /** The compose path of `captureAnnotated`; `null` on ANY failure. Never
   * throws, never runs compose in the page's main world. */
  private async captureComposedMarks(
    page: BrowserPageHandle,
    snapshotId: string,
    cursorHidden: boolean,
  ): Promise<{ captured: { imageData: string; width: number; height: number }; marked: number } | null> {
    if (!page.executeJavaScriptIsolated || !(page.capture || this.isEmulated(page))) return null;
    try {
      const layout = await this.executeScript(page, "MARKS_JS", { snapshotId, draw: false });
      if (
        "error" in layout ||
        !Array.isArray(layout.marks) ||
        typeof layout.viewportWidth !== "number" ||
        !(layout.viewportWidth > 0)
      ) {
        return null;
      }
      if (cursorHidden) await this.waitForPaint(page);
      const clean = await this.captureImage(page);
      if (!clean || !clean.imageData) return null;
      const code = COMPOSE_MARKS_JS.replace(ARGS_MARKER, () =>
        JSON.stringify({
          imageData: clean.imageData,
          marks: layout.marks,
          viewportWidth: layout.viewportWidth,
          viewportHeight: typeof layout.viewportHeight === "number" ? layout.viewportHeight : 0,
        }),
      );
      const out = await withTimeout(page.executeJavaScriptIsolated(code), COMPOSE_MARKS_TIMEOUT_MS, "Mark compose timed out.");
      if (
        !isRecord(out) ||
        "error" in out ||
        typeof out.imageData !== "string" ||
        !out.imageData.startsWith("data:image/") ||
        typeof out.width !== "number" ||
        typeof out.height !== "number"
      ) {
        return null;
      }
      return { captured: { imageData: out.imageData, width: out.width, height: out.height }, marked: layout.marks.length };
    } catch {
      return null;
    }
  }

  /** Full browser use: a downscaled JPEG of the current viewport —
   * `page.capture()` (window.ts: `webContents.capturePage()` → resize to
   * ≤1280px wide → `toJPEG(70)`).
   *
   * `annotate: true` marks the elements of a snapshot with numbered labels
   * ("set of marks"). The user never sees them: MARKS_JS lays them out with
   * `draw:false` (no DOM change), the CLEAN page is captured, and
   * COMPOSE_MARKS_JS paints the marks onto the image in a detached canvas.
   * Only if that fails does it fall back to drawing the visible
   * `[data-pen-marks]` DOM overlay, capturing, and always removing the overlay
   * in `finally`, so a failed capture never leaves marks on the page.
   * - Without `snapshotId`: takes a FRESH snapshot first; its id becomes the
   *   one `perform`/`act` accept next.
   * - With `snapshotId` (reuse path): marks that existing snapshot without
   *   re-snapshotting, so the loop's own snapshot stays valid. Staleness is
   *   decided only by `checkSnapshotStale` (unknown/superseded id or changed
   *   page → `{ error }`, nothing captured). `lastSnapshot` is never
   *   replaced or cleared. MARKS_JS covers only the top document and
   *   viewport-visible elements, so a current snapshot may legitimately mark
   *   0 — the image is still returned; `marked` reports the count.
   *
   * An empty capture (`capture()` returning null) is an `{ error }`, not a
   * blank image. */
  async screenshot(args: unknown): Promise<BrowserCommandResult> {
    return this.runExclusive(() => this.screenshotUnlocked(args));
  }

  /** The page carries an emulation of the active fixture and can take a CDP screenshot. */
  private isEmulated(page: BrowserPageHandle): boolean {
    return page.sendCdp !== undefined && this.emulationOf(page) !== undefined;
  }

  /**
   * One screenshot of `page`. While an emulation is active on the page, `Page.captureScreenshot`
   * (JPEG, quality 70, at most 1280 px wide, a `data:image/jpeg;base64,` URL like `capture()`) replaces `page.capture()`:
   * Electron's `capturePage` captures the view, not the emulated viewport. A CDP failure falls back
   * to `capture()`.
   */
  private async captureImage(page: BrowserPageHandle): Promise<{ imageData: string; width: number; height: number } | null> {
    const emulate = this.emulationOf(page);
    if (page.sendCdp && emulate) {
      try {
        const shot = await this.captureEmulated(page, emulate);
        if (shot) return shot;
      } catch {
        // fall through to the plain capture
      }
    }
    return (await page.capture?.()) ?? null;
  }

  private async captureEmulated(page: BrowserPageHandle, emulate: FixtureEmulate): Promise<{ imageData: string; width: number; height: number } | null> {
    const metrics = resolveEmulation(emulate).metrics;
    let width = metrics?.width;
    let height = metrics?.height;
    let dpr = metrics?.deviceScaleFactor;
    // `clip` is document-relative: start at the visible viewport (the scroll offset), not at the document origin.
    let originX = 0;
    let originY = 0;
    try {
      const layout: unknown = await page.sendCdp!("Page.getLayoutMetrics", {});
      const vv = isRecord(layout) && isRecord(layout.cssVisualViewport) ? layout.cssVisualViewport : undefined;
      if (vv) {
        if (typeof vv.pageX === "number" && Number.isFinite(vv.pageX)) originX = Math.max(0, vv.pageX);
        if (typeof vv.pageY === "number" && Number.isFinite(vv.pageY)) originY = Math.max(0, vv.pageY);
        // The size comes from the real visual viewport, not from the emulated metrics: a mobile page without
        // a meta viewport lays out at 980 px while the emulated width is 390, and the clip must cover it all.
        if (typeof vv.clientWidth === "number" && vv.clientWidth > 0) width = vv.clientWidth;
        if (typeof vv.clientHeight === "number" && vv.clientHeight > 0) height = vv.clientHeight;
      }
    } catch {
      // keep the document origin
    }
    if (width === undefined || height === undefined || dpr === undefined) {
      // No viewport override (only locale, colour scheme, ...): read the real viewport.
      const read = await readViewportSize(page);
      width ??= read?.width ?? 1280;
      height ??= read?.height ?? 800;
      dpr = read?.dpr ?? 1;
    }
    const outWidth = Math.min(width, EMULATED_SCREENSHOT_MAX_WIDTH);
    const ratio = outWidth / width;
    const raw = await page.sendCdp!("Page.captureScreenshot", {
      format: "jpeg",
      quality: 70,
      // The output is css size * DPR * scale: scale cancels the DPR so the image is css-sized, then caps the width.
      clip: { x: originX, y: originY, width, height, scale: ratio / dpr },
    });
    const data = isRecord(raw) && typeof raw.data === "string" ? raw.data : "";
    if (!data) return null;
    return { imageData: `data:image/jpeg;base64,${data}`, width: Math.round(outWidth), height: Math.round(height * ratio) };
  }

  private async screenshotUnlocked(args: unknown): Promise<BrowserCommandResult> {
    const validated = validateScreenshotArgs(args);
    if (!validated.ok) return errorResult(validated.error);
    const { annotate, snapshotId: givenSnapshotId } = validated.value;
    return this.withCommandTimeout(async () => {
      const page = this.target.currentPage();
      if (!page) return errorResult("No browser tab is open — call browse_open first.");
      if (!page.capture && !this.isEmulated(page)) return errorResult("Screenshot is not supported by this browser tab.");
      // Reusing the caller's snapshot: refuse a stale one BEFORE touching the
      // page. Read-only — `lastSnapshot` is neither replaced nor cleared.
      if (givenSnapshotId !== undefined) {
        const stale = this.checkSnapshotStale(givenSnapshotId, page);
        if (stale) return stale;
      }

      // The agent cursor's effects (glow, trail, ripple) must not show up in
      // a screenshot: hide the whole overlay root for the capture, restore
      // after. Skipped entirely when the cursor is disabled for this command;
      // best effort, never throws. A paint wait follows only when the overlay
      // really changed (and, with annotate, one wait covers the marks too).
      let cursorHidden = false;
      const hideCursor = async (): Promise<void> => {
        if (!this.cursorEnabled) return;
        try {
          const vis = await this.executeScript(page, "CURSOR_VISIBILITY_JS", { hidden: true });
          cursorHidden = isRecord(vis) && vis.changed === true;
        } catch {
          // cosmetic only
        }
      };
      const restoreCursor = async (): Promise<void> => {
        if (!cursorHidden) return;
        try {
          await this.executeScript(page, "CURSOR_VISIBILITY_JS", { hidden: false });
        } catch {
          // best effort — the next cursor move's show() clears it too
        }
      };

      let snapshotId: string | undefined;
      let elements: unknown;
      // Set when the visible DOM overlay was (attempted to be) drawn.
      const overlay = { drawn: false };
      let marked = 0;
      // One cleanup for every path (early error returns included): restore
      // the cursor, then remove the marks overlay if MARKS_JS drew it.
      try {
        let captured: { imageData: string; width: number; height: number } | null;
        if (annotate) {
          if (givenSnapshotId !== undefined) {
            snapshotId = givenSnapshotId;
          } else {
            const snap = await this.takeSnapshot(page);
            if ("error" in snap) return snap;
            snapshotId = snap.snapshotId as string;
            elements = snap.elements;
          }
          await hideCursor();
          const annotated = await this.captureAnnotated(page, snapshotId, cursorHidden, overlay);
          if ("error" in annotated) return errorResult(annotated.error);
          captured = annotated.captured;
          marked = annotated.marked;
        } else {
          await hideCursor();
          if (cursorHidden) await this.waitForPaint(page);
          captured = await this.captureImage(page);
        }
        if (!captured || !captured.imageData) {
          return errorResult("Screenshot capture failed (empty image).");
        }
        const result: BrowserCommandResult = {
          imageData: captured.imageData,
          width: captured.width,
          height: captured.height,
          url: page.getURL(),
          title: page.getTitle(),
        };
        if (annotate) {
          result.snapshotId = snapshotId;
          result.marked = marked;
          if (elements !== undefined) result.elements = elements;
        }
        return result;
      } finally {
        await restoreCursor();
        if (overlay.drawn) {
          try {
            await this.executeScript(page, "REMOVE_MARKS_JS", {});
          } catch {
            // Best-effort cleanup — must never mask the capture's outcome.
          }
        }
      }
    });
  }

  /** Full browser use's `tabs` command — lists/switches/closes/opens browser
   * tabs. Reports "not supported" up front when the injected `BrowserTarget`
   * doesn't implement the four optional methods this needs (window.ts
   * always implements all four together, but the unit-test fakes and any
   * future embedder might not). */
  async tabs(args: unknown): Promise<BrowserCommandResult> {
    return this.runExclusive(() => this.tabsUnlocked(args));
  }

  private async tabsUnlocked(args: unknown): Promise<BrowserCommandResult> {
    const validated = validateTabsArgs(args);
    if (!validated.ok) return errorResult(validated.error);
    const { action, tabId, url } = validated.value;
    if (!this.target.listPages || !this.target.selectPage || !this.target.closePage || !this.target.newPage) {
      return errorResult("Tab management is not supported by this browser build.");
    }
    // "new" with a url delegates to open() below (review finding 9), which
    // needs its own longer openTimeoutMs budget (BROWSER_OPEN_TIMEOUT_MS) —
    // the default command timeout would otherwise cut a slow page's
    // DOM-ready wait short before open()'s own grace period ever gets a
    // chance to run.
    //
    // Second-pass review finding 6: this outer command starts its own
    // withTimeout clock *before* `newPage()` runs, while the nested
    // `this.open()` call below starts its own (separately budgeted at the
    // same `this.openTimeoutMs`) only after `newPage()` has resolved — so the
    // outer timer's deadline was always strictly earlier than the inner
    // one's, and the outer timeout fired first, on every slow `open`,
    // producing a bare "Browser command timed out" with no tab listing at
    // all instead of `open()`'s own more specific timeout (which at least
    // still runs `listTabsResult()` afterward). Padding the outer budget by
    // OPEN_COMMAND_MARGIN_MS — comfortably more than `newPage()` (an
    // in-process tab creation, not a network wait) could ever take — ensures
    // the inner `open()` timeout always resolves first.
    const budgetMs = action === "new" && url ? this.openTimeoutMs + OPEN_COMMAND_MARGIN_MS : undefined;
    return this.withCommandTimeout(async () => {
      if (action === "list") return this.listTabsResult();
      if (action === "new") {
        // Review finding 9: `newPage` itself only creates the tab and makes
        // it current — it used to also `await`s a full `loadURL()` (the same
        // `did-finish-load` wait `open()` deliberately avoids for a heavy
        // page), so `tabs({action:"new", url})` blocked for as long as the
        // whole page took to finish loading instead of `open()`'s
        // DOM-ready-plus-grace-period compromise. `newPage()` now never
        // takes a url; loading one, when given, reuses `open()` outright —
        // same DOM-ready race, same grace period, same `{ loaded }` field.
        await this.target.newPage!();
        if (!url) return this.listTabsResult();
        // `openUnlocked`, not the public `open` — see `runExclusive`'s doc
        // comment: this call is already running inside the queue, from
        // `tabs`'s own turn, and calling back into `open` would deadlock.
        const openResult = await this.openUnlocked({ url });
        const tabsResult = await this.listTabsResult();
        // On open failure the tab still exists (newPage() already created
        // it) — report the error alongside the tab listing so the caller
        // can see the new (empty) tab instead of retrying `new` into a
        // duplicate tab.
        return "error" in openResult ? { ...tabsResult, error: openResult.error } : { ...tabsResult, ...openResult };
      }
      if (action === "switch") {
        const ok = await this.target.selectPage!(tabId!);
        if (!ok) return errorResult(`No browser tab with id ${tabId}.`);
        return this.listTabsResult();
      }
      // close
      const ok = await this.target.closePage!(tabId!);
      if (!ok) return errorResult(`No browser tab with id ${tabId} to close, or it is not a browser tab.`);
      return this.listTabsResult();
    }, budgetMs, this.journal && action !== "list" ? { op: "nav" } : undefined);
  }

  private async listTabsResult(): Promise<BrowserCommandResult> {
    const pages = await this.target.listPages!();
    const tabsOut = pages.map((p) => ({ tabId: p.tabId, url: p.url, title: p.title, current: p.current }));
    const current = pages.find((p) => p.current)?.tabId ?? null;
    return { tabs: tabsOut, current };
  }

  /** Best-effort tab listing used by `detectOpenedTab` — never throws, and
   * returns `[]` when the injected `BrowserTarget` doesn't implement
   * `listPages` at all (every unit-test fake, notably), so a click's own
   * result is never broken by openedTab detection being unavailable. */
  private async listPagesSafe(): Promise<BrowserTabInfo[]> {
    if (!this.target.listPages) return [];
    try {
      return await this.target.listPages();
    } catch {
      return [];
    }
  }

  /** Full browser use, fixing upstream jev-ultrafast #61 ("the agent sticks
   * to the old tab"): diffs a tab listing taken before a click-like action
   * against one taken after, and reports the first genuinely new tab id (if
   * any) as `openedTab` — the agent's current tab has already followed a
   * popup (window.ts's attachBrowserTabPolicy sets `agentBrowserTabId` to
   * it), so this is purely informational, telling the caller a new tab
   * exists rather than silently leaving it undiscovered. */
  private async detectOpenedTab(
    before: BrowserTabInfo[],
  ): Promise<{ tabId: number; url: string; title: string } | undefined> {
    const after = await this.listPagesSafe();
    if (after.length <= before.length) return undefined;
    const beforeIds = new Set(before.map((p) => p.tabId));
    const opened = after.find((p) => !beforeIds.has(p.tabId));
    if (!opened) return undefined;
    return { tabId: opened.tabId, url: opened.url, title: opened.title };
  }

  /** `detectOpenedTab` for the command RESULT. A popup is listed the moment
   * it is created, before its first navigation lands, so one listing can
   * report `url: ""` (title "New Tab") and the agent gets a tab it cannot
   * tell apart. Re-list it briefly (up to OPENED_TAB_URL_WAIT_MS) until the
   * url is known. The settle predicate keeps using the plain, instant
   * `detectOpenedTab`: it only needs to know that a tab appeared. */
  private async resolveOpenedTab(
    before: BrowserTabInfo[],
    deadlineAt?: number,
  ): Promise<{ tabId: number; url: string; title: string } | undefined> {
    let opened = await this.detectOpenedTab(before);
    if (!opened) return undefined;
    // Never eat into the command's own budget: a late result is a timeout
    // the agent may answer by clicking (and opening a popup) again.
    let waitUntil = Date.now() + OPENED_TAB_URL_WAIT_MS;
    if (deadlineAt !== undefined) waitUntil = Math.min(waitUntil, deadlineAt - SETTLE_HEADROOM_MS);
    while ((!opened.url || opened.url === "about:blank") && Date.now() < waitUntil) {
      await new Promise((resolve) => setTimeout(resolve, OPENED_TAB_URL_POLL_MS));
      const tabId: number = opened.tabId;
      const again = (await this.listPagesSafe()).find((p) => p.tabId === tabId);
      // The popup closed itself (an OAuth/payment window): there is no tab
      // left to report.
      if (!again) return undefined;
      opened = { tabId: again.tabId, url: again.url, title: again.title };
    }
    return opened;
  }

  /** Acts by index against the elements table from the caller's most recent
   * snapshot() — see validatePerformArgs and lastSnapshot's doc comment for
   * the staleness/cross-tab guard. CLICK reuses the same post-click settle
   * wait as browse_act's click (runClick above). */
  async perform(args: unknown): Promise<BrowserCommandResult> {
    return this.runExclusive(async () => {
      this.relocatedThisCommand = false;
      const result = this.withRelocated(await this.performUnlocked(args));
      // Wave 3 reliability, item 3: see act()'s identical call for why this
      // only ever runs once, at the outermost public entry point.
      return this.mergeDiagnostics(result, this.target.currentPage());
    });
  }

  /**
   * QA diagnostics, section 2: deterministic page checks (`QaCheck`, see agent/qaChecks.ts).
   * Runs under the command lock like `perform`. Read-only: no journal entry, no scroll, no
   * click. `args.checks` is the array `parseQaChecks` accepts; `args.snapshotId` (optional)
   * names the snapshot an `index` belongs to, else the current one is used. Resolves to
   * `{ ok: true, passed, results, consoleErrors?, failedRequests? }` (one result per check);
   * a bad `checks` array or a missing tab is `{ error }`. A failed check is a normal result.
   * `no_console_errors` and `no_failed_requests` see what THIS call drains; the agent layer
   * adds the history of the run.
   */
  async assert(args: unknown): Promise<BrowserCommandResult> {
    return this.runExclusive(() => this.assertUnlocked(args));
  }

  private async assertUnlocked(args: unknown): Promise<BrowserCommandResult> {
    if (!isRecord(args)) return errorResult('assert requires an object with "checks".');
    const parsed = parseQaChecks(args.checks);
    if (!parsed.ok) return errorResult(`assert: ${parsed.errors.join("; ")}`);
    const checks = parsed.value;
    if (args.snapshotId !== undefined && (typeof args.snapshotId !== "string" || args.snapshotId.trim() === "")) {
      return errorResult('assert requires "snapshotId" to be a non-empty string when provided.');
    }
    const givenSnapshotId = typeof args.snapshotId === "string" ? args.snapshotId : undefined;
    return this.withCommandTimeout(async () => {
      const page = this.target.currentPage();
      if (!page) return errorResult("No browser tab is open — call browse_open first.");
      const results: QaCheckResult[] = checks.map((check) => ({ check, passed: true }));
      // The checks that go to the page. An index check that cannot be resolved is answered here.
      const domIndexes: number[] = [];
      const snapshotId = givenSnapshotId ?? this.lastSnapshot?.id;
      const fingerprints: Record<string, unknown> = {};
      let snapshotError: string | undefined;
      checks.forEach((check, i) => {
        if (check.type === "text" || check.type === "count") return void domIndexes.push(i);
        if (check.type !== "element" && check.type !== "value") return;
        if (check.selector !== undefined || check.index === undefined) return void domIndexes.push(i);
        if (snapshotId === undefined) snapshotError = "No snapshot yet: call browse_snapshot before a check by index.";
        else if (snapshotError === undefined) snapshotError = (this.checkSnapshotStale(snapshotId, page) as { error?: string } | null)?.error;
        if (snapshotError !== undefined) {
          results[i] = { check, passed: false, error: snapshotError };
          return;
        }
        const route = this.lastSnapshot?.frameMap.get(check.index);
        if (route && route.frameId !== null) {
          results[i] = { check, passed: false, error: `Element ${check.index} is inside a frame; assert reads the top document only.` };
          return;
        }
        const fingerprint = this.lastSnapshot?.fingerprints.get(check.index);
        if (fingerprint) fingerprints[String(check.index)] = fingerprint;
        domIndexes.push(i);
      });
      if (domIndexes.length > 0) {
        let script: BrowserCommandResult;
        try {
          script = await this.executeScript(page, "ASSERT_JS", {
            checks: domIndexes.map((i) => checks[i]),
            ...(snapshotId !== undefined ? { snapshotId } : {}),
            fingerprints,
          });
        } catch (err) {
          script = errorResult(toMessage(err));
        }
        const answers = Array.isArray(script.results) ? (script.results as unknown[]) : undefined;
        domIndexes.forEach((checkIndex, k) => {
          const check = checks[checkIndex]!;
          const a = answers?.[k];
          if (isRecord(a)) {
            results[checkIndex] = {
              check,
              passed: a.passed === true,
              ...(typeof a.actual === "string" ? { actual: a.actual } : {}),
              ...(typeof a.error === "string" ? { error: a.error } : {}),
            };
          } else {
            results[checkIndex] = { check, passed: false, error: typeof script.error === "string" ? script.error : "The page did not answer the check." };
          }
        });
      }
      checks.forEach((check, i) => {
        if (check.type !== "url") return;
        const url = page.getURL();
        let passed = true;
        if (check.equals !== undefined && url !== check.equals) passed = false;
        if (check.contains !== undefined && !url.includes(check.contains)) passed = false;
        if (check.matches !== undefined) {
          try {
            if (!new RegExp(check.matches).test(url)) passed = false;
          } catch {
            results[i] = { check, passed: false, error: "matches: not a valid regular expression" };
            return;
          }
        }
        // The URL may hold a secret in its query or hash: report origin + pathname only.
        results[i] = passed ? { check, passed } : { check, passed, actual: `url ${redactUrl(url)}` };
      });
      // Same drain as act/perform: deduped, the last 20, with dropped counters.
      const diagnostics = this.drainDiagnostics(page);
      // The two history checks: evaluated here on what this call drained (the agent layer adds the run history).
      const evaluated = evaluateQaChecks({ results, consoleErrors: diagnostics.consoleErrors, failedRequests: diagnostics.failedRequests }, checks);
      const finalResults = evaluated.ok ? evaluated.results : results;
      return {
        ok: true,
        passed: finalResults.every((r) => r.passed),
        results: finalResults,
        ...diagnostics,
      };
    });
  }

  private drainList(drain: () => string[] | undefined): string[] {
    try {
      return drain() ?? [];
    } catch {
      return [];
    }
  }

  private async performUnlocked(args: unknown): Promise<BrowserCommandResult> {
    const validated = validatePerformArgs(args);
    if (!validated.ok) return errorResult(validated.error);
    const { index, operation, text, snapshotId } = validated.value;

    // Resolved before the staleness check (not inside withCommandTimeout)
    // so the check can compare it against the page snapshot() actually ran
    // against — see lastSnapshot's doc comment / finding 5.
    const page = this.target.currentPage();
    if (!page) return errorResult("No browser tab is open — call browse_open first.");

    const staleError = this.checkSnapshotStale(snapshotId, page);
    if (staleError) return staleError;

    // Wave 3 reliability, item 2: look up which document `index` actually
    // lives in (the top page, or a specific child frame) once, up front —
    // every branch below needs it. `cursorPoint` is a best-effort top-level-
    // viewport point for the overlay (see moveCursor's `point` doc comment)
    // when the element is frame-routed; the overlay itself is unchanged and
    // still always runs before the action, per the hard constraint.
    const { frameRoute, cursorPoint } = this.resolveFrameRouteWithCursorPoint(index);

    const journalOp = operation === "CLICK" ? "click" : operation === "TYPE_TEXT" ? "type" : operation === "SELECT" ? "select" : undefined;
    const journalAction: JournalDeclare | undefined =
      this.journal && journalOp ? { op: journalOp, locate: { index, snapshotId }, frameId: frameRoute.frameId, text, optionText: text } : undefined;

    return this.withCommandTimeout(async (deadlineAt) => {
      if (operation === "CLICK") {
        const previousUrl = page.getURL();
        // Full browser use: same openedTab detection as runClick — an
        // index-based click ("index click" in the design doc's item 4) gets
        // the same treatment as a target-based one.
        const tabsBefore = await this.listPagesSafe();
        // Before the before-signature capture — see runClick's comment.
        const reveal =
          frameRoute.frameId === null
            ? await this.revealTarget(page, { index, snapshotId }, "CLICK")
            : { dismissDialog: false, error: undefined };
        if (reveal.error) return errorResult(reveal.error);
        const dismissDialog = reveal.dismissDialog;
        await this.moveCursor(page, { action: "click", snapshotId, index, point: cursorPoint });
        const before = await this.captureSignature(page, "before");
        // Armed/captured before the click runs — see runClick's comment.
        const navWatcher = this.armNavigationWatcher(page, previousUrl);
        const networkBaseline = this.captureNetworkBaseline(page);
        // Wave 2 reliability item 1: trusted CDP click, falling back to
        // PERFORM_JS's CLICK branch internally — see dispatchClick. Wave 3
        // reliability item 2: an element routed to a child frame skips the
        // trusted-CDP path outright (the design doc's own sanctioned
        // fallback — "if hit-test inside the frame fails fall back to DOM
        // click via frame.executeJavaScript") and runs the DOM click path
        // directly inside that frame.
        const result =
          frameRoute.frameId === null
            ? await this.dispatchClick(page, { index, snapshotId })
            : await this.frameClickOrType(page, frameRoute.frameId, "CLICK", frameRoute.localIndex, snapshotId, deadlineAt);
        if ("error" in result) {
          navWatcher.dispose();
          return result;
        }
        const scopedBefore = extractScopedBefore(result);
        const selfDisabled = extractTargetSelfDisabled(result);
        await this.settleAfterClick(page, navWatcher, networkBaseline);
        if (selfDisabled) {
          await this.settleWhileTargetBusy(page);
          // See runClick: the navigation can start after the busy wait.
          await this.waitForLoadStop(page, CLICK_LOAD_SETTLE_TIMEOUT_MS);
        }
        const dialogClosed = dismissDialog && (await this.settleDialogDismiss(page, deadlineAt));
        const evidence = await this.captureClickEffect(page, before, previousUrl, scopedBefore, deadlineAt, dialogClosed, async () =>
      (await this.detectOpenedTab(tabsBefore)) !== undefined,
    );
        const currentUrl = page.getURL();
        const openedTab = await this.resolveOpenedTab(tabsBefore, deadlineAt);
        const merged: BrowserCommandResult = {
          ...result,
          url: currentUrl,
          title: page.getTitle(),
          ...evidence,
        };
        if (openedTab) merged.openedTab = openedTab;
        return merged;
      }

      if (operation === "TYPE_TEXT") {
        // Before the before-signature capture — see runClick's comment.
        if (frameRoute.frameId === null) {
          const reveal = await this.revealTarget(page, { index, snapshotId }, "TYPE_TEXT");
          if (reveal.error) return errorResult(reveal.error);
        }
        await this.moveCursor(page, { action: "type", snapshotId, index, point: cursorPoint });
        const before = await this.captureSignature(page, "before");
        // Wave 2 reliability item 2: trusted CDP typing, falling back to
        // PERFORM_JS's TYPE_TEXT branch internally — see dispatchType. Wave 3
        // reliability item 2: same frame-routing skip-trusted-CDP rule as
        // CLICK above.
        const baseline = this.autocompleteBaseline(page, frameRoute.frameId);
        try {
          let result: BrowserCommandResult;
          if (frameRoute.frameId === null) {
            result = await this.dispatchType(page, { index, snapshotId }, text!, deadlineAt, baseline);
          } else {
            await baseline.take();
            result = await this.frameClickOrType(page, frameRoute.frameId, "TYPE_TEXT", frameRoute.localIndex, snapshotId, deadlineAt, text);
          }
          if ("error" in result && !extractSliderPartial(result)) return result;
          const scopedBefore = extractScopedBefore(result);
          const selfDisabled = extractTargetSelfDisabled(result);
          await this.settleShort();
          await this.settleAutocomplete(page, frameRoute.frameId, deadlineAt, baseline);
          if (selfDisabled) await this.settleWhileTargetBusy(page);
          const after = await this.captureSignature(page, "after");
          return { ...result, ...this.diffSignatures(before, after, { scopedBefore }) };
        } finally {
          await baseline.release();
        }
      }

      // Review finding 3: SELECT/SCROLL_UP/SCROLL_DOWN get a short settle
      // before the after-capture too — see NON_CLICK_SETTLE_MS.
      // Before the before-signature capture — see runClick's comment.
      const cursorAction: "select" | "scroll" = operation === "SELECT" ? "select" : "scroll";
      await this.moveCursor(page, { action: cursorAction, snapshotId, index, point: cursorPoint });
      const before = await this.captureSignature(page, "before");
      // Wave 3 reliability, item 2: SELECT/SCROLL_* routed to a child frame
      // run PERFORM_JS inside that frame directly — there is no trusted-CDP
      // path for either operation even at the top level (see act's own
      // doc comment on `select`/`scroll`), so this is a plain routing
      // choice, not a fallback.
      const result =
        frameRoute.frameId === null
          ? await this.executeScript(page, "PERFORM_JS", { snapshotId, index, operation, text })
          : await this.executeScriptInFrame(page, frameRoute.frameId, "PERFORM_JS", {
              snapshotId,
              index: frameRoute.localIndex,
              operation,
              text,
            });
      if ("error" in result) return result;
      const scopedBefore = extractScopedBefore(result);
      const selfDisabled = extractTargetSelfDisabled(result);
      await this.settleShort();
      if (selfDisabled) await this.settleWhileTargetBusy(page);
      const after = await this.captureSignature(page, "after");
      return { ...result, ...this.diffSignatures(before, after, { scopedBefore }) };
    }, this.timeoutMs + this.cursorBudgetMs, journalAction);
  }

  /** Wraps a page-script call with a before/after page-signature
   * diff merged into a successful result as `{ changed, changes }` —
   * "Addendum 2" §1. Used by act's `scroll` (click has its own variant
   * inlined in runClick, since it also needs the click-settle wait in
   * between the two captures; `type` has its own variant too —
   * `runTypeWithEvidence` below — since Wave 2 reliability gave it a
   * trusted-CDP path with its own DOM fallback, not a single script call).
   *
   * Review finding 3: a short settle (NON_CLICK_SETTLE_MS) now runs between
   * the action and the after-capture — scroll used to capture "after"
   * immediately, with no settle at all.
   *
   * Code review finding 6: an index-based `scroll` now resolves and routes
   * through the same frame map CLICK/TYPE_TEXT/SELECT already do
   * (`resolveFrameRouteWithCursorPoint`) — it used to always run SCROLL_JS
   * against the top document, so an index that actually lived inside a
   * child frame (one of `SNAPSHOT_JS`'s frame-sourced entries) failed with
   * "No element matched: index N" instead of scrolling anything. */
  private async runOnPageWithEvidence(
    script: "SCROLL_JS",
    scriptArgs: Record<string, unknown> & { index?: number },
  ): Promise<BrowserCommandResult> {
    const page = this.target.currentPage();
    if (!page) return errorResult("No browser tab is open — call browse_open first.");
    const { frameRoute } = this.resolveFrameRouteWithCursorPoint(scriptArgs.index);
    // Before the before-signature capture — see runClick's comment /
    // CURSOR_JS's doc comment for why. CURSOR_JS itself short-circuits for
    // "scroll" before ever looking at target/index/point, so there is
    // nothing frame-specific to pass here even for a frame-routed scroll.
    await this.moveCursor(page, { action: "scroll" });
    const before = await this.captureSignature(page, "before");
    const result =
      frameRoute.frameId === null
        ? await this.executeScript(page, script, scriptArgs)
        : await this.executeScriptInFrame(page, frameRoute.frameId, script, { ...scriptArgs, index: frameRoute.localIndex });
    if ("error" in result) return result;
    const scopedBefore = extractScopedBefore(result);
    const selfDisabled = extractTargetSelfDisabled(result);
    await this.settleShort();
    if (selfDisabled) await this.settleWhileTargetBusy(page);
    const after = await this.captureSignature(page, "after");
    return { ...result, ...this.diffSignatures(before, after, { scopedBefore }) };
  }

  /** `act`'s target-based `type` — Wave 2 reliability item 2's trusted CDP
   * typing (`dispatchType`, which already has its own DOM fallback baked
   * in), wrapped with the same before/after evidence capture
   * `runOnPageWithEvidence` gives `scroll`. Kept separate from
   * `runOnPageWithEvidence` because `dispatchType` takes a locate-args
   * object plus `text`, not a single script name — the two no longer share
   * a call shape now that `type` can run two different scripts internally
   * (CLICK_RESOLVE_JS then either the trusted-input path or TYPE_JS). */
  private async runTypeWithEvidence(
    locateArgs: { target?: string; index?: number; snapshotId?: string },
    text: string,
    deadlineAt: number,
  ): Promise<BrowserCommandResult> {
    const page = this.target.currentPage();
    if (!page) return errorResult("No browser tab is open — call browse_open first.");
    const reveal = await this.revealTarget(page, locateArgs, "TYPE_TEXT", deadlineAt);
    if (reveal.error) return errorResult(reveal.error);
    await this.moveCursor(page, { action: "type", target: locateArgs.target, index: locateArgs.index, snapshotId: locateArgs.snapshotId });
    const before = await this.captureSignature(page, "before");
    const baseline = this.autocompleteBaseline(page, null);
    try {
      const result = await this.dispatchType(page, locateArgs, text, deadlineAt, baseline);
      if ("error" in result && !extractSliderPartial(result)) return result;
      const scopedBefore = extractScopedBefore(result);
      const selfDisabled = extractTargetSelfDisabled(result);
      await this.settleShort();
      await this.settleAutocomplete(page, null, deadlineAt, baseline);
      if (selfDisabled) await this.settleWhileTargetBusy(page);
      const after = await this.captureSignature(page, "after");
      return { ...result, ...this.diffSignatures(before, after, { scopedBefore }) };
    } finally {
      await baseline.release();
    }
  }

  /** A one-shot "what options are visible right now" recorder for
   * settleAutocomplete: `take()` (idempotent) runs AUTOCOMPLETE_STATE_JS's
   * stamp-free `baseline` probe, document-wide, and keeps `docOptions:docHash`
   * — or null when no option was visible (current behaviour) or the probe
   * failed. The type paths call it after focus has settled and before the
   * text goes in, so a focus-time list ("popular destinations") is what gets
   * recorded. */
  private autocompleteBaseline(page: BrowserPageHandle, frameId: number | null): AutocompleteBaseline {
    const baseline: AutocompleteBaseline = {
      key: null,
      ownKey: null,
      plain: false,
      netGen: null,
      taken: false,
      take: async () => {
        if (baseline.taken) return;
        baseline.taken = true;
        try {
          const state =
            frameId === null
              ? await this.executeScript(page, "AUTOCOMPLETE_STATE_JS", { baseline: true })
              : await this.executeScriptInFrame(page, frameId, "AUTOCOMPLETE_STATE_JS", { baseline: true });
          if (!("error" in state) && typeof state.docOptions === "number" && state.docOptions > 0) {
            baseline.key = `${state.docOptions}:${String(state.docHash)}`;
          }
          if (!("error" in state) && typeof state.ownOptions === "number" && state.ownOptions > 0) {
            baseline.ownKey = `${state.ownOptions}:${String(state.ownHash)}`;
          }
          if (!("error" in state) && state.plain === true && frameId === null) {
            // Plain text field: remember what typing starts from, so a later
            // network request or DOM mutation can be told apart from noise.
            baseline.plain = true;
            baseline.netGen = page.networkStats?.(NETWORK_REQUEST_DROP_MS).generation ?? null;
            await this.executeScript(page, "SUGGEST_ACTIVITY_JS", { action: "install" });
          }
        } catch {
          // Best-effort: no baseline ⇒ the plain "stable across two polls" rule.
        }
      },
      release: async () => {
        if (!baseline.plain || frameId !== null) return;
        baseline.plain = false;
        try {
          await this.executeScript(page, "SUGGEST_ACTIVITY_JS", { action: "uninstall" });
        } catch {
          // Best-effort.
        }
      },
    };
    return baseline;
  }

  /** Waits for an autocomplete field's suggestions after a successful type —
   * see AUTOCOMPLETE_SETTLE_MS. Probes the stamped target
   * (`AUTOCOMPLETE_STATE_JS`; after "typing follows the focus" that is the
   * field the text actually landed in) and returns at once for anything that
   * is not autocomplete-style. Otherwise polls until the visible option
   * count + label hash is non-zero and equal across two consecutive polls —
   * one poll can still be the stale pre-typing list, two equal ones with
   * the debounce elapsed rarely are — and, when `baseline` saw options
   * before the text went in, until the document-wide options digest also
   * differs from that baseline (a stale focus-time list is perfectly stable,
   * so stability alone would end the wait ~150 ms in). A list that never
   * changes from the baseline (the suggestions really equal it) waits out the
   * cap. Best-effort: a throwing or malformed script, the cap, or the command
   * deadline (minus SETTLE_HEADROOM_MS, skipped when already past it) just
   * ends the wait (the type itself already succeeded), and nothing is added
   * to the result. */
  private async settleAutocomplete(
    page: BrowserPageHandle,
    frameId: number | null,
    deadlineAt: number,
    baseline?: AutocompleteBaseline,
  ): Promise<void> {
    const start = Date.now();
    const plainField = frameId === null && baseline?.plain === true;
    // A plain field (no ARIA hints) only waits when typing set something in
    // motion, and under a tighter cap (PLAIN_SUGGEST_MAX_MS).
    const until = Math.min(start + (plainField ? PLAIN_SUGGEST_MAX_MS : AUTOCOMPLETE_SETTLE_MS), deadlineAt - SETTLE_HEADROOM_MS);
    if (Date.now() >= until) return;
    let previous: string | null = null;
    let activitySeen = false;
    let lastActiveAt = start;
    let lastGen = baseline?.netGen ?? null;
    while (true) {
      let state: BrowserCommandResult;
      try {
        state =
          frameId === null
            ? await this.executeScript(page, "AUTOCOMPLETE_STATE_JS", {})
            : await this.executeScriptInFrame(page, frameId, "AUTOCOMPLETE_STATE_JS", {});
      } catch {
        return;
      }
      if ("error" in state) return;
      let pollMs = AUTOCOMPLETE_POLL_INTERVAL_MS;
      if (state.autocomplete !== true) {
        // Not (yet) autocomplete-style. A plain eligible field keeps waiting
        // only while there is activity to wait for.
        if (!(plainField && state.plainEligible === true)) return;
        const now = Date.now();
        const stats = page.networkStats?.(NETWORK_REQUEST_DROP_MS, baseline?.netGen ?? undefined);
        if (stats && (stats.pending > 0 || (lastGen !== null && stats.generation > lastGen))) {
          activitySeen = true;
          lastActiveAt = now;
          lastGen = stats.generation;
        }
        try {
          const dom = await this.executeScript(page, "SUGGEST_ACTIVITY_JS", { action: "check" });
          if (dom.mutated === true) {
            activitySeen = true;
            lastActiveAt = Math.max(lastActiveAt, now - (typeof dom.ageMs === "number" ? dom.ageMs : 0));
          }
        } catch {
          // Best-effort: no DOM signal.
        }
        if (!activitySeen && now - start >= PLAIN_SUGGEST_ACTIVITY_MS) return;
        if (activitySeen && now - lastActiveAt >= PLAIN_SUGGEST_QUIET_MS) return;
        pollMs = PLAIN_SUGGEST_POLL_MS;
      } else {
        const options = typeof state.options === "number" ? state.options : 0;
        const key = `${options}:${String(state.hash)}`;
        const docKey = `${String(state.docOptions)}:${String(state.docHash)}`;
        // A field that names its own list is judged on that list alone; the
        // document-wide digest only stands in when it falls back to page-wide
        // options (an unrelated always-visible option list must not hold it).
        const fresh =
          state.ownList === true
            ? baseline?.ownKey == null || key !== baseline.ownKey
            : baseline?.key == null || docKey !== baseline.key;
        if (options > 0 && key === previous && fresh) return;
        previous = key;
      }
      if (Date.now() + pollMs >= until) return;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /** Wave 3 reliability, item 4: runs BOT_CHECK_JS after `open` settles and
   * returns `{ botCheck: true }` only when the page looks like a bot-check
   * wall — the field is deliberately omitted (not `{ botCheck: false }`)
   * when it doesn't, matching this file's "only report what's actually
   * true" convention for other optional result fields (`openedTab`,
   * `dialogs`). Best-effort: a throwing/rejecting script must never turn a
   * successful open into an error.
   *
   * Bounded by its own short timeout (`BOT_CHECK_TIMEOUT_MS`), independent
   * of `open`'s own DOM-ready-vs-grace-period race: electron/electron#5183
   * means `executeJavaScript` defers until the page stops loading, so a
   * page `open` correctly returned early for (`loaded: false`, a still-
   * pending subresource) would otherwise make this call block for however
   * long that subresource takes — silently reintroducing the exact "wait
   * for the whole page to finish loading" cost the DOM-ready fix exists to
   * avoid, just one call later. A timed-out check degrades to "no botCheck
   * field", same as a throwing one. */
  private async checkBotWall(page: BrowserPageHandle): Promise<{ botCheck?: true }> {
    try {
      const result = await withTimeout(
        this.executeScript(page, "BOT_CHECK_JS", {}),
        BOT_CHECK_TIMEOUT_MS,
        "botCheck timed out.",
      );
      return result.botCheck === true ? { botCheck: true } : {};
    } catch {
      return {};
    }
  }

  /** Wave 3 reliability, item 3: drains this tab's console-error ring buffer
   * (window.ts, via the same CDP session as sendCdp/drainDialogs) and merges
   * the entries into `act`/`perform`'s own result as `consoleErrors` — and,
   * the same way, the requests that failed since the last command as
   * `failedRequests`. Each list is deduped (first-seen order) and keeps the
   * LAST `MAX_DRAINED_DIAGNOSTICS` (20) entries; `consoleErrorsDropped` /
   * `failedRequestsDropped` count the older ones that did not fit. The drain
   * empties the buffer, so what the result leaves out is gone: the cap is 20
   * (not 5) so a step recorder (QA mode) that reads the result loses little.
   * A field is omitted entirely when there's nothing new, so a caller can check
   * for its presence rather than an always-present empty array. Called once,
   * by the outermost public `act()`/`perform()` entry point (not by every
   * internal branch), so an action that itself routes through another
   * command internally (`act`'s index-based click calling `perform`'s CLICK
   * branch) never double-drains the same ring buffer. */
  private mergeDiagnostics(result: BrowserCommandResult, page: BrowserPageHandle | null): BrowserCommandResult {
    if (!page) return result;
    const merged = this.drainDiagnostics(page);
    return Object.keys(merged).length > 0 ? { ...result, ...merged } : result;
  }

  /** The drain behind `mergeDiagnostics` and `assert`: deduped, the last 20, with `...Dropped` counters. */
  private drainDiagnostics(page: BrowserPageHandle): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    const lists = [
      { key: "consoleErrors", drain: page.drainConsoleErrors?.bind(page) },
      { key: "failedRequests", drain: page.drainFailedRequests?.bind(page) },
    ] as const;
    for (const { key, drain } of lists) {
      if (!drain) continue;
      const entries = [...new Set(this.drainList(drain))];
      if (entries.length === 0) continue;
      merged[key] = entries.slice(-MAX_DRAINED_DIAGNOSTICS);
      if (entries.length > MAX_DRAINED_DIAGNOSTICS) merged[`${key}Dropped`] = entries.length - MAX_DRAINED_DIAGNOSTICS;
    }
    return merged;
  }

  /** Wave 3 reliability, item 2: discovers which of the top document's
   * `<iframe>` elements are worth descending into for a `snapshot`/`read`/
   * `findImages` call — matches Electron's `WebFrameMain` child frames
   * (`page.listFrames()`) against `IFRAME_RECTS_JS`'s report of every
   * visible iframe *element* in the top document, by `url` first (falls
   * back to `name` when the url doesn't match, e.g. a frame that hasn't
   * finished its first navigation yet) — see IFRAME_RECTS_JS's doc comment
   * for why matching has to happen this way at all (a WebFrameMain has no
   * DOM-side identity a page script could read, and a cross-origin iframe's
   * `src` attribute can differ from the frame's current, possibly-
   * redirected `url`). Capped at MAX_BROWSER_FRAMES; each matched entry
   * carries the iframe element's own content-box offset in top-level
   * viewport CSS px, so a child frame's own (frame-relative)
   * `getBoundingClientRect()` output can be turned into a top-level
   * coordinate by simple addition (one level of nesting only — see the
   * class-level "Wave 3" note on why this doesn't recurse further). Returns
   * `[]` (never throws) when the page/target doesn't support frames at all,
   * or when the rect script itself fails. */
  private async resolveVisibleFrames(page: BrowserPageHandle): Promise<ResolvedFrame[]> {
    if (!page.listFrames || !page.executeJavaScriptInFrame) return [];
    let frames: { frameId: number; url: string; name: string }[];
    try {
      frames = page.listFrames();
    } catch {
      return [];
    }
    if (frames.length === 0) return [];
    let rectsResult: BrowserCommandResult;
    try {
      rectsResult = await this.executeScript(page, "IFRAME_RECTS_JS", {});
    } catch {
      return [];
    }
    if ("error" in rectsResult || !Array.isArray(rectsResult.frames)) return [];
    const usedFrameIds = new Set<number>();
    const resolved: ResolvedFrame[] = [];
    for (const raw of rectsResult.frames as unknown[]) {
      if (resolved.length >= MAX_BROWSER_FRAMES) break;
      if (!isRecord(raw)) continue;
      const url = typeof raw.url === "string" ? raw.url : "";
      const name = typeof raw.name === "string" ? raw.name : "";
      const x = typeof raw.x === "number" ? raw.x : NaN;
      const y = typeof raw.y === "number" ? raw.y : NaN;
      const width = typeof raw.width === "number" ? raw.width : 0;
      const height = typeof raw.height === "number" ? raw.height : 0;
      if (!Number.isFinite(x) || !Number.isFinite(y) || width <= 0 || height <= 0) continue;
      let match = url ? frames.find((f) => !usedFrameIds.has(f.frameId) && f.url === url) : undefined;
      if (!match && name) match = frames.find((f) => !usedFrameIds.has(f.frameId) && f.name === name);
      if (!match) continue;
      usedFrameIds.add(match.frameId);
      resolved.push({ frameId: match.frameId, url: match.url, name: match.name, x, y, width, height });
    }
    return resolved;
  }

  /** Wave 3 reliability, item 2: same templating as `executeScript`, but
   * runs the resulting code inside a specific child frame
   * (`page.executeJavaScriptInFrame`) instead of the top document, bounded
   * by `FRAME_SCRIPT_TIMEOUT_MS` — electron/electron#5183 means a frame
   * that never finishes loading would otherwise hang this call forever
   * (window.ts's own implementation also races it, but this bounds every
   * caller regardless of which `BrowserPageHandle` is behind it). */
  private async executeScriptInFrame(
    page: BrowserPageHandle,
    frameId: number,
    script: ScriptName,
    scriptArgs: Record<string, unknown>,
  ): Promise<BrowserCommandResult> {
    if (!page.executeJavaScriptInFrame) return errorResult("This browser tab does not support frame scripting.");
    const code = SCRIPT_TEMPLATES[script].replace(ARGS_MARKER, () => JSON.stringify(scriptArgs));
    const result = await page.executeJavaScriptInFrame(frameId, code, FRAME_SCRIPT_TIMEOUT_MS);
    if (!isRecord(result)) return errorResult("Unexpected response from the frame script.");
    return scriptAnswer(result);
  }

  /** Wave 3 reliability, item 2: looks a `perform()` caller's global element
   * index up in the current snapshot's frame map — `frameId: null` (or no
   * entry at all, e.g. a snapshot taken before this wave) means "act on the
   * top document with this same index", exactly the pre-Wave-3 behavior. */
  private resolveFrameRoute(index: number): { frameId: number | null; localIndex: number } {
    const route = this.lastSnapshot?.frameMap.get(index);
    return route ?? { frameId: null, localIndex: index };
  }

  /** Code review finding 6: `resolveFrameRoute` plus the `cursorPoint`
   * derivation `performUnlocked` already did for CLICK/TYPE_TEXT — factored
   * out so `act`'s index-based `scroll`/`hover`/`press` (which used to call
   * `executeScript` directly against the top document, ignoring the frame
   * map entirely, and so failed with "No element matched: index N" for any
   * element actually inside a child frame) can route the same way. `index`
   * undefined (no index given at all, e.g. a target-based or window-level
   * action) resolves to `{ frameId: null, localIndex: 0 }` — the top
   * document, exactly as before this wave for every caller that never
   * routes to a frame. */
  private resolveFrameRouteWithCursorPoint(index: number | undefined): {
    frameRoute: { frameId: number | null; localIndex: number };
    frameRect: { x: number; y: number; width: number; height: number } | undefined;
    cursorPoint: { x: number; y: number } | undefined;
  } {
    const frameRoute = index !== undefined ? this.resolveFrameRoute(index) : { frameId: null, localIndex: index ?? 0 };
    const frameRect = frameRoute.frameId !== null ? this.lastSnapshot?.frameRects.get(frameRoute.frameId) : undefined;
    const cursorPoint = frameRect ? { x: frameRect.x + frameRect.width / 2, y: frameRect.y + frameRect.height / 2 } : undefined;
    return { frameRoute, frameRect, cursorPoint };
  }

  /** Surfaces `relocated: true` on a successful act/perform result when any
   * of its page-script calls re-found a re-mounted target by fingerprint. */
  private withRelocated(result: BrowserCommandResult): BrowserCommandResult {
    const relocated = this.relocatedThisCommand;
    this.relocatedThisCommand = false;
    if (!relocated || "error" in result) return result;
    return { ...result, relocated: true };
  }

  private async executeScript(
    page: BrowserPageHandle,
    script: ScriptName,
    scriptArgs: Record<string, unknown>,
  ): Promise<BrowserCommandResult> {
    // A function replacer, not a plain string — String.prototype.replace's
    // *string* form treats `$&`, `` $` ``, `$'` and `$$` in the replacement
    // as special patterns (e.g. `$&` re-inserts the whole match, `$'`
    // inserts everything after it), so a JSON.stringify'd arg containing one
    // of those two-character sequences (a click target of "$'", chat text
    // "price is $&") would get silently mangled — and `$'` in particular can
    // splice page content into the JSON string literal, breaking the "can
    // never break out of the script" invariant this file's header claims.
    // The function form's return value is inserted verbatim, no pattern
    // interpretation.
    // Re-mount recovery: an index-based call against the CURRENT snapshot on
    // its own tab carries that element's snapshot fingerprint. Only the top
    // document ever reaches executeScript with an index (frame-routed calls go
    // through executeScriptInFrame, which never adds one). Relocation is
    // strictly within the same snapshot and tab — the controller-level
    // staleness check has already run by the time we get here.
    let args = scriptArgs;
    if (
      typeof scriptArgs.snapshotId === "string" &&
      typeof scriptArgs.index === "number" &&
      scriptArgs.fingerprint === undefined &&
      this.lastSnapshot &&
      this.lastSnapshot.id === scriptArgs.snapshotId &&
      this.lastSnapshot.page === page
    ) {
      const fingerprint = this.lastSnapshot.fingerprints.get(scriptArgs.index);
      if (fingerprint) args = { ...scriptArgs, fingerprint };
    }
    const code = SCRIPT_TEMPLATES[script].replace(ARGS_MARKER, () => JSON.stringify(args));
    const result = await page.executeJavaScript(code);
    if (!isRecord(result)) return errorResult("Unexpected response from the page script.");
    if (result.relocated === true) this.relocatedThisCommand = true;
    return scriptAnswer(result);
  }

  /** Per page: the capture id of the "before" SIGNATURE_JS state that an
   * "after" may read (see PageSignature.captureId). */
  private readonly signatureCaptureIds = new WeakMap<BrowserPageHandle, string>();

  /** Runs SIGNATURE_JS for the given phase and returns the parsed signature,
   * or `null` on any failure (a throwing/rejecting executeJavaScript, or a
   * malformed response) — evidence capture must never itself turn a
   * successful action into an error result, so a capture failure degrades
   * to "no evidence available" rather than propagating.
   *
   * Review finding 4: SIGNATURE_JS now takes `phase` (via ARGS_MARKER, like
   * every other script here) — it needs to know "before" from "after" to
   * coordinate the `data-pen-sig-mainimg`/`data-pen-sig-target` identity
   * markers across the two calls (see SIGNATURE_JS's doc comment). `keep`
   * (an "after" peek, see captureClickEffect) leaves the dom/text observer
   * and its state running for a later capture. A keep-peek's state is only
   * readable by the "after" of the SAME "before" (capture id, see
   * signatureCaptureIds), so a peek that ends up final cannot leak into a
   * later action whose own "before" failed. */
  private async captureSignature(
    page: BrowserPageHandle,
    phase: "before" | "after",
    keep = false,
  ): Promise<PageSignature | null> {
    // "before" forgets any id first: if the capture below fails, the "after"
    // presents none and the page ignores whatever state is still stored.
    if (phase === "before") this.signatureCaptureIds.delete(page);
    try {
      const captureId = phase === "after" ? this.signatureCaptureIds.get(page) : undefined;
      const scriptArgs: Record<string, unknown> = { phase };
      // The page-side observer timer must outlive the longest command that can
      // own this capture (click: timeout + cursor budget), plus a margin.
      if (phase === "before") scriptArgs.ttlMs = this.timeoutMs + this.cursorBudgetMs + SIGNATURE_OBSERVER_MARGIN_MS;
      if (keep) scriptArgs.keep = true;
      if (captureId !== undefined) scriptArgs.captureId = captureId;
      const code = SIGNATURE_JS.replace(ARGS_MARKER, () => JSON.stringify(scriptArgs));
      const result = await page.executeJavaScript(code);
      if (!isPageSignature(result)) return null;
      if (phase === "before" && result.captureId !== undefined) this.signatureCaptureIds.set(page, result.captureId);
      if (phase === "after" && !keep) this.signatureCaptureIds.delete(page);
      return result;
    } catch {
      return null;
    }
  }

  /** "Addendum 2" §1, reshaped by review findings 2/4: diffs two page
   * signatures into `{ changed, changes }`. `changes` uses stable category
   * names, not raw field names.
   *
   * Finding 2: when either capture is missing (most likely the AFTER one —
   * `executeJavaScript` rejecting mid a cross-origin navigation's frame
   * swap is exactly when the page is most likely to have actually changed),
   * this used to unconditionally report `changed: false` — self-contradictory
   * at the moment of the biggest effect. `opts.previousUrl`/`opts.currentUrl`
   * (both already tracked by every caller that navigates) are used as a
   * fallback signal instead of guessing "no change".
   *
   * Finding 4: a whole-document `dom`/`text` delta is noisy on a live page
   * (carousels, lazy images, ads) and is reported in `changes` for context,
   * but never gates `changed` on its own — only url/title/main-image
   * (identity-guarded via SIGNATURE_JS's marker, see its doc comment) and
   * the acted-on element's own scoped signature do. `scrollY` and
   * `focusedValueLength` (finding 3) also gate `changed`: unlike `dom`/
   * `text`, neither one drifts on its own between two captures of the same
   * page — they only move because the action itself scrolled the page or
   * changed what's typed into a field — so they're trustworthy evidence,
   * not noise. */
  private diffSignatures(
    before: PageSignature | null,
    after: PageSignature | null,
    opts?: { previousUrl?: string; currentUrl?: string; scopedBefore?: ScopedSignature | null },
  ): EffectEvidence {
    if (!before || !after) {
      const changes: string[] = [];
      if (opts?.previousUrl !== undefined && opts?.currentUrl !== undefined && opts.previousUrl !== opts.currentUrl) {
        changes.push("url");
      }
      return { changed: changes.length > 0, changes };
    }

    const changes: string[] = [];
    const urlChanged = before.url !== after.url;
    const titleChanged = before.title !== after.title;
    const mainImageChanged = before.mainImageSrc !== after.mainImageSrc;
    const scrollChanged = before.scrollY !== after.scrollY;
    const valueChanged =
      before.focusedValueLength !== after.focusedValueLength || before.focusedValueHash !== after.focusedValueHash;
    const controlsChanged = before.controlsHash !== after.controlsHash;

    if (urlChanged) changes.push("url");
    if (titleChanged) changes.push("title");
    // Report-only — see the doc comment above for why these don't gate.
    if (before.nodeCount !== after.nodeCount) changes.push("dom");
    if (before.textLength !== after.textLength || before.textHash !== after.textHash) changes.push("text");
    if (scrollChanged) changes.push("scroll");
    if (valueChanged) changes.push("value");
    if (controlsChanged) changes.push("controls");
    if (mainImageChanged) changes.push("main-image");

    let scopedChanged = false;
    if (opts && opts.scopedBefore !== undefined) {
      const scopedBefore = opts.scopedBefore;
      const scopedAfter = after.scopedAfter ?? null;
      if (scopedBefore || scopedAfter) {
        scopedChanged =
          !scopedBefore ||
          !scopedAfter ||
          scopedBefore.nodeCount !== scopedAfter.nodeCount ||
          scopedBefore.textHash !== scopedAfter.textHash ||
          scopedBefore.src !== scopedAfter.src ||
          scopedBefore.valueLength !== scopedAfter.valueLength ||
          scopedBefore.valueHash !== scopedAfter.valueHash ||
          scopedBefore.ariaExpanded !== scopedAfter.ariaExpanded ||
          scopedBefore.ariaSelected !== scopedAfter.ariaSelected ||
          (scopedBefore.ariaValueNow ?? "") !== (scopedAfter.ariaValueNow ?? "") ||
          scopedBefore.checked !== scopedAfter.checked;
      }
      if (scopedChanged) changes.push("target");
    }

    const changed = urlChanged || titleChanged || mainImageChanged || scrollChanged || valueChanged || controlsChanged || scopedChanged;
    return { changed, changes, pageChanged: after.pageChanged ?? false, appeared: after.appeared ?? [] };
  }

  /** Review finding 3: a short, fixed settle for a non-click action before
   * capturing "after" — see NON_CLICK_SETTLE_MS's doc comment. */
  private async settleShort(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, NON_CLICK_SETTLE_MS));
  }

  /** Second-pass review finding 7: waits for the next paint after a DOM
   * mutation (MARKS_JS's overlay) before `screenshot({ annotate: true })`
   * captures the page — an in-page double `requestAnimationFrame` (the
   * standard "wait for the browser to actually paint" idiom: the first rAF
   * only guarantees the *next* frame is about to be produced, the second
   * guarantees that frame has landed), raced against PAINT_WAIT_TIMEOUT_MS.
   * Swallows every failure (a throwing/rejecting executeJavaScript, or the
   * race timing out) — a hidden `WebContentsView` never fires
   * `requestAnimationFrame` at all, so timing out here is the expected,
   * common case for an off-screen tab, not an error; the capture proceeds
   * either way, exactly as it did before this wait existed. */
  private async waitForPaint(page: BrowserPageHandle): Promise<void> {
    const script =
      "(function(){return new Promise(function(resolve){" +
      "requestAnimationFrame(function(){requestAnimationFrame(function(){resolve(true);});});" +
      "});})()";
    try {
      await withTimeout(page.executeJavaScript(script), PAINT_WAIT_TIMEOUT_MS, "paint wait timed out");
    } catch {
      // See this method's doc comment.
    }
  }

  /** Waits (bounded by BUSY_SETTLE_TIMEOUT_MS) for the element the acting
   * script stamped `data-pen-sig-target` to stop being busy — i.e. for the
   * handler that disabled it to finish. Called only when that script
   * reported `__targetSelfDisabled`, so the common action pays nothing.
   *
   * Every failure mode ends the wait rather than extending it: the element
   * disappearing (`present: false` — a re-render or a navigation), a page
   * script `{ error }`, a rejecting executeJavaScript, or a malformed
   * answer. Observing a moment early is the old behaviour; hanging here is
   * not. */
  private async settleWhileTargetBusy(page: BrowserPageHandle): Promise<void> {
    const deadline = Date.now() + Math.min(this.timeoutMs, BUSY_SETTLE_TIMEOUT_MS);
    while (Date.now() < deadline) {
      let busy = false;
      try {
        const result = await this.executeScript(page, "TARGET_BUSY_JS", {});
        busy = result.present === true && result.busy === true;
      } catch {
        return;
      }
      if (!busy) return;
      await new Promise((resolve) => setTimeout(resolve, BUSY_POLL_INTERVAL_MS));
    }
  }

  /** Polls briefly for `page.getURL()` to move away from `previousUrl` —
   * bounded well under the overall command timeout so a page whose URL
   * never actually changes (e.g. a fake in tests, or a click that doesn't
   * navigate) doesn't stall a command. `maxWaitMs` defaults to 2s (used by
   * back/forward, which always navigate); a smaller bound is passed for
   * click, where most invocations don't navigate at all. Returns whether the
   * URL actually changed, so callers can tell "navigated" from "timed out
   * without navigating". */
  private async waitForUrlChange(page: BrowserPageHandle, previousUrl: string, maxWaitMs = 2_000): Promise<boolean> {
    const deadline = Date.now() + Math.min(this.timeoutMs, maxWaitMs);
    while (page.getURL() === previousUrl && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return page.getURL() !== previousUrl;
  }

  /** Polls until `page.isLoading()` goes false, bounded by `maxWaitMs` (and
   * always by the overall command timeout). Used only once a navigation has
   * actually been observed (see settleAfterClick) — a page that never
   * navigated has no load to wait for. */
  private async waitForLoadStop(page: BrowserPageHandle, maxWaitMs: number): Promise<void> {
    const deadline = Date.now() + Math.min(this.timeoutMs, maxWaitMs);
    while (page.isLoading() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** First phase of settleAfterClick's *fallback* path: polls (bounded,
   * short) for *any* sign that the click started a navigation — `getURL()`
   * moving, or `isLoading()` going true, whichever comes first. Checking
   * `isLoading()` too (not just the URL) is what makes CLICK_SETTLE_TIMEOUT_MS's
   * short bound viable for a real, slow-to-commit navigation — see its doc
   * comment. Returns whether a navigation was observed at all.
   *
   * Wave 1 speed: only used when `armNavigationWatcher` can't use
   * `onNavigationEvent` (every unit-test fake) — a real desktop page settles
   * event-driven instead, see that method. */
  private async waitForNavigationStart(page: BrowserPageHandle, previousUrl: string, maxWaitMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.min(this.timeoutMs, maxWaitMs);
    const navigating = () => page.getURL() !== previousUrl || page.isLoading();
    while (!navigating() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return navigating();
  }

  /** Wave 1 speed: a navigation-start watcher, armed *before* the action that
   * might navigate runs (a click's CLICK_JS call, a press's key dispatch,
   * `reload()`) — arming after the action risks missing an event that fires
   * synchronously inside it. `wait()` resolves `true` as soon as any
   * navigation-lifecycle event fires on the tab, or `false` once
   * NAV_START_GRACE_MS passes with none — replacing the old fixed
   * CLICK_SETTLE_TIMEOUT_MS (300ms) polling probe with an event-driven one
   * roughly 4x shorter for the common non-navigating case. Falls back to the
   * original `getURL()`/`isLoading()` polling (unarmed — there is nothing to
   * arm) when `page.onNavigationEvent` is absent, so every existing
   * unit-test fake (and any future `BrowserTarget` that doesn't implement
   * it) behaves exactly as before this change. `dispose()` must be called
   * once `wait()` has resolved (or is no longer needed) to release the
   * subscription/timer. */
  private armNavigationWatcher(page: BrowserPageHandle, previousUrl: string): { wait(): Promise<boolean>; dispose(): void } {
    if (!page.onNavigationEvent) {
      return {
        wait: () => this.waitForNavigationStart(page, previousUrl, CLICK_SETTLE_TIMEOUT_MS),
        dispose: () => {},
      };
    }
    let settled = false;
    let resolveWait!: (value: boolean) => void;
    const waitPromise = new Promise<boolean>((resolve) => {
      resolveWait = resolve;
    });
    const unsubscribe = page.onNavigationEvent(() => {
      if (settled) return;
      settled = true;
      resolveWait(true);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolveWait(false);
    }, Math.min(this.timeoutMs, NAV_START_GRACE_MS));
    return {
      wait: () => waitPromise,
      dispose: () => {
        unsubscribe();
        clearTimeout(timer);
      },
    };
  }

  /** Wave 1 speed: waits for this tab's network activity, tracked since
   * `baselineGeneration` (a `networkStats().generation` snapshot taken
   * *before* the action — see call sites), to go quiet — see
   * NETWORK_QUIET_WINDOW_MS's doc comment for what "quiet" means and why
   * that window. Returns immediately (no wait at all) when `networkStats` is
   * unavailable (no CDP session) or when nothing has started since the
   * baseline and nothing is currently pending — the "no-network action must
   * not pay for this" requirement: a click's settle already spent
   * NAV_START_GRACE_MS finding out there was no navigation, and by that same
   * moment any `fetch()`/`XMLHttpRequest` a click handler kicked off
   * synchronously has already been observed by `Network.requestWillBeSent`,
   * so no *additional* grace period is needed here — this is a plain
   * snapshot check, not another timed wait. */
  private async waitForNetworkQuiet(page: BrowserPageHandle, baselineGeneration: number): Promise<void> {
    if (!page.networkStats) return;
    // Code review finding 2: scope `pending` to requests that started AFTER
    // `baselineGeneration` — a request already in flight before the action
    // ran (Pinterest-style lazy images loading from an earlier scroll, say)
    // must not make a no-network action wait for it. `initial.pending` is
    // therefore already 0 whenever nothing new started, so the old combined
    // `generation === baseline && pending === 0` check collapses to a plain
    // `pending === 0` — a generation-only comparison can no longer disagree
    // with the (now baseline-scoped) pending count.
    const initial = page.networkStats(NETWORK_REQUEST_DROP_MS, baselineGeneration);
    if (initial.pending === 0) return;

    const deadline = Date.now() + NETWORK_QUIET_HARD_CAP_MS;
    let zeroStreakStart: number | null = null;
    while (Date.now() < deadline) {
      const stats = page.networkStats(NETWORK_REQUEST_DROP_MS, baselineGeneration);
      if (stats.pending === 0) {
        if (zeroStreakStart === null) zeroStreakStart = Date.now();
        if (Date.now() - zeroStreakStart >= NETWORK_QUIET_WINDOW_MS) return;
      } else {
        zeroStreakStart = null;
      }
      await new Promise((resolve) => setTimeout(resolve, NETWORK_POLL_INTERVAL_MS));
    }
  }

  /** Addendum F ("Load, not commit"): waits for a click's navigation, if any,
   * to actually finish loading — not merely for `getURL()` to change at
   * commit. First waits (bounded, short) to see whether the click started a
   * navigation at all; only if it did does it then wait (bounded, longer)
   * for that navigation to finish loading. A click that never navigates goes
   * through the network-quiet settle instead (Wave 1 speed) — an action that
   * triggers a `fetch()`/XHR without a full navigation (the common SPA case)
   * previously got no wait at all beyond the fixed probe, so a following
   * read routinely raced a still-in-flight request.
   *
   * `navWatcher` must already be armed (via `armNavigationWatcher`) *before*
   * the action ran; `networkBaseline` is `page.networkStats?.(...).
   * generation` captured at the same time — see call sites (runClick,
   * runPress, performUnlocked's CLICK branch, the `reload` action). */
  private async settleAfterClick(
    page: BrowserPageHandle,
    navWatcher: { wait(): Promise<boolean>; dispose(): void },
    networkBaseline: number | undefined,
  ): Promise<void> {
    const navigated = await navWatcher.wait();
    navWatcher.dispose();
    if (navigated) {
      await this.waitForLoadStop(page, CLICK_LOAD_SETTLE_TIMEOUT_MS);
      return;
    }
    if (networkBaseline === undefined) return;
    await this.waitForNetworkQuiet(page, networkBaseline);
  }

  /** `page.networkStats?.(...).generation` captured up front, or `undefined`
   * when the page has no CDP session — the baseline `waitForNetworkQuiet`
   * compares against to tell "nothing new since the action" from "something
   * started". Factored out since every settleAfterClick call site needs to
   * capture it at the same moment it arms the navigation watcher (before the
   * action runs). */
  private captureNetworkBaseline(page: BrowserPageHandle): number | undefined {
    return page.networkStats?.(NETWORK_REQUEST_DROP_MS).generation;
  }

  private async withCommandTimeout(
    fn: (deadlineAt: number) => Promise<BrowserCommandResult>,
    budgetMs?: number,
    journalAction?: JournalDeclare,
  ): Promise<BrowserCommandResult> {
    const ms = budgetMs ?? this.timeoutMs;
    // Taken in this tick, before any await: an abandoned command's late work keeps ITS OWN command,
    // which the journal ignores once it has ended (see JournalCommand).
    const journalSession = this.journal;
    const journalCommand = journalSession?.current ?? null;
    // Handed to `fn` (not stored on the controller): an abandoned command's
    // work keeps running after the next command starts, and must only ever
    // see ITS OWN deadline.
    let deadlineAt = Date.now() + ms;
    // Review finding 6: both captured *before* fn() runs, not after — a
    // command can itself close the tab it acted on (`tabs({action:"close"})`,
    // or a click whose handler navigates the whole window away and it gets
    // torn down), and each `BrowserPageHandle` here is a plain object closing
    // over its own dialog queue array, so draining it after the fact is safe
    // even once the underlying tab is gone — but only if we grabbed the
    // handle while the tab still existed.
    const actedPage = this.target.currentPage();
    const pageHandles = await this.listPageHandlesSafe();
    let result: BrowserCommandResult;
    // A command that declares it may change the page gets the journal's sync (and, for an action, its staging) BEFORE
    // its own budget starts, in a budget of the journal's own: a slow base read must not time out an action that works
    // with the journal off. With the journal off, or for a read-only command, it starts exactly as before.
    if (journalAction && journalSession && journalCommand) {
      await this.journalPrepare(journalSession, journalCommand, journalAction, actedPage);
      deadlineAt = Date.now() + ms;
    }
    const work = fn(deadlineAt);
    const timeoutMessage = `Browser command timed out after ${ms}ms.`;
    try {
      result = await withTimeout(work, ms, timeoutMessage);
    } catch (err) {
      if (journalSession && journalCommand && toMessage(err) === timeoutMessage) journalSession.markTimedOut(journalCommand);
      result = errorResult(toMessage(err));
      // See `overrun`'s doc comment: keep the next queued command from
      // starting while this one's abandoned work is still running.
      const settled = work.then(
        () => undefined,
        () => undefined,
      );
      this.registerOverrun(settled);
    }
    return this.mergeDialogs(result, pageHandles, actedPage);
  }

  /** Best-effort `BrowserTarget.pageHandles()` call — `[]` when the target
   * doesn't implement it (every unit-test fake, and any `BrowserTarget`
   * predating review finding 6) or throws, so dialog draining degrades to
   * `mergeDialogs`'s `actedPage`-only fallback rather than breaking the
   * command it's piggybacking on. */
  private async listPageHandlesSafe(): Promise<{ tabId: number; page: BrowserPageHandle }[]> {
    if (!this.target.pageHandles) return [];
    try {
      return await this.target.pageHandles();
    } catch {
      return [];
    }
  }

  /** Full browser use's dialog policy (CLAUDE.md): every command result gets
   * whatever JS dialogs (`alert`/`confirm`/`prompt`/`beforeunload`) any
   * browser tab's CDP session auto-handled since the last drain merged in as
   * `{ dialogs }` (each entry tagged `tabId`) — centralized here (every
   * public command routes through `withCommandTimeout`) rather than threaded
   * through each command individually. Applied on both success and failure:
   * a dialog raised by the very action that then errored out is still worth
   * reporting.
   *
   * Review finding 6: this used to drain only `target.currentPage()` *after*
   * the command ran — so a dialog on a tab other than the one a command acts
   * on (a popup that raised its own dialog while the command ran elsewhere,
   * or the tab the command itself just closed) was silently lost instead of
   * surfacing on the next report. `pageHandles` (captured by
   * `withCommandTimeout` before `fn()` ran) now covers every open browser
   * tab; `actedPage` (also captured beforehand) is the fallback for a
   * `BrowserTarget` that doesn't implement `pageHandles` at all.
   *
   * Second-pass review finding 6: `tabs({action:"new", url})` runs a nested
   * `open()` call (see `tabs()`), which is itself wrapped in
   * `withCommandTimeout` and so already drains and merges dialogs into its
   * own `{ dialogs }` field before the outer `tabs()` call's
   * `withCommandTimeout` ever sees the result. This method used to overwrite
   * `result.dialogs` outright (`{ ...result, dialogs }`) whenever *this* call
   * found anything of its own to drain — starting from an empty array
   * instead of whatever `result.dialogs` already carried, so the inner
   * call's dialogs were silently dropped the moment the outer call had any
   * dialogs of its own. Seeding `dialogs` from `result.dialogs` (when
   * present) fixes this without ever double-reporting: `drainDialogs()`
   * clears each tab's queue on the call that drains it, so by the time the
   * outer call's drain runs, every dialog the inner call already reported is
   * gone from the queue and cannot be drained a second time. */
  private mergeDialogs(
    result: BrowserCommandResult,
    pageHandles: { tabId: number; page: BrowserPageHandle }[],
    actedPage: BrowserPageHandle | null,
  ): BrowserCommandResult {
    const dialogs: Record<string, unknown>[] = Array.isArray(result.dialogs)
      ? [...(result.dialogs as Record<string, unknown>[])]
      : [];
    const drain = (page: BrowserPageHandle, tabId?: number) => {
      if (!page.drainDialogs) return;
      try {
        const drained = page.drainDialogs();
        for (const d of drained) dialogs.push(tabId === undefined ? { ...d } : { tabId, ...d });
      } catch {
        // A throwing drainDialogs degrades to "no dialogs from this tab"
        // rather than breaking the command it's piggybacking on.
      }
    };
    if (pageHandles.length > 0) {
      for (const { tabId, page } of pageHandles) drain(page, tabId);
    } else if (actedPage) {
      drain(actedPage);
    }
    if (dialogs.length === 0) return result;
    return { ...result, dialogs };
  }
}

function normalizeNonNegativeNumber(
  value: unknown,
  fallback: number,
): { value: number; error?: string } {
  if (value === undefined) return { value: fallback };
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { value: fallback, error: "must be a non-negative number." };
  }
  return { value };
}

/** Review finding 4: CLICK_JS/TYPE_JS/PERFORM_JS (for CLICK/TYPE_TEXT/SELECT)
 * embed the acted-on element's own before-signature in their result as an
 * internal `__scopedBefore` field. This pulls it out for diffSignatures and
 * deletes it from `result` in place, so it never leaks into the value a
 * caller (the chat tool, ultimately) ends up seeing. */
/** Upstream PR #58: CLICK_JS/TYPE_JS/PERFORM_JS report whether the action
 * itself made the acted-on control busy. Like `__scopedBefore`, it is an
 * internal field — pulled out here and deleted in place so it never reaches
 * the chat tool's result. */
function extractTargetSelfDisabled(result: BrowserCommandResult): boolean {
  const raw = result.__targetSelfDisabled;
  delete result.__targetSelfDisabled;
  return raw === true;
}

/** A slider drive that failed after moving the slider (see
 * `completeSliderResult`) marks its error result `__sliderPartial` so the
 * caller still computes `{ changed, changes }`. Pulled out and deleted in
 * place like the other internal fields. */
function extractSliderPartial(result: BrowserCommandResult): boolean {
  const raw = result.__sliderPartial;
  delete result.__sliderPartial;
  return raw === true;
}

function extractScopedBefore(result: BrowserCommandResult): ScopedSignature | null {
  const raw = result.__scopedBefore;
  delete result.__scopedBefore;
  return isScopedSignature(raw) ? raw : null;
}

/** What a snapshot element table entry looked like when it was taken — see
 * `lastSnapshot.fingerprints`. */
interface ElementFingerprint {
  tag: string;
  label: string;
  role?: string;
}

/** A top-document element's fingerprint from its element-table entry, or
 * `null` when it must not have one: a scroll-container entry (`ops: []`), or
 * an unlabelled element whose label is SNAPSHOT_JS's positional fallback
 * `"<tag> #<index>"` (not a property of the node, so useless for matching). */
function fingerprintOf(el: Record<string, unknown>): ElementFingerprint | null {
  if (typeof el.index !== "number" || typeof el.tag !== "string" || typeof el.label !== "string") return null;
  // SNAPSHOT_JS caps tag at 40 and role at 60: a value at the cap may have
  // been truncated, so relocation (which compares the real node's tag/role)
  // could never match it. No fingerprint = fail closed.
  if (el.tag.length >= 40 || (typeof el.role === "string" && el.role.length >= 60)) return null;
  if (!Array.isArray(el.ops) || el.ops.length === 0) return null;
  if (el.label === "" || el.label === `${el.tag} #${el.index}`) return null;
  const fp: ElementFingerprint = { tag: el.tag, label: el.label };
  if (typeof el.role === "string" && el.role !== "") fp.role = el.role;
  return fp;
}

/** SNAPSHOT_JS's internal `__modalFrames` (only present when it scoped to a
 * modal): the `{ url, name }` of each iframe inside that modal. `null` when
 * the snapshot wasn't modal-scoped (merge every frame as usual). */
function extractModalFrames(result: BrowserCommandResult): { url: string; name: string }[] | null {
  if (typeof result.modal !== "string") return null;
  const raw = result.__modalFrames;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((r) => ({
    url: typeof r.url === "string" ? r.url : "",
    name: typeof r.name === "string" ? r.name : "",
  }));
}

/** Wave 2 reliability: CLICK_RESOLVE_JS reports the resolved element's busy
 * state *before* any action ran (it performs no action itself) as an
 * internal `__busyBefore` field — pulled out here and deleted in place, same
 * pattern as `extractScopedBefore`/`extractTargetSelfDisabled`, so it never
 * reaches a caller. `dispatchClick`/`dispatchType` compare it against a
 * fresh `TARGET_BUSY_JS` read taken right after the trusted action to
 * compute `__targetSelfDisabled` themselves, since CLICK_RESOLVE_JS can't
 * know the outcome of an action it never performs. */
function extractBusyBefore(result: BrowserCommandResult): boolean {
  const raw = result.__busyBefore;
  delete result.__busyBefore;
  return raw === true;
}
