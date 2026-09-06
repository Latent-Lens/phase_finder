#!/usr/bin/env python3
"""Boundary, validation, and option-contract tests for DJF Stages 0–8."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / DJF Stage Edges"


_STAGE_EDGES = r"""() => {
  const pipeline = window.PhaseFinder.pipeline;
  const { structuralQc, timeQc, cellGate, singletGate, dnaHistogram } = pipeline;
  const results = [];
  const push = (name, pass, detail = '') => results.push({
    name, pass: Boolean(pass), detail: String(detail ?? ''),
  });
  const run = (name, test) => {
    try {
      const outcome = test();
      push(name, outcome.pass, outcome.detail);
    } catch (error) {
      push(name, false, `${error.name}: ${error.message}`);
    }
  };
  const close = (left, right, tolerance = 1e-9) =>
    Math.abs(left - right) <= tolerance;
  const throws = (callback, pattern = null) => {
    try {
      callback();
      return false;
    } catch (error) {
      return pattern == null || pattern.test(error.message);
    }
  };

  // ---- Stage 0 -----------------------------------------------------------
  run('Stage 0 edge: explicit PnR override controls bounded channels only', () => {
    const dataset = {
      eventCount: 3,
      channels: {
        DNA_A: Float64Array.from([9, 10, 11]),
        Time: Float64Array.from([0, 1000, 100000]),
      },
      pnr: { DNA_A: 100, Time: 1 },
    };
    const mask = structuralQc.createStructuralValidityMask(dataset, { DNA_A: 10, Time: 1 });
    return { pass: Array.from(mask).join('') === '100', detail: Array.from(mask).join('') };
  });

  run('Stage 0 edge: mismatched loaded channel lengths fail clearly', () => {
    const failed = throws(() => structuralQc.createStructuralValidityMask({
      eventCount: 3,
      channels: { DNA_A: [1, 2, 3], DNA_H: [1, 2] },
      pnr: {},
    }), /lengths do not match/);
    return { pass: failed, detail: `failed=${failed}` };
  });

  run('Stage 0 edge: at least one loaded channel is required', () => {
    const failed = throws(
      () => structuralQc.createStructuralValidityMask({ eventCount: 0, channels: {}, pnr: {} }),
      /at least one loaded channel/,
    );
    return { pass: failed, detail: `failed=${failed}` };
  });

  // ---- Stage 1 -----------------------------------------------------------
  run('Stage 1 edge: invalid Time values split acquisition segments and remain masked', () => {
    const prepared = timeQc.prepareTimeQCBins(
      Float64Array.from([0, 1, NaN, 2, 3, -1, 4]),
      { targetBinSize: 10, timerRange: 100 },
    );
    return {
      pass: Array.from(prepared.rawTimeValidityMask).join('') === '1101101'
        && Array.from(prepared.segmentId).join(',') === '0,0,-1,1,1,-1,2'
        && prepared.segmentCount === 3,
      detail: JSON.stringify({
        valid: Array.from(prepared.rawTimeValidityMask),
        segments: Array.from(prepared.segmentId),
      }),
    };
  });

  run('Stage 1 edge: balanced bin boundaries spread the remainder', () => {
    const prepared = timeQc.prepareTimeQCBins(
      Float64Array.from({ length: 10 }, (_, index) => index),
      { targetBinSize: 4, timerRange: 100 },
    );
    const sizes = prepared.bins.map((bin) => bin.size);
    return {
      pass: sizes.join(',') === '3,3,4' && Math.max(...sizes) - Math.min(...sizes) === 1,
      detail: sizes.join(','),
    };
  });

  run('SCI-12: exact event rate uses n-1 intervals for short and long bins', () => {
    const time = Float64Array.from({ length: 100 }, (_, index) => index * 0.25);
    const short = { indexes: [0, 1, 2] };
    const long = { indexes: Array.from({ length: 100 }, (_, index) => index) };
    return {
      pass: close(timeQc.calculateBinEventRate(short, time), 4)
        && close(timeQc.calculateBinEventRate(long, time), 4),
      detail: JSON.stringify({ short: timeQc.calculateBinEventRate(short, time), long: timeQc.calculateBinEventRate(long, time) }),
    };
  });

  run('SCI-12: one event, duplicate timestamps, and zero duration return NaN', () => {
    const one = timeQc.calculateBinEventRate({ indexes: [0] }, [5]);
    const duplicate = timeQc.calculateBinEventRate({ indexes: [0, 1] }, [5, 5]);
    const backwards = timeQc.calculateBinEventRate({ indexes: [0, 1] }, [5, 4]);
    return {
      pass: Number.isNaN(one) && Number.isNaN(duplicate) && Number.isNaN(backwards),
      detail: JSON.stringify({ one, duplicate, backwards }),
    };
  });

  run('Stage 1 edge: zero-MAD robust Z is zero at center and infinite off center', () => {
    const baseline = { active: true, median: 10, robustScale: 0 };
    const same = timeQc.calculateRobustZ(10, baseline);
    const high = timeQc.calculateRobustZ(11, baseline);
    const low = timeQc.calculateRobustZ(9, baseline);
    return {
      pass: same === 0 && high === Infinity && low === -Infinity,
      detail: JSON.stringify({ same, high, low }),
    };
  });

  run('Stage 1 edge: wholly unavailable metrics are excluded from scoring', () => {
    const summaries = [{ value: 1, absent: NaN }, { value: 1, absent: NaN }, { value: 2, absent: NaN }];
    const metrics = { available: (item) => item.value, unavailable: (item) => item.absent };
    const scoring = timeQc.scoreTimeQCBins(summaries, 4, metrics);
    return {
      pass: scoring.activeMetrics.join(',') === 'available'
        && scoring.excludedMetrics.join(',') === 'unavailable'
        && scoring.scoredBins[2].flagged,
      detail: JSON.stringify({ active: scoring.activeMetrics, excluded: scoring.excludedMetrics }),
    };
  });

  run('Stage 1 edge: adjacent flagged bins merge only within one segment', () => {
    const bins = [
      { segmentId: 0, binNumber: 0, firstEventIndex: 0, lastEventIndex: 4 },
      { segmentId: 0, binNumber: 1, firstEventIndex: 5, lastEventIndex: 9 },
      { segmentId: 1, binNumber: 0, firstEventIndex: 10, lastEventIndex: 14 },
    ];
    const scored = bins.map((bin, binIndex) => ({
      ...bin, binIndex, flagged: true, reasons: binIndex === 1 ? ['rate', 'dna'] : ['dna'],
    }));
    const intervals = timeQc.mergeFlaggedBins(scored, bins);
    return {
      pass: intervals.length === 2
        && intervals[0].firstEventIndex === 0 && intervals[0].lastEventIndex === 9
        && intervals[0].reasons.sort().join(',') === 'dna,rate'
        && intervals[1].segmentId === 1,
      detail: JSON.stringify(intervals),
    };
  });

  run('Stage 1 edge: output mask composes validity, input, and flagged bins', () => {
    const bins = [{ indexes: [0, 1] }, { indexes: [2, 3] }];
    const scored = [{ binIndex: 0, flagged: false }, { binIndex: 1, flagged: true }];
    const mask = timeQc.createTimeQCMask(
      5,
      scored,
      bins,
      Uint8Array.from([1, 1, 1, 1, 0]),
      Uint8Array.from([1, 0, 1, 1, 1]),
    );
    return { pass: Array.from(mask).join('') === '10000', detail: Array.from(mask).join('') };
  });

  // ---- Stage 2 -----------------------------------------------------------
  run('Stage 2 edge: deterministic initial means are reproducible and ordered', () => {
    const points = [[0, 0], [1, 1], [2, 2], [50, 50], [51, 51], [52, 52]];
    const first = cellGate.deterministicInitialMeans(points, 2);
    const second = cellGate.deterministicInitialMeans(points, 2);
    return {
      pass: JSON.stringify(first) === JSON.stringify(second)
        && first.length === 2 && first[0][0] < first[1][0],
      detail: JSON.stringify(first),
    };
  });

  run('Stage 2 edge: too few eligible scatter events is a clean optional skip', () => {
    const eventCount = cellGate.MINIMUM_SCATTER_EVENTS - 1;
    const gate = cellGate.gateMainBiologicalCloud({
      eventCount,
      channels: {
        FSC_A: Float64Array.from({ length: eventCount }, (_, index) => index),
        SSC_A: Float64Array.from({ length: eventCount }, (_, index) => 2 * index),
      },
    });
    return {
      pass: gate.skipped && gate.scatterMask === null && /Too few valid/.test(gate.reason),
      detail: gate.reason,
    };
  });

  run('Stage 2 edge: component weight threshold can exclude a tiny high-FSC cloud', () => {
    const components = [
      { mean: [50, 40], weight: 0.95 },
      { mean: [100, 80], weight: 0.05 },
    ];
    const substantial = cellGate.chooseMainBiologicalComponent(components, { minimumWeight: 0.1 });
    const fallback = cellGate.chooseMainBiologicalComponent(components, { minimumWeight: 0.99 });
    return {
      pass: substantial.componentIndex === 0 && fallback.componentIndex === 1,
      detail: JSON.stringify({ substantial: substantial.componentIndex, fallback: fallback.componentIndex }),
    };
  });

  run('Stage 2 edge: ellipse boundary is inclusive and absent raw indexes stay diagnostic NaN', () => {
    const component = { mean: [0, 0], covariance: [[1, 0], [0, 1]] };
    const gate = cellGate.createScatterGateMask(
      3,
      [{ eventIndex: 0, point: [2, 0] }, { eventIndex: 2, point: [2.01, 0] }],
      component,
      4,
    );
    return {
      pass: Array.from(gate.mask).join('') === '100'
        && gate.mahalanobisDistanceSquared[0] === 4
        && Number.isNaN(gate.mahalanobisDistanceSquared[1])
        && gate.mahalanobisDistanceSquared[2] > 4,
      detail: JSON.stringify({ mask: Array.from(gate.mask), distances: Array.from(gate.mahalanobisDistanceSquared) }),
    };
  });

  // ---- Stage 3 -----------------------------------------------------------
  run('Stage 3 edge: geometry points skip masked and nonfinite observations without reindexing', () => {
    const points = singletGate.buildPulseGeometryPoints(
      Float64Array.from([1, 2, NaN, 4, 5]),
      Float64Array.from([10, 20, 30, Infinity, 50]),
      Uint8Array.from([1, 0, 1, 1, 1]),
    );
    return {
      pass: points.length === 2 && points[0].eventIndex === 0 && points[1].eventIndex === 4,
      detail: JSON.stringify(points),
    };
  });

  run('Stage 3 edge: zero-MAD ridge keeps exact-distance observations only', () => {
    const indexedPoints = [0, 1, 2].map((eventIndex) => ({ eventIndex, point: [eventIndex, 0] }));
    const result = singletGate.createSingletMaskFromRidge(3, indexedPoints, {
      distances: [1, 1, 2], distanceMedian: 1, distanceMAD: 0,
    }, 5);
    return {
      pass: Array.from(result.singletMask).join('') === '110' && result.threshold === 0,
      detail: JSON.stringify({ mask: Array.from(result.singletMask), threshold: result.threshold }),
    };
  });

  run('Stage 3 edge: negative or nonfinite k-MAD values fail validation', () => {
    const indexedPoints = [{ eventIndex: 0, point: [0, 0] }];
    const ridge = { distances: [0], distanceMedian: 0, distanceMAD: 1 };
    const negative = throws(() => singletGate.createSingletMaskFromRidge(1, indexedPoints, ridge, -1), /kMAD/);
    const infinite = throws(() => singletGate.createSingletMaskFromRidge(1, indexedPoints, ridge, Infinity), /kMAD/);
    return { pass: negative && infinite, detail: JSON.stringify({ negative, infinite }) };
  });

  run('Stage 3 edge: insufficient geometry points skips and preserves upstream mask', () => {
    const inputMask = Uint8Array.from([1, 0, 1, 1]);
    const gate = singletGate.gateByPulseGeometry({
      eventCount: 4,
      channels: {
        DNA_A: Float64Array.from([10, 20, 30, 40]),
        DNA_H: Float64Array.from([5, 10, 15, 20]),
        DNA_W: null,
      },
    }, inputMask, { minimumPoints: 10 });
    return {
      pass: gate.skipped && /Only 3 usable/.test(gate.reason)
        && Array.from(gate.singletMask).join('') === '1011',
      detail: JSON.stringify({ reason: gate.reason, mask: Array.from(gate.singletMask) }),
    };
  });

  // ---- Stage 4 -----------------------------------------------------------
  run('Stage 4 edge: a constant auto-range expands and still bins every value', () => {
    const histogram = dnaHistogram.generateHistogram([5, 5, 5], null, { binCount: 4 });
    return {
      pass: histogram.min < 5 && histogram.max > 5
        && histogram.binnedCount === 3
        && histogram.y.reduce((sum, value) => sum + value, 0) === 3,
      detail: JSON.stringify(histogram),
    };
  });

  run('Stage 4 edge: manual ranges clip outliers, reject negative DNA as ineligible (QC-00), and include exact maximum in final bin', () => {
    const histogram = dnaHistogram.generateHistogram([-1, 0, 1, 2, 3], null, {
      binCount: 2, range: [0, 2],
    });
    const checks = {
      retained: histogram.retainedCount === 4,
      negative: histogram.rejectedNegative === 1,
      underflow: histogram.underflow === 0,
      overflow: histogram.overflow === 1,
      binned: histogram.binnedCount === 3,
      bins: histogram.y.join(',') === '1,2',
    };
    return {
      // QC-00: the -1 is negative DNA -> rejected as ineligible (not retained,
      // not underflow). 3 is a genuine in-eligibility overflow past max.
      pass: Object.values(checks).every(Boolean),
      detail: JSON.stringify({ checks, histogram }),
    };
  });

  run('Stage 4 edge: invalid mask length, range, and bin count are rejected', () => {
    const mask = throws(
      () => dnaHistogram.generateHistogram([1, 2], [1], { binCount: 2 }),
      /finalMask\.length/i,
    );
    const range = throws(() => dnaHistogram.generateHistogram([1, 2], null, { binCount: 2, range: [2, 1] }), /greater than min/);
    const bins = throws(() => dnaHistogram.generateHistogram([1, 2], null, { binCount: 0 }), /positive integer/);
    return { pass: mask && range && bins, detail: JSON.stringify({ mask, range, bins }) };
  });

  // ---- QC-00: mandatory DNA-eligibility invariant --------------------------
  run('QC-00: collectEligibleDnaValues keeps finite non-negative DNA and tallies rejected non-finite/negative', () => {
    const r = dnaHistogram.collectEligibleDnaValues([1, -2, 0, NaN, 3, Infinity, -0.5]);
    return {
      pass: r.eligible.join(',') === '1,0,3'
        && r.maskRetained === 7
        && r.rejectedNegative === 2
        && r.rejectedNonfinite === 2,
      detail: JSON.stringify(r),
    };
  });

  run('QC-00: saturation uses datatype/transform metadata and preserves original index alignment', () => {
    const metadata = { datatype: 'F', bits: 32, range: 4, amplification: '0,0', gain: 1 };
    const linear = dnaHistogram.collectEligibleDnaValues([0, 3.9, 4, 5], [1, 1, 1, 0], metadata);
    const transformed = dnaHistogram.collectEligibleDnaValues([4], null, { ...metadata, amplification: '4,1' });
    return {
      pass: linear.eligible.join(',') === '0,3.9' && linear.rejectedSaturated === 1
        && linear.saturationCeiling === 4 && transformed.rejectedSaturated === 0
        && transformed.saturationCeiling === null,
      detail: JSON.stringify({ linear, transformed }),
    };
  });

  run('QC-00: the DNA invariant is enforced identically whether Stage 0 (a mask) is off or on', () => {
    const values = [1, -2, 0, NaN, 3];
    const off = dnaHistogram.generateHistogram(values, null, { binCount: 4, range: [0, 4] });
    const on = dnaHistogram.generateHistogram(values, [1, 1, 1, 1, 1], { binCount: 4, range: [0, 4] });
    return {
      pass: off.retainedCount === 3 && on.retainedCount === 3
        && off.rejectedNegative === 1 && on.rejectedNegative === 1
        && off.rejectedNonfinite === 1 && on.rejectedNonfinite === 1,
      detail: JSON.stringify({ off, on }),
    };
  });

  run('QC-00: saturation is rejected identically with optional Structural QC off or on', () => {
    const values = [0, 1, 2, 4];
    const options = { binCount: 4, range: [0, 4], dnaMetadata: { datatype: 'I', bits: 8, range: 4, amplification: '0,0', gain: 1 } };
    const off = dnaHistogram.generateHistogram(values, null, options);
    const on = dnaHistogram.generateHistogram(values, [1, 1, 1, 1], options);
    return { pass: off.retainedCount === 3 && on.retainedCount === 3
      && off.rejectedSaturated === 1 && on.rejectedSaturated === 1, detail: JSON.stringify({ off: off.rejectedSaturated, on: on.rejectedSaturated }) };
  });

  // ---- QC-00 model boundary (result contract) ------------------------------
  const RC = window.CellCycleResultContract;
  const qc00State = ({ rejectedNegative = 0, eligibleEvents = 700 } = {}) => {
    const bins = Math.max(1, Math.round(eligibleEvents / 5));
    return {
      channelKey: 'DNA_A',
      histogram: {
        counts: new Array(bins).fill(5), y: new Array(bins).fill(5), fingerprint: 'fp',
        centers: Array.from({ length: bins }, (_, index) => index),
        maskRetainedCount: eligibleEvents + rejectedNegative, rejectedNegative, rejectedNonfinite: 0,
      },
      structuralQC: { valid: true, status: 'complete' },
      modeling: {
        histogramFingerprint: 'fp',
        peakSelection: { regions: { g1: { left: 55, right: 85 }, g2: { left: 120, right: 160 } }, reviewed: true, stale: false, revision: 1 },
      },
    };
  };
  const hasReason = (pf, code) => pf.reasons.some((r) => r.code === code);

  run('QC-00: model_preflight flags DNA_INELIGIBLE when >25% of DNA is negative/non-finite', () => {
    const pf = RC.model_preflight(qc00State({ rejectedNegative: 400 }), { requiredQc: [] });
    return { pass: hasReason(pf, RC.RESULT_REASON.DNA_INELIGIBLE) && pf.passed === false, detail: JSON.stringify(pf.reasons) };
  });

  run('QC-00: model_preflight passes eligibility when few DNA events are ineligible', () => {
    const pf = RC.model_preflight(qc00State({ rejectedNegative: 20 }), { requiredQc: [] });
    return { pass: !hasReason(pf, RC.RESULT_REASON.DNA_INELIGIBLE) && pf.passed === true, detail: JSON.stringify(pf.reasons) };
  });

  run('QC-00: the DNA-ineligibility boundary holds with Stage 0 passed AND skipped (independent of the toggle)', () => {
    const passed = RC.model_preflight(qc00State({ rejectedNegative: 400 }), { requiredQc: [] });
    const skipped = RC.model_preflight({ ...qc00State({ rejectedNegative: 400 }), structuralQC: { skipped: true } }, { requiredQc: [] });
    return { pass: hasReason(passed, RC.RESULT_REASON.DNA_INELIGIBLE) && hasReason(skipped, RC.RESULT_REASON.DNA_INELIGIBLE), detail: JSON.stringify({ passed: passed.reasons.length, skipped: skipped.reasons.length }) };
  });

  run('QC-00: model_preflight requires a minimum number of eligible events', () => {
    const pf = RC.model_preflight(qc00State({ eligibleEvents: 50 }), { requiredQc: [] });
    return { pass: hasReason(pf, RC.RESULT_REASON.EVENTS_INSUFFICIENT), detail: JSON.stringify(pf.reasons) };
  });

  run('QC-00: model_preflight requires nonempty bins and support inside both reviewed peak regions', () => {
    const sparse = qc00State();
    sparse.histogram.counts = sparse.histogram.y = [500, 0, 0, 0, 500];
    sparse.histogram.centers = [60, 80, 100, 130, 150];
    const sparseResult = RC.model_preflight(sparse, { requiredQc: [] });
    const unsupported = qc00State();
    unsupported.histogram.centers = unsupported.histogram.centers.map((_, index) => index < 120 ? 60 : 100);
    const unsupportedResult = RC.model_preflight(unsupported, { requiredQc: [] });
    return { pass: hasReason(sparseResult, RC.RESULT_REASON.HISTOGRAM_SUPPORT_INSUFFICIENT)
      && hasReason(unsupportedResult, RC.RESULT_REASON.PEAK_SUPPORT_INSUFFICIENT),
      detail: JSON.stringify({ sparse: sparseResult.reasons, unsupported: unsupportedResult.reasons }) };
  });

  run('DATA-01: model_preflight rejects a restored/cache channel marked as already transformed', () => {
    const state = qc00State();
    state.channelEligibility = {
      eligible: true,
      transform: { status: 'linear', applied: true, applicationCount: 1 },
      compensation: { status: 'unknown', applied: false, applicationCount: 0 },
    };
    const pf = RC.model_preflight(state, { requiredQc: [] });
    return { pass: hasReason(pf, 'fcs_transform_state_invalid') && !pf.passed, detail: JSON.stringify(pf.reasons) };
  });

  // ---- QC-01: explicit per-stage outcome taxonomy + fail-closed ------------
  const qc01State = (qc = {}) => ({
    channelKey: 'DNA_A',
    histogram: { counts: new Array(200).fill(5), y: new Array(200).fill(5), fingerprint: 'fp', maskRetainedCount: 1000, rejectedNegative: 0, rejectedNonfinite: 0 },
    structuralQC: qc.structural === undefined ? { skipped: false, rejectedEventCount: 0, retainedEventCount: 1000 } : qc.structural,
    timeQC: qc.time,
    scatterGate: qc.scatter,
    singletResult: qc.singlet,
    modeling: { histogramFingerprint: 'fp', peakSelection: { regions: { g1: { left: 55, right: 85 }, g2: { left: 120, right: 160 } }, reviewed: true, stale: false, revision: 1 } },
  });
  const structuralStatus = (product) => RC.model_preflight(qc01State({ structural: product }), { requiredQc: [] }).qc.structural.status;

  run('QC-01 taxonomy: applied (removed events) / passed_no_loss (removed nothing)', () => ({
    pass: structuralStatus({ skipped: false, rejectedEventCount: 30, retainedEventCount: 970 }) === 'applied'
      && structuralStatus({ skipped: false, rejectedEventCount: 0, retainedEventCount: 1000 }) === 'passed_no_loss',
    detail: '',
  }));

  run('QC-01 taxonomy: skipped_optional (off, no reason) vs unavailable (could not run, has a reason)', () => ({
    pass: structuralStatus({ skipped: true, status: 'off' }) === 'skipped_optional'
      && structuralStatus({ skipped: true, reason: 'Neither DNA_H nor DNA_W was available.' }) === 'unavailable',
    detail: '',
  }));

  run('QC-01 taxonomy: degraded (ran with warnings) / failed / cancelled / not_run', () => ({
    pass: structuralStatus({ skipped: false, rejectedEventCount: 5, warnings: ['review required'] }) === 'degraded'
      && structuralStatus({ failed: true, status: 'error' }) === 'failed'
      && structuralStatus({ cancelled: true }) === 'cancelled'
      && structuralStatus(null) === 'not_run',
    detail: '',
  }));

  run('QC-01 fail-closed: a required stage that is unavailable or not_run blocks reporting', () => {
    const unavailable = RC.model_preflight(qc01State({ structural: { skipped: true, reason: 'missing channel' } }), { requiredQc: ['structural'] });
    const notRun = RC.model_preflight(qc01State({ structural: null }), { requiredQc: ['structural'] });
    return { pass: hasReason(unavailable, RC.RESULT_REASON.QC_NOT_PASSED) && unavailable.passed === false
      && hasReason(notRun, RC.RESULT_REASON.QC_NOT_PASSED), detail: '' };
  });

  run('DATA-04: QC stages selected in pipeline state remain required at every model entry point', () => {
    const state = qc01State({ time: { skipped: true, reason: 'Time companion failed to load' } });
    state.requiredQc = ['time'];
    const pf = RC.model_preflight(state);
    return { pass: hasReason(pf, RC.RESULT_REASON.QC_NOT_PASSED) && !pf.passed, detail: JSON.stringify(pf.qc.time) };
  });

  run('DATA-04: a failed companion-backed stage clears its stale mask and prior fit state', () => {
    const row = {
      id: 'data04-failure', name: 'data04-failure.fcs',
      data: { eventCount: 3, masks: { structural: null, timeQC: Uint8Array.from([1, 1, 1]), scatter: null, singlet: null, final: Uint8Array.from([1, 1, 1]) }, channels: { DNA_A: Float64Array.from([1, 2, 3]) } },
    };
    const state = pipeline.get_or_create_state(row);
    state.modeling.activeResultKey = 'stale-fit';
    state.modeling.resultsByKey['stale-fit'] = { validForReporting: true };
    const failure = new Error('Time companion worker failed');
    failure.code = 'FCS_WORKER_LOAD_FAILED';
    pipeline.record_qc_failure(row, 1, failure);
    return {
      pass: row.data.masks.timeQC === null && state.timeQC.failed
        && state.timeQC.error.code === 'FCS_WORKER_LOAD_FAILED'
        && state.modeling.activeResultKey === null,
      detail: JSON.stringify({ mask: row.data.masks.timeQC, error: state.timeQC.error, active: state.modeling.activeResultKey }),
    };
  });

  run('UI-02 fault injection: every QC stage preserves its error and clears stale mask/model state', () => {
    const products = ['structuralQC', 'timeQC', 'scatterGate', 'singletResult'];
    const masks = ['structural', 'timeQC', 'scatter', 'singlet'];
    const results = products.map((product, index) => {
      const row = {
        id: `ui02-${index}`, name: `ui02-${index}.fcs`,
        data: { eventCount: 2, masks: { structural: null, timeQC: null, scatter: null, singlet: null, final: Uint8Array.from([1, 1]) }, channels: { DNA_A: Float64Array.from([1, 2]) } },
      };
      row.data.masks[masks[index]] = Uint8Array.from([1, 1]);
      const state = pipeline.get_or_create_state(row);
      state.modeling.activeResultKey = 'stale';
      state.modeling.resultsByKey.stale = { validForReporting: true };
      const error = new Error(`injected stage ${index}`);
      pipeline.record_qc_failure(row, index, error);
      return state[product].failed === true
        && state[product].cause === error
        && row.data.masks[masks[index]] === null
        && state.modeling.activeResultKey === null;
    });
    return { pass: results.every(Boolean), detail: JSON.stringify(results) };
  });

  run('QC-01 fail-closed: an OPTIONAL stage that failed still blocks (mask untrustworthy)', () => {
    const pf = RC.model_preflight(qc01State({ scatter: { failed: true, status: 'error' } }), { requiredQc: [] });
    return { pass: hasReason(pf, RC.RESULT_REASON.QC_NOT_PASSED), detail: JSON.stringify(pf.qc.scatter) };
  });

  run('QC-01: a required stage waived WITH a reason passes; a waiver WITHOUT a reason is rejected', () => {
    const waived = RC.model_preflight(qc01State({ structural: null }), { requiredQc: ['structural'], qcWaivers: { structural: { reason: 'external instrument QC' } } });
    const noReason = RC.model_preflight(qc01State({ structural: { skipped: true, reason: 'x' } }), { requiredQc: ['structural'], qcWaivers: { structural: {} } });
    return { pass: waived.qc.structural.status === 'waived' && waived.passed === true
      && noReason.qc.structural.status !== 'waived' && noReason.passed === false, detail: JSON.stringify({ waived: waived.qc.structural, noReason: noReason.qc.structural }) };
  });

  run('QC-01 critical removal: >50% event loss blocks until acknowledged; <50% does not', () => {
    // An acknowledgement now has to NAME the outcome it authorizes: a bare
    // truthy value used to open this gate, which meant any leftover flag
    // authorized whatever the QC stage happened to be doing today. The
    // identity-bound records are covered end to end in
    // unit_tests_qc_acknowledgement.py; here we only pin that this gate reads
    // them and still refuses a bare `true`.
    const heavy = { skipped: false, evaluatedEventCount: 1000, rejectedEventCount: 700, retainedEventCount: 300 };
    const key = RC.qc_acknowledgement_key('time', heavy);
    const blocked = RC.model_preflight(qc01State({ time: heavy }), { requiredQc: [] });
    const bare = RC.model_preflight(qc01State({ time: heavy }), { requiredQc: [], qcAcknowledgements: { time: true } });
    const acked = RC.model_preflight(qc01State({ time: heavy }), { requiredQc: [], qcAcknowledgements: { time: { key, acknowledgedAt: '2026-08-18T00:00:00.000Z' } } });
    const moderate = RC.model_preflight(qc01State({ time: { skipped: false, evaluatedEventCount: 1000, rejectedEventCount: 300, retainedEventCount: 700 } }), { requiredQc: [] });
    return { pass: hasReason(blocked, RC.RESULT_REASON.QC_CRITICAL_REMOVAL)
      && hasReason(bare, RC.RESULT_REASON.QC_CRITICAL_REMOVAL)
      && !hasReason(acked, RC.RESULT_REASON.QC_CRITICAL_REMOVAL)
      && !hasReason(moderate, RC.RESULT_REASON.QC_CRITICAL_REMOVAL)
      && moderate.qc.time.status === 'applied',
      detail: JSON.stringify({ blockedPct: blocked.qc.time.percentRemoved, moderatePct: moderate.qc.time.percentRemoved }) };
  });

  // ---- Orchestration -----------------------------------------------------
  run('pipeline edge: shared histogram range honors composed masks across samples', () => {
    const makeRow = (name, values, mask) => ({
      id: `${name}-id`, name,
      data: {
        channel_key: 'DNA-A', eventCount: values.length,
        channels: { DNA_A: Float64Array.from(values) },
        masks: { structural: Uint8Array.from(mask), timeQC: null, scatter: null, singlet: null, final: null },
      },
    });
    const first = makeRow('range-a', [1, 2, 100], [1, 1, 0]);
    const second = makeRow('range-b', [-10, 5, 6], [0, 1, 1]);
    const range = pipeline.shared_histogram_range([first, second]);
    return { pass: range[0] === 1 && range[1] === 6, detail: JSON.stringify(range) };
  });

  // Mirrors the production batch path (pipeline_ui.js, modeling_ui.js): derive
  // one range with shared_histogram_range(), then build each sample's histogram
  // with it. There is no index-based batch runner any more.
  run('pipeline edge: a shared range gives every row in a batch identical bins', () => {
    const makeRow = (name, values) => ({
      id: `${name}-id`, name,
      data: {
        channel_key: 'DNA-A', eventCount: values.length,
        channels: {
          DNA_A: Float64Array.from(values), DNA_H: null, DNA_W: null,
          FSC_A: null, SSC_A: null, Time: null,
        },
        pnr: { DNA_A: 100 },
        masks: { structural: null, timeQC: null, scatter: null, singlet: null, final: null },
      },
    });
    const first = makeRow('batch-range-a', [1, 2, 3]);
    const second = makeRow('batch-range-b', [10, 11, 12]);
    pipeline.apply_structural_qc(first);
    pipeline.apply_structural_qc(second);
    const sharedRange = pipeline.shared_histogram_range([first, second]);
    const outputs = [first, second].map(
      (row) => pipeline.apply_dna_histogram(row, { binCount: 4, range: sharedRange })
    );
    return {
      pass: outputs.length === 2
        && outputs[0].result.min === 1 && outputs[0].result.max === 12
        && outputs[1].result.min === 1 && outputs[1].result.max === 12,
      detail: JSON.stringify(outputs.map((entry) => ({ min: entry.result.min, max: entry.result.max, y: entry.result.y }))),
    };
  });

  return results;
}"""


def run_djf_edge_tests(ctx: TestContext):
    """Run stage-edge assertions and record each result separately."""

    try:
        all_results = ctx.page.evaluate(_STAGE_EDGES)
    except Exception as err:
        ctx.check(
            GROUP,
            "stage-edge suite setup",
            False,
            str(err),
            screenshot=False,
        )
        return

    for item in all_results:
        ctx.check(
            GROUP,
            item["name"],
            item["pass"],
            item.get("detail", ""),
            screenshot=False,
        )
