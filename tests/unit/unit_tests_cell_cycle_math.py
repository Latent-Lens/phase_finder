#!/usr/bin/env python3
"""Browser unit coverage for the canonical cell-cycle model math primitives
(js/analysis/math/gaussian_bin_mass.js, quadrature.js, poisson.js).

These are the numerical building blocks the Dean-Jett model (M3) is built
from: integrated Gaussian bin masses, fixed-node Gauss-Legendre quadrature
(independent of histogram resolution, per the modeling plan §5.3), and the
Poisson deviance/residual statistics used for both fitting and diagnostics.
Each is verified against closed-form results or internal self-consistency
checks, not just "does it run"."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / Cell Cycle Math"


_MATH_TESTS = r"""() => {
  const { erf, normalCdf, gaussianBinMass } = window.CellCycleGaussianBinMass;
  const { gaussLegendre, integrateGaussLegendre } = window.CellCycleQuadrature;
  const {
    poissonLogLikelihood, poissonNll, poissonDeviance,
    pearsonResiduals, poissonDevianceResiduals,
    lag1Autocorrelation, runsTestZ,
  } = window.CellCyclePoisson;
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

  // ---- gaussian_bin_mass.js -----------------------------------------------
  run('normalCdf(mu, mu, sigma) is exactly 0.5', () => {
    const value = normalCdf(5, 5, 2);
    return { pass: close(value, 0.5, 1e-9), detail: value };
  });

  run('normalCdf matches the standard normal table at z=1 and z=2', () => {
    const z1 = normalCdf(1, 0, 1);
    const z2 = normalCdf(2, 0, 1);
    return {
      pass: close(z1, 0.8413447, 1e-6) && close(z2, 0.9772499, 1e-6),
      detail: { z1, z2 },
    };
  });

  run('normalCdf is symmetric about the mean', () => {
    const mu = 3, sigma = 1.5, x = 2.1;
    const below = normalCdf(mu - x, mu, sigma);
    const above = normalCdf(mu + x, mu, sigma);
    return { pass: close(below + above, 1, 1e-9), detail: { below, above } };
  });

  run('erf is odd: erf(-x) = -erf(x)', () => {
    const x = 0.837;
    return { pass: close(erf(-x), -erf(x), 1e-12), detail: { pos: erf(x), neg: erf(-x) } };
  });

  run('gaussianBinMass over a wide domain recovers essentially all of the area', () => {
    const mu = 100, sigma = 10, area = 5000;
    const edges = Array.from({ length: 201 }, (_, i) => mu - 10 * sigma + i * sigma / 10);
    const masses = gaussianBinMass(edges, area, mu, sigma);
    const total = sum(masses);
    return { pass: close(total, area, area * 1e-6), detail: { total, area } };
  });

  run('gaussianBinMass with area<=0 returns an all-zero array', () => {
    const edges = [0, 1, 2, 3, 4];
    const masses = gaussianBinMass(edges, -5, 2, 1);
    return { pass: masses.every((value) => value === 0), detail: masses };
  });

  run('gaussianBinMass has one entry per bin and every entry is finite and nonnegative', () => {
    const edges = [0, 1, 2, 3, 4, 5];
    const masses = gaussianBinMass(edges, 1000, 2.5, 0.8);
    return {
      pass: masses.length === edges.length - 1
        && masses.every((value) => Number.isFinite(value) && value >= 0),
      detail: masses,
    };
  });

  // ---- quadrature.js --------------------------------------------------------
  run('gaussLegendre(n) node/weight arrays sum weights to the interval length 2', () => {
    const { nodes, weights } = gaussLegendre(16);
    return {
      pass: nodes.length === 16 && weights.length === 16 && close(sum(weights), 2, 1e-10),
      detail: sum(weights),
    };
  });

  run('gaussLegendre nodes lie strictly inside [-1, 1] and are sorted ascending', () => {
    const { nodes } = gaussLegendre(32);
    const inRange = nodes.every((x) => x > -1 && x < 1);
    const sorted = nodes.every((x, i) => i === 0 || x >= nodes[i - 1]);
    return { pass: inRange && sorted, detail: { first: nodes[0], last: nodes[nodes.length - 1] } };
  });

  run('n-point Gauss-Legendre integrates polynomials of degree <= 2n-1 exactly', () => {
    // 8 nodes are exact through degree 15; z^10 is comfortably inside that.
    const exact = 1 / 11; // integral of z^10 over [0, 1]
    const value = integrateGaussLegendre((z) => z ** 10, 0, 1, 8);
    return { pass: close(value, exact, 1e-10), detail: { value, exact } };
  });

  run('integrateGaussLegendre matches a closed-form transcendental integral', () => {
    // integral of e^z over [0, 1] = e - 1
    const exact = Math.E - 1;
    const value = integrateGaussLegendre((z) => Math.exp(z), 0, 1, 64);
    return { pass: close(value, exact, 1e-10), detail: { value, exact } };
  });

  run('64- and 128-node quadrature agree to near machine precision for a smooth integrand', () => {
    const fn = (z) => Math.exp(-((z - 0.4) ** 2) / (2 * 0.05 ** 2));
    const v64 = integrateGaussLegendre(fn, 0, 1, 64);
    const v128 = integrateGaussLegendre(fn, 0, 1, 128);
    return { pass: close(v64, v128, 1e-10), detail: { v64, v128, diff: Math.abs(v64 - v128) } };
  });

  run('integrateGaussLegendre returns 0 for a degenerate (empty) domain', () => {
    const value = integrateGaussLegendre((z) => 1 / (z + 1), 3, 3, 64);
    const valueInverted = integrateGaussLegendre((z) => 1, 3, 1, 64);
    return { pass: value === 0 && valueInverted === 0, detail: { value, valueInverted } };
  });

  // ---- poisson.js -----------------------------------------------------------
  run('poissonDeviance is exactly 0 for a perfect (nonzero-count) fit', () => {
    const observed = [5, 12, 30, 7];
    const value = poissonDeviance(observed, observed);
    return { pass: close(value, 0, 1e-9), detail: value };
  });

  run('poissonNll is the negation of poissonLogLikelihood', () => {
    const observed = [3, 8, 15];
    const expected = [4, 7, 16];
    const ll = poissonLogLikelihood(observed, expected);
    const nll = poissonNll(observed, expected);
    return { pass: close(ll, -nll, 1e-9), detail: { ll, nll } };
  });

  run('poissonLogLikelihood/poissonNll reject mismatched-length inputs', () => {
    let threw = false;
    try { poissonLogLikelihood([1, 2], [1, 2, 3]); } catch (_) { threw = true; }
    return { pass: threw, detail: 'expected a length-mismatch error' };
  });

  run('sum of squared deviance residuals reproduces the total Poisson deviance', () => {
    const observed = [0, 4, 9, 20, 3];
    const expected = [1.2, 5.5, 8.1, 18.4, 4.9];
    const total = poissonDeviance(observed, expected);
    const residuals = poissonDevianceResiduals(observed, expected);
    const fromResiduals = sum(residuals.map((value) => value * value));
    return { pass: close(total, fromResiduals, 1e-9), detail: { total, fromResiduals } };
  });

  run('pearsonResiduals sign matches observed-vs-expected direction', () => {
    const observed = [10, 2];
    const expected = [5, 6];
    const [over, under] = pearsonResiduals(observed, expected);
    return { pass: over > 0 && under < 0, detail: { over, under } };
  });

  run('lag1Autocorrelation of a constant sequence is 0 (zero variance, not NaN)', () => {
    const value = lag1Autocorrelation([4, 4, 4, 4, 4]);
    return { pass: value === 0, detail: value };
  });

  run('lag1Autocorrelation of a perfectly alternating sequence matches its closed form -(n-1)/n', () => {
    // numerator sums n-1 adjacent products (all -1 here); denominator sums
    // all n squared terms (all 1) -- so the exact value is -(n-1)/n, not -1
    // (that's only the limit as n -> infinity), for this formula's biased
    // (n, not n-1) denominator normalization.
    const values = [1, -1, 1, -1, 1, -1, 1, -1];
    const value = lag1Autocorrelation(values);
    const exact = -(values.length - 1) / values.length;
    return { pass: close(value, exact, 1e-9), detail: { value, exact } };
  });

  run('lag1Autocorrelation returns NaN for fewer than 3 values', () => {
    const value = lag1Autocorrelation([1, 2]);
    return { pass: Number.isNaN(value), detail: value };
  });

  run('runsTestZ returns NaN with too few nonzero-sign residuals', () => {
    const value = runsTestZ([1, -1, 0]);
    return { pass: Number.isNaN(value), detail: value };
  });

  run('runsTestZ is -Infinity when every residual shares one sign (maximal clustering)', () => {
    const value = runsTestZ([1, 2, 3, 4, 5]);
    return { pass: value === -Infinity, detail: value };
  });

  run('runsTestZ is strongly positive for a perfectly alternating (maximally split) sequence', () => {
    const value = runsTestZ([1, -1, 1, -1, 1, -1, 1, -1]);
    return { pass: Number.isFinite(value) && value > 2, detail: value };
  });

  run('runsTestZ is strongly negative for two long same-sign runs (clustered residuals)', () => {
    const value = runsTestZ([1, 1, 1, 1, -1, -1, -1, -1]);
    return { pass: Number.isFinite(value) && value < -1, detail: value };
  });

  return results;
}"""


def run_cell_cycle_math_tests(ctx: TestContext):
    """Run cell-cycle math-primitive assertions and record every result separately."""

    try:
        all_results = ctx.page.evaluate(_MATH_TESTS)
    except Exception as err:
        ctx.check(
            GROUP,
            "cell-cycle math suite setup",
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
