# QA mode - design (2026-10-17)

A mode of `runBrowseAgent` for testing a web app. One scenario is one ordinary
browse-agent run. The package does not orchestrate: no suite, no pool, no
concurrency. The consumer decides how many runs go in parallel (in Pen Editor the
main agent calls `browse_agent` N times), and what to do with each result. Builds
on the QA start (`2026-10-15-qa-start-design.md`): the scenario's browser state
comes from a `PageFixture`.

Isolation is the consumer's: each parallel run needs its OWN browser. Several agents
on one page are not supported (one page has one focus and one input queue; a failure
could not be attributed). `playwrightContexts(browser)` in `adapters/playwright` is a
helper for it: it returns a function that makes a new `BrowserContext` per call
(`PlaywrightTarget` -> `BrowserController` -> `controllerBridge`) and gives
`{ browser, close }`. Cookies, storage and network mocks (`context.route`) are per
context.

## API

```ts
const r = await runBrowseAgent(goal, { model, browser, fixture, qa: true });
// or qa: { onScreenshot(img) { ... } }
// r.qa = { outcome, verdict?, reason?, steps, stepsDropped? }
```

`RunBrowseAgentOptions.qa?: boolean | { onScreenshot?(img: { mediaType, base64 }): void | Promise<void> }`.
When on:

- The model gets one extra tool, `qa_verdict({ verdict: "pass" | "fail", reason })`
  (reason trimmed, 1 to 500 chars). It is a `singleUseTool`: a second call is refused
  by the guard before it runs (not a step), and the first verdict stays. A call with bad
  input is an error and does not use up the verdict.
- Prompt: with `prompt` unset or an options object, the principal is "a QA engineer"
  (unless the host set one) and the QA section is added after the host's sections.
  With `prompt` as a string the text is the host's and is not touched: the host must
  include the exported `QA_PROMPT_SECTION`. Without `qa` the prompt is unchanged.
  The section: you test a web app; do the scenario; check the expected result on the
  page; call `qa_verdict` exactly once at the end, `fail` when the app does not behave
  as the scenario expects; a blocked step (CAPTCHA, login wall, missing page) is not a
  fail, so do not call it and explain in the answer.
- The run ends right after a successful `qa_verdict` (no more model request), so the final
  answer text can be empty; the reason is in `qa`.
- Reserved names: a host extra tool named `qa_verdict` makes the call throw (before any
  browser command); result fields `qa` and `qaVerdict` from a host tool's `end` hook are dropped.
- The steps come from the general `onToolCall` hook (see below). The host's own
  `onToolCall` is still called.

## Result

`qa` is an extra field of the run result, so `JSON.stringify(result)` has the key order
`status, answer, steps, qa, error, setupStage`. It is the string a host gives its main
model, so it holds no screenshot, no base64 and no times.

```ts
interface QaResult {
  outcome: QaOutcome;
  verdict?: "pass" | "fail";
  reason?: string;     // the verdict reason; for outcome "error" with no verdict and no run `error`: why the run ended
  steps: { index, tool, args, ok, error? }[];   // the last 30
  stepsDropped?: number;
}
```

| run status | verdict | outcome |
|---|---|---|
| `setup_failed` | - | `setup_failed` (fixture broke; `setupStage` and `error` stay on the result) |
| `aborted` | - | `aborted` |
| any | `pass` | `passed` |
| any | `fail` | `failed` |
| `done` | none | `inconclusive` |
| `error`/`timeout`/`step_limit` | none | `error` |

`reason` for an `error` outcome without a verdict: only when the result has no top-level
`error` (it is not copied): "request limit reached" (`step_limit`), "deadline reached"
(`timeout`), else "the run ended with status X". Key order of `qa`: `outcome, verdict, reason,
steps, stepsDropped`.

## Steps

One step per tool call of the MODEL (the seven browse tools and `qa_verdict`), not the
bridge calls a tool made. `runBrowseAgent` has a general `onToolCall` hook: it is called
when an execution starts with `{ toolName, input, toolCallId, preOpen? }` and returns a
function that gets `{ output }` or `{ error }` when it ends. The step slot and index are
taken at the start, so parallel calls keep their order. The pre-open of `url` is the
session's own call (`preOpen: true`) and is not a step; the fixture setup is not a model
call either, so fixture data (secret) cannot reach the result. A step is
`{ index, tool, args, ok, error?, ms }`; `args` is the model's input with `text` values
over 200 chars cut (also inside a `browse_act` batch); `error` is capped like the run's `error` (300 chars). `ok` is false when the result
string is an object with a string `error`, when the tool threw, or when the call did not
end. In the result `ms` is left out and only the last 30 steps stay.

## Final screenshot

Only when `qa: { onScreenshot }` is given. After the run, before the fixture release (the
mocks are still live), the run calls `browser.screenshot({})` once, bounded to 10 s. The
callback gets `{ mediaType, base64 }` AFTER the release and the journal stop, so a slow
host callback holds neither the mocks nor the browser. It is never put into the result. Only
jpeg, png and webp count (`normalizeScreenshot`); bare base64 (what `PlaywrightTarget`
gives) and data URLs are both accepted. Not taken for `setup_failed`, `aborted` and
`timeout` (the controller may still hold its lock). A failed screenshot is ignored, and
so is a throw or rejection in the callback; an async callback is awaited for at most 15 s.

## Parts for a host on the session core

`src/agent/qa.ts` (zod only; no `ai`, no `node:*`) is exported from `@sideform/browser-agent/agent`:
`QA_PROMPT_SECTION`, `QA_VERDICT_TOOL`, `qaVerdictDefinition`, `qaVerdictHooks()`,
`executeQaVerdict`, `qaOutcome(status, verdict)`, `qaResultOf(result, steps)`,
`createStepRecorder()` and the types `QaOutcome`, `QaStep`, `QaResult`. A host that drives
the session itself (Pen Editor's frontend) assembles the same thing from them.

## Example and smoke

- `examples/qa-suite.ts <scenarios.json>`: a real model (OpenRouter), a small pool written in
  the example (consumer code), one `runBrowseAgent({ qa: true })` per scenario in its own
  context, one summary line per scenario.
- `npm run qa-smoke` (`examples/qa-smoke.ts`): no keys. Real Chromium, a local HTTP server, a
  scripted mock model, `Promise.all` over 3 runs: each sets its own cookie through its
  fixture and must not see the others' (isolation); one passes, one fails, one has a fixture
  that fails `expect` (`setup_failed`). Checks the results, the steps, the screenshots
  from the callback, and that the results hold no base64 and no fixture data.
