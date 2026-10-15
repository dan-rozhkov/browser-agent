// Fixture setup for a browse run: applies a PageFixture through the bridge and
// owns the release of what the apply installed (network mocks). Zod-free,
// `ai`-free and isomorphic, so a host that drives `createBrowseAgentSession`
// itself (Pen Editor's frontend) uses the same logic as `runBrowseAgent`.
import type { BrowserBridge } from "../loop/bridge.js";
import type { PageFixture } from "../fixture/types.js";
import { fixtureSetupBody } from "./result.js";
import { SetupError } from "./session.js";

const DEFAULT_RELEASE_TIMEOUT_MS = 10_000;

export interface FixtureSetupOptions {
  /** Host gate for `fixture.network`; passed to `applyFixture`. */
  allowNetworkMocks: boolean;
  /** Snapshot of the page after the apply, as the model-safe text the tool gives. */
  snapshot: () => Promise<unknown>;
  /** Called after a successful apply, only if `release()` has not been called yet. */
  onApplied?: (info: { mockCount: number }) => void;
  /** Bound for one `releaseFixture` call. Default 10 s. */
  releaseTimeoutMs?: number;
}

export interface FixtureSetup {
  /** The `setup` hook of `BrowseAgentRunOptions`. */
  setup: (ctx: { signal: AbortSignal }) => Promise<string>;
  /**
   * Call it in `finally`. Idempotent, never throws, bounded. Releases the token
   * of this setup's apply. When the apply is still in flight (the run was
   * aborted and the bridge cannot cancel), it does not wait: the token is
   * released as soon as the apply resolves, and `onApplied` is not called.
   * No-op when `setup` never ran.
   */
  release: () => Promise<void>;
}

export function createFixtureSetup(browser: BrowserBridge, fixture: PageFixture, opts: FixtureSetupOptions): FixtureSetup {
  const timeoutMs = opts.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS;
  let released = false;
  let token: string | undefined;

  /** Bounded: a bridge that hangs must not hold the result of a finished run. */
  async function releaseToken(t: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => browser.releaseFixture?.(t)),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
    } catch {
      // A failed release cannot change the result of the run.
    } finally {
      clearTimeout(timer);
    }
  }

  async function setup({ signal }: { signal: AbortSignal }): Promise<string> {
    if (!browser.applyFixture) throw new SetupError(undefined, "This browser does not support page fixtures (BrowserBridge.applyFixture is missing).");
    const mockCount = fixture.network?.length ?? 0;
    // Refuse rather than leak mocks: nobody could remove them.
    if (mockCount > 0 && !browser.releaseFixture) {
      throw new SetupError("network", "This browser cannot release network mocks (BrowserBridge.releaseFixture is missing).");
    }
    const raw = await browser.applyFixture(fixture, { signal, allowNetworkMocks: opts.allowNetworkMocks });
    const applied: Record<string, unknown> = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    // Only `summary` (counts), `stage`, `error` and `fixtureToken` (no cookie, storage or mock data) are read from the result.
    if (applied.ok !== true) {
      throw new SetupError(typeof applied.stage === "string" ? applied.stage : undefined, typeof applied.error === "string" ? applied.error : "The page fixture could not be applied.");
    }
    if (typeof applied.fixtureToken === "string") {
      const applyToken = applied.fixtureToken;
      token = applyToken;
      if (released) {
        // The run is over (abort or deadline) and `release()` did not see this token: release it now.
        await releaseToken(applyToken);
        return "";
      }
    }
    if (released) return "";
    opts.onApplied?.({ mockCount });
    const summary = typeof applied.summary === "string" ? applied.summary : "page fixture applied";
    const snap = await opts.snapshot();
    return fixtureSetupBody(summary, typeof snap === "string" ? snap : JSON.stringify(snap));
  }

  async function release(): Promise<void> {
    if (released) return;
    released = true;
    // The token of THIS setup only: never a newer run's mocks.
    if (token !== undefined) await releaseToken(token);
  }

  return { setup, release };
}
