import { describe, it, expect } from "vitest";
import { decideBrowserNavigation } from "../../src/controller/navigation.js";

describe("decideBrowserNavigation", () => {
  it("allows http(s), regardless of origin", () => {
    expect(decideBrowserNavigation("https://pinterest.com/search")).toBe("allow");
    expect(decideBrowserNavigation("http://example.com/")).toBe("allow");
    expect(decideBrowserNavigation("https://totally-unrelated-domain.test/x")).toBe("allow");
  });
  it("denies non-http schemes and garbage", () => {
    expect(decideBrowserNavigation("file:///etc/passwd")).toBe("deny");
    expect(decideBrowserNavigation("javascript:alert(1)")).toBe("deny");
    expect(decideBrowserNavigation("%%%")).toBe("deny");
  });
});
