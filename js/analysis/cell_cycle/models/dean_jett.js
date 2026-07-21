// ============================================================================
// Dean-Jett generative cell-cycle model (modeling plan §5.1-§5.3, §6.2).
//
// Parameter vector theta (this file's PARAMETER_INDEX order below):
//   N_G1 (g1Area), mu1 (g1Mean), CV1 (g1CV),
//   N_G2 (g2Area), mu2 (g2Mean), CV2 (g2CV),
//   N_S  (sArea),  b, c     <- quadratic S-phase occupancy profile shape
//
// Observation model -- raw integer histogram counts, Poisson per bin i
// (plan §5.1; log(y!) term omitted, it cancels in every comparison):
//
//   -logL(theta) = sum_i [ lambda_i(theta) - y_i * log(lambda_i(theta)) ]
//
// This file never evaluates -logL directly. fit_engine.js instead minimizes
// the sum of squared Poisson *deviance* residuals, which equals total
// deviance = 2*[logL(saturated) - logL(theta)] -- a monotonic, better-
// conditioned stand-in for the same likelihood (plan §5.7). See fit() below.
//
// Expected count per bin -- the model being fit:
//
//   lambda_i(theta) = G1_i(theta) + S_i(theta) + G2_i(theta)
//
// G1 / G2 peaks: each an area-parameterized Gaussian integrated exactly over
// bin i, sigma_k = CV_k * mu_k (plan §5.2; implemented once in shared.js's
// peakComponents(), reused here as G1_i and G2_i):
//
//   Gk_i = N_k * [ Phi((b_{i+1}-mu_k)/sigma_k) - Phi((b_i-mu_k)/sigma_k) ]
//
// Dean-Jett S phase: a normalized quadratic occupancy profile q(z) over the
// latent DNA position u(z) between the two peaks, broadened by a
// G1-CV-scaled Gaussian at every z and integrated over z in [0,1] (plan
// §5.3; implemented once in shared.js's convolvedSPhase(), reused here as
// S_i):
//
//   u(z) = mu1 + z*(mu2-mu1),                          z in [0,1]
//   q(z) = a + b*z + c*z^2,    a = 1 - b/2 - c/3        (integral(q,0..1)=1)
//   reject theta when min_{z in [0,1]} q(z) < 0         (isQuadraticProfileValid)
//   S_i = N_S * integral_0^1 q(z) *
//           [ Phi((b_{i+1}-u(z))/(CV1*u(z))) - Phi((b_i-u(z))/(CV1*u(z))) ] dz
//
// Biological phase fractions use total (not observed-domain-truncated)
// component areas (plan §5.1):
//
//   p_G1 = N_G1 / (N_G1+N_S+N_G2),  p_S = N_S / (...),  p_G2 = N_G2 / (...)
//
// Gk_i and S_i are implemented once in models/shared.js and reused here;
// *this* file owns theta's parameterization, its feasible region (peak-
// region + ratio + CV-mode constraints, plan §6.2 -- not part of the
// closed-form emission model above, but the domain the optimizer is allowed
// to search), deterministic initialization/multi-start, and the generic-
// result (plan §4.5) packaging around fit_engine.js's optimizer.
// ============================================================================

import { peakComponents, convolvedSPhase, projectQuadraticProfile, DEFAULT_S_QUADRATURE_NODES } from "./shared.js";
import { fitPoissonModel } from "../fit_engine.js";
import { buildPoissonFitDiagnostics, fitQualityWarnings, tailMassWarning, boundaryHitWarnings } from "../diagnostics.js";
import { validatePeakRegions, estimatePeakFromRegion } from "../peak_regions.js";
import { clamp } from "../../math/stats.js";

// theta's array position for every component of the formula block above.
const PARAMETER_INDEX = Object.freeze({
  G1_AREA: 0, // N_G1
  G1_MEAN: 1, // mu1
  G1_CV: 2,   // CV1 (also drives the S-phase broadening: convolvedSPhase's broadeningCV)
  G2_AREA: 3, // N_G2
  G2_MEAN: 4, // mu2
  G2_CV: 5,   // CV2
  S_AREA: 6,  // N_S
  B: 7,       // b
  C: 8,       // c
});
const PARAMETER_COUNT = 9;

export const DEFAULT_CONFIG = Object.freeze({
  ratioMode: "bounded", // "free" | "bounded" | "locked" -- constrains mu2/mu1, not part of the emission model itself
  fitRatioRange: [1.65, 2.25],
  lockedRatio: 2,
  cvMode: "free", // "free" | "equal" -- "equal" ties CV2 = CV1
  cvMin: 0.01,
  cvMax: 0.30,
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
  };
}

/**
 * lambda_i(theta) = G1_i + S_i + G2_i. The only place this file evaluates
 * the full expected-count model; every G1_i/S_i/G2_i term is delegated to
 * shared.js so the equations exist in exactly one place.
 */
function expected_counts_from_parameters(edges, parameters, quadratureNodes) {
  const named = paramsToNamed(parameters);
  const peaks = peakComponents(edges, named);
  const sCounts = convolvedSPhase(
    edges,
    { sArea: named.sArea, g1Mean: named.g1Mean, g2Mean: named.g2Mean, broadeningCV: named.g1CV, b: named.b, c: named.c },
    quadratureNodes,
  );
  const expected = new Array(peaks.g1.length);
  for (let i = 0; i < expected.length; i += 1) {
    expected[i] = peaks.g1[i] + sCounts[i] + peaks.g2[i];
  }
  return expected;
}

/**
 * Feasible domain for (mu1, mu2) -- plan §6.2's region + ratio-mode
 * constraints. Not part of the emission model: this is where in theta-space
 * the optimizer is allowed to look, independent of how well any particular
 * (mu1, mu2) explains the counts.
 */
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

// Feasible domain for (b, c) -- enforces isQuadraticProfileValid(b, c), i.e.
// min_{z in [0,1]} q(z) >= 0, per plan §5.3's explicit rejection rule. Lives
// in shared.js (projectQuadraticProfile) since Dean-Jett-Fox projects the
// same (b, c) pair the same way before blending in its wave term.
const project_quadratic = projectQuadraticProfile;

/** Full theta projection: every parameter's feasible domain, all in one place. */
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

    const [b, c] = project_quadratic(projected[PARAMETER_INDEX.B], projected[PARAMETER_INDEX.C]);
    projected[PARAMETER_INDEX.B] = b;
    projected[PARAMETER_INDEX.C] = c;
    return projected;
  };
}

/** Which theta indices the optimizer may move -- a locked ratio or equal-CV
 * mode removes the derived parameter from here entirely (it still exists in
 * theta and gets set by projectFn every iteration, but the LM Jacobian never
 * probes it directly), rather than leaving it "free" and hoping projection
 * undoes the step. */
function free_indices(config) {
  const indices = [
    PARAMETER_INDEX.G1_AREA,
    PARAMETER_INDEX.G1_MEAN,
    PARAMETER_INDEX.G1_CV,
    PARAMETER_INDEX.G2_AREA,
    PARAMETER_INDEX.S_AREA,
    PARAMETER_INDEX.B,
    PARAMETER_INDEX.C,
  ];
  if (config.cvMode !== "equal") indices.push(PARAMETER_INDEX.G2_CV);
  if (config.ratioMode !== "locked") indices.push(PARAMETER_INDEX.G2_MEAN);
  return indices;
}

/** Sum of raw counts whose bin center falls strictly between the two
 * accepted peak regions -- a rough N_S seed, not itself part of the model. */
function estimate_between_peaks_area(edges, counts, regions) {
  let total = 0;
  for (let i = 0; i < counts.length; i += 1) {
    const center = 0.5 * (edges[i] + edges[i + 1]);
    if (center > regions.g1.right && center < regions.g2.left) total += counts[i];
  }
  return Math.max(1, total);
}

/**
 * Checks the plan §6.2 ratio-mode feasibility conditions against the
 * accepted regions before spending any optimizer time. Mirrors the "If a
 * constraint is infeasible, disable Fit and explain it inline" rule -- this
 * is the model layer's half of that (a clear thrown error the caller
 * surfaces), not a UI concern.
 */
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

/**
 * Deterministic theta_0 candidates (plan §5.7: "run deterministic multiple
 * starts for DJF and difficult DJ fits"). The base start seeds G1/G2 from
 * each region's local estimate and the flat S profile (b=c=0); the others
 * perturb the S-phase shape/area to escape the flat profile's degenerate
 * gradient near b=c=0, not because those values are more plausible a priori.
 */
function build_parameter_starts(edges, counts, regions, config) {
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
  ];

  return [
    base,
    [...base.slice(0, PARAMETER_INDEX.B), 0.8, -0.5],
    [...base.slice(0, PARAMETER_INDEX.B), -0.8, -0.5],
    (() => {
      const wider = [...base];
      wider[PARAMETER_INDEX.S_AREA] = sAreaGuess * 1.5;
      return wider;
    })(),
  ];
}

function convergence_reason(fit) {
  if (fit.cancelled) return "cancelled";
  if (fit.converged) return "relative_deviance_and_step";
  return fit.maxIterationsReached ? "max_iterations" : "unknown";
}

function component_from_counts(id, label, counts, areaParameter, role = "biological") {
  const observedDomainArea = counts.reduce((sum, value) => sum + value, 0);
  return {
    id,
    label,
    role,
    counts,
    totalArea: areaParameter, // N_k itself -- the *true* area, not truncated by the histogram domain
    observedDomainArea,
    includeInBiologicalDenominator: role === "biological",
  };
}

export const dean_jett = {
  id: "dean_jett",
  version: "1.0.0",
  label: "Dean–Jett",
  kind: "generative",
  fitScope: "per_sample",
  comparisonGroup: "poisson_cell_cycle",
  requiredInputs: ["sample_histogram", "peak_regions"],
  capabilities: { contaminants: false, multiplePloidy: false, autoComparison: true },
  defaultConfig: { ...DEFAULT_CONFIG },

  /**
   * context: { histogram: Stage4-shaped (edges + counts/y), peakRegions:
   * { g1: {left,right}, g2: {left,right} }, config: DEFAULT_CONFIG overrides }.
   * Builds theta_0, minimizes total Poisson deviance (the sum-of-squares
   * stand-in for -logL(theta) from the formula block above) via
   * fit_engine.js, and returns the raw fit_engine result plus everything
   * normalizeResult() needs.
   */
  fit(context) {
    const { histogram, peakRegions, config: userConfig = {} } = context;
    // onProgress/shouldCancel are live closures fit_worker.js injects into
    // every model's config -- excluded from the merged `config` below since
    // that object gets stored in the returned rawResult (provenance.rawResult
    // in the normalized result), which the worker then postMessages back;
    // a function reference there fails structured-clone. Read separately for
    // the LM call itself instead.
    const { onProgress, shouldCancel, ...restUserConfig } = userConfig;
    const config = { ...DEFAULT_CONFIG, ...restUserConfig };
    const regions = validatePeakRegions(peakRegions);
    assert_ratio_feasible(regions, config);

    const edges = histogram.edges;
    const counts = Array.from(histogram.counts ?? histogram.y);
    if (!edges || edges.length !== counts.length + 1) {
      throw new Error("histogram.edges must have exactly one more entry than histogram.counts.");
    }

    const parameterStarts = build_parameter_starts(edges, counts, regions, config);
    const projectFn = make_project_fn(regions, config);
    const freeIndices = free_indices(config);

    // Minimizing sum(poissonDevianceResiduals^2) == minimizing total Poisson
    // deviance == (up to the additive saturated-model constant that cancels
    // in every comparison) minimizing -logL(theta) from the formula block
    // above -- this is the "matches the count likelihood" substitution plan
    // §5.7 calls for instead of ordinary SSE.
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

    return { fit, edges, counts, regions, config, initialCenters: { g1: parameterStarts[0][PARAMETER_INDEX.G1_MEAN], g2: parameterStarts[0][PARAMETER_INDEX.G2_MEAN] } };
  },

  /** lambda_i(theta) at arbitrary edges, for rendering a fitted curve at a
   * resolution independent of the histogram it was fit against. `parameters`
   * is the named object this model stores in a generic result's `parameters`
   * field (see normalizeResult()), not the raw fit array. */
  expectedCounts(edges, parameters) {
    const array = [
      parameters.g1Area, parameters.g1Mean, parameters.g1CV,
      parameters.g2Area, parameters.g2Mean, parameters.g2CV,
      parameters.sArea, parameters.b, parameters.c,
    ];
    return expected_counts_from_parameters(edges, array, parameters.sQuadratureNodes ?? DEFAULT_S_QUADRATURE_NODES);
  },

  /**
   * Packages fit()'s raw result into the generic §4.5 shape: components are
   * G1_i, S_i, G2_i (each with both its true area N_k and its observed-
   * domain-truncated sum); phaseFractions is p_G1/p_S/p_G2 from the formula
   * block's total-area ratio, not from any bin-counting shortcut.
   */
  normalizeResult(rawResult) {
    const { fit, edges, counts, regions, config, initialCenters } = rawResult;
    const named = paramsToNamed(fit.parameters);
    const peaks = peakComponents(edges, named);
    const sCounts = convolvedSPhase(
      edges,
      { sArea: named.sArea, g1Mean: named.g1Mean, g2Mean: named.g2Mean, broadeningCV: named.g1CV, b: named.b, c: named.c },
      config.sQuadratureNodes,
    );

    const components = [
      component_from_counts("g1", "G1 / 1C", peaks.g1, named.g1Area),
      component_from_counts("s", "S", sCounts, named.sArea),
      component_from_counts("g2", "G2/M / 2C", peaks.g2, named.g2Area),
    ];

    // p_G1 = N_G1/(N_G1+N_S+N_G2), p_S = N_S/(...), p_G2 = N_G2/(...) -- the
    // formula block's phase-fraction equations, using each component's true
    // (totalArea) area.
    const biologicalTotal = named.g1Area + named.sArea + named.g2Area;
    const phaseFractions = biologicalTotal > 0
      ? { g1: named.g1Area / biologicalTotal, s: named.sArea / biologicalTotal, g2: named.g2Area / biologicalTotal }
      : { g1: 0, s: 0, g2: 0 };

    const diagnostics = buildPoissonFitDiagnostics({
      observedCounts: counts,
      expectedCounts: fit.expectedCounts,
      parameterCount: free_indices(config).length,
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
      ...boundaryHitWarnings(named, {
        g1CV: { min: config.cvMin, max: config.cvMax },
        g2CV: { min: config.cvMin, max: config.cvMax },
      }),
    ];

    return {
      schemaVersion: 1,
      modelId: "dean_jett",
      modelVersion: "1.0.0",
      modelLabel: "Dean–Jett",
      kind: "generative",
      fitScope: "per_sample",
      comparisonGroup: "poisson_cell_cycle",

      converged: fit.converged,
      convergenceReason: convergence_reason(fit),
      parameters: { ...named, sQuadratureNodes: config.sQuadratureNodes },
      bounds: {
        g1CV: [config.cvMin, config.cvMax],
        g2CV: [config.cvMin, config.cvMax],
        g1Mean: [regions.g1.left, regions.g1.right],
        g2Mean: [regions.g2.left, regions.g2.right],
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
        restarts: fit.attempts.map((attempt) => ({
          startIndex: attempt.startIndex,
          deviance: attempt.deviance,
          converged: attempt.converged,
          iterations: attempt.iterations,
        })),
      },
      warnings,
      provenance: { rawResult },
      targetResults: [],
    };
  },
};
