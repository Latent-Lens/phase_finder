#!/usr/bin/env python3
"""Browser unit coverage for js/analysis/peak_tracking_time_qc.js -- the
peak-tracking Time QC method, and js/analysis/time_qc_settings.js -- the method
selection state it is driven by.

Covers the unit-test list in
docs/plans/peak_tracking_time_qc_implementation_spec.md ("Testing requirements"):
adaptive bin-size calculation, overlapping-bin boundaries, timer rollover
handling, local peak detection, fallback peak behavior, peak-to-track
assignment, track prevalence filtering, zero-MAD behavior, isolation split gain,
largest terminal-node selection, short-good-run removal, and bad-bin to
bad-event conversion -- plus the synthetic acquisition scenarios (stable,
stable-bimodal, transient shift, rate drop, rollover, backward jump) run
end to end through runPeakTrackingTimeQC.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / Time QC Peak Tracking"


_TESTS = r"""() => {
  const qc = window.PeakTrackingTimeQC;
  const settings = window.TimeQCSettings;
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

  // Deterministic normal deviates: a seeded LCG through Box-Muller, so every
  // scenario below is reproducible run to run.
  function makeRandom(seed) {
    let state = seed >>> 0;
    return () => {
      state = (1664525 * state + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }
  function makeNormal(seed) {
    const random = makeRandom(seed);
    return (mean, sigma) => {
      const u1 = Math.max(1e-12, random());
      const u2 = random();
      return mean + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };
  }

  /*
   * A synthetic acquisition: `count` events in acquisition order, with Time
   * increasing at a steady rate, and DNA-A/FSC-A/SSC-A drawn around per-event
   * centers supplied by `centerFor(index)`. That hook is how a scenario injects
   * a shift into a slice of the run.
   */
  function makeDataset(count, centerFor, { timeStep = 0.001, seed = 7, timeFor = null } = {}) {
    const normal = makeNormal(seed);
    const channels = {
      Time: new Float64Array(count),
      DNA_A: new Float64Array(count),
      FSC_A: new Float64Array(count),
      SSC_A: new Float64Array(count),
    };
    for (let index = 0; index < count; index += 1) {
      channels.Time[index] = timeFor ? timeFor(index) : index * timeStep;
      const centers = centerFor(index);
      channels.DNA_A[index] = normal(centers.dna, 2);
      channels.FSC_A[index] = normal(centers.fsc, 3);
      channels.SSC_A[index] = normal(centers.ssc, 3);
    }
    return { channels, eventCount: count, pnr: { Time: 1e9 }, masks: {} };
  }
  const stableCenters = () => ({ dna: 100, fsc: 60, ssc: 40 });
  // Scenario datasets are a few thousand events, which is far short of the
  // ~11k the shipped isolationTreeMinimumBins of 150 would need before the tree
  // is allowed to run. 20 keeps the tree in play for these sizes while still
  // being enough bins for a split to mean something.
  const fastOptions = { isolationTreeMinimumBins: 20, minimumGoodRunBins: 3 };

  function countMask(mask, value) {
    let total = 0;
    for (const entry of mask) if (entry === value) total += 1;
    return total;
  }

  // ── Step 2: adaptive bin size ────────────────────────────────────────────
  run('chooseAdaptiveBinSize matches the spec worked example (100k events, 500 bins -> 500)', () => {
    const size = qc.chooseAdaptiveBinSize(100000, { maximumBins: 500, binSizeRounding: 500, minimumEventsPerBin: 150 });
    return { pass: size === 500, detail: `binSize=${size}` };
  });

  run('chooseAdaptiveBinSize never returns fewer than minimumEventsPerBin', () => {
    // Small rounding, so the floor -- not the rounding step -- is what binds.
    const size = qc.chooseAdaptiveBinSize(1000, { maximumBins: 500, binSizeRounding: 10, minimumEventsPerBin: 150 });
    return { pass: size === 150, detail: `binSize=${size}` };
  });

  run('chooseAdaptiveBinSize rounds up to the configured multiple', () => {
    const size = qc.chooseAdaptiveBinSize(1000000, { maximumBins: 500, binSizeRounding: 500, minimumEventsPerBin: 150 });
    return { pass: size === 4000 && size % 500 === 0, detail: `binSize=${size}` };
  });

  // ── Step 3: overlapping bins ─────────────────────────────────────────────
  run('createOverlappingBins produces the spec 0-499 / 250-749 / 500-999 boundaries', () => {
    const indexes = Array.from({ length: 1000 }, (_, index) => index);
    const bins = qc.createOverlappingBins(indexes, 500, 0.5);
    const first = bins[0];
    const second = bins[1];
    const third = bins[2];
    return {
      pass: first.startOffset === 0 && first.endOffset === 500
        && second.startOffset === 250 && second.endOffset === 750
        && third.startOffset === 500 && third.endOffset === 1000,
      detail: JSON.stringify(bins.map((bin) => [bin.startOffset, bin.endOffset])),
    };
  });

  run('createOverlappingBins carries the original event indexes, not offsets', () => {
    const indexes = [10, 11, 12, 13, 14, 15, 16, 17];
    const bins = qc.createOverlappingBins(indexes, 4, 0.5);
    return {
      pass: bins[0].indexes[0] === 10 && bins[1].indexes[0] === 12,
      detail: JSON.stringify(bins.map((bin) => bin.indexes)),
    };
  });

  run('createOverlappingBins merges an undersized trailing remainder into the previous bin', () => {
    const indexes = Array.from({ length: 620 }, (_, index) => index);
    const bins = qc.createOverlappingBins(indexes, 500, 0.5);
    const last = bins[bins.length - 1];
    return {
      pass: last.endOffset === 620 && bins.every((bin) => bin.indexes.length >= 250),
      detail: JSON.stringify(bins.map((bin) => [bin.startOffset, bin.endOffset])),
    };
  });

  run('createOverlappingBins returns a single bin when the segment is shorter than one bin', () => {
    const bins = qc.createOverlappingBins([1, 2, 3], 500, 0.5);
    return { pass: bins.length === 1 && bins[0].indexes.length === 3, detail: JSON.stringify(bins) };
  });

  // ── Steps 4-5: density and peak detection ────────────────────────────────
  run('detectMajorDensityPeaks finds both modes of a bimodal density', () => {
    const normal = makeNormal(11);
    const values = [];
    for (let index = 0; index < 2000; index += 1) values.push(normal(index % 2 ? 150 : 50, 4));
    const density = qc.estimateChannelDensity(values, {});
    const peaks = qc.detectMajorDensityPeaks(density, 1 / 3);
    const positions = peaks.map((peak) => peak.position);
    return {
      pass: peaks.length === 2
        && Math.abs(positions[0] - 50) < 5 && Math.abs(positions[1] - 150) < 5
        && peaks.every((peak) => !peak.fallback),
      detail: JSON.stringify(positions.map((value) => Math.round(value))),
    };
  });

  run('detectMajorDensityPeaks suppresses a mode below the relative height threshold', () => {
    const normal = makeNormal(12);
    const values = [];
    for (let index = 0; index < 2000; index += 1) values.push(normal(50, 4));
    for (let index = 0; index < 60; index += 1) values.push(normal(150, 4));
    const density = qc.estimateChannelDensity(values, {});
    const peaks = qc.detectMajorDensityPeaks(density, 1 / 3);
    return { pass: peaks.length === 1 && Math.abs(peaks[0].position - 50) < 5, detail: JSON.stringify(peaks.map((p) => Math.round(p.position))) };
  });

  run('detectMajorDensityPeaks falls back to the tallest point, flagged, when nothing clears the threshold', () => {
    // A perfectly flat curve has no local maximum to find.
    const flat = { x: [0, 1, 2, 3, 4], y: [1, 1, 1, 1, 1] };
    const peaks = qc.detectMajorDensityPeaks(flat, 1 / 3);
    return {
      pass: peaks.length === 1 && peaks[0].fallback === true,
      detail: JSON.stringify(peaks),
    };
  });

  run('estimateChannelDensity reports invalid for too few values and for a constant channel', () => {
    const tooFew = qc.estimateChannelDensity([1, 2, 3], {});
    const constant = qc.estimateChannelDensity(new Array(500).fill(42), {});
    return {
      pass: tooFew.valid === false && constant.valid === false,
      detail: `tooFew=${tooFew.valid}, constant=${constant.valid}`,
    };
  });

  // ── Step 6: peak tracks ──────────────────────────────────────────────────
  run('buildPersistentPeakTracks assigns each bin peak to the nearest track', () => {
    const peaksByBin = [
      [{ position: 50 }, { position: 150 }],
      [{ position: 51 }, { position: 149 }],
      [{ position: 49 }, { position: 151 }],
      [{ position: 50 }, { position: 150 }],
    ];
    const tracks = qc.buildPersistentPeakTracks(peaksByBin, { minimumPeakClusterPrevalence: 0.5 });
    return {
      pass: tracks.length === 2
        && Math.abs(tracks[0].trackMedian - 50) < 1
        && Math.abs(tracks[1].trackMedian - 150) < 1
        && tracks.every((track) => track.imputed.every((flag) => flag === false)),
      detail: JSON.stringify(tracks.map((track) => track.positions)),
    };
  });

  run('buildPersistentPeakTracks discards a track present in too few bins', () => {
    const peaksByBin = [
      [{ position: 50 }, { position: 150 }],
      [{ position: 50 }],
      [{ position: 50 }],
      [{ position: 50 }],
      [{ position: 50 }],
    ];
    const tracks = qc.buildPersistentPeakTracks(peaksByBin, { minimumPeakClusterPrevalence: 0.5 });
    return {
      pass: tracks.length === 1 && Math.abs(tracks[0].trackMedian - 50) < 1,
      detail: JSON.stringify(tracks.map((track) => [track.trackMedian, track.prevalence])),
    };
  });

  run('buildPersistentPeakTracks imputes a retained track median for the bins that miss it', () => {
    const peaksByBin = [
      [{ position: 50 }, { position: 150 }],
      [{ position: 50 }, { position: 150 }],
      [{ position: 50 }, { position: 150 }],
      [{ position: 50 }],
      [{ position: 50 }, { position: 150 }],
    ];
    const tracks = qc.buildPersistentPeakTracks(peaksByBin, { minimumPeakClusterPrevalence: 0.5 });
    const second = tracks.find((track) => Math.abs(track.trackMedian - 150) < 1);
    return {
      pass: Boolean(second) && second.imputed[3] === true && Math.abs(second.positions[3] - 150) < 1,
      detail: JSON.stringify(second ? { positions: second.positions, imputed: second.imputed } : null),
    };
  });

  run('SCI-09C: missing-track evidence warns and rejects a sustained disappearance', () => {
    const evidence = qc.detectMissingPeakEvidence([{
      label: 'DNA_A peak 2',
      imputed: [false, false, true, true, true, false, false, true],
    }], 8);
    return {
      pass: JSON.stringify([...evidence.badBins]) === JSON.stringify([2, 3, 4])
        && evidence.warnings.length === 1,
      detail: JSON.stringify({ bad: [...evidence.badBins], warnings: evidence.warnings }),
    };
  });

  run('SCI-09C: density failure and undetected peak remain distinct evidence', () => {
    const peaks = [
      [{ position: 50 }, { position: 150 }],
      [{ position: 50 }],
      [],
      [{ position: 50 }, { position: 150 }],
    ];
    const tracks = qc.buildPersistentPeakTracks(peaks, { minimumPeakClusterPrevalence: 0.5 }, [
      'peak-not-detected', 'peak-not-detected', 'density-estimate-failed', 'peak-not-detected',
    ]);
    const second = tracks[1];
    return {
      pass: second.missingReasons[1] === 'peak-not-detected'
        && second.missingReasons[2] === 'density-estimate-failed',
      detail: JSON.stringify(second.missingReasons),
    };
  });

  run('SCI-09C: a stable second mode disappearing temporarily is not neutralized', () => {
    const peaksByBin = Array.from({ length: 10 }, (_, bin) =>
      bin >= 4 && bin <= 6
        ? [{ position: 50 + 0.1 * Math.sin(bin) }]
        : [{ position: 50 + 0.1 * Math.sin(bin) }, { position: 150 + 0.1 * Math.cos(bin) }]);
    const tracks = qc.buildPersistentPeakTracks(peaksByBin, { minimumPeakClusterPrevalence: 0.5 });
    const second = tracks.find(track => track.referencePosition > 100);
    const evidence = qc.detectMissingPeakEvidence([{
      label: 'DNA_A peak 2',
      imputed: second.imputed,
    }], peaksByBin.length);
    return {
      pass: JSON.stringify([...evidence.badBins]) === JSON.stringify([4, 5, 6]),
      detail: JSON.stringify({ imputed: second.imputed, rejected: [...evidence.badBins] }),
    };
  });

  run('SCI-09C: random isolated misses do not cause false rejection', () => {
    const imputed = Array.from({ length: 100 }, (_, index) =>
      ((index * 37 + 11) % 23 === 0));
    const evidence = qc.detectMissingPeakEvidence([{ label: 'DNA_A peak 2', imputed }], imputed.length);
    return {
      pass: evidence.badBins.size === 0,
      detail: JSON.stringify({ misses: imputed.filter(Boolean).length, rejected: [...evidence.badBins] }),
    };
  });

  // ── Step 8: isolation tree ───────────────────────────────────────────────
  run('computeSplitGain is high for a clean separation and zero for no spread', () => {
    const separated = [1, 1, 1, 10, 10, 10];
    const cleanGain = qc.computeSplitGain(separated, [0, 1, 2], [3, 4, 5]);
    const flatGain = qc.computeSplitGain([5, 5, 5, 5], [0, 1], [2, 3]);
    return {
      pass: cleanGain > 0.9 && flatGain === 0,
      detail: `clean=${cleanGain.toFixed(3)}, flat=${flatGain}`,
    };
  });

  run('buildDeterministicIsolationTree keeps the largest terminal node as the stable acquisition', () => {
    // 20 stable bins plus 3 clearly displaced ones. The stable bins carry
    // continuous jitter rather than two discrete levels: a two-level column
    // would itself split with gain 1.0, which is correct tree behavior but
    // says nothing about how it handles real, noisy peak positions.
    const jitter = makeNormal(41);
    const column = [];
    for (let index = 0; index < 20; index += 1) column.push(jitter(100, 0.4));
    for (let index = 0; index < 3; index += 1) column.push(160);
    const tree = qc.buildDeterministicIsolationTree([column], column.length, { isolationTreeGainThreshold: 0.6 });
    const goodCount = countMask(tree.goodBinMask, 1);
    const displacedKept = [20, 21, 22].some((index) => tree.goodBinMask[index] === 1);
    return {
      pass: goodCount === 20 && !displacedKept,
      detail: `good=${goodCount}, stableNodeSize=${tree.stableNodeSize}, displacedKept=${displacedKept}`,
    };
  });

  run('buildDeterministicIsolationTree keeps every bin when nothing splits above the gain threshold', () => {
    const column = Array.from({ length: 30 }, (_, index) => 100 + Math.sin(index));
    const tree = qc.buildDeterministicIsolationTree([column], column.length, { isolationTreeGainThreshold: 0.99 });
    return {
      pass: countMask(tree.goodBinMask, 1) === 30 && tree.splits.length === 0,
      detail: `good=${countMask(tree.goodBinMask, 1)}, splits=${tree.splits.length}`,
    };
  });

  run('buildDeterministicIsolationTree is deterministic across repeated runs', () => {
    const column = Array.from({ length: 40 }, (_, index) => (index >= 30 ? 200 : 100 + (index % 3)));
    const first = qc.buildDeterministicIsolationTree([column], column.length, {});
    const second = qc.buildDeterministicIsolationTree([column], column.length, {});
    return {
      pass: Array.from(first.goodBinMask).join('') === Array.from(second.goodBinMask).join(''),
      detail: Array.from(first.goodBinMask).join(''),
    };
  });

  // ── Step 9: MAD limits ───────────────────────────────────────────────────
  run('detectMADPeakOutliers flags a sustained shift and spares the stable bins', () => {
    const column = Array.from({ length: 60 }, (_, index) => (index >= 40 && index < 50 ? 140 : 100));
    const candidates = new Uint8Array(60).fill(1);
    const bad = qc.detectMADPeakOutliers([column], candidates, { madMultiplier: 6 });
    const flaggedShift = [42, 43, 44, 45, 46, 47].every((index) => bad.has(index));
    const sparedStable = ![0, 1, 2, 20, 55].some((index) => bad.has(index));
    return { pass: flaggedShift && sparedStable, detail: `flagged=${[...bad].join(',')}` };
  });

  run('detectMADPeakOutliers with a zero-spread track flags only the bins that differ from the center', () => {
    const column = new Array(40).fill(100);
    column[20] = 400;
    const candidates = new Uint8Array(40).fill(1);
    const bad = qc.detectMADPeakOutliers([column], candidates, { madMultiplier: 6 });
    // The moving average spreads bin 20's excursion over its neighbours, so the
    // point to prove is that the flagged set is a small window around 20 and
    // that the far-away stable bins are untouched.
    const flaggedCenter = bad.has(20);
    const sparedFar = ![0, 5, 10, 30, 39].some((index) => bad.has(index));
    return { pass: flaggedCenter && sparedFar && bad.size <= 6, detail: `flagged=${[...bad].join(',')}` };
  });

  run('detectMADPeakOutliers flags nothing when every track is stable', () => {
    const column = Array.from({ length: 60 }, (_, index) => 100 + ((index % 3) - 1) * 0.01);
    const candidates = new Uint8Array(60).fill(1);
    const bad = qc.detectMADPeakOutliers([column], candidates, { madMultiplier: 6 });
    return { pass: bad.size === 0, detail: `flagged=${[...bad].join(',')}` };
  });

  // ── Step 10: short surviving runs ────────────────────────────────────────
  run('removeShortGoodRuns clears a short interior island (spec example)', () => {
    const mask = Uint8Array.from([0, 0, 0, 1, 1, 0, 0]);
    const { mask: cleaned, removedBins } = qc.removeShortGoodRuns(mask, 5);
    return {
      pass: Array.from(cleaned).every((value) => value === 0) && removedBins.length === 2,
      detail: Array.from(cleaned).join(''),
    };
  });

  run('removeShortGoodRuns keeps a long interior run', () => {
    const mask = Uint8Array.from([0, 1, 1, 1, 1, 1, 0]);
    const { mask: cleaned } = qc.removeShortGoodRuns(mask, 5);
    return { pass: Array.from(cleaned).join('') === '0111110', detail: Array.from(cleaned).join('') };
  });

  run('removeShortGoodRuns leaves short runs touching the very start or end alone', () => {
    const mask = Uint8Array.from([1, 1, 0, 0, 0, 0, 1]);
    const { mask: cleaned, removedBins } = qc.removeShortGoodRuns(mask, 5);
    return {
      pass: Array.from(cleaned).join('') === '1100001' && removedBins.length === 0,
      detail: Array.from(cleaned).join(''),
    };
  });

  // ── Step 11: event rate ──────────────────────────────────────────────────
  run('detectEventRateOutliers flags a bin whose acquisition rate collapses', () => {
    const time = new Float64Array(300);
    for (let index = 0; index < 300; index += 1) {
      // Events 100-149 take 20x longer to acquire: a clog-like rate drop.
      time[index] = index < 100 ? index * 0.001 : index < 150 ? 0.1 + (index - 100) * 0.02 : 1.1 + (index - 150) * 0.001;
    }
    const bins = [];
    for (let start = 0; start + 50 <= 300; start += 50) {
      bins.push({ indexes: Array.from({ length: 50 }, (_, offset) => start + offset) });
    }
    const bad = qc.detectEventRateOutliers(bins, time, { eventRateZThreshold: 4 });
    return { pass: bad.has(2) && bad.size <= 2, detail: `flagged=${[...bad].join(',')}` };
  });

  run('detectEventRateOutliers flags nothing at a steady rate', () => {
    const time = new Float64Array(300);
    for (let index = 0; index < 300; index += 1) time[index] = index * 0.001;
    const bins = [];
    for (let start = 0; start + 50 <= 300; start += 50) {
      bins.push({ indexes: Array.from({ length: 50 }, (_, offset) => start + offset) });
    }
    const bad = qc.detectEventRateOutliers(bins, time, { eventRateZThreshold: 4 });
    return { pass: bad.size === 0, detail: `flagged=${[...bad].join(',')}` };
  });

  run('detectEventRateOutliers ignores float32 rounding noise on a perfectly steady clock', () => {
    // Regression: FCS files store Time as float32. A perfectly regular clock
    // then yields per-bin rates that differ only by rounding, which collapses
    // the MAD to zero -- and, before the scale was floored, divided that noise
    // up into z = Infinity and rejected half the run.
    const count = 6000;
    const time = new Float32Array(count);
    for (let index = 0; index < count; index += 1) time[index] = index * 0.01;
    const bins = [];
    for (let start = 0; start + 500 <= count; start += 250) {
      bins.push({ indexes: Array.from({ length: 500 }, (_, offset) => start + offset) });
    }
    const bad = qc.detectEventRateOutliers(bins, time, { eventRateZThreshold: 4 });
    return { pass: bad.size === 0, detail: `bins=${bins.length}, flagged=${[...bad].join(',')}` };
  });

  run('detectMADPeakOutliers ignores float-scale jitter in an otherwise pinned track', () => {
    // The same failure mode for peak positions rather than rates.
    const column = Array.from({ length: 60 }, (_, index) => 100 + (index % 7) * 1e-6);
    const candidates = new Uint8Array(60).fill(1);
    const bad = qc.detectMADPeakOutliers([column], candidates, { madMultiplier: 6 });
    return { pass: bad.size === 0, detail: `flagged=${[...bad].join(',')}` };
  });

  run('detectMADPeakOutliers still flags a shift that clears the minimum spread floor', () => {
    // 1% of the track center is ten times the 0.1% floor, so a real shift of
    // that size must still be caught.
    const column = Array.from({ length: 60 }, (_, index) => (index >= 30 && index < 40 ? 101 : 100));
    const candidates = new Uint8Array(60).fill(1);
    const bad = qc.detectMADPeakOutliers([column], candidates, { madMultiplier: 6 });
    return { pass: [32, 33, 34, 35, 36, 37].every((index) => bad.has(index)), detail: `flagged=${[...bad].join(',')}` };
  });

  // ── Step 12: bins back to events ─────────────────────────────────────────
  run('convertBadBinsToBadEvents rejects an event belonging to any rejected overlapping bin', () => {
    const bins = [
      { indexes: [0, 1, 2, 3] },
      { indexes: [2, 3, 4, 5] },
      { indexes: [4, 5, 6, 7] },
    ];
    const badBinMask = Uint8Array.from([0, 1, 0]);
    const badEvents = qc.convertBadBinsToBadEvents(bins, badBinMask, 8);
    return {
      pass: Array.from(badEvents).join('') === '00111100',
      detail: Array.from(badEvents).join(''),
    };
  });

  run('convertBadBinsToBadEvents rejects nothing when no bin is rejected', () => {
    const bins = [{ indexes: [0, 1] }, { indexes: [1, 2] }];
    const badEvents = qc.convertBadBinsToBadEvents(bins, Uint8Array.from([0, 0]), 3);
    return { pass: countMask(badEvents, 1) === 0, detail: Array.from(badEvents).join('') };
  });

  // ── End-to-end synthetic acquisition scenarios ───────────────────────────
  run('scenario: a stable single population loses no events', () => {
    const dataset = makeDataset(6000, stableCenters, { seed: 21 });
    const result = qc.runPeakTrackingTimeQC(dataset, null, fastOptions);
    return {
      pass: result.skipped === false && result.rejectedEventCount === 0 && result.percentRemoved === 0,
      detail: `removed=${result.rejectedEventCount} (${result.percentRemoved.toFixed(2)}%), bins=${result.binCount}`,
    };
  });

  run('scenario: a stable bimodal population loses no events', () => {
    const dataset = makeDataset(6000, (index) => ({
      dna: index % 2 ? 100 : 200, fsc: 60, ssc: 40,
    }), { seed: 22 });
    const result = qc.runPeakTrackingTimeQC(dataset, null, fastOptions);
    return {
      pass: result.skipped === false && result.rejectedEventCount === 0,
      detail: `removed=${result.rejectedEventCount}, tracks=${result.segmentResults[0]?.peakMetadata.length}`,
    };
  });

  run('scenario: a temporary global channel shift is removed, and the stable run is kept', () => {
    const dataset = makeDataset(6000, (index) => (index >= 2500 && index < 3500
      ? { dna: 145, fsc: 95, ssc: 75 }
      : { dna: 100, fsc: 60, ssc: 40 }), { seed: 23 });
    const result = qc.runPeakTrackingTimeQC(dataset, null, fastOptions);
    // Every event in the disturbed window must go; the conservative overlap rule
    // means some neighbouring events go with them, but most of the run survives.
    let shiftedRemoved = 0;
    for (let index = 2500; index < 3500; index += 1) if (result.timeQCMask[index] === 0) shiftedRemoved += 1;
    return {
      pass: shiftedRemoved === 1000 && result.percentRemoved < 40 && result.rejectedRegions.length >= 1,
      detail: `shiftedRemoved=${shiftedRemoved}, percentRemoved=${result.percentRemoved.toFixed(2)}, regions=${result.rejectedRegions.length}`,
    };
  });

  run('scenario: a shift in only one channel is still detected', () => {
    const dataset = makeDataset(6000, (index) => (index >= 3000 && index < 3800
      ? { dna: 100, fsc: 60, ssc: 95 }
      : { dna: 100, fsc: 60, ssc: 40 }), { seed: 24 });
    const result = qc.runPeakTrackingTimeQC(dataset, null, fastOptions);
    let shiftedRemoved = 0;
    for (let index = 3000; index < 3800; index += 1) if (result.timeQCMask[index] === 0) shiftedRemoved += 1;
    return {
      pass: shiftedRemoved > 700,
      detail: `shiftedRemoved=${shiftedRemoved}/800, percentRemoved=${result.percentRemoved.toFixed(2)}`,
    };
  });

  run('scenario: rejected bins carry a reason, and the reasons are from the documented set', () => {
    const dataset = makeDataset(6000, (index) => (index >= 2500 && index < 3500
      ? { dna: 145, fsc: 95, ssc: 75 }
      : { dna: 100, fsc: 60, ssc: 40 }), { seed: 23 });
    const result = qc.runPeakTrackingTimeQC(dataset, null, fastOptions);
    const known = new Set(Object.values(qc.REJECTION_REASONS));
    const allReasons = result.rejectedRegions.flatMap((region) => region.reasons);
    return {
      pass: allReasons.length > 0 && allReasons.every((reason) => known.has(reason)),
      detail: JSON.stringify([...new Set(allReasons)]),
    };
  });

  run('scenario: a timer rollover mid-acquisition is unwrapped, not treated as a disturbance', () => {
    const range = 32.6824;
    const dataset = makeDataset(6000, stableCenters, {
      seed: 25,
      // Time climbs to just under the timer range, then wraps back to zero.
      timeFor: (index) => (index * 0.005) % range,
    });
    dataset.pnr = { Time: range };
    const result = qc.runPeakTrackingTimeQC(dataset, null, fastOptions);
    return {
      pass: result.skipped === false && result.rejectedEventCount === 0,
      detail: `removed=${result.rejectedEventCount}, segments=${result.segmentResults.length}`,
    };
  });

  run('scenario: an unexplained backward time jump starts a second acquisition segment', () => {
    const dataset = makeDataset(6000, stableCenters, {
      seed: 26,
      // Halfway through, time drops back to zero from a value nowhere near the
      // timer range -- a new acquisition, not a rollover.
      timeFor: (index) => (index < 3000 ? index * 0.001 : (index - 3000) * 0.001),
    });
    dataset.pnr = { Time: 1e9 };
    const result = qc.runPeakTrackingTimeQC(dataset, null, fastOptions);
    return {
      pass: result.segmentResults.length === 2 && result.rejectedEventCount === 0,
      detail: JSON.stringify({
        segments: result.segmentResults.length,
        removed: result.rejectedEventCount,
        bins: result.segmentResults.map((segment) => segment.binCount),
        rejectedBins: result.rejectedBinCount,
        reasons: result.reasonBinCounts,
        warnings: result.warnings,
      }),
    };
  });

  run('scenario: a noisy low-event-count sample is skipped with a warning, not filtered', () => {
    const dataset = makeDataset(200, stableCenters, { seed: 27 });
    const result = qc.runPeakTrackingTimeQC(dataset, null, {});
    return {
      pass: result.rejectedEventCount === 0
        && result.warnings.some((warning) => /too few for reliable peak-tracking/i.test(warning)),
      detail: JSON.stringify({
        evaluated: result.evaluatedEventCount,
        retained: result.retainedEventCount,
        rejected: result.rejectedEventCount,
        segments: result.segmentResults.length,
        warnings: result.warnings,
      }),
    };
  });

  run('runPeakTrackingTimeQC honours the structural mask: masked events never re-enter', () => {
    const dataset = makeDataset(6000, stableCenters, { seed: 28 });
    const structural = new Uint8Array(6000).fill(1);
    for (let index = 0; index < 500; index += 1) structural[index] = 0;
    const result = qc.runPeakTrackingTimeQC(dataset, structural, fastOptions);
    let leaked = 0;
    for (let index = 0; index < 500; index += 1) if (result.timeQCMask[index] === 1) leaked += 1;
    return {
      pass: leaked === 0 && result.evaluatedEventCount === 5500,
      detail: `leaked=${leaked}, evaluated=${result.evaluatedEventCount}`,
    };
  });

  run('runPeakTrackingTimeQC skips a sample with no Time channel instead of throwing', () => {
    const dataset = makeDataset(3000, stableCenters, { seed: 29 });
    delete dataset.channels.Time;
    const result = qc.runPeakTrackingTimeQC(dataset, null, {});
    return {
      pass: result.skipped === true && result.mask === null && /no Time channel/.test(result.reason),
      detail: JSON.stringify({ skipped: result.skipped, reason: result.reason }),
    };
  });

  run('runPeakTrackingTimeQC returns the Stage 1 result contract the pipeline consumes', () => {
    const dataset = makeDataset(6000, stableCenters, { seed: 30 });
    const result = qc.runPeakTrackingTimeQC(dataset, null, fastOptions);
    const hasContract = result.mask === result.timeQCMask
      && result.timeQCMask.length === 6000
      && Number.isFinite(result.retainedEventCount)
      && Number.isFinite(result.rejectedEventCount)
      && result.status === 'time QC complete'
      && result.method === 'peak-tracking'
      && result.algorithmVersion === 'peak-tracking-v2';
    return {
      pass: hasContract,
      detail: JSON.stringify({ method: result.method, status: result.status, version: result.algorithmVersion }),
    };
  });

  run('runPeakTrackingTimeQC records the options and channels it actually used', () => {
    const dataset = makeDataset(6000, stableCenters, { seed: 31 });
    const result = qc.runPeakTrackingTimeQC(dataset, null, { ...fastOptions, madMultiplier: 9 });
    return {
      pass: result.optionsUsed.madMultiplier === 9
        && JSON.stringify(result.selectedChannels) === JSON.stringify(['DNA_A', 'FSC_A', 'SSC_A']),
      detail: JSON.stringify({ mad: result.optionsUsed.madMultiplier, channels: result.selectedChannels }),
    };
  });

  run('runPeakTrackingTimeQC warns when it removes an unusually large fraction of events', () => {
    // Alternating blocks give the tracks nothing stable to sit on, so a large
    // share of the run is rejected -- exactly the case the warning exists for.
    const dataset = makeDataset(8000, (index) => (Math.floor(index / 700) % 2
      ? { dna: 100, fsc: 60, ssc: 40 }
      : { dna: 180, fsc: 110, ssc: 90 }), { seed: 32 });
    const result = qc.runPeakTrackingTimeQC(dataset, null, fastOptions);
    const warned = result.warnings.some((warning) => /unusually large fraction|Review this before continuing/i.test(warning));
    return {
      pass: result.percentRemoved <= 20 || warned,
      detail: `percentRemoved=${result.percentRemoved.toFixed(2)}, warnings=${JSON.stringify(result.warnings)}`,
    };
  });

  // ── QC-04: channel availability, coverage, evidence, and QC-01 mapping ────
  run('QC-04: a requested-but-unloaded channel is reported (not silently dropped) and limits reliability', () => {
    const dataset = makeDataset(6000, stableCenters, { seed: 41 });
    dataset.channels.FSC_A = null;
    const result = qc.runPeakTrackingTimeQC(dataset, null, { ...fastOptions, channels: ['DNA_A', 'FSC_A', 'SSC_A'] });
    return {
      pass: JSON.stringify(result.missingChannels) === JSON.stringify(['FSC_A'])
        && JSON.stringify(result.availableChannels) === JSON.stringify(['DNA_A', 'SSC_A'])
        && result.limitedReliability === true
        && result.warnings.some((warning) => /not loaded/i.test(warning)),
      detail: JSON.stringify({ requested: result.requestedChannels, available: result.availableChannels, missing: result.missingChannels }),
    };
  });

  run('QC-04: an acquisition too small to score any segment is not_evaluable and removes no events', () => {
    const result = qc.runPeakTrackingTimeQC(makeDataset(200, stableCenters, { seed: 42 }), null, {});
    return {
      pass: result.notEvaluable === true && result.limitedReliability === true
        && result.rejectedEventCount === 0 && result.evaluatedSegmentCount === 0
        && /not evaluable/.test(result.status),
      detail: JSON.stringify({ status: result.status, segments: result.evaluatedSegmentCount, rejected: result.rejectedEventCount }),
    };
  });

  run('QC-04: an evaluable run retains per-bin reason/track evidence and the algorithm version', () => {
    const result = qc.runPeakTrackingTimeQC(makeDataset(6000, stableCenters, { seed: 43 }), null, fastOptions);
    const seg = result.segmentResults[0];
    return {
      pass: result.algorithmVersion === 'peak-tracking-v2'
        && result.notEvaluable === false
        && Array.isArray(seg.rejectionReasons) && seg.rejectionReasons.length === seg.binCount
        && Array.isArray(seg.peakMetadata) && seg.peakMetadata.every((meta) => Array.isArray(meta.imputed)),
      detail: JSON.stringify({ version: result.algorithmVersion, tracks: seg.peakMetadata.length, bins: seg.binCount }),
    };
  });

  run('QC-04: a not-evaluable peak-tracking result maps to a QC-01 "degraded" outcome that blocks a required stage', () => {
    const RC = window.CellCycleResultContract;
    const timeResult = qc.runPeakTrackingTimeQC(makeDataset(200, stableCenters, { seed: 44 }), null, {});
    const state = {
      channelKey: 'DNA_A',
      histogram: { counts: new Array(200).fill(5), y: new Array(200).fill(5), fingerprint: 'fp', maskRetainedCount: 1000, rejectedNegative: 0, rejectedNonfinite: 0 },
      timeQC: timeResult,
      structuralQC: { skipped: false, rejectedEventCount: 0, retainedEventCount: 1000 },
      modeling: { histogramFingerprint: 'fp', peakSelection: { regions: { g1: { left: 55, right: 85 }, g2: { left: 120, right: 160 } }, reviewed: true, stale: false, revision: 1 } },
    };
    const pf = RC.model_preflight(state, { requiredQc: ['time'] });
    return { pass: pf.qc.time.status === 'degraded' && pf.passed === false, detail: JSON.stringify(pf.qc.time) };
  });

  // ── Method-selection state ───────────────────────────────────────────────
  run('time_qc_settings defaults to the robust-summary method', () => {
    settings.reset_time_qc_state();
    const state = settings.get_time_qc_state();
    const options = settings.time_qc_method_options();
    return {
      pass: state.method === 'robust-summary' && options.method === 'robust-summary'
        && settings.time_qc_method_label() === 'Robust summary QC',
      detail: JSON.stringify({ method: state.method, label: settings.time_qc_method_label() }),
    };
  });

  run('time_qc_method_options carries the peak-tracking settings once that method is selected', () => {
    settings.reset_time_qc_state();
    settings.set_time_qc_state({ method: 'peak-tracking', peakTrackingOptions: { madMultiplier: 8 } });
    const options = settings.time_qc_method_options();
    settings.reset_time_qc_state();
    return {
      pass: options.method === 'peak-tracking' && options.madMultiplier === 8
        && JSON.stringify(options.channels) === JSON.stringify(['DNA_A', 'FSC_A', 'SSC_A']),
      detail: JSON.stringify(options),
    };
  });

  run('UI-01: set_time_qc_state rejects unsupported methods and empty channel lists atomically', () => {
    settings.reset_time_qc_state();
    const before = JSON.stringify(settings.get_time_qc_state());
    let rejected = false;
    try { settings.set_time_qc_state({ method: 'nonsense', selectedChannels: [] }); }
    catch (error) { rejected = Boolean(error.fieldErrors?.method && error.fieldErrors?.selectedChannels); }
    const state = settings.get_time_qc_state();
    settings.reset_time_qc_state();
    return {
      pass: rejected && JSON.stringify(state) === before,
      detail: JSON.stringify(state),
    };
  });

  run('UI-01: validator enforces numeric, integer, threshold, and cross-field constraints', () => {
    const invalid = settings.get_default_time_qc_state();
    invalid.robustSummaryOptions.targetBinSize = 50.5;
    invalid.peakTrackingOptions.overlapFraction = 1;
    invalid.peakTrackingOptions.minimumRelativePeakHeight = 0;
    invalid.peakTrackingOptions.minimumGoodRunBins = 20;
    invalid.peakTrackingOptions.maximumBins = 10;
    const checked = settings.validate_time_qc_state(invalid);
    return {
      pass: !checked.valid
        && Boolean(checked.errors.targetBinSize)
        && Boolean(checked.errors.overlapFraction)
        && Boolean(checked.errors.minimumRelativePeakHeight)
        && Boolean(checked.errors.minimumGoodRunBins),
      detail: JSON.stringify(checked.errors),
    };
  });

  run('Time QC configuration round-trips through the session config shape', () => {
    settings.reset_time_qc_state();
    settings.set_time_qc_state({
      method: 'peak-tracking',
      selectedChannels: ['DNA_A', 'SSC_A'],
      peakTrackingOptions: { madMultiplier: 7, minimumGoodRunBins: 9, includeEventRateCheck: false },
    });
    const saved = settings.get_time_qc_session_config();
    settings.reset_time_qc_state();
    const restored = settings.apply_time_qc_session_config(saved);
    settings.reset_time_qc_state();
    return {
      pass: restored.method === 'peak-tracking'
        && JSON.stringify(restored.selectedChannels) === JSON.stringify(['DNA_A', 'SSC_A'])
        && restored.peakTrackingOptions.madMultiplier === 7
        && restored.peakTrackingOptions.minimumGoodRunBins === 9
        && restored.peakTrackingOptions.includeEventRateCheck === false
        && saved.algorithm_version === 'peak-tracking-v2',
      detail: JSON.stringify(saved),
    };
  });

  run('apply_time_qc_session_config tolerates a session saved before Time QC methods existed', () => {
    settings.reset_time_qc_state();
    const restored = settings.apply_time_qc_session_config(undefined);
    return {
      pass: restored.method === 'robust-summary' && restored.selectedChannels.length === 3,
      detail: JSON.stringify(restored),
    };
  });

  run('UI-01: invalid session Time QC values are rejected before calculations', () => {
    settings.reset_time_qc_state();
    const before = JSON.stringify(settings.get_time_qc_state());
    let rejected = false;
    try {
      settings.apply_time_qc_session_config({
        method: 'peak-tracking', selected_channels: ['DNA_A'],
        minimum_events_per_bin: 10, maximum_bins: 10, overlap_fraction: 2,
      });
    } catch (error) {
      rejected = Boolean(error.fieldErrors?.minimumEventsPerBin && error.fieldErrors?.overlapFraction);
    }
    const after = JSON.stringify(settings.get_time_qc_state());
    settings.reset_time_qc_state();
    return { pass: rejected && after === before, detail: after };
  });

  return results;
}"""


def run_time_qc_peak_tracking_tests(ctx: TestContext):
    results = ctx.page.evaluate(_TESTS)
    for result in results:
        ctx.check(GROUP, result["name"], result["pass"], result["detail"])
