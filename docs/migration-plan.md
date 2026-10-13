# Migration plan: pen-editor repos → `@sideform/browser-agent`

Status: done 2026-10-13 on v0.2.1. pen-editor-backend `2cb790f`, pen-editor-desktop
`73d17e5`, pen-editor `e8b56e8f`. Bench: 7/7 ultrafast scenarios (2 live sites).
The copies in the three repos are gone: fix browser use here, then bump the
tag in each consumer.

## 0. Preconditions (all repos)

1. **Distribution.** The repo is public (MIT) and the package is not on a
   registry. Install it from GitHub, pinned to a tag:
   `"@sideform/browser-agent": "github:dan-rozhkov/browser-agent#v0.2.1"`.
   npm runs the package's `prepare` script (`npm run build`) on install, so
   `dist/` is built on the consumer side.
2. **CI access.** None needed: the repo is public, so `npm ci` in GitHub
   Actions and in the Render build fetches it without a token.
3. **Tag** on `browser-agent` `main` after it is green. Consumers bump the
   tag in `package.json`, never point at a branch.
4. **Freeze window.** While a layer migrates, browser-use fixes land in
   `browser-agent` first, then the consumer bumps the tag. Do not fix the
   same bug in both places.

## 1. Merge order

```
browser-agent v0.2.0
   │
   ├─► (A) pen-editor-backend: policy + cloud browser    ─┐
   ├─► (B) pen-editor-desktop: controller                 ├─ independent of each other
   │                                                      │
   └─► (C) pen-editor: loop (needs A deployed: same HTTP ─┘
           contract, so no hard order — but land C last
           so the contract test below has a real backend)
```

A and B can land in any order: the HTTP contract (`/api/browse/step`,
`/plan`, `/locate`) and the desktop IPC contract (`browser:command`) do not
change. C is last because it drops the frontend's copy of the loop and the
cross-repo `commitLabelContract.test.ts` then needs a new home (step C4).
No tool-schema change is involved, so the root CLAUDE.md "backend first"
tool-contract rule is not triggered.

## (A) pen-editor-backend

The backend has two copies to retire: the step policy (`src/ai/browse*.ts`)
and the vendored controller for the cloud browser (`src/browser/vendor/`,
regenerated from desktop by `npm run browser:sync`).

A1. Add the dependency; keep `ai`, `zod`, `playwright-core` (they become
    peer deps of the package — already present).

A2. **Policy.** Replace `src/ai/browseStep.ts`, `browseStepUltrafast.ts`,
    `browseCommitGuard.ts`, `browseCaptcha.ts`, `browseLocate.ts`,
    `browsePlan.ts` with imports from `@sideform/browser-agent/policy`. Build
    the options once in `app.ts`:

    ```ts
    import { aiSdkTextModel } from "@sideform/browser-agent/adapters/ai-sdk";
    const policy: BrowsePolicyOptions = {
      decisions: systemOneClient,                 // see A3
      models: {
        structured: aiSdkTextModel(createModel(config, config.STRUCTURED_MODEL, { reasoningEffort: "none" }), { id: config.STRUCTURED_MODEL }),
        cascade:    aiSdkTextModel(createModel(config, config.BROWSE_CASCADE_MODEL, { reasoningEffort: "none" }), { id: config.BROWSE_CASCADE_MODEL }),
      },
      policy: config.BROWSE_STEP_POLICY,
      vision: config.BROWSE_STEP_VISION === "on",
      decisionModel: config.TYPESAFE_MODEL,
    };
    ```

    `routes/browseStep.ts`, `browsePlan.ts`, `browseLocate.ts` keep the
    Fastify registration, rate limit and logging, and call
    `decideStep(policy, body)` / `planGoal` / `locateTarget`, validating
    with the package's `browse*BodySchema`. Keep the startup warning for
    `BROWSE_STEP_VISION=on` + `jev*` in the route (the package only gates
    silently).

A3. **System One.** `src/services/systemone.ts` has other callers (taste
    check, skill routing, trace analysis). Keep the file for one release as
    a thin wrapper: `createSystemOne(config)` → `createSystemOneClient({
    apiKey: config.TYPESAFE_API_KEY, model: config.TYPESAFE_MODEL, baseUrl:
    config.TYPESAFE_BASE_URL, openRouterApiKey: config.OPENROUTER_API_KEY })`
    (returning `null` when the key is empty, as before), and re-export the
    types from `@sideform/browser-agent/policy`.

A4. **PII.** `src/analysis/pii.ts` is used outside browsing (trace
    analysis). Keep it in the backend. The package carries its own copy;
    the two must not drift — add a backend test that runs both
    `scrubPii`s over the same fixture list.

A5. **Cloud browser vendor.** Delete `src/browser/vendor/`,
    `scripts/sync-browser-vendor.mjs`, `test/browserVendorSync.test.ts` and
    the `browser:sync` script. `src/browser/playwrightHandle.ts`,
    `connect.ts`, `redact.ts` → import `PlaywrightTarget`,
    `connectOverCdp`, `redactedError` from
    `@sideform/browser-agent/adapters/playwright`. `cloudSessions.ts` keeps its
    `CommandRunner` type; `connectOverCdp`'s `controller` satisfies it.
    The vendored copy was pinned to a desktop commit; the package tag now
    plays that role.

A6. Move tests: delete `test/browse-step*.test.ts`,
    `browse-commit-guard`, `browse-captcha`, `browse-locate.test.ts`,
    `browse-plan.test.ts`, `browseFakes.ts`, `cloudBrowserHandle.test.ts`
    (they live in the package). Keep the route tests
    (`browse-step-route`, `browse-locate-route`) — they now test the
    backend's glue against the package.

A7. Gate: `npm run lint && npm test && npm run build`, then a manual
    `bench/browse-task` run (memory: the bench is the real check for the
    policy — unit tests did not catch the Luna/Jev regressions).

## (B) pen-editor-desktop

B1. Add the dependency. The desktop is CommonJS (`"module": "commonjs"`)
    and the package is ESM-only. Electron 43 ships Node 24, whose
    `require()` loads synchronous ESM, so `tsc`-emitted `require(...)`
    works. Types resolve through the package's `typesVersions` under the
    desktop's node10 resolution — no tsconfig change needed. Verify both
    with a packaged build (`npm run dist` or equivalent), not only `tsc`.

B2. Replace `src/main/browser/controller.ts`, `pageScripts.ts`, `keys.ts`
    with imports from `@sideform/browser-agent/controller`. `navigation.ts`
    keeps everything Electron-specific and imports
    `decideBrowserNavigation` from the package (or keeps its own — it is
    10 lines; prefer the import so the two cannot drift).
    `tabManager.ts` keeps `BrowserTabInfo` as a re-export of the package
    type. `window.ts` keeps its Electron `BrowserTarget` /
    `BrowserPageHandle` implementation over `WebContentsView` — it already
    implements the package's interface.

B3. Move tests: `test/browserController.test.ts`, `keys.test.ts` and the
    `decideBrowserNavigation` part of `navigation.test.ts` are in the
    package; delete them here. Keep the Electron-policy parts of
    `navigation.test.ts` and `browserPermissions.test.ts`.

B4. Cross-repo contract: the desktop menu ↔ pen-editor command-palette
    contract is unaffected.

B5. Gate: lint/test/build + a manual smoke in the packaged app
    (`browse_task` on one real site) — CDP and `executeJavaScript`
    behaviour cannot be covered by unit tests.

## (C) pen-editor (frontend)

C1. Add the dependency. Vite bundles the package's ESM directly; the
    `loop` entry is isomorphic (no `node:*`), so no polyfills.

C2. Replace `src/lib/tools/browser/browseTask.ts`, `actionCache.ts`,
    `actionEffect.ts`, `loopGuard.ts` and the loop parts of `shared.ts`
    with `@sideform/browser-agent/loop`. The `browseTask` `ToolHandler` stays
    and becomes glue:

    ```ts
    import { runBrowseTask } from "@sideform/browser-agent/loop";
    import { createHttpBackend } from "@sideform/browser-agent/adapters/http-backend";
    const backend = createHttpBackend({
      baseUrl: resolveApiUrl("/"),
      credentials: credentialsMode, // "include" when accounts are on
    });

    export const browseTask: ToolHandler = async (args, context) => {
      const browser = getBrowserBridge(context?.sessionId);
      if (!browser) return JSON.stringify({ error: BROWSER_NOT_AVAILABLE_ERROR });
      const goal = typeof args.goal === "string" ? args.goal : "";
      const maxSteps =
        typeof args.maxSteps === "number" && Number.isFinite(args.maxSteps) ? args.maxSteps : undefined;
      const url = typeof args.url === "string" && args.url.length > 0 ? args.url : undefined;
      try {
        const transcript = await runBrowseTask(goal, {
          browser,
          backend,
          permissions: getBrowserAgentPermissions(),
          storage: globalThis.localStorage,
          cloud: !isDesktopBrowserAvailable(),
          stepScreenshots: browseStepScreenshotEnabled(),
          signal: context?.signal,
          maxSteps, url,
        });
        return JSON.stringify(transcript ?? {});
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : "browse_task failed." });
      }
    };
    ```

    (`runBrowseTask` owns the hard inner time bound; the handler's own
    race/abort plumbing is deleted.)

    `bridge.ts`, `browseAct.ts`, `browseOpen.ts`, `browseRead.ts`,
    `browseScreenshot.ts`, `browseSnapshot.ts`, `browseTabs.ts`,
    `browseFindImages.ts` stay (tool glue). `browseAct.ts` imports
    `fetchBrowseBackend` from the package with the same `backend`.
    `PenDesktopApi["browser"]` in `desktopBridge.ts` should be typed as
    the package's `BrowserBridge` so the two cannot drift.

C3. **Cache compatibility.** The package keeps the cache key
    `pen.browseActionCache.v1`, the kill switch `pen.browseActionCache`,
    TTL and cap, so users keep their cached actions. Passing
    `localStorage` as `storage` is the whole migration.

C4. Move tests: delete `__tests__/browseTask.test.ts`, `actionCache`,
    `actionEffect`, `loopGuard`, `shared` tests (now in the package). Keep
    `browserTools.test.ts` and `bridge.test.ts` (glue).
    `src/lib/__tests__/commitLabelContract.test.ts` compared the
    frontend's `isIrreversibleLabel` with the backend's
    `COMMIT_LABEL_SAMPLES` across repos; both now live in the package —
    move it there (one repo, no `skipIf`), and delete it here.

C5. Gate: lint/test/build + `npm run test:e2e` + a live `browse_task` in
    the desktop shell and once with the cloud browser (Steel).

## Rollback

Each step is a pure import swap with no data or contract change. Reverting
the PR restores the old copy. The action cache format and the HTTP and IPC
contracts are unchanged, so mixed versions (e.g. migrated backend + old
desktop) work.

## Later (not stage 1)

- Publish to a private registry (GitHub Packages) instead of `github:`
  installs, so consumers do not build on install.
- Move the cursor engine and the cloud session manager
  (`cloudSessions.ts`) into the package if a second service needs them.
- A shared conformance suite for `BrowserTarget` implementations
  (Electron, Playwright) — today the Electron one is tested only by e2e.
