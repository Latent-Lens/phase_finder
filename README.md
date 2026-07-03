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

Files are read by browser APIs. There is no upload server or database. The app
is built with Svelte + Vite and still runs entirely in the browser.

## Project Structure

```text
.
├── index.html
├── help.html             # in-app help/feature guide, linked from the header
├── package.json          # Vite/Svelte scripts and browser dependencies
├── src/
│   ├── App.svelte        # Svelte-owned app bootstrap/shell
│   ├── lib/              # importable parser/loading/bootstrap modules
│   └── stores/           # Svelte stores for migrated UI state
├── public/
│   ├── assets/           # URL-served images, icons, favicon, sample TOML
│   ├── css/              # existing split stylesheets
│   ├── js/               # compatibility scripts during migration
│   └── sessions/         # sample/local session files
├── tests/
│   └── e2e/             # Playwright driver (drive_flow.py) + results/
└── misc/
    └── README.md
```

The `public/js/` files are compatibility scripts kept while the UI moves into
Svelte components and stores. Importable parser/loading code lives under
`src/lib/`.

## How The App Works

`index.html` is the Vite entry point. `src/App.svelte` renders the application
shell and loads the current compatibility scripts after the DOM exists. Third
party libraries (`d3`, `ml-levenberg-marquardt`, and `ml-gsd`) are bundled by
Vite and attached to the same `window.*` globals that the plotting/modeling code
expects.

The runtime order matters:

1. `src/main.js` mounts `src/App.svelte`.
2. `src/lib/thirdParty.js` creates `window.d3`, `window.levenbergMarquardt`,
   and `window.gsd`.
3. `public/js/fcs-parser.js` creates `window.FCSParser` for compatibility.
4. `public/js/main.js` creates the file-loading/table UI state and exposes
  `window.PhaseFinderApp`.
5. `public/js/plotting.js` defines the plot renderer (`initPlot`, `renderDensityPlot`)
   and the DJF model; it listens for selection changes to redraw live.
6. `public/js/analysis.js` uses `window.PhaseFinderApp` and `window.FCSParser` to load
   selected event data, then calls `initPlot` to draw the plot.

## File Responsibilities

### `index.html`

The Vite HTML entry point. It links the global stylesheets and favicons, creates
`#app`, and loads `src/main.js`.

### `src/App.svelte`

The Svelte bootstrap component. It renders the current app shell, installs the
bundled third-party globals, then loads the compatibility scripts from
`public/js/` in the same runtime order the static app used.

### `public/css/*` (split stylesheets)

The stylesheet was split from a single file into themed files, linked in cascade
order in `index.html` (`base → layout → sidebar → table → plot → feedback →
responsive`). The `@media` block lives in `responsive.css` and is loaded last so
its breakpoint overrides win. Each file carries a header comment describing its
scope (see the structure list above).

### `public/js/fcs-parser.js` and `src/lib/fcs/parser.js`

The browser-side FCS parser. It has no external dependencies and exposes its API
through `window.FCSParser`.

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

### `public/js/main.js`

The main UI and metadata workflow. It owns the loaded file list, annotation
state, table state, selection state, and status/progress helpers.

Important responsibilities:

- Handles drag-and-drop and file picker input.
- Reads only the FCS header and TEXT metadata when files are first loaded.
- Rejects duplicate filenames within the current session.
- Guesses initial annotations from filenames.
- Sorts loaded files by strain, replicate, timepoint, and filename.
- Builds the editable sample table with a checkbox column and "select all".
- Files load **checked by default**; the displayed filename has its `.fcs`
  extension stripped (the underlying name is kept for matching).
- Maintains row selection across re-renders. Filtering a row out of the table
  automatically deselects it, so the plotted set is always "visible ∩ checked".
- Provides per-column multi-select filters and sortable headers.
- Populates the DNA-content channel selector from all loaded FCS parameter
  labels.
- Enables `Start Analysis` only when at least one row is selected and a DNA area
  channel is chosen.
- Dispatches a `fcs-selection-change` event when the checked set changes so the
  plot can add/remove curves live without re-running analysis.
- Exposes `window.PhaseFinderApp` (e.g. `getSelectedFiles`, `getParsedFiles`,
  `getSelectedChannels`, plus progress/status helpers).

Metadata table columns: Filename (read-only), Strain, Replicate,
Nocodazole Arrest, Timepoint (editable + filterable).

### `public/js/plotting.js`

The plot renderer and cell-cycle model, drawn with D3 into `#plotArea`.

Important responsibilities:

- Builds per-sample **event histograms** (per-bin event counts) drawn as smooth
  curves; the y-axis is "Number of Events".
- Honors the plot controls bar: **Color by** (file / strain), **Bins**,
  correction toggles, and the **Model (DJF)** sample picker. The x-axis is
  always linear and starts at 0.
- Keeps the plot in sync with the table: it renders the currently checked +
  loaded samples and redraws on `fcs-selection-change` (unchecking a row removes
  its curve without discarding its loaded data; re-checking restores it).
- Maintains a dynamic plot title: `Histogram of Events: n Samples, m Events`.
- **Dean–Jett–Fox modeling** (Full Fox broadening): seeds the fit by detecting
  histogram peaks with `ml-gsd`, identifies the G1/G2 peak pair at the ~2× DNA
  ratio, estimates a run-wide G1 (2N) position shared across samples, fits with
  `ml-levenberg-marquardt` (M1 pinned near the run G1, G2 mean fixed at 2×M1),
  and overlays the fitted total plus filled G1/S/G2 components with a
  `%G1 · %S · %G2` readout. Visible fits also populate a grouped results table:
  each sample has a metadata title row, followed by G1/S/G2 rows with phase
  percentages, fitted means, and fitted standard deviations. DJF is linear-axis
  only.
- A **draggable peak-detection threshold** (a grey line with a fill below it),
  shown only when the "Peak threshold" checkbox is ticked; dragging it re-detects
  peaks and refits on release.
- Plot styling is centralized in named constants at the top of the file —
  component colors (`DJF_G1_COLOR`, `DJF_S_COLOR`, `DJF_G2_COLOR`), fill opacity,
  line widths, margins, axis tick/title sizes, legend metrics, and threshold
  styling — so the look can be changed in one place.

### `public/js/analysis.js`

The selected-data loading and panel orchestration layer, loaded after
`plotting.js`. It uses the public `window.PhaseFinderApp` methods.

Important responsibilities:

- Tracks the collapsible metadata panel.
- Resolves the selected DNA-content channel to each file's FCS parameter index.
- Loads only the selected DNA-content column from each selected FCS file, in
  small batches controlled by `ANALYSIS_FILE_CONCURRENCY`.
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

### `public/assets/img/*`

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

Install dependencies once, then run the Vite dev server:

```bash
npm install
npm run dev
```

Then open the URL printed by Vite, usually:

```text
http://127.0.0.1:5173/
```

Create a production build with:

```bash
npm run build
```

Preview the production build locally with:

```bash
npm run preview
```

The Playwright regression runner starts a Vite dev server automatically when
`package.json` is present:

```bash
/tmp/flowvenv/bin/python tests/e2e/drive_flow.py
```

## Typical Workflow

1. Open the app in a browser.
2. Drop `.fcs` files on the drop zone, or click the drop zone to choose files.
3. Wait for metadata loading to finish.
4. Review and edit the sample annotations in the table.
5. Use table filters or sorting if needed (filtering a row out also unchecks it).
6. Confirm the DNA-content area channel selection.
7. Check the rows that should be included in the plot.
8. Click `Start Analysis`.
9. Review the overlaid event histogram; adjust Color by / Bins.
10. Optionally choose a sample under **Model (DJF)** to fit and read its cell-cycle
    fractions plus per-phase mean/std-dev in the fit results table; tick
    **Peak threshold** to fine-tune peak detection.
11. Check or uncheck rows to add or remove plotted samples live.

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

Sessions are saved as TOML by `public/js/session.js`. To make reloading a session
"just work" without re-selecting files, loaded FCS files are cached into the
browser's Origin Private File System (OPFS):

- **On file load**, `public/js/main.js` hands the loaded files to
  `window.PhaseFinderSessionFiles.register_loaded_files`, which builds a per-file
  record (`id`, `original_name`, `relative_path`, `size`, `last_modified`,
  `mime_type`, `opfs_path`, `status`) and copies each file into OPFS in the
  background via a Web Worker (`public/js/opfs_copy_worker.js`), showing
  "Caching file x of y" in the status bar. OPFS helpers live in
  `public/js/opfs_store.js` (`window.PhaseFinderOPFS`).
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

- `public/js/opfs_store.js` — `window.PhaseFinderOPFS`; OPFS feature detection plus
  read/delete helpers and storage-persistence requests (writes are delegated to
  the worker).
- `public/js/opfs_copy_worker.js` — Web Worker that writes a loaded `File` into OPFS off
  the main thread so caching large files never blocks the UI.
