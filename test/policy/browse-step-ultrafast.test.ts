import { describe, expect, it, vi } from "vitest";

import { textModelCalls, mockJsonModelOnce } from "./structuredModelFakes.js";
import { choice, fakeClient, makeOptions } from "./browseFakes.js";
import { shortenRetypedQuery, DONE_WHEN_RULE, MAX_DECISION_CHOICES, containsWholeTyped, goalWantsMultipleUnits, matchesTyped, pickSuggestion, repeatsCommittedClick, repeatsNoEffectClick } from "../../src/policy/browseStepUltrafast.js";
import type { SystemOneAnswer, SystemOneEvaluateParams, SystemOneQuestion } from "../../src/policy/decisions.js";
import { DISABLED_CONTROL_RULE, type BrowseStepElement, type BrowseStepInput } from "../../src/policy/browseStep.js";

const { decideBrowseStepUltrafast, buildUltrafastQuestions, withRememberedSelections } = await import("../../src/policy/browseStepUltrafast.js");

const config = makeOptions();

const FORM: BrowseStepElement[] = [
  { index: 0, tag: "input", label: "First name", ops: ["TYPE_TEXT"], value: "Anna" },
  { index: 1, tag: "input", label: "Last name", ops: ["TYPE_TEXT"], value: "" },
  { index: 2, tag: "input", label: "Email", ops: ["TYPE_TEXT"], hasValue: true },
  { index: 3, tag: "select", label: "Country", ops: ["SELECT"], options: ["Select…", "France", "Germany"], value: "France" },
  { index: 4, tag: "input", label: "I accept the terms", ops: ["CLICK"], checked: false },
  { index: 5, tag: "button", label: "Create account", ops: ["CLICK"] },
];

function input(overrides: Partial<BrowseStepInput> = {}): BrowseStepInput {
  return {
    goal: "Register as Anna Petrova from Germany and accept the terms",
    url: "https://example.com/register",
    title: "Register",
    elements: FORM,
    history: [],
    pageText: "Create your account",
    ...overrides,
  };
}

type Captured = SystemOneEvaluateParams<Record<string, SystemOneQuestion>>;

async function decide(answers: Record<string, SystemOneAnswer>, overrides: Partial<BrowseStepInput> = {}) {
  let captured: Captured | undefined;
  const result = await decideBrowseStepUltrafast(
    fakeClient(answers, { capture: (p) => (captured = p) }),
    config,
    input(overrides),
  );
  return { result, captured: captured! };
}

/** One-shot text-helper response; returns the prompt it was sent. */
function mockFieldText(text: string | null): () => string {
  return mockJsonModelOnce({ text }).seenPrompt;
}

describe("buildUltrafastQuestions", () => {
  const built = buildUltrafastQuestions("the goal", FORM, { y: 0, height: 900, atBottom: true });

  it("puts the goal and the next-step rules into every question's instructions", () => {
    for (const q of Object.values(built.questions)) {
      expect(q.instructions).toMatchObject({ goal: "the goal" });
      expect(JSON.stringify(q.instructions)).toContain("Do not repeat satisfied steps");
    }
    expect(JSON.stringify(built.questions.type_text_target.instructions)).toContain(
      "Do not choose a field that already contains the requested value",
    );
  });

  it("offers DONE/BLOCKED as operations and drops scrolls the page can't make", () => {
    expect(built.operations).toEqual(expect.arrayContaining(["CLICK", "TYPE_TEXT", "SELECT", "WAIT", "DONE", "BLOCKED"]));
    expect(built.operations).not.toContain("SCROLL_UP");
    expect(built.operations).not.toContain("SCROLL_DOWN");
  });

  it("repeats each field's current state in its target criterion", () => {
    const typeTargets = built.questions.type_text_target.type === "choice" ? built.questions.type_text_target.criteria : {};
    expect(typeTargets["0"]).toMatchObject({ element: "[0] First name", current_value: "Anna" });
    expect(typeTargets["1"]).toMatchObject({ current_value: "" });
    expect(typeTargets["2"]).toMatchObject({ current_value: "(filled; value hidden)" });
    const clickTargets = built.questions.click_target.type === "choice" ? built.questions.click_target.criteria : {};
    expect(clickTargets["4"]).toMatchObject({ checked: false });
  });

  it("shows a custom dropdown's current choice and whether its list is open", () => {
    const withCombo = buildUltrafastQuestions(
      "the goal",
      [{ index: 7, tag: "div", role: "combobox", label: "One way", ops: ["CLICK"], value: "One way", expanded: true }],
      { y: 0, height: 900, atBottom: true },
    );
    const clickTargets = withCombo.questions.click_target.type === "choice" ? withCombo.questions.click_target.criteria : {};
    expect(clickTargets["7"]).toMatchObject({ current_value: "One way", expanded: true });
    const rules = JSON.stringify(withCombo.questions.operation.instructions);
    expect(rules).toContain("already shows the requested choice is set");
    expect(rules).toContain("When a list is open (expanded)");
    expect(rules).toContain("never CLICK that same element again");
    expect(rules).toContain("answer BLOCKED (its options are not visible)");
  });

  it("makes every unselected, non-empty <select> option its own target", () => {
    const selectTargets = built.questions.select_target.type === "choice" ? built.questions.select_target.criteria : {};
    expect(Object.keys(selectTargets)).toEqual(["3:1", "3:3"]);
    expect(selectTargets["3:3"]).toMatchObject({ element: "[3] Country → Germany", current_value: "France" });
  });
});

describe("decideBrowseStepUltrafast", () => {
  it("sends page text, element state and recent actions, scrubbing PII", async () => {
    const { captured } = await decide(
      { operation: choice("WAIT", 0.9) },
      {
        pageText: "Signed in as anna@example.com",
        history: [{ operation: "TYPE_TEXT", label: 'TYPE_TEXT "Anna" into "First name"', ok: true, index: 0 }],
      },
    );
    const state = captured.state as {
      page: { text: string };
      elements: Array<Record<string, unknown>>;
      recent_actions: Array<Record<string, unknown>>;
    };
    expect(state.page.text).not.toContain("anna@example.com");
    expect(state.elements[0]).toMatchObject({ label: "First name", value: "Anna" });
    expect(state.elements[3]).toMatchObject({ value: "France" });
    expect(state.elements[4]).toMatchObject({ checked: false });
    expect(state.recent_actions[0]).toMatchObject({ action: 'TYPE_TEXT "Anna" into "First name"', ok: true });
  });

  it.each([
    ["DONE", "done"],
    ["BLOCKED", "blocked"],
    ["WAIT", "act"],
  ])("maps operation %s to outcome %s", async (op, outcome) => {
    const { result } = await decide({ operation: choice(op, 0.9) });
    expect(result.outcome).toBe(outcome);
  });

  it.each([
    ["DONE", "CLICK"],
    ["BLOCKED", "CLICK"],
  ])("demotes an unconfident %s to the runner-up operation", async (terminal) => {
    const { result } = await decide({
      operation: choice(terminal, 0.3, { probabilities: { [terminal]: 0.3, CLICK: 0.25, WAIT: 0.2 } }),
      click_target: choice("5", 0.9),
    });
    expect(result).toMatchObject({ outcome: "act", operation: "CLICK", index: 5 });
  });

  it("reports a <select> an older desktop build left unreported as unknown, not filled", () => {
    const legacySelect: BrowseStepElement = {
      index: 7,
      tag: "select",
      label: "Country",
      ops: ["SELECT"],
      options: ["Select a country", "Germany"],
      hasValue: true,
    };
    const { questions } = buildUltrafastQuestions("goal", [legacySelect], undefined);
    const criteria = questions.select_target.type === "choice" ? questions.select_target.criteria : {};
    expect(criteria["7:2"]).toMatchObject({ current_value: "(unknown)" });
  });

  it("remembers a <select> choice from history when the snapshot doesn't report it", () => {
    const legacySelect: BrowseStepElement = { index: 7, tag: "select", label: "Country", ops: ["SELECT"], options: ["Germany"], hasValue: true };
    const history = [
      { operation: "SELECT", label: 'SELECT "France" in "Country"', ok: true, index: 7 },
      { operation: "SELECT", label: 'SELECT "Germany" in "Country"', ok: true, index: 7 },
      { operation: "SELECT", label: 'SELECT "Spain" in "Country" (no effect)', ok: false, index: 7 },
    ];
    expect(withRememberedSelections([legacySelect], history)[0].value).toBe("Germany");
    expect(withRememberedSelections([{ ...legacySelect, value: "Italy" }], history)[0].value).toBe("Italy");
  });

  it("acts on the argmax target however low its peak (no gates)", async () => {
    const { result } = await decide({ operation: choice("CLICK", 0.4), click_target: choice("4", 0.3) });
    expect(result).toMatchObject({ outcome: "act", operation: "CLICK", index: 4 });
  });

  it("returns a SELECT with the chosen option's text and no text-model call", async () => {
    textModelCalls.mockClear();
    const { result } = await decide({ operation: choice("SELECT", 0.9), select_target: choice("3:3", 0.9) });
    expect(result).toMatchObject({ outcome: "act", operation: "SELECT", index: 3, text: "Germany" });
    expect(textModelCalls).not.toHaveBeenCalled();
  });

  it("asks the text model for the value of the CHOSEN field", async () => {
    const prompt = mockFieldText("Petrova");
    const { result } = await decide({ operation: choice("TYPE_TEXT", 0.9), type_text_target: choice("1", 0.9) });
    expect(result).toMatchObject({ outcome: "act", operation: "TYPE_TEXT", index: 1, text: "Petrova", textSource: "llm" });
    expect(prompt()).toContain("Last name");
    expect(prompt()).toContain("Create your account");
  });

  it("blocks (no runner-up) when the goal holds no value for the chosen field", async () => {
    mockFieldText(null);
    const { result } = await decide({ operation: choice("TYPE_TEXT", 0.9), type_text_target: choice("1", 0.9) });
    expect(result.outcome).toBe("blocked");
  });

  it("continues with the runner-up operation when no text can be written", async () => {
    mockFieldText(null);
    const { result } = await decide({
      operation: choice("TYPE_TEXT", 0.6, { probabilities: { TYPE_TEXT: 0.6, CLICK: 0.35 } }),
      type_text_target: choice("1", 0.9),
      click_target: choice("5", 0.9),
    });
    expect(result).toMatchObject({ outcome: "act", operation: "CLICK", index: 5 });
  });

  it("does not fall back to PRESS_ENTER when no text can be written and a password field is present", async () => {
    mockFieldText(null);
    const { result } = await decide(
      {
        operation: choice("TYPE_TEXT", 0.6, { probabilities: { TYPE_TEXT: 0.6, PRESS_ENTER: 0.35 } }),
        type_text_target: choice("1", 0.9),
      },
      { elements: [...FORM, { index: 9, tag: "input", label: "Password", ops: ["TYPE_TEXT"], isPassword: true }] },
    );
    expect(result.outcome).toBe("blocked");
    expect(result.operation).not.toBe("PRESS_ENTER");
  });

  it("blocks when the only runner-up is below the minimum probability", async () => {
    mockFieldText(null);
    const { result } = await decide({
      operation: choice("TYPE_TEXT", 0.9, { probabilities: { TYPE_TEXT: 0.9, CLICK: 0.05 } }),
      type_text_target: choice("1", 0.9),
      click_target: choice("5", 0.9),
    });
    expect(result.outcome).toBe("blocked");
  });

  it("does not fall back to a click on the field that returned no text", async () => {
    mockFieldText(null);
    const { result } = await decide({
      operation: choice("TYPE_TEXT", 0.6, { probabilities: { TYPE_TEXT: 0.6, CLICK: 0.35 } }),
      type_text_target: choice("1", 0.9),
      click_target: choice("1", 0.9),
    });
    expect(result.outcome).toBe("blocked");
  });

  it("writeFieldText prompt restricts the quoted-phrase rule to search fields and delimits the goal without double quotes", async () => {
    const prompt = mockFieldText("x");
    await decide({ operation: choice("TYPE_TEXT", 0.9), type_text_target: choice("1", 0.9) });
    expect(prompt()).toContain("For a search or query field, if the goal contains a phrase in double quotes, type exactly that phrase.");
    expect(prompt()).toContain("Goal:\\n<<<\\nRegister as Anna"); // prompt is JSON-serialized
    expect(prompt()).not.toContain('Goal: "');
  });

  it.each([
    ["typing into a password field", { operation: choice("TYPE_TEXT", 0.9), type_text_target: choice("9", 0.9) }],
    ["pressing Enter with a password field on the page", { operation: choice("PRESS_ENTER", 0.9) }],
  ])("refuses %s", async (_name, answers) => {
    const { result } = await decide(answers, {
      elements: [...FORM, { index: 9, tag: "input", label: "Password", ops: ["TYPE_TEXT"], isPassword: true }],
    });
    expect(result.outcome).toBe("blocked");
  });

  describe("permissions.allowPasswordEntry", () => {
    const withPassword = { elements: [...FORM, { index: 9, tag: "input", label: "Password", ops: ["TYPE_TEXT" as const], isPassword: true }] };
    const typePw = { operation: choice("TYPE_TEXT", 0.9), type_text_target: choice("9", 0.9) };

    it("types exactly the password the goal states, without the text helper", async () => {
      vi.mocked(textModelCalls).mockClear();
      const { result } = await decide(typePw, {
        ...withPassword,
        goal: 'Log in as me@x.com with password "hunter2"',
        permissions: { allowPasswordEntry: true },
      });
      expect(result).toMatchObject({ outcome: "act", operation: "TYPE_TEXT", index: 9, text: "hunter2" });
      expect(textModelCalls).not.toHaveBeenCalled();
    });

    it("never sends the plaintext password in the Jev evaluate call", async () => {
      const { result, captured } = await decide(typePw, {
        ...withPassword,
        goal: 'Log in with password "hunter2"',
        permissions: { allowPasswordEntry: true },
      });
      expect(result.text).toBe("hunter2");
      expect(JSON.stringify(captured)).not.toContain("hunter2");
      expect(JSON.stringify(captured)).toContain("[password]");
    });

    it("blocks when the goal states no password", async () => {
      const { result } = await decide(typePw, { ...withPassword, permissions: { allowPasswordEntry: true } });
      expect(result.outcome).toBe("blocked");
      expect(result.reason).toContain("the goal gives no value");
    });

    it("honors the flag in the Luna click-to-Enter rewrite", async () => {
      const lunaCfg = makeOptions({ decisionModel: "openai/gpt-6-luna-decisions" });
      const run = async (permissions?: { allowPasswordEntry: boolean }) =>
        decideBrowseStepUltrafast(
          fakeClient({ operation: choice("CLICK", 0.9), click_target: choice("1", 0.9) }, { model: "openai/gpt-6-luna-decisions" }),
          lunaCfg,
          input({
            elements: [
              { index: 1, tag: "input", label: "Username", ops: ["CLICK", "TYPE_TEXT"], value: "x" },
              { index: 9, tag: "input", label: "Password", ops: ["TYPE_TEXT"], isPassword: true },
            ],
            permissions,
            history: [{ operation: "TYPE_TEXT", label: 'TYPE_TEXT "x" into "Username"', ok: true, index: 1 }],
          }),
        );
      expect((await run({ allowPasswordEntry: true })).operation).toBe("PRESS_ENTER");
      expect((await run()).operation).not.toBe("PRESS_ENTER");
    });

    it("lets PRESS_ENTER through with a password field on the page", async () => {
      const { result } = await decide({ operation: choice("PRESS_ENTER", 0.9) }, { ...withPassword, permissions: { allowPasswordEntry: true } });
      expect(result).toMatchObject({ outcome: "act", operation: "PRESS_ENTER" });
    });
  });

  it.each([
    ["an operation that was not offered", { operation: choice("SCROLL_UP", 0.9) }],
    ["a target that was not offered", { operation: choice("CLICK", 0.9), click_target: choice("0", 0.9) }],
    ["a missing target answer", { operation: choice("CLICK", 0.9) }],
  ])("retries on %s", async (_name, answers) => {
    const { result } = await decide(answers, { scroll: { y: 0, height: 900 } });
    expect(result.outcome).toBe("retry");
  });

  it("retries when the operation question was refused (no answer), not acting on an invented one", async () => {
    // A refused question is absent from `answers`; the target answer alone must not trigger an action.
    const { result } = await decide({ click_target: choice("5", 0.9) });
    expect(result.outcome).toBe("retry");
    expect(result.index).toBeUndefined();
  });

  it("does not act on an invented index when the target question was refused", async () => {
    const { result } = await decide({ operation: choice("CLICK", 0.9) });
    expect(result.outcome).toBe("retry");
    expect(result.index).toBeUndefined();
  });

  it("retries when Jev itself fails", async () => {
    const result = await decideBrowseStepUltrafast(fakeClient({}, { throwError: new Error("boom") }), config, input());
    expect(result).toMatchObject({ outcome: "retry" });
    expect(result.reason).toContain("boom");
  });
});

describe("pending-suggestion gate", () => {
  const SUGGEST: BrowseStepElement[] = [
    { index: 0, tag: "input", role: "combobox", label: "Where to?", ops: ["TYPE_TEXT", "CLICK"], value: "Barcelona", expanded: true },
    { index: 1, tag: "input", label: "Departure", ops: ["CLICK", "TYPE_TEXT"], value: "" },
    { index: 2, tag: "li", role: "option", label: "Madrid, Spain", ops: ["CLICK"] },
    { index: 3, tag: "li", role: "option", label: "Barcelona, Spain", ops: ["CLICK"] },
    { index: 4, tag: "li", role: "option", label: "Barcelona-El Prat Airport (BCN)", ops: ["CLICK"] },
  ];
  const TYPED = [{ operation: "TYPE_TEXT", label: 'TYPE_TEXT "Barcelona" into "Where to?"', ok: true, index: 0 }];
  const probs = { "0": 0.05, "1": 0.4, "2": 0.05, "3": 0.3, "4": 0.2 };
  const run = (answers: Record<string, SystemOneAnswer>, overrides: Partial<BrowseStepInput> = {}) =>
    decide(answers, { elements: SUGGEST, history: TYPED, ...overrides });

  it("overrides a click on another field with the best-scoring suggestion", async () => {
    const { result } = await run({
      operation: choice("CLICK", 0.5),
      click_target: choice("1", 0.4, { probabilities: probs }),
    });
    expect(result).toMatchObject({ outcome: "act", operation: "CLICK", index: 3, confidence: 0.3 });
    expect(result.reason).toContain("suggestion");
    expect(result.diag?.gates).toContainEqual(expect.objectContaining({ head: "suggestion", jevPick: "1" }));
  });

  it("overrides a non-click operation too", async () => {
    const { result } = await run({
      operation: choice("SCROLL_DOWN", 0.6),
      click_target: choice("1", 0.4, { probabilities: probs }),
    });
    expect(result).toMatchObject({ operation: "CLICK", index: 3 });
  });

  it("falls back to the option containing the typed text when probabilities are unusable", async () => {
    const { result } = await run({
      operation: choice("CLICK", 0.5),
      click_target: choice("1", 0.4, { probabilities: { "1": 1 } }),
    });
    expect(result).toMatchObject({ operation: "CLICK", index: 3 });
  });

  it("leaves a suggestion pick alone", async () => {
    const { result } = await run({
      operation: choice("CLICK", 0.5),
      click_target: choice("4", 0.4, { probabilities: probs }),
    });
    expect(result).toMatchObject({ operation: "CLICK", index: 4 });
    expect(result.diag?.gates.some((g) => g.head === "suggestion")).toBe(false);
  });

  it("lets PRESS_ENTER and WAIT through", async () => {
    for (const op of ["PRESS_ENTER", "WAIT"]) {
      const { result } = await run({ operation: choice(op, 0.6), click_target: choice("1", 0.4, { probabilities: probs }) });
      expect(result).toMatchObject({ outcome: "act", operation: op });
    }
  });

  it("never forces an unrelated option: no matching candidate means Jev's pick stands", async () => {
    const unrelated = SUGGEST.filter((el) => el.index !== 3 && el.index !== 4);
    const { result } = await run(
      { operation: choice("CLICK", 0.5), click_target: choice("1", 0.4, { probabilities: probs }) },
      { elements: unrelated },
    );
    expect(result).toMatchObject({ operation: "CLICK", index: 1 });
    expect(result.diag?.gates.some((g) => g.head === "suggestion")).toBe(false);
  });

  it("matches diacritic-insensitively and by typed word", async () => {
    const elements = [
      SUGGEST[0],
      SUGGEST[1],
      { index: 2, tag: "li", role: "option", label: "Madrid, Spain", ops: ["CLICK" as const] },
      { index: 3, tag: "li", role: "option", label: "Málaga Costa del Sol", ops: ["CLICK" as const] },
    ];
    const history = [{ operation: "TYPE_TEXT", label: 'TYPE_TEXT "malaga airport" into "Where to?"', ok: true, index: 0 }];
    const { result } = await run(
      { operation: choice("CLICK", 0.5), click_target: choice("1", 0.4, { probabilities: { "1": 0.4, "2": 0.5, "3": 0.1 } }) },
      { elements, history },
    );
    expect(result).toMatchObject({ operation: "CLICK", index: 3 });
  });

  it("parses labels with side-effect suffixes and a truncated typed text", async () => {
    const full = "Barcelona-El Prat Airport terminal one departures and arrivals hall";
    const elements = [
      SUGGEST[0],
      SUGGEST[1],
      { index: 2, tag: "li", role: "option", label: "Madrid, Spain", ops: ["CLICK" as const] },
      { index: 3, tag: "li", role: "option", label: full, ops: ["CLICK" as const] },
    ];
    const history = [
      {
        operation: "TYPE_TEXT",
        label: `TYPE_TEXT "${full.slice(0, 59)}…" into "Where to?" (page updated: "Suggestions: Barcelona")`,
        ok: true,
      },
    ];
    const { result } = await run(
      { operation: choice("CLICK", 0.5), click_target: choice("1", 0.4, { probabilities: probs }) },
      { elements, history },
    );
    expect(result).toMatchObject({ operation: "CLICK", index: 3 });
  });

  it("lets retyping into the same field and PRESS_ESCAPE through", async () => {
    const { result } = await run({
      operation: choice("TYPE_TEXT", 0.6),
      type_text_target: choice("0", 0.6),
      click_target: choice("1", 0.4, { probabilities: probs }),
    });
    expect(result.diag?.gates.some((g) => g.head === "suggestion")).toBe(false);
    const esc = await run({ operation: choice("PRESS_ESCAPE", 0.6), click_target: choice("1", 0.4, { probabilities: probs }) });
    expect(esc.result).toMatchObject({ operation: "PRESS_ESCAPE" });
  });

  it("overrides typing into a different field", async () => {
    const { result } = await run({
      operation: choice("TYPE_TEXT", 0.6),
      type_text_target: choice("1", 0.6),
      click_target: choice("1", 0.4, { probabilities: probs }),
    });
    expect(result).toMatchObject({ operation: "CLICK", index: 3 });
  });

  it("does nothing when the last action was not a landed TYPE_TEXT", async () => {
    const answers = { operation: choice("CLICK", 0.5), click_target: choice("1", 0.4, { probabilities: probs }) };
    for (const history of [
      [{ ...TYPED[0], ok: false }],
      [{ operation: "CLICK", label: 'CLICK "Where to?"', ok: true, index: 0 }],
      [...TYPED, { operation: "CLICK", label: 'CLICK "Departure"', ok: true, index: 1 }],
    ]) {
      const { result } = await run(answers, { history });
      expect(result).toMatchObject({ operation: "CLICK", index: 1 });
    }
  });

  it("does nothing without an expanded field or without options", async () => {
    const answers = { operation: choice("CLICK", 0.5), click_target: choice("1", 0.4, { probabilities: probs }) };
    const closed = SUGGEST.map((el) => (el.index === 0 ? { ...el, expanded: false } : el));
    expect((await run(answers, { elements: closed })).result).toMatchObject({ index: 1 });
    const noOptions = SUGGEST.filter((el) => el.role !== "option");
    expect((await run(answers, { elements: noOptions })).result).toMatchObject({ index: 1 });
  });

  it("matches the typed field by label when the history carries no index", async () => {
    const { result } = await run(
      { operation: choice("CLICK", 0.5), click_target: choice("1", 0.4, { probabilities: probs }) },
      { history: [{ operation: "TYPE_TEXT", label: 'TYPE_TEXT "Barcelona" into "Where to?"', ok: true }] },
    );
    expect(result).toMatchObject({ operation: "CLICK", index: 3 });
  });

  it("keeps the terminal gate semantics", async () => {
    const { result } = await run({ operation: choice("DONE", 0.9), click_target: choice("1", 0.4, { probabilities: probs }) });
    expect(result.outcome).toBe("done");
  });
});

describe("suggestion matching", () => {
  it("does not match lookalike substrings or a bare place-kind word", () => {
    expect(matchesTyped("Newark Liberty Intl", "New York")).toBe(false);
    expect(matchesTyped("New Orleans", "New York")).toBe(false);
    expect(matchesTyped("Madrid-Barajas Airport", "Barcelona airport")).toBe(false);
    expect(matchesTyped("Madrid-Barajas Airport", "Barcelona-El Prat airport")).toBe(false);
  });

  it("matches the right airport, truncated typing and punctuation", () => {
    expect(matchesTyped("Josep Tarradellas Barcelona-El Prat Airport (BCN)", "Barcelona airport")).toBe(true);
    expect(matchesTyped("Barcelona, Spain", "Barcel")).toBe(true);
    expect(matchesTyped("New York, NY", "new york")).toBe(true);
    expect(matchesTyped("Málaga Costa del Sol", "malaga airport")).toBe(true);
  });

  it("only the LAST typed word may be a prefix", () => {
    expect(matchesTyped("Barcelona, Spain", "Barcel airport")).toBe(false);
    expect(matchesTyped("Barcelona, Spain", "Barcel Spain")).toBe(false);
  });

  it("prefers a whole-text match when probabilities are unusable", () => {
    const options: BrowseStepElement[] = [
      { index: 2, tag: "li", role: "option", label: "Barcelona, Spain", ops: ["CLICK"] },
      { index: 3, tag: "li", role: "option", label: "Barcelona airport shuttle", ops: ["CLICK"] },
    ];
    const field = { index: 0, tag: "input", label: "To", ops: ["TYPE_TEXT"] } as BrowseStepElement;
    const pending = { typed: "Barcelona airport", field, options };
    expect(containsWholeTyped(options[1].label, pending.typed)).toBe(true);
    expect(pickSuggestion(pending, null).el.index).toBe(3);
    expect(pickSuggestion(pending, { probabilities: {} } as never).el.index).toBe(3);
  });
});

describe("vision (opts.vision, was BROWSE_STEP_VISION)", () => {
  const SHOT = "data:image/jpeg;base64,QUJD";
  const visionConfig = makeOptions({ vision: true });
  const answers = { operation: choice("CLICK", 0.9), click_target: choice("5", 0.9) };

  async function run(cfg: typeof config, screenshot?: string) {
    let captured: Captured | undefined;
    const result = await decideBrowseStepUltrafast(
      fakeClient(answers, { capture: (p) => (captured = p) }),
      cfg,
      input({ screenshot }),
    );
    return { result, captured: captured! };
  }

  it("sends array state and a screenshot_note on every question when on + screenshot", async () => {
    const { result, captured } = await run(visionConfig, SHOT);
    expect(Array.isArray(captured.state)).toBe(true);
    const [json, image] = captured.state as [string, unknown];
    expect(JSON.parse(json)).toHaveProperty("elements");
    expect(image).toEqual({ type: "image_url", image_url: { url: SHOT } });
    for (const q of Object.values(captured.questions)) {
      expect(q.instructions).toHaveProperty("screenshot_note");
    }
    expect(result.diag).toMatchObject({ vision: true, inputTokens: 100 });
  });

  it("keeps state and questions byte-identical to the flag-off baseline otherwise", async () => {
    const base = await run(config);
    for (const other of [await run(config, SHOT), await run(visionConfig)]) {
      expect(JSON.stringify(other.captured.state)).toBe(JSON.stringify(base.captured.state));
      expect(JSON.stringify(other.captured.questions)).toBe(JSON.stringify(base.captured.questions));
      expect(other.result.diag?.vision).toBe(false);
    }
    expect(Array.isArray(base.captured.state)).toBe(false);
  });
});

describe("OpenAI Decisions (Luna) profile", () => {
  const lunaConfig = makeOptions({ decisionModel: "openai/gpt-6-luna-decisions" });
  const SCROLLED = { y: 100, height: 900, atBottom: false };

  async function decideLuna(answers: Record<string, SystemOneAnswer>, overrides: Partial<BrowseStepInput> = {}) {
    let captured: Captured | undefined;
    const result = await decideBrowseStepUltrafast(
      fakeClient(answers, { capture: (p) => (captured = p) }),
      lunaConfig,
      input(overrides),
    );
    return { result, captured: captured! };
  }

  it("recognises openai/ models only", async () => {
    const { isOpenAIDecisions } = await import("../../src/policy/browseStepUltrafast.js");
    expect(isOpenAIDecisions("openai/gpt-6-luna-decisions")).toBe(true);
    expect(isOpenAIDecisions("jev-latest")).toBe(false);
    expect(isOpenAIDecisions(undefined)).toBe(false);
  });

  it("uses a short instruction block, a none option and no always-offered noise operations", () => {
    const built = buildUltrafastQuestions("the goal", FORM, SCROLLED, { luna: true, history: [] });
    expect(typeof built.questions.operation.instructions).toBe("string");
    expect(String(built.questions.operation.instructions)).toContain("the goal");
    expect(String(built.questions.operation.instructions)).not.toContain("Do not repeat satisfied steps");
    expect(built.operations).not.toContain("HOVER");
    expect(built.operations).not.toContain("PRESS_ENTER");
    expect(built.operations).not.toContain("WAIT");
    expect(built.operations).not.toContain("PRESS_ESCAPE");
    expect(built.operations).toEqual(expect.arrayContaining(["CLICK", "TYPE_TEXT", "SELECT", "SCROLL_UP", "SCROLL_DOWN", "DONE", "BLOCKED"]));
    const criteria = built.questions.click_target.type === "choice" ? built.questions.click_target.criteria : {};
    expect(Object.keys(criteria)).toContain("none");
  });

  it("leaves Jev's questions untouched", () => {
    const built = buildUltrafastQuestions("the goal", FORM, SCROLLED, { history: [] });
    expect(built.operations).toEqual(expect.arrayContaining(["HOVER", "PRESS_ENTER", "WAIT", "PRESS_ESCAPE"]));
    const criteria = built.questions.click_target.type === "choice" ? built.questions.click_target.criteria : {};
    expect(Object.keys(criteria)).not.toContain("none");
  });

  it("offers PRESS_ENTER right after a landed TYPE_TEXT and the calendar hint when a calendar is open", () => {
    const history = [{ operation: "TYPE_TEXT" as const, label: 'TYPE_TEXT "x" into "Search"', ok: true, index: 0 }];
    const built = buildUltrafastQuestions(
      "goal",
      [{ index: 0, tag: "button", label: "Next month", ops: ["CLICK"] }],
      SCROLLED,
      { luna: true, history },
    );
    expect(built.operations).toContain("PRESS_ENTER");
    expect(String(built.questions.operation.instructions)).toContain("A calendar is open");
  });

  it("keeps a DONE that clearly leads the runner-up, but still demotes a weak BLOCKED", async () => {
    const done = await decideLuna({
      operation: choice("DONE", 0.35, { probabilities: { DONE: 0.35, CLICK: 0.15, SCROLL_DOWN: 0.1 } }),
    });
    expect(done.result.outcome).toBe("done");
    const blocked = await decideLuna({
      operation: choice("BLOCKED", 0.4, { probabilities: { BLOCKED: 0.4, CLICK: 0.2, SCROLL_DOWN: 0.1 } }),
      click_target: choice("5", 0.9),
    });
    expect(blocked.result).toMatchObject({ outcome: "act", operation: "CLICK", index: 5 });
  });

  it("falls back to the next-best operation when the target is 'none'", async () => {
    const { result } = await decideLuna({
      operation: choice("TYPE_TEXT", 0.6, { probabilities: { TYPE_TEXT: 0.6, CLICK: 0.3, DONE: 0.1 } }),
      type_text_target: choice("none", 0.9),
      click_target: choice("5", 0.9),
    });
    expect(result).toMatchObject({ outcome: "act", operation: "CLICK", index: 5, confidence: 0.3 });
  });

  it("retries instead of falling back to an operation below the probability floor", async () => {
    const { result } = await decideLuna({
      operation: choice("TYPE_TEXT", 0.85, { probabilities: { TYPE_TEXT: 0.85, CLICK: 0.1, DONE: 0.05 } }),
      type_text_target: choice("none", 0.9),
      click_target: choice("5", 0.9),
    });
    expect(result.outcome).toBe("retry");
  });

  it("offers WAIT only when no real action operation exists", () => {
    const withClick = buildUltrafastQuestions("g", FORM, SCROLLED, { luna: true, history: [] });
    expect(withClick.operations).not.toContain("WAIT");
    const empty = buildUltrafastQuestions("g", [], { y: 0, height: 900, atBottom: true }, { luna: true, history: [] });
    expect(empty.operations).toContain("WAIT");
  });

  it("offers both scroll operations when the client sends no scroll info", () => {
    const built = buildUltrafastQuestions("g", FORM, undefined, { luna: true, history: [] });
    expect(built.operations).toEqual(expect.arrayContaining(["SCROLL_UP", "SCROLL_DOWN"]));
  });

  it("retries when every candidate answers 'none'", async () => {
    const { result } = await decideLuna({
      operation: choice("CLICK", 0.6, { probabilities: { CLICK: 0.6, DONE: 0.4 } }),
      click_target: choice("none", 0.9),
    });
    expect(result.outcome).toBe("retry");
  });

  it("turns a click on the field just typed into into PRESS_ENTER", async () => {
    const { result } = await decideLuna(
      { operation: choice("CLICK", 0.9), click_target: choice("0", 0.9) },
      {
        elements: [{ index: 0, tag: "input", label: "Search", ops: ["CLICK", "TYPE_TEXT"], value: "x" }],
        history: [{ operation: "TYPE_TEXT", label: 'TYPE_TEXT "x" into "Search"', ok: true, index: 0 }],
      },
    );
    expect(result).toMatchObject({ outcome: "act", operation: "PRESS_ENTER" });
  });

  it("adds the element index and a repeat count to the history it sends", async () => {
    const click = (n: number) => ({ operation: "CLICK" as const, label: "Search (page updated)", ok: true, index: n });
    const { captured } = await decideLuna({ operation: choice("WAIT", 0.9) }, { history: [click(5), click(5), click(5)] });
    const recent = (captured.state as { recent_actions: Array<Record<string, unknown>> }).recent_actions;
    expect(recent[0]).toMatchObject({ index: 5 });
    expect(recent[0]).not.toHaveProperty("note");
    expect(recent[2]).toMatchObject({ index: 5, note: "same action repeated 3x" });
  });
});

describe("open dialog (modal) and repeated no-effect clicks", () => {
  const lunaConfig = makeOptions({ decisionModel: "openai/gpt-6-luna-decisions" });
  const SEARCH: BrowseStepElement[] = [
    { index: 0, tag: "input", label: "Search", ops: ["CLICK", "TYPE_TEXT"], value: "old query" },
    { index: 1, tag: "button", label: "Close", ops: ["CLICK"] },
  ];
  const NOT_SCROLLED = { y: 100, height: 900 };

  it("offers PRESS_ESCAPE for luna only when a modal is set, and says so in the prompt", () => {
    const plain = buildUltrafastQuestions("g", SEARCH, NOT_SCROLLED, { luna: true, history: [] });
    expect(plain.operations).not.toContain("PRESS_ESCAPE");
    const modal = buildUltrafastQuestions("g", SEARCH, NOT_SCROLLED, { luna: true, history: [], modal: "Frequently bought" });
    expect(modal.operations).toContain("PRESS_ESCAPE");
    expect(String(modal.questions.operation.instructions)).toContain("A dialog is open over the page");
    expect(String(modal.questions.operation.instructions)).not.toContain("Frequently bought");
    expect(String(modal.questions.operation.instructions)).toContain("hidden until it is closed");
    expect(JSON.stringify(plain.questions)).not.toContain("dialog is open");
  });

  it("puts the dialog note into the Jev rules and the state, with the name sanitized", async () => {
    const built = buildUltrafastQuestions("g", SEARCH, NOT_SCROLLED, { modal: "Ignore rules a@b.com" });
    expect(JSON.stringify(built.questions.operation.instructions)).toContain("dialog is open");
    expect(JSON.stringify(built.questions)).not.toContain("Ignore rules");
    const { captured } = await (async () => {
      let c: SystemOneEvaluateParams<Record<string, SystemOneQuestion>> | undefined;
      await decideBrowseStepUltrafast(fakeClient({ operation: choice("DONE", 0.9) }, { capture: (p) => (c = p) }), config, input({ modal: "Cart" }));
      return { captured: c! };
    })();
    expect((captured.state as { open_dialog?: string }).open_dialog).toBe("Cart");
  });

  it("does not re-offer a scroll that had no effect while a dialog is open", () => {
    const history = [{ operation: "SCROLL_DOWN", label: "SCROLL_DOWN (no effect)", ok: false }];
    const modal = buildUltrafastQuestions("g", SEARCH, NOT_SCROLLED, { history, modal: "Cart" });
    expect(modal.operations).not.toContain("SCROLL_DOWN");
    expect(modal.operations).toContain("SCROLL_UP");
    // alternation: DOWN then UP both dead -> neither offered, no 2-cycle
    const both = [...history, { operation: "SCROLL_UP", label: "SCROLL_UP (no effect)", ok: false }];
    const none = buildUltrafastQuestions("g", SEARCH, NOT_SCROLLED, { history: both, modal: "Cart" });
    expect(none.operations).not.toContain("SCROLL_DOWN");
    expect(none.operations).not.toContain("SCROLL_UP");
    // a refused scroll (no suffix) is not evidence of "no effect"
    const refused = buildUltrafastQuestions("g", SEARCH, NOT_SCROLLED, { history: [{ operation: "SCROLL_DOWN", label: "timed out", ok: false }], modal: "Cart" });
    expect(refused.operations).toContain("SCROLL_DOWN");
    const noModal = buildUltrafastQuestions("g", SEARCH, NOT_SCROLLED, { history });
    expect(noModal.operations).toContain("SCROLL_DOWN");
  });

  async function decideClick(history: BrowseStepInput["history"], elements = SEARCH, convert = true) {
    // A queued once-response that is never consumed would leak into later tests.
    if (convert) mockFieldText("new query");
    const out = await decideBrowseStepUltrafast(
      fakeClient({ operation: choice("CLICK", 0.8), click_target: choice("0", 0.8), type_text_target: choice("0", 0.8) }),
      lunaConfig,
      input({ elements, history }),
    );
    return out;
  }

  it("converts a repeated no-effect CLICK on an editable field to TYPE_TEXT (rule tier)", async () => {
    const result = await decideClick([{ operation: "CLICK", label: "Search (no effect)", ok: false, index: 0 }]);
    expect(result).toMatchObject({ outcome: "act", operation: "TYPE_TEXT", index: 0, text: "new query" });
    expect(result.diag?.tier).toBe("rule");
  });

  it("matches the previous click by exact label when the history has no index", async () => {
    const result = await decideClick([{ operation: "CLICK", label: "Search (no effect)", ok: false }]);
    expect(result).toMatchObject({ operation: "TYPE_TEXT", index: 0 });
    expect(result.diag?.gates.some((g) => g.head === "refocus-type")).toBe(true);
  });

  it("does not fire for a refused click, a similar label or a reused index with another label", async () => {
    for (const history of [
      [{ operation: "CLICK", label: "element is covered", ok: false, index: 0 }],
      [{ operation: "CLICK", label: "Search filters (no effect)", ok: false, index: 0 }],
      [{ operation: "CLICK", label: "Search (no effect)", ok: false, index: 7 }],
      [{ operation: "CLICK", label: "Close (no effect)", ok: false, index: 0 }],
    ]) {
      const result = await decideClick(history, SEARCH, false);
      expect(result).toMatchObject({ operation: "CLICK", index: 0 });
    }
  });

  it("leaves a first click, an effective click, another target and a once-retried non-editable click alone", async () => {
    for (const history of [
      [],
      [{ operation: "CLICK", label: 'CLICK "Search"', ok: true, index: 0 }],
      [{ operation: "CLICK", label: "Close (no effect)", ok: false, index: 1 }],
      [{ operation: "SCROLL_DOWN", label: "SCROLL_DOWN (no effect)", ok: false }],
    ]) {
      const result = await decideClick(history, SEARCH, false);
      expect(result).toMatchObject({ operation: "CLICK", index: 0 });
      expect(result.diag?.tier).toBe("jev");
    }
    const button: BrowseStepElement[] = [{ index: 0, tag: "button", label: "Search", ops: ["CLICK"] }];
    const result = await decideClick([{ operation: "CLICK", label: "Search (no effect)", ok: false, index: 0 }], button, false);
    // A single no-effect click may be retried once (the guard stops the third attempt).
    expect(result).toMatchObject({ operation: "CLICK", index: 0 });
  });

  it("keeps the click when the goal gives no text for the field", async () => {
    mockFieldText(null);
    const result = await decideBrowseStepUltrafast(
      fakeClient({ operation: choice("CLICK", 0.8), click_target: choice("0", 0.8) }),
      lunaConfig,
      input({ elements: SEARCH, history: [{ operation: "CLICK", label: "Search (no effect)", ok: false, index: 0 }] }),
    );
    expect(result).toMatchObject({ operation: "CLICK", index: 0 });
  });
});

describe("choice cap (Decisions API limit)", () => {
  const selects: BrowseStepElement[] = [0, 1, 2].map((n) => ({
    index: n,
    tag: "select",
    label: `Filter ${n}`,
    ops: ["SELECT"],
    options: Array.from({ length: 100 }, (_, i) => (n === 0 && i === 98 ? "Hiking boots" : `Option ${n}-${i}`)),
    value: "",
  }));

  it("keeps every question within the limit, luna NONE slot included", () => {
    for (const luna of [false, true]) {
      const built = buildUltrafastQuestions("buy hiking boots", selects, undefined, { luna });
      for (const q of Object.values(built.questions)) {
        if (q.type === "choice") expect(Object.keys(q.criteria).length).toBeLessThanOrEqual(MAX_DECISION_CHOICES);
      }
      expect(Object.keys(built.questions.select_target!.criteria as object).length).toBeLessThanOrEqual(MAX_DECISION_CHOICES);
    }
  });

  it("keeps a goal-matching option at position 99 and a fair share of every select", () => {
    const built = buildUltrafastQuestions("buy hiking boots", selects, undefined, { luna: true });
    const targets = [...built.targets.SELECT.values()];
    expect(targets.some((t) => t.index === 0 && t.option === "Hiking boots")).toBe(true);
    for (const n of [0, 1, 2]) expect(targets.filter((t) => t.index === n).length).toBeGreaterThan(50);
    // keys in the criteria still map to the right target
    const key = [...built.targets.SELECT].find(([, t]) => t.option === "Hiking boots")![0];
    expect(key).toBe("0:99");
    expect((built.questions.select_target!.criteria as Record<string, unknown>)[key]).toBeDefined();
  });

  // Insurance: no realistic page has this many clickable elements, but the
  // Decisions API rejects the whole question when one head overflows.
  it("caps CLICK targets by order", () => {
    const many: BrowseStepElement[] = Array.from({ length: 400 }, (_, i) => ({ index: i, tag: "a", label: `Link ${i}`, ops: ["CLICK"] }));
    const built = buildUltrafastQuestions("g", many, undefined, { luna: true });
    expect(Object.keys(built.questions.click_target!.criteria as object).length).toBeLessThanOrEqual(MAX_DECISION_CHOICES);
    expect(built.targets.CLICK.has("0")).toBe(true);
  });
});

describe("committed-click guard", () => {
  const BTN = (label: string): BrowseStepElement[] => [{ index: 3, tag: "button", label, ops: ["CLICK"] }];
  const ADDED = [{ operation: "CLICK", label: 'Add to cart → effect: "Add to cart" became "Add to cart 1"; counter 0→1', ok: true, index: 3 }];

  async function run(goal: string, history: BrowseStepInput["history"], label = "Add to cart 1") {
    return decideBrowseStepUltrafast(
      fakeClient({ operation: choice("CLICK", 0.8), click_target: choice("3", 0.8) }),
      config,
      input({ goal, elements: BTN(label), history }),
    );
  }

  it("turns a repeated commit click into DONE (rule tier, already-done gate)", async () => {
    const result = await run("add the tent to the cart", ADDED);
    expect(result.outcome).toBe("done");
    expect(result.diag?.tier).toBe("rule");
    expect(result.diag?.gates.some((g) => g.head === "already-done")).toBe(true);
  });

  it("does not fire on pagination or date clicks (no became note for the same control)", async () => {
    expect((await run("go to the next page", [{ operation: "CLICK", label: "Page 2", ok: true }], "Page 3")).outcome).toBe("act");
    expect((await run("pick a date", [{ operation: "CLICK", label: "June 14", ok: true }], "June 21")).outcome).toBe("act");
    expect((await run("add the tent", [{ operation: "CLICK", label: "Add to cart", ok: true }])).outcome).toBe("act");
  });

  it("does not fire for an identical label (next product page)", async () => {
    expect(await run("add the tent", ADDED, "Add to cart")).toMatchObject({ outcome: "act", operation: "CLICK", index: 3 });
    expect(repeatsCommittedClick([{ operation: "CLICK", label: "Add to cart → effect: counter 0→1", ok: true }], BTN("Add to cart")[0]!, "g")).toBe(false);
  });

  it("parses the became note with page-updated suffixes in either order", () => {
    const el = BTN("Add to cart 1")[0]!;
    const note = 'effect: "Add to cart" became "Add to cart 1"';
    const labels = [
      `Add to cart (page updated: "x") → ${note}`,
      `Add to cart → ${note} (page updated: "x")`,
      `Add to cart → ${note}; counter 0→1; appeared: "View cart" (page updated: "y")`,
    ];
    for (const label of labels) expect(repeatsCommittedClick([{ operation: "CLICK", label, ok: true }], el, "g")).toBe(true);
    // page text inside the suffix is never read as an effect
    const decoy = 'Add to cart → effect: counter 0→1 (page updated: "Add to cart" became "Add to cart 1")';
    expect(repeatsCommittedClick([{ operation: "CLICK", label: decoy, ok: true }], el, "g")).toBe(false);
  });

  it("is not converted when the goal asks for several units", async () => {
    expect(await run("add 2 bottles", ADDED)).toMatchObject({ outcome: "act", operation: "CLICK", index: 3 });
  });

  it("ignores no-effect clicks, failed clicks and unrelated labels", () => {
    const el = BTN("Add to cart 1")[0]!;
    const became = 'Add to cart → effect: "Add to cart" became "Add to cart 1"';
    expect(repeatsCommittedClick([{ operation: "CLICK", label: `${became} (no effect)`, ok: true }], el, "g")).toBe(false);
    expect(repeatsCommittedClick([{ operation: "CLICK", label: "Checkout", ok: true }], el, "g")).toBe(false);
    expect(repeatsCommittedClick([{ operation: "CLICK", label: became, ok: false }], el, "g")).toBe(false);
  });

  it("carried-over commits never end the sub-goal: the control is removed from the CLICK targets", async () => {
    const btn = BTN("Add to cart 1")[0]!;
    const carried = [{ operation: "CLICK", label: `${ADDED[0]!.label} (earlier sub-goal)`, ok: true }];
    expect(repeatsCommittedClick(carried, btn, "g")).toBe(false);
    const other: BrowseStepElement = { index: 4, tag: "button", label: "Buy now", ops: ["CLICK"] };
    const built = buildUltrafastQuestions("add the sleeping bag", [btn, other], undefined, { luna: true, history: carried });
    expect([...built.targets.CLICK.keys()]).toEqual(["4"]);
    // a current-sub-goal commit keeps the target (the DONE rule handles it)
    const own = buildUltrafastQuestions("add the tent", [btn, other], undefined, { luna: true, history: ADDED });
    expect([...own.targets.CLICK.keys()]).toEqual(["3", "4"]);
    // carried no-effect entries never trigger no-effect rules
    const el: BrowseStepElement = { index: 0, tag: "input", label: "Search", ops: ["CLICK", "TYPE_TEXT"] };
    expect(repeatsNoEffectClick([{ operation: "CLICK", label: "Search (no effect) (earlier sub-goal)", ok: false, index: 0 }], el)).toBe(false);
    expect(repeatsNoEffectClick([{ operation: "CLICK", label: "Search (no effect)", ok: false, index: 0 }], el)).toBe(true);
  });
});

describe("carried-over last history entry", () => {
  const FIELD: BrowseStepElement[] = [{ index: 1, tag: "input", label: "Search", ops: ["TYPE_TEXT", "CLICK"] }];
  const typed = { operation: "TYPE_TEXT", label: 'TYPE_TEXT "tent" into "Search"', ok: true, index: 1 };

  it("offers PRESS_ENTER after the sub-goal's own TYPE_TEXT but not after a carried one", () => {
    const own = buildUltrafastQuestions("g", FIELD, undefined, { luna: true, history: [typed] });
    expect(own.operations).toContain("PRESS_ENTER");
    const carried = buildUltrafastQuestions("g", FIELD, undefined, { luna: true, history: [{ ...typed, label: `${typed.label} (earlier sub-goal)` }] });
    expect(carried.operations).not.toContain("PRESS_ENTER");
  });

  it("offers HOVER and WAIT only for the sub-goal's own last entry", () => {
    const failed = { operation: "CLICK", label: "Buy (page updated: \"x\")", ok: false, index: 1 };
    const many: BrowseStepElement[] = [1, 2, 3].map((i) => ({ index: i, tag: "a", label: `L${i}`, ops: ["CLICK"] }));
    expect(buildUltrafastQuestions("g", many, undefined, { luna: true, history: [failed] }).operations).toEqual(expect.arrayContaining(["HOVER", "WAIT"]));
    const ops = buildUltrafastQuestions("g", many, undefined, { luna: true, history: [{ ...failed, label: `${failed.label} (earlier sub-goal)` }] }).operations;
    expect(ops).not.toContain("HOVER");
    expect(ops).not.toContain("WAIT");
  });
});

describe("goalWantsMultipleUnits", () => {
  it.each([
    "add 2 bottles of water to the cart",
    "buy two bottles of water",
    "put x2 in the basket",
    "add 3x tent pegs",
    "order 3 pcs",
    "set quantity 2",
    "add a couple of pens",
    "order a dozen eggs",
    "buy both",
    "get several",
    "add 12 bottles",
  ])("true: %s", (goal) => {
    expect(goalWantsMultipleUnits(goal)).toBe(true);
  });

  it.each([
    "find a tent under 50 EUR",
    "show gifts, price €30",
    "buy a $20 gift card",
    "add the 4-person tent",
    "add shoes size 42",
    "find a 20 cm ruler",
    "buy a 512 GB phone",
    "a 2 TB drive",
    "a 15 inch laptop",
    "a 65 W charger",
    "a 500 mAh battery",
    "20% off jackets",
    "models released in 2024",
    "add iphone15 case",
    "find an RTX4090",
    "add the sleeping bag to the cart",
    "go to page 3",
    "flights on June 14 returning June 21",
    "hotel for 2 adults and 3 nights",
    "add the 1 liter bottle",
    "order a 2.5 kg bag",
    "iPhone 15 Pro",
  ])("false: %s", (goal) => {
    expect(goalWantsMultipleUnits(goal)).toBe(false);
  });
});

describe("field text prompt", () => {
  it("tells the helper to take search text from the goal, never from the page", async () => {
    const prompt = mockFieldText("tent");
    await decideBrowseStepUltrafast(
      fakeClient({ operation: choice("TYPE_TEXT", 0.9), type_text_target: choice("1", 0.9) }),
      config,
      input({ goal: "find a tent" }),
    );
    expect(prompt()).toContain("MUST come from the goal");
    expect(prompt()).toContain("Never copy text from the page");
    expect(prompt()).toContain("return the first one");
  });
});

describe("done-after-no-effect gate", () => {
  const noEffect = { operation: "CLICK", label: "CLICK Add to cart (no effect)", ok: true, index: 5 };
  const worked = { operation: "CLICK", label: "CLICK Add to cart → effect: counter became 1", ok: true, index: 5 };
  const doneAnswers = (clickP = 0.3) => ({
    operation: choice("DONE", 0.6, { probabilities: { DONE: 0.6, CLICK: clickP } }),
    click_target: choice("5", 0.9),
  });

  it("demotes DONE to a runner-up on another target after one no-effect action", async () => {
    const { result } = await decide(
      { ...doneAnswers(), click_target: choice("4", 0.9) },
      { history: [worked, noEffect] },
    );
    expect(result).toMatchObject({ outcome: "act", operation: "CLICK", index: 4 });
    expect(result.diag?.gates).toContainEqual(expect.objectContaining({ head: "done-after-no-effect" }));
  });

  it("does not demote to a runner-up that redoes the no-effect click", async () => {
    const { result } = await decide(doneAnswers(), { history: [worked, noEffect] });
    expect(result.outcome).toBe("done");
  });

  it("skips the repeated click and takes the next non-terminal runner-up", async () => {
    const answers = {
      operation: choice("DONE", 0.5, { probabilities: { DONE: 0.5, CLICK: 0.3, TYPE_TEXT: 0.2 } }),
      click_target: choice("5", 0.9),
      type_text_target: choice("1", 0.9),
    };
    mockFieldText("Petrova");
    const { result } = await decide(answers, { history: [worked, noEffect] });
    expect(result).toMatchObject({ outcome: "act", operation: "TYPE_TEXT", index: 1 });
  });

  it("counts two in a row only for the same operation and target", async () => {
    const other = { operation: "CLICK", label: "CLICK I accept the terms (no effect)", ok: true, index: 4 };
    const { result } = await decide({ ...doneAnswers(), click_target: choice("4", 0.9) }, { history: [other, noEffect] });
    expect(result).toMatchObject({ outcome: "act", operation: "CLICK", index: 4 });
  });

  it("allows DONE after two no-effect actions in a row", async () => {
    const { result } = await decide(doneAnswers(), { history: [noEffect, noEffect] });
    expect(result.outcome).toBe("done");
  });

  it("allows DONE when the last action had an effect", async () => {
    const { result } = await decide(doneAnswers(), { history: [noEffect, worked] });
    expect(result.outcome).toBe("done");
  });

  it("ignores a carried-over no-effect entry", async () => {
    const carried = { ...noEffect, label: `${noEffect.label} (earlier sub-goal)` };
    const { result } = await decide(doneAnswers(), { history: [carried] });
    expect(result.outcome).toBe("done");
  });

  it("keeps DONE when the runner-up is below 0.15", async () => {
    const { result } = await decide({ ...doneAnswers(0.1), click_target: choice("4", 0.9) }, { history: [noEffect] });
    expect(result.outcome).toBe("done");
  });
});

describe("click-empty-field-typed gate", () => {
  const field = (extra: Partial<BrowseStepElement> = {}): BrowseStepElement[] => [
    { index: 0, tag: "input", label: "Search", ops: ["TYPE_TEXT", "CLICK"], value: "", ...extra },
    { index: 1, tag: "button", label: "Close", ops: ["CLICK"] },
  ];
  const clickAnswers = { operation: choice("CLICK", 0.39), click_target: choice("0", 0.8) };
  const quotedGoal = 'Search for "tent" in the shop';

  it("turns a CLICK on an empty text field into TYPE_TEXT with the written text", async () => {
    mockFieldText("Tent");
    const { result } = await decide(clickAnswers, { elements: field(), goal: quotedGoal });
    expect(result).toMatchObject({ outcome: "act", operation: "TYPE_TEXT", index: 0, text: "Tent" });
    expect(result.diag?.gates).toContainEqual(expect.objectContaining({ head: "click-empty-field-typed" }));
  });

  it.each([
    ["single quotes", "Add 'tent' to the cart"],
    ["guillemets", "Найди «tent»"],
  ])("reads a quoted phrase in %s", async (_name, goal) => {
    mockFieldText("tent");
    const { result } = await decide(clickAnswers, { elements: field(), goal });
    expect(result).toMatchObject({ operation: "TYPE_TEXT", index: 0, text: "tent" });
  });

  it("does not read an apostrophe as a quote", async () => {
    textModelCalls.mockClear();
    const { result } = await decide(clickAnswers, { elements: field(), goal: "Don't stop, it's a tent" });
    expect(result).toMatchObject({ operation: "CLICK", index: 0 });
    expect(textModelCalls).not.toHaveBeenCalled();
  });

  it("keeps the click when the field already has a value", async () => {
    const { result } = await decide(clickAnswers, { elements: field({ value: "old" }) });
    expect(result).toMatchObject({ operation: "CLICK", index: 0 });
    expect(result.diag?.gates.some((g) => g.head === "click-empty-field-typed")).toBe(false);
  });

  it("keeps the click on a password field", async () => {
    const { result } = await decide(clickAnswers, { elements: field({ isPassword: true }) });
    expect(result).toMatchObject({ operation: "CLICK", index: 0 });
  });

  it("keeps the click and skips the text helper when the goal quotes nothing", async () => {
    textModelCalls.mockClear();
    const { result } = await decide(clickAnswers, { elements: field() });
    expect(result).toMatchObject({ operation: "CLICK", index: 0 });
    expect(textModelCalls).not.toHaveBeenCalled();
    expect(result.diag?.gates.some((g) => g.head === "click-empty-field-typed")).toBe(false);
  });

  it("keeps the click when the written text is not a quoted phrase", async () => {
    mockFieldText("2026-10-12");
    const { result } = await decide(clickAnswers, { elements: field(), goal: quotedGoal });
    expect(result).toMatchObject({ operation: "CLICK", index: 0 });
  });

  it("keeps the click when the same field already got a landed TYPE_TEXT", async () => {
    const typed = { operation: "TYPE_TEXT", label: 'TYPE_TEXT "tent" into "Search"', ok: true, index: 0 };
    const { result } = await decide(clickAnswers, { elements: field(), goal: quotedGoal, history: [typed] });
    expect(result).toMatchObject({ operation: "CLICK", index: 0 });
  });

  it("still converts when the earlier TYPE_TEXT is from an earlier sub-goal", async () => {
    mockFieldText("tent");
    const typed = { operation: "TYPE_TEXT", label: 'TYPE_TEXT "tent" into "Search" (earlier sub-goal)', ok: true, index: 0 };
    const { result } = await decide(clickAnswers, { elements: field(), goal: quotedGoal, history: [typed] });
    expect(result).toMatchObject({ operation: "TYPE_TEXT", index: 0 });
  });

  it("keeps the click when the goal has nothing to type", async () => {
    mockFieldText(null);
    const { result } = await decide(
      { ...clickAnswers, type_text_target: choice("0", 0.8) },
      { elements: field(), goal: quotedGoal },
    );
    expect(result).toMatchObject({ outcome: "act", operation: "CLICK", index: 0 });
    expect(result.diag?.gates.some((g) => g.head === "no-text-runner-up")).toBe(false);
  });
});

describe("goal clauses", () => {
  it("ignores Done when / Does not count text when counting units", () => {
    expect(goalWantsMultipleUnits("Add a lamp to the cart. Done when: 2 items are in the cart.")).toBe(false);
    expect(goalWantsMultipleUnits("Add 2 lamps to the cart. Done when: 2 items are in the cart.")).toBe(true);
  });
});

describe("DONE_WHEN_RULE", () => {
  it("is in the step rules and the Luna instructions", () => {
    const { questions } = buildUltrafastQuestions("g", FORM, undefined, { luna: true, history: [] });
    expect(JSON.stringify(questions)).toContain(DONE_WHEN_RULE);
    const plain = buildUltrafastQuestions("g", FORM, undefined);
    expect(JSON.stringify(plain.questions)).toContain("Done when");
  });
});

describe("disabled elements", () => {
  const DISABLED = "A control marked disabled cannot be used yet.";
  const elements: BrowseStepElement[] = [
    { index: 0, tag: "input", role: "radio", label: "M5 Pro chip", ops: ["CLICK"], disabled: true },
    { index: 1, tag: "input", role: "radio", label: "Display standard", ops: ["CLICK"] },
  ];

  it("never offers a disabled element as a target but keeps it in the state", async () => {
    const { captured } = await decide({ operation: choice("CLICK", 0.9), click_target: choice("1", 0.9) }, { elements });
    const state = captured.state as { elements: Array<Record<string, unknown>> };
    expect(state.elements.find((e) => e.index === 0)).toMatchObject({ label: "M5 Pro chip", disabled: true });
    expect(state.elements.find((e) => e.index === 1)).not.toHaveProperty("disabled");
    const click = captured.questions.click_target;
    expect(click?.type === "choice" ? Object.keys(click.criteria) : []).toEqual(["1"]);
  });

  it("states the rule", () => {
    const built = buildUltrafastQuestions("goal", elements, undefined, { history: [] });
    expect(JSON.stringify(built.questions.operation.instructions)).toContain(DISABLED);
  });
});

describe("disabled elements (Luna profile)", () => {
  const elements: BrowseStepElement[] = [
    { index: 0, tag: "input", role: "radio", label: "M5 Pro chip", ops: ["CLICK"], disabled: true },
    { index: 1, tag: "input", role: "radio", label: "Display standard", ops: ["CLICK"] },
  ];
  it("puts the rule in the operation and target instructions and flags the state element", async () => {
    const lunaConfig = makeOptions({ decisionModel: "openai/gpt-6-luna-decisions" });
    let captured: Captured | undefined;
    await decideBrowseStepUltrafast(
      fakeClient({ operation: choice("CLICK", 0.9), click_target: choice("1", 0.9) }, { capture: (p) => (captured = p) }),
      lunaConfig,
      input({ elements }),
    );
    const state = captured!.state as { elements: Array<Record<string, unknown>> };
    expect(state.elements.find((e) => e.index === 0)).toMatchObject({ disabled: true });
    expect(JSON.stringify(captured!.questions.operation.instructions)).toContain("marked disabled cannot be used yet");
    expect(JSON.stringify(captured!.questions.click_target?.instructions)).toContain("marked disabled cannot be used yet");
  });
});

describe("busy control (disabled right after our own action)", () => {
  const history = [{ operation: "CLICK", label: "Save", ok: true, index: 7 }];
  const elements: BrowseStepElement[] = [{ index: 7, tag: "button", label: "Save", ops: ["CLICK"], disabled: true }];

  it("marks the element busy and the shared rule tells the model to WAIT", async () => {
    const { captured } = await decide({ operation: choice("WAIT", 0.9) }, { elements, history });
    const state = captured.state as { elements: Array<Record<string, unknown>> };
    expect(state.elements[0]).toMatchObject({ disabled: true, busy: true });
    expect(JSON.stringify(captured.questions.operation.instructions)).toContain(DISABLED_CONTROL_RULE);
    expect(DISABLED_CONTROL_RULE).toContain("WAIT");
  });

  it("does not mark a disabled control busy when our last action was on another element", async () => {
    const { captured } = await decide({ operation: choice("WAIT", 0.9) }, { elements, history: [{ ...history[0]!, index: 1 }] });
    const state = captured.state as { elements: Array<Record<string, unknown>> };
    expect(state.elements[0]).not.toHaveProperty("busy");
  });

  it("uses the reworded rule", () => {
    expect(DISABLED_CONTROL_RULE).toContain("only adds an optional extra");
    expect(DISABLED_CONTROL_RULE).toContain("decline it (an option like 'No ...' or 'None'); otherwise pick the standard option that adds no extra cost");
    expect(DISABLED_CONTROL_RULE).toContain("answer BLOCKED");
  });
});

describe("repeated no-effect click guard", () => {
  const els: BrowseStepElement[] = [
    { index: 5, tag: "button", label: "Search properties", ops: ["CLICK"] },
    { index: 6, tag: "button", label: "Refine location", ops: ["CLICK"] },
  ];
  const noEffect = (extra: Record<string, unknown> = {}) => ({
    operation: "CLICK",
    label: "Search properties (no effect)",
    ok: true,
    index: 5,
    ...extra,
  });
  const scroll = { y: 0, height: 900 };
  const clickSearch = (ops: Record<string, number>) => ({
    operation: choice("CLICK", ops.CLICK ?? 0.7, { probabilities: ops }),
    click_target: choice("5", 0.9),
  });

  it("diverts the third identical attempt to the runner-up and records the gate", async () => {
    const { result } = await decide(clickSearch({ CLICK: 0.7, SCROLL_DOWN: 0.3 }), { elements: els, scroll, history: [noEffect(), noEffect()] });
    expect(result).toMatchObject({ outcome: "act", operation: "SCROLL_DOWN" });
    expect(result.diag?.gates).toContainEqual(expect.objectContaining({ head: "repeat-no-effect" }));
    expect(result.diag?.tier).toBe("rule");
  });

  it("blocks the third attempt when there is no runner-up", async () => {
    const { result } = await decide(clickSearch({ CLICK: 0.9 }), { elements: els, scroll, history: [noEffect(), noEffect()] });
    expect(result).toMatchObject({ outcome: "blocked", reason: "the same click had no effect twice" });
  });

  it("matches by label when entries carry no index", async () => {
    const e = noEffect({ index: undefined });
    const { result } = await decide(clickSearch({ CLICK: 0.9 }), { elements: els, scroll, history: [e, e] });
    expect(result.outcome).toBe("blocked");
  });

  it("allows a retry after one no-effect click", async () => {
    const { result } = await decide(clickSearch({ CLICK: 0.9 }), { elements: els, scroll, history: [noEffect()] });
    expect(result).toMatchObject({ operation: "CLICK", index: 5 });
  });

  it("allows a retry after any other step in between", async () => {
    const between = { operation: "TYPE_TEXT", label: 'TYPE_TEXT "x" into "Last name"', ok: true, index: 1 };
    const history = [noEffect(), noEffect(), between];
    const { result } = await decide(clickSearch({ CLICK: 0.9 }), { elements: els, scroll, history });
    expect(result).toMatchObject({ operation: "CLICK", index: 5 });
  });

  it("allows Create account after a no-effect click, a TYPE_TEXT and the pick again", async () => {
    const history = [
      { operation: "CLICK", label: "Create account (no effect)", ok: true, index: 5 },
      { operation: "TYPE_TEXT", label: 'TYPE_TEXT "Petrova" into "Last name"', ok: true, index: 1 },
    ];
    const { result } = await decide(
      { operation: choice("CLICK", 0.9), click_target: choice("5", 0.9) },
      { history },
    );
    expect(result).toMatchObject({ operation: "CLICK", index: 5 });
  });

  it("ignores carried-over entries and a different element", async () => {
    const carried = noEffect({ label: "Search properties (no effect) (earlier sub-goal)" });
    expect((await decide(clickSearch({ CLICK: 0.9 }), { elements: els, scroll, history: [carried, carried] })).result).toMatchObject({ operation: "CLICK", index: 5 });
    const other = { operation: "CLICK", label: "Refine location (no effect)", ok: true, index: 6 };
    expect((await decide(clickSearch({ CLICK: 0.9 }), { elements: els, scroll, history: [other, noEffect()] })).result).toMatchObject({ operation: "CLICK", index: 5 });
  });
});

describe("retyped query shortening", () => {
  const field = (label: string, extra: Partial<BrowseStepElement> = {}): BrowseStepElement => ({ index: 1, tag: "input", label, ops: ["TYPE_TEXT"], ...extra });
  const typed = (text: string, label: string) => ({ operation: "TYPE_TEXT", label: `TYPE_TEXT "${text}" into "${label}"`, ok: true, index: 1 });
  const CJ = "Clapham Junction station, London";

  it("shortens an identical retype in a location field when no option was clicked", () => {
    const f = field("Location");
    expect(shortenRetypedQuery([typed(CJ, "Location")], f, [f], CJ)).toBe("Clapham Junction station");
    expect(shortenRetypedQuery([typed(CJ, "Location")], f, [f], "clapham  junction station, london")).toBe("Clapham Junction station");
  });
  it("works for combobox/searchbox roles regardless of label", () => {
    const f = field("Anything", { role: "combobox" });
    expect(shortenRetypedQuery([typed(CJ, "Anything")], f, [f], CJ)).toBe("Clapham Junction station");
  });
  it("leaves plain name/address fields alone", () => {
    const f = field("Last name");
    expect(shortenRetypedQuery([typed("Smith, Jr.", "Last name")], f, [f], "Smith, Jr.")).toBe("Smith, Jr.");
    const a = field("Street address");
    expect(shortenRetypedQuery([typed("1 Main St, Apt 2", "Street address")], a, [a], "1 Main St, Apt 2")).toBe("1 Main St, Apt 2");
  });
  it("leaves a different model text alone", () => {
    const f = field("Destination");
    expect(shortenRetypedQuery([typed("Paris, France", "Destination")], f, [f], "Lyon, France")).toBe("Lyon, France");
  });
  it("leaves the text alone after an option click landed, or without a comma, or a first typing", () => {
    const f = field("Location");
    const opt: BrowseStepElement = { index: 9, tag: "li", role: "option", label: "Clapham Junction Station, London", ops: ["CLICK"] };
    const pick = { operation: "CLICK", label: "Clapham Junction Station, London", ok: true, index: 9 };
    expect(shortenRetypedQuery([typed(CJ, "Location"), pick], f, [f, opt], CJ)).toBe(CJ);
    expect(shortenRetypedQuery([typed("Paris", "Location")], f, [f], "Paris")).toBe("Paris");
    expect(shortenRetypedQuery([], f, [f], CJ)).toBe(CJ);
  });
  it("keeps the text when the head is shorter than 3 characters", () => {
    const f = field("Location");
    expect(shortenRetypedQuery([typed("LA, USA", "Location")], f, [f], "LA, USA")).toBe("LA, USA");
  });

  it("is applied by the policy on a retype, with the gate and reason, and the prompt is unchanged", async () => {
    const prompt = mockFieldText(CJ);
    const elements: BrowseStepElement[] = [
      { index: 1, tag: "input", label: "Location", ops: ["TYPE_TEXT"], value: "" },
      { index: 5, tag: "button", label: "Search properties", ops: ["CLICK"] },
    ];
    const history = [typed(CJ, "Location"), { operation: "CLICK", label: "Search properties (no effect)", ok: true, index: 5 }];
    const { result } = await decide({ operation: choice("TYPE_TEXT", 0.9), type_text_target: choice("1", 0.9) }, { elements, history });
    expect(result).toMatchObject({ outcome: "act", operation: "TYPE_TEXT", index: 1, text: "Clapham Junction station", reason: "shortened a query that found nothing" });
    expect(result.diag?.gates).toContainEqual(expect.objectContaining({ head: "retype-shorten" }));
    expect(result.diag?.tier).toBe("rule");
    expect(prompt()).not.toContain("shorter form");
  });
});

describe("pending suggestions for a plain text field reported as expanded", () => {
  const elements: BrowseStepElement[] = [
    { index: 0, tag: "input", label: "Location", ops: ["TYPE_TEXT"], value: "Clapham Junction station", expanded: true },
    { index: 1, tag: "button", label: "Search properties", ops: ["CLICK"] },
    { index: 2, tag: "div", role: "option", label: "Clapham Junction Station, London", ops: ["CLICK"] },
  ];
  const history = [{ operation: "TYPE_TEXT", label: 'TYPE_TEXT "Clapham Junction station" into "Location"', ok: true, index: 0 }];
  it("clicks the matching option row before the search button", async () => {
    const { result } = await decide({ operation: choice("CLICK", 0.9), click_target: choice("1", 0.9) }, { elements, history });
    expect(result).toMatchObject({ outcome: "act", operation: "CLICK", index: 2 });
    expect(result.reason).toContain("suggestion");
  });
});

describe("unanswered-choice gate (SCROLL before a disabled button)", () => {
  const radio = (index: number, label: string, checked = false): BrowseStepElement => ({ index, tag: "input", role: "radio", label, ops: ["CLICK"], checked });
  const CHOICE: BrowseStepElement[] = [
    radio(1, "Standard"),
    radio(2, "Extended"),
    { index: 3, tag: "button", role: "button", label: "Continue", ops: ["CLICK"], disabled: true },
    { index: 4, tag: "a", role: "link", label: "Help", ops: ["CLICK"] },
  ];
  const lunaConfig = makeOptions({ decisionModel: "openai/gpt-6-luna-decisions" });
  const scroll = { operation: choice("SCROLL_DOWN", 0.9) };

  async function run(
    answers: Record<string, SystemOneAnswer>,
    elements: BrowseStepElement[] = CHOICE,
    opts: { luna?: boolean; history?: BrowseStepInput["history"] } = {},
  ) {
    let calls = 0;
    const result = await decideBrowseStepUltrafast(
      fakeClient(answers, { capture: () => calls++ }),
      opts.luna ? lunaConfig : config,
      input({ elements, history: opts.history ?? [] }),
    );
    return { result, calls };
  }

  for (const luna of [false, true]) {
    const name = luna ? "luna" : "jev";
    it(`${name}: clicks the model's own click target when it is an unanswered option`, async () => {
      const { result, calls } = await run({ ...scroll, click_target: choice("2", 0.7) }, CHOICE, { luna });
      expect(result).toMatchObject({ outcome: "act", operation: "CLICK", index: 2 });
      expect(result.diag?.gates).toContainEqual(expect.objectContaining({ head: "unanswered-choice" }));
      expect(result.diag?.tier).toBe("rule");
      expect(calls).toBe(1);
    });

    it(`${name}: asks one narrow question limited to the options, with the goal and the disabled-control rule`, async () => {
      const seen: Captured[] = [];
      const result = await decideBrowseStepUltrafast(
        fakeClient({ ...scroll, click_target: choice("4", 0.6), unanswered_choice: choice("1", 0.8) }, { capture: (p) => seen.push(p) }),
        luna ? lunaConfig : config,
        input({ elements: CHOICE }),
      );
      expect(result).toMatchObject({ outcome: "act", operation: "CLICK", index: 1 });
      expect(seen).toHaveLength(2);
      const q = seen[1]!.questions.unanswered_choice!;
      expect(q.type === "choice" ? Object.keys(q.criteria).sort() : []).toEqual(luna ? ["1", "2", "none"] : ["1", "2"]);
      const text = JSON.stringify(q.instructions);
      expect(text).toContain("Register as Anna Petrova");
      expect(text).toContain(DISABLED_CONTROL_RULE);
    });

    it(`${name}: keeps SCROLL on low confidence or when the answer is none`, async () => {
      const low = await run({ ...scroll, click_target: choice("4", 0.6), unanswered_choice: choice("1", 0.3) }, CHOICE, { luna });
      expect(low.result).toMatchObject({ outcome: "act", operation: "SCROLL_DOWN" });
      const none = await run({ ...scroll, click_target: choice("4", 0.6), unanswered_choice: choice("none", 0.9) }, CHOICE, { luna });
      expect(none.result).toMatchObject({ outcome: "act", operation: "SCROLL_DOWN" });
      expect(none.result.diag?.gates.some((g) => g.head === "unanswered-choice")).toBe(false);
    });
  }

  it("keeps SCROLL without a disabled button, with a checked radio, or with a single radio", async () => {
    const answers = { ...scroll, click_target: choice("2", 0.7) };
    const enabled = CHOICE.map((e) => (e.index === 3 ? { ...e, disabled: false } : e));
    expect((await run(answers, enabled)).result.operation).toBe("SCROLL_DOWN");
    const checked = CHOICE.map((e) => (e.index === 1 ? { ...e, checked: true } : e));
    expect((await run(answers, checked)).result.operation).toBe("SCROLL_DOWN");
    const single = CHOICE.filter((e) => e.index !== 2);
    expect((await run({ ...scroll, click_target: choice("1", 0.7) }, single)).result.operation).toBe("SCROLL_DOWN");
  });

  it("keeps SCROLL when recent no-effect clicks already ruled the options out", async () => {
    const history = [
      { operation: "CLICK", label: "Standard (no effect)", ok: true, index: 1 },
      { operation: "CLICK", label: "Extended (no effect)", ok: true, index: 2 },
    ];
    const { result } = await run({ ...scroll, click_target: choice("2", 0.7) }, CHOICE, { history });
    expect(result.operation).toBe("SCROLL_DOWN");
  });

  it("does not touch a non-scroll operation", async () => {
    const { result } = await run({ operation: choice("WAIT", 0.9) });
    expect(result.operation).toBe("WAIT");
  });
});

describe("literal-mismatch gate (near-miss numeric option)", () => {
  const goal = 'Filter the price to "Under 15"';
  const under20: BrowseStepElement = { index: 1, tag: "div", role: "option", label: "Under 20", ops: ["CLICK"] };
  const range: BrowseStepElement = { index: 2, tag: "div", role: "option", label: "From 10-15", ops: ["CLICK"] };
  const maxField: BrowseStepElement = { index: 3, tag: "input", label: "Max price", ops: ["TYPE_TEXT"], value: "" };
  const op = { operation: choice("CLICK", 0.8, { probabilities: { CLICK: 0.8, TYPE_TEXT: 0.15 } }), click_target: choice("1", 0.8) };

  it("picks the option that holds the exact quoted phrase", async () => {
    const exact: BrowseStepElement = { index: 4, tag: "div", role: "option", label: "Under 15", ops: ["CLICK"] };
    const { result } = await decide(op, { goal, elements: [under20, range, exact] });
    expect(result).toMatchObject({ outcome: "act", operation: "CLICK", index: 4 });
    expect(result.diag?.gates).toContainEqual(expect.objectContaining({ head: "literal-mismatch" }));
  });

  it("falls back to typing the value when only a text field can carry it", async () => {
    mockFieldText("15");
    const { result } = await decide({ ...op, type_text_target: choice("3", 0.8) }, { goal, elements: [under20, range, maxField] });
    expect(result).toMatchObject({ outcome: "act", operation: "TYPE_TEXT", index: 3, text: "15" });
    expect(result.diag?.gates).toContainEqual(expect.objectContaining({ head: "literal-mismatch" }));
  });

  it("blocks when the exact option is not offered and nothing can be typed", async () => {
    const { result } = await decide(op, { goal, elements: [under20, range] });
    expect(result.outcome).toBe("blocked");
    expect(result.reason).toContain('the exact option "under 15" is not offered');
  });

  it("matches numbers across thousands separators and currency marks", async () => {
    const exact: BrowseStepElement = { index: 4, tag: "div", role: "option", label: "Under $1,500", ops: ["CLICK"] };
    const near: BrowseStepElement = { index: 1, tag: "div", role: "option", label: "Under $2,000", ops: ["CLICK"] };
    const { result } = await decide(op, { goal: 'Pick "Under 1500"', elements: [near, exact] });
    expect(result).toMatchObject({ operation: "CLICK", index: 4 });
  });

  it("leaves a click alone when the label already has the quoted number or the goal has no number", async () => {
    const same = await decide({ operation: choice("CLICK", 0.8), click_target: choice("4", 0.8) }, {
      goal,
      elements: [under20, { index: 4, tag: "div", role: "option", label: "Under 15", ops: ["CLICK"] }],
    });
    expect(same.result).toMatchObject({ operation: "CLICK", index: 4 });
    expect(same.result.diag?.gates.some((g) => g.head === "literal-mismatch")).toBe(false);
    const plain = await decide(op, { goal: 'Pick "Under budget"', elements: [under20, range] });
    expect(plain.result).toMatchObject({ operation: "CLICK", index: 1 });
    const unquoted = await decide(op, { goal: "Pick Under 15", elements: [under20, range] });
    expect(unquoted.result).toMatchObject({ operation: "CLICK", index: 1 });
  });

  // The prompt-level twin of this gate made Luna refuse every click target
  // (a submit button has no quoted number) right after a field was filled:
  // the deterministic gate is the only guard.
  it("does not put a near-match rule into the click-target instructions", async () => {
    const { captured } = await decide(op, { goal, elements: [under20, range] });
    expect(JSON.stringify(captured.questions.click_target!.instructions)).not.toContain("different number");
  });
});

describe("value-already-set gate (retyping what a field holds)", () => {
  const field = (value: string): BrowseStepElement => ({ index: 1, tag: "input", label: "Destination", ops: ["TYPE_TEXT"], value });
  const go: BrowseStepElement = { index: 2, tag: "button", label: "Search", ops: ["CLICK"] };
  const goal = 'Search trains to "Berlin Hauptbahnhof"';

  it("does not retype; continues with the runner-up operation", async () => {
    mockFieldText("Berlin Hauptbahnhof");
    const { result } = await decide(
      { operation: choice("TYPE_TEXT", 0.8, { probabilities: { TYPE_TEXT: 0.8, CLICK: 0.3 } }), type_text_target: choice("1", 0.8), click_target: choice("2", 0.8) },
      { goal, elements: [field("berlin  Hauptbahnhof"), go] },
    );
    expect(result).toMatchObject({ outcome: "act", operation: "CLICK", index: 2 });
    expect(result.diag?.gates).toContainEqual(expect.objectContaining({ head: "value-already-set" }));
  });

  it("ends with DONE rather than BLOCKED when nothing else is left", async () => {
    mockFieldText("Berlin Hauptbahnhof");
    const { result } = await decide(
      { operation: choice("TYPE_TEXT", 0.8), type_text_target: choice("1", 0.8) },
      { goal, elements: [field("  Berlin  HAUPTBAHNHOF ")] },
    );
    expect(result).toMatchObject({ outcome: "done", operation: "DONE" });
    expect(result.diag?.gates).toContainEqual(expect.objectContaining({ head: "value-already-set" }));
  });

  it("still types when the field holds a different value", async () => {
    mockFieldText("Berlin Hauptbahnhof");
    const { result } = await decide(
      { operation: choice("TYPE_TEXT", 0.8), type_text_target: choice("1", 0.8) },
      { goal, elements: [field("Munich")] },
    );
    expect(result).toMatchObject({ outcome: "act", operation: "TYPE_TEXT", index: 1, text: "Berlin Hauptbahnhof" });
  });

  it("still types a short value (under 3 characters) into a field that holds it", async () => {
    mockFieldText("LA");
    const { result } = await decide(
      { operation: choice("TYPE_TEXT", 0.8), type_text_target: choice("1", 0.8) },
      { goal: 'Search "LA"', elements: [field("LA")] },
    );
    expect(result).toMatchObject({ operation: "TYPE_TEXT", text: "LA" });
  });
});

describe("value-already-set compares by equality, not substring", () => {
  it("is already set when an autocomplete appended after a non-alphanumeric boundary", async () => {
    mockFieldText("Berlin Hauptbahnhof");
    const { result } = await decide(
      { operation: choice("TYPE_TEXT", 0.8), type_text_target: choice("1", 0.8) },
      { goal: 'Search "Berlin Hauptbahnhof"', elements: [{ index: 1, tag: "input", label: "Destination", ops: ["TYPE_TEXT"], value: "Berlin Hauptbahnhof, Germany" }] },
    );
    expect(result).toMatchObject({ outcome: "done" });
    expect(result.diag?.gates).toContainEqual(expect.objectContaining({ head: "value-already-set" }));
  });

  it("ignores thousands separators, but not a longer number or word", async () => {
    for (const [text, value, set] of [["1500", "1,500", true], ["100", "1000", false], ["shoes", "red shoes for men", false]] as const) {
      mockFieldText(text);
      const { result } = await decide(
        { operation: choice("TYPE_TEXT", 0.8), type_text_target: choice("1", 0.8) },
        { goal: `Enter "${text}"`, elements: [{ index: 1, tag: "input", label: "Amount", ops: ["TYPE_TEXT"], value }] },
      );
      expect(result.diag?.gates.some((g) => g.head === "value-already-set")).toBe(set);
    }
  });

  it("still types when the field holds a longer word that merely starts with the text", async () => {
    mockFieldText("Berlin");
    const { result } = await decide(
      { operation: choice("TYPE_TEXT", 0.8), type_text_target: choice("1", 0.8) },
      {
        goal: 'Search trains to "Berlin"',
        elements: [{ index: 1, tag: "input", label: "Destination", ops: ["TYPE_TEXT"], value: "Berlinale" }],
      },
    );
    expect(result).toMatchObject({ outcome: "act", operation: "TYPE_TEXT", text: "Berlin" });
  });
});

describe("literal comparison respects number boundaries", () => {
  const op = { operation: choice("CLICK", 0.8, { probabilities: { CLICK: 0.8, TYPE_TEXT: 0.15 } }), click_target: choice("1", 0.8) };
  const opt = (index: number, label: string): BrowseStepElement => ({ index, tag: "div", role: "option", label, ops: ["CLICK"] });

  it('treats "Under $150" as a near miss for "Under 15", not an exact match', async () => {
    const { result } = await decide(op, { goal: 'Filter to "Under 15"', elements: [opt(1, "Under $150"), opt(2, "Over 15")] });
    expect(result.outcome).toBe("blocked");
    expect(result.reason).toContain("is not offered");
    expect(result.diag?.gates).toContainEqual(expect.objectContaining({ head: "literal-mismatch" }));
  });

  it('does not pick "Under $150" as the exact option when "Under 15" exists', async () => {
    const { result } = await decide(op, { goal: 'Filter to "Under 15"', elements: [opt(1, "Under $150"), opt(2, "Under 15")] });
    expect(result).toMatchObject({ operation: "CLICK", index: 2 });
  });

  it('treats "March 15" as a near miss for "March 1"', async () => {
    const { result } = await decide(op, { goal: 'Pick "March 1"', elements: [opt(1, "March 15"), opt(2, "March 1")] });
    expect(result).toMatchObject({ operation: "CLICK", index: 2 });
    expect(result.diag?.gates).toContainEqual(expect.objectContaining({ head: "literal-mismatch" }));
    const only = await decide(op, { goal: 'Pick "March 1"', elements: [opt(1, "March 15")] });
    expect(only.result.outcome).toBe("blocked");
  });

  it("blocks instead of typing when the TYPE_TEXT runner-up is below the minimum probability", async () => {
    const weak = { operation: choice("CLICK", 0.9, { probabilities: { CLICK: 0.9, TYPE_TEXT: 0.02 } }), click_target: choice("1", 0.9), type_text_target: choice("3", 0.9) };
    const { result } = await decide(weak, {
      goal: 'Filter to "Under 15"',
      elements: [opt(1, "Under 20"), { index: 3, tag: "input", label: "Max price", ops: ["TYPE_TEXT"], value: "" }],
    });
    expect(result.outcome).toBe("blocked");
    expect(result.reason).toContain("is not offered");
  });
});

describe("option-like is limited to real choice controls", () => {
  it('does not block a stepper button labelled "Adults: 1, increase"', async () => {
    const { result } = await decide(
      { operation: choice("CLICK", 0.8), click_target: choice("1", 0.8) },
      {
        goal: "Book for 2 adults",
        elements: [{ index: 1, tag: "button", label: "Adults: 1, increase", ops: ["CLICK"] }],
      },
    );
    expect(result).toMatchObject({ outcome: "act", operation: "CLICK", index: 1 });
    expect(result.diag?.gates.some((g) => g.head === "literal-mismatch")).toBe(false);
  });

  it('does not block a stepper whose goal quotes "2 adults"', async () => {
    const { result } = await decide(
      { operation: choice("CLICK", 0.8), click_target: choice("1", 0.8) },
      {
        goal: 'Set the guests to "2 adults"',
        elements: [{ index: 1, tag: "button", label: "Adults: 1, increase", ops: ["CLICK"] }],
      },
    );
    expect(result).toMatchObject({ outcome: "act", operation: "CLICK", index: 1 });
  });
});

describe("unanswered-choice gate: native inputs, peak and accounting", () => {
  const nativeRadio = (index: number, label: string, inputType = "radio"): BrowseStepElement => ({
    index, tag: "input", inputType, label, ops: ["CLICK"], checked: false,
  });
  const button: BrowseStepElement = { index: 3, tag: "button", label: "Continue", ops: ["CLICK"], disabled: true };
  const scroll = { operation: choice("SCROLL_DOWN", 0.9) };

  it("fires for a role-less native radio group above a disabled native button", async () => {
    const { result } = await decide({ ...scroll, click_target: choice("2", 0.7) }, { elements: [nativeRadio(1, "Standard"), nativeRadio(2, "Extended"), button] });
    expect(result).toMatchObject({ outcome: "act", operation: "CLICK", index: 2 });
    expect(result.diag?.gates).toContainEqual(expect.objectContaining({ head: "unanswered-choice" }));
  });

  it("does not treat native checkboxes as an unanswered required group", async () => {
    const { result } = await decide({ ...scroll, click_target: choice("2", 0.7) }, {
      elements: [nativeRadio(1, "News", "checkbox"), nativeRadio(2, "Offers", "checkbox"), button],
    });
    expect(result.operation).toBe("SCROLL_DOWN");
  });

  it("falls through to the narrow question when the model's own click target is weak", async () => {
    const seen: Captured[] = [];
    const result = await decideBrowseStepUltrafast(
      fakeClient({ ...scroll, click_target: choice("2", 0.3), unanswered_choice: choice("1", 0.8) }, { capture: (p) => seen.push(p) }),
      config,
      input({ elements: [nativeRadio(1, "Standard"), nativeRadio(2, "Extended"), button] }),
    );
    expect(result).toMatchObject({ outcome: "act", operation: "CLICK", index: 1 });
    expect(seen).toHaveLength(2);
    const gate = result.diag?.gates.find((g) => g.head === "unanswered-choice");
    expect(gate?.peak).toBe(0.8);
  });

  it("sends the screenshot with the narrow question and counts its tokens", async () => {
    const SHOT = "data:image/jpeg;base64,QUJD";
    const seen: Captured[] = [];
    const result = await decideBrowseStepUltrafast(
      fakeClient({ ...scroll, click_target: choice("4", 0.6), unanswered_choice: choice("1", 0.8) }, { capture: (p) => seen.push(p) }),
      makeOptions({ vision: true }),
      input({ elements: [nativeRadio(1, "Standard"), nativeRadio(2, "Extended"), button], screenshot: SHOT }),
    );
    expect(seen).toHaveLength(2);
    expect(seen[1]!.state).toEqual(seen[0]!.state);
    expect(Array.isArray(seen[1]!.state)).toBe(true);
    expect(JSON.stringify(seen[1]!.questions.unanswered_choice!.instructions)).toContain("screenshot_note");
    expect(result.diag?.inputTokens).toBe(200);
  });
});

describe("number matching by whole tokens, chips and model roles", () => {
  const op = { operation: choice("CLICK", 0.8, { probabilities: { CLICK: 0.8, TYPE_TEXT: 0.15 } }), click_target: choice("1", 0.8) };
  const chip = (index: number, label: string): BrowseStepElement => ({ index, tag: "button", label, ops: ["CLICK"] });

  it("accepts labels that carry extra numbers or words around the phrase", async () => {
    const goal = 'Filter to "Under 15"';
    const { result } = await decide(op, {
      goal,
      elements: [{ index: 1, tag: "div", role: "option", label: "Under $150", ops: ["CLICK"] }, { index: 2, tag: "div", role: "option", label: "Under $15 (23 hotels)", ops: ["CLICK"] }],
    });
    expect(result).toMatchObject({ operation: "CLICK", index: 2 });
    const date = await decide(op, {
      goal: 'Pick "March 1"',
      elements: [{ index: 1, tag: "div", role: "option", label: "Sat, March 15, 2026", ops: ["CLICK"] }, { index: 2, tag: "div", role: "option", label: "Sat, March 1, 2026", ops: ["CLICK"] }],
    });
    expect(date.result).toMatchObject({ operation: "CLICK", index: 2 });
  });

  it("treats role-less chips as options for the phrase, but not a stepper", async () => {
    const { result } = await decide(op, { goal: 'Filter to "Under 15"', elements: [chip(1, "Under $150"), chip(3, "Under $15")] });
    expect(result).toMatchObject({ operation: "CLICK", index: 3 });
    expect(result.diag?.gates).toContainEqual(expect.objectContaining({ head: "literal-mismatch" }));
    const only = await decide(op, { goal: 'Filter to "Under 15"', elements: [chip(1, "Under $150")] });
    expect(only.result.outcome).toBe("blocked");
  });

  it("shows a role-less native radio / checkbox to the model by its input type", async () => {
    const { captured } = await decide(
      { operation: choice("CLICK", 0.8), click_target: choice("1", 0.8) },
      { elements: [{ index: 1, tag: "input", inputType: "radio", label: "Std", ops: ["CLICK"], checked: false }] },
    );
    expect(JSON.stringify(captured.state)).toContain('"role":"radio"');
    expect(JSON.stringify(captured.questions.click_target)).toContain('"role":"radio"');
  });
});
