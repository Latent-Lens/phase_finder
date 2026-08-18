# PhaseFinder

PhaseFinder is a browser-based tool for inspecting and plotting flow cytometry
`.fcs` files. It is designed as a lightweight, local-first workspace: users drop
FCS files into the page, the app reads the FCS header and TEXT metadata in the
browser, and selected samples can then be loaded into an overlaid DNA-content
event histogram with optional Dean–Jett–Fox cell-cycle modeling.

The project currently focuses on a specific analysis workflow:

1. Load one or more FCS files from disk.
2. Review the detected sample metadata in a sortable, filterable table.
3. Edit sample annotations such as strain, replicate, nocodazole arrest status,
   and timepoint.
4. Choose the DNA-content area channel.
5. Check the samples to analyze.
6. Generate an overlaid event histogram for the selected files.
7. Review G1/G2 peak regions and fit Dean–Jett, Dean–Jett–Fox, Watson
   Pragmatic, Watson Classic, or CLOCCS (Unverified).

Files are read by browser APIs. There is no upload server or database. Vite
builds the static production artifact used by the release workflow.

### Browser support

PhaseFinder supports Chrome/Edge 111+, Firefox 121+, Safari 16.2+, Chrome for
Android 111+, and iOS Safari 16.2+. CI exercises current Chromium, Firefox, and
WebKit because Playwright does not distribute historical engines; these minimums
are the feature baseline, while current stable releases are recommended.
Web Workers, WebAssembly, IndexedDB, CSS Grid, and `inert` are required and are
checked at startup. OPFS and persistent folder access are optional: without
them, analysis remains in memory and session reconnect falls back to manual file
selection. The startup report is available as `window.PhaseFinderCompatibility`.

### Statistical metric comparability

Poisson log-likelihood includes the full `log(y!)` term and therefore matches standard external tools for the same observed histogram. AIC, AICc, and BIC use the number of fitted bins as `n` and the number of optimizer-moved parameters as `k`. Information-criterion differences are valid between models fitted to the same histogram only; they must not be ranked across samples, binning schemes, or different observed counts. Deviance and reduced deviance describe fit to their own histogram, while phase fractions remain the appropriate cross-sample biological outputs.

## Development

Use Node 24 (the exact major is pinned in `.nvmrc`) and Python 3.12:

```bash
npm ci
python3 -m venv .venv
./.venv/bin/python -m pip install --requirement requirements-dev.txt
./.venv/bin/python -m playwright install chromium
npm test
npm run build
npm run check:dist
npm run preview
```

### Which Python the tests use

Every `npm run test:*` script goes through `scripts/python.sh`, which resolves
the interpreter in the same order as the pre-commit hook:
`$PHASEFINDER_TEST_PYTHON`, then `./.venv/bin/python`, then `python3`. Creating
`.venv` as above is therefore enough; no environment variable is needed. `.venv`
may also be a symlink to an interpreter kept outside the checkout, and it is
gitignored either way.

This indirection exists because a bare `python3` is frequently a shim without
playwright installed, which fails the browser suites while a perfectly good
environment sits unused.

Two Python environments are involved and they are **not** interchangeable:

| Environment | Purpose | Installed from |
| --- | --- | --- |
| `.venv` | browser unit/e2e suites (`npm test`, `npm run check`) | `requirements-dev.txt` |
| `tests/external_tools/.venv` | independent-tool comparison harness — flowio, flowkit, numpy, scikit-learn, plus an R library tree | its own scripts under `tests/external_tools/`; see that directory's README |

The external-tools environment is large (>1 GB with `rlib/` and `results/`),
reconstructible from its scripts, and fully gitignored. It does not read
`requirements-dev.txt`, and nothing in `npm run check` depends on it.

`npm run dev` serves the source module graph for development. `npm run build`
creates the reviewed production artifact under `dist/`, and `npm run preview`
serves only that artifact. Opening either entry point with `file://` does not
work because browser module and worker loading requires HTTP. The combined
`npm run check` command runs CI contract tests, the browser unit suite,
production build, privacy checks, and artifact integrity checks.
Use `BASE_PATH=/phasefinder/ npm run build` for a non-root deployment; run
`npm run check:base` to build and verify that supported base path locally.
Release containment, rollback, artifact URL, and privacy policy are documented
in [`docs/release-and-privacy.md`](docs/release-and-privacy.md).
PhaseFinder is licensed under PolyForm Noncommercial 1.0.0; vendored dependency attribution is recorded in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Project Structure

```text
.
├── index.html
├── help/                 # topic-based in-app help center, linked from the footer
├── assets/
│   └── img/
│       ├── logo.png
│       ├── chevron-down-icon.svg
│       ├── chevron-right-icon.svg
│       └── favicon/
├── css/
│   ├── base.css         # tokens, reset, typography, base form controls
│   ├── layout.css       # header, app grid, panels, panel titles, Start button
│   ├── sidebar.css      # drop zone, channel controls, status text
│   ├── table.css        # metadata table, sort headers, filter dropdowns
│   ├── plot.css         # plot panel layout, controls bar, DJF readout
│   ├── feedback.css     # status bar and progress overlay
│   ├── responsive.css   # @media overrides (loaded last)
│   └── help.css         # standalone stylesheet for the help center
├── js/
│   ├── vendor/          # vendored D3 ESM bundle
│   ├── state/           # app_state (file_map + frame accessors), file-selection queries
│   ├── util/            # leaf string helpers (HTML escaping, filename transforms)
│   ├── analysis/        # QC + cell-cycle modeling pipeline (lazy-loaded), orchestration, summary stats
│   ├── data_structs/    # frame, table state, metadata columns, channel cache
│   ├── fcs/             # FCS parser, metadata reader, channel cleanup, module worker
│   ├── io/              # FCS/metadata loading, parameter map, table import/export
│   ├── plotting/        # D3 histogram rendering, axis modal, and DJF report UI
│   ├── session/         # TOML save/load, OPFS filesystem + file cache, reconnect flow
│   ├── ui/              # DOM refs, metadata table, wizard, panels, status/channel controls
│   └── main.js          # ES-module entry: init_*() bootstrap + window.PhaseFinder hook
├── docs/
│   ├── code-flow-diagrams.html                  # interactive Mermaid architecture/runtime diagrams
│   ├── function-call-and-user-decision-graphs.html # interactive call + decision diagrams
│   └── *.md                                     # canonical Mermaid sources for those pages
├── tests/
│   ├── e2e/             # driver, test data, generated reports and media
│   ├── unit/            # driver, unit checks, and browser test harness
│   └── validation/      # driver, synthetic/external data, and reports
└── misc/
    └── README.md
```

Note: the file list above is a high-level map, not exhaustive. The app loads as
native ES modules: `index.html` has a single `<script type="module"
src="./js/main.js">`, and `js/main.js` imports every layer and runs an ordered
`init_*()` bootstrap, so the dependency graph lives in the `import` statements
rather than a hand-maintained list of script tags. `help/index.html` links to topic pages documenting all of
the features the app adds (the metadata wizard, summary statistics, session
save/load, and layout controls); see it for an up-to-date feature tour. For the
module dependency layers and the key event-flow / user-decision paths as mermaid
diagrams, open [`docs/code-flow-diagrams.html`](docs/code-flow-diagrams.html) and
[`docs/function-call-and-user-decision-graphs.html`](docs/function-call-and-user-decision-graphs.html).
The generated [`docs/module-import-graph.md`](docs/module-import-graph.md) is
checked in CI; update it after an intentional import change with
`python3 scripts/check_import_graph.py --update`.
Both pages provide fit-to-screen, zoom, drag-pan, keyboard, and full-screen
controls; their canonical Mermaid sources remain beside them as `.md` files.

## How The App Works

`index.html` defines the full application shell. It maps D3 to the locally
vendored ESM bundle in `js/vendor/` (no runtime CDN dependency), loads the split
stylesheets, lays out the header, file drop zone, channel selector, metadata
table, plot panel, cell-cycle modeling controls, progress overlay, and bottom status bar,
then loads the app through the single ES-module entry (`js/main.js`). The native
DJF numeric modules under `js/analysis/` are lazy-loaded on the first pipeline
action, so they stay off the initial load path.

Load order is no longer hand-maintained: it is the ES-module dependency graph
plus one ordered bootstrap. `js/main.js` (the module entry) imports every layer,
then calls the `init_*()` functions in dependency order — tooltips, the main event
wiring + initial render, plot listeners, analysis listeners, stats, panel resize,
and session — before assigning the single `window.PhaseFinder` debug hook. At
runtime:

1. `js/fcs/parser.js` exports the `FCSParser` API (imported by the FCS module
   worker and by header/column reading).
2. `js/fcs/metadata_processing.js` reads FCS HEADER/TEXT metadata for new files.
3. `js/state/*`, `js/data_structs/*`, `js/io/metadata_io.js`, and `js/main.js`
   own the file-loading/table state (accessed through imports, not a global).
4. `js/plotting/render.js` defines the plot renderer (`render_density_plot`) and
   redraws on selection/control changes. It reads masks, histograms, fitted
   curves, and reports from per-sample pipeline state.
5. `js/io/channel_loading.js` imports the file getters and `FCSParser` to load
   index-aligned DNA A/H/W, FSC-A, SSC-A, and Time channels (via the module
   worker), then `js/plotting/modeling.js`'s `init_plot` draws the plot.
6. `js/analysis/pipeline/pipeline_loader.js` dynamically imports the QC + modeling
   pipeline orchestrator on the first QC or modeling action.

The only runtime third-party library is vendored in the repository:

```text
js/vendor/d3.min.js  # D3 v7 plotting bundle
```

D3 is vendored locally and resolved through the import map. Peak detection and
Levenberg–Marquardt fitting are implemented by the repository's own ES modules,
so the complete application works without network access.

## File Responsibilities

### `index.html`

The HTML entry point. It contains:

- A header with the PhaseFinder logo and application actions.
- A sidebar with the FCS file drop zone and DNA-content channel selector.
- A workspace with two panels:
  - `plotPanel`, hidden until analysis starts, containing the plot controls bar
    and the `#plotArea` SVG container.
  - `metadataPanel`, the loaded-sample table (can collapse).
- A progress overlay used during metadata and selected-data loading.
- A fixed status bar for long-running operation feedback.
- An import map mapping `d3` to its vendored ESM bundle, and a single
  `<script type="module" src="./js/main.js">` entry.

### `css/*` (split stylesheets)

The stylesheet was split from a single file into themed files, linked in cascade
order in `index.html` (`base → layout → sidebar → table → plot → feedback →
responsive`). The `@media` block lives in `responsive.css` and is loaded last so
its breakpoint overrides win. Each file carries a header comment describing its
scope (see the structure list above).

### `js/fcs/parser.js`

The browser-side FCS parser. It has no external dependencies and exports its API
as the `FCSParser` object, imported by both the main thread and the FCS module
worker.

It handles:

- Reading the fixed FCS header.
- Parsing TEXT segments and normalizing FCS keywords.
- Resolving `$BEGINDATA`, `$ENDDATA`, `$PAR`, `$TOT`, `$DATATYPE`,
  `$BYTEORD`, and parameter labels.
- Supporting float (`F`), double (`D`), and integer (`I`) data types.
- Reading all data with `parseFCS`.
- Reading only selected parameter columns with `parseSelectedColumns`, used
  during analysis to avoid loading unnecessary channels.
- Summarizing only the header/TEXT metadata with `parseFCSHeaderFromSegments`,
  which keeps initial file loading fast.

### `js/main.js`, `js/state/`, `js/data_structs/`, `js/io/`, and `js/ui/`

The main UI and metadata workflow. `main.js` is the ES-module entry: it wires the
top-level DOM events and runs the ordered `init_*()` bootstrap. The two shared
per-file representations — the loaded-file map and the metadata frame — live in
`js/state/app_state.js` behind accessors, with file-selection queries in
`js/state/files.js`; the frame class, table state, metadata-column helpers, and
channel-data cache live in `js/data_structs/`. FCS file metadata loading and
CSV/TSV table import/export live in `js/io/metadata_io.js`. DOM references, table
rendering, status/channel controls, panel controls, resize behavior, and the
filename metadata wizard live in `js/ui/`.

Important responsibilities:

- Handles drag-and-drop and file picker input.
- Reads only the FCS header and TEXT metadata when files are first loaded.
- Rejects duplicate filenames within the current session.
- Preserves imported metadata rows that do not yet have matching loaded FCS files.
- Sorts loaded files by strain, replicate, timepoint, and filename.
- Builds the editable sample table with a checkbox column and "select all".
- Files load **checked by default**; the displayed filename has its `.fcs`
  extension stripped (the underlying name is kept for matching).
- Maintains row selection across re-renders. Filtering a row out of the table
  automatically deselects it, so the plotted set is always "visible ∩ checked".
- Provides per-column multi-select filters and sortable headers.
- Populates the DNA-content channel selector from all loaded FCS parameter
  labels.
- Enables channel plotting only when at least one row is selected and a DNA area
  channel is chosen; enables the pipeline shortcut after a channel is plotted.
- Dispatches a `fcs-selection-change` event when the checked set changes so the
  plot can add/remove curves live without re-running analysis.
- Internal code shares state through direct module imports (accessors); the only
  global is the debug/automation hook `window.PhaseFinder = { app, pipeline,
  plot }` assigned at the end of the bootstrap. `pipeline` is a lazy getter (and
  `djf` remains as a compatibility alias once loaded).

Metadata table columns: Filename (read-only), Strain, Replicate,
Nocodazole Arrest, Timepoint (editable + filterable).

### `js/plotting/`

The plot renderer and cell-cycle display, drawn with D3 into `#plot_area`. Split
across `data.js` (state, data preparation, and histogram binning), `modeling.js`
(fit/report table), `render.js` (the main SVG render pass), and `axis_modal.js`
(axis-range modal, plot-control listeners, and the `window.PhaseFinder.plot`
inspection API). Rendering reads the latest available checkpoint from the
per-sample state owned by `js/analysis/pipeline/pipeline_state.js`.

Important responsibilities:

- Builds per-sample **event histograms** (per-bin event counts) drawn as smooth
  curves, bins, or curve-plus-bins; the y-axis is "Number of Events".
- Honors the plot controls bar: **Color by** (file / strain), **Display**, and
  **Bins**. The x-axis is linear.
- Keeps the plot in sync with the table: it renders the currently checked +
  loaded samples and redraws on `fcs-selection-change` (unchecking a row removes
  its curve without discarding its loaded data; re-checking restores it).
- Maintains a dynamic plot title: `Histogram of Events: n Samples, m Events`.
- **Cell-cycle modeling** runs in layers: pre-modeling QC (Structural, Time,
  Cell Gate, Singlet Gate) removes acquisition artifacts, debris, and doublets;
  the masked histogram is built; peaks are detected and reviewed (Identify
  Peaks); then a model is fit against the accepted G1/G2 regions (Model & Fit:
  Dean–Jett, Dean–Jett–Fox, Watson Pragmatic, Watson Classic, or CLOCCS
  (Unverified) -- automatic model selection was retired; the user always
  picks the model). The plot overlays
  the fitted total and filled G1/S/G2 components (plus selected contamination
  terms), and the fitted fractions plus the accepted region bounds are written
  to the metadata table.
- Plot styling is centralized in named constants at the top of the file —
  component colors (`DJF_G1_COLOR`, `DJF_S_COLOR`, `DJF_G2_COLOR`), fill opacity,
  line widths, margins, axis tick/title sizes, legend metrics, and threshold
  styling — so the look can be changed in one place.

### `js/analysis/`

The selected-data loading and panel orchestration layer, loaded after
`js/plotting/`. The QC + modeling pipeline, numeric helpers under `js/analysis/math/`,
per-sample state, lazy loader, and UI orchestration live directly under
`js/analysis/`;
`js/analysis/pipeline/start.js` coordinates plotting/pipeline actions, and
`js/analysis/stats.js` owns summary statistics. Selected FCS DATA loading is in
`js/io/channel_loading.js`, using `js/io/parameter_map.js` for parameter-index
resolution and `js/data_structs/channel_cache.js` for reusable loaded arrays.

Important responsibilities:

- Tracks the collapsible metadata panel.
- Resolves the selected DNA-content channel to each file's FCS parameter index.
- Loads the selected DNA-area channel and matching H/W, FSC-A, SSC-A, and Time
  columns without compacting event indexes, in small batches controlled by
  `ANALYSIS_FILE_CONCURRENCY`.
- Reveals the plot panel and calls `initPlot()` once the data is loaded; the
  sample/event counts are shown in the plot title rather than the sidebar.

### `tests/e2e/driving_code/`

A Playwright end-to-end driver (`drive_flow.py`) that launches the app in
headless Chromium, loads real FCS files, runs analysis, and exercises the plot
and DJF modeling. Screenshots are written to `tests/e2e/results/` (git-ignored).
Setup, usage, fixture documentation, provenance, and validation commands are
consolidated under [Testing](#testing) below.

The test driver is also the project's regression gate. It runs the browser e2e
workflow and then the JavaScript unit suites through `tests/unit/test_harness.html`:

```bash
/tmp/flowvenv/bin/python tests/e2e/driving_code/drive_flow.py
```

To run the fast CI-contract and supply-chain checks before local commits,
enable the tracked pre-commit hook once per clone:

```bash
git config core.hooksPath .githooks
```

The hook warns about unstaged/untracked files but permits legitimate partial
commits. It blocks only when its fast checks fail or Python is unavailable,
discovering Python from `PHASEFINDER_TEST_PYTHON`, `.venv`, then `python3`.
The full browser and production-artifact suites remain required CI/release
checks. `git commit --no-verify` bypasses the local hook, not required CI.

### `assets/img/*`

Static image assets: `logo.png` (header), the chevron SVGs (metadata panel
expand/collapse), and a `favicon/` set.

### `misc/README.md`

An older short README. The root `README.md` is the primary project guide.

## FCS Support Notes

The parser supports common list-mode FCS data where events are laid out as a
fixed-width sequence of parameters. It reads these `$DATATYPE` values:

- `F`: 32-bit floating point values.
- `D`: 64-bit floating point values.
- `I`: integer values, using each parameter's `$PnB` bit width.

The app relies on standard FCS metadata fields such as `$PAR`, `$TOT`,
`$BYTEORD`, `$PnN`, and `$PnS`. Parameter labels shown in the channel selector
prefer `$PnS`, then `$PnN`, then a generated `P<number>` fallback.

## Running Locally

The source tree can run without a build after dependencies are installed. It
loads as native ES modules, which the browser refuses to load over `file://`
(module CORS), so **a static HTTP server is required** — opening `index.html`
directly from disk will not work.

With the Python built-in server:

```bash
python3 -m http.server 8080
```

Then open:

```text
http://localhost:8080/
```

Or, with live-reload (auto-refreshes the browser on file changes):

```bash
~/.local/bin/livereload -p 8080
```

D3 is vendored locally and mapped via the import map in `index.html`; the DJF
numeric stack is repository-native. Plotting and modeling therefore work fully
offline — no network access or CDN is needed at runtime.

## Typical Workflow

1. Open the app in a browser.
2. Drop `.fcs` files on the drop zone, or click the drop zone to choose files.
3. Wait for metadata loading to finish.
4. Review and edit the sample annotations in the table.
5. Use table filters or sorting if needed (filtering a row out also unchecks it).
6. Confirm the DNA-content area channel selection.
7. Check the rows that should be included in the plot.
8. Click **Plot Channel Events**.
9. Review the overlaid event histogram; adjust Color by / Bins.
10. Click **Cell Cycle Modeling** to open the modeling controls in the
    sidebar. Apply the **Pre-modeling QC** filters you want (Structural, Time,
    Cell Gate, Singlet Gate — individually or via **Run All**), then use
    **Identify Peaks** to detect and, if needed, adjust the G1 and G2/M peak
    regions, and **Model & Fit** to pick a model and fit it against the
    reviewed regions; **Back** returns to the file/channel controls.
11. Check or uncheck rows to add or remove plotted samples live.

## Development Notes

- The app stores working state in memory, so reloading the page clears loaded
  files, annotations, selections, filters, and plots. Saving a session, however,
  caches the loaded FCS files into the browser's OPFS and records enough metadata
  to auto-restore them when the session is reloaded (see "Session reload via
  OPFS" below).
- No files are sent to a backend by this code. OPFS working copies are stored
  privately by the browser for this site and never leave the machine.
- Vite produces the reviewed release artifact; source changes can still be
  exercised directly through the local development server.
- We use Tablericons (https://tabler.io/icons) for a lot of the icons on the site.

## Session reload via OPFS

Sessions are saved as TOML by `js/session/` (`toml_io.js` for the serializer/
parser, `opfs_fs.js` for the OPFS working-copy cache, `reconnect.js` for the
restore/reconnect flow, and `core.js` for state collection/application, file
I/O, and button wiring). To make reloading a session "just work" without
re-selecting files, loaded FCS files are cached into the browser's Origin
Private File System (OPFS):

- **On file load**, `js/io/metadata_io.js` calls `register_loaded_files`
  (imported from `js/session/file_cache.js`), which builds a per-file record
  (`id`, `original_name`, `relative_path`, `size`, `last_modified`, `mime_type`,
  `opfs_path`, `status`, digest algorithm/value) and copies each file into OPFS in the background via a
  module worker (`js/session/copy_worker.js`), showing "Caching file x of y" in
  the status bar. Low-level OPFS helpers live in `js/session/opfs_fs.js`.
- **On save**, those records are written to the session TOML as
  `[[files.records]]` (alongside the legacy `[files].names`). No absolute OS
  paths are ever stored — only app-private OPFS paths and file metadata.
- **On reload**, files are restored automatically from OPFS only after content-
  digest verification. The digest is `SHA-256-CHUNKED-1M-v1`: SHA-256 is applied
  to each fixed 1 MiB chunk and then to the ordered chunk hashes, bounding memory
  without depending on browser stream boundaries. Filename and size are only
  prefilters. Missing, legacy-unverified, or mismatched files open the reconnect
  modal; a renamed manual selection is accepted when its digest matches.
- **Fallbacks**: legacy sessions without records use the original names-only
  folder picker; browsers without OPFS skip caching and warn that automatic
  reload is unavailable, falling back to manual reconnect.

New JS files for this feature:

- `js/session/opfs_fs.js` — the low-level OPFS filesystem wrapper: feature
  detection plus read/delete helpers and storage-persistence requests (writes are
  delegated to the worker).
- `js/session/file_cache.js` — the higher-level file registry, background copy
  queue, persistent cache ownership index, directory-handle persistence, and
  autoload fallbacks.
- `js/session/cache_manager.js` — quota/use, ownership and orphan cleanup UI.
- `js/session/file_digest.js` — bounded-memory content identity shared by copy
  and reconnect verification.
- `js/session/copy_worker.js` — module worker that writes a loaded `File` into
  OPFS off the main thread so caching large files never blocks the UI.

## Testing

All test documentation lives here. Machine-readable manifests remain beside
the files that consume them:

```text
tests/
├── flow_e2e_*.html              # final combined E2E/unit report
├── validation_tests_*.html      # final validation report
├── e2e/
│   ├── driving_code/            # Playwright driver and E2E checks
│   ├── e2e_test_data/           # generated E2E FCS fixtures
│   └── results/                 # temporary report media and hook log
├── unit/
│   ├── driving_code/            # Python unit-suite drivers and checks
│   └── test_harness.html        # browser unit harness
└── validation/
    ├── driving_code/            # synthetic/external validation runner
    ├── results/                 # benchmark JSON/Markdown output
    └── validation_test_data/
        ├── synthetic_fcs/       # generated FCS, truth, and manifest
        └── external_fcs/        # published data, licenses, and manifest
```

The manifests intentionally remain separate. The synthetic manifest is
generated and consumed by its benchmark; the external manifest records
licensing, provenance, privacy review, independent-reader summaries, and
published biological results. Their schemas and consumers are different.

### End-to-end and unit regression tests

One-time setup:

```bash
python3 -m venv /tmp/flowvenv
/tmp/flowvenv/bin/pip install playwright
/tmp/flowvenv/bin/python -m playwright install chromium
```

`ffmpeg` on `$PATH` enables WebM clips; without it the driver uses screenshots.
Run the browser workflow and JavaScript unit suites:

```bash
/tmp/flowvenv/bin/python tests/e2e/driving_code/drive_flow.py
```

Useful flags are `--files N`, `--extra-files N`, `--data DIR`, `--url`,
`--channel`, `--headed`, and `--keep`. Every invocation writes to a unique
git-ignored directory under `tests/e2e/results/`, so concurrent runs never
delete one another's output. One self-contained HTML report with E2E and Unit
tabs is written inside that run directory; screenshots and videos are embedded
and their temporary files are removed. By default the report keeps one
representative image/video per test group plus evidence for every failure;
pass `--all-media` to retain media for every eligible check. Full-media E2E
clips include two seconds of lead-in so related assertions retain the action
that produced them. Local test servers use the first open
port from 8000 through 9000. Run only the unit suites with:

```bash
/tmp/flowvenv/bin/python tests/unit/driving_code/run_standalone.py
```

The suite covers FCS decoding, metadata, selection/filtering, plotting,
structural/time/scatter/singlet QC, peak review, fitting, statistics, sessions,
and parser/model/math boundaries. Enable the fast tracked commit gate with
`git config core.hooksPath .githooks`; the full browser gate runs in CI.

### Synthetic and external validation report

The independent validation runner resets and reloads every FCS separately,
captures auto-detected G1/G2 regions, fits each enabled cell-cycle model, and
runs Dean–Jett–Fox again with Structural, both Time methods, Cell Gate, and
Singlet individually, then all four filters with each Time method.
It writes one self-contained HTML report directly under `tests/`; all plot images are embedded in the
HTML, so no separate screenshots are retained.

```bash
/tmp/flowvenv/bin/python tests/validation/driving_code/validation_tests.py
```

The full default run is intentionally large. For a quick browser smoke test,
select files by case ID, filename, or substring and limit the models/QC matrix:

```bash
/tmp/flowvenv/bin/python tests/validation/driving_code/validation_tests.py \
  --files truth_low_count_55_30_15 \
  --models watson_pragmatic \
  --skip-qc-matrix
```

Other useful options are `--kind synthetic|external`, `--max-files`,
`--headed`, `--report`, and `--keep`. By default older
`validation_tests_*.html` files in the report directory are removed before the
run; `--keep` retains them. Every modeled validation case uses the bin count
marked recommended for its retained event count. Parser-rejection fixtures and files without a
claimed DNA cell-cycle endpoint are imported and documented but are not given
invented biological expectations. Published external studies do not provide
PhaseFinder-style peak boundaries, so those expected/differential cells are
reported as N/A.

### Synthetic FCS benchmark

`tests/validation/validation_test_data/synthetic_fcs/` contains 47 deterministic, entirely synthetic
FCS cases. No file contains human, patient, instrument, or other real
experimental data. The corpus tests parser behavior, QC defenses, and recovery
of planted G1/S/G2/M fractions; it is regression evidence, not biological
validation.

| Fixture | Exact G1 / S / G2/M | Purpose |
|---|---:|---|
| `truth_clean_70_20_10` | 70 / 20 / 10 | G1-dominant control |
| `truth_clean_50_30_20` | 50 / 30 / 20 | balanced control |
| `truth_s_rich_25_55_20` | 25 / 55 / 20 | S-rich control |
| `truth_g2_rich_20_20_60` | 20 / 20 / 60 | G2/M-rich control |
| `truth_low_s_48_04_48` | 48 / 4 / 48 | low-S sensitivity |
| `truth_dj_early_40_40_20` | 40 / 40 / 20 | early-S residence profile |
| `truth_djf_early_wave_45_40_15` | 45 / 40 / 15 | early Fox-like wave |
| `truth_djf_late_wave_45_40_15` | 45 / 40 / 15 | late Fox-like wave |
| `truth_high_cv_overlap_35_45_20` | 35 / 45 / 20 | overlapping peaks |
| `truth_low_count_55_30_15` | 55 / 30 / 15 | low-count convergence |

Truth lives in event-aligned JSON sidecars rather than an FCS parameter, so it
cannot leak into fitting. The manifest pins hashes, fractions, parser/QC
outcomes, model contracts, regions, and tolerances. `recovery` contracts require
convergence within tolerance; `diagnostic` contracts only record behavior.

```bash
python3 tests/validation/validation_test_data/synthetic_fcs/generate_fixtures.py
python3 tests/validation/validation_test_data/synthetic_fcs/generate_fixtures.py --check
/tmp/flowvenv/bin/python tests/validation/validation_test_data/synthetic_fcs/run_benchmark.py
```

The runner accepts `--mode parser|qc|models`, `--models`, `--groups`, `--cases`,
`--browser`, and `--strict`. Groups are `known_phase_truth`,
`scientific_adversarial`, `qc_adversarial`, and `parser_conformance`. Reports
go under `tests/validation/results/`. A single seed is a regression
check; calibration requires a multi-seed or blinded validation corpus.

### Non-synthetic FCS and published validation data

`tests/validation/validation_test_data/external_fcs/` contains the combined tracked non-synthetic corpus:
**10 redistributable artifacts total, of which 6 are FCS files**. The other artifacts are two
labeled tables and two published reference figures.

The files sit at:

- `tests/validation/validation_test_data/external_fcs/files/fcsparser_miltenyi_pbs_fcs31.fcs`
- `tests/validation/validation_test_data/external_fcs/datasets/amouzgar_2025/` — one FCS and one table
- `tests/validation/validation_test_data/external_fcs/datasets/rodighiero_2024/` — four FCS and one table
- `tests/validation/validation_test_data/external_fcs/results/` — two Rodighiero reference figures

Every admitted binary must have a stable path, size, SHA-256, immutable source,
file-level redistribution basis, privacy review, FCS summary, and independent
oracle in `tests/validation/validation_test_data/external_fcs/manifest.json`. Files are immutable after
admission; changed upstream bytes require a new fixture and hash.

The Miltenyi PBS fixture came from `fcsparser` commit
`da70aaa7ec92ff3bd9ce00aec4eea7c77ee8c096` under MIT. It is an FCS 3.1
MACSQuant acquisition with a real-world off-by-one DATA stop offset. Its public
metadata contains no patient or human-subject identifier.

#### Rodighiero et al. (2024)

> Rodighiero S, Ceccacci E, Hayatigolkhatmi K, et al. “Automated workflow for
> the cell cycle analysis of (non-)adherent cells using a machine learning
> approach.” *eLife* 13:RP94689 (2024).
> [doi:10.7554/eLife.94689](https://doi.org/10.7554/eLife.94689),
> [PMC11584176](https://pmc.ncbi.nlm.nih.gov/articles/PMC11584176/).

The corpus contains four CC0 FCS files from the paper's
[Dryad dataset](https://doi.org/10.5061/dryad.cvdncjtcx): stained EdU/FUCCI
acquisitions and negative controls for Kasumi-1 and MDA-MB-231. It also retains
the pinned MIT FUCCI phase-track table and CC-BY Figure 4 panels.

| Sample and reference method | G1 | S | G2/M |
|---|---:|---:|---:|
| Kasumi-1, EdU/DAPI gates | 63.00% | 28.41% | 7.63% |
| Kasumi-1, FUCCI gates | 65.20% | 29.10% | 3.67% |
| MDA-MB-231, EdU/DAPI gates | 44.30% | 44.91% | 9.86% |
| MDA-MB-231, FUCCI gates | 43.60% | 49.90% | 4.77% |

These percentages came from manual EdU/DAPI and FUCCI gates, not a Dean–Jett,
Dean–Jett–Fox, Watson, or other DNA-histogram model. PhaseFinder estimates are
expected to differ, especially for S and G2/M; compare broad agreement rather
than exact equality. Negative controls have no specimen-specific percentages.

#### Amouzgar et al. (2025)

> Amouzgar M, et al. “A deep single cell mass cytometry approach to capture
> canonical and noncanonical cell cycle states.” *Nature Communications*
> (2025). [doi:10.1038/s41467-025-63883-4](https://doi.org/10.1038/s41467-025-63883-4),
> [PMC12494979](https://pmc.ncbi.nlm.nih.gov/articles/PMC12494979/),
> [Zenodo 14852934](https://zenodo.org/records/14852934).

The CC-BY-4.0 corpus includes a labeled 162,000-event table and one raw FCS 3.0
primary-T-cell acquisition. Labels are 51.167901% G0/G1, 33.295062% S,
13.761728% G2, and 1.775309% M; combined G2/M is 15.537037%. Its mass-cytometry
truth uses multiple cell-cycle markers, so a DNA-only fit is not expected to
reproduce it exactly. The FCS has no specimen-specific published phase table;
the CSV carries the biological truth.

#### Li, MacAlpine & Hartemink CLOCCS series (local-only)

> Li Y, MacAlpine DM, Hartemink AJ. “Comprehensive profiling of chromatin
> occupancy dynamics through the cell cycle.” *Nucleic Acids Research* 54(2)
> (2026). [doi:10.1093/nar/gkaf1385](https://doi.org/10.1093/nar/gkaf1385),
> [PMC12809599](https://pmc.ncbi.nlm.nih.gov/articles/PMC12809599/).

Two 16-timepoint yeast release series (32 FCS files, 30,000 events each) are
used to compare PhaseFinder's joint CLOCCS fit with the authors' saved CLOCCS
posteriors. Local files sit under
`tests/validation/validation_test_data/external_fcs/datasets/li_2026_cloccs/`;
their exact paths, sizes, SHA-256 hashes, citation, upstream commit, and
reference parameters are tracked in `external_fcs/manifest.json`.

The upstream GitHub repository declares no license, so these 32 binaries are
gitignored and are never uploaded with PhaseFinder. The default validation run
includes them when present and reports a documented skip when absent. The
source acquisitions are available from the pinned
[HarteminkLab repository](https://github.com/HarteminkLab/cell-cycle-deconv/tree/6d3b06a265f06c0385102262d839bd9c0c02218b/data/facs/cell_cycle).
The comparison covers recovery delay, S-entry time, cycle length, daughter
delay, population spread, and S-phase boundaries. The published model includes
a halted-cell fraction that PhaseFinder does not yet implement, so the report
shows that limitation instead of claiming exact equivalence.

Verify external hashes, metadata, counts, markers, and production decoding:

```bash
python3 tests/validation/validation_test_data/external_fcs/verify.py
node tests/validation/validation_test_data/external_fcs/verify_phasefinder_parser.mjs
```

Future deposits can be sought in [FlowRepository](https://flowrepository.org/),
[ImmPort](https://www.immport.org/), [Cytobank](https://community.cytobank.org/),
[BioStudies](https://www.ebi.ac.uk/biostudies/), [Dryad](https://datadryad.org/),
[Zenodo](https://zenodo.org/), [Figshare](https://figshare.com/), and
[OSF](https://osf.io/). Public access is not redistribution permission: verify
file-level licensing and privacy metadata. Pending parser-fixture candidates
include FlowCal, FlowIO, FlowKit, remaining fcsparser samples, and flowCore.
NCBI GEO is not a general FCS archive; FlowRepository and ImmPort are the
closest domain-specific repositories.
