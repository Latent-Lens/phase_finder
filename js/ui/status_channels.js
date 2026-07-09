// Status, progress overlay, loaded-file labels, and channel selector helpers.
// This module creates file ids, writes sidebar and footer status messages, shows
// and hides progress UI, and yields animation frames during long-running work.
// It builds channel selector options from loaded FCS parameter labels and guesses
// likely DNA-area channels for the user. It also converts frames to row objects,
// gathers distinct filter values, reads the selected analysis channel, and
// controls whether action buttons should be enabled. The shared table state
// itself lives in js/data_structs.

import {
  status_el,
  status_bar,
  status_bar_message,
  loaded_files_panel,
  loaded_files_label,
  loaded_files_list,
  file_upload_section,
  drop_zone_title,
  drop_zone_hint,
  progress_overlay,
  progress_fill,
  progress_label,
  progress_percent,
  progress_detail,
  channel_select,
  collapsed_channel_select,
  start_analysis_button,
  collapsed_plot_button,
  metadata_add_column_button,
  metadata_import_button,
  metadata_parse_button,
  metadata_export_button,
} from "./dom.js";
import { escape_html } from "../util/html.js";
import { get_file_map, get_file_table } from "../state/app_state.js";
import {
  selected_file_ids,
  column_filters,
  set_sort_state,
  set_open_filter_field,
  loaded_file_count,
} from "../data_structs/table_state.js";

/*

Purpose:
	Generates a unique id for a loaded file, using crypto.randomUUID when
	available and a timestamp+random fallback otherwise.

Input:
	(none)

Output:
	id [string]: a unique file identifier

*/
export function create_id() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `file-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/*

Purpose:
	Returns the currently selected analysis channels (the DNA-content area
	channel chosen in the sidebar).

Input:
	(none)

Output:
	channels [Object]: { dna_area }

*/
export function get_selected_channels() {
  return {
    dna_area: channel_select.value,
  };
}

/*

Purpose:
	Sets the sidebar status text and toggles its error styling.

Input:
	message [string]:   the status text
	is_error [boolean]: true to apply error styling (default false)

Output:
	(none) [void]: updates the #status element

*/
export function set_status(message, is_error = false) {
  status_el.textContent = message;
  status_el.classList.toggle("error", is_error);
}

/*

Purpose:
	Sets the footer status-bar text and toggles its error styling.

Input:
	message [string]:   the status-bar text
	is_error [boolean]: true to apply error styling (default false)

Output:
	(none) [void]: updates the status bar

*/
export function set_status_bar(message, is_error = false) {
  status_bar_message.textContent = message;
  status_bar.classList.toggle("error", is_error);
}

/*

Purpose:
	Updates the read-only sidebar list of loaded FCS filenames.

Input:
	(none)

Output:
	(none) [void]: updates and shows/hides the loaded-file list

*/
export function update_loaded_files_list() {
  if (!loaded_files_panel || !loaded_files_label || !loaded_files_list) {
    return;
  }

  const file_map = get_file_map();
  const count = file_map.size;
  file_upload_section?.classList.toggle("has_loaded_files", count > 0);
  loaded_files_panel.hidden = count === 0;
  loaded_files_label.textContent = `Loaded FCS files (${count.toLocaleString()})`;

  if (!count) {
    loaded_files_list.value = "";
    return;
  }

  const names = [...file_map.values()].map((entry) => entry.name);
  loaded_files_list.value = names.join("\n");
}

/*

Purpose:
	Updates the drop zone's title and hint to reflect how many files are loaded.

Input:
	(none)

Output:
	(none) [void]: updates the drop zone text

*/
export function update_drop_zone_text() {
  const count = get_file_map().size;
  update_loaded_files_list();

  if (!count) {
    drop_zone_title.textContent = "Drop FCS files here";
    drop_zone_hint.textContent = "or click to choose files from disk";
    drop_zone_hint.hidden = false;
    return;
  }

  drop_zone_title.textContent = "Drop or click to add more files";
  drop_zone_hint.textContent = "";
  drop_zone_hint.hidden = true;
}

/*

Purpose:
	Reveals the progress overlay and resets it to 0%.

Input:
	label [string]: the heading shown in the overlay (default "Loading FCS Metadata")

Output:
	(none) [void]: shows the progress overlay

*/
export function show_progress(label = "Loading FCS Metadata") {
  progress_overlay.hidden = false;
  progress_overlay.setAttribute("aria-busy", "true");
  update_progress(0, label, "Preparing files...");
}

/*

Purpose:
	Updates the progress overlay's bar width, percentage, heading, and detail
	line (optionally with a bold filename).

Input:
	percent [number]:  completion from 0 to 100 (clamped)
	label [string]:    the heading (default "Loading FCS Metadata")
	detail [string]:   the detail line (default "")
	filename [string]: optional filename shown in bold (default "")

Output:
	(none) [void]: updates the progress overlay

*/
export function update_progress(percent, label = "Loading FCS Metadata", detail = "", filename = "") {
  const bounded_percent = Math.max(0, Math.min(100, percent));
  progress_fill.style.width = `${bounded_percent}%`;
  progress_label.textContent = label;
  progress_percent.textContent = `${Math.round(bounded_percent)}%`;
  progress_detail.innerHTML = filename
    ? `${escape_html(detail)}<br><strong>${escape_html(filename)}</strong>`
    : escape_html(detail);
}

/*

Purpose:
	Hides the progress overlay after a short delay.

Input:
	delay [number]: milliseconds to wait before hiding (default 500)

Output:
	(none) [void]: hides the progress overlay after the delay

*/
export function hide_progress(delay = 500) {
  window.setTimeout(() => {
    progress_overlay.hidden = true;
    progress_overlay.setAttribute("aria-busy", "false");
  }, delay);
}

/*

Purpose:
	Returns a Promise that resolves on the next animation frame, used to yield
	so the progress UI can paint between steps.

Input:
	(none)

Output:
	frame [Promise<void>]: resolves on the next animation frame

*/
export function next_frame() {
  return new Promise((resolve) => window.requestAnimationFrame(resolve));
}

/*

Purpose:
	Resets the channel selector and all table state (selection, filters, sort,
	open filter menu) back to their empty defaults.

Input:
	(none)

Output:
	(none) [void]: clears the channel selector and table state

*/
export function clear_channel_controls() {
  [channel_select, collapsed_channel_select].forEach((select) => {
    select.innerHTML = "";
    select.add(new Option("", "", true, true));
    select.disabled = true;
  });

  selected_file_ids.clear();
  Object.keys(column_filters).forEach((field) => delete column_filters[field]);
  set_sort_state(null);
  set_open_filter_field(null);
}

/*

Purpose:
	Collects the distinct FCS parameter labels across all loaded files
	(first-seen order) to populate the channel selector.

Input:
	(none)

Output:
	columns [Array<string>]: the distinct parameter labels

*/
export function unique_columns() {
  const seen = new Set();
  const columns = [];

  get_file_map().forEach((entry) => {
    entry.summary.columns.forEach((column) => {
      if (!seen.has(column)) {
        seen.add(column);
        columns.push(column);
      }
    });
  });

  return columns;
}

/*

Purpose:
	Returns the distinct, sorted, non-blank values of a column across all loaded
	files. Used to build the header filter dropdowns.

Input:
	field [string]: the column field key

Output:
	values [Array<string>]: the sorted distinct values

*/
export function unique_column_values(field) {
  const frame = get_file_table();
  if (!frame) return [];
  const seen = new Set();
  const values = [];
  for (const v of frame.col(field)) {
    const str = (v != null && !Number.isNaN(v)) ? String(v).trim() : "";
    if (str && !seen.has(str)) {
      seen.add(str);
      values.push(str);
    }
  }
  values.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  return values;
}

/*

Purpose:
	Fills a <select> with a placeholder option plus one option per column,
	optionally pre-selecting a suggested value.

Input:
	select [HTMLSelectElement]: the select to populate
	columns [Array<string>]:    the option values/labels
	placeholder [string]:       the leading empty option's label
	suggested_value [string]:   value to pre-select, if present (default "")

Output:
	(none) [void]: replaces the select's options

*/
export function populate_single_select(select, columns, placeholder, suggested_value = "") {
  select.innerHTML = "";
  select.disabled = columns.length === 0;
  select.add(new Option(placeholder, "", true, true));

  columns.forEach((column) => {
    select.add(new Option(column, column, column === suggested_value, column === suggested_value));
  });
}

/*

Purpose:
	Picks the first column whose normalized name contains any of the given
	patterns — used to guess a default DNA-content channel.

Input:
	columns [Array<string>]:  the candidate column labels
	patterns [Array<string>]: substrings to look for (case-insensitive)

Output:
	match [string]: the first matching column, or "" if none match

*/
export function suggest_column(columns, patterns) {
  const upper_patterns = patterns.map((pattern) => pattern.toUpperCase());
  return columns.find((column) => {
    const normalized = column.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    return upper_patterns.some((pattern) => normalized.includes(pattern));
  }) || "";
}

/*

Purpose:
	Populates the DNA-content area channel selector from the loaded files'
	parameters, suggesting a likely DNA/area channel.

Input:
	(none)

Output:
	(none) [void]: fills the channel selector

*/
export function populate_channel_controls() {
  const columns = unique_columns();
  const previous = channel_select.value || collapsed_channel_select.value;
  const selected = columns.includes(previous)
    ? previous
    : suggest_column(columns, ["DAPI_A", "DNA_A", "AREA", "_A"]);

  [channel_select, collapsed_channel_select].forEach((select) => {
    populate_single_select(select, columns, "Choose DNA-content area channel", selected);
  });
}

/*

Purpose:
	Selects a value in a <select> only if a matching option exists, and reports
	whether it did.

Input:
	select [HTMLSelectElement]: the select element
	value [string]:             the value to select

Output:
	selected [boolean]: true if the value existed and was selected

*/
export function select_if_option_exists(select, value) {
  if (!value) {
    return false;
  }

  const option = Array.from(select.options).find((candidate) => candidate.value === value);
  if (!option) {
    return false;
  }

  select.value = value;
  return true;
}

/*

Purpose:
	Converts a PhaseFinderFrame to an array of plain row objects, one per row.
	Each object has a key for every column; NaN values pass through as-is.

Input:
	frame [PhaseFinderFrame]: the frame to extract

Output:
	rows [Array<Object>]: one plain object per row

*/
export function frame_to_rows(frame) {
  if (!frame || frame.length === 0) return [];
  const cols = frame.columns;
  const arrays = cols.map((c) => frame.col(c));
  const n = frame.length;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const row = {};
    for (let ci = 0; ci < cols.length; ci++) {
      row[cols[ci]] = arrays[ci][i];
    }
    rows.push(row);
  }
  return rows;
}

/*

Purpose:
	Enables or disables action buttons based on the current channel selection,
	selected rows, and loaded-file count.

Input:
	(none)

Output:
	(none) [void]: updates plot and statistics button disabled states

*/
export function update_start_button_state() {
  const frame = get_file_table();
  const file_map = get_file_map();
  const has_selected_loaded_rows = Boolean(frame && frame.col("id")
    .some((id) => selected_file_ids.has(id) && file_map.has(id)));
  const is_disabled = !channel_select.value || !has_selected_loaded_rows;
  [start_analysis_button, collapsed_plot_button].forEach((button) => {
    if (!button) {
      return;
    }
    button.disabled = is_disabled;
  });

  const has_files = loaded_file_count() > 0;
  const has_table_rows = Boolean(frame && frame.length > 0);
  ["#calculate_stats_button", "#collapsed_calculate_stats_button"].forEach((sel) => {
    const btn = document.querySelector(sel);
    if (btn) btn.disabled = !has_files;
  });
  if (metadata_add_column_button) metadata_add_column_button.disabled = !has_table_rows;
  if (metadata_import_button) metadata_import_button.disabled = !has_table_rows;
  if (metadata_parse_button) metadata_parse_button.disabled = !has_table_rows;
  if (metadata_export_button) metadata_export_button.disabled = !has_table_rows;
}
