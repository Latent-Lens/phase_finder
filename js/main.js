const file_input = document.querySelector("#file_input");
const file_upload_section = document.querySelector("#file_upload_section");
const drop_zone = document.querySelector("#drop_zone");
const collapsed_upload_target = document.querySelector("#collapsed_upload_target");
const drop_zone_title = document.querySelector("#drop_zone_title");
const drop_zone_hint = document.querySelector("#drop_zone_hint");
const loaded_files_panel = document.querySelector("#loaded_files_panel");
const loaded_files_label = document.querySelector("#loaded_files_label");
const loaded_files_list = document.querySelector("#loaded_files_list");
const status_el = document.querySelector("#status");
const status_bar = document.querySelector("#status_bar");
const status_bar_message = document.querySelector("#status_bar_message");
const channel_select = document.querySelector("#channel_select");
const collapsed_channel_select = document.querySelector("#collapsed_channel_select");
const file_table = document.querySelector("#file_table");
const metadata_parse_button = document.querySelector("#metadata_parse_button");
const metadata_export_button = document.querySelector("#metadata_export_button");
const metadata_wizard_modal = document.querySelector("#metadata_wizard_modal");
const metadata_wizard_close = document.querySelector("#metadata_wizard_close");
const metadata_wizard_cancel = document.querySelector("#metadata_wizard_cancel");
const metadata_wizard_apply = document.querySelector("#metadata_wizard_apply");
const metadata_wizard_reset = document.querySelector("#metadata_wizard_reset");
const metadata_split_steps = document.querySelector("#metadata_split_steps");
const metadata_add_split_step = document.querySelector("#metadata_add_split_step");
const metadata_column_editor = document.querySelector("#metadata_column_editor");
const metadata_preview = document.querySelector("#metadata_preview");
const start_analysis_button = document.querySelector("#start_analysis_button");
const collapsed_plot_button = document.querySelector("#collapsed_plot_button");
const progress_overlay = document.querySelector("#progress_overlay");
const progress_fill = document.querySelector("#progress_fill");
const progress_label = document.querySelector("#progress_label");
const progress_percent = document.querySelector("#progress_percent");
const progress_detail = document.querySelector("#progress_detail");
const app_shell = document.querySelector(".app");
const sidebar = document.querySelector("#sidebar");
const sidebar_content = document.querySelector("#sidebar_content");
const sidebar_toggle = document.querySelector("#sidebar_toggle");
const sidebar_toggle_icon = document.querySelector("#sidebar_toggle_icon");

const SIDEBAR_CLOSE_ICON = "./assets/img/sidepanel_close.svg";
const SIDEBAR_OPEN_ICON = "./assets/img/sidepanel_open.svg";
const SIDEBAR_TRANSITION_MS = 220;

// Non-tabular per-file data (File object, FCS header, cached event arrays).
// Analysis code holds references to these entries and mutates them (e.g. row.data).
let file_map = new Map();

// Tabular view of loaded files. Columns: id, name, user-defined filename
// metadata columns, plus stats columns added by summary_stats.js
// in the form "CHANNEL:metric" (e.g. "DAPI-A:mean"). Single source of truth
// for annotation edits and all stats.
let file_table_frame = null;

/*

Purpose:
	Reads only an FCS file's HEADER and TEXT segments to build a loaded-file
	entry (id, name, file, summary, guessed annotations) without loading event
	data.

Input:
	file [File]: the FCS File object

Output:
	entry [Promise<Object>]: resolves to a loaded-file entry

*/
async function read_fcs_header(file) {
  const header_buffer = await file.slice(0, 58).arrayBuffer();
  const header = window.FCSParser.parse_header(header_buffer);

  if (header.text_end < header.text_begin) {
    throw new Error("FCS header has an invalid TEXT segment range.");
  }

  const text_buffer = await file.slice(header.text_begin, header.text_end + 1).arrayBuffer();
  const summary = window.FCSParser.parse_fcs_header_from_segments(header_buffer, text_buffer);

  return {
    id: create_id(),
    name: file.name,
    file,
    summary,
  };
}

/*

Purpose:
	Loads metadata for dropped/selected FCS files: reads each file's header,
	skips duplicates, records failures, sorts and re-renders, and reports the
	outcome through the status/progress UI. Newly loaded files are checked by
	default until plotting has started; after that, they start unchecked.

Input:
	files [FileList|Array<File>]: the files to load

Output:
	(none) [Promise<void>]: loads metadata and updates the UI

*/
function has_initialized_plot() {
  return typeof plot_channels !== "undefined" && Boolean(plot_channels);
}

async function refresh_downstream_after_file_load() {
  if (typeof refresh_analysis_after_metadata_change !== "function") {
    return { refreshed: false, loaded_rows: 0 };
  }
  return refresh_analysis_after_metadata_change();
}

async function load_files(files) {
  const selected_files = Array.from(files || []);
  if (!selected_files.length) {
    return;
  }

  let loaded = 0;
  const loaded_entries = [];
  const new_tabular_rows = [];
  const failures = [];
  const duplicates = [];
  const existing_names = new Set([...file_map.values()].map((e) => e.name));
  const queued_names = new Set();
  show_progress("Loading FCS Metadata");
  update_progress(0, "Loading FCS Metadata", `Preparing ${selected_files.length} file(s)...`);
  await next_frame();

  for (const [index, file] of selected_files.entries()) {
    const current = index + 1;
    const start_percent = (index / selected_files.length) * 100;
    set_status_bar("Working: Loading FCS Metadata");
    update_progress(start_percent, "Loading FCS Metadata", `Reading metadata for file ${current} of ${selected_files.length}`, file.name);
    await next_frame();

    if (existing_names.has(file.name) || queued_names.has(file.name)) {
      duplicates.push(file.name);
      update_progress((current / selected_files.length) * 100, "Loading FCS Metadata", `Skipped duplicate file ${current} of ${selected_files.length}`, file.name);
      await next_frame();
      continue;
    }

    try {
      const entry = await read_fcs_header(file);
      file_map.set(entry.id, entry);
      if (!has_initialized_plot()) {
        selected_file_ids.add(entry.id);
      }
      new_tabular_rows.push({
        id: entry.id,
        name: entry.name,
      });
      queued_names.add(file.name);
      loaded_entries.push(entry);
      loaded += 1;
    } catch (error) {
      failures.push(`${file.name}: ${error.message}`);
    }

    update_progress((current / selected_files.length) * 100, "Loading FCS Metadata", `Finished file ${current} of ${selected_files.length}`, file.name);
    await next_frame();
  }

  if (new_tabular_rows.length) {
    const new_frame = make_frame(new_tabular_rows);
    // concat_frames fills missing columns (e.g. existing stats cols) with null
    // for new rows, which is the correct default until stats are calculated.
    file_table_frame = file_table_frame ? concat_frames(file_table_frame, new_frame) : new_frame;
    apply_current_filename_metadata_template({ render: false });
  }
  if (loaded_entries.length) {
    document.dispatchEvent(new CustomEvent("pf-files-loaded", {
      detail: { count: loaded, names: new_tabular_rows.map((r) => r.name) },
    }));
    // Copy newly loaded files into OPFS in the background so a saved session can
    // auto-restore them on reload. Already-cached files (session restore /
    // reconnect) are skipped inside register_loaded_files.
    window.PhaseFinderSessionFiles?.register_loaded_files(loaded_entries);
  }
  sort_file_table();
  update_views();
  update_drop_zone_text();
  if (loaded) schedule_metadata_wizard_after_file_load();

  let downstream_refresh = { refreshed: false, loaded_rows: 0 };
  if (loaded) {
    try {
      downstream_refresh = await refresh_downstream_after_file_load();
    } catch (error) {
      set_status(`Read metadata from ${loaded} file(s), but the existing plot could not be updated: ${error.message}`, true);
      set_status_bar("Existing plot refresh failed.", true);
      update_progress(100, "Loading Added FCS Data", error.message);
      hide_progress(1400);
      return;
    }
  }

  const final_progress_label = downstream_refresh.refreshed ? "Loading Added FCS Data" : "Loading FCS Metadata";
  const downstream_message = downstream_refresh.refreshed
    ? ` Existing plot updated${downstream_refresh.loaded_rows ? ` with ${downstream_refresh.loaded_rows} added file(s)` : ""}.`
    : "";

  const duplicate_message = duplicates.length
    ? ` Rejected duplicate file${duplicates.length === 1 ? "" : "s"}: ${duplicates.join(", ")}.`
    : "";

  if (loaded && (failures.length || duplicates.length)) {
    const failure_message = failures.length ? ` ${failures.join(" ")}` : "";
    set_status(`Read metadata from ${loaded} file(s).${downstream_message}${duplicate_message}${failure_message}`, true);
    set_status_bar(`Finished with ${failures.length + duplicates.length} issue(s).`, true);
    update_progress(100, final_progress_label, downstream_refresh.refreshed ? "Existing plot updated, with file-load issue(s)." : `Finished with ${failures.length + duplicates.length} issue(s).`);
    hide_progress(900);
  } else if (loaded) {
    set_status(`Read metadata from ${loaded} file(s).${downstream_message} Configure filename metadata columns before plotting if needed.`);
    set_status_bar(downstream_refresh.refreshed ? "Existing plot updated with added FCS data." : `Finished reading metadata from ${loaded} file(s).`);
    update_progress(100, final_progress_label, downstream_refresh.refreshed ? "Existing plot updated with added FCS data." : `Finished reading metadata from ${loaded} file(s).`);
    hide_progress(600);
  } else if (duplicates.length) {
    set_status(`No new files loaded.${duplicate_message}`, true);
    set_status_bar("Duplicate FCS file rejected.", true);
    update_progress(100, "Loading FCS Metadata", "Duplicate FCS file rejected.");
    hide_progress(1200);
  } else {
    set_status(failures.join(" "), true);
    set_status_bar("No metadata could be read.", true);
    update_progress(100, "Loading FCS Metadata", "No metadata could be read.");
    hide_progress(1200);
  }

  if (loaded_entries.length && has_initialized_plot() && typeof preload_analysis_rows_in_background === "function") {
    preload_analysis_rows_in_background(loaded_entries).catch((error) => {
      set_status_bar(`Background FCS data load failed: ${error.message}`, true);
    });
  }

}

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
  const input = event.target.closest("input[data-file-id][data-field]");
  if (!input || !file_table_frame) {
    return;
  }

  const id = input.dataset.fileId;
  const field = input.dataset.field;
  const ids = file_table_frame.col("id");
  let idx = -1;
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] === id) { idx = i; break; }
  }
  if (idx < 0) return;

  const new_values = [...file_table_frame.col(field)];
  new_values[idx] = input.value;
  file_table_frame.setCol(field, new_values);
  input.size = annotation_input_size(input.value);
  sync_file_annotations();
}

/*

Purpose:
	Escapes HTML-special characters in a value so it can be safely interpolated
	into table/markup strings.

Input:
	value [any]: the value to escape (coerced to a string)

Output:
	escaped [string]: the HTML-escaped string

*/
function escape_html(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

window.PhaseFinderTooltips.apply_static();

function notify_channel_changed() {
  document.dispatchEvent(new CustomEvent("fcs-channel-change"));
}

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
const uploadTargets = [drop_zone, collapsed_upload_target].filter(Boolean);

function open_file_browser() {
  file_input.click();
}

function set_upload_target_dragging(target, is_dragging) {
  target.classList.toggle("dragging", is_dragging);
}

uploadTargets.forEach((target) => {
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

// The logo reloads the page for a clean start.
function hard_restart() {
  window.location.reload();
}
document.querySelector("#site_logo").addEventListener("click", hard_restart);
file_table.addEventListener("input", update_annotation);
file_table.addEventListener("change", handle_table_change);
file_table.addEventListener("click", handle_table_click);
metadata_parse_button?.addEventListener("click", open_metadata_wizard);
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

/*

Purpose:
	Returns the currently selected analysis channels (the DNA-content area
	channel chosen in the sidebar).

Input:
	(none)

Output:
	channels [Object]: { dna_area }

*/
function get_selected_channels() {
  return {
    dna_area: channel_select.value,
  };
}

window.PhaseFinderApp = {
  // Non-tabular entry objects (file, summary, event cache) keyed by id.
  get_file_by_id: (id) => file_map.get(id),
  // All entries — used by analysis.js for background preload progress tracking.
  get_parsed_files: () => [...file_map.values()],
  // Selected entries returned as full file_map objects so analysis.js can read
  // and mutate file/summary/event-cache fields directly.
  get_selected_files: () => {
    if (!file_table_frame) return [];
    sync_file_annotations();
    return [...file_table_frame.col("id")]
      .filter((id) => selected_file_ids.has(id))
      .map((id) => file_map.get(id))
      .filter(Boolean);
  },
  // Tabular source of truth for annotations and stats.
  get_file_table: () => file_table_frame,
  set_file_table: (frame) => { file_table_frame = frame; },
  get_selected_channels,
  set_status,
  set_status_bar,
  show_progress,
  update_progress,
  hide_progress,
  next_frame,

  // ── Session save / load API ─────────────────────────────────────────────────

  // Returns a plain-object snapshot of table state for session serialization.
  get_session_table_state() {
    const frame = file_table_frame;
    const ids   = frame ? [...frame.col("id")]   : [];
    const names = frame ? [...frame.col("name")] : [];
    const selected_names = ids
      .map((id, i) => (selected_file_ids.has(id) ? names[i] : null))
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
  },

  // Applies a parsed session's table portion: template, annotations, sort,
  // filters, and row selection.
  apply_session_state({ template, annotations, sort, filters, selected_names }) {
    if (template?.columns?.length) {
      save_filename_metadata_template(template);
      if (file_table_frame) {
        apply_filename_metadata_columns(template, template.columns, {
          render: false,
          preserve_existing: false,
        });
      }
    } else if (template) {
      save_filename_metadata_template(template);
    }

    if (annotations?.length && file_table_frame) {
      const by_name    = new Map(annotations.map((r) => [r.name, r]));
      const cols       = file_table_frame.columns;
      const names_col  = file_table_frame.col("name");
      const col_data   = {};
      for (const col of cols) {
        col_data[col] = [...file_table_frame.col(col)].map((v, i) => {
          if (col === "id" || col === "name") return v;
          const saved = by_name.get(names_col[i]);
          return (saved && Object.prototype.hasOwnProperty.call(saved, col))
            ? saved[col]
            : (v ?? "");
        });
      }
      file_table_frame = new PhaseFinderFrame(col_data, cols);
      sync_file_annotations();
    }

    sort_state = sort?.field
      ? { field: sort.field, direction: sort.direction || "asc" }
      : { field: null, direction: "asc" };

    Object.keys(column_filters).forEach((k) => delete column_filters[k]);
    if (filters) {
      for (const [field, values] of Object.entries(filters)) {
        if (Array.isArray(values) && values.length) {
          column_filters[field] = new Set(values);
        }
      }
    }

    selected_file_ids.clear();
    if (selected_names?.length && file_table_frame) {
      const ids       = [...file_table_frame.col("id")];
      const names_arr = [...file_table_frame.col("name")];
      const name_to_id = new Map(names_arr.map((n, i) => [n, ids[i]]));
      for (const name of selected_names) {
        const id = name_to_id.get(name);
        if (id) selected_file_ids.add(id);
      }
    }

    render_file_table();
    update_start_button_state();
  },

  // Saves the filename-splitting template to localStorage.
  save_metadata_template(template) {
    save_filename_metadata_template(template);
  },
};

clear_channel_controls();
render_file_table();
update_drop_zone_text();
set_status("No files loaded.");
set_status_bar("Ready: Load FCS files by dragging them to the drop zone or using the file selector above.");
