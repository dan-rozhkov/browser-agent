import { botWallResult, detectBotWall } from "./browseCaptcha.js";
import { commitGuard } from "./browseCommitGuard.js";
import {
  BROWSE_STEP_OVERALL_DEADLINE_MS,
  MAX_SNAPSHOT_ELEMENTS,
  decideBrowseStep,
  type BrowseStepInput,
  type BrowseStepResult,
} from "./browseStep.js";
import { decideBrowseStepUltrafast } from "./browseStepUltrafast.js";
import { decideBrowseLocate, type BrowseLocateInput, type BrowseLocateResult } from "./browseLocate.js";
import { planBrowseGoal, type BrowsePlanResult } from "./browsePlan.js";
import { isJevModel, resolveDecisionModel, type DecisionClient } from "./decisions.js";
import {
  normalizeScreenshot,
  type BrowseLocateBody,
  type BrowsePlanBody,
  type BrowseStepBody,
} from "./schemas.js";
import type { TextModel } from "./textModel.js";

// What routes/browseStep.ts, browsePlan.ts and browseLocate.ts did around the
// policy (vision gate, screenshot normalisation, bot wall → policy → commit
// guard with the remaining budget), minus Fastify: body validation is the
// caller's job (the schemas in ./schemas.ts), and so is stripping `diag`
// (server-side diagnostics, never part of an HTTP contract).

/** Replaces the backend's `Config` for the policy layer. */
export interface BrowsePolicyOptions {
  decisions: DecisionClient;
  /** `structured` (was STRUCTURED_MODEL, legacy TYPE_TEXT) and `cascade`
   * (was BROWSE_CASCADE_MODEL: cascade, plan, ultrafast field text). */
  models: { structured: TextModel; cascade: TextModel };
  /** Was BROWSE_STEP_POLICY; default "ultrafast". */
  policy?: "ultrafast" | "legacy";
  /** Was BROWSE_STEP_VISION === "on". */
  vision?: boolean;
  /** Was TYPESAFE_MODEL — picks the Luna branch (`openai/...`) and blocks
   * screenshots for the text-only `jev*` models. */
  decisionModel?: string;
}

export async function decideStep(
  opts: BrowsePolicyOptions,
  body: BrowseStepBody,
): Promise<BrowseStepResult> {
  // System One "jev*" models are text-only: never send them an image.
  const decisionModel = resolveDecisionModel(opts);
  const visionBlocked = opts.vision === true && isJevModel(decisionModel);
  const visionOn = opts.vision === true && !visionBlocked;
  // Every reader below sees the one resolved decision model.
  const stepConfig: BrowsePolicyOptions = {
    ...opts,
    decisionModel,
    ...(visionBlocked ? { vision: false } : {}),
  };
  const startedAt = Date.now();
  const input: BrowseStepInput = {
    goal: body.goal,
    url: body.url,
    title: body.title,
    elements: body.elements.slice(0, MAX_SNAPSHOT_ELEMENTS),
    history: body.history,
    scroll: body.scroll,
    pageText: body.pageText,
    modal: body.modal,
    screenshot: visionOn ? normalizeScreenshot(body.screenshot) : undefined,
    permissions: body.permissions,
  };
  // Deterministic CAPTCHA guard, before either policy (no Jev call).
  const wall = detectBotWall(input);
  // Irreversible-action guard after either policy (one call site).
  return wall
    ? botWallResult(wall)
    : await commitGuard(
        opts.decisions,
        input,
        (opts.policy ?? "ultrafast") === "ultrafast"
          ? await decideBrowseStepUltrafast(opts.decisions, stepConfig, input)
          : await decideBrowseStep(opts.decisions, stepConfig, input),
        // The guard gets only what is left of the step budget.
        { timeoutMs: BROWSE_STEP_OVERALL_DEADLINE_MS + 1_000 - (Date.now() - startedAt) },
      );
}

/** Never throws for a model failure: falls back to `{ subgoals: [goal] }`
 * (with `fallbackReason`, which an HTTP layer should not send). The plan
 * timeout always applies; `signal` (a client hang-up, say) is combined with it. */
export function planGoal(
  opts: BrowsePolicyOptions,
  body: BrowsePlanBody,
  signal?: AbortSignal,
): Promise<BrowsePlanResult> {
  return planBrowseGoal(opts, body, signal);
}

export function locateTarget(
  opts: BrowsePolicyOptions,
  body: BrowseLocateBody,
): Promise<BrowseLocateResult> {
  const input: BrowseLocateInput = {
    description: body.description,
    operation: body.operation,
    url: body.url,
    title: body.title,
    elements: body.elements.slice(0, MAX_SNAPSHOT_ELEMENTS),
  };
  return decideBrowseLocate(opts.decisions, input);
}
