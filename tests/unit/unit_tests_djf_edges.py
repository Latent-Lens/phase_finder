#!/usr/bin/env python3
"""Boundary, validation, and option-contract tests for DJF Stages 0–8."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / DJF Stage Edges"


_STAGE_EDGES = r"""() => {
  const pipeline = window.PhaseFinder.pipeline;
  const { stage0, stage1, stage2, stage3, stage4, stage5, stage6, stage7, stage8 } = pipeline;
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
    const mask = stage0.createStructuralValidityMask(dataset, { DNA_A: 10, Time: 1 });
    return { pass: Array.from(mask).join('') === '100', detail: Array.from(mask).join('') };
  });

  run('Stage 0 edge: mismatched loaded channel lengths fail clearly', () => {
    const failed = throws(() => stage0.createStructuralValidityMask({
      eventCount: 3,
      channels: { DNA_A: [1, 2, 3], DNA_H: [1, 2] },
      pnr: {},
    }), /lengths do not match/);
    return { pass: failed, detail: `failed=${failed}` };
  });

  run('Stage 0 edge: at least one loaded channel is required', () => {
    const failed = throws(
      () => stage0.createStructuralValidityMask({ eventCount: 0, channels: {}, pnr: {} }),
      /at least one loaded channel/,
    );
    return { pass: failed, detail: `failed=${failed}` };
  });

  // ---- Stage 1 -----------------------------------------------------------
  run('Stage 1 edge: invalid Time values split acquisition segments and remain masked', () => {
    const prepared = stage1.prepareTimeQCBins(
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
    const prepared = stage1.prepareTimeQCBins(
      Float64Array.from({ length: 10 }, (_, index) => index),
      { targetBinSize: 4, timerRange: 100 },
    );
    const sizes = prepared.bins.map((bin) => bin.size);
    return {
      pass: sizes.join(',') === '3,3,4' && Math.max(...sizes) - Math.min(...sizes) === 1,
      detail: sizes.join(','),
    };
  });

  run('Stage 1 edge: zero-MAD robust Z is zero at center and infinite off center', () => {
    const baseline = { active: true, median: 10, robustScale: 0 };
    const same = stage1.calculateRobustZ(10, baseline);
    const high = stage1.calculateRobustZ(11, baseline);
    const low = stage1.calculateRobustZ(9, baseline);
    return {
      pass: same === 0 && high === Infinity && low === -Infinity,
      detail: JSON.stringify({ same, high, low }),
    };
  });

  run('Stage 1 edge: wholly unavailable metrics are excluded from scoring', () => {
    const summaries = [{ value: 1, absent: NaN }, { value: 1, absent: NaN }, { value: 2, absent: NaN }];
    const metrics = { available: (item) => item.value, unavailable: (item) => item.absent };
    const scoring = stage1.scoreTimeQCBins(summaries, 4, metrics);
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
    const intervals = stage1.mergeFlaggedBins(scored, bins);
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
    const mask = stage1.createTimeQCMask(
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
    const first = stage2.deterministicInitialMeans(points, 2);
    const second = stage2.deterministicInitialMeans(points, 2);
    return {
      pass: JSON.stringify(first) === JSON.stringify(second)
        && first.length === 2 && first[0][0] < first[1][0],
      detail: JSON.stringify(first),
    };
  });

  run('Stage 2 edge: too few eligible scatter events is a clean optional skip', () => {
    const eventCount = stage2.MINIMUM_SCATTER_EVENTS - 1;
    const gate = stage2.gateMainBiologicalCloud({
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
    const substantial = stage2.chooseMainBiologicalComponent(components, { minimumWeight: 0.1 });
    const fallback = stage2.chooseMainBiologicalComponent(components, { minimumWeight: 0.99 });
    return {
      pass: substantial.componentIndex === 0 && fallback.componentIndex === 1,
      detail: JSON.stringify({ substantial: substantial.componentIndex, fallback: fallback.componentIndex }),
    };
  });

  run('Stage 2 edge: ellipse boundary is inclusive and absent raw indexes stay diagnostic NaN', () => {
    const component = { mean: [0, 0], covariance: [[1, 0], [0, 1]] };
    const gate = stage2.createScatterGateMask(
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
    const points = stage3.buildPulseGeometryPoints(
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
    const result = stage3.createSingletMaskFromRidge(3, indexedPoints, {
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
    const negative = throws(() => stage3.createSingletMaskFromRidge(1, indexedPoints, ridge, -1), /kMAD/);
    const infinite = throws(() => stage3.createSingletMaskFromRidge(1, indexedPoints, ridge, Infinity), /kMAD/);
    return { pass: negative && infinite, detail: JSON.stringify({ negative, infinite }) };
  });

  run('Stage 3 edge: insufficient geometry points skips and preserves upstream mask', () => {
    const inputMask = Uint8Array.from([1, 0, 1, 1]);
    const gate = stage3.gateByPulseGeometry({
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
    const histogram = stage4.generateHistogram([5, 5, 5], null, { binCount: 4 });
    return {
      pass: histogram.min < 5 && histogram.max > 5
        && histogram.binnedCount === 3
        && histogram.y.reduce((sum, value) => sum + value, 0) === 3,
      detail: JSON.stringify(histogram),
    };
  });

  run('Stage 4 edge: manual ranges clip outliers and include exact maximum in final bin', () => {
    const histogram = stage4.generateHistogram([-1, 0, 1, 2, 3], null, {
      binCount: 2, range: [0, 2],
    });
    return {
      pass: histogram.retainedCount === 5 && histogram.binnedCount === 3
        && histogram.y.join(',') === '1,2',
      detail: JSON.stringify(histogram),
    };
  });

  run('Stage 4 edge: invalid mask length, range, and bin count are rejected', () => {
    const mask = throws(
      () => stage4.generateHistogram([1, 2], [1], { binCount: 2 }),
      /finalMask\.length/i,
    );
    const range = throws(() => stage4.generateHistogram([1, 2], null, { binCount: 2, range: [2, 1] }), /greater than min/);
    const bins = throws(() => stage4.generateHistogram([1, 2], null, { binCount: 0 }), /positive integer/);
    return { pass: mask && range && bins, detail: JSON.stringify({ mask, range, bins }) };
  });

  // ---- Stage 5 -----------------------------------------------------------
  run('Stage 5 edge: a flat-topped local maximum collapses to its center bin', () => {
    const maxima = stage5.findLocalMaxima([0, 1, 3, 3, 3, 1, 0]);
    return {
      pass: maxima.length === 1 && maxima[0].bin === 3 && maxima[0].height === 3,
      detail: JSON.stringify(maxima),
    };
  });

  run('Stage 5 edge: peak prominence uses the higher surrounding basin', () => {
    const prominence = stage5.calculatePeakProminence([0, 5, 1, 3, 2], 1);
    return { pass: prominence === 4, detail: String(prominence) };
  });

  run('Stage 5 edge: inconsistent ratio bounds fail before peak detection', () => {
    const failed = throws(() => stage5.detectDNAContentPeaks([0, 1, 0, 1, 0], {
      targetRatio: 2,
      minimumRatio: 2.1,
      maximumRatio: 2.2,
    }), /ratio settings/);
    return { pass: failed, detail: `failed=${failed}` };
  });

  // ---- Stage 6 -----------------------------------------------------------
  run('Stage 6 edge: histogram input rejects short, nonmonotonic, and negative data', () => {
    const short = throws(() => stage6.validateHistogramInput([1, 2], [1, 2]), /at least 10 bins/);
    const nonmonotonic = throws(() => stage6.validateHistogramInput(
      [0, 1, 2, 3, 4, 5, 6, 7, 7, 9],
      new Array(10).fill(1),
    ), /strictly increasing/);
    const negative = throws(() => stage6.validateHistogramInput(
      Array.from({ length: 10 }, (_, index) => index),
      [1, 1, 1, 1, -1, 1, 1, 1, 1, 1],
    ), /nonnegative/);
    return { pass: short && nonmonotonic && negative, detail: JSON.stringify({ short, nonmonotonic, negative }) };
  });

  run('Stage 6 edge: projection enforces locked ratio, CV bounds, and nonnegative amplitudes', () => {
    const options = { ...stage6.DEFAULT_OPTIONS, unlockRatio: false, ratioTarget: 2 };
    const projected = stage6.projectParameters(
      [-100, 9, -1, 1e9, -1, -2, -3, 4, -5],
      [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
      options,
    );
    const mu1 = projected[0];
    const mu2 = projected[1] * mu1;
    return {
      pass: projected[1] === 2 && mu1 > 10 && mu2 < 100
        && projected[2] >= options.cvMin * mu1 && projected[2] <= options.cvMax * mu1
        && projected[3] >= options.cvMin * mu2 && projected[3] <= options.cvMax * mu2
        && projected[4] === 0 && projected[5] === 0 && projected[6] === 0
        && projected[7] === 4 && projected[8] === 0,
      detail: JSON.stringify(projected),
    };
  });

  run('Stage 6 edge: weighted residuals divide raw error by square-root count', () => {
    const x = [10, 20];
    const y = [4, 9];
    const parameters = [10, 2, 1, 1, 0, 0, 0, 0, 0];
    const unweighted = stage6.computeResiduals(x, y, parameters, { weightedResiduals: false });
    const weighted = stage6.computeResiduals(x, y, parameters, { weightedResiduals: true });
    return {
      pass: unweighted.rawResiduals.join(',') === '-4,-9'
        && weighted.residuals.join(',') === '-2,-3',
      detail: JSON.stringify({ raw: unweighted.rawResiduals, weighted: weighted.residuals }),
    };
  });

  run('Stage 6 edge: unlocked ratio projection clamps to configured bounds', () => {
    const options = { ...stage6.DEFAULT_OPTIONS, unlockRatio: true, ratioMin: 1.8, ratioMax: 2.1 };
    const low = stage6.projectParameters([50, 1, 5, 5, 1, 1, 1, 1, 1], [0, 200], options);
    const high = stage6.projectParameters([50, 3, 5, 5, 1, 1, 1, 1, 1], [0, 200], options);
    return { pass: low[1] === 1.8 && high[1] === 2.1, detail: `${low[1]}, ${high[1]}` };
  });

  // ---- Stage 7 -----------------------------------------------------------
  run('Stage 7 edge: positive template correlation handles identical and empty energy', () => {
    const identical = stage7.normalizedPositiveCorrelation([1, 2, 3], [1, 2, 3]);
    const none = stage7.normalizedPositiveCorrelation([0, 0], [1, 2]);
    return { pass: close(identical, 1, 1e-12) && none === 0, detail: `${identical}, ${none}` };
  });

  run('Stage 7 edge: BIC penalizes extra parameters at identical SSE', () => {
    const simple = stage7.calculateBic(100, 50, 8);
    const complex = stage7.calculateBic(100, 50, 11);
    return { pass: complex > simple, detail: JSON.stringify({ simple, complex }) };
  });

  run('Stage 7 edge: model comparison requires all three improvement criteria', () => {
    const base = {
      sse: 100, bic: 50, aggregateResidualEnergy: 100, debrisResidualEnergy: 100,
    };
    const candidate = {
      sse: 90, bic: 40, flags: { aggregate: true, debris: false },
      aggregateResidualEnergy: 50, debrisResidualEnergy: 100,
    };
    const permissive = stage7.compareWithBase(base, candidate, {
      minRelativeSseImprovement: 0.05, minBicImprovement: 6, minTargetResidualImprovement: 0.2,
    });
    const strict = stage7.compareWithBase(base, candidate, {
      minRelativeSseImprovement: 0.05, minBicImprovement: 12, minTargetResidualImprovement: 0.2,
    });
    return {
      pass: permissive.materiallyImproved && !strict.materiallyImproved
        && close(permissive.relativeSseImprovement, 0.1)
        && close(permissive.targetResidualImprovement, 0.5),
      detail: JSON.stringify({ permissive, strict }),
    };
  });

  run('Stage 7 edge: extension input requires a real previous fit', () => {
    const x = Array.from({ length: 10 }, (_, index) => index + 1);
    const y = new Array(10).fill(1);
    const failed = throws(() => stage7.validateInput(x, y, null), /previousFit/);
    return { pass: failed, detail: `failed=${failed}` };
  });

  // ---- Stage 8 -----------------------------------------------------------
  run('Stage 8 edge: inferred parameter count tracks ratio and contamination terms', () => {
    const base = stage8.inferParameterCount({ diagnostics: { options: { unlockRatio: false } } }, {});
    const unlocked = stage8.inferParameterCount({ diagnostics: { options: { unlockRatio: true } } }, {});
    const extended = stage8.inferParameterCount({
      selectedModel: 'base+aggregate+debris', diagnostics: { options: { unlockRatio: false } },
    }, {});
    return { pass: base === 8 && unlocked === 9 && extended === 11, detail: `${base}, ${unlocked}, ${extended}` };
  });

  run('Stage 8 edge: residual autocorrelation and Durbin-Watson match an alternating sequence', () => {
    const residuals = [1, -1, 1, -1];
    const autocorrelation = stage8.calculateLagOneAutocorrelation(residuals);
    const durbinWatson = stage8.calculateDurbinWatson(residuals);
    return {
      pass: close(autocorrelation, -0.75) && close(durbinWatson, 3),
      detail: JSON.stringify({ autocorrelation, durbinWatson }),
    };
  });

  run('Stage 8 edge: local residual bias identifies the injected three-bin window', () => {
    const result = stage8.calculateMaximumLocalBias([0, 0, 5, 5, 5, 0, 0], 3);
    return {
      pass: result.startIndex === 2 && result.endIndex === 4
        && result.maximumAbsoluteZ > 1e6,
      detail: JSON.stringify(result),
    };
  });

  run('Stage 8 edge: pulse geometry can be inferred or explicitly overridden', () => {
    const inferred = stage8.detectPulseGeometry({
      pulseGeometryAvailable: null, channelNames: ['DAPI-A', 'DAPI-H', 'FSC-A'],
    });
    const absent = stage8.detectPulseGeometry({
      pulseGeometryAvailable: null, channelNames: ['DAPI-A', 'FSC-A'],
    });
    const overridden = stage8.detectPulseGeometry({
      pulseGeometryAvailable: false, channelNames: ['DAPI-A', 'DAPI-H'],
    });
    return {
      pass: inferred.available && inferred.source === 'channel-names'
        && !absent.available && !overridden.available && overridden.source === 'explicit-option',
      detail: JSON.stringify({ inferred, absent, overridden }),
    };
  });

  run('Stage 8 edge: percentage formatting handles precision and nonfinite values', () => {
    const percent = stage8.fractionToPercent(0.1234, 2);
    const missing = stage8.fractionToPercent(NaN, 1);
    return { pass: percent === '12.34' && missing === null, detail: JSON.stringify({ percent, missing }) };
  });

  run('Stage 8 edge: report validation rejects curve-length mismatches', () => {
    const failed = throws(() => stage8.validateFitResult({
      curves: {
        x: [0, 1], observed: [1, 1], g1: [1, 1], s: [0, 0], g2: [0, 0],
        fitted: [1], residuals: [0, 0],
      },
    }), /does not match/);
    return { pass: failed, detail: `failed=${failed}` };
  });

  // ---- Orchestration -----------------------------------------------------
  run('pipeline edge: invalid stage numbers fail with a clear message', () => {
    const failed = throws(() => pipeline.run_stage(99, {}), /Stage 99 is not available/);
    return { pass: failed, detail: `failed=${failed}` };
  });

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

  run('pipeline edge: Stage 4 batch runner applies one shared range to every row', () => {
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
    pipeline.run_stage0(first);
    pipeline.run_stage0(second);
    const outputs = pipeline.run_stage_all(4, [first, second], { binCount: 4 });
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
