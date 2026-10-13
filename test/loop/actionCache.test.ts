import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTION_CACHE_KILL_SWITCH_KEY,
  ACTION_CACHE_MAX_ENTRIES,
  ACTION_CACHE_STORAGE_KEY,
  ACTION_CACHE_TTL_MS,
  buildStepCacheKey,
  deleteCacheEntry,
  findTextRangeInGoal,
  hashCachedLabel,
  isActionCacheEnabled,
  isCacheableStepOperation,
  isIrreversibleLabel,
  isSensitiveField,
  isUnsafeCachedTarget,
  looksSensitive,
  lookupStepCache,
  readTextFromRange,
  resolveCachedIndex,
  secondHash,
  touchCacheEntry,
  writeStepCacheEntry,
} from "../../src/loop/actionCache.js";
import { memoryStorage, type KeyValueStorage } from "../../src/loop/storage.js";

// A fresh in-memory storage per test (was the shared happy-dom localStorage,
// cleared in afterEach).
let store: KeyValueStorage;
beforeEach(() => {
  store = memoryStorage();
});

afterEach(() => {
  vi.useRealTimers();
});

const ELS = [{ index: 0, tag: "button", label: "Accept all", ops: ["CLICK"], isPassword: false }];

const target = (label: string, tag: string, role?: string) => ({
  labelHash: hashCachedLabel(label),
  tag,
  ...(role ? { role } : {}),
});

describe("actionCache: EXACT-INPUT step cache key", () => {
  it("is exact on goal text: no lowercasing, no whitespace collapsing", () => {
    const a = buildStepCacheKey("Search for Headphones", "https://shop.example.com/cart", "Cart", ELS, []);
    const b = buildStepCacheKey("search for headphones", "https://shop.example.com/cart", "Cart", ELS, []);
    expect(a).not.toBe(b);
  });

  it("is exact on the URL: query string differences mint a different key, unlike the old :n path pattern", () => {
    const a = buildStepCacheKey("search", "https://shop.example.com/orders/1", "Orders", ELS, []);
    const b = buildStepCacheKey("search", "https://shop.example.com/orders/2", "Orders", ELS, []);
    expect(a).not.toBe(b);

    const c = buildStepCacheKey("search", "https://shop.example.com/cart?ref=a", "Cart", ELS, []);
    const d = buildStepCacheKey("search", "https://shop.example.com/cart?ref=b", "Cart", ELS, []);
    expect(c).not.toBe(d);
  });

  it("ignores only the URL fragment", () => {
    const a = buildStepCacheKey("search", "https://shop.example.com/cart#top", "Cart", ELS, []);
    const b = buildStepCacheKey("search", "https://shop.example.com/cart#bottom", "Cart", ELS, []);
    expect(a).toBe(b);
  });

  it("is exact on the page title", () => {
    const a = buildStepCacheKey("search", "https://shop.example.com/cart", "Your Cart", ELS, []);
    const b = buildStepCacheKey("search", "https://shop.example.com/cart", "Cart (1 item)", ELS, []);
    expect(a).not.toBe(b);
  });

  it("changes when an element becomes disabled", () => {
    const url = "https://shop.example.com/cart";
    const enabled = buildStepCacheKey("search", url, "Cart", ELS, []);
    const disabled = buildStepCacheKey("search", url, "Cart", [{ ...ELS[0]!, disabled: true }], []);
    expect(enabled).not.toBe(disabled);
  });

  it("isUnsafeCachedTarget: a disabled target is never replayed or cached", () => {
    expect(isUnsafeCachedTarget("CLICK", "Accept all", undefined, false, true)).toBe(true);
    expect(isUnsafeCachedTarget("CLICK", "Accept all", undefined, false, false)).toBe(false);
    expect(isUnsafeCachedTarget("CLICK", "Accept all", undefined, false)).toBe(false);
  });

  it("changes when the element set changes, with no indices involved", () => {
    const base = buildStepCacheKey("search", "https://shop.example.com/cart", "Cart", ELS, []);
    const grown = buildStepCacheKey(
      "search",
      "https://shop.example.com/cart",
      "Cart",
      [...ELS, { index: 1, tag: "button", label: "Reject all", ops: ["CLICK"], isPassword: false }],
      []
    );
    expect(base).not.toBe(grown);

    // Order-independent, and indices don't participate in the fingerprint.
    const reordered = buildStepCacheKey(
      "search",
      "https://shop.example.com/cart",
      "Cart",
      [
        { index: 9, tag: "button", label: "Reject all", ops: ["CLICK"], isPassword: false },
        { index: 4, tag: "button", label: "Accept all", ops: ["CLICK"], isPassword: false },
      ],
      []
    );
    expect(
      buildStepCacheKey(
        "search",
        "https://shop.example.com/cart",
        "Cart",
        [
          { index: 1, tag: "button", label: "Accept all", ops: ["CLICK"], isPassword: false },
          { index: 2, tag: "button", label: "Reject all", ops: ["CLICK"], isPassword: false },
        ],
        []
      )
    ).toBe(reordered);
  });

  it("changes when any of the extra element fields Jev's own digest can see changes (checked/hasValue/value/scrollable/frame/options)", () => {
    const base = buildStepCacheKey(
      "search",
      "https://shop.example.com/cart",
      "Cart",
      [{ index: 0, tag: "input", role: "checkbox", label: "Gift wrap", ops: ["CLICK"], checked: false }],
      []
    );
    const checked = buildStepCacheKey(
      "search",
      "https://shop.example.com/cart",
      "Cart",
      [{ index: 0, tag: "input", role: "checkbox", label: "Gift wrap", ops: ["CLICK"], checked: true }],
      []
    );
    expect(base).not.toBe(checked);

    const hasValue = buildStepCacheKey(
      "search",
      "https://shop.example.com/cart",
      "Cart",
      [{ index: 0, tag: "input", label: "Promo", ops: ["TYPE_TEXT"], hasValue: true }],
      []
    );
    const noValue = buildStepCacheKey(
      "search",
      "https://shop.example.com/cart",
      "Cart",
      [{ index: 0, tag: "input", label: "Promo", ops: ["TYPE_TEXT"], hasValue: false }],
      []
    );
    expect(hasValue).not.toBe(noValue);

    const withValueText = buildStepCacheKey(
      "search",
      "https://shop.example.com/cart",
      "Cart",
      [{ index: 0, tag: "select", label: "Size", ops: ["SELECT"], value: "M" }],
      []
    );
    const differentValueText = buildStepCacheKey(
      "search",
      "https://shop.example.com/cart",
      "Cart",
      [{ index: 0, tag: "select", label: "Size", ops: ["SELECT"], value: "L" }],
      []
    );
    expect(withValueText).not.toBe(differentValueText);

    const scrollable = buildStepCacheKey(
      "search",
      "https://shop.example.com/cart",
      "Cart",
      [{ index: 0, tag: "div", label: "Modal", ops: [], scrollable: true }],
      []
    );
    const notScrollable = buildStepCacheKey(
      "search",
      "https://shop.example.com/cart",
      "Cart",
      [{ index: 0, tag: "div", label: "Modal", ops: [], scrollable: false }],
      []
    );
    expect(scrollable).not.toBe(notScrollable);

    const inFrame = buildStepCacheKey(
      "search",
      "https://shop.example.com/cart",
      "Cart",
      [{ index: 0, tag: "button", label: "Pay", ops: ["CLICK"], frame: "checkout iframe" }],
      []
    );
    const noFrame = buildStepCacheKey(
      "search",
      "https://shop.example.com/cart",
      "Cart",
      [{ index: 0, tag: "button", label: "Pay", ops: ["CLICK"] }],
      []
    );
    expect(inFrame).not.toBe(noFrame);

    const withOptions = buildStepCacheKey(
      "search",
      "https://shop.example.com/cart",
      "Cart",
      [{ index: 0, tag: "select", label: "Country", ops: ["SELECT"], options: ["US", "CA"] }],
      []
    );
    const differentOptions = buildStepCacheKey(
      "search",
      "https://shop.example.com/cart",
      "Cart",
      [{ index: 0, tag: "select", label: "Country", ops: ["SELECT"], options: ["US", "CA", "MX"] }],
      []
    );
    expect(withOptions).not.toBe(differentOptions);
  });

  it("uses the FULL history — no truncation to the last 3 entries", () => {
    const long = Array.from({ length: 5 }, (_, i) => ({ operation: "CLICK", label: `Step ${i}` }));
    const withOlderChanged = [
      { operation: "CLICK", label: "DIFFERENT first step" },
      ...long.slice(1),
    ];
    const a = buildStepCacheKey("search", "https://shop.example.com/cart", "Cart", ELS, long);
    const b = buildStepCacheKey("search", "https://shop.example.com/cart", "Cart", ELS, withOlderChanged);
    // The old implementation only hashed the last 3 entries, so these two
    // would have collided; the new one must not.
    expect(a).not.toBe(b);
  });

  it("keeps a step's side-effect suffix as part of the exact history signature (no stripping)", () => {
    const a = buildStepCacheKey("search", "https://shop.example.com/cart", "Cart", ELS, [
      { operation: "CLICK", label: 'Add to cart (page updated: "x")' },
    ]);
    const b = buildStepCacheKey("search", "https://shop.example.com/cart", "Cart", ELS, [
      { operation: "CLICK", label: "Add to cart" },
    ]);
    expect(a).not.toBe(b);
  });

  it("no fixed point: an unproductive loop's history grows every step, so it can never re-hit the same key twice", () => {
    // Simulates the exact "same key forever" failure mode a code review
    // flagged in the old design — a step that keeps landing on the same
    // page with the same goal, but whose OWN history entry differs (e.g. a
    // repeated failed attempt) each time.
    const seen = new Set<string>();
    let history: Array<{ operation: string; label: string }> = [];
    for (let i = 0; i < 20; i++) {
      const key = buildStepCacheKey("check out", "https://shop.example.com/cart", "Cart", ELS, history);
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      history = [...history, { operation: "CLICK", label: `attempt ${i}` }];
    }
  });

  describe("scroll position", () => {
    it("changes when the bucketed y position changes (100px buckets)", () => {
      const a = buildStepCacheKey("search", "https://shop.example.com/cart", "Cart", ELS, [], {
        y: 0,
        atBottom: false,
      });
      const b = buildStepCacheKey("search", "https://shop.example.com/cart", "Cart", ELS, [], {
        y: 300,
        atBottom: false,
      });
      expect(a).not.toBe(b);
    });

    it("does NOT change for jitter within the same 100px bucket", () => {
      // 260 and 290 both round to the 300 bucket (Math.round(y/100)*100).
      const a = buildStepCacheKey("search", "https://shop.example.com/cart", "Cart", ELS, [], {
        y: 260,
        atBottom: false,
      });
      const b = buildStepCacheKey("search", "https://shop.example.com/cart", "Cart", ELS, [], {
        y: 290,
        atBottom: false,
      });
      expect(a).toBe(b);
    });

    it("changes when atBottom differs even at the same y bucket", () => {
      const a = buildStepCacheKey("search", "https://shop.example.com/cart", "Cart", ELS, [], {
        y: 900,
        atBottom: false,
      });
      const b = buildStepCacheKey("search", "https://shop.example.com/cart", "Cart", ELS, [], {
        y: 900,
        atBottom: true,
      });
      expect(a).not.toBe(b);
    });

    it("degrades to a stable key when scroll is missing or malformed", () => {
      const noScroll = buildStepCacheKey("search", "https://shop.example.com/cart", "Cart", ELS, []);
      const undefinedScroll = buildStepCacheKey(
        "search",
        "https://shop.example.com/cart",
        "Cart",
        ELS,
        [],
        undefined
      );
      const malformed = buildStepCacheKey("search", "https://shop.example.com/cart", "Cart", ELS, [], "garbage");
      expect(noScroll).toBe(undefinedScroll);
      expect(() => malformed).not.toThrow();
    });
  });
});

describe("actionCache: collision safety (two independently-seeded hashes)", () => {
  it("secondHash of a string differs from secondHash of its reverse (spot check)", () => {
    expect(secondHash("abc")).not.toBe(secondHash("cba"));
  });

  it("secondHash is deterministic (same input, same output)", () => {
    expect(secondHash("some cache key input")).toBe(secondHash("some cache key input"));
  });

  it("buildStepCacheKey's key is two concatenated hex hashes, not one", () => {
    const key = buildStepCacheKey("search", "https://shop.example.com/cart", "Cart", ELS, []);
    // "step:" prefix + two 32-bit FNV-1a hashes (each 1-8 hex chars,
    // leading zeros stripped by `.toString(16)`) concatenated — up to 16
    // hex chars total, never just one hash's worth.
    expect(key).toMatch(/^step:[0-9a-f]{2,16}$/);
  });

  it("lookupStepCache treats a `verify` mismatch as a miss and deletes the entry, even though the key itself matched", () => {
    const key = buildStepCacheKey("accept cookies", "https://example.com", "Example", ELS, []);
    writeStepCacheEntry(store, key, "accept cookies", ELS, {
      operation: "CLICK",
      target: target("Accept all", "button"),
    });

    // A hand-crafted collision simulation: same key, but looked up with a
    // DIFFERENT goal — this must never happen from a real hash collision in
    // practice, but simulates exactly what one would look like: the key
    // string matches, yet the context that produced it did not.
    expect(lookupStepCache(store, key, "a completely different goal", ELS)).toBeUndefined();
    // And the entry is gone afterward — not just refused this one time.
    expect(lookupStepCache(store, key, "accept cookies", ELS)).toBeUndefined();
  });

  it("lookupStepCache treats a mismatched element set as a miss too", () => {
    const key = buildStepCacheKey("accept cookies", "https://example.com", "Example", ELS, []);
    writeStepCacheEntry(store, key, "accept cookies", ELS, {
      operation: "CLICK",
      target: target("Accept all", "button"),
    });

    const differentElements = [{ index: 0, tag: "button", label: "Reject all", ops: ["CLICK"] }];
    expect(lookupStepCache(store, key, "accept cookies", differentElements)).toBeUndefined();
  });

  it("a malformed/pre-migration entry with no verify block is treated as a miss and deleted", () => {
    const key = buildStepCacheKey("accept cookies", "https://example.com", "Example", ELS, []);
    // Bypass writeStepCacheEntry to simulate a stored value from before the
    // `verify` block existed.
    store.setItem(
      ACTION_CACHE_STORAGE_KEY,
      JSON.stringify({
        [key]: { value: { operation: "CLICK" }, hits: 0, lastUsed: Date.now() },
      })
    );
    expect(lookupStepCache(store, key, "accept cookies", ELS)).toBeUndefined();
    const raw = JSON.parse(store.getItem(ACTION_CACHE_STORAGE_KEY) ?? "{}");
    expect(raw[key]).toBeUndefined();
  });
});

describe("actionCache: no raw text persisted", () => {
  it("storage contains neither typed text nor target label text — only hashes", () => {
    const goal = 'search for "wireless headphones" under $50';
    const key = buildStepCacheKey(goal, "https://example.com", "Example", ELS, []);
    const textStart = goal.indexOf("wireless headphones");
    writeStepCacheEntry(store, key, goal, ELS, {
      operation: "TYPE_TEXT",
      target: target("Search box", "input"),
      textRange: [textStart, textStart + "wireless headphones".length],
    });

    const raw = store.getItem(ACTION_CACHE_STORAGE_KEY) ?? "";
    expect(raw).not.toContain("wireless headphones");
    expect(raw).not.toContain("Search box");
    // tag/role stay plain per the code review decision.
    expect(raw).toContain("input");
  });

  it("hashCachedLabel is case/whitespace-insensitive, matching resolveCachedIndex's own normalization", () => {
    expect(hashCachedLabel("Accept ALL")).toBe(hashCachedLabel("  accept   all  "));
  });
});

describe("actionCache: storage (LRU / TTL / kill switch)", () => {
  it("round-trips a step cache entry", () => {
    const key = buildStepCacheKey("accept cookies", "https://example.com", "Example", ELS, []);
    expect(lookupStepCache(store, key, "accept cookies", ELS)).toBeUndefined();

    writeStepCacheEntry(store, key, "accept cookies", ELS, { operation: "CLICK", target: target("Accept all", "button") });

    expect(lookupStepCache(store, key, "accept cookies", ELS)).toEqual({
      operation: "CLICK",
      target: target("Accept all", "button"),
    });
  });

  it("deleteCacheEntry removes the entry and is a no-op on an already-missing key", () => {
    const key = buildStepCacheKey("accept cookies", "https://example.com", "Example", ELS, []);
    writeStepCacheEntry(store, key, "accept cookies", ELS, { operation: "CLICK", target: target("Accept all", "button") });

    deleteCacheEntry(store, key);
    expect(lookupStepCache(store, key, "accept cookies", ELS)).toBeUndefined();

    expect(() => deleteCacheEntry(store, key)).not.toThrow();
    expect(() => deleteCacheEntry(store, "never-written")).not.toThrow();
  });

  it("touchCacheEntry bumps hits without changing the stored value", () => {
    const key = buildStepCacheKey("accept cookies", "https://example.com", "Example", ELS, []);
    writeStepCacheEntry(store, key, "accept cookies", ELS, { operation: "CLICK", target: target("Accept all", "button") });

    touchCacheEntry(store, key);
    touchCacheEntry(store, key);

    const raw = JSON.parse(store.getItem(ACTION_CACHE_STORAGE_KEY)!);
    expect(raw[key].hits).toBe(2);
    expect(lookupStepCache(store, key, "accept cookies", ELS)).toEqual({
      operation: "CLICK",
      target: target("Accept all", "button"),
    });
  });

  it("evicts the least-recently-used entry once past ACTION_CACHE_MAX_ENTRIES", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const oldestKey = buildStepCacheKey("goal-oldest", "https://example.com", "Example", ELS, []);
    writeStepCacheEntry(store, oldestKey, "goal-oldest", ELS, { operation: "CLICK", target: target("A", "button") });

    // Fill the store up to the cap with entries newer than `oldestKey`.
    for (let i = 0; i < ACTION_CACHE_MAX_ENTRIES; i++) {
      vi.setSystemTime(i + 1);
      const goal = `goal-${i}`;
      writeStepCacheEntry(store, buildStepCacheKey(goal, "https://example.com", "Example", ELS, []), goal, ELS, {
        operation: "CLICK",
        target: target("A", "button"),
      });
    }

    expect(lookupStepCache(store, oldestKey, "goal-oldest", ELS)).toBeUndefined();
    const newestGoal = `goal-${ACTION_CACHE_MAX_ENTRIES - 1}`;
    expect(
      lookupStepCache(store, 
        buildStepCacheKey(newestGoal, "https://example.com", "Example", ELS, []),
        newestGoal,
        ELS
      )
    ).toBeDefined();
  });

  it("treats an entry older than ACTION_CACHE_TTL_MS as expired", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const key = buildStepCacheKey("accept cookies", "https://example.com", "Example", ELS, []);
    writeStepCacheEntry(store, key, "accept cookies", ELS, { operation: "CLICK", target: target("Accept all", "button") });

    vi.setSystemTime(ACTION_CACHE_TTL_MS - 1);
    expect(lookupStepCache(store, key, "accept cookies", ELS)).toBeDefined();

    vi.setSystemTime(ACTION_CACHE_TTL_MS + 1);
    expect(lookupStepCache(store, key, "accept cookies", ELS)).toBeUndefined();
  });

  it("the kill switch disables both reads and writes without throwing", () => {
    store.setItem(ACTION_CACHE_KILL_SWITCH_KEY, "off");
    expect(isActionCacheEnabled(store)).toBe(false);

    const key = buildStepCacheKey("accept cookies", "https://example.com", "Example", ELS, []);
    writeStepCacheEntry(store, key, "accept cookies", ELS, { operation: "CLICK", target: target("Accept all", "button") });

    expect(lookupStepCache(store, key, "accept cookies", ELS)).toBeUndefined();
    expect(store.getItem(ACTION_CACHE_STORAGE_KEY)).toBeNull();
  });

  it("degrades to a no-op instead of throwing when the storage itself throws", () => {
    const boom = () => {
      throw new Error("SecurityError: storage disabled");
    };
    const throwing: KeyValueStorage = { getItem: boom, setItem: boom, removeItem: boom };

    expect(() => isActionCacheEnabled(throwing)).not.toThrow();
    expect(isActionCacheEnabled(throwing)).toBe(true);
    expect(() =>
      writeStepCacheEntry(throwing, "k", "goal", ELS, { operation: "CLICK", target: target("A", "button") })
    ).not.toThrow();
    expect(() => lookupStepCache(throwing, "k", "goal", ELS)).not.toThrow();
    expect(lookupStepCache(throwing, "k", "goal", ELS)).toBeUndefined();
    expect(() => deleteCacheEntry(throwing, "k")).not.toThrow();
    expect(() => touchCacheEntry(throwing, "k")).not.toThrow();
  });

  it("with no storage passed the cache is off and every operation is a silent no-op", () => {
    expect(isActionCacheEnabled(undefined)).toBe(false);
    const key = buildStepCacheKey("accept cookies", "https://example.com", "Example", ELS, []);
    expect(() =>
      writeStepCacheEntry(undefined, key, "accept cookies", ELS, {
        operation: "CLICK",
        target: target("Accept all", "button"),
      })
    ).not.toThrow();
    expect(lookupStepCache(undefined, key, "accept cookies", ELS)).toBeUndefined();
    expect(() => deleteCacheEntry(undefined, key)).not.toThrow();
    expect(() => touchCacheEntry(undefined, key)).not.toThrow();
  });

  it("malformed JSON in storage is treated as an empty cache rather than throwing", () => {
    store.setItem(ACTION_CACHE_STORAGE_KEY, "{not json");
    expect(() => lookupStepCache(store, "anything", "goal", ELS)).not.toThrow();
    expect(lookupStepCache(store, "anything", "goal", ELS)).toBeUndefined();
  });
});

describe("actionCache: resolveCachedIndex (self-heal matching via label HASH)", () => {
  it("resolves a unique labelHash+tag match", () => {
    const elements = [
      { index: 0, tag: "button", label: "Accept all" },
      { index: 1, tag: "button", label: "Reject all" },
    ];
    expect(resolveCachedIndex(elements, target("Accept all", "button"))).toBe(0);
  });

  it("returns undefined (a miss) when nothing matches — the element is gone", () => {
    const elements = [{ index: 0, tag: "button", label: "Reject all" }];
    expect(resolveCachedIndex(elements, target("Accept all", "button"))).toBeUndefined();
  });

  it("returns undefined (never guesses) when MORE than one element matches", () => {
    const elements = [
      { index: 0, tag: "button", label: "Delete" },
      { index: 1, tag: "button", label: "Delete" },
    ];
    expect(resolveCachedIndex(elements, target("Delete", "button"))).toBeUndefined();
  });

  it("requires the role to match when the cached target carries one", () => {
    const elements = [
      { index: 0, tag: "input", label: "Search", role: "searchbox" },
      { index: 1, tag: "input", label: "Search", role: "combobox" },
    ];
    expect(resolveCachedIndex(elements, target("Search", "input", "searchbox"))).toBe(0);
  });

  it("matches label case/whitespace-insensitively via the hash", () => {
    const elements = [{ index: 0, tag: "button", label: "  Accept ALL " }];
    expect(resolveCachedIndex(elements, target("accept all", "button"))).toBe(0);
  });

  it("looks up by the element's own `index` field, not array position", () => {
    const elements = [
      { index: 7, tag: "button", label: "Accept all" }, // sparse — not at array position 0
    ];
    expect(resolveCachedIndex(elements, target("Accept all", "button"))).toBe(7);
  });
});

describe("actionCache: cacheability guards", () => {
  it("WAIT is never cacheable; other step operations are", () => {
    expect(isCacheableStepOperation("WAIT")).toBe(false);
    for (const op of ["CLICK", "TYPE_TEXT", "SELECT", "SCROLL_UP", "SCROLL_DOWN"]) {
      expect(isCacheableStepOperation(op)).toBe(true);
    }
  });

  it("looksSensitive flags card-number-shaped and password-shaped VALUES", () => {
    expect(looksSensitive("4111 1111 1111 1111")).toBe(true);
    expect(looksSensitive("4111-1111-1111-1111")).toBe(true);
    expect(looksSensitive("my password is hunter2")).toBe(true);
    expect(looksSensitive("headphones")).toBe(false);
    expect(looksSensitive(undefined)).toBe(false);
  });

  it.each([
    "Reserve table",
    "Book now",
    "Book a table",
    "Complete reservation",
    "Hold this seat",
    "Place your order",
    "Proceed to payment",
    "Send application",
    "Submit inquiry",
    "Забронировать столик",
    "Зарезервировать",
    "Перейти к оплате",
    "Отправить заявку",
    "Jetzt buchen",
    "Tisch reservieren",
    "Zahlungspflichtig bestellen",
    "Zur Kasse",
    "Absenden",
    "Book",
    " Book it ",
    "ORDER",
    "Buy",
    "Check out",
    "Confirm",
    "Заказать",
    "Bestellen",
    "Bestätigen",
  ])("commit label %j is never cached nor replayed", (label) => {
    expect(isIrreversibleLabel(label)).toBe(true);
    expect(isUnsafeCachedTarget("CLICK", label, undefined, undefined)).toBe(true);
  });

  it.each(["Booking.com", "Reservations", "Add to cart", "Bookmark", "Поиск", "Weiter"])(
    "non-commit label %j stays cacheable",
    (label) => {
      expect(isIrreversibleLabel(label)).toBe(false);
    }
  );

  it("isIrreversibleLabel flags destructive/one-way action labels in English and Russian", () => {
    for (const label of [
      "Place order",
      "Pay now",
      "Buy Now",
      "Checkout",
      "Confirm",
      "Submit order",
      "Delete",
      "Remove item",
      "Cancel subscription",
      "Refund",
      "Send money",
      "Transfer funds",
      "Unsubscribe",
      "Log out",
      "Sign out",
      "Оплатить",
      "Купить",
      "Удалить",
      "Отправить",
      "Подтвердить заказ",
      "Оформить заказ",
      "Выйти",
      "Отменить",
      "Перевести",
    ]) {
      expect(isIrreversibleLabel(label)).toBe(true);
    }
    expect(isIrreversibleLabel("Add to cart")).toBe(false);
    expect(isIrreversibleLabel(undefined)).toBe(false);
    expect(isIrreversibleLabel("Поиск")).toBe(false);
    expect(isIrreversibleLabel("Далее")).toBe(false);
    expect(isIrreversibleLabel("Показать ещё")).toBe(false);
  });

  it("isSensitiveField flags password/OTP/card/IBAN-shaped labels and types", () => {
    expect(isSensitiveField("Password", undefined)).toBe(true);
    expect(isSensitiveField("CVV", undefined)).toBe(true);
    expect(isSensitiveField("CVC code", undefined)).toBe(true);
    expect(isSensitiveField("OTP code", undefined)).toBe(true);
    expect(isSensitiveField("Verification code", undefined)).toBe(true);
    expect(isSensitiveField("2FA code", undefined)).toBe(true);
    expect(isSensitiveField("Card number", undefined)).toBe(true);
    expect(isSensitiveField("IBAN", undefined)).toBe(true);
    expect(isSensitiveField(undefined, "password")).toBe(true);
    expect(isSensitiveField("Пароль", undefined)).toBe(true);
    expect(isSensitiveField("Код подтверждения", undefined)).toBe(true);
    expect(isSensitiveField("Код из смс", undefined)).toBe(true);
    expect(isSensitiveField("Номер карты", undefined)).toBe(true);
    expect(isSensitiveField("Email", undefined)).toBe(false);
    expect(isSensitiveField(undefined, undefined)).toBe(false);
  });

  it("isUnsafeCachedTarget: irreversible label blocks ANY operation", () => {
    expect(isUnsafeCachedTarget("CLICK", "Delete", undefined, false)).toBe(true);
    expect(isUnsafeCachedTarget("CLICK", "Add to cart", undefined, false)).toBe(false);
  });

  it("isUnsafeCachedTarget: sensitive field / isPassword only blocks TYPE_TEXT/SELECT", () => {
    expect(isUnsafeCachedTarget("TYPE_TEXT", "Password", undefined, false)).toBe(true);
    expect(isUnsafeCachedTarget("TYPE_TEXT", "Email", "password", false)).toBe(true);
    expect(isUnsafeCachedTarget("TYPE_TEXT", "Search", undefined, true)).toBe(true);
    expect(isUnsafeCachedTarget("SELECT", "Password", undefined, false)).toBe(true);
    // A password field being CLICKED (not typed into) is not itself unsafe —
    // TYPE_TEXT/SELECT is what would leak/replay a credential.
    expect(isUnsafeCachedTarget("CLICK", "Password", undefined, true)).toBe(false);
    expect(isUnsafeCachedTarget("TYPE_TEXT", "Search", undefined, false)).toBe(false);
  });
});

describe("actionCache: text-range offsets (never raw typed text)", () => {
  it("finds the [start, end) range of text that occurs verbatim in the goal", () => {
    const goal = 'search for "wireless headphones" under $50';
    const range = findTextRangeInGoal(goal, "wireless headphones");
    expect(range).toBeDefined();
    expect(goal.slice(range![0], range![1])).toBe("wireless headphones");
  });

  it("returns undefined when the text does not occur verbatim in the goal", () => {
    expect(findTextRangeInGoal("search for shoes", "wireless headphones")).toBeUndefined();
    expect(findTextRangeInGoal("search for shoes", "")).toBeUndefined();
  });

  it("readTextFromRange round-trips what findTextRangeInGoal found", () => {
    const goal = "book a table for 4 people at 7pm";
    const range = findTextRangeInGoal(goal, "4 people");
    expect(readTextFromRange(goal, range)).toBe("4 people");
  });

  it("readTextFromRange is defensive against an out-of-bounds/corrupted range", () => {
    expect(readTextFromRange("short goal", [0, 1000])).toBeUndefined();
    expect(readTextFromRange("short goal", [5, 2])).toBeUndefined();
    expect(readTextFromRange("short goal", undefined)).toBeUndefined();
  });
});
