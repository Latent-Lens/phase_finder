// Shared Gaussian and log-domain helpers for the cell-cycle pipeline. Covers
// the 1-D building blocks the models use -- gaussianPeakHeight (a peak-height
// parameterized Gaussian) and gaussianSmooth (edge-normalized Gaussian
// smoothing) -- plus numerically stable transforms shared across the fit and
// gating code: logistic, logSumExp, and logGaussian2D (the log density of a
// full-covariance 2-D Gaussian, used by the FSC/SSC cell gate).

import { invertCovariance2D } from "./linalg2d.js";

/*

Purpose:
	Evaluates a Gaussian parameterized by its peak HEIGHT (amplitude at the
	mean), matching the source convention, rather than by area.

Input:
	x [number]: the point to evaluate at
	mean [number]: the Gaussian's center
	sigma [number]: the standard deviation (must be finite and > 0)
	amplitude [number]: the peak height at x = mean (negative is clamped to 0)

Output:
	value [number]: the Gaussian value at x, or 0 for a non-positive sigma

*/
export function gaussianPeakHeight(x, mean, sigma, amplitude) {
  if (!(sigma > 0) || !Number.isFinite(sigma)) return 0;

  const z = (x - mean) / sigma;
  return Math.max(0, amplitude) * Math.exp(-0.5 * z * z);
}

/*

Purpose:
	Smooths a 1-D signal with a normalized Gaussian kernel. Boundary points are
	normalized by the portion of the kernel that overlaps the signal, so neither
	edge is artificially attenuated.

Input:
	values [array|TypedArray]: the signal to smooth
	sigmaBins [number]: the kernel standard deviation, in bins

Output:
	smoothed [array]: the smoothed signal (a copy of the input when sigmaBins is
	                  not a positive finite number, or [] when empty)

*/
export function gaussianSmooth(values, sigmaBins) {
  const length = values?.length ?? 0;
  if (length === 0) return [];

  if (!(sigmaBins > 0) || !Number.isFinite(sigmaBins)) {
    return Array.from(values);
  }

  const radius = Math.max(1, Math.ceil(4 * sigmaBins));
  const kernel = new Float64Array(2 * radius + 1);

  for (let offset = -radius; offset <= radius; offset++) {
    kernel[offset + radius] = Math.exp(
      -0.5 * (offset / sigmaBins) ** 2,
    );
  }

  const smoothed = new Array(length);

  for (let index = 0; index < length; index++) {
    let weightedSum = 0;
    let weightSum = 0;

    for (let offset = -radius; offset <= radius; offset++) {
      const sourceIndex = index + offset;
      if (sourceIndex < 0 || sourceIndex >= length) continue;

      const weight = kernel[offset + radius];
      weightedSum += weight * values[sourceIndex];
      weightSum += weight;
    }

    smoothed[index] = weightSum > 0 ? weightedSum / weightSum : values[index];
  }

  return smoothed;
}

/*

Purpose:
	Overflow-safe logistic (sigmoid) transform, evaluated in whichever branch
	keeps the exponent negative so large-magnitude inputs never overflow.

Input:
	value [number]: the logit

Output:
	probability [number]: 1 / (1 + e^-value), in (0, 1)

*/
export function logistic(value) {
  if (value >= 0) {
    const exponential = Math.exp(-value);
    return 1 / (1 + exponential);
  }

  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

/*

Purpose:
	Numerically stable log(sum(exp(values))), computed by factoring out the max
	so the exponentials never overflow.

Input:
	logValues [array]: values already in the log domain

Output:
	result [number]: log of the summed exponentials, or -Infinity when empty

*/
export function logSumExp(logValues) {
  if (!logValues || logValues.length === 0) return -Infinity;

  let maximum = -Infinity;
  for (const value of logValues) maximum = Math.max(maximum, value);
  if (!Number.isFinite(maximum)) return maximum;

  let sum = 0;
  for (const value of logValues) sum += Math.exp(value - maximum);
  return maximum + Math.log(sum);
}

/*

Purpose:
	Log density of a full-covariance, two-dimensional Gaussian component -- the
	per-event term the FSC/SSC cell-gate mixture model evaluates.

Input:
	point [array]: the [x, y] observation
	component [object]: { mean: [x, y], covariance: [[a, b], [c, d]] }

Output:
	logDensity [number]: the log density, or -Infinity when the covariance is
	                     singular or the result is non-finite

*/
export function logGaussian2D(point, component) {
  const matrixInfo = invertCovariance2D(component?.covariance);
  if (!matrixInfo) return -Infinity;

  const [x, y] = point;
  const [meanX, meanY] = component.mean;
  const dx = x - meanX;
  const dy = y - meanY;
  const inverse = matrixInfo.inverse;

  const mahalanobis =
    dx * (inverse[0][0] * dx + inverse[0][1] * dy) +
    dy * (inverse[1][0] * dx + inverse[1][1] * dy);

  if (!Number.isFinite(mahalanobis)) return -Infinity;

  return (
    -Math.log(2 * Math.PI) -
    0.5 * Math.log(matrixInfo.determinant) -
    0.5 * mahalanobis
  );
}
