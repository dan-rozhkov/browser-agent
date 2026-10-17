# @sideform/browser-agent

A goal-driven browser agent as a TypeScript library. Give it a goal and a
browser; it loops (snapshot the page, decide the next step, act) until the
goal is done, blocked, or out of budget, and returns a `Transcript`.

It has three layers and a set of adapters:

- **controller** – drives one browser tab (`BrowserController`: open, act,
  read, snapshot, perform, screenshot, tabs). Talks to a `BrowserTarget`.
- **policy** – decides the next step from a page snapshot (`decideStep`),
  splits multi-item goals (`planGoal`) and resolves element descriptions
  (`locateTarget`). Talks to a `DecisionClient` and two `TextModel`s.
- **loop** – `runBrowseTask`, the browse_task loop. Talks to a
  `BrowserBridge` (the browser) and a `BrowseBackend` (the policy).
- **adapters** – ready implementations of those interfaces. They live
  behind subpath exports because some need optional peer dependencies.

## Provenance

Copied, not redesigned, from the pen-editor stack:

| Layer | Source | Commit |
|---|---|---|
| controller | `pen-editor-desktop` `src/main/browser/*`, `src/main/navigation.ts` | `3d8f975` |
| policy, adapters | `pen-editor-backend` `src/ai/browse*.ts`, `src/browser/*`, `src/services/systemone.ts` | `53f710e` |
| loop | `pen-editor` `src/lib/tools/browser/*` | `792b4e30` |

Comments that cite pen-editor specs are the history of why a rule exists.
See `docs/design.md` for the design and `docs/migration-plan.md` for how the
three pen-editor repos move onto this package.

## Install

Install it from the Git repo by tag:

```bash
npm install github:dan-rozhkov/browser-agent#v0.2.18 # x-release-please-version
```

When the `NPM_TOKEN` secret is set, releases are also published to npm
as `@sideform/browser-agent`. `prepare` builds `dist/` on install. Peer dependencies are optional:
`playwright-core` (for `adapters/playwright`) and `ai` (for
`adapters/ai-sdk`). `zod` is a normal dependency. Node >= 20.

## Quick start

`examples/run-task.ts` runs a task with local Chromium (or `CDP_URL`),
System One decisions and two OpenRouter text models. See `examples/README.md`.

```bash
TYPESAFE_API_KEY=... OPENROUTER_API_KEY=... npm run example -- "open example.com and read the heading"
```

The core of it:

```ts
import { runBrowseTask, memoryStorage } from "@sideform/browser-agent";
import { controllerBridge } from "@sideform/browser-agent/adapters/controller-bridge";
import { createLocalBackend } from "@sideform/browser-agent/adapters/local-backend";
import { connectOverCdp } from "@sideform/browser-agent/adapters/playwright";
import { createSystemOneClient } from "@sideform/browser-agent/adapters/systemone-http";

const { controller, close } = await connectOverCdp(process.env.CDP_URL!);
const transcript = await runBrowseTask("find the cheapest laptop on example.com", {
  browser: controllerBridge(controller),
  backend: createLocalBackend({
    decisions: createSystemOneClient({ apiKey: process.env.TYPESAFE_API_KEY! }),
    models: { structured: myTextModel, cascade: myTextModel },
  }),
  storage: memoryStorage(),
});
await close();
```

## Architecture

```
               ┌──────────── loop (isomorphic) ────────────┐
 goal ───────► │ runBrowseTask(goal, { browser, backend }) │
               └──────┬────────────────────────┬───────────┘
          BrowserBridge│                        │BrowseBackend
     ┌─────────────────▼───┐        ┌───────────▼────────────────┐
     │ controllerBridge()  │        │ createLocalBackend()  OR   │
     │  (in-process)       │        │ createHttpBackend(baseUrl) │
     └─────────┬───────────┘        └───────────┬────────────────┘
               │                                 │ (local)
     ┌─────────▼───────────┐        ┌───────────▼────────────────┐
     │ BrowserController   │        │ policy: decideStep()       │
     │  BrowserTarget /    │        │  captcha → ultrafast|legacy│
     │  BrowserPageHandle  │        │  → commitGuard; plan;locate│
     └─────────┬───────────┘        └──────┬───────────┬─────────┘
     ┌─────────▼───────────┐     DecisionClient     TextModel
     │ PlaywrightTarget    │     ┌──────▼──────┐ ┌────▼──────────┐
     │ (connectOverCdp /   │     │ createSystem│ │ aiSdkTextModel│
     │  any BrowserContext)│     │ OneClient   │ │ (AI SDK model)│
     └─────────────────────┘     └─────────────┘ └───────────────┘
```

## Entry points

| Import | Contents |
|---|---|
| `@sideform/browser-agent` | controller + policy + loop + fixture barrels (no adapters) |
| `@sideform/browser-agent/controller` | controller layer |
| `@sideform/browser-agent/policy` | policy layer |
| `@sideform/browser-agent/loop` | loop layer |
| `@sideform/browser-agent/adapters/playwright` | `PlaywrightTarget`, `connectOverCdp`, `playwrightContexts` |
| `@sideform/browser-agent/adapters/systemone-http` | `createSystemOneClient` |
| `@sideform/browser-agent/adapters/ai-sdk` | `aiSdkTextModel` |
| `@sideform/browser-agent/adapters/http-backend` | `createHttpBackend` |
| `@sideform/browser-agent/adapters/local-backend` | `createLocalBackend` |
| `@sideform/browser-agent/adapters/controller-bridge` | `controllerBridge` |
| `@sideform/browser-agent/fixture` | `PageFixture` types, `parsePageFixture`, `applyFixture`, `captureFixture`, `CheckpointResult` (isomorphic, no zod) |
| `@sideform/browser-agent/agent` | the browse agent mode: prompt, tool definitions, limits, session core (zod only, no `ai`) |
| `@sideform/browser-agent/agent/session` | the light part of `/agent`: limits, result helpers, session core, `singleUseTool`. No zod, no schemas, no descriptions: use it in a browser bundle |
| `@sideform/browser-agent/agent/ai-sdk` | `runBrowseAgent` (peer: `ai`) |

**Name collisions at the root.** Two names exist in more than one layer.
The root barrel exports the controller's `MAX_SNAPSHOT_ELEMENTS` (both are
`120`) and the loop's `BrowsePermissions` (the type `runBrowseTask` takes).
The policy's versions stay available from `@sideform/browser-agent/policy`.

## API: layers

### controller

```ts
class BrowserController {
  constructor(target: BrowserTarget, opts?: { timeoutMs?: number; openTimeoutMs?: number;
    cursor?: boolean | (() => boolean); cursorMotion?: string | undefined | (() => string | undefined); /* ... */ });
  open(args: unknown): Promise<BrowserCommandResult>;
  act(args: unknown): Promise<BrowserCommandResult>;
  read(args: unknown): Promise<BrowserCommandResult>;
  snapshot(): Promise<BrowserCommandResult>;
  perform(args: unknown): Promise<BrowserCommandResult>;
  findImages(args: unknown): Promise<BrowserCommandResult>;
  screenshot(args: unknown): Promise<BrowserCommandResult>;
  tabs(args: unknown): Promise<BrowserCommandResult>;
  capture(args?: unknown): Promise<BrowserCommandResult>; // { html, width, height, url, title } of the page or one snapshot element
}
type BrowserCommandResult = Record<string, unknown>;
decideBrowserNavigation(targetUrl: string): "allow" | "deny";
```

Also exported: `BrowserTarget`, `BrowserPageHandle`, key helpers
(`parseKeySpec`, `resolveNamedKey`, `modifiersBitmask`, `resolveEditCommand`),
page scripts and timing constants (`BROWSER_COMMAND_TIMEOUT_MS`,
`MAX_SNAPSHOT_ELEMENTS`, ...). Commands never throw for a page failure; they
resolve `{ error }`.

### policy

```ts
interface BrowsePolicyOptions {
  decisions: DecisionClient;
  models: { structured: TextModel; cascade: TextModel };
  policy?: "ultrafast" | "legacy";   // default "ultrafast"
  vision?: boolean;
  decisionModel?: string;
}
decideStep(opts: BrowsePolicyOptions, body: BrowseStepBody): Promise<BrowseStepResult>;  // result carries `diag`
planGoal(opts: BrowsePolicyOptions, body: BrowsePlanBody, signal?: AbortSignal): Promise<BrowsePlanResult>; // never throws
locateTarget(opts: BrowsePolicyOptions, body: BrowseLocateBody): Promise<BrowseLocateResult>;
browseStepBodySchema, browsePlanBodySchema, browseLocateBodySchema   // zod, same as the HTTP routes
normalizeScreenshot(raw: string | undefined): string | undefined;
```

When neither `decisionModel` nor `DecisionClient.model` is set, the policy
assumes `jev-latest`: a text-only model, so screenshots are not sent and the
Luna branch is off. A custom vision-capable client must set one of them.

Lower-level pieces are exported too: `decideBrowseStep`,
`decideBrowseStepUltrafast`, `commitGuard`, `detectBotWall`/`botWallResult`,
`decideBrowseLocate`, `planBrowseGoal`, `scrubPii`/`containsPii`, the
System One types and error classes (`SystemOneError`,
`SystemOneRateLimitError`, ...), `isJevModel`, `TextModelInvalidObjectError`.

### loop

```ts
runBrowseTask(goal: string, opts: RunBrowseTaskOptions): Promise<Transcript>;
interface RunBrowseTaskOptions {
  browser: BrowserBridge;
  backend: BrowseBackend;
  maxSteps?: number;                 // per sub-goal, capped at 25
  url?: string;                      // open before the loop
  signal?: AbortSignal;
  permissions?: BrowsePermissions;   // { allowPasswordEntry?, confirmIrreversible? }
  storage?: KeyValueStorage;         // action cache; omitted = cache off
  cloud?: boolean;                   // remote browser: cloud deadlines
  stepScreenshots?: boolean;
  now?: () => number; sleep?: (ms: number) => Promise<void>;
  deadlineMs?: number; overallDeadlineMs?: number;
}
memoryStorage(): KeyValueStorage;
```

`runBrowseTask` never throws for a browser or backend failure; it resolves a
`Transcript` (`status`, steps, observations). Also exported: `runBrowseTaskLoop`,
`runBrowseTaskCore`, the deadline helpers and the action-cache, effect and
loop-guard modules.

## API: adapters

```ts
// adapters/playwright   (peer: playwright-core)
class PlaywrightTarget implements BrowserTarget { constructor(context: BrowserContext) }
connectOverCdp(cdpUrl: string): Promise<{ controller: BrowserController; close(): Promise<void>; onDisconnected(cb: () => void): void }>;
redactedError(e: unknown, secret: string): Error;
playwrightContexts(browser: Browser, contextOptions?: BrowserContextOptions, controllerOptions?: ConstructorParameters<typeof BrowserController>[1]): () => Promise<OpenedBrowser>;  // a new isolated context per call, for parallel runs

// adapters/systemone-http
createSystemOneClient(opts: { apiKey?: string; model?: string; baseUrl?: string;
  openRouterApiKey?: string; fetch?: typeof fetch; sleep?: (ms: number, signal: AbortSignal) => Promise<void> }): DecisionClient;

// adapters/ai-sdk   (peer: ai)
aiSdkTextModel(model: LanguageModel, opts?: { id?: string; providerOptions?: Record<string, unknown> }): TextModel;

// agent/ai-sdk   (peer: ai)
runBrowseAgent(goal: string, opts: { model: LanguageModel; browser: BrowserBridge; url?: string; signal?: AbortSignal;
  providerOptions?: Record<string, Record<string, unknown>>; extraTools?: Record<string, BrowseAgentExtraTool>;
  prompt?: string | BuildBrowseAgentPromptOptions; toolDefinitions?: BrowseToolDefinitions; screenshots?: boolean;
  toolResultImages?: boolean;
  maxRequests?: number; deadlineMs?: number; runId?: string; maxOutputTokens?: number;
  qa?: boolean | { onScreenshot?(img: { mediaType: string; base64: string }): void | Promise<void> };
  onToolCall?(call: { toolName: string; input: unknown; toolCallId: string; preOpen?: true }): ((result: { output?: string; error?: unknown }) => void) | void }): Promise<BrowseAgentResult>;

// adapters/http-backend
createHttpBackend(opts: { baseUrl: string; fetch?: typeof fetch;
  headers?: Record<string, string> | (() => Record<string, string>);
  credentials?: RequestCredentials | (() => RequestCredentials | undefined) }): BrowseBackend;

// adapters/local-backend
createLocalBackend(opts: BrowsePolicyOptions): BrowseBackend;

// adapters/controller-bridge
controllerBridge(c: BrowserController): BrowserBridge;
```

`createLocalBackend` mirrors the backend routes: invalid body -> `400
{ error }`; any error thrown by the policy -> `502` with the route's fixed
message (the HTTP routes did the same; their `429` came from a rate-limit
plugin that has no in-process equivalent); unknown path -> `404`. The request
signal (and `timeoutMs`) also reaches the decision client and text models, so a
Stop stops paid calls. It strips `diag` (step) and `fallbackReason` (plan). It
never throws for a policy failure. An aborted signal, or `timeoutMs` passing,
rejects with an `AbortError`, as `fetch` does.

## Adapter interfaces (implement your own)

```ts
// controller: a browser the controller can drive
interface BrowserTarget {
  ensurePage(): Promise<BrowserPageHandle>;
  currentPage(): BrowserPageHandle | null;
  listPages?(): Promise<BrowserTabInfo[]>; selectPage?(id: number): Promise<boolean>;
  closePage?(id: number): Promise<boolean>; newPage?(url?: string): Promise<BrowserTabInfo>;
  pageHandles?(): Promise<{ tabId: number; page: BrowserPageHandle }[]>;
}
interface BrowserPageHandle {   // one tab
  loadURL(url: string): Promise<void>; executeJavaScript(code: string): Promise<unknown>;
  getURL(): string; getTitle(): string; goBack(): void; goForward(): void; reload(): void;
  canGoBack(): boolean; canGoForward(): boolean; isLoading(): boolean; onceDomReady(): Promise<void>;
  /* plus optional members: isVisible, capture, input and dialog hooks */
}

// policy: the decision service (System One contract)
interface DecisionClient {
  evaluate<Q extends Record<string, DecisionQuestion>>(p: {
    state: string | Record<string, unknown> | unknown[]; questions: Q; signal?: AbortSignal;
  }): Promise<{ model: string; answers: Partial<Record<keyof Q, DecisionAnswer>>;
               refused?: string[]; usage: { input_tokens: number; output_tokens: number } }>;
}

// policy: a small structured-output text model
interface TextModel {
  readonly id: string;
  generateObject<T>(req: { schema: z.ZodType<T>; prompt: string | TextModelMessage[];
    abortSignal?: AbortSignal }): Promise<{ object: T; usage?: { inputTokens?: number; outputTokens?: number } }>;
}   // throw TextModelInvalidObjectError when the output does not match the schema

// loop
interface KeyValueStorage { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem?(k: string): void }
interface BrowserBridge {   // open, act, read, snapshot, perform; optional findImages, screenshot, tabs, capture
  open(args: { url: string }): Promise<unknown>; act(args: Record<string, unknown>): Promise<unknown>;
  read(args: Record<string, unknown>): Promise<unknown>; snapshot(): Promise<unknown>;
  perform(args: { snapshotId: string; index?: number; operation: string; text?: string }): Promise<unknown>;
  findImages?(...): Promise<unknown>; screenshot?(...): Promise<unknown>; tabs?(...): Promise<unknown>;
}
interface BrowseBackend {
  request(path: "/api/browse/step" | "/api/browse/plan" | "/api/browse/locate",
          body: Record<string, unknown>, opts: { timeoutMs: number; signal?: AbortSignal }):
    Promise<{ status: number; ok: boolean; body: unknown; retryAfterSec?: number }>;
}
```

- A new browser (Electron, Puppeteer): implement `BrowserTarget` and wrap it in
  `new BrowserController(target)`, then `controllerBridge(controller)`. Or
  implement `BrowserBridge` directly (for example over IPC).
- A new LLM provider: implement `TextModel` (the example does it with `fetch`).
- A new decision service: implement `DecisionClient`.
- The policy on a server: run `createLocalBackend` there, and use
  `createHttpBackend` in the client.

## The browse agent mode (`/agent`)

A second way to run a goal, next to `runBrowseTask`. A **non-reasoning chat
model** drives seven tools (`browse_open`, `browse_snapshot`, `browse_screenshot`,
`browse_act`, `browse_tabs`, `browse_find_images`, `browse_read`) in a plain tool
loop and gives a text answer. There is no decision service and no cascade: the
chat model reads the snapshot and picks the action. It is fast and cheap when
reasoning is off. Pen Editor calls this mode `BROWSE_MODE=agent`.

Minimal example (`ai` is a peer dependency; the model is yours):

```ts
import { runBrowseAgent } from "@sideform/browser-agent/agent/ai-sdk";
import { controllerBridge } from "@sideform/browser-agent/adapters/controller-bridge";

const result = await runBrowseAgent("find the price of the first result", {
  model,                                  // any AI SDK LanguageModel, reasoning OFF
  browser: controllerBridge(controller),  // any BrowserBridge
  url: "https://example.com",             // optional: opened before the first request
  providerOptions: { openrouter: { reasoning: { effort: "none" } } },
});
// { status: "done" | "error" | "aborted" | "step_limit" | "timeout" | "setup_failed", answer, steps, error?, setupStage? }
```

`examples/run-agent.ts` runs it end to end with local Chromium and OpenRouter.

What the package owns:

- **Prompt**: `buildBrowseAgentPrompt({ principal?, guidanceBullets?, sections? })`.
- **Tool definitions**: `browseToolDefinitions` (`description` and a zod
  `inputSchema` per tool), `createBrowseToolDefinitions(slots)` and
  `BROWSE_AGENT_TOOL_NAMES`. Text that names a host feature (a canvas, a
  wider `browse_task` tool, examples) is a *slot* in `BrowseDescriptionSlots`.
  The defaults are neutral. A host that needs other fields extends the schema
  (`browseScreenshotInputSchema.extend({...})`). `browse_act` has no `element`
  field in the neutral definitions: a host that resolves `element` itself passes
  `elementTargeting: true` in the slots (text and schema, in one switch).
- **Limits**: `BROWSE_AGENT_MAX_REQUESTS` (60), `BROWSE_AGENT_DEADLINE_MS`
  (14 min), answer and error caps.
- **Session core**: `createBrowseAgentSession`. The deadline, the abort signal,
  the request cap (`step_limit`), the step counter, the allowlist, host tool
  guards (`singleUseTool`) and the status choice. Hooks with state (`fork`) get
  a fresh copy per session, so one `singleUseTool` object serves every run.
  `deadlineMs` and `maxRequests` must be positive numbers (else creation
  throws); a `deadlineMs` above 2^31-1 ms or `Infinity` means no deadline.
  Host result fields cannot replace `status`, `answer`, `steps` or `error`. A host plugs in how a tool
  runs (`executeTool`) and how the model is driven (`BrowseAgentDriver`).
  `runBrowseAgent` is one driver (AI SDK `generateText`); Pen Editor's nested
  `Chat` is another, on the same core.
- **Result helpers**: `finalAnswer(messages, status)` over a minimal message
  type that `UIMessage` satisfies, and `preOpenText(goal, url, openedResult)`.
- **Tool execution**: `executeBrowseTool(browser, name, input, opts?)` maps the seven
  tools onto a `BrowserBridge` (a snapshot follows `browse_open` and a changed page;
  `browse_act` batches up to 10 entries). It is the one implementation: Pen
  Editor's handlers are thin wrappers over it. `opts` plugs in what only a host
  has: `locateElement` (resolves `browse_act`'s `element` description to an
  index; see the next list), `texts` (`notAvailable`, `commandFailed`,
  `methodMissing` for `browse_screenshot` and `browse_tabs`), `elementActions` (the
  actions the locator can resolve; default click, type, select, hover, press),
  `afterScreenshot` (a hook that runs after `browse_screenshot`
  when the input has `placeOnCanvas: true`) and `now`. `browser` may be
  `undefined`: every tool then answers `texts.notAvailable`. `runActionsBatch`
  (also exported) runs a batch with an injectable clock (the positional `now`,
  else `opts.now`, else `Date.now`); its 60 s deadline is `BATCH_DEADLINE_MS`.
  A locator outcome `failed` without a message answers a default
  "element lookup failed" error, never a silent success.

What stays in the host:

- **Model choice and provider routing.** Pick a non-reasoning model and switch
  reasoning off in `providerOptions` (the package does not know your provider).
  A reasoning model is slow here and gains little.
- **Host tools.** Pass them as `extraTools` (with an optional guard such as
  `singleUseTool`). Their fields can join the result.
- **Nested chat transport.** A product that streams the sub-run through its
  own chat (Pen Editor: a headless `Chat` against `/api/chat`) writes its driver
  and uses `createBrowseAgentSession` for everything else.
- **`element` targeting** of `browse_act` (a description instead of an index).
  The package owns the routing, the checks, the snapshot rules and the result
  (`resolved`), but the lookup itself is the host's `locateElement` (Pen Editor
  calls its backend). Without a locator `executeBrowseTool` answers "not
  available, use target or index", so the neutral definitions do not offer the
  field and `runBrowseAgent` passes none.
- **Vision.** By default the `browse_screenshot` result is text only: the JSON
  without `imageData`, plus an `imageNote` that an image was taken but is not
  attached. OpenAI-compatible providers (`@ai-sdk/openai-compatible`) print an
  image part as JSON text, so base64 would fill the prompt of every later
  request. Pass `toolResultImages: true` ONLY for a provider whose AI SDK
  integration carries tool-result images natively. For a model that cannot read
  images at all, pass `screenshots: false` to drop the tool.

### Light entry for browsers

`@sideform/browser-agent/agent/session` exports the limits, the result helpers,
`createBrowseAgentSession` and `singleUseTool` and imports no zod, no schemas
and no descriptions (about 13 KB of text). A frontend that drives the session
with its own chat (Pen Editor) imports this entry, not `/agent`.

`@sideform/browser-agent/agent/execute` exports `executeBrowseTool`,
`runActionsBatch`, `parseResultObject`, `callBridge`, `attachSnapshot` and their types, and imports no zod, no
`ai` and no schemas. A frontend that runs the browse tools against its own
bridge (Pen Editor's handlers) imports this entry, not `/agent`. Pinned by
`test/agent/executeEntry.test.ts`.

#### Notes: one executor for the seven tools

The tool executor now serves Pen Editor and `runBrowseAgent` alike. For
`runBrowseAgent` (no locator, no hooks) these edge cases changed:

- **A malformed `browse_act` result** (not a JSON object): the entry result is
  `{ "error": "browse_act: malformed result from the browser bridge." }`, no
  longer `{}`. In a batch this now stops the batch.
- **`browse_open`** forwards all its input to `bridge.open`, not only `{ url }`.
- **`browse_find_images`** no longer checks that the bridge has `findImages`:
  a bridge without it throws a `TypeError`, and its message is the `error`
  (before: `browse_find_images is not supported by this browser.`). Pen Editor's
  handler never checked either.
- **`browse_screenshot`** forwards all its input except `placeOnCanvas`, `x`
  and `y`, not only `annotate`.
- **Unchanged**: `element` alone is still refused (before any bridge call).
  A batch with no locator has no stale-order check; an `element` entry stops
  the batch at its own error.

## QA mode (`runBrowseAgent({ qa })`)

One scenario is one ordinary run. The package does not orchestrate: the consumer decides
how many runs go in parallel. Each parallel run needs its OWN browser;
`playwrightContexts(browser)` (in `adapters/playwright`) makes a new isolated
`BrowserContext` per call. Design: `docs/specs/2026-10-17-qa-suite-design.md`.

```ts
import { chromium } from "playwright-core";
import { playwrightContexts } from "@sideform/browser-agent/adapters/playwright";
import { runBrowseAgent } from "@sideform/browser-agent/agent/ai-sdk";

const browser = await chromium.launch();
const open = playwrightContexts(browser);
const opened = await open();                       // { browser, close }
try {
  const r = await runBrowseAgent("Add 2 items, check the cart badge says 2", {
    model,
    browser: opened.browser,
    fixture: { version: 1, fresh: true, url: "https://shop.test/" },
    qa: { onScreenshot: (img) => save(img) },      // or qa: true
  });
  // r.qa = { outcome, verdict?, reason?, steps, stepsDropped? }
} finally {
  await opened.close();
}
```

With `qa` on, the model gets `qa_verdict({ verdict: "pass" | "fail", reason })` (once; a
repeat is refused), the prompt gets a QA section (principal "a QA engineer" unless you
set one; with `prompt` as a string, include the exported `QA_PROMPT_SECTION` yourself), and
the result gets an extra `qa` field before `error`. Outcome: `passed` / `failed` (the
verdict), `inconclusive` (the run ended without a verdict), `error` (model error, timeout or
step limit without a verdict; `reason` says why when the result has no `error` of its own), `setup_failed` (the fixture broke; `error` and
`setupStage` stay on the result) and `aborted`. `qa.steps` is one entry per tool call of the
model (the last 30, `stepsDropped` counts the rest), built from the `onToolCall` hook, so
fixture data cannot reach it. `JSON.stringify(result)` stays the string for a main model: no
screenshot and no base64. The final screenshot goes only to `qa.onScreenshot` (jpeg, png or webp; taken within 10 s before the fixture release, the callback runs after the release; not for `setup_failed`, `aborted` or `timeout`). The run ends right after the verdict, so `answer` can be empty. A host tool named `qa_verdict` throws; host result fields `qa` and `qaVerdict` are dropped.

A host on the session core (no zod) assembles the same from `@sideform/browser-agent/agent/session`
(the zod-free QA core `qaCore.ts`; `agent` exports it too, plus `qaVerdictSchema` and
`qaVerdictDefinition` for hosts that want the zod schema):

```ts
import { createBrowseAgentSession, createStepRecorder, executeQaVerdict, qaResultOf,
  qaVerdictHooks, QA_PRINCIPAL, QA_PROMPT_SECTION, QA_VERDICT_TOOL } from "@sideform/browser-agent/agent/session";

const trail = createStepRecorder();
const session = createBrowseAgentSession({
  extraTools: { [QA_VERDICT_TOOL]: qaVerdictHooks() },   // a successful verdict ends the run
  executeTool: async (call, ctx) => {
    // The recorder wraps the host's executeTool (as runBrowseAgent does), so calls the guard
    // refuses and unknown tools are not steps.
    const done = trail.onToolCall(call);
    try {
      const output = call.toolName === QA_VERDICT_TOOL ? executeQaVerdict(call.input) : await myExecute(call, ctx);
      done({ output });
      return output;
    } catch (error) {
      done({ error });
      throw error;
    }
  },
});
// Your prompt: principal QA_PRINCIPAL and the section QA_PROMPT_SECTION.
// The session core only executes. The tool schema reaches the model from the host's server:
// declare qa_verdict there with `qaVerdictDefinition` from `@sideform/browser-agent/agent`
// (verdict "pass" | "fail", reason 1..500 chars).
// Run every tool call through session.runTool. Stop the model loop when
// session.continueRequest() is false (also after the verdict).
const result = await session.run(goal, driver);
const qa = qaResultOf(result, trail.steps());            // the `qa` field
```

`qaVerdictHooks()` sets `endsRun`: after a successful call `session.continueRequest()`
returns false, so the host makes no extra model request. A verdict with bad input is an error
and does not end the run. `executeQaVerdict(input)` checks the input by hand with the rules
of `qaVerdictSchema`.

`examples/qa-suite.ts <scenarios.json>` runs a list with OpenRouter and a small pool of its own;
`npm run qa-smoke` runs three parallel runs with a scripted model in a real Chromium, no keys.

## Page fixtures

A `PageFixture` is the state of a browser before a task: cookies, localStorage,
sessionStorage, the start URL, extra tabs and deterministic setup steps (`goto`,
`click`, `type`, `press`, `waitFor`, `wait`; no LLM). Design:
`docs/specs/2026-10-15-page-fixture-design.md`.

```ts
import { applyFixture, captureFixture, parsePageFixture } from "@sideform/browser-agent/fixture";

const parsed = parsePageFixture(JSON.parse(text));          // { ok, value } | { ok, error }
await controller.applyFixture(fixture);                     // under the controller lock; { ok, url, title, summary }
const saved = await controller.captureFixture();            // { ok, fixture } - for the host only, it holds secrets

await runBrowseAgent(goal, { model, browser: controllerBridge(controller), fixture });
```

Apply order: session reset (`fresh`), network mocks, cookies, storage per origin,
start URL, extra tabs, steps, `expect`. Cookies need a target with `setCookies`
(`PlaywrightTarget` has it, so Steel too). The model never sees the fixture:
`runBrowseAgent({ fixture })` gives it a summary with counts only (for example
`1 cookie; 2 network mocks; fresh session; expect checked`), plus a snapshot. `url` and
`fixture` together are an error. A host that prepares the browser its own way
uses `BrowseAgentRunOptions.setup`. Capture takes storage, URL and tabs, not the
DOM state of a page.

### QA start: expect, network mocks, fresh session

Design: `docs/specs/2026-10-15-qa-start-design.md`. A QA host turns a fixture
into a test case: prepare state X, check that X is really there, then give the
task to the agent.

```ts
const fixture: PageFixture = {
  version: 1,
  fresh: true,                                   // reset the session first (needs target.resetSession)
  url: "https://shop.test/cart",
  network: [                                     // needs allowNetworkMocks and target.routeRequests
    { url: "https://api.shop.test/cart*", method: "GET", body: { items: [] } },
    { url: "https://api.shop.test/pay*", status: 500, times: 1 },
    { url: "https://cdn.shop.test/ads*", abort: true },
  ],
  expect: { selector: "#cart", text: "Your cart is empty", url: "https://shop.test/cart*", timeoutMs: 5000 },
};
```

- `expect` is checked on the main tab after `steps`. All given conditions must
  hold at once; the check polls up to `timeoutMs` (default 5000, max 30000).
  `url` and the network `url` use one matcher: the full URL, `*` is any run of characters.
- `network` rules: the first matching rule wins (fixture order); a rule with
  `times` stops after N answers and later requests go through. `body` as an object is sent as JSON.
- `allowNetworkMocks` is a host gate: `applyFixture(fixture, { allowNetworkMocks: true })`,
  `controller.applyFixture(fixture, { allowNetworkMocks: true })`, or
  `runBrowseAgent(goal, { ..., fixture, allowNetworkMocks: true })`. Without it a
  non-empty `network` fails with stage `network`. So does a target without
  `routeRequests`. `PlaywrightTarget` implements it for the whole context (every tab and popup).
- Mocks live until the task ends, not until `applyFixture` returns. `applyFixture`
  returns `release()` (idempotent) when it installed any; a failed apply removes them itself.
  `BrowserController` keeps the release: `controller.releaseFixture()` calls it, and a new
  `applyFixture` releases the previous one first. `runBrowseAgent({ fixture })` calls
  `browser.releaseFixture()` in `finally` for every outcome, and refuses (status `setup_failed`,
  stage `network`) a bridge with mocks but no `releaseFixture`.
- `fresh: true` calls `target.resetSession(origins)` before anything else. `PlaywrightTarget` closes
  ALL tabs and opens one new blank tab (sessionStorage and history are gone), then clears cookies,
  permissions and storage (CDP `Storage.clearDataForOrigin`). **Limit:** cookies are cleared everywhere,
  but storage only for the origins this `PlaywrightTarget` instance saw in main-frame navigations plus the
  fixture's own origins. A reconnected target (a new `PlaywrightTarget`) or a third-party iframe may keep storage.
  For full isolation use one new `BrowserContext` per run; `fresh` covers a reused context. A reset
  that runs past 15 s fails with `resetting the session took too long`.
- URL patterns (network `url`, `expect.url`): scheme and host match without case, a bare origin
  (`https://a.test`) means `https://a.test/`, and a pattern matches the encoded URL (no percent-encoding
  normalization). A mock `status` is 200-599; header names are HTTP tokens and values hold no line break.
- Ownership: the controller's apply result carries `fixtureToken` when it installed mocks;
  `releaseFixture(token)` removes only that fixture. `runBrowseAgent` uses the token of its own apply, so
  two runs on one controller cannot remove each other's mocks; a run whose apply returned no token releases nothing.
- Every apply failure has a `stage`: `validate`, `prepare`, `network`, `reset`, `cookies`, `storage`, `url`,
  `tabs`, `steps`, `expect`. In an agent run it comes back as status `setup_failed`
  (the model never ran) with `result.setupStage`; `done`, `error`, `timeout` and so on
  mean the agent or the site failed, not the preparation. A `setup` hook can throw `SetupError(stage, message)`
  to do the same. No error or summary holds a mock URL query, header or body.

```ts
const context = await browser.newContext();                       // a new context per QA run
const controller = new BrowserController(new PlaywrightTarget(context));
const result = await runBrowseAgent("Pay for the order", {
  model, browser: controllerBridge(controller), fixture, allowNetworkMocks: true,
});
if (result.status === "setup_failed") console.error("setup broke at", result.setupStage, result.error);
await context.close();
```

A host that drives `createBrowseAgentSession` itself (no `runBrowseAgent`) uses the same
setup and release logic through `createFixtureSetup` (zod-free, from `agent/session`):

```ts
import { createBrowseAgentSession, createFixtureSetup } from "@sideform/browser-agent/agent/session";

const fx = createFixtureSetup(browser, fixture, {
  allowNetworkMocks: true,
  snapshot: () => executeBrowseTool(browser, "browse_snapshot", {}),
  onApplied: ({ mockCount }) => log(mockCount),   // not called if release() ran first
});
try {
  await session.run(goal, driver, { setup: fx.setup });
} finally {
  await fx.release();   // idempotent, bounded (releaseTimeoutMs, 10 s), never throws
}
```

`release()` does not wait for an apply that is still in flight (a run aborted at the deadline;
a remote bridge cannot cancel): when that apply later resolves with a token, the helper releases it
at once and does not call `onApplied`.

A target in a profile the user also logs into (Pen Editor's desktop built-in
browser) must scope both: `routeRequests` to the agent's own tabs (CDP `Fetch` per
tab, never a profile-wide hook), and `resetSession` to the `origins` it is given.
A "clear everything" reset there would log the user out of every site.

### Checkpoint: save the browser in the middle of a task

A host can take a checkpoint of the browser at the end (or in the middle) of a task, and rebuild
it later with `applyFixture`, also in a new browser. The DOM and the JS state of a page cannot be
serialized, so a checkpoint is `base state + journal`: the URL, cookies and storage read at the
last new document, plus the agent's state-changing actions since then (click, type, select, press),
recorded as `FixtureStep`s with a CSS selector computed BEFORE each action. It is a normal
`PageFixture`: no new apply code. The `select` step (`{ action: "select", selector, value }`) was added for it.

```ts
await runBrowseAgent("Fill the order form", {
  model, browser: controllerBridge(controller), url,
  checkpoint: {                                  // origins?: string[] limits the base cookies and storage
    onCapture(result) {                          // called ONCE when the run ends; not after setup_failed or aborted, nor when no browser command ran; may be async
      if (result.ok) save(result.fixture);       // for the HOST only: cookie values, storage values, typed text
    },
  },
});
// later, in a new browser: await controller2.applyFixture(saved);
```

Without the agent: `const token = controller.startJournal({ origins? })`, `controller.captureCheckpoint(token)`,
`controller.stopJournal(token)`. The journal is off by default and costs nothing while off. The token is the owner
of the journal: a second `startJournal` replaces the running journal and the old token goes stale (its `stopJournal`
does nothing, its `captureCheckpoint` returns an error). Without a token both act on whatever journal runs.
Only commands that may change the page (click, type, select, press, open, reload, back, forward, tabs new/switch/close)
cost the journal anything; a snapshot, read or screenshot reads no marker.

- **One journal per tab.** The journal follows the current tab. Switching away and back continues that tab's
  journal. A tab the journal sees for the first time gets a fresh base at that moment. The checkpoint is the
  current tab's journal; the other tabs are listed as `tabs` URLs.
- **Reset = a new document.** The journal plants a marker in the page at base time (a random token on a
  non-enumerable `window` property). After each command it checks the marker. A missing or different marker is
  a new document: `open`, reload, a link, a form POST (also to the same URL), back/forward that restores another
  document. The steps are cleared and the base is re-read. An action that caused the change is not recorded: the new
  page is the base. A `pushState` or hash change is NOT a reset: the steps continue on the old base, and the replay
  reproduces the SPA route because the recorded click that pushed the state replays. A page that cannot be asked for
  its marker is a gap.
- **Base storage is read at the reset, not at capture.** A step such as "Add to cart" that writes `localStorage`
  must not be applied twice by the replay. The current page is read first (sessionStorage is per tab); other origins
  in `origins` come from the other tabs. `origins: []` reads no cookie and no storage.
- **`waitFor` before each action.** The journal records `{ action: "waitFor", selector }` before each click, type,
  select and press-with-selector, so a replay waits for async content (an autocomplete list). These steps are not
  counted toward `CHECKPOINT_MAX_STEPS`, and the summary counts actions.
- **Gaps** (`complete: false`, `gap` says why, recording stops until the next reset; the steps before the gap
  stay). The rule: when the journal cannot be sure a step was recorded correctly, it sets a gap. It never
  silently drops a possibly-effective action. Gaps: an element in an iframe or a shadow tree; a back or forward inside the
  same document (an SPA popstate; a back to a new document is a normal reset); steps on a base with no http(s) URL; no unique selector
  (also when the lookup found nothing: the action may still succeed); an element a `type` step cannot replay
  (range, file, contenteditable); a `type` that was retargeted to another element; a command that failed or timed
  out after it staged something (or a timed-out action); a document that could not be checked; more than
  `CHECKPOINT_MAX_STEPS` (100) actions; a successful `hover` (it opens menus and tooltips that no step replays);
  a `select` whose option value another option shares (the replay would pick the first one); an `open` that
  changes only the hash (the document stays, nothing replays it). A command rejected by argument validation
  before any page effect leaves no trace; so does an action whose page script refused before it touched the
  page (no element matched, a disabled control, no such option).
- **A key-only `press`** records the focused element (`document.activeElement`) as its target, so the replay focuses it
  before the key (the replayed `click` is `el.click()` and does not focus). Focus on the body records a bare press.
- **A fixture applied with the journal on becomes the base** of the current tab: base URL = `fixture.url`, base
  steps = the fixture's steps (they do not count toward the cap), base storage = the state the profile held BEFORE the apply
  (for the journal's origins and the fixture's) with the fixture's storage on top (the fixture wins per cookie and per key).
  With `fresh: true` the earlier state is ignored and the checkpoint says `fresh: true`.
  `network` and `expect` are not copied: the host owns them. A fixture with steps and no URL is a gap (its steps
  ran on a page the checkpoint does not know). A failed apply is a normal reset on the current page plus a gap.
- **Not recorded.** `scroll`, `wait` and read-only commands (a `hover` is a gap, see above). Known limit: a scroll
  is not replayed, so a page that loads content on scroll (infinite scroll, lazy lists) may lack the element
  when the replay reaches the next step. Then `applyFixture` fails at that step (its `waitFor` times out), loudly, not
  silently. Server-side state is out of reach: a replayed
  "Add to cart" that calls the server adds a second item there. The host owns this (test server, network mocks, `fresh`).
- **Secrets.** `fixture` holds secrets. `summary` and `gap` hold counts, step kinds and origin + pathname only.
  The checkpoint reaches the host only through `onCapture`: `BrowseAgentResult` has no checkpoint field, so
  `JSON.stringify(result)` cannot leak it. A bridge without `startJournal`, `stopJournal` and `captureCheckpoint`
  gives `{ ok: false, error }` to `onCapture`, not a failed run. When the run ends the journal is stopped, but the result
  waits for that at most 2 s.
- A host that drives `createBrowseAgentSession` itself uses `createCheckpointRecorder(browser, { origins? })`
  (`start()`, `capture()` returns the `CheckpointResult`, `stop()`; zod-free, from `agent/session`).
- `createRunCheckpoint(browser, { enabled?, origins?, signal?, startWaitMs?, stopWaitMs? })` is the whole run-end lifecycle in
  one helper (also from `agent/session`; `runBrowseAgent` always uses it): `await cp.begin()` before the run touches the
  browser. It is true only when the journal runs; it is false after `startWaitMs` = 5 s (the start bound is the smaller of
  `startWaitMs` and `timeoutMs`), an abort, a failed or timed-out start, an already aborted signal or a `finish()` that
  came first (the browser is not called) or `enabled: false` (no recorder and no timer exist). At the end
  `await cp.finish({ status, steps }, { beforeStop })` returns `undefined` ONLY for a deliberate skip (disabled, status
  `setup_failed` or `aborted`, `steps` not above 0). Otherwise it returns the capture, or `{ ok: false, error }`; when the journal did not
  start the error is the recorder's own (unsupported browser, failed or timed-out start), or the fixed text
  "the checkpoint journal did not start" after a begin abort. `beforeStop(captured)` runs next (put the host
  callback and the fixture release there: capture, callback, release, stop). The journal is always stopped, and the stop
  wait is `stopWaitMs` = 2 s. A capture already taken is returned even if the signal aborted meanwhile: a host that must not
  keep a checkpoint after an abort checks its signal after `finish()`. Never throws, idempotent.
  `cp.settled` is one promise, readable at any time; it resolves once when the journal's calls (start, the stop of a late
  start, stop) have settled, or at the latest `CHECKPOINT_SETTLE_CAP_MS` (30 s, option `settleCapMs`) after the stop was requested
  when the browser does not answer (best effort). The recorder has `idle()` for the unbounded wait.
- Pen Editor does not use this yet (its browser lives on between `browse_agent` calls).

## Isomorphism

`src/loop` and `src/policy` use no Node built-ins and no Playwright, so they
run in a browser (a web page can run the loop against `createHttpBackend`, or
even the policy with `createLocalBackend`). The loop never imports the policy at
runtime. Only the adapters (`playwright`, `ai-sdk`) bring in peer dependencies.

## Configuration: old pen-editor env vars to options

| Old (pen-editor-backend) | Option |
|---|---|
| `BROWSE_STEP_POLICY` | `BrowsePolicyOptions.policy` (`"ultrafast"` default, or `"legacy"`) |
| `BROWSE_STEP_VISION=on` | `BrowsePolicyOptions.vision: true` |
| `TYPESAFE_MODEL` | `BrowsePolicyOptions.decisionModel` and `createSystemOneClient({ model })` |
| `TYPESAFE_API_KEY` | `createSystemOneClient({ apiKey })` |
| `STRUCTURED_MODEL` | `BrowsePolicyOptions.models.structured` |
| `BROWSE_CASCADE_MODEL` | `BrowsePolicyOptions.models.cascade` |
| `OPENROUTER_API_KEY` (Luna decisions) | `createSystemOneClient({ openRouterApiKey })` |
| loop Zustand permissions store | `RunBrowseTaskOptions.permissions` |
| `localStorage` action cache | `RunBrowseTaskOptions.storage` |

## Develop

```bash
npm run lint   # tsc --noEmit && eslint
npm test       # vitest
npm run build  # tsc -> dist/
```

## Releases

Releases are made by release-please. Use Conventional Commits. Merge the
release PR it opens: this bumps the version, updates `CHANGELOG.md`, and makes
the tag and the GitHub release. Do not write manual `chore: release` commits
or tags.

While the version is 0.x, `feat` and `fix` bump the patch (0.2.x). A breaking
change bumps the minor (0.3.0). Consumers pin an exact git tag. Renovate in
each consumer opens a PR that moves the tag, and automerges a patch bump when
the consumer's CI is green.

npm publish runs after the release when the `NPM_TOKEN` secret is set.

Migration of the three pen-editor repos: [docs/migration-plan.md](docs/migration-plan.md).
