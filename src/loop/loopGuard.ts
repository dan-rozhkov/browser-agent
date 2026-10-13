/**
 * Loop guard for the MAIN agent's browse_* calls (browse-speed-contract.md,
 * "Frontend" item 5 — the Hermes tool_guardrails lesson: an agent that keeps
 * repeating an unproductive call needs to be TOLD, or it burns its whole
 * budget on a call that can never produce something new). Not the
 * browse_task loop's own stall detection (browseTask.ts's
 * MAX_CONSECUTIVE_UNPRODUCTIVE_STEPS) — this guards the top-level model's
 * own browse_* tool calls, one call at a time, across the whole chat turn.
 *
 * Keeps a small ring of recent (toolName, canonical args, result hash)
 * entries per chat session (keyed by `ToolExecutionContext.sessionId` when
 * a caller has one — see toolRegistry.ts's wrapping), falling back to a
 * single module-level ring when it's absent (a direct MCP bridge call has
 * no chat session). When the ring shows either of two patterns — the same
 * call landing the same result 3 times in a row, or an A,B,A,B cycle of two
 * different idempotent reads each landing the same result twice — a
 * `loopWarning` field is appended to the returned JSON telling the model to
 * change approach, rather than silently letting it repeat forever.
 */

const RING_SIZE = 4;
const CONSECUTIVE_THRESHOLD = 3;

interface LoopGuardEntry {
  toolName: string;
  argsKey: string;
  resultHash: string;
}

/**
 * browse_* tools whose call mutates page/tab state, as opposed to a pure
 * read (browse_snapshot/browse_read/browse_find_images/browse_screenshot,
 * and browse_tabs with the non-mutating `list` action). Only used to decide
 * whether a call that landed something genuinely NEW should reset the ring
 * (see `applyLoopGuard`) — once real progress happens, stale entries from
 * before it must not linger to falsely pattern-match against calls that
 * come after.
 */
const MUTATING_TOOLS = new Set(["browse_act", "browse_open", "browse_task"]);

function isMutatingCall(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName === "browse_tabs") {
    return args.action !== "list";
  }
  return MUTATING_TOOLS.has(toolName);
}

/**
 * Deterministic, dependency-free 32-bit hash (FNV-1a) over an arbitrary
 * string. Good enough to distinguish result payloads for loop detection, or
 * (combined with itself twice, forward and reversed) cache keys in
 * actionCache.ts — neither is a security use, so collisions merely mean an
 * occasional false "same result"/cache key, which is the safe direction for
 * both call sites (a loop-guard false positive is just a nudge; a cache-key
 * collision is caught by actionCache.ts's separate `verify` check before
 * ever being trusted — see that module's header comment). Exported so
 * actionCache.ts can reuse this instead of duplicating the algorithm
 * (check:dup).
 */
export function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Strips every `snapshotId` key (recursively, at any depth — including
 * `resolved.snapshotId` and the whole attached `snapshot` object's own
 * field) from a parsed result before it is hashed. Finding: browse_act/
 * browse_open/browse_snapshot results now carry a fresh, randomly-generated
 * snapshotId on every call (browse-speed-contract.md's snapshot-attach
 * follow-up), so two calls that are otherwise IDENTICAL — same args, same
 * matched element, same page — never hashed equal, and the loop guard could
 * never actually fire for them. Everything else in the result (element
 * lists, `matched`, `changed`, error text, ...) is kept: it genuinely
 * reflects the page, so it's exactly what should still distinguish one
 * result from another.
 */
function stripSnapshotIds(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripSnapshotIds);
  }
  if (value && typeof value === "object") {
    const stripped: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (key === "snapshotId") continue;
      stripped[key] = stripSnapshotIds(val);
    }
    return stripped;
  }
  return value;
}

/**
 * Hashes a browse_* handler's JSON-string result after normalizing away
 * volatile `snapshotId` fields (see `stripSnapshotIds`). Falls back to
 * hashing the raw string when it isn't valid JSON — still deterministic,
 * just without the normalization (nothing to strip from a non-object
 * result anyway).
 */
function normalizedResultHash(resultStr: string): string {
  try {
    const parsed: unknown = JSON.parse(resultStr);
    return hashString(JSON.stringify(stripSnapshotIds(parsed)));
  } catch {
    return hashString(resultStr);
  }
}

/** Stable stringify (sorted keys) so `{a:1,b:2}` and `{b:2,a:1}` compare
 * equal — an LLM's tool-call argument order is not meaningful. */
function canonicalArgsKey(args: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(args).sort()) {
    sorted[key] = args[key];
  }
  return JSON.stringify(sorted);
}

function entriesEqual(a: LoopGuardEntry, b: LoopGuardEntry): boolean {
  return a.toolName === b.toolName && a.argsKey === b.argsKey && a.resultHash === b.resultHash;
}

const chatRings = new Map<string, LoopGuardEntry[]>();
let moduleRing: LoopGuardEntry[] = [];

function getRing(chatId: string | undefined): LoopGuardEntry[] {
  if (!chatId) return moduleRing;
  return chatRings.get(chatId) ?? [];
}

function setRing(chatId: string | undefined, ring: LoopGuardEntry[]): void {
  if (!chatId) {
    moduleRing = ring;
  } else {
    chatRings.set(chatId, ring);
  }
}

/**
 * Clears the ring for `chatId` (or the module-level ring when omitted) — for
 * a caller that knows a new chat/session has started and wants a clean
 * slate immediately, rather than waiting for unrelated calls to dilute it.
 */
export function resetLoopGuard(chatId?: string): void {
  setRing(chatId, []);
}

/** True when the ring's last 3 entries are all the same call+result, or the
 * last 4 form an A,B,A,B cycle of two DIFFERENT calls (A≠B) each repeated
 * once. */
function detectLoop(ring: LoopGuardEntry[]): boolean {
  if (ring.length >= CONSECUTIVE_THRESHOLD) {
    const tail = ring.slice(-CONSECUTIVE_THRESHOLD);
    if (tail.every((entry) => entriesEqual(entry, tail[0]))) return true;
  }
  if (ring.length >= 4) {
    const [a, b, c, d] = ring.slice(-4);
    if (entriesEqual(a, c) && entriesEqual(b, d) && !entriesEqual(a, b)) return true;
  }
  return false;
}

/**
 * Records this browse_* call + result in the loop-guard ring, and — when it
 * completes a loop pattern (see `detectLoop`) — appends a `loopWarning`
 * field to the result. Returns `resultStr` untouched otherwise, or always
 * when the result isn't a JSON object (nothing sensible to merge a field
 * into). `args` should be the raw tool-call arguments (pre-handler); `chatId`
 * should be `ToolExecutionContext.sessionId` when the caller has one.
 */
export function applyLoopGuard(
  toolName: string,
  args: Record<string, unknown>,
  resultStr: string,
  chatId?: string
): string {
  const entry: LoopGuardEntry = {
    toolName,
    argsKey: canonicalArgsKey(args),
    resultHash: normalizedResultHash(resultStr),
  };

  const previousRing = getRing(chatId);
  const previous = previousRing[previousRing.length - 1];
  const mutating = isMutatingCall(toolName, args);

  // A mutating call landing a genuinely different result means real
  // progress happened — start the ring over with just this call so entries
  // from before it can't pattern-match against calls that come after.
  const ring =
    mutating && previous && !entriesEqual(previous, entry)
      ? [entry]
      : [...previousRing, entry].slice(-RING_SIZE);
  setRing(chatId, ring);

  if (!detectLoop(ring)) {
    return resultStr;
  }

  try {
    const parsed: unknown = JSON.parse(resultStr);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify({
        ...parsed,
        loopWarning:
          "You have made this exact call multiple times with the same result; change approach (different element, scroll, read, or ask the user).",
      });
    }
  } catch {
    // Not JSON — nothing to merge a field into, pass through untouched.
  }
  return resultStr;
}
