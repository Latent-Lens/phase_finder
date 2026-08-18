// Collects the per-sample cell-cycle modeling configuration for the session
// file. This follows the recompute-on-reload design: only the *inputs* are
// saved (which QC filters are applied, each sample's accepted peak regions, and
// its selected model + settings). Fit results are never serialized -- they are
// regenerated on reload by re-detecting/re-fitting from this config, so a
// restored session always reflects the current model code.
//
// Only samples currently on the plot are captured: an unplotted row is
// nonexistent to the modeling, so it carries no persisted modeling state.
//
// The per-sample shape is intentionally flat (no nested objects/arrays) so it
// round-trips cleanly through the flat-key TOML serializer.
//
// checked_qc_filters() reads the active QC selection from the DOM;
// get_modeling_session_state() builds the modeling section of the session file;
// apply_modeling_session() re-applies that config on reload.

import { plottable_rows, plot_bin_count, clamp_range_to_analysis_domain } from "../plotting/data.js";
import { get_state } from "../analysis/pipeline/pipeline_state.js";
import { load_pipeline } from "../analysis/pipeline/pipeline_loader.js";
import {
  get_modeling_state,
  update_peak_regions,
  set_model_settings,
  fit_cell_cycle_model,
} from "../analysis/cell_cycle/modeling_state.js";
import { get_model } from "../analysis/cell_cycle/model_registry.js";

// The four pre-model QC toggle button ids, index 0-3 (Structural, Time QC,
// Cell gate, Singlet gate). Read straight from the DOM pressed-state, which is
// where pipeline_ui.js keeps the active QC selection.
const QC_FILTER_IDS = ["qc_structural", "qc_time", "qc_cellgate", "qc_singlet"];

/*

Purpose:
	Reads the active pre-model QC selection from the DOM (the toggle buttons'
	pressed state), returning the checked filter indexes.

Input:
	(none)

Output:
	filters [array]: the checked QC filter indexes (0-3)

*/
function checked_qc_filters() {
  const filters = [];
  QC_FILTER_IDS.forEach((id, index) => {
    if (document.getElementById(id)?.getAttribute("aria-pressed") === "true") filters.push(index);
  });
  return filters;
}

/*

Purpose:
	Builds the modeling section for collect_session(): the applied QC filters plus
	one flat record per plotted sample that has accepted peak regions.

Input:
	(none)

Output:
	state [object]: { qc_filters, samples } for the session file

*/
export function get_modeling_session_state() {
  const samples = [];
  const scatter_gates = [];
  const singlet_gates = [];
  for (const row of plottable_rows()) {
    const pipelineState = get_state(row.name);
    const manualGate = pipelineState?.scatterGate?.manualOverride;
    if (manualGate) {
      scatter_gates.push({
        name: row.name,
        mean_x: manualGate.mean[0],
        mean_y: manualGate.mean[1],
        coverage: manualGate.coverage,
        rotation: manualGate.rotation ?? 0,
      });
    }
    const singlet = pipelineState?.singletResult;
    if (singlet?.pulseGeometryTransform) {
      singlet_gates.push({
        name: row.name,
        geometry_mode: singlet.geometryMode,
        transform_method: singlet.pulseGeometryTransform.method,
        area_center: singlet.pulseGeometryTransform.center[0],
        secondary_center: singlet.pulseGeometryTransform.center[1],
        area_scale: singlet.pulseGeometryTransform.scale[0],
        secondary_scale: singlet.pulseGeometryTransform.scale[1],
        identification_ratio: singlet.ridgeIdentificationRatio,
        review_required: Boolean(singlet.reviewRequired),
      });
    }
    const modeling = pipelineState?.modeling;
    const regions = modeling?.peakSelection?.regions;
    if (!regions) continue; // no accepted peaks -> nothing modeled for this sample
    const settings = modeling.settings;
    const eligibility = pipelineState?.channelEligibility;
    samples.push({
      name: row.name,
      model: settings.modelId,
      // STATE-01: record WHICH implementation produced the saved state. A
      // session is recomputed on reload, so if the model's version has moved
      // since it was written the recomputed numbers are a NEW result, not a
      // reproduction of the saved one -- and only a recorded version can tell
      // the two apart on restore.
      model_version: get_model(settings.modelId)?.version ?? "",
      reviewed: Boolean(modeling.peakSelection.reviewed),
      g1_left: regions.g1.left,
      g1_right: regions.g1.right,
      g1_source: regions.g1.source || "",
      g2_left: regions.g2.left,
      g2_right: regions.g2.right,
      g2_source: regions.g2.source || "",
      ratio_mode: settings.ratioMode,
      ratio_min: settings.ratioRange?.[0],
      ratio_max: settings.ratioRange?.[1],
      locked_ratio: settings.lockedRatio,
      cv_mode: settings.cvMode,
      ploidy_count: settings.ploidyCount,
      contaminant_debris: settings.contaminants?.debris ?? "off",
      contaminant_aggregate: settings.contaminants?.aggregate ?? "off",
      contaminant_subg1: settings.contaminants?.subG1 ?? "off",
      channel_eligibility: eligibility?.status ?? "unknown",
      channel_transform: eligibility?.transform?.status ?? "unknown",
      channel_compensation: eligibility?.compensation?.status ?? "unknown",
      transform_application_count: eligibility?.transform?.applicationCount ?? 0,
      compensation_application_count: eligibility?.compensation?.applicationCount ?? 0,
      qc_waivers: JSON.stringify(pipelineState?.qcWaivers ?? {}),
    });
  }
  return { qc_filters: checked_qc_filters(), scatter_gates, singlet_gates, samples };
}

/*

Purpose:
	Recomputes the saved modeling for the plotted samples (recompute-on-reload): for
	each saved sample currently on the plot, rebuild its histogram at the current bin
	count, restore its accepted peak regions and model/settings, and re-fit with its
	saved model. Assumes the saved QC filters have already been applied by the caller
	(so histograms reflect the right gated view). Unplotted saved samples are skipped.

Input:
	config [object]: the saved modeling section ({ samples, ... })
	options [object]: { onProgress } progress callback

Output:
	summary [Promise<object>]: { restored, failed, total }

*/
export async function apply_modeling_session(config, { onProgress } = {}) {
  const samples = config?.samples || [];
  const plotted = new Map(plottable_rows().map((row) => [row.name, row]));
  const targets = samples.filter((sample) => plotted.has(sample.name));
  const savedGates = (config?.scatter_gates || []).filter(gate => plotted.has(gate.name));
  if (!targets.length && !savedGates.length) return { restored: 0, failed: 0, total: 0, errors: [] };

  const pipeline = await load_pipeline();
  for (const saved of savedGates) {
    const row = plotted.get(saved.name);
    try {
      if (!get_state(row.name)?.scatterGate) pipeline.apply_cell_gate(row);
      pipeline.update_cell_gate(row, {
        mean: [saved.mean_x, saved.mean_y],
        coverage: saved.coverage,
        rotation: saved.rotation ?? 0,
      });
    } catch (_) {
      // A missing scatter channel is reported through the normal restore
      // summary; it must not prevent other samples/models being restored.
    }
  }
  const rows = plottable_rows();
  const range = clamp_range_to_analysis_domain(pipeline.shared_histogram_range(rows));
  const binCount = plot_bin_count();

  let restored = 0;
  let failed = 0;
  const errors = [];
  // STATE-01: samples whose model implementation moved since the session was
  // written, reported to the caller so the restore summary can say so rather
  // than presenting recomputed numbers as the saved ones.
  const driftedSamples = [];
  for (let index = 0; index < targets.length; index += 1) {
    const saved = targets[index];
    const row = plotted.get(saved.name);
    onProgress?.(index, targets.length, saved.name);
    try {
      // Ensure a current histogram even when no QC filter was applied.
      pipeline.ensure_histogram_current(row, { binCount, range });
      // Restore the exact accepted regions (bounds), then re-attach the
      // per-region provenance labels that validation drops.
      update_peak_regions(row, {
        g1: { left: saved.g1_left, right: saved.g1_right },
        g2: { left: saved.g2_left, right: saved.g2_right },
      }, { source: "manual", minimumGap: -0.01 });
      const regions = get_modeling_state(row).peakSelection.regions;
      if (saved.g1_source) regions.g1.source = saved.g1_source;
      if (saved.g2_source) regions.g2.source = saved.g2_source;
      get_modeling_state(row).peakSelection.reviewed = saved.reviewed === true;
      try {
        get_state(row.name).qcWaivers = JSON.parse(saved.qc_waivers || "{}");
      } catch (_) {
        get_state(row.name).qcWaivers = {};
      }

      set_model_settings(row, {
        modelId: saved.model,
        ratioMode: saved.ratio_mode,
        ratioRange: [saved.ratio_min, saved.ratio_max],
        lockedRatio: saved.locked_ratio,
        cvMode: saved.cv_mode,
        ploidyCount: saved.ploidy_count,
        contaminants: {
          debris: saved.contaminant_debris,
          aggregate: saved.contaminant_aggregate,
          subG1: saved.contaminant_subg1,
        },
      });

      // STATE-01: an UNREVIEWED saved sample restores its regions and settings
      // but is NOT refit -- accepting-by-recomputing would silently promote
      // regions the user never reviewed into an authoritative result.
      // Joint time-series models (CLOCCS) aren't per-sample fits; restore their
      // configuration but don't try to recompute a single-sample fit for them.
      const entry = get_model(saved.model);
      if (saved.reviewed === true && entry?.fitScope !== "joint_series") {
        const result = await fit_cell_cycle_model(row, saved.model);
        // STATE-01: label algorithm/version drift instead of implying the
        // recomputed number reproduces the saved session exactly.
        const savedVersion = saved.model_version || null;
        const currentVersion = entry?.version ?? null;
        const drifted = Boolean(savedVersion) && Boolean(currentVersion) && savedVersion !== currentVersion;
        result.reproduction = {
          status: drifted ? "recomputed_new" : savedVersion ? "reproduced" : "unknown_saved_version",
          savedModelVersion: savedVersion,
          currentModelVersion: currentVersion,
          modelId: saved.model,
        };
        if (drifted) {
          const message = `${entry?.label ?? saved.model} has changed since this session was saved `
            + `(v${savedVersion} → v${currentVersion}); this is a NEW result computed with the current model, `
            + "not a reproduction of the saved values.";
          result.warnings = [...(result.warnings ?? []), {
            code: "model_version_drift", severity: "warning", message,
          }];
          driftedSamples.push({ name: saved.name, model: saved.model, savedVersion, currentVersion });
        }
      }
      restored += 1;
    } catch (error) {
      failed += 1;
      errors.push({
        name: saved.name,
        code: error?.code ?? "model_restore_failed",
        message: error?.message ?? String(error),
      });
    }
  }
  return { restored, failed, total: targets.length, errors, drifted: driftedSamples };
}
