// Plot title and cell-cycle fit-summary presentation.
//
// LEGACY-01: this overlay reports CANONICAL model results only. It used to also
// render the legacy stage-8 fit report (its contamination percentages and its
// R^2/RMSE/reduced-chi-square goodness block) whenever a sample carried one,
// which put legacy diagnostics -- computed from different likelihood and
// contamination equations, and not gated by the result contract -- into the same
// table cells as canonical Dean-Jett/DJF/Watson numbers. That path is gone; the
// legacy bridge is an unvalidated compatibility model and never populates this
// surface.

import {
  plot_title,
  plot_area,
  strip_fcs,
  plot_escape_html,
  format_fit_number,
} from "./data.js";

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
	Renders a tabular summary of the currently visible canonical cell-cycle fits.
	Each fitted sample contributes one row per phase with metadata and component
	moments, plus the fit's own warnings.

Input:
	fits [Array<Object>]: visible canonical fit objects
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
    // Canonical models (Dean-Jett, DJF, Watson, Auto) carry their fit warnings
    // on the series entry itself (fit.warnings, each {code, severity, message}).
    // Show the actual warning messages here in the top-right overlay so the user
    // sees what a fit flagged, not just a count in the sidebar.
    const model_warnings = Array.isArray(fit.warnings) ? fit.warnings : [];
    let model_warning_rows = "";
    if (model_warnings.length) {
      const items = model_warnings
        .map((warning) => `<li>${plot_escape_html(warning.message || String(warning))}</li>`)
        .join("");
      model_warning_rows = `
        <tr class="djf_fit_warnings_row djf_fit_model_warnings_row">
          <td colspan="4">
            <span class="djf_fit_warnings_title">⚠ ${model_warnings.length} fit warning${model_warnings.length === 1 ? "" : "s"}</span>
            <ul class="djf_fit_warnings_list">${items}</ul>
          </td>
        </tr>`;
    }

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
        ${model_warning_rows}
      </tbody>`);
  });

  djf_fit_table.innerHTML = `
    <table class="djf_fit_table">
      ${fit_groups.join("")}
    </table>`;
  djf_fit_table.hidden = false;
  plot_area.appendChild(djf_fit_table);
}
