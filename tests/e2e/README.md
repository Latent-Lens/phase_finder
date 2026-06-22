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

## File layout

```
tests/
├── e2e/
│   ├── drive_flow.py       ← entry point
│   ├── helpers.py          ← TestContext, all helpers, report writers
│   ├── tests_io.py         ← library + file loading tests
│   ├── tests_filtering.py  ← sort + filter tests
│   ├── tests_plotting.py   ← plotting + channel change tests
│   ├── tests_modeling.py   ← DJF modeling tests
│   ├── tests_sidebar.py    ← collapsed sidebar icon tests
│   ├── tests_reset.py      ← restart + logo reset tests
│   └── results/
└── unit/
    ├── run_unit_tests.py   ← unit test orchestrator
    ├── test_harness.html   ← minimal page loading CDN libs + parser/DJF JS
    ├── unit_tests_parser.py← FCSParser unit tests (window.FCSParser)
    └── unit_tests_djf.py   ← DJF model unit tests (window.PhaseFinderDJF)
```

## What it checks

### E2E — Input/Output
- D3 / Levenberg–Marquardt / ml-gsd CDN libraries load
- File loading via drag-and-drop (expanded sidebar)
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

### E2E — Reset
- Restart button clears table, hides plot panel, resets status bar and channel
- Site logo click does the same

### Unit — FCS Parser (`window.FCSParser`)
- `parseFCSHeader`: version string, textBegin, dataBegin/textEnd ordering
- `parseFCSHeader`: eventCount, parameterCount, channel column names
- `parseFCSHeader`: throws on buffer < 58 bytes and non-FCS headers
- `parseFCS`: reads event rows and numeric channel values
- `parseSelectedColumns`: selected channels match full parse and invalid indexes throw
- `parseFCSHeaderFromSegments`: sliced HEADER/TEXT parsing matches full header parsing

### Unit — DJF Model (`window.PhaseFinderDJF`)
- `fit`: returns a non-null result on valid bimodal histogram
- `fit`: G1 center in expected range, G2/G1 ratio ≈ 2
- `fractions`: sum ≈ 100 %, each phase ≥ 0
- `estimateRunG1`: returns a positive value
- `components`: evaluates to > 0 at G1 peak
- `findAuxiliaryIndexes`: links DNA-A to matching height/width channels
- `prepareRow` / `correctionSummary`: correction stats and unavailable doublet-channel messaging
