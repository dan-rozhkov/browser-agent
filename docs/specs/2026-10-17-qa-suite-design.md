# QA suite — design (2026-10-17)

Sub-project on top of `runBrowseAgent` and the QA start (`2026-10-15-qa-start-design.md`).
A QA host gives a list of scenarios. The suite runs N browse agents in parallel,
each in its OWN browser (a new Playwright `BrowserContext`, or what the host's
factory gives), each with its own `PageFixture` and one scenario. At the end it
gives one report object: scenario → outcome → steps → final screenshot.

Not in scope: several agents (cursors) on one page. One page has one focus and one
input queue; agents would read each other's stale snapshots, and a failure could not
be attributed. Isolation is the point.

## API — subpath `@sideform/browser-agent/qa`

Imports `ai` (through `runBrowseAgent`), no `node:*`. The suite writes nothing to disk.
Not in the `agent` light import graph.

```ts
interface QaScenario {
  id: string;                 // unique in the suite; [A-Za-z0-9_-]{1,64} (short, easy to name)
  title?: string;
  goal: string;               // what to do and what to check ("Add 2 items, check the cart badge says 2")
  url?: string;               // start URL; `url` and `fixture` together are an error (runBrowseAgent rule)
  fixture?: PageFixture;      // state of THIS scenario's browser
  allowNetworkMocks?: boolean;
}

interface QaBrowser { browser: BrowserBridge; close(): Promise<void> }

interface RunQaSuiteOptions {
  model: LanguageModel;
  /** A fresh isolated browser per scenario. Called once per scenario; `close` is called in every outcome. */
  openBrowser(scenario: QaScenario, ctx: { signal?: AbortSignal }): Promise<QaBrowser>;
  concurrency?: number;       // default 3; < 1 or NaN throws; Infinity = all at once; clamped to the scenario count
  signal?: AbortSignal;       // aborts all running scenarios; not-started ones get outcome "aborted"
  providerOptions?: Record<string, Record<string, unknown>>;
  /** Passed to every runBrowseAgent call. */
  agent?: Pick<RunBrowseAgentOptions, "maxRequests" | "deadlineMs" | "toolResultImages" | "screenshots" | "maxOutputTokens" | "toolDefinitions">;
  /** Called when a scenario ends (progress). A throw is ignored. */
  onScenarioDone?(report: QaScenarioReport): void;
  now?(): number;             // test seam, default Date.now
}

function runQaSuite(scenarios: QaScenario[], opts: RunQaSuiteOptions): Promise<QaSuiteReport>;
```

Validation before anything runs (throws `Error`): empty list, duplicate or invalid
`id`, empty `goal`, `url` + `fixture`, `concurrency` below 1 or NaN, `agent.maxRequests`
or `agent.deadlineMs` that is not a positive number (the session rule). A failure inside one scenario (also a bug) gives
that scenario outcome `error`; `runQaSuite` itself does not reject after validation.

## Verdict

The model gets one extra tool, `qa_verdict({ verdict: "pass" | "fail", reason: string })`
(reason ≤ 500 chars, trimmed). The suite's prompt is `buildBrowseAgentPrompt` with
principal `"a QA engineer"` and a section: you test a web app; do the scenario; check
the expected result on the page; call `qa_verdict` exactly once at the end, with `fail`
when the app does not behave as the scenario expects; a blocked step (CAPTCHA, login
wall, missing page) is not a fail — do not call `qa_verdict`, explain in the answer.
A second `qa_verdict` call returns an error string and does not change the first verdict.

Outcome of a scenario (`QaOutcome`):

| run status | verdict | outcome |
|---|---|---|
| `setup_failed` | — | `setup_failed` (fixture broke; `setupStage` kept) |
| `aborted` | — | `aborted` |
| any | `pass` | `passed` |
| any | `fail` | `failed` |
| `done` | none | `inconclusive` |
| `error`/`timeout`/`step_limit` | none | `error` (`error` text from the run, else "request limit reached" / "deadline reached") |
| `openBrowser` threw, or returned no browser | — | `error` (no run) |

## Steps

The suite records the tool calls of the MODEL, not the bridge calls the tools make.
`runBrowseAgent` has a general `onToolCall` hook (start with the tool name and input,
and a function that gets the result string or the error). A step is taken when the
call STARTS, so its index and its place in the list follow the call order, also for
parallel calls. All tools are steps: the seven browse tools and `qa_verdict`. The
pre-open of `url` (the hook marks it `preOpen: true`) and the fixture setup are not model calls, so they are not steps,
and fixture data (secret) cannot reach the report. Each step:
`{ index, tool, args, ok, error?, ms }`. `args` is the input the model gave, with
`text` values longer than 200 chars cut (also inside a `browse_act` batch). `ok` is
false when the result string is an object with a string `error`, or the tool threw,
or the call did not end (abort).

## Final screenshot

After the run, before `close`, the suite calls `browser.screenshot?.({})` once
(bounded to 10 s, failures ignored) and keeps `{ mediaType, base64 }` from the
`imageData` data URL. Not taken for `setup_failed`, `aborted` and `timeout` (the controller may still hold its lock). Only jpeg, png and webp count (`normalizeScreenshot`); anything else gives no screenshot.

## Report

```ts
interface QaScenarioReport {
  id: string; title?: string; goal: string;
  outcome: QaOutcome;
  verdictReason?: string;
  answer: string;             // the agent's final answer
  status?: BrowseAgentStatus; // absent when openBrowser threw
  error?: string; setupStage?: string;
  steps: QaStep[];
  screenshot?: { mediaType: string; base64: string };
  startedAt: string; durationMs: number;   // ISO
}
interface QaSuiteReport {
  startedAt: string; durationMs: number; concurrency: number;
  summary: { total: number } & Record<QaOutcome, number>;
  scenarios: QaScenarioReport[];   // in input order, not finish order
}
```

The result is this object, nothing else. The suite writes no files and builds no
text for a model; what to do with the report (store it, format it for a model, show
the screenshot on a canvas) is the consumer's decision. The screenshot data stays in it
for that reason.

## Playwright helper

`playwrightContexts(browser: Browser, contextOptions?, controllerOptions?)` in `adapters/playwright`
returns an `openBrowser` that makes a new `BrowserContext` per scenario
(`PlaywrightTarget` → `BrowserController` → `controllerBridge`); `close` closes the
context. Full isolation: cookies, storage, network mocks (`context.route`) are per context.

## Example and smoke

- `examples/qa-suite.ts <scenarios.json>` prints one summary line per scenario — real model (OpenRouter, like `run-agent.ts`).
- `npm run qa-smoke` (`examples/qa-smoke.ts`): no keys. Real Chromium, a local HTTP
  server, a scripted mock model, 3 scenarios with concurrency 3: each sets its own
  cookie through its fixture and must not see the others' (isolation), one passes,
  one fails, one has a fixture that fails `expect` (`setup_failed`). Checks the returned object.

## Later review decisions

- `openBrowser` gets the suite signal and the suite races it: an abort ends the wait
  (outcome `aborted`), and a browser that arrives late is closed, close errors ignored.
- `qa_verdict` uses `singleUseTool`: a repeat is refused by the guard (not a step), the
  verdict reaches the suite as a result field. The reason is trimmed and must not be empty.
