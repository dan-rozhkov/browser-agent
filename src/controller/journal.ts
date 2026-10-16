// The checkpoint journal's state (docs/specs/2026-10-16-checkpoint-design.md):
// per tab, a base state read at the last new document + the deterministic steps
// recorded since. Pure bookkeeping, no browser access: `BrowserController`
// reads the page and feeds these classes. Isomorphic.
import { CHECKPOINT_GAPS, summarizeCheckpoint } from "../fixture/checkpoint.js";
import { CHECKPOINT_MAX_STEPS, type CheckpointJournalOptions, type FixtureCookie, type FixtureOrigin, type FixtureStep, type PageFixture } from "../fixture/types.js";
import { httpOrigin } from "../fixture/util.js";
import type { BrowserPageHandle } from "./controller.js";

/**
 * What an action staged before it ran: the steps to record when it succeeds
 * (a `waitFor` for the target, then the action), or why it cannot be recorded.
 */
export type StagedAction = { steps: FixtureStep[] } | { gap: string };

export interface JournalBase {
  /**
   * The marker of the document the base was read from (see DOC_MARKER_JS).
   * `null`: it could not be planted, so a new document cannot be told apart.
   */
  marker: string | null;
  /** The page URL as it was (hash kept), the start page of the checkpoint. */
  url: string;
  cookies: FixtureCookie[];
  origins: FixtureOrigin[];
  /**
   * Steps that come BEFORE the journal's own: those of an applied fixture
   * (`applyFixture` makes the fixture the base). They are not counted toward
   * `CHECKPOINT_MAX_STEPS`: the cap bounds what the agent recorded.
   */
  steps?: FixtureStep[];
  /** The base is an applied `fresh` fixture: the checkpoint says `fresh: true`, so a replay starts from an empty session too. */
  fresh?: boolean;
}

/** The journal of ONE tab. */
export class CheckpointJournal {
  base: JournalBase | null = null;
  steps: FixtureStep[] = [];
  /** Recorded actions (not the `waitFor` steps before them): what the cap counts. */
  actions = 0;
  complete = true;
  gap: string | undefined;

  /** A new document: drop the steps and the gap, take a new base. */
  reset(base: JournalBase, readFailed: boolean): void {
    this.base = base;
    this.steps = [];
    this.actions = 0;
    this.complete = !readFailed;
    this.gap = readFailed ? CHECKPOINT_GAPS.base : undefined;
  }

  /** The first gap stays: recording stops there until the next reset. */
  addGap(reason: string): void {
    if (!this.complete) return;
    this.complete = false;
    this.gap = reason;
  }

  /** Records a staged action after its command succeeded. A stopped journal (a gap) records nothing. */
  record(action: StagedAction): void {
    if (!this.complete) return;
    if ("gap" in action) {
      this.addGap(action.gap);
      return;
    }
    if (this.actions >= CHECKPOINT_MAX_STEPS) {
      this.addGap(CHECKPOINT_GAPS.cap);
      return;
    }
    this.steps.push(...action.steps);
    this.actions += action.steps.filter((s) => s.action !== "waitFor").length;
  }

  /** The checkpoint as a PageFixture. `tabs` are the URLs of the other tabs. */
  build(tabs: string[]): { fixture: PageFixture; complete: boolean; gap?: string; summary: string } {
    const fixture: PageFixture = { version: 1 };
    const base = this.base;
    if (base && httpOrigin(base.url)) fixture.url = base.url;
    if (base?.fresh) fixture.fresh = true;
    const others = tabs.filter((t) => httpOrigin(t));
    if (others.length > 0) fixture.tabs = others;
    const cookies = base?.cookies ?? [];
    const origins = base?.origins ?? [];
    if (cookies.length > 0 || origins.length > 0) {
      fixture.storage = { ...(cookies.length > 0 ? { cookies } : {}), ...(origins.length > 0 ? { origins } : {}) };
    }
    const all = [...(base?.steps ?? []), ...this.steps];
    if (all.length > 0) fixture.steps = all.map((s) => ({ ...s }));
    let complete = this.complete;
    let gap = this.gap;
    // Steps on a base without an http(s) URL cannot be replayed (there is no page to start them on).
    if (complete && base && !fixture.url && all.length > 0) {
      complete = false;
      gap = CHECKPOINT_GAPS.noStartUrl;
    }
    return { fixture, complete, ...(gap !== undefined ? { gap } : {}), summary: summarizeCheckpoint(fixture, complete, gap) };
  }
}

/**
 * One command's claim on the journal. A stage or a settle from a command that
 * is not the current one is ignored: a timed-out command keeps running, and its
 * late `journalStage` must not overwrite the next command's staged step.
 * Only `JournalSession` writes these fields (`declare`, `stage`, `markTimedOut`,
 * `markPreOverrun`, `skipSettle`): one owner.
 */
export interface JournalCommand {
  /** The tab and what the command staged (set once; a stale command cannot set it). */
  staged: { page: BrowserPageHandle; action: StagedAction } | null;
  /** The command declared an action (it asked to stage): a timeout is a gap even before it staged. */
  expectsAction: boolean;
  /** The tab the action runs on. */
  actedPage: BrowserPageHandle | null;
  timedOut: boolean;
  /** The command may change the page (it declared something): only then are sync and settle run. */
  mutating: boolean;
  /** A back or forward: a move inside the same document is a gap, a new document a reset. */
  history: boolean;
  /** Set for a command that changes lasting page state no step can replay (a hover): its success is this gap. */
  successGap: string | undefined;
  /** A navigation (open, reload, tabs): the URL of the tab it started on. A changed URL inside the same document is a gap. */
  navUrlBefore: string | undefined;
  /** The sync before the action ran out of its budget: the tab's state is unknown even if it has no journal yet. */
  preOverrun: boolean;
}

/** What a command declares to the journal (see `JournalSession.declare`). */
export type JournalDeclareKind = "action" | "nav" | "history" | "hover";

/** All tabs' journals. The journal follows the current tab; a tab keeps its own. */
export class JournalSession {
  readonly opts: CheckpointJournalOptions;
  /** Who owns this journal: `startJournal` returns it, `stopJournal` and `captureCheckpoint` check it. */
  readonly token: string;
  private readonly tabs = new WeakMap<BrowserPageHandle, CheckpointJournal>();
  /** The command that runs now; null between commands. */
  current: JournalCommand | null = null;

  constructor(opts: CheckpointJournalOptions = {}, token = "") {
    this.token = token;
    this.opts = { ...(opts.origins ? { origins: [...opts.origins] } : {}) };
  }

  begin(): JournalCommand {
    const command: JournalCommand = {
      staged: null,
      expectsAction: false,
      actedPage: null,
      timedOut: false,
      mutating: false,
      history: false,
      successGap: undefined,
      navUrlBefore: undefined,
      preOverrun: false,
    };
    this.current = command;
    return command;
  }

  /** After this, a late call of `command` changes nothing. */
  end(command: JournalCommand): void {
    if (this.current === command) this.current = null;
  }

  /**
   * A command says it may change the page (the only writer of `mutating`).
   * `action`: it will stage a step on `page`. `nav`: open, reload, tabs (`url`: where `page` is now).
   * `history`: back or forward. `hover`: lasting state no step can replay.
   * A nested command (a fixture's `open`) keeps the outer command's page.
   */
  declare(command: JournalCommand, kind: JournalDeclareKind, page: BrowserPageHandle | null, url?: string): void {
    if (this.current !== command) return;
    command.mutating = true;
    if (kind === "action") {
      if (!page) return;
      command.expectsAction = true;
      command.actedPage = page;
      return;
    }
    command.actedPage ??= page;
    if (kind === "nav") command.navUrlBefore ??= url;
    else if (kind === "history") command.history = true;
    else command.successGap = CHECKPOINT_GAPS.hover;
  }

  /** The command made the base itself (`applyFixture`): the settle step must not re-check the page. */
  skipSettle(command: JournalCommand): void {
    command.mutating = false;
  }

  /** The command ran past its budget. */
  markTimedOut(command: JournalCommand): void {
    command.timedOut = true;
  }

  /** The sync before the command's action ran out of its own budget. */
  markPreOverrun(command: JournalCommand): void {
    command.preOverrun = true;
  }

  /** Stages for `command` when it is still the current one. Returns whether it was. */
  stage(command: JournalCommand, page: BrowserPageHandle, action: StagedAction): boolean {
    if (this.current !== command) return false;
    command.staged = { page, action };
    return true;
  }

  forPage(page: BrowserPageHandle): CheckpointJournal | undefined {
    return this.tabs.get(page);
  }

  /** The tab's journal (created empty when the tab is new to the journal). */
  ensure(page: BrowserPageHandle): CheckpointJournal {
    let journal = this.tabs.get(page);
    if (!journal) {
      journal = new CheckpointJournal();
      this.tabs.set(page, journal);
    }
    return journal;
  }
}
