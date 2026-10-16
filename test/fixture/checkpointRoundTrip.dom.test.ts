// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { BrowserController } from "../../src/controller/controller.js";
import { applyFixture } from "../../src/fixture/apply.js";
import type { FixtureCookie } from "../../src/fixture/types.js";
import { fakeTarget } from "./fakes.js";

const COOKIE = "sentinel-cookie-rt1";

const FORM = `<main>
  <input id="name"><textarea name="note"></textarea>
  <select id="size"><option value="s">Small</option><option value="l">Large</option></select>
  <input type="checkbox" id="gift">
  <button id="add" type="button">Add to cart</button>
  <p id="out"></p>
</main>`;

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    getItem: (k: string) => map.get(k) ?? null,
    removeItem: (k: string) => void map.delete(k),
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
  };
}

function mountPage() {
  document.body.innerHTML = FORM;
  // Clicking "Add to cart" writes the cart to localStorage, like a shop does.
  document.getElementById("add")!.addEventListener("click", () => {
    localStorage.setItem("cart", (localStorage.getItem("cart") ?? "") + "x");
    document.getElementById("out")!.textContent = "cart=" + localStorage.getItem("cart");
  });
}

beforeEach(() => {
  for (const name of ["localStorage", "sessionStorage"] as const) {
    Object.defineProperty(globalThis, name, { value: memoryStorage(), configurable: true, writable: true });
  }
  Element.prototype.scrollIntoView = function () {};
  Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20, toJSON() {} } as DOMRect;
  };
  mountPage();
});

/** A target whose pages run every script in the happy-dom document, without a CDP session (DOM fallbacks). */
function domTarget(cookies: FixtureCookie[] = []) {
  const target = fakeTarget({ exec: (code) => (0, eval)(code) });
  delete target.pages.get(1)!.sendCdp;
  target.pages.get(1)!.url = "https://shop.test/product";
  target.getCookies = async () => cookies;
  return target;
}

describe("checkpoint round trip", () => {
  it("a captured checkpoint rebuilds the form state with applyFixture in a new browser", { timeout: 30_000 }, async () => {
    localStorage.setItem("theme", "dark");
    const source = domTarget([{ name: "sid", value: COOKIE, domain: "shop.test" }]);
    const controller = new BrowserController(source, { cursor: false });
    controller.startJournal();

    // The agent fills the form: by text/selector target and by index from a snapshot.
    await controller.act({ action: "type", target: "#name", text: "Ada Lovelace" });
    await controller.act({ action: "type", target: "[name=note]", text: "ring the bell" });
    const snapshot = (await controller.snapshot()) as { snapshotId: string; elements: { index: number; label: string; tag: string }[] };
    const sizeIndex = snapshot.elements.find((e) => e.tag === "select")!.index;
    const giftIndex = snapshot.elements.find((e) => e.label.toLowerCase().includes("gift") || (e as { inputType?: string }).inputType === "checkbox")!.index;
    await controller.perform({ snapshotId: snapshot.snapshotId, index: sizeIndex, operation: "SELECT", text: "Large" });
    await controller.perform({ snapshotId: snapshot.snapshotId, index: giftIndex, operation: "CLICK" });
    await controller.act({ action: "click", target: "Add to cart" });

    const state = () => ({
      name: (document.getElementById("name") as HTMLInputElement).value,
      note: (document.querySelector("[name=note]") as HTMLTextAreaElement).value,
      size: (document.getElementById("size") as HTMLSelectElement).value,
      gift: (document.getElementById("gift") as HTMLInputElement).checked,
      out: document.getElementById("out")!.textContent,
      cart: localStorage.getItem("cart"),
    });
    const before = state();
    expect(before).toEqual({ name: "Ada Lovelace", note: "ring the bell", size: "l", gift: true, out: "cart=x", cart: "x" });

    const cp = await controller.captureCheckpoint();
    expect(cp.ok).toBe(true);
    if (!cp.ok) return;
    expect(cp.complete).toBe(true);
    // 5 actions, each preceded by a waitFor for its element.
    expect(cp.fixture.steps).toHaveLength(10);
    expect(cp.fixture.steps?.filter((st) => st.action !== "waitFor")).toHaveLength(5);
    expect(cp.fixture.steps?.filter((st) => st.action === "waitFor")).toHaveLength(5);
    // The base was read before the first step: no cart in it.
    expect(cp.fixture.storage?.origins).toEqual([{ origin: "https://shop.test", localStorage: { theme: "dark" } }]);
    expect(cp.fixture.storage?.cookies).toEqual([{ name: "sid", value: COOKIE, domain: "shop.test" }]);

    // A new browser: a fresh document and fresh storage. The fixture is the only thing carried over.
    mountPage();
    for (const name of ["localStorage", "sessionStorage"] as const) {
      Object.defineProperty(globalThis, name, { value: memoryStorage(), configurable: true, writable: true });
    }
    expect(state()).toEqual({ name: "", note: "", size: "s", gift: false, out: "", cart: null });

    const fresh = domTarget();
    const applied = await applyFixture(fresh, JSON.parse(JSON.stringify(cp.fixture)));
    expect(applied).toMatchObject({ ok: true });
    expect(fresh.cookiesSet).toEqual([[{ name: "sid", value: COOKIE, domain: "shop.test" }]]);
    // Same form state, the cart written once (not twice: the step replays on the base, not on the captured storage).
    expect(state()).toEqual(before);
    expect(localStorage.getItem("theme")).toBe("dark");
    if (applied.ok) expect(applied.summary).not.toContain(COOKIE);
  });
});
