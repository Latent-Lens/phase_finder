// ============================================================================
// Watson Classic generative cell-cycle model (the canonical "Watson model" that
// commercial tools such as Flowreader and ModFit implement -- distinct from this
// repo's residual watson_pragmatic.js, and added so PhaseFinder can reproduce the
// external Flowreader Watson reference; see VALID-01).
//
// Parameter vector theta (this file's PARAMETER_INDEX order below):
//   N_G1 (g1Area), mu1 (g1Mean), CV1 (g1CV),
//   N_G2 (g2Area), mu2 (g2Mean), CV2 (g2CV),
//   N_S  (sArea),  slope           <- broadened-trapezoid S-phase shape
//
// Observation model -- identical Poisson-deviance objective to Dean-Jett
// (plan §5.1/§5.7): lambda_i = G1_i + S_i + G2_i, fit by minimizing the sum of
// squared Poisson deviance residuals via fit_engine.js.
//
// G1 / G2 peaks: area-parameterized Gaussians integrated exactly over each bin
// (shared.js's peakComponents(), identical to Dean-Jett/Dean-Jett-Fox).
//
// Watson S phase: the *broadened rectangle*. S-phase cells are assumed uniformly
// distributed in DNA content between mu1 and mu2 (a rectangle), each broadened by
// the same CV-scaled Gaussian measurement error the peaks carry. A single slope
// term turns the rectangle into a trapezoid so S can rise or fall linearly across
// the interval without the extra curvature Dean-Jett's quadratic profile adds:
//
//   u(z) = mu1 + z*(mu2-mu1),                 z in [0,1]
//   q(z) = 1 + slope*(z - 1/2),   integral(q,0..1)=1 for any slope
//   q(z) >= 0 on [0,1]  <=>  slope in [-2, 2]  (projected there; never clamped
//                                                silently mid-profile)
//   S_i = N_S * integral_0^1 q(z) *
//           [ Phi((b_{i+1}-u(z))/(CV1*u(z))) - Phi((b_i-u(z))/(CV1*u(z))) ] dz
//
// The rectangle is the slope=0 special case. Because the whole inter-peak
// interval is filled with broadened S mass (rather than Dean-Jett-Fox's separate
// latent wave), this model typically reports a fuller %S than DJ/DJF -- which is
// exactly the behaviour the Flowreader Watson reference shows.
//
// Phase fractions use total component areas, same as Dean-Jett:
//   p_G1 = N_G1/(N_G1+N_S+N_G2),  p_S = N_S/(...),  p_G2 = N_G2/(...)
//
// Shares peakComponents() and the generic broadened-S integrator
// convolvedSPhaseWithProfile() with shared.js; this file owns theta's
// parameterization, its feasible region (peak-region + ratio + CV-mode
// constraints + slope in [-2,2]), deterministic multi-start, and result
// packaging around fit_engine.js's optimizer.
// ============================================================================

import { peakComponents, convolvedSPhaseWithProfile, projectMeansToFeasible, DEFAULT_S_QUADRATURE_NODES } from "./shared.js";
import { createParameterTransform, fitPoissonModel } from "../fit_engine.js";
import { buildPoissonFitDiagnostics, fitQualityWarnings, tailMassWarning, boundaryHitWarnings } from "../diagnostics.js";
import { validatePeakRegions, estimatePeakFromRegion } from "../peak_regions.js";
import { clamp } from "../../math/stats.js";

const PARAMETER_INDEX = Object.freeze({
  G1_AREA: 0, // N_G1
  G1_MEAN: 1, // mu1
  G1_CV: 2,   // CV1 (also the S-phase broadening CV)
  G2_AREA: 3, // N_G2
  G2_MEAN: 4, // mu2
  G2_CV: 5,   // CV2
  S_AREA: 6,  // N_S
  S_SLOPE: 7, // trapezoid slope in [-2, 2]
});
const PARAMETER_COUNT = 8;

// The broadened trapezoid stays nonnegative on [0, 1] exactly when the slope is
// in this closed interval (q(0)=1-slope/2, q(1)=1+slope/2).
const SLOPE_MIN = -2;
const SLOPE_MAX = 2;

export const DEFAULT_CONFIG = Object.freeze({
  ratioMode: "bounded",
  fitRatioRange: [1.65, 2.25],
  lockedRatio: 2,
  cvMode: "free",
  cvMin: 0.01,
  cvMax: 0.30,
  sQuadratureNodes: DEFAULT_S_QUADRATURE_NODES,
  maxIterations: 200,
  tolerance: 1e-8,
  stepTolerance: 1e-7,
  initialLambda: 1e-2,
  finiteDifferenceStep: 1e-4,
});

/*

Purpose:
	The broadened-trapezoid S-phase profile q(z) = 1 + slope·(z - 1/2), whose
	integral over [0, 1] is 1 for any slope. slope = 0 is the pure rectangle.

Input:
	z [number]: latent position in [0, 1]
	slope [number]: trapezoid slope

Output:
	q [number]: profile value at z

*/
export function trapezoidProfile(z, slope) {
  return 1 + slope * (z - 0.5);
}

/*

Purpose:
	Projects the slope into its feasible interval [-2, 2] (the exact nonnegativity
	condition for the trapezoid on [0, 1]). Analogous to Dean-Jett's quadratic
	(b, c) projection but 1-D and closed-form.

Input:
	slope [number]: proposed slope

Output:
	slope [number]: a feasible slope

*/
export function projectTrapezoidSlope(slope) {
  if (!Number.isFinite(slope)) throw new RangeError("The Watson S-phase slope must be finite.");
  return clamp(slope, SLOPE_MIN, SLOPE_MAX);
}

/*

Purpose:
	Watson broadened-rectangle/trapezoid S-phase counts per bin: the generic
	broadened-S integrator specialized to the trapezoid profile. The slope is
	projected into [-2, 2] first so the profile is nonnegative everywhere.

Input:
	edges [array]: histogram bin edges
	parameters [object]: { sArea, g1Mean, g2Mean, broadeningCV, slope }
	quadratureNodes [number]: Gauss-Legendre node count

Output:
	counts [array]: per-bin S-phase counts

*/
export function watsonRectangleSPhase(
  edges,
  { sArea, g1Mean, g2Mean, broadeningCV, slope },
  quadratureNodes = DEFAULT_S_QUADRATURE_NODES,
) {
  const feasibleSlope = projectTrapezoidSlope(slope);
  return convolvedSPhaseWithProfile(
    edges,
    { sArea, g1Mean, g2Mean, broadeningCV, profileFn: (z) => trapezoidProfile(z, feasibleSlope) },
    quadratureNodes,
  );
}

function paramsToNamed(parameters) {
  return {
    g1Area: parameters[PARAMETER_INDEX.G1_AREA],
    g1Mean: parameters[PARAMETER_INDEX.G1_MEAN],
    g1CV: parameters[PARAMETER_INDEX.G1_CV],
    g2Area: parameters[PARAMETER_INDEX.G2_AREA],
    g2Mean: parameters[PARAMETER_INDEX.G2_MEAN],
    g2CV: parameters[PARAMETER_INDEX.G2_CV],
    sArea: parameters[PARAMETER_INDEX.S_AREA],
    slope: parameters[PARAMETER_INDEX.S_SLOPE],
  };
}

/*

Purpose:
	Evaluates lambda_i(theta) = G1_i + S_i + G2_i for the Watson model -- the only
	place this file assembles the full expected-count model; each term is delegated
	to shared.js.

Input:
	edges [array]: histogram bin edges
	parameters [array]: theta (PARAMETER_INDEX order)
	quadratureNodes [number]: Gauss-Legendre node count for the S integral

Output:
	expected [array]: expected count per bin

*/
function expected_counts_from_parameters(edges, parameters, quadratureNodes) {
  const named = paramsToNamed(parameters);
  const peaks = peakComponents(edges, named);
  const sCounts = watsonRectangleSPhase(
    edges,
    { sArea: named.sArea, g1Mean: named.g1Mean, g2Mean: named.g2Mean, broadeningCV: named.g1CV, slope: named.slope },
    quadratureNodes,
  );
  const expected = new Array(peaks.g1.length);
  for (let i = 0; i < expected.length; i += 1) {
    expected[i] = peaks.g1[i] + sCounts[i] + peaks.g2[i];
  }
  return expected;
}

const project_means = projectMeansToFeasible;

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

    projected[PARAMETER_INDEX.S_SLOPE] = projectTrapezoidSlope(projected[PARAMETER_INDEX.S_SLOPE]);
    return projected;
  };
}

/*

Purpose:
	Lists which theta indices the optimizer may move (locked ratio / equal CV drop
	their derived parameter from the Jacobian, matching Dean-Jett).

Input:
	config [object]: model config

Output:
	indices [array]: the free parameter indices

*/
function free_indices(config) {
  const indices = [
    PARAMETER_INDEX.G1_AREA,
    PARAMETER_INDEX.G1_MEAN,
    PARAMETER_INDEX.G1_CV,
    PARAMETER_INDEX.G2_AREA,
    PARAMETER_INDEX.S_AREA,
    PARAMETER_INDEX.S_SLOPE,
  ];
  if (config.cvMode !== "equal") indices.push(PARAMETER_INDEX.G2_CV);
  if (config.ratioMode !== "locked") indices.push(PARAMETER_INDEX.G2_MEAN);
  return indices;
}

function make_parameter_transform(regions, config) {
  const scaled = (region) => ({
    type: "scaled",
    center: 0.5 * (region.left + region.right),
    scale: Math.max(region.right - region.left, Number.EPSILON),
  });
  return createParameterTransform([
    { type: "log" }, scaled(regions.g1), { type: "bounded", min: config.cvMin, max: config.cvMax },
    { type: "log" }, scaled(regions.g2), { type: "bounded", min: config.cvMin, max: config.cvMax },
    { type: "log" }, { type: "bounded", min: SLOPE_MIN, max: SLOPE_MAX },
  ]);
}

function estimate_between_peaks_area(edges, counts, regions) {
  let total = 0;
  for (let i = 0; i < counts.length; i += 1) {
    const center = 0.5 * (edges[i] + edges[i + 1]);
    if (center > regions.g1.right && center < regions.g2.left) total += counts[i];
  }
  return Math.max(1, total);
}

/*

Purpose:
	Deterministic theta_0 start candidates for the multi-start fit: seed G1/G2 from
	each region's local estimate and the flat rectangle (slope=0); the others tilt
	the trapezoid to escape the flat profile's degenerate gradient.

Input:
	edges [array]: histogram bin edges
	counts [array]: per-bin counts
	regions [object]: the accepted { g1, g2 } peak regions
	config [object]: model config

Output:
	starts [array]: theta start vectors

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
    sAreaGuess, 0,
  ];

  return [
    base,
    [...base.slice(0, PARAMETER_INDEX.S_SLOPE), 1.0],
    [...base.slice(0, PARAMETER_INDEX.S_SLOPE), -1.0],
    (() => {
      const wider = [...base];
      wider[PARAMETER_INDEX.S_AREA] = sAreaGuess * 1.5;
      return wider;
    })(),
  ];
}

function convergence_reason(fit) {
  if (fit.cancelled) return "cancelled";
  if (fit.converged) return fit.terminationReason ?? "converged";
  return fit.maxIterationsReached ? "max_iterations" : "unknown";
}

function component_from_counts(id, label, counts, areaParameter, role = "biological") {
  const observedDomainArea = counts.reduce((sum, value) => sum + value, 0);
  return {
    id,
    label,
    role,
    counts,
    totalArea: areaParameter,
    observedDomainArea,
    includeInBiologicalDenominator: role === "biological",
  };
}

export const watson_classic = {
  id: "watson_classic",
  version: "1.0.0",
  label: "Watson Classic",
  kind: "generative",
  fitScope: "per_sample",
  comparisonGroup: "poisson_cell_cycle",
  requiredInputs: ["sample_histogram", "peak_regions"],
  capabilities: { contaminants: false, multiplePloidy: false, autoComparison: true },
  defaultConfig: { ...DEFAULT_CONFIG },

  /*

  Purpose:
	Builds theta_0, minimizes total Poisson deviance via fit_engine.js, and returns
	the raw fit result plus everything normalizeResult() needs.

  Input:
	context [object]: { histogram (edges + counts/y),
	                  peakRegions { g1:{left,right}, g2:{left,right} },
	                  config (DEFAULT_CONFIG overrides) }

  Output:
	rawResult [object]: { fit, edges, counts, regions, config, initialCenters }

  */
  fit(context) {
    const { histogram, peakRegions, config: userConfig = {} } = context;
    const { onProgress, shouldCancel, ...restUserConfig } = userConfig;
    const config = { ...DEFAULT_CONFIG, ...restUserConfig };
    const regions = validatePeakRegions(peakRegions);
    // Preflight the ratio-mode feasibility (throws a clear error when the regions
    // and ratio band cannot be jointly satisfied) before spending optimizer time.
    projectMeansToFeasible(0.5 * (regions.g1.left + regions.g1.right), 0.5 * (regions.g2.left + regions.g2.right), regions, config);

    const edges = histogram.edges;
    const counts = Array.from(histogram.counts ?? histogram.y);
    if (!edges || edges.length !== counts.length + 1) {
      throw new Error("histogram.edges must have exactly one more entry than histogram.counts.");
    }

    const parameterStarts = build_parameter_starts(edges, counts, regions, config);
    const projectFn = make_project_fn(regions, config);
    const parameterTransform = make_parameter_transform(regions, config);
    const freeIndices = free_indices(config);

    const fit = fitPoissonModel({
      observedCounts: counts,
      parameterStarts: parameterStarts.map(projectFn),
      freeIndices,
      expectedCountsFn: (parameters) => expected_counts_from_parameters(edges, parameters, config.sQuadratureNodes),
      projectFn,
      parameterTransform,
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

  /*

  Purpose:
	Evaluates lambda_i(theta) at arbitrary edges for rendering a fitted curve at a
	resolution independent of the histogram it was fit against.

  Input:
	edges [array]: the edges to evaluate at
	parameters [object]: the NAMED parameters this model stores

  Output:
	counts [array]: expected count per bin at the given edges

  */
  expectedCounts(edges, parameters) {
    const array = [
      parameters.g1Area, parameters.g1Mean, parameters.g1CV,
      parameters.g2Area, parameters.g2Mean, parameters.g2CV,
      parameters.sArea, parameters.slope,
    ];
    return expected_counts_from_parameters(edges, array, parameters.sQuadratureNodes ?? DEFAULT_S_QUADRATURE_NODES);
  },

  /*

  Purpose:
	Packages the raw fit result into the generic model-neutral shape (components
	G1_i, S_i, G2_i with true + observed-domain areas; phaseFractions from the
	total-area ratio).

  Input:
	rawResult [object]: the object returned by fit()

  Output:
	result [object]: the normalized, model-neutral fit result

  */
  normalizeResult(rawResult) {
    const { fit, edges, counts, regions, config, initialCenters } = rawResult;
    const named = paramsToNamed(fit.parameters);
    const peaks = peakComponents(edges, named);
    const sCounts = watsonRectangleSPhase(
      edges,
      { sArea: named.sArea, g1Mean: named.g1Mean, g2Mean: named.g2Mean, broadeningCV: named.g1CV, slope: named.slope },
      config.sQuadratureNodes,
    );

    const components = [
      component_from_counts("g1", "G1 / 1C", peaks.g1, named.g1Area),
      component_from_counts("s", "S", sCounts, named.sArea),
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
        parameterCount: free_indices(config).length,
      }),
      optimizer: fit.optimizerDiagnostics,
    };

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
        slope: { min: SLOPE_MIN, max: SLOPE_MAX },
      }),
    ];

    return {
      schemaVersion: 1,
      modelId: "watson_classic",
      modelVersion: "1.0.0",
      modelLabel: "Watson Classic",
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
        slope: [SLOPE_MIN, SLOPE_MAX],
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
