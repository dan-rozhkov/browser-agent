import { scrubPii } from "../analysis/pii.js";
import type { SystemOneClient } from "../services/systemone.js";
import { isCarriedOverEntry, type BrowseStepInput, type BrowseStepResult } from "./browseStep.js";

// Deterministic irreversible-action guard for browse_task. Live finding: with
// a goal that said "Do not book … stop before checkout/booking", the loop
// CLICKed a "Reserve table" slot and reached a page holding a REAL table.
// Like browseCaptcha.ts this lives in its own module and is applied once at
// the route's `decide` AFTER the policy answered, so both policies are
// covered by one call site. It looks at CLICK on a labelled element and at
// PRESS_ENTER that would submit a form next to an unauthorized commit
// button. Generic by design — verbs only (en/ru/de), no site names.

export type CommitKind = "reserve" | "purchase" | "submit";

/** Whole-word, Unicode-aware matcher (ASCII \b would split Cyrillic). */
const word = (src: string): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${src})(?![\\p{L}\\p{N}])`, "giu");
const L = "[\\p{L}]*";

// ---- labels -------------------------------------------------------------

const LABEL_RE: Record<CommitKind, RegExp> = {
  reserve: word(
    [
      "reserve",
      "(?:book|reserve) (?:tickets?|seats?|now|it|this|online)",
      "book (?:now|this)",
      "book (?:a |an )?(?:table|room|seat|ticket|flight|stay|appointment)",
      "(?:confirm|complete) (?:booking|reservation)",
      "hold (?:this |the )?(?:table|seat|room)",
      `(?:за)?бронировать|(?:за)?бронируй(?:те)?|зарезервировать|зарезервируйте|забронир${L}|брониру${L}`,
      `reservier${L}|jetzt buchen|buchen|reservieren`,
    ].join("|"),
  ),
  purchase: word(
    [
      "buy now",
      "place (?:your |an )?order",
      "submit order",
      "pay",
      "(?:complete|confirm) (?:purchase|order|payment)",
      "proceed to (?:checkout|payment)",
      "check ?out",
      "purchase",
      "(?:buy|order|purchase) (?:tickets?|seats?|now|it|this|online)",
      "(?:continue|go) to (?:payment|checkout)",
      `купить|оплатить|оформить заказ|перейти к оплате|оформление заказа|оплат${L}|заказать`,
      "kaufen|bezahlen|zahlungspflichtig bestellen|zur kasse|bestellen",
    ].join("|"),
  ),
  submit: word(
    [
      "(?:send|submit) (?:application|request|message|form|enquiry|inquiry)",
      "confirm and send",
      "sign (?:and|&) submit",
      "отправить заявку|отправить запрос",
      "absenden|anfrage senden",
    ].join("|"),
  ),
};

// Marketing copy that contains a commit verb but commits nothing.
const MARKETING_RE = word(
  "reserve now,? pay (?:later|at the \\p{L}+)|pay later|pay at the \\p{L}+|pay on arrival|pay when you stay|pay in store",
);
// A commit noun followed by one of these is a nav link ("Purchase history").
const NOUN_LINK_RE = word(
  `(?:purchase|checkout|check out|reserve|reservation|booking|book|buy|pay|order)s? (?:history|policy|guide|options|methods|terms|protection|details|info|list|management)`,
);

// Bare one-word controls: a cheap prefilter hit only; the model decides.
const BARE_LABELS: Record<string, CommitKind> = {
  book: "reserve", "book it": "reserve", reserve: "reserve", забронировать: "reserve", buchen: "reserve", reservieren: "reserve",
  submit: "submit", confirm: "submit", send: "submit", отправить: "submit", подтвердить: "submit", absenden: "submit", bestätigen: "submit",
  order: "purchase", pay: "purchase", buy: "purchase", purchase: "purchase", checkout: "purchase", "check out": "purchase",
  оплатить: "purchase", купить: "purchase", заказать: "purchase", bezahlen: "purchase", kaufen: "purchase", bestellen: "purchase",
};

/** Cheap prefilter: the kind of irreversible commit a control label may
 * name, or null. Not an authorization decision. */
export function commitKind(label: string): CommitKind | null {
  const bare = BARE_LABELS[label.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").trim().toLowerCase()];
  if (bare) return bare;
  const text = label.replace(/[’]/g, "'");
  const clean = text.replace(MARKETING_RE, " ").replace(NOUN_LINK_RE, " ");
  for (const kind of ["reserve", "purchase", "submit"] as const) {
    if (new RegExp(LABEL_RE[kind].source, "iu").test(clean)) return kind;
  }
  return null;
}

// ---- password value -----------------------------------------------------

const PASSWORD_KEYWORD_RE = /(?<![\p{L}\p{N}])(?:password|passwd|passcode|пароль|passwort)(?![\p{L}\p{N}])/giu;
const PASSWORD_FILLERS = new Set(["is", "ist", "for", "the", "site", "my", "to", "equals", "это", "—", "-", "–", ":", "=", ":="]);
// Nouns that follow the word "password" without being the password itself.
const PASSWORD_NOUNS = new Set(["manager", "field", "reset", "entry", "hint", "box", "input", "page", "form", "prompt"]);
const QUOTED_AT_START_RE = /^(?:"([^"]*)"|“([^”]*)”|«([^»]*)»|'([^']*)'|`([^`]*)`)/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PASSWORD_WORDS = 6;
const REDACTED_PASSWORD = "[password]";

interface GoalPassword {
  value: string;
  start: number;
  end: number;
}

function findPasswordInGoal(goal: string): GoalPassword | null {
  for (const kw of goal.matchAll(PASSWORD_KEYWORD_RE)) {
    let pos = kw.index + kw[0].length;
    for (let i = 0; i < MAX_PASSWORD_WORDS; i++) {
      pos += /^[\s:=]*/u.exec(goal.slice(pos))![0].length;
      const rest = goal.slice(pos);
      if (!rest) break;
      const quoted = QUOTED_AT_START_RE.exec(rest);
      if (quoted) {
        const raw = quoted.slice(1).find((g) => g !== undefined)!;
        const value = raw.trim();
        if (value && !EMAIL_RE.test(value)) {
          const start = pos + 1 + raw.indexOf(value);
          return { value, start, end: start + value.length };
        }
        break;
      }
      const token = /^\S+/u.exec(rest)![0];
      const bare = token.toLowerCase().replace(/[:,.;]+$/, "");
      if (bare === "" || PASSWORD_FILLERS.has(bare)) {
        pos += token.length;
        continue;
      }
      if (PASSWORD_NOUNS.has(bare)) break;
      const value = token.replace(/[.,]$/, "");
      if (value && !EMAIL_RE.test(value)) return { value, start: pos, end: pos + value.length };
      break;
    }
  }
  return null;
}

/** The password the goal itself states: a quoted phrase, or a single token
 * within 6 words after password/passwd/passcode/пароль/passwort (filler
 * words skipped, trailing punctuation on fillers ignored). Keeps the
 * token's punctuation except one trailing "." or ",". Never an email
 * address or a plain noun like "manager". Null when the goal gives none. */
export function extractPasswordFromGoal(goal: string): string | null {
  return findPasswordInGoal(goal)?.value ?? null;
}

/** The goal with the password value replaced by "[password]": the only form
 * of the goal any model may see. */
export function redactGoalPassword(goal: string): string {
  const found = findPasswordInGoal(goal);
  return found ? `${goal.slice(0, found.start)}${REDACTED_PASSWORD}${goal.slice(found.end)}` : goal;
}

/** The input a policy should work on: goal redacted, the real password kept
 * aside for deterministic typing (only when the user allowed it). */
export function withRedactedGoal<T extends Pick<BrowseStepInput, "goal" | "permissions">>(
  input: T,
): T & { typedPassword?: string | null } {
  const found = findPasswordInGoal(input.goal);
  if (!found) return input;
  return {
    ...input,
    goal: redactGoalPassword(input.goal),
    typedPassword: input.permissions?.allowPasswordEntry === true ? found.value : null,
  };
}

// ---- the guard ----------------------------------------------------------

const KIND_ACTION: Record<CommitKind, string> = {
  reserve: "reserve/book",
  purchase: "buy/pay/place an order",
  submit: "submit/send/confirm",
};
const SEARCH_LIKE = /(?<![\p{L}\p{N}])(?:search|find|query)|поиск|suche/iu;
const GUARD_TIMEOUT_MS = 8_000;
const MIN_GUARD_BUDGET_MS = 1_000;
const QUESTION_ID = "commit_check";

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

type Verdict = { answer: "yes" | "no" | "error"; probability?: number };

/** One yes/no System One question: does this action complete an
 * irreversible commitment the goal does not explicitly ask for? Fails
 * closed: any error, timeout or malformed answer is "error". */
async function askCommit(
  client: SystemOneClient,
  input: GuardInput,
  action: string,
  label: string,
  timeoutMs: number,
): Promise<Verdict> {
  if (timeoutMs < MIN_GUARD_BUDGET_MS) return { answer: "error" };
  const page = { url: hostOf(input.url ?? ""), title: scrubPii(truncate(input.title ?? "", 120)) };
  const where = `${page.title} (${page.url})`.trim();
  try {
    const result = await client.evaluate({
      state: { goal: scrubPii(redactGoalPassword(input.goal)), action, label, page },
      questions: {
        [QUESTION_ID]: {
          type: "choice",
          instructions:
            `The browser agent is about to ${action} on ${where}. ` +
            "Would this action complete an irreversible commitment — a reservation or booking, a purchase or payment, or sending an application/form — that the user's goal does NOT explicitly ask the agent to do? " +
            "Answer yes if the goal only asks to search, compare, look up or prepare, or says not to do it.",
          criteria: {
            yes: "The action completes an irreversible commitment the goal does not explicitly ask for.",
            no: "The action is reversible, or the goal explicitly asks the agent to do it.",
          },
        },
      },
      signal: AbortSignal.timeout(Math.min(GUARD_TIMEOUT_MS, timeoutMs)),
    });
    const a = result.answers[QUESTION_ID];
    if (a?.type !== "choice" || (a.choice !== "yes" && a.choice !== "no")) return { answer: "error" };
    return { answer: a.choice, probability: a.probabilities?.[a.choice] ?? a.confidence };
  } catch {
    return { answer: "error" };
  }
}

function stopped(
  result: BrowseStepResult,
  kind: CommitKind,
  rawLabel: string,
  what: string,
  verdict: Verdict,
): BrowseStepResult {
  return {
    outcome: "blocked",
    operation: "BLOCKED",
    confidence: 1,
    model: result.model,
    reason:
      verdict.answer === "error"
        ? `needs user confirmation: could not check whether "${scrubPii(truncate(rawLabel, 80))}" is allowed (check failed) — ask the user before this step`
        : `needs user confirmation: stopped before "${scrubPii(truncate(rawLabel, 80))}": this ${what} would ${KIND_ACTION[kind]} and the goal does not ask for it — report what is on the page and ask the user to confirm this step`,
    timings: result.timings,
    diag: {
      gates: [],
      ...result.diag,
      tier: "rule",
      commitGuard: kind,
      commitGuardAnswer: verdict.answer,
      commitGuardProbability: verdict.probability,
    },
  };
}

type GuardInput = Pick<BrowseStepInput, "goal" | "elements" | "permissions"> &
  Partial<Pick<BrowseStepInput, "history" | "url" | "title">>;

// "switch" is excluded on purpose: a switch often saves on toggle, so toggling can BE the commit.
const CHOICE_ROLES = new Set(["radio", "checkbox", "option", "menuitemradio"]);

function isChoiceControl(el: { tag: string; role?: string; checked?: boolean }): boolean {
  return (el.role !== undefined && CHOICE_ROLES.has(el.role.toLowerCase())) || (el.tag === "input" && el.checked !== undefined);
}

/** Prefilter finds a candidate commit control (CLICK, or the form's button
 * for an Enter that submits a non-search field); the model then decides
 * whether the goal authorizes it. yes/error -> terminal blocked result. */
export async function commitGuard(
  client: SystemOneClient,
  input: GuardInput,
  result: BrowseStepResult,
  opts: { timeoutMs?: number } = {},
): Promise<BrowseStepResult> {
  if (input.permissions?.confirmIrreversible === false) return result;
  if (result.outcome !== "act") return result;

  let candidate: { kind: CommitKind; label: string; action: string; what: string } | undefined;
  if (result.operation === "CLICK" && result.index !== undefined) {
    const el = input.elements.find((e) => e.index === result.index);
    // A choice control (radio, checkbox, option) only selects a value and never submits.
    // Its label can still read like a purchase ("Buy $2,399 Pay with ..."), so it is no commit candidate.
    const kind = el && !isChoiceControl(el) ? commitKind(el.label) : null;
    if (el && kind) {
      const label = scrubPii(truncate(el.label, 120));
      candidate = { kind, label: el.label, action: `click the control "${label}"`, what: "click" };
    }
  } else if (result.operation === "PRESS_ENTER") {
    const tail = input.history?.[input.history.length - 1];
    const last = tail && !isCarriedOverEntry(tail) ? tail : undefined;
    if (last?.operation === "TYPE_TEXT" && last.ok === true) {
      const field =
        (last.index !== undefined ? input.elements.find((e) => e.index === last.index) : undefined) ??
        input.elements.find((e) => e.label && last.label.includes(e.label));
      const fieldLabel = field?.label ?? last.label;
      if (!SEARCH_LIKE.test(`${fieldLabel} ${field?.role ?? ""}`)) {
        for (const el of input.elements) {
          const submitLike =
            !isChoiceControl(el) &&
            (el.tag === "button" || (el.tag === "input" && el.ops.includes("CLICK") && !el.ops.includes("TYPE_TEXT")));
          const kind = submitLike ? commitKind(el.label) : null;
          if (!kind) continue;
          const f = scrubPii(truncate(fieldLabel, 120));
          const l = scrubPii(truncate(el.label, 120));
          candidate = { kind, label: el.label, action: `press Enter in the field "${f}" next to the control "${l}"`, what: "key press" };
          break;
        }
      }
    }
  }
  if (!candidate) return result;

  const verdict = await askCommit(client, input, candidate.action, scrubPii(truncate(candidate.label, 120)), opts.timeoutMs ?? GUARD_TIMEOUT_MS);
  if (verdict.answer === "no") {
    return result.diag
      ? { ...result, diag: { ...result.diag, commitGuard: candidate.kind, commitGuardAnswer: "no", commitGuardProbability: verdict.probability } }
      : result;
  }
  return stopped(result, candidate.kind, candidate.label, candidate.what, verdict);
}

/** Label samples the cross-repo contract test replays against `commitKind`. */
export const COMMIT_LABEL_SAMPLES: {
  positive: ReadonlyArray<readonly [string, CommitKind]>;
  negative: readonly string[];
} = {
  positive: [
    ["6:30 PM Reserve table at Tropical Restaurant restaurant", "reserve"],
    ["Book →", "reserve"],
    ["Book now", "reserve"],
    ["Book tickets", "reserve"],
    ["Confirm booking", "reserve"],
    ["Jetzt reservieren", "reserve"],
    ["Забронирую", "reserve"],
    ["Забронировать", "reserve"],
    ["Confirm.", "submit"],
    ["Submit ›", "submit"],
    ["Отправить заявку", "submit"],
    ["Buy tickets", "purchase"],
    ["Buy now", "purchase"],
    ["Place your order", "purchase"],
    ["Continue to payment", "purchase"],
    ["Proceed to checkout", "purchase"],
    ["Pay with PayPal", "purchase"],
    ["Оплатить", "purchase"],
    ["Zur Kasse", "purchase"],
  ],
  negative: [
    "Booking.com", "Facebook", "Bookmark", "Notebook", "Reserved", "Reservations", "Payment methods", "Payments",
    "PayPal", "Add to cart", "Add to bag", "Add to basket", "Buying guide", "Ways to buy", "Search",
    "Мои бронирования", "Hotel Lumen 8.9 Reserve now, pay later", "Pay at the property", "Purchase history",
    "Reservation policy",
  ],
};
