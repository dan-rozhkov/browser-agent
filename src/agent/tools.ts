import type { ZodTypeAny } from "zod";
import {
  describeBrowseAct,
  describeBrowseFindImages,
  describeBrowseOpen,
  describeBrowseRead,
  describeBrowseScreenshot,
  describeBrowseSnapshot,
  describeBrowseTabs,
  type BrowseDescriptionSlots,
} from "./descriptions.js";
import {
  createBrowseActInputSchema,
  browseFindImagesInputSchema,
  createBrowseOpenInputSchema,
  browseReadInputSchema,
  browseScreenshotInputSchema,
  browseSnapshotInputSchema,
  browseTabsInputSchema,
} from "./schemas.js";

import { BROWSE_AGENT_TOOL_NAMES, type BrowseAgentToolName } from "./toolNames.js";

export { BROWSE_AGENT_TOOL_NAMES, type BrowseAgentToolName };

export interface BrowseToolDefinition {
  description: string;
  inputSchema: ZodTypeAny;
}

export type BrowseToolDefinitions = Record<BrowseAgentToolName, BrowseToolDefinition>;

/**
 * The definitions of the seven tools. `slots` carries the host text of the
 * descriptions (see `BrowseDescriptionSlots`); without it the descriptions are
 * neutral and `browse_act` has no `element` field (`slots.elementTargeting` adds the
 * field and its text). To add host fields to a schema, replace the entry:
 * `{ ...defs.browse_screenshot, inputSchema: browseScreenshotInputSchema.extend({...}) }`.
 */
export function createBrowseToolDefinitions(slots: BrowseDescriptionSlots = {}): BrowseToolDefinitions {
  return {
    browse_open: { description: describeBrowseOpen(slots), inputSchema: createBrowseOpenInputSchema({ appLaunch: slots.appLaunch === true }) },
    browse_snapshot: { description: describeBrowseSnapshot(slots), inputSchema: browseSnapshotInputSchema },
    browse_screenshot: { description: describeBrowseScreenshot(slots), inputSchema: browseScreenshotInputSchema },
    browse_act: { description: describeBrowseAct(slots), inputSchema: createBrowseActInputSchema({ elementTargeting: slots.elementTargeting === true, coordinates: slots.coordinateActions === true }) },
    browse_tabs: { description: describeBrowseTabs(), inputSchema: browseTabsInputSchema },
    browse_find_images: { description: describeBrowseFindImages(slots), inputSchema: browseFindImagesInputSchema },
    browse_read: { description: describeBrowseRead(slots), inputSchema: browseReadInputSchema },
  };
}

/** The neutral definitions (no host text). */
export const browseToolDefinitions: BrowseToolDefinitions = createBrowseToolDefinitions();
