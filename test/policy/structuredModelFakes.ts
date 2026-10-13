// Shared `createModel` mock for routes/helpers that call `generateObject()`
// against a small structured-output model (STRUCTURED_MODEL) rather than
// streaming chat: prototype-link.test.ts, user-skills-route.test.ts, and
// browse-step(-route).test.ts's TYPE_TEXT/SELECT cascade calls all scripted
// their own byte-identical `createModel` + `vi.mock("../src/ai/provider.js",
// ...)` pair before this file existed.
//
// HOISTING CONTRACT — same as chatMocks.ts. `vi.mock` calls are hoisted
// above every import in a test file, so a factory cannot close over a
// statically imported binding. Each test file must write:
//
//   vi.mock("../src/ai/provider.js", async (importOriginal) =>
//     (await import("./structuredModelFakes.js")).mockProviderModule(await importOriginal()));
//
// and separately `import { createModel, jsonModel } from "./structuredModelFakes.js"`
// normally — the factory's dynamic import and the file's static import
// resolve to the SAME module instance (vitest isolates the module graph per
// test file, so `createModel`'s mock state never leaks between files).
import { vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";

// A one-shot structured-output response containing `json` as the model's
// entire text output (generateObject parses this as the schema result).
// Tests script a different response per case with
// `createModel.mockImplementationOnce/mockReturnValueOnce(() => jsonModel(...))`,
// exactly like they did with their own local MockLanguageModelV3 literal.
export function jsonModel(json: unknown): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
      content: [{ type: "text", text: JSON.stringify(json) }],
    }),
  });
}

// The vi.fn() itself, so call sites can set a default implementation at
// module scope (`createModel.mockImplementation(() => jsonModel({...}))`)
// and still use `.mockClear()`/`.mockImplementationOnce()`/
// `.mockReturnValueOnce()`/`expect(createModel).toHaveBeenCalled()` per test,
// same as when it was a local const.
export const createModel = vi.fn();

// Only createModel is faked — every other export (bareModelId,
// parseModelRef, ...) stays the REAL implementation, since GET /api/models
// (registered by the same buildApp in the route-level tests) resolves the
// model list through it.
export function mockProviderModule<T extends object>(actual: T): T {
  return { ...actual, createModel: (...args: unknown[]) => createModel(...(args as [])) };
}

// Scripts the NEXT createModel() call to answer `json`, capturing the
// abortSignal and prompt its generation was given — for tests asserting
// what a small structured-model call was told and how it was bounded.
export function mockJsonModelOnce(json: unknown): {
  seenSignal: () => AbortSignal | undefined;
  seenPrompt: () => string;
} {
  let seenSignal: AbortSignal | undefined;
  let seenPrompt = "";
  createModel.mockImplementationOnce(
    () =>
      new MockLanguageModelV3({
        doGenerate: async (options: { abortSignal?: AbortSignal; prompt?: unknown }) => {
          seenSignal = options.abortSignal;
          seenPrompt = JSON.stringify(options.prompt ?? "");
          return {
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            warnings: [],
            content: [{ type: "text", text: JSON.stringify(json) }],
          };
        },
      }),
  );
  return { seenSignal: () => seenSignal, seenPrompt: () => seenPrompt };
}
