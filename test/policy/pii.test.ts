import { describe, expect, it } from "vitest";
import { scrubPii, containsPii, findPiiSpans } from "../src/analysis/pii.js";

describe("scrubPii", () => {
  it("replaces emails", () => {
    expect(scrubPii("contact john.doe+x@example.com please")).toBe(
      "contact [EMAIL] please",
    );
  });
  it("replaces phone numbers", () => {
    expect(scrubPii("call +7 (912) 345-67-89 now")).toBe("call [PHONE] now");
  });
  it("replaces API keys/tokens", () => {
    expect(scrubPii("use sk-abcdefghij1234567890abcd")).toBe("use [TOKEN]");
    expect(scrubPii("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345")).toBe("[TOKEN]");
  });
  it("replaces AWS access key IDs", () => {
    expect(scrubPii("key AKIAIOSFODNN7EXAMPLE here")).toBe("key [TOKEN] here");
  });
  it("replaces Google API keys", () => {
    expect(scrubPii(`use AIza${"Sy".repeat(17)}Q`)).toBe("use [TOKEN]");
  });
  it("replaces GitHub fine-grained tokens", () => {
    expect(
      scrubPii(`github_pat_11ABCDEFG0${"x".repeat(59)} end`),
    ).toBe("[TOKEN] end");
  });
  it("does not redact a plain 20-char uppercase word", () => {
    const text = "ABCDEFGHIJKLMNOPQRST is fine";
    expect(scrubPii(text)).toBe(text);
  });
  it("replaces credentials embedded in URLs, keeping the scheme", () => {
    expect(scrubPii("https://user:pass@db.example.com/x")).toBe(
      "https://[CREDENTIALS]@db.example.com/x",
    );
  });
  it("drops base64 data URLs entirely", () => {
    const dataUrl = `data:image/png;base64,${"A".repeat(200)}`;
    expect(scrubPii(`img ${dataUrl} end`)).toBe("img [DATA_URL] end");
  });
  it("replaces long high-entropy blobs", () => {
    expect(scrubPii(`x ${"Qq1".repeat(30)} y`)).toBe("x [BLOB] y");
  });
  it("leaves normal design-agent text untouched", () => {
    const text =
      "User asked to create a 3-column pricing frame; batch_design failed with 'Too many operations (30)'.";
    expect(scrubPii(text)).toBe(text);
    expect(containsPii(text)).toBe(false);
  });
});

describe("containsPii", () => {
  it("detects PII", () => {
    expect(containsPii("mail me at a@b.co")).toBe(true);
  });
});

// browseStep.ts's extractTextCandidates (review finding #1) locates PII
// spans in the RAW goal to drop any candidate that overlaps one without
// being it — these assert the span itself lands on the exact PII substring,
// not merely somewhere in the string.
describe("findPiiSpans", () => {
  it("locates an email span at its exact offset", () => {
    const text = "mail me at a@b.co please";
    const spans = findPiiSpans(text);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ kind: "email" });
    expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe("a@b.co");
  });

  it("locates a phone span at its exact offset", () => {
    const text = "call +7 (912) 345-67-89 now";
    const spans = findPiiSpans(text);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.kind).toBe("phone");
    expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe("+7 (912) 345-67-89");
  });

  it("locates a credentials span inside a URL, keyed as 'credentials'", () => {
    const text = "https://admin:Secret@host/path";
    const spans = findPiiSpans(text);
    const credSpan = spans.find((s) => s.kind === "credentials");
    expect(credSpan).toBeDefined();
    expect(text.slice(credSpan!.start, credSpan!.end)).toBe("https://admin:Secret@");
  });

  it("returns no spans for PII-free text", () => {
    expect(findPiiSpans("open the settings page")).toEqual([]);
  });
});
