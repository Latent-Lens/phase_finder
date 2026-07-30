// Shared two-dimensional linear algebra for the FSC/SSC cell gate and the
// DNA-A/H pulse-geometry singlet gate. Provides covariance construction
// (calculateGlobalCovariance, regularizeCovariance, and the weighted variants
// calculateWeightedCenter / calculateWeightedCovariance), matrix operations
// (invertCovariance2D, eigenDecomposition2D, principalDirection2D,
// rotateCovariance2D), and distance measures (mahalanobisSquared,
// signedOrthogonalDistance) used to fit and score those gates' ellipses/ridges.

/*

Purpose:
	Population covariance of an array of [x, y] points.

Input:
	points [array]: array of [x, y] pairs

Output:
	covariance [array]: the 2x2 covariance [[varX, covXY], [covXY, varY]]
	                    (all zeros for an empty input)

*/
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

/*

Purpose:
	Adds a small, scale-aware value to a covariance's diagonal so it stays
	positive-definite (invertible) even for a near-degenerate point cloud.

Input:
	covariance [array]: the 2x2 covariance to regularize
	regularizationFraction [number]: fraction of the average variance to add

Output:
	regularized [array]: a new 2x2 covariance with the diagonal nudged up

*/
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

/*

Purpose:
	Inverts a positive-definite 2x2 covariance matrix.

Input:
	covariance [array]: the 2x2 matrix to invert

Output:
	result [object|null]: { determinant, inverse } (inverse as a 2x2 array), or
	                      null when the matrix is malformed or not positive-definite

*/
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

/*

Purpose:
	Unit vector along the major principal axis of a symmetric covariance.

Input:
	covariance [array]: the 2x2 symmetric covariance

Output:
	direction [array]: the [cos, sin] unit vector of the major axis

*/
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

/*

Purpose:
	Eigenvalues and eigenvectors of a symmetric 2x2 matrix, ordered major axis
	first, with the eigenvectors returned as matching unit-vector pairs.

Input:
	covariance [array]: the 2x2 symmetric matrix

Output:
	result [object]: { values: [major, minor], vectors: [majorVec, minorVec] }

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

/*

Purpose:
	Rotates a symmetric 2x2 covariance's principal axes by an angle while
	preserving its eigenvalues -- lets the user manually reorient a fitted gate
	ellipse around its center without changing its shape (axis ratio) or size
	(coverage).

Input:
	covariance [array]: the 2x2 symmetric covariance
	angleRadians [number]: rotation angle, radians, counter-clockwise

Output:
	rotated [array]: the rotated 2x2 covariance

*/
export function rotateCovariance2D(covariance, angleRadians) {
  const { values, vectors } = eigenDecomposition2D(covariance);
  const [majorValue, minorValue] = values;
  const cos = Math.cos(angleRadians);
  const sin = Math.sin(angleRadians);
  const rotate = ([x, y]) => [x * cos - y * sin, x * sin + y * cos];
  const outer = ([x, y]) => [[x * x, x * y], [y * x, y * y]];
  const major = outer(rotate(vectors[0]));
  const minor = outer(rotate(vectors[1]));
  return [
    [majorValue * major[0][0] + minorValue * minor[0][0], majorValue * major[0][1] + minorValue * minor[0][1]],
    [majorValue * major[1][0] + minorValue * minor[1][0], majorValue * major[1][1] + minorValue * minor[1][1]],
  ];
}

/*

Purpose:
	Squared Mahalanobis distance of a point from a Gaussian, accepting either a
	GMM component ({ mean, covariance }) or an explicit mean + covariance pair.

Input:
	point [array]: the [x, y] observation
	componentOrMean [object|array]: a { mean, covariance } component, or the mean
	                                [x, y] when `covariance` is also given
	covariance [array|null]: the 2x2 covariance when the second arg is a mean

Output:
	distanceSquared [number]: the squared Mahalanobis distance, or Infinity when
	                          the covariance is singular or the mean is missing

*/
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

/*

Purpose:
	Weighted center (centroid) of [x, y] points.

Input:
	points [array]: array of [x, y] pairs
	weights [array]: per-point weights, same length as points

Output:
	center [array]: the weighted [x, y] center (throws when the lengths differ
	                or the total weight is zero)

*/
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

/*

Purpose:
	Weighted population covariance about a given center, with a small absolute
	regularizer added to the diagonal so the result stays invertible.

Input:
	points [array]: array of [x, y] pairs
	weights [array]: per-point weights, same length as points
	center [array]: the [x, y] center to deviate about
	regularization [number]: absolute value added to each diagonal term

Output:
	covariance [array]: the weighted 2x2 covariance (throws when the lengths
	                    differ or the total weight is zero)

*/
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

/*

Purpose:
	Signed distance of a point perpendicular to a ridge line -- positive on one
	side of the ridge, negative on the other -- as scored by the singlet gate.

Input:
	point [array]: the [x, y] observation
	center [array]: a point on the ridge line
	direction [array]: the ridge's unit direction vector

Output:
	distance [number]: the signed orthogonal distance from the ridge

*/
export function signedOrthogonalDistance(point, center, direction) {
  const normalX = -direction[1];
  const normalY = direction[0];

  return (
    (point[0] - center[0]) * normalX +
    (point[1] - center[1]) * normalY
  );
}
