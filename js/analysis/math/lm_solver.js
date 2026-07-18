// Small, dependency-free Levenberg-Marquardt primitives shared by cell-cycle fits.

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
 * Construct a finite-difference Jacobian, projected through model constraints.
 *
 * `residualFn(parameters)` may return residuals directly, or an object with
 * `objectiveResiduals`/`residuals`. `projectFn` applies model constraints
 * (e.g. clipping a parameter to a hard bound).
 *
 * Each free parameter is probed in both directions. When both a forward and a
 * backward step survive projection unclipped, the column uses a central
 * difference (second-order accurate). When only one side survives — the
 * parameter sits at a bound and the other direction gets clipped back to the
 * same value — the column uses a one-sided difference in that feasible
 * ("inward") direction instead of silently zeroing out. Only when *neither*
 * direction moves the parameter (it is fully pinned, e.g. by a degenerate
 * bound) does the column stay zero, which is the correct derivative there.
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

  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const shouldCancel = typeof options.shouldCancel === "function" ? options.shouldCancel : null;

  let parameters = asFiniteArray(
    projectFn(asFiniteArray(initialParameters, "initialParameters")),
    "projected parameters",
  );
  const indices = Array.from(freeIndices ?? freeParameterIndices ?? []);
  let lambda = options.initialLambda;
  let converged = indices.length === 0;
  let cancelled = false;
  let iterations = 0;

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

      if (relativeImprovement < options.tolerance || stepGenuinelySmall) {
        converged = true;
      }
    } else {
      const relativeDifference =
        Math.abs(trialSse - currentSse) / Math.max(currentSse, 1);
      if (
        Number.isFinite(trialSse) &&
        relativeDifference < options.tolerance &&
        stepGenuinelySmall
      ) {
        converged = true;
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
    maxIterationsReached,
    cancelled,
    finalLambda: lambda,
  };
}

export { DEFAULT_OPTIONS as DEFAULT_LM_OPTIONS };
