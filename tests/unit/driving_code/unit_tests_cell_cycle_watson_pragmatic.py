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
    // SCI-01 box 9: the residual left over in a genuinely bridge-free sample is
    // numerical leakage from imperfect closed-form peak recovery, not S phase.
    // The previous 2% bound (220 events for these peaks) would have silently
    // accepted an implausibly large ~145-event "S" signal in a sample with no
    // bridge. The real leakage here is ~36 events (0.33% of the biological mass),
    // so we hold it below 0.6% of the biological peak mass (~66 events): tight
    // enough to reject 145, with ~1.8x margin over the true leakage.
    const biological = TRUE_CLEAN.g1Area + TRUE_CLEAN.g2Area;
    const sTotal = cleanFitted.components.find((c) => c.id === 's').observedDomainArea;
    const pass = sTotal < 0.006 * biological && sTotal < 145;
    return { pass, detail: JSON.stringify({ sTotal, boundEvents: 0.006 * biological }) };
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
    pass: bridgeFitted.converged === false
      && bridgeFitted.decompositionCompleted === true
      && bridgeFitted.convergenceReason === 'not_applicable_closed_form',
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

  run('watson_pragmatic (SCI-01) quantitatively recovers a planted bridge S area within 5%', () => {
    // SCI-01 box 8: assert QUANTITATIVE recovery of a known planted S area, not
    // just "clearly nonzero." The bridge adds BRIDGE_HEIGHT counts to every bin
    // whose center is in [BRIDGE_START, BRIDGE_END); the planted S event count is
    // therefore height x (number of those bins) = height x width / binWidth. The
    // bridge [85,125] lies entirely inside the fitted-center interval (mu_G1~70,
    // mu_G2~140), and the asymmetric area windows exclude it, so recovery should
    // be near-exact. Tolerance 5% covers small peak-flank residual between the
    // means outside the bridge plus discretization (observed ~0.5% over).
    const binWidth = edges[1] - edges[0];
    const trueSEvents = BRIDGE_HEIGHT * (BRIDGE_END - BRIDGE_START) / binWidth;
    const sTotal = bridgeFitted.components.find((c) => c.id === 's').observedDomainArea;
    const pass = relClose(sTotal, trueSEvents, 0.05);
    return { pass, detail: JSON.stringify({ sTotal, trueSEvents, relError: (sTotal - trueSEvents) / trueSEvents }) };
  });

  run('watson_pragmatic phase fractions are finite, nonnegative, sum to 1, and G1 is the largest (SCI-01 box 10)', () => {
    const { g1, s, g2 } = bridgeFitted.phaseFractions;
    const finiteNonneg = [g1, s, g2].every((f) => Number.isFinite(f) && f >= 0);
    const pass = finiteNonneg && close(g1 + s + g2, 1, 1e-6) && g1 > s && g1 > g2;
    return { pass, detail: JSON.stringify(bridgeFitted.phaseFractions) };
  });

  run('watson_pragmatic result is never AIC/BIC-comparable: kind is "decomposition" and comparisonGroup is null (M5 exit gate)', () => ({
    pass: bridgeFitted.kind === 'decomposition' && bridgeFitted.comparisonGroup === null,
    detail: JSON.stringify({ kind: bridgeFitted.kind, comparisonGroup: bridgeFitted.comparisonGroup }),
  }));

  run('watson_pragmatic.expectedCounts() is not implemented (S is observed-data-dependent, not parameter-only), matching the retired legacy bridge’s documented precedent', () => ({
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

  // ---- SCI-01 regression: sub-G1 debris and post-G2 aggregate must NOT become S ----
  // Same clean G1/G2 peaks, plus a large sub-G1 debris blob (below the G1
  // center) and a post-G2 aggregate blob (above the G2 center). Residual S is
  // defined only strictly between the two fitted peak centers, so neither blob
  // may inflate %S. Before the fix S was summed over the whole domain, so both
  // blobs -- wherever they overshot the fitted peaks -- were counted as S phase.
  const DEBRIS_HEIGHT = 40, DEBRIS_START = 10, DEBRIS_END = 45;   // centers below regions.g1.left (55)
  const AGG_HEIGHT = 15, AGG_START = 180, AGG_END = 220;          // centers above regions.g2.right (165)
  const contamPeaks = peakComponents(edges, TRUE_CLEAN);
  const contamCounts = contamPeaks.g1.map((v, i) => {
    const center = 0.5 * (edges[i] + edges[i + 1]);
    const debris = center >= DEBRIS_START && center < DEBRIS_END ? DEBRIS_HEIGHT : 0;
    const aggregate = center >= AGG_START && center < AGG_END ? AGG_HEIGHT : 0;
    return Math.round(v + contamPeaks.g2[i] + debris + aggregate);
  });
  const contamRaw = watson.fit({ histogram: { edges, counts: contamCounts }, peakRegions: regions, config: {} });
  const contamFitted = watson.normalizeResult(contamRaw);

  run('watson_pragmatic (SCI-01) keeps residual S near zero despite strong sub-G1 debris and post-G2 aggregate', () => {
    const sTotal = contamFitted.components.find((c) => c.id === 's').observedDomainArea;
    // The blobs carry thousands of events; before SCI-01 they landed in S. S
    // must instead stay at the clean-case level (< 5% of the biological peaks).
    const pass = sTotal < 0.05 * (TRUE_CLEAN.g1Area + TRUE_CLEAN.g2Area);
    return { pass, detail: JSON.stringify({ sTotal, biological: TRUE_CLEAN.g1Area + TRUE_CLEAN.g2Area }) };
  });

  run('watson_pragmatic (SCI-01) every nonzero residual S bin lies strictly between the fitted peak centers', () => {
    const sCounts = contamFitted.components.find((c) => c.id === 's').counts;
    const { g1Mean, g2Mean } = contamFitted.parameters;
    let outsideNonzero = 0;
    for (let i = 0; i < sCounts.length; i += 1) {
      const center = 0.5 * (edges[i] + edges[i + 1]);
      if ((center <= g1Mean || center >= g2Mean) && sCounts[i] > 0) outsideNonzero += 1;
    }
    return { pass: outsideNonzero === 0, detail: JSON.stringify({ outsideNonzero, g1Mean, g2Mean }) };
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

  // ---- MODEL-08: integer typed-array counts must not truncate the residual S ----
  //
  // The trap: `.map()` on a typed array returns the SAME typed array type, so
  // an Int32Array of counts mapped through the Gaussian-residual arithmetic
  // (y - g1_i - g2_i, a float) writes each result back through an Int32 cast
  // and silently floors every S-phase bin. `js/analysis/math/poisson.js` had
  // exactly this bug. Nothing in the tree feeds watson_pragmatic a typed array
  // today -- dna_histogram.js builds counts with `new Array(n)`, and fit()
  // additionally normalizes with Array.from() on entry -- so this is a latent
  // trap. The point of these tests is that it STAYS closed if a future
  // performance change (PERF-01 invites precisely this) switches the histogram
  // to a typed buffer and one of those two guards is dropped.
  const typedBridgeCounts = Int32Array.from(bridgeCounts);

  run('MODEL-08: Int32Array.prototype.map really does truncate this arithmetic (the hazard is real)', () => {
    // Guards the tests below from becoming vacuous: if a future engine changed
    // TypedArray#map's return type, the two assertions after this one would
    // still pass while testing nothing. Demonstrate the truncation directly on
    // the same data the fit path handles.
    const truncated = typedBridgeCounts.map((y) => y + 0.5);
    const plain = Array.from(typedBridgeCounts, (y) => y + 0.5);
    const anyFractionalWhenTyped = Array.from(truncated).some((v) => !Number.isInteger(v));
    const anyFractionalWhenPlain = plain.some((v) => !Number.isInteger(v));
    return {
      pass: ArrayBuffer.isView(truncated) && !anyFractionalWhenTyped && anyFractionalWhenPlain,
      detail: JSON.stringify({
        mapReturnsTypedArray: ArrayBuffer.isView(truncated),
        anyFractionalWhenTyped, anyFractionalWhenPlain,
      }),
    };
  });

  run('MODEL-08: a typed-array histogram yields fractional residual S counts, not floored integers', () => {
    const typedRaw = watson.fit({
      histogram: { edges, counts: typedBridgeCounts }, peakRegions: regions, config: {},
    });
    // Every nonzero S bin is `y - g1_i - g2_i` with two Gaussian bin masses
    // subtracted, so on this fixture essentially all of them are fractional.
    // Requiring MOST rather than ALL keeps the assertion about truncation
    // rather than about how many bins happen to land on a whole number.
    const nonzero = typedRaw.sCounts.filter((v) => v > 0);
    const fractional = nonzero.filter((v) => !Number.isInteger(v));
    return {
      pass: Array.isArray(typedRaw.sCounts) && nonzero.length > 10 && fractional.length > 0.9 * nonzero.length,
      detail: JSON.stringify({
        sCountsIsPlainArray: Array.isArray(typedRaw.sCounts),
        nonzero: nonzero.length, fractional: fractional.length,
      }),
    };
  });

  run('MODEL-08: typed-array and plain-Array histograms produce identical fits', () => {
    // The end-to-end property the item is really asking for: the counts
    // buffer's REPRESENTATION must not change the science. Compares the whole
    // normalized result, so a truncation anywhere in the path -- not only the
    // one line the fix touched -- shows up here.
    const typedFitted = watson.normalizeResult(watson.fit({
      histogram: { edges, counts: typedBridgeCounts }, peakRegions: regions, config: {},
    }));
    const same = JSON.stringify(typedFitted.phaseFractions) === JSON.stringify(bridgeFitted.phaseFractions)
      && JSON.stringify(typedFitted.parameters) === JSON.stringify(bridgeFitted.parameters);
    return {
      pass: same,
      detail: JSON.stringify({
        typed: { fractions: typedFitted.phaseFractions, parameters: typedFitted.parameters },
        plain: { fractions: bridgeFitted.phaseFractions, parameters: bridgeFitted.parameters },
      }),
    };
  });

  // ---- MODEL-06: a background pedestal must not be scaled up into peak area ----
  //
  // refine_local_area() estimates N by dividing summed counts by summed
  // template mass over the asymmetric window. That ratio has no notion of a
  // floor, so every background count inside the window is divided by the same
  // (sub-unity) template mass and re-reported as peak area. G2 is hit hardest:
  // its window is wide relative to its area, so the inflation is multiplied.
  //
  // The fix reads the floor at the CLEAN window edge -- 3 sigma out, and
  // clamped to the histogram rather than to the region, so the region invariant
  // is untouched -- and discounts the peak's own Gaussian tail before calling
  // what is left background. Two alternatives were measured and rejected; the
  // tests below pin both the win and the rejections, because a future
  // "simplification" back to either one would otherwise look harmless.
  const BG_LEVELS = [0, 1, 3, 8];
  const bgCounts = (level) => bridgePeaks.g1.map((v, i) => {
    const center = 0.5 * (edges[i] + edges[i + 1]);
    const bridge = center >= BRIDGE_START && center < BRIDGE_END ? BRIDGE_HEIGHT : 0;
    return Math.round(v + bridgePeaks.g2[i] + bridge + level);
  });

  // Re-implements refine_local_area() over a fit's OWN reported window, mean and
  // sigma, so the only thing that differs between the variants below is the
  // baseline rule. Everything else -- peak location, width, window geometry --
  // is taken from the real fit.
  const { gaussianBinMass } = window.CellCycleGaussianBinMass;
  const areaWithBaseline = (counts, win, mean, sigma, baseline) => {
    const template = gaussianBinMass(edges, 1, mean, sigma);
    let observed = 0;
    let mass = 0;
    for (let i = win.start; i <= win.end; i += 1) {
      observed += Math.max(0, counts[i] - baseline);
      mass += template[i];
    }
    return mass > 0 ? Math.max(0, observed / mass) : 0;
  };
  const rawFloorAt = (counts, index) => {
    let floor = Infinity;
    for (let i = Math.max(0, index - 2); i <= Math.min(counts.length - 1, index + 2); i += 1) {
      floor = Math.min(floor, counts[i]);
    }
    return floor > 0 ? floor : 0;
  };

  const bgFits = BG_LEVELS.map((level) => {
    const counts = bgCounts(level);
    const raw = watson.fit({ histogram: { edges, counts }, peakRegions: regions, config: {} });
    return {
      level,
      counts,
      raw,
      g1: raw.g1.area,
      g2: raw.g2.area,
      // The frozen pre-MODEL-06 estimator: identical in every respect except
      // that it subtracts nothing.
      preG1: areaWithBaseline(counts, raw.g1.window, raw.g1.mean, raw.g1.sigma, 0),
      preG2: areaWithBaseline(counts, raw.g2.window, raw.g2.mean, raw.g2.sigma, 0),
      // The rule originally proposed for this item: read the floor at the
      // CONTAMINATED window edge (G1's right, G2's left).
      rejG1: areaWithBaseline(counts, raw.g1.window, raw.g1.mean, raw.g1.sigma, rawFloorAt(counts, raw.g1.window.end)),
      rejG2: areaWithBaseline(counts, raw.g2.window, raw.g2.mean, raw.g2.sigma, rawFloorAt(counts, raw.g2.window.start)),
    };
  });
  const errPct = (value, truth) => 100 * (value - truth) / truth;
  const spread = (values) => Math.max(...values) - Math.min(...values);

  run('MODEL-06: the hazard is real -- without a pedestal, a flat background inflates N_G2 by tens of percent', () => {
    // Guards every assertion below from becoming vacuous. If a future change
    // made the ratio estimator background-insensitive by some other route,
    // "the fix helps" would still pass while testing nothing, so demonstrate
    // the inflation directly on the frozen pre-fix estimator.
    const errors = bgFits.map((f) => errPct(f.preG2, TRUE_BRIDGE.g2Area));
    return {
      pass: Math.abs(errors[0]) < 1 && errors[errors.length - 1] > 50,
      detail: JSON.stringify({ backgrounds: BG_LEVELS, preFixG2ErrorPct: errors }),
    };
  });

  run('MODEL-06: subtracting the pedestal collapses N_G2 background sensitivity by at least 5x', () => {
    // The headline of the item. Not "N_G2 is now correct" -- S-phase mass
    // genuinely inside the window is not background and no flat subtraction can
    // remove it -- but "N_G2 no longer tracks the background level".
    const preSpread = spread(bgFits.map((f) => errPct(f.preG2, TRUE_BRIDGE.g2Area)));
    const fixSpread = spread(bgFits.map((f) => errPct(f.g2, TRUE_BRIDGE.g2Area)));
    return {
      pass: fixSpread * 5 < preSpread,
      detail: JSON.stringify({
        preFixSpreadPct: preSpread, fixedSpreadPct: fixSpread, ratio: preSpread / fixSpread,
        fixedG2ErrorPct: bgFits.map((f) => errPct(f.g2, TRUE_BRIDGE.g2Area)),
      }),
    };
  });

  run('MODEL-06: with no background the pedestal is exactly zero and the estimator is unchanged', () => {
    // The correction must be inert where there is nothing to correct. This is
    // what separates the landed rule from the simpler "read the raw floor at
    // the clean edge": at 3 sigma a Gaussian is still at ~1.1% of peak height,
    // so reading the raw floor there subtracts the peak's own tail and biases
    // a perfectly clean histogram low. Discounting the tail first makes the
    // zero-background case bit-for-bit identical to the pre-fix estimator.
    const clean = bgFits[0];
    const pass = clean.raw.g1.pedestal === 0 && clean.raw.g2.pedestal === 0
      && clean.g1 === clean.preG1 && clean.g2 === clean.preG2;
    return {
      pass,
      detail: JSON.stringify({
        g1Pedestal: clean.raw.g1.pedestal, g2Pedestal: clean.raw.g2.pedestal,
        fixed: { g1: clean.g1, g2: clean.g2 }, preFix: { g1: clean.preG1, g2: clean.preG2 },
      }),
    };
  });

  run('MODEL-06: the pedestal never exceeds the background actually present, so it under-subtracts rather than eating the peak', () => {
    // The tail discount uses the UN-subtracted area, which is itself
    // background-inflated, so the tail is over-estimated and the pedestal comes
    // out low by construction. Asserting that direction is what keeps the
    // failure mode benign: too little correction, never too much.
    const violations = bgFits.filter((f) => f.raw.g1.pedestal > f.level + 1e-9 || f.raw.g2.pedestal > f.level + 1e-9);
    return {
      pass: violations.length === 0,
      detail: JSON.stringify(bgFits.map((f) => ({
        background: f.level, g1Pedestal: f.raw.g1.pedestal, g2Pedestal: f.raw.g2.pedestal,
      }))),
    };
  });

  run('MODEL-06: reading the pedestal at the CONTAMINATED window edge (the originally proposed rule) destroys both areas', () => {
    // contaminatedWindowSigmas is 1, where a Gaussian is still at 61% of peak
    // height, so that floor is mostly peak. Subtracting it removes most of the
    // signal: measured -61% to -74% on every background here. Recorded as a
    // test so the "obvious" symmetric version of this fix is not re-attempted.
    const g1Errors = bgFits.map((f) => errPct(f.rejG1, TRUE_BRIDGE.g1Area));
    const g2Errors = bgFits.map((f) => errPct(f.rejG2, TRUE_BRIDGE.g2Area));
    return {
      pass: g1Errors.every((e) => e < -50) && g2Errors.every((e) => e < -50),
      detail: JSON.stringify({ contaminatedEdgeG1ErrorPct: g1Errors, contaminatedEdgeG2ErrorPct: g2Errors }),
    };
  });

  run('MODEL-06: the pedestal is region-independent -- %S stays within 1.5pp across tight/default/wide regions under background', () => {
    // The reason MODEL-05's pedestalUnderPeak() could not simply be reused: it
    // returns 0 when its sample point falls outside the user's REGION, which
    // makes the subtraction -- and therefore the phase fractions -- a function
    // of how wide the handle was dragged. A peak region bounds the mean and
    // nothing else. The window used here is clamped to the histogram, so the
    // invariant holds; at 8/bin the pre-fix estimator actually breaches it
    // (2.02pp) and the fix brings it back inside (1.17pp).
    const variants = {
      tight: { g1: { left: 62, right: 78 }, g2: { left: 128, right: 152 } },
      default: regions,
      wide: { g1: { left: 48, right: 92 }, g2: { left: 105, right: 175 } },
    };
    const counts = bgCounts(8);
    const percentS = Object.values(variants).map((peakRegions) => {
      const fitted = watson.normalizeResult(watson.fit({ histogram: { edges, counts }, peakRegions, config: {} }));
      return 100 * fitted.phaseFractions.s;
    });
    const observed = spread(percentS);
    return {
      pass: observed < 1.5,
      detail: JSON.stringify({ percentS, spreadPp: observed, tolerancePp: 1.5 }),
    };
  });

  run('MODEL-06: the subtracted pedestal is reported in diagnostics, so the correction is auditable', () => {
    const fitted = watson.normalizeResult(bgFits[3].raw);
    const { g1Pedestal, g2Pedestal } = fitted.diagnostics;
    const pass = Number.isFinite(g1Pedestal) && Number.isFinite(g2Pedestal)
      && g1Pedestal > 0 && g2Pedestal > 0;
    return { pass, detail: JSON.stringify({ g1Pedestal, g2Pedestal }) };
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
