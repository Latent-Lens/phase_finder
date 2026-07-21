#!/usr/bin/env python3
"""Browser unit coverage for js/analysis/cell_cycle/fit_engine.js,
diagnostics.js, and models/dean_jett.js: the canonical Dean-Jett model (M3)
end to end -- deterministic multi-start Poisson fitting, region/ratio/CV-mode
constraints (plan §6.2), and the diagnostics/warnings bundle (plan §5.1).

The parameter-recovery test builds its synthetic histogram from the exact
same shared.js primitives the model fits with (peakComponents +
convolvedSPhase), so it verifies the *optimizer and parameterization*
recover known theta, not a coincidence of some independent generator
matching the model by construction."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / Cell Cycle Dean-Jett"


_DEAN_JETT_TESTS = r"""() => {
  const { gaussianBinMass } = window.CellCycleGaussianBinMass;
  const { peakComponents, convolvedSPhase } = window.CellCycleModelShared;
  const { register_default_models, get_model, clear_registry } = window.CellCycleModelRegistry;
  const { fitPoissonModel } = window.CellCycleFitEngine;
  const {
    buildPoissonFitDiagnostics, tailMassWarning, boundaryHitWarnings,
    fitQualityWarnings, akaikeInformationCriterionCorrected,
  } = window.CellCycleDiagnostics;

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
  const close = (left, right, tolerance) => Math.abs(left - right) <= tolerance;
  const relClose = (left, right, relTolerance) =>
    Math.abs(left - right) <= relTolerance * Math.max(Math.abs(right), 1);

  // ---- shared synthetic fixture ---------------------------------------------
  const edges = Array.from({ length: 301 }, (_, i) => i); // 300 bins, width 1
  const TRUE = {
    g1Area: 8000, g1Mean: 70, g1CV: 0.06,
    g2Area: 3000, g2Mean: 140, g2CV: 0.07,
    sArea: 4000, b: 0.5, c: -0.3,
  };
  function syntheticCounts(truth, forEdges) {
    const peaks = peakComponents(forEdges, truth);
    const sCounts = convolvedSPhase(forEdges, {
      sArea: truth.sArea, g1Mean: truth.g1Mean, g2Mean: truth.g2Mean,
      broadeningCV: truth.g1CV, b: truth.b, c: truth.c,
    }, 64);
    return peaks.g1.map((value, i) => Math.round(value + sCounts[i] + peaks.g2[i]));
  }
  const counts = syntheticCounts(TRUE, edges);
  const regions = { g1: { left: 55, right: 85 }, g2: { left: 120, right: 165 } };

  register_default_models();
  const model = get_model('dean_jett');

  run('dean_jett is registered by register_default_models()', () => ({
    pass: Boolean(model) && model.id === 'dean_jett' && model.fitScope === 'per_sample',
    detail: model && model.id,
  }));

  // ---- parameter/fraction recovery (theta from the formula block) ----------
  const raw = model.fit({ histogram: { edges, counts }, peakRegions: regions, config: {} });
  const fitted = model.normalizeResult(raw);
  const trueBiologicalTotal = TRUE.g1Area + TRUE.sArea + TRUE.g2Area;
  const trueFractions = {
    g1: TRUE.g1Area / trueBiologicalTotal,
    s: TRUE.sArea / trueBiologicalTotal,
    g2: TRUE.g2Area / trueBiologicalTotal,
  };

  run('dean_jett fit converges on a noiseless synthetic histogram', () => ({
    pass: fitted.converged === true,
    detail: fitted.convergenceReason,
  }));

  run('dean_jett recovers G1/S/G2 phase fractions within 2% of the true values', () => {
    const { g1, s, g2 } = fitted.phaseFractions;
    const pass =
      close(g1, trueFractions.g1, 0.02) &&
      close(s, trueFractions.s, 0.02) &&
      close(g2, trueFractions.g2, 0.02);
    return { pass, detail: JSON.stringify({ fitted: fitted.phaseFractions, truth: trueFractions }) };
  });

  run('dean_jett recovers G1 and G2 means within one bin width of the truth', () => {
    const pass =
      close(fitted.parameters.g1Mean, TRUE.g1Mean, 1) &&
      close(fitted.parameters.g2Mean, TRUE.g2Mean, 1);
    return { pass, detail: JSON.stringify({ g1Mean: fitted.parameters.g1Mean, g2Mean: fitted.parameters.g2Mean }) };
  });

  run('dean_jett recovers G1 and G2 CVs within 15% relative of the truth', () => {
    const pass =
      relClose(fitted.parameters.g1CV, TRUE.g1CV, 0.15) &&
      relClose(fitted.parameters.g2CV, TRUE.g2CV, 0.15);
    return { pass, detail: JSON.stringify({ g1CV: fitted.parameters.g1CV, g2CV: fitted.parameters.g2CV }) };
  });

  run('dean_jett expected counts are finite and nonnegative at every bin', () => {
    const pass = fitted.expectedCounts.every((value) => Number.isFinite(value) && value >= 0);
    return { pass, detail: fitted.expectedCounts.length };
  });

  run("dean_jett component totalArea is each component's true area parameter, at least as large as its observed-domain sum", () => {
    const pass = fitted.components.every((c) => c.totalArea >= c.observedDomainArea - 1e-6);
    return { pass, detail: fitted.components.map((c) => `${c.id}: total=${c.totalArea.toFixed(1)} domain=${c.observedDomainArea.toFixed(1)}`).join('; ') };
  });

  run('dean_jett fitted G1/G2 means stay inside their accepted peak regions', () => {
    const pass =
      fitted.parameters.g1Mean >= regions.g1.left && fitted.parameters.g1Mean <= regions.g1.right &&
      fitted.parameters.g2Mean >= regions.g2.left && fitted.parameters.g2Mean <= regions.g2.right;
    return { pass, detail: JSON.stringify(fitted.parameters) };
  });

  run('dean_jett default (bounded) ratio mode keeps the fitted G2:G1 ratio within fitRatioRange', () => {
    const ratio = fitted.parameters.g2Mean / fitted.parameters.g1Mean;
    const pass = ratio >= 1.65 - 1e-6 && ratio <= 2.25 + 1e-6;
    return { pass, detail: ratio };
  });

  // ---- ratio/CV mode constraints (plan §6.2 -- not part of the emission model) ----
  run('dean_jett locked-ratio mode fits with fitted g2Mean == lockedRatio * fitted g1Mean exactly', () => {
    const lockedRaw = model.fit({
      histogram: { edges, counts }, peakRegions: regions,
      config: { ratioMode: 'locked', lockedRatio: 2 },
    });
    const lockedFit = model.normalizeResult(lockedRaw);
    const pass = close(lockedFit.parameters.g2Mean, 2 * lockedFit.parameters.g1Mean, 1e-6);
    return { pass, detail: JSON.stringify(lockedFit.parameters) };
  });

  run('dean_jett rejects an infeasible locked ratio before running the optimizer', () => {
    const tightRegions = { g1: { left: 55, right: 85 }, g2: { left: 250, right: 260 } };
    let threw = false;
    let message = '';
    try {
      model.fit({ histogram: { edges, counts }, peakRegions: tightRegions, config: { ratioMode: 'locked', lockedRatio: 2 } });
    } catch (error) {
      threw = true;
      message = error.message;
    }
    return { pass: threw, detail: message };
  });

  run('dean_jett equal-CV mode ties fitted g2CV to fitted g1CV exactly', () => {
    const equalRaw = model.fit({
      histogram: { edges, counts }, peakRegions: regions,
      config: { cvMode: 'equal' },
    });
    const equalFit = model.normalizeResult(equalRaw);
    return { pass: equalFit.parameters.g2CV === equalFit.parameters.g1CV, detail: JSON.stringify(equalFit.parameters) };
  });

  run('dean_jett.expectedCounts(edges, parameters) reproduces the fit result expected counts', () => {
    const recomputed = model.expectedCounts(edges, fitted.parameters);
    let maxDiff = 0;
    for (let i = 0; i < recomputed.length; i += 1) maxDiff = Math.max(maxDiff, Math.abs(recomputed[i] - fitted.expectedCounts[i]));
    return { pass: maxDiff < 1e-9, detail: maxDiff };
  });

  // ---- resolution independence (M3 exit gate: "stable across 256/512/1024
  // bins and quadrature refinement") -- NOT a "which bin count fits best"
  // competition: AICc/BIC aren't comparable across different bin counts
  // (they're both functions of n = bin count, so a coarser histogram simply
  // scores differently on a scale that isn't the finer histogram's scale).
  // The actual invariant this checks is that the *same underlying
  // population*, discretized at three different resolutions, recovers the
  // *same* biological answer each time -- proving convolvedSPhase's
  // resolution-independent quadrature (it integrates on its own latent-z
  // grid, never on histogram bin centers) actually pays off end to end
  // through a real fit, not just in isolation the way the 64-vs-128-node
  // quadrature test in unit_tests_cell_cycle_model_shared.py already does.
  run('dean_jett recovers the same phase fractions and means at 256, 512, and 1024 bins', () => {
    const domainMax = 300;
    const resolutions = [256, 512, 1024].map((binCount) => {
      const theseEdges = Array.from({ length: binCount + 1 }, (_, i) => (domainMax * i) / binCount);
      const theseCounts = syntheticCounts(TRUE, theseEdges);
      const theseRaw = model.fit({ histogram: { edges: theseEdges, counts: theseCounts }, peakRegions: regions, config: {} });
      return model.normalizeResult(theseRaw);
    });

    const allConverged = resolutions.every((r) => r.converged);
    const fractionSpread = (key) => {
      const values = resolutions.map((r) => r.phaseFractions[key]);
      return Math.max(...values) - Math.min(...values);
    };
    const meanSpread = (key) => {
      const values = resolutions.map((r) => r.parameters[key]);
      return Math.max(...values) - Math.min(...values);
    };

    const pass = allConverged &&
      fractionSpread('g1') < 0.01 && fractionSpread('s') < 0.01 && fractionSpread('g2') < 0.01 &&
      meanSpread('g1Mean') < 1 && meanSpread('g2Mean') < 1;
    return {
      pass,
      detail: JSON.stringify(resolutions.map((r) => ({ converged: r.converged, fractions: r.phaseFractions, g1Mean: r.parameters.g1Mean, g2Mean: r.parameters.g2Mean }))),
    };
  });

  clear_registry();

  // ---- fit_engine.js: model-agnostic multi-start selection -------------------
  run('fit_engine picks the converged attempt with lowest deviance among multiple starts', () => {
    const trueArea = 5000, mu = 50, sigma = 5;
    const oneEdges = Array.from({ length: 201 }, (_, i) => i * 0.5);
    const observed = gaussianBinMass(oneEdges, trueArea, mu, sigma).map((v) => Math.round(v));
    const expectedCountsFn = (parameters) => gaussianBinMass(oneEdges, Math.max(0, parameters[0]), mu, sigma);
    const projectFn = (parameters) => [Math.max(0, parameters[0])];

    const outcome = fitPoissonModel({
      observedCounts: observed,
      parameterStarts: [[1], [trueArea], [trueArea * 5]],
      freeIndices: [0],
      expectedCountsFn,
      projectFn,
      options: { maxIterations: 100 },
    });

    const pass = outcome.attempts.length === 3 && outcome.converged &&
      relClose(outcome.parameters[0], trueArea, 0.02);
    return { pass, detail: JSON.stringify({ parameters: outcome.parameters, bestStartIndex: outcome.bestStartIndex }) };
  });

  run('fit_engine reports cancelled immediately and skips remaining starts when shouldCancel fires', () => {
    const oneEdges = Array.from({ length: 21 }, (_, i) => i);
    const observed = new Array(20).fill(10);
    const outcome = fitPoissonModel({
      observedCounts: observed,
      parameterStarts: [[1], [2], [3]],
      freeIndices: [0],
      expectedCountsFn: () => new Array(20).fill(10),
      projectFn: (p) => p,
      options: { shouldCancel: () => true },
    });
    return { pass: outcome.cancelled === true && outcome.attempts.length === 1, detail: JSON.stringify({ cancelled: outcome.cancelled, attempts: outcome.attempts.length }) };
  });

  // ---- diagnostics.js ---------------------------------------------------------
  run('buildPoissonFitDiagnostics reports zero deviance for a perfect fit', () => {
    const observed = [5, 10, 15, 10, 5];
    const diagnostics = buildPoissonFitDiagnostics({ observedCounts: observed, expectedCounts: observed, parameterCount: 1 });
    return { pass: close(diagnostics.deviance, 0, 1e-9) && close(diagnostics.reducedDeviance, 0, 1e-9), detail: diagnostics.deviance };
  });

  run('tailMassWarning fires when most of a fitted component area falls outside the observed domain', () => {
    const warning = tailMassWarning({ componentId: 's', componentLabel: 'S', totalArea: 1000, observedDomainArea: 700 });
    return { pass: warning !== null && warning.code === 'component_tail_mass_outside_domain', detail: warning && warning.message };
  });

  run('tailMassWarning returns null when the observed domain captures essentially all fitted area', () => {
    const warning = tailMassWarning({ componentId: 'g1', componentLabel: 'G1', totalArea: 1000, observedDomainArea: 999.9 });
    return { pass: warning === null, detail: warning };
  });

  run('boundaryHitWarnings flags a parameter sitting at its configured lower bound', () => {
    const warnings = boundaryHitWarnings({ g1CV: 0.01 }, { g1CV: { min: 0.01, max: 0.30 } });
    return { pass: warnings.length === 1 && warnings[0].code === 'parameter_at_lower_bound', detail: JSON.stringify(warnings) };
  });

  run('boundaryHitWarnings is silent for a parameter comfortably inside its bounds', () => {
    const warnings = boundaryHitWarnings({ g1CV: 0.1 }, { g1CV: { min: 0.01, max: 0.30 } });
    return { pass: warnings.length === 0, detail: JSON.stringify(warnings) };
  });

  run('fitQualityWarnings flags an overdispersed reduced deviance', () => {
    const warnings = fitQualityWarnings({ reducedDeviance: 5, lag1Autocorrelation: 0, runsTestZ: 0 });
    return { pass: warnings.some((w) => w.code === 'overdispersed_fit'), detail: JSON.stringify(warnings) };
  });

  run('fitQualityWarnings is silent for a well-behaved fit', () => {
    const warnings = fitQualityWarnings({ reducedDeviance: 1.05, lag1Autocorrelation: 0.02, runsTestZ: 0.4 });
    return { pass: warnings.length === 0, detail: JSON.stringify(warnings) };
  });

  run('akaikeInformationCriterionCorrected is Infinity once sample size no longer exceeds parameterCount + 1', () => {
    const aicc = akaikeInformationCriterionCorrected(-100, 5, 6);
    return { pass: aicc === Infinity, detail: aicc };
  });

  return results;
}"""


def run_cell_cycle_dean_jett_tests(ctx: TestContext):
    """Run fit_engine.js/diagnostics.js/models/dean_jett.js assertions."""

    try:
        all_results = ctx.page.evaluate(_DEAN_JETT_TESTS)
    except Exception as err:
        ctx.check(
            GROUP,
            "cell-cycle dean-jett suite setup",
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
