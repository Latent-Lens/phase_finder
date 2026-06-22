#!/usr/bin/env python3
"""Unit tests for window.FCSParser (fcs-parser.js).

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
        const s = window.FCSParser.parseFCSHeader(buf);
        return { pass: s.header.version === 'FCS3.1', detail: 'version=' + s.header.version };
      } catch(e) { return { pass: false, detail: String(e) }; }
    }""")
    ctx.check(GROUP, "parseFCSHeader: version string is FCS3.1", result["pass"], result["detail"],
              screenshot=False)

    # --- 2. textBegin is 58 ---
    result = page.evaluate("""() => {
      const buf = window.TestUtils.buildSyntheticFCS(100);
      try {
        const s = window.FCSParser.parseFCSHeader(buf);
        return { pass: s.header.textBegin === 58, detail: 'textBegin=' + s.header.textBegin };
      } catch(e) { return { pass: false, detail: String(e) }; }
    }""")
    ctx.check(GROUP, "parseFCSHeader: textBegin equals 58", result["pass"], result["detail"],
              screenshot=False)

    # --- 3. dataBegin > textEnd ---
    result = page.evaluate("""() => {
      const buf = window.TestUtils.buildSyntheticFCS(100);
      try {
        const s = window.FCSParser.parseFCSHeader(buf);
        const ok = s.header.dataBegin > s.header.textEnd;
        return { pass: ok, detail: 'dataBegin=' + s.header.dataBegin + ' textEnd=' + s.header.textEnd };
      } catch(e) { return { pass: false, detail: String(e) }; }
    }""")
    ctx.check(GROUP, "parseFCSHeader: dataBegin > textEnd", result["pass"], result["detail"],
              screenshot=False)

    # --- 4. eventCount matches $TOT ---
    result = page.evaluate("""() => {
      const buf = window.TestUtils.buildSyntheticFCS(6000);
      try {
        const s = window.FCSParser.parseFCSHeader(buf);
        return { pass: s.eventCount === 6000, detail: 'eventCount=' + s.eventCount };
      } catch(e) { return { pass: false, detail: String(e) }; }
    }""")
    ctx.check(GROUP, "parseFCSHeader: eventCount equals $TOT (6000)", result["pass"], result["detail"],
              screenshot=False)

    # --- 5. parameterCount is 6 ---
    result = page.evaluate("""() => {
      const buf = window.TestUtils.buildSyntheticFCS(100);
      try {
        const s = window.FCSParser.parseFCSHeader(buf);
        return { pass: s.parameterCount === 6, detail: 'parameterCount=' + s.parameterCount };
      } catch(e) { return { pass: false, detail: String(e) }; }
    }""")
    ctx.check(GROUP, "parseFCSHeader: parameterCount equals 6", result["pass"], result["detail"],
              screenshot=False)

    # --- 6. GFP/FITC-A in columns ---
    result = page.evaluate("""() => {
      const buf = window.TestUtils.buildSyntheticFCS(100);
      try {
        const s = window.FCSParser.parseFCSHeader(buf);
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
        const s = window.FCSParser.parseFCSHeader(buf);
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
        window.FCSParser.parseFCSHeader(tiny);
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
        window.FCSParser.parseFCSHeader(buf);
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
        const parsed = window.FCSParser.parseFCS(buf);
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
        const summary = window.FCSParser.parseFCSHeader(buf);
        const parsed = window.FCSParser.parseFCS(buf);
        const data = buf.slice(summary.dataBegin, summary.dataEnd + 1);
        const selected = window.FCSParser.parseSelectedColumns(data, summary.metadata, [1, 4]);
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
        const summary = window.FCSParser.parseFCSHeader(buf);
        const data = buf.slice(summary.dataBegin, summary.dataEnd + 1);
        window.FCSParser.parseSelectedColumns(data, summary.metadata, [7]);
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
        const full = window.FCSParser.parseFCSHeader(buf);
        const headerBuffer = buf.slice(0, 58);
        const textBuffer = buf.slice(full.header.textBegin, full.header.textEnd + 1);
        const segmented = window.FCSParser.parseFCSHeaderFromSegments(headerBuffer, textBuffer);
        const ok = segmented.eventCount === full.eventCount
          && segmented.parameterCount === full.parameterCount
          && JSON.stringify(segmented.columns) === JSON.stringify(full.columns)
          && segmented.dataBegin === full.dataBegin
          && segmented.dataEnd === full.dataEnd;
        return { pass: ok, detail: `events=${segmented.eventCount} data=${segmented.dataBegin}-${segmented.dataEnd}` };
      } catch(e) { return { pass: false, detail: String(e) }; }
    }""")
    ctx.check(GROUP, "parseFCSHeaderFromSegments: matches full header summary", result["pass"], result["detail"],
              screenshot=False)
