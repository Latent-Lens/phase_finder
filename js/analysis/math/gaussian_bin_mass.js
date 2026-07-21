// Integrated-Gaussian bin masses for the canonical cell-cycle models (plan
// §5.2): each G1/G2 peak is an area parameter integrated over each histogram
// bin, not a peak-height Gaussian sampled at bin centers, so bin width and
// placement can't bias the reported component area.

const EPS = 1e-12;

// Abramowitz-Stegun 7.1.26 approximation (max absolute error ~1.5e-7),
// ported from the reference archive -- adequate for histogram bin
// integration, where the observed counts themselves carry far more noise
// than this approximation's error.
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

/** Standard normal CDF via the erf approximation above. */
export function normalCdf(x, mu = 0, sigma = 1) {
  const s = Math.max(Math.abs(sigma), EPS);
  return 0.5 * (1 + erf((x - mu) / (s * Math.SQRT2)));
}

/**
 * Expected count per bin for a Gaussian(mu, sigma) peak scaled to total area
 * `area`, integrated exactly (via the CDF) over each [edges[i], edges[i+1]]
 * bin: G_i = area * [Phi((b_{i+1}-mu)/sigma) - Phi((b_i-mu)/sigma)].
 * Returns nonnegative, finite counts even for a degenerate (area<=0 or
 * sigma<=0) peak.
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
