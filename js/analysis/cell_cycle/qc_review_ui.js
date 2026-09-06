// QC-01: the acknowledgement flow for critical QC event loss.
//
// The result contract has always refused to report a fit when any QC stage
// removed more than half the events without an acknowledgement
// (result_contract.js, RESULT_REASON.QC_CRITICAL_REMOVAL). Until this module
// existed nothing anywhere wrote `qcAcknowledgements`, so that refusal was a
// dead end rather than a safeguard: the user hit an error they had no way to
// resolve except by turning the QC stage off, which is exactly the wrong
// response.
//
// This renders the inline review panel in the "Model & Fit" sidebar section,
// shows what each blocking stage removed, and records a deliberate
// acknowledgement bound to that specific outcome. The binding is the point --
// see qc_acknowledgement_key() in result_contract.js.

import { get_state } from "../pipeline/pipeline_state.js";
import { model_preflight, qc_acknowledgement_key, RESULT_REASON } from "./result_contract.js";
import { escape_html } from "../../util/html.js";

// Sidebar review panel (index.html). Queried once at module load, like the rest
// of the sidebar's DOM refs -- the markup is parsed before these deferred module
// scripts run.
const qc_critical_review = document.querySelector("#qc_critical_review");
const qc_critical_review_list = document.querySelector("#qc_critical_review_list");
const qc_critical_review_acknowledge = document.querySelector("#qc_critical_review_acknowledge");
const qc_critical_review_status = document.querySelector("#qc_critical_review_status");

const QC_STAGE_LABELS = {
  structural: "Structural QC",
  time: "Time QC",
  scatter: "Cell gate",
  singlet: "Singlet gate",
};

/*

Purpose:
	QC-01 step 1: reads the preflight bundle for a sample and returns the
	critical-removal blocks the user has to review, each with the identity that
	an acknowledgement of it must carry.

	Deliberately re-runs model_preflight() rather than reading a cached
	`lastFitError`: the error only records the FIRST blocking reason, and a
	sample can trip critical removal on more than one stage at once. Asking the
	contract directly is also the only way to be sure the panel agrees with what
	the fit will actually accept -- a second, parallel notion of "is this
	blocked?" is precisely the class of bug QC-02 was.

Input:
	state [object]: the pipeline state for one sample (get_state(row.name))

Output:
	blocks [array]: [{ stage, label, percentRemoved, key, stale }], empty when
	                nothing is blocked on critical removal

*/
export function pending_qc_acknowledgements(state) {
  if (!state) return [];
  let preflight;
  try {
    preflight = model_preflight(state, {
      qcWaivers: state.qcWaivers ?? {},
      qcAcknowledgements: state.qcAcknowledgements ?? {},
    });
  } catch (_) {
    // A malformed state is not this panel's problem to report; the fit path
    // surfaces it. Showing nothing here is correct -- an acknowledgement
    // button over an unreadable state would authorize something unknown.
    return [];
  }
  return (preflight.reasons ?? [])
    .filter((reason) => reason.code === RESULT_REASON.QC_CRITICAL_REMOVAL)
    .map((reason) => ({
      stage: reason.detail?.name ?? null,
      label: QC_STAGE_LABELS[reason.detail?.name] ?? reason.detail?.name ?? "QC",
      percentRemoved: reason.detail?.percentRemoved ?? null,
      key: reason.detail?.acknowledgementKey ?? null,
      stale: reason.detail?.staleAcknowledgement === true,
      message: reason.message ?? "",
    }))
    .filter((block) => block.stage);
}

/*

Purpose:
	QC-01 step 3: records the user's review of every currently-blocking critical
	removal on one sample.

	Each record carries the outcome key that earned it, so it authorizes THIS
	removal and nothing else. Re-running QC with different options, or
	reconnecting a different file to the row, produces a different key and the
	record silently stops applying -- the sample blocks again and the panel
	reappears. That is step 4 of the checklist's flow, and it is enforced by
	construction rather than by anyone remembering to clear the record.

	Returns the stages it acknowledged so the caller can report precisely what
	was authorized rather than a generic success message.

Input:
	state [object]: the pipeline state for one sample
	now [Date]: injectable clock, so the test does not depend on wall time

Output:
	acknowledged [array]: the stage names that were recorded

*/
export function acknowledge_qc_critical_removal(state, now = new Date()) {
  if (!state) return [];
  const blocks = pending_qc_acknowledgements(state);
  if (!blocks.length) return [];
  state.qcAcknowledgements ??= {};
  const acknowledged = [];
  for (const block of blocks) {
    if (!block.key) continue;   // no identifiable outcome: refuse rather than authorize a blank
    state.qcAcknowledgements[block.stage] = {
      key: block.key,
      acknowledgedAt: now.toISOString(),
      removedFraction: Number.isFinite(block.percentRemoved) ? block.percentRemoved / 100 : null,
    };
    acknowledged.push(block.stage);
  }
  return acknowledged;
}

/*

Purpose:
	QC-01: drops any stored acknowledgement that no longer names the current
	stage outcome.

	Strictly speaking this is unnecessary -- a stale record cannot authorize
	anything, because the contract compares keys. It exists so the persisted
	session and the UI do not accumulate records that look like standing
	approvals to a human reading the file. Correctness comes from the key check;
	this is hygiene.

Input:
	state [object]: the pipeline state for one sample

Output:
	dropped [array]: the stage names whose stale records were removed

*/
export function prune_stale_qc_acknowledgements(state) {
  const stored = state?.qcAcknowledgements;
  if (!stored) return [];
  const products = {
    structural: state.structuralQC ?? null,
    time: state.timeQC ?? null,
    scatter: state.scatterGate ?? null,
    singlet: state.singletResult ?? null,
  };
  const dropped = [];
  for (const stage of Object.keys(stored)) {
    const key = qc_acknowledgement_key(stage, products[stage]);
    if (!key || stored[stage]?.key !== key) {
      delete stored[stage];
      dropped.push(stage);
    }
  }
  return dropped;
}

/*

Purpose:
	QC-01 step 2: renders the inline review panel for the active sample, or
	hides it when nothing is blocked.

Input:
	row [object|null]: the active file-table row, or null for no selection

Output:
	(none) [void]: writes the panel's markup and hidden state

*/
export function render_qc_critical_review(row) {
  if (!qc_critical_review) return;
  const state = row ? get_state(row.name) : null;
  const blocks = pending_qc_acknowledgements(state);
  if (!blocks.length) {
    qc_critical_review.hidden = true;
    if (qc_critical_review_list) qc_critical_review_list.innerHTML = "";
    if (qc_critical_review_status) qc_critical_review_status.hidden = true;
    return;
  }
  if (qc_critical_review_list) {
    qc_critical_review_list.innerHTML = blocks.map((block) => {
      const percent = Number.isFinite(block.percentRemoved)
        ? `${block.percentRemoved.toFixed(1)}%`
        : "an unrecorded share";
      const stale = block.stale
        ? ' <em class="qc_critical_review_stale">Your earlier acknowledgement was for a different QC configuration or a different file, so it no longer applies.</em>'
        : "";
      return `<li><strong>${escape_html(block.label)}</strong> removed ${escape_html(percent)} of events.${stale}</li>`;
    }).join("");
  }
  qc_critical_review.hidden = false;
}

/*

Purpose:
	QC-01: wires the "I have reviewed this" button. The caller supplies how to
	find the active row and what to do once an acknowledgement is recorded
	(normally: re-render the panel and re-enable the fit controls), so this
	module does not have to import the sidebar's orchestration and create an
	import cycle.

Input:
	active_row [function]: () -> row|null
	on_acknowledged [function]: (stages) -> void

Output:
	(none) [void]

*/
export function init_qc_critical_review({ active_row, on_acknowledged }) {
  if (!qc_critical_review_acknowledge) return;
  qc_critical_review_acknowledge.addEventListener("click", () => {
    const row = active_row?.();
    const state = row ? get_state(row.name) : null;
    const acknowledged = acknowledge_qc_critical_removal(state);
    if (qc_critical_review_status) {
      qc_critical_review_status.hidden = false;
      qc_critical_review_status.textContent = acknowledged.length
        ? `Recorded: ${acknowledged.map((stage) => QC_STAGE_LABELS[stage] ?? stage).join(", ")}. Re-run the fit to report this sample.`
        : "Nothing to acknowledge for this sample.";
    }
    render_qc_critical_review(row);
    on_acknowledged?.(acknowledged);
  });
}
