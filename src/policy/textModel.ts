import type { z } from "zod";

// The small structured-output text model the policy needs (was the AI SDK's
// `generateObject` + the backend's `createModel`). Isomorphic and vendor
// free: `adapters/aiSdk.ts` implements it over a Vercel AI SDK model; any
// other provider only has to satisfy this interface.

export interface TextModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TextModel {
  readonly id: string;
  generateObject<T>(req: {
    schema: z.ZodType<T>;
    prompt: string | TextModelMessage[];
    abortSignal?: AbortSignal;
  }): Promise<{ object: T; usage?: { inputTokens?: number; outputTokens?: number } }>;
}

/** The model answered, but not with an object matching the schema (was the
 * AI SDK's `NoObjectGeneratedError`). The cascade retries once on it. */
export class TextModelInvalidObjectError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TextModelInvalidObjectError";
  }

  static isInstance(error: unknown): boolean {
    return error instanceof TextModelInvalidObjectError;
  }
}
