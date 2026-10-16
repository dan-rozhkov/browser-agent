# Mid-task checkpoint — design (2026-10-16)

Sub-project 3 on top of the PageFixture core (`2026-10-15-page-fixture-design.md`)
and QA start (`2026-10-15-qa-start-design.md`).

## Goal

A host takes a checkpoint of the browser in the middle (or at the end) of a
browse task. Later, `applyFixture` rebuilds that state, also in a new browser.

Use cases:

- QA: re-run a failed task from the last good point, not from the start.
- Resume: the browser session was lost (a cloud session expired, the app
  restarted), and the task must continue from where it stopped.

## The problem and the decision

The DOM and the JS state of a page cannot be serialized. A modal that is open
or a form that is half filled exists only in the live page. So a checkpoint is:

```
checkpoint = base state + journal
base state = URL + cookies + storage, read at the last new document
journal    = the agent's state-changing actions after that new document,
             recorded as deterministic FixtureSteps with CSS selectors
```

The checkpoint is a normal `PageFixture`: `url` = base URL, `storage` = base
storage, `steps` = journal. Replay = `applyFixture`. No new apply code.

The base storage is read at the new document, NOT at capture time. Reason: a
step can change storage (for example "Add to cart" writes the cart to
`localStorage`). Storage read at capture time already holds that change, and
the replayed step would apply it a second time.

Server-side state is out of reach: a replayed "Add to cart" that also calls
the server adds a second item on the server. The host owns this (a test
server, network mocks, or `fresh`). The summary says how many steps replay.

## Journal (`BrowserController`)

Opt-in. Off by default: no cost for a host that does not use checkpoints.

```ts
controller.startJournal(opts?: { origins?: string[] }): string;   // the owner token
controller.stopJournal(token?: string): boolean;
controller.captureCheckpoint(token?: string): Promise<CheckpointResult>;

type CheckpointResult =
  | { ok: true; fixture: PageFixture; complete: boolean; gap?: string; summary: string }
  | { ok: false; error: string };
```

- `origins`: the cookies and storage of these origins go into the base state.
  Default: the base page's origin only. The desktop browser holds the user's
  real logins, so the default never reads the whole cookie jar.
- One journal per tab. The journal follows the agent's current tab (see "As built").

### New document = reset

The journal detects a NEW DOCUMENT with a marker planted in the page (see "As built"). A new document resets
that tab's journal:

1. `steps = []`, `complete = true`, `gap` cleared.
2. Base URL = the current URL.
3. Base cookies (`getCookies(origins)` when the target has it) and base
   storage (local and session storage, by page script).
   A read failure does not fail the command: the base then has no storage,
   and `gap` names it.

This covers a click that navigates, `browse_open`, back/forward/reload and a form POST. A `pushState` or hash
change is not a reset.

### Recorded actions

Only successful actions on the current tab's top frame:

| Agent action | FixtureStep |
|---|---|
| click | `{ action: "click", selector }` |
| type | `{ action: "type", selector, text }` |
| select | `{ action: "select", selector, value }` (new step kind) |
| press | `{ action: "press", key, selector? }` |
| `perform` CLICK / TYPE / SELECT | the same, one step per operation |

Not recorded: `scroll`, `wait`, and read-only commands (a `hover` is a gap, see "Review round 3")
(`snapshot`, `read`, `screenshot`, `findImages`). They do not change lasting
state. An action that causes a new document is not recorded: the reset makes
the new page the base.

### Selectors

A page script computes the selector of the target element BEFORE the action
runs (a click can remove the element). Order of preference:

1. `#id`, when the id is unique and does not look generated (no long run of
   digits or hex).
2. `tag[data-testid="…"]`, `tag[data-test="…"]`, `tag[data-qa="…"]`.
3. `tag[name="…"]`, `tag[aria-label="…"]`.
4. A path of `tag:nth-of-type(n)` from the nearest ancestor with a usable id
   (rule 1), or from `body`.

A candidate is used only when `document.querySelectorAll(sel)` returns exactly
that one element. Attribute values are escaped with `CSS.escape`.

### Gaps

The journal cannot always record a step. Then `complete = false`, `gap` holds
a model-safe reason, and recording stops until the next reset (a later step
can depend on the missing one). Reasons:

- the element is in an iframe;
- no unique selector;
- more than `CHECKPOINT_MAX_STEPS` (100) steps since the base.

`captureCheckpoint` still returns the base state and the steps before the gap.
The host decides whether a partial checkpoint is useful.

## New FixtureStep: `select`

`{ action: "select", selector: string, value: string }`. It sets the
`<select>` element's value by option value through the native setter, then
fires `input` and `change`. Parse error when the element is not a `select` or
no option has that value. The summary and errors never show `value`.

## Agent session

- `runBrowseAgent({ checkpoint: { origins?, onCapture } })` starts the journal before the setup
  or the start URL, and stops it in `finally`.
- When the run ends (done, error, timeout, step limit, abort), it calls
  `captureCheckpoint` and gives the result to `onCapture`, once. Not after
  `setup_failed`: then there is no task state to keep.
- The checkpoint is for the host only. `BrowseAgentResult` has no checkpoint field.
- `BrowserBridge` gets optional `startJournal?`, `stopJournal?`,
  `captureCheckpoint?`. `controllerBridge` forwards them. A bridge that lacks them
  gives `{ ok: false, error }` to `onCapture`, not a failed run.

## Secrets

The checkpoint holds cookie values, storage values and typed text. It is for
the host only. `summary` and `gap` hold counts, step kinds and
origin + pathname only. Tests assert this with sentinels, like the core.

## Out of scope

- Pen Editor integration. In Pen Editor the browser lives on between
  `browse_agent` calls, so no consumer needs a checkpoint now. A later change
  can add "resume from checkpoint" for an expired cloud session.
- Recording in iframes.
- Server-side state.
- Replay of `hover` and `scroll`.

## As built

Real deviations and additions, with the reason:

- **Marker, not tab and URL.** A first design compared tab and URL after each command. That reset on a `pushState` (the
  in-memory state was lost, yet the checkpoint said complete) and on a tab switch, and it missed a same-URL form POST and
  `location.reload()`. Now `DOC_MARKER_JS` plants a random token on a non-enumerable, non-writable, non-configurable
  `window` property at base time. After each command (and before it) the controller reads it. A missing or different
  token is a new document: reset. A bfcache back that restores an old document has another token, so it resets too.
  A pushState or hash change keeps the token: no reset, the steps continue on the old base. Replaying the base URL and the
  steps reproduces the SPA route, because the recorded click that pushed the state replays. No `forceReset` flags: `open`,
  reload, back and forward create a new document, so the marker covers them. A page that cannot be asked is a gap
  (`unknownDocument`). A base without a marker is re-based when one can be planted.
- **One journal per tab.** `JournalSession` (`src/controller/journal.ts`) keeps a `CheckpointJournal` per page handle in
  a `WeakMap`. The journal follows the current tab. Switching away and back continues that tab's journal. A tab first
  seen gets a fresh base at that moment. `captureCheckpoint` uses the current tab's journal; the other tabs are `tabs` URLs.
- **One staging point.** `withCommandTimeout` stages. A call site only declares a `JournalAction` (op, how to locate the
  element, frame, text or key) as its third argument; the four sites are `act` click, type and press, and `perform`.
  Staging runs inside the command timeout, before the action. One point for everything is not possible: the locate
  arguments are parsed per action, so each action path must declare them. A new action path that does not declare an
  action is not staged. The settle step keeps a safety net: a declared action that succeeded and staged nothing is a gap.
- **Command token.** Each command gets a `JournalCommand`. A stage from a command that is no longer the current one is
  ignored. A timed-out command keeps running, and its late stage cannot overwrite the next command's step. The overrun
  itself is a gap (`timeout`).
- **Failures are gaps.** A command that failed or threw after it staged a step or a gap is a gap (`failed`). A timed-out
  action is a gap (`timeout`), also when it timed out before it staged. A command rejected by argument validation before
  any page effect (a stale snapshot, a missing argument, an unparsable key) leaves no trace. A selector lookup that finds
  nothing is a gap (`noSelector`), because the action can still find its element. A `type` that was retargeted into another
  element (`retargeted: true` in the result) is a gap; computing a selector for the real target was not worth the risk.
- **`waitFor` before each action.** The journal records `{ action: "waitFor", selector }` before each click, type, select
  and press-with-selector (default timeout), so the replay waits for async content. They do not count toward
  `CHECKPOINT_MAX_STEPS`. The summary counts actions.
- **Base storage.** ONE reader, `readBaseState` (`src/fixture/capture.ts`), serves `captureFixture` and the journal's reset: the
  current page is read first (sessionStorage is per tab), other origins come from the other tabs, an empty store is left out.
  A failed read of the current page is a base gap. Cookies use `getCookies(origins)`. `origins: []` reads NOTHING: no cookie, no
  storage, and `getCookies([])` is never called (a real target reads it as every cookie of the profile).
- **Fixture as base.** After a successful `applyFixture` with the journal on, the current tab's base is the fixture: URL,
  steps (the base's steps; they do not count toward the cap) and storage. The storage is the state read BEFORE the apply
  (for the journal's origins and the fixture's origins, inside the apply's deadline) with the fixture on top: the fixture wins
  per cookie (name + domain + path) and per storage key, so the profile's other cookies and keys stay (an apply without `fresh`
  keeps them). With `fresh: true` the earlier state is ignored (not even read) and the checkpoint carries `fresh: true`. A
  pre-apply read that fails is a base gap. `origins: []` skips the pre-apply read. `network` and `expect` are not copied
  (the host's job). A fixture with steps and no URL cannot be replayed from the page it ended on, so it is a gap
  (`fixtureNoUrl`). A failed apply is a normal reset on the current page plus a gap (`fixtureFailed`): it may have run some steps.
- **More gaps.** A `type` into an element the apply `type` step cannot set (not `input`/`textarea`, or `range`/`file`),
  a `select` on a non-`select` element, an element in a shadow tree. Messages: `CHECKPOINT_GAPS` in `src/fixture/checkpoint.ts`.
- **`checkpoint` option.** `checkpoint?: { origins?; onCapture(result) }`. `checkpoint: true` is gone and the result has no
  `checkpoint` field (owner decision: a secret must not be one `JSON.stringify(result)` away from the model). `onCapture`
  runs once, a throw in it is ignored. The recorder (`createCheckpointRecorder`, `src/agent/checkpoint.ts`, exported from
  `agent/session`) bounds each journal call to 15 s, passes the bridge answer through `parsePageFixture`, and returns the
  result to its caller directly. The race-with-timer helper is shared with the fixture release (`src/agent/bounded.ts`).
- **Types.** `CheckpointResult`, `CheckpointJournalOptions` and `CHECKPOINT_MAX_STEPS` live in `src/fixture/types.ts`, so
  they come with the `fixture` subpath and the root barrel. No new subpath.

### Review round 2

- **Reader.** `readBaseState` is the one reader (see "Base storage"). `origins: []` is no origin at all.
- **back / forward** declare a `history` action. After it, an unchanged marker (the same document, an SPA popstate) is a gap
  (`history`), a new document is the normal reset. A move the command refused (no history) is no gap.
- **Callback.** `onCapture` may be async; its rejection is swallowed.
- **No start URL.** Steps on a base without an http(s) URL are a gap (`noStartUrl`), also when the base never had one.
- **Key-only `press`.** The replayed `click` is `el.click()` and does not focus, so a bare replayed key would go to the body.
  At stage time `SELECTOR_JS` (`op: "active"`) reads `document.activeElement`: the body (or nothing) records a bare `press`;
  another element records `press` with its selector (the apply `press` focuses its selector first); an iframe or no unique
  selector is a gap. Decision: the `click` replay is NOT changed to focus (it would alter every hand-written fixture; a later
  `type` focuses by itself, and a later key press carries its own selector). Pinned by the live check in `fixture-smoke`.
- **Fixture base** keeps the profile's earlier state, see "Fixture as base".
- **Read-only commands do no journal work.** Only a command that may change the page runs sync or settle: the declared actions
  (click, type, select, press), `open`, reload, back, forward and `tabs` new/switch/close. A snapshot, read, screenshot, findImages,
  `tabs` list, hover, scroll or wait makes no marker, cookie or storage read. The sync before an action runs INSIDE the command's
  timeout. The settle after it is bounded to `JOURNAL_SETTLE_BUDGET_MS` (10 s) beyond the command's budget; on overrun the tabs
  get a gap (`unknownDocument`) and the late work may not write. `applyFixture` has its own handling and its pre-apply read is
  inside its deadline (budget plus 8 s). `captureCheckpoint` checks the marker of the current tab (bounded) and, when that tab has
  no base yet, reads it then: with no recorded step there is nothing to apply twice.
- **Ownership.** `startJournal` returns an owner token. A second `startJournal` REPLACES the running journal and its old token
  is stale: `stopJournal(oldToken)` does nothing (returns false) and `captureCheckpoint(oldToken)` returns an error. Without a
  token both act on whatever journal runs (hosts that predate tokens). `BrowserBridge.startJournal` returns `string | void |
  Promise<string | void>`; `stopJournal(token?)` and `captureCheckpoint(token?)` get the token; `controllerBridge` forwards them.
  The recorder keeps its token and stops only with it. A start that answers after the recorder stopped (or timed out) is
  stopped at once with its own token; a start that failed is not stopped.
- **Run end.** No capture after `setup_failed`, after `aborted`, or when the run made no browser command (`steps === 0`, for
  example a call without a goal). The journal is still stopped (bounded 15 s by the recorder), but the result waits for the
  stop at most 2 s; the stop goes on in the background.

### Review round 3

- **A miss that dispatched nothing is no gap.** A lookup that finds nothing still stages a `noSelector` gap, because the
  action may find its element. When the action then fails, the settle step drops the trace if the page script proved it
  touched nothing. The scripts (`CLICK_JS`, `TYPE_JS`, `CLICK_RESOLVE_JS`, `PERFORM_JS`) return `noEffect: true` on a refusal
  before any effect: no element, hidden, disabled, no such option, not a select. `executeScript` turns that into a symbol
  tag on the error result (`NO_EFFECT`) and removes the field, so a host never sees it. Any other failure stays a `failed` gap.
- **Same-document navigation is a gap.** `open`, reload and `tabs` declare `nav` with the tab's URL. If the document is the
  same and the URL changed, the tab gets the gap `sameDocumentNav`. A tab switch or a new tab does not change the acted tab's URL: no gap.
- **Timeout plus new document.** After the reset, a timed-out action still adds the `timeout` gap to the new base: the overrun
  can keep changing the new page.
- **The sync runs before the command's budget.** `withCommandTimeout` calls `journalPrepare` first. It declares the command,
  syncs the tab (new tab: base; new document: reset) and stages the action, all bounded by `JOURNAL_SETTLE_BUDGET_MS`. Then the
  command's own timer starts. On overrun the tab gets a gap (`unknownDocument`), the late work cannot write, and the action
  runs with its full budget. If the overrun left the tab without a base, the settle step reads one and adds the gap.
  The "As built" rule "the sync before an action runs INSIDE the command's timeout" is replaced by this.
- **One round trip.** `SELECTOR_JS` returns the document marker too (`DOC_MARKER_FN_JS` is shared with `DOC_MARKER_JS`), and the
  pre-action check uses it. A journaled action on a tab with a base costs 2 page calls (lookup with marker, settle marker), was 3.
  The lookup is bounded to `JOURNAL_MARKER_TIMEOUT_MS`; no answer is `unknownDocument`. With a journal gap, a frame target or a stale
  snapshot the lookup is skipped and a plain marker check runs.
- **Hover is a gap.** `hover` declares itself. When it succeeds, the tab gets the gap `hover`. A failed hover changed nothing: no gap.
  The tab is synced before the hover, so a first-command hover also ends in the gap. `scroll` stays unrecorded and is no gap.
  Known limit: a page with infinite scroll or lazy content may lack an element on replay. The apply then fails loudly at that step.
- **Cookie key.** `mergeStorage` keys a cookie by name + exact domain form + path. `.a.test` (domain cookie) and `a.test`
  (host-only) are two cookies. A `url` cookie is host-only.
- **Select.** If the chosen option's value is shared by another option, the lookup says `option-not-unique` and the tab gets the gap
  `optionNotUnique`. In `applyFixture` the `select` step runs through the `settled` hook like `click` and `press`, and
  `fixtureBudgetMs` adds the settle time for it.
- **One race helper.** `boundedCall` and `withTimeout` in `src/fixture/util.ts` are the only race of a call against a timer.
  `raceTimeout`, `agent/bounded.ts`, the inline races in `journalBounded` and `releaseFixture`, and the controller's own
  `withTimeout` are gone. The controller already imports from `src/fixture`; the helper has no imports but a type.
- **One owner of the command flags.** Only `JournalSession` writes `mutating`, `expectsAction`, `actedPage`, `history`,
  `successGap`, `navUrlBefore`, `timedOut` and `preOverrun` (`declare`, `skipSettle`, `markTimedOut`, `markPreOverrun`).
  `stage` no longer sets `mutating`. A command must declare first.
- **Run helper.** `createRunCheckpoint` (`src/agent/checkpoint.ts`, exported from `agent/session`) holds the run-end lifecycle
  that `runBrowseAgent` and session hosts shared by copy. `begin()` is true only when the recorder's start really succeeded (`recorder.started()`). The recorder
  bounds the start once, by `min(timeoutMs, CHECKPOINT_START_WAIT_MS)` (`startTimeoutMs`); `begin()` only races the abort signal. An already
  aborted signal, a `finish()` that came first or `enabled: false` never calls the browser (disabled builds no recorder and no timer); a late start is stopped by its token. `finish()` returns
  `undefined` only for a deliberate skip (disabled, `setup_failed`, `aborted`, steps not above 0; the statuses are typed on
  `BrowseAgentStatus`); a journal that did not start gives `{ ok: false, error }` with the recorder's own error, or
  `"the checkpoint journal did not start"` after a begin abort, so `onCapture` always hears it. It does
  not check the signal after the capture (as `runBrowseAgent` never did): a host checks its own. It runs `beforeStop(captured)`,
  then stops in a `finally` and waits for the stop at most `CHECKPOINT_STOP_WAIT_MS` (2 s). `settled` is one deferred, resolved once
  when the recorder's tracked journal calls (start, late-start stop, stop; `recorder.idle()`) have really settled, or at the latest
  `CHECKPOINT_SETTLE_CAP_MS` (2 x the default call bound) when the browser does not answer (best effort). `runBrowseAgent` always creates the helper (`enabled = !!checkpoint`) and has one cleanup
  path; its order stays: capture, `onCapture`, fixture release, stop.
