// Main D3 render pass for the plot panel. This module gathers checked rows with
// loaded channel data, applies optional DJF preprocessing, builds histogram
// points, computes axis domains, and draws the SVG. It supports curve-only,
// curve-plus-bins, and bins-only sample histogram display modes. When modeling
// is active (or a debris/doublet correction is enabled) it uses the lazily loaded
// DJF numeric stack; the histogram always draws immediately and DJF is fetched in
// the background, triggering a redraw once ready. It also draws legends, threshold
// controls, axis hit areas, plot titles, readouts, and fit-result tables.

import * as d3 from "d3";
import {
  plot_area,
  plot_channels,
  djf_readout,
  plot_color_by_select,
  plot_bin_count,
  plot_display_mode,
  correction_state,
  shared_range_for_values,
  axis_opts,
  build_color_assigner,
  histogram_curve,
  build_histogram_summary,
  loaded_rows_for_active_channel,
  plottable_rows,
  set_last_series,
  series_by_name,
  histograms_by_name,
  axis_range_override,
  modeling_started,
  shown_fits,
  peak_threshold,
  set_peak_threshold,
  set_last_auto_x_range,
  set_last_auto_y_max,
  strip_fcs,
  plot_threshold_toggle,
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
  DJF_G1_COLOR,
  DJF_S_COLOR,
  DJF_G2_COLOR,
  DJF_TOTAL_COLOR,
  DJF_FILL_OPACITY,
  DJF_COMPONENT_LINE_WIDTH,
  DJF_TOTAL_LINE_WIDTH,
  LEGEND_OFFSET_X,
  LEGEND_ROW_HEIGHT,
  LEGEND_SWATCH_WIDTH,
  LEGEND_TEXT_OFFSET,
  LEGEND_LINE_WIDTH,
  LEGEND_FONT_SIZE,
  LEGEND_SWATCH_Y,
  LEGEND_TEXT_Y,
  LEGEND_CHECKBOX_SIZE,
  THRESHOLD_COLOR,
  THRESHOLD_LINE_WIDTH,
  THRESHOLD_FILL_OPACITY,
  THRESHOLD_HANDLE_WIDTH,
  THRESHOLD_LABEL_FONT_SIZE,
  THRESHOLD_LABEL_COLOR,
  THRESHOLD_LABEL_X_OFFSET,
  THRESHOLD_LABEL_Y_OFFSET,
  THRESHOLD_LABEL_TOP_PAD,
} from "./data.js";
import { get_parsed_files } from "../state/files.js";
import { load_djf, get_djf } from "./djf_loader.js";
import { update_plot_title, toggle_fit, render_fit_results_table } from "./modeling.js";
import { open_axis_range_modal } from "./axis_modal.js";

// Last non-empty x-range and y-max, reused to keep the axes drawn (not collapsed)
// when no samples are selected. Only this render pass reads or writes them.
let last_range = null;
let last_y_max = null;

/*

Purpose:
	The main render. Draws the overlaid event histograms for the currently
	checked samples with D3, applying the controls (color-by, axis scale, bins).
	When a sample is chosen under Model (DJF) it overlays the fitted curve and
	filled G1/S/G2 components, a draggable peak-threshold line, and a fraction
	readout. Also draws the legend and updates the title. DJF is loaded lazily;
	the histogram draws immediately and the fit/correction pass redraws once the
	numeric stack has loaded.

Input:
	(none)

Output:
	(none) [void]: rebuilds the #plot_area SVG

*/
export function render_density_plot() {
  if (!plot_area || !plot_channels) return;

  const rows = plottable_rows();

  plot_area.innerHTML = "";
  if (djf_readout) djf_readout.textContent = "";

  const is_log = false;
  const color_by = plot_color_by_select ? plot_color_by_select.value : "file";
  const bins = plot_bin_count();
  const display_mode = typeof plot_display_mode === "function" ? plot_display_mode() : "curve";
  const show_bins = display_mode === "bins" || display_mode === "curve_bins";
  const show_curves = display_mode !== "bins";
  const corrections = correction_state();

  // The DJF numeric stack is only needed for corrections and fitting. Load it on
  // demand the first time either is requested; draw raw meanwhile and redraw when
  // the module resolves.
  const djf = get_djf();
  const needs_djf = modeling_started || corrections.remove_debris || corrections.remove_doublets;
  if (needs_djf && !djf) {
    load_djf().then(() => render_density_plot()).catch(() => {
      if (djf_readout) djf_readout.textContent = "Cell-cycle modeling failed to load.";
    });
  }

  const prepared_rows = rows.map((row) => ({
    row,
    prepared: djf ? djf.prepare_row(row, corrections) : { values: row.data.dna_a, stats: { raw: row.data.dna_a.length, plotted: row.data.dna_a.length } },
  }));

  // With samples, compute the range from the plotted events and remember it;
  // with none, keep the axes by reusing the last range.
  let range;
  if (prepared_rows.length) {
    range = shared_range_for_values(prepared_rows.map((entry) => entry.prepared.values), is_log);
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
    const points = histogram_curve(prepared.values, opts);
    return { row, name: row.name, color, group, values: prepared.values, stats: prepared.stats, points, histogram: build_histogram_summary(points, opts) };
  });
  set_last_series(series);
  series.forEach((entry) => {
    series_by_name.set(entry.name, entry);
    histograms_by_name.set(entry.name, entry.histogram);
  });

  // Also compute histograms for loaded-but-unchecked files (not drawn, so no
  // color/group), using the same bins/range/corrections as the current plot,
  // so window.PhaseFinder.plot.get_histogram() works for every loaded sample
  // regardless of its table checkbox state.
  const plotted_names = new Set(series.map((entry) => entry.name));
  loaded_rows_for_active_channel(get_parsed_files())
    .filter((row) => !plotted_names.has(row.name))
    .forEach((row) => {
      const prepared = djf ? djf.prepare_row(row, corrections) : { values: row.data.dna_a, stats: { raw: row.data.dna_a.length, plotted: row.data.dna_a.length } };
      const points = histogram_curve(prepared.values, opts);
      const entry = { row, name: row.name, color: null, group: null, values: prepared.values, stats: prepared.stats, points, histogram: build_histogram_summary(points, opts) };
      series_by_name.set(entry.name, entry);
      histograms_by_name.set(entry.name, entry.histogram);
    });

  update_plot_title(rows, series.reduce((sum, item) => sum + item.values.length, 0));

  // Dean-Jett-Fox: one independent fit per shown sample (linear axis only). The
  // peak-detection threshold is a single draggable line shared by all fits;
  // default 5% of the tallest shown bin.
  const fits = [];
  let threshold_value = null;
  const correction_text = djf ? djf.correction_summary(prepared_rows, corrections) : "";
  if (modeling_started && rows.length) {
    if (is_log) {
      if (djf_readout) djf_readout.textContent = "DJF requires a linear X-axis.";
    } else if (!djf) {
      if (djf_readout) djf_readout.textContent = "Loading cell-cycle modeling…";
    } else {
      const shown_series = series.filter((s) => shown_fits.has(s.name));
      if (shown_series.length) {
        const shown_max = d3.max(shown_series, (s) => d3.max(s.points, (pt) => pt.y)) || 1;
        if (peak_threshold == null) set_peak_threshold(0.05 * shown_max);
        threshold_value = peak_threshold;
        const run_g1 = djf.estimate_run_g1(series, threshold_value);
        for (const s of shown_series) {
          const params = djf.fit(s.points, range, threshold_value, run_g1);
          if (!params) continue;
          const comps = s.points.map((pt) => ({ x: pt.x, c: djf.components(pt.x, params) }));
          const phase_stats = djf.phase_stats(s.points, params);
          fits.push({
            row: s.row,
            name: s.name,
            total: comps.map((o) => ({ x: o.x, y: o.c.g1 + o.c.s + o.c.g2 })),
            g1: comps.map((o) => ({ x: o.x, y: o.c.g1 })),
            s: comps.map((o) => ({ x: o.x, y: o.c.s })),
            g2: comps.map((o) => ({ x: o.x, y: o.c.g2 })),
            fractions: { g1: phase_stats.g1.percent, s: phase_stats.s.percent, g2: phase_stats.g2.percent },
            phase_stats,
          });
        }
      }
      if (djf_readout) {
        const fit_text = fits
          .map((fit) => `${strip_fcs(fit.name)}: G1 ${fit.fractions.g1.toFixed(1)}% · S ${fit.fractions.s.toFixed(1)}% · G2 ${fit.fractions.g2.toFixed(1)}%`)
          .join("\n");
        djf_readout.textContent = [fit_text, correction_text].filter(Boolean).join("\n");
      }
    }
  } else if (djf_readout && correction_text) {
    djf_readout.textContent = correction_text;
  }

  const width = plot_area.clientWidth || PLOT_FALLBACK_WIDTH;
  const height = plot_area.clientHeight || PLOT_FALLBACK_HEIGHT;
  const margin = PLOT_MARGIN;

  // Auto-computed bounds (from the data) are what "empty field = auto" falls
  // back to; a user override, when present and valid, wins over them.
  const auto_x_range = range;
  let x_domain = [
    axis_range_override.x_min != null ? axis_range_override.x_min : auto_x_range[0],
    axis_range_override.x_max != null ? axis_range_override.x_max : auto_x_range[1],
  ];
  if (!(x_domain[1] > x_domain[0])) x_domain = auto_x_range;

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
  let y_domain = [
    axis_range_override.y_min != null ? axis_range_override.y_min : 0,
    axis_range_override.y_max != null ? axis_range_override.y_max : auto_y_max,
  ];
  if (!(y_domain[1] > y_domain[0])) y_domain = [0, auto_y_max];
  const y_scale = d3.scaleLinear().domain(y_domain);
  // Only auto-round to "nice" bounds when both ends are auto-computed; an
  // explicit user bound should be drawn exactly as entered.
  if (axis_range_override.y_min == null && axis_range_override.y_max == null) y_scale.nice();
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
  const x_axis_group = svg.append("g").attr("class", "x_axis_group")
    .on("dblclick", () => open_axis_range_modal("x"));
  x_axis_group.append("rect")
    .attr("class", "axis_hit_area")
    .attr("x", margin.left)
    .attr("y", height - margin.bottom - AXIS_HIT_PAD)
    .attr("width", Math.max(0, width - margin.right - margin.left))
    .attr("height", margin.bottom + AXIS_HIT_PAD)
    .attr("fill", "transparent");
  style_axis(x_axis_group.append("g")
    .attr("transform", `translate(0,${height - margin.bottom})`)
    .call(d3.axisBottom(x_scale).ticks(X_AXIS_TICKS, is_log ? "~s" : undefined)));
  x_axis_group.append("text")
    .attr("class", "plot_axis_title")
    .attr("x", (margin.left + width - margin.right) / 2)
    .attr("y", height - X_TITLE_OFFSET)
    .attr("text-anchor", "middle")
    .attr("font-size", AXIS_TITLE_FONT_SIZE)
    .attr("fill", AXIS_LABEL_COLOR)
    .text(plot_channels.dna_area || "DNA-content area");

  const y_axis_group = svg.append("g").attr("class", "y_axis_group")
    .on("dblclick", () => open_axis_range_modal("y"));
  y_axis_group.append("rect")
    .attr("class", "axis_hit_area")
    .attr("x", 0)
    .attr("y", margin.top)
    .attr("width", margin.left + AXIS_HIT_PAD)
    .attr("height", Math.max(0, height - margin.bottom - margin.top))
    .attr("fill", "transparent");
  style_axis(y_axis_group.append("g")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y_scale).ticks(Y_AXIS_TICKS, "~s")));
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

  if (show_bins) {
    const bar_opacity = show_curves ? SAMPLE_BIN_OPACITY_WITH_CURVE : SAMPLE_BIN_OPACITY_ONLY;
    const bar_base_y = y_scale(Math.max(y_domain[0], 0));
    const bins_group = svg.append("g").attr("clip-path", `url(#${clip_id})`);
    series.forEach((sample) => {
      const edges = sample.histogram && sample.histogram.binEdges;
      bins_group.append("g")
        .attr("fill", sample.color)
        .attr("fill-opacity", bar_opacity)
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
        .attr("height", ({ point }) => Math.abs(bar_base_y - y_scale(point.y)));
    });
  }

  if (show_curves) {
    svg.append("g")
      .attr("clip-path", `url(#${clip_id})`)
      .selectAll("path")
      .data(series)
      .join("path")
      .attr("fill", "none")
      .attr("stroke", (d) => d.color)
      .attr("stroke-width", SAMPLE_LINE_WIDTH)
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
    const component = (data, color) => {
      overlay.append("path").attr("fill", color).attr("fill-opacity", DJF_FILL_OPACITY).attr("stroke", "none").attr("d", area(data));
      overlay.append("path").attr("fill", "none").attr("stroke", color).attr("stroke-width", DJF_COMPONENT_LINE_WIDTH).attr("d", line(data));
    };
    component(fit.g1, DJF_G1_COLOR);
    component(fit.s, DJF_S_COLOR);
    component(fit.g2, DJF_G2_COLOR);
    overlay.append("path").attr("fill", "none").attr("stroke", DJF_TOTAL_COLOR).attr("stroke-width", DJF_TOTAL_LINE_WIDTH).attr("d", line(fit.total));
  });

  // Draggable peak-detection threshold (only when the "Peak threshold" box is
  // checked): a grey line with a light fill down to 0. Drag to set the
  // event-count cutoff; on release, peaks + DJF recompute.
  const show_threshold = threshold_value != null && plot_threshold_toggle && plot_threshold_toggle.checked;
  if (show_threshold) {
    const x0 = margin.left;
    const x1 = width - margin.right;
    const base_y = height - margin.bottom;
    const group = svg.append("g");

    const position_at = (y_pix) => {
      group.select(".threshold_fill").attr("y", y_pix).attr("height", Math.max(0, base_y - y_pix));
      group.selectAll(".threshold_line").attr("y1", y_pix).attr("y2", y_pix);
      group.select(".threshold_label").attr("y", Math.max(margin.top + THRESHOLD_LABEL_TOP_PAD, y_pix - THRESHOLD_LABEL_Y_OFFSET));
    };

    group.append("rect").attr("class", "threshold_fill")
      .attr("x", x0).attr("width", x1 - x0)
      .attr("fill", THRESHOLD_COLOR).attr("opacity", THRESHOLD_FILL_OPACITY).attr("pointer-events", "none");
    group.append("line").attr("class", "threshold_line")
      .attr("x1", x0).attr("x2", x1)
      .attr("stroke", THRESHOLD_COLOR).attr("stroke-width", THRESHOLD_LINE_WIDTH).attr("pointer-events", "none");
    group.append("text").attr("class", "threshold_label")
      .attr("x", x0 + THRESHOLD_LABEL_X_OFFSET).attr("font-size", THRESHOLD_LABEL_FONT_SIZE).attr("fill", THRESHOLD_LABEL_COLOR)
      .text(`peak threshold: ${Math.round(threshold_value).toLocaleString()} events`);
    const handle = group.append("line").attr("class", "threshold_line")
      .attr("x1", x0).attr("x2", x1)
      .attr("stroke", "transparent").attr("stroke-width", THRESHOLD_HANDLE_WIDTH).attr("cursor", "ns-resize");

    position_at(y_scale(Math.min(threshold_value, y_max)));

    const clamp_value = (y_pix) => Math.max(0, Math.min(y_max, y_scale.invert(y_pix)));
    handle.call(
      d3.drag()
        .on("drag", (event) => {
          const value = clamp_value(event.y);
          position_at(y_scale(value));
          group.select(".threshold_label").text(`peak threshold: ${Math.round(value).toLocaleString()} events`);
        })
        .on("end", (event) => {
          set_peak_threshold(clamp_value(event.y));
          render_density_plot();
        }),
    );
  }

  // Legend: one row per sample (each gets a fit checkbox once modeling has
  // started), then the fitted-component rows for every shown fit. With more than
  // one fit shown, component labels are prefixed with the sample name.
  const legend_items = series.map((s) => ({ type: "sample", name: s.name, color: s.color }));
  const multiple_fits = fits.length > 1;
  fits.forEach((fit) => {
    const prefix = multiple_fits ? `${strip_fcs(fit.name)} ` : "";
    legend_items.push(
      { type: "component", label: `${prefix}DJF fit`, color: DJF_TOTAL_COLOR },
      { type: "component", label: `${prefix}G1`, color: DJF_G1_COLOR },
      { type: "component", label: `${prefix}S`, color: DJF_S_COLOR },
      { type: "component", label: `${prefix}G2`, color: DJF_G2_COLOR },
    );
  });

  const checkbox_col = modeling_started ? LEGEND_CHECKBOX_SIZE + 6 : 0;
  const legend = svg.append("g").attr("transform", `translate(${width - margin.right + LEGEND_OFFSET_X},${margin.top})`);
  const items = legend.selectAll("g").data(legend_items).join("g").attr("transform", (d, i) => `translate(0,${i * LEGEND_ROW_HEIGHT})`);

  if (modeling_started) {
    // Clickable checkbox on each sample row to show/hide that sample's fit.
    const sample_rows = items.filter((d) => d.type === "sample").attr("cursor", "pointer").on("click", (event, d) => toggle_fit(d.name));
    sample_rows.append("rect")
      .attr("x", 0).attr("y", LEGEND_SWATCH_Y - LEGEND_CHECKBOX_SIZE / 2)
      .attr("width", LEGEND_CHECKBOX_SIZE).attr("height", LEGEND_CHECKBOX_SIZE).attr("rx", 2)
      .attr("fill", "#fff").attr("stroke", THRESHOLD_COLOR);
    sample_rows.filter((d) => shown_fits.has(d.name)).append("path")
      .attr("d", `M2,${LEGEND_SWATCH_Y} l2.5,2.5 l5,-5`)
      .attr("fill", "none").attr("stroke", DJF_TOTAL_COLOR).attr("stroke-width", 1.6).attr("pointer-events", "none");
  }

  items.append("line")
    .attr("x1", checkbox_col).attr("x2", checkbox_col + LEGEND_SWATCH_WIDTH)
    .attr("y1", LEGEND_SWATCH_Y).attr("y2", LEGEND_SWATCH_Y)
    .attr("stroke", (d) => d.color).attr("stroke-width", LEGEND_LINE_WIDTH);
  items.append("text")
    .attr("x", checkbox_col + LEGEND_TEXT_OFFSET).attr("y", LEGEND_TEXT_Y)
    .attr("font-size", LEGEND_FONT_SIZE).attr("fill", AXIS_LABEL_COLOR)
    .text((d) => (d.type === "sample" ? strip_fcs(d.name) : d.label));

  render_fit_results_table(fits, {
    top: margin.top + legend_items.length * LEGEND_ROW_HEIGHT + 12,
    right: 8,
    max_width: Math.max(190, margin.right - 18),
  });
}
