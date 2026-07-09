#!/usr/bin/env python3
"""Unit tests for the pure IO/FCS helpers in js/io/parameter_map.js and
js/fcs/channel_cleaning.js.

Covers parameter-map construction, channel lookup, index de-duplication, the
optional height/width companion-channel matching, and the invalid-event filter.
Includes a regression test for the H/W-dedup decision: channel_cleaning's
word-boundary-anchored tokenizer must NOT carve "width" out of a longer word
like "Bandwidth" (the behavior that made it the surviving implementation over the
former unanchored copy in analysis/djf.js). None touch the DOM.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext

GROUP = "Unit / IO & Channel Cleaning"

_FULL_SUITE = r"""() => {
  const results = [];
  const push = (name, pass, detail) => results.push({ name, pass: Boolean(pass), detail: detail ?? '' });

  // ---- parameter_map ------------------------------------------------------
  const summary = {
    columns: ['FSC-A', 'FSC-H', 'DAPI-A'],
    metadata: { P1N: 'FSC-A', P1S: 'Forward Scatter', P2N: 'FSC-H', P3N: 'DAPI-A', P3S: 'DNA' },
  };
  const params = parameter_map(summary);
  push('parameter_map: builds one 1-based record per column',
       params.length === 3 && params[0].index === 1 && params[2].index === 3,
       JSON.stringify(params.map((p) => p.index)));
  push('parameter_map: pairs $PnN name and $PnS description with each column',
       params[0].label === 'FSC-A' && params[0].name === 'FSC-A' && params[0].desc === 'Forward Scatter'
       && params[2].desc === 'DNA',
       JSON.stringify(params[0]));

  // ---- find_param_index ---------------------------------------------------
  push('find_param_index: resolves a channel label to its 1-based index',
       find_param_index(params, 'DAPI-A') === 3, String(find_param_index(params, 'DAPI-A')));
  let threw = false;
  try { find_param_index(params, 'Not A Channel'); } catch (_) { threw = true; }
  push('find_param_index: throws when the channel is not present', threw, 'threw=' + threw);

  // ---- unique_indexes -----------------------------------------------------
  push('unique_indexes: de-duplicates and keeps only integers',
       JSON.stringify(unique_indexes([1, 1, 2, 3, 3, null, undefined, 2.5])) === JSON.stringify([1, 2, 3]),
       JSON.stringify(unique_indexes([1, 1, 2, 3, 3, null, undefined, 2.5])));

  // ---- find_auxiliary_indexes_for_file ------------------------------------
  const dapi = parameter_map({ columns: ['DAPI-A', 'DAPI-H', 'DAPI-W', 'Time'], metadata: {} });
  const aux = find_auxiliary_indexes_for_file(dapi, 'DAPI-A');
  push('find_auxiliary_indexes_for_file: links same-base height and width channels',
       aux.dna_h === 2 && aux.dna_w === 3
       && aux.dna_height_label === 'DAPI-H' && aux.dna_width_label === 'DAPI-W',
       JSON.stringify(aux));

  const noAux = find_auxiliary_indexes_for_file(dapi, 'Time');
  push('find_auxiliary_indexes_for_file: no companions for an unrelated channel',
       (noAux.dna_h == null) && (noAux.dna_w == null), JSON.stringify(noAux));

  // Regression for the H/W-dedup decision: "width" inside "Bandwidth" is NOT a
  // standalone word, so the \b-anchored tokenizer must leave the base intact and
  // still link Bandwidth-A to Bandwidth-H / Bandwidth-W.
  const band = parameter_map({ columns: ['Bandwidth-A', 'Bandwidth-H', 'Bandwidth-W'], metadata: {} });
  const bandAux = find_auxiliary_indexes_for_file(band, 'Bandwidth-A');
  push('find_auxiliary_indexes_for_file: word-boundary tokenizer does not carve "width" out of "Bandwidth"',
       bandAux.dna_h === 2 && bandAux.dna_w === 3,
       JSON.stringify(bandAux));

  // ---- filter_selected_channel_values -------------------------------------
  const columns = { 1: [64000, -5, 0, 128000, NaN], 2: [30000, 1, 1, 60000, 1], 3: [2.0, 9, 9, 2.1, 9] };
  const filtered = filter_selected_channel_values(columns, { dna_a: 1, dna_h: 2, dna_w: 3 });
  push('filter_selected_channel_values: keeps only finite positive DNA-area events',
       filtered.dna_a.length === 2 && filtered.dna_a[0] === 64000 && filtered.dna_a[1] === 128000
       && filtered.removed_count === 3 && filtered.total_count === 5,
       JSON.stringify({ a: Array.from(filtered.dna_a), removed: filtered.removed_count, total: filtered.total_count }));
  push('filter_selected_channel_values: applies the same keep-mask to height and width arrays',
       filtered.dna_h.length === 2 && filtered.dna_h[0] === 30000 && filtered.dna_h[1] === 60000
       && filtered.dna_w[0] === 2.0 && filtered.dna_w[1] === 2.1
       && Array.from(filtered.keep_mask).join('') === '10010',
       JSON.stringify({ h: Array.from(filtered.dna_h), w: Array.from(filtered.dna_w), mask: Array.from(filtered.keep_mask) }));

  return results;
}"""


def run_io_tests(ctx: TestContext):
    page = ctx.page
    try:
        all_results = page.evaluate(_FULL_SUITE)
    except Exception as err:
        ctx.check(GROUP, "IO/channel-cleaning suite setup", False, str(err), screenshot=False)
        return

    for item in all_results:
        ctx.check(GROUP, item["name"], item["pass"], item.get("detail", ""), screenshot=False)
