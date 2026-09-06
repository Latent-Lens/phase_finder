// Peak region validation and region-local (fit-free) peak estimation. Exposes
// normalizePeakRegion (coerce/validate one region), validatePeakRegions (check
// the G1 and G2/M pair are individually well-formed and correctly ordered), and
// estimatePeakFromRegion (estimate a peak's center/width/area from the bins
// inside a region, no model fit, so it can drive a live drag preview). Small
// internal helpers do the binning and one-sided width search.
//
// Ported (with adaptation to PhaseFinder's existing gaussianSmooth utility)
// from the LatentLens cell-cycle-modeling-handoff archive's
// src/peakRegions.js. See docs/references/PEAK_REGION_HANDLES.md for the
// full semantics: the four G1/G2 region
// limits identify which visible peak is which -- they are not final
// cell-cycle phase gates, and the optimizer may move a fitted center inside
// its region but must never move the limits themselves.
//
// Copyright (c) 2026 LatentLens, under the repository's PolyForm
// Noncommercial License 1.0.0 (see LICENSE).
//
// Deliberately not ported here: estimatePeakFromRegion's fit-seeding
// siblings (applyPeakRegionsToInitialization, buildPeakMeanParameterization,
// peakRegionBoundaryWarnings, summarizePeakRegionMigration) constrain an
// actual model fit and are meaningless before a canonical model exists to
// consume them -- that lands with the Dean-Jett model.

import { gaussianSmooth } from "../math/gaussian.js";
import { clamp } from "../math/stats.js";

const EPS = 1e-12;

// MODEL-03: widths are measured on a histogram Gaussian-smoothed at
// `smoothingSigmaBins`, so every raw flank/second-moment estimate is
// sqrt(sigma^2 + kernel^2), never sigma itself. Remove the kernel in
// quadrature. A feature narrower than the kernel is unresolvable; floor it at
// half a bin rather than returning NaN, which would drop the caller to the
// much weaker second-moment (or region-span) fallback.
const UNRESOLVED_SIGMA_BINS = 0.5;

function deconvolveSmoothing(sigmaBins, smoothingSigmaBins) {
  if (!Number.isFinite(sigmaBins) || !(sigmaBins > 0)) return sigmaBins;
  const kernel = Math.max(0, smoothingSigmaBins);
  if (!(kernel > 0)) return sigmaBins;
  const variance = sigmaBins * sigmaBins - kernel * kernel;
  return variance > UNRESOLVED_SIGMA_BINS ** 2 ? Math.sqrt(variance) : UNRESOLVED_SIGMA_BINS;
}

function sum(values) {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function binCenters(edges) {
  const centers = new Array(edges.length - 1);
  for (let i = 0; i < centers.length; i += 1) centers[i] = 0.5 * (edges[i] + edges[i + 1]);
  return centers;
}

function finiteNumber(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be a finite number.`);
  return value;
}

/*

Purpose:
	Coerces and validates a single peak region into a normalized shape, defaulting
	its label and boundary meaning.

Input:
	region [object]: { left, right, label?, boundaryMeaning? }
	label [string]: fallback label used in errors and on the result

Output:
	region [object]: { left, right, label, boundaryMeaning } (throws when the
	                 region is missing, non-finite, or has left >= right)

*/
export function normalizePeakRegion(region, label = "peak") {
  if (!region || typeof region !== "object") {
    throw new TypeError(`${label} region is required.`);
  }
  const left = finiteNumber(region.left, `${label}.left`);
  const right = finiteNumber(region.right, `${label}.right`);
  if (!(left < right)) throw new RangeError(`${label} region must satisfy left < right.`);
  return {
    left,
    right,
    label: region.label ?? label,
    boundaryMeaning: region.boundaryMeaning ?? "peak-window",
  };
}

/*

Purpose:
	Validates the G1 and G2/M peak regions together: both individually
	well-formed (left < right) and correctly ordered / non-overlapping as a pair
	(L1 < R1 <= L2 < R2). The regions identify which visible peak is which; they
	are not final cell-cycle phase gates.

Input:
	peakRegions [object]: { g1, g2 } regions
	options [object]: optional { minimumGap } required between the regions

Output:
	regions [object]: { g1, g2 } normalized (throws when malformed or overlapping)

*/
export function validatePeakRegions(peakRegions, options = {}) {
  const g1 = normalizePeakRegion(peakRegions?.g1, "G1");
  const g2 = normalizePeakRegion(peakRegions?.g2, "G2/M");
  const minimumGap = options.minimumGap ?? 0;
  if (!(g1.right + minimumGap <= g2.left)) {
    throw new RangeError("G1 and G2/M peak regions must be ordered and non-overlapping.");
  }
  return { g1, g2 };
}

function regionIndexes(centers, region) {
  const indexes = [];
  for (let i = 0; i < centers.length; i += 1) {
    if (centers[i] >= region.left && centers[i] <= region.right) indexes.push(i);
  }
  if (!indexes.length) {
    throw new RangeError(`${region.label} region does not contain any histogram bin centers.`);
  }
  return indexes;
}

function estimateSigmaOneSidedWithinRegion(values, peakIndex, indexes, fraction, side, baseline = 0) {
  // MODEL-05: the flank threshold is a fraction of the peak height measured
  // FROM THE PEDESTAL the peak sits on, not from zero. Measuring from zero
  // makes `fraction * peak` an absolute count that a peak riding on debris or
  // on the S-phase bridge stays above further out, so sigma is overestimated
  // in proportion to the pedestal.
  //
  // `baseline` is supplied by the caller, which reads it at a PEAK-RELATIVE
  // distance rather than at the region edge -- see pedestalUnderPeak(). It is 0
  // whenever the region is too tight to show a pedestal at all, which keeps
  // this estimate independent of how generously the user drew the box.
  const floor = Number.isFinite(baseline) && baseline > 0 ? baseline : 0;
  const peak = values[peakIndex] - floor;
  if (!(peak > 0)) return NaN;
  const threshold = floor + peak * clamp(fraction, 0.05, 0.95);
  const first = indexes[0];
  const last = indexes[indexes.length - 1];
  let index = peakIndex;
  let previous = peakIndex;

  if (side === "left") {
    while (index > first && values[index] > threshold) {
      previous = index;
      index -= 1;
    }
  } else if (side === "right") {
    while (index < last && values[index] > threshold) {
      previous = index;
      index += 1;
    }
  } else {
    throw new Error("side must be 'left' or 'right'.");
  }

  // The threshold must be crossed before the selected region edge. Otherwise
  // the handle window did not expose enough of that shoulder for this method.
  if (values[index] > threshold) return NaN;

  // MODEL-03/checklist follow-up: linearly interpolate the fractional
  // crossing point between the last bin still above threshold (`previous`)
  // and the first bin at/under it (`index`), instead of rounding to the
  // discrete bin index. Snapping to the integer bin can only round the
  // crossing distance OUTWARD, never inward -- the walk stops the instant it
  // first drops to/under threshold -- which systematically overestimates
  // sigma. Measured on a 1200-bin synthetic two-peak fixture (bin width 0.25,
  // heightFraction 0.6): G1 sigma error +5.33% -> +2.96%, G2 sigma error
  // +0.82% -> +0.06% (docs/audits/cell_cycle_model_investigation_handoff.md).
  const vHigh = values[previous];
  const vLow = values[index];
  const denominator = vHigh - vLow;
  const frac = denominator > EPS ? clamp((vHigh - threshold) / denominator, 0, 1) : 0;
  const distanceBins = Math.abs(previous - peakIndex) + frac;
  return distanceBins > 0 ? distanceBins / Math.sqrt(-2 * Math.log(fraction)) : NaN;
}

// MODEL-05: the floor a peak sits on, read at a distance set by the PEAK, not
// by the region.
//
// The obvious estimate -- the value at the region edge -- is wrong, and wrong
// in a way this codebase already has a test for: a peak region is a statement
// about where the mean is and nothing else (see the region-width tests in
// unit_tests_cell_cycle_dean_jett_fox.py). A box drawn tightly around a peak
// has its edges partway down the peak's own flanks, so "the value at the edge"
// is peak, not pedestal, and subtracting it would make the fitted width depend
// on how carefully the user dragged the handle.
//
// So the floor is sampled at PEDESTAL_DISTANCE_SIGMAS out from the centre on
// the clean side -- far enough that a Gaussian has fallen to ~1% of its peak,
// so what remains there is essentially all pedestal. When the region does not
// reach that far, the region simply has not exposed a pedestal and this
// returns 0, leaving the un-subtracted behaviour in place. Both branches are
// functions of the peak's own width, so neither leaks the region width.
//
// sigmaBins comes from an un-subtracted first pass, so on a tall pedestal it is
// itself inflated -- which pushes the sample point further out, toward truer
// background. The bootstrap error is in the conservative direction.
const PEDESTAL_DISTANCE_SIGMAS = 3;
const PEDESTAL_WINDOW_BINS = 2;

function pedestalUnderPeak(values, peakIndex, indexes, sigmaBins, side) {
  if (!(sigmaBins > 0) || !Number.isFinite(sigmaBins)) return 0;
  const offset = Math.round(PEDESTAL_DISTANCE_SIGMAS * sigmaBins);
  const sampleIndex = side === "left" ? peakIndex - offset : peakIndex + offset;
  const first = indexes[0];
  const last = indexes[indexes.length - 1];
  if (sampleIndex < first || sampleIndex > last) return 0;

  // Average out bin noise over a couple of bins, still peak-relative.
  let floor = Infinity;
  const from = Math.max(first, sampleIndex - PEDESTAL_WINDOW_BINS);
  const to = Math.min(last, sampleIndex + PEDESTAL_WINDOW_BINS);
  for (let i = from; i <= to; i += 1) floor = Math.min(floor, values[i]);
  return Number.isFinite(floor) && floor > 0 ? floor : 0;
}

// MODEL-04: `mean: centers[peakIndex]` quantizes the peak centre to a bin
// centre. A three-point parabolic fit through the peak and its two neighbours
// recovers up to half a bin of sub-bin position -- but only when the offset
// leans toward the clean flank. Applied symmetrically it was measured to make
// G2 worse (docs/audits/cell_cycle_model_investigation_handoff.md): the
// parabola leans toward the taller neighbour, and for both G1 and G2 the
// taller neighbour is the S-phase side, so an unguarded correction pushes G2
// further into the bias it was meant to remove. The clean-side guard below
// accepts an offset only when it moves the centre away from the S bridge.
function parabolicPeakOffset(values, peakIndex, indexes) {
  const first = indexes[0];
  const last = indexes[indexes.length - 1];
  if (peakIndex <= first || peakIndex >= last) return 0;
  const yMinus = values[peakIndex - 1];
  const yZero = values[peakIndex];
  const yPlus = values[peakIndex + 1];
  const denominator = yMinus - 2 * yZero + yPlus;
  if (!(Math.abs(denominator) > EPS)) return 0; // flat or inflected
  const offset = 0.5 * (yMinus - yPlus) / denominator;
  return Math.abs(offset) <= 0.5 ? offset : 0; // reject non-interior vertex
}

function localLinearBaseline(values, indexes) {
  const first = indexes[0];
  const last = indexes[indexes.length - 1];
  const leftValue = values[first];
  const rightValue = values[last];
  const denominator = Math.max(1, last - first);
  return indexes.map((index) => {
    const t = (index - first) / denominator;
    return leftValue + t * (rightValue - leftValue);
  });
}

/*

Purpose:
	Estimates a peak's center, width, and rough area using only the bins inside a
	user-selected region -- no model fit -- so it can drive a live preview as the
	user drags a region handle. The handles themselves are never modified here.
	Falls back from a one-sided flank width to a baseline-subtracted second
	moment, and finally to the region span, when the cleaner estimate is unusable.

Input:
	edges [array]: histogram bin edges (length = binCount + 1)
	counts [array]: per-bin counts
	regionInput [object]: the peak region { left, right, ... }
	options [object]: optional { label, smoothed, smoothingSigmaBins, cleanSide,
	                  heightFraction (default 0.5; watson_pragmatic passes 0.6) }

Output:
	estimate [object]: { region, peakIndex, mean, sigma, cv, area, binIndexes,
	                    subBinOffset (MODEL-04: clean-side-guarded parabolic
	                    offset in bins already folded into `mean`) }

*/
export function estimatePeakFromRegion(edges, counts, regionInput, options = {}) {
  const region = normalizePeakRegion(regionInput, options.label ?? "peak");
  const centers = binCenters(edges);
  const binWidth = edges[1] - edges[0];
  const smoothingSigmaBins = options.smoothingSigmaBins ?? 2;
  // MODEL-03 guard: a caller-supplied pre-smoothed array must declare the
  // kernel it was smoothed with, or deconvolution below would silently
  // assume the default kernel and mis-correct the width. Every caller today
  // (watson_classic.js, dean_jett.js, watson_pragmatic.js) uses the default
  // smoothing computed here and never supplies options.smoothed.
  if (options.smoothed != null && !Number.isFinite(options.smoothingSigmaBins)) {
    throw new TypeError(
      "estimatePeakFromRegion: options.smoothed requires options.smoothingSigmaBins " +
        "naming the kernel it was smoothed with, so the width estimate deconvolves " +
        "the kernel that was actually applied instead of assuming the default.",
    );
  }
  const smoothed = options.smoothed ?? gaussianSmooth(counts, smoothingSigmaBins);
  const indexes = regionIndexes(centers, region);

  let peakIndex = indexes[0];
  for (const index of indexes) {
    if (smoothed[index] > smoothed[peakIndex]) peakIndex = index;
  }

  const cleanSide = options.cleanSide ?? "left";
  const heightFraction = options.heightFraction ?? 0.5;

  // MODEL-04: only accept a sub-bin offset that moves the centre AWAY from the
  // S-phase bridge -- see parabolicPeakOffset's comment above for why the
  // unguarded (symmetric) version regresses G2.
  const rawOffset = parabolicPeakOffset(smoothed, peakIndex, indexes);
  const towardCleanSide = cleanSide === "left" ? rawOffset <= 0 : rawOffset >= 0;
  const subBinOffset = towardCleanSide ? rawOffset : 0;

  // MODEL-05: two passes. The first is the un-subtracted walk, used only to get
  // a width with which to locate the pedestal; the second re-measures the flank
  // against that pedestal. On clean data pedestalUnderPeak() returns 0 and the
  // second pass reproduces the first exactly.
  const provisionalSigmaBins = estimateSigmaOneSidedWithinRegion(
    smoothed, peakIndex, indexes, heightFraction, cleanSide,
  );
  const pedestal = pedestalUnderPeak(smoothed, peakIndex, indexes, provisionalSigmaBins, cleanSide);
  const sigmaBins = pedestal > 0
    ? estimateSigmaOneSidedWithinRegion(smoothed, peakIndex, indexes, heightFraction, cleanSide, pedestal)
    : provisionalSigmaBins;
  // MODEL-03: deconvolve the smoothing kernel in quadrature (bin units) before
  // converting to data units -- the flank estimate above is measured on
  // `smoothed`, so it is sqrt(sigma^2 + smoothingSigmaBins^2), not sigma.
  let sigma = deconvolveSmoothing(sigmaBins, smoothingSigmaBins) * binWidth;

  // If the one-sided estimate is unusable, fall back to a baseline-subtracted
  // second moment inside the region. The region span is only the last resort.
  // This also runs on the same smoothed array, so it needs the same
  // deconvolution -- here in data units, since `variance` already is one.
  if (!(sigma > 0) || !Number.isFinite(sigma)) {
    const baseline = localLinearBaseline(smoothed, indexes);
    const weights = indexes.map((index, i) => Math.max(0, smoothed[index] - baseline[i]));
    const weightSum = sum(weights);
    if (weightSum > EPS) {
      const centroid = sum(indexes.map((index, i) => weights[i] * centers[index])) / weightSum;
      const variance = sum(indexes.map((index, i) => weights[i] * (centers[index] - centroid) ** 2)) / weightSum;
      const kernel = smoothingSigmaBins * binWidth;
      sigma = Math.sqrt(Math.max((UNRESOLVED_SIGMA_BINS * binWidth) ** 2, variance - kernel * kernel));
    }
  }

  if (!(sigma > 0) || !Number.isFinite(sigma)) {
    const divisor = region.boundaryMeaning === "fwhm" ? 2.354820045 : 4;
    sigma = Math.max(binWidth, (region.right - region.left) / divisor);
  }

  const edgeBaseline = Math.min(smoothed[indexes[0]], smoothed[indexes[indexes.length - 1]]);
  const height = Math.max(0, smoothed[peakIndex] - edgeBaseline);
  const area = Math.max(1, height * Math.sqrt(2 * Math.PI) * sigma / Math.max(EPS, binWidth));

  // MODEL-04: the reported mean is sub-bin-interpolated (see subBinOffset
  // above); cv keeps using the bin-quantized centre it always has, since the
  // checklist scopes this fix to the reported mean only and cv's own accuracy
  // was not part of the measured G1/G2 mean-error win being landed here.
  const mean = centers[peakIndex] + subBinOffset * binWidth;

  return {
    region,
    peakIndex,
    mean,
    sigma,
    cv: sigma / Math.max(EPS, centers[peakIndex]),
    area,
    binIndexes: indexes,
    subBinOffset,
  };
}
