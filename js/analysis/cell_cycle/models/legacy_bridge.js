// legacy_bridge_v1: wraps the existing (pre-canonical) fitCellCycleHistogram
// implementation behind the generic model contract, so the registry-driven
// fit/render/report pipeline has one known-working entry before the canonical
// Dean-Jett/Dean-Jett-Fox/Watson models land. Per the modeling plan this is an
// advanced compatibility option: comparisonGroup is null (never compared
// against canonical models via AIC/BIC), and it must not be labeled
// Dean-Jett-Fox.
//
// normalize_legacy_extended_result() covers the debris/aggregate extension
// (extendCellCycleFit) with the same generic shape, so the plot/report layer
// can treat a base fit and an extended fit identically -- it just sees
// components with role "contaminant" alongside the biological ones.
//
// phaseFractions and contaminantFractions are intentionally left
// null/empty here -- those are computed today by cell_cycle_fit_report.js
// (Stage 8), and folding that into this generic contract is deferred rather
// than duplicated.
//
// Every normalized result carries the exact original legacy-shaped output in
// provenance.rawResult. That is not just an audit trail: extendCellCycleFit()
// and summarizeCellCycleFit() both require a previousFit/fit argument in that
// exact original shape (previousFit.parameters, previousFit.curves.residuals,
// etc.) -- callers orchestrating Stage 7/8 must pass provenance.rawResult
// through, not the normalized result itself.

import { fitCellCycleHistogram, DEFAULT_OPTIONS } from "../../legacy_bridge_fit.js";

function component_from_curve(id, label, counts, role = "biological") {
  const totalArea = counts.reduce((sum, value) => sum + value, 0);
  return {
    id,
    label,
    role,
    counts,
    totalArea,
    observedDomainArea: totalArea,
    includeInBiologicalDenominator: role === "biological",
  };
}

function convergence_reason(diagnostics) {
  if (diagnostics.cancelled) return "cancelled";
  if (diagnostics.converged) return "relative_deviance_and_step";
  return diagnostics.maxIterationsReached ? "max_iterations" : "unknown";
}

/** Shared §4.5 result-shape construction for both the base and extended fit. */
function build_generic_result({ parameters, expectedCounts, components, diagnostics, converged, extraDiagnostics = {}, rawResult }) {
  return {
    schemaVersion: 1,
    modelId: "legacy_bridge_v1",
    modelVersion: "1.0.0",
    modelLabel: "Legacy Bridge (compatibility)",
    kind: "generative",
    fitScope: "per_sample",
    comparisonGroup: null,

    converged,
    convergenceReason: convergence_reason(diagnostics),
    parameters,
    bounds: {},
    expectedCounts,
    components,
    phaseFractions: null,
    contaminantFractions: {},
    peakRegionMigration: {},
    diagnostics: {
      sse: diagnostics.sse,
      iterations: diagnostics.iterations,
      finalLambda: diagnostics.finalLambda,
      maxIterationsReached: diagnostics.maxIterationsReached,
      ...extraDiagnostics,
    },
    warnings: [],
    provenance: { rawResult },
    targetResults: [],
  };
}

export const legacy_bridge_v1 = {
  id: "legacy_bridge_v1",
  version: "1.0.0",
  label: "Legacy Bridge (compatibility)",
  kind: "generative",
  fitScope: "per_sample",
  comparisonGroup: null,
  requiredInputs: ["sample_histogram"],
  capabilities: { contaminants: false, multiplePloidy: false, autoComparison: false },
  defaultConfig: { ...DEFAULT_OPTIONS },

  /** context: { histogram, config }. histogram is a Stage 4-shaped result
   * (x/y required); config overrides DEFAULT_OPTIONS. */
  fit(context) {
    const { histogram, config = {} } = context;
    return fitCellCycleHistogram(histogram.x, histogram.y, config);
  },

  // Not implemented for the legacy bridge: its expected curve is only
  // available at the fitted histogram's own bin centers (curves.fitted in
  // the raw result), not as a standalone function of arbitrary edges.
  expectedCounts() {
    return null;
  },

  normalizeResult(rawResult) {
    const { parameters, curves, diagnostics } = rawResult;
    return build_generic_result({
      parameters,
      expectedCounts: curves.fitted,
      components: [
        component_from_curve("g1", "G1 / 1C", curves.g1),
        component_from_curve("s", "S", curves.s),
        component_from_curve("g2", "G2/M / 2C", curves.g2),
      ],
      diagnostics,
      converged: diagnostics.converged,
      extraDiagnostics: { detectedPeaks: diagnostics.detectedPeaks },
      rawResult,
    });
  },
};

/**
 * Normalizes extendCellCycleFit()'s raw output (Stage 7: debris/aggregate
 * extension) into the same generic §4.5 shape as legacy_bridge_v1's base fit,
 * so pipeline_fit_for_series() can read state.extendedFit and state.baseFit
 * uniformly. Not a separate registered model -- Stage 7 refines a Stage 6
 * result rather than offering an alternative model choice, so this is a plain
 * export used directly by the Stage 7 orchestrator, not routed through the
 * registry's fit()/normalizeResult() pair.
 */
export function normalize_legacy_extended_result(rawResult) {
  const { parameters, curves, diagnostics, selectedModel } = rawResult;
  const components = [
    component_from_curve("g1", "G1 / 1C", curves.g1),
    component_from_curve("s", "S", curves.s),
    component_from_curve("g2", "G2/M / 2C", curves.g2),
  ];
  if (selectedModel.includes("aggregate")) {
    components.push(component_from_curve("aggregate", "Aggregate", curves.aggregate, "contaminant"));
  }
  if (selectedModel.includes("debris")) {
    components.push(component_from_curve("debris", "Debris", curves.debris, "contaminant"));
  }

  return build_generic_result({
    parameters,
    expectedCounts: curves.fitted,
    components,
    diagnostics,
    converged: diagnostics.converged,
    extraDiagnostics: {
      bic: diagnostics.bic,
      candidateFits: diagnostics.candidateFits,
      comparisons: diagnostics.comparisons,
      selectedModel,
      inspection: rawResult.inspection,
    },
    rawResult,
  });
}
