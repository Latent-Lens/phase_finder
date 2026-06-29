const file_input = document.querySelector("#fileInput");
const drop_zone = document.querySelector("#dropZone");
const collapsed_upload_target = document.querySelector("#collapsedUploadTarget");
const drop_zone_title = document.querySelector("#dropZoneTitle");
const drop_zone_hint = document.querySelector("#dropZoneHint");
const status_el = document.querySelector("#status");
const status_bar = document.querySelector("#statusBar");
const status_bar_message = document.querySelector("#statusBarMessage");
const dna_area_select = document.querySelector("#dnaAreaSelect");
const collapsed_dna_area_select = document.querySelector("#collapsedDnaAreaSelect");
const file_table = document.querySelector("#fileTable");
const start_analysis_button = document.querySelector("#startAnalysisButton");
const collapsed_plot_button = document.querySelector("#collapsedPlotButton");
const progress_overlay = document.querySelector("#progressOverlay");
const progress_fill = document.querySelector("#progressFill");
const progress_label = document.querySelector("#progressLabel");
const progress_percent = document.querySelector("#progressPercent");
const progress_detail = document.querySelector("#progressDetail");
const app_shell = document.querySelector(".app");
const sidebar = document.querySelector("#sidebar");
const sidebar_content = document.querySelector("#sidebarContent");
const sidebar_toggle = document.querySelector("#sidebarToggle");
const sidebar_toggle_icon = document.querySelector("#sidebarToggleIcon");

const SIDEBAR_CLOSE_ICON = "./assets/img/sidepanel_close.svg";
const SIDEBAR_OPEN_ICON = "./assets/img/sidepanel_open.svg";
const SIDEBAR_TRANSITION_MS = 220;

// Non-tabular per-file data (File object, FCS header, cached event arrays).
// Analysis code holds references to these entries and mutates them (e.g. row.data).
let file_map = new Map();

// Tabular view of loaded files. Columns: id, name, strain, replicate,
// nocodazoleArrest, timepoint, plus stats columns added by summary_stats.js
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
      const anns = guess_annotations_from_filename(file.name);
      new_tabular_rows.push({
        id: entry.id,
        name: entry.name,
        strain: anns.strain,
        replicate: anns.replicate,
        nocodazoleArrest: anns.nocodazoleArrest,
        timepoint: anns.timepoint,
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
  }
  if (loaded_entries.length) {
    window.PhaseFinderDebug?.saveFilesToCache(loaded_entries.map((e) => e.file));
  }
  sort_file_table();
  update_views();
  update_drop_zone_text();

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
    set_status(`Read metadata from ${loaded} file(s).${downstream_message} Verify extracted strain, timepoint, and replicate data before plotting.`);
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
dna_area_select.addEventListener("change", () => {
  collapsed_dna_area_select.value = dna_area_select.value;
  update_start_button_state();
  notify_channel_changed();
});

collapsed_dna_area_select.addEventListener("change", () => {
  dna_area_select.value = collapsed_dna_area_select.value;
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

// Restart button and the logo both reload the page, clearing all in-memory
// state (loaded files, selections, plot, fits) for a clean start.
// In debug mode the cache is also cleared so files don't auto-restore.
async function hard_restart() {
  await window.PhaseFinderDebug?.clearDebugCache();
  window.location.reload();
}
document.querySelector("#restartButton").addEventListener("click", hard_restart);
document.querySelector("#siteLogo").addEventListener("click", hard_restart);
file_table.addEventListener("input", update_annotation);
file_table.addEventListener("change", handle_table_change);
file_table.addEventListener("click", handle_table_click);
document.addEventListener("click", handle_document_click);

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
    dna_area: dna_area_select.value,
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
};

clear_channel_controls();
render_file_table();
update_drop_zone_text();
set_status("No files loaded.");
set_status_bar("Ready: Load FCS files by dragging them to the drop zone or using the file selector above.");

if (window.PhaseFinderDebug?.isDebugMode()) {
  document.title = "[debug] " + document.title;
  window.PhaseFinderDebug.loadFilesFromCache().then((files) => {
    if (files.length) load_files(files);
  });
}
