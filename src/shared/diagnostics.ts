// Where the console errors and failed requests of a tool output live, and the deduped lists that collect them.
// Shared by the QA step recorder (qaCore.ts) and the trace recorder (traceRecorder.ts). Zod-free, no imports.

/**
 * The objects of a parsed tool output that can hold `consoleErrors` and
 * `failedRequests` (and their `...Dropped` counters): the output itself, then
 * each entry of `results`. A batched `browse_act` (`actions`) has the lists in
 * each entry of `results` (the executor's `{ results, completed, ... }`).
 */
function diagnosticParts(output: Record<string, unknown>): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [output];
  if (!Array.isArray(output.results)) return parts;
  for (const entry of output.results) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) parts.push(entry as Record<string, unknown>);
  }
  return parts;
}

/** A deduped, first-seen-order list of strings that remembers at most `memory` distinct entries. */
export function createSeenList(memory: number, keep: number) {
  const seen = new Set<string>();
  const list: string[] = [];
  let lost = 0;
  return {
    /** Adds the new strings of `entries`. Returns the ones that were new and kept. */
    add(entries: unknown): string[] {
      const fresh: string[] = [];
      if (!Array.isArray(entries)) return fresh;
      for (const entry of entries) {
        if (typeof entry !== "string" || seen.has(entry)) continue;
        if (list.length >= memory) {
          lost += 1;
          continue;
        }
        seen.add(entry);
        list.push(entry);
        fresh.push(entry);
      }
      return fresh;
    },
    /** Adds the count of entries the controller left out of its own drain (`...Dropped`). */
    lose(n: unknown): void {
      if (typeof n === "number" && Number.isInteger(n) && n > 0) lost += n;
    },
    list: (): readonly string[] => list,
    kept: (): string[] => list.slice(0, keep),
    dropped: (): number => Math.max(0, list.length - keep) + lost,
  };
}

export type SeenList = ReturnType<typeof createSeenList>;

/**
 * Takes `consoleErrors` and `failedRequests` (and their `...Dropped` counters) from a tool output, a batched
 * `browse_act` included. Returns the entries that were new.
 */
export function harvestDiagnostics(output: Record<string, unknown>, consoleErrors: SeenList, failedRequests: SeenList): { consoleErrors: string[]; failedRequests: string[] } {
  const fresh = { consoleErrors: [] as string[], failedRequests: [] as string[] };
  for (const part of diagnosticParts(output)) {
    fresh.consoleErrors.push(...consoleErrors.add(part.consoleErrors));
    consoleErrors.lose(part.consoleErrorsDropped);
    fresh.failedRequests.push(...failedRequests.add(part.failedRequests));
    failedRequests.lose(part.failedRequestsDropped);
  }
  return fresh;
}
