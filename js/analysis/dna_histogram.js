// Build a masked, linear DNA-content histogram -- the input every cell-cycle
// model fits. collectFiniteRetainedValues() pulls the finite DNA values a
// full-length event mask keeps; collectEligibleDnaValues() additionally enforces
// the MANDATORY linear-DNA invariant (finite AND non-negative) and records what
// it rejected; resolveHistogramRange() picks an explicit or data-derived
// [min, max]; generateHistogram() bins the eligible values into the count arrays
// (x/centers, y/counts, edges) the fitter, peak overlay, and plot layer read.
//
// QC-00: DNA content is a non-negative quantity, so a negative value is not just
// out of range -- it is scientifically ineligible for linear DNA modeling. That
// invariant is enforced HERE, at every histogram build, independent of whether
// the optional Structural QC (Stage 0) toggle happened to be on: model validity
// must not depend on a UI toggle. The counts of rejected non-finite/negative
// events are recorded on the histogram so the model-boundary contract can flag a
// channel that is largely ineligible (e.g. a log/compensated channel picked by
// mistake) rather than silently fitting whatever survived.

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

/*

Purpose:
	Returns the finite DNA values retained by a full-length event mask.

Input:
	dnaValues [array|TypedArray]: per-event DNA values
	finalMask [array|null]: 1 = keep; must match dnaValues.length when supplied

Output:
	retained [array]: the finite, retained DNA values (throws on a length/type
	                  mismatch)

*/
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

/*

Purpose:
	QC-00 mandatory DNA-eligibility filter. Returns the values a full-length event
	mask keeps that are ALSO scientifically eligible for linear DNA modeling --
	finite and non-negative -- plus a tally of what was rejected and why, with the
	original event indexes still respected (masked-out events are never counted as
	rejected; only kept-but-ineligible events are). Enforced on every histogram
	build regardless of any optional QC stage.

Input:
	dnaValues [array|TypedArray]: per-event DNA values
	finalMask [array|null]: 1 = keep; must match dnaValues.length when supplied

Output:
	result [object]: { eligible [array], maskRetained [number] (events the mask
	                 kept), rejectedNonfinite [number], rejectedNegative [number] }
	                 (throws on a length/type mismatch)

*/
function saturation_ceiling(metadata) {
  const datatype = String(metadata?.datatype ?? "").toUpperCase();
  const bits = Number(metadata?.bits);
  const range = Number(metadata?.range);
  const amplification = String(metadata?.amplification || "0,0").split(",").map(Number);
  const gain = Number(metadata?.gain ?? 1);
  if (!Number.isFinite(range) || range <= 0
      || amplification.length !== 2 || amplification.some((value) => !Number.isFinite(value))
      || amplification[0] !== 0 || gain !== 1) return null;
  if (datatype === "F" || datatype === "D") return range;
  if (datatype !== "I" || !Number.isInteger(bits) || bits < 1 || bits > 53) return null;
  return Math.min(range, 2 ** bits);
}

export function collectEligibleDnaValues(dnaValues, finalMask = null, metadata = null) {
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

  const eligible = [];
  let maskRetained = 0;
  let rejectedNonfinite = 0;
  let rejectedNegative = 0;
  let rejectedSaturated = 0;
  const saturationCeiling = saturation_ceiling(metadata);
  for (let eventIndex = 0; eventIndex < dnaValues.length; eventIndex += 1) {
    if (finalMask != null && finalMask[eventIndex] !== 1) continue;
    maskRetained += 1;
    const value = dnaValues[eventIndex];
    if (!Number.isFinite(value)) {
      rejectedNonfinite += 1;
      continue;
    }
    if (value < 0) {
      rejectedNegative += 1;
      continue;
    }
    if (saturationCeiling != null && value >= saturationCeiling) {
      rejectedSaturated += 1;
      continue;
    }
    eligible.push(value);
  }
  return { eligible, maskRetained, rejectedNonfinite, rejectedNegative, rejectedSaturated, saturationCeiling };
}

/*

Purpose:
	Resolves the histogram [min, max]: uses explicitly supplied bounds where
	given, otherwise derives them from the data, and widens a degenerate
	all-equal range so a valid positive span always results.

Input:
	retainedValues [array]: the finite retained values
	options [object]: { range: [min, max] } or { min, max }

Output:
	range [array]: [min, max] (throws when unresolvable or non-finite)

*/
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

/*

Purpose:
	Builds the masked histogram from index-aligned DNA values and a final mask.
	Values exactly at max go in the final bin; values outside an explicitly
	supplied range are excluded from binning but counted as underflow/overflow, so
	underflow + binnedCount + overflow === retainedCount always holds. The x/
	centers, y/counts, and edges are plain arrays for the fitter, peak overlay,
	and plot layer. options.dnaChannel is purely descriptive and echoed back.

Input:
	dnaValues [array|TypedArray]: per-event DNA values
	finalMask [array|object|null]: the event mask, or an options object
	options [object|number]: { binCount, range|min|max, dnaChannel } (or binCount)
	minimum [number|array|null]: legacy positional min (or a [min, max] range)
	maximum [number|null]: legacy positional max

Output:
	histogram [object]: { x, y, counts, centers, edges, min, max, binWidth,
	                    binCount, retainedCount, binnedCount, underflow, overflow,
	                    totalEvents, dnaChannel, scale }

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
  // QC-00: the mandatory finite + non-negative DNA filter runs on every build,
  // so negative/non-finite DNA can never be binned even when Structural QC is off.
  const eligibility = collectEligibleDnaValues(dnaValues, normalized.finalMask, settings.dnaMetadata);
  const retainedValues = eligibility.eligible;

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
    // QC-00 provenance: how many mask-kept events reached the eligibility gate,
    // and how many were rejected as non-finite or negative DNA. The model-
    // boundary contract reads these to block a largely-ineligible channel.
    maskRetainedCount: eligibility.maskRetained,
    rejectedNonfinite: eligibility.rejectedNonfinite,
    rejectedNegative: eligibility.rejectedNegative,
    rejectedSaturated: eligibility.rejectedSaturated,
    saturationCeiling: eligibility.saturationCeiling,
    dnaMetadata: settings.dnaMetadata ? { ...settings.dnaMetadata } : null,
    dnaChannel: settings.dnaChannel ?? null,
    scale: "linear",
  };
}

export { DEFAULT_BIN_COUNT };
