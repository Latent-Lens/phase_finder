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
//   reject theta when min_{z in [0,1]} q(z) < 0         (same as DJ, projectQuadraticProfile)
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
  quadraticProfile,
  projectQuadraticProfile,
  DEFAULT_S_QUADRATURE_NODES,
} from "./shared.js";
import { normalCdf, normalPdf } from "../../math/gaussian_bin_mass.js";
import { fitPoissonModel } from "../fit_engine.js";
import { buildPoissonFitDiagnostics, fitQualityWarnings, tailMassWarning, boundaryHitWarnings } from "../diagnostics.js";
import { validatePeakRegions, estimatePeakFromRegion } from "../peak_regions.js";
import { clamp } from "../../math/stats.js";

const EPS = 1e-12;

// theta_F's array position for every component of the formula block above.
const PARAMETER_INDEX = Object.freeze({
  G1_AREA: 0, G1_MEAN: 1, G1_CV: 2,
  G2_AREA: 3, G2_MEAN: 4, G2_CV: 5,
  S_AREA: 6, B: 7, C: 8,
  W: 9,          // w
  WAVE_MEAN: 10, // m_W
  WAVE_SIGMA: 11, // s_W
});

export const DEFAULT_CONFIG = Object.freeze({
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
    b: parameters[PARAMETER_INDEX.B],
    c: parameters[PARAMETER_INDEX.C],
    w: parameters[PARAMETER_INDEX.W],
    waveMean: parameters[PARAMETER_INDEX.WAVE_MEAN],
    waveSigma: parameters[PARAMETER_INDEX.WAVE_SIGMA],
  };
}

/** T(z; m_W, s_W): a normal density renormalized so its own mass over [0,1]
 * integrates to exactly 1 -- the wave term of q_F(z) above. Returns 0 (not
 * NaN) when waveSigma places essentially all mass outside [0,1], since that
 * degenerate placement should contribute nothing rather than blow up. */
function wave_profile(z, waveMean, waveSigma) {
  const sigma = Math.max(Math.abs(waveSigma), EPS);
  const normalization = normalCdf(1, waveMean, sigma) - normalCdf(0, waveMean, sigma);
  if (!(normalization > EPS)) return 0;
  return normalPdf(z, waveMean, sigma) / normalization;
}

/** q_F(z) = (1-w)*q(z) + w*T(z; m_W, s_W) -- the formula block's blended profile. */
function combined_profile(z, named) {
  const base = (1 - named.w) * quadraticProfile(z, named.b, named.c);
  if (!(named.w > 0)) return base; // w=0 nesting: skip evaluating T(z) entirely, not just multiply by 0
  return base + named.w * wave_profile(z, named.waveMean, named.waveSigma);
}

/**
 * lambda_i(theta_F) = G1_i + S_i + G2_i, with S_i using q_F(z). The only
 * place this file evaluates the full expected-count model; G1_i/G2_i and the
 * broadening integral itself are delegated to shared.js exactly as in
 * Dean-Jett.
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

function project_means(g1Mean, g2Mean, regions, config) {
  if (config.ratioMode === "locked") {
    const ratio = config.lockedRatio;
    const lo = Math.max(regions.g1.left, regions.g2.left / ratio);
    const hi = Math.min(regions.g1.right, regions.g2.right / ratio);
    const mu1 = clamp(g1Mean, lo, hi);
    return { g1Mean: mu1, g2Mean: ratio * mu1 };
  }

  const mu1 = clamp(g1Mean, regions.g1.left, regions.g1.right);
  let mu2 = clamp(g2Mean, regions.g2.left, regions.g2.right);
  if (config.ratioMode === "bounded") {
    const [ratioMin, ratioMax] = config.fitRatioRange;
    const ratio = mu2 / mu1;
    if (ratio < ratioMin) mu2 = clamp(ratioMin * mu1, regions.g2.left, regions.g2.right);
    else if (ratio > ratioMax) mu2 = clamp(ratioMax * mu1, regions.g2.left, regions.g2.right);
  }
  return { g1Mean: mu1, g2Mean: mu2 };
}

function make_project_fn(regions, config) {
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

    // q(z) must stay valid on its own (see shared.js's projectQuadraticProfile
    // doc): q_F only stays nonnegative when q does, since T(z) >= 0 already.
    const [b, c] = projectQuadraticProfile(projected[PARAMETER_INDEX.B], projected[PARAMETER_INDEX.C]);
    projected[PARAMETER_INDEX.B] = b;
    projected[PARAMETER_INDEX.C] = c;

    // The wave's own feasible domain -- not part of the emission model, the
    // region the optimizer may search for w, m_W, s_W.
    projected[PARAMETER_INDEX.W] = clamp(projected[PARAMETER_INDEX.W], config.wMin, config.wMax);
    projected[PARAMETER_INDEX.WAVE_MEAN] = clamp(projected[PARAMETER_INDEX.WAVE_MEAN], config.waveMeanMin, config.waveMeanMax);
    projected[PARAMETER_INDEX.WAVE_SIGMA] = clamp(Math.abs(projected[PARAMETER_INDEX.WAVE_SIGMA]), config.waveSigmaMin, config.waveSigmaMax);

    return projected;
  };
}

function free_indices(config) {
  const indices = [
    PARAMETER_INDEX.G1_AREA, PARAMETER_INDEX.G1_MEAN, PARAMETER_INDEX.G1_CV,
    PARAMETER_INDEX.G2_AREA, PARAMETER_INDEX.S_AREA,
    PARAMETER_INDEX.B, PARAMETER_INDEX.C,
    PARAMETER_INDEX.W, PARAMETER_INDEX.WAVE_MEAN, PARAMETER_INDEX.WAVE_SIGMA,
  ];
  if (config.cvMode !== "equal") indices.push(PARAMETER_INDEX.G2_CV);
  if (config.ratioMode !== "locked") indices.push(PARAMETER_INDEX.G2_MEAN);
  return indices;
}

function estimate_between_peaks_area(edges, counts, regions) {
  let total = 0;
  for (let i = 0; i < counts.length; i += 1) {
    const center = 0.5 * (edges[i] + edges[i + 1]);
    if (center > regions.g1.right && center < regions.g2.left) total += counts[i];
  }
  return Math.max(1, total);
}

function assert_ratio_feasible(regions, config) {
  if (config.ratioMode === "locked") {
    const ratio = config.lockedRatio;
    const lo = Math.max(regions.g1.left, regions.g2.left / ratio);
    const hi = Math.min(regions.g1.right, regions.g2.right / ratio);
    if (!(lo <= hi)) {
      throw new Error(`The locked G2:G1 ratio (${ratio}) is infeasible for the current peak regions.`);
    }
    return;
  }
  if (config.ratioMode === "bounded") {
    const achievableLow = regions.g2.left / regions.g1.right;
    const achievableHigh = regions.g2.right / regions.g1.left;
    const [ratioMin, ratioMax] = config.fitRatioRange;
    if (!(achievableLow <= ratioMax && achievableHigh >= ratioMin)) {
      throw new Error(
        `No G2:G1 ratio in [${ratioMin}, ${ratioMax}] is achievable from the current peak regions ` +
          `(achievable range [${achievableLow.toFixed(3)}, ${achievableHigh.toFixed(3)}]).`,
      );
    }
  }
}

// A small deterministic grid of wave placements (waveMean x waveSigma) used
// to seed both the region-based and djHint-based starts below. z in [0,1] is
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

/**
 * Deterministic theta_F,0 candidates (plan §5.7: "run deterministic multiple
 * starts for DJF ... from comparable starts"). Region-based starts 1-3 mirror
 * Dean-Jett's own starts exactly with w=0; the WAVE_PLACEMENT_GRID starts
 * activate a modest wave at each grid placement from the outset so a real
 * wave isn't only reachable by climbing out of the w=0 plateau -- and isn't
 * missed just because it doesn't happen to sit near one single guessed
 * placement.
 *
 * When `djHint` (Dean-Jett's own *converged, fitted* named parameters) is
 * supplied, it seeds an additional w=0 start built from DJ's actual optimum
 * rather than a fresh region-only estimate, plus the same wave-placement
 * grid built around it. The w=0 djHint start is a correctness property, not
 * just a quality tweak: since q_F(z)|_{w=0} = q(z) exactly (see this file's
 * formula block), DJF's feasible parameter space always *contains* DJ's
 * exact solution -- without this start, DJF's independently-derived region
 * estimate can converge to a worse local optimum than DJ reached, which
 * should never happen given the nesting. Passing this hint is how
 * "comparable starts" is satisfied instead of merely asserted.
 */
function build_parameter_starts(edges, counts, regions, config, djHint = null) {
  const g1Init = estimatePeakFromRegion(edges, counts, regions.g1, { label: "G1" });
  const g2Init = estimatePeakFromRegion(edges, counts, regions.g2, { label: "G2/M" });

  let g1CV = clamp(g1Init.cv, config.cvMin, config.cvMax);
  let g2CV = clamp(g2Init.cv, config.cvMin, config.cvMax);
  if (config.cvMode === "equal") g2CV = g1CV;

  const { g1Mean, g2Mean } = project_means(g1Init.mean, g2Init.mean, regions, config);
  const sAreaGuess = estimate_between_peaks_area(edges, counts, regions);

  const base = [
    Math.max(1, g1Init.area), g1Mean, g1CV,
    Math.max(1, g2Init.area), g2Mean, g2CV,
    sAreaGuess, 0, 0,
    0, 0.5, 0.15, // w=0, neutral (inactive) wave placement
  ];

  const starts = [
    base,
    [...base.slice(0, PARAMETER_INDEX.B), 0.8, -0.5, 0, 0.5, 0.15],
    [...base.slice(0, PARAMETER_INDEX.B), -0.8, -0.5, 0, 0.5, 0.15],
    ...WAVE_PLACEMENT_GRID.map(([waveMean, waveSigma]) => [...base.slice(0, PARAMETER_INDEX.B), 0, 0, 0.25, waveMean, waveSigma]),
  ];

  if (djHint) {
    const fromDj = [
      djHint.g1Area, djHint.g1Mean, djHint.g1CV,
      djHint.g2Area, djHint.g2Mean, djHint.g2CV,
      djHint.sArea, djHint.b, djHint.c,
      0, 0.5, 0.15, // w=0: identically DJ's own optimum, the nesting guarantee
    ];
    starts.push(
      fromDj,
      ...WAVE_PLACEMENT_GRID.map(([waveMean, waveSigma]) => [...fromDj.slice(0, PARAMETER_INDEX.W), 0.25, waveMean, waveSigma]),
    );
  }

  return starts;
}

function convergence_reason(fit) {
  if (fit.cancelled) return "cancelled";
  if (fit.converged) return "relative_deviance_and_step";
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

  /**
   * context: same shape as dean_jett's fit(), plus an optional
   * context.config.djHint -- Dean-Jett's own normalized `parameters` object
   * (fitted, not the default config) -- that seeds an additional,
   * nesting-guaranteed start. See build_parameter_starts() for why. Callers
   * fitting DJF standalone (not through auto_dj_djf) may simply omit it;
   * model_selection.js's auto_dj_djf always supplies it.
   */
  fit(context) {
    const { histogram, peakRegions, config: userConfig = {} } = context;
    // onProgress/shouldCancel excluded from the merged `config` for the same
    // reason as dean_jett.js's fit(): that object is stored in the returned
    // rawResult (provenance.rawResult), which the worker postMessages back,
    // and a live function reference there fails structured-clone.
    const { djHint = null, onProgress, shouldCancel, ...restConfig } = userConfig;
    const config = { ...DEFAULT_CONFIG, ...restConfig };
    const regions = validatePeakRegions(peakRegions);
    assert_ratio_feasible(regions, config);

    const edges = histogram.edges;
    const counts = Array.from(histogram.counts ?? histogram.y);
    if (!edges || edges.length !== counts.length + 1) {
      throw new Error("histogram.edges must have exactly one more entry than histogram.counts.");
    }

    const parameterStarts = build_parameter_starts(edges, counts, regions, config, djHint);
    const projectFn = make_project_fn(regions, config);
    const freeIndices = free_indices(config);

    const fit = fitPoissonModel({
      observedCounts: counts,
      parameterStarts: parameterStarts.map(projectFn),
      freeIndices,
      expectedCountsFn: (parameters) => expected_counts_from_parameters(edges, parameters, config.sQuadratureNodes),
      projectFn,
      options: {
        maxIterations: config.maxIterations,
        tolerance: config.tolerance,
        stepTolerance: config.stepTolerance,
        initialLambda: config.initialLambda,
        finiteDifferenceStep: config.finiteDifferenceStep,
        onProgress,
        shouldCancel,
      },
    });

    return {
      fit, edges, counts, regions, config,
      initialCenters: { g1: parameterStarts[0][PARAMETER_INDEX.G1_MEAN], g2: parameterStarts[0][PARAMETER_INDEX.G2_MEAN] },
    };
  },

  /** lambda_i(theta_F) at arbitrary edges -- see dean_jett.js's expectedCounts
   * for why this takes the named-parameter shape, not the raw fit array. */
  expectedCounts(edges, parameters) {
    const array = [
      parameters.g1Area, parameters.g1Mean, parameters.g1CV,
      parameters.g2Area, parameters.g2Mean, parameters.g2CV,
      parameters.sArea, parameters.b, parameters.c,
      parameters.w, parameters.waveMean, parameters.waveSigma,
    ];
    return expected_counts_from_parameters(edges, array, parameters.sQuadratureNodes ?? DEFAULT_S_QUADRATURE_NODES);
  },

  /**
   * Packages fit()'s raw result into the generic §4.5 shape -- structurally
   * identical to dean_jett.js's normalizeResult(), with waveFraction/
   * waveArea/waveMean/waveSigma added to parameters/diagnostics so
   * model_selection.js can read them without re-deriving anything from the
   * raw fit.
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

    const diagnostics = buildPoissonFitDiagnostics({
      observedCounts: counts,
      expectedCounts: fit.expectedCounts,
      parameterCount: free_indices(config).length,
    });

    const waveArea = named.w * named.sArea;
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
      ...boundaryHitWarnings(named, {
        g1CV: { min: config.cvMin, max: config.cvMax },
        g2CV: { min: config.cvMin, max: config.cvMax },
        w: { min: config.wMin, max: config.wMax },
        waveMean: { min: config.waveMeanMin, max: config.waveMeanMax },
        waveSigma: { min: config.waveSigmaMin, max: config.waveSigmaMax },
      }),
    ];

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
      bounds: {
        g1CV: [config.cvMin, config.cvMax],
        g2CV: [config.cvMin, config.cvMax],
        g1Mean: [regions.g1.left, regions.g1.right],
        g2Mean: [regions.g2.left, regions.g2.right],
        w: [config.wMin, config.wMax],
        waveMean: [config.waveMeanMin, config.waveMeanMax],
        waveSigma: [config.waveSigmaMin, config.waveSigmaMax],
      },
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
