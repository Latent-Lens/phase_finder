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

## Unit tests only

`tests/unit/run_standalone.py` runs just the JavaScript unit suites
(`tests/unit/test_harness.html`) against a headless page, independent of the
full e2e driver above:

```bash
/tmp/flowvenv/bin/python tests/unit/run_standalone.py
```

Use this when an e2e failure or hang would otherwise block the unit suites
from running at all, or when you just want a fast correctness check on the
numeric/state modules without paying for the full browser-driven flow. It
does not clear `results/` — it only adds its own timestamped
`unit_only_*.html`/`.md` report there, so it's safe to run alongside or
between full regression runs. Same `--url`/`--headed` flags as `drive_flow.py`.
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
    ├── test_harness.html    ← minimal page loading app ES modules + test helpers
    ├── unit_tests_parser.py ← FCSParser unit tests (window.FCSParser)
    ├── unit_tests_table.py  ← table/data_structs/metadata-wizard unit tests
    ├── unit_tests_djf_pipeline.py ← Stage 0–8 pipeline happy paths
    ├── unit_tests_djf_shared.py   ← shared math, LM, components, and state
    └── unit_tests_djf_edges.py    ← Stage 0–8 boundaries and validation
```

`drive_flow.py` also temporarily moves aside a `sessions/phasefinder_local.json`,
if present, for the duration of the run (restoring it unmodified
afterward). That file is a personal, uncommitted dev-convenience config (see
`sessions/phasefinder_local.example.json`) that can auto-load an arbitrary session and
FCS folder on every page load; left in place, the local test server would
serve it to the app under test exactly like a real browsing session, silently
loading extra files that desync every row-count assertion in this suite.

## What it checks

### E2E — Input/Output
- The locally vendored D3 module loads
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
- Cell Cycle Modeling becomes enabled after plotting
- Turning rows off removes lines; turning them back on restores them
- Data cache retained for unchecked rows
- Channel change clears curves, resets button, reloads data, replots

### E2E — Pre-modeling QC
- Pre-modeling QC toggles (Stage 0&ndash;3) each store their own checkpoint in
  original event order
- Time QC, FSC/SSC gating, and pulse-geometry gating exercise non-skip paths
- Turning on the Cell Gate QC toggle opens a populated scatter/gate editor;
  dragging changes the center, the coverage control resizes the ellipse, both
  change the authoritative raw-index mask, reset restores the fitted gate,
  and the Singlet Gate consumes the manually edited retained-event set
- The Stage 4 histogram is rebuilt automatically and stays current
- Rerunning an upstream gate clears its own downstream mask
- The compacted filtered view stays index-aligned with the recomputed final mask

### E2E — Modeling (Identify Peaks)
- Detect Peaks proposes an ordered, valid G1/G2 region pair with a status and
  confidence readout, reflected in the sidebar's numeric inputs
- An invalid manual region edit (breaks L1 &lt; R1 &le; L2 &lt; R2) shows an
  inline error and leaves the stored regions untouched
- A valid manual edit commits as "manual", marks the regions reviewed, and
  clears the error
- Reset restores the detector's automatic region proposal
- Accept marks the current regions reviewed

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

### Unit — staged DJF shared helpers (`window.DJFShared`)
- Robust statistics: median, MAD, mean, population variance, interpolated
  quantiles, residual-scale floors, nearest indexes, and safe fractions
- Gaussian/log-domain helpers: peak symmetry, boundary-normalized smoothing,
  stable logistic/log-sum-exp, and full-covariance 2D log density
- Trapezoidal integration for arrays, typed arrays, nonuniform spacing, and
  invalid input shapes
- 2D covariance, regularization, inversion, eigendecomposition, Mahalanobis
  distance, weighted moments, and signed ridge distances
- Shared Levenberg-Marquardt primitives: pivoting solve, singular-system errors,
  normal equations, finite-difference Jacobians, projection boundaries,
  convergence, and exhausted iteration budgets
- DJF Gaussian/S-bridge component invariants
- Pipeline state identity, mask composition, compacted-view original indexes,
  downstream invalidation, and metadata-table loss funnels

### Unit — staged DJF boundaries and validation
- Stage 0 PnR overrides, Time exemption, missing input, and length mismatches
- Stage 1 invalid-time segmentation, balanced bins, zero-MAD scoring, dynamic
  metric exclusion, interval merging, and composed masks
- Stage 2 deterministic initialization, minimum-event skip, component-weight
  selection, and inclusive ellipse boundaries
- Stage 3 masked/nonfinite points, zero-MAD ridge behavior, k-MAD validation,
  and insufficient-point skip behavior
- Stage 4 constant ranges, clipping, exact-maximum binning, and invalid inputs
- Stage 5 plateau maxima, prominence, and ratio validation
- Stage 6 histogram validation, parameter projection, residual weighting, and
  unlocked ratio bounds
- Stage 7 correlation, BIC penalty, three-part model-selection criteria, and
  previous-fit validation
- Stage 8 parameter counting, residual diagnostics, pulse-geometry inference,
  percentage formatting, and curve validation
- Orchestrator stage-number errors and shared batch histogram ranges

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
