// Root barrel: controller + policy + loop + fixture (all isomorphic). Adapters are NOT re-exported (they
// carry optional peer dependencies) — import them from
// `@sideform/browser-agent/adapters/*`.
export * from "./controller/index.js";
export * from "./policy/index.js";
export * from "./loop/index.js";
export * from "./fixture/index.js";

// Two names exist in more than one layer. The root picks one explicitly; the
// other stays available from its layer entry point (`@sideform/browser-agent/policy`).
//  - MAX_SNAPSHOT_ELEMENTS: both layers define 120 → the controller's.
//  - BrowsePermissions: the loop's (the one `runBrowseTask` accepts) wins over
//    the policy's request-body copy.
export { MAX_SNAPSHOT_ELEMENTS } from "./controller/index.js";
export type { BrowsePermissions } from "./loop/index.js";
