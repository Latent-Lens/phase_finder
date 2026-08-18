// Optional FSC/SSC biological-cloud gate using a Gaussian mixture model -- the
// Cell Gate, the third QC filter. Fits a deterministic 2-component
// full-covariance GMM to the FSC-A x SSC-A scatter, picks the main biological
// cloud, and keeps events within a Mahalanobis ellipse of it (rejecting
// debris/off-cloud events). buildScatterPoints() gathers finite points;
// deterministicInitialMeans() and calculateGMMLogLikelihood() support fitGMM2D()'s
// EM fit; chooseMainBiologicalComponent() selects the cell cloud;
// createScatterGateMask() turns Mahalanobis distances into a mask;
// gateMainBiologicalCloud() runs the whole gate; skippedScatterResult() is the
// shared skip-shape helper. The fit is deterministic (robust-quantile
// initialization, no RNG) so a sample always gates the same way.

import { mad, median, variance } from "../math/stats.js";
import { logGaussian2D, logSumExp } from "../math/gaussian.js";
import {
  calculateGlobalCovariance,
  eigenDecomposition2D,
  mahalanobisSquared,
  regularizeCovariance,
} from "../math/linalg2d.js";

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

// QC-05 validated scope. This gate fits exactly a 2-component full-covariance GMM
// -- the main biological cloud vs. debris/off-cloud events. Two components is the
// scope this gate is validated for; higher component counts (e.g. resolving
// aggregates as a third population) are deliberately out of scope and not fit
// here. A 2-component full-covariance 2-D GMM estimates 11 free parameters, so
// the event budget below governs whether a fit is trustworthy.

// Hard floor to attempt a fit at all: fewer finite FSC-A/SSC-A events than this
// is a clean optional skip (the sample keeps its upstream mask).
export const MINIMUM_SCATTER_EVENTS = 10;

// QC-05: below this the fit runs but is underpowered -- flagged for review and
// NOT silently applied. Each selected biological component must additionally
// command at least MINIMUM_COMPONENT_EVENTS effective events.
export const RELIABLE_SCATTER_EVENTS = 100;
export const MINIMUM_COMPONENT_EVENTS = 25;

// QC-05: condition number above which a component covariance is treated as
// near-singular -- its narrow axis is at/near the regularization floor rather
// than data-driven, so the ellipse geometry is not trustworthy.
export const MAXIMUM_COMPONENT_CONDITION = 1e4;

// QC-05: the selected ellipse must retain a plausible fraction of the fitted
// events. An ellipse that keeps almost nothing is not a meaningful biological
// selection and must not be applied without review.
export const MINIMUM_PLAUSIBLE_COVERAGE = 0.01;

// FSC-A and SSC-A are fitted after independent robust z-standardization. This
// keeps instrument gain/range from determining the GMM geometry. Components
// are converted back to acquisition units before masks or UI are produced.
export function fitScatterTransform(points) {
  const center = [0, 1].map(axis => median(points.map(point => point[axis])));
  const scale = [0, 1].map(axis => {
    const values = points.map(point => point[axis]);
    const robust = 1.4826 * mad(values, center[axis]);
    return Number.isFinite(robust) && robust > 0
      ? robust
      : Math.sqrt(variance(values)) || 1;
  });
  return { method: "robust_zscore", center, scale };
}

export function standardizeScatterPoint(point, transform) {
  return point.map((value, axis) =>
    (value - transform.center[axis]) / transform.scale[axis]);
}

export function unstandardizeScatterComponent(component, transform) {
  const [sx, sy] = transform.scale;
  return {
    ...component,
    mean: component.mean.map((value, axis) =>
      transform.center[axis] + value * transform.scale[axis]),
    covariance: [
      [component.covariance[0][0] * sx * sx, component.covariance[0][1] * sx * sy],
      [component.covariance[1][0] * sx * sy, component.covariance[1][1] * sy * sy],
    ],
  };
}

function componentQuality(component) {
  const eigenvalues = eigenDecomposition2D(component.covariance).values;
  const largest = Math.max(...eigenvalues);
  const smallest = Math.min(...eigenvalues);
  const determinant = Math.max(0,
    component.covariance[0][0] * component.covariance[1][1]
      - component.covariance[0][1] * component.covariance[1][0]);
  return {
    weight: component.weight,
    covarianceCondition: smallest > 0 ? largest / smallest : Infinity,
    compactness: Math.sqrt(determinant),
  };
}

function componentSeparation(first, second) {
  const pooled = {
    mean: first.mean,
    covariance: [
      [(first.covariance[0][0] + second.covariance[0][0]) / 2,
       (first.covariance[0][1] + second.covariance[0][1]) / 2],
      [(first.covariance[1][0] + second.covariance[1][0]) / 2,
       (first.covariance[1][1] + second.covariance[1][1]) / 2],
    ],
  };
  return Math.sqrt(Math.max(0, mahalanobisSquared(second.mean, pooled)));
}

export function scoreScatterComponents(components, { minimumWeight = 0.1 } = {}) {
  const separation = components.length === 2
    ? componentSeparation(components[0], components[1])
    : NaN;
  return components.map((component, componentIndex) => {
    const quality = componentQuality(component);
    return {
      componentIndex,
      ...quality,
      separation,
      eligible: quality.weight >= minimumWeight
        && Number.isFinite(quality.covarianceCondition)
        && quality.covarianceCondition <= 1e4,
      // Population weight is the primary evidence. Standardized FSC is only a
      // deterministic tie-breaker, preventing a small doublet cloud winning
      // merely because it lies furthest right.
      selectionScore: quality.weight + 1e-6 * component.mean[0],
    };
  });
}

/*

Purpose:
	Shared skipped-gate result so both skip paths (no scatter channels, too few
	events) return an identical shape.

Input:
	threshold [number]: the Mahalanobis threshold to echo back
	reason [string]: why the gate was skipped

Output:
	result [object]: the skipped Cell Gate result

*/
function skippedScatterResult(threshold, reason) {
  return {
    skipped: true,
    status: "scatter gate skipped",
    reason,
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

/*

Purpose:
	Builds finite [FSC-A, SSC-A] points from events surviving the upstream masks,
	preserving each point's original event index. Throws TOO_FEW_SCATTER_EVENTS
	(a normal gating outcome the caller catches) when too few remain.

Input:
	dataset [object]: row.data (reads channels.FSC_A/SSC_A, eventCount)
	structuralMask [array|null]: the structural mask, or null
	timeQCMask [array|null]: the Time QC mask, or null

Output:
	points [array]: [{ eventIndex, point: [fsc, ssc] }, ...]

*/
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
      throw new Error("The cell-gate input mask length does not match the event count.");
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

  if (scatterPoints.length < MINIMUM_SCATTER_EVENTS) {
    const error = new Error(
      `Too few valid FSC-A/SSC-A events remain for GMM fitting (${scatterPoints.length} < ${MINIMUM_SCATTER_EVENTS}).`,
    );
    error.code = "TOO_FEW_SCATTER_EVENTS";
    throw error;
  }

  return scatterPoints;
}

/*

Purpose:
	Deterministic initial component means from robust quantiles of a projected
	robust score (there is deliberately no RNG), so EM starts identically every
	run.

Input:
	points [array]: the [fsc, ssc] points
	componentCount [number]: how many components to seed

Output:
	means [array]: one [fsc, ssc] mean per component

*/
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

/*

Purpose:
	Total log-likelihood of the points under the current mixture (log-sum-exp over
	the weighted component densities).

Input:
	points [array]: the [fsc, ssc] points
	components [array]: the mixture components

Output:
	logLikelihood [number]: the total log-likelihood (-Infinity when any point is
	                        unrepresentable)

*/
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

/*

Purpose:
	Fits a deterministic full-covariance 2-D Gaussian mixture by EM: deterministic
	init, regularized covariances, and a floor on tiny components so a collapsing
	component is reset rather than allowed to diverge.

Input:
	points [array]: the [fsc, ssc] points
	options [object]: { componentCount, maxIterations, tolerance,
	                  regularizationFraction, minimumComponentFraction }

Output:
	result [object]: { components, converged, iterations, logLikelihood }

*/
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

/*

Purpose:
	Selects the main biological cloud: among components above a minimum weight
	(falling back to all components), the one with the greatest FSC-A, breaking
	ties on SSC-A.

Input:
	components [array]: the fitted mixture components
	options [object]: { minimumWeight }

Output:
	selected [object]: { component, componentIndex }

*/
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

/*

Purpose:
	Builds the original-event-index ellipse mask (Mahalanobis distance <= threshold
	from the main component) plus a parallel per-event squared-distance array for
	diagnostics/overlays.

Input:
	eventCount [number]: total event count
	scatterPoints [array]: points from buildScatterPoints
	mainComponent [object]: the selected main component
	threshold [number]: the squared-Mahalanobis keep threshold

Output:
	result [object]: { mask, mahalanobisDistanceSquared }

*/
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

/*

Purpose:
	Runs the complete optional Cell Gate: gather points, fit the 2-component GMM,
	pick the main biological cloud, and build the ellipse mask -- skipping (with a
	reason) when the scatter channels are missing or too few events remain.

Input:
	dataset [object]: row.data
	structuralMask [array|null]: the structural mask, or null
	timeQCMask [array|null]: the Time QC mask, or null
	options [object]: { threshold, minimumMainComponentWeight, gmmOptions }

Output:
	result [object]: the Cell Gate result (mask/scatterMask, components,
	                 mainComponent, distances, converged, skipped, ...)

*/
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
    return skippedScatterResult(threshold, "FSC_A/SSC_A unavailable");
  }

  let scatterPoints;
  try {
    scatterPoints = buildScatterPoints(dataset, structuralMask, timeQCMask);
  } catch (error) {
    // Too few surviving events is a normal gating outcome, not a failure:
    // skip the gate so the sample continues with its upstream mask intact.
    // Structural errors (length mismatches) still propagate.
    if (error.code === "TOO_FEW_SCATTER_EVENTS") {
      return skippedScatterResult(threshold, error.message);
    }
    throw error;
  }
  const points = scatterPoints.map(item => item.point);
  const scatterTransform = fitScatterTransform(points);
  const standardizedPoints = points.map(point =>
    standardizeScatterPoint(point, scatterTransform));
  const gmmResult = fitGMM2D(standardizedPoints, { ...gmmOptions, componentCount: 2 });
  const componentMetrics = scoreScatterComponents(gmmResult.components, {
    minimumWeight: minimumMainComponentWeight,
  });
  const eligible = componentMetrics.filter(metric => metric.eligible);
  const candidates = eligible.length ? eligible : componentMetrics;
  const selectedMetric = candidates.reduce((best, current) =>
    current.selectionScore > best.selectionScore ? current : best);
  const selected = {
    componentIndex: selectedMetric.componentIndex,
    component: gmmResult.components[selectedMetric.componentIndex],
  };
  const components = gmmResult.components.map(component =>
    unstandardizeScatterComponent(component, scatterTransform));
  const mainComponent = components[selected.componentIndex];
  const sortedScores = candidates.map(metric => metric.selectionScore).sort((a, b) => b - a);
  const scoreMargin = sortedScores.length > 1 ? sortedScores[0] - sortedScores[1] : Infinity;
  const fittedEventCount = scatterPoints.length;
  const mainComponentEffectiveCount = selectedMetric.weight * fittedEventCount;
  const reviewReasons = [];
  if (!gmmResult.converged) reviewReasons.push("GMM did not converge");
  if (!eligible.length) reviewReasons.push("no component passed weight/covariance checks");
  // QC-05: an underpowered fit (too few events overall, or too few in the
  // selected biological component) is not trustworthy -- flag it rather than
  // apply whatever the EM landed on.
  if (fittedEventCount < RELIABLE_SCATTER_EVENTS) {
    reviewReasons.push(`scatter fit is underpowered (${fittedEventCount} < ${RELIABLE_SCATTER_EVENTS} events)`);
  }
  if (mainComponentEffectiveCount < MINIMUM_COMPONENT_EVENTS) {
    reviewReasons.push("the selected biological component has too few effective events");
  }
  // QC-05: a near-singular selected covariance means the ellipse's narrow axis is
  // dominated by the regularization floor, not the data -- its geometry cannot be
  // trusted to separate the biological cloud from debris.
  if (!Number.isFinite(selectedMetric.covarianceCondition)
      || selectedMetric.covarianceCondition >= MAXIMUM_COMPONENT_CONDITION) {
    reviewReasons.push("main component covariance is near-singular");
  }
  if (Number.isFinite(selectedMetric.separation) && selectedMetric.separation < 2) {
    reviewReasons.push("component separation is weak");
  }
  if (componentMetrics.some(metric =>
    metric.componentIndex !== selected.componentIndex && metric.weight >= 0.3)) {
    reviewReasons.push("an alternative population is too large for automatic biological assignment");
  }
  if (scoreMargin < 0.1) reviewReasons.push("component selection is ambiguous");
  const { mask, mahalanobisDistanceSquared } = createScatterGateMask(
    dataset.eventCount ?? fsc.length,
    scatterPoints,
    mainComponent,
    threshold,
  );

  let retainedEventCount = 0;
  for (const retained of mask) retainedEventCount += retained;

  // QC-05: an ellipse that keeps an implausibly small fraction of the fitted
  // events is not a meaningful biological selection -- require review.
  const coverageFraction = fittedEventCount ? retainedEventCount / fittedEventCount : 0;
  if (coverageFraction < MINIMUM_PLAUSIBLE_COVERAGE) {
    reviewReasons.push("the fitted ellipse retains an implausibly small fraction of events");
  }

  return {
    skipped: false,
    status: reviewReasons.length ? "scatter gate review required" : "scatter gate fitted",
    reason: null,
    scatterMask: mask,
    mask,
    mahalanobisDistanceSquared,
    scatterPoints,
    components,
    standardizedComponents: gmmResult.components,
    componentMetrics,
    scatterTransform,
    mainComponent,
    mainComponentIndex: selected.componentIndex,
    threshold,
    converged: gmmResult.converged,
    iterations: gmmResult.iterations,
    logLikelihood: gmmResult.logLikelihood,
    reviewRequired: reviewReasons.length > 0,
    // QC-05: any review reason marks the fit as limited-reliability so the model-
    // boundary contract (qc_outcome) maps it to a degraded stage outcome. The
    // pipeline withholds the mask on reviewRequired, so an invalid fit is never
    // silently applied.
    limitedReliability: reviewReasons.length > 0,
    reviewReasons,
    fittedEventCount,
    retainedEventCount,
    coverageFraction,
    mainComponentEffectiveCount,
  };
}
