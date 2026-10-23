import { generateObject, NoObjectGeneratedError, type LanguageModel } from "ai";
import {
  TextModelInvalidObjectError,
  type TextModel,
  type TextModelMessage,
} from "../policy/textModel.js";

/** AI SDK 7 rejects system messages inside `messages`, so the leading ones
 * move to `system` (accepted by both 6 and 7). A system message after the
 * first non-system one stays where it is. */
function splitLeadingSystem(messages: TextModelMessage[]): { system?: string; messages: TextModelMessage[] } {
  const firstOther = messages.findIndex((m) => m.role !== "system");
  const cut = firstOther === -1 ? messages.length : firstOther;
  if (cut === 0) return { messages };
  return {
    system: messages
      .slice(0, cut)
      .map((m) => m.content)
      .join("\n\n"),
    messages: messages.slice(cut),
  };
}

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
            : await generateObject({ ...common, ...splitLeadingSystem(req.prompt) });
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
