// QC-01: the batch QC matrix -- one durable, per-file/per-stage record of what
// every QC stage did, together with the provenance of the final mask the
// analysis actually used.
//
// The data has always been there (each stage's product, and the four masks
// composed by recompute_final_mask()); what was missing was any surface that
// showed it for a whole batch at once. Per-sample status text tells a user that
// one file lost events; it does not tell them that eleven of thirty files lost
// more than half, nor which stages did it, and nothing carried that off-screen
// into a file they could keep.
//
// The one non-obvious column is `finalMask.verified`. Listing which stages ran
// is provenance by assertion: it says which masks were SUPPOSED to compose the
// final mask. This module instead recomposes the stage masks that are present
// and compares the result to the stored `masks.final` element by element, so
// the matrix reports whether the mask the histogram was actually built from is
// exactly the AND of the stages named beside it. A mismatch means some stage
// re-ran without the final mask being recomputed, which is precisely the class
// of silent staleness the QC surfaces cannot otherwise see.
//
// AD-5: pure. No DOM, no pipeline globals -- callers pass the (row, state)
// pairs in, so this loads unmodified in the headless unit harness.

import { qc_outcome, qc_acknowledgement_key, qc_acknowledgement_authorizes, QC_CRITICAL_REMOVAL_PERCENT } from "../cell_cycle/result_contract.js";
import { combine_masks } from "./pipeline_state.js";
import { PHASEFINDER_VERSION, PHASEFINDER_SOURCE_COMMIT } from "../../util/build_info.js";
import { escape_html } from "../../util/html.js";

export const QC_MATRIX_FORMAT_VERSION = "1.0.0";

// The four QC filter stages, in the order they are applied. `product` is the
// pipeline-state field holding the stage's result; `mask` is its field in
// row.data.masks. Both names differ from the stage key for historical reasons,
// which is exactly why they are written down once here instead of being spelled
// out at each call site.
export const QC_MATRIX_STAGES = [
  { key: "structural", label: "Structural QC", product: "structuralQC", mask: "structural" },
  { key: "time", label: "Time QC", product: "timeQC", mask: "timeQC" },
  { key: "scatter", label: "Cell gate", product: "scatterGate", mask: "scatter" },
  { key: "singlet", label: "Singlet gate", product: "singletResult", mask: "singlet" },
];

function mask_retained_count(mask) {
  if (!mask || typeof mask.length !== "number") return null;
  let retained = 0;
  for (let index = 0; index < mask.length; index += 1) if (mask[index]) retained += 1;
  return retained;
}

function finite_or_null(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/*

Purpose:
	QC-01: reports how one sample's final mask was actually composed, and
	whether the stored mask really is that composition.

	`contributingStages` is what the stored mask is claimed to be made of (the
	stage masks that are present); `verified` is whether it is. They are
	separate fields on purpose -- a report that only listed the stages would
	be unable to distinguish "the final mask is the AND of these four" from
	"the final mask is left over from before the cell gate re-ran".

Input:
	row [object]: a sample row (reads row.data.masks and row.data.eventCount)

Output:
	provenance [object]: { eventCount, contributingStages, retainedEventCount,
	                       retainedFraction, source, verified, mismatchCount }

*/
export function final_mask_provenance(row) {
  const masks = row?.data?.masks ?? {};
  const eventCount = finite_or_null(row?.data?.eventCount);
  const contributing = QC_MATRIX_STAGES.filter((stage) => masks[stage.mask] != null);
  const stored = masks.final ?? null;
  const provenance = {
    eventCount,
    contributingStages: contributing.map((stage) => stage.key),
    retainedEventCount: mask_retained_count(stored),
    retainedFraction: null,
    // "composed": built from at least one stage mask. "all-pass": no stage has
    // produced a mask, so every event survives by default. "absent": no final
    // mask has been computed at all -- nothing downstream can be trusted.
    source: stored == null ? "absent" : (contributing.length ? "composed" : "all-pass"),
    verified: null,
    mismatchCount: null,
  };
  if (Number.isFinite(provenance.retainedEventCount) && eventCount > 0) {
    provenance.retainedFraction = provenance.retainedEventCount / eventCount;
  }
  if (stored == null) return provenance;

  // Recompose and compare. combine_masks() throws on a length mismatch, which
  // is itself a failure to verify rather than an error to propagate: the
  // matrix's job is to report the discrepancy, not to abort the report.
  let recomposed = null;
  try {
    recomposed = combine_masks(contributing.map((stage) => masks[stage.mask]));
  } catch (_) {
    provenance.verified = false;
    return provenance;
  }
  if (recomposed == null) {
    // No stage masks: the final mask should be all-pass.
    let mismatches = 0;
    for (let index = 0; index < stored.length; index += 1) if (!stored[index]) mismatches += 1;
    provenance.mismatchCount = mismatches;
    provenance.verified = mismatches === 0 && (eventCount == null || stored.length === eventCount);
    return provenance;
  }
  if (recomposed.length !== stored.length) {
    provenance.verified = false;
    return provenance;
  }
  let mismatches = 0;
  for (let index = 0; index < stored.length; index += 1) {
    if (Boolean(stored[index]) !== Boolean(recomposed[index])) mismatches += 1;
  }
  provenance.mismatchCount = mismatches;
  provenance.verified = mismatches === 0;
  return provenance;
}

function stage_record(stage, state, masks) {
  const product = state?.[stage.product] ?? null;
  const waiver = state?.qcWaivers?.[stage.key];
  const outcome = qc_outcome(product, waiver);
  const percentRemoved = finite_or_null(outcome.percentRemoved);
  const critical = percentRemoved != null && percentRemoved > QC_CRITICAL_REMOVAL_PERCENT;
  const key = qc_acknowledgement_key(stage.key, product);
  const stored = state?.qcAcknowledgements?.[stage.key] ?? null;
  return {
    stage: stage.key,
    label: stage.label,
    status: outcome.status,
    reason: outcome.reason ?? null,
    percentRemoved,
    warningCount: Array.isArray(outcome.warnings) ? outcome.warnings.length : 0,
    evaluatedEventCount: finite_or_null(product?.evaluatedEventCount),
    rejectedEventCount: finite_or_null(product?.rejectedEventCount),
    retainedEventCount: finite_or_null(product?.retainedEventCount),
    configHash: product?.configHash ?? null,
    maskPresent: (masks ?? {})[stage.mask] != null,
    waived: outcome.status === "waived",
    waiverReason: waiver?.reason ?? null,
    criticalRemoval: critical,
    // Reported for every stage, not only the critical ones: a stored
    // acknowledgement that no longer authorizes is the thing a reader most
    // needs to see, and it is invisible if the matrix only prints a boolean.
    acknowledgementKey: key,
    acknowledgedAt: stored?.acknowledgedAt ?? null,
    acknowledgementAuthorizes: stored ? qc_acknowledgement_authorizes(stored, key) : false,
  };
}

/*

Purpose:
	QC-01: builds the batch QC matrix -- every sample crossed with every QC
	stage, plus each sample's final-mask provenance and a batch-level summary.

	Takes the (row, state) pairs rather than reading pipeline_states itself, so
	the caller decides what "the batch" means (every loaded file, only the
	plotted ones) and so this stays pure.

Input:
	entries [array]: [{ row, state }] pairs; entries without a row are skipped
	options [object]: { now [Date]: injectable clock for builtAt }

Output:
	matrix [object]: { formatVersion, builtAt, application, stages, samples,
	                   summary }

*/
export function build_qc_matrix(entries, { now = new Date() } = {}) {
  const samples = [];
  for (const entry of entries ?? []) {
    const row = entry?.row;
    if (!row) continue;
    const state = entry.state ?? null;
    const masks = row?.data?.masks ?? {};
    samples.push({
      sample: row.name ?? null,
      eventCount: finite_or_null(row?.data?.eventCount),
      channel: row?.data?.channel_key ?? null,
      stages: Object.fromEntries(QC_MATRIX_STAGES.map((stage) => [stage.key, stage_record(stage, state, masks)])),
      finalMask: final_mask_provenance(row),
    });
  }

  const byStatus = {};
  const criticalRemovals = [];
  const unverifiedFinalMasks = [];
  for (const sample of samples) {
    for (const stage of QC_MATRIX_STAGES) {
      const record = sample.stages[stage.key];
      byStatus[record.status] = (byStatus[record.status] ?? 0) + 1;
      if (record.criticalRemoval) {
        criticalRemovals.push({
          sample: sample.sample,
          stage: stage.key,
          percentRemoved: record.percentRemoved,
          acknowledged: record.acknowledgementAuthorizes,
        });
      }
    }
    if (sample.finalMask.verified === false || sample.finalMask.source === "absent") {
      unverifiedFinalMasks.push(sample.sample);
    }
  }

  return {
    formatVersion: QC_MATRIX_FORMAT_VERSION,
    builtAt: now.toISOString(),
    application: { name: "PhaseFinder", version: PHASEFINDER_VERSION, sourceCommit: PHASEFINDER_SOURCE_COMMIT },
    stages: QC_MATRIX_STAGES.map((stage) => ({ key: stage.key, label: stage.label })),
    samples,
    summary: {
      sampleCount: samples.length,
      byStatus,
      criticalRemovals,
      // Named for what a reader has to act on: these samples' final masks are
      // either missing or are not the composition the matrix reports beside
      // them, so their fits are not reportable on this evidence.
      unverifiedFinalMasks,
    },
  };
}

const TSV_COLUMNS = [
  "sample", "event_count", "channel",
  "stage", "stage_label", "status", "reason", "percent_removed", "warnings",
  "evaluated_events", "rejected_events", "retained_events", "config_hash",
  "stage_mask_present", "waived", "waiver_reason",
  "critical_removal", "acknowledged", "acknowledged_at", "acknowledgement_key",
  "final_mask_source", "final_mask_stages", "final_mask_retained", "final_mask_verified",
];

// Tabs and newlines are the only characters that can break a TSV row, and no
// quoting convention is universally honoured by TSV readers, so they are
// replaced rather than escaped. A leading formula character is neutralised the
// same way build_fit_csv() does it, because these files get opened in Excel.
function tsv_cell(value) {
  if (value == null) return "";
  const text = String(value).replace(/[\t\r\n]+/g, " ");
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function tsv_bool(value) {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "";
}

/*

Purpose:
	QC-01: serializes the matrix to TSV, one row per sample x stage.

	Long form rather than the wide sample-by-stage grid the on-screen table
	uses: a wide grid cannot carry each stage's counts, config hash, and
	acknowledgement without a variable column set that changes shape with the
	stage list, and a file whose columns move is not one anyone can script
	against. The wide reading is what qc_matrix_html() is for.

Input:
	matrix [object]: a build_qc_matrix() result

Output:
	tsv [string]: TSV text with a header row, "\n"-joined

*/
export function build_qc_matrix_tsv(matrix) {
  const lines = [TSV_COLUMNS.join("\t")];
  for (const sample of matrix?.samples ?? []) {
    const final = sample.finalMask ?? {};
    for (const stage of QC_MATRIX_STAGES) {
      const record = sample.stages?.[stage.key];
      if (!record) continue;
      lines.push([
        tsv_cell(sample.sample), tsv_cell(sample.eventCount), tsv_cell(sample.channel),
        tsv_cell(record.stage), tsv_cell(record.label), tsv_cell(record.status), tsv_cell(record.reason),
        tsv_cell(record.percentRemoved == null ? "" : record.percentRemoved.toFixed(2)),
        tsv_cell(record.warningCount),
        tsv_cell(record.evaluatedEventCount), tsv_cell(record.rejectedEventCount),
        tsv_cell(record.retainedEventCount), tsv_cell(record.configHash),
        tsv_bool(record.maskPresent), tsv_bool(record.waived), tsv_cell(record.waiverReason),
        tsv_bool(record.criticalRemoval), tsv_bool(record.acknowledgementAuthorizes),
        tsv_cell(record.acknowledgedAt), tsv_cell(record.acknowledgementKey),
        tsv_cell(final.source), tsv_cell((final.contributingStages ?? []).join("+")),
        tsv_cell(final.retainedEventCount), tsv_bool(final.verified),
      ].join("\t"));
    }
  }
  return lines.join("\n");
}

function cell_text(record) {
  if (!record) return "—";
  const percent = record.percentRemoved == null ? null : `${record.percentRemoved.toFixed(1)}%`;
  const parts = [record.status.replace(/_/g, " ")];
  if (percent) parts.push(`−${percent}`);
  if (record.criticalRemoval) parts.push(record.acknowledgementAuthorizes ? "acknowledged" : "⚠ unacknowledged");
  if (record.waived) parts.push("waived");
  return parts.join(" · ");
}

/*

Purpose:
	QC-01: renders the matrix as the wide grid a human reads -- samples down,
	QC stages across, final-mask provenance in the last column -- for embedding
	in the analysis report.

	Returns markup, not DOM nodes, so it stays testable without a document and
	can be dropped into the exported HTML report as-is.

Input:
	matrix [object]: a build_qc_matrix() result

Output:
	html [string]: a <table> wrapped for horizontal scrolling, or an empty-state
	               paragraph when the batch has no samples

*/
export function qc_matrix_html(matrix) {
  const samples = matrix?.samples ?? [];
  if (!samples.length) return '<p class="empty">No samples have been loaded, so there is no QC matrix.</p>';
  const head = ["Sample", ...QC_MATRIX_STAGES.map((stage) => stage.label), "Final mask"]
    .map((label) => `<th>${escape_html(label)}</th>`).join("");
  const body = samples.map((sample) => {
    const final = sample.finalMask ?? {};
    const retained = final.retainedEventCount == null
      ? "not computed"
      : `${final.retainedEventCount} / ${final.eventCount ?? "?"} events`;
    const composition = (final.contributingStages ?? []).length
      ? (final.contributingStages ?? []).join(" ∧ ")
      : "no stage masks (all-pass)";
    // An unverified final mask is the one cell in this table that invalidates
    // everything to its left, so it says so in words rather than as a flag.
    const verified = final.verified === true
      ? "verified"
      : (final.verified === false ? "⚠ does NOT match the stages named here" : "⚠ no final mask");
    const cells = QC_MATRIX_STAGES
      .map((stage) => `<td>${escape_html(cell_text(sample.stages?.[stage.key]))}</td>`).join("");
    return `<tr><td>${escape_html(sample.sample ?? "—")}</td>${cells}`
      + `<td>${escape_html(retained)}<br>${escape_html(composition)}<br>${escape_html(verified)}</td></tr>`;
  }).join("");
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
