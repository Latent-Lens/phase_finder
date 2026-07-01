// ---------------------------------------------------------------------------
// Lightweight column-store frame used for the metadata and stats table.
// Stores data as a plain object of arrays, one array per column.
// ---------------------------------------------------------------------------

class PhaseFinderFrame {
  /*

  Purpose:
	Creates a column-oriented table frame from prebuilt column arrays and an
	ordered column list.

  Input:
	col_data [Object]: map of column names to arrays
	cols [Array<string>]: ordered column names

  Output:
	frame [PhaseFinderFrame]: initialized frame instance

  */
  constructor(col_data, cols) {
    this._data = col_data; // { colName: Array }
    this._cols = cols;    // ordered column name list
  }

  /*

  Purpose:
	Returns the number of rows in the frame.

  Input:
	(none)

  Output:
	length [number]: row count, or 0 for an empty frame

  */
  get length() {
    return this._cols.length === 0 ? 0 : (this._data[this._cols[0]] || []).length;
  }

  /*

  Purpose:
	Returns the frame's ordered column names.

  Input:
	(none)

  Output:
	columns [Array<string>]: ordered column names

  */
  get columns() {
    return this._cols;
  }

  /*

  Purpose:
	Returns the array backing a named column.

  Input:
	name [string]: column name

  Output:
	values [Array]: column values, or an empty array when the column is absent

  */
  col(name) {
    return this._data[name] || [];
  }

  /*

  Purpose:
	Adds or replaces a named column with the provided values.

  Input:
	name [string]: column name
	values [Array|Iterable]: values to store in the column

  Output:
	(none) [void]: mutates the frame's column data

  */
  setCol(name, values) {
    if (!Object.prototype.hasOwnProperty.call(this._data, name)) {
      this._cols.push(name);
    }
    this._data[name] = Array.isArray(values) ? values : [...values];
  }
}

/*

Purpose:
	Builds a PhaseFinderFrame from row objects by converting each object key
	into a column array.

Input:
	rows [Array<Object>]: plain row objects with shared keys

Output:
	frame [PhaseFinderFrame]: column-oriented frame

*/
function make_frame(rows) {
  if (!rows || !rows.length) return new PhaseFinderFrame({}, []);
  const cols = Object.keys(rows[0]);
  const col_data = Object.fromEntries(cols.map((c) => [c, rows.map((r) => r[c] ?? null)]));
  return new PhaseFinderFrame(col_data, cols);
}

/*

Purpose:
	Appends two PhaseFinderFrame instances, preserving existing column order and
	filling missing columns with null values.

Input:
	frame1 [PhaseFinderFrame]: existing frame
	frame2 [PhaseFinderFrame]: frame to append

Output:
	frame [PhaseFinderFrame]: combined frame

*/
function concat_frames(frame1, frame2) {
  const seen = new Set(frame1.columns);
  const all_cols = [...frame1.columns, ...frame2.columns.filter((c) => !seen.has(c))];
  const n1 = frame1.length;
  const n2 = frame2.length;
  const col_data = Object.fromEntries(
    all_cols.map((col) => [
      col,
      [...(frame1._data[col] ?? Array(n1).fill(null)), ...(frame2._data[col] ?? Array(n2).fill(null))],
    ]),
  );
  return new PhaseFinderFrame(col_data, all_cols);
}

// ---------------------------------------------------------------------------

// Metadata table columns. `name` is the read-only filename. User-defined
// filename-derived columns are appended by the metadata wizard.
const FILENAME_TABLE_COLUMN = { field: "name", label: "Filename", editable: false, filterable: false };
let TABLE_COLUMNS = [FILENAME_TABLE_COLUMN];

// IDs of files whose row checkbox is ticked. Persists across re-renders so
// sorting/filtering don't drop the selection.
const selected_file_ids = new Set();
// field -> Set of values ticked in that column's filter dropdown. A row passes
// the column when the set is empty (no filter) or contains the row's value.
const column_filters = {};
let sort_state = { field: null, direction: "asc" };
// Field whose filter dropdown is currently open, or null. Kept in state so the
// menu stays open across table re-renders triggered by ticking its checkboxes.
let open_filter_field = null;

function metadata_field_from_label(label, used_fields = new Set()) {
  const trimmed = String(label || "").trim();
  const known = {
    filename: "filename",
    strain: "strain",
    replicate: "replicate",
    "nocodazole arrest": "nocodazoleArrest",
    nocodazole: "nocodazoleArrest",
    arrest: "nocodazoleArrest",
    timepoint: "timepoint",
    time: "timepoint",
  };
  const lower = trimmed.toLowerCase();
  let base = known[lower] || lower
    .replace(/[^a-z0-9]+(.)/g, (_, chr) => chr.toUpperCase())
    .replace(/[^a-z0-9]/g, "");
  if (!base || /^\d/.test(base)) base = `metadata${base ? `_${base}` : ""}`;
  if (base === "id" || base === "name") base = `${base}Metadata`;

  let field = base;
  let suffix = 2;
  while (used_fields.has(field)) {
    field = `${base}${suffix}`;
    suffix += 1;
  }
  used_fields.add(field);
  return field;
}

function table_base_field_set() {
  return new Set(["id", ...TABLE_COLUMNS.map((column) => column.field)]);
}

function table_stat_columns() {
  if (!file_table_frame) return [];
  const base_fields = table_base_field_set();
  return file_table_frame.columns.filter((field) => !base_fields.has(field) && field.includes(":"));
}

function set_metadata_table_columns(columns) {
  TABLE_COLUMNS = [FILENAME_TABLE_COLUMN, ...columns];
  Object.keys(column_filters).forEach((field) => {
    if (!TABLE_COLUMNS.some((column) => column.field === field)) {
      delete column_filters[field];
    }
  });
  if (sort_state.field && !TABLE_COLUMNS.some((column) => column.field === sort_state.field)) {
    sort_state = { field: null, direction: "asc" };
  }
  if (open_filter_field && !TABLE_COLUMNS.some((column) => column.field === open_filter_field)) {
    open_filter_field = null;
  }
}

function sync_file_annotations() {
  if (!file_table_frame || typeof file_map === "undefined") return;
  const ids = file_table_frame.col("id");
  const metadata_columns = TABLE_COLUMNS.filter((column) => column.field !== "name");
  ids.forEach((id, index) => {
    const entry = file_map.get(id);
    if (!entry) return;
    const annotations = {};
    metadata_columns.forEach((column) => {
      const value = file_table_frame.col(column.field)[index] ?? "";
      annotations[column.field] = value;
      annotations[column.label] = value;
    });
    entry.annotations = annotations;
  });
}

/*

Purpose:
	Generates a unique id for a loaded file, using crypto.randomUUID when
	available and a timestamp+random fallback otherwise.

Input:
	(none)

Output:
	id [string]: a unique file identifier

*/
function create_id() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `file-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
function set_status(message, is_error = false) {
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
function set_status_bar(message, is_error = false) {
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
function update_loaded_files_list() {
  if (!loaded_files_panel || !loaded_files_label || !loaded_files_list) {
    return;
  }

  const count = file_map.size;
  file_upload_section?.classList.toggle("has_loaded_files", count > 0);
  loaded_files_panel.hidden = count === 0;
  loaded_files_label.textContent = `Loaded FCS files (${count.toLocaleString()})`;

  if (!count) {
    loaded_files_list.value = "";
    return;
  }

  const names = file_table_frame && file_table_frame.length
    ? file_table_frame.col("name")
    : [...file_map.values()].map((entry) => entry.name);
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
function update_drop_zone_text() {
  const count = file_map.size;
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
function show_progress(label = "Loading FCS Metadata") {
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
function update_progress(percent, label = "Loading FCS Metadata", detail = "", filename = "") {
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
function hide_progress(delay = 500) {
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
function next_frame() {
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
function clear_channel_controls() {
  [channel_select, collapsed_channel_select].forEach((select) => {
    select.innerHTML = "";
    select.add(new Option("", "", true, true));
    select.disabled = true;
  });

  selected_file_ids.clear();
  Object.keys(column_filters).forEach((field) => delete column_filters[field]);
  sort_state = { field: null, direction: "asc" };
  open_filter_field = null;
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
function unique_columns() {
  const seen = new Set();
  const columns = [];

  file_map.forEach((entry) => {
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
function unique_column_values(field) {
  if (!file_table_frame) return [];
  const seen = new Set();
  const values = [];
  for (const v of file_table_frame.col(field)) {
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
function populate_single_select(select, columns, placeholder, suggested_value = "") {
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
function suggest_column(columns, patterns) {
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
function populate_channel_controls() {
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
function select_if_option_exists(select, value) {
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
function frame_to_rows(frame) {
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
function update_start_button_state() {
  const is_disabled = !channel_select.value || selected_file_ids.size === 0;
  [start_analysis_button, collapsed_plot_button].forEach((button) => {
    if (!button) {
      return;
    }
    button.disabled = is_disabled;
  });

  const has_files = file_map.size > 0;
  ["#calculate_stats_button", "#collapsed_calculate_stats_button"].forEach((sel) => {
    const btn = document.querySelector(sel);
    if (btn) btn.disabled = !has_files;
  });
  if (metadata_parse_button) metadata_parse_button.disabled = !has_files;
  if (metadata_export_button) metadata_export_button.disabled = !has_files;
}

const TABLE_EXPORT_STAT_LABELS = { mean: "Mean", stddev: "Std Dev", median: "Median", min: "Min", max: "Max" };

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

  if (!file_table_frame) return columns;

  const base_fields = table_base_field_set();
  file_table_frame.columns.forEach((field) => {
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
function metadata_table_tsv() {
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
async function handle_metadata_table_export() {
  if (!file_table_frame || file_table_frame.length === 0) {
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

/*

Purpose:
	Dispatches the custom "fcs-selection-change" event so the plot (plotting.js)
	can add/remove curves when the checked set changes. A custom name avoids the
	native "selectionchange".

Input:
	(none)

Output:
	(none) [void]: dispatches a document event

*/
function notify_selection_changed() {
  document.dispatchEvent(new CustomEvent("fcs-selection-change"));
}

/*

Purpose:
	Collapses or expands the left sidebar and asks plot code to recalculate after
	the grid column transition changes the workspace width.

Input:
	is_collapsed [boolean]: true to collapse the sidebar, false to expand it

Output:
	(none) [void]: updates sidebar state and layout-dependent controls

*/
function set_sidebar_collapsed(is_collapsed) {
  app_shell.classList.toggle("sidebar_collapsed", is_collapsed);
  sidebar.classList.toggle("is_collapsed", is_collapsed);
  sidebar_content.setAttribute("aria-hidden", String(is_collapsed));
  if ("inert" in sidebar_content) sidebar_content.inert = is_collapsed;

  sidebar_toggle.setAttribute("aria-expanded", String(!is_collapsed));
  window.PhaseFinderTooltips.set_quick_tooltip(sidebar_toggle, is_collapsed ? "sidebarExpand" : "sidebarCollapse");
  sidebar_toggle.setAttribute("aria-label", is_collapsed ? "Expand sidebar" : "Collapse sidebar");
  sidebar_toggle_icon.src = is_collapsed ? SIDEBAR_OPEN_ICON : SIDEBAR_CLOSE_ICON;

  const notify_layout_changed = () => window.dispatchEvent(new Event("resize"));
  window.requestAnimationFrame(notify_layout_changed);
  window.setTimeout(notify_layout_changed, SIDEBAR_TRANSITION_MS);
}

/*

Purpose:
	Click handler for the sidebar edge button.

Input:
	(none)

Output:
	(none) [void]: toggles the sidebar collapsed state

*/
function toggle_sidebar() {
  set_sidebar_collapsed(!app_shell.classList.contains("sidebar_collapsed"));
}

/*

Purpose:
	Returns the files shown in the table: those passing every active column
	filter, ordered by the current sort. Used for both rendering and "select all".

Input:
	(none)

Output:
	files [Array<Object>]: the filtered and sorted loaded files

*/
function displayed_files() {
  if (!file_table_frame || file_table_frame.length === 0) return [];

  let rows = frame_to_rows(file_table_frame);

  // Filter: each active column filter keeps only rows whose cell value is in
  // the allowed Set. An empty (or absent) Set means "no filter applied".
  for (const col of TABLE_COLUMNS) {
    const allowed = column_filters[col.field];
    if (allowed && allowed.size > 0) {
      rows = rows.filter((row) => {
        const v = row[col.field];
        const str = (v != null && !Number.isNaN(v)) ? String(v).trim() : "";
        return allowed.has(str);
      });
    }
  }

  if (!sort_state.field) return rows;

  const { field, direction } = sort_state;
  const factor = direction === "desc" ? -1 : 1;
  return rows.sort((a, b) => {
    const av = a[field];
    const bv = b[field];
    if (field === "timepoint") {
      const cmp = timepoint_sort_value(av) - timepoint_sort_value(bv);
      return (Number.isNaN(cmp) ? 0 : cmp) * factor;
    }
    return String(av ?? "").localeCompare(String(bv ?? ""), undefined, {
      numeric: true,
      sensitivity: "base",
    }) * factor;
  });
}

/*

Purpose:
	Builds the up/down sort-arrow HTML for a column header, highlighting the
	active sort direction.

Input:
	field [string]: the column field key

Output:
	html [string]: the sort-indicator markup

*/
function sort_indicator(field) {
  const active = sort_state.field === field;
  const asc_class = active && sort_state.direction === "asc" ? "sort_arrow active" : "sort_arrow";
  const desc_class = active && sort_state.direction === "desc" ? "sort_arrow active" : "sort_arrow";
  const sort_ascending_title = escape_html(window.PhaseFinderTooltips.text("sortAscending"));
  const sort_descending_title = escape_html(window.PhaseFinderTooltips.text("sortDescending"));
  return `<span class="sort_indicator"><span class="${asc_class}" data-sort-dir="asc" title="${sort_ascending_title}">▲</span><span class="${desc_class}" data-sort-dir="desc" title="${sort_descending_title}">▼</span></span>`;
}

/*

Purpose:
	Builds the per-column filter dropdown markup — a toggle button plus a
	checkbox menu of the column's unique values — reflecting the current
	selections and open/closed state.

Input:
	column [Object]: a TABLE_COLUMNS entry

Output:
	html [string]: the filter control markup

*/
function filter_control(column) {
  const selected = column_filters[column.field] || new Set();
  const summary = [...selected].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  );
  const is_open = open_filter_field === column.field;

  const options = unique_column_values(column.field)
    .map(
      (value) => `
            <label class="checkbox_option">
              <input type="checkbox" class="th_filter_option" data-filter-field="${column.field}" value="${escape_html(value)}"${selected.has(value) ? " checked" : ""} />
              <span title="${escape_html(value)}">${escape_html(value)}</span>
            </label>`,
    )
    .join("");

  return `
          <div class="th_filter multi_select">
            <button type="button" class="th_filter_toggle multi_select_toggle" data-filter-field="${column.field}" aria-expanded="${is_open}" title="${escape_html(window.PhaseFinderTooltips.text("filterBy", column.label))}">${escape_html(summary.join(", "))}</button>
            <div class="multi_select_menu" data-filter-menu="${column.field}"${is_open ? "" : " hidden"}>${options}</div>
          </div>`;
}

/*

Purpose:
	Builds one <th> for a column: a sortable label and, for filterable columns,
	the filter dropdown.

Input:
	column [Object]: a TABLE_COLUMNS entry

Output:
	html [string]: the header cell markup

*/
function header_cell(column) {
  const filter = column.filterable ? filter_control(column) : "";

  return `
        <th>
          <div class="th_inner">
            <button type="button" class="th_sort" data-sort-field="${column.field}">${escape_html(column.label)}${sort_indicator(column.field)}</button>
            ${filter}
          </div>
        </th>`;
}

/*

Purpose:
	Builds the sortable label <th> used in the first row of the two-row stats
	table header.

Input:
	column [Object]: a TABLE_COLUMNS entry

Output:
	html [string]: the stats-mode label header cell markup

*/
function header_label_cell(column) {
  return `<th class="stats_label_th"><button type="button" class="th_sort" data-sort-field="${column.field}">${escape_html(column.label)}${sort_indicator(column.field)}</button></th>`;
}

/*

Purpose:
	Builds the filter <th> used in the second row of the two-row stats table
	header.

Input:
	column [Object]: a TABLE_COLUMNS entry

Output:
	html [string]: the stats-mode filter header cell markup

*/
function header_filter_cell(column) {
  const filter = column.filterable ? filter_control(column) : "";
  return `<th class="stats_filter_th">${filter}</th>`;
}

/*

Purpose:
	Returns the filename shown to the user, without the .fcs extension. The full
	entry.name is kept for dedup/matching.

Input:
	name [string]: a sample filename

Output:
	label [string]: the filename without a trailing ".fcs"

*/
function display_name(name) {
  return name.replace(/\.fcs$/i, "");
}

const METADATA_TEMPLATE_STORAGE_KEY = "phasefinder_filename_metadata_template";
let metadata_wizard_seen_this_session = false;
let filename_metadata_template = load_filename_metadata_template();

function load_filename_metadata_template() {
  try {
    const raw = window.localStorage?.getItem(METADATA_TEMPLATE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.columns)) return null;
    return normalize_filename_metadata_template(parsed);
  } catch (_error) {
    return null;
  }
}

function normalize_filename_metadata_template(template) {
  if (!template) return null;
  if (Array.isArray(template.steps)) return template;
  const step = template.mode === "fixed"
    ? { type: "fixed", breaks: template.breaks || [] }
    : { type: "delimiter", delimiter: template.delimiter || "_" };
  return { ...template, steps: [step] };
}

function save_filename_metadata_template(template) {
  filename_metadata_template = normalize_filename_metadata_template(template);
  try {
    window.localStorage?.setItem(METADATA_TEMPLATE_STORAGE_KEY, JSON.stringify(filename_metadata_template));
  } catch (_error) {
    // localStorage can be unavailable in private/sandboxed contexts.
  }
}

function default_metadata_split_steps() {
  return [{ type: "delimiter", delimiter: "_" }];
}

function parse_fixed_breaks(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((candidate) => Number.parseInt(candidate, 10))
    .filter((candidate) => Number.isFinite(candidate) && candidate > 0)
    .sort((a, b) => a - b)
    .filter((candidate, index, arr) => index === 0 || candidate !== arr[index - 1]);
}

function collect_metadata_split_steps() {
  if (!metadata_split_steps) return default_metadata_split_steps();
  const steps = [...metadata_split_steps.querySelectorAll(".metadata_split_step")].map((row) => {
    const type = row.querySelector(".metadata_split_type")?.value || "delimiter";
    const label = row.querySelector(".metadata_step_column_name")?.value || "";
    const hide = row.querySelector(".metadata_step_hide")?.checked || false;
    if (type === "fixed") {
      return {
        type,
        breaks: parse_fixed_breaks(row.querySelector(".metadata_step_breaks")?.value || ""),
        label,
        hide,
      };
    }
    if (type === "regex") {
      return {
        type,
        pattern: row.querySelector(".metadata_step_regex")?.value || "",
        label,
        hide,
      };
    }
    return {
      type: "delimiter",
      delimiter: row.querySelector(".metadata_step_delimiter")?.value || "",
      label,
      hide,
    };
  });
  return steps.length ? steps : default_metadata_split_steps();
}

function current_metadata_wizard_spec() {
  return { steps: collect_metadata_split_steps() };
}

function metadata_split_step_controls(step) {
  if (step.type === "fixed") {
    return `
      <div class="metadata_split_step_controls">
        <input class="metadata_step_breaks" type="text" value="${escape_html((step.breaks || []).join(", "))}" placeholder="Break position">
        <input class="metadata_step_width" type="number" min="1" step="1" placeholder="Width">
        <button class="metadata_step_set_width" type="button">Set</button>
      </div>`;
  }
  if (step.type === "regex") {
    return `
      <div class="metadata_split_step_controls">
        <input class="metadata_step_regex metadata_regex_input" type="text" value="${escape_html(step.pattern || "")}" placeholder="Regex separator or capture, e.g. (\\d{2,3})aN">
      </div>`;
  }
  return `
    <div class="metadata_split_step_controls">
      <input class="metadata_step_delimiter metadata_full_step_input" type="text" value="${escape_html(step.delimiter ?? "_")}" placeholder="Delimiter, e.g. _">
    </div>`;
}

function render_metadata_split_steps(steps = default_metadata_split_steps()) {
  if (!metadata_split_steps) return;
  const saved_columns = filename_metadata_template?.columns || [];
  const saved_by_source = new Map(saved_columns.map((column) => [column.source_index, column]));
  const saved_leaves = filename_metadata_template?.leaves || [];
  metadata_split_steps.innerHTML = steps.map((step, index) => {
    const has_step_label = Object.prototype.hasOwnProperty.call(step, "label");
    const has_step_hide = Object.prototype.hasOwnProperty.call(step, "hide");
    const column_label = has_step_label
      ? step.label
      : saved_leaves[index]?.label || saved_by_source.get(index)?.label || `Column ${index + 1}`;
    const is_hidden = has_step_hide ? step.hide : saved_leaves[index]?.include === false;
    return `
    <div class="metadata_split_step" data-step-index="${index}">
      <span class="metadata_split_step_label">Split ${index + 1}</span>
      <select class="metadata_split_type" aria-label="Split step ${index + 1} type">
        <option value="delimiter"${step.type === "delimiter" ? " selected" : ""}>Delimiter</option>
        <option value="fixed"${step.type === "fixed" ? " selected" : ""}>Fixed width</option>
        <option value="regex"${step.type === "regex" ? " selected" : ""}>Regex</option>
      </select>
      ${metadata_split_step_controls(step)}
      <div class="metadata_branch_leaf">
        <input class="metadata_step_column_name" type="text" value="${escape_html(column_label)}" placeholder="Column header">
        <label class="metadata_leaf_hide">
          <input class="metadata_step_hide" type="checkbox" ${is_hidden ? "checked" : ""}>
          Hide
        </label>
      </div>
      <button class="metadata_split_step_remove" type="button" ${steps.length === 1 ? "disabled" : ""}>Remove</button>
    </div>`;
  }).join("");
}

function split_text_binary_step(text, step) {
  if (step.type === "fixed") {
    const split_at = (step.breaks || []).find((value) => value > 0 && value < text.length);
    if (!split_at) return { left: text, right: "" };
    return { left: text.slice(0, split_at), right: text.slice(split_at) };
  }
  if (step.type === "regex") {
    if (!step.pattern) return { left: text, right: "" };
    try {
      const match = new RegExp(step.pattern).exec(text);
      if (!match) return { left: text, right: "" };
      const capture = match.slice(1).find((value) => value !== undefined);
      return {
        left: capture !== undefined ? capture : text.slice(0, match.index),
        right: text.slice(match.index + match[0].length),
      };
    } catch (_error) {
      return { left: text, right: "" };
    }
  }
  if (!step.delimiter) return { left: text, right: "" };
  const index = text.indexOf(step.delimiter);
  if (index < 0) return { left: text, right: "" };
  return {
    left: text.slice(0, index),
    right: text.slice(index + step.delimiter.length),
  };
}

function split_filename_metadata(name, spec) {
  const base = display_name(name);
  const template = normalize_filename_metadata_template(spec) || { steps: default_metadata_split_steps() };
  const parts = [];
  let remainder = base;
  template.steps.forEach((step) => {
    const split = split_text_binary_step(remainder, step);
    parts.push(split.left);
    remainder = split.right;
  });
  parts.push(remainder);
  return parts;
}

function metadata_part_count(spec) {
  const template = normalize_filename_metadata_template(spec) || { steps: default_metadata_split_steps() };
  return Math.max(1, template.steps.length + 1);
}

function current_column_editor_state() {
  const step_states = metadata_split_steps
    ? [...metadata_split_steps.querySelectorAll(".metadata_split_step")].map((row) => ({
        include: !(row.querySelector(".metadata_step_hide")?.checked ?? false),
        label: row.querySelector(".metadata_step_column_name")?.value || "",
      }))
    : [];
  const remainder_row = metadata_column_editor?.querySelector(".metadata_column_row");
  const remainder_state = remainder_row ? [{
    include: !(remainder_row.querySelector(".metadata_leaf_hide input")?.checked ?? false),
    label: remainder_row.querySelector(".metadata_column_name")?.value || "",
  }] : [];
  return [...step_states, ...remainder_state];
}

function render_metadata_column_editor(part_count) {
  if (!metadata_column_editor) return;
  const existing = current_column_editor_state();
  const saved_columns = filename_metadata_template?.columns || [];
  const saved_by_source = new Map(saved_columns.map((column) => [column.source_index, column]));
  const saved_leaves = filename_metadata_template?.leaves || [];
  const has_saved_columns = saved_columns.length > 0;
  const index = Math.max(0, part_count - 1);
  const previous = existing[index] || saved_leaves[index] || saved_by_source.get(index) || {};
  const include = existing[index] ? previous.include !== false : (saved_leaves[index] ? saved_leaves[index].include !== false : (has_saved_columns ? saved_by_source.has(index) : true));
  const label = previous.label || "Remaining text";
  metadata_column_editor.innerHTML = `
    <div class="metadata_column_row metadata_remainder_leaf" data-column-index="${index}">
      <span class="metadata_remainder_label">Remainder</span>
      <input class="metadata_column_name" type="text" value="${escape_html(label)}" placeholder="Column header">
      <label class="metadata_leaf_hide">
        <input type="checkbox" ${include ? "" : "checked"}>
        Hide
      </label>
    </div>`;
}

function metadata_wizard_columns_from_editor() {
  const used = new Set(["id", "name"]);
  return current_column_editor_state()
    .map((column, index) => ({ ...column, source_index: index }))
    .filter((column) => column.include)
    .map((column, index) => {
      const label = column.label.trim() || `Column ${index + 1}`;
      return {
        source_index: column.source_index,
        label,
        field: metadata_field_from_label(label, used),
        editable: true,
        filterable: true,
      };
    });
}

function render_metadata_wizard_preview() {
  if (!metadata_preview || !file_table_frame) return;
  const spec = current_metadata_wizard_spec();
  const part_count = metadata_part_count(spec);
  const remainder_row = metadata_column_editor?.querySelector(".metadata_column_row");
  const remainder_index = Number.parseInt(remainder_row?.dataset.columnIndex || "", 10);
  if (!remainder_row || remainder_index !== part_count - 1) render_metadata_column_editor(part_count);
  const columns = metadata_wizard_columns_from_editor();
  const names = file_table_frame.col("name").slice(0, 20);

  const header = ["Filename", ...columns.map((column) => column.label)]
    .map((label) => `<th>${escape_html(label)}</th>`)
    .join("");
  const body = names.map((name) => {
    const parts = split_filename_metadata(name, spec);
    return `
      <tr>
        <td>${escape_html(display_name(name))}</td>
        ${columns.map((column) => `<td>${escape_html(parts[column.source_index] ?? "")}</td>`).join("")}
      </tr>`;
  }).join("");

  metadata_preview.innerHTML = `
    <table class="metadata_preview_table">
      <thead><tr>${header}</tr></thead>
      <tbody>${body || `<tr><td colspan="${columns.length + 1}">No files loaded.</td></tr>`}</tbody>
    </table>`;
}

function fill_metadata_wizard_from_template() {
  const template = normalize_filename_metadata_template(filename_metadata_template);
  render_metadata_split_steps(template?.steps?.length ? template.steps : default_metadata_split_steps());
}

function add_metadata_split_step() {
  render_metadata_split_steps([...collect_metadata_split_steps(), { type: "delimiter", delimiter: "_" }]);
  render_metadata_wizard_preview();
}

function open_metadata_wizard() {
  if (!metadata_wizard_modal || !file_table_frame || file_table_frame.length === 0) return;
  metadata_wizard_seen_this_session = true;
  if (metadata_column_editor) metadata_column_editor.innerHTML = "";
  fill_metadata_wizard_from_template();
  render_metadata_wizard_preview();
  metadata_wizard_modal.hidden = false;
  metadata_wizard_apply?.focus();
}

function close_metadata_wizard() {
  if (metadata_wizard_modal) metadata_wizard_modal.hidden = true;
}

function set_fixed_width_breaks_from_width(row) {
  const width = Number.parseInt(row?.querySelector(".metadata_step_width")?.value || "", 10);
  if (!Number.isFinite(width) || width <= 0) return;
  const breaks_input = row?.querySelector(".metadata_step_breaks");
  if (breaks_input) breaks_input.value = String(width);
  render_metadata_wizard_preview();
}

function handle_metadata_split_step_input(event) {
  const row = event.target.closest(".metadata_split_step");
  if (!row) return;
  if (event.target.classList.contains("metadata_split_type")) {
    const steps = collect_metadata_split_steps();
    const index = Number(row.dataset.stepIndex);
    const previous = steps[index] || {};
    steps[index] = {
      type: event.target.value,
      delimiter: "_",
      breaks: [],
      pattern: "",
      label: previous.label || "",
      hide: previous.hide || false,
    };
    render_metadata_split_steps(steps);
  }
  render_metadata_wizard_preview();
}

function handle_metadata_split_step_click(event) {
  const remove_button = event.target.closest(".metadata_split_step_remove");
  if (remove_button) {
    const row = remove_button.closest(".metadata_split_step");
    const index = Number(row.dataset.stepIndex);
    const steps = collect_metadata_split_steps();
    if (steps.length > 1) {
      steps.splice(index, 1);
      render_metadata_split_steps(steps);
      render_metadata_wizard_preview();
    }
    return;
  }

  const width_button = event.target.closest(".metadata_step_set_width");
  if (width_button) {
    set_fixed_width_breaks_from_width(width_button.closest(".metadata_split_step"));
  }
}

function apply_filename_metadata_columns(spec, columns, { render = true, preserve_existing = false } = {}) {
  if (!file_table_frame) return;

  set_metadata_table_columns(columns.map((column) => ({
    field: column.field,
    label: column.label,
    editable: true,
    filterable: true,
  })));

  const rows = frame_to_rows(file_table_frame);
  const stat_columns = file_table_frame.columns.filter((field) => field.includes(":"));
  const col_data = {
    id: rows.map((row) => row.id),
    name: rows.map((row) => row.name),
  };

  columns.forEach((column) => {
    col_data[column.field] = rows.map((row) => {
      const existing = row[column.field];
      if (preserve_existing && existing != null && String(existing) !== "") return existing;
      return split_filename_metadata(row.name, spec)[column.source_index] ?? "";
    });
  });
  stat_columns.forEach((field) => {
    col_data[field] = rows.map((row) => row[field] ?? null);
  });

  file_table_frame = new PhaseFinderFrame(col_data, ["id", "name", ...columns.map((column) => column.field), ...stat_columns]);
  sync_file_annotations();
  if (render) render_file_table();
}

function apply_current_filename_metadata_template({ render = true, preserve_existing = true } = {}) {
  if (!filename_metadata_template?.columns?.length || !file_table_frame) {
    sync_file_annotations();
    return;
  }
  apply_filename_metadata_columns(filename_metadata_template, filename_metadata_template.columns, { render, preserve_existing });
}

function apply_metadata_wizard() {
  if (!file_table_frame) return;
  const spec = current_metadata_wizard_spec();
  const columns = metadata_wizard_columns_from_editor();
  const template = { ...spec, columns, leaves: current_column_editor_state() };
  save_filename_metadata_template(template);
  apply_filename_metadata_columns(spec, columns);
  close_metadata_wizard();
  set_status_bar(`Filename metadata columns applied (${columns.length} column${columns.length === 1 ? "" : "s"}).`);
}

function reset_filename_metadata_columns() {
  if (!file_table_frame) return;
  save_filename_metadata_template({ steps: default_metadata_split_steps(), columns: [] });
  set_metadata_table_columns([]);
  const rows = frame_to_rows(file_table_frame);
  const stat_columns = file_table_frame.columns.filter((field) => field.includes(":"));
  const col_data = {
    id: rows.map((row) => row.id),
    name: rows.map((row) => row.name),
  };
  stat_columns.forEach((field) => {
    col_data[field] = rows.map((row) => row[field] ?? null);
  });
  file_table_frame = new PhaseFinderFrame(col_data, ["id", "name", ...stat_columns]);
  sync_file_annotations();
  render_file_table();
  close_metadata_wizard();
  set_status_bar("Metadata table reset to Filename only.");
}

function schedule_metadata_wizard_after_file_load() {
  if (metadata_wizard_seen_this_session || TABLE_COLUMNS.length > 1) return;
  window.setTimeout(() => open_metadata_wizard(), 750);
}

/*

Purpose:
	Renders the metadata table from the loaded files: header cells with
	sort/filter controls and one row per displayed file with a select checkbox
	and editable annotation inputs. Also prunes any selection that is no longer
	visible and refreshes the select-all and Start button state.

Input:
	(none)

Output:
	(none) [void]: rebuilds the #file_table markup

*/
function render_file_table() {
  if (!file_table_frame || file_table_frame.length === 0) {
    file_table.innerHTML = '<p class="empty_note">Upload FCS files to initialize the table.</p>';
    return;
  }

  // Annotation input for editable columns.
  const cell = (row, field) => {
    const value = String(row[field] ?? "");
    return `<td><input data-file-id="${row.id}" data-field="${field}" type="text" size="${annotation_input_size(value)}" value="${escape_html(value)}" /></td>`;
  };

  const visible_files = displayed_files();

  // A row filtered out of the display is automatically deselected.
  const visible_ids = new Set(visible_files.map((row) => row.id));
  let pruned_selection = false;
  selected_file_ids.forEach((id) => {
    if (!visible_ids.has(id)) {
      selected_file_ids.delete(id);
      pruned_selection = true;
    }
  });
  if (pruned_selection) {
    notify_selection_changed();
  }

  const STAT_LABELS = { mean: "Mean", stddev: "Std Dev", median: "Median", min: "Min", max: "Max" };
  // Stats columns live in the frame as "CHANNEL:metric".
  // Group them by channel to build the two-row stats header.
  const BASE_COLS = table_base_field_set();
  const channel_groups = {};
  for (const col of file_table_frame.columns) {
    if (!BASE_COLS.has(col)) {
      const sep = col.lastIndexOf(":");
      if (sep > 0) {
        const channel = col.slice(0, sep);
        const metric = col.slice(sep + 1);
        (channel_groups[channel] ??= []).push(metric);
      }
    }
  }
  const stats_groups = Object.entries(channel_groups).map(([channel, metrics]) => ({ channel, metrics }));
  const has_stats = stats_groups.length > 0;
  // NaN means "not computed for this file" — show a dash.
  const fmt = (v) => (v != null && !Number.isNaN(v) ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—");

  const checkbox_th_inner = `<input type="checkbox" id="select_all_files" title="${escape_html(window.PhaseFinderTooltips.text("selectAllDisplayedFiles"))}" />`;

  let head_html;
  if (has_stats) {
    const label_ths = TABLE_COLUMNS.map((col) => header_label_cell(col)).join("");
    const filter_ths = TABLE_COLUMNS.map((col) => header_filter_cell(col)).join("");
    const group_headers = stats_groups.map((g) =>
      `<th colspan="${g.metrics.length}" class="stats_group_th stats_col_start">${escape_html(g.channel)} Summary Statistics</th>`
    ).join("");
    const sub_headers = stats_groups.map((g) =>
      g.metrics.map((m, mi) => {
        const cls = mi === 0 ? " stats_col_start" : "";
        return `<th class="stats_sub_th${cls}">${STAT_LABELS[m] || m}</th>`;
      }).join("")
    ).join("");
    head_html = `
        <tr>
          <th class="checkbox_col stats_checkbox_th" rowspan="2">${checkbox_th_inner}</th>
          ${label_ths}
          ${group_headers}
        </tr>
        <tr>
          ${filter_ths}
          ${sub_headers}
        </tr>`;
  } else {
    const regular_headers = TABLE_COLUMNS.map((col) => header_cell(col)).join("");
    head_html = `
        <tr>
          <th class="checkbox_col">${checkbox_th_inner}</th>
          ${regular_headers}
        </tr>`;
  }

  const total_stat_cols = has_stats ? stats_groups.reduce((sum, g) => sum + g.metrics.length, 0) : 0;
  const empty_colspan = TABLE_COLUMNS.length + 1 + total_stat_cols;
  const body = visible_files.length
    ? visible_files.map((row) => {
        const metadata_tds = TABLE_COLUMNS.map((column) => {
          if (column.field === "name") {
            return `<td class="filename_cell" title="${escape_html(row.name)}">${escape_html(display_name(row.name))}</td>`;
          }
          return cell(row, column.field);
        }).join("");
        const stats_tds = has_stats ? stats_groups.map((g) =>
          g.metrics.map((m, mi) => {
            const cls = mi === 0 ? " stats_col_start" : "";
            return `<td class="stats_td${cls}">${fmt(row[`${g.channel}:${m}`])}</td>`;
          }).join("")
        ).join("") : "";
        return `
        <tr>
          <td class="checkbox_col"><input type="checkbox" class="row_select" data-file-id="${row.id}"${selected_file_ids.has(row.id) ? " checked" : ""} /></td>
          ${metadata_tds}
          ${stats_tds}
        </tr>`;
      }).join("")
    : `<tr><td class="empty_note" colspan="${empty_colspan}">No files match the current filters.</td></tr>`;

  file_table.innerHTML = `
    <table class="file_table">
      <thead>${head_html}</thead>
      <tbody>${body}</tbody>
    </table>
  `;

  update_select_all_checkbox();
  update_start_button_state();
  sync_file_annotations();
}

/*

Purpose:
	Sets the header "select all" checkbox to checked when every displayed row is
	selected and indeterminate when only some are. The indeterminate state can't
	be expressed in HTML, so it's set here after each render.

Input:
	(none)

Output:
	(none) [void]: updates the select-all checkbox state

*/
function update_select_all_checkbox() {
  const checkbox = document.querySelector("#select_all_files");
  if (!checkbox) {
    return;
  }

  const displayed = displayed_files();
  const selected_count = displayed.reduce(
    (count, entry) => count + (selected_file_ids.has(entry.id) ? 1 : 0),
    0,
  );
  checkbox.checked = displayed.length > 0 && selected_count === displayed.length;
  checkbox.indeterminate = selected_count > 0 && selected_count < displayed.length;
}

/*

Purpose:
	Delegated change handler for the table: applies filter-checkbox toggles, the
	select-all checkbox, and per-row selection, re-rendering and notifying the
	plot as needed.

Input:
	event [Event]: a change event from the file table

Output:
	(none) [void]: updates selection/filter state and re-renders

*/
function handle_table_change(event) {
  const target = event.target;

  if (target.classList.contains("th_filter_option")) {
    const field = target.dataset.filterField;
    const selected = column_filters[field] || (column_filters[field] = new Set());
    if (target.checked) {
      selected.add(target.value);
    } else {
      selected.delete(target.value);
    }
    render_file_table();
    return;
  }

  if (target.id === "select_all_files") {
    displayed_files().forEach((entry) => {
      if (target.checked) {
        selected_file_ids.add(entry.id);
      } else {
        selected_file_ids.delete(entry.id);
      }
    });
    render_file_table();
    update_start_button_state();
    notify_selection_changed();
    return;
  }

  if (target.classList.contains("row_select")) {
    const file_id = target.dataset.fileId;
    if (target.checked) {
      selected_file_ids.add(file_id);
    } else {
      selected_file_ids.delete(file_id);
    }
    update_select_all_checkbox();
    update_start_button_state();
    notify_selection_changed();
  }
}

/*

Purpose:
	Delegated click handler for the table: opens/closes a column's filter
	dropdown, or toggles the sort column and direction.

Input:
	event [Event]: a click event from the file table

Output:
	(none) [void]: updates sort/filter state and re-renders

*/
function handle_table_click(event) {
  const filter_toggle = event.target.closest(".th_filter_toggle");
  if (filter_toggle) {
    const field = filter_toggle.dataset.filterField;
    open_filter_field = open_filter_field === field ? null : field;
    render_file_table();
    return;
  }

  // Clicking a specific arrow sorts that column in that direction (up = asc,
  // down = desc).
  const sort_arrow = event.target.closest(".sort_arrow");
  if (sort_arrow) {
    const arrow_button = sort_arrow.closest(".th_sort");
    if (arrow_button) {
      sort_state = { field: arrow_button.dataset.sortField, direction: sort_arrow.dataset.sortDir };
      render_file_table();
    }
    return;
  }

  // Clicking the label (not an arrow) toggles the direction.
  const sort_button = event.target.closest(".th_sort");
  if (!sort_button) {
    return;
  }

  const field = sort_button.dataset.sortField;
  if (sort_state.field === field) {
    sort_state.direction = sort_state.direction === "asc" ? "desc" : "asc";
  } else {
    sort_state = { field, direction: "asc" };
  }
  render_file_table();
}

/*

Purpose:
	Closes an open filter dropdown when the user clicks anywhere outside a filter
	control.

Input:
	event [Event]: a document click event

Output:
	(none) [void]: may close the open filter menu and re-render

*/
function handle_document_click(event) {
  if (open_filter_field === null || event.target.closest(".th_filter")) {
    return;
  }
  open_filter_field = null;
  render_file_table();
}

/*

Purpose:
	Computes the character width for an annotation input so each cell hugs its
	content, clamped so empty cells stay clickable and long values stay readable.

Input:
	value [string]: the cell's current value

Output:
	size [number]: the input's size attribute (4–28)

*/
function annotation_input_size(value) {
  return Math.min(28, Math.max(4, String(value).length + 1));
}


/*

Purpose:
	Re-renders the table, refreshes the channel selector, and updates the Start
	button. Run after files load.

Input:
	(none)

Output:
	(none) [void]: refreshes the table and channel controls

*/
function update_views() {
  render_file_table();
  populate_channel_controls();
  collapsed_channel_select.value = channel_select.value;
  update_start_button_state();
}

/*

Purpose:
	Guesses initial strain/replicate/nocodazole/timepoint annotations by
	pattern-matching the filename, with fallbacks for names that don't follow
	the main strain/replicate/arrest token format.

Input:
	filename [string]: the FCS file name

Output:
	guess [Object]: { strain, replicate, nocodazoleArrest, timepoint }

*/
function guess_annotations_from_filename(filename) {
  const basename = filename.replace(/\.[^.]+$/, "");
  const guess = {
    strain: "",
    replicate: "",
    nocodazoleArrest: "",
    timepoint: "",
  };

  // Sample token, e.g. "76aN t55": strain digits + replicate letter +
  // nocodazole-arrest letter, then "t" + time since release.
  const core_match = basename.match(/(?:^|[_\s-])(\d+)([A-Za-z])([A-Za-z])\s+t(\d+)(?:[_\s.-]|$)/i);
  if (core_match) {
    guess.strain = core_match[1];
    guess.replicate = core_match[2];
    guess.nocodazoleArrest = core_match[3];
    guess.timepoint = core_match[4];
    return guess;
  }

  // Fallbacks for filenames that don't follow the strain/replicate/arrest token.
  const strain_timepoint_match = basename.match(/(?:^|[_\s-])([^_\s-]+)\s+t(\d+)(?:[_\s-]|$)/i);
  if (strain_timepoint_match) {
    guess.strain = strain_timepoint_match[1];
    guess.timepoint = strain_timepoint_match[2];
  }

  const replicate_match = basename.match(/__([A-Za-z]+\d+)(?:\.|_|\s|-|$)/) || basename.match(/(?:^|[_\s-])([A-Za-z]+\d+)(?:\.|_|\s|-|$)/);
  if (replicate_match) {
    guess.replicate = replicate_match[1];
  }

  return guess;
}

/*

Purpose:
	Converts a timepoint annotation to a number for sorting; non-numeric values
	sort last.

Input:
	value [string]: the timepoint annotation

Output:
	sort_value [number]: the numeric value, or +Infinity if not numeric

*/
function timepoint_sort_value(value) {
  const numeric = Number.parseFloat(value);
  return Number.isFinite(numeric) ? numeric : Number.POSITIVE_INFINITY;
}

/*

Purpose:
	Sorts file_table_frame in place by filename. Rebuilds the frame from sorted
	rows so all columns (including user metadata and stats) are preserved in the
	new order.

Input:
	(none)

Output:
	(none) [void]: replaces file_table_frame with a sorted copy

*/
function sort_file_table() {
  if (!file_table_frame || file_table_frame.length === 0) return;

  const rows = frame_to_rows(file_table_frame);
  rows.sort((a, b) => {
    return String(a.name ?? "").localeCompare(String(b.name ?? ""), undefined, { numeric: true, sensitivity: "base" });
  });

  // Reconstruct column-oriented data and rebuild the frame.
  const cols = file_table_frame.columns;
  const col_data = Object.fromEntries(cols.map((col) => [col, rows.map((row) => row[col] ?? null)]));
  file_table_frame = new PhaseFinderFrame(col_data, [...cols]);
}
