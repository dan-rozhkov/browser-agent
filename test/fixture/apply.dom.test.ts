// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { applyFixture } from "../../src/fixture/apply.js";
import type { PageFixture } from "../../src/fixture/types.js";
import { fakeTarget } from "./fakes.js";

/** A target whose `executeJavaScript` runs the script in the happy-dom document, like page.evaluate. */
function domTarget(withCdp = false) {
  const target = fakeTarget({ exec: (code) => (0, eval)(code) });
  const page = target.pages.get(1)!;
  if (!withCdp) delete page.sendCdp;
  return target;
}

const apply = (target: ReturnType<typeof domTarget>, steps: PageFixture["steps"]) => applyFixture(target, { version: 1, steps });

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    getItem: (k: string) => map.get(k) ?? null,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  // Node 26 has its own `localStorage` getter that shadows happy-dom's: use a plain in-memory Storage.
  for (const name of ["localStorage", "sessionStorage"] as const) {
    Object.defineProperty(globalThis, name, { value: memoryStorage(), configurable: true, writable: true });
  }
  // happy-dom has no layout; scrollIntoView may be absent.
  Element.prototype.scrollIntoView = function () {};
});

describe("fixture step scripts in a DOM", () => {
  it("click clicks the element", async () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    let clicked = 0;
    document.getElementById("go")!.addEventListener("click", () => clicked++);
    expect((await apply(domTarget(), [{ action: "click", selector: "#go" }])).ok).toBe(true);
    expect(clicked).toBe(1);
  });

  it("click on a missing element fails", async () => {
    const r = await apply(domTarget(), [{ action: "click", selector: "#nope" }]);
    expect(r).toEqual({ ok: false, error: "step 1 (click #nope) failed: element not found" });
  });

  it("an invalid selector fails", async () => {
    const r = await apply(domTarget(), [{ action: "click", selector: "##" }]);
    expect(r).toEqual({ ok: false, error: "step 1 (click ##) failed: invalid selector" });
  });

  it("type uses the native setter and fires input and change", async () => {
    document.body.innerHTML = '<input id="q"><textarea id="t"></textarea>';
    const events: string[] = [];
    for (const id of ["q", "t"]) {
      const el = document.getElementById(id) as HTMLInputElement;
      el.addEventListener("input", () => events.push(`${id}:input:${el.value}`));
      el.addEventListener("change", () => events.push(`${id}:change:${el.value}`));
    }
    const r = await apply(domTarget(), [
      { action: "type", selector: "#q", text: 'he said "hi"' },
      { action: "type", selector: "#t", text: "x" },
    ]);
    expect(r.ok).toBe(true);
    expect((document.getElementById("q") as HTMLInputElement).value).toBe('he said "hi"');
    expect(events).toEqual(['q:input:he said "hi"', 'q:change:he said "hi"', "t:input:x", "t:change:x"]);
  });

  it("type refuses a non-text element", async () => {
    document.body.innerHTML = '<div id="d"></div>';
    const r = await apply(domTarget(), [{ action: "type", selector: "#d", text: "x" }]);
    expect(r).toEqual({ ok: false, error: "step 1 (type #d) failed: element is not a text field" });
  });

  it("press without CDP dispatches keydown and keyup on the focused element", async () => {
    document.body.innerHTML = '<input id="q">';
    const seen: string[] = [];
    const el = document.getElementById("q")!;
    el.addEventListener("keydown", (e) => seen.push(`down:${(e as KeyboardEvent).key}`));
    el.addEventListener("keyup", (e) => seen.push(`up:${(e as KeyboardEvent).key}`));
    const r = await apply(domTarget(), [{ action: "press", key: "Enter", selector: "#q" }]);
    expect(r.ok).toBe(true);
    expect(seen).toEqual(["down:Enter", "up:Enter"]);
  });

  it("waitFor sees an element that appears later", async () => {
    setTimeout(() => { document.body.innerHTML = '<p class="ready"></p>'; }, 150);
    const r = await apply(domTarget(), [{ action: "waitFor", selector: ".ready", timeoutMs: 2000 }]);
    expect(r.ok).toBe(true);
  });

  it("waitFor with an invalid selector fails at once", async () => {
    const r = await apply(domTarget(), [{ action: "waitFor", selector: "##", timeoutMs: 2000 }]);
    expect(r).toEqual({ ok: false, error: "step 1 (waitFor ##) failed: invalid selector" });
  });

  it("the storage script writes both stores", async () => {
    const target = domTarget();
    target.pages.get(1)!.loadURL = async () => { target.pages.get(1)!.url = "https://a.test/"; };
    const r2 = await applyFixture(target, {
      version: 1,
      storage: { origins: [{ origin: "https://a.test", localStorage: { a: "1" }, sessionStorage: { b: "2" } }] },
    });
    expect(r2.ok).toBe(true);
    expect(localStorage.getItem("a")).toBe("1");
    expect(sessionStorage.getItem("b")).toBe("2");
  });
});
