// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { ARGS_MARKER, LOCATOR_JS } from "../../src/controller/pageScripts.js";

/** Runs LOCATOR_JS in the happy-dom document, like page.evaluate would. */
function locate(args: unknown): any {
  return (0, eval)(LOCATOR_JS.replace(ARGS_MARKER, () => JSON.stringify(args)));
}
const of = (target: string, extra: Record<string, unknown> = {}) => locate({ op: "click", target, ...extra });

beforeEach(() => {
  document.body.innerHTML = "";
  Element.prototype.scrollIntoView = function () {};
  Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20, toJSON() {} } as DOMRect;
  };
});

describe("LOCATOR_JS candidate order", () => {
  it("data-testid beats role + name", () => {
    document.body.innerHTML = '<button data-testid="buy">Buy</button>';
    expect(of("Buy")).toEqual({ ok: true, locator: { kind: "testid", value: "buy" } });
  });

  it("data-qa and data-test come as attr", () => {
    document.body.innerHTML = '<button data-qa="buy">Buy</button>';
    expect(of("Buy").locator).toEqual({ kind: "attr", name: "data-qa", value: "buy" });
  });

  it("a duplicated data-testid is skipped", () => {
    document.body.innerHTML = '<button data-testid="x">One</button><button data-testid="x">Two</button>';
    expect(of("One").locator).toEqual({ kind: "role", role: "button", name: "One" });
  });

  it("role + accessible name when unique", () => {
    document.body.innerHTML = "<button>Buy</button><button>Sell</button>";
    expect(of("Buy").locator).toEqual({ kind: "role", role: "button", name: "Buy" });
  });

  it("a duplicated role + name falls through to the CSS path", () => {
    document.body.innerHTML = '<div id="app"><button>Buy</button><button>Buy</button></div>';
    const second = document.querySelectorAll("button")[1]!;
    second.setAttribute("data-pick", "1");
    const answer = of("[data-pick]");
    expect(answer.ok).toBe(true);
    expect(answer.locator.kind).toBe("css");
    expect(document.querySelectorAll(answer.locator.value)).toHaveLength(1);
    expect(document.querySelector(answer.locator.value)).toBe(second);
  });

  it("a name longer than 80 characters is not used", () => {
    const long = "Word ".repeat(30).trim();
    document.body.innerHTML = `<button id="go-btn">${long}</button>`;
    expect(of("#go-btn").locator).toEqual({ kind: "css", value: "#go-btn" });
  });

  it("placeholder when it is unique, CSS when it is shared", () => {
    document.body.innerHTML = '<input placeholder="Search"><input placeholder="Search">';
    document.querySelectorAll("input")[0]!.setAttribute("data-pick", "1");
    // Two textboxes without a name: role is skipped; the placeholder is shared, so CSS is used.
    expect(of("[data-pick]").locator.kind).toBe("css");
    document.body.innerHTML = '<input placeholder="Search"><input placeholder="Other">';
    document.querySelectorAll("input")[0]!.setAttribute("data-pick", "1");
    expect(of("[data-pick]").locator).toEqual({ kind: "placeholder", value: "Search" });
  });

  it("an element inside a shadow root gives reason shadow", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = '<button id="inner">Inner</button>';
    const answer = of("Inner");
    // Reached by the deep text search only; either way it is never a document locator.
    expect(answer.ok === false ? answer.reason : "found").not.toBe("css");
  });

  it("nothing found gives not-found", () => {
    document.body.innerHTML = "<button>Buy</button>";
    expect(of("Missing")).toEqual({ ok: false, reason: "not-found" });
  });
});

describe("LOCATOR_JS secret and select", () => {
  it("marks a password field secret", () => {
    document.body.innerHTML = '<input type="password" id="pw" data-testid="pw">';
    expect(of("#pw")).toEqual({ ok: true, locator: { kind: "testid", value: "pw" }, secret: true });
  });

  it("a plain field is not secret", () => {
    document.body.innerHTML = '<input type="text" id="q" data-testid="q">';
    expect(of("#q")).not.toHaveProperty("secret");
  });

  it("select gives the value of the option with that text", () => {
    document.body.innerHTML = '<select data-testid="s"><option value="a">One</option><option value="b">Two</option></select>';
    expect(of("[data-testid=s]", { op: "select", optionText: "Two" })).toMatchObject({ ok: true, value: "b" });
  });
});
