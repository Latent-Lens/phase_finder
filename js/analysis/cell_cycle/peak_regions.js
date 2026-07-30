// Peak region validation and region-local (fit-free) peak estimation. Exposes
// normalizePeakRegion (coerce/validate one region), validatePeakRegions (check
// the G1 and G2/M pair are individually well-formed and correctly ordered), and
// estimatePeakFromRegion (estimate a peak's center/width/area from the bins
// inside a region, no model fit, so it can drive a live drag preview). Small
// internal helpers do the binning and one-sided width search.
//
// Ported (with adaptation to PhaseFinder's existing gaussianSmooth utility)
// from the MIT-licensed cell-cycle-modeling-handoff archive's
// src/peakRegions.js. See assets/misc/cell-cycle-modeling-handoff(2).zip and
// PEAK_REGION_HANDLES.md there for the full semantics: the four G1/G2 region
// limits identify which visible peak is which -- they are not final
// cell-cycle phase gates, and the optimizer may move a fitted center inside
// its region but must never move the limits themselves.
//
// MIT License, Copyright (c) 2026 -- see js/analysis/cell_cycle/peak_detection.js
// for the full license text (identical for this port).
//
// Deliberately not ported here: estimatePeakFromRegion's fit-seeding
// siblings (applyPeakRegionsToInitialization, buildPeakMeanParameterization,
// peakRegionBoundaryWarnings, summarizePeakRegionMigration) constrain an
// actual model fit and are meaningless before a canonical model exists to
// consume them -- that lands with the Dean-Jett model.

import { gaussianSmooth } from "../math/gaussian.js";
import { clamp } from "../math/stats.js";

const EPS = 1e-12;

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

function estimateSigmaOneSidedWithinRegion(values, peakIndex, indexes, fraction, side) {
  const peak = values[peakIndex];
  if (!(peak > 0)) return NaN;
  const threshold = peak * clamp(fraction, 0.05, 0.95);
  const first = indexes[0];
  const last = indexes[indexes.length - 1];
  let index = peakIndex;

  if (side === "left") {
    while (index > first && values[index] > threshold) index -= 1;
  } else if (side === "right") {
    while (index < last && values[index] > threshold) index += 1;
  } else {
    throw new Error("side must be 'left' or 'right'.");
  }

  // The threshold must be crossed before the selected region edge. Otherwise
  // the handle window did not expose enough of that shoulder for this method.
  if (values[index] > threshold) return NaN;
  const distanceBins = Math.abs(index - peakIndex);
  return distanceBins > 0 ? distanceBins / Math.sqrt(-2 * Math.log(fraction)) : NaN;
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
	estimate [object]: { region, peakIndex, mean, sigma, cv, area, binIndexes }

*/
export function estimatePeakFromRegion(edges, counts, regionInput, options = {}) {
  const region = normalizePeakRegion(regionInput, options.label ?? "peak");
  const centers = binCenters(edges);
  const binWidth = edges[1] - edges[0];
  const smoothed = options.smoothed ?? gaussianSmooth(counts, options.smoothingSigmaBins ?? 2);
  const indexes = regionIndexes(centers, region);

  let peakIndex = indexes[0];
  for (const index of indexes) {
    if (smoothed[index] > smoothed[peakIndex]) peakIndex = index;
  }

  const cleanSide = options.cleanSide ?? "left";
  const heightFraction = options.heightFraction ?? 0.5;
  const sigmaBins = estimateSigmaOneSidedWithinRegion(smoothed, peakIndex, indexes, heightFraction, cleanSide);
  let sigma = sigmaBins * binWidth;

  // If the one-sided estimate is unusable, fall back to a baseline-subtracted
  // second moment inside the region. The region span is only the last resort.
  if (!(sigma > 0) || !Number.isFinite(sigma)) {
    const baseline = localLinearBaseline(smoothed, indexes);
    const weights = indexes.map((index, i) => Math.max(0, smoothed[index] - baseline[i]));
    const weightSum = sum(weights);
    if (weightSum > EPS) {
      const centroid = sum(indexes.map((index, i) => weights[i] * centers[index])) / weightSum;
      const variance = sum(indexes.map((index, i) => weights[i] * (centers[index] - centroid) ** 2)) / weightSum;
      sigma = Math.sqrt(Math.max(EPS, variance));
    }
  }

  if (!(sigma > 0) || !Number.isFinite(sigma)) {
    const divisor = region.boundaryMeaning === "fwhm" ? 2.354820045 : 4;
    sigma = Math.max(binWidth, (region.right - region.left) / divisor);
  }

  const edgeBaseline = Math.min(smoothed[indexes[0]], smoothed[indexes[indexes.length - 1]]);
  const height = Math.max(0, smoothed[peakIndex] - edgeBaseline);
  const area = Math.max(1, height * Math.sqrt(2 * Math.PI) * sigma / Math.max(EPS, binWidth));

  return {
    region,
    peakIndex,
    mean: centers[peakIndex],
    sigma,
    cv: sigma / Math.max(EPS, centers[peakIndex]),
    area,
    binIndexes: indexes,
  };
}
