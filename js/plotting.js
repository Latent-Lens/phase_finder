// Plot panel rendering: per-sample event histograms drawn as smooth curves
// (D3 into #plotArea), with optional Dean–Jett–Fox cell-cycle modeling. The
// plot stays in sync with the table's checkbox selection — unchecking a row
// removes its curve without discarding the already-loaded event data.

const plotArea = document.querySelector("#plotArea");
const plotTitle = document.querySelector("#plotTitle");
const plotColorBySelect = document.querySelector("#plotColorBy");
const plotXScaleSelect = document.querySelector("#plotXScale");
const plotBinsInput = document.querySelector("#plotBins");
const plotThresholdToggle = document.querySelector("#plotThresholdToggle");
const djfReadout = document.querySelector("#djfReadout");

const DEFAULT_BINS = 512;
const DJF_S_NODES = 48;

// Colors come from the CSS custom properties in base.css so there is a single
// source of truth for the whole app; the fallback is used only if a token is
// missing. (Numeric sizes/widths below stay here as plain JS.)
const cssColor = (name, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

// Dean–Jett–Fox cell-cycle component colors.
const DJF_G1_COLOR = cssColor("--djf-g1", "#95c1dc");
const DJF_S_COLOR = cssColor("--djf-s", "#d5eec8");
const DJF_G2_COLOR = cssColor("--djf-g2", "#ef8b8d");
const DJF_TOTAL_COLOR = cssColor("--djf-total", "#111827");
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
const AXIS_LABEL_COLOR = cssColor("--text", "#172033");
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

const THRESHOLD_COLOR = cssColor("--threshold", "#9ca3af");
const THRESHOLD_LINE_WIDTH = 1.5;
const THRESHOLD_FILL_OPACITY = 0.12;
const THRESHOLD_HANDLE_WIDTH = 14; // invisible drag target thickness
const THRESHOLD_LABEL_FONT_SIZE = 10;
const THRESHOLD_LABEL_COLOR = cssColor("--threshold-label", "#6b7280");
const THRESHOLD_LABEL_X_OFFSET = 6; // label inset from the left edge
const THRESHOLD_LABEL_Y_OFFSET = 5; // label sits this far above the line
const THRESHOLD_LABEL_TOP_PAD = 10; // keep the label this far below the plot top

// DNA-content channel(s) of the most recent analysis; null until analysis runs.
let plotChannels = null;
// Last non-empty x-range and y-max, reused to keep the axes drawn (not collapsed)
// when no samples are selected.
let lastRange = null;
let lastYMax = null;
// Global event-count cutoff for peak detection, set by dragging the threshold
// line on the plot; applies to every sample's fit.
let peakThreshold = null;
// DJF modeling state: whether the user has started modeling, and the set of
// sample names whose fit is shown (toggled via the legend checkboxes).
let modelingStarted = false;
const shownFits = new Set();

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
function stripFcs(name) {
  return name.replace(/\.fcs$/i, "");
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
function plotBinCount() {
  const raw = Number.parseInt(plotBinsInput && plotBinsInput.value, 10);
  if (!Number.isFinite(raw)) return DEFAULT_BINS;
  return Math.max(16, Math.min(1024, raw));
}

/*

Purpose:
	Returns the samples that should be drawn: those currently checked in the
	table AND already loaded with event data. Reads the selection through
	window.FlowPlotterApp.

Input:
	(none)

Output:
	rows [Array<Object>]: checked sample objects whose row.data.dnaA is loaded

*/
function plottableRows() {
  const app = window.FlowPlotterApp;
  if (!app) return [];
  return app.getSelectedFiles().filter((row) => row.data && row.data.dnaA);
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
function sampleColor(index, total) {
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
	colorBy [string]:     "file" or "strain"

Output:
	assign [Function]: (row, index) => { color [string], group [string] }

*/
function buildColorAssigner(rows, colorBy) {
  if (colorBy === "strain") {
    const strainOf = (row) => (row.annotations.strain || "").trim() || "(none)";
    const strains = [...new Set(rows.map(strainOf))].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
    );
    const colors = new Map(strains.map((s, i) => [s, sampleColor(i, strains.length)]));
    return (row) => ({ color: colors.get(strainOf(row)), group: strainOf(row) });
  }
  return (row, index) => ({ color: sampleColor(index, rows.length), group: row.name });
}

/*

Purpose:
	Computes a shared x-range for all plotted samples from the 0.5th–99.5th
	percentiles of a downsample of their events, so a few extreme outliers
	don't squash the curves.

Input:
	rows [Array<Object>]:   the plotted samples (uses row.data.dnaA)
	positiveOnly [boolean]: drop values <= 0 first (needed for a log axis)

Output:
	range [Array<number>]: the [lo, hi] x-range

*/
function sharedRange(rows, positiveOnly) {
  const total = rows.reduce((sum, row) => sum + row.data.dnaA.length, 0);
  const stride = Math.max(1, Math.floor(total / 50000));
  const sample = [];
  for (const row of rows) {
    const values = row.data.dnaA;
    for (let i = 0; i < values.length; i += stride) {
      const v = values[i];
      if (!positiveOnly || v > 0) sample.push(v);
    }
  }
  if (!sample.length) return positiveOnly ? [1, 10] : [0, 1];
  sample.sort((a, b) => a - b);
  const at = (p) => sample[Math.min(sample.length - 1, Math.max(0, Math.round(p * (sample.length - 1))))];
  let lo = at(0.005);
  let hi = at(0.995);
  if (!(hi > lo)) { lo = sample[0]; hi = sample[sample.length - 1]; }
  if (!(hi > lo)) { hi = lo + 1; }
  return [lo, hi];
}

/*

Purpose:
	Builds the binning transform for the histogram: identity for a linear axis,
	log10 for a log axis (so log bins are evenly spaced on screen).

Input:
	range [Array<number>]: the [lo, hi] data range
	isLog [boolean]:       true for a log x-axis
	bins [number]:         number of histogram bins

Output:
	opts [Object]: { tLo, tHi, bins, toData, toT } used by histogramCurve

*/
function axisOpts(range, isLog, bins) {
  const [lo, hi] = range;
  if (isLog) {
    return { tLo: Math.log10(lo), tHi: Math.log10(hi), bins, toData: (t) => 10 ** t, toT: (v) => (v > 0 ? Math.log10(v) : NaN) };
  }
  return { tLo: lo, tHi: hi, bins, toData: (t) => t, toT: (v) => v };
}

/*

Purpose:
	Bins a sample's event values into per-bin counts and returns them as points,
	producing a histogram that is later drawn as a smooth curve.

Input:
	values [Float64Array]: the channel's event values (one per event)
	opts [Object]:         binning transform from axisOpts()

Output:
	points [Array<{x,y}>]: per-bin { x: bin center, y: event count } points

*/
function histogramCurve(values, opts) {
  const { tLo, tHi, bins, toData, toT } = opts;
  const width = (tHi - tLo) / bins;
  const counts = new Float64Array(bins);
  for (let i = 0; i < values.length; i++) {
    const t = toT(values[i]);
    if (Number.isNaN(t) || t < tLo || t > tHi) continue;
    let bin = Math.floor((t - tLo) / width);
    if (bin >= bins) bin = bins - 1;
    else if (bin < 0) bin = 0;
    counts[bin]++;
  }
  const points = new Array(bins);
  for (let i = 0; i < bins; i++) {
    points[i] = { x: toData(tLo + (i + 0.5) * width), y: counts[i] };
  }
  return points;
}

/* ---------- Dean–Jett–Fox model (Full Fox broadening) ---------- */

/*

Purpose:
	Evaluates a unit-area (normalized) Gaussian at a given distance from its
	mean. Used as the building block for the DJF G1/G2 peaks and S broadening.

Input:
	distance [number]: distance from the Gaussian's mean (x - mean)
	sigma [number]:    standard deviation

Output:
	density [number]: the normalized Gaussian value at that distance

*/
function gaussian(distance, sigma) {
  return Math.exp(-(distance * distance) / (2 * sigma * sigma)) / (sigma * Math.sqrt(2 * Math.PI));
}

/*

Purpose:
	Evaluates the three DJF cell-cycle components at one channel value. G1 and
	G2 are Gaussians with M2 = 2*M1 and sigma2 = 2*sigma1 (constant CV); the S
	phase is a quadratic in normalized position broadened by a Gaussian whose
	width varies linearly from sigma1 to sigma2 (Full Fox).

Input:
	value [number]:    the channel value (x position) to evaluate
	p [Array<number>]: [M1, sigma1, aG1, aG2, s0, s1, s2] fit parameters

Output:
	components [Object]: { g1, s, g2 } component heights at that x

*/
function djfComponents(value, p) {
  const [M1, sigma1, aG1, aG2, s0, s1, s2] = p;
  const M2 = 2 * M1;
  const sigma2 = 2 * sigma1;
  const g1 = aG1 * gaussian(value - M1, sigma1);
  const g2 = aG2 * gaussian(value - M2, sigma2);
  let s = 0;
  const span = M2 - M1;
  const du = span / DJF_S_NODES;
  for (let k = 0; k < DJF_S_NODES; k++) {
    const pos = (k + 0.5) / DJF_S_NODES;
    let height = s0 + s1 * pos + s2 * pos * pos;
    if (height < 0) height = 0;
    const u = M1 + pos * span;
    const sigU = sigma1 + (sigma2 - sigma1) * pos;
    s += height * gaussian(value - u, sigU) * du;
  }
  return { g1, s, g2 };
}

/*

Purpose:
	Evaluates the full DJF model (the sum of the G1, S and G2 components) at one
	channel value. This is the function the least-squares fit is run against.

Input:
	value [number]:    the channel value (x position) to evaluate
	p [Array<number>]: the DJF fit parameters (see djfComponents)

Output:
	total [number]: the summed model height (G1 + S + G2) at that x

*/
function djfModel(value, p) {
  const c = djfComponents(value, p);
  return c.g1 + c.s + c.g2;
}

/*

Purpose:
	Finds histogram peaks (left to right) above an absolute event-count cutoff.
	Uses the ml-gsd library when present and falls back to a simple local-maxima
	scan otherwise.

Input:
	points [Array<{x,y}>]:   the sample's histogram points
	threshold [number|null]: absolute event-count cutoff; null = 5% of the max bin

Output:
	peaks [Array<{x,y}>]: detected peaks, sorted left to right (may be empty)

*/
function detectPeaks(points, threshold) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const maxY = ys.reduce((m, v) => Math.max(m, v), 0) || 1;
  const cutoff = threshold != null ? threshold : 0.05 * maxY;

  if (typeof window.gsd === "function") {
    try {
      const minMaxRatio = Math.min(0.99, Math.max(1e-4, cutoff / maxY));
      const found = window.gsd({ x: xs, y: ys }, { minMaxRatio, smoothY: true, realTopDetection: true });
      const peaks = (found || [])
        .map((pk) => ({ x: pk.x, y: pk.y != null ? pk.y : pk.height }))
        .filter((pk) => Number.isFinite(pk.x) && Number.isFinite(pk.y) && pk.y >= cutoff);
      if (peaks.length) {
        peaks.sort((a, b) => a.x - b.x);
        return peaks;
      }
    } catch (error) {
      // fall through to the manual scan
    }
  }

  const win = Math.max(2, Math.floor(points.length / 48));
  const peaks = [];
  for (let i = 0; i < points.length; i++) {
    if (ys[i] < cutoff) continue;
    let isMax = true;
    for (let j = Math.max(0, i - win); j <= Math.min(points.length - 1, i + win); j++) {
      if (ys[j] > ys[i]) { isMax = false; break; }
    }
    if (isMax) {
      peaks.push({ x: xs[i], y: ys[i] });
      i += win;
    }
  }
  return peaks;
}

/*

Purpose:
	Among the detected peaks, finds the tallest pair whose positions sit at a
	~2x ratio — the G1 (2N) and G2 (4N) peaks. Using the pair is robust even
	when G2 is the dominant peak and G1 is small.

Input:
	peaks [Array<{x,y}>]: detected histogram peaks

Output:
	pair [Object|null]: { g1, g2 } peak points, or null if no ~2x pair exists

*/
function bestG1G2Pair(peaks) {
  let best = null;
  let bestScore = -Infinity;
  for (let i = 0; i < peaks.length; i++) {
    for (let j = 0; j < peaks.length; j++) {
      if (i === j || peaks[j].x <= peaks[i].x) continue;
      const ratio = peaks[j].x / peaks[i].x;
      if (ratio < 1.7 || ratio > 2.3) continue;
      const score = peaks[i].y + peaks[j].y;
      if (score > bestScore) {
        bestScore = score;
        best = { g1: peaks[i], g2: peaks[j] };
      }
    }
  }
  return best;
}

/*

Purpose:
	Returns the y value of the histogram point nearest a given x. Used to seed
	component amplitudes from the actual counts at the G1 and G2 positions.

Input:
	points [Array<{x,y}>]: the sample's histogram points
	x [number]:            the x position to look up

Output:
	y [number]: the count at the nearest bin (0 if there are no points)

*/
function valueAt(points, x) {
  let best = 0;
  let bestDist = Infinity;
  for (const p of points) {
    const dist = Math.abs(p.x - x);
    if (dist < bestDist) { bestDist = dist; best = p.y; }
  }
  return best;
}

/*

Purpose:
	Estimates the shared 2N (G1) channel position for the run. Since the 2N
	position is fixed by the stain, it takes the median G1 across the samples
	that show a clear G1/G2 pair; samples that only show a G2 peak (e.g. fully
	arrested) can then be seeded with this shared value.

Input:
	rows [Array<Object>]: all plotted samples
	opts [Object]:        binning transform from axisOpts()

Output:
	g1 [number|null]: the run-wide G1 position, or null if no pair was found

*/
function estimateRunG1(rows, opts) {
  const positions = [];
  for (const row of rows) {
    const pair = bestG1G2Pair(detectPeaks(histogramCurve(row.data.dnaA, opts)));
    if (pair) positions.push(pair.g1.x);
  }
  if (!positions.length) return null;
  positions.sort((a, b) => a - b);
  return positions[Math.floor((positions.length - 1) / 2)];
}

/*

Purpose:
	Produces an initial DJF parameter guess for the fit by locating G1 from the
	histogram peaks. Prefers the tallest peak pair at a ~2x ratio; otherwise
	falls back to a run-wide G1 hint, then to the most prominent peak. Getting
	G1 right matters most because G2 is pinned at 2x G1.

Input:
	points [Array<{x,y}>]:   the modeled sample's histogram points
	range [Array<number>]:   the [lo, hi] x-range
	threshold [number|null]: peak-detection cutoff (the draggable line height)
	g1Hint [number|null]:    run-wide G1 position to fall back on, or null

Output:
	seed [Array<number>]: [M1, sigma1, aG1, aG2, s0, s1, s2] initial guess

*/
function seedDJF(points, range, threshold, g1Hint) {
  const [lo, hi] = range;
  const peaks = detectPeaks(points, threshold);
  const globalMax = points.reduce((m, p) => Math.max(m, p.y), 1);

  let M1 = null;
  let peakY = null;
  let g2Y = null;

  const pair = bestG1G2Pair(peaks);
  if (pair) {
    M1 = pair.g1.x;
    peakY = pair.g1.y;
    g2Y = pair.g2.y;
  } else if (g1Hint != null) {
    // No pair in THIS sample (e.g. only the G2/M peak): use the run-wide G1
    // position and seed amplitudes from the actual counts at G1 and 2*G1.
    M1 = g1Hint;
    peakY = valueAt(points, M1);
    g2Y = valueAt(points, 2 * M1);
  } else if (peaks.length) {
    const tallest = peaks.reduce((t, p) => (p.y > t.y ? p : t), peaks[0]);
    const halfMate = peaks.find((p) => Math.abs(p.x - tallest.x / 2) < 0.2 * tallest.x);
    if (halfMate) {
      M1 = halfMate.x; peakY = halfMate.y; g2Y = tallest.y;
    } else {
      M1 = tallest.x; peakY = tallest.y;
    }
  } else {
    M1 = lo + 0.25 * (hi - lo);
    peakY = globalMax;
  }

  const sigma1 = Math.max((hi - lo) * 0.015, 0.03 * M1);
  const aG1 = Math.max(peakY, 1e-9) * sigma1 * Math.sqrt(2 * Math.PI);
  const aG2 = g2Y != null ? Math.max(g2Y, 1e-9) * (2 * sigma1) * Math.sqrt(2 * Math.PI) : 0.3 * aG1;

  return [M1, sigma1, aG1, aG2, 0.05 * Math.max(peakY, 1e-9), 0, 0];
}

/*

Purpose:
	Fits the DJF model to a sample's histogram with Levenberg–Marquardt
	(ml-levenberg-marquardt). Seeds from seedDJF and bounds the parameters,
	pinning M1 near the run G1 when known so the fit can't mistake a dominant
	G2 peak for G1.

Input:
	points [Array<{x,y}>]:   the modeled sample's histogram points
	range [Array<number>]:   the [lo, hi] x-range
	threshold [number|null]: peak-detection cutoff used for seeding
	g1Hint [number|null]:    run-wide G1 position to pin M1 near, or null

Output:
	params [Array<number>|null]: fitted [M1, sigma1, aG1, aG2, s0, s1, s2], or null if the fit fails or the library is missing

*/
function fitDJF(points, range, threshold, g1Hint) {
  const LM = window.levenbergMarquardt;
  if (!LM) return null;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const initial = seedDJF(points, range, threshold, g1Hint);
  const [lo, hi] = range;
  const span = hi - lo;
  const maxY = Math.max(...ys, 1);
  const bigA = maxY * span * 10 + 10;
  const bigS = maxY * 10 + 10;
  // The 2N (G1) channel is fixed by the stain/run, so when we know it, pin M1
  // tightly around it. Otherwise the free fit can park G1 on a dominant G2/M
  // peak (calling it G1) and absorb the rest into S.
  const m1Lo = g1Hint != null ? g1Hint * 0.85 : lo;
  const m1Hi = g1Hint != null ? g1Hint * 1.15 : lo + 0.7 * span;
  const minValues = [m1Lo, span * 0.002, 0, 0, -bigS, -bigS, -bigS];
  const maxValues = [m1Hi, span * 0.25, bigA, bigA, bigS, bigS, bigS];
  try {
    const result = LM(
      { x: xs, y: ys },
      (p) => (x) => djfModel(x, p),
      {
        initialValues: initial,
        minValues,
        maxValues,
        damping: 1e-2,
        gradientDifference: 1e-4,
        maxIterations: 120,
        errorTolerance: 1e-9,
      },
    );
    return result.parameterValues;
  } catch (error) {
    return null;
  }
}

/*

Purpose:
	Integrates the fitted G1, S and G2 components over the histogram and returns
	each as a percentage of the total — the cell-cycle phase fractions.

Input:
	points [Array<{x,y}>]: the modeled sample's histogram points
	p [Array<number>]:     the fitted DJF parameters

Output:
	fractions [Object]: { g1, s, g2 } as percentages summing to 100

*/
function djfFractions(points, p) {
  let g1 = 0;
  let s = 0;
  let g2 = 0;
  for (const pt of points) {
    const c = djfComponents(pt.x, p);
    g1 += c.g1;
    s += c.s;
    g2 += c.g2;
  }
  const total = g1 + s + g2 || 1;
  return { g1: (g1 / total) * 100, s: (s / total) * 100, g2: (g2 / total) * 100 };
}

/* ---------- Rendering ---------- */

/*

Purpose:
	Updates the plot panel title to show the number of plotted samples and the
	total number of events across them.

Input:
	rows [Array<Object>]: the currently plotted samples

Output:
	(none) [void]: sets the #plotTitle text

*/
function updatePlotTitle(rows) {
  if (!plotTitle) return;
  const events = rows.reduce((sum, row) => sum + row.data.dnaA.length, 0);
  plotTitle.textContent = `Histogram of Events:  ${rows.length} Samples  |  ${events.toLocaleString()} Events`;
}

/*

Purpose:
	Initializes the plot once analysis has loaded data: stores the selected
	channel info and renders. Subsequent redraws are driven by control changes
	and table selection changes.

Input:
	channels [Object]: the selected channels, e.g. { dnaArea }

Output:
	(none) [void]: stores plot state and triggers the first render

*/
function initPlot(channels) {
  plotChannels = channels;
  renderDensityPlot();
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
function startModeling() {
  if (!plotChannels) return;
  modelingStarted = true;
  const rows = plottableRows();
  shownFits.clear();
  if (rows.length) shownFits.add(rows[0].name);
  renderDensityPlot();
}

/*

Purpose:
	Toggles whether a sample's DJF fit is shown, from its legend checkbox. The
	sample's data curve is unaffected (it follows the table selection).

Input:
	name [string]: the sample's full row.name

Output:
	(none) [void]: updates shownFits and re-renders

*/
function toggleFit(name) {
  if (shownFits.has(name)) {
    shownFits.delete(name);
  } else {
    shownFits.add(name);
  }
  renderDensityPlot();
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
function renderDensityPlot() {
  const d3 = window.d3;
  if (!d3 || !plotArea || !plotChannels) return;

  const rows = plottableRows();
  updatePlotTitle(rows);

  plotArea.innerHTML = "";
  if (djfReadout) djfReadout.textContent = "";

  const isLog = plotXScaleSelect && plotXScaleSelect.value === "log";
  const colorBy = plotColorBySelect ? plotColorBySelect.value : "file";
  const bins = plotBinCount();

  // With samples, compute the range and remember it; with none, keep the axes
  // by reusing the last range (or a sensible default) instead of bailing out.
  let range;
  if (rows.length) {
    range = sharedRange(rows, isLog);
    lastRange = range;
  } else if (lastRange && (!isLog || lastRange[0] > 0)) {
    range = lastRange;
  } else {
    range = isLog ? [1, 10] : [0, 1];
  }
  const opts = axisOpts(range, isLog, bins);

  const assign = buildColorAssigner(rows, colorBy);
  const series = rows.map((row, index) => {
    const { color, group } = assign(row, index);
    return { name: row.name, color, group, points: histogramCurve(row.data.dnaA, opts) };
  });

  // Dean–Jett–Fox: one independent fit per shown sample (linear axis only). The
  // peak-detection threshold is a single draggable line shared by all fits;
  // default 5% of the tallest shown bin.
  const fits = [];
  let thresholdValue = null;
  if (modelingStarted && rows.length) {
    if (isLog) {
      if (djfReadout) djfReadout.textContent = "DJF requires a linear X-axis.";
    } else {
      const shownSeries = series.filter((s) => shownFits.has(s.name));
      if (shownSeries.length) {
        const shownMax = d3.max(shownSeries, (s) => d3.max(s.points, (pt) => pt.y)) || 1;
        if (peakThreshold == null) peakThreshold = 0.05 * shownMax;
        thresholdValue = peakThreshold;
        const runG1 = estimateRunG1(rows, opts);
        for (const s of shownSeries) {
          const params = fitDJF(s.points, range, thresholdValue, runG1);
          if (!params) continue;
          const comps = s.points.map((pt) => ({ x: pt.x, c: djfComponents(pt.x, params) }));
          fits.push({
            name: s.name,
            total: comps.map((o) => ({ x: o.x, y: o.c.g1 + o.c.s + o.c.g2 })),
            g1: comps.map((o) => ({ x: o.x, y: o.c.g1 })),
            s: comps.map((o) => ({ x: o.x, y: o.c.s })),
            g2: comps.map((o) => ({ x: o.x, y: o.c.g2 })),
            fractions: djfFractions(s.points, params),
          });
        }
      }
      if (djfReadout) {
        djfReadout.textContent = fits
          .map((fit) => `${stripFcs(fit.name)}: G1 ${fit.fractions.g1.toFixed(1)}% · S ${fit.fractions.s.toFixed(1)}% · G2 ${fit.fractions.g2.toFixed(1)}%`)
          .join("     |     ");
      }
    }
  }

  const width = plotArea.clientWidth || PLOT_FALLBACK_WIDTH;
  const height = plotArea.clientHeight || PLOT_FALLBACK_HEIGHT;
  const margin = PLOT_MARGIN;

  const xScale = (isLog ? d3.scaleLog() : d3.scaleLinear())
    .domain(range)
    .range([margin.left, width - margin.right]);
  let yMax = d3.max(series, (s) => d3.max(s.points, (pt) => pt.y)) || 0;
  for (const fit of fits) yMax = Math.max(yMax, d3.max(fit.total, (pt) => pt.y) || 0);
  // Remember the populated y-max so an empty plot keeps the same y-scale.
  if (yMax > 0) {
    lastYMax = yMax;
  } else {
    yMax = lastYMax || 1;
  }
  const yScale = d3.scaleLinear().domain([0, yMax]).nice().range([height - margin.bottom, margin.top]);

  const svg = d3.select(plotArea).append("svg").attr("width", width).attr("height", height);

  // Apply tick font size + axis line width to a rendered axis group.
  const styleAxis = (g) => {
    g.style("font-size", `${AXIS_TICK_FONT_SIZE}px`);
    g.selectAll(".domain, .tick line").attr("stroke-width", AXIS_LINE_WIDTH);
    return g;
  };

  styleAxis(svg.append("g")
    .attr("transform", `translate(0,${height - margin.bottom})`)
    .call(d3.axisBottom(xScale).ticks(X_AXIS_TICKS, isLog ? "~s" : undefined)));
  styleAxis(svg.append("g")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(yScale).ticks(Y_AXIS_TICKS, "~s")));

  svg.append("text")
    .attr("x", (margin.left + width - margin.right) / 2)
    .attr("y", height - X_TITLE_OFFSET)
    .attr("text-anchor", "middle")
    .attr("font-size", AXIS_TITLE_FONT_SIZE)
    .attr("fill", AXIS_LABEL_COLOR)
    .text(plotChannels.dnaArea || "DNA-content area");
  svg.append("text")
    .attr("transform", "rotate(-90)")
    .attr("x", -(margin.top + height - margin.bottom) / 2)
    .attr("y", Y_TITLE_OFFSET)
    .attr("text-anchor", "middle")
    .attr("font-size", AXIS_TITLE_FONT_SIZE)
    .attr("fill", AXIS_LABEL_COLOR)
    .text("Number of Events");

  const line = d3.line()
    .defined((d) => !isLog || d.x > 0)
    .x((d) => xScale(d.x))
    .y((d) => yScale(d.y))
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
    .defined((d) => !isLog || d.x > 0)
    .x((d) => xScale(d.x))
    .y0(yScale(0))
    .y1((d) => yScale(d.y))
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
  const showThreshold = thresholdValue != null && plotThresholdToggle && plotThresholdToggle.checked;
  if (showThreshold) {
    const x0 = margin.left;
    const x1 = width - margin.right;
    const baseY = height - margin.bottom;
    const group = svg.append("g");

    const positionAt = (yPix) => {
      group.select(".threshold-fill").attr("y", yPix).attr("height", Math.max(0, baseY - yPix));
      group.selectAll(".threshold-line").attr("y1", yPix).attr("y2", yPix);
      group.select(".threshold-label").attr("y", Math.max(margin.top + THRESHOLD_LABEL_TOP_PAD, yPix - THRESHOLD_LABEL_Y_OFFSET));
    };

    group.append("rect").attr("class", "threshold-fill")
      .attr("x", x0).attr("width", x1 - x0)
      .attr("fill", THRESHOLD_COLOR).attr("opacity", THRESHOLD_FILL_OPACITY).attr("pointer-events", "none");
    group.append("line").attr("class", "threshold-line")
      .attr("x1", x0).attr("x2", x1)
      .attr("stroke", THRESHOLD_COLOR).attr("stroke-width", THRESHOLD_LINE_WIDTH).attr("pointer-events", "none");
    group.append("text").attr("class", "threshold-label")
      .attr("x", x0 + THRESHOLD_LABEL_X_OFFSET).attr("font-size", THRESHOLD_LABEL_FONT_SIZE).attr("fill", THRESHOLD_LABEL_COLOR)
      .text(`peak threshold: ${Math.round(thresholdValue).toLocaleString()} events`);
    const handle = group.append("line").attr("class", "threshold-line")
      .attr("x1", x0).attr("x2", x1)
      .attr("stroke", "transparent").attr("stroke-width", THRESHOLD_HANDLE_WIDTH).attr("cursor", "ns-resize");

    positionAt(yScale(Math.min(thresholdValue, yMax)));

    const clampValue = (yPix) => Math.max(0, Math.min(yMax, yScale.invert(yPix)));
    handle.call(
      d3.drag()
        .on("drag", (event) => {
          const value = clampValue(event.y);
          positionAt(yScale(value));
          group.select(".threshold-label").text(`peak threshold: ${Math.round(value).toLocaleString()} events`);
        })
        .on("end", (event) => {
          peakThreshold = clampValue(event.y);
          renderDensityPlot();
        }),
    );
  }

  // Legend: one row per sample (each gets a fit checkbox once modeling has
  // started), then the fitted-component rows for every shown fit. With more than
  // one fit shown, component labels are prefixed with the sample name.
  const legendItems = series.map((s) => ({ type: "sample", name: s.name, color: s.color }));
  const multipleFits = fits.length > 1;
  fits.forEach((fit) => {
    const prefix = multipleFits ? `${stripFcs(fit.name)} ` : "";
    legendItems.push(
      { type: "component", label: `${prefix}DJF fit`, color: DJF_TOTAL_COLOR },
      { type: "component", label: `${prefix}G1`, color: DJF_G1_COLOR },
      { type: "component", label: `${prefix}S`, color: DJF_S_COLOR },
      { type: "component", label: `${prefix}G2`, color: DJF_G2_COLOR },
    );
  });

  const checkboxCol = modelingStarted ? LEGEND_CHECKBOX_SIZE + 6 : 0;
  const legend = svg.append("g").attr("transform", `translate(${width - margin.right + LEGEND_OFFSET_X},${margin.top})`);
  const items = legend.selectAll("g").data(legendItems).join("g").attr("transform", (d, i) => `translate(0,${i * LEGEND_ROW_HEIGHT})`);

  if (modelingStarted) {
    // Clickable checkbox on each sample row to show/hide that sample's fit.
    const sampleRows = items.filter((d) => d.type === "sample").attr("cursor", "pointer").on("click", (event, d) => toggleFit(d.name));
    sampleRows.append("rect")
      .attr("x", 0).attr("y", LEGEND_SWATCH_Y - LEGEND_CHECKBOX_SIZE / 2)
      .attr("width", LEGEND_CHECKBOX_SIZE).attr("height", LEGEND_CHECKBOX_SIZE).attr("rx", 2)
      .attr("fill", "#fff").attr("stroke", THRESHOLD_COLOR);
    sampleRows.filter((d) => shownFits.has(d.name)).append("path")
      .attr("d", `M2,${LEGEND_SWATCH_Y} l2.5,2.5 l5,-5`)
      .attr("fill", "none").attr("stroke", DJF_TOTAL_COLOR).attr("stroke-width", 1.6).attr("pointer-events", "none");
  }

  items.append("line")
    .attr("x1", checkboxCol).attr("x2", checkboxCol + LEGEND_SWATCH_WIDTH)
    .attr("y1", LEGEND_SWATCH_Y).attr("y2", LEGEND_SWATCH_Y)
    .attr("stroke", (d) => d.color).attr("stroke-width", LEGEND_LINE_WIDTH);
  items.append("text")
    .attr("x", checkboxCol + LEGEND_TEXT_OFFSET).attr("y", LEGEND_TEXT_Y)
    .attr("font-size", LEGEND_FONT_SIZE).attr("fill", AXIS_LABEL_COLOR)
    .text((d) => (d.type === "sample" ? stripFcs(d.name) : d.label));
}

/* ---------- Listeners ---------- */

[plotColorBySelect, plotXScaleSelect, plotBinsInput, plotThresholdToggle].forEach((el) => {
  if (el) el.addEventListener("change", renderDensityPlot);
});

// Live-update when the table checkbox selection changes (uncheck removes a
// curve, re-check restores it from the still-loaded data).
document.addEventListener("fcs-selection-change", () => {
  if (plotChannels) renderDensityPlot();
});

// Redraw on resize so the SVG tracks the panel size.
let plotResizeTimer = null;
window.addEventListener("resize", () => {
  window.clearTimeout(plotResizeTimer);
  plotResizeTimer = window.setTimeout(() => {
    if (plotChannels) renderDensityPlot();
  }, 150);
});
