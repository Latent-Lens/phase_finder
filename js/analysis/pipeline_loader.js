// Lazy loader for the staged Dean-Jett-Fox pipeline. The numeric modules stay
// off the initial application graph until a manual stage button is used.

import { show_progress, update_progress, hide_progress } from "../ui/status_channels.js";

let pipeline_promise = null;
let pipeline_module = null;

export function load_pipeline() {
  if (pipeline_promise) return pipeline_promise;

  show_progress("Loading DJF pipeline");
  update_progress(30, "Loading DJF pipeline", "Fetching staged cell-cycle analysis modules…");
  pipeline_promise = import("./cell_cycle_pipeline.js")
    .then((module) => {
      pipeline_module = module;
      update_progress(100, "Loading DJF pipeline", "Ready.");
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

export function get_pipeline() {
  return pipeline_module;
}

/**
 * Loads the pipeline module like load_pipeline(), but without the visible
 * "Loading DJF pipeline" progress overlay -- for background precompute
 * triggered right after a channel plots, before the user has asked for
 * anything DJF-related. Shares the same cached promise/module, so an
 * in-flight or already-resolved load (from either loader) is reused.
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
