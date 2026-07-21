// ============================================================================
// auto_dj_djf: a conservative selection *policy* over two already-registered
// generative models (dean_jett, dean_jett_fox) -- not a third biological
// equation (plan §4.4: "auto_dj_djf is a selection policy over two
// registered generative models"). Fits both independently from each model's
// own deterministic starts and retains Fox only when every one of plan
// §5.4's criteria holds; otherwise keeps Dean-Jett and records exactly why
// Fox was rejected. Both candidate normalized results are always retained
// (modelComparison.djResult/djfResult) so a caller can inspect or override
// the automatic choice, not just see the winner.
//
// Selection criteria (plan §5.4), each checked and reported independently so
// a rejection is always attributable to a specific criterion:
//
//   1. deltaBic = DJ.bic - DJF.bic >= bicImprovementThreshold (plan: >= 6)
//   2. Poisson residual structure "materially improves". The plan states
//      this in prose without a closed form; this file operationalizes it as
//      DJF's lag-1 residual autocorrelation dropping in magnitude relative
//      to DJ's -- lag-1 autocorrelation is one of the plan's own named §5.1
//      residual-structure diagnostics, and (unlike overall reduced deviance)
//      it measures *pattern*, not scale, so it stays meaningful even on a
//      near-noiseless histogram where reduced deviance isn't anchored near 1
//      for either model. A versioned, documented choice, not a literal plan
//      equation. See residual_structure_improved() below.
//   3. waveArea / biologicalArea >= minimumWaveAreaFraction (plan: >= 0.01)
//   4. wave area/mean/width are not effectively on their configured bounds
//      (boundaryHitWarnings, read from djfResult.warnings)
//   5. deterministic restarts agree on the wave within tolerance -- the
//      spread of fitted w across dean_jett_fox.js's own restarts that are
//      competitive with the winner (converged, deviance within
//      nearBestDevianceMargin of the best), not a re-fit and not diluted by
//      restarts that merely satisfied generic LM convergence while landing
//      in a clearly worse local optimum
//
// Fox is retained only when DJF itself converged AND all five hold.
// ============================================================================

import { dean_jett } from "./models/dean_jett.js";
import { dean_jett_fox } from "./models/dean_jett_fox.js";

export const DEFAULT_SELECTION_OPTIONS = Object.freeze({
  bicImprovementThreshold: 6,
  minimumWaveAreaFraction: 0.01,
  restartWaveTolerance: 0.05, // absolute spread in fitted w across competitive restarts
  nearBestDevianceMargin: 0.02, // a restart counts as "competitive" within 2% relative deviance of the best
});

/** Criterion 2: does DJF's lag-1 residual autocorrelation drop in magnitude
 * relative to DJ's? (see the module doc for why this, not a plan-given
 * formula, operationalizes "residual structure materially improves"). */
function residual_structure_improved(djDiagnostics, djfDiagnostics) {
  const djLag1 = Math.abs(djDiagnostics.lag1Autocorrelation);
  const djfLag1 = Math.abs(djfDiagnostics.lag1Autocorrelation);
  if (!Number.isFinite(djfLag1)) return false;
  return !Number.isFinite(djLag1) || djfLag1 < djLag1;
}

/** Criterion 4: true when none of DJF's boundary warnings concern a wave parameter. */
function wave_not_on_bounds(djfResult) {
  const waveParameters = new Set(["w", "waveMean", "waveSigma"]);
  return !djfResult.warnings.some(
    (warning) =>
      (warning.code === "parameter_at_lower_bound" || warning.code === "parameter_at_upper_bound") &&
      waveParameters.has(warning.parameter),
  );
}

/**
 * Criterion 5: spread of w across restarts that are actually *competitive*
 * with the winning fit must stay within tolerance. "Competitive" means
 * converged with deviance within `nearBestDevianceMargin` of the best
 * converged restart's deviance -- a restart that converged to a clearly
 * worse local optimum is already excluded from winning by fit_engine.js's
 * own best-by-deviance selection, so it shouldn't count as "disagreement"
 * here either just because it also happened to satisfy the generic LM
 * convergence tolerance. Falls back to every converged restart (or every
 * restart at all) when there are too few competitive ones or deviance data
 * is missing, so a hand-built fixture that omits `deviance` degrades to the
 * simpler "did every converged restart agree" check rather than silently
 * passing.
 */
function restarts_agree_on_wave(djfResult, tolerance, nearBestDevianceMargin) {
  const restarts = djfResult.diagnostics.restarts ?? [];
  const converged = restarts.filter((restart) => restart.converged);
  const pool = converged.length >= 2 ? converged : restarts;
  if (pool.length < 2) return true;

  const bestDeviance = Math.min(...pool.map((restart) => restart.deviance));
  const competitive = pool.filter((restart) => restart.deviance <= bestDeviance * (1 + nearBestDevianceMargin));
  const finalPool = competitive.length >= 2 ? competitive : pool;

  const values = finalPool.map((restart) => restart.w);
  return Math.max(...values) - Math.min(...values) <= tolerance;
}

/**
 * Compares two already-fit, already-normalized results (dean_jett's and
 * dean_jett_fox's, both plan §4.5-shaped) and applies plan §5.4's selection
 * criteria. Pure function of its two results -- does no fitting itself, so
 * it is independently testable against hand-built diagnostics fixtures as
 * well as real fits.
 */
export function selectAutomaticModel({ djResult, djfResult, options = {} }) {
  const config = { ...DEFAULT_SELECTION_OPTIONS, ...options };
  const reasons = [];

  const djfConverged = djfResult.converged === true;
  reasons.push({
    criterion: "djf_converged",
    pass: djfConverged,
    detail: djfConverged ? "Dean-Jett-Fox converged." : `Dean-Jett-Fox did not converge (${djfResult.convergenceReason}).`,
  });

  const deltaBic = djResult.diagnostics.bic - djfResult.diagnostics.bic;
  const bicPass = Number.isFinite(deltaBic) && deltaBic >= config.bicImprovementThreshold;
  reasons.push({
    criterion: "bic_improvement",
    pass: bicPass,
    detail: `deltaBic (DJ - DJF) = ${Number.isFinite(deltaBic) ? deltaBic.toFixed(2) : "n/a"}, threshold ${config.bicImprovementThreshold}.`,
  });

  const residualPass = residual_structure_improved(djResult.diagnostics, djfResult.diagnostics);
  reasons.push({
    criterion: "residual_structure_improved",
    pass: residualPass,
    detail: `DJ reducedDeviance=${djResult.diagnostics.reducedDeviance?.toFixed(3)}, DJF reducedDeviance=${djfResult.diagnostics.reducedDeviance?.toFixed(3)}.`,
  });

  const biologicalArea = djfResult.parameters.g1Area + djfResult.parameters.sArea + djfResult.parameters.g2Area;
  const waveAreaFraction = biologicalArea > 0 ? djfResult.parameters.waveArea / biologicalArea : 0;
  const areaPass = waveAreaFraction >= config.minimumWaveAreaFraction;
  reasons.push({
    criterion: "minimum_wave_area",
    pass: areaPass,
    detail: `waveArea/biologicalArea=${waveAreaFraction.toFixed(4)}, threshold ${config.minimumWaveAreaFraction}.`,
  });

  const boundsPass = wave_not_on_bounds(djfResult);
  reasons.push({
    criterion: "wave_not_on_bounds",
    pass: boundsPass,
    detail: boundsPass ? "Wave parameters are interior to their bounds." : "A wave parameter converged at its configured bound.",
  });

  const stabilityPass = restarts_agree_on_wave(djfResult, config.restartWaveTolerance, config.nearBestDevianceMargin);
  reasons.push({
    criterion: "restart_stability",
    pass: stabilityPass,
    detail: stabilityPass ? "Converged restarts agree on w." : "Converged restarts disagree on w beyond tolerance.",
  });

  const selectFox = djfConverged && bicPass && residualPass && areaPass && boundsPass && stabilityPass;

  return {
    selectedModelId: selectFox ? "dean_jett_fox" : "dean_jett",
    selectedResult: selectFox ? djfResult : djResult,
    reasons,
    comparison: {
      deltaBic,
      waveAreaFraction,
      djReducedDeviance: djResult.diagnostics.reducedDeviance,
      djfReducedDeviance: djfResult.diagnostics.reducedDeviance,
    },
  };
}

export const auto_dj_djf = {
  id: "auto_dj_djf",
  version: "1.0.0",
  label: "Automatic — Dean–Jett / Dean–Jett–Fox",
  kind: "generative",
  fitScope: "per_sample",
  comparisonGroup: "poisson_cell_cycle",
  requiredInputs: ["sample_histogram", "peak_regions"],
  capabilities: { contaminants: false, multiplePloidy: false, autoComparison: true },
  defaultConfig: { dj: {}, djf: {}, selection: { ...DEFAULT_SELECTION_OPTIONS } },

  /**
   * Fits DJ first, then fits DJF with DJ's own converged parameters passed
   * through as config.djHint ("Independently fit both generative models to
   * each selected sample histogram from comparable starts" -- DJF's nesting
   * guarantee, spelled out in dean_jett_fox.js's build_parameter_starts(),
   * only actually holds in practice when DJF's starts include DJ's real
   * optimum, not just a fresh region-only estimate). Defers the actual
   * selection to normalizeResult(), where selectAutomaticModel() runs.
   */
  fit(context) {
    const { config: userConfig = {} } = context;
    const shared = { onProgress: userConfig.onProgress, shouldCancel: userConfig.shouldCancel };
    const djRaw = dean_jett.fit({ ...context, config: { ...(userConfig.dj ?? {}), ...shared } });
    const djHint = dean_jett.normalizeResult(djRaw).parameters;
    const djfRaw = dean_jett_fox.fit({ ...context, config: { ...(userConfig.djf ?? {}), djHint, ...shared } });
    return { djRaw, djfRaw, selectionOptions: userConfig.selection ?? {} };
  },

  /** DJF's parameters always include `w`; DJ's never do -- a reliable,
   * simple way to route to the model that actually produced `parameters`
   * without threading an extra field through the generic §4.5 shape. */
  expectedCounts(edges, parameters) {
    return "w" in parameters
      ? dean_jett_fox.expectedCounts(edges, parameters)
      : dean_jett.expectedCounts(edges, parameters);
  },

  normalizeResult(rawResult) {
    const { djRaw, djfRaw, selectionOptions } = rawResult;
    const djResult = dean_jett.normalizeResult(djRaw);
    const djfResult = dean_jett_fox.normalizeResult(djfRaw);
    const selection = selectAutomaticModel({ djResult, djfResult, options: selectionOptions });

    return {
      ...selection.selectedResult,
      modelId: "auto_dj_djf",
      modelLabel: "Automatic — Dean–Jett / Dean–Jett–Fox",
      // "Store both candidate results in Auto mode" (plan M4 task list) --
      // the selected result's own fields above are the ones every existing
      // consumer (plot, table, export) reads; modelComparison is additive.
      modelComparison: {
        selectedModelId: selection.selectedModelId,
        reasons: selection.reasons,
        comparison: selection.comparison,
        djResult,
        djfResult,
      },
    };
  },
};
