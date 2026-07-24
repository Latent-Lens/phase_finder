// Plot axis-range modal, plot-control listeners, and plot inspection API. This
// module opens and applies the manual x/y range modal, including reset behavior
// and draggable modal positioning. init_plot_listeners() (called once by the
// entry bootstrap) wires color grouping, display mode, bin count, table selection
// changes, and resize observers to plot redraws. It keeps axis override state
// and calls the renderer when controls change. It also exports plot_api, which
// main.js surfaces on window.PhaseFinder.plot so other modules or tests can
// inspect current and cached series or histogram summaries.

import {
  axis_range_modal,
  axis_range_x_min_input,
  axis_range_x_max_input,
  axis_range_y_min_input,
  axis_range_y_max_input,
  axis_range_override,
  last_auto_x_range,
  last_auto_y_max,
  plot_color_by_select,
  plot_display_mode_select,
  plot_view_mode_select,
  set_plot_view_mode,
  set_ridge_focus_name,
  plot_channels,
  plot_area,
  last_series,
  series_by_name,
  histograms_by_name,
  plot_viewport,
} from "./data.js";
import { render_density_plot } from "./render.js";
import { plot_interaction_mode } from "./plot_viewport.js";

/*

Purpose:
	Opens the combined axis-range modal, prefilling all four fields with the
	user's current overrides (blank where an axis is on auto-scale) and
	showing each axis's live auto-computed bound as a placeholder. Focuses the
	Min field of whichever axis was double-clicked.

Input:
	focus_axis [string]: "x" or "y" — which axis's Min field gets focus

Output:
	(none) [void]: shows #axis_range_modal

*/
export function open_axis_range_modal(focus_axis) {
  if (!axis_range_modal) return;

  axis_range_x_min_input.value = axis_range_override.x_min == null ? "" : axis_range_override.x_min;
  axis_range_x_max_input.value = axis_range_override.x_max == null ? "" : axis_range_override.x_max;
  axis_range_y_min_input.value = axis_range_override.y_min == null ? "" : axis_range_override.y_min;
  axis_range_y_max_input.value = axis_range_override.y_max == null ? "" : axis_range_override.y_max;

  const placeholder = (value) => (Number.isFinite(value) ? String(Math.round(value * 100) / 100) : "auto");
  axis_range_x_min_input.placeholder = placeholder(last_auto_x_range[0]);
  axis_range_x_max_input.placeholder = placeholder(last_auto_x_range[1]);
  axis_range_y_min_input.placeholder = placeholder(0);
  axis_range_y_max_input.placeholder = placeholder(last_auto_y_max);

  axis_range_modal.hidden = false;
  (focus_axis === "y" ? axis_range_y_min_input : axis_range_x_min_input).focus();
}

/*

Purpose:
	Hides the axis-range modal without applying any changes.

Input:
	(none)

Output:
	(none) [void]: hides #axis_range_modal

*/
export function close_axis_range_modal() {
  if (axis_range_modal) axis_range_modal.hidden = true;
}

/*

Purpose:
	Reads all four fields and stores them as the x/y overrides (an empty
	field clears that bound back to auto), then re-renders. Silently ignores
	non-numeric input rather than applying it.

Input:
	(none)

Output:
	(none) [void]: updates axis_range_override and re-renders the plot

*/
export function apply_axis_range_modal() {
  const parse = (input) => {
    const text = input.value.trim();
    if (!text) return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : undefined;
  };
  const x_min = parse(axis_range_x_min_input);
  const x_max = parse(axis_range_x_max_input);
  const y_min = parse(axis_range_y_min_input);
  const y_max = parse(axis_range_y_max_input);
  if (x_min === undefined || x_max === undefined || y_min === undefined || y_max === undefined) return;

  const x_range_changed = x_min !== axis_range_override.x_min || x_max !== axis_range_override.x_max;
  axis_range_override.x_min = x_min;
  axis_range_override.x_max = x_max;
  axis_range_override.y_min = y_min;
  axis_range_override.y_max = y_max;
  close_axis_range_modal();
  render_density_plot();
  // Explicitly setting the x-range changes how much data is visible, which
  // bounds the modeling histogram -- so it triggers a full recompute of peaks
  // and fits (bin_settings_sync.js), same as a bin-count change. The y-range is
  // display-only. NOTE: a future interactive zoom/pan must stay viewport-only
  // (examining an existing fit), so it must NOT reuse this event.
  if (x_range_changed) document.dispatchEvent(new CustomEvent("pf-x-range-changed"));
}

/*

Purpose:
	Wires the plot-control change listeners, selection-change redraw,
	axis-range modal buttons and drag-to-move, and window/ResizeObserver redraws.
	Called once by the entry bootstrap.

Input:
	(none)

Output:
	(none) [void]: installs plot-related listeners

*/
export function init_plot_listeners() {
  // #plot_bins is handled by analysis/cell_cycle/bin_settings_sync.js instead:
  // a bin-count change must also invalidate stale peak regions/fits before
  // re-rendering, not merely redraw, so it can't share this render-only wiring.
  [plot_color_by_select, plot_display_mode_select].forEach((el) => {
    if (el) el.addEventListener("change", render_density_plot);
  });

  // Overlay/Ridge view toggle. Switching out of a blown-up review returns to
  // the ridge, so clear any ridge focus when the mode is changed by hand.
  if (plot_view_mode_select) {
    plot_view_mode_select.addEventListener("change", () => {
      set_plot_view_mode(plot_view_mode_select.value);
      set_ridge_focus_name(null);
      render_density_plot();
    });
  }

  // Live-update when the table checkbox selection changes (uncheck removes a
  // curve, re-check restores it from the still-loaded data).
  document.addEventListener("fcs-selection-change", () => {
    if (plot_channels) render_density_plot();
  });

  if (axis_range_modal) {
    axis_range_modal.querySelector(".stats_modal_backdrop").addEventListener("click", close_axis_range_modal);
    axis_range_modal.querySelector("#axis_range_close").addEventListener("click", close_axis_range_modal);
    axis_range_modal.querySelector("#axis_range_cancel").addEventListener("click", close_axis_range_modal);
    axis_range_modal.querySelector("#axis_range_apply").addEventListener("click", apply_axis_range_modal);
    axis_range_modal.querySelector("#axis_range_reset").addEventListener("click", () => {
      const x_range_changed = axis_range_override.x_min != null || axis_range_override.x_max != null;
      axis_range_override.x_min = null;
      axis_range_override.x_max = null;
      axis_range_override.y_min = null;
      axis_range_override.y_max = null;
      close_axis_range_modal();
      render_density_plot();
      // Clearing an x-range override widens the visible data back to the full
      // extent, so re-include the previously-excluded events (recompute).
      if (x_range_changed) document.dispatchEvent(new CustomEvent("pf-x-range-changed"));
    });
    axis_range_modal.addEventListener("keydown", (event) => {
      if (event.key === "Enter") apply_axis_range_modal();
      else if (event.key === "Escape") close_axis_range_modal();
    });

    // Drag-to-move: grab the header to pull the card off the plot so the data
    // underneath is unobstructed while picking axis bounds (the backdrop is
    // transparent for this modal, see plot.css). Position is remembered across
    // opens/closes for the session, starting from the CSS-centered spot.
    const axis_range_card = axis_range_modal.querySelector(".axis_range_card");
    const axis_range_header = axis_range_modal.querySelector(".stats_modal_header");
    let axis_range_drag = null;

    axis_range_header.addEventListener("mousedown", (event) => {
      if (event.target.closest(".stats_modal_close") || event.button !== 0) return;
      const rect = axis_range_card.getBoundingClientRect();
      axis_range_card.style.position = "fixed";
      axis_range_card.style.margin = "0";
      axis_range_card.style.left = `${rect.left}px`;
      axis_range_card.style.top = `${rect.top}px`;
      axis_range_drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      axis_range_modal.classList.add("axis_range_modal__dragging");
      event.preventDefault();
    });

    window.addEventListener("mousemove", (event) => {
      if (!axis_range_drag) return;
      const max_x = Math.max(0, window.innerWidth - axis_range_card.offsetWidth);
      const max_y = Math.max(0, window.innerHeight - axis_range_card.offsetHeight);
      axis_range_card.style.left = `${Math.min(max_x, Math.max(0, event.clientX - axis_range_drag.dx))}px`;
      axis_range_card.style.top = `${Math.min(max_y, Math.max(0, event.clientY - axis_range_drag.dy))}px`;
    });

    window.addEventListener("mouseup", () => {
      axis_range_drag = null;
      axis_range_modal.classList.remove("axis_range_modal__dragging");
    });
  }

  // Redraw on resize so the SVG tracks the panel size.
  let plot_resize_timer = null;
  const schedule_plot_resize = (delay = 100) => {
    window.clearTimeout(plot_resize_timer);
    plot_resize_timer = window.setTimeout(() => {
      if (plot_channels && plot_area && plot_area.clientWidth > 0 && plot_area.clientHeight > 0) {
        render_density_plot();
      }
    }, delay);
  };

  window.addEventListener("resize", () => schedule_plot_resize(150));

  if (plot_area && "ResizeObserver" in window) {
    const plot_area_resize_observer = new ResizeObserver(() => schedule_plot_resize());
    plot_area_resize_observer.observe(plot_area);
  }
}

// Plot inspection API, surfaced on window.PhaseFinder.plot by main.js.
export const plot_api = {
  get series() {
    return last_series;
  },
  get_series(name) {
    return series_by_name.get(name) || null;
  },
  get series_names() {
    return Array.from(series_by_name.keys());
  },
  get_histogram(name) {
    return histograms_by_name.get(name) || null;
  },
  get histogram_names() {
    return Array.from(histograms_by_name.keys());
  },
  // The live axis-range override object (mutable). Exposed for the E2E x-range
  // test; production code sets it through the axis-range modal.
  get axis_range_override() {
    return axis_range_override;
  },
  // Display-only pan/zoom state (plot_viewport.js). Read-only here: it exists so
  // tests can assert that a gesture moved the *view* while axis_range_override
  // (the modeling range) stayed untouched.
  get viewport() {
    return { x: plot_viewport.x ? plot_viewport.x.slice() : null, y: plot_viewport.y ? plot_viewport.y.slice() : null };
  },
  get interaction_mode() {
    return plot_interaction_mode();
  },
};
