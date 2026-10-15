import { asSchema } from "ai";
import { describe, expect, it } from "vitest";
import {
  BROWSE_AGENT_TOOL_NAMES,
  browseToolDefinitions,
  buildBrowseAgentPrompt,
  buildManualBrowserGuidance,
  createBrowseToolDefinitions,
} from "../../src/agent/index.js";
import golden from "./golden/pen-editor-backend-2026-10-15.json" with { type: "json" };
import {
  PEN_EDITOR_CAPTURE_BULLET,
  PEN_EDITOR_CAPTURE_SECTION,
  PEN_EDITOR_PRINCIPAL,
  PEN_EDITOR_SCREENSHOT_BULLET,
  penEditorToolDefinitions,
} from "./penEditorFixtures.js";

// `golden` was dumped from pen-editor-backend (src/ai/system-prompt.ts and
// src/ai/tools.ts) on 2026-10-15, before the move. Pen Editor's host text,
// passed to the package, must give those strings back byte for byte.

describe("prompt byte identity", () => {
  it("rebuilds MANUAL_BROWSER_GUIDANCE", () => {
    const built = buildManualBrowserGuidance({
      extraBullets: [PEN_EDITOR_SCREENSHOT_BULLET, PEN_EDITOR_CAPTURE_BULLET],
    });
    expect(built).toBe(golden.MANUAL_BROWSER_GUIDANCE);
  });

  it("rebuilds BROWSE_AGENT_PROMPT", () => {
    const built = buildBrowseAgentPrompt({
      principal: PEN_EDITOR_PRINCIPAL,
      guidanceBullets: [PEN_EDITOR_SCREENSHOT_BULLET],
      sections: [PEN_EDITOR_CAPTURE_SECTION],
    });
    expect(built).toBe(golden.BROWSE_AGENT_PROMPT);
  });

  it("has a generic default without host words", () => {
    const text = buildBrowseAgentPrompt();
    expect(text).toContain("working for an assistant.");
    expect(text).not.toMatch(/canvas|browse_capture|design assistant/);
  });
});

describe("tool definitions byte identity", () => {
  const defs = penEditorToolDefinitions();

  it("covers the seven tools in order", () => {
    expect(Object.keys(golden.tools)).toEqual([...BROWSE_AGENT_TOOL_NAMES]);
    expect(Object.keys(browseToolDefinitions)).toEqual([...BROWSE_AGENT_TOOL_NAMES]);
  });

  for (const name of BROWSE_AGENT_TOOL_NAMES) {
    it(`${name}: description`, () => {
      expect(defs[name].description).toBe(golden.tools[name].description);
    });

    it(`${name}: JSON schema`, () => {
      const json = asSchema(defs[name].inputSchema).jsonSchema;
      expect(JSON.stringify(json)).toBe(JSON.stringify(golden.tools[name].jsonSchema));
    });
  }
});

describe("neutral definitions", () => {
  it("carry no host words", () => {
    for (const name of BROWSE_AGENT_TOOL_NAMES) {
      expect(browseToolDefinitions[name].description, name).not.toMatch(/onto the canvas|canvas can|Pinterest|browse_task|web_search|placeOnCanvas|imageFill|desktop app/);
    }
  });

  it("keep the schemas that need no host field", () => {
    for (const name of BROWSE_AGENT_TOOL_NAMES.filter((n) => n !== "browse_screenshot" && n !== "browse_act")) {
      expect(JSON.stringify(asSchema(browseToolDefinitions[name].inputSchema).jsonSchema)).toBe(
        JSON.stringify(golden.tools[name].jsonSchema),
      );
    }
    const shot = asSchema(browseToolDefinitions.browse_screenshot.inputSchema).jsonSchema as { properties: object };
    expect(Object.keys(shot.properties)).toEqual(["annotate"]);
  });

  it("browse_act has no element targeting: no field, no text", () => {
    const json = JSON.stringify(asSchema(browseToolDefinitions.browse_act.inputSchema).jsonSchema);
    expect(json).not.toContain('"element"');
    expect(json).not.toContain("resolved.snapshotId");
    const text = browseToolDefinitions.browse_act.description;
    expect(text).not.toMatch(/`element`|resolved|re-snapshots/);
    expect(text).toContain("more reliable than text matching once you have a snapshot. Scrolling");
    expect(text).toContain("optionally focusing `target`/`index` first");
    expect(text).toContain("`select` needs `index`+`snapshotId` and `text`");
  });

  it("the golden schema is the neutral one plus the element fields, key order kept", () => {
    const withEl = JSON.stringify(asSchema(createBrowseToolDefinitions({ elementTargeting: true }).browse_act.inputSchema).jsonSchema);
    expect(withEl).toBe(JSON.stringify(golden.tools.browse_act.jsonSchema));
  });
});
