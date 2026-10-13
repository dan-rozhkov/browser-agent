// The System One ("Jev" / OpenAI Decisions) contract: question/answer types,
// the result shape, the error hierarchy and the model-name predicates.
// Vendor-neutral and isomorphic — the policy layer depends on this file, the
// HTTP client (adapters/systemoneHttp.ts) implements `SystemOneClient`.

// --- Question types (request side) -----------------------------------

// The vendor accepts structured JSON here as well as plain text —
// jev-ultrafast sends `{ goal, rules }` objects as instructions and per-option
// objects (label + current value + state) as choice criteria.
export type SystemOneInstructions = string | Record<string, unknown>;

export interface SystemOneNoulQuestion {
  type: "noul";
  instructions: SystemOneInstructions;
  criteria?: { true?: string; false?: string };
}

export interface SystemOneChoiceQuestion {
  type: "choice";
  instructions: SystemOneInstructions;
  // Option -> description. A null description is allowed by the vendor, and
  // so is a structured object.
  criteria: Record<string, string | null | Record<string, unknown>>;
}

export interface SystemOneScoreQuestion {
  type: "score";
  instructions: SystemOneInstructions;
  // Ordered level descriptions, low to high. At least 2.
  criteria: string[];
}

export type SystemOneQuestion =
  | SystemOneNoulQuestion
  | SystemOneChoiceQuestion
  | SystemOneScoreQuestion;

// --- Answer types (response side) -------------------------------------

export interface SystemOneNoulAnswer {
  type: "noul";
  // 0..1 probability of "yes". No confidence field — the vendor never sends
  // one for this answer kind.
  noul: number;
}

export interface SystemOneChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface SystemOneScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type SystemOneAnswer =
  | SystemOneNoulAnswer
  | SystemOneChoiceAnswer
  | SystemOneScoreAnswer;

export type SystemOneAnswers = Record<string, SystemOneAnswer>;

// --- Errors --------------------------------------------------------------

export class SystemOneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SystemOneError";
  }
}

export class SystemOneAuthError extends SystemOneError {
  constructor(message: string) {
    super(message);
    this.name = "SystemOneAuthError";
  }
}

export class SystemOneValidationError extends SystemOneError {
  constructor(message: string) {
    super(message);
    this.name = "SystemOneValidationError";
  }
}

export class SystemOneRateLimitError extends SystemOneError {
  constructor(message: string) {
    super(message);
    this.name = "SystemOneRateLimitError";
  }
}

export class SystemOneUpstreamError extends SystemOneError {
  constructor(message: string) {
    super(message);
    this.name = "SystemOneUpstreamError";
  }
}

/** The vendor's exact refusal: HTTP 502 with
 * `{"error":{"message":"OpenAI refused to answer question \"<id>\"","code":502}}`.
 * Any other 502 stays a plain SystemOneUpstreamError. */
export class SystemOneRefusalError extends SystemOneUpstreamError {
  constructor(
    message: string,
    readonly questionId: string,
  ) {
    super(message);
    this.name = "SystemOneRefusalError";
  }
}


// --- Client ---------------------------------------------------------------

export interface SystemOneEvaluateParams<
  Q extends Record<string, SystemOneQuestion>,
> {
  state: string | Record<string, unknown> | unknown[];
  questions: Q;
  signal?: AbortSignal;
}

export interface SystemOneResult<Q extends Record<string, SystemOneQuestion>> {
  model: string;
  /** A question the vendor refused to answer is ABSENT here (never filled
   * with a made-up value): callers must treat a missing key as "no answer"
   * and take their fail-safe path. */
  answers: Partial<Record<keyof Q, SystemOneAnswer>>;
  /** Ids of the questions dropped because the vendor refused them. */
  refused?: string[];
  usage: { input_tokens: number; output_tokens: number };
}

export interface SystemOneClient {
  evaluate<Q extends Record<string, SystemOneQuestion>>(
    params: SystemOneEvaluateParams<Q>,
  ): Promise<SystemOneResult<Q>>;
}

/** OpenAI Decisions models ("Luna", `openai/...`). Case-insensitive. */
export function isOpenAIDecisions(model: string | undefined): boolean {
  return (model ?? "").toLowerCase().startsWith("openai/");
}

/** System One "jev*" models (text-only). Case-insensitive. */
export function isJevModel(model: string | undefined): boolean {
  return (model ?? "").toLowerCase().startsWith("jev");
}

// Vendor-neutral names for the same contract (the old `SystemOne*` names stay
// as the canonical ones so the moved code and tests change little).
export type DecisionClient = SystemOneClient;
export type DecisionQuestion = SystemOneQuestion;
export type DecisionAnswer = SystemOneAnswer;
