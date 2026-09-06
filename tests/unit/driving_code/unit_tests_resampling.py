#!/usr/bin/env python3
"""Browser unit coverage for js/analysis/cell_cycle/resampling.js (UNC-01).

uncertainty.js answers "how much did the data determine this parameter, given
that the model, the bins, the peak regions and the QC gate are all exactly
right?" That conditional is the whole problem: every one of those four is a
choice, and this layer re-runs the fit under a perturbed version of each so the
interval carries their cost too.

The assertions are grouped so a failure names its own layer:

  * the samplers must be exact, not approximately right. The Poisson test runs
    at lambda = 1200 specifically because `Math.exp(-1200)` is exactly 0 in
    double precision, so the textbook Knuth product form returns 0 events for
    every bin of a busy G1 peak and silently deletes the data. The log-form
    inter-arrival sampler used here is the reason the numbers below come out.

  * the peak-region jitter must never emit a region the rest of the codebase
    would reject. That is asserted against the REAL validatePeakRegions rather
    than a restatement of its rules, because a private copy of an invariant
    drifts away from the invariant it is copying.

  * an interval must not be able to leave [0, 1]. That is the specific reason
    percentile intervals are used for phase fractions where the delta method
    clips: a percentile endpoint IS one of the replicate estimates, so it is
    in range by construction rather than by repair.

  * a bundle must say what it did NOT perturb. QC gating lives upstream of the
    model layer and cannot be perturbed from inside this module, so a caller
    that does not supply qcVariants gets an interval narrower than the truth --
    and the honesty chain that reports this (skipped -> warning -> definition
    sentence) is asserted end to end.

The resampleUncertainty tests drive a synthetic fitFn rather than a real model.
A real fit costs 0.5-3.2 s, so a single test would exceed the whole suite's
budget; what is under test here is the resampling machinery itself.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / Cell Cycle Resampling"


_RESAMPLING_TESTS = r"""() => {
  const {
    resampleEvents, poissonResampleCounts, perturbPeakRegions,
    percentileInterval, resampleUncertainty, resamplingWarnings,
    INTERVAL_METHOD, RESAMPLE_METHOD,
    DEFAULT_REPLICATES, MINIMUM_USABLE_REPLICATES, DEFAULT_INTERVAL_LEVEL,
    DEFAULT_REGION_JITTER_FRACTION, SELECTION_STABILITY_THRESHOLD,
  } = window.CellCycleResampling;
  const { validatePeakRegions } = window.CellCyclePeakRegions;

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

  // A local mulberry32, identical to the shared one. The samplers take an rng
  // argument precisely so these tests can be deterministic; keeping a local
  // copy makes the sampler assertions independent of how the app seeds itself.
  const rngFrom = (seed) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const meanOf = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const varianceOf = (xs) => {
    const m = meanOf(xs);
    return xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  };

  // ============================ samplers ============================

  run('UNC-01: resampleEvents draws n values with replacement from the input', () => {
    const values = [3, 1, 4, 1, 5, 9, 2, 6];
    const drawn = resampleEvents(values, rngFrom(11));
    const allowed = new Set(values);
    return {
      pass: drawn.length === values.length && drawn.every((v) => allowed.has(v)),
      detail: `n=${drawn.length}, first four ${drawn.slice(0, 4).join(',')}`,
    };
  });

  run('UNC-01: resampleEvents is a resample, not a permutation', () => {
    // A permutation preserves the multiset exactly, so no value ever repeats.
    // Over 200 draws of 40 distinct values at least one must repeat, or the
    // "with replacement" half of the bootstrap is not happening and every
    // replicate is the same dataset in a different order.
    const values = Array.from({ length: 40 }, (_, i) => i);
    const rng = rngFrom(12);
    let sawRepeat = false;
    for (let i = 0; i < 200 && !sawRepeat; i += 1) {
      const drawn = resampleEvents(values, rng);
      sawRepeat = new Set(drawn).size < drawn.length;
    }
    return { pass: sawRepeat, detail: `repeat observed: ${sawRepeat}` };
  });

  run('UNC-01: the event bootstrap is unbiased for the sample mean', () => {
    const values = Array.from({ length: 400 }, (_, i) => 80 + (i % 37) * 0.7);
    const sampleMean = meanOf(values);
    const rng = rngFrom(13);
    const means = Array.from({ length: 400 }, () => meanOf(resampleEvents(values, rng)));
    const bootMean = meanOf(means);
    return {
      pass: close(bootMean, sampleMean, 0.2),
      detail: `bootstrap mean-of-means ${bootMean.toFixed(4)} vs sample mean ${sampleMean.toFixed(4)}`,
    };
  });

  run('UNC-01: Poisson resampling matches lambda in both mean and variance', () => {
    const rng = rngFrom(21);
    const checks = [0.5, 12].map((lambda) => {
      const draws = poissonResampleCounts(Array.from({ length: 4000 }, () => lambda), rng);
      const m = meanOf(draws);
      const v = varianceOf(draws);
      return { lambda, m, v, ok: close(m / lambda, 1, 0.06) && close(v / m, 1, 0.12) };
    });
    return {
      pass: checks.every((c) => c.ok),
      detail: checks.map((c) => `lambda ${c.lambda}: mean ${c.m.toFixed(3)}, var/mean ${(c.v / c.m).toFixed(3)}`).join('; '),
    };
  });

  run('UNC-01: Poisson resampling survives a lambda where exp(-lambda) underflows', () => {
    // This is the whole reason the sampler is written in log form. A busy G1
    // bin of a 300k-event file really does reach lambda ~ 1200, and the Knuth
    // product form compares a running product against exp(-1200), which IS
    // exactly 0 in double precision -- so it returns 0 for every such bin and
    // deletes the peak from every replicate.
    const underflows = Math.exp(-1200) === 0;
    const rng = rngFrom(22);
    const draws = poissonResampleCounts(Array.from({ length: 3000 }, () => 1200), rng);
    const m = meanOf(draws);
    const v = varianceOf(draws);
    const anyZero = draws.some((d) => d === 0);
    return {
      pass: underflows && !anyZero && close(m / 1200, 1, 0.01) && close(v / m, 1, 0.1),
      detail: `exp(-1200) === 0: ${underflows}; mean ${m.toFixed(1)}, var/mean ${(v / m).toFixed(3)}, any empty bin: ${anyZero}`,
    };
  });

  run('UNC-01: Poisson resampling maps empty and non-finite bins to zero', () => {
    const drawn = poissonResampleCounts([0, -3, NaN, Infinity, null, undefined], rngFrom(23));
    return {
      pass: drawn.length === 6 && drawn.every((d) => d === 0),
      detail: `drawn [${drawn.join(', ')}]`,
    };
  });

  // ======================= peak-region jitter =======================

  run('UNC-01: jittered peak regions always pass the real validatePeakRegions', () => {
    // Regression test. Repairing an overlap by pulling the INNER edges apart
    // could drag an inner edge past its own outer edge when the regions
    // started close together and the jitter was large, emitting a region with
    // left >= right. 448 of 5000 draws did this before the fix.
    const tight = { g1: { left: 95, right: 105 }, g2: { left: 106, right: 116 } };
    const rng = rngFrom(31);
    let rejected = 0;
    let inverted = 0;
    for (let i = 0; i < 3000; i += 1) {
      const jittered = perturbPeakRegions(tight, rng, { jitterFraction: 0.9 });
      if (!(jittered.g1.left < jittered.g1.right) || !(jittered.g2.left < jittered.g2.right)) inverted += 1;
      try {
        validatePeakRegions(jittered);
      } catch (error) {
        rejected += 1;
      }
    }
    return {
      pass: rejected === 0 && inverted === 0,
      detail: `${rejected}/3000 rejected by validatePeakRegions, ${inverted}/3000 inverted`,
    };
  });

  run('UNC-01: jitter magnitude scales with the width of the region it perturbs', () => {
    // A fixed absolute jitter would be a large perturbation for a tight region
    // and a rounding error for a wide one. Mean |delta| for a uniform shift
    // over +/- f*width is f*width/2, so f = 0.1 gives 5.0 and 0.5.
    const measure = (width) => {
      const regions = { g1: { left: 0, right: width }, g2: { left: 4 * width, right: 5 * width } };
      const rng = rngFrom(32);
      let total = 0;
      for (let i = 0; i < 2000; i += 1) {
        total += Math.abs(perturbPeakRegions(regions, rng, { jitterFraction: 0.1 }).g1.left);
      }
      return total / 2000;
    };
    const wide = measure(100);
    const narrow = measure(10);
    return {
      pass: close(wide, 5, 0.6) && close(narrow, 0.5, 0.06),
      detail: `mean |delta left|: width 100 -> ${wide.toFixed(3)} (expect ~5), width 10 -> ${narrow.toFixed(3)} (expect ~0.5)`,
    };
  });

  run('UNC-01: a zero jitter fraction returns the regions unchanged', () => {
    const regions = { g1: { left: 40, right: 70 }, g2: { left: 95, right: 125 } };
    const out = perturbPeakRegions(regions, rngFrom(33), { jitterFraction: 0 });
    return {
      pass: out.g1.left === 40 && out.g1.right === 70 && out.g2.left === 95 && out.g2.right === 125,
      detail: JSON.stringify(out),
    };
  });

  // =========================== intervals ============================

  run('UNC-01: percentile endpoints are the empirical quantiles', () => {
    const samples = Array.from({ length: 101 }, (_, i) => i / 100);
    const interval = percentileInterval(samples, {
      level: 0.9, pointEstimate: 0.5, method: INTERVAL_METHOD.PERCENTILE,
    });
    return {
      pass: close(interval.lower, 0.05, 1e-9) && close(interval.upper, 0.95, 1e-9)
        && close(interval.median, 0.5, 1e-9),
      detail: `[${interval.lower.toFixed(4)}, ${interval.upper.toFixed(4)}], median ${interval.median.toFixed(4)}`,
    };
  });

  run('UNC-01: percentile endpoints cannot leave the range the replicates live in', () => {
    // The delta method has to clip a fraction interval back into [0, 1] and
    // raise a `clipped` flag. A percentile endpoint IS one of the replicates,
    // so it is in range by construction. Asserted on a fraction pinned hard
    // against 0, where the symmetric interval certainly goes negative.
    const samples = Array.from({ length: 400 }, (_, i) => (i % 17) * 0.0006);
    const interval = percentileInterval(samples, {
      level: 0.95, pointEstimate: 0.004, method: INTERVAL_METHOD.PERCENTILE,
    });
    const symmetricLower = interval.value - 1.959963984540054 * interval.standardError;
    return {
      pass: interval.lower >= 0 && interval.upper <= 1 && symmetricLower < 0,
      detail: `percentile [${interval.lower.toFixed(5)}, ${interval.upper.toFixed(5)}]; `
        + `a symmetric lower bound would be ${symmetricLower.toFixed(5)}`,
    };
  });

  run('UNC-01: bias correction is a no-op when the point estimate sits at the median', () => {
    const samples = Array.from({ length: 101 }, (_, i) => i / 100);
    const interval = percentileInterval(samples, {
      level: 0.9, pointEstimate: 0.5, method: INTERVAL_METHOD.BIAS_CORRECTED,
    });
    return {
      pass: interval.biasCorrectionApplied === true && Math.abs(interval.z0) < 0.02
        && close(interval.lower, 0.05, 0.01) && close(interval.upper, 0.95, 0.01),
      detail: `z0 ${interval.z0.toFixed(6)} -> [${interval.lower.toFixed(4)}, ${interval.upper.toFixed(4)}]`,
    };
  });

  run('UNC-01: bias correction moves BOTH endpoints toward a low-lying point estimate', () => {
    // About 20% of the replicates fall below the point estimate, so z0 is
    // roughly probit(0.2) = -0.85 and both endpoints must move down. An
    // implementation that moved only one would be widening the interval
    // instead of relocating it, which is a different (and wrong) claim.
    const samples = Array.from({ length: 101 }, (_, i) => i / 100);
    const plain = percentileInterval(samples, {
      level: 0.9, pointEstimate: 0.2, method: INTERVAL_METHOD.PERCENTILE,
    });
    const corrected = percentileInterval(samples, {
      level: 0.9, pointEstimate: 0.2, method: INTERVAL_METHOD.BIAS_CORRECTED,
    });
    return {
      pass: close(corrected.z0, -0.8487, 0.02)
        && corrected.lower < plain.lower && corrected.upper < plain.upper,
      detail: `z0 ${corrected.z0.toFixed(4)}; plain [${plain.lower.toFixed(4)}, ${plain.upper.toFixed(4)}] `
        + `-> corrected [${corrected.lower.toFixed(4)}, ${corrected.upper.toFixed(4)}]`,
    };
  });

  run('UNC-01: a saturated bias correction falls back to the plain percentile', () => {
    // Every replicate above the point estimate makes z0 = probit(0) = -Inf,
    // which would collapse both endpoints onto the minimum. Reporting the
    // uncorrected interval and saying the correction was not applied is the
    // honest outcome; silently emitting the collapsed one is not.
    const samples = Array.from({ length: 101 }, (_, i) => i / 100);
    const interval = percentileInterval(samples, {
      level: 0.9, pointEstimate: -1, method: INTERVAL_METHOD.BIAS_CORRECTED,
    });
    return {
      pass: interval.biasCorrectionApplied === false
        && close(interval.lower, 0.05, 1e-9) && close(interval.upper, 0.95, 1e-9),
      detail: `applied ${interval.biasCorrectionApplied} -> [${interval.lower.toFixed(4)}, ${interval.upper.toFixed(4)}]`,
    };
  });

  run('UNC-01: too few replicates yields NaN endpoints rather than a throw', () => {
    const interval = percentileInterval([0.4], {
      level: 0.95, pointEstimate: 0.4, method: INTERVAL_METHOD.BIAS_CORRECTED,
    });
    return {
      pass: Number.isNaN(interval.lower) && Number.isNaN(interval.upper) && interval.replicates === 1,
      detail: `replicates ${interval.replicates}, [${interval.lower}, ${interval.upper}]`,
    };
  });

  // ==================== resampleUncertainty ====================

  const EDGES = Array.from({ length: 65 }, (_, i) => i * 4);
  const COUNTS = Array.from({ length: 64 }, (_, i) => Math.round(
    400 * Math.exp(-((i - 16) ** 2) / 18) + 300 * Math.exp(-((i - 32) ** 2) / 20) + 30,
  ));
  const HISTOGRAM = { edges: EDGES, counts: COUNTS, y: COUNTS, binCount: 64, min: 0, max: 256 };
  const REGIONS = { g1: { left: 50, right: 80 }, g2: { left: 115, right: 145 } };
  const BASE = {
    histogram: HISTOGRAM, peakRegions: REGIONS, domain: { min: 0, max: 256 }, binCount: 64,
  };

  // Fractions track the resampled counts, so replicates genuinely vary and an
  // interval of width zero would mean the perturbation never reached the fit.
  const countingFitFn = ({ histogram }) => {
    const total = histogram.counts.reduce((a, b) => a + b, 0);
    const peak = Math.max(...histogram.counts);
    const s = peak / Math.max(1, total);
    return [{
      modelId: 'alpha',
      comparisonGroup: 'poisson_cell_cycle',
      converged: true,
      bic: 1000 + (total % 7),
      phaseFractions: { g1: 0.6 - s, s, g2: 0.4 },
      parameters: { total, peak },
    }];
  };

  run('UNC-01: a fixed seed reproduces the bundle exactly, and a different seed does not', () => {
    const sOf = (bundle) => bundle.models.alpha.phaseFractions.s;
    const a = resampleUncertainty({ ...BASE, fitFn: countingFitFn, replicates: 40, seed: 5 });
    const b = resampleUncertainty({ ...BASE, fitFn: countingFitFn, replicates: 40, seed: 5 });
    const c = resampleUncertainty({ ...BASE, fitFn: countingFitFn, replicates: 40, seed: 6 });
    return {
      pass: sOf(a).lower === sOf(b).lower && sOf(a).upper === sOf(b).upper
        && sOf(a).lower !== sOf(c).lower,
      detail: `seed 5 lower ${sOf(a).lower.toFixed(8)}, repeat ${sOf(b).lower.toFixed(8)}, `
        + `seed 6 ${sOf(c).lower.toFixed(8)}`,
    };
  });

  run('UNC-01: the bundle records which perturbations it OMITTED, end to end', () => {
    // The chain that stops an over-narrow interval passing as a complete one:
    // skipped list -> warning -> the plain-English definition sentence. QC
    // gating happens upstream of the model layer, so a caller that supplies no
    // qcVariants gets an interval that excludes QC-choice variance, and all
    // three surfaces have to say so.
    const bundle = resampleUncertainty({ ...BASE, fitFn: countingFitFn, replicates: 30, seed: 8 });
    const skipped = bundle.perturbations.skipped.map((entry) => entry.name);
    const warnIds = resamplingWarnings(bundle).map((w) => w.id);
    return {
      pass: skipped.includes('qc')
        && warnIds.includes('perturbations_incomplete')
        && /It does NOT include:.*qc/.test(bundle.definition)
        && bundle.perturbations.skipped.every((entry) => Boolean(entry.reason)),
      detail: `skipped [${skipped.join(', ')}]; warnings [${warnIds.join(', ')}]; `
        + `definition ends "${bundle.definition.slice(-56)}"`,
    };
  });

  run('UNC-01: a histogram-only caller is labelled as the Poisson fallback', () => {
    // Without the retained events there is nothing to bootstrap and nothing to
    // re-bin, so the method name and the skipped list both have to change
    // rather than the caller quietly receiving a weaker interval under the
    // stronger method's name.
    const bundle = resampleUncertainty({ ...BASE, fitFn: countingFitFn, replicates: 20, seed: 9 });
    const skipped = bundle.perturbations.skipped.map((entry) => entry.name);
    return {
      pass: bundle.method === RESAMPLE_METHOD.POISSON_COUNTS
        && skipped.includes('event_bootstrap') && skipped.includes('bin_domain'),
      detail: `method ${bundle.method}; skipped [${skipped.join(', ')}]`,
    };
  });

  run('UNC-01: failed replicates are counted, not silently dropped', () => {
    let call = 0;
    const flaky = (args) => {
      call += 1;
      if (call % 4 === 0) throw new Error('synthetic optimizer failure');
      return countingFitFn(args);
    };
    const bundle = resampleUncertainty({ ...BASE, fitFn: flaky, replicates: 50, seed: 10 });
    const warnIds = resamplingWarnings(bundle).map((w) => w.id);
    return {
      pass: bundle.replicatesSucceeded + bundle.replicatesFailed === 50
        && bundle.replicatesFailed > 0 && bundle.failures.length > 0
        && bundle.failures.every((f) => Boolean(f.reason))
        && warnIds.includes('resample_failure_rate'),
      detail: `${bundle.replicatesSucceeded} ok / ${bundle.replicatesFailed} failed; `
        + `warnings [${warnIds.join(', ')}]`,
    };
  });

  run('UNC-01: too few usable replicates is blocking, not advisory', () => {
    const bundle = resampleUncertainty({
      ...BASE, fitFn: countingFitFn, seed: 14,
      replicates: Math.max(2, MINIMUM_USABLE_REPLICATES - 5),
    });
    const warning = resamplingWarnings(bundle).find((w) => w.id === 'resample_insufficient_replicates');
    return {
      pass: Boolean(warning) && warning.severity === 'critical' && warning.nonreportable === true,
      detail: warning
        ? `severity ${warning.severity}, nonreportable ${warning.nonreportable}`
        : `no warning at ${bundle.replicatesSucceeded} replicates (floor ${MINIMUM_USABLE_REPLICATES})`,
    };
  });

  run('UNC-01: every warning uses the shared id/severity/nonreportable vocabulary', () => {
    const bundle = resampleUncertainty({ ...BASE, fitFn: countingFitFn, replicates: 5, seed: 15 });
    const warnings = resamplingWarnings(bundle);
    return {
      pass: warnings.length > 0 && warnings.every((w) => typeof w.id === 'string' && w.id
        && ['info', 'warning', 'critical'].includes(w.severity)
        && typeof w.nonreportable === 'boolean'
        && typeof w.message === 'string' && w.message.length > 10),
      detail: warnings.map((w) => `${w.id}/${w.severity}/${w.nonreportable}`).join(', '),
    };
  });

  run('UNC-01: a cancelled run returns the partial bundle it had already built', () => {
    let seen = 0;
    const bundle = resampleUncertainty({
      ...BASE, fitFn: countingFitFn, replicates: 200, seed: 16,
      shouldCancel: () => { seen += 1; return seen > 12; },
    });
    const warnIds = resamplingWarnings(bundle).map((w) => w.id);
    return {
      pass: bundle.cancelled === true && bundle.replicatesSucceeded === 12
        && warnIds.includes('resample_insufficient_replicates'),
      detail: `cancelled ${bundle.cancelled}, ${bundle.replicatesSucceeded}/200 done, `
        + `warnings [${warnIds.join(', ')}]`,
    };
  });

  // ======================== model selection =========================

  const twoGroupFitFn = ({ histogram }) => {
    const total = histogram.counts.reduce((a, b) => a + b, 0);
    return [
      {
        modelId: 'alpha', comparisonGroup: 'poisson_cell_cycle', converged: true,
        bic: 1000 + (total % 7), phaseFractions: { g1: 0.5, s: 0.3, g2: 0.2 },
      },
      {
        // The decomposition model. Its BIC is absurdly low on purpose: if the
        // null comparisonGroup were ever ignored it would win every replicate,
        // so the failure could not be mistaken for noise.
        modelId: 'gamma_decomposition', comparisonGroup: null, converged: true,
        bic: -99999, phaseFractions: { g1: 0.4, s: 0.4, g2: 0.2 },
      },
    ];
  };

  run('UNC-01: a null comparison group is never BIC-ranked, however low its BIC', () => {
    // Plan section 5.5: never AIC/BIC-rank a decomposition against a
    // generative model. watson_pragmatic declares comparisonGroup null for
    // exactly this reason, and the selection code is where that declaration is
    // enforced rather than merely stated. Its intervals are still reported --
    // the model is excluded from the RANKING, not from the output.
    const bundle = resampleUncertainty({ ...BASE, fitFn: twoGroupFitFn, replicates: 40, seed: 17 });
    const frequency = bundle.selection.frequency;
    return {
      pass: frequency.gamma_decomposition === undefined
        && bundle.selection.pointEstimateWinner === 'alpha'
        && Boolean(bundle.models.gamma_decomposition),
      detail: `frequency ${JSON.stringify(frequency)}; winner ${bundle.selection.pointEstimateWinner}; `
        + `gamma intervals still present: ${Boolean(bundle.models.gamma_decomposition)}`,
    };
  });

  run('UNC-01: a non-converged fit is never BIC-ranked either', () => {
    const bundle = resampleUncertainty({
      ...BASE, replicates: 30, seed: 18,
      fitFn: () => [
        {
          modelId: 'alpha', comparisonGroup: 'poisson_cell_cycle', converged: true,
          bic: 1000, phaseFractions: { g1: 0.5, s: 0.3, g2: 0.2 },
        },
        {
          modelId: 'beta', comparisonGroup: 'poisson_cell_cycle', converged: false,
          bic: -9999, phaseFractions: { g1: 0.1, s: 0.8, g2: 0.1 },
        },
      ],
    });
    return {
      pass: bundle.selection.frequency.beta === undefined
        && bundle.selection.pointEstimateWinner === 'alpha',
      detail: `frequency ${JSON.stringify(bundle.selection.frequency)}, `
        + `winner ${bundle.selection.pointEstimateWinner}`,
    };
  });

  run('UNC-01: two different comparison groups are refused, not ranked by array order', () => {
    // Ranking across two non-null groups is as wrong as ranking against a null
    // one, and taking whichever group happened to come first in the array
    // would hide it behind a plausible-looking winner.
    const bundle = resampleUncertainty({
      ...BASE, replicates: 20, seed: 19,
      fitFn: () => [
        {
          modelId: 'alpha', comparisonGroup: 'poisson_cell_cycle', converged: true,
          bic: 1000, phaseFractions: { g1: 0.5, s: 0.3, g2: 0.2 },
        },
        {
          modelId: 'zeta', comparisonGroup: 'gaussian_mixture', converged: true,
          bic: -5000, phaseFractions: { g1: 0.4, s: 0.4, g2: 0.2 },
        },
      ],
    });
    const warnIds = resamplingWarnings(bundle).map((w) => w.id);
    return {
      pass: bundle.selection.pointEstimateWinner === null
        && bundle.selection.replicates === 0
        && (bundle.selection.ambiguousGroups ?? []).length === 2
        && warnIds.includes('selection_group_ambiguous'),
      detail: `winner ${bundle.selection.pointEstimateWinner}; groups `
        + `${JSON.stringify(bundle.selection.ambiguousGroups)}; warnings [${warnIds.join(', ')}]`,
    };
  });

  run('UNC-01: a winner that changes across replicates is reported as unstable', () => {
    // The reason the selection is resampled and not just the parameters: if a
    // small perturbation of the data flips which model wins, "the best model
    // is X" is not a finding, and the frequency table says so.
    const bundle = resampleUncertainty({
      ...BASE, replicates: 60, seed: 20,
      fitFn: ({ histogram }) => {
        const total = histogram.counts.reduce((a, b) => a + b, 0);
        return [
          {
            modelId: 'alpha', comparisonGroup: 'poisson_cell_cycle', converged: true,
            bic: 1000, phaseFractions: { g1: 0.5, s: 0.3, g2: 0.2 },
          },
          {
            modelId: 'beta', comparisonGroup: 'poisson_cell_cycle', converged: true,
            bic: 1000 + (total % 3 === 0 ? -5 : 5), phaseFractions: { g1: 0.52, s: 0.28, g2: 0.2 },
          },
        ];
      },
    });
    const warnIds = resamplingWarnings(bundle).map((w) => w.id);
    const freq = bundle.selection.frequency;
    const total = Object.values(freq).reduce((a, b) => a + b, 0);
    return {
      pass: Object.keys(freq).length === 2 && close(total, 1, 1e-9)
        && bundle.selection.winnerFrequency < SELECTION_STABILITY_THRESHOLD
        && bundle.selection.stable === false
        && warnIds.includes('model_selection_unstable'),
      detail: `frequency ${JSON.stringify(freq)} (sums to ${total.toFixed(6)}); `
        + `stable ${bundle.selection.stable}; warnings [${warnIds.join(', ')}]`,
    };
  });

  // ==================== defaults and the event path ====================

  run('UNC-01: the declared defaults are the ones the module actually uses', () => {
    const bundle = resampleUncertainty({ ...BASE, fitFn: countingFitFn, seed: 24 });
    return {
      pass: bundle.replicatesRequested === DEFAULT_REPLICATES
        && bundle.intervalLevel === DEFAULT_INTERVAL_LEVEL
        && DEFAULT_REPLICATES > MINIMUM_USABLE_REPLICATES
        && DEFAULT_REGION_JITTER_FRACTION > 0 && DEFAULT_REGION_JITTER_FRACTION < 1,
      detail: `requested ${bundle.replicatesRequested} vs default ${DEFAULT_REPLICATES}; `
        + `level ${bundle.intervalLevel}; floor ${MINIMUM_USABLE_REPLICATES}; `
        + `jitter ${DEFAULT_REGION_JITTER_FRACTION}`,
    };
  });

  run('UNC-01: supplying the events unlocks the event bootstrap and the re-binning', () => {
    // Nothing is invented on this path: every consumer downstream sees only
    // bin counts, so resampling the retained events with replacement IS the
    // exact nonparametric bootstrap of what the model was fit to, and the bins
    // can be redrawn from the events rather than approximated from the counts.
    const rng = rngFrom(41);
    const values = [];
    for (let i = 0; i < 4000; i += 1) {
      values.push((rng() < 0.6 ? 64 : 128) + (rng() + rng() + rng() - 1.5) * 8);
    }
    const bundle = resampleUncertainty({
      ...BASE, values, fitFn: countingFitFn, replicates: 12, seed: 25,
    });
    const skipped = bundle.perturbations.skipped.map((entry) => entry.name);
    return {
      pass: bundle.method === RESAMPLE_METHOD.EVENT_BOOTSTRAP
        && !skipped.includes('event_bootstrap') && !skipped.includes('bin_domain')
        && bundle.perturbations.applied.binning.length >= 2
        && bundle.replicatesSucceeded === 12,
      detail: `method ${bundle.method}; applied ${JSON.stringify(bundle.perturbations.applied)}; `
        + `skipped [${skipped.join(', ')}]`,
    };
  });

  run('UNC-01: events without a resolvable domain are refused up front, not one replicate at a time', () => {
    // Re-deriving the range from each bootstrap sample would move the analysis
    // domain between replicates, which is a different analysis rather than a
    // resampling of this one; DOMAIN-01 treats the domain as a scientific
    // input. Refusing at the door also matters because a real fit costs
    // seconds, so the alternative burns the entire budget before reporting.
    let message = '';
    try {
      resampleUncertainty({
        peakRegions: REGIONS, values: [10, 20, 30, 40], fitFn: countingFitFn, replicates: 4, seed: 27,
      });
    } catch (error) {
      message = `${error.name}: ${error.message}`;
    }
    return {
      pass: message.startsWith('TypeError') && /domain/.test(message) && /binCount/.test(message),
      detail: message || 'no error thrown',
    };
  });

  run('UNC-01: a fraction interval brackets the point estimate and its own median', () => {
    // The weakest sanity property, asserted because it is exactly what a sign
    // error or a swapped quantile lookup would break: the median must lie
    // inside [lower, upper], the interval must stay inside [0, 1], and it must
    // have positive width once the replicates genuinely differ.
    const rng = rngFrom(42);
    const values = [];
    for (let i = 0; i < 3000; i += 1) {
      values.push((rng() < 0.55 ? 64 : 128) + (rng() + rng() + rng() - 1.5) * 8);
    }
    const bundle = resampleUncertainty({
      ...BASE, values, fitFn: countingFitFn, replicates: 40, seed: 26,
    });
    const s = bundle.models.alpha.phaseFractions.s;
    return {
      pass: s.upper > s.lower && s.lower <= s.median && s.median <= s.upper
        && s.lower >= 0 && s.upper <= 1 && s.standardError > 0,
      detail: `s = ${s.value.toFixed(5)} in [${s.lower.toFixed(5)}, ${s.upper.toFixed(5)}], `
        + `median ${s.median.toFixed(5)}, se ${s.standardError.toFixed(5)}`,
    };
  });

  return results;
}"""


def run_resampling_tests(ctx: TestContext):
    """Run the UNC-01 resampling-layer assertions."""

    try:
        all_results = ctx.page.evaluate(_RESAMPLING_TESTS)
    except Exception as err:
        ctx.check(
            GROUP,
            "resampling suite setup",
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
