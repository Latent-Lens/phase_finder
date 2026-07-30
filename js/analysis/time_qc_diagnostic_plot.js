// Acquisition-order diagnostic plot for peak-tracking Time QC -- Phase 2 of
// docs/plans/peak_tracking_time_qc_implementation_spec.md ("Diagnostic plot").
//
// Everything the plot needs already lives in the Stage-1 peak-tracking result
// (peak_tracking_time_qc.js): result.segmentResults[] carries, per acquisition
// segment, the tracked peak positions (peakColumns), their per-track metadata
// (peakMetadata, including the per-bin `imputed` mask from SCI-09C), and the
// per-bin good/rejected mask (goodBinMask). This module only turns that into a
// drawable model and an SVG -- no fitting, no re-detection.
//
// The spec lists four layers: individual events at low opacity, tracked peak
// positions, rejected-bin shading, and acquisition segment boundaries. The raw
// per-event channel values are NOT retained on the result (only masks and the
// per-bin tracked positions survive Stage 1), so the event-scatter layer is
// intentionally omitted; the spec itself notes that for peak-tracking mode the
// tracked-peak layer is "more informative than median-only traces." The other
// three layers are all drawn, with a channel picker.
//
// buildTimeQcDiagnosticModel(result, { channel }) -> pure, testable plot model
// renderTimeQcDiagnosticSvg(model, options)       -> a standalone SVG string
// timeQcDiagnosticChannels(result)                -> channels that have a track
// timeQcDiagnosticAvailable(result)               -> is there anything to draw

// A small, colour-blind-friendly qualitative palette for the peak tracks. One
// colour per track within the selected channel; kept short and cycled so the
// plot stays legible even with several tracks.
const TRACK_COLORS = ["#2563eb", "#d97706", "#059669", "#db2743", "#7c3aed", "#0891b2"];

/*

Purpose:
	Lists the channels that produced at least one persistent peak track in a
	peak-tracking Time QC result, in first-seen order -- the options a channel
	picker offers.

Input:
	result [object]: a peak-tracking Time QC result (or anything without segments)

Output:
	channels [array]: the distinct channel names that have a track

*/
export function timeQcDiagnosticChannels(result) {
  const channels = [];
  for (const segment of result?.segmentResults ?? []) {
    for (const meta of segment?.peakMetadata ?? []) {
      if (meta?.channel && !channels.includes(meta.channel)) channels.push(meta.channel);
    }
  }
  return channels;
}

/*

Purpose:
	Reports whether a result carries enough peak-tracking diagnostics to draw the
	acquisition-order plot (peak-tracking method, at least one segment, at least
	one track). Robust-summary results and skipped runs return false.

Input:
	result [object]: a Time QC result

Output:
	available [boolean]: true when buildTimeQcDiagnosticModel would have data

*/
export function timeQcDiagnosticAvailable(result) {
  if (!result || result.method !== "peak-tracking" || result.skipped) return false;
  return timeQcDiagnosticChannels(result).length > 0;
}

// Collapses a sorted list of rejected bin indices into contiguous [start, end]
// spans so the shading draws one rectangle per rejected region rather than one
// per bin.
function mergeRejectedSpans(rejectedBins) {
  const spans = [];
  let start = null;
  let previous = null;
  for (const bin of rejectedBins) {
    if (start === null) {
      start = bin;
      previous = bin;
    } else if (bin === previous + 1) {
      previous = bin;
    } else {
      spans.push([start, previous]);
      start = bin;
      previous = bin;
    }
  }
  if (start !== null) spans.push([start, previous]);
  return spans;
}

/*

Purpose:
	Turns a peak-tracking Time QC result into a pure, drawable model for the
	acquisition-order plot: the tracks (filtered to one channel), the rejected-bin
	spans, and the segment layout laid end to end along a single global bin axis.
	No DOM, no rendering -- so the layout maths can be unit-tested directly.

Input:
	result [object]: a peak-tracking Time QC result
	options [object]: { channel } -- the channel to show; falls back to the first
	                  available channel when omitted or not present

Output:
	model [object]: {
	  channels, activeChannel,
	  segments: [{ segmentId, xStart, binCount, rejectedSpans, tracks:
	              [{ channel, label, trackIndex, color, points:
	                 [{ binIndex, x, value, imputed }] }] }],
	  totalBins, xExtent:[0,totalBins], yExtent:[min,max], hasData }

*/
export function buildTimeQcDiagnosticModel(result, { channel = null } = {}) {
  const channels = timeQcDiagnosticChannels(result);
  const activeChannel = channel && channels.includes(channel) ? channel : (channels[0] ?? null);
  const segments = result?.segmentResults ?? [];

  const modelSegments = [];
  let offset = 0;
  let yMin = Infinity;
  let yMax = -Infinity;
  // Colours are assigned per (channel, trackIndex) across the whole plot so the
  // same track keeps its colour across segments.
  const colorByTrackKey = new Map();

  for (const segment of segments) {
    const binCount = segment?.binCount ?? (segment?.goodBinMask ? segment.goodBinMask.length : 0);

    const rejectedBins = [];
    const mask = segment?.goodBinMask;
    if (mask) {
      for (let bin = 0; bin < binCount; bin += 1) {
        if (mask[bin] !== 1) rejectedBins.push(bin);
      }
    }

    const columns = segment?.peakColumns ?? [];
    const metas = segment?.peakMetadata ?? [];
    const tracks = [];
    for (let column = 0; column < columns.length; column += 1) {
      const meta = metas[column] ?? {};
      if (activeChannel && meta.channel !== activeChannel) continue;

      const key = `${meta.channel}#${meta.trackIndex ?? column}`;
      if (!colorByTrackKey.has(key)) colorByTrackKey.set(key, TRACK_COLORS[colorByTrackKey.size % TRACK_COLORS.length]);

      const positions = columns[column] ?? [];
      const imputed = meta.imputed ?? [];
      const missingReasons = meta.missingReasons ?? [];
      const points = [];
      for (let bin = 0; bin < positions.length; bin += 1) {
        const value = positions[bin];
        if (!Number.isFinite(value)) continue;
        points.push({
          binIndex: bin,
          x: offset + bin,
          value,
          imputed: Boolean(imputed[bin]),
          missingReason: missingReasons[bin] ?? null,
        });
        if (value < yMin) yMin = value;
        if (value > yMax) yMax = value;
      }
      tracks.push({
        channel: meta.channel,
        label: meta.label ?? `${meta.channel} peak ${(meta.trackIndex ?? column) + 1}`,
        trackIndex: meta.trackIndex ?? column,
        color: colorByTrackKey.get(key),
        points,
      });
    }

    modelSegments.push({
      segmentId: segment?.segmentId ?? modelSegments.length,
      xStart: offset,
      binCount,
      rejectedSpans: mergeRejectedSpans(rejectedBins),
      tracks,
    });
    offset += binCount;
  }

  const totalBins = offset;
  if (!(yMin <= yMax)) {
    yMin = 0;
    yMax = 1;
  }
  const pad = (yMax - yMin) * 0.05 || Math.max(1, Math.abs(yMax) * 0.05);

  return {
    channels,
    activeChannel,
    segments: modelSegments,
    totalBins,
    xExtent: [0, Math.max(1, totalBins)],
    yExtent: [yMin - pad, yMax + pad],
    hasData: modelSegments.some((segment) => segment.tracks.some((track) => track.points.length > 0)),
  };
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/*

Purpose:
	Renders a diagnostic-plot model to a standalone SVG string with the three
	drawable layers: rejected-region shading, acquisition segment boundaries, and
	the tracked peak polylines (imputed bins marked with hollow points). Uses
	currentColor for axes/labels so it inherits the surrounding text colour and
	themes in light and dark automatically.

Input:
	model [object]: the output of buildTimeQcDiagnosticModel
	options [object]: { width, height } in px (sensible defaults otherwise)

Output:
	svg [string]: a complete <svg>...</svg> markup string

*/
export function renderTimeQcDiagnosticSvg(model, { width = 640, height = 260 } = {}) {
  const margin = { top: 14, right: 14, bottom: 30, left: 48 };
  const innerWidth = Math.max(1, width - margin.left - margin.right);
  const innerHeight = Math.max(1, height - margin.top - margin.bottom);

  const [xMin, xMax] = model.xExtent;
  const [yMin, yMax] = model.yExtent;
  const xSpan = Math.max(1e-9, xMax - xMin);
  const ySpan = Math.max(1e-9, yMax - yMin);
  const xPx = (x) => margin.left + ((x - xMin) / xSpan) * innerWidth;
  const yPx = (y) => margin.top + (1 - (y - yMin) / ySpan) * innerHeight;

  const layers = [];

  // Layer 1: rejected-region shading (behind everything).
  const shades = [];
  for (const segment of model.segments) {
    for (const [start, end] of segment.rejectedSpans) {
      const x0 = xPx(segment.xStart + start);
      const x1 = xPx(segment.xStart + end + 1);
      shades.push(
        `<rect x="${x0.toFixed(1)}" y="${margin.top}" width="${Math.max(0.5, x1 - x0).toFixed(1)}" height="${innerHeight}" class="tqc_diag_reject" />`,
      );
    }
  }
  layers.push(`<g class="tqc_diag_shading">${shades.join("")}</g>`);

  // Layer 2: acquisition segment boundaries (a divider before every segment
  // after the first).
  const boundaries = [];
  for (let index = 1; index < model.segments.length; index += 1) {
    const x = xPx(model.segments[index].xStart);
    boundaries.push(
      `<line x1="${x.toFixed(1)}" y1="${margin.top}" x2="${x.toFixed(1)}" y2="${margin.top + innerHeight}" class="tqc_diag_segment" />`,
    );
  }
  layers.push(`<g class="tqc_diag_segments">${boundaries.join("")}</g>`);

  // Layer 3: tracked peak polylines, one path per track, with hollow markers on
  // imputed (missing-and-filled) bins so a "perfectly stable" imputed stretch is
  // visibly distinct from real observations (SCI-09C).
  const trackMarkup = [];
  for (const segment of model.segments) {
    for (const track of segment.tracks) {
      if (!track.points.length) continue;
      const d = track.points
        .map((point, index) => `${index === 0 ? "M" : "L"}${xPx(point.x).toFixed(1)} ${yPx(point.value).toFixed(1)}`)
        .join(" ");
      trackMarkup.push(`<path d="${d}" fill="none" stroke="${track.color}" stroke-width="1.5" class="tqc_diag_track" />`);
      for (const point of track.points) {
        if (!point.imputed) continue;
        trackMarkup.push(
          `<circle cx="${xPx(point.x).toFixed(1)}" cy="${yPx(point.value).toFixed(1)}" r="2.4" fill="none" stroke="${track.color}" stroke-width="1" class="tqc_diag_imputed"><title>Imputed peak: ${escapeXml(point.missingReason || "peak not detected")}. Runs of 3 or more bins are rejected.</title></circle>`,
        );
      }
    }
  }
  layers.push(`<g class="tqc_diag_tracks">${trackMarkup.join("")}</g>`);

  // Axes: a simple L-frame plus a couple of value ticks and axis titles.
  const axis = [
    `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + innerHeight}" class="tqc_diag_axis" />`,
    `<line x1="${margin.left}" y1="${margin.top + innerHeight}" x2="${margin.left + innerWidth}" y2="${margin.top + innerHeight}" class="tqc_diag_axis" />`,
    `<text x="${margin.left - 6}" y="${(margin.top + 8).toFixed(1)}" text-anchor="end" class="tqc_diag_tick">${escapeXml(yMax.toFixed(0))}</text>`,
    `<text x="${margin.left - 6}" y="${(margin.top + innerHeight).toFixed(1)}" text-anchor="end" class="tqc_diag_tick">${escapeXml(yMin.toFixed(0))}</text>`,
    `<text x="${(margin.left + innerWidth / 2).toFixed(1)}" y="${height - 6}" text-anchor="middle" class="tqc_diag_title">acquisition order (bin)</text>`,
    `<text transform="translate(12 ${(margin.top + innerHeight / 2).toFixed(1)}) rotate(-90)" text-anchor="middle" class="tqc_diag_title">${escapeXml(model.activeChannel ?? "channel")} value</text>`,
  ];

  return (
    `<svg viewBox="0 0 ${width} ${height}" class="tqc_diag_svg" role="img" ` +
    `aria-label="Acquisition-order peak-tracking diagnostic for ${escapeXml(model.activeChannel ?? "the selected channel")}">` +
    layers.join("") +
    `<g class="tqc_diag_axes">${axis.join("")}</g>` +
    `</svg>`
  );
}
