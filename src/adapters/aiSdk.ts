import { generateObject, NoObjectGeneratedError, type LanguageModel } from "ai";
import {
  TextModelInvalidObjectError,
  type TextModel,
} from "../policy/textModel.js";

/** Wraps a Vercel AI SDK `LanguageModel` as the policy's `TextModel`.
 * Provider routing (and options such as `reasoningEffort: "none"`) stay in
 * the host: pass a ready model, and `providerOptions` when needed. */
export function aiSdkTextModel(
  model: LanguageModel,
  opts: { id?: string; providerOptions?: Record<string, unknown> } = {},
): TextModel {
  const id = opts.id ?? (typeof model === "string" ? model : model.modelId);
  return {
    id,
    async generateObject(req) {
      try {
        const common = {
          model,
          schema: req.schema,
          abortSignal: req.abortSignal,
          providerOptions: opts.providerOptions as never,
        };
        const result =
          typeof req.prompt === "string"
            ? await generateObject({ ...common, prompt: req.prompt })
            : await generateObject({ ...common, messages: req.prompt });
        return {
          object: result.object as never,
          usage: {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
          },
        };
      } catch (e) {
        if (NoObjectGeneratedError.isInstance(e)) {
          throw new TextModelInvalidObjectError(e.message, { cause: e });
        }
        throw e;
      }
    },
  };
}
