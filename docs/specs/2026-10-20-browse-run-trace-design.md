# Browse run trace — design (2026-10-20)

A **trace** is a recorded browse run that a person can replay in a viewer:
steps with timing, screenshots per step, console errors, failed requests and
the QA result. It is our own format, not Playwright's `trace.zip`. There are no
DOM snapshots.

Decisions of the owner:
- Own format. The package `@sideform/browser-agent` records it, for both
  browser paths (desktop Electron controller and cloud Steel/Playwright).
- Storage: locally on the desktop (Electron userData), in R2 when the run
  executes in the Steel cloud browser.
- No DOM snapshots.
- Viewer: a separate route `/trace/:id` in pen-editor (Base UI) and a tab
  kind `trace` in pen-editor-desktop.

## Why the recorder works at the tool-call level

The run loop runs in the host (pen-editor runs it in the renderer through
`createBrowseAgentSession`; `runBrowseAgent` runs it in Node). The host sees
every tool call and every result. Main (desktop) and the backend (cloud) only
execute single commands. So the recorder is a host-side object fed from the
`executeTool` seam, the same seam as the QA `createStepRecorder`.

## Part 1 — package `browser-agent` (mechanism only)

New zod-free module `src/shared/trace.ts` (types + pure helpers) and
`src/agent/traceRecorder.ts` (recorder). Both are exported from `./agent/session`
(zod-free entry) and `./agent`. No file writers, no UI, no storage
(see "mechanism, not policy").

### Format v1

```ts
export const BROWSE_TRACE_FORMAT = "sideform.browse-trace";
export const BROWSE_TRACE_VERSION = 1;

export interface BrowseTrace {
  format: typeof BROWSE_TRACE_FORMAT;
  version: typeof BROWSE_TRACE_VERSION;
  id: string;                 // [A-Za-z0-9_-]{1,64}
  goal: string;               // capped at 4000 chars
  startedAt: number;          // epoch ms
  endedAt: number;            // epoch ms
  status: string;             // BrowseAgentResult.status
  answer?: string;            // capped at 4000 chars
  error?: string;             // capped at 2000 chars
  labels?: Record<string, string>; // free-form host labels, e.g. { browser: "cloud" }
  steps: BrowseTraceStep[];
  frames: BrowseTraceFrame[];
  console: BrowseTraceLogEntry[];  // console errors
  network: BrowseTraceLogEntry[];  // failed requests ("<METHOD> <status|error> <origin><path>")
  qa?: QaResult;
  dropped?: { steps?: number; frames?: number; console?: number; network?: number };
}

export interface BrowseTraceStep {
  index: number;              // 0-based, call order
  tool: string;
  args: unknown;              // redacted, see below
  startedAt: number;
  endedAt: number;
  ok: boolean;
  error?: string;             // capped at 2000 chars
  output?: string;            // JSON/text of the result, image data removed, capped at 4000 chars
}

export interface BrowseTraceFrame {
  id: number;                 // 0-based, unique in the trace
  at: number;                 // epoch ms
  stepIndex?: number;         // step the frame belongs to
  kind: "step" | "screenshot" | "final";
  src: string;                // data URL in memory; asset path or URL after storage
  width?: number;
  height?: number;
}

export interface BrowseTraceLogEntry { at: number; stepIndex?: number; text: string }
```

Redaction of `args`: any object key that matches
`/pass(word)?|secret|token|api[-_]?key|otp|cvv|card/i` gets the value `"[redacted]"`,
recursively. Typed text: in an object with `action` `type` or `fill` (a `browse_act` call and each
entry of `actions`), `text`/`value` become `"[redacted]"` when `target`, `element`, `label`,
`selector`, `name` or `placeholder` matches `/pass|pwd|secret|otp|one.?time|code|pin|cvv|cvc|card|token|key|ssn/i`,
or when `inputType`/`type` is `"password"` (the act schema has no such field today). A call that names the
field only by `index` keeps its text. The default redactor keeps one bit of state per run: whether the last
`click`/`focus`/`type` target looked secret, so a `type` without a target right after a click on such a field
is redacted too (a click by `index` resets it). A step whose typed text was redacted gets no frame. Strings longer than 2000 chars are cut. The host can pass its own
`redactArgs`.

### Recorder

```ts
export interface BrowseTraceRecorderOptions {
  id?: string;                // default: random 22-char id
  goal: string;
  now?: () => number;         // default Date.now
  labels?: Record<string, string>;
  /** Take a screenshot of the current page. Returns a data URL. */
  capture?: () => Promise<{ imageData: string; width?: number; height?: number; dialogs?: unknown[] } | undefined>;
  /** Which finished calls get a "step" frame. Default (a failed call too, since 2026-10-21): browse_open;
   *  browse_act except a lone `wait`; browse_tabs switch/close/new. */
  captureAfter?: (tool: string, args: unknown, ok: boolean) => boolean;
  captureTimeoutMs?: number;  // default 4000; a throw = no frame, never an error. ONE timeout stops all later
                              // step captures (the screenshot may still hold the browser); lost and skipped
                              // captures are counted in dropped.frames
  redactArgs?: (args: unknown) => unknown;
  maxSteps?: number;          // default 300
  maxFrames?: number;         // default 150
  maxLogEntries?: number;     // default 300 per log
}

export interface BrowseTraceRecorder {
  readonly id: string;
  /** Same shape as StepRecorder.onToolCall. The returned function is async:
   *  await it before the result goes back to the model, so the step frame
   *  shows the page right after this step. */
  onToolCall(call: { toolName: string; input: unknown }, ctx?: { signal?: AbortSignal }):
    (end: { output?: unknown; error?: unknown }) => Promise<{ dialogs?: unknown[] }>;
  addFrame(frame: { imageData: string; kind?: "step" | "screenshot" | "final";
                    width?: number; height?: number; stepIndex?: number }): void;
  finish(end: { status: string; answer?: string; error?: string; qa?: QaResult }): BrowseTrace;
}
export function createBrowseTraceRecorder(opts: BrowseTraceRecorderOptions): BrowseTraceRecorder;
```

Rules:
- An output with `imageData` (a `browse_screenshot` result) becomes a
  `"screenshot"` frame. The stored `output` drops the image data.
- Outputs with `consoleErrors` / `failedRequests` arrays (act, perform, assert
  results, also inside JSON strings) append to `console` / `network`, deduped
  over the whole run (a seen-set, shared with the QA recorder). The controller's own
  `consoleErrorsDropped` / `failedRequestsDropped` counts add to `dropped.console` / `dropped.network`.
- `qa.consoleErrors` / `qa.failedRequests` passed to `finish` are merged the same way.
- The trace carries no QA step args (2026-10-21). The QA step recorder keeps the raw input of each call (a typed
  password included) and traces go to a public bucket; `steps` already holds the redacted args of every call. So in
  `trace.qa` each step keeps `index`, `tool`, `ok`, `error` and `ms`, and `args` is the fixed string `"[omitted]"` (the
  `QaStep` type requires the field). The `qa` in the run result and the object the host passed to `finish` are not
  changed. Nothing reads these args: the viewer uses `qa.stepsDropped` only.
- Page-load diagnostics (2026-10-21): the controller's public `open` drains the console errors and failed requests
  like `act`/`perform`/`assert` do, so an error thrown while `browse_open` loads a page has the `stepIndex` of the
  open step, not of the next `browse_act`. `tabs` with `action: "new"` and a valid `url` drains the same way, once, in that branch (a refused open, an empty or invalid url drain nothing); `applyFixture` calls
  `openUnlocked` and does not drain. The QA step recorder records no step for a pre-open call (the start page) but
  harvests its `consoleErrors` / `failedRequests`, so a start page that throws on load reaches `qa.consoleErrors` and
  the `no_console_errors` / `no_failed_requests` checks.
- A step takes its slot (index = call order) when the call starts, so `steps` is in call order and
  parallel calls cannot pass `maxSteps`. Calls still pending at `finish` become steps with
  `ok: false`, `error: "unfinished"`, `endedAt` = finish time.
- No step frame is taken when `ctx.signal` is aborted (counted in `dropped.frames`); an abort during a
  capture ends the wait at once.
- Dialogs: every controller command, a screenshot too, drains the pending JS dialogs of all tabs. The capture
  returns them as `dialogs`; the end function resolves to `{ dialogs }`; the host merges them into the tool output
  with `mergeCarriedDialogs(output, dialogs)` (output's own `dialogs` first, carried ones appended: the
  controller's `mergeDialogs` rule). `runBrowseAgent` does this itself, so tracing does not change what the model sees.
  A capture that times out may drain dialogs nobody receives.
- Raw base64 `imageData` (no `data:` prefix) is turned into a data URL by magic bytes (jpeg, png, webp).
- Caps drop the OLDEST frames past `maxFrames` (keep first frame) and count
  them in `dropped`. Steps and logs past their caps are dropped from the end
  and counted.
- `finish` is idempotent (second call returns the same object) and never throws.
- The recorder never throws into the host from `onToolCall`/`end`.

### Pure helpers (shared/trace.ts)

```ts
/** Moves data-URL frames out of the manifest. frame.src becomes "frames/<id>.<ext>". */
export function splitTraceAssets(trace: BrowseTrace):
  { manifest: BrowseTrace; assets: { path: string; dataUrl: string; contentType: string }[] };
/** Maps each frame.src through resolve (for a stored manifest). */
export function mapTraceFrames(trace: BrowseTrace, resolve: (src: string) => string): BrowseTrace;
/** Structural check of an unknown JSON value. Returns the trace or an error string. */
export function parseBrowseTrace(value: unknown): { trace: BrowseTrace } | { error: string };
export const BROWSE_TRACE_ASSET_PATH = /^frames\/\d{1,4}\.(jpg|png|webp)$/;
export const BROWSE_TRACE_ID = /^[A-Za-z0-9_-]{1,64}$/;
```

`parseBrowseTrace` checks `format`, `version`, `id`, the arrays and the frame
fields. `frame.src` must be an image data URL (jpeg, png, webp), a path matching
`BROWSE_TRACE_ASSET_PATH`, an `https:` URL, or `http://localhost` / `127.0.0.1`. Consumers (backend, desktop main, viewer) use it as the trust boundary.

### runBrowseAgent

`RunBrowseAgentOptions.trace?: { labels?; capture?: boolean (default true); onTrace?(trace: BrowseTrace) }`.
When set, `runBrowseAgent` builds a recorder (capture = `browser.screenshot`), feeds it from its
`executeTool` wrapper (passing the tool's abort signal), adds the QA final screenshot as a `"final"`
frame (the same image `qa.onScreenshot` gets; taken once), and calls `onTrace(trace)` once at the end,
after the fixture release and the journal stop (bounded to 15 s, errors swallowed, not called when the run
throws). The trace is NOT a field of the result and never in the JSON for the model; the host decides
what to do with it.

## Part 2 — pen-editor-backend (R2 for cloud runs)

- `POST /api/browse/traces` — body `{ userId?, manifest, assets: [{ path, dataUrl }] }`.
  - `requireUserId`. Rate limit 20/min per IP, and 200 traces/day per userId and per IP (in memory, 429). `bodyLimit` 24 MB.
  - 503 when `resolveS3Target` is null.
  - `parseBrowseTrace(manifest)` (from `@sideform/browser-agent/agent/session`), else 400.
  - At most 160 assets. Each `path` matches `BROWSE_TRACE_ASSET_PATH`, is referenced
    by a frame (every frame `src` must be an asset path), decodes to ≤ 3 MB, and `sniffImageType` accepts it with a type that matches the path extension (no GIF). Else 400. The rewritten manifest is capped at 4 MB (413).
  - The server makes the id: `randomUUID()`. Objects: `browse-traces/<id>/<path>`,
    then the manifest at `browse-traces/<id>/trace.json` with `id` = server id,
    frame `src` = public URL, and `ownerHash` (sha256 hex of the userId) added at the top level. The raw userId is never stored: the object is public. On an upload failure or a client abort the objects already written are deleted (best effort), `trace.json` is not written, and the answer is 502.
    Write-once keys (objects are cached immutable).
  - Response `{ id }`.
- `GET /api/browse/traces/:id` — `id` must be a UUID, else 400. Reads
  `trace.json` through a new `getObjectText(target, key)` in `src/services/s3.ts`
  (the bucket has no CORS, the browser cannot fetch it directly). 404 when the
  object is missing, 502 on other storage errors. The id is lowercased before the key is built. Returns the manifest without `ownerHash`/`owner`. The UUID is the
  capability (same model as public bucket objects). Frames load straight from
  the public R2 URL with `<img>` (no CORS needed).
- Tests with the S3 mock pattern of `test/upload-route.test.ts`.

## Part 3 — pen-editor-desktop (local storage + trace tab)

- Pure module `src/main/traceStore.ts` with an fs port (credentialStore pattern):
  - dir `userData/browse-traces/<id>/trace.json` + `frames/<n>.<ext>`.
  - `save({manifest, assets})`: validates with `parseBrowseTrace` (the package is
    already a dependency; CommonJS consumer — use the `agent/session` subpath,
    check it loads under `typesVersions`), id format, ≤ 160 assets, each ≤ 3 MB,
    manifest JSON ≤ 4 MB, every asset path referenced. Writes tmp + rename.
    Keeps the newest 100 traces; deletes older dirs. Returns `{ id }` or `{ error }`.
  - `read(id)`: returns the manifest with frame `src` turned into data URLs, or `{ error }`.
  - Paths never leave the traces dir (id regex + asset regex, no `..`).
- IPC (`ipcMain.handle`, payload errors return `{ error }`, never throw):
  - `traces:save` — sender is the agent panel or an editor tab.
  - `traces:read` — sender is a trace tab, the panel, or an editor tab.
  - `traces:open` — panel only. Focuses an open trace tab for the id or opens one.
  - Add the channels to `test/ipcContract.test.ts` and the CLAUDE.md IPC list.
- Preload: `penAgentPanel.traces = { save, open }`, `penDesktop.traces = { save, read }`.
- Tab kind `"trace"` (pattern of `"doc"`): `resolveTraceTabUrl(base, id)` →
  `/trace/<id>?src=local&chat=off`, `isValidTraceId`, tab bar icon, title from
  `page-title-updated`. Not in the "+" menu (a trace tab opens from a run only).

## Part 4 — pen-editor (collect, store, view)

- Bump `@sideform/browser-agent` to the tag that has the trace module
  (0.3.0's breaking change is only `BrowserController.cursorMotion`, unused here).
- `src/lib/tools/browser/browseAgent.ts`: one recorder per `browse_agent` run with `qa: true` (2026-10-20: other runs keep no trace).
  - An app run (`app`) records its launch (`browse_open { app }`, run in the session `setup`) as step 0 with a frame of the app window.
  - `capture` = `bridge.screenshot` of the run's bridge (desktop or cloud).
  - Feed it from the `executeTool` wrapper next to the QA recorder; await `end`.
  - Labels: `{ browser: "desktop" | "cloud", mode: "qa", app?: <app name> }`.
  - At the run end (both finish paths, after the judge settles), `finish(...)`,
    then store: desktop bridge present → `traces.save` over the bridge;
    otherwise (cloud) → `POST /api/browse/traces` with `splitTraceAssets`.
    Bounded by 15 s; a failure only logs. The tool result gets
    `trace: { id, source: "local" | "cloud" }` when the save succeeds.
- `src/lib/browseTraces.ts`: `saveBrowseTrace`, `loadBrowseTrace(id, source)`.
  Local load uses `window.penDesktop?.traces?.read`.
- Route `/trace/:id` (lazy, like `/doc`; `?src=local|cloud`, default cloud;
  no bridges bootstrap): `src/routes/TracePage.tsx` + `src/components/trace/*`.
  - Header: goal, status / QA outcome badge, duration, step count, browser label.
  - Filmstrip of frames along a time axis, click to select.
  - Left: step list (tool, short args summary, duration, ok/error). Selecting a
    step selects its last frame.
  - Center: large frame, before/after toggle (previous step's frame vs this step's).
  - Bottom, full width: Base UI Tabs — Console, Network, QA (verdict, reason, checks, judge). (The Step details tab was removed on 2026-10-20.)
  - Keyboard: ←/→ previous/next step.
  - States: loading, not found, invalid format.
- `BrowseAgentIndicator`: a "View trace" button when the result has `trace`.
  In the desktop agent panel → `penAgentPanel.traces.open(id)` (opens a trace tab).
  Elsewhere → `window.open("/trace/<id>?src=cloud", "_blank")`. A local trace
  without the panel bridge shows no button.

## Not in scope

- A log of ALL network requests: done 2026-10-21 (see "v1 additions"). The desktop handle must implement
  `BrowserPageHandle.drainRequests` itself.
- `browse_task` (rollback-only tool) is not traced.
- Retention of R2 traces (no TTL yet). Import of Playwright `trace.zip`.

## v1 additions (2026-10-21)

All additive and optional: no version bump, no new frame kinds. An older viewer keeps unknown fields
(`parseBrowseTrace`).

- **Frame after a failed action.** The default `captureAfter` also captures after a FAILED `browse_open`,
  `browse_act` (not a lone `wait`) and `browse_tabs` `switch`/`close`/`new`, so a viewer shows the page at the
  failure, except (default `captureAfter` only) a call refused by argument validation before it ran, and a second
  failure in a row after a failure frame (one frame per run of failures). Unchanged: a step with redacted typed text gets no frame, and one capture timeout stops all later captures.
- **`step.actions?: BrowseTraceAction[]`** (`{ action, ok, error? }`). For a batched `browse_act`, built from the result
  `{ results, completed, stoppedAt?, error? }`: one ok entry per completed action, then the failing one at `stoppedAt`
  (`ok: false`, its error, else the batch error). Actions after it never ran and are not listed; a viewer counts them
  from `args.actions`. Absent when the call failed before the batch ran. Names come from the redacted `args`
  ("act" when missing).
- **`trace.requests?: BrowseTraceRequest[]`** and `dropped.requests`. Every request of the run: `at`, `stepIndex?`,
  `method`, `url`, `type?`, `status?`, `error?`, `durationMs?`, `size?`, `mimeType?`, `requestHeaders?`,
  `responseHeaders?`, `responseBody?`, `bodyTruncated?`.
  - Source: `BrowserPageHandle.drainRequests?(): Promise<PageRequestEntry[]>` (raw; WebSocket, EventSource, Ping and
    `data:` skipped; ring of 300; fetch/xhr text bodies fetched lazily at drain, each <= 1 s and 2 s in total (entries come back without the late bodies), cut to 16 KB (a longer JSON body no longer parses: see redaction); the adapter counts ring overflow and eviction (`droppedRequests?()`, added to `dropped.requests`); entries of a tab closed since the last drain come through `BrowserTarget.drainClosedRequests?()` (no bodies, at most 300); the
    Playwright adapter implements it). `BrowserController.requests()` drains every known tab without the command
    lock, <= 3 s, never throws. `BrowserBridge.requests?(): Promise<string>` returns the JSON of `{ requests, dropped? }`.
  - Recorder: option `requests: () => Promise<unknown>` (string or object), `maxRequests` (500). Drained at the end of
    each finished step in the background, AFTER the step frame (the step never waits for it; drains run one after
    another through one queue); 5000 ms limit per drain (above the controller's 3000 ms), one timeout stops it;
    skipped when the signal is aborted. `flush(signal?)` waits for the queue and drains once more (await it before
    `finish`; `runBrowseAgent` does). A redirect hop is logged as its own entry (its status, no body: the body belongs
    to the final hop, which shares the requestId). `stepIndex` = the step whose time span
    holds `at`, else the step being finished (`flush`: none). `requests` is in the trace only when the option was given.
  - Redaction (`redactTraceRequest`), one key rule (`isSecretName`) for body keys, header names and query params:
    the args rule (substring `pass|secret|token|api_key|otp|cvv|card`), or `session|sid|auth|code|sig|signature` as a
    whole part (split at `_ - .` and camelCase: `sessionId`, `x-session-id`, `auth` match; `zipcode`, `author`,
    `design` do not). Headers `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`,
    `x-auth-token`, `x-csrf-token` and secret-named ones become `"[redacted]"`; values <= 500 chars, at most 60
    headers; values of `referer`, `location`, `content-location`, `origin` (and any absolute http(s) value) go
    through `redactTraceUrl`. Url: `user:pass@` removed, secret-named query/fragment params redacted, <= 2000 chars.
    Body: if it parses as JSON (after BOM / `)]}'`), a secret-named key loses its whole subtree; a form body keeps its
    field redaction; any other text (cut JSON, JSONP, script, plain) that contains a secret-looking word anywhere
    is replaced by `"[redacted: unparsed body with a secret-looking key]"`, else kept. Cut to 4000 chars
    (`bodyTruncated`).
  - A flush after an abort still drains once (own 2000 ms limit); an aborted run schedules no new step drains, and a
    queued drain still runs. The default failure frame is also skipped for an argument-validation error only when no
    action ran (a validation error in the middle of a batch gets its frame).
