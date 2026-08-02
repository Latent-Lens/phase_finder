#!/usr/bin/env python3
"""STAT-01 regression coverage: structured rejection of invalid Poisson inputs
(js/analysis/math/poisson.js) and the constraint audit
(js/analysis/cell_cycle/constraint_audit.js).

The audit half deliberately triggers EACH configured bound and joint constraint
one at a time -- CV, mean, area, wave, profile, ratio (bounded and locked), and
the fraction-feasibility conditions -- so every warning the audit can emit has a
test that fires it, rather than only proving the common case stays silent."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / STAT-01 Poisson Inputs & Constraint Audit"


_STAT_TESTS = r"""() => {
  const poisson = window.CellCyclePoisson;
  const audit = window.CellCycleConstraintAudit;
  const { sPhaseProfileMinimum } = window.CellCycleModelShared;

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

  // Captures the thrown error so the test can assert on its structure, not just
  // that "something threw".
  const capture = (callback) => {
    try {
      callback();
      return null;
    } catch (error) {
      return error;
    }
  };

  const OBSERVED = [4, 9, 16, 9, 4];
  const EXPECTED = [4.1, 8.8, 15.9, 9.2, 3.9];

  // ---- STAT-01 box 1: reject invalid Poisson inputs ----------------------

  const STATISTICS = [
    ['poissonLogLikelihood', poisson.poissonLogLikelihood],
    ['poissonNll', poisson.poissonNll],
    ['poissonDeviance', poisson.poissonDeviance],
    ['pearsonResiduals', poisson.pearsonResiduals],
    ['poissonDevianceResiduals', poisson.poissonDevianceResiduals],
  ];

  run('every Poisson statistic accepts a valid observed/expected pair', () => {
    const bad = STATISTICS.filter(([, fn]) => {
      const value = fn(OBSERVED, EXPECTED);
      return Array.isArray(value)
        ? value.length !== OBSERVED.length || value.some((entry) => !Number.isFinite(entry))
        : !Number.isFinite(value);
    });
    return { pass: bad.length === 0, detail: JSON.stringify(bad.map(([name]) => name)) };
  });

  run('a negative OBSERVED count is rejected by every Poisson statistic with a structured error', () => {
    const observed = [4, -1, 16, 9, 4];
    const failures = [];
    for (const [name, fn] of STATISTICS) {
      const error = capture(() => fn(observed, EXPECTED));
      const ok = error
        && error.code === poisson.POISSON_INPUT_INVALID
        && error.detail?.role === 'Observed'
        && error.detail?.reason === 'negative'
        && error.detail?.index === 1
        && error.detail?.value === -1;
      if (!ok) failures.push(`${name}:${error ? JSON.stringify(error.detail) : 'no throw'}`);
    }
    return { pass: failures.length === 0, detail: JSON.stringify(failures) };
  });

  run('a non-finite OBSERVED count is rejected with the offending bin index', () => {
    const error = capture(() => poisson.poissonDeviance([4, NaN, 16], [4, 9, 16]));
    return {
      pass: error?.code === poisson.POISSON_INPUT_INVALID
        && error.detail.role === 'Observed'
        && error.detail.reason === 'nonfinite'
        && error.detail.index === 1,
      detail: JSON.stringify(error?.detail ?? null),
    };
  });

  run('a materially negative EXPECTED count is rejected rather than silently clamped', () => {
    const failures = [];
    for (const [name, fn] of STATISTICS) {
      const error = capture(() => fn(OBSERVED, [4.1, -0.5, 15.9, 9.2, 3.9]));
      const ok = error
        && error.code === poisson.POISSON_INPUT_INVALID
        && error.detail?.role === 'Expected'
        && error.detail?.reason === 'negative'
        && error.detail?.index === 1;
      if (!ok) failures.push(`${name}:${error ? JSON.stringify(error.detail) : 'no throw'}`);
    }
    return { pass: failures.length === 0, detail: JSON.stringify(failures) };
  });

  run('a non-finite EXPECTED count is rejected (it previously produced a NaN statistic)', () => {
    const error = capture(() => poisson.poissonLogLikelihood(OBSERVED, [4.1, 8.8, Infinity, 9.2, 3.9]));
    return {
      pass: error?.code === poisson.POISSON_INPUT_INVALID
        && error.detail.role === 'Expected'
        && error.detail.reason === 'nonfinite'
        && error.detail.index === 2,
      detail: JSON.stringify(error?.detail ?? null),
    };
  });

  run('quadrature round-off (a few ulps below zero) in EXPECTED is absorbed, not rejected', () => {
    const value = poisson.poissonDeviance(OBSERVED, [4.1, -1e-13, 15.9, 9.2, 3.9]);
    return { pass: Number.isFinite(value), detail: String(value) };
  });

  run('a length mismatch is a structured error, not a silent short evaluation', () => {
    const error = capture(() => poisson.poissonDeviance([1, 2, 3], [1, 2]));
    return {
      pass: error?.code === poisson.POISSON_INPUT_INVALID && error.detail.reason === 'length_mismatch',
      detail: JSON.stringify(error?.detail ?? null),
    };
  });

  run('deviance residuals of an integer-typed observed array stay real-valued', () => {
    // Int32Array.prototype.map returns an Int32Array, which used to TRUNCATE
    // every residual to an integer; Array.from keeps them real.
    const residuals = poisson.poissonDevianceResiduals(Int32Array.from([4, 9, 16]), [4.4, 8.2, 16.9]);
    return {
      pass: Array.isArray(residuals) && residuals.some((value) => !Number.isInteger(value)),
      detail: JSON.stringify(residuals),
    };
  });

  // ---- STAT-01 boxes 2-4: audit every bound, trigger every warning -------

  // A feasible reference fit: nothing at a bound, nothing violated.
  const CLEAN = {
    named: {
      g1Area: 5000, sArea: 2000, g2Area: 3000,
      g1Mean: 100, g1CV: 0.05, g2Mean: 200, g2CV: 0.06,
      shape1: 0, shape2: 0, w: 0.4, waveMean: 0.5, waveSigma: 0.2,
    },
    bounds: {
      g1Area: [0, Infinity], sArea: [0, Infinity], g2Area: [0, Infinity],
      g1CV: [0.01, 0.30], g2CV: [0.01, 0.30],
      g1Mean: [90, 110], g2Mean: [190, 210],
      w: [0, 0.95], waveMean: [0.02, 0.98], waveSigma: [0.02, 0.5],
    },
    config: { ratioMode: 'bounded', fitRatioRange: [1.65, 2.25] },
    phaseFractions: { g1: 0.5, s: 0.2, g2: 0.3 },
    contaminantFractions: {},
    profileMinimumFn: sPhaseProfileMinimum,
  };

  const auditWith = (overrides = {}) => {
    const spec = {
      ...CLEAN,
      ...overrides,
      named: { ...CLEAN.named, ...(overrides.named ?? {}) },
      config: { ...CLEAN.config, ...(overrides.config ?? {}) },
    };
    const bundle = audit.buildConstraintAudit(spec);
    return { bundle, warnings: audit.constraintAuditWarnings(bundle) };
  };

  run('a fit comfortably inside every bound reports no active constraint and no violation', () => {
    const { bundle, warnings } = auditWith();
    return {
      pass: bundle.activeCount === 0 && bundle.violationCount === 0 && warnings.length === 0,
      detail: JSON.stringify({ active: bundle.active.map((e) => e.parameter ?? e.constraint), warnings }),
    };
  });

  run('the audit covers every declared bound plus every joint constraint', () => {
    const { bundle } = auditWith();
    const boxes = bundle.entries.filter((entry) => entry.constraint === 'box').map((entry) => entry.parameter).sort();
    const joints = bundle.entries.filter((entry) => entry.kind === 'joint').map((entry) => entry.constraint).sort();
    const expectedBoxes = Object.keys(CLEAN.bounds).sort();
    return {
      pass: JSON.stringify(boxes) === JSON.stringify(expectedBoxes)
        && JSON.stringify(joints) === JSON.stringify([
          'contaminant_fractions_feasible', 'g2_g1_ratio', 'phase_fractions_simplex', 's_profile_nonnegative',
        ]),
      detail: JSON.stringify({ boxes, joints }),
    };
  });

  run('every box entry carries an exact residual and slack, not just a flag', () => {
    const { bundle } = auditWith();
    const cv = bundle.entries.find((entry) => entry.parameter === 'g1CV');
    return {
      pass: Math.abs(cv.lowerResidual - 0.04) < 1e-12
        && Math.abs(cv.upperResidual - 0.25) < 1e-12
        && Math.abs(cv.slack - 0.04) < 1e-12,
      detail: JSON.stringify(cv),
    };
  });

  // --- one focused trigger per configured bound ---
  const BOUND_TRIGGERS = [
    ['CV lower', { g1CV: 0.01 }, 'g1CV', 'parameter_at_lower_bound'],
    ['CV upper', { g2CV: 0.30 }, 'g2CV', 'parameter_at_upper_bound'],
    ['mean lower', { g1Mean: 90 }, 'g1Mean', 'parameter_at_lower_bound'],
    ['mean upper', { g2Mean: 210 }, 'g2Mean', 'parameter_at_upper_bound'],
    ['area lower', { sArea: 0 }, 'sArea', 'parameter_at_lower_bound'],
    ['wave weight upper', { w: 0.95 }, 'w', 'parameter_at_upper_bound'],
    ['wave mean lower', { waveMean: 0.02 }, 'waveMean', 'parameter_at_lower_bound'],
    ['wave sigma upper', { waveSigma: 0.5 }, 'waveSigma', 'parameter_at_upper_bound'],
  ];

  for (const [label, named, parameter, code] of BOUND_TRIGGERS) {
    run(`STAT-01 bound trigger: ${label} (${parameter}) reports an active bound and warns`, () => {
      const { bundle, warnings } = auditWith({ named });
      const entry = bundle.entries.find((item) => item.parameter === parameter);
      const warning = warnings.find((item) => item.parameter === parameter);
      return {
        pass: entry?.active === true && !entry.violated && warning?.code === code,
        detail: JSON.stringify({ entry, warning }),
      };
    });
  }

  run('a parameter pushed OUTSIDE its bound is reported as violated, not merely active', () => {
    const { bundle, warnings } = auditWith({ named: { g1CV: 0.9 } });
    const entry = bundle.entries.find((item) => item.parameter === 'g1CV');
    return {
      pass: entry.violated === true
        && Math.abs(entry.upperResidual - (0.30 - 0.9)) < 1e-12
        && warnings.some((item) => item.code === 'parameter_bound_violated' && item.severity === 'error'),
      detail: JSON.stringify({ entry, warnings }),
    };
  });

  // --- one focused trigger per joint constraint ---

  run('STAT-01 joint trigger: a bounded G2:G1 ratio pinned at its lower edge is active', () => {
    const { bundle, warnings } = auditWith({ named: { g1Mean: 100, g2Mean: 165 } });
    const entry = bundle.entries.find((item) => item.constraint === 'g2_g1_ratio');
    return {
      pass: entry.active === true && entry.violated === false && entry.activeSide === 'lower'
        && Math.abs(entry.value - 1.65) < 1e-12
        && warnings.some((item) => item.code === 'joint_constraint_active' && item.constraint === 'g2_g1_ratio'),
      detail: JSON.stringify({ entry, warnings }),
    };
  });

  run('STAT-01 joint trigger: a G2:G1 ratio outside the band is violated with an exact residual', () => {
    const { bundle, warnings } = auditWith({ named: { g1Mean: 100, g2Mean: 300 } });
    const entry = bundle.entries.find((item) => item.constraint === 'g2_g1_ratio');
    return {
      pass: entry.violated === true && Math.abs(entry.residual - 0.75) < 1e-12
        && warnings.some((item) => item.code === 'joint_constraint_violated'),
      detail: JSON.stringify(entry),
    };
  });

  run('STAT-01 joint trigger: a LOCKED ratio is always active and flags any departure', () => {
    const held = auditWith({ named: { g1Mean: 100, g2Mean: 200 }, config: { ratioMode: 'locked', lockedRatio: 2 } });
    const broken = auditWith({ named: { g1Mean: 100, g2Mean: 210 }, config: { ratioMode: 'locked', lockedRatio: 2 } });
    const heldEntry = held.bundle.entries.find((item) => item.constraint === 'g2_g1_ratio');
    const brokenEntry = broken.bundle.entries.find((item) => item.constraint === 'g2_g1_ratio');
    return {
      pass: heldEntry.active === true && heldEntry.violated === false
        && brokenEntry.violated === true && Math.abs(brokenEntry.residual - 0.1) < 1e-12,
      detail: JSON.stringify({ heldEntry, brokenEntry }),
    };
  });

  run('STAT-01 joint trigger: a free ratio mode imposes no ratio constraint', () => {
    const { bundle } = auditWith({ named: { g2Mean: 500 }, config: { ratioMode: 'free' } });
    const entry = bundle.entries.find((item) => item.constraint === 'g2_g1_ratio');
    return { pass: entry.active === false && entry.violated === false, detail: JSON.stringify(entry) };
  });

  run('STAT-01: the S-profile constraint is audited and cannot be violated by any shape', () => {
    // Under the Bernstein basis (SCI-08) nonnegativity holds by construction, so
    // this entry is EVIDENCE rather than a gate. It must still be present -- an
    // audit that drops a constraint because it "cannot fail" is how constraints
    // quietly stop holding -- and it must report a non-negative minimum for
    // every shape, including ones the old direct basis made infeasible.
    const shapes = [[0, 0], [-2, 0], [-4, 0], [12, -12], [-30, 30]];
    const entries = shapes.map(([shape1, shape2]) =>
      auditWith({ named: { shape1, shape2 } }).bundle.entries
        .find((item) => item.constraint === 's_profile_nonnegative'));
    return {
      pass: entries.every((entry) => entry && entry.violated === false && entry.value >= 0),
      detail: JSON.stringify(entries.map((entry, i) => [shapes[i], entry?.value])),
    };
  });

  run('STAT-01: a profile touching zero is reported active (the constraint is live evidence)', () => {
    // Driving one Bernstein weight to essentially zero makes q(0) -> 0, so the
    // minimum sits on the boundary and the audit should say the constraint is
    // shaping the fit.
    const { bundle } = auditWith({ named: { shape1: 40, shape2: 40 } });
    const entry = bundle.entries.find((item) => item.constraint === 's_profile_nonnegative');
    return {
      pass: entry.active === true && entry.violated === false && entry.value >= 0 && entry.value < 1e-3,
      detail: JSON.stringify(entry),
    };
  });

  run('STAT-01 joint trigger: phase fractions that do not sum to one are violated', () => {
    const { bundle, warnings } = auditWith({ phaseFractions: { g1: 0.5, s: 0.2, g2: 0.1 } });
    const entry = bundle.entries.find((item) => item.constraint === 'phase_fractions_simplex');
    return {
      pass: entry.violated === true && warnings.some((item) => item.code === 'joint_constraint_violated'),
      detail: JSON.stringify(entry),
    };
  });

  run('STAT-01 joint trigger: a negative phase fraction is violated even when the sum is one', () => {
    const { bundle } = auditWith({ phaseFractions: { g1: 1.2, s: -0.2, g2: 0.0 } });
    const entry = bundle.entries.find((item) => item.constraint === 'phase_fractions_simplex');
    return { pass: entry.violated === true, detail: JSON.stringify(entry) };
  });

  run('STAT-01 joint trigger: contaminant fractions are audited explicitly, empty set included', () => {
    const empty = auditWith().bundle.entries.find((item) => item.constraint === 'contaminant_fractions_feasible');
    const bad = auditWith({ contaminantFractions: { debris: 0.7, aggregate: 0.6 } })
      .bundle.entries.find((item) => item.constraint === 'contaminant_fractions_feasible');
    return {
      pass: empty.componentCount === 0 && empty.violated === false
        && bad.componentCount === 2 && bad.violated === true && Math.abs(bad.residual - 0.3) < 1e-12,
      detail: JSON.stringify({ empty, bad }),
    };
  });

  // ---- the audit is wired into the models it claims to cover -------------

  run('every canonical model publishes a constraintAudit whose boxes match its bounds', () => {
    const { register_default_models, get_model, clear_registry } = window.CellCycleModelRegistry;
    clear_registry();
    register_default_models();

    const edges = [];
    for (let i = 0; i <= 120; i += 1) edges.push(i * 5);
    const centers = edges.slice(0, -1).map((left, i) => 0.5 * (left + edges[i + 1]));
    const gauss = (x, mu, sigma) => Math.exp(-0.5 * ((x - mu) / sigma) ** 2);
    const counts = centers.map((x) =>
      Math.round(4000 * gauss(x, 200, 12) + 1800 * gauss(x, 400, 22)
        + 900 * Math.exp(-0.5 * ((x - 300) / 70) ** 2)));
    const histogram = { edges, counts, x: centers, y: counts };
    const regions = { g1: { left: 160, right: 240 }, g2: { left: 350, right: 450 } };

    const missing = [];
    for (const id of ['dean_jett', 'dean_jett_fox', 'watson_classic', 'watson_pragmatic']) {
      const model = get_model(id);
      const result = model.normalizeResult(model.fit({ histogram, peakRegions: regions, config: {} }));
      const auditBundle = result.constraintAudit;
      if (!auditBundle || !Array.isArray(auditBundle.entries)) { missing.push(`${id}:no audit`); continue; }
      const boxes = auditBundle.entries.filter((entry) => entry.constraint === 'box').map((entry) => entry.parameter).sort();
      const declared = Object.keys(result.bounds ?? {})
        .filter((key) => Number.isFinite(result.parameters?.[key]))
        .sort();
      if (JSON.stringify(boxes) !== JSON.stringify(declared)) {
        missing.push(`${id}: audited ${JSON.stringify(boxes)} vs declared ${JSON.stringify(declared)}`);
      }
      // Every joint constraint must be recorded, including for the
      // decomposition model that declares no box bounds at all.
      const joints = auditBundle.entries.filter((entry) => entry.kind === 'joint').map((entry) => entry.constraint);
      if (!joints.includes('phase_fractions_simplex') || !joints.includes('contaminant_fractions_feasible')) {
        missing.push(`${id}: joint set ${JSON.stringify(joints)}`);
      }
    }
    return { pass: missing.length === 0, detail: JSON.stringify(missing) };
  });

  run('a canonical fit satisfies its own constraints (no violation on clean synthetic data)', () => {
    const { register_default_models, get_model, clear_registry } = window.CellCycleModelRegistry;
    clear_registry();
    register_default_models();
    const edges = [];
    for (let i = 0; i <= 120; i += 1) edges.push(i * 5);
    const centers = edges.slice(0, -1).map((left, i) => 0.5 * (left + edges[i + 1]));
    const gauss = (x, mu, sigma) => Math.exp(-0.5 * ((x - mu) / sigma) ** 2);
    const counts = centers.map((x) =>
      Math.round(4000 * gauss(x, 200, 12) + 1800 * gauss(x, 400, 22)
        + 900 * Math.exp(-0.5 * ((x - 300) / 70) ** 2)));
    const histogram = { edges, counts, x: centers, y: counts };
    const regions = { g1: { left: 160, right: 240 }, g2: { left: 350, right: 450 } };

    const offenders = [];
    for (const id of ['dean_jett', 'dean_jett_fox', 'watson_classic', 'watson_pragmatic']) {
      const model = get_model(id);
      const result = model.normalizeResult(model.fit({ histogram, peakRegions: regions, config: {} }));
      if (result.constraintAudit.violationCount > 0) {
        offenders.push(`${id}:${JSON.stringify(result.constraintAudit.violations)}`);
      }
    }
    return { pass: offenders.length === 0, detail: JSON.stringify(offenders) };
  });

  return results;
}"""


def run_stat_constraint_tests(ctx: TestContext):
    """Run the STAT-01 Poisson-input and constraint-audit assertions."""

    try:
        all_results = ctx.page.evaluate(_STAT_TESTS)
    except Exception as err:
        ctx.check(GROUP, "STAT-01 suite setup", False, str(err), screenshot=False)
        return

    for item in all_results:
        ctx.check(GROUP, item["name"], item["pass"], item.get("detail", ""), screenshot=False)
