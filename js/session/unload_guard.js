// Shared "warn before leaving with unsaved data" guard. Installs one
// beforeunload listener for real navigation (back/forward/refresh/closing the
// tab), which the browser restricts to its own fixed wording for security. Our
// own JS-triggered reloads (logo click, Reset Session) show their own confirm()
// first with our wording; suppress_next_unload_warning() lets them skip the
// browser's native prompt too, since the user already answered ours.

import { loaded_file_count } from "../data_structs/table_state.js";

let suppress_once = false;

/*

Purpose:
	Marks the next beforeunload as already confirmed by our own dialog, so the
	browser's native "leave site?" prompt doesn't also fire right after it.
	Call immediately before a JS-triggered window.location.reload() (or similar)
	whose action the user just confirmed through our own confirm().

Input:
	(none)

Output:
	(none) [void]: sets a one-shot flag consumed by the next beforeunload

*/
export function suppress_next_unload_warning() {
  suppress_once = true;
}

/*

Purpose:
	Installs the beforeunload listener. Called once by the entry bootstrap.

Input:
	(none)

Output:
	(none) [void]: wires window's beforeunload handler

*/
export function init_unload_guard() {
  window.addEventListener("beforeunload", (event) => {
    if (suppress_once) {
      suppress_once = false;
      return;
    }
    if (loaded_file_count() === 0) return;
    event.preventDefault();
    event.returnValue = "";
  });
}
