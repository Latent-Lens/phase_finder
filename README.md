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
7. Optionally fit a Dean–Jett–Fox (DJF) cell-cycle model to one sample and read
   off its %G1 / %S / %G2 fractions.

Files are read by browser APIs. There is no upload server, database, or build
pipeline in this repository.

## Project Structure

```text
.
├── index.html
├── help.html             # in-app help/feature guide, linked from the header
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
│   └── help.css         # standalone stylesheet for help.html
├── js/
│   ├── vendor/          # vendored D3 ESM bundle
│   ├── state/           # app_state (file_map + frame accessors), file-selection queries
│   ├── util/            # leaf string helpers (HTML escaping, filename transforms)
│   ├── analysis/        # staged DJF pipeline (lazy-loaded), orchestration, summary stats
│   ├── data_structs/    # frame, table state, metadata columns, channel cache
│   ├── fcs/             # FCS parser, metadata reader, channel cleanup, module worker
│   ├── io/              # FCS/metadata loading, parameter map, table import/export
│   ├── plotting/        # D3 histogram rendering, axis modal, and DJF report UI
│   ├── session/         # TOML save/load, OPFS filesystem + file cache, reconnect flow
│   ├── ui/              # DOM refs, metadata table, wizard, panels, status/channel controls
│   └── main.js          # ES-module entry: init_*() bootstrap + window.PhaseFinder hook
├── docs/
│   ├── code-flow-diagrams.md                    # layered deps + event-flow mermaid diagrams
│   └── function-call-and-user-decision-graphs.md
├── tests/
│   ├── e2e/             # Playwright driver (drive_flow.py) + results/
│   └── unit/            # module-level unit suites driven via test_harness.html
└── misc/
    └── README.md
```

Note: the file list above is a high-level map, not exhaustive. The app loads as
native ES modules: `index.html` has a single `<script type="module"
src="./js/main.js">`, and `js/main.js` imports every layer and runs an ordered
`init_*()` bootstrap, so the dependency graph lives in the `import` statements
rather than a hand-maintained list of script tags. `help.html` documents all of
the features the app adds (the metadata wizard, summary statistics, session
save/load, and layout controls); see it for an up-to-date feature tour. For the
module dependency layers and the key event-flow / user-decision paths as mermaid
diagrams, see [`docs/code-flow-diagrams.md`](docs/code-flow-diagrams.md) and
[`docs/function-call-and-user-decision-graphs.md`](docs/function-call-and-user-decision-graphs.md).

## How The App Works

`index.html` defines the full application shell. It maps D3 to the locally
vendored ESM bundle in `js/vendor/` (no runtime CDN dependency), loads the split
stylesheets, lays out the header, file drop zone, channel selector, metadata
table, plot panel, staged DJF controls, progress overlay, and bottom status bar,
then loads the app through the single ES-module entry (`js/main.js`). The native
DJF numeric modules under `js/analysis/djf/` are lazy-loaded on the first pipeline
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
6. `js/analysis/djf/pipeline_loader.js` dynamically imports the Stage 0–8
   orchestrator on the first stage or Run-all action.

The only runtime third-party library is:

```text
https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js     # plotting
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
per-sample state owned by `js/analysis/djf/pipeline_state.js`.

Important responsibilities:

- Builds per-sample **event histograms** (per-bin event counts) drawn as smooth
  curves, bins, or curve-plus-bins; the y-axis is "Number of Events".
- Honors the plot controls bar: **Color by** (file / strain), **Display**, and
  **Bins**. The x-axis is linear.
- Keeps the plot in sync with the table: it renders the currently checked +
  loaded samples and redraws on `fcs-selection-change` (unchecking a row removes
  its curve without discarding its loaded data; re-checking restores it).
- Maintains a dynamic plot title: `Histogram of Events: n Samples, m Events`.
- **Dean–Jett–Fox modeling** is a manual nine-stage pipeline: structural QC,
  optional Time/scatter/singlet gates, masked histogram construction, peak
  detection, constrained base fit, optional debris/aggregate extension, and a
  normalized report. Stage 6/7 overlays the fitted total and filled G1/S/G2
  components (plus selected contamination terms); Stage 8 populates the grouped
  report table and diagnostic warnings.
- Plot styling is centralized in named constants at the top of the file —
  component colors (`DJF_G1_COLOR`, `DJF_S_COLOR`, `DJF_G2_COLOR`), fill opacity,
  line widths, margins, axis tick/title sizes, legend metrics, and threshold
  styling — so the look can be changed in one place.

### `js/analysis/`

The selected-data loading and panel orchestration layer, loaded after
`js/plotting/`. The `js/analysis/djf/` directory contains the Stage 0–8 model,
numeric helpers, per-sample state, lazy loader, and UI orchestration;
`js/analysis/start.js` coordinates plotting/pipeline actions, and
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

### `tests/e2e/`

A Playwright end-to-end driver (`drive_flow.py`) that launches the app in
headless Chromium, loads real FCS files, runs analysis, and exercises the plot
and DJF modeling. Screenshots are written to `tests/e2e/results/` (git-ignored).
See `tests/e2e/README.md` for the one-time Playwright setup and usage.

The test driver is also the project's regression gate. It runs the browser e2e
workflow and then the JavaScript unit suites through `tests/unit/test_harness.html`:

```bash
/tmp/flowvenv/bin/python tests/e2e/drive_flow.py
```

To require this full suite before local commits, enable the tracked pre-commit
hook once per clone:

```bash
git config core.hooksPath .githooks
```

After that, `git commit` is blocked unless the worktree is clean and the full
regression suite passes. If Playwright is installed in a different environment,
set `PHASEFINDER_TEST_PYTHON` to that Python executable before committing. While
the hook is running, live output is also written to:

```bash
tail -f tests/e2e/results/pre_commit_latest.log
```

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

Because this is a static browser app, there is no install or build step. The app
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
10. Run individual Stage 0–8 buttons for checkpoint diagnostics, or click
    **Run all** / **Run DJF Pipeline** to execute the full analysis.
11. Review the fitted components, normalized phase fractions, contamination
    accounting, diagnostics, and warnings in the plot and report table.
12. Check or uncheck rows to add or remove plotted samples live.

## Development Notes

- The app stores working state in memory, so reloading the page clears loaded
  files, annotations, selections, filters, and plots. Saving a session, however,
  caches the loaded FCS files into the browser's OPFS and records enough metadata
  to auto-restore them when the session is reloaded (see "Session reload via
  OPFS" below).
- No files are sent to a backend by this code. OPFS working copies are stored
  privately by the browser for this site and never leave the machine.
- There is no package manager configuration or bundler in the repository; the
  JavaScript is plain browser JavaScript, so changes can be tested by refreshing
  the page.
- We use Tablericons (https://tabler.io/icons) for a lot of the icons on the site.

## Session reload via OPFS

Sessions are saved as TOML by `js/session/` (`toml.js` for the serializer/
parser, `opfs.js` for the OPFS working-copy cache, `reconnect.js` for the
restore/reconnect flow, and `core.js` for state collection/application, file
I/O, and button wiring). To make reloading a session "just work" without
re-selecting files, loaded FCS files are cached into the browser's Origin
Private File System (OPFS):

- **On file load**, `js/io/metadata_io.js` calls `register_loaded_files`
  (imported from `js/session/file_cache.js`), which builds a per-file record
  (`id`, `original_name`, `relative_path`, `size`, `last_modified`, `mime_type`,
  `opfs_path`, `status`) and copies each file into OPFS in the background via a
  module worker (`js/session/copy_worker.js`), showing "Caching file x of y" in
  the status bar. Low-level OPFS helpers live in `js/session/opfs_fs.js`.
- **On save**, those records are written to the session TOML as
  `[[files.records]]` (alongside the legacy `[files].names`). No absolute OS
  paths are ever stored — only app-private OPFS paths and file metadata.
- **On reload**, files are restored automatically from OPFS by `opfs_path`; if
  every file is present the session loads with no picker. Any missing or
  size-mismatched files open a reconnect modal that lists the expected files and
  lets the user pick the containing folder or select the files manually (matched
  by name/size/lastModified), after which the matches are re-cached into OPFS.
- **Fallbacks**: legacy sessions without records use the original names-only
  folder picker; browsers without OPFS skip caching and warn that automatic
  reload is unavailable, falling back to manual reconnect.

New JS files for this feature:

- `js/session/opfs_fs.js` — the low-level OPFS filesystem wrapper: feature
  detection plus read/delete helpers and storage-persistence requests (writes are
  delegated to the worker).
- `js/session/file_cache.js` — the higher-level file registry, background copy
  queue, directory-handle persistence, and autoload fallbacks.
- `js/session/copy_worker.js` — module worker that writes a loaded `File` into
  OPFS off the main thread so caching large files never blocks the UI.
