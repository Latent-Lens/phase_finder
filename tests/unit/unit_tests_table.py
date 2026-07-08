#!/usr/bin/env python3
"""Unit tests for table/metadata helpers in js/data_structs/ and js/ui/.

These are pure-logic pieces of the table: the PhaseFinderFrame column store,
frame construction/concatenation, filename-metadata-wizard field naming and
splitting, the (currently unused but still reachable) legacy filename guesser,
and small formatting helpers. None of them touch the DOM, so these files can
be loaded directly into the harness page without the rest of the app.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext

GROUP = "Unit / Table & Metadata"

_FULL_SUITE = """() => {
  const results = [];
  const push = (name, pass, detail) => results.push({ name, pass: Boolean(pass), detail: detail ?? '' });

  // ---- PhaseFinderFrame -----------------------------------------------
  const frame = new PhaseFinderFrame({ id: ['a', 'b'], name: ['x.fcs', 'y.fcs'] }, ['id', 'name']);
  push('PhaseFinderFrame: length reflects the row count of the first column',
       frame.length === 2, 'length=' + frame.length);
  push('PhaseFinderFrame: columns() returns the ordered column list',
       JSON.stringify(frame.columns) === JSON.stringify(['id', 'name']), JSON.stringify(frame.columns));
  push('PhaseFinderFrame: col() returns the backing array',
       JSON.stringify(frame.col('name')) === JSON.stringify(['x.fcs', 'y.fcs']), JSON.stringify(frame.col('name')));
  push('PhaseFinderFrame: col() returns [] for an absent column',
       JSON.stringify(frame.col('missing')) === '[]', JSON.stringify(frame.col('missing')));

  frame.setCol('strain', ['76', '77']);
  push('PhaseFinderFrame: setCol() appends a brand-new column to columns()',
       frame.columns.includes('strain') && frame.columns.length === 3, JSON.stringify(frame.columns));
  frame.setCol('name', ['renamed1.fcs', 'renamed2.fcs']);
  push('PhaseFinderFrame: setCol() replaces an existing column without duplicating it',
       frame.columns.filter((c) => c === 'name').length === 1 && frame.col('name')[0] === 'renamed1.fcs',
       JSON.stringify(frame.columns));

  const emptyFrame = new PhaseFinderFrame({}, []);
  push('PhaseFinderFrame: length is 0 for a frame with no columns',
       emptyFrame.length === 0, 'length=' + emptyFrame.length);

  // ---- make_frame -------------------------------------------------------
  const built = make_frame([{ id: '1', name: 'a.fcs' }, { id: '2', name: 'b.fcs' }]);
  push('make_frame: builds columns from row object keys in first-seen order',
       JSON.stringify(built.columns) === JSON.stringify(['id', 'name']), JSON.stringify(built.columns));
  push('make_frame: preserves per-row values',
       built.col('id')[0] === '1' && built.col('name')[1] === 'b.fcs',
       JSON.stringify({ id: built.col('id'), name: built.col('name') }));
  const emptyBuilt = make_frame([]);
  push('make_frame: an empty row array yields a 0-length, 0-column frame',
       emptyBuilt.length === 0 && emptyBuilt.columns.length === 0,
       `length=${emptyBuilt.length} columns=${JSON.stringify(emptyBuilt.columns)}`);

  // ---- concat_frames ------------------------------------------------------
  const f1 = make_frame([{ id: '1', name: 'a.fcs', strain: '76' }]);
  const f2 = make_frame([{ id: '2', name: 'b.fcs', timepoint: '30' }]);
  const combined = concat_frames(f1, f2);
  push('concat_frames: preserves frame1 column order then appends frame2-only columns',
       JSON.stringify(combined.columns) === JSON.stringify(['id', 'name', 'strain', 'timepoint']),
       JSON.stringify(combined.columns));
  push('concat_frames: total row count is the sum of both frames',
       combined.length === 2, 'length=' + combined.length);
  push('concat_frames: fills a column missing from frame2 with null in frame2 rows',
       combined.col('strain')[1] === null, JSON.stringify(combined.col('strain')));
  push('concat_frames: fills a column missing from frame1 with null in frame1 rows',
       combined.col('timepoint')[0] === null, JSON.stringify(combined.col('timepoint')));
  push('concat_frames: keeps distinct per-row values for shared columns',
       combined.col('id')[0] === '1' && combined.col('id')[1] === '2', JSON.stringify(combined.col('id')));

  // ---- metadata_field_from_label ------------------------------------------
  const used1 = new Set();
  const strainField = metadata_field_from_label('Strain', used1);
  push('metadata_field_from_label: known label "Strain" maps to field "strain"',
       strainField === 'strain', strainField);
  const arrestField = metadata_field_from_label('Nocodazole Arrest', new Set());
  push('metadata_field_from_label: known label "Nocodazole Arrest" maps to "nocodazoleArrest"',
       arrestField === 'nocodazoleArrest', arrestField);
  const cellTypeField = metadata_field_from_label('Cell Type', new Set());
  push('metadata_field_from_label: unknown label is camelCased ("Cell Type" -> "cellType")',
       cellTypeField === 'cellType', cellTypeField);
  push('metadata_field_from_label: a label starting with a digit is prefixed with "metadata"',
       /^metadata/.test(metadata_field_from_label('2nd Pass', new Set())),
       metadata_field_from_label('2nd Pass', new Set()));
  push('metadata_field_from_label: colliding with reserved "id"/"name" appends "Metadata"',
       metadata_field_from_label('id', new Set()) === 'idMetadata'
       && metadata_field_from_label('name', new Set()) === 'nameMetadata',
       `${metadata_field_from_label('id', new Set())}, ${metadata_field_from_label('name', new Set())}`);
  const usedDup = new Set();
  const first = metadata_field_from_label('Strain', usedDup);
  const second = metadata_field_from_label('Strain', usedDup);
  push('metadata_field_from_label: a repeated label gets a numeric suffix to stay unique',
       first === 'strain' && second === 'strain2', `${first}, ${second}`);

  // ---- split_filename_metadata --------------------------------------------
  const delimiterSpec = { steps: [{ type: 'delimiter', delimiter: '_' }] };
  const delimParts = split_filename_metadata('WT_1_no_0min.fcs', delimiterSpec);
  push('split_filename_metadata: a single delimiter step yields [left, remainder]',
       JSON.stringify(delimParts) === JSON.stringify(['WT', '1_no_0min']), JSON.stringify(delimParts));

  const fixedSpec = { steps: [{ type: 'fixed', breaks: [2] }] };
  const fixedParts = split_filename_metadata('A1D001', fixedSpec);
  push('split_filename_metadata: a fixed-width step splits at the given character position',
       JSON.stringify(fixedParts) === JSON.stringify(['A1', 'D001']), JSON.stringify(fixedParts));

  const regexCaptureSpec = { steps: [{ type: 'regex', pattern: '^(\\\\d+)' }] };
  const regexCaptureParts = split_filename_metadata('900aN_t35', regexCaptureSpec);
  push('split_filename_metadata: a regex step with a capture group uses the captured text as the value',
       JSON.stringify(regexCaptureParts) === JSON.stringify(['900', 'aN_t35']), JSON.stringify(regexCaptureParts));

  const regexNoCaptureSpec = { steps: [{ type: 'regex', pattern: '_' }] };
  const regexNoCaptureParts = split_filename_metadata('strain_76_rep1', regexNoCaptureSpec);
  push('split_filename_metadata: a regex step with no capture group splits on the match boundary',
       JSON.stringify(regexNoCaptureParts) === JSON.stringify(['strain', '76_rep1']), JSON.stringify(regexNoCaptureParts));

  const chainedSpec = {
    steps: [
      { type: 'delimiter', delimiter: '_' },
      { type: 'regex', pattern: '^(\\\\d+)' },
      { type: 'regex', pattern: '^([A-Za-z])' },
      { type: 'regex', pattern: '^([A-Za-z])' },
      { type: 'regex', pattern: 't(\\\\d+)' },
    ],
  };
  const chainedParts = split_filename_metadata('EDS2026-03-06_900aN t35__E2E1.0001', chainedSpec);
  push('split_filename_metadata: chained delimiter+regex steps extract strain/replicate/arrest/timepoint',
       JSON.stringify(chainedParts) === JSON.stringify(['EDS2026-03-06', '900', 'a', 'N', '35', '__E2E1.0001']),
       JSON.stringify(chainedParts));

  const noMatchSpec = { steps: [{ type: 'regex', pattern: 'ZZZ_NOT_PRESENT' }] };
  const noMatchParts = split_filename_metadata('plain_filename', noMatchSpec);
  push('split_filename_metadata: a non-matching regex step leaves the text whole with an empty remainder',
       JSON.stringify(noMatchParts) === JSON.stringify(['plain_filename', '']), JSON.stringify(noMatchParts));

  // ---- guess_annotations_from_filename (legacy helper, still reachable) --
  const coreGuess = guess_annotations_from_filename('EDS2026-03-06_76aN t55__A1.0001.fcs');
  push('guess_annotations_from_filename: parses the core strain/replicate/arrest/timepoint token',
       coreGuess.strain === '76' && coreGuess.replicate === 'a'
       && coreGuess.nocodazoleArrest === 'N' && coreGuess.timepoint === '55',
       JSON.stringify(coreGuess));
  const fallbackGuess = guess_annotations_from_filename('WT t30__B1.fcs');
  push('guess_annotations_from_filename: falls back to strain+timepoint and replicate tokens when the core pattern misses',
       fallbackGuess.strain === 'WT' && fallbackGuess.timepoint === '30' && fallbackGuess.replicate === 'B1',
       JSON.stringify(fallbackGuess));
  const noGuess = guess_annotations_from_filename('unstructured.fcs');
  push('guess_annotations_from_filename: returns blank fields when nothing recognizable is found',
       noGuess.strain === '' && noGuess.replicate === '' && noGuess.nocodazoleArrest === '' && noGuess.timepoint === '',
       JSON.stringify(noGuess));

  // ---- timepoint_sort_value -------------------------------------------
  push('timepoint_sort_value: parses a numeric string to a number',
       timepoint_sort_value('30') === 30, String(timepoint_sort_value('30')));
  push('timepoint_sort_value: non-numeric values sort to +Infinity (last)',
       timepoint_sort_value('n/a') === Infinity, String(timepoint_sort_value('n/a')));

  // ---- display_name / annotation_input_size / parse_fixed_breaks --------
  push('display_name: strips a trailing .fcs extension case-insensitively',
       display_name('Sample.FCS') === 'Sample', display_name('Sample.FCS'));
  push('display_name: leaves non-.fcs text alone',
       display_name('Sample.0001') === 'Sample.0001', display_name('Sample.0001'));

  push('annotation_input_size: clamps small values up to a minimum width',
       annotation_input_size('') === 4, String(annotation_input_size('')));
  push('annotation_input_size: clamps long values down to a maximum width',
       annotation_input_size('x'.repeat(60)) === 28, String(annotation_input_size('x'.repeat(60))));
  push('annotation_input_size: fits short values to content length + 1',
       annotation_input_size('abc') === 4, String(annotation_input_size('abc')));

  push('parse_fixed_breaks: parses, sorts, and dedupes comma/space-separated positions',
       JSON.stringify(parse_fixed_breaks('5, 2 5 8,2')) === JSON.stringify([2, 5, 8]),
       JSON.stringify(parse_fixed_breaks('5, 2 5 8,2')));
  push('parse_fixed_breaks: ignores non-positive and non-numeric junk',
       JSON.stringify(parse_fixed_breaks('0, -3, abc, 4')) === JSON.stringify([4]),
       JSON.stringify(parse_fixed_breaks('0, -3, abc, 4')));

  // ---- metadata import helpers --------------------------------------------
  const parsedTsv = parse_delimited_metadata('Filename\\tCondition\\tDose\\nA.fcs\\tcontrol\\t0\\nB.fcs\\tdrug\\t10\\n');
  push('parse_delimited_metadata: parses TSV headers and records',
       parsedTsv.headers[0] === 'Filename' && parsedTsv.records.length === 2
       && parsedTsv.records[1].Condition === 'drug',
       JSON.stringify(parsedTsv));

  const parsedCsv = parse_delimited_metadata('Filename,Note\\nA.fcs,\"alpha, beta\"\\n');
  push('parse_delimited_metadata: preserves quoted CSV commas',
       parsedCsv.records[0].Note === 'alpha, beta', JSON.stringify(parsedCsv.records[0]));

  push('find_metadata_filename_column: recognizes common filename headers',
       find_metadata_filename_column(['Sample Name', 'Condition']) === 'Sample Name',
       find_metadata_filename_column(['Sample Name', 'Condition']));

  push('metadata_filename_key: strips paths and .fcs extensions case-insensitively',
       metadata_filename_key('C:/data/Sample_01.FCS') === 'sample_01',
       metadata_filename_key('C:/data/Sample_01.FCS'));

  const loadedIndex = loaded_file_index_by_metadata_key([
    { name: 'Alpha.fcs' },
    { name: 'Beta.fcs' },
  ]);
  push('loaded_file_index_by_metadata_key: maps imported filenames to loaded FCS rows',
       loadedIndex.get(metadata_filename_key('/tmp/Alpha.FCS')) === 0
       && loadedIndex.get(metadata_filename_key('Beta')) === 1
       && !loadedIndex.has(metadata_filename_key('Gamma.fcs')),
       JSON.stringify([...loadedIndex.entries()]));

  const importedBuild = build_metadata_frame_from_records(
    [
      { name: 'Alpha.fcs', condition: 'control', dose: '0' },
      { name: 'Missing.fcs', condition: 'drug', dose: '10' },
    ],
    [
      { field: 'condition', label: 'Condition', headerEditable: true, source: 'import' },
      { field: 'dose', label: 'Dose', headerEditable: true, source: 'import' },
    ],
    [{ id: 'loaded-alpha', name: 'Alpha.fcs' }],
    { source: 'import' },
  );
  push('build_metadata_frame_from_records: preserves imported row order',
       JSON.stringify(importedBuild.frame.col('name')) === JSON.stringify(['Alpha.fcs', 'Missing.fcs']),
       JSON.stringify(importedBuild.frame.col('name')));
  push('build_metadata_frame_from_records: links matching rows and flags unmatched rows',
       importedBuild.matched === 1
       && importedBuild.unmatched === 1
       && importedBuild.frame.col('id')[0] === 'loaded-alpha'
       && String(importedBuild.frame.col('id')[1]).startsWith('metadata-unlinked-'),
       JSON.stringify({ matched: importedBuild.matched, unmatched: importedBuild.unmatched, ids: importedBuild.frame.col('id') }));
  push('build_metadata_frame_from_records: preserves imported metadata values',
       importedBuild.frame.col('condition')[0] === 'control'
       && importedBuild.frame.col('dose')[1] === '10',
       JSON.stringify({ condition: importedBuild.frame.col('condition'), dose: importedBuild.frame.col('dose') }));

  const duplicateBuild = build_metadata_frame_from_records(
    [
      { name: 'Alpha.fcs', condition: 'first' },
      { name: '/other/path/alpha.FCS', condition: 'duplicate' },
    ],
    [{ field: 'condition', label: 'Condition', headerEditable: true }],
    [{ id: 'loaded-alpha', name: 'Alpha.fcs' }],
    { source: 'import' },
  );
  push('build_metadata_frame_from_records: duplicate imported filenames link deterministically to the first row only',
       duplicateBuild.matched === 1
       && duplicateBuild.duplicates === 1
       && duplicateBuild.frame.col('id')[0] === 'loaded-alpha'
       && String(duplicateBuild.frame.col('id')[1]).startsWith('metadata-unlinked-'),
       JSON.stringify({ matched: duplicateBuild.matched, duplicates: duplicateBuild.duplicates, ids: duplicateBuild.frame.col('id') }));

  const duplicateColumns = normalize_metadata_columns([
    { label: 'Condition', source: 'manual', headerEditable: true },
    { label: 'Condition', source: 'manual', headerEditable: true },
  ]);
  push('normalize_metadata_columns: duplicate labels are made unique for editable metadata columns',
       duplicateColumns[0].label === 'Condition' && duplicateColumns[1].label === 'Condition 2'
       && duplicateColumns[0].field !== duplicateColumns[1].field,
       JSON.stringify(duplicateColumns));

  return results;
}"""


def run_table_tests(ctx: TestContext):
    page = ctx.page

    try:
        all_results = page.evaluate(_FULL_SUITE)
    except Exception as err:
        ctx.check(GROUP, "Table/metadata suite setup", False, str(err), screenshot=False)
        return

    for item in all_results:
        ctx.check(GROUP, item["name"], item["pass"], item.get("detail", ""), screenshot=False)
