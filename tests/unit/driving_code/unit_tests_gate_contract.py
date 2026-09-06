#!/usr/bin/env python3
"""GATE-01 regression coverage for the "one authoritative contract" requirement:
a model result is reportable only if it went through BOTH halves of the shared
contract -- model_preflight() for its input preconditions and
apply_result_contract() for its output quality.

The audited hole was that "not validated" and "validated and rejected" were
indistinguishable: a raw registry normalizeResult() output has no
`validForReporting` field, and every consumer's `=== true` check therefore
happened to refuse it. That is refusal by accident. These tests assert the
positive property instead -- the contract stamp -- and prove the stamp cannot be
obtained without a preflight."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / GATE-01 Result Contract"


_GATE_TESTS = r"""async () => {
  const contract = window.CellCycleResultContract;
  const registry = window.CellCycleModelRegistry;
  const pipelineState = window.DJFPipelineState;

  const results = [];
  const push = (name, pass, detail = '') => results.push({
    name, pass: Boolean(pass), detail: String(detail ?? ''),
  });
  // Awaits so an async assertion (the per-sample fit entry point below) is
  // recorded like any other rather than resolving after the results are read.
  const run = async (name, test) => {
    try {
      const outcome = await test();
      push(name, outcome.pass, outcome.detail);
    } catch (error) {
      push(name, false, `${error.name}: ${error.message}`);
    }
  };
  const capture = (callback) => {
    try { callback(); return null; } catch (error) { return error; }
  };

  const rawResult = () => ({
    kind: 'generative', modelId: 'dean_jett', modelLabel: 'Dean–Jett',
    converged: true, terminationReason: 'objective_step_tolerance', cancelled: false,
    expectedCounts: [4, 5, 6], phaseFractions: { g1: 0.5, s: 0.3, g2: 0.2 },
    diagnostics: { deviance: 10, bic: 42, reducedDeviance: 1.1 },
  });
  const passingPreflight = { passed: true, reasons: [] };

  await run('GATE-01: apply_result_contract stamps the contract version it validated under', () => {
    const applied = contract.apply_result_contract(rawResult(), passingPreflight);
    return {
      pass: applied.contractVersion === contract.RESULT_CONTRACT_VERSION
        && contract.is_contracted_result(applied) === true,
      detail: JSON.stringify({ version: applied.contractVersion, expected: contract.RESULT_CONTRACT_VERSION }),
    };
  });

  await run('GATE-01: a result cannot be validated without its preflight bundle', () => {
    const missing = capture(() => contract.apply_result_contract(rawResult()));
    const nulled = capture(() => contract.apply_result_contract(rawResult(), null));
    const malformed = capture(() => contract.apply_result_contract(rawResult(), { reasons: [] }));
    return {
      pass: [missing, nulled, malformed].every((error) => error?.code === 'PREFLIGHT_MISSING'),
      detail: JSON.stringify([missing?.code, nulled?.code, malformed?.code]),
    };
  });

  await run('GATE-01: a FAILED preflight still contracts the result, carrying its reasons', () => {
    // Failing closed means the result is produced and marked unreportable with
    // machine-readable reasons -- not that the contract refuses to describe it.
    const applied = contract.apply_result_contract(rawResult(), {
      passed: false,
      reasons: [{ code: contract.RESULT_REASON.REGIONS_UNREVIEWED, message: 'Review the peak regions first.' }],
    });
    return {
      pass: contract.is_contracted_result(applied)
        && applied.validityReasons.some((reason) => reason.code === contract.RESULT_REASON.REGIONS_UNREVIEWED),
      detail: JSON.stringify(applied.validityReasons.map((reason) => reason.code)),
    };
  });

  await run('GATE-01: a raw registry normalizeResult() output is NOT contracted', () => {
    registry.clear_registry();
    registry.register_default_models();
    const model = registry.get_model('dean_jett');
    const edges = [];
    for (let i = 0; i <= 120; i += 1) edges.push(i * 5);
    const centers = edges.slice(0, -1).map((left, i) => 0.5 * (left + edges[i + 1]));
    const gauss = (x, mu, sigma) => Math.exp(-0.5 * ((x - mu) / sigma) ** 2);
    const counts = centers.map((x) =>
      Math.round(4000 * gauss(x, 200, 12) + 1800 * gauss(x, 400, 22) + 900 * gauss(x, 300, 70)));
    const normalized = model.normalizeResult(model.fit({
      histogram: { edges, counts, x: centers, y: counts },
      peakRegions: { g1: { left: 160, right: 240 }, g2: { left: 350, right: 450 } },
      config: {},
    }));
    return {
      pass: contract.is_contracted_result(normalized) === false
        && contract.is_reportable_result(normalized) === false
        && normalized.validForReporting === undefined,
      detail: JSON.stringify({ contractVersion: normalized.contractVersion, valid: normalized.validForReporting }),
    };
  });

  await run('GATE-01: an object that merely CLAIMS validForReporting is refused', () => {
    // The failure mode the stamp exists to close: a code path that forgot the
    // validator, or a hand-built object, cannot fake a validated result.
    const forged = { ...rawResult(), validForReporting: true, scientificallyValid: true };
    return {
      pass: contract.is_reportable_result(forged) === false
        && contract.result_reporting_summary(forged).reportable === false
        && contract.result_reporting_summary(forged).phaseFractions === null,
      detail: JSON.stringify(contract.result_reporting_summary(forged)),
    };
  });

  await run('GATE-01: assert_result_contracted rejects an ungated result at a consumer boundary', () => {
    const error = capture(() => contract.assert_result_contracted({ modelId: 'dean_jett' }, 'TSV export'));
    const applied = contract.apply_result_contract(rawResult(), passingPreflight);
    return {
      pass: error?.code === 'RESULT_NOT_CONTRACTED'
        && /TSV export/.test(error.message)
        && error.detail.modelId === 'dean_jett'
        && contract.assert_result_contracted(applied, 'TSV export') === applied,
      detail: JSON.stringify({ code: error?.code, detail: error?.detail }),
    };
  });

  await run('GATE-01: the active-result accessor demands the stamp, not just the verdict', () => {
    const applied = contract.apply_result_contract(rawResult(), passingPreflight);
    const forged = { ...rawResult(), validForReporting: true };
    const contracted = { modeling: { activeResultKey: 'k', resultsByKey: { k: applied } } };
    const faked = { modeling: { activeResultKey: 'k', resultsByKey: { k: forged } } };
    return {
      pass: pipelineState.get_active_model_result(contracted) === applied
        && pipelineState.get_active_model_result(faked) === null,
      detail: JSON.stringify({ contracted: !!pipelineState.get_active_model_result(contracted) }),
    };
  });

  await run('GATE-01: the preflight bundle travels with the result for audit', () => {
    const preflight = {
      passed: true, reasons: [], histogramFingerprint: 'fp-1', regionRevision: 7,
      retainedEventCount: 12345, qc: { structural: { status: 'applied' } },
    };
    const applied = contract.apply_result_contract(rawResult(), preflight);
    return {
      pass: applied.preflight === preflight
        && applied.preflight.qc.structural.status === 'applied'
        && applied.preflight.histogramFingerprint === 'fp-1',
      detail: JSON.stringify(applied.preflight),
    };
  });

  await run('AMBIG-01/D9: an inferred_g2 (single-peak) selection is preflighted through and qualified with a warning, not silently accepted', () => {
    const state = {
      histogram: { fingerprint: 'fp-amb', edges: [0, 1, 2], counts: [1, 1] },
      modeling: {
        histogramFingerprint: 'fp-amb',
        peakDetection: { status: 'inferred_g2', confidence: 0.4, reasons: ['NO_PLAUSIBLE_DETECTED_PAIR'] },
        peakSelection: {
          regions: { g1: { left: 0, right: 1 }, g2: { left: 1, right: 2 } },
          reviewed: true, stale: false, revision: 1,
        },
      },
      channelKey: 'DNA_A',
    };
    const preflight = contract.model_preflight(state);
    const applied = contract.apply_result_contract(rawResult(), preflight);
    const detectedPreflight = contract.model_preflight({
      ...state,
      modeling: { ...state.modeling, peakDetection: { status: 'detected', confidence: 0.9, reasons: [] } },
    });
    const detectedApplied = contract.apply_result_contract(rawResult(), detectedPreflight);
    return {
      pass: preflight.peakDetectionStatus === 'inferred_g2'
        && applied.warnings.some((w) => w.code === contract.RESULT_REASON.REGIONS_AMBIGUOUS_SINGLE_PEAK)
        && applied.validForReporting === true
        && !detectedApplied.warnings.some((w) => w.code === contract.RESULT_REASON.REGIONS_AMBIGUOUS_SINGLE_PEAK),
      detail: JSON.stringify({
        status: preflight.peakDetectionStatus,
        warnings: applied.warnings.map((w) => w.code),
        detectedWarnings: detectedApplied.warnings.map((w) => w.code),
      }),
    };
  });

  await run('GATE-01: the per-sample fit entry point produces a contracted result', async () => {
    // fit_cell_cycle_model() is the single per-sample entry point every UI,
    // bulk, ridge-edit, and session-restore path funnels through; proving IT
    // contracts is what makes those paths gated.
    const pipeline = window.PhaseFinder.pipeline;
    const modelingState = window.CellCycleModelingState;
    const count = 4000;
    const dna = new Float64Array(count);
    let seed = 20260731;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const normal = () => {
      const u = Math.max(random(), 1e-9);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
    };
    for (let i = 0; i < count; i += 1) {
      dna[i] = i < 2400 ? 70 + 4 * normal() : i < 3000 ? 70 + (70 * (i - 2400)) / 600 : 140 + 6 * normal();
    }
    const row = {
      id: 'gate-01-row', name: 'gate-01.fcs',
      data: { eventCount: count, channel_key: 'DNA_A', dna_a: dna, channels: { DNA_A: dna }, pnr: {} },
    };
    pipeline.clear_state(row.name);
    pipeline.apply_structural_qc(row);
    pipeline.apply_dna_histogram(row, { binCount: 128, range: [0, 220] });
    modelingState.detect_peak_regions(row);
    modelingState.update_peak_regions(row, { g1: { left: 55, right: 85 }, g2: { left: 120, right: 160 } });

    const result = await modelingState.fit_cell_cycle_model(row, 'dean_jett');
    return {
      pass: contract.is_contracted_result(result) === true && !!result.preflight,
      detail: JSON.stringify({ version: result.contractVersion, reportable: result.validForReporting }),
    };
  });

  return results;
}"""


def run_gate_contract_tests(ctx: TestContext):
    """Run the GATE-01 result-contract assertions."""

    try:
        all_results = ctx.page.evaluate(_GATE_TESTS)
    except Exception as err:
        ctx.check(GROUP, "GATE-01 suite setup", False, str(err), screenshot=False)
        return

    for item in all_results:
        ctx.check(GROUP, item["name"], item["pass"], item.get("detail", ""), screenshot=False)
