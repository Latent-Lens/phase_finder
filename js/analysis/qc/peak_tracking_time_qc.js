// Peak-tracking Time QC: the second Time QC method, alongside the existing
// robust-summary method in acquisition_time_qc.js.
//
// Where robust-summary QC watches per-bin medians, IQRs and event rate, this
// method follows the *positions of the major density peaks* in each selected
// channel across overlapping acquisition bins, and rejects the bins where those
// peaks move abnormally. That catches population shifts that barely move a
// median (a subpopulation appearing, a mode splitting) at the cost of being
// more sensitive to genuine biological drift -- hence the DNA-A/FSC-A/SSC-A
// default channel set and the warnings this module returns.
//
// Acquisition segmentation (timer unwrap + backward-jump splitting) is shared
// with the robust-summary method via prepareTimeQCBins, so both methods agree on
// what "acquisition order" means; only the binning and scoring differ.

import { mad, median } from "../math/stats.js";
import { prepareTimeQCBins, DEFAULT_TIMER_RANGE } from "./acquisition_time_qc.js";

export const PEAK_TRACKING_ALGORITHM_VERSION = "peak-tracking-v2";

// Channels whose distributions should stay stable through an acquisition.
// Deliberately small: every added fluorescence channel raises the chance of
// rejecting a real biological change as a technical artifact.
export const DEFAULT_PEAK_TRACKING_CHANNELS = Object.freeze(["DNA_A", "FSC_A", "SSC_A"]);

export const DEFAULT_PEAK_TRACKING_OPTIONS = Object.freeze({
  minimumEventsPerBin: 150,
  maximumBins: 500,
  binSizeRounding: 500,
  overlapFraction: 0.5,
  minimumRelativePeakHeight: 1 / 3,
  minimumPeakClusterPrevalence: 0.5,
  isolationTreeEnabled: true,
  isolationTreeMinimumBins: 150,
  isolationTreeGainThreshold: 0.6,
  isolationTreeMaximumDepth: null,
  madMultiplier: 6,
  minimumGoodRunBins: 5,
  removeZeroValues: false,
  includeEventRateCheck: true,
  eventRateZThreshold: 4,
});

// Density grid resolution. The KDE is evaluated by linear-binning the values
// onto this grid and convolving once with a Gaussian, rather than summing the
// kernel over every value at every grid point -- with hundreds of bins per
// sample and three channels each, the O(values x grid) form is far too slow to
// run on the main thread.
const DENSITY_GRID_SIZE = 256;
// Gaussian kernel truncation, in bandwidths. Beyond 4 sigma the kernel
// contributes < 0.01% of its mass.
const KERNEL_RADIUS_SIGMA = 4;
// A density estimate needs at least this many finite values to mean anything.
const MINIMUM_DENSITY_VALUES = 20;
// Fraction of a full bin below which a trailing remainder is merged into the
// previous bin instead of forming an undersized bin of its own.
const MINIMUM_FINAL_BIN_FRACTION = 0.5;
// Peaks closer together than this many density-grid intervals are merged: they
// are the same mode split by estimation noise.
const PEAK_MERGE_GRID_INTERVALS = 2;
// Floors on the robust scale used to score peak positions and event rates,
// as a fraction of the quantity's own median.
//
// Without them, a *perfectly* stable acquisition is the worst case rather than
// the best: the MAD collapses to (near) zero, and float32 rounding in the
// stored channel values — differences of 1 part in 10^6 — divides out into
// enormous z-scores and rejects half the run. A floor makes the question
// "did this move by a physically meaningful amount?" instead of "did this move
// at all?".
//
// 0.1% for peak positions is well below one density-grid interval (the grid
// spans the bin's data range in 256 steps), so it cannot mask a shift the
// density estimate could have resolved in the first place. 1% for event rates
// means a bin must be >4% off the median rate to be flagged, which a genuine
// clog or pressure change clears by an order of magnitude.
const MINIMUM_RELATIVE_PEAK_SPREAD = 1e-3;
const MINIMUM_RELATIVE_RATE_SPREAD = 1e-2;

// Every reason a bin can be rejected, for the per-bin reason sets and the UI
// summary breakdown.
export const REJECTION_REASONS = Object.freeze({
  ISOLATION_TREE: "isolation-tree outlier",
  MAD_PEAK: "MAD peak-position outlier",
  SHORT_RUN: "short surviving region",
  EVENT_RATE: "event-rate anomaly",
  PEAK_MISSING: "persistent peak missing",
});

// One isolated miss is warned/visualized but tolerated. Three consecutive
// missing bins are evidence of population disappearance and are rejected.
// Tracks missing from >50% of bins are invalidated by the existing prevalence
// rule instead of being treated as a persistent population.
const MISSING_TRACK_WARNING_FRACTION = 0.1;
const MISSING_TRACK_REJECT_RUN = 3;

function resolve_options(options) {
  return { ...DEFAULT_PEAK_TRACKING_OPTIONS, ...(options || {}) };
}

function standard_deviation(values) {
  const count = values.length;
  if (count < 2) return 0;
  let total = 0;
  for (const value of values) total += value;
  const average = total / count;
  let squares = 0;
  for (const value of values) squares += (value - average) ** 2;
  return Math.sqrt(squares / count);
}

/*

Purpose:
	Chooses how many events go in each acquisition bin: enough for a usable
	density estimate, but few enough that the whole acquisition still resolves
	into a useful number of bins.

Input:
	eventCount [number]: events in this acquisition segment
	options [object]: maximumBins, binSizeRounding, minimumEventsPerBin

Output:
	binSize [number]: events per bin

*/
export function chooseAdaptiveBinSize(eventCount, options = {}) {
  const resolved = resolve_options(options);
  const rounding = Math.max(1, resolved.binSizeRounding);
  // The factor of two accounts for the ~50% overlap: each event lands in about
  // two bins, so twice as many bin-slots are needed to cover the segment.
  const approximate = Math.ceil((2 * Math.max(0, eventCount)) / Math.max(1, resolved.maximumBins));
  const rounded = Math.ceil(approximate / rounding) * rounding;
  return Math.max(resolved.minimumEventsPerBin, rounded);
}

/*

Purpose:
	Slices one acquisition segment into overlapping, acquisition-ordered bins.
	Overlap means a shift is seen by more than one bin, so a rejected region is
	bounded conservatively rather than clipped to a bin edge.

Input:
	eventIndexes [array]: original event indexes, in acquisition order
	binSize [number]: events per bin
	overlapFraction [number]: 0-1 fraction of a bin shared with the next

Output:
	bins [array]: { startOffset, endOffset, indexes } in acquisition order

*/
export function createOverlappingBins(eventIndexes, binSize, overlapFraction = 0.5) {
  const length = eventIndexes?.length || 0;
  const size = Math.max(1, Math.floor(binSize));
  if (length === 0) return [];
  if (length <= size) {
    return [{ startOffset: 0, endOffset: length, indexes: Array.from(eventIndexes) }];
  }

  const clampedOverlap = Math.min(0.95, Math.max(0, overlapFraction));
  const step = Math.max(1, Math.round(size * (1 - clampedOverlap)));
  const minimumFinalSize = Math.max(1, Math.floor(size * MINIMUM_FINAL_BIN_FRACTION));
  const bins = [];

  for (let start = 0; start < length; start += step) {
    const end = Math.min(start + size, length);
    if (end - start < minimumFinalSize && bins.length) {
      // Too short to stand alone: extend the previous bin over the remainder so
      // no event is left unexamined.
      const previous = bins[bins.length - 1];
      previous.endOffset = length;
      previous.indexes = Array.from(eventIndexes).slice(previous.startOffset, length);
      break;
    }
    bins.push({
      startOffset: start,
      endOffset: end,
      indexes: Array.from(eventIndexes).slice(start, end),
    });
    if (end >= length) break;
  }

  return bins;
}

/*

Purpose:
	Estimates a channel's density over one bin's events, as the x/y curve the
	peak detector reads.

	Uses linear binning plus a single Gaussian convolution (the standard fast
	KDE): values are spread onto a fixed grid, then smoothed once. The bandwidth
	is Silverman's rule on a robust scale estimate -- min(sd, IQR/1.349) -- so a
	long tail or a second mode doesn't inflate it into over-smoothing.

Input:
	values [array]: channel values for the bin's events
	options [object]: removeZeroValues, gridSize

Output:
	density [object]: { x, y, bandwidth, validCount, valid }

*/
export function estimateChannelDensity(values, options = {}) {
  const resolved = resolve_options(options);
  const gridSize = Math.max(16, Math.floor(options.gridSize || DENSITY_GRID_SIZE));

  const finite = [];
  for (const value of values || []) {
    if (!Number.isFinite(value)) continue;
    if (resolved.removeZeroValues && value === 0) continue;
    finite.push(value);
  }

  if (finite.length < MINIMUM_DENSITY_VALUES) {
    return { x: [], y: [], bandwidth: NaN, validCount: finite.length, valid: false };
  }

  finite.sort((a, b) => a - b);
  const minimum = finite[0];
  const maximum = finite[finite.length - 1];
  if (!(maximum > minimum)) {
    // A constant channel in this bin has no resolvable peak structure.
    return { x: [], y: [], bandwidth: NaN, validCount: finite.length, valid: false };
  }

  const quantile = (probability) => {
    const position = (finite.length - 1) * probability;
    const lower = Math.floor(position);
    const upper = Math.min(finite.length - 1, lower + 1);
    return finite[lower] + (finite[upper] - finite[lower]) * (position - lower);
  };
  const spread = standard_deviation(finite);
  const iqr = quantile(0.75) - quantile(0.25);
  const robustScale = iqr > 0 ? Math.min(spread, iqr / 1.349) : spread;
  const scale = robustScale > 0 ? robustScale : spread;
  let bandwidth = 0.9 * scale * finite.length ** (-1 / 5);
  if (!(bandwidth > 0)) bandwidth = (maximum - minimum) / gridSize;

  // Pad the grid so kernel mass near the extremes isn't clipped.
  const pad = 3 * bandwidth;
  const low = minimum - pad;
  const high = maximum + pad;
  const interval = (high - low) / (gridSize - 1);

  // Linear binning: each value contributes to its two neighbouring grid points
  // in proportion to its distance from them.
  const weights = new Float64Array(gridSize);
  for (const value of finite) {
    const position = (value - low) / interval;
    const lower = Math.floor(position);
    const fraction = position - lower;
    if (lower >= 0 && lower < gridSize) weights[lower] += 1 - fraction;
    if (lower + 1 >= 0 && lower + 1 < gridSize) weights[lower + 1] += fraction;
  }

  // Gaussian convolution over the truncated kernel.
  const sigmaGrid = bandwidth / interval;
  const radius = Math.max(1, Math.ceil(KERNEL_RADIUS_SIGMA * sigmaGrid));
  const kernel = new Float64Array(2 * radius + 1);
  let kernelTotal = 0;
  for (let offset = -radius; offset <= radius; offset += 1) {
    const weight = Math.exp(-0.5 * (offset / sigmaGrid) ** 2);
    kernel[offset + radius] = weight;
    kernelTotal += weight;
  }

  const x = new Array(gridSize);
  const y = new Float64Array(gridSize);
  for (let index = 0; index < gridSize; index += 1) {
    x[index] = low + index * interval;
    let total = 0;
    const from = Math.max(0, index - radius);
    const to = Math.min(gridSize - 1, index + radius);
    for (let source = from; source <= to; source += 1) {
      total += weights[source] * kernel[source - index + radius];
    }
    y[index] = total / (kernelTotal * finite.length);
  }

  return { x, y: Array.from(y), bandwidth, validCount: finite.length, valid: true };
}

/*

Purpose:
	Finds the major modes of a density curve: local maxima tall enough relative
	to the curve's own tallest peak to be a real population rather than noise.

	When nothing clears the threshold the single tallest point is returned as a
	fallback, flagged as such -- a bin always contributes a position, but a
	channel that only ever produces fallbacks is reported and dropped upstream.

Input:
	densityCurve [object]: { x, y } from estimateChannelDensity
	relativeHeightThreshold [number]: fraction of the max height a peak must reach

Output:
	peaks [array]: { position, height, fallback } ordered by position

*/
export function detectMajorDensityPeaks(densityCurve, relativeHeightThreshold = 1 / 3) {
  const x = densityCurve?.x || [];
  const y = densityCurve?.y || [];
  if (x.length < 3) return [];

  let maximumDensity = 0;
  let maximumIndex = 0;
  for (let index = 0; index < y.length; index += 1) {
    if (y[index] > maximumDensity) {
      maximumDensity = y[index];
      maximumIndex = index;
    }
  }
  if (!(maximumDensity > 0)) return [];

  const minimumHeight = relativeHeightThreshold * maximumDensity;
  const peaks = [];
  for (let index = 1; index < y.length - 1; index += 1) {
    const isLocalMaximum = y[index] > y[index - 1] && y[index] >= y[index + 1];
    if (isLocalMaximum && y[index] >= minimumHeight) {
      peaks.push({ position: x[index], height: y[index], gridIndex: index, fallback: false });
    }
  }

  if (!peaks.length) {
    return [{ position: x[maximumIndex], height: maximumDensity, gridIndex: maximumIndex, fallback: true }];
  }

  // Merge peaks within a couple of grid intervals of each other: one mode split
  // by estimation noise, not two populations. The taller one wins.
  const merged = [];
  for (const peak of peaks) {
    const previous = merged[merged.length - 1];
    if (previous && peak.gridIndex - previous.gridIndex <= PEAK_MERGE_GRID_INTERVALS) {
      if (peak.height > previous.height) merged[merged.length - 1] = peak;
      continue;
    }
    merged.push(peak);
  }
  return merged;
}

/*

Purpose:
	Aligns the peaks detected independently in each bin into persistent tracks,
	so "peak 2 of DNA-A" means the same population in every bin. Bins legitimately
	differ in how many peaks they resolve, so tracks are seeded from the most
	common peak count, each bin's peaks are assigned to the nearest track, and
	tracks that only appear in a minority of bins are discarded as noise.

	Bins missing a retained track get that track's median position, marked
	imputed -- a missing peak must not read as a peak that moved.

Input:
	peaksByBin [array]: per-bin peak arrays from detectMajorDensityPeaks
	options [object]: minimumPeakClusterPrevalence

Output:
	tracks [array]: { positions, imputed, prevalence, referencePosition }

*/
export function buildPersistentPeakTracks(peaksByBin, options = {}, binEvidence = null) {
  const resolved = resolve_options(options);
  const binCount = peaksByBin.length;
  if (!binCount) return [];

  // Most frequently observed nonzero peak count decides how many tracks to seed.
  const countFrequency = new Map();
  for (const peaks of peaksByBin) {
    const count = peaks.length;
    if (!count) continue;
    countFrequency.set(count, (countFrequency.get(count) || 0) + 1);
  }
  if (!countFrequency.size) return [];

  let commonPeakCount = 0;
  let bestFrequency = -1;
  for (const [count, frequency] of countFrequency) {
    // Ties go to the smaller count: fewer, better-supported tracks.
    if (frequency > bestFrequency || (frequency === bestFrequency && count < commonPeakCount)) {
      bestFrequency = frequency;
      commonPeakCount = count;
    }
  }

  // Reference positions: the median of the k-th ordered peak across the bins
  // that resolved exactly commonPeakCount peaks.
  const referencePositions = [];
  for (let rank = 0; rank < commonPeakCount; rank += 1) {
    const positions = [];
    for (const peaks of peaksByBin) {
      if (peaks.length !== commonPeakCount) continue;
      positions.push(peaks[rank].position);
    }
    referencePositions.push(median(positions));
  }
  if (!referencePositions.every(Number.isFinite)) return [];

  // Assign every bin's peaks to their nearest reference; when two peaks claim
  // the same reference the closer one keeps it.
  const assigned = referencePositions.map(() => new Array(binCount).fill(NaN));
  for (let binIndex = 0; binIndex < binCount; binIndex += 1) {
    const claims = new Map();
    for (const peak of peaksByBin[binIndex]) {
      let nearest = 0;
      let nearestDistance = Infinity;
      referencePositions.forEach((reference, trackIndex) => {
        const distance = Math.abs(peak.position - reference);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = trackIndex;
        }
      });
      const existing = claims.get(nearest);
      if (!existing || nearestDistance < existing.distance) {
        claims.set(nearest, { position: peak.position, distance: nearestDistance });
      }
    }
    for (const [trackIndex, claim] of claims) assigned[trackIndex][binIndex] = claim.position;
  }

  const tracks = [];
  assigned.forEach((positions, trackIndex) => {
    const observed = positions.filter(Number.isFinite);
    const prevalence = observed.length / binCount;
    if (prevalence < resolved.minimumPeakClusterPrevalence) return;

    const trackMedian = median(observed);
    const imputed = positions.map((position) => !Number.isFinite(position));
    const missingReasons = imputed.map((missing, binIndex) =>
      missing ? (binEvidence?.[binIndex] ?? "peak-not-detected") : null);
    const filled = positions.map((position) => (Number.isFinite(position) ? position : trackMedian));
    tracks.push({
      referencePosition: referencePositions[trackIndex],
      trackMedian,
      prevalence,
      positions: filled,
      imputed,
      missingReasons,
    });
  });

  return tracks;
}

/*

Purpose:
	Builds the peak matrix: one row per acquisition bin, one column per retained
	peak track per selected channel. This is the matrix every later step scores.

Input:
	bins [array]: overlapping bins from createOverlappingBins
	channelValuesByName [object]: name -> full-length channel array
	selectedChannels [array]: channel names to track
	options [object]: peak-tracking options

Output:
	result [object]: { columns, metadata, channelWarnings, densityFailures }

*/
export function constructPeakMatrix(bins, channelValuesByName, selectedChannels, options = {}) {
  const resolved = resolve_options(options);
  const columns = [];
  const metadata = [];
  const channelWarnings = [];

  for (const channelName of selectedChannels) {
    const values = channelValuesByName?.[channelName];
    if (!values) {
      channelWarnings.push(`${channelName} is not loaded; it was excluded from peak tracking.`);
      continue;
    }

    const peaksByBin = [];
    const binEvidence = [];
    let invalidDensities = 0;
    let fallbackOnly = 0;
    for (const bin of bins) {
      const binValues = new Array(bin.indexes.length);
      for (let index = 0; index < bin.indexes.length; index += 1) {
        binValues[index] = values[bin.indexes[index]];
      }
      const density = estimateChannelDensity(binValues, resolved);
      if (!density.valid) {
        invalidDensities += 1;
        peaksByBin.push([]);
        binEvidence.push("density-estimate-failed");
        continue;
      }
      const peaks = detectMajorDensityPeaks(density, resolved.minimumRelativePeakHeight);
      if (peaks.length && peaks.every((peak) => peak.fallback)) fallbackOnly += 1;
      peaksByBin.push(peaks);
      binEvidence.push("peak-not-detected");
    }

    // A channel that mostly fails to produce real peaks carries no information
    // about acquisition stability -- tracking it would only add noise.
    const unusable = (invalidDensities + fallbackOnly) / Math.max(1, bins.length);
    if (unusable > 0.5) {
      channelWarnings.push(
        `${channelName} produced no reliable density peaks in ${Math.round(unusable * 100)}% of bins; it was excluded from peak tracking.`,
      );
      continue;
    }

    const tracks = buildPersistentPeakTracks(peaksByBin, resolved, binEvidence);
    if (!tracks.length) {
      channelWarnings.push(`${channelName} has no peak that persists across acquisition; it was excluded.`);
      continue;
    }

    tracks.forEach((track, trackIndex) => {
      columns.push(track.positions);
      metadata.push({
        channel: channelName,
        trackIndex,
        label: `${channelName} peak ${trackIndex + 1}`,
        prevalence: track.prevalence,
        trackMedian: track.trackMedian,
        imputed: track.imputed,
        missingReasons: track.missingReasons,
        missingFraction: track.imputed.filter(Boolean).length / Math.max(1, track.imputed.length),
        longestMissingRun: longest_true_run(track.imputed),
      });
    });
  }

  return { columns, metadata, channelWarnings };
}

function longest_true_run(flags) {
  let longest = 0;
  let current = 0;
  for (const flag of flags || []) {
    current = flag ? current + 1 : 0;
    if (current > longest) longest = current;
  }
  return longest;
}

export function detectMissingPeakEvidence(metadata, binCount) {
  const badBins = new Set();
  const warnings = [];
  for (const track of metadata || []) {
    const imputed = track.imputed || [];
    const missingCount = imputed.filter(Boolean).length;
    if (missingCount / Math.max(1, binCount) >= MISSING_TRACK_WARNING_FRACTION) {
      warnings.push(
        `${track.label} was missing in ${missingCount} of ${binCount} bins (longest run ${longest_true_run(imputed)}).`,
      );
    }
    let start = 0;
    while (start < imputed.length) {
      if (!imputed[start]) { start += 1; continue; }
      let end = start;
      while (end + 1 < imputed.length && imputed[end + 1]) end += 1;
      if (end - start + 1 >= MISSING_TRACK_REJECT_RUN) {
        for (let index = start; index <= end; index += 1) badBins.add(index);
      }
      start = end + 1;
    }
  }
  return { badBins, warnings };
}

/*

Purpose:
	Relative reduction in spread achieved by splitting a column's values into two
	groups -- the isolation tree's split criterion.

Input:
	values [array]: the column's values for the node's rows
	leftIndices [array]: positions (into values) on the left of the split
	rightIndices [array]: positions on the right

Output:
	gain [number]: 0-1, higher means a cleaner separation

*/
export function computeSplitGain(values, leftIndices, rightIndices) {
  const parentSpread = standard_deviation(Array.from(values));
  if (!(parentSpread > 0)) return 0;
  const left = leftIndices.map((index) => values[index]);
  const right = rightIndices.map((index) => values[index]);
  if (!left.length || !right.length) return 0;
  const childSpread = (standard_deviation(left) + standard_deviation(right)) / 2;
  return (parentSpread - childSpread) / parentSpread;
}

// Best split of one node over every column, found by sorting each column once
// and sweeping the thresholds while accumulating running sums -- the naive
// re-scan of both children at every candidate threshold is quadratic per column
// and this is run at every node of the tree.
function find_best_split(columns, rowIndices, gainThreshold) {
  let best = null;
  let bestGain = gainThreshold;

  for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
    const column = columns[columnIndex];
    const nodeValues = rowIndices.map((row) => column[row]);
    const count = nodeValues.length;
    if (count < 2) continue;

    const parentSpread = standard_deviation(nodeValues);
    if (!(parentSpread > 0)) continue;

    const order = nodeValues.map((value, index) => index).sort((a, b) => nodeValues[a] - nodeValues[b]);
    let leftSum = 0;
    let leftSquares = 0;
    let rightSum = 0;
    let rightSquares = 0;
    for (const value of nodeValues) {
      rightSum += value;
      rightSquares += value * value;
    }

    for (let position = 0; position < count - 1; position += 1) {
      const value = nodeValues[order[position]];
      leftSum += value;
      leftSquares += value * value;
      rightSum -= value;
      rightSquares -= value * value;

      const nextValue = nodeValues[order[position + 1]];
      if (nextValue === value) continue; // only split between distinct values

      const leftCount = position + 1;
      const rightCount = count - leftCount;
      const leftSpread = Math.sqrt(Math.max(0, leftSquares / leftCount - (leftSum / leftCount) ** 2));
      const rightSpread = Math.sqrt(Math.max(0, rightSquares / rightCount - (rightSum / rightCount) ** 2));
      const gain = (parentSpread - (leftSpread + rightSpread) / 2) / parentSpread;

      if (gain > bestGain) {
        const threshold = (value + nextValue) / 2;
        bestGain = gain;
        best = {
          columnIndex,
          threshold,
          gain,
          leftRows: rowIndices.filter((row) => column[row] <= threshold),
          rightRows: rowIndices.filter((row) => column[row] > threshold),
        };
      }
    }
  }

  return best;
}

/*

Purpose:
	Splits the bins into groups by their peak-position patterns and keeps the
	largest group as the stable acquisition. Deterministic (no random subsampling
	or random split points), so the same input always yields the same partition.

	This is the step that catches a broad, multi-channel disturbance: a clog or
	a pressure change moves several peaks at once, which separates cleanly from
	the bulk of the run.

Input:
	columns [array]: peak-matrix columns
	binCount [number]: number of acquisition bins
	options [object]: isolationTreeGainThreshold, isolationTreeMaximumDepth

Output:
	result [object]: { goodBinMask, splits, stableNodeSize }

*/
export function buildDeterministicIsolationTree(columns, binCount, options = {}) {
  const resolved = resolve_options(options);
  const allRows = Array.from({ length: binCount }, (_, index) => index);
  const goodBinMask = new Uint8Array(binCount);

  if (!columns.length || binCount === 0) {
    goodBinMask.fill(1);
    return { goodBinMask, splits: [], stableNodeSize: binCount };
  }

  const maximumDepth = Number.isFinite(resolved.isolationTreeMaximumDepth)
    ? resolved.isolationTreeMaximumDepth
    : Infinity;
  const queue = [{ rows: allRows, depth: 0 }];
  const terminalNodes = [];
  const splits = [];

  while (queue.length) {
    const node = queue.shift();
    if (node.depth >= maximumDepth || node.rows.length < 2) {
      terminalNodes.push(node);
      continue;
    }
    const split = find_best_split(columns, node.rows, resolved.isolationTreeGainThreshold);
    if (!split || !split.leftRows.length || !split.rightRows.length) {
      terminalNodes.push(node);
      continue;
    }
    splits.push({ columnIndex: split.columnIndex, threshold: split.threshold, gain: split.gain, depth: node.depth });
    queue.push({ rows: split.leftRows, depth: node.depth + 1 });
    queue.push({ rows: split.rightRows, depth: node.depth + 1 });
  }

  let stableNode = terminalNodes[0];
  for (const node of terminalNodes) {
    if (node.rows.length > stableNode.rows.length) stableNode = node;
  }
  for (const row of stableNode?.rows || allRows) goodBinMask[row] = 1;

  return { goodBinMask, splits, stableNodeSize: stableNode?.rows.length ?? binCount };
}

// Light smoothing of a peak track over acquisition order, so a single noisy bin
// doesn't trip the MAD limits on its own while a sustained shift still does.
// A centered moving average stands in for the spec's smoothing spline: the same
// role (suppress bin-to-bin noise, keep the trend) without a spline solver.
function smooth_series(values, windowRadius = 2) {
  const smoothed = new Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    let total = 0;
    let count = 0;
    for (let offset = -windowRadius; offset <= windowRadius; offset += 1) {
      const source = index + offset;
      if (source < 0 || source >= values.length) continue;
      if (!Number.isFinite(values[source])) continue;
      total += values[source];
      count += 1;
    }
    smoothed[index] = count ? total / count : NaN;
  }
  return smoothed;
}

/*

Purpose:
	Flags bins whose smoothed peak position sits outside a robust band around the
	track's center. Catches the subtler, slower shifts the isolation tree leaves
	behind (or everything, when there were too few bins to run the tree).

	A bin is rejected when ANY retained track puts it out of range.

Input:
	columns [array]: peak-matrix columns
	candidateGoodBins [Uint8Array]: bins still considered good
	options [object]: madMultiplier

Output:
	badBins [Set]: bin indexes to reject

*/
export function detectMADPeakOutliers(columns, candidateGoodBins, options = {}) {
  const resolved = resolve_options(options);
  const badBins = new Set();
  const binCount = candidateGoodBins.length;
  const candidateIndexes = [];
  for (let index = 0; index < binCount; index += 1) {
    if (candidateGoodBins[index] === 1) candidateIndexes.push(index);
  }
  if (candidateIndexes.length < 3) return badBins;

  for (const column of columns) {
    const restricted = candidateIndexes.map((index) => column[index]);
    const smoothed = smooth_series(restricted);
    const finite = smoothed.filter(Number.isFinite);
    const center = median(finite);
    if (!Number.isFinite(center)) continue;

    // A track that barely moves has a near-zero MAD, which would turn ordinary
    // rounding noise into a huge deviation -- see MINIMUM_RELATIVE_PEAK_SPREAD.
    const observed = mad(finite, center);
    const spread = Math.max(
      Number.isFinite(observed) ? observed : 0,
      Math.abs(center) * MINIMUM_RELATIVE_PEAK_SPREAD,
    );
    if (!(spread > 0)) continue; // a track pinned at exactly zero cannot shift

    const lower = center - resolved.madMultiplier * spread;
    const upper = center + resolved.madMultiplier * spread;
    candidateIndexes.forEach((binIndex, position) => {
      const value = smoothed[position];
      if (!Number.isFinite(value) || value < lower || value > upper) badBins.add(binIndex);
    });
  }

  return badBins;
}

/*

Purpose:
	Drops short islands of surviving bins inside a disturbed stretch -- a handful
	of good bins between two rejected regions is not a trustworthy piece of
	acquisition.

	Runs touching the very start or end of the acquisition are left alone: a
	genuinely short first or last region is normal, and removing it silently
	trims data the user never saw flagged.

Input:
	goodBinMask [Uint8Array]: current good/bad per bin
	minimumGoodRunBins [number]: shortest interior run to keep

Output:
	result [object]: { mask, removedBins }

*/
export function removeShortGoodRuns(goodBinMask, minimumGoodRunBins = 5) {
  const mask = Uint8Array.from(goodBinMask);
  const removedBins = [];
  const length = mask.length;
  if (!length || minimumGoodRunBins <= 1) return { mask, removedBins };

  let start = 0;
  while (start < length) {
    if (mask[start] !== 1) {
      start += 1;
      continue;
    }
    let end = start;
    while (end + 1 < length && mask[end + 1] === 1) end += 1;

    const runLength = end - start + 1;
    const touchesEdge = start === 0 || end === length - 1;
    if (runLength < minimumGoodRunBins && !touchesEdge) {
      for (let index = start; index <= end; index += 1) {
        mask[index] = 0;
        removedBins.push(index);
      }
    }
    start = end + 1;
  }

  return { mask, removedBins };
}

/*

Purpose:
	Supplementary event-rate check: peak tracking sees distribution shifts, but a
	pure rate disturbance (a partial clog that slows the stream without changing
	what is measured) leaves every peak where it was.

Input:
	bins [array]: overlapping bins
	unwrappedTime [Float64Array]: per-event acquisition time, rollover-corrected
	options [object]: eventRateZThreshold

Output:
	badBins [Set]: bin indexes whose rate is anomalous

*/
export function detectEventRateOutliers(bins, unwrappedTime, options = {}) {
  const resolved = resolve_options(options);
  const badBins = new Set();
  if (!unwrappedTime) return badBins;

  const rates = bins.map((bin) => {
    if (bin.indexes.length < 2) return NaN;
    const duration = unwrappedTime[bin.indexes[bin.indexes.length - 1]] - unwrappedTime[bin.indexes[0]];
    // (n-1)/duration: n timestamps span n-1 intervals (audit SCI-12).
    return duration > 0 ? (bin.indexes.length - 1) / duration : NaN;
  });
  const finiteRates = rates.filter(Number.isFinite);
  if (finiteRates.length < 3) return badBins;

  const center = median(finiteRates);
  const observed = mad(finiteRates, center);
  if (!Number.isFinite(center) || !(center > 0)) return badBins;

  // A steady acquisition clock gives an essentially constant rate, so the MAD
  // collapses and float rounding alone would score as an anomaly. Floor the
  // scale so a bin has to be materially off the median rate to be flagged --
  // see MINIMUM_RELATIVE_RATE_SPREAD.
  const robustScale = Math.max(
    1.4826 * (Number.isFinite(observed) ? observed : 0),
    center * MINIMUM_RELATIVE_RATE_SPREAD,
  );
  rates.forEach((rate, index) => {
    if (!Number.isFinite(rate)) return;
    if (Math.abs((rate - center) / robustScale) > resolved.eventRateZThreshold) badBins.add(index);
  });
  return badBins;
}

/*

Purpose:
	Expands rejected bins back to rejected events. Bins overlap, so an event can
	belong to several -- the rule is deliberately conservative: an event is
	rejected if ANY bin containing it was rejected.

Input:
	bins [array]: overlapping bins
	badBinMask [Uint8Array]: 1 where the bin is rejected
	eventCount [number]: total events in the sample

Output:
	badEventMask [Uint8Array]: 1 where the event is rejected

*/
export function convertBadBinsToBadEvents(bins, badBinMask, eventCount) {
  const badEventMask = new Uint8Array(eventCount);
  bins.forEach((bin, binIndex) => {
    if (badBinMask[binIndex] !== 1) return;
    for (const eventIndex of bin.indexes) badEventMask[eventIndex] = 1;
  });
  return badEventMask;
}

// Contiguous runs of rejected bins, reported as acquisition regions with the
// union of their reasons -- what the UI summary counts.
function merge_rejected_regions(bins, goodBinMask, reasonsByBin, segmentIndex) {
  const regions = [];
  for (let index = 0; index < goodBinMask.length; index += 1) {
    if (goodBinMask[index] === 1) continue;
    const previous = regions[regions.length - 1];
    if (previous && previous.lastBin === index - 1) {
      previous.lastBin = index;
      previous.lastEventIndex = bins[index].indexes[bins[index].indexes.length - 1];
      for (const reason of reasonsByBin[index]) previous.reasons.add(reason);
      continue;
    }
    regions.push({
      segmentIndex,
      firstBin: index,
      lastBin: index,
      firstEventIndex: bins[index].indexes[0],
      lastEventIndex: bins[index].indexes[bins[index].indexes.length - 1],
      reasons: new Set(reasonsByBin[index]),
    });
  }
  return regions.map((region) => ({ ...region, reasons: [...region.reasons] }));
}

/*

Purpose:
	Runs peak-tracking Time QC over a sample and returns the same result contract
	the pipeline's Time QC expects from the robust-summary method (mask,
	timeQCMask, retained/rejected counts, skipped/status), plus the
	peak-tracking-specific diagnostics: the peak matrix, per-bin rejection
	reasons, rejected acquisition regions, and warnings.

	Acquisition order is preserved throughout: events are never sorted by marker
	value, and a backward time jump starts a new segment that is analyzed on its
	own rather than being reordered into the previous one.

Input:
	dataset [object]: row.data — { channels, eventCount, pnr, masks }
	structuralMask [Uint8Array|null]: Structural QC's good-event mask
	options [object]: peak-tracking options, plus `channels` (names to track)

Output:
	result [object]: Time QC result with method "peak-tracking"

*/
export function runPeakTrackingTimeQC(dataset, structuralMask = null, options = {}) {
  const channels = dataset?.channels ?? dataset;
  const rawTime = channels?.Time;
  const resolved = resolve_options(options);
  const selectedChannels = (options?.channels && options.channels.length
    ? options.channels
    : DEFAULT_PEAK_TRACKING_CHANNELS
  ).filter((name) => channels?.[name]);

  if (!rawTime) {
    return {
      method: "peak-tracking",
      skipped: true,
      reason: "no Time channel",
      status: "time QC skipped",
      mask: null,
      timeQCMask: null,
      warnings: ["This sample has no Time channel, so Time QC was skipped."],
    };
  }

  const eventCount = dataset?.eventCount ?? rawTime.length;
  if (rawTime.length !== eventCount) {
    throw new Error("Time channel length does not match the event count.");
  }
  if (structuralMask && structuralMask.length !== eventCount) {
    throw new Error("Structural mask length does not match the event count.");
  }
  if (!selectedChannels.length) {
    return {
      method: "peak-tracking",
      skipped: true,
      reason: "no trackable channels",
      status: "time QC skipped",
      mask: null,
      timeQCMask: null,
      warnings: ["None of the selected peak-tracking channels are loaded, so Time QC was skipped."],
    };
  }

  const pnrRange = Number(dataset?.pnr?.Time);
  const timerRange = Number.isFinite(resolved.timerRange) && resolved.timerRange > 0
    ? resolved.timerRange
    : Number.isFinite(pnrRange) && pnrRange > 0
      ? pnrRange
      : DEFAULT_TIMER_RANGE;

  // Step 1 is shared with the robust-summary method: unwrap the timer, split
  // acquisition segments on unexplained backward jumps, and honour the
  // structural mask without breaking time continuity.
  const prepared = prepareTimeQCBins(rawTime, {
    timerRange,
    targetBinSize: resolved.minimumEventsPerBin,
    inputMask: structuralMask,
  });

  const indexesBySegment = new Map();
  for (let eventIndex = 0; eventIndex < eventCount; eventIndex += 1) {
    if (prepared.validTimeMask[eventIndex] !== 1) continue;
    const id = prepared.segmentId[eventIndex];
    if (id < 0) continue;
    if (!indexesBySegment.has(id)) indexesBySegment.set(id, []);
    indexesBySegment.get(id).push(eventIndex);
  }

  const warnings = [];
  const channelWarnings = new Set();
  const segmentResults = [];
  const badEventMask = new Uint8Array(eventCount);
  let totalBins = 0;
  let rejectedBins = 0;
  const reasonBinCounts = {
    [REJECTION_REASONS.ISOLATION_TREE]: 0,
    [REJECTION_REASONS.MAD_PEAK]: 0,
    [REJECTION_REASONS.SHORT_RUN]: 0,
    [REJECTION_REASONS.EVENT_RATE]: 0,
    [REJECTION_REASONS.PEAK_MISSING]: 0,
  };
  const rejectedRegions = [];

  for (const [segmentId, eventIndexes] of indexesBySegment) {
    if (eventIndexes.length < 2 * resolved.minimumEventsPerBin) {
      warnings.push(
        `Acquisition segment ${segmentId + 1} has ${eventIndexes.length.toLocaleString()} events — too few for reliable peak-tracking Time QC, so it was left unfiltered.`,
      );
      continue;
    }

    const binSize = chooseAdaptiveBinSize(eventIndexes.length, resolved);
    const bins = createOverlappingBins(eventIndexes, binSize, resolved.overlapFraction);
    if (bins.length < 3) {
      warnings.push(`Acquisition segment ${segmentId + 1} produced too few bins to score; it was left unfiltered.`);
      continue;
    }

    const matrix = constructPeakMatrix(bins, channels, selectedChannels, resolved);
    for (const warning of matrix.channelWarnings) channelWarnings.add(warning);
    if (!matrix.columns.length) {
      warnings.push(
        `No channel produced a peak that persists across acquisition segment ${segmentId + 1}; it was left unfiltered.`,
      );
      continue;
    }

    const reasonsByBin = bins.map(() => new Set());
    let goodBinMask = new Uint8Array(bins.length).fill(1);

    if (resolved.isolationTreeEnabled && bins.length >= resolved.isolationTreeMinimumBins) {
      const tree = buildDeterministicIsolationTree(matrix.columns, bins.length, resolved);
      for (let index = 0; index < bins.length; index += 1) {
        if (tree.goodBinMask[index] !== 1) reasonsByBin[index].add(REJECTION_REASONS.ISOLATION_TREE);
      }
      goodBinMask = tree.goodBinMask;
    } else if (resolved.isolationTreeEnabled) {
      warnings.push(
        `Acquisition segment ${segmentId + 1} has only ${bins.length} bins (fewer than ${resolved.isolationTreeMinimumBins}); isolation-tree filtering was skipped and MAD filtering was used alone.`,
      );
    }

    const missingEvidence = detectMissingPeakEvidence(matrix.metadata, bins.length);
    for (const warning of missingEvidence.warnings) {
      channelWarnings.add(`Acquisition segment ${segmentId + 1}: ${warning}`);
    }
    for (const binIndex of missingEvidence.badBins) {
      goodBinMask[binIndex] = 0;
      reasonsByBin[binIndex].add(REJECTION_REASONS.PEAK_MISSING);
    }

    for (const binIndex of detectMADPeakOutliers(matrix.columns, goodBinMask, resolved)) {
      goodBinMask[binIndex] = 0;
      reasonsByBin[binIndex].add(REJECTION_REASONS.MAD_PEAK);
    }

    if (resolved.includeEventRateCheck) {
      for (const binIndex of detectEventRateOutliers(bins, prepared.unwrappedTime, resolved)) {
        goodBinMask[binIndex] = 0;
        reasonsByBin[binIndex].add(REJECTION_REASONS.EVENT_RATE);
      }
    }

    const cleaned = removeShortGoodRuns(goodBinMask, resolved.minimumGoodRunBins);
    for (const binIndex of cleaned.removedBins) reasonsByBin[binIndex].add(REJECTION_REASONS.SHORT_RUN);
    goodBinMask = cleaned.mask;

    const badBinMask = new Uint8Array(bins.length);
    for (let index = 0; index < bins.length; index += 1) badBinMask[index] = goodBinMask[index] === 1 ? 0 : 1;
    const segmentBadEvents = convertBadBinsToBadEvents(bins, badBinMask, eventCount);
    for (let index = 0; index < eventCount; index += 1) {
      if (segmentBadEvents[index] === 1) badEventMask[index] = 1;
    }

    totalBins += bins.length;
    for (let index = 0; index < bins.length; index += 1) {
      if (badBinMask[index] !== 1) continue;
      rejectedBins += 1;
      for (const reason of reasonsByBin[index]) reasonBinCounts[reason] += 1;
    }
    rejectedRegions.push(...merge_rejected_regions(bins, goodBinMask, reasonsByBin, segmentId));

    segmentResults.push({
      segmentId,
      eventCount: eventIndexes.length,
      binSize,
      binCount: bins.length,
      goodBinMask,
      peakColumns: matrix.columns,
      peakMetadata: matrix.metadata,
      rejectionReasons: reasonsByBin.map((reasons) => [...reasons]),
    });
  }

  for (const warning of channelWarnings) warnings.push(warning);

  // Structurally valid events that peak tracking rejected, and the surviving
  // mask the rest of the pipeline consumes.
  const timeQCMask = new Uint8Array(eventCount);
  let evaluatedEventCount = 0;
  let retainedEventCount = 0;
  for (let index = 0; index < eventCount; index += 1) {
    const enteredWindow =
      (!structuralMask || structuralMask[index] === 1) && prepared.validTimeMask[index] === 1;
    if (enteredWindow) evaluatedEventCount += 1;
    const retained = enteredWindow && badEventMask[index] !== 1;
    timeQCMask[index] = retained ? 1 : 0;
    if (retained) retainedEventCount += 1;
  }
  const rejectedEventCount = evaluatedEventCount - retainedEventCount;
  const percentRemoved = evaluatedEventCount > 0 ? (100 * rejectedEventCount) / evaluatedEventCount : 0;

  if (percentRemoved > 50) {
    warnings.push(
      `Peak-tracking Time QC removed ${percentRemoved.toFixed(1)}% of the evaluated events. Review this before continuing to modeling — a selected channel may be changing for biological reasons.`,
    );
  } else if (percentRemoved > 20) {
    warnings.push(
      `Peak-tracking Time QC removed an unusually large fraction of events (${percentRemoved.toFixed(1)}%). Review the affected acquisition regions.`,
    );
  }
  if (selectedChannels.length > DEFAULT_PEAK_TRACKING_CHANNELS.length) {
    warnings.push(
      "A selected channel may change for biological reasons. Peak-tracking QC treats major acquisition-ordered shifts as potential technical artifacts.",
    );
  }

  // QC-04: report requested vs available channels rather than silently dropping a
  // requested channel that wasn't loaded.
  const requestedChannels = (options?.channels && options.channels.length
    ? options.channels
    : DEFAULT_PEAK_TRACKING_CHANNELS).map(String);
  const availableChannels = selectedChannels.map(String);
  const missingChannels = requestedChannels.filter((name) => !availableChannels.includes(name));
  if (missingChannels.length) {
    warnings.push(
      `Requested peak-tracking channel${missingChannels.length === 1 ? "" : "s"} not loaded: ${missingChannels.join(", ")}. ` +
        `Tracking ran on ${availableChannels.join(", ")} only.`,
    );
  }

  // QC-04 coverage + reliability, consistent with QC-03. A run where NO acquisition
  // segment could be scored (too few events, too few bins, or no persistent peak)
  // is NOT a confident pass -- it is not evaluable, and no events are removed.
  // Partial coverage (some segments left unfiltered), a missing requested channel,
  // or critical removal qualify the run as limited reliability, which the model
  // boundary (QC-01) maps to a "degraded" outcome.
  const totalSegmentCount = indexesBySegment.size;
  const evaluatedSegmentCount = segmentResults.length;
  const notEvaluable = evaluatedSegmentCount === 0;
  const limitedReliability = notEvaluable
    || missingChannels.length > 0
    || evaluatedSegmentCount < totalSegmentCount
    || percentRemoved > 50;

  return {
    ...prepared,
    method: "peak-tracking",
    algorithmVersion: PEAK_TRACKING_ALGORITHM_VERSION,
    skipped: false,
    status: notEvaluable ? "time QC not evaluable" : "time QC complete",
    reason: notEvaluable
      ? "No acquisition segment could be scored (too few events, too few bins, or no persistent peak); no events were removed."
      : null,
    rawTime,
    requestedChannels,
    availableChannels,
    missingChannels,
    selectedChannels,
    optionsUsed: resolved,
    segmentResults,
    rejectedRegions,
    reasonBinCounts,
    binCount: totalBins,
    rejectedBinCount: rejectedBins,
    segmentCount: totalSegmentCount,
    evaluatedSegmentCount,
    notEvaluable,
    limitedReliability,
    timeQCMask,
    mask: timeQCMask,
    badEventMask,
    evaluatedEventCount,
    retainedEventCount,
    rejectedEventCount,
    percentRemoved,
    warnings,
  };
}
