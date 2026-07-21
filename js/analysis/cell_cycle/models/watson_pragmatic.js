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
//   N_G1 = sum(y_i, i in window_G1) / sum(gaussianTemplate(mu_G1,sigma_G1)_i, i in window_G1)
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
import { validatePeakRegions, estimatePeakFromRegion } from "../peak_regions.js";

const EPS = 1e-12;

export const DEFAULT_CONFIG = Object.freeze({
  heightFraction: 0.6,          // plan step 1: "near 60% peak height"
  cleanWindowSigmas: 3,         // asymmetric window (plan step 2): reach on the clean flank
  contaminatedWindowSigmas: 1,  // asymmetric window: reach on the contaminated flank
  smoothingSigmaBins: 2,        // matches estimatePeakFromRegion's own default
});

/**
 * Bin-index window around a local peak, asymmetric per plan step 2: reaches
 * `cleanWindowSigmas` on the uncontaminated flank but only
 * `contaminatedWindowSigmas` on the flank nearer to S-phase, so the area
 * refit below is dominated by the trustworthy side of the peak.
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

/**
 * N_G1 (or N_G2): the area that makes a unit-area Gaussian template best
 * match the observed counts summed only over the asymmetric window -- a
 * closed-form ratio estimator, not an iterative fit, per "Pragmatic".
 */
function refine_local_area(edges, counts, mean, sigma, window) {
  const unitTemplate = gaussianBinMass(edges, 1, mean, sigma);
  let observedSum = 0;
  let templateSum = 0;
  for (let i = window.start; i <= window.end; i += 1) {
    observedSum += counts[i];
    templateSum += unitTemplate[i];
  }
  return templateSum > EPS ? Math.max(0, observedSum / templateSum) : 0;
}

/** Steps 1-2 (or the mirror-image step 3) for one peak: locate it within its
 * region using only the clean-side flank, then refit its area from the
 * asymmetric window built around that estimate. */
function fit_local_peak(edges, counts, region, cleanSide, config) {
  const local = estimatePeakFromRegion(edges, counts, region, {
    cleanSide,
    heightFraction: config.heightFraction,
    smoothingSigmaBins: config.smoothingSigmaBins,
  });
  const binWidth = edges[1] - edges[0];
  const sigmaBins = local.sigma / Math.max(EPS, binWidth);
  const window = build_asymmetric_window(local.peakIndex, sigmaBins, cleanSide, config, counts.length);
  const area = refine_local_area(edges, counts, local.mean, local.sigma, window);

  return {
    mean: local.mean,
    sigma: local.sigma,
    area,
    cv: local.sigma / Math.max(EPS, local.mean),
    peakIndex: local.peakIndex,
    window,
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

  /** context: { histogram: Stage4-shaped (edges + counts/y), peakRegions:
   * { g1: {left,right}, g2: {left,right} }, config: DEFAULT_CONFIG overrides }.
   * No optimizer, no multi-start: every step is closed-form. */
  fit(context) {
    const { histogram, peakRegions, config: userConfig = {} } = context;
    const config = { ...DEFAULT_CONFIG, ...userConfig };
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
    // Plan step 4's formula, evaluated at every bin (not just each peak's
    // own local window).
    const sCounts = counts.map((y, i) => Math.max(0, y - g1Counts[i] - g2Counts[i]));

    return { edges, counts, regions, config, g1, g2, g1Counts, g2Counts, sCounts };
  },

  /** Not implemented, for the same reason as legacy_bridge_v1's: S here is
   * defined from the *observed* counts at fit time (plan step 4), not from a
   * standalone function of parameters alone, so there is no
   * (edges, parameters) => expectedCounts closed form to offer. */
  expectedCounts() {
    return null;
  },

  /**
   * Packages fit()'s raw result into the generic §4.5 shape. `kind:
   * "decomposition"` and `comparisonGroup: null` are what the UI/report/
   * export layers must check before ever placing Watson next to a DJ/DJF
   * AIC/BIC comparison (plan §5.5) -- this file does not additionally
   * enforce that at read time; it is a contract those consumers must honor.
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
    ];

    return {
      schemaVersion: 1,
      modelId: "watson_pragmatic",
      modelVersion: "1.0.0",
      modelLabel: "Watson Pragmatic",
      kind: "decomposition",
      fitScope: "per_sample",
      comparisonGroup: null,

      converged: true, // closed-form: "succeeds" unless fit() threw (e.g. infeasible regions)
      convergenceReason: "closed_form",
      parameters: { g1Area: g1.area, g1Mean: g1.mean, g1CV: g1.cv, g2Area: g2.area, g2Mean: g2.mean, g2CV: g2.cv },
      bounds: {},
      expectedCounts,
      components,
      phaseFractions,
      contaminantFractions: {},
      peakRegionMigration: {}, // no optimizer moved anything from an initial guess; there is only this one closed-form estimate
      diagnostics: { ...diagnostics, g1Window: g1.window, g2Window: g2.window },
      warnings,
      provenance: { rawResult },
      targetResults: [],
    };
  },
};
