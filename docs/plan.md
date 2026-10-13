# browser-agent stage 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the copied pen-editor browser-use sources in `browser-agent/` into a standalone, tested TypeScript library with adapters.

**Architecture:** Port, do not redesign. Three layers (controller, policy, loop) are copied verbatim into `src/` and their host dependencies are cut and replaced by the adapter interfaces of the spec. Adapters live in `src/adapters/`.

**Tech Stack:** TypeScript ~5.9 (ESM, NodeNext), Vitest 4, ESLint 9 + typescript-eslint, zod 3, optional peers `ai` 6 and `playwright-core`.

**Spec:** `docs/design.md`

## Global Constraints

- No import from `pen-editor`, `pen-editor-backend`, `pen-editor-desktop`, `electron`, `fastify`, `zustand`, or any `@/` alias.
- Relative imports carry the `.js` suffix (NodeNext).
- `src/loop/**` and `src/policy/**` must be isomorphic: no `node:*` imports (browser bundles consume them). `src/controller/**` uses `globalThis.crypto.randomUUID`, not `node:crypto`.
- `ai` and `playwright-core` are imported only from `src/adapters/aiSdk.ts` and `src/adapters/playwright.ts` (playwright lazily).
- Do not weaken a moved test's assertion. Plumbing changes only (injected fakes instead of `vi.mock` of host modules).
- `package.json`, `tsconfig*.json`, `eslint.config.js`, `vitest.config.ts` are owned by the main agent — tasks do not edit them.
- No git operations in tasks; the main agent commits.
- Checks: `npm run lint` (tsc --noEmit + eslint), `npm test`, `npm run build`, all at 0 errors.

## Review Focus

1. A `jev*` decision model with `vision: true` — the screenshot must still be dropped (the route used to do this; now `decideStep` must).
2. `createLocalBackend` given a body the route would reject (empty goal, 121+ elements) — must answer 400, not throw, so the loop's error branch runs.
3. `DecisionClient` rate-limit error (`SystemOneRateLimitError`) inside the local backend — must surface as 429 so the loop's retry path works.
4. Action cache with no storage passed — must be a silent no-op, never a crash.
5. `aiSdkTextModel` when the model returns invalid JSON twice — the cascade must report "invalid object (after retry)", i.e. the error mapping to `TextModelInvalidObjectError` must work through the adapter.

---

### Task 1: Controller layer + Playwright adapter

**Files:**
- Modify: `src/controller/{controller,pageScripts,keys,navigation}.ts`
- Create: `src/controller/index.ts`
- Modify: `src/adapters/playwright.ts`; fold `src/adapters/connect.ts` and `src/adapters/redact.ts` into it (delete the two files)
- Test: `test/controller/{browserController,keys,navigation}.test.ts`, `test/adapters/playwright.test.ts`

**Interfaces:**
- Produces (from `src/controller/index.ts`): `BrowserController`, `BrowserTarget`, `BrowserPageHandle`, `BrowserTabInfo`, `BrowserCommandResult`, `EffectEvidence`, all exported constants, `parseKeySpec`, `resolveNamedKey`, `modifiersBitmask`, `resolveEditCommand`, `decideBrowserNavigation`, every `*_JS` page script and `ARGS_MARKER`.
- Produces (from `src/adapters/playwright.ts`): `PlaywrightTarget` (class, ctor `(context: BrowserContext)`), `connectOverCdp(cdpUrl: string): Promise<{ controller: BrowserController; close(): Promise<void>; onDisconnected(cb: () => void): void }>`, `redactedError(e: unknown, secret: string): Error`.

- [ ] Step 1: In `controller.ts` replace `import { decideBrowserNavigation } from "../navigation"` → `"./navigation.js"`, `"./keys"` → `"./keys.js"`, `"./pageScripts"` → `"./pageScripts.js"`; replace `import type { BrowserTabInfo } from "../tabManager"` by an inline exported interface `{ tabId: number; url: string; title: string; current: boolean }`; replace `import { randomUUID } from "node:crypto"` by `const randomUUID = () => globalThis.crypto.randomUUID();`.
- [ ] Step 2: `navigation.ts` keeps only `decideBrowserNavigation` (already reduced — verify, drop the vendor header comment, add a one-line provenance comment).
- [ ] Step 3: Write `src/controller/index.ts` barrel (`export * from "./controller.js"` etc.).
- [ ] Step 4: Port the tests: fix import paths to `../../src/controller/*.js`; drop any test that exercises a removed Electron-only function of `navigation.ts` (`decideNavigation`, `attach*`, `shouldDrop*`, `shouldForward*`) — list each dropped `describe` in the report. Run `npx vitest run test/controller` → PASS.
- [ ] Step 5: `playwright.ts`: import from `../controller/index.js`; append `connectOverCdp` from `connect.ts` (its return type is `BrowserController`, not `CommandRunner`) and `redactedError` from `redact.ts`; delete `connect.ts`, `redact.ts`. Port `test/adapters/playwright.test.ts`. Run `npx vitest run test/adapters/playwright.test.ts` → PASS.
- [ ] Step 6: `npx tsc --noEmit 2>&1 | grep -E "src/(controller|adapters/playwright)|test/(controller|adapters/playwright)"` → empty; `npx eslint src/controller src/adapters/playwright.ts test/controller test/adapters/playwright.test.ts` → 0 errors.

### Task 2: Policy layer + System One HTTP + AI SDK adapters

**Files:**
- Modify: `src/policy/{browseStep,browseStepUltrafast,browseCommitGuard,browseCaptcha,browseLocate,browsePlan,pii}.ts`
- Create: `src/policy/decisions.ts`, `src/policy/textModel.ts`, `src/policy/decide.ts`, `src/policy/schemas.ts`, `src/policy/index.ts`
- Modify: `src/adapters/systemoneHttp.ts`; Create: `src/adapters/aiSdk.ts`
- Test: `test/policy/*.test.ts`, `test/policy/{browseFakes,structuredModelFakes}.ts`, `test/adapters/systemoneHttp.test.ts`; Create: `test/policy/decide.test.ts`, `test/adapters/aiSdk.test.ts`

**Interfaces:**
- Produces `src/policy/decisions.ts`: all `SystemOne*` question/answer/result types and error classes (`SystemOneError`, `SystemOneAuthError`, `SystemOneValidationError`, `SystemOneRateLimitError`, `SystemOneUpstreamError`, `SystemOneRefusalError`), `isOpenAIDecisions`, `isJevModel`, plus aliases `DecisionClient = SystemOneClient`, `DecisionQuestion`, `DecisionAnswer`.
- Produces `src/policy/textModel.ts`: `TextModel`, `TextModelMessage`, `TextModelInvalidObjectError` (static `isInstance(e): boolean`).
- Produces `src/policy/decide.ts`: `BrowsePolicyOptions` (spec), `decideStep(opts, body: BrowseStepBody): Promise<BrowseStepResult>` (with `diag`), `planGoal(opts, body: BrowsePlanBody)`, `locateTarget(opts, body: BrowseLocateBody)`.
- Produces `src/policy/schemas.ts`: `browseStepBodySchema`, `browsePlanBodySchema`, `browseLocateBodySchema` (zod, copied from backend `src/routes/browse{Step,Plan,Locate}.ts`) and their `z.infer` types `BrowseStepBody`, `BrowsePlanBody`, `BrowseLocateBody`; `normalizeScreenshot`.
- Produces `src/adapters/systemoneHttp.ts`: `createSystemOneClient(opts: { apiKey: string; model?: string /* default "jev-latest" */; baseUrl?: string /* default TypeSafe URL from the source config default */; openRouterApiKey?: string; fetch?: typeof fetch; sleep?: (ms: number, s: AbortSignal) => Promise<void> }): DecisionClient`.
- Produces `src/adapters/aiSdk.ts`: `aiSdkTextModel(model: LanguageModel, opts?: { id?: string; providerOptions?: Record<string, unknown> }): TextModel`.

- [ ] Step 1: Move the types/errors/predicates out of `systemoneHttp.ts` into `policy/decisions.ts`; `systemoneHttp.ts` imports them and keeps only the HTTP client; `createSystemOne(config)` becomes `createSystemOneClient(opts)` (map `TYPESAFE_API_KEY→apiKey`, `TYPESAFE_MODEL→model`, `TYPESAFE_BASE_URL→baseUrl`, `OPENROUTER_API_KEY→openRouterApiKey`); it throws if `apiKey` is empty instead of returning null.
- [ ] Step 2: Write `textModel.ts` (spec interface). Write `aiSdk.ts`: `generateObject({ model, schema, prompt | messages, abortSignal, providerOptions })`; catch `NoObjectGeneratedError.isInstance(e)` → throw `new TextModelInvalidObjectError(e.message, { cause: e })`.
- [ ] Step 3: In every policy file replace `Config` by `BrowsePolicyOptions` (or a narrowed `Pick`), `createModel(config, config.STRUCTURED_MODEL, …)` by `opts.models.structured`, `config.BROWSE_CASCADE_MODEL` by `opts.models.cascade` (the cascade's `model` diag string becomes `opts.models.cascade.id`), `config.BROWSE_STEP_VISION === "on"` by `opts.vision === true`, `isOpenAIDecisions(config.TYPESAFE_MODEL)` by `isOpenAIDecisions(opts.decisionModel)`, `generateObject({model, …})` by `model.generateObject({…})`, `NoObjectGeneratedError.isInstance` by `TextModelInvalidObjectError.isInstance`; imports of `../services/systemone.js`/`../analysis/pii.js` → `./decisions.js`/`./pii.js`.
- [ ] Step 4: Write `schemas.ts` (copy the zod body schemas + `normalizeScreenshot` from the backend routes, verbatim) and `decide.ts` (copy the orchestration of `browseStepRoutes`' `decide` callback: vision gate `vision && !isJevModel(decisionModel)`, bot wall → policy (`policy ?? "ultrafast"`) → `commitGuard` with `BROWSE_STEP_OVERALL_DEADLINE_MS + 1_000 - elapsed`; and the plan/locate route bodies the same way). Write `index.ts` barrel.
- [ ] Step 5: Port tests: replace `vi.mock("../src/ai/provider.js", …)` + `createModel` mocks by passing `aiSdkTextModel(new MockLanguageModelV3(...))` models in `BrowsePolicyOptions`; adapt `structuredModelFakes.ts` to build such models (keep `mockJsonModelOnce` helper semantics: the next text-model call answers the given object and records signal/prompt); replace `makeConfig(...)` by an options builder in `test/policy/browseFakes.ts`. Keep every assertion.
- [ ] Step 6: New tests `test/policy/decide.test.ts`: (a) jev model + `vision: true` ⇒ policy sees `screenshot: undefined` (Review Focus 1); (b) bot-wall page ⇒ `blocked` without a decision call; (c) legacy vs ultrafast selection. `test/adapters/aiSdk.test.ts`: invalid JSON twice ⇒ `TextModelInvalidObjectError` (Review Focus 5); valid JSON ⇒ object.
- [ ] Step 7: `npx vitest run test/policy test/adapters/systemoneHttp.test.ts test/adapters/aiSdk.test.ts` → PASS; tsc filtered to `src/policy|src/adapters/(systemoneHttp|aiSdk)|test/policy|test/adapters/(systemoneHttp|aiSdk)` → empty; eslint on those paths → 0.

### Task 3: Loop layer + HTTP backend + storage

**Files:**
- Modify: `src/loop/{browseTask,actionCache,actionEffect,loopGuard,shared}.ts`
- Create: `src/loop/{bridge,backend,storage,index}.ts`, `src/adapters/httpBackend.ts`
- Test: `test/loop/*`; Create: `test/adapters/httpBackend.test.ts`

**Interfaces:**
- Produces `src/loop/bridge.ts`: `interface BrowserBridge { open(a:{url:string}):Promise<unknown>; act(a:Record<string,unknown>):Promise<unknown>; read(a:Record<string,unknown>):Promise<unknown>; snapshot():Promise<unknown>; perform(a:{snapshotId:string;index?:number;operation:string;text?:string}):Promise<unknown>; findImages?(a:Record<string,unknown>):Promise<unknown>; screenshot?(a?:{annotate?:boolean;snapshotId?:string}):Promise<unknown>; tabs?(a:Record<string,unknown>):Promise<unknown> }` — copy the exact member list and doc comments from `pen-editor/src/lib/desktopBridge.ts`' `browser` block.
- Produces `src/loop/backend.ts`: `BrowseEndpoint`, `BrowseBackendResponse`, `BrowseBackend` (spec).
- Produces `src/loop/storage.ts`: `KeyValueStorage`, `memoryStorage()`.
- Produces `src/loop/index.ts`: `runBrowseTask(goal, opts: RunBrowseTaskOptions): Promise<Transcript>`, `RunBrowseTaskOptions` (spec "Loop entry point"), `Transcript`, `TranscriptStep`, `BrowsePermissions` (shape copied from `pen-editor/src/store/browserAgentSettingsStore.ts`' `getBrowserAgentPermissions` return type), `runActionsBatch`-free; plus the pure helpers already exported by the moved files.
- Produces `src/adapters/httpBackend.ts`: `createHttpBackend(opts: { baseUrl: string; fetch?: typeof fetch; headers?: Record<string,string> | (() => Record<string,string>) }): BrowseBackend`.

- [ ] Step 1: `shared.ts`: `fetchBrowseBackend(backend: BrowseBackend, path, body, timeoutMs, signal, retry)` — keep the retry loop, replace `fetchBrowseBackendOnce` by `backend.request(path, body, { timeoutMs, signal })`; move `fetchBrowseBackendOnce` body to `adapters/httpBackend.ts` (`apiFetch(path)` → `fetch(new URL(path, baseUrl))`, the overall timeout stays inside the adapter). Drop the `PenDesktopBrowser`/`window.penDesktop` types for `BrowserBridge`; drop the tool-handler-only helpers (`callBrowserBridge`, `attachSnapshot`, `BROWSER_NOT_AVAILABLE_ERROR` stay only if `browseTask.ts` uses them).
- [ ] Step 2: `actionCache.ts`: every `localStorage` use → a `KeyValueStorage` parameter (thread it from the loop options; no storage ⇒ disabled, Review Focus 4). Keep keys, TTL, cap and format.
- [ ] Step 3: `browseTask.ts`: delete the `ToolHandler` `browseTask` export and `toolRegistry`/store/bridge imports; thread a single internal `LoopEnv { browser; backend; permissions?; storage?; cloud: boolean; stepScreenshots: boolean }` through `runBrowseTask`/`runBrowseTaskLoop`/helpers in place of `getBrowserAgentPermissions()`, `isDesktopBrowserAvailable()`, `localStorage` flag reads, and `getBrowserBridge()`. `browseTaskDeadlineMs()`/`browseTaskOverallDeadlineMs()`/`browseTaskInnerBoundMs()` take `cloud: boolean`. Export the `runBrowseTask(goal, opts)` signature from the spec; keep the positional internal function under another name if that minimizes the diff.
- [ ] Step 4: Port tests: `window.penDesktop.browser` fakes → a `BrowserBridge` fake passed in; `fetchBrowseBackend` `vi.mock` → a fake `BrowseBackend`; Zustand store setup → `permissions` option; `localStorage` → `memoryStorage()`; drop `vi.mock("@/lib/cloudBrowser")` in favour of `cloud: true|false`. Do not port `browserTools.test.ts` (pen-editor tool glue). Keep every assertion that concerns the loop.
- [ ] Step 5: New `test/adapters/httpBackend.test.ts`: URL join (`baseUrl` with and without trailing slash), JSON body/headers, non-JSON body ⇒ `body: null`, `Retry-After: 5` ⇒ `retryAfterSec: 5`, timeout aborts. Plus a loop test: storage omitted ⇒ cache no-op and the task still completes.
- [ ] Step 6: `npx vitest run test/loop test/adapters/httpBackend.test.ts` → PASS; tsc filtered to `src/loop|src/adapters/httpBackend|test/loop|test/adapters/httpBackend` → empty; eslint on those paths → 0.

### Task 4: Integration adapters, barrel, example, docs (after 1–3)

**Files:**
- Create: `src/adapters/localBackend.ts`, `src/adapters/controllerBridge.ts`, `src/index.ts`, `examples/run-task.ts`, `README.md`, `CLAUDE.md`, `docs/migration-plan.md`
- Test: `test/adapters/{localBackend,controllerBridge}.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 exports.
- Produces: `createLocalBackend(opts: BrowsePolicyOptions): BrowseBackend`; `controllerBridge(c: BrowserController): BrowserBridge`.

- [ ] Step 1: `localBackend.ts`: route on `path`; `safeParse` the matching schema → `{status:400, ok:false, body:{error}}` on failure (Review Focus 2); call `decideStep`/`planGoal`/`locateTarget`; strip `diag`; `SystemOneRateLimitError` → 429 (+`retryAfterSec` when the error carries one), other `SystemOneError` → 502, anything else → 500 (Review Focus 3). Tests for each branch.
- [ ] Step 2: `controllerBridge.ts`: forward each `BrowserBridge` method to the same-named `BrowserController` method. Test with a fake target.
- [ ] Step 3: `src/index.ts` re-exports `controller`, `policy`, `loop` barrels (not the adapters — they have peer deps).
- [ ] Step 4: `examples/run-task.ts`: env `CDP_URL` (or launch local chromium via `playwright-core` `chromium.launch()` when absent), `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`; builds `createSystemOneClient`, two `aiSdkTextModel(createOpenRouter(...))` — use `@ai-sdk/openai-compatible` or document the model as a parameter; runs `runBrowseTask(process.argv[2], {...})` and prints the transcript. Must type-check under `npm run lint`.
- [ ] Step 5: README (install from private git, quick start, API per layer, adapters, isomorphism note), CLAUDE.md (commands, layout, invariants: no host imports, isomorphic layers, provenance of copied code), `docs/migration-plan.md`.
- [ ] Step 6: `npm run lint && npm test && npm run build` → all green.
