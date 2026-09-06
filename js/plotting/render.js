// Main D3 render pass for the plot panel. This module gathers checked rows with
// loaded channel data, reads DJF pipeline masks/fits, builds histogram
// points, computes axis domains, and draws the SVG. It supports curve-only,
// curve-plus-bins, and bins-only sample histogram display modes. When modeling
// pipeline state. Curves are identified by hovering (see curve_tooltip.js) and
// isolated by color/group via double-click, rather than a fixed legend. It
// also draws axis hit areas, plot titles, readouts, and fit-result tables.
//
// AUDIT-008: this used to be a single ~1300-line file. It's now the overlay
// renderer plus orchestration only; three siblings carry the rest of what used
// to live here --
//   histogram_prep.js    per-sample data prep + caching, shared by both renderers
//   plot_accessibility.js SVG <title>/<desc>, the text-alternative table, the
//                          clipping warning
//   ridge_review.js       the ridge small-multiples view + manual peak-region
//                          review workflow
// render_density_plot(), plot_performance, analysis_text(),
// visible_histogram_range(), VISIBLE_HISTOGRAM_RANGE_CONTRACT and
// build_fit_series_entry() are re-exported here at their original path because
// tests/unit/test_harness.html does `import * as PlotRender from
// "/js/plotting/render.js"` and several Python driving-code tests call
// window.PlotRender.<name>(...) directly -- that import path is a contract,
// independent of which file now defines each symbol.

import * as d3 from "d3";
import {
  plot_area,
  plot_channels,
  plot_color_by_select,
  plot_bin_count,
  plot_display_mode,
  plot_view_mode,
  ridge_focus_name,
  plot_viewport,
  plottable_rows,
  axis_opts,
  build_color_assigner,
  axis_range_override,
  set_last_auto_x_range,
  set_last_auto_y_max,
  get_isolated_color_group,
  toggle_isolated_color_group,
  set_last_series,
  set_row_colors,
  PLOT_MARGIN,
  PLOT_FALLBACK_WIDTH,
  PLOT_FALLBACK_HEIGHT,
  AXIS_LINE_WIDTH,
  AXIS_TICK_FONT_SIZE,
  AXIS_TITLE_FONT_SIZE,
  AXIS_LABEL_COLOR,
  AXIS_HIT_PAD,
  X_AXIS_TICKS,
  Y_AXIS_TICKS,
  X_TITLE_OFFSET,
  Y_TITLE_OFFSET,
  SAMPLE_LINE_WIDTH,
  SAMPLE_BIN_OPACITY_WITH_CURVE,
  SAMPLE_BIN_OPACITY_ONLY,
  SAMPLE_BIN_WIDTH_RATIO,
  CURVE_HOVER_HIT_WIDTH,
  ISOLATED_DIM_OPACITY,
  DJF_G1_COLOR,
  DJF_S_COLOR,
  DJF_G2_COLOR,
  DJF_TOTAL_COLOR,
  DJF_DEBRIS_COLOR,
  DJF_AGG_COLOR,
  DJF_FILL_OPACITY,
  DJF_COMPONENT_LINE_WIDTH,
  DJF_TOTAL_LINE_WIDTH,
} from "./data.js";
import { update_plot_title, render_fit_results_table } from "./modeling.js";
import { show_curve_tooltip, hide_curve_tooltip } from "./curve_tooltip.js";
import { render_peak_region_overlay } from "./peak_region_overlay.js";
import { install_plot_interactions, set_plot_renderer } from "./plot_viewport.js";
import {
  SAMPLE_LINE_STYLES,
  plot_performance,
  prepare_row,
  prepared_histogram,
  prune_plot_compute_cache,
  replace_plot_caches,
  clipping_stats,
  pipeline_fit_for_series,
  plot_controls_offset,
  build_fit_series_entry,
  VISIBLE_HISTOGRAM_RANGE_CONTRACT,
  visible_histogram_range,
} from "./histogram_prep.js";
import {
  analysis_text,
  make_plot_accessible,
  render_plot_accessibility_summary,
  render_plot_clipping_warning,
} from "./plot_accessibility.js";
import { render_ridge_plot, remove_ridge_review_bar, render_ridge_review_header } from "./ridge_review.js";

// Re-exported at their original render.js path -- see the AUDIT-008 note
// above. Each is imported normally above (not `export { x } from "..."`)
// because build_fit_series_entry/plot_performance/analysis_text are pure
// re-exports (nothing below calls them directly) while visible_histogram_range
// and VISIBLE_HISTOGRAM_RANGE_CONTRACT are both used below AND re-exported.
export { plot_performance, analysis_text, visible_histogram_range, VISIBLE_HISTOGRAM_RANGE_CONTRACT, build_fit_series_entry };

// Last non-empty x-range and y-max, reused to keep the axes drawn (not collapsed)
// when no samples are selected. Only this render pass reads or writes them.
let last_range = null;
let last_y_max = null;

// The histogram bin a data-space x falls in, for a series entry, as
// { left, right, count } -- or null if x is outside the histogram range or the
// entry has no bin data. Drives the hover tooltip's bin readout.
function bin_at_data_x(entry, data_x) {
  const summary = entry.histogram;
  if (!summary || !summary.binEdges || !summary.counts || !summary.counts.length) return null;
  const edges = summary.binEdges;
  if (!(data_x >= edges[0] && data_x <= edges[edges.length - 1])) return null;
  let index = d3.bisectRight(edges, data_x) - 1;
  index = Math.max(0, Math.min(summary.counts.length - 1, index));
  return { left: edges[index], right: edges[index + 1], count: summary.counts[index] };
}

/*

Purpose:
	The main render. Draws the overlaid event histograms for the currently
	checked samples with D3, applying the controls (color-by, axis scale, bins).
	When DJF pipeline state exists it overlays the stored fitted curve and filled
	G1/S/G2/contamination components. It also draws the report table and updates
	the title; numeric work itself is run only by the manual pipeline UI. Samples
	are identified by hovering their curve (curve_tooltip.js), not a legend.

Input:
	(none)

Output:
	(none) [void]: rebuilds the #plot_area SVG

*/
export function render_density_plot() {
  if (!plot_area || !plot_channels) return;

  // The manual-review bar lives above the plot (outside #plot_area); clear it on
  // every render so it only appears while a sample is blown up for review.
  remove_ridge_review_bar();
  plot_area.parentElement?.querySelector(":scope > .plot_accessibility_summary")?.remove();

  // Ridge view: stacked per-sample small-multiples for multi-sample review.
  // Skipped when a single sample is "blown up" for manual review
  // (ridge_focus_name), which falls through to the normal single-sample overlay.
  if (plot_view_mode === "ridge" && !ridge_focus_name && plottable_rows().length > 0) {
    render_ridge_plot();
    return;
  }

  // When a ridge row is blown up for review, render just that one sample so the
  // full plot (with its draggable region handles) is dedicated to editing it.
  let rows = plottable_rows();
  if (ridge_focus_name) rows = rows.filter((row) => row.name === ridge_focus_name);
  prune_plot_compute_cache(rows);

  plot_area.innerHTML = "";
  const is_log = false;
  const color_by = plot_color_by_select ? plot_color_by_select.value : "file";
  const bins = plot_bin_count();
  const display_mode = typeof plot_display_mode === "function" ? plot_display_mode() : "curve";
  const show_bins = display_mode === "bins" || display_mode === "curve_bins";
  const show_curves = display_mode !== "bins";

  const prepared_rows = rows.map((row) => ({ row, prepared: prepare_row(row) }));

  // With samples, compute the range from the plotted events and remember it;
  // with none, keep the axes by reusing the last range.
  let range;
  if (prepared_rows.length) {
    range = visible_histogram_range(prepared_rows, is_log);
    last_range = range;
  } else if (last_range && (!is_log || last_range[0] > 0)) {
    range = is_log ? last_range : [0, Math.max(last_range[1], 1)];
  } else {
    range = is_log ? [1, 10] : [0, 1];
  }
  const opts = axis_opts(range, is_log, bins);

  const assign = build_color_assigner(rows, color_by);
  const series = prepared_rows.map(({ row, prepared }, index) => {
    const { color, group } = assign(row, index);
    const { points, histogram } = prepared_histogram(row.name, prepared, opts);
    return { row, name: row.name, color, group, lineStyle: SAMPLE_LINE_STYLES[index % SAMPLE_LINE_STYLES.length], values: prepared.values, stats: { ...prepared.stats, ...clipping_stats(prepared.values, histogram) }, points, histogram, pipelineState: prepared.pipelineState };
  });
  set_last_series(series);
  set_row_colors(series.map((entry) => ({ id: entry.row.id, color: entry.color, group: entry.group })));
  // If the isolated group no longer matches anything currently plotted (its
  // samples got unchecked, filtered out, etc.), drop the isolation instead of
  // leaving every curve dimmed with nothing left highlighted.
  let isolated_group = get_isolated_color_group();
  if (isolated_group != null && !series.some((entry) => entry.group === isolated_group)) {
    toggle_isolated_color_group(isolated_group); // same value in -> clears back to null
    isolated_group = null;
  }
  replace_plot_caches(series);

  update_plot_title(rows, series.reduce((sum, item) => sum + item.values.length, 0));

  // Dean-Jett-Fox: draw whichever stored fit currently exists per sample.
  const fits = series.map(pipeline_fit_for_series).filter(Boolean);

  const width = plot_area.clientWidth || PLOT_FALLBACK_WIDTH;
  const height = plot_area.clientHeight || PLOT_FALLBACK_HEIGHT;
  const margin = width < 700
    ? { top: PLOT_MARGIN.top, right: Math.max(100, Math.round(width * 0.3)), bottom: 42, left: 52 }
    : PLOT_MARGIN;
  const x_tick_count = width < 480 ? 3 : width < 700 ? 4 : X_AXIS_TICKS;
  const y_tick_count = height < 360 ? 3 : Y_AXIS_TICKS;

  // Auto-computed bounds (from the data) are what "empty field = auto" falls
  // back to; a user override, when present and valid, wins over them.
  const auto_x_range = range;
  let base_x_domain = [
    axis_range_override.x_min != null ? axis_range_override.x_min : auto_x_range[0],
    axis_range_override.x_max != null ? axis_range_override.x_max : auto_x_range[1],
  ];
  if (!(base_x_domain[1] > base_x_domain[0])) base_x_domain = auto_x_range;
  // The interactive pan/zoom viewport (display-only) overrides the base domain
  // for viewing; double-click resets it back to base_x_domain.
  const x_domain = plot_viewport.x || base_x_domain;

  const x_scale = (is_log ? d3.scaleLog() : d3.scaleLinear())
    .domain(x_domain)
    .range([margin.left, width - margin.right]);
  let y_max = d3.max(series, (s) => d3.max(s.points, (pt) => pt.y)) || 0;
  for (const fit of fits) y_max = Math.max(y_max, d3.max(fit.total, (pt) => pt.y) || 0);
  // Remember the populated y-max so an empty plot keeps the same y-scale.
  if (y_max > 0) {
    last_y_max = y_max;
  } else {
    y_max = last_y_max || 1;
  }
  const auto_y_max = y_max;
  let base_y_domain = [
    axis_range_override.y_min != null ? axis_range_override.y_min : 0,
    axis_range_override.y_max != null ? axis_range_override.y_max : auto_y_max,
  ];
  if (!(base_y_domain[1] > base_y_domain[0])) base_y_domain = [0, auto_y_max];
  const y_domain = plot_viewport.y || base_y_domain;
  const y_scale = d3.scaleLinear().domain(y_domain);
  // Only auto-round to "nice" bounds when both ends are auto-computed and no
  // pan/zoom viewport is active; an explicit user bound or a zoom should be
  // drawn exactly.
  if (!plot_viewport.y && axis_range_override.y_min == null && axis_range_override.y_max == null) y_scale.nice();
  y_scale.range([height - margin.bottom, margin.top]);

  // Remembered so the axis-range modal can show live placeholders for both
  // axes no matter which one was double-clicked to open it.
  set_last_auto_x_range(auto_x_range);
  set_last_auto_y_max(auto_y_max);

  const svg = d3.select(plot_area).append("svg").attr("width", width).attr("height", height);

  // Clip the data curves to the plot area so a zoomed-in axis range doesn't
  // draw curve segments over the axis labels or legend.
  const clip_id = `plot_clip_${Math.round(Math.random() * 1e9)}`;
  svg.append("defs").append("clipPath").attr("id", clip_id).append("rect")
    .attr("x", margin.left).attr("y", margin.top)
    .attr("width", Math.max(0, width - margin.right - margin.left))
    .attr("height", Math.max(0, height - margin.bottom - margin.top));

  // Apply tick font size + axis line width to a rendered axis group.
  const style_axis = (g) => {
    g.style("font-size", `${AXIS_TICK_FONT_SIZE}px`);
    g.selectAll(".domain, .tick line").attr("stroke-width", AXIS_LINE_WIDTH);
    return g;
  };

  // Each axis is wrapped in its own group with an invisible, generously
  // padded hit-area rect (fill: transparent still receives pointer events)
  // so double-clicking near the ticks reliably opens the range modal instead
  // of requiring a precise hit on a thin tick line or label.
  // stopPropagation so the double-click doesn't also reach the SVG-level
  // viewport reset (plot_viewport.js) -- opening the range modal is the whole
  // intent of a double-click here.
  const x_axis_group = svg.append("g").attr("class", "x_axis_group")
    .on("dblclick", (event) => {
      event.stopPropagation();
      document.dispatchEvent(new CustomEvent("pf-open-axis-range", { detail: { axis: "x" } }));
    });
  x_axis_group.append("rect")
    .attr("class", "axis_hit_area")
    .attr("x", margin.left)
    .attr("y", height - margin.bottom - AXIS_HIT_PAD)
    .attr("width", Math.max(0, width - margin.right - margin.left))
    .attr("height", margin.bottom + AXIS_HIT_PAD)
    .attr("fill", "transparent");
  style_axis(x_axis_group.append("g")
    .attr("transform", `translate(0,${height - margin.bottom})`)
    .call(d3.axisBottom(x_scale).ticks(x_tick_count, is_log ? "~s" : undefined)));
  x_axis_group.append("text")
    .attr("class", "plot_axis_title")
    .attr("x", (margin.left + width - margin.right) / 2)
    .attr("y", height - X_TITLE_OFFSET)
    .attr("text-anchor", "middle")
    .attr("font-size", AXIS_TITLE_FONT_SIZE)
    .attr("fill", AXIS_LABEL_COLOR)
    .text(plot_channels.dna_area || "DNA-content area");

  const y_axis_group = svg.append("g").attr("class", "y_axis_group")
    .on("dblclick", (event) => {
      event.stopPropagation();
      document.dispatchEvent(new CustomEvent("pf-open-axis-range", { detail: { axis: "y" } }));
    });
  y_axis_group.append("rect")
    .attr("class", "axis_hit_area")
    .attr("x", 0)
    .attr("y", margin.top)
    .attr("width", margin.left + AXIS_HIT_PAD)
    .attr("height", Math.max(0, height - margin.bottom - margin.top))
    .attr("fill", "transparent");
  style_axis(y_axis_group.append("g")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y_scale).ticks(y_tick_count, "~s")));
  y_axis_group.append("text")
    .attr("class", "plot_axis_title")
    .attr("transform", "rotate(-90)")
    .attr("x", -(margin.top + height - margin.bottom) / 2)
    .attr("y", Y_TITLE_OFFSET)
    .attr("text-anchor", "middle")
    .attr("font-size", AXIS_TITLE_FONT_SIZE)
    .attr("fill", AXIS_LABEL_COLOR)
    .text("Number of Events");

  const line = d3.line()
    .defined((d) => !is_log || d.x > 0)
    .x((d) => x_scale(d.x))
    .y((d) => y_scale(d.y))
    .curve(d3.curveBasis);

  // Shared interaction helpers, used by both the bin rects and the curve
  // hit-paths so hovering a bar body or a curve behaves identically.
  const isolate_on_dblclick = (event, group) => {
    event.stopPropagation();
    toggle_isolated_color_group(group);
    hide_curve_tooltip();
    render_density_plot();
  };
  // The { left, right, count } for a known bin index of a sample (used when the
  // exact bin is already known, i.e. hovering a specific bar).
  const bin_from_index = (sample, index) => {
    const edges = sample.histogram && sample.histogram.binEdges;
    if (!edges || edges[index] == null || edges[index + 1] == null) return null;
    return { left: edges[index], right: edges[index + 1], count: sample.points[index]?.y };
  };

  if (show_bins) {
    const bar_opacity = show_curves ? SAMPLE_BIN_OPACITY_WITH_CURVE : SAMPLE_BIN_OPACITY_ONLY;
    const bar_base_y = y_scale(Math.max(y_domain[0], 0));
    const bins_group = svg.append("g").attr("clip-path", `url(#${clip_id})`);
    series.forEach((sample) => {
      const edges = sample.histogram && sample.histogram.binEdges;
      const in_isolated_group = !isolated_group || sample.group === isolated_group;
      bins_group.append("g")
        .attr("fill", sample.color)
        .attr("fill-opacity", in_isolated_group ? bar_opacity : bar_opacity * ISOLATED_DIM_OPACITY)
        .selectAll("rect")
        .data(sample.points.map((point, index) => ({ point, index })))
        .join("rect")
        .attr("x", ({ point, index }) => {
          if (edges && edges[index] != null && edges[index + 1] != null) {
            const x0 = x_scale(edges[index]);
            const x1 = x_scale(edges[index + 1]);
            const width_px = Math.abs(x1 - x0) * SAMPLE_BIN_WIDTH_RATIO;
            return Math.min(x0, x1) + (Math.abs(x1 - x0) - width_px) / 2;
          }
          return x_scale(point.x) - 1;
        })
        .attr("y", ({ point }) => Math.min(y_scale(point.y), bar_base_y))
        .attr("width", ({ index }) => {
          if (edges && edges[index] != null && edges[index + 1] != null) {
            return Math.max(1, Math.abs(x_scale(edges[index + 1]) - x_scale(edges[index])) * SAMPLE_BIN_WIDTH_RATIO);
          }
          return 2;
        })
        .attr("height", ({ point }) => Math.abs(bar_base_y - y_scale(point.y)))
        // Each bar is itself hoverable so the tooltip fires anywhere over the
        // bar body, not only near the top envelope where the curve hit-path
        // sits (which matters most in bins-only mode). The exact bin is known
        // from the bound datum, so no cursor-to-bin lookup is needed here.
        .style("cursor", "pointer")
        .on("pointerenter pointermove", (event, { index }) =>
          show_curve_tooltip(event, sample, bin_from_index(sample, index)))
        .on("pointerleave", hide_curve_tooltip)
        .on("dblclick", (event) => isolate_on_dblclick(event, sample.group));
    });
  }

  if (show_curves) {
    // Visible curves: dimmed when a different color group is isolated. The
    // interactive hit-paths are drawn separately below (always, even in
    // bins-only mode) so hover/isolate work regardless of display mode.
    svg.append("g")
      .attr("clip-path", `url(#${clip_id})`)
      .selectAll("path")
      .data(series)
      .join("path")
      .attr("fill", "none")
      .attr("stroke", (d) => d.color)
      .attr("stroke-width", SAMPLE_LINE_WIDTH)
      .attr("stroke-dasharray", (d) => d.lineStyle)
      .attr("stroke-opacity", (d) => (!isolated_group || d.group === isolated_group) ? 1 : ISOLATED_DIM_OPACITY)
      .attr("d", (d) => line(d.points));
  }

  // Each shown fit: filled G1/S/G2 components (semi-transparent so overlaps
  // show) with solid outlines, plus the fitted total on top.
  const area = d3.area()
    .defined((d) => !is_log || d.x > 0)
    .x((d) => x_scale(d.x))
    .y0(y_scale(0))
    .y1((d) => y_scale(d.y))
    .curve(d3.curveBasis);

  fits.forEach((fit) => {
    const overlay = svg.append("g").attr("clip-path", `url(#${clip_id})`);
    const component = (data, color, line_style) => {
      overlay.append("path").attr("fill", color).attr("fill-opacity", DJF_FILL_OPACITY).attr("stroke", "none").attr("d", area(data));
      overlay.append("path").attr("fill", "none").attr("stroke", AXIS_LABEL_COLOR).attr("stroke-width", DJF_COMPONENT_LINE_WIDTH).attr("stroke-dasharray", line_style).attr("d", line(data));
    };
    component(fit.g1, DJF_G1_COLOR, null);
    component(fit.s, DJF_S_COLOR, "7 3");
    component(fit.g2, DJF_G2_COLOR, "2 2");
    if (fit.debris) component(fit.debris, DJF_DEBRIS_COLOR, "9 2 2 2");
    if (fit.aggregate) component(fit.aggregate, DJF_AGG_COLOR, "1 2");
    overlay.append("path").attr("fill", "none").attr("stroke", DJF_TOTAL_COLOR).attr("stroke-width", DJF_TOTAL_LINE_WIDTH).attr("d", line(fit.total));
  });

  // Invisible wide hit-targets following each sample's histogram shape, drawn
  // last so they sit above the curves/bins/fits and reliably receive pointer
  // events. Each is a fully transparent, much wider (CURVE_HOVER_HIT_WIDTH)
  // stroke than the 1.5px visible line, so a thin curve is easy to hover or
  // double-click. Drawn in every display mode (curve, curve+bins, bins-only),
  // so hovering works even when only bars are shown. Hover shows the sample's
  // tooltip with the histogram bin under the cursor's x; double-click isolates
  // that color group (a dimmed curve stays interactive so it can still be
  // identified or re-isolated).
  svg.append("g")
    .attr("clip-path", `url(#${clip_id})`)
    .selectAll("path")
    .data(series)
    .join("path")
    .attr("fill", "none")
    .attr("stroke", "transparent")
    .attr("stroke-width", CURVE_HOVER_HIT_WIDTH)
    .style("pointer-events", "stroke")
    .style("cursor", "pointer")
    .attr("d", (d) => line(d.points))
    .on("pointerenter pointermove", (event, d) => {
      const data_x = x_scale.invert(d3.pointer(event, svg.node())[0]);
      show_curve_tooltip(event, d, bin_at_data_x(d, data_x));
    })
    .on("pointerleave", hide_curve_tooltip)
    .on("dblclick", (event, d) => isolate_on_dblclick(event, d.group));

  // Draggable G1/G2 region handles for whichever sample Identify Peaks is
  // currently reviewing, drawn last so they sit above everything else and
  // reliably receive pointer events. Wrapped defensively: this is optional
  // decoration, and letting it throw would abort the fit-results table below
  // and the pf-plot-rendered dispatch every other listener (including the
  // sidebar's own refresh) depends on.
  try {
    render_peak_region_overlay({ svg, series, x_scale, y_scale, margin, height, clipId: clip_id });
  } catch (error) {
    console.error("Peak region overlay failed to render:", error);
  }

  // Display-only pan/zoom gestures (plot_viewport.js). Installed last so its
  // interaction surface is inserted under the drawn layers while its SVG-level
  // listeners see everything that bubbles. Wrapped for the same reason as the
  // overlay above: it is optional interactivity, and a throw here must not cost
  // the fit table or the pf-plot-rendered dispatch below.
  try {
    install_plot_interactions({
      svg, x_scale, y_scale, margin, width, height,
      base_x_domain, base_y_domain,
    });
  } catch (error) {
    console.error("Plot pan/zoom interactions failed to install:", error);
  }

  // No legend: samples are identified by hovering their curve (curve_tooltip.js)
  // and DJF fit components keep their fixed reference colors (G1/S/G2/etc.)
  // without needing a label, since there's only ever this one small fixed set.

  // LEGACY-01: only canonical models report numbers. The legacy bridge is an
  // unvalidated compatibility path (different likelihood and contamination
  // equations, no result-contract gate), so it never populates the fit-results
  // table -- previously it did, as soon as a sample had completed the legacy
  // stage-8 report. A canonical result needs no separate report step:
  // fit_cell_cycle_model()'s result is already final.
  render_fit_results_table(fits, {
    // Sit below the floating top-right controls so they don't overlap.
    top: Math.max(margin.top, plot_controls_offset()),
    right: 8,
    max_width: Math.max(190, margin.right - 18),
  });

  make_plot_accessible(svg, { mode: "Overlay", entries: series, fits, x_domain, y_domain });
  render_plot_accessibility_summary(series, fits, x_domain, y_domain);
  render_plot_clipping_warning(series);

  // In a ridge blow-up, overlay a header bar with the sample name, an "Under
  // manual review" badge, and Accept (returns to the ridge).
  if (ridge_focus_name) render_ridge_review_header(ridge_focus_name);

  // Lets the metadata table keep its per-row color swatches in sync (see
  // sync_filename_swatches in table_render.js) without this module reaching
  // into the UI layer directly, and without the table doing a full rebuild
  // on every redraw -- this fires on every one, including high-frequency
  // ones like dragging the bin-count control.
  document.dispatchEvent(new CustomEvent("pf-plot-rendered"));
}

set_plot_renderer(render_density_plot);
