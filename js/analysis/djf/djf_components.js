// Shared Dean-Jett-Fox base-model component evaluators.

export const PARAMETER_INDEX = Object.freeze({
  MU1: 0,
  R: 1,
  SIGMA1: 2,
  SIGMA2: 3,
  A1: 4,
  A2: 5,
  S0: 6,
  S1: 7,
  S2: 8,
});

/** Gaussian parameterized by peak height (the DJF A1/A2 convention). */
export function gaussianPeak(xValue, mu, sigma, amplitude) {
  if (!(sigma > 0) || !Number.isFinite(sigma) || !(amplitude > 0)) return 0;
  const z = (xValue - mu) / sigma;
  return amplitude * Math.exp(-0.5 * z * z);
}

/** Nonnegative Bernstein-polynomial bridge, tapered to zero at G1 and G2. */
export function evaluateSBridge(xValue, mu1, mu2, s0, s1, s2) {
  if (!(mu2 > mu1) || xValue <= mu1 || xValue >= mu2) return 0;

  const t = (xValue - mu1) / (mu2 - mu1);
  const oneMinusT = 1 - t;
  const positivePolynomial =
    s0 * oneMinusT * oneMinusT +
    2 * s1 * t * oneMinusT +
    s2 * t * t;

  return 4 * t * oneMinusT * positivePolynomial;
}

/** Evaluate G1 + S + G2 at one DNA-axis position. */
export function evaluateBaseAt(
  xValue,
  parameters,
  index = PARAMETER_INDEX,
) {
  const mu1 = parameters[index.MU1];
  const ratio = parameters[index.R];
  const mu2 = ratio * mu1;

  const g1 = gaussianPeak(
    xValue,
    mu1,
    parameters[index.SIGMA1],
    parameters[index.A1],
  );
  const s = evaluateSBridge(
    xValue,
    mu1,
    mu2,
    parameters[index.S0],
    parameters[index.S1],
    parameters[index.S2],
  );
  const g2 = gaussianPeak(
    xValue,
    mu2,
    parameters[index.SIGMA2],
    parameters[index.A2],
  );

  return { g1, s, g2, total: g1 + s + g2 };
}

/** Evaluate the base model across an array-like x axis. */
export function evaluateBaseModel(x, parameters, index = PARAMETER_INDEX) {
  const g1 = new Array(x.length);
  const s = new Array(x.length);
  const g2 = new Array(x.length);
  const fitted = new Array(x.length);

  for (let bin = 0; bin < x.length; bin += 1) {
    const value = evaluateBaseAt(x[bin], parameters, index);
    g1[bin] = value.g1;
    s[bin] = value.s;
    g2[bin] = value.g2;
    fitted[bin] = value.total;
  }

  return { g1, s, g2, fitted };
}

export const evaluateModel = evaluateBaseModel;
