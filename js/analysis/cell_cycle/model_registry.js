// Model-neutral registry for cell-cycle fit models. Each entry describes one
// selectable model (id, fit scope, capabilities) plus the functions needed to
// run it and normalize its output into the generic fit-result contract every
// consumer (plot overlay, result table, export) reads, regardless of which
// underlying model produced it. This module only holds the registry mechanics
// -- it has no built-in knowledge of any specific model; callers register_model()
// their own entries (see register_default_models() for the current app-wide set).

import { legacy_bridge_v1 } from "./models/legacy_bridge.js";
import { dean_jett } from "./models/dean_jett.js";
import { dean_jett_fox } from "./models/dean_jett_fox.js";
import { watson_pragmatic } from "./models/watson_pragmatic.js";
import { watson_classic } from "./models/watson_classic.js";
import { cloccs } from "./models/cloccs.js";

const registry = new Map();

/*

Purpose:
	Registers one model entry, throwing on a structurally invalid entry (missing
	id/fit/normalizeResult, or a fitScope outside the two supported values) so a
	malformed model fails at registration time rather than on first use.

Input:
	entry [object]: { id, fit, normalizeResult, fitScope: "per_sample" |
	                  "joint_series", ... }

Output:
	(none) [void]: stores the entry under its id (throws on an invalid entry)

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

/*

Purpose:
	Looks up a registered model by id.

Input:
	id [string]: the model id

Output:
	entry [object|null]: the registered entry, or null when unknown

*/
export function get_model(id) {
  return registry.get(id) ?? null;
}

/*

Purpose:
	Lists every registered model entry.

Input:
	(none)

Output:
	entries [array]: all registered model entries

*/
export function list_models() {
  return [...registry.values()];
}

/*

Purpose:
	Test-only helper that clears every registered model so test suites don't
	leak registry state between runs.

Input:
	(none)

Output:
	(none) [void]: empties the registry

*/
export function clear_registry() {
  registry.clear();
}

/*

Purpose:
	Registers the current app-wide set of models. Called explicitly (not as an
	import-time side effect) so tests can control exactly what is registered.
	Synchronous: the pipeline module (this registry's only real caller) is itself
	lazy-loaded as a whole, so there's no benefit to dynamically importing each
	model here.

Input:
	(none)

Output:
	(none) [void]: registers legacy_bridge_v1, dean_jett, dean_jett_fox,
	               watson_pragmatic, and watson_classic

*/
export function register_default_models() {
  register_model(legacy_bridge_v1);
  register_model(dean_jett);
  register_model(dean_jett_fox);
  register_model(watson_pragmatic);
  register_model(watson_classic);
  // Joint time-series model (fitScope "joint_series"). Registered so it can be
  // selected and looked up, but it is UNVERIFIED and fits a whole strain's
  // timepoints together via fitSeries(), not the per-sample fit() path.
  register_model(cloccs);
}
