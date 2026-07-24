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
  focused_file_id,
  set_focused_file_id,
  prune_focused_file_id,
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
  DERIVED_COLUMN_GROUPS, TOTAL_EVENTS_COLUMN, TOTAL_EVENTS_HEADER,
  CELL_CYCLE_COLUMN_PREFIX, CELL_CYCLE_PHASE_LABELS, CELL_CYCLE_MODEL_LABELS,
} from "../data_structs/derived_columns.js";
import { decorate_removable_headers, handle_remove_columns_click } from "./column_remove.js";
import {
  displayed_files,
  annotation_input_size,
  header_cell,
  header_label_cell,
  header_filter_cell,
  notify_selection_changed,
  notify_focus_changed,
} from "./table_support.js";
import { update_start_button_state } from "./status_channels.js";
import { sync_color_by_options, get_row_color, toggle_isolated_color_group } from "../plotting/data.js";
import { render_density_plot } from "../plotting/render.js";

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
	Updates every row's color swatch in place to match the plot's current
	per-row colors, without a full table re-render. Called after every
	render_density_plot() (see the pf-plot-rendered listener in main.js) --
	using a full render_file_table() there instead would rebuild the entire
	table on every plot redraw (including high-frequency ones like dragging
	the bin-count control), which is unnecessary just to recolor some dots.

Input:
	(none)

Output:
	(none) [void]: updates each .filename_color_swatch element's color/title

*/
export function sync_filename_swatches() {
  document.querySelectorAll("#file_table .filename_color_swatch[data-row-id]").forEach((el) => {
    const color_info = get_row_color(el.dataset.rowId);
    if (color_info) {
      el.classList.remove("filename_color_swatch_empty");
      el.style.background = color_info.color;
      el.dataset.colorGroup = color_info.group;
      el.title = `${color_info.group} — double-click to show only this color on the plot`;
    } else {
      el.classList.add("filename_color_swatch_empty");
      el.style.background = "";
      delete el.dataset.colorGroup;
      el.title = "Not currently plotted";
    }
  });
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
  sync_color_by_options();
  const frame = get_file_table();
  if (!frame || frame.length === 0) {
    file_table.innerHTML = '<p class="empty_note">Load FCS files to initialize the table.</p>';
    return;
  }

  // Annotation input for editable columns. Carries the same data-column-key as
  // its header so remove-columns mode can span the highlight down to this cell.
  const cell = (row, field) => {
    const value = String(row[field] ?? "");
    return `<td data-column-key="field:${escape_html(field)}"><input data-file-id="${row.id}" data-field="${field}" type="text" size="${annotation_input_size(value)}" value="${escape_html(value)}" /></td>`;
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
  // Cell-cycle fit fraction columns ("cellCycleFit:<modelId>:<phase>") are
  // pulled out first: they contain colons but must NOT be treated as
  // CHANNEL:metric stats columns. Grouped by model so each model in use gets its
  // own G1/S/G2-M header block.
  const cell_cycle_model_columns = {};
  for (const col of frame.columns) {
    if (col.startsWith(CELL_CYCLE_COLUMN_PREFIX)) {
      const rest = col.slice(CELL_CYCLE_COLUMN_PREFIX.length);
      const sep = rest.lastIndexOf(":");
      if (sep > 0) {
        const modelId = rest.slice(0, sep);
        const phase = rest.slice(sep + 1);
        (cell_cycle_model_columns[modelId] ??= {})[phase] = col;
      }
    }
  }
  const cell_cycle_groups = Object.entries(cell_cycle_model_columns).map(([modelId, phases]) => ({
    label: CELL_CYCLE_MODEL_LABELS[modelId] || modelId,
    columns: ["g1", "s", "g2"]
      .filter((phase) => phases[phase])
      .map((phase) => ({ field: phases[phase], label: CELL_CYCLE_PHASE_LABELS[phase] })),
  })).filter((group) => group.columns.length);
  const has_cell_cycle = cell_cycle_groups.length > 0;

  const channel_groups = {};
  for (const col of frame.columns) {
    if (!BASE_COLS.has(col) && !col.startsWith(CELL_CYCLE_COLUMN_PREFIX)) {
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
  // The leading total-events column renders on its own with a header split
  // across the two rows ("Total number" / "of events"); it is never grouped.
  const has_total_events = derived_columns.includes(TOTAL_EVENTS_COLUMN);
  const groupable_derived = derived_columns.filter((column) => column !== TOTAL_EVENTS_COLUMN);
  // Group the rest under section headers (Quality Control, Dean-Jett-Fox
  // Modeling), keeping only members present in the frame so a group grows as its
  // columns are added. Anything unrecognized renders standalone. The ordered
  // list drives both the header and body cell order.
  const present_derived = new Set(groupable_derived);
  const used_derived = new Set();
  const derived_groups = [];
  for (const group of DERIVED_COLUMN_GROUPS) {
    const columns = group.columns.filter((column) => present_derived.has(column));
    if (columns.length) {
      derived_groups.push({ label: group.label, columns });
      columns.forEach((column) => used_derived.add(column));
    }
  }
  const ungrouped_derived = groupable_derived.filter((column) => !used_derived.has(column));
  const ordered_derived_columns = [
    ...(has_total_events ? [TOTAL_EVENTS_COLUMN] : []),
    ...derived_groups.flatMap((group) => group.columns),
    ...ungrouped_derived,
  ];
  // The leading total column and the first column of each section carry the
  // divider border.
  const derived_col_start = new Set([
    ...(has_total_events ? [TOTAL_EVENTS_COLUMN] : []),
    ...derived_groups.map((group) => group.columns[0]),
    ...ungrouped_derived,
  ]);
  // Any grouped section (or the split total header) forces the two-row header
  // even without stats, so section titles align with the metadata labels and
  // column titles align with the metadata filter dropdowns.
  const two_row_header = has_stats || derived_groups.length > 0 || has_total_events || has_cell_cycle;
  // Removable derived/stats headers carry data-column-key="col:<frame column>".
  const col_key = (column) =>
    ` data-column-key="col:${escape_html(column)}" data-column-label="${escape_html(column)}"`;
  const total_top_th = has_total_events
    ? `<th class="derived_group_th stats_col_start"${col_key(TOTAL_EVENTS_COLUMN)}>${escape_html(TOTAL_EVENTS_HEADER.top)}</th>`
    : "";
  const total_bottom_th = has_total_events
    ? `<th class="derived_sub_th stats_col_start"${col_key(TOTAL_EVENTS_COLUMN)}>${escape_html(TOTAL_EVENTS_HEADER.bottom)}</th>`
    : "";
  const derived_group_ths = [
    total_top_th,
    ...derived_groups.map((group) =>
      `<th colspan="${group.columns.length}" class="derived_group_th stats_col_start">${escape_html(group.label)}</th>`,
    ),
    ...ungrouped_derived.map((column) =>
      `<th class="derived_result_th stats_col_start"${col_key(column)}${two_row_header ? ' rowspan="2"' : ""}>${escape_html(column)}</th>`,
    ),
  ].join("");
  const derived_sub_ths = [
    total_bottom_th,
    ...derived_groups.map((group) =>
      group.columns.map((column, ci) =>
        `<th class="derived_sub_th${ci === 0 ? " stats_col_start" : ""}"${col_key(column)}>${escape_html(column)}</th>`,
      ).join(""),
    ),
  ].join("");
  // NaN means "not computed for this file" — show a dash.
  const fmt = (v) => (v != null && !Number.isNaN(v) ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—");

  const checkbox_th_inner = `<input type="checkbox" id="select_all_files" title="${escape_html(Tooltips.text("selectAllDisplayedFiles"))}" />`;

  let head_html;
  if (two_row_header) {
    const label_ths = TABLE_COLUMNS.map((col) => header_label_cell(col)).join("");
    const filter_ths = TABLE_COLUMNS.map((col) => header_filter_cell(col)).join("");
    const group_headers = stats_groups.map((g) =>
      `<th colspan="${g.metrics.length}" class="stats_group_th stats_col_start">${escape_html(g.channel)} Summary Statistics</th>`
    ).join("");
    const sub_headers = stats_groups.map((g) =>
      g.metrics.map((m, mi) => {
        const cls = mi === 0 ? " stats_col_start" : "";
        const key = `col:${escape_html(`${g.channel}:${m}`)}`;
        const label = escape_html(`${g.channel} ${STAT_LABELS[m] || m}`);
        return `<th class="stats_sub_th${cls}" data-column-key="${key}" data-column-label="${label}">${STAT_LABELS[m] || m}</th>`;
      }).join("")
    ).join("");
    // Per-model cell-cycle groups: model label spanning its G1/S/G2-M columns.
    const cell_cycle_group_headers = cell_cycle_groups.map((g) =>
      `<th colspan="${g.columns.length}" class="stats_group_th cell_cycle_group_th stats_col_start">${escape_html(g.label)}</th>`
    ).join("");
    const cell_cycle_sub_headers = cell_cycle_groups.map((g) =>
      g.columns.map((c, ci) => {
        const cls = ci === 0 ? " stats_col_start" : "";
        const key = `col:${escape_html(c.field)}`;
        const label = escape_html(`${g.label} ${c.label}`);
        return `<th class="stats_sub_th cell_cycle_sub_th${cls}" data-column-key="${key}" data-column-label="${label}">${escape_html(c.label)}</th>`;
      }).join("")
    ).join("");
    head_html = `
        <tr>
          <th class="checkbox_col stats_checkbox_th" rowspan="2">${checkbox_th_inner}</th>
          ${label_ths}
          ${derived_group_ths}
          ${group_headers}
          ${cell_cycle_group_headers}
        </tr>
        <tr>
          ${filter_ths}
          ${derived_sub_ths}
          ${sub_headers}
          ${cell_cycle_sub_headers}
        </tr>`;
  } else {
    const regular_headers = TABLE_COLUMNS.map((col) => header_cell(col)).join("");
    head_html = `
        <tr>
          <th class="checkbox_col">${checkbox_th_inner}</th>
          ${regular_headers}
          ${derived_group_ths}
        </tr>`;
  }

  const total_stat_cols = has_stats ? stats_groups.reduce((sum, g) => sum + g.metrics.length, 0) : 0;
  const total_cell_cycle_cols = cell_cycle_groups.reduce((sum, g) => sum + g.columns.length, 0);
  const empty_colspan = TABLE_COLUMNS.length + 1 + derived_columns.length + total_stat_cols + total_cell_cycle_cols;
  const body = visible_files.length
    ? visible_files.map((row) => {
        const is_linked = metadata_row_is_linked(row);
        const metadata_tds = TABLE_COLUMNS.map((column) => {
          if (column.field === "name") {
            const title = is_linked ? row.name : `${row.name || "(blank filename)"} — FCS file is not loaded`;
            const class_name = is_linked ? "filename_cell" : "filename_cell filename_cell_unlinked";
            const color_info = get_row_color(row.id);
            const swatch = color_info
              ? `<span class="filename_color_swatch" data-row-id="${escape_html(row.id)}" data-color-group="${escape_html(color_info.group)}" style="background:${escape_html(color_info.color)}" title="${escape_html(color_info.group)} — double-click to show only this color on the plot"></span>`
              : `<span class="filename_color_swatch filename_color_swatch_empty" data-row-id="${escape_html(row.id)}" title="Not currently plotted"></span>`;
            return `<td class="${class_name}" title="${escape_html(title)}">${swatch}${escape_html(display_name(row.name || ""))}</td>`;
          }
          return cell(row, column.field);
        }).join("");
        const derived_tds = ordered_derived_columns.map((column) => {
          const cls = derived_col_start.has(column) ? " stats_col_start" : "";
          const key = `col:${escape_html(column)}`;
          return `<td class="derived_result_td${cls}" data-column-key="${key}">${escape_html(String(row[column] ?? "—"))}</td>`;
        }).join("");
        const stats_tds = has_stats ? stats_groups.map((g) =>
          g.metrics.map((m, mi) => {
            const cls = mi === 0 ? " stats_col_start" : "";
            const key = `col:${escape_html(`${g.channel}:${m}`)}`;
            return `<td class="stats_td${cls}" data-column-key="${key}">${fmt(row[`${g.channel}:${m}`])}</td>`;
          }).join("")
        ).join("") : "";
        const cell_cycle_tds = has_cell_cycle ? cell_cycle_groups.map((g) =>
          g.columns.map((c, ci) => {
            const cls = ci === 0 ? " stats_col_start" : "";
            const key = `col:${escape_html(c.field)}`;
            const value = row[c.field];
            return `<td class="stats_td cell_cycle_td${cls}" data-column-key="${key}">${value ? escape_html(String(value)) : "—"}</td>`;
          }).join("")
        ).join("") : "";
        const focus_class = row.id === focused_file_id ? " metadata_row_focused" : "";
        return `
        <tr class="${is_linked ? "" : "metadata_row_unlinked"}${focus_class}" data-file-id="${row.id}">
          <td class="checkbox_col"><input type="checkbox" class="row_select" data-file-id="${row.id}"${selected_file_ids.has(row.id) && is_linked ? " checked" : ""}${is_linked ? "" : " disabled"} /></td>
          ${metadata_tds}
          ${derived_tds}
          ${stats_tds}
          ${cell_cycle_tds}
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
  decorate_removable_headers();

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
	Delegated keydown handler for the table: pressing Enter while editing a new
	column's header name confirms it, the same as clicking its "OK" button.

Input:
	event [Event]: a keydown event from the file table

Output:
	(none) [void]: finalizes the header on Enter

*/
export function handle_table_keydown(event) {
  if (event.key !== "Enter") return;
  const input = event.target.closest(".metadata_header_input");
  if (!input) return;
  event.preventDefault();
  finalize_metadata_header_by_field(input.dataset.field);
}

/*

Purpose:
	Delegated double-click handler for the table: double-clicking a row's color
	swatch isolates that color/group on the plot, same as double-clicking its
	curve there -- a second double-click (on the same or any swatch of the same
	color) clears the isolation back to showing every plotted curve.

Input:
	event [Event]: a dblclick event from the file table

Output:
	(none) [void]: toggles the isolated color group and redraws the plot

*/
export function handle_table_dblclick(event) {
  const swatch = event.target.closest(".filename_color_swatch");
  if (!swatch || !swatch.dataset.colorGroup) return;
  toggle_isolated_color_group(swatch.dataset.colorGroup);
  render_density_plot();
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
    prune_focused_file_id();
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
      prune_focused_file_id();
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
  // In remove-columns mode, header clicks pick columns to delete instead of
  // sorting/filtering.
  if (handle_remove_columns_click(event.target)) return;

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

  // Clicking anywhere on a checked sample's row (not its checkbox) brings it
  // into focus for per-sample review UI (e.g. Identify Peaks) -- only
  // meaningful when more than one file is checked at once, since with exactly
  // one checked file that file is unambiguously the one being reviewed.
  const body_row = event.target.closest("tbody tr[data-file-id]");
  if (body_row) {
    const file_id = body_row.dataset.fileId;
    if (file_id && selected_file_ids.has(file_id) && file_id !== focused_file_id) {
      set_focused_file_id(file_id);
      file_table.querySelectorAll("tbody tr[data-file-id]").forEach((row_el) => {
        row_el.classList.toggle("metadata_row_focused", row_el.dataset.fileId === file_id);
      });
      notify_focus_changed();
    }
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
