// Lazy loader for the cell-cycle QC + modeling pipeline. The numeric modules
// stay off the initial application graph until the first QC or modeling action
// needs them. load_pipeline() imports the module behind a visible progress
// overlay; load_pipeline_silently() does the same for background precompute with
// no overlay; get_pipeline() returns the already-loaded module (or null). All
// three share one cached promise, so concurrent callers reuse a single import.

import { show_progress, update_progress, hide_progress } from "../ui/status_channels.js";

let pipeline_promise = null;
let pipeline_module = null;

/*

Purpose:
	Imports the cell-cycle pipeline module on first use, behind a visible
	"Loading cell-cycle modeling" progress overlay, and caches the promise so
	later calls reuse the same import.

Input:
	(none)

Output:
	module [Promise<Module>]: resolves to the pipeline module (rejects, and
	                          clears the cache to allow a retry, on import failure)

*/
export function load_pipeline() {
  if (pipeline_promise) return pipeline_promise;

  show_progress("Loading cell-cycle modeling");
  update_progress(30, "Loading cell-cycle modeling", "Fetching the analysis modules…");
  pipeline_promise = import("./cell_cycle_pipeline.js")
    .then((module) => {
      pipeline_module = module;
      update_progress(100, "Loading cell-cycle modeling", "Ready.");
      hide_progress(0);
      return module;
    })
    .catch((error) => {
      pipeline_promise = null;
      hide_progress(200);
      throw error;
    });
  return pipeline_promise;
}

/*

Purpose:
	Returns the already-loaded pipeline module without triggering a load.

Input:
	(none)

Output:
	module [Module|null]: the loaded module, or null if it hasn't loaded yet

*/
export function get_pipeline() {
  return pipeline_module;
}

/*

Purpose:
	Loads the pipeline module like load_pipeline() but without the visible
	progress overlay -- for background precompute triggered right after a channel
	plots, before the user has asked for anything. Shares the same cached
	promise/module, so an in-flight or resolved load from either loader is reused.

Input:
	(none)

Output:
	module [Promise<Module>]: resolves to the pipeline module

*/
export function load_pipeline_silently() {
  if (pipeline_promise) return pipeline_promise;
  pipeline_promise = import("./cell_cycle_pipeline.js")
    .then((module) => {
      pipeline_module = module;
      return module;
    })
    .catch((error) => {
      pipeline_promise = null;
      throw error;
    });
  return pipeline_promise;
}
