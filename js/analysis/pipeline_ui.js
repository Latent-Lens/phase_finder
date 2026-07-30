// Pre-modeling QC gate toggles: applies the checked gating filters (Structural,
// Time, Cell Gate, Singlet Gate) to every plotted sample, keeps their loss
// columns and the DNA-content histogram current, and owns the Cell Gate inspector
// modal. The Identify Peaks / model workflow that follows QC lives in
// cell_cycle/peak_review_ui.js.

import {
  qc_gate_buttons,
  qc_gate_run_all,
  structural_qc_line,
  structural_qc_summary_name,
  structural_qc_edit,
  time_qc_method_line,
  time_qc_method_name,
  time_qc_method_edit,
  time_qc_summary,
} from "../ui/dom.js";
import {
  get_time_qc_state,
  time_qc_method_options,
  time_qc_method_label,
} from "./time_qc_settings.js";
import { open_time_qc_method_modal, init_time_qc_modal } from "./time_qc_modal.js";
import {
  timeQcDiagnosticAvailable,
  timeQcDiagnosticChannels,
  buildTimeQcDiagnosticModel,
  renderTimeQcDiagnosticSvg,
} from "./time_qc_diagnostic_plot.js";
import {
  get_structural_qc_state,
  structural_qc_state_is_default,
  STRUCTURAL_QC_CEILING_CHANNELS,
} from "./structural_qc_settings.js";
import { open_structural_qc_modal, init_structural_qc_modal } from "./structural_qc_modal.js";
import { plottable_rows, plot_bin_count, clamp_range_to_analysis_domain } from "../plotting/data.js";
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
import { QC_LOST_COLUMNS, QC_STATUS_COLUMN, TOTAL_EVENTS_COLUMN } from "../data_structs/derived_columns.js";
import { qc_outcome } from "./cell_cycle/result_contract.js";

let initialized = false;

// User-facing names for the four pre-model QC filters (indexes 0-3), matching
// the sidebar toggle labels, so the progress readout can name exactly which
// filters are being applied rather than a generic "Applying pre-model QC".
const QC_FILTER_NAMES = ["Structural", "Time QC", "Cell gate", "Singlet gate"];

/*

Purpose:
	The progress-overlay label naming exactly which QC filters are being applied (or
	"Clearing pre-model QC" when none are checked).

Input:
	checked_filters [array]: the checked QC filter indexes

Output:
	label [string]: the progress label

*/
function qc_progress_label(checked_filters) {
  if (!checked_filters.length) return "Clearing pre-model QC";
  return `Applying QC: ${checked_filters.map((filterIndex) => QC_FILTER_NAMES[filterIndex]).join(", ")}`;
}

export function qc_completion_message(rows, pipeline, checked, method_note = "") {
  const outcomes = rows.flatMap((row) => {
    const state = pipeline.get_state(row.name);
    const products = [state?.structuralQC, state?.timeQC, state?.scatterGate, state?.singletResult];
    return checked.map((filterIndex) => ({
      sample: row.name,
      stage: QC_FILTER_NAMES[filterIndex],
      ...qc_ui_outcome(products[filterIndex]),
    }));
  });
  const incomplete = rows.filter((row) => outcomes.some(
    (outcome) => outcome.sample === row.name && outcome.type !== "success",
  ));
  const failures = outcomes.filter((outcome) => outcome.type === "failed_unexpected");
  return {
    incomplete,
    outcomes,
    failures,
    message: checked.length
      ? failures.length
        ? `Pre-model QC failed for ${failures.length} sample/stage result${failures.length === 1 ? "" : "s"}: ${failures.map((failure) => `${failure.sample} — ${failure.stage}: ${failure.reason}`).join("; ")}. Review the sample/channel data and retry.`
        : incomplete.length
        ? `Pre-model QC incomplete for ${incomplete.length} sample${incomplete.length === 1 ? "" : "s"}; see the QC status column.`
        : `Pre-model QC applied: ${checked.map((filterIndex) => QC_LOST_COLUMNS[filterIndex].label.replace(/ lost$/, "")).join(", ")}.${method_note}`
      : "Pre-model QC cleared.",
  };
}

export function qc_ui_outcome(product) {
  const outcome = qc_outcome(product);
  if (["applied", "passed_no_loss"].includes(outcome.status)) return { type: "success", ...outcome };
  if (["not_run", "unavailable", "skipped_optional"].includes(outcome.status)) return { type: "skipped_expected", ...outcome };
  if (["degraded", "waived"].includes(outcome.status)) return { type: "warning/degraded", ...outcome };
  if (outcome.status === "cancelled") return { type: "cancelled", ...outcome };
  return { type: "failed_unexpected", ...outcome };
}

/*

Purpose:
	Ensures each row's DNA-content histogram (masked DNA-content binning) is
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
	(none) [void]: updates each row's stored DNA-content histogram in place

*/
export function regenerate_histograms(rows, pipeline) {
  let shared_range;
  try {
    // Clamp to the explicit analysis domain so QC-gated histograms (which feed peak
    // detection + fitting) exclude events outside the current x-axis.
    shared_range = clamp_range_to_analysis_domain(pipeline.shared_histogram_range(rows));
  } catch (_) {
    // No row has any retained events yet (e.g. a filter removed everything) —
    // leave histograms unset; the requesting operation's own per-row error
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

/*

Purpose:
	Formats one filter's loss as "count (percent%)" of the events that entered it,
	e.g. "1,905 (4.5%)". A skipped/optional filter (no mask) shows an em dash.

Input:
	filter [object]: a funnel filter entry ({ entered, lost, skipped })

Output:
	text [string]: the formatted loss

*/
function format_lost(filter) {
  if (!filter || filter.skipped) return "—";
  const percent = filter.entered > 0 ? (100 * filter.lost) / filter.entered : 0;
  return `${filter.lost.toLocaleString()} (${percent.toFixed(1)}%)`;
}

/*

Purpose:
	Sets one metadata-frame column from a per-id value function; returning undefined
	for an id leaves that cell as-is, so samples not in this run keep their prior
	value.

Input:
	frame [object]: the metadata frame
	ids [array]: the frame's row ids, in order
	col_name [string]: the column to write
	value_for_id [function]: id -> value (or undefined to skip)

Output:
	(none) [void]: writes the column into the frame

*/
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
// Each checkbox toggles one gating filter (0 Structural, 1 Time, 2 Scatter,
// 3 Singlet). Toggling re-applies only the checked gates, in order, to every
// plotted sample, updates the table loss columns, and re-plots the survivors.

const QC_FILTER_INDICES = [0, 1, 2, 3];
let qc_busy = false;

const is_qc_active = (button) => button?.getAttribute("aria-pressed") === "true";
const set_qc_active = (button, active) => button?.setAttribute("aria-pressed", active ? "true" : "false");

/*

Purpose:
	The QC filter indexes whose toggle buttons are currently pressed.

Input:
	(none)

Output:
	filters [array]: the checked filter indexes (0-3)

*/
function checked_qc_filters() {
  return QC_FILTER_INDICES.filter((filterIndex) => is_qc_active(qc_gate_buttons[filterIndex]));
}

/*

Purpose:
	Enables or disables all QC toggle buttons and the Run All button together (while
	an apply is in flight).

Input:
	disabled [boolean]: whether to disable them

Output:
	(none) [void]

*/
function set_qc_controls_disabled(disabled) {
  qc_gate_buttons.forEach((button) => { if (button) button.disabled = disabled; });
  if (qc_gate_run_all) qc_gate_run_all.disabled = disabled;
}

/*

Purpose:
	Keeps the "Run All" button's pressed state in sync -- active only when every
	filter is on.

Input:
	(none)

Output:
	(none) [void]

*/
function sync_qc_run_all_state() {
  if (!qc_gate_run_all) return;
  set_qc_active(qc_gate_run_all, checked_qc_filters().length === QC_FILTER_INDICES.length);
}

/*

Purpose:
	Writes the checked filters' loss columns (plus the leading total-events column)
	into the metadata table and drops any unchecked filter's column, then re-renders
	the table.

Input:
	rows [array]: the plotted sample rows
	pipeline [object]: the loaded pipeline module
	checked [array]: the checked QC filter indexes

Output:
	(none) [void]: updates and re-renders the metadata table

*/
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
    const products = ["structuralQC", "timeQC", "scatterGate", "singletResult"];
    write_frame_column(frame, ids, QC_STATUS_COLUMN, (id) => {
      const name = name_for(id);
      if (!name) return undefined;
      const state = pipeline.get_state(name);
      for (const filterIndex of checked) {
        const product = state?.[products[filterIndex]];
        if (!product) return `${QC_FILTER_NAMES[filterIndex]} not run`;
        if (product.failed) return `${QC_FILTER_NAMES[filterIndex]} failed: ${product.reason ?? "load error"}`;
        if (product.skipped || product.reviewRequired) {
          return `${QC_FILTER_NAMES[filterIndex]} incomplete: ${product.reason ?? product.status ?? "review required"}`;
        }
      }
      return "Complete";
    });
  } else if (frame.columns.includes(TOTAL_EVENTS_COLUMN)) {
    frame.dropCol(TOTAL_EVENTS_COLUMN);
    if (frame.columns.includes(QC_STATUS_COLUMN)) frame.dropCol(QC_STATUS_COLUMN);
  }

  QC_LOST_COLUMNS.forEach(({ key, label }, filterIndex) => {
    if (checked_set.has(filterIndex)) {
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

// ── Time QC method line + result summary ─────────────────────────────────────
// Time QC is the only QC filter with a choice of algorithm, so it is
// the only one that reports which method ran and what that method removed.
// See docs/plans/peak_tracking_time_qc_implementation_spec.md ("Result summary").

const TIME_QC_FILTER_INDEX = 1;
// Removal fractions (of the events that entered Time QC) that warrant a warning
// and, above the second, an explicit review before modeling continues.
const HIGH_REMOVAL_PERCENT = 20;
const CRITICAL_REMOVAL_PERCENT = 50;

/*

Purpose:
	Shows or hides the Time QC method line under the QC buttons and sets its method
	name, based on whether the Time QC filter is active.

Input:
	(none)

Output:
	(none) [void]

*/
function sync_time_qc_method_line() {
  if (!time_qc_method_line) return;
  const active = is_qc_active(qc_gate_buttons[TIME_QC_FILTER_INDEX]);
  time_qc_method_line.hidden = !active;
  if (time_qc_method_name) time_qc_method_name.textContent = time_qc_method_label();
}

// ── Structural QC settings line ──────────────────────────────────────────────
// Structural QC has no choice of algorithm, only an optional saturation-ceiling
// override (structural_qc_settings.js) -- but like Time QC, turning it on asks
// first (init_premodel_qc's click handler), since a channel repurposed as the
// DNA-content proxy can carry a stale/wrong $PnR that silently deletes a real
// population before the user ever sees a histogram.

const STRUCTURAL_QC_FILTER_INDEX = 0;

/*

Purpose:
	One-line summary of the current saturation-ceiling configuration for the
	"Change…" line: the shipped default, or how many channels were customized.

Input:
	(none)

Output:
	label [string]: e.g. "Default saturation ceilings" or "Custom saturation
	                ceiling (1 channel)"

*/
function structural_qc_summary_label() {
  if (structural_qc_state_is_default()) return "Default saturation ceilings";
  const state = get_structural_qc_state();
  const customized = STRUCTURAL_QC_CEILING_CHANNELS.filter((channel) => {
    const entry = state.ceilings[channel];
    return !entry.enabled || Number.isFinite(entry.override);
  });
  return `Custom saturation ceiling (${customized.length} channel${customized.length === 1 ? "" : "s"})`;
}

/*

Purpose:
	Shows or hides the Structural QC settings line under the QC buttons and sets
	its summary text, based on whether the Structural QC filter is active.

Input:
	(none)

Output:
	(none) [void]

*/
function sync_structural_qc_line() {
  if (!structural_qc_line) return;
  const active = is_qc_active(qc_gate_buttons[STRUCTURAL_QC_FILTER_INDEX]);
  structural_qc_line.hidden = !active;
  if (structural_qc_summary_name) structural_qc_summary_name.textContent = structural_qc_summary_label();
}

/*

Purpose:
	Reads the currently-plotted DNA channels' own recorded $PnR and underlying
	FCS label from the first plotted sample with loaded data, purely so the
	settings dialog can show a "recorded as X, ceiling Y" reference next to each
	channel -- informational only, never a value the dialog writes back.

Input:
	(none)

Output:
	info [object|null]: { DNA_A/DNA_H/DNA_W: { label, pnr } }, or null when no
	                    plotted sample has loaded data yet

*/
function structural_qc_reference_info() {
  const row = plottable_rows().find((candidate) => candidate.data);
  if (!row) return null;
  const info = {};
  for (const channel of STRUCTURAL_QC_CEILING_CHANNELS) {
    const meta = row.data.parameterMetadata?.[channel];
    const pnr = row.data.pnr?.[channel];
    info[channel] = { label: meta?.name || "", pnr: Number.isFinite(pnr) ? pnr : null };
  }
  return info;
}

/*

Purpose:
	HTML-escapes a string for safe interpolation into the summary's innerHTML.

Input:
	value [string]: the text to escape

Output:
	html [string]: the escaped text

*/
function escape_text(value) {
  const element = document.createElement("span");
  element.textContent = value;
  return element.innerHTML;
}

/*

Purpose:
	Renders the Time QC result summary under the QC buttons: which method ran,
	how many events it evaluated and removed, how many acquisition regions were
	rejected and why, plus any warnings the method raised (too few events, an
	excluded channel, excessive removal).

	Counts come from the pipeline filter funnel rather than the operation result, so
	"removed" means events this filter removed -- not events Structural QC had
	already dropped.

Input:
	rows [array]: plotted sample rows
	pipeline [object]: the loaded pipeline module
	checked [array]: currently applied QC filter indexes

Output:
	critical [boolean]: true when any sample lost more than half its events here

*/
function render_time_qc_summary(rows, pipeline, checked) {
  if (!time_qc_summary) return false;
  if (!checked.includes(TIME_QC_FILTER_INDEX)) {
    time_qc_summary.hidden = true;
    time_qc_summary.innerHTML = "";
    return false;
  }

  let entered = 0;
  let removed = 0;
  let regions = 0;
  let skipped = 0;
  const reason_counts = new Map();
  const warnings = new Set();
  let worst_percent = 0;

  for (const row of rows) {
    const funnel = pipeline.pipeline_filter_funnel(row);
    const filter = funnel?.filters.find((entry) => entry.key === "timeQC");
    const result = pipeline.get_state(row.name)?.timeQC;
    if (result?.skipped) skipped += 1;
    if (filter && !filter.skipped) {
      entered += filter.entered;
      removed += filter.lost;
      if (filter.entered > 0) {
        worst_percent = Math.max(worst_percent, (100 * filter.lost) / filter.entered);
      }
    }
    if (!result) continue;

    // Peak-tracking reports rejected acquisition regions; robust-summary
    // reports merged flagged intervals. Both are "a contiguous stretch of
    // acquisition that was removed", and both are counted per reason -- a
    // region rejected for two reasons counts once under each, which is why the
    // reason counts can exceed the region total.
    const rejected = Array.isArray(result.rejectedRegions)
      ? result.rejectedRegions
      : (Array.isArray(result.flaggedIntervals) ? result.flaggedIntervals : []);
    regions += rejected.length;
    for (const region of rejected) {
      for (const reason of region.reasons || []) {
        reason_counts.set(reason, (reason_counts.get(reason) || 0) + 1);
      }
    }
    for (const warning of result.warnings || []) warnings.add(warning);
  }

  if (skipped === rows.length && rows.length > 0) {
    time_qc_summary.hidden = false;
    time_qc_summary.className = "time_qc_summary";
    time_qc_summary.innerHTML =
      `<p class="time_qc_summary_head">${escape_text(time_qc_method_label())}</p>`
      + `<p class="time_qc_summary_row">Skipped: no Time channel is loaded for these samples.</p>`;
    return false;
  }

  const percent = entered > 0 ? (100 * removed) / entered : 0;
  const critical = worst_percent > CRITICAL_REMOVAL_PERCENT;
  const high = worst_percent > HIGH_REMOVAL_PERCENT;

  const reason_text = [...reason_counts.entries()]
    .map(([reason, count]) => `${escape_text(reason)}: ${count.toLocaleString()} region${count === 1 ? "" : "s"}`)
    .join(" · ");

  const parts = [
    `<p class="time_qc_summary_head">${escape_text(time_qc_method_label())}</p>`,
    `<p class="time_qc_summary_row">Events evaluated: <strong>${entered.toLocaleString()}</strong></p>`,
    `<p class="time_qc_summary_row">Events removed: <strong>${removed.toLocaleString()}</strong> (${percent.toFixed(2)}%)</p>`,
    `<p class="time_qc_summary_row">Acquisition regions removed: <strong>${regions.toLocaleString()}</strong></p>`,
  ];
  if (reason_text) parts.push(`<p class="time_qc_summary_reasons">${reason_text}</p>`);
  if (!removed) {
    parts.push('<p class="time_qc_summary_row">No acquisition regions exceeded the selected thresholds.</p>');
  }
  for (const warning of warnings) {
    parts.push(`<p class="time_qc_summary_warning">⚠ ${escape_text(warning)}</p>`);
  }

  // Phase 2 acquisition-order diagnostic (peak-tracking only): the first plotted
  // sample that carries peak-tracking diagnostics gets a collapsible plot of its
  // tracked peak positions across acquisition, with rejected regions shaded and
  // segment boundaries drawn, plus a channel picker. Everything is guarded so a
  // diagnostic failure can never break the summary itself.
  let diag_result = null;
  let diag_name = "";
  try {
    for (const row of rows) {
      const candidate = pipeline.get_state(row.name)?.timeQC;
      if (timeQcDiagnosticAvailable(candidate)) {
        diag_result = candidate;
        diag_name = row.name;
        break;
      }
    }
    if (diag_result) parts.push(diagnostic_markup(diag_result, diag_name));
  } catch (_) {
    diag_result = null;
  }

  time_qc_summary.hidden = false;
  time_qc_summary.className = `time_qc_summary${critical ? " time_qc_summary__critical" : high ? " time_qc_summary__high" : ""}`;
  time_qc_summary.innerHTML = parts.join("");

  if (diag_result) {
    try {
      wire_diagnostic_channel_picker(diag_result);
    } catch (_) {
      /* leave the static default-channel plot in place */
    }
  }
  return critical;
}

/*

Purpose:
	Builds the collapsible acquisition-order diagnostic block for one sample's
	peak-tracking result: a channel picker and the rendered SVG for the first
	channel. Returns "" if the result has nothing to draw.

Input:
	result [object]: a peak-tracking Time QC result
	sampleName [string]: the sample the diagnostic is for

Output:
	markup [string]: the <details> block, or "" when there is no data

*/
function diagnostic_markup(result, sampleName) {
  const channels = timeQcDiagnosticChannels(result);
  if (!channels.length) return "";
  const model = buildTimeQcDiagnosticModel(result, { channel: channels[0] });
  if (!model.hasData) return "";

  const options = channels
    .map((channel) => `<option value="${escape_text(channel)}">${escape_text(channel)}</option>`)
    .join("");
  return (
    `<details class="tqc_diag_details">` +
    `<summary>Acquisition-order diagnostic — ${escape_text(sampleName)}</summary>` +
    `<div class="tqc_diag_controls">` +
    `<label class="tqc_diag_channel_label">Channel ` +
    `<select class="tqc_diag_channel">${options}</select></label>` +
    `<span class="tqc_diag_legend">line = tracked peak · hollow point = imputed bin · shaded = rejected region · vertical rule = segment boundary</span>` +
    `</div>` +
    `<div class="tqc_diag_host">${renderTimeQcDiagnosticSvg(model)}</div>` +
    `</details>`
  );
}

/*

Purpose:
	After the summary HTML is placed, connects the diagnostic's channel <select>
	so choosing a channel re-renders just the SVG host from the retained result.

Input:
	result [object]: the peak-tracking Time QC result the block was built from

Output:
	(none) [void]

*/
function wire_diagnostic_channel_picker(result) {
  const select = time_qc_summary.querySelector(".tqc_diag_channel");
  const host = time_qc_summary.querySelector(".tqc_diag_host");
  if (!select || !host) return;
  select.addEventListener("change", () => {
    const model = buildTimeQcDiagnosticModel(result, { channel: select.value });
    host.innerHTML = renderTimeQcDiagnosticSvg(model);
  });
}

/*

Purpose:
	Applies the currently checked QC filters to every plotted sample from a clean
	slate: loads the pipeline, (re)runs each checked filter per row, rebuilds the
	histograms, updates the loss columns and Time QC summary, re-plots, and warns
	when Time QC removed a critical share of events.

Input:
	(none)

Output:
	(none) [Promise<void>]

*/
async function apply_qc_selection() {
  if (qc_busy) return;
  const checked = checked_qc_filters();
  const rows = plottable_rows();
  if (!rows.length) {
    set_status_bar("Plot at least one selected sample before applying QC gates.", true);
    return;
  }

  qc_busy = true;
  set_qc_controls_disabled(true);
  let progress_operation = null;
  try {
    const pipeline = await load_pipeline();
    // Time, Cell, and Singlet QC need companion channels; wait if they are still loading.
    if (checked.some((filterIndex) => filterIndex >= 1)) {
      if (rows.some((row) => row.data && row.data.companionsPending)) {
        set_status_bar("Loading companion channels for QC gating…");
      }
      await ensure_companions_loaded(rows);
    }

    const progress_label = qc_progress_label(checked);
    progress_operation = show_progress(progress_label);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      update_progress((100 * index) / rows.length, progress_label, row.name, "", progress_operation);
      await next_frame();
      pipeline.reset_qc_gates(row);
      for (const filterIndex of checked) {
        try {
          // Every gate reuses a cache instead of recomputing from scratch on each
          // Apply. Structural QC and Time QC reuse the eager background precompute
          // (see schedule_qc_precompute below); the Cell and Singlet gates cache
          // their fit keyed on the composed input mask + options, so re-applying
          // after only a downstream change reuses the prior fit and only the
          // genuinely-affected gate re-fits.
          if (filterIndex === 0) pipeline.apply_structural_qc_fast(row);
          // Time QC runs whichever Time QC method is currently selected
          // (time_qc_settings.js); its options are part of the operation's cache
          // key, so switching methods recomputes instead of reusing the other one.
          else if (filterIndex === 1) pipeline.apply_time_qc_fast(row, time_qc_method_options());
          else if (filterIndex === 2) pipeline.apply_cell_gate_fast(row);
          else pipeline.apply_singlet_gate_fast(row);
        } catch (error) {
          pipeline.record_qc_failure(row, filterIndex, error);
          console.error(`QC failed for ${row.name} at ${QC_FILTER_NAMES[filterIndex]}`, error);
          break;
        }
      }
    }

    // Keep each sample's histogram in sync with whichever gates are now
    // applied (or none), at the current Bins value, so Identify Peaks / Model
    // DJF always read fresh, correctly filtered bins without a separate
    // manual "build the histogram" step.
    regenerate_histograms(rows, pipeline);
    const requiredQc = checked.map((filterIndex) => ["structural", "time", "scatter", "singlet"][filterIndex]);
    rows.forEach((row) => {
      const state = pipeline.get_state(row.name);
      if (state) state.requiredQc = requiredQc;
    });

    update_qc_columns(rows, pipeline, checked);
    sync_structural_qc_line();
    sync_time_qc_method_line();
    const critical_removal = render_time_qc_summary(rows, pipeline, checked);
    render_density_plot();
    const method_note = checked.includes(TIME_QC_FILTER_INDEX) ? ` (Time QC: ${time_qc_method_label()})` : "";
    const completion = qc_completion_message(rows, pipeline, checked, method_note);
    set_status_bar(completion.message, completion.incomplete.length > 0, null, progress_operation);
    hide_progress(300, progress_operation);
    // Above half the events removed, the spec requires review rather than
    // silently carrying on into modeling.
    if (critical_removal) {
      set_status_bar(
        `Time QC removed more than ${CRITICAL_REMOVAL_PERCENT}% of the events for at least one sample. Review the Time QC summary before modeling.`,
        true, null, progress_operation,
      );
    }
  } catch (error) {
    console.error("Pre-model QC failed before per-stage completion", error);
    set_status_bar(`Pre-model QC failed: ${error.message}`, true, null, progress_operation, error);
    hide_progress(800, progress_operation);
  } finally {
    qc_busy = false;
    set_qc_controls_disabled(false);
  }
}

/*

Purpose:
	Opens the interactive FSC-A x SSC-A scatter-gate inspector for the first plotted
	sample with a valid (non-skipped) Cell Gate, so the user can review -- and, if
	needed, drag-adjust -- the fitted ellipse. On an edit it re-runs the gate,
	rebuilds the histograms/columns, and re-plots. The only current UI trigger for
	that inspector.

Input:
	(none)

Output:
	(none) [void]

*/
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
      const updated = pipeline.update_cell_gate(inspect_row, edit);
      // The gate edit invalidates every downstream mask for this row; keep
      // its Pre-modeling QC columns and the plot in sync with the new gate.
      regenerate_histograms(rows, pipeline);
      update_qc_columns(rows, pipeline, checked_qc_filters());
      render_density_plot();

      const result = updated.result;
      const action = result.manualOverride ? "Manual cell gate applied" : "Cell gate reset";
      const message = `${action} for ${inspect_row.name.replace(/\.fcs$/i, "")}: ${result.retainedEventCount.toLocaleString()} events retained.`;
      set_status_bar(message);
      return updated;
    },
  });
}

/*

Purpose:
	Programmatically sets the four QC toggles to exactly `filters` (an array of
	filter indexes 0-3) and applies them -- used by session restore to reinstate the
	saved pre-model QC selection before re-fitting. Awaits the apply so callers can
	sequence the histogram rebuild before restoring peaks/fits.

Input:
	filters [array]: the QC filter indexes to enable

Output:
	(none) [Promise<void>]

*/
export async function apply_saved_qc_filters(filters) {
  const wanted = new Set(filters || []);
  qc_gate_buttons.forEach((button, index) => set_qc_active(button, wanted.has(index)));
  sync_qc_run_all_state();
  await apply_qc_selection();
}

/*

Purpose:
	Wires the QC toggle buttons, the Time QC "Change..." link, and the "Run All"
	button: each toggle re-applies the selection (asking Time QC's method dialog when
	turning Time QC on, and opening the Cell Gate inspector when turning the Cell Gate
	on).

Input:
	(none)

Output:
	(none) [void]

*/
function init_premodel_qc() {
  qc_gate_buttons.forEach((button, filterIndex) => {
    if (!button) return;
    button.addEventListener("click", async () => {
      const turning_on = !is_qc_active(button);

      // Structural QC asks about its saturation-ceiling settings first, so a
      // channel repurposed as the DNA-content proxy (and carrying a stale/wrong
      // $PnR) never silently deletes a real population before the user gets a
      // chance to look. Cancelling leaves the filter off.
      if (filterIndex === STRUCTURAL_QC_FILTER_INDEX && turning_on) {
        const before = get_structural_qc_state();
        const chosen = await open_structural_qc_modal({
          applyLabel: "Run Structural QC",
          referenceInfo: structural_qc_reference_info(),
        });
        if (!chosen) return;
        if (JSON.stringify(before) !== JSON.stringify(chosen)) {
          const pipeline = await load_pipeline();
          pipeline.invalidate_qc_precompute_cache();
        }
      }

      // Time QC is the one filter with a choice of algorithm, so turning it on
      // asks which one to run first. Cancelling leaves the filter off rather
      // than quietly applying whichever method happened to be selected.
      if (filterIndex === TIME_QC_FILTER_INDEX && turning_on) {
        const chosen = await open_time_qc_method_modal({ applyLabel: "Run Time QC" });
        if (!chosen) return;
      }

      set_qc_active(button, turning_on);
      sync_qc_run_all_state();
      await apply_qc_selection();
      if (filterIndex === 2 && turning_on) open_cell_gate_inspector();
    });
  });

  // "Change…" under the QC buttons: re-open the dialog for an already-applied
  // Structural QC and re-run it with the new saturation-ceiling settings. Its
  // precompute cache doesn't key by settings the way Time QC's does (see
  // cell_cycle_pipeline.js's qc_precompute_cache), so a real change has to
  // invalidate it explicitly or the stale, unsettings-aware result would keep
  // getting reused.
  structural_qc_edit?.addEventListener("click", async () => {
    const before = get_structural_qc_state();
    const chosen = await open_structural_qc_modal({
      applyLabel: "Apply",
      referenceInfo: structural_qc_reference_info(),
    });
    if (!chosen) return;
    sync_structural_qc_line();
    const unchanged = JSON.stringify(before) === JSON.stringify(chosen);
    if (!unchanged) {
      const pipeline = await load_pipeline();
      pipeline.invalidate_qc_precompute_cache();
      if (is_qc_active(qc_gate_buttons[STRUCTURAL_QC_FILTER_INDEX])) await apply_qc_selection();
    }
  });

  // "Change…" under the QC buttons: re-open the dialog for an already-applied
  // Time QC and re-run it with the new method/settings.
  time_qc_method_edit?.addEventListener("click", async () => {
    const before = get_time_qc_state();
    const chosen = await open_time_qc_method_modal({ applyLabel: "Apply" });
    if (!chosen) return;
    sync_time_qc_method_line();
    const unchanged = JSON.stringify(before) === JSON.stringify(chosen);
    if (!unchanged && is_qc_active(qc_gate_buttons[TIME_QC_FILTER_INDEX])) await apply_qc_selection();
  });
  if (qc_gate_run_all) {
    qc_gate_run_all.addEventListener("click", async () => {
      // Toggle every filter: turn all on, or clear them if already all on.
      const turn_on = checked_qc_filters().length !== QC_FILTER_INDICES.length;
      if (turn_on) {
        const chosen = await open_time_qc_method_modal({ applyLabel: "Run All QC" });
        if (!chosen) return;
      }
      qc_gate_buttons.forEach((button) => set_qc_active(button, turn_on));
      sync_qc_run_all_state();
      await apply_qc_selection();
    });
  }
}

/*

Purpose:
	As soon as a channel finishes plotting, silently loads the pipeline module (no
	progress overlay -- the user hasn't asked for anything yet), eagerly computes
	structural QC and both Time QC variants so the first Pre-model QC click is
	instant, and warms each row's DNA-content histogram so the plot can switch from
	its live first-paint binning (render.js) to the same shared, persisted histogram
	Identify Peaks / Model DJF will read -- all without making the initial "Plot
	Channel Events" click wait on the pipeline module. A no-op for rows whose
	histogram is already current (e.g. the user got there first).

Input:
	(none)

Output:
	(none) [void]: best-effort background work

*/
function schedule_qc_precompute() {
  load_pipeline_silently()
    .then((pipeline) => {
      pipeline.precompute_prefilter_qc(plottable_rows());

      const rows = plottable_rows();
      let shared_range;
      try {
        shared_range = clamp_range_to_analysis_domain(pipeline.shared_histogram_range(rows));
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

/*

Purpose:
	Initializes the pipeline UI once: the scatter modal, the Time QC modal, the
	pre-model QC toggles, the Time QC method line, and the background precompute
	trigger.

Input:
	(none)

Output:
	(none) [void]

*/
export function init_pipeline_ui() {
  if (initialized) return;
  initialized = true;
  init_scatter_modal();
  init_structural_qc_modal();
  init_time_qc_modal();
  init_premodel_qc();
  sync_structural_qc_line();
  sync_time_qc_method_line();
  document.addEventListener("pf-plot-complete", schedule_qc_precompute);
}
