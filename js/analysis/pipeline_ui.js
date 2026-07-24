// Pre-modeling QC gate toggles: applies checked gating stages (Structural,
// Time, Cell Gate, Singlet Gate) to every plotted sample, keeps their loss
// columns and the Stage 4 histogram current, and owns the Cell Gate inspector
// modal. The Identify Peaks / model workflow that follows QC lives in
// cell_cycle/peak_review_ui.js.

import {
  qc_gate_buttons,
  qc_gate_run_all,
} from "../ui/dom.js";
import { plottable_rows, plot_bin_count, clamp_range_to_axis_override } from "../plotting/data.js";
import { render_density_plot } from "../plotting/render.js";
import {
  set_status_bar,
  show_progress,
  update_progress,
  hide_progress,
  next_frame,
} from "../ui/status_channels.js";
import { load_pipeline, load_pipeline_silently, get_pipeline } from "./pipeline_loader.js";
import { init_scatter_modal, open_scatter_modal } from "./scatter_modal.js";
import { get_file_table } from "../state/app_state.js";
import { get_file_by_id } from "../state/files.js";
import { render_file_table } from "../ui/table_render.js";
import { ensure_companions_loaded } from "../io/channel_loading.js";
import { QC_LOST_COLUMNS, TOTAL_EVENTS_COLUMN } from "../data_structs/derived_columns.js";

let initialized = false;

// User-facing names for the four pre-model QC stages (indexes 0-3), matching
// the sidebar toggle labels, so the progress readout can name exactly which
// filters are being applied rather than a generic "Applying pre-model QC".
const QC_STAGE_NAMES = ["Structural", "Time QC", "Cell gate", "Singlet gate"];

function qc_progress_label(checked_stages) {
  if (!checked_stages.length) return "Clearing pre-model QC";
  return `Applying QC: ${checked_stages.map((stage) => QC_STAGE_NAMES[stage]).join(", ")}`;
}

/*

Purpose:
	Ensures each row's Stage 4 histogram (masked DNA-content binning) is
	current at the current Bins control value, using a range shared across
	every row so they stay comparable. Rows whose histogram already matches the
	requested bins/range/gated-view revision are left untouched instead of
	being unconditionally rebuilt. Called after any Pre-model QC change (so the
	histogram always reflects whatever gates are currently applied) and lazily
	before Identify Peaks / Model DJF (so those always have a fresh histogram
	to read, even if QC was never touched).

Input:
	rows [array]: plottable sample rows to rebuild histograms for
	pipeline [object]: the loaded DJF pipeline module

Output:
	(none) [void]: updates each row's stored Stage 4 histogram in place

*/
export function regenerate_histograms(rows, pipeline) {
  let shared_range;
  try {
    // Clamp to the visible x-range so QC-gated histograms (which feed peak
    // detection + fitting) exclude events outside the current x-axis.
    shared_range = clamp_range_to_axis_override(pipeline.shared_histogram_range(rows));
  } catch (_) {
    // No row has any retained events yet (e.g. a filter removed everything) —
    // leave histograms unset; the requesting stage's own per-row error
    // handling will report it.
    return;
  }
  for (const row of rows) {
    try {
      pipeline.ensure_histogram_current(row, { binCount: plot_bin_count(), range: shared_range });
    } catch (_) {
      // This sample has nothing left to histogram; skip it.
    }
  }
}

// "1,905 (4.5%)" — count removed by the filter and its share of the events that
// entered that stage. A skipped/optional filter (no mask) shows an em dash.
function format_lost(filter) {
  if (!filter || filter.skipped) return "—";
  const percent = filter.entered > 0 ? (100 * filter.lost) / filter.entered : 0;
  return `${filter.lost.toLocaleString()} (${percent.toFixed(1)}%)`;
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

    const progress_label = qc_progress_label(checked);
    show_progress(progress_label);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      update_progress((100 * index) / rows.length, progress_label, row.name);
      await next_frame();
      pipeline.reset_qc_gates(row);
      for (const stage of checked) {
        try {
          // Stages 0-1 reuse the eager background precompute (see
          // schedule_qc_precompute below) instead of recomputing from
          // scratch on every toggle; Stages 2-3 still run fresh each time.
          if (stage === 0) pipeline.run_stage0_fast(row);
          else if (stage === 1) pipeline.run_stage1_fast(row);
          else pipeline.run_stage(stage, row, {});
        } catch (_) {
          // A gate can't run for this sample (e.g. too few events); leave its
          // mask unset so it simply doesn't filter.
        }
      }
    }

    // Keep each sample's histogram in sync with whichever gates are now
    // applied (or none), at the current Bins value, so Identify Peaks / Model
    // DJF always read fresh, correctly filtered bins without a separate
    // manual "build the histogram" step.
    regenerate_histograms(rows, pipeline);

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

// Opens the interactive FSC-A x SSC-A scatter-gate inspector for the first
// plotted sample with a valid (non-skipped) Stage 2 gate, so the user can
// review — and, if needed, drag-adjust — the ellipse the Cell Gate filter
// just fitted. This is the only current UI trigger for that inspector.
function open_cell_gate_inspector() {
  const pipeline = get_pipeline();
  if (!pipeline) return;
  const rows = plottable_rows();
  const inspect_row = rows.find((row) => {
    const state = pipeline.get_state(row.name);
    return state?.scatterGate && !state.scatterGate.skipped;
  });
  if (!inspect_row) return;

  open_scatter_modal(inspect_row, pipeline.get_state(inspect_row.name).scatterGate, {
    onGateChange: (edit) => {
      const updated = pipeline.update_stage2_gate(inspect_row, edit);
      // The gate edit invalidates every downstream mask for this row; keep
      // its Pre-modeling QC columns and the plot in sync with the new gate.
      regenerate_histograms(rows, pipeline);
      update_qc_columns(rows, pipeline, checked_qc_stages());
      render_density_plot();

      const result = updated.result;
      const action = result.manualOverride ? "Manual Stage 2 gate applied" : "Stage 2 gate reset";
      const message = `${action} for ${inspect_row.name.replace(/\.fcs$/i, "")}: ${result.retainedEventCount.toLocaleString()} events retained.`;
      set_status_bar(message);
      return updated;
    },
  });
}

/**
 * Programmatically set the four QC toggles to exactly `stages` (an array of
 * stage indexes 0-3) and apply them -- used by session restore to reinstate the
 * saved pre-model QC selection before re-fitting. Awaits the apply so callers
 * can sequence the histogram rebuild before restoring peaks/fits.
 */
export async function apply_saved_qc_stages(stages) {
  const wanted = new Set(stages || []);
  qc_gate_buttons.forEach((button, index) => set_qc_active(button, wanted.has(index)));
  sync_qc_run_all_state();
  await apply_qc_selection();
}

function init_premodel_qc() {
  qc_gate_buttons.forEach((button, stage) => {
    if (!button) return;
    button.addEventListener("click", async () => {
      const turning_on = !is_qc_active(button);
      set_qc_active(button, turning_on);
      sync_qc_run_all_state();
      await apply_qc_selection();
      if (stage === 2 && turning_on) open_cell_gate_inspector();
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

// As soon as a channel finishes plotting, silently load the pipeline module
// (no progress overlay — the user didn't ask for anything yet), eagerly
// compute Stage 0 and both Stage 1 variants in the background so the first
// Pre-model QC click is instant, and warm each row's Stage 4 histogram so the
// plot can switch over from its live first-paint binning (render.js) to the
// same shared, persisted histogram Identify Peaks / Model DJF will read —
// without making the initial "Plot Channel Events" click wait on the
// pipeline module. ensure_histogram_current() makes this a no-op for rows
// whose histogram is already current (e.g. the user got there first).
function schedule_qc_precompute() {
  load_pipeline_silently()
    .then((pipeline) => {
      pipeline.precompute_qc_stage01(plottable_rows());

      const rows = plottable_rows();
      let shared_range;
      try {
        shared_range = clamp_range_to_axis_override(pipeline.shared_histogram_range(rows));
      } catch (_) {
        return; // no retained events yet; nothing to histogram
      }
      for (const row of rows) {
        try {
          pipeline.ensure_histogram_current(row, { binCount: plot_bin_count(), range: shared_range });
        } catch (_) {
          // This sample has nothing to histogram; it stays on its live-binned fallback.
        }
      }
      render_density_plot();
    })
    .catch(() => {}); // background best-effort; a real click will retry/report
}

export function init_pipeline_ui() {
  if (initialized) return;
  initialized = true;
  init_scatter_modal();
  init_premodel_qc();
  document.addEventListener("pf-plot-complete", schedule_qc_precompute);
}
