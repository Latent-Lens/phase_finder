#!/usr/bin/env python3
"""Browser unit coverage for js/analysis/cell_cycle/peak_detection.js -- the
multi-scale G1/G2 peak-pair detector ported from the MIT-licensed
cell-cycle-modeling-handoff archive. Covers the failure-mode categories the
modeling plan's test matrix (docs/cell_cycle_modeling_plan.md §11.2) calls
for: clean bimodal, sub-G1 distractor, one-bin impulse, missing G2 (inferred),
three-peak ambiguity, sparse/low-count, and input validation.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / Cell Cycle Peak Detection"


_TESTS = r"""() => {
  const peakDetection = window.CellCyclePeakDetection;
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

  // A synthetic linear histogram, built directly (not via djExpectedCounts,
  // which isn't ported yet) as a sum of Gaussian bumps over integer bin
  // edges [0, n]. Reused across scenarios below.
  function gaussianBump(edges, area, mean, sigma) {
    const counts = new Array(edges.length - 1).fill(0);
    for (let i = 0; i < counts.length; i += 1) {
      const center = 0.5 * (edges[i] + edges[i + 1]);
      const z = (center - mean) / sigma;
      counts[i] += area * Math.exp(-0.5 * z * z) / (sigma * Math.sqrt(2 * Math.PI));
    }
    return counts;
  }
  function addAll(...arrays) {
    const out = new Array(arrays[0].length).fill(0);
    for (const array of arrays) for (let i = 0; i < array.length; i += 1) out[i] += array[i];
    return out;
  }
  function edgesFor(binCount) {
    return Array.from({ length: binCount + 1 }, (_, i) => i);
  }

  run('clean bimodal histogram detects the G1/G2 pair with high confidence', () => {
    const edges = edgesFor(256);
    const counts = addAll(
      gaussianBump(edges, 5000, 70, 4.2),
      gaussianBump(edges, 1800, 140, 8.4),
    );
    const result = peakDetection.detectCellCyclePeakPair(edges, counts);
    return {
      pass: result.detection.status === 'detected'
        && result.detection.confidence >= 0.65
        && Math.abs(result.detection.selectedPair.g1.x - 70) < 3
        && Math.abs(result.detection.selectedPair.g2.x - 140) < 6
        && Math.abs(result.detection.selectedPair.ratio - 2) < 0.15,
      detail: JSON.stringify({ status: result.detection.status, confidence: result.detection.confidence, g1: result.detection.selectedPair?.g1.x, g2: result.detection.selectedPair?.g2.x }),
    };
  });

  run('a sub-G1 distractor peak does not beat the real G1/G2 pair', () => {
    const edges = edgesFor(256);
    const biological = addAll(
      gaussianBump(edges, 5000, 70, 4.2),
      gaussianBump(edges, 1800, 140, 8.4),
      // small S-phase bridge so the bridge-evidence score can favor the real pair
      gaussianBump(edges, 800, 105, 20),
    );
    const distractor = gaussianBump(edges, 1500, 35, 1);
    const counts = addAll(biological, distractor);
    const result = peakDetection.detectCellCyclePeakPair(edges, counts);
    return {
      pass: result.detection.status === 'detected'
        && Math.abs(result.detection.selectedPair.g1.x - 70) < 4
        && Math.abs(result.detection.selectedPair.g2.x - 140) < 8,
      detail: JSON.stringify({ status: result.detection.status, g1: result.detection.selectedPair?.g1.x, g2: result.detection.selectedPair?.g2.x, alternatives: result.detection.alternatives.map((p) => [p.g1.x, p.g2.x]) }),
    };
  });

  run('a one-bin impulse is downweighted and does not win a pair', () => {
    const edges = edgesFor(256);
    const counts = addAll(
      gaussianBump(edges, 5000, 70, 4.2),
      gaussianBump(edges, 1800, 140, 8.4),
    );
    // A literal one-bin spike: width inherits entirely from the smoothing
    // kernel, so its deconvolved intrinsic width should be near zero.
    counts[100] += 4000;
    const result = peakDetection.detectCellCyclePeakPair(edges, counts);
    const spikeCandidate = result.candidates.find((c) => Math.abs(c.index - 100) <= 1);
    return {
      pass: Math.abs(result.detection.selectedPair.g1.x - 70) < 4
        && Math.abs(result.detection.selectedPair.g2.x - 140) < 8
        && (!spikeCandidate || spikeCandidate.impulseSupport < 0.5),
      detail: JSON.stringify({ g1: result.detection.selectedPair?.g1.x, g2: result.detection.selectedPair?.g2.x, spikeImpulseSupport: spikeCandidate?.impulseSupport }),
    };
  });

  run('a single visible peak reports inferred_g2 with the expected reasons', () => {
    const edges = edgesFor(256);
    const counts = gaussianBump(edges, 5000, 70, 4.2);
    const result = peakDetection.detectCellCyclePeakPair(edges, counts);
    return {
      pass: result.detection.status === 'inferred_g2'
        && result.detection.selectedPair === null
        && result.detection.reasons.includes('G2_INITIALIZED_FROM_EXPECTED_RATIO')
        && Math.abs(result.detection.g2Index !== result.detection.g1Index) // has a distinct proposed g2
        && result.autoPeakRegions.g2.source === 'inferred',
      detail: JSON.stringify(result.detection),
    };
  });

  run('a three-peak x/2x/4x pattern is reported, not silently forced to one confident answer', () => {
    const edges = edgesFor(256);
    const counts = addAll(
      gaussianBump(edges, 4000, 35, 3),
      gaussianBump(edges, 3000, 70, 4.2),
      gaussianBump(edges, 1200, 140, 8.4),
    );
    const result = peakDetection.detectCellCyclePeakPair(edges, counts);
    // Both 35/70 and 70/140 are valid ~2:1 pairs; the detector should at
    // least surface more than one plausible pair rather than only ever
    // finding a single unambiguous candidate.
    return {
      pass: result.pairs.length >= 2,
      detail: JSON.stringify(result.pairs.map((p) => ({ g1: p.g1.x, g2: p.g2.x, score: p.score }))),
    };
  });

  run('a sparse/low-count histogram does not throw', () => {
    const edges = edgesFor(64);
    const counts = new Array(64).fill(0);
    // A handful of scattered single-digit counts -- no clean peaks at all.
    [10, 11, 12, 40, 41].forEach((i) => { counts[i] = 2; });
    let threw = false;
    let result = null;
    try {
      result = peakDetection.detectCellCyclePeakPair(edges, counts);
    } catch (error) {
      threw = true;
    }
    return {
      pass: !threw && result && typeof result.detection.status === 'string',
      detail: threw ? 'threw' : JSON.stringify(result.detection.status),
    };
  });

  run('mismatched edges/counts length is rejected', () => {
    const failed = throws(
      () => peakDetection.detectCellCyclePeakPair([0, 1, 2, 3], [1, 2, 3]),
      /at least 8 bins|one more entry/,
    );
    return { pass: failed, detail: `failed=${failed}` };
  });

  run('non-increasing edges are rejected', () => {
    const edges = edgesFor(16);
    edges[5] = edges[4]; // flat, not strictly increasing
    const failed = throws(
      () => peakDetection.detectCellCyclePeakPair(edges, new Array(16).fill(1)),
      /strictly increasing/,
    );
    return { pass: failed, detail: `failed=${failed}` };
  });

  run('negative counts are rejected', () => {
    const edges = edgesFor(16);
    const counts = new Array(16).fill(1);
    counts[3] = -1;
    const failed = throws(
      () => peakDetection.detectCellCyclePeakPair(edges, counts),
      /finite and nonnegative/,
    );
    return { pass: failed, detail: `failed=${failed}` };
  });

  run('autoPeakRegions are ordered, within the histogram domain, and non-overlapping', () => {
    const edges = edgesFor(256);
    const counts = addAll(
      gaussianBump(edges, 5000, 70, 4.2),
      gaussianBump(edges, 1800, 140, 8.4),
    );
    const result = peakDetection.detectCellCyclePeakPair(edges, counts);
    const { g1, g2 } = result.autoPeakRegions;
    return {
      pass: g1.left < g1.right && g2.left < g2.right
        && g1.right <= g2.left
        && g1.left >= edges[0] && g2.right <= edges[edges.length - 1],
      detail: JSON.stringify(result.autoPeakRegions),
    };
  });

  return results;
}"""


def run_cell_cycle_peak_detection_tests(ctx: TestContext):
    results = ctx.page.evaluate(_TESTS)
    for result in results:
        ctx.check(GROUP, result["name"], result["pass"], result["detail"])
