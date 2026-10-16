// Checkpoint helpers shared by the controller journal and the tests: gap
// texts and the model-safe summary. Isomorphic and zod-free. Design:
// docs/specs/2026-10-16-checkpoint-design.md
import { CHECKPOINT_MAX_STEPS, type FixtureCookie, type FixtureOrigin, type PageFixture } from "./types.js";
import { fixtureStateParts, plural } from "./util.js";

/** Reasons a journal cannot record a step. They hold no selector, URL or value: safe for a model. */
export const CHECKPOINT_GAPS = {
  iframe: "an action targeted an element inside an iframe",
  noSelector: "an action targeted an element without a unique selector",
  unsupported: "an action targeted an element that a checkpoint cannot replay",
  cap: `more than ${CHECKPOINT_MAX_STEPS} steps since the last new document`,
  base: "the base state of the page could not be read",
  timeout: "a command timed out, so its effect on the page is unknown",
  failed: "a command failed after it may have changed the page",
  retargeted: "typed text went into a different element than the one targeted",
  unknownDocument: "the page could not be checked for a reload or a new document",
  fixtureFailed: "a page fixture failed to apply, so the page may hold state the checkpoint lacks",
  fixtureNoUrl: "a page fixture with steps and no start URL was applied, so its steps cannot be replayed",
  noStartUrl: "the base page has no http(s) URL, so the recorded steps cannot be replayed",
  history: "history navigation inside the page cannot be replayed",
  hover: "a hover cannot be replayed",
  sameDocumentNav: "navigation inside the page cannot be replayed",
  optionNotUnique: "a select option has no unique value",
} as const;

/**
 * Counts, step kinds and origin + pathname only: no cookie, storage key or
 * value, no selector, no typed text. Says how many ACTIONS replay: the
 * `waitFor` steps the journal adds before each action are not counted.
 */
export function summarizeCheckpoint(fixture: PageFixture, complete: boolean, gap?: string): string {
  const parts = fixtureStateParts(fixture);
  const actions = (fixture.steps ?? []).filter((s) => s.action !== "waitFor");
  const kinds = new Map<string, number>();
  for (const step of actions) kinds.set(step.action, (kinds.get(step.action) ?? 0) + 1);
  const detail = [...kinds].map(([kind, n]) => `${n} ${kind}`).join(", ");
  parts.push(`${plural(actions.length, "replayable step")}${detail ? ` (${detail})` : ""}`);
  if (!complete) parts.push(`incomplete: ${gap ?? "a step is missing"}`);
  return `checkpoint: ${parts.join("; ")}`;
}

/**
 * name + domain + path, with the domain in its exact form: `.a.test` (a domain
 * cookie, sent to subdomains too) and `a.test` (host-only) are two cookies in a
 * jar. A cookie given by `url` is host-only, so it is keyed by the host.
 */
function cookieKey(c: FixtureCookie): string {
  let domain = c.domain;
  if (domain === undefined && c.url) {
    try {
      domain = new URL(c.url).hostname;
    } catch {
      domain = c.url;
    }
  }
  return `${c.name}\u0000${(domain ?? "").toLowerCase()}\u0000${c.path ?? "/"}`;
}

/**
 * The state a fixture leaves behind when it is applied on top of `pre` (no
 * `fresh`): the fixture wins per cookie (name + domain + path) and per storage
 * key; whatever else `pre` held stays. Pure.
 */
export function mergeStorage(
  pre: { cookies: FixtureCookie[]; origins: FixtureOrigin[] },
  fixture: PageFixture["storage"],
): { cookies: FixtureCookie[]; origins: FixtureOrigin[] } {
  const cookies = new Map<string, FixtureCookie>();
  for (const c of pre.cookies) cookies.set(cookieKey(c), c);
  for (const c of fixture?.cookies ?? []) cookies.set(cookieKey(c), c);
  const origins = new Map<string, FixtureOrigin>();
  for (const o of pre.origins) origins.set(o.origin, { origin: o.origin, ...(o.localStorage ? { localStorage: { ...o.localStorage } } : {}), ...(o.sessionStorage ? { sessionStorage: { ...o.sessionStorage } } : {}) });
  for (const o of fixture?.origins ?? []) {
    const had = origins.get(o.origin);
    const local = { ...had?.localStorage, ...o.localStorage };
    const session = { ...had?.sessionStorage, ...o.sessionStorage };
    origins.set(o.origin, {
      origin: o.origin,
      ...(Object.keys(local).length > 0 ? { localStorage: local } : {}),
      ...(Object.keys(session).length > 0 ? { sessionStorage: session } : {}),
    });
  }
  return { cookies: [...cookies.values()], origins: [...origins.values()] };
}
