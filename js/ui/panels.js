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
export const sidebar_back_button = document.querySelector("#sidebar_back_button");
export const sidebar_modeling_section = document.querySelector("#sidebar_modeling_section");
const app_shell = document.querySelector(".app");
const sidebar_content = document.querySelector("#sidebar_content");
const sidebar_title = document.querySelector(".sidebar_title_row h2");
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

// Sidebar "Cell Cycle Modeling" mode: the file/channel controls cross-fade out
// and the relocated QC + DJF controls fade in. Title swaps at the faded midpoint.
const SIDEBAR_MODE_FADE_MS = 150;
const SIDEBAR_TITLE_FILES = "FCS Files";
const SIDEBAR_TITLE_MODELING = "Cell Cycle Modeling";

/*

Purpose:
	Toggles the sidebar between file-loading mode and Cell Cycle Modeling mode.
	Modeling mode hides the file/channel controls and the Plot/Modeling/Stats
	action buttons, reveals the relocated Pre-modeling QC + manual DJF controls
	plus a Back button, and swaps the sidebar title. Nothing is destroyed — file
	state, selections, and any in-progress QC/DJF work persist across toggles.

Input:
	on [boolean]: true to enter modeling mode, false to return to file mode

Output:
	(none) [void]: updates the sidebar DOM (class, title, focus) and re-lays-out
	the plot via a resize event

*/
export function set_sidebar_modeling_mode(on) {
  if (!app_shell || app_shell.classList.contains("sidebar_modeling_mode") === on) {
    return;
  }

  const notify_layout_changed = () => window.dispatchEvent(new Event("resize"));

  const apply = () => {
    app_shell.classList.toggle("sidebar_modeling_mode", on);
    if (sidebar_title) {
      sidebar_title.textContent = on ? SIDEBAR_TITLE_MODELING : SIDEBAR_TITLE_FILES;
    }
    // Move focus onto a control that is visible in the new mode so it never
    // falls back to <body> when the previously focused button is hidden.
    const focus_target = on
      ? document.querySelector("#qc_stage0")
      : cell_cycle_modeling_button;
    if (focus_target && !focus_target.disabled) focus_target.focus();
    window.requestAnimationFrame(notify_layout_changed);
    window.setTimeout(notify_layout_changed, SIDEBAR_MODE_FADE_MS);
  };

  const reduce_motion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce_motion || !sidebar_content) {
    apply();
    return;
  }

  // Cross-dissolve: fade the sidebar content (and title) out, swap the visible
  // controls while invisible, then fade back in on the next frame.
  sidebar_content.classList.add("sidebar_mode_fading");
  if (sidebar_title) sidebar_title.classList.add("sidebar_mode_fading");
  window.setTimeout(() => {
    apply();
    window.requestAnimationFrame(() => {
      sidebar_content.classList.remove("sidebar_mode_fading");
      if (sidebar_title) sidebar_title.classList.remove("sidebar_mode_fading");
    });
  }, SIDEBAR_MODE_FADE_MS);
}

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
