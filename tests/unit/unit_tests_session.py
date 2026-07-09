#!/usr/bin/env python3
"""Unit tests for the session TOML serializer/parser in js/session/toml_io.js.

Builds a representative session object (the shape js/session/core.js's
collect_session produces), serializes it to TOML, parses it back, and asserts
that the fields the app relies on survive the round-trip: files, plot controls,
table sort/filters, metadata columns and rows, the filename template, UI layout,
and the stats plan. Guards session save/load reliability without any DOM or app
state.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext

GROUP = "Unit / Session TOML"

_FULL_SUITE = r"""() => {
  const results = [];
  const push = (name, pass, detail) => results.push({ name, pass: Boolean(pass), detail: detail ?? '' });

  const session = {
    session: { created: '2026-07-09T00:00:00.000Z' },
    files: { names: ['A.fcs', 'B.fcs'], records: [] },
    stats_plan: [{ channel: 'DAPI-A', metrics: ['mean', 'median'] }],
    metadata: {
      columns: [
        { field: 'strain', label: 'Strain', headerEditable: false, source: 'filename' },
        { field: 'timepoint', label: 'Timepoint', headerEditable: true, source: 'filename' },
      ],
      rows: [
        { name: 'A.fcs', strain: '76', timepoint: '0' },
        { name: 'B.fcs', strain: '77', timepoint: '30' },
      ],
    },
    metadata_template: {
      steps: [{ type: 'delimiter', delimiter: '_' }],
      columns: [{ field: 'strain', label: 'Strain', source_index: 0 }],
    },
    table: {
      selected_files: ['A.fcs'],
      sort_field: 'strain',
      sort_direction: 'desc',
      filters: { strain: ['76', '77'] },
    },
    plot: {
      channel: 'DAPI-A', color_by: 'strain', display_mode: 'curve_bins', bins: 384,
      remove_debris: true, remove_doublets: false, show_peak_threshold: true,
    },
    ui: {
      sidebar_collapsed: false, sidebar_width_px: 340,
      plot_panel_collapsed: false, plot_panel_height_px: 420,
      metadata_panel_collapsed: true, metadata_panel_height_px: 260,
    },
  };

  let text, parsed;
  try {
    text = serialize_session(session);
    parsed = parse_session_toml(text);
  } catch (err) {
    push('serialize_session/parse_session_toml: round-trip runs without error', false, String(err));
    return results;
  }
  push('serialize_session: produces a non-empty TOML document with a [session] header',
       typeof text === 'string' && text.includes('[session]') && text.length > 100,
       'length=' + (text ? text.length : 0));

  push('round-trip: session.created is preserved',
       parsed.session && parsed.session.created === session.session.created,
       parsed.session && parsed.session.created);
  push('round-trip: files.names is preserved in order',
       JSON.stringify(parsed.files && parsed.files.names) === JSON.stringify(['A.fcs', 'B.fcs']),
       JSON.stringify(parsed.files && parsed.files.names));

  push('round-trip: plot controls (channel, display_mode, bins) survive with types',
       parsed.plot.channel === 'DAPI-A' && parsed.plot.display_mode === 'curve_bins'
       && parsed.plot.bins === 384,
       JSON.stringify(parsed.plot));
  push('round-trip: plot boolean toggles survive as booleans',
       parsed.plot.remove_debris === true && parsed.plot.remove_doublets === false
       && parsed.plot.show_peak_threshold === true,
       JSON.stringify({ d: parsed.plot.remove_debris, db: parsed.plot.remove_doublets, t: parsed.plot.show_peak_threshold }));

  push('round-trip: table sort field and direction survive',
       parsed.table.sort_field === 'strain' && parsed.table.sort_direction === 'desc',
       JSON.stringify({ f: parsed.table.sort_field, d: parsed.table.sort_direction }));
  push('round-trip: table selection and column filters survive as arrays',
       JSON.stringify(parsed.table.selected_files) === JSON.stringify(['A.fcs'])
       && JSON.stringify(parsed.table.filters.strain) === JSON.stringify(['76', '77']),
       JSON.stringify({ sel: parsed.table.selected_files, filt: parsed.table.filters }));

  push('round-trip: metadata columns preserve field, label, and header_editable',
       parsed.metadata.columns.length === 2
       && parsed.metadata.columns[0].field === 'strain' && parsed.metadata.columns[0].label === 'Strain'
       && parsed.metadata.columns[1].header_editable === true,
       JSON.stringify(parsed.metadata.columns));
  push('round-trip: metadata rows preserve per-column values keyed by filename',
       parsed.metadata.rows.length === 2
       && parsed.metadata.rows[0].name === 'A.fcs' && parsed.metadata.rows[0].strain === '76'
       && parsed.metadata.rows[1].timepoint === '30',
       JSON.stringify(parsed.metadata.rows));

  push('round-trip: filename metadata template steps and columns survive',
       parsed.metadata_template.steps[0].type === 'delimiter'
       && parsed.metadata_template.steps[0].delimiter === '_'
       && parsed.metadata_template.columns[0].source_index === 0,
       JSON.stringify(parsed.metadata_template));

  push('round-trip: UI layout numbers and collapsed flags survive',
       parsed.ui.sidebar_width_px === 340 && parsed.ui.metadata_panel_collapsed === true
       && parsed.ui.plot_panel_height_px === 420,
       JSON.stringify(parsed.ui));

  push('round-trip: stats plan entries survive with their metric lists',
       parsed.stats_plan && parsed.stats_plan.entries
       && parsed.stats_plan.entries[0].channel === 'DAPI-A'
       && JSON.stringify(parsed.stats_plan.entries[0].metrics) === JSON.stringify(['mean', 'median']),
       JSON.stringify(parsed.stats_plan));

  return results;
}"""


def run_session_tests(ctx: TestContext):
    page = ctx.page
    try:
        all_results = page.evaluate(_FULL_SUITE)
    except Exception as err:
        ctx.check(GROUP, "Session TOML suite setup", False, str(err), screenshot=False)
        return

    for item in all_results:
        ctx.check(GROUP, item["name"], item["pass"], item.get("detail", ""), screenshot=False)
