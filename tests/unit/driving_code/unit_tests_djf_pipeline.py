#!/usr/bin/env python3
"""Browser unit coverage for the staged Dean-Jett-Fox pipeline.

The harness imports the real ES modules and these snippets exercise each stage
directly. Synthetic inputs are deterministic so failures identify algorithm or
mask-regression changes rather than random test data.
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / DJF Pipeline"


_STAGES_0_TO_4 = r"""() => {
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
  const countMask = (mask, start = 0, end = mask.length) => {
    let count = 0;
    for (let i = start; i < end; i += 1) count += mask[i];
    return count;
  };

  run('harness: exposes the pipeline stage modules and runners', () => {
    const modules = ['structuralQc', 'timeQc', 'cellGate', 'singletGate', 'dnaHistogram'];
    const modulesPresent = modules.every((name) => Boolean(pipeline[name]));
    return {
      pass: modulesPresent
        && typeof pipeline.apply_structural_qc === 'function'
        && typeof pipeline.apply_dna_histogram === 'function'
        && typeof window.DJFPipelineState.combine_masks === 'function',
      detail: `modulesPresent=${modulesPresent}`,
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

  run('Stage 0: structural mask keeps zero, rejects nonfinite/negative on all channels and saturation on DNA only', () => {
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
    const qc = structuralQc.runStructuralQC(dataset);
    const actual = Array.from(qc.structuralMask).join('');
    // Event 4 (DNA_A at its PnR ceiling) is rejected -- saturated DNA content.
    // Event 5 (FSC_A at its ceiling) is NOW KEPT: the saturation ceiling is
    // DNA-only, so scatter saturation no longer strips events (which on real
    // data preferentially removed the large-cell G2/M population). Event 6
    // (SSC_A = -1) is still rejected: the non-negative check remains on every
    // channel. Event 1 (DNA_A = -1) and event 2 (DNA_H = NaN) are rejected too.
    return {
      pass: actual === '10010101'
        && qc.retainedEventCount === 4
        && qc.rejectedEventCount === 4,
      detail: `mask=${actual}, retained=${qc.retainedEventCount}`,
    };
  });

  run('Stage 0: Time is exempt from its PnR upper bound', () => {
    const mask = structuralQc.createStructuralValidityMask({
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
    const prepared = timeQc.prepareTimeQCBins(
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
    const qc = timeQc.runTimeQC(dataset, structural, {
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
    const qc = timeQc.runTimeQC({ eventCount: 3, channels: { DNA_A: [1, 2, 3], Time: null } });
    return {
      pass: qc.skipped && qc.timeQCMask === null && /no Time/.test(qc.reason),
      detail: JSON.stringify(qc),
    };
  });

  // ---- QC-03: harden robust-summary acquisition Time QC --------------------
  run('QC-03: calculateBinEventRate uses (n-1)/duration exactly (SCI-12)', () => {
    // 5 events at t = 0,1,2,3,4 span 4 intervals over duration 4 -> rate 1.0.
    const rate = timeQc.calculateBinEventRate({ indexes: [0, 1, 2, 3, 4] }, [0, 1, 2, 3, 4]);
    return { pass: Math.abs(rate - 1.0) < 1e-12, detail: String(rate) };
  });

  run('QC-03: disabling the event-rate check excludes eventRate from scoring entirely', () => {
    const dataset = TestUtils.buildTimeQCDataset();
    const structural = new Uint8Array(dataset.eventCount); structural.fill(1);
    const base = { targetBinSize: dataset.eventsPerBin, timerRange: 1000, threshold: 4 };
    const on = timeQc.runTimeQC(dataset, structural, { ...base, includeEventRateCheck: true });
    const off = timeQc.runTimeQC(dataset, structural, { ...base, includeEventRateCheck: false });
    const offTouchesEventRate = off.activeMetrics.includes('eventRate')
      || off.scoredBins.some((bin) => bin.reasons.includes('eventRate'));
    return {
      pass: on.activeMetrics.includes('eventRate')
        && off.disabledMetrics.join(',') === 'eventRate'
        && !offTouchesEventRate,
      detail: JSON.stringify({ onActive: on.activeMetrics.includes('eventRate'), offDisabled: off.disabledMetrics }),
    };
  });

  run('QC-03: a too-few-bin acquisition is not_evaluable and removes no events', () => {
    const n = 10;
    const dataset = {
      eventCount: n,
      channels: {
        DNA_A: Array.from({ length: n }, (_, i) => 100 + i),
        FSC_A: Array.from({ length: n }, () => 50),
        SSC_A: Array.from({ length: n }, () => 50),
        Time: Array.from({ length: n }, (_, i) => i),
      },
      pnr: { Time: 1000 },
    };
    const qc = timeQc.runTimeQC(dataset, null, { targetBinSize: 5, timerRange: 1000, threshold: 4 });
    return {
      pass: qc.notEvaluable === true && qc.binCount < 3 && qc.rejectedEventCount === 0
        && qc.limitedReliability === true && /not evaluable/.test(qc.status),
      detail: JSON.stringify({ bins: qc.binCount, rejected: qc.rejectedEventCount, status: qc.status }),
    };
  });

  run('QC-03: a zero-MAD (degenerate) metric marks the run limited-reliability without removing events', () => {
    const n = 30;
    const dataset = {
      eventCount: n,
      channels: {
        DNA_A: Array.from({ length: n }, () => 100),
        FSC_A: Array.from({ length: n }, () => 50),
        SSC_A: Array.from({ length: n }, () => 50),
        Time: Array.from({ length: n }, (_, i) => i),
      },
      pnr: { Time: 1000 },
    };
    const qc = timeQc.runTimeQC(dataset, null, { targetBinSize: 5, timerRange: 1000, threshold: 4 });
    return {
      pass: qc.binCount >= 3 && qc.degenerateMetrics.length > 0 && qc.limitedReliability === true
        && qc.rejectedEventCount === 0,
      detail: JSON.stringify({ bins: qc.binCount, degenerate: qc.degenerateMetrics, limited: qc.limitedReliability }),
    };
  });

  run('Stage 2: chooses the high-FSC main component and gates its tight ellipse', () => {
    const dataset = TestUtils.buildScatterDataset();
    const structural = new Uint8Array(dataset.eventCount);
    structural.fill(1);
    structural[0] = 0;
    const gate = cellGate.gateMainBiologicalCloud(dataset, structural, null);
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
    const gate = cellGate.gateMainBiologicalCloud({
      eventCount: 3,
      channels: { DNA_A: [1, 2, 3], FSC_A: null, SSC_A: null },
    });
    return {
      pass: gate.skipped && gate.scatterMask === null && gate.components.length === 0,
      detail: gate.reason,
    };
  });

  run('SCI-09A: scatter fit is invariant to independent FSC/SSC instrument scale', () => {
    const base = TestUtils.buildScatterDataset();
    const scaled = {
      ...base,
      channels: {
        ...base.channels,
        FSC_A: Array.from(base.channels.FSC_A, value => 17 * value + 9000),
        SSC_A: Array.from(base.channels.SSC_A, value => 0.03 * value - 40),
      },
    };
    const first = cellGate.gateMainBiologicalCloud(base);
    const second = cellGate.gateMainBiologicalCloud(scaled);
    return {
      pass: first.scatterTransform.method === 'robust_zscore'
        && second.scatterTransform.method === 'robust_zscore'
        && Array.from(first.scatterMask).every((value, index) => value === second.scatterMask[index]),
      detail: JSON.stringify({ first: first.scatterTransform, second: second.scatterTransform }),
    };
  });

  run('SCI-09A: small high-FSC doublet component does not replace the main population', () => {
    const fsc = [], ssc = [];
    for (let i = 0; i < 240; i++) {
      fsc.push(100 + 5 * Math.sin(i * 1.7));
      ssc.push(80 + 4 * Math.cos(i * 1.3));
    }
    for (let i = 0; i < 45; i++) {
      fsc.push(205 + 4 * Math.sin(i * 1.1));
      ssc.push(160 + 3 * Math.cos(i * 1.9));
    }
    const gate = cellGate.gateMainBiologicalCloud({
      eventCount: fsc.length,
      channels: { FSC_A: fsc, SSC_A: ssc },
    });
    return {
      pass: gate.mainComponent.mean[0] < 150
        && gate.componentMetrics[gate.mainComponentIndex].weight > 0.7,
      detail: JSON.stringify({ mean: gate.mainComponent.mean, metrics: gate.componentMetrics }),
    };
  });

  run('SCI-09A: overlapping alternatives are marked review-required', () => {
    const fsc = [], ssc = [];
    for (let i = 0; i < 300; i++) {
      const offset = i < 150 ? -0.5 : 0.5;
      fsc.push(100 + offset + 8 * Math.sin(i * 1.31));
      ssc.push(80 + offset + 8 * Math.cos(i * 1.73));
    }
    const gate = cellGate.gateMainBiologicalCloud({
      eventCount: fsc.length,
      channels: { FSC_A: fsc, SSC_A: ssc },
    });
    return {
      pass: gate.reviewRequired && gate.reviewReasons.length > 0
        && gate.componentMetrics.every(metric => Number.isFinite(metric.compactness)),
      detail: JSON.stringify({ reasons: gate.reviewReasons, metrics: gate.componentMetrics }),
    };
  });

  run('SCI-09A: debris-dominant mixtures require biological review', () => {
    const fsc = [], ssc = [];
    for (let i = 0; i < 180; i++) {
      fsc.push(25 + 3 * Math.sin(i * 1.7));
      ssc.push(18 + 2 * Math.cos(i * 1.1));
    }
    for (let i = 0; i < 120; i++) {
      fsc.push(100 + 5 * Math.sin(i * 1.3));
      ssc.push(80 + 4 * Math.cos(i * 1.9));
    }
    const gate = cellGate.gateMainBiologicalCloud({ eventCount: fsc.length, channels: { FSC_A: fsc, SSC_A: ssc } });
    return {
      pass: gate.reviewRequired && gate.reviewReasons.some(reason => /alternative population/.test(reason)),
      detail: JSON.stringify({ reasons: gate.reviewReasons, weights: gate.componentMetrics.map(x => x.weight) }),
    };
  });

  run('SCI-09A: near-dominant high-FSC doublets require biological review', () => {
    const fsc = [], ssc = [];
    for (let i = 0; i < 165; i++) {
      fsc.push(100 + 4 * Math.sin(i * 1.4));
      ssc.push(80 + 3 * Math.cos(i * 1.8));
    }
    for (let i = 0; i < 135; i++) {
      fsc.push(205 + 5 * Math.sin(i * 1.2));
      ssc.push(160 + 4 * Math.cos(i * 1.6));
    }
    const gate = cellGate.gateMainBiologicalCloud({ eventCount: fsc.length, channels: { FSC_A: fsc, SSC_A: ssc } });
    return {
      pass: gate.reviewRequired && gate.reviewReasons.some(reason => /alternative population/.test(reason)),
      detail: JSON.stringify({ reasons: gate.reviewReasons, weights: gate.componentMetrics.map(x => x.weight) }),
    };
  });

  run('Stage 3: A/H robust ridge retains singlets and removes injected doublets', () => {
    const dataset = TestUtils.buildPulseGeometryDataset(false);
    const inputMask = new Uint8Array(dataset.eventCount);
    inputMask.fill(1);
    inputMask[0] = 0;
    const gate = singletGate.gateByPulseGeometry(dataset, inputMask, { kMAD: 5 });
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
    const gate = singletGate.gateByPulseGeometry(dataset, null, { kMAD: 5 });
    const retainedDoublets = countMask(gate.singletMask, dataset.singletCount);
    return {
      pass: !gate.skipped
        && gate.geometryMode === 'DNA_A_vs_DNA_W'
        && gate.secondaryChannelName === 'DNA_W'
        && retainedDoublets <= 2,
      detail: JSON.stringify({ mode: gate.geometryMode, retainedDoublets }),
    };
  });

  run('SCI-09B: channel policy chooses higher-quality A/W over degraded A/H', () => {
    const dataset = TestUtils.buildPulseGeometryDataset(false);
    dataset.channels.DNA_W = Array.from(dataset.channels.DNA_A, (value, index) =>
      0.45 * value + 2 * Math.sin(index));
    dataset.channels.DNA_H = Array.from(dataset.channels.DNA_H, (value, index) =>
      index % 3 ? NaN : value);
    const geometry = singletGate.selectPulseGeometry(dataset);
    return {
      pass: geometry.geometryMode === 'DNA_A_vs_DNA_W'
        && geometry.selectionEvidence.length === 2
        && geometry.selectionEvidence.every(item => Number.isFinite(item.correlation)),
      detail: JSON.stringify(geometry.selectionEvidence),
    };
  });

  run('SCI-09B: independent channel gain changes preserve the singlet mask', () => {
    const dataset = TestUtils.buildPulseGeometryDataset(false);
    const scaled = {
      ...dataset,
      channels: {
        ...dataset.channels,
        DNA_A: Array.from(dataset.channels.DNA_A, value => 13 * value + 7000),
        DNA_H: Array.from(dataset.channels.DNA_H, value => 0.07 * value - 30),
      },
    };
    const first = singletGate.gateByPulseGeometry(dataset, null, { kMAD: 5 });
    const second = singletGate.gateByPulseGeometry(scaled, null, { kMAD: 5 });
    return {
      pass: first.pulseGeometryTransform.method === 'robust_zscore'
        && Array.from(first.singletMask).every((value, index) => value === second.singletMask[index]),
      detail: JSON.stringify({ first: first.pulseGeometryTransform, second: second.pulseGeometryTransform }),
    };
  });

  run('SCI-09B: labeled synthetic truth has high singlet sensitivity and doublet specificity', () => {
    const dataset = TestUtils.buildPulseGeometryDataset(false);
    const gate = singletGate.gateByPulseGeometry(dataset, null, { kMAD: 5 });
    const truePositive = countMask(gate.singletMask, 0, dataset.singletCount);
    const trueNegative = dataset.doubletCount
      - countMask(gate.singletMask, dataset.singletCount);
    const sensitivity = truePositive / dataset.singletCount;
    const specificity = trueNegative / dataset.doubletCount;
    return {
      pass: sensitivity >= 0.95 && specificity >= 0.95,
      detail: JSON.stringify({ sensitivity, specificity, ratio: gate.ridgeIdentificationRatio }),
    };
  });

  run('SCI-09B: poorly identified pulse geometry is review-required', () => {
    const area = [], height = [];
    for (let i = 0; i < 120; i++) {
      area.push(100 + 10 * Math.sin(i * 1.7));
      height.push(80 + 10 * Math.cos(i * 1.3));
    }
    const gate = singletGate.gateByPulseGeometry({
      eventCount: area.length,
      channels: { DNA_A: area, DNA_H: height, DNA_W: null },
    });
    return {
      pass: gate.reviewRequired && /poorly identified/.test(gate.reason),
      detail: JSON.stringify({ reason: gate.reason, ratio: gate.ridgeIdentificationRatio }),
    };
  });

  run('Stage 3: no H/W skip preserves the input mask and recommends aggregate modeling', () => {
    const inputMask = Uint8Array.from([1, 0, 1, 1]);
    const gate = singletGate.gateByPulseGeometry({
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

  // ---- QC-05: never apply an invalid scatter GMM -------------------------
  run('QC-05: underpowered scatter fit is flagged limited-reliability (mask withheld)', () => {
    const n = 30;
    const fsc = [], ssc = [];
    for (let i = 0; i < n; i += 1) {
      if (i < 20) { fsc.push(100 + 5 * Math.sin(i * 1.7)); ssc.push(80 + 4 * Math.cos(i * 1.3)); }
      else { fsc.push(30 + 4 * Math.sin(i * 1.1)); ssc.push(25 + 3 * Math.cos(i * 1.9)); }
    }
    const gate = cellGate.gateMainBiologicalCloud({
      eventCount: n, channels: { FSC_A: fsc, SSC_A: ssc },
    });
    return {
      pass: !gate.skipped && gate.reviewRequired && gate.limitedReliability === true
        && gate.fittedEventCount < cellGate.RELIABLE_SCATTER_EVENTS
        && gate.reviewReasons.some(reason => /underpowered/.test(reason)),
      detail: JSON.stringify({ reasons: gate.reviewReasons, fitted: gate.fittedEventCount }),
    };
  });

  run('QC-05: a non-converged scatter fit is flagged and not silently applied', () => {
    const dataset = TestUtils.buildScatterDataset();
    const gate = cellGate.gateMainBiologicalCloud(dataset, null, null, {
      gmmOptions: { maxIterations: 1 },
    });
    return {
      pass: !gate.skipped && gate.converged === false && gate.reviewRequired
        && gate.limitedReliability === true
        && gate.reviewReasons.some(reason => /did not converge/.test(reason)),
      detail: JSON.stringify({ converged: gate.converged, reasons: gate.reviewReasons }),
    };
  });

  run('QC-05: a near-singular (collinear) covariance is flagged near-singular', () => {
    const fsc = [], ssc = [];
    for (let i = 0; i < 120; i += 1) { fsc.push(i); ssc.push(2 * i); }
    const gate = cellGate.gateMainBiologicalCloud({
      eventCount: fsc.length, channels: { FSC_A: fsc, SSC_A: ssc },
    });
    return {
      pass: !gate.skipped && gate.reviewRequired && gate.limitedReliability === true
        && gate.reviewReasons.some(reason => /near-singular/.test(reason)),
      detail: JSON.stringify({ reasons: gate.reviewReasons, condition: gate.componentMetrics.map(m => m.covarianceCondition) }),
    };
  });

  run('QC-05: a clean, well-powered, well-separated scatter fit does not trip QC-05 flags', () => {
    const gate = cellGate.gateMainBiologicalCloud(TestUtils.buildScatterDataset());
    const qc05Tripped = gate.reviewReasons.some(reason =>
      /underpowered|near-singular|implausibly small/.test(reason));
    return {
      pass: !gate.skipped && !qc05Tripped
        && gate.coverageFraction > 0.1
        && gate.mainComponentEffectiveCount > cellGate.MINIMUM_COMPONENT_EVENTS
        && gate.limitedReliability === gate.reviewRequired,
      detail: JSON.stringify({
        reasons: gate.reviewReasons, coverage: gate.coverageFraction,
        effective: gate.mainComponentEffectiveCount,
      }),
    };
  });

  // ---- QC-06: never apply an invalid pulse-geometry singlet ridge --------
  run('QC-06: underpowered pulse-geometry fit is flagged limited-reliability (mask withheld)', () => {
    const n = 30;
    const area = [], height = [];
    for (let i = 0; i < n; i += 1) {
      area.push(50000 + i * 280);
      height.push(0.52 * area[i] + (((i * 37) % 23) - 11) * 18);
    }
    const gate = singletGate.gateByPulseGeometry({
      eventCount: n, channels: { DNA_A: area, DNA_H: height, DNA_W: null },
    });
    return {
      pass: !gate.skipped && gate.reviewRequired && gate.limitedReliability === true
        && gate.fittedEventCount < singletGate.RELIABLE_PULSE_GEOMETRY_EVENTS
        && gate.reviewReasons.some(reason => /underpowered/.test(reason)),
      detail: JSON.stringify({ reasons: gate.reviewReasons, fitted: gate.fittedEventCount }),
    };
  });

  run('QC-06: a degenerate (collinear) ridge scale is flagged and not applied', () => {
    const n = 60;
    const area = [], height = [];
    for (let i = 0; i < n; i += 1) { area.push(50000 + i * 280); height.push(0.52 * area[i]); }
    const gate = singletGate.gateByPulseGeometry({
      eventCount: n, channels: { DNA_A: area, DNA_H: height, DNA_W: null },
    });
    return {
      pass: !gate.skipped && gate.reviewRequired && gate.limitedReliability === true
        && gate.reviewReasons.some(reason => /degenerate/.test(reason)),
      detail: JSON.stringify({ reasons: gate.reviewReasons, ratio: gate.ridgeIdentificationRatio }),
    };
  });

  run('QC-06: a non-converged ridge fit (iteration cap) is flagged and not applied', () => {
    const gate = singletGate.gateByPulseGeometry(TestUtils.buildPulseGeometryDataset(false), null, {
      kMAD: 5, ridgeOptions: { maxIterations: 1, convergenceTolerance: 1e-12 },
    });
    return {
      pass: !gate.skipped && gate.converged === false && gate.reviewRequired
        && gate.limitedReliability === true
        && gate.reviewReasons.some(reason => /did not converge/.test(reason)),
      detail: JSON.stringify({ converged: gate.converged, reasons: gate.reviewReasons }),
    };
  });

  run('QC-06: a clean, well-powered singlet ridge does not trip QC-06 flags', () => {
    const gate = singletGate.gateByPulseGeometry(TestUtils.buildPulseGeometryDataset(false), null, { kMAD: 5 });
    const qc06Tripped = gate.reviewReasons.some(reason =>
      /underpowered|degenerate|implausibly small/.test(reason));
    return {
      pass: !gate.skipped && !qc06Tripped
        && gate.coverageFraction > 0.5
        && gate.limitedReliability === gate.reviewRequired,
      detail: JSON.stringify({ reasons: gate.reviewReasons, coverage: gate.coverageFraction }),
    };
  });

  run('Stage 4: masked hand-computed histogram has exact counts and retains zero', () => {
    const histogram = dnaHistogram.generateHistogram(
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
    const histogram = dnaHistogram.generateHistogram([0, 1, 3, 5], null, {
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

  run('Stage 4: edges has binCount + 1 boundaries and centers/counts alias x/y', () => {
    const histogram = dnaHistogram.generateHistogram([0, 1, 3, 5], null, {
      binCount: 3, range: [0, 6],
    });
    return {
      pass: histogram.edges.length === 4
        && histogram.edges.join(',') === '0,2,4,6'
        && histogram.centers === histogram.x
        && histogram.counts === histogram.y,
      detail: JSON.stringify({ edges: histogram.edges }),
    };
  });

  run('Stage 4: underflow/overflow are counted, and underflow + binnedCount + overflow === retainedCount', () => {
    // range [2, 8]: 0 and 1 fall below (underflow), 9 falls above (overflow),
    // 2..8 are binned.
    const histogram = dnaHistogram.generateHistogram(
      [0, 1, 2, 5, 8, 9], null, { binCount: 3, range: [2, 8] },
    );
    return {
      pass: histogram.underflow === 2
        && histogram.overflow === 1
        && histogram.binnedCount === 3
        && histogram.underflow + histogram.binnedCount + histogram.overflow === histogram.retainedCount
        && histogram.totalEvents === 6,
      detail: JSON.stringify(histogram),
    };
  });

  run('Stage 4: dnaChannel is echoed back and scale is linear', () => {
    const histogram = dnaHistogram.generateHistogram([1, 2, 3], null, {
      binCount: 2, range: [0, 4], dnaChannel: 'GFP/FITC-A',
    });
    return {
      pass: histogram.dnaChannel === 'GFP/FITC-A' && histogram.scale === 'linear',
      detail: JSON.stringify({ dnaChannel: histogram.dnaChannel, scale: histogram.scale }),
    };
  });

  // ---- QC-02: Time QC cache identity includes every effective option -------
  const robustDefaults = pipeline.timeQc.DEFAULT_ROBUST_SUMMARY_OPTIONS;
  const peakDefaults = window.PeakTrackingTimeQC.DEFAULT_PEAK_TRACKING_OPTIONS;

  run('QC-02: robust-summary cache key changes when includeEventRateCheck toggles (previously omitted)', () => {
    const base = { method: 'robust-summary', ...robustDefaults };
    const k0 = pipeline.time_qc_cache_key(base, false);
    const k1 = pipeline.time_qc_cache_key({ ...base, includeEventRateCheck: !base.includeEventRateCheck }, false);
    return { pass: k0 !== k1, detail: JSON.stringify({ k0, k1 }) };
  });

  run('QC-02: toggling EVERY effective robust-summary option misses the cache', () => {
    const base = { method: 'robust-summary', ...robustDefaults };
    const baseKey = pipeline.time_qc_cache_key(base, false);
    const changed = Object.keys(robustDefaults).map((key) => {
      const value = typeof base[key] === 'boolean' ? !base[key] : base[key] + 1;
      return { key, miss: pipeline.time_qc_cache_key({ ...base, [key]: value }, false) !== baseKey };
    });
    return { pass: changed.every((c) => c.miss), detail: JSON.stringify(changed.filter((c) => !c.miss)) };
  });

  run('QC-02: toggling EVERY effective peak-tracking option (and channel set) misses the cache', () => {
    const base = { method: 'peak-tracking', channels: ['DNA_A'], ...peakDefaults };
    const baseKey = pipeline.time_qc_cache_key(base, false);
    const changed = Object.keys(peakDefaults).map((key) => {
      const cur = base[key];
      const value = typeof cur === 'boolean' ? !cur : (Number.isFinite(cur) ? cur + 1 : 'sentinel');
      return { key, miss: pipeline.time_qc_cache_key({ ...base, [key]: value }, false) !== baseKey };
    });
    const channelMiss = pipeline.time_qc_cache_key({ ...base, channels: ['DNA_A', 'FSC_A'] }, false) !== baseKey;
    return { pass: changed.every((c) => c.miss) && channelMiss, detail: JSON.stringify(changed.filter((c) => !c.miss)) };
  });

  run('QC-02: equivalent configs (key order + channel order + omitted defaults) hit the same key', () => {
    const a = pipeline.time_qc_cache_key({ method: 'peak-tracking', channels: ['DNA_A', 'FSC_A'], madMultiplier: 6, maximumBins: 500 }, true);
    const b = pipeline.time_qc_cache_key({ maximumBins: 500, channels: ['FSC_A', 'DNA_A'], method: 'peak-tracking', madMultiplier: 6 }, true);
    return { pass: a === b, detail: JSON.stringify({ a, b }) };
  });

  run('QC-02: algorithm version and structural conditioning are part of the identity', () => {
    const base = { method: 'robust-summary' };
    const noStruct = pipeline.time_qc_cache_key(base, false);
    const withStruct = pipeline.time_qc_cache_key(base, true);
    const resolved = pipeline.resolve_time_qc_config(base);
    return { pass: noStruct !== withStruct && noStruct.includes(resolved.algorithmVersion), detail: JSON.stringify({ version: resolved.algorithmVersion }) };
  });

  // ---- Fitted-gate fit caches: keys track the composed input + options -----
  run('gate cache: scatter key is stable and changes with mask content, presence, or options', () => {
    const a = Uint8Array.from([1, 1, 0, 1, 1, 0]);
    const b = Uint8Array.from([1, 1, 0, 1, 1, 0]);
    const changed = Uint8Array.from([1, 1, 1, 1, 1, 0]);
    const base = pipeline.cell_gate_cache_key(a, null, { threshold: 5.991 });
    return {
      pass: base === pipeline.cell_gate_cache_key(b, null, { threshold: 5.991 })     // identical content -> hit
        && base !== pipeline.cell_gate_cache_key(changed, null, { threshold: 5.991 })// changed structural -> miss
        && base !== pipeline.cell_gate_cache_key(a, a, { threshold: 5.991 })         // Time QC mask added -> miss
        && base !== pipeline.cell_gate_cache_key(a, null, { threshold: 4.0 }),       // changed options -> miss
      detail: base,
    };
  });

  run('gate cache: singlet key is stable and changes with mask content or options', () => {
    const a = Uint8Array.from([1, 1, 0, 1]);
    const b = Uint8Array.from([1, 1, 0, 1]);
    const changed = Uint8Array.from([1, 0, 0, 1]);
    const base = pipeline.singlet_gate_cache_key(a, { kMAD: 5 });
    return {
      pass: base === pipeline.singlet_gate_cache_key(b, { kMAD: 5 })
        && base !== pipeline.singlet_gate_cache_key(changed, { kMAD: 5 })
        && base !== pipeline.singlet_gate_cache_key(a, { kMAD: 4 }),
      detail: base,
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
    pipeline.apply_structural_qc(row);
    const time = pipeline.apply_time_qc(row).result;
    const scatter = pipeline.apply_cell_gate(row).result;
    const singlet = pipeline.apply_singlet_gate(row).result;
    const histogram = pipeline.apply_dna_histogram(row, { binCount: 3, range: [0, 6] }).result;
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
        && state.lastRunIndex === 4,
      detail: JSON.stringify({ finalMask, bins: histogram.y, lastRunIndex: state.lastRunIndex }),
    };
  });

  run('pipeline orchestrator: rerunning an earlier stage invalidates downstream products', () => {
    const row = makeRow('unit-orchestrator-invalidation');
    pipeline.clear_state(row.name);
    pipeline.apply_structural_qc(row);
    pipeline.apply_dna_histogram(row, { binCount: 3, range: [0, 6] });
    const state = pipeline.get_state(row.name);
    state.peaks = { found: true };
    state.baseFit = { fake: true };
    state.extendedFit = { fake: true };
    state.report = { fake: true };
    pipeline.apply_singlet_gate(row);
    return {
      pass: state.histogram === null
        && state.peaks === null
        && state.baseFit === null
        && state.extendedFit === null
        && state.report === null
        && state.lastRunIndex === 3,
      detail: JSON.stringify({
        histogram: state.histogram,
        peaks: state.peaks,
        baseFit: state.baseFit,
        lastRunIndex: state.lastRunIndex,
      }),
    };
  });

  run('pipeline orchestrator: ensure_histogram_current reuses an unchanged histogram without clearing Stage 5-8', () => {
    // Regression for the "unconditional Stage 4 rerun deletes the Stage 5
    // result before fitting" bug: rebuilding the histogram before Stage 5/6
    // used to unconditionally invalidate downstream products even when the
    // gated view and bin/range request hadn't changed at all.
    const row = makeRow('unit-orchestrator-histogram-reuse');
    pipeline.clear_state(row.name);
    pipeline.apply_structural_qc(row);
    const first = pipeline.apply_dna_histogram(row, { binCount: 3, range: [0, 6] }).result;
    const state = pipeline.get_state(row.name);
    state.peaks = { found: true };
    state.baseFit = { fake: true };

    const reused = pipeline.ensure_histogram_current(row, { binCount: 3, range: [0, 6] }).result;
    return {
      pass: reused === first
        && state.histogram === first
        && state.peaks !== null
        && state.baseFit !== null,
      detail: JSON.stringify({
        sameHistogram: reused === first,
        peaks: state.peaks,
        baseFit: state.baseFit,
      }),
    };
  });

  run('pipeline orchestrator: ensure_histogram_current rebuilds (and invalidates) when the request actually changes', () => {
    const row = makeRow('unit-orchestrator-histogram-rebuild');
    pipeline.clear_state(row.name);
    pipeline.apply_structural_qc(row);
    const first = pipeline.apply_dna_histogram(row, { binCount: 3, range: [0, 6] }).result;
    const state = pipeline.get_state(row.name);
    state.peaks = { found: true };
    state.baseFit = { fake: true };

    // A different bin count is a genuine change; the histogram must rebuild
    // and Stage 5-8 must be invalidated, same as before this fix.
    const rebuilt = pipeline.ensure_histogram_current(row, { binCount: 4, range: [0, 6] }).result;
    return {
      pass: rebuilt !== first
        && state.histogram === rebuilt
        && state.peaks === null
        && state.baseFit === null,
      detail: JSON.stringify({
        rebuilt: rebuilt !== first,
        peaks: state.peaks,
        baseFit: state.baseFit,
      }),
    };
  });

  run('pipeline orchestrator: apply_dna_histogram stamps a self-contained fingerprint/revision on the histogram', () => {
    const row = makeRow('unit-orchestrator-histogram-fingerprint');
    pipeline.clear_state(row.name);
    const first = pipeline.apply_dna_histogram(row, { binCount: 3, range: [0, 6] }).result;
    const fingerprintV1 = first.fingerprint;

    // A mask change bumps the gated-view revision; the fingerprint must
    // change to match even at the same bin count/range, since it's built
    // from row.data.filteredViewRevision, not a separately-tracked sidecar.
    pipeline.apply_structural_qc(row);
    const second = pipeline.apply_dna_histogram(row, { binCount: 3, range: [0, 6] }).result;

    return {
      pass: typeof fingerprintV1 === 'string' && fingerprintV1.length > 0
        && typeof first.revision === 'number'
        && second.fingerprint !== fingerprintV1
        && second.revision > first.revision
        && second.dnaChannel === row.data.channel_key,
      detail: JSON.stringify({
        fingerprintV1, fingerprintV2: second.fingerprint,
        revision1: first.revision, revision2: second.revision,
        dnaChannel: second.dnaChannel,
      }),
    };
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
    pipeline.apply_structural_qc(row);
    const fitted = pipeline.apply_cell_gate(row).result;
    const fittedMean = [...fitted.mainComponent.mean];
    const fittedMask = Array.from(fitted.scatterMask);
    const state = pipeline.get_state(row.name);
    Object.assign(state, {
      singletResult: { stale: true }, histogram: { stale: true },
      peaks: { stale: true }, baseFit: { stale: true },
      extendedFit: { stale: true }, report: { stale: true },
    });

    const moved = pipeline.update_cell_gate(row, {
      mean: [fittedMean[0] + 8, fittedMean[1]],
    }).result;
    const changedEvents = fittedMask.reduce(
      (count, value, index) => count + (value !== moved.scatterMask[index] ? 1 : 0),
      0,
    );
    const movedFilteredCount = row.data.filtered.eventCount;
    const resized = pipeline.update_cell_gate(row, { coverage: 0.8 }).result;
    const expectedThreshold = -2 * Math.log(1 - 0.8);
    const resizedFilteredCount = row.data.filtered.eventCount;
    const reset = pipeline.update_cell_gate(row, { reset: true }).result;
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
    pipeline.apply_structural_qc(row);
    const existed = pipeline.get_state(row.name) !== null;
    pipeline.clear_state(row.name);
    return {
      pass: existed && pipeline.get_state(row.name) === null,
      detail: `existed=${existed}`,
    };
  });

  // QC-05/QC-06: an invalid gate fit must never install a removal mask. These
  // drive the real orchestrator end-to-end and assert the filter mask stays null
  // (upstream mask preserved) while the stored result records why it was withheld.
  run('QC-05: an underpowered scatter fit is not applied as a filter mask (pipeline)', () => {
    const n = 30;
    const fsc = new Float64Array(n);
    const ssc = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      if (i < 20) { fsc[i] = 100 + 5 * Math.sin(i * 1.7); ssc[i] = 80 + 4 * Math.cos(i * 1.3); }
      else { fsc[i] = 30 + 4 * Math.sin(i * 1.1); ssc[i] = 25 + 3 * Math.cos(i * 1.9); }
    }
    const row = {
      id: 'qc05-underpowered-id', name: 'qc05-underpowered',
      data: {
        channel_key: 'DAPI-A', eventCount: n,
        channels: {
          DNA_A: Float64Array.from({ length: n }, () => 1),
          DNA_H: null, DNA_W: null, FSC_A: fsc, SSC_A: ssc, Time: null,
        },
        pnr: { DNA_A: 10, DNA_H: null, DNA_W: null, FSC_A: null, SSC_A: null, Time: null },
        masks: { structural: null, timeQC: null, scatter: null, singlet: null, final: null },
      },
    };
    pipeline.clear_state(row.name);
    pipeline.apply_structural_qc(row);
    const result = pipeline.apply_cell_gate(row).result;
    const state = pipeline.get_state(row.name);
    return {
      pass: !result.skipped && result.reviewRequired && result.limitedReliability === true
        && result.reviewReasons.some(reason => /underpowered/.test(reason))
        && row.data.masks.scatter === null
        && state.scatterGate === result,
      detail: JSON.stringify({ reasons: result.reviewReasons, scatterMask: row.data.masks.scatter }),
    };
  });

  // QC-02/AD-3: before this, the sidebar toggle button read "did this gate
  // succeed" off aria-pressed (which only ever meant "is the toggle on") while
  // the table's QC status column inspected the stage product's raw fields
  // directly -- two independent readings of the same product that could (and
  // did) disagree, so a gate could render "applied" in the sidebar while the
  // table simultaneously said "incomplete: review required". derive_gate_state()
  // is now the one function both call sites (pipeline_ui.js's
  // update_gate_button_states() for the sidebar and update_qc_columns() for the
  // table -- both fed from the same compute_gate_state_matrix() call) delegate
  // to, so they cannot diverge. This exercises that shared derivation directly
  // against a real per-row scatter-gate product produced by the orchestrator,
  // the same object pipeline_ui.js reads as state.scatterGate.
  run('QC-02: a review-required scatter gate reads as needs-review (the shared derivation both surfaces use)', () => {
    const n = 30;
    const fsc = new Float64Array(n);
    const ssc = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      if (i < 20) { fsc[i] = 100 + 5 * Math.sin(i * 1.7); ssc[i] = 80 + 4 * Math.cos(i * 1.3); }
      else { fsc[i] = 30 + 4 * Math.sin(i * 1.1); ssc[i] = 25 + 3 * Math.cos(i * 1.9); }
    }
    const row = {
      id: 'qc02-review-id', name: 'qc02-review',
      data: {
        channel_key: 'DAPI-A', eventCount: n,
        channels: {
          DNA_A: Float64Array.from({ length: n }, () => 1),
          DNA_H: null, DNA_W: null, FSC_A: fsc, SSC_A: ssc, Time: null,
        },
        pnr: { DNA_A: 10, DNA_H: null, DNA_W: null, FSC_A: null, SSC_A: null, Time: null },
        masks: { structural: null, timeQC: null, scatter: null, singlet: null, final: null },
      },
    };
    pipeline.clear_state(row.name);
    pipeline.apply_structural_qc(row);
    pipeline.apply_cell_gate(row);
    const state = pipeline.get_state(row.name);
    const buttonState = stateHelpers.derive_gate_state(state.scatterGate, { active: true });
    const inactiveState = stateHelpers.derive_gate_state(state.scatterGate, { active: false });
    const runningState = stateHelpers.derive_gate_state(state.scatterGate, { active: true, running: true });
    return {
      pass: state.scatterGate.reviewRequired === true
        && buttonState === 'needs-review'
        && inactiveState === 'not-run'
        && runningState === 'running',
      detail: JSON.stringify({
        reasons: state.scatterGate.reviewReasons, buttonState, inactiveState, runningState,
      }),
    };
  });

  run('QC-02: a clean, fully-passing scatter gate reads as applied (not needs-review)', () => {
    const gate = pipeline.cellGate.gateMainBiologicalCloud(TestUtils.buildScatterDataset());
    const buttonState = stateHelpers.derive_gate_state(gate, { active: true });
    return {
      pass: gate.reviewRequired === false && buttonState === 'applied',
      detail: JSON.stringify({ reviewRequired: gate.reviewRequired, buttonState }),
    };
  });

  run('QC-02: aggregate_gate_state picks the worst state across samples for one gate button', () => {
    const mixed = stateHelpers.aggregate_gate_state(['applied', 'needs-review', 'applied']);
    const allApplied = stateHelpers.aggregate_gate_state(['applied', 'applied']);
    const withFailure = stateHelpers.aggregate_gate_state(['needs-review', 'failed', 'applied']);
    const empty = stateHelpers.aggregate_gate_state([]);
    return {
      pass: Array.isArray(stateHelpers.GATE_STATES) && stateHelpers.GATE_STATES.length === 6
        && mixed === 'needs-review' && allApplied === 'applied' && withFailure === 'failed'
        && empty === 'not-run',
      detail: JSON.stringify({ order: stateHelpers.GATE_STATES, mixed, allApplied, withFailure, empty }),
    };
  });

  run('gate cache: re-applying the scatter gate with unchanged upstream reuses the fit', () => {
    const scatter = TestUtils.buildScatterDataset();
    const row = {
      id: 'qc-cache-scatter-id', name: 'qc-cache-scatter',
      data: {
        channel_key: 'DAPI-A', eventCount: scatter.eventCount,
        channels: {
          DNA_A: Float64Array.from({ length: scatter.eventCount }, () => 1),
          DNA_H: null, DNA_W: null,
          FSC_A: scatter.channels.FSC_A, SSC_A: scatter.channels.SSC_A, Time: null,
        },
        pnr: { DNA_A: 10, DNA_H: null, DNA_W: null, FSC_A: null, SSC_A: null, Time: null },
        masks: { structural: null, timeQC: null, scatter: null, singlet: null, final: null },
      },
    };
    pipeline.clear_state(row.name);
    pipeline.apply_structural_qc(row);
    const first = pipeline.apply_cell_gate_fast(row).result;
    const second = pipeline.apply_cell_gate_fast(row).result;
    // Same cached fit => the mask array reference is shared (no re-fit).
    const reused = first.scatterMask === second.scatterMask;
    // Change the upstream (install a Time QC mask dropping one event) -> re-fit.
    const timeMask = new Uint8Array(row.data.eventCount); timeMask.fill(1); timeMask[5] = 0;
    row.data.masks.timeQC = timeMask;
    const third = pipeline.apply_cell_gate_fast(row).result;
    const refit = third.scatterMask !== first.scatterMask;
    return {
      pass: !first.skipped && reused && refit,
      detail: JSON.stringify({ reused, refit }),
    };
  });

  run('gate cache: re-applying the singlet gate with unchanged upstream reuses the fit', () => {
    const geo = TestUtils.buildPulseGeometryDataset(false);
    const row = {
      id: 'qc-cache-singlet-id', name: 'qc-cache-singlet',
      data: {
        channel_key: 'DAPI-A', eventCount: geo.eventCount,
        channels: { DNA_A: geo.channels.DNA_A, DNA_H: geo.channels.DNA_H, DNA_W: null, FSC_A: null, SSC_A: null, Time: null },
        pnr: { DNA_A: 200000, DNA_H: null, DNA_W: null, FSC_A: null, SSC_A: null, Time: null },
        masks: { structural: null, timeQC: null, scatter: null, singlet: null, final: null },
      },
    };
    pipeline.clear_state(row.name);
    pipeline.apply_structural_qc(row);
    const first = pipeline.apply_singlet_gate_fast(row).result;
    const second = pipeline.apply_singlet_gate_fast(row).result;
    const reused = first.singletMask === second.singletMask;
    // Change the upstream (install a Cell Gate mask dropping one event) -> re-fit.
    const scatterMask = new Uint8Array(row.data.eventCount); scatterMask.fill(1); scatterMask[3] = 0;
    row.data.masks.scatter = scatterMask;
    const third = pipeline.apply_singlet_gate_fast(row).result;
    const refit = third.singletMask !== first.singletMask;
    return {
      pass: !first.skipped && reused && refit,
      detail: JSON.stringify({ reused, refit }),
    };
  });

  run('QC-06: a degenerate (collinear) ridge is not applied as a filter mask (pipeline)', () => {
    const n = 60;
    const dnaA = new Float64Array(n);
    const dnaH = new Float64Array(n);
    for (let i = 0; i < n; i += 1) { dnaA[i] = 50000 + i * 280; dnaH[i] = 0.52 * dnaA[i]; }
    const row = {
      id: 'qc06-degenerate-id', name: 'qc06-degenerate',
      data: {
        channel_key: 'DAPI-A', eventCount: n,
        channels: { DNA_A: dnaA, DNA_H: dnaH, DNA_W: null, FSC_A: null, SSC_A: null, Time: null },
        pnr: { DNA_A: 200000, DNA_H: null, DNA_W: null, FSC_A: null, SSC_A: null, Time: null },
        masks: { structural: null, timeQC: null, scatter: null, singlet: null, final: null },
      },
    };
    pipeline.clear_state(row.name);
    pipeline.apply_structural_qc(row);
    const result = pipeline.apply_singlet_gate(row).result;
    return {
      pass: !result.skipped && result.reviewRequired && result.limitedReliability === true
        && result.reviewReasons.some(reason => /degenerate/.test(reason))
        && row.data.masks.singlet === null,
      detail: JSON.stringify({ reasons: result.reviewReasons, singletMask: row.data.masks.singlet }),
    };
  });

  return results;
}"""


def _check_ui06_metadata_wizard_no_auto_open(ctx: TestContext):
    """UI-06 regression guard: the wizard no longer force-opens itself.

    `schedule_metadata_wizard_after_file_load()` used to be
    `window.setTimeout(() => open_metadata_wizard(), 750)` -- a blocking modal
    that opened itself 750ms after the first file load and stole focus mid-
    orientation. The fix replaces it with a non-blocking status-bar hint
    pointing at the existing "Configure filename metadata columns" toolbar
    button, so the wizard only opens when the user chooses to.

    The headless unit-test harness (tests/unit/test_harness.html) renders no
    app UI -- its own comment notes every module querySelector capture
    resolves to null -- so calling the real function here cannot observe
    modal-visibility or focus state directly (set_status_bar() would throw on
    the missing #status_bar_message element, and open_metadata_wizard() would
    silently no-op on the missing modal either way, before or after the fix).
    Given that constraint, this reads the actual owned source file WS-4 ships
    and asserts the blocking-timer call is gone and the replacement hint is
    wired through set_status_bar() -- it fails against the pre-fix source
    (real assertion error, not a harness artifact) and passes against the
    current one.
    """
    metadata_wizard_path = Path(__file__).resolve().parent.parent.parent.parent / "js" / "ui" / "metadata_wizard.js"
    source = metadata_wizard_path.read_text()
    match = re.search(
        r"export function schedule_metadata_wizard_after_file_load\(\)\s*\{(.*?)\n\}",
        source,
        re.DOTALL,
    )
    body = match.group(1) if match else ""
    no_blocking_timer = not re.search(r"setTimeout\([^)]*open_metadata_wizard", source)
    uses_status_bar_hint = bool(re.search(r"set_status_bar\(", body))
    ctx.check(
        GROUP,
        "UI-06: file load no longer force-opens the metadata wizard via a blocking timer",
        match is not None and no_blocking_timer and uses_status_bar_hint,
        (
            f"function_found={match is not None} no_blocking_timer={no_blocking_timer} "
            f"uses_status_bar_hint={uses_status_bar_hint}"
        ),
        screenshot=False,
    )


def _check_ui09_peak_review_message_names_real_control(ctx: TestContext):
    """UI-09 regression guard: the bulk-detect messaging names a control that

    actually works, and the disabled fields underneath explain themselves.

    With several samples checked and none singled out, `peak_review_ui.js`
    used to tell the user "click a row to review one" both before and after
    Detect Peaks -- but clicking a table row does not focus a sample (only
    the Ridge view's per-sample "Manual Review" button does, via
    `js/plotting/render.js`'s `enter_ridge_review()` ->
    `set_focused_file_id()`). A live-browser repro (Playwright, two real FCS
    fixtures) confirmed clicking a row did nothing while the four region
    inputs stayed empty and disabled directly under a "Peaks detected"
    success message -- the reported bug. The fix (a) replaces "click a row"
    with the control that actually works in both the pre-detection hint
    (refresh_panel()) and the post-detection status
    (on_detect_peaks_click()), and (b) makes the disabled-fields state
    self-explaining by surfacing a reason on the existing `peak_review_status`
    line instead of just hiding it.

    Same headless-harness constraint as the UI-06 check above (no app DOM,
    so `refresh_panel()`/`on_detect_peaks_click()` can't be exercised
    directly here): this reads the owned source file and asserts the old,
    dead-end instruction is gone and the replacement literally names the
    real controls ("Ridge", the View mode; "Manual Review", the per-sample
    button label in render.js) in both messages, plus that the disabled
    fields get a non-empty explanation. Fails against the pre-fix source
    (the old "click a row" text matches) and passes against the current one.
    """
    peak_review_path = (
        Path(__file__).resolve().parent.parent.parent.parent / "js" / "analysis" / "cell_cycle" / "peak_review_ui.js"
    )
    source = peak_review_path.read_text()

    no_dead_end_instruction = not re.search(r"[Cc]lick a row", source)

    hint_match = re.search(
        r"samples checked.*?Detect Peaks runs on all of them;\s*([^`]*?)`",
        source,
    )
    hint_text = hint_match.group(1) if hint_match else ""
    hint_names_real_control = "Ridge" in hint_text and "Manual Review" in hint_text

    status_match = re.search(
        r"Peaks detected for all \$\{targets\.length\} plotted samples\.\s*([^`]*?)`",
        source,
    )
    status_text = status_match.group(1) if status_match else ""
    status_names_real_control = "Ridge" in status_text and "Manual Review" in status_text

    # refresh_panel()'s !row branch: peak_review_status must be given a
    # non-empty explanation (not just left hidden) when several samples are
    # checked and none is focused.
    self_explains_disabled_state = bool(
        re.search(r"peak_review_status\.textContent\s*=\s*bulk\s*\n\s*\?\s*\"[^\"]+\"", source)
    )

    ctx.check(
        GROUP,
        "UI-09: bulk Detect Peaks messaging names the control that actually focuses a sample, "
        "and the disabled region fields explain themselves",
        no_dead_end_instruction and hint_names_real_control and status_names_real_control and self_explains_disabled_state,
        (
            f"no_dead_end_instruction={no_dead_end_instruction} hint_names_real_control={hint_names_real_control} "
            f"status_names_real_control={status_names_real_control} "
            f"self_explains_disabled_state={self_explains_disabled_state}"
        ),
        screenshot=False,
    )


def run_djf_pipeline_tests(ctx: TestContext):
    """Run isolated stage groups and record every JS assertion."""

    for suite_name, source in (
        ("Stages 0-4", _STAGES_0_TO_4),
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

    _check_ui06_metadata_wizard_no_auto_open(ctx)
