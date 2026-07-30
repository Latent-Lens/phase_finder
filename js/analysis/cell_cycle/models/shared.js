// Shared component builders for the canonical generative cell-cycle models
// (Dean-Jett and Dean-Jett-Fox, which reuse the same G1/G2 peaks and quadratic
// S-phase profile). Pure functions of already-resolved numeric parameters --
// which parameters are free, bounded, or locked (G2:G1 ratio mode, CV mode) is
// an initialization/fit-engine concern, not this module's. Exposes the
// quadratic S-phase profile helpers (quadraticProfile, quadraticProfileMinimum,
// isQuadraticProfileValid, projectQuadraticProfile), the area-parameterized
// G1/G2 peaks (peakComponents), and the broadened S-phase integrators
// (convolvedSPhaseWithProfile and its Dean-Jett specialization convolvedSPhase).
//
// Two deliberate choices: the quadratic S-phase profile is used literally (no
// softplus reparameterization -- an invalid profile is rejected outright, not
// silently clamped positive), and the S-phase integral runs on independent
// fixed-node Gauss-Legendre quadrature rather than on the histogram's own bin
// centers as the latent integration grid.

import { gaussianBinMass, normalCdf } from "../../math/gaussian_bin_mass.js";
import { gaussLegendre } from "../../math/quadrature.js";
import { clamp } from "../../math/stats.js";

const EPS = 1e-12;
export const DEFAULT_S_QUADRATURE_NODES = 64;

/*

Purpose:
	Literal normalized quadratic profile q(z) = a + b·z + c·z^2 with
	a = 1 - b/2 - c/3, so its integral over [0, 1] is 1 for any b, c.

Input:
	z [number]: the latent position in [0, 1]
	b [number]: linear coefficient
	c [number]: quadratic coefficient

Output:
	q [number]: the profile value at z

*/
export function quadraticProfile(z, b, c) {
  const a = 1 - b / 2 - c / 3;
  return a + b * z + c * z * z;
}

/*

Purpose:
	Analytic minimum of q(z) on [0, 1]: checked at both endpoints and, when
	c > 0 and the vertex z = -b/(2c) lies inside (0, 1), at the vertex too (a
	downward-opening or monotonic quadratic's minimum is always at an endpoint).

Input:
	b [number]: linear coefficient
	c [number]: quadratic coefficient

Output:
	minimum [number]: the smallest value of q on [0, 1]

*/
export function quadraticProfileMinimum(b, c) {
  const a = 1 - b / 2 - c / 3;
  let minimum = Math.min(a, a + b + c); // q(0), q(1)
  if (c > 0) {
    const vertexZ = -b / (2 * c);
    if (vertexZ > 0 && vertexZ < 1) {
      minimum = Math.min(minimum, quadraticProfile(vertexZ, b, c));
    }
  }
  return minimum;
}

/*

Purpose:
	Whether q(z) stays nonnegative over [0, 1] -- the explicit rejection rule for
	an invalid S-phase profile.

Input:
	b [number]: linear coefficient
	c [number]: quadratic coefficient

Output:
	valid [boolean]: true when q(z) >= 0 across [0, 1]

*/
export function isQuadraticProfileValid(b, c) {
  return quadraticProfileMinimum(b, c) >= 0;
}

/*

Purpose:
	Projects (b, c) exactly along the ray from the always-valid flat profile.
	For coefficients (t*b,t*c), q_t(z)=1+t*(q(z)-1), so when the proposed
	minimum m is negative, t=1/(1-m) makes the new minimum exactly zero.
	Validity is a joint condition on the pair; no arbitrary coefficient bounds,
	shrink factor, or iterative repair is involved.
	Shared by every model whose latent profile includes this quadratic term
	(Dean-Jett uses it as q(z); Dean-Jett-Fox projects the same (b, c) before
	blending in the wave, since q_F = (1-w)·q + w·T stays nonnegative only when q
	itself does).

Input:
	b [number]: linear coefficient
	c [number]: quadratic coefficient
Output:
	pair [array]: a feasible [b, c], unchanged when already feasible

*/
export function projectQuadraticProfile(b, c) {
  if (!Number.isFinite(b) || !Number.isFinite(c)) {
    throw new RangeError("Quadratic profile coefficients must be finite.");
  }
  const minimum = quadraticProfileMinimum(b, c);
  if (minimum >= 0) return [b, c];
  // Stay a few ulps inside the boundary so recomputing the vertex cannot turn
  // mathematical zero into a tiny negative value through roundoff.
  const scale = (1 - 16 * Number.EPSILON) / (1 - minimum);
  return [b * scale, c * scale];
}

/*

Purpose:
	Projects a proposed (mu1, mu2) jointly onto the feasible set defined by both
	peak regions AND the G2:G1 ratio mode, so the returned pair always satisfies
	every constraint at once (audit SCI-02). The previous per-model version
	clamped mu1 and mu2 to their regions independently and then patched mu2 for
	the ratio, re-clamping it back into the G2 region afterwards -- and that final
	re-clamp could reintroduce a ratio violation (e.g. G1 [1,10], G2 [18,20],
	ratio [1.65,2.25], proposed mu1 = 1 left mu2 = 18 at ratio 18). Here mu1 is
	first confined to the sub-interval of its region for which SOME mu2 in the G2
	region can satisfy the ratio band, then mu2 is clamped into the intersection
	of the G2 region and the ratio band about that mu1 -- feasible by construction
	whenever the regions and ratio are jointly satisfiable (assert_ratio_feasible
	rejects the empty case before fitting; the fallbacks here only guard against a
	caller that skipped that check).

	This is a projection for FEASIBILITY, not the exact Euclidean nearest point:
	it prioritises landing inside every constraint, then stays as close to the
	proposal as each 1-D clamp allows.

Input:
	g1Mean [number]: proposed mu1
	g2Mean [number]: proposed mu2
	regions [object]: { g1:{left,right}, g2:{left,right} } accepted peak regions
	config [object]: { ratioMode: "free"|"bounded"|"locked", fitRatioRange,
	                  lockedRatio }

Output:
	means [object]: { g1Mean, g2Mean } guaranteed to satisfy the active bounds

*/
export function projectMeansToFeasible(g1Mean, g2Mean, regions, config) {
  const g1L = regions.g1.left;
  const g1R = regions.g1.right;
  const g2L = regions.g2.left;
  const g2R = regions.g2.right;

  if (config.ratioMode === "locked") {
    const ratio = config.lockedRatio;
    // mu1 must place BOTH mu1 and ratio*mu1 inside their regions.
    const lo = Math.max(g1L, g2L / ratio);
    const hi = Math.min(g1R, g2R / ratio);
    if (lo > hi) throw new Error(`The locked G2:G1 ratio (${ratio}) is infeasible for the current peak regions.`);
    const mu1 = clamp(g1Mean, lo, hi);
    return { g1Mean: mu1, g2Mean: ratio * mu1 };
  }

  if (config.ratioMode === "bounded") {
    const [ratioMin, ratioMax] = config.fitRatioRange;
    // mu1 values for which some mu2 in [g2L, g2R] satisfies the ratio band:
    //   ratioMin*mu1 <= g2R  and  ratioMax*mu1 >= g2L
    //   => mu1 in [g2L/ratioMax, g2R/ratioMin]
    const mu1Lo = Math.max(g1L, g2L / ratioMax);
    const mu1Hi = Math.min(g1R, g2R / ratioMin);
    if (mu1Lo > mu1Hi) {
      throw new Error(`No G2:G1 ratio in [${ratioMin}, ${ratioMax}] is achievable from the current peak regions.`);
    }
    const mu1 = clamp(g1Mean, mu1Lo, mu1Hi);
    // Given that mu1, the feasible mu2 interval is the region ∩ the ratio band.
    // Nonempty whenever mu1 came from the interval above.
    const mu2Lo = Math.max(g2L, ratioMin * mu1);
    const mu2Hi = Math.min(g2R, ratioMax * mu1);
    const mu2 = clamp(g2Mean, mu2Lo, mu2Hi);
    return { g1Mean: mu1, g2Mean: mu2 };
  }

  // free: each mean clamped to its own region only.
  return { g1Mean: clamp(g1Mean, g1L, g1R), g2Mean: clamp(g2Mean, g2L, g2R) };
}

/*

Purpose:
	Builds the G1 and G2/M peaks as area-parameterized Gaussians integrated
	exactly over each histogram bin, with sigma = CV·mean for each peak
	independently. Equal-CV/locked-ratio behavior is a caller choice (which
	parameters are tied together before calling), never inferred here.

Input:
	edges [array]: histogram bin edges
	parameters [object]: { g1Area, g1Mean, g1CV, g2Area, g2Mean, g2CV }

Output:
	components [object]: { g1Mean, g2Mean, g1Sigma, g2Sigma, g1, g2 } where g1/g2
	                     are the per-bin count arrays

*/
export function peakComponents(edges, { g1Area, g1Mean, g1CV, g2Area, g2Mean, g2CV }) {
  const g1Sigma = Math.max(EPS, Math.abs(g1CV * g1Mean));
  const g2Sigma = Math.max(EPS, Math.abs(g2CV * g2Mean));
  return {
    g1Mean,
    g2Mean,
    g1Sigma,
    g2Sigma,
    g1: gaussianBinMass(edges, g1Area, g1Mean, g1Sigma),
    g2: gaussianBinMass(edges, g2Area, g2Mean, g2Sigma),
  };
}

/*

Purpose:
	Broadened S-phase count per bin, generic over the latent z-occupancy profile.
	Every latent DNA position u(z) = g1Mean + z·(g2Mean-g1Mean), z in [0, 1],
	carries profileFn(z)·dz of occupancy mass and its own CV-scaled Gaussian
	broadening; the per-bin count is the quadrature sum of each node's broadened
	contribution. Evaluates each node's CDF at every bin edge once by sweeping
	edges left to right and reusing the previous edge's value.

Input:
	edges [array]: histogram bin edges
	parameters [object]: { sArea, g1Mean, g2Mean, broadeningCV, profileFn }
	quadratureNodes [number]: Gauss-Legendre node count

Output:
	counts [array]: per-bin S-phase counts (all zero for a non-positive area or
	                g1->g2 span; profileFn's own validity is the caller's concern)

*/
export function convolvedSPhaseWithProfile(
  edges,
  { sArea, g1Mean, g2Mean, broadeningCV, profileFn },
  quadratureNodes = DEFAULT_S_QUADRATURE_NODES,
) {
  const binCount = edges.length - 1;
  const out = new Array(binCount).fill(0);
  const span = g2Mean - g1Mean;
  if (!(sArea > 0) || !(span > 0)) return out;

  const { nodes, weights } = gaussLegendre(quadratureNodes);
  for (let k = 0; k < nodes.length; k += 1) {
    // Rescale this node from [-1, 1] to z in [0, 1] (dz-scale factor 0.5).
    const z = 0.5 * (nodes[k] + 1);
    const weight = 0.5 * weights[k];
    const qz = profileFn(z);
    if (!(qz > 0)) continue;
    const u = g1Mean + z * span;
    const sigma = Math.max(EPS, Math.abs(broadeningCV * u));
    const massScale = sArea * weight * qz;

    let previousCdf = normalCdf(edges[0], u, sigma);
    for (let i = 0; i < binCount; i += 1) {
      const nextCdf = normalCdf(edges[i + 1], u, sigma);
      out[i] += massScale * Math.max(0, nextCdf - previousCdf);
      previousCdf = nextCdf;
    }
  }
  return out;
}

/*

Purpose:
	Dean-Jett S phase: convolvedSPhaseWithProfile specialized to the quadratic
	occupancy profile q(z). Returns all zeros for an invalid quadratic profile in
	addition to the generic non-positive-area/span cases.

Input:
	edges [array]: histogram bin edges
	parameters [object]: { sArea, g1Mean, g2Mean, broadeningCV, b, c }
	quadratureNodes [number]: Gauss-Legendre node count

Output:
	counts [array]: per-bin S-phase counts

*/
export function convolvedSPhase(
  edges,
  { sArea, g1Mean, g2Mean, broadeningCV, b, c },
  quadratureNodes = DEFAULT_S_QUADRATURE_NODES,
) {
  if (!isQuadraticProfileValid(b, c)) return new Array(edges.length - 1).fill(0);
  return convolvedSPhaseWithProfile(
    edges,
    { sArea, g1Mean, g2Mean, broadeningCV, profileFn: (z) => quadraticProfile(z, b, c) },
    quadratureNodes,
  );
}
