// Model-neutral registry for cell-cycle fit models. Each entry describes one
// selectable model (id, fit scope, capabilities) plus the functions needed to
// run it and normalize its output into the generic fit-result contract every
// consumer (plot overlay, result table, export) reads, regardless of which
// underlying model produced it. This module only holds the registry mechanics
// -- it has no built-in knowledge of any specific model; callers register_model()
// their own entries (see register_default_models() for the current app-wide set).

import { legacy_bridge_v1 } from "./models/legacy_bridge.js";
import { dean_jett } from "./models/dean_jett.js";

const registry = new Map();

/**
 * Register one model entry. Throws on structurally invalid entries (missing
 * id/fit/normalizeResult, or a fitScope outside the two the plan defines) so
 * a malformed model fails at registration time, not on first use.
 */
export function register_model(entry) {
  if (!entry || typeof entry.id !== "string" || !entry.id) {
    throw new TypeError("Model entries require a non-empty string id.");
  }
  if (typeof entry.fit !== "function") {
    throw new TypeError(`Model "${entry.id}" must provide a fit(context) function.`);
  }
  if (typeof entry.normalizeResult !== "function") {
    throw new TypeError(`Model "${entry.id}" must provide a normalizeResult(rawResult) function.`);
  }
  if (entry.fitScope !== "per_sample" && entry.fitScope !== "joint_series") {
    throw new TypeError(`Model "${entry.id}" fitScope must be "per_sample" or "joint_series".`);
  }
  registry.set(entry.id, entry);
}

export function get_model(id) {
  return registry.get(id) ?? null;
}

export function list_models() {
  return [...registry.values()];
}

/** Test-only: clears every registered model so suites don't leak state. */
export function clear_registry() {
  registry.clear();
}

/**
 * Registers the current app-wide set of models. Called explicitly (not as an
 * import-time side effect) so tests can control exactly what's registered.
 * Synchronous: cell_cycle_pipeline.js (this registry's only real caller) is
 * itself already lazy-loaded as a whole, so there's no separate "off the
 * critical path" benefit to also dynamically importing each model here.
 * Canonical Dean-Jett-Fox/Watson models register here too once they land.
 */
export function register_default_models() {
  register_model(legacy_bridge_v1);
  register_model(dean_jett);
}
