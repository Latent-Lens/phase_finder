"use strict";

// Stage 6: constrained single-cycle Dean-Jett-Fox histogram fit.

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

function isArrayLike(value) {
  return value != null &&
    typeof value !== "string" &&
    Number.isInteger(value.length) &&
    value.length >= 0;
}

function finiteMedian(values, fallback = 0) {
  const value = median(values);
  return Number.isFinite(value) ? value : fallback;
}

/** Validate Arrays, typed arrays, and other numeric array-like inputs. */
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

/** Find ordinary local maxima used by Stage 6's internal initializer. */
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

/** Select the strongest plausible pair, with the source implementation's fallback. */
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

/** Estimate Gaussian sigma from local full width at half maximum. */
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

/** Estimate baseline-subtracted local peak area by trapezoidal integration. */
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

/** Initialize a broad nonnegative S bridge from residual histogram height. */
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

/** Full source-faithful initializer: peaks, widths, amplitudes, then S bridge. */
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

/** Project every parameter onto the DJF constraints. */
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

/** Residual convention is fitted minus observed. */
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

/** Source-signature adapter retained for focused Jacobian tests. */
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

/** Thin Stage 6 adapter around the shared projected LM driver. */
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

/** Fit a G1 + S + G2 model to a linear DNA histogram. */
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
      iterations: fit.iterations,
      sse: fit.sse,
      finalLambda: fit.finalLambda,
      detectedPeaks: initialization.detectedPeaks,
      ratioWasUnlocked: options.unlockRatio,
      options,
    },
  };
}

// Re-export the source model helpers alongside the stage-specific fit helpers.
export {
  PARAMETER_INDEX,
  evaluateBaseModel,
  evaluateSBridge,
  gaussianPeak,
};

export const evaluateModel = evaluateBaseModel;
export const gaussianPeakHeight = gaussianPeak;
