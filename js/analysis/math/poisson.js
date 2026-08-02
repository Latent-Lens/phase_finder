// Poisson fit statistics and residual diagnostics shared by every canonical
// cell-cycle model: raw integer histogram counts are fit directly (never
// smoothed counts), so the observation model is Poisson, not Gaussian/SSE.
// Provides the likelihood terms the optimizer minimizes (poissonLogLikelihood,
// poissonNll), goodness-of-fit measures (poissonDeviance), per-bin residuals
// (pearsonResiduals, poissonDevianceResiduals), and residual-structure tests
// used to detect systematic under/over-fit (lag1Autocorrelation, runsTestZ).
// Ported/adapted from the reference archive's pure-numeric helpers.

const EPS = 1e-12;

// STAT-01: expected counts come from bin-mass integrals and Gauss-Legendre
// quadrature, both of which can land a few ulps below zero on a component whose
// true mass is ~0. That round-off is absorbed (clamped to 0); anything more
// negative than this is a real modelling error and is REJECTED rather than
// silently clamped, which is what `Math.max(0, ...)` used to do.
const NEGATIVE_ROUNDOFF_TOLERANCE = 1e-9;

export const POISSON_INPUT_INVALID = "poisson_input_invalid";

/*

Purpose:
	The structured error every Poisson statistic throws on an input it cannot
	honestly evaluate. Carries a machine-readable `code` plus a `detail` naming
	the offending array, index, and value, so a caller can surface exactly which
	bin broke rather than propagating a NaN into a reported statistic.

*/
export class PoissonInputError extends RangeError {
  constructor(message, detail) {
    super(message);
    this.name = "PoissonInputError";
    this.code = POISSON_INPUT_INVALID;
    this.detail = detail;
  }
}

function assert_counts(values, role, length, { allowNegativeRoundoff }) {
  if (values == null || typeof values.length !== "number") {
    throw new PoissonInputError(`${role} counts must be an array or typed array.`, { role, reason: "not_array_like" });
  }
  if (length != null && values.length !== length) {
    throw new PoissonInputError(
      "Observed and expected must have the same length.",
      { role, reason: "length_mismatch", length: values.length, expectedLength: length },
    );
  }
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!Number.isFinite(value)) {
      throw new PoissonInputError(
        `${role} count at bin ${index} is ${value} — Poisson statistics require finite counts.`,
        { role, reason: "nonfinite", index, value },
      );
    }
    const floor = allowNegativeRoundoff ? -NEGATIVE_ROUNDOFF_TOLERANCE : 0;
    if (value < floor) {
      throw new PoissonInputError(
        `${role} count at bin ${index} is ${value} — Poisson statistics require non-negative counts.`,
        { role, reason: "negative", index, value },
      );
    }
  }
}

/*

Purpose:
	STAT-01 input gate for every Poisson statistic below. Rejects non-finite or
	negative observed counts and non-finite or materially negative expected
	counts with a structured PoissonInputError, so an invalid histogram or a
	broken model evaluation fails loudly at the boundary instead of silently
	becoming a clamped (or NaN) likelihood, deviance, or residual.

Input:
	observed [array]: observed integer counts per bin
	expected [array]: expected (model) means per bin

Output:
	(none) [void]: returns normally when both inputs are valid, throws otherwise

*/
export function validatePoissonCounts(observed, expected) {
  assert_counts(observed, "Observed", null, { allowNegativeRoundoff: false });
  assert_counts(expected, "Expected", observed.length, { allowNegativeRoundoff: true });
}

// Lanczos log-gamma (g=7). JavaScript has no native lgamma; this supplies the
// standard Poisson log(y!) term without factorial overflow.
export function logGamma(value) {
  const coefficients = [
    0.9999999999998099, 676.5203681218851, -1259.1392167224028,
    771.3234287776531, -176.6150291621406, 12.507343278686905,
    -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7,
  ];
  if (value < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  const z = value - 1;
  let series = coefficients[0];
  for (let index = 1; index < coefficients.length; index += 1) series += coefficients[index] / (z + index);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(series);
}

/*

Purpose:
	Standard absolute Poisson log-likelihood, including log(y!), so values match
	external statistical tools when evaluated on the same observations.

Input:
	observed [array]: observed integer counts per bin
	expected [array]: expected (model) means per bin, same length as observed

Output:
	logLikelihood [number]: the summed log-likelihood

*/
export function poissonLogLikelihood(observed, expected) {
  validatePoissonCounts(observed, expected);
  let ll = 0;
  for (let i = 0; i < observed.length; i += 1) {
    // Non-negative and finite by validatePoissonCounts above; the only floor
    // left is EPS on mu, so log(0) cannot appear for an empty modelled bin.
    const y = observed[i];
    const mu = Math.max(EPS, expected[i]);
    ll += y * Math.log(mu) - mu - logGamma(y + 1);
  }
  return ll;
}

/*

Purpose:
	Negative Poisson log-likelihood -- the scalar the optimizer minimizes.

Input:
	observed [array]: observed counts per bin
	expected [array]: expected means per bin

Output:
	nll [number]: -poissonLogLikelihood(observed, expected)

*/
export function poissonNll(observed, expected) {
  return -poissonLogLikelihood(observed, expected);
}

/*

Purpose:
	Total Poisson deviance: the sum of each bin's deviance contribution, a
	goodness-of-fit measure that is zero for a perfect fit.

Input:
	observed [array]: observed counts per bin
	expected [array]: expected means per bin

Output:
	deviance [number]: the total deviance

*/
export function poissonDeviance(observed, expected) {
  validatePoissonCounts(observed, expected);
  let deviance = 0;
  for (let i = 0; i < observed.length; i += 1) {
    const y = observed[i];
    const mu = Math.max(EPS, expected[i]);
    deviance += y === 0 ? 2 * mu : 2 * (y * Math.log(y / mu) - (y - mu));
  }
  return deviance;
}

/*

Purpose:
	Pearson residual per bin, (y - mu) / sqrt(mu).

Input:
	observed [array]: observed counts per bin
	expected [array]: expected means per bin

Output:
	residuals [array]: the per-bin Pearson residuals

*/
export function pearsonResiduals(observed, expected) {
  validatePoissonCounts(observed, expected);
  return Array.from(observed, (value, i) => (value - expected[i]) / Math.sqrt(Math.max(EPS, expected[i])));
}

/*

Purpose:
	Signed deviance residual per bin -- sign(y - mu) times the square root of the
	bin's deviance contribution -- so the sum of their squares reproduces the
	total deviance.

Input:
	observed [array]: observed counts per bin
	expected [array]: expected means per bin

Output:
	residuals [array]: the per-bin signed deviance residuals

*/
export function poissonDevianceResiduals(observed, expected) {
  validatePoissonCounts(observed, expected);
  return Array.from(observed, (value, i) => {
    const y = value;
    const mu = Math.max(EPS, expected[i]);
    const contribution = y === 0 ? 2 * mu : 2 * (y * Math.log(y / mu) - (y - mu));
    return Math.sign(y - mu) * Math.sqrt(Math.max(0, contribution));
  });
}

/*

Purpose:
	Lag-1 autocorrelation of a residual sequence -- how much each residual
	predicts the next -- as one signal of leftover structure in a fit.

Input:
	values [array]: the residual sequence, in bin order

Output:
	autocorrelation [number]: the lag-1 autocorrelation, or NaN for fewer than 3 values

*/
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

/*

Purpose:
	Wald-Wolfowitz runs-test z-score for a residual sequence's signs: how many
	contiguous same-sign runs occur versus the number expected under a random,
	structure-free arrangement. A strongly negative z means residual signs
	cluster into long runs -- systematic under/over-fit regions, not just noise.

Input:
	values [array]: the residual sequence, in bin order

Output:
	z [number]: the runs-test z-score; NaN when too few nonzero-sign residuals
	            exist to test, and -Infinity when every residual shares one sign
	            (the most extreme possible clustering)

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
