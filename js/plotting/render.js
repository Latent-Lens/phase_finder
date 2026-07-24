// Main D3 render pass for the plot panel. This module gathers checked rows with
// loaded channel data, reads staged DJF masks/fits, builds histogram
// points, computes axis domains, and draws the SVG. It supports curve-only,
// curve-plus-bins, and bins-only sample histogram display modes. When modeling
// pipeline state. Curves are identified by hovering (see curve_tooltip.js) and
// isolated by color/group via double-click, rather than a fixed legend. It
// also draws axis hit areas, plot titles, readouts, and fit-result tables.

import * as d3 from "d3";
import {
  plot_area,
  plot_channels,
  djf_readout,
  plot_color_by_select,
  plot_bin_count,
  plot_display_mode,
  plot_view_mode,
  ridge_focus_name,
  set_ridge_focus_name,
  plot_viewport,
  set_plot_viewport,
  reset_plot_viewport,
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
  get_isolated_color_group,
  toggle_isolated_color_group,
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
import { get_parsed_files } from "../state/files.js";
import { set_focused_file_id } from "../data_structs/table_state.js";
import { update_plot_title, render_fit_results_table } from "./modeling.js";
import { open_axis_range_modal } from "./axis_modal.js";
import { get_state as get_pipeline_state, state_matches_row } from "../analysis/pipeline_state.js";
import { update_peak_regions, fit_cell_cycle_model } from "../analysis/cell_cycle/modeling_state.js";
import { show_curve_tooltip, hide_curve_tooltip } from "./curve_tooltip.js";
import { render_peak_region_overlay } from "./peak_region_overlay.js";
import { install_plot_interactions } from "./plot_viewport.js";

// Last non-empty x-range and y-max, reused to keep the axes drawn (not collapsed)
// when no samples are selected. Only this render pass reads or writes them.
let last_range = null;
let last_y_max = null;

function active_pipeline_state(row) {
  const state = get_pipeline_state(row.name);
  return state_matches_row(state, row) ? state : null;
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

// Per-sample plot inputs, shared by the overlay and ridge renderers. A sample
// with a stored Stage 4 histogram renders from that frozen snapshot (its own
// bin count/range) so its fit stays valid; otherwise it bins live from the
// events surviving the active QC gates (compact_final_values returns every
// finite event when no mask is set, so this is correct before any gating too).
function prepare_row(row) {
  const pipelineState = active_pipeline_state(row);
  const values = compact_final_values(row);
  const stats = { raw: row.data.dna_a.length, plotted: values.length };
  return { values, stats, pipelineState, stageHistogram: pipelineState?.histogram || null };
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

// Builds the series-overlay shape from any model's generic §4.5 result (its
// `components` array and `expectedCounts`), independent of which model
// produced it -- the canonical models (Dean-Jett, Dean-Jett-Fox, Watson
// Pragmatic, auto_dj_djf) and the legacy bridge all normalize to this same
// shape. `reportFractionByKey` is legacy-only: the old Stage 8 report
// recomputes phase fractions more precisely than the Stage 6/7 fit alone, so
// when present it wins over the moments-based percent computed here;
// canonical-model results have no separate report stage; their own
// `phaseFractions` already is the final number, threaded straight through.
function build_fit_series_entry(series_entry, state, fit, { reportFractionByKey = {} } = {}) {
  const x = state.histogram.x;
  const point_series = (values) => x.map((position, index) => ({
    x: position,
    y: Number(values?.[index]) || 0,
  }));
  const component_counts = (id) => fit.components.find((entry) => entry.id === id)?.counts ?? null;
  const moments = {
    g1: component_moments(x, component_counts("g1")),
    s: component_moments(x, component_counts("s")),
    g2: component_moments(x, component_counts("g2")),
  };
  const biologicalTotal = moments.g1.total + moments.s.total + moments.g2.total;
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

  const debris_counts = component_counts("debris");
  const aggregate_counts = component_counts("aggregate");

  return {
    row: series_entry.row,
    name: series_entry.name,
    total: point_series(fit.expectedCounts),
    g1: point_series(component_counts("g1")),
    s: point_series(component_counts("s")),
    g2: point_series(component_counts("g2")),
    debris: debris_counts ? point_series(debris_counts) : null,
    aggregate: aggregate_counts ? point_series(aggregate_counts) : null,
    fractions: {
      g1: phase_stats.g1.percent,
      s: phase_stats.s.percent,
      g2: phase_stats.g2.percent,
    },
    phase_stats,
    pipelineState: state,
    modelId: fit.modelId,
    modelLabel: fit.modelLabel,
    warnings: fit.warnings ?? [],
  };
}

// Prefers the row's active model-neutral result (js/analysis/cell_cycle/
// modeling_state.js's fit_cell_cycle_model(), any registered model) over the
// legacy Stage 6/7 fit -- invalidate_histogram_dependents() already clears
// activeResultKey whenever the histogram changes, so a stale model-neutral
// result never lingers here once QC/regions move on; it just falls back to
// "no overlay" (or the legacy fit, if that's what's current) until refit.
function pipeline_fit_for_series(series_entry) {
  const state = active_pipeline_state(series_entry.row);
  if (!state?.histogram?.x) return null;

  const modeling = state.modeling;
  const modelResult = modeling?.activeResultKey ? modeling.resultsByKey[modeling.activeResultKey] : null;
  if (modelResult?.components?.length && modelResult.expectedCounts) {
    return build_fit_series_entry(series_entry, state, modelResult);
  }

  const legacyFit = state.extendedFit || state.baseFit;
  if (!legacyFit?.components?.length || !legacyFit.expectedCounts) return null;
  const reportedFractions = state.report?.fractions?.biologicalSinglets;
  return build_fit_series_entry(series_entry, state, legacyFit, {
    reportFractionByKey: {
      g1: reportedFractions?.oneC,
      s: reportedFractions?.sPhase,
      g2: reportedFractions?.twoC,
    },
  });
}

// Strips a trailing .fcs for compact display; the full name stays in the title.
function strip_fcs_ext(name) {
  return String(name || "").replace(/\.fcs$/i, "");
}

// Vertical space the floating top-right plot controls occupy, so plot content
// under them (the first ridge row's header, the overlay fit table) can clear it.
function plot_controls_offset() {
  const el = document.querySelector(".plot_controls");
  return el ? Math.ceil(el.getBoundingClientRect().height) + 10 : 0;
}

// Ridge "Review" -> blow one sample up to the full single-sample plot for manual
// region editing. Focusing the row makes it the Identify Peaks panel's active
// sample (so its draggable region handles + inputs target it); render then falls
// through to the overlay path (filtered to this one sample) because
// ridge_focus_name is set.
function enter_ridge_review(row) {
  set_ridge_focus_name(row.name);
  set_focused_file_id(row.id);
  document.dispatchEvent(new CustomEvent("cell-cycle-focus-change"));
  render_density_plot();
}

// Accept -> leave the blow-up and return to the ridge (badge back to Ready).
function exit_ridge_review() {
  set_ridge_focus_name(null);
  render_density_plot();
}

// Draggable G1/G2 peak-region boundaries drawn directly on a ridge row, so the
// user can resize/move each region without blowing the sample up. Mirrors
// peak_region_overlay.js's ordering rule (G1.left < G1.right <= G2.left <
// G2.right) live during the drag, and commits + refits that one sample on
// release (commit_ridge_regions).
const RIDGE_G1_COLOR = "#2563eb";
const RIDGE_G2_COLOR = "#b42318";
const RIDGE_BOUNDARIES = [
  { key: "g1_left", region: "g1", side: "left", color: RIDGE_G1_COLOR },
  { key: "g1_right", region: "g1", side: "right", color: RIDGE_G1_COLOR },
  { key: "g2_left", region: "g2", side: "left", color: RIDGE_G2_COLOR },
  { key: "g2_right", region: "g2", side: "right", color: RIDGE_G2_COLOR },
];
const ridge_boundary_value = (live, key) => live[key.startsWith("g1") ? "g1" : "g2"][key.endsWith("left") ? "left" : "right"];
const set_ridge_boundary = (live, key, value) => { live[key.startsWith("g1") ? "g1" : "g2"][key.endsWith("left") ? "left" : "right"] = value; };

let ridge_commit_pending = false;

// Commit a ridge row's edited regions and re-fit just that sample with its
// model, then re-render the ridge so its fit + box reflect the edit.
async function commit_ridge_regions(row, live) {
  try {
    update_peak_regions(row, {
      g1: { left: live.g1.left, right: live.g1.right },
      g2: { left: live.g2.left, right: live.g2.right },
    }, { source: "manual", minimumGap: -0.01 });
    const modelId = get_pipeline_state(row.name)?.modeling?.settings?.modelId;
    if (modelId) await fit_cell_cycle_model(row, modelId);
  } catch (_) {
    // Invalid bounds or a failed fit -- fall through and re-render with whatever
    // committed; the row simply shows no (or the prior) fit.
  } finally {
    ridge_commit_pending = false;
    document.dispatchEvent(new CustomEvent("cell-cycle-fit-changed"));
    render_density_plot();
  }
}

function draw_ridge_region_editor(svg, row, x_scale, top, bottom) {
  const regions = get_pipeline_state(row.name)?.modeling?.peakSelection?.regions;
  if (!regions?.g1 || !regions?.g2) return;
  const [domain_min, domain_max] = x_scale.domain();
  const live = { g1: { ...regions.g1 }, g2: { ...regions.g2 } };

  const group = svg.append("g").attr("class", "ridge_region_editor");
  const bands = {
    g1: group.append("rect").attr("class", "ridge_region_band").attr("fill", RIDGE_G1_COLOR).attr("fill-opacity", 0.1),
    g2: group.append("rect").attr("class", "ridge_region_band").attr("fill", RIDGE_G2_COLOR).attr("fill-opacity", 0.1),
  };
  const edges = {};

  const redraw = () => {
    ["g1", "g2"].forEach((region) => {
      const x0 = x_scale(live[region].left);
      const x1 = x_scale(live[region].right);
      bands[region].attr("x", Math.min(x0, x1)).attr("y", top).attr("width", Math.max(0, Math.abs(x1 - x0))).attr("height", Math.max(0, bottom - top));
    });
    RIDGE_BOUNDARIES.forEach(({ key }) => {
      const px = x_scale(ridge_boundary_value(live, key));
      edges[key].line.attr("x1", px).attr("x2", px).attr("y1", top).attr("y2", bottom);
      edges[key].hit.attr("x", px - 5).attr("y", top).attr("width", 10).attr("height", Math.max(0, bottom - top));
    });
  };

  const boundary_limits = (key) => {
    switch (key) {
      case "g1_left": return [domain_min, live.g1.right];
      case "g1_right": return [live.g1.left, live.g2.left];
      case "g2_left": return [live.g1.right, live.g2.right];
      case "g2_right": return [live.g2.left, domain_max];
      default: return [domain_min, domain_max];
    }
  };

  RIDGE_BOUNDARIES.forEach(({ key, color }) => {
    const line = group.append("line").attr("class", "ridge_region_edge").attr("stroke", color).attr("stroke-width", 1.5).attr("stroke-dasharray", "3 2");
    const hit = group.append("rect").attr("class", "ridge_region_hit").attr("fill", "transparent").style("cursor", "ew-resize");
    edges[key] = { line, hit };
    hit.call(d3.drag()
      .on("drag", (event) => {
        const [lo, hi] = boundary_limits(key);
        set_ridge_boundary(live, key, Math.max(lo, Math.min(hi, x_scale.invert(event.x))));
        redraw();
      })
      .on("end", () => { if (!ridge_commit_pending) { ridge_commit_pending = true; commit_ridge_regions(row, live); } }));
  });

  // Band body drag -> move the whole region (both edges) within its neighbours.
  const px_per_data = (x_scale.range()[1] - x_scale.range()[0]) / (domain_max - domain_min || 1);
  ["g1", "g2"].forEach((region) => {
    bands[region].style("cursor", "grab").call(d3.drag()
      .on("drag", (event) => {
        const width = live[region].right - live[region].left;
        const lower = region === "g1" ? domain_min : live.g1.right;
        const upper = region === "g1" ? live.g2.left : domain_max;
        let left = live[region].left + event.dx / px_per_data;
        left = Math.max(lower, Math.min(upper - width, left));
        live[region].left = left;
        live[region].right = left + width;
        redraw();
      })
      .on("end", () => { if (!ridge_commit_pending) { ridge_commit_pending = true; commit_ridge_regions(row, live); } }));
  });

  redraw();
}

// Ridge view: each plotted sample rendered as its own small histogram (with its
// fit overlay) stacked vertically for side-by-side multi-sample review. All
// rows share one x-scale so peaks line up. Each row shows a "Ready to model"
// status badge; the per-row Review blow-up is wired in Phase 2. Keeps the shared
// plot maps in sync (debug API + table swatches) exactly like the overlay path.
function render_ridge_plot() {
  const rows = plottable_rows();
  plot_area.innerHTML = "";
  if (!rows.length) return;

  const bins = plot_bin_count();
  const is_log = false;
  const prepared_rows = rows.map((row) => ({ row, prepared: prepare_row(row) }));

  const staged = prepared_rows.map((entry) => entry.prepared.stageHistogram).filter(Boolean);
  const range = staged.length
    ? [d3.min(staged, (histogram) => histogram.min), d3.max(staged, (histogram) => histogram.max)]
    : shared_range_for_values(prepared_rows.map((entry) => entry.prepared.values), is_log);
  const opts = axis_opts(range, is_log, bins);
  let x_domain = [
    axis_range_override.x_min != null ? axis_range_override.x_min : range[0],
    axis_range_override.x_max != null ? axis_range_override.x_max : range[1],
  ];
  if (!(x_domain[1] > x_domain[0])) x_domain = range;

  const assign = build_color_assigner(rows, plot_color_by_select ? plot_color_by_select.value : "file");
  const entries = prepared_rows.map(({ row, prepared }, index) => {
    const { color, group } = assign(row, index);
    const points = prepared.stageHistogram
      ? prepared.stageHistogram.x.map((x, bin) => ({ x, y: prepared.stageHistogram.y[bin] }))
      : histogram_curve(prepared.values, opts);
    const histogram = prepared.stageHistogram
      ? stage_histogram_summary(prepared.stageHistogram)
      : build_histogram_summary(points, opts);
    const entry = { row, name: row.name, color, group, values: prepared.values, stats: prepared.stats, points, histogram, pipelineState: prepared.pipelineState };
    return { entry, color, fit: pipeline_fit_for_series(entry) };
  });

  set_last_series(entries.map((item) => item.entry));
  set_row_colors(entries.map((item) => ({ id: item.entry.row.id, color: item.color, group: item.entry.group })));
  entries.forEach((item) => {
    series_by_name.set(item.entry.name, item.entry);
    histograms_by_name.set(item.entry.name, item.entry.histogram);
  });
  update_plot_title(rows, entries.reduce((sum, item) => sum + item.entry.values.length, 0));

  const total_width = plot_area.clientWidth || PLOT_FALLBACK_WIDTH;
  const row_height = 92;
  const margin = { top: 8, right: 14, bottom: 6, left: 14 };
  const x_scale = d3.scaleLinear().domain(x_domain).range([margin.left, total_width - margin.right]);

  const container = document.createElement("div");
  container.className = "ridge_container";
  // Clear the floating controls so the first row's header isn't hidden.
  container.style.paddingTop = `${plot_controls_offset()}px`;

  entries.forEach(({ entry, color, fit }) => {
    const row_el = document.createElement("div");
    row_el.className = "ridge_row";
    row_el.dataset.sampleName = entry.name;

    const header = document.createElement("div");
    header.className = "ridge_row_header";
    const name_el = document.createElement("span");
    name_el.className = "ridge_row_name";
    name_el.textContent = strip_fcs_ext(entry.name);
    name_el.title = entry.name;
    const badge = document.createElement("span");
    badge.className = "ridge_badge ridge_badge_ready";
    badge.textContent = "Ready to model";
    const review_btn = document.createElement("button");
    review_btn.type = "button";
    review_btn.className = "ridge_review_button";
    review_btn.textContent = "Review";
    review_btn.title = `Blow up ${strip_fcs_ext(entry.name)} for manual peak-region review`;
    review_btn.addEventListener("click", () => enter_ridge_review(entry.row));
    header.append(name_el, badge, review_btn);
    row_el.appendChild(header);

    const svg = d3.select(document.createElementNS("http://www.w3.org/2000/svg", "svg"))
      .attr("class", "ridge_svg")
      .attr("width", total_width)
      .attr("height", row_height);
    const y_max = Math.max(
      d3.max(entry.points, (point) => point.y) || 0,
      fit ? (d3.max(fit.total, (point) => point.y) || 0) : 0,
    ) || 1;
    const y_scale = d3.scaleLinear().domain([0, y_max]).range([row_height - margin.bottom, margin.top]);
    const line = d3.line().x((point) => x_scale(point.x)).y((point) => y_scale(point.y));

    if (fit) {
      const area = d3.area().x((point) => x_scale(point.x)).y0(y_scale(0)).y1((point) => y_scale(point.y));
      const component = (data, fill) => {
        if (data) svg.append("path").attr("fill", fill).attr("fill-opacity", DJF_FILL_OPACITY).attr("stroke", "none").attr("d", area(data));
      };
      component(fit.g1, DJF_G1_COLOR);
      component(fit.s, DJF_S_COLOR);
      component(fit.g2, DJF_G2_COLOR);
    }
    svg.append("path").attr("fill", "none").attr("stroke", color || "#5b6472").attr("stroke-width", SAMPLE_LINE_WIDTH).attr("d", line(entry.points));
    if (fit) {
      svg.append("path").attr("fill", "none").attr("stroke", DJF_TOTAL_COLOR).attr("stroke-width", 1.4).attr("d", line(fit.total));
    }
    // Draggable G1/G2 region boundaries so peaks can be edited in place.
    draw_ridge_region_editor(svg, entry.row, x_scale, margin.top, row_height - margin.bottom);
    row_el.appendChild(svg.node());
    container.appendChild(row_el);
  });

  plot_area.appendChild(container);
  document.dispatchEvent(new CustomEvent("pf-plot-rendered"));
}

/*

Purpose:
	The main render. Draws the overlaid event histograms for the currently
	checked samples with D3, applying the controls (color-by, axis scale, bins).
	When staged DJF state exists it overlays the stored fitted curve and filled
	G1/S/G2/contamination components. It also draws the report table and updates
	the title; numeric work itself is run only by the manual stage UI. Samples
	are identified by hovering their curve (curve_tooltip.js), not a legend.

Input:
	(none)

Output:
	(none) [void]: rebuilds the #plot_area SVG

*/
export function render_density_plot() {
  if (!plot_area || !plot_channels) return;

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

  plot_area.innerHTML = "";
  const has_pipeline_state = rows.some((row) => active_pipeline_state(row)?.lastStageRun != null);
  if (djf_readout && !has_pipeline_state) djf_readout.textContent = "";

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
  set_row_colors(series.map((entry) => ({ id: entry.row.id, color: entry.color, group: entry.group })));
  // If the isolated group no longer matches anything currently plotted (its
  // samples got unchecked, filtered out, etc.), drop the isolation instead of
  // leaving every curve dimmed with nothing left highlighted.
  let isolated_group = get_isolated_color_group();
  if (isolated_group != null && !series.some((entry) => entry.group === isolated_group)) {
    toggle_isolated_color_group(isolated_group); // same value in -> clears back to null
    isolated_group = null;
  }
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
    .on("dblclick", (event) => { event.stopPropagation(); open_axis_range_modal("x"); });
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
    .on("dblclick", (event) => { event.stopPropagation(); open_axis_range_modal("y"); });
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

  // Numeric stats for a legacy_bridge_v1 fit are only shown once a sample has
  // completed the full pipeline (the Stage 8 report). Before that, the
  // fitted curve overlay is drawn but no numbers are reported, so the user
  // never sees phase fractions change as later stages run (the pre-report
  // values also use a coarser integration than the report). The fit curve
  // for Stages 6-7 still renders above. A canonical-model result has no
  // separate report stage to wait for -- fit_cell_cycle_model()'s result is
  // already final, so it's included immediately.
  const report_fits = fits.filter((fit) => fit.pipelineState?.report || fit.modelId !== "legacy_bridge_v1");
  render_fit_results_table(report_fits, {
    // Sit below the floating top-right controls so they don't overlap.
    top: Math.max(margin.top, plot_controls_offset()),
    right: 8,
    max_width: Math.max(190, margin.right - 18),
  });

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

// The overlay bar shown while a ridge row is blown up for manual review.
function render_ridge_review_header(name) {
  const bar = document.createElement("div");
  bar.className = "ridge_review_bar";
  const label = document.createElement("span");
  label.className = "ridge_review_name";
  label.textContent = strip_fcs_ext(name);
  label.title = name;
  const badge = document.createElement("span");
  badge.className = "ridge_badge ridge_badge_review";
  badge.textContent = "Under manual review";
  const accept = document.createElement("button");
  accept.type = "button";
  accept.className = "ridge_review_accept";
  accept.textContent = "Accept & back to ridge";
  accept.addEventListener("click", exit_ridge_review);
  bar.append(label, badge, accept);
  plot_area.appendChild(bar);
}
