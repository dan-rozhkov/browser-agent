import { describe, it, expect } from "vitest";
import { parseKeySpec, resolveNamedKey, modifiersBitmask, resolveEditCommand } from "../src/main/browser/keys";

describe("resolveNamedKey", () => {
  it("resolves named keys case-insensitively", () => {
    expect(resolveNamedKey("Enter")).toEqual({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    expect(resolveNamedKey("enter")).toEqual({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    expect(resolveNamedKey("ESCAPE")).toEqual({ key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, text: undefined });
    expect(resolveNamedKey("Tab")).toMatchObject({ key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    expect(resolveNamedKey("ArrowDown")).toMatchObject({ key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
  });

  it("resolves a single printable letter with the correct code/text/virtual-key", () => {
    expect(resolveNamedKey("a")).toEqual({ key: "a", code: "KeyA", windowsVirtualKeyCode: 65, text: "a" });
    // Case is preserved in `key`/`text` (shift state is a separate concern,
    // carried by the "+"-joined spec, not inferred from letter case here).
    expect(resolveNamedKey("A")).toEqual({ key: "A", code: "KeyA", windowsVirtualKeyCode: 65, text: "A" });
  });

  it("resolves a single digit", () => {
    expect(resolveNamedKey("5")).toEqual({ key: "5", code: "Digit5", windowsVirtualKeyCode: 53, text: "5" });
  });

  it("resolves a non-alphanumeric single character generically", () => {
    const result = resolveNamedKey("$");
    expect(result?.key).toBe("$");
    expect(result?.text).toBe("$");
  });

  it("returns null for an unrecognized multi-character key", () => {
    expect(resolveNamedKey("Foobar")).toBeNull();
  });

  // Review finding 1: before the fixed table, a punctuation character's
  // windowsVirtualKeyCode fell back to its raw ASCII code point, which
  // collides with several of CDP's real virtual-key codes for entirely
  // different physical keys. Each case below asserts the previously-colliding
  // ASCII code point is NOT what gets sent, and the correct US-layout
  // code/virtual-key is.
  describe("punctuation no longer collides with unrelated virtual-key codes (finding 1)", () => {
    it("'.' (ASCII 46, same as Delete's own vk) resolves to Period/190", () => {
      const result = resolveNamedKey(".");
      expect(result?.windowsVirtualKeyCode).not.toBe(46);
      expect(result).toEqual({ key: ".", code: "Period", windowsVirtualKeyCode: 190, text: "." });
    });

    it("'%' (ASCII 37, same as ArrowLeft's vk) resolves as Shift+5, not a collision", () => {
      const result = resolveNamedKey("%");
      expect(result?.windowsVirtualKeyCode).not.toBe(37);
      expect(result).toEqual({ key: "%", code: "Digit5", windowsVirtualKeyCode: 53, text: "%" });
    });

    it("'&' (ASCII 38, same as ArrowUp's vk) resolves as Shift+7", () => {
      const result = resolveNamedKey("&");
      expect(result?.windowsVirtualKeyCode).not.toBe(38);
      expect(result).toEqual({ key: "&", code: "Digit7", windowsVirtualKeyCode: 55, text: "&" });
    });

    it("\"'\" (ASCII 39, same as ArrowRight's vk) resolves to Quote/222", () => {
      const result = resolveNamedKey("'");
      expect(result?.windowsVirtualKeyCode).not.toBe(39);
      expect(result).toEqual({ key: "'", code: "Quote", windowsVirtualKeyCode: 222, text: "'" });
    });

    it("'(' (ASCII 40, same as ArrowDown's vk) resolves as Shift+9", () => {
      const result = resolveNamedKey("(");
      expect(result?.windowsVirtualKeyCode).not.toBe(40);
      expect(result).toEqual({ key: "(", code: "Digit9", windowsVirtualKeyCode: 57, text: "(" });
    });

    it("every named non-printable key still keeps its own dedicated virtual-key code", () => {
      expect(resolveNamedKey("Delete")?.windowsVirtualKeyCode).toBe(46);
      expect(resolveNamedKey("ArrowLeft")?.windowsVirtualKeyCode).toBe(37);
      expect(resolveNamedKey("ArrowUp")?.windowsVirtualKeyCode).toBe(38);
      expect(resolveNamedKey("ArrowRight")?.windowsVirtualKeyCode).toBe(39);
      expect(resolveNamedKey("ArrowDown")?.windowsVirtualKeyCode).toBe(40);
      expect(resolveNamedKey("Home")?.windowsVirtualKeyCode).toBe(36);
      expect(resolveNamedKey("End")?.windowsVirtualKeyCode).toBe(35);
      expect(resolveNamedKey("PageUp")?.windowsVirtualKeyCode).toBe(33);
      expect(resolveNamedKey("PageDown")?.windowsVirtualKeyCode).toBe(34);
    });

    it("resolves the rest of the US punctuation row to their documented code/virtual-key", () => {
      expect(resolveNamedKey(";")).toEqual({ key: ";", code: "Semicolon", windowsVirtualKeyCode: 186, text: ";" });
      expect(resolveNamedKey("=")).toEqual({ key: "=", code: "Equal", windowsVirtualKeyCode: 187, text: "=" });
      expect(resolveNamedKey(",")).toEqual({ key: ",", code: "Comma", windowsVirtualKeyCode: 188, text: "," });
      expect(resolveNamedKey("-")).toEqual({ key: "-", code: "Minus", windowsVirtualKeyCode: 189, text: "-" });
      expect(resolveNamedKey("/")).toEqual({ key: "/", code: "Slash", windowsVirtualKeyCode: 191, text: "/" });
      expect(resolveNamedKey("`")).toEqual({ key: "`", code: "Backquote", windowsVirtualKeyCode: 192, text: "`" });
      expect(resolveNamedKey("[")).toEqual({ key: "[", code: "BracketLeft", windowsVirtualKeyCode: 219, text: "[" });
      expect(resolveNamedKey("\\")).toEqual({ key: "\\", code: "Backslash", windowsVirtualKeyCode: 220, text: "\\" });
      expect(resolveNamedKey("]")).toEqual({ key: "]", code: "BracketRight", windowsVirtualKeyCode: 221, text: "]" });
    });

    it("resolves an already-shifted symbol to its base key's code/virtual-key", () => {
      expect(resolveNamedKey("_")).toEqual({ key: "_", code: "Minus", windowsVirtualKeyCode: 189, text: "_" });
      expect(resolveNamedKey("!")).toEqual({ key: "!", code: "Digit1", windowsVirtualKeyCode: 49, text: "!" });
      expect(resolveNamedKey(":")).toEqual({ key: ":", code: "Semicolon", windowsVirtualKeyCode: 186, text: ":" });
    });

    it("digits 0-9 resolve to Digit<n>/48-57", () => {
      for (let d = 0; d <= 9; d++) {
        expect(resolveNamedKey(String(d))).toEqual({
          key: String(d),
          code: `Digit${d}`,
          windowsVirtualKeyCode: 48 + d,
          text: String(d),
        });
      }
    });
  });
});

describe("parseKeySpec", () => {
  it("parses a bare key with no modifiers", () => {
    const parsed = parseKeySpec("Enter");
    expect(parsed?.modifiers).toEqual({ alt: false, ctrl: false, meta: false, shift: false });
    expect(parsed?.descriptor.key).toBe("Enter");
  });

  it("parses a single modifier + key", () => {
    const parsed = parseKeySpec("Meta+a");
    expect(parsed?.modifiers).toEqual({ alt: false, ctrl: false, meta: true, shift: false });
    expect(parsed?.descriptor.key).toBe("a");
  });

  it("parses Shift+Tab", () => {
    const parsed = parseKeySpec("Shift+Tab");
    expect(parsed?.modifiers).toEqual({ alt: false, ctrl: false, meta: false, shift: true });
    expect(parsed?.descriptor.key).toBe("Tab");
  });

  it("parses multiple modifiers and common aliases (Cmd/Control/Option)", () => {
    const parsed = parseKeySpec("Control+Option+Delete");
    expect(parsed?.modifiers).toEqual({ alt: true, ctrl: true, meta: false, shift: false });
    expect(parsed?.descriptor.key).toBe("Delete");

    const cmdParsed = parseKeySpec("Cmd+c");
    expect(cmdParsed?.modifiers.meta).toBe(true);
  });

  it("trims whitespace around '+'-separated segments", () => {
    const parsed = parseKeySpec(" Shift + Tab ");
    expect(parsed?.modifiers.shift).toBe(true);
    expect(parsed?.descriptor.key).toBe("Tab");
  });

  it("returns null for an unrecognized modifier name", () => {
    expect(parseKeySpec("Fn+a")).toBeNull();
  });

  it("returns null for an unrecognized trailing key", () => {
    expect(parseKeySpec("Meta+NotAKey")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseKeySpec("")).toBeNull();
  });

  // Second-pass review finding 5: "+" as the key itself was unreachable —
  // splitting on "+" always produced either zero parts ("+" alone) or
  // silently dropped the trailing "+" ("Ctrl++"). A trailing empty segment
  // from the split now becomes an explicit "+" key segment.
  describe("'+' as a key is reachable (finding 5)", () => {
    it("parses a bare '+'", () => {
      const parsed = parseKeySpec("+");
      expect(parsed?.modifiers).toEqual({ alt: false, ctrl: false, meta: false, shift: false });
      expect(parsed?.descriptor.key).toBe("+");
      expect(parsed?.descriptor.code).toBe("Equal");
    });

    it("parses 'Ctrl++'", () => {
      const parsed = parseKeySpec("Ctrl++");
      expect(parsed?.modifiers).toEqual({ alt: false, ctrl: true, meta: false, shift: false });
      expect(parsed?.descriptor.key).toBe("+");
    });

    it("parses 'Meta++'", () => {
      const parsed = parseKeySpec("Meta++");
      expect(parsed?.modifiers).toEqual({ alt: false, ctrl: false, meta: true, shift: false });
      expect(parsed?.descriptor.key).toBe("+");
    });

    it("accepts the 'Plus' named alias as equivalent to '+'", () => {
      const parsed = parseKeySpec("Ctrl+Plus");
      expect(parsed?.modifiers.ctrl).toBe(true);
      expect(parsed?.descriptor).toEqual({ key: "+", code: "Equal", windowsVirtualKeyCode: 187, text: "+" });
    });
  });

  // Second-pass review finding 5: a literal single space must resolve to the
  // Space key, not be trimmed away into an empty (invalid) spec.
  it("parses a literal single space as Space", () => {
    const parsed = parseKeySpec(" ");
    expect(parsed?.modifiers).toEqual({ alt: false, ctrl: false, meta: false, shift: false });
    expect(parsed?.descriptor).toEqual({ key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " });
  });

  // Review finding 2: Shift+letter must send the uppercase text a real
  // keyboard produces; Shift+digit/punctuation sends the shifted US-layout
  // symbol — code/virtual-key (physical key identity) stay the base key's.
  describe("Shift rewrites key/text to what a real keyboard would report (finding 2)", () => {
    it("Shift+a reports uppercase 'A' text/key, same physical KeyA code/vk", () => {
      const parsed = parseKeySpec("Shift+a");
      expect(parsed?.descriptor).toEqual({ key: "A", code: "KeyA", windowsVirtualKeyCode: 65, text: "A" });
    });

    it("Shift+A (already uppercase) is unaffected — no double-shift", () => {
      const parsed = parseKeySpec("Shift+A");
      expect(parsed?.descriptor).toEqual({ key: "A", code: "KeyA", windowsVirtualKeyCode: 65, text: "A" });
    });

    it("Shift+1 reports '!' as text/key, keeping Digit1's code/vk", () => {
      const parsed = parseKeySpec("Shift+1");
      expect(parsed?.descriptor).toEqual({ key: "!", code: "Digit1", windowsVirtualKeyCode: 49, text: "!" });
    });

    it("Shift+- reports '_' as text/key, keeping Minus's code/vk", () => {
      const parsed = parseKeySpec("Shift+-");
      expect(parsed?.descriptor).toEqual({ key: "_", code: "Minus", windowsVirtualKeyCode: 189, text: "_" });
    });

    it("Shift+Tab (a named, non-printable key) is unaffected", () => {
      const parsed = parseKeySpec("Shift+Tab");
      expect(parsed?.descriptor).toMatchObject({ key: "Tab", code: "Tab" });
      expect(parsed?.descriptor.text).toBeUndefined();
    });

    it("without Shift, case/symbol are passed through exactly as resolveNamedKey produced them", () => {
      const parsed = parseKeySpec("a");
      expect(parsed?.descriptor).toEqual({ key: "a", code: "KeyA", windowsVirtualKeyCode: 65, text: "a" });
    });
  });
});

describe("resolveEditCommand (finding 2 — macOS Chromium doesn't run editing commands off a synthesized Meta/Ctrl keydown)", () => {
  it("returns undefined without Meta or Ctrl", () => {
    expect(resolveEditCommand("a", { alt: false, ctrl: false, meta: false, shift: false })).toBeUndefined();
    expect(resolveEditCommand("a", { alt: false, ctrl: false, meta: false, shift: true })).toBeUndefined();
  });

  it("maps Meta/Ctrl + a/c/x/v to selectAll/copy/cut/paste", () => {
    const meta = { alt: false, ctrl: false, meta: true, shift: false };
    expect(resolveEditCommand("a", meta)).toEqual(["selectAll"]);
    expect(resolveEditCommand("c", meta)).toEqual(["copy"]);
    expect(resolveEditCommand("x", meta)).toEqual(["cut"]);
    expect(resolveEditCommand("v", meta)).toEqual(["paste"]);

    const ctrl = { alt: false, ctrl: true, meta: false, shift: false };
    expect(resolveEditCommand("a", ctrl)).toEqual(["selectAll"]);
  });

  it("maps z to undo, Shift+z and y to redo", () => {
    const meta = { alt: false, ctrl: false, meta: true, shift: false };
    expect(resolveEditCommand("z", meta)).toEqual(["undo"]);
    expect(resolveEditCommand("z", { ...meta, shift: true })).toEqual(["redo"]);
    expect(resolveEditCommand("y", meta)).toEqual(["redo"]);
  });

  it("is case-insensitive and returns undefined for keys outside the fixed list", () => {
    const meta = { alt: false, ctrl: false, meta: true, shift: false };
    expect(resolveEditCommand("A", meta)).toEqual(["selectAll"]);
    expect(resolveEditCommand("b", meta)).toBeUndefined();
  });
});

describe("modifiersBitmask", () => {
  it("combines bits per CDP's Input.dispatchKeyEvent convention (Alt=1, Ctrl=2, Meta=4, Shift=8)", () => {
    expect(modifiersBitmask({ alt: false, ctrl: false, meta: false, shift: false })).toBe(0);
    expect(modifiersBitmask({ alt: true, ctrl: false, meta: false, shift: false })).toBe(1);
    expect(modifiersBitmask({ alt: false, ctrl: true, meta: false, shift: false })).toBe(2);
    expect(modifiersBitmask({ alt: false, ctrl: false, meta: true, shift: false })).toBe(4);
    expect(modifiersBitmask({ alt: false, ctrl: false, meta: false, shift: true })).toBe(8);
    expect(modifiersBitmask({ alt: true, ctrl: true, meta: true, shift: true })).toBe(15);
  });
});
