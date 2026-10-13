// Shared fake TextModels for tests whose policy code calls a small
// structured-output model (generateObject) rather than System One: the
// TYPE_TEXT / SELECT / cascade / plan / field-text calls of browse-step,
// browse-step-ultrafast and browse-plan. They used to script a `createModel`
// mock via vi.mock of the backend's provider module; now the models are
// injected through BrowsePolicyOptions (see makeOptions in browseFakes.ts),
// built with aiSdkTextModel over a MockLanguageModelV3 so the AI SDK
// generateObject + error mapping path stays real.
import { vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { aiSdkTextModel } from "../../src/adapters/aiSdk.js";
import type { TextModel } from "../../src/policy/textModel.js";

// The parts of a LanguageModelV3 generate result every fake here shares
// (a clean stop, 1+1 tokens, no warnings) — spread it and add `content`.
export const generateResultBase = {
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  },
  warnings: [] as never[],
};

// A one-shot structured-output response containing `json` as the model's
// entire text output (generateObject parses this as the schema result).
// Tests script a different response per case with
// `textModelCalls.mockImplementationOnce/mockReturnValueOnce(() => jsonModel(...))`.
export function jsonModel(json: unknown): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      ...generateResultBase,
      content: [{ type: "text", text: JSON.stringify(json) }],
    }),
  });
}

// Called once at the start of EVERY generateObject() of a fake TextModel
// (structured and cascade roles share it) and returns the model that call
// should be answered by — so `expect(textModelCalls).toHaveBeenCalled()` /
// `.not.toHaveBeenCalled()` asserts that a text-model generateObject did /
// did not happen, exactly like asserting on `createModel` did. Set a default
// implementation at module scope and use `.mockClear()` /
// `.mockImplementationOnce()` / `.mockReturnValueOnce()` per test.
export const textModelCalls = vi.fn();

/** A TextModel whose every generateObject() asks `textModelCalls` which
 * MockLanguageModelV3 answers it. A throw from `textModelCalls` surfaces from
 * generateObject, like a throwing `createModel` did. */
export function fakeTextModel(id: string): TextModel {
  return {
    id,
    async generateObject(req) {
      const model = textModelCalls() as MockLanguageModelV3;
      return aiSdkTextModel(model, { id }).generateObject(req);
    },
  };
}

// Scripts the NEXT generateObject() to answer `json`, capturing the
// abortSignal and prompt its generation was given — for tests asserting
// what a small structured-model call was told and how it was bounded.
export function mockJsonModelOnce(json: unknown): {
  seenSignal: () => AbortSignal | undefined;
  seenPrompt: () => string;
} {
  let seenSignal: AbortSignal | undefined;
  let seenPrompt = "";
  textModelCalls.mockImplementationOnce(
    () =>
      new MockLanguageModelV3({
        doGenerate: async (options: { abortSignal?: AbortSignal; prompt?: unknown }) => {
          seenSignal = options.abortSignal;
          seenPrompt = JSON.stringify(options.prompt ?? "");
          return {
            ...generateResultBase,
            content: [{ type: "text", text: JSON.stringify(json) }],
          };
        },
      }),
  );
  return { seenSignal: () => seenSignal, seenPrompt: () => seenPrompt };
}
