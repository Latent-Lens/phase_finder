// Interactive pan/zoom for the overlay plot, plus the toolbar's interaction
// mode. Everything here is DISPLAY-ONLY: it writes plot_viewport (data.js) and
// re-renders, and never touches axis_range_override or fires
// "pf-x-range-changed". That separation is deliberate -- the axis-range modal is
// the explicit *modeling* range (narrowing it re-runs detection and every fit),
// while dragging or wheeling around to examine an existing fit must never
// invalidate it. See docs/plans/cell_cycle_modeling_plan.md and todo.md.
//
// Interaction map (matches the plotly conventions the toolbar icons come from):
//   pan mode (default)  left-drag = pan          shift+left-drag = box zoom
//   zoom in / zoom out  left-drag = box zoom     shift+left-drag = pan
//                       left-click = zoom in/out about the cursor
//   any mode            wheel = zoom about the cursor
//                       double-click on empty plot space = reset to base view

import * as d3 from "d3";
import {
  plot_area,
  plot_viewport,
  set_plot_viewport,
  reset_plot_viewport,
  last_auto_x_range,
  last_auto_y_max,
} from "./data.js";
import { render_density_plot } from "./render.js";

// A box-zoom drag shorter than this (in px, either axis) is treated as a click
// rather than a rectangle, so a slightly-shaky click never zooms to a sliver.
const MIN_BOX_ZOOM_PX = 6;
// Wheel notch and click zoom strengths. The wheel step is small so a scroll
// feels continuous; a click is a discrete jump, so it is larger.
const WHEEL_ZOOM_FACTOR = 1.15;
const CLICK_ZOOM_FACTOR = 1.6;
// Click-to-zoom waits this long before acting so the second click of a
// double-click (which resets the view) cancels it instead of zooming twice.
const CLICK_ZOOM_DELAY_MS = 220;
// Never let a zoom-out widen an axis past this multiple of its base span, and
// never let a zoom-in shrink it below this fraction -- both would strand the
// user in empty space with no data on screen.
const MAX_SPAN_FACTOR = 20;
const MIN_SPAN_FACTOR = 1e-4;

// "pan" | "zoom_in" | "zoom_out". The toolbar's three mode buttons set this;
// it survives re-renders and view switches for the session.
let interaction_mode = "pan";

/*

Purpose:
	Reports the active toolbar interaction mode, so the toolbar can mark the
	pressed button and the renderer can pick the matching cursor.

Input:
	(none)

Output:
	mode [string]: "pan", "zoom_in" or "zoom_out"

*/
export function plot_interaction_mode() {
  return interaction_mode;
}

/*

Purpose:
	Switches the interaction mode and redraws so the new cursor and drag
	behavior take effect immediately.

Input:
	mode [string]: "pan", "zoom_in" or "zoom_out" (anything else is ignored)

Output:
	(none) [void]: updates the mode and re-renders the plot

*/
export function set_plot_interaction_mode(mode) {
  if (mode !== "pan" && mode !== "zoom_in" && mode !== "zoom_out") return;
  if (interaction_mode === mode) return;
  interaction_mode = mode;
  document.dispatchEvent(new CustomEvent("pf-plot-mode-changed"));
  render_density_plot();
}

// Panning re-renders the whole plot (the same full redraw the bin slider drives
// while dragging), so coalesce to one redraw per animation frame.
let render_frame = null;
function schedule_render() {
  if (render_frame != null) return;
  render_frame = window.requestAnimationFrame(() => {
    render_frame = null;
    render_density_plot();
  });
}

// Ascending, finite and non-degenerate -- a guard against every zoom/pan path
// producing a domain the scales can't draw.
function is_usable_domain(domain) {
  return Array.isArray(domain)
    && Number.isFinite(domain[0])
    && Number.isFinite(domain[1])
    && domain[1] > domain[0];
}

// Clamp a proposed domain's span against the base domain so no gesture can
// zoom out into empty space or collapse the axis to nothing. Anchored on the
// proposed domain's center, so the point under the cursor still stays put for
// any gesture that isn't already past the limit.
function clamp_span(domain, base_domain) {
  if (!is_usable_domain(domain)) return null;
  if (!is_usable_domain(base_domain)) return domain;
  const base_span = base_domain[1] - base_domain[0];
  const span = domain[1] - domain[0];
  const max_span = base_span * MAX_SPAN_FACTOR;
  const min_span = base_span * MIN_SPAN_FACTOR;
  if (span <= max_span && span >= min_span) return domain;
  const target = span > max_span ? max_span : min_span;
  const center = (domain[0] + domain[1]) / 2;
  return [center - target / 2, center + target / 2];
}

/*

Purpose:
	Stores a new display viewport and redraws. A domain that matches its base
	(or is unusable) is stored as null, which makes that axis fall back to the
	base domain -- so zooming back out all the way genuinely clears the
	viewport instead of leaving a numerically-identical override behind.

Input:
	x_domain [array|null]: proposed [min, max] display domain for x
	y_domain [array|null]: proposed [min, max] display domain for y
	base [object]: { x: [min, max], y: [min, max] } current base domains

Output:
	(none) [void]: updates plot_viewport and schedules a re-render

*/
function commit_viewport(x_domain, y_domain, base) {
  const same_as_base = (domain, base_domain) =>
    !domain || (is_usable_domain(base_domain) && domain[0] === base_domain[0] && domain[1] === base_domain[1]);
  const next_x = is_usable_domain(x_domain) && !same_as_base(x_domain, base.x) ? x_domain : null;
  const next_y = is_usable_domain(y_domain) && !same_as_base(y_domain, base.y) ? y_domain : null;
  set_plot_viewport({ x: next_x, y: next_y });
  schedule_render();
}

// Zoom both axes about a pixel anchor, keeping the data value under the anchor
// pinned to that same pixel. factor > 1 zooms in, < 1 zooms out.
//
// The domains come from plot_viewport when it is set, NOT from the passed
// scales: the redraw that follows a zoom is deferred to the next animation
// frame, so a fast wheel burst would otherwise keep re-zooming the same stale
// domain and lose every notch but one. Anchor values are interpolated from the
// domain for the same reason -- render.js draws the plot on linear scales
// (is_log is fixed false there), so this is exact.
function zoom_about(context, factor, anchor) {
  const { x_scale, y_scale, inner, base } = context;
  const width_px = Math.max(1, inner.right - inner.left);
  const height_px = Math.max(1, inner.bottom - inner.top);
  const anchor_x = Math.min(inner.right, Math.max(inner.left, anchor[0]));
  const anchor_y = Math.min(inner.bottom, Math.max(inner.top, anchor[1]));

  const x_domain = plot_viewport.x || x_scale.domain();
  const y_domain = plot_viewport.y || y_scale.domain();
  const x_span = (x_domain[1] - x_domain[0]) / factor;
  const y_span = (y_domain[1] - y_domain[0]) / factor;
  const tx = (anchor_x - inner.left) / width_px;
  // y pixels grow downward, so the fraction is measured up from the bottom.
  const ty = (inner.bottom - anchor_y) / height_px;
  const x_at = x_domain[0] + tx * (x_domain[1] - x_domain[0]);
  const y_at = y_domain[0] + ty * (y_domain[1] - y_domain[0]);

  commit_viewport(
    clamp_span([x_at - tx * x_span, x_at + (1 - tx) * x_span], base.x),
    clamp_span([y_at - ty * y_span, y_at + (1 - ty) * y_span], base.y),
    base,
  );
}

/*

Purpose:
	Toolbar "autoscale": fits both axes tightly around the data currently
	plotted, ignoring any manual axis bounds. Display-only, like every other
	gesture here -- the modeling range is untouched.

Input:
	(none)

Output:
	(none) [void]: sets plot_viewport to the data extent and re-renders

*/
export function autoscale_plot_viewport() {
  const x_domain = Array.isArray(last_auto_x_range) ? last_auto_x_range.slice() : null;
  const y_max = Number.isFinite(last_auto_y_max) && last_auto_y_max > 0 ? last_auto_y_max : null;
  set_plot_viewport({
    x: is_usable_domain(x_domain) ? x_domain : null,
    y: y_max == null ? null : [0, y_max],
  });
  render_density_plot();
}

/*

Purpose:
	Toolbar "home" (and the double-click reset): drops the display viewport so
	the plot returns to the axis configuration it was drawn with -- the manual
	axis-range overrides if any are set, otherwise the auto-computed bounds.

Input:
	(none)

Output:
	(none) [void]: clears plot_viewport and re-renders

*/
export function reset_plot_viewport_to_base() {
  if (!plot_viewport.x && !plot_viewport.y) return;
  reset_plot_viewport();
  render_density_plot();
}

/*

Purpose:
	Reports whether a pan/zoom viewport is currently active, so the toolbar can
	enable or disable its reset controls.

Input:
	(none)

Output:
	active [boolean]: true when either axis is showing a zoomed/panned domain

*/
export function has_plot_viewport() {
  return Boolean(plot_viewport.x || plot_viewport.y);
}

// Gestures that start on the peak-region overlay or an axis belong to those
// controls (region handles have their own d3.drag; the axes open the range
// modal on double-click), so the viewport ignores them.
function is_plot_background(event) {
  const target = event && event.target;
  if (!target || typeof target.closest !== "function") return true;
  return !target.closest(".peak_region_overlay")
    && !target.closest(".x_axis_group")
    && !target.closest(".y_axis_group")
    && !target.closest(".ridge_row");
}

/*

Purpose:
	Installs the display-only pan/zoom gestures on a freshly rendered plot SVG:
	drag to pan, shift-drag (or drag in a zoom mode) to rubber-band zoom, click
	to zoom in a zoom mode, wheel to zoom about the cursor, and double-click on
	empty space to reset. Called at the end of every overlay render pass, since
	each pass builds a brand-new SVG.

	Drag state is anchored to #plot_area rather than the SVG: panning redraws
	the plot (destroying and rebuilding the SVG) on every frame, and d3's drag
	container must outlive the gesture.

Input:
	context [object]: { svg, x_scale, y_scale, margin, width, height,
	                    base_x_domain, base_y_domain } from render_density_plot

Output:
	(none) [void]: appends an interaction surface and binds listeners

*/
export function install_plot_interactions(context) {
  const { svg, x_scale, y_scale, margin, width, height, base_x_domain, base_y_domain } = context;
  if (!svg || !svg.node()) return;

  const inner = {
    left: margin.left,
    right: width - margin.right,
    top: margin.top,
    bottom: height - margin.bottom,
  };
  if (!(inner.right > inner.left) || !(inner.bottom > inner.top)) return;

  const base = { x: base_x_domain, y: base_y_domain };
  const gesture_context = { x_scale, y_scale, inner, base };

  // Transparent surface inserted UNDER every drawn layer so empty plot space is
  // still a pointer target (curves, bars and region handles keep their own
  // hover/drag behavior by sitting above it).
  svg.insert("rect", ":first-child")
    .attr("class", "plot_interaction_surface")
    .attr("x", inner.left)
    .attr("y", inner.top)
    .attr("width", inner.right - inner.left)
    .attr("height", inner.bottom - inner.top)
    .attr("fill", "transparent");

  if (plot_area) plot_area.dataset.plotMode = interaction_mode;

  let pending_click_zoom = null;
  const cancel_click_zoom = () => {
    if (pending_click_zoom == null) return;
    window.clearTimeout(pending_click_zoom);
    pending_click_zoom = null;
  };

  // ── Drag: pan, or rubber-band box zoom ────────────────────────────────────
  let gesture = null;
  const drag_behavior = d3.drag()
    // #plot_area survives the mid-drag redraws that panning triggers; the SVG
    // (d3's default container, the node's parent) would not.
    .container(() => plot_area || svg.node())
    .filter((event) => event.button === 0 && !event.ctrlKey && is_plot_background(event))
    .on("start", (event) => {
      cancel_click_zoom();
      const box_zoom = interaction_mode === "pan"
        ? Boolean(event.sourceEvent && event.sourceEvent.shiftKey)
        : !(event.sourceEvent && event.sourceEvent.shiftKey);
      const x_domain = x_scale.domain();
      const y_domain = y_scale.domain();
      gesture = {
        box_zoom,
        x0: event.x,
        y0: event.y,
        x_domain: x_domain.slice(),
        y_domain: y_domain.slice(),
        x_per_px: (x_domain[1] - x_domain[0]) / (inner.right - inner.left),
        y_per_px: (y_domain[1] - y_domain[0]) / (inner.bottom - inner.top),
        band: null,
        moved: false,
      };
      if (box_zoom) {
        gesture.band = svg.append("rect")
          .attr("class", "plot_zoom_band")
          .attr("x", event.x)
          .attr("y", inner.top)
          .attr("width", 0)
          .attr("height", 0);
      } else if (plot_area) {
        plot_area.classList.add("plot_area__panning");
      }
    })
    .on("drag", (event) => {
      if (!gesture) return;
      const dx = event.x - gesture.x0;
      const dy = event.y - gesture.y0;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) gesture.moved = true;

      if (gesture.box_zoom) {
        // Rubber band, clamped to the plot body. Drawn live on the current SVG
        // (a box zoom doesn't redraw until it's released).
        const x1 = Math.min(inner.right, Math.max(inner.left, gesture.x0));
        const x2 = Math.min(inner.right, Math.max(inner.left, event.x));
        const y1 = Math.min(inner.bottom, Math.max(inner.top, gesture.y0));
        const y2 = Math.min(inner.bottom, Math.max(inner.top, event.y));
        gesture.band
          .attr("x", Math.min(x1, x2))
          .attr("y", Math.min(y1, y2))
          .attr("width", Math.abs(x2 - x1))
          .attr("height", Math.abs(y2 - y1));
        return;
      }

      // Pan: shift both domains so the data under the cursor tracks it.
      const x_shift = dx * gesture.x_per_px;
      const y_shift = dy * gesture.y_per_px;
      commit_viewport(
        [gesture.x_domain[0] - x_shift, gesture.x_domain[1] - x_shift],
        [gesture.y_domain[0] + y_shift, gesture.y_domain[1] + y_shift],
        base,
      );
    })
    .on("end", (event) => {
      if (!gesture) return;
      const finished = gesture;
      gesture = null;
      if (plot_area) plot_area.classList.remove("plot_area__panning");
      if (!finished.box_zoom) return;

      if (finished.band) finished.band.remove();
      const dx = Math.abs(event.x - finished.x0);
      const dy = Math.abs(event.y - finished.y0);
      // Too small to be a deliberate rectangle -- leave the view alone so the
      // click-to-zoom path (zoom modes) can handle it instead.
      if (dx < MIN_BOX_ZOOM_PX && dy < MIN_BOX_ZOOM_PX) return;

      const px_x = [finished.x0, event.x].map((value) => Math.min(inner.right, Math.max(inner.left, value)));
      const px_y = [finished.y0, event.y].map((value) => Math.min(inner.bottom, Math.max(inner.top, value)));
      const x_domain = [x_scale.invert(Math.min(...px_x)), x_scale.invert(Math.max(...px_x))];
      // Inverted because y pixels grow downward.
      const y_domain = [y_scale.invert(Math.max(...px_y)), y_scale.invert(Math.min(...px_y))];
      commit_viewport(
        dx >= MIN_BOX_ZOOM_PX ? clamp_span(x_domain, base.x) : x_scale.domain().slice(),
        dy >= MIN_BOX_ZOOM_PX ? clamp_span(y_domain, base.y) : y_scale.domain().slice(),
        base,
      );
    });

  svg.call(drag_behavior);

  // ── Wheel: zoom about the cursor in every mode ────────────────────────────
  svg.on("wheel", (event) => {
    if (!is_plot_background(event)) return;
    event.preventDefault();
    const factor = event.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR;
    zoom_about(gesture_context, factor, d3.pointer(event, svg.node()));
  });

  // ── Click: zoom in/out about the cursor while a zoom mode is active ───────
  // Deferred so the second click of a double-click cancels it (the double-click
  // resets the view instead of zooming twice on the way there).
  svg.on("click", (event) => {
    if (interaction_mode === "pan" || !is_plot_background(event)) return;
    const anchor = d3.pointer(event, svg.node());
    cancel_click_zoom();
    pending_click_zoom = window.setTimeout(() => {
      pending_click_zoom = null;
      zoom_about(gesture_context, interaction_mode === "zoom_in" ? CLICK_ZOOM_FACTOR : 1 / CLICK_ZOOM_FACTOR, anchor);
    }, CLICK_ZOOM_DELAY_MS);
  });

  // ── Double-click on empty plot space: back to the base view ───────────────
  // Curves and bars stop propagation on their own double-click (isolate a color
  // group), and the axis groups are filtered out above, so this only fires on
  // genuinely empty space.
  svg.on("dblclick", (event) => {
    if (!is_plot_background(event)) return;
    cancel_click_zoom();
    reset_plot_viewport_to_base();
  });
}
