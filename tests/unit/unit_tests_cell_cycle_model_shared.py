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
    quadraticProfile, quadraticProfileMinimum, isQuadraticProfileValid,
    peakComponents, convolvedSPhase,
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

  // ---- quadraticProfile / validity ------------------------------------------
  run('quadraticProfile integrates to 1 over [0,1] for arbitrary b, c', () => {
    const b = 1.4, c = -0.6;
    const integral = integrateGaussLegendre((z) => quadraticProfile(z, b, c), 0, 1, 64);
    return { pass: close(integral, 1, 1e-9), detail: integral };
  });

  run('quadraticProfile(z, 0, 0) is the flat profile q=1 everywhere', () => {
    const values = [0, 0.25, 0.5, 0.75, 1].map((z) => quadraticProfile(z, 0, 0));
    return { pass: values.every((value) => close(value, 1, 1e-12)), detail: values };
  });

  run('quadraticProfileMinimum finds the interior vertex when c>0 and it lies in [0,1]', () => {
    // b=-2, c=2 gives a=1-(-1)-2/3=4/3, vertex z=-b/2c=0.5, q(0.5)=4/3-1+0.5=5/6.
    const value = quadraticProfileMinimum(-2, 2);
    return { pass: close(value, 5 / 6, 1e-9), detail: value };
  });

  run('quadraticProfileMinimum ignores a vertex outside [0,1] (uses endpoints)', () => {
    // b=-10, c=2 has vertex z=2.5, outside [0,1], so the minimum is at an endpoint.
    const a = 1 - (-10) / 2 - 2 / 3;
    const q0 = a;
    const q1 = a - 10 + 2;
    const value = quadraticProfileMinimum(-10, 2);
    return { pass: close(value, Math.min(q0, q1), 1e-9), detail: { value, q0, q1 } };
  });

  run('isQuadraticProfileValid accepts the flat profile and rejects a profile that dips negative', () => {
    const flatOk = isQuadraticProfileValid(0, 0);
    // b=0, c=-6 (downward-opening, so the vertex check doesn't apply -- its
    // minimum is at an endpoint): a=1-0-(-2)=3, q(0)=3, q(1)=3+0-6=-3.
    const bBad = 0, cBad = -6;
    const badRejected = isQuadraticProfileValid(bBad, cBad) === false;
    return {
      pass: flatOk === true && badRejected,
      detail: { flatOk, minimum: quadraticProfileMinimum(bBad, cBad) },
    };
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
  run('convolvedSPhase is all-zero when the quadratic profile is invalid', () => {
    const edges = evenEdges(0, 400, 400);
    // b=0, c=-6: q(1) = -3 < 0 (see the isQuadraticProfileValid test above).
    const out = convolvedSPhase(edges, {
      sArea: 1000, g1Mean: 70, g2Mean: 140, broadeningCV: 0.08, b: 0, c: -6,
    });
    return { pass: out.every((value) => value === 0), detail: sum(out) };
  });

  run('convolvedSPhase is all-zero when g2Mean does not exceed g1Mean', () => {
    const edges = evenEdges(0, 400, 400);
    const out = convolvedSPhase(edges, {
      sArea: 1000, g1Mean: 140, g2Mean: 140, broadeningCV: 0.08, b: 0, c: 0,
    });
    return { pass: out.every((value) => value === 0), detail: sum(out) };
  });

  run('convolvedSPhase over a wide domain recovers essentially all of sArea', () => {
    const edges = evenEdges(-50, 250, 1200);
    const out = convolvedSPhase(edges, {
      sArea: 5000, g1Mean: 70, g2Mean: 140, broadeningCV: 0.08, b: 0.3, c: -0.2,
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
      sArea: 10000, g1Mean, g2Mean, broadeningCV: 0.03, b: 0, c: 0,
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
    const params = { sArea: 3000, g1Mean: 70, g2Mean: 140, broadeningCV: 0.08, b: 0.4, c: -0.3 };
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
