// Shared DOM references and layout constants. This leaf module captures, once,
// the elements the app wires and reads across several modules (upload targets,
// status/progress UI, channel selectors, the metadata table + toolbar, the
// metadata wizard modal, and the sidebar). Because the entry module loads as a
// deferred ES module, these querySelector calls run after the document is parsed,
// so every reference resolves. It imports nothing, so any module can import these
// refs without forming a dependency cycle. Panel- and plot-specific DOM refs stay
// in ui/panels.js and plotting/data.js respectively.

// ── Upload / drop targets ────────────────────────────────────────────────────
export const file_input = document.querySelector("#file_input");
export const file_upload_section = document.querySelector("#file_upload_section");
export const drop_zone = document.querySelector("#drop_zone");
export const collapsed_upload_target = document.querySelector("#collapsed_upload_target");
export const drop_zone_title = document.querySelector("#drop_zone_title");
export const drop_zone_hint = document.querySelector("#drop_zone_hint");
export const loaded_files_panel = document.querySelector("#loaded_files_panel");
export const loaded_files_label = document.querySelector("#loaded_files_label");
export const loaded_files_list = document.querySelector("#loaded_files_list");

// ── Status / progress ────────────────────────────────────────────────────────
export const status_el = document.querySelector("#status");
export const status_bar = document.querySelector("#status_bar");
export const status_bar_message = document.querySelector("#status_bar_message");
export const progress_overlay = document.querySelector("#progress_overlay");
export const progress_fill = document.querySelector("#progress_fill");
export const progress_label = document.querySelector("#progress_label");
export const progress_percent = document.querySelector("#progress_percent");
export const progress_detail = document.querySelector("#progress_detail");

// ── Channel selectors ────────────────────────────────────────────────────────
export const channel_select = document.querySelector("#channel_select");
export const collapsed_channel_select = document.querySelector("#collapsed_channel_select");
export const channel_eligibility_status = document.querySelector("#channel_eligibility_status");

// ── Pre-modeling QC gate toggle buttons ──────────────────────────────────────
export const qc_gate_buttons = [
  document.querySelector("#qc_structural"),
  document.querySelector("#qc_time"),
  document.querySelector("#qc_cellgate"),
  document.querySelector("#qc_singlet"),
];
export const qc_gate_run_all = document.querySelector("#qc_filter_all");

// Structural QC's DNA saturation-ceiling settings (structural_qc_settings.js)
// carry a "Change…" line of their own, matching Time QC's.
export const structural_qc_line = document.querySelector("#structural_qc_line");
export const structural_qc_summary_name = document.querySelector("#structural_qc_summary_name");
export const structural_qc_edit = document.querySelector("#structural_qc_edit");

// Time QC is the one QC filter with a choice of algorithm (robust summary vs
// peak tracking), so it carries a method line and a result summary of its own.
export const time_qc_method_line = document.querySelector("#time_qc_method_line");
export const time_qc_method_name = document.querySelector("#time_qc_method_name");
export const time_qc_method_edit = document.querySelector("#time_qc_method_edit");
export const time_qc_summary = document.querySelector("#time_qc_summary");

// ── Identify Peaks (sidebar peak-review panel) ───────────────────────────────
export const peak_review_focus = document.querySelector("#peak_review_focus");
export const detect_peaks_button = document.querySelector("#detect_peaks_button");
export const peak_review_status = document.querySelector("#peak_review_status");
export const peak_region_g1_left = document.querySelector("#peak_region_g1_left");
export const peak_region_g1_right = document.querySelector("#peak_region_g1_right");
export const peak_region_g2_left = document.querySelector("#peak_region_g2_left");
export const peak_region_g2_right = document.querySelector("#peak_region_g2_right");
export const peak_region_error = document.querySelector("#peak_region_error");
export const peak_regions_reset_button = document.querySelector("#peak_regions_reset_button");
export const peak_regions_accept_button = document.querySelector("#peak_regions_accept_button");
export const peak_regions_apply_all_button = document.querySelector("#peak_regions_apply_all_button");

// ── Model & Fit (sidebar cell-cycle model panel) ─────────────────────────────
export const cell_cycle_model_select = document.querySelector("#cell_cycle_model_select");
export const cell_cycle_fit_current_button = document.querySelector("#cell_cycle_fit_current_button");
export const cell_cycle_fit_all_button = document.querySelector("#cell_cycle_fit_all_button");
export const cell_cycle_fit_status = document.querySelector("#cell_cycle_fit_status");
export const cell_cycle_fit_result = document.querySelector("#cell_cycle_fit_result");

// ── Plot toolbar axis-range button ───────────────────────────────────────────
// AD-1: this button lives in dom.js (not plotting/data.js, which WS-1 owns for
// MODEL-09) even though its five sibling plot_tool_* buttons are registered
// there. plot_toolbar.js imports this one ref from here instead.
export const plot_tool_axes = document.querySelector("#plot_tool_axes");

// ── Companion (Height/Width/FSC/SSC) channel panel ───────────────────────────
export const channel_aux_panel = document.querySelector("#channel_aux_panel");
export const aux_height_select = document.querySelector("#aux_height_select");
export const aux_width_select = document.querySelector("#aux_width_select");
export const aux_fsc_select = document.querySelector("#aux_fsc_select");
export const aux_ssc_select = document.querySelector("#aux_ssc_select");

// ── Metadata table + toolbar ─────────────────────────────────────────────────
export const file_table = document.querySelector("#file_table");
export const metadata_add_column_button = document.querySelector("#metadata_add_column_button");
export const metadata_remove_column_button = document.querySelector("#metadata_remove_column_button");

// ── Remove-columns floating panel ────────────────────────────────────────────
export const remove_columns_panel = document.querySelector("#remove_columns_panel");
export const remove_columns_header = document.querySelector("#remove_columns_header");
export const remove_columns_list = document.querySelector("#remove_columns_list");
export const remove_columns_confirm = document.querySelector("#remove_columns_confirm");
export const remove_columns_cancel = document.querySelector("#remove_columns_cancel");
export const metadata_import_button = document.querySelector("#metadata_import_button");
export const metadata_import_input = document.querySelector("#metadata_import_input");
export const metadata_parse_button = document.querySelector("#metadata_parse_button");
export const metadata_export_button = document.querySelector("#metadata_export_button");

// ── Metadata wizard modal ────────────────────────────────────────────────────
export const metadata_wizard_modal = document.querySelector("#metadata_wizard_modal");
export const metadata_wizard_close = document.querySelector("#metadata_wizard_close");
export const metadata_wizard_cancel = document.querySelector("#metadata_wizard_cancel");
export const metadata_wizard_apply = document.querySelector("#metadata_wizard_apply");
export const metadata_wizard_reset = document.querySelector("#metadata_wizard_reset");
export const metadata_split_steps = document.querySelector("#metadata_split_steps");
export const metadata_add_split_step = document.querySelector("#metadata_add_split_step");
export const metadata_column_editor = document.querySelector("#metadata_column_editor");
export const metadata_preview = document.querySelector("#metadata_preview");

// ── Plot action buttons (also referenced by ui/panels.js under other names) ──
export const start_analysis_button = document.querySelector("#start_analysis_button");
export const collapsed_plot_button = document.querySelector("#collapsed_plot_button");

// ── Cell Gate diagnostics modal ─────────────────────────────────────────────
export const djf_scatter_modal = document.querySelector("#djf_scatter_modal");
export const djf_scatter_modal_close = document.querySelector("#djf_scatter_modal_close");
export const djf_scatter_reset = document.querySelector("#djf_scatter_reset");
export const djf_scatter_coverage = document.querySelector("#djf_scatter_coverage");
export const djf_scatter_coverage_value = document.querySelector("#djf_scatter_coverage_value");
export const djf_scatter_plot = document.querySelector("#djf_scatter_plot");
export const djf_scatter_caption = document.querySelector("#djf_scatter_caption");

// ── App shell / sidebar ──────────────────────────────────────────────────────
export const app_shell = document.querySelector(".app");
export const sidebar = document.querySelector("#sidebar");
export const sidebar_content = document.querySelector("#sidebar_content");
export const sidebar_toggle = document.querySelector("#sidebar_toggle");
export const sidebar_toggle_icon = document.querySelector("#sidebar_toggle_icon");

export const SIDEBAR_CLOSE_ICON = new URL("../../assets/img/sidepanel_close.svg", import.meta.url).href;
export const SIDEBAR_OPEN_ICON = new URL("../../assets/img/sidepanel_open.svg", import.meta.url).href;
export const SIDEBAR_TRANSITION_MS = 220;

const REQUIRED_DOM = {
  file_input,
  drop_zone,
  channel_select,
  file_table,
  sidebar,
  sidebar_content,
  sidebar_toggle,
  status_bar_message,
  progress_overlay,
  metadata_wizard_modal,
  start_analysis_button,
};

export function assert_required_dom() {
  const missing = Object.entries(REQUIRED_DOM).filter(([, element]) => !element).map(([name]) => name);
  if (missing.length) throw new Error(`Required PhaseFinder DOM elements are missing: ${missing.join(", ")}`);
}
