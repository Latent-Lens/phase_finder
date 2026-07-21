// Shared component builders for the canonical generative cell-cycle models
// (Dean-Jett here; Dean-Jett-Fox reuses the same G1/G2 peaks and quadratic
// profile in M4). Pure functions of already-resolved numeric parameters --
// which parameters are free, bounded, or locked (G2:G1 ratio mode, CV mode)
// is an initialization/fit_engine concern, not this module's.
//
// Ported/adapted from the reference archive's src/models/shared.js, with the
// two changes the modeling plan calls out explicitly (see docs/
// cell_cycle_modeling_plan.md §5.3): the quadratic S-phase profile is used
// literally (no softplus reparameterization -- an invalid profile is
// rejected outright via isQuadraticProfileValid, not silently clamped
// positive), and the S-phase integral runs on independent fixed-node
// Gauss-Legendre quadrature (quadrature.js) rather than on the histogram's
// own bin centers as the latent integration grid.

import { gaussianBinMass, normalCdf } from "../../math/gaussian_bin_mass.js";
import { gaussLegendre } from "../../math/quadrature.js";
import { clamp } from "../../math/stats.js";

const EPS = 1e-12;
export const DEFAULT_S_QUADRATURE_NODES = 64;

/**
 * Literal normalized quadratic profile q(z) = a + b*z + c*z^2 with
 * a = 1 - b/2 - c/3, so integral(q, 0..1) = 1 for any b, c.
 */
export function quadraticProfile(z, b, c) {
  const a = 1 - b / 2 - c / 3;
  return a + b * z + c * z * z;
}

/**
 * The analytic minimum of q(z) on [0, 1]: q is checked at both endpoints and,
 * when c > 0 and the vertex z = -b/(2c) lies inside [0, 1], at the vertex --
 * a downward-opening or monotonic quadratic's minimum is always at an
 * endpoint, so the vertex only needs checking when c > 0 (upward-opening).
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

/** Whether q(z) stays nonnegative over [0, 1] -- the plan's explicit rejection rule. */
export function isQuadraticProfileValid(b, c) {
  return quadraticProfileMinimum(b, c) >= 0;
}

/**
 * Projects (b, c) onto the feasible set { isQuadraticProfileValid(b, c) },
 * shrinking both coefficients toward the always-valid flat profile (b=c=0)
 * rather than clamping each independently, since validity is a joint
 * condition on the pair, not two separate bounds. Shared by every model
 * whose latent occupancy profile includes this quadratic term as a
 * component -- Dean-Jett uses it directly as q(z); Dean-Jett-Fox (M4) uses
 * the same projection on the same (b, c) before blending in the wave term,
 * since q_F(z) = (1-w)*q(z) + w*T(z) only stays nonnegative when q(z) itself
 * does (T(z) is a density, already nonnegative by construction).
 */
export function projectQuadraticProfile(b, c, { maxMagnitude = 8, shrinkFactor = 0.7, maxIterations = 40 } = {}) {
  let bb = clamp(b, -maxMagnitude, maxMagnitude);
  let cc = clamp(c, -maxMagnitude, maxMagnitude);
  let guard = 0;
  while (!isQuadraticProfileValid(bb, cc) && guard < maxIterations) {
    bb *= shrinkFactor;
    cc *= shrinkFactor;
    guard += 1;
  }
  return isQuadraticProfileValid(bb, cc) ? [bb, cc] : [0, 0];
}

/**
 * G1 and G2/M peaks as area-parameterized Gaussians integrated exactly over
 * each histogram bin (plan §5.2). sigma = CV * mean for each peak
 * independently -- equal-CV/locked-ratio behavior is an explicit caller
 * choice (which parameters get tied together before this function is
 * called), never inferred here.
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

/**
 * Broadened S-phase count per bin, generalized over the latent z-occupancy
 * profile (plan §5.3's structure, generic over which profile function fills
 * it): every latent DNA position u(z) = g1Mean + z*(g2Mean-g1Mean), z in
 * [0,1], carries profileFn(z)*dz of occupancy mass and its own CV-scaled
 * Gaussian broadening; the total per-bin count is the sum over quadrature
 * nodes of each node's broadened contribution. Evaluates each node's CDF at
 * every bin edge once (not twice per bin) by sweeping edges left to right
 * and reusing the previous edge's CDF value, the same trick gaussianBinMass
 * uses internally.
 *
 * Dean-Jett's convolvedSPhase() below is this function specialized to
 * profileFn = z => quadraticProfile(z, b, c). Dean-Jett-Fox (M4) is the
 * other specialization, with profileFn = z => (1-w)*quadraticProfile(z,b,c)
 * + w*waveProfile(z, ...) -- see models/dean_jett_fox.js.
 *
 * Returns an all-zero array (rather than throwing) for a non-positive area
 * or a non-positive g1-to-g2 span -- those are caller/optimizer-side
 * validation failures, not this integrator's concern. profileFn's own
 * validity (e.g. isQuadraticProfileValid) is the caller's responsibility.
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

/**
 * Dean-Jett S phase (plan §5.3): convolvedSPhaseWithProfile() specialized to
 * the quadratic occupancy profile q(z). Returns an all-zero array for an
 * invalid quadratic profile in addition to the generic non-positive-area/
 * span cases -- see convolvedSPhaseWithProfile()'s own doc for those.
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
