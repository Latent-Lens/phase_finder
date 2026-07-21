#!/usr/bin/env python3
"""Browser unit coverage for js/analysis/cell_cycle/modeling_state.js's fit
orchestration (M6): fit_cell_cycle_model, get_modeling_state, and
set_model_settings -- the plan §4.2 operations that connect the registered
models (dean_jett, dean_jett_fox, watson_pragmatic, auto_dj_djf) to a row's
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
    pipeline.run_stage0(row);
    pipeline.run_stage4(row, { binCount: 128, range: [0, 220] });
    modelingState.detect_peak_regions(row);
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

    await throwsAsync(async () => {
      const row = buildBimodalRow('fit-orch-no-histogram', 100);
      pipeline.clear_state(row.name);
      await modelingState.fit_cell_cycle_model(row, 'dean_jett');
    }, /Stage 4 histogram/).then((failed) => push(
      'fit_cell_cycle_model requires a Stage 4 histogram first',
      failed,
      `failed=${failed}`,
    ));

    await throwsAsync(async () => {
      const row = buildBimodalRow('fit-orch-no-regions', 1500);
      pipeline.clear_state(row.name);
      pipeline.run_stage0(row);
      pipeline.run_stage4(row, { binCount: 128, range: [0, 220] });
      await modelingState.fit_cell_cycle_model(row, 'dean_jett');
    }, /peak regions/).then((failed) => push(
      'fit_cell_cycle_model requires accepted peak regions first',
      failed,
      `failed=${failed}`,
    ));

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
      const modeling = modelingState.get_modeling_state(row);
      const stored = modeling.resultsByKey[modeling.activeResultKey];
      const pass = result.modelId === 'dean_jett'
        && typeof result.converged === 'boolean'
        && result.phaseFractions
        && Number.isFinite(result.phaseFractions.g1)
        && stored === result
        && modeling.settings.modelId === 'dean_jett';
      return { pass, detail: JSON.stringify({ modelId: result.modelId, converged: result.converged, phaseFractions: result.phaseFractions }) };
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

    await runAsync('fit_cell_cycle_model fits auto_dj_djf end to end and normalizes to the generic result contract', async () => {
      const row = buildReviewedRow('fit-orch-auto');
      const result = await modelingState.fit_cell_cycle_model(row, 'auto_dj_djf');
      const pass = result.modelId === 'auto_dj_djf'
        && result.modelComparison
        && ['dean_jett', 'dean_jett_fox'].includes(result.modelComparison.selectedModelId)
        && Array.isArray(result.warnings)
        && Array.isArray(result.components);
      return { pass, detail: JSON.stringify({ selectedModelId: result.modelComparison?.selectedModelId, componentCount: result.components?.length }) };
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
