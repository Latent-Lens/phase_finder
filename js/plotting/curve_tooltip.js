// Hover tooltip for sample curves in the density plot. Replaces the old fixed
// per-sample legend: hovering a curve (via its wide invisible hit-stroke, see
// render.js) shows the sample's filename and every metadata-table value
// directly next to the cursor, instead of a separate always-visible list.

import { TABLE_COLUMNS } from "../data_structs/table_state.js";
import { escape_html } from "../util/html.js";
import { strip_fcs } from "./data.js";

let tip = null;

function ensure_tip() {
  if (tip) return tip;
  tip = document.createElement("div");
  tip.id = "plot_curve_tooltip";
  tip.className = "plot_curve_tooltip";
  tip.setAttribute("aria-hidden", "true");
  document.body.appendChild(tip);
  return tip;
}

// DNA-content edge values can be large; show up to 2 decimals with grouping.
function fmt_value(value) {
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function tooltip_row(label, value) {
  return `<div class="plot_curve_tooltip_row">` +
    `<span class="plot_curve_tooltip_label">${escape_html(label)}:</span> ` +
    `${escape_html(String(value))}</div>`;
}

// `bin` (optional): { left, right, count } for the histogram bin under the
// cursor's x, so a curve/bin readout shows the concrete values there.
function tooltip_html(entry, bin) {
  const swatch = entry.color
    ? `<span class="plot_curve_tooltip_swatch" style="background:${escape_html(entry.color)}"></span>`
    : "";
  const meta = TABLE_COLUMNS
    .filter((column) => column.field !== "name")
    .map((column) => {
      const value = entry.row?.annotations?.[column.field];
      if (value == null || value === "") return "";
      return tooltip_row(column.label, value);
    })
    .join("");
  const bin_rows = bin
    ? `<div class="plot_curve_tooltip_sep"></div>` +
      tooltip_row("Bin left edge", fmt_value(bin.left)) +
      tooltip_row("Bin right edge", fmt_value(bin.right)) +
      tooltip_row("Events in bin", Number(bin.count).toLocaleString())
    : "";
  return `<div class="plot_curve_tooltip_title">${swatch}${escape_html(strip_fcs(entry.name))}</div>${meta}${bin_rows}`;
}

/*

Purpose:
	Positions the tooltip near the cursor, flipping to whichever side keeps it
	fully inside the viewport.

Input:
	event [PointerEvent]: the triggering pointer event (reads clientX/clientY)

Output:
	(none) [void]: updates the tooltip element's position

*/
function position_tip(event) {
  if (!tip) return;
  const pad = 14;
  const rect = tip.getBoundingClientRect();
  let x = event.clientX + pad;
  let y = event.clientY + pad;
  if (x + rect.width > window.innerWidth) x = event.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight) y = event.clientY - rect.height - pad;
  tip.style.left = `${Math.round(Math.max(0, x))}px`;
  tip.style.top = `${Math.round(Math.max(0, y))}px`;
}

/*

Purpose:
	Shows (and positions) the curve tooltip for one series entry, including the
	histogram bin under the cursor when provided. Called on both pointerenter
	and pointermove: the bin changes as the cursor slides along a curve, so the
	content is rebuilt each move rather than only repositioned.

Input:
	event [PointerEvent]: the hover/move event driving the tooltip's position
	entry [Object]: a render_density_plot series entry ({ row, name, color, ... })
	bin [Object|null]: { left, right, count } for the bin under the cursor's x

Output:
	(none) [void]: updates the shared tooltip element

*/
export function show_curve_tooltip(event, entry, bin = null) {
  const el = ensure_tip();
  el.innerHTML = tooltip_html(entry, bin);
  el.setAttribute("aria-hidden", "false");
  el.classList.add("visible");
  position_tip(event);
}

export function hide_curve_tooltip() {
  if (!tip) return;
  tip.classList.remove("visible");
  tip.setAttribute("aria-hidden", "true");
}
