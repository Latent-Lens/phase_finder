// Metadata table rendering and delegated table event handling. This module
// builds the visible table header, filter row, checkbox column, editable
// metadata cells, grouped stat columns, empty states, and unlinked-row styling.
// It keeps selection state coherent when filters hide rows and keeps the
// select-all checkbox synchronized with visible linked rows. It handles row
// selection, filter checkbox changes, sort clicks, header edits, and select-all
// behavior through delegated events. It also links imported metadata rows to
// newly loaded FCS entries when filenames match.

import { file_table } from "./dom.js";
import { Tooltips } from "./hover_text.js";
import { escape_html } from "../util/html.js";
import { display_name, metadata_filename_key } from "../util/names.js";
import { get_file_map, get_file_table } from "../state/app_state.js";
import {
  TABLE_COLUMNS,
  selected_file_ids,
  column_filters,
  sort_state,
  set_sort_state,
  open_filter_field,
  set_open_filter_field,
  pending_header_focus_field,
  set_pending_header_focus_field,
  metadata_row_is_linked,
  table_base_field_set,
  sync_file_annotations,
} from "../data_structs/table_state.js";
import { unique_metadata_label } from "../data_structs/metadata_columns.js";
import {
  displayed_files,
  annotation_input_size,
  header_cell,
  header_label_cell,
  header_filter_cell,
  notify_selection_changed,
} from "./table_support.js";
import { update_start_button_state } from "./status_channels.js";

export function link_existing_metadata_row_to_loaded_entry(entry) {
  const frame = get_file_table();
  if (!frame || !entry?.id || !entry?.name) return false;
  const target_key = metadata_filename_key(entry.name);
  if (!target_key) return false;

  const file_map = get_file_map();
  const ids = [...frame.col("id")];
  const names = [...frame.col("name")];
  const index = names.findIndex((name, row_index) => {
    if (file_map.has(ids[row_index])) return false;
    return metadata_filename_key(name) === target_key;
  });
  if (index < 0) return false;

  ids[index] = entry.id;
  names[index] = entry.name;
  frame.setCol("id", ids);
  frame.setCol("name", names);
  return true;
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
export function render_file_table() {
  const frame = get_file_table();
  if (!frame || frame.length === 0) {
    file_table.innerHTML = '<p class="empty_note">Load FCS files to initialize the table.</p>';
    return;
  }

  // Annotation input for editable columns.
  const cell = (row, field) => {
    const value = String(row[field] ?? "");
    return `<td><input data-file-id="${row.id}" data-field="${field}" type="text" size="${annotation_input_size(value)}" value="${escape_html(value)}" /></td>`;
  };

  const visible_files = displayed_files();

  // A row filtered out of the display is automatically deselected.
  const visible_ids = new Set(visible_files.filter((row) => metadata_row_is_linked(row)).map((row) => row.id));
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
  for (const col of frame.columns) {
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
  // Pipeline/report outputs are frame-backed, read-only derived columns. They
  // intentionally have no `channel:metric` delimiter and are not editable
  // metadata, so render them directly instead of silently dropping them.
  const derived_columns = frame.columns.filter((column) =>
    !BASE_COLS.has(column) && !column.includes(":"),
  );
  const derived_headers = derived_columns.map((column) =>
    `<th class="derived_result_th"${has_stats ? ' rowspan="2"' : ""}>${escape_html(column)}</th>`,
  ).join("");
  // NaN means "not computed for this file" — show a dash.
  const fmt = (v) => (v != null && !Number.isNaN(v) ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—");

  const checkbox_th_inner = `<input type="checkbox" id="select_all_files" title="${escape_html(Tooltips.text("selectAllDisplayedFiles"))}" />`;

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
          ${derived_headers}
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
          ${derived_headers}
        </tr>`;
  }

  const total_stat_cols = has_stats ? stats_groups.reduce((sum, g) => sum + g.metrics.length, 0) : 0;
  const empty_colspan = TABLE_COLUMNS.length + 1 + derived_columns.length + total_stat_cols;
  const body = visible_files.length
    ? visible_files.map((row) => {
        const is_linked = metadata_row_is_linked(row);
        const metadata_tds = TABLE_COLUMNS.map((column) => {
          if (column.field === "name") {
            const title = is_linked ? row.name : `${row.name || "(blank filename)"} — FCS file is not loaded`;
            const class_name = is_linked ? "filename_cell" : "filename_cell filename_cell_unlinked";
            return `<td class="${class_name}" title="${escape_html(title)}">${escape_html(display_name(row.name || ""))}</td>`;
          }
          return cell(row, column.field);
        }).join("");
        const derived_tds = derived_columns.map((column) =>
          `<td class="derived_result_td">${escape_html(String(row[column] ?? "—"))}</td>`,
        ).join("");
        const stats_tds = has_stats ? stats_groups.map((g) =>
          g.metrics.map((m, mi) => {
            const cls = mi === 0 ? " stats_col_start" : "";
            return `<td class="stats_td${cls}">${fmt(row[`${g.channel}:${m}`])}</td>`;
          }).join("")
        ).join("") : "";
        return `
        <tr class="${is_linked ? "" : "metadata_row_unlinked"}">
          <td class="checkbox_col"><input type="checkbox" class="row_select" data-file-id="${row.id}"${selected_file_ids.has(row.id) && is_linked ? " checked" : ""}${is_linked ? "" : " disabled"} /></td>
          ${metadata_tds}
          ${derived_tds}
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

  if (pending_header_focus_field) {
    const field = pending_header_focus_field;
    set_pending_header_focus_field(null);
    window.requestAnimationFrame(() => {
      const input = [...file_table.querySelectorAll(".metadata_header_input")]
        .find((candidate) => candidate.dataset.field === field);
      if (input) {
        input.focus();
        input.select();
      }
    });
  }
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
export function update_select_all_checkbox() {
  const checkbox = document.querySelector("#select_all_files");
  if (!checkbox) {
    return;
  }

  const displayed = displayed_files().filter((entry) => metadata_row_is_linked(entry));
  const selected_count = displayed.reduce(
    (count, entry) => count + (selected_file_ids.has(entry.id) ? 1 : 0),
    0,
  );
  checkbox.checked = displayed.length > 0 && selected_count === displayed.length;
  checkbox.indeterminate = selected_count > 0 && selected_count < displayed.length;
}

export function handle_metadata_header_input(event) {
  const input = event.target.closest(".metadata_header_input");
  if (!input) return false;

  const column = TABLE_COLUMNS.find((entry) => entry.field === input.dataset.field);
  if (!column) return true;
  column.label = input.value;
  sync_file_annotations();
  return true;
}

export function finalize_metadata_header_input(input) {
  const column = TABLE_COLUMNS.find((entry) => entry.field === input.dataset.field);
  if (!column) return;

  const used = new Set(TABLE_COLUMNS
    .filter((entry) => entry.field !== "name" && entry.field !== column.field)
    .map((entry) => entry.label.toLowerCase()));
  const label = unique_metadata_label(input.value, used);
  column.label = label;
  column.headerEditable = false;
  input.value = label;
  sync_file_annotations();
}

function finalize_metadata_header_by_field(field) {
  const input = [...file_table.querySelectorAll(".metadata_header_input")]
    .find((candidate) => candidate.dataset.field === field);
  if (!input) return false;
  finalize_metadata_header_input(input);
  render_file_table();
  return true;
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
export function handle_table_change(event) {
  const target = event.target;

  if (target.classList.contains("metadata_header_input")) {
    return;
  }

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
    displayed_files().filter((entry) => metadata_row_is_linked(entry)).forEach((entry) => {
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
    if (!file_id || !get_file_map().has(file_id)) {
      target.checked = false;
      return;
    }
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
export function handle_table_click(event) {
  const header_ok = event.target.closest(".metadata_header_ok");
  if (header_ok) {
    finalize_metadata_header_by_field(header_ok.dataset.field);
    return;
  }

  const filter_toggle = event.target.closest(".th_filter_toggle");
  if (filter_toggle) {
    const field = filter_toggle.dataset.filterField;
    set_open_filter_field(open_filter_field === field ? null : field);
    render_file_table();
    return;
  }

  // Clicking a specific arrow sorts that column in that direction (up = asc,
  // down = desc).
  const sort_arrow = event.target.closest(".sort_arrow");
  if (sort_arrow) {
    const arrow_button = sort_arrow.closest(".th_sort");
    if (arrow_button) {
      set_sort_state(arrow_button.dataset.sortField, sort_arrow.dataset.sortDir);
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
    set_sort_state(field, "asc");
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
export function handle_document_click(event) {
  if (open_filter_field === null || event.target.closest(".th_filter")) {
    return;
  }
  set_open_filter_field(null);
  render_file_table();
}
