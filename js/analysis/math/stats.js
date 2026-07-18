// Shared robust-statistics helpers for the cell-cycle pipeline.

/** Clamp a number to an inclusive interval. */
export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Median of an Array or typed array.
 *
 * Callers that work with partially missing observations should filter them
 * first.  Returning NaN for an empty sample makes a missing metric explicit
 * (and is important to Stage 1's dynamic metric selection).
 */
export function median(values) {
  if (!values || values.length === 0) return NaN;

  const sorted = Array.from(values).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1
    ? sorted[middle]
    : 0.5 * (sorted[middle - 1] + sorted[middle]);
}

/** Median absolute deviation about the supplied (or sample) center. */
export function mad(values, center = median(values)) {
  if (!values || values.length === 0 || !Number.isFinite(center)) {
    return NaN;
  }

  const deviations = Array.from(
    values,
    value => Math.abs(value - center),
  );

  return median(deviations);
}

/** Arithmetic mean. */
export function mean(values) {
  if (!values || values.length === 0) return NaN;

  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/** Population variance (the convention used by the source implementation). */
export function variance(values) {
  if (!values || values.length < 2) return 0;

  const center = mean(values);
  let total = 0;

  for (const value of values) {
    const difference = value - center;
    total += difference * difference;
  }

  return total / values.length;
}

/** Linear-interpolated quantile of values that are already sorted. */
export function quantileSorted(sortedValues, probability) {
  const length = sortedValues?.length ?? 0;
  if (length === 0) return NaN;
  if (length === 1) return sortedValues[0];

  const p = clamp(probability, 0, 1);
  const position = (length - 1) * p;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const fraction = position - lowerIndex;

  return (
    sortedValues[lowerIndex] +
    fraction * (sortedValues[upperIndex] - sortedValues[lowerIndex])
  );
}

/** Maximum without materializing typed arrays through Math.max(...values). */
export function maximumValue(values) {
  let maximum = -Infinity;
  for (const value of values ?? []) {
    if (value > maximum) maximum = value;
  }
  return maximum;
}

/** Sum of squared values. */
export function sumSquares(values) {
  let total = 0;
  for (const value of values ?? []) total += value * value;
  return total;
}

/** Robust residual scale, with a non-zero floor for numerical solvers. */
export function robustResidualScale(residuals, minimumScale = 1e-12) {
  const center = median(residuals);
  if (!Number.isFinite(center)) return minimumScale;

  const scale = 1.4826 * mad(residuals, center);
  return Number.isFinite(scale)
    ? Math.max(scale, minimumScale)
    : minimumScale;
}

/** Index of the closest value to a target. */
export function nearestIndex(values, target) {
  if (!values || values.length === 0) return -1;

  let bestIndex = 0;
  let bestDistance = Infinity;

  for (let index = 0; index < values.length; index++) {
    const distance = Math.abs(values[index] - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  return bestIndex;
}

/** A fraction helper used by reporting code when an area is absent. */
export function safeFraction(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}
