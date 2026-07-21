#!/usr/bin/env python3
"""Browser unit coverage for js/analysis/cell_cycle/models/watson_pragmatic.js
(M5): the pragmatic local-peak-plus-residual decomposition, as distinct from
Dean-Jett/Dean-Jett-Fox's joint generative fits.

Covers the plan's M5 exit gate directly:
  - fitted G1/G2 centers stay within their accepted peak regions;
  - the residual S is finite and nonnegative at every bin;
  - the result is `kind: "decomposition"` with `comparisonGroup: null`, so
    the UI/report layer can never place it in an AIC/BIC comparison against
    DJ/DJF.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / Cell Cycle Watson Pragmatic"


_WATSON_TESTS = r"""() => {
  const { peakComponents } = window.CellCycleModelShared;
  const { register_default_models, get_model, clear_registry } = window.CellCycleModelRegistry;
  const { estimatePeakFromRegion } = window.CellCyclePeakRegions;

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
  const close = (left, right, tolerance) => Math.abs(left - right) <= tolerance;
  const relClose = (left, right, relTolerance) => Math.abs(left - right) <= relTolerance * Math.max(Math.abs(right), 1);

  // Fine resolution (1200 bins over the same 0-300 physical domain) rather
  // than DJ/DJF's usual 1-unit bins: Watson's one-sided flank-crossing width
  // measurement reads a *single* bin crossing, unlike DJ/DJF's whole-curve
  // iterative fit, so it is far more sensitive to a peak spanning only a
  // handful of bins. A ~6% CV peak at mean ~70-140 is only ~4 bins wide at
  // 1-unit resolution (fine for an iterative fit, coarse for a single flank
  // crossing) but ~17 bins wide here, matching how many bins a real
  // instrument's histogram actually gives a G1/G2 peak.
  const edges = Array.from({ length: 1201 }, (_, i) => i * 0.25); // 1200 bins, width 0.25
  const regions = { g1: { left: 55, right: 85 }, g2: { left: 115, right: 165 } };

  register_default_models();
  const watson = get_model('watson_pragmatic');

  run('watson_pragmatic is registered by register_default_models() with the decomposition contract', () => ({
    pass: Boolean(watson) && watson.kind === 'decomposition' && watson.comparisonGroup === null && watson.fitScope === 'per_sample',
    detail: watson && JSON.stringify({ id: watson.id, kind: watson.kind, comparisonGroup: watson.comparisonGroup }),
  }));

  // ---- clean two-peak case: no S contamination, so recovery should be tight ----
  const TRUE_CLEAN = { g1Area: 8000, g1Mean: 70, g1CV: 0.06, g2Area: 3000, g2Mean: 140, g2CV: 0.07 };
  const cleanPeaks = peakComponents(edges, TRUE_CLEAN);
  const cleanCounts = cleanPeaks.g1.map((v, i) => Math.round(v + cleanPeaks.g2[i]));
  const cleanRaw = watson.fit({ histogram: { edges, counts: cleanCounts }, peakRegions: regions, config: {} });
  const cleanFitted = watson.normalizeResult(cleanRaw);

  run('watson_pragmatic recovers G1/G2 areas within 5% when there is no S-phase contamination', () => {
    const pass = relClose(cleanFitted.parameters.g1Area, TRUE_CLEAN.g1Area, 0.05) && relClose(cleanFitted.parameters.g2Area, TRUE_CLEAN.g2Area, 0.05);
    return { pass, detail: JSON.stringify(cleanFitted.parameters) };
  });

  run('watson_pragmatic residual S is near zero when there is nothing between the peaks', () => {
    const sTotal = cleanFitted.components.find((c) => c.id === 's').observedDomainArea;
    const pass = sTotal < 0.02 * (TRUE_CLEAN.g1Area + TRUE_CLEAN.g2Area);
    return { pass, detail: sTotal };
  });

  // ---- bridged case: a modest uniform S-phase bridge between the peaks ----
  const BRIDGE_HEIGHT = 20;
  const BRIDGE_START = 85;
  const BRIDGE_END = 125;
  const TRUE_BRIDGE = { g1Area: 8000, g1Mean: 70, g1CV: 0.06, g2Area: 3000, g2Mean: 140, g2CV: 0.07 };
  const bridgePeaks = peakComponents(edges, TRUE_BRIDGE);
  const bridgeCounts = bridgePeaks.g1.map((v, i) => {
    const center = 0.5 * (edges[i] + edges[i + 1]);
    const bridge = center >= BRIDGE_START && center < BRIDGE_END ? BRIDGE_HEIGHT : 0;
    return Math.round(v + bridgePeaks.g2[i] + bridge);
  });
  const bridgeRaw = watson.fit({ histogram: { edges, counts: bridgeCounts }, peakRegions: regions, config: {} });
  const bridgeFitted = watson.normalizeResult(bridgeRaw);

  run('watson_pragmatic converges (closed-form) on a bridged histogram', () => ({
    pass: bridgeFitted.converged === true && bridgeFitted.convergenceReason === 'closed_form',
    detail: bridgeFitted.convergenceReason,
  }));

  run('watson_pragmatic fitted G1/G2 centers stay inside their accepted peak regions (M5 exit gate)', () => {
    const pass =
      bridgeFitted.parameters.g1Mean >= regions.g1.left && bridgeFitted.parameters.g1Mean <= regions.g1.right &&
      bridgeFitted.parameters.g2Mean >= regions.g2.left && bridgeFitted.parameters.g2Mean <= regions.g2.right;
    return { pass, detail: JSON.stringify({ g1Mean: bridgeFitted.parameters.g1Mean, g2Mean: bridgeFitted.parameters.g2Mean, regions }) };
  });

  run('watson_pragmatic residual S is finite and nonnegative at every bin (M5 exit gate)', () => {
    const sCounts = bridgeFitted.components.find((c) => c.id === 's').counts;
    const pass = sCounts.every((value) => Number.isFinite(value) && value >= 0);
    return { pass, detail: sCounts.length };
  });

  run('watson_pragmatic recovers a clearly nonzero residual S for a real bridge', () => {
    const sTotal = bridgeFitted.components.find((c) => c.id === 's').observedDomainArea;
    const trueBridgeTotal = BRIDGE_HEIGHT * (BRIDGE_END - BRIDGE_START);
    const pass = sTotal > 0.5 * trueBridgeTotal;
    return { pass, detail: JSON.stringify({ sTotal, trueBridgeTotal }) };
  });

  run('watson_pragmatic phase fractions sum to 1 and G1 is the largest fraction (matches the largest true area)', () => {
    const { g1, s, g2 } = bridgeFitted.phaseFractions;
    const pass = close(g1 + s + g2, 1, 1e-6) && g1 > s && g1 > g2;
    return { pass, detail: JSON.stringify(bridgeFitted.phaseFractions) };
  });

  run('watson_pragmatic result is never AIC/BIC-comparable: kind is "decomposition" and comparisonGroup is null (M5 exit gate)', () => ({
    pass: bridgeFitted.kind === 'decomposition' && bridgeFitted.comparisonGroup === null,
    detail: JSON.stringify({ kind: bridgeFitted.kind, comparisonGroup: bridgeFitted.comparisonGroup }),
  }));

  run('watson_pragmatic.expectedCounts() is not implemented (S is observed-data-dependent, not parameter-only), matching legacy_bridge_v1’s documented precedent', () => ({
    pass: watson.expectedCounts(edges, bridgeFitted.parameters) === null,
    detail: watson.expectedCounts(edges, bridgeFitted.parameters),
  }));

  run('watson_pragmatic diagnostics windows are valid, in-bounds bin-index ranges', () => {
    const { g1Window, g2Window } = bridgeFitted.diagnostics;
    const validWindow = (w) => w.start >= 0 && w.end < edges.length - 1 && w.start <= w.end;
    return { pass: validWindow(g1Window) && validWindow(g2Window), detail: JSON.stringify({ g1Window, g2Window }) };
  });

  run('watson_pragmatic fitted CVs are finite and positive', () => {
    const pass = [bridgeFitted.parameters.g1CV, bridgeFitted.parameters.g2CV].every((cv) => Number.isFinite(cv) && cv > 0);
    return { pass, detail: JSON.stringify({ g1CV: bridgeFitted.parameters.g1CV, g2CV: bridgeFitted.parameters.g2CV }) };
  });

  clear_registry();

  // ---- estimatePeakFromRegion's new heightFraction option is backward compatible ----
  run('estimatePeakFromRegion(..., { heightFraction: 0.5 }) matches the pre-existing no-option default exactly', () => {
    const withDefault = estimatePeakFromRegion(edges, bridgeCounts, regions.g1, { label: 'G1' });
    const withExplicitHalf = estimatePeakFromRegion(edges, bridgeCounts, regions.g1, { label: 'G1', heightFraction: 0.5 });
    const pass = withDefault.mean === withExplicitHalf.mean && withDefault.sigma === withExplicitHalf.sigma && withDefault.area === withExplicitHalf.area;
    return { pass, detail: JSON.stringify({ withDefault, withExplicitHalf }) };
  });

  run('estimatePeakFromRegion(..., { heightFraction: 0.6 }) measures a different (narrower) width than the 0.5 default', () => {
    // Not asserting a specific direction/magnitude -- just that the
    // parameter actually takes effect, since 0.6 vs 0.5 changes *where* on
    // the flank the crossing is measured.
    const at50 = estimatePeakFromRegion(edges, bridgeCounts, regions.g1, { label: 'G1', heightFraction: 0.5 });
    const at60 = estimatePeakFromRegion(edges, bridgeCounts, regions.g1, { label: 'G1', heightFraction: 0.6 });
    return { pass: at50.sigma !== at60.sigma, detail: JSON.stringify({ at50: at50.sigma, at60: at60.sigma }) };
  });

  return results;
}"""


def run_cell_cycle_watson_pragmatic_tests(ctx: TestContext):
    """Run models/watson_pragmatic.js assertions."""

    try:
        all_results = ctx.page.evaluate(_WATSON_TESTS)
    except Exception as err:
        ctx.check(
            GROUP,
            "cell-cycle watson-pragmatic suite setup",
            False,
            str(err),
            screenshot=False,
        )
        return

    for item in all_results:
        ctx.check(
            GROUP,
            item["name"],
            item["pass"],
            item.get("detail", ""),
            screenshot=False,
        )
