// Metadata frame primitives and frame-building helpers. This module defines the
// PhaseFinderFrame column store used by metadata, stats, import/export, and
// session restore code. It provides helpers to build frames from row objects and
// concatenate frames while preserving column order and filling missing values.
// It also builds linked/unlinked metadata frames from imported or session
// records, matching rows back to loaded FCS files when filenames align. It does
// not own table selection, filters, or column editing rules; those live in the
// neighboring data_structs modules.

import { normalize_metadata_columns } from "./metadata_columns.js";
import { loaded_file_by_metadata_key, metadata_unlinked_row_id } from "./table_state.js";
import { metadata_filename_key } from "../util/names.js";

export class PhaseFinderFrame {
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
export function make_frame(rows) {
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
export function concat_frames(frame1, frame2) {
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

/*

Purpose:
	Builds a metadata frame from imported/session records, linking each record to
	a loaded FCS row when their normalized filenames match (first match wins) and
	leaving unmatched or duplicate records as unlinked rows with generated ids.

Input:
	records [Array<Object>]:     metadata rows (each carries a name/Filename plus column values)
	columns [Array<Object>]:     raw metadata column definitions to normalize
	loaded_rows [Array<Object>]: currently loaded rows to match against (default [])
	options [Object]:            { source } tag applied to normalized columns

Output:
	result [Object]: { frame, columns, matched, unmatched, duplicates, empty_filenames }

*/
export function build_metadata_frame_from_records(records, columns, loaded_rows = [], options = {}) {
  const normalized_columns = normalize_metadata_columns(columns, { default_source: options.source || "metadata" });
  const loaded_by_key = loaded_file_by_metadata_key(loaded_rows);
  const used_loaded_ids = new Set();
  const col_data = {
    id: [],
    name: [],
  };

  normalized_columns.forEach((column) => {
    col_data[column.field] = [];
  });

  let matched = 0;
  let unmatched = 0;
  let duplicates = 0;
  let empty_filenames = 0;

  (records || []).forEach((record, index) => {
    const imported_name = String(record.name ?? record.Filename ?? record.filename ?? "").trim();
    const key = metadata_filename_key(imported_name);
    const loaded = key ? loaded_by_key.get(key) : null;
    const can_link = loaded && !used_loaded_ids.has(loaded.id);

    if (!key) empty_filenames += 1;
    if (loaded && !can_link) duplicates += 1;

    if (can_link) {
      col_data.id.push(loaded.id);
      col_data.name.push(loaded.name);
      used_loaded_ids.add(loaded.id);
      matched += 1;
    } else {
      col_data.id.push(metadata_unlinked_row_id(index));
      col_data.name.push(imported_name);
      unmatched += 1;
    }

    normalized_columns.forEach((column) => {
      col_data[column.field].push(record[column.field] ?? "");
    });
  });

  return {
    frame: new PhaseFinderFrame(col_data, ["id", "name", ...normalized_columns.map((column) => column.field)]),
    columns: normalized_columns,
    matched,
    unmatched,
    duplicates,
    empty_filenames,
  };
}
