// Model-agnostic Poisson-count histogram fit engine. Any per-sample generative
// model (Dean-Jett, Dean-Jett-Fox, Watson) supplies expectedCountsFn / projectFn
// / parameterStarts and gets back a fit selected the same principled way:
// minimize total Poisson deviance (via poissonDevianceResiduals, so the LM
// sum-of-squares objective matches the count likelihood, not SSE) from the best
// of several deterministic restarts. Its single export, fitPoissonModel, owns
// none of a model's equations or parameterization -- the model modules do.

import { runLevenbergMarquardt } from "../math/lm_solver.js";
import { poissonDeviance, poissonDevianceResiduals } from "../math/poisson.js";

const TRANSFORM_EPSILON = 1e-12;

function sigmoid(value) {
  return value >= 0
    ? 1 / (1 + Math.exp(-value))
    : Math.exp(value) / (1 + Math.exp(value));
}

// Builds a same-length physical <-> dimensionless coordinate map. Models only
// describe each coordinate; the shared engine owns all transform mechanics.
export function createParameterTransform(specifications) {
  const specs = specifications.map((specification) => specification ?? { type: "identity" });
  const encodeOne = (value, spec) => {
    if (spec.type === "log") return Math.log(Math.max(value, TRANSFORM_EPSILON));
    if (spec.type === "bounded") {
      const fraction = Math.min(1 - TRANSFORM_EPSILON, Math.max(
        TRANSFORM_EPSILON,
        (value - spec.min) / (spec.max - spec.min),
      ));
      return Math.log(fraction / (1 - fraction));
    }
    if (spec.type === "scaled") return (value - spec.center) / spec.scale;
    return value;
  };
  const decodeOne = (value, spec) => {
    if (spec.type === "log") return Math.exp(Math.min(700, value));
    if (spec.type === "bounded") return spec.min + (spec.max - spec.min) * sigmoid(value);
    if (spec.type === "scaled") return spec.center + spec.scale * value;
    return value;
  };
  return {
    encode: (parameters) => parameters.map((value, index) => encodeOne(value, specs[index])),
    decode: (coordinates) => coordinates.map((value, index) => decodeOne(value, specs[index])),
    description: specs.map((specification, index) => ({ index, ...specification })),
  };
}

/*

Purpose:
	Fits one Poisson-count histogram model from multiple deterministic starting
	points and returns the best result plus a full per-start audit trail (the
	models record this for restart-stability transparency). A shouldCancel that
	fires during any restart short-circuits the whole multi-start loop and
	returns that attempt immediately -- there is no value in racing further
	restarts against a fit the caller already gave up on.

Input:
	spec [object]: {
	  observedCounts [array]: the histogram counts to fit,
	  parameterStarts [array]: nonempty array of raw parameter vectors to restart from,
	  freeIndices [array]: which parameter positions the optimizer may move (a
	    locked/derived parameter is omitted here and enforced in projectFn, not
	    left "free"),
	  expectedCountsFn [function]: parameters -> expected per-bin counts,
	  projectFn [function]: parameters -> constrained parameters,
	  options [object]: forwarded to runLevenbergMarquardt (incl. shouldCancel) }

Output:
	result [object]: the best fit -- { parameters, expectedCounts, deviance,
	                 converged, maxIterationsReached, cancelled, iterations,
	                 finalLambda, bestStartIndex, attempts } (attempts is the
	                 per-start audit trail)

*/
export function fitPoissonModel({
  observedCounts,
  parameterStarts,
  freeIndices,
  expectedCountsFn,
  projectFn,
  parameterTransform = null,
  options = {},
}) {
  if (typeof expectedCountsFn !== "function" || typeof projectFn !== "function") {
    throw new TypeError("expectedCountsFn and projectFn must both be functions.");
  }
  if (!Array.isArray(parameterStarts) || parameterStarts.length === 0) {
    throw new TypeError("parameterStarts must be a nonempty array of starting parameter vectors.");
  }

  const transform = parameterTransform ?? {
    encode: (values) => [...values],
    decode: (values) => [...values],
    description: freeIndices.map((index) => ({ index, type: "identity" })),
  };
  const decode = (coordinates) => projectFn(transform.decode(coordinates));
  const projectCoordinates = (coordinates) => transform.encode(decode(coordinates));
  const attempts = [];
  for (let startIndex = 0; startIndex < parameterStarts.length; startIndex += 1) {
    const residualFn = (coordinates) =>
      poissonDevianceResiduals(observedCounts, expectedCountsFn(decode(coordinates)));

    const result = runLevenbergMarquardt({
      initialParameters: transform.encode(projectFn(parameterStarts[startIndex])),
      residualFn,
      projectFn: projectCoordinates,
      freeIndices,
      options,
    });

    const optimizerParameters = result.parameters;
    const parameters = decode(optimizerParameters);
    const expectedCounts = expectedCountsFn(parameters);
    const attempt = {
      startIndex,
      parameters,
      optimizerParameters,
      expectedCounts,
      deviance: poissonDeviance(observedCounts, expectedCounts),
      converged: result.converged,
      terminationReason: result.terminationReason,
      maxIterationsReached: result.maxIterationsReached,
      cancelled: result.cancelled,
      iterations: result.iterations,
      finalLambda: result.finalLambda,
      optimizerDiagnostics: {
        ...result.optimizerDiagnostics,
        parameterCoordinates: transform.description,
      },
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
    optimizerParameters: best.optimizerParameters,
    expectedCounts: best.expectedCounts,
    deviance: best.deviance,
    converged: best.converged,
    terminationReason: best.terminationReason,
    maxIterationsReached: best.maxIterationsReached,
    cancelled: false,
    iterations: best.iterations,
    finalLambda: best.finalLambda,
    optimizerDiagnostics: best.optimizerDiagnostics,
    bestStartIndex: best.startIndex,
    attempts,
  };
}
