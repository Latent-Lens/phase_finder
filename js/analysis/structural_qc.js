// Structural validity mask used at the start of the cell-cycle QC pipeline.

export const BOUNDED_CHANNEL_NAMES = Object.freeze([
  "DNA_A",
  "DNA_H",
  "DNA_W",
  "FSC_A",
  "SSC_A",
]);

// The PnR ("upper margin"/saturation) ceiling is applied only to the DNA
// channels. A maxed-out DNA reading corrupts the cell-cycle content the whole
// pipeline measures, so those events must go. Forward/side scatter, by
// contrast, saturate heavily on real instruments (side scatter especially) and
// scale with cell size -- G2/M cells are the largest, so a scatter-saturation
// ceiling here would preferentially delete the entire G2 population before
// modeling ever runs. Scatter-based removal belongs to the interactive Stage 2
// Cell Gate (GMM on FSC/SSC), not this blunt pre-filter, so FSC_A/SSC_A are
// checked only for non-finite/negative values below, never the ceiling.
const CEILING_CHANNEL_NAMES = Object.freeze(["DNA_A", "DNA_H", "DNA_W"]);

function resolveStructuralInput(datasetOrChannels, pnrOverride) {
  const isDataset = Boolean(datasetOrChannels?.channels);
  const channels = isDataset
    ? datasetOrChannels.channels
    : datasetOrChannels;
  const pnr = pnrOverride ?? (isDataset ? datasetOrChannels.pnr : null) ?? {};

  if (!channels || typeof channels !== "object") {
    throw new Error("Stage 0 requires a channels object.");
  }

  const loadedChannels = [
    ...BOUNDED_CHANNEL_NAMES.map(name => channels[name]),
    channels.Time,
  ].filter(channel => channel != null);

  const eventCount = isDataset && Number.isInteger(datasetOrChannels.eventCount)
    ? datasetOrChannels.eventCount
    : loadedChannels[0]?.length ?? 0;

  if (loadedChannels.length === 0) {
    throw new Error("Stage 0 requires at least one loaded channel.");
  }

  for (const channel of loadedChannels) {
    if (channel.length !== eventCount) {
      throw new Error("Loaded channel lengths do not match the event count.");
    }
  }

  return { channels, pnr, eventCount };
}

/**
 * Create the raw, original-event-index structural validity mask.
 *
 * The preferred input is the full `row.data` object.  Passing
 * `(row.data.channels, row.data.pnr)` is also supported so this function stays
 * useful in focused unit tests.
 */
export function createStructuralValidityMask(datasetOrChannels, pnrOverride) {
  const { channels, pnr, eventCount } = resolveStructuralInput(
    datasetOrChannels,
    pnrOverride,
  );
  const mask = new Uint8Array(eventCount);

  for (let eventIndex = 0; eventIndex < eventCount; eventIndex++) {
    let retained = true;

    for (const channelName of BOUNDED_CHANNEL_NAMES) {
      const channel = channels[channelName];
      if (channel == null) continue;

      const value = channel[eventIndex];
      if (!Number.isFinite(value) || value < 0) {
        retained = false;
        break;
      }

      // Diverges from the source document by user decision: zero is valid.
      // The saturation ceiling is DNA-only (see CEILING_CHANNEL_NAMES) --
      // scatter channels are checked for finiteness/negativity above but not
      // for the upper margin.
      if (CEILING_CHANNEL_NAMES.includes(channelName)) {
        const configuredLimit = pnr[channelName];
        const numericLimit = configuredLimit == null || configuredLimit === ""
          ? NaN
          : Number(configuredLimit);
        if (Number.isFinite(numericLimit) && value >= numericLimit) {
          retained = false;
          break;
        }
      }
    }

    if (retained && channels.Time != null) {
      const time = channels.Time[eventIndex];

      // Time has deliberately no Stage-0 PnR upper bound.  Timer wrapping and
      // acquisition discontinuities are handled by Stage 1.
      if (!Number.isFinite(time) || time < 0) retained = false;
    }

    mask[eventIndex] = retained ? 1 : 0;
  }

  return mask;
}

/** Diagnostic wrapper used by the orchestrator/UI. */
export function runStructuralQC(datasetOrChannels, pnrOverride) {
  const mask = createStructuralValidityMask(datasetOrChannels, pnrOverride);
  let retainedEventCount = 0;
  for (const value of mask) retainedEventCount += value;

  return {
    mask,
    structuralMask: mask,
    eventCount: mask.length,
    retainedEventCount,
    rejectedEventCount: mask.length - retainedEventCount,
    skipped: false,
  };
}
