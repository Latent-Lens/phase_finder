#!/usr/bin/env python3
"""Unit tests for the pure IO/FCS helpers in js/io/parameter_map.js and
js/fcs/channel_cleaning.js.

Covers parameter-map construction, channel lookup, index de-duplication, the
optional height/width companion-channel matching, pipeline-channel detection,
and construction of raw, uncompacted analysis channels.
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

  // ---- staged-pipeline channel detection ----------------------------------
  const pipelineParams = parameter_map({
    columns: ['DAPI-A', 'DAPI-H', 'FSC-A', 'SSC-A', 'HDR-T'],
    metadata: {
      P3S: 'Forward Scatter Area',
      P4S: 'Side Scatter Area',
      P5S: 'Acquisition Time',
    },
  });
  const pipelineIndexes = find_pipeline_channel_indexes(pipelineParams);
  push('find_pipeline_channel_indexes: detects FSC-A, SSC-A, and HDR-T',
       pipelineIndexes.fsc_a === 3 && pipelineIndexes.ssc_a === 4 && pipelineIndexes.time === 5,
       JSON.stringify(pipelineIndexes));

  // ---- build_raw_analysis_channels ----------------------------------------
  const raw = build_raw_analysis_channels(
    {
      1: [64000, -5, 0, 128000, NaN],
      2: [30000, 1, 0, 60000, 1],
      3: [100, 101, 102, 103, 104],
      4: [200, 201, 202, 203, 204],
      5: [0, 1, 2, 3, 500],
    },
    { dna_a: 1, dna_h: 2, dna_w: null, fsc_a: 3, ssc_a: 4, time: 5 },
    {
      DATATYPE: 'F',
      P1R: '262144', P1B: '32', P1N: 'DAPI-A',
      P2R: '262144', P3R: '1000', P4R: '1000', P5R: '100',
    },
    5,
  );
  push('build_raw_analysis_channels: preserves original indexes, zero, negatives, and NaN',
       raw.channels.DNA_A instanceof Float64Array
       && raw.channels.DNA_A.length === 5
       && raw.channels.DNA_A[0] === 64000
       && raw.channels.DNA_A[1] === -5
       && raw.channels.DNA_A[2] === 0
       && raw.channels.DNA_A[3] === 128000
       && Number.isNaN(raw.channels.DNA_A[4])
       && raw.channels.DNA_H[2] === 0,
       JSON.stringify({ a: Array.from(raw.channels.DNA_A), h: Array.from(raw.channels.DNA_H) }));
  push('build_raw_analysis_channels: leaves missing channels null and captures PnR metadata',
       raw.channels.DNA_W === null
       && raw.pnr.DNA_A === 262144
       && raw.pnr.Time === 100
       && raw.parameterMetadata.DNA_A.bits === 32
       && raw.parameterMetadata.DNA_A.datatype === 'F',
       JSON.stringify({ pnr: raw.pnr, dnaMetadata: raw.parameterMetadata.DNA_A }));

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
