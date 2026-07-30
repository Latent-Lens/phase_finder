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

    # --- 18. malformed FCS contracts reject during header import with stable codes ---
    result = page.evaluate("""async () => {
      const expected = {
        parser_data_offset_oob: 'FCS_OFFSET_CONFLICT',
        parser_i12_packed: 'FCS_PACKED_INTEGER_UNSUPPORTED',
        parser_i64_unsafe: 'FCS_INTEGER_PRECISION_UNSUPPORTED',
        parser_huge_par: 'FCS_PARAMETER_LIMIT_EXCEEDED',
        parser_short_header: 'FCS_HEADER_TRUNCATED',
        parser_supplemental_text: 'FCS_SUPPLEMENTAL_TEXT_UNSUPPORTED',
        parser_tot_allocation_mismatch: 'FCS_DATA_LENGTH_MISMATCH',
        parser_truncated_data: 'FCS_DATA_TRUNCATED',
        parser_unknown_byte_order: 'FCS_BYTE_ORDER_INVALID',
        parser_unsupported_ascii: 'FCS_DATATYPE_UNSUPPORTED',
      };
      const observed = {};
      for (const [name, code] of Object.entries(expected)) {
        const response = await fetch(`/tests/validation/validation_test_data/synthetic_fcs/files/${name}.fcs`);
        const buffer = await response.arrayBuffer();
        try {
          window.FCSParser.parse_fcs_header(buffer);
          observed[name] = 'accepted';
        } catch (error) {
          observed[name] = error.code || 'untyped';
        }
      }
      return {
        pass: Object.entries(expected).every(([name, code]) => observed[name] === code),
        detail: JSON.stringify(observed),
      };
    }""")
    ctx.check(GROUP, "Malformed FCS contracts reject during import with the expected error codes",
              result["pass"], result["detail"], screenshot=False)

    result = page.evaluate("""async () => {
      const expected = {
        parser_log_amplified_dna: 'FCS_DNA_TRANSFORM_UNSUPPORTED',
        parser_nonunit_gain_dna: 'FCS_DNA_TRANSFORM_UNSUPPORTED',
        parser_spillover_dna: 'FCS_COMPENSATION_REQUIRED',
        parser_non_list_mode: 'FCS_MODE_UNSUPPORTED',
        parser_nextdata_nonzero: 'FCS_MULTIPLE_DATASETS_UNSUPPORTED',
        parser_invalid_dna_range: 'FCS_DNA_RANGE_INVALID',
      };
      const observed = {};
      for (const [name] of Object.entries(expected)) {
        const response = await fetch(`/tests/validation/validation_test_data/synthetic_fcs/files/${name}.fcs`);
        const summary = window.FCSParser.parse_fcs_header(await response.arrayBuffer());
        const dnaIndex = summary.columns.findIndex((label) => /DNA.*-A/i.test(label)) + 1;
        observed[name] = window.FCSParser.channel_eligibility(summary, dnaIndex).code;
      }
      const normal = window.FCSParser.parse_fcs_header(window.TestUtils.buildSyntheticFCS(10));
      const normalIndex = normal.columns.indexOf('GFP/FITC-A') + 1;
      const normalEligibility = window.FCSParser.channel_eligibility(normal, normalIndex);
      return {
        pass: normalEligibility.eligible
          && Object.entries(expected).every(([name, code]) => observed[name] === code),
        detail: JSON.stringify({ normal: normalEligibility, blocked: observed }),
      };
    }""")
    ctx.check(GROUP, "DATA-01: DNA-channel semantic eligibility classifies every adversarial fixture",
              result["pass"], result["detail"], screenshot=False)

    result = page.evaluate("""async () => {
      const response = await fetch('/tests/validation/validation_test_data/synthetic_fcs/files/parser_log_amplified_dna.fcs');
      const summary = window.FCSParser.parse_fcs_header(await response.arrayBuffer());
      const io = await import('/js/io/channel_loading.js');
      try {
        io.selected_indexes_for_file(summary, { dna_area: 'DNA-A' });
        return { pass: false, detail: 'analysis accepted unsupported DNA transform' };
      } catch (error) {
        return { pass: error.code === 'FCS_DNA_TRANSFORM_UNSUPPORTED', detail: `${error.code}: ${error.message}` };
      }
    }""")
    ctx.check(GROUP, "DATA-01: selected-channel loading blocks an incompatible DNA channel with a typed error",
              result["pass"], result["detail"], screenshot=False)

    result = page.evaluate("""() => {
      const buf = window.TestUtils.buildSyntheticFCS(12);
      const summary = window.FCSParser.parse_fcs_header(buf);
      const data = buf.slice(summary.data_begin, summary.data_end + 1);
      const selected = window.FCSParser.parse_selected_columns(data, summary.metadata, [1, 4]);
      return {
        pass: selected[1] instanceof Float64Array && selected[4] instanceof Float64Array,
        detail: `${selected[1].constructor.name}/${selected[4].constructor.name}`,
      };
    }""")
    ctx.check(GROUP, "DATA-03: selected-column decoding writes directly into final typed arrays",
              result["pass"], result["detail"], screenshot=False)

    result = page.evaluate("""() => {
      const buf = window.TestUtils.buildSyntheticFCS(12);
      const summary = window.FCSParser.parse_fcs_header(buf);
      const data = buf.slice(summary.data_begin, summary.data_end);
      try {
        window.FCSParser.parse_selected_columns(data, summary.metadata, [1]);
        return { pass: false, detail: 'accepted truncated DATA' };
      } catch (error) {
        return { pass: error.code === 'FCS_DATA_TRUNCATED', detail: `${error.code}: ${error.message}` };
      }
    }""")
    ctx.check(GROUP, "DATA-02: selected-column decoding bounds DATA before allocating outputs",
              result["pass"], result["detail"], screenshot=False)

    result = page.evaluate("""() => {
      const original = window.FCSParser.limits.maxEvents;
      window.FCSParser.limits.maxEvents = 4;
      try {
        window.FCSParser.parse_fcs_header(window.TestUtils.buildSyntheticFCS(5));
        return { pass: false, detail: 'accepted configured event-limit overflow' };
      } catch (error) {
        return { pass: error.code === 'FCS_EVENT_LIMIT_EXCEEDED', detail: `${error.code}: ${error.message}` };
      } finally {
        window.FCSParser.limits.maxEvents = original;
      }
    }""")
    ctx.check(GROUP, "DATA-02: parser resource limits are configurable and fail with typed errors",
              result["pass"], result["detail"], screenshot=False)

    result = page.evaluate("""async () => {
      const buf = window.TestUtils.buildSyntheticFCS(25);
      const summary = window.FCSParser.parse_fcs_header(buf);
      const full = window.FCSParser.parse_selected_columns(
        buf.slice(summary.data_begin, summary.data_end + 1), summary.metadata, [1, 4]);
      const chunked = await window.FCSParser.parse_selected_columns_from_blob(
        new Blob([buf.slice(summary.data_begin, summary.data_end + 1)]),
        summary.metadata, [1, 4], { chunkBytes: 48 });
      const aligned = [1, 4].every((index) =>
        chunked.columns[index].length === 25
        && chunked.columns[index].every((value, event) => value === full[index][event]));
      return {
        pass: aligned && chunked.metrics.chunks > 1 && chunked.metrics.peakInputBytes <= 48
          && chunked.metrics.retainedBytes === 25 * 2 * 8,
        detail: JSON.stringify(chunked.metrics),
      };
    }""")
    ctx.check(GROUP, "DATA-03: event-aligned Blob chunks preserve indexes and bound resident input bytes",
              result["pass"], result["detail"], screenshot=False)

    result = page.evaluate("""async () => {
      const buf = window.TestUtils.buildSyntheticFCS(5);
      const summary = window.FCSParser.parse_fcs_header(buf);
      const controller = new AbortController();
      controller.abort();
      try {
        await window.FCSParser.parse_selected_columns_from_blob(
          new Blob([buf.slice(summary.data_begin, summary.data_end + 1)]),
          summary.metadata, [1], { signal: controller.signal, chunkBytes: 24 });
        return { pass: false, detail: 'cancelled load completed' };
      } catch (error) {
        return { pass: error.code === 'FCS_LOAD_CANCELLED', detail: `${error.code}: ${error.message}` };
      }
    }""")
    ctx.check(GROUP, "DATA-03: cancelled chunk loads release partial work with a typed result",
              result["pass"], result["detail"], screenshot=False)

    result = page.evaluate("""async () => {
      const buf = window.TestUtils.buildSyntheticFCS(20);
      const summary = window.FCSParser.parse_fcs_header(buf);
      const worker = new Worker(new URL('/js/fcs/data_worker.js', location.origin), { type: 'module' });
      try {
        const response = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('worker timeout')), 3000);
          worker.onmessage = (event) => { clearTimeout(timer); resolve(event.data); };
          worker.onerror = (event) => { clearTimeout(timer); reject(new Error(event.message)); };
          worker.postMessage({
            type: 'parse', request_id: 1, file: new File([buf], 'chunked.fcs'), summary, selected_indexes: [1, 4],
          });
        });
        return {
          pass: response.ok && response.columns[1] instanceof Float64Array
            && response.columns[1].length === 20 && response.metrics.retainedBytes === 20 * 2 * 8,
          detail: JSON.stringify(response.metrics || response),
        };
      } finally { worker.terminate(); }
    }""")
    ctx.check(GROUP, "DATA-03: worker transfers final typed buffers and load metrics",
              result["pass"], result["detail"], screenshot=False)

    result = page.evaluate("""async () => {
      const buf = window.TestUtils.buildSyntheticFCS(4);
      const summary = window.FCSParser.parse_fcs_header(buf);
      const worker = new Worker(new URL('/js/fcs/data_worker.js', location.origin), { type: 'module' });
      try {
        const response = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('worker timeout')), 3000);
          worker.onmessage = (event) => { clearTimeout(timer); resolve(event.data); };
          worker.onerror = (event) => { clearTimeout(timer); reject(new Error(event.message)); };
          worker.postMessage({ type: 'parse', request_id: 2, file: new File([buf], 'bad-map.fcs'), summary, selected_indexes: [999] });
        });
        return { pass: !response.ok && response.code === 'FCS_PARAMETER_SELECTION_INVALID', detail: JSON.stringify(response) };
      } finally { worker.terminate(); }
    }""")
    ctx.check(GROUP, "DATA-04: wrong mapped indexes and worker exceptions retain a typed per-channel failure",
              result["pass"], result["detail"], screenshot=False)

    result = page.evaluate("""async () => {
      const sizes = [10, 1000, 10000];
      const measurements = [];
      for (const events of sizes) {
        const buffer = window.TestUtils.buildSyntheticFCS(events);
        const summary = window.FCSParser.parse_fcs_header(buffer);
        const parsed = await window.FCSParser.parse_selected_columns_from_blob(
          new Blob([buffer.slice(summary.data_begin, summary.data_end + 1)]),
          summary.metadata, [1, 4], { chunkBytes: 16384 });
        measurements.push({ events, lengths: [parsed.columns[1].length, parsed.columns[4].length], ...parsed.metrics });
      }
      return {
        pass: measurements.every((item) => item.lengths.every((length) => length === item.events)
          && item.peakInputBytes <= 16384 && item.retainedBytes === item.events * 16)
          && measurements[0].sourceBytesRead < measurements[1].sourceBytesRead
          && measurements[1].sourceBytesRead < measurements[2].sourceBytesRead,
        detail: JSON.stringify(measurements),
      };
    }""")
    ctx.check(GROUP, "DATA-03: small/medium/large fixtures stay under the chunk-memory ceiling without value misalignment",
              result["pass"], result["detail"], screenshot=False)

    result = page.evaluate("""() => {
      const buffer = window.TestUtils.buildSyntheticFCS(10);
      const summary = window.FCSParser.parse_fcs_header(buffer);
      const original = window.FCSParser.limits.maxWorkingBytes;
      window.FCSParser.limits.maxWorkingBytes = 1;
      try {
        window.FCSParser.parse_selected_columns(
          buffer.slice(summary.data_begin, summary.data_end + 1), summary.metadata, [1]);
        return { pass: false, detail: 'memory limit was ignored' };
      } catch (error) {
        return { pass: error.code === 'FCS_MEMORY_LIMIT_EXCEEDED'
          && /fewer files|fewer companion channels/.test(error.message), detail: `${error.code}: ${error.message}` };
      } finally { window.FCSParser.limits.maxWorkingBytes = original; }
    }""")
    ctx.check(GROUP, "DATA-03: memory-limit failures are typed and give recovery guidance",
              result["pass"], result["detail"], screenshot=False)

    result = page.evaluate("""async () => {
      const io = await import('/js/io/channel_loading.js');
      const row = (bytes) => ({ summary: { data_begin: 100, data_end: 99 + bytes } });
      const small = io.analysis_file_concurrency([row(1024 * 1024)], 4);
      const large = io.analysis_file_concurrency([row(200 * 1024 * 1024)], 1);
      return { pass: small === 4 && large === 1, detail: JSON.stringify({ small, large }) };
    }""")
    ctx.check(GROUP, "DATA-03: file concurrency adapts to declared DATA size and device memory",
              result["pass"], result["detail"], screenshot=False)

    result = page.evaluate("""async () => {
      const [matrix, manifest] = await Promise.all([
        fetch('/docs/fcs-compatibility.json').then((response) => response.json()),
        fetch('/tests/validation/validation_test_data/synthetic_fcs/manifest.json').then((response) => response.json()),
      ]);
      const cases = new Map(manifest.cases.map((entry) => [entry.id, entry]));
      const fixtures = [...new Set(matrix.cells.flatMap((cell) => cell.fixtures || []))];
      const observed = {};
      for (const id of fixtures) {
        const entry = cases.get(id);
        if (!entry) { observed[id] = 'missing'; continue; }
        const expectation = entry.parser_expectation;
        const buffer = await fetch(`/tests/validation/validation_test_data/synthetic_fcs/${entry.file}`).then((response) => response.arrayBuffer());
        try {
          const summary = window.FCSParser.parse_fcs_header(buffer);
          if (expectation.outcome === 'IMPORT_REJECT') observed[id] = 'accepted';
          else if (expectation.outcome === 'ANALYSIS_BLOCK') {
            const dna = summary.columns.findIndex((label) => /DNA.*-A/i.test(label)) + 1;
            observed[id] = window.FCSParser.channel_eligibility(summary, dna).code;
          } else {
            window.FCSParser.parse_selected_columns(
              buffer.slice(summary.data_begin, summary.data_end + 1), summary.metadata, [1]);
            observed[id] = 'LOAD_OK';
          }
        } catch (error) { observed[id] = error.code || 'untyped'; }
      }
      const expected = (entry) => entry.parser_expectation.outcome === 'LOAD_OK'
        ? 'LOAD_OK' : entry.parser_expectation.code;
      return {
        pass: matrix.cells.every((cell) => cell.fixtures?.length)
          && fixtures.every((id) => cases.has(id) && observed[id] === expected(cases.get(id))),
        detail: JSON.stringify(observed),
      };
    }""")
    ctx.check(GROUP, "DATA-06: every compatibility-matrix cell is generated from a passing supported/rejection fixture",
              result["pass"], result["detail"], screenshot=False)

    result = page.evaluate("""async () => {
      const [reference, manifest] = await Promise.all([
        fetch('/tests/validation/validation_test_data/synthetic_fcs/independent_reader_reference.json').then((response) => response.json()),
        fetch('/tests/validation/validation_test_data/synthetic_fcs/manifest.json').then((response) => response.json()),
      ]);
      const cases = new Map(manifest.cases.map((entry) => [entry.id, entry]));
      const comparisons = [];
      for (const fixture of reference.fixtures) {
        const entry = cases.get(fixture.id);
        const buffer = await fetch(`/tests/validation/validation_test_data/synthetic_fcs/${entry.file}`).then((response) => response.arrayBuffer());
        const summary = window.FCSParser.parse_fcs_header(buffer);
        const indexes = Object.keys(fixture.firstEvent).map((name) => summary.columns.indexOf(name) + 1);
        const columns = window.FCSParser.parse_selected_columns(
          buffer.slice(summary.data_begin, summary.data_end + 1), summary.metadata, indexes);
        for (const [name, expected] of Object.entries(fixture.firstEvent)) {
          const index = summary.columns.indexOf(name) + 1;
          const actual = columns[index][0];
          comparisons.push({ fixture: fixture.id, name, expected, actual,
            pass: Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected)) });
        }
      }
      return { pass: comparisons.length > 0 && comparisons.every((item) => item.pass), detail: JSON.stringify({ reader: reference.reader, comparisons }) };
    }""")
    ctx.check(GROUP, "DATA-01: decoded raw values match independent FlowIO references within tolerance",
              result["pass"], result["detail"], screenshot=False)

    result = page.evaluate("""() => {
      const buf = window.TestUtils.buildSyntheticFCS(4);
      const summary = window.FCSParser.parse_fcs_header(buf);
      const cases = [
        { name: 'empty header', buffer: buf.slice(0, 0), code: 'FCS_HEADER_TRUNCATED' },
        { name: '57-byte header', buffer: buf.slice(0, 57), code: 'FCS_HEADER_TRUNCATED' },
        { name: 'TEXT final byte', buffer: buf.slice(0, summary.header.text_end), code: 'FCS_SEGMENT_RANGE_INVALID' },
        { name: 'DATA final byte', buffer: buf.slice(0, summary.data_end), code: 'FCS_DATA_TRUNCATED' },
      ];
      const observed = cases.map((item) => {
        try { window.FCSParser.parse_fcs_header(item.buffer); return `${item.name}:accepted`; }
        catch (error) { return `${item.name}:${error.code}`; }
      });
      return { pass: cases.every((item, index) => observed[index] === `${item.name}:${item.code}`), detail: JSON.stringify(observed) };
    }""")
    ctx.check(GROUP, "DATA-02: HEADER, TEXT, and DATA truncation boundaries reject deterministically",
              result["pass"], result["detail"], screenshot=False)

    result = page.evaluate("""async () => {
      const base = window.TestUtils.buildSyntheticFCS(8);
      const moduleUrl = new URL('/js/fcs/parser.js', location.origin).href;
      const source = `import { FCSParser } from ${JSON.stringify(moduleUrl)};
        self.onmessage = ({data}) => {
          const started = performance.now();
          const results = data.map((buffer) => {
            try { FCSParser.parse_fcs_header(buffer); return 'accepted'; }
            catch (error) { return error.code || 'error'; }
          });
          self.postMessage({ results, elapsed: performance.now() - started });
        };`;
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      const worker = new Worker(url, { type: 'module' });
      try {
        const mutations = Array.from({ length: 64 }, (_, index) => {
          const copy = new Uint8Array(base.slice(0));
          copy[(index * 37) % Math.min(copy.length, 600)] ^= (index * 29 + 1) & 255;
          return copy.buffer;
        });
        const outcome = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('fuzz worker timeout')), 3000);
          worker.onmessage = (event) => { clearTimeout(timer); resolve(event.data); };
          worker.onerror = (event) => { clearTimeout(timer); reject(new Error(event.message)); };
          worker.postMessage(mutations, mutations);
        });
        return { pass: outcome.results.length === 64 && outcome.elapsed < 2000, detail: JSON.stringify({ elapsed: outcome.elapsed, results: outcome.results }) };
      } finally { worker.terminate(); URL.revokeObjectURL(url); }
    }""")
    ctx.check(GROUP, "DATA-02: deterministic parser fuzzing stays bounded in a worker without crashing",
              result["pass"], result["detail"], screenshot=False)
