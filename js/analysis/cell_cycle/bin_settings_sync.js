// Owns the plot's "Bins" slider and keeps the cell-cycle modeling workflow in
// sync with it.
//
// The Bins slider (#plot_bins) is a range input over discrete power-of-two
// stops (plotting/data.js's BIN_STOPS: 128..1024); its native value is the
// stop index. The chosen bin count drives the plot AND -- captured at fit time
// -- peak detection and model fitting. This module:
//
//   * mirrors the slider position into a live "512"-style value label;
//   * paints the slider track green->amber->red by how risky each stop's bin
//     count is for the loaded sample(s) (too few events/bin = noisy; too coarse
//     = G1/G2 merge), and explains that colouring in the slider tooltip;
//   * marks the recommended stop for the current data;
//   * on a committed change, if any sample already has detected peaks or a fit,
//     shows a blocking "recalculating" modal and automatically rebuilds each
//     sample's histogram at the new bin count and re-fits it with its last
//     model, so every displayed value reflects the new bin size.

import {
  plot_bins_input,
  plot_bin_count,
  plottable_rows,
  BIN_STOPS,
  DEFAULT_BINS,
  slider_index_for_bins,
  clamp_range_to_axis_override,
} from "../../plotting/data.js";
import { render_density_plot } from "../../plotting/render.js";
import { pipeline_states, invalidate_histogram_dependents, invalidate_model_results } from "../pipeline_state.js";
import { load_pipeline } from "../pipeline_loader.js";
import {
  get_modeling_state,
  fit_cell_cycle_model,
  detect_peak_regions,
  accept_peak_regions,
} from "./modeling_state.js";
import { set_status_bar } from "../../ui/status_channels.js";

let initialized = false;
let recalc_busy = false;
let last_committed_bins = plot_bin_count();

// Single-level undo for the most recent bin-size recalculation: a snapshot of
// every sample's modeling state + histogram taken just before the recalc, plus
// the prior slider index, so an accidental change (which re-detects peaks and
// discards manual edits) can be reverted whole. Replaced by the next change,
// cleared once applied.
let bin_undo = null;

const bins_value_label = document.querySelector("#plot_bins_value");
const bins_ticks = document.querySelector("#plot_bins_ticks");
const bins_undo_button = document.querySelector("#plot_bins_undo");
const recalc_modal = document.querySelector("#bin_recalc_modal");
const recalc_detail = document.querySelector("#bin_recalc_detail");

// Events-per-bin thresholds. Below MIN the histogram is too sparse (Poisson
// noise invents peaks); between MIN and COMFORTABLE it is usable but getting
// noisy. 128 bins is flagged coarse regardless of counts (G1/S/G2 can merge).
const MIN_EVENTS_PER_BIN = 20;
const COMFORTABLE_EVENTS_PER_BIN = 50;
const COARSE_BIN_COUNT = 128;

const RISK_COLORS = {
  safe: "#22c55e",
  caution: "#f59e0b",
  danger: "#ef4444",
  unknown: "#cbd5e1",
};

// Static explanation appended to the (data-driven) slider tooltip. The
// events-per-bin figure and recommendation are prepended per-sample in
// update_slider_visuals().
const SLIDER_TOOLTIP_STATIC =
  "Histogram bins for the plot, peak detection, and model fitting. " +
  "Track colour = risk: green a good balance; amber coarse (G1/S/G2 peaks may " +
  "merge) or getting sparse; red too few events per bin (noisy, risks spurious " +
  "peaks). Changing this after peak detection or modeling re-runs both automatically.";

// Post-QC event count actually binned when a histogram exists, else the raw
// loaded event count, else null.
function sample_event_count(row) {
  const state = pipeline_states.get(row.name);
  const retained = state?.histogram?.retainedCount;
  if (Number.isFinite(retained) && retained > 0) return retained;
  return Number.isFinite(row.data?.eventCount) ? row.data.eventCount : null;
}

// The smallest event count across the currently plotted samples -- danger and
// the recommendation are driven by the worst-case sample so every sample keeps
// adequate counts per bin.
function worst_case_event_count() {
  const counts = plottable_rows()
    .map(sample_event_count)
    .filter((count) => Number.isFinite(count) && count > 0);
  return counts.length ? Math.min(...counts) : null;
}

function stop_risk(stopBins, eventCount) {
  if (!Number.isFinite(eventCount) || eventCount <= 0) return "unknown";
  const perBin = eventCount / stopBins;
  if (perBin < MIN_EVENTS_PER_BIN) return "danger";
  if (stopBins <= COARSE_BIN_COUNT) return "caution";
  if (perBin < COMFORTABLE_EVENTS_PER_BIN) return "caution";
  return "safe";
}

// A stop is recommended when it is the largest (finest) stop that is still
// "safe" for the worst-case sample -- maximum resolution without going noisy.
// Falls back to the default stop when there's no data yet.
function recommended_index(eventCount) {
  if (!Number.isFinite(eventCount) || eventCount <= 0) return slider_index_for_bins(DEFAULT_BINS);
  let best = -1;
  for (let i = 0; i < BIN_STOPS.length; i += 1) {
    if (stop_risk(BIN_STOPS[i], eventCount) === "safe") best = i;
  }
  // No stop is fully safe (tiny sample) -> recommend the coarsest (most
  // events/bin); if every stop is safe, `best` is already the finest.
  return best >= 0 ? best : 0;
}

// The per-sample events/bin + recommendation sentence, prepended to the static
// tooltip so hovering the slider explains the current choice (moved here from a
// separate visible hint line).
function bins_guidance_text(bins, eventCount) {
  if (!Number.isFinite(eventCount) || eventCount <= 0) {
    return `Recommended ${DEFAULT_BINS} bins for DNA histograms (${BIN_STOPS[0]}–${BIN_STOPS[BIN_STOPS.length - 1]}).`;
  }
  const recommended = BIN_STOPS[recommended_index(eventCount)];
  const sampleCount = plottable_rows().length;
  const scope = sampleCount > 1 ? ` (smallest of ${sampleCount} samples)` : "";
  const perBin = Math.round(eventCount / bins);
  const risk = stop_risk(bins, eventCount);
  if (risk === "danger") {
    return `${bins} bins is too fine — only ~${perBin} events/bin${scope}; try ${recommended}.`;
  }
  if (risk === "caution") {
    return `${bins} bins works (~${perBin}/bin${scope}) but ${recommended} is recommended.`;
  }
  return `${bins} bins — ~${perBin} events/bin${scope}. Recommended ${recommended}.`;
}

// Repaints the value label, the track danger gradient, the recommended tick,
// and the data-driven tooltip from the current slider position and loaded data.
function update_slider_visuals() {
  const bins = plot_bin_count();
  const eventCount = worst_case_event_count();

  if (bins_value_label) bins_value_label.textContent = String(bins);
  if (plot_bins_input) {
    plot_bins_input.title = `${bins_guidance_text(bins, eventCount)} ${SLIDER_TOOLTIP_STATIC}`;
  }

  // Track gradient: each stop's risk colour anchored at that stop's position
  // (0/33/66/100% for the four stops), matching the tick labels below and so
  // blending smoothly between neighbours.
  if (plot_bins_input) {
    const stops = BIN_STOPS.map((stopBins, i) => {
      const pos = (i / (BIN_STOPS.length - 1)) * 100;
      return `${RISK_COLORS[stop_risk(stopBins, eventCount)]} ${pos}%`;
    });
    plot_bins_input.style.setProperty("--bins-track", `linear-gradient(to right, ${stops.join(", ")})`);
  }

  const recIndex = recommended_index(eventCount);
  if (bins_ticks) {
    bins_ticks.querySelectorAll(".plot_bins_tick").forEach((tick) => {
      tick.classList.toggle("plot_bins_tick_recommended", Number(tick.dataset.index) === recIndex);
    });
  }
}

function show_recalc_modal(text) {
  if (recalc_detail) recalc_detail.textContent = text;
  if (recalc_modal) recalc_modal.hidden = false;
}

function hide_recalc_modal() {
  if (recalc_modal) recalc_modal.hidden = true;
}

// For each already-computed sample: rebuild its histogram at the new bin
// count, re-run automatic peak detection against it, re-accept, and re-fit the
// ones that had a fit with their last model. (Re-detecting keeps the modeling
// state -- including its histogram fingerprint, which the result key is built
// from -- consistent with the new histogram; a manual peak edit is not
// preserved across a bin-size change, matching the "re-run auto peak-detection"
// behaviour.)
async function recalculate_all(targets) {
  const pipeline = await load_pipeline();
  const rows = plottable_rows();
  const range = clamp_range_to_axis_override(pipeline.shared_histogram_range(rows));
  const binCount = plot_bin_count();

  // Snapshot before touching anything: fitting mutates activeResultKey.
  const plan = targets.map((row) => {
    const modeling = get_modeling_state(row);
    return { row, modelId: modeling.settings.modelId, hadFit: Boolean(modeling.activeResultKey) };
  });

  let refit = 0;
  let failed = 0;
  for (let i = 0; i < plan.length; i += 1) {
    const { row, modelId, hadFit } = plan[i];
    show_recalc_modal(`Recalculating ${i + 1} of ${plan.length}: ${row.name}`);
    try {
      pipeline.ensure_histogram_current(row, { binCount, range });
      detect_peak_regions(row);
      accept_peak_regions(row);
      if (hadFit) {
        await fit_cell_cycle_model(row, modelId);
        refit += 1;
      }
    } catch (_) {
      failed += 1;
      // A detection/refit that fails at the new bin count (e.g. an infeasible
      // ratio) must not leave the previous bin count's result active over the
      // freshly rebuilt histogram -- clear the stale fit so no mismatched
      // overlay shows.
      invalidate_model_results(pipeline_states.get(row.name), "bin recalc refit failed");
    }
  }

  return { refit, failed, total: plan.length };
}

function show_undo_button() {
  if (bins_undo_button) bins_undo_button.hidden = false;
}

function hide_undo_button() {
  if (bins_undo_button) bins_undo_button.hidden = true;
}

// Deep-clones every sample's modeling state + histogram and the prior slider
// position, before a recalc mutates them. Fit results carry no functions (see
// the "don't store live progress/cancel closures" fix), so structuredClone is
// safe here.
function capture_undo_snapshot(previousBins) {
  const states = new Map();
  for (const [name, state] of pipeline_states) {
    states.set(name, {
      modeling: structuredClone(state.modeling),
      histogram: state.histogram ? structuredClone(state.histogram) : null,
    });
  }
  bin_undo = { previousIndex: slider_index_for_bins(previousBins), previousBins, states };
}

function clear_undo() {
  bin_undo = null;
  hide_undo_button();
}

// Restores the snapshot captured before the last recalc: every sample's
// modeling state + histogram, and the slider position. Reverts the whole
// bin-size change, including any peak regions/manual edits the recalc's
// re-detection discarded.
function apply_undo() {
  if (!bin_undo || recalc_busy) return;
  for (const [name, snap] of bin_undo.states) {
    const state = pipeline_states.get(name);
    if (!state) continue;
    state.modeling = snap.modeling;
    state.histogram = snap.histogram;
  }
  if (plot_bins_input) plot_bins_input.value = String(bin_undo.previousIndex);
  const restored = bin_undo.previousBins;
  last_committed_bins = plot_bin_count();
  clear_undo();
  document.dispatchEvent(new CustomEvent("cell-cycle-regions-changed"));
  document.dispatchEvent(new CustomEvent("cell-cycle-fit-changed"));
  render_density_plot();
  update_slider_visuals();
  set_status_bar(`Reverted bin size to ${restored}.`);
}

// Shared recompute for any change to the modeling histogram identity -- bin
// count or the visible x-range. Rebuilds each plotted computed sample's
// histogram and re-fits it (recalculate_all), and invalidates any non-plotted
// computed states. `undoFromBins` (a prior bin count), when given, snapshots
// for the one-click bins undo and shows the button; an x-range recompute passes
// nothing (it isn't covered by the bins undo -- the axis modal has its own Reset).
async function run_recompute({ statusPrefix, undoFromBins = null }) {
  const plotted = plottable_rows();
  const plottedNames = new Set(plotted.map((row) => row.name));

  // Read-only: which plotted samples have computed peaks/fits to recalculate.
  const targets = plotted.filter((row) => {
    const modeling = pipeline_states.get(row.name)?.modeling;
    return modeling && (modeling.peakSelection.regions || modeling.activeResultKey);
  });

  if (!targets.length) {
    clear_undo();
    for (const [name, state] of pipeline_states) {
      if (!plottedNames.has(name)) invalidate_histogram_dependents(state, "histogram identity changed");
    }
    render_density_plot();
    update_slider_visuals();
    return;
  }

  if (undoFromBins != null) capture_undo_snapshot(undoFromBins);
  else clear_undo();

  // Non-plotted computed samples can't be rebuilt here (no live channel view);
  // mark them stale so they recompute when next used.
  for (const [name, state] of pipeline_states) {
    if (!plottedNames.has(name)) invalidate_histogram_dependents(state, "histogram identity changed");
  }

  recalc_busy = true;
  if (plot_bins_input) plot_bins_input.disabled = true;
  show_recalc_modal("Recalculating all values…");
  try {
    const { refit, failed, total } = await recalculate_all(targets);
    set_status_bar(
      `${statusPrefix} Recalculated ${total} sample${total === 1 ? "" : "s"}` +
        `${refit ? `, re-fit ${refit}` : ""}${failed ? `, ${failed} failed` : ""}.`,
      failed > 0 && refit === 0,
    );
    if (undoFromBins != null) show_undo_button();
  } finally {
    hide_recalc_modal();
    recalc_busy = false;
    if (plot_bins_input) plot_bins_input.disabled = false;
    document.dispatchEvent(new CustomEvent("cell-cycle-regions-changed"));
    document.dispatchEvent(new CustomEvent("cell-cycle-fit-changed"));
    render_density_plot();
    update_slider_visuals();
  }
}

async function on_bins_commit() {
  if (recalc_busy) return;
  const bins = plot_bin_count();
  if (bins === last_committed_bins) return; // dragged back to the same stop
  const previousBins = last_committed_bins;
  last_committed_bins = bins;
  await run_recompute({ statusPrefix: `Bin size changed to ${bins}.`, undoFromBins: previousBins });
}

// Fired by the axis modal (pf-x-range-changed) when the user explicitly sets or
// clears the x-range, changing how much data is visible. That bounds the
// modeling histogram, so peaks/fits recompute -- same as a bin-count change.
// (A future interactive zoom/pan is viewport-only and must not fire this.)
async function on_x_range_change() {
  if (recalc_busy) return;
  await run_recompute({ statusPrefix: "X-axis range changed." });
}

export function init_bin_settings_sync() {
  if (initialized) return;
  initialized = true;

  if (plot_bins_input) {
    // Live feedback while dragging (label/colour/hint), commit + recalc on release.
    plot_bins_input.addEventListener("input", update_slider_visuals);
    plot_bins_input.addEventListener("change", on_bins_commit);
  }
  if (bins_undo_button) bins_undo_button.addEventListener("click", apply_undo);
  document.addEventListener("pf-x-range-changed", on_x_range_change);

  document.addEventListener("fcs-selection-change", update_slider_visuals);
  document.addEventListener("cell-cycle-focus-change", update_slider_visuals);
  document.addEventListener("pf-plot-complete", update_slider_visuals);

  update_slider_visuals();
}
