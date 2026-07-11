// Shared Gaussian/log-domain helpers for the staged DJF pipeline.

import { invertCovariance2D } from "./linalg2d.js";

/** Gaussian parameterized by peak height, matching the source DJF convention. */
export function gaussianPeakHeight(x, mean, sigma, amplitude) {
  if (!(sigma > 0) || !Number.isFinite(sigma)) return 0;

  const z = (x - mean) / sigma;
  return Math.max(0, amplitude) * Math.exp(-0.5 * z * z);
}

/**
 * Smooth a one-dimensional signal with a normalized Gaussian kernel.
 * Boundary points are normalized by the portion of the kernel that overlaps
 * the signal, avoiding artificial attenuation at either edge.
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

/** Overflow-safe logistic transform. */
export function logistic(value) {
  if (value >= 0) {
    const exponential = Math.exp(-value);
    return 1 / (1 + exponential);
  }

  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

/** Stable log(sum(exp(values))). */
export function logSumExp(logValues) {
  if (!logValues || logValues.length === 0) return -Infinity;

  let maximum = -Infinity;
  for (const value of logValues) maximum = Math.max(maximum, value);
  if (!Number.isFinite(maximum)) return maximum;

  let sum = 0;
  for (const value of logValues) sum += Math.exp(value - maximum);
  return maximum + Math.log(sum);
}

/** Log density of a full-covariance, two-dimensional Gaussian component. */
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
