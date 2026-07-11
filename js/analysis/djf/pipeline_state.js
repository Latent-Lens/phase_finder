// Per-sample state and mask composition for the staged DJF pipeline. State is
// keyed by filename for the public debugging API, while each entry records its
// active channel key so changing DNA channels cannot reuse stale masks or fits.

export const pipeline_states = new Map();

const STATE_FIELDS_BY_STAGE = [
  "structuralMask",
  "timeQC",
  "scatterGate",
  "singletResult",
  "histogram",
  "peaks",
  "baseFit",
  "extendedFit",
  "report",
];

const MASK_FIELDS_BY_STAGE = ["structural", "timeQC", "scatter", "singlet"];

function empty_state(row) {
  return {
    rowId: row && row.id ? row.id : null,
    name: row && row.name ? row.name : "",
    channelKey: row && row.data ? row.data.channel_key : null,
    eventCount: row && row.data ? row.data.eventCount : 0,
    structuralQC: null,
    structuralMask: null,
    timeQC: null,
    scatterGate: null,
    singletResult: null,
    histogram: null,
    peaks: null,
    baseFit: null,
    extendedFit: null,
    report: null,
    lastStageRun: null,
  };
}

export function get_state(name) {
  return pipeline_states.get(name) || null;
}

export function get_or_create_state(row) {
  if (!row || !row.name || !row.data) {
    throw new Error("A loaded sample with row.data is required.");
  }

  const previous = pipeline_states.get(row.name);
  const channel_changed = previous && previous.channelKey !== row.data.channel_key;
  const event_count_changed = previous && previous.eventCount !== row.data.eventCount;
  const row_changed = previous && previous.rowId && row.id && previous.rowId !== row.id;

  if (!previous || channel_changed || event_count_changed || row_changed) {
    const state = empty_state(row);
    pipeline_states.set(row.name, state);
    return state;
  }
  return previous;
}

export function clear_state(name) {
  if (name == null) {
    pipeline_states.clear();
    return;
  }
  pipeline_states.delete(name);
}

export function combine_masks(...input_masks) {
  const masks = input_masks.flat().filter((mask) => mask != null);
  if (!masks.length) return null;

  const length = masks[0].length;
  if (!Number.isInteger(length)) throw new Error("Pipeline masks must be array-like.");
  const combined = new Uint8Array(length);
  combined.fill(1);

  for (const mask of masks) {
    if (mask.length !== length) {
      throw new Error(`Pipeline mask length mismatch: expected ${length}, received ${mask.length}.`);
    }
    for (let index = 0; index < length; index += 1) {
      if (!mask[index]) combined[index] = 0;
    }
  }
  return combined;
}

export function all_pass_mask(event_count) {
  const count = Number(event_count);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`Invalid event count for mask: ${event_count}`);
  }
  const mask = new Uint8Array(count);
  mask.fill(1);
  return mask;
}

export function combined_mask_before(row, stage_number) {
  const masks = row && row.data && row.data.masks ? row.data.masks : {};
  const count = row && row.data ? row.data.eventCount : 0;
  const relevant = MASK_FIELDS_BY_STAGE
    .slice(0, Math.max(0, Math.min(MASK_FIELDS_BY_STAGE.length, stage_number)))
    .map((name) => masks[name])
    .filter(Boolean);
  return combine_masks(relevant) || all_pass_mask(count);
}

export function recompute_final_mask(row) {
  if (!row || !row.data) throw new Error("A loaded sample with row.data is required.");
  if (!row.data.masks) row.data.masks = {};
  const masks = MASK_FIELDS_BY_STAGE.map((name) => row.data.masks[name]).filter(Boolean);
  row.data.masks.final = combine_masks(masks) || all_pass_mask(row.data.eventCount);
  return row.data.masks.final;
}

export function set_stage_mask(row, stage_number, mask) {
  if (!Number.isInteger(stage_number) || stage_number < 0 || stage_number > 3) {
    throw new Error(`Stage ${stage_number} does not own an event mask.`);
  }
  if (!row || !row.data) throw new Error("A loaded sample with row.data is required.");
  if (!row.data.masks) row.data.masks = {};
  if (mask != null && mask.length !== row.data.eventCount) {
    throw new Error(
      `Stage ${stage_number} mask length mismatch: expected ${row.data.eventCount}, received ${mask.length}.`,
    );
  }
  row.data.masks[MASK_FIELDS_BY_STAGE[stage_number]] = mask;
  return recompute_final_mask(row);
}

export function invalidate_after(row, state, completed_stage) {
  if (!state) state = get_or_create_state(row);
  for (let stage = completed_stage + 1; stage < STATE_FIELDS_BY_STAGE.length; stage += 1) {
    state[STATE_FIELDS_BY_STAGE[stage]] = null;
  }

  if (row && row.data && row.data.masks) {
    for (let stage = completed_stage + 1; stage < MASK_FIELDS_BY_STAGE.length; stage += 1) {
      row.data.masks[MASK_FIELDS_BY_STAGE[stage]] = null;
    }
    recompute_final_mask(row);
  }
  state.lastStageRun = completed_stage;
  return state;
}
