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

const INVALID_OBJECT_MARKER = Symbol.for("@sideform/browser-agent.TextModelInvalidObjectError");

/** The model answered, but not with an object matching the schema (was the
 * AI SDK's `NoObjectGeneratedError`). The cascade retries once on it. */
export class TextModelInvalidObjectError extends Error {
  /** Marker for `isInstance`: survives duplicate copies of this package, where
   * `instanceof` would not (the AI SDK's errors work the same way). */
  readonly [INVALID_OBJECT_MARKER] = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TextModelInvalidObjectError";
  }

  static isInstance(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      (error as Record<symbol, unknown>)[INVALID_OBJECT_MARKER] === true
    );
  }
}
