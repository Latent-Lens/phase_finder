#!/usr/bin/env python3
"""Browser unit coverage for the CLOCCS joint time-series model
(js/analysis/cell_cycle/models/cloccs.js), its synthetic data generator
(models/cloccs_synthetic.js), and the Nelder-Mead optimizer (math/nelder_mead.js).

CLOCCS is shipped UNVERIFIED (no external/biological validation yet). These tests
establish INTERNAL SOUNDNESS: each mathematical operation matches the design doc,
the mixture position density and predicted DNA density both normalise, the
position->DNA map and phase classification are correct, the parameter transforms
round-trip, the model assigns higher posterior to the true parameters than to
wrong ones, and -- the key end-to-end check -- parameters are recovered when the
model is fit to data its own generator produced.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / CLOCCS (Unverified)"


_CLOCCS_TESTS = r"""async () => {
  const C = window.CLOCCS;
  const Syn = window.CLOCCSSynthetic;
  const { minimizeNelderMead } = window.NelderMead;

  const results = [];
  const push = (name, pass, detail = '') => results.push({ name, pass: Boolean(pass), detail: String(detail ?? '') });
  const run = (name, test) => {
    try {
      const outcome = test();
      push(name, outcome.pass, outcome.detail);
    } catch (error) { push(name, false, `${error.name}: ${error.message}`); }
  };
  const runAsync = async (name, test) => {
    try {
      const outcome = await test();
      push(name, outcome.pass, outcome.detail);
    } catch (error) { push(name, false, `${error.name}: ${error.message}`); }
  };
  const close = (a, b, tol) => Math.abs(a - b) <= tol;

  const trapz = (fn, min, max, n) => {
    let total = 0;
    const step = (max - min) / n;
    let prev = fn(min);
    for (let i = 1; i <= n; i += 1) {
      const x = min + i * step;
      const cur = fn(x);
      total += 0.5 * (cur + prev) * step;
      prev = cur;
    }
    return total;
  };

  // ── Nelder-Mead soundness ──────────────────────────────────────────────────
  run('minimizeNelderMead finds the minimum of a shifted quadratic', () => {
    const f = ([x, y]) => (x - 3) ** 2 + (y + 1) ** 2 + 5;
    const r = minimizeNelderMead(f, [0, 0], { maxIterations: 400 });
    return { pass: close(r.point[0], 3, 1e-3) && close(r.point[1], -1, 1e-3) && close(r.value, 5, 1e-4), detail: JSON.stringify({ point: r.point, value: r.value }) };
  });

  run('minimizeNelderMead treats non-finite objective values as +Infinity (infeasible)', () => {
    const f = ([x]) => (x < 0 ? NaN : (x - 2) ** 2);
    const r = minimizeNelderMead(f, [5], { maxIterations: 300 });
    return { pass: close(r.point[0], 2, 1e-2), detail: JSON.stringify(r.point) };
  });

  // ── §9 parameter transforms round-trip ─────────────────────────────────────
  run('decodeBiologicalParameters(encode(theta)) round-trips', () => {
    const theta = { mu0: 12, sigma0: 6, sigmaV: 0.05, lambda: 90, delta: 18, gamma1: 0.28, gamma2: 0.62 };
    const back = C.decodeBiologicalParameters(C.encodeBiologicalParameters(theta));
    const keys = Object.keys(theta);
    const pass = keys.every((k) => close(back[k], theta[k], 1e-9));
    return { pass, detail: JSON.stringify(back) };
  });

  run('decodeBiologicalParameters always yields gamma1 < gamma2 < 1 for arbitrary raw', () => {
    let ok = true;
    for (const g1 of [-5, -1, 0, 1, 4]) for (const gap of [-5, -1, 0, 2, 6]) {
      const t = C.decodeBiologicalParameters({ logMu0: 2, logSigma0: 1, logSigmaV: -2, logLambda: 4.5, logDelta: 2.5, gamma1Raw: g1, gamma2GapRaw: gap });
      if (!(t.gamma1 > 0 && t.gamma1 < t.gamma2 && t.gamma2 < 1)) ok = false;
    }
    return { pass: ok, detail: '' };
  });

  run('decodeSampleParameters(encode(sp)) round-trips', () => {
    const sp = { alpha1: 100, alpha2: 95, tau: 6 };
    const back = C.decodeSampleParameters(C.encodeSampleParameters(sp));
    return { pass: close(back.alpha1, 100, 1e-9) && close(back.alpha2, 95, 1e-9) && close(back.tau, 6, 1e-9), detail: JSON.stringify(back) };
  });

  // ── §10 cohort enumeration ─────────────────────────────────────────────────
  run('enumerateCohorts(2) is [{0,0},{1,1},{1,2},{2,2}]', () => {
    const c = C.enumerateCohorts(2);
    return { pass: JSON.stringify(c) === JSON.stringify([{ g: 0, r: 0 }, { g: 1, r: 1 }, { g: 1, r: 2 }, { g: 2, r: 2 }]), detail: JSON.stringify(c) };
  });

  const theta = { mu0: 12, sigma0: 6, sigmaV: 0.05, lambda: 90, delta: 18, gamma1: 0.28, gamma2: 0.62 };

  // ── §11 cohort mass and weights ────────────────────────────────────────────
  run('cohortMass of the origin cohort {0,0} is 1; an invalid (g>r) cohort is 0', () => {
    const origin = C.cohortMass({ g: 0, r: 0 }, 40, theta);
    const invalid = C.cohortMass({ g: 3, r: 2 }, 40, theta);
    return { pass: origin === 1 && invalid === 0, detail: JSON.stringify({ origin, invalid }) };
  });

  run('computeCohortWeights sum to 1 across several timepoints', () => {
    let ok = true;
    for (const t of [0, 30, 60, 120, 200]) {
      const w = C.computeCohortWeights(t, theta, 4);
      const total = w.reduce((s, item) => s + item.weight, 0);
      if (!close(total, 1, 1e-9)) ok = false;
    }
    return { pass: ok, detail: '' };
  });

  // ── §12 position distribution ──────────────────────────────────────────────
  run('cohortPositionDensity is 0 below a cohort lower bound (-delta for non-origin cohorts)', () => {
    const cohort = { g: 1, r: 1 };
    const below = C.cohortPositionDensity(-theta.delta - 5, cohort, 40, theta);
    const above = C.cohortPositionDensity(-theta.delta + 1, cohort, 40, theta);
    return { pass: below === 0 && above >= 0, detail: JSON.stringify({ below, above }) };
  });

  run('cloccsPositionDensity (mixture of normalised truncated normals) integrates to ~1', () => {
    let ok = true;
    const detail = [];
    for (const t of [10, 60, 120]) {
      const range = C.choosePositionIntegrationRange(t, theta, 4);
      const integral = trapz((p) => C.cloccsPositionDensity(p, t, theta, 4), range.min, range.max, 4000);
      detail.push(integral.toFixed(4));
      if (!close(integral, 1, 0.02)) ok = false;
    }
    return { pass: ok, detail: detail.join(', ') };
  });

  // ── §13 position -> DNA map and §21 phase classification ───────────────────
  const sp = { alpha1: 100, alpha2: 100, tau: 6 };
  run('expectedDnaFromPosition maps negative/G1 -> 1C, S -> ramp, G2M -> 2C', () => {
    const g1neg = C.expectedDnaFromPosition(-10, theta, sp);               // recovery -> 1C
    const g1 = C.expectedDnaFromPosition(theta.gamma1 * 0.5 * theta.lambda, theta, sp); // within G1
    const midS = C.expectedDnaFromPosition((theta.gamma1 + theta.gamma2) / 2 * theta.lambda, theta, sp);
    const g2 = C.expectedDnaFromPosition((theta.gamma2 + 1) / 2 * theta.lambda, theta, sp);
    const pass = close(g1neg, 100, 1e-9) && close(g1, 100, 1e-9) && close(midS, 150, 1) && close(g2, 200, 1e-9);
    return { pass, detail: JSON.stringify({ g1neg, g1, midS, g2 }) };
  });

  run('phaseFromPosition classifies G1 / S / G2M by cycle fraction', () => {
    const a = C.phaseFromPosition(-5, theta) === 'G1';
    const b = C.phaseFromPosition(theta.gamma1 * 0.5 * theta.lambda, theta) === 'G1';
    const c = C.phaseFromPosition((theta.gamma1 + theta.gamma2) / 2 * theta.lambda, theta) === 'S';
    const d = C.phaseFromPosition((theta.gamma2 + 1) / 2 * theta.lambda, theta) === 'G2M';
    return { pass: a && b && c && d, detail: JSON.stringify({ a, b, c, d }) };
  });

  // ── §14/§15 predicted DNA density normalises ───────────────────────────────
  run('predictDnaDensityAtValue integrates over DNA to ~1', () => {
    const integral = trapz((dna) => C.predictDnaDensityAtValue({ dnaValue: dna, time: 60, theta, sampleParameters: sp, maxR: 4, gridSize: 300 }), -50, 350, 800);
    return { pass: close(integral, 1, 0.03), detail: integral.toFixed(4) };
  });

  run('predictHistogramProbabilities are non-negative and sum to 1', () => {
    const edges = Array.from({ length: 101 }, (_, i) => i * 3); // 0..300
    const counts = new Array(100).fill(1);
    const sample = { timeMinutes: 60, histogram: C.histogramFromEdgesCounts(edges, counts) };
    const probs = C.predictHistogramProbabilities({ sample, theta, sampleParameters: sp, maxR: 4, gridSize: 300 });
    const total = probs.reduce((s, p) => s + p, 0);
    return { pass: close(total, 1, 1e-9) && probs.every((p) => p >= 0), detail: total.toFixed(6) };
  });

  // ── §21 phase fractions ────────────────────────────────────────────────────
  run('calculatePhaseFractions sum to 1 and are in [0,1] across timepoints', () => {
    let ok = true;
    for (const t of [0, 30, 60, 120]) {
      const pf = C.calculatePhaseFractions({ time: t, theta, maxR: 4 });
      if (!close(pf.g1 + pf.s + pf.g2, 1, 1e-6)) ok = false;
      if ([pf.g1, pf.s, pf.g2].some((v) => v < -1e-9 || v > 1 + 1e-9)) ok = false;
    }
    return { pass: ok, detail: '' };
  });

  run('early synchronized timepoints are mostly G1 (1C)', () => {
    const pf0 = C.calculatePhaseFractions({ time: 0, theta, maxR: 4 });
    return { pass: pf0.g1 > 0.8, detail: JSON.stringify(pf0) };
  });

  // ── synthetic generation + likelihood prefers the truth ────────────────────
  const timepoints = [0, 20, 40, 60, 80, 100];
  const series = Syn.generateCloccsSeries({
    theta, timepoints, sampleParameters: sp, maxR: 3, eventCount: 2500, seed: 7, binCount: 96, dnaRange: [0, 300],
  });
  const fitConfig = { maxReproductiveInstance: 3, gridSize: 260, coordinateRounds: 6, biologicalMaxIterations: 200, sampleMaxIterations: 90 };
  const priorConfig = C.createDefaultCloccsPriors(series);
  const truthMap = new Map(series.samples.map((s) => [s.sampleId, sp]));

  run('generated t=0 sample is centered near 1C (alpha1)', () => {
    const values = series.samples[0].transformedDna;
    const meanDna = values.reduce((s, v) => s + v, 0) / values.length;
    return { pass: meanDna > 60 && meanDna < 140, detail: meanDna.toFixed(1) };
  });

  run('joint log-posterior scores the true parameters above a wrong-cycle-length theta', () => {
    const llTruth = C.strainLogPosterior({ theta, sampleParametersById: truthMap, series, config: fitConfig, priorConfig });
    const wrong = { ...theta, lambda: theta.lambda * 2 };
    const llWrong = C.strainLogPosterior({ theta: wrong, sampleParametersById: truthMap, series, config: fitConfig, priorConfig });
    return { pass: llTruth > llWrong, detail: JSON.stringify({ llTruth: llTruth.toFixed(1), llWrong: llWrong.toFixed(1) }) };
  });

  // ── end-to-end synthetic round-trip recovery ───────────────────────────────
  const fit = C.fitCloccsForStrain(series, fitConfig);

  run('fitCloccsForStrain returns a finite result with per-timepoint phase fractions', () => {
    const finiteTheta = Object.values(fit.theta).every(Number.isFinite);
    const finiteObj = Number.isFinite(fit.diagnostics.objectiveValue);
    return { pass: finiteTheta && finiteObj && fit.timepointResults.length === timepoints.length, detail: JSON.stringify(fit.theta) };
  });

  run('the fit recovers the cycle length lambda within +/-20%', () => {
    const ratio = fit.theta.lambda / theta.lambda;
    return { pass: ratio > 0.8 && ratio < 1.2, detail: `fitted lambda=${fit.theta.lambda.toFixed(1)} vs true ${theta.lambda} (ratio ${ratio.toFixed(2)})` };
  });

  run('the fit recovers the observable phase-fraction dynamics (mean abs error < 0.05)', () => {
    let mae = 0;
    let n = 0;
    for (const tp of fit.timepointResults) {
      const truthPf = C.calculatePhaseFractions({ time: tp.timeMinutes, theta, maxR: 3 });
      mae += Math.abs(tp.phaseFractions.g1 - truthPf.g1) + Math.abs(tp.phaseFractions.s - truthPf.s) + Math.abs(tp.phaseFractions.g2 - truthPf.g2);
      n += 3;
    }
    mae /= n;
    return { pass: mae < 0.05, detail: `phase-fraction MAE = ${mae.toFixed(4)}` };
  });

  run('the fit improves the joint objective below its starting value', () => {
    const startTheta = C.createInitialBiologicalParameters(series);
    const startMap = new Map(series.samples.map((s) => [s.sampleId, s.fluorescenceInit]));
    const startNeg = -C.strainLogPosterior({ theta: startTheta, sampleParametersById: startMap, series, config: fitConfig, priorConfig });
    return { pass: fit.diagnostics.objectiveValue <= startNeg, detail: JSON.stringify({ fitted: fit.diagnostics.objectiveValue.toFixed(1), start: startNeg.toFixed(1) }) };
  });

  // ── multi-start dispersion diagnostics ─────────────────────────────────────
  const multi = C.fitCloccsForStrain(series, { ...fitConfig, starts: 3, startSeed: 3 });

  run('multi-start fit reports dispersion diagnostics for every start', () => {
    const d = multi.diagnostics.dispersion;
    return { pass: multi.diagnostics.starts === 3 && d.starts === 3 && Number.isFinite(d.lambda.cv) && Number.isFinite(d.agreementFraction), detail: JSON.stringify({ starts: d.starts, lambdaCv: d.lambda.cv.toFixed(3), agree: d.agreementFraction.toFixed(2) }) };
  });

  run('on identifiable synthetic data the starts agree (well-identified: agreement >= 0.5, small lambda spread)', () => {
    const d = multi.diagnostics.dispersion;
    return { pass: d.agreementFraction >= 0.5 && d.lambda.cv < 0.25, detail: JSON.stringify({ agree: d.agreementFraction.toFixed(2), lambdaCv: d.lambda.cv.toFixed(3) }) };
  });

  run('multi-start does not worsen the best objective vs a single start', () => {
    const single = C.fitCloccsForStrain(series, { ...fitConfig, starts: 1 });
    return { pass: multi.diagnostics.objectiveValue <= single.diagnostics.objectiveValue + 1e-6, detail: JSON.stringify({ multi: multi.diagnostics.objectiveValue.toFixed(1), single: single.diagnostics.objectiveValue.toFixed(1) }) };
  });

  // ── MCMC posterior sampling (§19 optional stage) ───────────────────────────
  const posterior = C.sampleCloccsPosterior(series, { ...fitConfig, posteriorDraws: 500, posteriorBurnIn: 150, posteriorStepSize: 0.06 }, fit);

  run('sampleCloccsPosterior returns ordered, non-degenerate intervals with a reasonable (adapted) acceptance rate', () => {
    const iv = posterior.intervals;
    const ordered = Object.values(iv).every((i) => i.p2_5 <= i.p50 && i.p50 <= i.p97_5);
    const moved = iv.lambda.p97_5 > iv.lambda.p2_5 && iv.gamma1.p97_5 > iv.gamma1.p2_5;
    const accOk = posterior.acceptanceRate > 0.08 && posterior.acceptanceRate < 0.7;
    return { pass: ordered && moved && accOk && posterior.draws === 500, detail: JSON.stringify({ acc: posterior.acceptanceRate.toFixed(2), lambda: iv.lambda }) };
  });

  run('the posterior credible interval for lambda is centered on and contains the MAP estimate', () => {
    const iv = posterior.intervals.lambda;
    // A sharp, data-rich posterior concentrates around the MAP (not necessarily
    // the true value, which the MAP itself is biased from by finite data).
    return { pass: fit.theta.lambda >= iv.p2_5 && fit.theta.lambda <= iv.p97_5, detail: `MAP ${fit.theta.lambda.toFixed(1)} in [${iv.p2_5.toFixed(2)}, ${iv.p97_5.toFixed(2)}]` };
  });

  // ── cooperative async fit + cancellation ───────────────────────────────────
  await runAsync('fitCloccsForStrainAsync matches the synchronous fit', async () => {
    const asyncFit = await C.fitCloccsForStrainAsync(series, fitConfig);
    return { pass: close(asyncFit.theta.lambda, fit.theta.lambda, 1e-6) && close(asyncFit.diagnostics.objectiveValue, fit.diagnostics.objectiveValue, 1e-6), detail: JSON.stringify({ asyncLambda: asyncFit.theta.lambda.toFixed(2), syncLambda: fit.theta.lambda.toFixed(2) }) };
  });

  await runAsync('fitCloccsForStrainAsync honours an immediate cancellation request', async () => {
    const outcome = await C.fitCloccsForStrainAsync(series, fitConfig, { shouldCancel: () => true });
    return { pass: outcome.cancelled === true, detail: JSON.stringify(outcome) };
  });

  // ── registry contract ──────────────────────────────────────────────────────
  run('cloccs model entry is joint_series, labelled "CLOCCS (Unverified)", and per-sample fit() refuses', () => {
    const entry = C.cloccs;
    let refused = false;
    try { entry.fit({}); } catch (_) { refused = true; }
    return { pass: entry.fitScope === 'joint_series' && entry.label === 'CLOCCS (Unverified)' && refused, detail: JSON.stringify({ fitScope: entry.fitScope, label: entry.label }) };
  });

  return results;
}"""


def run_cloccs_tests(ctx: TestContext):
    """Run the CLOCCS model, synthetic generator, and Nelder-Mead assertions."""

    try:
        all_results = ctx.page.evaluate(_CLOCCS_TESTS)
    except Exception as err:
        ctx.check(GROUP, "cloccs suite setup", False, str(err), screenshot=False)
        return

    for item in all_results:
        ctx.check(GROUP, item["name"], item["pass"], item.get("detail", ""), screenshot=False)
