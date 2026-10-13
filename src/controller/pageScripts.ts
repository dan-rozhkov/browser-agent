// Scripts injected into a browser tab's real page via
// `WebContents#executeJavaScript` (see controller.ts). Each is a plain
// string constant — a self-invoking function expression that returns a
// JSON-serializable value — with a single ARGS_MARKER placeholder standing
// in for its arguments. controller.ts fills that placeholder in with
// `JSON.stringify(args)` (a JSON literal is always valid JS), never by
// concatenating raw values into the source: an untrusted string value (a
// click target, typed text, a URL) can never break out of the script by
// containing backticks, quotes, or `</script>`-like sequences, since it is
// never written into the template as anything other than the output of
// JSON.stringify.

/** The placeholder every script below embeds its JSON-stringified args at. */
export const ARGS_MARKER = "/*PEN_BROWSER_ARGS*/";

/**
 * Wave 3 reliability, item 1: a shadow-DOM-piercing `querySelectorAll`.
 * `Element.querySelectorAll` never looks inside a shadow root (open or
 * closed) — a growing share of real sites (design-system web components,
 * `<script type="module">` custom elements) put their interactive content
 * behind one, and every element-resolution path in this file
 * (`findByText`, `findBySnapshot`, `SNAPSHOT_JS`'s candidate walk,
 * `READ_JS`'s text/heading/link collection, `FIND_IMAGES_JS`'s image scan)
 * used to simply never see it. `deepQueryAll(root, selector)` walks `root`,
 * collects `root.querySelectorAll(selector)`, then recurses into every
 * descendant's `.shadowRoot` — only ever `open` roots are reachable this
 * way at all (a `closed` root's `shadowRoot` property is `null` from
 * outside, so this is naturally scoped to "open" without any extra check).
 * A closed shadow root is opaque to `document.elementFromPoint` too, so
 * `CLICK_RESOLVE_JS`'s hit-test needs no equivalent change — it already
 * pierces every open shadow root Chromium's own implementation does.
 *
 * Bounded so a huge page (or one with many/deep nested shadow trees) stays
 * fast: `PEN_DEEP_QUERY_MAX_NODES` (5000) caps the total number of elements
 * visited across the whole walk, `PEN_DEEP_QUERY_MAX_DEPTH` (30) caps
 * shadow-root nesting depth (not plain DOM depth, which querySelectorAll
 * already handles natively within one root). Once either bound is hit the
 * walk simply stops descending further — a partial result (missing only
 * what's past the cap) rather than an error, matching this file's existing
 * "degrade, don't throw" posture for every other page script.
 */
const DEEP_QUERY_HELPER_JS = `
  var PEN_DEEP_QUERY_MAX_NODES = 5000;
  var PEN_DEEP_QUERY_MAX_DEPTH = 30;
  function deepQueryAll(root, selector) {
    var results = [];
    var visited = 0;
    function walk(node, depth) {
      if (visited >= PEN_DEEP_QUERY_MAX_NODES || depth > PEN_DEEP_QUERY_MAX_DEPTH) return;
      var matches;
      try {
        matches = node.querySelectorAll(selector);
      } catch (err) {
        matches = [];
      }
      for (var mi = 0; mi < matches.length; mi++) results.push(matches[mi]);
      var all;
      try {
        all = node.querySelectorAll("*");
      } catch (err) {
        all = [];
      }
      for (var ai = 0; ai < all.length; ai++) {
        visited++;
        if (visited >= PEN_DEEP_QUERY_MAX_NODES) return;
        if (all[ai].shadowRoot) walk(all[ai].shadowRoot, depth + 1);
      }
    }
    walk(root, 0);
    return results;
  }
`;

/**
 * Shared `findByText` body, interpolated into both CLICK_JS and TYPE_JS
 * (kept as one TypeScript-side string so the two copies can't drift, even
 * though each is inlined into its own independent IIFE at runtime — there
 * is no module system inside the injected page script).
 *
 * Fix for the "outermost wrapper wins" bug: `document.querySelectorAll("body
 * *")` walks in document order (ancestors before descendants), so a plain
 * first-match scan picks the outermost element whose *trimmed textContent*
 * happens to equal/contain the needle — typically a wrapper `<div>` around
 * the real interactive element, since wrapper text often equals its single
 * child's text. Clicking that div does nothing (click() on an element only
 * bubbles up through ancestors, never down into descendants), so the
 * command falsely reports success. Fixed by (1) searching genuinely
 * clickable elements first, falling back to any element only if none
 * matches, and (2) within each candidate set, preferring the innermost
 * match (the one that contains none of the other candidates) over any
 * ancestor that merely encloses it.
 */
/**
 * THE text -> label/value producer: `penCleanText(root)` is textContent minus
 * what is never visible text — <style>/<script>/<noscript>/<template>
 * subtrees (an inline CSS comment used to become a button's label) and the
 * cursor / marks overlays. Fast path: a node with none of those inside gives
 * its textContent straight back. Otherwise a bounded walk: the element
 * budget limits how many ELEMENT subtrees are entered, but direct text nodes
 * are always collected ("<button><svg>…3500 nodes…</svg>Download</button>").
 */
const TEXT_CLEAN_JS = `
  var PEN_NON_TEXT_TAGS = { STYLE: 1, SCRIPT: 1, NOSCRIPT: 1, TEMPLATE: 1 };
  function penCleanText(root) {
    if (!root) return "";
    if (!root.querySelector || !root.querySelector("style, script, noscript, template, [data-pen-cursor], [data-pen-marks]")) {
      return root.textContent || "";
    }
    var parts = [];
    var budget = 3000;
    (function walk(n) {
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) {
          parts.push(c.nodeValue);
        } else if (c.nodeType === 1) {
          if (PEN_NON_TEXT_TAGS[String(c.tagName).toUpperCase()]) continue;
          if (c.hasAttribute("data-pen-cursor") || c.hasAttribute("data-pen-marks")) continue;
          if (budget <= 0) continue;
          budget--;
          walk(c);
        }
      }
    })(root);
    return parts.join("");
  }
`;

/**
 * The one "visible without the viewport-margin clause" predicate (the test
 * SNAPSHOT_JS's isVisible applies, minus its margin): FIND_BY_TEXT_JS,
 * relocation and the radio/checkbox label proxy all use this copy.
 * Nodes inside the cursor / marks overlays are never visible to it.
 */
const BOX_VISIBLE_JS = `
  function penBoxVisible(node) {
    if (node.closest && (node.closest("[data-pen-cursor]") || node.closest("[data-pen-marks]"))) return false;
    var r = node.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var st = getComputedStyle(node);
    return st.display !== "none" && st.visibility !== "hidden" && parseFloat(st.opacity) !== 0;
  }
`;

/**
 * Wave 2 reliability, item 3: prefers a VISIBLE match over a hidden one — a
 * bench run found a bare word ("Details", say) matching a `display:none`
 * menu item that happened to share the wanted text with the real, visible
 * control, silently "succeeding" against an element nothing could actually
 * see. `findByText` now searches every candidate set twice: once requiring
 * `isVisible` (the same test SNAPSHOT_JS uses, minus its viewport-distance
 * margin clause — a target below the fold is still fair game for a text
 * search, just not a genuinely `display:none`/zero-size one), and only if
 * that yields nothing does it fall back to a hidden match. The return shape
 * is now `{ el, hidden } | null` instead of a bare element, so a caller can
 * tell "found, but only hidden" apart from "found and visible" and refuse to
 * act on the former (see CLICK_JS/TYPE_JS/LOCATE_TARGET_JS's own doc
 * comments) instead of silently clicking/typing into it.
 */
const FIND_BY_TEXT_JS = `
  ${DEEP_QUERY_HELPER_JS}
  ${TEXT_CLEAN_JS}
  ${BOX_VISIBLE_JS}
  function findByText(needle) {
    var wanted = needle.trim().toLowerCase();
    if (!wanted) return null;
    var clickableSelector = "a, button, [role='button'], input, select, textarea, [onclick]";

    function textOf(el) {
      return penCleanText(el).trim().toLowerCase();
    }

    function innermost(elements) {
      for (var i = 0; i < elements.length; i++) {
        var candidate = elements[i];
        var isAncestorOfAnother = false;
        for (var j = 0; j < elements.length; j++) {
          if (i !== j && candidate.contains(elements[j])) {
            isAncestorOfAnother = true;
            break;
          }
        }
        if (!isAncestorOfAnother) return candidate;
      }
      return null;
    }

    // Same test SNAPSHOT_JS's isVisible uses, minus its viewport-distance
    // margin clause (item 3: a text search should still find something
    // below the fold, just not something the page itself hides).
    function isVisibleForText(el) {
      return penBoxVisible(el);
    }

    // Code review finding 5: never match a <style>/<script>/<noscript>/
    // <template> element itself — its "text" is CSS/JS/inert markup, not
    // page content, but its raw source is still exposed via
    // el.textContent like any other element, so a target string that
    // happens to appear literally in a stylesheet or script body (a class
    // name, a URL, a bit of JSON) could otherwise "match" one of these and
    // report a false success against an element nothing could ever see or
    // click.
    var NON_TEXT_TAGS = { STYLE: true, SCRIPT: true, NOSCRIPT: true, TEMPLATE: true };

    function search(selector, matchFn, requireVisible) {
      // Wave 3 reliability, item 1: pierces open shadow roots.
      var all = deepQueryAll(document, selector);
      var matches = [];
      for (var i = 0; i < all.length; i++) {
        if (NON_TEXT_TAGS[all[i].tagName]) continue;
        var text = textOf(all[i]);
        if (!text || !matchFn(text)) continue;
        if (requireVisible && !isVisibleForText(all[i])) continue;
        matches.push(all[i]);
      }
      return innermost(matches);
    }

    function exact(text) {
      return text === wanted;
    }
    function partial(text) {
      return text.indexOf(wanted) !== -1;
    }

    var visibleMatch =
      search(clickableSelector, exact, true) ||
      search(clickableSelector, partial, true) ||
      search("body *", exact, true) ||
      search("body *", partial, true);
    if (visibleMatch) return { el: visibleMatch, hidden: false };

    var hiddenMatch =
      search(clickableSelector, exact, false) ||
      search(clickableSelector, partial, false) ||
      search("body *", exact, false) ||
      search("body *", partial, false);
    if (hiddenMatch) return { el: hiddenMatch, hidden: true };
    return null;
  }
`;

/**
 * Option-like items of OPEN POPUPS, whatever library drew them. Custom
 * dropdowns routinely render each visible option as a role-less
 * <div aria-selected> (or a bare <li style="cursor:pointer">) in a floating
 * layer, while their only role=option nodes sit in a 0x0 a11y-only mirror
 * listbox (the motivating case: Ant Design Select). Without this an open
 * select showed no options and the agent stalled on "no candidate fits
 * CLICK". A page-wide "aria-selected without a role" rule was rejected: it
 * turned selected table rows and carousel slides into options and hid the
 * controls inside them. So the rule is scoped to an OPEN POPUP, with NO
 * library class names. A missed option is better than an invented one on a
 * page with no open list, so every step errs on the side of "not a popup":
 *
 *  1. Owners: visible elements with aria-expanded="true" that are
 *     role=combobox, carry aria-haspopup (listbox/menu/true/tree/grid/dialog)
 *     or sit inside a role=combobox wrapper.
 *  2. An owner's popup is, in order:
 *     a. its aria-controls/aria-owns target (on it or its combobox wrapper)
 *        when that target is rendered, not too small to show (>= 4x4px, no
 *        overflow-clipping ancestor under 4px, no clip:rect(0,0,0,0)) and
 *        holds an item OR any interactive content (role=menuitem/option/
 *        treeitem/gridcell, a[href], button, input...). It IS the popup:
 *        there is no fallback, even with zero role-less items (the ordinary
 *        snapshot rules list its role-bearing controls). Strong signal.
 *     b. else, ONLY for listbox-type owners (role=combobox, inside a
 *        role=combobox wrapper, or aria-haspopup listbox/true/tree/grid;
 *        never aria-haspopup=menu/dialog, whose popups use roles) the
 *        floating layer (computed position fixed/absolute, not containing
 *        the owner, non-zero box, not a wall >= 85% of the viewport in both
 *        axes) ADJACENT to the owner or its combobox wrapper: vertical gap
 *        <= 24px, and its left edge within 32px of the owner's left edge or
 *        overlapping >= 50% of the owner's width. A layer that is/contains a
 *        dialog (role=dialog/alertdialog, aria-modal, <dialog>) or an h1-h3,
 *        or contains a text input outside the owner, is never a popup. Layers
 *        are looked for among the descendants (depth <= 3, <= 300 nodes per
 *        base) of <body>, of the owner's dialog and of its three nearest
 *        ancestors; a layer must hold an item to be chosen, nearest first
 *        (smaller area on a tie).
 *     c. Mirror anchoring (strong signal, wins over geometry): when the owner
 *        has an aria-controls listbox that is a MIRROR (rendered but too
 *        small to show, holding role=option) and a candidate layer (dialog/
 *        heading exclusions and the wall rule still apply, adjacency is
 *        relaxed to <= 400px) contains an element whose trimmed text equals
 *        one of the mirror options' labels, that layer is the popup.
 *  3. Items inside a popup: visible, non-aria-hidden, not aria-disabled, not
 *     pointer-events:none / cursor:not-allowed, with a visible text or label,
 *     and a signal: aria-selected, role=option, tabindex, or computed
 *     cursor:pointer that STARTS at the element (its parent's cursor, the
 *     popup root included, is not pointer: children inherit it, so a pointer
 *     root gives its direct children only the other signals). A role-less
 *     item must also be shown (>= 4px); an explicit role=option is not
 *     size-checked (open/scale transitions). An element with another role is
 *     never an item; natively interactive tags are already candidates, and an
 *     element that CONTAINS a native control or an interactive role (a
 *     <label> around a checkbox) is not an item either: the inner control is
 *     listed as itself. Nested chains collapse to the outermost element,
 *     except that an element holding two or more separate item branches, any
 *     descendant item with a stronger signal (role=option / aria-selected >
 *     tabindex > inherited cursor), or (when tabindex is its ONLY signal) any
 *     item descendant at all, is a container (a tabindex scroll wrapper) and
 *     yields to them.
 *  4. Mirror options: an explicit role=option inside a mirror listbox is
 *     dropped from the snapshot only when its owner has a popup with items
 *     elsewhere (penIsMirrorOption). Every other role=option is listed
 *     whenever the ordinary visibility test passes.
 *
 * Bounded: <= 8 owners, <= 1500 elements scanned per popup root, <= 100 items
 * in all; getComputedStyle runs only inside popups. Shared by SNAPSHOT_JS,
 * FIND_BY_SNAPSHOT_JS and AUTOCOMPLETE_STATE_JS so the three agree on what an
 * option is. Light DOM only inside a popup (owners are found through open
 * shadow roots). The embedding script must include DEEP_QUERY_HELPER_JS
 * itself (once).
 */
const POPUP_OPTION_JS = `
  ${TEXT_CLEAN_JS}
  var PEN_POPUP_ITEM_CAP = 100;
  var PEN_POPUP_OWNER_CAP = 8;
  var PEN_POPUP_SCAN_CAP = 1500;
  var PEN_POPUP_LAYER_NODE_CAP = 300;
  var PEN_POPUP_LAYER_DEPTH = 3;
  var PEN_POPUP_MAX_GAP = 400;
  var PEN_POPUP_ADJ_GAP = 24;
  var PEN_POPUP_ADJ_LEFT = 32;
  var PEN_POPUP_WALL_RATIO = 0.85;
  var PEN_POPUP_DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog';
  var penPopupCache = null;
  // [aria-expanded="true"] elements collected by penCandidates' single deep
  // walk (SNAPSHOT_JS / FIND_BY_SNAPSHOT_JS). Null = no walk ran yet (the
  // AUTOCOMPLETE_STATE_JS path), so penPopupOwners walks for itself. One
  // combined walk instead of a second one: a native querySelector pre-check
  // cannot see open shadow roots, and deepQueryAll is the bounded way in.
  var penExpandedFound = null;

  function penPopupHasBox(el) {
    if (!el || el.nodeType !== 1 || !el.getClientRects || el.getClientRects().length === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // True when \`el\` cannot show anything to a user although it has a box:
  // it, or an overflow-clipping ancestor, is under 4px on an axis, or a
  // clip:rect(0,0,0,0) hides it (the standard sr-only mirror). A scroll
  // container that merely scrolls the element out of view does NOT count.
  var penSmallCache = new Map();
  function penTooSmallToShow(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return true;
    var node = el.parentElement;
    for (var up = 0; node && node !== document.body && node !== document.documentElement && up < 12; up++) {
      if (!penSmallCache.has(node)) {
        var st = getComputedStyle(node);
        var clips = st.overflowX !== "visible" || st.overflowY !== "visible";
        var zeroClip = /rect\\(\\s*0(px)?[ ,]+0(px)?[ ,]+0(px)?[ ,]+0(px)?\\s*\\)/.test(st.clip || "");
        var nr = node.getBoundingClientRect();
        penSmallCache.set(node, zeroClip || (clips && (nr.width < 4 || nr.height < 4)));
      }
      if (penSmallCache.get(node)) return true;
      node = node.parentElement;
    }
    return false;
  }

  var PEN_POPUP_CONTROL_SELECTOR =
    "a[href], button, input, select, textarea, summary, [contenteditable='true'], [contenteditable=''], " +
    "[role='button'], [role='link'], [role='checkbox'], [role='radio'], [role='tab'], [role='menuitem'], " +
    "[role='menuitemcheckbox'], [role='menuitemradio'], [role='combobox'], [role='slider'], [role='switch'], " +
    "[role='textbox'], [role='searchbox'], [role='spinbutton']";
  // Anything a popup target may hold that proves it is the real popup.
  var PEN_POPUP_INTERACTIVE_SELECTOR =
    PEN_POPUP_CONTROL_SELECTOR + ", [role='option'], [role='treeitem'], [role='gridcell']";

  function penPopupOwners() {
    var found = penExpandedFound || deepQueryAll(document, '[aria-expanded="true"]');
    var owners = [];
    for (var oi = 0; oi < found.length && owners.length < PEN_POPUP_OWNER_CAP; oi++) {
      var el = found[oi];
      var role = (el.getAttribute("role") || "").toLowerCase();
      var hp = (el.getAttribute("aria-haspopup") || "").toLowerCase();
      var ok =
        role === "combobox" ||
        /^(true|listbox|menu|tree|grid|dialog)$/.test(hp) ||
        !!(el.closest && el.closest('[role="combobox"]'));
      if (!ok) continue;
      if (el.closest && (el.closest("[data-pen-cursor]") || el.closest("[data-pen-marks]"))) continue;
      // Loose on purpose: a readonly select input is often opacity:0.
      if (!penPopupHasBox(el)) continue;
      var st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") continue;
      owners.push(el);
    }
    return owners;
  }

  // A plain text field with no ARIA autocomplete hints: the only kind whose
  // suggestions can only be found by watching what typing sets in motion.
  function penPlainField(f) {
    var tag = (f.tagName || "").toLowerCase();
    var type = (f.getAttribute("type") || "text").toLowerCase();
    if (!(tag === "textarea" || (tag === "input" && /^(text|search|url|tel|email)$/.test(type)))) return false;
    if (f.closest && f.closest('[role="combobox"]')) return false;
    var au = (f.getAttribute("aria-autocomplete") || "").toLowerCase();
    return au !== "list" && au !== "both" && (f.getAttribute("aria-haspopup") || "").toLowerCase() !== "listbox";
  }

  // The focused PLAIN text field with something typed in it: an owner even
  // without aria-expanded (a plain <input type=text> whose suggestion list is
  // a floating <ul> of role=button rows). Looks through open shadow roots.
  // Never a password field. Returns { el, word } or null; \`word\` is the
  // first token of 2+ letters or digits of the current value, lower-cased
  // (used ONLY to match suggestion rows, it never leaves the page).
  function penFocusOwner() {
    var a = document.activeElement;
    var guard = 0;
    while (a && a.shadowRoot && a.shadowRoot.activeElement && guard < 20) {
      a = a.shadowRoot.activeElement;
      guard++;
    }
    if (!a || a.nodeType !== 1 || !penPlainField(a)) return null;
    if (a.closest && (a.closest("[data-pen-cursor]") || a.closest("[data-pen-marks]"))) return null;
    var m = /[\\p{L}\\p{N}]{2,}/u.exec(String(a.value || ""));
    if (!m || !penPopupHasBox(a)) return null;
    var st = getComputedStyle(a);
    if (st.display === "none" || st.visibility === "hidden") return null;
    return { el: a, word: m[0].toLowerCase() };
  }

  // Extra suggestion rows for a focus owner: role=button elements and native
  // li / a / button inside \`root\`, shown, enabled, whose text has a word
  // STARTING with \`word\` (prefix match). The innermost matching row wins:
  // a matching container is dropped when it holds another matching row.
  // Same filters as penPopupItemsIn; at most PEN_POPUP_LAYER_NODE_CAP nodes.
  var penExtraItems = new Set();
  function penFocusItemsIn(root, owner, word) {
    var nodes = root.querySelectorAll("[role='button'], li, a, button");
    var n = Math.min(nodes.length, PEN_POPUP_LAYER_NODE_CAP);
    var escaped = word.replace(/[.*+?^$()|[\\]{}\\\\]/g, "\\\\$&");
    var prefix = new RegExp("(^|[^\\p{L}\\p{N}])" + escaped, "u");
    var hits = [];
    for (var i = 0; i < n; i++) {
      var el = nodes[i];
      if (el === owner || el.contains(owner)) continue;
      if (el.getAttribute("aria-hidden") === "true" || el.getAttribute("aria-disabled") === "true" || el.hasAttribute("disabled")) continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      var st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden" || parseFloat(st.opacity) === 0) continue;
      if (st.pointerEvents === "none" || st.cursor === "not-allowed") continue;
      if (!penPopupHasBox(el) || penTooSmallToShow(el)) continue;
      var text = String(el.getAttribute("aria-label") || penCleanText(el)).toLowerCase();
      if (!prefix.test(text)) continue;
      hits.push(el);
    }
    var set = new Set(hits);
    var out = [];
    for (var h = 0; h < hits.length; h++) {
      var holdsOther = false;
      for (var k = 0; k < hits.length && !holdsOther; k++) {
        if (k !== h && hits[h].contains(hits[k])) holdsOther = true;
      }
      if (!holdsOther) out.push(hits[h]);
    }
    return out;
  }

  // The new rows of \`root\` for a focus owner, minus any that hold or sit
  // inside an item the ordinary rules already found (the ordinary item wins).
  function penExtraRows(root, owner, word, ordinary) {
    var rows = penFocusItemsIn(root, owner, word);
    return rows.filter(function (row) {
      for (var oi = 0; oi < ordinary.length; oi++) {
        if (ordinary[oi] === row || ordinary[oi].contains(row) || row.contains(ordinary[oi])) return false;
      }
      return true;
    });
  }

  // Floating layers present BEFORE typing next to a plain field are stamped
  // data-pen-pre-type, so a nav / menu already on screen can never become the
  // field's "suggestions". The stamps deliberately OUTLIVE the type command:
  // the next snapshot is a separate script run that must still tell that menu
  // from the list typing produced. They are replaced at the next typing's
  // baseline (old stamps cleared first), and a layer that is the field's OWN
  // current suggestion list (a retype of the same field) is never stamped.
  function penStampPreType(owner) {
    penClearPreType();
    var ownRoots = [];
    var fo = penFocusOwner();
    if (fo && fo.el === owner) {
      var own = penPopupFor(owner);
      if (own && own.focusOwner) ownRoots = own.roots;
    }
    var layers = penFloatingLayers(owner);
    for (var i = 0; i < layers.length; i++) {
      var skip = false;
      for (var r = 0; r < ownRoots.length; r++) {
        if (ownRoots[r] === layers[i] || layers[i].contains(ownRoots[r]) || ownRoots[r].contains(layers[i])) skip = true;
      }
      if (!skip) layers[i].setAttribute("data-pen-pre-type", "1");
    }
  }
  function penClearPreType() {
    var stamped = document.querySelectorAll("[data-pen-pre-type]");
    for (var i = 0; i < stamped.length; i++) stamped[i].removeAttribute("data-pen-pre-type");
  }
  function penIsPreType(node) {
    return !!(node.hasAttribute && node.hasAttribute("data-pen-pre-type")) || !!(node.closest && node.closest("[data-pen-pre-type]"));
  }

  // Only a listbox-type owner may fall back to a geometric guess: a menu or
  // dialog trigger's popup carries roles of its own.
  function penIsListboxOwner(el) {
    var role = (el.getAttribute("role") || "").toLowerCase();
    var hp = (el.getAttribute("aria-haspopup") || "").toLowerCase();
    return role === "combobox" || /^(true|listbox|tree|grid)$/.test(hp) || !!(el.closest && el.closest('[role="combobox"]'));
  }

  // The elements the owner (or its combobox wrapper) names through
  // aria-controls / aria-owns, whatever their state.
  function penRefTargets(owner) {
    var hosts = [owner];
    var wrap = owner.closest ? owner.closest('[role="combobox"]') : null;
    if (wrap && wrap !== owner) hosts.push(wrap);
    var doc = owner.getRootNode ? owner.getRootNode() : document;
    var out = [];
    for (var hi = 0; hi < hosts.length; hi++) {
      var ids = ((hosts[hi].getAttribute("aria-controls") || "") + " " + (hosts[hi].getAttribute("aria-owns") || "")).split(/\\s+/);
      for (var ii = 0; ii < ids.length; ii++) {
        if (!ids[ii]) continue;
        var t = (doc && doc.getElementById && doc.getElementById(ids[ii])) || document.getElementById(ids[ii]);
        if (!t || t === owner || t.contains(owner) || out.indexOf(t) >= 0) continue;
        out.push(t);
      }
    }
    return out;
  }

  function penHasInteractive(root) {
    return !!((root.matches && root.matches(PEN_POPUP_INTERACTIVE_SELECTOR)) || root.querySelector(PEN_POPUP_INTERACTIVE_SELECTOR));
  }

  // The a11y-only mirrors among \`targets\`: rendered (so not the closed
  // display:none list) yet too small to show, holding role=option. Returns
  // the mirror roots and the labels of their options.
  function penMirrors(targets) {
    var roots = [];
    var labels = [];
    for (var ti = 0; ti < targets.length; ti++) {
      var t = targets[ti];
      if (t.getClientRects().length === 0 || !penTooSmallToShow(t)) continue;
      var opts = t.getAttribute("role") === "option" ? [t] : [];
      var inner = t.querySelectorAll('[role="option"]');
      for (var ii = 0; ii < inner.length; ii++) opts.push(inner[ii]);
      if (!opts.length) continue;
      roots.push(t);
      for (var oi = 0; oi < opts.length; oi++) {
        var label = (opts[oi].getAttribute("aria-label") || penCleanText(opts[oi])).trim();
        if (label) labels.push(label);
      }
    }
    return { roots: roots, labels: labels };
  }

  // The option-like items under \`root\` (rules in the comment above).
  function penPopupItemsIn(root) {
    var all = root.querySelectorAll("*");
    var n = Math.min(all.length, PEN_POPUP_SCAN_CAP);
    var cursorOf = new Map();
    function cursor(node) {
      if (!cursorOf.has(node)) cursorOf.set(node, getComputedStyle(node).cursor);
      return cursorOf.get(node);
    }
    var signals = [];
    var strength = new Map();
    var tabOnly = new Set();
    for (var i = 0; i < n; i++) {
      var el = all[i];
      if (!(el instanceof HTMLElement)) continue;
      var explicit = (el.getAttribute("role") || "").toLowerCase();
      if (explicit && explicit !== "option") continue;
      if (!explicit && el.matches("a[href], button, input, select, textarea, summary, [contenteditable='true']")) continue;
      if (el.getAttribute("aria-hidden") === "true" || el.getAttribute("aria-disabled") === "true") continue;
      if (el.hasAttribute("disabled")) continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      var st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden" || parseFloat(st.opacity) === 0) continue;
      if (st.pointerEvents === "none" || st.cursor === "not-allowed") continue;
      var strong = explicit === "option" || el.hasAttribute("aria-selected");
      var tabbable = el.hasAttribute("tabindex");
      // cursor is inherited: the item is where pointer STARTS, so the parent
      // (the popup root included) must not already be pointer.
      var pointerStart = st.cursor === "pointer" && !(el.parentElement && cursor(el.parentElement) === "pointer");
      if (!strong && !tabbable && !pointerStart) continue;
      if (!penPopupHasBox(el)) continue;
      if (explicit !== "option" && penTooSmallToShow(el)) continue;
      // A role-less wrapper around a real control (a <label> around a
      // checkbox) is not an item: the inner control is listed as itself.
      if (explicit !== "option" && el.querySelector(PEN_POPUP_CONTROL_SELECTOR)) continue;
      var label = (el.getAttribute("aria-label") || el.getAttribute("title") || penCleanText(el)).trim();
      if (!label) continue;
      signals.push(el);
      strength.set(el, strong ? 3 : tabbable ? 2 : 1);
      // tabindex alone is a weak signal (a scroll wrapper / focus sink).
      if (!strong && tabbable && !pointerStart) tabOnly.add(el);
    }
    // Collapse: outermost wins, unless it holds two or more item branches (a
    // container), a descendant with a STRONGER signal (role=option /
    // aria-selected > tabindex > inherited cursor), or it is tabindex-only
    // and holds any item at all: those win then.
    var inSet = new Set(signals);
    var kids = new Map();
    var tops = [];
    for (var si = 0; si < signals.length; si++) {
      var parent = signals[si].parentElement;
      while (parent && parent !== root && !inSet.has(parent)) parent = parent.parentElement;
      if (parent && parent !== root) {
        if (!kids.has(parent)) kids.set(parent, []);
        kids.get(parent).push(signals[si]);
      } else {
        tops.push(signals[si]);
      }
    }
    var maxBelow = new Map();
    function strongestBelow(node) {
      if (maxBelow.has(node)) return maxBelow.get(node);
      var best = 0;
      var sub = kids.get(node) || [];
      for (var bi = 0; bi < sub.length; bi++) best = Math.max(best, strength.get(sub[bi]), strongestBelow(sub[bi]));
      maxBelow.set(node, best);
      return best;
    }
    var items = [];
    var stack = tops.slice().reverse();
    while (stack.length) {
      var cur = stack.pop();
      var ch = kids.get(cur) || [];
      if (ch.length >= 2 || strongestBelow(cur) > strength.get(cur) || (ch.length >= 1 && tabOnly.has(cur))) {
        for (var ci = ch.length - 1; ci >= 0; ci--) stack.push(ch[ci]);
      } else {
        items.push(cur);
      }
    }
    return items;
  }

  // A layer that is (or holds) a dialog, a heading, or a text field of its
  // own is a panel / modal, never an option list.
  function penLayerRejected(layer, owner) {
    if ((layer.matches && layer.matches(PEN_POPUP_DIALOG_SELECTOR)) || layer.querySelector(PEN_POPUP_DIALOG_SELECTOR)) return true;
    if (layer.querySelector("h1, h2, h3")) return true;
    var fields = layer.querySelectorAll("input, textarea, [contenteditable='true'], [contenteditable=''], [role='textbox'], [role='searchbox']");
    for (var fi = 0; fi < fields.length; fi++) {
      var type = (fields[fi].getAttribute("type") || "").toLowerCase();
      if (/^(checkbox|radio|button|submit|reset|image|file|range|color|hidden)$/.test(type)) continue;
      if (owner.contains(fields[fi])) continue;
      return true;
    }
    return false;
  }

  function penLayerHasLabel(layer, labels) {
    var all = layer.querySelectorAll("*");
    var n = Math.min(all.length, PEN_POPUP_SCAN_CAP);
    for (var i = 0; i < n; i++) {
      if (labels.indexOf(penCleanText(all[i]).trim()) >= 0) return true;
    }
    return false;
  }

  // The floating layer that best belongs to \`owner\`: see rule 2b/2c above.
  // \`labels\` are the owner's mirror-option labels (may be empty).
  function penFloatingLayers(owner) {
    var bases = [document.body];
    var dlg = owner.closest ? owner.closest(PEN_POPUP_DIALOG_SELECTOR) : null;
    if (dlg) bases.push(dlg);
    var up = owner.parentElement;
    for (var k = 0; k < 3 && up && up !== document.body && up !== document.documentElement; k++) {
      bases.push(up);
      up = up.parentElement;
    }
    var layers = [];
    for (var bi = 0; bi < bases.length; bi++) {
      var queue = [];
      var kidsOfBase = bases[bi].children;
      for (var ki = 0; ki < kidsOfBase.length; ki++) queue.push({ node: kidsOfBase[ki], depth: 1 });
      var visited = 0;
      while (queue.length && visited < PEN_POPUP_LAYER_NODE_CAP) {
        var q = queue.shift();
        var node = q.node;
        visited++;
        if (!(node instanceof HTMLElement) || /^(script|style|template|link|meta)$/i.test(node.tagName)) continue;
        if (node.contains(owner) || node.hasAttribute("data-pen-cursor") || node.hasAttribute("data-pen-marks")) continue;
        var st = getComputedStyle(node);
        if (st.display === "none") continue;
        if ((st.position === "fixed" || st.position === "absolute") && st.visibility !== "hidden" && penPopupHasBox(node)) {
          if (layers.indexOf(node) < 0) layers.push(node);
          continue;
        }
        if (q.depth < PEN_POPUP_LAYER_DEPTH) {
          for (var ci = 0; ci < node.children.length; ci++) queue.push({ node: node.children[ci], depth: q.depth + 1 });
        }
      }
    }
    return layers;
  }

  function penPopupFloating(owner, labels, word) {
    var layers = penFloatingLayers(owner);
    var wrap = owner.closest ? owner.closest('[role="combobox"]') : null;
    var refs = [owner.getBoundingClientRect()];
    if (wrap && wrap !== owner) refs.push(wrap.getBoundingClientRect());
    var cands = [];
    for (var li = 0; li < layers.length; li++) {
      var r = layers[li].getBoundingClientRect();
      if (r.width >= window.innerWidth * PEN_POPUP_WALL_RATIO && r.height >= window.innerHeight * PEN_POPUP_WALL_RATIO) continue;
      // An a11y-only mirror (sr-only 1px clip) is itself an absolute layer
      // near the owner: it shows nothing, so it is never the popup.
      if (penTooSmallToShow(layers[li])) continue;
      var gap = Infinity;
      var adjacent = false;
      for (var ri = 0; ri < refs.length; ri++) {
        var o = refs[ri];
        var g = Math.max(0, r.top - o.bottom, o.top - r.bottom);
        gap = Math.min(gap, g);
        var overlap = Math.min(r.right, o.right) - Math.max(r.left, o.left);
        if (g <= PEN_POPUP_ADJ_GAP && (Math.abs(r.left - o.left) <= PEN_POPUP_ADJ_LEFT || overlap >= o.width * 0.5)) adjacent = true;
      }
      if (gap > PEN_POPUP_MAX_GAP) continue;
      if (penLayerRejected(layers[li], owner)) continue;
      if (word && penIsPreType(layers[li])) continue;
      cands.push({ layer: layers[li], gap: gap, area: r.width * r.height, adjacent: adjacent });
    }
    cands.sort(function (a, b) {
      return a.gap - b.gap || a.area - b.area;
    });
    if (labels && labels.length) {
      for (var ai = 0; ai < cands.length; ai++) {
        if (!penLayerHasLabel(cands[ai].layer, labels)) continue;
        var anchoredItems = penPopupItemsIn(cands[ai].layer);
        if (anchoredItems.length) return { roots: [cands[ai].layer], items: anchoredItems, anchored: true };
      }
    }
    for (var sc = 0; sc < cands.length; sc++) {
      if (!cands[sc].adjacent) continue;
      var items = penPopupItemsIn(cands[sc].layer);
      var extra = word ? penExtraRows(cands[sc].layer, owner, word, items) : [];
      if (items.length || extra.length) return { roots: [cands[sc].layer], items: items.concat(extra), extra: extra, anchored: false };
    }
    return null;
  }

  // [{ owner, roots, items, strong, mirrors }] for every open popup (cached
  // per script run). \`strong\`: found through aria-controls or a mirror
  // anchor, not by geometry alone. \`mirrors\`: the owner's a11y-only
  // role=option listboxes.
  function penPopups() {
    if (penPopupCache) return penPopupCache;
    var out = [];
    var total = 0;
    var owners = penPopupOwners();
    for (var oi = 0; oi < owners.length && total < PEN_POPUP_ITEM_CAP; oi++) {
      var owner = owners[oi];
      var targets = penRefTargets(owner);
      var roots = [];
      var items = [];
      var strong = false;
      for (var ti = 0; ti < targets.length; ti++) {
        if (!penPopupHasBox(targets[ti]) || penTooSmallToShow(targets[ti])) continue;
        var own = penPopupItemsIn(targets[ti]);
        if (own.length || penHasInteractive(targets[ti])) {
          roots.push(targets[ti]);
          items = items.concat(own);
          strong = true;
        }
      }
      var mirror = penMirrors(targets);
      if (!strong && penIsListboxOwner(owner)) {
        var fl = penPopupFloating(owner, mirror.labels);
        if (fl) {
          roots = fl.roots;
          items = fl.items;
          strong = fl.anchored;
        }
      }
      items = items.slice(0, PEN_POPUP_ITEM_CAP - total);
      total += items.length;
      out.push({ owner: owner, roots: roots, items: items, strong: strong, mirrors: mirror.roots });
    }
    // The focused, non-empty PLAIN text field as an additional owner: its
    // popup is its aria-controls target, else the adjacent floating layer —
    // either way only one that did not exist before typing (penStampPreType).
    // Items = the ordinary item rules plus NEW rows (role=button / li / a /
    // button) whose text starts a word with the first token of its value.
    // No item = no popup (fail closed). Items an earlier owner already
    // listed are not listed twice.
    var fo = total < PEN_POPUP_ITEM_CAP ? penFocusOwner() : null;
    if (fo) {
      var fTargets = penRefTargets(fo.el);
      var fRoots = [];
      var fItems = [];
      var fExtra = [];
      var fStrong = false;
      for (var ft = 0; ft < fTargets.length; ft++) {
        if (!penPopupHasBox(fTargets[ft]) || penTooSmallToShow(fTargets[ft]) || penIsPreType(fTargets[ft])) continue;
        var fOrd = penPopupItemsIn(fTargets[ft]);
        var fNew = penExtraRows(fTargets[ft], fo.el, fo.word, fOrd);
        if (fOrd.length || fNew.length) {
          fRoots.push(fTargets[ft]);
          fItems = fItems.concat(fOrd, fNew);
          fExtra = fExtra.concat(fNew);
          fStrong = true;
        }
      }
      if (!fItems.length) {
        var flayer = penPopupFloating(fo.el, [], fo.word);
        if (flayer) {
          fRoots = flayer.roots;
          fItems = flayer.items;
          fExtra = flayer.extra || [];
        }
      }
      var taken = new Set();
      for (var po = 0; po < out.length; po++) for (var pi2 = 0; pi2 < out[po].items.length; pi2++) taken.add(out[po].items[pi2]);
      fItems = fItems.filter(function (it, ix) {
        return fItems.indexOf(it) === ix && !taken.has(it);
      });
      if (fItems.length) {
        fItems = fItems.slice(0, PEN_POPUP_ITEM_CAP - total);
        total += fItems.length;
        var fItemSet = new Set(fItems);
        for (var xi = 0; xi < fExtra.length; xi++) if (fItemSet.has(fExtra[xi])) penExtraItems.add(fExtra[xi]);
        out.push({ owner: fo.el, roots: fRoots, items: fItems, strong: fStrong, mirrors: [], focusOwner: true });
      }
    }
    penPopupCache = out;
    return out;
  }

  function penPopupItems() {
    var seen = new Set();
    var items = [];
    var pops = penPopups();
    for (var pi = 0; pi < pops.length; pi++) {
      for (var ii = 0; ii < pops[pi].items.length; ii++) {
        if (!seen.has(pops[pi].items[ii])) {
          seen.add(pops[pi].items[ii]);
          items.push(pops[pi].items[ii]);
        }
      }
    }
    return items;
  }

  var penPopupItemSetCache = null;
  function penPopupItemSet() {
    if (!penPopupItemSetCache) penPopupItemSetCache = new Set(penPopupItems());
    return penPopupItemSetCache;
  }

  // True for an explicit role=option inside an owner's a11y-only mirror
  // listbox WHEN that owner's visible popup (with items) is found elsewhere:
  // it would repeat the visible option. Any other role=option stays listed.
  function penIsMirrorOption(el) {
    var pops = penPopups();
    for (var pi = 0; pi < pops.length; pi++) {
      if (!pops[pi].items.length) continue;
      for (var mi = 0; mi < pops[pi].mirrors.length; mi++) {
        if (pops[pi].mirrors[mi] === el || pops[pi].mirrors[mi].contains(el)) return true;
      }
    }
    return false;
  }

  // The open popup owned by \`field\`: the owner is the field, holds it, sits
  // inside it, or shares its role=combobox wrapper. Null when none.
  function penPopupFor(field) {
    var pops = penPopups();
    // A field that is itself the focus owner gets its own popup, never an
    // enclosing aria-expanded wrapper's.
    for (var fp = 0; fp < pops.length; fp++) if (pops[fp].focusOwner && pops[fp].owner === field) return pops[fp];
    var fieldWrap = field.closest ? field.closest('[role="combobox"]') : null;
    for (var pi = 0; pi < pops.length; pi++) {
      var owner = pops[pi].owner;
      if (owner === field || owner.contains(field) || field.contains(owner)) return pops[pi];
      if (fieldWrap && owner.closest && owner.closest('[role="combobox"]') === fieldWrap) return pops[pi];
    }
    return null;
  }
`;

/**
 * The candidate selector SNAPSHOT_JS walks, shared with FIND_BY_SNAPSHOT_JS's
 * fingerprint relocation so both look at exactly the same set of elements.
 */
const INTERACTIVE_SELECTOR_JS = `
  ${POPUP_OPTION_JS}
  var INTERACTIVE_SELECTOR =
    "a[href], button, input, select, textarea, [role='button'], [role='link'], " +
    "[role='checkbox'], [role='radio'], [role='tab'], [role='menuitem'], " +
    "[role='combobox'], [role='slider'], [onclick], [contenteditable='true'], " +
    // Custom dropdowns, menus and date pickers (Google Flights' trip-type
    // list, every React Select, a calendar's day grid): without these the
    // agent could open the list but never see what to pick. A gridcell only
    // counts when it is focusable or selectable — a data table's cells are
    // not controls.
    "[role='option'], [role='menuitemradio'], [role='menuitemcheckbox'], " +
    "[role='switch'], [role='treeitem'], [role='gridcell'][tabindex], [role='gridcell'][aria-selected]";

  // INTERACTIVE_SELECTOR's matches plus the option-like items of open popups
  // (POPUP_OPTION_JS): role-less to the selector, options to the step model.
  // Table column headers. A sortable header (aria-sort, a pointer cursor or an
  // onclick handler on the cell itself) is a control; a plain header cell is
  // not, so it never floods the table. A header that CONTAINS a native or ARIA
  // control is not listed as itself: the inner control is the target.
  var PEN_HEADER_SELECTOR = "th, [role='columnheader']";
  var PEN_HEADER_INNER = "a[href], button, input, select, textarea, [role='button'], [role='link']";
  var PEN_HEADER_SCAN_CAP = 300;
  var PEN_HEADER_ITEM_CAP = 40;
  function penIsHeaderCell(el) {
    return !!(el.matches && el.matches(PEN_HEADER_SELECTOR));
  }
  function penHeaderHasInner(el) {
    return !!el.querySelector(PEN_HEADER_INNER);
  }
  function penHeaderItems(seen) {
    var cells = deepQueryAll(document, PEN_HEADER_SELECTOR);
    var out = [];
    var limit = Math.min(cells.length, PEN_HEADER_SCAN_CAP);
    for (var hi = 0; hi < limit && out.length < PEN_HEADER_ITEM_CAP; hi++) {
      var cell = cells[hi];
      if (seen.has(cell) || penHeaderHasInner(cell)) continue;
      if (cell.hasAttribute("aria-sort") || cell.hasAttribute("onclick") || getComputedStyle(cell).cursor === "pointer") {
        out.push(cell);
      }
    }
    return out;
  }

  function penCandidates() {
    var walked = deepQueryAll(document, INTERACTIVE_SELECTOR + ', [aria-expanded="true"]');
    var base = [];
    penExpandedFound = [];
    for (var wi = 0; wi < walked.length; wi++) {
      // A header cell wrapping its own control (onclick on the cell AND a
      // button inside): only the inner control is listed.
      if (penIsHeaderCell(walked[wi]) && penHeaderHasInner(walked[wi])) continue;
      // One deep walk for both sets. An element that does not carry
      // aria-expanded="true" matched through INTERACTIVE_SELECTOR; only an
      // expanded one needs the (second) membership test.
      var expanded = walked[wi].getAttribute("aria-expanded") === "true";
      if (expanded) penExpandedFound.push(walked[wi]);
      if (!expanded || walked[wi].matches(INTERACTIVE_SELECTOR)) base.push(walked[wi]);
    }
    var seen = new Set(base);
    var headers = penHeaderItems(seen);
    for (var hj = 0; hj < headers.length; hj++) {
      base.push(headers[hj]);
      seen.add(headers[hj]);
    }
    var items = penPopupItems();
    for (var pi = 0; pi < items.length; pi++) {
      if (!seen.has(items[pi])) base.push(items[pi]);
    }
    return base;
  }

  // The role the element table reports: the role attribute as written, or
  // "option" for an item of an open popup (penPopupItemSet) so the step model
  // treats it as a list option.
  function penRoleOf(el) {
    var explicit = el.getAttribute("role");
    // A suggestion row of a focus-owner popup (role=button / li / a) is an
    // option like any other popup item, whatever role it carries.
    if (explicit && !(penPopupItemSet().has(el) && penExtraItems.has(el))) return explicit;
    return penPopupItemSet().has(el) ? "option" : "";
  }

  // Roles whose on/off state lives in aria-checked vs aria-selected. Reported
  // as the element table's \`checked\`: without it "One way" and "Round trip"
  // look identical, and the agent re-picks the option that is already on.
  var PEN_ARIA_CHECKED_ROLES = { checkbox: 1, radio: 1, switch: 1, menuitemradio: 1, menuitemcheckbox: 1 };
  var PEN_ARIA_SELECTED_ROLES = { option: 1, gridcell: 1, tab: 1, treeitem: 1 };
  // A disabled option / past calendar day cannot be picked; listing it only
  // spends the element cap and invites a click that does nothing.
  var PEN_SKIP_WHEN_ARIA_DISABLED = { option: 1, gridcell: 1, menuitemradio: 1, menuitemcheckbox: 1, treeitem: 1 };
`;

/**
 * The ARIA slider predicate and bounds, shared by LABEL_HELPER_JS (so
 * SNAPSHOT_JS/FIND_BY_SNAPSHOT_JS list and label it) and TYPE_JS (which
 * includes it directly; PERFORM_JS gets it through FIND_BY_SNAPSHOT_JS). One
 * copy: the listing rule and the typing rule must agree on what a slider is.
 */
const ARIA_SLIDER_HELPER_JS = `
  // A non-native slider (role=slider on a div/span thumb: rc-slider, noUiSlider,
  // Radix, custom widgets). Any native <input> keeps its own path even with
  // role=slider: a native range is a range, and a text input with that role
  // still has to pass the input branch's value-privacy rules.
  function penIsAriaSlider(el) {
    return (
      !!el &&
      el.nodeType === 1 &&
      (el.tagName || "").toLowerCase() !== "input" &&
      (el.getAttribute("role") || "").toLowerCase() === "slider"
    );
  }

  // Only bounds the page states explicitly: null = unknown. The WAI-ARIA
  // defaults (0/100) are a spec fiction for a widget that omits them (a
  // slider with aria-valuenow=500 and no bounds is not clamped to 100), so an
  // unknown side is neither clamped to nor sent Home/End toward. There is no
  // "step" attribute in ARIA.
  function penAriaSliderBounds(el) {
    var min = parseFloat(el.getAttribute("aria-valuemin"));
    var max = parseFloat(el.getAttribute("aria-valuemax"));
    return { min: isNaN(min) ? null : min, max: isNaN(max) ? null : max };
  }

  // The one place a slider's bounds turn into label text, for native ranges
  // and ARIA sliders alike, so their fingerprint labels cannot drift:
  // "0\u20131000", "\u22650", "\u226410" or "" (unknown).
  function penBoundsText(b) {
    if (b.min !== null && b.max !== null) return b.min + "\u2013" + b.max;
    if (b.min !== null) return "\u2265" + b.min;
    if (b.max !== null) return "\u2264" + b.max;
    return "";
  }

  // "slider <bounds>[, step <step>]" — b.step is null/undefined for none.
  function penSliderSuffix(b) {
    var text = penBoundsText(b);
    var suffix = "slider" + (text ? " " + text : "");
    if (b.step !== null && b.step !== undefined) suffix += ", step " + b.step;
    return suffix;
  }
`;

/**
 * Shared label algorithm (`looksGenerated` + `accessibleNameOf` + `labelOf`),
 * interpolated into SNAPSHOT_JS (which reports the label in the element
 * table) AND FIND_BY_SNAPSHOT_JS (which recomputes it to re-find a
 * re-mounted node by fingerprint). One copy on purpose: if the two ever
 * drifted, a relocation would compare against a label the snapshot never
 * reported and silently never match.
 */
const LABEL_HELPER_JS = `
  ${TEXT_CLEAN_JS}
  ${ARIA_SLIDER_HELPER_JS}

  // Review finding 7: a machine-generated id (React useId's ":r3:", Ember's
  // "ember123", Amazon's "a-autoid-1-announce") makes a worse label than the
  // honest positional fallback — it reads as plausible to a decision model,
  // which both defeats MIN_STEP_CONFIDENCE's ability to refuse a bad guess
  // and actively invites a wrong one. A real, hand-authored id ("inp-search",
  // "btn-checkout") is still a legitimate label source and is left alone;
  // only ids that *look* generated are skipped, falling through to whatever
  // label source comes next (and ultimately to the positional fallback).
  function looksGenerated(id) {
    var trimmed = (id || "").trim();
    if (!trimmed) return true;
    if (/^\\d+$/.test(trimmed)) return true; // digits-only, e.g. "123"
    if (/^:.*:$/.test(trimmed)) return true; // React useId, e.g. ":r3:"
    if (/^(react-select|radix-|headlessui-|mui-|chakra-|css-)/i.test(trimmed)) return true; // known framework prefixes
    if (/\\d{2,}$/.test(trimmed)) return true; // digit-suffixed, e.g. "ember123"
    if (/-\\d+(-|$)/.test(trimmed)) return true; // hyphen-digit segment, e.g. "a-autoid-1-announce"
    return false;
  }

  // BROWSE-02 (jev-loop design doc, "Addendum 2, 2026-09-19"): a live
  // Amazon run degraded to a run of unlabelled "div #6"/"input #7" entries
  // whenever the real accessible name lived one level away from the
  // element itself — a descendant icon ("<div role=button><svg
  // aria-label=Save>"), an aria-labelledby reference, or an enclosing
  // <a>/<button> wrapping a plain element. Every step below is tried, in
  // order, before the positional "tag #index" fallback in the caller —
  // which stays last on purpose: dropping an unlabelled element entirely is
  // worse, since cookie banners are made of exactly these.
  function accessibleNameOf(el) {
    var aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    var text = penCleanText(el).trim().replace(/\\s+/g, " ");
    if (text) return text;
    var title = el.getAttribute("title");
    if (title && title.trim()) return title.trim();
    return "";
  }

  function baseLabelOf(el) {
    var aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();

    var labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      var ids = labelledBy.split(/\\s+/);
      var combined = [];
      for (var i = 0; i < ids.length; i++) {
        if (!ids[i]) continue;
        var ref = document.getElementById(ids[i]);
        if (!ref) continue;
        var refText = penCleanText(ref).trim().replace(/\\s+/g, " ");
        if (refText) combined.push(refText);
      }
      var joined = combined.join(" ").trim();
      if (joined) return joined;
    }

    // An associated <label> (for= or wrapping) — the ONLY name a plain radio
    // or checkbox has. Without this step both shipping radios of a checkout
    // form fell through to their shared name="shipping" and were
    // indistinguishable in the element table: the bench run picked
    // "express" when asked for "standard" in two runs out of three. Read
    // from a clone with the form controls removed, so a wrapping
    // <label>Country <select>…</select></label> doesn't glue every option's
    // text onto the name.
    if (el.labels && el.labels.length) {
      var labelTexts = [];
      for (var li = 0; li < el.labels.length; li++) {
        var clone = el.labels[li].cloneNode(true);
        var controls = clone.querySelectorAll("input, select, textarea, button");
        for (var ci = 0; ci < controls.length; ci++) controls[ci].remove();
        var labelText = penCleanText(clone).trim().replace(/\\s+/g, " ");
        if (labelText) labelTexts.push(labelText);
      }
      var labelJoined = labelTexts.join(" ").trim();
      if (labelJoined) return labelJoined;
    }

    var text = penCleanText(el).trim().replace(/\\s+/g, " ");
    // A calendar day or a numbered cell reads "14" (or "14$34" with a price)
    // while its real name — "Saturday, November 14, 2026" — sits on a child.
    // Bare digits there made every month's 14th the same label, and the
    // agent picked the wrong month's day.
    if (text && !/\\p{L}{3,}/u.test(text)) {
      var namedKids = el.querySelectorAll("[aria-label]");
      for (var nk = 0; nk < namedKids.length; nk++) {
        var kidName = (namedKids[nk].getAttribute("aria-label") || "").trim();
        if (/\\p{L}{3,}/u.test(kidName)) return kidName;
      }
    }
    if (text) return text;

    var placeholder = el.getAttribute("placeholder");
    if (placeholder && placeholder.trim()) return placeholder.trim();

    var alt = el.getAttribute("alt");
    if (alt && alt.trim()) return alt.trim();

    var title = el.getAttribute("title");
    if (title && title.trim()) return title.trim();

    // Review finding 6: a descendant's aria-label/title/alt — the common
    // icon-button shape, e.g. <div role="button"><img alt=""><svg
    // aria-label="Save"></svg></div>. The *first* element matching
    // [aria-label],[title],[alt] is not necessarily the labelled one (an
    // empty-alt <img> placed before the real svg[aria-label] used to make
    // this whole step yield nothing) — every match is tried, in document
    // order, until one actually has a non-empty value.
    var descendants = el.querySelectorAll("[aria-label], [title], [alt]");
    for (var di = 0; di < descendants.length; di++) {
      var d = descendants[di];
      var dAria = d.getAttribute("aria-label");
      if (dAria && dAria.trim()) return dAria.trim();
      var dTitle = d.getAttribute("title");
      if (dTitle && dTitle.trim()) return dTitle.trim();
      var dAlt = d.getAttribute("alt");
      if (dAlt && dAlt.trim()) return dAlt.trim();
    }

    // The accessible name of the nearest enclosing <a>/<button> — for an
    // element that is itself unlabelled but sits inside a labelled control
    // (a plain <input> wrapped by an <a aria-label="…">, say). Guarded
    // against matching el itself, which every earlier step already
    // covered.
    var enclosing = el.closest("a, button");
    if (enclosing && enclosing !== el) {
      var enclosingName = accessibleNameOf(enclosing);
      if (enclosingName) return enclosingName;
    }

    var name = el.getAttribute("name");
    if (name && name.trim()) return name.trim();

    var id = el.id;
    if (id && id.trim() && !looksGenerated(id)) return id.trim();

    return "";
  }

  function penIsRange(el) {
    return (
      !!el &&
      (el.tagName || "").toLowerCase() === "input" &&
      (el.getAttribute("type") || "").toLowerCase() === "range"
    );
  }

  // A range input's own label ("Max.") says nothing about WHAT it ranges
  // over; the small model that writes the TYPE_TEXT value never knew a
  // hidden "Min."/"Max." pair was a nightly-cost filter. The question lives
  // on an ancestor: the <legend> of a <fieldset> (nearest one with a
  // non-empty legend wins), else the aria-label / aria-labelledby of a
  // [role=group]/<fieldset>, looked for up to 6 levels up. Live finding: the
  // native inputs sit 4 levels below the legend that names the filter.
  function penGroupContextOf(el) {
    var node = el.parentElement;
    var ancestors = [];
    for (var lvl = 0; node && lvl < 6; lvl++) {
      ancestors.push(node);
      node = node.parentElement;
    }
    function clean(t) {
      return (t || "").trim().replace(/\\s+/g, " ").slice(0, 50);
    }
    for (var a = 0; a < ancestors.length; a++) {
      if ((ancestors[a].tagName || "").toLowerCase() !== "fieldset") continue;
      var legend = ancestors[a].querySelector(":scope > legend");
      var legendText = legend ? clean(penCleanText(legend)) : "";
      if (legendText) return legendText;
    }
    for (var b = 0; b < ancestors.length; b++) {
      var anc = ancestors[b];
      var isGroup = (anc.getAttribute("role") || "") === "group" || (anc.tagName || "").toLowerCase() === "fieldset";
      if (!isGroup) continue;
      var groupAria = clean(anc.getAttribute("aria-label"));
      if (groupAria) return groupAria;
      var groupBy = anc.getAttribute("aria-labelledby");
      if (groupBy) {
        var gIds = groupBy.split(/\\s+/);
        var gParts = [];
        for (var g = 0; g < gIds.length; g++) {
          var gRef = gIds[g] ? document.getElementById(gIds[g]) : null;
          var gText = gRef ? clean(penCleanText(gRef)) : "";
          if (gText) gParts.push(gText);
        }
        if (gParts.length) return gParts.join(" ").slice(0, 50);
      }
    }
    return "";
  }

  // Context for a slider with NO legend / labelled group AND no label of its
  // own (labelOf asks only then: "Volume" needs no help), from nearby visible
  // text. Ten bare "slider 0-100" controls on one page (a component gallery)
  // are otherwise indistinguishable. One rule, per element (no cross-element
  // dedupe, so the label the snapshot reports is the one relocation
  // recomputes): the SMALLEST ancestor (<= 9 levels up: a thumb sits several
  // wrappers below its track) whose text, minus that of the sliders inside
  // it, has a meaningful line. No context when that ancestor holds more than
  // 4 sliders (too shared to name this one), or when it, or an ancestor on
  // the way, has more than 2000 chars of text or contains page furniture (a
  // page region, not a card: climbing on would label a slider with the site
  // header), and never <body>/<html> themselves. The cheap
  // textContent tests run first; innerText is read only on a candidate.
  // Meaningful = a line with a real word and none of: a digit (live readouts
  // like "Up to \u20ac400" or "75%" change as the slider moves and would break
  // fingerprint relocation; it also drops code- and password-like tokens), an
  // "@", a code character, a trailing colon (the caption of a neighbouring
  // control, "Disabled:") or a leading quote. The first two are joined and
  // capped at 40 chars. The same visible text already leaves the page in the
  // snapshot's text field.
  function penNearbyTextOf(el) {
    var SLIDER_SEL = "[role='slider'], input[type='range']";
    function meaningful(text) {
      var lines = text.split(/\\n+/);
      var kept = [];
      for (var li = 0; li < lines.length && kept.length < 2; li++) {
        var line = lines[li].trim().replace(/\\s+/g, " ");
        if (
          /\\p{L}{3,}/u.test(line) &&
          !/\\d|@|:$|[<>{};=\\[\\]]|,$|^['"]/.test(line)
        ) {
          kept.push(line);
        }
      }
      return kept.join(" ").slice(0, 40).trim();
    }
    // A container with page furniture in it (nav, footer, banner) is a page
    // region, not a card: never name a slider after the site header.
    var FURNITURE_SEL =
      "nav, footer, [role='banner'], [role='navigation'], [role='contentinfo'], header:not(:is(article, section, main, aside) header)";
    var anc = el.parentElement;
    for (var up = 0; anc && up < 9; up++) {
      if (anc === document.body || anc === document.documentElement) return "";
      var all = anc.textContent || "";
      if (all.length > 2000 || anc.querySelector(FURNITURE_SEL)) return "";
      var sliders = anc.querySelectorAll(SLIDER_SEL);
      var rest = all;
      for (var si = 0; si < sliders.length; si++) {
        var st = sliders[si].textContent || "";
        if (st) rest = rest.replace(st, "");
      }
      if (/\\p{L}{3,}/u.test(rest)) {
        var text = anc.innerText || "";
        for (var sj = 0; sj < sliders.length; sj++) {
          var st2 = sliders[sj].textContent || "";
          if (st2) text = text.replace(st2, "");
        }
        var found = meaningful(text);
        if (found) return sliders.length <= 4 ? found : "";
      }
      anc = anc.parentElement;
    }
    return "";
  }

  function penRangeBounds(el) {
    var min = parseFloat(el.getAttribute("min"));
    var max = parseFloat(el.getAttribute("max"));
    if (isNaN(min)) min = 0;
    if (isNaN(max)) max = 100;
    var stepAttr = (el.getAttribute("step") || "").trim().toLowerCase();
    var step = stepAttr === "any" ? NaN : parseFloat(stepAttr);
    if (stepAttr === "") step = 1;
    return { min: min, max: max, step: step, anyStep: stepAttr === "any" };
  }

  // "<group context>: <own label> (slider <min>–<max>, step <step>)". The
  // suffix must survive the callers' PEN_LABEL_MAX slice, so the two text
  // parts are capped well below it.
  function labelOf(el) {
    var own = baseLabelOf(el);
    var bounds;
    if (penIsAriaSlider(el)) {
      bounds = penAriaSliderBounds(el);
    } else if (penIsRange(el)) {
      var rb = penRangeBounds(el);
      var stepAttrRaw = (el.getAttribute("step") || "").trim();
      bounds = { min: rb.min, max: rb.max, step: stepAttrRaw && !rb.anyStep && !isNaN(rb.step) ? rb.step : null };
    } else {
      return own;
    }
    var suffix = penSliderSuffix(bounds);
    var head = [penGroupContextOf(el) || (own ? "" : penNearbyTextOf(el)), own.slice(0, 40)].filter(Boolean).join(": ");
    return head ? head + " (" + suffix + ")" : suffix;
  }

  var PEN_LABEL_MAX = 120;
  // The label exactly as the element table reports it (truncated), or "" when
  // labelOf found nothing (SNAPSHOT_JS then falls back to a positional
  // "<tag> #<n>" label, which is never a fingerprint).
  function truncatedLabelOf(el) {
    var full = labelOf(el);
    return full ? full.slice(0, PEN_LABEL_MAX) : "";
  }
`;

/**
 * Radio/checkbox "tiles": the native input is routinely made invisible on
 * purpose (opacity:0 stretched over a styled <label>, or a 1x1 clip-hidden box
 * beside a swatch label) while the label is what the user sees and clicks.
 * isVisible drops such an input, so the choice never reached the element
 * table. `penToggleProxy(el)` is THE one place that picks the label standing
 * in for the input: used by SNAPSHOT_JS (box), MARKS_JS (mark placement), the
 * click/reveal path and fingerprint relocation, so the listed label and the
 * clicked label are always the same node. It is null unless the input is
 * "hidden on purpose" (`penToggleHidden`: opacity 0, a box under 2px on an
 * axis, or clip-hidden) and some associated label (`el.labels`, first visible
 * wins) is visible. Fail-closed: null when the input, or anything above it,
 * is display:none / visibility:hidden / content-visibility hidden. Cached per
 * input for the life of one page-script run.
 */
const TOGGLE_PROXY_JS = `
  ${BOX_VISIBLE_JS}

  function penToggleInput(el) {
    if (!el || el.nodeType !== 1 || (el.tagName || "").toLowerCase() !== "input") return false;
    var t = (el.getAttribute("type") || "").toLowerCase();
    return t === "radio" || t === "checkbox";
  }

  var PEN_CLIP_ZERO = /^rect\\(\\s*0(px)?[\\s,]+0(px)?[\\s,]+0(px)?[\\s,]+0(px)?\\s*\\)$/;
  function penToggleHidden(el) {
    if (!penToggleInput(el)) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return true;
    var st = getComputedStyle(el);
    if (parseFloat(st.opacity) === 0) return true;
    if (PEN_CLIP_ZERO.test(String(st.clip || "").trim())) return true;
    var cp = String(st.clipPath || "").replace(/\\s+/g, "");
    return cp === "inset(50%)" || cp === "inset(100%)";
  }

  // Whether el and everything above it are rendered (opacity is NOT checked:
  // an opacity:0 input is the whole point).
  function penRenderedChain(el) {
    if (typeof el.checkVisibility === "function") {
      return el.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true });
    }
    var own = getComputedStyle(el);
    if (own.display === "none" || own.visibility === "hidden") return false;
    var depth = 0;
    var up = el.parentNode;
    while (up && up.nodeType !== 9 && depth < 12) {
      if (up.nodeType === 1 && getComputedStyle(up).display === "none") return false;
      up = up.nodeType === 11 && up.host ? up.host : up.parentNode;
      depth++;
    }
    return true;
  }

  var penToggleProxyCache = new Map();
  function penToggleProxy(el) {
    if (!penToggleInput(el)) return null;
    if (penToggleProxyCache.has(el)) return penToggleProxyCache.get(el);
    var found = null;
    if (el.labels && el.labels.length && penToggleHidden(el) && penRenderedChain(el)) {
      for (var li = 0; li < el.labels.length; li++) {
        var label = el.labels[li];
        if (label !== el && penBoxVisible(label)) {
          found = label;
          break;
        }
      }
    }
    penToggleProxyCache.set(el, found);
    return found;
  }
`;

/**
 * Shared `findBySnapshot` body, interpolated into FOCUS_JS/HOVER_TARGET_JS
 * (review finding 5). Both used to embed `args.snapshotId` straight into a
 * `[data-pen-snap="' + snapshotId + ":" + index + '"]'` selector string —
 * unlike PERFORM_JS's identical-looking lookup, whose `snapshotId` only ever
 * comes from this controller's own server-generated ids, these two accept
 * whatever `snapshotId` a press/hover call passes, so a value containing a
 * `"` (or any CSS-selector metacharacter) would either throw out of
 * `querySelector` or, worse, close the attribute selector early and let the
 * rest of the string be interpreted as selector syntax. Iterating
 * `[data-pen-snap]` and comparing the attribute value with plain string
 * equality sidesteps selector-injection entirely — no value of `snapshotId`
 * can ever be anything other than a literal string compare.
 */
const FIND_BY_SNAPSHOT_JS = `
  ${DEEP_QUERY_HELPER_JS}
  ${INTERACTIVE_SELECTOR_JS}
  ${LABEL_HELPER_JS}
  ${TOGGLE_PROXY_JS}

  // Set true when findBySnapshot re-found a re-mounted node by fingerprint
  // (see below); read by the script that interpolated this snippet so it can
  // report \`relocated: true\`. Per-script: each script is its own IIFE.
  var penRelocated = false;

  // Same visibility test as SNAPSHOT_JS's isVisible, minus its viewport
  // margin clause (like FIND_BY_TEXT_JS's isVisibleForText): the node we want
  // may be below the fold; it just must not be hidden.
  function penFingerprintVisible(el) {
    if (el.closest && (el.closest("[data-pen-cursor]") || el.closest("[data-pen-marks]"))) return false;
    // A hidden native range input is listed by SNAPSHOT_JS through its
    // visible proxy (penRangeProxy); relocation has to accept the same node.
    if (penIsRange(el)) {
      var rs = getComputedStyle(el);
      return rs.display !== "none" && rs.visibility !== "hidden" && el.getClientRects().length > 0;
    }
    // Likewise a hidden-on-purpose radio/checkbox, listed via its label.
    if (penToggleProxy(el)) return true;
    return penBoxVisible(el);
  }

  // Re-finds a node the page re-mounted between snapshot and action
  // (booking.com replaces its search form ~1s after load, so the stamped
  // node is gone). Only a UNIQUE exact match on tag + role + label — the
  // same fields the element table reported — is accepted; zero or several
  // matches return null (fail closed, exactly as before). Password inputs are
  // never relocated: the fingerprint carries no input type, so a re-mounted
  // field could differ from the one the snapshot flagged isPassword.
  function relocateByFingerprint(fingerprint, snapshotId) {
    if (!fingerprint || typeof fingerprint.tag !== "string" || typeof fingerprint.label !== "string" || !fingerprint.label) {
      return null;
    }
    // Only within the document the snapshot was taken in: SNAPSHOT_JS records
    // { id, href } on this window (a new document loses it; an SPA route
    // change keeps window but changes href). Without it, a same-tab
    // navigation would let an old index click the NEW page's unique lookalike.
    var snapDoc = window.__penSnapDoc;
    if (!snapDoc || snapDoc.id !== String(snapshotId) || snapDoc.href !== location.href) return null;
    var ownPrefix = String(snapshotId) + ":";
    var wantedRole = fingerprint.role || "";
    var candidates = penCandidates();
    var match = null;
    for (var ri = 0; ri < candidates.length; ri++) {
      var cand = candidates[ri];
      if ((cand.tagName || "").toLowerCase() !== fingerprint.tag) continue;
      if (penRoleOf(cand) !== wantedRole) continue;
      if (fingerprint.tag === "input" && (cand.getAttribute("type") || "").toLowerCase() === "password") continue;
      // Never take a node stamped for another index of this snapshot (two
      // "Remove" buttons: a retry of a removed one must not hit its sibling).
      var candStamp = cand.getAttribute("data-pen-snap");
      if (candStamp && candStamp.indexOf(ownPrefix) === 0) continue;
      if (!penFingerprintVisible(cand)) continue;
      if (truncatedLabelOf(cand) !== fingerprint.label) continue;
      if (match) return null; // ambiguous
      match = cand;
    }
    return match;
  }

  function findBySnapshot(snapshotId, index, fingerprint) {
    if (snapshotId === undefined || snapshotId === null || index === undefined || index === null) return null;
    var stamp = String(snapshotId) + ":" + String(index);
    // Wave 3 reliability, item 1: an element SNAPSHOT_JS stamped inside an
    // open shadow root is only reachable via deepQueryAll — a plain
    // document.querySelectorAll("[data-pen-snap]") never looks inside one.
    var all = deepQueryAll(document, "[data-pen-snap]");
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute("data-pen-snap") === stamp) return all[i];
    }
    var relocated = fingerprint ? relocateByFingerprint(fingerprint, snapshotId) : null;
    if (relocated) {
      relocated.setAttribute("data-pen-snap", stamp);
      penRelocated = true;
      return relocated;
    }
    return null;
  }
`;

/**
 * Composed hit-test + "related" test, shared by CLICK_RESOLVE_JS (is the
 * click point really on the target?) and SNAPSHOT_JS (is a candidate covered
 * by an overlay a user couldn't click through?) so the two can never drift —
 * a control SNAPSHOT_JS offers must be one CLICK_RESOLVE_JS would accept.
 *
 * `elementFromPointDeep` walks into *open* shadow roots (a closed root is
 * opaque, same as `elementFromPoint` itself). `penHitIsRelated(el, hit)`
 * is true when the hit is el, a descendant, an ancestor (a click landing on a
 * wrapper still bubbles to the target's listener), or a <label> that
 * contains el / whose `for` equals el.id. `penOverlayLayerFor` / `penIsWall`
 * classify what is on top of an element (see their comments).
 */
const HIT_TEST_HELPER_JS = `
  function elementFromPointDeep(px, py) {
    var node = document.elementFromPoint(px, py);
    var guard = 0;
    while (node && node.shadowRoot && guard < 20) {
      var inner = node.shadowRoot.elementFromPoint(px, py);
      if (!inner || inner === node) break;
      node = inner;
      guard++;
    }
    return node;
  }

  function penComposedParent(node) {
    var parent = node.parentNode;
    if (parent && parent.nodeType === 11 && parent.host) return parent.host; // ShadowRoot -> host
    return parent;
  }

  function penComposedContains(container, node) {
    var guard = 0;
    while (node && guard < 500) {
      if (node === container) return true;
      node = penComposedParent(node);
      guard++;
    }
    return false;
  }

  // The nearest fixed/sticky ancestor of hitEl that does NOT also contain el —
  // an overlay layer (modal backdrop, cookie banner, sticky header) sitting on
  // top of el rather than el's own positioned wrapper, skipping
  // pointer-events:none layers. null if there is none (the hit is then not
  // treated as a wall: the element stays listed).
  // Cached per node: a page has few distinct layers but many candidates.
  var penLayerCache = new Map();
  function penOverlayLayerFor(hitEl, el) {
    var node = hitEl;
    var guard = 0;
    while (node && node.nodeType === 1 && guard < 500) {
      var info = penLayerCache.get(node);
      if (info === undefined) {
        var cs = getComputedStyle(node);
        info = { pos: cs.position, none: cs.pointerEvents === "none" };
        penLayerCache.set(node, info);
      }
      // pointer-events:none layers (toast containers: sonner, react-hot-toast
      // — fixed, near viewport-sized) never receive the click, so they are
      // never the occluder; keep walking to the next layer that does.
      if ((info.pos === "fixed" || info.pos === "sticky") && !info.none && !penComposedContains(node, el)) return node;
      node = penComposedParent(node);
      guard++;
    }
    return null;
  }

  // A "wall" is an overlay layer covering at least 85% of the viewport (a
  // modal backdrop, a full-page cookie wall): nothing behind it can be
  // scrolled clear, so those controls really are unreachable. A partial bar
  // (booking.com's OneTrust banner, div.otFlat: fixed, bottom, full width,
  // ~200px of an 800px viewport, NOT aria-modal) is not a wall — the element
  // under it can be scrolled out from beneath it, and a calendar popup's day
  // cells can sit exactly there. An earlier version dropped anything under
  // ANY fixed layer and hid every calendar day, so Jev kept re-toggling the
  // date field. Area is the layer's rect clipped to the viewport.
  function penIsWall(layer) {
    var lr = layer.getBoundingClientRect();
    var w = Math.min(lr.right, window.innerWidth) - Math.max(lr.left, 0);
    var h = Math.min(lr.bottom, window.innerHeight) - Math.max(lr.top, 0);
    if (w <= 0 || h <= 0) return false;
    return (w * h) / (window.innerWidth * window.innerHeight) >= 0.85;
  }

  // Samples up to 5 viewport-clipped points of el (centre + the 25%/75%
  // corners) through the shared hit-test. Returns how many were testable,
  // whether any hit was related to el, and how many unrelated hits sit under
  // a WALL layer. Elements outside the viewport have nothing testable.
  //
  // boxEl (optional) is the element whose rect is sampled when el has no
  // usable box of its own — a visually hidden native range input is probed
  // through its visible proxy, and a hit inside that proxy counts as related.
  function penProbe(el, boxEl) {
    var out = { testable: 0, related: false, walled: 0, wall: null };
    var r = (boxEl || el).getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return out;
    if (r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth) return out;
    var fracs = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
    for (var pi = 0; pi < fracs.length; pi++) {
      var px = r.left + r.width * fracs[pi][0];
      var py = r.top + r.height * fracs[pi][1];
      if (px < 0 || py < 0 || px >= window.innerWidth || py >= window.innerHeight) continue;
      var hit = elementFromPointDeep(px, py);
      if (!hit) continue;
      out.testable++;
      if (penHitIsRelated(el, hit) || (boxEl && boxEl !== el && penHitIsRelated(boxEl, hit))) {
        out.related = true;
        return out;
      }
      var layer = penOverlayLayerFor(hit, el);
      if (layer && penIsWall(layer)) {
        out.walled++;
        if (!out.wall) out.wall = layer;
      }
    }
    return out;
  }

  function penHitIsRelated(el, hitEl) {
    if (!hitEl) return false;
    if (hitEl === el || (el.contains && el.contains(hitEl)) || (hitEl.contains && hitEl.contains(el))) return true;
    var labelAncestor = hitEl.closest && hitEl.closest("label");
    if (labelAncestor) {
      if (labelAncestor.contains(el)) return true;
      var forId = labelAncestor.getAttribute("for");
      if (forId && el.id === forId) return true;
    }
    return false;
  }
`;
/**
 * "Scroll only if needed" (Google Flights calendar bug): an unconditional
 * \`scrollIntoView({ inline: "center" })\` on a target that was already fully
 * visible scrolled the horizontal month strip it lives in, the site's own
 * scroll handler snapped it back ~300 ms later, and the trusted click — whose
 * coordinates were computed in between — landed on the gap between months.
 * A reveal must therefore never move a target a user could already click:
 * if its box is non-empty, lies fully inside the viewport AND a hit-test at
 * its centre lands on it (or a related node, HIT_TEST_HELPER_JS), nothing is
 * scrolled. Otherwise it scrolls with \`block: "center"\` but
 * \`inline: "nearest"\`, so a carousel/strip is never centred horizontally
 * just because. Always \`behavior: "instant"\` (see LOCATE_TARGET_JS).
 * Returns true when it scrolled. Interpolates HIT_TEST_HELPER_JS itself.
 */
const REVEAL_IF_NEEDED_JS = `
  ${HIT_TEST_HELPER_JS}
  ${TOGGLE_PROXY_JS}

  // Descendants of a label that a click must never land on (a link in a tile).
  var PEN_LABEL_INTERACTIVE = "a, button, input, select, textarea, [role='link'], [role='button'], [onclick]";
  function penHitOnLabelControl(hit, label, input) {
    var node = hit;
    while (node && node !== label) {
      if (node.nodeType === 1 && node !== input && node.matches && node.matches(PEN_LABEL_INTERACTIVE)) return true;
      node = node.parentNode;
    }
    return false;
  }

  function penPointInViewport(x, y) {
    return x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;
  }

  // Where a click on el should land: { box, x, y, hitOk }. Normally el's own
  // centre. For a hidden-on-purpose radio/checkbox (penToggleProxy): its own
  // centre when it is a real, hit-testable box (the stretched opacity:0
  // tile), else the first of centre / 25% / 75% points of its label whose hit
  // is inside the label and NOT on another control in it. No such point:
  // hitOk false (the caller falls back to the DOM click on the input itself).
  function penClickPoint(el) {
    var proxy = penToggleProxy(el);
    var r = el.getBoundingClientRect();
    var x = r.left + r.width / 2;
    var y = r.top + r.height / 2;
    if (!proxy || (r.width >= 8 && r.height >= 8 && penPointInViewport(x, y) && penHitIsRelated(el, elementFromPointDeep(x, y)))) {
      var ok = r.width > 0 && r.height > 0 && penPointInViewport(x, y) && penHitIsRelated(el, elementFromPointDeep(x, y));
      return { box: el, x: x, y: y, hitOk: ok };
    }
    var lr = proxy.getBoundingClientRect();
    var fracs = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
    for (var fi = 0; fi < fracs.length; fi++) {
      var px = lr.left + lr.width * fracs[fi][0];
      var py = lr.top + lr.height * fracs[fi][1];
      if (!penPointInViewport(px, py)) continue;
      var hit = elementFromPointDeep(px, py);
      if (hit && (hit === proxy || proxy.contains(hit)) && !penHitOnLabelControl(hit, proxy, el)) {
        return { box: proxy, x: px, y: py, hitOk: true };
      }
    }
    return { box: proxy, x: lr.left + lr.width / 2, y: lr.top + lr.height / 2, hitOk: false };
  }

  function penRevealIfNeeded(el) {
    var cp = penClickPoint(el);
    var r = cp.box.getBoundingClientRect();
    if (cp.hitOk && r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight) {
      return false;
    }
    cp.box.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    return true;
  }
`;

/**
 * Shared target-resolution + scroll-into-view helper for FOCUS_JS,
 * HOVER_TARGET_JS, CLICK_RESOLVE_JS and SCROLL_JS (second-pass review finding
 * 10 — before this, FOCUS_JS/HOVER_TARGET_JS each inlined an identical copy of
 * this same resolution order, one that could silently drift between the two;
 * Wave 2 reliability reuses it again rather than adding a third copy).
 * Resolves by `snapshotId`+`index` (the exact `data-pen-snap` stamp, via
 * FIND_BY_SNAPSHOT_JS — same as PERFORM_JS), else by visible text/selector
 * (FIND_BY_TEXT_JS, same order as CLICK_JS/TYPE_JS), then scrolls the match
 * into view.
 *
 * Wave 2 reliability, item 3: `locateTarget` now returns `{ el, hidden }`,
 * not a bare element — `findByText` itself reports whether the match it
 * found was only reachable as a hidden fallback (see FIND_BY_TEXT_JS's doc
 * comment), and that has to survive through `locateTarget` for every caller
 * (hover/focus/click/scroll) to refuse acting on it instead of silently
 * proceeding. A hidden text match short-circuits before the reveal
 * call — scrolling to reveal something the page itself is hiding is not
 * "revealing" it.
 *
 * `behavior: "instant"` (second-pass review finding 4): the default
 * ("auto", which follows the page's own `scroll-behavior`) is still
 * animating on a page that sets `html { scroll-behavior: smooth }` at the
 * moment the very next line reads `getBoundingClientRect()` — so
 * HOVER_TARGET_JS's reported centre coordinates, and FOCUS_JS's focus call,
 * would land on where the element WAS about to be, not where it actually is
 * yet. An instant jump makes the scroll's own effect on layout observable
 * before either script reads anything back.
 *
 * The reveal itself is \`penRevealIfNeeded\` (REVEAL_IF_NEEDED_JS): a target
 * that is already fully visible and hit-testable is not scrolled at all.
 */
const LOCATE_TARGET_JS = `
  ${REVEAL_IF_NEEDED_JS}
  ${FIND_BY_TEXT_JS}
  ${FIND_BY_SNAPSHOT_JS}

  function findBySelector(sel) {
    try {
      return document.querySelector(sel);
    } catch (err) {
      return null;
    }
  }

  function locateTarget(args) {
    var el = null;
    var hidden = false;
    if (args.snapshotId !== undefined && args.snapshotId !== null && args.index !== undefined && args.index !== null) {
      el = findBySnapshot(args.snapshotId, args.index, args.fingerprint);
    } else if (typeof args.target === "string" && args.target.trim() !== "") {
      // Code review finding 5: visible text match → CSS selector → hidden
      // text match's own refusal — a hidden-only text match used to
      // short-circuit here without ever trying the selector fallback. Same
      // order as CLICK_JS/TYPE_JS now use.
      var found = findByText(args.target);
      if (found && !found.hidden) {
        el = found.el;
      } else {
        el = findBySelector(args.target);
        if (!el && found && found.hidden) hidden = true;
      }
    }
    if (hidden) return { el: null, hidden: true };
    if (el && !args.skipReveal) penRevealIfNeeded(el);
    return { el: el, hidden: false, relocated: penRelocated };
  }
`;

/**
 * The `data-pen-sig-target` stamp: which element the current action is about.
 * The stamp is the attribute AND a per-document reference
 * (`window.__penSigTarget`), so finding it is a property read, never a DOM
 * walk (Wave 1 speed: no querySelectorAll('*') per command). The reference
 * also reaches a stamp inside an open shadow root, which the attribute query
 * alone cannot. Each frame has its own window, hence its own reference.
 * Interpolated into SCOPED_SIGNATURE_JS and into the small scripts that only
 * read the stamp.
 */
const SIG_TARGET_HELPER_JS = `
  // Removes the stamp: from the stored element (wherever it lives, shadow
  // roots included) plus a shallow query for any light-DOM leftover.
  function penClearSigTargets() {
    var prev = window.__penSigTarget;
    if (prev && prev.removeAttribute) prev.removeAttribute("data-pen-sig-target");
    var stale = document.querySelectorAll("[data-pen-sig-target]");
    for (var st = 0; st < stale.length; st++) stale[st].removeAttribute("data-pen-sig-target");
    window.__penSigTarget = null;
  }

  function penStampSigTarget(el) {
    penClearSigTargets();
    el.setAttribute("data-pen-sig-target", "1");
    window.__penSigTarget = el;
  }

  // The stamped element: the stored reference while it is still in the
  // document and still stamped, else a shallow query.
  function penFindSigTarget() {
    var ref = window.__penSigTarget;
    if (ref && ref.isConnected && ref.hasAttribute("data-pen-sig-target")) return ref;
    return document.querySelector("[data-pen-sig-target]");
  }
`;

/**
 * "Typing follows the focus the click moved" helpers, shared by
 * CLICK_RESOLVE_JS (records the pre-click focus), SELECT_ALL_CONTENT_JS and
 * READ_TARGET_VALUE_JS. \`penDeepActive\` is \`document.activeElement\`
 * descended through open shadow roots. \`penIsEditable\` is the one editable
 * definition the type path uses everywhere: an input (range excluded — it is
 * typed through the native setter), a textarea, or a contenteditable.
 * \`penFollowableFocus(el)\` returns the deep active element when focus has
 * been MOVED by the click onto a different editable than the target —
 * not the target or inside it, and not whatever was already focused before
 * the click (\`window.__penPreFocus\`), which a click that did not move focus
 * leaves active — else null.
 */
const FOCUS_FOLLOW_HELPER_JS = `
  function penDeepActive() {
    var a = document.activeElement;
    var guard = 0;
    while (a && a.shadowRoot && a.shadowRoot.activeElement && guard < 20) {
      a = a.shadowRoot.activeElement;
      guard++;
    }
    return a;
  }

  function penIsEditable(n) {
    if (!n || n.nodeType !== 1) return false;
    var t = (n.tagName || "").toLowerCase();
    return (
      (t === "input" && (n.getAttribute("type") || "").toLowerCase() !== "range") ||
      t === "textarea" ||
      n.isContentEditable === true
    );
  }

  function penFollowableFocus(el) {
    var a = penDeepActive();
    if (!a || a === el || !penIsEditable(a) || (el.contains && el.contains(a))) return null;
    if (a === window.__penPreFocus) return null;
    return a;
  }
`;

/**
 * Shared `scopedSignatureOf` body, interpolated into CLICK_JS, TYPE_JS,
 * PERFORM_JS and SIGNATURE_JS — a cheap signature of a *single element's own
 * subtree*, not the whole document.
 *
 * Review finding 4 (jev-loop design doc "Addendum 2, 2026-09-19" §1, further
 * scoped by the follow-up review): a whole-document signature (node count,
 * full innerText hash, largest visible `<img>`) is noisy on exactly the
 * pages this design exists for — a rotating carousel, a lazy-loading image,
 * a live price, an injected ad all move it between two captures
 * milliseconds apart, so a click that did nothing gets `changed: true`
 * anyway, handing the agent the same false confirmation "Addendum 2" was
 * written to stop. `scopedSignatureOf` is called on the *specific* element a
 * click/type/select acted on (CLICK_JS/TYPE_JS/PERFORM_JS stamp it with
 * `data-pen-sig-target` and compute this signature inline, before mutating
 * anything, so the "before" half is captured at the true start of the
 * action rather than via a second round trip); the "after" half is computed
 * by SIGNATURE_JS re-finding the same stamped element. Its own subtree node
 * count / text hash / src / value length / aria-expanded / aria-selected /
 * checked are the properties that actually move when *that* element reacts
 * — not whatever else happens to be moving elsewhere on the page.
 */
const SCOPED_SIGNATURE_JS = `
  ${SIG_TARGET_HELPER_JS}

  function penHashString(str) {
    var h = 0;
    for (var hi = 0; hi < str.length; hi++) {
      h = (h * 31 + str.charCodeAt(hi)) | 0;
    }
    return h;
  }

  function scopedSignatureOf(el) {
    var nodeCount = el.querySelectorAll("*").length + 1;
    var text = (el.textContent || "").replace(/\\s+/g, " ").trim();
    var hash = 0;
    for (var i = 0; i < text.length; i++) {
      hash = (hash * 31 + text.charCodeAt(i)) | 0;
    }
    return {
      nodeCount: nodeCount,
      textHash: hash,
      src: el.getAttribute("src") || "",
      // A length and a small numeric hash, never the content — the raw value
      // never leaves the page, only numbers do, and this element can be a
      // form field (see the credentials rule elsewhere in this file for why
      // raw field content is treated as sensitive by default). The hash makes
      // a same-length change ("06" -> "08") visible. A password field keeps
      // the length only: its hash stays 0.
      valueLength: "value" in el ? String(el.value || "").length : 0,
      valueHash:
        "value" in el && (el.getAttribute("type") || "").toLowerCase() !== "password"
          ? penHashString(String(el.value || ""))
          : 0,
      ariaExpanded: el.getAttribute("aria-expanded") || "",
      ariaSelected: el.getAttribute("aria-selected") || "",
      // A slider thumb has no text/value of its own: aria-valuenow is the
      // only property that moves when a key press really changed it.
      ariaValueNow: el.getAttribute("aria-valuenow") || "",
      checked: "checked" in el ? !!el.checked : false,
    };
  }
`;

/**
 * Wave 2 reliability, item 4: shared scroll-container helpers, interpolated
 * into SCROLL_JS, PERFORM_JS (its SCROLL_UP/SCROLL_DOWN branch) and
 * SNAPSHOT_JS (to mark scrollable containers). `isScrollableContainer`
 * intentionally excludes `<body>`/`<html>` — those are "the window", not an
 * inner container — and requires a real overflow style (`auto`/`scroll`)
 * plus actual overflow (`scrollHeight > clientHeight`), not just a style
 * that *permits* scrolling. `pickLargestScrollableInCenter` is the "no
 * target given, window itself can't scroll" fallback (a common SPA shape: a
 * fixed-height shell with one big inner scroll pane) — largest by rendered
 * area among containers that are both scrollable and actually intersect the
 * viewport, deliberately excluding the cursor/marks overlays the same way
 * every other page script here does.
 */
const SCROLL_CONTAINER_HELPER_JS = `
  function isScrollableContainer(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    var style = getComputedStyle(el);
    var overflowY = style.overflowY;
    if (overflowY !== "auto" && overflowY !== "scroll") return false;
    return el.scrollHeight > el.clientHeight + 2;
  }

  function nearestScrollableAncestor(el) {
    var node = el ? el.parentElement : null;
    while (node && node !== document.body && node !== document.documentElement) {
      if (isScrollableContainer(node)) return node;
      node = node.parentElement;
    }
    return null;
  }

  function windowIsScrollable() {
    var docEl = document.documentElement;
    var bodyStyle = document.body ? getComputedStyle(document.body) : null;
    if (bodyStyle && (bodyStyle.overflow === "hidden" || bodyStyle.overflowY === "hidden")) return false;
    return docEl.scrollHeight > window.innerHeight + 2;
  }

  function isScrollVisible(el) {
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    var style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return true;
  }

  function pickLargestScrollableInCenter() {
    var all = document.querySelectorAll("*");
    var best = null;
    var bestArea = 0;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.closest && (el.closest("[data-pen-cursor]") || el.closest("[data-pen-marks]"))) continue;
      if (!isScrollableContainer(el)) continue;
      if (!isScrollVisible(el)) continue;
      var rect = el.getBoundingClientRect();
      if (rect.right < 0 || rect.left > window.innerWidth || rect.bottom < 0 || rect.top > window.innerHeight) continue;
      var area = rect.width * rect.height;
      if (area > bestArea) {
        bestArea = area;
        best = el;
      }
    }
    return best;
  }
`;

/**
 * Collects every `<img>` and every element with a CSS `background-image`,
 * resolves URLs against the document, dedupes by resolved URL, filters by
 * minimum rendered size, sorts by rendered area descending, and caps the
 * result at `limit`. Deliberately does not try to rewrite thumbnail URLs to
 * higher resolutions (site-specific, rots) — it returns what the page
 * actually shows.
 *
 * BROWSE-01 (jev-loop design doc, "Addendum 2, 2026-09-19"): a live
 * Pinterest run showed this returning only the page's rendered `/236x/`
 * thumbnails, which the agent then took to guessing at higher-resolution
 * URLs itself (a confident 404 waiting to happen on any other host). Fixed
 * generically, not per-host: an `<img>`'s `srcset` is parsed and the
 * largest *declared* candidate (by `w` width descriptor, or by `x` density
 * descriptor as a proxy when only density descriptors are present) is
 * preferred over `currentSrc`/`src`, which the page may only be rendering
 * at a smaller size. `naturalWidth`/`naturalHeight` are reported alongside
 * the existing rendered `width`/`height` (which still means rendered size —
 * the e2e suite pins that) so a consumer can tell a small asset from a
 * small *rendering* of a large one. Still no per-host URL rewriting — that
 * is the part that rots.
 *
 * Review finding 1 (HIGH): the original `srcset.split(",")` broke on the
 * comma-bearing URLs real CDNs routinely serve (Cloudinary/imgix transforms
 * like `https://cdn/x/w_800,h_600/a.jpg 800w`) — the URL itself split into
 * two pieces, the descriptor-less fragment ("…w_800") was skipped, and the
 * remainder ("h_600/a.jpg 800w") won on score and got returned as a
 * relative URL fragment, silently 404ing every image `browse_find_images`
 * returned on such a host — worse than the bug this fix originally set out
 * to solve. Splitting on `,\\s+` (comma *followed by whitespace*, which is
 * how the srcset grammar actually separates candidates — a raw comma
 * embedded in a URL is essentially never followed by whitespace) fixes the
 * real-world case; `pickLargestSrcsetCandidate` additionally verifies the
 * winning candidate resolves as a URL at all before returning it, falling
 * back to `currentSrc || src` rather than ever handing back something that
 * isn't a URL.
 *
 * Review finding 5: `naturalWidth`/`naturalHeight` used to always come from
 * the `<img>` element's *loaded* resource, even once this fix started
 * preferring a *different*, larger URL from `srcset` that the browser may
 * never have fetched — reporting a real thumbnail's tiny naturalWidth next
 * to a much larger returned URL defeats the documented "tell a small asset
 * from a small rendering" use of these fields. Whenever the returned URL
 * came from a `w`-descriptor `srcset` candidate at all, the descriptor's own
 * declared width is reported instead of `img.naturalWidth`/`naturalHeight` —
 * *even when that candidate happens to be the one the browser actually
 * fetched*: per the HTML spec, a `w`-descriptor selection makes the browser
 * report a *density-corrected* `naturalWidth`/`naturalHeight` (the resource's
 * real pixel size divided by an implied pixel density computed from the
 * descriptor and the "sizes"-resolved target width, which defaults to the
 * viewport width) rather than the resource's true pixel dimensions — so
 * trusting `img.naturalWidth` even in the "matches what's loaded" case
 * quietly reports a viewport-width-dependent number instead of the image's
 * real size. Height is estimated from the loaded image's own aspect ratio
 * (density correction scales both dimensions by the same factor, so the
 * *ratio* stays meaningful even though the absolute numbers don't) or the
 * rendered box's, if even that isn't known. With no `srcset` involved at
 * all, `img.naturalWidth`/`naturalHeight` are reported as-is (no density
 * correction applies without `srcset`). With no declared width to fall back
 * on (an `x`-density-only srcset), natural size is omitted entirely rather
 * than reporting a number that describes the wrong image.
 */
export const FIND_IMAGES_JS = `(() => {
  ${DEEP_QUERY_HELPER_JS}
  var args = ${ARGS_MARKER};
  var minWidth = args.minWidth;
  var minHeight = args.minHeight;
  var limit = args.limit;

  function resolve(url) {
    if (!url) return null;
    try {
      return new URL(url, document.baseURI).href;
    } catch (err) {
      return null;
    }
  }

  function extractBackgroundUrl(bg) {
    if (!bg || bg === "none") return null;
    var start = bg.indexOf("url(");
    if (start === -1) return null;
    var rest = bg.slice(start + 4);
    var end = rest.indexOf(")");
    if (end === -1) return null;
    var raw = rest.slice(0, end).trim();
    if (raw.length >= 2) {
      var first = raw[0];
      var last = raw[raw.length - 1];
      if ((first === '"' || first === "'") && first === last) raw = raw.slice(1, -1);
    }
    return raw;
  }

  // Picks the largest declared candidate out of an <img srcset> — by "w"
  // width descriptor when present, else by "x" density descriptor as a
  // relative-size proxy (a 1000x multiplier keeps it comparable against a
  // "w" descriptor without ever mattering in practice, since a page mixing
  // both descriptor kinds in one srcset is not something the spec allows).
  // Returns null (falls back to currentSrc||src) when there is no srcset,
  // nothing in it parses, or the winning candidate doesn't even resolve as
  // a URL (finding 1's defence-in-depth, on top of the split fix above).
  // Returns { url, declaredWidth } — declaredWidth is the "w" descriptor's
  // pixel value when the winner came from one, else null (finding 5).
  function pickLargestSrcsetCandidate(srcset) {
    if (!srcset) return null;
    // Finding 1: split on a comma *followed by whitespace* — that's how the
    // srcset grammar actually separates candidates, and it's what a raw
    // comma embedded in a URL (a CDN transform parameter, say) essentially
    // never looks like. A plain split(",") tore exactly such a URL in two.
    var entries = srcset.split(/,\\s+/);
    var best = null;
    var bestScore = -1;
    var bestDeclaredWidth = null;
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i].trim();
      if (!entry) continue;
      var parts = entry.split(/\\s+/);
      var url = parts[0];
      var descriptor = parts[1] || "";
      var score = -1;
      var declaredWidth = null;
      if (descriptor.slice(-1) === "w") {
        var w = parseInt(descriptor.slice(0, -1), 10);
        if (!isNaN(w)) {
          score = w;
          declaredWidth = w;
        }
      } else if (descriptor.slice(-1) === "x") {
        var x = parseFloat(descriptor.slice(0, -1));
        if (!isNaN(x)) score = x * 1000;
      }
      if (url && score > bestScore) {
        bestScore = score;
        best = url;
        bestDeclaredWidth = declaredWidth;
      }
    }
    if (!best) return null;
    // Finding 1: validate the winner actually resolves as a URL before
    // handing it back — a malformed/mis-split fragment should fall back to
    // currentSrc||src rather than being returned as-is.
    try {
      new URL(best, document.baseURI);
    } catch (err) {
      return null;
    }
    return { url: best, declaredWidth: bestDeclaredWidth };
  }

  var seen = Object.create(null);
  var found = [];

  function consider(rawUrl, alt, width, height, naturalWidth, naturalHeight) {
    var url = resolve(rawUrl);
    if (!url) return;
    // Only http(s) — an inline data:/blob: URL (background images and
    // <img src> both allow them) can be arbitrarily large, has no size cap,
    // and this repo has already been bitten twice by base64 image payloads
    // flooding the model's chat history (see CLAUDE.md's memory notes).
    // Pinterest and friends serve real images over http(s); a page that
    // only offers inline data URIs is not a useful reference source anyway.
    if (url.indexOf("http:") !== 0 && url.indexOf("https:") !== 0) return;
    if (width < minWidth || height < minHeight) return;
    if (seen[url]) return;
    seen[url] = true;
    var entry = {
      url: url,
      alt: (alt || "").trim().slice(0, 200),
      width: width,
      height: height,
    };
    // Finding 5: omit rather than report a natural size known to describe
    // the wrong image.
    if (naturalWidth !== undefined && naturalWidth !== null) entry.naturalWidth = naturalWidth;
    if (naturalHeight !== undefined && naturalHeight !== null) entry.naturalHeight = naturalHeight;
    found.push(entry);
  }

  // Wave 3 reliability, item 1: document.images never looks inside an open
  // shadow root — deepQueryAll does.
  var imgs = deepQueryAll(document, "img");
  for (var i = 0; i < imgs.length; i++) {
    var img = imgs[i];
    // Skip the cursor overlay (pageScripts.ts's CURSOR_JS) and the
    // screenshot annotation overlay (MARKS_JS) — neither is page content,
    // just pointer-events:none chrome this bridge draws itself.
    if (img.closest && (img.closest("[data-pen-cursor]") || img.closest("[data-pen-marks]"))) continue;
    var rect = img.getBoundingClientRect();
    var srcsetPick = pickLargestSrcsetCandidate(img.getAttribute("srcset"));
    var chosenUrl = (srcsetPick && srcsetPick.url) || img.currentSrc || img.src;
    var naturalWidth, naturalHeight;
    if (!srcsetPick || !srcsetPick.url) {
      // No srcset candidate was used at all — no "w"-descriptor density
      // correction applies, so img.naturalWidth/naturalHeight are the
      // resource's real pixel size and are trustworthy as-is.
      naturalWidth = img.naturalWidth || Math.round(rect.width);
      naturalHeight = img.naturalHeight || Math.round(rect.height);
    } else if (srcsetPick.declaredWidth) {
      // Finding 5: a "w"-descriptor srcset candidate was used — report its
      // own declared width rather than img.naturalWidth, which (per the
      // HTML spec) is density-corrected against the "sizes"-resolved target
      // width for a "w" descriptor and so does NOT reflect the resource's
      // real pixel size, even when this candidate is the one actually
      // loaded. Height isn't declared by a "w" descriptor, so it's
      // estimated from whatever aspect ratio is available — the loaded
      // image's own (density correction scales both dimensions equally, so
      // the ratio itself stays meaningful), or failing that the rendered
      // box's.
      var aspect =
        img.naturalWidth && img.naturalHeight
          ? img.naturalHeight / img.naturalWidth
          : rect.width
            ? rect.height / rect.width
            : 1;
      naturalWidth = srcsetPick.declaredWidth;
      naturalHeight = Math.round(srcsetPick.declaredWidth * aspect);
    } else {
      // Only an "x" density descriptor was available (no pixel width to
      // report) — natural size can't be known without fetching the
      // candidate ourselves, so it's omitted rather than guessed.
      naturalWidth = undefined;
      naturalHeight = undefined;
    }
    consider(chosenUrl, img.alt, Math.round(rect.width), Math.round(rect.height), naturalWidth, naturalHeight);
  }

  // Wave 3 reliability, item 1: pierces open shadow roots.
  var all = deepQueryAll(document, "*");
  for (var j = 0; j < all.length; j++) {
    var el = all[j];
    if (el.closest && (el.closest("[data-pen-cursor]") || el.closest("[data-pen-marks]"))) continue;
    var bg = getComputedStyle(el).backgroundImage;
    var bgUrl = extractBackgroundUrl(bg);
    if (!bgUrl) continue;
    var elRect = el.getBoundingClientRect();
    // A CSS background image has no "natural size" concept reachable
    // synchronously without decoding it ourselves — rendered size is the
    // best available proxy, same as before this addendum.
    consider(
      bgUrl,
      el.getAttribute("aria-label") || el.getAttribute("title") || "",
      Math.round(elRect.width),
      Math.round(elRect.height),
      Math.round(elRect.width),
      Math.round(elRect.height)
    );
  }

  found.sort(function (a, b) {
    return b.width * b.height - a.width * a.height;
  });
  var images = found.slice(0, limit);

  return { images: images, count: images.length, pageUrl: location.href };
})()`;

/**
 * Locates a target first as a CSS selector, then as visible text (see
 * FIND_BY_TEXT_JS above: clickable elements preferred over any element,
 * innermost match preferred over an enclosing wrapper, exact match
 * preferred over a substring match), scrolls it into view, and clicks it.
 *
 * Review finding 4: before mutating anything, the located element is
 * stamped `data-pen-sig-target` and its own scoped signature is captured
 * (see SCOPED_SIGNATURE_JS above) — returned as `__scopedBefore`, an
 * internal field controller.ts reads and strips before the result ever
 * reaches a caller.
 */
/**
 * Shared "is this control mid-flight?" predicate — a control that disables
 * itself while its own handler runs (a submit button during a slow request,
 * a filter that greys out while it refetches). Upstream jev-ultrafast's PR
 * #58 describes the failure it causes: the input lands, the handler starts,
 * and the next observation ~50ms later sees the acted control `:disabled`
 * (SNAPSHOT_JS then lists it with \`disabled: true\`, which reads as locked,
 * not busy) while the controls the handler will enable are
 * not actionable yet — the model is offered neither what it just used nor
 * what it is waiting for, and answers BLOCKED. WAIT cannot rescue it: one
 * WAIT is 400ms, so sitting out a 3s handler costs ~8 paid decision round
 * trips.
 *
 * `aria-busy` is checked on ancestors too (`closest`), because the common
 * React pattern marks the *form* or a wrapper busy rather than the button.
 * A native `disabled` is only checked on the element itself: a disabled
 * <fieldset> already disables its controls, which shows up as `el.disabled`.
 */
const TARGET_BUSY_HELPER_JS = `
  // A natively disabled form control (own attribute or a disabled fieldset
  // ancestor; :disabled matches both): it ignores clicks, keys and typing.
  // SNAPSHOT_JS LISTS such a control with \`disabled: true\` (a locked step
  // tells the agent an earlier choice is missing), so every acting script
  // must refuse it; controller.ts first gives a merely BUSY one (a handler
  // that disables it for a moment) a short chance to re-enable.
  function penNativelyDisabled(el) {
    var t = (el.tagName || "").toLowerCase();
    return (t === "input" || t === "select" || t === "textarea" || t === "button") && el.matches(":disabled");
  }

  // THE one refusal: null when el may be acted on, else the error text.
  // A disabled native range keeps its own older "a disabled slider." message
  // on TYPE_TEXT (the slider path reports it); a CLICK on it is refused here.
  function penDisabledError(el, operation) {
    if (!el || !el.matches || !penNativelyDisabled(el)) return null;
    var isRange = (el.tagName || "").toLowerCase() === "input" && (el.getAttribute("type") || "").toLowerCase() === "range";
    if (isRange && operation === "TYPE_TEXT") return null;
    return "the control is disabled";
  }

  function penTargetIsBusy(el) {
    if (!el) return false;
    if (el.disabled === true) return true;
    if (el.getAttribute("aria-disabled") === "true") return true;
    if (el.getAttribute("aria-busy") === "true") return true;
    return !!(el.closest && el.closest('[aria-busy="true"]'));
  }
`;

/**
 * Autocomplete probe for controller.ts's settleAutocomplete: is the stamped
 * (`data-pen-sig-target`) field an autocomplete-style one, and how many
 * suggestion options are visible right now? A field is autocomplete-style
 * when it (or an ancestor wrapper — the ARIA 1.0 combobox shape) has
 * role=combobox, `aria-autocomplete` list/both or `aria-haspopup`
 * listbox. A native `<input list>` is deliberately NOT one: its datalist has
 * no DOM options to wait for.
 *
 * Options are the `role=option` nodes under the listbox(es) the field names
 * via `aria-controls`/`aria-owns`, else any visible `role=option` in the
 * document (a popup portalled elsewhere). "Visible" = a non-empty rect, no
 * display:none / visibility:hidden, no aria-hidden ancestor. `hash` digests
 * the options' labels so the caller can tell a list that is still being
 * replaced from one that has settled. `docOptions`/`docHash` are the same
 * digest over EVERY visible `role=option` in the document: settleAutocomplete
 * compares it with the pre-typing baseline (`{ baseline: true }` — answers
 * just `{ docOptions, docHash }`, needs no stamp) so a focus-time "popular"
 * list that is still on screen is not mistaken for the settled suggestions.
 * A plain field answers `{ autocomplete: false }`.
 */
export const AUTOCOMPLETE_STATE_JS = `(() => {
  var args = ${ARGS_MARKER};
  ${SIG_TARGET_HELPER_JS}
  ${DEEP_QUERY_HELPER_JS}
  ${POPUP_OPTION_JS}

  function visible(node) {
    var r = node.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var cs = getComputedStyle(node);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    return !(node.closest && node.closest('[aria-hidden="true"]'));
  }

  // Count + label digest of the visible options among \`nodes\`.
  function digest(nodes) {
    var count = 0;
    var hash = 0;
    for (var oi = 0; oi < nodes.length; oi++) {
      if (!visible(nodes[oi])) continue;
      count++;
      var label = (nodes[oi].textContent || "").trim().slice(0, 80);
      for (var li = 0; li < label.length; li++) hash = (hash * 31 + label.charCodeAt(li)) | 0;
      hash = (hash * 31 + 7) | 0;
    }
    return { count: count, hash: hash };
  }

  // The option nodes of the listbox(es) \`field\` names via aria-controls/
  // aria-owns (on it or its combobox wrapper), or null when none resolves (an
  // existing but still EMPTY listbox is an own list with zero options; so is
  // a display:none one, the closed list). Two generic exceptions: a rendered
  // referenced listbox whose options are ALL too small to show (0x0 or an
  // sr-only 1px clip) is an a11y-only mirror, not the field's own list; and a field that owns an open popup
  // (penPopupFor) has that popup's items as its own options.
  function penOwnOptions(field) {
    var pop = penPopupFor(field);
    if (pop && pop.items.length) return pop.items.slice();
    var cb = field.closest ? field.closest('[role="combobox"]') : null;
    var hostEl = cb || field;
    var refs = ((hostEl.getAttribute("aria-controls") || "") + " " + (hostEl.getAttribute("aria-owns") || "") + " " +
      (field.getAttribute("aria-controls") || "") + " " + (field.getAttribute("aria-owns") || "")).split(/\\s+/);
    var found = [];
    var resolved = false;
    var seenRoots = [];
    for (var ri = 0; ri < refs.length; ri++) {
      var root = refs[ri] ? document.getElementById(refs[ri]) : null;
      if (!root || seenRoots.indexOf(root) >= 0) continue;
      seenRoots.push(root);
      var rootOpts = root.getAttribute("role") === "option" ? [root] : [];
      var inner = root.querySelectorAll('[role="option"]');
      for (var ii = 0; ii < inner.length; ii++) rootOpts.push(inner[ii]);
      if (root.getClientRects().length > 0 && rootOpts.length > 0) {
        var shown = false;
        for (var oi2 = 0; oi2 < rootOpts.length && !shown; oi2++) shown = !penTooSmallToShow(rootOpts[oi2]);
        if (!shown) continue;
      }
      resolved = true;
      for (var fi = 0; fi < rootOpts.length; fi++) found.push(rootOpts[fi]);
    }
    return resolved ? found : null;
  }

  // Every role=option node plus every open popup's items (computed only once
  // a field exists, and past the autocomplete gate for the full probe).
  function penAllOptions() {
    var allOptions = Array.prototype.slice.call(document.querySelectorAll('[role="option"]'));
    var popupItems = penPopupItems();
    for (var pk = 0; pk < popupItems.length; pk++) {
      if (allOptions.indexOf(popupItems[pk]) < 0) allOptions.push(popupItems[pk]);
    }
    return allOptions;
  }

  if (args.clearPreType) {
    penClearPreType();
    return { cleared: true };
  }
  var el = penFindSigTarget();
  // args.baseline: the pre-typing probe — no stamp needed (focus/typing may
  // still re-target), just what is visible document-wide right now.
  if (args.baseline) {
    if (!el) return { docOptions: 0, docHash: 0 };
    var baseDigest = digest(penAllOptions());
    var plainNow = penPlainField(el);
    // Layers already floating beside a plain field are not its suggestions.
    if (plainNow) penStampPreType(el);
    var baseOut = { docOptions: baseDigest.count, docHash: baseDigest.hash, plain: plainNow };
    var baseOwn = penOwnOptions(el);
    if (baseOwn) {
      var ownDigest = digest(baseOwn);
      baseOut.ownOptions = ownDigest.count;
      baseOut.ownHash = ownDigest.hash;
    }
    return baseOut;
  }

  if (!el) return { autocomplete: false };
  var combo = el.closest ? el.closest('[role="combobox"]') : null;
  var auto = (el.getAttribute("aria-autocomplete") || "").toLowerCase();
  var popup = (el.getAttribute("aria-haspopup") || "").toLowerCase();
  if (!combo && auto !== "list" && auto !== "both" && popup !== "listbox") {
    // A plain text field only counts once its (focus-owner) suggestion popup
    // is actually showing: without ARIA hints, "autocomplete-style" cannot be
    // known earlier, and waiting on every plain field would cost the cap.
    var focusPop = penPopupFor(el);
    if (!(focusPop && focusPop.focusOwner && focusPop.owner === el)) {
      var fo2 = penPlainField(el) ? penFocusOwner() : null;
      return { autocomplete: false, plainEligible: !!(fo2 && fo2.el === el) };
    }
  }

  var allOptions = penAllOptions();
  var docWide = digest(allOptions);
  var own = penOwnOptions(el);
  var candidates = own || allOptions;
  var scoped = candidates === allOptions ? docWide : digest(candidates);
  // ownList: the field names its own listbox, so the caller compares ONLY
  // that list with its baseline (an unrelated always-visible option list
  // elsewhere on the page must not hold the wait open).
  return { autocomplete: true, options: scoped.count, hash: scoped.hash, docOptions: docWide.count, docHash: docWide.hash, ownList: !!own };
})()`;

/**
 * Re-reads the busy state of the element the last action stamped
 * `data-pen-sig-target` (CLICK_JS/TYPE_JS/PERFORM_JS all stamp it). Polled
 * by controller.ts's settleWhileTargetBusy *only* when the acting script
 * reported `__targetSelfDisabled: true`, i.e. the action itself is what
 * made the control busy. `present: false` (the element is gone — the page
 * re-rendered or navigated) ends the wait just like `busy: false` does.
 */
export const TARGET_BUSY_JS = `(() => {
  ${TARGET_BUSY_HELPER_JS}
  ${SIG_TARGET_HELPER_JS}
  var el = penFindSigTarget();
  if (!el) return { present: false, busy: false };
  return { present: true, busy: penTargetIsBusy(el) };
})()`;

export const CLICK_JS = `(() => {
  var args = ${ARGS_MARKER};
  var target = args.target;

  function findBySelector(sel) {
    try {
      return document.querySelector(sel);
    } catch (err) {
      return null;
    }
  }

  ${FIND_BY_TEXT_JS}
  ${SCOPED_SIGNATURE_JS}
  ${TARGET_BUSY_HELPER_JS}
  ${REVEAL_IF_NEEDED_JS}

  // Text first, selector as fallback (not the reverse): a bare word like
  // "Search", "Map", "Details", "Select", "Menu", "Address" or "Video" is
  // also a syntactically valid CSS *type* selector — it matches the
  // <search>/<map>/<details>/<select>/<menu>/<address>/<video> element on
  // the page (if present) rather than the button labelled "Details" the
  // caller meant, and el.click() on that wrapper still returns { matched }
  // as if it worked. Trying the visible label first avoids needing a
  // selector-shaped heuristic, and a real CSS selector essentially never
  // equals some element's trimmed textContent, so the fallback still fires
  // for genuine selectors.
  //
  // Code review finding 5: a HIDDEN-only text match used to short-circuit
  // straight to the hidden-element error, never even trying the selector
  // fallback — a menu item's label matching some off-screen/display:none
  // element elsewhere on the page (say, a closed dropdown's own copy of the
  // same text) meant a perfectly good CSS selector for the real, visible
  // target never got a chance to run at all. Order is now: visible text
  // match, then selector, then (only if neither found anything) the hidden
  // text match's own refusal.
  var found = findByText(target);
  var el = found && !found.hidden ? found.el : null;
  if (!el) el = findBySelector(target);
  if (!el && found && found.hidden) {
    // Item 3: a text match that only exists hidden must never be clicked —
    // see FIND_BY_TEXT_JS's doc comment.
    return { error: "target is not visible (hidden element)" };
  }
  if (!el) return { error: "No element matched: " + target };
  var penRefusalC = penDisabledError(el, "CLICK");
  if (penRefusalC) return { error: penRefusalC };

  penStampSigTarget(el);
  var scopedBefore = scopedSignatureOf(el);
  var busyBefore = penTargetIsBusy(el);

  penRevealIfNeeded(el);
  el.click();
  return {
    url: location.href,
    title: document.title,
    matched: target,
    __scopedBefore: scopedBefore,
    __targetSelfDisabled: !busyBefore && penTargetIsBusy(el),
  };
})()`;

/**
 * Shared by TYPE_JS and PERFORM_JS: turns the text a model wrote for a range
 * input into a value the slider will really accept. A range input has no
 * text, so setting "150 EUR" verbatim leaves it at its default; the first
 * number is parsed ("150", "150 EUR", "1,500" and "1 500" -> 1500), clamped
 * to [min, max] and snapped to the min + k*step grid (a browser would snap
 * it anyway, but to the nearest valid value only after we have clamped).
 * Returns { value } or { error } (no parsable number).
 */
const RANGE_TYPE_HELPER_JS = `
  // The first number in free text: "150", "150 EUR", "1,500" and "1 500"
  // (thousands separators) -> 1500. null when there is none.
  function penFirstNumber(raw) {
    var m = String(raw === undefined || raw === null ? "" : raw).match(
      /-?\\d+(?:[ ,\\u00a0\\u202f]\\d{3}(?!\\d))*(?:\\.\\d+)?/
    );
    if (!m) return null;
    return parseFloat(m[0].replace(/[ ,\\u00a0\\u202f]/g, ""));
  }

  // Prepares a typed number for a non-native slider (role=slider). It cannot
  // be set by writing a value or attribute (widgets keep the value in their
  // own state), so this only parses/clamps the target, focuses the thumb and
  // reports where it stands; the controller then drives it with TRUSTED key
  // presses (see controller.ts driveSlider). null = el is not an ARIA slider.
  // No step snapping: ARIA exposes none, the loop stops within half a step.
  function penSliderPrepare(el, raw) {
    if (!penIsAriaSlider(el)) return null;
    var bounds = penAriaSliderBounds(el);
    var min = bounds.min;
    var max = bounds.max;
    var v = penFirstNumber(raw);
    if (v === null) {
      var boundsText = penBoundsText(bounds);
      return { error: "a slider" + (boundsText ? " (" + boundsText + ")" : "") + "; type a number." };
    }
    if (el.getAttribute("aria-disabled") === "true") return { error: "a disabled slider." };
    if (isNaN(parseFloat(el.getAttribute("aria-valuenow")))) {
      return { error: "a slider with no numeric aria-valuenow, so it cannot be set by typing." };
    }
    var requested = v;
    if (min !== null && v < min) v = min;
    if (max !== null && v > max) v = max;
    el.scrollIntoView({ block: "center" });
    el.focus();
    return { slider: { min: min, max: max, target: v, requested: requested } };
  }

  function penRangeValueFor(el, raw) {
    // A disabled range (its own attribute or a disabled fieldset) cannot be
    // moved by a user, so the native setter must not move it either.
    if (el.matches && el.matches(":disabled")) return { error: "a disabled slider." };
    var min = parseFloat(el.getAttribute("min"));
    var max = parseFloat(el.getAttribute("max"));
    if (isNaN(min)) min = 0;
    if (isNaN(max)) max = 100;
    var stepAttr = (el.getAttribute("step") || "").trim().toLowerCase();
    var step = stepAttr === "" ? 1 : parseFloat(stepAttr);
    var v = penFirstNumber(raw);
    if (v === null) return { error: "a slider (" + min + "\\u2013" + max + "); type a number." };
    var raw_ = v;
    if (v < min) v = min;
    if (v > max) v = max;
    var clamped = v;
    if (stepAttr !== "any" && !isNaN(step) && step > 0) {
      var snapped = min + Math.round((v - min) / step) * step;
      if (snapped > max) snapped = min + Math.floor((max - min) / step + 1e-9) * step;
      v = snapped;
    }
    return {
      value: String(parseFloat(v.toFixed(10))),
      raw: raw_,
      clamped: clamped,
      min: min,
      max: max,
      step: stepAttr === "any" ? NaN : step,
    };
  }

  // The verdict on a native range AFTER the value was set: it reads el.value
  // back (the browser sanitizes it and a controlled input may revert it) and
  // judges what the slider really holds. Tolerance is half a step but never
  // more than 5% of the range (a reversed range gives no cap). "" = success.
  function penRangeVerdict(el, info) {
    var actual = parseFloat(el.value);
    if (isNaN(actual)) return "";
    function fmt(n) {
      return String(parseFloat(n.toFixed(10)));
    }
    var range = info.max >= info.min ? info.max - info.min : null;
    var five = range === null ? Infinity : range * 0.05 + 1e-9;
    // A framework-controlled range often re-renders to its own coarser grid
    // than the declared step (a price slider with no step attribute that lands
    // on 625 for 624), so half the declared step is floored at 1% of the
    // range before the 5% cap.
    var tol = info.step > 0 ? Math.min(Math.max(info.step / 2, range === null ? 0 : range * 0.01), five) : five;
    // Clamping is honest too: asking for 1500 on a 20-400 slider is not "ok".
    if (info.raw !== info.clamped && Math.abs(info.raw - info.clamped) > (range === null ? 0 : five)) {
      return (
        "slider can't go " + (info.raw > info.clamped ? "above " + fmt(info.max) : "below " + fmt(info.min)) +
        " (target " + fmt(info.raw) + ") \u2014 it is now at " + fmt(actual)
      );
    }
    if (Math.abs(actual - info.clamped) > tol) {
      return (
        "slider can't be set to exactly " + fmt(info.clamped) + "; nearest reachable value is " + fmt(actual) +
        " \u2014 it is now at " + fmt(actual)
      );
    }
    return "";
  }
`;

/**
 * Locates a target the same way CLICK_JS does, then sets its value (input /
 * textarea) or text content (contenteditable), dispatching `input` and
 * `change` so framework-bound listeners see the change. Also stamps and
 * scoped-signatures the target element before mutating it — see CLICK_JS's
 * doc comment, finding 4.
 */
export const TYPE_JS = `(() => {
  var args = ${ARGS_MARKER};
  var target = args.target;
  var text = args.text;

  function findBySelector(sel) {
    try {
      return document.querySelector(sel);
    } catch (err) {
      return null;
    }
  }

  ${FIND_BY_TEXT_JS}
  ${SCOPED_SIGNATURE_JS}
  ${TARGET_BUSY_HELPER_JS}
  ${REVEAL_IF_NEEDED_JS}
  ${ARIA_SLIDER_HELPER_JS}
  ${RANGE_TYPE_HELPER_JS}

  // Text first, selector as fallback — see CLICK_JS's comment for why.
  // Code review finding 5: same visible-text → selector → hidden-text-
  // error order as CLICK_JS — see its comment.
  var found = findByText(target);
  var el = found && !found.hidden ? found.el : null;
  if (!el) el = findBySelector(target);
  if (!el && found && found.hidden) {
    // Item 3: see CLICK_JS's comment — a hidden-only text match is refused.
    return { error: "target is not visible (hidden element)" };
  }
  if (!el) return { error: "No element matched: " + target };
  var penRefusalT = penDisabledError(el, "TYPE_TEXT");
  if (penRefusalT) return { error: penRefusalT };

  penStampSigTarget(el);
  var scopedBefore = scopedSignatureOf(el);
  var busyBefore = penTargetIsBusy(el);

  var sliderPrep = penSliderPrepare(el, text);
  if (sliderPrep) {
    if (sliderPrep.error) return { error: "Element is " + sliderPrep.error + " Target: " + target };
    // Nothing is typed here: the controller drives the focused thumb with
    // trusted key presses and folds the outcome into this result.
    return {
      url: location.href,
      title: document.title,
      matched: target,
      __scopedBefore: scopedBefore,
      __targetSelfDisabled: false,
      __slider: sliderPrep.slider,
    };
  }
  penRevealIfNeeded(el);
  el.focus();
  var tag = (el.tagName || "").toLowerCase();
  var rangeInfo = null;
  if (tag === "input" && (el.getAttribute("type") || "").toLowerCase() === "range") {
    var rangeTyped = penRangeValueFor(el, text);
    if (rangeTyped.error) return { error: "Element is " + rangeTyped.error + " Target: " + target };
    text = rangeTyped.value;
    rangeInfo = rangeTyped;
  }
  if (tag === "input" || tag === "textarea") {
    var proto = tag === "input" ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, text);
  } else if (el.isContentEditable) {
    el.textContent = text;
  } else {
    return { error: "Element is not editable: " + target };
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  var rangeMiss = rangeInfo ? penRangeVerdict(el, rangeInfo) : "";
  var typedResult = {
    url: location.href,
    title: document.title,
    matched: target,
    __scopedBefore: scopedBefore,
    __targetSelfDisabled: !busyBefore && penTargetIsBusy(el),
  };
  // A coarse native range moved to a different number than asked: an error
  // that still carries the evidence (the value did move).
  if (rangeMiss) {
    typedResult.error = rangeMiss;
    typedResult.__sliderPartial = true;
  }
  return typedResult;
})()`;

/**
 * Wave 2 reliability, item 1/2: resolves a click/type target — by `target`
 * text/selector (LOCATE_TARGET_JS's text-first order, same as CLICK_JS/
 * TYPE_JS) or by `index`+`snapshotId` (the existing PERFORM_JS lookup) —
 * scrolls it into view, stamps it (same `data-pen-sig-target` +
 * `scopedSignatureOf` every acting script already captures), and hit-tests
 * its centre point via `document.elementFromPoint`, *without* performing any
 * action itself. `controller.ts`'s `dispatchClick`/`dispatchType` use the
 * returned centre point plus `hitOk` to decide whether a trusted CDP mouse
 * event can safely land on this element, or whether to fall back to the
 * existing `el.click()`/native-setter DOM path (CLICK_JS/TYPE_JS/PERFORM_JS)
 * instead — the same "resolve once, act only if resolution looks sound"
 * split `act`'s `hover`/`press` already use (HOVER_TARGET_JS/FOCUS_JS).
 *
 * `hitOk` is true when the point lands on the target element itself, one of
 * its descendants, one of its ancestors (a click can legitimately land on a
 * wrapper that bubbles to a listener further up — the same reason CLICK_JS's
 * own `el.click()` fallback works at all), or an ancestor `<label>` whose
 * `for` attribute (or containment) associates it with the target — a common
 * "click the label to focus the input" shape. `elementFromPointDeep` walks
 * into *open* shadow roots (`Element#shadowRoot`, only ever non-null for an
 * open root) so a target inside one isn't falsely reported as covered by its
 * own host; a closed shadow root is opaque to this check the same way it is
 * to `elementFromPoint` itself, and simply hit-tests against the host.
 * `hitOk` is also false outright when the element has zero rendered size or
 * its centre point falls outside the current viewport — a trusted mouse
 * event at an off-screen or invisible point is not meaningfully "a click on
 * this element" even if some other element happens to occupy that point.
 *
 * Also reports `editable` (code review finding 4) — a read-only tag/
 * `isContentEditable` check, the same one `SELECT_ALL_CONTENT_JS` uses —
 * so `controller.ts`'s `dispatchType` can check it BEFORE sending any
 * trusted CDP click: a trusted click landing on a non-editable target (a
 * text match that's actually a link/button) would otherwise click it
 * before the code ever discovered it wasn't a text field.
 */
export const CLICK_RESOLVE_JS = `(() => {
  var args = ${ARGS_MARKER};

  ${LOCATE_TARGET_JS}
  ${SCOPED_SIGNATURE_JS}
  ${TARGET_BUSY_HELPER_JS}
  ${FOCUS_FOLLOW_HELPER_JS}

  var located = locateTarget(args);
  if (located.hidden) return { error: "target is not visible (hidden element)" };
  var el = located.el;
  if (!el) return { error: "No element matched: " + (args.target || "index " + args.index) };

  var penRefusal = penDisabledError(el, args.operation);
  if (penRefusal) return { error: penRefusal };

  penStampSigTarget(el);

  var rect, x, y, hitOk;
  function hitTestTarget() {
    // A hidden-on-purpose radio/checkbox is aimed at its label (or its own
    // box): see penClickPoint.
    var cp = penClickPoint(el);
    rect = cp.box.getBoundingClientRect();
    x = cp.x;
    y = cp.y;
    hitOk = cp.hitOk;
    return null;
  }

  // No reveal-scroll here: any scroll must happen BEFORE the controller's
  // before-signature capture, so it lives in REVEAL_TARGET_JS, which the
  // controller runs ahead of it (locateTarget's own scrollIntoView below is
  // then already a no-op).
  hitTestTarget();

  var scopedBefore = scopedSignatureOf(el);
  var busyBefore = penTargetIsBusy(el);

  // What was focused BEFORE the trusted click: lets SELECT_ALL_CONTENT_JS /
  // READ_TARGET_VALUE_JS tell "the click moved focus to another field" (an
  // overlay input opened by the click) from "focus was already there". No
  // side effect beyond this page-global note.
  window.__penPreFocus = penDeepActive();

  // Code review finding 4: computed here, ahead of any click, so
  // \`controller.ts\`'s \`dispatchType\` can refuse a non-editable target
  // (a text match that's actually a link/button, say) BEFORE sending a
  // trusted CDP click to "focus" it — clicking first meant typing into a
  // link/button clicked it. Mirrors SELECT_ALL_CONTENT_JS's own tag check,
  // but read-only: no focus()/select() side effect here.
  var tagForEditable = (el.tagName || "").toLowerCase();
  // A range input is "editable" only through the native-setter path
  // (TYPE_JS/PERFORM_JS parse and snap the number): a trusted click on its
  // hidden 1x1 box plus Input.insertText would type into nothing, so it is
  // reported non-editable here to route dispatchType straight to that path.
  // A role=slider div is non-editable for the same reason, and that legacy
  // path is where it is prepared (penSliderPrepare) before the controller
  // drives it with trusted arrow keys.
  var editable =
    (tagForEditable === "input" && (el.getAttribute("type") || "").toLowerCase() !== "range") ||
    tagForEditable === "textarea" ||
    el.isContentEditable === true;

  var result = {
    found: true,
    x: x,
    y: y,
    hitOk: hitOk,
    editable: editable,
    __scopedBefore: scopedBefore,
    __busyBefore: busyBefore,
  };
  if (typeof args.target === "string") result.matched = args.target;
  if (located.relocated) result.relocated = true;
  return result;
})()`;

/**
 * Used by REVEAL_TARGET_JS (DISMISS_DIALOG_STATE_JS reads the stamp): is `el` a dialog-dismissing control inside an open dialog? The dialog is
 * the nearest ancestor (composed, so through shadow roots) with
 * role=dialog/alertdialog, aria-modal=true or an open <dialog>; the control
 * dismisses when its accessible name (aria-label, else text/value/title,
 * trimmed, case-insensitive) equals or starts with done/close/apply/ok/save/
 * confirm/cancel (a word boundary — "Done, 2 adults" yes, "Okinawa" no), is a
 * bare x-glyph, or its aria-label contains the WORD "close" ("Closest airports" and "Show
 * closed stores" do not). A day cell, a field or a
 * "Next month" button inside the same dialog is not. `penMarkDismissDialog`
 * stamps the dialog `data-pen-dismiss-dialog` (stale stamps cleared first)
 * and returns true; false leaves nothing stamped.
 */
const DISMISS_DIALOG_HELPER_JS = `
  ${TEXT_CLEAN_JS}
  function penDialogOf(node) {
    var cur = node;
    while (cur) {
      if (cur.nodeType === 1) {
        var role = (cur.getAttribute("role") || "").toLowerCase();
        var tag = (cur.tagName || "").toLowerCase();
        if (
          role === "dialog" ||
          role === "alertdialog" ||
          cur.getAttribute("aria-modal") === "true" ||
          (tag === "dialog" && cur.open === true)
        ) {
          return cur;
        }
      }
      cur = cur.parentNode || cur.host || null;
    }
    return null;
  }

  function penLooksDismissing(el) {
    var control = el.closest ? el.closest("button, [role='button'], a, input[type='button'], input[type='submit']") || el : el;
    var aria = (control.getAttribute("aria-label") || "").trim().toLowerCase();
    if (/(^|[^\\p{L}\\p{N}])close(?![\\p{L}\\p{N}])/u.test(aria)) return true;
    var name = (aria || control.value || penCleanText(control) || control.getAttribute("title") || "")
      .toString().replace(/\\s+/g, " ").trim().toLowerCase();
    if (!name) return false;
    if (name === "×" || name === "✕" || name === "✖" || name === "✗") return true;
    return /^(done|close|apply|ok|okay|save|confirm|cancel)(?![\\p{L}\\p{N}])/u.test(name);
  }

  // The stamp is the attribute AND a per-window reference
  // (window.__penDismissDialog), like window.__penSigTarget: the reference
  // reaches a dialog inside a shadow root, which document.querySelector
  // cannot.
  function penMarkDismissDialog(el) {
    var prev = window.__penDismissDialog;
    if (prev && prev.removeAttribute) prev.removeAttribute("data-pen-dismiss-dialog");
    window.__penDismissDialog = null;
    var stale = document.querySelectorAll("[data-pen-dismiss-dialog]");
    for (var si = 0; si < stale.length; si++) stale[si].removeAttribute("data-pen-dismiss-dialog");
    var dialog = penDialogOf(el);
    if (!dialog || !penLooksDismissing(el)) return false;
    dialog.setAttribute("data-pen-dismiss-dialog", "1");
    window.__penDismissDialog = dialog;
    return true;
  }
`;

/**
 * Runs BEFORE the controller's before-signature capture on every path that
 * goes through dispatchClick/dispatchType (target-based act click/type,
 * perform CLICK/TYPE_TEXT), so scrolling the target into view is never
 * counted as the action's own effect (a click that did nothing used to report
 * changed: true, changes: ["scroll"] — false progress that makes loops). The
 * same ordering rule runHover follows (review finding 8): reveal/locate
 * first, then the cursor overlay move, then the before-capture, then act.
 *
 * Resolves the target exactly like CLICK_RESOLVE_JS (LOCATE_TARGET_JS, whose
 * `locateTarget` scrolls the element to the viewport centre — that scroll is
 * the reveal; CLICK_RESOLVE_JS's own locate afterwards is then a no-op), and
 * reports whether the click point now passes the shared hit-test. Read-only
 * otherwise: no signatures, and the only stamp is `data-pen-dismiss-dialog`
 * on the enclosing dialog when the target is a dialog-dismissing control
 * (DISMISS_DIALOG_HELPER_JS; reported as `dismissDialog: true`). Never an error the controller acts
 * on — a miss is left for CLICK_RESOLVE_JS to report. `__penReveal` is the
 * marker the unit tests use to tell this call from the action scripts.
 * Top document only (frame-routed targets skip it).
 */
export const REVEAL_TARGET_JS = `(() => {
  var __penReveal = true;
  var args = ${ARGS_MARKER};

  ${LOCATE_TARGET_JS}
  ${DISMISS_DIALOG_HELPER_JS}
  ${TARGET_BUSY_HELPER_JS}

  // Resolve WITHOUT scrolling, so a refused (disabled) target causes no
  // scroll, no dismiss-dialog stamp and — since the controller stops here —
  // no cursor move and no signature capture.
  var located = locateTarget({ target: args.target, index: args.index, snapshotId: args.snapshotId, fingerprint: args.fingerprint, skipReveal: true });
  if (!located.el) return { found: false, hidden: located.hidden === true };
  var penRefusalR = penDisabledError(located.el, args.operation);
  if (penRefusalR) return { found: true, disabled: true, error: penRefusalR };
  penRevealIfNeeded(located.el);
  var hitOk = penClickPoint(located.el).hitOk;
  var revealResult = { found: true, hitOk: hitOk };
  if (located.relocated) revealResult.relocated = true;
  if (penMarkDismissDialog(located.el)) revealResult.dismissDialog = true;
  return revealResult;
})()`;


/**
 * Polled by controller.ts's settleDialogDismiss after a click
 * REVEAL_TARGET_JS flagged as dismissing a dialog: is the stamped dialog
 * gone? The dialog is found through `window.__penDismissDialog` (reaches a
 * shadow root), else the attribute. Closed = no longer in the document,
 * `open` false on a <dialog>, display:none on it or an ancestor,
 * visibility:hidden, or no descendant with a box left (a dialog shell whose
 * content a CSS transition just hid, even though the shell stays laid out).
 * A bare zero rect on the wrapper is not enough. `{ closed: true }` also when the stamp vanished. Read-only.
 */
export const DISMISS_DIALOG_STATE_JS = `(() => {
  var dialog = window.__penDismissDialog || document.querySelector("[data-pen-dismiss-dialog]");
  if (!dialog || !dialog.isConnected) return { closed: true };
  if ((dialog.tagName || "").toLowerCase() === "dialog" && dialog.open === false) return { closed: true };
  // display:none on the dialog or any ancestor (composed, so through shadow
  // hosts), or visibility:hidden (inherited, so the dialog's own value).
  for (var anc = dialog; anc; anc = anc.parentNode || anc.host || null) {
    if (anc.nodeType !== 1) continue;
    if (getComputedStyle(anc).display === "none") return { closed: true };
  }
  if (getComputedStyle(dialog).visibility === "hidden") return { closed: true };
  function boxVisible(node) {
    var r = node.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var cs = getComputedStyle(node);
    return cs.display !== "none" && cs.visibility !== "hidden";
  }
  // A zero rect alone is NOT closed: display:contents / height:0 role=dialog
  // wrappers exist, their content still has boxes. And a wrapper that keeps
  // its own box is NOT open by itself either: a CSS transition can hide all
  // the content while the shell stays laid out. So either way the answer
  // comes from the descendants: closed when none has a visible box.
  var inner = dialog.querySelectorAll("*");
  var limit = inner.length < 300 ? inner.length : 300;
  for (var i = 0; i < limit; i++) {
    if (boxVisible(inner[i])) return { closed: false };
  }
  // No visible descendant: closed, unless the dialog is an empty leaf whose
  // own box is all there is (then it is still open).
  return { closed: inner.length > 0 || !boxVisible(dialog) };
})()`;

/**
 * Wave 2 reliability, item 2: selects the *existing* content of the element
 * `CLICK_RESOLVE_JS` stamped `data-pen-sig-target`, so the CDP-typed
 * replacement text overwrites it instead of being inserted alongside it —
 * the native "select all, then type" a real keyboard-driven fill does. An
 * input/textarea uses `el.select()` (falling back to `setSelectionRange`,
 * which some custom-element-wrapped inputs implement without `select()`); a
 * `contenteditable` uses a DOM Range covering its full contents. Neither
 * reads or returns the field's own value — only whether it *is* an editable
 * field at all (`editable`), which `controller.ts`'s `dispatchType` uses to
 * decide between proceeding with the trusted-input path and returning the
 * same "Element is not editable" error TYPE_JS/PERFORM_JS already report.
 *
 * Args `{ followFocus }`: see the in-script comment — after a landed trusted
 * click, typing follows a focus the click moved to another editable.
 */
export const SELECT_ALL_CONTENT_JS = `(() => {
  var args = ${ARGS_MARKER};
  ${SCOPED_SIGNATURE_JS}
  ${FOCUS_FOLLOW_HELPER_JS}
  var el = penFindSigTarget();
  if (!el) return { error: "Target element not found for typing." };
  // followFocus (only sent after a TRUSTED click really landed): the click
  // may have opened an overlay and focused a DIFFERENT field in it (a
  // "Where from?" box that hands off to a search input). Calling el.focus()
  // then would pull focus back to the covered original and the text would be
  // typed into the wrong field, so typing follows the focus instead: the new
  // field is re-stamped as the target and el is left alone. \`retargeted\`
  // and that field's own before-signature (\`__scopedBefore\`, taken before
  // any text is inserted) go back to the controller.
  var retargeted = false;
  if (args.followFocus === true) {
    var moved = penFollowableFocus(el);
    if (moved) {
      penStampSigTarget(moved);
      el = moved;
      retargeted = true;
    }
  }
  if (!retargeted && typeof el.focus === "function") el.focus();
  var tag = (el.tagName || "").toLowerCase();
  var result = { editable: false };
  if (tag === "input" || tag === "textarea") {
    try {
      if (typeof el.select === "function") el.select();
      else if (typeof el.setSelectionRange === "function") el.setSelectionRange(0, String(el.value || "").length);
    } catch (e) {}
    result = { editable: true };
  } else if (el.isContentEditable) {
    try {
      var range = document.createRange();
      range.selectNodeContents(el);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {}
    result = { editable: true };
  }
  if (retargeted) {
    result.retargeted = true;
    result.__scopedBefore = scopedSignatureOf(el);
  }
  return result;
})()`;

/**
 * Wave 2 reliability, item 2: verifies the element `CLICK_RESOLVE_JS`
 * stamped `data-pen-sig-target` now holds exactly the text the trusted-input
 * path (CDP \`Input.insertText\`) was asked to type — \`controller.ts\`'s
 * \`dispatchType\` falls back to the existing native-setter path
 * (TYPE_JS/PERFORM_JS) whenever this reports anything other than an exact
 * match, e.g. a masked/formatted input that rewrote what was inserted. Never
 * returns the field's own content — only the boolean comparison result — so
 * a raw value never has to leave the page for this check, matching this
 * file's existing value/hasValue privacy rules (see SNAPSHOT_JS's addendum
 * D and SCOPED_SIGNATURE_JS's \`valueLength\`).
 */
export const READ_TARGET_VALUE_JS = `(() => {
  var args = ${ARGS_MARKER};
  var expected = args.text;
  ${SCOPED_SIGNATURE_JS}
  ${FOCUS_FOLLOW_HELPER_JS}
  function penReadText(n) {
    var t = (n.tagName || "").toLowerCase();
    if (t === "input" || t === "textarea") return n.value;
    if (n.isContentEditable) return n.textContent;
    return null;
  }
  var el = penFindSigTarget();
  if (!el) return { matches: false, present: false };
  var actual = penReadText(el);
  if (actual === expected) return { matches: true, present: true };
  // The click's focus move can land AFTER SELECT_ALL_CONTENT_JS ran (a slow
  // overlay): the text then went into the newly focused field, not the
  // stamped one. If that field holds exactly the expected text, adopt it as
  // the target (same boolean-only privacy rule). Its before-signature is
  // synthesized as "empty": the insert replaced the selection, and an empty
  // before vs. a non-empty after is what makes the type count as a change.
  var moved = penFollowableFocus(el);
  if (moved && penReadText(moved) === expected) {
    penStampSigTarget(moved);
    var before = scopedSignatureOf(moved);
    if (expected.length > 0) {
      before.valueLength = 0;
      before.valueHash = 0;
    }
    return { matches: true, present: true, retargeted: true, __scopedBefore: before };
  }
  return { matches: false, present: true };
})()`;

/**
 * Reads back a non-native slider that TYPE_JS/PERFORM_JS stamped
 * `data-pen-sig-target`, between the controller's trusted key presses: its
 * current aria-valuenow and whether keyboard focus is still on it (keys go
 * to the focused element, so a press sent after focus moved would land on
 * something else). It adopts ONLY the stamped element (and it must still be
 * an ARIA slider): a framework that re-mounts the thumb mid-drive replaces
 * the stamped node, and the read then reports `present: false`, which ends
 * the drive with a "disappeared" error that still carries evidence. There is
 * no relocation. Document focus (`document.hasFocus()`) is deliberately not
 * required: Chromium reports false whenever the window is not OS-focused
 * although CDP keys still reach the focused element; a press that lands
 * elsewhere shows up as "value did not change" and stops the drive.
 */
export const SLIDER_READ_JS = `(() => {
  ${SIG_TARGET_HELPER_JS}
  ${ARIA_SLIDER_HELPER_JS}
  function deepActive() {
    var a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }
  var el = penFindSigTarget();
  if (!el || !penIsAriaSlider(el)) return { present: false };
  function hasKeyFocus() {
    var a = deepActive();
    return !!a && (a === el || el.contains(a));
  }
  var focused = hasKeyFocus();
  if (!focused) {
    try {
      el.focus();
    } catch (e) {}
    focused = hasKeyFocus();
  }
  var now = parseFloat(el.getAttribute("aria-valuenow"));
  return { present: true, now: isNaN(now) ? null : now, focused: focused };
})()`;

/**
 * Scroll safety for the slider key presses: an unhandled Home/End/PageUp/
 * PageDown/arrow falls through to the browser and scrolls the page.
 * - `guard` / `unguard`: install/remove a last-in-bubble window keydown
 *   listener that cancels the default action of such a key the widget left
 *   un-prevented, so the page never starts scrolling.
 * - `save` (once, at the start of the drive) / `restore` (after each batch):
 *   records the window and the slider's scrollable ancestors and puts them
 *   back, instantly, only if they moved. That covers a widget that stops
 *   propagation without preventing the default. State lives on window.
 */
export const SLIDER_SCROLL_JS = `(() => {
  var args = ${ARGS_MARKER};
  ${SIG_TARGET_HELPER_JS}
  if (args.op === "guard") {
    if (!window.__penSliderKeyGuard) {
      window.__penSliderKeyGuard = function (e) {
        if (!e.defaultPrevented && /^(Home|End|PageUp|PageDown|Arrow(Up|Down|Left|Right))$/.test(e.key)) e.preventDefault();
      };
      window.addEventListener("keydown", window.__penSliderKeyGuard);
    }
    return { guarded: true };
  }
  if (args.op === "unguard") {
    if (window.__penSliderKeyGuard) window.removeEventListener("keydown", window.__penSliderKeyGuard);
    window.__penSliderKeyGuard = null;
    window.__penSliderScroll = null;
    return { guarded: false };
  }
  if (args.op === "save") {
    var saved = { x: window.scrollX, y: window.scrollY, anc: [] };
    var node = penFindSigTarget();
    for (var depth = 0; node && depth < 40; depth++) {
      var parent = node.parentNode;
      if (parent && parent.nodeType === 11 && parent.host) parent = parent.host;
      node = parent && parent.nodeType === 1 ? parent : null;
      if (node && (node.scrollTop || node.scrollLeft || node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth)) {
        saved.anc.push({ el: node, top: node.scrollTop, left: node.scrollLeft });
      }
    }
    window.__penSliderScroll = saved;
    return { saved: true };
  }
  var s = window.__penSliderScroll;
  if (!s) return { restored: false };
  var restored = false;
  if (window.scrollX !== s.x || window.scrollY !== s.y) {
    window.scrollTo({ left: s.x, top: s.y, behavior: "instant" });
    restored = true;
  }
  for (var i = 0; i < s.anc.length; i++) {
    var a = s.anc[i];
    if (a.el.scrollTop !== a.top || a.el.scrollLeft !== a.left) {
      a.el.scrollTo({ left: a.left, top: a.top, behavior: "instant" });
      restored = true;
    }
  }
  return { restored: restored };
})()`;

/**
 * Scrolls vertically by `amount` viewport heights (default 1) — the window,
 * or, per Wave 2 reliability item 4, an inner scrollable container instead:
 *
 * - `target` (visible text/selector) or `index`+`snapshotId` given: resolves
 *   that element (LOCATE_TARGET_JS) and scrolls it directly if it's itself
 *   scrollable, else its nearest scrollable ancestor — that covers the
 *   common case of a `target`/index that names a row or button *inside* a
 *   scroll pane, not the pane itself. `{ error }` if nothing scrollable is
 *   found for it (a hidden-only text match is also `{ error }` — see
 *   LOCATE_TARGET_JS's doc comment).
 * - No target/index: scrolls the window as before, unless the window itself
 *   can't scroll (`!windowIsScrollable()` — a fixed-height app shell), in
 *   which case the largest visible scrollable container near the viewport
 *   centre is auto-picked (`pickLargestScrollableInCenter`, same helper
 *   PERFORM_JS's SCROLL_UP/SCROLL_DOWN and SNAPSHOT_JS's container-picking
 *   share) and scrolled instead.
 */
export const SCROLL_JS = `(() => {
  var args = ${ARGS_MARKER};
  var amount = args.amount;
  var amountPx = window.innerHeight * amount;

  ${LOCATE_TARGET_JS}
  ${SCROLL_CONTAINER_HELPER_JS}

  var hasTarget =
    (typeof args.target === "string" && args.target.trim() !== "") ||
    (args.index !== undefined && args.index !== null && args.snapshotId);

  var el = null;
  if (hasTarget) {
    var located = locateTarget(args);
    if (located.hidden) return { error: "target is not visible (hidden element)" };
    if (!located.el) return { error: "No element matched: " + (args.target || "index " + args.index) };
    el = isScrollableContainer(located.el) ? located.el : nearestScrollableAncestor(located.el);
    if (!el) return { error: "No scrollable container found for that target." };
  } else if (!windowIsScrollable()) {
    el = pickLargestScrollableInCenter();
  }

  if (el) el.scrollBy(0, amountPx);
  else window.scrollBy(0, amountPx);

  var scrollResult = { url: location.href, title: document.title };
  if (penRelocated) scrollResult.relocated = true;
  return scrollResult;
})()`;

/**
 * Walks the document once and returns an indexed table of visible,
 * interactive elements — a port of the concepts in jev-ultrafast's
 * `snapshot.js` (https://github.com/browser-use/jev-ultrafast, MIT license):
 * a cheap structured element table in place of a screenshot, so a fast
 * decision model (`POST /api/browse/step`, see the jev-loop design doc) can
 * pick an operation and target in one round trip instead of reasoning over
 * pixels.
 *
 * Each surviving element is stamped with a `data-pen-snap="<snapshotId>:
 * <index>"` attribute (`snapshotId` supplied by the controller via
 * ARGS_MARKER, see controller.ts's `snapshot()`). PERFORM_JS below looks
 * elements up by that exact attribute rather than by recomputing the
 * candidate list — if the page re-renders (React replaces the node) or
 * navigates between snapshot and perform, the marked node is simply gone
 * and the lookup fails closed, instead of `perform` silently landing on
 * whatever now happens to occupy the same array position.
 */
export const SNAPSHOT_JS = `(() => {
  var args = ${ARGS_MARKER};
  var snapshotId = args.snapshotId;
  var maxElements = args.maxElements;
  // Per-document token: FIND_BY_SNAPSHOT_JS relocates a re-mounted node only
  // while this still matches the requested snapshot and the current URL.
  window.__penSnapDoc = { id: String(snapshotId), href: location.href };

  ${DEEP_QUERY_HELPER_JS}
  ${INTERACTIVE_SELECTOR_JS}
  ${SCROLL_CONTAINER_HELPER_JS}
  ${HIT_TEST_HELPER_JS}
  ${TOGGLE_PROXY_JS}
  ${TARGET_BUSY_HELPER_JS}

  function isVisible(el, ignoreMargin) {
    // The cursor overlay (pageScripts.ts's CURSOR_JS) and the screenshot
    // annotation overlay (MARKS_JS) are both pointer-events:none and never a
    // real interactive control — skip anything inside either so neither can
    // ever show up as a snapshot element to act on.
    if (el.closest && (el.closest("[data-pen-cursor]") || el.closest("[data-pen-marks]"))) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    var style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (parseFloat(style.opacity) === 0) return false;
    // Viewport-ish region with a generous margin — infinite-scroll grids
    // just outside the fold still matter to a browsing task.
    // ignoreMargin: a far-away radio option pulled in next to a disabled
    // button (see the "unanswered choice" block after the cap below).
    var margin = Math.max(window.innerHeight, 600);
    if (!ignoreMargin && (rect.bottom < -margin || rect.top > window.innerHeight + margin)) return false;
    return true;
  }

  function tagOf(el) {
    return (el.tagName || "").toLowerCase();
  }

  ${LABEL_HELPER_JS}

  // Native range inputs are routinely hidden on purpose: a 1x1, opacity:0
  // <input type=range> layered over custom-drawn thumbs (a dual slider is
  // two of them). isVisible drops them, so the control never reached the
  // element table even though setting its value works. This returns the
  // element whose box stands in for the input — the input itself when it
  // has a real (>= 8x8) box, else its nearest ancestor with one — or null
  // when the input is genuinely hidden (display:none / visibility:hidden on
  // it or on anything between it and the proxy, opacity:0 on an ancestor, or
  // outside the viewport margin). Only ever consulted for input[type=range].
  //
  // The proxy must stay slider-sized: a hit anywhere inside it counts as
  // reaching the input (penProbe), so a wrapper whose absolutely positioned
  // children give it no height would otherwise climb to #root/body, and a
  // modal rendered inside that container would "reach" the slider behind
  // it. Hence the short walk and the size cap; past them the input is
  // treated as hidden (fail-closed).
  var PEN_RANGE_PROXY_MAX_DEPTH = 4;
  var PEN_RANGE_PROXY_MAX_HEIGHT = 120;
  function penRangeProxy(el) {
    if (!penIsRange(el)) return null;
    if (el.closest && (el.closest("[data-pen-cursor]") || el.closest("[data-pen-marks]"))) return null;
    var margin = Math.max(window.innerHeight, 600);
    var node = el;
    for (var depth = 0; node && node.nodeType === 1 && depth < PEN_RANGE_PROXY_MAX_DEPTH; depth++) {
      var st = getComputedStyle(node);
      if (st.display === "none" || st.visibility === "hidden") return null;
      if (node !== el && parseFloat(st.opacity) === 0) return null;
      var r = node.getBoundingClientRect();
      if (r.width >= 8 && r.height >= 8) {
        if (r.height > PEN_RANGE_PROXY_MAX_HEIGHT || r.width > window.innerWidth * 0.6) return null;
        if (r.bottom < -margin || r.top > window.innerHeight + margin) return null;
        return node;
      }
      node = penComposedParent(node);
    }
    return null;
  }

  function opsFor(el, tag) {
    // ARIA slider: typed as a number, driven by trusted arrow keys.
    if (penIsAriaSlider(el)) return ["TYPE_TEXT"];
    if (tag === "select") return ["SELECT"];
    if (tag === "textarea") return ["TYPE_TEXT"];
    if (tag === "input") {
      var type = (el.getAttribute("type") || "text").toLowerCase();
      if (
        type === "checkbox" ||
        type === "radio" ||
        type === "submit" ||
        type === "button" ||
        type === "reset" ||
        type === "file" ||
        type === "image"
      ) {
        return ["CLICK"];
      }
      // A text field is also clicked: many open a date picker or a
      // suggestion list on click and carry no attribute saying so (Google
      // Flights' "Departure"). Offered only TYPE_TEXT, a "click the date
      // field" decision had no such target and landed on a neighbour.
      if (type === "range" || type === "password") return ["TYPE_TEXT"];
      return ["TYPE_TEXT", "CLICK"];
    }
    if (el.isContentEditable) return ["TYPE_TEXT"];
    return ["CLICK"];
  }

  var PEN_CELL_ROLES = { option: 1, gridcell: 1, menuitemradio: 1, menuitemcheckbox: 1, treeitem: 1 };
  function penInsideSelectableCell(el) {
    var node = el.parentElement;
    for (var up = 0; node && up < 4; up++) {
      if (PEN_CELL_ROLES[(node.getAttribute("role") || "").toLowerCase()]) return true;
      node = node.parentElement;
    }
    return false;
  }

  // How far a box is scrolled out of its nearest scrolling ancestor (0 when
  // it shows inside it). Scroll-ness is cached per ancestor: a year-long
  // date picker is hundreds of candidates under the same few ancestors.
  function penClippedByAncestor(el, rect) {
    var node = el.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      var st = getComputedStyle(node);
      if (/^(hidden|clip)$/.test(st.overflowX) || /^(hidden|clip)$/.test(st.overflowY)) {
        var cr = node.getBoundingClientRect();
        if (cr.height <= 0 || cr.width <= 0) return true;
        if (rect.bottom <= cr.top || rect.top >= cr.bottom || rect.right <= cr.left || rect.left >= cr.right) return true;
      }
      node = node.parentElement;
    }
    return false;
  }
  var penScrollableCache = new Map();
  function penCachedScrollable(node) {
    if (!penScrollableCache.has(node)) penScrollableCache.set(node, isScrollableContainer(node));
    return penScrollableCache.get(node);
  }
  function penClippedDistance(el, rect) {
    var node = el.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      if (penCachedScrollable(node)) {
        var cr = node.getBoundingClientRect();
        if (rect.bottom <= cr.top) return cr.top - rect.bottom + 1;
        if (rect.top >= cr.bottom) return rect.top - cr.bottom + 1;
        return 0;
      }
      node = node.parentElement;
    }
    return 0;
  }

  // Wave 3 reliability, item 1: pierces open shadow roots.
  var candidates = penCandidates();
  var found = [];
  var penProxyLabels = new Set();
  // Builds the element-table entry for one candidate, or null when it is not
  // listable. \`forced\` (far-away radio options chosen by the "unanswered
  // choice" block below) lifts only the viewport-distance margin; every other
  // rule, the label logic and the toggle-proxy handling stay the same.
  function penBuildEntry(el, forced) {
    // A disabled ARIA slider ignores keys, so offering it only invites a
    // TYPE_TEXT that cannot work.
    if (penIsAriaSlider(el) && el.getAttribute("aria-disabled") === "true") return null;
    // Natively disabled controls stay listed (reported as \`disabled: true\`
    // below): a disabled step tells the agent an earlier choice is missing.
    // A disabled ARIA slider ignores keys, so it is still skipped.
    var rawRole = penRoleOf(el);
    var ariaRole = rawRole.toLowerCase();
    if (PEN_SKIP_WHEN_ARIA_DISABLED[ariaRole] && el.getAttribute("aria-disabled") === "true") return null;
    // The a11y-only mirror of a custom select (sr-only 1px listbox): its
    // option is not something a user can see or click.
    if (ariaRole === "option" && penIsMirrorOption(el)) return null;
    // The page itself says this control is not there (a past calendar day,
    // an inert copy of a menu).
    if (el.getAttribute("aria-hidden") === "true") return null;
    // The clickable child of a listed cell/option (a day cell wrapping a
    // role=button) would list the same day twice; the cell carries the
    // selection state and a click on it lands on the child anyway.
    if (penInsideSelectableCell(el)) return null;
    var box = el;
    var toggleProxy = penToggleProxy(el);
    if (toggleProxy) {
      // Transparent / clip-hidden native radio or checkbox over a visible
      // <label>: the label stands in for the box (same node the click and
      // mark paths use), and must itself be near the viewport.
      if (!isVisible(toggleProxy, forced)) return null;
      box = toggleProxy;
      penProxyLabels.add(toggleProxy);
    } else if (!isVisible(el, forced)) {
      box = penRangeProxy(el);
      if (!box) return null;
    }
    var tag = tagOf(el);
    var isPassword = tag === "input" && (el.getAttribute("type") || "").toLowerCase() === "password";
    var ops = opsFor(el, tag);
    var rect = box.getBoundingClientRect();
    // 0 for anything the user can see right now, else how far it is from
    // the viewport edge. The old "distance from the viewport CENTRE" let a
    // dense page (Hacker News: ~6 links per row) spend the whole cap on
    // below-the-fold rows around the middle and drop the top rows — the
    // first thing a user reads.
    var distance =
      rect.bottom > 0 && rect.top < window.innerHeight
        ? 0
        : rect.top >= window.innerHeight
          ? rect.top - window.innerHeight
          : -rect.bottom;
    // Inside the window but scrolled out of its own panel (a date picker
    // renders a whole year in a scrolling list): not visible either. Without
    // this the months above and below the shown one ate the cap.
    distance = Math.max(distance, penClippedDistance(box, rect));
    if (forced) {
      // Only the viewport margin is lifted: an option hidden inside a clipping
      // ancestor (closed accordion, max-height:0) is still not there.
      if (penClippedByAncestor(box, rect)) return null;
      distance = 0;
    }
    var entry = {
      el: el,
      box: box,
      tag: tag,
      role: rawRole || undefined,
      label: labelOf(el),
      ops: ops,
      isPassword: isPassword,
      distance: distance,
      // A day or a list option is one of many near-identical siblings: at the
      // same visibility it yields to one-off controls, or an open calendar's
      // days crowd its own confirm button out of the cap.
      cell: !!PEN_CELL_ROLES[ariaRole],
      top: rect.top,
      left: rect.left,
    };
    // Open or closed: without it "click the dropdown" and "pick from the
    // open list" look the same, and the agent toggled a list open and shut.
    var expandedAttr = el.getAttribute("aria-expanded");
    if (expandedAttr === "true" || expandedAttr === "false") entry.expanded = expandedAttr === "true";
    else if (tag === "input" || tag === "textarea") {
      var fieldPopup = penPopupFor(el);
      if (fieldPopup && fieldPopup.focusOwner && fieldPopup.owner === el) entry.expanded = true;
    }
    if (penNativelyDisabled(el)) entry.disabled = true;
    // A custom (non-input) combobox shows its current choice as its text —
    // report it as the value, or "One way" reads as an unset control that
    // still needs setting.
    if (ariaRole === "combobox" && tag !== "input" && tag !== "select" && tag !== "textarea") {
      var shown = penCleanText(el).trim().replace(/\\s+/g, " ");
      if (shown) entry.value = shown.slice(0, 100);
    }
    if (tag !== "input") {
      var ariaState = PEN_ARIA_CHECKED_ROLES[ariaRole]
        ? el.getAttribute("aria-checked")
        : PEN_ARIA_SELECTED_ROLES[ariaRole]
          ? el.getAttribute("aria-selected")
          : null;
      if (ariaState === "true" || ariaState === "false") entry.checked = ariaState === "true";
    }
    // Checked state of a checkbox/radio — without it a filter that is
    // already on looks exactly like one that is off, and the only way to
    // tell was a screenshot.
    if (tag === "input") {
      var checkType = (el.getAttribute("type") || "").toLowerCase();
      if (checkType === "checkbox" || checkType === "radio") entry.checked = !!el.checked;
    }
    if (penIsAriaSlider(el)) {
      // Where the slider sits now, as a bare number only: aria-valuetext is
      // free-form page text, and never leaves the page here.
      var sliderNow = (el.getAttribute("aria-valuenow") || "").trim();
      if (/^-?\\d+(?:\\.\\d+)?$/.test(sliderNow)) entry.value = sliderNow;
    } else if (tag === "select") {
      // Addendum D: options capped at 100 entries, each truncated, in the
      // page script itself — the payload must be valid by construction, not
      // rely on the backend to reject an oversized country dropdown.
      var options = [];
      for (var o = 0; o < el.options.length && options.length < 100; o++) {
        options.push(String(el.options[o].text || "").slice(0, 120));
      }
      entry.options = options;
      // The chosen option's text, not just "something is selected": a
      // "Select…" placeholder (empty option value) is the unset state, and
      // without the real choice Jev can't tell Country is already Germany and
      // re-selects it forever. Option texts already leave the page in
      // \`options\`, so reporting which one is selected discloses nothing new.
      var selectedOpt = el.options[el.selectedIndex];
      var chosenText = selectedOpt && selectedOpt.value !== "" ? String(selectedOpt.text || "").trim() : "";
      if (chosenText) entry.value = chosenText.slice(0, 100);
      entry.hasValue = !!chosenText;
    } else if (tag === "input" || tag === "textarea") {
      // Addendum D: only a non-password input[type=text], input[type=search]
      // or textarea reports its live "value" — and only when "autocomplete"
      // isn't one of the sensitive tokens (cc-*, one-time-code,
      // current-password, new-password). The old rule guarded only
      // type=password, so an autofilled card number in a type=text field,
      // an email, or a phone number left the page in the element table.
      // Every other input/textarea instead reports "hasValue" — whether the
      // model needs to know a field is already filled, never its content.
      var inputType = tag === "textarea" ? "textarea" : (el.getAttribute("type") || "text").toLowerCase();
      var autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase().trim();
      var sensitiveAutocomplete =
        autocomplete.indexOf("cc-") === 0 ||
        autocomplete === "one-time-code" ||
        autocomplete === "current-password" ||
        autocomplete === "new-password";
      // A range value is a bare number the model needs to see (where the
      // slider currently sits), never user-entered text.
      var valueEligible =
        !isPassword &&
        (inputType === "text" || inputType === "search" || inputType === "textarea" || inputType === "range") &&
        !sensitiveAutocomplete;
      var rawValue = el.value || "";
      if (valueEligible) {
        entry.value = String(rawValue).slice(0, 100);
      } else if (inputType !== "checkbox" && inputType !== "radio") {
        // A checkbox/radio's value is its submit token ("on" by default),
        // never user input — "hasValue" made every unchecked box read as
        // filled. Its state is \`checked\`, set above.
        entry.hasValue = rawValue.length > 0;
      }
    }
    return entry;
  }
  for (var i = 0; i < candidates.length; i++) {
    var built = penBuildEntry(candidates[i], false);
    if (built) found.push(built);
  }
  // A label that is itself a candidate (onclick, role) would list the same
  // tile twice — but only drop it when its toggle really got an entry above
  // (an aria-hidden / cell-nested input gets none, and its label must stay).
  if (penProxyLabels.size) {
    found = found.filter(function (f) {
      return !(f.tag === "label" && penProxyLabels.has(f.el));
    });
  }

  // Reachability (booking.com finding). The table used to list every control
  // in the DOM, including ones a user cannot touch. Live on booking.com, a
  // Genius sign-in modal (role=dialog aria-modal=true inside a full-viewport
  // [data-bui-trap-root] backdrop) was open; the table reported the "Select
  // dates" button and "Search" BEHIND it, mixed with the modal's own
  // "Dismiss" button. Jev clicked the date field, CLICK_RESOLVE_JS's hit-test
  // failed (the backdrop covers it), the controller fell back to a DOM
  // el.click() straight through the modal, the focus trap swallowed it, and
  // the calendar never opened — Jev then repeated the click (and, on the
  // results page, "Search" eight times) without ever seeing calendar days.
  // Two rules, applied to the candidates before sort/cap so the cap is spent
  // on reachable controls only:
  //
  // 1. Modal scope. The topmost visible modal layer ([aria-modal=true], or a
  //    <dialog> that is open :modal) restricts the table to controls inside
  //    it — but only when it has at least one interactive candidate, so this
  //    rule can never produce an empty table. A non-modal role=dialog (a
  //    cookie banner) does not scope; neither do a calendar / autocomplete
  //    popup that lives outside any aria-modal.
  // 2. Covered by an overlay (see penIsCovered below).
  function penModalIsVisible(m) {
    var mr = m.getBoundingClientRect();
    if (mr.width <= 0 || mr.height <= 0) return false;
    if (mr.bottom <= 0 || mr.top >= window.innerHeight || mr.right <= 0 || mr.left >= window.innerWidth) return false;
    var ms = getComputedStyle(m);
    if (ms.display === "none" || ms.visibility === "hidden") return false;
    if (parseFloat(ms.opacity) === 0) return false;
    return true;
  }

  // True when a hit-test at one of container's sample points (centre + the
  // 25%/75% corners, viewport-clipped) lands on container or a descendant
  // (composed). Distinguishes a modal/popup that is actually on top from one
  // left mounted but inert: an exit-transition leftover inside an
  // opacity:0; pointer-events:none wrapper lets the click through to
  // whatever is beneath, so nothing lands on it.
  function penHitsWithin(container) {
    var r = container.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var fracs = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
    for (var pi = 0; pi < fracs.length; pi++) {
      var px = r.left + r.width * fracs[pi][0];
      var py = r.top + r.height * fracs[pi][1];
      if (px < 0 || py < 0 || px >= window.innerWidth || py >= window.innerHeight) continue;
      var hit = elementFromPointDeep(px, py);
      if (hit && penComposedContains(container, hit)) return true;
    }
    return false;
  }

  function penFindTopModal() {
    var modalCandidates = deepQueryAll(document, "[aria-modal='true'], dialog");
    var top = null;
    for (var mi = 0; mi < modalCandidates.length; mi++) {
      var m = modalCandidates[mi];
      var isModal = m.getAttribute("aria-modal") === "true";
      if (!isModal && tagOf(m) === "dialog") {
        try {
          isModal = m.matches(":modal");
        } catch (err) {
          isModal = false;
        }
      }
      // Last in document order wins — among modals that are genuinely on
      // top (penHitsWithin): a stale one left mounted after its exit
      // transition must not outrank the open one.
      if (isModal && penModalIsVisible(m) && penHitsWithin(m)) top = m;
    }
    return top;
  }

  function penModalLabel(m) {
    var text = "";
    var aria = m.getAttribute("aria-label");
    if (aria && aria.trim()) text = aria.trim();
    if (!text) {
      var lb = m.getAttribute("aria-labelledby");
      if (lb) {
        var lbIds = lb.split(/\\s+/);
        var lbParts = [];
        for (var lbi = 0; lbi < lbIds.length; lbi++) {
          var lbRef = lbIds[lbi] ? document.getElementById(lbIds[lbi]) : null;
          var lbText = lbRef ? penCleanText(lbRef).trim().replace(/\\s+/g, " ") : "";
          if (lbText) lbParts.push(lbText);
        }
        text = lbParts.join(" ");
      }
    }
    if (!text) {
      var heading = m.querySelector("h1, h2, h3, h4, h5, h6");
      if (heading) text = penCleanText(heading).trim().replace(/\\s+/g, " ");
    }
    return text.slice(0, 80);
  }

  // Portals: libraries often render a dialog's datepicker / listbox /
  // autocomplete at the end of <body>, OUTSIDE the aria-modal element. A
  // candidate outside the modal is therefore kept when it is visibly on top
  // of the backdrop: in the viewport with at least one sample point whose
  // hit-test lands on it or a related node. Outside candidates that are
  // covered (the backdrop hits them) or wholly off-screen are dropped.
  var modalEl = penFindTopModal();
  var modalScoped = false;
  if (modalEl) {
    var inModal = [];
    var outsideOnTop = [];
    var insideCount = 0;
    for (var fm = 0; fm < found.length; fm++) {
      if (penComposedContains(modalEl, found[fm].el)) {
        inModal.push(found[fm]);
        insideCount++;
      } else if (penProbe(found[fm].el, found[fm].box).related) {
        outsideOnTop.push(found[fm]);
      }
    }
    if (insideCount > 0) {
      found = inModal.concat(outsideOnTop);
      modalScoped = true;
    }
  }

  // 2. Covered by an overlay layer. A candidate whose sampled points (centre
  // plus the 25%/75% corners, viewport-clipped) all hit something unrelated
  // (same test as CLICK_RESOLVE_JS) that sits inside a fixed/sticky wall layer not
  // containing the candidate is unreachable — a cookie wall, a sticky header,
  // a modal-ish backdrop that isn't marked aria-modal. Only a WALL counts
  // (layer covers >= 85% of the viewport, see penIsWall): a partial bar such
  // as booking.com's bottom OneTrust banner covered the calendar day cells
  // and dropping them made Jev toggle the date field forever; those elements
  // stay listed and REVEAL_TARGET_JS scrolls them into view before the click. The fixed/sticky
  // restriction is deliberate: a custom checkbox whose real <input> sits under
  // a sibling styled <span> (not inside a <label>) is also "unrelated" by the
  // hit-test, yet perfectly reachable through its wrapper, so only genuine
  // overlays count. Elements wholly outside the viewport are never dropped
  // (nothing can be hit-tested there; they're the infinite-scroll margin).
  // Every covered candidate is also tallied against the wall layer that hid
  // it (penWallHits), so a non-aria-modal drawer/overlay can be reported as
  // the snapshot's modal below.
  var penWallHits = new Map();
  function penIsCovered(el, boxEl) {
    var probe = penProbe(el, boxEl);
    var covered = probe.testable > 0 && !probe.related && probe.walled === probe.testable;
    // covered implies walled > 0, so probe.wall is always set here.
    if (covered) penWallHits.set(probe.wall, (penWallHits.get(probe.wall) || 0) + 1);
    return covered;
  }

  // Nearest-to-viewport first, then capped — the element table is the whole
  // request payload for /api/browse/step, so an uncapped one on a big page
  // is both slow and expensive. The covered check runs lazily in that order,
  // stopping once maxElements survivors are found, so it never hit-tests the
  // long tail that would be capped away anyway.
  function penReadingOrder(a, b) {
    return a.top - b.top || a.left - b.left;
  }
  found.sort(function (a, b) {
    return a.distance - b.distance || Number(!!a.disabled) - Number(!!b.disabled) || Number(a.cell) - Number(b.cell) || penReadingOrder(a, b);
  });
  var capped = [];
  for (var cf = 0; cf < found.length && capped.length < maxElements; cf++) {
    if (!penIsCovered(found[cf].el, found[cf].box)) capped.push(found[cf]);
  }
  // Priority decides WHAT survives the cap; the table itself follows the
  // page, top to bottom and left to right, so "the first result" in the
  // table is the first result on the page.
  capped.sort(penReadingOrder);

  // A wall that is not aria-modal / <dialog> (a cart side drawer that dims the
  // page and locks scroll) still hides everything behind it. When rule 1 found
  // no modal but rule 2 dropped at least PEN_OVERLAY_MIN_COVERED candidates
  // behind one wall AND a surviving listed control lives in a fixed/sticky
  // layer (the drawer itself or the wall), report that wall as the modal so
  // the caller knows it is behind an overlay (and can press Escape / use the
  // overlay's own close control) instead of scrolling to no effect. An empty
  // overlay (nothing interactive on it) or a stray covered control keeps the
  // old behaviour: no modal. The element table is NOT scoped by this, and
  // child frames are still all merged (a sibling iframe pattern).
  var PEN_OVERLAY_MIN_COVERED = 3;
  function penFixedLayerOf(el) {
    var node = el;
    var guard = 0;
    while (node && node.nodeType === 1 && guard < 500) {
      var pos = getComputedStyle(node).position;
      if (pos === "fixed" || pos === "sticky") return node;
      node = penComposedParent(node);
      guard++;
    }
    return null;
  }
  // An overlay tied to the focused text field (an autocomplete / suggestions
  // panel) is part of typing, not a blocker: reporting it as the modal made
  // the caller press Escape, which clears the typed text, then click the field
  // again, forever. Deliberately narrow — suppress ONLY when (a) the deep
  // active element is a real text entry (textarea, text-like input, or
  // contenteditable; not a role=combobox div, not a date/password input),
  // (b) that field sits OUTSIDE the wall and the drawer layers (an overlay
  // holding its own focused field is a real popup; a full-viewport suggestions
  // panel covers its own field, so "listed" cannot be required),
  // and (c) the field points at the overlay (aria-controls / aria-owns / list
  // target inside or equal to a layer) or a layer holds a listbox / option.
  // Mirrors the penDeepActive / penIsEditable helpers (FOCUS_FOLLOW_HELPER_JS)
  // but with a stricter input-type list.
  function penOverlayBelongsToField(wall, layers) {
    var act = document.activeElement;
    var g = 0;
    while (act && act.shadowRoot && act.shadowRoot.activeElement && g < 20) {
      act = act.shadowRoot.activeElement;
      g++;
    }
    if (!act || act.nodeType !== 1 || act === document.body) return false;
    var tag = act.tagName.toLowerCase();
    var itype = (act.getAttribute("type") || "").toLowerCase();
    var textEntry =
      tag === "textarea" ||
      (tag === "input" && /^(|text|search|email|url|tel|number)$/.test(itype)) ||
      act.isContentEditable === true;
    if (!textEntry) return false;
    var all = [wall].concat(layers);
    for (var ai = 0; ai < all.length; ai++) {
      if (penComposedContains(all[ai], act)) return false;
    }
    var root = act.getRootNode && act.getRootNode();
    var refIds = ((act.getAttribute("aria-controls") || "") + " " + (act.getAttribute("aria-owns") || "") + " " + (act.getAttribute("list") || "")).split(/\\s+/);
    for (var li = 0; li < all.length; li++) {
      var layer = all[li];
      for (var ri = 0; ri < refIds.length; ri++) {
        if (!refIds[ri]) continue;
        var ref = (root && root.getElementById && root.getElementById(refIds[ri])) || document.getElementById(refIds[ri]);
        if (ref && penComposedContains(layer, ref)) return true;
      }
      if (deepQueryAll(layer, "[role=listbox], [role=option]").length > 0) return true;
      // The popup the shared rule assigns to the focused field (role-less
      // options in a floating layer).
      // Only a popup found through aria-controls or a mirror anchor counts,
      // never one guessed from geometry alone.
      var fieldPopup = penPopupFor(act);
      for (var pri = 0; fieldPopup && fieldPopup.strong && pri < fieldPopup.roots.length; pri++) {
        if (penComposedContains(layer, fieldPopup.roots[pri]) || penComposedContains(fieldPopup.roots[pri], layer)) return true;
      }
    }
    return false;
  }
  var overlayEl = null;
  var overlayLabel = "";
  if (!modalScoped) {
    var overlayBest = 0;
    penWallHits.forEach(function (count, layer) {
      if (count > overlayBest) {
        overlayBest = count;
        overlayEl = layer;
      }
    });
    if (overlayEl && overlayBest >= PEN_OVERLAY_MIN_COVERED) {
      var survivingLayers = [];
      for (var sl = 0; sl < capped.length; sl++) {
        var slLayer = penFixedLayerOf(capped[sl].el);
        if (slLayer && survivingLayers.indexOf(slLayer) < 0) survivingLayers.push(slLayer);
      }
      if (survivingLayers.length === 0 || penOverlayBelongsToField(overlayEl, survivingLayers)) {
        overlayEl = null;
      } else {
        // The wall's own label first; a bare backdrop falls back to the
        // sibling panel that holds the listed controls (the drawer).
        overlayLabel = penModalLabel(overlayEl);
        for (var ll = 0; !overlayLabel && ll < survivingLayers.length; ll++) {
          overlayLabel = penModalLabel(survivingLayers[ll]);
        }
      }
    } else {
      overlayEl = null;
    }
  }

  // Unanswered required choice far above a disabled goal button. A configurator
  // keeps its primary button natively disabled until radio groups ABOVE it are
  // answered, often 2-3 screens up; the near-viewport table then shows the
  // disabled button but never the choice that unlocks it, and the step rule
  // "a disabled control means an earlier choice is unanswered" has nothing to
  // act on (the agent scrolled up and down forever). So when a natively
  // disabled button is listed, also list the enabled options of the (at most
  // 2 nearest) radio groups before it that have no checked option, even outside
  // the viewport margin (PERFORM scrolls the target into view). Same entry
  // builder as every other element (only the viewport-distance margin is
  // lifted; a clipped-away option is still rejected); nothing changes without
  // a disabled button, behind a modal or a reported overlay. The table never
  // exceeds maxElements: the farthest ordinary entries make room.
  var PEN_EXTRA_GROUPS = 2;
  var PEN_EXTRA_OPTIONS = 6;
  function penIsDisabledButtonLike(e) {
    if (!e.disabled) return false;
    var itype = (e.el.getAttribute("type") || "").toLowerCase();
    var erole = (e.role || "").toLowerCase();
    return (!erole || erole === "button") && (e.tag === "button" || (e.tag === "input" && /^(submit|button)$/.test(itype)));
  }
  // The same wall test as penIsCovered, WITHOUT tallying penWallHits: forced
  // extras must not feed the overlay statistics.
  function penIsCoveredQuiet(el, boxEl) {
    var probe = penProbe(el, boxEl);
    return probe.testable > 0 && !probe.related && probe.walled === probe.testable;
  }
  if (!modalScoped && !overlayEl) {
    var penIdx = new Map();
    for (var xi = 0; xi < candidates.length; xi++) penIdx.set(candidates[xi], xi);
    // a before b in document order (candidate order across shadow roots).
    var penBefore = function (a, b) {
      var pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_DISCONNECTED) return (penIdx.get(a) || 0) < (penIdx.get(b) || 0);
      return !!(pos & Node.DOCUMENT_POSITION_FOLLOWING);
    };
    var penAnchor = null;
    for (var bi = 0; bi < capped.length; bi++) {
      if (!penIsDisabledButtonLike(capped[bi])) continue;
      if (!penAnchor || penBefore(penAnchor.el, capped[bi].el)) penAnchor = capped[bi];
    }
    if (penAnchor) {
      var penGroups = new Map();
      for (var ri = 0; ri < candidates.length; ri++) {
        var radio = candidates[ri];
        if (!penToggleInput(radio) || (radio.getAttribute("type") || "").toLowerCase() !== "radio") continue;
        var rname = radio.getAttribute("name");
        if (!rname) continue;
        var gkey = radio.form || radio.getRootNode();
        var gmap = penGroups.get(gkey);
        if (!gmap) {
          gmap = new Map();
          penGroups.set(gkey, gmap);
        }
        var grp = gmap.get(rname);
        if (!grp) {
          grp = { form: radio.form, checked: false, opts: [], last: -1 };
          gmap.set(rname, grp);
        }
        if (radio.checked) grp.checked = true;
        if (penNativelyDisabled(radio) || radio.getAttribute("aria-hidden") === "true") continue;
        if (penBefore(radio, penAnchor.el)) {
          grp.opts.push(radio);
          grp.last = ri;
        }
      }
      var penOpen = [];
      penGroups.forEach(function (gm) {
        gm.forEach(function (g) {
          if (!g.checked && g.opts.length > 0) penOpen.push(g);
        });
      });
      // The anchor's own form wins when it holds a qualifying group.
      var anchorForm = penAnchor.el.form;
      if (anchorForm) {
        var inForm = penOpen.filter(function (g) {
          return g.form === anchorForm;
        });
        if (inForm.length) penOpen = inForm;
      }
      penOpen.sort(function (a, b) {
        return b.last - a.last;
      });
      var penListed = new Set();
      for (var ci = 0; ci < capped.length; ci++) {
        penListed.add(capped[ci].el);
        penListed.add(capped[ci].box);
      }
      var penExtras = [];
      var penGroupSlots = PEN_EXTRA_GROUPS;
      var penRoom = Math.max(0, maxElements - 1);
      for (var gi = 0; gi < penOpen.length && penExtras.length < penRoom; gi++) {
        var added = 0;
        for (var oi = 0; oi < penOpen[gi].opts.length && added < PEN_EXTRA_OPTIONS && penExtras.length < penRoom; oi++) {
          var opt = penOpen[gi].opts[oi];
          if (penListed.has(opt)) continue;
          var extra = penBuildEntry(opt, true);
          if (!extra || penListed.has(extra.box) || penIsCoveredQuiet(extra.el, extra.box)) continue;
          penListed.add(extra.el);
          penListed.add(extra.box);
          penExtras.push(extra);
          added++;
        }
        if (added > 0 && --penGroupSlots === 0) break;
      }
      if (penExtras.length) {
        // Make room: evict the farthest ordinary entries, never the anchor.
        var evictable = capped.filter(function (c) {
          return c !== penAnchor;
        });
        evictable.sort(function (a, b) {
          return b.distance - a.distance || penReadingOrder(b, a);
        });
        var need = capped.length + penExtras.length - maxElements;
        var evict = new Set(evictable.slice(0, Math.max(0, need)));
        capped = capped.filter(function (c) {
          return !evict.has(c);
        });
        capped = capped.concat(penExtras);
        capped.sort(penReadingOrder);
      }
    }
  }

  var elements = [];
  for (var idx = 0; idx < capped.length; idx++) {
    var item = capped[idx];
    // Unlabelled icon buttons are exactly what cookie banners are made of —
    // still include the element, labelled by its tag and position, rather
    // than dropping it.
    var label = item.label ? item.label.slice(0, PEN_LABEL_MAX) : String(item.tag).slice(0, 40) + " #" + idx;
    item.el.setAttribute("data-pen-snap", snapshotId + ":" + idx);
    var out = { index: idx, tag: String(item.tag).slice(0, 40), label: label, ops: item.ops };
    if (item.role) out.role = String(item.role).slice(0, 60);
    if (item.options) out.options = item.options;
    if (item.value !== undefined) out.value = item.value;
    if (item.hasValue !== undefined) out.hasValue = item.hasValue;
    // Load-bearing, not informational: /api/browse/step refuses outright to
    // generate text for a password field, and this flag is the only way it
    // can tell. Omitting it made that refusal unreachable end to end — the
    // rule is absolute, so the signal carrying it has to leave the page.
    if (item.isPassword) out.isPassword = true;
    if (item.checked !== undefined) out.checked = item.checked;
    if (item.expanded !== undefined) out.expanded = item.expanded;
    if (item.disabled === true) out.disabled = true;
    elements.push(out);
  }

  // Wave 2 reliability, item 4/5: mark scrollable containers as their own
  // element-table entries, so act scroll / perform SCROLL_* can be pointed
  // at one by index — the same data-pen-snap stamping every other indexed
  // action already relies on (see PERFORM_JS/SCROLL_JS's own lookups).
  // ops: [], not ["SCROLL"]: pen-editor-backend's /api/browse/step zod
  // schema enumerates ops as CLICK | TYPE_TEXT | SELECT with .min(1) —
  // adding a fourth value there is a separate, backend-repo change (see the
  // shared contract doc and this repo's CLAUDE.md); a container is instead
  // recognizable purely by scrollable: true. Visible-only (SNAPSHOT_JS's own
  // isVisible, same as every interactive element above), largest-by-
  // rendered-area first.
  //
  // Code review finding 7: these used to be appended UNCONDITIONALLY on top
  // of \`elements\` (already capped at \`maxElements\` interactive elements),
  // so a busy page with both \`maxElements\` interactive elements AND up to
  // 10 scroll containers could report more than \`maxElements\` elements
  // total. \`controller.ts\`'s \`takeSnapshot\` computes its own frame budget as
  // \`remaining = MAX_SNAPSHOT_ELEMENTS - elements.length\` straight off that
  // count — a negative \`remaining\` made its \`if (remaining > 0)\` guard skip
  // the whole child-frame merge outright, so a busy top document silently
  // starved every iframe's elements out of the snapshot. The scroll-
  // container slice is now capped to whatever budget is actually left after
  // the interactive elements (min(10, maxElements - capped.length), never
  // negative), so \`elements.length\` here can never exceed \`maxElements\` and
  // \`remaining\` downstream can never go negative.
  // Second-pass review: a scroll container that is ALSO an interactive
  // element (e.g. a textarea with overflow:auto, a contenteditable editor,
  // a combobox listbox) was already stamped data-pen-snap with its
  // interactive index above. Re-stamping it here with a fresh container
  // index would overwrite that stamp, so the interactive index no longer
  // resolves ("No element matched") the next time a caller acts on it. Any
  // element already carrying this snapshot's stamp — whether an interactive
  // entry or (defensively) an earlier scroll-container entry — is skipped
  // here; its existing element-table entry is flagged scrollable: true
  // instead of getting a duplicate entry.
  var scrollContainerBudget = Math.max(0, Math.min(10, maxElements - elements.length));
  var scrollContainerCandidates = scrollContainerBudget > 0 ? deepQueryAll(document, "*") : [];
  var scrollContainers = [];
  var snapshotStampPrefix = snapshotId + ":";
  for (var sci = 0; sci < scrollContainerCandidates.length; sci++) {
    var candidate = scrollContainerCandidates[sci];
    if (!isScrollableContainer(candidate)) continue;
    if (!isVisible(candidate)) continue;
    // Modal scope applies to scroll containers too (a page-behind list is as
    // unreachable as a page-behind button).
    // A portalled scroll container (a datepicker / listbox appended to
    // <body>) outside the modal is kept when it is visibly on top: a sample
    // point hits it or a descendant (same rule as portal candidates above).
    if (modalScoped && !penComposedContains(modalEl, candidate) && !penHitsWithin(candidate)) continue;
    // A page carousel hidden behind the overlay wall is as unreachable as a
    // page-behind button.
    if (overlayEl && penIsCovered(candidate)) continue;
    var existingStamp = candidate.getAttribute("data-pen-snap");
    if (existingStamp && existingStamp.indexOf(snapshotStampPrefix) === 0) {
      var existingIndex = parseInt(existingStamp.slice(snapshotStampPrefix.length), 10);
      if (!isNaN(existingIndex) && elements[existingIndex]) {
        elements[existingIndex].scrollable = true;
      }
      continue;
    }
    scrollContainers.push(candidate);
  }
  scrollContainers.sort(function (a, b) {
    var ra = a.getBoundingClientRect();
    var rb = b.getBoundingClientRect();
    return rb.width * rb.height - ra.width * ra.height;
  });
  scrollContainers = scrollContainers.slice(0, scrollContainerBudget);

  function containerLabelOf(el) {
    var aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim().slice(0, 60);
    var heading = el.querySelector("h1, h2, h3, h4, h5, h6");
    if (heading) {
      var headingText = penCleanText(heading).trim().replace(/\\s+/g, " ");
      if (headingText) return headingText.slice(0, 60);
    }
    var text = penCleanText(el).trim().replace(/\\s+/g, " ");
    if (text) return text.slice(0, 60);
    return tagOf(el) + " (scrollable)";
  }

  for (var ci = 0; ci < scrollContainers.length; ci++) {
    var containerEl = scrollContainers[ci];
    var containerIndex = elements.length;
    containerEl.setAttribute("data-pen-snap", snapshotId + ":" + containerIndex);
    elements.push({
      index: containerIndex,
      tag: tagOf(containerEl),
      label: containerLabelOf(containerEl),
      ops: [],
      scrollable: true,
    });
  }

  var scrollInfo = {
    y: window.scrollY,
    height: document.documentElement.scrollHeight,
    atBottom: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2,
  };
  // Item 5: when the window itself can't scroll, also report scroll info for
  // whichever container act scroll / perform SCROLL_* would auto-pick —
  // otherwise a caller has no way to tell how much of that container is left
  // to scroll without a wasted round trip.
  if (!windowIsScrollable()) {
    var autoContainer = pickLargestScrollableInCenter();
    if (autoContainer) {
      var autoIndex = -1;
      for (var fi = 0; fi < scrollContainers.length; fi++) {
        if (scrollContainers[fi] === autoContainer) {
          autoIndex = elements.length - scrollContainers.length + fi;
          break;
        }
      }
      scrollInfo.container = {
        index: autoIndex >= 0 ? autoIndex : undefined,
        y: autoContainer.scrollTop,
        height: autoContainer.scrollHeight,
        atBottom: autoContainer.scrollTop + autoContainer.clientHeight >= autoContainer.scrollHeight - 2,
      };
    }
  }

  // Visible text inside the viewport, in document order, capped at 6000
  // chars — jev-ultrafast's snapshot.js: the decision model needs the words a
  // user sees (a validation error, "Account created", a result's price), not
  // just the controls. Overlay text (cursor, set-of-marks) and inert source
  // (script/style/noscript/template) never count.
  var textParts = [];
  var textLength = 0;
  if (document.body) {
    var textWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var textRange = document.createRange();
    var textNode;
    while ((textNode = textWalker.nextNode()) && textLength < 6000) {
      var piece = (textNode.textContent || "").replace(/\\s+/g, " ").trim();
      var holder = textNode.parentElement;
      if (!piece || !holder) continue;
      if (holder.closest("script,style,noscript,template,[data-pen-cursor],[data-pen-marks],[aria-hidden='true']")) continue;
      textRange.selectNodeContents(textNode);
      var tr = textRange.getBoundingClientRect();
      if (tr.width <= 0 || tr.height <= 0 || tr.bottom <= 0 || tr.top >= window.innerHeight || tr.right <= 0 || tr.left >= window.innerWidth) continue;
      var holderStyle = getComputedStyle(holder);
      if (holderStyle.visibility === "hidden" || parseFloat(holderStyle.opacity) === 0) continue;
      textParts.push(piece);
      textLength += piece.length + 1;
    }
  }

  var snapshotResult = {
    url: location.href,
    title: document.title,
    elements: elements,
    scroll: scrollInfo,
    text: textParts.join("\\n").slice(0, 6000),
  };
  // Present when rule 1 scoped the table (these are the modal's controls, not
  // "this page has nothing else"), or when a non-aria wall hid candidates
  // behind a drawer/overlay (see overlayEl above; the table is not scoped).
  if (modalScoped) {
    snapshotResult.modal = penModalLabel(modalEl) || "modal dialog";
  } else if (overlayEl) {
    snapshotResult.modal = overlayLabel || "overlay";
  }
  if (modalScoped) {
    // Which <iframe>s live inside the modal (identified like IFRAME_RECTS_JS:
    // src, name/id) so controller.ts's takeSnapshot merges only those child
    // frames. Internal — stripped from the result before it reaches callers.
    var modalFrames = [];
    var allFrames = deepQueryAll(document, 'iframe');
    for (var mf = 0; mf < allFrames.length; mf++) {
      if (penComposedContains(modalEl, allFrames[mf])) {
        modalFrames.push({ url: allFrames[mf].src || "", name: allFrames[mf].getAttribute("name") || allFrames[mf].id || "" });
      }
    }
    snapshotResult.__modalFrames = modalFrames;
  }
  return snapshotResult;
})()`;

/**
 * Acts on the element previously stamped by SNAPSHOT_JS at `args.index`
 * under `args.snapshotId`, looked up by the exact `data-pen-snap` attribute
 * (see SNAPSHOT_JS's doc comment for why this is a lookup, not a
 * recomputed candidate list). `SCROLL_UP`/`SCROLL_DOWN` act on the page
 * itself and never need an element.
 *
 * Review finding 4: for CLICK/TYPE_TEXT/SELECT, the located element is
 * additionally stamped `data-pen-sig-target` and scoped-signatured before
 * being mutated — same as CLICK_JS/TYPE_JS, see their doc comments.
 */
export const PERFORM_JS = `(() => {
  var args = ${ARGS_MARKER};
  var snapshotId = args.snapshotId;
  var index = args.index;
  var operation = args.operation;
  var text = args.text;

  ${SCOPED_SIGNATURE_JS}
  ${TARGET_BUSY_HELPER_JS}
  ${FIND_BY_SNAPSHOT_JS}
  ${REVEAL_IF_NEEDED_JS}
  ${SCROLL_CONTAINER_HELPER_JS}
  ${RANGE_TYPE_HELPER_JS}

  if (operation === "SCROLL_UP" || operation === "SCROLL_DOWN") {
    // Wave 2 reliability item 4: same auto-pick SCROLL_JS uses when the
    // caller gave no target — an explicit index/snapshotId naming a scroll
    // container (SNAPSHOT_JS's own ADD entries, or any indexed element)
    // scrolls that container (or its nearest scrollable ancestor) directly;
    // otherwise, if the window itself can't scroll, the largest visible
    // scrollable container near the viewport centre is used instead.
    var amount = operation === "SCROLL_UP" ? -1 : 1;
    var amountPx = window.innerHeight * amount;
    var scrollEl = null;
    if (index !== undefined && index !== null && snapshotId) {
      var scrollTargetEl = findBySnapshot(snapshotId, index, args.fingerprint);
      if (scrollTargetEl) {
        scrollEl = isScrollableContainer(scrollTargetEl) ? scrollTargetEl : nearestScrollableAncestor(scrollTargetEl);
      }
    }
    if (!scrollEl && !windowIsScrollable()) {
      scrollEl = pickLargestScrollableInCenter();
    }
    if (scrollEl) scrollEl.scrollBy(0, amountPx);
    else window.scrollBy(0, amountPx);
    var performScrollResult = { url: location.href, title: document.title };
    if (penRelocated) performScrollResult.relocated = true;
    return performScrollResult;
  }

  // Second-pass review finding 10: reuses the same exact-attribute-compare
  // lookup FOCUS_JS/HOVER_TARGET_JS already use (FIND_BY_SNAPSHOT_JS) instead
  // of an independent, identical-looking inline data-pen-snap selector
  // lookup — snapshotId here only ever comes from this controller's own
  // server-generated ids, so the selector-injection risk that motivated
  // FIND_BY_SNAPSHOT_JS in the first place never applied to PERFORM_JS, but
  // keeping one lookup implementation instead of two means a future fix to
  // it can't drift between the two call sites.
  var el = findBySnapshot(snapshotId, index, args.fingerprint);
  if (!el) {
    return { error: "No element at index " + index + " for this snapshot (stale or removed)." };
  }

  var penRefusal2 = penDisabledError(el, operation);
  if (penRefusal2) return { error: penRefusal2 };

  penStampSigTarget(el);
  var scopedBefore = scopedSignatureOf(el);
  var busyBefore = penTargetIsBusy(el);
  function penResult() {
    var r = {
      url: location.href,
      title: document.title,
      __scopedBefore: scopedBefore,
      __targetSelfDisabled: !busyBefore && penTargetIsBusy(el),
    };
    if (penRelocated) r.relocated = true;
    return r;
  }

  if (operation === "CLICK") {
    penRevealIfNeeded(el);
    el.click();
    return penResult();
  }

  if (operation === "TYPE_TEXT") {
    var sliderPrep = penSliderPrepare(el, text);
    if (sliderPrep) {
      if (sliderPrep.error) return { error: "Element at index " + index + " is " + sliderPrep.error };
      // See TYPE_JS: the controller finishes the job with trusted keys.
      var sliderResult = penResult();
      sliderResult.__slider = sliderPrep.slider;
      sliderResult.__targetSelfDisabled = false;
      return sliderResult;
    }
    penRevealIfNeeded(el);
    el.focus();
    var tag = (el.tagName || "").toLowerCase();
    var rangeInfo = null;
    if (tag === "input" && (el.getAttribute("type") || "").toLowerCase() === "range") {
      var rangeTyped = penRangeValueFor(el, text);
      if (rangeTyped.error) return { error: "Element at index " + index + " is " + rangeTyped.error };
      text = rangeTyped.value;
      rangeInfo = rangeTyped;
    }
    if (tag === "input" || tag === "textarea") {
      var proto = tag === "input" ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, text);
    } else if (el.isContentEditable) {
      el.textContent = text;
    } else {
      return { error: "Element at index " + index + " is not editable." };
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    var rangeMiss = rangeInfo ? penRangeVerdict(el, rangeInfo) : "";
    var typedResult = penResult();
    // See TYPE_JS: a coarse native range moved to a different number.
    if (rangeMiss) {
      typedResult.error = rangeMiss;
      typedResult.__sliderPartial = true;
    }
    return typedResult;
  }

  if (operation === "SELECT") {
    var tagName = (el.tagName || "").toLowerCase();
    if (tagName !== "select") {
      return { error: "Element at index " + index + " is not a <select>." };
    }
    var matched = false;
    for (var i = 0; i < el.options.length; i++) {
      if (el.options[i].text === text) {
        el.selectedIndex = i;
        matched = true;
        break;
      }
    }
    if (!matched) {
      return { error: "No option matching " + JSON.stringify(text) + " in element at index " + index + "." };
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return penResult();
  }

  return { error: "Unsupported operation: " + operation };
})()`;

/**
 * A cheap, deterministic page signature — jev-loop design doc "Addendum 2,
 * 2026-09-19" §1 ("Act results must carry evidence of effect"). Run once
 * before an action and once after its settle, then diffed by
 * controller.ts's `diffSignatures`.
 *
 * Review findings 2/3/4 reshaped this considerably from the original
 * addendum:
 *
 * - It now takes `args.phase` ("before" | "after") — no longer argument-free
 *   — because it needs to coordinate element-identity markers across the two
 *   calls (see below), which a stateless single-shot script can't do.
 * - `scrollY` and a `focusedValueLength` (the currently-focused input's
 *   value length, never its content) join the signature (finding 3): the
 *   old signature had nothing that moved for a successful scroll or a
 *   successful type into a field, making them indistinguishable from typing
 *   into/scrolling a dead one.
 * - `mainImageSrc` is now identity-guarded (finding 4's "guard against the
 *   largest visible img becoming a different element when an ad loads"): on
 *   `phase: "before"`, the element currently largest-by-visible-area is
 *   found and stamped `data-pen-sig-mainimg`; on `phase: "after"`, the
 *   *same* stamped element (if it still exists) is re-read, rather than
 *   recomputing "largest visible img" from scratch, which could now pick a
 *   newly-loaded ad instead of the element that actually changed.
 * - On `phase: "after"`, if the acting script (CLICK_JS/TYPE_JS/PERFORM_JS)
 *   stamped an element `data-pen-sig-target`, its scoped signature is
 *   re-computed and returned as `scopedAfter` (see SCOPED_SIGNATURE_JS).
 * - `phase: "before"` also sweeps away any `data-pen-sig-mainimg` /
 *   `data-pen-sig-target` markers left over from a *previous* action, so
 *   each action's identity tracking starts clean.
 *
 * `nodeCount`/`textLength`/`textHash` (the whole-document numbers) are
 * still computed and returned — controller.ts still reports them in
 * `changes` as useful context — but per finding 4 they no longer gate
 * `changed` on their own; see diffSignatures's doc comment.
 */
export const SIGNATURE_JS = `(() => {
  var args = ${ARGS_MARKER};
  var phase = args.phase;

  function isVisible(el) {
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    var style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (parseFloat(style.opacity) === 0) return false;
    return true;
  }

  ${SCOPED_SIGNATURE_JS}

  if (phase === "before") {
    var staleMain = document.querySelectorAll("[data-pen-sig-mainimg]");
    for (var sm = 0; sm < staleMain.length; sm++) staleMain[sm].removeAttribute("data-pen-sig-mainimg");
    penClearSigTargets();
  }

  // Wave 1 speed (2026-09-24 browse-speed contract, "cheaper evidence"): the
  // whole-document dom/text signal used to be a plain
  // document.querySelectorAll("*").length + document.body.innerText scan,
  // run once "before" and once "after" — the innerText read in particular
  // forces a full layout/reflow, and this ran on every act/perform/press
  // call whether or not anything actually changed. diffSignatures
  // (controller.ts) only ever uses dom/text as report-only entries in
  // "changes" — they never gate "changed" on their own (only
  // url/title/main-image/scroll/value/the scoped target signature do, see
  // its doc comment) — so a much cheaper boolean "did anything mutate the
  // DOM/text" from a MutationObserver installed on "before" and read back on
  // "after" is exactly as useful here as the exact node count/text hash ever
  // was, for a fraction of the cost. nodeCount/textLength/textHash keep
  // their original field names/types (numbers) purely so
  // isPageSignature/diffSignatures on the controller.ts side need no changes
  // at all: "before" always reports 0/0/0 (a fixed baseline, no scan
  // needed), and "after" reports 1/1/1 only when the observer actually saw a
  // relevant mutation — the inequality diffSignatures checks is exactly as
  // meaningful as it was comparing two real scans, since only "did it
  // change" was ever read out of it.
  // Cross-phase state lives on \`window\`, never in a local var: the observer
  // registered in the "before" phase's IIFE invocation keeps running (and
  // its callback keeps firing, asynchronously) long after that particular
  // executeJavaScript call has returned — but the "after" phase is a
  // completely separate IIFE invocation with its own fresh locals. A local
  // \`var penSigDomChanged\` etc. would silently discard whatever the live
  // callback saw in between (it usually fires well before "after" ever
  // runs, so takeRecords() in "after" often has nothing left to flush) —
  // exactly the bug this comment is here to prevent regressing. Every
  // helper below reads/writes \`window.__penSigState\` for that reason, so
  // both "the callback that's still running from 'before'" and "the manual
  // takeRecords() flush 'after' does" accumulate into the one shared object.
  // Capture id: "before" mints one (returned as \`captureId\`) and the
  // controller hands it back with the "after". An "after" whose id does not
  // match the stored state belongs to a DIFFERENT action (its own "before"
  // failed, or a keep-peek left state behind): that evidence is treated as
  // unavailable — observer torn down, state replaced by an empty one — so a
  // stale change can never be reported as this action's effect.
  var penSigCaptureId = "";
  if (phase === "before") {
    penSigCaptureId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    window.__penSigState = { id: penSigCaptureId, domChanged: false, textChanged: false, pageChanged: false, appeared: [] };
  } else if (!window.__penSigState || window.__penSigState.id !== args.captureId) {
    if (window.__penSigObserver) {
      try {
        window.__penSigObserver.disconnect();
      } catch (e) {}
      window.__penSigObserver = null;
    }
    if (window.__penSigTimer) clearTimeout(window.__penSigTimer);
    window.__penSigTimer = null;
    window.__penSigState = { id: null, domChanged: false, textChanged: false, pageChanged: false, appeared: [] };
  }
  var penSigState = window.__penSigState;

  // Browse-speed contract addendum (2026-09-24): a second, stricter signal —
  // "did the page meaningfully change" (pageChanged) plus up to 3 short
  // snippets of text that newly appeared/changed (appeared) — layered on top
  // of the same MutationObserver used for the report-only dom/text booleans
  // above. Deliberately more conservative than domChanged/textChanged:
  // whole-document noise (a carousel auto-advancing, a lazy image swapping
  // in, the cursor/marks overlay's own DOM churn) must never count as
  // confirmation that an action had an effect — only visible, real-content
  // mutations do.
  var IGNORED_TAGS = { SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, NOSCRIPT: 1 };
  var INTERACTIVE_TAGS = { BUTTON: 1, A: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1 };
  // Review finding 1: a value/timestamp that only ever cycles through
  // digits/whitespace/punctuation (a clock, a countdown, "12:34", "3/25")
  // is exactly the kind of background noise a live page mutates on its own
  // — it must never look like evidence that an *action* did something.
  var TICKER_RE = /^[\\s\\d:.,\\/%+\\-–—()]*$/;

  function isOverlayNode(node) {
    return !!(node && node.closest && (node.closest("[data-pen-cursor]") || node.closest("[data-pen-marks]")));
  }

  function shortSnippet(text) {
    if (!text) return "";
    var trimmed = String(text).replace(/\\s+/g, " ").trim();
    if (!trimmed) return "";
    return trimmed.length > 80 ? trimmed.slice(0, 80) : trimmed;
  }

  function pushAppeared(text) {
    if (penSigState.appeared.length >= 3) return;
    var snippet = shortSnippet(text);
    if (!snippet) return;
    if (penSigState.appeared.indexOf(snippet) !== -1) return;
    penSigState.appeared.push(snippet);
  }

  function normalizeDigits(text) {
    return String(text || "").replace(/\\d/g, "0");
  }

  // Two ways a text change can be pure ticker noise: both the old and new
  // text are entirely digits/whitespace/punctuation (a clock face), or they
  // differ only in which digits appear (a counter, "Updated 2 min ago" →
  // "Updated 3 min ago").
  function isTickerChange(oldText, newText) {
    if (TICKER_RE.test(oldText) && TICKER_RE.test(newText)) return true;
    return normalizeDigits(oldText) === normalizeDigits(newText);
  }

  function isInteractive(el) {
    var tag = (el.tagName || "").toUpperCase();
    return !!INTERACTIVE_TAGS[tag] || el.hasAttribute("role");
  }

  // Perf/review finding 2: textContent never forces layout the way
  // innerText does, and it's cheap enough to read repeatedly — used for the
  // "is there any real text here at all" check before anything touches
  // innerText. Capped to 200 chars, since this is only ever used to decide
  // "empty or not" / feed the ticker comparison, never rendered in full.
  function cheapText(node) {
    return (node.textContent || "").slice(0, 200);
  }

  // Removals are never evidence (review finding 1): a node leaving the DOM
  // (however "real" it was) is exactly as likely to be routine cleanup
  // (a toast timing out, a carousel recycling an off-screen slide) as it is
  // to be the effect of an action — unlike an *addition*, there's no
  // "still visible with real content" signal left to check once a node is
  // detached, so removals are simply never counted at all.
  function considerElement(el) {
    if (!el || el.nodeType !== 1) return;
    var tag = (el.tagName || "").toUpperCase();
    if (IGNORED_TAGS[tag]) return;
    if (isOverlayNode(el)) return;
    // Attached and currently in the live document — isVisible's layout
    // read is meaningful here.
    if (!isVisible(el)) return;
    var interactive = isInteractive(el);
    if (!interactive && !cheapText(el).trim()) return;
    penSigState.pageChanged = true;
    // Snippet cap checked BEFORE the (layout-forcing) innerText read.
    if (penSigState.appeared.length < 3) {
      var text = (el.innerText || el.textContent || "").slice(0, 200);
      pushAppeared(text);
    }
  }

  // oldValue is only ever supplied for an actual characterData mutation
  // (a text node's content changing in place); a brand-new text node has no
  // "old" counterpart, so it's filtered on its own content alone.
  function considerTextNode(node, oldValue) {
    if (!node) return;
    var parent = node.parentElement;
    if (!parent) return;
    var tag = (parent.tagName || "").toUpperCase();
    if (IGNORED_TAGS[tag]) return;
    if (isOverlayNode(parent)) return;
    if (!isVisible(parent)) return;
    var newText = cheapText(node);
    if (!newText.trim()) return;
    if (oldValue !== undefined) {
      if (isTickerChange(String(oldValue || "").slice(0, 200), newText)) return;
    } else if (TICKER_RE.test(newText)) {
      return;
    }
    penSigState.pageChanged = true;
    if (penSigState.appeared.length < 3) pushAppeared(newText);
  }

  // Perf finding 2: bounded per invocation two ways — at most 50 records
  // examined (this callback fires on every quiet MutationObserver
  // microtask, and a bulk DOM rewrite can otherwise hand it thousands at
  // once), and an early exit the moment there's nothing left to learn
  // (pageChanged already true and the 3-snippet cap already full).
  function penSigProcessRecords(records) {
    var limit = records.length < 50 ? records.length : 50;
    for (var r = 0; r < limit; r++) {
      if (penSigState.pageChanged && penSigState.appeared.length >= 3) break;
      var rec = records[r];
      if (rec.type === "characterData") {
        penSigState.textChanged = true;
        considerTextNode(rec.target, rec.oldValue);
        continue;
      }
      if (rec.type === "childList" && (rec.addedNodes.length || rec.removedNodes.length)) {
        penSigState.domChanged = true;
        for (var an = 0; an < rec.addedNodes.length; an++) {
          var added = rec.addedNodes[an];
          if (added.nodeType === 3) {
            penSigState.textChanged = true;
            considerTextNode(added);
          } else {
            considerElement(added);
          }
        }
        // Removals only feed the report-only textChanged/domChanged
        // booleans above — never pageChanged/appeared (see considerElement's
        // doc comment).
        for (var rn = 0; rn < rec.removedNodes.length; rn++) {
          var removed = rec.removedNodes[rn];
          if (removed.nodeType === 3) penSigState.textChanged = true;
        }
      }
    }
  }

  var textLength = 0;
  var hash = 0;

  if (phase === "before") {
    // A previous action's observer (if the "after" phase somehow never ran —
    // e.g. a prior command timed out mid-capture) is disconnected first, so
    // observers never pile up on a long-lived page.
    if (window.__penSigObserver) {
      try {
        window.__penSigObserver.disconnect();
      } catch (e) {}
    }
    try {
      var observer = new MutationObserver(penSigProcessRecords);
      if (document.body) {
        // characterDataOldValue is needed so considerTextNode can tell a
        // ticker-like text change (a clock/counter) apart from real content.
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
          characterDataOldValue: true,
        });
      }
      window.__penSigObserver = observer;
      // Bound the observer's lifetime: if no "after" ever tears it down (a
      // timed-out command, a final keep-peek) it must not keep processing
      // mutations on a busy page. The state it accumulated stays readable.
      if (window.__penSigTimer) clearTimeout(window.__penSigTimer);
      // args.ttlMs (from the controller) must outlive the command that owns
      // this capture, so its final "after" still sees the whole evidence.
      var sigTtl = typeof args.ttlMs === "number" && args.ttlMs > 0 ? args.ttlMs : 30000;
      window.__penSigTimer = setTimeout(function () {
        try {
          observer.disconnect();
        } catch (e) {}
        if (window.__penSigObserver === observer) window.__penSigObserver = null;
        window.__penSigTimer = null;
      }, sigTtl);
    } catch (e) {
      // No MutationObserver (shouldn't happen in Chromium) — "after" falls
      // back to reporting no dom/text change at all, same as a page that
      // genuinely didn't mutate; every other field is unaffected.
      window.__penSigObserver = null;
    }
  } else {
    var activeObserver = window.__penSigObserver;
    if (activeObserver) {
      try {
        // takeRecords() both returns and flushes whatever the async
        // callback hasn't been scheduled to see yet — combined with
        // whatever the callback already processed (it may have already run
        // by the time this executes), this can't miss a mutation regardless
        // of microtask timing.
        penSigProcessRecords(activeObserver.takeRecords());
        // args.keep: a non-final "after" peek (controller.ts's late-effect
        // re-check) — the observer keeps running so the final capture still
        // sees the whole dom/text evidence, not just what landed after the
        // peek. The next "before" (or a later non-keep "after") tears it down.
        if (!args.keep) activeObserver.disconnect();
      } catch (e) {}
      if (!args.keep) {
        window.__penSigObserver = null;
        if (window.__penSigTimer) clearTimeout(window.__penSigTimer);
        window.__penSigTimer = null;
      }
    }
    textLength = penSigState.textChanged ? 1 : 0;
    hash = penSigState.textChanged ? 1 : 0;
  }

  var mainImageSrc = "";
  if (phase === "before") {
    var bestArea = 0;
    var bestEl = null;
    var imgs = document.images;
    for (var j = 0; j < imgs.length; j++) {
      var img = imgs[j];
      if (!isVisible(img)) continue;
      var rect = img.getBoundingClientRect();
      var area = rect.width * rect.height;
      if (area > bestArea) {
        bestArea = area;
        bestEl = img;
      }
    }
    if (bestEl) {
      bestEl.setAttribute("data-pen-sig-mainimg", "1");
      mainImageSrc = bestEl.currentSrc || bestEl.src || "";
    }
  } else {
    var marked = document.querySelector("[data-pen-sig-mainimg]");
    mainImageSrc = marked ? marked.currentSrc || marked.src || "" : "";
  }

  var activeEl = document.activeElement;
  var focusedValueLength = 0;
  if (activeEl) {
    var activeTag = (activeEl.tagName || "").toLowerCase();
    if (activeTag === "input" || activeTag === "textarea") {
      focusedValueLength = String(activeEl.value || "").length;
    } else if (activeEl.isContentEditable) {
      focusedValueLength = (activeEl.textContent || "").length;
    }
  }

  // A numeric hash of the focused field's value (never the value; skipped for
  // a password field), so a same-length edit still moves the signature.
  var focusedValueHash = 0;
  if (activeEl && String(activeEl.type || "").toLowerCase() !== "password") {
    var activeTag2 = (activeEl.tagName || "").toLowerCase();
    if (activeTag2 === "input" || activeTag2 === "textarea") {
      focusedValueHash = penHashString(String(activeEl.value || ""));
    } else if (activeEl.isContentEditable) {
      focusedValueHash = penHashString(activeEl.textContent || "");
    }
  }

  // controlsHash: one numeric hash over the live state of the visible form
  // controls (value, checked, aria-valuenow / aria-checked / aria-selected).
  // The MutationObserver cannot see a .value or .checked property change, so
  // a stepper that rewrites a sibling input would otherwise look like "no
  // effect". Scoped to the open dialog when there is one, capped, and only a
  // number leaves the page; password fields are skipped.
  var controlsHash = 0;
  try {
    var ctlRoot = document;
    var dlgs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]');
    for (var di = dlgs.length - 1; di >= 0; di--) {
      if (isVisible(dlgs[di])) {
        ctlRoot = dlgs[di];
        break;
      }
    }
    var ctls = ctlRoot.querySelectorAll(
      "input, select, textarea, [role='checkbox'], [role='radio'], [role='switch'], [role='slider'], [role='spinbutton'], [role='option'], [role='tab'], [aria-checked], [aria-selected], [aria-valuenow]"
    );
    var ctlCap = Math.min(ctls.length, 150);
    var ctlKey = "";
    for (var ci = 0; ci < ctlCap; ci++) {
      var ctl = ctls[ci];
      if (String(ctl.type || "").toLowerCase() === "password") continue;
      if (!isVisible(ctl)) continue;
      ctlKey +=
        ci + "|" + ("value" in ctl ? String(ctl.value || "") : "") + "|" + (ctl.checked ? 1 : 0) + "|" +
        (ctl.getAttribute("aria-valuenow") || "") + "|" + (ctl.getAttribute("aria-checked") || "") + "|" +
        (ctl.getAttribute("aria-selected") || "") + ";";
    }
    controlsHash = penHashString(ctlKey);
  } catch (e) {}

  var result = {
    url: location.href,
    title: document.title,
    nodeCount: phase === "after" && penSigState.domChanged ? 1 : 0,
    textLength: textLength,
    textHash: hash,
    mainImageSrc: mainImageSrc,
    scrollY: window.scrollY,
    focusedValueLength: focusedValueLength,
    focusedValueHash: focusedValueHash,
    controlsHash: controlsHash,
    pageChanged: phase === "after" && penSigState.pageChanged,
    appeared: phase === "after" ? penSigState.appeared : [],
  };
  if (phase === "before") result.captureId = penSigCaptureId;

  if (phase === "after") {
    var targetEl = penFindSigTarget();
    result.scopedAfter = targetEl ? scopedSignatureOf(targetEl) : null;
    // Review finding 3: the observer itself is already disconnected above,
    // but the state object it was accumulating into (domChanged/
    // pageChanged/appeared) stayed on \`window\` — if this document is later
    // restored from bfcache (pageshow, no navigation, so nothing re-runs
    // the "before" phase's reset first) whatever read \`window.__penSigState\`
    // at that point would see the previous action's leftover evidence.
    // Clearing it here, once \`result\` has already been built from it, means
    // there's nothing to leak.
    if (!args.keep) window.__penSigState = null;
  }

  return result;
})()`;

/**
 * A readable digest of the current page (jev-loop design doc "Addendum 2,
 * 2026-09-19" §2, `browse_read`): visible text with script/style/noscript/
 * nav chrome stripped and whitespace collapsed, h1-h3 headings in document
 * order, and deduped http(s) links — each capped per the design doc so the
 * payload is bounded by construction, not by trusting the caller.
 * `args.selector`, when given, narrows the whole read to one subtree; when
 * it matches nothing this returns `{ error }` rather than silently reading
 * the whole page.
 *
 * Review finding 9: with a `selector`, `text` already included the root
 * element itself (collectText walks the root's own child nodes), but
 * `headings`/`links` used `root.querySelectorAll(...)`, which only matches
 * *descendants* — so `read({ selector: "h1" })` returned that heading's own
 * text in `text` but an empty `headings` array. `queryIncludingSelf` below
 * makes the two consistent: the root itself is checked against the selector
 * too, not just its descendants.
 *
 * Review finding 8: `truncated` used to reflect only the text cap — the
 * 40-heading and 60-link caps were applied silently, so a page with (say)
 * 500 links reported 60 of them with `truncated: false`, and a consumer had
 * no way to know anything was cut. `headingsTruncated`/`linksTruncated` now
 * report each collection's own truncation alongside the existing
 * (text-only) `truncated` field.
 */
/**
 * The pure motion planner behind CURSOR_JS (cua-derived, MIT): constants,
 * easing/profile/path math, `planMove`, `sampleAt`, `velocityAt`. No DOM, no
 * `args`. CURSOR_JS embeds it the way it embeds FIND_BY_TEXT_JS, and
 * test/cursorMotion.test.ts evaluates this fragment directly. Only
 * `window.__penCursorBowSign` (classic's bow alternation) is touched.
 */
export const CURSOR_PLAN_JS = `
  var DT_MS = 1000 / 120; // cua DT_MS: planning sample step
  var DEFAULT_TARGET_PT = 24; // cua DEFAULT_TARGET_PT: box assumed for a bare point
  var ARRIVAL_TOLERANCE = 1; // cua ARRIVAL_TOLERANCE_PT
  var REDUCED_MOTION_MS = 120; // cua REDUCED_MOTION_MS
  // Hard cap on the ARRIVAL moment. The 1150ms backstop below must never win
  // in a visible tab: two rAFs for scrollIntoView come before the move. 700ms
  // keeps the agent's per-action latency low.
  var ARRIVAL_CAP_MS = 700;

  // Heading rotation (cua trajectory.rs finish() / motion-lab applyHeading, MIT).
  // The arrow art rests with its tip up-left: TIP_ANGLE in screen space (y down).
  var TIP_ANGLE = -0.75 * Math.PI;
  var HEADING_RATE = 22; // 1/s: rot relaxes toward the wanted angle with k = 1 - exp(-dt * rate)
  var SETTLE_MAX_SAMPLES = 36;
  var SETTLE_EPS = 0.002; // rad
  // The arrow's hotspot inside its 22x26 viewBox: the point that lands on the
  // planned target, and the pivot of every rotation/scale. The polygon is
  // offset from here by half the stroke along the tip bisector, so the
  // visible tip sits within ~1px of it.
  var ARROW_PIVOT = { x: 0, y: 0 };
  var ARROW_POINTS = "2.2,1.6 17.6,8.5 10.8,12.4 6.2,17.7";
  // cua motion.rs default_effects, per style. rotates: the tip turns toward the
  // direction of travel (cua heading Tangent); false = fixed, never chases a heading.
  // Every style is fixed on purpose: the turning arrow read as distracting, the
  // user wants plain movement. Flip a style back to true to re-enable it.
  var STYLE_EFFECTS = {
    signature_arc: { trail: false, glow: true, magnet: false, ripple: true, squish: true, rotates: false },
    spring_settle: { trail: false, glow: true, magnet: false, ripple: false, squish: true, rotates: false },
    magnetic: { trail: false, glow: false, magnet: true, ripple: true, squish: false, rotates: false },
    comet_swoop: { trail: true, glow: false, magnet: false, ripple: true, squish: false, rotates: false },
    classic: { trail: false, glow: false, magnet: false, ripple: true, squish: true, rotates: false }
  };
  var NO_EFFECTS = { trail: false, glow: false, magnet: false, ripple: false, squish: false, rotates: false };

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  // Maps an angle into (-PI, PI].
  function wrapAngle(a) {
    var tau = 2 * Math.PI;
    var r = a - tau * Math.floor((a + Math.PI) / tau);
    return r === -Math.PI ? Math.PI : r;
  }

  // The one transform the arrow SVG gets: rotation then press squish, both
  // about ARROW_PIVOT (set as transform-origin), so the hotspot never moves.
  function arrowTransform(rot, scale) {
    return "rotate(" + rot + "rad) scale(" + scale + ")";
  }

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }
  function minJerk(t) {
    return t * t * t * (10 - 15 * t + 6 * t * t);
  }
  function smootherstep(t) {
    return t * t * t * (t * (6 * t - 15) + 10);
  }
  function easeOut(k) {
    return 1 - Math.pow(1 - k, 3);
  }
  function dist(a, b) {
    return Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));
  }
  function unitVec(a, b) {
    var d = dist(a, b);
    if (d === 0) d = 1;
    return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
  }

  // bump_profile: base plus a smooth bump; over pushes past the end late and
  // settles back. Fractions of the distance.
  function bumpProfile(base, over, overAt) {
    function bump(tau, at) {
      var a = Math.max(at * 10, 1.5);
      var b = Math.max((1 - at) * 10, 1.5);
      var peak = Math.pow(a / (a + b), a) * Math.pow(b / (a + b), b);
      return (Math.pow(tau, a) * Math.pow(1 - tau, b)) / peak;
    }
    return function (tau) {
      return base(tau) + over * bump(tau, overAt);
    };
  }

  // wobble_profile: damped wobble around the end from "start" on.
  function wobbleProfile(base, amp, cycles, decay, start) {
    return function (tau) {
      if (tau <= start) return base(tau);
      var u = (tau - start) / (1 - start);
      var ramp = smootherstep(Math.min(u / 0.18, 1));
      var norm = Math.max(Math.exp(-decay * 0.12) * 0.77, 1e-6);
      return (
        base(tau) +
        (amp * ramp * Math.exp(-decay * u) * Math.sin(2 * Math.PI * cycles * u) * Math.pow(1 - u, 2)) / norm
      );
    };
  }

  // A parametric path with an arc-length table, so profiles act on distance.
  // at(frac) extrapolates along the end tangents outside [0, 1].
  function makePath(f, n) {
    var us = [0];
    var ss = [0];
    var prev = f(0);
    var total = 0;
    for (var i = 1; i <= n; i++) {
      var u = i / n;
      var p = f(u);
      total += Math.sqrt((p.x - prev.x) * (p.x - prev.x) + (p.y - prev.y) * (p.y - prev.y));
      us.push(u);
      ss.push(total);
      prev = p;
    }
    var p0 = f(0);
    var p1 = f(1);
    var t0 = unitVec(f(1e-3), p0);
    var t1 = unitVec(f(1 - 1e-3), p1);
    return {
      length: total,
      at: function (frac) {
        if (total < 1e-9) return f(clamp(frac, 0, 1));
        if (frac > 1) return { x: p1.x + t1.x * (frac - 1) * total, y: p1.y + t1.y * (frac - 1) * total };
        if (frac < 0) return { x: p0.x + t0.x * -frac * total, y: p0.y + t0.y * -frac * total };
        var target = frac * total;
        var lo = 0;
        var hi = ss.length - 1;
        while (hi - lo > 1) {
          var mid = (lo + hi) >> 1;
          if (ss[mid] < target) lo = mid;
          else hi = mid;
        }
        var span = ss[hi] - ss[lo];
        if (span === 0) span = 1;
        return f(us[lo] + (us[hi] - us[lo]) * ((target - ss[lo]) / span));
      }
    };
  }

  // The cua bezier (bezier.rs build_motion_bezier) as a path.
  function cuaPath(a, b, shape) {
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    var len = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
    var px = -dy / len;
    var py = dx / len;
    var deflection = len * shape.arcSize;
    var flow = (shape.arcFlow + 1) / 2;
    var c1d = deflection * (1 - 0.5 * flow);
    var c2d = deflection * (1 - 0.5 * (1 - flow));
    var c1 = { x: a.x + dx * shape.startHandle + px * c1d, y: a.y + dy * shape.startHandle + py * c1d };
    var c2 = { x: b.x - dx * shape.endHandle + px * c2d, y: b.y - dy * shape.endHandle + py * c2d };
    return makePath(function (u) {
      var v = 1 - u;
      var w0 = v * v * v;
      var w1 = 3 * v * v * u;
      var w2 = 3 * v * u * u;
      var w3 = u * u * u;
      return {
        x: w0 * a.x + w1 * c1.x + w2 * c2.x + w3 * b.x,
        y: w0 * a.y + w1 * c1.y + w2 * c2.y + w3 * b.y
      };
    }, 256);
  }

  // Gentle single-sided quadratic curve (paths.bow).
  function bowPath(a, b, amount) {
    var d = dist(a, b);
    var un = unitVec(a, b);
    var nx = -un.y;
    var ny = un.x;
    var c = { x: (a.x + b.x) / 2 + nx * amount * d, y: (a.y + b.y) / 2 + ny * amount * d };
    return makePath(function (u) {
      var v = 1 - u;
      return {
        x: v * v * a.x + 2 * v * u * c.x + u * u * b.x,
        y: v * v * a.y + 2 * v * u * c.y + u * u * b.y
      };
    }, 256);
  }

  // Chord side that bends paths upward for horizontal moves (naturalSide).
  function naturalSide(a, b) {
    return unitVec(a, b).x >= 0 ? -1 : 1;
  }

  // Samples: [{ t (ms from move start), x, y }].
  function sampleTimed(pos, durationMs) {
    var n = Math.max(Math.ceil(durationMs / DT_MS), 2);
    var out = [];
    for (var i = 0; i <= n; i++) {
      var tau = i / n;
      var p = pos(tau);
      out.push({ t: tau * durationMs, x: p.x, y: p.y });
    }
    return out;
  }
  function pinEnds(samples, from, aim) {
    samples[0].x = from.x;
    samples[0].y = from.y;
    samples[samples.length - 1].x = aim.x;
    samples[samples.length - 1].y = aim.y;
    return samples;
  }
  function glide(from, aim, path, profile, durationMs) {
    return pinEnds(
      sampleTimed(function (tau) {
        return path.at(profile(tau));
      }, durationMs),
      from,
      aim
    );
  }

  // Director's-cut duration (dc_ms): Fitts-aware, small targets slower.
  function dcMs(d, w, scale) {
    return clamp(150 + 120 * Math.log(d / w + 1) / Math.LN2, 300, 1000) * scale;
  }

  // magnetic(): bow 0.04, capture radius min(40, len/2), pull 0.45, enter
  // speed 300. Returns the samples and the lock-on time in ms.
  function magneticSamples(from, aim) {
    var path = bowPath(from, aim, 0.04 * naturalSide(from, aim));
    var len = path.length;
    var radius = Math.min(40, len * 0.5);
    var pull = 0.45;
    var enterSpeed = 300;
    var out = [{ t: 0, x: from.x, y: from.y }];
    var s = 0;
    var v = 0;
    var t = 0;
    var snapT = null;
    var dt = DT_MS / 1000;
    while (s < len && t < 4) {
      var rem = len - s;
      if (rem > radius) {
        v = Math.min(1500, v + 7000 * dt, enterSpeed + 5.5 * (rem - radius));
      } else {
        if (snapT === null) snapT = t * 1000;
        v += 26000 * pull * (radius / Math.max(rem, 6)) * dt;
      }
      s = Math.min(len, s + v * dt);
      t += dt;
      var q = path.at(s / len);
      out.push({ t: t * 1000, x: q.x, y: q.y });
    }
    if (out.length < 2) out.push({ t: DT_MS, x: aim.x, y: aim.y });
    return { samples: pinEnds(out, from, aim), snapT: snapT === null ? t * 1000 : snapT };
  }

  // The old behaviour, kept as the escape hatch: bowed quadratic, eased with
  // easeInOutCubic, a tiny overshoot corrected a frame later.
  function classicSamples(from, aim, d) {
    var duration = Math.min(900, Math.max(260, 90 + d * 0.7));
    var dx = aim.x - from.x;
    var dy = aim.y - from.y;
    var dd = d || 0.0001;
    window.__penCursorBowSign = -(window.__penCursorBowSign || -1);
    var bow = dd * (0.08 + Math.random() * 0.04) * window.__penCursorBowSign;
    var midX = (from.x + aim.x) / 2 - (dy / dd) * bow;
    var midY = (from.y + aim.y) / 2 + (dx / dd) * bow;
    var over = Math.min(6, dd * 0.03);
    var out = sampleTimed(function (tau) {
      var e = easeInOutCubic(tau);
      var m = 1 - e;
      return {
        x: m * m * from.x + 2 * m * e * midX + e * e * aim.x,
        y: m * m * from.y + 2 * m * e * midY + e * e * aim.y
      };
    }, duration);
    pinEnds(out, from, aim);
    out.push({ t: duration + 8, x: aim.x + (dx / dd) * over, y: aim.y + (dy / dd) * over });
    out.push({ t: duration + 25, x: aim.x, y: aim.y });
    return out;
  }

  function arrivalIndex(samples, to) {
    for (var i = 0; i < samples.length; i++) {
      if (dist(samples[i], to) <= ARRIVAL_TOLERANCE) return i;
    }
    return samples.length - 1;
  }

  function retime(samples, k) {
    for (var i = 0; i < samples.length; i++) samples[i].t *= k;
  }

  // Heading rotation, per sample (velocity from a +-2-sample window): above
  // 40 px/s rot chases the travel heading along the SHORTEST arc,
  //   target = wrapAngle(atan2(vy, vx) - TIP_ANGLE)
  //   rot    = wrapAngle(rot + wrapAngle(target - rot) * k),  k = 1 - exp(-dt * 22)
  // and below it rot is held. rot is always in (-PI, PI]. rot0 is where the
  // previous move left off (only a move that had already ARRIVED hands one
  // over: a mid-flight cancel snaps rot to 0), so a follow-up never snaps.
  // DELIBERATE DIFFERENCE from cua: its speed-ramp formula flips at
  // TIP_ANGLE + PI and spins on carried headings. After the last sample a
  // settle tail eases rot home along the shortest arc (<= a half-turn) at
  // DT_MS steps, only if rot has not reached 0 by the last sample; it only
  // extends playback AFTER arrival. Styles with rotates:false never chase a
  // heading: a carried rot0 just eases toward 0 during the move.
  function applyHeading(samples, rotates, rot0, arrivalT) {
    var n = samples.length;
    var rot = wrapAngle(rot0 || 0);
    for (var i = 0; i < n; i++) {
      var step = i > 0 ? (samples[i].t - samples[i - 1].t) / 1000 : 0;
      var kStep = 1 - Math.exp(-step * HEADING_RATE);
      if (!rotates) {
        // Fixed style: no heading, so a carried rot just eases toward 0
        // during the move (same shortest-arc chase, target 0).
        rot = wrapAngle(rot + wrapAngle(0 - rot) * kStep);
      } else if (samples[i].t <= arrivalT) {
        // The chase stops at arrival: the late overshoot/settle wobble must
        // not swing the arrow around; from there rot is held until the tail.
        var a = samples[Math.max(0, i - 2)];
        var b = samples[Math.min(n - 1, i + 2)];
        var dt = Math.max(1e-3, (b.t - a.t) / 1000);
        var vx = (b.x - a.x) / dt;
        var vy = (b.y - a.y) / dt;
        if (Math.sqrt(vx * vx + vy * vy) > 40) {
          var target = wrapAngle(Math.atan2(vy, vx) - TIP_ANGLE);
          rot = wrapAngle(rot + wrapAngle(target - rot) * kStep);
        }
      }
      samples[i].rot = rot;
    }
    var end = samples[n - 1];
    var k = 1 - Math.exp(-(DT_MS / 1000) * HEADING_RATE);
    var added = 0;
    while (Math.abs(rot) >= SETTLE_EPS && added < SETTLE_MAX_SAMPLES) {
      rot = wrapAngle(rot + wrapAngle(0 - rot) * k);
      added++;
      samples.push({ t: end.t + added * DT_MS, x: end.x, y: end.y, rot: rot });
    }
    samples[samples.length - 1].rot = 0;
  }

  // Plans the whole move. opts: { style, from, to, w (target box smaller
  // side, or null for a bare point), reduce }.
  function planMove(opts) {
    var from = opts.from;
    var to = opts.to;
    var d = dist(from, to);
    var w = Math.max(4, opts.w === null || opts.w === undefined ? DEFAULT_TARGET_PT : opts.w);
    var style = Object.prototype.hasOwnProperty.call(STYLE_EFFECTS, opts.style) ? opts.style : "signature_arc";
    var samples;
    var snapT = null;
    var effects = STYLE_EFFECTS[style];
    var side = naturalSide(from, to);
    var big = Math.max(d, 1);

    if (opts.reduce) {
      // cua REDUCED_MOTION_MS: a short straight glide, no effects.
      var line = makePath(function (u) {
        return { x: from.x + (to.x - from.x) * u, y: from.y + (to.y - from.y) * u };
      }, 8);
      samples = glide(from, to, line, minJerk, REDUCED_MOTION_MS);
      effects = NO_EFFECTS;
    } else if (style === "classic") {
      samples = classicSamples(from, to, d);
    } else if (style === "magnetic") {
      var mag = magneticSamples(from, to);
      samples = mag.samples;
      snapT = mag.snapT;
    } else if (style === "spring_settle") {
      var spPath = cuaPath(from, to, { startHandle: 0.3, endHandle: 0.3, arcSize: 0.12 * side, arcFlow: 0 });
      var amp = Math.min(0.05, 6 / big);
      var spProfile = wobbleProfile(
        function (t) {
          return minJerk(Math.min(t / 0.68, 1));
        },
        amp,
        1.3,
        2.6,
        0.55
      );
      samples = glide(from, to, spPath, spProfile, dcMs(d, w, 1.35));
    } else if (style === "comet_swoop") {
      var coPath = cuaPath(from, to, { startHandle: 0.3, endHandle: 0.3, arcSize: 0.24 * side, arcFlow: 0.2 });
      samples = glide(from, to, coPath, easeInOutCubic, dcMs(d, w, 1.15));
    } else {
      var sgPath = cuaPath(from, to, { startHandle: 0.3, endHandle: 0.3, arcSize: 0.16 * side, arcFlow: 0.15 });
      var over = Math.min(0.018, 8 / big);
      samples = glide(from, to, sgPath, bumpProfile(minJerk, over, 0.82), dcMs(d, w, 1.1));
    }

    var arrivalT = samples[arrivalIndex(samples, to)].t;
    if (arrivalT > ARRIVAL_CAP_MS) {
      var k = ARRIVAL_CAP_MS / arrivalT;
      retime(samples, k);
      if (snapT !== null) snapT *= k;
      arrivalT = ARRIVAL_CAP_MS;
    }
    // End of the motion proper (before the rotation settle tail): trail/glow
    // lifetimes key off this, not off the tail.
    var motionEndMs = samples[samples.length - 1].t;
    // Reduced motion never rotates: a carried rot snaps to 0, no tail.
    applyHeading(samples, effects.rotates, opts.reduce ? 0 : opts.rot0, arrivalT);
    return {
      style: style,
      samples: samples,
      snapT: snapT,
      arrivalT: arrivalT,
      motionEndMs: motionEndMs,
      effects: effects
    };
  }

  // Interpolated hotspot at time t (ms), clamped to the sample range.
  function sampleAt(samples, t) {
    var last = samples.length - 1;
    if (t <= samples[0].t) return samples[0];
    if (t >= samples[last].t) return samples[last];
    var lo = 0;
    var hi = last;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (samples[mid].t <= t) lo = mid;
      else hi = mid;
    }
    var a = samples[lo];
    var b = samples[hi];
    var span = b.t - a.t || 1;
    var f = (t - a.t) / span;
    return {
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      rot: wrapAngle(a.rot + wrapAngle(b.rot - a.rot) * f)
    };
  }
  function velocityAt(samples, t) {
    var a = sampleAt(samples, t - 12);
    var b = sampleAt(samples, t + 12);
    return { x: (b.x - a.x) / 0.024, y: (b.y - a.y) / 0.024 };
  }
`;

/**
 * Drives the visible, human-like cursor overlay for the built-in browser tab
 * (design: a human-watched agent that clicks/types instantly and invisibly
 * looks broken even when it's working correctly). Unlike every other script
 * in this file, its value is a **Promise** — Electron's `executeJavaScript`
 * awaits whatever the injected expression evaluates to, and the whole point
 * here is an animation that spans several `requestAnimationFrame` ticks, not
 * a synchronous computation.
 *
 * `controller.ts`'s `moveCursor` runs this **before** the before-action
 * `captureSignature` call in every call site that acts on the page (click,
 * type, scroll, perform's CLICK/TYPE_TEXT/SELECT/SCROLL_UP/SCROLL_DOWN) —
 * deliberately, not incidentally: the overlay's own DOM insertion and the
 * `scrollIntoView` this script performs while locating the target are both
 * observable page mutations, and "Addendum 2"'s evidence-of-effect feature
 * (SIGNATURE_JS, `diffSignatures`) exists specifically to tell the agent
 * whether *its* action changed the page. Running the cursor between the two
 * signature captures would fold the cursor's own DOM/scroll footprint into
 * that diff and manufacture false "changed: true" evidence for actions that
 * didn't actually do anything. Running it before "before" keeps it invisible
 * to that mechanism.
 *
 * `pointer-events:none` on the overlay root — and every element inside it —
 * is a hard invariant, not a style choice: this overlay sits on top of the
 * real page content at `z-index:2147483647`, and if it ever became
 * click-through-blocking it would silently break every subsequent
 * click/type this bridge performs (its own and the user's, since a browser
 * tab has no preload to route around it).
 *
 * Motion: the move is planned once as timed samples (120 Hz) and every
 * animation frame interpolates by elapsed time, so it is frame-rate
 * independent. `args.style` picks signature_arc (default), spring_settle,
 * comet_swoop, magnetic or classic; the math is derived from trycua/cua's
 * cursor-overlay trajectory.rs (MIT). The Promise resolves at *arrival* (the
 * first sample within 1px of the target, capped at 700ms), while the
 * follow-through, ripple and press squish keep animating; a new call cancels
 * the previous animation and starts from its final point.
 *
 * Never throws and always settles quickly: every code path is wrapped so a
 * failure resolves `{ error }` rather than rejecting, and a `finish()` guard
 * plus a hard backstop timer (~1.15s, comfortably under this repo's other
 * short page-script budgets) mean the promise always settles even if
 * `requestAnimationFrame` never fires again — which upstream findings in
 * this same repo (see get_screenshot's rAF-in-a-background-tab gotcha) show
 * does happen. The backstop is disarmed *only* inside `finish()` itself,
 * never by a caller ahead of time, so it stays live and able to win that
 * race for every settle path, not just the early-return ones. `moveCursor` on the controller side wraps this in its own,
 * slightly longer timeout and swallows every failure besides — the cursor
 * must never turn a working browser command into an error or a timeout.
 */
export const CURSOR_JS = `(() => {
  // Motion engine derived from trycua/cua cursor-overlay trajectory.rs, MIT
  // (https://github.com/trycua/cua): the whole move is planned once as timed
  // samples (120 Hz), then every animation frame interpolates by elapsed time.
  var args = ${ARGS_MARKER};
  var CURSOR_VERSION = "6";

  ${FIND_BY_TEXT_JS}

  var TRAIL_MS = 240;
  var RIPPLE_MS = 380;
  var MAGNET_MS = 700;
  var PRESS_HOLD_MS = 90;
  var PRESS_IN_MS = 50;
  var PRESS_OUT_MS = 220;

  ${CURSOR_PLAN_JS}

  // Idempotent install, guarded by a version string so a reload of this
  // script (a code change while the tab stays open) replaces a stale
  // overlay instead of leaving two stacked on top of each other.
  // Every element lives under the [data-pen-cursor] root, which is what
  // SNAPSHOT_JS/FIND_IMAGES_JS skip, and every one is pointer-events:none.
  function ensureOverlay() {
    var existing = window.__penCursor;
    if (existing && existing.version === CURSOR_VERSION && existing.root && existing.root.isConnected) {
      return existing;
    }
    var priorPos = existing && existing.pos ? existing.pos : null;
    if (existing) {
      try {
        cancelAnim(existing);
      } catch (err) {
        // ignore — a stale overlay from an older version
      }
    }
    if (existing && existing.root && existing.root.parentNode) {
      existing.root.parentNode.removeChild(existing.root);
    }

    var root = document.createElement("div");
    root.setAttribute("data-pen-cursor", "1");
    root.style.cssText =
      "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;" +
      "pointer-events:none;";

    // Magnet: outline of the target rect when magnetic locks on.
    var magnet = document.createElement("div");
    magnet.setAttribute("data-pen-cursor-magnet", "1");
    magnet.style.cssText =
      "position:absolute;left:0;top:0;box-sizing:border-box;border-radius:16px;" +
      "border:4px solid rgba(159,215,255,.9);box-shadow:0 0 40px rgba(13,153,255,.8);" +
      "pointer-events:none;opacity:0;z-index:2147483647;";
    root.appendChild(magnet);

    // Glow: a soft radial fog behind the arrow (100px, scaled per frame).
    var glow = document.createElement("div");
    glow.setAttribute("data-pen-cursor-glow", "1");
    glow.style.cssText =
      "position:absolute;left:-50px;top:-50px;width:100px;height:100px;border-radius:50%;" +
      "background:radial-gradient(circle closest-side,rgba(94,192,232,1),rgba(94,192,232,0));" +
      "pointer-events:none;opacity:0;z-index:2147483647;";
    root.appendChild(glow);

    // Ripple ring: the pre-engine click pulse — a thin white ring with a faint
    // dark outline, scaled per frame (0.4 -> 1.6, opacity .9 -> 0). The bright
    // blue cua ring read as too loud on real pages.
    var ring = document.createElement("div");
    ring.setAttribute("data-pen-cursor-ring", "1");
    ring.style.cssText =
      "position:absolute;left:0;top:0;width:24px;height:24px;margin-left:-12px;margin-top:-12px;" +
      "box-sizing:border-box;border-radius:50%;border:2px solid rgba(255,255,255,.9);" +
      "box-shadow:0 0 0 1px rgba(0,0,0,.35);pointer-events:none;opacity:0;" +
      "z-index:2147483647;";
    root.appendChild(ring);

    // The arrow rides in its own translated carrier.
    var carrier = document.createElement("div");
    carrier.setAttribute("data-pen-cursor-carrier", "1");
    carrier.style.cssText =
      "position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;will-change:transform;z-index:2147483647;" +
      // The shadow lives on the NON-rotating carrier so it always falls downward.
      "filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));";

    var svgNS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("width", "22");
    svg.setAttribute("height", "26");
    svg.setAttribute("viewBox", "0 0 22 26");
    svg.setAttribute("data-pen-cursor-arrow", "1");
    svg.style.cssText =
      "position:absolute;left:0;top:0;overflow:visible;pointer-events:none;" +
      "transform-origin:" + ARROW_PIVOT.x + "px " + ARROW_PIVOT.y + "px;";
    // The visual reference is NOT the thin-tailed macOS pointer: it is a
    // wide, heavily rounded arrow — tip up-left, a long edge out to the
    // right, and a concave notch pulling back in before the bottom point.
    // Four points describe it (tip, right, notch, bottom) and the rounding
    // comes entirely from stroking each polygon in its own fill colour with
    // stroke-linejoin:round, which fattens the silhouette outward and
    // rounds every corner — a plain fill would give hard corners.
    //
    // Two stacked copies: a wider white one underneath is the rim that
    // keeps the cursor readable on dark pages, the accent-blue one on top
    // is the arrow itself. The colour is pen-editor's own UI accent
    // (--color-accent-primary in its src/index.css) written out as a
    // literal —
    // the overlay lives in an arbitrary third-party page, which has no
    // access to the editor's custom properties.
    //
    // The stroke widths below are also what sets how round the corners
    // read, so the points are pulled in from the reference's own geometry
    // to keep the silhouette the same size as the stroke fattens it, and
    // offset from (0,0) by half the stroke along the tip's bisector — the
    // rounded tip bulges outward past the corner it rounds, so an
    // unoffset polygon would land its visible point a few px beyond the
    // target rather than on it.
    function arrowPolygon(colour, strokeWidth) {
      var poly = document.createElementNS(svgNS, "polygon");
      poly.setAttribute("points", ARROW_POINTS);
      poly.setAttribute("fill", colour);
      poly.setAttribute("stroke", colour);
      poly.setAttribute("stroke-width", String(strokeWidth));
      poly.setAttribute("stroke-linejoin", "round");
      poly.setAttribute("stroke-linecap", "round");
      poly.style.pointerEvents = "none";
      return poly;
    }
    svg.appendChild(arrowPolygon("#fff", 7.8));
    svg.appendChild(arrowPolygon("#0d99ff", 5.4));
    carrier.appendChild(svg);
    root.appendChild(carrier);

    (document.documentElement || document.body).appendChild(root);

    var state = {
      version: CURSOR_VERSION,
      root: root,
      carrier: carrier,
      svg: svg,
      ring: ring,
      glow: glow,
      magnet: magnet,
      canvas: null,
      pos: priorPos,
      hideTimer: null,
      token: 0,
      raf: 0,
      abort: null,
      rot: 0,
      glowOn: false
    };
    window.__penCursor = state;
    return state;
  }

  // Stops a still-running animation (a previous move's follow-through, or
  // a call still waiting on its scroll frames): bumps the token so every
  // pending callback of that call bails out, cancels its rAF, and settles
  // its Promise if it is still pending.
  function cancelAnim(state) {
    state.token = (state.token || 0) + 1;
    if (state.raf) {
      try {
        cancelAnimationFrame(state.raf);
      } catch (err) {
        // ignore
      }
      state.raf = 0;
    }
    var ab = state.abort;
    state.abort = null;
    if (typeof ab === "function") ab();
  }

  // Idle auto-hide: every call re-shows the overlay and (re)arms an 8s
  // fade-out, so it reads as "visible while the agent is working" rather
  // than a permanent fixture.
  function show(state) {
    state.root.style.transition = "opacity 400ms";
    state.root.style.opacity = "1";
    // A screenshot hides the root with visibility:hidden; if its restore
    // call failed, the next move must make the cursor visible again.
    state.root.style.visibility = "";
    if (state.hideTimer) clearTimeout(state.hideTimer);
    state.hideTimer = setTimeout(function () {
      state.root.style.opacity = "0";
    }, 8000);
  }

  function drawGlow(state, x, y, vx, vy) {
    var speed = Math.sqrt(vx * vx + vy * vy);
    var off = Math.min(18, speed * 0.009);
    var ux = speed > 1 ? vx / speed : 0;
    var uy = speed > 1 ? vy / speed : 0;
    var r = 34 * (1 + Math.min(0.44, speed * 0.00024));
    // cua's alpha is min(0.5, 0.12 + speed * 0.00012); the 0.12 floor is
    // ramped in by speed so the glow fades to ZERO at rest instead of
    // lingering around a parked cursor.
    var a = Math.min(0.5, 0.12 + speed * 0.00012) * clamp(speed / 60, 0, 1);
    var gx = x + 8 - ux * off;
    var gy = y + 11 - uy * off;
    state.glow.style.transform = "translate3d(" + gx + "px," + gy + "px,0) scale(" + r / 50 + ")";
    state.glow.style.opacity = String(a);
  }

  // Moves the arrow carrier. The glow follows only at rest here; during a
  // move the frame loop positions it with the velocity offset.
  function place(state, x, y) {
    state.carrier.style.transform = "translate3d(" + x + "px," + y + "px,0)";
    state.pos = { x: x, y: y };
    if (state.glowOn) drawGlow(state, x, y, 0, 0);
  }

  function resolveTarget() {
    if (args.snapshotId !== undefined && args.snapshotId !== null && args.index !== undefined && args.index !== null) {
      return document.querySelector('[data-pen-snap="' + args.snapshotId + ":" + args.index + '"]');
    }
    if (typeof args.target === "string" && args.target.trim() !== "") {
      function findBySelector(sel) {
        try {
          return document.querySelector(sel);
        } catch (err) {
          return null;
        }
      }
      // Item 3: findByText now returns { el, hidden } (a truthy object even
      // when el is null), not a bare element — the cursor overlay just wants
      // wherever the action will actually land, hidden or not (it's cosmetic
      // guidance, not the thing deciding whether the action itself proceeds
      // — that refusal happens in CLICK_JS/TYPE_JS/CLICK_RESOLVE_JS/
      // LOCATE_TARGET_JS), so a hidden match is still an acceptable point to
      // aim at here.
      var textMatch = findByText(args.target);
      return (textMatch && textMatch.el) || findBySelector(args.target);
    }
    return null;
  }

  // Trail: anchored at the arrow's BODY, not its tip — the arrow is painted
  // after the trail, so the body covers the start and the tip stays clean.
  // The offset follows velocity, ramped in by speed (clamp((speed-40)/260)).
  var TRAIL_BACK_PX = 10; // roughly the distance from the tip to the arrow body's centre
  function drawTrail(state, samples, tEl) {
    var canvas = state.canvas;
    if (!canvas) {
      // Created lazily, only for a style that draws a trail: ONE canvas,
      // behind everything else in the overlay root.
      canvas = document.createElement("canvas");
      canvas.setAttribute("data-pen-cursor-trail", "1");
      canvas.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:2147483647;";
      state.root.insertBefore(canvas, state.root.firstChild);
      state.canvas = canvas;
    }
    var dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    var w = window.innerWidth;
    var h = window.innerHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
    }
    var g = canvas.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    var total = samples[samples.length - 1].t;
    var steps = 26;
    var pts = [];
    var len = 0;
    for (var i = 0; i <= steps; i++) {
      var tt = clamp(tEl - TRAIL_MS + (TRAIL_MS * i) / steps, 0, total);
      var q = sampleAt(samples, tt);
      var v = velocityAt(samples, tt);
      var sp = Math.sqrt(v.x * v.x + v.y * v.y);
      var wgt = clamp((sp - 40) / 260, 0, 1);
      var p =
        sp > 1
          ? { x: q.x - (v.x / sp) * TRAIL_BACK_PX * wgt, y: q.y - (v.y / sp) * TRAIL_BACK_PX * wgt }
          : { x: q.x, y: q.y };
      if (i) len += dist(p, pts[i - 1]);
      pts.push(p);
    }
    var fade = Math.min(1, len / 60); // a very short trail (start, landing) fades out
    if (fade <= 0) return;
    g.lineCap = "round";
    var prev = pts[0];
    for (var j = 1; j <= steps; j++) {
      var cur = pts[j];
      var k = j / steps;
      if (dist(prev, cur) > 0.3) {
        g.strokeStyle = "rgba(159,215,255," + 0.45 * k * k * fade + ")";
        g.lineWidth = 1.5 + 8 * k;
        g.beginPath();
        g.moveTo(prev.x, prev.y);
        g.lineTo(cur.x, cur.y);
        g.stroke();
      }
      prev = cur;
    }
  }

  // Frees the backing store: a zero-sized canvas holds no pixel buffer.
  function clearTrail(state) {
    var c = state.canvas;
    if (!c) return;
    c.width = 0;
    c.height = 0;
  }

  return new Promise(function (resolve) {
    var settled = false;
    // finish() is the ONLY place the backstop is cleared (idempotent via
    // the settled flag) — every settle path must go through here rather
    // than clearing the backstop itself ahead of time, so the backstop
    // stays armed, and able to win the race, until something has genuinely
    // settled. A hidden/throttled renderer clamps background timers to a
    // 1s-plus floor and stops requestAnimationFrame entirely, so nothing
    // else bounds the Promise.
    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(backstop);
      var st = window.__penCursor;
      if (st && st.abort === abortMe) st.abort = null;
      resolve(value);
    }
    // Hard backstop: requestAnimationFrame can simply stop firing (a
    // backgrounded tab, per this repo's get_screenshot rAF findings), and
    // this script must settle regardless — "at most ~1.2s" from the design,
    // kept a little under that so moveCursor's own (longer) timeout on the
    // controller side is never the thing that actually fires. Arrival is
    // capped at 700ms, so in a visible tab this never wins.
    var backstop = setTimeout(function () {
      settleAtTarget(true);
    }, 1150);
    function abortMe() {
      settleAtTarget(false);
    }
    // The backstop and a cancel both settle at the move's planned FINAL
    // target (snapping the overlay there), never at a mid-path point, so the
    // controller's next move and state.pos agree with where the action lands.
    // Before the target is planned (still waiting on scroll frames) the
    // current position is all there is. The backstop (stopCurrent = true) also
    // cancels the pending animation first, so a throttled or hidden tab can
    // not replay the stale move when it becomes visible again; a cancel
    // (cancelAnim already bumped the token and cancelled the rAF) needs not.
    var plannedTarget = null;
    // Every settle/error path must leave the arrow un-rotated.
    function resetRot() {
      var st = window.__penCursor;
      if (!st) return;
      try {
        st.rot = 0;
        st.svg.style.transform = arrowTransform(0, 1);
      } catch (err) {
        // cosmetic only
      }
    }
    function settleAtTarget(stopCurrent) {
      if (settled) return;
      var st = window.__penCursor;
      if (st && stopCurrent) {
        if (st.abort === abortMe) st.abort = null;
        cancelAnim(st);
      }
      var pos = plannedTarget || (st && st.pos ? st.pos : { x: 0, y: 0 });
      resetRot();
      if (plannedTarget && st) {
        try {
          place(st, pos.x, pos.y);
        } catch (err) {
          // cosmetic only
        }
      }
      finish({ moved: false, x: pos.x, y: pos.y });
    }

    // True once THIS call has cancelled the previous animation and taken
    // over; only then may the outer catch reset the arrow.
    var owns = false;
    // Never throws: a failed lookup just means "no target".
    function safeResolveTarget() {
      try {
        return resolveTarget();
      } catch (err) {
        return null;
      }
    }

    try {
      var state = ensureOverlay();
      show(state);

      var reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

      // Where the cursor rests right now. Re-read after a cancel: cancelling
      // an in-flight move snaps state.pos to ITS target.
      var startX, startY;
      function readStart() {
        if (state.pos) {
          startX = state.pos.x;
          startY = state.pos.y;
        } else if (args.from && typeof args.from.x === "number" && typeof args.from.y === "number") {
          startX = args.from.x;
          startY = args.from.y;
        } else {
          startX = window.innerWidth * 0.12;
          startY = window.innerHeight * 0.85;
        }
      }
      readStart();

      // Wave 3 reliability, item 2: an explicit top-level-viewport point,
      // used for an element routed to a child frame — the cursor overlay
      // lives in the top document, so it can't resolve/scroll to an
      // element that lives inside a frame's own document at all. The
      // controller computes this point itself (the matched iframe's own
      // content-box offset plus the element's local center, best effort —
      // see resolveVisibleFrames/moveCursor's doc comments) and passes it
      // as args.point instead of target/snapshotId+index.
      var hasPoint = !!(args.point && typeof args.point.x === "number" && typeof args.point.y === "number");
      var el = null;
      // Calls that will not move the cursor (scroll, unresolvable target):
      // a previous move that has ALREADY ARRIVED (state.abort is null; only its
      // settle tail is playing) is left to ease home on its own. One that has
      // not arrived yet is cancelled as always (snapped to its target), so the
      // x/y returned is always a point where the cursor actually rests.
      var willMove = args.action !== "scroll";
      if (willMove && !hasPoint) {
        el = safeResolveTarget();
        willMove = !!el;
      }
      if (!willMove) {
        if (state.abort) cancelAnim(state);
        readStart();
        if (!state.pos) place(state, startX, startY);
        finish({ moved: false, x: startX, y: startY });
        return;
      }

      // A real move stops whatever the previous one is still animating, then
      // starts from where that one rests.
      cancelAnim(state);
      readStart();
      owns = true;
      var myToken = state.token;
      state.abort = abortMe;

      // Reset effect elements left over from the previous move. Carry the
      // previous move's current rotation (cua from_heading): no snap. Only
      // an ARRIVED move still playing its settle tail gets here with
      // rot != 0; a move cancelled mid-flight went through settleAtTarget,
      // which snaps position AND rot to 0. (Reduced motion plans rot 0, so
      // it snaps at its first sample.)
      state.svg.style.transform = arrowTransform(state.rot || 0, 1);
      state.ring.style.opacity = "0";
      state.magnet.style.opacity = "0";
      clearTrail(state);
      place(state, startX, startY);

      if (hasPoint) {
        var px = clamp(args.point.x, 0, window.innerWidth);
        var py = clamp(args.point.y, 0, window.innerHeight);
        animateTo(px, py, null);
        return;
      }

      function animateTo(targetX, targetY, rect) {
        var plan = planMove({
          style: args.style,
          from: { x: startX, y: startY },
          to: { x: targetX, y: targetY },
          rot0: state.rot,
          w: rect ? Math.min(rect.width, rect.height) : null,
          reduce: reduceMotion
        });
        plannedTarget = { x: targetX, y: targetY };
        var fx = plan.effects;
        var samples = plan.samples;
        var total = samples[samples.length - 1].t;
        var motionEnd = plan.motionEndMs;
        var arrivalT = plan.arrivalT;
        var isClick = args.action === "click" || args.action === "select";
        var isType = args.action === "type";
        // squash depth: click/select 0.88 (cua default), type a lighter 0.94
        var squash = isClick ? 0.12 : isType ? 0.06 : 0;
        var doRipple = fx.ripple && isClick;
        var doSquish = fx.squish && squash > 0;
        var doMagnet = fx.magnet && plan.snapT !== null && !!rect;

        state.glowOn = fx.glow || fx.magnet; // cua fogs the magnet style too
        if (!state.glowOn) state.glow.style.opacity = "0";
        if (doMagnet) {
          var ms = state.magnet.style;
          ms.left = rect.left - 6 + "px";
          ms.top = rect.top - 6 + "px";
          ms.width = rect.width + 12 + "px";
          ms.height = rect.height + 12 + "px";
        }
        state.ring.style.transform = "translate3d(" + targetX + "px," + targetY + "px,0) scale(0.4)";

        var endMs = total;
        if (fx.trail) endMs = Math.max(endMs, motionEnd + TRAIL_MS);
        if (doRipple) endMs = Math.max(endMs, arrivalT + RIPPLE_MS);
        if (doSquish) endMs = Math.max(endMs, arrivalT + PRESS_HOLD_MS + PRESS_OUT_MS);
        if (doMagnet) endMs = Math.max(endMs, plan.snapT + MAGNET_MS);

        var t0 = null;
        var arrived = false;
        var glowRested = false;
        var trailCleared = false;
        function frame(ts) {
          state.raf = 0;
          if (state.token !== myToken) return;
          if (t0 === null) t0 = ts;
          var elapsed = ts - t0;
          var tm = Math.min(elapsed, total);
          var s = sampleAt(samples, tm);
          var v = velocityAt(samples, tm);
          state.rot = s.rot;

          // Early arrival: resolve the moment the hotspot reaches the
          // target — follow-through, settle and click feedback keep
          // playing while the real action proceeds. No extra post-arrival
          // delay (the old 120ms): arrival is honest now, and the ripple
          // and press are already underway when the click lands.
          if (!arrived && elapsed >= arrivalT) {
            arrived = true;
            state.pos = { x: targetX, y: targetY };
            finish({ moved: true, x: targetX, y: targetY });
          } else if (!arrived) {
            state.pos = { x: s.x, y: s.y };
          }

          state.carrier.style.transform = "translate3d(" + s.x + "px," + s.y + "px,0)";
          // Glow and trail follow the motion only; the rotation tail extends
          // just the arrow transform.
          if (state.glowOn) {
            if (elapsed <= motionEnd) {
              drawGlow(state, s.x, s.y, v.x, v.y);
            } else if (!glowRested) {
              glowRested = true;
              drawGlow(state, targetX, targetY, 0, 0);
            }
          }
          if (fx.trail) {
            if (elapsed <= motionEnd + TRAIL_MS) drawTrail(state, samples, tm);
            else if (!trailCleared) {
              trailCleared = true;
              clearTrail(state);
            }
          }

          if (doRipple) {
            var rk = (elapsed - arrivalT) / RIPPLE_MS;
            if (rk >= 0 && rk <= 1) {
              var ek = easeOut(rk);
              state.ring.style.transform =
                "translate3d(" + targetX + "px," + targetY + "px,0) scale(" + (0.4 + 1.2 * ek) + ")";
              state.ring.style.opacity = String(0.9 * (1 - ek));
            } else {
              state.ring.style.opacity = "0";
            }
          }

          if (doMagnet) {
            var mg = Math.max(0, 1 - (elapsed - plan.snapT) / MAGNET_MS);
            state.magnet.style.opacity = elapsed >= plan.snapT ? String(mg) : "0";
          }

          var pk = 0;
          if (doSquish) {
            // Press squish: quick in, springy out.
            var age = elapsed - arrivalT;
            if (age >= 0 && age < PRESS_HOLD_MS) {
              pk = squash * Math.min(1, age / PRESS_IN_MS);
            } else if (age >= PRESS_HOLD_MS) {
              var a2 = age - PRESS_HOLD_MS;
              pk =
                squash *
                Math.max(0, Math.cos(Math.min(1, a2 / PRESS_OUT_MS) * Math.PI * 1.5)) *
                Math.max(0, 1 - a2 / PRESS_OUT_MS);
            }
          }
          // One composed transform: rotate(heading) scale(squish), about the hotspot.
          state.svg.style.transform = arrowTransform(s.rot, 1 - pk);

          if (elapsed < endMs) {
            state.raf = requestAnimationFrame(frame);
          } else {
            state.ring.style.opacity = "0";
            state.magnet.style.opacity = "0";
            resetRot();
            if (fx.trail) clearTrail(state);
            place(state, targetX, targetY);
            if (!arrived) finish({ moved: true, x: targetX, y: targetY });
          }
        }
        state.raf = requestAnimationFrame(frame);
      }

      try {
        el.scrollIntoView({ block: "center" });
      } catch (err) {
        // ignore — animate to wherever the element already is
      }
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          if (state.token !== myToken) return;
          try {
            var rect = el.getBoundingClientRect();
            var targetX = clamp(rect.left + rect.width / 2, 0, window.innerWidth);
            var targetY = clamp(rect.top + rect.height / 2, 0, window.innerHeight);
            animateTo(targetX, targetY, rect);
          } catch (err) {
            resetRot();
            finish({ error: String((err && err.message) || err) });
          }
        });
      });
    } catch (err) {
      if (owns) resetRot();
      finish({ error: String((err && err.message) || err) });
    }
  });
})()`;

export const READ_JS = `(() => {
  ${DEEP_QUERY_HELPER_JS}
  var args = ${ARGS_MARKER};
  var selector = args.selector;
  var maxChars = args.maxChars;

  var root = document;
  if (selector) {
    try {
      root = document.querySelector(selector);
    } catch (err) {
      root = null;
    }
    if (!root) {
      return { error: "browse_read: no element matched selector " + JSON.stringify(selector) };
    }
  }

  function isChrome(el) {
    var tag = (el.tagName || "").toLowerCase();
    if (tag === "script" || tag === "style" || tag === "noscript" || tag === "nav") return true;
    var role = el.getAttribute ? el.getAttribute("role") : null;
    if (role === "navigation") return true;
    // Full browser use (2026-09-23): neither the cursor overlay nor the
    // screenshot annotation overlay (MARKS_JS) is page content — a mark
    // label carries real visible text (the element's index number), which
    // would otherwise leak into browse_read's text digest.
    if (el.hasAttribute && (el.hasAttribute("data-pen-cursor") || el.hasAttribute("data-pen-marks"))) return true;
    return false;
  }

  function isVisible(el) {
    var style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (parseFloat(style.opacity) === 0) return false;
    return true;
  }

  // Finding 9: root.querySelectorAll only matches descendants — when root
  // itself (not document) matches the selector, it must be included too,
  // the same way collectText already includes the root's own text.
  // Wave 3 reliability, item 1: deepQueryAll additionally pierces open
  // shadow roots, so headings/links inside a web component are no longer
  // invisible to browse_read.
  function queryIncludingSelf(scopeRoot, sel) {
    var results = [];
    if (scopeRoot !== document && scopeRoot.matches && scopeRoot.matches(sel)) results.push(scopeRoot);
    var descendants = deepQueryAll(scopeRoot, sel);
    for (var i = 0; i < descendants.length; i++) results.push(descendants[i]);
    return results;
  }

  // Wave 3 reliability, item 1: also walks into every open shadow root
  // (n.shadowRoot), so browse_read's text digest includes text rendered
  // inside a web component instead of stopping at its host element.
  function collectText(node) {
    var parts = [];
    function walk(n) {
      if (n.nodeType === 3) {
        if (n.nodeValue) parts.push(n.nodeValue);
        return;
      }
      // A ShadowRoot itself is a DocumentFragment (nodeType 11), not an
      // Element (nodeType 1) — recursing into it via a plain walk(n.shadowRoot)
      // call would hit the nodeType!==1 guard above and return immediately,
      // silently dropping every bit of shadow content. Its own childNodes are
      // walked directly instead, the same way a plain element's are below.
      if (n.nodeType === 11) {
        var shadowChildren = n.childNodes;
        for (var si = 0; si < shadowChildren.length; si++) walk(shadowChildren[si]);
        return;
      }
      if (n.nodeType !== 1) return;
      if (isChrome(n)) return;
      if (!isVisible(n)) return;
      var children = n.childNodes;
      for (var i = 0; i < children.length; i++) walk(children[i]);
      if (n.shadowRoot) walk(n.shadowRoot);
    }
    walk(node);
    return parts.join(" ");
  }

  var textRoot = root === document ? document.body : root;
  var rawText = textRoot ? collectText(textRoot) : "";
  var collapsed = rawText.replace(/\\s+/g, " ").trim();
  var truncated = collapsed.length > maxChars;
  var text = truncated ? collapsed.slice(0, maxChars) : collapsed;

  var scopeForQuery = root === document ? document : root;

  var headingEls = queryIncludingSelf(scopeForQuery, "h1, h2, h3");
  var allHeadings = [];
  for (var h = 0; h < headingEls.length; h++) {
    var hEl = headingEls[h];
    if (isChrome(hEl) || !isVisible(hEl)) continue;
    var hText = (hEl.textContent || "").replace(/\\s+/g, " ").trim();
    if (hText) allHeadings.push(hText);
  }
  var headingsTruncated = allHeadings.length > 40;
  var headings = allHeadings.slice(0, 40);

  var linkEls = queryIncludingSelf(scopeForQuery, "a[href]");
  var allLinks = [];
  var seenHrefs = Object.create(null);
  for (var l = 0; l < linkEls.length; l++) {
    var a = linkEls[l];
    var hrefAttr = a.getAttribute("href");
    var href;
    try {
      href = new URL(hrefAttr, document.baseURI).href;
    } catch (err) {
      continue;
    }
    if (href.indexOf("http:") !== 0 && href.indexOf("https:") !== 0) continue;
    if (seenHrefs[href]) continue;
    seenHrefs[href] = true;
    var label = (a.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120);
    allLinks.push({ label: label, href: href });
  }
  var linksTruncated = allLinks.length > 60;
  var links = allLinks.slice(0, 60);

  return {
    url: location.href,
    title: document.title,
    headings: headings,
    text: text,
    links: links,
    truncated: truncated,
    headingsTruncated: headingsTruncated,
    linksTruncated: linksTruncated,
  };
})()`;

// --- Full browser use (design doc `2026-09-23-full-browser-use-design.md`) ---

/**
 * `browse_screenshot`'s "set of marks" overlay — a numbered label plus an
 * outline box over every element `SNAPSHOT_JS` stamped `data-pen-snap` for
 * `args.snapshotId` (`browse_screenshot({ annotate: true })` runs it against
 * a fresh snapshot, or against the caller's still-current `snapshotId` on the
 * reuse path; staleness is checked by the controller, not here). Covers only
 * the top document and only elements intersecting the viewport — elements in
 * iframes/shadow roots, off-screen or zero-size ones get no mark, so `marked`
 * may legitimately be 0. Everything is `position:fixed` (viewport-relative), matching the
 * coordinate space `webContents.capturePage()` captures, and wrapped in a
 * single `[data-pen-marks]` container so `controller.ts`'s `screenshot()` can
 * remove the whole thing in one shot via REMOVE_MARKS_JS's `finally`.
 *
 * Label placement (each number is a small blue tab touching its box): first
 * the free spot left of the box's top-left corner (same row), then above,
 * right, below — the first that covers no other marked box, no earlier label
 * and no visible page text/control (`elementFromPoint` + text-node rects).
 * Boxes with 3+ neighbours within 6px (calendar days, table-cell buttons) and
 * anything with no free outside spot get a smaller translucent label INSIDE
 * their top-left corner instead; pages with more than 60 marks use smaller
 * labels. History: above-only confused table rows, inside-only hid field
 * text, left-only covered the neighbour in dense rows. The result also carries
 * `placement` (counts per spot) for diagnostics and tests.
 *
 * Never left in the DOM across commands: `SNAPSHOT_JS`/`FIND_IMAGES_JS`/
 * `SIGNATURE_JS`/`READ_JS` all additionally exclude `[data-pen-marks]` from
 * their own output (see each script's own doc comment), the same way they
 * already exclude the cursor overlay's `[data-pen-cursor]` — belt-and-braces
 * on top of the removal, not a substitute for it.
 */
export const MARKS_JS = `(() => {
  var args = ${ARGS_MARKER};
  var snapshotId = args.snapshotId;
  // draw:false = layout only: same selection and placement, NO DOM change; the
  // marks come back as data for COMPOSE_MARKS_JS to paint onto the captured image.
  var draw = args.draw !== false;

  var vw = window.innerWidth || document.documentElement.clientWidth || 0;
  var vh = window.innerHeight || document.documentElement.clientHeight || 0;
  ${TOGGLE_PROXY_JS}
  var marked = document.querySelectorAll('[data-pen-snap^="' + snapshotId + ':"]');

  // Pass 1: every visible marked element and its box. Collected up front so a
  // label can be checked against ALL other boxes, not only earlier ones.
  var items = [];
  for (var i = 0; i < marked.length; i++) {
    var el = marked[i];
    // A hidden-on-purpose radio/checkbox is marked on its label, the same
    // box the snapshot listed it with.
    var rect = (penToggleProxy(el) || el).getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    // Off-screen: no box, no label.
    if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= vw || rect.top >= vh) continue;
    var attr = el.getAttribute("data-pen-snap") || "";
    var idx = parseInt(attr.slice(String(snapshotId).length + 1), 10);
    if (isNaN(idx)) continue;
    items.push({ el: el, idx: idx, l: rect.left, t: rect.top, r: rect.right, b: rect.bottom });
  }

  // Dense pages get smaller labels (fewer collisions, less covered content).
  var dense = items.length > 60;
  var LABEL_H = dense ? 13 : 16;
  var FONT = dense ? 9 : 10;
  var CHAR_W = dense ? 6 : 7;
  var PAD = dense ? 3 : 4;
  var placed = [];
  var stats = { left: 0, above: 0, right: 0, below: 0, inside: 0 };

  function overlaps(a, c) {
    return a.l < c.r && c.l < a.r && a.t < c.b && c.t < a.b;
  }
  // A box that wraps the element (a card around its button) is a container,
  // not a neighbour: a label sitting inside it covers no other control.
  function wraps(outer, inner) {
    return outer.l <= inner.l + 1 && outer.t <= inner.t + 1 && outer.r >= inner.r - 1 && outer.b >= inner.b - 1;
  }
  // Does the page paint content (text, a control, an image) under this point?
  function contentAt(x, y, c) {
    var hit = document.elementFromPoint(x, y);
    if (!hit || hit === document.documentElement || hit === document.body) return false;
    var tag = hit.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "IMG" || tag === "SVG" || tag === "svg" || tag === "CANVAS" || tag === "VIDEO" || tag === "BUTTON" || tag === "A") return true;
    for (var n = hit.firstChild; n; n = n.nextSibling) {
      if (n.nodeType !== 3 || !n.nodeValue || !n.nodeValue.trim()) continue;
      var range = document.createRange();
      range.selectNodeContents(n);
      var rs = range.getClientRects();
      for (var q = 0; q < rs.length; q++) {
        if (rs[q].width > 0 && overlaps({ l: rs[q].left, t: rs[q].top, r: rs[q].right, b: rs[q].bottom }, c)) return true;
      }
    }
    return false;
  }
  function coversContent(c) {
    var xs = [c.l + 1, (c.l + c.r) / 2, c.r - 1];
    var ys = [c.t + 1, c.b - 1];
    for (var a = 0; a < xs.length; a++) {
      for (var b2 = 0; b2 < ys.length; b2++) {
        if (contentAt(xs[a], ys[b2], c)) return true;
      }
    }
    return false;
  }
  function inViewport(c) {
    return c.l >= 0 && c.t >= 0 && c.r <= vw && c.b <= vh;
  }
  function clean(c, self, skipContent) {
    if (!inViewport(c)) return false;
    for (var j = 0; j < items.length; j++) {
      if (j === self) continue;
      if (overlaps(items[j], c) && !wraps(items[j], items[self])) return false;
    }
    for (var k = 0; k < placed.length; k++) {
      if (overlaps(placed[k], c)) return false;
    }
    return skipContent || !coversContent(c);
  }

  var out = [];
  for (var n2 = 0; n2 < items.length; n2++) {
    var it = items[n2];

    var text = String(it.idx);
    var labelW = 2 * PAD + CHAR_W * text.length;
    // Outside the box, touching it: left of the top-left corner (same row),
    // above it, right of it, below it. The first spot that covers no other
    // marked box, no earlier label and no visible page content wins. Dense
    // grids (calendar days, pagination, table cells) leave none: then a small
    // translucent label goes INSIDE the box corner.
    var cands = [
      ["left", { l: it.l - 1 - labelW, t: it.t }],
      ["above", { l: it.l, t: it.t - 1 - LABEL_H }],
      ["right", { l: it.r + 1, t: it.t }],
      ["below", { l: it.l, t: it.b + 1 }],
    ];
    var chosen = null;
    var kind = "";
    // A tight grid (3+ boxes within 6px: calendar day, table-cell button) has
    // no honest outside spot: labels floating between cells read as belonging
    // to the neighbour, so those boxes get the inside-corner label directly.
    var near = 0;
    for (var nb = 0; nb < items.length; nb++) {
      if (nb === n2 || wraps(items[nb], it) || wraps(it, items[nb])) continue;
      if (items[nb].l < it.r + 6 && it.l < items[nb].r + 6 && items[nb].t < it.b + 6 && it.t < items[nb].b + 6) near++;
    }
    for (var ci = 0; ci < cands.length && !chosen && near < 3; ci++) {
      var cc = cands[ci][1];
      var cand = { l: cc.l, t: cc.t, r: cc.l + labelW, b: cc.t + LABEL_H };
      if (clean(cand, n2, false)) {
        chosen = cand;
        kind = cands[ci][0];
      }
    }
    var inside = false;
    var fw = labelW;
    var fh = LABEL_H;
    if (!chosen) {
      inside = true;
      kind = "inside";
      // Smaller, translucent, in the first box corner free of other labels.
      fh = 12;
      fw = 6 + 6 * text.length;
      var bw = it.r - it.l;
      var bh = it.b - it.t;
      var corners = [[it.l + 1, it.t + 1], [it.r - 1 - fw, it.t + 1], [it.l + 1, it.b - 1 - fh], [it.r - 1 - fw, it.b - 1 - fh]];
      for (var cn = 0; cn < corners.length && !chosen; cn++) {
        var cd = { l: corners[cn][0], t: corners[cn][1], r: corners[cn][0] + fw, b: corners[cn][1] + fh };
        var hit2 = false;
        for (var k2 = 0; k2 < placed.length; k2++) if (overlaps(placed[k2], cd)) hit2 = true;
        if (!hit2 && (bw >= fw + 2 || cn === 0) && (bh >= fh + 2 || cn === 0)) chosen = cd;
      }
      if (!chosen) chosen = { l: it.l + 1, t: it.t + 1, r: it.l + 1 + fw, b: it.t + 1 + fh };
    }
    // Clamp last (the viewport edge may still push a label), then record the
    // clamped rect so later labels collide with what is really drawn.
    var labelLeft = Math.max(0, Math.min(chosen.l, Math.max(0, vw - fw)));
    var labelTop = Math.max(0, Math.min(chosen.t, Math.max(0, vh - fh)));
    placed.push({ l: labelLeft, t: labelTop, r: labelLeft + fw, b: labelTop + fh });
    stats[kind]++;
    out.push({
      text: text,
      box: { l: it.l, t: it.t, w: it.r - it.l, h: it.b - it.t },
      label: { l: labelLeft, t: labelTop, w: fw, h: fh },
      inside: inside,
      font: inside ? 9 : FONT,
      padX: inside ? 3 : PAD,
      bg: inside ? "rgba(13,153,255,0.82)" : "#0d99ff",
    });
  }

  // Both modes first drop any stale overlay, so it never ends up in a clean capture.
  var existing = document.querySelector("[data-pen-marks]");
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

  if (!draw) {
    return { marked: out.length, placement: stats, marks: out, viewportWidth: vw, viewportHeight: vh };
  }

  var container = document.createElement("div");
  container.setAttribute("data-pen-marks", "1");
  container.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none;";
  for (var d = 0; d < out.length; d++) {
    var m = out[d];
    var box = document.createElement("div");
    box.style.cssText =
      "position:fixed;left:" +
      m.box.l +
      "px;top:" +
      m.box.t +
      "px;width:" +
      m.box.w +
      "px;height:" +
      m.box.h +
      "px;outline:2px solid #0d99ff;outline-offset:-1px;box-sizing:border-box;pointer-events:none;";
    container.appendChild(box);

    var label = document.createElement("div");
    label.textContent = m.text;
    label.style.cssText =
      "position:fixed;left:" +
      m.label.l +
      "px;top:" +
      m.label.t +
      "px;box-sizing:border-box;min-width:" +
      m.label.w +
      "px;height:" +
      m.label.h +
      "px;padding:0 " +
      m.padX +
      "px;background:" +
      m.bg +
      ";color:#fff;font:" +
      m.font +
      "px/" +
      m.label.h +
      "px -apple-system,BlinkMacSystemFont,sans-serif;border-radius:3px;" +
      "pointer-events:none;white-space:nowrap;text-align:center;";
    container.appendChild(label);
  }

  (document.documentElement || document.body).appendChild(container);
  return { marked: out.length, placement: stats };
})()`;

/**
 * Runs ONLY in an isolated world (executeJavaScriptIsolated) — never the page's
 * main world, whose scripts could patch atob/Blob/createImageBitmap and read
 * cross-origin iframe pixels or forge the result. Paints MARKS_JS's layout (`draw:false` result) onto an already captured
 * image, entirely off-DOM: the JPEG (`args.imageData`, a data URL or bare
 * base64) is decoded via base64 -> Uint8Array -> Blob -> createImageBitmap (no
 * network, no `new Image()`, so page CSP cannot block it), drawn on a
 * detached (Offscreen)Canvas, and the boxes/labels are drawn scaled by
 * imageWidth / viewportWidth. Resolves `{ imageData, width, height }` (JPEG
 * data URL, same as capture()) or `{ error }`. Never touches the document.
 */
/** JPEG quality of the composed (second-generation) screenshot. Higher than
 * capture()'s 0.7 so small digits survive re-encoding. */
export const COMPOSE_JPEG_QUALITY = 0.8;

export const COMPOSE_MARKS_JS = `(async () => {
  var args = ${ARGS_MARKER};
  try {
    if (typeof createImageBitmap !== "function") return { error: "createImageBitmap unavailable" };
    var b64 = String(args.imageData || "");
    var comma = b64.indexOf(",");
    if (b64.indexOf("data:") === 0 && comma >= 0) b64 = b64.slice(comma + 1);
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
    var W = bmp.width;
    var H = bmp.height;
    var canvas;
    if (typeof OffscreenCanvas === "function") canvas = new OffscreenCanvas(W, H);
    else {
      canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
    }
    var ctx = canvas.getContext("2d");
    if (!ctx) return { error: "no 2d context" };
    ctx.drawImage(bmp, 0, 0, W, H);
    if (bmp.close) bmp.close();
    var kx = args.viewportWidth > 0 ? W / args.viewportWidth : 1;
    var ky = args.viewportHeight > 0 ? H / args.viewportHeight : kx;
    var marks = args.marks || [];
    var BLUE = "#0d99ff";
    for (var a = 0; a < marks.length; a++) {
      var m = marks[a];
      ctx.strokeStyle = BLUE;
      // DOM look: outline 2px, offset -1px = ring from 1px inside to 1px
      // outside the box edge, i.e. a 2px stroke centred on the edge.
      ctx.lineWidth = 2 * kx;
      ctx.strokeRect(m.box.l * kx, m.box.t * ky, m.box.w * kx, m.box.h * ky);
    }
    for (var c = 0; c < marks.length; c++) {
      var mk = marks[c];
      // Exactly the placed rect: placement and drawing stay identical.
      var x = mk.label.l * kx;
      var y = mk.label.t * ky;
      var w = mk.label.w * kx;
      var h = mk.label.h * ky;
      var fontPx = mk.font * ky;
      ctx.font = fontPx + "px -apple-system,BlinkMacSystemFont,sans-serif";
      var avail = Math.max(1, w - 2 * mk.padX * kx);
      var tw = ctx.measureText(mk.text).width;
      if (tw > avail) {
        fontPx = fontPx * (avail / tw);
        ctx.font = fontPx + "px -apple-system,BlinkMacSystemFont,sans-serif";
      }
      var r = 3 * Math.min(kx, ky);
      ctx.fillStyle = mk.bg;
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.arcTo(x + w, y, x + w, y + r, r);
      ctx.lineTo(x + w, y + h - r);
      ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
      ctx.lineTo(x + r, y + h);
      ctx.arcTo(x, y + h, x, y + h - r, r);
      ctx.lineTo(x, y + r);
      ctx.arcTo(x, y, x + r, y, r);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(mk.text, x + w / 2, y + h / 2 + 0.5 * ky);
    }
    var dataUrl;
    if (canvas.convertToBlob) {
      var blob = await canvas.convertToBlob({ type: "image/jpeg", quality: ${COMPOSE_JPEG_QUALITY} });
      var buf = new Uint8Array(await blob.arrayBuffer());
      var s = "";
      for (var p = 0; p < buf.length; p += 8192) s += String.fromCharCode.apply(null, buf.subarray(p, p + 8192));
      dataUrl = "data:image/jpeg;base64," + btoa(s);
    } else {
      dataUrl = canvas.toDataURL("image/jpeg", ${COMPOSE_JPEG_QUALITY});
    }
    if (!dataUrl || dataUrl.indexOf("data:image/jpeg") !== 0) return { error: "compose produced no image" };
    return { imageData: dataUrl, width: W, height: H };
  } catch (e) {
    return { error: "compose failed: " + (e && e.message ? e.message : String(e)) };
  }
})()`;

/** Removes the `[data-pen-marks]` overlay MARKS_JS installed — run in
 * `controller.ts`'s `finally` so a mark overlay never survives past the
 * `browse_screenshot` call that created it, regardless of how that call
 * resolves. */
export const REMOVE_MARKS_JS = `(() => {
  var el = document.querySelector("[data-pen-marks]");
  if (el && el.parentNode) el.parentNode.removeChild(el);
  return { removed: !!el };
})()`;

/** Hides (or restores) the agent-cursor overlay root so a screenshot never
 * shows its glow/trail/ripple. `changed` is true only when the overlay exists
 * and its visibility actually flipped. Never throws. */
export const CURSOR_VISIBILITY_JS = `(() => {
  var args = ${ARGS_MARKER};
  var root = document.querySelector("[data-pen-cursor]");
  // No overlay, or already faded out by the idle auto-hide: nothing to hide.
  if (!root || root.style.opacity === "0") return { changed: false };
  var wasHidden = root.style.visibility === "hidden";
  root.style.visibility = args.hidden ? "hidden" : "";
  return { changed: wasHidden !== !!args.hidden };
})()`;

/**
 * Locates an element the same way `act`'s `hover` resolves its target (see
 * LOCATE_TARGET_JS) and reports its viewport-relative centre.
 * `controller.ts`'s `runHover` dispatches the actual hover via CDP's
 * `Input.dispatchMouseEvent` against these coordinates: a synthetic
 * `mouseover`/`mouseenter` `dispatchEvent` from page script would not trigger
 * the browser's own `:hover` CSS pseudo-class, which is the whole point of
 * `act`'s hover action.
 */
export const HOVER_TARGET_JS = `(() => {
  var args = ${ARGS_MARKER};

  ${LOCATE_TARGET_JS}

  var located = locateTarget(args);
  var el = located.el;
  if (!el) return { found: false, hidden: located.hidden === true };
  var rect = el.getBoundingClientRect();
  var hoverResult = {
    found: true,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
  if (located.relocated) hoverResult.relocated = true;
  return hoverResult;
})()`;

/**
 * Focus step for `act`'s `press` action when it's given a `target`/
 * `index`+`snapshotId` to focus first (pressing a key with no element in
 * mind just goes to whatever already has focus). This script itself never
 * throws — it reports `{ focused: false }` for "no element matched" — but
 * (review finding 5) `controller.ts`'s `runPress` now turns that into a hard
 * `{ error }` whenever a target/index was actually given, instead of the
 * previous best-effort behavior of silently sending the key to whatever
 * already had focus: dispatching a keystroke to the wrong element on a page
 * is worse than reporting "couldn't find that to focus." Resolves its target
 * the same way `act`'s `hover` does — see LOCATE_TARGET_JS.
 */
export const FOCUS_JS = `(() => {
  var args = ${ARGS_MARKER};

  ${LOCATE_TARGET_JS}

  var located = locateTarget(args);
  var el = located.el;
  if (!el) return { focused: false, hidden: located.hidden === true };
  if (typeof el.focus === "function") el.focus();
  var focusResult = { focused: true };
  if (located.relocated) focusResult.relocated = true;
  return focusResult;
})()`;

/** `act`'s `wait` action, when given `text`: a single poll of the page's
 * visible text for a case-insensitive substring match. `controller.ts`'s
 * `runWait` calls this in a loop (every 100ms) rather than blocking inside
 * one long-running script — Electron's `executeJavaScript` has no built-in
 * polling primitive, and a single call here keeps each round trip cheap and
 * independently bounded by the outer wait's own deadline. */
export const WAIT_TEXT_JS = `(() => {
  var args = ${ARGS_MARKER};
  var needle = String(args.text || "").toLowerCase();
  var body = (document.body && document.body.innerText) || "";
  return { found: body.toLowerCase().indexOf(needle) !== -1 };
})()`;

/**
 * Activity watcher for plain-field suggestions (controller.ts
 * settleAutocomplete): like WAIT_DOM_ACTIVITY_JS, but it only counts
 * mutations that ADD ELEMENT nodes (outside the cursor / marks overlays) — a
 * ticking clock or counter only swaps text, which is not a suggestion list
 * being rendered. `check` returns { mutated, ageMs }.
 */
export const SUGGEST_ACTIVITY_JS = `(() => {
  var args = ${ARGS_MARKER};
  var action = args.action;
  if (action === "install") {
    if (window.__penSuggestDom && window.__penSuggestDom.observer) {
      try {
        window.__penSuggestDom.observer.disconnect();
      } catch (e) {}
    }
    var state = { observer: null, lastAt: null };
    try {
      var observer = new MutationObserver(function (records) {
        if (penCounts(records)) state.lastAt = Date.now();
      });
      if (document.body) observer.observe(document.body, { childList: true, subtree: true });
      state.observer = observer;
    } catch (e) {
      state.observer = null;
    }
    window.__penSuggestDom = state;
    return { installed: true };
  }
  if (action === "uninstall") {
    if (window.__penSuggestDom && window.__penSuggestDom.observer) {
      try {
        window.__penSuggestDom.observer.disconnect();
      } catch (e) {}
    }
    window.__penSuggestDom = null;
    return { uninstalled: true };
  }
  function penCounts(records) {
    for (var i = 0; i < records.length; i++) {
      var added = records[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var n = added[j];
        if (n.nodeType !== 1) continue;
        if (n.closest && (n.closest("[data-pen-cursor]") || n.closest("[data-pen-marks]"))) continue;
        return true;
      }
    }
    return false;
  }
  var st = window.__penSuggestDom;
  if (!st || !st.observer) return { mutated: false, ageMs: null };
  try {
    if (penCounts(st.observer.takeRecords())) st.lastAt = Date.now();
  } catch (e) {}
  if (st.lastAt === null) return { mutated: false, ageMs: null };
  return { mutated: true, ageMs: Date.now() - st.lastAt };
})()`;

/**
 * `act`'s `wait` action, when given no `text`: tracks DOM-mutation activity
 * across a whole wait, alongside `controller.ts`'s own CDP network-activity
 * tracking (`BrowserPageHandle.networkStats`) — the DOM half of the "wait
 * for *something to happen, then settle*" rule (Wave 1 speed follow-up:
 * `wait` must not return early just because nothing has started yet, only
 * once something that *did* start has since gone quiet — see
 * `runWait`'s doc comment).
 *
 * `action: "install"` (called once, at the very start of the wait, before
 * the poll loop) creates a `MutationObserver` on `document.body`
 * (`childList`/`subtree`/`characterData`) and stores it — along with the
 * timestamp of the most recent mutation it has seen — on
 * `window.__penWaitDom`, so state survives across the separate
 * `executeJavaScript` calls the poll loop makes (same page realm, same
 * pattern `SIGNATURE_JS`'s `window.__penSigObserver` already uses).
 * `action: "check"` (called once per poll) flushes `takeRecords()` — which
 * can't miss a mutation regardless of whether the observer's own async
 * callback has run yet — and reports `{ mutated, ageMs }`: `mutated` is
 * whether *any* relevant mutation has been seen since `install`, `ageMs` is
 * how long ago the most recent one was (`null` when `mutated` is false).
 * `action: "uninstall"` (called once, when the wait ends) disconnects the
 * observer and clears the stored state, so it never lingers past the
 * `browse_act` call that installed it.
 */
export const WAIT_DOM_ACTIVITY_JS = `(() => {
  var args = ${ARGS_MARKER};
  var action = args.action;

  if (action === "install") {
    if (window.__penWaitDom && window.__penWaitDom.observer) {
      try {
        window.__penWaitDom.observer.disconnect();
      } catch (e) {}
    }
    var state = { observer: null, lastMutationAt: null };
    try {
      var observer = new MutationObserver(function (records) {
        if (records.length > 0) state.lastMutationAt = Date.now();
      });
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      }
      state.observer = observer;
    } catch (e) {
      state.observer = null;
    }
    window.__penWaitDom = state;
    return { installed: true };
  }

  if (action === "uninstall") {
    if (window.__penWaitDom && window.__penWaitDom.observer) {
      try {
        window.__penWaitDom.observer.disconnect();
      } catch (e) {}
    }
    window.__penWaitDom = null;
    return { uninstalled: true };
  }

  // "check"
  var st = window.__penWaitDom;
  if (!st || !st.observer) return { mutated: false, ageMs: null };
  try {
    var pending = st.observer.takeRecords();
    if (pending.length > 0) st.lastMutationAt = Date.now();
  } catch (e) {}
  if (st.lastMutationAt === null) return { mutated: false, ageMs: null };
  return { mutated: true, ageMs: Date.now() - st.lastMutationAt };
})()`;

/**
 * Wave 3 reliability, item 4: a cheap, best-effort "does this page look like
 * a bot-check/CAPTCHA wall" heuristic, run once after `open` settles.
 * Deliberately conservative — a false positive just tells the agent to hand
 * off to the user instead of fighting a wall that doesn't actually exist,
 * while a missed real one just means the agent keeps trying and eventually
 * gives up on its own. Matches on the page's title or the first 2000 chars
 * of its visible body text against a fixed set of common challenge phrases
 * ("just a moment", "verify you are human", "captcha", "attention
 * required", "access denied", "unusual traffic" — Cloudflare/Google/generic
 * anti-bot copy), or the presence of an iframe whose `src` points at a
 * known challenge host (Cloudflare Turnstile, Google/hCaptcha reCAPTCHA).
 * Swallows its own failures — a botCheck script throwing must never turn a
 * working `open` into an error.
 */
/**
 * Wave 3 reliability, item 2: run against the TOP document only, to
 * discover which of its `<iframe>` elements are actually worth descending
 * into. Returns `{ url, name, x, y, width, height }` for every visible
 * (non-zero-size, not `display:none`/`visibility:hidden`) iframe element —
 * `x`/`y` are the iframe's own content-box origin in top-level viewport CSS
 * px (border/padding excluded, since that's the same coordinate space a
 * child frame's own `getBoundingClientRect()` calls report *within*, so
 * `controller.ts` can add the two directly with no further conversion).
 * `deepQueryAll` (not a plain `document.querySelectorAll`) so an iframe
 * nested inside an open shadow root is still found. `controller.ts` matches
 * each entry back to a `WebFrameMain` child frame by `url` first, falling
 * back to `name` — see its own doc comment for why neither match is
 * available from inside this script (a cross-origin iframe's `src` may
 * differ from the frame's *current*, possibly-redirected `url`, and a
 * `WebFrameMain` has no DOM-side identity a page script could read at all).
 */
export const IFRAME_RECTS_JS = `(() => {
  ${DEEP_QUERY_HELPER_JS}
  var out = [];
  var frames = deepQueryAll(document, "iframe");
  for (var i = 0; i < frames.length; i++) {
    var el = frames[i];
    if (el.closest && (el.closest("[data-pen-cursor]") || el.closest("[data-pen-marks]"))) continue;
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    var style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    var cs = style;
    var borderLeft = parseFloat(cs.borderLeftWidth) || 0;
    var borderTop = parseFloat(cs.borderTopWidth) || 0;
    var paddingLeft = parseFloat(cs.paddingLeft) || 0;
    var paddingTop = parseFloat(cs.paddingTop) || 0;
    out.push({
      url: el.src || "",
      name: el.getAttribute("name") || el.id || "",
      x: rect.left + borderLeft + paddingLeft,
      y: rect.top + borderTop + paddingTop,
      width: rect.width,
      height: rect.height,
    });
  }
  return { frames: out };
})()`;

export const BOT_CHECK_JS = `(() => {
  try {
    var pattern = /just a moment|verify you are human|are you a robot|captcha|attention required|access denied|unusual traffic/i;
    var title = document.title || "";
    var bodyText = document.body && document.body.innerText ? document.body.innerText.slice(0, 2000) : "";
    var textMatch = pattern.test(title) || pattern.test(bodyText);
    var challengeHosts = ["challenges.cloudflare.com", "google.com/recaptcha", "hcaptcha.com"];
    var iframeMatch = false;
    var iframes = document.querySelectorAll("iframe");
    for (var i = 0; i < iframes.length && !iframeMatch; i++) {
      var src = iframes[i].getAttribute("src") || "";
      for (var h = 0; h < challengeHosts.length; h++) {
        if (src.indexOf(challengeHosts[h]) !== -1) {
          iframeMatch = true;
          break;
        }
      }
    }
    return { botCheck: textMatch || iframeMatch };
  } catch (err) {
    return { botCheck: false };
  }
})()`;
