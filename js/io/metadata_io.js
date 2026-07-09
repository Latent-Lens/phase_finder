// Metadata and file-table IO for FCS files plus CSV/TSV metadata tables. This
// module loads dropped or selected FCS files at the metadata level by calling the
// FCS HEADER/TEXT reader, rejecting duplicate filenames, extending the metadata
// frame, and registering files for session caching. It also imports external
// metadata tables, matches imported filename rows to loaded FCS entries, and
// preserves unmatched rows as unlinked metadata. Its export path serializes the
// currently visible metadata table as TSV. Plot refresh and background preload
// hooks are triggered here when new files arrive after analysis has started.

import { metadata_import_input } from "../ui/dom.js";
import { display_name, metadata_filename_key } from "../util/names.js";
import { get_file_map, get_file_table, set_file_table } from "../state/app_state.js";
import { make_frame, concat_frames, build_metadata_frame_from_records } from "../data_structs/metadata_frame.js";
import {
  TABLE_COLUMNS,
  selected_file_ids,
  set_metadata_table_columns,
  set_preserve_metadata_row_order,
  should_preserve_metadata_row_order,
  metadata_row_is_linked,
  sync_file_annotations,
  table_base_field_set,
} from "../data_structs/table_state.js";
import {
  metadata_field_from_label,
  unique_metadata_label,
  TABLE_EXPORT_STAT_LABELS,
} from "../data_structs/metadata_columns.js";
import { read_fcs_header } from "../fcs/metadata_processing.js";
import { plot_channels } from "../plotting/data.js";
import { refresh_analysis_after_metadata_change, preload_analysis_rows_in_background } from "./channel_loading.js";
import {
  set_status,
  set_status_bar,
  show_progress,
  update_progress,
  hide_progress,
  next_frame,
  update_drop_zone_text,
  frame_to_rows,
} from "../ui/status_channels.js";
import { sort_file_table, update_views, displayed_files } from "../ui/table_support.js";
import { link_existing_metadata_row_to_loaded_entry, render_file_table } from "../ui/table_render.js";
import {
  can_auto_apply_filename_metadata_template,
  apply_current_filename_metadata_template,
  schedule_metadata_wizard_after_file_load,
} from "../ui/metadata_wizard.js";
import { register_loaded_files } from "../session/file_cache.js";
import { clear_stats_plan } from "../analysis/stats.js";

function has_initialized_plot() {
  return Boolean(plot_channels);
}

async function refresh_downstream_after_file_load() {
  return refresh_analysis_after_metadata_change();
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
export async function load_files(files) {
  const selected_files = Array.from(files || []);
  if (!selected_files.length) {
    return;
  }

  const file_map = get_file_map();
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
      const linked_existing_row = link_existing_metadata_row_to_loaded_entry(entry);
      if (!linked_existing_row) {
        new_tabular_rows.push({
          id: entry.id,
          name: entry.name,
        });
      }
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
    const current_frame = get_file_table();
    set_file_table(current_frame ? concat_frames(current_frame, new_frame) : new_frame);
    if (can_auto_apply_filename_metadata_template()) {
      apply_current_filename_metadata_template({ render: false });
    } else {
      sync_file_annotations();
    }
  } else if (loaded_entries.length) {
    sync_file_annotations();
  }
  if (loaded_entries.length) {
    document.dispatchEvent(new CustomEvent("pf-files-loaded", {
      detail: { count: loaded, names: loaded_entries.map((entry) => entry.name) },
    }));
    // Copy newly loaded files into OPFS in the background so a saved session can
    // auto-restore them on reload. Already-cached files (session restore /
    // reconnect) are skipped inside register_loaded_files.
    register_loaded_files(loaded_entries);
  }
  if (!should_preserve_metadata_row_order()) {
    sort_file_table();
  }
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

  if (loaded_entries.length && has_initialized_plot()) {
    preload_analysis_rows_in_background(loaded_entries).catch((error) => {
      set_status_bar(`Background FCS data load failed: ${error.message}`, true);
    });
  }
}

export function open_metadata_import_picker() {
  const frame = get_file_table();
  if (!frame || frame.length === 0) {
    set_status("Load FCS files or an existing metadata table before importing metadata.", true);
    return;
  }
  if (!metadata_import_input) return;
  metadata_import_input.value = "";
  metadata_import_input.click();
}

function detect_metadata_delimiter(text) {
  const first_line = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).find((line) => line.trim()) || "";
  const tab_count = (first_line.match(/\t/g) || []).length;
  const comma_count = (first_line.match(/,/g) || []).length;
  return tab_count > comma_count ? "\t" : ",";
}

export function parse_delimited_metadata(text, delimiter = detect_metadata_delimiter(text)) {
  const rows = [];
  let row = [];
  let field = "";
  let in_quotes = false;
  const input = String(text || "").replace(/^\uFEFF/, "");

  for (let i = 0; i < input.length; i += 1) {
    const chr = input[i];
    if (in_quotes) {
      if (chr === '"' && input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (chr === '"') {
        in_quotes = false;
      } else {
        field += chr;
      }
      continue;
    }

    if (chr === '"') {
      in_quotes = true;
    } else if (chr === delimiter) {
      row.push(field);
      field = "";
    } else if (chr === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (chr === "\r") {
      // Ignore CR in CRLF input.
    } else {
      field += chr;
    }
  }

  row.push(field);
  rows.push(row);
  while (rows.length && rows[rows.length - 1].every((value) => String(value || "").trim() === "")) {
    rows.pop();
  }
  if (!rows.length) return { headers: [], records: [], delimiter };

  const headers = rows[0].map((value) => String(value || "").trim());
  const records = rows.slice(1).map((values) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = values[index] ?? "";
    });
    return record;
  });
  return { headers, records, delimiter };
}

function normalized_metadata_header(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function find_metadata_filename_column(headers) {
  const preferred = new Set([
    "filename",
    "file",
    "fileid",
    "fcs",
    "fcsfile",
    "fcsfilename",
    "samplename",
    "sample",
    "name",
  ]);
  return headers.find((header) => preferred.has(normalized_metadata_header(header))) || "";
}

export function loaded_file_index_by_metadata_key(rows) {
  const index = new Map();
  rows.forEach((row, row_index) => {
    [row.name, display_name(row.name)].forEach((name) => {
      const key = metadata_filename_key(name);
      if (key && !index.has(key)) index.set(key, row_index);
    });
  });
  return index;
}

function import_metadata_records(parsed, source_name = "metadata file") {
  const frame = get_file_table();
  if (!frame || frame.length === 0) {
    set_status("Load FCS files or an existing metadata table before importing metadata.", true);
    return;
  }

  const filename_header = find_metadata_filename_column(parsed.headers);
  if (!filename_header) {
    set_status_bar("Metadata import failed: no Filename column was found.", true);
    return;
  }

  const used_labels = new Set();
  const used_fields = new Set(["id", "name"]);
  const imported_columns = parsed.headers
    .filter((header) => header && header !== filename_header)
    .map((header) => {
      const label = unique_metadata_label(header, used_labels);
      return {
        field: metadata_field_from_label(label, used_fields),
        label,
        editable: true,
        filterable: true,
        headerEditable: true,
        source: "import",
        source_header: header,
      };
    });

  if (!imported_columns.length) {
    set_status_bar("Metadata import failed: no metadata columns were found after the Filename column.", true);
    return;
  }

  const records = parsed.records.map((record) => {
    const row = { name: record[filename_header] ?? "" };
    imported_columns.forEach((column) => {
      row[column.field] = record[column.source_header] ?? "";
    });
    return row;
  });

  const loaded_rows = frame_to_rows(frame).filter((row) => metadata_row_is_linked(row));
  const result = build_metadata_frame_from_records(records, imported_columns, loaded_rows, { source: "import" });

  set_preserve_metadata_row_order(true);
  clear_stats_plan();
  set_metadata_table_columns(result.columns);
  set_file_table(result.frame);
  selected_file_ids.clear();
  const file_map = get_file_map();
  result.frame.col("id").forEach((id) => {
    if (file_map.has(id)) selected_file_ids.add(id);
  });
  sync_file_annotations();
  render_file_table();
  set_status_bar(
    `Imported ${result.frame.length} metadata row${result.frame.length === 1 ? "" : "s"} from ${source_name}; ` +
    `${result.matched} matched loaded FCS file${result.matched === 1 ? "" : "s"}, ` +
    `${result.unmatched} unmatched.`,
    result.unmatched > 0,
  );
}

export async function handle_metadata_import_file() {
  const file = metadata_import_input?.files?.[0];
  if (!file) return;
  try {
    const parsed = parse_delimited_metadata(await file.text());
    import_metadata_records(parsed, file.name);
  } catch (error) {
    set_status_bar(`Metadata import failed: ${error.message}`, true);
  }
}

/*

Purpose:
	Converts a table cell value to TSV-safe text.

Input:
	value [any]: value to serialize

Output:
	cell [string]: TSV cell text

*/
function tsv_cell(value) {
  if (value == null || Number.isNaN(value)) return "";
  const text = String(value);
  if (!/[\t\r\n"]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

/*

Purpose:
	Builds the TSV header/value column list for the visible metadata table,
	omitting the checkbox column and preserving stats-column order.

Input:
	(none)

Output:
	columns [Array<Object>]: export column definitions

*/
function metadata_export_columns() {
  const columns = TABLE_COLUMNS.map((column) => ({
    header: column.label,
    value: (row) => column.field === "name" ? display_name(row.name) : row[column.field],
  }));

  const frame = get_file_table();
  if (!frame) return columns;

  const base_fields = table_base_field_set();
  frame.columns.forEach((field) => {
    if (base_fields.has(field)) return;
    const sep = field.lastIndexOf(":");
    const header = sep > 0
      ? `${field.slice(0, sep)} ${TABLE_EXPORT_STAT_LABELS[field.slice(sep + 1)] || field.slice(sep + 1)}`
      : field;
    columns.push({ header, value: (row) => row[field] });
  });

  return columns;
}

/*

Purpose:
	Serializes the currently visible metadata table rows to TSV, including
	headers and any summary-stat columns.

Input:
	(none)

Output:
	tsv [string]: tab-separated metadata table text

*/
export function metadata_table_tsv() {
  const columns = metadata_export_columns();
  const rows = displayed_files();
  return [
    columns.map((column) => tsv_cell(column.header)).join("\t"),
    ...rows.map((row) => columns.map((column) => tsv_cell(column.value(row))).join("\t")),
  ].join("\n") + "\n";
}

/*

Purpose:
	Saves a Blob through the File System Access API when available, with an
	anchor-download fallback for browsers that do not expose a save picker.

Input:
	blob [Blob]: file contents
	filename [string]: suggested filename

Output:
	saved [Promise<boolean>]: true when a file was written/downloaded, false when canceled

*/
async function save_blob(blob, filename) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{
          description: "Tab-separated values",
          accept: { "text/tab-separated-values": [".tsv"] },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (error) {
      if (error.name === "AbortError") return false;
      throw error;
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return true;
}

/*

Purpose:
	Exports the visible metadata table, including headers, to a TSV file.

Input:
	(none)

Output:
	(none) [Promise<void>]: prompts the user to save/download a TSV file

*/
export async function handle_metadata_table_export() {
  const frame = get_file_table();
  if (!frame || frame.length === 0) {
    set_status("Load FCS files before exporting the table.", true);
    return;
  }

  const tsv = metadata_table_tsv();
  const blob = new Blob([tsv], { type: "text/tab-separated-values;charset=utf-8" });

  try {
    const saved = await save_blob(blob, "phasefinder_loaded_fcs_samples.tsv");
    if (!saved) return;
    const row_count = displayed_files().length;
    set_status_bar(`Exported metadata table (${row_count} row${row_count === 1 ? "" : "s"}).`);
  } catch (error) {
    set_status(`Could not export metadata table: ${error.message}`, true);
    set_status_bar("Metadata table export failed.", true);
  }
}
