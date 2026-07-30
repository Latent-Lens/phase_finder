// The Structural QC settings dialog: opened every time Structural QC is
// switched on (pipeline_ui.js's init_premodel_qc), and reachable afterwards
// from the "Change…" link under the QC buttons -- the same two-way pattern as
// Time QC's own dialog (time_qc_modal.js).
//
// Lets the user, per DNA channel (DNA-A/H/W): disable the saturation-ceiling
// check entirely, or replace the file's own $PnR with a custom value. The
// custom-ceiling field is preloaded with the channel's own recorded $PnR
// (from the caller's referenceInfo) whenever there's no override saved yet, so
// the user edits a real number instead of starting from a blank field. See
// structural_qc_settings.js for why this exists -- a channel repurposed as the
// DNA-content proxy can carry a stale $PnR that silently deletes a real
// population (typically G2/M) as if it had saturated the detector.
//
// The dialog only edits configuration. Running the QC filter is the caller's
// job: Apply resolves the open() promise with the committed settings, Cancel
// resolves with null.
//
// open_structural_qc_modal() opens the dialog (optionally with reference $PnR
// values/labels for the currently-focused sample, purely informational) and
// resolves with the chosen settings (or null); init_structural_qc_modal()
// wires listeners once.

import {
  STRUCTURAL_QC_CEILING_CHANNELS,
  get_structural_qc_state,
  set_structural_qc_state,
  reset_structural_qc_state,
} from "./structural_qc_settings.js";

const CHANNEL_LABELS = { DNA_A: "DNA-A", DNA_H: "DNA-H", DNA_W: "DNA-W" };

const modal = document.querySelector("#structural_qc_modal");
const rows_container = document.querySelector("#structural_qc_ceiling_rows");
const note = document.querySelector("#structural_qc_note");
const apply_button = document.querySelector("#structural_qc_apply");

let initialized = false;
let resolve_open = null;
let reference_info = null;

/*

Purpose:
	Builds the one-line reference caption for a channel: the underlying FCS
	parameter label and its recorded $PnR, when reference info was supplied to
	open_structural_qc_modal().

Input:
	channel [string]: "DNA_A", "DNA_H", or "DNA_W"

Output:
	caption [string]: e.g. "Recorded as GFP/FITC-A, ceiling 1023", or a fallback
	                  when no reference sample is available

*/
function reference_caption(channel) {
  const info = reference_info?.[channel];
  if (!info) return "No plotted sample to read a recorded ceiling from.";
  const label = info.label ? `Recorded as ${info.label}` : "Channel not loaded for this sample";
  const ceiling = Number.isFinite(info.pnr) ? `, ceiling ${info.pnr}` : ", no $PnR recorded";
  return `${label}${info.label ? ceiling : ""}.`;
}

/*

Purpose:
	Rebuilds the three per-channel ceiling rows (enabled checkbox + optional
	override input + reference caption) from the current state.

Input:
	state [object]: a structural_qc_settings.js state object

Output:
	(none) [void]: replaces the row list in the DOM

*/
function render_rows(state) {
  if (!rows_container) return;
  rows_container.innerHTML = "";
  for (const channel of STRUCTURAL_QC_CEILING_CHANNELS) {
    const setting = state.ceilings[channel];
    const row = document.createElement("div");
    row.className = "structural_qc_ceiling_row";
    row.dataset.channel = channel;

    const enabled_label = document.createElement("label");
    enabled_label.className = "time_qc_checkbox";
    const enabled_input = document.createElement("input");
    enabled_input.type = "checkbox";
    enabled_input.className = "structural_qc_ceiling_enabled";
    enabled_input.checked = setting.enabled;
    const enabled_text = document.createElement("span");
    enabled_text.textContent = `${CHANNEL_LABELS[channel]} ceiling enabled`;
    enabled_label.append(enabled_input, enabled_text);

    const reference = document.createElement("span");
    reference.className = "structural_qc_ceiling_reference";
    reference.textContent = reference_caption(channel);

    const override_label = document.createElement("label");
    override_label.className = "time_qc_field structural_qc_override_field";
    const override_span = document.createElement("span");
    override_span.textContent = "Custom ceiling (optional)";
    const override_input = document.createElement("input");
    override_input.type = "number";
    override_input.step = "any";
    override_input.className = "structural_qc_ceiling_override";
    override_input.placeholder = "use recorded value";
    // Preload the field with the channel's own recorded $PnR when there's no
    // saved override yet, so the user starts from and edits a real number
    // instead of a blank box -- an explicit override always wins over this.
    const recorded_pnr = reference_info?.[channel]?.pnr;
    if (Number.isFinite(setting.override)) override_input.value = setting.override;
    else if (Number.isFinite(recorded_pnr)) override_input.value = recorded_pnr;
    override_input.disabled = !setting.enabled;
    override_label.append(override_span, override_input);

    enabled_input.addEventListener("change", () => {
      override_input.disabled = !enabled_input.checked;
    });

    row.append(enabled_label, reference, override_label);
    rows_container.append(row);
  }
}

/*

Purpose:
	Reads the form back into a structural_qc_settings.js-shaped patch.

Input:
	(none)

Output:
	patch [object]: { ceilings: { <channel>: { enabled, override } } }

*/
function read_form() {
  const ceilings = {};
  for (const channel of STRUCTURAL_QC_CEILING_CHANNELS) {
    const row = rows_container?.querySelector(`.structural_qc_ceiling_row[data-channel="${channel}"]`);
    const enabled = row?.querySelector(".structural_qc_ceiling_enabled")?.checked ?? true;
    const raw = row?.querySelector(".structural_qc_ceiling_override")?.value ?? "";
    const override = raw === "" ? null : Number(raw);
    ceilings[channel] = { enabled, override: Number.isFinite(override) ? override : null };
  }
  return { ceilings };
}

/*

Purpose:
	Hides the dialog and resolves the pending open() promise with the given result.

Input:
	result [object|null]: the value to resolve with (committed state, or null)

Output:
	(none) [void]

*/
function close(result) {
  if (modal) modal.hidden = true;
  const resolve = resolve_open;
  resolve_open = null;
  resolve?.(result);
}

/*

Purpose:
	Wires the dialog's listeners (backdrop/close/cancel/reset/apply buttons,
	keyboard) once.

Input:
	(none)

Output:
	(none) [void]

*/
function init() {
  if (initialized || !modal) return;
  initialized = true;

  modal.querySelector(".stats_modal_backdrop")?.addEventListener("click", () => close(null));
  document.querySelector("#structural_qc_close")?.addEventListener("click", () => close(null));
  document.querySelector("#structural_qc_cancel")?.addEventListener("click", () => close(null));
  document.querySelector("#structural_qc_reset")?.addEventListener("click", () => {
    render_rows(reset_structural_qc_state());
  });
  apply_button?.addEventListener("click", () => close(set_structural_qc_state(read_form())));
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close(null);
    else if (event.key === "Enter" && event.target.tagName !== "BUTTON") close(set_structural_qc_state(read_form()));
  });
}

/*

Purpose:
	Opens the Structural QC settings dialog, prefilled from the current
	configuration, and resolves once the user applies or dismisses it.

Input:
	options [object]: { applyLabel, referenceInfo } -- applyLabel is the confirm
	                  button's text; referenceInfo is an optional
	                  { DNA_A/DNA_H/DNA_W: { pnr, label } } read from the
	                  currently-focused sample, shown purely for reference

Output:
	settings [Promise<object|null>]: the committed configuration, or null if the
	                                 user cancelled

*/
export function open_structural_qc_modal({ applyLabel = "Run Structural QC", referenceInfo = null } = {}) {
  init();
  if (!modal) return Promise.resolve(null);
  // A second open while one is pending would strand the first promise.
  if (resolve_open) close(null);

  reference_info = referenceInfo;
  render_rows(get_structural_qc_state());
  if (note) {
    note.textContent = "Disabling a ceiling, or setting a custom one, applies to every loaded file -- $PnR is only ever read per file for the file's own recorded value, never edited on disk.";
  }
  if (apply_button) apply_button.textContent = applyLabel;
  modal.hidden = false;
  rows_container?.querySelector("input")?.focus();

  return new Promise((resolve) => {
    resolve_open = resolve;
  });
}

/*

Purpose:
	Exposed so the entry bootstrap can wire the dialog's listeners once at startup.

Input:
	(none)

Output:
	(none) [void]

*/
export function init_structural_qc_modal() {
  init();
}
