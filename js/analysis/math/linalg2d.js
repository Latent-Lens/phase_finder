// Shared two-dimensional linear algebra for scatter and pulse gates.

/** Population covariance of an array of [x, y] points. */
export function calculateGlobalCovariance(points) {
  if (!points || points.length === 0) {
    return [[0, 0], [0, 0]];
  }

  let meanX = 0;
  let meanY = 0;

  for (const [x, y] of points) {
    meanX += x;
    meanY += y;
  }

  meanX /= points.length;
  meanY /= points.length;

  let varianceX = 0;
  let varianceY = 0;
  let covarianceXY = 0;

  for (const [x, y] of points) {
    const dx = x - meanX;
    const dy = y - meanY;
    varianceX += dx * dx;
    varianceY += dy * dy;
    covarianceXY += dx * dy;
  }

  return [
    [varianceX / points.length, covarianceXY / points.length],
    [covarianceXY / points.length, varianceY / points.length],
  ];
}

/** Add a small scale-aware value to the covariance diagonal. */
export function regularizeCovariance(
  covariance,
  regularizationFraction = 1e-6,
) {
  const averageVariance = Math.max(
    1,
    (covariance[0][0] + covariance[1][1]) / 2,
  );
  const regularization = regularizationFraction * averageVariance;

  return [
    [covariance[0][0] + regularization, covariance[0][1]],
    [covariance[1][0], covariance[1][1] + regularization],
  ];
}

/** Invert a positive-definite 2 x 2 covariance matrix. */
export function invertCovariance2D(covariance) {
  if (!covariance || covariance.length !== 2) return null;

  const a = covariance[0]?.[0];
  const b = covariance[0]?.[1];
  const c = covariance[1]?.[0];
  const d = covariance[1]?.[1];
  const determinant = a * d - b * c;

  if (!Number.isFinite(determinant) || determinant <= 0) return null;

  return {
    determinant,
    inverse: [
      [d / determinant, -b / determinant],
      [-c / determinant, a / determinant],
    ],
  };
}

/** Unit vector along the major principal axis of a symmetric covariance. */
export function principalDirection2D(covariance) {
  const varianceX = covariance[0][0];
  const covarianceXY = 0.5 * (covariance[0][1] + covariance[1][0]);
  const varianceY = covariance[1][1];
  const angle = 0.5 * Math.atan2(
    2 * covarianceXY,
    varianceX - varianceY,
  );

  return [Math.cos(angle), Math.sin(angle)];
}

/**
 * Eigenvalues/eigenvectors of a symmetric 2 x 2 matrix, ordered major first.
 * Vectors are returned as matching unit-vector pairs in `vectors`.
 */
export function eigenDecomposition2D(covariance) {
  const a = covariance[0][0];
  const b = 0.5 * (covariance[0][1] + covariance[1][0]);
  const c = covariance[1][1];
  const midpoint = 0.5 * (a + c);
  const radius = Math.hypot(0.5 * (a - c), b);
  const majorValue = midpoint + radius;
  const minorValue = midpoint - radius;
  const majorVector = principalDirection2D([[a, b], [b, c]]);
  const minorVector = [-majorVector[1], majorVector[0]];

  return {
    values: [majorValue, minorValue],
    vectors: [majorVector, minorVector],
  };
}

/** Squared Mahalanobis distance from a GMM component or mean/covariance pair. */
export function mahalanobisSquared(
  point,
  componentOrMean,
  covariance = null,
) {
  const mean = covariance ? componentOrMean : componentOrMean?.mean;
  const matrix = covariance ?? componentOrMean?.covariance;
  const matrixInfo = invertCovariance2D(matrix);
  if (!matrixInfo || !mean) return Infinity;

  const dx = point[0] - mean[0];
  const dy = point[1] - mean[1];
  const inverse = matrixInfo.inverse;

  return (
    dx * (inverse[0][0] * dx + inverse[0][1] * dy) +
    dy * (inverse[1][0] * dx + inverse[1][1] * dy)
  );
}

/** Weighted center of [x, y] points. */
export function calculateWeightedCenter(points, weights) {
  if (!points || points.length !== weights?.length) {
    throw new Error("Points and weights must have the same length.");
  }

  let totalWeight = 0;
  let weightedX = 0;
  let weightedY = 0;

  for (let index = 0; index < points.length; index++) {
    const weight = weights[index];
    totalWeight += weight;
    weightedX += weight * points[index][0];
    weightedY += weight * points[index][1];
  }

  if (!(totalWeight > 0)) {
    throw new Error("Cannot calculate ridge center: total weight is zero.");
  }

  return [weightedX / totalWeight, weightedY / totalWeight];
}

/** Weighted population covariance with a small absolute regularizer. */
export function calculateWeightedCovariance(
  points,
  weights,
  center,
  regularization = 1e-9,
) {
  if (!points || points.length !== weights?.length) {
    throw new Error("Points and weights must have the same length.");
  }

  let totalWeight = 0;
  let varianceX = 0;
  let varianceY = 0;
  let covarianceXY = 0;

  for (let index = 0; index < points.length; index++) {
    const weight = weights[index];
    const dx = points[index][0] - center[0];
    const dy = points[index][1] - center[1];

    totalWeight += weight;
    varianceX += weight * dx * dx;
    varianceY += weight * dy * dy;
    covarianceXY += weight * dx * dy;
  }

  if (!(totalWeight > 0)) {
    throw new Error("Cannot calculate ridge covariance: total weight is zero.");
  }

  return [
    [varianceX / totalWeight + regularization, covarianceXY / totalWeight],
    [covarianceXY / totalWeight, varianceY / totalWeight + regularization],
  ];
}

/** Signed distance perpendicular to a ridge line. */
export function signedOrthogonalDistance(point, center, direction) {
  const normalX = -direction[1];
  const normalY = direction[0];

  return (
    (point[0] - center[0]) * normalX +
    (point[1] - center[1]) * normalY
  );
}
