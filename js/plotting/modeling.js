// DJF modeling UI state and fit-summary presentation. This module updates the
// plot title, manages whether modeling has started, chooses which sample fits
// are visible, and renders the fit-results overlay table. It resets modeling
// state when the plotted channel changes so stale fits are not shown for a new
// channel. Starting modeling first lazy-loads the DJF numeric stack, then selects
// an initial sample fit and asks the renderer to redraw with model overlays. Raw
// histogram drawing and model math live in other plotting/analysis files.

import {
  plot_title,
  plot_area,
  djf_readout,
  plot_channels,
  set_plot_channels,
  set_modeling_started,
  shown_fits,
  set_peak_threshold,
  plottable_rows,
  strip_fcs,
  plot_escape_html,
  format_fit_number,
} from "./data.js";
import { render_density_plot } from "./render.js";
import { load_djf } from "./djf_loader.js";

// The fit-results overlay element; recreated each render. Owned here because
// only this module reads or replaces it.
let djf_fit_table = null;

/*

Purpose:
	Updates the plot panel title to show the number of plotted samples and the
	total number of events across them.

Input:
	rows [Array<Object>]: the currently plotted samples
	event_count [number]: optional pre-computed event count

Output:
	(none) [void]: sets the #plot_title text

*/
export function update_plot_title(rows, event_count = null) {
  if (!plot_title) return;
  const events = event_count == null
    ? rows.reduce((sum, row) => sum + row.data.dna_a.length, 0)
    : event_count;
  plot_title.textContent = `Histogram of Events:  ${rows.length} Samples  |  ${events.toLocaleString()} Events`;
}

/*

Purpose:
	Renders a tabular summary of the currently visible DJF fits. Each fitted
	sample contributes one row per phase with metadata and component moments.

Input:
	fits [Array<Object>]: visible DJF fit objects
	placement [Object]:   positioning for the table overlay

Output:
	(none) [void]: updates #djf_fit_table

*/
export function render_fit_results_table(fits, placement = {}) {
  if (!plot_area) return;
  if (!fits.length) {
    if (djf_fit_table) {
      djf_fit_table.hidden = true;
      djf_fit_table.innerHTML = "";
    }
    return;
  }
  djf_fit_table = document.createElement("div");
  djf_fit_table.id = "djf_fit_table";
  djf_fit_table.className = "djf_fit_table_wrap";
  djf_fit_table.style.top = `${Math.round(placement.top || 0)}px`;
  djf_fit_table.style.right = `${Math.round(placement.right || 8)}px`;
  if (placement.max_width) djf_fit_table.style.max_width = `${Math.round(placement.max_width)}px`;

  const fit_groups = [];
  fits.forEach((fit) => {
    const annotations = fit.row && fit.row.annotations ? fit.row.annotations : {};
    const meta = [
      `Strain: ${annotations.strain || ""}`,
      `Replicate: ${annotations.replicate || ""}`,
      `Nocodazole Arrest: ${annotations.nocodazoleArrest || ""}`,
      `Timepoint: ${annotations.timepoint || ""}`,
    ];
    const phase_rows = [fit.phase_stats.g1, fit.phase_stats.s, fit.phase_stats.g2]
      .map((phase) => `
        <tr class="djf_fit_phase_row">
          <td>${plot_escape_html(phase.phase)}</td>
          <td class="numeric_cell">${format_fit_number(phase.percent, 1)}%</td>
          <td class="numeric_cell">${format_fit_number(phase.mean, 2)}</td>
          <td class="numeric_cell">${format_fit_number(phase.stdev, 2)}</td>
        </tr>`)
      .join("");

    fit_groups.push(`
      <tbody class="djf_fit_group">
        <tr class="djf_fit_title_row">
          <th colspan="4">
            <span class="djf_fit_sample" title="${plot_escape_html(fit.name)}">${plot_escape_html(strip_fcs(fit.name))}</span>
            <span class="djf_fit_meta">${plot_escape_html(meta.join("  |  "))}</span>
          </th>
        </tr>
        <tr class="djf_fit_column_row">
          <th>Phase</th>
          <th class="numeric_cell">Percent</th>
          <th class="numeric_cell">Mean</th>
          <th class="numeric_cell">Std Dev</th>
        </tr>
        ${phase_rows}
      </tbody>`);
  });

  djf_fit_table.innerHTML = `
    <table class="djf_fit_table">
      ${fit_groups.join("")}
    </table>`;
  djf_fit_table.hidden = false;
  plot_area.appendChild(djf_fit_table);
}


/*

Purpose:
	Clears DJF modeling state so a newly selected channel starts as a plain
	event plot until the user starts modeling again.

Input:
	(none)

Output:
	(none) [void]: resets modeling flags and fit selections

*/
export function reset_modeling_state() {
  set_modeling_started(false);
  shown_fits.clear();
  set_peak_threshold(null);
  if (djf_readout) {
    djf_readout.textContent = "";
  }
}

/*

Purpose:
	Initializes the plot once analysis has loaded data: stores the selected
	channel info and renders. Subsequent redraws are driven by control changes
	and table selection changes.

Input:
	channels [Object]: the selected channels, e.g. { dna_area }

Output:
	(none) [void]: stores plot state and triggers the first render

*/
export function init_plot(channels) {
  set_plot_channels(channels);
  render_density_plot();
}

/*

Purpose:
	Begins DJF modeling (triggered by the "Start Modeling (DJF)" button). Lazily
	loads the DJF numeric stack on first use, then shows only the first plotted
	sample's fit; the rest are toggled on via their legend checkboxes.

Input:
	(none)

Output:
	(none) [Promise<void>]: loads DJF if needed, enables modeling, and re-renders

*/
export async function start_modeling() {
  if (!plot_channels) return;
  await load_djf();
  set_modeling_started(true);
  const rows = plottable_rows();
  shown_fits.clear();
  if (rows.length) shown_fits.add(rows[0].name);
  render_density_plot();
}

/*

Purpose:
	Toggles whether a sample's DJF fit is shown, from its legend checkbox. The
	sample's data curve is unaffected (it follows the table selection).

Input:
	name [string]: the sample's full row.name

Output:
	(none) [void]: updates shown_fits and re-renders

*/
export function toggle_fit(name) {
  if (shown_fits.has(name)) {
    shown_fits.delete(name);
  } else {
    shown_fits.add(name);
  }
  render_density_plot();
}
