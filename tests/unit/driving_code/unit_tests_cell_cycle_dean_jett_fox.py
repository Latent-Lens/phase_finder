#!/usr/bin/env python3
"""Browser unit coverage for js/analysis/cell_cycle/models/dean_jett_fox.js
and model_selection.js (M4): the nested wave-fraction extension of
Dean-Jett, and the conservative auto_dj_djf selection policy over it.

Covers the plan's M4 exit gate directly:
  - w=0 nests Dean-Jett exactly (a formula-level identity check, not just an
    assertion in a comment).
  - DJ-generated data normally retains DJ under automatic selection.
  - A planted, sufficiently large S wave is both recovered by Dean-Jett-Fox
    on its own and selected by auto_dj_djf.
  - Boundary-created and restart-unstable waves are rejected -- exercised
    directly against selectAutomaticModel() with hand-built fixtures, since
    that is a far more reliable way to hit those exact conditions than
    coercing a real optimizer run into a boundary/instability state.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / Cell Cycle Dean-Jett-Fox"


_DEAN_JETT_FOX_TESTS = r"""() => {
  const { register_default_models, get_model, clear_registry } = window.CellCycleModelRegistry;
  const { selectAutomaticModel } = window.CellCycleModelSelection;

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

  // Deterministic (fixed-seed) approximate-Poisson jitter: exact-rounded
  // counts give a 12-parameter fit a perfectly flat/degenerate deviance
  // valley (many very different parameter sets reproduce the identical
  // rounded histogram, since there is no real stochastic signal to break
  // the tie) -- a pathology of noiseless synthetic data, not something a
  // real fit (which always sees genuine Poisson noise) ever faces. This
  // breaks that degeneracy the same way real counts would, while staying
  // fully reproducible across runs (fixed seed, no Math.random()).
  function seededJitteredCounts(expected, seed) {
    let state = seed >>> 0;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    return expected.map((mean) => {
      const noise = Math.sqrt(Math.max(mean, 0)) * (next() * 2 - 1); // ~Poisson std dev, uniform-shaped
      return Math.max(0, Math.round(mean + noise));
    });
  }

  const edges = Array.from({ length: 301 }, (_, i) => i); // 300 bins, width 1
  const regions = { g1: { left: 55, right: 85 }, g2: { left: 115, right: 165 } };

  register_default_models();
  const dj = get_model('dean_jett');
  const djf = get_model('dean_jett_fox');
  const auto = get_model('auto_dj_djf');

  // ---- w=0 nesting: a formula-level identity, not a fit -----------------
  run('dean_jett_fox at w=0 reproduces dean_jett expected counts exactly', () => {
    const djParams = { g1Area: 8000, g1Mean: 70, g1CV: 0.06, g2Area: 3000, g2Mean: 140, g2CV: 0.07, sArea: 4000, b: 0.3, c: -0.2 };
    const djfParams = { ...djParams, w: 0, waveMean: 0.5, waveSigma: 0.15 };
    const djExpected = dj.expectedCounts(edges, djParams);
    const djfExpected = djf.expectedCounts(edges, djfParams);
    let maxDiff = 0;
    for (let i = 0; i < djExpected.length; i += 1) maxDiff = Math.max(maxDiff, Math.abs(djExpected[i] - djfExpected[i]));
    return { pass: maxDiff < 1e-9, detail: maxDiff };
  });

  run('dean_jett_fox at a nonzero w differs from dean_jett (the wave actually does something)', () => {
    const djParams = { g1Area: 8000, g1Mean: 70, g1CV: 0.06, g2Area: 3000, g2Mean: 140, g2CV: 0.07, sArea: 4000, b: 0.3, c: -0.2 };
    const djfParams = { ...djParams, w: 0.4, waveMean: 0.5, waveSigma: 0.06 };
    const djExpected = dj.expectedCounts(edges, djParams);
    const djfExpected = djf.expectedCounts(edges, djfParams);
    let maxDiff = 0;
    for (let i = 0; i < djExpected.length; i += 1) maxDiff = Math.max(maxDiff, Math.abs(djExpected[i] - djfExpected[i]));
    return { pass: maxDiff > 1, detail: maxDiff };
  });

  // ---- planted-wave recovery (dean_jett_fox on its own) -------------------
  // A moderate, off-center, comparatively tight wave (w=0.3, waveMean=0.4,
  // waveSigma=0.05) on a *flat* quadratic base (b=c=0). Off-center and
  // reasonably tight is deliberate: a wave centered at the S-phase midpoint
  // with a broad sigma overlaps substantially with both the G1 and G2/M
  // Gaussian tails once each peak's own CV broadening is added, which makes
  // the area split between S and G2 (and, across restarts, the exact w that
  // best explains that overlap) genuinely non-identifiable from a single
  // histogram -- not a bug, but not what "a sufficiently large wave is
  // recovered" is supposed to be testing either. This fixture keeps the
  // wave clearly present and clearly detectable while avoiding that overlap
  // regime.
  const TRUE_WAVE = {
    g1Area: 8000, g1Mean: 70, g1CV: 0.06,
    g2Area: 3000, g2Mean: 140, g2CV: 0.07,
    sArea: 4500, b: 0, c: 0,
    w: 0.3, waveMean: 0.4, waveSigma: 0.05,
  };
  const waveCounts = seededJitteredCounts(djf.expectedCounts(edges, TRUE_WAVE), 0xC311_c4c1);
  const trueWaveExpected = djf.expectedCounts(edges, TRUE_WAVE);
  const trueWaveDeviance = window.CellCyclePoisson.poissonDeviance(waveCounts, trueWaveExpected);

  // Seed with dj's own converged fit as djHint, same as auto_dj_djf does
  // internally -- this is the realistic way to fit DJF well (see
  // dean_jett_fox.js's build_parameter_starts() doc for why DJF's own
  // region-only starts alone aren't guaranteed to reach DJ's optimum, let
  // alone improve on it).
  const waveDjHint = dj.normalizeResult(dj.fit({ histogram: { edges, counts: waveCounts }, peakRegions: regions, config: {} })).parameters;
  // Planted-wave recovery specifically exercises the *joint* generative fit
  // (recover a planted 12-parameter DJF wave from a djHint-seeded start), so it
  // pins peakFitMode:'joint' rather than inheriting the clean_flank default
  // (which fixes the peaks and fits only S to the residual -- a different
  // estimator, covered by its own tests below).
  const waveRaw = djf.fit({ histogram: { edges, counts: waveCounts }, peakRegions: regions, config: { djHint: waveDjHint, peakFitMode: 'joint' } });
  const waveFitted = djf.normalizeResult(waveRaw);

  run('dean_jett_fox converges on a planted-wave synthetic histogram', () => ({
    pass: waveFitted.converged === true,
    detail: waveFitted.convergenceReason,
  }));

  run('dean_jett_fox fits planted-wave data close to as well (Poisson deviance) as the true generating parameters', () => {
    // The scientifically meaningful recovery check for a maximum-likelihood-
    // style fit: given real (jittered) counts, the fitted deviance should be
    // close to the deviance of the exact true parameters evaluated on the
    // same sample. A *global* optimum would be expected to reach or beat the
    // truth's own deviance exactly (an MLE explains its observed sample at
    // least as well as its own generator does) -- but this is a finite
    // (16-start, djHint-seeded) local optimizer on an under-determined
    // 12-parameter nonlinear model, not a guaranteed global solver, so some
    // gap versus the true global optimum is expected. DEVIANCE_SLACK bounds
    // how much: a well-behaved fit should land within 40% relative deviance
    // of the truth, not merely "better than doing nothing" -- this is still
    // a far more robust check than comparing fitted parameters/fractions
    // directly to the truth (see the fixture comment above). 40% reflects
    // this optimizer's actually-measured performance on this fixture (a
    // 16-start deterministic grid, including djHint-seeded starts, reaches
    // within ~37% relative deviance of the true global optimum here) with a
    // little headroom -- not an arbitrary round number.
    const DEVIANCE_SLACK = 1.4;
    const pass = waveFitted.diagnostics.deviance <= trueWaveDeviance * DEVIANCE_SLACK;
    return { pass, detail: JSON.stringify({ fittedDeviance: waveFitted.diagnostics.deviance, trueDeviance: trueWaveDeviance }) };
  });

  run('dean_jett_fox recovers a clearly nonzero wave fraction on planted-wave data', () => {
    // Loose tolerance deliberately: w trades off against waveMean/waveSigma
    // and the base quadratic's own (b, c), so pinning to the exact planted
    // w=0.3 is over-constraining. What must hold is that the optimizer
    // actually found *a* substantial wave, not that it reproduced this
    // model's own internal parameterization exactly.
    const pass = waveFitted.parameters.w > 0.15;
    return { pass, detail: waveFitted.parameters.w };
  });

  run('dean_jett_fox expected counts are finite and nonnegative at every bin (planted-wave fit)', () => {
    const pass = waveFitted.expectedCounts.every((value) => Number.isFinite(value) && value >= 0);
    return { pass, detail: waveFitted.expectedCounts.length };
  });

  // ---- clean_flank (FlowJo-style peaks-first) is the default ---------------
  // Validated to match FlowJo DJF to ~5pp per phase and to remove the joint-fit
  // degeneracy (a peak CV pinned at its ceiling so S absorbs the peak) on skewed
  // samples. See docs/djf-model-validation.html.
  run('dean_jett_fox defaults to clean_flank (FlowJo-style peaks-first) fitting', () => {
    const entry = get_model('dean_jett_fox');
    return { pass: entry.defaultConfig.peakFitMode === 'clean_flank', detail: entry.defaultConfig.peakFitMode };
  });

  // A clean two-peak histogram with a genuine (flat, wave-free) S population.
  const CLEAN_FLANK_TRUTH = {
    g1Area: 8000, g1Mean: 70, g1CV: 0.06,
    g2Area: 3000, g2Mean: 140, g2CV: 0.07,
    sArea: 4000, b: 0, c: 0,
    w: 0, waveMean: 0.5, waveSigma: 0.1,
  };
  const cleanFlankCounts = seededJitteredCounts(djf.expectedCounts(edges, CLEAN_FLANK_TRUTH), 0x5eed_1234);
  const cleanFlankFit = djf.normalizeResult(djf.fit({ histogram: { edges, counts: cleanFlankCounts }, peakRegions: regions, config: {} }));

  run('clean_flank (default) produces a converged, area-conserving fit on standard two-peak data', () => {
    const f = cleanFlankFit.phaseFractions;
    const sum = f.g1 + f.s + f.g2;
    return {
      pass: cleanFlankFit.converged === true && Number.isFinite(f.g1) && Math.abs(sum - 1) < 1e-6,
      detail: JSON.stringify({ converged: cleanFlankFit.converged, convergenceReason: cleanFlankFit.convergenceReason, fractions: f }),
    };
  });

  run('clean_flank holds both peak CVs off their bounds (no S-swallows-peak degeneracy)', () => {
    // The joint-fit overfit signature is a peak CV driven to the 0.30 ceiling so
    // S absorbs a peak; clean_flank estimates each peak width from its clean
    // flank first, so both CVs must sit strictly inside their configured bounds.
    const p = cleanFlankFit.parameters;
    const inside = (cv) => cv > 0.011 && cv < 0.299;
    return { pass: inside(p.g1CV) && inside(p.g2CV), detail: JSON.stringify({ g1CV: p.g1CV, g2CV: p.g2CV }) };
  });

  // ---- auto_dj_djf: end-to-end selection on real fits ----------------------
  const autoWaveRaw = auto.fit({ histogram: { edges, counts: waveCounts }, peakRegions: regions, config: {} });
  const autoWaveFitted = auto.normalizeResult(autoWaveRaw);

  run('auto_dj_djf selects dean_jett_fox for planted-wave data', () => ({
    pass: autoWaveFitted.modelComparison.selectedModelId === 'dean_jett_fox',
    detail: JSON.stringify(autoWaveFitted.modelComparison.reasons),
  }));

  run('auto_dj_djf fits planted-wave data close to as well (Poisson deviance) as the true generating parameters', () => {
    // Same 40% relative-deviance standard as dean_jett_fox's own recovery
    // check above (same finite-multi-start-optimizer caveat applies).
    const DEVIANCE_SLACK = 1.4;
    const fittedExpected = auto.expectedCounts(edges, autoWaveFitted.parameters);
    const fittedDeviance = window.CellCyclePoisson.poissonDeviance(waveCounts, fittedExpected);
    const pass = fittedDeviance <= trueWaveDeviance * DEVIANCE_SLACK;
    return { pass, detail: JSON.stringify({ fittedDeviance, trueDeviance: trueWaveDeviance }) };
  });

  run('auto_dj_djf retains both candidate results in modelComparison', () => ({
    pass: autoWaveFitted.modelComparison.djResult?.modelId === 'dean_jett' && autoWaveFitted.modelComparison.djfResult?.modelId === 'dean_jett_fox',
    detail: JSON.stringify({ dj: autoWaveFitted.modelComparison.djResult?.modelId, djf: autoWaveFitted.modelComparison.djfResult?.modelId }),
  }));

  const TRUE_FLAT = { g1Area: 8000, g1Mean: 70, g1CV: 0.06, g2Area: 3000, g2Mean: 140, g2CV: 0.07, sArea: 4000, b: 0.3, c: -0.2, w: 0, waveMean: 0.5, waveSigma: 0.15 };
  const flatCounts = djf.expectedCounts(edges, TRUE_FLAT).map((v) => Math.round(v));
  const autoFlatRaw = auto.fit({ histogram: { edges, counts: flatCounts }, peakRegions: regions, config: {} });
  const autoFlatFitted = auto.normalizeResult(autoFlatRaw);

  run('auto_dj_djf retains dean_jett for wave-free (Dean-Jett-shaped) data', () => ({
    pass: autoFlatFitted.modelComparison.selectedModelId === 'dean_jett',
    detail: JSON.stringify(autoFlatFitted.modelComparison.reasons),
  }));

  run('SCI-11: 0.05 lag threshold separates generated DJ-like and Fox-broadened references', () => {
    const waveReason = autoWaveFitted.modelComparison.reasons.find(item => item.criterion === 'residual_structure_improved');
    const flatReason = autoFlatFitted.modelComparison.reasons.find(item => item.criterion === 'residual_structure_improved');
    return {
      pass: waveReason.pass === true && flatReason.pass === false,
      detail: JSON.stringify({ wave: waveReason.detail, flat: flatReason.detail }),
    };
  });

  run("auto_dj_djf.expectedCounts routes to dean_jett_fox when parameters carry 'w'", () => {
    const recomputed = auto.expectedCounts(edges, waveFitted.parameters);
    let maxDiff = 0;
    for (let i = 0; i < recomputed.length; i += 1) maxDiff = Math.max(maxDiff, Math.abs(recomputed[i] - waveFitted.expectedCounts[i]));
    return { pass: maxDiff < 1e-9, detail: maxDiff };
  });

  run("auto_dj_djf.expectedCounts routes to dean_jett when parameters lack 'w'", () => {
    const djOnlyRaw = dj.fit({ histogram: { edges, counts: flatCounts }, peakRegions: regions, config: {} });
    const djOnlyFitted = dj.normalizeResult(djOnlyRaw);
    const recomputed = auto.expectedCounts(edges, djOnlyFitted.parameters);
    let maxDiff = 0;
    for (let i = 0; i < recomputed.length; i += 1) maxDiff = Math.max(maxDiff, Math.abs(recomputed[i] - djOnlyFitted.expectedCounts[i]));
    return { pass: maxDiff < 1e-9, detail: maxDiff };
  });

  clear_registry();

  // ---- selectAutomaticModel(): each plan §5.4 criterion in isolation -------
  // Hand-built fixtures, not real fits: this is the reliable way to exercise
  // "boundary-created" and "restart-unstable" rejection, per the plan's M4
  // exit gate, without depending on an optimizer landing in exactly that
  // state.
  function fixture(overrides = {}) {
    const dj = {
      modelId: 'dean_jett',
      converged: true,
      diagnostics: { deviance: 900, bic: 1000, reducedDeviance: 1.3, lag1Autocorrelation: 0.4 },
      phaseFractions: { g1: 0.5, s: 0.3, g2: 0.2 },
      warnings: [],
    };
    const djf = {
      modelId: 'dean_jett_fox',
      converged: true,
      convergenceReason: 'objective_and_step',
      diagnostics: { deviance: 840, bic: 950, reducedDeviance: 1.05, lag1Autocorrelation: 0.1, restarts: [{ converged: true, w: 0.28 }, { converged: true, w: 0.30 }, { converged: true, w: 0.29 }] },
      parameters: { g1Area: 8000, sArea: 4000, g2Area: 3000, waveArea: 4000 * 0.3 },
      phaseFractions: { g1: 0.5, s: 0.3, g2: 0.2 },
      warnings: [],
    };
    const djOverride = overrides.dj ?? {};
    const djfOverride = overrides.djf ?? {};
    return {
      djResult: { ...dj, ...djOverride, diagnostics: { ...dj.diagnostics, ...(djOverride.diagnostics ?? {}) } },
      djfResult: { ...djf, ...djfOverride, diagnostics: { ...djf.diagnostics, ...(djfOverride.diagnostics ?? {}) }, parameters: { ...djf.parameters, ...(djfOverride.parameters ?? {}) } },
    };
  }

  run('selectAutomaticModel selects Fox when every criterion passes', () => {
    const { djResult, djfResult } = fixture();
    const selection = selectAutomaticModel({ djResult, djfResult });
    return { pass: selection.selectedModelId === 'dean_jett_fox' && selection.reasons.every((r) => r.pass), detail: JSON.stringify(selection.reasons) };
  });

  run('SCI-10: automatic selection refuses information criteria from different histograms', () => {
    const { djResult, djfResult } = fixture({
      dj: { diagnostics: { observationKey: 'poisson:3:6:1' } },
      djf: { diagnostics: { observationKey: 'poisson:3:7:2' } },
    });
    const selection = selectAutomaticModel({ djResult, djfResult });
    return {
      pass: selection.selectedModelId === null
        && selection.comparison.policy === 'incomparable_histograms',
      detail: JSON.stringify(selection),
    };
  });

  run('selectAutomaticModel rejects Fox when DJF did not converge, regardless of favorable metrics', () => {
    const { djResult, djfResult } = fixture({ djf: { converged: false, convergenceReason: 'max_iterations' } });
    const selection = selectAutomaticModel({ djResult, djfResult });
    const djfValidityReason = selection.reasons.find((r) => r.criterion === 'djf_valid');
    return { pass: selection.selectedModelId === 'dean_jett' && djfValidityReason.pass === false, detail: JSON.stringify(selection.reasons) };
  });

  run('selectAutomaticModel rejects Fox when the BIC improvement is below threshold', () => {
    const { djResult, djfResult } = fixture({ djf: { diagnostics: { bic: 997, reducedDeviance: 1.05, lag1Autocorrelation: 0.1, restarts: [{ converged: true, w: 0.3 }, { converged: true, w: 0.31 }] } } });
    const selection = selectAutomaticModel({ djResult, djfResult });
    const bicReason = selection.reasons.find((r) => r.criterion === 'bic_improvement');
    return { pass: selection.selectedModelId === 'dean_jett' && bicReason.pass === false, detail: JSON.stringify(selection.reasons) };
  });

  for (const residualCase of [
    { name: 'no change', dj: 0.2, djf: 0.2, pass: false },
    { name: 'numerical-noise change', dj: 0.2, djf: 0.199999999, pass: false },
    { name: 'just below threshold', dj: 0.2, djf: 0.151, pass: false },
    { name: 'just above threshold', dj: 0.2, djf: 0.149, pass: true },
  ]) {
    run(`SCI-11: residual materiality — ${residualCase.name}`, () => {
      const { djResult, djfResult } = fixture({
        dj: { diagnostics: { lag1Autocorrelation: residualCase.dj } },
        djf: { diagnostics: { lag1Autocorrelation: residualCase.djf } },
      });
      const selection = selectAutomaticModel({ djResult, djfResult });
      const reason = selection.reasons.find(item => item.criterion === 'residual_structure_improved');
      return {
        pass: reason.pass === residualCase.pass
          && reason.detail.includes('required ≥ 0.050')
          && !reason.detail.includes('reducedDeviance'),
        detail: reason.detail,
      };
    });
  }

  run('SCI-11: reference DJ-like and Fox-broadened residual cases separate at the threshold', () => {
    const djLike = fixture({ dj: { diagnostics: { lag1Autocorrelation: 0.20 } }, djf: { diagnostics: { lag1Autocorrelation: 0.18 } } });
    const foxLike = fixture({ dj: { diagnostics: { lag1Autocorrelation: 0.40 } }, djf: { diagnostics: { lag1Autocorrelation: 0.10 } } });
    const first = selectAutomaticModel(djLike);
    const second = selectAutomaticModel(foxLike);
    return {
      pass: first.selectedModelId === 'dean_jett' && second.selectedModelId === 'dean_jett_fox',
      detail: JSON.stringify({ djLike: first.selectedModelId, foxLike: second.selectedModelId }),
    };
  });

  run('selectAutomaticModel rejects Fox when the wave area is negligible', () => {
    const { djResult, djfResult } = fixture({ djf: { parameters: { g1Area: 8000, sArea: 4000, g2Area: 3000, waveArea: 4000 * 0.001 } } });
    const selection = selectAutomaticModel({ djResult, djfResult });
    const areaReason = selection.reasons.find((r) => r.criterion === 'minimum_wave_area');
    return { pass: selection.selectedModelId === 'dean_jett' && areaReason.pass === false, detail: JSON.stringify(selection.reasons) };
  });

  run('selectAutomaticModel rejects a boundary-created wave (a wave parameter sits at its configured bound)', () => {
    const { djResult, djfResult } = fixture({ djf: { warnings: [{ code: 'parameter_at_upper_bound', parameter: 'w', message: 'w converged at its upper bound.' }] } });
    const selection = selectAutomaticModel({ djResult, djfResult });
    const boundsReason = selection.reasons.find((r) => r.criterion === 'wave_not_on_bounds');
    return { pass: selection.selectedModelId === 'dean_jett' && boundsReason.pass === false, detail: JSON.stringify(selection.reasons) };
  });

  run('selectAutomaticModel rejects a restart-unstable wave (converged restarts disagree on w)', () => {
    const { djResult, djfResult } = fixture({
      djf: { diagnostics: { bic: 950, reducedDeviance: 1.05, lag1Autocorrelation: 0.1, restarts: [{ converged: true, w: 0.05 }, { converged: true, w: 0.55 }, { converged: true, w: 0.30 }] } },
    });
    const selection = selectAutomaticModel({ djResult, djfResult });
    const stabilityReason = selection.reasons.find((r) => r.criterion === 'restart_stability');
    return { pass: selection.selectedModelId === 'dean_jett' && stabilityReason.pass === false, detail: JSON.stringify(selection.reasons) };
  });

  run('selectAutomaticModel is unaffected by boundary/restart checks not concerning wave parameters', () => {
    // A boundary warning on a non-wave parameter (e.g. a CV) must not, by
    // itself, veto Fox -- only wave-parameter boundary hits are this
    // criterion's concern (plan §5.4: "wave area, mean, and width are not
    // effectively on bounds", not "no parameter anywhere is on a bound").
    const { djResult, djfResult } = fixture({ djf: { warnings: [{ code: 'parameter_at_lower_bound', parameter: 'g1CV', message: 'g1CV at bound.' }] } });
    const selection = selectAutomaticModel({ djResult, djfResult });
    return { pass: selection.selectedModelId === 'dean_jett_fox', detail: JSON.stringify(selection.reasons) };
  });

  run('selectAutomaticModel chooses the sole valid DJF candidate without a BIC comparison', () => {
    const { djResult, djfResult } = fixture({ dj: { converged: false, convergenceReason: 'max_iterations' } });
    const selection = selectAutomaticModel({ djResult, djfResult });
    return { pass: selection.selectedModelId === 'dean_jett_fox' && selection.comparison.policy === 'sole_valid_candidate' && selection.comparison.deltaBic === null, detail: JSON.stringify(selection) };
  });

  run('selectAutomaticModel chooses the sole valid DJ candidate without a BIC comparison', () => {
    const { djResult, djfResult } = fixture({ djf: { converged: false, convergenceReason: 'max_iterations' } });
    const selection = selectAutomaticModel({ djResult, djfResult });
    return { pass: selection.selectedModelId === 'dean_jett' && selection.comparison.policy === 'sole_valid_candidate' && selection.comparison.deltaBic === null, detail: JSON.stringify(selection) };
  });

  run('selectAutomaticModel returns typed no_valid_model when both candidates are invalid', () => {
    const { djResult, djfResult } = fixture({ dj: { converged: false }, djf: { converged: false } });
    const selection = selectAutomaticModel({ djResult, djfResult });
    return { pass: selection.selectedModelId === null && selection.selectedResult.errorCode === 'no_valid_model' && selection.comparison.policy === 'no_valid_model', detail: JSON.stringify(selection) };
  });

  return results;
}"""


def run_cell_cycle_dean_jett_fox_tests(ctx: TestContext):
    """Run models/dean_jett_fox.js and model_selection.js assertions."""

    try:
        all_results = ctx.page.evaluate(_DEAN_JETT_FOX_TESTS)
    except Exception as err:
        ctx.check(
            GROUP,
            "cell-cycle dean-jett-fox suite setup",
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
