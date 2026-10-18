import { describe, expect, it } from "vitest";
import { UPLOAD_MAX_BYTES, validateUploadFiles } from "../../src/controller/uploadFiles.js";
import { UPLOAD_SAMPLES } from "../../src/controller/uploadSamples.js";

const err = (raw: unknown) => {
  const r = validateUploadFiles(raw);
  if (r.ok) throw new Error("expected a refusal");
  return r.error;
};

describe("validateUploadFiles", () => {
  it("encodes text as UTF-8 base64 and picks a MIME type from the name", () => {
    const r = validateUploadFiles([{ name: "n.csv", text: "é,1" }]);
    expect(r).toMatchObject({ ok: true, files: [{ name: "n.csv", mimeType: "text/csv" }] });
    if (r.ok) expect(Buffer.from(r.files[0]!.base64, "base64").toString("utf8")).toBe("é,1");
  });

  it("keeps an explicit mimeType and passes valid base64 through", () => {
    const r = validateUploadFiles([{ name: "x.bin", mimeType: "application/x-foo", base64: "aGk=" }]);
    expect(r).toMatchObject({ ok: true, totalBytes: 2, files: [{ mimeType: "application/x-foo", base64: "aGk=" }] });
  });

  it("expands every sample to valid bytes with its own MIME type", () => {
    for (const kind of ["png", "jpg", "pdf", "txt", "csv"] as const) {
      const r = validateUploadFiles([{ name: `s.${kind}`, sample: kind }]);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.files[0]!.mimeType).toBe(UPLOAD_SAMPLES[kind].mimeType);
    }
    const png = Buffer.from(UPLOAD_SAMPLES.png.base64, "base64");
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect([...Buffer.from(UPLOAD_SAMPLES.jpg.base64, "base64").subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect(Buffer.from(UPLOAD_SAMPLES.pdf.base64, "base64").toString("latin1")).toMatch(/^%PDF-1\.4[\s\S]*%%EOF\n$/);
  });

  it("refuses an empty list and more than 5 files", () => {
    expect(err([])).toMatch(/non-empty/);
    expect(err(undefined)).toMatch(/non-empty/);
    expect(err(Array.from({ length: 6 }, (_, i) => ({ name: `f${i}`, text: "a" })))).toMatch(/at most 5/);
    expect(validateUploadFiles(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, text: "a" }))).ok).toBe(true);
  });

  it("refuses names that are empty, over 100 characters or hold a path separator", () => {
    expect(err([{ name: "", text: "a" }])).toMatch(/name/);
    expect(err([{ name: "a".repeat(101), text: "a" }])).toMatch(/name/);
    expect(validateUploadFiles([{ name: "a".repeat(100), text: "a" }]).ok).toBe(true);
    expect(err([{ name: "../x.txt", text: "a" }])).toMatch(/must not contain/);
    expect(err([{ name: "a\\b.txt", text: "a" }])).toMatch(/must not contain/);
  });

  it("refuses bad base64", () => {
    expect(err([{ name: "a", base64: "not base64!" }])).toMatch(/not valid base64/);
    expect(err([{ name: "a", base64: "abc" }])).toMatch(/not valid base64/);
    expect(err([{ name: "a", base64: "data:text/plain;base64,aGk=" }])).toMatch(/not valid base64/);
  });

  it("refuses a file with zero or several sources, and an unknown sample", () => {
    expect(err([{ name: "a" }])).toMatch(/exactly one/);
    expect(err([{ name: "a", text: "x", base64: "aGk=" }])).toMatch(/exactly one/);
    expect(err([{ name: "a", sample: "exe" }])).toMatch(/sample must be/);
    expect(err([{ name: "a", sample: "toString" }])).toMatch(/sample must be/);
  });

  it("limits the decoded total to 2 MB", () => {
    const half = Buffer.alloc(UPLOAD_MAX_BYTES / 2).toString("base64");
    expect(validateUploadFiles([{ name: "a", base64: half }, { name: "b", base64: half }]).ok).toBe(true);
    expect(err([{ name: "a", base64: half }, { name: "b", base64: half }, { name: "c", text: "x" }])).toMatch(/larger than 2 MB/);
  });
});
