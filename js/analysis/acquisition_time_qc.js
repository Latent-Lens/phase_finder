// Optional time-based acquisition QC.

import { mad, median, quantileSorted } from "./math/stats.js";

// Keep the numerical names visible from the stage module for source-level
// traceability and focused browser tests.
export { mad, median, quantileSorted };

export const DEFAULT_TIMER_RANGE = 32.6824;
export const DEFAULT_TIME_QC_THRESHOLD = 4;

/**
 * Prepare a raw Time/HDR-T channel for acquisition QC while retaining original
 * event indexes.  Timer wraps are unwrapped; unrelated backward jumps begin a
 * new acquisition segment.  An optional input mask limits which indexes enter
 * bins without breaking time continuity across otherwise valid events.
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
    throw new Error("The Stage 1 input mask length does not match Time.");
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

export function calculateBinEventRate(bin, unwrappedTime) {
  if (!bin || bin.indexes.length < 2) return NaN;

  const firstIndex = bin.indexes[0];
  const lastIndex = bin.indexes[bin.indexes.length - 1];
  const duration = unwrappedTime[lastIndex] - unwrappedTime[firstIndex];

  return duration > 0 ? bin.indexes.length / duration : NaN;
}

/** Robust channel summary for a set of original event indexes. */
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

export const TIME_QC_METRICS = Object.freeze({
  medianDNA_A: summary => summary.DNA_A.median,
  iqrDNA_A: summary => summary.DNA_A.iqr,
  medianFSC_A: summary => summary.FSC_A.median,
  iqrFSC_A: summary => summary.FSC_A.iqr,
  medianSSC_A: summary => summary.SSC_A.median,
  iqrSSC_A: summary => summary.SSC_A.iqr,
  eventRate: summary => summary.eventRate,
});

/**
 * Across-bin robust baselines.  Metrics unavailable for every bin are marked
 * inactive instead of turning every bin into an "invalid metric" outlier.
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

export function calculateRobustZ(value, baseline, epsilon = 1e-12) {
  if (!Number.isFinite(value) || !baseline?.active) return NaN;

  const difference = value - baseline.median;
  if (baseline.robustScale > epsilon) {
    return difference / baseline.robustScale;
  }

  if (Math.abs(difference) <= epsilon) return 0;
  return difference > 0 ? Infinity : -Infinity;
}

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

/** Create an original-index mask and optionally seed it from valid/input masks. */
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

/** Complete Stage 1 wrapper used by the pipeline orchestrator. */
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
  const scoring = scoreTimeQCBins(binSummaries, threshold);
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

export const runTimeQualityControl = runTimeQC;
export const stage1TimeQC = runTimeQC;
