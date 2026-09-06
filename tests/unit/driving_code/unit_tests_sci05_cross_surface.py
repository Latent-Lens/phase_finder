#!/usr/bin/env python3
"""SCI-05 regression coverage for "one canonical phase-fraction result
everywhere": the table/TSV/sidebar surfaces (format_fraction_cell(), shared by
all three -- see cell_cycle_columns.js's active_result() and
modeling_ui.js's render_fraction_value() wrapper) and the plot's SVG
<desc>/"Plot data and analysis summary" surface (render.js's analysis_text(),
fed by build_fit_series_entry()) must never show a different percentage, or a
different trust caveat, for the same fit.

The two surfaces do NOT share a formatter -- analysis_text() independently
reconstructs its text because an SVG <desc>/<title> cannot carry a CSS class
or a table cell's ⚠ styling. What keeps them from silently drifting apart is
architectural, not textual: both are fed exclusively through
get_active_model_result()/active_result() (pipeline_state.js's strict
validForReporting===true gate), so the `fit` a table cell reads and the `fit`
analysis_text() reads are the literal same contracted-result object, and both
call fraction_trust_reason() with the same converged/validForReporting
precedence. These tests prove that architecture holds, rather than trusting
the code comments that assert it."""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / SCI-05 Cross-Surface Fraction Consistency"


_SCI05_TESTS = r"""async () => {
  const contract = window.CellCycleResultContract;
  const pipelineState = window.DJFPipelineState;
  const columns = window.CellCycleColumns;
  const render = window.PlotRender;

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

  const rawResult = (overrides = {}) => ({
    kind: 'generative', modelId: 'dean_jett', modelLabel: 'Dean-Jett',
    converged: true, terminationReason: 'objective_step_tolerance', cancelled: false,
    expectedCounts: [4, 5, 6, 7, 8], components: [],
    phaseFractions: { g1: 0.512, s: 0.288, g2: 0.2 },
    diagnostics: { deviance: 10, bic: 42, reducedDeviance: 1.1 },
    ...overrides,
  });
  const passingPreflight = { passed: true, reasons: [] };
  const histogramState = { histogram: { x: [10, 20, 30, 40, 50] } };
  const seriesEntry = { row: 0, name: 'sci05-sample' };

  // Parses "G1 X.X%, S X.X%, G2/M X.X%" out of analysis_text()'s output.
  const parsePlotText = (text) => {
    const match = text.match(/G1 ([\d.]+)%, S ([\d.]+)%, G2\/M ([\d.]+)%/);
    if (!match) return null;
    return { g1: Number(match[1]), s: Number(match[2]), g2: Number(match[3]) };
  };
  // Parses the leading "X.X%" out of format_fraction_cell()'s output (the
  // literal function table/TSV/sidebar all call -- see render_fraction_value()
  // in modeling_ui.js, a thin wrapper that adds no numeric logic).
  const parseCellPercent = (cellText) => {
    const match = cellText.match(/^([\d.]+)%/);
    return match ? Number(match[1]) : null;
  };
  const tableFractions = (contracted) => ({
    g1: parseCellPercent(columns.format_fraction_cell(contracted, contracted.phaseFractions.g1)),
    s: parseCellPercent(columns.format_fraction_cell(contracted, contracted.phaseFractions.s)),
    g2: parseCellPercent(columns.format_fraction_cell(contracted, contracted.phaseFractions.g2)),
  });

  run('SCI-05: a clean converged, reportable fit shows byte-identical percentages on the table and the SVG-desc/summary surface', () => {
    const contracted = contract.apply_result_contract(rawResult(), passingPreflight);
    const built = render.build_fit_series_entry(seriesEntry, histogramState, contracted);
    const plotFractions = parsePlotText(render.analysis_text(seriesEntry, built));
    const cellFractions = tableFractions(contracted);
    return {
      pass: plotFractions && ['g1', 's', 'g2'].every((key) => plotFractions[key] === cellFractions[key]),
      detail: JSON.stringify({ plotFractions, cellFractions }),
    };
  });

  run('SCI-05: a nonconverged-but-reportable (FlowJo-style) fit shows the same numbers AND the same trust caveat on both surfaces', () => {
    const contracted = contract.apply_result_contract(
      rawResult({ converged: false, terminationReason: 'max_iterations' }),
      passingPreflight,
    );
    const built = render.build_fit_series_entry(seriesEntry, histogramState, contracted);
    const plotText = render.analysis_text(seriesEntry, built);
    const plotFractions = parsePlotText(plotText);
    const cellFractions = tableFractions(contracted);
    const cellsWarn = ['g1', 's', 'g2'].every((key) =>
      columns.format_fraction_cell(contracted, contracted.phaseFractions[key]).endsWith(' ⚠'));
    return {
      pass: contracted.validForReporting === true
        && plotFractions && ['g1', 's', 'g2'].every((key) => plotFractions[key] === cellFractions[key])
        && cellsWarn
        && plotText.includes('(fit did not converge)'),
      detail: JSON.stringify({ plotText, plotFractions, cellFractions, validForReporting: contracted.validForReporting }),
    };
  });

  run('SCI-05: an unreportable fit (e.g. cancelled) is refused by the SAME gate on both the table and the plot -- neither surface ever shows a number', () => {
    const contracted = contract.apply_result_contract(rawResult({ cancelled: true }), passingPreflight);
    const stateHoldingIt = { modeling: { activeResultKey: 'k', resultsByKey: { k: contracted } } };
    // active_result() (table/TSV/sidebar) and pipeline_fit_for_series()
    // (render.js's SVG-desc/summary source) both call this exact function --
    // proving it returns null here proves neither surface can diverge by
    // showing a number the other withholds.
    const gated = pipelineState.get_active_model_result(stateHoldingIt);
    const plotText = render.analysis_text({ pipelineState: { lastRunIndex: 2 } }, gated);
    return {
      pass: contracted.validForReporting === false
        && gated === null
        && plotText === 'QC through stage 3; no model fit',
      detail: JSON.stringify({ validForReporting: contracted.validForReporting, gated, plotText }),
    };
  });

  const critical = { id: 'rank_deficient', severity: 'critical', nonreportable: true, message: 'Rank-deficient fit.' };
  for (const [name, overrides, preflight, qualified, scientificallyValid] of [
    ['critical uncertainty', { uncertainty: { warnings: [critical] } }, passingPreflight, true, false],
    ['flattened uncertainty', { warnings: [{ ...critical, nonreportable: undefined }], uncertainty: { warnings: [critical] } }, passingPreflight, true, false],
    ['weak identification', { warnings: [{ id: 'ill_conditioned', severity: 'warning', message: 'Weakly identified.' }] }, passingPreflight, true, true],
    ['active bound', { warnings: [{ code: 'parameter_at_upper_bound', severity: 'warning', message: 'Area at bound.' }] }, passingPreflight, true, true],
    ['violated constraints', { constraintAudit: { violationCount: 1, violations: [{ parameter: 'g1CV' }] } }, passingPreflight, true, false],
    ['degenerate peak', { parameters: { g1CV: 0.3 }, bounds: { g1CV: [0.01, 0.3] } }, passingPreflight, true, false],
    ['single-peak assumption', {}, { ...passingPreflight, peakDetectionStatus: 'inferred_g2' }, true, true],
    ['informational note', { warnings: [{ code: 'model_settings_not_applied', severity: 'info', message: 'Ignored setting.' }] }, passingPreflight, false, true],
    ['nonreportable overrides info', { warnings: [{ severity: 'info', nonreportable: true, message: 'Unusable uncertainty.' }] }, passingPreflight, true, false],
  ]) {
    run(`GATE-02/UI-01: ${name} keeps the same numbers and qualification across table, plot and JSON`, () => {
      const result = contract.apply_result_contract(rawResult(overrides), preflight);
      const serialized = JSON.parse(JSON.stringify(result));
      const built = render.build_fit_series_entry(seriesEntry, histogramState, serialized);
      const plotText = render.analysis_text(seriesEntry, built);
      const exported = window.CellCycleExport.build_fit_export({ name: 'trust-test' }, serialized).fit;
      const table = tableFractions(serialized);
      const plot = parsePlotText(plotText);
      const reason = contract.fraction_trust_reason(result);
      const summary = contract.result_reporting_summary(result);
      return {
        pass: result.validForReporting === true
          && result.scientificallyValid === scientificallyValid
          && result.limitedReliability === qualified
          && Boolean(reason) === qualified
          && ['g1', 's', 'g2'].every((key) => table[key] === plot[key]
            && columns.format_fraction_cell(serialized, serialized.phaseFractions[key]).endsWith(' ⚠') === qualified)
          && (!qualified || plotText.includes(reason))
          && summary.status === (qualified ? 'Reportable with warnings' : 'Reportable')
          && exported.scientificallyValid === scientificallyValid
          && exported.limitedReliability === qualified
          && JSON.stringify(exported.phaseFractions) === JSON.stringify(result.phaseFractions)
          && JSON.stringify(exported.warnings) === JSON.stringify(result.warnings)
          && (!overrides.uncertainty || (result.warnings.length === 1 && result.warnings[0].nonreportable === true)),
        detail: JSON.stringify({ name, reason, summary, plotText, exported }),
      };
    });
  }

  run('GATE-02: old contract versions cannot activate results without current warning checks', () => {
    const current = contract.apply_result_contract(rawResult(), passingPreflight);
    const old = { ...current, contractVersion: contract.RESULT_CONTRACT_VERSION - 1 };
    return { pass: contract.is_reportable_result(current) && !contract.is_reportable_result(old), detail: JSON.stringify(old) };
  });

  run('SCI-05: a JSON-serialized result reproduces byte-identical percentages on both surfaces', () => {
    const contracted = contract.apply_result_contract(rawResult(), passingPreflight);
    const before = {
      plot: parsePlotText(render.analysis_text(seriesEntry, render.build_fit_series_entry(seriesEntry, histogramState, contracted))),
      table: tableFractions(contracted),
    };
    // This checks only result serialization. Actual TOML session restore
    // recomputes fits and needs separate coverage (SCI-05 / STATE-02).
    const restored = JSON.parse(JSON.stringify(contracted));
    const after = {
      plot: parsePlotText(render.analysis_text(seriesEntry, render.build_fit_series_entry(seriesEntry, histogramState, restored))),
      table: tableFractions(restored),
    };
    return {
      pass: JSON.stringify(before) === JSON.stringify(after),
      detail: JSON.stringify({ before, after }),
    };
  });

  return results;
}"""


def run_sci05_cross_surface_tests(ctx: TestContext):
    """Run the SCI-05 table/TSV/sidebar vs. SVG-desc fraction-consistency assertions."""

    try:
        all_results = ctx.page.evaluate(_SCI05_TESTS)
    except Exception as err:
        ctx.check(GROUP, "SCI-05 suite setup", False, str(err), screenshot=False)
        return

    for item in all_results:
        ctx.check(GROUP, item["name"], item["pass"], item.get("detail", ""), screenshot=False)
