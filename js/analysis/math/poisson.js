// Poisson fit statistics and residual diagnostics shared by every canonical
// cell-cycle model (plan §5.1): raw integer histogram counts are fit
// directly (never smoothed counts), so the observation model is Poisson, not
// Gaussian/SSE. Ported/adapted from the reference archive's math.js and
// diagnostics.js pure-numeric helpers -- these formulas aren't affected by
// the archive's softplus/histogram-grid choices the plan replaces elsewhere.

const EPS = 1e-12;

/** Poisson log-likelihood (log(y!) term omitted -- it cancels in model comparisons). */
export function poissonLogLikelihood(observed, expected) {
  if (observed.length !== expected.length) {
    throw new Error("Observed and expected must have the same length.");
  }
  let ll = 0;
  for (let i = 0; i < observed.length; i += 1) {
    const y = Math.max(0, observed[i]);
    const mu = Math.max(EPS, expected[i]);
    ll += y * Math.log(mu) - mu;
  }
  return ll;
}

/** Negative log-likelihood -- the quantity the optimizer minimizes. */
export function poissonNll(observed, expected) {
  return -poissonLogLikelihood(observed, expected);
}

/** Total Poisson deviance: sum of each bin's deviance contribution. */
export function poissonDeviance(observed, expected) {
  let deviance = 0;
  for (let i = 0; i < observed.length; i += 1) {
    const y = Math.max(0, observed[i]);
    const mu = Math.max(EPS, expected[i]);
    deviance += y === 0 ? 2 * mu : 2 * (y * Math.log(y / mu) - (y - mu));
  }
  return deviance;
}

/** Pearson residual per bin: (y - mu) / sqrt(mu). */
export function pearsonResiduals(observed, expected) {
  return observed.map((value, i) => (value - expected[i]) / Math.sqrt(Math.max(EPS, expected[i])));
}

/**
 * Signed deviance residual per bin -- sign(y-mu) * sqrt(that bin's deviance
 * contribution) -- so summing their squares reproduces the total deviance.
 */
export function poissonDevianceResiduals(observed, expected) {
  return observed.map((value, i) => {
    const y = Math.max(0, value);
    const mu = Math.max(EPS, expected[i]);
    const contribution = y === 0 ? 2 * mu : 2 * (y * Math.log(y / mu) - (y - mu));
    return Math.sign(y - mu) * Math.sqrt(Math.max(0, contribution));
  });
}

/** Lag-1 autocorrelation of a residual sequence; NaN when fewer than 3 values. */
export function lag1Autocorrelation(values) {
  if (values.length < 3) return NaN;
  let m = 0;
  for (const value of values) m += value;
  m /= values.length;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < values.length - 1; i += 1) numerator += (values[i] - m) * (values[i + 1] - m);
  for (const value of values) denominator += (value - m) ** 2;
  return denominator > EPS ? numerator / denominator : 0;
}

/**
 * Wald-Wolfowitz runs-test z-score for a residual sequence's signs: how many
 * contiguous same-sign runs occur versus the number expected under a random
 * (structure-free) arrangement. A strongly negative z means residual signs
 * cluster into long runs -- systematic under/over-fit regions, not just
 * noise. NaN when there are too few nonzero-sign residuals to test;
 * -Infinity when every residual shares one sign (the most extreme possible
 * clustering).
 */
export function runsTestZ(values) {
  const signs = values.filter((value) => value !== 0).map((value) => (value > 0 ? 1 : -1));
  if (signs.length < 4) return NaN;
  const nPos = signs.filter((value) => value > 0).length;
  const nNeg = signs.length - nPos;
  if (!nPos || !nNeg) return -Infinity;
  let runs = 1;
  for (let i = 1; i < signs.length; i += 1) if (signs[i] !== signs[i - 1]) runs += 1;
  const expected = 1 + (2 * nPos * nNeg) / (nPos + nNeg);
  const variance = (2 * nPos * nNeg * (2 * nPos * nNeg - nPos - nNeg))
    / (((nPos + nNeg) ** 2) * (nPos + nNeg - 1));
  return variance > EPS ? (runs - expected) / Math.sqrt(variance) : NaN;
}
