import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedCall, withTimeout } from "../../src/fixture/util.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("boundedCall", () => {
  it("returns the value when the call settles first, and clears its timer", async () => {
    vi.useFakeTimers();
    const out = await boundedCall(() => Promise.resolve(7), 1_000);
    expect(out).toEqual({ done: true, value: 7 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns done:false when the timer wins; a late answer is dropped and a late rejection is not unhandled", async () => {
    vi.useFakeTimers();
    let rejectLate!: (e: Error) => void;
    const slow = new Promise<number>((_, reject) => { rejectLate = reject; });
    const pending = boundedCall(() => slow, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual({ done: false });
    const unhandled = vi.fn();
    process.once("unhandledRejection", unhandled);
    rejectLate(new Error("late"));
    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a rejection before the timer rejects, a synchronous throw too, and the timer is cleared", async () => {
    vi.useFakeTimers();
    await expect(boundedCall(() => Promise.reject(new Error("boom")), 1_000)).rejects.toThrow("boom");
    await expect(boundedCall(() => { throw new Error("sync"); }, 1_000)).rejects.toThrow("sync");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs the call at once (in the same tick)", () => {
    let called = false;
    void boundedCall(() => { called = true; return 1; }, 10);
    expect(called).toBe(true);
  });
});

describe("withTimeout", () => {
  it("resolves, rejects with the message after ms, and turns a non-Error rejection into an Error", async () => {
    vi.useFakeTimers();
    expect(await withTimeout(Promise.resolve("ok"), 100, "late")).toBe("ok");
    const timed = withTimeout(new Promise<void>(() => {}), 100, "too slow");
    const caught = expect(timed).rejects.toThrow("too slow");
    await vi.advanceTimersByTimeAsync(100);
    await caught;
    await expect(withTimeout(Promise.reject("plain text"), 100, "late")).rejects.toThrow("plain text");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts a function and calls it at once", async () => {
    expect(await withTimeout(() => 5, 100, "late")).toBe(5);
  });
});
