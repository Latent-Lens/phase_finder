// Per-sample data prep shared by both plot renderers (the overlay in
// render.js and the ridge small-multiples view in ridge_review.js): gating
// masked/live events into plottable values, building/caching histograms,
// computing the shared visible range across a cohort, and shaping a model
// fit into the series-overlay points both renderers draw. Split out of
// render.js (AUDIT-008) as the render-agnostic computation layer neither
// renderer needs to duplicate.

import * as d3 from "d3";
import {
  series_by_name,
  histograms_by_name,
  shared_range_for_values,
  histogram_curve,
  build_histogram_summary,
} from "./data.js";
import { get_state as get_pipeline_state, get_active_model_result, state_matches_row } from "../analysis/pipeline/pipeline_state.js";

// Dash patterns cycled across plotted samples so overlapping curves stay
// distinguishable without relying on color alone. Shared by the overlay and
// ridge renderers so a given sample's line style doesn't change between views.
export const SAMPLE_LINE_STYLES = [null, "7 3", "2 2", "9 2 2 2"];

const plot_compute_cache = new Map();
const plot_performance_counts = { eventScans: 0, histogramBuilds: 0, cacheHits: 0 };

export const plot_performance = {
  reset() {
    plot_performance_counts.eventScans = 0;
    plot_performance_counts.histogramBuilds = 0;
    plot_performance_counts.cacheHits = 0;
  },
  snapshot() {
    return { ...plot_performance_counts, cachedSamples: plot_compute_cache.size };
  },
};

export function replace_plot_caches(entries) {
  series_by_name.clear();
  histograms_by_name.clear();
  entries.forEach((entry) => {
    series_by_name.set(entry.name, entry);
    histograms_by_name.set(entry.name, entry.histogram);
  });
}

function active_pipeline_state(row) {
  const state = get_pipeline_state(row.name);
  return state_matches_row(state, row) ? state : null;
}

function compact_final_values(row) {
  const values = row.data.channels?.DNA_A || row.data.dna_a || [];
  const mask = row.data.masks?.final;
  if (!mask || mask.length !== values.length) return values;
  const filtered = row.data.filtered;
  if (filtered?.sourceMask === mask && filtered.channels?.DNA_A) {
    return filtered.channels.DNA_A;
  }
  plot_performance_counts.eventScans += values.length;
  const retained = [];
  for (let index = 0; index < values.length; index += 1) {
    if (mask[index] && Number.isFinite(values[index])) retained.push(values[index]);
  }
  return retained;
}

// Per-sample plot inputs, shared by the overlay and ridge renderers. A sample
// with a stored DNA-content histogram renders from that frozen snapshot (its own
// bin count/range) so its fit stays valid; otherwise it bins live from the
// events surviving the active QC gates (compact_final_values returns every
// finite event when no mask is set, so this is correct before any gating too).
export function prepare_row(row) {
  const pipelineState = active_pipeline_state(row);
  const values = compact_final_values(row);
  const stats = { raw: row.data.dna_a.length, plotted: values.length };
  return { values, stats, pipelineState, maskedHistogram: pipelineState?.histogram || null };
}

export function prepared_histogram(name, prepared, opts) {
  const source = prepared.maskedHistogram;
  const key = source ? null : `${opts.t_lo}:${opts.t_hi}:${opts.bins}`;
  const cached = plot_compute_cache.get(name);
  if (cached
      && cached.values === prepared.values
      && cached.source === source
      && cached.key === key) {
    plot_performance_counts.cacheHits += 1;
    return cached;
  }
  const points = source
    ? source.x.map((x, bin) => ({ x, y: source.y[bin] }))
    : histogram_curve(prepared.values, opts);
  const histogram = source
    ? masked_histogram_summary(source)
    : build_histogram_summary(points, opts);
  if (!source) {
    plot_performance_counts.eventScans += prepared.values.length;
    plot_performance_counts.histogramBuilds += 1;
  }
  const computed = { values: prepared.values, source, key, points, histogram };
  plot_compute_cache.set(name, computed);
  return computed;
}

export function prune_plot_compute_cache(rows) {
  const visible = new Set(rows.map((row) => row.name));
  for (const name of plot_compute_cache.keys()) {
    if (!visible.has(name)) plot_compute_cache.delete(name);
  }
}

function masked_histogram_summary(histogram) {
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
    underflow: histogram.underflow ?? 0,
    overflow: histogram.overflow ?? 0,
  };
}

export const VISIBLE_HISTOGRAM_RANGE_CONTRACT = "visible-cohort-union-v1";

export function visible_histogram_range(prepared_rows, is_log = false) {
  const ranges = prepared_rows
    .map((entry) => entry.prepared.maskedHistogram)
    .filter(Boolean)
    .map((histogram) => [histogram.min, histogram.max]);
  const live = prepared_rows.filter((entry) => !entry.prepared.maskedHistogram);
  if (live.length) ranges.push(shared_range_for_values(live.map((entry) => entry.prepared.values), is_log));
  if (!ranges.length) return shared_range_for_values(prepared_rows.map((entry) => entry.prepared.values), is_log);
  return [d3.min(ranges, (range) => range[0]), d3.max(ranges, (range) => range[1])];
}

export function clipping_stats(values, histogram) {
  const underflow = histogram.underflow ?? values.filter((value) => value < histogram.min).length;
  const overflow = histogram.overflow ?? values.filter((value) => value > histogram.max).length;
  return { underflow, overflow, inRange: Math.max(0, values.length - underflow - overflow) };
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
// `components` array and `expectedCounts`), independent of which model produced
// it -- every canonical model (Dean-Jett, Dean-Jett-Fox, Watson Pragmatic,
// Watson Classic) normalizes to this same shape.
//
// SCI-05/LEGACY-01: `fit.phaseFractions` is the sole authoritative source of the
// displayed percentages. This function used to accept a `reportFractionByKey`
// override so the legacy stage-8 report's independently recomputed fractions
// could win over the canonical ones; that override is gone. The moments-based
// fallback below applies only when a model published no phaseFractions at all,
// and is labelled as the domain-limited diagnostic it is.
export function build_fit_series_entry(series_entry, state, fit) {
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
  const canonicalFractionByKey = fit.phaseFractions ?? {};
  const phase = (key, label) => ({
    phase: label,
    percent: Number.isFinite(canonicalFractionByKey[key])
      ? 100 * canonicalFractionByKey[key]
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
    // AD-2/UI-01 follow-up: carried straight through from the source `fit`
    // (the contracted result -- see result_contract.js's apply_result_contract,
    // which stamps both), NOT defaulted -- absence of evidence is not
    // validation. Without these two fields, analysis_text() (plot_accessibility.js)
    // has no way to know a result is unvalidated or unconverged, so the SVG
    // <desc> and the visible "Plot data and analysis summary" table were
    // announcing bare percentages with zero trust signal for exactly the
    // results the sidebar and metadata table flag with a qualifier/⚠
    // (format_fraction_cell()).
    validForReporting: fit.validForReporting,
    converged: fit.converged,
    scientificallyValid: fit.scientificallyValid,
    limitedReliability: fit.limitedReliability,
  };
}

// Reads only the authoritative model-neutral result. Legacy stage 6-8 state is
// compatibility data and must never leak into canonical plot/export output.
export function pipeline_fit_for_series(series_entry) {
  const state = active_pipeline_state(series_entry.row);
  if (!state?.histogram?.x) return null;

  const modelResult = get_active_model_result(state);
  if (modelResult?.components?.length && modelResult.expectedCounts) {
    return build_fit_series_entry(series_entry, state, modelResult);
  }

  return null;
}

// Strips a trailing .fcs for compact display; the full name stays in the title.
export function strip_fcs_ext(name) {
  return String(name || "").replace(/\.fcs$/i, "");
}

// Vertical space the floating top-right plot controls occupy, so plot content
// under them (the first ridge row's header, the overlay fit table) can clear it.
export function plot_controls_offset() {
  const el = document.querySelector(".plot_controls");
  return el ? Math.ceil(el.getBoundingClientRect().height) + 10 : 0;
}
