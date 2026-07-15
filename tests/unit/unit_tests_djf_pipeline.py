#!/usr/bin/env python3
"""Browser unit coverage for the staged Dean-Jett-Fox pipeline.

The harness imports the real ES modules and these snippets exercise each stage
directly. Synthetic inputs are deterministic so failures identify algorithm or
mask-regression changes rather than random test data.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / DJF Pipeline"


_STAGES_0_TO_4 = r"""() => {
  const pipeline = window.PhaseFinder.pipeline;
  const { stage0, stage1, stage2, stage3, stage4 } = pipeline;
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
  const countMask = (mask, start = 0, end = mask.length) => {
    let count = 0;
    for (let i = start; i < end; i += 1) count += mask[i];
    return count;
  };

  run('harness: exposes Stage 0 through Stage 8 and pipeline runners', () => {
    const stagesPresent = Array.from({ length: 9 }, (_, stage) =>
      Boolean(pipeline[`stage${stage}`])
    ).every(Boolean);
    return {
      pass: stagesPresent
        && typeof pipeline.run_stage0 === 'function'
        && typeof pipeline.run_stage8 === 'function'
        && typeof window.DJFPipelineState.combine_masks === 'function',
      detail: `stagesPresent=${stagesPresent}`,
    };
  });

  run('loader helper: preserves raw event order, zero, negatives, and NaN', () => {
    const columns = {
      1: [0, -2, NaN, 100],
      2: [0, 10, 20, 30],
      3: [50, 51, 52, 53],
      4: [60, 61, 62, 63],
      5: [0, 1, 2, 500],
    };
    const indexes = {
      dna_a: 1, dna_h: 2, dna_w: null, fsc_a: 3, ssc_a: 4, time: 5,
    };
    const metadata = {
      DATATYPE: 'F', P1R: '262144', P1N: 'DAPI-A', P1B: '32',
      P2R: '262144', P3R: '1000', P4R: '1000', P5R: '100',
    };
    const raw = build_raw_analysis_channels(columns, indexes, metadata, 4);
    const dna = raw.channels.DNA_A;
    return {
      pass: dna instanceof Float64Array
        && dna.length === 4
        && dna[0] === 0
        && dna[1] === -2
        && Number.isNaN(dna[2])
        && dna[3] === 100
        && raw.channels.DNA_W === null
        && raw.channels.Time[3] === 500,
      detail: JSON.stringify({ dna: Array.from(dna), time: Array.from(raw.channels.Time) }),
    };
  });

  run('loader helper: captures PnR and parameter metadata without compaction', () => {
    const raw = build_raw_analysis_channels(
      { 1: [0, 1], 2: [2, 3] },
      { dna_a: 1, dna_h: null, dna_w: null, fsc_a: null, ssc_a: null, time: 2 },
      { DATATYPE: 'I', P1R: '4096', P1B: '16', P1N: 'DNA-A', P2R: '1024', P2N: 'HDR-T' },
      2,
    );
    return {
      pass: raw.pnr.DNA_A === 4096
        && raw.pnr.Time === 1024
        && raw.parameterMetadata.DNA_A.bits === 16
        && raw.parameterMetadata.DNA_A.datatype === 'I'
        && raw.channels.DNA_A.length === 2,
      detail: JSON.stringify({ pnr: raw.pnr, metadata: raw.parameterMetadata.DNA_A }),
    };
  });

  run('loader helper: auto-detects FSC-A, SSC-A, and HDR-T parameters', () => {
    const params = parameter_map({
      columns: ['DAPI-A', 'DAPI-H', 'FSC-A', 'SSC-A', 'HDR-T'],
      metadata: { P3S: 'Forward Scatter Area', P4S: 'Side Scatter Area', P5S: 'Time' },
    });
    const indexes = find_pipeline_channel_indexes(params);
    return {
      pass: indexes.fsc_a === 3 && indexes.ssc_a === 4 && indexes.time === 5,
      detail: JSON.stringify(indexes),
    };
  });

  run('Stage 0: structural mask keeps zero and rejects nonfinite, negative, and saturated values', () => {
    const dataset = {
      eventCount: 8,
      channels: {
        DNA_A: Float64Array.from([0, -1, 100, 999, 1000, 500, 500, 500]),
        DNA_H: Float64Array.from([0, 10, NaN, 10, 10, 500, 500, 500]),
        DNA_W: null,
        FSC_A: Float64Array.from([0, 10, 10, 10, 10, 1000, 10, 10]),
        SSC_A: Float64Array.from([0, 10, 10, 10, 10, 10, -1, 10]),
        Time: Float64Array.from([0, 1, 2, 3, 4, 5, 6, 10000]),
      },
      pnr: { DNA_A: 1000, DNA_H: 1000, FSC_A: 1000, SSC_A: 1000, Time: 100 },
    };
    const qc = stage0.runStructuralQC(dataset);
    const actual = Array.from(qc.structuralMask).join('');
    return {
      pass: actual === '10010001'
        && qc.retainedEventCount === 3
        && qc.rejectedEventCount === 5,
      detail: `mask=${actual}, retained=${qc.retainedEventCount}`,
    };
  });

  run('Stage 0: Time is exempt from its PnR upper bound', () => {
    const mask = stage0.createStructuralValidityMask({
      eventCount: 3,
      channels: {
        DNA_A: Float64Array.from([0, 1, 2]),
        Time: Float64Array.from([0, 100, 10000]),
      },
      pnr: { DNA_A: 10, Time: 10 },
    });
    return { pass: Array.from(mask).join('') === '111', detail: Array.from(mask).join('') };
  });

  run('Stage 1: unwraps a timer wrap but starts a new segment for an unrelated backward jump', () => {
    const prepared = stage1.prepareTimeQCBins(
      Float64Array.from([8, 9, 9.8, 0.2, 1, 2, 1.5, 2.5]),
      { timerRange: 10, targetBinSize: 3 },
    );
    const segments = Array.from(prepared.segmentId).join(',');
    return {
      pass: prepared.segmentCount === 2
        && segments === '0,0,0,0,0,0,1,1'
        && Math.abs(prepared.unwrappedTime[3] - 10.2) < 1e-9
        && prepared.bins.length === 3,
      detail: `segments=${segments}, unwrapped3=${prepared.unwrappedTime[3]}, bins=${prepared.bins.length}`,
    };
  });

  run('Stage 1: flags an injected |z| > 4 DNA-median bin and clears its raw-index mask', () => {
    const dataset = TestUtils.buildTimeQCDataset();
    const structural = new Uint8Array(dataset.eventCount);
    structural.fill(1);
    const qc = stage1.runTimeQC(dataset, structural, {
      targetBinSize: dataset.eventsPerBin,
      timerRange: 1000,
      threshold: 4,
    });
    const outlier = qc.scoredBins.at(-1);
    const finalBinStart = dataset.eventCount - dataset.eventsPerBin;
    const rejectedFinalBin = countMask(qc.timeQCMask, finalBinStart) === 0;
    return {
      pass: !qc.skipped
        && qc.bins.length === 9
        && outlier.flagged
        && Math.abs(outlier.zScores.medianDNA_A) > 4
        && rejectedFinalBin,
      detail: JSON.stringify({
        bins: qc.bins.length,
        flagged: outlier.flagged,
        z: outlier.zScores.medianDNA_A,
        retained: qc.retainedEventCount,
      }),
    };
  });

  run('Stage 1: skips cleanly when Time is absent', () => {
    const qc = stage1.runTimeQC({ eventCount: 3, channels: { DNA_A: [1, 2, 3], Time: null } });
    return {
      pass: qc.skipped && qc.timeQCMask === null && /no Time/.test(qc.reason),
      detail: JSON.stringify(qc),
    };
  });

  run('Stage 2: chooses the high-FSC main component and gates its tight ellipse', () => {
    const dataset = TestUtils.buildScatterDataset();
    const structural = new Uint8Array(dataset.eventCount);
    structural.fill(1);
    structural[0] = 0;
    const gate = stage2.gateMainBiologicalCloud(dataset, structural, null);
    const retainedMain = countMask(gate.scatterMask, 0, dataset.mainCount);
    const retainedContaminants = countMask(gate.scatterMask, dataset.mainCount);
    return {
      pass: !gate.skipped
        && gate.mainComponent.mean[0] > 80
        && gate.scatterMask[0] === 0
        && retainedMain >= 285
        && retainedContaminants <= 5,
      detail: JSON.stringify({
        mean: gate.mainComponent.mean,
        retainedMain,
        retainedContaminants,
        converged: gate.converged,
      }),
    };
  });

  run('Stage 2: skips cleanly when FSC/SSC are absent', () => {
    const gate = stage2.gateMainBiologicalCloud({
      eventCount: 3,
      channels: { DNA_A: [1, 2, 3], FSC_A: null, SSC_A: null },
    });
    return {
      pass: gate.skipped && gate.scatterMask === null && gate.components.length === 0,
      detail: gate.reason,
    };
  });

  run('Stage 3: A/H robust ridge retains singlets and removes injected doublets', () => {
    const dataset = TestUtils.buildPulseGeometryDataset(false);
    const inputMask = new Uint8Array(dataset.eventCount);
    inputMask.fill(1);
    inputMask[0] = 0;
    const gate = stage3.gateByPulseGeometry(dataset, inputMask, { kMAD: 5 });
    const retainedSinglets = countMask(gate.singletMask, 0, dataset.singletCount);
    const retainedDoublets = countMask(gate.singletMask, dataset.singletCount);
    return {
      pass: !gate.skipped
        && gate.geometryMode === 'DNA_A_vs_DNA_H'
        && gate.singletMask[0] === 0
        && retainedSinglets >= 225
        && retainedDoublets <= 2,
      detail: JSON.stringify({ retainedSinglets, retainedDoublets, threshold: gate.threshold }),
    };
  });

  run('Stage 3: falls back to A/W when height is unavailable', () => {
    const dataset = TestUtils.buildPulseGeometryDataset(true);
    const gate = stage3.gateByPulseGeometry(dataset, null, { kMAD: 5 });
    const retainedDoublets = countMask(gate.singletMask, dataset.singletCount);
    return {
      pass: !gate.skipped
        && gate.geometryMode === 'DNA_A_vs_DNA_W'
        && gate.secondaryChannelName === 'DNA_W'
        && retainedDoublets <= 2,
      detail: JSON.stringify({ mode: gate.geometryMode, retainedDoublets }),
    };
  });

  run('Stage 3: no H/W skip preserves the input mask and recommends aggregate modeling', () => {
    const inputMask = Uint8Array.from([1, 0, 1, 1]);
    const gate = stage3.gateByPulseGeometry({
      eventCount: 4,
      channels: { DNA_A: Float64Array.from([1, 2, 3, 4]), DNA_H: null, DNA_W: null },
    }, inputMask);
    return {
      pass: gate.skipped
        && gate.optionalAggregateTermRecommended
        && Array.from(gate.singletMask).join('') === '1011',
      detail: JSON.stringify({ reason: gate.reason, mask: Array.from(gate.singletMask) }),
    };
  });

  run('Stage 4: masked hand-computed histogram has exact counts and retains zero', () => {
    const histogram = stage4.generateHistogram(
      Float64Array.from([0, 1, 2, 3, 4, 5, NaN]),
      Uint8Array.from([1, 1, 0, 1, 1, 1, 1]),
      { binCount: 3, range: [0, 6] },
    );
    return {
      pass: histogram.y.join(',') === '2,1,2'
        && histogram.retainedCount === 5
        && histogram.binnedCount === 5,
      detail: JSON.stringify(histogram),
    };
  });

  run('Stage 4: bin centers are strictly increasing centers, not edges', () => {
    const histogram = stage4.generateHistogram([0, 1, 3, 5], null, {
      binCount: 3, range: [0, 6],
    });
    const increasing = histogram.x.every((value, index) =>
      index === 0 || value > histogram.x[index - 1]
    );
    return {
      pass: increasing && histogram.x.join(',') === '1,3,5' && histogram.binWidth === 2,
      detail: JSON.stringify({ x: histogram.x, width: histogram.binWidth }),
    };
  });

  return results;
}"""


_STAGES_5_TO_8 = r"""() => {
  const { stage5, stage6, stage7, stage8 } = window.PhaseFinder.pipeline;
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

  const histogram = TestUtils.buildDJFHistogram(256);
  let fit = null;

  run('Stage 5: detects the deterministic 1C/2C pair at an approximately 2:1 ratio', () => {
    const peaks = stage5.detectDNAContentPeaks(histogram.y, {
      histogramMin: histogram.min,
      binWidth: histogram.binWidth,
    });
    return {
      pass: peaks.found && peaks.ratio >= 1.8 && peaks.ratio <= 2.1,
      detail: JSON.stringify({ found: peaks.found, mu1: peaks.mu1, mu2: peaks.mu2, ratio: peaks.ratio }),
    };
  });

  run('Stage 5: a single-peak histogram reports no valid pair', () => {
    const onePeak = histogram.x.map((x) =>
      800 * Math.exp(-0.5 * Math.pow((x - 64000) / 4500, 2))
    );
    const peaks = stage5.detectDNAContentPeaks(onePeak, {
      histogramMin: histogram.min,
      binWidth: histogram.binWidth,
    });
    return {
      pass: !peaks.found && peaks.candidatePairs.length === 0,
      detail: peaks.status,
    };
  });

  run('Stage 6: constrained DJF fit converges with G1 in range and G2/G1 near two', () => {
    fit = stage6.fitCellCycleHistogram(histogram.x, histogram.y);
    const ratio = fit.parameters.mu2 / fit.parameters.mu1;
    return {
      pass: fit.diagnostics.converged
        && fit.parameters.mu1 > 52000
        && fit.parameters.mu1 < 76000
        && ratio > 1.9
        && ratio < 2.1,
      detail: JSON.stringify({
        converged: fit.diagnostics.converged,
        iterations: fit.diagnostics.iterations,
        mu1: fit.parameters.mu1,
        mu2: fit.parameters.mu2,
        ratio,
      }),
    };
  });

  run('Stage 6: fitted total equals the nonnegative G1 + S + G2 components', () => {
    if (!fit) fit = stage6.fitCellCycleHistogram(histogram.x, histogram.y);
    let maximumDifference = 0;
    let allNonnegative = true;
    for (let i = 0; i < fit.curves.x.length; i += 1) {
      const sum = fit.curves.g1[i] + fit.curves.s[i] + fit.curves.g2[i];
      maximumDifference = Math.max(maximumDifference, Math.abs(sum - fit.curves.fitted[i]));
      allNonnegative = allNonnegative
        && fit.curves.g1[i] >= 0 && fit.curves.s[i] >= 0 && fit.curves.g2[i] >= 0;
    }
    return {
      pass: allNonnegative && maximumDifference < 1e-9,
      detail: `maximumDifference=${maximumDifference}`,
    };
  });

  run('Stage 7: a 2C-multiple residual is detected and selects the aggregate extension', () => {
    if (!fit) fit = stage6.fitCellCycleHistogram(histogram.x, histogram.y);
    const perfectBase = {
      ...fit,
      curves: {
        ...fit.curves,
        observed: [...fit.curves.fitted],
        residuals: new Array(fit.curves.x.length).fill(0),
      },
    };
    const parameters = stage7.parametersFromPreviousFit(
      perfectBase,
      histogram.x,
      perfectBase.curves.fitted,
    );
    const aggregateTemplate = histogram.x.map((x) =>
      0.5 * stage7.evaluateBaseAt(x / 2, parameters).total
    );
    const aggregateObserved = perfectBase.curves.fitted.map((value, index) =>
      value + 0.8 * aggregateTemplate[index]
    );
    const aggregatePrevious = {
      ...perfectBase,
      curves: {
        ...perfectBase.curves,
        observed: aggregateObserved,
        residuals: perfectBase.curves.fitted.map((value, index) =>
          value - aggregateObserved[index]
        ),
      },
    };
    const extended = stage7.extendCellCycleFit(
      histogram.x,
      aggregateObserved,
      aggregatePrevious,
    );
    const aggregateArea = extended.curves.aggregate.reduce((sum, value) => sum + value, 0);
    return {
      pass: extended.inspection.aggregateDetected
        && extended.selectedModel.includes('aggregate')
        && extended.parameters.pAggregate > 0
        && aggregateArea > 0,
      detail: JSON.stringify({
        selectedModel: extended.selectedModel,
        pAggregate: extended.parameters.pAggregate,
        detected: extended.inspection.aggregateDetected,
        excessZ: extended.inspection.aggregateExcessZ,
        correlation: extended.inspection.aggregateCorrelation,
      }),
    };
  });

  run('Stage 7: clean residuals conservatively retain the base model', () => {
    if (!fit) fit = stage6.fitCellCycleHistogram(histogram.x, histogram.y);
    const perfectBase = {
      ...fit,
      curves: {
        ...fit.curves,
        observed: [...fit.curves.fitted],
        residuals: new Array(fit.curves.x.length).fill(0),
      },
    };
    const extended = stage7.extendCellCycleFit(
      histogram.x,
      perfectBase.curves.fitted,
      perfectBase,
    );
    return {
      pass: !extended.inspection.aggregateDetected
        && !extended.inspection.debrisDetected
        && extended.selectedModel === 'base'
        && extended.diagnostics.candidateFits.length === 1,
      detail: JSON.stringify({
        selectedModel: extended.selectedModel,
        inspection: extended.inspection,
        candidates: extended.diagnostics.candidateFits.map((candidate) => candidate.name),
      }),
    };
  });

  run('Stage 8: biological-singlet fractions sum to 100% and display as percentages', () => {
    if (!fit) fit = stage6.fitCellCycleHistogram(histogram.x, histogram.y);
    const report = stage8.summarizeCellCycleFit(fit, { pulseGeometryAvailable: true });
    const fractions = report.fractions.biologicalSinglets;
    const total = fractions.oneC + fractions.sPhase + fractions.twoC;
    const display = stage8.createDisplaySummary(report);
    return {
      pass: Math.abs(total - 1) < 1e-9
        && report.areas.biologicalSingletTotal > 0
        && display.cellCycle.oneC.endsWith('%')
        && display.cellCycle.sPhase.endsWith('%')
        && display.cellCycle.twoC.endsWith('%'),
      detail: JSON.stringify({ fractions, total, display: display.cellCycle }),
    };
  });

  run('Stage 8: one-peak, ratio-off, and missing-geometry warnings all fire', () => {
    if (!fit) fit = stage6.fitCellCycleHistogram(histogram.x, histogram.y);
    const zeros = new Array(fit.curves.x.length).fill(0);
    const fitted = fit.curves.g1.map((value, index) => value + fit.curves.s[index]);
    const warningFit = {
      ...fit,
      parameters: {
        ...fit.parameters,
        R: 1.6,
        mu2: 1.6 * fit.parameters.mu1,
        a2: 0,
      },
      curves: {
        ...fit.curves,
        g2: zeros,
        fitted,
        observed: [...fitted],
        residuals: [...zeros],
      },
    };
    const report = stage8.summarizeCellCycleFit(warningFit, {
      pulseGeometryAvailable: false,
    });
    const codes = report.warnings.map((warning) => warning.code);
    return {
      pass: codes.includes('ONLY_ONE_VISIBLE_PEAK')
        && codes.includes('RATIO_FAR_FROM_EXPECTED')
        && codes.includes('NO_PULSE_GEOMETRY_CHANNELS')
        && report.qualityChecks.passed === false,
      detail: codes.join(', '),
    };
  });

  return results;
}"""


_PIPELINE_HELPERS = r"""() => {
  const pipeline = window.PhaseFinder.pipeline;
  const stateHelpers = window.DJFPipelineState;
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
  const makeRow = (name) => ({
    id: `${name}-id`,
    name,
    data: {
      channel_key: 'DAPI-A',
      eventCount: 6,
      channels: {
        DNA_A: Float64Array.from([0, 1, 2, 3, 4, 5]),
        DNA_H: null,
        DNA_W: null,
        FSC_A: null,
        SSC_A: null,
        Time: null,
      },
      pnr: { DNA_A: 10, DNA_H: null, DNA_W: null, FSC_A: null, SSC_A: null, Time: null },
      masks: { structural: null, timeQC: null, scatter: null, singlet: null, final: null },
    },
  });

  run('pipeline state: combine_masks ANDs present masks and ignores null optionals', () => {
    const combined = stateHelpers.combine_masks(
      Uint8Array.from([1, 1, 0, 1]),
      null,
      Uint8Array.from([1, 0, 1, 1]),
    );
    return {
      pass: Array.from(combined).join('') === '1001',
      detail: Array.from(combined).join(''),
    };
  });

  run('pipeline orchestrator: optional skips remain null while final mask preserves Stage 0', () => {
    const row = makeRow('unit-orchestrator-skips');
    pipeline.clear_state(row.name);
    pipeline.run_stage0(row);
    const time = pipeline.run_stage1(row).result;
    const scatter = pipeline.run_stage2(row).result;
    const singlet = pipeline.run_stage3(row).result;
    const histogram = pipeline.run_stage4(row, { binCount: 3, range: [0, 6] }).result;
    const state = pipeline.get_state(row.name);
    const finalMask = Array.from(row.data.masks.final).join('');
    return {
      pass: time.skipped && scatter.skipped && singlet.skipped
        && row.data.masks.timeQC === null
        && row.data.masks.scatter === null
        && row.data.masks.singlet === null
        && finalMask === '111111'
        && histogram.binnedCount === 6
        && state.histogram === histogram
        && state.lastStageRun === 4,
      detail: JSON.stringify({ finalMask, bins: histogram.y, lastStageRun: state.lastStageRun }),
    };
  });

  run('pipeline orchestrator: rerunning an earlier stage invalidates downstream products', () => {
    const row = makeRow('unit-orchestrator-invalidation');
    pipeline.clear_state(row.name);
    pipeline.run_stage0(row);
    pipeline.run_stage4(row, { binCount: 3, range: [0, 6] });
    const state = pipeline.get_state(row.name);
    state.peaks = { found: true };
    state.baseFit = { fake: true };
    state.extendedFit = { fake: true };
    state.report = { fake: true };
    pipeline.run_stage3(row);
    return {
      pass: state.histogram === null
        && state.peaks === null
        && state.baseFit === null
        && state.extendedFit === null
        && state.report === null
        && state.lastStageRun === 3,
      detail: JSON.stringify({
        histogram: state.histogram,
        peaks: state.peaks,
        baseFit: state.baseFit,
        lastStageRun: state.lastStageRun,
      }),
    };
  });

  run('pipeline orchestrator: dependent stages fail clearly when Stage 4 has not run', () => {
    const row = makeRow('unit-orchestrator-dependency');
    pipeline.clear_state(row.name);
    pipeline.run_stage0(row);
    let message = '';
    try {
      pipeline.run_stage6(row);
    } catch (error) {
      message = error.message;
    }
    return { pass: /Stage 4 before Stage 6/.test(message), detail: message };
  });

  run('pipeline orchestrator: manual Stage 2 translation replaces the mask and reset restores it', () => {
    const scatter = TestUtils.buildScatterDataset();
    const row = {
      id: 'unit-manual-scatter-id',
      name: 'unit-manual-scatter',
      data: {
        ...scatter,
        channel_key: 'DAPI-A',
        channels: {
          DNA_A: Float64Array.from({ length: scatter.eventCount }, () => 1),
          DNA_H: null,
          DNA_W: null,
          FSC_A: scatter.channels.FSC_A,
          SSC_A: scatter.channels.SSC_A,
          Time: null,
        },
        pnr: { DNA_A: 10, DNA_H: null, DNA_W: null, FSC_A: null, SSC_A: null, Time: null },
        masks: { structural: null, timeQC: null, scatter: null, singlet: null, final: null },
      },
    };
    pipeline.clear_state(row.name);
    pipeline.run_stage0(row);
    const fitted = pipeline.run_stage2(row).result;
    const fittedMean = [...fitted.mainComponent.mean];
    const fittedMask = Array.from(fitted.scatterMask);
    const state = pipeline.get_state(row.name);
    Object.assign(state, {
      singletResult: { stale: true }, histogram: { stale: true },
      peaks: { stale: true }, baseFit: { stale: true },
      extendedFit: { stale: true }, report: { stale: true },
    });

    const moved = pipeline.update_stage2_gate(row, {
      mean: [fittedMean[0] + 8, fittedMean[1]],
    }).result;
    const changedEvents = fittedMask.reduce(
      (count, value, index) => count + (value !== moved.scatterMask[index] ? 1 : 0),
      0,
    );
    const movedFilteredCount = row.data.filtered.eventCount;
    const resized = pipeline.update_stage2_gate(row, { coverage: 0.8 }).result;
    const expectedThreshold = -2 * Math.log(1 - 0.8);
    const resizedFilteredCount = row.data.filtered.eventCount;
    const reset = pipeline.update_stage2_gate(row, { reset: true }).result;
    const restored = fittedMask.every((value, index) => value === reset.scatterMask[index]);
    return {
      pass: moved.manualOverride != null
        && moved.gateSource === 'manual'
        && moved.mainComponent.mean[0] === fittedMean[0] + 8
        && moved.fittedMainComponent.mean[0] === fittedMean[0]
        && changedEvents > 0
        && movedFilteredCount === moved.retainedEventCount
        && resized.mainComponent.mean.join(',') === moved.mainComponent.mean.join(',')
        && Math.abs(resized.threshold - expectedThreshold) < 1e-12
        && Math.abs(resized.manualOverride?.coverage - 0.8) < 1e-12
        && resized.retainedEventCount < moved.retainedEventCount
        && resizedFilteredCount === resized.retainedEventCount
        && state.singletResult === null && state.histogram === null
        && state.baseFit === null && state.report === null
        && row.data.masks.scatter === reset.scatterMask
        && reset.manualOverride === null && reset.gateSource === 'fitted'
        && reset.mainComponent.mean.join(',') === fittedMean.join(',')
        && reset.threshold === fitted.threshold
        && restored,
      detail: JSON.stringify({
        fittedMean,
        movedMean: moved.manualOverride?.mean,
        changedEvents,
        movedFilteredCount,
        movedRetained: moved.retainedEventCount,
        resizedCoverage: resized.manualOverride?.coverage,
        resizedThreshold: resized.threshold,
        resizedRetained: resized.retainedEventCount,
        resetMean: reset.mainComponent.mean,
        restored,
      }),
    };
  });

  run('pipeline state: clear_state removes a per-sample state entry', () => {
    const row = makeRow('unit-orchestrator-clear');
    pipeline.run_stage0(row);
    const existed = pipeline.get_state(row.name) !== null;
    pipeline.clear_state(row.name);
    return {
      pass: existed && pipeline.get_state(row.name) === null,
      detail: `existed=${existed}`,
    };
  });

  return results;
}"""


def run_djf_pipeline_tests(ctx: TestContext):
    """Run isolated stage groups and record every JS assertion."""

    for suite_name, source in (
        ("Stages 0-4", _STAGES_0_TO_4),
        ("Stages 5-8", _STAGES_5_TO_8),
        ("orchestrator/state helpers", _PIPELINE_HELPERS),
    ):
        try:
            all_results = ctx.page.evaluate(source)
        except Exception as err:
            ctx.check(
                GROUP,
                f"{suite_name} suite setup",
                False,
                str(err),
                screenshot=False,
            )
            continue

        for item in all_results:
            ctx.check(
                GROUP,
                item["name"],
                item["pass"],
                item.get("detail", ""),
                screenshot=False,
            )
