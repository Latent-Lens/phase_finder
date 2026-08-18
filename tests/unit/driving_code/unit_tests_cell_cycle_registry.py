#!/usr/bin/env python3
"""Browser unit coverage for the model-neutral cell-cycle model registry
(js/analysis/cell_cycle/model_registry.js) and the canonical model adapters
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

    await runAsync('registry: the retired legacy_bridge_v1 compatibility model is NOT registered', async () => {
      // Removed with the pre-canonical stage 5-8 bridge. It was never
      // reportable, and every canonical model now covers its surface.
      registry.clear_registry();
      await registry.register_default_models();
      const ids = registry.list_models().map((model) => model.id);
      return {
        pass: registry.get_model('legacy_bridge_v1') === null && !ids.includes('legacy_bridge_v1'),
        detail: JSON.stringify(ids),
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

    run('registry: register_default_models() also registers the canonical dean_jett_fox model', () => {
      const entry = registry.get_model('dean_jett_fox');
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

    run('registry: register_default_models() also registers the watson_pragmatic decomposition', () => {
      const entry = registry.get_model('watson_pragmatic');
      return {
        pass: !!entry
          && entry.kind === 'decomposition'
          && entry.fitScope === 'per_sample'
          && entry.comparisonGroup === null
          && entry.capabilities?.autoComparison === false
          && typeof entry.fit === 'function'
          && typeof entry.normalizeResult === 'function',
        detail: JSON.stringify({ entry: entry && { id: entry.id, kind: entry.kind, comparisonGroup: entry.comparisonGroup } }),
      };
    });

    run('registry: the retired auto_dj_djf selection policy is NOT registered', () => {
      // Retired together with dean_jett_fox's "joint" estimator, which existed
      // only to give Auto a like-for-like DJ-vs-DJF comparison.
      const ids = registry.list_models().map((model) => model.id);
      return {
        pass: registry.get_model('auto_dj_djf') == null && !ids.includes('auto_dj_djf'),
        detail: JSON.stringify(ids),
      };
    });

    return results;
  })();
}"""


def run_cell_cycle_registry_tests(ctx: TestContext):
    results = ctx.page.evaluate(_TESTS)
    for result in results:
        ctx.check(GROUP, result["name"], result["pass"], result["detail"])
