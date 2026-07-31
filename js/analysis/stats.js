// Summary-statistics modal and per-file metric workflow. This module lets users
// choose channels and metrics, loads the needed channel arrays, and writes the
// computed values back into the metadata frame as statistic columns. It tracks a
// stats plan so later file loads and session restores can repeat the same
// channel/metric calculations. It updates modal progress while long calculations
// run and reports completion through the status bar. init_stats() (called once by
// the entry bootstrap) wires the modal controls and the file-load auto-compute.
// get_stats_plan/restore_stats_plan/clear_stats_plan are imported directly by the
// session and IO layers.

import { channel_select, collapsed_channel_select } from "../ui/dom.js";
import { get_file_table } from "../state/app_state.js";
import { get_parsed_files, get_file_by_id } from "../state/files.js";
import { set_status_bar, unique_columns } from "../ui/status_channels.js";
import { load_analysis_row } from "../io/channel_loading.js";
import { render_file_table } from "../ui/table_render.js";

const calculate_stats_button = document.querySelector("#calculate_stats_button");
const collapsed_calculate_stats_button = document.querySelector("#collapsed_calculate_stats_button");
const stats_modal = document.querySelector("#stats_modal");
const stats_channel_select = document.querySelector("#stats_channel_select");
const stats_progress_indicator = document.querySelector("#stats_progress_indicator");
const stats_progress_bar = document.querySelector("#stats_progress_bar");
const stats_progress_label = document.querySelector("#stats_progress_label");
const stats_cancel_button = document.querySelector("#stats_cancel_button");
let active_stats_abort = null;

const STAT_LABELS = { mean: "Mean", stddev: "Std Dev", median: "Median", min: "Min", max: "Max" };
const FILE_CONCURRENCY = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2));

export async function map_with_concurrency(items, mapper, limit = FILE_CONCURRENCY, signal = null) {
  const results = Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      if (signal?.aborted) throw new DOMException("Statistics calculation cancelled.", "AbortError");
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

// ── In-memory stats session ─────────────────────────────────────────────────
// Tracks which (channel, metrics) combos have been computed so newly loaded
// files automatically receive the same statistics without any user action.

const stats_session = new Map(); // channel_label -> Set<metric_name>

function record_stats(channel, metrics) {
  if (!stats_session.has(channel)) stats_session.set(channel, new Set());
  for (const m of metrics) stats_session.get(channel).add(m);
}

export function get_stats_plan() {
  return [...stats_session.entries()]
    .filter(([, ms]) => ms.size > 0)
    .map(([channel, ms]) => ({ channel, metrics: [...ms] }));
}

export function restore_stats_plan(entries) {
  if (!Array.isArray(entries)) return;
  for (const { channel, metrics } of entries) {
    if (channel && Array.isArray(metrics) && metrics.length) {
      record_stats(channel, metrics);
    }
  }
}

export function clear_stats_plan() {
  stats_session.clear();
}

// Scans the current frame for "CHANNEL:metric" columns and re-populates
// stats_session. Called on pf-files-loaded so a restored session (whose
// TOML carried a stats_plan) is always reflected in memory.
function rebuild_session_from_frame() {
  const df = get_file_table();
  if (!df) return;
  for (const col of df.columns) {
    const sep = col.lastIndexOf(":");
    if (sep > 0) record_stats(col.slice(0, sep), [col.slice(sep + 1)]);
  }
}

// For each tracked (channel, metrics), load data and compute stats for the
// given files, then write the results back into the frame.
async function compute_stats_for_new_files(new_names) {
  if (!stats_session.size || !new_names?.length) return;

  const name_set = new Set(new_names);
  const all_rows = get_parsed_files();
  const new_rows = all_rows.filter((r) => name_set.has(r.name));
  if (!new_rows.length) return;

  let any_computed = false;

  for (const [channel, metrics_set] of stats_session) {
    const metrics = [...metrics_set];

    const loaded = await map_with_concurrency(new_rows, async (row) => {
      try {
        const data = await load_analysis_row(row, { dna_area: channel }, { activate: false });
        return (data?.dna_a?.length) ? { name: row.name, array: data.dna_a } : null;
      } catch (_) { return null; }
    });

    const valid = loaded.filter(Boolean);
    if (!valid.length) continue;

    const results_by_name = new Map(
      valid.map(({ name, array }) => [name, compute_column_stats(array, metrics)]),
    );

    const frame = get_file_table();
    if (!frame) continue;

    const ids = [...frame.col("id")];
    for (const metric of metrics) {
      const col_name = `${channel}:${metric}`;
      const col = frame.columns.includes(col_name)
        ? [...frame.col(col_name)]
        : Array(ids.length).fill(null);
      ids.forEach((id, i) => {
        const entry = get_file_by_id(id);
        const sr = results_by_name.get(entry?.name);
        if (sr?.[metric] != null) col[i] = sr[metric];
      });
      frame.setCol(col_name, col);
    }
    any_computed = true;
  }

  if (any_computed) {
    render_file_table();
    const channels = [...stats_session.keys()].join(", ");
    set_status_bar(
      `Stats auto-computed for ${new_names.length} newly loaded file(s): ${channels}.`,
    );
  }
}

// ── Column statistics ────────────────────────────────────────────────────────

export function compute_column_stats(typed_array, selected_stats) {
  // Analysis channels now retain the original FCS event order, including
  // invalid acquisition values. Summary statistics must therefore select the
  // structurally usable scalar values instead of allowing one NaN/Infinity to
  // poison every result. Zero is intentionally valid; negative values are not.
  const needs_median = selected_stats.includes("median");
  const values = needs_median ? [] : null;
  let n = 0, sum = 0, min = Infinity, max = -Infinity;
  for (let index = 0; index < typed_array.length; index += 1) {
    const value = Number(typed_array[index]);
    if (!Number.isFinite(value) || value < 0) continue;
    n += 1;
    sum += value;
    if (value < min) min = value;
    if (value > max) max = value;
    values?.push(value);
  }
  if (!n) return null;

  const results = { n };
  const mean = sum / n;

  if (selected_stats.includes("mean")) results.mean = mean;
  if (selected_stats.includes("min")) results.min = min;
  if (selected_stats.includes("max")) results.max = max;

  if (selected_stats.includes("stddev")) {
    let variance = 0;
    for (let index = 0; index < typed_array.length; index += 1) {
      const value = Number(typed_array[index]);
      if (Number.isFinite(value) && value >= 0) { const d = value - mean; variance += d * d; }
    }
    results.stddev = Math.sqrt(variance / n);
  }

  if (needs_median) {
    values.sort((a, b) => a - b);
    const mid = Math.floor(n / 2);
    results.median = n % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid];
  }

  return results;
}

export function open_stats_modal() {
  if (!stats_modal) return;
  const columns = unique_columns();
  const sidebar_channel = channel_select?.value || collapsed_channel_select?.value || "";
  stats_channel_select.innerHTML = "";
  stats_channel_select.add(new Option("Choose a channel", "", true, true));
  columns.forEach((col) => stats_channel_select.add(new Option(col, col)));
  if (columns.includes(sidebar_channel)) {
    stats_channel_select.value = sidebar_channel;
  }
  // Reset disabled state (no channel selected yet → all enabled).
  update_stats_checkboxes();
  if (stats_progress_indicator) {
    stats_progress_indicator.hidden = true;
    stats_progress_indicator.classList.remove("stats_progress__error");
  }
  if (stats_progress_bar) stats_progress_bar.style.width = "0%";
  if (stats_progress_label) stats_progress_label.textContent = "";
  stats_modal.hidden = false;
  stats_channel_select.focus();
}

export function close_stats_modal() {
  active_stats_abort?.abort();
  if (stats_modal) stats_modal.hidden = true;
}

// Disables checkboxes for stats already calculated for the currently selected
// channel.
function update_stats_checkboxes() {
  if (!stats_modal || !stats_channel_select) return;
  const channel = stats_channel_select.value;
  const df = get_file_table();
  const existing_metrics = df
    ? new Set(
        df.columns
          .filter((c) => c.startsWith(channel + ":"))
          .map((c) => c.slice(channel.length + 1))
      )
    : new Set();

  const all_box = stats_modal.querySelector('input[value="all"]');
  const other_boxes = [...stats_modal.querySelectorAll('input[name="stat"]:not([value="all"])')];

  other_boxes.forEach((cb) => {
    const done = existing_metrics.has(cb.value);
    cb.disabled = done;
    if (done) cb.checked = false;
    cb.closest("label").classList.toggle("stats_check__done", done);
  });

  const enabled_boxes = other_boxes.filter((cb) => !cb.disabled);
  const checked_count = enabled_boxes.filter((cb) => cb.checked).length;
  if (all_box) {
    all_box.checked = enabled_boxes.length > 0 && checked_count === enabled_boxes.length;
    all_box.indeterminate = checked_count > 0 && checked_count < enabled_boxes.length;
  }
}

function show_stats_error(msg) {
  if (!stats_progress_indicator) return;
  stats_progress_indicator.hidden = false;
  stats_progress_indicator.classList.add("stats_progress__error");
  if (stats_progress_bar) stats_progress_bar.style.width = "0%";
  if (stats_progress_label) stats_progress_label.textContent = msg;
}

async function run_stats_calculation(calculate_button) {
  const channel_label = stats_channel_select.value;
  if (!channel_label) { show_stats_error("Select a channel first."); return; }

  const other_boxes = [...stats_modal.querySelectorAll('input[name="stat"]:not([value="all"])')];
  const selected_stats = other_boxes.filter((cb) => cb.checked && !cb.disabled).map((cb) => cb.value);
  if (!selected_stats.length) { show_stats_error("Select at least one statistic."); return; }

  // Only compute stats not already in the table for this channel.
  const df = get_file_table();
  const existing_metrics = df
    ? new Set(
        df.columns
          .filter((c) => c.startsWith(channel_label + ":"))
          .map((c) => c.slice(channel_label.length + 1))
      )
    : new Set();
  const new_stats = selected_stats.filter((s) => !existing_metrics.has(s));
  if (!new_stats.length) { show_stats_error("All selected statistics are already in the table."); return; }

  const rows = get_parsed_files();

  if (stats_progress_indicator) {
    stats_progress_indicator.hidden = false;
    stats_progress_indicator.classList.remove("stats_progress__error");
  }
  if (stats_progress_bar) stats_progress_bar.style.width = "0%";
  calculate_button.disabled = true;
  stats_cancel_button.hidden = false;
  const controller = new AbortController();
  active_stats_abort?.abort();
  active_stats_abort = controller;

  try {
    if (stats_progress_label) stats_progress_label.textContent = `Loading ${channel_label} data for ${rows.length} file${rows.length === 1 ? "" : "s"}…`;
    const loaded_data = await map_with_concurrency(rows, async (row) => {
      try {
        const data = await load_analysis_row(row, { dna_area: channel_label }, { activate: false });
        return data?.dna_a?.length
          ? { name: row.name, array: data.dna_a, error: null }
          : { name: row.name, array: null, error: "channel data is empty" };
      } catch (error) {
        return { name: row.name, array: null, error: error?.message || String(error) };
      }
    }, FILE_CONCURRENCY, controller.signal);
    const valid_data = loaded_data.filter(({ array }) => array);
    const failures = loaded_data.filter(({ error }) => error);
    if (!valid_data.length) throw new Error(`No data available for "${channel_label}".`);

    const valid = [];
    for (let index = 0; index < valid_data.length; index += 1) {
      if (controller.signal.aborted) throw new DOMException("Statistics calculation cancelled.", "AbortError");
      const { name, array } = valid_data[index];
      if (stats_progress_label) stats_progress_label.textContent = `Calculating ${new_stats.map((stat) => STAT_LABELS[stat] || stat).join(", ")} for file ${index + 1} of ${valid_data.length}`;
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      const stats = compute_column_stats(array, new_stats);
      if (stats) valid.push({ name, stats });
      if (stats_progress_bar) stats_progress_bar.style.width = `${Math.round(((index + 1) / valid_data.length) * 100)}%`;
    }
    if (!valid.length) throw new Error(`No data computed for "${channel_label}".`);

    const results_by_name = new Map(valid.map(({ name, stats }) => [name, stats]));
    const current_frame = get_file_table();
    if (current_frame) {
      const ids = current_frame.col("id");
      for (const stat of new_stats) {
        const col_name = `${channel_label}:${stat}`;
        current_frame.setCol(col_name, ids.map((id) => {
          const entry = get_file_by_id(id);
          return results_by_name.get(entry?.name)?.[stat] ?? null;
        }));
      }
    }

    render_file_table();
    stats_modal.hidden = true;
    const stat_names = new_stats.map((s) => STAT_LABELS[s] || s).join(", ");
    const partial = failures.length > 0;
    const message = partial
      ? `${stat_names} for ${channel_label} partially complete (${valid.length}/${rows.length} files).`
      : `${stat_names} for ${channel_label} added to the table (${valid.length} file${valid.length === 1 ? "" : "s"}).`;
    set_status_bar(message, partial, null, null,
      partial ? new Error(failures.map(({ name, error }) => `${name}: ${error}`).join("\n")) : null);
    document.dispatchEvent(new CustomEvent("pf-stats-complete", {
      detail: { channel: channel_label, stats: new_stats, files: valid.length, failures },
    }));
  } catch (error) {
    const cancelled = error?.name === "AbortError";
    const message = cancelled ? "Statistics calculation cancelled." : error?.message || "Statistics calculation failed.";
    show_stats_error(message);
    set_status_bar(message, !cancelled, null, null, error);
  } finally {
    calculate_button.disabled = false;
    stats_cancel_button.hidden = true;
    if (active_stats_abort === controller) active_stats_abort = null;
  }
}

/*

Purpose:
	Wires the Calculate Statistics modal controls and the file-load auto-compute
	behavior. Called once by the entry bootstrap.

Input:
	(none)

Output:
	(none) [void]: installs stats-related listeners

*/
export function init_stats() {
  // Record computed stats when the modal calculates them.
  document.addEventListener("pf-stats-complete", (e) => {
    const { channel, stats } = e.detail || {};
    if (channel && stats?.length) record_stats(channel, stats);
  });

  // When files load, rebuild the session from the frame (picks up TOML-restored
  // stats_plan) then auto-compute any tracked stats for the new files.
  document.addEventListener("pf-files-loaded", (e) => {
    rebuild_session_from_frame();
    compute_stats_for_new_files(e.detail?.names).catch(() => {});
  });

  if (stats_modal) {
    // "All" checkbox: toggles all enabled others; individual boxes update All state.
    stats_modal.addEventListener("change", (e) => {
      if (e.target.name !== "stat") return;
      const all_box = stats_modal.querySelector('input[value="all"]');
      const other_boxes = [...stats_modal.querySelectorAll('input[name="stat"]:not([value="all"])')];
      const enabled_boxes = other_boxes.filter((cb) => !cb.disabled);
      if (e.target.value === "all") {
        enabled_boxes.forEach((cb) => { cb.checked = all_box.checked; });
      } else {
        const checked_count = enabled_boxes.filter((cb) => cb.checked).length;
        all_box.checked = enabled_boxes.length > 0 && checked_count === enabled_boxes.length;
        all_box.indeterminate = checked_count > 0 && checked_count < enabled_boxes.length;
      }
    });

    stats_channel_select.addEventListener("change", update_stats_checkboxes);

    stats_modal.querySelector(".stats_modal_backdrop").addEventListener("click", close_stats_modal);
    stats_modal.querySelector("#stats_modal_close").addEventListener("click", close_stats_modal);

    const calculate_button = stats_modal.querySelector("#stats_calculate_button");
    calculate_button.addEventListener("click", () => { run_stats_calculation(calculate_button); });
    stats_cancel_button?.addEventListener("click", () => active_stats_abort?.abort());
  }

  [calculate_stats_button, collapsed_calculate_stats_button].forEach((btn) => {
    if (btn) btn.addEventListener("click", open_stats_modal);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && stats_modal && !stats_modal.hidden) close_stats_modal();
  });
}
