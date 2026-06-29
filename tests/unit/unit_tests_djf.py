#!/usr/bin/env python3
"""Unit tests for window.PhaseFinderDJF (djf_gpt.js).

Uses a synthetic bimodal histogram (two Gaussian peaks at ~64 000 and ~128 000)
built by window.TestUtils.buildBimodalHistogram() and invokes fit/fractions/
components/estimateRunG1 via page.evaluate(). No app state or console.log needed.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext

GROUP = "Unit / DJF Model"

# Shared JS snippet that builds the histogram once and runs all sub-tests.
# We keep the histogram in a JS variable across calls by using a single evaluate.

_FULL_SUITE = """() => {
  const DJF = window.PhaseFinderDJF;
  const points = window.TestUtils.buildBimodalHistogram(256);
  const range = [20000, 200000];
  const results = [];

  // 1. fit returns a non-null result
  const p = DJF.fit(points, range, null, null);
  results.push({ name: 'fit: returns a non-null result', pass: p !== null && Array.isArray(p),
                 detail: p === null ? 'fit returned null' : 'paramCount=' + p.length });

  if (!p) {
    // Remaining tests can't run without a fit
    for (let i = 0; i < 6; i++) results.push({ name: 'fit/fractions/components (no fit)', pass: false, detail: 'fit returned null' });
    return results;
  }

  // 2. G1 center in expected range (~64000 ± 30%)
  const g1 = p[0];
  const g1ok = g1 > 44800 && g1 < 83200;
  results.push({ name: 'fit: G1 center in expected range (64000 ± 30%)', pass: g1ok,
                 detail: 'G1=' + g1.toFixed(0) });

  // 3. G2/G1 ratio between 1.7 and 2.3
  const g2 = p[3];
  const ratio = g2 / g1;
  results.push({ name: 'fit: G2/G1 center ratio between 1.7 and 2.3', pass: ratio > 1.7 && ratio < 2.3,
                 detail: 'G2=' + g2.toFixed(0) + ' ratio=' + ratio.toFixed(3) });

  // 4. fractions sum to ~100%
  const frac = DJF.fractions(points, p);
  const total = frac.g1 + frac.s + frac.g2;
  results.push({ name: 'fractions: G1 + S + G2 sum to ~100% (within 1%)',
                 pass: Math.abs(total - 100) < 1,
                 detail: 'G1=' + frac.g1.toFixed(1) + '% S=' + frac.s.toFixed(1) + '% G2=' + frac.g2.toFixed(1) + '% sum=' + total.toFixed(2) });

  // 5. each fraction >= 0
  results.push({ name: 'fractions: each phase fraction is non-negative',
                 pass: frac.g1 >= 0 && frac.s >= 0 && frac.g2 >= 0,
                 detail: 'G1=' + frac.g1.toFixed(1) + '% S=' + frac.s.toFixed(1) + '% G2=' + frac.g2.toFixed(1) + '%' });

  // 6. estimate_run_g1 returns a positive value
  const g1est = DJF.estimate_run_g1([{ points }], null);
  results.push({ name: 'estimate_run_g1: returns a positive value on valid histogram',
                 pass: g1est !== null && g1est > 0,
                 detail: 'g1est=' + (g1est === null ? 'null' : g1est.toFixed(0)) });

  // 7. components evaluates to > 0 at G1 peak
  const comp = DJF.components(g1, p);
  const compOk = comp && typeof comp === 'object' && (comp.g1 > 0 || comp.total > 0 || Object.values(comp).some(v => v > 0));
  results.push({ name: 'components: model value > 0 at G1 peak position',
                 pass: Boolean(compOk),
                 detail: JSON.stringify(comp) });

  // 8. find_auxiliary_indexes links area to height/width channels with the same base
  const summary = window.FCSParser.parse_fcs_header(window.TestUtils.buildSyntheticFCS(20));
  const aux = DJF.find_auxiliary_indexes(summary, 'GFP/FITC-A');
  results.push({ name: 'find_auxiliary_indexes: resolves matching height and width channels',
                 pass: aux.dna_h === 2 && aux.dna_w === 3
                   && aux.dna_height_label === 'GFP/FITC-H'
                   && aux.dna_width_label === 'GFP/FITC-W',
                 detail: JSON.stringify(aux) });

  // 9. find_auxiliary_indexes returns an empty object for an unknown area channel
  const missingAux = DJF.find_auxiliary_indexes(summary, 'Not A Channel');
  results.push({ name: 'find_auxiliary_indexes: returns empty object for unknown channel',
                 pass: Object.keys(missingAux).length === 0,
                 detail: JSON.stringify(missingAux) });

  // 10. prepare_row without corrections preserves the DNA-A values
  const rawRow = { data: { dna_a: [64000, 66000, 128000] } };
  const preparedRaw = DJF.prepare_row(rawRow, { remove_debris: false, remove_doublets: false });
  results.push({ name: 'prepare_row: no corrections preserves all DNA-A values',
                 pass: preparedRaw.values.length === 3
                   && preparedRaw.stats.raw === 3
                   && preparedRaw.stats.plotted === 3,
                 detail: JSON.stringify(preparedRaw.stats) });

  // 11. prepare_row debris correction removes non-positive events
  const debrisRow = { data: { dna_a: [-5, 0, 64000, 66000, 128000] } };
  const preparedDebris = DJF.prepare_row(debrisRow, { remove_debris: true, remove_doublets: false });
  results.push({ name: 'prepare_row: debris correction removes non-positive events',
                 pass: preparedDebris.values.length < 5
                   && preparedDebris.stats.raw === 5
                   && preparedDebris.stats.debris_removed >= 2,
                 detail: JSON.stringify(preparedDebris.stats) });

  // 12. correction_summary reports unavailable doublet channels when requested
  const summaryText = DJF.correction_summary(
    [{ prepared: preparedDebris }],
    { remove_debris: true, remove_doublets: true }
  );
  results.push({ name: 'correction_summary: reports debris and unavailable doublet channels',
                 pass: /debris\\/background removed/.test(summaryText)
                   && /aggregate\\/doublet channels unavailable/.test(summaryText)
                   && /events plotted/.test(summaryText),
                 detail: summaryText });

  return results;
}"""


def run_djf_tests(ctx: TestContext):
    page = ctx.page

    try:
        all_results = page.evaluate(_FULL_SUITE)
    except Exception as err:
        ctx.check(GROUP, "DJF suite setup", False, str(err), screenshot=False)
        return

    for item in all_results:
        ctx.check(GROUP, item["name"], item["pass"], item.get("detail", ""), screenshot=False)
