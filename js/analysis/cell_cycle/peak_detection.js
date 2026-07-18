// Multi-scale G1/G2 peak-pair detection and automatic region proposal.
//
// Ported (with adaptation to PhaseFinder's existing gaussianSmooth/clamp/
// median utilities and its Stage-4 histogram shape) from the MIT-licensed
// cell-cycle-modeling-handoff archive's src/peakDetection.js and
// src/histogram.js findLocalMaxima/gaussianKernel. See
// assets/misc/cell-cycle-modeling-handoff(2).zip and
// AUTOMATIC_PEAK_DETECTION.md there for the full mathematical writeup this
// implements: multi-scale Gaussian smoothing at [1, 2, 4] bins, prominence +
// half-prominence width + area evidence per scale, persistence/location
// stability clustering across scales, one-bin-impulse downweighting via
// deconvolved intrinsic width, and weighted G1/G2 pair scoring (ratio,
// prominence, area, width/CV compatibility, persistence, separation,
// S-bridge evidence, edge support) with detected/low_confidence/inferred_g2
// status and up to four ranked alternatives.
//
// MIT License
// Copyright (c) 2026
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, subject to
// including the above copyright notice and this permission notice in all
// copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED
// "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
//
// Confidence and pair scores are heuristic evidence in [0, 1], not
// calibrated probabilities that a labeling is biologically correct (see
// AUTOMATIC_PEAK_DETECTION.md §10, §13 "Failure boundaries").

import { gaussianSmooth } from "../math/gaussian.js";
import { clamp, median } from "../math/stats.js";

export const DEFAULT_CELL_CYCLE_PAIR_WEIGHTS = Object.freeze({
  ratio: 0.28,
  prominence: 0.14,
  area: 0.09,
  width: 0.09,
  persistence: 0.14,
  separation: 0.08,
  bridge: 0.12,
  edge: 0.06,
});

function assertHistogram(edges, counts) {
  if (!Array.isArray(edges) && !ArrayBuffer.isView(edges)) {
    throw new TypeError("edges must be an array or typed array.");
  }
  if (!Array.isArray(counts) && !ArrayBuffer.isView(counts)) {
    throw new TypeError("counts must be an array or typed array.");
  }
  if (edges.length !== counts.length + 1 || counts.length < 8) {
    throw new Error("edges must have exactly one more entry than counts, with at least 8 bins.");
  }
  for (let i = 0; i < edges.length; i += 1) {
    if (!Number.isFinite(edges[i])) throw new Error("All histogram edges must be finite.");
    if (i > 0 && !(edges[i] > edges[i - 1])) throw new Error("Histogram edges must be strictly increasing.");
  }
  for (const value of counts) {
    if (!Number.isFinite(value) || value < 0) throw new Error("Histogram counts must be finite and nonnegative.");
  }
}

function binCenters(edges) {
  const centers = new Array(edges.length - 1);
  for (let i = 0; i < centers.length; i += 1) centers[i] = 0.5 * (edges[i] + edges[i + 1]);
  return centers;
}

function medianBinWidth(edges) {
  const widths = [];
  for (let i = 0; i < edges.length - 1; i += 1) widths.push(edges[i + 1] - edges[i]);
  return median(widths);
}

function sum(values) {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function argMin(values, start, end) {
  let index = Math.max(0, start);
  let value = values[index];
  for (let i = index + 1; i <= Math.min(values.length - 1, end); i += 1) {
    if (values[i] < value) {
      value = values[i];
      index = i;
    }
  }
  return { index, value };
}

function interpolateLevelCrossing(values, insideIndex, outsideIndex, level) {
  const insideValue = values[insideIndex];
  const outsideValue = values[outsideIndex];
  const denominator = insideValue - outsideValue;
  if (Math.abs(denominator) < 1e-12) return 0.5 * (insideIndex + outsideIndex);
  const fractionFromOutside = clamp((level - outsideValue) / denominator, 0, 1);
  return outsideIndex + fractionFromOutside * (insideIndex - outsideIndex);
}

function crossingLeft(values, peakIndex, level) {
  let inside = peakIndex;
  while (inside > 0 && values[inside] > level) inside -= 1;
  if (inside === 0 && values[inside] > level) return 0;
  return interpolateLevelCrossing(values, inside + 1, inside, level);
}

function crossingRight(values, peakIndex, level) {
  let outside = peakIndex;
  while (outside < values.length - 1 && values[outside] > level) outside += 1;
  if (outside === values.length - 1 && values[outside] > level) return values.length - 1;
  return interpolateLevelCrossing(values, outside - 1, outside, level);
}

/**
 * Measure one local maximum on one smoothed scale. Width is measured at half
 * prominence, not half absolute height, so a nonzero S-phase/background level
 * does not inflate the width as severely.
 */
function measurePeak(values, peak, options = {}) {
  const window = Math.max(3, Math.floor(options.prominenceWindow ?? 24));
  const left = argMin(values, peak.index - window, peak.index - 1);
  const right = argMin(values, peak.index + 1, peak.index + window);
  const baseline = Math.max(left.value, right.value);
  const prominence = Math.max(0, values[peak.index] - baseline);
  const relativeHeight = clamp(options.widthRelativeHeight ?? 0.5, 0.05, 0.95);
  const widthLevel = values[peak.index] - relativeHeight * prominence;
  const leftCrossing = crossingLeft(values, peak.index, widthLevel);
  const rightCrossing = crossingRight(values, peak.index, widthLevel);
  const widthBins = Math.max(0.5, rightCrossing - leftCrossing);
  const sigmaBins = widthBins / (2 * Math.sqrt(2 * Math.log(1 / Math.max(1e-6, 1 - relativeHeight))));

  let areaAboveBaseline = 0;
  for (let i = left.index; i <= right.index; i += 1) {
    areaAboveBaseline += Math.max(0, values[i] - baseline);
  }

  const halfProminenceSigmaFactor = Math.sqrt(2 * Math.log(2));
  const sigmaLeftBins = Math.max(0.5, (peak.index - leftCrossing) / halfProminenceSigmaFactor);
  const sigmaRightBins = Math.max(0.5, (rightCrossing - peak.index) / halfProminenceSigmaFactor);

  return {
    ...peak,
    prominence,
    baseline,
    leftBaseIndex: left.index,
    rightBaseIndex: right.index,
    leftCrossing,
    rightCrossing,
    widthBins,
    sigmaBins,
    sigmaLeftBins,
    sigmaRightBins,
    areaAboveBaseline,
  };
}

function uniqueSortedScales(scales) {
  return [...new Set(scales
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0))]
    .sort((a, b) => a - b);
}

function robustNoiseFloor(counts) {
  if (counts.length < 2) return 1;
  const differences = [];
  for (let i = 1; i < counts.length; i += 1) differences.push(Math.abs(counts[i] - counts[i - 1]));
  return Math.max(1, median(differences) / 0.954); // approximate sigma from |N(0,2 sigma^2)| median
}

function localMinimum(values, start, end) {
  let minimum = Infinity;
  for (let i = Math.max(0, start); i <= Math.min(values.length - 1, end); i += 1) minimum = Math.min(minimum, values[i]);
  return minimum;
}

function findLocalMaxima(values, options = {}) {
  const minHeight = options.minHeight ?? 0;
  const minDistance = Math.max(1, Math.floor(options.minDistance ?? 3));
  const prominenceWindow = Math.max(2, Math.floor(options.prominenceWindow ?? 12));
  const minProminence = options.minProminence ?? 0;
  const candidates = [];

  for (let i = 1; i < values.length - 1; i += 1) {
    if (values[i] < minHeight) continue;
    if (values[i] < values[i - 1] || values[i] < values[i + 1]) continue;
    const leftMin = localMinimum(values, i - prominenceWindow, i - 1);
    const rightMin = localMinimum(values, i + 1, i + prominenceWindow);
    const prominence = values[i] - Math.max(leftMin, rightMin);
    if (prominence < minProminence) continue;
    candidates.push({ index: i, height: values[i], prominence });
  }

  candidates.sort((a, b) => b.prominence - a.prominence || b.height - a.height);
  const selected = [];
  for (const candidate of candidates) {
    if (selected.every((peak) => Math.abs(peak.index - candidate.index) >= minDistance)) selected.push(candidate);
  }
  return selected.sort((a, b) => a.index - b.index);
}

function detectAtScale(counts, scale, options = {}) {
  const smoothed = gaussianSmooth(counts, scale);
  const maximum = Math.max(...smoothed, 0);
  const noise = robustNoiseFloor(counts);
  const prominenceWindow = options.prominenceWindow
    ?? Math.max(10, Math.floor(counts.length * 0.10));
  const minDistance = options.minPeakDistanceBins
    ?? Math.max(2, Math.floor(counts.length * 0.015), Math.ceil(1.5 * scale));
  const looseCandidates = findLocalMaxima(smoothed, {
    minHeight: options.minHeight ?? Math.max(1, 0.004 * maximum),
    minProminence: 0,
    minDistance,
    prominenceWindow,
  });

  const minProminenceFraction = options.minProminenceFraction ?? 0.004;
  const noiseMultiplier = options.prominenceNoiseMultiplier ?? 2.5;
  const peaks = looseCandidates
    .map((peak) => measurePeak(smoothed, peak, { ...options, prominenceWindow }))
    .filter((peak) => {
      const poissonFloor = noiseMultiplier * Math.max(noise, Math.sqrt(Math.max(1, peak.height)));
      const required = options.minProminence
        ?? Math.max(minProminenceFraction * maximum, poissonFloor);
      return peak.prominence >= required;
    })
    .map((peak) => ({ ...peak, scale }));

  return { scale, smoothed, peaks, maximum, noise };
}

function clusterScalePeaks(scaleResults, options = {}) {
  const maxScale = Math.max(...scaleResults.map((result) => result.scale));
  const toleranceBins = options.scaleMatchToleranceBins ?? Math.max(2, Math.ceil(1.5 * maxScale));
  const observations = scaleResults
    .flatMap((result) => result.peaks)
    .sort((a, b) => b.prominence - a.prominence || b.height - a.height);
  const clusters = [];

  for (const observation of observations) {
    let bestCluster = null;
    let bestDistance = Infinity;
    for (const cluster of clusters) {
      if (cluster.byScale.has(observation.scale)) continue;
      const distance = Math.abs(cluster.centerIndex - observation.index);
      if (distance <= toleranceBins && distance < bestDistance) {
        bestCluster = cluster;
        bestDistance = distance;
      }
    }
    if (!bestCluster) {
      bestCluster = { observations: [], byScale: new Map(), centerIndex: observation.index };
      clusters.push(bestCluster);
    }
    bestCluster.observations.push(observation);
    bestCluster.byScale.set(observation.scale, observation);
    let weightedIndex = 0;
    let totalWeight = 0;
    for (const item of bestCluster.observations) {
      const weight = Math.max(1e-6, item.prominence);
      weightedIndex += item.index * weight;
      totalWeight += weight;
    }
    bestCluster.centerIndex = weightedIndex / totalWeight;
  }

  return { clusters, toleranceBins };
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const m = values.reduce((acc, value) => acc + value, 0) / values.length;
  const variance = values.reduce((acc, value) => acc + (value - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function finalizeCandidates(scaleResults, centers, options = {}) {
  const scales = scaleResults.map((result) => result.scale);
  const primaryScale = options.primaryScale
    ?? scales.reduce((best, value) => Math.abs(value - 2) < Math.abs(best - 2) ? value : best, scales[0]);
  const { clusters, toleranceBins } = clusterScalePeaks(scaleResults, options);
  const primaryResult = scaleResults.find((result) => result.scale === primaryScale) ?? scaleResults[0];

  const candidates = clusters.map((cluster, clusterIndex) => {
    const representative = cluster.byScale.get(primaryScale)
      ?? [...cluster.observations].sort((a, b) => b.prominence - a.prominence)[0];
    const uniqueScaleCount = cluster.byScale.size;
    const indexSpread = standardDeviation(cluster.observations.map((item) => item.index));
    const stability = Math.exp(-0.5 * (indexSpread / Math.max(1, toleranceBins)) ** 2);
    const persistence = uniqueScaleCount / scales.length;
    const intrinsicSigmas = cluster.observations.map((item) =>
      Math.sqrt(Math.max(0, item.sigmaBins ** 2 - item.scale ** 2)));
    const intrinsicSigmaBins = median(intrinsicSigmas);
    const intrinsicWidthStability = Math.exp(
      -0.5 * (standardDeviation(intrinsicSigmas) / Math.max(0.5, intrinsicSigmaBins)) ** 2,
    );
    // A one-bin impulse becomes wider exactly with the smoothing kernel and
    // therefore has near-zero deconvolved width. Real cytometry peaks retain
    // a nonzero intrinsic width across scales.
    const impulseSupport = 1 - Math.exp(-intrinsicSigmaBins / (options.impulseWidthScaleBins ?? 1.0));
    const index = clamp(Math.round(cluster.centerIndex), 0, centers.length - 1);

    return {
      id: `peak-${clusterIndex + 1}`,
      ...representative,
      index,
      x: centers[index],
      persistence,
      stability,
      intrinsicSigmaBins,
      intrinsicWidthStability,
      impulseSupport,
      scaleHits: [...cluster.byScale.keys()].sort((a, b) => a - b),
      indexSpread,
      observations: cluster.observations.map((item) => ({
        scale: item.scale,
        index: item.index,
        height: item.height,
        prominence: item.prominence,
        widthBins: item.widthBins,
      })),
    };
  }).sort((a, b) => a.index - b.index);

  const maxProminence = Math.max(...candidates.map((peak) => peak.prominence), 1);
  const maxArea = Math.max(...candidates.map((peak) => peak.areaAboveBaseline), 1);
  const maxHeight = Math.max(...candidates.map((peak) => peak.height), 1);
  for (const peak of candidates) {
    peak.prominenceScore = Math.log1p(peak.prominence) / Math.log1p(maxProminence);
    peak.areaScore = Math.log1p(peak.areaAboveBaseline) / Math.log1p(maxArea);
    peak.heightScore = Math.log1p(peak.height) / Math.log1p(maxHeight);
    const baseQuality = clamp(
      0.30 * peak.prominenceScore
      + 0.17 * peak.areaScore
      + 0.08 * peak.heightScore
      + 0.20 * peak.persistence
      + 0.10 * peak.stability
      + 0.15 * peak.intrinsicWidthStability,
      0,
      1,
    );
    peak.quality = baseQuality * (0.20 + 0.80 * peak.impulseSupport);
  }

  return { candidates, primaryScale, primarySmoothed: primaryResult.smoothed, scaleResults };
}

function normalizedWeights(weights) {
  const merged = { ...DEFAULT_CELL_CYCLE_PAIR_WEIGHTS, ...(weights ?? {}) };
  const total = Object.values(merged).reduce((acc, value) => acc + Math.max(0, value), 0);
  if (!(total > 0)) return { ...DEFAULT_CELL_CYCLE_PAIR_WEIGHTS };
  return Object.fromEntries(Object.entries(merged).map(([key, value]) => [key, Math.max(0, value) / total]));
}

function geometricMean(a, b) {
  return Math.sqrt(Math.max(0, a) * Math.max(0, b));
}

function bridgeEvidence(smoothed, left, right, total) {
  const start = Math.max(left.index + 1, Math.ceil(left.rightCrossing));
  const end = Math.min(right.index - 1, Math.floor(right.leftCrossing));
  if (end < start) return { score: 0, massFraction: 0, continuity: 0, bins: 0 };

  let bridgeMass = 0;
  let active = 0;
  const maximum = Math.max(...smoothed, 1);
  const activityThreshold = Math.max(0.002 * maximum, 0.05 * Math.min(left.prominence, right.prominence));
  for (let i = start; i <= end; i += 1) {
    bridgeMass += Math.max(0, smoothed[i]);
    if (smoothed[i] >= activityThreshold) active += 1;
  }
  const bins = end - start + 1;
  const massFraction = bridgeMass / Math.max(1, total);
  const continuity = active / bins;
  const massScore = 1 - Math.exp(-massFraction / 0.008);
  const score = Math.sqrt(clamp(massScore, 0, 1) * clamp(continuity, 0, 1));
  return { score, massFraction, continuity, bins };
}

function edgeEvidence(candidate, countLength) {
  const leftDistance = candidate.index;
  const rightDistance = countLength - 1 - candidate.index;
  const characteristicWidth = Math.max(1, candidate.widthBins);
  return clamp(Math.min(leftDistance, rightDistance) / (2.5 * characteristicWidth), 0, 1);
}

function pairSoftmaxProbability(pairs, temperature = 0.08) {
  if (!pairs.length) return 0;
  const maxScore = pairs[0].score;
  const exponentials = pairs.map((pair) => Math.exp((pair.score - maxScore) / Math.max(1e-6, temperature)));
  return exponentials[0] / Math.max(1e-12, exponentials.reduce((acc, value) => acc + value, 0));
}

/**
 * Score every biologically plausible ordered G1/G2 pair. Scores are heuristic
 * evidence scores in [0,1], not calibrated posterior probabilities.
 */
export function scoreCellCyclePeakPairs({
  edges,
  counts,
  candidates,
  smoothed,
}, options = {}) {
  assertHistogram(edges, counts);
  const centers = binCenters(edges);
  const binWidth = medianBinWidth(edges);
  const total = sum(counts);
  const expectedRatio = options.expectedRatio ?? 2;
  const ratioRange = options.ratioRange ?? [1.60, 2.35];
  const ratioLogTolerance = options.ratioLogTolerance ?? 0.12;
  const widthLogTolerance = options.widthLogTolerance ?? 0.55;
  const weights = normalizedWeights(options.pairWeights);
  const pairs = [];

  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const g1 = candidates[i];
      const g2 = candidates[j];
      if (!(g1.x > 0) || !(g2.x > g1.x)) continue;
      const ratio = g2.x / g1.x;
      if (ratio < ratioRange[0] || ratio > ratioRange[1]) continue;

      const ratioScore = Math.exp(-0.5 * (Math.log(ratio / expectedRatio) / ratioLogTolerance) ** 2);
      const prominenceScore = geometricMean(g1.prominenceScore, g2.prominenceScore);
      const areaScore = geometricMean(g1.areaScore, g2.areaScore);
      const persistenceScore = geometricMean(
        g1.persistence * g1.stability * g1.intrinsicWidthStability * g1.impulseSupport,
        g2.persistence * g2.stability * g2.intrinsicWidthStability * g2.impulseSupport,
      );

      const g1CV = Math.max(1e-6, g1.sigmaBins * binWidth / g1.x);
      const g2CV = Math.max(1e-6, g2.sigmaBins * binWidth / g2.x);
      const widthScore = Math.exp(-0.5 * (Math.log(g2CV / g1CV) / widthLogTolerance) ** 2);

      const centerDistance = g2.index - g1.index;
      const halfWidthSum = 0.5 * (g1.widthBins + g2.widthBins);
      const separationScore = clamp((centerDistance - halfWidthSum) / Math.max(1, halfWidthSum), 0, 1);
      const bridge = bridgeEvidence(smoothed, g1, g2, total);
      const edgeScore = geometricMean(edgeEvidence(g1, counts.length), edgeEvidence(g2, counts.length));

      const components = {
        ratio: ratioScore,
        prominence: prominenceScore,
        area: areaScore,
        width: widthScore,
        persistence: persistenceScore,
        separation: separationScore,
        bridge: bridge.score,
        edge: edgeScore,
      };
      const score = Object.entries(weights)
        .reduce((acc, [key, weight]) => acc + weight * components[key], 0);

      pairs.push({
        g1,
        g2,
        ratio,
        score,
        components,
        bridge,
        estimatedCVs: { g1: g1CV, g2: g2CV },
      });
    }
  }

  pairs.sort((a, b) => b.score - a.score);
  if (pairs.length) {
    const posteriorLike = pairSoftmaxProbability(pairs, options.softmaxTemperature ?? 0.08);
    const margin = pairs.length > 1 ? pairs[0].score - pairs[1].score : 0;
    const marginEvidence = pairs.length > 1
      ? 1 - Math.exp(-margin / (options.marginScale ?? 0.08))
      : pairs[0].score;
    const candidateFloor = Math.min(pairs[0].g1.quality, pairs[0].g2.quality);
    const confidence = clamp(
      0.45 * pairs[0].score
      + 0.25 * marginEvidence
      + 0.20 * posteriorLike
      + 0.10 * candidateFloor,
      0,
      1,
    );
    pairs[0].confidence = confidence;
    pairs[0].scoreMargin = margin;
    pairs[0].softmaxShare = posteriorLike;
  }
  return pairs;
}

function indexNearest(centers, value) {
  let best = 0;
  for (let i = 1; i < centers.length; i += 1) {
    if (Math.abs(centers[i] - value) < Math.abs(centers[best] - value)) best = i;
  }
  return best;
}

function chooseFallbackG1(candidates, centers, options = {}) {
  const expectedRatio = options.expectedRatio ?? 2;
  const maxX = centers[centers.length - 1];
  const feasible = candidates.filter((peak) => peak.x > 0 && expectedRatio * peak.x <= maxX * 1.05);
  const pool = feasible.length ? feasible : candidates;
  return [...pool].sort((a, b) => {
    const leftPreferenceA = clamp(1 - a.index / (0.75 * centers.length), 0, 1);
    const leftPreferenceB = clamp(1 - b.index / (0.75 * centers.length), 0, 1);
    return (0.85 * b.quality + 0.15 * leftPreferenceB)
      - (0.85 * a.quality + 0.15 * leftPreferenceA);
  })[0] ?? null;
}

function candidateByIndex(candidates, index, tolerance = 2) {
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate.index - index);
    if (distance <= tolerance && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function proposedRegion(edges, centerIndex, sigmaBins, multiplier) {
  const centers = binCenters(edges);
  const binWidth = medianBinWidth(edges);
  const center = centers[centerIndex];
  const halfWidth = Math.max(1.5 * binWidth, multiplier * sigmaBins * binWidth);
  return {
    left: clamp(center - halfWidth, edges[0], edges[edges.length - 1]),
    right: clamp(center + halfWidth, edges[0], edges[edges.length - 1]),
  };
}

/**
 * Create initial editable peak regions. These are proposals only; after the
 * user edits them, the four handles are immutable during model fitting.
 */
export function proposeAutomaticPeakRegions(edges, detection, options = {}) {
  const multiplier = options.regionSigmaMultiplier ?? 2.75;
  const g1Sigma = detection.g1Candidate?.sigmaLeftBins
    ?? detection.g1Candidate?.sigmaBins
    ?? detection.fallbackSigmaBins
    ?? 2;
  const g2Sigma = detection.g2Candidate?.sigmaRightBins
    ?? detection.g2Candidate?.sigmaBins
    ?? detection.fallbackSigmaBins
    ?? g1Sigma;
  const g1 = proposedRegion(edges, detection.g1Index, g1Sigma, multiplier);
  const g2 = proposedRegion(edges, detection.g2Index, g2Sigma, multiplier);

  if (g1.right >= g2.left) {
    const centers = binCenters(edges);
    const midpoint = 0.5 * (centers[detection.g1Index] + centers[detection.g2Index]);
    g1.right = Math.min(g1.right, midpoint);
    g2.left = Math.max(g2.left, midpoint);
  }

  return {
    g1: { ...g1, source: detection.g1Candidate ? "detected" : "inferred" },
    g2: { ...g2, source: detection.g2Candidate ? "detected" : "inferred" },
  };
}

/**
 * Hardened automatic peak initialization:
 * - detects local maxima at multiple Gaussian smoothing scales;
 * - merges peaks that persist across scales;
 * - measures prominence, width, area, and location stability;
 * - scores all biologically plausible G1/G2 pairs;
 * - reports confidence and explicit inferred/low-confidence states.
 */
export function detectCellCyclePeakPair(edges, counts, options = {}) {
  assertHistogram(edges, counts);
  const centers = binCenters(edges);
  const requestedScales = options.smoothingScales
    ?? [
      Math.max(0.75, 0.5 * (options.smoothingSigmaBins ?? 2)),
      options.smoothingSigmaBins ?? 2,
      2 * (options.smoothingSigmaBins ?? 2),
    ];
  const scales = uniqueSortedScales(requestedScales);
  if (!scales.length) throw new Error("At least one positive smoothing scale is required.");

  const scaleResults = scales.map((scale) => detectAtScale(counts, scale, options));
  const finalized = finalizeCandidates(scaleResults, centers, options);
  const pairs = scoreCellCyclePeakPairs({
    edges,
    counts,
    candidates: finalized.candidates,
    smoothed: finalized.primarySmoothed,
  }, options);

  const minPairScore = options.minPairScore ?? 0.52;
  const minConfidence = options.minPairConfidence ?? 0.65;
  const expectedRatio = options.expectedRatio ?? 2;
  let detection;

  if (pairs.length) {
    const selected = pairs[0];
    const status = selected.score >= minPairScore && selected.confidence >= minConfidence
      ? "detected"
      : "low_confidence";
    detection = {
      status,
      confidence: selected.confidence,
      g1Index: selected.g1.index,
      g2Index: selected.g2.index,
      g1Candidate: selected.g1,
      g2Candidate: selected.g2,
      selectedPair: selected,
      alternatives: pairs.slice(1, options.maxAlternatives ?? 4),
      reasons: status === "detected" ? [] : ["PAIR_EVIDENCE_WEAK_OR_AMBIGUOUS"],
    };
  } else {
    const fallbackG1 = chooseFallbackG1(finalized.candidates, centers, options);
    const g1Index = fallbackG1?.index ?? finalized.primarySmoothed.indexOf(Math.max(...finalized.primarySmoothed));
    const g2Index = indexNearest(centers, expectedRatio * centers[g1Index]);
    const inferredCandidate = candidateByIndex(finalized.candidates, g2Index, options.scaleMatchToleranceBins ?? 3);
    detection = {
      status: "inferred_g2",
      confidence: clamp(0.20 + 0.35 * (fallbackG1?.quality ?? 0), 0, 0.55),
      g1Index,
      g2Index,
      g1Candidate: fallbackG1,
      g2Candidate: inferredCandidate,
      selectedPair: null,
      alternatives: [],
      reasons: ["NO_PLAUSIBLE_DETECTED_PAIR", "G2_INITIALIZED_FROM_EXPECTED_RATIO"],
    };
  }

  detection.fallbackSigmaBins = detection.g1Candidate?.sigmaLeftBins
    ?? detection.g1Candidate?.sigmaBins
    ?? Math.max(1, (options.defaultCV ?? 0.06) * centers[detection.g1Index] / medianBinWidth(edges));
  detection.autoPeakRegions = proposeAutomaticPeakRegions(edges, detection, options);

  return {
    ...finalized,
    pairs,
    detection,
    autoPeakRegions: detection.autoPeakRegions,
    configuration: {
      smoothingScales: scales,
      primaryScale: finalized.primaryScale,
      expectedRatio,
      ratioRange: [...(options.ratioRange ?? [1.60, 2.35])],
      pairWeights: normalizedWeights(options.pairWeights),
      minPairScore,
      minPairConfidence: minConfidence,
      softmaxTemperature: options.softmaxTemperature ?? 0.08,
      marginScale: options.marginScale ?? 0.08,
      regionSigmaMultiplier: options.regionSigmaMultiplier ?? 2.75,
    },
  };
}
