#!/usr/bin/env python3
"""Browser unit coverage for js/analysis/cell_cycle/models/dean_jett_fox.js:
the nested wave-fraction extension of Dean-Jett.

Covers:
  - w=0 nests Dean-Jett exactly (a formula-level identity check, not just an
    assertion in a comment), and a nonzero w genuinely changes the curve.
  - The peaks-first contract: G1 and G2 are measured from their clean flanks and
    held EXACTLY fixed, so a region bounds the peak and the optimizer only ever
    moves the S phase.
  - The fit converges rather than stalling against the w bound.
  - The model reports S-phase SHAPE and never claims a population form.

Dean-Jett-Fox has a single estimator: clean-flank peaks held fixed, S phase fit
to the residual. The auto_dj_djf selection policy this file used to cover has
been retired, and the reference's asynchronous/synchronous BIC selection is
deliberately not implemented (see the note above fit() for the measurement that
retired it)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / Cell Cycle Dean-Jett-Fox"


_DEAN_JETT_FOX_TESTS = r"""() => {
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

  // ---- w=0 nesting: a formula-level identity, not a fit -----------------
  run('dean_jett_fox at w=0 reproduces dean_jett expected counts exactly', () => {
    const djParams = { g1Area: 8000, g1Mean: 70, g1CV: 0.06, g2Area: 3000, g2Mean: 140, g2CV: 0.07, sArea: 4000, shape1: 0.3, shape2: -0.2 };
    const djfParams = { ...djParams, w: 0, waveMean: 0.5, waveSigma: 0.15 };
    const djExpected = dj.expectedCounts(edges, djParams);
    const djfExpected = djf.expectedCounts(edges, djfParams);
    let maxDiff = 0;
    for (let i = 0; i < djExpected.length; i += 1) maxDiff = Math.max(maxDiff, Math.abs(djExpected[i] - djfExpected[i]));
    return { pass: maxDiff < 1e-9, detail: maxDiff };
  });

  run('dean_jett_fox at a nonzero w differs from dean_jett (the wave actually does something)', () => {
    const djParams = { g1Area: 8000, g1Mean: 70, g1CV: 0.06, g2Area: 3000, g2Mean: 140, g2CV: 0.07, sArea: 4000, shape1: 0.3, shape2: -0.2 };
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
    sArea: 4500, shape1: 0, shape2: 0,
    w: 0.3, waveMean: 0.4, waveSigma: 0.05,
  };
  const waveCounts = seededJitteredCounts(djf.expectedCounts(edges, TRUE_WAVE), 0xC311_c4c1);
  const trueWaveExpected = djf.expectedCounts(edges, TRUE_WAVE);
  const trueWaveDeviance = window.CellCyclePoisson.poissonDeviance(waveCounts, trueWaveExpected);

  // Dean-Jett-Fox is fit PEAKS-FIRST: G1 and G2 are measured once from their
  // clean flanks and held fixed, then only the S phase (area, Bernstein shape,
  // wave) is fit to what those peaks leave unexplained.
  const waveRaw = djf.fit({ histogram: { edges, counts: waveCounts }, peakRegions: regions, config: {} });
  const waveFitted = djf.normalizeResult(waveRaw);
  const waveCleanFlank = {
    g1: window.CellCycleWatsonPragmatic.fit_local_peak(
      edges, waveCounts, regions.g1, 'left', window.CellCycleWatsonPragmatic.DEFAULT_CONFIG),
    g2: window.CellCycleWatsonPragmatic.fit_local_peak(
      edges, waveCounts, regions.g2, 'right', window.CellCycleWatsonPragmatic.DEFAULT_CONFIG),
  };

  run('dean_jett_fox converges on a planted-wave synthetic histogram', () => ({
    pass: waveFitted.converged === true,
    detail: waveFitted.convergenceReason,
  }));

  run('the fit converges rather than stalling against the w bound', () => {
    // Regression guard for a real defect. w used to be an unbounded optimizer
    // coordinate hard-clamped into [0, 0.95] by the projection. Because the wave
    // is the only flexible shape left once the peaks are frozen, it routinely
    // runs to that ceiling -- and a hard clamp there is the boundary stall
    // lm_solver.js refuses to call convergence, so the fit burned all 200
    // iterations and reported maxIterationsReached. A non-converged result is
    // not reportable, so a wave that wanted to be large produced NO result.
    // With w on a smooth bounded coordinate the fit terminates on tolerance.
    return {
      pass: waveFitted.converged === true && waveFitted.convergenceReason !== 'max_iterations',
      detail: JSON.stringify({
        converged: waveFitted.converged,
        reason: waveFitted.convergenceReason,
        w: waveFitted.parameters.w,
      }),
    };
  });

  run('the reported peaks are EXACTLY the clean-flank estimate (the optimizer never moves them)', () => {
    // The peaks-first contract, asserted against the same clean-flank routine
    // the model calls. Exact equality, not a tolerance: these are copied into
    // the parameter vector by the projection on every evaluation, so any drift
    // means a peak parameter escaped into the free set.
    const p = waveFitted.parameters;
    const c = waveCleanFlank;
    return {
      pass: p.g1Mean === c.g1.mean && p.g1CV === c.g1.cv && p.g1Area === Math.max(1, c.g1.area)
        && p.g2Mean === c.g2.mean && p.g2CV === c.g2.cv && p.g2Area === Math.max(1, c.g2.area),
      detail: JSON.stringify({
        fitted: { g1Mean: p.g1Mean, g1CV: p.g1CV, g2Mean: p.g2Mean, g2CV: p.g2CV },
        cleanFlank: { g1Mean: c.g1.mean, g1CV: c.g1.cv, g2Mean: c.g2.mean, g2CV: c.g2.cv },
      }),
    };
  });

  run('DOCUMENTED LIMITATION: frozen peaks leave a large deviance gap to the truth', () => {
    // Not an aspiration -- a measured, deliberately pinned fact, so that
    // improving the peak estimate shows up here as a test that needs updating
    // rather than passing silently.
    //
    // The clean-flank estimate is still biased on this fixture -- g1CV 0.067
    // for a true 0.060, g2CV 0.083 for a true 0.070, g2 mean 137.5 for a true
    // 140 -- and because the peaks are frozen the fit cannot correct it: the
    // deviance lands ~3.6x the truth's own and %S is starved by ~9.6pp.
    // Freeing the peaks fixes the synthetic and BREAKS real data (all_pass
    // 8/30 -> 0/30 on the 30-sample FlowJo set), so the fix is a better peak
    // ESTIMATOR, not a joint fit. See
    // docs/audits/cell_cycle_model_investigation_handoff.md §8.1.
    //
    // PIN HISTORY -- the band below was `> 5 && < 60` around a measured ~25x,
    // with %S starved by ~12pp. MODEL-03 (deconvolving the smoothing kernel in
    // quadrature) and MODEL-04 (sub-bin parabolic peak interpolation, plus
    // linear interpolation of the fractional flank crossing) improved the
    // estimator enough to drop the gap to ~3.6x, which fell straight through
    // the old floor of 5 and turned this test red. That red was the test doing
    // its job, not a regression. The band was therefore RE-DERIVED from the new
    // measurement -- deliberately not deleted, and not widened downward to
    // swallow both the old and new values, either of which would have destroyed
    // the tripwire this test exists to be. The seeded jitter (0xC311_c4c1)
    // makes the measurement deterministic, so this band is tight on purpose:
    // improve the estimator again and this test must go red again and be
    // re-derived again, with the numbers in this comment updated to match.
    const ratio = waveFitted.diagnostics.deviance / trueWaveDeviance;
    return {
      pass: ratio > 2 && ratio < 6,
      detail: JSON.stringify({
        devianceRatio: +ratio.toFixed(1),
        fittedDeviance: waveFitted.diagnostics.deviance,
        trueDeviance: trueWaveDeviance,
        sError: +(100 * waveFitted.phaseFractions.s - 100 * TRUE_WAVE.sArea
          / (TRUE_WAVE.g1Area + TRUE_WAVE.sArea + TRUE_WAVE.g2Area)).toFixed(1),
      }),
    };
  });

  run('a planted wave puts the fitted wave where the wave actually is', () => {
    // Position, not amplitude. w itself is not trustworthy here -- with the
    // peaks frozen the wave also absorbs peak misfit, so its amplitude reflects
    // both. Where it sits along S is still informative: the plant is at z = 0.4.
    const placed = Math.abs(waveFitted.parameters.waveMean - TRUE_WAVE.waveMean) < 0.1;
    return {
      pass: placed && waveFitted.parameters.w > 0,
      detail: JSON.stringify({
        waveMean: waveFitted.parameters.waveMean, planted: TRUE_WAVE.waveMean,
        w: waveFitted.parameters.w,
      }),
    };
  });

  run('dean_jett_fox expected counts are finite and nonnegative at every bin (planted-wave fit)', () => {
    const pass = waveFitted.expectedCounts.every((value) => Number.isFinite(value) && value >= 0);
    return { pass, detail: waveFitted.expectedCounts.length };
  });

  // ---- the peaks-first fit on standard, wave-free two-peak data -----------
  run('dean_jett_fox has exactly one estimator, so there is no peakFitMode switch', () => {
    const entry = get_model('dean_jett_fox');
    return {
      pass: !('peakFitMode' in entry.defaultConfig),
      detail: JSON.stringify(Object.keys(entry.defaultConfig)),
    };
  });

  // A clean two-peak histogram with a genuine (flat, wave-free) S population.
  const TWO_PEAK_TRUTH = {
    g1Area: 8000, g1Mean: 70, g1CV: 0.06,
    g2Area: 3000, g2Mean: 140, g2CV: 0.07,
    sArea: 4000, shape1: 0, shape2: 0,
    w: 0, waveMean: 0.5, waveSigma: 0.1,
  };
  const twoPeakCounts = seededJitteredCounts(djf.expectedCounts(edges, TWO_PEAK_TRUTH), 0x5eed_1234);
  const twoPeakFit = djf.normalizeResult(djf.fit({ histogram: { edges, counts: twoPeakCounts }, peakRegions: regions, config: {} }));

  // ---- a peak region bounds the MEAN and nothing else --------------------
  //
  // A user drawing a generous box is saying "the mean is somewhere in here",
  // not "there is less S phase" and not "take coarser optimizer steps". Region
  // width used to leak into both: it scaled the mean coordinate (so the same
  // sample fit differently depending on how precisely the box was drawn), and
  // the S seed was summed strictly BETWEEN the region edges (so widening a
  // region shrank the gap and starved S).
  const REGION_WIDTHS = [
    ['tight', { g1: { left: 64, right: 76 }, g2: { left: 126, right: 154 } }],
    ['default', { g1: { left: 55, right: 85 }, g2: { left: 115, right: 165 } }],
    ['wide', { g1: { left: 49, right: 91 }, g2: { left: 100, right: 180 } }],
  ];
  const widthFits = REGION_WIDTHS.map(([label, region]) => {
    const fit = djf.normalizeResult(djf.fit({
      histogram: { edges, counts: twoPeakCounts }, peakRegions: region, config: {},
    }));
    return { label, s: fit.phaseFractions.s, g1CV: fit.parameters.g1CV, sArea: fit.parameters.sArea };
  });

  run('region WIDTH does not change the fitted %S (a wide region must not starve S)', () => {
    const values = widthFits.map((entry) => 100 * entry.s);
    const spread = Math.max(...values) - Math.min(...values);
    // All three regions comfortably contain both true means, so the only thing
    // varying is how generously the box was drawn. 1.5pp allows for the
    // optimizer landing in slightly different places; the pre-fix behaviour
    // moved %S by far more than this through the S seed alone.
    return {
      pass: spread < 1.5,
      detail: JSON.stringify({ spread, byWidth: widthFits.map((e) => [e.label, +(100 * e.s).toFixed(2)]) }),
    };
  });

  run('region WIDTH does not change the fitted peak width', () => {
    const values = widthFits.map((entry) => entry.g1CV);
    const spread = Math.max(...values) - Math.min(...values);
    return {
      pass: spread < 0.005,
      detail: JSON.stringify({ spread, byWidth: widthFits.map((e) => [e.label, +e.g1CV.toFixed(4)]) }),
    };
  });

  run('a region still HARD-BOUNDS the fitted mean to the drawn interval', () => {
    // The one job a region does keep: the mean cannot leave it.
    const narrow = { g1: { left: 74, right: 78 }, g2: { left: 115, right: 165 } };
    const fit = djf.normalizeResult(djf.fit({
      histogram: { edges, counts: twoPeakCounts }, peakRegions: narrow, config: {},
    }));
    return {
      pass: fit.parameters.g1Mean >= 74 - 1e-9 && fit.parameters.g1Mean <= 78 + 1e-9
        && fit.bounds.g1Mean[0] === 74 && fit.bounds.g1Mean[1] === 78,
      detail: JSON.stringify({ g1Mean: fit.parameters.g1Mean, bounds: fit.bounds.g1Mean }),
    };
  });

  run('the fit produces a converged, area-conserving result on standard two-peak data', () => {
    const f = twoPeakFit.phaseFractions;
    const sum = f.g1 + f.s + f.g2;
    return {
      pass: twoPeakFit.converged === true && Number.isFinite(f.g1) && Math.abs(sum - 1) < 1e-6,
      detail: JSON.stringify({ converged: twoPeakFit.converged, convergenceReason: twoPeakFit.convergenceReason, fractions: f }),
    };
  });

  run('both peak CVs sit off their bounds (no S-swallows-peak degeneracy)', () => {
    // The overfit signature is a peak CV driven to the 0.30 ceiling so S absorbs
    // a peak. Measuring each peak from its clean flank and holding it there is
    // what keeps the fit out of that basin, so both CVs must sit strictly
    // inside their configured bounds.
    const p = twoPeakFit.parameters;
    const inside = (cv) => cv > 0.011 && cv < 0.299;
    return { pass: inside(p.g1CV) && inside(p.g2CV), detail: JSON.stringify({ g1CV: p.g1CV, g2CV: p.g2CV }) };
  });

  // ---- the model reports S-phase SHAPE, never a population form -----------
  //
  // The reference (§13, Steps 6-9) fits asynchronous and synchronous variants and
  // selects between them by BIC. That was implemented here and REMOVED, because
  // with the peaks frozen it is not identifiable: on THIS wave-free fixture the
  // BIC comparison preferred the cohort by 103 (it was absorbing frozen-peak
  // misfit, w running to its 0.95 ceiling), while the same code given the true
  // peaks correctly rejected it (ΔBIC +16.7, w = 0.0135). It only appeared to
  // work because the synchronous fit never converged, so a `converged` guard
  // rejected the cohort for an accidental reason.

  run('the model never claims a population form', () => {
    // Plan §1.1's Fox row: "report 'complex S-phase model'; do not infer
    // synchronization". No populationMode, no synchronous/asynchronous label.
    const noClaim = (fit) => fit.populationMode === undefined
      && fit.populationSelection === undefined
      && !/synchronous/i.test(fit.modelLabel);
    return {
      pass: noClaim(twoPeakFit) && noClaim(waveFitted),
      detail: JSON.stringify({
        label: waveFitted.modelLabel,
        populationMode: waveFitted.populationMode ?? null,
        populationSelection: waveFitted.populationSelection ?? null,
      }),
    };
  });

  run('a substantial wave is surfaced as S-phase shape, with no synchronization claim', () => {
    const note = waveFitted.warnings.find((w) => w.code === 'complex_s_phase_shape');
    return {
      pass: !!note && /shape only/i.test(note.message)
        && /does not test for a synchronized population/i.test(note.message),
      detail: JSON.stringify({ w: waveFitted.parameters.w, message: note?.message ?? null }),
    };
  });

  run('the wave parameters are always charged to the parameter count', () => {
    // There is one variant now, so w/waveMean/waveSigma are always free and
    // always counted: S area + 2 Bernstein shapes + 3 wave terms = 6. A
    // parameter count that changed per sample would make BIC incomparable
    // across the sample set.
    return {
      pass: twoPeakFit.diagnostics.parameterCount === 6
        && waveFitted.diagnostics.parameterCount === 6,
      detail: JSON.stringify({
        twoPeak: twoPeakFit.diagnostics.parameterCount,
        wave: waveFitted.diagnostics.parameterCount,
      }),
    };
  });

  run('a faint wave on a small S population still produces a finite, converged fit', () => {
    const faint = {
      g1Area: 9000, g1Mean: 70, g1CV: 0.06,
      g2Area: 5000, g2Mean: 140, g2CV: 0.07,
      sArea: 600, shape1: 0, shape2: 0,
      w: 0.2, waveMean: 0.4, waveSigma: 0.05,
    };
    const faintCounts = seededJitteredCounts(djf.expectedCounts(edges, faint), 0xFA13_7777);
    const fit = djf.normalizeResult(djf.fit({
      histogram: { edges, counts: faintCounts }, peakRegions: regions, config: {},
    }));
    const f = fit.phaseFractions;
    return {
      pass: fit.converged === true
        && [f.g1, f.s, f.g2].every((value) => Number.isFinite(value) && value >= 0)
        && Math.abs(f.g1 + f.s + f.g2 - 1) < 1e-6,
      detail: JSON.stringify({ converged: fit.converged, reason: fit.convergenceReason, fractions: f }),
    };
  });

  clear_registry();

  return results;
}"""


def run_cell_cycle_dean_jett_fox_tests(ctx: TestContext):
    """Run models/dean_jett_fox.js assertions."""

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
