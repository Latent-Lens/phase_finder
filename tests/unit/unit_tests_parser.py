#!/usr/bin/env python3
"""Unit tests for window.FCSParser (js/fcs/parser.js).

Each test calls page.evaluate() with a self-contained JS expression that builds
a synthetic FCS ArrayBuffer using window.TestUtils.buildSyntheticFCS() and then
invokes the parser API. No console.log additions are required.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext, join_detail

GROUP = "Unit / FCS Parser"


def _js(expr: str) -> str:
    """Wrap an expression in an async IIFE for page.evaluate."""
    return f"async () => {{ {expr} }}"


def run_parser_tests(ctx: TestContext):
    page = ctx.page

    # --- 1. version string ---
    result = page.evaluate("""() => {
      const buf = window.TestUtils.buildSyntheticFCS(100);
      try {
        const s = window.FCSParser.parse_fcs_header(buf);
        return { pass: s.header.version === 'FCS3.1', detail: 'version=' + s.header.version };
      } catch(e) { return { pass: false, detail: String(e) }; }
    }""")
    ctx.check(GROUP, "parseFCSHeader: version string is FCS3.1", result["pass"], result["detail"],
              screenshot=False)

    # --- 2. text_begin is 58 ---
    result = page.evaluate("""() => {
      const buf = window.TestUtils.buildSyntheticFCS(100);
      try {
        const s = window.FCSParser.parse_fcs_header(buf);
        return { pass: s.header.text_begin === 58, detail: 'text_begin=' + s.header.text_begin };
      } catch(e) { return { pass: false, detail: String(e) }; }
    }""")
    ctx.check(GROUP, "parseFCSHeader: text_begin equals 58", result["pass"], result["detail"],
              screenshot=False)

    # --- 3. data_begin > text_end ---
    result = page.evaluate("""() => {
      const buf = window.TestUtils.buildSyntheticFCS(100);
      try {
        const s = window.FCSParser.parse_fcs_header(buf);
        const ok = s.header.data_begin > s.header.text_end;
        return { pass: ok, detail: 'data_begin=' + s.header.data_begin + ' text_end=' + s.header.text_end };
      } catch(e) { return { pass: false, detail: String(e) }; }
    }""")
    ctx.check(GROUP, "parseFCSHeader: data_begin > text_end", result["pass"], result["detail"],
              screenshot=False)

    # --- 4. event_count matches $TOT ---
    result = page.evaluate("""() => {
      const buf = window.TestUtils.buildSyntheticFCS(6000);
      try {
        const s = window.FCSParser.parse_fcs_header(buf);
        return { pass: s.event_count === 6000, detail: 'event_count=' + s.event_count };
      } catch(e) { return { pass: false, detail: String(e) }; }
    }""")
    ctx.check(GROUP, "parseFCSHeader: event_count equals $TOT (6000)", result["pass"], result["detail"],
              screenshot=False)

    # --- 5. parameter_count is 6 ---
    result = page.evaluate("""() => {
      const buf = window.TestUtils.buildSyntheticFCS(100);
      try {
        const s = window.FCSParser.parse_fcs_header(buf);
        return { pass: s.parameter_count === 6, detail: 'parameter_count=' + s.parameter_count };
      } catch(e) { return { pass: false, detail: String(e) }; }
    }""")
    ctx.check(GROUP, "parseFCSHeader: parameter_count equals 6", result["pass"], result["detail"],
              screenshot=False)

    # --- 6. GFP/FITC-A in columns ---
    result = page.evaluate("""() => {
      const buf = window.TestUtils.buildSyntheticFCS(100);
      try {
        const s = window.FCSParser.parse_fcs_header(buf);
        const ok = Array.isArray(s.columns) && s.columns.includes('GFP/FITC-A');
        return { pass: ok, detail: 'columns=' + JSON.stringify(s.columns) };
      } catch(e) { return { pass: false, detail: String(e) }; }
    }""")
    ctx.check(GROUP, "parseFCSHeader: GFP/FITC-A present in columns", result["pass"], result["detail"],
              screenshot=False)

    # --- 7. mCherry/PE-A in columns ---
    result = page.evaluate("""() => {
      const buf = window.TestUtils.buildSyntheticFCS(100);
      try {
        const s = window.FCSParser.parse_fcs_header(buf);
        const ok = Array.isArray(s.columns) && s.columns.includes('mCherry/PE-A');
        return { pass: ok, detail: 'columns=' + JSON.stringify(s.columns) };
      } catch(e) { return { pass: false, detail: String(e) }; }
    }""")
    ctx.check(GROUP, "parseFCSHeader: mCherry/PE-A present in columns", result["pass"], result["detail"],
              screenshot=False)

    # --- 8. throws on buffer < 58 bytes ---
    result = page.evaluate("""() => {
      const tiny = new ArrayBuffer(10);
      try {
        window.FCSParser.parse_fcs_header(tiny);
        return { pass: false, detail: 'no error thrown' };
      } catch(e) {
        return { pass: true, detail: String(e) };
      }
    }""")
    ctx.check(GROUP, "parseFCSHeader: throws on buffer < 58 bytes", result["pass"], result["detail"],
              screenshot=False)

    # --- 9. throws on non-FCS header ---
    result = page.evaluate("""() => {
      const buf = new ArrayBuffer(58);
      const bytes = new Uint8Array(buf);
      bytes.set(new TextEncoder().encode('NOTFCS'));
      try {
        window.FCSParser.parse_fcs_header(buf);
        return { pass: false, detail: 'no error thrown' };
      } catch(e) {
        return { pass: /does not look like an FCS file/.test(String(e)), detail: String(e) };
      }
    }""")
    ctx.check(GROUP, "parseFCSHeader: throws on non-FCS header", result["pass"], result["detail"],
              screenshot=False)

    # --- 10. parseFCS reads all event rows and values ---
    result = page.evaluate("""() => {
      const buf = window.TestUtils.buildSyntheticFCS(25);
      try {
        const parsed = window.FCSParser.parse_fcs(buf);
        const columnsOk = parsed.columns.length === 6 && parsed.columns[0] === 'GFP/FITC-A';
        const rowsOk = parsed.rows.length === 25;
        const valuesOk = parsed.rows.every(row =>
          Number.isFinite(row['GFP/FITC-A']) && Number.isFinite(row['mCherry/PE-W'])
        );
        return {
          pass: columnsOk && rowsOk && valuesOk,
          detail: `rows=${parsed.rows.length} columns=${JSON.stringify(parsed.columns)}`
        };
      } catch(e) { return { pass: false, detail: String(e) }; }
    }""")
    ctx.check(GROUP, "parseFCS: reads all rows and numeric channel values", result["pass"], result["detail"],
              screenshot=False)

    # --- 11. parseSelectedColumns returns selected data matching full parse ---
    result = page.evaluate("""() => {
      const buf = window.TestUtils.buildSyntheticFCS(32);
      try {
        const summary = window.FCSParser.parse_fcs_header(buf);
        const parsed = window.FCSParser.parse_fcs(buf);
        const data = buf.slice(summary.data_begin, summary.data_end + 1);
        const selected = window.FCSParser.parse_selected_columns(data, summary.metadata, [1, 4]);
        const firstOk = selected[1][0] === parsed.rows[0]['GFP/FITC-A'];
        const lastOk = selected[4][31] === parsed.rows[31]['mCherry/PE-A'];
        const keysOk = Object.keys(selected).sort().join(',') === '1,4';
        return {
          pass: firstOk && lastOk && keysOk && selected[1].length === 32 && selected[4].length === 32,
          detail: `keys=${Object.keys(selected).join(',')} lengths=${selected[1].length}/${selected[4].length}`
        };
      } catch(e) { return { pass: false, detail: String(e) }; }
    }""")
    ctx.check(GROUP, "parseSelectedColumns: matches full parse for selected channels", result["pass"], result["detail"],
              screenshot=False)

    # --- 12. parseSelectedColumns rejects out-of-range indexes ---
    result = page.evaluate("""() => {
      const buf = window.TestUtils.buildSyntheticFCS(5);
      try {
        const summary = window.FCSParser.parse_fcs_header(buf);
        const data = buf.slice(summary.data_begin, summary.data_end + 1);
        window.FCSParser.parse_selected_columns(data, summary.metadata, [7]);
        return { pass: false, detail: 'no error thrown' };
      } catch(e) {
        return { pass: /out of range/.test(String(e)), detail: String(e) };
      }
    }""")
    ctx.check(GROUP, "parseSelectedColumns: rejects out-of-range parameter indexes", result["pass"], result["detail"],
              screenshot=False)

    # --- 13. segment parser returns same summary as full header parse ---
    result = page.evaluate("""() => {
      const buf = window.TestUtils.buildSyntheticFCS(17);
      try {
        const full = window.FCSParser.parse_fcs_header(buf);
        const header_buffer = buf.slice(0, 58);
        const text_buffer = buf.slice(full.header.text_begin, full.header.text_end + 1);
        const segmented = window.FCSParser.parse_fcs_header_from_segments(header_buffer, text_buffer);
        const ok = segmented.event_count === full.event_count
          && segmented.parameter_count === full.parameter_count
          && JSON.stringify(segmented.columns) === JSON.stringify(full.columns)
          && segmented.data_begin === full.data_begin
          && segmented.data_end === full.data_end;
        return { pass: ok, detail: `events=${segmented.event_count} data=${segmented.data_begin}-${segmented.data_end}` };
      } catch(e) { return { pass: false, detail: String(e) }; }
    }""")
    ctx.check(GROUP, "parseFCSHeaderFromSegments: matches full header summary", result["pass"], result["detail"],
              screenshot=False)

    # --- 14. parseSelectedColumns with an empty index list returns {} ---
    result = page.evaluate("""() => {
      const buf = window.TestUtils.buildSyntheticFCS(5);
      try {
        const summary = window.FCSParser.parse_fcs_header(buf);
        const data = buf.slice(summary.data_begin, summary.data_end + 1);
        const selected = window.FCSParser.parse_selected_columns(data, summary.metadata, []);
        return { pass: Object.keys(selected).length === 0, detail: JSON.stringify(selected) };
      } catch(e) { return { pass: false, detail: String(e) }; }
    }""")
    ctx.check(GROUP, "parseSelectedColumns: an empty index list returns an empty object", result["pass"], result["detail"],
              screenshot=False)

    # --- 15. $DATATYPE I (16-bit integer) header metadata reads correctly ---
    result = page.evaluate("""() => {
      const buf = window.TestUtils.buildSyntheticIntegerFCS(10);
      try {
        const s = window.FCSParser.parse_fcs_header(buf);
        const ok = s.parameter_count === 2 && s.event_count === 10
          && s.columns.join(',') === 'Chan-A,Chan-B';
        return { pass: ok, detail: `columns=${JSON.stringify(s.columns)} params=${s.parameter_count} events=${s.event_count}` };
      } catch(e) { return { pass: false, detail: String(e) }; }
    }""")
    ctx.check(GROUP, "parseFCSHeader: reads $DATATYPE I parameter metadata correctly", result["pass"], result["detail"],
              screenshot=False)

    # --- 16. parseFCS reads $DATATYPE I (16-bit) values for every event ---
    result = page.evaluate("""() => {
      const buf = window.TestUtils.buildSyntheticIntegerFCS(10);
      try {
        const parsed = window.FCSParser.parse_fcs(buf);
        const ok = parsed.rows.length === 10
          && parsed.rows[3]['Chan-A'] === 300 && parsed.rows[3]['Chan-B'] === 65535 - 300
          && parsed.rows[9]['Chan-A'] === 900 && parsed.rows[9]['Chan-B'] === 65535 - 900;
        return { pass: ok, detail: `row3=${JSON.stringify(parsed.rows[3])} row9=${JSON.stringify(parsed.rows[9])}` };
      } catch(e) { return { pass: false, detail: String(e) }; }
    }""")
    ctx.check(GROUP, "parseFCS: reads $DATATYPE I (16-bit) values correctly for every event", result["pass"], result["detail"],
              screenshot=False)

    # --- 17. parseSelectedColumns matches full parse for an integer channel ---
    result = page.evaluate("""() => {
      const buf = window.TestUtils.buildSyntheticIntegerFCS(10);
      try {
        const summary = window.FCSParser.parse_fcs_header(buf);
        const parsed = window.FCSParser.parse_fcs(buf);
        const data = buf.slice(summary.data_begin, summary.data_end + 1);
        const selected = window.FCSParser.parse_selected_columns(data, summary.metadata, [2]);
        const ok = selected[2].length === 10
          && selected[2][0] === parsed.rows[0]['Chan-B']
          && selected[2][9] === parsed.rows[9]['Chan-B'];
        return { pass: ok, detail: JSON.stringify(selected[2]) };
      } catch(e) { return { pass: false, detail: String(e) }; }
    }""")
    ctx.check(GROUP, "parseSelectedColumns: matches full parse for an integer ($DATATYPE I) channel", result["pass"], result["detail"],
              screenshot=False)
