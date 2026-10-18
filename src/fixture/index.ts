// `@sideform/browser-agent/fixture`: PageFixture types, validation, apply and
// capture. Isomorphic and zod-free.
export * from "./types.js";
export { parsePageFixture } from "./parse.js";
export { applyFixture, applyParsedFixture, fixtureBudgetMs, type FixtureBudgetOptions } from "./apply.js";
export { captureFixture } from "./capture.js";
export { matchUrlPattern, pickNetworkRule, buildMockResponse, createNetworkHandler } from "./network.js";
export { DEVICE_PRESETS, resolveEmulation, type ResolvedEmulation } from "./emulate.js";
