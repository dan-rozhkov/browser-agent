// Tool descriptions for the seven browse tools. The text is moved as-is from
// Pen Editor's backend (src/ai/tools.ts). Every passage that names a host
// feature (the canvas, browse_task, a Pinterest example, web_search) is a
// SLOT: the package ships a neutral default, and a host passes its own text to
// get back the exact string it had before. Slot values carry no leading or
// trailing space; the templates add the separators.

/** Host-specific passages of the tool descriptions. Every field is optional. */
export interface BrowseDescriptionSlots {
  /** A sentence that opens browse_snapshot's, browse_screenshot's and browse_act's
   * description (and browse_open's, unless `openIntro` is given). It points to a
   * wider tool set, for example a "browse_task" tool. Default: none. */
  taskHint?: string;
  /** Opening of browse_open's description. Default: `taskHint`. */
  openIntro?: string;
  /** The first words of browse_open's description after the intro, up to and
   * including "navigate it to" / "navigates it to". */
  openLead?: string;
  /** A passage after browse_open's body that gives an example use. Default: none. */
  openReach?: string;
  /** What makes a snapshotId stale, in browse_snapshot ("the moment you call ... again"). */
  snapshotStaleCauses?: string;
  /** Clause after "plus the image" in browse_screenshot (no leading "; "). Default: none. */
  screenshotVisionNote?: string;
  /** Last passage of browse_screenshot, for host-only arguments. Default: none. */
  screenshotPlacement?: string;
  /** Words after "an infinite-scroll grid" in browse_act, with a leading space. Default: none. */
  scrollExample?: string;
  /** Sentence in browse_find_images about what to do with the URLs. Default: none. */
  imagesUsage?: string;
  /** Words after "On a search results grid" in browse_find_images, with a leading space. Default: none. */
  imagesGridExample?: string;
  /** Advertise `element` targeting in browse_act (a natural-language target the
   * HOST resolves). Default false: the neutral text has no `element` passages,
   * because `executeBrowseTool` refuses an element-only call.
   * `createBrowseToolDefinitions` also adds the matching field to the schema. */
  elementTargeting?: boolean;
  /** Advertise `app` in browse_open (launch a desktop Electron app). Default false.
   * `createBrowseToolDefinitions` also adds the matching field to the schema. */
  appLaunch?: boolean;
  /** Text added to browse_open's description when `appLaunch` is true. Default: a neutral STE text. */
  openApp?: string;
  /** Second sentence of browse_read about why and when to read. */
  readHow?: string;
}

const join = (...parts: (string | undefined)[]): string => parts.filter((p): p is string => !!p).join(" ");

const DEFAULT_OPEN_APP =
  "Desktop apps: pass `app`, the path of a macOS .app of an Electron app (for example /Applications/Orca.app), instead of `url`. Pass `url` or `app`, not both.";

export function describeBrowseOpen(slots: BrowseDescriptionSlots = {}): string {
  return join(
    slots.openIntro ?? slots.taskHint,
    slots.openLead ?? "Opens a browser tab and navigates it to",
  ) + (slots.appLaunch === true
    ? " `url`, or starts the desktop app in `app` if you pass `app` instead of `url`, waiting for the page to finish loading."
    : " `url`, waiting for the page to finish loading.") + " Returns `{ url, title }` with the FINAL url after any redirects, plus `snapshot` (the same shape browse_snapshot returns — `{ snapshotId, elements, scroll, truncated? }`) taken once the page has settled, so you usually don't need a separate browse_snapshot call right after opening. May also carry `botCheck: true` when the loaded page looks like a CAPTCHA/anti-bot wall (\"just a moment\", \"verify you are human\", captcha, cloudflare…) — when set, hand the task back to the user instead of trying to click through it."
    + (slots.openReach ? " " + slots.openReach : "")
    + (slots.appLaunch === true ? " " + (slots.openApp ?? DEFAULT_OPEN_APP) : "")
    + " " + "Once open, act on the returned `snapshot` directly with browse_act (by index or selector); take a fresh browse_snapshot/browse_screenshot only if it's missing or the page has since changed.";
}

export function describeBrowseSnapshot(slots: BrowseDescriptionSlots = {}): string {
  return (
    "Get an indexed table of every interactive element on the currently open browser tab's page — buttons, links, inputs, selects — without any pixels. Returns `{ snapshotId, url, title, elements: [{ index, tag, label, ops, role?, options?, value?, hasValue?, isPassword?, checked?, scrollable?, frame? }], scroll: { y, height, atBottom } }`. `ops` lists which browse_act actions apply to that element — values are `CLICK` (click/hover), `TYPE_TEXT` (fill a text input/textarea), `SELECT` (pick a `<select>` option). `checked` is the current checkbox/radio state; `scrollable: true` marks an element that is itself a scroll container (pass its `index` to browse_act's `scroll` action to scroll inside it instead of the window); `frame` names the iframe the element lives in when it's not in the top-level document (acting on it by `index` still works the same way, across frames). Pass an element's `index` together with THIS `snapshotId` to browse_act — the indices are only valid for that snapshotId and go stale the moment you call " +
    (slots.snapshotStaleCauses ?? "browse_snapshot or browse_screenshot with annotate again") +
    ", so take a fresh one before acting if you're not sure yours is still current." +
    " " + join(slots.taskHint, "Prefer this over browse_screenshot when you just need to know what's clickable and don't need to actually see the page (cheaper, no image tokens); use browse_screenshot when the layout itself matters or the snapshot's labels are ambiguous.")
  );
}

export function describeBrowseScreenshot(slots: BrowseDescriptionSlots = {}): string {
  return join(
    slots.taskHint,
    "Take a screenshot of the browser tab's current viewport (not the whole page) for visual verification — use this when the layout itself matters (does a modal actually cover the CTA, is a canvas-rendered widget visible, does this look broken) rather than just \"what's clickable\", which browse_snapshot answers more cheaply. Returns `{ url, title, width, height }` plus the image" +
      (slots.screenshotVisionNote ? "; " + slots.screenshotVisionNote : "") +
      ". Pass `annotate: true` to additionally get numbered labels drawn over every interactive element PLUS `snapshotId` and `elements` (the same shape as browse_snapshot) in the same call — use this set-of-marks mode when you want to both see the page and act on it by index in one round trip, instead of calling browse_snapshot separately first.",
    slots.screenshotPlacement,
  );
}

export function describeBrowseAct(slots: BrowseDescriptionSlots = {}): string {
  const el = slots.elementTargeting === true;
  return join(
    slots.taskHint,
    "Act on the currently open browser tab: click, type, scroll, go back/forward, press a key, hover, pick a `<select>` option, upload files, reload, wait, or change the viewport. `target` (for click/type) is matched first as visible text (case-insensitive, trimmed, first match in document order), then as a CSS selector; alternatively pass `index` (from browse_snapshot or an annotated browse_screenshot) together with that call's `snapshotId` to act on a specific element by its number — more reliable than text matching once you have a snapshot" + (el ? "; or pass `element` instead (see below) to skip taking a snapshot yourself" : "") + ". Scrolling is what makes an infinite-scroll grid" + (slots.scrollExample ?? "") + " usable: call `scroll` to load more results, then call browse_find_images (or browse_snapshot) again — `scroll` also takes `index`+`snapshotId` (or `target`) to scroll INSIDE that element (a scrollable panel/modal, or any element browse_snapshot marked `scrollable: true`) instead of the whole window. `press` sends a real key event (`key`: \"Enter\", \"Escape\", \"Tab\", \"ArrowDown\", \"Meta+a\", …), optionally focusing `target`/`index`" + (el ? "/`element`" : "") + " first — this is how you submit a form with Enter or close a modal with Escape. `hover` moves the pointer over `target`/`index`" + (el ? "/`element`" : "") + " without clicking, for hover-revealed menus. `select` needs `index`+`snapshotId`" + (el ? " (or `element`)" : "") + " and `text` = the option's label or value. `upload` sets files on a file input: pass `index`+`snapshotId`" + (el ? " (or `element`)" : "") + " and `files`, 1 to 5 entries of `{ name, mimeType?, text | base64 | sample }`, 2 MB in total. `sample` is a tiny valid file: png, jpg, pdf, txt or csv. Target the input, its label, or a drop zone. A drop zone gets a file drop. `viewport` changes the device emulation, for example to check a responsive layout: `device` is iphone-15, pixel-8, ipad, desktop-1440, desktop-1920, or custom with `width` and `height` (200 to 4000) and optional `mobile`. A change of device can reload the page (the result has `reloaded: true`). `device: \"reset\"` goes back to the start state. Put `viewport` last in a batch: it makes the snapshotId stale for every index-based entry after it. `reload` takes no fields. `wait` polls for `text` to appear (or just sleeps `ms`, default 3000, hard cap 15000) — use it after an action that triggers an async page update before your next snapshot/screenshot. Batching: pass `actions` (1-10 entries, each the same shape as this call minus `snapshotId` — all index-based entries refer to THIS call's top-level `snapshotId`) instead of a single `action` to run several simple steps in one round trip — e.g. fill a few fields then press Enter to submit — rather than spending one chat turn per step. When `actions` is given the top-level `action`/`target`/`index`/etc. fields are ignored; provide exactly one of `action` or `actions`. Entries run in order and stop at the first one that errors or whose target goes stale; the result is `{ results: [...one per entry actually run], completed, stoppedAt?, error? }` alongside the usual fields below." + (el ? " An `element` entry re-snapshots the page to resolve it, which makes the batch's top-level `snapshotId` stale for every entry after it — put `element` entries LAST in the batch, or split into separate batches, never an index-based entry after one; a batch that violates this order is rejected up front with an error naming the offending entry, before anything runs." : "") + " A batch also has its own internal time budget and may stop early with `stoppedAt` and an error saying so if it runs too long — check `completed` rather than assuming every entry ran. Returns `{ url, title, matched }` on success or `{ error }` naming what wasn't found" + (el ? "; resolving via `element` takes a fresh snapshot to match against, so it also returns `resolved: { index, label, confidence, snapshotId?, note }` on both success and failure — `snapshotId` is the NEW current snapshot (any snapshotId you already had is now stale) and `note` says so, UNLESS this same result also carries a `snapshot` field (see below), in which case `resolved.snapshotId` is omitted and `note` instead points you at `snapshot.snapshotId` — always use whichever snapshotId `note` actually names, never an older one you already had. If it can't resolve (no fast model configured, or nothing matched clearly) the error says to retry with `target`/`index` instead" : "") + ". A click/type/press result may also carry `openedTab: { tabId, url, title }` when the action opened a new browser tab — a click on your own tab that opens a popup DOES make that popup your current tab, so your next browse_* call already acts on it; use browse_tabs to switch back to the previous one — and `dialogs: [{ type, message }]` listing any JS alert/confirm/prompt the browser auto-handled since your last command. `changed` (with `changes`, when present) tells you whether the action actually altered the page — check it instead of assuming success; when the action changed the page (or at the end of an `actions` batch, or for `wait`/`scroll`), the result also carries `snapshot` — a compact current snapshot (same shape as browse_snapshot) taken after the action settles, whose `snapshotId` is current — use it for your next index-based call instead of taking a fresh browse_snapshot yourself. May also carry `consoleErrors: string[]` listing new page JS errors observed since your last command.",
  );
}

export function describeBrowseTabs(): string {
  return BROWSE_TABS_DESCRIPTION;
}

export function describeBrowseFindImages(slots: BrowseDescriptionSlots = {}): string {
  return join(
    "Read every image currently visible on the open browser tab's page — both <img> elements and CSS background-images — sorted largest-first and capped at `limit`. Returns `{ images: [{ url, alt, width, height }], count, pageUrl }`.",
    slots.imagesUsage,
    "On a search results grid" + (slots.imagesGridExample ?? "") + " this typically only sees the first screenful — call browse_act with `scroll` and call this again to see more, repeating the loop until you have enough references.",
  );
}

export function describeBrowseRead(slots: BrowseDescriptionSlots = {}): string {
  return (
    "Read the TEXT of the page currently open in the built-in browser tab — headings, visible body text, and links — with scripts, styles, and nav chrome already stripped out. Returns `{ url, title, headings: string[], text: string, links: [{ label, href }], truncated: boolean }`. " +
    (slots.readHow ??
      "This is how you read a page you have already navigated to with browse_open: once the browser is sitting on the page you need, call this to read its actual current content.") +
    " " + "Prefer browse_find_images when you want images rather than text, and browse_snapshot/browse_screenshot when you need to see or act on the page rather than read its content. `maxChars` bounds the returned text (default 6000, hard cap 20000); `selector` narrows the read to one subtree of the page (e.g. \"main\", \"article\") — an unmatched selector is an error, not a silent whole-page read."
  );
}

const BROWSE_TABS_DESCRIPTION = "List, switch, close, or open browser tabs in the built-in browser. `action: \"list\"` returns every open browser tab; `\"switch\"` (needs `tabId`) makes that tab your current one for browse_act/browse_snapshot/browse_screenshot/browse_read; `\"close\"` (needs `tabId`) closes a browser tab (not the app itself); `\"new\"` opens a fresh browser tab, optionally navigating it to `url`, and makes it current. Returns `{ tabs: [{ tabId, url, title, current }], current }`. A browse_act click that opens a popup already makes that popup current (see browse_act's `openedTab`); call this with `action: \"switch\"` when you want to go back to the tab you were on before.";
