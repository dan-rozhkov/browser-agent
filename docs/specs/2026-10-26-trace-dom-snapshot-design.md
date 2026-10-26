# DOM snapshot of a failed step in the browse trace — design (2026-10-26)

Addition to `2026-10-20-browse-run-trace-design.md`. That design said "no DOM
snapshots". A screenshot shows what the page looked like. It does not show why
a locator failed, which element covered the target, or what the markup of an
error state is. Playwright's trace has a DOM snapshot before and after every
action. We take a smaller, targeted version: a DOM snapshot only where a run
went wrong.

## When

The recorder takes a DOM snapshot after a step, when ALL of these hold:

1. The host gave the `captureDom` option.
2. The step is one of:
   - a failed step that the default failure frame rule would capture (a failed
     `browse_open`, `browse_act` that is not a lone `wait`, `browse_tabs`
     switch/close/new), or
   - a `qa_assert` step whose output has `passed: false` (the bug evidence).
3. The step has no redacted typed text (`typedSecret`), like frames.
4. Fewer than `maxDoms` (default 5) snapshots were taken in this run.
5. No earlier DOM capture timed out (one timeout stops DOM capture for the
   run, like frames).

A failed check is not a failed step, so rule 2 needs its own branch.

## What

`BrowserBridge.capture()` (the existing `browse_capture` command, whole page,
no `index`). It returns `{ html, width, height, url, title }`: a self-contained
HTML document, CSS inlined, scripts removed, password values masked
(`CAPTURE_JS`). No new controller code. The recorder option is a function, so
the host decides the source:

```ts
captureDom?: (signal: AbortSignal) => Promise<{ html: string; url?: string; title?: string; width?: number; height?: number } | undefined>;
domFallback?: boolean;  // default true: ax entry from the latest snapshot when captureDom gives no html
maxDoms?: number;       // default 5
maxDomBytes?: number;   // default 2_000_000 (UTF-8 length of html); bigger -> skipped, counted in dropped.doms
```

Timeout: 5000 ms per capture, INLINE. (Redesign: the first version ran the
capture in the background request queue, in parallel with the agent's next
steps. That could hold the controller lock up to 45 s, show a LATER page, and
miss a secret a later step typed.) The recorder captures right after the step
frame and awaits it before the step result returns, so the snapshot is the page
of that step. To make the 5 s bound real, `capture` takes a host-only
`budgetMs` arg (a number; the effective budget is `min(budgetMs, 45000)`;
an invalid value is ignored). `createTraceDomSource` passes `{ budgetMs: 3500 }`: the recorder bound stays 5000 ms, and the 1500 ms difference is for the bridge round trip and the wait for the controller lock, so the controller gives up first and the recorder timer (which disables DOM capture for the run) is only the backstop.
A step that was aborted takes no capture (counted in `dropped.doms`); an abort
during the capture ends the wait and aborts the `signal`. `flush()` does not
wait for DOM captures.

### Parallel steps

The inline capture must not record a page that a concurrent step changed or typed into. The recorder skips the DOM
(counted in `dropped.doms`) when, at capture time, another call is still open, or a step that typed a secret
(`typedSecret`) ended after this step started.

### One shared DOM source (`createTraceDomSource`)

`createTraceDomSource(bridge: Pick<BrowserBridge, "capture">)` (`agent/traceDomSource.ts`, zod-free and ai-free,
exported from `agent/session` and `agent`, with `TRACE_DOM_BUDGET_MS = 3500`) is the one `captureDom` for every host
(`runBrowseAgent` uses it; pen-editor imports it). It returns `undefined` at once for an aborted signal or a missing
`capture`; races the call against the signal (the bridge call itself cannot be cancelled: it runs on until the
controller's budget ends it and its result is dropped); and returns `undefined` for a throw or `{ error }`.

It REQUIRES proof that the redaction ran: the controller puts `forTrace: true` in its capture answer when it honoured
the arg. An answer without it comes from an older controller that ignored the arg: it is discarded and the source
disables itself for the rest of its life (an old controller is asked at most once).

### Secrets in the HTML

`capture` also takes a host-only `forTrace: true` (the recorder path only).
Then `CAPTURE_JS`, in addition to its normal masking: drops the `value` of every
`input[type=hidden]`; blanks the value of inputs/textareas that are secret by
`penIsSecretField`, by `autocomplete` `cc-*` / `one-time-code` /
`current-password` / `new-password`, or by a name/id/label/placeholder that
matches the trace `SECRET_FIELD` rule; and replaces the value of secret-named
query/fragment params with `[redacted]` in `href`, `src`, `action`, `srcset`,
`poster` and URL-looking `data-*` attributes (the key rule of `redactTraceUrl`).
The page script gets the rules from `TRACE_SECRET_RULES` (`shared/trace.ts`) as
data, so the host and the page keep one rule. Also with `forTrace`:

- `user:pass@` userinfo is removed from every redacted URL (as `redactTraceUrl` does).
- An attribute whose NAME is secret by the key rule (`data-csrf-token`, `data-api-key`, `data-auth`) is dropped, also
  on `<html>` and `<body>`; so is the `content` of a `<meta>` whose `name` (or `property` / `http-equiv`) is secret.
- Any other `data-*` attribute whose value is longer than 200 characters or starts with `{` or `[` (JSON state blobs:
  Inertia `data-page`, Livewire snapshots) is dropped. `data-testid`, `data-test` and `data-qa` always stay.
- `url(...)` in inline `style` attributes and in inlined CSS goes through the same URL redaction. The page does this
  for what it reads; the controller does it again (`redactCssUrls`, `shared/trace.ts`) on the final sheet text, which
  holds the fetched `@import` / `<link>` sheets and the literal `@import` fallbacks.

## Format (additive, version stays 1)

```ts
interface BrowseTraceDom {
  id: number;          // 0-based, unique in the trace
  at: number;          // epoch ms
  stepIndex: number;
  src: string;         // "data:text/html;base64,..." in memory; "dom/<id>.html" after splitTraceAssets
  url?: string;        // redactTraceUrl
  title?: string;      // capped 300
  width?: number;
  height?: number;
  bytes: number;
  sourceStepIndex?: number; // ax only: the step whose output the tree came from
}
interface BrowseTrace { /* ... */ doms?: BrowseTraceDom[]; dropped?: { /* ... */ doms?: number } }
```

- `BROWSE_TRACE_ASSET_PATH` grows to `^(frames\/\d{1,4}\.(jpg|png|webp)|dom\/\d{1,4}\.html)$`.
- `splitTraceAssets` moves `data:text/html;base64,` DOM sources to `dom/<id>.html`
  (and ax sources to `dom/<id>.txt`). BOTH get content type
  `text/plain; charset=utf-8`: the stored file is never served as HTML; the
  viewer renders the text in a sandboxed iframe. The prefix match ignores case
  (as `parseBrowseTrace` does) and the stored header is lower-cased. Frames keep their rule.
- `mapTraceFrames` also maps `doms[].src` (a stored manifest resolves both).
- `parseBrowseTrace`: `doms` optional; each entry checked; `id` is an integer
  0..9999 and unique; `url`, when present, is an `http:` or `https:` URL; `src` must be a
  `data:text/html;base64,` URL, a `dom/<n>.html` asset path, an `https:` URL or
  `http://localhost`.

## Hosts

- pen-editor (`browseAgent.ts`): passes `captureDom` that calls
  `bridge.capture({})` when the bridge has `capture`, for QA runs (the runs
  that record a trace).
- Backend (`/api/browse/traces`, R2): accepts the new asset paths with content
  type `text/plain`. R2 serves them from the public bucket host, not from the
  app origin. The viewer never navigates to them: it fetches the text.
- Desktop (`traceStore.ts`): accepts and serves `dom/<n>.html` and
  `dom/<n>.txt` the same way as frames. `appTargets.ts` routes `capture` to an
  Electron app (see "Desktop apps").
- Viewer: when the selected step has a DOM snapshot, the frame area gets a
  "Screenshot / DOM" switch. The DOM view is `<iframe sandbox="" srcdoc=...>`
  (no scripts, no same origin, no forms, no top navigation). The HTML is
  fetched as text (asset path resolved like frames) and put into `srcdoc`.
  A "Open DOM in new tab" action is NOT offered (it would run without the sandbox).

## Desktop apps

pen-editor-desktop drives apps in two ways (`appTargets.ts`):

1. **Electron app, launched by us.** The controller drives the app's renderer
   over CDP: it is a real DOM, and `CAPTURE_JS` works there. Today the desktop
   refuses `capture` for app targets (`REFUSED` in `appTargets.ts`), because
   `capture` used to mean only "put the page on the canvas". Change: route
   `capture` to the app controller. The model-facing rule stays: `browse_agent`
   still refuses `app` together with its `capture` option. Only the recorder
   calls `capture` here.
2. **Native app (computer use, accessibility tree).** There is no DOM. The
   closest equivalent is the accessibility tree: the `snapshot` command already
   works there and gives what the agent saw (roles, names, indexes). The DOM
   entry then holds this tree as text.

So a DOM entry has a kind:

```ts
interface BrowseTraceDom { /* ... */ kind: "html" | "ax"; }
```

- `html`: `src` is `data:text/html;base64,...` / `dom/<id>.html`.
- `ax`: `src` is `data:text/plain;base64,...` / `dom/<id>.txt`. The text is the
  snapshot's element list (one line per element: index, role, name, value), the
  same text the model saw.
- `captureDom` is html-only: it returns `{ html, url?, title?, width?, height? }`
  or `undefined`. The ax entry is made by the RECORDER, not the host, with no
  browser call: it remembers the latest `snapshot` (with `elements`) of any step
  output (`browse_open`, `browse_act`, `browse_snapshot`, `browse_screenshot`),
  and when `captureDom` gives no html it stores
  `formatSnapshotForTrace(latest)` as `ax`. (The first version called
  `browser.snapshot()`, which replaced the controller's last snapshot and made
  the model's `snapshotId` stale.) `domFallback: false` turns this off.
  The snapshot is used ONLY if it came from this step's own output, or from an earlier step after which only
  read-only tools ran (`qa_assert`, `browse_read`, `browse_snapshot`, `browse_screenshot`, `browse_find_images`,
  `qa_verdict`). Any other step since (`browse_act`, `browse_open`, `browse_tabs`, `browse_fill_login`, a host tool)
  makes it stale: no fallback, counted in `dropped.doms`. The entry's `sourceStepIndex` names the step the tree came
  from, so a viewer can say "accessibility tree from step N". `parseBrowseTrace` checks it as an optional
  non-negative integer.
- Asset path: `^dom\/\d{1,4}\.(html|txt)$`.
- Viewer: `ax` is shown as a monospace, read-only text block (no iframe).

The Playwright export (`2026-10-26-playwright-spec-export-design.md`) still
marks Electron app runs as not replayable. Playwright can drive Electron
(`_electron.launch`); that is a separate follow-up.

## Security

The trace DOM is for seeing structure and layout, not for keeping page state. The redaction (`forTrace` in
`CAPTURE_JS`) is an ALLOWLIST, not a denylist. Three review rounds kept finding attributes a denylist missed
(`wire:snapshot`, `hx-headers`, `hx-vals`, `x-data`, `formaction`, `ping`, canvas attributes, values typed in an earlier
step). With an allowlist a new or unknown attribute is dropped by default.

- Every emitted element (also `<html>`, `<body>` and the `<canvas>` -> `<img>` replacement) keeps only: `id`, `class`,
  `style`, `role`, `lang`, `dir`, `hidden`, `title`, `alt`, `type`, `for`, `colspan`, `rowspan`, `width`, `height`,
  `tabindex`, `disabled`, `checked`, `selected`, `readonly`, `open`, `multiple`, `placeholder`, `src`, `srcset`, `href`,
  `action`, `poster`, `xlink:href`, every `aria-*`, `data-testid`, `data-test`, `data-qa`, and the SVG drawing
  attributes (`viewBox`, `d`, `fill`, `stroke`, `stroke-width`, `points`, `x`, `y`, `cx`, `cy`, `r`, `rx`, `ry`, `x1`,
  `y1`, `x2`, `y2`, `transform`, `opacity`, `fill-rule`, `clip-rule`, `preserveAspectRatio`, `xmlns`, and a few more
  presentation attributes). Names match case-insensitively; the attribute order stays.
- Dropped: all other `data-*`, `name`, `value`, `content`, `formaction`, `ping`, `cite`, `background`, `integrity`,
  `nonce`, event handlers, and every framework attribute (`x-`, `hx-`, `wire:`, `v-`, `ng-`, `:`, `@`).
- Form values: no `value` attribute and no `<textarea>` text for ANY input or textarea. `checked` and `selected` stay.
  `<option>` text stays (page text), `<option value>` goes. `<input type="hidden">` is removed. A `<meta>` is removed
  unless it is `charset` or `viewport`.
- URLs that stay (`src`, `srcset` per candidate, `href`, `action`, `poster`, `xlink:href`) and `url(...)` in `style` and in
  style sheets lose their userinfo and the value of secret-named query and fragment params. This runs exactly once per
  value (inline styles in the page, sheet text in the controller).
- Trade-off: the trace loses state the page keeps in attributes (a custom `data-*` hook, `name`, `value`), so a viewer
  cannot restyle by those selectors and a form shows empty. We accept that: the screenshot of the same moment shows the
  state, and the DOM is only for structure. Page TEXT is not redacted: it can hold PII. A step that typed a secret gets
  no DOM snapshot.
- The bucket is public behind an unguessable trace id, the same as frames today. The viewer renders the HTML with a
  fully empty `sandbox` attribute.

## Implementation notes (decisions beyond the text above)

- The DOM trigger reuses the failure-frame predicate (`failureWanted` in `traceRecorder.ts`) with the DEFAULT
  `captureAfter`, even when the host gives its own `captureAfter` (that only changes step frames). The "second failure
  in a row" memory is the frame's (`prevFailureFramed`); without a `capture` option it never sets, so each failure
  qualifies until `maxDoms`.
- `trace.doms` exists only when at least one snapshot was stored. A timeout counts one in `dropped.doms`; the
  `AbortSignal` passed to `captureDom` is aborted on that timeout.
- Base64 of UTF-8 is `utf8ToBase64` / `domTextToDataUrl` in `shared/trace.ts` (`TextEncoder`, chunked `btoa`).
- `formatSnapshotForTrace` (`agent/traceSnapshot.ts`, exported from `agent/session`) never writes `value` of an element
  with `isPassword`, `inputType`/`type` "password" or `masked`, or whose label/name/id matches `isSecretFieldName`;
  an element with only `hasValue` prints `filled` (unless secret).
- `runBrowseAgent` `trace.dom: true`: `captureDom` is `createTraceDomSource(browser)` (see above).
- `dropped.doms` counts every wanted DOM that was not stored: over `maxDoms`, over `maxDomBytes`, a throw, a timeout
  (also the later ones, once a timeout disabled html capture), an abort, no html and no snapshot.
- The HTML is UTF-8 encoded once; the bytes feed the size check and the base64.
- A frame `src` may not be a `dom/` path; a DOM `src` must match its kind.
