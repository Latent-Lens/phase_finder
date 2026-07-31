// Metadata-column naming, normalization, rebuilding, and manual-column helpers.
// This file centralizes how user-facing metadata labels become stable table
// fields and how duplicate labels or fields are made unique. It normalizes
// columns coming from imports, sessions, filename templates, and manual edits so
// table code can consume one consistent shape. It rebuilds the metadata frame
// when the metadata columns change while preserving row order and existing stats
// columns. It also implements the blank-column action used by the metadata table
// toolbar.

import {
  TABLE_COLUMNS,
  set_metadata_table_columns,
  set_pending_header_focus_field,
} from "./table_state.js";
import { PhaseFinderFrame } from "./metadata_frame.js";
import {
  metadata_field_from_label,
  normalize_metadata_columns,
  unique_metadata_label,
} from "./metadata_column_schema.js";
export {
  metadata_field_from_label,
  normalize_metadata_columns,
  unique_metadata_label,
} from "./metadata_column_schema.js";
import { get_file_table, set_file_table } from "../state/app_state.js";
import { frame_to_rows, set_status, set_status_bar } from "../ui/status_channels.js";

export const TABLE_EXPORT_STAT_LABELS = { mean: "Mean", stddev: "Std Dev", median: "Median", min: "Min", max: "Max" };

/*

Purpose:
	Returns only user metadata columns, excluding the built-in Filename column.

Input:
	(none)

Output:
	columns [Array<Object>]: current metadata column definitions

*/
export function current_metadata_columns() {
  return TABLE_COLUMNS.filter((column) => column.field !== "name");
}

/*

Purpose:
	Rebuilds the metadata frame after the metadata column set changes.

Input:
	columns [Array<Object>]: metadata columns to keep
	value_overrides [Object]: optional field/index values for new columns

Output:
	(none) [void]: replaces file_table_frame and re-renders the table

*/
export function rebuild_table_with_metadata_columns(columns, value_overrides = {}) {
  const frame = get_file_table();
  if (!frame) return;

  const normalized_columns = normalize_metadata_columns(columns);
  const rows = frame_to_rows(frame);
  const stat_columns = frame.columns.filter((field) => field.includes(":"));
  const col_data = {
    id: rows.map((row) => row.id),
    name: rows.map((row) => row.name),
  };

  normalized_columns.forEach((column) => {
    col_data[column.field] = rows.map((row, index) => {
      const overrides = value_overrides[column.field];
      if (overrides && Object.prototype.hasOwnProperty.call(overrides, index)) {
        return overrides[index];
      }
      return row[column.field] ?? "";
    });
  });

  stat_columns.forEach((field) => {
    col_data[field] = rows.map((row) => row[field] ?? null);
  });

  set_metadata_table_columns(normalized_columns);
  set_file_table(new PhaseFinderFrame(
    col_data,
    ["id", "name", ...normalized_columns.map((column) => column.field), ...stat_columns],
  ));
  document.dispatchEvent(new CustomEvent("pf-render-file-table"));
}

/*

Purpose:
	Adds a new blank editable metadata column to the table.

Input:
	(none)

Output:
	(none) [void]: updates the metadata frame and focuses the new header

*/
export function add_manual_metadata_column() {
  const frame = get_file_table();
  if (!frame || frame.length === 0) {
    set_status("Load FCS files or import metadata before adding metadata columns.", true);
    return;
  }

  const existing = current_metadata_columns();
  const used_labels = new Set(existing.map((column) => column.label.toLowerCase()));
  const label = unique_metadata_label("New Column", used_labels);
  const used = new Set(["id", "name", ...existing.map((column) => column.field), ...frame.columns]);
  const field = metadata_field_from_label(label, used);
  const column = {
    field,
    label,
    editable: true,
    filterable: true,
    headerEditable: true,
    source: "manual",
  };
  set_pending_header_focus_field(field);
  rebuild_table_with_metadata_columns([...existing, column], { [field]: Array(frame.length).fill("") });
  set_status_bar(`Added metadata column "${label}".`);
}
