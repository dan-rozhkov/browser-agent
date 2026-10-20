# Controller notes (moved from pen-editor-desktop)

These notes came verbatim from the "Built-in browser tab" section of
pen-editor-desktop's `CLAUDE.md` at commit `3d8f975`, when the controller
moved into this package. They describe the Electron-free controller, its
injected page scripts, key parsing and the cursor overlay, plus the history of
the fixes made to them.

Path mapping: `src/main/browser/X.ts` (controller, pageScripts, keys) now means
`src/controller/X.ts` here, and tests such as `test/browserController.test.ts`
now live under `test/controller/`. Mentions of `window.ts`, `tabManager.ts`,
`navigation.ts` and `e2e/browser-tab.spec.ts` still refer to
pen-editor-desktop, which keeps the Electron side.

`src/main/browser/controller.ts` (`BrowserController`) is the command
surface, in the same Electron-free, injected-handle style as
`mcp/dispatcher.ts` — a `BrowserTarget`/`BrowserPageHandle` pair stands in
for the real tab, so it is unit-tested under plain Node/vitest
(`test/browserController.test.ts`). Its six commands (`open`, `act`,
`findImages`, `snapshot`, `perform`, `read`) are exposed to an *editor* tab's
preload as `window.penDesktop.browser.{open,act,findImages,snapshot,perform,read}`
(`src/preload/tab.ts`), each forwarding to the single `browser:command`
`ipcMain.handle` in `window.ts` — `snapshot`/`perform`/`read` are additional
commands on that *same* channel, not a new IPC channel, so
`test/ipcContract.test.ts`'s table is unaffected by them. That handler is the trust boundary — every
argument ultimately comes from an LLM tool call, so `BrowserController`
validates shape and type itself rather than trusting the caller, and every
command resolves (never rejects), coming back as `{ error: string }` on any
failure, matching how `dispatcher.ts`'s calls and pen-editor's own
`toolHandlers` behave. `act`'s `click`/`type`/`scroll` commands run small
injected page scripts (`src/main/browser/pageScripts.ts`) via
`executeJavaScript`, with arguments always embedded as a `JSON.stringify`d
literal via a **function** replacer (`.replace(ARGS_MARKER, () =>
JSON.stringify(args))`) — the string form of `replace` treats `$&`, `` $` ``,
`$'` and `$$` in the replacement as special patterns, which would otherwise
let a click target or typed text containing one of those sequences mangle
the script or (for `` $' ``) splice page source into the JSON literal,
defeating the "never break out of the script" invariant. `back`/`forward`
are guarded by `canGoBack()`/`canGoForward()` before calling
`goBack()`/`goForward()` — an ungoverned `goForward()` with no forward
history is a silent no-op that used to report false success after burning
the full settle wait. `click`'s page script reads
`location.href`/`document.title` synchronously, so if the click itself
starts a navigation it can report the page just left rather than the one
landed on. `BrowserController.settleAfterClick` (used by both `act`'s click
and `perform`'s `CLICK`, and `act`'s `press`) settles in two phases. Phase
one asks "did this even start a navigation" — event-driven since Wave 1
speed (`docs/superpowers/specs/2026-09-24-browse-speed-contract.md`):
`armNavigationWatcher` subscribes to the acted-on tab's navigation lifecycle
(`did-start-navigation`/`did-navigate`/`did-navigate-in-page`/
`did-start-loading`, forwarded by `TabViewHandle.onNavigationEvent` in
`window.ts`) *before* the action runs (a synchronous click handler can start
a navigation, or fire a `fetch()`, inside the very `executeJavaScript` call
that runs it, so arming has to happen first), and resolves as soon as any of
those fires, or after a short grace (`NAV_START_GRACE_MS`, 80ms) if none do.
This replaced a fixed 300ms poll of `getURL()`/`isLoading()`
(`CLICK_SETTLE_TIMEOUT_MS`) that always paid the full 300ms for the common
non-navigating case; that poll is now only a fallback, used when a
`BrowserPageHandle` doesn't implement `onNavigationEvent` (every unit-test
fake, notably). If a navigation *was* observed, phase two is the original
longer (8s, `CLICK_LOAD_SETTLE_TIMEOUT_MS`) bounded wait for `isLoading()` to
go back to `false` before trusting the result's url/title — addendum F,
"Load, not commit" (`docs/superpowers/specs/2026-09-18-browse-task-jev-loop-design.md`):
a following `browse_find_images` would otherwise measure an unlaid-out
document at commit, where every `getBoundingClientRect()` is 0×0, so the
size filter dropped every image and the tool reported `count: 0` even on an
image-rich page. If no navigation was observed, phase two is now a
**network-quiet settle** instead of returning immediately — see below.
`back`/`forward` still use the plain `waitForUrlChange` poll with their
longer (2s) bound — addendum F's fix (and Wave 1 speed's event-driven
version of it) is scoped to the click/press path.

**Network-quiet settle (Wave 1 speed).** A click that fires a `fetch()`/XHR
without a full navigation — the common SPA case — used to get no wait at all
beyond the 300ms fixed probe above, so a slow-rendering response (say,
1.2s) routinely raced the very next `browse_read`/`browse_snapshot`. Each
browser tab's `webContents.debugger` session now also sends
`Network.enable` (alongside `Page.enable`), and `window.ts` tracks every
`Network.requestWillBeSent`/`loadingFinished`/`loadingFailed` event into a
per-tab `pendingNetworkRequests` map plus a monotonic `networkGeneration`
counter (bumped once per *new* relevant request). WebSocket/EventSource/Ping
(Chromium's CDP type for both `navigator.sendBeacon()` and a ping/beacon
request) are never counted — none of them are the "request, then render"
shape a settle should wait on, and a WebSocket/EventSource connection never
"finishes" while the page is open, so counting it would make the tab
permanently non-quiet. `TabViewHandle.networkStats(dropAfterMs)` is a cheap,
synchronous snapshot (`{ pending, generation }`); any single request still
outstanding longer than `dropAfterMs` (`NETWORK_REQUEST_DROP_MS`, 2s) is
force-dropped from `pending` so a long-poll/SSE connection can't keep the
tab non-quiet forever. `BrowserController.waitForNetworkQuiet` (controller.ts)
captures `networkStats().generation` as a baseline *before* the action runs
(same moment `armNavigationWatcher` is armed) and, once the navigation-watch
phase resolves with no navigation, checks that baseline again: if nothing
new started and nothing is pending, it returns immediately — **a no-network
action must never pay for this** — otherwise it polls
(`NETWORK_POLL_INTERVAL_MS`, 20ms) until `pending` has been `0`
continuously for `NETWORK_QUIET_WINDOW_MS` (300ms — long enough that a
request chain doesn't get cut off between requests, short enough not to
meaningfully slow down an already-settled page), bounded overall by
`NETWORK_QUIET_HARD_CAP_MS` (5s). `act`'s `press` used to run this same
click-settle wait *and then* an unconditional extra fixed sleep
(`settleShort`, `NON_CLICK_SETTLE_MS`) on top — a double settle for every
single key. It now runs the settle above exactly once, same as click.
`act`'s `wait` with no `text` used to always sleep the full `ms` (default
`WAIT_DEFAULT_MS`, 3s) regardless of whether the page had anything left to
settle. A first pass made it return as soon as the page looked network-quiet
from the very start — but `wait` exists precisely because the caller expects
*something* to still be in flight, often a client-side timer with no network
involvement at all (a spinner resolving into a button, say), and "quiet from
the start" is indistinguishable from "nothing ever happens" until it's too
late: that version returned almost immediately for a purely-timer-driven UI
change, the opposite of what the caller asked for. The rule instead is
"waits for *activity*, then for that activity to settle" — never "returns
early just because nothing has happened yet." `BrowserController.
runWaitForActivityThenQuiet` polls **two** signals every
`WAIT_POLL_INTERVAL_MS` (100ms): network activity (the same `networkStats`
CDP tracking above) and DOM-mutation activity, via a `MutationObserver`
installed on `document.body` for the duration of the call
(`WAIT_DOM_ACTIVITY_JS`, `pageScripts.ts` — `action: "install"` at the start,
`"check"` on each poll via `takeRecords()` so nothing is missed regardless of
async callback timing, `"uninstall"` when the wait ends). It only starts
accumulating a quiet streak once *either* signal has actually fired (a new
network request, or a DOM mutation) — before that, "currently quiet" and
"nothing has ever happened" look identical (`pending === 0`, no mutation
seen), and only the latter should ever return early. Once something has
fired, it waits for both signals to go quiet — no pending network request,
and no DOM mutation within the last `NETWORK_QUIET_WINDOW_MS` — continuously
for `NETWORK_QUIET_WINDOW_MS`, then returns. If nothing at all happens for
the whole call, it waits out the full `ms`, exactly like the original fixed
sleep — a purely-timer-driven spinner with no network traffic is still
caught by the DOM-mutation signal, so the button rendering at ~1.5s settles
the wait at roughly 1.5s + the quiet window, not the full 3s default, and
not near-instantly either.

**Cheaper evidence (Wave 1 speed).** `SIGNATURE_JS`'s whole-document
`nodeCount`/`textLength`/`textHash` fields used to come from
`document.querySelectorAll("*").length` and `document.body.innerText` — the
latter forces a full layout/reflow — run once "before" an action and once
"after", on *every* act/perform/press call. `diffSignatures` (controller.ts)
only ever treats these three as *report-only* entries in `changes` — they
never gate `changed` on their own, only url/title/main-image/scroll/value
and the acted-on element's own scoped signature do (see its doc comment) —
so `SIGNATURE_JS` now derives them from a `MutationObserver` installed on
`document.body` at the "before" call (`childList`/`subtree`/
`characterData`) and read back (via `takeRecords()`, which can't miss a
mutation regardless of microtask timing, plus whatever the observer's own
async callback already processed) at the "after" call, instead of scanning
the document twice. The three fields keep their original names/types
(numbers) so `isPageSignature`/`diffSignatures` need no changes: "before"
always reports a fixed `0`/`0`/`0` baseline (no scan needed at all), "after"
reports `1`/`1`/`1` only when the observer actually saw a relevant
mutation — the *inequality* `diffSignatures` checks is exactly as
meaningful as it was comparing two real scans, since only "did it change"
was ever read out of these three fields.

**`pageChanged`/`appeared` (browse-speed contract addendum, 2026-09-24).**
Layered on the same `MutationObserver` as the report-only dom/text booleans
above, `SIGNATURE_JS` also derives a stricter "did the page meaningfully
change" signal — `pageChanged: boolean` plus up to 3 short (<=80 char)
`appeared` snippets of new visible text — surfaced by `act`/`perform` results
alongside `changed`/`changes`. This exists for the case `diffSignatures`'s
scoped target signature can't see: a click whose handler mutates a
*different* element than the one acted on (e.g. "Add to Cart" updating a
separate cart-status element) — the target itself reports `changed: false`,
but `pageChanged`/`appeared` still surface that something real happened.
Deliberately conservative, since whole-document noise must never look like
evidence an action did something:
- **Removals never count**, at all — a node leaving the DOM (toast timeout,
  carousel recycling an off-screen slide) is exactly as likely to be routine
  page churn as an action's effect, and unlike an addition there's no
  "still visible with real content" signal left to check once it's
  detached. Only additions and text changes can set `pageChanged`.
- **Ticker-like text changes are ignored.** A `characterData` mutation (or a
  bare text node swapped via `el.textContent = …`) is skipped when the old
  and new text both match `/^[\s\d:.,/%+\-–—()]*$/` (a clock, "12:34",
  "3/25") or differ only in which digits appear once both are normalized to
  `0` (a counter, "Updated 2 min ago" → "Updated 3 min ago") — a live clock
  or countdown ticking under a no-op click must never register as evidence.
  Needs `characterDataOldValue: true` on the observer to compare against.
- **Added elements count only if visible AND either carry non-empty
  trimmed text or are interactive** (`button`/`a`/`input`/`select`/
  `textarea`/anything with a `role`) — an empty decorative wrapper appearing
  doesn't count just because it's in the DOM.
- **Bounded per `MutationObserver` callback**: at most 50 records examined
  per invocation (a bulk DOM rewrite can otherwise hand the callback
  thousands at once), with an early exit the moment there's nothing left to
  learn (`pageChanged` already true and the 3-snippet cap already full).
  The "is there real text here" check reads `textContent` (capped to 200
  chars) — never `innerText`, which forces layout — and the layout-forcing
  `innerText` read for the final snippet only happens once the 3-snippet
  cap is confirmed not yet full.
- **State is reset at the end of every "after" phase**, not just at the
  start of "before": the observer itself is disconnected there already, but
  the accumulator object (`window.__penSigState`) used to be left in place
  too, so a bfcache-restored document (pageshow, no navigation — nothing
  re-runs "before" first) could read a previous action's stale
  `pageChanged`/`appeared`. It's nulled out only after `result` has already
  been built from it.
- The cursor (`[data-pen-cursor]`) and screenshot-annotation
  (`[data-pen-marks]`) overlays, and `script`/`style`/`link`/`meta`/
  `noscript` elements, are still always excluded, same as the report-only
  dom/text booleans.

Coverage: `e2e/browser-tab.spec.ts`'s `/side-effect` fixture (a click that
updates a *separate* element — `changed: false`, `pageChanged: true`), a
`/ticker` fixture (a `setInterval` clock plus a no-op button — a click must
report `pageChanged: false`), and a `/removal` fixture (a click that only
removes an element — also `pageChanged: false`). This logic runs inside a
`SIGNATURE_JS` template-literal string executed in the browser, so it isn't
unit-testable against a fake DOM the way most of `pageScripts.ts` is —
coverage is e2e-only by construction.

`pageScripts.ts`'s `findByText` (used by `click`/`type`, tried *before* a
CSS-selector lookup — see below) searches genuinely clickable elements
(`a, button, [role="button"], input, select, textarea, [onclick]`) before
falling back to any element, and within each candidate set prefers the
innermost match over an enclosing wrapper — a plain document-order scan
picks the outermost element whose trimmed `textContent` matches, typically
a wrapper `<div>` around the real control, and `el.click()` on that wrapper
never reaches a descendant's listener. `CLICK_JS`/`TYPE_JS` try `target` as
visible text (`findByText`) *before* trying it as a CSS selector
(`findBySelector`) — the reverse order used to be the default, and a bare
word like "Search", "Map", "Details", "Select", "Menu", "Address" or
"Video" is also a syntactically valid CSS *type* selector, matching the
real `<search>`/`<map>`/`<details>`/`<select>`/`<menu>`/`<address>`/`<video>`
element on the page (when present) instead of the button carrying that
label — while still reporting `{ matched: target }` as if the click had
landed correctly. A real CSS selector essentially never equals some
element's trimmed `textContent`, so the fallback to `findBySelector` still
fires for genuine selectors. `FIND_IMAGES_JS`'s `consider()` only
accepts `http:`/`https:` resolved URLs — an inline `data:`/`blob:` image has
no size cap and would otherwise flood chat history with base64 (this repo's
been bitten by that twice before).

`snapshot`/`perform` (design doc `2026-09-18-browse-task-jev-loop-design.md`
§1, corrections in its "Addendum, 2026-09-18" section) exist to drive a
cheap per-step decision model (Jev) instead of a full chat turn per click —
see that doc's §2–§3 for the backend/frontend halves, which are a separate
change in `pen-editor-backend`/`pen-editor`. `snapshot` runs `SNAPSHOT_JS`
(a port of jev-ultrafast's `snapshot.js` concepts, credited in
`pageScripts.ts`'s header) and returns an indexed table of visible,
interactive elements (tag, role, label, ops, options, capped at
`MAX_SNAPSHOT_ELEMENTS = 120`; what survives the cap is chosen in-viewport
first, then by distance from the viewport edge, and the table itself is listed
in reading order — top to bottom, left to right; ranking by distance from the
viewport *centre* dropped the top rows of a dense page like Hacker News) plus a
freshly minted `snapshotId`. Custom listbox/menu/date-picker controls are
candidates too (`role=option|menuitemradio|menuitemcheckbox|switch|treeitem`,
and a `gridcell` only when focusable or selectable), plus the option-like
items of OPEN POPUPS (`POPUP_OPTION_JS`, no library class names; reported as
`role: "option"`). Motivating case, Ant Design Select: the visible options are
role-less `<div aria-selected>` in a body portal while the only `role=option`
nodes sit in a 0x0 a11y mirror listbox, so an open select showed no options and
browse_task stalled on "no candidate fits CLICK". Conservative by design (a
missed option beats an invented one on a page with no open list). An *owner* is
a visible `aria-expanded="true"` element that is `role=combobox`, has
`aria-haspopup`, or sits in a combobox wrapper. Its popup is, in order: (a) its
`aria-controls`/`aria-owns` target (on it or its wrapper) when that is rendered,
not too small to show (>= 4px, no clipping ancestor under 4px, no
`clip:rect(0,0,0,0)`) and holds an item or ANY interactive content - then it IS
the popup and there is never a fallback, even with zero role-less items; (b)
only for listbox-type owners (`role=combobox`, inside one, or `aria-haspopup`
listbox/true/tree/grid - never menu/dialog), a floating layer (computed
`position` fixed/absolute, not containing the owner, not a wall >= 85% of the
viewport, not < 4px) ADJACENT to the owner or its wrapper: vertical gap <= 24px
and left edge within 32px of the owner's or overlapping >= 50% of its width,
searched under `<body>`, the owner's dialog and its 3 nearest ancestors; a layer
that is/holds a dialog (role dialog/alertdialog, aria-modal, `<dialog>`), an
h1-h3, or a text input outside the owner is never one; (c) mirror anchoring
beats geometry: when the owner's `aria-controls` listbox is a mirror (rendered,
too small, holding `role=option`) and a layer (same exclusions, gap <= 400px)
contains an element whose trimmed text equals a mirror option's label, that
layer is the popup. Items are visible, not
`aria-hidden`/`aria-disabled`/`pointer-events:none`/`cursor:not-allowed`, have a
label, and carry `aria-selected`, `role=option`, `tabindex` or a computed
`cursor:pointer` that *starts* there (the parent, the popup root included, is
not pointer: children inherit it). A role-less item must be >= 4px; an explicit
`role=option` is never size-checked (open/scale transitions). Nested chains
collapse to the outermost; a container with 2+ item branches, or with a
descendant of a STRONGER signal (role=option/aria-selected > tabindex > pointer),
yields to them, and an element whose ONLY signal is `tabindex` yields to any item
inside it (`<ul tabindex=-1><li style=cursor:pointer>`: the `li` wins); an
element with another role, a native interactive tag, or a native
control/interactive role INSIDE it (a `<label>` around a checkbox) is never one,
and the inner control is listed as itself.
Popup items never suppress anything (`penInsideSelectableCell` reads the
explicit role attribute only); an explicit `role=option` is skipped only for
`aria-disabled` (CSS disabled checks apply to role-less items only) or when it
lies in a mirror listbox AND its owner has a popup with items found elsewhere
(`penIsMirrorOption`). The open-owner list comes from
`penCandidates`' one combined deep walk (no second walk) when it ran. A
page-wide "`aria-selected` without a role" rule was rejected because it turned
selected table rows and carousel slides into options and hid their buttons, so
never widen this outside a popup. `AUTOCOMPLETE_STATE_JS` shares it (and
computes popups only past its gate): a rendered referenced listbox whose options
are all too small to show is a mirror, not the field's own list (an empty one
stays the own list with zero options); a field belonging to an owner (same
element, one contains the other, or the same `[role=combobox]` wrapper) has that
popup's items; the document-wide set is `role=option` plus all popups' items;
`penOverlayBelongsToField` also accepts the popup assigned to the focused field,
but only a strong one (via `aria-controls` or a mirror anchor, never pure
geometry). The script embedding `POPUP_OPTION_JS` includes
`DEEP_QUERY_HELPER_JS` itself, once. An `aria-disabled` option
or day is skipped, but a NATIVELY disabled input/select/textarea/button (own attribute
or a disabled fieldset) stays listed with `disabled: true` (omitted when enabled):
the agent must see that a step is locked behind an earlier choice, and `perform`
on it returns `the control is disabled` without clicking. A transparent or
clip-hidden radio/checkbox is listed through its first visible `<label>` (one
shared `penToggleProxy`, also used for click point, marks and relocation), and ARIA state (`aria-checked`, or `aria-selected` for
option/gridcell/tab/treeitem) is reported as `checked`. Found live on Google
Flights (browse_task looped, 0/3 → 3/3 after): `aria-hidden="true"` controls
are skipped; a control nested in a listed cell/option is not listed again; an
element with no 3+-letter text ("14", "14$34") is named by a descendant's
`aria-label` ("Saturday, November 14, 2026"); a candidate's distance is the
larger of its distance from the window and from its nearest scrolling
ancestor's box, so a year-long picker spends the cap on the shown month; at
equal distance cells rank after one-off controls, so an open calendar keeps its
confirm button; `aria-expanded` is reported as `expanded`, a non-input
`role=combobox` reports its shown text as `value`, and a text `input` (not
password/range) offers `["TYPE_TEXT", "CLICK"]` — date fields open their picker
on click with no attribute saying so. Addendum D governs what an element may report as
`value`: only a non-password `input[type=text]`, `input[type=search]`, or
`textarea` — truncated to 100 chars, and only when `autocomplete` isn't one
of `cc-*`, `one-time-code`, `current-password`, `new-password` — reports its
live `value` at all; every other element (a password input included)
reports `hasValue: true|false` instead, never the content. The original
rule guarded only `type=password`, so an autofilled card number in a
`type=text` field, an email, or a phone number left the page in the element
table under `value`. Exceptions to "everything else reports `hasValue`": a
slider reports its position as a bare number in `value` — a native
`<input type=range>` (its `.value`) and a non-native `role=slider` (only
`aria-valuenow`, and only when it is a plain number; the free-form
`aria-valuetext` never leaves the page). Sliders carry no user-entered text,
and the model needs the position to choose a target. An `<input role=slider>`
is NOT an ARIA slider here: the input branch and its `autocomplete` guard
win. A slider with no legend, labelled group or label of its own gets a
*nearby-text context* prefix in its label (`labelOf` → `penNearbyTextOf`): the
first two meaningful lines (≤40 chars) of the smallest ancestor within 9
levels that has any, so ten bare `slider 0–100` controls in a gallery become
distinguishable. Lines with a digit (live readouts), `@`, code characters, a
trailing colon or a leading quote are dropped; nothing is used when that
ancestor holds more than 4 sliders, over 2000 chars of text, or page furniture
(nav/footer/banner), and never `<body>`. It is visible text that already
leaves the page in the snapshot's `text` field. A `<select>` also reports its chosen option's text as `value` (the option texts
already leave the page in `options`; a `Select…` placeholder with an empty
option value is unset, `hasValue: false`), and a checkbox/radio reports only
`checked` — its `value` is a submit token (`on`), never user input, and
reading it as `hasValue` made every unchecked box look filled. The snapshot
also returns `text`: visible text inside the viewport (≤6000 chars, overlays
and `script`/`style` excluded) for pen-editor-backend's jev-ultrafast step
policy, which otherwise sees only the controls. `options` on a `<select>` is capped at 100 entries,
each truncated to 120 chars, in the page script itself — the payload must
be valid by construction, not rely on the backend to reject an oversized
country dropdown. `SNAPSHOT_JS` only offers controls a user can reach
(booking.com finding: a Genius sign-in `role=dialog aria-modal=true` popup
sat over a full-viewport backdrop while the table listed every control behind
it; Jev's date-field click hit the backdrop, `CLICK_RESOLVE_JS` fell back to a
DOM `el.click()` through the modal, the focus trap ate it, and Jev looped).
Two rules run before the sort/cap: (1) **modal scope** — the topmost visible
`[aria-modal="true"]` / `dialog:modal` layer restricts the table (and the
scroll-container entries) to what is inside it, but only if it contains at
least one interactive candidate (never an empty table); the result then
carries `modal` (≤80 chars, aria-label / aria-labelledby / first heading);
a non-modal `role=dialog` cookie banner does not scope; candidates OUTSIDE the modal are kept only if visibly on top of the backdrop (in the viewport, a sample point hits them or a related node) — a portalled datepicker/listbox appended to `<body>` survives, a page control under the backdrop does not; a modal only counts if a hit-test at one of its sample points lands on it or a descendant (a stale modal left mounted inside an `opacity:0; pointer-events:none` exit-transition wrapper is ignored); a scroll container outside the modal is kept under the same rule as portal candidates; when `modal` is reported `takeSnapshot` merges only child frames whose `<iframe>` is inside the modal (SNAPSHOT_JS reports them as internal `__modalFrames` by src/name, stripped before the result reaches callers; matched like `resolveVisibleFrames`); (2) **covered by an
overlay** — up to 5 viewport-clipped sample points per candidate go through
the same composed hit-test as `CLICK_RESOLVE_JS` (shared `HIT_TEST_HELPER_JS`
so they can't drift); a candidate is dropped only if no point is "related"
AND every unrelated hit sits in a `position: fixed|sticky` **wall** — a layer
not containing the candidate whose rect covers ≥85% of the viewport
(`pointer-events:none` layers, e.g. toast containers, are skipped — never the
occluder). A
*partial* bar is not a wall: booking.com's OneTrust cookie banner
(`div.otFlat`, fixed, bottom, full width, ~200px of 800, not aria-modal)
covered the calendar's day cells, the first version of this rule dropped every
day, and Jev kept re-toggling the date field. Elements under a partial bar
stay listed, and the click path scrolls them into view first:
`REVEAL_TARGET_JS` (same target resolution as `CLICK_RESOLVE_JS`; `locateTarget`
centres the element) runs via `revealTarget` **before** the cursor move and
the before-signature capture on every `dispatchClick`/`dispatchType` path
(target-based act click/type, perform CLICK/TYPE_TEXT; top document only) —
the same ordering as `runHover` (finding 8), so the scroll is never counted as
the action's effect (a click that did nothing used to report
`changes: ["scroll"]`). `CLICK_RESOLVE_JS` no longer scrolls. A custom checkbox under a sibling styled span stays,
and off-screen elements are never dropped. `modal` has a **second source**: a
non-aria wall (a cart drawer's dim backdrop) that rule 2 used to hide >= 3
candidates (`PEN_OVERLAY_MIN_COVERED`) is reported as `modal` when at least
one surviving listed control lives in a fixed/sticky layer (the drawer or the
wall); an empty overlay keeps reporting none. Label: the wall's own
aria-label/heading, else the drawer panel's, else `"overlay"`. This source does
NOT scope the table, does NOT set `__modalFrames` (all child frames still
merge), and scroll containers covered by the wall are dropped. `takeSnapshot`
passes `modal` through untouched (top document only). It also stamps each surviving element with a
`data-pen-snap="<snapshotId>:<index>"` attribute. **Invariant:** `perform`
only ever acts against the *same* snapshot its index came from, taken
against the *same* browser tab. `BrowserController` keeps `{ id, page }` for
the most recent `snapshot()` call — both the id and the exact
`BrowserPageHandle` object it ran against — and `perform` hard-errors
(before running anything) unless the caller's `snapshotId` matches *and*
`target.currentPage()` is reference-equal to that same page, rather than
falling back to the page's `data-pen-snap` lookup (which would itself fail
closed if the marked node were gone, but the controller-level check makes
the failure an explicit, immediate error instead of a "no element"
surprise). The page-identity half exists because File ▸ New Browser Tab and
popups both mean more than one browser tab can exist, and
`TabManager.browserHandle()` picks active-if-browser else last-created —
without it, a snapshot taken on one tab followed by a `perform` after the
user (or a popup) switched to a different tab would pass the id check
(nothing else took a new snapshot) and only then fail in-page against the
wrong tab's DOM with a misleading "no element at index N" message, instead
of an accurate cross-tab error. This is deliberate either way: a page that
re-rendered — or a browser tab that changed — between `snapshot` and
`perform` must never be acted on silently — that would be the one way the
indexed design goes quietly wrong. **Re-mounted targets (booking.com finding) are the one
exception, and only by a unique exact fingerprint.** Live on booking.com's
results page the search form is re-mounted (React replaces the nodes)
~0.8-1.5 s after load, so the stamp `SNAPSHOT_JS` set was gone by the time the
~1 s-later `perform` CLICK ran — "No element matched: index 23" ("Найти"),
alternating 5-8 times as each fresh results page did it again. So
`lastSnapshot.fingerprints` keeps, per TOP-document interactive element,
`{ tag, label, role? }` exactly as the element table reported it (label
already truncated to 120 chars); positional-fallback labels (`"<tag> #<n>"`),
scroll-container entries and frame-routed elements get none.
`executeScript` adds it as `fingerprint` to every page-script call whose args
carry the CURRENT snapshotId + an index on the snapshot's own tab (perform,
act hover/press/scroll by index, `CLICK_RESOLVE_JS`, `REVEAL_TARGET_JS`,
cursor). When the stamp lookup in `FIND_BY_SNAPSHOT_JS` misses, it re-collects
visible candidates (`INTERACTIVE_SELECTOR`, visibility minus the viewport
margin) and accepts a node only if tag and role match and its label —
computed by the SAME shared `LABEL_HELPER_JS` snippet `SNAPSHOT_JS` uses, so
they cannot drift — equals the fingerprint label exactly, AND it is the only
such node. It then restamps it with the same `data-pen-snap` and the result
carries `relocated: true` (surfaced on the `act`/`perform` result via
`relocatedThisCommand`). Zero or several matches keep the original "No
element matched" error: an ambiguous re-mount must never be guessed at.
Password inputs are never relocated (the fingerprint has no input type). Relocation is
also tied to the snapshot's document: `SNAPSHOT_JS` sets
`window.__penSnapDoc = { id, href }`, and `FIND_BY_SNAPSHOT_JS` relocates only
while that id equals the requested snapshotId and `href` equals the current
`location.href` (a new document loses the token; an SPA route change alters
href) — otherwise an old index could click the next page's unique lookalike.
Nodes already stamped for any index of the same snapshot are excluded as
candidates, and the controller stores no fingerprint for an entry whose
`{tag,label,role}` repeats in the table (two "Remove" buttons), so a retry of
one can never take its sibling. The
controller-level snapshotId + same-tab check above is unchanged — relocation
only ever happens inside the same snapshot on the same tab. `perform`'s
argument shape (addendum A):
`index` is required only for `CLICK`/`TYPE_TEXT`/`SELECT` — `SCROLL_UP` and
`SCROLL_DOWN` act on the page itself and are accepted with no `index` at
all (an unconditional requirement used to make scrolling always fail at the
bridge); `WAIT` is not a member of `PerformOperation` at all and is never
sent to `perform` — the frontend loop handles it locally by sleeping and
taking a fresh snapshot. `perform`'s `CLICK` operation reuses the same
two-phase post-click settle wait as `act`'s click (`settleAfterClick`, see
above); `SCROLL_UP`/`SCROLL_DOWN` need no element lookup. `snapshot`/`perform`
are loop internals only — they are never exposed as their own `penTools`
entries, reachable solely through this preload.

### Evidence of effect, `browse_read`, and better images/labels (Addendum 2, 2026-09-19)

A live Amazon run exposed a gap the hermetic suites can't see on their own:
navigation and clicks landed correctly, but the agent *narrated* effects that
never happened (claiming an image gallery had switched when it was
pixel-identical, claiming a filter it never applied) because `act`/`perform`
gave it nothing to check itself against. Four fixes, all in this repo (design
doc's "Addendum 2, 2026-09-19"):

1. **Evidence of effect.** `act` and `perform` now merge an
   `{ changed: boolean, changes: string[] }` pair into every successful
   result (an `{ error }` result is unaffected — no evidence is attached to a
   failure — with one exception: an ARIA-slider `TYPE_TEXT` that fails AFTER
   its key presses were sent, e.g. `slider stopped at 300 (target 900)`, keeps
   its `error` and still carries `url`/`title` and `{ changed, changes }`, so
   the agent learns the value moved instead of retrying blind; the internal
   `__sliderPartial` marker routes it through the same diff). `BrowserController.captureSignature` runs a new page script,
   `SIGNATURE_JS`, once before the action and once after the existing settle
   wait, and `diffSignatures` compares the two. `changed: false` is a normal,
   reportable answer — a click that landed on a wrapper and did nothing is
   still a successful command, never an error. `captureSignature` swallows
   its own failures (a throwing/rejecting `executeJavaScript`) and returns
   `null`. Applied to every `act` action (`click`/`type`/`scroll`/`back`/
   `forward`) and every `perform` operation (`CLICK`/`TYPE_TEXT`/`SELECT`/
   `SCROLL_UP`/`SCROLL_DOWN`); `open`, `findImages`, `snapshot`, and `read`
   are read-only or one-shot and carry no evidence field.

   **A high-effort review of this design found the first cut too coarse and
   too fragile, in four ways that reshaped it further (all still in this
   repo — `pageScripts.ts`/`controller.ts`/`test/browserController.test.ts`/
   `e2e/browser-tab.spec.ts`):**

   - **`changed` no longer gates on whole-document `dom`/`text` deltas.**
     The original signature was `{ url, title, nodeCount, textLength,
     textHash, mainImageSrc }`, and *any* difference — including node count
     or visible-text-hash — set `changed: true`. On a live page (a rotating
     carousel, a lazy-loading image, a live price, an injected ad) that
     moves between two captures milliseconds apart regardless of what the
     agent did, handing back exactly the false "it worked" confirmation this
     whole feature exists to prevent. `dom`/`text` are still *reported* in
     `changes` as useful context, but only `"url"`, `"title"`, `"main-image"`
     (see below), `"scroll"`, `"value"` and `"target"` (see below) gate the
     boolean.
   - **The acted-on element gets its own scoped signature.** `CLICK_JS`/
     `TYPE_JS`/`PERFORM_JS` (for `CLICK`/`TYPE_TEXT`/`SELECT`) stamp the
     element they actually found with `data-pen-sig-target` and compute its
     own signature (subtree node count, text hash, `src`, a **value
     length** — never the raw value — `aria-expanded`, `aria-selected`,
     `aria-valuenow` (a slider thumb's only moving property), `checked`) *before* mutating it, inline in the action script itself
     (returned as an internal `__scopedBefore` field the controller strips
     before the result reaches a caller — see `extractScopedBefore`).
     `SIGNATURE_JS`'s `"after"` phase re-finds the same marked element and
     reports its current signature as `scopedAfter`. A change here reports
     `"target"` in `changes` and gates `changed` — this is the real evidence
     on a page whose document-wide numbers are noise, and it's also what
     makes a successful `type`/`select` (which moves a form field's value,
     not the visible text) distinguishable from a dead one.
   - **`main-image` is now identity-guarded.** The original signature just
     recomputed "the largest visible `<img>`" independently before and
     after — so a newly-loaded ad becoming larger than the real photo, with
     the photo itself completely unchanged, still reported `"main-image"`
     changed. `SIGNATURE_JS`'s `"before"` phase picks that element once and
     stamps it `data-pen-sig-mainimg`; the `"after"` phase re-reads the
     *same* stamped element (or reports an empty src if it's gone) rather
     than recomputing "largest" from scratch, so `"main-image"` only fires
     when that specific element's own `src` actually changed.
   - **`scrollY` and a focused element's value length joined the
     document-wide signature**, and `type`/`scroll` (both `act`'s and
     `perform`'s) now get a short (`NON_CLICK_SETTLE_MS`, 50ms) settle before
     the "after" capture. The original signature had nothing that moved for
     a successful scroll at all, and `type`/`scroll` captured "after"
     immediately with no settle — a successful action and a dead one (typed
     into a field that dropped the keystrokes, scrolled a page that didn't
     move) were indistinguishable. Unlike `dom`/`text`, `scrollY` and the
     focused value's length don't drift on their own between two captures of
     the same page, so — like the scoped-target signature — they gate
     `changed` rather than being noise.
   - **A missing capture no longer silently means "no change".** The
     original `diffSignatures` returned `{ changed: false, changes: [] }`
     whenever either the before or after capture was `null` — but a `null`
     *after* capture is most likely to happen exactly when the page *did*
     change: `executeJavaScript` rejecting mid a cross-origin navigation's
     frame swap. `runClick`/`perform`'s `CLICK` branch/`back`/`forward`
     already track `previousUrl`/`currentUrl`; `diffSignatures` now falls
     back to comparing those (reporting `"url"` only — there's no equivalent
     fallback for `title`) instead of guessing "unchanged".

   `SIGNATURE_JS` now takes `args.phase` (`"before" | "after"`, via the same
   `ARGS_MARKER` substitution every other script uses) so it can coordinate
   the `data-pen-sig-mainimg`/`data-pen-sig-target` markers across the two
   calls — it is no longer argument-free.

2. **`read` / `browse_read`.** A sixth command, `read`, runs a new page
   script, `READ_JS`, and returns
   `{ url, title, headings, text, links, truncated }` — the first thing in
   this bridge that gives the agent a text digest of a page rather than only
   an element table or an image list. `text` is visible text with
   `script`/`style`/`noscript`/`nav` (and anything `role="navigation"`)
   stripped and whitespace collapsed, capped at `maxChars` (default 6000,
   hard cap 20000 — `BrowserController.validateReadArgs` clamps a caller's
   request to the hard cap rather than rejecting it, the same "payload valid
   by construction" posture as `SNAPSHOT_JS`'s option/value caps). `headings`
   are `h1`-`h3` in document order, capped at 40; `links` are `a[href]`
   resolved to absolute URLs, http(s) only, deduped by resolved href, capped
   at 60, with each label trimmed to 120 chars. An optional `selector`
   narrows the whole read to one subtree; when it matches nothing, `READ_JS`
   itself returns `{ error }` — the controller surfaces that verbatim rather
   than silently widening back out to a whole-page read, the same principle
   `perform`'s stale-snapshot check already enforces elsewhere in this file.
   Read-only, so unlike `act`/`perform` it carries no `{ changed, changes }`.

   Review fixes: `truncated` only ever reflected the *text* cap — the
   40-heading/60-link caps were applied silently, so a page with hundreds of
   links reported 60 of them with `truncated: false` and a consumer had no
   way to know anything was cut. `headingsTruncated`/`linksTruncated` now
   report each collection's own truncation alongside the unchanged
   (text-only) `truncated` field. Separately, with a `selector`, `text`
   already included the root element's own text (`collectText` walks the
   root's own children), but `headings`/`links` used
   `root.querySelectorAll(...)`, which only matches *descendants* — so
   `read({ selector: "h1" })` returned that heading's text in `text` but an
   empty `headings` array. `queryIncludingSelf` makes root inclusion
   consistent: the root itself is checked against the selector too, not just
   its descendants.

3. **BROWSE-01 (better images).** `FIND_IMAGES_JS` now parses an `<img>`'s
   `srcset` and picks the largest declared candidate — by `w` width
   descriptor when present, else by `x` density descriptor as a relative-size
   proxy — falling back to `currentSrc || src` only when there is no usable
   srcset. This is deliberately generic (no per-host URL rewriting, which is
   the part that rots): a live Pinterest run had the agent guessing at
   higher-resolution URLs itself after `find_images` only ever returned
   236px thumbnails, and the fix is to read what the page already declares
   instead. Every found image also now reports `naturalWidth`/
   `naturalHeight` alongside the existing `width`/`height` — which still
   means *rendered* size, the e2e suite pins that — so a consumer can tell a
   genuinely small asset from a small CSS rendering of a large one. A
   background-image element has no natural-size concept reachable
   synchronously without decoding it, so its `naturalWidth`/`naturalHeight`
   fall back to its rendered size, same as before this addendum.

   **Review fixes (HIGH):** the original `srcset.split(",")` broke on the
   comma-bearing URLs real CDNs routinely serve
   (`https://cdn/x/w_800,h_600/a.jpg 800w` — a Cloudinary/imgix transform) —
   the URL itself split at the internal comma, the descriptor-less fragment
   was skipped, and the *other* fragment (missing its own scheme/host) won on
   score and was returned as-is, silently 404ing every image `find_images`
   returned on such a host — worse than the bug this fix originally set out
   to solve. `pickLargestSrcsetCandidate` now splits on `,\s+` (comma
   *followed by whitespace*, which is how the srcset grammar actually
   separates candidates, and something a comma embedded in a URL essentially
   never looks like), and additionally verifies the winning candidate
   resolves as a URL at all before returning it. Separately, `naturalWidth`/
   `naturalHeight` used to always come from `img.naturalWidth`/
   `naturalHeight` even once this fix started preferring a different,
   possibly-unfetched `srcset` candidate — worse, per the HTML spec a `w`
   descriptor selection makes the browser report *density-corrected* natural
   size (divided by an implied pixel density computed from the descriptor
   and the viewport-width-dependent "sizes" target), so even the "candidate
   the browser did fetch" case doesn't reliably reflect the resource's real
   pixel size. Whenever the returned URL came from a `w`-descriptor `srcset`
   candidate at all, the descriptor's own declared width is reported
   instead, with height estimated from the loaded image's aspect ratio
   (density correction scales both dimensions equally, so the ratio itself
   stays meaningful) — or omitted entirely when there's no declared width to
   fall back on (an `x`-density-only srcset).

4. **BROWSE-02 (better labels).** `SNAPSHOT_JS`'s `labelOf` gained several
   steps, all tried before the positional `tag #index` fallback, which stays
   last on purpose (dropping an unlabelled element outright is worse — cookie
   banners are made of exactly these): `aria-label` → `aria-labelledby`
   (resolved through the referenced element's own text) → own text →
   `placeholder` → `alt` → `title` → a **descendant's** `aria-label`/`title`/
   `alt` (the common icon-button shape,
   `<div role="button"><svg aria-label="Save"></svg></div>`, where the real
   label sits one level below the interactive element itself) → the
   accessible name of the **nearest enclosing** `<a>`/`<button>` (guarded
   against matching the element itself, which every earlier step already
   covers) → `name`/`id` attribute → the positional fallback. A live Amazon
   run degraded to a run of `div #6`/`input #7` entries that
   `MIN_STEP_CONFIDENCE` then (correctly) refused to act on, making those
   controls unreachable by `browse_task`; the new steps recover a real label
   in exactly the shapes that run exposed. One consequence worth knowing for
   test fixtures: since `id` is now a legitimate label source, any element
   that should exercise the *positional* fallback in a test must have no
   `id` either, not just no `aria-label`/text/etc.

   **Review fixes:** the descendant step used to inspect only the *first*
   element matching `[aria-label], [title], [alt]` and give up if its
   attributes were blank — `<div role="button"><img alt=""><svg
   aria-label="Save"></svg></div>` (a very common shape) matches the `<img>`
   first, which yields nothing, so the label was lost. Every match is now
   tried, in document order, until one actually has a non-empty value.
   Separately, falling back to `el.id` turns a machine-generated id (React
   useId's `":r3:"`, Ember's `"ember123"`, Amazon's `"a-autoid-1-announce"`)
   into a label — worse than the honest positional fallback, since it reads
   as plausible to the Jev decision model and both defeats
   `MIN_STEP_CONFIDENCE`'s ability to refuse a bad guess and invites a wrong
   pick. `looksGenerated` skips ids that are digits-only, digit-suffixed,
   React-useId-shaped (leading/trailing `:`), or start with a known
   framework prefix, falling through to whatever label source comes next (or
   ultimately the positional fallback) — a genuinely hand-authored id
   (`"inp-search"`, `"btn-checkout"`) is still a legitimate label source and
   is left alone.

### The human cursor overlay

While the agent drives a browser tab, clicks/typing used to land instantly
and invisibly — nothing on screen showed the user what the agent was doing.
`BrowserController.moveCursor` (`controller.ts`) runs a new page script,
`CURSOR_JS` (`pageScripts.ts`), before every action that touches the page:
`act`'s `click`/`type`/`scroll` and `perform`'s `CLICK`/`TYPE_TEXT`/`SELECT`/
`SCROLL_UP`/`SCROLL_DOWN`. It installs (idempotently, under
`window.__penCursor`) a fixed-position SVG arrow overlay — a wide, heavily
rounded arrow in pen-editor's own UI accent (`#0d99ff`, written out as a
literal since a third-party page has no access to the editor's custom
properties) over a white rim that keeps it readable on dark pages — animates
it to the resolved target's center with a planned, human-like motion (see
"Motion engine" below) and gives it ripple/press feedback on arrival. Its corners are rounded
by stroking each polygon in its own fill colour with `stroke-linejoin:round`,
so the stroke widths, not a radius, are what "more rounded" means here.

**Ordering invariant: `moveCursor` always runs *before* the action's
before-signature capture (`captureSignature(page, "before")`), never
between the two captures.** The overlay's own DOM insertion and the
`scrollIntoView` it performs while locating the target are both real page
mutations, and "Addendum 2"'s evidence-of-effect diff (`SIGNATURE_JS`,
`diffSignatures`) exists specifically to tell the agent whether *its* action
changed the page — running the cursor between the two captures would fold
the cursor's own footprint into that diff and manufacture false
`changed: true` evidence for actions that didn't actually do anything.

**`pointer-events:none` and `z-index:2147483647` on the overlay root — and
every element inside it — is a hard invariant.** The overlay sits on top of
real page content in a browser tab with no preload to route around it; if it
ever became click-through-blocking, it would silently break every
subsequent click/type this bridge performs. `SNAPSHOT_JS`/`FIND_IMAGES_JS`
both skip any node inside `[data-pen-cursor]` for the same reason: the
overlay must never itself show up as an actionable element or a "found
image".

`CURSOR_JS`'s own value is a Promise, unlike every other script in this
file — `executeJavaScript` awaits it, and the animation spans several
`requestAnimationFrame` ticks. It never throws (every path resolves,
including a `{ error }` shape) and always settles within 600ms via its own
internal backstop timer, since `requestAnimationFrame` can simply stop
firing in a backgrounded tab. Every settle path — `finish()` — is what
clears the backstop, never a caller of `finish()`: an earlier version
cleared it before scheduling a final unguarded `setTimeout(finish, 120)`,
which a throttled/hidden renderer (Chromium clamps backgrounded timers to a
≥1s floor) could delay past 1s — the backstop is only ever disarmed once
something has actually settled, so it genuinely bounds every path. (The
120ms post-arrival timer is gone now — see "Early arrival".) `moveCursor` wraps the call in its own timeout
(`CURSOR_TIMEOUT_MS`, bounded further by the controller's own `timeoutMs`)
and swallows every failure — a rejecting/throwing/timed-out cursor call must
never turn a working browser command into an error or a timeout of its own.
The controller tracks the overlay's last known position
(`this.cursorPosition`) and feeds it back as `from` on the next call, so
consecutive moves chain from wherever the cursor actually is.

**The cursor step's own budget is added to, not carved out of, the command's
timeout.** `moveCursor` runs *inside* the same closure `withCommandTimeout`
bounds for every action that does a cursor step (`act`'s click/type/scroll,
`perform`) — early versions passed the controller's plain `timeoutMs` as that
closure's budget, so the cursor's up-to-`CURSOR_TIMEOUT_MS` (0.9s) came out of
the same 20s the action itself needs, and a slow-but-successful click already
close to that budget could time out purely because of a cosmetic overlay.
Those four call sites now pass `this.timeoutMs + this.cursorBudgetMs` instead
(`cursorBudgetMs` is `Math.min(this.timeoutMs, CURSOR_TIMEOUT_MS)` when the
cursor is enabled, `0` when it isn't) — `open`, `findImages`, `read`,
`snapshot`, and `back`/`forward` never run a cursor step, so they keep the
plain `timeoutMs` budget.

**`moveCursor` also skips itself entirely when the driven tab isn't
visible.** `TabManager.browserHandle()` (and therefore
`BrowserController.currentPage()`) can return a browser tab that isn't the
*active* one, and a hidden `WebContentsView` never fires
`requestAnimationFrame` — so the animation would only ever settle via its own
backstop, paying the full 600ms per click/type/select for an overlay nobody
can see (the same rAF-in-a-hidden-tab failure this repo already hit with
`get_screenshot`). `BrowserPageHandle` (`controller.ts`) and `TabViewHandle`
(`tabManager.ts`) both carry an **optional** `isVisible?(): boolean`; the real
implementation in `window.ts` is `view.getVisible()` (Electron's own
`View#getVisible()`, shipped on `WebContentsView` in this repo's pinned
Electron version), which already tracks exactly what
`TabManager.setActive`'s `view.setVisible(...)` calls set — no separate
visibility bookkeeping needed. `moveCursor` returns immediately when
`page.isVisible?.() === false`; a handle that doesn't implement the method
(every fake page in the unit suite) behaves as before — the cursor always
runs.

Disabled with `PEN_DESKTOP_BROWSER_CURSOR=off` (also `0`/`false`,
case-insensitive — `config.ts`'s `resolveBrowserCursorEnabled`), wired into
`window.ts`'s `new BrowserController(...)` call as the `cursor` option
(default on).

**Motion engine (2026-10-06).** The move is *planned once*, then played by
time: `planMove` builds an array of `{t(ms), x, y}` samples at 120 Hz (cua
`DT_MS`) and every `requestAnimationFrame` frame interpolates by elapsed time,
so the motion is frame-rate independent. The math is derived from
**trycua/cua** (MIT) `cursor-overlay/src/trajectory.rs` (`cua_path`,
`natural_side`, `bump_profile`, the arc-length
`Path`, `glide`, `dc_ms`) and `motion.rs` (`default_effects`);
`CURSOR_JS` carries a credit comment. The cursor has one motion (cua's
`signature_arc`; the other four styles and the `cursorMotion` option were
removed): cua bezier, arc 0.16 × natural side, flow 0.15, handles 0.3/0.3;
min-jerk + late overshoot bump (`min(0.018, 8/D)` at 0.82); duration `dc_ms`
×1.1; effects glow + ripple + squish.

**Heading rotation (cua "heading Tangent") — OFF by default since 2026-10-11.**
The motion has `rotates:false` in `MOTION_EFFECTS`: the arrow only moves, it
never turns (the user found the turning distracting). The math below is kept
for re-enabling, and its tests force `rotates:true`; a separate test pins that it does not rotate by default.
`planMove` adds a `rot` (radians)
to every sample (`applyHeading` in `CURSOR_PLAN_JS`, derived from cua
`trajectory.rs finish()` / motion-lab `applyHeading`, MIT). The arrow art rests
tip up-left (`TIP_ANGLE = -0.75π`). **Model (we deliberately differ from cua):**
`rot` is always wrapped into (-π, π]. Per sample (velocity from samples i±2),
while speed > 40 px/s and up to arrival, `rot` chases the travel heading along
the shortest arc: `target = wrapAngle(atan2(vy,vx) - TIP_ANGLE)`,
`rot = wrapAngle(rot + wrapAngle(target - rot)·k)`, `k = 1 - exp(-dt·22)`;
below 40 px/s, and after arrival, `rot` is held. cua instead scales
`wrapAngle(h - TIP_ANGLE)` by a speed ramp, which flips sign at `TIP_ANGLE + π`
(moving down-right) and spins the arrow on carried headings; that ramp (and the
unwrap patches we tried on it) is gone. Guarantees, all enforced by the sweep
test (8 directions × rot0 ∈ {−3,−2.5,0,2.5,3} ×
600/80px): |rot| ≤ π always; |Δrot| per sample ≤ 0.55 (shortest arc); the arrow
keeps pointing along travel until arrival (tip leads); the total rotation is
the turn into the heading plus the turn home plus the arc's bow (the travel
heading itself swings across an arc, so the test budgets a slack of 1.45 rad). After the
last sample a settle tail (120 Hz, ≤36 samples, until |rot| < 0.002; none if
rot is already ~0) eases rot home along the shortest arc — at most a half-turn
— and the final sample is exactly 0. The tail only extends playback after
arrival: arrival is still the first sample within 1px of the target and still
≤300ms (`ARRIVAL_CAP_MS`), and the plan's `motionEndMs` is the pre-tail end that glow
lifetimes key off (the tail extends only the arrow transform). With
`rotates:false` (the default) the motion never chases a heading: a carried rot0 eases toward 0
from sample 0 during the move (same shortest-arc chase, target 0), and the tail
exists only if rot has not reached 0 by the last sample; reduced
motion plans rot 0 (`planMove`'s `opts.reduce ? 0 : rot0`, the single place),
so it snaps at its first sample. `sampleAt` interpolates rot along the shortest
arc. `CURSOR_JS` sets one composed transform `rotate(rot rad) scale(squish)` on
the arrow SVG (`arrowTransform`), with `transform-origin` = `ARROW_PIVOT` =
(0,0) of the 22×26 viewBox: the hotspot that lands on the target. The "within
1px" pivot guarantee covers the blue fill's rounded tip
(`test/controller/cursorPlan.test.ts` checks it, and that the pivot is fixed under
rotate+scale); the white rim's rounded tip extends ~1.5–2px past it, as it
always did. The drop-shadow filter sits on the non-rotating carrier so the
shadow always falls downward. The current rot is stored on
`window.__penCursor.rot`. **Carry-over:** a new move starts from it (cua
`from_heading`, no snap) only when the previous move had already *arrived* and
its settle tail was still playing. A move cancelled mid-flight goes through the
backstop/cancel `settleAtTarget`, which always resets rot to 0 and applies the
transform (as do the error paths), consistent with the snap-to-target
invariant. A moving call cancels the previous animation and starts from where
that one rests (`state.pos` is re-read AFTER the cancel, which snaps an
in-flight move to its target). A non-moving call (scroll, unresolvable target)
leaves a move that has already *arrived* (only its settle tail playing,
`state.abort` null) alone so it eases home, but cancels a not-yet-arrived one
as usual; either way it resolves `{moved:false}` at a point where the cursor
actually rests, never mid-path. Target lookup before the cancel cannot throw
(null on error), and the outer catch resets rot only if the call owns the
animation. `sampleAt` wraps the interpolated rot so `state.rot` stays in (-π, π]. Glow stays velocity-based
(offset back along the velocity, as in cua), independent of rot.
`CURSOR_VERSION` is `"7"`.

**Agent speed.** Every non-reduced plan is multiplied by `MOTION_TIME_SCALE` = 0.4
(2.5× faster than the cua timings; the cursor used to cost ~0.8s of a ~1.2s
action because the action awaits arrival). `planMove` does one retime with
`k = min(MOTION_TIME_SCALE, ARRIVAL_CAP_MS / arrivalT)`. `RIPPLE_MS` and the press timings are unchanged.

`dc_ms = clamp(150 + 120·log2(D/W + 1), 300, 1000) × scale`, W = the target
rect's smaller side (min 4), or a 24px box for an `args.point` (Fitts-aware:
small targets slower, big ones faster). There is no duration override
(`args.durationMs` was removed; no caller sent it). **Hard cap: the *arrival* moment is retimed to ≤300ms** (`ARRIVAL_CAP_MS`), so the 600ms backstop (itself under `CURSOR_TIMEOUT_MS` = 900ms) never wins in a visible tab (two rAFs for
`scrollIntoView` come before the move).

**Early arrival and cancellation.** The Promise resolves through `finish()`
with `{moved:true, x, y}` at the first sample whose hotspot is within 1px of
the target (cua: "arrival fires when the hotspot reaches the target"); the
follow-through, settle, ripple and squish keep animating *during* the click.
The old 120ms post-arrival delay is dropped: arrival is honest now and the
effects are already underway when the click lands. The resolved x/y and
`state.pos` are always the final target point, never a mid-wobble point. A
new CURSOR_JS call cancels the previous animation (a token + rAF id on
`window.__penCursor`; a still-pending older Promise is settled `moved:false`),
and the new move starts from the previous move's final point (a non-moving call
— scroll, unresolvable target — does not cancel an *arrived* move whose settle
tail is still playing, only a not-yet-arrived one; see "Heading rotation").
**The cancel
path and the backstop path both settle at the move's planned FINAL target and
snap the overlay there** (`place()`), never at a mid-path point; only a call
cancelled before its target was planned (still waiting on scroll frames) falls
back to the current position. The backstop also cancels the pending animation
(token bump + `cancelAnimationFrame`) before settling, so a throttled or hidden
tab cannot replay the stale move when it becomes visible.

**Effects** (all pre-created in `ensureOverlay()` under `[data-pen-cursor]`,
`pointer-events:none`, never DOM inserted per frame): `glow` — one radial
gradient div offset against velocity, radius/alpha growing with speed
(alpha is ramped by speed so it is exactly 0 at rest — no lingering halo);
`ripple` — the pre-engine click pulse, deliberately quiet: a 24px
ring, 2px white border with a 1px dark outline, scaled 0.4→1.6 over 380ms
(ease-out), opacity 0.9→0 (click/select). The cua ring (bright blue, 8→52px,
5px line) was replaced on 2026-10-11 as too loud; `squish` — arrow scales to 0.88 over 50ms then springs
out over ~220ms (click/select; a lighter 0.94 for type). **Reduced motion**
(`prefers-reduced-motion`): a 120ms straight glide with no effects (cua
`REDUCED_MOTION_MS`), instead of a jump. The arrow artwork (polygon points,
stroke widths, colours) is unchanged and never rotated. **Screenshots never show
the effects:** the `screenshot` command hides the whole `[data-pen-cursor]` root
(`CURSOR_VISIBILITY_JS`, `visibility:hidden`) for the capture and restores it
afterwards, best effort and never throwing. The hide is skipped when the cursor
is disabled for that command, `CURSOR_VISIBILITY_JS` reports `changed:false`
when there is no overlay or it is already faded out (`opacity:0`), and the
paint wait runs only when it reports `changed:true`; with `annotate` the hide
runs before the marks, so one paint wait covers both DOM changes. Every move's
`show()` also clears `visibility`, so a failed restore heals on the next move.
Unticking "Show Agent Cursor" calls `BrowserController.hideCursorOverlay()`
(same script, best effort, outside the command queue) to hide the overlay on
the current page at once.

**Settings: env vars and the View menu.** On/off: `PEN_DESKTOP_BROWSER_CURSOR=off` (also
`0`/`false`, case-insensitive — `resolveBrowserCursorEnabled`). **An empty or
whitespace-only value counts as UNSET** (no menu lock, the saved setting
applies). The user can also choose in the native menu **View ▸ Show Agent
Cursor** (checkbox; `menu.ts`). The choice is saved to `cursor-settings.json` in
`app.getPath("userData")` as `{ "enabled": true }`
(`src/main/cursorSettings.ts`, pure path-taking read/write helpers;
missing/corrupt file → defaults). **Precedence** lives in the
pure `resolveCursorSettings(env, saved)` (`cursorSettings.ts`, unit-tested):
a set env var wins and its menu item renders `enabled: false` so the user can
see why the choice does not change; otherwise the saved setting applies.
`window.ts` only wires it: it passes a getter (`cursor: () => boolean`) to `new BrowserController(...)`,
which reads it on every command, so a menu change applies without a
restart. The controller latches the enabled flag on its FIRST read in a
command (the budget read at command entry); the latch is reset inside the
queued function (after any overrun from a timed-out command has settled) and
when the command ends,
so `cursorBudgetMs` and the cursor step always agree even if the user flips the
setting mid-command. Keep `controller.ts` / `pageScripts.ts` (now in the package) free
of electron imports. Tests:
`CURSOR_PLAN_JS` is the pure planner (constants, easing/path math, `planMove`,
`sampleAt`, `velocityAt`) that `pageScripts.ts` exports as its own fragment and
CURSOR_JS embeds the way it embeds `FIND_BY_TEXT_JS`. Production CURSOR_JS has
no test hook. `test/controller/cursorPlan.test.ts` evaluates it and covers `planMove` timing
(arrival ≤ `ARRIVAL_CAP_MS` (300ms), `MOTION_TIME_SCALE` (0.4) applied to an
under-cap move, reduced motion keeping its 120ms glide), the default
`signature_arc` path (endpoints, bow off the chord, zero-length move, Fitts-aware
duration, 24px bare-point box, no effects and no rotation under reduced
motion/default), and — forcing `rotates:true` — the heading, `wrapAngle`,
`sampleAt` and arrow-pivot/hotspot checks.

### Full browser use (2026-09-23)

Design doc: `docs/superpowers/specs/2026-09-23-full-browser-use-design.md`.
Three new commands on the *same* `browser:command` channel (no new IPC
channel — same shape as `snapshot`/`perform`/`read` before them), `act`
gaining five new actions, and per-tab CDP wiring for trusted input and a
dialog policy.

**`screenshot({ annotate? })`.** `BrowserController.screenshot` calls the
optional `BrowserPageHandle.capture()` — window.ts's real implementation is
`webContents.capturePage()` (works with no preload, same as every other
command) resized to ≤1280px wide via `nativeImage.resize()` and encoded
`toJPEG(70)`, returned as `imageData: "data:image/jpeg;base64,…"` plus
`width`/`height`/`url`/`title`. `capture()` returning `null` (an empty
capture, or any thrown error) is reported as `{ error }`, never a blank
image — a caller has no other way to tell "genuinely blank page" from
"capture silently failed." `annotate: true` first takes a fresh snapshot
(`takeSnapshot`, factored out of `snapshot()` so both share one
implementation) — its `snapshotId` becomes the one `perform`/`act`'s
index-based actions accept next — then draws the "set of marks" WITHOUT
showing it to the user: `MARKS_JS` with `draw:false` lays the marks out (no DOM
change, returns them in CSS px plus viewport size), the CLEAN page is
captured, and `COMPOSE_MARKS_JS` decodes that JPEG (base64 → Blob →
`createImageBitmap`, no network/CSP exposure), paints the boxes and labels on a
detached canvas (scaled by imageWidth/viewportWidth and imageHeight/viewportHeight,
labels at exactly the placed rect) and returns a fresh q0.8 JPEG data URL.
Compose runs ONLY through the optional `BrowserPageHandle.executeJavaScriptIsolated`
(window.ts: `executeJavaScriptInIsolatedWorld`, world 1999) — never the main
world, where page scripts could patch the decoders, read cross-origin iframe
pixels or forge the result — and is bounded by `COMPOSE_MARKS_TIMEOUT_MS`.
If a handle lacks the method (the backend's Steel/CDP one) or any compose step
fails or hangs, it falls back to the visible overlay: `MARKS_JS` (`pageScripts.ts`) as a
`[data-pen-marks]`-tagged, `pointer-events:none` overlay drawing a numbered
outline box + label over every one of that snapshot's elements (the
"set-of-marks" a vision model reasons over), captures, and always runs
`REMOVE_MARKS_JS` in `finally` regardless of how the capture itself resolves
— a mark overlay must never survive past the single `browse_screenshot` call
that created it. `SNAPSHOT_JS`/`FIND_IMAGES_JS`/`READ_JS` additionally
exclude `[data-pen-marks]` from their own output, the same way they already
exclude the cursor overlay's `[data-pen-cursor]` — belt and braces on top of
the removal (a mark label carries real, visible text — the element's index —
which would otherwise leak into `browse_read`'s text digest).

Review finding 10: `SIGNATURE_JS` is the one exception, and deliberately
so — it measures text via plain `document.body.innerText`, not a per-element
walk that filters `[data-pen-marks]` out. A prior pass had added exactly
that walk (a simplified, duplicated copy of `READ_JS`'s own `collectText`)
specifically to keep a mark label's visible index number out of
`textLength`/`textHash`, but it was solving a problem that can't actually
occur: `MARKS_JS`'s `[data-pen-marks]` overlay only ever exists for the
single, synchronous duration of a `browse_screenshot({annotate:true})`
capture (installed right before `page.capture()`, always removed in
`finally`), while `SIGNATURE_JS` only ever runs as a before/after pair
around an `act`/`perform`/`press`/`hover` call — the two never overlap. If a
future change ever did make them overlap, the comment on `SIGNATURE_JS`'s
`rawText` line says the cheap fix is subtracting `[data-pen-marks]`'s own
`innerText` length from `document.body`'s, not reintroducing a full
per-element visibility walk.

Review finding 9: `newPage()` itself only creates the tab and makes it
current — it used to also `await` a *full* `loadURL()` (`did-finish-load`),
so `tabs({action:"new", url})` blocked for as long as the whole page took to
finish loading, unlike `open`'s own DOM-ready-plus-grace-period compromise
below. `tabs()`'s `"new"` branch now calls `newPage()` with no url and, when
a url is given, loads it by calling `BrowserController.open()` on itself
(same DOM-ready race, same `OPEN_LOAD_GRACE_MS` grace period, same `openTimeoutMs`
command budget instead of the default, shorter one) — `ensurePage()` finds
the tab `newPage()` just created and made current, so no second tab is
created. On an `open()` failure the tab still exists (`newPage()` already
created it), so the error is merged into the same result as the fresh tab
listing (`{ ...tabsResult, error }`) rather than replacing it — the agent can
see the new (empty) tab instead of retrying `new` into a duplicate.

**`act` gained `select`/`press`/`hover`/`reload`/`wait`, and `click`/`type`
now also accept `index`+`snapshotId`.** Index-based `click`/`type` (and
`select`, which is index-only) route straight to the existing `perform()`
method — `perform("CLICK"|"TYPE_TEXT"|"SELECT", index, snapshotId, text)` —
reusing its staleness/cross-tab `snapshotId` check and its evidence
computation verbatim, rather than duplicating either. `press` (`key`,
optional `target`/`index`+`snapshotId` to focus first) and `hover` (`target`
or `index`+`snapshotId`) are new, CDP-backed action implementations
(`runPress`/`runHover` in `controller.ts`) — see below. `reload` is
`page.reload()` plus the same two-phase settle wait a click's navigation
uses (addendum F), returning `{ url, title }` with no evidence field (like
`open`/`findImages`/`read`, it's not acting on a specific element). `wait`
(`text?`, `ms?` — default 3000, hard-capped at 15000 the same "clamp, don't
reject" way `browse_read`'s `maxChars` is) without `text` is a bounded sleep;
with `text`, polls a new page script (`WAIT_TEXT_JS`) every 100ms for a
case-insensitive substring match. `found: false` on a timed-out wait is a
normal, reportable answer, never an error — the same "not finding something
is not a failure" convention `diffSignatures`'s `changed: false` already
established. `press`/`hover`/`select` all carry the same `{ changed, changes
}` evidence `click`/`type` do (select's comes for free via `perform`'s
existing SELECT-branch evidence; press/hover run their own before/after
`SIGNATURE_JS` pair).

Review finding 5: an `index`+`snapshotId` target on `press`'s focus step or
on `hover` now goes through `BrowserController.checkSnapshotStale` — the
exact staleness/cross-tab guard (same `lastSnapshot` slot, same two error
messages) `perform()` already applied to its own `snapshotId`. Before this,
both skipped straight to a page-script lookup on a stale or wrong-tab
snapshotId, which just failed to find an element with a misleading "not
found" instead of an accurate staleness error. Also finding 5: `FOCUS_JS`/
`HOVER_TARGET_JS` used to embed `snapshotId` straight into a
`[data-pen-snap="<id>:<index>"]` selector string; both now share
`FIND_BY_SNAPSHOT_JS` (`pageScripts.ts`), which iterates `[data-pen-snap]`
and compares the attribute value by plain string equality instead — a
`snapshotId` containing a CSS-selector metacharacter (a `"`, say) can no
longer break out of or reinterpret the selector. And: a `press` given an
explicit `target`/`index` to focus first now hard-errors if `FOCUS_JS`
doesn't find it, instead of the previous best-effort "send the key to
whatever already has focus" — dispatching a keystroke at the wrong element
is worse than reporting the failure.

Review finding 8: `runHover` locates the target (`HOVER_TARGET_JS`, which
itself calls `scrollIntoView`) **before** the before-signature capture, not
after. Before this fix, the order was before-capture → locate-and-scroll →
dispatch → after-capture, so a target that needed scrolling into view
produced a `scrollY` difference the diff blamed on the hover itself, even
when nothing else about the page changed.

**Key parsing lives in `browser/keys.ts`, not `controller.ts`.** `key` is a
"+"-separated spec (`"Enter"`, `"Meta+a"`, `"Shift+Tab"`) — every segment but
the last must be a recognized modifier alias (`Meta`/`Cmd`/`Command`,
`Ctrl`/`Control`, `Alt`/`Option`, `Shift`); the last resolves to a CDP
key/code/windowsVirtualKeyCode/text descriptor, either from a small named-key
table (`Enter`, `Escape`, `Tab`, arrows, `Home`/`End`/`PageUp`/`PageDown`,
`Backspace`/`Delete`, `Space`), a letter (`code: "Key<X>"`, vk = uppercase
ASCII), a digit (`code: "Digit<n>"`, vk 48-57 — ASCII already matches), or a
US-layout punctuation table (review finding 1). Kept in its own CDP-free
module specifically so the parsing itself — the part an LLM's raw string
input actually exercises — is unit-testable without a fake page at all
(`test/keys.test.ts`). An unrecognized modifier or key returns `null` from
`parseKeySpec`, which `act`'s validation turns into a clear `{ error }`
rather than a best-effort guess at what was meant.

Review finding 1: punctuation used to fall back to the character's raw
ASCII code point as its `windowsVirtualKeyCode` — which collides with
several of CDP's *real* virtual-key codes for unrelated physical keys:
`.` (46) is Delete's own vk, `%`/`&`/`'`/`(` (37-40) are the arrow keys',
and other punctuation code points land on Home/End/PageUp/PageDown/Insert.
`PUNCTUATION` (`;`=186, `=`=187, `,`=188, `-`=189, `.`=190, `/`=191,
`` ` ``=192, `[`=219, `\`=220, `]`=221, `'`=222) now supplies the real
code/vk for each; a shifted symbol (`!`, `_`, `"`, …) resolves to its
**base** key's code/vk via `SHIFTED_PUNCTUATION_TO_BASE`/
`DIGIT_SHIFT_SYMBOL_TO_BASE` — Shift doesn't change which physical key was
pressed. A single character outside every table (a non-US-layout symbol)
now returns `null` instead of a virtual-key code that might collide with an
unrelated real key.

Review finding 2, two independent fixes to `act`'s `press`:

- **Shift+letter/digit/punctuation text.** `parseKeySpec` (once it sees
  `Shift` among the spec's modifiers) rewrites the resolved descriptor's
  `key`/`text` to what a real keyboard reports for Shift+that physical
  key — `"Shift+a"` → text `"A"`, `"Shift+1"` → text `"!"`,
  `"Shift+-"` → text `"_"` — via `applyShiftToDescriptor`. `code`/
  `windowsVirtualKeyCode` (the physical key identity) are untouched; a spec
  that already spells out the shifted symbol (`"Shift+A"`, `"Shift+!"`) is
  left alone, since shifting it again would be wrong.
- **Meta/Ctrl combos need `commands`, not `text`.** On macOS Chromium, a
  CDP-synthesized `Input.dispatchKeyEvent` with `Meta`/`Ctrl` held doesn't
  run the browser's native editing-command table the way a genuine
  OS-originated shortcut would — so a synthetic Cmd+A previously did
  nothing at all. `resolveEditCommand(key, modifiers)` (`keys.ts`) maps a
  fixed, Puppeteer-style list — Meta/Ctrl+`a`→`selectAll`, `c`→`copy`,
  `x`→`cut`, `v`→`paste`, `z`→`undo`, Shift+`z` or `y`→`redo` — to CDP's
  `commands` field; `runPress` (`controller.ts`) sends that combo's keydown
  with `commands` set and **no** `text`/`unmodifiedText` at all, since a
  modified shortcut like Cmd+A must never also insert the literal character
  "a" into whatever's focused. A Meta/Ctrl combo outside this fixed list
  still dispatches as a plain (textless) keydown, just without a `commands`
  hint.

Draining happens centrally in `BrowserController.withCommandTimeout` —
every public command routes through it — via `mergeDialogs`. Review finding
6: `withCommandTimeout` now captures both `target.currentPage()` (the
acted-on page) *and* `target.pageHandles()` (every currently open browser
tab's own handle, tagged `tabId` — an **optional** `BrowserTarget` method;
window.ts implements it over `TabManager.listBrowserTabs()`/
`browserTabHandleById()`) **before** `fn()` runs, not after. `mergeDialogs`
drains every handle in `pageHandles` (each dialog entry tagged with its
`tabId`), falling back to draining only `currentPage()` (untagged, for
backward compatibility) when the target doesn't implement `pageHandles` at
all. Capturing both *before* the command runs — not, as before this fix,
looking up only `currentPage()` *after* — fixes two ways dialogs used to go
missing: a dialog on a tab other than the one a command acts on (a popup
that raised its own dialog while the command ran elsewhere) was never
drained at all, and a dialog on the tab a command itself closes (`tabs
({action:"close"})`, or a click whose handler navigates the whole window
away) was lost the moment that tab stopped being "current." Each captured
`BrowserPageHandle` is a plain object closing over its own dialog-queue
array, so draining it after the command (even once the real tab behind it
is gone) is safe — it never touches the underlying, possibly-destroyed
webContents. A throwing `drainDialogs` degrades to "no dialogs from that
tab" rather than breaking the command it's piggybacking on.

**`openedTab`.** `act`'s target-based `click`, index-based `click` (routed
through `perform`'s own `CLICK` branch), and `press` all diff a tab listing
taken immediately before the action against one taken after
(`BrowserController.detectOpenedTab`, backed by the same optional
`listPages()`); the first genuinely new tab id becomes `openedTab: { tabId,
url, title }` on the result. This is purely informational — the agent's
*current* tab has already followed a popup via `agentBrowserTabId` above —
but without it the agent has no way to discover a new tab exists at all
(the upstream #61 failure mode this whole feature branch is named for).
`hover`/hover-only paths never open tabs, so `runHover` doesn't bother with
this check.

**Second-pass review findings.** A follow-up review of everything above
found ten more real defects, fixed together:

1. **Dialog policy gap: a dialog opening *between* commands used to hang
   forever.** The finding-3 policy above ("auto-handle only while a command
   is in flight") left a dialog that opens with *nothing* in flight — a
   page's `load`-handler `alert()`, a `setTimeout`-delayed one — genuinely
   open indefinitely: every later `executeJavaScript` against that tab then
   hangs on the open modal, so every subsequent command silently ran out the
   full `BROWSER_COMMAND_TIMEOUT_MS` with no indication why. Each browser
   tab now tracks its own *currently open* dialog (`openDialog` in
   `window.ts`'s `createView`: set by `Page.javascriptDialogOpening`,
   cleared by `Page.javascriptDialogClosed`), exposed as
   `TabViewHandle.applyDialogPolicy()`. `onBrowserCommand` calls it, for
   *every* open browser tab (not just whichever one the next command will
   act on), right before dispatching any `browser:command` — so a dialog
   left open from between commands is resolved and queued for reporting the
   moment the agent's next command starts, instead of stalling that
   command's own script call. The "user answers dialogs raised while the
   agent is idle" policy itself is unchanged; only the "and it must not sit
   open forever if the agent comes back" gap is closed. E2e-only
   (`e2e/browser-tab.spec.ts`'s "dialogs (finding 1)" test) — a fake CDP
   session can't prove a real dialog was left genuinely open.
2. **`agentBrowserTabId` being `null` in common states let a non-agent
   popup steal the agent.** `TabManager.currentBrowserTabId()` is new —
   the id half of what `browserHandle()` already resolves (factored out of
   it, so the two can never drift). `BrowserTarget.ensurePage()`
   (`window.ts`) now pins `agentBrowserTabId` to it even when handing back
   an *existing* tab, not only when creating a new one; the popup callback
   (`attachBrowserTabPolicy`) pins the agent's current tab id *before*
   `newTab` makes the popup the active tab, whenever the popup's opener
   isn't the agent's own tab (finding 7's existing check) — both close the
   same gap: an unset `agentBrowserTabId` let `browserHandle()`'s "active
   tab if it's a browser tab" fallback silently follow an unrelated popup.
3. **Only `activate()` (a tab-strip click) repointed the agent.**
   `TabManager.cycle()` (backing `nextTab`/`prevTab`, i.e. Ctrl+Tab/
   Ctrl+Shift+Tab) and the menu's "New Browser Tab" (`window.ts`'s
   `newBrowserTab: () => tabs.setAgentBrowserTabId(tabs.newTab("browser"))`)
   now also repoint `agentBrowserTabId` when the tab they land on/create is
   a browser tab — the same "the agent follows explicit user action" rule
   `activate()` already applied. Automatic activations (a popup's own
   `newTab` call, `closeTab`'s neighbor pick) still go through the private
   `setActive` alone and are untouched.
4. **`scrollIntoView` raced a smooth scroll.** `HOVER_TARGET_JS`/`FOCUS_JS`
   (via the new shared `LOCATE_TARGET_JS` helper, finding 10) now pass
   `behavior: "instant"` — on a page with `html { scroll-behavior: smooth }`,
   the default behavior was still animating at the moment the very next
   line read `getBoundingClientRect()`, so hover's reported coordinates (or
   focus's target) landed on where the element was *about to be*, not where
   it already was. E2e-only (needs a real, animating scroll).
5. **`parseKeySpec`'s `"+"`-splitting made `"+"` itself unreachable as a
   key.** `"+"` and `"Ctrl++"` both lost their trailing `"+"` to the
   naive `.split("+").filter(p => p.length > 0)`. A trailing empty split
   segment is now collapsed into an explicit `"+"` key segment, and a
   `"Plus"` named alias was added alongside it. A literal single-space spec
   (`" "`) is now special-cased to resolve to `Space` too, instead of being
   trimmed away into an empty (`null`) spec.
6. **`tabs({action:"new", url})`'s nested `open()` call had two bugs.** The
   outer command's own `withCommandTimeout` budget used to equal the nested
   `open()` call's (`openTimeoutMs`) but started its clock strictly earlier
   (before `newPage()` even ran) — so on a genuinely slow open, the outer
   timeout always fired first, reporting a bare "Browser command timed out"
   with **no tab listing at all**, instead of the inner `open()` timeout
   (which still runs `listTabsResult()` afterward). Fixed by padding the
   outer budget with `OPEN_COMMAND_MARGIN_MS` (5s) on top of
   `openTimeoutMs`. Separately, `mergeDialogs` used to *overwrite*
   `result.dialogs` outright whenever it found anything new of its own to
   drain, discarding whatever the nested `open()` call had already merged
   in — it now seeds its working array from `result.dialogs` first (never a
   double-report, since `drainDialogs()` clears each tab's queue on the
   call that drains it).
7. **`screenshot({annotate:true})` could miss the marks overlay, or hide a
   `MARKS_JS` failure.** `MARKS_JS`'s own result is now checked before
   `capturePage()` runs — an `{ error }` there is returned as the command's
   error (removing any partially-applied marks first), instead of silently
   proceeding to a capture with no marks and no explanation. On success, a
   short in-page double-`requestAnimationFrame` wait (`waitForPaint`, capped
   at `PAINT_WAIT_TIMEOUT_MS`/100ms) now runs between marking and
   capturing, so the just-installed overlay has actually painted — a hidden
   `WebContentsView` never ticks `requestAnimationFrame` at all, so timing
   out there is the expected, harmless case (the capture proceeds anyway).
8. **Nothing serialized concurrent `BrowserController` commands.** The
   frontend's browse tools aren't serialized, so two tool calls fired
   without awaiting each other could interleave — a `screenshot`'s marks
   overlay landing mid another command's own signature capture,
   `lastSnapshot` being replaced mid-`perform` by a racing `snapshot()`. A
   FIFO queue (`BrowserController.runExclusive`) now wraps every public
   command (`open`/`act`/`findImages`/`snapshot`/`perform`/`read`/
   `screenshot`/`tabs`), started synchronously (not via an always-deferred
   `.then()` hop) when the queue is idle — several existing behaviors
   (`withCommandTimeout` capturing `pageHandles`/`currentPage()` "before
   `fn()` runs") depend on a command beginning in the same synchronous tick
   it's called in. Since every command already settles within its own
   `withCommandTimeout` bound, a plain FIFO needs no separate queue timeout
   of its own. A command that calls another public command internally
   (`act`'s index-routed branches calling `perform`; `tabs`'s "new"+url case
   calling `open`) calls that command's `*Unlocked` implementation directly
   — calling back into the queue-wrapped public method from inside an
   already-queued command would deadlock forever.
9. **`act`'s `wait` with `text` and a small/zero `ms` never actually
   polled.** `runWait`'s `while (Date.now() < deadline)` loop's condition
   could already be false before the body ever ran once, so the page was
   never checked at all — `found: false` came back regardless of what was
   already on the page. It's a do/while now: always polls at least once.
10. **Dedup.** `BrowserTabInfo` was declared identically in both
    `controller.ts` and `tabManager.ts` — now declared once (in
    `tabManager.ts`) and re-exported from `controller.ts` for existing
    imports. `FOCUS_JS`/`HOVER_TARGET_JS` shared their target-resolution
    logic even before this pass (`FIND_BY_SNAPSHOT_JS`); the pass factored
    the rest (visible-text/selector fallback + the scroll-into-view call,
    see finding 4) into one `LOCATE_TARGET_JS` snippet both scripts now
    interpolate. `PERFORM_JS` now reuses that same `FIND_BY_SNAPSHOT_JS`
    lookup too, instead of an independent, identical-looking inline
    `data-pen-snap` selector. `window.ts`'s `selectPage` no longer calls
    `setAgentBrowserTabId` right after `activate()`, which already sets it
    for a browser tab.

### Wave 2 reliability (2026-09-24): trusted input, hidden-target refusal, scroll containers

Design doc: `docs/superpowers/specs/2026-09-24-browse-speed-contract.md`
("Desktop → Wave 2 reliability"). Builds on Wave 1 speed above; the human
cursor overlay (`CURSOR_JS`/`moveCursor`) is unchanged and still runs before
every action, exactly as before.

**Trusted click/type via CDP, with the pre-existing DOM path as fallback.**
`act`'s `click`/`type` (a `target`, or `index`+`snapshotId`) and `perform`'s
`CLICK`/`TYPE_TEXT` now try a genuinely trusted input path first —
`event.isTrusted === true` on the page, and a real `beforeinput` for typing —
falling back to the pre-existing `el.click()`/native-setter path
(`CLICK_JS`/`TYPE_JS`/`PERFORM_JS`) whenever the trusted path can't safely
proceed. `controller.ts`'s `dispatchClick`/`dispatchType` are the shared
entry points both the target-based and index-based branches route through;
`pageScripts.ts`'s `CLICK_RESOLVE_JS` is the shared "resolve, but don't act"
step both use, built on the same `locateTarget` (`LOCATE_TARGET_JS`) every
other indexed/targeted action already shares (hover, focus, scroll — see
below).

- **Reveal only if needed; typing follows the focus the click moved** (Google
  Flights fixes). `locateTarget` calls `penRevealIfNeeded` (`pageScripts.ts`):
  a target whose box is fully inside the viewport and hit-testable at its
  centre is NOT scrolled; otherwise `{ block: "center", inline: "nearest",
  behavior: "instant" }` (never horizontally centred — a scroll strip's own
  snap-back handler used to move the target between coordinates and click).
  The DOM-fallback click/type scripts use the same helper. For typing,
  `CLICK_RESOLVE_JS` records `window.__penPreFocus`; after a trusted click
  that landed, `SELECT_ALL_CONTENT_JS({ followFocus: true })` re-stamps a
  DIFFERENT editable the click focused (an overlay input) instead of calling
  `el.focus()` on the covered original, and `READ_TARGET_VALUE_JS` adopts such
  a field when focus moved later (slow/cloud) and it holds the typed text.
  `dispatchType` then returns `via: "cdp"` plus `retargeted: true` with no
  legacy fallback, and diffs against the new field's own before-signature.
  E2E: `/reveal-strip`, `/reveal-fold`, `/focus-overlay` fixtures.

- **Autocomplete settle after typing** (Google Flights "Where to?"). After a
  successful type (`perform` TYPE_TEXT incl. frame-routed, `act` type via
  `runTypeWithEvidence`) `settleAutocomplete` probes the stamped target with
  `AUTOCOMPLETE_STATE_JS`: `role=combobox` (or inside one), `aria-autocomplete`
  list/both or `aria-haspopup=listbox` counts; a native `<input list>` does
  not (no DOM options). For those it polls every 100 ms until the visible
  `role=option` nodes (under the field's `aria-controls`/`aria-owns` listbox,
  else anywhere) are present and their count + label hash is equal across two
  polls, capped by `AUTOCOMPLETE_SETTLE_MS` (2 s) and the command deadline
  minus `SETTLE_HEADROOM_MS`. Suggestions arrive behind a debounced fetch, so
  without this the next snapshot had no option to offer. A list already on
  screen BEFORE the text goes in (a focus-time "popular destinations" list) is
  perfectly stable, so stability alone would end the wait on it: the type
  paths take a stamp-free document-wide `{ baseline: true }` probe after focus
  settles and before the text goes in (`autocompleteBaseline`; inside
  `dispatchType` just before `Input.insertText`, before the DOM path
  elsewhere), and the wait also requires the document-wide options digest to
  differ from it (a list that really equals the baseline waits out the cap).
  Plain fields pay one baseline probe and one probe after, no wait.
  Best-effort and report-silent: a failing probe never errors the type and
  nothing is added to the result. E2E: `/autocomplete` fixture.

- **Late click effects + dialog-dismiss settle** (Google Flights calendar
  "Done"). The site hides the dialog ~300 ms AFTER the click (CSS
  transition), past the click settle, so the after-capture said
  `changed: false` and the next snapshot was still scoped to the closing
  dialog as `modal`. Two bounded, generic waits in `runClick` and `perform`
  CLICK (frame-routed clicks get only the first):
  1. **Dismiss-in-dialog.** `REVEAL_TARGET_JS` (already run before the
     before-capture) reports `dismissDialog: true` and stamps the enclosing
     dialog `data-pen-dismiss-dialog` when the target sits in a
     role=dialog/alertdialog/aria-modal/open `<dialog>` AND its accessible
     name equals/starts with done/close/apply/ok/save/confirm/cancel (word
     boundary), is a bare x-glyph, or its aria-label contains the WORD
     "close" ("Closest airports" does not). The dialog is also kept as
     `window.__penDismissDialog` (reaches a shadow root). After the click
     `settleDialogDismiss` polls `DISMISS_DIALOG_STATE_JS` every 100 ms until
     the dialog is detached, `<dialog>.open === false`, display:none on it or
     an ancestor, visibility:hidden, or neither it nor a descendant has a
     visible box (a bare zero-rect wrapper — display:contents, height:0 — is
     NOT closed), capped by `DIALOG_DISMISS_SETTLE_MS` (1 s) and the command
     deadline minus `SETTLE_HEADROOM_MS`. A closed dialog IS the effect: the hidden button's own
     signature rarely moves, so the result is `changed: true` with a
     `"dialog"` entry when nothing else changed. A day cell or any other
     click pays no probe.
  2. **Late effect re-check.** `captureClickEffect`: a same-URL click whose
     after-diff is `changed: false` re-captures every 150 ms until something
     changed or `LATE_CLICK_EFFECT_MS` (800 ms) elapsed (capped by the
     command deadline minus `SETTLE_HEADROOM_MS`). It also stops on any other
     signal the browse_task loop counts as an effect: `pageChanged: true`, or
     an opened tab (checked before each poll, so a click that already opened
     a tab never starts the loop; native JS dialogs cannot be peeked, their
     drain is destructive). The peeks pass `keep` to `SIGNATURE_JS`, which
     then leaves `window.__penSigObserver` and `__penSigState` alive (the
     usual "after" tears both down) so the final capture still carries the
     whole dom/text evidence; the last poll is non-`keep`. A click that
     changes something at once costs one capture. A final `keep` capture
     leaves state behind, made harmless three ways: the "before" capture
     mints a `captureId` (the controller keeps it per page in
     `signatureCaptureIds` and sends it with the "after"; a mismatch or a
     failed "before" makes the page discard the stored state and observer as
     unavailable), the next "before" replaces it, and the observer
     disconnects itself after 10 s.
  **`SETTLE_HEADROOM_MS` (1.5 s)**: the optional waits above (autocomplete,
  dialog-dismiss, late re-check) stop at `deadlineAt - SETTLE_HEADROOM_MS` and
  are skipped once past it, leaving time for the after-capture,
  `detectOpenedTab` and `settleWhileTargetBusy`, so `withCommandTimeout`
  never reports a timeout for an action that landed.
  Both are best-effort (a failing probe never errors the click). E2E:
  `/late-effect` fixture.

- `CLICK_RESOLVE_JS` locates the element (visible text → CSS selector for a
  `target`, or the `data-pen-snap` stamp for `index`+`snapshotId`), stamps it
  `data-pen-sig-target` and captures its scoped signature (same as
  `CLICK_JS`/`TYPE_JS`/`PERFORM_JS` always have), then computes the
  viewport-CSS-px centre of its `getBoundingClientRect()` and hit-tests that
  point with `document.elementFromPoint` — recursing into *open* shadow roots
  (a closed root is opaque to this check the same way it is to
  `elementFromPoint` itself). The hit passes (`hitOk: true`) when the point
  lands on the element itself, one of its descendants, one of its ancestors
  (a click can legitimately land on a wrapper that bubbles to a listener
  further up), or an ancestor `<label>` associated with the element (by
  containment or `for`) — and fails outright for a zero-size element or a
  centre point outside the current viewport.
- **Click:** when `hitOk` and the tab has a CDP session (`page.sendCdp`), a
  `mouseMoved`/`mousePressed`/`mouseReleased` triple (`Input.
  dispatchMouseEvent`, button `"left"`, `clickCount: 1`) lands a real,
  OS-trusted click at that point — CDP coordinates are CSS px of the page
  viewport, the same space `getBoundingClientRect()` reports in, so no
  zoom/devicePixelRatio conversion is needed. Otherwise (hit-test failed —
  covered, zero-size, offscreen after scroll — or no CDP session, or the
  trusted dispatch itself threw), it falls back to the existing `el.click()`
  script (`CLICK_JS` for a `target`, `PERFORM_JS`'s `CLICK` branch for an
  index) exactly as before this wave.
- **Type:** focus is attempted via a trusted CDP click at the resolved point
  when `hitOk` passed, *and then* an explicit `el.focus()`
  (`SELECT_ALL_CONTENT_JS`) — the CDP click can land on a non-focusable
  wrapper that merely delegates focus on click, so the explicit call is what
  actually guarantees the field itself is focused. `SELECT_ALL_CONTENT_JS`
  then selects the field's *existing* content (native `el.select()`/
  `setSelectionRange` for input/textarea, a DOM `Range` for
  `contenteditable`) so the typed text replaces it, the way a real
  keyboard-driven fill does — and reports only whether the target *is*
  editable at all, never its content. Typing itself is one `keyDown`+`keyUp`
  pair for the first character (no `text`, so it fires `keydown`/`keyup`
  listeners without inserting anything itself — resolved via `keys.ts`'s
  `resolveNamedKey`, the same table `act`'s `press` uses) followed by a
  single `Input.insertText` for the *entire* string — this fires
  `beforeinput`/`input` the way real typing or an IME/paste commit would,
  React-compatible, unlike a raw `.value =` assignment. One `insertText` call
  for the whole string, not one `dispatchKeyEvent` pair per character, was a
  deliberate choice — character-at-a-time dispatch is far slower for
  anything but a short string. The result is verified
  (`READ_TARGET_VALUE_JS`, comparing on the page — it never returns the raw
  value itself, matching this file's existing value-privacy rules) before
  being trusted: a masked/formatted input that rewrites what was inserted
  falls back to the legacy native-setter + `input`/`change` path
  (`TYPE_JS`/`PERFORM_JS`'s `TYPE_TEXT` branch) instead of reporting a false
  success. Password fields are untouched by any of this — nothing in the
  trusted-input path reads or reports a field's value, only a boolean match.
- Both paths report an optional `via: "cdp" | "dom"` on the result, so a
  caller (or a test) can tell which one actually ran.
- `select`/`scroll`/`back`/`forward`/`reload`/`wait` are unchanged by this
  wave — `select` (a `<select>`'s option) has no meaningful "trusted click"
  equivalent, and `press`/`hover` were already CDP-backed since "Full browser
  use" above.

**Text-target resolution prefers a visible match, and refuses a hidden
one.** A bench run found a bare word matching a `display:none` menu item
that happened to share the wanted text with the real, visible control,
silently "succeeding" against an element nothing could see. `FIND_BY_TEXT_JS`
(the `findByText` shared by `CLICK_JS`, `TYPE_JS`, `CLICK_RESOLVE_JS`, and —
via `LOCATE_TARGET_JS` — `HOVER_TARGET_JS`/`FOCUS_JS`/`SCROLL_JS`) now
searches every candidate set twice: once requiring visibility (the same test
`SNAPSHOT_JS`'s `isVisible` uses, minus its viewport-distance margin clause —
a target below the fold is still fair game, just not one the page itself
hides), and only if that finds nothing does it fall back to a hidden match.
Its return shape is now `{ el, hidden } | null`, not a bare element, so every
caller can tell "found, but only hidden" apart from "found and visible" —
every one of them refuses to act on a hidden-only match, reporting
`"target is not visible (hidden element)"` (`click`/`type`/`scroll`) or the
same message via a `hidden: true` field on their own result shape
(`hover`/`press`'s focus step). `CURSOR_JS`'s own target resolution (cosmetic
only — it's guidance for where the overlay points, not a gate on whether the
action proceeds) still accepts a hidden match rather than refusing it.

**Scroll containers.** `act`'s `scroll` now accepts an optional `target` (or
`index`+`snapshotId`); when given, it resolves that element
(`LOCATE_TARGET_JS`) and scrolls it directly if it's itself scrollable
(`overflow-y: auto|scroll` and `scrollHeight > clientHeight`, `SCROLL_
CONTAINER_HELPER_JS`'s `isScrollableContainer`), else its nearest scrollable
ancestor. With no target, and `perform`'s `SCROLL_UP`/`SCROLL_DOWN` (with an
optional `index`+`snapshotId` of their own), the *window* is scrolled unless
it can't (`!windowIsScrollable()` — body `overflow: hidden`, or
`document.documentElement.scrollHeight <= innerHeight`), in which case the
largest visible scrollable container near the viewport centre is auto-picked
(`pickLargestScrollableInCenter`) and scrolled instead — the common
fixed-height-app-shell-with-one-inner-scroll-pane shape.
`SNAPSHOT_JS` marks up to 10 visible scrollable containers (largest-by-area
first) as their own element-table entries — `{ tag, label
(aria-label → nearest heading → first text ≤60 chars → tag), ops: [],
scrollable: true }`, stamped with the same `data-pen-snap` every indexed
action already relies on, so `act scroll`/`perform SCROLL_*` can be pointed
at one by index. **`ops: []`, not `["SCROLL"]`**: pen-editor-backend's
`/api/browse/step` zod schema enumerates `ops` as `CLICK | TYPE_TEXT |
SELECT` with `.min(1)`, so a fourth op value there — or an empty array at
all — is a *separate*, backend-repo schema change, not something this repo
can add unilaterally; a container is recognizable purely by `scrollable:
true` on the frontend/backend side once they're updated to read it.
`SNAPSHOT_JS`'s `scroll` field also now reports the auto-picked container's
own `{ index, y, height, atBottom }` (alongside the window's own, unchanged
`{ y, height, atBottom }`) whenever the window itself can't scroll — without
it, a caller has no way to tell how much of that container is left to
scroll without a wasted round trip.

### Wave 3 reliability (2026-09-24): shadow DOM, iframes/OOPIF, console errors, botCheck

Shared contract doc: `docs/superpowers/specs/2026-09-24-browse-speed-contract.md`
("Desktop → Wave 3"). Builds on Waves 1/2 above; the human cursor overlay
(`CURSOR_JS`/`moveCursor`) is unchanged and still runs before every action —
for a frame-routed element it moves to an explicit top-level-viewport point
(the matched iframe's own center) rather than resolving/scrolling to the
element itself, since the overlay lives in the top document and can't reach
into a frame's own document at all (`CURSOR_JS`'s `args.point` branch).

**Open shadow roots.** `deepQueryAll(root, selector)` (`pageScripts.ts`) is a
bounded, shadow-piercing `querySelectorAll`: it collects `root.querySelectorAll(selector)`
then recurses into every descendant's `.shadowRoot` (only ever `open` roots
are reachable this way — a `closed` root's `shadowRoot` property is `null`
from outside, so no separate check is needed). Capped at 5000 elements
visited and 30 levels of *shadow-root nesting* (not plain DOM depth, which
`querySelectorAll` already handles within one root) — `PEN_DEEP_QUERY_MAX_NODES`/
`PEN_DEEP_QUERY_MAX_DEPTH`. Wired into `findByText`/`findBySnapshot`
(`FIND_BY_TEXT_JS`/`FIND_BY_SNAPSHOT_JS`, shared by `CLICK_JS`/`TYPE_JS`/
`CLICK_RESOLVE_JS`/`LOCATE_TARGET_JS`/`PERFORM_JS`), `SNAPSHOT_JS`'s
interactive-element and scroll-container candidate walks, `FIND_IMAGES_JS`'s
`<img>`/background-image scan, and `READ_JS`'s heading/link queries and text
collection (`collectText` also walks into `n.shadowRoot`'s own `childNodes`
directly — a `ShadowRoot` is a `DocumentFragment`, `nodeType` 11, not an
`Element`, so a naive `walk(n.shadowRoot)` call hits `collectText`'s own
`nodeType !== 1` guard and silently drops every bit of shadow text; this bit
during development and is why that branch is handled before the element
guard, not folded into the generic recursion). `CLICK_RESOLVE_JS`'s
`document.elementFromPoint` hit-test needs no equivalent change — Chromium's
own implementation already pierces every open shadow root.

**Iframes (same-origin AND cross-origin/OOPIF), one level deep.**
`BrowserPageHandle.listFrames()`/`executeJavaScriptInFrame()` (`controller.ts`,
mirrored on `TabViewHandle` in `tabManager.ts`) wrap Electron's
`webContents.mainFrame.frames` (direct children only — `WebFrameMain`
abstracts over the process boundary, so a same-origin child and a
cross-origin/OOPIF child look identical here) and `WebFrameMain#executeJavaScript`.
`frameId` is `frameTreeNodeId` (stable for the frame's lifetime), not the
deprecated `routingId`. `BrowserController.resolveVisibleFrames` matches each
`WebFrameMain` child against a visible `<iframe>` element the top document's
own `IFRAME_RECTS_JS` reports (by `url` first, falling back to `name` — a
`WebFrameMain` has no DOM-side identity a page script could read, and a
cross-origin iframe's `src` attribute can differ from the frame's current,
possibly-redirected `url`), capped at `MAX_BROWSER_FRAMES` (8) and skipping
any iframe element with zero rendered size. `snapshot()`/`read()`/
`findImages()` all descend into every matched frame after their own
top-document script call: snapshot indices are global and stable within one
snapshot (top-document elements keep SNAPSHOT_JS's own 0..N-1, each frame's
own elements are appended and renumbered), capped at the existing
`MAX_SNAPSHOT_ELEMENTS`; each frame-sourced element/read-text-append carries
`frame: "<title|name|host>"` (`frameLabel`). `BrowserController.lastSnapshot`
now also keeps a `frameMap` (global index → `{frameId, localIndex}`) and a
`frameRects` map (frameId → the iframe's own content-box offset/size in
top-level viewport px) alongside the existing id/page staleness check, so
`perform()` can route CLICK/TYPE_TEXT/SELECT/SCROLL_* to the right document.
A frame-routed CLICK/TYPE_TEXT skips the trusted-CDP path entirely and runs
the DOM path (`PERFORM_JS`) directly inside that frame via
`executeJavaScriptInFrame` (`frameClickOrType`) — this is the design's own
sanctioned fallback ("if hit-test inside the frame fails fall back to DOM
click via frame.executeJavaScript"), not a shortcut: computing a genuinely
trusted CDP click's coordinates across a frame boundary (accumulating each
ancestor iframe's own content-box offset) is real, separate work this pass
scoped out — nested iframes (a frame inside a frame) are out of scope for
the same reason, one level deep only. Text-target (`act`'s `target: "…"`)
resolution is **not** frame-aware in this pass — only snapshot/index-based
routing is; a `target` click/type still only searches the top document, see
`FIND_BY_TEXT_JS`.

**Console error ring buffer.** (Revised by a later code-review pass — see
"Code review fixes" below: this no longer goes through the CDP `Runtime`
domain.) Each browser tab's `webContents.on("console-message", ...)`
listener (`window.ts`, wired unconditionally for `kind: "browser"`, no
debugger session required) captures every message with `level === "error"`
— both an explicit `console.error(...)` call and an uncaught JS exception
report to the same console sink in Chromium, so one check covers both —
pushing each (truncated to 200 chars) into a per-tab ring buffer capped at
50 (oldest dropped first). Exposed as `drainConsoleErrors()` on
`TabViewHandle`/`BrowserPageHandle` — same "drain empties it" shape as
`drainDialogs`, but gated on `kind === "browser"` rather than
`debuggerAttached`, since it needs no CDP session at all — it stays
available even on a browser tab whose debugger attach failed (e.g. real
DevTools already attached). `BrowserController.act()`/
`perform()` (the public entry points, not their `*Unlocked` internals — so
an action that internally routes through another command, e.g. `act`'s
index-based click calling `perform`'s CLICK branch, never double-drains)
merge up to 5 entries into the result as `consoleErrors: string[]`, omitted
entirely when empty rather than an always-present empty array.
**"New since the previous command" means exactly that**: an exception thrown
synchronously as part of a click's own dispatch and settle is typically
already drained by *that click's own* `act`/`perform` call, not a
subsequent one — a caller (or a test) watching for a specific error should
check the acting command's own result first, not assume it always lands on
the next call. `open`/`findImages`/`snapshot`/`read`/`screenshot`/`tabs`
carry no `consoleErrors` field at all — only `act`/`perform` have a
meaningful "since the previous command" window.

**botCheck on open.** `BOT_CHECK_JS` (`pageScripts.ts`) checks the page's
title and the first 2000 chars of its visible body text against a fixed
regex (`just a moment|verify you are human|are you a robot|captcha|attention
required|access denied|unusual traffic`, case-insensitive) or the presence
of an `<iframe>` whose `src` points at a known challenge host
(`challenges.cloudflare.com`, `google.com/recaptcha`, `hcaptcha.com`).
`BrowserController.checkBotWall` runs it after `open` settles (both the
"full load beat DOM-ready" and "DOM-ready then grace period" branches) and
merges `{ botCheck: true }` into the result — omitted, not `{ botCheck:
false }`, when the page doesn't look like a challenge wall, matching this
file's convention for other optional fields (`openedTab`, `dialogs`).
Bounded by its own short `BOT_CHECK_TIMEOUT_MS` (400ms), *independent* of
`open`'s own DOM-ready/grace-period timing: this bit during development — a
first cut let the bot-check script inherit however long was left, and
`electron#5183` means `executeJavaScript` on a page `open` correctly
returned early for (`loaded: false`, a subresource still pending) blocks
until that subresource finally settles, silently reintroducing the exact
"wait for the whole page" cost the DOM-ready fix exists to avoid, one call
later — an e2e regression (the DOM-ready timing test's elapsed-time
assertion) caught it directly. A timed-out or throwing check degrades to no
`botCheck` field at all, same as a script that genuinely disagrees.

**Testing.** `test/browserController.test.ts`'s "BrowserController — Wave 3
reliability" describe block covers frame discovery/matching/routing (a fake
`listFrames`/`executeJavaScriptInFrame`, including a rejecting frame call
proving a stuck frame is skipped, not fatal), the console-error merge (and
its absence on a page with no `drainConsoleErrors`), and `checkBotWall`
(true/omitted/throwing). Shadow-DOM piercing itself is e2e-only (a fake page
can't prove a real shadow root was traversed) —
`e2e/browser-tab.spec.ts`'s `/wave3` fixture (served by the suite's existing
stub HTTP server) covers an open shadow root, a same-origin iframe, and a
button whose click handler throws; a **second** http server, bound to
`"localhost"` rather than the main server's `"127.0.0.1"` (genuinely
different origins/sites, not just a different port — Chromium's default site
isolation puts it in its own renderer process, a real OOPIF), serves the
cross-origin iframe fixture. `/botcheck` is a separate fixture page titled
"Just a moment...".

### Code review fixes on top of Waves 1–3 (2026-09-24)

A follow-up review pass found and fixed several correctness bugs in the
above, without touching the human cursor overlay:

- **Navigation-event forwarding is main-frame-only.** `window.ts`'s
  `onNavigationEvent` broadcast (Wave 1 speed) used to forward
  `did-start-navigation`/`did-navigate-in-page`/`did-start-loading`
  unfiltered — all three fire for ANY frame, and `did-start-loading` in
  particular reflects the whole tab's loading state, which flips for a
  subframe too. An ad/embed iframe navigating during the 80ms
  `NAV_START_GRACE_MS` grace window made an ordinary, non-navigating click
  wait the full 8s `CLICK_LOAD_SETTLE_TIMEOUT_MS` load-stop settle for
  nothing. Fixed via `navigation.ts`'s new pure
  `shouldForwardNavigationEvent({ isMainFrame })`: `did-start-navigation`
  and `did-navigate-in-page` are now filtered on their own `isMainFrame`
  arg, `did-navigate` needs no filter (already main-frame-only per
  Electron's own doc), and `did-start-loading` — which carries no frame
  info to filter on — is dropped from the broadcast entirely.
- **`waitForNetworkQuiet` ignores requests already pending before the
  action.** Wave 1 speed's network-quiet settle used to treat ANY currently
  pending request as reason to wait, even one that started well before the
  acted-on command (a Pinterest-style lazy-loading image grid still
  fetching from an earlier scroll, say) — a genuinely no-network action
  could pay the full quiet-window/hard-cap wait for a request it never
  caused. `window.ts`'s `pendingNetworkRequests` map now carries each
  request's own `networkGeneration` snapshot at the moment it started, and
  `networkStats(dropAfterMs, sinceGeneration?)` takes an optional second
  argument scoping `pending` down to only requests started after it;
  `waitForNetworkQuiet` passes its captured baseline generation, so a
  request that predates the baseline never counts.
- **`dispatchType` no longer clicks before checking editability.** Wave 2
  reliability's trusted-typing path used to send a trusted CDP click to
  "focus" the resolved target BEFORE checking whether it was actually
  editable — typing into a text match that turned out to be a link/button
  clicked it. `CLICK_RESOLVE_JS` now also reports a read-only `editable`
  flag (the same tag/`isContentEditable` check `SELECT_ALL_CONTENT_JS`
  already used, but with no focus/select side effect), and `dispatchType`
  checks it immediately after resolving, before any click — a non-editable
  target goes straight to the legacy DOM path (which reports the same "not
  editable" error TYPE_JS/PERFORM_JS always have) without ever touching the
  mouse.
- **Hidden-only text match now tries the CSS selector before refusing, and
  `<style>`/`<script>`/`<noscript>`/`<template>` are never click targets.**
  `FIND_BY_TEXT_JS`'s `findByText` used to be consulted first in
  `CLICK_JS`/`TYPE_JS`/`LOCATE_TARGET_JS`'s `locateTarget` — if it found
  *any* match, even a hidden-only one, the selector fallback never ran at
  all, so a bare word matching a hidden element elsewhere on the page (a
  closed dropdown's own copy of the label, say) could shadow a perfectly
  good CSS selector for the real, visible target. The order is now: visible
  text match → CSS selector → the hidden text match's own refusal (`"target
  is not visible (hidden element)"`) → "No element matched". Separately,
  `findByText`'s candidate search now skips `<style>`/`<script>`/
  `<noscript>`/`<template>` elements outright — their `textContent` is
  CSS/JS/inert source, not page content, and a target string that happened
  to appear literally in one (a class name, a URL, a JSON blob) could
  otherwise "match" it and report a false click success against an element
  nothing could ever see.
- **`act`'s index-based `scroll`/`hover`/`press` are frame-routed.** Only
  `perform`'s CLICK/TYPE_TEXT/SELECT/SCROLL_* branches used
  `resolveFrameRoute`/`executeScriptInFrame` — `act`'s own `scroll` (via
  `runOnPageWithEvidence`), `hover` (`runHover`), and `press`'s optional
  focus target (`runPress`) always ran their page script against the top
  document regardless of the frame map `snapshot()` built, so any of them
  given an index that actually lived in a child frame failed with "No
  element matched" instead of acting. All three now resolve through
  `resolveFrameRouteWithCursorPoint` (factored out of `performUnlocked`'s
  existing frame-routing logic) and route `SCROLL_JS`/`HOVER_TARGET_JS`/
  `FOCUS_JS` into the matched frame via `executeScriptInFrame` when
  frame-routed. `press`'s actual key dispatch needs no frame routing itself
  — CDP keyboard input targets whichever frame currently holds focus,
  regardless of which document `FOCUS_JS` ran in to get it there — but
  `hover`'s trusted `Input.dispatchMouseEvent` does: a frame-routed
  `HOVER_TARGET_JS` call reports coordinates local to that frame's own
  document, so the matched iframe's own content-box offset (`frameRect`) is
  added back in before dispatching, to land in the top-level-viewport
  coordinate space CDP mouse events are always expressed in.
- **`SNAPSHOT_JS`'s scroll-container budget is shared with the interactive-
  element cap, not additional to it.** Scroll containers used to be
  appended UNCONDITIONALLY on top of the already-`maxElements`-capped
  interactive elements (up to 10 more) — a busy page with both could report
  more elements than `maxElements`, and `controller.ts`'s `takeSnapshot`
  computes its own child-frame budget as `remaining = MAX_SNAPSHOT_ELEMENTS
  - elements.length` straight off that count: a negative `remaining` made
  its `if (remaining > 0)` guard skip the whole frame merge outright. The
  scroll-container slice is now capped to whatever budget is left after the
  interactive elements (`min(10, maxElements - capped.length)`, never
  negative), so the top document's own element count can never exceed
  `maxElements` and `remaining` downstream can never go negative.
- **`dispatchClick` no longer falls back to a DOM click after the mouse-down
  was already sent.** The trusted-CDP click path's single `try`/`catch`
  used to fall through to the DOM `el.click()` fallback on ANY failure,
  including one after `Input.dispatchMouseEvent`'s `mousePressed` had
  already been dispatched — risking a genuine mouse-down (or a full
  press+release that merely failed to report success) PLUS a synthetic
  click landing on the same target, a double click. A `mousePressedSent`
  flag (set right before that call, not after it resolves) now
  distinguishes the two cases: a failure before it (only `mouseMoved` ran)
  still falls through to the DOM path exactly as before; a failure at or
  after it reports an error instead, never touching the DOM fallback.
  `dispatchType`'s own catch around its CDP click attempt carries no such
  risk and is unchanged — a failed focus-click there just falls through to
  `SELECT_ALL_CONTENT_JS`'s own `el.focus()`, never a second click.
  Frame-routed clicks/types (`frameClickOrType`) were never in scope for
  either of these two fixes — Wave 3 already routes them straight to the
  DOM path inside the frame, skipping the trusted-CDP path (and its
  editability check / double-click risk) entirely by design.

### Second-pass review fixes (2026-09-24)

- **`SNAPSHOT_JS`'s scroll-container pass no longer double-stamps an
  interactive element that is also a scroll container.** A scroll container
  that is ALSO an interactive element — a `<textarea>` with
  `overflow-y:auto` and more content than fits, a `contenteditable` editor
  pane, a combobox's own scrollable listbox — used to get a *second*
  element-table entry from the scroll-container pass, which re-stamped its
  `data-pen-snap` with a fresh container index. That overwrote the
  interactive element's own earlier stamp, so a `perform` call using the
  index a prior `snapshot()` had reported for it no longer resolved
  ("No element at index … (stale or removed)"), even though the element was
  neither stale nor removed. The scroll-container loop now checks each
  candidate's `data-pen-snap` before stamping it: if it already carries
  *this* snapshot's stamp (interactive, or — defensively — an earlier
  scroll-container entry), it is skipped and that existing element-table
  entry is flagged `scrollable: true` instead of getting a duplicate entry.
  Covered by `e2e/browser-tab.spec.ts`'s `/snapshot` fixture (a scrollable
  `<textarea>` added alongside the existing interactive elements) and a new
  e2e test asserting exactly one entry with both `ops: ["TYPE_TEXT"]` and
  `scrollable: true`, and that `perform` TYPE_TEXT by that index still
  resolves the element.
- **`runWaitForActivityThenQuiet` (the `act wait` no-`text` engine) now
  scopes `networkStats` to its own baseline generation.** It already
  captured a `networkBaseline` generation up front (the same pattern
  `waitForNetworkQuiet` uses for click/press settle), but its poll loop
  called `page.networkStats(NETWORK_REQUEST_DROP_MS)` without passing that
  baseline as the second (`sinceGeneration`) argument, so `pending` counted
  *every* currently in-flight request — including ones that started before
  the wait itself, which never contributed to `networkStarted`/
  `sawActivity` but still held `currentlyActive` (and therefore the whole
  wait) true for as long as they stayed pending, up to the full `ms`
  budget. The call now passes `networkBaseline` through, matching
  `waitForNetworkQuiet`. Covered by a new unit test in
  `test/browserController.test.ts` (Wave 1 speed describe block) that
  starts a request before the wait begins (never finished) and a second one
  after the baseline is captured (started and finished quickly) — the wait
  must settle once the *new* request goes quiet, not wait out the stale
  one for the full budget.

## 2026-10-13: same-length value changes and sortable column headers

- **False "no effect" on a same-length value change.** The effect signature
  kept only value *lengths*, and the MutationObserver cannot see `.value`
  property writes, so typing "08" over "06", or a stepper rewriting a sibling
  input 06 -> 07, reported `changed: false`. The scoped signature now carries
  `valueHash`, the page signature `focusedValueHash` and `controlsHash` (value,
  checked, aria-valuenow/-checked/-selected of up to 150 visible form
  controls, scoped to the open dialog when there is one). `diffSignatures`
  reports a `controls` change kind and `controls`/`value` gate `changed`. Only
  numeric hashes leave the page, never values; `type=password` fields keep
  length only (hash 0, skipped in `controlsHash`). Hash fields are optional
  in `isScopedSignature`/`isPageSignature`, so older shapes compare as
  "no change" (undefined === undefined). Tests: `test/controller/pageScripts.dom.test.ts`.
- **Sortable column headers were not actionable.** `penCandidates` now lists a
  `th` / `[role=columnheader]` that has `aria-sort`, an `onclick`, or a
  computed `cursor: pointer` (cap 40, scan cap 300). A header that contains a
  button/link/input is not listed itself: the inner control is the target
  (no duplicate). Plain header cells are still not listed.

## Quantity-reached gate (loop)

`src/loop/quantityGate.ts`, wired in `runBrowseTaskLoop`. A sub-goal that asks
for N units ("Add 2 units ...") used to end with more, because the step policy
sees an unchanged button and clicks again (live bench: bag showed 4, not 2).

- N comes from the action part, else the "Done when" clause (never "Does not
  count"); exactly one quantity, 1..20, and not a measure or price. A phrase
  like "quantity to 3" or "set ... to 3" is an absolute target.
- Units per target = sum of `counter a→b` deltas with 0 < delta <= N, plus 1 if
  the effect of the click on that target right before the first counter had an
  `appeared:` text holding `a` as a whole token. An older click's text does not
  count, and a text without that number (an error toast) infers nothing. For
  N = 1 the first effect must show a count: "1 item(s)/unit(s)/product(s)/
  article(s)", "(1)", "1 x" or "x 1"; a bare "1" ("Only 1 left") does not arm.
  For an absolute target, a counter that ends at N also counts.
- A target is origin + pathname + query (not the hash) + normalised label. A
  relabel aliases the state under the new label too, so a label that reverts
  still finds it. The clicked element is found by its own `.index`, the same
  lookup the effect code uses.
- In a sub-goal, a repeat CLICK on a saturated target ends the sub-goal as
  done. In a single-goal run it is vetoed twice instead (a failed history step
  that does not feed the stall or cycle counters; a vetoed cache replay deletes
  its entry); a third attempt ends the run as done.
- The gate lives on `HistoryShare` and survives the stall-recovery retry. The
  retry does not carry a pending (not yet observed) effect of the last click.

## Loop: opened-tab clicks and picker toggles

- A click that opens a new tab returns `{ changed: false, openedTab }`. `changed:false` describes the page left behind; the loop treats a present `openedTab` as a landed step (ok, no "(no effect)") on the perform, act and cache-replay paths. The unproductive counter resets, so the policy gets fresh decisions on the new page.
- Primary signal: after a landed click on a choice control, the history label gets " → now checked" / " → now unchecked" when the next snapshot shows the same control flipped, so the policy sees what the click did. Radios are included in the note.
- Safety net: a non-radio control the loop's own click turned on (keyed by url without hash + role + label) is not clicked again while still `checked` ("already selected, not clicking again": first one is a rule step off the stall counters, a repeat counts unproductive). The set is cleared on a URL change and on a landed TYPE_TEXT. Sub-goals whose action asks to remove/uncheck/clear are exempt (the "Already done earlier" tail is ignored).
- A click that opened a tab skips the post-click bookkeeping (effect note, quantity observe, page-state mark, toggle tracking, picker tracking); the cache write stays.

## Regression note (v0.2.2 → v0.2.5/0.2.6): form fields got slow

- v0.2.2 put a "different number = different option" line into the click-target
  prompt. On forms whose goal quotes a value with digits (a phone, "£2,500 pcm")
  Luna then refused every click target right after a field fill — the submit
  button has no such number — so the sub-goal stalled ("no candidate fits CLICK"
  ×3), the site reopened and the form was filled again. Removed in v0.2.5; the
  deterministic `literal-mismatch` gate is the only guard now.
- `value-already-set` returned DONE when no runner-up existed, which closed
  sub-goals on a text-helper mismatch. Since v0.2.6 it falls back to typing.

## `capture` (2026-10-15, v2)

`capture({ index?, snapshotId? })` serializes the top document (or one
`data-pen-snap`-stamped element) into a self-contained HTML document. Success
`{ html, width, height, url, title }`; over 3_000_000 characters it returns
`{ error }`. Spec: `pen-editor-backend/docs/specs/2026-10-15-browse-capture-design.md`
("v2, steps 1-2").

Flow in `captureUnlocked` (own 45 s budget, not the default command timeout):

1. `CAPTURE_JS` returns `{ sources, htmlOpen, bodyOpen, bodyHtml, width, height, url, title }`.
   `sources` are the document-level styles in order: `link` (href, media), `inline`
   (text, baseUrl, media; an empty `<style>` is read from its cssRules) and `adopted`.
   Body clone as in v1 (scripts and `on*` dropped, URLs absolute, lazy images, form
   state, canvas to `<img>`, shadow roots flattened with nested inline styles).
2. `resolveImports` (`captureCss.ts`): `page.fetchText` (optional; the Playwright adapter uses
   Node `http`/`https`: cookie-less, origin-only referer, connection-time address check against
   private/loopback/link-local ranges, 3 manual redirects, decoded-size cap; desktop uses `session.fetch`) fetches each link and every
   `@import` recursively. Limits: 8 s/file, 3 MB/file, 100 files, depth 4, 8 MB total,
   6 parallel, cycle guard. Every `url()` and `@import` becomes absolute against the
   file it is written in; `@import` media/`layer()`/`supports()` and `<link media>`
   become `@media`/`@layer`/`@supports` wrappers. A failed fetch (or no `fetchText`)
   leaves the literal `@import url("<abs>")` (a failed nested one is hoisted to the top
   of its sheet).
3. Each sheet is parsed with postcss (a sheet that fails to parse is emitted as-is).
   `collectQueries` builds the root compounds (`html`/`:root`) and "existence test"
   selectors (user-action and pseudo-element parts stripped); `CSS_QUERY_JS` answers
   them in the page (batches of 5000 selectors). `applyQueryResults`: a matched root
   compound becomes `:is(:root,:host)`, an unmatched one drops its selector; selectors
   with no match in the captured scope are dropped; empty rules/blocks are dropped
   (an emptied named `@layer x {}` stays as `@layer x;` to keep the layer order).
   `@font-face`, `@keyframes`, `@property`, `@page`, ... are never pruned.
   If the page query fails, the unpruned CSS is used.
4. One `<style>` per source, then the document is assembled; postcss escapes `</style`
   in parsed sheets (`\3c `), `renderStyleTag` escapes it in raw ones.

v2 review rounds (2026-10-15):

- `isFetchableStylesheetUrl` / `isBlockedIp` guard every fetch (SSRF); the controller checks before `fetchText`, the adapter again per redirect and at connect time (`guardedLookup`).
- A fallback `@import` (failed fetch, no `fetchText`, low budget) is its own `<style>` before the sheet's, and keeps its outer conditions (media combined with `and`, one layer, one supports). A fallback whose conditions cannot be expressed is dropped and counted in `ResolvedSheet.dropped`.
- Leftover `@charset` / `@import` (data:) / `@namespace` are hoisted to the top of the sheet, outside wrappers.
- Rewritten root compounds keep exact specificity: `:is(:where(:root,:host),C:not(*))` for `html`/`:root`, `:is(C,:where(:root,:host))` for classless C.
- Budget: no new fetch under 8 s left, pending ones aborted at deadline - 3 s; the page query is checked before each 5000-selector chunk and raced against deadline - 2 s (unpruned CSS otherwise). Any CSS-phase throw or an over-cap document falls back to the v1 shape.

## Electron service windows (2026-10-20)

Bug: an Electron app (Qure) had a service window with the URL `data:text/html,<html><body></body></html>`.
`PlaywrightTarget` made the last registered page current, so the agent read the empty window and reported
"no data". Fix, app mode only: `launchElectronApp` connects with `skipPlaceholderPages: true`. A placeholder URL is
empty, `about:blank` or `data:*` (`isPlaceholderPageUrl`). With the option on, a placeholder is current only when no
real page exists, a placeholder never takes the current tab from a real page, closing the current page picks the
newest real page, and a page that navigates to a real URL replaces a current placeholder. The launcher also waits up
to `placeholderGraceMs` (default 5000, never past `timeoutMs`) for a real page in `/json/list` before it connects.
Normal browser mode is unchanged: a popup that starts at `about:blank` still becomes current.

Review fixes (same day): a placeholder window that appears beside a real current page (also at construction) becomes current on its first
real main-frame navigation, if that happens within 10 s and the agent has not pinned a tab; `newPage` and `selectPage` pin the current tab against the placeholder hand-off;
the app-mode close guard (`src/shared/placeholderUrl.ts`, shared with the adapter) refuses to close the only real window;
`isPlaceholderPageUrl` matches empty, any `about:` URL and `data:` (not `chrome-error://`). `BrowserTarget.listPages(opts?)`
takes `{ freshTitles: true }`; every `tabs` action result passes it; click detection does not, so it does no `page.title()` round trips.
Each page has one title read in flight: lists reuse it, a read that a navigation overtook writes nothing, and a running read never blocks a script. The launcher passes `{ skipPlaceholderPages: true }`
to an injected `deps.connect` as the third argument, clamps `placeholderGraceMs` (NaN/undefined: 5000, negative: 0), and
connects instead of failing when a page was seen but the last polls errored.
