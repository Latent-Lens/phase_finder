// Vite replaces these constants in production builds. Plain source-tree
// serving intentionally uses explicit development markers instead.
export const PHASEFINDER_VERSION = typeof __PHASEFINDER_VERSION__ === "string"
  ? __PHASEFINDER_VERSION__
  : "source-tree";

export const PHASEFINDER_SOURCE_COMMIT = typeof __PHASEFINDER_SOURCE_COMMIT__ === "string"
  ? __PHASEFINDER_SOURCE_COMMIT__
  : "unbuilt";

export function phasefinder_provenance(kind, details = {}) {
  return {
    schemaVersion: 1,
    application: "PhaseFinder",
    applicationVersion: PHASEFINDER_VERSION,
    sourceCommit: PHASEFINDER_SOURCE_COMMIT,
    kind,
    generatedAt: new Date().toISOString(),
    ...details,
  };
}
