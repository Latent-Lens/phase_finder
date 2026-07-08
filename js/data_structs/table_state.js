// Shared metadata-table state for selection, filtering, sorting, and row links.
// This file owns the globals that must persist across table re-renders, such as
// TABLE_COLUMNS, selected file ids, active column filters, sort state, and the
// open filter dropdown. It provides helpers for identifying linked metadata
// rows, generating stable unlinked-row ids, and discovering base versus stats
// columns. It also synchronizes metadata-frame cell values back onto each loaded
// file entry's annotations object. UI rendering and IO modules depend on this
// state but do not define it themselves.

const FILENAME_TABLE_COLUMN = { field: "name", label: "Filename", editable: false, filterable: false };
let TABLE_COLUMNS = [FILENAME_TABLE_COLUMN];
let pending_header_focus_field = null;
let metadata_unlinked_row_counter = 0;
let preserve_metadata_row_order = false;

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

/*

Purpose:
	Returns whether a metadata-table row is linked to a loaded FCS file entry.

Input:
	row [Object]: metadata table row

Output:
	linked [boolean]: true when row.id exists in file_map

*/
function metadata_row_is_linked(row) {
  return Boolean(row?.id && typeof file_map !== "undefined" && file_map.has(row.id));
}

/*

Purpose:
	Returns how many loaded FCS file entries are currently in file_map.

Input:
	(none)

Output:
	count [number]: loaded file count

*/
function loaded_file_count() {
  return typeof file_map !== "undefined" ? file_map.size : 0;
}

/*

Purpose:
	Builds a unique id for an imported metadata row without a loaded FCS file.

Input:
	index [number]: row index from the source metadata table

Output:
	id [string]: generated unlinked metadata row id

*/
function metadata_unlinked_row_id(index = 0) {
  metadata_unlinked_row_counter += 1;
  return `metadata-unlinked-${Date.now()}-${metadata_unlinked_row_counter}-${index}`;
}

/*

Purpose:
	Indexes loaded rows by normalized metadata filename key for import matching.

Input:
	rows [Array<Object>]: candidate loaded rows

Output:
	index [Map]: metadata filename key -> row

*/
function loaded_file_by_metadata_key(rows) {
  const index = new Map();
  (rows || []).forEach((row) => {
    if (!row?.id || !row?.name) return;
    const key = metadata_filename_key(row.name);
    if (key && !index.has(key)) index.set(key, row);
  });
  return index;
}

/*

Purpose:
	Reports whether imported/session metadata row order should be preserved.

Input:
	(none)

Output:
	preserve [boolean]: true to skip automatic file sorting

*/
function should_preserve_metadata_row_order() {
  return preserve_metadata_row_order;
}

/*

Purpose:
	Returns fields that belong to built-in or user metadata columns.

Input:
	(none)

Output:
	fields [Set]: base table field names

*/
function table_base_field_set() {
  return new Set(["id", ...TABLE_COLUMNS.map((column) => column.field)]);
}

/*

Purpose:
	Returns computed statistic columns currently present in file_table_frame.

Input:
	(none)

Output:
	columns [Array<string>]: statistic field names such as "DAPI-A:mean"

*/
function table_stat_columns() {
  if (!file_table_frame) return [];
  const base_fields = table_base_field_set();
  return file_table_frame.columns.filter((field) => !base_fields.has(field) && field.includes(":"));
}

/*

Purpose:
	Replaces the active user metadata column definitions and prunes stale state.

Input:
	columns [Array<Object>]: user metadata columns, excluding Filename

Output:
	(none) [void]: updates TABLE_COLUMNS, filters, sort state, and open filter

*/
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

/*

Purpose:
	Copies metadata-frame values back onto each loaded file entry's annotations.

Input:
	(none)

Output:
	(none) [void]: mutates loaded file entries in file_map

*/
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
