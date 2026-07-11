// Manual one-button-per-stage DJF debugging UI. Every click runs only its
// selected stage for all currently plottable rows and records per-sample output.

import {
  djf_stage_buttons,
  djf_run_all_button,
} from "../../ui/dom.js";
import { djf_readout, plottable_rows, plot_bin_count } from "../../plotting/data.js";
import { render_density_plot } from "../../plotting/render.js";
import {
  set_status_bar,
  show_progress,
  update_progress,
  hide_progress,
  next_frame,
} from "../../ui/status_channels.js";
import { load_pipeline } from "./pipeline_loader.js";
import { init_scatter_modal, open_scatter_modal } from "./scatter_modal.js";

const IMPLEMENTED_STAGE_COUNT = 9;
let initialized = false;
let pipeline_busy = false;

function set_pipeline_controls_disabled(disabled) {
  djf_stage_buttons.forEach((stageButton) => {
    if (stageButton) stageButton.disabled = disabled;
  });
  if (djf_run_all_button) djf_run_all_button.disabled = disabled;
}

function format_stage_result(stage, entry) {
  const result = entry.result;
  const name = entry.name.replace(/\.fcs$/i, "");
  if (result.skipped) return `${name}: Stage ${stage} skipped — ${result.reason}`;

  if (stage === 0) {
    return `${name}: Stage 0 retained ${result.retainedEventCount.toLocaleString()} / ${result.eventCount.toLocaleString()} events`;
  }
  if (stage === 1) {
    const flagged = result.scoredBins.filter((bin) => bin.flagged).length;
    return `${name}: Stage 1 retained ${result.retainedEventCount.toLocaleString()} events · ${flagged}/${result.scoredBins.length} time bins flagged`;
  }
  if (stage === 2) {
    return `${name}: Stage 2 retained ${result.retainedEventCount.toLocaleString()} / ${result.fittedEventCount.toLocaleString()} eligible events · GMM ${result.converged ? "converged" : "not converged"}`;
  }
  if (stage === 3) {
    return `${name}: Stage 3 retained ${result.retainedSingletCount.toLocaleString()} / ${result.fittedEventCount.toLocaleString()} pulse-geometry events · ${result.geometryMode}`;
  }
  if (stage === 4) {
    return `${name}: Stage 4 binned ${result.binnedCount.toLocaleString()} retained events into ${result.binCount} bins`;
  }
  if (stage === 5) {
    return result.found
      ? `${name}: Stage 5 peaks at ${result.mu1.toFixed(2)} and ${result.mu2.toFixed(2)} · ratio ${result.ratio.toFixed(3)}`
      : `${name}: Stage 5 found no valid peak pair — ${result.status}`;
  }
  if (stage === 6) {
    return `${name}: Stage 6 ${result.diagnostics.converged ? "converged" : "stopped"} in ${result.diagnostics.iterations} iterations · G1 ${result.parameters.mu1.toFixed(2)} · G2/G1 ${result.parameters.R.toFixed(3)}`;
  }
  if (stage === 7) {
    return `${name}: Stage 7 selected ${result.selectedModel} · ${result.diagnostics.candidateFits.length} candidate model(s) compared`;
  }
  if (stage === 8) {
    const fractions = result.fractions.biologicalSinglets;
    return `${name}: Stage 8 · 1C ${(100 * fractions.oneC).toFixed(1)}% · S ${(100 * fractions.sPhase).toFixed(1)}% · 2C ${(100 * fractions.twoC).toFixed(1)}% · ${result.warnings.length} warning(s) · background model not specified`;
  }
  return `${name}: Stage ${stage} complete`;
}

async function run_manual_stage(
  stage,
  button,
  { keepOverlay = false, openScatter = true, managedByRunAll = false } = {},
) {
  if (pipeline_busy && !managedByRunAll) return [];
  const rows = plottable_rows();
  if (!rows.length) {
    const message = "Plot at least one selected sample before running a DJF stage.";
    if (djf_readout) djf_readout.textContent = message;
    set_status_bar(message, true);
    return [];
  }

  if (!managedByRunAll) {
    pipeline_busy = true;
    set_pipeline_controls_disabled(true);
  }
  button.disabled = true;
  button.classList.add("djf_stage_running");
  button.classList.remove("djf_stage_complete");
  djf_stage_buttons.slice(stage + 1).forEach((downstreamButton) =>
    downstreamButton?.classList.remove("djf_stage_complete")
  );

  try {
    const pipeline = await load_pipeline();
    // Let the lazy-loader's hide timer settle before reusing the overlay for
    // per-sample progress.
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    show_progress(`Running DJF Stage ${stage}`);
    const outputs = [];
    const stageOptions = stage === 4
      ? { binCount: plot_bin_count(), range: pipeline.shared_histogram_range(rows) }
      : {};

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      update_progress(
        (100 * index) / rows.length,
        `Running DJF Stage ${stage}`,
        `Sample ${index + 1} of ${rows.length}`,
        row.name,
      );
      await next_frame();
      outputs.push(pipeline.run_stage(stage, row, stageOptions));
    }

    update_progress(100, `Running DJF Stage ${stage}`, `Finished ${rows.length} sample(s).`);
    // Every stage can invalidate downstream state, so redraw even for stages
    // without their own visual output to remove stale histograms/fits/reports.
    render_density_plot();
    if (stage === 2 && openScatter) {
      const inspect = outputs.find((entry) => !entry.result.skipped);
      if (inspect) open_scatter_modal(rows.find((row) => row.name === inspect.name), inspect.result);
    }
    if (djf_readout) {
      djf_readout.textContent = outputs.map((entry) => format_stage_result(stage, entry)).join("\n");
    }
    button.classList.add("djf_stage_complete");
    set_status_bar(`DJF Stage ${stage} complete for ${rows.length} sample(s).`);
    if (!keepOverlay) hide_progress(350);
    return outputs;
  } catch (error) {
    const message = `DJF Stage ${stage} failed: ${error.message}`;
    if (djf_readout) djf_readout.textContent = message;
    set_status_bar(message, true);
    update_progress(100, `DJF Stage ${stage} failed`, error.message);
    hide_progress(1200);
    return [];
  } finally {
    button.classList.remove("djf_stage_running");
    if (!managedByRunAll) {
      pipeline_busy = false;
      set_pipeline_controls_disabled(false);
    }
  }
}

async function run_manual_all() {
  if (!djf_run_all_button || pipeline_busy) return [];
  pipeline_busy = true;
  set_pipeline_controls_disabled(true);
  djf_run_all_button.classList.add("djf_stage_running");
  const originalText = djf_run_all_button.textContent;
  const outputs = [];

  try {
    for (let stage = 0; stage < IMPLEMENTED_STAGE_COUNT; stage += 1) {
      djf_run_all_button.textContent = `Running Stage ${stage}…`;
      const stageOutputs = await run_manual_stage(stage, djf_stage_buttons[stage], {
        keepOverlay: stage < IMPLEMENTED_STAGE_COUNT - 1,
        openScatter: false,
        managedByRunAll: true,
      });
      if (!stageOutputs.length) break;
      outputs.push(stageOutputs);
    }
    if (outputs.length === IMPLEMENTED_STAGE_COUNT) {
      djf_run_all_button.classList.add("djf_stage_complete");
      set_status_bar("All nine DJF pipeline stages completed.");
    }
    return outputs;
  } finally {
    djf_run_all_button.textContent = originalText;
    pipeline_busy = false;
    set_pipeline_controls_disabled(false);
    djf_run_all_button.classList.remove("djf_stage_running");
  }
}

export function init_pipeline_ui() {
  if (initialized) return;
  initialized = true;
  init_scatter_modal();

  djf_stage_buttons.forEach((button, stage) => {
    if (!button) return;
    if (stage >= IMPLEMENTED_STAGE_COUNT) {
      button.disabled = true;
      button.title = "This stage is enabled by the next pipeline checkpoint.";
      return;
    }
    button.addEventListener("click", () => run_manual_stage(stage, button));
  });

  if (djf_run_all_button) {
    djf_run_all_button.disabled = false;
    djf_run_all_button.title = "Run all nine stages in order for selected samples.";
    djf_run_all_button.addEventListener("click", run_manual_all);
  }
}

export { run_manual_stage, run_manual_all };
