# browser-agent — design (stage 1)

Date: 2026-10-13. Status: approved by the autopilot run (headless; the
recommended option was taken at every fork — see "Decisions" at the end).

## Goal

Move pen-editor's "browser use" stack into one independent TypeScript
library, so other services can drive a browser towards a goal without
pen-editor, Electron, Fastify, Zustand or the backend's `Config`.

Success criteria for stage 1:

- `browser-agent/` is its own git repo (private on GitHub), with `lint`,
  `test`, `build` green locally and in CI.
- The page controller, the step policy and the `browse_task` loop live in
  the package, behind adapter interfaces. No import from the three
  pen-editor repos.
- Ready adapters: Playwright/CDP (browser), System One over HTTP
  (decisions), AI SDK (text model), HTTP backend (loop → remote policy).
- The unit tests of the moved code moved with it and pass.
- `examples/`, `README.md` (API), `docs/migration-plan.md`.
- The three existing repos are NOT changed (code or dependencies).

## Sources (snapshot)

| Layer | Source | Commit |
|---|---|---|
| controller | `pen-editor-desktop/src/main/browser/{controller,pageScripts,keys}.ts`, `src/main/navigation.ts` (only `decideBrowserNavigation`) | desktop `3d8f975` |
| policy | `pen-editor-backend/src/ai/browse{Step,StepUltrafast,CommitGuard,Captcha,Locate,Plan}.ts`, `src/analysis/pii.ts`, the route orchestration in `src/routes/browseStep.ts` | backend `53f710e` |
| adapters | `pen-editor-backend/src/browser/{playwrightHandle,connect,redact}.ts`, `src/services/systemone.ts` | backend `53f710e` |
| loop | `pen-editor/src/lib/tools/browser/{browseTask,actionCache,actionEffect,loopGuard,shared}.ts` | pen-editor `792b4e30` |

The behaviour is copied, not redesigned. Edits are limited to cutting the
host dependencies listed below. Comments that cite pen-editor specs stay —
they are the history of why a rule exists.

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

### Module map

```
src/
  index.ts                  re-exports the public API of every layer
  controller/  index.ts controller.ts pageScripts.ts keys.ts navigation.ts
  policy/      index.ts step.ts(browseStep) stepUltrafast.ts commitGuard.ts
               captcha.ts locate.ts plan.ts pii.ts decisions.ts textModel.ts
               decide.ts (route orchestration → decideStep/planGoal/locate)
  loop/        index.ts browseTask.ts actionCache.ts actionEffect.ts
               loopGuard.ts shared.ts bridge.ts backend.ts storage.ts
  adapters/    playwright.ts (PlaywrightTarget + connectOverCdp + redact)
               systemoneHttp.ts  aiSdk.ts  httpBackend.ts
               localBackend.ts  controllerBridge.ts
```

File names inside `policy/` may keep their `browse*` names if renaming
costs more than it gives; the `index.ts` barrels are the contract.

## Adapter interfaces

### Browser (controller layer)

`BrowserTarget` and `BrowserPageHandle` already exist in `controller.ts`
and are Electron-free. They stay as they are. `BrowserTabInfo` (was in
desktop's `tabManager.ts`) is inlined. `decideBrowserNavigation` is the
only part of `navigation.ts` that moves (as the backend vendor already
does). `randomUUID` comes from `globalThis.crypto`, not `node:crypto`.

`PlaywrightTarget` (from the backend's `playwrightHandle.ts`) implements
them over any Playwright `BrowserContext`. `connectOverCdp(cdpUrl)` returns
`{ controller, close, onDisconnected }` and redacts the URL from errors.
`playwright-core` is an optional peer dependency, imported lazily.

### DecisionClient (policy layer)

```ts
// policy/decisions.ts — the System One contract, vendor-neutral name
export type DecisionQuestion = SystemOneQuestion;          // noul | choice | score
export type DecisionAnswer = SystemOneAnswer;
export interface DecisionClient {
  evaluate<Q extends Record<string, DecisionQuestion>>(p: {
    state: string | Record<string, unknown> | unknown[];
    questions: Q; signal?: AbortSignal;
  }): Promise<{ model: string; answers: Partial<Record<keyof Q, DecisionAnswer>>;
                refused?: string[]; usage: { input_tokens: number; output_tokens: number } }>;
}
```

The old `SystemOne*` type names are kept as aliases so the moved code and
tests change little. `adapters/systemoneHttp.ts` exports
`createSystemOneClient({ apiKey, model, baseUrl?, openRouterApiKey?, fetch? })`
(was `createSystemOne(config)`), with the same Jev/Luna routing, retries,
refusal handling and error classes.

### TextModel (policy layer)

```ts
export interface TextModel {
  readonly id: string;
  generateObject<T>(req: {
    schema: z.ZodType<T>;
    prompt: string | TextModelMessage[];
    abortSignal?: AbortSignal;
  }): Promise<{ object: T; usage?: { inputTokens?: number; outputTokens?: number } }>;
}
export class TextModelInvalidObjectError extends Error {}  // was NoObjectGeneratedError
```

The policy needs two roles: `structured` (was `STRUCTURED_MODEL`, legacy
TYPE_TEXT) and `cascade` (was `BROWSE_CASCADE_MODEL`, cascade, plan,
ultrafast field text). `adapters/aiSdk.ts` exports
`aiSdkTextModel(model: LanguageModel, opts?)`, which calls the AI SDK's
`generateObject` and maps `NoObjectGeneratedError` to
`TextModelInvalidObjectError`. Provider routing (`createModel`,
`reasoningEffort: "none"`) stays in the host: the host passes a ready
`LanguageModel`.

### Policy options (replaces `Config`)

```ts
export interface BrowsePolicyOptions {
  decisions: DecisionClient;
  models: { structured: TextModel; cascade: TextModel };
  policy?: "ultrafast" | "legacy";     // BROWSE_STEP_POLICY, default ultrafast
  vision?: boolean;                    // BROWSE_STEP_VISION === "on"
  decisionModel?: string;              // TYPESAFE_MODEL — picks the Luna branch
}
```

`decide.ts` holds what `routes/browseStep.ts` did around the policy:
vision gate (`jev*` model ⇒ no screenshot), screenshot normalisation, bot
wall → policy → commit guard with the remaining budget. It returns the
result with `diag`; the HTTP layer strips it. Input validation (zod body
schemas) moves too, as `browseStepBodySchema`/`browsePlanBodySchema`/
`browseLocateBodySchema`, so any host can validate the same way.

### BrowserBridge (loop layer)

The loop talks to "a browser" through the shape pen-editor's preload
exposes (`window.penDesktop.browser`): `open`, `act`, `read`, `snapshot`,
`perform`, and optional `screenshot`, `tabs`, `findImages`. It is declared
as `BrowserBridge` in `loop/bridge.ts`. `adapters/controllerBridge.ts`
adapts a `BrowserController` to it in-process.

### BrowseBackend (loop layer)

```ts
export type BrowseEndpoint = "/api/browse/step" | "/api/browse/plan" | "/api/browse/locate";
export interface BrowseBackendResponse { status: number; ok: boolean; body: unknown; retryAfterSec?: number }
export interface BrowseBackend {
  request(path: BrowseEndpoint, body: Record<string, unknown>,
          opts: { timeoutMs: number; signal?: AbortSignal }): Promise<BrowseBackendResponse>;
}
```

The HTTP-response shape is kept on purpose: the loop's retry rules (429,
503 + Retry-After) and error branches stay byte-for-byte. Two adapters:

- `createHttpBackend({ baseUrl, fetch?, headers? })` — the old
  `fetchBrowseBackendOnce` with the URL resolution injected.
- `createLocalBackend(policyOptions)` — validates the body with the moved
  zod schemas (400 on failure, like the route), runs `decideStep` /
  `planGoal` / `locate` in-process, answers `{ status: 200, ok: true, body }`
  without `diag`; a `DecisionClient` rate-limit error maps to 429/503 like
  the route does.

### Storage (loop layer)

```ts
export interface KeyValueStorage { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem?(k: string): void }
export function memoryStorage(): KeyValueStorage;
```

The action cache takes a `KeyValueStorage` (pen-editor passes
`localStorage`). No storage ⇒ the cache is off. The kill-switch key and
the cache format stay as they were, so pen-editor can keep its existing
cache blob after migration.

### Loop entry point

```ts
runBrowseTask(goal: string, opts: {
  browser: BrowserBridge; backend: BrowseBackend;
  maxSteps?: number; url?: string; signal?: AbortSignal;
  permissions?: BrowsePermissions;    // was the Zustand settings store
  storage?: KeyValueStorage;          // action cache
  cloud?: boolean;                    // was isDesktopBrowserAvailable() === false → cloud deadlines
  stepScreenshots?: boolean;          // was a localStorage flag
  now?: () => number; sleep?: (ms: number) => Promise<void>;
  deadlineMs?: number; overallDeadlineMs?: number;
}): Promise<Transcript>
```

The pen-editor `ToolHandler` wrapper (`browseTask`), `browseAct`'s tool
handler and the other one-call `browse_*` tool handlers are NOT moved —
they are pen-editor glue around this API.

## Error handling

Unchanged from the sources: the controller returns `{ error }` results
instead of throwing; the policy fails safe to `retry`/`blocked`; the loop
turns everything into a `Transcript`. New code (adapters) follows the
same rule: `createLocalBackend` never throws for a policy failure — it
answers 5xx like the route.

## Testing

- Moved unit tests: controller (`browserController`, `keys`,
  `navigation`), policy (`browse-step*`, commit guard, captcha, locate,
  plan, pii), System One client, Playwright handle, loop (`browseTask`,
  `actionCache`, `actionEffect`, `loopGuard`, `shared`). Assertions are
  not weakened; only the plumbing changes (fakes injected instead of
  `vi.mock` of host modules, `window.penDesktop` → a `BrowserBridge` fake,
  `localStorage` → `memoryStorage()`).
- New tests: `createLocalBackend` (status mapping, diag stripped,
  validation 400), `createHttpBackend` (URL join, Retry-After parse),
  `aiSdkTextModel` (error mapping), `controllerBridge` (method forwarding).
- The route tests (`browse-step-route`, `browse-locate-route`) stay in the
  backend; their orchestration part is covered by `decide.ts` tests.

## Out of scope (stage 1)

- Changing pen-editor, pen-editor-backend or pen-editor-desktop.
- npm publication; public visibility.
- The desktop's Electron `BrowserTarget` (window.ts/tabManager) — stays in
  desktop; it implements the package's interface after migration.
- The cursor engine, permissions handler, MCP bridge, cloud session
  manager (`cloudSessions.ts`) and Steel specifics — host concerns.

## Decisions (taken without a human, recommended option each time)

1. One package with subpath exports, not an npm-workspace monorepo — one
   version, one CI, enough for stage 1.
2. Keep the HTTP-response shape at the loop/backend seam — the loop code
   and its 3 000-line test file barely change.
3. `TextModel` is a minimal `generateObject` interface plus an AI SDK
   adapter; `ai` is an optional peer dependency. `zod` is a real
   dependency (schemas are part of the policy).
4. Package name `@pen/browser-agent`, `private: true`, version 0.1.0.
   Consumers install it from the private Git repo (`github:` dependency)
   until a registry is chosen.
5. ESM + NodeNext (`.js` import suffixes) — the backend's convention; the
   frontend's Vite build and desktop's bundler both accept it.
6. TypeScript ~5.9 (matches pen-editor; the desktop's TS 7 can consume
   the emitted `.d.ts`).
