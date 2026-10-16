# QA start — design (2026-10-15)

Sub-project 2 on top of the PageFixture core (`2026-10-15-page-fixture-design.md`).
A QA host turns a fixture into a test case: prepare state X, check that X is
really there, then give the task to the agent. Three parts.

## 1. Expect: "am I in the right place"

```ts
interface PageFixture {
  // ...core fields
  expect?: {
    selector?: string;      // an element matching it exists and is visible
    text?: string;          // the page's visible text contains it
    url?: string;           // URL pattern, same matcher as network rules (see 2)
    timeoutMs?: number;     // default 5000, max 30000; polls like waitFor
  };
}
```

- At least one of `selector`, `text`, `url` when `expect` is present (parse error otherwise).
- Checked on the main tab after `steps`. All given conditions must hold at once.
- Failure: `applyFixture` returns `{ ok: false, stage: "expect", error }`.
  `error` names the failed condition: the selector, the expected text (author-written, quoted
  up to 80 chars), or the actual URL as origin+pathname.
- Every apply failure gets a `stage`: `"validate" | "prepare" | "network" | "reset" | "cookies" | "storage" | "url" | "tabs" | "steps" | "expect"`. `prepare` is the main-tab detection (and any failure before a feature stage). Prechecks (gate, missing target method) run under the stage of the feature checked, only for features the fixture uses, and before anything changes.

### Agent status `setup_failed`

`BrowseAgentStatus` gets `"setup_failed"`. The session returns it when the `setup`
hook throws (a `SetupError` class, exported, or any throw from setup). `runBrowseAgent`
throws `SetupError(stage, message)` when `applyFixture` fails. So a QA host tells
"the preparation broke" (`setup_failed`, the model never ran) from "the agent or the
site failed" (`done`/`error`/...). `result.error` holds the message, `result.setupStage`
the stage. No model request is made after a setup failure.

## 2. Network mocks (`network`, behind `allowNetworkMocks`)

```ts
interface FixtureNetworkRule {
  url: string;            // pattern: full URL with `*` wildcards (`*` = any chars), e.g. "https://api.shop.test/cart*"
  method?: string;        // default any; case-insensitive
  status?: number;        // default 200
  headers?: Record<string, string>;
  body?: string | object; // object => JSON.stringify + content-type application/json if not given
  delayMs?: number;       // max 30000
  abort?: boolean;        // fail the request (network error) instead of responding
  times?: number;         // apply at most N times, then let requests through
}
```

- The matcher (`matchUrlPattern`, `pickNetworkRule`) is isomorphic and lives in `src/fixture/network.ts`.
  First matching rule wins (fixture order). Rules with exhausted `times` are skipped.
- Target surface: optional `BrowserTarget.routeRequests?(handler): Promise<() => Promise<void>>`.
  `handler(req: { url, method }) => FixtureMockResponse | undefined` — `undefined` lets the request
  through. The returned function removes the interception.
  `PlaywrightTarget` implements it with `context.route("**/*", ...)` + `context.unroute`
  (covers popups and every tab of the context). A request no rule mocks goes to `route.fallback()` (never `continue()`), so the host's own route handlers still run; so does a delayed request after removal. A delay is a signal-aware sleep on one AbortController per installation. Other targets lack it.
- Applied right after validation and reset (before cookies), so the first page load is already mocked.
- Gate: `applyFixture(..., { allowNetworkMocks: true })`. Without the flag, a non-empty
  `network` fails with stage `network`: `network mocks are disabled (allowNetworkMocks is off)`.
  A target without `routeRequests` fails with stage `network`: `this browser cannot mock network requests`.
  Replaces the core's "not supported yet".

### Lifetime

Mocks must live until the end of the task, not until the end of `applyFixture`.

- `applyFixture` success result gains `release(): Promise<void>` (idempotent) when it installed
  anything that must be undone (mocks). Without mocks, `release` is a no-op.
  If `applyFixture` fails after installing mocks, it removes them itself before returning.
- If the apply finishes after its signal aborted (the host stopped waiting: deadline, abort), it removes its own mocks and fails with `aborted`. `controller.releaseFixture()` waits for an apply still in flight, then releases what it produced. A failing release of the previous fixture never rejects the next `applyFixture` (it is marked released first).
- `BrowserController` keeps the active release. `controller.releaseFixture()` calls it.
  A new `applyFixture` on the same controller releases the previous one first.
  `BrowserBridge.releaseFixture?()`, `controllerBridge` forwards.
- `runBrowseAgent({ fixture })` calls `browser.releaseFixture?.()` in `finally`
  (done, error, timeout, abort, setup failure). A bridge that applied mocks but has no
  `releaseFixture` is a setup error (refuse rather than leak mocks).
- Desktop safety: the desktop target runs in the user's real profile. Rules must be scoped to the agent's tabs.
  Implemented in pen-editor-desktop 673bcbc (2026-10-15): CDP `Fetch` per built-in-browser tab (pattern `*`,
  Request stage), never `session.webRequest`. Editor tabs are never routed.
  The scoping is only partly met. Mocks apply to EVERY built-in-browser tab, also tabs the user opened by hand.
  Rules match only the fixture's URLs; other requests pass through.
  CDP `Fetch` is per page target: out-of-process iframes and service workers are not intercepted.
  Mocks are released when the editor tab that drove the run reloads, crashes or closes.
  If the agent's current tab has no debugger, `routeRequests` fails instead of reporting mocks it cannot deliver.

## 3. Repeatability: `fresh`

```ts
interface PageFixture { fresh?: boolean }   // default false
```

- `fresh: true` → before anything else, `target.resetSession(origins?)`. `applyFixture` passes the fixture's own origins (url, tabs, storage origins, `goto` steps) so those are always cleared. A target without it fails
  with stage `reset`: `this browser cannot reset its session`.
- `PlaywrightTarget.resetSession(origins?)`: close every page but one (open one if none), load `about:blank` in it, then `context.clearCookies()`, `context.clearPermissions()`, and clear storage
  (localStorage, sessionStorage, IndexedDB, cache storage, service workers) for every origin the
  target has seen: track origins from each page's main-frame `framenavigated` events (subframes are not tracked; the list keeps the 500 newest, least recently seen evicted first) plus the given `origins`, then
  CDP `Storage.clearDataForOrigin({ origin, storageTypes: "all" })` per origin, at most 8 at a time. A failed clear fails the reset. `fresh` adds one navigation plus 15 s to the fixture budget.
- The desktop target must NEVER clear the whole profile (it would log the user out of everything).
  Documented in README and CLAUDE.md invariants.
  Implemented in pen-editor-desktop 673bcbc (2026-10-15) with a narrower contract than `PlaywrightTarget`:
  `resetSession(origins)` works on the `persist:penbrowser` partition only, never the editor session.
  It closes every browser tab and opens one blank tab.
  It clears cookies and site data ONLY for the given origins (validated first, http/https only).
  Parent-domain cookies (`.example.com`) stay. Cookies ignore ports, so `localhost:3000` clears every localhost port.
  Without origins, only the tabs are reset. Other logins survive.
- Recommended for full isolation: one new Playwright `BrowserContext` per QA run
  (README example). `fresh` covers a reused context.

## Model-facing text

- The fixture summary adds counts: `2 network mocks`, `fresh session`, `expect checked`.
  No rule URL, no body, no header.
- Error texts follow the core rule: URLs as origin+pathname, no cookie/storage values,
  no mock body or header values.

## Out of scope

- A test-case runner / reporter (pass/fail of the agent's goal). Hosts own it.
- Capture of network traffic into rules.
- Desktop implementations of `routeRequests`, `resetSession`, cookies. (Done later in pen-editor-desktop 673bcbc, 2026-10-15; see "Desktop safety" and `fresh`.)

## As built, round 2 (review fixes)

- **Stages.** `tabs` and `steps` are entered only when the fixture has tabs or steps. The last main-page read, and an abort between the prechecks and the first feature, report `prepare`.
- **URL patterns** (network `url`, `expect.url`): the scheme is lowercased, and the host too when no `*` touches it; a bare origin (`https://a.test`) means origin + `/`. Nothing else is normalized: no percent-encoding, a pattern matches the URL as the browser sends it (encoded).
- **Parse.** A mock `status` is 200-599. A header name is an HTTP token (non-empty, no whitespace or colon); a value has no CR or LF. The error names the header's index, never its name or value.
- **Failed answers.** If `route.fulfill` or `route.abort` rejects, `PlaywrightTarget` tries `route.fallback()`, and `route.abort()` as the last resort, so a request never hangs.
- **Ownership.** `BrowserController.applyFixture` returns `fixtureToken` (opaque, no secrets) when it installed mocks. `releaseFixture(token?)` / `BrowserBridge.releaseFixture?(token?)` release only the fixture that token names (nothing if a newer apply replaced it); no token releases whatever is active, after waiting at most 5 s for an apply still in flight (past that, the abandoned apply releases its own mocks when it ends). `runBrowseAgent` releases with the token of its own apply, bounded to 10 s, and releases nothing when its apply returned no token (a failed apply cleaned up itself).
- **`resetSession(origins?)`** closes ALL tabs in parallel and opens one new blank tab (sessionStorage and history are gone), then clears cookies, permissions and storage, 16 origins at a time. `applyFixture` stops a reset that runs past 15 s with `resetting the session took too long` (stage `reset`). One shared `httpOrigin(url)` (`src/fixture/util.ts`) serves the apply, the capture and the adapter.
- **Limitation of `fresh`.** Cookies are cleared everywhere. Storage is cleared only for the origins this `PlaywrightTarget` instance saw in main-frame navigations plus the fixture's own origins. A reconnected target (a new `PlaywrightTarget` on an old context) or a third-party iframe may keep storage. For full isolation use a new `BrowserContext` per run. There is no code workaround.
