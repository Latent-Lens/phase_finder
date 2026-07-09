// Shared metadata-table state for selection, filtering, sorting, and row links.
// This module owns the state that must persist across table re-renders, such as
// TABLE_COLUMNS, selected file ids, active column filters, sort state, and the
// open filter dropdown. It provides helpers for identifying linked metadata
// rows, generating stable unlinked-row ids, and discovering base versus stats
// columns. It also synchronizes metadata-frame cell values back onto each loaded
// file entry's annotations object. UI rendering and IO modules import this
// state but do not define it themselves.

import { get_file_map, get_file_table } from "../state/app_state.js";
import { metadata_filename_key } from "../util/names.js";

const FILENAME_TABLE_COLUMN = { field: "name", label: "Filename", editable: false, filterable: false };
export let TABLE_COLUMNS = [FILENAME_TABLE_COLUMN];
export let pending_header_focus_field = null;
let metadata_unlinked_row_counter = 0;
let preserve_metadata_row_order = false;

// IDs of files whose row checkbox is ticked. Persists across re-renders so
// sorting/filtering don't drop the selection.
export const selected_file_ids = new Set();
// field -> Set of values ticked in that column's filter dropdown. A row passes
// the column when the set is empty (no filter) or contains the row's value.
export const column_filters = {};
// Current sort. Kept as a stable object so importers see live updates; mutate
// via set_sort_state (or its own .direction toggle) rather than reassigning.
export const sort_state = { field: null, direction: "asc" };
// Field whose filter dropdown is currently open, or null. Kept in state so the
// menu stays open across table re-renders triggered by ticking its checkboxes.
export let open_filter_field = null;

/*

Purpose:
	Sets the active sort field/direction in place so importers of sort_state see
	the update through their live binding.

Input:
	field [string|null]:  the column field to sort by, or null for no sort
	direction [string]:   "asc" or "desc" (default "asc")

Output:
	(none) [void]: mutates sort_state

*/
export function set_sort_state(field, direction = "asc") {
  sort_state.field = field;
  sort_state.direction = direction;
}

/*

Purpose:
	Sets which column's filter dropdown is open (or null to close).

Input:
	field [string|null]: the open filter field, or null

Output:
	(none) [void]: updates open_filter_field

*/
export function set_open_filter_field(field) {
  open_filter_field = field;
}

/*

Purpose:
	Records the metadata column header that should receive focus after the next
	table render (used when adding a manual column).

Input:
	field [string|null]: the field to focus, or null

Output:
	(none) [void]: updates pending_header_focus_field

*/
export function set_pending_header_focus_field(field) {
  pending_header_focus_field = field;
}

/*

Purpose:
	Toggles whether imported/session metadata row order should be preserved
	(i.e. automatic filename sorting is suppressed).

Input:
	value [boolean]: true to preserve row order

Output:
	(none) [void]: updates preserve_metadata_row_order

*/
export function set_preserve_metadata_row_order(value) {
  preserve_metadata_row_order = value;
}

/*

Purpose:
	Returns whether a metadata-table row is linked to a loaded FCS file entry.

Input:
	row [Object]: metadata table row

Output:
	linked [boolean]: true when row.id exists in file_map

*/
export function metadata_row_is_linked(row) {
  return Boolean(row?.id && get_file_map().has(row.id));
}

/*

Purpose:
	Returns how many loaded FCS file entries are currently in file_map.

Input:
	(none)

Output:
	count [number]: loaded file count

*/
export function loaded_file_count() {
  return get_file_map().size;
}

/*

Purpose:
	Builds a unique id for an imported metadata row without a loaded FCS file.

Input:
	index [number]: row index from the source metadata table

Output:
	id [string]: generated unlinked metadata row id

*/
export function metadata_unlinked_row_id(index = 0) {
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
export function loaded_file_by_metadata_key(rows) {
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
export function should_preserve_metadata_row_order() {
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
export function table_base_field_set() {
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
export function table_stat_columns() {
  const frame = get_file_table();
  if (!frame) return [];
  const base_fields = table_base_field_set();
  return frame.columns.filter((field) => !base_fields.has(field) && field.includes(":"));
}

/*

Purpose:
	Replaces the active user metadata column definitions and prunes stale state.

Input:
	columns [Array<Object>]: user metadata columns, excluding Filename

Output:
	(none) [void]: updates TABLE_COLUMNS, filters, sort state, and open filter

*/
export function set_metadata_table_columns(columns) {
  TABLE_COLUMNS = [FILENAME_TABLE_COLUMN, ...columns];
  Object.keys(column_filters).forEach((field) => {
    if (!TABLE_COLUMNS.some((column) => column.field === field)) {
      delete column_filters[field];
    }
  });
  if (sort_state.field && !TABLE_COLUMNS.some((column) => column.field === sort_state.field)) {
    set_sort_state(null);
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
export function sync_file_annotations() {
  const frame = get_file_table();
  if (!frame) return;
  const file_map = get_file_map();
  const ids = frame.col("id");
  const metadata_columns = TABLE_COLUMNS.filter((column) => column.field !== "name");
  ids.forEach((id, index) => {
    const entry = file_map.get(id);
    if (!entry) return;
    const annotations = {};
    metadata_columns.forEach((column) => {
      const value = frame.col(column.field)[index] ?? "";
      annotations[column.field] = value;
      annotations[column.label] = value;
    });
    entry.annotations = annotations;
  });
}
