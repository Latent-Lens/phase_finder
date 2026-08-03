// ============================================================================
// Dean-Jett-Fox generative cell-cycle model (modeling plan §5.1-§5.2, §5.4,
// §6.2). Fox is DJ plus a latent Gaussian "wave" blended into the S-phase
// occupancy profile -- everything else (G1/G2 peaks, the broadening
// integral, the region/ratio/CV feasible domain) is identical to
// models/dean_jett.js and is not re-derived here.
//
// Parameter vector theta_F (this file's PARAMETER_INDEX order below) is
// Dean-Jett's theta plus three wave parameters:
//   N_G1 (g1Area), mu1 (g1Mean), CV1 (g1CV),
//   N_G2 (g2Area), mu2 (g2Mean), CV2 (g2CV),
//   N_S  (sArea),  b, c,          <- same quadratic q(z) as Dean-Jett
//   w, m_W (waveMean), s_W (waveSigma)   <- new: the wave term
//
// Observation model -- unchanged from Dean-Jett (plan §5.1): raw integer
// Poisson counts, fit by minimizing total Poisson deviance (fit_engine.js),
// never SSE.
//
// Expected count per bin -- same G1_i/S_i/G2_i decomposition as Dean-Jett,
// only S_i's occupancy profile changes:
//
//   lambda_i(theta_F) = G1_i(theta_F) + S_i(theta_F) + G2_i(theta_F)
//
// G1_i, G2_i: identical to Dean-Jett (shared.js's peakComponents(), plan §5.2).
//
// Dean-Jett-Fox S phase (plan §5.4): the same broadened latent-z integral as
// Dean-Jett (shared.js's convolvedSPhaseWithProfile(), plan §5.3's u(z) and
// CV1-scaled broadening), but the z-occupancy profile is now a blend of the
// Dean-Jett quadratic and a normalized Gaussian "wave" T(z) confined to
// [0,1] via truncation-renormalization:
//
//   u(z) = mu1 + z*(mu2-mu1),                          z in [0,1]   (same as DJ)
//   q(z) = a + b*z + c*z^2,    a = 1 - b/2 - c/3        (same as DJ)
//   q(z) >= 0 holds by construction (Bernstein basis, same as DJ)
//
//   T(z; m_W, s_W) = phi(z; m_W, s_W) / [Phi((1-m_W)/s_W) - Phi((-m_W)/s_W)],  z in [0,1]
//     (phi = normal PDF, Phi = normal CDF -- a Gaussian renormalized to
//      integrate to exactly 1 over [0,1], not a plain unit Gaussian)
//
//   q_F(z) = (1-w) * q(z)  +  w * T(z; m_W, s_W),       0 <= w < 1
//
//   S_i = N_S * integral_0^1 q_F(z) *
//           [ Phi((b_{i+1}-u(z))/(CV1*u(z))) - Phi((b_i-u(z))/(CV1*u(z))) ] dz
//
// Nesting identity (this file's exit-gate requirement, plan §5.4/M4): at
// w=0, q_F(z) = q(z) exactly, so Dean-Jett-Fox's expected counts equal
// Dean-Jett's at the same (g1..g2CV, sArea, b, c) -- verified directly by
// unit_tests_cell_cycle_dean_jett_fox.py, not just asserted here.
//
// w is not itself a phase fraction: it is the *share of the S-phase area*
// (N_S) assigned to the wave, so wave area = w*N_S. Biological phase
// fractions still use only N_G1, N_S, N_G2 (plan §5.1) -- the wave never
// creates a fourth phase category, and this model must never be read as
// inferring synchronization (plan §1.1's Fox row: "report 'complex S-phase
// model'; do not infer synchronization").
//
// That last clause is load-bearing, and it is why this file deliberately does
// NOT implement the reference's asynchronous/synchronous BIC selection
// (baselines/dean_jett_fox_javascript_implementation.html §13, Steps 6-9). See
// the "why there is no population-form selection" note above fit().
//
// Everything below that is *not* part of the emission model above -- the
// region/ratio/CV-mode feasible domain (plan §6.2), deterministic multi-
// start initialization, and the generic-result (plan §4.5) packaging around
// fit_engine.js -- mirrors models/dean_jett.js's structure so the two stay
// easy to compare side by side; only the S-phase profile and its three new
// parameters actually differ.
// ============================================================================

import {
  peakComponents,
  convolvedSPhaseWithProfile,
  sPhaseProfile,
  projectMeansToFeasible,
  sPhaseProfileMinimum,
  DEFAULT_S_QUADRATURE_NODES,
} from "./shared.js";
import { normalCdf, normalPdf } from "../../math/gaussian_bin_mass.js";
import { createParameterTransform, fitPoissonModel } from "../fit_engine.js";
import { buildPoissonFitDiagnostics, fitQualityWarnings, tailMassWarning } from "../diagnostics.js";
import { buildConstraintAudit, constraintAuditWarnings } from "../constraint_audit.js";
import { validatePeakRegions } from "../peak_regions.js";
import { clamp } from "../../math/stats.js";
// FlowJo fits each G1/G2 Gaussian by least squares over a -3sigma..+1sigma window
// about the mean -- i.e. from the peak's UNCONTAMINATED flank -- and only then
// models S (docs.flowjo.com cell-cycle univariate). This model reuses Watson
// Pragmatic's clean-flank local peak fit for exactly that, so DJF's peaks are
// established before the S phase is fit, instead of a joint fit letting a broad
// peak or the flexible S phase absorb each other on real, overlapping DNA peaks
// (VALID-01).
//
// Known cost, measured: that estimator is BIASED when S is substantial (it does
// not subtract the S pedestal under either peak, it measures widths on a
// histogram smoothed at 2 bins without removing the kernel, and it quantizes the
// centre to a bin). Both peaks come out too wide and too fat, which starves S.
// Since they are frozen, the fit cannot correct it. This is the largest known
// defect in the model and it is documented in full, with the numbers, in
// docs/audits/cell_cycle_model_investigation_handoff.md §8.1.
import { fit_local_peak, DEFAULT_CONFIG as WATSON_LOCAL_PEAK_CONFIG } from "./watson_pragmatic.js";

const EPS = 1e-12;

// theta_F's array position for every component of the formula block above.
const PARAMETER_INDEX = Object.freeze({
  G1_AREA: 0, G1_MEAN: 1, G1_CV: 2,
  G2_AREA: 3, G2_MEAN: 4, G2_CV: 5,
  S_AREA: 6, SHAPE1: 7, SHAPE2: 8,
  W: 9,          // w
  WAVE_MEAN: 10, // m_W
  WAVE_SIGMA: 11, // s_W
});

export const DEFAULT_CONFIG = Object.freeze({
  // Dean-Jett-Fox fits G1/G2 from their clean flanks and holds them fixed, then
  // fits only the S phase to the residual -- the FlowJo-style peaks-first
  // approach. Validated to match FlowJo DJF to ~5pp per phase and to be the
  // closest model on 26/30 reference samples, and it removes the joint-fit
  // degeneracy (S collapsing to 0% or ballooning to swallow a peak) on skewed
  // samples. See docs/djf-model-validation.html.
  //
  // The older "joint" estimator (every parameter optimized together) existed
  // only so the retired auto_dj_djf policy could compare DJ against DJF as the
  // same generative fit. With Auto retired there is no second estimator and no
  // peakFitMode switch: the peaks are ALWAYS fixed from their clean flanks.
  //
  // Consequence, stated because it is not obvious: ratioMode/cvMode constrain
  // peak MEANS and WIDTHS, and those are no longer free parameters here, so
  // they cannot influence this model's fit. The user controls the peaks by
  // editing the G1/G2 regions (which is where each clean-flank fit looks);
  // constraint_audit.js still EVALUATES the G2:G1 ratio and reports an
  // implausible one as a diagnostic, it just no longer enforces it.
  ratioMode: "bounded",
  fitRatioRange: [1.65, 2.25],
  lockedRatio: 2,
  cvMode: "free",
  cvMin: 0.01,
  cvMax: 0.30,
  wMin: 0,
  wMax: 0.95, // plan §5.4: "0 <= w < 1"; kept strictly below 1 with margin for numerical stability
  waveMeanMin: 0.02,
  waveMeanMax: 0.98,
  waveSigmaMin: 0.02,
  waveSigmaMax: 0.5,
  sQuadratureNodes: DEFAULT_S_QUADRATURE_NODES,
  maxIterations: 200,
  tolerance: 1e-8,
  stepTolerance: 1e-7,
  initialLambda: 1e-2,
  finiteDifferenceStep: 1e-4,
});

function paramsToNamed(parameters) {
  return {
    g1Area: parameters[PARAMETER_INDEX.G1_AREA],
    g1Mean: parameters[PARAMETER_INDEX.G1_MEAN],
    g1CV: parameters[PARAMETER_INDEX.G1_CV],
    g2Area: parameters[PARAMETER_INDEX.G2_AREA],
    g2Mean: parameters[PARAMETER_INDEX.G2_MEAN],
    g2CV: parameters[PARAMETER_INDEX.G2_CV],
    sArea: parameters[PARAMETER_INDEX.S_AREA],
    shape1: parameters[PARAMETER_INDEX.SHAPE1],
    shape2: parameters[PARAMETER_INDEX.SHAPE2],
    w: parameters[PARAMETER_INDEX.W],
    waveMean: parameters[PARAMETER_INDEX.WAVE_MEAN],
    waveSigma: parameters[PARAMETER_INDEX.WAVE_SIGMA],
  };
}

/*

Purpose:
	T(z; m_W, s_W): a normal density renormalized so its own mass over [0, 1]
	integrates to exactly 1 -- the wave term of q_F(z). Returns 0 (not NaN) when
	waveSigma places essentially all mass outside [0, 1], since that degenerate
	placement should contribute nothing rather than blow up.

Input:
	z [number]: latent position in [0, 1]
	waveMean [number]: wave center m_W
	waveSigma [number]: wave width s_W

Output:
	density [number]: the renormalized wave density at z

*/
function wave_profile(z, waveMean, waveSigma) {
  const sigma = Math.max(Math.abs(waveSigma), EPS);
  const normalization = normalCdf(1, waveMean, sigma) - normalCdf(0, waveMean, sigma);
  if (!(normalization > EPS)) return 0;
  return normalPdf(z, waveMean, sigma) / normalization;
}

/*

Purpose:
	The blended S-phase profile q_F(z) = (1-w)*q(z) + w*T(z; m_W, s_W). Skips
	evaluating T(z) entirely when w = 0, preserving exact nesting with Dean-Jett.

Input:
	z [number]: latent position in [0, 1]
	named [object]: named parameters (b, c, w, waveMean, waveSigma)

Output:
	profile [number]: q_F(z)

*/
function combined_profile(z, named) {
  const base = (1 - named.w) * sPhaseProfile(z, named.shape1, named.shape2);
  if (!(named.w > 0)) return base; // w=0 nesting: skip evaluating T(z) entirely, not just multiply by 0
  return base + named.w * wave_profile(z, named.waveMean, named.waveSigma);
}

/*

Purpose:
	Evaluates lambda_i(theta_F) = G1_i + S_i + G2_i, with S_i using the blended
	profile q_F(z). The only place this file assembles the full expected-count
	model; G1_i/G2_i and the broadening integral are delegated to shared.js
	exactly as in Dean-Jett.

Input:
	edges [array]: histogram bin edges
	parameters [array]: the theta_F parameter vector
	quadratureNodes [number]: Gauss-Legendre node count

Output:
	expected [array]: expected count per bin

*/
function expected_counts_from_parameters(edges, parameters, quadratureNodes) {
  const named = paramsToNamed(parameters);
  const peaks = peakComponents(edges, named);
  const sCounts = convolvedSPhaseWithProfile(
    edges,
    { sArea: named.sArea, g1Mean: named.g1Mean, g2Mean: named.g2Mean, broadeningCV: named.g1CV, profileFn: (z) => combined_profile(z, named) },
    quadratureNodes,
  );
  const expected = new Array(peaks.g1.length);
  for (let i = 0; i < expected.length; i += 1) {
    expected[i] = peaks.g1[i] + sCounts[i] + peaks.g2[i];
  }
  return expected;
}

// ---- region/ratio/CV feasible domain -- identical to dean_jett.js's, since
// Fox reuses "the same G1/G2 peaks" (plan); duplicated rather than imported
// to keep each model file a self-contained, independently readable unit
// (matches this codebase's existing legacy_bridge.js/dean_jett.js pattern of
// each model owning its own projection, not sharing a projection module that
// doesn't exist yet in the plan's file layout). ---------------------------

// Identical joint (mu1, mu2) projection as Dean-Jett, shared verbatim through
// shared.js (audit SCI-02) so DJ and DJF cannot diverge on constraint handling.
const project_means = projectMeansToFeasible;

// FlowJo-style clean-flank peak fits (G1 from its left flank, G2 from its right),
// returned as the fixed peak parameters the clean_flank fit holds constant.
function clean_flank_fixed_peaks(edges, counts, regions) {
  const g1 = fit_local_peak(edges, counts, regions.g1, "left", WATSON_LOCAL_PEAK_CONFIG);
  const g2 = fit_local_peak(edges, counts, regions.g2, "right", WATSON_LOCAL_PEAK_CONFIG);
  return {
    g1Area: Math.max(1, g1.area), g1Mean: g1.mean, g1CV: Math.max(EPS, g1.cv),
    g2Area: Math.max(1, g2.area), g2Mean: g2.mean, g2CV: Math.max(EPS, g2.cv),
  };
}

function make_project_fn(regions, config, { fixedPeaks = null } = {}) {
  return function project(parameters) {
    const projected = [...parameters];
    projected[PARAMETER_INDEX.G1_AREA] = Math.max(0, projected[PARAMETER_INDEX.G1_AREA]);
    projected[PARAMETER_INDEX.G2_AREA] = Math.max(0, projected[PARAMETER_INDEX.G2_AREA]);
    projected[PARAMETER_INDEX.S_AREA] = Math.max(0, projected[PARAMETER_INDEX.S_AREA]);

    projected[PARAMETER_INDEX.G1_CV] = clamp(Math.abs(projected[PARAMETER_INDEX.G1_CV]), config.cvMin, config.cvMax);
    projected[PARAMETER_INDEX.G2_CV] =
      config.cvMode === "equal"
        ? projected[PARAMETER_INDEX.G1_CV]
        : clamp(Math.abs(projected[PARAMETER_INDEX.G2_CV]), config.cvMin, config.cvMax);

    const { g1Mean, g2Mean } = project_means(
      projected[PARAMETER_INDEX.G1_MEAN],
      projected[PARAMETER_INDEX.G2_MEAN],
      regions,
      config,
    );
    projected[PARAMETER_INDEX.G1_MEAN] = g1Mean;
    projected[PARAMETER_INDEX.G2_MEAN] = g2Mean;


    // The wave's own feasible domain -- not part of the emission model, the
    // region the optimizer may search for w, m_W, s_W.
    projected[PARAMETER_INDEX.W] = clamp(projected[PARAMETER_INDEX.W], config.wMin, config.wMax);
    projected[PARAMETER_INDEX.WAVE_MEAN] = clamp(projected[PARAMETER_INDEX.WAVE_MEAN], config.waveMeanMin, config.waveMeanMax);
    projected[PARAMETER_INDEX.WAVE_SIGMA] = clamp(Math.abs(projected[PARAMETER_INDEX.WAVE_SIGMA]), config.waveSigmaMin, config.waveSigmaMax);

    // The peaks are pinned to their clean-flank estimate and never moved, so only
    // the S phase is optimized. Applied after the generic peak projections above
    // so the projection stays a single code path.
    if (fixedPeaks) {
      projected[PARAMETER_INDEX.G1_AREA] = fixedPeaks.g1Area;
      projected[PARAMETER_INDEX.G1_MEAN] = fixedPeaks.g1Mean;
      projected[PARAMETER_INDEX.G1_CV] = fixedPeaks.g1CV;
      projected[PARAMETER_INDEX.G2_AREA] = fixedPeaks.g2Area;
      projected[PARAMETER_INDEX.G2_MEAN] = fixedPeaks.g2Mean;
      projected[PARAMETER_INDEX.G2_CV] = fixedPeaks.g2CV;
    }

    return projected;
  };
}

/*

Purpose:
	The parameters the optimizer may move: the S-phase area, its two Bernstein
	shape logits, and the three wave terms. The G1/G2 peaks are NOT among them --
	they are measured from their clean flanks and held fixed (see below).

Input:
	(none -- the free set does not depend on config, because ratio/CV mode
	constrain peak parameters this model does not optimize)

Output:
	indices [array]: the free parameter positions in theta_F

*/
function free_indices() {
  // The G1/G2 peaks are measured from their clean flanks and HELD FIXED; only
  // the S phase is optimized against the residual.
  //
  // A joint fit (every parameter free, seeded from the same clean-flank
  // estimate) was tried and REVERTED. Measured on the 30-sample FlowJo set
  // under matched QC, freeing the peaks bought a small G1 gain and cost a large
  // S regression, because the flexible S term expands into G2:
  //
  //     metric        frozen peaks    joint fit
  //     g1_mean          0.985x         0.996x
  //     %S median        -2.9pp        +12.0pp
  //     %G2 median       +6.4pp         -6.8pp
  //     %S within tol     28/30          11/30
  //     all_pass           8/30           0/30
  //
  // This is the "S balloons to swallow a peak" degeneracy the peaks-first
  // approach exists to prevent. Freezing the peaks costs a little accuracy in
  // their position and buys a great deal in the phase fractions, which are what
  // is actually reported.
  return [
    PARAMETER_INDEX.S_AREA, PARAMETER_INDEX.SHAPE1, PARAMETER_INDEX.SHAPE2,
    PARAMETER_INDEX.W, PARAMETER_INDEX.WAVE_MEAN, PARAMETER_INDEX.WAVE_SIGMA,
  ];
}

/*

Purpose:
	Builds the dimensionless optimizer coordinates (SCI-07). The map covers all
	twelve parameters because fit_engine.js encodes the whole vector; only the six
	S-phase coordinates are ever actually moved.

	The two peak-mean coordinates are scaled by the PEAK's own estimated width,
	not by the width of the region the user drew. A region expresses one thing --
	"the mean lies somewhere in here" -- and it is enforced as a hard bound by
	make_project_fn(). It must not additionally set the optimizer's step size:
	scaling by region width meant that drawing a generous box silently made every
	step in mean-space coarser, so the same sample could fit differently purely
	because the user was less precise with the mouse. Sigma is the physically
	meaningful scale for how far a peak mean might move. (Inert while the peaks
	are frozen, since neither mean is free -- kept correct so that a future
	peak-fitting mode inherits the right scale rather than a silently wrong one.)

Input:
	peaks [object]: the peak estimate (needs g1Mean/g1CV and g2Mean/g2CV)
	config [object]: the merged model config

Output:
	transform [object]: the encode/decode coordinate map

*/
function make_parameter_transform(peaks, config) {
  const peak_scaled = (mean, cv) => ({
    type: "scaled",
    center: mean,
    // One sigma, floored so a degenerate CV estimate cannot collapse the step
    // size to zero and stall the optimizer.
    scale: Math.max(Math.abs(mean * cv), MINIMUM_MEAN_STEP_SCALE),
  });
  return createParameterTransform([
    { type: "log" }, peak_scaled(peaks.g1Mean, peaks.g1CV), { type: "bounded", min: config.cvMin, max: config.cvMax },
    { type: "log" }, peak_scaled(peaks.g2Mean, peaks.g2CV), { type: "bounded", min: config.cvMin, max: config.cvMax },
    { type: "log" }, { type: "identity" }, { type: "identity" },
    // All three wave parameters use smooth bounded coordinates.
    //
    // w used to be an "identity" coordinate clamped into [wMin, wMax] by the
    // projection, so that the exact w = 0 Dean-Jett nesting start stayed
    // representable. That cost far more than it bought: w is the parameter that
    // most often runs to a bound (with the peaks frozen, the wave is the only
    // flexible shape left and it absorbs peak misfit), and a hard clamp on an
    // unbounded coordinate is exactly the boundary stall lm_solver.js refuses to
    // call convergence -- the raw LM step stays large while the projected step is
    // clipped to nothing, so the fit burned all 200 iterations and reported
    // maxIterationsReached. A non-converged result is not reportable
    // (result_contract.js), so this turned "the wave wants to be large" into
    // "no result at all".
    //
    // The sigmoid saturates instead of clipping: the Jacobian column shrinks as w
    // approaches its bound, the step shrinks with it, and the fit converges and
    // reports w at its bound honestly (diagnostics.js raises
    // parameter_at_upper_bound). w = 0 is no longer exactly representable, but
    // nothing needs it to be: the nesting identity is a property of
    // expectedCounts(), which is evaluated directly, not reached through a fit.
    { type: "bounded", min: config.wMin, max: config.wMax },
    { type: "bounded", min: config.waveMeanMin, max: config.waveMeanMax },
    { type: "bounded", min: config.waveSigmaMin, max: config.waveSigmaMax },
  ]);
}

// How many sigma out from each peak centre the S bridge is taken to start. At
// 2 sigma a Gaussian peak has ~95% of its mass inside, so the interval between
// these two points is dominated by S rather than by peak tails.
const BRIDGE_SIGMA_OFFSET = 2;

// Floor on the peak-mean step scale, in channel units, so a degenerate CV
// estimate cannot collapse the optimizer's step size to zero.
const MINIMUM_MEAN_STEP_SCALE = 1e-6;

// Share of the S area in the wave above which the fit reports a "complex S-phase
// shape" note. Chosen to be well clear of the small w values a smooth profile
// picks up from noise, without waiting until the wave dominates: at w = 0.2 a
// fifth of S sits in one narrow band, which a reader should see.
const WAVE_NOTICE_FRACTION = 0.2;

// ---------------------------------------------------------------------------
// Why there is no asynchronous/synchronous population-form selection.
//
// The reference (§13, Steps 6-9) fits an asynchronous variant (w = 0) and a
// synchronous one (w free), then selects between them by BIC under four
// safeguards. That was implemented here and REMOVED, because it is not
// identifiable while the peaks are frozen. The measurement, on the wave-free
// two-peak fixture in unit_tests_cell_cycle_dean_jett_fox.py (true w = 0):
//
//                      frozen clean-flank peaks   frozen at the TRUE peaks
//   asynchronous dev            1289.6                      46.1
//   synchronous  dev            1169.6                      45.7
//   fitted w                    0.95 (its ceiling)          0.0135
//   deltaBIC                    -102.9  -> "synchronous"    +16.7 -> asynchronous
//
// With the true peaks the selection is correct: the cohort earns nothing and
// BIC rejects it. With the clean-flank peaks it is wrong, and wrong in the one
// direction that matters -- the cohort is selected on data that contains no
// cohort. The reason is that the clean-flank estimate is biased (it returns
// g1CV 0.084 for a true 0.060, g2Mean 137.5 for a true 140), the frozen peaks
// therefore leave a large systematic residual, and the wave -- the only
// flexible shape left in the model -- absorbs that residual. It is fitting
// PEAK MISFIT, not a synchronized population.
//
// Because the fit runs against a hard w <= 0.95 clamp in that state, LM's
// projected step never satisfies the step tolerance and the synchronous variant
// reports converged: false. The `converged` guard then rejected the cohort for
// an accidental reason, which is what made the selection look like it worked.
// A guard that returns the right answer for the wrong reason is worse than no
// guard: it would have started selecting spurious cohorts the moment the
// optimizer's convergence behaviour changed.
//
// This does NOT mean the reference is wrong. It means population-form selection
// needs peaks that are unbiased enough for a cohort to be distinguishable from
// peak misfit, which the frozen clean-flank estimate is not. Re-attempting it
// requires fixing the peak estimate first, and validating on the 30-sample
// FlowJo reference set -- not on DJF-generated synthetics, which have exactly
// the "clean, well-separated Gaussians" property that makes the frozen peaks
// look far better than they are on real yeast.
//
// Consequence for reporting, stated because it is not obvious: w is still fit,
// so a genuinely synchronized sample still gets a better-shaped S profile. What
// the model no longer does is CLAIM a population form. That matches the plan's
// standing instruction for this model (§1.1's Fox row: "report 'complex S-phase
// model'; do not infer synchronization").
// ---------------------------------------------------------------------------

/*

Purpose:
	Seeds the S-phase area from the bridge between the two PEAK ESTIMATES, offset
	by each peak's own width.

	It deliberately does NOT use the region edges. Summing strictly between
	regions.g1.right and regions.g2.left meant that drawing generous peak regions
	shrank the gap between them and so starved the S seed -- a user being cautious
	about where a mean might lie was silently telling the model there was less S.
	A region bounds the MEAN; it says nothing about how much S there is.

Input:
	edges [array]: histogram bin edges
	counts [array]: per-bin counts
	peaks [object]: the peak estimate (means and CVs)

Output:
	area [number]: a positive S-area seed

*/
function estimate_bridge_area(edges, counts, peaks) {
  const left = peaks.g1Mean + BRIDGE_SIGMA_OFFSET * Math.abs(peaks.g1Mean * peaks.g1CV);
  const right = peaks.g2Mean - BRIDGE_SIGMA_OFFSET * Math.abs(peaks.g2Mean * peaks.g2CV);
  if (!(right > left)) return 1; // peaks overlap within 2 sigma; fall back to the residual seed
  let total = 0;
  for (let i = 0; i < counts.length; i += 1) {
    const center = 0.5 * (edges[i] + edges[i + 1]);
    if (center > left && center < right) total += counts[i];
  }
  return Math.max(1, total);
}

/*

Purpose:
	A second, independent S-area seed: whatever the histogram holds that the two
	fitted peaks do not account for. Complements estimate_bridge_area(), which
	under-counts S wherever the peaks' own tails overlap the bridge.

Input:
	counts [array]: per-bin counts
	peaks [object]: the peak estimate (needs g1Area and g2Area)

Output:
	area [number]: a positive S-area seed

*/
function estimate_residual_area(counts, peaks) {
  let total = 0;
  for (const value of counts) total += value;
  return Math.max(1, total - peaks.g1Area - peaks.g2Area);
}

// A small deterministic grid of wave placements (waveMean x waveSigma) used to
// seed the S-phase starts below. z in [0,1] is
// the entire latent S-phase axis, so this grid is a genuine, from-scratch
// scan of "where along S could a wave sit and how tight could it be" -- not
// tuned to any particular dataset. Three means (early/mid/late S) crossed
// with two widths (tight/broad) gives the optimizer a real chance at
// whichever placement the true wave happens to be near, rather than betting
// on just one or two fixed guesses.
const WAVE_PLACEMENT_GRID = [
  [0.3, 0.06], [0.5, 0.06], [0.7, 0.06],
  [0.3, 0.15], [0.5, 0.15], [0.7, 0.15],
];

/*

Purpose:
	Builds the deterministic theta_F,0 start candidates.

	Only the S-phase coordinates vary between starts. The six peak slots are
	filled from the clean-flank estimate and are identical in every start, because
	make_project_fn() overwrites them with exactly those values anyway -- the
	peaks are fixed, so a start that disagreed about them would be projected back
	before the first residual evaluation. (Seeding a second, region-based peak
	estimate here produced a set of starts that were bit-identical after
	projection: twice the restarts, same search.)

	The S coordinates that DO vary: two width-independent area seeds, a flat and
	two sloped Bernstein shapes, and the wave-placement grid, so a genuine wave is
	reachable without first climbing out of the w=0 plateau.

Input:
	edges [array]: histogram bin edges
	counts [array]: per-bin counts
	regions [object]: the accepted { g1, g2 } peak regions
	config [object]: model config
	cleanFlankPeaks [object]: the fixed clean-flank peak estimate

Output:
	starts [array]: an array of theta_F start vectors

*/
function build_parameter_starts(edges, counts, regions, config, cleanFlankPeaks) {
  // Two width-independent S seeds: the bridge between the peaks, and whatever
  // the peaks leave unexplained. Neither reads the region edges, so widening a
  // region cannot starve the S estimate.
  const bridgeGuess = estimate_bridge_area(edges, counts, cleanFlankPeaks);
  const residualGuess = estimate_residual_area(counts, cleanFlankPeaks);
  const sAreaGuess = Math.max(bridgeGuess, residualGuess);

  let g1CV = clamp(cleanFlankPeaks.g1CV, config.cvMin, config.cvMax);
  let g2CV = config.cvMode === "equal"
    ? g1CV
    : clamp(cleanFlankPeaks.g2CV, config.cvMin, config.cvMax);
  const { g1Mean, g2Mean } = project_means(
    cleanFlankPeaks.g1Mean, cleanFlankPeaks.g2Mean, regions, config,
  );
  const head = [
    Math.max(1, cleanFlankPeaks.g1Area), g1Mean, g1CV,
    Math.max(1, cleanFlankPeaks.g2Area), g2Mean, g2CV,
    sAreaGuess,
  ];

  return [
    [...head, 0, 0, 0, 0.5, 0.15], // flat profile, w=0 (neutral wave placement)
    [...head, 0.8, -0.5, 0, 0.5, 0.15],
    [...head, -0.8, -0.5, 0, 0.5, 0.15],
    // The alternate S-area seed, so whichever of the two is closer on this
    // sample is available to the multi-start rather than being averaged away.
    [...head.slice(0, PARAMETER_INDEX.S_AREA), Math.min(bridgeGuess, residualGuess), 0, 0, 0, 0.5, 0.15],
    ...WAVE_PLACEMENT_GRID.map(([waveMean, waveSigma]) => [...head, 0, 0, 0.25, waveMean, waveSigma]),
  ];
}

/*

Purpose:
	Reference Step 7: locate the wave from the WAVE-FREE background pass's
	residuals rather than from a fixed grid. The largest positive residual between
	the two peak centres is where the smooth profile most under-explains the data,
	which is where a wave would sit; its local width seeds sigma_F.

	This replaces guessing: a fixed placement grid can only land near a wave by
	luck, while this looks at the sample. Used purely to add a start vector -- it
	decides nothing on its own.

Input:
	edges [array]: histogram bin edges
	counts [array]: observed per-bin counts
	expected [array]: the background pass's expected counts
	g1Mean [number]: fitted G1 centre
	g2Mean [number]: fitted G2/M centre

Output:
	seed [object|null]: { waveMean, waveSigma, residual } in latent z units, or
	                    null when no positive residual lies between the peaks

*/
function cohort_seed_from_residuals(edges, counts, expected, g1Mean, g2Mean) {
  const span = g2Mean - g1Mean;
  if (!(span > 0)) return null;

  let bestIndex = -1;
  let best = 0;
  for (let i = 0; i < counts.length; i += 1) {
    const center = 0.5 * (edges[i] + edges[i + 1]);
    if (center <= g1Mean || center >= g2Mean) continue;
    const residual = counts[i] - expected[i];
    if (residual > best) {
      best = residual;
      bestIndex = i;
    }
  }
  if (bestIndex < 0) return null;

  // Local width: walk out from the peak residual while it stays above half its
  // height, the same half-maximum convention the peak detector uses.
  const half = best / 2;
  let left = bestIndex;
  let right = bestIndex;
  while (left > 0 && counts[left - 1] - expected[left - 1] > half) left -= 1;
  while (right < counts.length - 1 && counts[right + 1] - expected[right + 1] > half) right += 1;
  const centerOf = (i) => 0.5 * (edges[i] + edges[i + 1]);
  const widthX = Math.max(centerOf(right) - centerOf(left), edges[1] - edges[0]);

  // Half-width at half maximum -> sigma for a Gaussian.
  const sigmaX = widthX / (2 * Math.sqrt(2 * Math.LN2));
  return {
    waveMean: clamp((centerOf(bestIndex) - g1Mean) / span, 0, 1),
    waveSigma: clamp(sigmaX / span, 0, 1),
    residual: best,
  };
}

function convergence_reason(fit) {
  if (fit.cancelled) return "cancelled";
  if (fit.converged) return fit.terminationReason ?? "converged";
  return fit.maxIterationsReached ? "max_iterations" : "unknown";
}

function component_from_counts(id, label, counts, areaParameter, role = "biological") {
  const observedDomainArea = counts.reduce((sum, value) => sum + value, 0);
  return {
    id, label, role, counts,
    totalArea: areaParameter,
    observedDomainArea,
    includeInBiologicalDenominator: role === "biological",
  };
}

export const dean_jett_fox = {
  id: "dean_jett_fox",
  version: "1.0.0",
  label: "Dean–Jett–Fox",
  kind: "generative",
  fitScope: "per_sample",
  comparisonGroup: "poisson_cell_cycle",
  requiredInputs: ["sample_histogram", "peak_regions"],
  capabilities: { contaminants: false, multiplePloidy: false, autoComparison: true },
  defaultConfig: { ...DEFAULT_CONFIG },

  /*

  Purpose:
	Fits Dean-Jett-Fox peaks-first: G1 and G2 are measured from their clean flanks
	and HELD FIXED, then the S phase (area, Bernstein shape, and the wave) is fit
	to what those peaks leave unexplained, from a deterministic multi-start.

	Runs in two passes, both of which fit the SAME model -- the first exists only
	to place the wave's starting point:

	  1. a background pass with w pinned at its w=0 start (the wave parameters are
	     simply not in freeIndices), which is Dean-Jett's fit;
	  2. the reported fit, whose starts are the standard grid PLUS the background
	     pass's optimum with the wave switched on where that pass most
	     under-explains the data (reference Step 7 -- seed the cohort from the
	     largest positive residual rather than from a fixed grid).

	Pass 1 is initialization, not model selection: its result is never reported
	and never compared against pass 2. fitPoissonModel takes the best of all
	restarts by deviance, so adding a data-located start can only lower the
	objective. See the note above on why the reference's BIC-based
	asynchronous/synchronous SELECTION is deliberately not implemented.

  Input:
	context [object]: { histogram (masked histogram), peakRegions, config
	                  (DEFAULT_CONFIG overrides) }

  Output:
	rawResult [object]: the raw fit result for normalizeResult()

  */
  fit(context) {
    const { histogram, peakRegions, config: userConfig = {} } = context;
    // onProgress/shouldCancel excluded from the merged `config` for the same
    // reason as dean_jett.js's fit(): that object is stored in the returned
    // rawResult (provenance.rawResult), which the worker postMessages back,
    // and a live function reference there fails structured-clone.
    const { onProgress, shouldCancel, ...restConfig } = userConfig;
    const config = { ...DEFAULT_CONFIG, ...restConfig };
    const regions = validatePeakRegions(peakRegions);
    projectMeansToFeasible(0.5 * (regions.g1.left + regions.g1.right), 0.5 * (regions.g2.left + regions.g2.right), regions, config);

    const edges = histogram.edges;
    const counts = Array.from(histogram.counts ?? histogram.y);
    if (!edges || edges.length !== counts.length + 1) {
      throw new Error("histogram.edges must have exactly one more entry than histogram.counts.");
    }

    // The clean-flank estimate IS the peaks: measured once here and held fixed
    // for the whole fit. Only the S phase below is optimized.
    const cleanFlankPeaks = clean_flank_fixed_peaks(edges, counts, regions);
    const parameterStarts = build_parameter_starts(edges, counts, regions, config, cleanFlankPeaks);
    const parameterTransform = make_parameter_transform(cleanFlankPeaks, config);
    const expectedCountsFn = (parameters) =>
      expected_counts_from_parameters(edges, parameters, config.sQuadratureNodes);
    const solverOptions = {
      maxIterations: config.maxIterations,
      tolerance: config.tolerance,
      stepTolerance: config.stepTolerance,
      initialLambda: config.initialLambda,
      finiteDifferenceStep: config.finiteDifferenceStep,
      onProgress,
      shouldCancel,
    };
    const projectFn = make_project_fn(regions, config, { fixedPeaks: cleanFlankPeaks });
    const run_fit = (starts, freeIndices) => fitPoissonModel({
      observedCounts: counts,
      parameterStarts: starts.map(projectFn),
      freeIndices,
      expectedCountsFn,
      projectFn,
      parameterTransform,
      options: solverOptions,
    });

    // Pass 1 (initialization only) -- the wave-free fit: only the starts that
    // already sit at w = 0, with the three wave parameters left out of
    // freeIndices so nothing can move them.
    //
    // Selecting the starts this way rather than zeroing w on all of them is
    // deliberate. A start's w survives untouched when W is not free, so feeding
    // in the wave-placement grid (which sits at w = 0.25) would make this
    // "wave-free" pass silently carry a wave. And with w = 0 the placement is
    // inert, so those grid starts would only duplicate the S-shape starts they
    // were built from -- there is nothing to gain by keeping them.
    const backgroundStarts = parameterStarts.filter(
      (start) => start[PARAMETER_INDEX.W] === 0,
    );
    const background = run_fit(backgroundStarts, [
      PARAMETER_INDEX.S_AREA, PARAMETER_INDEX.SHAPE1, PARAMETER_INDEX.SHAPE2,
    ]);

    // Reference Step 7 -- locate the wave where the background pass most
    // under-explains the data, instead of relying on the fixed placement grid.
    const backgroundNamed = paramsToNamed(background.parameters);
    const cohortSeed = background.cancelled ? null : cohort_seed_from_residuals(
      edges, counts, background.expectedCounts, backgroundNamed.g1Mean, backgroundNamed.g2Mean,
    );
    const starts = [...parameterStarts];
    if (cohortSeed) {
      // Start from the background optimum with the residual-located wave
      // switched on, at two abundances so a small wave is reachable too.
      for (const w of [0.15, 0.35]) {
        const start = [...background.parameters];
        start[PARAMETER_INDEX.W] = w;
        start[PARAMETER_INDEX.WAVE_MEAN] = clamp(cohortSeed.waveMean, config.waveMeanMin, config.waveMeanMax);
        start[PARAMETER_INDEX.WAVE_SIGMA] = clamp(cohortSeed.waveSigma, config.waveSigmaMin, config.waveSigmaMax);
        starts.push(start);
      }
    }

    // Pass 2 -- the reported fit: S area, Bernstein shape and the wave.
    const fit = background.cancelled ? background : run_fit(starts, free_indices());

    return {
      fit, edges, counts, regions, config,
      cohortSeed,
      initialCenters: { g1: parameterStarts[0][PARAMETER_INDEX.G1_MEAN], g2: parameterStarts[0][PARAMETER_INDEX.G2_MEAN] },
    };
  },

  /*

  Purpose:
	Evaluates lambda_i(theta_F) at arbitrary edges (see dean_jett's expectedCounts
	for why it takes the named-parameter shape, not the raw fit array).

  Input:
	edges [array]: the edges to evaluate at
	parameters [object]: the named Dean-Jett-Fox parameters

  Output:
	counts [array]: expected count per bin at the given edges

  */
  expectedCounts(edges, parameters) {
    const array = [
      parameters.g1Area, parameters.g1Mean, parameters.g1CV,
      parameters.g2Area, parameters.g2Mean, parameters.g2CV,
      parameters.sArea, parameters.shape1, parameters.shape2,
      parameters.w, parameters.waveMean, parameters.waveSigma,
    ];
    return expected_counts_from_parameters(edges, array, parameters.sQuadratureNodes ?? DEFAULT_S_QUADRATURE_NODES);
  },

  /*

  Purpose:
	Packages the raw fit result into the generic model-neutral shape --
	structurally identical to dean_jett's normalizeResult(), with waveFraction/
	waveArea/waveMean/waveSigma added alongside the shared fields.

  Input:
	rawResult [object]: the object returned by fit()

  Output:
	result [object]: the normalized, model-neutral fit result

  */
  normalizeResult(rawResult) {
    const { fit, edges, counts, regions, config, initialCenters } = rawResult;
    const named = paramsToNamed(fit.parameters);
    const peaks = peakComponents(edges, named);
    const sCounts = convolvedSPhaseWithProfile(
      edges,
      { sArea: named.sArea, g1Mean: named.g1Mean, g2Mean: named.g2Mean, broadeningCV: named.g1CV, profileFn: (z) => combined_profile(z, named) },
      config.sQuadratureNodes,
    );

    const components = [
      component_from_counts("g1", "G1 / 1C", peaks.g1, named.g1Area),
      component_from_counts("s", "S (complex S-phase model)", sCounts, named.sArea),
      component_from_counts("g2", "G2/M / 2C", peaks.g2, named.g2Area),
    ];

    const biologicalTotal = named.g1Area + named.sArea + named.g2Area;
    const phaseFractions = biologicalTotal > 0
      ? { g1: named.g1Area / biologicalTotal, s: named.sArea / biologicalTotal, g2: named.g2Area / biologicalTotal }
      : { g1: 0, s: 0, g2: 0 };

    const diagnostics = {
      ...buildPoissonFitDiagnostics({
        observedCounts: counts,
        expectedCounts: fit.expectedCounts,
        parameterCount: free_indices().length,
      }),
      optimizer: fit.optimizerDiagnostics,
    };

    const waveArea = named.w * named.sArea;

    // STAT-01: the single declared bound set. The audit, the boundary warnings,
    // and the result's published `bounds` all read THIS object, so a bound can
    // no longer exist in one place and be missing from another (the audited gap
    // was g1Mean/g2Mean, which were published but never warned about).
    const bounds = {
      g1Area: [0, Infinity],
      sArea: [0, Infinity],
      g2Area: [0, Infinity],
      g1CV: [config.cvMin, config.cvMax],
      g2CV: [config.cvMin, config.cvMax],
      g1Mean: [regions.g1.left, regions.g1.right],
      g2Mean: [regions.g2.left, regions.g2.right],
      w: [config.wMin, config.wMax],
      waveMean: [config.waveMeanMin, config.waveMeanMax],
      waveSigma: [config.waveSigmaMin, config.waveSigmaMax],
    };
    const constraintAudit = buildConstraintAudit({
      named, bounds, config, phaseFractions, contaminantFractions: {},
      profileMinimumFn: sPhaseProfileMinimum,
    });

    const warnings = [
      ...fitQualityWarnings(diagnostics),
      ...components
        .map((component) => tailMassWarning({
          componentId: component.id,
          componentLabel: component.label,
          totalArea: component.totalArea,
          observedDomainArea: component.observedDomainArea,
        }))
        .filter(Boolean),
      ...constraintAuditWarnings(constraintAudit),
    ];
    // A substantial wave means the S phase is not a smooth asynchronous
    // progression. It is reported as SHAPE evidence and nothing more: this model
    // must not be read as inferring synchronization (plan §1.1), and with the
    // peaks frozen a wave can also be absorbing peak misfit rather than a real
    // cohort (see the note above fit()).
    if (named.w >= WAVE_NOTICE_FRACTION) {
      warnings.push({
        code: "complex_s_phase_shape",
        severity: "info",
        message: `The S-phase profile is not smooth: ${(100 * named.w).toFixed(0)}% of the S area sits in a `
          + `narrow band near ${(100 * named.waveMean).toFixed(0)}% of the way from G1 to G2/M. `
          + `Reported as S-phase shape only — this model does not test for a synchronized population.`,
      });
    }

    return {
      schemaVersion: 1,
      modelId: "dean_jett_fox",
      modelVersion: "1.0.0",
      modelLabel: "Dean–Jett–Fox",
      kind: "generative",
      fitScope: "per_sample",
      comparisonGroup: "poisson_cell_cycle",

      converged: fit.converged,
      convergenceReason: convergence_reason(fit),
      parameters: { ...named, waveArea, sQuadratureNodes: config.sQuadratureNodes },
      bounds,
      constraintAudit,
      expectedCounts: fit.expectedCounts,
      components,
      phaseFractions,
      contaminantFractions: {},
      peakRegionMigration: {
        g1: named.g1Mean - initialCenters.g1,
        g2: named.g2Mean - initialCenters.g2,
      },
      diagnostics: {
        ...diagnostics,
        iterations: fit.iterations,
        finalLambda: fit.finalLambda,
        maxIterationsReached: fit.maxIterationsReached,
        bestStartIndex: fit.bestStartIndex,
        waveArea,
        restarts: fit.attempts.map((attempt) => ({
          startIndex: attempt.startIndex,
          deviance: attempt.deviance,
          converged: attempt.converged,
          iterations: attempt.iterations,
          w: attempt.parameters[PARAMETER_INDEX.W],
        })),
      },
      warnings,
      provenance: { rawResult },
      targetResults: [],
    };
  },
};
