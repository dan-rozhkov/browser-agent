import { describe, expect, it } from "vitest";
import { isIrreversibleLabel, isUnsafeCachedTarget } from "../../src/loop/actionCache.js";
import { COMMIT_LABEL_SAMPLES, commitKind } from "../../src/policy/browseCommitGuard.js";

/**
 * Pins the loop's action cache to the policy's commit-label prefilter: every
 * label the commit guard treats as a commit must never be cached or replayed,
 * since a replay skips the step policy and with it the guard. Moved here from
 * pen-editor's cross-repo `commitLabelContract.test.ts` — both sides now live
 * in this package.
 */
describe("commit label contract between loop and policy", () => {
  it("never caches or replays any commit-guard positive sample", () => {
    expect(COMMIT_LABEL_SAMPLES.positive.length).toBeGreaterThan(0);
    const mismatches = COMMIT_LABEL_SAMPLES.positive.filter(
      ([label]) =>
        commitKind(label) === null ||
        !isIrreversibleLabel(label) ||
        !isUnsafeCachedTarget("CLICK", label, undefined, undefined)
    );
    expect(mismatches).toEqual([]);
  });
});
