// ============================================================================
// Watson Pragmatic cell-cycle decomposition (modeling plan §5.5).
//
// Unlike Dean-Jett/Dean-Jett-Fox, this is *not* one global generative
// likelihood fit over the whole histogram -- it is a `kind: "decomposition"`
// with `comparisonGroup: null` (plan §1.1/§5.5: "never rank it against
// DJ/DJF with ordinary AIC/BIC"). G1 and G2/M are each estimated locally and
// independently from only their own uncontaminated ("clean") flank; S-phase
// is not a separate parametric component at all -- it is whatever count is
// left over once both fitted peaks are subtracted back out of the raw data.
// Closed-form throughout (no iterative optimizer), matching "Pragmatic".
//
// Step 1 (plan step 1, G1's "clean" flank is the LEFT one -- nothing
// biological sits below G1, while rising S-phase contaminates the right):
// estimate G1's width from a one-sided flank measurement at height fraction
// h ("near 60% peak height"), the same formula peak_regions.js's
// estimateSigmaOneSidedWithinRegion() already implements for peak-region
// preview (reused here via estimatePeakFromRegion's heightFraction option):
//
//   sigma_G1 = leftFlankDistance(h) / sqrt(-2 ln h)
//   mu_G1    = argmax(smoothed counts) within region G1
//
// Step 2 (plan step 2, "locally fit G1 using an asymmetric window"): having
// fixed (mu_G1, sigma_G1) from the clean flank alone, re-estimate G1's area
// from a window around the peak that reaches further on the clean (left)
// side than the contaminated (right) side -- build_asymmetric_window() and
// refine_local_area() below:
//
//   N_G1 = sum(y_i - b_G1, i in window_G1) / sum(gaussianTemplate(mu_G1,sigma_G1)_i, i in window_G1)
//
// where b is the background floor read at the window's clean edge (MODEL-06 --
// see pedestal_at_clean_edge() below for why that edge and not another).
//
// Step 3 (plan step 3, "locally fit G2/M inside its assigned region"): the
// mirror-image procedure using region G2 and the RIGHT (clean) flank --
// nothing biological sits above G2/M, while S-phase approaching from below
// contaminates the left:
//
//   sigma_G2, mu_G2, N_G2  -- same two formulas above, cleanSide="right"
//
// G1_i and G2_i are then the usual integrated-Gaussian bin masses over the
// *entire* histogram domain (shared.js's gaussianBinMass would compute the
// identical formula; duplicated here via the same math/gaussian_bin_mass.js
// primitive rather than importing models/shared.js, since Watson shares no
// S-phase modeling machinery with DJ/DJF at all -- see this file's header).
//
// Step 4 (plan step 4): whatever observed count isn't explained by either
// fitted peak, clipped at zero -- not a parametric component, so unlike
// DJ/DJF's S it has no "true" area beyond what is actually in this sample:
//
//   S_i = max(0, y_i - G1_i - G2_i)
//
// Phase fractions still use total component areas (plan §5.1), with N_G1
// and N_G2 the two locally-fitted area parameters above and N_S simply the
// sum of the residual S_i:
//
//   p_G1 = N_G1/(N_G1+N_S+N_G2),  p_S = N_S/(...),  p_G2 = N_G2/(...)
// ============================================================================

import { gaussianBinMass } from "../../math/gaussian_bin_mass.js";
import { buildPoissonFitDiagnostics, fitQualityWarnings, tailMassWarning } from "../diagnostics.js";
import { buildConstraintAudit, constraintAuditWarnings } from "../constraint_audit.js";
import { validatePeakRegions, estimatePeakFromRegion } from "../peak_regions.js";

const EPS = 1e-12;

export const DEFAULT_CONFIG = Object.freeze({
  heightFraction: 0.6,          // plan step 1: "near 60% peak height"
  cleanWindowSigmas: 3,         // asymmetric window (plan step 2): reach on the clean flank
  contaminatedWindowSigmas: 1,  // asymmetric window: reach on the contaminated flank
  smoothingSigmaBins: 2,        // matches estimatePeakFromRegion's own default
});

/*

Purpose:
	Builds an asymmetric bin-index window around a local peak: it reaches
	cleanWindowSigmas on the uncontaminated flank but only
	contaminatedWindowSigmas on the flank nearer S-phase, so the area refit is
	dominated by the trustworthy side of the peak.

Input:
	peakIndex [number]: the peak's bin index
	sigmaBins [number]: the peak width in bins
	cleanSide [string]: which flank ("left"/"right") is uncontaminated
	config [object]: window-size config

Output:
	window [object]: the { start, end } bin-index window

*/
function build_asymmetric_window(peakIndex, sigmaBins, cleanSide, config, binCount) {
  const cleanReach = Math.max(1, Math.round(config.cleanWindowSigmas * sigmaBins));
  const contaminatedReach = Math.max(1, Math.round(config.contaminatedWindowSigmas * sigmaBins));
  const leftReach = cleanSide === "left" ? cleanReach : contaminatedReach;
  const rightReach = cleanSide === "right" ? cleanReach : contaminatedReach;
  return {
    start: Math.max(0, peakIndex - leftReach),
    end: Math.min(binCount - 1, peakIndex + rightReach),
  };
}

// MODEL-06: the floor the peak sits on, read at the CLEAN edge of the
// asymmetric window.
//
// refine_local_area() below divides summed counts by summed template mass, so
// every background count inside the window is scaled up and reported as peak
// area. Measured on synthetic fixtures with known component areas, an 800/bin
// flat background inflates N_G2 by +88% and N_G1 by +13% -- the pedestal is
// not a rounding term.
//
// WHERE to read it is the whole difficulty, and two plausible-looking choices
// are both wrong:
//
//   * The CONTAMINATED window edge (originally proposed for this item) sits
//     only contaminatedWindowSigmas -- one sigma -- from the centre, where a
//     Gaussian is still at 61% of its peak height. Subtracting that from every
//     bin removes most of the peak itself: measured -52% to -70% area error on
//     every fixture, turning a moderate over-count into a severe under-count.
//
//   * peak_regions.js's pedestalUnderPeak() (MODEL-05) reads the right place,
//     but returns 0 when the sample point falls outside the user's REGION. In
//     MODEL-05 that gate only reached sigma, where its effect stayed inside
//     tolerance. Routed into the area it reaches the phase fractions, and the
//     region-width invariant breaks outright: %S spread across region widths
//     measured 8.28pp against a 1.5pp tolerance, stepping exactly where the
//     gate flips. A peak region bounds the mean and nothing else -- see the
//     region-width tests in unit_tests_cell_cycle_dean_jett_fox.py.
//
// The clean window edge is MODEL-05's rule without MODEL-05's gate. It already
// sits at cleanWindowSigmas (3) from the centre -- far enough that a Gaussian
// has fallen to ~1% of peak -- and build_asymmetric_window() clamps it to the
// HISTOGRAM, never to the region, so it is available whatever the user
// dragged.
//
// That ~1% is not negligible, though, and reading the raw floor there is the
// third wrong answer: at 3 sigma a Gaussian is at exp(-4.5) = 1.11% of peak
// height, which for a typical G1 is ~2 counts/bin. Subtracting it treats the
// peak's own tail as background and biases every area low even in a histogram
// with no background at all -- measured -1.7pp on both peaks in the clean
// two-peak fixture, enough to push the SCI-01 bridge-free S-leakage bound
// (unit_tests_cell_cycle_watson_pragmatic.py) from 45.5 events to 72.1
// against a 66-event limit. So the tail is discounted first: the floor is
// min(counts_i - tail_i) over the edge bins, where tail is the provisional
// Gaussian evaluated with the un-subtracted area. That provisional area is
// itself background-inflated, so the tail is over-estimated and the pedestal
// errs LOW -- the estimator degrades toward doing nothing rather than toward
// eating the peak.
//
// Measured on the bridged fixture at 0/1/3/8 background counts per bin:
//
//   N_G2 error  +0.07 / +7.00 / +21.60 / +63.64%  before
//               +0.07 / +3.38 /  +4.84 /  +8.90%  after   (7.2x less drift)
//   N_G1 error  +0.72 / -1.00 /  +0.99 /  +5.90%  before
//               +0.72 / -1.96 /  -1.88 /  -1.74%  after
//
// At zero background the pedestal is exactly 0 and the estimator reduces to
// its pre-MODEL-06 self, so nothing that was already right moves. It also
// *improves* region invariance rather than costing it: %S spread across
// tight/default/wide regions at 8/bin goes 2.020pp -> 1.173pp, moving a
// pre-existing violation of the 1.5pp tolerance back inside it.
//
// The residual is S-phase mass inside the window, not background. No flat
// subtraction can remove it -- S is a ramp, not a pedestal -- and limiting it
// is precisely what the window's asymmetry is for. Restricting the window to
// the clean half was measured too: it buys a further 1-6pp but makes
// contaminatedWindowSigmas inert, so it is a window redesign rather than this
// item, and was not taken.
const PEDESTAL_EDGE_WINDOW_BINS = 2;

/*

Purpose:
	Estimates the background floor beneath a peak by reading the histogram at
	the uncontaminated edge of its asymmetric window -- a distance set by the
	peak's own width, and clamped to the histogram rather than to the region.

Input:
	edges [array]: bin edges
	counts [array]: per-bin counts
	window [object]: the asymmetric { start, end } window
	cleanSide [string]: which flank ("left"/"right") is uncontaminated
	mean [number]: the peak mean
	sigma [number]: the peak width
	peakArea [number]: provisional (un-subtracted) area, used to size the tail

Output:
	pedestal [number]: the floor to subtract, or 0 when there is none

*/
function pedestal_at_clean_edge(edges, counts, window, cleanSide, mean, sigma, peakArea) {
  const edgeIndex = cleanSide === "left" ? window.start : window.end;
  // What the peak itself contributes at the edge, so only what is left over is
  // called background.
  const tail = gaussianBinMass(edges, peakArea, mean, sigma);
  // Take the minimum over a couple of bins so one low-count bin of Poisson
  // noise cannot set the floor high; the minimum also errs downward, which
  // under-subtracts rather than eating into the peak.
  let floor = Infinity;
  const from = Math.max(0, edgeIndex - PEDESTAL_EDGE_WINDOW_BINS);
  const to = Math.min(counts.length - 1, edgeIndex + PEDESTAL_EDGE_WINDOW_BINS);
  for (let i = from; i <= to; i += 1) floor = Math.min(floor, counts[i] - tail[i]);
  return Number.isFinite(floor) && floor > 0 ? floor : 0;
}

/*

Purpose:
	Estimates a peak's area N (G1 or G2): the scale that makes a unit-area
	Gaussian template best match the observed counts summed over the asymmetric
	window -- a closed-form ratio estimator, not an iterative fit.

Input:
	counts [array]: per-bin counts
	window [object]: the asymmetric { start, end } window
	mean [number]: the peak mean
	sigma [number]: the peak width
	baseline [number]: the pedestal to subtract per bin (MODEL-06)

Output:
	area [number]: the estimated peak area

*/
function refine_local_area(edges, counts, mean, sigma, window, baseline = 0) {
  const unitTemplate = gaussianBinMass(edges, 1, mean, sigma);
  let observedSum = 0;
  let templateSum = 0;
  for (let i = window.start; i <= window.end; i += 1) {
    observedSum += Math.max(0, counts[i] - baseline);
    templateSum += unitTemplate[i];
  }
  return templateSum > EPS ? Math.max(0, observedSum / templateSum) : 0;
}

/*

Purpose:
	Locates one peak within its region using only the clean-side flank, then
	refits its area from the asymmetric window built around that estimate (the
	G1 procedure, or its mirror image for G2).

Input:
	edges [array]: histogram bin edges
	counts [array]: per-bin counts
	region [object]: the peak's region
	cleanSide [string]: the uncontaminated flank
	config [object]: model config

Output:
	peak [object]: { mean, sigma, area, ... } for the located peak

*/
export function fit_local_peak(edges, counts, region, cleanSide, config) {
  const local = estimatePeakFromRegion(edges, counts, region, {
    cleanSide,
    heightFraction: config.heightFraction,
    smoothingSigmaBins: config.smoothingSigmaBins,
  });
  const binWidth = edges[1] - edges[0];
  const sigmaBins = local.sigma / Math.max(EPS, binWidth);
  const window = build_asymmetric_window(local.peakIndex, sigmaBins, cleanSide, config, counts.length);
  // Two passes: the un-subtracted area sizes the peak's own tail, so the floor
  // read at the clean edge can be reduced to background alone (MODEL-06).
  const provisionalArea = refine_local_area(edges, counts, local.mean, local.sigma, window, 0);
  const pedestal = pedestal_at_clean_edge(
    edges, counts, window, cleanSide, local.mean, local.sigma, provisionalArea,
  );
  const area = refine_local_area(edges, counts, local.mean, local.sigma, window, pedestal);

  return {
    mean: local.mean,
    sigma: local.sigma,
    area,
    cv: local.sigma / Math.max(EPS, local.mean),
    peakIndex: local.peakIndex,
    window,
    pedestal,
  };
}

function sum(values) {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function component_from_counts(id, label, counts, totalArea) {
  return {
    id,
    label,
    role: "biological",
    counts,
    totalArea,
    observedDomainArea: sum(counts),
    includeInBiologicalDenominator: true,
  };
}

export const watson_pragmatic = {
  id: "watson_pragmatic",
  version: "1.0.0",
  label: "Watson Pragmatic",
  kind: "decomposition",
  fitScope: "per_sample",
  comparisonGroup: null, // plan §5.5: never AIC/BIC-ranked against DJ/DJF
  requiredInputs: ["sample_histogram", "peak_regions"],
  capabilities: { contaminants: false, multiplePloidy: false, autoComparison: false },
  defaultConfig: { ...DEFAULT_CONFIG },

  /*

  Purpose:
	Runs the pragmatic decomposition: locate and area-refit G1 and G2, then take
	S as the residual between the peaks. No optimizer, no multi-start -- every
	step is closed-form.

  Input:
	context [object]: { histogram (masked histogram: edges + counts/y),
	                  peakRegions { g1:{left,right}, g2:{left,right} },
	                  config (DEFAULT_CONFIG overrides) }

  Output:
	rawResult [object]: the raw decomposition result for normalizeResult()

  */
  fit(context) {
    const { histogram, peakRegions, config: userConfig = {} } = context;
    // onProgress/shouldCancel (live closures fit_worker.js injects into
    // every model's config, unused here since this fit is closed-form)
    // excluded from the merged `config` for the same reason as
    // dean_jett.js's fit(): that object is stored in the returned rawResult
    // (provenance.rawResult in the normalized result), which the worker
    // postMessages back, and a live function reference there fails
    // structured-clone.
    const { onProgress, shouldCancel, ...restUserConfig } = userConfig;
    const config = { ...DEFAULT_CONFIG, ...restUserConfig };
    const regions = validatePeakRegions(peakRegions);

    const edges = histogram.edges;
    const counts = Array.from(histogram.counts ?? histogram.y);
    if (!edges || edges.length !== counts.length + 1) {
      throw new Error("histogram.edges must have exactly one more entry than histogram.counts.");
    }

    const g1 = fit_local_peak(edges, counts, regions.g1, "left", config);
    const g2 = fit_local_peak(edges, counts, regions.g2, "right", config);

    const g1Counts = gaussianBinMass(edges, g1.area, g1.mean, g1.sigma);
    const g2Counts = gaussianBinMass(edges, g2.area, g2.mean, g2.sigma);
    // Plan step 4's formula (S_i = max(0, y_i - G1_i - G2_i)), but confined to
    // the S-phase interval strictly between the two fitted peak centers
    // (audit SCI-01). Residual mass below mu_G1 (sub-G1 debris) or above mu_G2
    // (post-G2 aggregates) overshoots its own fitted peak, not S phase, and
    // must not be reclassified as S -- the modeling plan defines residual S over
    // [mu_G1, mu_G2], not the whole histogram domain. Bins whose center falls at
    // or outside a peak center contribute zero residual S.
    // MODEL-08: Array.from(counts, fn) rather than counts.map(fn) -- .map() on a
    // typed array returns the SAME typed array type, silently truncating this
    // Gaussian-residual arithmetic to integers if counts is ever a typed array
    // (safe today only because dna_histogram.js hands back a plain Array;
    // PERF-01 would invite exactly that switch). Array.from always produces a
    // plain Array regardless of the input's type, so the fix is future-proof
    // rather than dependent on counts' current representation.
    const sCounts = Array.from(counts, (y, i) => {
      const center = 0.5 * (edges[i] + edges[i + 1]);
      if (center <= g1.mean || center >= g2.mean) return 0;
      return Math.max(0, y - g1Counts[i] - g2Counts[i]);
    });

    return { edges, counts, regions, config, g1, g2, g1Counts, g2Counts, sCounts };
  },

  /*

  Purpose:
	Not implemented, for the same reason as the retired legacy bridge's: S here is defined
	from the OBSERVED counts at fit time, not a standalone function of parameters,
	so there is no (edges, parameters) => expectedCounts closed form to offer.

  Input:
	(none)

  Output:
	value [null]: always null

  */
  expectedCounts() {
    return null;
  },

  /*

  Purpose:
	Packages the raw result into the generic model-neutral shape. kind:
	"decomposition" and comparisonGroup: null are what the UI/report/export
	layers must check before ever placing Watson next to a Dean-Jett/Dean-Jett-Fox
	AIC/BIC comparison -- this file does not enforce that at read time; it is a
	contract those consumers must honor.

  Input:
	rawResult [object]: the object returned by fit()

  Output:
	result [object]: the normalized, model-neutral fit result

  */
  normalizeResult(rawResult) {
    const { counts, g1, g2, g1Counts, g2Counts, sCounts } = rawResult;

    const components = [
      component_from_counts("g1", "G1 / 1C", g1Counts, g1.area),
      component_from_counts("s", "S (residual)", sCounts, sum(sCounts)),
      component_from_counts("g2", "G2/M / 2C", g2Counts, g2.area),
    ];

    const biologicalTotal = g1.area + sum(sCounts) + g2.area;
    const phaseFractions = biologicalTotal > 0
      ? { g1: g1.area / biologicalTotal, s: sum(sCounts) / biologicalTotal, g2: g2.area / biologicalTotal }
      : { g1: 0, s: 0, g2: 0 };

    // Expected = G1_i + S_i + G2_i can exceed y_i where the two locally-fitted
    // peaks alone already overshoot the observed count at a bin (S_i is
    // clipped to 0 there rather than going negative) -- an expected property
    // of a decomposition, not a bug; the diagnostics below make any such
    // systematic overshoot visible rather than hiding it.
    const expectedCounts = g1Counts.map((value, i) => value + sCounts[i] + g2Counts[i]);
    const diagnostics = buildPoissonFitDiagnostics({
      observedCounts: counts,
      expectedCounts,
      parameterCount: 6, // g1Area/g1Mean/g1CV + g2Area/g2Mean/g2CV, estimated (not jointly optimized)
    });

    // STAT-01: a decomposition optimizes nothing, so it declares no box bounds --
    // but the composition it reports is still subject to the joint feasibility
    // conditions, and the audit records them explicitly rather than skipping the
    // model. (Watson Pragmatic models no contaminant, so that set is empty by
    // construction, which the audit states rather than omits.)
    const constraintAudit = buildConstraintAudit({
      named: { g1Mean: g1.mean, g2Mean: g2.mean },
      bounds: {},
      config: { ratioMode: "free" },
      phaseFractions,
      contaminantFractions: {},
    });

    const warnings = [
      ...fitQualityWarnings(diagnostics),
      ...components
        .filter((component) => component.id !== "s") // S has no "true" area beyond the data; tail-mass framing doesn't apply
        .map((component) => tailMassWarning({
          componentId: component.id,
          componentLabel: component.label,
          totalArea: component.totalArea,
          observedDomainArea: component.observedDomainArea,
        }))
        .filter(Boolean),
      ...constraintAuditWarnings(constraintAudit),
    ];

    return {
      schemaVersion: 1,
      modelId: "watson_pragmatic",
      modelVersion: "1.0.0",
      modelLabel: "Watson Pragmatic",
      kind: "decomposition",
      fitScope: "per_sample",
      comparisonGroup: null,

      converged: false, // no optimizer ran; completion and scientific validity are separate
      decompositionCompleted: true,
      convergenceReason: "not_applicable_closed_form",
      parameters: { g1Area: g1.area, g1Mean: g1.mean, g1CV: g1.cv, g2Area: g2.area, g2Mean: g2.mean, g2CV: g2.cv },
      bounds: {},
      constraintAudit,
      expectedCounts,
      components,
      phaseFractions,
      contaminantFractions: {},
      peakRegionMigration: {}, // no optimizer moved anything from an initial guess; there is only this one closed-form estimate
      // MODEL-06: the per-bin background subtracted from each peak's area, so a
      // reader can see how much of the correction was pedestal.
      diagnostics: {
        ...diagnostics,
        g1Window: g1.window,
        g2Window: g2.window,
        g1Pedestal: g1.pedestal,
        g2Pedestal: g2.pedestal,
      },
      warnings,
      provenance: { rawResult },
      targetResults: [],
    };
  },
};
