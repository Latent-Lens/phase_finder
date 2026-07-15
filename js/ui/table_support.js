// Sidebar toggle, table support helpers, and display-row preparation. This
// module dispatches table selection events, controls sidebar collapsed state,
// filters rows, sorts rows, and builds table header/control markup. It formats
// display names, filter controls, sort indicators, editable header labels, and
// stat header groupings used by the renderer. It also contains filename
// annotation guessing and timepoint sorting helpers used by table workflows and
// unit tests. Rendering and delegated DOM event handling live in
// js/ui/table_render.js.

import {
  app_shell,
  sidebar,
  sidebar_content,
  sidebar_toggle,
  sidebar_toggle_icon,
  SIDEBAR_OPEN_ICON,
  SIDEBAR_CLOSE_ICON,
  SIDEBAR_TRANSITION_MS,
  channel_select,
  collapsed_channel_select,
} from "./dom.js";
import { Tooltips } from "./hover_text.js";
import { escape_html } from "../util/html.js";
import { display_name } from "../util/names.js";
import { get_file_table, set_file_table } from "../state/app_state.js";
import { TABLE_COLUMNS, column_filters, sort_state, open_filter_field } from "../data_structs/table_state.js";
import { PhaseFinderFrame } from "../data_structs/metadata_frame.js";
import { frame_to_rows, unique_column_values, populate_channel_controls, update_start_button_state } from "./status_channels.js";
import { render_file_table } from "./table_render.js";

/*

Purpose:
	Dispatches the custom "fcs-selection-change" event so the plot
	(js/plotting/render.js) can add/remove curves when the checked set changes.
	A custom name avoids the native "selectionchange".

Input:
	(none)

Output:
	(none) [void]: dispatches a document event

*/
export function notify_selection_changed() {
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
export function set_sidebar_collapsed(is_collapsed) {
  app_shell.classList.toggle("sidebar_collapsed", is_collapsed);
  sidebar.classList.toggle("is_collapsed", is_collapsed);
  sidebar_content.setAttribute("aria-hidden", String(is_collapsed));
  if ("inert" in sidebar_content) sidebar_content.inert = is_collapsed;

  sidebar_toggle.setAttribute("aria-expanded", String(!is_collapsed));
  Tooltips.set_quick_tooltip(sidebar_toggle, is_collapsed ? "sidebarExpand" : "sidebarCollapse");
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
export function toggle_sidebar() {
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
export function displayed_files() {
  const frame = get_file_table();
  if (!frame || frame.length === 0) return [];

  let rows = frame_to_rows(frame);

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
export function sort_indicator(field) {
  const active = sort_state.field === field;
  const asc_class = active && sort_state.direction === "asc" ? "sort_arrow active" : "sort_arrow";
  const desc_class = active && sort_state.direction === "desc" ? "sort_arrow active" : "sort_arrow";
  const sort_ascending_title = escape_html(Tooltips.text("sortAscending"));
  const sort_descending_title = escape_html(Tooltips.text("sortDescending"));
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
export function filter_control(column) {
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
            <button type="button" class="th_filter_toggle multi_select_toggle" data-filter-field="${column.field}" aria-expanded="${is_open}" title="${escape_html(Tooltips.text("filterBy", column.label))}">${escape_html(summary.join(", "))}</button>
            <div class="multi_select_menu" data-filter-menu="${column.field}"${is_open ? "" : " hidden"}>${options}</div>
          </div>`;
}

export function header_label_control(column) {
  if (column.headerEditable) {
    return `
          <div class="metadata_header_editor">
            <input
              class="metadata_header_input"
              data-field="${escape_html(column.field)}"
              type="text"
              value="${escape_html(column.label)}"
              aria-label="Metadata column header"
            />
            <button
              class="metadata_header_ok"
              data-field="${escape_html(column.field)}"
              type="button"
              aria-label="Confirm metadata column header"
            >OK</button>
          </div>`;
  }
  return `<button type="button" class="th_sort" data-sort-field="${column.field}">${escape_html(column.label)}${sort_indicator(column.field)}</button>`;
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
export function header_cell(column) {
  const filter = column.filterable ? filter_control(column) : "";

  return `
        <th${column_key_attrs(column)}>
          <div class="th_inner">
            ${header_label_control(column)}
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
// data-column-key marks a header as removable in remove-columns mode. The
// Filename column is the row key and is never removable.
export function column_key_attrs(column) {
  if (!column || column.field === "name") return "";
  return ` data-column-key="field:${escape_html(column.field)}" data-column-label="${escape_html(column.label)}"`;
}

export function header_label_cell(column) {
  return `<th class="stats_label_th"${column_key_attrs(column)}>${header_label_control(column)}</th>`;
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
export function header_filter_cell(column) {
  const filter = column.filterable ? filter_control(column) : "";
  return `<th class="stats_filter_th"${column_key_attrs(column)}>${filter}</th>`;
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
export function annotation_input_size(value) {
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
export function update_views() {
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
export function guess_annotations_from_filename(filename) {
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
export function timepoint_sort_value(value) {
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
export function sort_file_table() {
  const frame = get_file_table();
  if (!frame || frame.length === 0) return;

  const rows = frame_to_rows(frame);
  rows.sort((a, b) => {
    return String(a.name ?? "").localeCompare(String(b.name ?? ""), undefined, { numeric: true, sensitivity: "base" });
  });

  // Reconstruct column-oriented data and rebuild the frame.
  const cols = frame.columns;
  const col_data = Object.fromEntries(cols.map((col) => [col, rows.map((row) => row[col] ?? null)]));
  set_file_table(new PhaseFinderFrame(col_data, [...cols]));
}
