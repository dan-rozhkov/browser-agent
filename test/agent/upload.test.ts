import { afterEach, describe, expect, it } from "vitest";
import { asSchema } from "ai";
import { createBrowseActInputSchema, createBrowseToolDefinitions, normalizeBrowseActInput } from "../../src/agent/index.js";
import { bridgeWith, browseAct, FOUND, resetEnvironment, snap, stubLocate } from "./executeHarness.js";

afterEach(resetEnvironment);

const schema = createBrowseActInputSchema({ elementTargeting: true });
const parse = (v: unknown) => schema.safeParse(v);
const one = { name: "a.png", sample: "png" };

describe("browse_act upload: schema", () => {
  it("accepts upload with each file source", () => {
    for (const file of [{ name: "a.txt", text: "hi" }, { name: "a.bin", base64: "aGk=", mimeType: "x/y" }, one]) {
      expect(parse({ action: "upload", index: 1, snapshotId: "s", files: [file] }).success).toBe(true);
    }
    expect(parse({ action: "upload", element: "the avatar input", files: [one] }).success).toBe(true);
  });

  it("rejects a file with no source, two sources, a bad sample, no name, or 6 files", () => {
    const base = { action: "upload", index: 1, snapshotId: "s" };
    expect(parse({ ...base, files: [{ name: "a" }] }).success).toBe(false);
    expect(parse({ ...base, files: [{ name: "a", text: "x", sample: "png" }] }).success).toBe(false);
    expect(parse({ ...base, files: [{ name: "a", sample: "exe" }] }).success).toBe(false);
    expect(parse({ ...base, files: [{ text: "x" }] }).success).toBe(false);
    expect(parse({ ...base, files: Array.from({ length: 6 }, () => one) }).success).toBe(false);
  });

  it("is also valid inside an actions batch", () => {
    expect(parse({ snapshotId: "s", actions: [{ action: "upload", index: 1, files: [one] }] }).success).toBe(true);
  });

  it("treats strict-mode placeholders as absent", () => {
    // An empty `files` array on a click, and empty keys inside a file entry.
    const click = normalizeBrowseActInput({ action: "click", index: 2, snapshotId: "s", files: [] });
    expect(click).toEqual({ action: "click", index: 2, snapshotId: "s" });
    const up = normalizeBrowseActInput({
      action: "upload",
      index: 2,
      snapshotId: "s",
      files: [{ name: "a.png", mimeType: "", text: "", base64: "", sample: "png" }],
    });
    expect(up).toEqual({ action: "upload", index: 2, snapshotId: "s", files: [{ name: "a.png", sample: "png" }] });
    expect(parse({ action: "upload", index: 2, snapshotId: "s", files: [{ name: "a.png", mimeType: "", text: "", base64: "", sample: "png" }] }).success).toBe(true);
    expect(parse({ action: "click", index: 2, snapshotId: "s", files: [], actions: [] }).success).toBe(true);
  });

  it("puts upload in the action enum of the published JSON schema", () => {
    const json = JSON.stringify(asSchema(createBrowseToolDefinitions().browse_act.inputSchema).jsonSchema);
    expect(json).toContain('"upload"');
    expect(json).toContain('"files"');
  });
});

describe("browse_act upload: executor", () => {
  it("forwards a non-element upload to the bridge untouched", async () => {
    const args = { action: "upload", index: 1, snapshotId: "s-0", files: [one] };
    const bridge = bridgeWith({ act: [{ ok: true, uploaded: ["a.png"], via: "input", changed: true }], snapshot: [snap("s-1")] });
    await browseAct(args);
    expect(bridge.callsTo("act").map((c) => c.args)).toEqual([[args]]);
  });

  it("an element upload resolves the element and forwards files", async () => {
    const bridge = bridgeWith({ snapshot: [snap("pre-1"), snap("post-2")], act: [{ ok: true, uploaded: ["a.png"], via: "input" }] });
    stubLocate([FOUND(4)]);
    await browseAct({ action: "upload", element: "the avatar input", files: [one] });
    expect(bridge.callsTo("act").map((c) => c.args)).toEqual([[{ action: "upload", index: 4, snapshotId: "pre-1", files: [one] }]]);
  });

  it("refuses an element upload with no files before any round trip", async () => {
    const bridge = bridgeWith({ snapshot: [snap("pre-1")] });
    const locate = stubLocate([FOUND(4)]);
    const out = JSON.parse(await browseAct({ action: "upload", element: "the input" }));
    expect(out.error).toBe('browse_act: action "upload" requires a non-empty "files" array.');
    const empty = JSON.parse(await browseAct({ action: "upload", element: "the input", files: [] }));
    expect(empty.error).toBe('browse_act: action "upload" requires a non-empty "files" array.');
    expect(locate.requests).toHaveLength(0);
    expect(bridge.callsTo("act")).toHaveLength(0);
  });
});
