// User-facing analysis and modeling orchestration. This module coordinates the
// transition from loaded metadata to plotted channel data, then from plotted
// data to DJF modeling mode. It enables and disables plot action controls while
// channel data is loading so users cannot start conflicting workflows. It
// responds to channel changes by loading or activating the selected channel
// cache and redrawing the plot. init_analysis_listeners() (called once by the
// entry bootstrap) wires the analysis buttons, plot-panel toggles,
// selection-change handling, and channel-change handling.

import {
  analysis_start_button,
  analysis_collapsed_plot_button,
  cell_cycle_modeling_button,
  collapsed_cell_cycle_modeling_button,
  sidebar_back_button,
  set_sidebar_modeling_mode,
  plot_panel,
  metadata_panel_toggle,
  plot_panel_toggle,
  toggle_metadata_panel,
  toggle_plot_panel,
} from "../ui/panels.js";
import { set_sidebar_collapsed } from "../ui/table_support.js";
import { Tooltips } from "../ui/hover_text.js";
import { get_parsed_files } from "../state/files.js";
import {
  get_selected_channels,
  set_status,
  set_status_bar,
  show_progress,
  update_progress,
  hide_progress,
  next_frame,
  update_start_button_state,
} from "../ui/status_channels.js";
import { is_analysis_data_loaded, activate_analysis_data } from "../data_structs/channel_cache.js";
import { plot_channels } from "../plotting/data.js";
import { init_plot } from "../plotting/modeling.js";
import { render_density_plot } from "../plotting/render.js";
import {
  ANALYSIS_FILE_CONCURRENCY,
  load_analysis_data,
  load_analysis_batch,
  refresh_analysis_after_metadata_change,
} from "../io/channel_loading.js";

let channel_change_load_id = 0;

/*

Purpose:
	Forces the plot action controls disabled/enabled while modal channel-data
	loading is in progress.

Input:
	is_disabled [boolean]: true to disable plot controls

Output:
	(none) [void]: updates the plot action buttons

*/
function set_plot_action_controls_disabled(is_disabled) {
  [analysis_start_button, analysis_collapsed_plot_button].forEach((button) => {
    if (button) {
      button.disabled = is_disabled;
    }
  });
}

/*

Purpose:
	Disables pipeline actions after the selected channel changes until the new
	channel is explicitly plotted.

Input:
	(none)

Output:
	(none) [void]: updates button text, class, and tooltip

*/
function enter_plotting_mode() {
  [cell_cycle_modeling_button, collapsed_cell_cycle_modeling_button].forEach((btn) => {
    if (!btn) return;
    btn.disabled = true;
    btn.setAttribute("aria-label", Tooltips.text("cellCycleModelingDisabled"));
    Tooltips.set_quick_tooltip(btn, "cellCycleModelingDisabled");
  });
}

/*

Purpose:
	After a plot exists and the selected channel changes, load missing data for
	the new channel with the modal progress UI, then switch the visible plot
	over to it once loading finishes (or immediately, if its data was already
	cached from an earlier plot).

Input:
	(none)

Output:
	(none) [Promise<void>]: loads selected-row data for the newly selected channel

*/
async function prepare_selected_channel_for_plotting() {
  const selected = get_selected_channels();

  if (!plot_channels) {
    return;
  }

  const request_id = ++channel_change_load_id;
  const rows = get_parsed_files();

  enter_plotting_mode();

  update_start_button_state();

  if (!selected.dna_area || !rows.length) {
    set_status_bar("Load files and select a channel before plotting.", true);
    return;
  }

  const missing_rows = rows.filter((row) => !is_analysis_data_loaded(row, selected));
  if (!missing_rows.length) {
    // Data for this channel is already cached (e.g. switching back to a
    // previously-plotted channel). Activate it, but leave plotting explicit:
    // the action button remains "Plot Channel Events" until the user clicks it.
    rows.forEach((row) => activate_analysis_data(row, selected));
    render_density_plot();
    set_status_bar(`Channel ${selected.dna_area} data ready.`);
    return;
  }

  const completed = { count: 0 };
  const label = `Loading ${selected.dna_area} Channel FCS Data`;
  set_plot_action_controls_disabled(true);
  show_progress(label);
  set_status_bar(`Working: ${label}`);
  update_progress(0, label, `Preparing ${missing_rows.length} file(s)...`);
  await next_frame();

  try {
    for (let start = 0; start < missing_rows.length; start += ANALYSIS_FILE_CONCURRENCY) {
      const batch = missing_rows.slice(start, start + ANALYSIS_FILE_CONCURRENCY).map((row, offset) => ({
        row,
        index: start + offset,
      }));
      await load_analysis_batch(batch, selected, completed, missing_rows.length, label, {
        activate: false,
        detail_prefix: "Loading data",
      });
    }

    if (request_id === channel_change_load_id) {
      // Now that the new channel's data has actually finished loading,
      // activate it for every row (it was loaded with activate: false to
      // avoid disturbing the old plot mid-load). Redraw against the prior
      // plot-channel key so the curves clear while axes remain; clicking
      // "Plot Channel Events" explicitly switches to the new channel.
      rows.forEach((row) => activate_analysis_data(row, selected));
      render_density_plot();
      set_status_bar(`Channel ${selected.dna_area} data ready — pre-loaded ${missing_rows.length} file(s).`);
      update_progress(100, label, `Finished loading data for ${missing_rows.length} file(s).`);
    }
  } finally {
    if (request_id === channel_change_load_id) {
      hide_progress(700);
      update_start_button_state();
    }
  }
}

/*

Purpose:
	Enables the convenience action that runs the manual DJF pipeline after a
	channel has been plotted.

Input:
	(none)

Output:
	(none) [void]: updates the button text/style and the modeling flag

*/
function enable_pipeline_action() {
  [cell_cycle_modeling_button, collapsed_cell_cycle_modeling_button].forEach((btn) => {
    if (!btn) return;
    btn.disabled = false;
    btn.setAttribute("aria-label", Tooltips.text("cellCycleModeling"));
    Tooltips.set_quick_tooltip(btn, "cellCycleModeling");
  });
}

/*

Purpose:
	Click handler for plot controls. Loads the selected data and reveals the plot;
	manual DJF stages remain separate controls.

Input:
	(none)

Output:
	(none) [Promise<void>]: runs analysis or starts modeling

*/
export async function start_analysis() {
  plot_panel.hidden = false;
  document.dispatchEvent(new CustomEvent("pf-plot-started", {
    detail: { channel: get_selected_channels().dna_area },
  }));

  try {
    await load_analysis_data();
    enable_pipeline_action();
    document.dispatchEvent(new CustomEvent("pf-plot-complete", {
      detail: { channel: get_selected_channels().dna_area },
    }));
  } catch (error) {
    set_status(error.message, true);
    set_status_bar("Selected data loading failed.", true);
    update_progress(100, "Loading Selected FCS Data", error.message);
    hide_progress(1400);
  }
}

/*

Purpose:
	Wires the analysis buttons, plot-panel toggles, selection-change refresh, and
	channel-change reload. Called once by the entry bootstrap.

Input:
	(none)

Output:
	(none) [void]: installs analysis-related listeners

*/
export function init_analysis_listeners() {
  metadata_panel_toggle.addEventListener("click", toggle_metadata_panel);
  plot_panel_toggle.addEventListener("click", toggle_plot_panel);
  analysis_start_button.addEventListener("click", start_analysis);
  analysis_collapsed_plot_button.addEventListener("click", start_analysis);

  document.addEventListener("fcs-selection-change", () => {
    refresh_analysis_after_metadata_change({ redraw_if_no_missing: false }).catch((error) => {
      set_status(error.message, true);
      set_status_bar("Selected data loading failed.", true);
      update_progress(100, "Loading Added FCS Data", error.message);
      hide_progress(1400);
    });
  });

  document.addEventListener("fcs-channel-change", () => {
    prepare_selected_channel_for_plotting().catch((error) => {
      set_status(error.message, true);
      set_status_bar("Selected channel data loading failed.", true);
      update_progress(100, "Loading Selected FCS Data", error.message);
      hide_progress(1400);
      update_start_button_state();
    });
  });

  // The sidebar "Cell Cycle Modeling" buttons switch the sidebar into modeling
  // mode (they no longer run the pipeline — the relocated Run all / stage
  // buttons do that once modeling mode is open). The collapsed-rail variant
  // expands the sidebar first so the modeling controls are actually visible.
  if (cell_cycle_modeling_button) {
    cell_cycle_modeling_button.addEventListener("click", () => set_sidebar_modeling_mode(true));
  }
  if (collapsed_cell_cycle_modeling_button) {
    collapsed_cell_cycle_modeling_button.addEventListener("click", () => {
      set_sidebar_collapsed(false);
      set_sidebar_modeling_mode(true);
    });
  }
  if (sidebar_back_button) {
    sidebar_back_button.addEventListener("click", () => set_sidebar_modeling_mode(false));
  }
}
