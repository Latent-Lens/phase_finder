// Stage 7: optional debris/aggregate extension with conservative selection.
//
// This intentionally ports the source implementation's simple contamination
// model: aggregate = 0.5 * p * F(x / 2), plus a left-edge exponential debris
// term.  It is not the self-convolution/Bagwell model described in the prose.

import {
  clamp,
  maximumValue,
  median,
  robustResidualScale,
  sumSquares,
} from "./math/stats.js";
import { logistic } from "./math/gaussian.js";
import {
  buildFiniteDiffJacobian,
  buildNormalEquations,
  runLevenbergMarquardt,
  solveLinearSystem,
} from "./math/lm_solver.js";
import {
  PARAMETER_INDEX,
  gaussianPeak,
  evaluateSBridge,
  evaluateBaseAt,
} from "./djf_components.js";

const DEFAULT_EXTENSION_OPTIONS = Object.freeze({
  cvMin: 0.01,
  cvMax: 0.2,
  ratioTarget: 2.0,
  ratioMin: 1.7,
  ratioMax: 2.3,
  unlockRatio: false,
  aggregateDetectionZ: 2.5,
  debrisDetectionZ: 2.5,
  minimumTemplateCorrelation: 0.2,
  maxIterations: 150,
  tolerance: 1e-7,
  stepTolerance: 1e-6,
  initialLambda: 1e-2,
  finiteDifferenceStep: 1e-4,
  weightedResiduals: false,
  aggregateMaxFraction: 1.0,
  debrisTauMinFraction: 0.02,
  debrisTauMaxFraction: 0.75,
  minRelativeSseImprovement: 0.02,
  minBicImprovement: 6.0,
  minTargetResidualImprovement: 0.2,
});

const INDEX = Object.freeze({
  ...PARAMETER_INDEX,
  P_AGGREGATE: 9,
  DEBRIS_AMPLITUDE: 10,
  DEBRIS_TAU: 11,
});

const MODEL_FLAGS = Object.freeze({
  BASE: Object.freeze({ aggregate: false, debris: false }),
  AGGREGATE: Object.freeze({ aggregate: true, debris: false }),
  DEBRIS: Object.freeze({ aggregate: false, debris: true }),
  BOTH: Object.freeze({ aggregate: true, debris: true }),
});

function isArrayLikeSequence(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Number.isSafeInteger(value.length) &&
    value.length >= 0
  );
}

function normalizedPositiveCorrelation(values, template) {
  if (!isArrayLikeSequence(values) || !isArrayLikeSequence(template)) return 0;
  const length = Math.min(values.length, template.length);
  let dot = 0;
  let valueNorm = 0;
  let templateNorm = 0;

  for (let i = 0; i < length; i += 1) {
    const positiveValue = Math.max(0, values[i]);
    const positiveTemplate = Math.max(0, template[i]);
    dot += positiveValue * positiveTemplate;
    valueNorm += positiveValue * positiveValue;
    templateNorm += positiveTemplate * positiveTemplate;
  }

  return valueNorm === 0 || templateNorm === 0
    ? 0
    : dot / Math.sqrt(valueNorm * templateNorm);
}

function evaluateAggregateAt(xValue, parameters) {
  const p = parameters[INDEX.P_AGGREGATE];
  if (!(p > 0)) return 0;
  return 0.5 * p * evaluateBaseAt(xValue / 2, parameters).total;
}

function evaluateDebrisAt(xValue, xMinimum, parameters) {
  const amplitude = parameters[INDEX.DEBRIS_AMPLITUDE];
  const tau = parameters[INDEX.DEBRIS_TAU];
  if (!(amplitude > 0) || !(tau > 0)) return 0;

  const mu1 = parameters[INDEX.MU1];
  const sigma1 = parameters[INDEX.SIGMA1];
  const distanceFromLeft = Math.max(0, xValue - xMinimum);
  const decay = Math.exp(-distanceFromLeft / tau);
  const cutoffCenter = mu1 - sigma1;
  const cutoffWidth = Math.max(0.25 * sigma1, 1e-12);
  const leftWindow = logistic((cutoffCenter - xValue) / cutoffWidth);
  return amplitude * decay * leftWindow;
}

function evaluateCandidateModel(x, parameters, flags) {
  const xMinimum = x[0];
  const g1 = new Array(x.length);
  const s = new Array(x.length);
  const g2 = new Array(x.length);
  const aggregate = new Array(x.length).fill(0);
  const debris = new Array(x.length).fill(0);
  const fitted = new Array(x.length);

  for (let i = 0; i < x.length; i += 1) {
    const base = evaluateBaseAt(x[i], parameters);
    g1[i] = base.g1;
    s[i] = base.s;
    g2[i] = base.g2;
    if (flags.aggregate) aggregate[i] = evaluateAggregateAt(x[i], parameters);
    if (flags.debris) {
      debris[i] = evaluateDebrisAt(x[i], xMinimum, parameters);
    }
    fitted[i] = g1[i] + s[i] + g2[i] + aggregate[i] + debris[i];
  }
  return { g1, s, g2, aggregate, debris, fitted };
}

function parametersFromPreviousFit(previousFit, x, y) {
  const source = previousFit?.parameters;
  if (!source) throw new TypeError("previousFit.parameters is required.");

  const mu1 = source.mu1;
  const ratio = source.R ?? source.mu2 / source.mu1;
  if (!Number.isFinite(mu1) || !Number.isFinite(ratio)) {
    throw new RangeError(
      "The previous fit does not contain valid mu1 and R values.",
    );
  }

  const residuals = previousFit.curves?.residuals;
  let initialDebrisAmplitude = 0;
  if (isArrayLikeSequence(residuals) && residuals.length === x.length) {
    for (let i = 0; i < x.length; i += 1) {
      const insideDebrisRegion = x[i] < mu1 - 2 * source.sigma1;
      if (insideDebrisRegion) {
        initialDebrisAmplitude = Math.max(
          initialDebrisAmplitude,
          Math.max(0, -residuals[i]),
        );
      }
    }
  } else {
    initialDebrisAmplitude = 0.01 * Math.max(maximumValue(y), 0);
  }

  return [
    source.mu1,
    ratio,
    source.sigma1,
    source.sigma2,
    source.a1,
    source.a2,
    source.s0,
    source.s1,
    source.s2,
    0.05,
    initialDebrisAmplitude,
    0.2 * mu1,
  ];
}

function projectParameters(parameters, x, options, flags) {
  const projected = Array.from(parameters);
  const xMinimum = x[0];
  const xMaximum = x[x.length - 1];
  const xSpan = Math.max(xMaximum - xMinimum, Number.EPSILON);
  const ratio = options.unlockRatio
    ? clamp(projected[INDEX.R], options.ratioMin, options.ratioMax)
    : options.ratioTarget;
  const minimumMu1 = Math.max(xMinimum + 1e-6 * xSpan, Number.EPSILON);
  const maximumMu1 = Math.max(
    minimumMu1,
    (xMaximum - 1e-6 * xSpan) / ratio,
  );
  const mu1 = clamp(projected[INDEX.MU1], minimumMu1, maximumMu1);
  const mu2 = ratio * mu1;

  projected[INDEX.MU1] = mu1;
  projected[INDEX.R] = ratio;
  projected[INDEX.SIGMA1] = clamp(
    Math.abs(projected[INDEX.SIGMA1]),
    options.cvMin * mu1,
    options.cvMax * mu1,
  );
  projected[INDEX.SIGMA2] = clamp(
    Math.abs(projected[INDEX.SIGMA2]),
    options.cvMin * mu2,
    options.cvMax * mu2,
  );

  for (const index of [
    INDEX.A1,
    INDEX.A2,
    INDEX.S0,
    INDEX.S1,
    INDEX.S2,
  ]) {
    projected[index] = Math.max(0, projected[index]);
  }

  projected[INDEX.P_AGGREGATE] = flags.aggregate
    ? clamp(
        projected[INDEX.P_AGGREGATE],
        0,
        options.aggregateMaxFraction,
      )
    : 0;
  projected[INDEX.DEBRIS_AMPLITUDE] = flags.debris
    ? Math.max(0, projected[INDEX.DEBRIS_AMPLITUDE])
    : 0;
  projected[INDEX.DEBRIS_TAU] = flags.debris
    ? clamp(
        Math.abs(projected[INDEX.DEBRIS_TAU]),
        options.debrisTauMinFraction * mu1,
        options.debrisTauMaxFraction * mu1,
      )
    : 0.2 * mu1;
  return projected;
}

function computeResiduals(x, y, parameters, options, flags) {
  const model = evaluateCandidateModel(x, parameters, flags);
  const rawResiduals = new Array(y.length);
  const objectiveResiduals = new Array(y.length);
  for (let i = 0; i < y.length; i += 1) {
    const raw = model.fitted[i] - y[i];
    rawResiduals[i] = raw;
    objectiveResiduals[i] = options.weightedResiduals
      ? raw / Math.sqrt(Math.max(y[i], 1))
      : raw;
  }
  return { model, rawResiduals, objectiveResiduals };
}

function inspectResidualStructure(x, y, previousFit, options) {
  const residuals = previousFit.curves?.residuals;
  const parameters = parametersFromPreviousFit(previousFit, x, y);
  if (!isArrayLikeSequence(residuals) || residuals.length !== x.length) {
    throw new RangeError(
      "previousFit.curves.residuals must exist and match the histogram length.",
    );
  }

  const residualScale = robustResidualScale(residuals);
  const observedExcess = Array.from(residuals, (value) => Math.max(0, -value));
  const aggregateTemplate = Array.from(
    x,
    (xValue) => 0.5 * evaluateBaseAt(xValue / 2, parameters).total,
  );
  const mu1 = parameters[INDEX.MU1];
  const sigma1 = parameters[INDEX.SIGMA1];
  const debrisTemplate = Array.from(x, (xValue) => {
    if (xValue >= mu1 - sigma1) return 0;
    return Math.exp(-Math.max(0, xValue - x[0]) / (0.2 * mu1));
  });

  const aggregateCorrelation = normalizedPositiveCorrelation(
    observedExcess,
    aggregateTemplate,
  );
  const debrisCorrelation = normalizedPositiveCorrelation(
    observedExcess,
    debrisTemplate,
  );
  let aggregateWeightedExcess = 0;
  let aggregateWeight = 0;
  let debrisWeightedExcess = 0;
  let debrisWeight = 0;

  for (let i = 0; i < x.length; i += 1) {
    aggregateWeightedExcess += observedExcess[i] * aggregateTemplate[i];
    aggregateWeight += aggregateTemplate[i];
    debrisWeightedExcess += observedExcess[i] * debrisTemplate[i];
    debrisWeight += debrisTemplate[i];
  }

  const aggregateExcessZ =
    aggregateWeight > 0
      ? aggregateWeightedExcess / aggregateWeight / residualScale
      : 0;
  const debrisExcessZ =
    debrisWeight > 0 ? debrisWeightedExcess / debrisWeight / residualScale : 0;
  const aggregateDetected =
    aggregateExcessZ >= options.aggregateDetectionZ &&
    aggregateCorrelation >= options.minimumTemplateCorrelation;
  const debrisDetected =
    debrisExcessZ >= options.debrisDetectionZ &&
    debrisCorrelation >= options.minimumTemplateCorrelation;

  return {
    aggregateDetected,
    debrisDetected,
    residualScale,
    aggregateExcessZ,
    debrisExcessZ,
    aggregateCorrelation,
    debrisCorrelation,
    templates: { aggregate: aggregateTemplate, debris: debrisTemplate },
  };
}

function getFreeParameterIndices(options, flags) {
  const indices = [INDEX.MU1];
  if (options.unlockRatio) indices.push(INDEX.R);
  indices.push(
    INDEX.SIGMA1,
    INDEX.SIGMA2,
    INDEX.A1,
    INDEX.A2,
    INDEX.S0,
    INDEX.S1,
    INDEX.S2,
  );
  if (flags.aggregate) indices.push(INDEX.P_AGGREGATE);
  if (flags.debris) indices.push(INDEX.DEBRIS_AMPLITUDE, INDEX.DEBRIS_TAU);
  return indices;
}

// Source-compatible adapter around the shared finite-difference implementation.
function buildJacobian(
  x,
  y,
  parameters,
  baseResiduals,
  freeParameterIndices,
  options,
  flags,
) {
  return buildFiniteDiffJacobian({
    parameters,
    baseResiduals,
    freeIndices: freeParameterIndices,
    residualFn: (candidate) =>
      computeResiduals(x, y, candidate, options, flags),
    projectFn: (candidate) =>
      projectParameters(candidate, x, options, flags),
    finiteDifferenceStep: options.finiteDifferenceStep,
  });
}

function fitCandidateModel(x, y, initialParameters, options, flags) {
  const freeParameterIndices = getFreeParameterIndices(options, flags);
  const projectFn = (parameters) =>
    projectParameters(parameters, x, options, flags);
  const residualFn = (parameters) =>
    computeResiduals(x, y, parameters, options, flags);
  const fitted = runLevenbergMarquardt({
    initialParameters,
    residualFn,
    projectFn,
    freeIndices: freeParameterIndices,
    options,
  });

  return {
    flags,
    parameters: fitted.parameters,
    model: fitted.model,
    rawResiduals: fitted.rawResiduals,
    objectiveResiduals: fitted.objectiveResiduals,
    sse: fitted.sse,
    parameterCount: fitted.parameterCount,
    iterations: fitted.iterations,
    converged: fitted.converged,
    finalLambda: fitted.finalLambda,
  };
}

function calculateBic(sse, observationCount, parameterCount) {
  const safeSse = Math.max(sse, 1e-12);
  return (
    observationCount * Math.log(safeSse / observationCount) +
    parameterCount * Math.log(observationCount)
  );
}

function targetedResidualEnergy(x, residuals, parameters, target) {
  let energy = 0;
  const mu1 = parameters[INDEX.MU1];
  const sigma1 = parameters[INDEX.SIGMA1];
  for (let i = 0; i < x.length; i += 1) {
    const observedExcess = Math.max(0, -residuals[i]);
    let weight = 0;
    if (target === "aggregate") {
      weight = 0.5 * evaluateBaseAt(x[i] / 2, parameters).total;
    }
    if (target === "debris" && x[i] < mu1 - sigma1) {
      weight = Math.exp(-Math.max(0, x[i] - x[0]) / (0.2 * mu1));
    }
    energy += weight * observedExcess * observedExcess;
  }
  return energy;
}

function summarizeCandidate(x, y, candidate) {
  return {
    ...candidate,
    bic: calculateBic(candidate.sse, y.length, candidate.parameterCount),
    aggregateResidualEnergy: targetedResidualEnergy(
      x,
      candidate.rawResiduals,
      candidate.parameters,
      "aggregate",
    ),
    debrisResidualEnergy: targetedResidualEnergy(
      x,
      candidate.rawResiduals,
      candidate.parameters,
      "debris",
    ),
  };
}

function compareWithBase(base, candidate, options) {
  const relativeSseImprovement =
    (base.sse - candidate.sse) / Math.max(base.sse, 1e-12);
  const bicImprovement = base.bic - candidate.bic;
  const targetImprovements = [];

  if (candidate.flags.aggregate) {
    targetImprovements.push(
      (base.aggregateResidualEnergy - candidate.aggregateResidualEnergy) /
        Math.max(base.aggregateResidualEnergy, 1e-12),
    );
  }
  if (candidate.flags.debris) {
    targetImprovements.push(
      (base.debrisResidualEnergy - candidate.debrisResidualEnergy) /
        Math.max(base.debrisResidualEnergy, 1e-12),
    );
  }
  const targetResidualImprovement =
    targetImprovements.length > 0 ? Math.min(...targetImprovements) : 0;
  const materiallyImproved =
    relativeSseImprovement >= options.minRelativeSseImprovement &&
    bicImprovement >= options.minBicImprovement &&
    targetResidualImprovement >= options.minTargetResidualImprovement;

  return {
    relativeSseImprovement,
    bicImprovement,
    targetResidualImprovement,
    materiallyImproved,
  };
}

function chooseModel(candidates, options) {
  const base = candidates.find(
    (candidate) => !candidate.flags.aggregate && !candidate.flags.debris,
  );
  if (!base) throw new Error("A base candidate is required for model selection.");

  const comparisons = [];
  const eligible = [base];
  for (const candidate of candidates) {
    if (candidate === base) continue;
    const comparison = compareWithBase(base, candidate, options);
    comparisons.push({ candidate, comparison });
    if (comparison.materiallyImproved) eligible.push(candidate);
  }

  eligible.sort((first, second) => {
    if (first.parameterCount !== second.parameterCount) {
      return first.parameterCount - second.parameterCount;
    }
    return first.bic - second.bic;
  });
  let selected = eligible[0];
  for (const candidate of eligible.slice(1)) {
    if (selected.bic - candidate.bic >= options.minBicImprovement) {
      selected = candidate;
    }
  }
  return { selected, comparisons };
}

function validateInput(x, y, previousFit) {
  if (!isArrayLikeSequence(x) || !isArrayLikeSequence(y)) {
    throw new TypeError("x and y must both be arrays or typed arrays.");
  }
  if (x.length !== y.length || x.length < 10) {
    throw new RangeError(
      "x and y must have equal lengths and contain at least 10 bins.",
    );
  }
  for (let i = 0; i < x.length; i += 1) {
    if (!Number.isFinite(x[i])) throw new RangeError(`x[${i}] is not finite.`);
    if (!Number.isFinite(y[i]) || y[i] < 0) {
      throw new RangeError(`y[${i}] must be finite and nonnegative.`);
    }
    if (i > 0 && x[i] <= x[i - 1]) {
      throw new RangeError("x must be strictly increasing.");
    }
  }
  if (!previousFit?.parameters || !previousFit?.curves) {
    throw new TypeError(
      "previousFit must be the result returned by fitCellCycleHistogram().",
    );
  }
}

function extendCellCycleFit(xInput, yInput, previousFit, userOptions = {}) {
  validateInput(xInput, yInput, previousFit);
  const x = Array.from(xInput);
  const y = Array.from(yInput);
  const options = { ...DEFAULT_EXTENSION_OPTIONS, ...userOptions };
  const inspection = inspectResidualStructure(x, y, previousFit, options);
  const initialParameters = parametersFromPreviousFit(previousFit, x, y);
  const candidateDefinitions = [{ name: "base", flags: MODEL_FLAGS.BASE }];

  if (inspection.aggregateDetected) {
    candidateDefinitions.push({
      name: "base+aggregate",
      flags: MODEL_FLAGS.AGGREGATE,
    });
  }
  if (inspection.debrisDetected) {
    candidateDefinitions.push({
      name: "base+debris",
      flags: MODEL_FLAGS.DEBRIS,
    });
  }
  if (inspection.aggregateDetected && inspection.debrisDetected) {
    candidateDefinitions.push({
      name: "base+aggregate+debris",
      flags: MODEL_FLAGS.BOTH,
    });
  }

  const candidates = candidateDefinitions.map(({ name, flags }) => ({
    name,
    ...summarizeCandidate(
      x,
      y,
      fitCandidateModel(x, y, initialParameters, options, flags),
    ),
  }));
  const { selected, comparisons } = chooseModel(candidates, options);
  const parameters = selected.parameters;
  const mu1 = parameters[INDEX.MU1];
  const ratio = parameters[INDEX.R];
  const mu2 = ratio * mu1;

  return {
    selectedModel: selected.name,
    parameters: {
      mu1,
      mu2,
      R: ratio,
      sigma1: parameters[INDEX.SIGMA1],
      sigma2: parameters[INDEX.SIGMA2],
      cv1: parameters[INDEX.SIGMA1] / mu1,
      cv2: parameters[INDEX.SIGMA2] / mu2,
      a1: parameters[INDEX.A1],
      a2: parameters[INDEX.A2],
      s0: parameters[INDEX.S0],
      s1: parameters[INDEX.S1],
      s2: parameters[INDEX.S2],
      pAggregate: selected.flags.aggregate
        ? parameters[INDEX.P_AGGREGATE]
        : 0,
      debrisAmplitude: selected.flags.debris
        ? parameters[INDEX.DEBRIS_AMPLITUDE]
        : 0,
      debrisTau: selected.flags.debris ? parameters[INDEX.DEBRIS_TAU] : 0,
    },
    curves: {
      x: [...x],
      observed: [...y],
      g1: selected.model.g1,
      s: selected.model.s,
      g2: selected.model.g2,
      aggregate: selected.model.aggregate,
      debris: selected.model.debris,
      fitted: selected.model.fitted,
      residuals: selected.rawResiduals,
    },
    inspection,
    diagnostics: {
      converged: selected.converged,
      iterations: selected.iterations,
      sse: selected.sse,
      bic: selected.bic,
      finalLambda: selected.finalLambda,
      candidateFits: candidates.map((candidate) => ({
        name: candidate.name,
        converged: candidate.converged,
        iterations: candidate.iterations,
        parameterCount: candidate.parameterCount,
        sse: candidate.sse,
        bic: candidate.bic,
      })),
      comparisons: comparisons.map(({ candidate, comparison }) => ({
        candidate: candidate.name,
        ...comparison,
      })),
      options,
    },
  };
}

export {
  DEFAULT_EXTENSION_OPTIONS,
  PARAMETER_INDEX,
  INDEX,
  MODEL_FLAGS,
  isArrayLikeSequence,
  normalizedPositiveCorrelation,
  gaussianPeak,
  evaluateSBridge,
  evaluateBaseAt,
  evaluateAggregateAt,
  logistic,
  evaluateDebrisAt,
  evaluateCandidateModel,
  parametersFromPreviousFit,
  projectParameters,
  computeResiduals,
  inspectResidualStructure,
  getFreeParameterIndices,
  buildJacobian,
  buildNormalEquations,
  solveLinearSystem,
  fitCandidateModel,
  calculateBic,
  targetedResidualEnergy,
  summarizeCandidate,
  compareWithBase,
  chooseModel,
  validateInput,
  extendCellCycleFit,
  // Source utility names retained after consolidation into shared math modules.
  clamp,
  median,
  sumSquares,
  robustResidualScale,
};
