# @pen/browser-agent

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

The package is private. Install it from the Git repo:

```bash
npm install github:dan-rozhkov/browser-agent#v0.1.0
```

`prepare` builds `dist/` on install. Peer dependencies are optional:
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
import { runBrowseTask, memoryStorage } from "@pen/browser-agent";
import { controllerBridge } from "@pen/browser-agent/adapters/controller-bridge";
import { createLocalBackend } from "@pen/browser-agent/adapters/local-backend";
import { connectOverCdp } from "@pen/browser-agent/adapters/playwright";
import { createSystemOneClient } from "@pen/browser-agent/adapters/systemone-http";

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
| `@pen/browser-agent` | controller + policy + loop barrels (no adapters) |
| `@pen/browser-agent/controller` | controller layer |
| `@pen/browser-agent/policy` | policy layer |
| `@pen/browser-agent/loop` | loop layer |
| `@pen/browser-agent/adapters/playwright` | `PlaywrightTarget`, `connectOverCdp` |
| `@pen/browser-agent/adapters/systemone-http` | `createSystemOneClient` |
| `@pen/browser-agent/adapters/ai-sdk` | `aiSdkTextModel` |
| `@pen/browser-agent/adapters/http-backend` | `createHttpBackend` |
| `@pen/browser-agent/adapters/local-backend` | `createLocalBackend` |
| `@pen/browser-agent/adapters/controller-bridge` | `controllerBridge` |

**Name collisions at the root.** Two names exist in more than one layer.
The root barrel exports the controller's `MAX_SNAPSHOT_ELEMENTS` (both are
`120`) and the loop's `BrowsePermissions` (the type `runBrowseTask` takes).
The policy's versions stay available from `@pen/browser-agent/policy`.

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

// adapters/systemone-http
createSystemOneClient(opts: { apiKey: string; model?: string; baseUrl?: string;
  openRouterApiKey?: string; fetch?: typeof fetch; sleep?: (ms: number, signal: AbortSignal) => Promise<void> }): DecisionClient;

// adapters/ai-sdk   (peer: ai)
aiSdkTextModel(model: LanguageModel, opts?: { id?: string; providerOptions?: Record<string, unknown> }): TextModel;

// adapters/http-backend
createHttpBackend(opts: { baseUrl: string; fetch?: typeof fetch;
  headers?: Record<string, string> | (() => Record<string, string>) }): BrowseBackend;

// adapters/local-backend
createLocalBackend(opts: BrowsePolicyOptions): BrowseBackend;

// adapters/controller-bridge
controllerBridge(c: BrowserController): BrowserBridge;
```

`createLocalBackend` mirrors the backend routes: invalid body -> `400
{ error }`; `SystemOneRateLimitError` -> `429` (with `retryAfterSec` if the
error carries one); other `SystemOneError` -> `502`; anything else -> `500`;
unknown path -> `404`. It strips `diag` (step) and `fallbackReason` (plan). It
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
interface BrowserBridge {   // open, act, read, snapshot, perform; optional findImages, screenshot, tabs
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

Migration of the three pen-editor repos: [docs/migration-plan.md](docs/migration-plan.md).
