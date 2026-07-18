#!/usr/bin/env python3
"""Browser unit coverage for shared DJF numerical and state helpers.

These tests deliberately use small, hand-computable inputs.  They protect the
math primitives used by several pipeline stages, so a regression is reported at
the helper boundary instead of surfacing later as a vague fit failure.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / DJF Shared"


_SHARED_HELPERS = r"""() => {
  const { stats, gaussian, integrate, linalg2d, lm, components } = window.DJFShared;
  const state = window.DJFPipelineState;
  const pipeline = window.PhaseFinder.pipeline;
  const results = [];
  const push = (name, pass, detail = '') => results.push({
    name, pass: Boolean(pass), detail: String(detail ?? ''),
  });
  const run = (name, test) => {
    try {
      const outcome = test();
      push(name, outcome.pass, outcome.detail);
    } catch (error) {
      push(name, false, `${error.name}: ${error.message}`);
    }
  };
  const close = (left, right, tolerance = 1e-9) =>
    Math.abs(left - right) <= tolerance;
  const throws = (callback, pattern = null) => {
    try {
      callback();
      return false;
    } catch (error) {
      return pattern == null || pattern.test(error.message);
    }
  };

  // ---- Robust statistics -------------------------------------------------
  run('stats: median handles odd, even, typed, and empty inputs', () => {
    const values = {
      odd: stats.median([9, 1, 5]),
      even: stats.median(Float64Array.from([8, 2, 4, 6])),
      empty: stats.median([]),
    };
    return {
      pass: values.odd === 5 && values.even === 5 && Number.isNaN(values.empty),
      detail: JSON.stringify(values),
    };
  });

  run('stats: MAD is measured about the supplied/sample median', () => {
    const sample = [1, 1, 2, 2, 4];
    const automatic = stats.mad(sample);
    const supplied = stats.mad(sample, 1);
    return {
      pass: automatic === 1 && supplied === 1,
      detail: `automatic=${automatic}, supplied=${supplied}`,
    };
  });

  run('stats: mean and population variance match hand calculation', () => {
    const mean = stats.mean([1, 2, 3, 4]);
    const variance = stats.variance([1, 2, 3, 4]);
    return { pass: mean === 2.5 && variance === 1.25, detail: `${mean}, ${variance}` };
  });

  run('stats: sorted quantiles interpolate and clamp probabilities', () => {
    const values = [0, 10, 20, 30];
    const q25 = stats.quantileSorted(values, 0.25);
    const below = stats.quantileSorted(values, -5);
    const above = stats.quantileSorted(values, 5);
    return {
      pass: q25 === 7.5 && below === 0 && above === 30,
      detail: JSON.stringify({ q25, below, above }),
    };
  });

  run('stats: maximum and sum-of-squares support empty and signed inputs', () => {
    const maximum = stats.maximumValue([]);
    const squared = stats.sumSquares([-2, 3]);
    return {
      pass: maximum === -Infinity && squared === 13,
      detail: `maximum=${maximum}, squared=${squared}`,
    };
  });

  run('stats: robust residual scale honors its positive floor', () => {
    const defaultFloor = stats.robustResidualScale([0, 0, 0]);
    const customFloor = stats.robustResidualScale([4, 4, 4], 0.5);
    return {
      pass: defaultFloor === 1e-12 && customFloor === 0.5,
      detail: `${defaultFloor}, ${customFloor}`,
    };
  });

  run('stats: nearest-index ties use first value and zero denominator is safe', () => {
    const index = stats.nearestIndex([0, 10, 20], 15);
    const ordinary = stats.safeFraction(3, 4);
    const zero = stats.safeFraction(3, 0);
    return {
      pass: index === 1 && ordinary === 0.75 && zero === 0,
      detail: JSON.stringify({ index, ordinary, zero }),
    };
  });

  // ---- Gaussian and log-domain helpers ----------------------------------
  run('gaussian: peak height is exact at the mean and symmetric', () => {
    const center = gaussian.gaussianPeakHeight(10, 10, 2, 7);
    const left = gaussian.gaussianPeakHeight(8, 10, 2, 7);
    const right = gaussian.gaussianPeakHeight(12, 10, 2, 7);
    return {
      pass: center === 7 && close(left, right) && gaussian.gaussianPeakHeight(10, 10, 0, 7) === 0,
      detail: JSON.stringify({ center, left, right }),
    };
  });

  run('gaussian: smoothing preserves a constant signal including boundaries', () => {
    const smoothed = gaussian.gaussianSmooth([5, 5, 5, 5, 5], 1.25);
    const maximumError = Math.max(...smoothed.map((value) => Math.abs(value - 5)));
    return { pass: maximumError < 1e-12, detail: `maximumError=${maximumError}` };
  });

  run('gaussian: impulse smoothing is finite, positive, and symmetric', () => {
    const smoothed = gaussian.gaussianSmooth([0, 0, 0, 1, 0, 0, 0], 1);
    const symmetric = smoothed.every((value, index) =>
      close(value, smoothed[smoothed.length - index - 1], 1e-12)
    );
    return {
      pass: symmetric && smoothed.every(Number.isFinite) && smoothed[3] > smoothed[2] && smoothed[2] > smoothed[1],
      detail: JSON.stringify(smoothed),
    };
  });

  run('gaussian: invalid smoothing sigma returns a copied signal', () => {
    const source = [1, 4, 2];
    const output = gaussian.gaussianSmooth(source, 0);
    return {
      pass: output !== source && output.join(',') === source.join(','),
      detail: JSON.stringify(output),
    };
  });

  run('gaussian: logistic remains stable at extreme magnitudes', () => {
    const low = gaussian.logistic(-1000);
    const high = gaussian.logistic(1000);
    const symmetry = gaussian.logistic(2) + gaussian.logistic(-2);
    return {
      pass: low === 0 && high === 1 && close(symmetry, 1, 1e-15),
      detail: JSON.stringify({ low, high, symmetry }),
    };
  });

  run('gaussian: logSumExp avoids overflow and defines empty input', () => {
    const value = gaussian.logSumExp([1000, 1000]);
    const empty = gaussian.logSumExp([]);
    return {
      pass: close(value, 1000 + Math.log(2), 1e-12) && empty === -Infinity,
      detail: `${value}, ${empty}`,
    };
  });

  run('gaussian: 2D log density matches standard normal and rejects singular covariance', () => {
    const component = { mean: [0, 0], covariance: [[1, 0], [0, 1]] };
    const origin = gaussian.logGaussian2D([0, 0], component);
    const unit = gaussian.logGaussian2D([1, 0], component);
    const singular = gaussian.logGaussian2D([0, 0], {
      mean: [0, 0], covariance: [[1, 1], [1, 1]],
    });
    return {
      pass: close(origin, -Math.log(2 * Math.PI), 1e-12)
        && close(unit, origin - 0.5, 1e-12)
        && singular === -Infinity,
      detail: JSON.stringify({ origin, unit, singular }),
    };
  });

  // ---- Numerical integration --------------------------------------------
  run('integrate: trapezoids recover a unit triangle area', () => {
    const area = integrate.integrateTrapezoidal([0, 1, 2], [0, 1, 0]);
    return { pass: area === 1, detail: String(area) };
  });

  run('integrate: typed arrays and nonuniform spacing are supported', () => {
    const area = integrate.integrateTrapezoidal(
      Float64Array.from([0, 2, 5]),
      Float64Array.from([1, 1, 3]),
    );
    return { pass: area === 8, detail: String(area) };
  });

  run('integrate: mismatched and undersized inputs return zero', () => {
    const mismatched = integrate.integrateTrapezoidal([0, 1], [2]);
    const undersized = integrate.integrateTrapezoidal([0], [2]);
    return { pass: mismatched === 0 && undersized === 0, detail: `${mismatched}, ${undersized}` };
  });

  // ---- Two-dimensional linear algebra -----------------------------------
  run('linalg2d: population covariance matches a two-point example', () => {
    const covariance = linalg2d.calculateGlobalCovariance([[0, 0], [2, 0]]);
    return {
      pass: covariance[0][0] === 1 && covariance[0][1] === 0
        && covariance[1][0] === 0 && covariance[1][1] === 0,
      detail: JSON.stringify(covariance),
    };
  });

  run('linalg2d: covariance regularization is symmetric and scale-aware', () => {
    const covariance = linalg2d.regularizeCovariance([[0, 0], [0, 0]], 1e-3);
    return {
      pass: covariance[0][0] === 1e-3 && covariance[1][1] === 1e-3
        && covariance[0][1] === 0 && covariance[1][0] === 0,
      detail: JSON.stringify(covariance),
    };
  });

  run('linalg2d: 2x2 covariance inverse and determinant are exact', () => {
    const result = linalg2d.invertCovariance2D([[4, 2], [2, 3]]);
    return {
      pass: result.determinant === 8
        && close(result.inverse[0][0], 0.375)
        && close(result.inverse[0][1], -0.25)
        && close(result.inverse[1][0], -0.25)
        && close(result.inverse[1][1], 0.5),
      detail: JSON.stringify(result),
    };
  });

  run('linalg2d: eigendecomposition orders major and minor axes', () => {
    const decomposition = linalg2d.eigenDecomposition2D([[3, 0], [0, 1]]);
    const major = decomposition.vectors[0];
    const minor = decomposition.vectors[1];
    const dot = major[0] * minor[0] + major[1] * minor[1];
    return {
      pass: close(decomposition.values[0], 3) && close(decomposition.values[1], 1)
        && close(Math.hypot(...major), 1) && close(Math.hypot(...minor), 1)
        && close(dot, 0),
      detail: JSON.stringify(decomposition),
    };
  });

  run('linalg2d: Mahalanobis distance handles diagonal and singular covariance', () => {
    const distance = linalg2d.mahalanobisSquared([3, 4], [0, 0], [[9, 0], [0, 16]]);
    const singular = linalg2d.mahalanobisSquared([1, 1], [0, 0], [[1, 1], [1, 1]]);
    return {
      pass: close(distance, 2) && singular === Infinity,
      detail: JSON.stringify({ distance, singular }),
    };
  });

  run('linalg2d: weighted center and covariance retain symmetry', () => {
    const points = [[0, 0], [10, 20]];
    const weights = [1, 3];
    const center = linalg2d.calculateWeightedCenter(points, weights);
    const covariance = linalg2d.calculateWeightedCovariance(points, weights, center, 0);
    return {
      pass: close(center[0], 7.5) && close(center[1], 15)
        && close(covariance[0][1], covariance[1][0])
        && covariance[0][0] > 0 && covariance[1][1] > covariance[0][0],
      detail: JSON.stringify({ center, covariance }),
    };
  });

  run('linalg2d: signed orthogonal distance follows ridge orientation', () => {
    const distance = linalg2d.signedOrthogonalDistance([2, 3], [1, 1], [1, 0]);
    const reverse = linalg2d.signedOrthogonalDistance([2, 3], [1, 1], [-1, 0]);
    return { pass: distance === 2 && reverse === -2, detail: `${distance}, ${reverse}` };
  });

  // ---- Shared Levenberg-Marquardt primitives -----------------------------
  run('LM: Gaussian elimination pivots and solves a hand-computed system', () => {
    const solution = lm.solveLinearSystem([[0, 2], [1, 3]], [4, 5]);
    return {
      pass: close(solution[0], -1) && close(solution[1], 2),
      detail: JSON.stringify(solution),
    };
  });

  run('LM: singular linear systems fail clearly', () => {
    const failed = throws(
      () => lm.solveLinearSystem([[1, 2], [2, 4]], [1, 2]),
      /Singular/,
    );
    return { pass: failed, detail: `failed=${failed}` };
  });

  run('LM: normal equations build JtJ and negative Jtr', () => {
    const equations = lm.buildNormalEquations([[1, 2], [3, 4]], [5, 6], 0);
    const expectedMatrix = '10,14;14,20';
    const actualMatrix = equations.matrix.map((row) => row.join(',')).join(';');
    return {
      pass: actualMatrix === expectedMatrix && equations.rightHandSide.join(',') === '-23,-34',
      detail: JSON.stringify(equations),
    };
  });

  run('LM: finite-difference Jacobian recovers linear derivatives', () => {
    const parameters = [2, 4];
    const residualFn = ([a, b]) => [a + 2 * b, 3 * a - b];
    const baseResiduals = residualFn(parameters);
    const jacobian = lm.buildFiniteDiffJacobian({
      parameters,
      baseResiduals,
      freeIndices: [0, 1],
      residualFn,
      finiteDifferenceStep: 1e-6,
    });
    return {
      pass: close(jacobian[0][0], 1, 1e-8) && close(jacobian[1][0], 3, 1e-8)
        && close(jacobian[0][1], 2, 1e-8) && close(jacobian[1][1], -1, 1e-8),
      detail: JSON.stringify(jacobian),
    };
  });

  run('LM: finite-difference columns stay zero only when fully pinned in both directions', () => {
    const jacobian = lm.buildFiniteDiffJacobian({
      parameters: [1],
      baseResiduals: [1],
      freeIndices: [0],
      residualFn: ([value]) => [value],
      projectFn: () => [1], // locked regardless of the requested perturbation
      finiteDifferenceStep: 1e-4,
    });
    return { pass: jacobian[0][0] === 0, detail: JSON.stringify(jacobian) };
  });

  run('LM: a one-sided bound uses the feasible (inward) direction instead of zeroing out', () => {
    const jacobian = lm.buildFiniteDiffJacobian({
      parameters: [1],
      baseResiduals: [1],
      freeIndices: [0],
      residualFn: ([value]) => [value],
      projectFn: ([value]) => [Math.min(1, value)], // upper bound; backward direction is feasible
      finiteDifferenceStep: 1e-4,
    });
    return { pass: close(jacobian[0][0], 1, 1e-6), detail: JSON.stringify(jacobian) };
  });

  run('LM: projected solver converges on a one-parameter least-squares target', () => {
    const fit = lm.runLevenbergMarquardt({
      initialParameters: [0],
      freeIndices: [0],
      residualFn: ([value]) => [value - 3],
      options: { maxIterations: 50, tolerance: 1e-12, stepTolerance: 1e-12 },
    });
    return {
      pass: fit.converged && close(fit.parameters[0], 3, 1e-6) && fit.sse < 1e-12,
      detail: JSON.stringify({ parameter: fit.parameters[0], sse: fit.sse, iterations: fit.iterations }),
    };
  });

  run('LM: an upper-bound-pinned start moves inward to the true feasible optimum', () => {
    // Regression for the false-convergence-at-bounds bug: starts clipped to the
    // upper bound (1), but the true minimum of (value - 0.5)^2 lies inward at
    // 0.5, which is feasible. Before the central/inward-difference fix this
    // fell into a zero Jacobian column and falsely converged at the bound
    // after one iteration with sse=0.25.
    const fit = lm.runLevenbergMarquardt({
      initialParameters: [2],
      freeIndices: [0],
      residualFn: ([value]) => [value - 0.5],
      projectFn: ([value]) => [Math.min(1, value)],
      options: { maxIterations: 200, tolerance: 1e-12, stepTolerance: 1e-12 },
    });
    return {
      pass: fit.converged && close(fit.parameters[0], 0.5, 1e-4) && fit.sse < 1e-6,
      detail: JSON.stringify({ parameter: fit.parameters[0], sse: fit.sse, iterations: fit.iterations }),
    };
  });

  run('LM: a lower-bound-pinned start moves inward to the true feasible optimum', () => {
    // Symmetric mirror of the upper-bound case: starts clipped to the lower
    // bound (0), true minimum of (value - 1.5)^2 lies inward at 1.5.
    const fit = lm.runLevenbergMarquardt({
      initialParameters: [-1],
      freeIndices: [0],
      residualFn: ([value]) => [value - 1.5],
      projectFn: ([value]) => [Math.max(0, value)],
      options: { maxIterations: 200, tolerance: 1e-12, stepTolerance: 1e-12 },
    });
    return {
      pass: fit.converged && close(fit.parameters[0], 1.5, 1e-4) && fit.sse < 1e-6,
      detail: JSON.stringify({ parameter: fit.parameters[0], sse: fit.sse, iterations: fit.iterations }),
    };
  });

  run('LM: no free parameters is an immediate converged result', () => {
    const fit = lm.runLevenbergMarquardt({
      initialParameters: [7],
      freeIndices: [],
      residualFn: ([value]) => [value - 3],
    });
    return {
      pass: fit.converged && fit.iterations === 0 && fit.parameterCount === 0 && fit.parameters[0] === 7,
      detail: JSON.stringify(fit),
    };
  });

  run('LM: shouldCancel halts the loop immediately and reports cancelled, not converged', () => {
    const fit = lm.runLevenbergMarquardt({
      initialParameters: [0],
      freeIndices: [0],
      residualFn: ([value]) => [value - 100],
      options: { maxIterations: 50, shouldCancel: () => true },
    });
    return {
      pass: fit.cancelled === true && fit.converged === false && fit.iterations === 0,
      detail: JSON.stringify({ cancelled: fit.cancelled, converged: fit.converged, iterations: fit.iterations }),
    };
  });

  run('LM: shouldCancel checked after a chosen iteration count halts mid-fit', () => {
    let calls = 0;
    const fit = lm.runLevenbergMarquardt({
      initialParameters: [0],
      freeIndices: [0],
      residualFn: ([value]) => [value - 100],
      options: {
        maxIterations: 50, tolerance: 0, stepTolerance: 0,
        shouldCancel: () => { calls += 1; return calls > 3; },
      },
    });
    return {
      pass: fit.cancelled === true && fit.iterations === 3,
      detail: JSON.stringify({ cancelled: fit.cancelled, iterations: fit.iterations, calls }),
    };
  });

  run('LM: onProgress fires once per iteration with increasing iteration numbers and a finite sse', () => {
    const events = [];
    lm.runLevenbergMarquardt({
      initialParameters: [0],
      freeIndices: [0],
      residualFn: ([value]) => [value - 100],
      options: { maxIterations: 50, onProgress: (event) => events.push(event) },
    });
    const strictlyIncreasing = events.every((event, index) =>
      index === 0 || event.iteration > events[index - 1].iteration
    );
    return {
      pass: events.length > 0
        && strictlyIncreasing
        && events.every((event) => Number.isFinite(event.sse) && Number.isFinite(event.maxIterations)),
      detail: JSON.stringify(events),
    };
  });

  run('LM: exhausted iteration budget is distinguished from convergence', () => {
    const fit = lm.runLevenbergMarquardt({
      initialParameters: [0],
      freeIndices: [0],
      residualFn: ([value]) => [value - 100],
      options: { maxIterations: 1, tolerance: 0, stepTolerance: 0 },
    });
    return {
      pass: !fit.converged && fit.maxIterationsReached && fit.iterations === 1,
      detail: JSON.stringify({ converged: fit.converged, max: fit.maxIterationsReached, iterations: fit.iterations }),
    };
  });

  run('LM: invalid free-parameter indexes fail before fitting', () => {
    const failed = throws(() => lm.buildFiniteDiffJacobian({
      parameters: [1],
      baseResiduals: [1],
      freeIndices: [2],
      residualFn: ([value]) => [value],
    }), /out of range/);
    return { pass: failed, detail: `failed=${failed}` };
  });

  // ---- DJF component functions ------------------------------------------
  run('components: Gaussian peaks reject invalid widths and amplitudes', () => {
    const center = components.gaussianPeak(10, 10, 2, 100);
    const invalidWidth = components.gaussianPeak(10, 10, 0, 100);
    const invalidAmplitude = components.gaussianPeak(10, 10, 2, -1);
    return {
      pass: center === 100 && invalidWidth === 0 && invalidAmplitude === 0,
      detail: JSON.stringify({ center, invalidWidth, invalidAmplitude }),
    };
  });

  run('components: S bridge tapers to zero and reaches its center coefficient', () => {
    const left = components.evaluateSBridge(10, 10, 20, 5, 5, 5);
    const center = components.evaluateSBridge(15, 10, 20, 5, 5, 5);
    const right = components.evaluateSBridge(20, 10, 20, 5, 5, 5);
    return { pass: left === 0 && center === 5 && right === 0, detail: `${left}, ${center}, ${right}` };
  });

  run('components: base total equals G1 plus S plus G2 at every x', () => {
    const parameters = [10, 2, 1, 2, 100, 50, 5, 6, 7];
    const model = components.evaluateBaseModel([8, 10, 12, 15, 20, 22], parameters);
    const maximumError = Math.max(...model.fitted.map((value, index) =>
      Math.abs(value - model.g1[index] - model.s[index] - model.g2[index])
    ));
    return {
      pass: maximumError < 1e-12
        && model.g1.length === 6 && model.s.length === 6 && model.g2.length === 6,
      detail: `maximumError=${maximumError}`,
    };
  });

  // ---- Pipeline state and compacted-view helpers ------------------------
  run('pipeline state: combine_masks supports nested inputs and rejects length mismatch', () => {
    const combined = state.combine_masks([
      Uint8Array.from([1, 1, 0]),
      null,
      Uint8Array.from([1, 0, 1]),
    ]);
    const mismatch = throws(() => state.combine_masks(
      Uint8Array.from([1, 1]),
      Uint8Array.from([1]),
    ), /length mismatch/);
    return {
      pass: Array.from(combined).join('') === '100' && state.combine_masks(null) === null && mismatch,
      detail: JSON.stringify({ combined: Array.from(combined), mismatch }),
    };
  });

  run('pipeline state: all-pass masks validate event counts', () => {
    const mask = state.all_pass_mask(4);
    const negative = throws(() => state.all_pass_mask(-1), /Invalid event count/);
    const fractional = throws(() => state.all_pass_mask(2.5), /Invalid event count/);
    return {
      pass: mask instanceof Uint8Array && Array.from(mask).join('') === '1111' && negative && fractional,
      detail: JSON.stringify({ mask: Array.from(mask), negative, fractional }),
    };
  });

  run('pipeline state: state is reused only for the same row identity and channel', () => {
    const row = {
      id: 'state-row-a', name: 'shared-state-reuse',
      data: { channel_key: 'DNA-A', eventCount: 3 },
    };
    state.clear_state(row.name);
    const first = state.get_or_create_state(row);
    first.baseFit = { marker: true };
    const reused = state.get_or_create_state(row);
    const replacementRow = {
      id: 'state-row-b', name: row.name,
      data: { channel_key: 'DNA-A', eventCount: 3 },
    };
    const replaced = state.get_or_create_state(replacementRow);
    return {
      pass: reused === first && replaced !== first && replaced.baseFit === null
        && state.state_matches_row(replaced, replacementRow),
      detail: JSON.stringify({ reused: reused === first, replaced: replaced !== first }),
    };
  });

  run('pipeline state: set_stage_mask builds an index-preserving compacted view', () => {
    const row = {
      id: 'filtered-row', name: 'filtered-view-unit',
      data: {
        channel_key: 'DNA-A', eventCount: 4,
        channels: {
          DNA_A: Float64Array.from([10, 20, 30, 40]),
          DNA_H: Float64Array.from([1, 2, 3, 4]),
          DNA_W: null, FSC_A: null, SSC_A: null,
          Time: Float64Array.from([0, 1, 2, 3]),
        },
        masks: {},
      },
    };
    state.set_stage_mask(row, 0, Uint8Array.from([1, 0, 1, 0]));
    const filtered = row.data.filtered;
    return {
      pass: Array.from(row.data.masks.final).join('') === '1010'
        && filtered.eventCount === 2
        && Array.from(filtered.originalIndex).join(',') === '0,2'
        && Array.from(filtered.channels.DNA_A).join(',') === '10,30'
        && Array.from(filtered.channels.DNA_H).join(',') === '1,3'
        && filtered.channels.DNA_W === null,
      detail: JSON.stringify({
        final: Array.from(row.data.masks.final),
        indexes: Array.from(filtered.originalIndex),
        dna: Array.from(filtered.channels.DNA_A),
      }),
    };
  });

  run('pipeline state: combined_mask_before includes only earlier masks', () => {
    const row = {
      data: {
        eventCount: 4,
        masks: {
          structural: Uint8Array.from([1, 1, 0, 1]),
          timeQC: Uint8Array.from([1, 0, 1, 1]),
          scatter: Uint8Array.from([0, 1, 1, 1]),
          singlet: Uint8Array.from([1, 1, 1, 0]),
        },
      },
    };
    const masks = Array.from({ length: 5 }, (_, stageNumber) =>
      Array.from(state.combined_mask_before(row, stageNumber)).join('')
    );
    return {
      pass: masks.join('|') === '1111|1101|1001|0001|0000',
      detail: masks.join('|'),
    };
  });

  run('pipeline state: invalidation clears downstream masks, products, and filtered view', () => {
    const row = {
      id: 'invalidate-row', name: 'invalidate-shared-unit',
      data: {
        channel_key: 'DNA-A', eventCount: 4,
        channels: {
          DNA_A: Float64Array.from([1, 2, 3, 4]),
          DNA_H: null, DNA_W: null, FSC_A: null, SSC_A: null, Time: null,
        },
        masks: {
          structural: Uint8Array.from([1, 1, 1, 0]),
          timeQC: Uint8Array.from([1, 0, 1, 1]),
          scatter: Uint8Array.from([0, 1, 1, 1]),
          singlet: Uint8Array.from([1, 1, 0, 1]),
          final: null,
        },
      },
    };
    const pipelineState = state.get_or_create_state(row);
    Object.assign(pipelineState, {
      scatterGate: { marker: true }, singletResult: { marker: true },
      histogram: { marker: true }, peaks: { marker: true }, baseFit: { marker: true },
      extendedFit: { marker: true }, report: { marker: true },
    });
    state.invalidate_after(row, pipelineState, 1);
    return {
      pass: row.data.masks.scatter === null && row.data.masks.singlet === null
        && Array.from(row.data.masks.final).join('') === '1010'
        && Array.from(row.data.filtered.originalIndex).join(',') === '0,2'
        && pipelineState.scatterGate === null && pipelineState.singletResult === null
        && pipelineState.histogram === null && pipelineState.report === null
        && pipelineState.lastStageRun === 1,
      detail: JSON.stringify({
        final: Array.from(row.data.masks.final),
        indexes: Array.from(row.data.filtered.originalIndex),
        lastStageRun: pipelineState.lastStageRun,
      }),
    };
  });

  run('pipeline state: a fresh state has the default model-neutral modeling shape', () => {
    const row = { id: 'modeling-default-row', name: 'modeling-default-unit', data: { eventCount: 1 } };
    const pipelineState = state.get_or_create_state(row);
    const m = pipelineState.modeling;
    return {
      pass: m.schemaVersion === 1
        && m.peakDetection.detectorId === 'multiscale_v1'
        && m.peakDetection.status === null
        && Array.isArray(m.peakDetection.candidates) && m.peakDetection.candidates.length === 0
        && m.peakSelection.source === 'automatic'
        && m.peakSelection.stale === false
        && m.settings.modelId === 'auto_dj_djf'
        && m.settings.ratioMode === 'bounded'
        && Object.keys(m.resultsByKey).length === 0
        && m.activeResultKey === null
        && m.revision === 0,
      detail: JSON.stringify(m),
    };
  });

  run('pipeline state: invalidate_histogram_dependents marks regions stale, clears fits, preserves them', () => {
    const row = { id: 'inv-hist-row', name: 'inv-hist-unit', data: { eventCount: 1 } };
    const pipelineState = state.get_or_create_state(row);
    const m = pipelineState.modeling;
    m.peakSelection.regions = { g1: [1, 2], g2: [3, 4] };
    m.peakSelection.source = 'manual';
    m.resultsByKey = { 'dean_jett|fp1': { modelId: 'dean_jett' } };
    m.activeResultKey = 'dean_jett|fp1';
    m.modelComparison = { winner: 'dean_jett' };

    state.invalidate_histogram_dependents(pipelineState, 'histogram rebuilt');

    return {
      pass: m.peakSelection.stale === true
        && m.peakSelection.regions.g1[0] === 1 // preserved, not wiped
        && m.peakSelection.source === 'manual' // preserved
        && Object.keys(m.resultsByKey).length === 0
        && m.activeResultKey === null
        && m.modelComparison === null
        && m.lastInvalidationReason === 'histogram rebuilt'
        && m.revision === 1,
      detail: JSON.stringify(m),
    };
  });

  run('pipeline state: invalidate_model_results clears every cached fit without touching regions', () => {
    const row = { id: 'inv-results-row', name: 'inv-results-unit', data: { eventCount: 1 } };
    const pipelineState = state.get_or_create_state(row);
    const m = pipelineState.modeling;
    m.peakSelection.regions = { g1: [1, 2], g2: [3, 4] };
    m.resultsByKey = { a: { modelId: 'dean_jett' }, b: { modelId: 'watson_pragmatic' } };
    m.activeResultKey = 'a';

    state.invalidate_model_results(pipelineState, 'regions accepted');

    return {
      pass: Object.keys(m.resultsByKey).length === 0
        && m.activeResultKey === null
        && m.peakSelection.regions.g1[0] === 1 // untouched
        && m.peakSelection.stale === false // untouched
        && m.lastInvalidationReason === 'regions accepted',
      detail: JSON.stringify(m),
    };
  });

  run('pipeline state: invalidate_model_config_result removes only the matching model\'s cached fits', () => {
    const row = { id: 'inv-config-row', name: 'inv-config-unit', data: { eventCount: 1 } };
    const pipelineState = state.get_or_create_state(row);
    const m = pipelineState.modeling;
    m.resultsByKey = {
      'dean_jett|fp1': { modelId: 'dean_jett' },
      'dean_jett|fp2': { modelId: 'dean_jett' },
      'watson_pragmatic|fp1': { modelId: 'watson_pragmatic' },
    };
    m.activeResultKey = 'dean_jett|fp1';

    state.invalidate_model_config_result(pipelineState, 'dean_jett', 'ratio constraint changed');

    return {
      pass: Object.keys(m.resultsByKey).join(',') === 'watson_pragmatic|fp1'
        && m.activeResultKey === null // was pointing at a removed key
        && m.lastInvalidationReason === 'ratio constraint changed',
      detail: JSON.stringify(m),
    };
  });

  run('pipeline summary: filter losses form a sequential funnel and fractions become percentages', () => {
    const row = {
      id: 'summary-row', name: 'pipeline-summary-unit',
      data: {
        channel_key: 'DNA-A', eventCount: 5,
        channels: { DNA_A: Float64Array.from([1, 2, 3, 4, 5]) },
        masks: {
          structural: Uint8Array.from([1, 1, 1, 1, 0]),
          timeQC: Uint8Array.from([1, 0, 1, 1, 1]),
          scatter: null,
          singlet: Uint8Array.from([1, 1, 0, 1, 1]),
        },
      },
    };
    state.clear_state(row.name);
    const pipelineState = state.get_or_create_state(row);
    pipelineState.report = {
      fractions: { biologicalSinglets: { oneC: 0.5, sPhase: 0.25, twoC: 0.25 } },
    };
    const summary = pipeline.pipeline_table_stats(row);
    return {
      pass: summary.filters.map((filter) => filter.entered).join(',') === '5,4,3,3'
        && summary.filters.map((filter) => filter.lost).join(',') === '1,1,0,1'
        && summary.filters[2].skipped
        && summary.fractions.g1 === 50 && summary.fractions.s === 25 && summary.fractions.g2 === 25,
      detail: JSON.stringify(summary),
    };
  });

  return results;
}"""


def run_djf_shared_tests(ctx: TestContext):
    """Run shared-helper assertions and record every result separately."""

    try:
        all_results = ctx.page.evaluate(_SHARED_HELPERS)
    except Exception as err:
        ctx.check(
            GROUP,
            "shared-helper suite setup",
            False,
            str(err),
            screenshot=False,
        )
        return

    for item in all_results:
        ctx.check(
            GROUP,
            item["name"],
            item["pass"],
            item.get("detail", ""),
            screenshot=False,
        )
