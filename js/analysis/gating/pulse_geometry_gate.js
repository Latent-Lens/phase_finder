// Optional pulse-geometry singlet gate -- the fourth QC filter. Fits a robust
// PCA ridge to a DNA area-vs-secondary (Height/Width) scatter and rejects
// events too far off it (doublets/aggregates). fitRobustRidge2D() fits the
// ridge; selectPulseGeometry() picks the secondary channel; buildPulseGeometryPoints()
// gathers finite points; createSingletMaskFromRidge() turns ridge distances
// into a mask; gateByPulseGeometry() runs the whole gate; copyInputMask() and
// combineMasks() are mask helpers.

import { mad, median, variance } from "../math/stats.js";
import {
  calculateWeightedCenter,
  calculateWeightedCovariance,
  principalDirection2D,
  signedOrthogonalDistance,
  eigenDecomposition2D,
} from "../math/linalg2d.js";

export {
  calculateWeightedCenter,
  calculateWeightedCovariance,
  mad,
  median,
  principalDirection2D,
  signedOrthogonalDistance,
};

// QC-06 event budget. The ridge (center + orientation) needs far fewer events
// than the scatter GMM, but a fit over very few points is still unreliable.
// DEFAULT_MINIMUM_POINTS is the hard floor to attempt a fit at all (below it the
// gate is a clean optional skip); RELIABLE_PULSE_GEOMETRY_EVENTS is the point
// below which the fit runs but is flagged underpowered and NOT silently applied.
export const DEFAULT_MINIMUM_POINTS = 20;
export const RELIABLE_PULSE_GEOMETRY_EVENTS = 50;

// QC-06: ridge identifiability. Below this ratio of the along-ridge to
// off-ridge spread the points form a blob with no meaningful ridge; the fit is
// poorly identified and must be reviewed rather than applied.
export const MINIMUM_RIDGE_IDENTIFICATION_RATIO = 4;

// QC-06: the ridge must retain a plausible fraction of the fitted events. A ridge
// that keeps almost nothing is degenerate/misplaced and must not be applied.
export const MINIMUM_PLAUSIBLE_SINGLET_COVERAGE = 0.05;

// QC-06: minor-axis (off-ridge) variance floor in robust-z-score coordinates.
// Below this the two channels are effectively collinear (e.g. a derived or
// duplicated channel) -- the ridge has no meaningful width, so it cannot
// separate singlets from doublets and must be reviewed, not applied. The value
// sits well above the solver's covariance regularization (1e-9) and well below
// the off-ridge spread of a genuine, jittered singlet ridge.
export const MINIMUM_RIDGE_OFF_AXIS_EIGENVALUE = 1e-6;

/*

Purpose:
	Fits a robust 2-D ridge line to a set of points by iteratively reweighted PCA
	with Huber weights, so a minority of off-ridge doublets/aggregates doesn't
	drag the fit.

Input:
	points [array]: array of [x, y] points (at least 3)
	options [object]: { maxIterations, convergenceTolerance, huberConstant,
	                  covarianceRegularization }

Output:
	ridge [object]: the fitted ridge (center, direction, spread) (throws for
	                fewer than 3 or non-finite points)

*/
export function fitRobustRidge2D(
  points,
  {
    maxIterations = 50,
    convergenceTolerance = 1e-7,
    huberConstant = 1.345,
    covarianceRegularization = 1e-9,
  } = {},
) {
  if (!points || points.length < 3) {
    throw new Error("At least three points are required to fit a ridge.");
  }
  if (points.some(point =>
    !Number.isFinite(point?.[0]) || !Number.isFinite(point?.[1]),
  )) {
    throw new Error("Ridge points must contain finite x/y values.");
  }

  let center = [
    median(points.map(point => point[0])),
    median(points.map(point => point[1])),
  ];
  const weights = new Float64Array(points.length);
  weights.fill(1);

  let covariance = calculateWeightedCovariance(
    points,
    weights,
    center,
    covarianceRegularization,
  );
  let direction = principalDirection2D(covariance);
  let converged = false;
  let iterationsCompleted = 0;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    iterationsCompleted = iteration + 1;
    const distances = points.map(point =>
      signedOrthogonalDistance(point, center, direction),
    );
    const distanceMedian = median(distances);
    const distanceMAD = mad(distances, distanceMedian);
    const robustScale = 1.4826 * distanceMAD;

    if (!Number.isFinite(robustScale) || robustScale <= Number.EPSILON) {
      converged = true;
      break;
    }

    for (let pointIndex = 0; pointIndex < distances.length; pointIndex++) {
      const standardizedDistance =
        Math.abs(distances[pointIndex] - distanceMedian) / robustScale;
      weights[pointIndex] = standardizedDistance <= huberConstant
        ? 1
        : huberConstant / standardizedDistance;
    }

    const newCenter = calculateWeightedCenter(points, weights);
    const newCovariance = calculateWeightedCovariance(
      points,
      weights,
      newCenter,
      covarianceRegularization,
    );
    const newDirection = principalDirection2D(newCovariance);

    // A direction and its negative describe the same ridge.
    const directionDotProduct =
      direction[0] * newDirection[0] + direction[1] * newDirection[1];
    if (directionDotProduct < 0) {
      newDirection[0] *= -1;
      newDirection[1] *= -1;
    }

    const centerMovement = Math.hypot(
      newCenter[0] - center[0],
      newCenter[1] - center[1],
    );
    const directionMovement = Math.hypot(
      newDirection[0] - direction[0],
      newDirection[1] - direction[1],
    );

    center = newCenter;
    covariance = newCovariance;
    direction = newDirection;

    if (
      centerMovement <= convergenceTolerance &&
      directionMovement <= convergenceTolerance
    ) {
      converged = true;
      break;
    }
  }

  const distances = points.map(point =>
    signedOrthogonalDistance(point, center, direction),
  );
  const distanceMedian = median(distances);
  const distanceMAD = mad(distances, distanceMedian);

  return {
    center,
    direction,
    covariance,
    distances,
    distanceMedian,
    distanceMAD,
    weights,
    converged,
    iterations: iterationsCompleted,
  };
}

/*

Purpose:
	Copies an earlier event mask, or makes an all-pass mask when none exists.

Input:
	eventCount [number]: total event count
	inputMask [array|null]: an upstream mask, or null for all-pass

Output:
	mask [Uint8Array]: the copied/all-pass mask (throws on a length mismatch)

*/
export function copyInputMask(eventCount, inputMask = null) {
  if (inputMask && inputMask.length !== eventCount) {
    throw new Error("The pulse-geometry input mask length is invalid.");
  }

  const copiedMask = new Uint8Array(eventCount);
  for (let eventIndex = 0; eventIndex < eventCount; eventIndex++) {
    copiedMask[eventIndex] =
      !inputMask || inputMask[eventIndex] === 1 ? 1 : 0;
  }
  return copiedMask;
}

/*

Purpose:
	Chooses the pulse-geometry channel pair: prefers DNA-A vs DNA-H (Height),
	falls back to DNA-A vs DNA-W (Width), otherwise returns null.

Input:
	dataset [object]: row.data (reads channels.DNA_A/DNA_H/DNA_W, eventCount)

Output:
	geometry [object|null]: the chosen { areaChannel, secondaryChannel, mode }, or
	                        null when no usable pair exists (throws when DNA_A is
	                        missing/invalid)

*/
export function selectPulseGeometry(dataset) {
  const dnaA = dataset?.channels?.DNA_A;
  const dnaH = dataset?.channels?.DNA_H;
  const dnaW = dataset?.channels?.DNA_W;
  const eventCount = dataset?.eventCount ?? dnaA?.length ?? 0;

  if (!dnaA || dnaA.length !== eventCount) {
    throw new Error("DNA_A is missing or has an invalid length.");
  }

  const candidates = [
    { channel: dnaH, geometryMode: "DNA_A_vs_DNA_H", secondaryChannelName: "DNA_H", preference: 1 },
    { channel: dnaW, geometryMode: "DNA_A_vs_DNA_W", secondaryChannelName: "DNA_W", preference: 0 },
  ].filter(candidate => candidate.channel?.length === eventCount)
    .map(candidate => {
      const pairs = [];
      for (let index = 0; index < eventCount; index++) {
        if (Number.isFinite(dnaA[index]) && Number.isFinite(candidate.channel[index])) {
          pairs.push([dnaA[index], candidate.channel[index]]);
        }
      }
      const x = pairs.map(point => point[0]);
      const y = pairs.map(point => point[1]);
      const transform = fitPulseGeometryTransform(pairs);
      const standardized = pairs.map(point => standardizePulseGeometryPoint(point, transform));
      const covariance = standardized.length >= 3
        ? calculateWeightedCovariance(standardized, new Float64Array(standardized.length).fill(1), [0, 0])
        : [[0, 0], [0, 0]];
      const correlation = covariance[0][0] > 0 && covariance[1][1] > 0
        ? covariance[0][1] / Math.sqrt(covariance[0][0] * covariance[1][1])
        : 0;
      return {
        ...candidate,
        finiteCount: pairs.length,
        finiteFraction: eventCount ? pairs.length / eventCount : 0,
        positiveFraction: pairs.length
          ? pairs.filter(point => point[0] > 0 && point[1] > 0).length / pairs.length
          : 0,
        correlation,
        usableSpread: Math.sqrt(variance(x)) > 0 && Math.sqrt(variance(y)) > 0,
      };
    });
  if (!candidates.length) return null;
  const selected = candidates.reduce((best, current) => {
    const currentScore = current.finiteFraction + 0.25 * Math.abs(current.correlation)
      + 0.05 * current.positiveFraction + 1e-6 * current.preference;
    const bestScore = best.finiteFraction + 0.25 * Math.abs(best.correlation)
      + 0.05 * best.positiveFraction + 1e-6 * best.preference;
    return currentScore > bestScore ? current : best;
  });
  return {
    areaChannel: dnaA,
    secondaryChannel: selected.channel,
    geometryMode: selected.geometryMode,
    secondaryChannelName: selected.secondaryChannelName,
    selectionEvidence: candidates.map(({ channel, preference, ...evidence }) => evidence),
  };
}

export function fitPulseGeometryTransform(points) {
  if (!points?.length) return { method: "robust_zscore", center: [0, 0], scale: [1, 1] };
  const center = [0, 1].map(axis => median(points.map(point => point[axis])));
  const scale = [0, 1].map(axis => {
    const values = points.map(point => point[axis]);
    const robust = 1.4826 * mad(values, center[axis]);
    return Number.isFinite(robust) && robust > 0 ? robust : Math.sqrt(variance(values)) || 1;
  });
  return { method: "robust_zscore", center, scale };
}

export function standardizePulseGeometryPoint(point, transform) {
  return point.map((value, axis) =>
    (value - transform.center[axis]) / transform.scale[axis]);
}

/*

Purpose:
	Builds finite [area, secondary] geometry points from the retained events,
	preserving each point's raw event index for mapping the mask back.

Input:
	areaChannel [array]: the DNA area channel
	secondaryChannel [array]: the DNA height/width channel
	inputMask [array|null]: an upstream mask, or null

Output:
	points [array]: [{ eventIndex, point: [area, secondary] }, ...] (throws on a
	                length mismatch)

*/
export function buildPulseGeometryPoints(
  areaChannel,
  secondaryChannel,
  inputMask = null,
) {
  if (!areaChannel || !secondaryChannel || areaChannel.length !== secondaryChannel.length) {
    throw new Error("Pulse-geometry channel lengths do not match.");
  }
  if (inputMask && inputMask.length !== areaChannel.length) {
    throw new Error("The pulse-geometry input mask length is invalid.");
  }

  const indexedPoints = [];
  for (let eventIndex = 0; eventIndex < areaChannel.length; eventIndex++) {
    if (inputMask && inputMask[eventIndex] === 0) continue;

    const area = areaChannel[eventIndex];
    const secondary = secondaryChannel[eventIndex];
    if (!Number.isFinite(area) || !Number.isFinite(secondary)) continue;

    indexedPoints.push({ eventIndex, point: [area, secondary] });
  }

  return indexedPoints;
}

/*

Purpose:
	Converts each point's signed distance from the ridge into an
	original-event-index mask, keeping points within k MADs of the ridge.

Input:
	eventCount [number]: total event count
	indexedPoints [array]: points from buildPulseGeometryPoints
	ridge [object]: the fitted ridge from fitRobustRidge2D
	kMAD [number]: the MAD multiplier defining the keep band

Output:
	mask [Uint8Array]: 1 = singlet (kept), 0 = off-ridge

*/
export function createSingletMaskFromRidge(
  eventCount,
  indexedPoints,
  ridge,
  kMAD,
) {
  if (!(kMAD >= 0) || !Number.isFinite(kMAD)) {
    throw new Error("kMAD must be a finite non-negative number.");
  }
  if (ridge.distances.length !== indexedPoints.length) {
    throw new Error("Ridge distance count does not match the geometry points.");
  }

  const singletMask = new Uint8Array(eventCount);
  const orthogonalDistance = new Float64Array(eventCount);
  const distanceDeviation = new Float64Array(eventCount);
  orthogonalDistance.fill(NaN);
  distanceDeviation.fill(NaN);

  const threshold = kMAD * ridge.distanceMAD;
  let retainedSingletCount = 0;

  for (let pointIndex = 0; pointIndex < indexedPoints.length; pointIndex++) {
    const eventIndex = indexedPoints[pointIndex].eventIndex;
    const distance = ridge.distances[pointIndex];
    const deviation = Math.abs(distance - ridge.distanceMedian);
    orthogonalDistance[eventIndex] = distance;
    distanceDeviation[eventIndex] = deviation;

    const retained = ridge.distanceMAD === 0
      ? deviation === 0
      : deviation <= threshold;

    if (Number.isFinite(deviation) && retained) {
      singletMask[eventIndex] = 1;
      retainedSingletCount++;
    }
  }

  return {
    singletMask,
    mask: singletMask,
    orthogonalDistance,
    distanceDeviation,
    threshold,
    retainedSingletCount,
  };
}

function countRetained(mask) {
  let count = 0;
  for (const value of mask) count += value;
  return count;
}

/*

Purpose:
	Runs the complete optional pulse-geometry singlet gate: pick the channel pair,
	gather points, fit the ridge, and build the singlet mask -- skipping (all-pass)
	when there are too few usable points.

Input:
	dataset [object]: row.data
	inputMask [array|null]: the upstream mask, or null
	options [object]: { kMAD, minimumPoints, ridgeOptions }

Output:
	result [object]: { mask, singletMask, retained/rejected counts, geometryMode,
	                 skipped, ... }

*/
export function gateByPulseGeometry(
  dataset,
  inputMask = null,
  {
    kMAD = 5,
    minimumPoints = DEFAULT_MINIMUM_POINTS,
    ridgeOptions = {},
  } = {},
) {
  const eventCount =
    dataset?.eventCount ?? dataset?.channels?.DNA_A?.length ?? 0;
  const geometry = selectPulseGeometry(dataset);

  if (!geometry) {
    const singletMask = copyInputMask(eventCount, inputMask);
    return {
      singletMask,
      mask: singletMask,
      skipped: true,
      status: "no pulse geometry",
      geometryMode: null,
      secondaryChannelName: null,
      ridge: null,
      fittedEventCount: 0,
      retainedSingletCount: countRetained(singletMask),
      optionalAggregateTermRecommended: true,
      reason: "Neither DNA_H nor DNA_W was available.",
    };
  }

  const indexedPoints = buildPulseGeometryPoints(
    geometry.areaChannel,
    geometry.secondaryChannel,
    inputMask,
  );

  if (indexedPoints.length < minimumPoints) {
    const singletMask = copyInputMask(eventCount, inputMask);
    return {
      singletMask,
      mask: singletMask,
      skipped: true,
      status: "insufficient pulse-geometry events",
      geometryMode: geometry.geometryMode,
      secondaryChannelName: geometry.secondaryChannelName,
      ridge: null,
      fittedEventCount: indexedPoints.length,
      retainedSingletCount: countRetained(singletMask),
      optionalAggregateTermRecommended: true,
      reason: `Only ${indexedPoints.length} usable events were available.`,
    };
  }

  const points = indexedPoints.map(item => item.point);
  const pulseGeometryTransform = fitPulseGeometryTransform(points);
  const standardizedPoints = points.map(point =>
    standardizePulseGeometryPoint(point, pulseGeometryTransform));
  // SCI-09B/QC-06: the ridge is fit in robust-z-score coordinates, so the
  // solver's absolute convergence tolerance and Huber scale operate on a
  // scale-stable representation -- an instrument gain change on either channel
  // leaves the fit (and the resulting mask) unchanged.
  const ridge = fitRobustRidge2D(standardizedPoints, ridgeOptions);
  const ridgeEigenvalues = eigenDecomposition2D(ridge.covariance).values;
  const ridgeIdentificationRatio = ridgeEigenvalues[1] > 0
    ? ridgeEigenvalues[0] / ridgeEigenvalues[1]
    : Infinity;
  const reviewReasons = [];
  if (!ridge.converged) reviewReasons.push("robust ridge did not converge");
  if (!Number.isFinite(ridgeIdentificationRatio)
      || ridgeIdentificationRatio < MINIMUM_RIDGE_IDENTIFICATION_RATIO) {
    reviewReasons.push("pulse-geometry ridge is poorly identified");
  }
  // QC-06: an underpowered fit (enough to attempt, too few to trust) is flagged
  // for review rather than silently applied.
  if (indexedPoints.length < RELIABLE_PULSE_GEOMETRY_EVENTS) {
    reviewReasons.push(`pulse-geometry fit is underpowered (${indexedPoints.length} < ${RELIABLE_PULSE_GEOMETRY_EVENTS} events)`);
  }
  // QC-06: a collapsed off-ridge axis (near-perfect collinearity) leaves the
  // ridge with no meaningful width -- it cannot separate singlets from doublets,
  // so it must never be applied as a gate. Measured on the minor eigenvalue in
  // scale-stable coordinates so it is robust to floating-point residuals and to
  // instrument gain, and distinct from the poorly-identified (blob) case above.
  if (!Number.isFinite(ridgeEigenvalues[1])
      || ridgeEigenvalues[1] <= MINIMUM_RIDGE_OFF_AXIS_EIGENVALUE) {
    reviewReasons.push("pulse-geometry ridge scale is degenerate (near-collinear)");
  }
  const gateResult = createSingletMaskFromRidge(
    eventCount,
    indexedPoints,
    ridge,
    kMAD,
  );

  // QC-06: a ridge that keeps an implausibly small fraction of events is
  // degenerate/misplaced -- require review before it can be applied.
  const coverageFraction = indexedPoints.length
    ? gateResult.retainedSingletCount / indexedPoints.length
    : 0;
  if (coverageFraction < MINIMUM_PLAUSIBLE_SINGLET_COVERAGE) {
    reviewReasons.push("the fitted ridge retains an implausibly small fraction of events");
  }

  return {
    singletMask: gateResult.singletMask,
    mask: gateResult.singletMask,
    orthogonalDistance: gateResult.orthogonalDistance,
    distanceDeviation: gateResult.distanceDeviation,
    skipped: false,
    status: reviewReasons.length ? "singlet ridge review required" : "singlet ridge fitted",
    reason: reviewReasons.length ? reviewReasons.join("; ") : null,
    geometryMode: geometry.geometryMode,
    secondaryChannelName: geometry.secondaryChannelName,
    channelSelectionEvidence: geometry.selectionEvidence,
    pulseGeometryTransform,
    ridge,
    ridgeCenter: ridge.center,
    ridgeDirection: ridge.direction,
    ridgeCovariance: ridge.covariance,
    distanceMedian: ridge.distanceMedian,
    distanceMAD: ridge.distanceMAD,
    kMAD,
    threshold: gateResult.threshold,
    fittedEventCount: indexedPoints.length,
    retainedSingletCount: gateResult.retainedSingletCount,
    coverageFraction,
    converged: ridge.converged,
    iterations: ridge.iterations,
    ridgeIdentificationRatio,
    reviewRequired: reviewReasons.length > 0,
    // QC-06: any review reason marks the fit as limited-reliability so the model-
    // boundary contract (qc_outcome) maps it to a degraded stage outcome. The
    // pipeline withholds the mask on reviewRequired, so an invalid/degenerate
    // ridge is never silently applied.
    limitedReliability: reviewReasons.length > 0,
    reviewReasons,
    optionalAggregateTermRecommended: false,
  };
}

/*

Purpose:
	Combines several event masks with logical AND; null optional masks are
	ignored (kept for source compatibility with the reference implementation).

Input:
	masks [array]: any number of masks (or nulls)

Output:
	mask [Uint8Array|null]: the AND of the non-null masks, or null when none

*/
export function combineMasks(...masks) {
  const validMasks = masks.filter(Boolean);
  if (validMasks.length === 0) {
    throw new Error("At least one mask is required.");
  }

  const eventCount = validMasks[0].length;
  const combinedMask = new Uint8Array(eventCount);

  for (const mask of validMasks) {
    if (mask.length !== eventCount) {
      throw new Error("Mask lengths do not match.");
    }
  }

  for (let eventIndex = 0; eventIndex < eventCount; eventIndex++) {
    let retained = true;
    for (const mask of validMasks) {
      if (mask[eventIndex] === 0) {
        retained = false;
        break;
      }
    }
    combinedMask[eventIndex] = retained ? 1 : 0;
  }

  return combinedMask;
}
