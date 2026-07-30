#!/usr/bin/env python3
"""Browser unit coverage for models/watson_classic.js: the canonical parametric
Watson model (G1/G2 Gaussians + broadened-rectangle/trapezoid S phase), added so
PhaseFinder can reproduce the external Flowreader Watson reference (VALID-01).

The parameter-recovery test builds its synthetic histogram from the same
primitives the model fits with (peakComponents + watsonRectangleSPhase), so it
verifies the optimizer/parameterization recover known theta, not a coincidence of
an independent generator matching the model."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / Cell Cycle Watson Classic"


_WATSON_CLASSIC_TESTS = r"""() => {
  const { peakComponents } = window.CellCycleModelShared;
  const { trapezoidProfile, projectTrapezoidSlope, watsonRectangleSPhase } = window.CellCycleWatsonClassic;
  const { register_default_models, get_model, clear_registry } = window.CellCycleModelRegistry;

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
  const close = (a, b, tol) => Math.abs(a - b) <= tol;
  const relClose = (a, b, rel) => Math.abs(a - b) <= rel * Math.max(Math.abs(b), 1);
  const sum = (xs) => xs.reduce((s, v) => s + v, 0);

  const edges = Array.from({ length: 301 }, (_, i) => i); // 300 bins, width 1
  const regions = { g1: { left: 55, right: 85 }, g2: { left: 120, right: 165 } };

  register_default_models();
  const model = get_model('watson_classic');

  run('watson_classic is registered as a generative, AIC/BIC-comparable per-sample model', () => ({
    pass: Boolean(model) && model.id === 'watson_classic'
      && model.kind === 'generative' && model.fitScope === 'per_sample'
      && model.comparisonGroup === 'poisson_cell_cycle',
    detail: model && JSON.stringify({ id: model.id, kind: model.kind, group: model.comparisonGroup }),
  }));

  // ---- S-phase primitives ---------------------------------------------------
  run('trapezoidProfile integrates to 1 over [0,1] for any slope (midpoint = 1)', () => {
    const nodes = 2000;
    for (const slope of [-2, -1, 0, 0.7, 2]) {
      let integral = 0;
      for (let k = 0; k < nodes; k += 1) integral += trapezoidProfile((k + 0.5) / nodes, slope) / nodes;
      if (!close(integral, 1, 1e-6)) return { pass: false, detail: `slope=${slope} integral=${integral}` };
    }
    return { pass: close(trapezoidProfile(0.5, 1.3), 1, 1e-12), detail: 'ok' };
  });

  run('projectTrapezoidSlope clamps to the feasible [-2, 2] and passes valid slopes through', () => {
    const pass = projectTrapezoidSlope(5) === 2 && projectTrapezoidSlope(-5) === -2
      && projectTrapezoidSlope(0.9) === 0.9;
    return { pass, detail: JSON.stringify([projectTrapezoidSlope(5), projectTrapezoidSlope(-5), projectTrapezoidSlope(0.9)]) };
  });

  run('watsonRectangleSPhase (slope 0) integrates to the S area and is flat between the peaks', () => {
    const s = watsonRectangleSPhase(edges, { sArea: 5000, g1Mean: 70, g2Mean: 140, broadeningCV: 0.06, slope: 0 }, 64);
    const total = sum(s);
    // Bins well inside [70,140] should carry near-equal mass (rectangle top).
    const mid = [95, 100, 105, 110].map((center) => s[center]); // bin index == left edge for width-1 bins
    const flat = mid.every((v) => relClose(v, mid[0], 0.05));
    return {
      pass: relClose(total, 5000, 0.01) && flat,
      detail: JSON.stringify({ total, mid }),
    };
  });

  run('watsonRectangleSPhase area is invariant to slope (trapezoid tilts but conserves mass)', () => {
    const flat = sum(watsonRectangleSPhase(edges, { sArea: 4000, g1Mean: 70, g2Mean: 140, broadeningCV: 0.06, slope: 0 }, 64));
    const tilted = sum(watsonRectangleSPhase(edges, { sArea: 4000, g1Mean: 70, g2Mean: 140, broadeningCV: 0.06, slope: 1.5 }, 64));
    return { pass: relClose(flat, 4000, 0.01) && relClose(tilted, 4000, 0.01), detail: JSON.stringify({ flat, tilted }) };
  });

  // ---- parameter/fraction recovery -----------------------------------------
  const TRUE = {
    g1Area: 8000, g1Mean: 70, g1CV: 0.06,
    g2Area: 3000, g2Mean: 140, g2CV: 0.07,
    sArea: 4000, slope: 0.5,
  };
  function syntheticCounts(truth, forEdges) {
    const peaks = peakComponents(forEdges, truth);
    const s = watsonRectangleSPhase(forEdges, {
      sArea: truth.sArea, g1Mean: truth.g1Mean, g2Mean: truth.g2Mean, broadeningCV: truth.g1CV, slope: truth.slope,
    }, 64);
    return peaks.g1.map((v, i) => Math.round(v + s[i] + peaks.g2[i]));
  }
  const counts = syntheticCounts(TRUE, edges);
  const raw = model.fit({ histogram: { edges, counts }, peakRegions: regions, config: {} });
  const fitted = model.normalizeResult(raw);
  const trueBio = TRUE.g1Area + TRUE.sArea + TRUE.g2Area;
  const trueFractions = { g1: TRUE.g1Area / trueBio, s: TRUE.sArea / trueBio, g2: TRUE.g2Area / trueBio };

  run('watson_classic fit converges on a noiseless synthetic histogram', () => ({
    pass: fitted.converged === true, detail: fitted.convergenceReason,
  }));

  run('watson_classic recovers G1/S/G2 phase fractions within 2% of the true values', () => {
    const { g1, s, g2 } = fitted.phaseFractions;
    const pass = close(g1, trueFractions.g1, 0.02) && close(s, trueFractions.s, 0.02) && close(g2, trueFractions.g2, 0.02);
    return { pass, detail: JSON.stringify({ fitted: fitted.phaseFractions, truth: trueFractions }) };
  });

  run('watson_classic recovers G1/G2 means within one bin and the S slope within 0.2', () => {
    const pass = close(fitted.parameters.g1Mean, TRUE.g1Mean, 1)
      && close(fitted.parameters.g2Mean, TRUE.g2Mean, 1)
      && close(fitted.parameters.slope, TRUE.slope, 0.2);
    return { pass, detail: JSON.stringify({ g1Mean: fitted.parameters.g1Mean, g2Mean: fitted.parameters.g2Mean, slope: fitted.parameters.slope }) };
  });

  run('watson_classic phase fractions are finite, nonnegative, and sum to 1', () => {
    const { g1, s, g2 } = fitted.phaseFractions;
    const pass = [g1, s, g2].every((f) => Number.isFinite(f) && f >= 0) && close(g1 + s + g2, 1, 1e-9);
    return { pass, detail: JSON.stringify(fitted.phaseFractions) };
  });

  run('watson_classic expected counts are finite and nonnegative at every bin', () => ({
    pass: fitted.expectedCounts.every((v) => Number.isFinite(v) && v >= 0),
    detail: fitted.expectedCounts.length,
  }));

  run('watson_classic fitted G1/G2 means stay inside their accepted peak regions', () => {
    const pass = fitted.parameters.g1Mean >= regions.g1.left && fitted.parameters.g1Mean <= regions.g1.right
      && fitted.parameters.g2Mean >= regions.g2.left && fitted.parameters.g2Mean <= regions.g2.right;
    return { pass, detail: JSON.stringify(fitted.parameters) };
  });

  run('watson_classic slope stays within its feasible [-2, 2] bound', () => ({
    pass: fitted.parameters.slope >= -2 && fitted.parameters.slope <= 2,
    detail: String(fitted.parameters.slope),
  }));

  clear_registry();
  return results;
}"""


def run_cell_cycle_watson_classic_tests(ctx: TestContext):
    """Run models/watson_classic.js assertions."""

    try:
        all_results = ctx.page.evaluate(_WATSON_CLASSIC_TESTS)
    except Exception as err:
        ctx.check(GROUP, "watson_classic suite setup", False, str(err), screenshot=False)
        return

    for item in all_results:
        ctx.check(GROUP, item["name"], item["pass"], item.get("detail", ""), screenshot=False)
