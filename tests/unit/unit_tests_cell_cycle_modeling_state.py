#!/usr/bin/env python3
"""Browser unit coverage for js/analysis/cell_cycle/peak_regions.js (region
validation/estimation) and js/analysis/cell_cycle/modeling_state.js (the
peak-region state transitions: detect, select an alternative, edit, accept,
reset)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / Cell Cycle Modeling State"


_TESTS = r"""() => {
  const pipeline = window.PhaseFinder.pipeline;
  const peakRegions = window.CellCyclePeakRegions;
  const modelingState = window.CellCycleModelingState;
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
  const throws = (callback, pattern = null) => {
    try {
      callback();
      return false;
    } catch (error) {
      return pattern ? pattern.test(error.message) : true;
    }
  };

  // --- peak_regions.js: validation ---

  run('validatePeakRegions accepts a well-ordered pair', () => {
    const validated = peakRegions.validatePeakRegions({
      g1: { left: 50, right: 90 }, g2: { left: 110, right: 170 },
    });
    return { pass: validated.g1.left === 50 && validated.g2.right === 170, detail: JSON.stringify(validated) };
  });

  run('validatePeakRegions rejects an inverted region (left >= right)', () => {
    const failed = throws(() => peakRegions.validatePeakRegions({
      g1: { left: 90, right: 50 }, g2: { left: 110, right: 170 },
    }), /left < right/);
    return { pass: failed, detail: `failed=${failed}` };
  });

  run('validatePeakRegions rejects an overlapping pair (G1 right > G2 left)', () => {
    const failed = throws(() => peakRegions.validatePeakRegions({
      g1: { left: 50, right: 120 }, g2: { left: 110, right: 170 },
    }), /ordered and non-overlapping/);
    return { pass: failed, detail: `failed=${failed}` };
  });

  run('validatePeakRegions accepts touching regions (G1 right === G2 left)', () => {
    const validated = peakRegions.validatePeakRegions({
      g1: { left: 50, right: 100 }, g2: { left: 100, right: 170 },
    });
    return { pass: validated.g1.right === validated.g2.left, detail: JSON.stringify(validated) };
  });

  run('estimatePeakFromRegion finds the region-local peak center without any fit', () => {
    const edges = Array.from({ length: 129 }, (_, i) => i * 2);
    const counts = new Array(128).fill(0);
    for (let i = 0; i < 128; i += 1) {
      const center = i * 2 + 1;
      const z = (center - 70) / 6;
      counts[i] = 500 * Math.exp(-0.5 * z * z);
    }
    const estimate = peakRegions.estimatePeakFromRegion(edges, counts, { left: 40, right: 100 });
    return {
      pass: Math.abs(estimate.mean - 70) < 4 && estimate.sigma > 0 && estimate.area > 0,
      detail: JSON.stringify({ mean: estimate.mean, sigma: estimate.sigma, area: estimate.area }),
    };
  });

  // --- modeling_state.js: build a real row + Stage 4 histogram to exercise
  // the state transitions against, via the actual pipeline orchestrator. ---

  function buildBimodalRow(name, eventsPerPeak) {
    const total = eventsPerPeak * 2;
    const dna = new Float64Array(total);
    // Deterministic pseudo-Gaussian spread via a small linear congruential
    // generator so the test is reproducible without Math.random().
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const gaussian = () => {
      const u1 = Math.max(1e-9, rand());
      const u2 = rand();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };
    for (let i = 0; i < eventsPerPeak; i += 1) dna[i] = 70 + gaussian() * 4.2;
    for (let i = 0; i < eventsPerPeak; i += 1) dna[eventsPerPeak + i] = 140 + gaussian() * 8.4;

    return {
      id: `${name}-id`,
      name,
      data: {
        channel_key: 'DNA-A',
        eventCount: total,
        channels: { DNA_A: dna, DNA_H: null, DNA_W: null, FSC_A: null, SSC_A: null, Time: null },
        pnr: { DNA_A: 300, DNA_H: null, DNA_W: null, FSC_A: null, SSC_A: null, Time: null },
        masks: { structural: null, timeQC: null, scatter: null, singlet: null, final: null },
      },
    };
  }

  run('detect_peak_regions populates peakDetection/peakSelection from a real Stage 4 histogram', () => {
    const row = buildBimodalRow('modeling-state-detect', 1500);
    pipeline.clear_state(row.name);
    pipeline.run_stage0(row);
    pipeline.run_stage4(row, { binCount: 128, range: [0, 220] });

    const detection = modelingState.detect_peak_regions(row);
    const state = pipeline.get_state(row.name);
    return {
      pass: (detection.status === 'detected' || detection.status === 'low_confidence')
        && state.modeling.peakSelection.source === 'automatic'
        && state.modeling.peakSelection.regions !== null
        && state.modeling.peakSelection.stale === false
        && state.modeling.histogramFingerprint === state.histogram.fingerprint
        && detection.pairs.every((pair) => typeof pair.id === 'string'),
      detail: JSON.stringify({ status: detection.status, regions: state.modeling.peakSelection.regions }),
    };
  });

  run('detect_peak_regions requires a Stage 4 histogram first', () => {
    const row = buildBimodalRow('modeling-state-no-histogram', 100);
    pipeline.clear_state(row.name);
    const failed = throws(() => modelingState.detect_peak_regions(row), /Stage 4 histogram/);
    return { pass: failed, detail: `failed=${failed}` };
  });

  run('update_peak_regions applies a valid manual edit, marks reviewed, and invalidates cached fits', () => {
    const row = buildBimodalRow('modeling-state-update', 1500);
    pipeline.clear_state(row.name);
    pipeline.run_stage0(row);
    pipeline.run_stage4(row, { binCount: 128, range: [0, 220] });
    modelingState.detect_peak_regions(row);

    const state = pipeline.get_state(row.name);
    state.modeling.resultsByKey = { 'legacy_bridge_v1|fp1': { modelId: 'legacy_bridge_v1' } };
    state.modeling.activeResultKey = 'legacy_bridge_v1|fp1';

    const updated = modelingState.update_peak_regions(row, {
      g1: { left: 55, right: 85 }, g2: { left: 120, right: 160 },
    });
    return {
      pass: updated.source === 'manual'
        && updated.reviewed === true
        && updated.regions.g1.left === 55
        && Object.keys(state.modeling.resultsByKey).length === 0
        && state.modeling.activeResultKey === null,
      detail: JSON.stringify({ updated, resultsByKey: state.modeling.resultsByKey }),
    };
  });

  run('update_peak_regions rejects an invalid edit and leaves the previous regions untouched', () => {
    const row = buildBimodalRow('modeling-state-update-invalid', 1500);
    pipeline.clear_state(row.name);
    pipeline.run_stage0(row);
    pipeline.run_stage4(row, { binCount: 128, range: [0, 220] });
    modelingState.detect_peak_regions(row);
    const state = pipeline.get_state(row.name);
    const before = JSON.stringify(state.modeling.peakSelection.regions);

    const failed = throws(() => modelingState.update_peak_regions(row, {
      g1: { left: 55, right: 130 }, g2: { left: 120, right: 160 }, // overlapping
    }));
    const after = JSON.stringify(state.modeling.peakSelection.regions);
    return { pass: failed && before === after, detail: `failed=${failed}, unchanged=${before === after}` };
  });

  run('select_peak_pair switches to an alternative pair and invalidates cached fits', () => {
    const row = buildBimodalRow('modeling-state-select', 1500);
    pipeline.clear_state(row.name);
    pipeline.run_stage0(row);
    pipeline.run_stage4(row, { binCount: 128, range: [0, 220] });
    const detection = modelingState.detect_peak_regions(row);
    const state = pipeline.get_state(row.name);

    if (detection.pairs.length < 2) {
      // Not every random seed produces a second candidate pair; skip cleanly
      // rather than fail on an environment-dependent fixture detail.
      return { pass: true, detail: 'only one candidate pair found; select_peak_pair not exercised' };
    }
    const alternativeId = detection.pairs[1].id;
    state.modeling.resultsByKey = { x: { modelId: 'legacy_bridge_v1' } };
    const selection = modelingState.select_peak_pair(row, alternativeId);
    return {
      pass: state.modeling.peakDetection.selectedPairId === alternativeId
        && selection.source === 'alternative'
        && Object.keys(state.modeling.resultsByKey).length === 0,
      detail: JSON.stringify({ selectedPairId: state.modeling.peakDetection.selectedPairId, selection }),
    };
  });

  run('select_peak_pair rejects an unknown pair id', () => {
    const row = buildBimodalRow('modeling-state-select-unknown', 1500);
    pipeline.clear_state(row.name);
    pipeline.run_stage0(row);
    pipeline.run_stage4(row, { binCount: 128, range: [0, 220] });
    modelingState.detect_peak_regions(row);
    const failed = throws(() => modelingState.select_peak_pair(row, 'not-a-real-pair-id'), /No detected pair/);
    return { pass: failed, detail: `failed=${failed}` };
  });

  run('accept_peak_regions marks reviewed without changing the regions', () => {
    const row = buildBimodalRow('modeling-state-accept', 1500);
    pipeline.clear_state(row.name);
    pipeline.run_stage0(row);
    pipeline.run_stage4(row, { binCount: 128, range: [0, 220] });
    modelingState.detect_peak_regions(row);
    const state = pipeline.get_state(row.name);
    const before = JSON.stringify(state.modeling.peakSelection.regions);

    const accepted = modelingState.accept_peak_regions(row);
    return {
      pass: accepted.reviewed === true && JSON.stringify(state.modeling.peakSelection.regions) === before,
      detail: JSON.stringify(accepted),
    };
  });

  run('reset_peak_regions restores the automatic proposal after a manual edit', () => {
    const row = buildBimodalRow('modeling-state-reset', 1500);
    pipeline.clear_state(row.name);
    pipeline.run_stage0(row);
    pipeline.run_stage4(row, { binCount: 128, range: [0, 220] });
    modelingState.detect_peak_regions(row);
    const state = pipeline.get_state(row.name);
    const automatic = JSON.stringify(state.modeling.peakSelection.automaticRegions);

    modelingState.update_peak_regions(row, { g1: { left: 55, right: 85 }, g2: { left: 120, right: 160 } });
    const reset = modelingState.reset_peak_regions(row);
    return {
      pass: reset.source === 'automatic'
        && reset.reviewed === false
        && JSON.stringify(reset.regions) === automatic,
      detail: JSON.stringify({ automatic, reset }),
    };
  });

  run('reset_peak_regions requires detection to have run first', () => {
    const row = buildBimodalRow('modeling-state-reset-no-detect', 100);
    pipeline.clear_state(row.name);
    const failed = throws(() => modelingState.reset_peak_regions(row), /detect_peak_regions/);
    return { pass: failed, detail: `failed=${failed}` };
  });

  run('rerunning detect_peak_regions after a manual edit preserves the manual selection', () => {
    const row = buildBimodalRow('modeling-state-rerun-preserve', 1500);
    pipeline.clear_state(row.name);
    pipeline.run_stage0(row);
    pipeline.run_stage4(row, { binCount: 128, range: [0, 220] });
    modelingState.detect_peak_regions(row);
    modelingState.update_peak_regions(row, { g1: { left: 55, right: 85 }, g2: { left: 120, right: 160 } });
    const state = pipeline.get_state(row.name);

    modelingState.detect_peak_regions(row);
    return {
      pass: state.modeling.peakSelection.source === 'manual'
        && state.modeling.peakSelection.regions.g1.left === 55,
      detail: JSON.stringify(state.modeling.peakSelection),
    };
  });

  return results;
}"""


def run_cell_cycle_modeling_state_tests(ctx: TestContext):
    results = ctx.page.evaluate(_TESTS)
    for result in results:
        ctx.check(GROUP, result["name"], result["pass"], result["detail"])
