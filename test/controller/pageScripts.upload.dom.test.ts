// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { ARGS_MARKER, UPLOAD_JS } from "../../src/controller/pageScripts.js";

function run(args: unknown): any {
  const code = UPLOAD_JS.replace(ARGS_MARKER, () => JSON.stringify(args));
  return (0, eval)(code);
}

const b64 = (s: string) => btoa(s);
const file = (name: string, content = "hi", mimeType = "text/plain") => ({ name, mimeType, base64: b64(content) });

beforeEach(() => {
  document.body.innerHTML = "";
  Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20, toJSON() {} } as DOMRect;
  };
  Element.prototype.scrollIntoView = function () {};
});

describe("UPLOAD_JS", () => {
  it("sets files on a file input and fires input then change", async () => {
    document.body.innerHTML = '<input id="f" type="file">';
    const input = document.getElementById("f") as HTMLInputElement;
    const events: string[] = [];
    input.addEventListener("input", () => events.push("input"));
    input.addEventListener("change", () => events.push("change"));
    const out = run({ target: "#f", files: [file("a.txt", "hello")] });
    expect(out).toEqual({ ok: true, uploaded: ["a.txt"], via: "input" });
    expect(events).toEqual(["input", "change"]);
    expect(input.files!.length).toBe(1);
    expect(input.files![0]!.name).toBe("a.txt");
    expect(input.files![0]!.type).toBe("text/plain");
    expect(await input.files![0]!.text()).toBe("hello");
  });

  it("finds a file input inside the target", () => {
    document.body.innerHTML = '<div id="zone"><input type="file" hidden></div>';
    const out = run({ target: "#zone", files: [file("a.txt")] });
    expect(out.via).toBe("input");
    expect((document.querySelector("input") as HTMLInputElement).files!.length).toBe(1);
  });

  it("follows <label for> to the input", () => {
    document.body.innerHTML = '<label id="l" for="f">Pick</label><input id="f" type="file">';
    const out = run({ target: "#l", files: [file("a.txt")] });
    expect(out).toEqual({ ok: true, uploaded: ["a.txt"], via: "input" });
    expect((document.getElementById("f") as HTMLInputElement).files!.length).toBe(1);
  });

  it("drops the files on an element with no file input", () => {
    document.body.innerHTML = '<div id="zone">Drop here</div>';
    const zone = document.getElementById("zone")!;
    const seen: Record<string, number> = {};
    for (const t of ["dragenter", "dragover", "drop"]) {
      zone.addEventListener(t, (e) => {
        seen[t] = (e as DragEvent).dataTransfer?.files.length ?? -1;
        e.preventDefault();
      });
    }
    const out = run({ target: "#zone", files: [file("a.txt"), file("b.txt")] });
    expect(out).toEqual({ ok: true, uploaded: ["a.txt", "b.txt"], via: "drop" });
    expect(Object.keys(seen)).toEqual(["dragenter", "dragover", "drop"]);
    expect(seen.drop).toBe(2);
  });

  it("errors on a drop that no listener accepted, with noEffect when the page did not change", () => {
    document.body.innerHTML = '<div id="zone">Plain text</div>';
    const out = run({ target: "#zone", files: [file("a.txt")] });
    expect(out).toMatchObject({ noEffect: true });
    expect(out.error).toContain("No file input or drop zone found at this element");
    expect(out.ok).toBeUndefined();
  });

  it("reports an unconfirmed drop (ok, no error) when no listener cancelled the events but the page changed", () => {
    document.body.innerHTML = '<div id="zone">Plain text</div>';
    document.getElementById("zone")!.addEventListener("drop", () => {
      document.body.appendChild(document.createElement("span"));
    });
    const out = run({ target: "#zone", files: [file("a.txt")] });
    expect(out).toEqual({ ok: true, uploaded: ["a.txt"], via: "drop", unconfirmed: true });
  });

  it("sees a change inside the target's own open shadow root", () => {
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.getElementById("host")!;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = "<div>Plain</div>";
    expect(run({ target: "#host", files: [file("a.txt")] })).toMatchObject({ error: expect.stringContaining("No file input or drop zone"), noEffect: true });
    // A listener on the host that changes its own shadow tree: seen through el.shadowRoot.
    host.addEventListener("drop", () => shadow.appendChild(document.createElement("i")));
    expect(run({ target: "#host", files: [file("a.txt")] })).toMatchObject({ ok: true, via: "drop", unconfirmed: true });
  });

  it("does not use the sibling input for a non-trigger target (a div drop zone beside an avatar input)", () => {
    document.body.innerHTML = '<div class="row"><div id="zone">Drop files</div><input type="file" id="avatar"></div>';
    const zone = document.getElementById("zone")!;
    zone.addEventListener("dragover", (e) => e.preventDefault());
    const out = run({ target: "#zone", files: [file("a.txt")] });
    expect(out).toMatchObject({ ok: true, via: "drop" });
    expect((document.getElementById("avatar") as HTMLInputElement).files!.length).toBe(0);
  });

  it("still uses the sibling input for a span inside a button", () => {
    document.body.innerHTML = '<div><button><span id="s">Browse</span></button><input type="file" hidden></div>';
    expect(run({ target: "#s", files: [file("a.txt")] })).toMatchObject({ via: "input" });
  });

  it("accepts a drop that cancels only dragover", () => {
    document.body.innerHTML = '<div id="zone">Drop</div>';
    document.getElementById("zone")!.addEventListener("dragover", (e) => e.preventDefault());
    expect(run({ target: "#zone", files: [file("a.txt")] })).toMatchObject({ ok: true, via: "drop" });
  });

  it("finds the file input next to the target (same form group)", () => {
    document.body.innerHTML = '<div class="group"><button id="b">Browse</button><span><input type="file" hidden></span></div><div><input type="file" id="other"></div>';
    const out = run({ target: "#b", files: [file("a.txt")] });
    expect(out).toEqual({ ok: true, uploaded: ["a.txt"], via: "input" });
    expect((document.querySelector(".group input") as HTMLInputElement).files!.length).toBe(1);
    expect((document.getElementById("other") as HTMLInputElement).files!.length).toBe(0);
  });

  it("does not guess when the nearest group has two file inputs", () => {
    document.body.innerHTML = '<div><button id="b">Browse</button><input type="file"><input type="file"></div>';
    const out = run({ target: "#b", files: [file("a.txt")] });
    expect(out.error).toContain("No file input or drop zone found");
    for (const i of Array.from(document.querySelectorAll("input"))) expect((i as HTMLInputElement).files!.length).toBe(0);
  });

  it("refuses more than one file on an input without multiple, and touches nothing", () => {
    document.body.innerHTML = '<input id="f" type="file">';
    const input = document.getElementById("f") as HTMLInputElement;
    let fired = 0;
    input.addEventListener("change", () => fired++);
    const out = run({ target: "#f", files: [file("a.txt"), file("b.txt")] });
    expect(out).toEqual({ error: "This input takes one file", noEffect: true });
    expect(fired).toBe(0);
    expect(input.files!.length).toBe(0);
  });

  it("accepts several files on a multiple input", () => {
    document.body.innerHTML = '<input id="f" type="file" multiple>';
    const out = run({ target: "#f", files: [file("a.txt"), file("b.txt")] });
    expect(out.ok).toBe(true);
    expect((document.getElementById("f") as HTMLInputElement).files!.length).toBe(2);
  });

  it("does not enforce accept", () => {
    document.body.innerHTML = '<input id="f" type="file" accept="image/png">';
    const out = run({ target: "#f", files: [file("a.txt")] });
    expect(out.ok).toBe(true);
  });

  it("refuses a disabled input and a missing target, both as no-effect", () => {
    document.body.innerHTML = '<input id="f" type="file" disabled>';
    expect(run({ target: "#f", files: [file("a.txt")] })).toMatchObject({ noEffect: true });
    expect(run({ target: "#nope", files: [file("a.txt")] })).toMatchObject({
      error: "No element matched for upload: #nope",
      noEffect: true,
    });
  });
});
