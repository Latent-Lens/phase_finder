#!/usr/bin/env python3
"""Browser unit coverage for js/analysis/cell_cycle/modeling_state.js's fit
orchestration (M6): fit_cell_cycle_model, get_modeling_state, and
set_model_settings -- the plan §4.2 operations that connect the registered
models (dean_jett, dean_jett_fox, watson_pragmatic, watson_classic) to a row's
per-sample modeling state. Peak-region state transitions are covered
separately in unit_tests_cell_cycle_modeling_state.py.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / Cell Cycle Fit Orchestration"


_TESTS = r"""() => {
  const pipeline = window.PhaseFinder.pipeline;
  const modelingState = window.CellCycleModelingState;
  // Self-contained rather than relying on cell_cycle_pipeline.js's own
  // module-load-time register_default_models() call: other unit-test
  // modules sharing this same page load (e.g.
  // unit_tests_cell_cycle_watson_pragmatic.py) call clear_registry() at
  // their end, which would otherwise leave the registry empty by the time
  // this suite runs, depending on test execution order.
  window.CellCycleModelRegistry.register_default_models();
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
  const runAsync = async (name, test) => {
    try {
      const outcome = await test();
      push(name, outcome.pass, outcome.detail);
    } catch (error) {
      push(name, false, `${error.name}: ${error.message}`);
    }
  };
  const throwsAsync = async (callback, pattern = null) => {
    try {
      await callback();
      return false;
    } catch (error) {
      return pattern ? pattern.test(error.message) : true;
    }
  };

  run('plot series uses canonical phaseFractions even when visible component mass disagrees', () => {
    const canonical = { g1: 0.5, s: 0.3, g2: 0.2 };
    const fit = {
      modelId: 'dean_jett', modelLabel: 'Dean–Jett', phaseFractions: canonical,
      expectedCounts: [10, 10],
      components: [
        { id: 'g1', counts: [1, 1] },
        { id: 's', counts: [1, 1] },
        { id: 'g2', counts: [98, 98] },
      ],
    };
    const entry = window.PlotRender.build_fit_series_entry(
      { row: {}, name: 'tail-heavy' }, { histogram: { x: [1, 2] } }, fit,
    );
    const shown = [entry.fractions.g1, entry.fractions.s, entry.fractions.g2];
    const roundedSum = shown.reduce((sum, value) => sum + Number(value.toFixed(1)), 0);
    return {
      pass: shown[0] === 50 && shown[1] === 30 && shown[2] === 20
        && Math.abs(roundedSum - 100) <= 0.1
        && JSON.stringify(canonical) === JSON.stringify({ g1: 0.5, s: 0.3, g2: 0.2 }),
      detail: JSON.stringify({ shown, roundedSum, canonical }),
    };
  });

  run('SCI-14: legacy stage outputs cannot become the authoritative model result', () => {
    const legacyOnly = {
      baseFit: { modelId: 'legacy_bridge_v1', phaseFractions: { g1: 1, s: 0, g2: 0 } },
      extendedFit: { modelId: 'legacy_bridge_v1', phaseFractions: { g1: 0, s: 1, g2: 0 } },
      report: { fractions: { biologicalSinglets: { oneC: 0, sPhase: 0, twoC: 1 } } },
      modeling: { activeResultKey: null, resultsByKey: {} },
    };
    // GATE-01: the canonical result must carry the contract stamp, not just the
    // verdict field -- get_active_model_result() now requires both, so a raw
    // object claiming validForReporting can no longer become authoritative.
    const canonical = window.CellCycleResultContract.apply_result_contract({
      kind: 'generative', modelId: 'dean_jett', converged: true, cancelled: false,
      expectedCounts: [4, 5, 6], phaseFractions: { g1: 0.5, s: 0.3, g2: 0.2 },
      diagnostics: { deviance: 10 },
    }, { passed: true, reasons: [] });
    const uncontracted = { modelId: 'dean_jett', validForReporting: true, phaseFractions: { g1: 0.5, s: 0.3, g2: 0.2 } };
    const canonicalState = {
      ...legacyOnly,
      modeling: { activeResultKey: 'canonical', resultsByKey: { canonical } },
    };
    const uncontractedState = {
      ...legacyOnly,
      modeling: { activeResultKey: 'u', resultsByKey: { u: uncontracted } },
    };
    return {
      pass: window.DJFPipelineState.get_active_model_result(legacyOnly) === null
        && window.DJFPipelineState.get_active_model_result(uncontractedState) === null
        && window.DJFPipelineState.get_active_model_result(canonicalState) === canonical,
      detail: JSON.stringify({
        canonical: !!window.DJFPipelineState.get_active_model_result(canonicalState),
        uncontracted: window.DJFPipelineState.get_active_model_result(uncontractedState),
      }),
    };
  });

  run('GATE-01: canonical accessor refuses an explicitly non-reportable result', () => {
    const invalid = { modelId: 'dean_jett', validForReporting: false, phaseFractions: { g1: 0.5, s: 0.3, g2: 0.2 } };
    const state = { modeling: { activeResultKey: 'invalid', resultsByKey: { invalid } } };
    return {
      pass: window.DJFPipelineState.get_active_model_result(state) === null,
      detail: JSON.stringify(window.DJFPipelineState.get_active_model_result(state)),
    };
  });

  run('GATE-01: non-finite diagnostics invalidate an otherwise coherent result', () => {
    const contracted = window.CellCycleResultContract.apply_result_contract({
      kind: 'optimized', converged: true, cancelled: false,
      expectedCounts: [4, 5, 6], phaseFractions: { g1: 0.5, s: 0.3, g2: 0.2 },
      diagnostics: { deviance: NaN },
    }, { passed: true, reasons: [] });
    return {
      pass: contracted.scientificallyValid === false
        && contracted.validForReporting === false
        && contracted.validityReasons.some((reason) => reason.code === 'result_nonfinite'),
      detail: JSON.stringify(contracted.validityReasons),
    };
  });

  run('SCI-03: a stall termination is not marked converged, but its fractions are still reported with a non-convergence warning', () => {
    const contracted = window.CellCycleResultContract.apply_result_contract({
      kind: 'generative', converged: true, convergenceReason: 'boundary_stall', cancelled: false,
      expectedCounts: [4, 5, 6], phaseFractions: { g1: 0.5, s: 0.3, g2: 0.2 },
      diagnostics: { deviance: 10 },
    }, { passed: true, reasons: [] });
    return {
      // FlowJo-style report+warn: the convergence flag stays honest (false), but
      // the coherent fractions are still reported -- the non-convergence rides
      // along as a warning for the user to weigh, not a silent withhold.
      pass: contracted.converged === false
        && contracted.optimizerConverged === false
        && contracted.validForReporting === true
        && contracted.warnings.some((warning) => warning.code === 'optimizer_not_converged'),
      detail: JSON.stringify({ converged: contracted.converged, valid: contracted.validForReporting,
                               warnings: contracted.warnings.map((w) => w.code) }),
    };
  });

  run('SCI-03: reporting consumers withhold fractions and retain the nonconvergence reason', () => {
    const summary = window.CellCycleResultContract.result_reporting_summary({
      validForReporting: false,
      converged: false,
      convergenceReason: 'boundary_stall',
      phaseFractions: { g1: 0.5, s: 0.3, g2: 0.2 },
    });
    return {
      pass: summary.reportable === false
        && summary.status === 'Not converged'
        && summary.reason === 'boundary_stall'
        && summary.phaseFractions === null,
      detail: JSON.stringify(summary),
    };
  });

  run('SCI-03/GATE-01: a peak CV pinned at its upper bound is flagged limited-reliability and reported with a degeneracy warning', () => {
    // The VALID-01 DJF S-overfit signature: converged, fractions sum to 1, but a
    // G2 "peak" driven to the 0.30 CV ceiling let S absorb G2 (g1=0, s=0.86).
    const contracted = window.CellCycleResultContract.apply_result_contract({
      kind: 'generative', converged: true, cancelled: false,
      expectedCounts: [4, 5, 6], phaseFractions: { g1: 0.0, s: 0.86, g2: 0.14 },
      diagnostics: { deviance: 10 },
      parameters: { g1CV: 0.05, g2CV: 0.30 }, bounds: { g1CV: [0.01, 0.30], g2CV: [0.01, 0.30] },
    }, { passed: true, reasons: [] });
    return {
      // FlowJo-style report+warn: the degeneracy is still detected
      // (limitedReliability) and surfaced as a warning, but the fractions are
      // reported so the user -- not the tool -- decides whether to trust them.
      pass: contracted.optimizerConverged === true
        && contracted.scientificallyValid === true
        && contracted.limitedReliability === true
        && contracted.validForReporting === true
        && contracted.warnings.some((w) => w.code === 'fit_peak_degenerate'),
      detail: JSON.stringify({ limited: contracted.limitedReliability, valid: contracted.validForReporting,
                               warnings: contracted.warnings.map((w) => w.code) }),
    };
  });

  run('GATE-01: a well-identified fit (CVs off their bounds) stays valid for reporting', () => {
    const contracted = window.CellCycleResultContract.apply_result_contract({
      kind: 'generative', converged: true, cancelled: false,
      expectedCounts: [4, 5, 6], phaseFractions: { g1: 0.5, s: 0.2, g2: 0.3 },
      diagnostics: { deviance: 10 },
      parameters: { g1CV: 0.06, g2CV: 0.07 }, bounds: { g1CV: [0.01, 0.30], g2CV: [0.01, 0.30] },
    }, { passed: true, reasons: [] });
    return {
      pass: contracted.limitedReliability === false && contracted.validForReporting === true
        && !contracted.validityReasons.some((r) => r.code === 'fit_peak_degenerate'),
      detail: JSON.stringify({ limited: contracted.limitedReliability, valid: contracted.validForReporting }),
    };
  });

  // ---- SCI-06: a median is only a consensus when the parts agree -----------
  run('SCI-06: shared regions are refused when proposals disagree about which peak is G1', () => {
    const ui = window.CellCycleModelingUI;
    const calibration = { range: 1024, channel: 'FL7-A', datatype: 'F' };
    // The measured alpha-factor failure: some timepoints get (1C, 2C) detected,
    // later ones get (2C, 4C) once the 1C peak depletes. Each proposal is
    // individually confident; together they mean different things.
    const oneC = { g1: { left: 140, right: 250 }, g2: { left: 300, right: 480 } };
    const twoC = { g1: { left: 260, right: 440 }, g2: { left: 600, right: 800 } };
    const entries = [
      { regions: oneC, calibration }, { regions: oneC, calibration },
      { regions: twoC, calibration }, { regions: twoC, calibration },
    ];
    const verdict = ui.shared_regions_consistent(entries);
    const shared = ui.robust_shared_regions(entries);
    return {
      pass: verdict.consistent === false
        && verdict.ratio > 1.6 && verdict.ratio < 2.4
        && /which peak is G1/.test(verdict.reason)
        && shared === null,
      detail: JSON.stringify({ verdict, shared }),
    };
  });

  run('SCI-06: a genuinely agreeing set still shares, and the median is inside it', () => {
    const ui = window.CellCycleModelingUI;
    const calibration = { range: 1024, channel: 'FL7-A', datatype: 'F' };
    const entries = [
      { regions: { g1: { left: 140, right: 250 }, g2: { left: 300, right: 480 } }, calibration },
      { regions: { g1: { left: 150, right: 258 }, g2: { left: 310, right: 486 } }, calibration },
      { regions: { g1: { left: 145, right: 246 }, g2: { left: 305, right: 476 } }, calibration },
    ];
    const verdict = ui.shared_regions_consistent(entries);
    const shared = ui.robust_shared_regions(entries);
    const center = shared ? (shared.g1.left + shared.g1.right) / 2 : NaN;
    return {
      pass: verdict.consistent === true && shared !== null && center > 190 && center < 210,
      detail: JSON.stringify({ verdict, shared, center }),
    };
  });

  run('SCI-06: a lone outlier is still resisted by the median, not treated as a split', () => {
    // The distinction that matters: ONE stray proposal among agreeing ones is
    // exactly what a median is for. Only a genuine split -- enough proposals
    // sitting away from the median to form a second population -- is refused.
    const ui = window.CellCycleModelingUI;
    const calibration = { range: 1000 };
    const entry = (g1, g2) => ({
      calibration,
      regions: { g1: { left: g1 - 10, right: g1 + 10 }, g2: { left: g2 - 20, right: g2 + 20 } },
    });
    const entries = [entry(100, 200), entry(102, 202), entry(900, 950)];
    const verdict = ui.shared_regions_consistent(entries);
    const shared = ui.robust_shared_regions(entries);
    return {
      pass: verdict.consistent === true && verdict.dissenters === 1
        && shared !== null && shared.g1.left === 92 && shared.g1.right === 112,
      detail: JSON.stringify({ verdict, shared }),
    };
  });

  run('SCI-06: an unexplained wide split is refused too, not just the 2x case', () => {
    const ui = window.CellCycleModelingUI;
    const calibration = { range: 1024, channel: 'FL7-A', datatype: 'F' };
    const entries = [
      { regions: { g1: { left: 100, right: 160 }, g2: { left: 260, right: 380 } }, calibration },
      { regions: { g1: { left: 104, right: 164 }, g2: { left: 264, right: 384 } }, calibration },
      { regions: { g1: { left: 400, right: 520 }, g2: { left: 900, right: 1000 } }, calibration },
      { regions: { g1: { left: 404, right: 524 }, g2: { left: 904, right: 1004 } }, calibration },
    ];
    const verdict = ui.shared_regions_consistent(entries);
    return {
      pass: verdict.consistent === false && verdict.ratio > 2.4
        && !/which peak is G1/.test(verdict.reason)
        && ui.robust_shared_regions(entries) === null,
      detail: JSON.stringify(verdict),
    };
  });

  run('bulk sharing rejects mixed DNA-axis calibration and weak/inferred detections', () => {
    const ui = window.CellCycleModelingUI;
    const base = {
      channel: 'DNA-A', parameterName: 'DNA-A', stain: '', range: 262144,
      datatype: 'F', bits: 32, amplification: '0,0', spillover: 'none', instrument: 'A',
    };
    const mixedScale = { ...base, range: 1048576 };
    return {
      pass: ui.calibration_matches(base, { ...base })
        && !ui.calibration_matches(base, mixedScale)
        && ui.detection_can_share({ status: 'detected', confidence: 0.8 })
        && !ui.detection_can_share({ status: 'low_confidence', confidence: 0.8 })
        && !ui.detection_can_share({ status: 'inferred_g2', confidence: 0.99 })
        && !ui.detection_can_share({ status: 'detected', confidence: 0.64 }),
      detail: JSON.stringify({ base, mixedScale }),
    };
  });

  run('bulk shared-region proposal uses normalized medians and resists one outlier', () => {
    const calibration = { range: 1000 };
    const entry = (g1, g2) => ({
      calibration,
      regions: {
        g1: { left: g1 - 10, right: g1 + 10 },
        g2: { left: g2 - 20, right: g2 + 20 },
      },
    });
    const proposal = window.CellCycleModelingUI.robust_shared_regions([
      entry(100, 200), entry(102, 202), entry(900, 950),
    ]);
    return {
      pass: proposal.g1.left === 92 && proposal.g1.right === 112
        && proposal.g2.left === 182 && proposal.g2.right === 222,
      detail: JSON.stringify(proposal),
    };
  });

  run('UI-06: mixed bulk outcomes count every sample exactly once', () => {
    const outcomes = new Map([
      ['ok', { status: 'converged_reportable' }],
      ['computed', { status: 'computed_nonconverged' }],
      ['detect', { status: 'detection_failed' }],
      ['fit', { status: 'fit_failed' }],
      ['cancel', { status: 'cancelled' }],
      ['skip', { status: 'skipped' }],
    ]);
    const summary = window.CellCycleModelingUI.summarize_bulk_fit_outcomes(outcomes);
    return {
      pass: summary.attempted === outcomes.size
        && summary.success === 1 && summary.failed === 3
        && summary.cancelled === 1 && summary.skipped === 1
        && summary.success + summary.failed + summary.skipped + summary.cancelled === summary.attempted
        && /computed but did not converge/.test(summary.message),
      detail: JSON.stringify(summary),
    };
  });

  run('UI-07: axis drafts reject invalid ranges without rejecting auto or partial bounds', () => {
    const validate = window.AxisRangeModal.validate_axis_range_draft;
    const auto = { x_min: 0, x_max: 100, y_min: 0, y_max: 50 };
    const valid = [
      validate({ x_min: '', x_max: '', y_min: '', y_max: '' }, auto),
      validate({ x_min: '10', x_max: '', y_min: '', y_max: '1000000000' }, auto),
      validate({ x_min: '0', x_max: '1', y_min: '0', y_max: '1' }, auto, true),
    ].every((result) => result.valid);
    const invalid = [
      validate({ x_min: '2', x_max: '2', y_min: '', y_max: '' }, auto),
      validate({ x_min: '3', x_max: '2', y_min: '', y_max: '' }, auto),
      validate({ x_min: 'NaN', x_max: '', y_min: '', y_max: '' }, auto),
      validate({ x_min: '-1', x_max: '2', y_min: '', y_max: '' }, auto, true),
      validate({ x_min: '', x_max: '', y_min: '-1', y_max: '2' }, auto),
    ].every((result) => !result.valid);
    return { pass: valid && invalid, detail: JSON.stringify({ valid, invalid }) };
  });

  run('UI-08: declared browser baseline and startup capability report cover required and optional features', () => {
    const baseline = window.BrowserCompatibility.BROWSER_BASELINE;
    const report = window.BrowserCompatibility.browser_capabilities(window);
    return {
      pass: baseline.Chrome === 111 && baseline.Edge === 111 && baseline.Firefox === 121
        && baseline.Safari === 16.2 && Array.isArray(report.missingRequired)
        && Array.isArray(report.missingOptional) && report.missingRequired.length === 0
        && Object.hasOwn(report.optional, 'opfs'),
      detail: JSON.stringify({ baseline, report }),
    };
  });

  run('UI-12: overlay/ridge range contract expands when a wider live sample becomes visible', () => {
    const narrow = [
      { prepared: { maskedHistogram: { min: 20, max: 80 }, values: [20, 80] } },
    ];
    const prepared = [
      ...narrow,
      { prepared: { maskedHistogram: null, values: [0, 10, 100, 120] } },
    ];
    const narrowRange = window.PlotRender.visible_histogram_range(narrow);
    const range = window.PlotRender.visible_histogram_range(prepared);
    return {
      pass: window.PlotRender.VISIBLE_HISTOGRAM_RANGE_CONTRACT === 'visible-cohort-union-v1'
        && narrowRange[0] === 20 && narrowRange[1] === 80
        && range[0] <= 10 && range[1] >= 100
        && range[0] < narrowRange[0] && range[1] > narrowRange[1],
      detail: JSON.stringify({ contract: window.PlotRender.VISIBLE_HISTOGRAM_RANGE_CONTRACT, narrowRange, range }),
    };
  });

  run('DATA-04: user-approved unavailable QC is recorded as an explicit per-stage waiver', () => {
    const row = { id: 'data04-waiver', name: 'data04-waiver.fcs', data: { channel_key: 'DNA-A', eventCount: 100 } };
    const state = pipeline.get_or_create_state(row);
    state.requiredQc = ['time'];
    state.timeQC = { skipped: true, reason: 'Time channel missing' };
    const approved = window.CellCycleModelingUI.approve_degraded_qc([row], () => true);
    const waiver = state.qcWaivers?.time;
    const preflight = window.CellCycleResultContract.model_preflight({
      ...state,
      histogram: { counts: [20, 20, 20, 20, 20], centers: [1.2, 1.8, 3.1, 3.5, 3.9], maskRetainedCount: 100 },
      channelKey: 'DNA-A',
      modeling: {
        histogramFingerprint: null,
        peakSelection: { regions: { g1: { left: 1, right: 2 }, g2: { left: 3, right: 4 } }, reviewed: true, stale: false },
      },
    }, { requiredQc: ['time'], qcWaivers: state.qcWaivers, minimumRetainedEvents: 1 });
    return {
      pass: approved && /User disabled unavailable time QC/.test(waiver?.reason || '')
        && preflight.qc.time.status === 'waived' && preflight.passed,
      detail: JSON.stringify({ waiver, outcome: preflight.qc.time }),
    };
  });

  run('dimensionless optimizer transforms round-trip log, bounded, scaled, and identity coordinates', () => {
    const transform = window.CellCycleFitEngine.createParameterTransform([
      { type: 'log' },
      { type: 'bounded', min: 0.01, max: 0.3 },
      { type: 'scaled', center: 100, scale: 20 },
      { type: 'identity' },
    ]);
    const physical = [2500, 0.08, 110, -0.4];
    const roundTrip = transform.decode(transform.encode(physical));
    return {
      pass: roundTrip.every((value, index) => Math.abs(value - physical[index]) < 1e-9),
      detail: JSON.stringify({ coordinates: transform.encode(physical), roundTrip }),
    };
  });

  run('Jacobian condition diagnostics distinguish full-rank and rank-deficient designs', () => {
    const estimate = window.DJFShared.lm.estimateJacobianCondition;
    const conditioned = estimate([[1, 0], [0, 2]]);
    const deficient = estimate([[1, 2], [2, 4]]);
    return {
      pass: Math.abs(conditioned - 2) < 1e-9 && deficient === Infinity,
      detail: JSON.stringify({ conditioned, deficient }),
    };
  });

  // Same deterministic bimodal-row fixture as unit_tests_cell_cycle_modeling_state.py.
  function buildBimodalRow(name, eventsPerPeak) {
    const total = eventsPerPeak * 2;
    const dna = new Float64Array(total);
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

  function buildReviewedRow(name, eventsPerPeak = 1500) {
    const row = buildBimodalRow(name, eventsPerPeak);
    pipeline.clear_state(row.name);
    pipeline.apply_structural_qc(row);
    pipeline.apply_dna_histogram(row, { binCount: 128, range: [0, 220] });
    modelingState.detect_peak_regions(row);
    modelingState.accept_peak_regions(row);
    return row;
  }

  return (async () => {
    run('get_modeling_state returns the same object as pipeline.get_state(row.name).modeling', () => {
      const row = buildReviewedRow('fit-orch-get-state');
      const modeling = modelingState.get_modeling_state(row);
      const state = pipeline.get_state(row.name);
      return { pass: modeling === state.modeling, detail: modeling === state.modeling };
    });

    run('set_model_settings merges a patch without touching regions/histogram', () => {
      const row = buildReviewedRow('fit-orch-set-settings');
      const before = JSON.stringify(modelingState.get_modeling_state(row).peakSelection.regions);
      const settings = modelingState.set_model_settings(row, { modelId: 'watson_pragmatic' });
      const after = JSON.stringify(modelingState.get_modeling_state(row).peakSelection.regions);
      return {
        pass: settings.modelId === 'watson_pragmatic' && before === after,
        detail: JSON.stringify({ settings, before, after }),
      };
    });

    run('STATE-01: stored settings map once to canonical model configuration names', () => {
      const config = modelingState.resolve_model_configuration('dean_jett', {
        ratioMode: 'bounded', ratioRange: [1.8, 2.1], lockedRatio: 1.95,
        cvMode: 'equal', contaminants: { debris: 'off', aggregate: 'off', subG1: 'off' }, ploidyCount: 1,
      });
      return {
        pass: JSON.stringify(config.fitRatioRange) === JSON.stringify([1.8, 2.1])
          && !('ratioRange' in config) && config.cvMode === 'equal' && config.lockedRatio === 1.95,
        detail: JSON.stringify(config),
      };
    });

    run('STATE-01: unknown stored settings fail instead of remaining inert', () => {
      const row = buildReviewedRow('fit-orch-unknown-setting');
      let message = '';
      try { modelingState.set_model_settings(row, { imaginaryControl: true }); } catch (error) { message = error.message; }
      return { pass: /Unsupported model setting/.test(message), detail: message };
    });

    run('STATE-01: selecting a different model deactivates the prior model immediately', () => {
      const row = buildReviewedRow('fit-orch-model-switch');
      const modeling = modelingState.get_modeling_state(row);
      modeling.resultsByKey.old = { modelId: 'dean_jett', validForReporting: true };
      modeling.activeResultKey = 'old';
      modelingState.set_model_settings(row, { modelId: 'watson_pragmatic' });
      return { pass: modeling.activeResultKey === null, detail: modeling.activeResultKey };
    });

    await throwsAsync(async () => {
      const row = buildBimodalRow('fit-orch-no-histogram', 100);
      pipeline.clear_state(row.name);
      await modelingState.fit_cell_cycle_model(row, 'dean_jett');
    }, /Build the histogram/).then((failed) => push(
      'fit_cell_cycle_model requires a histogram first',
      failed,
      `failed=${failed}`,
    ));

    await throwsAsync(async () => {
      const row = buildBimodalRow('fit-orch-no-regions', 1500);
      pipeline.clear_state(row.name);
      pipeline.apply_structural_qc(row);
      pipeline.apply_dna_histogram(row, { binCount: 128, range: [0, 220] });
      await modelingState.fit_cell_cycle_model(row, 'dean_jett');
    }, /peak regions/).then((failed) => push(
      'fit_cell_cycle_model requires accepted peak regions first',
      failed,
      `failed=${failed}`,
    ));

    await throwsAsync(async () => {
      const row = buildReviewedRow('fit-orch-unreviewed');
      modelingState.get_modeling_state(row).peakSelection.reviewed = false;
      await modelingState.fit_cell_cycle_model(row, 'dean_jett');
    }, /Review and accept/).then((failed) => push(
      'GATE-01: unreviewed regions fail the shared preflight', failed, `failed=${failed}`,
    ));

    await throwsAsync(async () => {
      const row = buildReviewedRow('fit-orch-stale');
      modelingState.get_modeling_state(row).peakSelection.stale = true;
      await modelingState.fit_cell_cycle_model(row, 'dean_jett');
    }, /stale/).then((failed) => push(
      'GATE-01: stale regions fail the shared preflight', failed, `failed=${failed}`,
    ));

    await throwsAsync(async () => {
      const row = buildReviewedRow('fit-orch-qc-failed');
      pipeline.get_state(row.name).structuralQC = { status: 'structural QC failed', failed: true };
      await modelingState.fit_cell_cycle_model(row, 'dean_jett');
    }, /QC failed/).then((failed) => push(
      'GATE-01: a failed QC outcome cannot produce a model result', failed, `failed=${failed}`,
    ));

    await throwsAsync(async () => {
      const row = buildReviewedRow('fit-orch-invalid-config');
      await modelingState.fit_cell_cycle_model(row, 'dean_jett', { tolerance: NaN });
    }, /finite numbers/).then((failed) => push(
      'GATE-01: non-finite model configuration fails the shared preflight', failed, `failed=${failed}`,
    ));

    await throwsAsync(async () => {
      const row = buildReviewedRow('fit-orch-incompatible-dna');
      pipeline.get_state(row.name).channelEligibility = {
        eligible: false,
        code: 'FCS_DNA_TRANSFORM_UNSUPPORTED',
        message: 'Selected DNA channel uses unsupported logarithmic amplification.',
      };
      await modelingState.fit_cell_cycle_model(row, 'watson_pragmatic');
    }, /unsupported logarithmic amplification/).then((failed) => push(
      'DATA-01: a numerically fit-capable model cannot bypass incompatible DNA-channel metadata',
      failed,
      `failed=${failed}`,
    ));

    await throwsAsync(async () => {
      const row = buildReviewedRow('fit-orch-invalid-regions');
      modelingState.get_modeling_state(row).peakSelection.regions.g1.right = Infinity;
      await modelingState.fit_cell_cycle_model(row, 'dean_jett');
    }, /finite/).then((failed) => push(
      'GATE-01: invalid region constraints fail the shared preflight', failed, `failed=${failed}`,
    ));

    await runAsync('GATE-01: a required-QC waiver is explicit and retained in provenance', async () => {
      const row = buildReviewedRow('fit-orch-qc-waiver');
      pipeline.get_state(row.name).structuralQC = null;
      const waiver = { reason: 'instrument QC supplied externally', author: 'unit-test' };
      const result = await modelingState.fit_cell_cycle_model(row, 'watson_pragmatic', {
        qcWaivers: { structural: waiver },
      });
      return {
        pass: result.validForReporting === true
          && result.preflight.qc.structural.status === 'waived'
          && result.preflight.qc.structural.waiver === waiver,
        detail: JSON.stringify(result.preflight.qc.structural),
      };
    });

    await throwsAsync(async () => {
      const row = buildReviewedRow('fit-orch-unknown-model');
      await modelingState.fit_cell_cycle_model(row, 'not-a-real-model');
    }, /Unknown cell-cycle model/).then((failed) => push(
      'fit_cell_cycle_model rejects an unknown model id',
      failed,
      `failed=${failed}`,
    ));

    await runAsync('fit_cell_cycle_model fits dean_jett and stores a normalized result as the active result', async () => {
      const row = buildReviewedRow('fit-orch-dean-jett');
      const result = await modelingState.fit_cell_cycle_model(row, 'dean_jett');
      const repeated = await modelingState.fit_cell_cycle_model(row, 'dean_jett');
      const modeling = modelingState.get_modeling_state(row);
      const stored = modeling.resultsByKey[modeling.activeResultKey];
      const pass = result.modelId === 'dean_jett'
        && typeof result.converged === 'boolean'
        && result.phaseFractions
        && result.computed === true
        && result.optimizerConverged === true
        && result.scientificallyValid === true
        && result.validForReporting === true
        && result.invalid === false
        && Number.isFinite(result.phaseFractions.g1)
        && stored === repeated
        && JSON.stringify(repeated.parameters) === JSON.stringify(result.parameters)
        && repeated.diagnostics.deviance === result.diagnostics.deviance
        && Array.isArray(result.diagnostics?.optimizer?.parameterCoordinates)
        && Number.isFinite(result.diagnostics?.optimizer?.finiteDifferenceRelativeStep)
        && Number.isInteger(result.diagnostics?.optimizer?.rankFailureCount)
        && modeling.settings.modelId === 'dean_jett';
      return { pass, detail: JSON.stringify({ modelId: result.modelId, converged: result.converged, phaseFractions: result.phaseFractions, deterministic: repeated.diagnostics.deviance === result.diagnostics.deviance }) };
    });

    await runAsync('STATE-01: stored constraints affect behavior and exact applied config is retained', async () => {
      const row = buildReviewedRow('fit-orch-stored-config');
      modelingState.set_model_settings(row, { ratioMode: 'locked', lockedRatio: 2, cvMode: 'equal' });
      const result = await modelingState.fit_cell_cycle_model(row, 'dean_jett');
      return {
        pass: result.parameters.g2Mean === 2 * result.parameters.g1Mean
          && result.parameters.g2CV === result.parameters.g1CV
          && result.appliedConfiguration.ratioMode === 'locked'
          && result.appliedConfiguration.cvMode === 'equal',
        detail: JSON.stringify({ parameters: result.parameters, applied: result.appliedConfiguration }),
      };
    });

    await runAsync('STATE-01: config and changed DNA content produce distinct result keys', async () => {
      const row = buildReviewedRow('fit-orch-key-inputs');
      await modelingState.fit_cell_cycle_model(row, 'watson_pragmatic');
      const modeling = modelingState.get_modeling_state(row);
      const first = Object.keys(modeling.resultsByKey)[0];
      row.data.channels.DNA_A[0] += 0.125;
      await modelingState.fit_cell_cycle_model(row, 'watson_pragmatic');
      const second = modeling.activeResultKey;
      return {
        pass: first !== second && Object.keys(modeling.resultsByKey).length === 2,
        detail: JSON.stringify({ first, second }),
      };
    });

    await runAsync('GATE-01: a nonconverged fit is still reported (becomes the active result) with a non-convergence warning', async () => {
      const row = buildReviewedRow('fit-orch-limit-preview');
      const result = await modelingState.fit_cell_cycle_model(row, 'dean_jett', { maxIterations: 0 });
      const modeling = modelingState.get_modeling_state(row);
      return {
        // FlowJo-style report+warn: a fit that hit its iteration limit is still
        // reported (becomes the active result) as long as it produced coherent
        // fractions; the non-convergence is surfaced as a warning, not withheld.
        pass: result.optimizerConverged === false
          && result.validForReporting === true
          && modeling.activeResultKey !== null
          && modeling.resultsByKey[modeling.activeResultKey] === result
          && (result.warnings ?? []).some((w) => w.code === 'optimizer_not_converged'),
        detail: JSON.stringify({ optimizerConverged: result.optimizerConverged, active: modeling.activeResultKey,
                                 warnings: (result.warnings ?? []).map((w) => w.code) }),
      };
    });

    await runAsync('GATE-01: cancellation cannot activate or report a completed candidate', async () => {
      const row = buildReviewedRow('fit-orch-cancelled');
      const controller = new AbortController();
      controller.abort();
      const result = await modelingState.fit_cell_cycle_model(row, 'dean_jett', { signal: controller.signal });
      const modeling = modelingState.get_modeling_state(row);
      return {
        pass: result.cancelled === true && result.computed === false
          && result.validForReporting === false && modeling.activeResultKey === null,
        detail: JSON.stringify({ cancelled: result.cancelled, computed: result.computed, active: modeling.activeResultKey }),
      };
    });

    await runAsync('UI-11: a fit finishing after its inputs change cannot mutate model state', async () => {
      const row = buildReviewedRow('fit-orch-stale-input');
      const pending = modelingState.fit_cell_cycle_model(row, 'dean_jett');
      modelingState.set_model_settings(row, { ratioMode: 'locked', lockedRatio: 2 });
      let code = null;
      try { await pending; } catch (error) { code = error.code; }
      const modeling = modelingState.get_modeling_state(row);
      return {
        pass: code === 'FIT_INPUTS_CHANGED'
          && modeling.activeResultKey === null
          && Object.keys(modeling.resultsByKey).length === 0,
        detail: JSON.stringify({ code, active: modeling.activeResultKey, keys: Object.keys(modeling.resultsByKey) }),
      };
    });

    await runAsync('fit_cell_cycle_model runs off the main thread via the shared fit worker', async () => {
      // Mirrors the existing "fit worker: a real fit matches the main-thread
      // result" test's approach: a real Worker was actually used if progress
      // events arrived, since a synchronous main-thread fallback path never
      // posts them.
      const row = buildReviewedRow('fit-orch-worker-progress');
      const progressEvents = [];
      await modelingState.fit_cell_cycle_model(row, 'dean_jett', {
        onProgress: (event) => progressEvents.push(event),
      });
      return { pass: progressEvents.length > 0, detail: progressEvents.length };
    });

    await runAsync('fit_cell_cycle_model keeps independent results per model for the same sample', async () => {
      const row = buildReviewedRow('fit-orch-multi-model');
      const djResult = await modelingState.fit_cell_cycle_model(row, 'dean_jett');
      const watsonResult = await modelingState.fit_cell_cycle_model(row, 'watson_pragmatic');
      const modeling = modelingState.get_modeling_state(row);
      const keys = Object.keys(modeling.resultsByKey);
      const pass = keys.length === 2
        && modeling.resultsByKey[modeling.activeResultKey] === watsonResult
        && Object.values(modeling.resultsByKey).some((r) => r === djResult);
      return { pass, detail: JSON.stringify({ keys, activeResultKey: modeling.activeResultKey }) };
    });

  return results;
  })();
}"""


def run_cell_cycle_fit_orchestration_tests(ctx: TestContext):
    """Run modeling_state.js fit-orchestration assertions."""

    try:
        all_results = ctx.page.evaluate(_TESTS)
    except Exception as err:
        ctx.check(
            GROUP,
            "cell-cycle fit-orchestration suite setup",
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
