// Nelder-Mead downhill-simplex minimizer -- a small, dependency-free,
// derivative-free optimizer for smooth-ish objectives where a gradient is
// awkward to supply. The CLOCCS MAP fit uses it on low-dimensional parameter
// blocks (see models/cloccs.js): its objective is a numerically-integrated
// log-posterior, so finite-difference gradients would be both noisy and
// expensive, and a robust simplex search on ≤7-dimensional blocks is a better
// fit than a quasi-Newton method here.
//
// Standard algorithm (Nelder & Mead 1965) with the usual coefficients:
//   reflection α = 1, expansion γ = 2, contraction ρ = 0.5, shrink σ = 0.5.
// Convergence is declared when both the spread of objective values across the
// simplex and the geometric size of the simplex fall below their tolerances.

const REFLECTION = 1;
const EXPANSION = 2;
const CONTRACTION = 0.5;
const SHRINK = 0.5;

function addScaled(base, direction, scale) {
  const result = new Array(base.length);
  for (let i = 0; i < base.length; i += 1) result[i] = base[i] + scale * direction[i];
  return result;
}

function centroidExcludingWorst(vertices) {
  const dimension = vertices[0].point.length;
  const centroid = new Array(dimension).fill(0);
  for (let v = 0; v < vertices.length - 1; v += 1) {
    for (let d = 0; d < dimension; d += 1) centroid[d] += vertices[v].point[d];
  }
  for (let d = 0; d < dimension; d += 1) centroid[d] /= vertices.length - 1;
  return centroid;
}

/*

Purpose:
	Minimizes a scalar objective over a real vector by the Nelder-Mead simplex
	method. Deterministic: identical inputs always give the identical result.

Input:
	objective [function]: (point [array]) -> number; a non-finite value is treated
	                      as +Infinity so infeasible points are simply rejected
	initialPoint [array]: the starting vector x0
	options [object]: {
	  initialStep   -- initial simplex edge (absolute), default 0.05*|x_i|+0.05
	  maxIterations -- iteration cap, default 400
	  functionTolerance -- stop when the spread of vertex values is below this
	  pointTolerance    -- stop when the simplex size is below this
	}

Output:
	result [object]: { point, value, iterations, converged, evaluations }

*/
export function minimizeNelderMead(objective, initialPoint, options = {}) {
  const {
    initialStep = null,
    maxIterations = 400,
    functionTolerance = 1e-8,
    pointTolerance = 1e-9,
  } = options;

  const dimension = initialPoint.length;
  let evaluations = 0;
  const evaluate = (point) => {
    const value = objective(point);
    evaluations += 1;
    return Number.isFinite(value) ? value : Infinity;
  };

  if (dimension === 0) {
    return { point: [], value: evaluate([]), iterations: 0, converged: true, evaluations };
  }

  // Build the initial simplex: x0 plus a perturbation along each axis.
  const step = (index) =>
    (Array.isArray(initialStep) ? initialStep[index] : initialStep) ??
    (0.05 * Math.abs(initialPoint[index]) + 0.05);

  const vertices = [{ point: initialPoint.slice(), value: 0 }];
  for (let d = 0; d < dimension; d += 1) {
    const point = initialPoint.slice();
    point[d] += step(d);
    vertices.push({ point, value: 0 });
  }
  for (const vertex of vertices) vertex.value = evaluate(vertex.point);

  let iterations = 0;
  let converged = false;

  for (iterations = 1; iterations <= maxIterations; iterations += 1) {
    vertices.sort((a, b) => a.value - b.value);
    const best = vertices[0];
    const worst = vertices[vertices.length - 1];
    const secondWorst = vertices[vertices.length - 2];

    // Convergence: both the objective spread and the simplex geometry are small.
    const valueSpread = Math.abs(worst.value - best.value);
    let pointSpread = 0;
    for (let v = 1; v < vertices.length; v += 1) {
      for (let d = 0; d < dimension; d += 1) {
        pointSpread = Math.max(pointSpread, Math.abs(vertices[v].point[d] - best.point[d]));
      }
    }
    if (valueSpread <= functionTolerance && pointSpread <= pointTolerance) {
      converged = true;
      break;
    }

    const centroid = centroidExcludingWorst(vertices);
    const direction = addScaled(centroid, worst.point, -1); // centroid - worst

    // Reflection.
    const reflected = { point: addScaled(centroid, direction, REFLECTION), value: 0 };
    reflected.value = evaluate(reflected.point);

    if (reflected.value < best.value) {
      // Expansion: reflection was the new best, try to go further.
      const expanded = { point: addScaled(centroid, direction, EXPANSION), value: 0 };
      expanded.value = evaluate(expanded.point);
      vertices[vertices.length - 1] = expanded.value < reflected.value ? expanded : reflected;
      continue;
    }

    if (reflected.value < secondWorst.value) {
      // Reflection is a middling improvement: accept it.
      vertices[vertices.length - 1] = reflected;
      continue;
    }

    // Contraction (outside if reflection beat the worst, otherwise inside).
    const useOutside = reflected.value < worst.value;
    const contractScale = (useOutside ? 1 : -1) * CONTRACTION;
    const contracted = { point: addScaled(centroid, direction, contractScale), value: 0 };
    contracted.value = evaluate(contracted.point);
    const reference = useOutside ? reflected.value : worst.value;
    if (contracted.value < reference) {
      vertices[vertices.length - 1] = contracted;
      continue;
    }

    // Shrink every vertex toward the current best.
    for (let v = 1; v < vertices.length; v += 1) {
      const shrunk = addScaled(best.point, addScaled(vertices[v].point, best.point, -1), SHRINK);
      vertices[v] = { point: shrunk, value: evaluate(shrunk) };
    }
  }

  vertices.sort((a, b) => a.value - b.value);
  return {
    point: vertices[0].point,
    value: vertices[0].value,
    iterations,
    converged,
    evaluations,
  };
}
