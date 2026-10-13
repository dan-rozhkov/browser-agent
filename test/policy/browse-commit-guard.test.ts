import { describe, expect, it } from "vitest";
import { COMMIT_LABEL_SAMPLES, commitGuard, commitKind, extractPasswordFromGoal, redactGoalPassword } from "../../src/policy/browseCommitGuard.js";
import type { BrowseStepResult } from "../../src/policy/browseStep.js";
import type { SystemOneAnswer } from "../../src/policy/decisions.js";
import { choice, fakeClient } from "./browseFakes.js";

describe("COMMIT_LABEL_SAMPLES", () => {
  it.each(COMMIT_LABEL_SAMPLES.positive)("%s -> %s", (label, kind) => {
    expect(commitKind(label)).toBe(kind);
  });
  it.each(COMMIT_LABEL_SAMPLES.negative)("%s is not a candidate", (label) => {
    expect(commitKind(label)).toBeNull();
  });
});

describe("commitKind (prefilter)", () => {
  it.each([
    ["6:30 PM Reserve table at Tropical Restaurant restaurant", "reserve"],
    ["Reserve", "reserve"],
    ["Book now", "reserve"],
    ["Confirm booking", "reserve"],
    ["Hold this table", "reserve"],
    ["Jetzt reservieren", "reserve"],
    ["Jetzt buchen", "reserve"],
    ["Забронировать", "reserve"],
    ["Buy now", "purchase"],
    ["Place your order", "purchase"],
    ["Pay with PayPal", "purchase"],
    ["Proceed to checkout", "purchase"],
    ["Checkout", "purchase"],
    ["Оплатить", "purchase"],
    ["Zur Kasse", "purchase"],
    ["Submit application", "submit"],
    ["Отправить заявку", "submit"],
    ["Absenden", "submit"],
    ["Book", "reserve"],
    ["Confirm", "submit"],
    ["Send", "submit"],
    ["Order", "purchase"],
    ["Заказать", "purchase"],
    ["Bestellen", "purchase"],
    ["Book →", "reserve"],
    ["Confirm.", "submit"],
    ["Submit ›", "submit"],
    ["Buy tickets", "purchase"],
    ["Book tickets", "reserve"],
    ["Continue to payment", "purchase"],
    ["Go to checkout", "purchase"],
    ["Забронирую", "reserve"],
    [`Select a time slot ${"word ".repeat(15)}Reserve table`, "reserve"],
  ])("%s -> %s", (label, kind) => {
    expect(commitKind(label)).toBe(kind);
  });

  it.each([
    "Booking.com", "Facebook", "Bookmark", "Notebook", "Reserved", "Reservations", "Payment methods", "Payments",
    "PayPal", "Add to cart", "Add to bag", "Add to basket", "Buying guide", "Ways to buy", "Search",
    "Мои бронирования", "Hotel Lumen 8.9 Reserve now, pay later", "Pay at the property", "Purchase history",
    "Reservation policy",
  ])("%s is not a candidate", (label) => {
    expect(commitKind(label)).toBeNull();
  });
});

const GOAL = "Find 3 restaurants with a free slot. Do not book; stop before checkout.";
const clickOn = (index = 4): BrowseStepResult => ({
  outcome: "act",
  operation: "CLICK",
  index,
  confidence: 0.9,
  model: "m",
  diag: { gates: [], tier: "jev" },
});
const reserveInput = (extra: Record<string, unknown> = {}) => ({
  goal: GOAL,
  url: "https://shop.example.com/r/1?x=1",
  title: "Restaurant",
  elements: [{ index: 4, tag: "button", label: "6:30 PM Reserve table", ops: ["CLICK" as const] }],
  ...extra,
});
const yes = (): Record<string, SystemOneAnswer> => ({ commit_check: choice("yes", 0.9, { probabilities: { yes: 0.9, no: 0.1 } }) });
const no = (): Record<string, SystemOneAnswer> => ({ commit_check: choice("no", 0.8, { probabilities: { yes: 0.2, no: 0.8 } }) });

function spy(answers: Record<string, SystemOneAnswer>, throwError?: Error) {
  const calls: unknown[] = [];
  return { calls, client: fakeClient(answers, { capture: (p) => calls.push(p), throwError }) };
}

describe("commitGuard (model-decided)", () => {
  it("blocks when the model says yes, with prefix and diag", async () => {
    const { client, calls } = spy(yes());
    const r = await commitGuard(client, reserveInput(), clickOn());
    expect(calls).toHaveLength(1);
    expect(r).toMatchObject({ outcome: "blocked", operation: "BLOCKED", confidence: 1, model: "m" });
    expect(r.reason?.startsWith('needs user confirmation: stopped before "6:30 PM Reserve table"')).toBe(true);
    expect(r.diag).toMatchObject({ tier: "rule", commitGuard: "reserve", commitGuardAnswer: "yes", commitGuardProbability: 0.9 });
  });

  it("sends a scrubbed goal, the label and the page host, not the full URL", async () => {
    const { client, calls } = spy(yes());
    await commitGuard(client, reserveInput({ goal: "Do not book. Mail me at bob@example.com" }), clickOn());
    const sent = JSON.stringify(calls[0]);
    expect(sent).not.toContain("bob@example.com");
    expect(sent).toContain("shop.example.com");
    expect(sent).not.toContain("?x=1");
    expect(sent).toContain("6:30 PM Reserve table");
  });

  it("passes the original result when the model says no", async () => {
    const { client } = spy(no());
    const original = clickOn();
    const r = await commitGuard(client, reserveInput(), original);
    expect(r).toMatchObject({ outcome: "act", operation: "CLICK", index: 4 });
    expect(r.diag).toMatchObject({ commitGuardAnswer: "no" });
  });

  it("fails closed on a thrown error and on a malformed answer", async () => {
    const thrown = spy({}, new Error("boom"));
    const a = await commitGuard(thrown.client, reserveInput(), clickOn());
    expect(a.outcome).toBe("blocked");
    expect(a.diag?.commitGuardAnswer).toBe("error");
    const bad = spy({ commit_check: choice("maybe", 0.9) });
    expect((await commitGuard(bad.client, reserveInput(), clickOn())).outcome).toBe("blocked");
    const missing = spy({});
    expect((await commitGuard(missing.client, reserveInput(), clickOn())).outcome).toBe("blocked");
  });

  it("never treats a click on a choice control as a commit candidate", async () => {
    const { client, calls } = spy(yes());
    const radio = reserveInput({
      elements: [{ index: 4, tag: "input", role: "radio", checked: false, label: "Buy $2,399.00 Pay with Apple Pay or other payment methods", ops: ["CLICK" as const] }],
    });
    const original = clickOn();
    expect(await commitGuard(client, radio, original)).toBe(original);
    const box = reserveInput({ elements: [{ index: 4, tag: "div", role: "Radio", label: "Buy It Now", ops: ["CLICK" as const] }] });
    expect(await commitGuard(client, box, original)).toBe(original);
    expect(calls).toHaveLength(0);
    const button = reserveInput({
      elements: [{ index: 4, tag: "button", label: "Buy $2,399.00 Pay with Apple Pay or other payment methods", ops: ["CLICK" as const] }],
    });
    await commitGuard(client, button, original);
    expect(calls).toHaveLength(1);
    const toggle = reserveInput({ elements: [{ index: 4, tag: "button", role: "switch", label: "Subscribe and pay $9.99/mo", ops: ["CLICK" as const] }] });
    await commitGuard(client, toggle, original);
    expect(calls).toHaveLength(2);
  });

  it("makes no client call on a prefilter miss", async () => {
    const { client, calls } = spy(yes());
    const input = reserveInput({ elements: [{ index: 4, tag: "button", label: "Add to bag", ops: ["CLICK" as const] }] });
    const original = clickOn();
    expect(await commitGuard(client, input, original)).toBe(original);
    expect(calls).toHaveLength(0);
  });

  it("makes no client call when confirmIrreversible is false", async () => {
    const { client, calls } = spy(yes());
    const original = clickOn();
    const r = await commitGuard(client, reserveInput({ permissions: { confirmIrreversible: false } }), original);
    expect(r).toBe(original);
    expect(calls).toHaveLength(0);
  });

  it("ignores non-act results, other operations and unknown indices", async () => {
    const { client, calls } = spy(yes());
    const wait: BrowseStepResult = { ...clickOn(), operation: "WAIT" };
    expect(await commitGuard(client, reserveInput(), wait)).toBe(wait);
    const blockedRes: BrowseStepResult = { ...clickOn(), outcome: "blocked" };
    expect(await commitGuard(client, reserveInput(), blockedRes)).toBe(blockedRes);
    const unknown = clickOn(99);
    expect(await commitGuard(client, reserveInput(), unknown)).toBe(unknown);
    expect(calls).toHaveLength(0);
  });
});

describe("commitGuard PRESS_ENTER", () => {
  const enter: BrowseStepResult = { outcome: "act", operation: "PRESS_ENTER", confidence: 0.9, model: "m" };
  const typed = (label: string) => [{ operation: "TYPE_TEXT", label, ok: true, index: 1 }];
  const form = (fieldLabel: string) => ({
    goal: "Look at the shop. Do not pay.",
    url: "https://shop.example.com/",
    title: "Shop",
    history: typed(fieldLabel),
    elements: [
      { index: 1, tag: "input", label: fieldLabel, ops: ["TYPE_TEXT" as const] },
      { index: 2, tag: "button", label: "Place order", ops: ["CLICK" as const] },
    ],
  });

  it("asks the model for a non-search field next to a commit button and blocks on yes", async () => {
    const { client, calls } = spy(yes());
    const r = await commitGuard(client, form("Email"), enter);
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0])).toContain("press Enter in the field");
    expect(r.reason).toContain("key press");
    expect(r.diag?.commitGuard).toBe("purchase");
  });

  it("ignores a choice control as the Enter submit candidate", async () => {
    const { client, calls } = spy(yes());
    const input = form("Email");
    input.elements = [
      input.elements[0]!,
      { index: 2, tag: "input", role: "radio", checked: false, label: "Buy $2,399.00 Pay with Apple Pay or other payment methods", ops: ["CLICK" as const] } as never,
    ];
    expect(await commitGuard(client, input, enter)).toBe(enter);
    expect(calls).toHaveLength(0);
  });

  it("lets Enter through when the model says no (a ZIP code box beside a header Checkout)", async () => {
    const { client } = spy(no());
    expect(await commitGuard(client, form("ZIP code"), enter)).toBe(enter);
  });

  it("skips the model for a search-like field or when no commit button exists", async () => {
    const { client, calls } = spy(yes());
    expect(await commitGuard(client, form("Search products"), enter)).toBe(enter);
    const noButton = { ...form("Email"), elements: [form("Email").elements[0]!] };
    expect(await commitGuard(client, noButton, enter)).toBe(enter);
    expect(calls).toHaveLength(0);
  });
});

describe("extractPasswordFromGoal", () => {
  it.each([
    ["password isabel77", "isabel77"],
    ["my password for the site is hunter2", "hunter2"],
    ["log in, password Secr3t!", "Secr3t!"],
    ['log in as me@x.com with password "hunter2"', "hunter2"],
    ["password: hunter2", "hunter2"],
    ["Пароль: s3cret.", "s3cret"],
    ["login with passwort «abc 123»", "abc 123"],
    ["log in and search for \"winter jacket\"", null],
    ["password me@x.com", null],
    ["no secrets here", null],
    ["Log in, password is: hunter2", "hunter2"],
    ["Log in and pass the onboarding quiz", null],
    ["Use the password manager entry", null],
    ['password: ""', null],
    ['password: "  "', null],
    ["passcode 1234", "1234"],
  ])("%s -> %s", (goal, expected) => {
    expect(extractPasswordFromGoal(goal)).toBe(expected);
  });
});

describe("redactGoalPassword", () => {
  it("replaces only the password value", () => {
    expect(redactGoalPassword('log in as me@x.com with password "hunter2" then search')).toBe(
      'log in as me@x.com with password "[password]" then search',
    );
    expect(redactGoalPassword("password: Secr3t!")).toBe("password: [password]");
    expect(redactGoalPassword("search for shoes")).toBe("search for shoes");
  });
});

describe("guard budget, reasons and secrecy", () => {
  const input = (extra: Record<string, unknown> = {}) => ({
    goal: "Do not book. password: hunter2",
    url: "https://shop.example.com/",
    title: "Shop",
    elements: [{ index: 4, tag: "button", label: "Reserve table", ops: ["CLICK" as const] }],
    ...extra,
  });
  const act = (): BrowseStepResult => ({ outcome: "act", operation: "CLICK", index: 4, confidence: 0.9, model: "m" });

  it("never sends the plaintext password to the model", async () => {
    const { client, calls } = spy(yes());
    await commitGuard(client, input(), act());
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0])).not.toContain("hunter2");
    expect(JSON.stringify(calls[0])).toContain("[password]");
  });

  it("fails closed with an honest reason on error", async () => {
    const { client } = spy({}, new Error("boom"));
    const r = await commitGuard(client, input(), act());
    expect(r.reason).toBe(
      'needs user confirmation: could not check whether "Reserve table" is allowed (check failed) — ask the user before this step',
    );
  });

  it("skips the model call and fails closed when under 1s of budget remains", async () => {
    const { client, calls } = spy(no());
    const r = await commitGuard(client, input(), act(), { timeoutMs: 999 });
    expect(calls).toHaveLength(0);
    expect(r.outcome).toBe("blocked");
    expect(r.diag?.commitGuardAnswer).toBe("error");
  });

  it("scrubs PII out of the label in the reason", async () => {
    const { client } = spy(yes());
    const els = [{ index: 4, tag: "button", label: "Reserve for bob@example.com", ops: ["CLICK" as const] }];
    const r = await commitGuard(client, input({ elements: els }), act());
    expect(r.reason).not.toContain("bob@example.com");
  });

  it("ignores a carried-over or failed TYPE_TEXT for the Enter guard", async () => {
    const { client, calls } = spy(yes());
    const enter: BrowseStepResult = { outcome: "act", operation: "PRESS_ENTER", confidence: 0.9, model: "m" };
    const els = [
      { index: 1, tag: "input", label: "Email", ops: ["TYPE_TEXT" as const] },
      { index: 2, tag: "button", label: "Place order", ops: ["CLICK" as const] },
    ];
    const carried = [{ operation: "TYPE_TEXT", label: 'TYPE_TEXT "x" into "Email" (earlier sub-goal)', ok: true, index: 1 }];
    const failed = [{ operation: "TYPE_TEXT", label: 'TYPE_TEXT "x" into "Email"', ok: false, index: 1 }];
    expect(await commitGuard(client, input({ elements: els, history: carried }), enter)).toBe(enter);
    expect(await commitGuard(client, input({ elements: els, history: failed }), enter)).toBe(enter);
    expect(calls).toHaveLength(0);
  });
});
