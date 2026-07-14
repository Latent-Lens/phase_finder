// Manual stage orchestrator for the Dean-Jett-Fox pipeline. Each entry point
// runs exactly one stage, stores diagnostics, invalidates downstream products,
// and leaves optional missing-channel stages as null masks.

import { plottable_rows } from "../../plotting/data.js";
import * as stage0 from "./stage0_structural.js";
import * as stage1 from "./stage1_time_qc.js";
import * as stage2 from "./stage2_scatter_gate.js";
import * as stage3 from "./stage3_singlet_gate.js";
import * as stage4 from "./stage4_histogram.js";
import * as stage5 from "./stage5_peaks.js";
import * as stage6 from "./stage6_fit.js";
import * as stage7 from "./stage7_extend.js";
import * as stage8 from "./stage8_report.js";
import {
  pipeline_states,
  get_state,
  get_or_create_state,
  clear_state,
  combined_mask_before,
  set_stage_mask,
  invalidate_after,
  recompute_final_mask,
  build_filtered_view,
} from "./pipeline_state.js";

export { stage0, stage1, stage2, stage3, stage4, stage5, stage6, stage7, stage8 };
export {
  pipeline_states,
  get_state,
  get_or_create_state,
  clear_state,
  recompute_final_mask,
};

function require_row_data(row) {
  if (!row || !row.data || !row.data.channels?.DNA_A) {
    throw new Error("Load and plot a DNA-area channel before running the DJF pipeline.");
  }
  return row.data;
}

function stage_result(stage_number, row, result, state) {
  return {
    stage: stage_number,
    name: row.name,
    channel: row.data.channel_key,
    result,
    state,
  };
}

function clone_scatter_component(component) {
  if (!component) return null;
  return {
    ...component,
    mean: Array.from(component.mean ?? []),
    covariance: Array.from(
      component.covariance ?? [],
      row => Array.from(row ?? []),
    ),
  };
}

function validate_scatter_gate_center(mean) {
  if (
    !mean ||
    mean.length !== 2 ||
    !Number.isFinite(mean[0]) ||
    !Number.isFinite(mean[1])
  ) {
    throw new RangeError("The Stage 2 gate center must contain finite FSC-A and SSC-A values.");
  }
  return [Number(mean[0]), Number(mean[1])];
}

function validate_scatter_gate_coverage(coverage) {
  const value = Number(coverage);
  if (!Number.isFinite(value) || !(value > 0) || !(value < 1)) {
    throw new RangeError("The Stage 2 gate coverage must be greater than 0 and less than 1.");
  }
  return value;
}

// For two dimensions, squared Mahalanobis distance follows chi-square(2),
// whose inverse CDF has this closed form.
function scatter_threshold_for_coverage(coverage) {
  return -2 * Math.log1p(-validate_scatter_gate_coverage(coverage));
}

function count_retained(mask) {
  let count = 0;
  for (const retained of mask ?? []) count += retained ? 1 : 0;
  return count;
}

export function run_stage0(row, options = {}) {
  const data = require_row_data(row);
  const state = get_or_create_state(row);
  const result = stage0.runStructuralQC(data, options.pnr);
  state.structuralQC = result;
  state.structuralMask = result.structuralMask;
  set_stage_mask(row, 0, result.structuralMask);
  invalidate_after(row, state, 0);
  return stage_result(0, row, result, state);
}

export function run_stage1(row, options = {}) {
  const data = require_row_data(row);
  const state = get_or_create_state(row);
  const structuralMask = data.masks?.structural ?? null;
  const result = stage1.runTimeQC(data, structuralMask, options);
  state.timeQC = result;
  set_stage_mask(row, 1, result.skipped ? null : result.timeQCMask);
  invalidate_after(row, state, 1);
  return stage_result(1, row, result, state);
}

export function run_stage2(row, options = {}) {
  const data = require_row_data(row);
  const state = get_or_create_state(row);
  const result = stage2.gateMainBiologicalCloud(
    data,
    data.masks?.structural ?? null,
    data.masks?.timeQC ?? null,
    options,
  );
  if (!result.skipped && result.mainComponent) {
    result.fittedMainComponent = clone_scatter_component(result.mainComponent);
    result.fittedThreshold = result.threshold;
    result.manualOverride = null;
    result.gateSource = "fitted";
  }
  state.scatterGate = result;
  set_stage_mask(row, 2, result.skipped ? null : result.scatterMask);
  invalidate_after(row, state, 2);
  return stage_result(2, row, result, state);
}

/**
 * Translate or resize Stage 2's fitted ellipse and make it authoritative.
 *
 * Translation changes the FSC-A/SSC-A center. Coverage changes the squared
 * Mahalanobis threshold while retaining the fitted covariance, so both axes
 * scale together without changing their ratio or rotation. The raw-index mask
 * is recomputed from the original scatter points, then Stage 3 and every
 * downstream product are invalidated.
 */
export function update_stage2_gate(
  row,
  { mean = null, coverage = null, reset = false } = {},
) {
  const data = require_row_data(row);
  const state = get_or_create_state(row);
  const result = state.scatterGate;
  if (!result || result.skipped || !result.mainComponent) {
    throw new Error("Run DJF Stage 2 before editing its scatter gate.");
  }

  const fittedComponent = clone_scatter_component(
    result.fittedMainComponent ?? result.mainComponent,
  );
  const currentComponent = clone_scatter_component(result.mainComponent);
  const center = reset
    ? validate_scatter_gate_center(fittedComponent.mean)
    : mean == null
      ? validate_scatter_gate_center(currentComponent.mean)
      : validate_scatter_gate_center(mean);
  const fittedThreshold = Number(result.fittedThreshold ?? result.threshold);
  const threshold = reset
    ? fittedThreshold
    : coverage == null
      ? Number(result.threshold)
      : scatter_threshold_for_coverage(coverage);
  const nextComponent = {
    ...(reset ? fittedComponent : currentComponent),
    mean: center,
  };
  const { mask, mahalanobisDistanceSquared } = stage2.createScatterGateMask(
    data.eventCount,
    result.scatterPoints,
    nextComponent,
    threshold,
  );

  const components = [...result.components];
  if (
    Number.isInteger(result.mainComponentIndex) &&
    result.mainComponentIndex >= 0 &&
    result.mainComponentIndex < components.length
  ) {
    components[result.mainComponentIndex] = nextComponent;
  }
  const updatedResult = {
    ...result,
    components,
    mainComponent: nextComponent,
    fittedMainComponent: fittedComponent,
    fittedThreshold,
    threshold,
    scatterMask: mask,
    mask,
    mahalanobisDistanceSquared,
    retainedEventCount: count_retained(mask),
    manualOverride: reset
      ? null
      : {
          mean: [...center],
          threshold,
          coverage: 1 - Math.exp(-threshold / 2),
        },
    gateSource: reset ? "fitted" : "manual",
  };

  state.scatterGate = updatedResult;
  set_stage_mask(row, 2, mask);
  invalidate_after(row, state, 2);
  return stage_result(2, row, updatedResult, state);
}

export function run_stage3(row, options = {}) {
  const data = require_row_data(row);
  const state = get_or_create_state(row);
  const inputMask = combined_mask_before(row, 3);
  const result = stage3.gateByPulseGeometry(data, inputMask, options);
  state.singletResult = result;
  // The source returns a copied input mask when geometry is unavailable. The
  // pipeline stores null for a skipped optional gate so mask provenance stays
  // explicit; recomputing final still preserves all prior masks.
  set_stage_mask(row, 3, result.skipped ? null : result.singletMask);
  invalidate_after(row, state, 3);
  return stage_result(3, row, result, state);
}

export function run_stage4(row, options = {}) {
  const data = require_row_data(row);
  const state = get_or_create_state(row);
  recompute_final_mask(row);
  // Bin the gated view directly: prior filters have already deleted their events
  // from it, so no mask is applied here (identical to masking the originals).
  const filtered = build_filtered_view(row);
  const result = stage4.generateHistogram(filtered.channels.DNA_A, null, options);
  state.histogram = result;
  invalidate_after(row, state, 4);
  return stage_result(4, row, result, state);
}

function require_histogram(state, target_stage) {
  if (!state.histogram) {
    throw new Error(`Run DJF Stage 4 before Stage ${target_stage}.`);
  }
  return state.histogram;
}

export function run_stage5(row, options = {}) {
  require_row_data(row);
  const state = get_or_create_state(row);
  const histogram = require_histogram(state, 5);
  const result = stage5.detectDNAContentPeaks(histogram.y, {
    histogramMin: histogram.min,
    binWidth: histogram.binWidth,
    ...options,
  });
  state.peaks = result;
  invalidate_after(row, state, 5);
  return stage_result(5, row, result, state);
}

export function run_stage6(row, options = {}) {
  require_row_data(row);
  const state = get_or_create_state(row);
  const histogram = require_histogram(state, 6);
  const result = stage6.fitCellCycleHistogram(histogram.x, histogram.y, options);
  state.baseFit = result;
  invalidate_after(row, state, 6);
  return stage_result(6, row, result, state);
}

export function run_stage7(row, options = {}) {
  require_row_data(row);
  const state = get_or_create_state(row);
  const histogram = require_histogram(state, 7);
  if (!state.baseFit) throw new Error("Run DJF Stage 6 before Stage 7.");
  const result = stage7.extendCellCycleFit(
    histogram.x,
    histogram.y,
    state.baseFit,
    options,
  );
  state.extendedFit = result;
  invalidate_after(row, state, 7);
  return stage_result(7, row, result, state);
}

export function run_stage8(row, options = {}) {
  require_row_data(row);
  const state = get_or_create_state(row);
  const fit = state.extendedFit || state.baseFit;
  if (!fit) throw new Error("Run DJF Stage 6 (and optionally Stage 7) before Stage 8.");

  const channelNames = options.channelNames ?? [
    ...(row.summary?.columns || []),
    ...Object.values(row.data.parameterMetadata || {}).flatMap((metadata) =>
      metadata ? [metadata.name, metadata.stain] : []
    ),
  ].filter(Boolean);
  const pulseGeometryAvailable = typeof options.pulseGeometryAvailable === "boolean"
    ? options.pulseGeometryAvailable
    : state.singletResult?.geometryMode != null;
  const report = stage8.summarizeCellCycleFit(fit, {
    ...options,
    channelNames,
    pulseGeometryAvailable,
  });
  const result = {
    ...report,
    displaySummary: stage8.createDisplaySummary(report),
    background: {
      implemented: false,
      reason: "General background model has not yet been specified.",
    },
  };
  state.report = result;
  invalidate_after(row, state, 8);
  return stage_result(8, row, result, state);
}

const STAGE_RUNNERS = [
  run_stage0,
  run_stage1,
  run_stage2,
  run_stage3,
  run_stage4,
  run_stage5,
  run_stage6,
  run_stage7,
  run_stage8,
];

export function run_stage(stage_number, row, options = {}) {
  const runner = STAGE_RUNNERS[stage_number];
  if (!runner) throw new Error(`DJF Stage ${stage_number} is not available.`);
  return runner(row, options);
}

function target_rows(rows) {
  return rows == null ? plottable_rows() : Array.from(rows);
}

export function shared_histogram_range(rows) {
  const targets = target_rows(rows);
  let minimum = Infinity;
  let maximum = -Infinity;
  let retainedCount = 0;

  for (const row of targets) {
    const data = require_row_data(row);
    const mask = recompute_final_mask(row);
    for (let eventIndex = 0; eventIndex < data.channels.DNA_A.length; eventIndex += 1) {
      if (!mask[eventIndex]) continue;
      const value = data.channels.DNA_A[eventIndex];
      if (!Number.isFinite(value)) continue;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
      retainedCount += 1;
    }
  }

  if (!retainedCount) {
    throw new Error("No finite retained DNA events are available for Stage 4.");
  }
  if (!(maximum > minimum)) {
    const span = Math.max(Math.abs(minimum) * 1e-6, 1);
    minimum -= span / 2;
    maximum += span / 2;
  }
  return [minimum, maximum];
}

export function run_stage_all(stage_number, rows = null, options = {}) {
  const targets = target_rows(rows);
  const stageOptions = stage_number === 4 && options.range == null
    ? { ...options, range: shared_histogram_range(targets) }
    : options;
  return targets.map((row) => run_stage(stage_number, row, stageOptions));
}

export const run_stage0_all = (rows = null, options = {}) => run_stage_all(0, rows, options);
export const run_stage1_all = (rows = null, options = {}) => run_stage_all(1, rows, options);
export const run_stage2_all = (rows = null, options = {}) => run_stage_all(2, rows, options);
export const run_stage3_all = (rows = null, options = {}) => run_stage_all(3, rows, options);
export const run_stage4_all = (rows = null, options = {}) => run_stage_all(4, rows, options);
export const run_stage5_all = (rows = null, options = {}) => run_stage_all(5, rows, options);
export const run_stage6_all = (rows = null, options = {}) => run_stage_all(6, rows, options);
export const run_stage7_all = (rows = null, options = {}) => run_stage_all(7, rows, options);
export const run_stage8_all = (rows = null, options = {}) => run_stage_all(8, rows, options);

export function run_all(row, options_by_stage = {}) {
  return STAGE_RUNNERS.map((runner, stage_number) =>
    runner(row, options_by_stage[stage_number] || {})
  );
}

/**
 * Clear all four QC gate masks and the pipeline state for a sample, so the
 * Pre-model QC checkboxes can re-apply only the currently checked gates from a
 * clean slate. The gated view and final mask are recomputed to "all pass".
 */
export function reset_qc_gates(row) {
  clear_state(row?.name);
  if (row && row.data && row.data.masks) {
    for (const name of ["structural", "timeQC", "scatter", "singlet"]) {
      row.data.masks[name] = null;
    }
    recompute_final_mask(row);
    build_filtered_view(row);
  }
}

const FILTER_STAGES = [
  { key: "structural", label: "Structural" },
  { key: "timeQC", label: "Time QC" },
  { key: "scatter", label: "Scatter" },
  { key: "singlet", label: "Singlet" },
];

/**
 * Per-filter event funnel: how many events each mask removed relative to the
 * events that entered that stage. Derived from the composed masks rather than
 * each stage's own counts, so it stays correct regardless of per-stage mask
 * semantics and reports a null-mask (skipped/optional) stage as removing nothing.
 *
 * Needs no report, so each filter's loss can be written to the table as soon as
 * that stage runs. Returns null when the sample has no loaded data.
 */
export function pipeline_filter_funnel(row) {
  if (!row?.data) return null;

  const eventCount = row.data.eventCount ?? 0;
  const masks = row.data.masks || {};
  const alive = new Uint8Array(eventCount).fill(1);
  let entered = eventCount;
  const filters = [];

  for (const { key, label } of FILTER_STAGES) {
    const mask = masks[key];
    if (!mask) {
      filters.push({ key, label, entered, lost: 0, skipped: true });
      continue;
    }
    let keptAfter = 0;
    for (let index = 0; index < eventCount; index += 1) {
      if (alive[index] && !mask[index]) alive[index] = 0;
      if (alive[index]) keptAfter += 1;
    }
    filters.push({ key, label, entered, lost: entered - keptAfter, skipped: false });
    entered = keptAfter;
  }

  return { name: row.name, eventCount, filters };
}

/**
 * Full metadata-table summary: the per-filter funnel plus the G1/S/G2-M cell
 * cycle percentages. Returns null until the sample has a Stage 8 report, so the
 * cell-cycle columns only populate for samples that completed the pipeline.
 */
export function pipeline_table_stats(row) {
  const state = get_state(row?.name);
  if (!state || !state.report) return null;
  const funnel = pipeline_filter_funnel(row);
  if (!funnel) return null;

  const bio = state.report.fractions?.biologicalSinglets || {};
  const percent = (fraction) => (Number.isFinite(fraction) ? 100 * fraction : NaN);
  return {
    ...funnel,
    fractions: {
      g1: percent(bio.oneC),
      s: percent(bio.sPhase),
      g2: percent(bio.twoC),
    },
  };
}
