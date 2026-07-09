// Lazy loader for the Dean-Jett-Fox numeric stack. The DJF module statically
// imports the two heaviest optional dependencies (ml-levenberg-marquardt and
// ml-gsd), so keeping analysis/djf.js off the initial import graph keeps that
// whole stack off the startup critical path. It is fetched on demand the first
// time the user enables a correction or starts modeling. The first fetch shows
// the shared progress overlay; the resolved module is cached and exposed
// synchronously via get_djf() so the (synchronous) render pass can use it on
// every subsequent draw. main.js's window.PhaseFinder.djf debug hook reads the
// same cached module, so it is populated after this first load, not at startup.

import { show_progress, update_progress, hide_progress } from "../ui/status_channels.js";

let djf_promise = null;
let djf_module = null;

/*

Purpose:
	Dynamically imports the DJF numeric stack on demand, memoized so it is fetched
	at most once. Shows the progress overlay during the one-time fetch.

Input:
	(none)

Output:
	module [Promise<Object>]: resolves to the analysis/djf.js module namespace

*/
export function load_djf() {
  if (djf_promise) return djf_promise;

  show_progress("Loading cell-cycle modeling");
  update_progress(35, "Loading cell-cycle modeling", "Fetching the Dean–Jett–Fox numeric stack…");
  djf_promise = import("../analysis/djf.js")
    .then((module) => {
      // Cache it; main.js's window.PhaseFinder.djf is a getter over get_djf(),
      // so exposing it needs no assignment here (and the property has no setter).
      djf_module = module;
      update_progress(100, "Loading cell-cycle modeling", "Ready.");
      hide_progress(300);
      return module;
    })
    .catch((error) => {
      djf_promise = null; // allow a later retry
      hide_progress(200);
      throw error;
    });
  return djf_promise;
}

/*

Purpose:
	Returns the already-loaded DJF module synchronously, or null if it has not
	been loaded yet. Lets the synchronous render pass use DJF once it is cached.

Input:
	(none)

Output:
	module [Object|null]: the DJF module namespace, or null before first load

*/
export function get_djf() {
  return djf_module;
}
