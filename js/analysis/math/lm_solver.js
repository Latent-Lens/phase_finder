// Small, dependency-free Levenberg-Marquardt primitives shared by the cell-cycle
// fits. Provides the pieces of a bounded nonlinear least-squares solve:
// solveLinearSystem (Gaussian elimination with pivoting), buildNormalEquations
// (assemble the damped J'J system), buildFiniteDiffJacobian (a projection-aware
// finite-difference Jacobian that stays valid at parameter bounds), and
// runLevenbergMarquardt (the driver that ties them together, with progress and
// cancellation hooks). Internal helpers validate/normalize array inputs.

const DEFAULT_OPTIONS = Object.freeze({
  maxIterations: 150,
  tolerance: 1e-7,
  stepTolerance: 1e-6,
  initialLambda: 1e-2,
  finiteDifferenceStep: 1e-4,
  minimumLambda: 1e-12,
  maximumLambda: 1e12,
});

function isArrayLike(value) {
  return value != null &&
    typeof value !== "string" &&
    Number.isInteger(value.length) &&
    value.length >= 0;
}

function asFiniteArray(values, name) {
  if (!isArrayLike(values)) {
    throw new TypeError(`${name} must be an array or typed array.`);
  }

  const result = Array.from(values);
  for (let index = 0; index < result.length; index += 1) {
    if (!Number.isFinite(result[index])) {
      throw new RangeError(`${name}[${index}] must be finite.`);
    }
  }
  return result;
}

function objectiveResidualsFrom(evaluation) {
  const values =
    isArrayLike(evaluation)
      ? evaluation
      : evaluation?.objectiveResiduals ?? evaluation?.residuals;

  if (!isArrayLike(values)) {
    throw new TypeError(
      "residualFn must return an array-like value or an object containing residuals.",
    );
  }

  return asFiniteArray(values, "residuals");
}

function sumSquares(values) {
  let total = 0;
  for (const value of values) total += value * value;
  return total;
}

/*

Purpose:
	Solves a small dense linear system Ax = b by Gaussian elimination with
	partial pivoting.

Input:
	matrix [array]: the square coefficient matrix A (array of rows)
	vector [array]: the right-hand side b, length = matrix size

Output:
	solution [array]: x (throws on a singular matrix or a size mismatch)

*/
export function solveLinearSystem(matrix, vector) {
  const rightHandSide = asFiniteArray(vector, "vector");
  const size = rightHandSide.length;

  if (size === 0) return [];
  if (!isArrayLike(matrix) || matrix.length !== size) {
    throw new RangeError("matrix must be square and match vector.length.");
  }

  const augmented = new Array(size);
  for (let row = 0; row < size; row += 1) {
    const sourceRow = asFiniteArray(matrix[row], `matrix[${row}]`);
    if (sourceRow.length !== size) {
      throw new RangeError("matrix must be square and match vector.length.");
    }
    augmented[row] = [...sourceRow, rightHandSide[row]];
  }

  for (let pivot = 0; pivot < size; pivot += 1) {
    let strongestRow = pivot;
    for (let row = pivot + 1; row < size; row += 1) {
      if (
        Math.abs(augmented[row][pivot]) >
        Math.abs(augmented[strongestRow][pivot])
      ) {
        strongestRow = row;
      }
    }

    if (Math.abs(augmented[strongestRow][pivot]) < 1e-14) {
      throw new Error("Singular normal-equation matrix.");
    }

    [augmented[pivot], augmented[strongestRow]] = [
      augmented[strongestRow],
      augmented[pivot],
    ];

    const pivotValue = augmented[pivot][pivot];
    for (let column = pivot; column <= size; column += 1) {
      augmented[pivot][column] /= pivotValue;
    }

    for (let row = 0; row < size; row += 1) {
      if (row === pivot) continue;
      const factor = augmented[row][pivot];
      for (let column = pivot; column <= size; column += 1) {
        augmented[row][column] -= factor * augmented[pivot][column];
      }
    }
  }

  return augmented.map(row => row[size]);
}

/*

Purpose:
	Assembles the damped normal equations (J'J + lambda·D) delta = -J'r for one
	Levenberg-Marquardt step, where D is the scaled diagonal of J'J.

Input:
	jacobian [array]: the Jacobian J, one row of partial derivatives per residual
	residuals [array]: the residual vector r
	lambda [number]: the LM damping factor (finite, >= 0)

Output:
	system [object]: { matrix, rightHandSide } ready for solveLinearSystem

*/
export function buildNormalEquations(jacobian, residuals, lambda) {
  const objectiveResiduals = asFiniteArray(residuals, "residuals");
  if (!isArrayLike(jacobian) || jacobian.length !== objectiveResiduals.length) {
    throw new RangeError("jacobian rows must match residuals.length.");
  }
  if (!(lambda >= 0) || !Number.isFinite(lambda)) {
    throw new RangeError("lambda must be finite and nonnegative.");
  }

  if (jacobian.length === 0) {
    return { matrix: [], rightHandSide: [] };
  }

  const parameterCount = jacobian[0]?.length ?? 0;
  const matrix = Array.from(
    { length: parameterCount },
    () => new Array(parameterCount).fill(0),
  );
  const gradient = new Array(parameterCount).fill(0);

  for (let row = 0; row < jacobian.length; row += 1) {
    const derivatives = asFiniteArray(jacobian[row], `jacobian[${row}]`);
    if (derivatives.length !== parameterCount) {
      throw new RangeError("all jacobian rows must have the same length.");
    }

    for (let column = 0; column < parameterCount; column += 1) {
      const derivative = derivatives[column];
      gradient[column] += derivative * objectiveResiduals[row];

      for (let other = column; other < parameterCount; other += 1) {
        matrix[column][other] += derivative * derivatives[other];
      }
    }
  }

  for (let column = 0; column < parameterCount; column += 1) {
    for (let other = 0; other < column; other += 1) {
      matrix[column][other] = matrix[other][column];
    }
    matrix[column][column] +=
      lambda * Math.max(matrix[column][column], 1);
  }

  return {
    matrix,
    rightHandSide: gradient.map(value => -value),
  };
}

// 2-norm condition estimate from the eigenvalues of J'J. The cell-cycle
// models have at most twelve parameters, so a small symmetric Jacobi sweep is
// simpler and more reliable than inferring conditioning from solver failures.
export function estimateJacobianCondition(jacobian) {
  if (!jacobian.length || !jacobian[0]?.length) return 1;
  const columns = jacobian[0].length;
  const gram = Array.from({ length: columns }, () => new Array(columns).fill(0));
  for (const row of jacobian) {
    for (let left = 0; left < columns; left += 1) {
      for (let right = left; right < columns; right += 1) {
        gram[left][right] += row[left] * row[right];
        if (left !== right) gram[right][left] = gram[left][right];
      }
    }
  }
  for (let sweep = 0; sweep < 50 * columns * columns; sweep += 1) {
    let p = 0;
    let q = 0;
    let largest = 0;
    for (let row = 0; row < columns; row += 1) {
      for (let column = row + 1; column < columns; column += 1) {
        if (Math.abs(gram[row][column]) > largest) {
          largest = Math.abs(gram[row][column]);
          p = row;
          q = column;
        }
      }
    }
    if (largest <= 1e-12 * Math.max(1, ...gram.map((row, index) => Math.abs(row[index])))) break;
    const angle = 0.5 * Math.atan2(2 * gram[p][q], gram[q][q] - gram[p][p]);
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const app = gram[p][p];
    const aqq = gram[q][q];
    const apq = gram[p][q];
    gram[p][p] = cosine * cosine * app - 2 * sine * cosine * apq + sine * sine * aqq;
    gram[q][q] = sine * sine * app + 2 * sine * cosine * apq + cosine * cosine * aqq;
    gram[p][q] = 0;
    gram[q][p] = 0;
    for (let index = 0; index < columns; index += 1) {
      if (index === p || index === q) continue;
      const aip = gram[index][p];
      const aiq = gram[index][q];
      gram[index][p] = gram[p][index] = cosine * aip - sine * aiq;
      gram[index][q] = gram[q][index] = sine * aip + cosine * aiq;
    }
  }
  const eigenvalues = gram.map((row, index) => Math.max(0, row[index]));
  const largest = Math.max(...eigenvalues);
  const smallest = Math.min(...eigenvalues);
  if (!(largest > 0) || smallest <= largest * 1e-14) return Infinity;
  return Math.sqrt(largest / smallest);
}

/*

Purpose:
	Builds a finite-difference Jacobian projected through the model's
	constraints, so derivatives stay valid for parameters sitting at a bound.
	Each free parameter is probed both ways: when both a forward and a backward
	step survive projection unclipped, the column uses a central difference;
	when only one side survives (the parameter is at a bound), it uses a
	one-sided difference in that feasible direction rather than zeroing out;
	only a fully pinned parameter yields a zero column (the correct derivative
	there).

Input:
	spec [object]: {
	  parameters, baseResiduals, freeIndices (or freeParameterIndices),
	  residualFn (returns residuals or { objectiveResiduals|residuals }),
	  projectFn (applies constraints), finiteDifferenceStep }

Output:
	jacobian [array]: rows = residuals, columns = free parameters

*/
export function buildFiniteDiffJacobian({
  parameters,
  baseResiduals,
  freeIndices,
  freeParameterIndices,
  residualFn,
  projectFn = values => values,
  finiteDifferenceStep = DEFAULT_OPTIONS.finiteDifferenceStep,
}) {
  const currentParameters = asFiniteArray(parameters, "parameters");
  const residuals = asFiniteArray(baseResiduals, "baseResiduals");
  const indices = Array.from(freeIndices ?? freeParameterIndices ?? []);

  if (typeof residualFn !== "function" || typeof projectFn !== "function") {
    throw new TypeError("residualFn and projectFn must be functions.");
  }
  if (!(finiteDifferenceStep > 0) || !Number.isFinite(finiteDifferenceStep)) {
    throw new RangeError("finiteDifferenceStep must be finite and positive.");
  }

  const jacobian = Array.from(
    { length: residuals.length },
    () => new Array(indices.length).fill(0),
  );

  for (let column = 0; column < indices.length; column += 1) {
    const parameterIndex = indices[column];
    if (
      !Number.isInteger(parameterIndex) ||
      parameterIndex < 0 ||
      parameterIndex >= currentParameters.length
    ) {
      throw new RangeError(`freeIndices[${column}] is out of range.`);
    }

    const requestedStep = finiteDifferenceStep * Math.max(
      Math.abs(currentParameters[parameterIndex]),
      1,
    );

    const perturbedForward = [...currentParameters];
    perturbedForward[parameterIndex] += requestedStep;
    const projectedForward = asFiniteArray(projectFn(perturbedForward), "projected parameters");
    if (projectedForward.length !== currentParameters.length) {
      throw new RangeError("projectFn must preserve the parameter-vector length.");
    }
    const actualStepForward = projectedForward[parameterIndex] - currentParameters[parameterIndex];
    const forwardFeasible = Math.abs(actualStepForward) >= Number.EPSILON;

    const perturbedBackward = [...currentParameters];
    perturbedBackward[parameterIndex] -= requestedStep;
    const projectedBackward = asFiniteArray(projectFn(perturbedBackward), "projected parameters");
    if (projectedBackward.length !== currentParameters.length) {
      throw new RangeError("projectFn must preserve the parameter-vector length.");
    }
    const actualStepBackward = projectedBackward[parameterIndex] - currentParameters[parameterIndex];
    const backwardFeasible = Math.abs(actualStepBackward) >= Number.EPSILON;

    if (!forwardFeasible && !backwardFeasible) continue; // fully pinned; zero is correct

    if (forwardFeasible && backwardFeasible) {
      const residualsForward = objectiveResidualsFrom(residualFn(projectedForward));
      const residualsBackward = objectiveResidualsFrom(residualFn(projectedBackward));
      if (
        residualsForward.length !== residuals.length ||
        residualsBackward.length !== residuals.length
      ) {
        throw new RangeError("residualFn must preserve the residual-vector length.");
      }
      const stepSpread = actualStepForward - actualStepBackward;
      for (let row = 0; row < residuals.length; row += 1) {
        jacobian[row][column] =
          (residualsForward[row] - residualsBackward[row]) / stepSpread;
      }
    } else {
      const projected = forwardFeasible ? projectedForward : projectedBackward;
      const actualStep = forwardFeasible ? actualStepForward : actualStepBackward;
      const perturbedResiduals = objectiveResidualsFrom(residualFn(projected));
      if (perturbedResiduals.length !== residuals.length) {
        throw new RangeError("residualFn must preserve the residual-vector length.");
      }
      for (let row = 0; row < residuals.length; row += 1) {
        jacobian[row][column] =
          (perturbedResiduals[row] - residuals[row]) / actualStep;
      }
    }
  }

  return jacobian;
}

/*

Purpose:
	Generic projected Levenberg-Marquardt driver -- the bounded nonlinear
	least-squares loop the cell-cycle fits run on. Iterates finite-difference
	Jacobian -> damped normal equations -> accept/reject step by SSE, adapting
	lambda, until a tolerance is met, the step is genuinely small, the iteration
	budget is exhausted, or the caller cancels.

Input:
	spec [object]: {
	  initialParameters, residualFn, projectFn, freeIndices (or
	  freeParameterIndices), options: { maxIterations, tolerance, stepTolerance,
	  initialLambda, finiteDifferenceStep, onProgress, shouldCancel, ... } }

Output:
	result [object]: { parameters, residuals, objectiveResiduals, sse,
	                   iterations, converged, maxIterationsReached, cancelled,
	                   finalLambda, model, evaluation }

*/
export function runLevenbergMarquardt({
  initialParameters,
  residualFn,
  projectFn = values => values,
  freeIndices,
  freeParameterIndices,
  options: userOptions = {},
}) {
  if (typeof residualFn !== "function" || typeof projectFn !== "function") {
    throw new TypeError("residualFn and projectFn must be functions.");
  }

  const options = { ...DEFAULT_OPTIONS, ...userOptions };
  if (!Number.isInteger(options.maxIterations) || options.maxIterations < 0) {
    throw new RangeError("maxIterations must be a nonnegative integer.");
  }
  for (const name of ["tolerance", "stepTolerance", "initialLambda"]) {
    if (!(options[name] >= 0) || !Number.isFinite(options[name])) {
      throw new RangeError(`${name} must be finite and nonnegative.`);
    }
  }

  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const shouldCancel = typeof options.shouldCancel === "function" ? options.shouldCancel : null;

  let parameters = asFiniteArray(
    projectFn(asFiniteArray(initialParameters, "initialParameters")),
    "projected parameters",
  );
  const indices = Array.from(freeIndices ?? freeParameterIndices ?? []);
  let lambda = options.initialLambda;
  let converged = indices.length === 0;
  // Which stopping condition actually fired, so callers never label a fit with a
  // criterion that did not hold (audit SCI-03). Convergence in the accepted-step
  // branch can come from the objective tolerance OR the step tolerance alone, so
  // "objective_and_step" must be reserved for when both genuinely held.
  let terminationReason = indices.length === 0 ? "no_free_parameters" : null;
  let cancelled = false;
  let iterations = 0;
  let rankFailureCount = 0;
  let maximumJacobianCondition = 1;
  let activeProjectionCount = 0;

  let evaluation = residualFn(parameters);
  let residuals = objectiveResidualsFrom(evaluation);
  let currentSse = sumSquares(residuals);

  for (
    iterations = 1;
    !converged && iterations <= options.maxIterations;
    iterations += 1
  ) {
    if (shouldCancel && shouldCancel()) {
      cancelled = true;
      break;
    }

    const jacobian = buildFiniteDiffJacobian({
      parameters,
      baseResiduals: residuals,
      freeIndices: indices,
      residualFn,
      projectFn,
      finiteDifferenceStep: options.finiteDifferenceStep,
    });
    maximumJacobianCondition = Math.max(
      maximumJacobianCondition,
      estimateJacobianCondition(jacobian),
    );
    const { matrix, rightHandSide } = buildNormalEquations(
      jacobian,
      residuals,
      lambda,
    );

    let delta;
    try {
      delta = solveLinearSystem(matrix, rightHandSide);
    } catch {
      rankFailureCount += 1;
      lambda = Math.min(lambda * 10, options.maximumLambda);
      continue;
    }

    const trialParameters = [...parameters];
    for (let index = 0; index < indices.length; index += 1) {
      trialParameters[indices[index]] += delta[index];
    }

    const projectedTrial = asFiniteArray(
      projectFn(trialParameters),
      "projected parameters",
    );
    for (const parameterIndex of indices) {
      if (Math.abs(projectedTrial[parameterIndex] - trialParameters[parameterIndex]) > 1e-10) {
        activeProjectionCount += 1;
      }
    }
    const trialEvaluation = residualFn(projectedTrial);
    const trialResiduals = objectiveResidualsFrom(trialEvaluation);
    if (trialResiduals.length !== residuals.length) {
      throw new RangeError("residualFn must preserve the residual-vector length.");
    }
    const trialSse = sumSquares(trialResiduals);

    let relativeStep = 0;
    for (const parameterIndex of indices) {
      relativeStep = Math.max(
        relativeStep,
        Math.abs(projectedTrial[parameterIndex] - parameters[parameterIndex]) /
          Math.max(Math.abs(parameters[parameterIndex]), 1),
      );
    }

    // Post-projection displacement alone can't distinguish "genuinely
    // converged" from "the raw LM step got clipped to ~zero by a bound."
    // Require the *unprojected* step to be small too before trusting a small
    // projected step as convergence evidence; a large raw step that keeps
    // getting clipped means the solver is still trying to move, just blocked.
    let rawRelativeStep = 0;
    for (let index = 0; index < indices.length; index += 1) {
      const parameterIndex = indices[index];
      rawRelativeStep = Math.max(
        rawRelativeStep,
        Math.abs(delta[index]) / Math.max(Math.abs(parameters[parameterIndex]), 1),
      );
    }
    const stepGenuinelySmall =
      relativeStep < options.stepTolerance && rawRelativeStep < options.stepTolerance;

    if (Number.isFinite(trialSse) && trialSse < currentSse) {
      const relativeImprovement =
        (currentSse - trialSse) / Math.max(currentSse, 1);

      parameters = projectedTrial;
      evaluation = trialEvaluation;
      residuals = trialResiduals;
      currentSse = trialSse;
      lambda = Math.max(lambda / 3, options.minimumLambda);

      const objectiveMet = relativeImprovement < options.tolerance;
      if (objectiveMet || stepGenuinelySmall) {
        converged = true;
        terminationReason =
          objectiveMet && stepGenuinelySmall ? "objective_and_step"
            : objectiveMet ? "objective_tolerance"
              : "step_tolerance";
      }
    } else {
      const relativeDifference =
        Math.abs(trialSse - currentSse) / Math.max(currentSse, 1);
      if (
        Number.isFinite(trialSse) &&
        relativeDifference < options.tolerance &&
        stepGenuinelySmall
      ) {
        // No improving step exists and the trial step is tiny: a stall at the
        // tolerance, not a fresh objective decrease. Labelled distinctly so it
        // is not read as a productive objective-tolerance stop.
        converged = true;
        terminationReason = "step_stall";
      } else {
        lambda = Math.min(lambda * 10, options.maximumLambda);
      }
    }

    if (onProgress) {
      onProgress({ iteration: iterations, maxIterations: options.maxIterations, sse: currentSse, converged });
    }
  }

  // `iterations` holds the loop counter after its final post-increment (and is
  // never entered as maxIterations + 1), so the number of iterations actually
  // executed is one less. This equals the bodies run in every case: converged
  // early, ran to the budget, or never entered the loop.
  const iterationsPerformed = Math.max(0, iterations - 1);
  const evaluationObject =
    evaluation && !isArrayLike(evaluation) ? evaluation : null;
  // The loop exits either on a tolerance hit (`converged`) or on exhausting the
  // iteration budget. The latter with a finite SSE is a stable stop, distinct
  // from a genuine early abort; callers report the two differently.
  const maxIterationsReached =
    !converged &&
    options.maxIterations > 0 &&
    iterationsPerformed >= options.maxIterations;

  return {
    parameters,
    model: evaluationObject?.model,
    evaluation,
    residuals,
    rawResiduals: evaluationObject?.rawResiduals ?? evaluationObject?.residuals,
    objectiveResiduals: residuals,
    sse: currentSse,
    parameterCount: indices.length,
    iterations: iterationsPerformed,
    converged,
    terminationReason:
      terminationReason ?? (cancelled ? "cancelled" : maxIterationsReached ? "max_iterations" : "unknown"),
    maxIterationsReached,
    cancelled,
    finalLambda: lambda,
    optimizerDiagnostics: {
      maximumJacobianCondition,
      rankFailureCount,
      activeProjectionCount,
      weaklyIdentified: !Number.isFinite(maximumJacobianCondition) || maximumJacobianCondition > 1e8,
      finiteDifferenceRelativeStep: options.finiteDifferenceStep,
    },
  };
}

export { DEFAULT_OPTIONS as DEFAULT_LM_OPTIONS };
