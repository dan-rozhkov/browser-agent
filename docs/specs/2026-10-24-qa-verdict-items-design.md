# qa_verdict items - design (2026-10-24)

Extends `2026-10-17-qa-suite-design.md`. One `browse_agent({ qa: true, goal })` run is
still one scenario. A scenario may now be a short checklist, and `qa_verdict` may report
one result per checklist item.

## Why

A benchmark (WebTestBench) showed three problems:

1. The agent marks "could not test" as `fail`. A broken environment or a missing
   precondition then looks like a defect of the app.
2. The agent reports "feature missing" when the feature shows only under a condition: a date
   near a deadline, a count at a limit, an amount above a threshold.
3. One run per checklist item cost 260 to 900 subagent steps per app. The subagent signed
   in again in every run.

## What

### The `items` field

`qa_verdict` takes an optional `items`: 1 to 20 entries (`QA_ITEMS_MAX`).

| Field | Rule |
| --- | --- |
| `id` | string, trimmed, 1 to 40 chars (`QA_ITEM_ID_MAX_CHARS`) |
| `result` | `pass`, `fail` or `blocked` |
| `reason` | string, trimmed, 1 to 300 chars (`QA_ITEM_REASON_MAX_CHARS`) |

`items: null` and `items: []` count as absent (strict-mode placeholders), in the zod schema
(`z.preprocess(normalizeQaItems, ...)`) and in the hand parser `parseQaVerdict`.

### Rules (`qaItemsRuleError`, shared by both checks)

- Item ids are unique.
- If any item has `fail`, `verdict` must be `fail`.
- A `fail` verdict with no failed item is allowed: the agent saw a defect outside the listed items
  (for example a crash). The prompt tells it to put that defect in `reason`.
- If every item is `blocked`, the input is rejected. The error tells the model to not call
  `qa_verdict` and to explain in the final answer. This is the existing blocked rule.

A violation is an input error. The call does not use up the one verdict (`singleUseTool`
with `isSuccess`).

### Result

`QaResult.items?: QaVerdictItem[]` is present only when the verdict had items. The hooks
field `qaVerdict`, the `executeQaVerdict` output and `qaResultOf` carry it. When the agent
check rule or `applyFinalChecks` downgrades a pass, the items stay as the agent gave them.
The judge and the trace recorder read only `outcome` and `reason`, so they do not change.

### Prompt

`QA_PROMPT_SECTION` gets these changes:

- How to work through several items (sign in once, cheapest order, `blocked` is not a fail,
  a defect outside the items gives `fail` with the defect in `reason`).
- A boundary paragraph that applies only when the agent is about to give `fail` because a
  feature or element is missing: find the condition that shows it (a date near a deadline, a
  count at a limit, an amount above a threshold, an empty or full list). If the scenario allows
  test data, make data just below, at and just above the limit and check again. Give `fail`
  only when it does not appear under its condition. Otherwise mark it as missing and name the
  condition in the reason.
- A URL paragraph: do not guess URLs. Reach a page through the links, buttons and menus. Open a URL
  directly only when the scenario gives it or when it was seen on a page or in a request of the
  app. A 404 on a guessed URL is not a defect and does not prove that a feature is missing.
- The blocked-step paragraph depends on items. No items: do not call `qa_verdict`, explain in
  the final answer. With items: mark the item that the blocked step stops as `blocked`,
  continue with the others and call `qa_verdict`. When every item is blocked, do not call it.

`QA_AGENT_CLOSING` agrees: call `qa_verdict` once, but not when a blocked step stopped the whole
scenario or every item is blocked.

### Downgrade with items

Without items, `qaResultOf` turns `pass` into `inconclusive` when the agent's last `qa_assert`
call had a failed check. With items this downgrade is skipped: the last call covers only the last
item, and the agent judged each item itself. The host final checks (`applyFinalChecks`) and the
judge still apply.

## Compatibility

`items` is optional. A host or model that does not send it gets the old behavior and the
old output. The `QaOutcome` union does not change. `QaResult` gains one optional field. An
old host that ignores `qa.items` loses only the detail.
