// Manual one-button-per-stage DJF debugging UI. Every click runs only its
// selected stage for all currently plottable rows and records per-sample output.

import {
  djf_stage_buttons,
  djf_run_all_button,
  qc_gate_buttons,
  qc_gate_run_all,
} from "../../ui/dom.js";
import { djf_readout, plottable_rows, plot_bin_count } from "../../plotting/data.js";
import { render_density_plot } from "../../plotting/render.js";
import {
  set_status_bar,
  show_progress,
  update_progress,
  hide_progress,
  next_frame,
} from "../../ui/status_channels.js";
import { load_pipeline } from "./pipeline_loader.js";
import { init_scatter_modal, open_scatter_modal } from "./scatter_modal.js";
import { get_file_table } from "../../state/app_state.js";
import { get_file_by_id } from "../../state/files.js";
import { render_file_table } from "../../ui/table_render.js";
import { ensure_companions_loaded } from "../../io/channel_loading.js";
import { QC_LOST_COLUMNS, DJF_FRACTION_COLUMNS, TOTAL_EVENTS_COLUMN } from "../../data_structs/derived_columns.js";

const IMPLEMENTED_STAGE_COUNT = 9;
// The QC gating stages (0-3) are driven by the Pre-modeling QC buttons; the
// manual "Run all" runs the modeling stages on whatever QC is currently applied.
const MODEL_STAGES = [4, 5, 6, 7, 8];
let initialized = false;
let pipeline_busy = false;

function set_pipeline_controls_disabled(disabled) {
  djf_stage_buttons.forEach((stageButton) => {
    if (stageButton) stageButton.disabled = disabled;
  });
  if (djf_run_all_button) djf_run_all_button.disabled = disabled;
}

// "1,905 (4.5%)" — count removed by the filter and its share of the events that
// entered that stage. A skipped/optional filter (no mask) shows an em dash.
function format_lost(filter) {
  if (!filter || filter.skipped) return "—";
  const percent = filter.entered > 0 ? (100 * filter.lost) / filter.entered : 0;
  return `${filter.lost.toLocaleString()} (${percent.toFixed(1)}%)`;
}

function format_percent(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "—";
}

// Sets one frame column from a per-id value function; `undefined` leaves a cell
// as-is, so samples not in this run keep their prior value.
function write_frame_column(frame, ids, col_name, value_for_id) {
  const column = frame.columns.includes(col_name)
    ? [...frame.col(col_name)]
    : Array(ids.length).fill(null);
  ids.forEach((id, index) => {
    const value = value_for_id(id);
    if (value !== undefined) column[index] = value;
  });
  frame.setCol(col_name, column);
}

// Writes one gating stage's loss column as soon as that stage finishes, then
// blanks any downstream columns whose masks this run just invalidated so they
// can't show stale numbers.
function write_gating_loss_column(rows, pipeline, stage) {
  const frame = get_file_table();
  if (!frame) return;

  const funnel_by_name = new Map();
  for (const row of rows) {
    const funnel = pipeline.pipeline_filter_funnel(row);
    if (funnel) funnel_by_name.set(row.name, funnel);
  }
  if (!funnel_by_name.size) return;

  const ids = [...frame.col("id")];
  const name_for = (id) => get_file_by_id(id)?.name;
  const processed = new Set(funnel_by_name.keys());
  const { key, label } = QC_LOST_COLUMNS[stage];

  // The first filter also seeds the leading raw event-count column, so it lands
  // to the left of the loss columns.
  if (stage === 0) {
    write_frame_column(frame, ids, TOTAL_EVENTS_COLUMN, (id) => {
      const funnel = funnel_by_name.get(name_for(id));
      return funnel ? funnel.eventCount.toLocaleString() : undefined;
    });
  }

  write_frame_column(frame, ids, label, (id) => {
    const funnel = funnel_by_name.get(name_for(id));
    if (!funnel) return undefined;
    return format_lost(funnel.filters.find((filter) => filter.key === key));
  });

  const downstream = [
    ...QC_LOST_COLUMNS.slice(stage + 1).map((column) => column.label),
    ...DJF_FRACTION_COLUMNS.map((column) => column.label),
  ];
  for (const col_name of downstream) {
    if (!frame.columns.includes(col_name)) continue;
    write_frame_column(frame, ids, col_name, (id) =>
      processed.has(name_for(id)) ? null : undefined,
    );
  }

  render_file_table();
}

// Writes the G1/S/G2-M percentage columns once samples have a Stage 8 report.
function write_fraction_columns(rows, pipeline) {
  const frame = get_file_table();
  if (!frame) return;

  const stats_by_name = new Map();
  for (const row of rows) {
    const stats = pipeline.pipeline_table_stats(row);
    if (stats) stats_by_name.set(row.name, stats);
  }
  if (!stats_by_name.size) return;

  const ids = [...frame.col("id")];
  const name_for = (id) => get_file_by_id(id)?.name;
  for (const { key, label } of DJF_FRACTION_COLUMNS) {
    write_frame_column(frame, ids, label, (id) => {
      const stats = stats_by_name.get(name_for(id));
      return stats ? format_percent(stats.fractions[key]) : undefined;
    });
  }

  render_file_table();
}

function fit_outcome_label(diagnostics) {
  if (diagnostics?.converged) return "converged";
  if (diagnostics?.maxIterationsReached) return "reached max iterations";
  return "stopped";
}

function format_stage_result(stage, entry) {
  const name = entry.name.replace(/\.fcs$/i, "");
  if (entry.failed) return `${name}: Stage ${stage} failed — ${entry.error}`;
  const result = entry.result;
  if (result.skipped) return `${name}: Stage ${stage} skipped — ${result.reason}`;

  if (stage === 0) {
    return `${name}: Stage 0 retained ${result.retainedEventCount.toLocaleString()} / ${result.eventCount.toLocaleString()} events`;
  }
  if (stage === 1) {
    const flagged = result.scoredBins.filter((bin) => bin.flagged).length;
    return `${name}: Stage 1 retained ${result.retainedEventCount.toLocaleString()} events · ${flagged}/${result.scoredBins.length} time bins flagged`;
  }
  if (stage === 2) {
    return `${name}: Stage 2 retained ${result.retainedEventCount.toLocaleString()} / ${result.fittedEventCount.toLocaleString()} eligible events · GMM ${result.converged ? "converged" : "not converged"}`;
  }
  if (stage === 3) {
    return `${name}: Stage 3 retained ${result.retainedSingletCount.toLocaleString()} / ${result.fittedEventCount.toLocaleString()} pulse-geometry events · ${result.geometryMode}`;
  }
  if (stage === 4) {
    return `${name}: Stage 4 binned ${result.binnedCount.toLocaleString()} retained events into ${result.binCount} bins`;
  }
  if (stage === 5) {
    return result.found
      ? `${name}: Stage 5 peaks at ${result.mu1.toFixed(2)} and ${result.mu2.toFixed(2)} · ratio ${result.ratio.toFixed(3)}`
      : `${name}: Stage 5 found no valid peak pair — ${result.status}`;
  }
  if (stage === 6) {
    return `${name}: Stage 6 ${fit_outcome_label(result.diagnostics)} in ${result.diagnostics.iterations} iterations · G1 ${result.parameters.mu1.toFixed(2)} · G2/G1 ${result.parameters.R.toFixed(3)}`;
  }
  if (stage === 7) {
    return `${name}: Stage 7 selected ${result.selectedModel} (${fit_outcome_label(result.diagnostics)}) · ${result.diagnostics.candidateFits.length} candidate model(s) compared`;
  }
  if (stage === 8) {
    const fractions = result.fractions.biologicalSinglets;
    return `${name}: Stage 8 · 1C ${(100 * fractions.oneC).toFixed(1)}% · S ${(100 * fractions.sPhase).toFixed(1)}% · 2C ${(100 * fractions.twoC).toFixed(1)}% · ${result.warnings.length} warning(s) · background model not specified`;
  }
  return `${name}: Stage ${stage} complete`;
}

async function run_manual_stage(
  stage,
  button,
  { keepOverlay = false, openScatter = true, managedByRunAll = false } = {},
) {
  if (pipeline_busy && !managedByRunAll) return [];
  const rows = plottable_rows();
  if (!rows.length) {
    const message = "Plot at least one selected sample before running a DJF stage.";
    if (djf_readout) djf_readout.textContent = message;
    set_status_bar(message, true);
    return [];
  }

  if (!managedByRunAll) {
    pipeline_busy = true;
    set_pipeline_controls_disabled(true);
  }
  button.disabled = true;
  button.classList.add("djf_stage_running");
  button.classList.remove("djf_stage_complete");
  djf_stage_buttons.slice(stage + 1).forEach((downstreamButton) =>
    downstreamButton?.classList.remove("djf_stage_complete")
  );

  try {
    const pipeline = await load_pipeline();
    // The plot loads only the DNA channel up front; the gating stages need the
    // companion channels, so wait for their background load to finish first.
    if (rows.some((row) => row.data && row.data.companionsPending)) {
      set_status_bar("Loading companion channels for the DJF pipeline…");
    }
    await ensure_companions_loaded(rows);
    // Let the lazy-loader's hide timer settle before reusing the overlay for
    // per-sample progress.
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    show_progress(`Running DJF Stage ${stage}`);
    const outputs = [];
    const failures = [];
    // Stage 4 snapshots the current bin count and shared range into the stored
    // histogram; Stages 6-8 then fit at those bin centers. The snapshot is
    // deliberately frozen — changing the bin control afterwards does not re-bin
    // a sample that already has stage state (see render.js prepare_row), because
    // re-binning would silently invalidate the fit. Re-run Stage 4 to refresh.
    const stageOptions = stage === 4
      ? { binCount: plot_bin_count(), range: pipeline.shared_histogram_range(rows) }
      : {};

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      update_progress(
        (100 * index) / rows.length,
        `Running DJF Stage ${stage}`,
        `Sample ${index + 1} of ${rows.length}`,
        row.name,
      );
      await next_frame();
      // Isolate each sample: one file's failure must not abort the batch or
      // the Run-All chain. Failed samples get an error entry and no state,
      // so downstream stages simply have nothing to build on for them.
      try {
        outputs.push(pipeline.run_stage(stage, row, stageOptions));
      } catch (error) {
        const entry = { stage, name: row.name, error: error.message, failed: true };
        outputs.push(entry);
        failures.push(entry);
      }
    }

    update_progress(100, `Running DJF Stage ${stage}`, `Finished ${rows.length} sample(s).`);
    // Every stage can invalidate downstream state, so redraw even for stages
    // without their own visual output to remove stale histograms/fits/reports.
    render_density_plot();
    if (stage === 2 && openScatter) {
      const inspect = outputs.find((entry) => entry.result && !entry.result.skipped);
      if (inspect) {
        const inspect_row = rows.find((row) => row.name === inspect.name);
        open_scatter_modal(inspect_row, inspect.result, {
          onGateChange: (edit) => {
            const updated = pipeline.update_stage2_gate(inspect_row, edit);
            djf_stage_buttons.slice(3).forEach((stageButton) =>
              stageButton?.classList.remove("djf_stage_complete")
            );
            djf_run_all_button?.classList.remove("djf_stage_complete");
            render_density_plot();

            const result = updated.result;
            const action = result.manualOverride
              ? "Manual Stage 2 gate applied"
              : "Stage 2 gate reset";
            const message = `${action} for ${inspect_row.name.replace(/\.fcs$/i, "")}: ${result.retainedEventCount.toLocaleString()} events retained. Re-run Stages 3–8.`;
            if (djf_readout) djf_readout.textContent = message;
            set_status_bar(message);
            return updated;
          },
        });
      }
    }
    if (djf_readout) {
      djf_readout.textContent = outputs.map((entry) => format_stage_result(stage, entry)).join("\n");
    }

    // Every sample failed — surface it as a stage failure so Run All stops.
    if (failures.length === rows.length) {
      set_status_bar(`DJF Stage ${stage} failed for all ${rows.length} sample(s): ${failures[0].error}`, true);
      update_progress(100, `DJF Stage ${stage} failed`, failures[0].error);
      hide_progress(1200);
      return [];
    }

    button.classList.add("djf_stage_complete");
    const skipped_count = outputs.filter((entry) => entry.result?.skipped).length;
    const skip_note = skipped_count ? ` (${skipped_count} skipped)` : "";
    if (failures.length) {
      const failed_names = failures.map((entry) => entry.name.replace(/\.fcs$/i, ""));
      const shown = failed_names.slice(0, 3).join(", ");
      const more = failed_names.length > 3 ? ` and ${failed_names.length - 3} more` : "";
      set_status_bar(
        `DJF Stage ${stage} completed for ${rows.length - failures.length} of ${rows.length} sample(s)${skip_note}; ${failures.length} failed: ${shown}${more}.`,
        true,
      );
    } else {
      set_status_bar(`DJF Stage ${stage} complete for ${rows.length} sample(s)${skip_note}.`);
    }

    // Publish table stats as they become available: each gating stage's event
    // loss the moment that filter runs, and the cell-cycle percentages once the
    // Stage 8 report exists.
    if (stage >= 0 && stage <= 3) {
      write_gating_loss_column(rows, pipeline, stage);
    } else if (stage === 8) {
      write_fraction_columns(rows, pipeline);
    }
    if (!keepOverlay) hide_progress(350);
    return outputs;
  } catch (error) {
    const message = `DJF Stage ${stage} failed: ${error.message}`;
    if (djf_readout) djf_readout.textContent = message;
    set_status_bar(message, true);
    update_progress(100, `DJF Stage ${stage} failed`, error.message);
    hide_progress(1200);
    return [];
  } finally {
    button.classList.remove("djf_stage_running");
    if (!managedByRunAll) {
      pipeline_busy = false;
      set_pipeline_controls_disabled(false);
    }
  }
}

async function run_manual_all() {
  if (!djf_run_all_button || pipeline_busy) return [];
  pipeline_busy = true;
  set_pipeline_controls_disabled(true);
  djf_run_all_button.classList.add("djf_stage_running");
  const originalText = djf_run_all_button.textContent;
  const outputs = [];

  try {
    for (let index = 0; index < MODEL_STAGES.length; index += 1) {
      const stage = MODEL_STAGES[index];
      djf_run_all_button.textContent = `Running Stage ${stage}…`;
      const stageOutputs = await run_manual_stage(stage, djf_stage_buttons[stage], {
        keepOverlay: index < MODEL_STAGES.length - 1,
        openScatter: false,
        managedByRunAll: true,
      });
      if (!stageOutputs.length) break;
      outputs.push(stageOutputs);
    }
    if (outputs.length === MODEL_STAGES.length) {
      djf_run_all_button.classList.add("djf_stage_complete");
      set_status_bar("DJF modeling stages completed.");
    }
    return outputs;
  } finally {
    djf_run_all_button.textContent = originalText;
    pipeline_busy = false;
    set_pipeline_controls_disabled(false);
    djf_run_all_button.classList.remove("djf_stage_running");
  }
}

// ── Pre-model QC gate checkboxes ─────────────────────────────────────────────
// Each checkbox toggles one gating stage (0 Structural, 1 Time, 2 Scatter,
// 3 Singlet). Toggling re-applies only the checked gates, in order, to every
// plotted sample, updates the table loss columns, and re-plots the survivors.

const QC_STAGE_INDICES = [0, 1, 2, 3];
let qc_busy = false;

const is_qc_active = (button) => button?.getAttribute("aria-pressed") === "true";
const set_qc_active = (button, active) => button?.setAttribute("aria-pressed", active ? "true" : "false");

function checked_qc_stages() {
  return QC_STAGE_INDICES.filter((stage) => is_qc_active(qc_gate_buttons[stage]));
}

function set_qc_controls_disabled(disabled) {
  qc_gate_buttons.forEach((button) => { if (button) button.disabled = disabled; });
  if (qc_gate_run_all) qc_gate_run_all.disabled = disabled;
}

// "Run All" reads as active only when every filter is on.
function sync_qc_run_all_state() {
  if (!qc_gate_run_all) return;
  set_qc_active(qc_gate_run_all, checked_qc_stages().length === QC_STAGE_INDICES.length);
}

// Write the checked stages' loss columns (plus the leading total-events column)
// and drop any unchecked stage's column from the table.
function update_qc_columns(rows, pipeline, checked) {
  const frame = get_file_table();
  if (!frame) return;
  const checked_set = new Set(checked);
  const funnel_by_name = new Map();
  for (const row of rows) {
    const funnel = pipeline.pipeline_filter_funnel(row);
    if (funnel) funnel_by_name.set(row.name, funnel);
  }
  const ids = [...frame.col("id")];
  const name_for = (id) => get_file_by_id(id)?.name;

  if (checked.length) {
    write_frame_column(frame, ids, TOTAL_EVENTS_COLUMN, (id) => {
      const funnel = funnel_by_name.get(name_for(id));
      return funnel ? funnel.eventCount.toLocaleString() : undefined;
    });
  } else if (frame.columns.includes(TOTAL_EVENTS_COLUMN)) {
    frame.dropCol(TOTAL_EVENTS_COLUMN);
  }

  QC_LOST_COLUMNS.forEach(({ key, label }, stage) => {
    if (checked_set.has(stage)) {
      write_frame_column(frame, ids, label, (id) => {
        const funnel = funnel_by_name.get(name_for(id));
        if (!funnel) return undefined;
        return format_lost(funnel.filters.find((filter) => filter.key === key));
      });
    } else if (frame.columns.includes(label)) {
      frame.dropCol(label);
    }
  });
  render_file_table();
}

async function apply_qc_selection() {
  if (qc_busy) return;
  const checked = checked_qc_stages();
  const rows = plottable_rows();
  if (!rows.length) {
    set_status_bar("Plot at least one selected sample before applying QC gates.", true);
    return;
  }

  qc_busy = true;
  set_qc_controls_disabled(true);
  try {
    const pipeline = await load_pipeline();
    // Stages 2 and 3 need the companion channels; wait if they are still loading.
    if (checked.some((stage) => stage >= 2)) {
      if (rows.some((row) => row.data && row.data.companionsPending)) {
        set_status_bar("Loading companion channels for QC gating…");
      }
      await ensure_companions_loaded(rows);
    }

    show_progress("Applying pre-model QC");
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      update_progress((100 * index) / rows.length, "Applying pre-model QC", row.name);
      await next_frame();
      pipeline.reset_qc_gates(row);
      for (const stage of checked) {
        try {
          pipeline.run_stage(stage, row, {});
        } catch (_) {
          // A gate can't run for this sample (e.g. too few events); leave its
          // mask unset so it simply doesn't filter.
        }
      }
    }

    update_qc_columns(rows, pipeline, checked);
    render_density_plot();
    set_status_bar(checked.length
      ? `Pre-model QC applied: ${checked.map((stage) => QC_LOST_COLUMNS[stage].label.replace(/ lost$/, "")).join(", ")}.`
      : "Pre-model QC cleared.");
    hide_progress(300);
  } catch (error) {
    set_status_bar(`Pre-model QC failed: ${error.message}`, true);
    hide_progress(800);
  } finally {
    qc_busy = false;
    set_qc_controls_disabled(false);
  }
}

function init_premodel_qc() {
  qc_gate_buttons.forEach((button) => {
    if (!button) return;
    button.addEventListener("click", () => {
      set_qc_active(button, !is_qc_active(button));
      sync_qc_run_all_state();
      apply_qc_selection();
    });
  });
  if (qc_gate_run_all) {
    qc_gate_run_all.addEventListener("click", () => {
      // Toggle every filter: turn all on, or clear them if already all on.
      const turn_on = checked_qc_stages().length !== QC_STAGE_INDICES.length;
      qc_gate_buttons.forEach((button) => set_qc_active(button, turn_on));
      sync_qc_run_all_state();
      apply_qc_selection();
    });
  }
}

export function init_pipeline_ui() {
  if (initialized) return;
  initialized = true;
  init_scatter_modal();
  init_premodel_qc();

  djf_stage_buttons.forEach((button, stage) => {
    if (!button) return;
    if (stage >= IMPLEMENTED_STAGE_COUNT) {
      button.disabled = true;
      button.title = "This stage is enabled by the next pipeline checkpoint.";
      return;
    }
    button.addEventListener("click", () => run_manual_stage(stage, button));
  });

  if (djf_run_all_button) {
    djf_run_all_button.disabled = false;
    djf_run_all_button.title = "Run all nine stages in order for selected samples.";
    djf_run_all_button.addEventListener("click", run_manual_all);
  }
}

export { run_manual_stage, run_manual_all };
