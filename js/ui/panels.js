// Metadata and plot panel collapse/expand behavior. This module owns shared DOM
// references for analysis buttons, modeling buttons, plot panels, metadata
// panels, panel bodies, and panel toggle icons. It applies collapsed state by
// updating CSS classes, ARIA attributes, inert state, icons, and resize
// notifications. It provides small toggle wrappers consumed by analysis start
// and panel controls. It intentionally does not load data or render plots; it
// manages only the workspace shell around those workflows.

import { Tooltips } from "./hover_text.js";

export const analysis_start_button = document.querySelector("#start_analysis_button");
export const analysis_collapsed_plot_button = document.querySelector("#collapsed_plot_button");
export const cell_cycle_modeling_button = document.querySelector("#cell_cycle_modeling_button");
export const collapsed_cell_cycle_modeling_button = document.querySelector("#collapsed_cell_cycle_modeling_button");
export const plot_panel = document.querySelector("#plot_panel");
export const metadata_panel = document.querySelector("#metadata_panel");
export const metadata_panel_body = document.querySelector("#metadata_panel_body");
export const metadata_panel_toggle = document.querySelector("#metadata_panel_toggle");
export const metadata_panel_toggle_icon = document.querySelector("#metadata_panel_toggle_icon");
export const plot_panel_toggle = document.querySelector("#plot_panel_toggle");
export const plot_panel_toggle_icon = document.querySelector("#plot_panel_toggle_icon");
export const plot_panel_body = document.querySelector("#plot_panel_body");
const TABLE_MINIMIZE_ICON = "./assets/img/table_minimize.svg";
const TABLE_RESTORE_ICON = "./assets/img/table_restore.svg";
const TABLE_PANEL_TRANSITION_MS = 220;

/*

Purpose:
	Collapses or expands the metadata (Loaded FCS Samples) panel, updating its
	CSS class, body accessibility state, aria-expanded state, and toggle icon.

Input:
	is_collapsed [boolean]: true to collapse the panel, false to expand it

Output:
	(none) [void]: updates the metadata panel DOM

*/
export function set_metadata_panel_collapsed(is_collapsed) {
  if (metadata_panel.classList.contains("is_collapsed") === is_collapsed) {
    return;
  }

  metadata_panel.classList.toggle("is_collapsed", is_collapsed);
  metadata_panel_body.setAttribute("aria-hidden", String(is_collapsed));
  if ("inert" in metadata_panel_body) metadata_panel_body.inert = is_collapsed;

  const table_tooltip_key = is_collapsed ? "tableExpand" : "tableCollapse";
  metadata_panel_toggle.setAttribute("aria-expanded", String(!is_collapsed));
  Tooltips.set_quick_tooltip(metadata_panel_toggle, table_tooltip_key);
  metadata_panel_toggle.setAttribute("aria-label", Tooltips.text(table_tooltip_key));
  metadata_panel_toggle_icon.src = is_collapsed ? TABLE_RESTORE_ICON : TABLE_MINIMIZE_ICON;

  const notify_layout_changed = () => window.dispatchEvent(new Event("resize"));
  window.requestAnimationFrame(notify_layout_changed);
  window.setTimeout(notify_layout_changed, TABLE_PANEL_TRANSITION_MS);
}

/*

Purpose:
	Convenience wrapper that collapses the metadata panel.

Input:
	(none)

Output:
	(none) [void]: collapses the metadata panel

*/
export function collapse_metadata_panel() {
  set_metadata_panel_collapsed(true);
}

/*

Purpose:
	Toggles the metadata panel between its collapsed and expanded states.

Input:
	(none)

Output:
	(none) [void]: toggles the metadata panel

*/
export function toggle_metadata_panel() {
  set_metadata_panel_collapsed(!metadata_panel.classList.contains("is_collapsed"));
}

/*

Purpose:
	Collapses or expands the plot panel, updating its CSS class, body
	accessibility state, aria-expanded state, and toggle icon.

Input:
	is_collapsed [boolean]: true to collapse the panel, false to expand it

Output:
	(none) [void]: updates the plot panel DOM

*/
export function set_plot_panel_collapsed(is_collapsed) {
  if (plot_panel.classList.contains("is_collapsed") === is_collapsed) {
    return;
  }

  plot_panel.classList.toggle("is_collapsed", is_collapsed);
  plot_panel_body.setAttribute("aria-hidden", String(is_collapsed));
  if ("inert" in plot_panel_body) plot_panel_body.inert = is_collapsed;

  const plot_tooltip_key = is_collapsed ? "plotExpand" : "plotCollapse";
  plot_panel_toggle.setAttribute("aria-expanded", String(!is_collapsed));
  Tooltips.set_quick_tooltip(plot_panel_toggle, plot_tooltip_key);
  plot_panel_toggle.setAttribute("aria-label", Tooltips.text(plot_tooltip_key));
  plot_panel_toggle_icon.src = is_collapsed ? TABLE_RESTORE_ICON : TABLE_MINIMIZE_ICON;

  const notify_layout_changed = () => window.dispatchEvent(new Event("resize"));
  window.requestAnimationFrame(notify_layout_changed);
  window.setTimeout(notify_layout_changed, TABLE_PANEL_TRANSITION_MS);
}

export function toggle_plot_panel() {
  set_plot_panel_collapsed(!plot_panel.classList.contains("is_collapsed"));
}
