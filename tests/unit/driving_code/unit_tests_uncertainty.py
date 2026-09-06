#!/usr/bin/env python3
"""Browser unit coverage for js/analysis/cell_cycle/uncertainty.js (UNC-01).

The register's blocker is that a fitted percentage was published as a bare
point estimate with nothing saying how much of it the data determined. This
suite pins the two halves of the answer:

  * the covariance really is (J'J)^-1 -- the Poisson dispersion is KNOWN, so
    there is no residual-variance factor to estimate, and a test that only
    checked "the numbers look plausible" would not notice one being silently
    multiplied in. The scaling test below makes that structural: scale J by k
    and every standard error must move by exactly 1/k.

  * a fit that did NOT determine its parameters says so. The rank-deficient
    fixture is the important one: the Moore-Penrose pseudo-inverse returns
    perfectly finite, perfectly innocent-looking standard errors on a singular
    J'J, so the rank flag -- not the standard error -- is what carries the
    warning, and that is asserted directly.

The delta-method tests use functions whose gradient is known in closed form,
so they check the propagation arithmetic rather than re-deriving it with the
same finite differences the implementation uses.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / Cell Cycle Uncertainty"


_UNCERTAINTY_TESTS = r"""() => {
  const {
    parameterUncertainty, deltaMethodInterval, phaseFractionIntervals,
    multistartAgreement, identifiabilityWarnings,
    RANK_TOLERANCE, CONDITION_WARNING_THRESHOLD, CORRELATION_WARNING_THRESHOLD,
    EQUIVALENT_DEVIANCE_WINDOW, OPTIMUM_SEPARATION_TOLERANCE,
  } = window.CellCycleUncertainty;
  const { estimateJacobianCondition } = window.DJFShared.lm;
  const { register_default_models, get_model } = window.CellCycleModelRegistry;
  const { peakComponents, convolvedSPhase } = window.CellCycleModelShared;

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
  const close = (left, right, tolerance) => Math.abs(left - right) <= tolerance;
  const NORMAL_95 = 1.959963984540054;

  // ---- fixture: orthogonal columns, so (J'J)^-1 is exact by hand ----------
  // J'J = diag(2, 8) -> covariance diag(0.5, 0.125), zero correlation.
  const ORTHOGONAL = [[1, 0], [0, 2], [1, 0], [0, 2]];

  run('UNC-01: covariance is (J\'J)^-1 with no dispersion factor', () => {
    const u = parameterUncertainty({ jacobian: ORTHOGONAL, freeIndices: [0, 3] });
    return {
      pass: close(u.covariance[0][0], 0.5, 1e-12)
        && close(u.covariance[1][1], 0.125, 1e-12)
        && close(u.covariance[0][1], 0, 1e-12)
        && close(u.standardErrors[0], Math.sqrt(0.5), 1e-12)
        && close(u.standardErrors[1], Math.sqrt(0.125), 1e-12),
      detail: `cov=${JSON.stringify(u.covariance)} se=${JSON.stringify(u.standardErrors)}`,
    };
  });

  run('UNC-01: standard errors scale as 1/k when the Jacobian scales by k', () => {
    // The one assertion that would catch a dispersion/residual-variance factor
    // sneaking in: (J'J)^-1 is exactly quadratic in the Jacobian scale, and
    // nothing else the module could plausibly compute is.
    const base = parameterUncertainty({ jacobian: ORTHOGONAL, freeIndices: [0, 3] });
    const scaled = parameterUncertainty({
      jacobian: ORTHOGONAL.map((row) => row.map((value) => 5 * value)),
      freeIndices: [0, 3],
    });
    const ratios = base.standardErrors.map((se, i) => se / scaled.standardErrors[i]);
    return {
      pass: ratios.every((ratio) => close(ratio, 5, 1e-9)),
      detail: `se ratios base/scaled = ${JSON.stringify(ratios)} (expected 5)`,
    };
  });

  run('UNC-01: the correlation matrix is unit-diagonal, symmetric, and bounded', () => {
    const jacobian = [[1, 0.4, 0.1], [0.2, 1, 0.3], [0.5, 0.1, 1], [0.3, 0.7, 0.2], [1, 1, 0.5]];
    const u = parameterUncertainty({ jacobian, freeIndices: [0, 1, 2] });
    const diagonalOk = u.correlations.every((row, i) => close(row[i], 1, 1e-12));
    const symmetricOk = u.correlations.every((row, i) => row.every((value, j) =>
      close(value, u.correlations[j][i], 1e-12)));
    const boundedOk = u.correlations.every((row) => row.every((value) => Math.abs(value) <= 1));
    return {
      pass: diagonalOk && symmetricOk && boundedOk,
      detail: `diag=${diagonalOk} sym=${symmetricOk} bounded=${boundedOk} rho=${JSON.stringify(u.correlations)}`,
    };
  });

  run('UNC-01: the condition number agrees with the solver\'s own estimate', () => {
    // uncertainty.js and lm_solver.js must not be able to disagree about
    // whether a fit was identified, so they share one eigen-decomposition.
    const jacobian = [[1, 0.4, 0.1], [0.2, 1, 0.3], [0.5, 0.1, 1], [0.3, 0.7, 0.2], [1, 1, 0.5]];
    const u = parameterUncertainty({ jacobian, freeIndices: [0, 1, 2] });
    const solver = estimateJacobianCondition(jacobian);
    return {
      pass: close(u.conditionNumber, solver, 1e-9 * Math.max(solver, 1)),
      detail: `uncertainty=${u.conditionNumber} lm_solver=${solver}`,
    };
  });

  // ---- rank deficiency: columns 0 and 2 are identical ----------------------
  const SINGULAR = [[1, 0, 1], [0, 1, 0], [1, 0, 1], [0, 1, 0]];

  run('UNC-01: a duplicated Jacobian column is reported as rank deficiency', () => {
    const u = parameterUncertainty({
      jacobian: SINGULAR, freeIndices: [0, 1, 2],
      parameterNames: ['sArea', 'g1CV', 'sAreaTwin'],
    });
    return {
      pass: u.rank === 2 && u.parameterCount === 3 && u.rankDeficiency === 1
        && u.weaklyIdentified === true && !Number.isFinite(u.conditionNumber),
      detail: `rank=${u.rank}/${u.parameterCount} deficiency=${u.rankDeficiency} `
        + `cond=${u.conditionNumber} weak=${u.weaklyIdentified}`,
    };
  });

  run('UNC-01: the unidentified direction names the parameters it confounds', () => {
    const u = parameterUncertainty({
      jacobian: SINGULAR, freeIndices: [0, 1, 2],
      parameterNames: ['sArea', 'g1CV', 'sAreaTwin'],
    });
    const direction = u.nullSpaceDirections[0];
    const named = (direction?.loadings ?? []).map((l) => l.parameter).sort();
    return {
      pass: u.nullSpaceDirections.length === 1
        && named.length === 2 && named[0] === 'sArea' && named[1] === 'sAreaTwin'
        && close(direction.eigenvalue, 0, 1e-9),
      detail: `directions=${u.nullSpaceDirections.length} loadings=${JSON.stringify(direction?.loadings)}`,
    };
  });

  run('UNC-01: rank deficiency is carried by the flag, not by an infinite SE', () => {
    // The pseudo-inverse deliberately returns the covariance of the IDENTIFIED
    // subspace, so a singular fit still produces small, plausible-looking
    // standard errors. If a consumer ever starts trusting `standardErrors`
    // alone to reveal an unidentified fit, this is the test that says why it
    // cannot: every SE here is finite and modest despite rank 2 of 3.
    const u = parameterUncertainty({ jacobian: SINGULAR, freeIndices: [0, 1, 2] });
    return {
      pass: u.standardErrors.every((se) => Number.isFinite(se) && se < 1)
        && u.rank < u.parameterCount,
      detail: `se=${JSON.stringify(u.standardErrors)} rank=${u.rank}/${u.parameterCount}`,
    };
  });

  run('UNC-01: near-collinear columns are reported as a high correlation', () => {
    const jacobian = [[1, 1], [1, 1.0001], [1, 1], [1, 1.0001]];
    const u = parameterUncertainty({
      jacobian, freeIndices: [6, 7], parameterNames: ['sArea', 'shape1'],
    });
    const pair = u.highCorrelations[0];
    return {
      pass: u.rank === 2 && u.highCorrelations.length === 1
        && Math.abs(pair.correlation) >= CORRELATION_WARNING_THRESHOLD
        && pair.a === 'sArea' && pair.b === 'shape1',
      detail: `rank=${u.rank} rho=${pair && pair.correlation} pairs=${u.highCorrelations.length}`,
    };
  });

  run('UNC-01: free indices label the rows when no names are supplied', () => {
    const u = parameterUncertainty({ jacobian: ORTHOGONAL, freeIndices: [6, 8] });
    return {
      pass: u.parameterNames[0] === 'theta[6]' && u.parameterNames[1] === 'theta[8]'
        && u.freeIndices[0] === 6 && u.freeIndices[1] === 8,
      detail: JSON.stringify(u.parameterNames),
    };
  });

  run('UNC-01: a Jacobian whose width disagrees with freeIndices is rejected', () => {
    let threw = null;
    try {
      parameterUncertainty({ jacobian: ORTHOGONAL, freeIndices: [0, 1, 2] });
    } catch (error) { threw = error; }
    let threwEmpty = null;
    try { parameterUncertainty({ jacobian: [], freeIndices: [] }); } catch (error) { threwEmpty = error; }
    return {
      pass: threw instanceof RangeError && threwEmpty instanceof TypeError,
      detail: `width=${threw && threw.name} empty=${threwEmpty && threwEmpty.name}`,
    };
  });

  // ---- delta method --------------------------------------------------------
  run('UNC-01: the delta method reproduces a closed-form linear variance', () => {
    // g(theta) = 3*theta[0] - 2*theta[1] with C = diag(0.5, 0.125):
    // Var = 9*0.5 + 4*0.125 = 5.
    const interval = deltaMethodInterval({
      fn: (theta) => 3 * theta[0] - 2 * theta[1],
      parameters: [2, 7],
      covariance: [[0.5, 0], [0, 0.125]],
      freeIndices: [0, 1],
    });
    return {
      pass: close(interval.value, -8, 1e-12)
        && close(interval.gradient[0], 3, 1e-6) && close(interval.gradient[1], -2, 1e-6)
        && close(interval.standardError, Math.sqrt(5), 1e-6)
        && close(interval.upper - interval.lower, 2 * NORMAL_95 * Math.sqrt(5), 1e-6),
      detail: `value=${interval.value} se=${interval.standardError} grad=${JSON.stringify(interval.gradient)}`,
    };
  });

  run('UNC-01: the delta method carries off-diagonal covariance', () => {
    // A correlated pair is the whole reason a fraction interval is not just
    // the areas' errors added in quadrature: Var = g'Cg with C[0][1] != 0.
    const covariance = [[1, 0.8], [0.8, 1]];
    const interval = deltaMethodInterval({
      fn: (theta) => theta[0] + theta[1],
      parameters: [10, 10], covariance, freeIndices: [0, 1],
    });
    return {
      pass: close(interval.standardError, Math.sqrt(1 + 1 + 2 * 0.8), 1e-6),
      detail: `se=${interval.standardError} expected=${Math.sqrt(3.6)}`,
    };
  });

  // ---- phase fractions -----------------------------------------------------
  const AREAS = [6000, 3000, 1000];          // g1, s, g2 -> 0.6 / 0.3 / 0.1
  const AREA_INDICES = { g1: 0, s: 1, g2: 2 };
  const POISSONISH = [[1e4, 0, 0], [0, 1e4, 0], [0, 0, 1e4]];

  run('UNC-01: phase-fraction point estimates sum to one', () => {
    const intervals = phaseFractionIntervals({
      parameters: AREAS, covariance: POISSONISH, freeIndices: [0, 1, 2],
      areaIndices: AREA_INDICES,
    });
    const total = intervals.g1.value + intervals.s.value + intervals.g2.value;
    return {
      pass: close(total, 1, 1e-12) && close(intervals.g1.value, 0.6, 1e-12),
      detail: `g1=${intervals.g1.value} s=${intervals.s.value} g2=${intervals.g2.value} sum=${total}`,
    };
  });

  run('UNC-01: a fraction\'s interval matches the hand-computed ratio gradient', () => {
    // dp_g1/dA_g1 = (T - A_g1)/T^2 = 4e-5; dp_g1/dA_s = dp_g1/dA_g2 = -6e-5.
    // Var = 1e4*(4e-5^2 + 6e-5^2 + 6e-5^2) = 8.8e-5.
    const intervals = phaseFractionIntervals({
      parameters: AREAS, covariance: POISSONISH, freeIndices: [0, 1, 2],
      areaIndices: AREA_INDICES,
    });
    const expected = Math.sqrt(8.8e-5);
    return {
      pass: close(intervals.g1.standardError, expected, 1e-9)
        && intervals.g1.clipped === false
        && intervals.g1.lower < 0.6 && intervals.g1.upper > 0.6,
      detail: `se=${intervals.g1.standardError} expected=${expected} `
        + `[${intervals.g1.lower}, ${intervals.g1.upper}]`,
    };
  });

  run('UNC-01: an interval that leaves [0, 1] is truncated and says so', () => {
    const huge = [[1e10, 0, 0], [0, 1e10, 0], [0, 0, 1e10]];
    const intervals = phaseFractionIntervals({
      parameters: AREAS, covariance: huge, freeIndices: [0, 1, 2], areaIndices: AREA_INDICES,
    });
    const everyPhase = ['g1', 's', 'g2'].every((phase) =>
      intervals[phase].clipped === true
      && intervals[phase].lower >= 0 && intervals[phase].upper <= 1);
    return {
      pass: everyPhase,
      detail: ['g1', 's', 'g2'].map((phase) =>
        `${phase}=[${intervals[phase].lower.toFixed(3)},${intervals[phase].upper.toFixed(3)}] `
        + `clipped=${intervals[phase].clipped}`).join(' '),
    };
  });

  run('UNC-01: a frozen area contributes no width to the fractions', () => {
    // Dean-Jett-Fox freezes the peaks, so g1Area/g2Area are not free and their
    // columns are absent from the covariance. The fraction interval must then
    // reflect the S area alone rather than silently assuming the frozen areas
    // are also uncertain.
    const intervals = phaseFractionIntervals({
      parameters: AREAS, covariance: [[1e4]], freeIndices: [1], areaIndices: AREA_INDICES,
    });
    // dp_s/dA_s = (T - A_s)/T^2 = 7000/1e8 = 7e-5 -> se = sqrt(1e4)*7e-5.
    const expected = 100 * 7e-5;
    return {
      pass: close(intervals.s.standardError, expected, 1e-9)
        && intervals.s.standardError > 0,
      detail: `s se=${intervals.s.standardError} expected=${expected}`,
    };
  });

  // ---- warning vocabulary --------------------------------------------------
  run('UNC-01: a rank-deficient fit is flagged nonreportable', () => {
    const u = parameterUncertainty({
      jacobian: SINGULAR, freeIndices: [0, 1, 2],
      parameterNames: ['sArea', 'g1CV', 'sAreaTwin'],
    });
    const warnings = identifiabilityWarnings(u, null);
    const rank = warnings.find((warning) => warning.id === 'rank_deficient');
    return {
      pass: Boolean(rank) && rank.nonreportable === true && rank.severity === 'critical'
        && rank.message.includes('sArea')
        // rank deficiency SUBSUMES ill conditioning -- reporting both would be
        // two warnings for one cause.
        && !warnings.some((warning) => warning.id === 'ill_conditioned'),
      detail: warnings.map((warning) => warning.id).join(',') + ' | ' + (rank && rank.message),
    };
  });

  run('UNC-01: the ill-conditioning band between the thresholds is not empty', () => {
    // The invariant that makes the ill_conditioned warning reachable at all.
    // Forming J'J squares the condition number, so the rank cut on eigenvalue
    // ratios implies a condition-number cut of 1/sqrt(RANK_TOLERANCE); a
    // warning threshold at or above that would classify every ill-conditioned
    // fit as rank deficient first and the branch would be dead code. That is
    // exactly the state the module was in before this test existed.
    const rankImpliedCondition = 1 / Math.sqrt(RANK_TOLERANCE);
    return {
      pass: CONDITION_WARNING_THRESHOLD < rankImpliedCondition,
      detail: `warn at ${CONDITION_WARNING_THRESHOLD.toExponential(0)}, `
        + `rank cut implies ${rankImpliedCondition.toExponential(0)}`,
    };
  });

  run('UNC-01: a full-rank but ill-conditioned fit is qualified, not blocked', () => {
    // J'J = diag(1, 9e-14): the eigenvalue ratio clears the 1e-14 rank cut, so
    // both directions are resolvable, but the condition number 3.3e6 is past
    // the warning threshold. These intervals have lost digits, not meaning.
    const jacobian = [[1, 0], [0, 3e-7]];
    const u = parameterUncertainty({ jacobian, freeIndices: [0, 1] });
    const warnings = identifiabilityWarnings(u, null);
    const conditioning = warnings.find((warning) => warning.id === 'ill_conditioned');
    return {
      pass: u.rank === 2 && u.rankDeficiency === 0
        && u.conditionNumber > CONDITION_WARNING_THRESHOLD
        && Boolean(conditioning) && conditioning.nonreportable === false
        && conditioning.severity === 'warning'
        && !warnings.some((warning) => warning.id === 'rank_deficient')
        && u.weaklyIdentified === true,
      detail: `rank=${u.rank} cond=${u.conditionNumber.toExponential(2)} `
        + `ids=${warnings.map((w) => w.id).join(',')}`,
    };
  });

  run('UNC-01: correlated parameters are a qualification, not a block', () => {
    const jacobian = [[1, 1], [1, 1.0001], [1, 1], [1, 1.0001]];
    const u = parameterUncertainty({
      jacobian, freeIndices: [6, 7], parameterNames: ['sArea', 'shape1'],
    });
    const warning = identifiabilityWarnings(u, null)
      .find((entry) => entry.id === 'parameter_correlation');
    return {
      pass: Boolean(warning) && warning.nonreportable === false && warning.severity === 'warning',
      detail: warning && warning.message,
    };
  });

  run('UNC-01: a fraction wider than the reportability limit blocks reporting', () => {
    const intervals = phaseFractionIntervals({
      parameters: AREAS, covariance: [[4e6, 0, 0], [0, 4e6, 0], [0, 0, 4e6]],
      freeIndices: [0, 1, 2], areaIndices: AREA_INDICES,
    });
    const warnings = identifiabilityWarnings(
      parameterUncertainty({ jacobian: ORTHOGONAL, freeIndices: [0, 1] }),
      intervals,
    );
    const tooUncertain = warnings.filter((warning) => warning.id === 'fraction_too_uncertain');
    const tight = identifiabilityWarnings(
      parameterUncertainty({ jacobian: ORTHOGONAL, freeIndices: [0, 1] }),
      phaseFractionIntervals({
        parameters: AREAS, covariance: POISSONISH, freeIndices: [0, 1, 2],
        areaIndices: AREA_INDICES,
      }),
    );
    return {
      pass: tooUncertain.length > 0 && tooUncertain.every((warning) => warning.nonreportable === true)
        && tight.length === 0,
      detail: `wide=${warnings.map((w) => w.id).join(',')} tight=${tight.length}`,
    };
  });

  run('UNC-01: the reportability threshold is caller-configurable', () => {
    const intervals = phaseFractionIntervals({
      parameters: AREAS, covariance: POISSONISH, freeIndices: [0, 1, 2],
      areaIndices: AREA_INDICES,
    });
    const uncertainty = parameterUncertainty({ jacobian: ORTHOGONAL, freeIndices: [0, 1] });
    const strict = identifiabilityWarnings(uncertainty, intervals,
      { fractionUncertaintyThreshold: 1e-4 });
    const lenient = identifiabilityWarnings(uncertainty, intervals,
      { fractionUncertaintyThreshold: 0.5 });
    return {
      pass: strict.some((warning) => warning.id === 'fraction_too_uncertain')
        && !lenient.some((warning) => warning.id === 'fraction_too_uncertain'),
      detail: `strict=${strict.length} lenient=${lenient.length}`,
    };
  });

  // ---- multimodality from the multi-start audit trail ---------------------
  // The covariance is the curvature of ONE basin, so a second equally good
  // optimum is invisible to it. These fixtures stand in for fitPoissonModel's
  // `attempts` array.
  const attempt = (deviance, parameters, converged = true) => ({ deviance, parameters, converged });

  run('UNC-01: restarts that agree are not called multimodal', () => {
    const agreement = multistartAgreement([
      attempt(1000, [8000, 4000, 3000]),
      attempt(1000.2, [8001, 3999, 3000.5]),
      attempt(1000.1, [7999.5, 4000.2, 2999.8]),
    ], { freeIndices: [0, 1, 2], parameterNames: ['g1Area', 'sArea', 'g2Area'] });
    return {
      pass: agreement.comparable === true && agreement.multimodal === false
        && agreement.equivalentCount === 3 && agreement.trappedStarts === 0
        && agreement.separatedParameters.length === 0,
      detail: `equivalent=${agreement.equivalentCount} sep=${agreement.maximumSeparation.toExponential(1)} `
        + `multimodal=${agreement.multimodal}`,
    };
  });

  run('UNC-01: indistinguishable deviances with different parameters are multimodal', () => {
    // The canonical cell-cycle failure: S swallows a peak, the deviance is
    // essentially the same, and the phase fractions are completely different.
    const agreement = multistartAgreement([
      attempt(1000, [8000, 4000, 3000]),
      attempt(1001, [5000, 9000, 1000]),
    ], { freeIndices: [0, 1, 2], parameterNames: ['g1Area', 'sArea', 'g2Area'] });
    const worst = agreement.separatedParameters[0];
    return {
      pass: agreement.multimodal === true && agreement.equivalentCount === 2
        && worst.parameter === 'sArea'
        && agreement.maximumSeparation > OPTIMUM_SEPARATION_TOLERANCE,
      detail: `equivalent=${agreement.equivalentCount} worst=${worst && worst.parameter} `
        + `sep=${agreement.maximumSeparation.toFixed(3)}`,
    };
  });

  run('UNC-01: a restart in a worse basin is dispersion, not multimodality', () => {
    // A deviance gap wider than the chi-square(1) window means the other start
    // is simply a worse fit, not a rival explanation of the data.
    const agreement = multistartAgreement([
      attempt(1000, [8000, 4000, 3000]),
      attempt(1000 + 4 * EQUIVALENT_DEVIANCE_WINDOW, [5000, 9000, 1000]),
    ], { freeIndices: [0, 1, 2], parameterNames: ['g1Area', 'sArea', 'g2Area'] });
    return {
      pass: agreement.multimodal === false && agreement.trappedStarts === 1
        && agreement.equivalentCount === 1
        && close(agreement.devianceSpread, 4 * EQUIVALENT_DEVIANCE_WINDOW, 1e-9),
      detail: `trapped=${agreement.trappedStarts} spread=${agreement.devianceSpread.toFixed(2)} `
        + `multimodal=${agreement.multimodal}`,
    };
  });

  run('UNC-01: non-converged and single-start audit trails are not comparable', () => {
    const single = multistartAgreement([attempt(1000, [1, 2, 3])], { freeIndices: [0, 1, 2] });
    const none = multistartAgreement([
      attempt(1000, [1, 2, 3], false), attempt(1100, [9, 9, 9], false),
    ], { freeIndices: [0, 1, 2] });
    return {
      pass: single.comparable === false && single.multimodal === false
        && none.comparable === false && none.convergedCount === 0
        && multistartAgreement(undefined).comparable === false,
      detail: `single=${single.comparable} noneConverged=${none.convergedCount} `
        + `undefined=${multistartAgreement(undefined).comparable}`,
    };
  });

  run('UNC-01: a multimodal surface is nonreportable, dispersion is a warning', () => {
    const uncertainty = parameterUncertainty({ jacobian: ORTHOGONAL, freeIndices: [0, 1] });
    const multimodal = identifiabilityWarnings(uncertainty, null, {
      multistart: multistartAgreement([
        attempt(1000, [8000, 4000, 3000]), attempt(1001, [5000, 9000, 1000]),
      ], { freeIndices: [0, 1, 2], parameterNames: ['g1Area', 'sArea', 'g2Area'] }),
    });
    const dispersed = identifiabilityWarnings(uncertainty, null, {
      multistart: multistartAgreement([
        attempt(1000, [8000, 4000, 3000]),
        attempt(1100, [5000, 9000, 1000]),
      ], { freeIndices: [0, 1, 2], parameterNames: ['g1Area', 'sArea', 'g2Area'] }),
    });
    const one = multimodal.find((warning) => warning.id === 'multimodal_optimum');
    const two = dispersed.find((warning) => warning.id === 'restart_dispersion');
    return {
      pass: Boolean(one) && one.nonreportable === true && one.message.includes('sArea')
        && Boolean(two) && two.nonreportable === false
        // The two are mutually exclusive: a surface is either reporting rival
        // optima or reporting that some starts did worse, never labelled both.
        && !multimodal.some((warning) => warning.id === 'restart_dispersion')
        && !dispersed.some((warning) => warning.id === 'multimodal_optimum'),
      detail: `multimodal=${multimodal.map((w) => w.id).join(',')} `
        + `dispersed=${dispersed.map((w) => w.id).join(',')}`,
    };
  });

  // ---- boundary-dominated intervals ----------------------------------------
  run('UNC-01: a bound on an area parameter blocks reporting, a nuisance bound qualifies', () => {
    // An asymptotic interval assumes an interior optimum. A parameter pinned to
    // its bound has half its interval in space the fit could not enter -- and
    // when that parameter is one the fractions are built from, the fractions
    // inherit the problem.
    const uncertainty = parameterUncertainty({ jacobian: ORTHOGONAL, freeIndices: [0, 1] });
    const options = { fractionParameters: ['g1Area', 'sArea', 'g2Area'] };
    const structural = identifiabilityWarnings(uncertainty, null,
      { ...options, boundaryParameters: ['sArea'] })
      .find((warning) => warning.id === 'boundary_dominated');
    const nuisance = identifiabilityWarnings(uncertainty, null,
      { ...options, boundaryParameters: ['g2CV'] })
      .find((warning) => warning.id === 'boundary_dominated');
    return {
      pass: Boolean(structural) && structural.nonreportable === true
        && structural.severity === 'critical'
        && Boolean(nuisance) && nuisance.nonreportable === false
        && nuisance.severity === 'warning'
        && identifiabilityWarnings(uncertainty, null, options).length === 0,
      detail: `sArea nonreportable=${structural && structural.nonreportable} `
        + `g2CV nonreportable=${nuisance && nuisance.nonreportable}`,
    };
  });

  run('UNC-01: identifiabilityWarnings tolerates a missing bundle', () => ({
    pass: Array.isArray(identifiabilityWarnings(null)) && identifiabilityWarnings(null).length === 0,
    detail: JSON.stringify(identifiabilityWarnings(null)),
  }));

  run('UNC-01: the module publishes the thresholds it enforces', () => ({
    // A caller that wants to explain a flag in the UI needs the number the flag
    // was compared against; a private constant would force it to hard-code one.
    pass: RANK_TOLERANCE === 1e-14 && CONDITION_WARNING_THRESHOLD === 1e6
      && CORRELATION_WARNING_THRESHOLD === 0.99,
    detail: `rank=${RANK_TOLERANCE} cond=${CONDITION_WARNING_THRESHOLD} rho=${CORRELATION_WARNING_THRESHOLD}`,
  }));

  // ---- end to end through a real model fit ---------------------------------
  const edges = Array.from({ length: 301 }, (_, i) => i);
  const TRUE = {
    g1Area: 8000, g1Mean: 70, g1CV: 0.06,
    g2Area: 3000, g2Mean: 140, g2CV: 0.07,
    sArea: 4000, shape1: 0.5, shape2: -0.3,
  };
  const peaks = peakComponents(edges, TRUE);
  const sCounts = convolvedSPhase(edges, {
    sArea: TRUE.sArea, g1Mean: TRUE.g1Mean, g2Mean: TRUE.g2Mean,
    broadeningCV: TRUE.g1CV, shape1: TRUE.shape1, shape2: TRUE.shape2,
  }, 64);
  const counts = peaks.g1.map((value, i) => Math.round(value + sCounts[i] + peaks.g2[i]));
  const regions = { g1: { left: 55, right: 85 }, g2: { left: 120, right: 165 } };

  register_default_models();
  const fitted = (() => {
    const model = get_model('dean_jett');
    return model.normalizeResult(
      model.fit({ histogram: { edges, counts }, peakRegions: regions, config: {} }),
    );
  })();

  run('UNC-01: dean_jett publishes an uncertainty bundle on its result', () => {
    const u = fitted.uncertainty;
    return {
      pass: Boolean(u) && u.method === 'asymptotic_deviance_curvature'
        && u.intervalLevel === 0.95
        && Array.isArray(u.standardErrors) && u.standardErrors.length === u.parameterCount
        && u.parameterNames.length === u.parameterCount
        && u.parameterNames.every((name) => !name.startsWith('theta[')),
      detail: u ? `rank=${u.rank}/${u.parameterCount} names=${u.parameterNames.join(',')}` : 'no bundle',
    };
  });

  run('UNC-01: the published intervals bracket the published phase fractions', () => {
    const u = fitted.uncertainty;
    const ok = ['g1', 's', 'g2'].every((phase) => {
      const interval = u.phaseFractions[phase];
      return close(interval.value, fitted.phaseFractions[phase], 1e-9)
        && interval.lower <= interval.value + 1e-12
        && interval.upper >= interval.value - 1e-12;
    });
    return {
      pass: ok,
      detail: ['g1', 's', 'g2'].map((phase) =>
        `${phase}: ${(100 * u.phaseFractions[phase].value).toFixed(2)}% `
        + `[${(100 * u.phaseFractions[phase].lower).toFixed(2)}, `
        + `${(100 * u.phaseFractions[phase].upper).toFixed(2)}]`).join(' | '),
    };
  });

  run('UNC-01: a noiseless well-posed fit reports full rank and finite errors', () => {
    // If this ever goes rank deficient the model has a genuine parameterization
    // problem -- the fixture is generated by the model's own primitives, so the
    // data determines every free parameter by construction.
    const u = fitted.uncertainty;
    return {
      pass: u.rank === u.parameterCount && u.rankDeficiency === 0
        && Number.isFinite(u.conditionNumber)
        && u.standardErrors.every((se) => Number.isFinite(se) && se >= 0),
      detail: `rank=${u.rank}/${u.parameterCount} cond=${u.conditionNumber.toExponential(2)} `
        + `se=${u.standardErrors.map((se) => se.toPrecision(3)).join(',')}`,
    };
  });

  run('UNC-01: the published bundle carries the multi-start and boundary evidence', () => {
    // Not just the flags -- the evidence behind them, so a reader can see how
    // many restarts agreed and which bounds were active without re-running.
    const u = fitted.uncertainty;
    return {
      pass: Boolean(u.multistart) && typeof u.multistart.comparable === 'boolean'
        && u.multistart.convergedCount >= 1
        && Array.isArray(u.boundaryParameters),
      detail: `starts=${u.multistart.startCount} converged=${u.multistart.convergedCount} `
        + `equivalent=${u.multistart.equivalentCount} multimodal=${u.multistart.multimodal} `
        + `spread=${Number.isFinite(u.multistart.devianceSpread) ? u.multistart.devianceSpread.toFixed(2) : 'na'} `
        + `bounds=[${u.boundaryParameters.join(',')}]`,
    };
  });

  run('UNC-01: the model folds identifiability flags into its published warnings', () => {
    // The bundle's own warnings list is not enough: a consumer reading only
    // result.warnings must still see a nonreportable fit.
    const u = fitted.uncertainty;
    const missing = (u.warnings ?? []).filter((warning) => !(fitted.warnings ?? []).some((published) =>
      published.id === warning.id && published.message === warning.message
      && published.severity === warning.severity && published.nonreportable === warning.nonreportable));
    return {
      pass: Array.isArray(u.warnings) && missing.length === 0,
      detail: `bundle=${(u.warnings ?? []).map((w) => w.id).join(',') || 'none'} `
        + `missing from result.warnings=${missing.map((w) => w.id).join(',') || 'none'}`,
    };
  });

  return results;
}"""


def run_uncertainty_tests(ctx: TestContext):
    """Run the UNC-01 identifiability and interval assertions."""

    try:
        all_results = ctx.page.evaluate(_UNCERTAINTY_TESTS)
    except Exception as err:
        ctx.check(
            GROUP,
            "uncertainty suite setup",
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
