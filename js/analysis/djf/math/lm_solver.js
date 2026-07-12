// Small, dependency-free Levenberg-Marquardt primitives shared by DJF fits.

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

/** Solve a small dense linear system by Gaussian elimination with pivoting. */
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

/** Build `(J'J + lambda D) delta = -J'r`. */
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

/**
 * Construct a forward finite-difference Jacobian.
 *
 * `residualFn(parameters)` may return residuals directly, or an object with
 * `objectiveResiduals`/`residuals`. `projectFn` applies model constraints.
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
    const perturbed = [...currentParameters];
    perturbed[parameterIndex] += requestedStep;

    const projected = asFiniteArray(projectFn(perturbed), "projected parameters");
    if (projected.length !== currentParameters.length) {
      throw new RangeError("projectFn must preserve the parameter-vector length.");
    }

    const actualStep =
      projected[parameterIndex] - currentParameters[parameterIndex];
    if (Math.abs(actualStep) < Number.EPSILON) continue;

    const perturbedResiduals = objectiveResidualsFrom(residualFn(projected));
    if (perturbedResiduals.length !== residuals.length) {
      throw new RangeError("residualFn must preserve the residual-vector length.");
    }

    for (let row = 0; row < residuals.length; row += 1) {
      jacobian[row][column] =
        (perturbedResiduals[row] - residuals[row]) / actualStep;
    }
  }

  return jacobian;
}

/** Generic projected Levenberg-Marquardt driver used by Stages 6 and 7. */
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

  let parameters = asFiniteArray(
    projectFn(asFiniteArray(initialParameters, "initialParameters")),
    "projected parameters",
  );
  const indices = Array.from(freeIndices ?? freeParameterIndices ?? []);
  let lambda = options.initialLambda;
  let converged = indices.length === 0;
  let iterations = 0;

  let evaluation = residualFn(parameters);
  let residuals = objectiveResidualsFrom(evaluation);
  let currentSse = sumSquares(residuals);

  for (
    iterations = 1;
    !converged && iterations <= options.maxIterations;
    iterations += 1
  ) {
    const jacobian = buildFiniteDiffJacobian({
      parameters,
      baseResiduals: residuals,
      freeIndices: indices,
      residualFn,
      projectFn,
      finiteDifferenceStep: options.finiteDifferenceStep,
    });
    const { matrix, rightHandSide } = buildNormalEquations(
      jacobian,
      residuals,
      lambda,
    );

    let delta;
    try {
      delta = solveLinearSystem(matrix, rightHandSide);
    } catch {
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

    if (Number.isFinite(trialSse) && trialSse < currentSse) {
      const relativeImprovement =
        (currentSse - trialSse) / Math.max(currentSse, 1);

      parameters = projectedTrial;
      evaluation = trialEvaluation;
      residuals = trialResiduals;
      currentSse = trialSse;
      lambda = Math.max(lambda / 3, options.minimumLambda);

      if (
        relativeImprovement < options.tolerance ||
        relativeStep < options.stepTolerance
      ) {
        converged = true;
      }
    } else {
      const relativeDifference =
        Math.abs(trialSse - currentSse) / Math.max(currentSse, 1);
      if (
        Number.isFinite(trialSse) &&
        relativeDifference < options.tolerance &&
        relativeStep < options.stepTolerance
      ) {
        converged = true;
      } else {
        lambda = Math.min(lambda * 10, options.maximumLambda);
      }
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
    maxIterationsReached,
    finalLambda: lambda,
  };
}

export { DEFAULT_OPTIONS as DEFAULT_LM_OPTIONS };
