# Stage 1 report — 2026-10-13 (headless night run)

Repository: https://github.com/dan-rozhkov/browser-agent (private)
Code commit: `fda7ddd` on `main` (this report is the commit after it).

## Result

- New git repo `browser-agent/` next to the other three. It is a TypeScript
  library (`@sideform/browser-agent`, `private: true`, 0.1.0) with ESM/NodeNext,
  subpath exports and `typesVersions` (so CommonJS/node10 consumers such as
  pen-editor-desktop also resolve the types).
- `npm run lint` (tsc + eslint), `npm test` (22 files, **1414 tests**) and
  `npm run build` are green locally and in a clean clone (`npm ci` runs
  `prepare` → build). GitHub Actions CI runs the same three on push/PR.
- About 23 k lines of source and 19 k lines of tests.

## What moved

| Layer | From | Into |
|---|---|---|
| Page controller, page scripts, keys, `decideBrowserNavigation` | pen-editor-desktop `3d8f975` | `src/controller/` |
| Step policy (legacy + ultrafast), commit guard, captcha, locate, plan, PII scrub, route orchestration + zod body schemas | pen-editor-backend `53f710e` | `src/policy/` |
| `browse_task` loop, action cache, action effect, loop guard, shared helpers | pen-editor `792b4e30` | `src/loop/` |
| Playwright target + `connectOverCdp` + redaction (the cloud-browser adapter) | pen-editor-backend | `src/adapters/playwright.ts` |
| System One HTTP client (Jev / Luna via OpenRouter) | pen-editor-backend | `src/adapters/systemoneHttp.ts` |

Host dependencies were replaced by interfaces:

| Was | Now |
|---|---|
| Electron `WebContents` | `BrowserTarget` / `BrowserPageHandle` (already existed; adapter: `PlaywrightTarget`) |
| `services/systemone.ts` + `Config` | `DecisionClient` (adapter: `createSystemOneClient`) |
| `createModel(config, …)` + AI SDK `generateObject` | `TextModel` (adapter: `aiSdkTextModel`) |
| `Config` env vars | `BrowsePolicyOptions` (`policy`, `vision`, `decisionModel`, `models.structured`, `models.cascade`) |
| Fastify routes | `decideStep` / `planGoal` / `locateTarget` + `createLocalBackend` (in-process) |
| `apiFetch` to `/api/browse/*` | `BrowseBackend` (adapters: `createHttpBackend`, `createLocalBackend`) |
| `window.penDesktop.browser` | `BrowserBridge` (adapter: `controllerBridge`) |
| Zustand settings store | `permissions` option |
| `localStorage` | `KeyValueStorage` (`memoryStorage()`; pen-editor passes `localStorage`, same key and format) |

Also: `examples/run-task.ts` (Playwright + System One + OpenRouter via
`@ai-sdk/openai-compatible`), `README.md` with the API, `CLAUDE.md`,
`docs/design.md`, `docs/plan.md`, `docs/migration-plan.md`.

## Review

Two `/code-review` rounds (high, then medium on the fix commit).
Round 1: 10 findings, all fixed (effective decision model, plan budget,
`credentials`, inner race bound, System One key per route, 502 mapping like
the route, example structured output, migration snippet, cross-copy error
check, request signal into the in-process policy). Round 2: 10 findings, 9
fixed. One was kept on purpose: with no `decisionModel` and no
`DecisionClient.model`, the policy assumes `jev-latest` (text-only). This is
the old `TYPESAFE_MODEL` default and the safe side, because a screenshot sent
to a text-only model stalls the task. This is documented in the README.

## Not done / open

- **The three existing repos were not changed** (as required). The
  migration is a plan only: `docs/migration-plan.md`. Order: tag `v0.1.0` →
  backend (policy + cloud-browser vendor) and desktop (controller) in any
  order → pen-editor (loop) last.
- **CI access for consumers:** a read token for the private repo must be
  added to the consumer repos' CI and to Render's build env. This is prod
  env, so a person must do it.
- **No live run.** The example was not run against real sites or real
  keys. Before a consumer migrates, run it once and do a `bench/browse-task`
  run. Unit tests did not catch earlier Luna/Jev regressions.
- **Behaviour differences of the library entry point (by design):**
  `runBrowseTask` does not catch errors and turn them into `{error}` JSON.
  That stays in the host's tool handler (see the migration snippet). When no
  `permissions` are given, the step body has none, and the policy then uses
  its defaults (confirm irreversible: on, password entry: off).
  `createSystemOneClient` throws on a missing key instead of returning `null`.
- **Not ported tests:** the Fastify route tests (`browse-step-route`,
  `browse-locate-route`, the plan "503 without key" test). They test backend
  glue and stay in the backend. pen-editor's `browserTools.test.ts` and
  `bridge.test.ts` test tool glue. Seven `navigation.test.ts` blocks cover
  Electron-only functions that did not move.
- **PII scrub is duplicated** (the backend keeps `analysis/pii.ts` for trace
  analysis). The migration plan adds a parity test.
- Tag `v0.1.0` points at the commit that adds this report (CI green on `fda7ddd`).
