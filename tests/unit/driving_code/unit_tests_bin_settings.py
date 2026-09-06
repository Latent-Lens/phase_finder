#!/usr/bin/env python3
"""Browser unit coverage for the DNA-histogram default bin count (MODEL-09).

`dna_histogram.js` owns the analysis-side fallback used when a caller supplies
no explicit `binCount`; `plotting/data.js` owns the Bins slider's default and
its advertised stops. Before MODEL-09 those were two independent literals --
512 in the histogram module, 256 in the plot module -- so which bin count a
sample was actually analysed at depended on the call path that reached the
histogram builder, with nothing in the tree able to notice the disagreement.

These tests pin the single-source-of-truth relationship itself rather than the
number: if someone re-declares a literal in either module, or moves the plot
default to a stop the analysis fallback cannot produce, this fails.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / Bin Settings"


_BIN_SETTINGS_TESTS = r"""() => {
  const { DEFAULT_BIN_COUNT } = window.DnaHistogram;
  const { DEFAULT_BINS, BIN_STOPS, slider_index_for_bins } = window.PlotData;

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

  run('MODEL-09: the histogram module and the plot module agree on the default bin count', () => ({
    // The whole point of the item: one concept, one value. Identity (not
    // approximate agreement) is the assertion, because plotting/data.js is
    // supposed to be RE-EXPORTING the histogram module's constant, not
    // maintaining a copy that happens to match today.
    pass: DEFAULT_BINS === DEFAULT_BIN_COUNT,
    detail: `dna_histogram DEFAULT_BIN_COUNT=${DEFAULT_BIN_COUNT}, plotting/data DEFAULT_BINS=${DEFAULT_BINS}`,
  }));

  run('MODEL-09: the shared default is a real slider stop, so the UI can represent it', () => {
    // A default the Bins slider cannot land on would silently snap to a
    // neighbouring stop the first time the user touched the control, so the
    // analysis fallback and the visible control would diverge again by a
    // different route than the one MODEL-09 closed.
    const index = BIN_STOPS.indexOf(DEFAULT_BIN_COUNT);
    return {
      pass: index >= 0,
      detail: `BIN_STOPS=${JSON.stringify(BIN_STOPS)} index of ${DEFAULT_BIN_COUNT} = ${index}`,
    };
  });

  run('MODEL-09: an unusable stored bin count falls back to the shared default index', () => {
    // slider_index_for_bins() is the session-restore path: a stored bin count
    // maps onto the discrete slider. Its unusable-input fallback is
    // DEFAULT_BIN_INDEX, derived from the shared constant -- a hard-coded index
    // here would reintroduce the split for exactly the malformed-session case
    // that is hardest to notice. Only NON-FINITE inputs take that branch:
    // `null` coerces to 0 and legitimately snaps to the nearest stop (128),
    // so it is not a fallback case and is deliberately excluded here.
    const expected = BIN_STOPS.indexOf(DEFAULT_BIN_COUNT);
    const fallbacks = [NaN, undefined, Infinity, 'not a number'].map((value) => slider_index_for_bins(value));
    return {
      pass: expected >= 0 && fallbacks.every((index) => index === expected),
      detail: `fallbacks=${JSON.stringify(fallbacks)} expected all ${expected} (index of ${DEFAULT_BIN_COUNT})`,
    };
  });

  run('MODEL-09: every slider stop round-trips through slider_index_for_bins', () => {
    const mapped = BIN_STOPS.map((stop) => BIN_STOPS[slider_index_for_bins(stop)]);
    return {
      pass: mapped.every((value, index) => value === BIN_STOPS[index]),
      detail: `mapped=${JSON.stringify(mapped)} stops=${JSON.stringify(BIN_STOPS)}`,
    };
  });

  return results;
}"""


def run_bin_settings_tests(ctx: TestContext):
    """Run the MODEL-09 default-bin-count agreement assertions."""

    try:
        all_results = ctx.page.evaluate(_BIN_SETTINGS_TESTS)
    except Exception as err:
        ctx.check(
            GROUP,
            "bin settings suite setup",
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
