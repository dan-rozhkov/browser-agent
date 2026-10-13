// Pure key-name parsing for `browse_act`'s "press" action (design doc
// `2026-09-23-full-browser-use-design.md`). Kept free of any CDP/Electron
// dependency, unlike controller.ts's other helpers, so the parsing itself —
// the part an LLM's raw string input actually exercises — is unit-testable
// under plain Node/vitest without a fake page at all (test/keys.test.ts).
//
// controller.ts's runPress feeds the result straight into CDP's
// `Input.dispatchKeyEvent`: `windowsVirtualKeyCode`/`code`/`key` identify the
// physical key, and `text` (present only for a key that actually produces
// character input — a letter, digit, space, or Enter's "\r") is what makes a
// keyDown also insert a character, matching what a real keyboard reports.
// Modifier keys (Shift/Ctrl/Alt/Meta) never carry a `text` of their own here
// — they only set bits in the event's `modifiers` field via
// `modifiersBitmask`.

export interface ModifierState {
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

/** CDP's `Input.dispatchKeyEvent` "modifiers" bitmask (Alt=1, Ctrl=2,
 * Meta/Command=4, Shift=8 — see the Chrome DevTools Protocol's own
 * `Input.dispatchKeyEvent` reference). */
export function modifiersBitmask(mods: ModifierState): number {
  let bits = 0;
  if (mods.alt) bits |= 1;
  if (mods.ctrl) bits |= 2;
  if (mods.meta) bits |= 4;
  if (mods.shift) bits |= 8;
  return bits;
}

export interface KeyDescriptor {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  /** Present only for a key that produces character input. */
  text?: string;
}

interface NamedKey {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
}

// Values match the Windows virtual-key codes CDP expects (the same table
// Chromium itself uses for `Input.dispatchKeyEvent`), and `code`/`key`
// mirror the DOM UI Events spec's own values for each physical key.
const NAMED_KEYS: Record<string, NamedKey> = {
  enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  esc: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  end: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  // Second-pass review finding 5: an explicit named alias for "+" — parsed
  // the same as the punctuation-table "+" (a shifted "="), so "Plus" and "+"
  // are interchangeable ways to spell the same physical key.
  plus: { key: "+", code: "Equal", windowsVirtualKeyCode: 187, text: "+" },
};

/**
 * Review finding 1: a US-layout table for the punctuation row, keyed by the
 * *unshifted* character. Before this, a punctuation character's
 * `windowsVirtualKeyCode` fell back to its raw ASCII code point — which
 * collides with several of CDP's real virtual-key codes for entirely
 * different physical keys: `.` (46) is Delete's own code, `%`/`&`/`'`/`(`
 * (37/38/39/40) are the arrow keys', and several other punctuation code
 * points land on Home/End/PageUp/PageDown/Insert. Sending a "press '.'"
 * command with `windowsVirtualKeyCode: 46` therefore risked Chromium
 * treating it as an actual Delete keypress in some code paths, not the
 * period key. Every entry here is the real CDP/Windows virtual-key code for
 * that physical key, independent of the character's own code point.
 */
const PUNCTUATION: Record<string, { code: string; vk: number }> = {
  ";": { code: "Semicolon", vk: 186 },
  "=": { code: "Equal", vk: 187 },
  ",": { code: "Comma", vk: 188 },
  "-": { code: "Minus", vk: 189 },
  ".": { code: "Period", vk: 190 },
  "/": { code: "Slash", vk: 191 },
  "`": { code: "Backquote", vk: 192 },
  "[": { code: "BracketLeft", vk: 219 },
  "\\": { code: "Backslash", vk: 220 },
  "]": { code: "BracketRight", vk: 221 },
  "'": { code: "Quote", vk: 222 },
};

/** A shifted punctuation symbol resolves to its *base* (unshifted) key's
 * code/virtual-key — Shift doesn't change which physical key was pressed —
 * while `key`/`text` stay the shifted symbol itself. Digits work the same
 * way via `DIGIT_SHIFT`. */
const SHIFTED_PUNCTUATION_TO_BASE: Record<string, string> = {
  "~": "`",
  "_": "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
};

/** US-layout Shift+digit symbols, both directions — `parseKeySpec` uses the
 * base→shifted direction to turn "Shift+1" into the "!" a real keyboard
 * would actually produce (review finding 2); `resolveNamedKey` uses the
 * shifted→base direction so a spec that already spells out "!" resolves to
 * Digit1's own code/virtual-key. */
const DIGIT_SHIFT_BASE_TO_SYMBOL: Record<string, string> = {
  "0": ")",
  "1": "!",
  "2": "@",
  "3": "#",
  "4": "$",
  "5": "%",
  "6": "^",
  "7": "&",
  "8": "*",
  "9": "(",
};
const DIGIT_SHIFT_SYMBOL_TO_BASE: Record<string, string> = Object.fromEntries(
  Object.entries(DIGIT_SHIFT_BASE_TO_SYMBOL).map(([digit, symbol]) => [symbol, digit]),
);
const PUNCTUATION_BASE_TO_SHIFTED: Record<string, string> = Object.fromEntries(
  Object.entries(SHIFTED_PUNCTUATION_TO_BASE).map(([shifted, base]) => [base, shifted]),
);

/** Resolves a single logical key name — a named key ("Enter", case
 * insensitive) or a single printable character ("a", "A", "1", "$") — into
 * its CDP descriptor. Returns null for anything else (an unrecognized name,
 * or a multi-character string that isn't a named key): this is parsing
 * untrusted LLM input, so an unrecognized key is a validation error, not a
 * best-effort guess.
 *
 * Review finding 1: letters/digits/space keep their previous, already-correct
 * handling; punctuation now goes through `PUNCTUATION`/
 * `SHIFTED_PUNCTUATION_TO_BASE`/`DIGIT_SHIFT_SYMBOL_TO_BASE` instead of a raw
 * `charCodeAt(0)` fallback — a single character this repo has no table entry
 * for (a non-US-layout symbol, an emoji, …) now returns null rather than a
 * virtual-key code that might collide with an unrelated real key. */
export function resolveNamedKey(rawKey: string): KeyDescriptor | null {
  const named = NAMED_KEYS[rawKey.toLowerCase()];
  if (named) return { key: named.key, code: named.code, windowsVirtualKeyCode: named.windowsVirtualKeyCode, text: named.text };
  if (rawKey.length !== 1) return null;

  if (/[a-zA-Z]/.test(rawKey)) {
    // A real keyboard's virtual-key code for a letter is its uppercase
    // ASCII value regardless of shift state (shift is a separate modifier
    // bit, not baked into the key code); `key`/`text` preserve whatever case
    // the caller passed — shift-driven case normalization is `parseKeySpec`'s
    // job (review finding 2), not this function's.
    return { key: rawKey, code: `Key${rawKey.toUpperCase()}`, windowsVirtualKeyCode: rawKey.toUpperCase().charCodeAt(0), text: rawKey };
  }
  if (/[0-9]/.test(rawKey)) {
    // Digit '0'-'9' ASCII code points (48-57) already equal the CDP virtual-key
    // codes for Digit0-Digit9 — no separate table needed, unlike punctuation.
    return { key: rawKey, code: `Digit${rawKey}`, windowsVirtualKeyCode: rawKey.charCodeAt(0), text: rawKey };
  }

  const base = PUNCTUATION[rawKey];
  if (base) return { key: rawKey, code: base.code, windowsVirtualKeyCode: base.vk, text: rawKey };

  const shiftedDigitBase = DIGIT_SHIFT_SYMBOL_TO_BASE[rawKey];
  if (shiftedDigitBase) {
    return { key: rawKey, code: `Digit${shiftedDigitBase}`, windowsVirtualKeyCode: shiftedDigitBase.charCodeAt(0), text: rawKey };
  }

  const shiftedPunctBase = SHIFTED_PUNCTUATION_TO_BASE[rawKey];
  if (shiftedPunctBase) {
    const baseEntry = PUNCTUATION[shiftedPunctBase];
    if (baseEntry) return { key: rawKey, code: baseEntry.code, windowsVirtualKeyCode: baseEntry.vk, text: rawKey };
  }

  return null;
}

export interface ParsedKeySpec {
  descriptor: KeyDescriptor;
  modifiers: ModifierState;
}

const MODIFIER_ALIASES: Record<string, keyof ModifierState> = {
  meta: "meta",
  cmd: "meta",
  command: "meta",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
};

/** Review finding 2: when `Shift` is one of the spec's modifiers and the
 * trailing key is a single *unshifted* letter/digit/punctuation character
 * (not a named key like Tab, and not already a shifted symbol like "!" or
 * "A"), rewrites the descriptor's `key`/`text` to what a real keyboard
 * reports for Shift+that physical key — the code/virtual-key (the physical
 * key identity) is left untouched, only the character it produces changes.
 * "Shift+a" → text "A"; "Shift+1" → text "!"; "Shift+-" → text "_". A spec
 * that already spells out the shifted symbol ("Shift+A", "Shift+!") is left
 * alone — it's already correct, and shifting it again would be wrong (e.g.
 * turning "!" into some double-shifted nonsense). Named multi-character keys
 * (rawKey.length !== 1) are untouched — Shift+Tab has no different "text". */
function applyShiftToDescriptor(descriptor: KeyDescriptor, rawKey: string): void {
  if (rawKey.length !== 1) return;
  if (/[a-zA-Z]/.test(rawKey)) {
    descriptor.key = rawKey.toUpperCase();
    descriptor.text = rawKey.toUpperCase();
    return;
  }
  const shiftedDigit = DIGIT_SHIFT_BASE_TO_SYMBOL[rawKey];
  if (shiftedDigit) {
    descriptor.key = shiftedDigit;
    descriptor.text = shiftedDigit;
    return;
  }
  const shiftedPunct = PUNCTUATION_BASE_TO_SHIFTED[rawKey];
  if (shiftedPunct) {
    descriptor.key = shiftedPunct;
    descriptor.text = shiftedPunct;
  }
  // Anything else (already a shifted symbol, or a named key with no
  // shift-specific text) is left as resolveNamedKey produced it.
}

/** Parses a "+"-separated key spec ("Enter", "Meta+a", "Shift+Tab") into the
 * final key descriptor plus which modifiers should be held. Every segment
 * except the last must be a recognized modifier alias — an unrecognized
 * modifier name or a bare key this repo doesn't recognize both return null,
 * since a caller (an LLM tool call) that gets this wrong should see a clear
 * validation error, not a silently-wrong keypress. */
export function parseKeySpec(spec: string): ParsedKeySpec | null {
  // Second-pass review finding 5: a literal single-space spec (" ") is a
  // real key press — Space — not an empty string to be trimmed away. Handled
  // before the "+"-split logic below, which would otherwise reduce it to no
  // parts at all and return null.
  if (spec === " ") {
    return {
      descriptor: resolveNamedKey("space")!,
      modifiers: { alt: false, ctrl: false, meta: false, shift: false },
    };
  }
  const rawParts = spec.split("+");
  // Second-pass review finding 5: a trailing empty segment means the spec
  // itself ended in a literal "+" — "+".split("+") is ["", ""], and
  // "Ctrl++".split("+") is ["Ctrl", "", ""]. The previous logic trimmed and
  // filtered out every empty segment unconditionally, which made "+" as a
  // key completely unreachable: "+" alone became zero parts (→ null), and
  // "Ctrl++" silently lost its trailing "+" and tried to resolve "Ctrl"
  // itself as the key. Collapsing the trailing empty segment into an
  // explicit "+" key segment fixes both.
  let parts: string[];
  if (rawParts.length > 1 && rawParts[rawParts.length - 1] === "") {
    parts = rawParts
      .slice(0, -1)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    parts.push("+");
  } else {
    parts = rawParts.map((p) => p.trim()).filter((p) => p.length > 0);
  }
  if (parts.length === 0) return null;
  const modifiers: ModifierState = { alt: false, ctrl: false, meta: false, shift: false };
  for (let i = 0; i < parts.length - 1; i++) {
    const alias = MODIFIER_ALIASES[parts[i].toLowerCase()];
    if (!alias) return null;
    modifiers[alias] = true;
  }
  const rawKey = parts[parts.length - 1];
  const descriptor = resolveNamedKey(rawKey);
  if (!descriptor) return null;
  if (modifiers.shift) applyShiftToDescriptor(descriptor, rawKey);
  return { descriptor, modifiers };
}

/**
 * Review finding 2: Chromium doesn't run its native editing-command table
 * (select-all, copy, cut, paste, undo, redo) off a CDP-synthesized
 * `Meta`/`Ctrl`-modified `Input.dispatchKeyEvent` the way it would off a
 * genuine OS-originated shortcut — this is a known Chromium/Puppeteer
 * limitation, not something a `text`/`key`/`code` combination can work
 * around. Puppeteer's own fix (and this one) is to pass CDP's `commands`
 * field naming the editing command directly, and to send *no* `text` for
 * the keydown, since a modified shortcut like Cmd+A must never also insert
 * the literal character "a" into whatever's focused. Returns `undefined` for
 * anything outside this fixed, deliberately small list — an unrecognized
 * Meta/Ctrl combo still dispatches as a plain (textless) key event, just
 * without a `commands` hint. */
export function resolveEditCommand(key: string, modifiers: ModifierState): string[] | undefined {
  if (!modifiers.meta && !modifiers.ctrl) return undefined;
  const lower = key.toLowerCase();
  if (lower === "z") return [modifiers.shift ? "redo" : "undo"];
  if (lower === "y") return ["redo"];
  if (lower === "a") return ["selectAll"];
  if (lower === "c") return ["copy"];
  if (lower === "x") return ["cut"];
  if (lower === "v") return ["paste"];
  return undefined;
}
