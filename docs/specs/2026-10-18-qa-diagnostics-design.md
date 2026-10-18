# QA diagnostics, assertions, emulation and upload (2026-10-18)

Status: approved for implementation (autopilot). Source: gap analysis of
2026-10-18 against Playwright MCP, Chrome DevTools MCP, Momentic, Stagehand and
others. Priority 1 items.

Rules that apply to every part:

- The package gives mechanism and typed results. The host decides how to show,
  store or format them ([browser-agent-mechanism-not-policy]).
- No UI work in consumers. Everything here is used by the agents.
- Secrets rule from the fixture spec stays: no cookie value, storage value, or
  URL query/hash in model text or errors that the package builds itself.
  Failed-request URLs are reported as `origin + pathname` only.
- Every new `BrowserTarget`/`BrowserPageHandle` capability is optional. A
  target without it fails the feature clearly, never silently.

## 1. Failed requests and console errors in results

### Page handle

```ts
/** Drains (and clears) failed requests since the last drain. Each entry is
 * "<METHOD> <status|errorText> <origin><pathname>", ≤200 chars. Ring buffer
 * caps at 50. Records HTTP status >= 400 (Network.responseReceived) and
 * Network.loadingFailed (except canceled/aborted by the page: errorText
 * "net::ERR_ABORTED" with `canceled: true`). Data URLs, WebSocket,
 * EventSource and beacons are skipped. */
drainFailedRequests?(): string[];
```

Implemented in `adapters/playwright.ts` (CDP Network listeners it already
has) and in the desktop `window.ts` (debugger `message` listener it already
has; only when the debugger is attached).

### Controller

`act` and `perform` merge it like `consoleErrors`: result field
`failedRequests` (deduped, the last 20; `failedRequestsDropped` counts older ones; `consoleErrors` follows the same rule), absent when empty. `assert` (section 2) merges both
lists too, with the same rule (deduped, last 20, `...Dropped` counters; one helper,
`drainDiagnostics`, serves `act`, `perform` and `assert`).

### QA result

`createStepRecorder` harvests `consoleErrors` and `failedRequests` from each
tool output (it already parses the JSON) into run-level lists: deduplicated,
in first-seen order, capped at 20 each, with a dropped counter. The
controller's own `consoleErrorsDropped` / `failedRequestsDropped` (top level and in
each entry of a batched `results`) are added to the run's dropped counters, as are
those of an `assert` answer (`executeQaAssert`, `runFinalChecks`).

```ts
interface QaResult {
  ...existing
  /** Console errors seen during the run (deduped, ≤20). Absent when none. */
  consoleErrors?: string[];
  consoleErrorsDropped?: number;
  /** Failed requests seen during the run (deduped, ≤20). Absent when none. */
  failedRequests?: string[];
  failedRequestsDropped?: number;
  /** Assertion results, in order: the agent's qa_assert calls, then the host's final checks. */
  checks?: QaCheckRecord[];
}
```

Errors from page loads that no `act`/`perform`/`assert` drained are not seen.
The final checks (section 2) call `assert`, which drains, so a run with final
checks sees them.

## 2. Deterministic assertions

### Check shapes (package type `QaCheck`, zod-free parser + zod schema)

```ts
type QaCheck =
  | { type: "text"; text: string; absent?: boolean }             // visible text on the page (top document), case-insensitive substring; must be present unless absent is true (default false)
  | { type: "element"; selector?: string; index?: number;          // CSS selector, or snapshot index (as browse_act)
      state: "visible" | "hidden" | "exists" | "absent" | "enabled" | "disabled" | "checked" | "unchecked" }
  | { type: "value"; selector?: string; index?: number; equals?: string; contains?: string } // input/textarea/select value
  | { type: "count"; selector: string; equals?: number; min?: number; max?: number }
  | { type: "url"; equals?: string; contains?: string; matches?: string }  // matches = JS regex source
  | { type: "no_console_errors"; ignore?: string[] }               // substrings to ignore
  | { type: "no_failed_requests"; ignore?: string[] };             // substrings of the reported entry to ignore
```

Limits: ≤10 checks per call. A check with neither `selector` nor `index`
where one is needed, or with no comparator, is a parse error (not a failed
check).

### Controller command `assert`

`controller.assert({ checks })` runs under `runExclusive`, like `perform`.
Returns:

```ts
{ ok: true, passed: boolean, results: { check: QaCheck; passed: boolean; actual?: string; error?: string }[],
  consoleErrors?: string[], failedRequests?: string[], consoleErrorsDropped?: number, failedRequestsDropped?: number }
```

- DOM checks run in one page script on the current tab. `actual` is a short
  string (≤120 chars) that explains a failure ("3 matches", "value \"abc\"",
  "hidden"). An invalid selector gives `passed:false` with `error`.
- `url` compares against `getURL()` (full URL, the agent already sees it).
- `no_console_errors` / `no_failed_requests` in the controller look only at
  what this call drained. The session layer (below) adds the run history.
- The command is read-only. The journal records nothing for it.

`BrowserBridge` gets optional `assert?(args)`. `controllerBridge` forwards it.

### QA tool `qa_assert` (agent-side)

QA mode adds a second tool next to `qa_verdict`: `qa_assert({ checks })`. It
is not single-use and does not end the run. The executor calls
`browser.assert`, then `evaluateQaChecks(result, recorder)` in `qaCore`:
console/network checks are evaluated against the recorder's run-level lists
plus what this call drained. Tool output: `{ passed, results }` JSON.
Recorded in `QaResult.checks` with `source: "agent"`.

Strict-mode placeholders (`normalizeQaChecks`, run by `parseQaChecks` and, as a
`z.preprocess`, by `qaAssertSchema`): `null` and `""` count as absent (except
`equals: ""` of a `value` check with no other comparator: an input that must be
empty; next to a non-empty `contains` it is dropped); an empty `ignore` array is
absent; `index: 0` next to a non-empty `selector` is dropped (the selector wins).
The text check uses `absent` (default false), not `present`, so a `false` placeholder
means the safe default: the text must be on the page. `count` with more than one
comparator drops the zeros that conflict: `min: 0` always (a no-op), `equals: 0`
when `min` or `max` is non-zero, `max: 0` when `min` or `equals` is above 0. A
`count` with `equals: 0` alone (or `min: 0` or `max: 0` alone) is a real check and
stays. Other zeros are real values. The
parser and evaluation live in `src/shared/qaChecks.ts` (the controller imports
them there, not from `agent`).

A failed agent check does NOT change the outcome. The agent may probe. The
QA prompt section tells the agent: use `qa_assert` to confirm each expected
result before `qa_verdict`, and give `pass` only when the checks you rely on
passed.

### Host final checks

`runBrowseAgent({ qa: { checks?: QaCheck[] } })` (and the Pen Editor
`browse_agent` input `checks`, QA only). After the agent loop ends with
outcome `passed`, `failed` or `inconclusive`, the host runs the checks once
via `browser.assert` and evaluates them with the same helper.
`applyFinalChecks(qa, results)` in `qaCore`:

- records them with `source: "final"`;
- outcome `passed` + any failed final check → `failed`, reason
  `"Final check failed: <first failure>. Agent verdict: <reason>"`;
- other outcomes do not change.

Final checks are skipped for `setup_failed`, `aborted` and `error`.

```ts
interface QaCheckRecord { source: "agent" | "final"; check: QaCheck; passed: boolean; actual?: string; error?: string }
```

Both result assemblers use these helpers: `agent/aiSdk.ts` and the Pen Editor
frontend copy (`browseAgent.ts`).

## 3. Environment emulation (`PageFixture.emulate`)

```ts
interface FixtureEmulate {
  device?: "iphone-15" | "pixel-8" | "ipad" | "desktop-1440" | "desktop-1920";
  viewport?: { width: number; height: number; deviceScaleFactor?: number; mobile?: boolean };
  touch?: boolean;
  userAgent?: string;
  locale?: string;        // BCP 47, e.g. "de-DE"
  timezone?: string;      // IANA, e.g. "Europe/Berlin"
  colorScheme?: "light" | "dark";
  reducedMotion?: boolean;
}
```

- `device` is a preset (viewport + DPR + mobile + touch + UA). Explicit
  fields override the preset.
- Applied via `page.sendCdp` on the agent tab and on the fixture's `tabs`, in
  stage `emulate` (new `FixtureStage`), after `fresh` and before `url`/`steps`:
  `Emulation.setDeviceMetricsOverride`, `setTouchEmulationEnabled`,
  `setUserAgentOverride`, `setLocaleOverride`, `setTimezoneOverride`,
  `setEmulatedMedia` (`prefers-color-scheme`, `prefers-reduced-motion`).
- User-agent override: only for an explicit `userAgent` or a mobile preset (a
  desktop preset sends none). The user agent and the client hints of the real
  browser are read in ONE `executeJavaScript` round-trip before the override,
  with a 2 s timeout (a timeout or an unreadable `navigator.userAgentData`
  means "hints unreadable"). Per case:
  - iPhone / iPad preset: `userAgent` + `platform` ("iPhone"/"iPad") (+
    `acceptLanguage`) and NO `userAgentMetadata`. Real iOS Safari has no UA
    Client Hints; an override without metadata makes Chromium disable them
    (live: `navigator.userAgentData` exists with empty `brands`, `mobile`
    false, `platform` "").
  - Android preset (pixel-8): the preset UA string is a template; its Chrome
    version is replaced by the real browser's major (from the Chromium /
    Google Chrome brand of the hints, else from the browser's own UA), so UA
    string and brands agree. Metadata carries the brands and `fullVersionList`
    as the browser reports them (nothing is invented), `wow64` as reported,
    `platform` "Android", `platformVersion`, `model`, `mobile: true`. With
    unreadable hints the metadata is built from the UA's Chrome version only:
    brands `["Chromium", "Not.A/Brand"]`, platform "Android".
  - Explicit `userAgent`: the real browser's hints (brands, platform,
    architecture, bitness, `wow64`) with `mobile` from `viewport.mobile`. With
    unreadable hints: the UA (+ `acceptLanguage`) without metadata; no platform
    or brand is invented.
- Emulated screenshots return a `data:image/jpeg;base64,` URL, the same format as
  `page.capture()` (the Playwright adapter's `capture()` now returns it too).
- `locale` and `navigator.language` / `Accept-Language`: `setLocaleOverride` alone
  changes `Intl` only (found by the live smoke `npm run qa-diagnostics-smoke`).
  Both paths end in the same header `de-DE,de;q=0.9` and the same
  `navigator.languages` `["de-DE","de"]` (a locale without a region gives just
  the locale; the smoke compares locale-only with locale + pixel-8).
  - When the fixture also sets a UA override (explicit `userAgent` or a mobile
    device preset), `acceptLanguage` goes into that same `setUserAgentOverride`
    call (no extra call). The field is a plain list (`de-DE,de`): Chromium adds
    the `;q=` weights itself and derives `navigator.languages` from it (live:
    sending `de-DE,de;q=0.9` there gives `de-DE,de;q=0.9;q=0.9`).
  - Otherwise the UA is not touched (an override without `userAgentMetadata`
    disables UA Client Hints). The fixture sends `Network.enable` (left
    enabled; both shipped hosts already enable Network), then
    `Network.setExtraHTTPHeaders` `{ "Accept-Language": "de-DE,de;q=0.9" }` and
    `Page.addScriptToEvaluateOnNewDocument` with a script that defines
    `navigator.language` and `navigator.languages` (`[locale, base]`, deduped)
    as configurable getters on `Navigator.prototype`. The fixture applies
    emulation before the start URL loads, so the init script covers the run's
    documents; it also runs once in the document that is open at apply time.
  - `setExtraHTTPHeaders` replaces the session's WHOLE extra-header set (CDP
    keeps one set per session) at apply, for the whole run, and again at
    release (`{ headers: {} }`). A host that sets its own extra headers through
    CDP loses them from apply on, and must re-apply them after `release()`.
  - Limit: the locale-only path covers the tab's top document session only.
    Out-of-process iframes and workers keep the real browser language.
  - `release()` calls `removeScriptToEvaluateOnNewDocument(identifier)` and
    `setExtraHTTPHeaders({ headers: {} })`. An already loaded document keeps
    the patched `navigator.language` until it navigates. A failure in apply
    rolls back like the other overrides.
- A target whose page has no `sendCdp` → `setup_failed`, stage `emulate`,
  "This browser does not support emulation."
- `release()` clears every override it set (`clearDeviceMetricsOverride`,
  touch off, UA restored to the value read before apply, locale/timezone
  cleared with empty params, media features cleared). Release is composed with
  the network release, so `applyFixture` keeps a release when only emulation
  was set.
- Tabs opened later (popups) are NOT emulated. Documented limit.
- The UA clear on release (`userAgent: ""`) also removes a UA override the host set
  through CDP before the fixture. A host that relies on its own CDP UA override must not
  use `emulate.userAgent` or a device preset (they carry a UA), or must re-apply its
  override after `release()`.
- Hook seam: `FixtureHooks.newTab` opens a blank tab (the apply emulates it, then loads
  it through `navigate`). The released `openTab(url)` (open and load in one) stays as a
  deprecated hook, used only when a host gives no `newTab`; in that path the tab is
  emulated AFTER its first load, so that first load is not emulated.
- Geolocation is NOT in scope: the desktop denies the permission, so an
  override would not reach the page. Deferred.
- Screenshot: while emulation is active on a page with `sendCdp`, the
  controller captures with `Page.captureScreenshot` (JPEG, quality 70, scaled
  to ≤1280 wide by the same rule as `capture`) instead of `page.capture()`. The clip
  size and origin come from `cssVisualViewport` (`clientWidth`/`clientHeight`,
  `pageX`/`pageY`), not from the emulated metrics, so a mobile page without a meta
  viewport (980 px layout in a 390 px device) is captured whole; the emulated metrics
  are the fallback when the viewport is not readable,
  because Electron's `capturePage` captures the view, not the emulated
  viewport.
- `captureFixture` / checkpoint base includes the active `emulate`, so a
  resumed run gets the same device.

## 4. File upload (`browse_act` action `upload`)

```ts
{ action: "upload", index | element, files: UploadFile[] }
type UploadFile = { name: string; mimeType?: string } & (
  | { text: string }        // UTF-8 text content
  | { base64: string }      // raw bytes
  | { sample: "png" | "jpg" | "pdf" | "txt" | "csv" }  // built-in tiny valid file
);
```

- ≤5 files, ≤2 MB decoded in total, `name` ≤100 chars, no path separators.
- Mechanism: a page script, like Playwright's buffer path. It builds `File`
  objects, assigns them through a `DataTransfer` to the target
  `input[type=file]`, then dispatches `input` and `change`. No temp files, no
  CDP, works on desktop and cloud alike.
- Target resolution: the element itself if it is a file input; else a file
  input inside it, or the input its `<label for>` names. If none: dispatch
  `dragenter`, `dragover`, `drop` with the `DataTransfer` on the element (drop
  zones). The sibling/cousin file-input lookup (nearest ancestor within 3 levels
  that holds exactly one file input) applies only to a trigger-like target: a
  `button`, `a`, `label`, `[role=button|link]`, `input[type=button|submit]` or an
  element inside one. Any other element (a div drop zone) goes straight to the drop.
  A drop that no listener cancelled, but after which the DOM changed (a
  MutationObserver on the document, the target's open shadow root and the open
  shadow roots of its composed ancestors; a closed shadow root is not reachable),
  returns `ok: true, via: "drop", unconfirmed: true`: the page may have taken the
  files, so the agent must not upload again. If nothing changed, it is an error with
  `noEffect`.
- `multiple` absent and >1 file → error "This input takes one file".
  `accept` is not enforced (a QA test may check rejection).
- Result: `{ ok, uploaded: [names], via: "input" | "drop", unconfirmed?: true }`.
- Journal: `upload` is a checkpoint gap (the bytes are not replayable).
- The sample files are tiny valid files embedded as base64 constants in the
  package (1×1 PNG/JPEG, one-page PDF).

## 5. Out of scope here

- Run video / trace: needs a decision where the host stores it. Deferred.
- Geolocation, network throttling, offline mode.
- Firefox/WebKit.

## 6. Changing the viewport mid-run (`browse_act` action `viewport`)

```ts
{ action: "viewport", device: "iphone-15" | "pixel-8" | "ipad" | "desktop-1440" | "desktop-1920" | "custom" | "reset",
  width?: number, height?: number, mobile?: boolean }
```

The agent can test a page on desktop, then on a phone. It is not an element action (no `index`, no `element`).
It is also valid in an `actions` batch.

- `custom` needs integer `width` and `height`, 200 to 4000; `mobile` defaults to false. For any other
  device `width`, `height` and `mobile` are ignored. Strict-mode placeholders: `width`/`height` 0 and
  `mobile: false` are removed by `normalizeBrowseActInput`, except `width`/`height` 0 next to `custom`, which
  stays and is an error. The rules are in `src/shared/viewport.ts` (`parseViewportArgs`); the schema, the
  executor (refuses a bad call before the bridge) and the controller all use them.
- Scope: the agent's current page only. Tabs opened later are not emulated (as in section 3).
- Mechanism, all in the controller, reusing `src/fixture/emulate.ts` (`resolveEmulation`, `installEmulation`,
  the presets, the client hints). Each action does the same thing: clear the previous action's layer (its
  own undo), clear the device parts of the page's fixture emulation (metrics, touch, user agent; the
  fixture's own clear is all or nothing), then install the new emulation WHOLE. The new emulation is the
  fixture's `locale`, `timezone`, `colorScheme` and `reducedMotion` (kept) plus the device or viewport of
  the action (replacing the fixture's device, viewport, touch and user agent). The real user agent and hints
  are therefore read from a clean page. `reset` installs the fixture's own emulation again if the page
  carries one, else it only clears. A failed install clears itself and puts the page back to the fixture's state;
  the result is `{ error: "Setting the viewport failed: ..." }`.
- Reload: if the identity changes, the controller reloads the page (the same wait as `reload`) and the
  result says `reloaded: true`. Identity is the user agent string and the `mobile` flag of the metrics, so
  phone to desktop, one phone to another, and a custom `mobile` change reload; a pure size change does not.
  The last snapshot is dropped (the layout changed); the executor attaches a fresh `snapshot`.
- Result: `{ ok: true, viewport: { width, height, deviceScaleFactor, mobile }, device, reloaded }`. `width`,
  `height` and the scale factor are read from the page after the change (`innerWidth`, `innerHeight`,
  `devicePixelRatio`); if they cannot be read, the emulated metrics are used (absent with neither).
- Page without `sendCdp`: `{ error: "This browser does not support emulation." }` with the no-effect marker.
- Screenshots while a layer is active use the emulated capture path of section 3 (`Page.captureScreenshot`,
  data URL), with the layer's emulation.
- Checkpoint: the journal records no step for `viewport`, and it is not a gap. `captureCheckpoint` puts the
  EFFECTIVE emulation into `fixture.emulate`: the layer of the current page, else the fixture's. A resumed run
  gets the same device. With the journal on, an action that reloads declares itself like `reload` (`nav`).
- Lifetime: the layer must not outlive the run.
  - `BrowserController.clearActEmulation()` ends it: each page goes back to the fixture's state (or to the real
    browser without a fixture). Idempotent, never rejects, no reload.
  - `releaseFixture()` also clears all layers (before the fixture's own clear), so a release after any number of
    actions leaves no override. A release without a token does this also when no fixture is active.
  - `BrowserBridge.clearActEmulation?()` (new, optional) is forwarded by `controllerBridge`. `runBrowseAgent`
    calls it at the end of every run, after the fixture release, also when the run used no fixture (bounded to 5 s,
    a rejection is ignored). **Hosts that drive the browser without `runBrowseAgent` (for example Pen Editor's
    frontend running `browse_agent` itself, or the desktop shell between runs) must call
    `bridge.clearActEmulation()` when their run ends.** A bridge for a remote browser (cloud bridge) must forward it
    to the controller that holds the layers; without it a phone viewport can stay on a shared browser.
- The tool description (`describeBrowseAct`) names the action in two sentences (when to use it, that a device
  change can reload the page, `reset`). The `browse_act` golden of the byte-identity test was updated on
  purpose: the new enum value, the four fields and the sentences.

## Consumers (Pen Editor)

- Backend: `browse_agent` gets `checks` (QA variant only) and `setup.emulate`;
  register `qa_assert` gated exactly like `qa_verdict`; cloud command name
  `assert`; descriptions + goldens.
- Desktop: `drainFailedRequests` in `window.ts` (+ `tabManager.ts` copy);
  `assert` command through `browserCommands.ts`, the `window.ts` switch and
  the preload.
- Frontend: `qa_assert` routed to `bridge.assert` + `evaluateQaChecks`; final
  checks; the new `QaResult` fields in `toJson`; tool name lists; cloud
  bridge `assert`. No UI changes.
- `browse_act` `viewport` (section 6): backend `tools.ts` takes the new schema from the package (descriptions and
  goldens change); the frontend/desktop/cloud bridge forwards `clearActEmulation` and calls it at the end of a
  run that does not go through `runBrowseAgent`.
