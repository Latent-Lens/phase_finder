// Model-agnostic Poisson-count histogram fit engine (plan §5.7): any
// per-sample generative model (Dean-Jett now, Dean-Jett-Fox/Watson later)
// supplies expectedCountsFn/projectFn/parameterStarts and gets back a fit
// selected the same principled way -- minimize total Poisson deviance (via
// poissonDevianceResiduals, so the LM sum-of-squares objective matches the
// count likelihood, not SSE), from the best of several deterministic
// restarts. This module owns none of a specific model's equations or
// parameterization; models/dean_jett.js (and its future siblings) own that.

import { runLevenbergMarquardt } from "../math/lm_solver.js";
import { poissonDeviance, poissonDevianceResiduals } from "../math/poisson.js";

/**
 * Fits one Poisson-count histogram model from multiple deterministic
 * starting points and returns the best result plus a full per-start audit
 * trail (models/dean_jett.js records this in diagnostics for the "restarts"
 * transparency the plan calls for in §4.5/§5.7).
 *
 * `expectedCountsFn(parameters)` and `projectFn(parameters)` are the only
 * model-specific hooks; `parameterStarts` is a nonempty array of raw
 * parameter arrays (already in the caller's chosen order) to restart from.
 * `freeIndices` selects which parameter positions the optimizer may move --
 * a locked-ratio or equal-CV model constrains a parameter by omitting it
 * here and folding it into projectFn instead, not by leaving it "free" and
 * hoping the projection undoes every step.
 *
 * A `shouldCancel` that fires during any restart short-circuits the whole
 * multi-start loop and returns that attempt as `cancelled: true` immediately
 * -- there is no value in racing further restarts against a fit the caller
 * already gave up on.
 */
export function fitPoissonModel({
  observedCounts,
  parameterStarts,
  freeIndices,
  expectedCountsFn,
  projectFn,
  options = {},
}) {
  if (typeof expectedCountsFn !== "function" || typeof projectFn !== "function") {
    throw new TypeError("expectedCountsFn and projectFn must both be functions.");
  }
  if (!Array.isArray(parameterStarts) || parameterStarts.length === 0) {
    throw new TypeError("parameterStarts must be a nonempty array of starting parameter vectors.");
  }

  const attempts = [];
  for (let startIndex = 0; startIndex < parameterStarts.length; startIndex += 1) {
    const residualFn = (parameters) =>
      poissonDevianceResiduals(observedCounts, expectedCountsFn(parameters));

    const result = runLevenbergMarquardt({
      initialParameters: parameterStarts[startIndex],
      residualFn,
      projectFn,
      freeIndices,
      options,
    });

    const expectedCounts = expectedCountsFn(result.parameters);
    const attempt = {
      startIndex,
      parameters: result.parameters,
      expectedCounts,
      deviance: poissonDeviance(observedCounts, expectedCounts),
      converged: result.converged,
      maxIterationsReached: result.maxIterationsReached,
      cancelled: result.cancelled,
      iterations: result.iterations,
      finalLambda: result.finalLambda,
    };
    attempts.push(attempt);

    // A cancelled restart means the caller is tearing the fit down; further
    // restarts would just burn time nobody is going to read the result of.
    if (attempt.cancelled) {
      return { ...attempt, attempts, bestStartIndex: startIndex };
    }
  }

  const converged = attempts.filter((attempt) => attempt.converged);
  const pool = converged.length ? converged : attempts;
  let best = pool[0];
  for (const attempt of pool) {
    if (attempt.deviance < best.deviance) best = attempt;
  }

  return {
    parameters: best.parameters,
    expectedCounts: best.expectedCounts,
    deviance: best.deviance,
    converged: best.converged,
    maxIterationsReached: best.maxIterationsReached,
    cancelled: false,
    iterations: best.iterations,
    finalLambda: best.finalLambda,
    bestStartIndex: best.startIndex,
    attempts,
  };
}
