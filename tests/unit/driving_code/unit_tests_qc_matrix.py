#!/usr/bin/env python3
"""Browser unit coverage for the QC-01 batch QC matrix.

The per-file/per-stage outcomes have always existed on the pipeline state, and
the four QC masks have always been composed into `masks.final`; what did not
exist was a surface that showed them for a whole batch, or any check that the
mask an analysis actually used is the composition the report claims it is.

The tests below concentrate on that last point. Listing which stages ran is
provenance by assertion -- it records what was SUPPOSED to have happened. The
matrix instead recomposes the stage masks and compares against the stored final
mask, so a mask left over from before a stage re-ran is reported rather than
described. `final_mask_provenance` is therefore tested with a deliberately
stale mask, an all-pass mask, an absent mask, and a length mismatch, because
each of those is a different way for a batch to look fine and not be.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / QC Matrix"


_TESTS = r"""() => {
  const M = window.QcMatrix;
  const results = [];
  const push = (name, pass, detail = '') => results.push({
    name, pass: Boolean(pass), detail: String(detail ?? ''),
  });
  const run = (name, test) => {
    try {
      const outcome = test();
      push(name, outcome.pass, outcome.detail);
    } catch (error) {
      push(name, false, `${error.name}: ${error.message}`);
    }
  };

  const mask = (bits) => Uint8Array.from(bits);
  const AND = (...masks) => mask(masks[0].map((_, i) => masks.every((m) => m[i]) ? 1 : 0));

  // Four events; structural drops the last, the cell gate drops the first.
  const structuralMask = mask([1, 1, 1, 0]);
  const scatterMask = mask([0, 1, 1, 1]);

  const makeRow = (overrides = {}) => ({
    id: 'row-1', name: 'sample-a.fcs',
    data: {
      eventCount: 4,
      channel_key: 'DNA_A',
      masks: {
        structural: structuralMask, timeQC: null, scatter: scatterMask, singlet: null,
        final: AND(structuralMask, scatterMask),
      },
      ...overrides,
    },
  });

  const makeState = (overrides = {}) => ({
    structuralQC: { configHash: 'cfg-S', evaluatedEventCount: 4, rejectedEventCount: 1, retainedEventCount: 3 },
    scatterGate: { configHash: 'cfg-C', evaluatedEventCount: 3, rejectedEventCount: 1, retainedEventCount: 2 },
    timeQC: null,
    singletResult: null,
    ...overrides,
  });

  const matrixFor = (row, state) => M.build_qc_matrix([{ row, state }], { now: new Date('2026-08-18T12:00:00Z') });

  // ---- shape ---------------------------------------------------------------

  run('QC-01 matrix: every loaded sample is crossed with every QC stage', () => {
    const matrix = matrixFor(makeRow(), makeState());
    const stages = Object.keys(matrix.samples[0].stages);
    return {
      pass: matrix.samples.length === 1
        && stages.length === 4
        && ['structural', 'time', 'scatter', 'singlet'].every((key) => stages.includes(key)),
      detail: JSON.stringify(stages),
    };
  });

  run('QC-01 matrix: a stage that never ran is reported as not_run, not omitted', () => {
    // Omission is the failure mode this replaces: a batch view that only lists
    // the stages that produced something cannot be read as "the singlet gate
    // was never applied to these thirty files".
    const time = matrixFor(makeRow(), makeState()).samples[0].stages.time;
    return { pass: time.status === 'not_run' && time.maskPresent === false, detail: JSON.stringify(time) };
  });

  run('QC-01 matrix: each stage carries its own counts and config hash', () => {
    const structural = matrixFor(makeRow(), makeState()).samples[0].stages.structural;
    return {
      pass: structural.status === 'applied' && structural.evaluatedEventCount === 4
        && structural.rejectedEventCount === 1 && structural.retainedEventCount === 3
        && structural.configHash === 'cfg-S' && Math.abs(structural.percentRemoved - 25) < 1e-9,
      detail: JSON.stringify(structural),
    };
  });

  run('QC-01 matrix: the matrix is versioned and stamps the build that produced it', () => {
    const matrix = matrixFor(makeRow(), makeState());
    return {
      pass: typeof matrix.formatVersion === 'string' && matrix.formatVersion.length > 0
        && matrix.builtAt === '2026-08-18T12:00:00.000Z'
        && matrix.application?.name === 'PhaseFinder'
        && typeof matrix.application.sourceCommit === 'string',
      detail: JSON.stringify({ v: matrix.formatVersion, at: matrix.builtAt, app: matrix.application }),
    };
  });

  // ---- final-mask provenance: the point of the item ------------------------

  run('QC-01 provenance: a correctly composed final mask verifies', () => {
    const provenance = M.final_mask_provenance(makeRow());
    return {
      pass: provenance.source === 'composed'
        && provenance.verified === true && provenance.mismatchCount === 0
        && provenance.retainedEventCount === 2
        && JSON.stringify(provenance.contributingStages) === JSON.stringify(['structural', 'scatter']),
      detail: JSON.stringify(provenance),
    };
  });

  run('QC-01 provenance: a STALE final mask fails verification', () => {
    // The mask still on the row was composed before the cell gate ran. Every
    // per-stage row in the matrix looks correct; only the recomposition
    // catches that the histogram was built from the wrong events.
    const row = makeRow();
    row.data.masks.final = mask([1, 1, 1, 0]);   // structural only
    const provenance = M.final_mask_provenance(row);
    return {
      pass: provenance.verified === false && provenance.mismatchCount === 1,
      detail: JSON.stringify(provenance),
    };
  });

  run('QC-01 provenance: no stage masks means the final mask must be all-pass', () => {
    const row = makeRow();
    row.data.masks = { structural: null, timeQC: null, scatter: null, singlet: null, final: mask([1, 1, 1, 1]) };
    const clean = M.final_mask_provenance(row);
    row.data.masks.final = mask([1, 1, 0, 1]);   // events dropped by nothing at all
    const unexplained = M.final_mask_provenance(row);
    return {
      pass: clean.source === 'all-pass' && clean.verified === true
        && unexplained.verified === false && unexplained.mismatchCount === 1,
      detail: JSON.stringify({ clean, unexplained }),
    };
  });

  run('QC-01 provenance: an absent final mask is reported, not treated as all-pass', () => {
    const row = makeRow();
    row.data.masks.final = null;
    const provenance = M.final_mask_provenance(row);
    return {
      pass: provenance.source === 'absent' && provenance.verified === null
        && provenance.retainedEventCount === null,
      detail: JSON.stringify(provenance),
    };
  });

  run('QC-01 provenance: a length mismatch fails verification instead of throwing', () => {
    // combine_masks() throws on mismatched lengths. The matrix has to survive
    // that and report it: a report that aborts on the one broken sample tells
    // the user nothing about the other twenty-nine.
    const row = makeRow();
    row.data.masks.scatter = mask([1, 1, 1]);
    const provenance = M.final_mask_provenance(row);
    return { pass: provenance.verified === false, detail: JSON.stringify(provenance) };
  });

  run('QC-01 matrix: unverified and absent final masks are collected in the summary', () => {
    const good = makeRow();
    const stale = makeRow();
    stale.id = 'row-2'; stale.name = 'sample-b.fcs';
    stale.data.masks = { ...stale.data.masks, final: mask([1, 1, 1, 0]) };
    const matrix = M.build_qc_matrix([
      { row: good, state: makeState() },
      { row: stale, state: makeState() },
    ]);
    return {
      pass: JSON.stringify(matrix.summary.unverifiedFinalMasks) === JSON.stringify(['sample-b.fcs'])
        && matrix.summary.sampleCount === 2,
      detail: JSON.stringify(matrix.summary),
    };
  });

  // ---- critical removals and acknowledgements ------------------------------

  run('QC-01 matrix: a critical removal is flagged, with whether it is acknowledged', () => {
    const heavy = { configHash: 'cfg-S', evaluatedEventCount: 1000, rejectedEventCount: 700, retainedEventCount: 300 };
    const unacked = matrixFor(makeRow(), makeState({ structuralQC: heavy }));
    const key = unacked.samples[0].stages.structural.acknowledgementKey;
    const acked = matrixFor(makeRow(), makeState({
      structuralQC: heavy,
      qcAcknowledgements: { structural: { key, acknowledgedAt: '2026-08-18T00:00:00.000Z' } },
    }));
    return {
      pass: unacked.summary.criticalRemovals.length === 1
        && unacked.summary.criticalRemovals[0].acknowledged === false
        && acked.summary.criticalRemovals[0].acknowledged === true,
      detail: JSON.stringify({ unacked: unacked.summary.criticalRemovals, acked: acked.summary.criticalRemovals }),
    };
  });

  run('QC-01 matrix: an acknowledgement for a DIFFERENT outcome reads as unacknowledged', () => {
    // Same invalidation rule as the fit gate, reported the same way -- if the
    // matrix said "acknowledged" where the contract says "blocked", the batch
    // view would contradict the thing it is supposed to explain.
    const heavy = { configHash: 'cfg-S', evaluatedEventCount: 1000, rejectedEventCount: 700, retainedEventCount: 300 };
    const matrix = matrixFor(makeRow(), makeState({
      structuralQC: heavy,
      qcAcknowledgements: { structural: { key: 'structural|cfg-OLD|1000|700|300', acknowledgedAt: '2026-08-01T00:00:00.000Z' } },
    }));
    const record = matrix.samples[0].stages.structural;
    return {
      pass: record.criticalRemoval === true && record.acknowledgementAuthorizes === false
        && record.acknowledgedAt === '2026-08-01T00:00:00.000Z',
      detail: JSON.stringify(record),
    };
  });

  run('QC-01 matrix: a waived stage is recorded as waived, with its reason', () => {
    const matrix = matrixFor(makeRow(), makeState({
      structuralQC: null,
      qcWaivers: { structural: { reason: 'external instrument QC' } },
    }));
    const record = matrix.samples[0].stages.structural;
    return {
      pass: record.status === 'waived' && record.waived === true
        && record.waiverReason === 'external instrument QC',
      detail: JSON.stringify(record),
    };
  });

  // ---- serialization -------------------------------------------------------

  run('QC-01 TSV: one row per sample x stage, with a fixed column set', () => {
    const matrix = matrixFor(makeRow(), makeState());
    const lines = M.build_qc_matrix_tsv(matrix).split('\n');
    const header = lines[0].split('\t');
    const widths = new Set(lines.map((line) => line.split('\t').length));
    return {
      pass: lines.length === 5 && widths.size === 1 && header.includes('final_mask_verified')
        && header.includes('acknowledgement_key') && header[0] === 'sample',
      detail: `lines=${lines.length} widths=${JSON.stringify([...widths])} cols=${header.length}`,
    };
  });

  run('QC-01 TSV: final-mask provenance is repeated on every stage row', () => {
    // Long form is only usable if each row stands alone; a reader filtering to
    // one stage must still be able to see which mask the analysis used.
    const matrix = matrixFor(makeRow(), makeState());
    const lines = M.build_qc_matrix_tsv(matrix).split('\n');
    const header = lines[0].split('\t');
    const at = (line, column) => line.split('\t')[header.indexOf(column)];
    const values = lines.slice(1).map((line) => at(line, 'final_mask_stages'));
    return {
      pass: values.length === 4 && values.every((value) => value === 'structural+scatter'),
      detail: JSON.stringify(values),
    };
  });

  run('QC-01 TSV: tabs and newlines in a reason cannot break the row', () => {
    const matrix = matrixFor(makeRow(), makeState({
      structuralQC: { skipped: true, reason: 'missing\tDNA_H\nchannel' },
    }));
    const lines = M.build_qc_matrix_tsv(matrix).split('\n');
    const width = lines[0].split('\t').length;
    return {
      pass: lines.length === 5 && lines.every((line) => line.split('\t').length === width),
      detail: `lines=${lines.length} widths=${JSON.stringify(lines.map((l) => l.split('\t').length))}`,
    };
  });

  run('QC-01 TSV: a value that would be read as a formula is neutralised', () => {
    const matrix = matrixFor(makeRow(), makeState({
      structuralQC: { skipped: true, reason: '=cmd|calc' },
    }));
    const line = M.build_qc_matrix_tsv(matrix).split('\n')[1];
    return { pass: line.includes("'=cmd|calc"), detail: line };
  });

  run('QC-01 HTML: the wide grid names each sample, each stage, and the mask verdict', () => {
    const stale = makeRow();
    stale.data.masks = { ...stale.data.masks, final: mask([1, 1, 1, 0]) };
    const html = M.qc_matrix_html(matrixFor(stale, makeState()));
    return {
      pass: html.includes('sample-a.fcs') && html.includes('Structural QC') && html.includes('Singlet gate')
        && /does NOT match/.test(html) && html.includes('structural ∧ scatter'),
      detail: html.slice(0, 260),
    };
  });

  run('QC-01 HTML: a sample name is escaped, not interpolated as markup', () => {
    const row = makeRow();
    row.name = '<img src=x onerror=alert(1)>.fcs';
    const html = M.qc_matrix_html(matrixFor(row, makeState()));
    return {
      pass: !html.includes('<img') && html.includes('&lt;img'),
      detail: html.slice(html.indexOf('tbody'), html.indexOf('tbody') + 160),
    };
  });

  run('QC-01 HTML: an empty batch says so instead of rendering an empty table', () => {
    const html = M.qc_matrix_html(M.build_qc_matrix([]));
    return { pass: !html.includes('<table') && /No samples/.test(html), detail: html };
  });

  return results;
}"""


def run_qc_matrix_tests(ctx: TestContext):
    """Run the QC-01 batch-matrix and final-mask-provenance assertions."""

    try:
        all_results = ctx.page.evaluate(_TESTS)
    except Exception as err:
        ctx.check(GROUP, "qc matrix suite setup", False, str(err), screenshot=False)
        return

    for item in all_results:
        ctx.check(GROUP, item["name"], item["pass"], item.get("detail", ""), screenshot=False)
