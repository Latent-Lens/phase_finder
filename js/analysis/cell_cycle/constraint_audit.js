// STAT-01 constraint audit: one place that turns a fitted model's declared
// bounds and joint feasibility conditions into EXACT numeric evidence --
// per-constraint residual, remaining slack, whether the constraint is active at
// the optimum, and whether it is violated.
//
// Why this exists separately from diagnostics.js's boundaryHitWarnings(): that
// helper only warned about whichever parameters a model happened to pass it,
// and each model passed a hand-written subset of the bounds it publishes. The
// audited gap was real -- g1Mean/g2Mean appeared in every model's `bounds` but
// in no model's warning call, so a peak mean pinned to its region edge produced
// no warning at all. Here the audit is derived FROM the published `bounds` map,
// so the two can no longer drift, and the joint constraints (G2:G1 ratio,
// S-profile nonnegativity, contaminant/phase-fraction feasibility) that have no
// box representation are audited alongside them.
//
// Exports buildConstraintAudit (the evidence), constraintAuditWarnings (the
// warning vocabulary derived from it), and the individual joint auditors for
// direct testing.

// A box bound counts as ACTIVE when the fitted value sits within this relative
// distance of it -- the optimizer wanted to keep moving and the constraint is
// what stopped it. Matches diagnostics.js's boundaryHitWarnings epsilon so the
// two agree on what "at a bound" means.
export const ACTIVE_BOUND_EPSILON = 1e-3;

// A joint (non-box) constraint counts as violated beyond this absolute residual.
// Projection makes these satisfiable by construction, so anything above this is
// a genuine defect in the projection, not round-off.
export const JOINT_CONSTRAINT_TOLERANCE = 1e-9;

function normalize_bound(bound) {
  if (Array.isArray(bound)) return { min: bound[0], max: bound[1] };
  if (bound && typeof bound === "object") return { min: bound.min, max: bound.max };
  return { min: undefined, max: undefined };
}

/*

Purpose:
	Audits every declared box bound on a fitted parameter set, reporting the exact
	distance to each side, the remaining slack, and which side (if any) is active.

Input:
	namedParameters [object]: parameter name -> fitted value
	bounds [object]: parameter name -> [min, max] or { min, max } (either side may
	                 be undefined/non-finite for a one-sided bound)
	options [object]: optional { epsilon } relative closeness that counts as active

Output:
	entries [array]: one { constraint: "box", parameter, value, min, max,
	                 lowerResidual, upperResidual, slack, active, activeSide,
	                 violated } per bounded parameter with a finite fitted value

*/
export function boxConstraintAudit(namedParameters, bounds, { epsilon = ACTIVE_BOUND_EPSILON } = {}) {
  const entries = [];
  for (const [parameter, rawBound] of Object.entries(bounds ?? {})) {
    const { min, max } = normalize_bound(rawBound);
    const value = namedParameters?.[parameter];
    if (!Number.isFinite(value)) continue;
    if (!Number.isFinite(min) && !Number.isFinite(max)) continue;

    const scale = Math.max(Math.abs(value), 1);
    // Signed distance INTO the feasible side: positive = slack remaining,
    // negative = the bound is violated by that much.
    const lowerResidual = Number.isFinite(min) ? value - min : null;
    const upperResidual = Number.isFinite(max) ? max - value : null;
    const slack = Math.min(
      lowerResidual ?? Infinity,
      upperResidual ?? Infinity,
    );
    const atLower = lowerResidual != null && lowerResidual <= epsilon * scale;
    const atUpper = upperResidual != null && upperResidual <= epsilon * scale;
    entries.push({
      constraint: "box",
      parameter,
      value,
      min: Number.isFinite(min) ? min : null,
      max: Number.isFinite(max) ? max : null,
      lowerResidual,
      upperResidual,
      slack: Number.isFinite(slack) ? slack : null,
      active: atLower || atUpper,
      activeSide: atLower ? "lower" : atUpper ? "upper" : null,
      violated: (lowerResidual != null && lowerResidual < -epsilon * scale)
        || (upperResidual != null && upperResidual < -epsilon * scale),
    });
  }
  return entries;
}

/*

Purpose:
	Audits the joint G2:G1 mean-ratio constraint (SCI-02) that no box bound can
	express: it couples two parameters, so a fit can satisfy both mean regions
	individually and still violate the ratio.

Input:
	named [object]: fitted parameters, needs g1Mean and g2Mean
	config [object]: { ratioMode: "free"|"bounded"|"locked", fitRatioRange,
	                  lockedRatio }

Output:
	entry [object|null]: a joint audit entry, or null when the mode imposes no
	                     ratio constraint or the means are unusable

*/
export function ratioConstraintAudit(named, config) {
  const g1Mean = named?.g1Mean;
  const g2Mean = named?.g2Mean;
  if (!Number.isFinite(g1Mean) || !Number.isFinite(g2Mean) || !(g1Mean > 0)) return null;
  const ratio = g2Mean / g1Mean;
  const mode = config?.ratioMode ?? "free";

  if (mode === "locked") {
    const target = config.lockedRatio;
    if (!Number.isFinite(target)) return null;
    const residual = Math.abs(ratio - target);
    return {
      constraint: "g2_g1_ratio",
      kind: "joint",
      mode,
      value: ratio,
      target,
      min: target,
      max: target,
      residual,
      slack: 0,
      active: true, // an equality constraint is always active
      violated: residual > Math.max(JOINT_CONSTRAINT_TOLERANCE, 1e-6 * Math.abs(target)),
    };
  }

  if (mode === "bounded") {
    const [min, max] = config.fitRatioRange ?? [];
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    const lowerResidual = ratio - min;
    const upperResidual = max - ratio;
    const slack = Math.min(lowerResidual, upperResidual);
    const width = Math.max(max - min, JOINT_CONSTRAINT_TOLERANCE);
    return {
      constraint: "g2_g1_ratio",
      kind: "joint",
      mode,
      value: ratio,
      min,
      max,
      lowerResidual,
      upperResidual,
      residual: slack < 0 ? -slack : 0,
      slack,
      active: slack <= ACTIVE_BOUND_EPSILON * width,
      activeSide: lowerResidual <= ACTIVE_BOUND_EPSILON * width
        ? "lower"
        : upperResidual <= ACTIVE_BOUND_EPSILON * width ? "upper" : null,
      violated: slack < -JOINT_CONSTRAINT_TOLERANCE,
    };
  }

  return { constraint: "g2_g1_ratio", kind: "joint", mode: "free", value: ratio, active: false, violated: false, residual: 0, slack: null };
}

/*

Purpose:
	Audits the S-phase profile's nonnegativity across z in [0,1].

	Since SCI-08 moved the profile to the Bernstein basis this holds BY
	CONSTRUCTION, so the entry is evidence rather than a gate: a violation here
	would mean the parameterization itself is broken, not that the fit wandered.
	It is still audited rather than assumed -- an audit that skips a constraint
	because it "cannot fail" is how constraints quietly stop holding.

Input:
	named [object]: fitted parameters, needs b and c
	profileMinimumFn [function]: (shape1, shape2) -> min of q on [0,1]
	                             (shared.js's sPhaseProfileMinimum, injected so
	                             this module stays free of model-equation imports)

Output:
	entry [object|null]: a joint audit entry, or null when (b, c) are absent

*/
export function profileConstraintAudit(named, profileMinimumFn) {
  const shape1 = named?.shape1;
  const shape2 = named?.shape2;
  if (!Number.isFinite(shape1) || !Number.isFinite(shape2) || typeof profileMinimumFn !== "function") return null;
  const minimum = profileMinimumFn(shape1, shape2);
  return {
    constraint: "s_profile_nonnegative",
    kind: "joint",
    parameters: { shape1, shape2 },
    value: minimum,
    min: 0,
    residual: minimum < 0 ? -minimum : 0,
    slack: minimum,
    // The profile is projected exactly onto the boundary when infeasible, so a
    // minimum at (numerically) zero means the constraint is what shaped the fit.
    active: minimum <= ACTIVE_BOUND_EPSILON,
    violated: minimum < -JOINT_CONSTRAINT_TOLERANCE,
  };
}

/*

Purpose:
	Audits the feasibility of the reported composition itself: the biological
	phase fractions must form a distribution (each in [0,1], summing to 1) and any
	contaminant fractions must be individually in [0,1] and not exceed the whole
	sample alongside them. Canonical models declare no contaminants, so this
	normally records an explicitly empty contaminant set rather than omitting the
	category -- an audit that silently skips a constraint is not an audit.

Input:
	result [object]: { phaseFractions, contaminantFractions }

Output:
	entries [array]: the phase-fraction and contaminant-fraction audit entries

*/
export function fractionConstraintAudit({ phaseFractions, contaminantFractions } = {}) {
  const entries = [];
  const phases = phaseFractions ?? {};
  const values = [phases.g1, phases.s, phases.g2];
  const allFinite = values.every((value) => Number.isFinite(value));
  const total = allFinite ? values.reduce((sum, value) => sum + value, 0) : NaN;
  const outOfUnit = allFinite
    ? Math.max(0, ...values.map((value) => Math.max(-value, value - 1)))
    : NaN;
  entries.push({
    constraint: "phase_fractions_simplex",
    kind: "joint",
    value: total,
    target: 1,
    residual: allFinite ? Math.max(Math.abs(total - 1), outOfUnit) : Infinity,
    slack: allFinite ? Math.min(...values) : null,
    active: false,
    violated: !allFinite || Math.abs(total - 1) > 1e-6 || outOfUnit > 1e-9,
  });

  const contaminants = Object.entries(contaminantFractions ?? {});
  const contaminantTotal = contaminants.reduce((sum, [, value]) => sum + (Number.isFinite(value) ? value : 0), 0);
  entries.push({
    constraint: "contaminant_fractions_feasible",
    kind: "joint",
    componentCount: contaminants.length,
    value: contaminantTotal,
    min: 0,
    max: 1,
    residual: Math.max(0, -contaminantTotal, contaminantTotal - 1),
    slack: 1 - contaminantTotal,
    active: contaminants.length > 0 && contaminantTotal >= 1 - ACTIVE_BOUND_EPSILON,
    violated: contaminants.some(([, value]) => !Number.isFinite(value) || value < 0 || value > 1)
      || contaminantTotal > 1 + 1e-9,
  });
  return entries;
}

/*

Purpose:
	Assembles the complete STAT-01 constraint audit for one normalized fit result:
	every declared box bound plus every joint feasibility condition, each with its
	exact residual and active flag, and a summary of which constraints are active
	or violated. Stored on the result so a reviewer can see precisely which
	constraints shaped the reported numbers.

Input:
	spec [object]: { named (fitted parameters by name), bounds (the result's
	               published bounds map), config (the applied model config),
	               phaseFractions, contaminantFractions, profileMinimumFn
	               (optional, enables the S-profile audit) }

Output:
	audit [object]: { entries, active, violations, activeCount, violationCount }

*/
export function buildConstraintAudit({
  named,
  bounds = {},
  config = {},
  phaseFractions = null,
  contaminantFractions = null,
  profileMinimumFn = null,
} = {}) {
  const entries = [
    ...boxConstraintAudit(named, bounds),
    ratioConstraintAudit(named, config),
    profileConstraintAudit(named, profileMinimumFn),
    ...fractionConstraintAudit({ phaseFractions, contaminantFractions }),
  ].filter(Boolean);

  const active = entries.filter((entry) => entry.active);
  const violations = entries.filter((entry) => entry.violated);
  return {
    entries,
    active,
    violations,
    activeCount: active.length,
    violationCount: violations.length,
  };
}

const JOINT_LABEL = Object.freeze({
  g2_g1_ratio: "The G2:G1 mean ratio",
  s_profile_nonnegative: "The S-phase profile's nonnegativity condition",
  phase_fractions_simplex: "The phase fractions",
  contaminant_fractions_feasible: "The contaminant fractions",
});

/*

Purpose:
	The warning vocabulary derived from a constraint audit: one warning per active
	box bound (the reported optimum is an artifact of that bound) and one per
	active or violated joint constraint. Replaces each model's hand-listed
	boundaryHitWarnings call, so every bound a model publishes is covered.

Input:
	audit [object]: the bundle from buildConstraintAudit

Output:
	warnings [array]: zero or more { code, severity, parameter?, constraint?,
	                  message } warnings

*/
export function constraintAuditWarnings(audit) {
  const warnings = [];
  for (const entry of audit?.entries ?? []) {
    if (entry.constraint === "box") {
      if (entry.violated) {
        warnings.push({
          code: "parameter_bound_violated",
          severity: "error",
          parameter: entry.parameter,
          message: `${entry.parameter} = ${entry.value} lies outside its configured range [${entry.min}, ${entry.max}]; the constraint projection failed.`,
        });
      } else if (entry.active) {
        const side = entry.activeSide === "lower" ? "lower" : "upper";
        const bound = entry.activeSide === "lower" ? entry.min : entry.max;
        warnings.push({
          code: entry.activeSide === "lower" ? "parameter_at_lower_bound" : "parameter_at_upper_bound",
          severity: "warning",
          parameter: entry.parameter,
          message: `${entry.parameter} converged at its ${side} bound (${bound}); the true optimum may lie outside the configured range.`,
        });
      }
      continue;
    }

    const label = JOINT_LABEL[entry.constraint] ?? entry.constraint;
    if (entry.violated) {
      warnings.push({
        code: "joint_constraint_violated",
        severity: "error",
        constraint: entry.constraint,
        message: `${label} is violated by ${Number(entry.residual).toExponential(2)}; the fit does not satisfy its own feasibility conditions.`,
      });
    } else if (entry.active && entry.constraint !== "phase_fractions_simplex") {
      warnings.push({
        code: "joint_constraint_active",
        severity: "warning",
        constraint: entry.constraint,
        message: `${label} is active at the optimum (residual ${Number(entry.residual ?? 0).toExponential(2)}); the reported fit is shaped by that constraint rather than by the data alone.`,
      });
    }
  }
  return warnings;
}
