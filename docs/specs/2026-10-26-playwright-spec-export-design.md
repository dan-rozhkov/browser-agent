# Playwright test from a QA run — design (2026-10-26)

A QA run of the browse agent (`qa: true`) ends with a verdict. A verdict is not
reproducible: the next run is a new LLM run. This feature turns a recorded QA
run into a Playwright `.spec.ts` file. The file replays the run without an LLM,
in CI, for free, with the same result every time.

## How Playwright does it (the reference)

Playwright Test Agents (generator) and Playwright MCP (1.64):

- The model never writes code. Each action tool runs the real action AND appends
  a structured action record `{ name, selector, args }`. A deterministic renderer
  turns the records into code.
- The locator is computed in the live page at action time, from the element the
  model picked (a snapshot ref). The ref never reaches the code. Priority (lowest
  score wins): test id, role + name, placeholder, label, alt, text, title, `#id`,
  role only, tag, nth, CSS. A candidate is used only when it matches exactly one
  element.
- Failed tool calls are not recorded.
- Assertions come from `browser_verify_*` tools that run live. Code is emitted
  only when the check passed.
- No explicit waits in the code (auto-wait, web-first `expect`). Secrets become
  `process.env[...]`.
- The generator never runs the file it writes. A separate healer agent does.

## What we keep, and what we change

| Playwright | Ours | Why |
|---|---|---|
| Action records + renderer | Same | No LLM in code generation |
| Live, scored, unique locator | Same order, computed by a page script before the action | Same reasons. Before the action, because a click can remove the element |
| Only passing assertions | **All** `qa_assert` checks, passing and failing, in call order | A failed check is the bug. The test is red now and turns green when the bug is fixed: a regression test, not only a recording |
| No setup | `setup.network` mocks become `page.route`, `setup.emulate` becomes `test.use` | The run's mocked server answers are part of the bug |
| Secrets to env | Same, and the secret never enters the trace either | The trace bucket is public |
| Silent fallbacks | Every step we cannot replay is a visible `// GAP:` comment and is counted in the header | A reader must know what the file does not cover |

Not in scope (follow-ups): a healer, running the spec after export, iframes,
several tabs, Electron app runs.

## Data flow

1. Host turns recording on: `executeBrowseTool(..., { repro: true })`.
2. The executor adds `repro: true` to the args of `browser.act` and
   `browser.assert`. The model schema does not change; the model never sends it.
3. The controller (`act`): when `args.repro === true` and the action targets an
   element, a page script `LOCATOR_JS` finds the element with the same
   `locateTarget` the action uses (BEFORE the action) and returns a Playwright
   locator description. The act result gets `__repro: { locator } | { gap }`.
   `assert` does the same for each check that has an `index` (`__repro.checks`,
   one entry per check, `null` for a check without an index).
4. The browse tool output carries `__repro`. The trace recorder reads it and
   removes it from the recorded `output`. The session core removes it from the
   text the model gets (`stripRepro`), so the model never pays tokens for it.
5. The trace recorder stores `step.repro: BrowseTraceReproAction[]` on each
   step it can map, and `trace.repro: { setup? }` for the run setup the host
   gives (`setRepro({ setup })`).
6. `browseTraceToPlaywrightSpec(trace)` (pure, zod-free, `agent/session`)
   renders the file. The viewer offers it as a download.

## Locator

```ts
type ReproLocator =
  | { kind: "testid"; value: string }                        // data-testid -> page.getByTestId(v)
  | { kind: "attr"; name: "data-test" | "data-qa"; value: string } // page.locator('[data-qa="v"]')
  | { kind: "role"; role: string; name?: string }            // page.getByRole(r, { name, exact: true })
  | { kind: "placeholder"; value: string }                   // page.getByPlaceholder(v, { exact: true })
  | { kind: "label"; value: string }                         // page.getByLabel(v, { exact: true })
  | { kind: "alt"; value: string }                           // page.getByAltText(v, { exact: true })
  | { kind: "text"; value: string }                          // page.getByText(v, { exact: true })
  | { kind: "title"; value: string }                         // page.getByTitle(v, { exact: true })
  | { kind: "css"; value: string };                          // page.locator(v)
```

- Order: testid, attr, role+name, placeholder, label, alt, text, title, then
  CSS (the journal's `selectorFor`: stable `#id`, `[name]`, `[aria-label]`,
  nth-of-type path). The first candidate that matches exactly that one element
  in the document wins. Uniqueness for role+name: same `penRoleOf` and the same
  accessible name (whitespace-normalized, exact) among all elements of the
  document. Text: exact, whitespace-normalized `textContent` of the element,
  only for an element without element children with text, at most 80 chars.
- Role and name come from the snapshot helpers (`penRoleOf`, `accessibleNameOf`),
  so the locator names the element the way the snapshot showed it to the model.
- A name or text longer than 80 chars, or one that looks generated, is skipped.
- `gap` reasons: `iframe`, `shadow`, `not-found`, `no-unique`.
- Typed text into a secret field (`SECRET_FIELD_JS`: password, OTP, card) is not
  recorded: `fill` gets `secret: true` and the renderer emits
  `process.env.QA_SECRET_<n> ?? ""`.

## Trace format additions (additive, version stays 1)

```ts
interface BrowseTraceReproAction {
  // goto | click | fill | select | press | hover | check (not used yet) | back | forward | reload | viewport | expect | gap
  op: string;
  locator?: ReproLocator;
  url?: string;              // goto (redacted with redactTraceUrl)
  text?: string;             // fill (absent when secret)
  secret?: true;
  value?: string;            // select: option value
  key?: string;              // press
  viewport?: { width: number; height: number };
  check?: QaCheck;           // expect: the check as the agent gave it
  passed?: boolean;          // expect: the live result
  checkLocator?: ReproLocator; // expect with an index
  gap?: string;              // gap: why this step cannot be replayed
  note?: string;             // short human text for the comment line
}
interface BrowseTraceStep { /* ... */ repro?: BrowseTraceReproAction[] }
interface BrowseTrace { /* ... */ repro?: { setup?: {
  network?: ReproNetworkRule[];   // FixtureNetworkRule + { gap?, bodyRedacted?, headersRedacted? }
  url?: string; urlRedacted?: true; steps?: ReproFixtureStep[]; tabs?: number;   // the QA fixture start
  emulate?: FixtureEmulate; app?: true; storage?: true } } }
// BrowseTraceReproAction also has: urlRedacted?: true (goto), error?: string (expect: the check could not run)
```

Additions after the first review (all additive):

- **Fixture start.** The session runs `fixture.url` / `fixture.steps` as the setup and does NOT
  pre-open (`url` and `setup` together are an error), so a run has either a fixture start or a
  `browse_open` goto, never both. `setRepro` stores `setup.url` (redacted), `setup.steps`
  (`goto`, `click`, `type`, `select`, `press`, `waitFor`, `wait`; the text of a `type` into a field whose
  selector matches the trace SECRET_FIELD rule is dropped and marked `secret`) and `setup.tabs`.
  The renderer emits them after the mocks and listeners under `// Setup from the QA fixture`.
  `waitFor` polls for the element to exist, so it is `toBeAttached({ timeout })`. Extra tabs are a GAP.
  `fixture.expect` is not exported.
- **Final checks.** `trace.qa.checks` entries with `source: "final"` render at the end under
  `// Final checks of the QA run`, like agent checks (FAILED comment, `failingChecks`).
- **Partial batch.** A batched `browse_act` that stops after `completed > 0` records the completed
  actions, then `gap: "batch stopped at action <n>: <error>"`. A single failed action stays a dead end.
- **Text check** is `toContainText(t, { ignoreCase: true, useInnerText: true })`: the run lowercases
  `document.body.innerText`.
- **Fill text** is kept only when the host-redacted args (the default redactor or `redactArgs`) hold exactly
  the same text at the same position; otherwise `secret: true`. Also `capture.secret`.
- **Listeners** mirror the run: console = `console.error` text and `pageerror` message, each cut to 200
  chars; failed requests = `<METHOD> <status|errorText> <origin><path>` (no query), cut to 200 chars,
  skipping `net::ERR_ABORTED`, data: URLs, WebSocket and EventSource. Playwright cannot see the CDP
  `canceled` flag; this is commented in the generated code.
- **Mocks.** The URL regex is built from `normalizePattern` (exported from `fixture/network`) with `*` as
  `[\s\S]*`, like `matchUrlPattern`. Method + `times` use a `mockHitsN` counter (Playwright's `times` also counts
  `fallback()`ed requests). URL patterns are not redacted; a secret query value, fragment value or userinfo makes the
  rule a GAP `mock url had a secret query value`. A `goto` whose URL lost a secret value keeps the goto, gets
  `// NOTE: a secret query value was removed from this URL` and counts as a gap.
  Bodies: object (or JSON string) -> deep copy, secret-named keys get "[redacted]" (NOTE comment), up to 200 KB
  of JSON (bigger: GAP); other strings stay unless they hold a secret-looking word (GAP). Secret headers are removed (NOTE).
- **Check errors.** A `qa_assert` result with `error` renders `// GAP: check could not run in the run: <error>`
  and is not a failing check.

Mapping (recorded only for a step that did not fail; a failed action is a dead
end, as in Playwright):

| Tool call | Actions |
|---|---|
| `browse_open {url}` | `goto` (the final `url` of the result when it has one) |
| `browse_open {app}` | `gap: "electron app"` |
| `browse_act` click/type/select/press/hover | the op with `__repro.locator`; `__repro.gap` gives a `gap` |
| `browse_act` press without a target | `press` without a locator (`page.keyboard.press`) |
| `browse_act` back/forward/reload | the op |
| `browse_act` viewport | `viewport` with the result size |
| `browse_act` scroll/wait | nothing (auto-wait, auto-scroll) |
| `browse_act` upload | `gap: "upload"` |
| batched `actions` | one entry per completed action, in order |
| `browse_screenshot {waitFor: {text}}` | `expect` text check (wait) |
| `qa_assert {checks}` | one `expect` per check, with `passed` from the result |
| `browse_tabs` new/switch/close | `gap: "tabs"` |
| `browse_fill_login` and any other tool | `gap` with the tool name |
| read-only tools (snapshot, read, screenshot without waitFor, find_images) | nothing |

## Renderer

```ts
browseTraceToPlaywrightSpec(trace: BrowseTrace, opts?: { title?: string }): { code: string; actions: number; gaps: number; failingChecks: number } | { error: string }
```

Error when the trace has no `repro` data at all (an old trace or recording was off).

File shape:

```ts
// Generated by @sideform/browser-agent from browse trace <id>.
// Scenario: <goal, one line per line of the goal, each prefixed with "// ">
// QA outcome: failed. Reason: <qa.reason>
// <failingChecks> check(s) failed in the run: this test fails until the bug is fixed.
// <gaps> step(s) could not be exported: see the GAP comments.
import { test, expect, devices } from "@playwright/test";

test.use({ ...devices["iPhone 15"], colorScheme: "dark" });   // only with setup.emulate

test("<title>", async ({ page }) => {
  // Mocks from the QA setup.
  await page.route("https://api.shop.test/cart*", (route) => route.fulfill({ status: 500, contentType: "application/json", body: "{...}" }));
  // only for no_console_errors / no_failed_requests checks:
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  const failedRequests: string[] = [];
  page.on("requestfailed", (r) => failedRequests.push(`${r.method()} ${r.url()}`));
  page.on("response", (r) => { if (r.status() >= 400) failedRequests.push(`${r.request().method()} ${r.status()} ${r.url()}`); });

  // Step 1: browse_open
  await page.goto("https://shop.test/");
  // Step 2: browse_act click "Add to cart"
  await page.getByRole("button", { name: "Add to cart", exact: true }).click();
  // Step 3: qa_assert (FAILED in the run: expected "1 item", saw "0 items")
  await expect(page.locator("body")).toContainText("1 item", { ignoreCase: true });
});
```

Check rendering:

| QaCheck | Code |
|---|---|
| text | `expect(page.locator("body")).toContainText(t, { ignoreCase: true, useInnerText: true })`; `absent` → `.not.` |
| element + selector/index | locator = `page.locator(css)` or the check locator. visible → `toBeVisible()`, hidden → `toBeHidden()`, exists → `toBeAttached()`, absent → `not.toBeAttached()`, enabled/disabled/checked/unchecked → `toBeEnabled()`… `not.toBeChecked()` |
| value | `toHaveValue(equals)`; contains → `toHaveValue(new RegExp(<escaped>))` |
| count | `page.locator(css)` (+ `.filter({ visible: true })` when `visible`); equals → `toHaveCount(n)`; min/max → `expect.poll(() => loc.count()).toBeGreaterThanOrEqual(min)` / `toBeLessThanOrEqual(max)` |
| url | equals → `toHaveURL(s)`; contains → `toHaveURL(new RegExp(<escaped>))`; matches → `toHaveURL(new RegExp(src))` |
| no_console_errors | `expect(consoleErrors.filter((e) => !ignore.some((i) => e.includes(i)))).toEqual([])` |
| no_failed_requests | same with `failedRequests` |
| element/value with an index and no check locator | `// GAP` comment |

- A check that FAILED in the run gets the comment `FAILED in the run: <actual>`.
- `expect.soft` is NOT used: the first failing check stops the test, like the run's verdict.
- Every string literal is emitted with `JSON.stringify` (safe quoting). A regex
  source from `contains` is escaped. `matches` is used as given (it was valid in
  the run).
- Fill with secret: `process.env.QA_SECRET_1 ?? ""` with a comment naming the field.
- Mock bodies: object → `JSON.stringify(body)`; string as is (see the additions above for redaction).
- `setup.storage` / cookies are NOT exported (they can hold sessions): a header
  comment says so.
- Devices: iphone-15 → `devices["iPhone 15"]`, pixel-8 → `devices["Pixel 7"]`
  (closest in Playwright's list), ipad → `devices["iPad (gen 7)"]`,
  desktop-1440 → `viewport: { width: 1440, height: 900 }`, desktop-1920 →
  `{ width: 1920, height: 1080 }`, custom → `viewport` + `isMobile`.
  `colorScheme`, `locale`, `timezoneId` map 1:1 where `FixtureEmulate` has them.

## Host (pen-editor)

- `browseAgent.ts`: when the trace recorder runs (QA runs), pass `repro: true`
  to the executor and the setup to `traceRecorder.setRepro({ setup })`.
- Trace viewer: a "Download Playwright test" button next to "Download trace"
  (hidden when the trace has no `repro`). File name `<trace file stem>.spec.ts`.

No backend or desktop change: both forward `act`/`assert` args as opaque
objects, and the trace JSON grows by a field the stores keep as is.
