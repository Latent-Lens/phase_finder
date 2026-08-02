// Shared component builders for the canonical generative cell-cycle models
// (Dean-Jett and Dean-Jett-Fox, which reuse the same G1/G2 peaks and quadratic
// S-phase profile). Pure functions of already-resolved numeric parameters --
// which parameters are free, bounded, or locked (G2:G1 ratio mode, CV mode) is
// an initialization/fit-engine concern, not this module's. Exposes the
// Bernstein S-phase profile helpers (sPhaseProfileWeights, sPhaseProfile,
// sPhaseProfileMinimum), the area-parameterized
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

// ---------------------------------------------------------------------------
// S-phase occupancy profile q(z), z in [0, 1].
//
// SCI-07/SCI-08: expressed in the quadratic BERNSTEIN basis
//
//     q(z) = w0*(1-z)^2 + 2*w1*z*(1-z) + w2*z^2
//
// which is nonnegative across [0, 1] for ANY nonnegative weights -- the
// nonnegativity constraint is satisfied BY CONSTRUCTION rather than repaired
// after the fact. The previous direct form q(z) = a + b*z + c*z^2 could go
// negative mid-optimization and needed projectQuadraticProfile() to pull it
// back, which put a nonsmooth repair inside the optimizer's search surface.
// This is the form the reference DJF implementation specifies
// (docs/audits/baselines/dean_jett_fox_javascript_implementation.html §3).
//
// The two free shape parameters are unconstrained real numbers mapped through a
// softmax, so the weights are strictly positive and sum to PROFILE_WEIGHT_SUM:
//
//     (v0, v1, v2) = (1, exp(shape1), exp(shape2))
//     w_i          = 3 * v_i / (v0 + v1 + v2)
//
// The 3 makes integral(q) over [0, 1] exactly 1 for every (shape1, shape2), so q
// is a density and the S component's area parameter IS its area -- the same
// contract the previous parameterization provided. (0, 0) gives w = (1, 1, 1),
// i.e. the flat profile q(z) = 1, so the neutral start is still the origin.
// ---------------------------------------------------------------------------

// Weights sum to 3 because integral over [0,1] of the Bernstein basis is 1/3 each.
export const PROFILE_WEIGHT_SUM = 3;

// The shape logits are bounded so the softmax cannot underflow a weight to
// exactly zero. At +-30 the extreme weight ratio is e^60 ~ 1e26, far beyond any
// physically meaningful S-phase occupancy contrast, while every weight stays
// comfortably above the float64 floor -- so "strictly positive" is a property
// the parameterization actually guarantees rather than one it usually has.
// A concentrated cohort is what the Fox wave term models; it is not this
// polynomial's job to represent one.
export const PROFILE_SHAPE_LIMIT = 30;

/*

Purpose:
	The three Bernstein weights for a shape pair: strictly positive and summing
	to PROFILE_WEIGHT_SUM, via a numerically stable softmax (the max is
	subtracted before exponentiating so a large shape value cannot overflow).

Input:
	shape1 [number]: unconstrained logit controlling the mid-S weight
	shape2 [number]: unconstrained logit controlling the late-S weight

Output:
	weights [array]: [w0, w1, w2] -- density near G1, mid S, and near G2/M

*/
export function sPhaseProfileWeights(shape1, shape2) {
  if (!Number.isFinite(shape1) || !Number.isFinite(shape2)) {
    throw new RangeError("S-phase profile shape parameters must be finite.");
  }
  const s1 = Math.min(PROFILE_SHAPE_LIMIT, Math.max(-PROFILE_SHAPE_LIMIT, shape1));
  const s2 = Math.min(PROFILE_SHAPE_LIMIT, Math.max(-PROFILE_SHAPE_LIMIT, shape2));
  const largest = Math.max(0, s1, s2);
  const v0 = Math.exp(-largest);
  const v1 = Math.exp(s1 - largest);
  const v2 = Math.exp(s2 - largest);
  const total = v0 + v1 + v2;
  return [
    (PROFILE_WEIGHT_SUM * v0) / total,
    (PROFILE_WEIGHT_SUM * v1) / total,
    (PROFILE_WEIGHT_SUM * v2) / total,
  ];
}

/*

Purpose:
	The S-phase occupancy density q(z) at one latent position.

Input:
	z [number]: the latent position in [0, 1]
	shape1 [number]: mid-S shape logit
	shape2 [number]: late-S shape logit

Output:
	q [number]: the profile value at z (always >= 0)

*/
export function sPhaseProfile(z, shape1, shape2) {
  const [w0, w1, w2] = sPhaseProfileWeights(shape1, shape2);
  const oneMinusZ = 1 - z;
  return w0 * oneMinusZ * oneMinusZ + 2 * w1 * z * oneMinusZ + w2 * z * z;
}

/*

Purpose:
	Analytic minimum of q(z) on [0, 1]. With nonnegative Bernstein weights this is
	always >= 0, so it exists as EVIDENCE rather than as a gate: STAT-01's
	constraint audit reports it, and a negative value would mean the
	parameterization itself is broken rather than that the fit wandered.

Input:
	shape1 [number]: mid-S shape logit
	shape2 [number]: late-S shape logit

Output:
	minimum [number]: the smallest value of q on [0, 1]

*/
export function sPhaseProfileMinimum(shape1, shape2) {
  const [w0, w1, w2] = sPhaseProfileWeights(shape1, shape2);
  // Monomial form: q(z) = w0 + 2(w1 - w0) z + (w0 - 2 w1 + w2) z^2.
  const linear = 2 * (w1 - w0);
  const quadratic = w0 - 2 * w1 + w2;
  let minimum = Math.min(w0, w2); // q(0), q(1)
  if (quadratic > 0) {
    const vertexZ = -linear / (2 * quadratic);
    if (vertexZ > 0 && vertexZ < 1) {
      minimum = Math.min(minimum, sPhaseProfile(vertexZ, shape1, shape2));
    }
  }
  return minimum;
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
	Dean-Jett S phase: convolvedSPhaseWithProfile specialized to the Bernstein
	occupancy profile q(z).

Input:
	edges [array]: histogram bin edges
	parameters [object]: { sArea, g1Mean, g2Mean, broadeningCV, shape1, shape2 }
	quadratureNodes [number]: Gauss-Legendre node count

Output:
	counts [array]: per-bin S-phase counts

*/
export function convolvedSPhase(
  edges,
  { sArea, g1Mean, g2Mean, broadeningCV, shape1, shape2 },
  quadratureNodes = DEFAULT_S_QUADRATURE_NODES,
) {
  // No validity gate: the Bernstein parameterization cannot produce a negative
  // profile, so there is no infeasible case left to reject here.
  return convolvedSPhaseWithProfile(
    edges,
    { sArea, g1Mean, g2Mean, broadeningCV, profileFn: (z) => sPhaseProfile(z, shape1, shape2) },
    quadratureNodes,
  );
}
