#!/usr/bin/env python3
"""Browser unit coverage for js/analysis/qc/time_qc_diagnostic_plot.js -- the
Phase 2 acquisition-order diagnostic for peak-tracking Time QC.

These test the pure model builder (channel discovery, per-segment layout along
one global bin axis, rejected-bin span merging, imputed marking, and channel
filtering) plus that the SVG renderer emits the expected layers. They use small
hand-built Stage-1-shaped results rather than a full QC run, so the layout maths
is checked directly and deterministically.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / Time QC Diagnostic Plot"


_DIAGNOSTIC_TESTS = r"""() => {
  const {
    timeQcDiagnosticChannels, timeQcDiagnosticAvailable,
    buildTimeQcDiagnosticModel, renderTimeQcDiagnosticSvg,
  } = window.TimeQCDiagnosticPlot;

  const results = [];
  const push = (name, pass, detail = '') => results.push({ name, pass: Boolean(pass), detail: String(detail ?? '') });
  const run = (name, test) => {
    try {
      const outcome = test();
      push(name, outcome.pass, outcome.detail);
    } catch (error) {
      push(name, false, `${error.name}: ${error.message}`);
    }
  };

  // Two acquisition segments. Segment 0: 4 bins, one DNA-A track (bin 2 imputed)
  // and one FSC-A track; bin 3 rejected. Segment 1: 3 bins, one DNA-A track; no
  // rejected bins. goodBinMask uses 1=good, 0=rejected.
  const result = {
    method: 'peak-tracking',
    skipped: false,
    segmentResults: [
      {
        segmentId: 0,
        binCount: 4,
        goodBinMask: Uint8Array.from([1, 1, 1, 0]),
        peakColumns: [
          [100, 101, 100, 102],   // DNA-A track
          [40, 41, 40, 42],       // FSC-A track
        ],
        peakMetadata: [
          { channel: 'DNA_A', trackIndex: 0, label: 'DNA_A peak 1', imputed: [false, false, true, false], missingReasons: [null, null, 'peak-not-detected', null] },
          { channel: 'FSC_A', trackIndex: 0, label: 'FSC_A peak 1', imputed: [false, false, false, false] },
        ],
      },
      {
        segmentId: 1,
        binCount: 3,
        goodBinMask: Uint8Array.from([1, 1, 1]),
        peakColumns: [[103, 104, 103]],
        peakMetadata: [
          { channel: 'DNA_A', trackIndex: 0, label: 'DNA_A peak 1', imputed: [false, false, false] },
        ],
      },
    ],
  };

  run('timeQcDiagnosticChannels lists each channel once, first-seen order', () => {
    const channels = timeQcDiagnosticChannels(result);
    return { pass: JSON.stringify(channels) === JSON.stringify(['DNA_A', 'FSC_A']), detail: JSON.stringify(channels) };
  });

  run('timeQcDiagnosticAvailable is true for a peak-tracking result with tracks', () => ({
    pass: timeQcDiagnosticAvailable(result) === true, detail: '',
  }));

  run('timeQcDiagnosticAvailable is false for a robust-summary result', () => ({
    pass: timeQcDiagnosticAvailable({ method: 'robust-summary', segmentResults: [] }) === false, detail: '',
  }));

  run('timeQcDiagnosticAvailable is false for a skipped result', () => ({
    pass: timeQcDiagnosticAvailable({ ...result, skipped: true }) === false, detail: '',
  }));

  run('buildTimeQcDiagnosticModel defaults to the first channel and totals bins across segments', () => {
    const model = buildTimeQcDiagnosticModel(result);
    return { pass: model.activeChannel === 'DNA_A' && model.totalBins === 7 && model.hasData === true, detail: JSON.stringify({ activeChannel: model.activeChannel, totalBins: model.totalBins }) };
  });

  run('buildTimeQcDiagnosticModel lays segments end to end (segment 1 starts at bin 4)', () => {
    const model = buildTimeQcDiagnosticModel(result);
    const starts = model.segments.map((s) => s.xStart);
    // Track x-coordinates are global: segment 1's first DNA point is at x=4.
    const seg1FirstX = model.segments[1].tracks[0].points[0].x;
    return { pass: JSON.stringify(starts) === JSON.stringify([0, 4]) && seg1FirstX === 4, detail: JSON.stringify({ starts, seg1FirstX }) };
  });

  run('buildTimeQcDiagnosticModel filters tracks to the active channel', () => {
    const dna = buildTimeQcDiagnosticModel(result, { channel: 'DNA_A' });
    const fsc = buildTimeQcDiagnosticModel(result, { channel: 'FSC_A' });
    const dnaTrackChannels = dna.segments.flatMap((s) => s.tracks.map((t) => t.channel));
    const fscTrackChannels = fsc.segments.flatMap((s) => s.tracks.map((t) => t.channel));
    const pass = dnaTrackChannels.every((c) => c === 'DNA_A') && fscTrackChannels.every((c) => c === 'FSC_A') && fscTrackChannels.length === 1;
    return { pass, detail: JSON.stringify({ dnaTrackChannels, fscTrackChannels }) };
  });

  run('buildTimeQcDiagnosticModel merges rejected bins into spans (segment 0 bin 3)', () => {
    const model = buildTimeQcDiagnosticModel(result);
    const spans0 = model.segments[0].rejectedSpans;
    const spans1 = model.segments[1].rejectedSpans;
    return { pass: JSON.stringify(spans0) === JSON.stringify([[3, 3]]) && spans1.length === 0, detail: JSON.stringify({ spans0, spans1 }) };
  });

  run('buildTimeQcDiagnosticModel marks the imputed bin (segment 0 DNA bin 2) as imputed', () => {
    const model = buildTimeQcDiagnosticModel(result, { channel: 'DNA_A' });
    const dnaPoints = model.segments[0].tracks[0].points;
    const imputedAtBin2 = dnaPoints.find((p) => p.binIndex === 2)?.imputed;
    const othersReal = dnaPoints.filter((p) => p.binIndex !== 2).every((p) => p.imputed === false);
    return { pass: imputedAtBin2 === true && othersReal, detail: JSON.stringify(dnaPoints) };
  });

  run('buildTimeQcDiagnosticModel yExtent brackets the channel values with padding', () => {
    const model = buildTimeQcDiagnosticModel(result, { channel: 'DNA_A' });
    // DNA-A values span 100..104 across both segments.
    const [lo, hi] = model.yExtent;
    return { pass: lo < 100 && hi > 104, detail: JSON.stringify(model.yExtent) };
  });

  run('buildTimeQcDiagnosticModel returns hasData:false for an empty result', () => {
    const model = buildTimeQcDiagnosticModel({ method: 'peak-tracking', segmentResults: [] });
    return { pass: model.hasData === false && model.activeChannel === null, detail: JSON.stringify({ hasData: model.hasData, activeChannel: model.activeChannel }) };
  });

  run('renderTimeQcDiagnosticSvg emits an <svg> with a track path, a rejected-region rect, and a segment boundary line', () => {
    const svg = renderTimeQcDiagnosticSvg(buildTimeQcDiagnosticModel(result));
    const pass = svg.startsWith('<svg') && svg.includes('tqc_diag_track') && svg.includes('tqc_diag_reject') && svg.includes('tqc_diag_segment');
    return { pass, detail: svg.slice(0, 80) };
  });

  run('renderTimeQcDiagnosticSvg marks imputed bins with a hollow point element', () => {
    const svg = renderTimeQcDiagnosticSvg(buildTimeQcDiagnosticModel(result, { channel: 'DNA_A' }));
    return { pass: svg.includes('tqc_diag_imputed'), detail: '' };
  });

  run('SCI-09C: diagnostic explains imputation evidence and rejection rule', () => {
    const svg = renderTimeQcDiagnosticSvg(buildTimeQcDiagnosticModel(result));
    return {
      pass: svg.includes('Imputed peak: peak-not-detected')
        && svg.includes('Runs of 3 or more bins are rejected'),
      detail: '',
    };
  });

  return results;
}"""


def run_time_qc_diagnostic_plot_tests(ctx: TestContext):
    """Run js/analysis/qc/time_qc_diagnostic_plot.js assertions."""

    try:
        all_results = ctx.page.evaluate(_DIAGNOSTIC_TESTS)
    except Exception as err:
        ctx.check(GROUP, "time-qc diagnostic-plot suite setup", False, str(err), screenshot=False)
        return

    for item in all_results:
        ctx.check(GROUP, item["name"], item["pass"], item.get("detail", ""), screenshot=False)
