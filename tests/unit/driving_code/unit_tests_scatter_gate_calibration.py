#!/usr/bin/env python3
"""QC-05 regression coverage: pin the debris-dominant scatter-gate calibration
finding so it cannot silently regress (or silently "fix" itself without the
change being visible in test output).

gateMainBiologicalCloud() (js/analysis/gating/scatter_gmm_gate.js) selects its
"main" component primarily by population weight (`quality.weight + 1e-6 *
mean[0]`). tests/validation/validation_test_data/synthetic_fcs/
verify_qc_calibration_fixtures.mjs already exercises this against the labelled
debris_dominant_run QC-CAL-01 fixture and found the selection inverts once
debris is the majority population: the gate keeps the debris cluster and
rejects the live cells, so biological-cell recall collapses and the
false-positive rate approaches 1. That script only asserts loose bounds
(recall < 0.5, FPR > 0.5) as an inline calibration check; this test pins the
*exact* measured values against the real production module (not a
reimplementation) so any change to the selection rule -- a real fix or a
silent regression -- shows up as a failing assertion here rather than passing
unnoticed under the loose bound.

This is the QC-05 "reproduce and retain recall/contaminant-retention metrics"
sub-item. Replacing the weight-based selection rule itself is a separate,
out-of-scope sub-item (needs labelled real acquisitions, not synthetic
fixtures) and is deliberately NOT attempted here.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / QC-05 Scatter Gate Calibration"

# Measured 2026-09-05 against the real gateMainBiologicalCloud() via
# tests/validation/validation_test_data/synthetic_fcs/verify_qc_calibration_fixtures.mjs.
# The gate's GMM fit is deterministic (robust-quantile initialization, no RNG --
# see scatter_gmm_gate.js), so a given fixture always gates identically.
EXPECTED_DEBRIS_DOMINANT_RECALL = 0.05636114911080711
EXPECTED_DEBRIS_DOMINANT_FALSE_POSITIVE_RATE = 1.0

_TEST = r"""async () => {
  const CHANNEL_KEY_MAPPING = { 'DNA-A': 'DNA_A', 'DNA-H': 'DNA_H', 'DNA-W': 'DNA_W', 'FSC-A': 'FSC_A', 'SSC-A': 'SSC_A', Time: 'Time' };
  const TIME_PARAMETER_INDEX = 6; // fixed parameter order the fixture generator writes

  const buildDataset = (rows, metadata) => {
    const channels = {};
    for (const [rawName, key] of Object.entries(CHANNEL_KEY_MAPPING)) {
      channels[key] = rows.map((row) => row[rawName]);
    }
    const pnrTime = Number(metadata[`P${TIME_PARAMETER_INDEX}R`]);
    return { channels, eventCount: rows.length, pnr: { Time: pnrTime } };
  };

  const confusionRates = (mask, positiveIndices) => {
    const positiveSet = new Set(positiveIndices);
    let truePositive = 0, falseNegative = 0, falsePositive = 0, trueNegative = 0;
    for (let index = 0; index < mask.length; index += 1) {
      const flaggedAsPositive = mask[index] === 0; // rejected by the gate
      const actuallyPositive = positiveSet.has(index);
      if (actuallyPositive && flaggedAsPositive) truePositive += 1;
      else if (actuallyPositive && !flaggedAsPositive) falseNegative += 1;
      else if (!actuallyPositive && flaggedAsPositive) falsePositive += 1;
      else trueNegative += 1;
    }
    const recall = truePositive + falseNegative > 0 ? truePositive / (truePositive + falseNegative) : NaN;
    const falsePositiveRate = falsePositive + trueNegative > 0 ? falsePositive / (falsePositive + trueNegative) : NaN;
    return { recall, falsePositiveRate };
  };

  const manifest = await fetch('/tests/validation/validation_test_data/synthetic_fcs/qc_calibration/manifest.json')
    .then((response) => response.json());
  const truth = manifest.fixtures.debris_dominant_run;
  const buffer = await fetch(`/tests/validation/validation_test_data/synthetic_fcs/qc_calibration/${truth.path}`)
    .then((response) => response.arrayBuffer());

  const { rows, metadata } = window.FCSParser.parse_fcs(buffer);
  const dataset = buildDataset(rows, metadata);

  // The real production gate module, reached the same way the pipeline
  // reaches it (window.PhaseFinder.pipeline.cellGate re-exports
  // js/analysis/gating/scatter_gmm_gate.js), not a reimplementation.
  const scatterGate = window.PhaseFinder.pipeline.cellGate.gateMainBiologicalCloud(dataset);
  const debrisStats = confusionRates(scatterGate.mask, truth.debris_event_indices);

  return {
    category: truth.category,
    skipped: scatterGate.skipped ?? false,
    recall: debrisStats.recall,
    falsePositiveRate: debrisStats.falsePositiveRate,
  };
}"""


def run_scatter_gate_calibration_tests(ctx: TestContext):
    """Pin the debris-dominant scatter-gate recall/false-positive regression."""
    try:
        result = ctx.page.evaluate(_TEST)
    except Exception as err:
        ctx.check(GROUP, "QC-05 suite setup", False, str(err), screenshot=False)
        return

    ctx.check(
        GROUP,
        "QC-05: debris_dominant_run fixture loaded as the expected category",
        result["category"] == "debris_dominant",
        str(result),
        screenshot=False,
    )
    ctx.check(
        GROUP,
        "QC-05: the scatter gate runs (does not skip) on the debris-dominant fixture",
        result["skipped"] is False,
        str(result),
        screenshot=False,
    )
    ctx.check(
        GROUP,
        "QC-05: debris-dominant biological-cell recall is pinned at the measured "
        f"{EXPECTED_DEBRIS_DOMINANT_RECALL} -- weight-based main-component selection "
        "keeps inverting under a debris majority; a change here (fix or regression) "
        "must show up as a failing assertion, not pass silently",
        abs(result["recall"] - EXPECTED_DEBRIS_DOMINANT_RECALL) < 1e-9,
        str(result),
        screenshot=False,
    )
    ctx.check(
        GROUP,
        "QC-05: debris-dominant false-positive rate is pinned at the measured "
        f"{EXPECTED_DEBRIS_DOMINANT_FALSE_POSITIVE_RATE} (nearly all live cells misflagged)",
        abs(result["falsePositiveRate"] - EXPECTED_DEBRIS_DOMINANT_FALSE_POSITIVE_RATE) < 1e-9,
        str(result),
        screenshot=False,
    )
