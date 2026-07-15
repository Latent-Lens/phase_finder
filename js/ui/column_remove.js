// Remove-columns mode: a non-blocking, draggable floating panel plus
// click-to-select anywhere on the table's column headers or their body cells.
// Entering the mode lets the user click any removable column (every column
// except the Filename key) to toggle it for deletion; selected columns are
// outlined header-to-last-row by an animated dashed overlay box, and are
// listed in the panel. "Remove" drops them from the frame (and, for metadata
// columns, from TABLE_COLUMNS); "Cancel" — or clicking any other button in the
// app — leaves everything untouched and exits the mode.
// Header/cell identification relies on the data-column-key attributes that
// table_render/table_support emit on both the header and every body cell of a
// column, so a column's full vertical extent can be measured, outlined, and
// clicked anywhere within it.

import { get_file_table } from "../state/app_state.js";
import { TABLE_COLUMNS, set_metadata_table_columns } from "../data_structs/table_state.js";
import { escape_html } from "../util/html.js";
import { render_file_table } from "./table_render.js";
import {
  file_table,
  metadata_remove_column_button,
  remove_columns_panel,
  remove_columns_header,
  remove_columns_list,
  remove_columns_confirm,
  remove_columns_cancel,
} from "./dom.js";

let remove_mode = false;
const selected = new Map(); // column key -> display label
let overlay_layer = null;
let resize_listener_attached = false;

export function is_remove_columns_mode() {
  return remove_mode;
}

function on_viewport_change() {
  recompute_overlays();
}

// Any click outside the floating panel and outside the table (i.e. not a
// column pick) exits the mode without applying anything — same as Cancel.
// The toggle button itself is excluded since it already handles enter/exit on
// its own click listener.
function on_outside_click(event) {
  if (!remove_mode) return;
  const target = event.target;
  if (remove_columns_panel?.contains(target)) return;
  if (file_table?.contains(target)) return;
  if (metadata_remove_column_button?.contains(target)) return;
  exit_mode();
}

function reset_panel_position() {
  if (!remove_columns_panel) return;
  remove_columns_panel.style.left = "";
  remove_columns_panel.style.top = "";
  remove_columns_panel.style.right = "";
  remove_columns_panel.style.bottom = "";
}

function enter_mode() {
  remove_mode = true;
  selected.clear();
  metadata_remove_column_button?.setAttribute("aria-pressed", "true");
  reset_panel_position(); // always spawn at the default bottom-right spot
  if (remove_columns_panel) remove_columns_panel.hidden = false;
  file_table?.classList.add("remove_columns_active");
  update_panel();
  render_file_table(); // re-render so decorate_removable_headers tags the headers
  if (!resize_listener_attached) {
    window.addEventListener("resize", on_viewport_change);
    file_table?.addEventListener("scroll", on_viewport_change, { passive: true });
    resize_listener_attached = true;
  }
  document.addEventListener("click", on_outside_click);
}

function exit_mode() {
  remove_mode = false;
  selected.clear();
  metadata_remove_column_button?.setAttribute("aria-pressed", "false");
  if (remove_columns_panel) remove_columns_panel.hidden = true;
  file_table?.classList.remove("remove_columns_active");
  if (resize_listener_attached) {
    window.removeEventListener("resize", on_viewport_change);
    file_table?.removeEventListener("scroll", on_viewport_change);
    resize_listener_attached = false;
  }
  document.removeEventListener("click", on_outside_click);
  overlay_layer = null; // the table re-render below discards the old layer element
  render_file_table(); // clears the removable decorations and any overlay boxes
}

// Tag every removable header and body cell (and mark the currently selected
// ones). Called at the end of render_file_table while the mode is active.
export function decorate_removable_headers() {
  if (!remove_mode || !file_table) return;
  file_table.querySelectorAll("th[data-column-key], td[data-column-key]").forEach((cell) => {
    cell.classList.add("col_removable");
  });
  overlay_layer = null; // render_file_table just replaced the table's innerHTML
  recompute_overlays();
}

// Only header cells carry data-column-label; body cells share the same
// data-column-key without it. Look up the header's label so clicking a body
// cell still lists a readable name rather than the raw key.
function label_for_key(key) {
  const labeled = file_table.querySelector(`[data-column-key="${CSS.escape(key)}"][data-column-label]`);
  return labeled?.getAttribute("data-column-label") || key;
}

// Toggle a column's selection. Called from table_render's delegated click
// handler while the mode is active; returns true when it consumed the click (so
// sorting/filtering doesn't also fire). Clicking anywhere in a column's header
// or its body cells (every cell in a removable column carries the same
// data-column-key) picks that column.
export function handle_remove_columns_click(target) {
  if (!remove_mode) return false;
  const cell = target.closest("[data-column-key]");
  if (!cell || !file_table.contains(cell)) return false;

  const key = cell.getAttribute("data-column-key");
  if (selected.has(key)) {
    selected.delete(key);
  } else {
    selected.set(key, label_for_key(key));
  }
  update_panel();
  recompute_overlays();
  return true;
}

function update_panel() {
  if (remove_columns_list) {
    // A CSS grid (2 columns, row-major auto-flow) rather than a real <table> or
    // <ul>: no table chrome to strip and no list-marker/grid interaction to fight
    // with — each item supplies its own bullet via CSS. Map iteration order is
    // insertion order, so items land row1/col1, row1/col2, row2/col1, … in the
    // order columns were selected (a deselect+reselect moves an item to the end,
    // since it's a fresh insertion).
    remove_columns_list.innerHTML = selected.size
      ? `<div class="remove_columns_grid">${[...selected.values()]
          .map((label) => `<span class="remove_columns_item">${escape_html(label)}</span>`)
          .join("")}</div>`
      : "(None)";
  }
  if (remove_columns_confirm) {
    const count = selected.size;
    remove_columns_confirm.textContent = `Remove ${count} selected column${count === 1 ? "" : "s"}`;
    remove_columns_confirm.disabled = count === 0;
  }
}

// ── Column outline overlay ───────────────────────────────────────────────────
// Draws one dashed box per contiguous run of selected columns, spanning header
// to last row, instead of decorating individual cells. Adjacent selected
// columns merge into a single box; a column separated by an unselected one gets
// its own box.

function ensure_overlay_layer() {
  if (overlay_layer && file_table.contains(overlay_layer)) return overlay_layer;
  overlay_layer = document.createElement("div");
  overlay_layer.className = "col_remove_overlay_layer";
  file_table.appendChild(overlay_layer);
  return overlay_layer;
}

// Left-to-right column order, determined by each column's rendered position
// (robust to the header's two-row/colspan/rowspan structure — every leaf column
// has at least one element carrying its key, wherever it happens to render).
function ordered_column_keys() {
  const first_seen = new Map(); // key -> representative element
  file_table.querySelectorAll("[data-column-key]").forEach((el) => {
    const key = el.getAttribute("data-column-key");
    if (!first_seen.has(key)) first_seen.set(key, el);
  });
  return [...first_seen.entries()]
    .sort((a, b) => a[1].getBoundingClientRect().left - b[1].getBoundingClientRect().left)
    .map(([key]) => key);
}

function recompute_overlays() {
  if (!remove_mode || !file_table) return;
  const layer = ensure_overlay_layer();
  layer.innerHTML = "";
  if (!selected.size) return;

  const order = ordered_column_keys();
  const selected_indices = order
    .map((key, index) => (selected.has(key) ? index : -1))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);
  if (!selected_indices.length) return;

  // Cluster consecutive column indices into runs, e.g. [1,2,3,5] -> [[1,2,3],[5]].
  const clusters = [];
  let current = [selected_indices[0]];
  for (let i = 1; i < selected_indices.length; i += 1) {
    if (selected_indices[i] === current[current.length - 1] + 1) {
      current.push(selected_indices[i]);
    } else {
      clusters.push(current);
      current = [selected_indices[i]];
    }
  }
  clusters.push(current);

  const container_rect = file_table.getBoundingClientRect();
  const scroll_left = file_table.scrollLeft;
  const scroll_top = file_table.scrollTop;

  for (const cluster of clusters) {
    const keys = cluster.map((index) => order[index]);
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const key of keys) {
      const cells = file_table.querySelectorAll(`[data-column-key="${CSS.escape(key)}"]`);
      cells.forEach((cell) => {
        const rect = cell.getBoundingClientRect();
        left = Math.min(left, rect.left);
        top = Math.min(top, rect.top);
        right = Math.max(right, rect.right);
        bottom = Math.max(bottom, rect.bottom);
      });
    }
    if (!Number.isFinite(left)) continue;

    const box = document.createElement("div");
    box.className = "col_remove_overlay_box";
    box.style.left = `${left - container_rect.left + scroll_left}px`;
    box.style.top = `${top - container_rect.top + scroll_top}px`;
    box.style.width = `${right - left}px`;
    box.style.height = `${bottom - top}px`;
    layer.appendChild(box);
  }
}

function remove_selected_columns() {
  if (!selected.size) return;
  const frame = get_file_table();
  const metadata_fields = [];

  for (const key of selected.keys()) {
    if (key.startsWith("field:")) {
      metadata_fields.push(key.slice("field:".length));
    } else if (key.startsWith("col:")) {
      frame?.dropCol(key.slice("col:".length));
    }
  }

  if (metadata_fields.length) {
    const remaining = TABLE_COLUMNS.filter(
      (column) => column.field !== "name" && !metadata_fields.includes(column.field),
    );
    set_metadata_table_columns(remaining);
    metadata_fields.forEach((field) => frame?.dropCol(field));
  }

  exit_mode();
}

// ── Drag-to-reposition (by the title bar) ───────────────────────────────────
// Switches the panel from its default right/bottom-anchored spawn position to
// an explicit left/top position on the first drag, so it can be moved anywhere
// in the viewport; reset_panel_position() (called on every enter_mode) clears
// that override so it always spawns back at the default bottom-right spot.

let drag_state = null;

function on_header_mousedown(event) {
  if (!remove_columns_panel || event.button !== 0) return;
  const rect = remove_columns_panel.getBoundingClientRect();
  drag_state = {
    start_x: event.clientX,
    start_y: event.clientY,
    start_left: rect.left,
    start_top: rect.top,
    width: rect.width,
    height: rect.height,
  };
  remove_columns_panel.style.left = `${rect.left}px`;
  remove_columns_panel.style.top = `${rect.top}px`;
  remove_columns_panel.style.right = "auto";
  remove_columns_panel.style.bottom = "auto";
  document.body.style.userSelect = "none";
  event.preventDefault();
}

function on_drag_move(event) {
  if (!drag_state || !remove_columns_panel) return;
  const dx = event.clientX - drag_state.start_x;
  const dy = event.clientY - drag_state.start_y;
  const max_left = Math.max(window.innerWidth - drag_state.width, 0);
  const max_top = Math.max(window.innerHeight - drag_state.height, 0);
  const left = Math.min(Math.max(drag_state.start_left + dx, 0), max_left);
  const top = Math.min(Math.max(drag_state.start_top + dy, 0), max_top);
  remove_columns_panel.style.left = `${left}px`;
  remove_columns_panel.style.top = `${top}px`;
}

function on_drag_end() {
  if (!drag_state) return;
  drag_state = null;
  document.body.style.userSelect = "";
}

export function init_remove_columns() {
  metadata_remove_column_button?.addEventListener("click", () => {
    if (remove_mode) exit_mode();
    else enter_mode();
  });
  remove_columns_cancel?.addEventListener("click", exit_mode);
  remove_columns_confirm?.addEventListener("click", remove_selected_columns);
  remove_columns_header?.addEventListener("mousedown", on_header_mousedown);
  document.addEventListener("mousemove", on_drag_move);
  document.addEventListener("mouseup", on_drag_end);
}
