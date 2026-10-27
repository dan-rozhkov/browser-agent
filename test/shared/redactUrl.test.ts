import { describe, expect, it } from "vitest";
import { redactUrl } from "../../src/shared/redactUrl.js";

describe("redactUrl", () => {
  it("keeps origin and path of a web URL, drops query and hash", () => {
    expect(redactUrl("https://app.example.com/x?token=s#access_token=t")).toBe("https://app.example.com/x");
  });

  it("keeps scheme and host of a non-special scheme (desktop app URL)", () => {
    expect(redactUrl("macos-app://com.github.Electron/20328?a=1")).toBe("macos-app://com.github.Electron/20328");
  });

  it("returns [url] for text that does not parse", () => {
    expect(redactUrl("not a url")).toBe("[url]");
  });
});
