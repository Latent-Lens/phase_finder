// Shared component evaluators for the legacy bridge model. gaussianPeak is a
// peak-height Gaussian (the A1/A2 convention); evaluateSBridge is the
// nonnegative Bernstein-polynomial S bridge tapered to zero at G1/G2;
// evaluateBaseAt sums G1 + S + G2 at one DNA-axis position and evaluateBaseModel
// sweeps that across an x axis (aliased as evaluateModel).

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

/*

Purpose:
	A Gaussian parameterized by its peak height (the A1/A2 convention), not area.

Input:
	xValue [number]: the point to evaluate at
	mu [number]: the peak center
	sigma [number]: the standard deviation (must be finite and > 0)
	amplitude [number]: the peak height (must be > 0)

Output:
	value [number]: the Gaussian value, or 0 for a degenerate sigma/amplitude

*/
export function gaussianPeak(xValue, mu, sigma, amplitude) {
  if (!(sigma > 0) || !Number.isFinite(sigma) || !(amplitude > 0)) return 0;
  const z = (xValue - mu) / sigma;
  return amplitude * Math.exp(-0.5 * z * z);
}

/*

Purpose:
	The nonnegative Bernstein-polynomial S bridge, tapered to zero at G1 and G2.

Input:
	xValue [number]: the DNA-axis position
	mu1 [number]: the G1 mean
	mu2 [number]: the G2 mean
	s0 [number]: bridge coefficient at G1
	s1 [number]: bridge coefficient at the midpoint
	s2 [number]: bridge coefficient at G2

Output:
	value [number]: the bridge height at xValue (0 outside (mu1, mu2))

*/
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

/*

Purpose:
	Evaluates G1 + S + G2 at one DNA-axis position.

Input:
	xValue [number]: the DNA-axis position
	parameters [array]: the model parameter vector
	index [object]: parameter-index map (defaults to PARAMETER_INDEX)

Output:
	value [object]: { g1, s, g2, total } at xValue

*/
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

/*

Purpose:
	Evaluates the base model across an array-like x axis.

Input:
	x [array]: the x-axis positions
	parameters [array]: the model parameter vector
	index [object]: parameter-index map (defaults to PARAMETER_INDEX)

Output:
	curves [object]: { g1, s, g2, fitted } arrays, one value per x

*/
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
