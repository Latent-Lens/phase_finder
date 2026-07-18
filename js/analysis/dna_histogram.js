// Build a masked, linear DNA-content histogram.

const DEFAULT_BIN_COUNT = 512;

function isArrayLike(value) {
  return value != null &&
    typeof value !== "string" &&
    Number.isInteger(value.length) &&
    value.length >= 0;
}

function normalizeArguments(finalMask, options, minimum, maximum) {
  if (
    finalMask != null &&
    !isArrayLike(finalMask) &&
    typeof finalMask === "object"
  ) {
    return {
      finalMask: finalMask.finalMask ?? finalMask.mask ?? null,
      options: finalMask,
    };
  }

  return {
    finalMask,
    options:
      typeof options === "number"
        ? (
            isArrayLike(minimum) && minimum.length === 2
              ? { binCount: options, range: minimum }
              : {
                  binCount: options,
                  ...(minimum != null ? { min: minimum } : {}),
                  ...(maximum != null ? { max: maximum } : {}),
                }
          )
        : (options ?? {}),
  };
}

/** Return the finite DNA values retained by a full-length event mask. */
export function collectFiniteRetainedValues(dnaValues, finalMask = null) {
  if (!isArrayLike(dnaValues)) {
    throw new TypeError("dnaValues must be an array or typed array.");
  }
  if (finalMask != null) {
    if (!isArrayLike(finalMask)) {
      throw new TypeError("finalMask must be a Uint8Array or another array-like mask.");
    }
    if (finalMask.length !== dnaValues.length) {
      throw new RangeError("finalMask.length must equal dnaValues.length.");
    }
  }

  const retained = [];
  for (let eventIndex = 0; eventIndex < dnaValues.length; eventIndex += 1) {
    if (finalMask != null && finalMask[eventIndex] !== 1) continue;
    const value = dnaValues[eventIndex];
    if (Number.isFinite(value)) retained.push(value);
  }
  return retained;
}

/** Resolve an explicit or data-derived finite histogram range. */
export function resolveHistogramRange(retainedValues, options = {}) {
  const suppliedRange = options.range;
  if (suppliedRange != null && (!isArrayLike(suppliedRange) || suppliedRange.length !== 2)) {
    throw new TypeError("range must contain exactly [min, max].");
  }

  let minimum = suppliedRange != null ? suppliedRange[0] : options.min;
  let maximum = suppliedRange != null ? suppliedRange[1] : options.max;
  const minimumWasSupplied = minimum != null;
  const maximumWasSupplied = maximum != null;

  if (!minimumWasSupplied || !maximumWasSupplied) {
    if (!retainedValues.length) {
      throw new RangeError("No finite retained DNA values are available for a histogram.");
    }

    let dataMinimum = Infinity;
    let dataMaximum = -Infinity;
    for (const value of retainedValues) {
      dataMinimum = Math.min(dataMinimum, value);
      dataMaximum = Math.max(dataMaximum, value);
    }
    if (!minimumWasSupplied) minimum = dataMinimum;
    if (!maximumWasSupplied) maximum = dataMaximum;
  }

  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
    throw new RangeError("Histogram min and max must be finite.");
  }

  if (!(maximum > minimum)) {
    if (!minimumWasSupplied && !maximumWasSupplied && maximum === minimum) {
      const span = Math.max(Math.abs(minimum) * 1e-6, 1);
      minimum -= span / 2;
      maximum += span / 2;
    } else {
      throw new RangeError("Histogram max must be greater than min.");
    }
  }

  return [minimum, maximum];
}

/**
 * Generate Stage 4's histogram from index-aligned DNA values and final mask.
 *
 * Exact values at `max` are assigned to the final bin. Values below/above an
 * explicitly supplied range are excluded from binning but counted separately
 * as `underflow`/`overflow`, so `underflow + binnedCount + overflow ===
 * retainedCount` always holds. `x`/`centers`, `y`/`counts`, and `edges` are
 * plain arrays so they can pass directly to the fitter, peak-region overlay,
 * and plot layer. `options.dnaChannel` is purely descriptive and echoed back
 * on the result; this module has no row/pipeline concept of its own.
 */
export function generateHistogram(
  dnaValues,
  finalMask = null,
  options = {},
  minimum = null,
  maximum = null,
) {
  const normalized = normalizeArguments(finalMask, options, minimum, maximum);
  const settings = normalized.options;
  const retainedValues = collectFiniteRetainedValues(
    dnaValues,
    normalized.finalMask,
  );

  const binCount = settings.binCount ?? DEFAULT_BIN_COUNT;
  if (!Number.isInteger(binCount) || binCount < 1) {
    throw new RangeError("binCount must be a positive integer.");
  }

  const [min, max] = resolveHistogramRange(retainedValues, settings);
  const binWidth = (max - min) / binCount;
  if (!(binWidth > 0) || !Number.isFinite(binWidth)) {
    throw new RangeError("Histogram range and binCount must produce a finite positive bin width.");
  }
  const y = new Array(binCount).fill(0);
  let binnedCount = 0;
  let underflow = 0;
  let overflow = 0;

  for (const value of retainedValues) {
    if (value < min) { underflow += 1; continue; }
    if (value > max) { overflow += 1; continue; }

    // value is in [min, max], so this is always within [0, binCount - 1].
    const binIndex = value === max
      ? binCount - 1
      : Math.min(binCount - 1, Math.floor((value - min) / binWidth));

    y[binIndex] += 1;
    binnedCount += 1;
  }

  const x = Array.from(
    { length: binCount },
    (_, bin) => min + (bin + 0.5) * binWidth,
  );
  const edges = Array.from(
    { length: binCount + 1 },
    (_, index) => min + index * binWidth,
  );

  return {
    x,
    y,
    counts: y,
    centers: x,
    edges,
    min,
    max,
    binWidth,
    binCount,
    retainedCount: retainedValues.length,
    binnedCount,
    underflow,
    overflow,
    totalEvents: dnaValues.length,
    dnaChannel: settings.dnaChannel ?? null,
    scale: "linear",
  };
}

export { DEFAULT_BIN_COUNT };
