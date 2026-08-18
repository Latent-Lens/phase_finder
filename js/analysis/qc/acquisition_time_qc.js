// Optional time-based acquisition QC -- the robust-summary Time QC method. Bins a
// sample's events along acquisition time and rejects whole time windows whose
// channel medians/IQRs or event rate drift far from the run's robust baseline,
// catching clogs, bubbles, and fluidics instability. prepareTimeQCBins() unwraps
// the timer and cuts near-equal bins per acquisition segment;
// calculateBinEventRate(), summarizeChannel(), and summarizeTimeQCBins() describe
// each bin; calculateMetricBaselines(), calculateRobustZ(), and scoreTimeQCBins()
// flag drifting bins; mergeFlaggedBins() groups them into intervals;
// createTimeQCMask() turns flagged bins into an original-event-index mask;
// runTimeQC() (alias runTimeQualityControl) is the orchestrator entry point. The
// peak-tracking Time QC method lives in peak_tracking_time_qc.js; both satisfy
// the same Time QC result contract.

import { mad, median, quantileSorted } from "../math/stats.js";

// Keep the numerical helpers visible from this module for source-level
// traceability and focused browser tests.
export { mad, median, quantileSorted };

export const DEFAULT_TIMER_RANGE = 32.6824;
export const DEFAULT_TIME_QC_THRESHOLD = 4;

// The robust-summary method's algorithm version and canonical effective options.
// This is the single source of truth for the analysis-affecting robust-summary
// settings, so the Time QC cache key (QC-02) can resolve and hash the full config
// rather than cherry-picking fields -- which is how includeEventRateCheck was
// omitted from the key before.
export const ROBUST_SUMMARY_ALGORITHM_VERSION = "robust-summary-v2";
export const DEFAULT_ROBUST_SUMMARY_OPTIONS = Object.freeze({
  targetBinSize: 500,
  threshold: DEFAULT_TIME_QC_THRESHOLD,
  includeEventRateCheck: true,
});

// QC-03: below this bin count there is not enough of an acquisition to form a
// robust across-bin baseline, so the run is reported not-evaluable (no removal)
// rather than as a confident pass. A metric whose robust scale is at or below
// this epsilon is degenerate (zero MAD) and cannot discriminate outliers, so it
// qualifies the run as limited reliability.
const MIN_EVALUABLE_TIME_QC_BINS = 3;
const ROBUST_SCALE_EPSILON = 1e-12;

/*

Purpose:
	Prepares a raw Time/HDR-T channel for acquisition QC while retaining original
	event indexes: unwraps timer wraps, starts a new acquisition segment on an
	unrelated backward jump, then cuts each segment into near-equal bins. An
	optional input mask limits which indexes enter bins without breaking time
	continuity across otherwise valid events.

Input:
	rawTime [array]: the raw Time channel
	options [object]: { timerRange, targetBinSize, wrapHighFraction,
	                  wrapLowFraction, backwardTolerance, inputMask }

Output:
	prepared [object]: { validTimeMask, rawTimeValidityMask, unwrappedTime,
	                   segmentId, bins, segmentCount, timerRange, targetBinSize }

*/
export function prepareTimeQCBins(
  rawTime,
  {
    timerRange = DEFAULT_TIMER_RANGE,
    targetBinSize = 500,
    wrapHighFraction = 0.8,
    wrapLowFraction = 0.2,
    backwardTolerance = 1e-6,
    inputMask = null,
  } = {},
) {
  if (!rawTime || typeof rawTime.length !== "number") {
    throw new Error("A Time channel is required.");
  }

  const eventCount = rawTime.length;
  if (inputMask && inputMask.length !== eventCount) {
    throw new Error("The input mask length does not match Time.");
  }

  const effectiveTimerRange = Number.isFinite(timerRange) && timerRange > 0
    ? timerRange
    : DEFAULT_TIMER_RANGE;
  const effectiveTargetBinSize = Number.isFinite(targetBinSize) && targetBinSize > 0
    ? targetBinSize
    : 500;

  const validTimeMask = new Uint8Array(eventCount);
  const rawTimeValidityMask = new Uint8Array(eventCount);
  const unwrappedTime = new Float64Array(eventCount);
  const segmentId = new Int32Array(eventCount);

  unwrappedTime.fill(NaN);
  segmentId.fill(-1);

  let currentSegment = -1;
  let previousRawTime = null;
  let previousUnwrappedTime = null;
  let offset = 0;

  for (let eventIndex = 0; eventIndex < eventCount; eventIndex++) {
    const currentRawTime = rawTime[eventIndex];

    if (!Number.isFinite(currentRawTime) || currentRawTime < 0) {
      // Never calculate an interval across an invalid Time observation.
      previousRawTime = null;
      previousUnwrappedTime = null;
      offset = 0;
      continue;
    }

    rawTimeValidityMask[eventIndex] = 1;

    if (previousRawTime === null) {
      currentSegment++;
      offset = 0;
      segmentId[eventIndex] = currentSegment;
      unwrappedTime[eventIndex] = currentRawTime;
      previousRawTime = currentRawTime;
      previousUnwrappedTime = currentRawTime;
      validTimeMask[eventIndex] =
        !inputMask || inputMask[eventIndex] === 1 ? 1 : 0;
      continue;
    }

    const movedBackward =
      currentRawTime < previousRawTime - backwardTolerance;

    if (movedBackward) {
      const likelyWrap =
        previousRawTime > wrapHighFraction * effectiveTimerRange &&
        currentRawTime < wrapLowFraction * effectiveTimerRange;

      if (likelyWrap) {
        offset += effectiveTimerRange;
      } else {
        currentSegment++;
        offset = 0;
      }
    }

    let currentUnwrappedTime = currentRawTime + offset;
    const previousIndexInSameSegment =
      eventIndex > 0 && segmentId[eventIndex - 1] === currentSegment;

    // Clamp tiny movements that fall within the tolerance to one timestamp.
    if (
      previousIndexInSameSegment &&
      currentUnwrappedTime < previousUnwrappedTime
    ) {
      currentUnwrappedTime = previousUnwrappedTime;
    }

    segmentId[eventIndex] = currentSegment;
    unwrappedTime[eventIndex] = currentUnwrappedTime;
    validTimeMask[eventIndex] =
      !inputMask || inputMask[eventIndex] === 1 ? 1 : 0;

    previousRawTime = currentRawTime;
    previousUnwrappedTime = currentUnwrappedTime;
  }

  const indexesBySegment = new Map();

  for (let eventIndex = 0; eventIndex < eventCount; eventIndex++) {
    if (validTimeMask[eventIndex] === 0) continue;
    const id = segmentId[eventIndex];
    if (id < 0) continue;

    if (!indexesBySegment.has(id)) indexesBySegment.set(id, []);
    indexesBySegment.get(id).push(eventIndex);
  }

  // Build near-equal bins inside each segment; floor boundaries spread the
  // remainder instead of leaving one undersized terminal bin.
  const bins = [];

  for (const [id, indexes] of indexesBySegment) {
    const binCount = Math.max(
      1,
      Math.round(indexes.length / effectiveTargetBinSize),
    );

    for (let binNumber = 0; binNumber < binCount; binNumber++) {
      const start = Math.floor((binNumber * indexes.length) / binCount);
      const end = Math.floor(((binNumber + 1) * indexes.length) / binCount);
      const binIndexes = indexes.slice(start, end);
      if (binIndexes.length === 0) continue;

      bins.push({
        segmentId: id,
        binNumber,
        indexes: binIndexes,
        size: binIndexes.length,
        firstEventIndex: binIndexes[0],
        lastEventIndex: binIndexes[binIndexes.length - 1],
        limitedReliability:
          binIndexes.length < effectiveTargetBinSize / 2,
      });
    }
  }

  return {
    validTimeMask,
    rawTimeValidityMask,
    unwrappedTime,
    segmentId,
    bins,
    segmentCount: indexesBySegment.size,
    timerRange: effectiveTimerRange,
    targetBinSize: effectiveTargetBinSize,
  };
}

/*

Purpose:
	Events-per-time-unit for one bin, from its first to last event's unwrapped
	time.

Input:
	bin [object]: a bin from prepareTimeQCBins
	unwrappedTime [array]: the unwrapped time per event

Output:
	rate [number]: the bin's event rate (NaN for < 2 events or zero duration)

*/
export function calculateBinEventRate(bin, unwrappedTime) {
  if (!bin || bin.indexes.length < 2) return NaN;

  const firstIndex = bin.indexes[0];
  const lastIndex = bin.indexes[bin.indexes.length - 1];
  const duration = unwrappedTime[lastIndex] - unwrappedTime[firstIndex];

  // n timestamps span n-1 inter-event intervals across `duration`, so the rate
  // is (n-1)/duration, not n/duration (audit SCI-12). The naive n/duration form
  // biases every bin's rate slightly high, most visibly on short bins.
  return duration > 0 ? (bin.indexes.length - 1) / duration : NaN;
}

/*

Purpose:
	Robust summary (median, quartiles, IQR, count) of one channel's finite values
	over a set of original event indexes.

Input:
	channelValues [array]: the channel to summarize
	eventIndexes [array]: the original event indexes to include

Output:
	summary [object]: { median, q1, q3, iqr, n }

*/
export function summarizeChannel(channelValues, eventIndexes) {
  if (!channelValues) {
    return { median: NaN, q1: NaN, q3: NaN, iqr: NaN, n: 0 };
  }

  const values = [];
  for (const eventIndex of eventIndexes) {
    const value = channelValues[eventIndex];
    if (Number.isFinite(value)) values.push(value);
  }

  if (values.length === 0) {
    return { median: NaN, q1: NaN, q3: NaN, iqr: NaN, n: 0 };
  }

  values.sort((a, b) => a - b);
  const q1 = quantileSorted(values, 0.25);
  const center = quantileSorted(values, 0.5);
  const q3 = quantileSorted(values, 0.75);

  return { median: center, q1, q3, iqr: q3 - q1, n: values.length };
}

/*

Purpose:
	Builds the per-bin summary rows (DNA/scatter channel summaries plus event
	rate) that the scoring step compares against the across-bin baselines.

Input:
	bins [array]: bins from prepareTimeQCBins
	channels [object]: the sample channels (reads DNA_A, FSC_A, SSC_A)
	unwrappedTime [array|null]: unwrapped time, for the event-rate metric

Output:
	summaries [array]: one summary row per bin

*/
export function summarizeTimeQCBins(bins, channels, unwrappedTime = null) {
  return bins.map((bin, binIndex) => ({
    binIndex,
    segmentId: bin.segmentId,
    binNumber: bin.binNumber,
    eventCount: bin.indexes.length,
    DNA_A: summarizeChannel(channels?.DNA_A, bin.indexes),
    FSC_A: summarizeChannel(channels?.FSC_A, bin.indexes),
    SSC_A: summarizeChannel(channels?.SSC_A, bin.indexes),
    eventRate: unwrappedTime
      ? calculateBinEventRate(bin, unwrappedTime)
      : NaN,
  }));
}

// The metrics compared across bins: each maps a bin summary to a single number.
export const TIME_QC_METRICS = Object.freeze({
  medianDNA_A: summary => summary.DNA_A.median,
  iqrDNA_A: summary => summary.DNA_A.iqr,
  medianFSC_A: summary => summary.FSC_A.median,
  iqrFSC_A: summary => summary.FSC_A.iqr,
  medianSSC_A: summary => summary.SSC_A.median,
  iqrSSC_A: summary => summary.SSC_A.iqr,
  eventRate: summary => summary.eventRate,
});

/*

Purpose:
	Across-bin robust baseline (median + MAD-scaled spread) for each metric. A
	metric that isn't finite for every bin is marked inactive rather than turning
	every bin into an "invalid metric" outlier.

Input:
	binSummaries [array]: rows from summarizeTimeQCBins
	metrics [object]: metric name -> accessor (defaults to TIME_QC_METRICS)

Output:
	baselines [object]: metric name -> { median, mad, robustScale, validBinCount,
	                    active }

*/
export function calculateMetricBaselines(
  binSummaries,
  metrics = TIME_QC_METRICS,
) {
  const baselines = {};

  for (const [metricName, getValue] of Object.entries(metrics)) {
    const values = binSummaries.map(getValue).filter(Number.isFinite);
    const center = median(values);
    const metricMAD = mad(values, center);
    const robustScale = 1.4826 * metricMAD;

    baselines[metricName] = {
      median: center,
      mad: metricMAD,
      robustScale,
      validBinCount: values.length,
      active:
        values.length > 0 &&
        Number.isFinite(center) &&
        Number.isFinite(robustScale),
    };
  }

  return baselines;
}

/*

Purpose:
	Robust z-score of a value against a metric baseline. When the robust scale is
	effectively zero, returns 0 for an on-baseline value and +/-Infinity for any
	departure.

Input:
	value [number]: the bin's metric value
	baseline [object]: a baseline from calculateMetricBaselines
	epsilon [number]: the zero-scale tolerance

Output:
	z [number]: the robust z-score (NaN when the value or baseline is unusable)

*/
export function calculateRobustZ(value, baseline, epsilon = 1e-12) {
  if (!Number.isFinite(value) || !baseline?.active) return NaN;

  const difference = value - baseline.median;
  if (baseline.robustScale > epsilon) {
    return difference / baseline.robustScale;
  }

  if (Math.abs(difference) <= epsilon) return 0;
  return difference > 0 ? Infinity : -Infinity;
}

/*

Purpose:
	Scores every bin: computes each active metric's robust z-score, flags a bin
	when any |z| exceeds the threshold, and records which metrics drove the flag.

Input:
	binSummaries [array]: rows from summarizeTimeQCBins
	threshold [number]: the |z| flagging threshold
	metrics [object]: metric name -> accessor

Output:
	scoring [object]: { baselines, scoredBins, activeMetrics, excludedMetrics }

*/
export function scoreTimeQCBins(
  binSummaries,
  threshold = DEFAULT_TIME_QC_THRESHOLD,
  metrics = TIME_QC_METRICS,
) {
  const baselines = calculateMetricBaselines(binSummaries, metrics);
  const activeMetrics = Object.keys(metrics).filter(
    metricName => baselines[metricName].active,
  );
  const excludedMetrics = Object.keys(metrics).filter(
    metricName => !baselines[metricName].active,
  );

  const scoredBins = binSummaries.map(summary => {
    const zScores = {};
    const reasons = [];
    let maximumAbsoluteZ = 0;

    for (const [metricName, getValue] of Object.entries(metrics)) {
      const baseline = baselines[metricName];
      if (!baseline.active) {
        zScores[metricName] = NaN;
        continue;
      }

      const z = calculateRobustZ(getValue(summary), baseline);
      zScores[metricName] = z;

      // A partially non-finite metric is unavailable for this bin, not itself
      // evidence of an acquisition anomaly. Structural QC handles bad events.
      if (Number.isNaN(z)) continue;

      const absoluteZ = Math.abs(z);
      maximumAbsoluteZ = Math.max(maximumAbsoluteZ, absoluteZ);
      if (absoluteZ > threshold) reasons.push(metricName);
    }

    return {
      ...summary,
      zScores,
      score: maximumAbsoluteZ,
      flagged: reasons.length > 0,
      reasons,
    };
  });

  return { baselines, scoredBins, activeMetrics, excludedMetrics };
}

/*

Purpose:
	Merges adjacent flagged bins within the same acquisition segment into
	contiguous intervals (for reporting and overlays), unioning their reasons.

Input:
	scoredBins [array]: scored bins from scoreTimeQCBins
	bins [array]: the bins from prepareTimeQCBins

Output:
	intervals [array]: [{ segmentId, firstBinNumber, lastBinNumber,
	                  firstEventIndex, lastEventIndex, binIndexes, reasons }]

*/
export function mergeFlaggedBins(scoredBins, bins) {
  const flagged = scoredBins
    .filter(result => result.flagged)
    .sort((a, b) =>
      a.segmentId - b.segmentId || a.binNumber - b.binNumber,
    );
  const intervals = [];

  for (const result of flagged) {
    const bin = bins[result.binIndex];
    const previousInterval = intervals.at(-1);
    const isAdjacent =
      previousInterval &&
      previousInterval.segmentId === result.segmentId &&
      result.binNumber === previousInterval.lastBinNumber + 1;

    if (isAdjacent) {
      previousInterval.lastBinNumber = result.binNumber;
      previousInterval.lastEventIndex = bin.lastEventIndex;
      previousInterval.binIndexes.push(result.binIndex);
      previousInterval.reasons.push(...result.reasons);
    } else {
      intervals.push({
        segmentId: result.segmentId,
        firstBinNumber: result.binNumber,
        lastBinNumber: result.binNumber,
        firstEventIndex: bin.firstEventIndex,
        lastEventIndex: bin.lastEventIndex,
        binIndexes: [result.binIndex],
        reasons: [...result.reasons],
      });
    }
  }

  for (const interval of intervals) {
    interval.reasons = [...new Set(interval.reasons)];
  }

  return intervals;
}

/*

Purpose:
	Builds the original-event-index Time QC mask: starts from the valid-time and
	input masks, then drops every event that falls in a flagged bin.

Input:
	eventCount [number]: total event count
	scoredBins [array]: scored bins from scoreTimeQCBins
	bins [array]: bins from prepareTimeQCBins
	validTimeMask [array|null]: the valid-time mask from prepareTimeQCBins
	inputMask [array|null]: an upstream (e.g. structural) mask

Output:
	mask [Uint8Array]: 1 = retained, 0 = rejected

*/
export function createTimeQCMask(
  eventCount,
  scoredBins,
  bins,
  validTimeMask = null,
  inputMask = null,
) {
  const mask = new Uint8Array(eventCount);

  for (let eventIndex = 0; eventIndex < eventCount; eventIndex++) {
    mask[eventIndex] =
      (!validTimeMask || validTimeMask[eventIndex] === 1) &&
      (!inputMask || inputMask[eventIndex] === 1)
        ? 1
        : 0;
  }

  for (const result of scoredBins) {
    if (!result.flagged) continue;
    for (const eventIndex of bins[result.binIndex].indexes) {
      mask[eventIndex] = 0;
    }
  }

  return mask;
}

/*

Purpose:
	Normalizes runTimeQC's overloaded signature: the second argument may be a
	structural mask or an options object, so this returns a consistent
	{ structuralMask, options } (falling back to dataset.masks.structural).

Input:
	dataset [object]: row.data
	structuralMaskOrOptions [array|object|null]: a mask or an options object
	options [object]: options when the second argument was a mask

Output:
	resolved [object]: { structuralMask, options }

*/
function resolveRunArguments(dataset, structuralMaskOrOptions, options) {
  const looksLikeMask =
    Array.isArray(structuralMaskOrOptions) ||
    ArrayBuffer.isView(structuralMaskOrOptions);

  if (looksLikeMask) {
    return {
      structuralMask: structuralMaskOrOptions,
      options: options ?? {},
    };
  }

  const resolvedOptions = structuralMaskOrOptions ?? options ?? {};
  return {
    structuralMask:
      resolvedOptions.structuralMask ?? dataset?.masks?.structural ?? null,
    options: resolvedOptions,
  };
}

/*

Purpose:
	The complete robust-summary Time QC entry point used by the pipeline
	orchestrator: prepares bins, summarizes them, scores against baselines, merges
	flagged intervals, and builds the mask -- skipping (with a reason) when the
	sample has no Time channel.

Input:
	dataset [object]: row.data
	structuralMaskOrOptions [array|object|null]: a structural mask or options
	options [object]: options when the second argument was a mask

Output:
	result [object]: the Time QC result contract (mask/timeQCMask, retained/rejected
	                 counts, bins, scoring, flaggedIntervals, skipped, ...)

*/
export function runTimeQC(
  dataset,
  structuralMaskOrOptions = null,
  options = {},
) {
  const channels = dataset?.channels ?? dataset;
  const rawTime = channels?.Time;

  if (!rawTime) {
    return {
      skipped: true,
      reason: "no Time channel",
      status: "time QC skipped",
      mask: null,
      timeQCMask: null,
    };
  }

  const { structuralMask, options: resolvedOptions } = resolveRunArguments(
    dataset,
    structuralMaskOrOptions,
    options,
  );
  const eventCount = dataset?.eventCount ?? rawTime.length;

  if (rawTime.length !== eventCount) {
    throw new Error("Time channel length does not match the event count.");
  }
  if (structuralMask && structuralMask.length !== eventCount) {
    throw new Error("Structural mask length does not match the event count.");
  }

  const configuredRange = resolvedOptions.timerRange;
  const pnrRange = Number(dataset?.pnr?.Time);
  const timerRange = Number.isFinite(configuredRange) && configuredRange > 0
    ? configuredRange
    : Number.isFinite(pnrRange) && pnrRange > 0
      ? pnrRange
      : DEFAULT_TIMER_RANGE;

  const prepared = prepareTimeQCBins(rawTime, {
    ...resolvedOptions,
    timerRange,
    inputMask: structuralMask,
  });
  const binSummaries = summarizeTimeQCBins(
    prepared.bins,
    channels,
    prepared.unwrappedTime,
  );
  const threshold = resolvedOptions.threshold ?? DEFAULT_TIME_QC_THRESHOLD;

  // QC-03: event-rate scoring runs ONLY when its own toggle is on, so a disabled
  // event-rate check cannot flag bins. The dropped metric is recorded.
  const includeEventRate = resolvedOptions.includeEventRateCheck !== false;
  const scoringMetrics = includeEventRate
    ? TIME_QC_METRICS
    : Object.fromEntries(Object.entries(TIME_QC_METRICS).filter(([name]) => name !== "eventRate"));
  const disabledMetrics = includeEventRate ? [] : ["eventRate"];

  const scoring = scoreTimeQCBins(binSummaries, threshold, scoringMetrics);

  // QC-03 coverage + reliability. A run with no metric able to form a baseline, or
  // with too few acquisition bins, is not evaluable: report it as such WITHOUT
  // removing any events (fail-safe) rather than as a confident pass. A pooled
  // multi-segment baseline (see segmentCount), a degenerate zero-MAD active
  // metric, or a mostly small-bin (limited-reliability) acquisition qualify the
  // run as limited reliability, which the model boundary (QC-01) maps to a
  // "degraded" outcome instead of a confident result.
  const binCount = prepared.bins.length;
  const limitedReliabilityBinCount = prepared.bins.filter((bin) => bin.limitedReliability).length;
  const degenerateMetrics = scoring.activeMetrics.filter(
    (name) => !(scoring.baselines[name].robustScale > ROBUST_SCALE_EPSILON),
  );
  const notEvaluable = scoring.activeMetrics.length === 0 || binCount < MIN_EVALUABLE_TIME_QC_BINS;
  const limitedReliability = notEvaluable
    || prepared.segmentCount > 1
    || degenerateMetrics.length > 0
    || (binCount > 0 && limitedReliabilityBinCount / binCount > 0.5);

  const coverage = {
    disabledMetrics,
    degenerateMetrics,
    binCount,
    limitedReliabilityBinCount,
    limitedReliability,
    notEvaluable,
  };

  if (notEvaluable) {
    // Keep every valid, structurally-retained event (no flag-driven removal).
    const passthroughScored = scoring.scoredBins.map((bin) => ({ ...bin, flagged: false, reasons: [] }));
    const passthroughMask = createTimeQCMask(eventCount, passthroughScored, prepared.bins, prepared.validTimeMask, structuralMask);
    let passRetained = 0;
    for (const retained of passthroughMask) passRetained += retained;
    return {
      ...prepared,
      ...scoring,
      ...coverage,
      skipped: false,
      status: "time QC not evaluable",
      reason: scoring.activeMetrics.length === 0
        ? "No Time QC metric could form a stable baseline; no events were removed."
        : `Only ${binCount} acquisition bin${binCount === 1 ? "" : "s"} — too few to evaluate; no events were removed.`,
      threshold,
      rawTime,
      binSummaries,
      flaggedIntervals: [],
      timeQCMask: passthroughMask,
      mask: passthroughMask,
      retainedEventCount: passRetained,
      rejectedEventCount: eventCount - passRetained,
    };
  }

  const flaggedIntervals = mergeFlaggedBins(
    scoring.scoredBins,
    prepared.bins,
  );
  const timeQCMask = createTimeQCMask(
    eventCount,
    scoring.scoredBins,
    prepared.bins,
    prepared.validTimeMask,
    structuralMask,
  );

  let retainedEventCount = 0;
  for (const retained of timeQCMask) retainedEventCount += retained;

  return {
    ...prepared,
    ...scoring,
    ...coverage,
    skipped: false,
    status: "time QC complete",
    reason: null,
    threshold,
    rawTime,
    binSummaries,
    flaggedIntervals,
    timeQCMask,
    mask: timeQCMask,
    retainedEventCount,
    rejectedEventCount: eventCount - retainedEventCount,
  };
}

// Source-compatible alias for runTimeQC.
export const runTimeQualityControl = runTimeQC;
