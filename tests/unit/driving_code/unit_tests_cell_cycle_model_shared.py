#!/usr/bin/env python3
"""Browser unit coverage for js/analysis/cell_cycle/models/shared.js: the
quadratic S-phase profile, its validity rule, and the G1/G2/S component
builders the canonical Dean-Jett model (M3) assembles into a fit."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / Cell Cycle Model Shared"


_MODEL_SHARED_TESTS = r"""() => {
  const {
    sPhaseProfile, sPhaseProfileWeights, sPhaseProfileMinimum,
    PROFILE_WEIGHT_SUM, PROFILE_SHAPE_LIMIT,
    peakComponents, convolvedSPhase, projectMeansToFeasible,
  } = window.CellCycleModelShared;
  const { integrateGaussLegendre } = window.CellCycleQuadrature;
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
  const close = (left, right, tolerance = 1e-6) =>
    Math.abs(left - right) <= tolerance;
  const sum = (values) => values.reduce((total, value) => total + value, 0);
  const evenEdges = (start, end, count) =>
    Array.from({ length: count + 1 }, (_, i) => start + ((end - start) * i) / count);

  // ---- Bernstein S-phase profile (SCI-08) ---------------------------------
  // The basis change is the point: nonnegativity is now a property of the
  // parameterization, so there is no validity predicate and no repair step to
  // test -- there is instead an obligation to prove NOTHING can make it fail.

  run('sPhaseProfile integrates to 1 over [0,1] for arbitrary shape parameters', () => {
    const cases = [[0, 0], [1.4, -0.6], [-3, 2.5], [7, -7], [0.2, 9]];
    const integrals = cases.map(([s1, s2]) =>
      integrateGaussLegendre((z) => sPhaseProfile(z, s1, s2), 0, 1, 64));
    return {
      pass: integrals.every((value) => close(value, 1, 1e-9)),
      detail: JSON.stringify(integrals),
    };
  });

  run('sPhaseProfile(z, 0, 0) is the flat profile q=1 everywhere', () => {
    const values = [0, 0.25, 0.5, 0.75, 1].map((z) => sPhaseProfile(z, 0, 0));
    return { pass: values.every((value) => close(value, 1, 1e-12)), detail: values };
  });

  run('the Bernstein weights are strictly positive and sum to PROFILE_WEIGHT_SUM', () => {
    const cases = [[0, 0], [12, -12], [-40, 40], [1e3, 1e3], [-1e3, 0]];
    const bad = cases.filter(([s1, s2]) => {
      const weights = sPhaseProfileWeights(s1, s2);
      return weights.some((w) => !(w > 0)) || !close(weights[0] + weights[1] + weights[2], PROFILE_WEIGHT_SUM, 1e-9);
    });
    return { pass: bad.length === 0, detail: JSON.stringify(bad) };
  });

  run('extreme shape values neither overflow nor underflow the softmax', () => {
    // Two separate hazards. Overflow: without subtracting the max, exp(1000) is
    // Infinity and every weight becomes NaN. Underflow: without PROFILE_SHAPE_LIMIT,
    // exp(-2000) is exactly 0 and a weight silently leaves the open interval,
    // so "strictly positive" would be true in practice but not by construction.
    const weights = sPhaseProfileWeights(1000, -1000);
    const clamped = sPhaseProfileWeights(PROFILE_SHAPE_LIMIT, -PROFILE_SHAPE_LIMIT);
    return {
      pass: weights.every(Number.isFinite) && weights.every((w) => w > 0)
        && JSON.stringify(weights) === JSON.stringify(clamped),
      detail: JSON.stringify({ weights, clamped }),
    };
  });

  run('NO shape pair can drive the profile negative (nonnegativity by construction)', () => {
    // The whole reason for the basis change. A wide sweep of shape pairs,
    // including extremes the optimizer could never reach, must all stay >= 0 --
    // the direct a + b*z + c*z^2 form failed this for many of these values and
    // needed an explicit repair step.
    let failures = 0;
    let worst = Infinity;
    for (let i = -20; i <= 20; i += 1) {
      for (let j = -20; j <= 20; j += 1) {
        const minimum = sPhaseProfileMinimum(i, j);
        if (minimum < worst) worst = minimum;
        if (!(minimum >= 0)) failures += 1;
      }
    }
    return { pass: failures === 0 && worst >= 0, detail: `failures=${failures} worstMinimum=${worst}` };
  });

  run('sPhaseProfileMinimum finds an interior minimum when the profile is U-shaped', () => {
    // w1 far below w0 and w2 puts the minimum strictly inside (0, 1).
    const [s1, s2] = [-3, 0];
    const minimum = sPhaseProfileMinimum(s1, s2);
    let scanned = Infinity;
    for (let k = 0; k <= 1000; k += 1) scanned = Math.min(scanned, sPhaseProfile(k / 1000, s1, s2));
    return {
      pass: close(minimum, scanned, 1e-6) && minimum < Math.min(sPhaseProfile(0, s1, s2), sPhaseProfile(1, s1, s2)),
      detail: JSON.stringify({ minimum, scanned }),
    };
  });

  run('the shape parameters actually reshape the profile (they are not inert)', () => {
    const early = sPhaseProfile(0.1, -4, -4); // weight pushed toward G1
    const late = sPhaseProfile(0.9, -4, -4);
    return { pass: early > late * 2, detail: JSON.stringify({ early, late }) };
  });

  run('randomized shapes yield nonnegative, normalized S expected counts', () => {
    const edges = evenEdges(-200, 400, 240);
    let failures = 0;
    for (let index = 0; index < 20; index += 1) {
      const shape1 = ((index * 17) % 31) - 15;
      const shape2 = ((index * 29) % 37) - 18;
      const counts = convolvedSPhase(edges, {
        sArea: 1000, g1Mean: 70, g2Mean: 140, broadeningCV: 0.08, shape1, shape2,
      });
      if (counts.some((value) => value < -1e-12) || !close(sum(counts), 1000, 0.1)) failures += 1;
    }
    return { pass: failures === 0, detail: `failures=${failures}` };
  });

  // ---- peakComponents ---------------------------------------------------
  run('peakComponents derives sigma = CV * mean independently per peak', () => {
    const edges = evenEdges(0, 400, 400);
    const out = peakComponents(edges, {
      g1Area: 1000, g1Mean: 70, g1CV: 0.08,
      g2Area: 1000, g2Mean: 140, g2CV: 0.10,
    });
    return {
      pass: close(out.g1Sigma, 70 * 0.08, 1e-9) && close(out.g2Sigma, 140 * 0.10, 1e-9),
      detail: { g1Sigma: out.g1Sigma, g2Sigma: out.g2Sigma },
    };
  });

  run('peakComponents recovers each peak\'s full area over a wide domain', () => {
    const edges = evenEdges(0, 400, 800);
    const out = peakComponents(edges, {
      g1Area: 1234, g1Mean: 70, g1CV: 0.08,
      g2Area: 4321, g2Mean: 140, g2CV: 0.10,
    });
    const g1Total = sum(out.g1);
    const g2Total = sum(out.g2);
    return {
      pass: close(g1Total, 1234, 1234 * 1e-6) && close(g2Total, 4321, 4321 * 1e-6),
      detail: { g1Total, g2Total },
    };
  });

  // ---- convolvedSPhase ----------------------------------------------------
  run('a shape that WAS infeasible under the old basis now fits normally', () => {
    // Under the direct a + b*z + c*z^2 form, (b, c) = (0, -6) gave q(1) = -3 and
    // convolvedSPhase returned all zeros -- a whole region of parameter space the
    // optimizer had to be projected out of. The Bernstein basis has no such
    // region: the same numbers are just another valid shape.
    const edges = evenEdges(0, 400, 400);
    const out = convolvedSPhase(edges, {
      sArea: 1000, g1Mean: 70, g2Mean: 140, broadeningCV: 0.08, shape1: 0, shape2: -6,
    });
    return {
      pass: out.every((value) => value >= 0 && Number.isFinite(value)) && close(sum(out), 1000, 1),
      detail: JSON.stringify({ total: sum(out), minimum: Math.min(...out) }),
    };
  });

  run('convolvedSPhase is all-zero when g2Mean does not exceed g1Mean', () => {
    const edges = evenEdges(0, 400, 400);
    const out = convolvedSPhase(edges, {
      sArea: 1000, g1Mean: 140, g2Mean: 140, broadeningCV: 0.08, shape1: 0, shape2: 0,
    });
    return { pass: out.every((value) => value === 0), detail: sum(out) };
  });

  run('convolvedSPhase over a wide domain recovers essentially all of sArea', () => {
    const edges = evenEdges(-50, 250, 1200);
    const out = convolvedSPhase(edges, {
      sArea: 5000, g1Mean: 70, g2Mean: 140, broadeningCV: 0.08, shape1: 0.3, shape2: -0.2,
    });
    const total = sum(out);
    return { pass: close(total, 5000, 5000 * 1e-4), detail: total };
  });

  run('a flat profile (b=0,c=0) splits its S mass evenly across the G1-to-G2 midpoint', () => {
    // Both the flat quadratic profile and each latent point's own Gaussian
    // broadening are symmetric, so by symmetry almost exactly half the total
    // S mass should fall below the g1Mean/g2Mean midpoint and half above --
    // a closed-form check that (unlike a per-bin comparison) isn't sensitive
    // to how finely 64 quadrature nodes resolve any individual bin.
    const g1Mean = 70, g2Mean = 140;
    const midpoint = 0.5 * (g1Mean + g2Mean);
    const edges = evenEdges(g1Mean - 30, g2Mean + 30, 800); // generous margin for broadened tails
    const out = convolvedSPhase(edges, {
      sArea: 10000, g1Mean, g2Mean, broadeningCV: 0.03, shape1: 0, shape2: 0,
    });
    let lowerHalf = 0;
    for (let i = 0; i < out.length; i += 1) {
      if (0.5 * (edges[i] + edges[i + 1]) < midpoint) lowerHalf += out[i];
    }
    const total = sum(out);
    const fraction = lowerHalf / total;
    return { pass: close(fraction, 0.5, 0.01), detail: { fraction, total } };
  });

  run('convolvedSPhase with 64 vs 128 quadrature nodes agree closely for a smooth profile', () => {
    const edges = evenEdges(0, 400, 400);
    const params = { sArea: 3000, g1Mean: 70, g2Mean: 140, broadeningCV: 0.08, shape1: 0.4, shape2: -0.3 };
    const out64 = convolvedSPhase(edges, params, 64);
    const out128 = convolvedSPhase(edges, params, 128);
    let maxAbsDiff = 0;
    for (let i = 0; i < out64.length; i += 1) maxAbsDiff = Math.max(maxAbsDiff, Math.abs(out64[i] - out128[i]));
    // Both are already converged to well beyond what the observed counts'
    // own Poisson noise could distinguish -- looser than quadrature.js's own
    // node-agreement test since this compounds many bin-edge CDF
    // evaluations (each carrying the erf approximation's ~1.5e-7 error) on
    // top of the quadrature sum itself.
    return { pass: maxAbsDiff < 1e-4, detail: maxAbsDiff };
  });

  // ---- projectMeansToFeasible: joint region+ratio projection (audit SCI-02) ----
  const ratioOk = (mu1, mu2, [lo, hi]) => {
    const r = mu2 / mu1;
    return r >= lo - 1e-9 && r <= hi + 1e-9;
  };
  const inRegion = (v, region) => v >= region.left - 1e-9 && v <= region.right + 1e-9;

  run('projectMeansToFeasible (SCI-02) returns a feasible pair for the adversarial G1[1,10]/G2[18,20]/ratio[1.65,2.25] case', () => {
    // The old independent-clamp-then-patch code left mu1=1, mu2=18 at ratio 18.
    const regions = { g1: { left: 1, right: 10 }, g2: { left: 18, right: 20 } };
    const config = { ratioMode: 'bounded', fitRatioRange: [1.65, 2.25] };
    const { g1Mean, g2Mean } = projectMeansToFeasible(1, 18, regions, config);
    const pass = inRegion(g1Mean, regions.g1) && inRegion(g2Mean, regions.g2) && ratioOk(g1Mean, g2Mean, config.fitRatioRange);
    return { pass, detail: JSON.stringify({ g1Mean, g2Mean, ratio: g2Mean / g1Mean }) };
  });

  run('projectMeansToFeasible (SCI-02) satisfies both regions and the ratio band across a grid of proposals', () => {
    const regions = { g1: { left: 40, right: 80 }, g2: { left: 90, right: 170 } };
    const config = { ratioMode: 'bounded', fitRatioRange: [1.7, 2.1] };
    let bad = 0;
    for (let mu1 = 20; mu1 <= 100; mu1 += 7) {
      for (let mu2 = 60; mu2 <= 200; mu2 += 11) {
        const { g1Mean, g2Mean } = projectMeansToFeasible(mu1, mu2, regions, config);
        if (!(inRegion(g1Mean, regions.g1) && inRegion(g2Mean, regions.g2) && ratioOk(g1Mean, g2Mean, config.fitRatioRange))) bad += 1;
      }
    }
    return { pass: bad === 0, detail: `infeasible projections: ${bad}` };
  });

  run('projectMeansToFeasible (SCI-02) locked ratio ties mu2 = ratio*mu1 exactly and keeps both in region', () => {
    const regions = { g1: { left: 40, right: 80 }, g2: { left: 90, right: 170 } };
    const config = { ratioMode: 'locked', lockedRatio: 2 };
    const { g1Mean, g2Mean } = projectMeansToFeasible(55, 130, regions, config);
    const pass = close(g2Mean, 2 * g1Mean, 1e-9) && inRegion(g1Mean, regions.g1) && inRegion(g2Mean, regions.g2);
    return { pass, detail: JSON.stringify({ g1Mean, g2Mean }) };
  });

  run('projectMeansToFeasible (SCI-02) locked ratio remains feasible at both shared-region boundaries', () => {
    const regions = { g1: { left: 50, right: 60 }, g2: { left: 100, right: 120 } };
    const config = { ratioMode: 'locked', lockedRatio: 2 };
    const low = projectMeansToFeasible(-1, -1, regions, config);
    const high = projectMeansToFeasible(999, 999, regions, config);
    return { pass: low.g1Mean === 50 && low.g2Mean === 100 && high.g1Mean === 60 && high.g2Mean === 120, detail: JSON.stringify({ low, high }) };
  });

  run('projectMeansToFeasible (SCI-02) rejects infeasible bounded and locked constraints', () => {
    const regions = { g1: { left: 10, right: 20 }, g2: { left: 100, right: 120 } };
    let bounded = false, locked = false;
    try { projectMeansToFeasible(15, 110, regions, { ratioMode: 'bounded', fitRatioRange: [1.8, 2.2] }); } catch (error) { bounded = /No G2:G1 ratio/.test(error.message); }
    try { projectMeansToFeasible(15, 110, regions, { ratioMode: 'locked', lockedRatio: 2 }); } catch (error) { locked = /locked G2:G1 ratio/.test(error.message); }
    return { pass: bounded && locked, detail: JSON.stringify({ bounded, locked }) };
  });

  run('projectMeansToFeasible (SCI-02) free mode clamps each mean to its own region and leaves the ratio unconstrained', () => {
    const regions = { g1: { left: 40, right: 80 }, g2: { left: 90, right: 170 } };
    const { g1Mean, g2Mean } = projectMeansToFeasible(10, 500, regions, { ratioMode: 'free' });
    const pass = g1Mean === 40 && g2Mean === 170;
    return { pass, detail: JSON.stringify({ g1Mean, g2Mean }) };
  });

  run('projectMeansToFeasible (SCI-02) leaves an already-feasible proposal essentially unchanged', () => {
    const regions = { g1: { left: 40, right: 80 }, g2: { left: 90, right: 170 } };
    const config = { ratioMode: 'bounded', fitRatioRange: [1.7, 2.1] };
    // mu1=60, mu2=120 -> ratio 2.0, both interior and inside the band.
    const { g1Mean, g2Mean } = projectMeansToFeasible(60, 120, regions, config);
    return { pass: close(g1Mean, 60, 1e-9) && close(g2Mean, 120, 1e-9), detail: JSON.stringify({ g1Mean, g2Mean }) };
  });

  return results;
}"""


def run_cell_cycle_model_shared_tests(ctx: TestContext):
    """Run models/shared.js assertions and record every result separately."""

    try:
        all_results = ctx.page.evaluate(_MODEL_SHARED_TESTS)
    except Exception as err:
        ctx.check(
            GROUP,
            "cell-cycle model-shared suite setup",
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
