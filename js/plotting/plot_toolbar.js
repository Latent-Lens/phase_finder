// Plot toolbar: the plotly-style icon strip floating over the plot's top-left
// corner. Three of the buttons are sticky modes (pan / zoom in / zoom out) that
// change what a click or drag on the plot does; the other three are one-shot
// actions (download image, autoscale, reset axes).
//
// Every control here is display-only -- see plot_viewport.js for why that
// matters. None of them touch the modeling range or invalidate a fit.

import {
  plot_toolbar,
  plot_tool_camera,
  plot_tool_pan,
  plot_tool_zoom_in,
  plot_tool_zoom_out,
  plot_tool_autoscale,
  plot_tool_home,
  plot_export_modal,
  plot_area,
} from "./data.js";
import {
  plot_interaction_mode,
  set_plot_interaction_mode,
  autoscale_plot_viewport,
  reset_plot_viewport_to_base,
} from "./plot_viewport.js";
import {
  open_plot_export_modal,
  close_plot_export_modal,
  submit_plot_export,
} from "./plot_export.js";

const MODE_BUTTONS = () => [
  [plot_tool_pan, "pan"],
  [plot_tool_zoom_in, "zoom_in"],
  [plot_tool_zoom_out, "zoom_out"],
];

/*

Purpose:
	Marks the button for the active interaction mode as pressed, so the toolbar
	always shows which drag/click behavior is armed.

Input:
	(none)

Output:
	(none) [void]: updates aria-pressed and the active class

*/
function sync_toolbar_modes() {
  const mode = plot_interaction_mode();
  for (const [button, button_mode] of MODE_BUTTONS()) {
    if (!button) continue;
    const active = button_mode === mode;
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.classList.toggle("plot_tool__active", active);
  }
  if (plot_area) plot_area.dataset.plotMode = mode;
}

/*

Purpose:
	Wires the plot toolbar buttons and the export modal. Called once by the
	entry bootstrap.

Input:
	(none)

Output:
	(none) [void]: installs toolbar listeners

*/
export function init_plot_toolbar() {
  if (!plot_toolbar) return;

  for (const [button, mode] of MODE_BUTTONS()) {
    if (button) button.addEventListener("click", () => set_plot_interaction_mode(mode));
  }
  if (plot_tool_camera) plot_tool_camera.addEventListener("click", open_plot_export_modal);
  if (plot_tool_autoscale) plot_tool_autoscale.addEventListener("click", autoscale_plot_viewport);
  if (plot_tool_home) plot_tool_home.addEventListener("click", reset_plot_viewport_to_base);

  document.addEventListener("pf-plot-mode-changed", sync_toolbar_modes);
  sync_toolbar_modes();

  if (plot_export_modal) {
    plot_export_modal.querySelector(".stats_modal_backdrop").addEventListener("click", close_plot_export_modal);
    plot_export_modal.querySelector("#plot_export_close").addEventListener("click", close_plot_export_modal);
    plot_export_modal.querySelector("#plot_export_cancel").addEventListener("click", close_plot_export_modal);
    plot_export_modal.querySelector("#plot_export_download").addEventListener("click", submit_plot_export);
    plot_export_modal.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close_plot_export_modal();
      else if (event.key === "Enter") submit_plot_export();
    });
  }
}
