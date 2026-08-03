// Plot axis-range modal, plot-control listeners, and plot inspection API. This
// module opens and applies the manual x/y range modal, including reset behavior
// and draggable modal positioning. init_plot_listeners() (called once by the
// entry bootstrap) wires color grouping, display mode, bin count, table selection
// changes, and resize observers to plot redraws. It keeps axis override state
// and calls the renderer when controls change. It also exports plot_api, which
// main.js surfaces on window.PhaseFinder.plot so other modules or tests can
// inspect the currently drawn series and histogram summaries.

import {
  axis_range_modal,
  axis_range_x_min_input,
  axis_range_x_max_input,
  axis_range_y_min_input,
  axis_range_y_max_input,
  axis_range_analysis_domain_input,
  axis_range_override,
  analysis_domain_override,
  set_analysis_domain_override,
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
  plottable_rows,
} from "./data.js";
import { plot_performance, render_density_plot } from "./render.js";
import { get_state as get_pipeline_state, get_active_model_result } from "../analysis/pipeline_state.js";
import { plot_interaction_mode } from "./plot_viewport.js";

const axis_range_error = document.querySelector("#axis_range_error");
const AXIS_INPUTS = () => ({
  x_min: axis_range_x_min_input,
  x_max: axis_range_x_max_input,
  y_min: axis_range_y_min_input,
  y_max: axis_range_y_max_input,
});

export function validate_axis_range_draft(raw, auto = {}, scientific = false) {
  const values = {};
  for (const [field, text] of Object.entries(raw)) {
    const trimmed = String(text ?? "").trim();
    if (!trimmed) values[field] = null;
    else {
      const value = Number(trimmed);
      if (!Number.isFinite(value)) return { valid: false, field, message: `${field.replace("_", " ")} must be a finite number.` };
      values[field] = value;
    }
  }
  const effective = {
    x_min: values.x_min ?? auto.x_min,
    x_max: values.x_max ?? auto.x_max,
    y_min: values.y_min ?? auto.y_min,
    y_max: values.y_max ?? auto.y_max,
  };
  if (!(effective.x_min < effective.x_max)) return { valid: false, field: values.x_max != null ? "x_max" : "x_min", message: "X maximum must be greater than X minimum." };
  if (!(effective.y_min < effective.y_max)) return { valid: false, field: values.y_max != null ? "y_max" : "y_min", message: "Y maximum must be greater than Y minimum." };
  if (effective.y_min < 0) return { valid: false, field: "y_min", message: "Event counts cannot have a negative Y minimum." };
  if (scientific && effective.x_min < 0) return { valid: false, field: "x_min", message: "The scientific DNA-content domain cannot start below zero." };
  return { valid: true, values, effective };
}

function clear_axis_range_error() {
  if (axis_range_error) {
    axis_range_error.hidden = true;
    axis_range_error.textContent = "";
  }
  Object.values(AXIS_INPUTS()).forEach((input) => {
    input?.removeAttribute("aria-invalid");
    input?.removeAttribute("aria-describedby");
  });
}

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
  axis_range_analysis_domain_input.checked =
    analysis_domain_override.x_min != null || analysis_domain_override.x_max != null;
  clear_axis_range_error();

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
/*

Purpose:
	Whether any plotted sample currently carries a reportable model result, so an
	X-range change knows whether there is a fit to invalidate and recompute.

Input:
	(none)

Output:
	present [boolean]: true when at least one plotted sample has an active result

*/
function any_active_model_result() {
  try {
    return plottable_rows().some((row) => get_active_model_result(get_pipeline_state(row.name)));
  } catch (_) {
    return false; // no plotted data yet; nothing to refit
  }
}

export function apply_axis_range_modal() {
  const useAnalysisDomain = axis_range_analysis_domain_input.checked;
  const validation = validate_axis_range_draft({
    x_min: axis_range_x_min_input.value,
    x_max: axis_range_x_max_input.value,
    y_min: axis_range_y_min_input.value,
    y_max: axis_range_y_max_input.value,
  }, {
    x_min: last_auto_x_range[0], x_max: last_auto_x_range[1], y_min: 0, y_max: last_auto_y_max,
  }, useAnalysisDomain);
  if (!validation.valid) {
    const input = AXIS_INPUTS()[validation.field];
    if (axis_range_error) {
      axis_range_error.textContent = validation.message;
      axis_range_error.hidden = false;
    }
    input?.setAttribute("aria-invalid", "true");
    input?.setAttribute("aria-describedby", "axis_range_error");
    input?.focus();
    return;
  }
  clear_axis_range_error();
  const { x_min, x_max, y_min, y_max } = validation.values;

  // A changed X range moves which events are BINNED, so any existing model fit
  // was computed on a different domain than the one now on screen. Rather than
  // leave the plot and the reported numbers describing different things, an X
  // change is treated as an analysis-domain change whenever a fit exists, and
  // the samples are refit (via pf-analysis-domain-changed -> run_recompute).
  //
  // Y is deliberately NOT included: it is the COUNT axis, so its limits clip
  // what is drawn and cannot change which events fall in which bin. There is
  // nothing for a refit to do.
  //
  // Pan/zoom stays display-only regardless -- that is an exploration gesture,
  // not a deliberate statement about the analysis domain.
  const xChanged = x_min !== axis_range_override.x_min || x_max !== axis_range_override.x_max;
  const refitNeeded = xChanged && (x_min != null || x_max != null) && any_active_model_result();
  const treatAsAnalysisDomain = useAnalysisDomain || refitNeeded;
  const analysisMin = treatAsAnalysisDomain ? x_min : null;
  const analysisMax = treatAsAnalysisDomain ? x_max : null;
  const analysisChanged = analysisMin !== analysis_domain_override.x_min
    || analysisMax !== analysis_domain_override.x_max;
  if (analysisChanged && treatAsAnalysisDomain && !window.confirm(
    refitNeeded && !useAnalysisDomain
      ? "These X limits change which events are analysed, and this sample already has a model fit. "
        + "Continue and refit on the new X range?"
      : "Change the scientific analysis domain? Events outside these X limits will be excluded and existing peak/model results invalidated.",
  )) return;
  axis_range_override.x_min = x_min;
  axis_range_override.x_max = x_max;
  axis_range_override.y_min = y_min;
  axis_range_override.y_max = y_max;
  set_analysis_domain_override(analysisMin, analysisMax);
  close_axis_range_modal();
  render_density_plot();
  if (analysisChanged) document.dispatchEvent(new CustomEvent("pf-analysis-domain-changed"));
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
  document.addEventListener("pf-open-axis-range", (event) => {
    open_axis_range_modal(event.detail?.axis);
  });
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
    const form = axis_range_modal.querySelector("#axis_range_form");
    axis_range_modal.querySelector(".stats_modal_backdrop").addEventListener("click", close_axis_range_modal);
    axis_range_modal.querySelector("#axis_range_close").addEventListener("click", close_axis_range_modal);
    axis_range_modal.querySelector("#axis_range_cancel").addEventListener("click", close_axis_range_modal);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      apply_axis_range_modal();
    });
    axis_range_modal.querySelector("#axis_range_reset").addEventListener("click", () => {
      const analysisChanged = analysis_domain_override.x_min != null || analysis_domain_override.x_max != null;
      axis_range_override.x_min = null;
      axis_range_override.x_max = null;
      axis_range_override.y_min = null;
      axis_range_override.y_max = null;
      set_analysis_domain_override(null, null);
      close_axis_range_modal();
      render_density_plot();
      // Clearing an x-range override widens the visible data back to the full
      // extent, so re-include the previously-excluded events (recompute).
      if (analysisChanged) document.dispatchEvent(new CustomEvent("pf-analysis-domain-changed"));
    });
    axis_range_modal.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close_axis_range_modal();
    });

    // Drag-to-move now lives in ui/draggable_modal.js, wired generically for
    // every modal by init_draggable_modals() in the entry bootstrap -- this
    // modal's transparent backdrop (plot.css) is what actually makes dragging
    // it aside useful, so the data underneath stays visible while picking
    // axis bounds.
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
  get analysis_domain() {
    return { ...analysis_domain_override };
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
  performance: plot_performance,
};
