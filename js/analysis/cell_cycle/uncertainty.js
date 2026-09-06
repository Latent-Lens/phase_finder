// UNC-01: identifiability and uncertainty evidence for a converged Poisson
// count fit. A fitted percentage reported as a bare point estimate is the
// register's stated publication blocker; this module supplies the evidence that
// says how much of that point estimate the data actually determined.
//
// Everything here is derived from the Jacobian of the DEVIANCE residuals at the
// solution, which is the same object the optimizer already builds each
// iteration (lm_solver.js's buildFiniteDiffJacobian) -- so the covariance below
// is the model's own linearization, not a second, differently-parameterized
// approximation that could disagree with the fit.
//
// Why (J'J)^-1 is the covariance here, with no dispersion estimate:
//
//   The objective is sum(r_i^2) over Poisson deviance residuals, and by
//   construction sum(r_i^2) = D, the total deviance, with D = -2 logL + C for a
//   constant C that does not depend on theta. So the observed Fisher
//   information is I = -d2 logL/dtheta2 = (1/2) d2D/dtheta2, and the
//   Gauss-Newton approximation d2D/dtheta2 ~ 2 J'J gives I ~ J'J directly.
//   Cov(theta) ~ I^-1 = (J'J)^-1.
//
//   The Poisson dispersion is KNOWN (= 1), so unlike a least-squares fit there
//   is no residual-variance factor to estimate and multiply in. A fit that is
//   overdispersed relative to Poisson is not handled by inflating this
//   covariance -- it is a model-adequacy failure, and diagnostics.js's
//   reducedDeviance is what reports it. These intervals are therefore
//   conditional on the Poisson model being adequate, which is why
//   identifiabilityWarnings() re-states that rather than hiding it.
//
// What this module does NOT claim: these are asymptotic, curvature-based
// intervals. They assume the log-likelihood is locally quadratic and the
// solution is interior. Both assumptions fail exactly where cell-cycle fits are
// hardest -- a boundary-pinned area, a weak S phase, a low-count sample -- so
// every consumer gets the boundary/rank/conditioning flags alongside the
// numbers, and a flagged interval is meant to be reported as qualified rather
// than quietly used.

import { gramMatrix, symmetricEigenDecomposition } from "../math/lm_solver.js";

// The two thresholds below have to be read together, because forming J'J
// SQUARES the condition number: a Jacobian with 2-norm condition k gives a Gram
// matrix with eigenvalue ratio 1/k^2. That single fact fixes the whole scale.
//
//   eigenvalue ratio   1e-14 ......... 1e-12 ......... 1e-10
//   Jacobian condition   1e7 ........... 1e6 ........... 1e5
//                       |               |
//                       |               +-- CONDITION_WARNING_THRESHOLD
//                       +-- RANK_TOLERANCE
//
// An eigenvalue below RANK_TOLERANCE * lambda_max is treated as a null
// direction: the data constrains no combination of parameters along it. 1e-14
// is where double precision stops being able to tell a tiny eigenvalue of J'J
// from zero, and it is the same cut lm_solver's estimateJacobianCondition uses
// to declare a Jacobian singular -- so the optimizer and this module cannot
// disagree about which fits were identified.
//
// It is tempting to raise this (1e-10, say) to make the rank flag fire more
// often. That is a mistake: a direction at 1e-10 is not null, it is merely
// weakly determined, and dropping it hides its large-but-real standard error
// inside the pseudo-inverse instead of reporting it. The ill-conditioning band
// below is what those directions are for.
export const RANK_TOLERANCE = 1e-14;

// Above this 2-norm condition number the covariance has lost most of its
// significant digits (a condition of 1e6 leaves the Gram matrix roughly four of
// sixteen) and the intervals should be read as qualified rather than exact.
// This MUST stay below the condition number the rank cut implies --
// 1/sqrt(RANK_TOLERANCE) = 1e7 -- or the band between the two is empty and the
// ill-conditioning warning becomes unreachable dead code.
export const CONDITION_WARNING_THRESHOLD = 1e6;

// |correlation| at or above this between two free parameters means the fit
// determined their combination but not each one separately.
export const CORRELATION_WARNING_THRESHOLD = 0.99;

const NORMAL_QUANTILE_95 = 1.959963984540054;

// Two optima whose total deviances differ by less than the chi-square(1) 95%
// point are not statistically distinguishable: a likelihood-ratio test at one
// degree of freedom could not reject either in favour of the other. Restarts
// that land inside this window and DISAGREE about the parameters are the
// definition of a multimodal surface, so this is the right yardstick rather
// than an arbitrary epsilon.
export const EQUIVALENT_DEVIANCE_WINDOW = 3.841458820694124;

// How far apart two equivalent optima's parameters must be, relative to the
// parameter's own scale, before they count as genuinely different solutions
// rather than the same solution reached from different directions.
export const OPTIMUM_SEPARATION_TOLERANCE = 0.05;

/*

Purpose:
	Moore-Penrose pseudo-inverse of a symmetric PSD matrix from its
	eigendecomposition, inverting only the directions the data actually
	constrained. A true inverse would either throw or return astronomically
	large variances on a rank-deficient J'J; the pseudo-inverse instead returns
	the covariance of the identified subspace and lets the caller report the
	deficiency explicitly, which is what UNC-01 asks for.

Input:
	values [array]: eigenvalues, descending
	vectors [array]: vectors[k] is the unit eigenvector for values[k]
	tolerance [number]: relative cutoff below lambda_max for a null direction

Output:
	result [object]: { inverse [array], rank [number], retained [array of index] }

*/
function pseudoInverse(values, vectors, tolerance) {
  const size = values.length;
  const largest = values.length ? Math.max(...values) : 0;
  const cutoff = largest * tolerance;
  const retained = [];
  const inverse = Array.from({ length: size }, () => new Array(size).fill(0));
  for (let k = 0; k < size; k += 1) {
    if (!(values[k] > cutoff) || !(values[k] > 0)) continue;
    retained.push(k);
    const vector = vectors[k];
    const scale = 1 / values[k];
    for (let row = 0; row < size; row += 1) {
      for (let column = row; column < size; column += 1) {
        const term = scale * vector[row] * vector[column];
        inverse[row][column] += term;
        if (row !== column) inverse[column][row] = inverse[row][column];
      }
    }
  }
  return { inverse, rank: retained.length, retained };
}

/*

Purpose:
	The identifiability + covariance bundle for one converged fit: rank,
	conditioning, per-parameter standard errors, and the full correlation matrix
	of the FREE parameters. This is UNC-01's first deliverable -- the evidence
	that says which parameters the data determined and which it only determined
	in combination.

	Parameter order throughout is the order of `freeIndices`, and `parameterNames`
	(when supplied) labels them, so a caller never has to re-derive which column
	is which.

Input:
	spec [object]: {
	  jacobian [array]: rows = fitted bins, columns = free parameters, evaluated
	                    at the solution in NATURAL parameter units
	  freeIndices [array]: theta indices the optimizer was allowed to move
	  parameterNames [array|null]: display names aligned to freeIndices
	  rankTolerance [number]: override for RANK_TOLERANCE
	}

Output:
	uncertainty [object]: {
	  covariance, correlations [arrays]: free x free matrices
	  standardErrors [array]: sqrt of the covariance diagonal
	  eigenvalues [array]: spectrum of J'J, descending
	  rank, parameterCount, rankDeficiency [number]
	  conditionNumber [number]: 2-norm condition of J (sqrt of the J'J ratio)
	  nullSpaceDirections [array]: for each unidentified direction, the parameter
	                               loadings that the data does not separate
	  highCorrelations [array]: { a, b, correlation } above the threshold
	  weaklyIdentified [boolean]
	}

*/
export function parameterUncertainty({
  jacobian,
  freeIndices = [],
  parameterNames = null,
  rankTolerance = RANK_TOLERANCE,
}) {
  if (!Array.isArray(jacobian) || !jacobian.length || !Array.isArray(jacobian[0])) {
    throw new TypeError("parameterUncertainty requires a nonempty Jacobian matrix.");
  }
  const parameterCount = jacobian[0].length;
  if (freeIndices.length && freeIndices.length !== parameterCount) {
    throw new RangeError("freeIndices.length must match the Jacobian's column count.");
  }
  const names = parameterNames && parameterNames.length === parameterCount
    ? [...parameterNames]
    : freeIndices.map((index) => `theta[${index}]`);

  const gram = gramMatrix(jacobian);
  const { values, vectors } = symmetricEigenDecomposition(gram);
  // Jacobi can leave a PSD matrix's smallest eigenvalues a hair below zero;
  // clamping keeps the rank test and the condition number honest rather than
  // letting -1e-19 masquerade as a negative curvature direction.
  const eigenvalues = values.map((value) => Math.max(0, value));
  const { inverse: covariance, rank, retained } = pseudoInverse(eigenvalues, vectors, rankTolerance);

  const largest = Math.max(...eigenvalues);
  const smallest = Math.min(...eigenvalues);
  const conditionNumber = largest > 0 && smallest > largest * 1e-14
    ? Math.sqrt(largest / smallest)
    : Infinity;

  const standardErrors = covariance.map((row, index) => {
    const variance = row[index];
    return variance > 0 ? Math.sqrt(variance) : (rank < parameterCount ? Infinity : 0);
  });

  const correlations = covariance.map((row, i) => row.map((value, j) => {
    const denominator = standardErrors[i] * standardErrors[j];
    if (!(denominator > 0) || !Number.isFinite(denominator)) return i === j ? 1 : NaN;
    // Clamp: rounding in the pseudo-inverse can push a perfect correlation to
    // 1 + 1e-16, and a |rho| > 1 in a published table reads as a bug.
    return Math.max(-1, Math.min(1, value / denominator));
  }));

  const retainedSet = new Set(retained);
  const nullSpaceDirections = eigenvalues
    .map((eigenvalue, k) => ({ eigenvalue, k }))
    .filter(({ k }) => !retainedSet.has(k))
    .map(({ eigenvalue, k }) => ({
      eigenvalue,
      // Only the parameters with real weight in this direction are worth
      // naming; the rest are numerical dust and would bury the signal.
      loadings: vectors[k]
        .map((weight, index) => ({ parameter: names[index], weight }))
        .filter(({ weight }) => Math.abs(weight) > 0.1)
        .sort((left, right) => Math.abs(right.weight) - Math.abs(left.weight)),
    }));

  const highCorrelations = [];
  for (let i = 0; i < parameterCount; i += 1) {
    for (let j = i + 1; j < parameterCount; j += 1) {
      const correlation = correlations[i][j];
      if (Number.isFinite(correlation) && Math.abs(correlation) >= CORRELATION_WARNING_THRESHOLD) {
        highCorrelations.push({ a: names[i], b: names[j], correlation });
      }
    }
  }

  return {
    parameterNames: names,
    freeIndices: [...freeIndices],
    covariance,
    correlations,
    standardErrors,
    eigenvalues,
    rank,
    parameterCount,
    rankDeficiency: parameterCount - rank,
    conditionNumber,
    nullSpaceDirections,
    highCorrelations,
    weaklyIdentified: rank < parameterCount
      || !Number.isFinite(conditionNumber)
      || conditionNumber > CONDITION_WARNING_THRESHOLD,
  };
}

/*

Purpose:
	Delta-method standard error and normal interval for a scalar function of the
	fitted parameters -- the phase fractions above all, which are ratios of
	fitted areas and therefore have no standard error of their own until one is
	propagated.

	Var(g) = grad(g)' C grad(g), with grad taken by central differences on the
	SAME free parameters the covariance describes.

Input:
	spec [object]: {
	  fn [function]: theta (full parameter vector) -> scalar
	  parameters [array]: the fitted theta
	  covariance [array]: free x free covariance from parameterUncertainty
	  freeIndices [array]: which theta entries the covariance covers
	  step [number]: relative finite-difference step
	  z [number]: normal quantile for the interval half-width (default 95%)
	}

Output:
	interval [object]: { value, standardError, lower, upper, gradient }

*/
export function deltaMethodInterval({
  fn,
  parameters,
  covariance,
  freeIndices,
  step = 1e-5,
  z = NORMAL_QUANTILE_95,
}) {
  const value = fn(parameters);
  const gradient = freeIndices.map((index) => {
    const scale = Math.max(Math.abs(parameters[index]), 1) * step;
    const forward = [...parameters];
    const backward = [...parameters];
    forward[index] += scale;
    backward[index] -= scale;
    const high = fn(forward);
    const low = fn(backward);
    return Number.isFinite(high) && Number.isFinite(low) ? (high - low) / (2 * scale) : 0;
  });

  let variance = 0;
  for (let i = 0; i < gradient.length; i += 1) {
    for (let j = 0; j < gradient.length; j += 1) {
      variance += gradient[i] * covariance[i][j] * gradient[j];
    }
  }
  const standardError = variance > 0 ? Math.sqrt(variance) : (variance === 0 ? 0 : NaN);
  const halfWidth = z * standardError;
  return {
    value,
    standardError,
    lower: Number.isFinite(halfWidth) ? value - halfWidth : NaN,
    upper: Number.isFinite(halfWidth) ? value + halfWidth : NaN,
    gradient,
  };
}

/*

Purpose:
	Phase-fraction intervals. p_k = A_k / (A_g1 + A_s + A_g2), so each fraction
	depends on all three areas and the three intervals are NOT independent --
	the delta method is applied to the ratio itself rather than to each area,
	which is why a fraction's interval can be much tighter than its area's.

	Intervals are clipped to [0, 1]: a normal interval on a bounded quantity can
	run outside the simplex, and a reported "-3% S phase" is worse than a
	truncated one. `clipped` records that it happened, because a clipped
	interval is a signal the normal approximation is not appropriate for that
	fit -- identifiabilityWarnings() picks that up.

Input:
	spec [object]: {
	  parameters [array]: fitted theta
	  covariance [array], freeIndices [array]: from parameterUncertainty
	  areaIndices [object]: { g1, s, g2 } -> theta index of each phase's area
	  z [number]: normal quantile
	}

Output:
	intervals [object]: phase -> { value, standardError, lower, upper, clipped }

*/
export function phaseFractionIntervals({
  parameters,
  covariance,
  freeIndices,
  areaIndices,
  z = NORMAL_QUANTILE_95,
}) {
  const phases = ["g1", "s", "g2"];
  const out = {};
  for (const phase of phases) {
    const fractionFn = (theta) => {
      const total = phases.reduce((sum, key) => sum + Math.max(0, theta[areaIndices[key]]), 0);
      return total > 0 ? Math.max(0, theta[areaIndices[phase]]) / total : NaN;
    };
    const raw = deltaMethodInterval({ fn: fractionFn, parameters, covariance, freeIndices, z });
    const lower = Math.max(0, raw.lower);
    const upper = Math.min(1, raw.upper);
    out[phase] = {
      value: raw.value,
      standardError: raw.standardError,
      lower,
      upper,
      clipped: lower !== raw.lower || upper !== raw.upper,
    };
  }
  return out;
}

/*

Purpose:
	Multimodality evidence from the optimizer's own multi-start audit trail.

	The covariance above is a LOCAL object: it describes the curvature of one
	basin and cannot see a second, equally good optimum somewhere else in the
	parameter space. That second optimum is the failure mode cell-cycle fits are
	most prone to -- S balloons to swallow a peak, or the G1/G2 assignment
	flips -- and it produces narrow, confident, wrong intervals. fitPoissonModel
	already runs deterministic restarts and keeps every attempt, so the evidence
	is free; it just has to be read.

	Two questions get answered separately, because they mean different things:

	  * do the restarts that converged AGREE on the parameters, among those whose
	    deviances are statistically indistinguishable? Disagreement is
	    multimodality, and the reported point estimate is then one of several.
	  * do the restarts that converged reach materially DIFFERENT deviances? That
	    is not multimodality -- the worse ones are simply worse -- but it does say
	    the surface has local minima the optimizer can be trapped in, so the
	    answer depends on the start set rather than on the data alone.

Input:
	attempts [array]: fitPoissonModel's per-start audit trail; each entry needs
	                  { parameters, deviance, converged }
	options [object]: {
	  freeIndices [array]: restrict the comparison to fitted parameters; an empty
	                       list compares every entry of the vector
	  parameterNames [array|null]: names aligned to freeIndices, for the message
	  devianceWindow [number]: deviance gap below which two optima are equivalent
	  separationTolerance [number]: relative parameter distance that counts as a
	                                different solution
	}

Output:
	agreement [object]: {
	  comparable [boolean]: false when fewer than two starts converged
	  startCount, convergedCount [number]
	  bestDeviance [number], devianceSpread [number]: over CONVERGED starts
	  equivalentCount [number]: starts inside the deviance window of the best
	  maximumSeparation [number]: largest relative parameter gap among those
	  separatedParameters [array]: { parameter, separation }, worst first
	  multimodal [boolean], trappedStarts [number]
	}

*/
export function multistartAgreement(attempts, {
  freeIndices = [],
  parameterNames = null,
  devianceWindow = EQUIVALENT_DEVIANCE_WINDOW,
  separationTolerance = OPTIMUM_SEPARATION_TOLERANCE,
} = {}) {
  const list = Array.isArray(attempts) ? attempts : [];
  const converged = list.filter((attempt) => attempt?.converged
    && Array.isArray(attempt.parameters) && Number.isFinite(attempt.deviance));
  const empty = {
    comparable: false,
    startCount: list.length,
    convergedCount: converged.length,
    bestDeviance: converged.length ? Math.min(...converged.map((a) => a.deviance)) : NaN,
    devianceSpread: 0,
    equivalentCount: converged.length,
    maximumSeparation: 0,
    separatedParameters: [],
    multimodal: false,
    trappedStarts: 0,
  };
  if (converged.length < 2) return empty;

  const deviances = converged.map((attempt) => attempt.deviance);
  const bestDeviance = Math.min(...deviances);
  const best = converged.find((attempt) => attempt.deviance === bestDeviance);
  const indices = freeIndices.length
    ? [...freeIndices]
    : best.parameters.map((_, index) => index);
  const nameFor = (index, slot) => (parameterNames && parameterNames[slot])
    || `theta[${index}]`;

  const equivalent = converged.filter((attempt) => attempt.deviance - bestDeviance <= devianceWindow);
  const separations = indices.map((index, slot) => {
    const scale = Math.max(Math.abs(best.parameters[index]), 1);
    const separation = Math.max(...equivalent.map((attempt) =>
      Math.abs(attempt.parameters[index] - best.parameters[index]) / scale));
    return { parameter: nameFor(index, slot), separation };
  });
  const separated = separations
    .filter((entry) => entry.separation > separationTolerance)
    .sort((left, right) => right.separation - left.separation);

  return {
    comparable: true,
    startCount: list.length,
    convergedCount: converged.length,
    bestDeviance,
    devianceSpread: Math.max(...deviances) - bestDeviance,
    equivalentCount: equivalent.length,
    maximumSeparation: separations.length ? Math.max(...separations.map((e) => e.separation)) : 0,
    separatedParameters: separated,
    multimodal: equivalent.length > 1 && separated.length > 0,
    trappedStarts: converged.length - equivalent.length,
  };
}

/*

Purpose:
	The warning vocabulary for the uncertainty bundle. Each entry is a reason a
	reader should not treat the interval at face value; `nonreportable` marks the
	ones where the fit failed to identify its own parameters, which GATE-01's
	contract can refuse rather than publish.

Input:
	uncertainty [object]: a parameterUncertainty() result
	intervals [object|null]: a phaseFractionIntervals() result
	options [object]: {
	  fractionUncertaintyThreshold: half-width in fraction units above which a
	                                phase fraction is too uncertain to report
	  multistart [object|null]: a multistartAgreement() result
	  boundaryParameters [array]: names of FREE parameters sitting on a declared
	                              bound at the solution
	  fractionParameters [array]: names of the parameters the phase fractions are
	                              computed from, so a bound on one of those can be
	                              escalated past a bound on a nuisance parameter
	}

Output:
	warnings [array]: { id, severity, nonreportable, message }

*/
export function identifiabilityWarnings(uncertainty, intervals = null, {
  fractionUncertaintyThreshold = 0.1,
  multistart = null,
  boundaryParameters = [],
  fractionParameters = [],
} = {}) {
  const warnings = [];
  if (!uncertainty) return warnings;

  if (uncertainty.rankDeficiency > 0) {
    const directions = uncertainty.nullSpaceDirections
      .map((direction) => direction.loadings.map((l) => `${l.parameter} (${l.weight.toFixed(2)})`).join(" + "))
      .filter(Boolean);
    warnings.push({
      id: "rank_deficient",
      severity: "critical",
      nonreportable: true,
      message: `The fit determined only ${uncertainty.rank} of ${uncertainty.parameterCount} free parameters.`
        + (directions.length ? ` Unidentified combination(s): ${directions.join("; ")}.` : "")
        + " Standard errors along those directions are unbounded, so the reported values are one of many equally good fits.",
    });
  } else if (!Number.isFinite(uncertainty.conditionNumber)
    || uncertainty.conditionNumber > CONDITION_WARNING_THRESHOLD) {
    // Qualified, not blocked: the rank test passing means every direction is
    // still resolvable, so the intervals carry real information -- just fewer
    // significant digits than they appear to. The unusable case is rank
    // deficiency, handled above.
    warnings.push({
      id: "ill_conditioned",
      severity: "warning",
      nonreportable: false,
      message: `The Jacobian condition number is ${Number.isFinite(uncertainty.conditionNumber)
        ? uncertainty.conditionNumber.toExponential(2) : "infinite"}, past the ${CONDITION_WARNING_THRESHOLD.toExponential(0)} `
        + "limit; the parameters are determined only weakly along the worst-conditioned direction, so treat the "
        + "interval widths as approximate.",
    });
  }

  for (const { a, b, correlation } of uncertainty.highCorrelations) {
    warnings.push({
      id: "parameter_correlation",
      severity: "warning",
      nonreportable: false,
      message: `${a} and ${b} are correlated at ${correlation.toFixed(4)}: the data determined their combination, `
        + "not either one separately, so their individual values should not be interpreted.",
    });
  }

  for (const [phase, interval] of Object.entries(intervals ?? {})) {
    if (!Number.isFinite(interval.standardError)) {
      warnings.push({
        id: "fraction_interval_undefined",
        severity: "critical",
        nonreportable: true,
        message: `No interval could be computed for the ${phase.toUpperCase()} fraction.`,
      });
      continue;
    }
    if (interval.clipped) {
      warnings.push({
        id: "fraction_interval_clipped",
        severity: "warning",
        nonreportable: false,
        message: `The ${phase.toUpperCase()} interval ran outside [0, 1] and was truncated; the normal approximation `
          + "is a poor fit near the boundary, so treat the width as a lower bound on the true uncertainty.",
      });
    }
    const halfWidth = 0.5 * (interval.upper - interval.lower);
    if (halfWidth > fractionUncertaintyThreshold) {
      warnings.push({
        id: "fraction_too_uncertain",
        severity: "critical",
        nonreportable: true,
        message: `The ${phase.toUpperCase()} fraction is ${(100 * interval.value).toFixed(1)}% `
          + `+/- ${(100 * halfWidth).toFixed(1)} pp, wider than the ${(100 * fractionUncertaintyThreshold).toFixed(0)} pp `
          + "reportability limit.",
      });
    }
  }

  // Boundary-dominated intervals. Everything above assumes the solution is
  // INTERIOR: a normal interval centred on a parameter pinned against its own
  // bound extends into a region the optimizer was never allowed to visit, so
  // the half-width is not a confidence statement about anything. An area
  // parameter on a bound is worse than a nuisance parameter on one, because the
  // phase fractions are built from the areas.
  const fractionSet = new Set(fractionParameters);
  for (const parameter of boundaryParameters) {
    const structural = fractionSet.has(parameter);
    warnings.push({
      id: "boundary_dominated",
      severity: structural ? "critical" : "warning",
      nonreportable: structural,
      message: `${parameter} is pinned against a declared bound, so the curvature-based interval around it `
        + "extends into parameter space the fit could not enter and its width is not a confidence statement"
        + (structural ? "; the phase fractions are computed from it, so they inherit the problem." : "."),
    });
  }

  // Multimodality. The covariance is blind to it by construction -- it is the
  // curvature of ONE basin -- so this is the only place a second, equally good
  // answer can be reported.
  if (multistart?.multimodal) {
    const named = multistart.separatedParameters
      .slice(0, 4)
      .map((entry) => `${entry.parameter} (${(100 * entry.separation).toFixed(0)}%)`)
      .join(", ");
    warnings.push({
      id: "multimodal_optimum",
      severity: "critical",
      nonreportable: true,
      message: `${multistart.equivalentCount} of ${multistart.convergedCount} converged restarts reached deviances `
        + "a likelihood-ratio test cannot separate, yet disagree about the parameters: "
        + `${named}. The reported values are one of several equally supported solutions, and the intervals above `
        + "describe only the basin the best start happened to land in.",
    });
  } else if (multistart?.comparable && multistart.trappedStarts > 0) {
    warnings.push({
      id: "restart_dispersion",
      severity: "warning",
      nonreportable: false,
      message: `${multistart.trappedStarts} of ${multistart.convergedCount} converged restarts settled in worse `
        + `local minima (deviance spread ${multistart.devianceSpread.toFixed(1)}). The optimum is start-dependent, `
        + "so a different start set could report different values from the same data.",
    });
  }

  return warnings;
}
