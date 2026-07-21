// Model-neutral Poisson fit diagnostics (plan §5.1/§4.5): every canonical
// generative model (Dean-Jett here; Dean-Jett-Fox/Watson later) reports the
// same deviance/residual/information-criterion bundle and the same warning
// vocabulary, built from js/analysis/math/poisson.js's raw statistics plus
// this module's AICc/BIC and tail-mass/boundary checks. Kept separate from
// any one model file so the plot/report layer and future models can all read
// (and eventually compare) the identical diagnostics shape.

import {
  poissonLogLikelihood,
  poissonDeviance,
  pearsonResiduals,
  poissonDevianceResiduals,
  lag1Autocorrelation,
  runsTestZ,
} from "../math/poisson.js";

const EPS = 1e-12;

/** Corrected AIC (Hurvich-Tsai): AIC plus a small-sample bias correction that
 * blows up (reported as Infinity, never a misleadingly finite number) once
 * the sample size no longer exceeds parameterCount by more than 1. */
export function akaikeInformationCriterionCorrected(logLikelihood, parameterCount, sampleSize) {
  const aic = 2 * parameterCount - 2 * logLikelihood;
  const denominator = sampleSize - parameterCount - 1;
  return denominator > 0 ? aic + (2 * parameterCount * (parameterCount + 1)) / denominator : Infinity;
}

export function bayesianInformationCriterion(logLikelihood, parameterCount, sampleSize) {
  return parameterCount * Math.log(Math.max(sampleSize, EPS)) - 2 * logLikelihood;
}

/**
 * Full §5.1 diagnostics bundle for one fitted histogram: log-likelihood,
 * deviance (raw and reduced), both residual families, the two structure
 * checks (lag-1 autocorrelation and the runs test) that distinguish "noisy
 * but unbiased" from "systematically wrong in one region", and AICc/BIC.
 * `parameterCount` must be the number of *free* parameters the optimizer
 * actually moved, matching plan §5.1's "use the number of fitted bins as n"
 * and never mixing that with a locked/derived parameter's count.
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
    deviance,
    degreesOfFreedom,
    reducedDeviance,
    devianceResiduals,
    pearsonResiduals: pearsonResiduals(observedCounts, expectedCounts),
    lag1Autocorrelation: lag1Autocorrelation(devianceResiduals),
    runsTestZ: runsTestZ(devianceResiduals),
    aicc: akaikeInformationCriterionCorrected(logLikelihood, parameterCount, n),
    bic: bayesianInformationCriterion(logLikelihood, parameterCount, n),
  };
}

/** Structure-quality warnings from an already-built diagnostics bundle.
 * Thresholds are versioned heuristics (documented here, not calibrated
 * probabilities) -- callers needing different sensitivity pass overrides. */
export function fitQualityWarnings(diagnostics, { reducedDevianceThreshold = 2, lag1Threshold = 0.3, runsZThreshold = 2 } = {}) {
  const warnings = [];
  const { reducedDeviance, lag1Autocorrelation: lag1, runsTestZ: runsZ } = diagnostics;

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

/**
 * Warns when a component's fitted total area extends materially beyond the
 * observed histogram domain (plan §5.1: "warn when missing tail mass is
 * large enough to make total-area fractions sensitive to the chosen
 * domain"). `totalArea` is the model's area *parameter* (the true, untruncated
 * area); `observedDomainArea` is the sum of that component's actual per-bin
 * counts, which the domain silently truncates.
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

/**
 * Warns when a free parameter's fitted value sits at (or within `epsilon`
 * relative distance of) one of its bounds -- the optimizer wanted to move
 * further but a hard constraint stopped it. `bounds` maps parameter name to
 * `{ min, max }`; either may be omitted for a one-sided or unbounded
 * parameter.
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
