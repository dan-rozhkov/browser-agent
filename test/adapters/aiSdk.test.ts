import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { aiSdkTextModel } from "../../src/adapters/aiSdk.js";
import { TextModelInvalidObjectError } from "../../src/policy/textModel.js";

const schema = z.object({ text: z.string() });

function modelAnswering(text: string, seen?: { prompt?: unknown; abortSignal?: AbortSignal }) {
  return new MockLanguageModelV3({
    doGenerate: async (options: { prompt?: unknown; abortSignal?: AbortSignal }) => {
      if (seen) {
        seen.prompt = options.prompt;
        seen.abortSignal = options.abortSignal;
      }
      return {
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 4, text: 4, reasoning: undefined },
        },
        warnings: [] as never[],
        content: [{ type: "text", text }],
      };
    },
  });
}

describe("aiSdkTextModel", () => {
  it("returns the parsed object and the token usage for valid JSON", async () => {
    const model = aiSdkTextModel(modelAnswering(JSON.stringify({ text: "hello" })));
    const result = await model.generateObject({ schema, prompt: "say hello" });
    expect(result.object).toEqual({ text: "hello" });
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
  });

  it("passes the prompt and the abort signal to the model", async () => {
    const seen: { prompt?: unknown; abortSignal?: AbortSignal } = {};
    const model = aiSdkTextModel(modelAnswering(JSON.stringify({ text: "x" }), seen));
    const controller = new AbortController();
    await model.generateObject({ schema, prompt: "the prompt text", abortSignal: controller.signal });
    expect(JSON.stringify(seen.prompt)).toContain("the prompt text");
    expect(seen.abortSignal).toBeDefined();
  });

  it("accepts a message list as the prompt", async () => {
    const seen: { prompt?: unknown } = {};
    const model = aiSdkTextModel(modelAnswering(JSON.stringify({ text: "x" }), seen));
    await model.generateObject({
      schema,
      prompt: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi there" },
      ],
    });
    const prompt = JSON.stringify(seen.prompt);
    expect(prompt).toContain("be brief");
    expect(prompt).toContain("hi there");
  });

  it("maps invalid JSON (twice in a row) to TextModelInvalidObjectError", async () => {
    const model = aiSdkTextModel(modelAnswering("this is not json"));
    for (let attempt = 0; attempt < 2; attempt++) {
      const err = await model.generateObject({ schema, prompt: "p" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TextModelInvalidObjectError);
      expect(TextModelInvalidObjectError.isInstance(err)).toBe(true);
      expect((err as Error).cause).toBeDefined();
    }
  });

  it("maps JSON that does not match the schema to TextModelInvalidObjectError", async () => {
    const model = aiSdkTextModel(modelAnswering(JSON.stringify({ wrong: 1 })));
    await expect(model.generateObject({ schema, prompt: "p" })).rejects.toBeInstanceOf(
      TextModelInvalidObjectError,
    );
  });

  it("rethrows other errors untouched", async () => {
    const boom = new Error("provider down");
    const model = aiSdkTextModel(
      new MockLanguageModelV3({
        doGenerate: async () => {
          throw boom;
        },
      }),
    );
    const err = await model.generateObject({ schema, prompt: "p" }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TextModelInvalidObjectError);
    expect(err).toBeDefined();
  });

  it("exposes the model id (explicit or from the model)", () => {
    expect(aiSdkTextModel(modelAnswering("{}"), { id: "my-id" }).id).toBe("my-id");
    expect(aiSdkTextModel(modelAnswering("{}")).id).toBe("mock-model-id");
  });
});

describe("TextModelInvalidObjectError.isInstance", () => {
  it("is false for other errors and non-errors", () => {
    expect(TextModelInvalidObjectError.isInstance(new Error("x"))).toBe(false);
    expect(TextModelInvalidObjectError.isInstance(undefined)).toBe(false);
    expect(TextModelInvalidObjectError.isInstance(new TextModelInvalidObjectError("x"))).toBe(true);
  });
});
