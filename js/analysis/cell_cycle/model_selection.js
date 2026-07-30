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
//
// Exports: selectAutomaticModel (the pure comparison policy over two fitted,
// normalized results) and auto_dj_djf (the registry model that fits both then
// defers to it in normalizeResult). Internal helpers residual_structure_improved,
// wave_not_on_bounds, and restarts_agree_on_wave implement criteria 2, 4, and 5.
// ============================================================================

import { dean_jett } from "./models/dean_jett.js";
import { dean_jett_fox } from "./models/dean_jett_fox.js";

export const DEFAULT_SELECTION_OPTIONS = Object.freeze({
  bicImprovementThreshold: 6,
  minimumWaveAreaFraction: 0.01,
  restartWaveTolerance: 0.05, // absolute spread in fitted w across competitive restarts
  nearBestDevianceMargin: 0.02, // a restart counts as "competitive" within 2% relative deviance of the best
  minimumLag1Improvement: 0.05,
});

/*

Purpose:
	Criterion 2: does Dean-Jett-Fox's lag-1 residual autocorrelation drop in
	magnitude relative to Dean-Jett's? (See the module header for why this, not a
	fixed formula, operationalizes "residual structure materially improves".)

Input:
	djDiagnostics [object]: the Dean-Jett fit's diagnostics bundle
	djfDiagnostics [object]: the Dean-Jett-Fox fit's diagnostics bundle

Output:
	improved [boolean]: true when Fox's lag-1 autocorrelation is smaller

*/
function residual_structure_improved(djDiagnostics, djfDiagnostics, minimumImprovement) {
  const djLag1 = Math.abs(djDiagnostics.lag1Autocorrelation);
  const djfLag1 = Math.abs(djfDiagnostics.lag1Autocorrelation);
  const improvement = djLag1 - djfLag1;
  return {
    pass: Number.isFinite(improvement) && improvement >= minimumImprovement,
    djLag1,
    djfLag1,
    improvement,
  };
}

/*

Purpose:
	Criterion 4: true when none of Dean-Jett-Fox's boundary warnings concern a
	wave parameter (a wave sitting on its bound is treated as not real).

Input:
	djfResult [object]: the normalized Dean-Jett-Fox result (reads .warnings)

Output:
	interior [boolean]: true when no wave parameter is at a bound

*/
function wave_not_on_bounds(djfResult) {
  const waveParameters = new Set(["w", "waveMean", "waveSigma"]);
  return !(djfResult.warnings ?? []).some(
    (warning) =>
      (warning.code === "parameter_at_lower_bound" || warning.code === "parameter_at_upper_bound") &&
      waveParameters.has(warning.parameter),
  );
}

export function candidateValidity(result) {
  const reasons = [];
  if (result?.validForReporting === false) reasons.push("result is not valid for reporting");
  if (result?.converged !== true) reasons.push(`did not converge (${result?.convergenceReason ?? "unknown reason"})`);
  for (const key of ["deviance", "bic", "reducedDeviance"]) {
    if (!Number.isFinite(result?.diagnostics?.[key])) reasons.push(`missing finite ${key}`);
  }
  for (const [key, range] of Object.entries(result?.bounds ?? {})) {
    const value = result?.parameters?.[key];
    if (!Number.isFinite(value) || value < range[0] - 1e-9 || value > range[1] + 1e-9) reasons.push(`${key} violates its bound`);
  }
  const fractions = Object.values(result?.phaseFractions ?? {});
  if (fractions.length !== 3 || fractions.some((value) => !Number.isFinite(value) || value < 0) || Math.abs(fractions.reduce((a, b) => a + b, 0) - 1) > 1e-6) {
    reasons.push("phase fractions are invalid");
  }
  if ((result?.warnings ?? []).some((warning) => warning.code === "component_tail_mass_outside_domain")) reasons.push("component tail mass exceeds the accepted limit");
  return { valid: reasons.length === 0, reasons };
}

/*

Purpose:
	Criterion 5: the spread of fitted w across the restarts that are actually
	competitive with the winning fit must stay within tolerance. "Competitive"
	means converged with deviance within nearBestDevianceMargin of the best
	converged restart -- a restart that landed in a clearly worse local optimum
	is already excluded from winning, so it shouldn't count as disagreement here
	either. Falls back to every converged restart (or every restart) when there
	are too few competitive ones or deviance data is missing, so a fixture that
	omits deviance degrades to a simpler "did every converged restart agree".

Input:
	djfResult [object]: the normalized Dean-Jett-Fox result (reads
	                    diagnostics.restarts)
	tolerance [number]: allowed absolute spread in fitted w
	nearBestDevianceMargin [number]: relative deviance margin defining "competitive"

Output:
	agree [boolean]: true when the competitive restarts agree on w within tolerance

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

/*

Purpose:
	Compares two already-fit, already-normalized results (Dean-Jett's and
	Dean-Jett-Fox's) and applies the selection criteria, keeping Fox only when
	DJF converged and all five criteria hold. A pure function of its two inputs
	-- it does no fitting itself, so it is independently testable against
	hand-built diagnostics fixtures as well as real fits.

Input:
	spec [object]: { djResult, djfResult, options } where options overrides
	               DEFAULT_SELECTION_OPTIONS (thresholds/tolerances)

Output:
	selection [object]: { selectedModelId, selectedResult, reasons (per-criterion
	                     pass/detail), comparison (deltaBic, waveAreaFraction, ...) }

*/
export function selectAutomaticModel({ djResult, djfResult, options = {} }) {
  const config = { ...DEFAULT_SELECTION_OPTIONS, ...options };
  const reasons = [];

  const djValidity = candidateValidity(djResult);
  const djfValidity = candidateValidity(djfResult);
  reasons.push({ criterion: "dj_valid", pass: djValidity.valid, detail: djValidity.valid ? "Dean-Jett is valid." : djValidity.reasons.join("; ") });
  reasons.push({ criterion: "djf_valid", pass: djfValidity.valid, detail: djfValidity.valid ? "Dean-Jett-Fox is valid." : djfValidity.reasons.join("; ") });

  if (!djValidity.valid && !djfValidity.valid) {
    return {
      selectedModelId: null,
      selectedResult: {
        schemaVersion: 1,
        modelId: "auto_dj_djf",
        modelLabel: "Automatic — No valid model",
        converged: false,
        convergenceReason: "no_valid_model",
        errorCode: "no_valid_model",
        phaseFractions: null,
        warnings: [{ code: "no_valid_model", severity: "error", message: `No valid automatic model. Dean-Jett: ${djValidity.reasons.join("; ")}. Dean-Jett-Fox: ${djfValidity.reasons.join("; ")}.` }],
      },
      reasons,
      comparison: { policy: "no_valid_model", deltaBic: null, waveAreaFraction: null },
    };
  }

  if (djValidity.valid !== djfValidity.valid) {
    const selectedResult = djValidity.valid ? djResult : djfResult;
    return {
      selectedModelId: selectedResult.modelId,
      selectedResult,
      reasons,
      comparison: { policy: "sole_valid_candidate", deltaBic: null, waveAreaFraction: null },
    };
  }

  const djObservation = djResult.diagnostics.observationKey;
  const djfObservation = djfResult.diagnostics.observationKey;
  if (djObservation && djfObservation && djObservation !== djfObservation) {
    return {
      selectedModelId: null,
      selectedResult: null,
      reasons: [...reasons, {
        criterion: "same_observed_histogram",
        pass: false,
        detail: "AIC/BIC candidates were fitted to different observed histograms and are not comparable.",
      }],
      comparison: { policy: "incomparable_histograms", deltaBic: null, waveAreaFraction: null },
    };
  }

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

  const residualEvidence = residual_structure_improved(
    djResult.diagnostics,
    djfResult.diagnostics,
    config.minimumLag1Improvement,
  );
  const residualPass = residualEvidence.pass;
  reasons.push({
    criterion: "residual_structure_improved",
    pass: residualPass,
    detail: `absolute |lag-1| improvement=${Number.isFinite(residualEvidence.improvement) ? residualEvidence.improvement.toFixed(3) : "n/a"} `
      + `(DJ ${Number.isFinite(residualEvidence.djLag1) ? residualEvidence.djLag1.toFixed(3) : "n/a"} - DJF ${Number.isFinite(residualEvidence.djfLag1) ? residualEvidence.djfLag1.toFixed(3) : "n/a"}); `
      + `required ≥ ${config.minimumLag1Improvement.toFixed(3)}.`,
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
      policy: "information_criterion",
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

  /*

  Purpose:
	Fits Dean-Jett first, then fits Dean-Jett-Fox with DJ's own converged
	parameters threaded through as config.djHint -- DJF's nesting guarantee only
	holds in practice when its starts include DJ's real optimum, not just a fresh
	region-only estimate. Defers the actual choice to normalizeResult(), where
	selectAutomaticModel() runs.

  Input:
	context [object]: the model fit context (histogram, peakRegions, config with
	                  optional dj/djf/selection/onProgress/shouldCancel)

  Output:
	rawResult [object]: { djRaw, djfRaw, selectionOptions } for normalizeResult()

  */
  fit(context) {
    const { config: userConfig = {} } = context;
    const shared = { onProgress: userConfig.onProgress, shouldCancel: userConfig.shouldCancel };
    const djRaw = dean_jett.fit({ ...context, config: { ...(userConfig.dj ?? {}), ...shared } });
    const djHint = dean_jett.normalizeResult(djRaw).parameters;
    const djfRaw = dean_jett_fox.fit({ ...context, config: { ...(userConfig.djf ?? {}), djHint, ...shared } });
    return { djRaw, djfRaw, selectionOptions: userConfig.selection ?? {} };
  },

  /*

  Purpose:
	Expected per-bin counts for whichever submodel produced the parameters.
	Dean-Jett-Fox's parameters always include `w` and Dean-Jett's never do, which
	is a reliable way to route without threading an extra field through the
	generic result shape.

  Input:
	edges [array]: histogram bin edges
	parameters [object]: a fitted parameter set from either submodel

  Output:
	counts [array]: the expected per-bin counts from the matching submodel

  */
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
