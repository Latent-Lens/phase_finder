// Stage 5: detect a prominent lower/upper DNA peak pair near a 2:1 ratio.

import { gaussianSmooth } from "./math/gaussian.js";
import { maximumValue } from "./math/stats.js";

function isArrayLike(value) {
  return value != null &&
    typeof value !== "string" &&
    Number.isInteger(value.length) &&
    value.length >= 0;
}

export function validatePeakDetectionInput(histogram, options) {
  if (!isArrayLike(histogram) || histogram.length < 3) {
    throw new RangeError("Histogram must contain at least three bins.");
  }
  for (let bin = 0; bin < histogram.length; bin += 1) {
    if (!Number.isFinite(histogram[bin]) || histogram[bin] < 0) {
      throw new RangeError(`histogram[${bin}] must be finite and nonnegative.`);
    }
  }

  if (!(options.sigma > 0) || !Number.isFinite(options.sigma)) {
    throw new RangeError("Gaussian smoothing sigma must be finite and greater than zero.");
  }
  if (!(options.binWidth > 0) || !Number.isFinite(options.binWidth)) {
    throw new RangeError("Histogram bin width must be finite and greater than zero.");
  }
  if (!Number.isFinite(options.histogramMin)) {
    throw new RangeError("histogramMin must be finite.");
  }
  if (
    !Number.isFinite(options.minimumRatio) ||
    !Number.isFinite(options.maximumRatio) ||
    !Number.isFinite(options.targetRatio) ||
    !(options.minimumRatio > 1) ||
    !(options.maximumRatio >= options.minimumRatio) ||
    !(options.targetRatio >= options.minimumRatio) ||
    !(options.targetRatio <= options.maximumRatio)
  ) {
    throw new RangeError("Peak-ratio settings are invalid.");
  }
  if (!(options.ratioSigma > 0) || !Number.isFinite(options.ratioSigma)) {
    throw new RangeError("ratioSigma must be finite and greater than zero.");
  }
  if (
    options.minProminence != null &&
    (!Number.isFinite(options.minProminence) || options.minProminence < 0)
  ) {
    throw new RangeError("minProminence must be finite and nonnegative.");
  }
  if (
    !Number.isFinite(options.minProminenceFraction) ||
    options.minProminenceFraction < 0
  ) {
    throw new RangeError("minProminenceFraction must be finite and nonnegative.");
  }
}

/** Collapse every flat-topped local maximum to the center of its plateau. */
export function findLocalMaxima(smoothedHistogram) {
  const localMaxima = [];
  let bin = 1;

  while (bin < smoothedHistogram.length - 1) {
    const current = smoothedHistogram[bin];
    const previous = smoothedHistogram[bin - 1];
    if (current <= previous) {
      bin += 1;
      continue;
    }

    let plateauEnd = bin;
    while (
      plateauEnd + 1 < smoothedHistogram.length &&
      smoothedHistogram[plateauEnd + 1] === current
    ) {
      plateauEnd += 1;
    }

    const nextValue =
      plateauEnd + 1 < smoothedHistogram.length
        ? smoothedHistogram[plateauEnd + 1]
        : -Infinity;
    if (current > nextValue) {
      const peakBin = Math.floor((bin + plateauEnd) / 2);
      localMaxima.push({ bin: peakBin, height: smoothedHistogram[peakBin] });
    }
    bin = plateauEnd + 1;
  }

  return localMaxima;
}

/** Prominence above the higher of the two surrounding basin minima. */
export function calculatePeakProminence(values, peakBin) {
  const peakHeight = values[peakBin];
  let leftMinimum = peakHeight;
  for (let left = peakBin - 1; left >= 0; left -= 1) {
    leftMinimum = Math.min(leftMinimum, values[left]);
    if (values[left] > peakHeight) break;
  }

  let rightMinimum = peakHeight;
  for (let right = peakBin + 1; right < values.length; right += 1) {
    rightMinimum = Math.min(rightMinimum, values[right]);
    if (values[right] > peakHeight) break;
  }

  return Math.max(0, peakHeight - Math.max(leftMinimum, rightMinimum));
}

/**
 * Smooth, filter, and score all plausible lower/upper DNA-content peak pairs.
 */
export function detectDNAContentPeaks(histogram, userOptions = {}) {
  const options = {
    sigma: 2,
    histogramMin: 0,
    binWidth: 1,
    minProminence: null,
    minProminenceFraction: 0.02,
    targetRatio: 2,
    minimumRatio: 1.8,
    maximumRatio: 2.1,
    ratioSigma: 0.08,
    ...userOptions,
  };
  validatePeakDetectionInput(histogram, options);

  const values = Array.from(histogram);
  const smoothedHistogram = gaussianSmooth(values, options.sigma);
  const localMaxima = findLocalMaxima(smoothedHistogram);
  const allPeaks = localMaxima.map(peak => ({
    ...peak,
    prominence: calculatePeakProminence(smoothedHistogram, peak.bin),
  }));

  const maximumSmoothedHeight = maximumValue(smoothedHistogram);
  const prominenceThreshold = Number.isFinite(options.minProminence)
    ? options.minProminence
    : options.minProminenceFraction * Math.max(0, maximumSmoothedHeight);
  const retainedPeaks = allPeaks.filter(
    peak => peak.prominence >= prominenceThreshold,
  );

  if (retainedPeaks.length < 2) {
    return {
      found: false,
      status: "Fewer than two sufficiently prominent peaks were found.",
      smoothedHistogram,
      allPeaks,
      retainedPeaks,
      prominenceThreshold,
      candidatePairs: [],
    };
  }

  const binCenter = bin =>
    options.histogramMin + (bin + 0.5) * options.binWidth;
  const candidatePairs = [];

  for (let lowerIndex = 0; lowerIndex < retainedPeaks.length; lowerIndex += 1) {
    const lowerPeak = retainedPeaks[lowerIndex];
    const lowerPosition = binCenter(lowerPeak.bin);
    if (!(lowerPosition > 0)) continue;

    for (let upperIndex = 0; upperIndex < retainedPeaks.length; upperIndex += 1) {
      const upperPeak = retainedPeaks[upperIndex];
      if (upperPeak.bin <= lowerPeak.bin) continue;

      const upperPosition = binCenter(upperPeak.bin);
      const ratio = upperPosition / lowerPosition;
      if (ratio < options.minimumRatio || ratio > options.maximumRatio) continue;

      const ratioDeviation = (ratio - options.targetRatio) / options.ratioSigma;
      const ratioWeight = Math.exp(-0.5 * ratioDeviation * ratioDeviation);
      const lowerStrength = lowerPeak.prominence + 0.25 * lowerPeak.height;
      const upperStrength = upperPeak.prominence + 0.25 * upperPeak.height;
      const pairStrength = Math.sqrt(lowerStrength * upperStrength);

      candidatePairs.push({
        lowerPeak,
        upperPeak,
        lowerPosition,
        upperPosition,
        ratio,
        ratioWeight,
        score: pairStrength * ratioWeight,
      });
    }
  }

  if (candidatePairs.length === 0) {
    return {
      found: false,
      status: "No sufficiently prominent peak pair had an acceptable 2C/1C ratio.",
      smoothedHistogram,
      allPeaks,
      retainedPeaks,
      prominenceThreshold,
      candidatePairs,
    };
  }

  candidatePairs.sort((left, right) => right.score - left.score);
  const bestPair = candidatePairs[0];

  return {
    found: true,
    status: "DNA peak pair found",
    mu1: bestPair.lowerPosition,
    mu2: bestPair.upperPosition,
    mu1Bin: bestPair.lowerPeak.bin,
    mu2Bin: bestPair.upperPeak.bin,
    ratio: bestPair.ratio,
    score: bestPair.score,
    lowerPeak: bestPair.lowerPeak,
    upperPeak: bestPair.upperPeak,
    smoothedHistogram,
    allPeaks,
    retainedPeaks,
    candidatePairs,
    prominenceThreshold,
    settings: {
      sigma: options.sigma,
      histogramMin: options.histogramMin,
      binWidth: options.binWidth,
      targetRatio: options.targetRatio,
      minimumRatio: options.minimumRatio,
      maximumRatio: options.maximumRatio,
    },
  };
}
