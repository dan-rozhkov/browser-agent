import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpBackend } from "../../src/adapters/httpBackend.js";

type FetchLike = typeof fetch;

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createHttpBackend", () => {
  it.each([
    ["without a trailing slash", "https://api.test"],
    ["with a trailing slash", "https://api.test/"],
  ])("joins baseUrl %s and the path into one URL", async (_name, baseUrl) => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({}));
    await createHttpBackend({ baseUrl, fetch: fetchMock }).request("/api/browse/step", {}, { timeoutMs: 1000 });
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://api.test/api/browse/step");
  });

  it("keeps a path prefix in baseUrl", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({}));
    await createHttpBackend({ baseUrl: "https://api.test/v1/", fetch: fetchMock }).request(
      "/api/browse/plan",
      {},
      { timeoutMs: 1000 }
    );
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://api.test/v1/api/browse/plan");
  });

  it("POSTs the JSON body with a JSON content type and the extra headers", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ outcome: "done" }));
    const backend = createHttpBackend({ baseUrl: "https://api.test", fetch: fetchMock, headers: { Authorization: "Bearer t" } });
    const res = await backend.request("/api/browse/step", { goal: "g" }, { timeoutMs: 1000 });

    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ goal: "g" });
    expect(init.headers).toEqual({ Authorization: "Bearer t", "Content-Type": "application/json" });
    expect(res).toEqual({ status: 200, ok: true, body: { outcome: "done" } });
  });

  it("passes credentials to fetch (value or per-request function), omits it when unset", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({}));
    await createHttpBackend({ baseUrl: "https://api.test", fetch: fetchMock, credentials: "include" }).request(
      "/api/browse/step", {}, { timeoutMs: 1000 });
    let mode: RequestCredentials | undefined = "include";
    const fn = createHttpBackend({ baseUrl: "https://api.test", fetch: fetchMock, credentials: () => mode });
    await fn.request("/api/browse/step", {}, { timeoutMs: 1000 });
    mode = undefined;
    await fn.request("/api/browse/step", {}, { timeoutMs: 1000 });
    await createHttpBackend({ baseUrl: "https://api.test", fetch: fetchMock }).request(
      "/api/browse/step", {}, { timeoutMs: 1000 });
    expect(fetchMock.mock.calls[0]![1]!.credentials).toBe("include");
    expect(fetchMock.mock.calls[1]![1]!.credentials).toBe("include");
    expect(fetchMock.mock.calls[2]![1]).not.toHaveProperty("credentials");
    expect(fetchMock.mock.calls[3]![1]).not.toHaveProperty("credentials");
  });

  it("calls a headers function once per request", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({}));
    let n = 0;
    const backend = createHttpBackend({ baseUrl: "https://api.test", fetch: fetchMock, headers: () => ({ "X-N": String(++n) }) });
    await backend.request("/api/browse/step", {}, { timeoutMs: 1000 });
    await backend.request("/api/browse/step", {}, { timeoutMs: 1000 });
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>)["X-N"]).toBe("1");
    expect((fetchMock.mock.calls[1]![1]!.headers as Record<string, string>)["X-N"]).toBe("2");
  });

  it("uses globalThis.fetch when none is injected", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ ok: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await createHttpBackend({ baseUrl: "https://api.test" }).request("/api/browse/locate", {}, { timeoutMs: 1000 });
      expect(res.body).toEqual({ ok: 1 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports a non-JSON body as body: null (status and ok kept)", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => new Response("<html>bad gateway</html>", { status: 502 }));
    const res = await createHttpBackend({ baseUrl: "https://api.test", fetch: fetchMock }).request("/api/browse/step", {}, { timeoutMs: 1000 });
    expect(res).toEqual({ status: 502, ok: false, body: null });
  });

  it("parses Retry-After into retryAfterSec", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({}, { status: 429, headers: { "Retry-After": "5" } }));
    const res = await createHttpBackend({ baseUrl: "https://api.test", fetch: fetchMock }).request("/api/browse/step", {}, { timeoutMs: 1000 });
    expect(res.status).toBe(429);
    expect(res.retryAfterSec).toBe(5);
  });

  it.each([["not-a-number"], ["-3"], [""]])("ignores an unusable Retry-After (%j)", async (value) => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({}, { status: 503, headers: { "Retry-After": value } }));
    const res = await createHttpBackend({ baseUrl: "https://api.test", fetch: fetchMock }).request("/api/browse/step", {}, { timeoutMs: 1000 });
    expect(res).not.toHaveProperty("retryAfterSec");
  });

  it("aborts the request when timeoutMs elapses", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<FetchLike>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new Error("aborted")));
        })
    );
    const pending = createHttpBackend({ baseUrl: "https://api.test", fetch: fetchMock }).request("/api/browse/step", {}, { timeoutMs: 500 });
    const assertion = expect(pending).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(501);
    await assertion;
  });

  it("the timeout also bounds a body that stalls after the headers arrived", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<FetchLike>(async (_url, init) => {
      const res = {
        status: 200,
        ok: true,
        headers: new Headers(),
        json: () =>
          new Promise<unknown>((_resolve, reject) => {
            init!.signal!.addEventListener("abort", () => reject(new Error("body aborted")));
          }),
      };
      return res as unknown as Response;
    });
    const pending = createHttpBackend({ baseUrl: "https://api.test", fetch: fetchMock }).request("/api/browse/step", {}, { timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(501);
    // The stalled parse is aborted and reported as a non-JSON body, not hung.
    await expect(pending).resolves.toEqual({ status: 200, ok: true, body: null });
  });

  it("aborts when the caller's signal aborts, and when it is already aborted", async () => {
    const fetchMock = vi.fn<FetchLike>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          if (init!.signal!.aborted) reject(new Error("aborted"));
          init!.signal!.addEventListener("abort", () => reject(new Error("aborted")));
        })
    );
    const backend = createHttpBackend({ baseUrl: "https://api.test", fetch: fetchMock });

    const ac = new AbortController();
    const pending = backend.request("/api/browse/step", {}, { timeoutMs: 60_000, signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toThrow("aborted");

    await expect(backend.request("/api/browse/step", {}, { timeoutMs: 60_000, signal: ac.signal })).rejects.toThrow("aborted");
  });
});
