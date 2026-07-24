// Collects the per-sample cell-cycle modeling configuration for the session
// file. This follows the recompute-on-reload design: only the *inputs* are
// saved (which QC stages are applied, each sample's accepted peak regions, and
// its selected model + settings). Fit results are never serialized -- they are
// regenerated on reload by re-detecting/re-fitting from this config, so a
// restored session always reflects the current model code.
//
// Only samples currently on the plot are captured: an unplotted row is
// nonexistent to the modeling, so it carries no persisted modeling state.
//
// The per-sample shape is intentionally flat (no nested objects/arrays) so it
// round-trips cleanly through the flat-key TOML serializer.

import { plottable_rows, plot_bin_count, clamp_range_to_axis_override } from "../plotting/data.js";
import { get_state } from "../analysis/pipeline_state.js";
import { load_pipeline } from "../analysis/pipeline_loader.js";
import {
  get_modeling_state,
  update_peak_regions,
  set_model_settings,
  fit_cell_cycle_model,
} from "../analysis/cell_cycle/modeling_state.js";

// The four pre-model QC toggle button ids, index 0-3 (Structural, Time QC,
// Cell gate, Singlet gate). Read straight from the DOM pressed-state, which is
// where pipeline_ui.js keeps the active QC selection.
const QC_STAGE_IDS = ["qc_stage0", "qc_stage1", "qc_stage2", "qc_stage3"];

function checked_qc_stages() {
  const stages = [];
  QC_STAGE_IDS.forEach((id, index) => {
    if (document.getElementById(id)?.getAttribute("aria-pressed") === "true") stages.push(index);
  });
  return stages;
}

/**
 * The modeling section for collect_session(): the applied QC stages plus one
 * flat record per plotted sample that has accepted peak regions.
 */
export function get_modeling_session_state() {
  const samples = [];
  for (const row of plottable_rows()) {
    const modeling = get_state(row.name)?.modeling;
    const regions = modeling?.peakSelection?.regions;
    if (!regions) continue; // no accepted peaks -> nothing modeled for this sample
    const settings = modeling.settings;
    samples.push({
      name: row.name,
      model: settings.modelId,
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
    });
  }
  return { qc_stages: checked_qc_stages(), samples };
}

/**
 * Recomputes the saved modeling for the plotted samples (recompute-on-reload):
 * for each saved sample that is currently on the plot, rebuild its histogram at
 * the current bin count, restore its accepted peak regions and model/settings,
 * and re-fit with its saved model. Assumes the saved QC stages have already
 * been applied by the caller (so histograms reflect the right gated view).
 * Unplotted saved samples are skipped -- an unplotted row is nonexistent to the
 * modeling.
 */
export async function apply_modeling_session(config, { onProgress } = {}) {
  const samples = config?.samples || [];
  const plotted = new Map(plottable_rows().map((row) => [row.name, row]));
  const targets = samples.filter((sample) => plotted.has(sample.name));
  if (!targets.length) return { restored: 0, failed: 0, total: 0 };

  const pipeline = await load_pipeline();
  const rows = plottable_rows();
  const range = clamp_range_to_axis_override(pipeline.shared_histogram_range(rows));
  const binCount = plot_bin_count();

  let restored = 0;
  let failed = 0;
  for (let index = 0; index < targets.length; index += 1) {
    const saved = targets[index];
    const row = plotted.get(saved.name);
    onProgress?.(index, targets.length, saved.name);
    try {
      // Ensure a current histogram even when no QC stage was applied.
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

      await fit_cell_cycle_model(row, saved.model);
      restored += 1;
    } catch (_) {
      failed += 1;
    }
  }
  return { restored, failed, total: targets.length };
}
