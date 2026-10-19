# CLAUDE.md

`@sideform/browser-agent`: a goal-driven browser agent library (controller + policy
+ loop + adapters), extracted from pen-editor. TypeScript, ESM/NodeNext,
Vitest 4, ESLint 9. Read `README.md` for the API, `docs/design.md` for the
design, `docs/migration-plan.md` for how consumers move onto it.
Controller design notes and fix history (moved from pen-editor-desktop): `docs/controller-notes.md`.

## Commands

```bash
npm run lint      # tsc --noEmit && eslint . (covers src, test, examples)
npm test          # vitest run
npm run build     # tsc -p tsconfig.build.json -> dist/ (src only)
npm run example -- "<goal>"   # examples/run-task.ts; needs API keys and network
```

Run lint, test and build before you call work done. Do not pipe them through
`tail` and trust the exit code (a pipe hides it); check the output.

## Layout

```
src/controller/   BrowserController, page scripts, keys, navigation (BrowserTarget/PageHandle)
src/policy/       decideStep / planGoal / locateTarget, step policies, schemas, DecisionClient, TextModel
src/loop/         runBrowseTask, action cache, loop guard, BrowserBridge, BrowseBackend, KeyValueStorage
src/adapters/     playwright, electron (launchElectronApp; reaches Playwright only through playwright.ts), systemoneHttp, aiSdk, httpBackend, localBackend, controllerBridge
src/agent/        browse agent mode: prompt, tool definitions, session core (zod only); sessionEntry.ts = zod-free `agent/session`; execute.ts + executeEntry.ts = the one executor of the seven browse tools, zod-free `agent/execute`; aiSdk.ts = runBrowseAgent (peer ai); qaCore.ts = QA mode parts (qa_verdict hooks, executeQaVerdict, outcome, step recorder, prompt section; zod-free, exported from `agent/session` and `agent`); qa.ts = the zod schema of qa_verdict, re-exports qaCore
src/shared/       neutral, zod-free code that both controller and agent import (QA check parser/evaluation `qaChecks.ts`, QA result types `qaTypes.ts`); the controller must not import from src/agent
src/fixture/      PageFixture: types, parsePageFixture, applyFixture, captureFixture, network rule matcher (isomorphic, zod-free; subpath `fixture`)
src/index.ts      root barrel: controller + policy + loop + fixture (NOT adapters)
test/<layer>/     mirrors src; examples/ is type-checked by lint
```

`package.json` `exports` and `typesVersions` map each subpath to `dist/`; keep
them in step when you add an entry point.

## Invariants

- No imports from the pen-editor repos, Electron, Fastify or Zustand. This
  package must stand alone.
- `src/loop`, `src/policy` and `src/fixture` are isomorphic (they run in browsers): no
  `node:*` imports, no `ai` import outside `src/adapters/aiSdk.ts`, `src/agent/aiSdk.ts` (the rest of `src/agent` is `ai`-free, `qa.ts` included), no
  Playwright outside `src/adapters/playwright.ts`.
- The loop never imports the policy at runtime (type-only imports are fine).
  It reaches the policy only through a `BrowseBackend`.
- The action-cache `localStorage` key and blob format stay compatible with
  pen-editor, so a consumer keeps its existing cache after migration.
- The HTTP-response shape at the loop/backend seam stays (status, ok, body,
  retryAfterSec). `createLocalBackend` and `createHttpBackend` must stay
  indistinguishable to the loop.
- Adapters carry optional peer dependencies; the root barrel never re-exports
  them. Name collisions between layers are resolved explicitly in
  `src/index.ts`.
- `BrowserTarget.resetSession` and `routeRequests` (QA start) clear or intercept a whole
  browser context. A target in a profile the user also logs into (pen-editor-desktop's
  built-in browser) must scope them: `routeRequests` to the agent's own tabs (CDP `Fetch`
  per tab, never a profile-wide hook) and `resetSession` to the `origins` it is given
  (never "clear everything", or the user is logged out of every site). A network mock
  must be removed by `release()` when the task ends.
- Relative imports use the `.js` suffix.
- Fixes land here first. Do not patch the copies in the consumer repos
  (pen-editor, backend, desktop).
- Releases are made by release-please. Use Conventional Commits. When a
  release PR is open, merge it: this bumps the version, writes `CHANGELOG.md`,
  makes the tag and the GitHub release. Do not write manual `chore: release`
  commits or tags.
- Versioning while 0.x: `feat` and `fix` bump the patch (0.2.x). A breaking
  change bumps the minor (0.3.0).
- Consumers pin an exact git tag (`#v0.2.13`). Renovate in each consumer
  (`renovate.json`) opens a PR that moves the tag. It automerges a patch bump
  when the consumer's CI is green. A minor bump waits for a human.
- The release PR is made with `GITHUB_TOKEN`, so CI does not run on it. It
  changes only the version and `CHANGELOG.md`. The publish job runs lint and
  test again before `npm publish`. If the publish job fails, the tag exists but
  npm does not have the version: fix the cause and re-run the job.
- Do not run `npm publish` by hand. `prepublishOnly` stops it outside GitHub
  Actions.
- npm publish runs in the same workflow after a release, and only when the
  `NPM_TOKEN` secret is set. Without it, consumers install by git tag.

## Testing

- Fakes, not mocks of host modules: `test/policy/browseFakes.ts`
  (`makeOptions`, `fakeClient`, `choice`), `structuredModelFakes.ts`
  (`fakeTextModel`, `textModelCalls`), `test/loop/helpers.ts` (`stubBrowser`).
- No network, no real LLM, no real browser. Browser tests use fake
  `BrowserTarget`/`BrowserPageHandle`.
- The policy fails open (a throwing `DecisionClient` becomes a `retry`
  decision), so to test an error branch of a wrapper, make the entry point
  throw (see `test/adapters/localBackend.test.ts`).
- Do not weaken a moved assertion to make a test pass.

## Provenance

The code was copied from pen-editor-desktop `3d8f975`, pen-editor-backend
`53f710e` and pen-editor `792b4e30`. Comments that cite pen-editor specs
(`docs/superpowers/specs/...`, "Addendum", "Review Focus") are historical
provenance: those files are not in this repo. Keep them; they explain why a
rule exists.
