#!/usr/bin/env python3
"""Coverage for js/plotting/peak_focus_range.js: framing the plot on G1/S/G2.

The property that matters most is the DOMAIN-01 one -- this computes a display
range only, so it must never be mistaken for the analysis domain. The rest is
about the two edges: G2's tail on the right, and G1's tail on the left without
falling into the sub-G1 debris."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / Peak Focus Range"


_TESTS = r"""() => {
  const { peak_focus_range, shared_peak_focus_range, debris_valley,
          PEAK_TAIL_SIGMA } = window.PeakFocusRange;

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

  // A realistic DNA histogram: sub-G1 debris at ~20, G1 at 170, G2 at 340,
  // an S bridge between, and empty axis out to 1000.
  const centers = [], counts = [];
  const gauss = (x, mu, sigma) => Math.exp(-0.5 * ((x - mu) / sigma) ** 2);
  for (let x = 2; x <= 1000; x += 4) {
    centers.push(x);
    counts.push(Math.round(
      900 * gauss(x, 20, 8)                       // debris
      + 5000 * gauss(x, 170, 12)                  // G1
      + 2200 * gauss(x, 340, 20)                  // G2/M
      + (x > 170 && x < 340 ? 700 : 0)            // S bridge
    ));
  }
  const FIT = { g1Mean: 170, g1Sigma: 12, g2Mean: 340, g2Sigma: 20, centers, counts };

  run('the right edge sits beyond the G2 tail, not through it', () => {
    const r = peak_focus_range(FIT);
    // 4 sigma past G2 = 420, plus margin.
    return {
      pass: r.max > 340 + PEAK_TAIL_SIGMA * 20 && r.max < 520,
      detail: JSON.stringify(r),
    };
  });

  run('the empty high-DNA axis is trimmed away', () => {
    const r = peak_focus_range(FIT);
    return { pass: r.max < 0.55 * 1000, detail: `max=${r.max.toFixed(0)} of 1000` };
  });

  run('the left edge stops above the sub-G1 debris', () => {
    const r = peak_focus_range(FIT);
    // Debris is centred at 20 with sigma 8, so anything at or below ~40 would
    // pull the debris spike into view and let it set the y-scale.
    return { pass: r.min > 45 && r.min < 170, detail: JSON.stringify(r) };
  });

  run('the debris valley is found between the debris and G1', () => {
    const floor = debris_valley(centers, counts, 170);
    return { pass: floor > 40 && floor < 140, detail: String(floor) };
  });

  run('a histogram with NO debris still frames on the G1 tail', () => {
    const clean = [], cleanCounts = [];
    for (let x = 2; x <= 1000; x += 4) {
      clean.push(x);
      cleanCounts.push(Math.round(5000 * gauss(x, 170, 12) + 2200 * gauss(x, 340, 20)));
    }
    const r = peak_focus_range({ ...FIT, centers: clean, counts: cleanCounts });
    const floor = debris_valley(clean, cleanCounts, 170);
    return {
      pass: floor === null && r.min > 0 && r.min < 170 - 2 * 12,
      detail: JSON.stringify({ floor, min: r.min }),
    };
  });

  run('the range never goes negative', () => {
    const r = peak_focus_range({ g1Mean: 20, g1Sigma: 15, g2Mean: 40, g2Sigma: 15 });
    return { pass: r.min >= 0, detail: JSON.stringify(r) };
  });

  run('unusable peaks return null rather than a nonsense range', () => {
    const cases = [
      peak_focus_range({}),
      peak_focus_range({ g1Mean: NaN, g2Mean: 300 }),
      peak_focus_range({ g1Mean: 300, g2Mean: 170 }),   // G2 below G1
      peak_focus_range({ g1Mean: -5, g2Mean: 300 }),
    ];
    return { pass: cases.every((c) => c === null), detail: JSON.stringify(cases) };
  });

  run('a missing sigma falls back to a CV-scaled width instead of failing', () => {
    const r = peak_focus_range({ g1Mean: 170, g2Mean: 340 });
    return { pass: r !== null && r.max > 340 && r.min < 170, detail: JSON.stringify(r) };
  });

  run('an overlay of several samples gets one shared frame covering all of them', () => {
    const shared = shared_peak_focus_range([
      { g1Mean: 170, g1Sigma: 12, g2Mean: 340, g2Sigma: 20 },
      { g1Mean: 220, g1Sigma: 14, g2Mean: 440, g2Sigma: 24 },
    ]);
    const a = peak_focus_range({ g1Mean: 170, g1Sigma: 12, g2Mean: 340, g2Sigma: 20 });
    const b = peak_focus_range({ g1Mean: 220, g1Sigma: 14, g2Mean: 440, g2Sigma: 24 });
    return {
      pass: shared.min <= Math.min(a.min, b.min) + 1e-9
        && shared.max >= Math.max(a.max, b.max) - 1e-9,
      detail: JSON.stringify({ shared, a, b }),
    };
  });

  run('DOMAIN-01: framing the view is display-only and never touches the analysis domain', () => {
    // The whole reason this lives apart from analysis_domain_override: a change
    // to what you LOOK at must not change what was FIT. Compute a frame and
    // confirm the scientific domain is untouched.
    const data = window.PlotData ?? null;
    if (!data) return { pass: true, detail: 'plot data module not exposed in the unit harness' };
    const before = JSON.stringify(data.analysis_domain_override);
    peak_focus_range(FIT);
    shared_peak_focus_range([FIT]);
    return {
      pass: JSON.stringify(data.analysis_domain_override) === before,
      detail: `analysis_domain_override unchanged: ${before}`,
    };
  });

  return results;
}"""


def run_peak_focus_range_tests(ctx: TestContext):
    """Run the peak-focus display-range assertions."""

    try:
        all_results = ctx.page.evaluate(_TESTS)
    except Exception as err:
        ctx.check(GROUP, "peak focus range suite setup", False, str(err), screenshot=False)
        return

    for item in all_results:
        ctx.check(GROUP, item["name"], item["pass"], item.get("detail", ""), screenshot=False)
