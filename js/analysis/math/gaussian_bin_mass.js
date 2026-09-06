// Integrated-Gaussian bin masses for the canonical cell-cycle models: each
// G1/G2 peak is an AREA parameter integrated over each histogram bin, not a
// peak-height Gaussian sampled at bin centers, so bin width and placement can't
// bias the reported component area. Provides erf (an Abramowitz-Stegun
// approximation), the derived normalCdf, its inverse inverseStandardNormalCdf
// (Acklam's probit), the closed-form normalPdf, and gaussianBinMass, which
// integrates a scaled Gaussian exactly over each bin.

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
	Inverse standard-normal CDF (the probit) via Acklam's rational
	approximation, accurate to ~1.15e-9 in absolute value over the whole
	open interval -- roughly two orders of magnitude tighter than the erf
	approximation normalCdf above is built on, so round-tripping a probability
	through normalCdf and back is limited by erf, not by this.

	It lives beside normalCdf because it is that function's inverse: the two are
	used together wherever a probability has to be turned into a z-score (a
	bias-corrected bootstrap endpoint) or back (a truncated-normal draw).

Input:
	p [number]: a probability; p <= 0 returns -Infinity and p >= 1 returns
	            +Infinity rather than throwing, so a saturated empirical
	            proportion degrades to an infinite endpoint the caller can test
	            for instead of a NaN it cannot

Output:
	z [number]: the standard-normal quantile at p

*/
export function inverseStandardNormalCdf(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q;
  let r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
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
