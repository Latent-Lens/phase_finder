// Entry module and application bootstrap for PhaseFinder. Loaded as the single
// <script type="module">, it imports every layer and runs the ordered init_*()
// sequence that replaces the old <script> load-order contract. It owns the
// top-level DOM event wiring (file selection, drag/drop, channel changes, table
// edits, metadata workflows, sidebar toggle, hard restart), the session table
// bridge (get_session_table_state / apply_session_state), and the single
// documented debug hook window.PhaseFinder = { app, pipeline, plot }. Shared file/frame
// state lives in state/app_state.js; this module reads it through accessors.

import {
  file_input,
  drop_zone,
  collapsed_upload_target,
  channel_select,
  collapsed_channel_select,
  file_table,
  sidebar_toggle,
  metadata_add_column_button,
  metadata_import_button,
  metadata_import_input,
  metadata_parse_button,
  metadata_export_button,
  metadata_wizard_modal,
  metadata_wizard_close,
  metadata_wizard_cancel,
  metadata_wizard_apply,
  metadata_wizard_reset,
  metadata_split_steps,
  metadata_add_split_step,
  metadata_column_editor,
} from "./ui/dom.js";
import { get_file_table, set_file_table } from "./state/app_state.js";
import { get_file_by_id, get_parsed_files, get_selected_files } from "./state/files.js";
import { TABLE_COLUMNS, sync_file_annotations, loaded_file_count } from "./data_structs/table_state.js";
import { add_manual_metadata_column } from "./data_structs/metadata_columns.js";
import { init_tooltips, Tooltips } from "./ui/hover_text.js";
import {
  get_selected_channels,
  set_status,
  set_status_bar,
  show_progress,
  update_progress,
  hide_progress,
  next_frame,
  clear_channel_controls,
  update_drop_zone_text,
  update_start_button_state,
  populate_companion_channel_controls,
} from "./ui/status_channels.js";
import { toggle_sidebar, annotation_input_size } from "./ui/table_support.js";
import {
  render_file_table,
  handle_metadata_header_input,
  handle_table_change,
  handle_table_click,
  handle_table_keydown,
  handle_table_dblclick,
  handle_document_click,
  sync_filename_swatches,
} from "./ui/table_render.js";
import {
  open_metadata_wizard,
  close_metadata_wizard,
  apply_metadata_wizard,
  reset_filename_metadata_columns,
  add_metadata_split_step,
  handle_metadata_split_step_input,
  handle_metadata_split_step_click,
  render_metadata_wizard_preview,
  save_filename_metadata_template,
} from "./ui/metadata_wizard.js";
import {
  load_files,
  open_metadata_import_picker,
  handle_metadata_import_file,
  handle_metadata_table_export,
  metadata_table_tsv,
} from "./io/metadata_io.js";
import { get_session_table_state, apply_session_state } from "./session/table_session.js";
import { init_plot_listeners, plot_api } from "./plotting/axis_modal.js";
import { init_plot_toolbar } from "./plotting/plot_toolbar.js";
import { render_density_plot } from "./plotting/render.js";
import { init_analysis_listeners } from "./analysis/start.js";
import { init_pipeline_ui } from "./analysis/pipeline_ui.js";
import { init_peak_review_ui } from "./analysis/cell_cycle/peak_review_ui.js";
import { init_modeling_ui } from "./analysis/cell_cycle/modeling_ui.js";
import { init_bin_settings_sync } from "./analysis/cell_cycle/bin_settings_sync.js";
import { init_cell_cycle_columns } from "./ui/cell_cycle_columns.js";
import { get_pipeline } from "./analysis/pipeline_loader.js";
import { init_stats } from "./analysis/stats.js";
import { init_panel_resize } from "./ui/panel_resize.js";
import { init_remove_columns } from "./ui/column_remove.js";
import { init_session } from "./session/core.js";
import { get_modeling_session_state, apply_modeling_session } from "./session/modeling_session.js";
import { init_unload_guard, suppress_next_unload_warning } from "./session/unload_guard.js";

/*

Purpose:
	Writes an edited annotation input back to its file entry and resizes the
	input to fit. Ignores events from non-annotation inputs.

Input:
	event [Event]: an input event from the file table

Output:
	(none) [void]: updates the file's annotation in place

*/
function update_annotation(event) {
  if (handle_metadata_header_input(event)) {
    return;
  }

  const frame = get_file_table();
  const input = event.target.closest("input[data-file-id][data-field]");
  if (!input || !frame) {
    return;
  }

  const id = input.dataset.fileId;
  const field = input.dataset.field;
  const ids = frame.col("id");
  let idx = -1;
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] === id) { idx = i; break; }
  }
  if (idx < 0) return;

  const new_values = [...frame.col(field)];
  new_values[idx] = input.value;
  frame.setCol(field, new_values);
  input.size = annotation_input_size(input.value);
  sync_file_annotations();
}

function notify_channel_changed() {
  document.dispatchEvent(new CustomEvent("fcs-channel-change"));
}

function open_file_browser() {
  file_input.click();
}

function set_upload_target_dragging(target, is_dragging) {
  target.classList.toggle("dragging", is_dragging);
}

// The logo reloads the page for a clean start. Unlike a real back/forward/
// refresh navigation, this is our own JS-triggered action, so we can show our
// own wording instead of the browser's generic "leave site?" text -- and
// since window.location.reload() is itself a real navigation, it would
// trigger the beforeunload guard (see unload_guard.js) a second time right
// after the user already answered this one, so we suppress that.
function hard_restart() {
  if (loaded_file_count() > 0 && !window.confirm(
    "Reload PhaseFinder? Any unsaved session changes will be lost.",
  )) {
    return;
  }
  suppress_next_unload_warning();
  window.location.reload();
}

// ── Debug hook API surface (window.PhaseFinder.app) ──────────────────────────

const app_api = {
  // Non-tabular entry objects (file, summary, event cache) keyed by id.
  get_file_by_id,
  // All entries, used by channel loading for background preload progress tracking.
  get_parsed_files,
  // Selected entries returned as full file_map objects so channel loading can
  // read and mutate file/summary/event-cache fields directly.
  get_selected_files,
  // Tabular source of truth for annotations and stats.
  get_file_table,
  set_file_table,
  get_selected_channels,
  set_status,
  set_status_bar,
  show_progress,
  update_progress,
  hide_progress,
  next_frame,
  // Session save / load API.
  get_session_table_state,
  apply_session_state,
  save_metadata_template: save_filename_metadata_template,
  // Test/automation accessors for the visible metadata table (formerly reached
  // as bare globals when everything shared one classic-script scope).
  metadata_table_tsv,
  get_table_columns: () => TABLE_COLUMNS,
};

/*

Purpose:
	Wires the top-level DOM event listeners and runs the initial table/status
	render. Replaces main.js's former trailing bootstrap lines.

Input:
	(none)

Output:
	(none) [void]: installs listeners and renders the empty initial UI

*/
function init_app_bootstrap() {
  Tooltips.apply_static();

  file_input.addEventListener("change", () => load_files(file_input.files));
  sidebar_toggle.addEventListener("click", toggle_sidebar);
  channel_select.addEventListener("change", () => {
    collapsed_channel_select.value = channel_select.value;
    populate_companion_channel_controls();
    update_start_button_state();
    notify_channel_changed();
  });
  collapsed_channel_select.addEventListener("change", () => {
    channel_select.value = collapsed_channel_select.value;
    populate_companion_channel_controls();
    update_start_button_state();
    notify_channel_changed();
  });

  [drop_zone, collapsed_upload_target].filter(Boolean).forEach((target) => {
    target.addEventListener("click", open_file_browser);

    ["dragenter", "dragover"].forEach((event_name) => {
      target.addEventListener(event_name, (event) => {
        event.preventDefault();
        set_upload_target_dragging(target, true);
      });
    });

    ["dragleave", "drop"].forEach((event_name) => {
      target.addEventListener(event_name, (event) => {
        event.preventDefault();
        set_upload_target_dragging(target, false);
      });
    });

    target.addEventListener("drop", (event) => {
      load_files(event.dataTransfer.files);
    });
  });

  document.querySelector("#site_logo").addEventListener("click", hard_restart);
  file_table.addEventListener("input", update_annotation);
  file_table.addEventListener("change", handle_table_change);
  file_table.addEventListener("click", handle_table_click);
  file_table.addEventListener("dblclick", handle_table_dblclick);
  file_table.addEventListener("keydown", handle_table_keydown);
  metadata_parse_button?.addEventListener("click", open_metadata_wizard);
  metadata_add_column_button?.addEventListener("click", add_manual_metadata_column);
  metadata_import_button?.addEventListener("click", open_metadata_import_picker);
  metadata_import_input?.addEventListener("change", handle_metadata_import_file);
  metadata_export_button?.addEventListener("click", handle_metadata_table_export);
  metadata_wizard_close?.addEventListener("click", close_metadata_wizard);
  metadata_wizard_cancel?.addEventListener("click", close_metadata_wizard);
  metadata_wizard_apply?.addEventListener("click", apply_metadata_wizard);
  metadata_wizard_reset?.addEventListener("click", reset_filename_metadata_columns);
  metadata_wizard_modal?.querySelector(".stats_modal_backdrop")?.addEventListener("click", close_metadata_wizard);
  metadata_add_split_step?.addEventListener("click", add_metadata_split_step);
  metadata_split_steps?.addEventListener("input", handle_metadata_split_step_input);
  metadata_split_steps?.addEventListener("change", handle_metadata_split_step_input);
  metadata_split_steps?.addEventListener("click", handle_metadata_split_step_click);
  metadata_column_editor?.addEventListener("input", render_metadata_wizard_preview);
  metadata_column_editor?.addEventListener("change", render_metadata_wizard_preview);
  document.addEventListener("click", handle_document_click);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && metadata_wizard_modal && !metadata_wizard_modal.hidden) {
      close_metadata_wizard();
    }
  });
  // Keeps the metadata table's per-row color swatches in sync with the plot
  // (see plotting/render.js) after every redraw.
  document.addEventListener("pf-plot-rendered", sync_filename_swatches);
  // A peak-region edit (sidebar or plot-overlay drag) commits straight to
  // pipeline state without going through the plot; re-render so the overlay
  // (and the sidebar, which also listens for this) reflect it immediately.
  document.addEventListener("cell-cycle-regions-changed", render_density_plot);

  clear_channel_controls();
  render_file_table();
  update_drop_zone_text();
  set_status("No files loaded.");
  set_status_bar("Ready: Load FCS files by dragging them to the drop zone or using the file selector above.");
}

// ── Ordered bootstrap (replaces the old <script> load-order contract) ─────────

init_tooltips();            // ui/hover_text.js tooltip runtime
init_app_bootstrap();       // main.js event wiring + initial render
init_plot_listeners();      // plotting/axis_modal.js listener block
init_plot_toolbar();        // plotting/plot_toolbar.js pan/zoom/export icon strip
init_analysis_listeners();  // analysis/start.js listener block
init_pipeline_ui();         // analysis/pipeline_ui.js manual stage controls
init_peak_review_ui();      // analysis/cell_cycle/peak_review_ui.js Identify Peaks panel
init_modeling_ui();         // analysis/cell_cycle/modeling_ui.js Model & Fit panel
init_bin_settings_sync();   // analysis/cell_cycle/bin_settings_sync.js Bins-change invalidation + hint
init_cell_cycle_columns();  // ui/cell_cycle_columns.js per-model G1/S/G2-M metadata columns
init_stats();               // analysis/stats.js modal + auto-compute
init_panel_resize();        // ui/panel_resize.js drag handlers
init_remove_columns();      // ui/column_remove.js remove-columns mode
init_session();             // session/core.js wiring + deferred try_autoload
init_unload_guard();        // session/unload_guard.js beforeunload wiring

// The single documented debug/automation/test hook. The staged pipeline is
// lazy-loaded by its manual controls; `djf` remains a compatibility alias.
window.PhaseFinder = {
  app: app_api,
  get djf() { return get_pipeline(); },
  get pipeline() { return get_pipeline(); },
  plot: plot_api,
  // Session modeling persistence (recompute-on-reload): collect the saveable
  // config and re-apply it. Surfaced for the E2E round-trip test.
  session: { collect_modeling: get_modeling_session_state, apply_modeling: apply_modeling_session },
};
