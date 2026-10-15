// Pen Editor's host text for the browse tool descriptions, captured from
// pen-editor-backend/src/ai/tools.ts and src/ai/system-prompt.ts on 2026-10-15.
// Passing these slots to the package must give back today's strings byte for byte.
import { z } from "zod";
import {
  browseScreenshotInputSchema,
  createBrowseToolDefinitions,
  type BrowseDescriptionSlots,
} from "../../src/agent/index.js";

export const PEN_EDITOR_DESCRIPTION_SLOTS: BrowseDescriptionSlots = {
  elementTargeting: true,
  taskHint: "If browse_task is in your tool set, start browser tasks with it and use this tool for finishing or follow-up; if it is not, drive the browser with this tool directly (see Browser tasks in the system prompt).",
  openIntro: "If browse_task is in your tool set, start browser tasks with it and use this tool for finishing or follow-up; if it is not, drive the browser with this tool directly (see Browser tasks in the system prompt). Opening a page the user just wants to look at is fine.",
  openLead: "Opens the built-in browser tab (a REAL browser tab — in the desktop app it runs on the user's OWN logged-in session, cookies and all; in the web app it is a fresh cloud browser with no logins) and navigate it to",
  openReach: "This is how you reach outside references the canvas can't otherwise see: a Pinterest search URL (e.g. \"https://www.pinterest.com/search/pins/?q=minimal%20fintech%20app%20ui\") is the worked example — search results load as an infinite-scroll image grid you then read with browse_find_images.",
  snapshotStaleCauses: "browse_snapshot, browse_screenshot with annotate, or browse_task again",
  screenshotVisionNote: "on a text-only model this costs a second vision-model call that returns a description rather than the image itself, same as get_screenshot",
  screenshotPlacement: "When the user asks to capture, save, or put a browser page on the canvas or as a reference, call this tool with `placeOnCanvas: true`. The result then adds `placedNodeId`, the id of the new canvas layer, and the image is also returned to you as usual.",
  scrollExample: " like Pinterest's",
  imagesUsage: "The returned URLs go straight onto the canvas: imageFill.url already accepts remote http(s) URLs (falling back to the image proxy when direct loading trips CORS), so no download step is needed.",
  imagesGridExample: " (Pinterest et al.)",
  readHow: "This is how you read a page you've already navigated to with browse_open/browse_task: once the browser is sitting on the page you need, call this INSTEAD OF falling back to web_search for the same information — web_search only re-finds pages you can already see, and cannot read this one's actual current content (a search result, a filtered listing, anything behind a click).",
};

export const PEN_EDITOR_PRINCIPAL = "a design assistant";

/** Guidance bullet that both the manual guidance and the subagent prompt carry. */
export const PEN_EDITOR_SCREENSHOT_BULLET =
  "- To put a screenshot of the browser page on the canvas, call `browse_screenshot` with `placeOnCanvas: true`.";
/** Guidance bullet only the manual guidance carries. */
export const PEN_EDITOR_CAPTURE_BULLET =
  "- To put an editable copy of the page on the canvas when the user asks for it, call `browse_capture`.";
/** Paragraph of the subagent prompt for the gated capture tool. */
export const PEN_EDITOR_CAPTURE_SECTION =
  "If browse_capture is in your tools, the user asked for a copy of a page on the canvas: get to the right page (and element), call browse_capture once, and report its nodeId.";

/** The three host-only fields of browse_screenshot. */
export const penEditorScreenshotSchema = browseScreenshotInputSchema.extend({
  placeOnCanvas: z.boolean().optional().describe("If true, also put the screenshot on the design canvas as a new image layer (a rectangle with an image fill, sized to the screenshot). The result then carries `placedNodeId`. The placed image never has the annotate labels on it. Default false."),
  x: z.number().optional().describe("Canvas position (absolute) for the placed image's top-left corner. Only used with placeOnCanvas. If omitted, the image goes into empty space to the right of the existing content."),
  y: z.number().optional().describe("Canvas position (absolute) for the placed image's top-left corner. Only used with placeOnCanvas. If omitted, the image goes into empty space to the right of the existing content."),
});

/** The seven definitions as Pen Editor's backend composes them. */
export function penEditorToolDefinitions() {
  const defs = createBrowseToolDefinitions(PEN_EDITOR_DESCRIPTION_SLOTS);
  return { ...defs, browse_screenshot: { ...defs.browse_screenshot, inputSchema: penEditorScreenshotSchema } };
}
