# Flow Plotter

Flow Plotter is a browser-based tool for inspecting and plotting flow cytometry
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
│   └── responsive.css   # @media overrides (loaded last)
├── js/
│   ├── fcs-parser.js    # window.FCSParser — FCS reading
│   ├── main.js          # window.FlowPlotterApp — file/table/selection UI
│   ├── plotting.js      # D3 histogram + DJF modeling
│   └── analysis.js      # selected-data loading + plot panel orchestration
├── tests/
│   └── e2e/             # Playwright driver (drive_flow.py) + results/
└── misc/
    └── README.md
```

## How The App Works

`index.html` defines the full application shell. It loads D3 (and, for the DJF
fit, the `ml-levenberg-marquardt` and `ml-gsd` libraries) from CDNs, loads the
split stylesheets, lays out the header, file drop zone, channel selector,
metadata table, plot panel, progress overlay, and bottom status bar, then loads
the local JavaScript files.

The runtime order matters:

1. `js/fcs-parser.js` creates `window.FCSParser`.
2. `js/main.js` creates the file-loading/table UI state and exposes
   `window.FlowPlotterApp`.
3. `js/plotting.js` defines the plot renderer (`initPlot`, `renderDensityPlot`)
   and the DJF model; it listens for selection changes to redraw live.
4. `js/analysis.js` uses `window.FlowPlotterApp` and `window.FCSParser` to load
   selected event data, then calls `initPlot` to draw the plot.

The third-party libraries are loaded from:

```text
https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js     # plotting
https://esm.sh/ml-levenberg-marquardt@4              # DJF curve fitting
https://esm.sh/ml-gsd@13                             # DJF peak detection
```

The `ml-*` libraries are imported dynamically and attached to `window`
(`window.levenbergMarquardt`, `window.gsd`); a load failure is logged and only
disables DJF modeling, not the rest of the app. Plotting and modeling therefore
require network access unless these libraries are vendored locally.

## File Responsibilities

### `index.html`

The HTML entry point. It contains:

- A header with the Flow Plotter logo and the `Start Analysis` button.
- A sidebar with the FCS file drop zone and DNA-content channel selector.
- A workspace with two panels:
  - `plotPanel`, hidden until analysis starts, containing the plot controls bar
    and the `#plotArea` SVG container.
  - `metadataPanel`, the loaded-sample table (can collapse).
- A progress overlay used during metadata and selected-data loading.
- A fixed status bar for long-running operation feedback.
- Script tags for D3, the dynamic `ml-*` imports, and the four local JS files.

### `css/*` (split stylesheets)

The stylesheet was split from a single file into themed files, linked in cascade
order in `index.html` (`base → layout → sidebar → table → plot → feedback →
responsive`). The `@media` block lives in `responsive.css` and is loaded last so
its breakpoint overrides win. Each file carries a header comment describing its
scope (see the structure list above).

### `js/fcs-parser.js`

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

### `js/main.js`

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
- Exposes `window.FlowPlotterApp` (e.g. `getSelectedFiles`, `getParsedFiles`,
  `getSelectedChannels`, plus progress/status helpers).

Metadata table columns: Filename (read-only), Strain, Replicate,
Nocodazole Arrest, Timepoint (editable + filterable).

### `js/plotting.js`

The plot renderer and cell-cycle model, drawn with D3 into `#plotArea`.

Important responsibilities:

- Builds per-sample **event histograms** (per-bin event counts) drawn as smooth
  curves; the y-axis is "Number of Events".
- Honors the plot controls bar: **Color by** (file / strain), **X-axis**
  (linear / log), **Bins**, and **Model (DJF)** sample picker.
- Keeps the plot in sync with the table: it renders the currently checked +
  loaded samples and redraws on `fcs-selection-change` (unchecking a row removes
  its curve without discarding its loaded data; re-checking restores it).
- Maintains a dynamic plot title: `Histogram of Events: n Samples, m Events`.
- **Dean–Jett–Fox modeling** (Full Fox broadening): seeds the fit by detecting
  histogram peaks with `ml-gsd`, identifies the G1/G2 peak pair at the ~2× DNA
  ratio, estimates a run-wide G1 (2N) position shared across samples, fits with
  `ml-levenberg-marquardt` (M1 pinned near the run G1, G2 mean fixed at 2×M1),
  and overlays the fitted total plus filled G1/S/G2 components with a
  `%G1 · %S · %G2` readout. DJF is linear-axis only.
- A **draggable peak-detection threshold** (a grey line with a fill below it),
  shown only when the "Peak threshold" checkbox is ticked; dragging it re-detects
  peaks and refits on release.
- Plot styling is centralized in named constants at the top of the file —
  component colors (`DJF_G1_COLOR`, `DJF_S_COLOR`, `DJF_G2_COLOR`), fill opacity,
  line widths, margins, axis tick/title sizes, legend metrics, and threshold
  styling — so the look can be changed in one place.

### `js/analysis.js`

The selected-data loading and panel orchestration layer, loaded after
`plotting.js`. It uses the public `window.FlowPlotterApp` methods.

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

Because this is a static browser app, there is no install step. Opening
`index.html` directly works, but a static server is recommended (the `ml-*`
modules import more reliably over `http://`):

```bash
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000/
```

D3, `ml-levenberg-marquardt`, and `ml-gsd` are loaded from CDNs (see "How The App
Works"), so plotting and DJF modeling need network access unless those libraries
are vendored locally and the tags in `index.html` are changed.

## Typical Workflow

1. Open the app in a browser.
2. Drop `.fcs` files on the drop zone, or click the drop zone to choose files.
3. Wait for metadata loading to finish.
4. Review and edit the sample annotations in the table.
5. Use table filters or sorting if needed (filtering a row out also unchecks it).
6. Confirm the DNA-content area channel selection.
7. Check the rows that should be included in the plot.
8. Click `Start Analysis`.
9. Review the overlaid event histogram; adjust Color by / X-axis / Bins.
10. Optionally choose a sample under **Model (DJF)** to fit and read its cell-cycle
    fractions; tick **Peak threshold** to fine-tune peak detection.
11. Check or uncheck rows to add or remove plotted samples live.

## Development Notes

- The app stores all state in memory. Reloading the page clears loaded files,
  annotations, selections, filters, and plots.
- No files are sent to a backend by this code.
- There is no package manager configuration or bundler in the repository; the
  JavaScript is plain browser JavaScript, so changes can be tested by refreshing
  the page.
- `main.js` includes `applyDebugChannelDefaults`, which automatically selects
  `GFP/FITC-A` when that channel exists. The inline comment marks this as a debug
  helper to remove for production.
