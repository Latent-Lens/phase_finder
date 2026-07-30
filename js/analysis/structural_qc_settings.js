// Structural QC's saturation-ceiling configuration: whether the PnR ceiling
// check (structural_qc.js's CEILING_CHANNEL_NAMES) runs at all for each DNA
// channel, and an optional value to use instead of the FCS file's own $PnR.
//
// Exists because $PnR is trusted blindly today: whatever channel is picked as
// the DNA-content proxy gets its own file header's $PnR as a hard ceiling, and
// a channel repurposed from its originally-calibrated dye (e.g. a
// fluorescence channel used as a DNA proxy) can carry a stale or simply wrong
// $PnR -- one low enough to reject an entire real G2 population as
// "saturated" when the raw histogram shows a perfectly clean, unclipped peak
// past it. This module is what a "2. Time"-style settings dialog
// (structural_qc_modal.js) edits.
//
// get_structural_qc_state()/set_structural_qc_state()/reset_structural_qc_state()
// read and update the live configuration; resolve_pnr_for_dataset() merges it
// with one dataset's own $PnR values into the full object
// createStructuralValidityMask() expects, without clobbering channels the user
// didn't touch.

// Only the DNA channels take a saturation ceiling at all (see
// structural_qc.js's CEILING_CHANNEL_NAMES) -- FSC-A/SSC-A are deliberately
// exempt there, so there is nothing for this dialog to configure for them.
export const STRUCTURAL_QC_CEILING_CHANNELS = Object.freeze(["DNA_A", "DNA_H", "DNA_W"]);

function default_state() {
  return {
    ceilings: {
      DNA_A: { enabled: true, override: null },
      DNA_H: { enabled: true, override: null },
      DNA_W: { enabled: true, override: null },
    },
  };
}

let state = default_state();

/*

Purpose:
	Reads the current Structural QC saturation-ceiling configuration. Returns a
	copy so a caller can't mutate the live state by holding on to it.

Input:
	(none)

Output:
	state [object]: { ceilings: { DNA_A/DNA_H/DNA_W: { enabled, override } } }

*/
export function get_structural_qc_state() {
  const ceilings = {};
  for (const channel of STRUCTURAL_QC_CEILING_CHANNELS) {
    ceilings[channel] = { ...state.ceilings[channel] };
  }
  return { ceilings };
}

/*

Purpose:
	Merges a patch into the live configuration. Only recognized channels and
	well-formed { enabled, override } entries are applied, so a malformed patch
	can't leave a channel in an inconsistent state.

Input:
	patch [object]: { ceilings: { <channel>: { enabled?, override? } } }

Output:
	state [object]: the updated configuration

*/
export function set_structural_qc_state(patch = {}) {
  if (patch.ceilings) {
    for (const channel of STRUCTURAL_QC_CEILING_CHANNELS) {
      const entry = patch.ceilings[channel];
      if (!entry) continue;
      const current = state.ceilings[channel];
      const enabled = typeof entry.enabled === "boolean" ? entry.enabled : current.enabled;
      const override = entry.override === null || Number.isFinite(entry.override) ? entry.override : current.override;
      state.ceilings[channel] = { enabled, override };
    }
  }
  return get_structural_qc_state();
}

/*

Purpose:
	Restores the shipped defaults (every ceiling enabled, no override) -- used by
	the dialog's "Reset defaults".

Input:
	(none)

Output:
	state [object]: the reset configuration

*/
export function reset_structural_qc_state() {
  state = default_state();
  return get_structural_qc_state();
}

/*

Purpose:
	True when every ceiling channel is at its default (enabled, no override) --
	lets callers skip rebuilding/clearing caches when nothing actually changed.

Input:
	(none)

Output:
	isDefault [boolean]

*/
export function structural_qc_state_is_default() {
  return STRUCTURAL_QC_CEILING_CHANNELS.every((channel) => {
    const entry = state.ceilings[channel];
    return entry.enabled === true && entry.override === null;
  });
}

/*

Purpose:
	Builds the full PnR object to pass as createStructuralValidityMask's
	pnrOverride: one dataset's own $PnR values, with each DNA channel's ceiling
	disabled (set to null, so structural_qc.js's `Number.isFinite(numericLimit)`
	check simply never fires) or replaced with the configured override.
	pnrOverride *replaces* the whole pnr object rather than merging with it (see
	structural_qc.js's resolveStructuralInput), so every channel not being
	overridden must still be carried through from the dataset's own values --
	building a partial object here would silently disable their ceilings too.

Input:
	datasetPnr [object|null]: the dataset's own pnr object (row.data.pnr)

Output:
	pnr [object]: the full pnr object to pass as pnrOverride

*/
export function resolve_pnr_for_dataset(datasetPnr) {
  const merged = { ...(datasetPnr || {}) };
  for (const channel of STRUCTURAL_QC_CEILING_CHANNELS) {
    const setting = state.ceilings[channel];
    if (!setting.enabled) {
      merged[channel] = null;
    } else if (Number.isFinite(setting.override)) {
      merged[channel] = setting.override;
    }
    // else: enabled with no override -- leave the dataset's own value in place.
  }
  return merged;
}

/*

Purpose:
	The reproducibility record for the session file: one enabled flag and one
	optional override per DNA channel, flattened to flat keys (matching
	time_qc_settings.js's session-config shape -- toml_io.js's [section] writer
	only handles flat scalar/array values, not nested objects). An override of
	null is simply omitted, so a channel with no override round-trips as absent
	rather than as a literal null in the file.

Input:
	(none)

Output:
	config [object]: e.g. { dna_a_ceiling_enabled, dna_a_ceiling_override, ... }

*/
export function get_structural_qc_session_config() {
  const config = {};
  for (const channel of STRUCTURAL_QC_CEILING_CHANNELS) {
    const key = channel.toLowerCase();
    const entry = state.ceilings[channel];
    config[`${key}_ceiling_enabled`] = entry.enabled;
    if (Number.isFinite(entry.override)) config[`${key}_ceiling_override`] = entry.override;
  }
  return config;
}

/*

Purpose:
	Restores a saved Structural QC saturation-ceiling configuration from a
	session file, tolerating a file written before this feature existed (or
	missing a key) by falling back to the default for that field.

Input:
	config [object]: the `[structural_qc]` section of a session file

Output:
	state [object]: the restored configuration

*/
export function apply_structural_qc_session_config(config) {
  if (!config) return get_structural_qc_state();
  const patch = { ceilings: {} };
  for (const channel of STRUCTURAL_QC_CEILING_CHANNELS) {
    const key = channel.toLowerCase();
    const enabled = to_boolean(config[`${key}_ceiling_enabled`]);
    const override = to_number(config[`${key}_ceiling_override`]);
    patch.ceilings[channel] = { override: override !== undefined ? override : null };
    if (enabled !== undefined) patch.ceilings[channel].enabled = enabled;
  }
  return set_structural_qc_state(patch);
}

/*

Purpose:
	Coerces a value to a finite number, or undefined when it isn't finite.

Input:
	value [any]: the value to coerce

Output:
	number [number|undefined]: the finite number, or undefined

*/
function to_number(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/*

Purpose:
	Coerces a value to a boolean from true/false or the strings "true"/"false",
	or undefined otherwise.

Input:
	value [any]: the value to coerce

Output:
	boolean [boolean|undefined]: the boolean, or undefined

*/
function to_boolean(value) {
  if (value === true || value === false) return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}
