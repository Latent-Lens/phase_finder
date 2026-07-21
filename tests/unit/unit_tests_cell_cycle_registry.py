#!/usr/bin/env python3
"""Browser unit coverage for the model-neutral cell-cycle model registry
(js/analysis/cell_cycle/model_registry.js) and the legacy_bridge_v1 adapter
that proves the contract end-to-end against the existing fit implementation.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / Cell Cycle Registry"


_TESTS = r"""() => {
  const registry = window.CellCycleModelRegistry;
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
  const throws = (callback, pattern = null) => {
    try {
      callback();
      return false;
    } catch (error) {
      return pattern ? pattern.test(error.message) : true;
    }
  };

  return (async () => {
    run('registry: rejects entries missing an id', () => {
      const failed = throws(() => registry.register_model({ fit: () => {}, normalizeResult: () => {}, fitScope: 'per_sample' }), /non-empty string id/);
      return { pass: failed, detail: `failed=${failed}` };
    });

    run('registry: rejects entries missing fit()', () => {
      const failed = throws(() => registry.register_model({ id: 'x', normalizeResult: () => {}, fitScope: 'per_sample' }), /must provide a fit/);
      return { pass: failed, detail: `failed=${failed}` };
    });

    run('registry: rejects entries missing normalizeResult()', () => {
      const failed = throws(() => registry.register_model({ id: 'x', fit: () => {}, fitScope: 'per_sample' }), /must provide a normalizeResult/);
      return { pass: failed, detail: `failed=${failed}` };
    });

    run('registry: rejects an invalid fitScope', () => {
      const failed = throws(() => registry.register_model({ id: 'x', fit: () => {}, normalizeResult: () => {}, fitScope: 'whenever' }), /per_sample.*joint_series/);
      return { pass: failed, detail: `failed=${failed}` };
    });

    run('registry: register/get/list round-trip, and clear_registry empties it', () => {
      registry.clear_registry();
      const entry = { id: 'unit-test-model', fit: () => {}, normalizeResult: () => {}, fitScope: 'per_sample' };
      registry.register_model(entry);
      const got = registry.get_model('unit-test-model');
      const listed = registry.list_models();
      registry.clear_registry();
      const afterClear = registry.get_model('unit-test-model');
      return {
        pass: got === entry && listed.length === 1 && listed[0] === entry && afterClear === null,
        detail: JSON.stringify({ got: !!got, listedLength: listed.length, afterClear }),
      };
    });

    run('registry: get_model returns null for an unknown id', () => {
      return { pass: registry.get_model('does-not-exist') === null, detail: '' };
    });

    await runAsync('registry: register_default_models() registers legacy_bridge_v1 with the right contract shape', async () => {
      registry.clear_registry();
      await registry.register_default_models();
      const entry = registry.get_model('legacy_bridge_v1');
      return {
        pass: !!entry
          && entry.version === '1.0.0'
          && entry.kind === 'generative'
          && entry.fitScope === 'per_sample'
          && entry.comparisonGroup === null // never AIC/BIC-compared against canonical models
          && typeof entry.fit === 'function'
          && typeof entry.normalizeResult === 'function'
          // Not an exact registry size: register_default_models() gains a new
          // canonical model at each milestone (dean_jett here in M3; DJF/Watson
          // later), and this test only cares that legacy_bridge_v1 itself is
          // still registered with its documented compatibility-model shape.
          && registry.list_models().some((m) => m.id === 'legacy_bridge_v1'),
        detail: JSON.stringify({ entry: entry && { id: entry.id, version: entry.version, comparisonGroup: entry.comparisonGroup } }),
      };
    });

    run('registry: register_default_models() also registers the canonical dean_jett model', () => {
      const entry = registry.get_model('dean_jett');
      return {
        pass: !!entry
          && entry.kind === 'generative'
          && entry.fitScope === 'per_sample'
          && entry.comparisonGroup === 'poisson_cell_cycle'
          && typeof entry.fit === 'function'
          && typeof entry.normalizeResult === 'function',
        detail: JSON.stringify({ entry: entry && { id: entry.id, version: entry.version, comparisonGroup: entry.comparisonGroup } }),
      };
    });

    run('registry: legacy_bridge_v1 fits a real bimodal histogram and normalizes to the generic result contract', () => {
      const entry = registry.get_model('legacy_bridge_v1');
      const histogram = window.TestUtils.buildDJFHistogram(256);
      const raw = entry.fit({ histogram, config: {} });
      const result = entry.normalizeResult(raw);

      const componentIds = result.components.map((c) => c.id).join(',');
      const componentsSumToFitted = result.components.every((c) =>
        Array.isArray(c.counts) && c.counts.length === result.expectedCounts.length
      );

      return {
        pass: result.schemaVersion === 1
          && result.modelId === 'legacy_bridge_v1'
          && result.comparisonGroup === null
          && typeof result.converged === 'boolean'
          && typeof result.parameters.mu1 === 'number' && result.parameters.mu1 > 0
          && typeof result.parameters.R === 'number'
          && Array.isArray(result.expectedCounts) && result.expectedCounts.length === histogram.x.length
          && componentIds === 'g1,s,g2'
          && componentsSumToFitted
          && Array.isArray(result.warnings)
          && Array.isArray(result.targetResults)
          && result.provenance.rawResult === raw,
        detail: JSON.stringify({
          converged: result.converged, mu1: result.parameters.mu1, R: result.parameters.R,
          componentIds, expectedCountsLength: result.expectedCounts.length,
        }),
      };
    });

    return results;
  })();
}"""


def run_cell_cycle_registry_tests(ctx: TestContext):
    results = ctx.page.evaluate(_TESTS)
    for result in results:
        ctx.check(GROUP, result["name"], result["pass"], result["detail"])
