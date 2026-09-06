#!/usr/bin/env python3
"""Browser unit coverage for the FEAT-02 versioned fit export module
(js/analysis/cell_cycle/export.js). Covers build_fit_export() (the JSON
payload: provenance, model identity, and the fit's trust state alongside
the phase fractions -- not just the percentages) and build_fit_csv() (the
long-form per-bin CSV, including the formula-injection defense on cell
values). AD-5: export.js is a pure module (no DOM, no js/ui/* imports), so
these tests call it directly with plain fixture objects -- no rendering,
no app state.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / Cell Cycle Export"


_TESTS = r"""() => {
  const mod = window.CellCycleExport;
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
  const throws = (callback, pattern = null) => {
    try {
      callback();
      return false;
    } catch (error) {
      return pattern ? pattern.test(error.message) : true;
    }
  };

  const row = {
    name: 'sample_A',
    data: { eventCount: 12345, channel_key: 'FL2-A' },
  };

  const fullResult = {
    modelId: 'dean_jett_fox',
    modelVersion: '2.1.0',
    settings: { smoothingSigmaBins: 2 },
    settingsApplicability: { smoothingSigmaBins: true },
    configHash: 'abc123',
    analysisDomain: [0, 400],
    binCount: 256,
    domainCoverage: { underflow: 0.001, overflow: 0.002, componentTailCoverage: 0.98 },
    peakRegions: { g1: { left: 10, right: 30 }, g2: { left: 120, right: 160 } },
    preflight: { qc: { status: 'pass' } },
    bulkRegionProvenance: { source: 'manual' },
    parameters: { mu1: 70, sigma1: 4.2, mu2: 140, sigma2: 9.8, R: 1.974 },
    phaseFractions: { g1: 0.55, s: 0.3, g2: 0.15 },
    converged: true,
    convergenceReason: 'gradient-tolerance',
    validForReporting: true,
    validityReasons: [],
    warnings: ['S-phase estimate near a QC boundary'],
    goodnessOfFit: { chiSquare: 1.23, reducedChiSquare: 1.01 },
    optimizerDiagnostics: { iterations: 42 },
    contractVersion: 1,
    curves: {
      x: [10, 20, 30],
      observed: [100, 200, 150],
      fitted: [98, 202, 148],
      g1: [90, 10, 0],
      s: [8, 180, 20],
      g2: [0, 12, 128],
      residuals: [2, -2, 2],
    },
  };

  run('export: EXPORT_FORMAT_VERSION is a semver-shaped string', () => {
    return {
      pass: typeof mod.EXPORT_FORMAT_VERSION === 'string' && /^\d+\.\d+\.\d+$/.test(mod.EXPORT_FORMAT_VERSION),
      detail: String(mod.EXPORT_FORMAT_VERSION),
    };
  });

  run('build_fit_export: throws with no result to export', () => {
    const failed = throws(() => mod.build_fit_export(row, null), /No fit result/);
    return { pass: failed, detail: `failed=${failed}` };
  });

  run('build_fit_export: carries application/model/domain provenance, not just numbers', () => {
    const out = mod.build_fit_export(row, fullResult);
    return {
      pass: out.formatVersion === mod.EXPORT_FORMAT_VERSION
        && typeof out.exportedAt === 'string' && !Number.isNaN(Date.parse(out.exportedAt))
        && out.application?.name === 'PhaseFinder'
        && typeof out.application.version === 'string' && out.application.version.length > 0
        && typeof out.application.sourceCommit === 'string' && out.application.sourceCommit.length > 0
        && out.sample.name === 'sample_A'
        && out.sample.eventCount === 12345
        && out.sample.channel === 'FL2-A'
        && out.model.id === 'dean_jett_fox'
        && out.model.version === '2.1.0'
        && out.model.configHash === 'abc123'
        && Array.isArray(out.domain.range) && out.domain.range[0] === 0 && out.domain.range[1] === 400
        && out.domain.componentTailCoverage === 0.98
        && out.peakRegions?.g1?.left === 10
        && out.qc?.status === 'pass'
        && out.bulkRegionProvenance?.source === 'manual',
      detail: JSON.stringify(out),
    };
  });

  run('build_fit_export: the fit block carries trust state, not only phase fractions', () => {
    const out = mod.build_fit_export(row, fullResult);
    const f = out.fit;
    return {
      pass: JSON.stringify(f.phaseFractions) === JSON.stringify({ g1: 0.55, s: 0.3, g2: 0.15 })
        && f.converged === true
        && f.convergenceReason === 'gradient-tolerance'
        && f.validForReporting === true
        && Array.isArray(f.validityReasons)
        && Array.isArray(f.warnings) && f.warnings.length === 1
        && f.goodnessOfFit?.reducedChiSquare === 1.01
        && f.optimizerDiagnostics?.iterations === 42
        && f.contractVersion === 1,
      detail: JSON.stringify(f),
    };
  });

  run('build_fit_export: includeCurves defaults to true, and false omits the curves', () => {
    const withCurves = mod.build_fit_export(row, fullResult);
    const withoutCurves = mod.build_fit_export(row, fullResult, { includeCurves: false });
    return {
      pass: withCurves.curves?.x?.length === 3 && withoutCurves.curves === null,
      detail: JSON.stringify({ withCurvesLength: withCurves.curves?.x?.length, withoutCurves: withoutCurves.curves }),
    };
  });

  run('build_fit_export: missing optional fields resolve to null/[] rather than throwing', () => {
    const minimalRow = { name: 'bare' };
    const out = mod.build_fit_export(minimalRow, { modelId: 'watson_pragmatic' });
    return {
      pass: out.sample.eventCount === null
        && out.sample.channel === null
        && out.model.settings === null
        && out.peakRegions === null
        && out.qc === null
        && out.fit.warnings.length === 0
        && out.fit.validityReasons.length === 0
        && out.curves === null,
      detail: JSON.stringify(out),
    };
  });

  run('build_fit_csv: throws when the result has no curves', () => {
    const failed = throws(() => mod.build_fit_csv(row, { modelId: 'x' }), /no curves/);
    return { pass: failed, detail: `failed=${failed}` };
  });

  run('build_fit_csv: header + one row per bin, values in bin order', () => {
    const csv = mod.build_fit_csv(row, fullResult);
    const lines = csv.split('\n');
    const header = lines[0];
    const dataRows = lines.slice(1);
    const secondRowFields = dataRows[1].split(',');
    return {
      pass: header === 'sample,model,bin_center,observed,fitted,g1,s,g2,residual,qualification,warnings'
        && dataRows.length === 3
        // fields: "sample_A","dean_jett_fox",20,200,202,10,180,12,-2
        && secondRowFields[2] === '20' && secondRowFields[3] === '200' && secondRowFields[8] === '-2',
      detail: csv,
    };
  });

  run('build_fit_csv: qualification and warnings columns carry the fit\'s actual trust caveat and warning content (GATE-02/UI-01), not just a header label', () => {
    // The header-shape test above never inspects these two columns' values, so
    // a regression that wired them to the wrong field (or always blank) would
    // pass it silently. fullResult carries one non-info warning, which is
    // exactly the case fraction_trust_reason() (the same function table,
    // sidebar and TSV route through) treats as material.
    const reason = window.CellCycleResultContract.fraction_trust_reason(fullResult);
    const warned = mod.build_fit_csv(row, fullResult).split('\n')[1];
    const cleanResult = { ...fullResult, warnings: [] };
    const cleanReason = window.CellCycleResultContract.fraction_trust_reason(cleanResult);
    const clean = mod.build_fit_csv(row, cleanResult).split('\n')[1];
    return {
      pass: reason === 'fit has reliability warnings'
        && warned.endsWith(`"${reason}","[""S-phase estimate near a QC boundary""]"`)
        && cleanReason === ''
        && clean.endsWith('"",""[]""') === false && clean.endsWith('"","[]"'),
      detail: JSON.stringify({ reason, warned, cleanReason, clean }),
    };
  });

  run('build_fit_csv: neutralizes a leading formula character in a cell (FE-028 injection defense)', () => {
    const hostileRow = { name: '=SUM(A1:A2)' };
    const csv = mod.build_fit_csv(hostileRow, fullResult);
    const firstDataRow = csv.split('\n')[1];
    // Expect the sample cell quoted with a defused leading char: "'=SUM(A1:A2)"
    return {
      pass: firstDataRow.startsWith('"\'=SUM(A1:A2)"'),
      detail: firstDataRow,
    };
  });

  run('build_fit_csv: quotes embedded double quotes in a cell', () => {
    const quoteyRow = { name: 'sample "B"' };
    const csv = mod.build_fit_csv(quoteyRow, fullResult);
    const firstDataRow = csv.split('\n')[1];
    // Built by concatenation (not a literal) so this source file never
    // contains a run of three raw double-quote characters -- that sequence
    // would prematurely close the Python r\"\"\" string this JS lives in.
    const q = String.fromCharCode(34);
    const expectedCell = [q, 'sample ', q, q, 'B', q, q, q].join('');
    return {
      pass: firstDataRow.startsWith(expectedCell),
      detail: firstDataRow,
    };
  });

  return results;
}"""


def run_cell_cycle_export_tests(ctx: TestContext):
    results = ctx.page.evaluate(_TESTS)
    for result in results:
        ctx.check(GROUP, result["name"], result["pass"], result["detail"])
