// Session <-> metadata-table bridge. This module translates between the live
// table state and the plain-object session representation: it snapshots the
// selection, sort, filters, filename template, and columns for serialization,
// and rebuilds the metadata frame (with linked/unlinked rows, restored
// annotations, sort, filters, and selection) when a session is applied. It sits
// in the session layer so the entry module no longer needs to own session logic,
// which keeps main.js and session/core.js free of a mutual dependency. It reads
// and writes shared state only through the data_structs and state accessors.

import { get_file_map, get_file_table, set_file_table } from "../state/app_state.js";
import {
  TABLE_COLUMNS,
  selected_file_ids,
  column_filters,
  sort_state,
  set_sort_state,
  set_metadata_table_columns,
  set_preserve_metadata_row_order,
  sync_file_annotations,
} from "../data_structs/table_state.js";
import { PhaseFinderFrame, build_metadata_frame_from_records } from "../data_structs/metadata_frame.js";
import { frame_to_rows, update_start_button_state } from "../ui/status_channels.js";
import { render_file_table } from "../ui/table_render.js";
import {
  apply_filename_metadata_columns,
  save_filename_metadata_template,
  filename_metadata_template,
} from "../ui/metadata_wizard.js";

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

  // selected_names is only omitted (not just empty) when a caller wants to
  // leave the live selection alone — see apply_table_session's restore_selection
  // option, used to stop the post-reconnect pf-files-loaded replay from
  // clobbering rows load_files() already auto-checked.
  if (selected_names !== undefined) {
    selected_file_ids.clear();
    const frame = get_file_table();
    if (selected_names.length && frame) {
      const ids       = [...frame.col("id")];
      const names_arr = [...frame.col("name")];
      const name_to_id = new Map(names_arr.map((n, i) => [n, ids[i]]));
      for (const name of selected_names) {
        const id = name_to_id.get(name);
        if (id) selected_file_ids.add(id);
      }
    }
  }

  render_file_table();
  update_start_button_state();
}
