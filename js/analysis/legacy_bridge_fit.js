"use strict";

// Temporary compatibility fit using the project's legacy tapered S-phase bridge
// (a G1 + tapered-S + G2 model fit to a linear DNA histogram by projected
// Levenberg-Marquardt). Wrapped for the model registry by
// models/legacy_bridge.js; this module holds the numerics. fitCellCycleHistogram()
// is the entry point: validateHistogramInput()/validateFittingOptions() guard
// inputs; initializeParameters() builds the starting point (via
// detectCandidatePeaks(), chooseG1G2Peaks(), estimateSigmaFromPeakWidth(),
// estimatePeakArea(), and initializeSBridge()); projectParameters() enforces the
// constraints; computeResiduals(), buildJacobian(), and fitWithLevenbergMarquardt()
// drive the fit. isArrayLike() and finiteMedian() are small internal helpers.

import { gaussianSmooth } from "./math/gaussian.js";
import {
  clamp,
  maximumValue,
  median,
  nearestIndex,
} from "./math/stats.js";
import {
  buildFiniteDiffJacobian,
  runLevenbergMarquardt,
} from "./math/lm_solver.js";
import {
  PARAMETER_INDEX,
  evaluateBaseModel,
  evaluateSBridge,
  gaussianPeak,
} from "./djf_components.js";

export const DEFAULT_OPTIONS = Object.freeze({
  smoothSigmaBins: 2,
  maxIterations: 150,
  tolerance: 1e-7,
  stepTolerance: 1e-6,
  initialLambda: 1e-2,
  finiteDifferenceStep: 1e-4,
  cvMin: 0.01,
  cvMax: 0.20,
  ratioTarget: 2,
  ratioMin: 1.70,
  ratioMax: 2.30,
  unlockRatio: false,
  weightedResiduals: false,
});

/*

Purpose:
	Whether a value is a numeric array-like (Array or typed array), excluding
	strings.

Input:
	value [any]: the value to test

Output:
	isArrayLike [boolean]: true for an array/typed array

*/
function isArrayLike(value) {
  return value != null &&
    typeof value !== "string" &&
    Number.isInteger(value.length) &&
    value.length >= 0;
}

/*

Purpose:
	Median of the values, falling back to a default when the median isn't finite
	(e.g. an empty set).

Input:
	values [array]: the values
	fallback [number]: the value to return when the median isn't finite

Output:
	median [number]: the finite median, or the fallback

*/
function finiteMedian(values, fallback = 0) {
  const value = median(values);
  return Number.isFinite(value) ? value : fallback;
}

/*

Purpose:
	Validates the histogram inputs: x and y are numeric array-likes of equal length
	(>= 10 bins), all finite, y nonnegative, and x strictly increasing.

Input:
	x [array]: bin centers
	y [array]: bin counts

Output:
	(none) [void]: throws TypeError/RangeError on invalid input

*/
export function validateHistogramInput(x, y) {
  if (!isArrayLike(x) || !isArrayLike(y)) {
    throw new TypeError("x and y must both be arrays or typed arrays.");
  }
  if (x.length !== y.length || x.length < 10) {
    throw new RangeError(
      "x and y must have the same length and contain at least 10 bins.",
    );
  }

  for (let bin = 0; bin < x.length; bin += 1) {
    if (!Number.isFinite(x[bin])) {
      throw new RangeError(`x[${bin}] is not finite.`);
    }
    if (!Number.isFinite(y[bin]) || y[bin] < 0) {
      throw new RangeError(`y[${bin}] must be finite and nonnegative.`);
    }
    if (bin > 0 && x[bin] <= x[bin - 1]) {
      throw new RangeError("x must be strictly increasing.");
    }
  }
}

/*

Purpose:
	Validates the fitting options (smoothing, CV bounds, G2/G1 ratio bounds,
	iteration/tolerance settings) before a fit begins.

Input:
	options [object]: the merged fit options

Output:
	(none) [void]: throws RangeError on an invalid setting

*/
export function validateFittingOptions(options) {
  if (!(options.smoothSigmaBins > 0) || !Number.isFinite(options.smoothSigmaBins)) {
    throw new RangeError("smoothSigmaBins must be finite and positive.");
  }
  if (
    !Number.isFinite(options.cvMin) ||
    !Number.isFinite(options.cvMax) ||
    !(options.cvMin > 0) ||
    !(options.cvMax >= options.cvMin)
  ) {
    throw new RangeError(
      "cvMin must be positive and cvMax must be greater than or equal to cvMin.",
    );
  }
  if (
    !Number.isFinite(options.ratioTarget) ||
    !Number.isFinite(options.ratioMin) ||
    !Number.isFinite(options.ratioMax) ||
    !(options.ratioTarget > 1) ||
    !(options.ratioMin > 1) ||
    !(options.ratioMax >= options.ratioMin)
  ) {
    throw new RangeError("The G2/G1 ratio settings are invalid.");
  }
  if (!Number.isInteger(options.maxIterations) || options.maxIterations < 0) {
    throw new RangeError("maxIterations must be a nonnegative integer.");
  }
  for (const name of [
    "tolerance",
    "stepTolerance",
    "initialLambda",
    "finiteDifferenceStep",
  ]) {
    if (!(options[name] > 0) || !Number.isFinite(options[name])) {
      throw new RangeError(`${name} must be finite and positive.`);
    }
  }
}

/*

Purpose:
	Finds ordinary local maxima (above a small fraction of the tallest bin) used by
	the fit's internal initializer, falling back to the single tallest bin when
	none qualify.

Input:
	x [array]: bin centers
	y [array]: bin counts

Output:
	peaks [array]: [{ index, x, height }, ...]

*/
export function detectCandidatePeaks(x, y) {
  const maximum = maximumValue(y);
  const minimumHeight = Math.max(0, maximum) * 0.03;
  const peaks = [];

  for (let bin = 1; bin < y.length - 1; bin += 1) {
    if (
      y[bin] >= y[bin - 1] &&
      y[bin] > y[bin + 1] &&
      y[bin] >= minimumHeight
    ) {
      peaks.push({ index: bin, x: x[bin], height: y[bin] });
    }
  }

  if (peaks.length === 0) {
    let tallestIndex = 0;
    for (let bin = 1; bin < y.length; bin += 1) {
      if (y[bin] > y[tallestIndex]) tallestIndex = bin;
    }
    peaks.push({
      index: tallestIndex,
      x: x[tallestIndex],
      height: y[tallestIndex],
    });
  }
  return peaks;
}

/*

Purpose:
	Chooses the strongest plausible G1/G2 peak pair (best height with a ratio near
	the target), with the source implementation's expected-G2 search fallback when
	no pair qualifies.

Input:
	x [array]: bin centers
	y [array]: bin counts
	options [object]: the fit options (ratioTarget, ...)

Output:
	pair [object]: { first, second, detectedRatio }

*/
export function chooseG1G2Peaks(x, y, options) {
  const peaks = detectCandidatePeaks(x, y);
  let bestPair = null;
  let bestScore = -Infinity;

  for (const first of peaks) {
    if (!(first.x > 0)) continue;

    for (const second of peaks) {
      if (second.x <= first.x) continue;
      const ratio = second.x / first.x;
      if (ratio < 1.45 || ratio > 2.55) continue;

      const ratioPenalty = 6 * (ratio - options.ratioTarget) ** 2;
      const score =
        Math.log1p(first.height) +
        Math.log1p(second.height) -
        ratioPenalty;
      if (score > bestScore) {
        bestScore = score;
        bestPair = { first, second, detectedRatio: ratio };
      }
    }
  }
  if (bestPair) return bestPair;

  let first = peaks[0];
  for (const peak of peaks) {
    if (peak.height > first.height) first = peak;
  }

  const expectedG2 = options.ratioTarget * first.x;
  const lowerSearchBound = expectedG2 * 0.85;
  const upperSearchBound = expectedG2 * 1.15;
  let secondIndex = nearestIndex(x, expectedG2);
  let secondHeight = y[secondIndex];

  for (let bin = 0; bin < x.length; bin += 1) {
    if (
      x[bin] >= lowerSearchBound &&
      x[bin] <= upperSearchBound &&
      y[bin] > secondHeight
    ) {
      secondIndex = bin;
      secondHeight = y[bin];
    }
  }

  const second = {
    index: secondIndex,
    x: x[secondIndex],
    height: y[secondIndex],
  };
  return { first, second, detectedRatio: second.x / first.x };
}

/*

Purpose:
	Estimates a peak's Gaussian sigma from its local full width at half maximum
	(floored so adjacent bins give a nonzero width).

Input:
	x [array]: bin centers
	y [array]: bin counts
	peakIndex [number]: the peak's bin index

Output:
	sigma [number]: the estimated Gaussian sigma

*/
export function estimateSigmaFromPeakWidth(x, y, peakIndex) {
  const peakHeight = y[peakIndex];
  const halfHeight = 0.5 * peakHeight;
  let leftIndex = peakIndex;
  while (leftIndex > 0 && y[leftIndex] > halfHeight) leftIndex -= 1;

  let rightIndex = peakIndex;
  while (rightIndex < y.length - 1 && y[rightIndex] > halfHeight) {
    rightIndex += 1;
  }

  const measuredFwhm = Math.abs(x[rightIndex] - x[leftIndex]);
  const nearbyLeft = Math.max(0, peakIndex - 1);
  const nearbyRight = Math.min(x.length - 1, peakIndex + 1);
  const minimumFwhm = Math.abs(x[nearbyRight] - x[nearbyLeft]);
  return Math.max(measuredFwhm, minimumFwhm, Number.EPSILON) / 2.354820045;
}

/*

Purpose:
	Estimates a peak's baseline-subtracted area by trapezoidal integration over
	+/-2.5 sigma, falling back to a Gaussian area when too few bins are in range.

Input:
	x [array]: bin centers
	y [array]: bin counts
	mu [number]: the peak center
	sigma [number]: the peak sigma

Output:
	area [number]: the estimated (nonnegative) peak area

*/
export function estimatePeakArea(x, y, mu, sigma) {
  const lowerBound = mu - 2.5 * sigma;
  const upperBound = mu + 2.5 * sigma;
  const selectedIndices = [];
  for (let bin = 0; bin < x.length; bin += 1) {
    if (x[bin] >= lowerBound && x[bin] <= upperBound) {
      selectedIndices.push(bin);
    }
  }

  if (selectedIndices.length < 2) {
    const peakIndex = nearestIndex(x, mu);
    return y[peakIndex] * sigma * Math.sqrt(2 * Math.PI);
  }

  const edgeValues = [
    y[selectedIndices[0]],
    y[selectedIndices[Math.min(1, selectedIndices.length - 1)]],
    y[selectedIndices[Math.max(0, selectedIndices.length - 2)]],
    y[selectedIndices[selectedIndices.length - 1]],
  ];
  const baseline = Math.max(0, finiteMedian(edgeValues));
  let area = 0;

  for (let position = 1; position < selectedIndices.length; position += 1) {
    const previousIndex = selectedIndices[position - 1];
    const currentIndex = selectedIndices[position];
    const previousHeight = Math.max(0, y[previousIndex] - baseline);
    const currentHeight = Math.max(0, y[currentIndex] - baseline);
    area +=
      0.5 *
      (previousHeight + currentHeight) *
      (x[currentIndex] - x[previousIndex]);
  }
  return Math.max(area, 0);
}

/*

Purpose:
	Initializes a broad nonnegative S-phase bridge (three control levels) from the
	residual histogram height between the G1 and G2 peaks.

Input:
	x [array]: bin centers
	y [array]: bin counts
	parameters [array]: the current parameter vector (G1/G2 peaks)

Output:
	levels [array]: the [s0, s1, s2] bridge control levels

*/
export function initializeSBridge(x, y, parameters) {
  const mu1 = parameters[PARAMETER_INDEX.MU1];
  const ratio = parameters[PARAMETER_INDEX.R];
  const sigma1 = parameters[PARAMETER_INDEX.SIGMA1];
  const sigma2 = parameters[PARAMETER_INDEX.SIGMA2];
  const a1 = parameters[PARAMETER_INDEX.A1];
  const a2 = parameters[PARAMETER_INDEX.A2];
  const mu2 = ratio * mu1;
  const leftValues = [];
  const middleValues = [];
  const rightValues = [];

  for (let bin = 0; bin < x.length; bin += 1) {
    if (x[bin] <= mu1 || x[bin] >= mu2) continue;
    const t = (x[bin] - mu1) / (mu2 - mu1);
    const remainingHeight = Math.max(
      0,
      y[bin] -
        gaussianPeak(x[bin], mu1, sigma1, a1) -
        gaussianPeak(x[bin], mu2, sigma2, a2),
    );

    if (t < 1 / 3) leftValues.push(remainingHeight);
    else if (t < 2 / 3) middleValues.push(remainingHeight);
    else rightValues.push(remainingHeight);
  }

  const broadLevel = Math.max(
    0,
    finiteMedian([...leftValues, ...middleValues, ...rightValues]),
  );
  return [
    Math.max(finiteMedian(leftValues), 0.5 * broadLevel),
    Math.max(finiteMedian(middleValues), broadLevel),
    Math.max(finiteMedian(rightValues), 0.5 * broadLevel),
  ];
}

/*

Purpose:
	Full source-faithful initializer: smooths the histogram, picks G1/G2 peaks and
	their widths and amplitudes, then seeds the S bridge -- producing the starting
	parameter vector for the fit.

Input:
	x [array]: bin centers
	y [array]: bin counts
	options [object]: the fit options

Output:
	init [object]: { parameters, detectedPeaks, smoothedHistogram }

*/
export function initializeParameters(x, y, options) {
  const smoothedHistogram = gaussianSmooth(y, options.smoothSigmaBins);
  const { first, second, detectedRatio } = chooseG1G2Peaks(
    x,
    smoothedHistogram,
    options,
  );

  const mu1 = first.x;
  let ratio = detectedRatio;
  let mu2 = second.x;
  if (!options.unlockRatio) {
    ratio = options.ratioTarget;
    mu2 = ratio * mu1;
  }

  let sigma1 = estimateSigmaFromPeakWidth(x, smoothedHistogram, first.index);
  let sigma2 = estimateSigmaFromPeakWidth(x, smoothedHistogram, second.index);
  sigma1 = clamp(sigma1, options.cvMin * mu1, options.cvMax * mu1);
  sigma2 = clamp(sigma2, options.cvMin * mu2, options.cvMax * mu2);

  const area1 = estimatePeakArea(x, smoothedHistogram, mu1, sigma1);
  const area2 = estimatePeakArea(x, smoothedHistogram, mu2, sigma2);
  const areaDerivedA1 = area1 / (sigma1 * Math.sqrt(2 * Math.PI));
  const areaDerivedA2 = area2 / (sigma2 * Math.sqrt(2 * Math.PI));
  const parameters = [
    mu1,
    ratio,
    sigma1,
    sigma2,
    Math.max(first.height, areaDerivedA1, 0),
    Math.max(second.height, areaDerivedA2, 0),
    0,
    0,
    0,
  ];

  const [s0, s1, s2] = initializeSBridge(x, smoothedHistogram, parameters);
  parameters[PARAMETER_INDEX.S0] = s0;
  parameters[PARAMETER_INDEX.S1] = s1;
  parameters[PARAMETER_INDEX.S2] = s2;

  return {
    parameters,
    detectedPeaks: {
      g1Index: first.index,
      g2Index: second.index,
      detectedMu1: first.x,
      detectedMu2: second.x,
      detectedRatio,
    },
    smoothedHistogram,
  };
}

/*

Purpose:
	Projects every parameter onto the model's constraints (peak ordering via the
	G2/G1 ratio, CV-bounded sigmas, nonnegative amplitudes and S levels).

Input:
	parameters [array]: the parameter vector to project
	x [array]: bin centers (for the domain bounds)
	options [object]: the fit options (ratio/CV bounds, unlockRatio)

Output:
	projected [array]: the constraint-satisfying parameter vector

*/
export function projectParameters(parameters, x, options) {
  const projected = Array.from(parameters);
  const xMinimum = x[0];
  const xMaximum = x[x.length - 1];
  const xSpan = Math.max(xMaximum - xMinimum, Number.EPSILON);
  const ratio = options.unlockRatio
    ? clamp(projected[PARAMETER_INDEX.R], options.ratioMin, options.ratioMax)
    : options.ratioTarget;

  const minimumMu1 = Math.max(
    xMinimum + 1e-6 * xSpan,
    Number.EPSILON,
  );
  const maximumMu1 = Math.max(
    minimumMu1,
    (xMaximum - 1e-6 * xSpan) / ratio,
  );
  const mu1 = clamp(projected[PARAMETER_INDEX.MU1], minimumMu1, maximumMu1);
  const mu2 = ratio * mu1;
  projected[PARAMETER_INDEX.MU1] = mu1;
  projected[PARAMETER_INDEX.R] = ratio;
  projected[PARAMETER_INDEX.SIGMA1] = clamp(
    Math.abs(projected[PARAMETER_INDEX.SIGMA1]),
    options.cvMin * mu1,
    options.cvMax * mu1,
  );
  projected[PARAMETER_INDEX.SIGMA2] = clamp(
    Math.abs(projected[PARAMETER_INDEX.SIGMA2]),
    options.cvMin * mu2,
    options.cvMax * mu2,
  );

  for (const index of [
    PARAMETER_INDEX.A1,
    PARAMETER_INDEX.A2,
    PARAMETER_INDEX.S0,
    PARAMETER_INDEX.S1,
    PARAMETER_INDEX.S2,
  ]) {
    projected[index] = Math.max(0, projected[index]);
  }
  return projected;
}

/*

Purpose:
	Evaluates the model and returns residuals (fitted minus observed), optionally
	Poisson-weighted, alongside the raw residuals and the evaluated model.

Input:
	x [array]: bin centers
	y [array]: bin counts
	parameters [array]: the parameter vector
	options [object]: the fit options (weightedResiduals)

Output:
	result [object]: { residuals, rawResiduals, model }

*/
export function computeResiduals(x, y, parameters, options) {
  const model = evaluateBaseModel(x, parameters);
  const rawResiduals = new Array(y.length);
  const residuals = new Array(y.length);
  for (let bin = 0; bin < y.length; bin += 1) {
    const rawResidual = model.fitted[bin] - y[bin];
    rawResiduals[bin] = rawResidual;
    residuals[bin] = options.weightedResiduals
      ? rawResidual / Math.sqrt(Math.max(y[bin], 1))
      : rawResidual;
  }
  return { residuals, rawResiduals, model };
}

/*

Purpose:
	Source-signature adapter retained for focused Jacobian tests: builds the
	finite-difference Jacobian of the residuals with respect to the free
	parameters.

Input:
	x [array]: bin centers
	y [array]: bin counts
	parameters [array]: the parameter vector
	baseResiduals [array]: residuals at the current parameters
	freeParameterIndices [array]: which parameters are free
	options [object]: the fit options (finiteDifferenceStep)

Output:
	jacobian [array]: the finite-difference Jacobian

*/
export function buildJacobian(
  x,
  y,
  parameters,
  baseResiduals,
  freeParameterIndices,
  options,
) {
  return buildFiniteDiffJacobian({
    parameters,
    baseResiduals,
    freeIndices: freeParameterIndices,
    residualFn: values => computeResiduals(x, y, values, options),
    projectFn: values => projectParameters(values, x, options),
    finiteDifferenceStep: options.finiteDifferenceStep,
  });
}

/*

Purpose:
	Thin adapter around the shared projected Levenberg-Marquardt driver: defines
	the free-parameter set (adding the ratio only when unlocked) and wires in the
	project/residual functions.

Input:
	x [array]: bin centers
	y [array]: bin counts
	initialParameters [array]: the starting parameter vector
	options [object]: the fit options

Output:
	fit [object]: the LM result (parameters, residuals, diagnostics)

*/
export function fitWithLevenbergMarquardt(x, y, initialParameters, options) {
  const freeIndices = [
    PARAMETER_INDEX.MU1,
    ...(options.unlockRatio ? [PARAMETER_INDEX.R] : []),
    PARAMETER_INDEX.SIGMA1,
    PARAMETER_INDEX.SIGMA2,
    PARAMETER_INDEX.A1,
    PARAMETER_INDEX.A2,
    PARAMETER_INDEX.S0,
    PARAMETER_INDEX.S1,
    PARAMETER_INDEX.S2,
  ];

  return runLevenbergMarquardt({
    initialParameters,
    freeIndices,
    projectFn: parameters => projectParameters(parameters, x, options),
    residualFn: parameters => computeResiduals(x, y, parameters, options),
    options,
  });
}

/*

Purpose:
	Fits a G1 + S + G2 model to a linear DNA histogram: validates inputs,
	initializes parameters, runs projected LM, and returns the fitted parameters,
	component curves, and diagnostics. The registry's entry point into the legacy
	fit.

Input:
	x [array]: bin centers
	y [array]: bin counts
	userOptions [object]: options overriding DEFAULT_OPTIONS

Output:
	result [object]: { parameters, curves, diagnostics } (the legacy-shaped result)

*/
export function fitCellCycleHistogram(x, y, userOptions = {}) {
  validateHistogramInput(x, y);
  const xValues = Array.from(x);
  const yValues = Array.from(y);
  const options = { ...DEFAULT_OPTIONS, ...userOptions };
  validateFittingOptions(options);

  const initialization = initializeParameters(xValues, yValues, options);
  const fit = fitWithLevenbergMarquardt(
    xValues,
    yValues,
    initialization.parameters,
    options,
  );
  const parameters = fit.parameters;
  const mu1 = parameters[PARAMETER_INDEX.MU1];
  const ratio = parameters[PARAMETER_INDEX.R];
  const mu2 = ratio * mu1;
  const sigma1 = parameters[PARAMETER_INDEX.SIGMA1];
  const sigma2 = parameters[PARAMETER_INDEX.SIGMA2];
  const model = fit.model ?? evaluateBaseModel(xValues, parameters);

  return {
    parameters: {
      mu1,
      mu2,
      R: ratio,
      sigma1,
      sigma2,
      cv1: sigma1 / mu1,
      cv2: sigma2 / mu2,
      a1: parameters[PARAMETER_INDEX.A1],
      a2: parameters[PARAMETER_INDEX.A2],
      s0: parameters[PARAMETER_INDEX.S0],
      s1: parameters[PARAMETER_INDEX.S1],
      s2: parameters[PARAMETER_INDEX.S2],
    },
    curves: {
      x: [...xValues],
      observed: [...yValues],
      g1: [...model.g1],
      s: [...model.s],
      g2: [...model.g2],
      fitted: [...model.fitted],
      residuals: [...fit.residuals],
    },
    diagnostics: {
      converged: fit.converged,
      maxIterationsReached: fit.maxIterationsReached,
      cancelled: fit.cancelled,
      iterations: fit.iterations,
      sse: fit.sse,
      finalLambda: fit.finalLambda,
      detectedPeaks: initialization.detectedPeaks,
      ratioWasUnlocked: options.unlockRatio,
      options,
    },
  };
}

// Re-export the source model helpers alongside this module's fit helpers.
export {
  PARAMETER_INDEX,
  evaluateBaseModel,
  evaluateSBridge,
  gaussianPeak,
};

export const evaluateModel = evaluateBaseModel;
export const gaussianPeakHeight = gaussianPeak;
