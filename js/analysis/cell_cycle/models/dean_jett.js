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
//   q(z) >= 0 holds by construction (Bernstein basis, shared.js)
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

import { peakComponents, convolvedSPhase, projectMeansToFeasible, sPhaseProfileMinimum, DEFAULT_S_QUADRATURE_NODES } from "./shared.js";
import {
  parameterUncertainty,
  phaseFractionIntervals,
  multistartAgreement,
  identifiabilityWarnings,
} from "../uncertainty.js";
import { createParameterTransform, fitPoissonModel } from "../fit_engine.js";
import { buildPoissonFitDiagnostics, fitQualityWarnings, tailMassWarning } from "../diagnostics.js";
import { buildConstraintAudit, constraintAuditWarnings } from "../constraint_audit.js";
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
  SHAPE1: 7,  // mid-S Bernstein shape logit
  SHAPE2: 8,  // late-S Bernstein shape logit
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
    shape1: parameters[PARAMETER_INDEX.SHAPE1],
    shape2: parameters[PARAMETER_INDEX.SHAPE2],
  };
}

/*

Purpose:
	Evaluates lambda_i(theta) = G1_i + S_i + G2_i -- the only place this file
	assembles the full expected-count model; each G1_i/S_i/G2_i term is delegated
	to shared.js so the equations live in exactly one place.

Input:
	edges [array]: histogram bin edges
	parameters [array]: the theta parameter vector (PARAMETER_INDEX order)
	quadratureNodes [number]: Gauss-Legendre node count for the S-phase integral

Output:
	expected [array]: expected count per bin

*/
function expected_counts_from_parameters(edges, parameters, quadratureNodes) {
  const named = paramsToNamed(parameters);
  const peaks = peakComponents(edges, named);
  const sCounts = convolvedSPhase(
    edges,
    { sArea: named.sArea, g1Mean: named.g1Mean, g2Mean: named.g2Mean, broadeningCV: named.g1CV, shape1: named.shape1, shape2: named.shape2 },
    quadratureNodes,
  );
  const expected = new Array(peaks.g1.length);
  for (let i = 0; i < expected.length; i += 1) {
    expected[i] = peaks.g1[i] + sCounts[i] + peaks.g2[i];
  }
  return expected;
}

/*

Purpose:
	Projects (mu1, mu2) into their feasible domain from the accepted regions and
	ratio mode. Not part of the emission model -- this is where in theta-space the
	optimizer is allowed to look, independent of how well a given (mu1, mu2)
	explains the counts.

Input:
	g1Mean [number]: proposed G1 mean
	g2Mean [number]: proposed G2 mean
	regions [object]: the accepted { g1, g2 } peak regions
	config [object]: model config (ratioMode, lockedRatio, fitRatioRange)

Output:
	means [object]: { g1Mean, g2Mean } constrained to the feasible domain

*/
// Joint (mu1, mu2) projection onto both peak regions and the ratio band, shared
// verbatim with dean_jett_fox.js via shared.js (audit SCI-02) so the two models
// can never drift apart on constraint handling.
const project_means = projectMeansToFeasible;

// (b, c) had a feasible-domain projection here; the Bernstein shape parameters
// are unconstrained, so no projection is needed.

/*

Purpose:
	Returns a projection function that constrains a full theta vector to every
	parameter's feasible domain (areas >= 0, CVs in range, means via
	project_means; the Bernstein shape parameters need no projection) in one place.

Input:
	regions [object]: the accepted { g1, g2 } peak regions
	config [object]: model config

Output:
	project [function]: parameters -> feasible parameters

*/
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

    return projected;
  };
}

/*

Purpose:
	Lists which theta indices the optimizer may move. A locked ratio or equal-CV
	mode removes the derived parameter entirely (it still exists in theta and is
	set by projectFn each iteration, but the LM Jacobian never probes it), rather
	than leaving it "free" and hoping projection undoes the step.

Input:
	config [object]: model config (ratioMode, cvMode)

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
    PARAMETER_INDEX.SHAPE1,
    PARAMETER_INDEX.SHAPE2,
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
    { type: "log" }, { type: "identity" }, { type: "identity" },
  ]);
}

/*

Purpose:
	Sums the raw counts whose bin center falls strictly between the two accepted
	peak regions -- a rough N_S (S-phase area) seed, not itself part of the model.

Input:
	edges [array]: histogram bin edges
	counts [array]: per-bin counts
	regions [object]: the accepted { g1, g2 } peak regions

Output:
	area [number]: the between-peaks count sum (at least 1)

*/
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
	Checks the ratio-mode feasibility conditions against the accepted regions
	before spending any optimizer time, throwing a clear error the caller can
	surface when no valid G2:G1 ratio is achievable.

Input:
	regions [object]: the accepted { g1, g2 } peak regions
	config [object]: model config (ratioMode, lockedRatio, fitRatioRange)

Output:
	(none) [void]: returns normally when feasible, throws otherwise

*/
/*

Purpose:
	Builds the deterministic theta_0 start candidates for the multi-start fit. The
	base start seeds G1/G2 from each region's local estimate and the flat S
	profile (b=c=0); the others perturb the S-phase shape/area to escape the flat
	profile's degenerate gradient near b=c=0, not because those values are more
	plausible a priori.

Input:
	edges [array]: histogram bin edges
	counts [array]: per-bin counts
	regions [object]: the accepted { g1, g2 } peak regions
	config [object]: model config

Output:
	starts [array]: an array of theta start vectors

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
    [...base.slice(0, PARAMETER_INDEX.SHAPE1), 0.8, -0.5],
    [...base.slice(0, PARAMETER_INDEX.SHAPE1), -0.8, -0.5],
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
    totalArea: areaParameter, // N_k itself -- the *true* area, not truncated by the histogram domain
    observedDomainArea,
    includeInBiologicalDenominator: role === "biological",
  };
}

// UNC-01: parameter names for the covariance/correlation matrices, in the exact
// order free_indices() lists them, so a reader of the correlation matrix never
// has to map a row back to a theta slot by hand.
const PARAMETER_LABEL = Object.freeze({
  [PARAMETER_INDEX.G1_AREA]: "g1Area",
  [PARAMETER_INDEX.G1_MEAN]: "g1Mean",
  [PARAMETER_INDEX.G1_CV]: "g1CV",
  [PARAMETER_INDEX.G2_AREA]: "g2Area",
  [PARAMETER_INDEX.G2_MEAN]: "g2Mean",
  [PARAMETER_INDEX.G2_CV]: "g2CV",
  [PARAMETER_INDEX.S_AREA]: "sArea",
  [PARAMETER_INDEX.SHAPE1]: "shape1",
  [PARAMETER_INDEX.SHAPE2]: "shape2",
});

/*

Purpose:
	UNC-01's uncertainty bundle for a finished fit: identifiability evidence
	(rank, conditioning, parameter correlations) plus delta-method intervals on
	the three phase fractions, which is the only place in the result where a
	reported percentage acquires an interval.

	Returns null -- never a fabricated bundle -- when the engine could not build
	a Jacobian at the solution, so a consumer can tell "no uncertainty was
	computed" apart from "uncertainty was computed and is small".

Input:
	fit [object]: the fitPoissonModel result (needs solutionJacobian, parameters,
	              and attempts -- the multi-start audit trail multimodality is
	              read from)
	config [object]: the merged model config, for free_indices()
	constraintAudit [object]: buildConstraintAudit's bundle; its active entries
	                          say which free parameters ended on a bound, where
	                          the interior-solution assumption behind an
	                          asymptotic interval does not hold

Output:
	uncertainty [object|null]: the parameterUncertainty() bundle plus
	                        { phaseFractions, multistart, boundaryParameters,
	                          warnings }

*/
function build_uncertainty(fit, config, constraintAudit) {
  if (!Array.isArray(fit.solutionJacobian) || !fit.solutionJacobian.length) return null;
  const freeIndices = free_indices(config);
  const parameterNames = freeIndices.map((index) => PARAMETER_LABEL[index] ?? `theta[${index}]`);
  try {
    const uncertainty = parameterUncertainty({
      jacobian: fit.solutionJacobian,
      freeIndices,
      parameterNames,
    });
    const intervals = phaseFractionIntervals({
      parameters: fit.parameters,
      covariance: uncertainty.covariance,
      freeIndices,
      areaIndices: {
        g1: PARAMETER_INDEX.G1_AREA,
        s: PARAMETER_INDEX.S_AREA,
        g2: PARAMETER_INDEX.G2_AREA,
      },
    });
    // Only bounds on parameters the optimizer was actually free to move matter
    // here: a bound on a frozen parameter says nothing about the interval,
    // because there is no interval to invalidate.
    const freeNames = new Set(parameterNames);
    const boundaryParameters = (constraintAudit?.active ?? [])
      .map((entry) => entry.parameter)
      .filter((parameter) => parameter && freeNames.has(parameter));
    const multistart = multistartAgreement(fit.attempts, { freeIndices, parameterNames });
    return {
      ...uncertainty,
      method: "asymptotic_deviance_curvature",
      intervalLevel: 0.95,
      phaseFractions: intervals,
      multistart,
      boundaryParameters,
      warnings: identifiabilityWarnings(uncertainty, intervals, {
        multistart,
        boundaryParameters,
        fractionParameters: [
          PARAMETER_LABEL[PARAMETER_INDEX.G1_AREA],
          PARAMETER_LABEL[PARAMETER_INDEX.S_AREA],
          PARAMETER_LABEL[PARAMETER_INDEX.G2_AREA],
        ],
      }),
    };
  } catch {
    return null;
  }
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

  /*

  Purpose:
	Builds theta_0, minimizes total Poisson deviance (the sum-of-squares
	stand-in for -logL(theta) from the header formula block) via fit_engine.js,
	and returns the raw fit result plus everything normalizeResult() needs.

  Input:
	context [object]: { histogram (masked histogram: edges + counts/y),
	                  peakRegions { g1:{left,right}, g2:{left,right} },
	                  config (DEFAULT_CONFIG overrides) }

  Output:
	rawResult [object]: { fit, edges, counts, regions, config, initialCenters }

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
	Evaluates lambda_i(theta) at arbitrary edges, for rendering a fitted curve at
	a resolution independent of the histogram it was fit against.

  Input:
	edges [array]: the edges to evaluate at
	parameters [object]: the NAMED parameters this model stores in a generic
	                     result (not the raw fit array)

  Output:
	counts [array]: expected count per bin at the given edges

  */
  expectedCounts(edges, parameters) {
    const array = [
      parameters.g1Area, parameters.g1Mean, parameters.g1CV,
      parameters.g2Area, parameters.g2Mean, parameters.g2CV,
      parameters.sArea, parameters.shape1, parameters.shape2,
    ];
    return expected_counts_from_parameters(edges, array, parameters.sQuadratureNodes ?? DEFAULT_S_QUADRATURE_NODES);
  },

  /*

  Purpose:
	Packages the raw fit result into the generic model-neutral shape: components
	G1_i, S_i, G2_i (each with both its true area N_k and its observed-domain
	sum); phaseFractions is p_G1/p_S/p_G2 from the total-area ratio, not a
	bin-counting shortcut.

  Input:
	rawResult [object]: the object returned by fit()

  Output:
	result [object]: the normalized, model-neutral fit result

  */
  normalizeResult(rawResult) {
    const { fit, edges, counts, regions, config, initialCenters } = rawResult;
    const named = paramsToNamed(fit.parameters);
    const peaks = peakComponents(edges, named);
    const sCounts = convolvedSPhase(
      edges,
      { sArea: named.sArea, g1Mean: named.g1Mean, g2Mean: named.g2Mean, broadeningCV: named.g1CV, shape1: named.shape1, shape2: named.shape2 },
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

    const diagnostics = {
      ...buildPoissonFitDiagnostics({
        observedCounts: counts,
        expectedCounts: fit.expectedCounts,
        parameterCount: free_indices(config).length,
      }),
      optimizer: fit.optimizerDiagnostics,
    };

    // STAT-01: one declared bound set feeding the audit, the warnings, and the
    // published `bounds` alike (see dean_jett_fox.js for the rationale).
    const bounds = {
      g1Area: [0, Infinity],
      sArea: [0, Infinity],
      g2Area: [0, Infinity],
      g1CV: [config.cvMin, config.cvMax],
      g2CV: [config.cvMin, config.cvMax],
      g1Mean: [regions.g1.left, regions.g1.right],
      g2Mean: [regions.g2.left, regions.g2.right],
    };
    const constraintAudit = buildConstraintAudit({
      named, bounds, config, phaseFractions, contaminantFractions: {},
      profileMinimumFn: sPhaseProfileMinimum,
    });

    const uncertainty = build_uncertainty(fit, config, constraintAudit);

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
      ...(uncertainty?.warnings ?? []),
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
        restarts: fit.attempts.map((attempt) => ({
          startIndex: attempt.startIndex,
          deviance: attempt.deviance,
          converged: attempt.converged,
          iterations: attempt.iterations,
        })),
      },
      warnings,
      uncertainty,
      provenance: { rawResult },
      targetResults: [],
    };
  },
};
