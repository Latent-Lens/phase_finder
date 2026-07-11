// Stage 3: optional pulse-geometry singlet gate.

import { mad, median } from "./math/stats.js";
import {
  calculateWeightedCenter,
  calculateWeightedCovariance,
  principalDirection2D,
  signedOrthogonalDistance,
} from "./math/linalg2d.js";

export {
  calculateWeightedCenter,
  calculateWeightedCovariance,
  mad,
  median,
  principalDirection2D,
  signedOrthogonalDistance,
};

/** Iteratively reweighted PCA ridge using Huber weights. */
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

/** Copy an earlier mask, or make an all-pass mask when none exists. */
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

/** Prefer DNA-A/Height, fall back to DNA-A/Width, otherwise return null. */
export function selectPulseGeometry(dataset) {
  const dnaA = dataset?.channels?.DNA_A;
  const dnaH = dataset?.channels?.DNA_H;
  const dnaW = dataset?.channels?.DNA_W;
  const eventCount = dataset?.eventCount ?? dnaA?.length ?? 0;

  if (!dnaA || dnaA.length !== eventCount) {
    throw new Error("DNA_A is missing or has an invalid length.");
  }

  if (dnaH && dnaH.length === eventCount) {
    return {
      areaChannel: dnaA,
      secondaryChannel: dnaH,
      geometryMode: "DNA_A_vs_DNA_H",
      secondaryChannelName: "DNA_H",
    };
  }

  if (dnaW && dnaW.length === eventCount) {
    return {
      areaChannel: dnaA,
      secondaryChannel: dnaW,
      geometryMode: "DNA_A_vs_DNA_W",
      secondaryChannelName: "DNA_W",
    };
  }

  return null;
}

/** Build finite geometry points from retained events, preserving raw indexes. */
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

/** Convert ridge distances into an original-event-index k-MAD mask. */
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

/** Complete optional Stage 3 pulse-geometry gate. */
export function gateByPulseGeometry(
  dataset,
  inputMask = null,
  {
    kMAD = 5,
    minimumPoints = 20,
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
  const ridge = fitRobustRidge2D(points, ridgeOptions);
  const gateResult = createSingletMaskFromRidge(
    eventCount,
    indexedPoints,
    ridge,
    kMAD,
  );

  return {
    singletMask: gateResult.singletMask,
    mask: gateResult.singletMask,
    orthogonalDistance: gateResult.orthogonalDistance,
    distanceDeviation: gateResult.distanceDeviation,
    skipped: false,
    status: "singlet ridge fitted",
    reason: null,
    geometryMode: geometry.geometryMode,
    secondaryChannelName: geometry.secondaryChannelName,
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
    converged: ridge.converged,
    iterations: ridge.iterations,
    optionalAggregateTermRecommended: false,
  };
}

/** Source-compatible mask combiner; null optional masks are ignored. */
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

export const stage3SingletGate = gateByPulseGeometry;
