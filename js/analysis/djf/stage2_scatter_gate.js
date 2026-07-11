// Stage 2: optional FSC/SSC biological-cloud gate.

import { mad, median, variance } from "./math/stats.js";
import { logGaussian2D, logSumExp } from "./math/gaussian.js";
import {
  calculateGlobalCovariance,
  mahalanobisSquared,
  regularizeCovariance,
} from "./math/linalg2d.js";

export {
  calculateGlobalCovariance,
  logGaussian2D,
  logSumExp,
  mad,
  mahalanobisSquared,
  median,
  regularizeCovariance,
  variance,
};

export const DEFAULT_SCATTER_THRESHOLD = 5.991;

/** Build finite FSC-A/SSC-A points while preserving original event indexes. */
export function buildScatterPoints(dataset, structuralMask = null, timeQCMask = null) {
  const fsc = dataset?.channels?.FSC_A;
  const ssc = dataset?.channels?.SSC_A;

  if (!fsc || !ssc) {
    throw new Error("FSC_A and SSC_A channels are required.");
  }
  if (fsc.length !== ssc.length) {
    throw new Error("FSC_A and SSC_A lengths do not match.");
  }

  const eventCount = dataset.eventCount ?? fsc.length;
  if (fsc.length !== eventCount) {
    throw new Error("FSC_A/SSC_A lengths do not match the event count.");
  }
  for (const mask of [structuralMask, timeQCMask]) {
    if (mask && mask.length !== eventCount) {
      throw new Error("A Stage 2 input mask length does not match the event count.");
    }
  }

  const scatterPoints = [];

  for (let eventIndex = 0; eventIndex < eventCount; eventIndex++) {
    if (structuralMask && structuralMask[eventIndex] === 0) continue;
    if (timeQCMask && timeQCMask[eventIndex] === 0) continue;

    const fscValue = fsc[eventIndex];
    const sscValue = ssc[eventIndex];
    if (!Number.isFinite(fscValue) || !Number.isFinite(sscValue)) continue;

    scatterPoints.push({ eventIndex, point: [fscValue, sscValue] });
  }

  if (scatterPoints.length < 10) {
    throw new Error("Too few valid FSC-A/SSC-A events remain for GMM fitting.");
  }

  return scatterPoints;
}

/** Deterministic robust-quantile initialization (there is deliberately no RNG). */
export function deterministicInitialMeans(points, componentCount) {
  if (!points || points.length === 0 || componentCount < 1) {
    throw new Error("Points and a positive component count are required.");
  }

  const fscValues = points.map(point => point[0]);
  const sscValues = points.map(point => point[1]);
  const medianFSC = median(fscValues);
  const medianSSC = median(sscValues);
  const robustScaleFSC = 1.4826 * mad(fscValues, medianFSC);
  const robustScaleSSC = 1.4826 * mad(sscValues, medianSSC);
  const scaleFSC = Number.isFinite(robustScaleFSC) && robustScaleFSC > 0
    ? robustScaleFSC
    : Math.sqrt(variance(fscValues)) || 1;
  const scaleSSC = Number.isFinite(robustScaleSSC) && robustScaleSSC > 0
    ? robustScaleSSC
    : Math.sqrt(variance(sscValues)) || 1;

  const ranked = points
    .map((point, originalIndex) => ({
      point,
      originalIndex,
      score:
        (point[0] - medianFSC) / scaleFSC +
        (point[1] - medianSSC) / scaleSSC,
    }))
    .sort((a, b) =>
      a.score - b.score ||
      a.point[0] - b.point[0] ||
      a.point[1] - b.point[1] ||
      a.originalIndex - b.originalIndex,
    );

  const means = [];
  for (let componentIndex = 0; componentIndex < componentCount; componentIndex++) {
    const probability = (componentIndex + 0.5) / componentCount;
    const pointIndex = Math.min(
      ranked.length - 1,
      Math.floor(probability * ranked.length),
    );
    means.push(ranked[pointIndex].point.slice());
  }

  return means;
}

export function calculateGMMLogLikelihood(points, components) {
  let logLikelihood = 0;

  for (const point of points) {
    const logWeights = components.map(component =>
      Math.log(Math.max(component.weight, 1e-300)) +
      logGaussian2D(point, component),
    );
    const pointLogLikelihood = logSumExp(logWeights);
    if (!Number.isFinite(pointLogLikelihood)) return -Infinity;
    logLikelihood += pointLogLikelihood;
  }

  return logLikelihood;
}

/** Fit a deterministic full-covariance 2D Gaussian mixture by EM. */
export function fitGMM2D(
  points,
  {
    componentCount = 2,
    maxIterations = 100,
    tolerance = 1e-6,
    regularizationFraction = 1e-6,
    minimumComponentFraction = 1e-4,
  } = {},
) {
  if (!Number.isInteger(componentCount) || componentCount < 1) {
    throw new Error("componentCount must be a positive integer.");
  }
  if (!points || points.length < componentCount * 2) {
    throw new Error("Too few points to fit the requested GMM.");
  }

  const eventCount = points.length;
  const initialMeans = deterministicInitialMeans(points, componentCount);
  const globalCovariance = regularizeCovariance(
    calculateGlobalCovariance(points),
    regularizationFraction,
  );
  let components = initialMeans.map(mean => ({
    weight: 1 / componentCount,
    mean: mean.slice(),
    covariance: [globalCovariance[0].slice(), globalCovariance[1].slice()],
  }));
  const responsibilities = Array.from(
    { length: eventCount },
    () => new Float64Array(componentCount),
  );

  let previousLogLikelihood = -Infinity;
  let converged = false;
  let iterationsCompleted = 0;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    iterationsCompleted = iteration + 1;
    let logLikelihood = 0;

    // Expectation step.
    for (let eventIndex = 0; eventIndex < eventCount; eventIndex++) {
      const logWeights = components.map(component =>
        Math.log(Math.max(component.weight, 1e-300)) +
        logGaussian2D(points[eventIndex], component),
      );
      const normalization = logSumExp(logWeights);

      if (!Number.isFinite(normalization)) {
        // Regularization normally prevents this, but an equal fallback keeps a
        // pathological input deterministic and avoids propagating NaNs.
        for (let k = 0; k < componentCount; k++) {
          responsibilities[eventIndex][k] = 1 / componentCount;
        }
        logLikelihood = -Infinity;
      } else {
        if (Number.isFinite(logLikelihood)) logLikelihood += normalization;
        for (let k = 0; k < componentCount; k++) {
          responsibilities[eventIndex][k] = Math.exp(
            logWeights[k] - normalization,
          );
        }
      }
    }

    if (
      iteration > 0 &&
      Number.isFinite(logLikelihood) &&
      Number.isFinite(previousLogLikelihood) &&
      Math.abs(logLikelihood - previousLogLikelihood) <=
        tolerance * (1 + Math.abs(previousLogLikelihood))
    ) {
      converged = true;
      break;
    }
    previousLogLikelihood = logLikelihood;

    // Maximization step.
    const updatedComponents = [];

    for (let componentIndex = 0; componentIndex < componentCount; componentIndex++) {
      let effectiveCount = 0;
      for (let eventIndex = 0; eventIndex < eventCount; eventIndex++) {
        effectiveCount += responsibilities[eventIndex][componentIndex];
      }

      const minimumEffectiveCount = minimumComponentFraction * eventCount;
      if (!Number.isFinite(effectiveCount) || effectiveCount < minimumEffectiveCount) {
        updatedComponents.push({
          weight: minimumComponentFraction,
          mean: initialMeans[componentIndex].slice(),
          covariance: [
            globalCovariance[0].slice(),
            globalCovariance[1].slice(),
          ],
        });
        continue;
      }

      let meanX = 0;
      let meanY = 0;
      for (let eventIndex = 0; eventIndex < eventCount; eventIndex++) {
        const responsibility = responsibilities[eventIndex][componentIndex];
        meanX += responsibility * points[eventIndex][0];
        meanY += responsibility * points[eventIndex][1];
      }
      meanX /= effectiveCount;
      meanY /= effectiveCount;

      let varianceX = 0;
      let varianceY = 0;
      let covarianceXY = 0;
      for (let eventIndex = 0; eventIndex < eventCount; eventIndex++) {
        const responsibility = responsibilities[eventIndex][componentIndex];
        const dx = points[eventIndex][0] - meanX;
        const dy = points[eventIndex][1] - meanY;
        varianceX += responsibility * dx * dx;
        varianceY += responsibility * dy * dy;
        covarianceXY += responsibility * dx * dy;
      }

      const covariance = regularizeCovariance(
        [
          [varianceX / effectiveCount, covarianceXY / effectiveCount],
          [covarianceXY / effectiveCount, varianceY / effectiveCount],
        ],
        regularizationFraction,
      );
      updatedComponents.push({
        weight: effectiveCount / eventCount,
        mean: [meanX, meanY],
        covariance,
      });
    }

    const totalWeight = updatedComponents.reduce(
      (sum, component) => sum + component.weight,
      0,
    );
    for (const component of updatedComponents) component.weight /= totalWeight;
    components = updatedComponents;
  }

  return {
    components,
    converged,
    iterations: iterationsCompleted,
    logLikelihood: calculateGMMLogLikelihood(points, components),
  };
}

/** Select the substantial mixture component with greater FSC-A (SSC tiebreak). */
export function chooseMainBiologicalComponent(
  components,
  { minimumWeight = 0.1 } = {},
) {
  if (!components || components.length === 0) {
    throw new Error("At least one GMM component is required.");
  }

  const indexedComponents = components.map((component, componentIndex) => ({
    component,
    componentIndex,
  }));
  const substantialComponents = indexedComponents.filter(
    item => item.component.weight >= minimumWeight,
  );
  const candidates = substantialComponents.length > 0
    ? substantialComponents
    : indexedComponents;

  return candidates.reduce((best, current) => {
    const bestFSC = best.component.mean[0];
    const currentFSC = current.component.mean[0];
    if (currentFSC > bestFSC) return current;
    if (
      currentFSC === bestFSC &&
      current.component.mean[1] > best.component.mean[1]
    ) {
      return current;
    }
    return best;
  });
}

/** Create a raw-index ellipse mask and a parallel diagnostic distance array. */
export function createScatterGateMask(
  eventCount,
  scatterPoints,
  mainComponent,
  threshold = DEFAULT_SCATTER_THRESHOLD,
) {
  const mask = new Uint8Array(eventCount);
  const mahalanobisDistanceSquared = new Float64Array(eventCount);
  mahalanobisDistanceSquared.fill(NaN);

  for (const { eventIndex, point } of scatterPoints) {
    const distanceSquared = mahalanobisSquared(point, mainComponent);
    mahalanobisDistanceSquared[eventIndex] = distanceSquared;

    if (Number.isFinite(distanceSquared) && distanceSquared <= threshold) {
      mask[eventIndex] = 1;
    }
  }

  return { mask, mahalanobisDistanceSquared };
}

/** Complete optional Stage 2 biological-cloud gate. */
export function gateMainBiologicalCloud(
  dataset,
  structuralMask = null,
  timeQCMask = null,
  {
    threshold = DEFAULT_SCATTER_THRESHOLD,
    minimumMainComponentWeight = 0.1,
    gmmOptions = {},
  } = {},
) {
  const fsc = dataset?.channels?.FSC_A;
  const ssc = dataset?.channels?.SSC_A;

  if (!fsc || !ssc) {
    return {
      skipped: true,
      status: "scatter gate skipped",
      reason: "FSC_A/SSC_A unavailable",
      scatterMask: null,
      mask: null,
      mahalanobisDistanceSquared: null,
      scatterPoints: [],
      components: [],
      mainComponent: null,
      mainComponentIndex: null,
      threshold,
      converged: false,
      iterations: 0,
      logLikelihood: NaN,
    };
  }

  const scatterPoints = buildScatterPoints(dataset, structuralMask, timeQCMask);
  const points = scatterPoints.map(item => item.point);
  const gmmResult = fitGMM2D(points, { ...gmmOptions, componentCount: 2 });
  const selected = chooseMainBiologicalComponent(gmmResult.components, {
    minimumWeight: minimumMainComponentWeight,
  });
  const mainComponent = selected.component;
  const { mask, mahalanobisDistanceSquared } = createScatterGateMask(
    dataset.eventCount ?? fsc.length,
    scatterPoints,
    mainComponent,
    threshold,
  );

  let retainedEventCount = 0;
  for (const retained of mask) retainedEventCount += retained;

  return {
    skipped: false,
    status: "scatter gate fitted",
    reason: null,
    scatterMask: mask,
    mask,
    mahalanobisDistanceSquared,
    scatterPoints,
    components: gmmResult.components,
    mainComponent,
    mainComponentIndex: selected.componentIndex,
    threshold,
    converged: gmmResult.converged,
    iterations: gmmResult.iterations,
    logLikelihood: gmmResult.logLikelihood,
    fittedEventCount: scatterPoints.length,
    retainedEventCount,
  };
}

export const stage2ScatterGate = gateMainBiologicalCloud;
