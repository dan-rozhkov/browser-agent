# PageFixture core — design (2026-10-15)

## Goal

A host prepares the state of the browser before a browse task: cookies,
localStorage, sessionStorage, the start URL, extra tabs, and deterministic
setup steps. The agent then starts from that state. The same format can be
captured from a live browser and applied again.

This is the core only. Out of scope:

- Login persistence in the cloud browser (dropped by decision, 2026-10-15).
- Network mocks. The `network` field is reserved. Any non-empty `network`
  makes `applyFixture` fail with `PageFixture.network is not supported yet`.
  A later QA sub-project implements it behind a host flag `allowNetworkMocks`.
- Capture of setup steps. `captureFixture` captures storage, URL and tabs only.
  The DOM and JS state of a page cannot be serialized: a modal or a half-filled
  form comes back only through `steps`.

## Format (`src/fixture/types.ts`, zod-free, isomorphic)

```ts
interface PageFixture {
  version: 1;
  /** Main tab start URL. Loaded after the storage is set. */
  url?: string;
  /** Extra tabs, opened after the main tab. The main tab stays current. */
  tabs?: string[];
  storage?: {
    cookies?: FixtureCookie[];
    origins?: { origin: string; localStorage?: Record<string, string>; sessionStorage?: Record<string, string> }[];
  };
  /** Deterministic steps on the main tab, run after `url` loads. No LLM. */
  steps?: FixtureStep[];
  /** Reserved. Non-empty => error "not supported yet". */
  network?: unknown[];
}
interface FixtureCookie { name; value; domain?; path?; url?; expires?; httpOnly?; secure?; sameSite?: "Strict"|"Lax"|"None" }
type FixtureStep =
  | { action: "goto"; url: string }
  | { action: "click"; selector: string }
  | { action: "type"; selector: string; text: string }   // native value setter + input/change
  | { action: "press"; key: string; selector?: string }
  | { action: "waitFor"; selector: string; timeoutMs?: number }
  | { action: "wait"; ms: number };
```

`parsePageFixture(input: unknown)` returns `{ ok: true, value } | { ok: false, error }`.
Error text names the field path and never contains a cookie value or a storage value.

## Target surface

`BrowserTarget` gets two optional methods (cookies live on the context, not on a page):

```ts
getCookies?(urls?: string[]): Promise<FixtureCookie[]>;
setCookies?(cookies: FixtureCookie[]): Promise<void>;
```

`PlaywrightTarget` implements them over `context.cookies()` / `context.addCookies()`.
That also covers Steel (it connects through `PlaywrightTarget`). The desktop
target implements them later over Electron `session.cookies`. A fixture with
cookies on a target without `setCookies` fails with a clear error.

Storage needs no new target method: it goes through `executeJavaScript` on the page.

## Apply order (`applyFixture(target, fixture, { signal? })`)

1. Validate. Reject `network`.
2. Cookies: `target.setCookies`.
3. For each storage origin: load `origin + "/"` in the main tab, set
   localStorage and sessionStorage by JS. (sessionStorage is per tab, so it is
   set in the main tab, which then navigates on the same origin.)
4. Load `url` in the main tab.
5. Open `tabs` with `target.newPage`, then select the main tab again.
6. Run `steps` in order on the main tab. A failed step stops the apply with
   `step N (<action> <selector>) failed: <reason>`.

Result: `{ ok: true, url, title, summary } | { ok: false, error }`.
`summary` is safe for the model: counts only, for example
`start page https://x/y; 2 cookies; storage for 1 origin; 1 extra tab; 3 setup steps`.
No cookie name, no value, no storage key.

## Capture (`captureFixture(target, { origins? })`)

Cookies (`getCookies`, filtered by `origins` when given), localStorage and
sessionStorage of the current page's origin (and of each open tab's origin when
the target lists tabs), `url` of the current tab, `tabs` = the other tabs' URLs.
The result is for the host only. It holds secrets.

## Controller and bridge

- `BrowserController.applyFixture(fixture)` / `captureFixture(opts)` run under
  the controller's exclusive lock and invalidate the last snapshot.
- `BrowserBridge` gets optional `applyFixture?` / `captureFixture?`;
  `controllerBridge` forwards them.

## Agent session

- `BrowseAgentRunOptions.setup?: (ctx: { signal }) => Promise<string>` — a host
  hook that runs before the first model request, inside the deadline and abort.
  It counts as one step. Its string is the model-safe text placed after the goal.
  `url` and `setup` together is an error.
- `runBrowseAgent({ fixture })`: builds `setup` from `browser.applyFixture`,
  then runs `browse_snapshot` and builds the first message with
  `fixtureSetupText(goal, summary, snapshotResult)`. A bridge without
  `applyFixture` gives status `error`. `url` and `fixture` together is an error.
- The `url`-only path stays byte-identical (golden tests).

## Secrets

The fixture never reaches the model: no message, no tool result, no error text
holds a cookie value, a storage key or a storage value. Tests assert this.

## Exports

New subpath `@sideform/browser-agent/fixture` (types, `parsePageFixture`,
`applyFixture`, `captureFixture`), in `exports` and `typesVersions`.

## As built (after two review rounds)

- `captureFixture` returns `{ ok: true, fixture } | { ok: false, error }`. `origins: []` captures nothing.
- `applyFixture` = `parsePageFixture` + `applyParsedFixture`. The controller validates once and calls `applyParsedFixture`.
- `FixtureHooks` (`navigate`, `openTab`, `press`, `settled`): the controller routes navigation through
  `openUnlocked` (bot check = error), extra tabs through the `tabs new` path (the desktop `newPage` ignores
  its url), keys through the shared `dispatchKeyPair` in `keys.ts`, and click/press settle through the `act`
  helpers. Without hooks, the standalone path does the same with plain target calls.
- The main tab is re-selected and re-resolved before every navigation and step. A popup cannot take over.
- Every page script has a 10 s cap. The controller wraps apply/capture in `withCommandTimeout` with
  `fixtureBudgetMs(fixture, { navigationMs, settleMs })`. Dialogs from nested opens are reported.
- Summary and error texts show URLs as origin + pathname only (no query, no hash).
- Storage origins are normalized to `URL.origin`. A path, query or hash is rejected.
- The session's first message is `${goal}\n\n${setupText}`. `runBrowseAgent({ fixture })` passes
  `fixtureSetupBody(summary, snapshot)`.
