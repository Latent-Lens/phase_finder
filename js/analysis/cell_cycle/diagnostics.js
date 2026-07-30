// Model-neutral Poisson fit diagnostics: every canonical generative model
// (Dean-Jett, Dean-Jett-Fox, Watson) reports the same deviance/residual/
// information-criterion bundle and the same warning vocabulary, built from
// js/analysis/math/poisson.js's raw statistics plus this module's AICc/BIC and
// tail-mass/boundary checks. Exposes the two information criteria
// (akaikeInformationCriterionCorrected, bayesianInformationCriterion), the
// full bundle builder (buildPoissonFitDiagnostics), and the warning generators
// (fitQualityWarnings, tailMassWarning, boundaryHitWarnings). Kept separate from
// any one model file so the plot/report layer and every model read (and can
// compare) the identical diagnostics shape.

import {
  poissonLogLikelihood,
  poissonDeviance,
  pearsonResiduals,
  poissonDevianceResiduals,
  lag1Autocorrelation,
  runsTestZ,
} from "../math/poisson.js";

const EPS = 1e-12;

/*

Purpose:
	Corrected AIC (Hurvich-Tsai): AIC plus a small-sample bias correction that
	blows up to Infinity -- never a misleadingly finite number -- once the sample
	size no longer exceeds the parameter count by more than 1.

Input:
	logLikelihood [number]: the fit's Poisson log-likelihood
	parameterCount [number]: number of free parameters
	sampleSize [number]: number of fitted bins

Output:
	aicc [number]: the corrected AIC, or Infinity when uncorrectable

*/
export function akaikeInformationCriterionCorrected(logLikelihood, parameterCount, sampleSize) {
  const aic = 2 * parameterCount - 2 * logLikelihood;
  const denominator = sampleSize - parameterCount - 1;
  return denominator > 0 ? aic + (2 * parameterCount * (parameterCount + 1)) / denominator : Infinity;
}

/*

Purpose:
	Bayesian information criterion for a fit.

Input:
	logLikelihood [number]: the fit's Poisson log-likelihood
	parameterCount [number]: number of free parameters
	sampleSize [number]: number of fitted bins

Output:
	bic [number]: the BIC

*/
export function bayesianInformationCriterion(logLikelihood, parameterCount, sampleSize) {
  return parameterCount * Math.log(Math.max(sampleSize, EPS)) - 2 * logLikelihood;
}

export function akaikeInformationCriterion(logLikelihood, parameterCount) {
  return 2 * parameterCount - 2 * logLikelihood;
}

function observation_key(counts) {
  let hash = 2166136261;
  let total = 0;
  for (const count of counts) {
    total += count;
    for (const character of String(count)) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 44;
    hash = Math.imul(hash, 16777619);
  }
  return `poisson:${counts.length}:${total}:${hash >>> 0}`;
}

/*

Purpose:
	Builds the full diagnostics bundle for one fitted histogram: log-likelihood,
	deviance (raw and reduced), both residual families, the two structure checks
	(lag-1 autocorrelation and the runs test) that distinguish "noisy but
	unbiased" from "systematically wrong in one region", and AICc/BIC.

Input:
	spec [object]: { observedCounts, expectedCounts, parameterCount } --
	               parameterCount must be the number of FREE parameters the
	               optimizer actually moved, and n is the number of fitted bins

Output:
	diagnostics [object]: { logLikelihood, deviance, degreesOfFreedom,
	                        reducedDeviance, devianceResiduals, pearsonResiduals,
	                        lag1Autocorrelation, runsTestZ, aicc, bic }

*/
export function buildPoissonFitDiagnostics({ observedCounts, expectedCounts, parameterCount }) {
  if (observedCounts.length !== expectedCounts.length) {
    throw new Error("observedCounts and expectedCounts must have the same length.");
  }
  const n = observedCounts.length;
  const logLikelihood = poissonLogLikelihood(observedCounts, expectedCounts);
  const deviance = poissonDeviance(observedCounts, expectedCounts);
  const degreesOfFreedom = Math.max(0, n - parameterCount);
  const reducedDeviance = degreesOfFreedom > 0 ? deviance / degreesOfFreedom : NaN;
  const devianceResiduals = poissonDevianceResiduals(observedCounts, expectedCounts);

  return {
    logLikelihood,
    aic: akaikeInformationCriterion(logLikelihood, parameterCount),
    deviance,
    degreesOfFreedom,
    reducedDeviance,
    devianceResiduals,
    pearsonResiduals: pearsonResiduals(observedCounts, expectedCounts),
    lag1Autocorrelation: lag1Autocorrelation(devianceResiduals),
    runsTestZ: runsTestZ(devianceResiduals),
    aicc: akaikeInformationCriterionCorrected(logLikelihood, parameterCount, n),
    bic: bayesianInformationCriterion(logLikelihood, parameterCount, n),
    informationCriterionScope: "same_observed_histogram",
    observationKey: observation_key(observedCounts),
    parameterCount,
  };
}

/*

Purpose:
	Structure-quality warnings derived from an already-built diagnostics bundle
	(overdispersion, residual autocorrelation, and residual-sign runs). The
	thresholds are versioned heuristics, not calibrated probabilities; callers
	needing different sensitivity pass overrides.

Input:
	diagnostics [object]: a bundle from buildPoissonFitDiagnostics
	thresholds [object]: optional { reducedDevianceThreshold, lag1Threshold,
	                     runsZThreshold }

Output:
	warnings [array]: zero or more { code, severity, message } warnings

*/
export function fitQualityWarnings(diagnostics, { reducedDevianceThreshold = 2, lag1Threshold = 0.3, runsZThreshold = 2 } = {}) {
  const warnings = [];
  const { reducedDeviance, lag1Autocorrelation: lag1, runsTestZ: runsZ } = diagnostics;

  if (diagnostics.optimizer?.weaklyIdentified) {
    warnings.push({
      code: "weak_optimizer_identifiability",
      severity: "warning",
      message: "The optimizer Jacobian is rank-deficient or poorly conditioned; fitted parameters may be weakly identified.",
    });
  }

  if (Number.isFinite(reducedDeviance) && reducedDeviance > reducedDevianceThreshold) {
    warnings.push({
      code: "overdispersed_fit",
      severity: "warning",
      message: `Reduced deviance ${reducedDeviance.toFixed(2)} is well above 1; the fitted model may not fully explain the observed counts.`,
    });
  }
  if (Number.isFinite(lag1) && Math.abs(lag1) > lag1Threshold) {
    warnings.push({
      code: "residual_autocorrelation",
      severity: "warning",
      message: `Lag-1 residual autocorrelation ${lag1.toFixed(2)} suggests structured misfit rather than noise.`,
    });
  }
  if (Number.isFinite(runsZ) && Math.abs(runsZ) > runsZThreshold) {
    warnings.push({
      code: "residual_runs",
      severity: "warning",
      message: `Residual signs cluster into long runs (z=${runsZ.toFixed(2)}), indicating a systematically under- or over-fit region.`,
    });
  }
  return warnings;
}

/*

Purpose:
	Warns when a component's fitted total area extends materially beyond the
	observed histogram domain, so total-area fractions that are sensitive to the
	chosen domain are flagged.

Input:
	spec [object]: { componentId, componentLabel, totalArea (the model's
	               untruncated area parameter), observedDomainArea (the summed
	               in-domain per-bin counts), thresholdFraction }

Output:
	warning [object|null]: a { code, severity, componentId, message } warning, or
	                       null when the missing fraction is below threshold

*/
export function tailMassWarning({ componentId, componentLabel, totalArea, observedDomainArea, thresholdFraction = 0.02 }) {
  if (!(totalArea > 0)) return null;
  const missingFraction = 1 - observedDomainArea / totalArea;
  if (!(missingFraction > thresholdFraction)) return null;
  return {
    code: "component_tail_mass_outside_domain",
    severity: "warning",
    componentId,
    message: `${componentLabel ?? componentId}: ${(missingFraction * 100).toFixed(1)}% of the fitted area falls outside the observed histogram domain; total-area fractions may be sensitive to the fit domain.`,
  };
}

/*

Purpose:
	Warns when a free parameter's fitted value sits at (or within a relative
	epsilon of) one of its bounds -- the optimizer wanted to move further but a
	hard constraint stopped it, so the reported optimum may be an artifact of the
	bound.

Input:
	namedParameters [object]: parameter name -> fitted value
	bounds [object]: parameter name -> { min?, max? } (either side may be omitted)
	options [object]: optional { epsilon } relative closeness to a bound

Output:
	warnings [array]: zero or more { code, severity, parameter, message } warnings

*/
export function boundaryHitWarnings(namedParameters, bounds, { epsilon = 1e-3 } = {}) {
  const warnings = [];
  for (const [name, { min, max } = {}] of Object.entries(bounds)) {
    const value = namedParameters[name];
    if (!Number.isFinite(value)) continue;
    const scale = Math.max(Math.abs(value), 1);
    if (Number.isFinite(min) && Math.abs(value - min) <= epsilon * scale) {
      warnings.push({
        code: "parameter_at_lower_bound",
        severity: "warning",
        parameter: name,
        message: `${name} converged at its lower bound (${min}); the true optimum may lie outside the configured range.`,
      });
    } else if (Number.isFinite(max) && Math.abs(value - max) <= epsilon * scale) {
      warnings.push({
        code: "parameter_at_upper_bound",
        severity: "warning",
        parameter: name,
        message: `${name} converged at its upper bound (${max}); the true optimum may lie outside the configured range.`,
      });
    }
  }
  return warnings;
}
