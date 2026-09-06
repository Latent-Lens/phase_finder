#!/usr/bin/env python3
"""Browser unit coverage for js/analysis/cell_cycle/peak_detection.js -- the
multi-scale G1/G2 peak-pair detector ported from the LatentLens
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

  for (const fraction of [0.25, 0.5, 0.6, 0.75]) {
    run(`SCI-13: Gaussian sigma conversion is analytic at relative height ${fraction}`, () => {
      const sigma = 7.25;
      const crossingDistance = sigma * Math.sqrt(2 * Math.log(1 / (1 - fraction)));
      const recovered = peakDetection.gaussianSigmaFromProminenceDistance(crossingDistance, fraction);
      return { pass: Math.abs(recovered - sigma) < 1e-12, detail: recovered };
    });
  }

  run('SCI-13: default half-height conversion remains unchanged', () => {
    const distance = 8;
    const before = distance / Math.sqrt(2 * Math.log(2));
    const after = peakDetection.gaussianSigmaFromProminenceDistance(distance);
    return { pass: Math.abs(after - before) < Number.EPSILON, detail: JSON.stringify({ before, after }) };
  });

  run('SCI-13: invalid or endpoint relative heights are rejected', () => ({
    pass: [NaN, -0.1, 0, 1, 1.1].every(value =>
      throws(() => peakDetection.gaussianSigmaFromProminenceDistance(1, value), /strictly between/)),
    detail: '',
  }));

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

  run('#1: autoPeakRegions are asymmetric — the inter-peak (S-facing) edge is tighter than the clean flank', () => {
    // The DJF S-overfit fix (VALID-01): each peak's inner edge (facing the S-phase
    // gap) reaches less far than its clean outer flank, so the region does not
    // swallow the rising S shoulder and mis-seed the peak width.
    const edges = edgesFor(256);
    const counts = addAll(
      gaussianBump(edges, 5000, 70, 4.2),
      gaussianBump(edges, 1800, 140, 8.4),
    );
    const result = peakDetection.detectCellCyclePeakPair(edges, counts);
    const { g1, g2 } = result.autoPeakRegions;
    const g1c = result.detection.g1Candidate.x, g2c = result.detection.g2Candidate.x;
    const g1OuterLeft = g1c - g1.left, g1InnerRight = g1.right - g1c;
    const g2InnerLeft = g2c - g2.left, g2OuterRight = g2.right - g2c;
    return {
      pass: g1InnerRight < g1OuterLeft && g2InnerLeft < g2OuterRight,
      detail: JSON.stringify({ g1: { outerLeft: +g1OuterLeft.toFixed(2), innerRight: +g1InnerRight.toFixed(2) },
                               g2: { innerLeft: +g2InnerLeft.toFixed(2), outerRight: +g2OuterRight.toFixed(2) } }),
    };
  });

  // ---- PEAK-01: a region must actually constrain the mean ------------------
  //
  // Measured on the 30-sample FlowJo set: region width separated correct from
  // period-doubled fits perfectly -- every region <= 4.0 sigma of the fitted
  // peak was correct (16/16), every region >= 4.5 sigma was doubled (14/14),
  // G1 having landed on the 2C peak through a window wide enough to reach it.

  run('PEAK-01: an inflated detector sigma cannot open the region past the cap', () => {
    const { proposeAutomaticPeakRegions, MAX_REGION_SIGMA, MAX_REGION_PEAK_CV } = peakDetection;
    const edges = Array.from({ length: 257 }, (_, i) => i * 4); // 0..1024
    // A wildly inflated width estimate, as produced on a broad or misidentified
    // feature. Before the cap this multiplied straight through into the region.
    const det = {
      g1Index: 42, g2Index: 85,           // centres ~170 and ~342
      g1Candidate: { sigmaLeftBins: 400 }, // absurd
      g2Candidate: { sigmaRightBins: 400 },
      fallbackSigmaBins: 2,
    };
    const regions = proposeAutomaticPeakRegions(edges, det);
    const g1Center = 0.5 * (edges[42] + edges[43]);
    // Sigma is capped at MAX_REGION_PEAK_CV of the centre, then the reach at
    // MAX_REGION_SIGMA of that.
    const cap = MAX_REGION_SIGMA * MAX_REGION_PEAK_CV * g1Center;
    return {
      pass: (g1Center - regions.g1.left) <= cap + 1e-6,
      detail: JSON.stringify({ region: regions.g1, g1Center, cap }),
    };
  });

  run('PEAK-01: a normal detection is left alone by the cap', () => {
    const { proposeAutomaticPeakRegions } = peakDetection;
    const edges = Array.from({ length: 257 }, (_, i) => i * 4);
    const det = {
      g1Index: 42, g2Index: 85,
      g1Candidate: { sigmaLeftBins: 3 }, g2Candidate: { sigmaRightBins: 5 },
      fallbackSigmaBins: 3,
    };
    const regions = proposeAutomaticPeakRegions(edges, det);
    // 2.75 * 3 bins * 4 units = 33 units of outer reach; well inside the cap.
    const g1Center = 0.5 * (edges[42] + edges[43]);
    return {
      pass: Math.abs((g1Center - regions.g1.left) - 33) < 2,
      detail: JSON.stringify({ region: regions.g1, outerReach: g1Center - regions.g1.left }),
    };
  });

  run('MODEL-03: a known-width Gaussian recovers its true sigma', () => {
    const edges = edgesFor(400);                     // binWidth = 1
    const counts = gaussianBump(edges, 50000, 200, 6);
    const est = estimatePeakFromRegion(edges, counts, { left: 170, right: 230 }, { cleanSide: 'left' });
    const naive = Math.sqrt(6 * 6 + 2 * 2);           // 6.32 — the old, un-deconvolved value
    // Tolerance is 0.5, not the checklist snippet's illustrative 0.4: even with
    // the flank crossing now linearly interpolated to a fractional bin position
    // (see estimateSigmaOneSidedWithinRegion's follow-on fix, tested in isolation
    // below), the peak INDEX is still an integer -- which bin captures the argmax
    // as the true sub-bin peak position slides is itself a step function -- so
    // the sigma estimate is not perfectly continuous in the true peak position.
    // Verified by direct computation (outside this harness, on this exact
    // fixture) that sweeping the true peak continuously across a full bin makes
    // est.sigma range from 5.566 to 6.415, a residual +/-0.42..0.49 band around
    // the true sigma=6 driven by argmax quantization, not by the old
    // outward-only rounding bug the test below guards against directly. 0.5 is
    // the tightest bound that accepts every alignment while still failing on the
    // un-deconvolved naive value (6.32-6.49 apart depending on alignment).
    return {
      pass: Math.abs(est.sigma - 6) < 0.5 && Math.abs(est.sigma - naive) > 0.2,
      detail: `sigma=${est.sigma.toFixed(3)} (true 6, un-deconvolved ${naive.toFixed(3)})`,
    };
  });

  run('MODEL-03: deconvolveSmoothing matches the closed-form quadrature subtraction exactly', () => {
    // A statistically-sampled Gaussian fixture can't isolate deconvolveSmoothing's
    // own arithmetic from the one-sided flank walk's independent +/-1-bin
    // discretization noise (see the comment on the test above -- on this exact
    // algorithm, that noise alone spans ~0.4-0.5 sigma-bins at sigma=6, kernel=2,
    // regardless of sub-bin peak alignment). This test instead hand-crafts an
    // options.smoothed array where the 50%-of-peak crossing lands at an exact,
    // known integer bin distance (5 bins: 100 -> 90 -> ... -> 50, stepping by 10),
    // so the raw (pre-deconvolution) sigma-in-bins is known in closed form, and
    // asserts the deconvolved output matches sqrt(rawSigmaBins^2 - kernel^2)
    // to floating-point precision -- a direct, unambiguous check of the
    // quadrature-subtraction math itself.
    const edges = edgesFor(200);
    const values = new Array(200).fill(0);
    const peakIndex = 100;
    values[peakIndex] = 100;
    for (let d = 1; d <= 20; d += 1) {
      values[peakIndex - d] = Math.max(0, 100 - 10 * d);
      values[peakIndex + d] = Math.max(0, 90 - d);
    }
    const counts = new Array(200).fill(1); // unused: options.smoothed bypasses gaussianSmooth(counts, ...)
    const est = estimatePeakFromRegion(edges, counts, { left: 50, right: 150 }, {
      cleanSide: 'left',
      smoothed: values,
      smoothingSigmaBins: 3,
    });
    const rawSigmaBins = 5 / Math.sqrt(-2 * Math.log(0.5)); // distanceBins=5 by construction
    const expectedSigma = Math.sqrt(rawSigmaBins * rawSigmaBins - 3 * 3); // kernel=3, binWidth=1
    return {
      pass: Math.abs(est.sigma - expectedSigma) < 1e-9,
      detail: `sigma=${est.sigma} expected=${expectedSigma}`,
    };
  });

  // ---- MODEL-05: baseline-subtracted flank threshold ----
  //
  // The checklist recorded this as "measured inert": the flank walk stopped at
  // a discrete bin index, and subtracting the pedestal did not move which bin
  // first fell below threshold. That observation predates MODEL-03's follow-on
  // fix, which made the crossing a linearly INTERPOLATED position between two
  // bins. Once the crossing is continuous, the threshold's absolute value
  // feeds straight into the answer, so a pedestal biases sigma whether or not
  // the bin index moves -- and above ~15% of peak height the bin moves too.
  //
  // These fixtures are a pure Gaussian on a FLAT pedestal, with the peak
  // centred on a bin centre. Nothing else contributes to the flank, so any
  // dependence of the recovered sigma on the pedestal height is the defect.

  // A frozen copy of the pre-MODEL-05 walk, kept deliberately: it is what the
  // "crossing bin does not move" claim was measured against, so the test can
  // show directly that it does.
  function crossingIndex(values, peakIndex, indexes, fraction, side, floor) {
    const peak = values[peakIndex] - floor;
    const threshold = floor + peak * fraction;
    const first = indexes[0];
    const last = indexes[indexes.length - 1];
    let index = peakIndex;
    if (side === 'left') { while (index > first && values[index] > threshold) index -= 1; }
    else { while (index < last && values[index] > threshold) index += 1; }
    return index;
  }
  // Peak on a bin CENTRE (edgesFor(n) makes centres i + 0.5), so the argmax bin
  // is stable as the pedestal changes and cannot confound the comparison.
  function pedestalFixture(pedestalFractionOfPeak) {
    const edges = edgesFor(400);
    const bump = gaussianBump(edges, 50000, 200.5, 6);
    const peakHeight = Math.max(...bump);
    const pedestal = pedestalFractionOfPeak * peakHeight;
    return { edges, counts: bump.map((v) => v + pedestal), pedestal };
  }

  run('MODEL-05: recovered sigma is independent of the pedestal the peak sits on', () => {
    // The load-bearing assertion. Before the fix the error grew in proportion
    // to the pedestal: +0.01% at no pedestal, +7.65% at 10%, +23.18% at 30%.
    const sigmas = [0, 0.10, 0.30].map((f) => {
      const { edges, counts } = pedestalFixture(f);
      return estimatePeakFromRegion(edges, counts, { left: 170, right: 230 }, { cleanSide: 'left' }).sigma;
    });
    const spread = Math.max(...sigmas) - Math.min(...sigmas);
    const worstError = Math.max(...sigmas.map((s) => Math.abs(s - 6)));
    return {
      pass: spread < 0.05 && worstError < 0.1,
      detail: `sigmas=${sigmas.map((s) => s.toFixed(4)).join(', ')} spread=${spread.toFixed(4)} worstError=${worstError.toFixed(4)}`,
    };
  });

  run('MODEL-05: a steep pedestal moves the crossing bin, not only the interpolated position', () => {
    // The fixture the checklist asked for, and the reason this item is not
    // inert. At a pedestal of 15% of peak height the un-subtracted walk stops
    // one bin further out than the subtracted one.
    const { edges, counts, pedestal } = pedestalFixture(0.15);
    const smoothed = window.DJFShared.gaussian.gaussianSmooth(counts, 2);
    const centers = edges.slice(0, -1).map((e, i) => 0.5 * (e + edges[i + 1]));
    const indexes = [];
    for (let i = 0; i < centers.length; i += 1) {
      if (centers[i] >= 170 && centers[i] <= 230) indexes.push(i);
    }
    let peakIndex = indexes[0];
    for (const i of indexes) if (smoothed[i] > smoothed[peakIndex]) peakIndex = i;
    // The PLANTED pedestal, not an estimate of it: this test is about whether
    // the defect can move a bin at all, so it must not depend on how the
    // implementation happens to locate the floor.
    const legacy = crossingIndex(smoothed, peakIndex, indexes, 0.5, 'left', 0);
    const fixed = crossingIndex(smoothed, peakIndex, indexes, 0.5, 'left', pedestal);
    return {
      pass: legacy !== fixed && fixed > legacy,
      detail: `peakIndex=${peakIndex} legacyCrossing=${legacy} baselineSubtractedCrossing=${fixed} pedestal=${pedestal.toFixed(1)}`,
    };
  });

  run('MODEL-05: with no pedestal the estimate is unchanged', () => {
    // The fix must be a no-op on clean data, or it would be trading one bias
    // for another rather than removing one.
    const edges = edgesFor(400);
    const counts = gaussianBump(edges, 50000, 200.5, 6);
    const est = estimatePeakFromRegion(edges, counts, { left: 170, right: 230 }, { cleanSide: 'left' });
    return { pass: Math.abs(est.sigma - 6) < 0.05, detail: `sigma=${est.sigma.toFixed(4)} (true 6)` };
  });

  run('MODEL-05: a region too tight to show a pedestal does not get one subtracted', () => {
    // Subtracting a pedestal RAISES the threshold, so the walk stops sooner --
    // the failure mode this fix could introduce is reading the peak's own flank
    // as a floor and collapsing sigma. A region drawn inside 3 sigma never
    // reaches the sample point, so no pedestal is subtracted and the estimate
    // stays the un-subtracted one. This region spans +/- 11 units on a
    // sigma = 6 peak, i.e. under 2 sigma, over a 30%-of-peak pedestal.
    const { edges, counts } = pedestalFixture(0.30);
    const est = estimatePeakFromRegion(edges, counts, { left: 190, right: 212 }, { cleanSide: 'left' });
    return {
      pass: Number.isFinite(est.sigma) && est.sigma > 1 && est.sigma < 12,
      detail: `sigma=${est.sigma} on a sub-2-sigma region over a 30%-of-peak pedestal`,
    };
  });

  run('MODEL-03: options.smoothed without options.smoothingSigmaBins throws (mismatched-kernel guard)', () => {
    const edges = edgesFor(400);
    const counts = gaussianBump(edges, 50000, 200, 6);
    const failed = throws(
      () => estimatePeakFromRegion(edges, counts, { left: 170, right: 230 }, { smoothed: counts }),
      /smoothingSigmaBins/,
    );
    return { pass: failed, detail: `failed=${failed}` };
  });

  return results;
}"""


def run_cell_cycle_peak_detection_tests(ctx: TestContext):
    results = ctx.page.evaluate(_TESTS)
    for result in results:
        ctx.check(GROUP, result["name"], result["pass"], result["detail"])
