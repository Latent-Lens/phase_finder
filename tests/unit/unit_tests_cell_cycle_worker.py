#!/usr/bin/env python3
"""Browser unit coverage for js/analysis/cell_cycle/fit_worker.js and
fit_client.js -- the worker actually runs in a real browser Worker, not a
mock, so this exercises the genuine postMessage round trip.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / Cell Cycle Worker"


_TESTS = r"""() => {
  const registry = window.CellCycleModelRegistry;
  const results = [];
  const push = (name, pass, detail = '') => results.push({
    name, pass: Boolean(pass), detail: String(detail ?? ''),
  });
  const runAsync = async (name, test) => {
    try {
      const outcome = await test();
      push(name, outcome.pass, outcome.detail);
    } catch (error) {
      push(name, false, `${error.name}: ${error.message}`);
    }
  };

  return (async () => {
    const histogram = window.TestUtils.buildDJFHistogram(256);

    await runAsync('fit worker: a real fit matches the main-thread result within tolerance', async () => {
      registry.clear_registry();
      registry.register_default_models();
      const entry = registry.get_model('legacy_bridge_v1');
      const mainThread = entry.normalizeResult(entry.fit({ histogram, config: {} }));

      const { promise } = window.run_fit_in_worker('legacy_bridge_v1', histogram, {}, {});
      const worker = await promise;

      const closeEnough = (a, b, tol) => Math.abs(a - b) <= tol;
      return {
        pass: worker.modelId === 'legacy_bridge_v1'
          && worker.converged === mainThread.converged
          && closeEnough(worker.parameters.mu1, mainThread.parameters.mu1, 1e-6)
          && closeEnough(worker.parameters.R, mainThread.parameters.R, 1e-6)
          && worker.expectedCounts.length === mainThread.expectedCounts.length
          && worker.components.map((c) => c.id).join(',') === mainThread.components.map((c) => c.id).join(','),
        detail: JSON.stringify({
          workerMu1: worker.parameters.mu1, mainMu1: mainThread.parameters.mu1,
          workerR: worker.parameters.R, mainR: mainThread.parameters.R,
        }),
      };
    });

    await runAsync('fit worker: onProgress fires during a real worker fit', async () => {
      const events = [];
      const { promise } = window.run_fit_in_worker('legacy_bridge_v1', histogram, {}, {
        onProgress: (event) => events.push(event),
      });
      await promise;
      return {
        pass: events.length > 0
          && events.every((event) => Number.isFinite(event.iteration) && Number.isFinite(event.sse)),
        detail: JSON.stringify(events),
      };
    });

    await runAsync('fit worker: an unknown model id rejects with a clear error', async () => {
      const { promise } = window.run_fit_in_worker('not-a-real-model', histogram, {}, {});
      try {
        await promise;
        return { pass: false, detail: 'expected the promise to reject' };
      } catch (error) {
        return { pass: /Unknown model/.test(error.message), detail: error.message };
      }
    });

    await runAsync('fit worker: concurrent requests are routed back to the correct caller by request id', async () => {
      const narrowHistogram = window.TestUtils.buildDJFHistogram(64);
      const wideHistogram = window.TestUtils.buildDJFHistogram(512);
      const a = window.run_fit_in_worker('legacy_bridge_v1', narrowHistogram, {}, {});
      const b = window.run_fit_in_worker('legacy_bridge_v1', wideHistogram, {}, {});
      const [resultA, resultB] = await Promise.all([a.promise, b.promise]);
      return {
        pass: resultA.expectedCounts.length === 64 && resultB.expectedCounts.length === 512,
        detail: JSON.stringify({ a: resultA.expectedCounts.length, b: resultB.expectedCounts.length }),
      };
    });

    await runAsync('fit worker: cancel() cannot interrupt an in-flight fit (documented limitation, not a bug)', async () => {
      // legacy_bridge_v1's fit is fully synchronous with no yield points, and
      // a worker processes one message to completion before it can even look
      // at a queued "cancel" message -- so cancel() immediately after
      // starting cannot stop this fit. If this test starts failing, the LM
      // solver has gained real yield points and fit_client.js's docs (and
      // this test) need to be updated to match the new behavior.
      const { promise, cancel } = window.run_fit_in_worker('legacy_bridge_v1', histogram, {}, {});
      cancel();
      const result = await promise;
      return {
        pass: result.convergenceReason !== 'cancelled' && result.converged === true,
        detail: JSON.stringify({ convergenceReason: result.convergenceReason, converged: result.converged }),
      };
    });

    return results;
  })();
}"""


def run_cell_cycle_worker_tests(ctx: TestContext):
    results = ctx.page.evaluate(_TESTS)
    for result in results:
        ctx.check(GROUP, result["name"], result["pass"], result["detail"])
