// Types of the QA suite (docs/specs/2026-10-17-qa-suite-design.md). Type-only
// imports: this file adds nothing to a bundle.
import type { LanguageModel } from "ai";
import type { BrowseAgentStatus } from "../agent/result.js";
import type { RunBrowseAgentOptions } from "../agent/aiSdk.js";
import type { PageFixture } from "../fixture/types.js";
import type { OpenedBrowser } from "../loop/bridge.js";

export interface QaScenario {
  /** Unique in the suite; `[A-Za-z0-9_-]{1,64}` (short, and easy to name in a message). */
  id: string;
  title?: string;
  /** What to do and what to check ("Add 2 items, check the cart badge says 2"). */
  goal: string;
  /** Start URL. `url` and `fixture` together are an error (the `runBrowseAgent` rule). */
  url?: string;
  /** State of THIS scenario's browser. */
  fixture?: PageFixture;
  allowNetworkMocks?: boolean;
}

/** The browser of one scenario (same shape as `OpenedBrowser`). */
export type QaBrowser = OpenedBrowser;

export type QaOutcome = "passed" | "failed" | "inconclusive" | "error" | "setup_failed" | "aborted";

export interface QaStep {
  /** 1-based, in call order. */
  index: number;
  /** The tool the model called (`browse_read`, `browse_act`, ..., `qa_verdict`). */
  tool: string;
  /** The input the model gave; `text` values over 200 chars are cut. */
  args: unknown;
  ok: boolean;
  error?: string;
  ms: number;
}

export interface QaScreenshot {
  mediaType: string;
  base64: string;
}

export interface QaScenarioReport {
  id: string;
  title?: string;
  goal: string;
  outcome: QaOutcome;
  verdictReason?: string;
  /** The final answer of the agent. */
  answer: string;
  /** Absent when `openBrowser` threw or the scenario never started. */
  status?: BrowseAgentStatus;
  error?: string;
  setupStage?: string;
  steps: QaStep[];
  screenshot?: QaScreenshot;
  /** ISO time. */
  startedAt: string;
  durationMs: number;
}

export interface QaSuiteReport {
  startedAt: string;
  durationMs: number;
  concurrency: number;
  summary: { total: number } & Record<QaOutcome, number>;
  /** In input order, not finish order. */
  scenarios: QaScenarioReport[];
}

export interface RunQaSuiteOptions {
  model: LanguageModel;
  /** A fresh isolated browser per scenario. Called once per scenario; `close` is called in every outcome. `ctx.signal` is the suite signal: when it aborts while the call is pending, the suite stops waiting (outcome `aborted`) and closes the browser that arrives later. */
  openBrowser(scenario: QaScenario, ctx: { signal?: AbortSignal }): Promise<QaBrowser>;
  /** Default 3. Must be a number of at least 1 (else `runQaSuite` throws); `Infinity` means all at once. Clamped to the scenario count. */
  concurrency?: number;
  /** Aborts all running scenarios; scenarios that did not start get outcome "aborted". */
  signal?: AbortSignal;
  providerOptions?: Record<string, Record<string, unknown>>;
  /** Passed to every `runBrowseAgent` call. */
  agent?: Pick<
    RunBrowseAgentOptions,
    "maxRequests" | "deadlineMs" | "toolResultImages" | "screenshots" | "maxOutputTokens" | "toolDefinitions"
  >;
  /** Called when a scenario ends (progress). A throw or a rejection is ignored; the suite does not wait for it. */
  onScenarioDone?(report: QaScenarioReport): void | Promise<void>;
  /** Test seam. Default `Date.now`. */
  now?(): number;
}
