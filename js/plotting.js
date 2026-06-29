// Plot panel rendering: per-sample event histograms drawn as smooth curves
// (D3 into #plotArea), with optional Dean–Jett–Fox cell-cycle modeling. The
// plot stays in sync with the table's checkbox selection — unchecking a row
// removes its curve without discarding the already-loaded event data.

const plot_area = document.querySelector("#plotArea");
const plot_title = document.querySelector("#plotTitle");
const plot_color_by_select = document.querySelector("#plotColorBy");
const plot_x_scale_select = document.querySelector("#plotXScale");
const plot_bins_input = document.querySelector("#plotBins");
let djf_fit_table = null;
const plot_debris_correction_toggle = document.querySelector("#plotDebrisCorrection");
const plot_doublet_correction_toggle = document.querySelector("#plotDoubletCorrection");
const plot_threshold_toggle = document.querySelector("#plotThresholdToggle");
const djf_readout = document.querySelector("#djfReadout");

const DEFAULT_BINS = 512;

// Colors come from the CSS custom properties in base.css so there is a single
// source of truth for the whole app; the fallback is used only if a token is
// missing. (Numeric sizes/widths below stay here as plain JS.)
const css_color = (name, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

// Dean–Jett–Fox cell-cycle component colors.
const DJF_G1_COLOR = css_color("--djf-g1", "#95c1dc");
const DJF_S_COLOR = css_color("--djf-s", "#d5eec8");
const DJF_G2_COLOR = css_color("--djf-g2", "#ef8b8d");
const DJF_TOTAL_COLOR = css_color("--djf-total", "#111827");
// Fill opacity for the DJF component areas (0 = transparent, 1 = solid).
const DJF_FILL_OPACITY = 0.8;
const DJF_COMPONENT_LINE_WIDTH = 1.5; // G1/S/G2 outlines
const DJF_TOTAL_LINE_WIDTH = 2; // fitted total

// ---- Plot layout & styling (tweak here) ----
const PLOT_MARGIN = { top: 14, right: 250, bottom: 48, left: 70 };
const PLOT_FALLBACK_WIDTH = 800;
const PLOT_FALLBACK_HEIGHT = 420;

const AXIS_LINE_WIDTH = 1;
const AXIS_TICK_FONT_SIZE = 11;
const AXIS_TITLE_FONT_SIZE = 12;
const AXIS_LABEL_COLOR = css_color("--text", "#172033");
const X_AXIS_TICKS = 6;
const Y_AXIS_TICKS = 5;
const X_TITLE_OFFSET = 10; // px above the bottom edge
const Y_TITLE_OFFSET = 16; // px from the left edge

const SAMPLE_LINE_WIDTH = 1.5; // per-sample histogram curves

const LEGEND_OFFSET_X = 14; // gap right of the plot area
const LEGEND_ROW_HEIGHT = 18;
const LEGEND_SWATCH_WIDTH = 18;
const LEGEND_TEXT_OFFSET = 24;
const LEGEND_LINE_WIDTH = 2;
const LEGEND_FONT_SIZE = 11;
const LEGEND_SWATCH_Y = 6; // swatch line vertical position within a row
const LEGEND_TEXT_Y = 9; // label baseline within a row
const LEGEND_CHECKBOX_SIZE = 11; // fit-toggle checkbox on sample legend rows

const THRESHOLD_COLOR = css_color("--threshold", "#9ca3af");
const THRESHOLD_LINE_WIDTH = 1.5;
const THRESHOLD_FILL_OPACITY = 0.12;
const THRESHOLD_HANDLE_WIDTH = 14; // invisible drag target thickness
const THRESHOLD_LABEL_FONT_SIZE = 10;
const THRESHOLD_LABEL_COLOR = css_color("--threshold-label", "#6b7280");
const THRESHOLD_LABEL_X_OFFSET = 6; // label inset from the left edge
const THRESHOLD_LABEL_Y_OFFSET = 5; // label sits this far above the line
const THRESHOLD_LABEL_TOP_PAD = 10; // keep the label this far below the plot top

// DNA-content channel(s) of the most recent analysis; null until analysis runs.
let plot_channels = null;
// Last non-empty x-range and y-max, reused to keep the axes drawn (not collapsed)
// when no samples are selected.
let last_range = null;
let last_y_max = null;
// Global event-count cutoff for peak detection, set by dragging the threshold
// line on the plot; applies to every sample's fit.
let peak_threshold = null;
// DJF modeling state: whether the user has started modeling, and the set of
// sample names whose fit is shown (toggled via the legend checkboxes).
let modeling_started = false;
const shown_fits = new Set();

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
function strip_fcs(name) {
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
function plot_escape_html(value) {
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
function format_fit_number(value, digits = 2) {
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
function plot_bin_count() {
  const raw = Number.parseInt(plot_bins_input && plot_bins_input.value, 10);
  if (!Number.isFinite(raw)) return DEFAULT_BINS;
  return Math.max(16, Math.min(1024, raw));
}

/*

Purpose:
	Reads the correction toggles that control event preprocessing before plotting
	and DJF fitting.

Input:
	(none)

Output:
	state [Object]: { remove_debris, remove_doublets }

*/
function correction_state() {
  return {
    remove_debris: Boolean(plot_debris_correction_toggle && plot_debris_correction_toggle.checked),
    remove_doublets: Boolean(plot_doublet_correction_toggle && plot_doublet_correction_toggle.checked),
  };
}

/*

Purpose:
  Returns the samples that should be drawn: those currently checked in the
  table AND already loaded with event data. Reads the selection through
  window.PhaseFinderApp.

Input:
  (none)

Output:
  rows [Array<Object>]: checked sample objects whose row.data.dna_a is loaded

*/
function plottable_rows() {
  const app = window.PhaseFinderApp;
  if (!app) return [];
  const active_channel = plot_channels && plot_channels.dna_area;
  return app.get_selected_files().filter((row) =>
    row.data && row.data.dna_a && (!row.data.channel_key || row.data.channel_key === active_channel)
  );
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
function sample_color(index, total) {
  const hue = total > 1 ? Math.round((index * 360) / total) % 360 : 210;
  return `hsl(${hue}, 70%, 45%)`;
}

/*

Purpose:
	Builds a function that assigns a color and a legend group to each sample.
	When coloring by strain, all samples of a strain share one hue; otherwise
	every file gets its own hue.

Input:
	rows [Array<Object>]: the samples to be plotted
	color_by [string]:    "file" or "strain"

Output:
	assign [Function]: (row, index) => { color [string], group [string] }

*/
function build_color_assigner(rows, color_by) {
  if (color_by === "strain") {
    const strain_of = (row) => (row.annotations.strain || "").trim() || "(none)";
    const strains = [...new Set(rows.map(strain_of))].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
    );
    const colors = new Map(strains.map((s, i) => [s, sample_color(i, strains.length)]));
    return (row) => ({ color: colors.get(strain_of(row)), group: strain_of(row) });
  }
  return (row, index) => ({ color: sample_color(index, rows.length), group: row.name });
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
function shared_range(rows, positive_only) {
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
function shared_range_for_values(value_sets, positive_only) {
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
function axis_opts(range, is_log, bins) {
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
function histogram_curve(values, opts) {
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

/* ---------- Rendering ---------- */

/*

Purpose:
	Updates the plot panel title to show the number of plotted samples and the
	total number of events across them.

Input:
	rows [Array<Object>]: the currently plotted samples
	event_count [number]: optional pre-computed event count

Output:
	(none) [void]: sets the #plotTitle text

*/
function update_plot_title(rows, event_count = null) {
  if (!plot_title) return;
  const events = event_count == null
    ? rows.reduce((sum, row) => sum + row.data.dna_a.length, 0)
    : event_count;
  plot_title.textContent = `Histogram of Events:  ${rows.length} Samples  |  ${events.toLocaleString()} Events`;
}

/*

Purpose:
	Renders a tabular summary of the currently visible DJF fits. Each fitted
	sample contributes one row per phase with metadata and component moments.

Input:
	fits [Array<Object>]: visible DJF fit objects
	placement [Object]:   positioning for the table overlay

Output:
	(none) [void]: updates #djfFitTable

*/
function render_fit_results_table(fits, placement = {}) {
  if (!plot_area) return;
  if (!fits.length) {
    if (djf_fit_table) {
      djf_fit_table.hidden = true;
      djf_fit_table.innerHTML = "";
    }
    return;
  }
  djf_fit_table = document.createElement("div");
  djf_fit_table.id = "djfFitTable";
  djf_fit_table.className = "djf-fit-table-wrap";
  djf_fit_table.style.top = `${Math.round(placement.top || 0)}px`;
  djf_fit_table.style.right = `${Math.round(placement.right || 8)}px`;
  if (placement.max_width) djf_fit_table.style.max_width = `${Math.round(placement.max_width)}px`;

  const fit_groups = [];
  fits.forEach((fit) => {
    const annotations = fit.row && fit.row.annotations ? fit.row.annotations : {};
    const meta = [
      `Strain: ${annotations.strain || ""}`,
      `Replicate: ${annotations.replicate || ""}`,
      `Nocodazole Arrest: ${annotations.nocodazoleArrest || ""}`,
      `Timepoint: ${annotations.timepoint || ""}`,
    ];
    const phase_rows = [fit.phase_stats.g1, fit.phase_stats.s, fit.phase_stats.g2]
      .map((phase) => `
        <tr class="djf-fit-phase-row">
          <td>${plot_escape_html(phase.phase)}</td>
          <td class="numeric-cell">${format_fit_number(phase.percent, 1)}%</td>
          <td class="numeric-cell">${format_fit_number(phase.mean, 2)}</td>
          <td class="numeric-cell">${format_fit_number(phase.stdev, 2)}</td>
        </tr>`)
      .join("");

    fit_groups.push(`
      <tbody class="djf-fit-group">
        <tr class="djf-fit-title-row">
          <th colspan="4">
            <span class="djf-fit-sample" title="${plot_escape_html(fit.name)}">${plot_escape_html(strip_fcs(fit.name))}</span>
            <span class="djf-fit-meta">${plot_escape_html(meta.join("  |  "))}</span>
          </th>
        </tr>
        <tr class="djf-fit-column-row">
          <th>Phase</th>
          <th class="numeric-cell">Percent</th>
          <th class="numeric-cell">Mean</th>
          <th class="numeric-cell">Std Dev</th>
        </tr>
        ${phase_rows}
      </tbody>`);
  });

  djf_fit_table.innerHTML = `
    <table class="djf-fit-table">
      ${fit_groups.join("")}
    </table>`;
  djf_fit_table.hidden = false;
  plot_area.appendChild(djf_fit_table);
}


/*

Purpose:
	Clears DJF modeling state so a newly selected channel starts as a plain
	event plot until the user starts modeling again.

Input:
	(none)

Output:
	(none) [void]: resets modeling flags and fit selections

*/
function reset_modeling_state() {
  modeling_started = false;
  shown_fits.clear();
  peak_threshold = null;
  if (djf_readout) {
    djf_readout.textContent = "";
  }
}

/*

Purpose:
	Initializes the plot once analysis has loaded data: stores the selected
	channel info and renders. Subsequent redraws are driven by control changes
	and table selection changes.

Input:
	channels [Object]: the selected channels, e.g. { dna_area }

Output:
	(none) [void]: stores plot state and triggers the first render

*/
function init_plot(channels) {
  plot_channels = channels;
  render_density_plot();
}

/*

Purpose:
	Begins DJF modeling (triggered by the "Start Modeling (DJF)" button). Shows
	only the first plotted sample's fit; the rest are toggled on via their legend
	checkboxes.

Input:
	(none)

Output:
	(none) [void]: enables modeling and re-renders

*/
function start_modeling() {
  if (!plot_channels) return;
  modeling_started = true;
  const rows = plottable_rows();
  shown_fits.clear();
  if (rows.length) shown_fits.add(rows[0].name);
  render_density_plot();
}

/*

Purpose:
	Toggles whether a sample's DJF fit is shown, from its legend checkbox. The
	sample's data curve is unaffected (it follows the table selection).

Input:
	name [string]: the sample's full row.name

Output:
	(none) [void]: updates shown_fits and re-renders

*/
function toggle_fit(name) {
  if (shown_fits.has(name)) {
    shown_fits.delete(name);
  } else {
    shown_fits.add(name);
  }
  render_density_plot();
}

/*

Purpose:
	The main render. Draws the overlaid event histograms for the currently
	checked samples with D3, applying the controls (color-by, axis scale, bins).
	When a sample is chosen under Model (DJF) it overlays the fitted curve and
	filled G1/S/G2 components, a draggable peak-threshold line, and a fraction
	readout. Also draws the legend and updates the title.

Input:
	(none)

Output:
	(none) [void]: rebuilds the #plotArea SVG

*/
function render_density_plot() {
  const d3 = window.d3;
  if (!d3 || !plot_area || !plot_channels) return;

  const djf = window.PhaseFinderDJF;
  const rows = plottable_rows();

  plot_area.innerHTML = "";
  if (djf_readout) djf_readout.textContent = "";

  const is_log = false;
  const color_by = plot_color_by_select ? plot_color_by_select.value : "file";
  const bins = plot_bin_count();
  const corrections = correction_state();
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
    return { row, name: row.name, color, group, values: prepared.values, stats: prepared.stats, points: histogram_curve(prepared.values, opts) };
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
      if (djf_readout) djf_readout.textContent = "Corrected DJF module is unavailable.";
    } else {
      const shown_series = series.filter((s) => shown_fits.has(s.name));
      if (shown_series.length) {
        const shown_max = d3.max(shown_series, (s) => d3.max(s.points, (pt) => pt.y)) || 1;
        if (peak_threshold == null) peak_threshold = 0.05 * shown_max;
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

  const x_scale = (is_log ? d3.scaleLog() : d3.scaleLinear())
    .domain(range)
    .range([margin.left, width - margin.right]);
  let y_max = d3.max(series, (s) => d3.max(s.points, (pt) => pt.y)) || 0;
  for (const fit of fits) y_max = Math.max(y_max, d3.max(fit.total, (pt) => pt.y) || 0);
  // Remember the populated y-max so an empty plot keeps the same y-scale.
  if (y_max > 0) {
    last_y_max = y_max;
  } else {
    y_max = last_y_max || 1;
  }
  const y_scale = d3.scaleLinear().domain([0, y_max]).nice().range([height - margin.bottom, margin.top]);

  const svg = d3.select(plot_area).append("svg").attr("width", width).attr("height", height);

  // Apply tick font size + axis line width to a rendered axis group.
  const style_axis = (g) => {
    g.style("font-size", `${AXIS_TICK_FONT_SIZE}px`);
    g.selectAll(".domain, .tick line").attr("stroke-width", AXIS_LINE_WIDTH);
    return g;
  };

  style_axis(svg.append("g")
    .attr("transform", `translate(0,${height - margin.bottom})`)
    .call(d3.axisBottom(x_scale).ticks(X_AXIS_TICKS, is_log ? "~s" : undefined)));
  style_axis(svg.append("g")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y_scale).ticks(Y_AXIS_TICKS, "~s")));

  svg.append("text")
    .attr("x", (margin.left + width - margin.right) / 2)
    .attr("y", height - X_TITLE_OFFSET)
    .attr("text-anchor", "middle")
    .attr("font-size", AXIS_TITLE_FONT_SIZE)
    .attr("fill", AXIS_LABEL_COLOR)
    .text(plot_channels.dna_area || "DNA-content area");
  svg.append("text")
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

  svg.append("g")
    .selectAll("path")
    .data(series)
    .join("path")
    .attr("fill", "none")
    .attr("stroke", (d) => d.color)
    .attr("stroke-width", SAMPLE_LINE_WIDTH)
    .attr("d", (d) => line(d.points));

  // Each shown fit: filled G1/S/G2 components (semi-transparent so overlaps
  // show) with solid outlines, plus the fitted total on top.
  const area = d3.area()
    .defined((d) => !is_log || d.x > 0)
    .x((d) => x_scale(d.x))
    .y0(y_scale(0))
    .y1((d) => y_scale(d.y))
    .curve(d3.curveBasis);

  fits.forEach((fit) => {
    const overlay = svg.append("g");
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
      group.select(".threshold-fill").attr("y", y_pix).attr("height", Math.max(0, base_y - y_pix));
      group.selectAll(".threshold-line").attr("y1", y_pix).attr("y2", y_pix);
      group.select(".threshold-label").attr("y", Math.max(margin.top + THRESHOLD_LABEL_TOP_PAD, y_pix - THRESHOLD_LABEL_Y_OFFSET));
    };

    group.append("rect").attr("class", "threshold-fill")
      .attr("x", x0).attr("width", x1 - x0)
      .attr("fill", THRESHOLD_COLOR).attr("opacity", THRESHOLD_FILL_OPACITY).attr("pointer-events", "none");
    group.append("line").attr("class", "threshold-line")
      .attr("x1", x0).attr("x2", x1)
      .attr("stroke", THRESHOLD_COLOR).attr("stroke-width", THRESHOLD_LINE_WIDTH).attr("pointer-events", "none");
    group.append("text").attr("class", "threshold-label")
      .attr("x", x0 + THRESHOLD_LABEL_X_OFFSET).attr("font-size", THRESHOLD_LABEL_FONT_SIZE).attr("fill", THRESHOLD_LABEL_COLOR)
      .text(`peak threshold: ${Math.round(threshold_value).toLocaleString()} events`);
    const handle = group.append("line").attr("class", "threshold-line")
      .attr("x1", x0).attr("x2", x1)
      .attr("stroke", "transparent").attr("stroke-width", THRESHOLD_HANDLE_WIDTH).attr("cursor", "ns-resize");

    position_at(y_scale(Math.min(threshold_value, y_max)));

    const clamp_value = (y_pix) => Math.max(0, Math.min(y_max, y_scale.invert(y_pix)));
    handle.call(
      d3.drag()
        .on("drag", (event) => {
          const value = clamp_value(event.y);
          position_at(y_scale(value));
          group.select(".threshold-label").text(`peak threshold: ${Math.round(value).toLocaleString()} events`);
        })
        .on("end", (event) => {
          peak_threshold = clamp_value(event.y);
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

/* ---------- Listeners ---------- */

[plot_color_by_select, plot_bins_input, plot_threshold_toggle].forEach((el) => {
  if (el) el.addEventListener("change", render_density_plot);
});

[plot_debris_correction_toggle, plot_doublet_correction_toggle].forEach((el) => {
  if (el) {
    el.addEventListener("change", () => {
      peak_threshold = null;
      render_density_plot();
    });
  }
});

// Live-update when the table checkbox selection changes (uncheck removes a
// curve, re-check restores it from the still-loaded data).
document.addEventListener("fcs-selection-change", () => {
  if (plot_channels) render_density_plot();
});

// Redraw on resize so the SVG tracks the panel size.
let plot_resize_timer = null;
window.addEventListener("resize", () => {
  window.clearTimeout(plot_resize_timer);
  plot_resize_timer = window.setTimeout(() => {
    if (plot_channels) render_density_plot();
  }, 150);
});
