// Main D3 render pass for the plot panel. This module gathers checked rows with
// loaded channel data, reads staged DJF masks/fits, builds histogram
// points, computes axis domains, and draws the SVG. It supports curve-only,
// curve-plus-bins, and bins-only sample histogram display modes. When modeling
// pipeline state. It also draws legends, axis hit areas, plot titles, readouts,
// and fit-result tables.

import * as d3 from "d3";
import {
  plot_area,
  plot_channels,
  djf_readout,
  plot_color_by_select,
  plot_bin_count,
  plot_display_mode,
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
  set_last_auto_x_range,
  set_last_auto_y_max,
  strip_fcs,
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
  DJF_DEBRIS_COLOR,
  DJF_AGG_COLOR,
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
} from "./data.js";
import { get_parsed_files } from "../state/files.js";
import { update_plot_title, render_fit_results_table } from "./modeling.js";
import { open_axis_range_modal } from "./axis_modal.js";
import { get_state as get_pipeline_state } from "../analysis/djf/pipeline_state.js";

// Last non-empty x-range and y-max, reused to keep the axes drawn (not collapsed)
// when no samples are selected. Only this render pass reads or writes them.
let last_range = null;
let last_y_max = null;

function active_pipeline_state(row) {
  const state = get_pipeline_state(row.name);
  return state && state.channelKey === row.data?.channel_key ? state : null;
}

function compact_final_values(row) {
  const values = row.data.channels?.DNA_A || row.data.dna_a || [];
  const mask = row.data.masks?.final;
  if (!mask || mask.length !== values.length) return values;
  const retained = [];
  for (let index = 0; index < values.length; index += 1) {
    if (mask[index] && Number.isFinite(values[index])) retained.push(values[index]);
  }
  return retained;
}

function stage_histogram_summary(histogram) {
  const binEdges = new Array(histogram.binCount + 1);
  for (let index = 0; index <= histogram.binCount; index += 1) {
    binEdges[index] = histogram.min + index * histogram.binWidth;
  }
  return {
    binEdges,
    binCenters: [...histogram.x],
    counts: [...histogram.y],
    binWidth: histogram.binWidth,
    min: histogram.min,
    max: histogram.max,
  };
}

function component_moments(x, values) {
  if (!values || values.length !== x.length) return { total: 0, mean: NaN, stdev: NaN };
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (!(total > 0)) return { total: 0, mean: NaN, stdev: NaN };
  let mean = 0;
  for (let index = 0; index < values.length; index += 1) {
    mean += x[index] * Math.max(0, values[index]);
  }
  mean /= total;
  let variance = 0;
  for (let index = 0; index < values.length; index += 1) {
    variance += Math.max(0, values[index]) * (x[index] - mean) ** 2;
  }
  return { total, mean, stdev: Math.sqrt(variance / total) };
}

function pipeline_fit_for_series(series_entry) {
  const state = active_pipeline_state(series_entry.row);
  const fit = state && (state.extendedFit || state.baseFit);
  if (!fit?.curves?.x || !fit.curves.fitted) return null;

  const x = fit.curves.x;
  const point_series = (values) => x.map((position, index) => ({
    x: position,
    y: Number(values?.[index]) || 0,
  }));
  const moments = {
    g1: component_moments(x, fit.curves.g1),
    s: component_moments(x, fit.curves.s),
    g2: component_moments(x, fit.curves.g2),
  };
  const biologicalTotal = moments.g1.total + moments.s.total + moments.g2.total;
  const reportedFractions = state.report?.fractions?.biologicalSinglets;
  const reportFractionByKey = {
    g1: reportedFractions?.oneC,
    s: reportedFractions?.sPhase,
    g2: reportedFractions?.twoC,
  };
  const phase = (key, label) => ({
    phase: label,
    percent: Number.isFinite(reportFractionByKey[key])
      ? 100 * reportFractionByKey[key]
      : biologicalTotal > 0 ? (100 * moments[key].total) / biologicalTotal : 0,
    mean: moments[key].mean,
    stdev: moments[key].stdev,
  });
  const phase_stats = {
    g1: phase("g1", "G1 / 1C"),
    s: phase("s", "S"),
    g2: phase("g2", "G2/M / 2C"),
  };

  return {
    row: series_entry.row,
    name: series_entry.name,
    total: point_series(fit.curves.fitted),
    g1: point_series(fit.curves.g1),
    s: point_series(fit.curves.s),
    g2: point_series(fit.curves.g2),
    debris: fit.selectedModel?.includes("debris") && fit.curves.debris
      ? point_series(fit.curves.debris)
      : null,
    aggregate: fit.selectedModel?.includes("aggregate") && fit.curves.aggregate
      ? point_series(fit.curves.aggregate)
      : null,
    fractions: {
      g1: phase_stats.g1.percent,
      s: phase_stats.s.percent,
      g2: phase_stats.g2.percent,
    },
    phase_stats,
    pipelineState: state,
  };
}

/*

Purpose:
	The main render. Draws the overlaid event histograms for the currently
	checked samples with D3, applying the controls (color-by, axis scale, bins).
	When staged DJF state exists it overlays the stored fitted curve and filled
	G1/S/G2/contamination components. It also draws the legend, report table, and
	updates the title; numeric work itself is run only by the manual stage UI.

Input:
	(none)

Output:
	(none) [void]: rebuilds the #plot_area SVG

*/
export function render_density_plot() {
  if (!plot_area || !plot_channels) return;

  const rows = plottable_rows();

  plot_area.innerHTML = "";
  const has_pipeline_state = rows.some((row) => active_pipeline_state(row)?.lastStageRun != null);
  if (djf_readout && !has_pipeline_state) djf_readout.textContent = "";

  const is_log = false;
  const color_by = plot_color_by_select ? plot_color_by_select.value : "file";
  const bins = plot_bin_count();
  const display_mode = typeof plot_display_mode === "function" ? plot_display_mode() : "curve";
  const show_bins = display_mode === "bins" || display_mode === "curve_bins";
  const show_curves = display_mode !== "bins";

  const prepare_row = (row) => {
    const pipelineState = active_pipeline_state(row);
    if (pipelineState?.histogram) {
      const values = compact_final_values(row);
      return {
        values,
        stats: { raw: row.data.dna_a.length, plotted: values.length },
        pipelineState,
        stageHistogram: pipelineState.histogram,
      };
    }
    const prepared = {
      values: row.data.dna_a,
      stats: { raw: row.data.dna_a.length, plotted: row.data.dna_a.length },
    };
    return { ...prepared, pipelineState, stageHistogram: null };
  };
  const prepared_rows = rows.map((row) => ({ row, prepared: prepare_row(row) }));

  // With samples, compute the range from the plotted events and remember it;
  // with none, keep the axes by reusing the last range.
  let range;
  if (prepared_rows.length) {
    const staged_histograms = prepared_rows
      .map((entry) => entry.prepared.stageHistogram)
      .filter(Boolean);
    range = staged_histograms.length
      ? [
          d3.min(staged_histograms, (histogram) => histogram.min),
          d3.max(staged_histograms, (histogram) => histogram.max),
        ]
      : shared_range_for_values(prepared_rows.map((entry) => entry.prepared.values), is_log);
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
    const points = prepared.stageHistogram
      ? prepared.stageHistogram.x.map((x, bin) => ({ x, y: prepared.stageHistogram.y[bin] }))
      : histogram_curve(prepared.values, opts);
    const histogram = prepared.stageHistogram
      ? stage_histogram_summary(prepared.stageHistogram)
      : build_histogram_summary(points, opts);
    return { row, name: row.name, color, group, values: prepared.values, stats: prepared.stats, points, histogram, pipelineState: prepared.pipelineState };
  });
  set_last_series(series);
  series.forEach((entry) => {
    series_by_name.set(entry.name, entry);
    histograms_by_name.set(entry.name, entry.histogram);
  });

  // Also compute histograms for loaded-but-unchecked files (not drawn, so no
  // color/group), using the same bins/range as the current plot,
  // so window.PhaseFinder.plot.get_histogram() works for every loaded sample
  // regardless of its table checkbox state.
  const plotted_names = new Set(series.map((entry) => entry.name));
  loaded_rows_for_active_channel(get_parsed_files())
    .filter((row) => !plotted_names.has(row.name))
    .forEach((row) => {
      const prepared = prepare_row(row);
      const points = prepared.stageHistogram
        ? prepared.stageHistogram.x.map((x, bin) => ({ x, y: prepared.stageHistogram.y[bin] }))
        : histogram_curve(prepared.values, opts);
      const histogram = prepared.stageHistogram
        ? stage_histogram_summary(prepared.stageHistogram)
        : build_histogram_summary(points, opts);
      const entry = { row, name: row.name, color: null, group: null, values: prepared.values, stats: prepared.stats, points, histogram, pipelineState: prepared.pipelineState };
      series_by_name.set(entry.name, entry);
      histograms_by_name.set(entry.name, entry.histogram);
    });

  update_plot_title(rows, series.reduce((sum, item) => sum + item.values.length, 0));

  // Dean-Jett-Fox: draw whichever staged fit currently exists per sample.
  const fits = series.map(pipeline_fit_for_series).filter(Boolean);

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
    if (fit.debris) component(fit.debris, DJF_DEBRIS_COLOR);
    if (fit.aggregate) component(fit.aggregate, DJF_AGG_COLOR);
    overlay.append("path").attr("fill", "none").attr("stroke", DJF_TOTAL_COLOR).attr("stroke-width", DJF_TOTAL_LINE_WIDTH).attr("d", line(fit.total));
  });

  // Legend: one row per sample, then the fitted-component rows for every staged
  // fit. With more than one fit shown, component labels include the sample name.
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
    if (fit.debris) {
      legend_items.push({ type: "component", label: `${prefix}Debris`, color: DJF_DEBRIS_COLOR });
    }
    if (fit.aggregate) {
      legend_items.push({ type: "component", label: `${prefix}Aggregate`, color: DJF_AGG_COLOR });
    }
  });

  const checkbox_col = 0;
  const legend = svg.append("g").attr("transform", `translate(${width - margin.right + LEGEND_OFFSET_X},${margin.top})`);
  const items = legend.selectAll("g").data(legend_items).join("g").attr("transform", (d, i) => `translate(0,${i * LEGEND_ROW_HEIGHT})`);

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
