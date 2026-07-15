// Shared plot state, DOM references, layout constants, and histogram helpers.
// This module is the data-preparation layer between loaded channel arrays and the
// D3 rendering modules. It tracks active channels, cached series, histogram
// summaries, axis overrides, and plot-control values such as color grouping,
// bin count, and display mode. It provides the
// helpers that choose plottable rows, assign colors, compute shared x ranges,
// build histogram bins, and format model-table values. State that other plotting
// modules reassign is exposed through setters so their imported bindings stay
// live. Rendering and modeling modules import this state but keep their drawing
// and UI actions separate.

import { get_selected_files } from "../state/files.js";
import { TABLE_COLUMNS } from "../data_structs/table_state.js";
import { escape_html } from "../util/html.js";

export const plot_area = document.querySelector("#plot_area");
export const plot_title = document.querySelector("#plot_title");
export const plot_color_by_select = document.querySelector("#plot_color_by");
export const plot_display_mode_select = document.querySelector("#plot_display_mode");
export const plot_x_scale_select = document.querySelector("#plot_x_scale");
export const plot_bins_input = document.querySelector("#plot_bins");
export const djf_readout = document.querySelector("#djf_readout");

export const axis_range_modal = document.querySelector("#axis_range_modal");
export const axis_range_x_min_input = document.querySelector("#axis_range_x_min");
export const axis_range_x_max_input = document.querySelector("#axis_range_x_max");
export const axis_range_y_min_input = document.querySelector("#axis_range_y_min");
export const axis_range_y_max_input = document.querySelector("#axis_range_y_max");

export const DEFAULT_BINS = 512;

// Colors come from the CSS custom properties in base.css so there is a single
// source of truth for the whole app; the fallback is used only if a token is
// missing. (Numeric sizes/widths below stay here as plain JS.)
const css_color = (name, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

// Dean–Jett–Fox cell-cycle component colors.
export const DJF_G1_COLOR = css_color("--djf_g1", "#95c1dc");
export const DJF_S_COLOR = css_color("--djf_s", "#d5eec8");
export const DJF_G2_COLOR = css_color("--djf_g2", "#ef8b8d");
export const DJF_TOTAL_COLOR = css_color("--djf_total", "#111827");
export const DJF_DEBRIS_COLOR = css_color("--djf_debris", "#a78bfa");
export const DJF_AGG_COLOR = css_color("--djf_agg", "#f59e0b");
// Fill opacity for the DJF component areas (0 = transparent, 1 = solid).
export const DJF_FILL_OPACITY = 0.8;
export const DJF_COMPONENT_LINE_WIDTH = 1.5; // G1/S/G2 outlines
export const DJF_TOTAL_LINE_WIDTH = 2; // fitted total

// ---- Plot layout & styling (tweak here) ----
// right just needs to fit the DJF fit-results table now that the per-sample
// legend (which used to share this margin) is gone -- see curve_tooltip.js
export const PLOT_MARGIN = { top: 14, right: 210, bottom: 48, left: 70 };
export const PLOT_FALLBACK_WIDTH = 800;
export const PLOT_FALLBACK_HEIGHT = 420;

export const AXIS_LINE_WIDTH = 1;
export const AXIS_TICK_FONT_SIZE = 11;
export const AXIS_TITLE_FONT_SIZE = 12;
export const AXIS_LABEL_COLOR = css_color("--text", "#172033");
// Extra px the double-click hit area extends past each axis's own margin
// band, into the plot area, so opening the range modal doesn't require a
// precise click on a thin tick line or label.
export const AXIS_HIT_PAD = 10;
export const X_AXIS_TICKS = 6;
export const Y_AXIS_TICKS = 5;
export const X_TITLE_OFFSET = 10; // px above the bottom edge
export const Y_TITLE_OFFSET = 16; // px from the left edge

export const SAMPLE_LINE_WIDTH = 1.5; // per-sample histogram curves
export const SAMPLE_BIN_OPACITY_WITH_CURVE = 0.18;
export const SAMPLE_BIN_OPACITY_ONLY = 0.42;
export const SAMPLE_BIN_WIDTH_RATIO = 0.9;

// No visible legend anymore (see curve_tooltip.js for hover/isolate instead):
// a much wider, fully transparent stroke drawn on top of each visible curve
// is the actual hover/double-click hit target, so a thin 1.5px line is easy
// to land on without needing a legend to click instead.
export const CURVE_HOVER_HIT_WIDTH = 14;
// Opacity applied to every curve/bin NOT in the isolated color group.
export const ISOLATED_DIM_OPACITY = 0.12;

// ── Shared plot state ────────────────────────────────────────────────────────
// Bindings reassigned by other plotting modules (render/modeling/axis_modal) are
// exported as `let` with a setter so importers keep seeing the live value.

// DNA-content channel(s) of the most recent analysis; null until analysis runs.
export let plot_channels = null;
export function set_plot_channels(channels) { plot_channels = channels; }

// Per-sample histogram series (name, color, points, etc.) from the most recent
// render, exposed via window.PhaseFinder.plot for other modules to read.
export let last_series = [];
export function set_last_series(series) { last_series = series; }

// The color-by "group" (see build_color_assigner) currently isolated by a
// double-click on a curve or a metadata-table color swatch, or null when
// nothing is isolated. Persists across re-renders (toggling a QC filter,
// changing bins, etc.) until double-clicked again or a mismatched render
// clears it -- see render_density_plot's isolation-safety check.
let isolated_color_group = null;
export function get_isolated_color_group() { return isolated_color_group; }
export function set_isolated_color_group(group) { isolated_color_group = group; }
export function toggle_isolated_color_group(group) {
  isolated_color_group = isolated_color_group === group ? null : group;
}

// row.id -> { color, group } for every currently-plotted sample, rebuilt on
// every render_density_plot() call. Lets the metadata table draw each row's
// current plot color as a swatch without importing the plotting/render layer.
let row_color_by_id = new Map();
export function set_row_colors(entries) {
  row_color_by_id = new Map(entries.map(({ id, color, group }) => [id, { color, group }]));
}
export function get_row_color(id) {
  return row_color_by_id.get(id) || null;
}

// All series ever rendered, keyed by sample name (the metadata Filename column).
// Entries persist across renders/deselection so a sample's histogram stays
// available by name even after it drops off the current plot.
export const series_by_name = new Map();
// Histogram summaries ({ binEdges, binCenters, counts, binWidth, min, max }),
// keyed the same way as series_by_name.
export const histograms_by_name = new Map();
// User-entered axis bounds, set via the axis-range modal; null means "keep
// using the auto-computed value" for that end of the axis. Mutated in place.
export const axis_range_override = { x_min: null, x_max: null, y_min: null, y_max: null };
// The most recent auto-computed bounds, remembered so the modal can show
// them as placeholders even for the axis that wasn't double-clicked.
export let last_auto_x_range = [0, 1];
export function set_last_auto_x_range(range) { last_auto_x_range = range; }
export let last_auto_y_max = 1;
export function set_last_auto_y_max(value) { last_auto_y_max = value; }

/*

Purpose:
	Strips a trailing ".fcs" extension from a filename for display. The full
	row.name is kept elsewhere for matching/selection, so only the shown label
	changes.

Input:
	name [string]: a sample filename, possibly ending in ".fcs"

Output:
	label [string]: the filename with any trailing ".fcs" (case-insensitive) removed

*/
export function strip_fcs(name) {
  return name.replace(/\.fcs$/i, "");
}

/*

Purpose:
	Escapes text before building the DJF fit-results table.

Input:
	value [any]: text-ish value to escape

Output:
	text [string]: HTML-safe text

*/
export function plot_escape_html(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/*

Purpose:
	Formats numeric fit table values with stable precision and thousands
	separators.

Input:
	value [number]: number to format
	digits [number]: max decimal places

Output:
	text [string]: formatted number, or blank for non-finite values

*/
export function format_fit_number(value, digits = 2) {
  if (!Number.isFinite(value)) return "";
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

/*

Purpose:
	Reads the bin count from the "Bins" input and clamps it to a safe range.
	Falls back to the default when the field is empty or non-numeric.

Input:
	(none)

Output:
	bins [number]: the bin count, clamped to [16, 1024] (default 256)

*/
export function plot_bin_count() {
  const raw = Number.parseInt(plot_bins_input && plot_bins_input.value, 10);
  if (!Number.isFinite(raw)) return DEFAULT_BINS;
  return Math.max(16, Math.min(1024, raw));
}

/*

Purpose:
	Reads whether the plot should draw smoothed curves, histogram bins, or both.

Input:
	(none)

Output:
	mode [string]: "curve", "curve_bins", or "bins"

*/
export function plot_display_mode() {
  const mode = plot_display_mode_select ? plot_display_mode_select.value : "curve";
  return ["curve", "curve_bins", "bins"].includes(mode) ? mode : "curve";
}

/*

Purpose:
	Filters a list of loaded-file rows down to those with event data already
	loaded for the currently active DNA-area channel.

Input:
	rows [Array<Object>]: candidate loaded-file rows

Output:
	rows [Array<Object>]: the subset with row.data.dna_a loaded for the active channel

*/
export function loaded_rows_for_active_channel(rows) {
  const active_channel = plot_channels && plot_channels.dna_area;
  return rows.filter((row) =>
    row.data && row.data.dna_a && (!row.data.channel_key || row.data.channel_key === active_channel)
  );
}

/*

Purpose:
	Returns the samples that should be drawn: those currently checked in the
	table AND already loaded with event data.

Input:
	(none)

Output:
	rows [Array<Object>]: checked sample objects whose row.data.dna_a is loaded

*/
export function plottable_rows() {
  return loaded_rows_for_active_channel(get_selected_files());
}

/*

Purpose:
	Picks a distinct color for one curve by spreading hues evenly around the
	color wheel, so many overlaid samples stay distinguishable.

Input:
	index [number]: this curve's position in the set
	total [number]: number of samples sharing the palette

Output:
	color [string]: an HSL color string

*/
export function sample_color(index, total) {
  const hue = total > 1 ? Math.round((index * 360) / total) % 360 : 210;
  return `hsl(${hue}, 70%, 45%)`;
}

/*

Purpose:
	Builds a function that assigns a color and a legend group to each sample.
	When coloring by a metadata column, all samples sharing a value for that
	column share one hue; otherwise every file gets its own hue.

Input:
	rows [Array<Object>]: the samples to be plotted
	color_by [string]:    "file", or a metadata column's field name

Output:
	assign [Function]: (row, index) => { color [string], group [string] }

*/
export function build_color_assigner(rows, color_by) {
  if (color_by && color_by !== "file") {
    const value_of = (row) => String(row.annotations?.[color_by] ?? "").trim() || "(none)";
    const values = [...new Set(rows.map(value_of))].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
    );
    const colors = new Map(values.map((v, i) => [v, sample_color(i, values.length)]));
    return (row) => ({ color: colors.get(value_of(row)), group: value_of(row) });
  }
  return (row, index) => ({ color: sample_color(index, rows.length), group: row.name });
}

/*

Purpose:
	Keeps the "Color by" dropdown's options in sync with the metadata table's
	current columns: "File" plus one option per user metadata column (Filename
	itself excluded, since "File" already covers per-file coloring). Preserves
	the current selection when it still exists, otherwise falls back to "File"
	(e.g. the selected column was just deleted).

Input:
	(none)

Output:
	(none) [void]: rebuilds #plot_color_by's <option> list

*/
export function sync_color_by_options() {
  if (!plot_color_by_select) return;
  const previous = plot_color_by_select.value;
  const metadata_columns = TABLE_COLUMNS.filter((column) => column.field !== "name");

  plot_color_by_select.innerHTML = [
    `<option value="file">File</option>`,
    ...metadata_columns.map(
      (column) => `<option value="${escape_html(column.field)}">${escape_html(column.label)}</option>`,
    ),
  ].join("");

  const previous_still_exists = [...plot_color_by_select.options].some((option) => option.value === previous);
  plot_color_by_select.value = previous_still_exists ? previous : "file";
}

/*

Purpose:
	Computes a shared x-range for all plotted samples from the 0.5th–99.5th
	percentiles of a downsample of their events, so a few extreme outliers
	don't squash the curves.

Input:
	rows [Array<Object>]:   the plotted samples (uses row.data.dna_a)
	positive_only [boolean]: drop values <= 0 first (needed for a log axis)

Output:
	range [Array<number>]: the [lo, hi] x-range

*/
export function shared_range(rows, positive_only) {
  return shared_range_for_values(rows.map((row) => row.data.dna_a), positive_only);
}

/*

Purpose:
	Computes the shared x-range from already-prepared event arrays. This lets the
	plot range follow the correction checkboxes instead of always using raw events.

Input:
	value_sets [Array<Array<number>>]: per-sample event arrays
	positive_only [boolean]:          drop values <= 0 first (needed for a log axis)

Output:
	range [Array<number>]: the [lo, hi] x-range

*/
export function shared_range_for_values(value_sets, positive_only) {
  const total = value_sets.reduce((sum, values) => sum + values.length, 0);
  const stride = Math.max(1, Math.floor(total / 50000));
  const sample = [];
  for (const values of value_sets) {
    for (let i = 0; i < values.length; i += stride) {
      const v = values[i];
      if (Number.isFinite(v) && (!positive_only || v > 0)) sample.push(v);
    }
  }
  if (!sample.length) return positive_only ? [1, 10] : [0, 1];
  sample.sort((a, b) => a - b);
  const at = (p) => sample[Math.min(sample.length - 1, Math.max(0, Math.round(p * (sample.length - 1))))];
  let lo = at(0.005);
  let hi = at(0.995);
  if (!(hi > lo)) { lo = sample[0]; hi = sample[sample.length - 1]; }
  if (!(hi > lo)) { hi = lo + 1; }
  if (!positive_only) {
    lo = 0;
    if (!(hi > lo)) hi = 1;
  }
  return [lo, hi];
}

/*

Purpose:
	Builds the binning transform for the histogram: identity for a linear axis,
	log10 for a log axis (so log bins are evenly spaced on screen).

Input:
	range [Array<number>]: the [lo, hi] data range
	is_log [boolean]:      true for a log x-axis
	bins [number]:         number of histogram bins

Output:
	opts [Object]: { t_lo, t_hi, bins, to_data, to_t } used by histogram_curve

*/
export function axis_opts(range, is_log, bins) {
  const [lo, hi] = range;
  if (is_log) {
    return { t_lo: Math.log10(lo), t_hi: Math.log10(hi), bins, to_data: (t) => 10 ** t, to_t: (v) => (v > 0 ? Math.log10(v) : NaN) };
  }
  return { t_lo: lo, t_hi: hi, bins, to_data: (t) => t, to_t: (v) => v };
}

/*

Purpose:
	Bins a sample's event values into per-bin counts and returns them as points,
	producing a histogram that is later drawn as a smooth curve.

Input:
	values [Float64Array]: the channel's event values (one per event)
	opts [Object]:         binning transform from axis_opts()

Output:
	points [Array<{x,y}>]: per-bin { x: bin center, y: event count } points

*/
export function histogram_curve(values, opts) {
  const { t_lo, t_hi, bins, to_data, to_t } = opts;
  const width = (t_hi - t_lo) / bins;
  const counts = new Float64Array(bins);
  for (let i = 0; i < values.length; i++) {
    const t = to_t(values[i]);
    if (Number.isNaN(t) || t < t_lo || t > t_hi) continue;
    let bin = Math.floor((t - t_lo) / width);
    if (bin >= bins) bin = bins - 1;
    else if (bin < 0) bin = 0;
    counts[bin]++;
  }
  const points = new Array(bins);
  for (let i = 0; i < bins; i++) {
    points[i] = { x: to_data(t_lo + (i + 0.5) * width), y: counts[i] };
  }
  return points;
}

/*

Purpose:
	Derives a plain-array histogram summary (edges, centers, counts, width,
	range) from points already computed by histogram_curve(), for callers that
	want the raw binning shape instead of {x,y} points.

Input:
	points [Array<{x,y}>]: output of histogram_curve()
	opts [Object]:         binning transform from axis_opts(), same one passed
	                        to histogram_curve()

Output:
	summary [Object]: { binEdges, binCenters, counts, binWidth, min, max }

*/
export function build_histogram_summary(points, opts) {
  const { t_lo, t_hi, bins, to_data } = opts;
  const width = (t_hi - t_lo) / bins;
  const binEdges = new Array(bins + 1);
  for (let i = 0; i <= bins; i++) binEdges[i] = to_data(t_lo + i * width);
  const min = to_data(t_lo);
  const max = to_data(t_hi);
  return {
    binEdges,
    binCenters: points.map((p) => p.x),
    counts: points.map((p) => p.y),
    binWidth: (max - min) / bins,
    min,
    max,
  };
}
