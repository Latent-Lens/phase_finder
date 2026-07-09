// Entry module and application bootstrap for PhaseFinder. Loaded as the single
// <script type="module">, it imports every layer and runs the ordered init_*()
// sequence that replaces the old <script> load-order contract. It owns the
// top-level DOM event wiring (file selection, drag/drop, channel changes, table
// edits, metadata workflows, sidebar toggle, hard restart), the session table
// bridge (get_session_table_state / apply_session_state), and the single
// documented debug hook window.PhaseFinder = { app, djf, plot }. Shared file/frame
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
import { get_file_map, get_file_table, set_file_table } from "./state/app_state.js";
import { get_file_by_id, get_parsed_files, get_selected_files } from "./state/files.js";
import {
  TABLE_COLUMNS,
  selected_file_ids,
  column_filters,
  sort_state,
  set_sort_state,
  set_metadata_table_columns,
  set_preserve_metadata_row_order,
  sync_file_annotations,
} from "./data_structs/table_state.js";
import { PhaseFinderFrame, build_metadata_frame_from_records } from "./data_structs/metadata_frame.js";
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
  frame_to_rows,
} from "./ui/status_channels.js";
import { toggle_sidebar, annotation_input_size } from "./ui/table_support.js";
import {
  render_file_table,
  handle_metadata_header_input,
  handle_table_change,
  handle_table_click,
  handle_document_click,
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
  apply_filename_metadata_columns,
  save_filename_metadata_template,
  filename_metadata_template,
} from "./ui/metadata_wizard.js";
import {
  load_files,
  open_metadata_import_picker,
  handle_metadata_import_file,
  handle_metadata_table_export,
  metadata_table_tsv,
} from "./io/metadata_io.js";
import { init_plot_listeners, plot_api } from "./plotting/axis_modal.js";
import { get_djf } from "./plotting/djf_loader.js";
import { init_analysis_listeners } from "./analysis/start.js";
import { init_stats } from "./analysis/stats.js";
import { init_panel_resize } from "./ui/panel_resize.js";
import { init_session } from "./session/core.js";

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

// The logo reloads the page for a clean start.
function hard_restart() {
  window.location.reload();
}

// ── Session table bridge (imported by session/core.js) ───────────────────────

/*

Purpose:
	Returns a plain-object snapshot of table state for session serialization.

Input:
	(none)

Output:
	state [Object]: selected names, sort, filters, filename template, columns

*/
export function get_session_table_state() {
  const frame = get_file_table();
  const file_map = get_file_map();
  const ids   = frame ? [...frame.col("id")]   : [];
  const names = frame ? [...frame.col("name")] : [];
  const selected_names = ids
    .map((id, i) => (selected_file_ids.has(id) && file_map.has(id) ? names[i] : null))
    .filter(Boolean);
  const filters_plain = {};
  for (const [field, set] of Object.entries(column_filters)) {
    if (set?.size) filters_plain[field] = [...set];
  }
  return {
    selected_names,
    sort: { ...sort_state },
    filters: filters_plain,
    template: filename_metadata_template
      ? JSON.parse(JSON.stringify(filename_metadata_template))
      : null,
    table_columns: TABLE_COLUMNS.map((c) => ({ ...c })),
  };
}

/*

Purpose:
	Applies a parsed session's table portion: template, annotations, sort,
	filters, and row selection.

Input:
	session_table [Object]: { template, columns, annotations, sort, filters, selected_names }

Output:
	(none) [void]: rebuilds the metadata frame and table state

*/
export function apply_session_state({ template, columns, annotations, sort, filters, selected_names }) {
  if (template?.columns?.length) {
    save_filename_metadata_template(template);
    if (get_file_table() && !columns?.length) {
      apply_filename_metadata_columns(template, template.columns, {
        render: false,
        preserve_existing: false,
      });
    }
  } else if (template) {
    save_filename_metadata_template(template);
  }

  const file_map = get_file_map();

  if (columns?.length && annotations?.length) {
    const frame = get_file_table();
    const loaded_rows = frame ? frame_to_rows(frame).filter((row) => file_map.has(row.id)) : [];
    const normalized_columns = columns.map((column) => ({
      field: column.field,
      label: column.label,
      editable: column.editable !== false,
      filterable: column.filterable !== false,
      headerEditable: Boolean(column.headerEditable ?? column.header_editable ?? false),
      source: column.source || "session",
    }));
    const result = build_metadata_frame_from_records(annotations, normalized_columns, loaded_rows, { source: "session" });
    set_preserve_metadata_row_order(true);
    set_metadata_table_columns(result.columns);
    set_file_table(result.frame);
    sync_file_annotations();
  }

  if (annotations?.length && get_file_table()) {
    const frame = get_file_table();
    const by_name    = new Map(annotations.map((r) => [r.name, r]));
    const cols       = frame.columns;
    const names_col  = frame.col("name");
    const col_data   = {};
    for (const col of cols) {
      col_data[col] = [...frame.col(col)].map((v, i) => {
        if (col === "id" || col === "name") return v;
        const saved = by_name.get(names_col[i]);
        return (saved && Object.prototype.hasOwnProperty.call(saved, col))
          ? saved[col]
          : (v ?? "");
      });
    }
    set_file_table(new PhaseFinderFrame(col_data, cols));
    sync_file_annotations();
  }

  if (sort?.field) {
    set_sort_state(sort.field, sort.direction || "asc");
  } else {
    set_sort_state(null);
  }

  Object.keys(column_filters).forEach((k) => delete column_filters[k]);
  if (filters) {
    for (const [field, values] of Object.entries(filters)) {
      if (Array.isArray(values) && values.length) {
        column_filters[field] = new Set(values);
      }
    }
  }

  selected_file_ids.clear();
  const frame = get_file_table();
  if (selected_names?.length && frame) {
    const ids       = [...frame.col("id")];
    const names_arr = [...frame.col("name")];
    const name_to_id = new Map(names_arr.map((n, i) => [n, ids[i]]));
    for (const name of selected_names) {
      const id = name_to_id.get(name);
      if (id) selected_file_ids.add(id);
    }
  }

  render_file_table();
  update_start_button_state();
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
    update_start_button_state();
    notify_channel_changed();
  });
  collapsed_channel_select.addEventListener("change", () => {
    channel_select.value = collapsed_channel_select.value;
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
init_analysis_listeners();  // analysis/start.js listener block
init_stats();               // analysis/stats.js modal + auto-compute
init_panel_resize();        // ui/panel_resize.js drag handlers
init_session();             // session/core.js wiring + deferred try_autoload

// The single documented debug/automation/test hook. `djf` is a getter so it
// reflects the lazily loaded DJF module: it is null until the first correction
// or modeling action loads analysis/djf.js, then returns the numeric API.
window.PhaseFinder = {
  app: app_api,
  get djf() { return get_djf(); },
  plot: plot_api,
};
