// Integrated-Gaussian bin masses for the canonical cell-cycle models: each
// G1/G2 peak is an AREA parameter integrated over each histogram bin, not a
// peak-height Gaussian sampled at bin centers, so bin width and placement can't
// bias the reported component area. Provides erf (an Abramowitz-Stegun
// approximation), the derived normalCdf and closed-form normalPdf, and
// gaussianBinMass, which integrates a scaled Gaussian exactly over each bin.

const EPS = 1e-12;

/*

Purpose:
	Error function via the Abramowitz-Stegun 7.1.26 approximation (max absolute
	error ~1.5e-7) -- adequate for histogram bin integration, where the observed
	counts carry far more noise than this approximation's error.

Input:
	x [number]: the argument

Output:
	erf [number]: the error function value

*/
export function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-ax * ax);
  return sign * y;
}

/*

Purpose:
	Standard-normal cumulative distribution function, built on the erf
	approximation above.

Input:
	x [number]: the point to evaluate at
	mu [number]: the mean (default 0)
	sigma [number]: the standard deviation (default 1; floored at EPS)

Output:
	probability [number]: P(X <= x) for X ~ Normal(mu, sigma)

*/
export function normalCdf(x, mu = 0, sigma = 1) {
  const s = Math.max(Math.abs(sigma), EPS);
  return 0.5 * (1 + erf((x - mu) / (s * Math.SQRT2)));
}

/*

Purpose:
	Closed-form normal probability density (no erf approximation). Paired with
	normalCdf by Dean-Jett-Fox's truncated-normal wave profile, which needs both
	the density and its normalizing mass over [0, 1].

Input:
	x [number]: the point to evaluate at
	mu [number]: the mean (default 0)
	sigma [number]: the standard deviation (default 1; floored at EPS)

Output:
	density [number]: the normal PDF at x

*/
export function normalPdf(x, mu = 0, sigma = 1) {
  const s = Math.max(Math.abs(sigma), EPS);
  const z = (x - mu) / s;
  return Math.exp(-0.5 * z * z) / (s * Math.sqrt(2 * Math.PI));
}

/*

Purpose:
	Expected count per bin for a Gaussian(mu, sigma) peak scaled to total area,
	integrated exactly over each [edges[i], edges[i+1]] bin via the CDF:
	G_i = area * [Phi((b_{i+1}-mu)/sigma) - Phi((b_i-mu)/sigma)]. Returns
	nonnegative, finite counts even for a degenerate (area <= 0 or sigma <= 0) peak.

Input:
	edges [array]: bin edges (length = binCount + 1)
	area [number]: the peak's total area (negative is clamped to 0)
	mu [number]: the peak mean
	sigma [number]: the peak standard deviation (floored at EPS)

Output:
	counts [array]: expected count per bin (length = binCount)

*/
export function gaussianBinMass(edges, area, mu, sigma) {
  const out = new Array(edges.length - 1);
  const a = Math.max(0, area);
  const s = Math.max(Math.abs(sigma), EPS);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = a * Math.max(0, normalCdf(edges[i + 1], mu, s) - normalCdf(edges[i], mu, s));
  }
  return out;
}
