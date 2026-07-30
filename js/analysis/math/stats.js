// Shared robust-statistics helpers for the cell-cycle pipeline. This leaf module
// holds the small, dependency-free numeric primitives the QC and modeling code
// leans on: clamp, and the order-statistic / dispersion helpers median, mad,
// mean, variance, and quantileSorted; the accumulators maximumValue and
// sumSquares; robustResidualScale (a floored robust scale for solvers);
// nearestIndex (closest-value lookup); and safeFraction (guarded division).
// Empty samples return NaN rather than throwing, so a missing metric stays
// explicit for the callers that select metrics dynamically (e.g. Time QC).

/*

Purpose:
	Clamps a number to an inclusive interval.

Input:
	value [number]: the value to constrain
	minimum [number]: lower bound
	maximum [number]: upper bound

Output:
	clamped [number]: value limited to [minimum, maximum]

*/
export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

/*

Purpose:
	Median of an Array or typed array. Callers working with partially missing
	observations should filter them first; returning NaN for an empty sample
	makes a missing metric explicit (which Time QC's dynamic metric selection
	relies on).

Input:
	values [array|TypedArray]: the sample

Output:
	median [number]: the median, or NaN when the sample is empty

*/
export function median(values) {
  if (!values || values.length === 0) return NaN;

  const sorted = Array.from(values).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1
    ? sorted[middle]
    : 0.5 * (sorted[middle - 1] + sorted[middle]);
}

/*

Purpose:
	Median absolute deviation about a supplied (or the sample's own) center --
	a robust dispersion measure.

Input:
	values [array|TypedArray]: the sample
	center [number]: the center to deviate about (defaults to the sample median)

Output:
	mad [number]: the MAD, or NaN when the sample is empty or the center is not finite

*/
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

/*

Purpose:
	Arithmetic mean of a sample.

Input:
	values [array|TypedArray]: the sample

Output:
	mean [number]: the mean, or NaN when the sample is empty

*/
export function mean(values) {
  if (!values || values.length === 0) return NaN;

  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/*

Purpose:
	Population variance (divides by N, the convention used by the source
	implementation this was ported from).

Input:
	values [array|TypedArray]: the sample

Output:
	variance [number]: the population variance, or 0 for fewer than two values

*/
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

/*

Purpose:
	Linear-interpolated quantile of an already-sorted sample.

Input:
	sortedValues [array|TypedArray]: values in ascending order
	probability [number]: the quantile in [0, 1] (clamped)

Output:
	quantile [number]: the interpolated quantile, or NaN when the sample is empty

*/
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

/*

Purpose:
	Maximum of a sample without materializing a typed array through the
	Math.max(...values) spread (which overflows the call stack for large arrays).

Input:
	values [array|TypedArray]: the sample

Output:
	maximum [number]: the largest value, or -Infinity when empty

*/
export function maximumValue(values) {
  let maximum = -Infinity;
  for (const value of values ?? []) {
    if (value > maximum) maximum = value;
  }
  return maximum;
}

/*

Purpose:
	Sum of squared values.

Input:
	values [array|TypedArray]: the sample

Output:
	total [number]: the sum of each value squared (0 when empty)

*/
export function sumSquares(values) {
  let total = 0;
  for (const value of values ?? []) total += value * value;
  return total;
}

/*

Purpose:
	Robust residual scale (1.4826 · MAD), floored at a small positive value so
	numerical solvers never divide by zero on a perfect-fit residual set.

Input:
	residuals [array|TypedArray]: fit residuals
	minimumScale [number]: the floor applied to the returned scale

Output:
	scale [number]: max(robust scale, minimumScale)

*/
export function robustResidualScale(residuals, minimumScale = 1e-12) {
  const center = median(residuals);
  if (!Number.isFinite(center)) return minimumScale;

  const scale = 1.4826 * mad(residuals, center);
  return Number.isFinite(scale)
    ? Math.max(scale, minimumScale)
    : minimumScale;
}

/*

Purpose:
	Index of the value closest to a target.

Input:
	values [array|TypedArray]: the sample to search
	target [number]: the value to approach

Output:
	index [number]: index of the nearest value, or -1 when the sample is empty

*/
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

/*

Purpose:
	Guarded division used by reporting code when an area (the denominator) may
	be absent, so a missing total reads as 0 rather than NaN/Infinity.

Input:
	numerator [number]: the dividend
	denominator [number]: the divisor

Output:
	fraction [number]: numerator/denominator, or 0 when denominator <= 0

*/
export function safeFraction(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}
