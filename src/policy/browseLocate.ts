import type {
  SystemOneAnswer,
  SystemOneClient,
  SystemOneQuestion,
} from "./decisions.js";
import { scrubPii } from "./pii.js";
import {
  BROWSE_STEP_TIMEOUT_MS,
  PEAK_THRESHOLD_TARGET,
  capAndScrubElements,
  elementCriterionLabel,
  hasProbabilities,
  isActionable,
  peakProbability,
  truncateLabel,
  type BrowseStepElement,
} from "./browseStep.js";

// POST /api/browse/locate's decision core — a one-shot sibling of
// decideBrowseStep (browseStep.ts): resolve a natural-language element
// description to a single element index with ONE Jev Choice call, for
// browse_act's `element` field (tools.ts). Where decideBrowseStep answers
// "what should happen next" from a goal and full page state across many
// steps, this answers one narrower question — "which of these elements is
// THE ONE the caller already described in words" — against a single fresh
// snapshot, so it reuses decideBrowseStep's element scrubbing/truncation
// (capAndScrubElements) and its target-head criterion rendering
// (elementCriterionLabel) rather than re-deriving either. See
// docs/superpowers/specs/2026-09-23-full-browser-use-design.md for the
// bridge-side contract this sits behind, and browseStep.ts's own header for
// the shared Jev/vendor conventions (peak-probability gating, PII
// scrubbing, fail-open on transport errors).

/** The browse_act operations `element` can be resolved for. HOVER is
 * accepted here even though it has no `ops` entry of its own on an
 * element — like decideBrowseStep's target_click head, a HOVER lookup
 * reuses the CLICK candidate set (see isCandidateFor below), since hovering
 * is only ever meaningful on something also clickable/focusable. FOCUS is
 * browse_act's `press` action's element-targeting operation: pressing a key
 * (Enter, Tab, …) can meaningfully target a button, a text input, or a
 * `<select>` alike, so it accepts ANY of CLICK/TYPE_TEXT/SELECT rather than
 * being pinned to one — resolving `press` against CLICK alone (the old
 * behavior) could never match a text input, which is exactly the field
 * Enter is usually pressed in. */
export type BrowseLocateOperation = "CLICK" | "TYPE_TEXT" | "SELECT" | "HOVER" | "FOCUS";

export interface BrowseLocateInput {
  description: string;
  operation: BrowseLocateOperation;
  url: string;
  title: string;
  elements: BrowseStepElement[];
}

export type BrowseLocateResult =
  | { outcome: "found"; index: number; label: string; confidence: number; model: string }
  | { outcome: "not_found"; reason: string; confidence: number; model: string }
  // Transient — a Jev timeout or a malformed answer. No `confidence`/`model`:
  // there is no trustworthy reading of either from a call that didn't
  // resolve. Mirrors decideBrowseStep's `retry()` outcome/shape.
  | { outcome: "retry"; reason: string };

const LOCATE_ID = "locate";

/** Choice criterion key for "none of the listed elements matches" — a
 * dedicated escape hatch so Jev has somewhere to put its probability mass
 * when the description genuinely doesn't match anything on the page,
 * rather than being forced to pick SOME element and relying entirely on
 * the peak-probability gate to catch a bad forced pick. Element criteria
 * are always keyed by a nonnegative integer's string form (`String(el.index)`,
 * `el.index: z.number().int().nonnegative()` in routes/browseStep.ts's
 * elementSchema), so this key can never collide with one. Picking it as the
 * Choice's peak resolves to `not_found`, same as a below-threshold peak —
 * see the peak-gate check below, which still runs first and applies
 * regardless of which key wins. */
const NONE_CRITERION_KEY = "none";

/** Whether `el` is a candidate for a given browse_act/locate operation —
 * identity for CLICK/TYPE_TEXT/SELECT, CLICK for HOVER (elements never
 * carry a `HOVER` op themselves — see decideBrowseStep's `targetHeadFor`
 * for the same borrowing on the browse_task side), and for FOCUS, ANY of
 * CLICK/TYPE_TEXT/SELECT — see BrowseLocateOperation's comment on FOCUS. */
function isCandidateFor(operation: BrowseLocateOperation, el: BrowseStepElement): boolean {
  if (operation === "HOVER") return isActionable(el, "CLICK");
  if (operation === "FOCUS") return !el.disabled && el.ops.length > 0;
  return isActionable(el, operation);
}

function notFound(reason: string, confidence: number, model: string): BrowseLocateResult {
  return { outcome: "not_found", reason, confidence, model };
}

function retry(reason: string): BrowseLocateResult {
  return { outcome: "retry", reason };
}

/**
 * Resolves `input.description` to one element index with a single Jev
 * Choice call. Never throws — a transport/parse failure or a malformed
 * answer resolves to `retry`, exactly like decideBrowseStep, since guessing
 * on a live page is worse than stopping (the caller — browse_act's
 * `element` handling — is expected to surface that to the model as "try
 * again with target/index instead").
 */
export async function decideBrowseLocate(
  client: SystemOneClient,
  input: BrowseLocateInput,
): Promise<BrowseLocateResult> {
  const scrubbedDescription = scrubPii(input.description);
  const scrubbedUrl = scrubPii(input.url);
  const scrubbedTitle = scrubPii(input.title);
  const scrubbedElements = capAndScrubElements(input.elements);

  const candidates = scrubbedElements.filter((el) => isCandidateFor(input.operation, el));
  if (candidates.length === 0) {
    // No `client.evaluate()` call at all — a `choice` question cannot be
    // asked with empty criteria (same rule buildBrowseStepQuestions
    // follows), and there is genuinely nothing to resolve against.
    return notFound(
      `no element on the page supports "${input.operation}", so "${truncateLabel(scrubbedDescription, 120)}" cannot be matched to one`,
      0,
      "",
    );
  }

  const criteria: Record<string, string | null> = {};
  for (const el of candidates) {
    criteria[String(el.index)] = elementCriterionLabel(el);
  }
  criteria[NONE_CRITERION_KEY] = "None of the listed elements matches the description.";

  const questions: Record<string, SystemOneQuestion> = {
    [LOCATE_ID]: {
      type: "choice",
      instructions: `Given the page below, which element best matches this description: "${truncateLabel(scrubbedDescription, 300)}"?`,
      criteria,
    },
  };

  let model: string;
  let answer: SystemOneAnswer | undefined;
  try {
    const result = await client.evaluate({
      state: { url: scrubbedUrl, title: scrubbedTitle, description: scrubbedDescription },
      questions,
      signal: AbortSignal.timeout(BROWSE_STEP_TIMEOUT_MS),
    });
    model = result.model;
    answer = result.answers[LOCATE_ID];
  } catch (err) {
    // Transient, same class as decideBrowseStep's main-call catch.
    return retry(
      `browse locate evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!answer || answer.type !== "choice") {
    return retry(`unexpected answer type "${answer?.type ?? "missing"}" for locate`);
  }
  if (!hasProbabilities(answer)) {
    return retry("the locate answer's probability distribution was empty");
  }

  const peak = peakProbability(answer);
  if (peak < PEAK_THRESHOLD_TARGET) {
    return notFound(
      `"${truncateLabel(scrubbedDescription, 120)}" did not clearly match any element on the page (peak probability below the ${PEAK_THRESHOLD_TARGET} threshold)`,
      peak,
      model,
    );
  }

  // Membership check, not Number() coercion — same reasoning as
  // decideBrowseStep's target-index validation: a blank or unknown choice
  // must not silently resolve to element 0.
  if (!Object.prototype.hasOwnProperty.call(criteria, answer.choice)) {
    return retry(`Jev picked an unknown element index "${answer.choice}" for locate`);
  }

  // NONE_CRITERION_KEY winning the Choice (as the peak, having already
  // cleared PEAK_THRESHOLD_TARGET above) is a considered "none of these"
  // judgment, not a malformed answer — resolve it the same way a
  // below-threshold peak resolves: not_found.
  if (answer.choice === NONE_CRITERION_KEY) {
    return notFound(
      `none of the elements on the page matched "${truncateLabel(scrubbedDescription, 120)}"`,
      peak,
      model,
    );
  }

  const index = Number(answer.choice);
  const element = candidates.find((el) => el.index === index);
  if (!element) {
    return retry(`Jev picked element index "${answer.choice}" for locate but no matching element was found`);
  }

  // Hard rule, not a threshold — same as decideBrowseStep's TYPE_TEXT
  // credentials guard: never resolve `element` to a password field for
  // TYPE_TEXT, and never for FOCUS either — pressing Enter or any other key
  // into a password field is exactly as forbidden as typing text into one.
  // The user logs in themselves in the visible tab.
  if ((input.operation === "TYPE_TEXT" || input.operation === "FOCUS") && element.isPassword) {
    return notFound(
      "the best match is a password field, and this agent never types into or sends key presses to password fields — the user must log in themselves",
      peak,
      model,
    );
  }

  return {
    outcome: "found",
    index: element.index,
    label: truncateLabel(element.label, 160),
    confidence: peak,
    model,
  };
}
