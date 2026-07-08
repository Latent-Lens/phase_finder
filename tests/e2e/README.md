# End-to-end + Unit test driver

`drive_flow.py` is the single entry point. It launches the real app in headless
Chromium (Playwright), records a per-test WebM video via ffmpeg, runs the full
e2e pipeline, then runs JavaScript unit tests against a minimal test harness
page. Both result sets are combined into a single timestamped HTML + Markdown
report in `results/`.

## One-time setup

```bash
python3 -m venv /tmp/flowvenv
/tmp/flowvenv/bin/pip install playwright
/tmp/flowvenv/bin/python -m playwright install chromium
```

ffmpeg must be on `$PATH` for per-test video clips (`apt install ffmpeg` on
Ubuntu). Without it the run still completes — it just falls back to screenshots.

## Run

Run the driver (it will automatically start a background server on a free port):

```bash
/tmp/flowvenv/bin/python tests/e2e/drive_flow.py
```

Flags:
- `--files N` — initial FCS files to load (default 4, minimum 2)
- `--extra-files N` — additional unique files to append (default 2)
- `--data DIR` — FCS directory (defaults to generated synthetic FCS fixtures)
- `--url` — app URL (default `http://localhost:8731/index.html`)
- `--channel` — preferred DNA area channel (default `GFP/FITC-A`)
- `--headed` — run with a visible browser window

Synthetic FCS fixtures are generated under `tests/test_data/` when `--data` is
omitted. `drive_flow.py` clears that directory at the start of each run before
creating fresh synthetic inputs.

Reports are written to `results/` (e.g. `results/flow_e2e_20260617-143000.html`).
Screenshots are written to `results/assets/img/`, and WebM recordings/clips are
written to `results/assets/vid/`. At the start of each run, `drive_flow.py`
clears both asset directories and removes old root-level HTML/Markdown reports
plus legacy root-level `flow_e2e_*.png`, `flow_e2e_*.webm`, and `page@*.webm`
artifacts.
The directory is tracked but its contents are git-ignored.

## Commit-time regression gate

This repository includes a tracked Git hook in `.githooks/pre-commit`. Enable it
once per clone:

```bash
git config core.hooksPath .githooks
```

After it is enabled, `git commit` runs the full e2e + unit regression driver:

```bash
/tmp/flowvenv/bin/python tests/e2e/drive_flow.py
```

The hook blocks the commit if the worktree has unstaged tracked changes or
untracked non-ignored files, because the tests run against the working tree and
should cover exactly what is being committed. If your Playwright environment is
not at `/tmp/flowvenv/bin/python`, set `PHASEFINDER_TEST_PYTHON` to the Python
executable that has Playwright installed.

During commit-time test runs, the hook also writes live output to a stable log
file that can be tailed from another terminal:

```bash
tail -f tests/e2e/results/pre_commit_latest.log
```

## File layout

```
tests/
├── e2e/
│   ├── drive_flow.py            ← entry point
│   ├── helpers.py                ← TestContext, all helpers, report writers
│   ├── tests_io.py                ← library + file loading tests
│   ├── tests_filtering.py         ← sort + filter tests
│   ├── tests_plotting.py          ← plotting + channel change tests
│   ├── tests_modeling.py          ← DJF modeling tests
│   ├── tests_sidebar.py           ← collapsed sidebar icon tests
│   ├── tests_stats.py             ← Calculate Statistics modal tests
│   ├── tests_metadata_wizard.py   ← filename metadata wizard + TSV export tests
│   ├── tests_reset.py             ← site-logo reset tests
│   └── results/
└── unit/
    ├── run_unit_tests.py    ← unit test orchestrator
    ├── test_harness.html    ← minimal page loading CDN libs + app JS helpers
    ├── unit_tests_parser.py ← FCSParser unit tests (window.FCSParser)
    ├── unit_tests_table.py  ← table/data_structs/metadata-wizard unit tests
    └── unit_tests_djf.py    ← DJF model unit tests (window.PhaseFinderDJF)
```

`drive_flow.py` also temporarily moves aside a `phasefinder_local.json` in the
repo root, if present, for the duration of the run (restoring it unmodified
afterward). That file is a personal, uncommitted dev-convenience config (see
`phasefinder_local.example.json`) that can auto-load an arbitrary session and
FCS folder on every page load; left in place, the local test server would
serve it to the app under test exactly like a real browsing session, silently
loading extra files that desync every row-count assertion in this suite.

## What it checks

### E2E — Input/Output
- D3 / Levenberg–Marquardt / ml-gsd CDN libraries load
- File loading via drag-and-drop (expanded sidebar)
- The filename metadata wizard auto-opens once, after the very first file
  load, and is configured here (Strain/Replicate/Nocodazole Arrest/Timepoint
  via regex split steps) — downstream sort/filter/plotting/DJF-annotation
  tests all depend on these columns existing
- File loading via file-browser click (expanded sidebar)
- Progress overlay appears and hides during file loading
- Status bar updates after load
- Duplicate file rejection with status-bar warning
- Additional unique files append without replacing the table
- Synthetic filename annotations populate replicate, arrest, and timepoint columns
- Collapsed sidebar upload icon — file browser
- Collapsed sidebar upload icon — drag-and-drop
- No uncaught JavaScript page errors

### E2E — Filtering
- Filename / Strain / Replicate / Timepoint column sort (ascending ↔ descending)
- Strain / Replicate / Nocodazole Arrest / Timepoint filter: apply, verify row count, clear
- Select-all checkbox selects and deselects all rows

### E2E — Plotting
- GFP/FITC-A channel selection (or best available)
- Progress overlay during Plot Channel Events
- Plot a strict subset of rows, verify curve count
- Plot all rows, verify count, title, and y-axis label
- Button transitions Plot Channel Events → Start Modeling (DJF)
- Turning rows off removes lines; turning them back on restores them
- Data cache retained for unchecked rows
- Channel change clears curves, resets button, reloads data, replots

### E2E — Modeling
- Start Modeling (DJF) produces one visible fit
- G1 + S + G2 fractions sum to ~100 %
- DJF fit table appears with title and phase rows
- Status bar updates after modeling completes
- Debris correction updates readout
- Doublet correction updates readout
- Peak threshold line appears

### E2E — Sidebar/Icons
- Collapsed sidebar shows upload / channel / histogram icons
- Upload icon tooltip text
- Collapsed channel select mirrors expanded select
- Collapsed histogram icon is enabled
- Collapsed histogram icon click triggers replot

### E2E — Summary Statistics
- Calculate Statistics modal opens; Mean/Std Dev checked by default
- Computing Mean/Std Dev/Median adds a grouped column header and correct per-file values
- Reopening the modal disables already-computed statistics for the selected channel
- The "All" checkbox only checks the remaining enabled (not-yet-computed) statistics
- Min/Max compute correctly and stay consistent with the mean
- Escape closes the modal
- Files loaded after a stat has been computed automatically receive it, with no need to reopen the modal

### E2E — Metadata Wizard
- Opens via the table title-bar icon; "Filename Only" resets to a single default step
- Fixed-width step: typing a width and clicking "Set" fills in the break position
- The live preview reflects delimiter/fixed-width/regex steps and hidden columns
- Apply commits columns in configured order with correct per-file split values
- Cancel discards in-progress edits without touching the already-applied table
- TSV export (via the pure `metadata_table_tsv()` helper, and — where the browser
  doesn't expose `showSaveFilePicker` — an actual download) includes every
  configured column and its values

### E2E — Reset
- Site logo click clears the table, hides the plot panel, and resets status bar and channel

### Unit — FCS Parser (`window.FCSParser`)
- `parseFCSHeader`: version string, textBegin, dataBegin/textEnd ordering
- `parseFCSHeader`: eventCount, parameterCount, channel column names
- `parseFCSHeader`: throws on buffer < 58 bytes and non-FCS headers
- `parseFCS`: reads event rows and numeric channel values
- `parseSelectedColumns`: selected channels match full parse, an empty index
  list returns `{}`, and invalid indexes throw
- `parseFCSHeaderFromSegments`: sliced HEADER/TEXT parsing matches full header parsing
- `$DATATYPE I` (16-bit integer) files: header metadata, full parse, and
  `parseSelectedColumns` all read correct values (previously only `F` was covered)

### Unit — DJF Model (`window.PhaseFinderDJF`)
- `fit`: returns a non-null result on valid bimodal histogram
- `fit`: G1 center in expected range, G2/G1 ratio ≈ 2
- `fractions`: sum ≈ 100 %, each phase ≥ 0
- `estimateRunG1`: returns a positive value on one histogram, and picks the
  median (not the min/max) G1 position across several series
- `components`: evaluates to > 0 at G1 peak
- `findAuxiliaryIndexes`: links DNA-A to matching height/width channels, and
  to a height-only or width-only channel when only one side is linkable
- `prepareRow` / `correctionSummary`: correction stats, unavailable
  doublet-channel messaging, and actual doublet-outlier removal when
  height/width channels are available

### Unit — Table & Metadata (`js/ui/`)
- `PhaseFinderFrame` / `make_frame` / `concat_frames`: column storage,
  construction from rows, and concatenation with missing-column null-filling
- `metadata_field_from_label`: known-label mapping, camelCasing, reserved-name
  and duplicate-label collision handling
- `split_filename_metadata`: delimiter, fixed-width, and regex (with/without a
  capture group) split steps, chained multi-step splits, and non-matching steps
- `guess_annotations_from_filename`: legacy filename-guessing fallback paths
- `timepoint_sort_value`, `display_name`, `annotation_input_size`,
  `parse_fixed_breaks`: small formatting/parsing helpers
