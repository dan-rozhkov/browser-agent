// Shared SystemOneClient fakes and answer builders for the browse-step
// (decideBrowseStep) and browse-locate (decideBrowseLocate) unit tests —
// decideBrowseLocate is a one-shot sibling of decideBrowseStep, sharing
// element caps/scrubbing and target-criterion rendering with it (see
// browseLocate.ts's header), so its test fixtures were byte-identical to
// browse-step.test.ts's before being pulled out here.
import type {
  SystemOneAnswer,
  SystemOneClient,
  SystemOneEvaluateParams,
  SystemOneQuestion,
} from "../../src/policy/decisions.js";
import type { BrowsePolicyOptions } from "../../src/policy/decide.js";
import { fakeTextModel } from "./structuredModelFakes.js";

/** Replaces the backend tests' `makeConfig`: BrowsePolicyOptions with fake
 * TextModels (see structuredModelFakes.ts) and a `decisions` client that
 * fails loudly — the policy functions under test take their System One client
 * as a separate argument, tests of decideStep pass `decisions` explicitly. */
export function makeOptions(overrides: Partial<BrowsePolicyOptions> = {}): BrowsePolicyOptions {
  return {
    decisions: {
      async evaluate() {
        throw new Error("makeOptions: unexpected decisions.evaluate call (pass `decisions`)");
      },
    },
    models: {
      structured: fakeTextModel("openrouter:deepseek/deepseek-v4.1-flash"),
      cascade: fakeTextModel("openrouter:google/gemini-2.5-flash"),
    },
    decisionModel: "jev-latest",
    ...overrides,
  };
}

// A fake SystemOneClient that answers every evaluate() call with the same
// `answers` record (e.g. `{ locate: choice(...) }` for browse-locate, or a
// full fan-out record for browse-step).
export function fakeClient(
  answers: Record<string, SystemOneAnswer>,
  opts: {
    model?: string;
    capture?: (params: SystemOneEvaluateParams<Record<string, SystemOneQuestion>>) => void;
    throwError?: Error;
  } = {},
): SystemOneClient {
  return {
    async evaluate(params) {
      opts.capture?.(params);
      if (opts.throwError) throw opts.throwError;
      return {
        model: opts.model ?? "jev-latest",
        answers: answers as never,
        usage: { input_tokens: 100, output_tokens: 10 },
      };
    },
  };
}

/** `pick` wins with peak probability `peak` (the value the new gate reads).
 * `confidence` defaults to the same number — none of the tests below need
 * confidence and peak to diverge, since that divergence is a property of
 * option COUNT (see peakProbability's comment in browseStep.ts), not
 * something a hand-written fixture needs to model to exercise the gate. */
export function choice(
  pick: string,
  peak: number,
  opts: { confidence?: number; probabilities?: Record<string, number> } = {},
): SystemOneAnswer {
  return {
    type: "choice",
    choice: pick,
    probabilities: opts.probabilities ?? { [pick]: peak },
    confidence: opts.confidence ?? peak,
  };
}

export function noul(value: number): SystemOneAnswer {
  return { type: "noul", noul: value };
}
