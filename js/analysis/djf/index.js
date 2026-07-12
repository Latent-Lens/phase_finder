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
  state.scatterGate = result;
  set_stage_mask(row, 2, result.skipped ? null : result.scatterMask);
  invalidate_after(row, state, 2);
  return stage_result(2, row, result, state);
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

const FILTER_STAGES = [
  { key: "structural", label: "Structural" },
  { key: "timeQC", label: "Time QC" },
  { key: "scatter", label: "Scatter" },
  { key: "singlet", label: "Singlet" },
];

/**
 * Per-sample metadata-table summary: how many events each mask filter removed
 * (relative to the events that entered that stage) plus the G1/S/G2-M percents.
 *
 * The funnel is derived from the composed masks rather than each stage's own
 * counts, so it stays correct regardless of per-stage mask semantics and reports
 * a null-mask (skipped/optional) stage as removing nothing. Returns null until
 * the sample has a Stage 8 report, so the table only shows completed samples.
 */
export function pipeline_table_stats(row) {
  const state = get_state(row?.name);
  if (!state || !state.report || !row?.data) return null;

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

  const bio = state.report.fractions?.biologicalSinglets || {};
  const percent = (fraction) => (Number.isFinite(fraction) ? 100 * fraction : NaN);
  return {
    name: row.name,
    eventCount,
    filters,
    fractions: {
      g1: percent(bio.oneC),
      s: percent(bio.sPhase),
      g2: percent(bio.twoC),
    },
  };
}
