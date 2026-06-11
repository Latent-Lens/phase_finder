# Flow Plotter

Flow Plotter is a browser-based tool for inspecting and plotting flow cytometry
`.fcs` files. It is designed as a lightweight, local-first workspace: users drop
FCS files into the page, the app reads the FCS header and TEXT metadata in the
browser, and selected samples can then be loaded into an overlaid DNA-content
density plot.

The project currently focuses on a specific analysis workflow:

1. Load one or more FCS files from disk.
2. Review the detected sample metadata in a sortable, filterable table.
3. Edit sample annotations such as strain, replicate, nocodazole arrest status,
   and timepoint.
4. Choose the DNA-content area channel.
5. Select the samples to analyze.
6. Generate a normalized density plot for the selected files.

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
│       └── chevron-right-icon.svg
├── css/
│   └── style.css
├── js/
│   ├── fcs-parser.js
│   ├── main.js
│   └── analysis.js
└── misc/
    └── README.md
```

## How The App Works

`index.html` defines the full application shell. It loads Plotly from a CDN,
loads the stylesheet, lays out the header, file drop zone, channel selector,
metadata table, plot panel, progress overlay, and bottom status bar, then loads
the local JavaScript files.

The runtime order matters:

1. `js/fcs-parser.js` creates `window.FCSParser`.
2. `js/main.js` creates the file-loading UI state and exposes
   `window.FlowPlotterApp`.
3. `js/analysis.js` uses `window.FlowPlotterApp`, `window.FCSParser`, and Plotly
   to load selected event data and draw the plot.

## File Responsibilities

### `index.html`

The HTML entry point for the app. It contains:

- A header with the Flow Plotter logo and the `Start Analysis` button.
- A sidebar with the FCS file drop zone and DNA-content channel selector.
- A workspace with two panels:
  - `plotPanel`, hidden until analysis starts.
  - `metadataPanel`, which contains the loaded sample table and can collapse.
- A progress overlay used during metadata loading and selected data loading.
- A fixed status bar for long-running operation feedback.
- Script tags for Plotly and the three local JavaScript files.

### `css/style.css`

The stylesheet controls the application layout and interaction states. Major
areas include:

- Two-column desktop layout with a responsive single-column mobile layout.
- Panel, table, drop-zone, button, progress overlay, and status-bar styling.
- Sticky table headers.
- Sort indicators and filter dropdown menus in the metadata table.
- Collapsible metadata panel states.
- Plot panel sizing so the Plotly chart has stable vertical space.

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
- Reading only selected parameter columns with `parseSelectedColumns`, which is
  used during analysis to avoid loading unnecessary channels.
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
- Builds the editable sample table.
- Maintains row selection across re-renders.
- Provides per-column filtering for editable annotation fields.
- Provides sortable table headers.
- Populates the DNA-content channel selector from all loaded FCS parameter
  labels.
- Enables `Start Analysis` only when at least one row is selected and a DNA area
  channel is chosen.
- Exposes `window.FlowPlotterApp` so `analysis.js` can access selected files,
  selected channels, progress UI, and status UI.

The metadata table currently contains these columns:

- Filename
- Strain
- Replicate
- Nocodazole Arrest
- Timepoint

The filename is read-only. The other columns are editable and filterable.

### `js/analysis.js`

The analysis and plotting layer. It is loaded after `main.js` and uses the
public `window.FlowPlotterApp` methods.

Important responsibilities:

- Tracks the collapsible metadata panel.
- Resolves the selected DNA-content channel to each file's FCS parameter index.
- Loads only the selected DNA-content column from each selected FCS file.
- Loads selected files in small batches, controlled by
  `ANALYSIS_FILE_CONCURRENCY`.
- Computes a shared x-axis range from the 0.5th to 99.5th percentile of a
  downsample, limiting the effect of extreme outliers.
- Converts each selected sample into a normalized histogram density trace.
- Renders overlaid sample density curves with Plotly.
- Removes a trace when a plotted row is unchecked, and re-renders when rows are
  added back so shared ranges stay consistent.

### `assets/img/*`

Static image assets used by the interface:

- `logo.png` is displayed in the page header.
- `chevron-down-icon.svg` and `chevron-right-icon.svg` indicate whether the
  loaded sample panel is expanded or collapsed.

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

Because this is a static browser app, there is no install step.

The simplest option is to open `index.html` directly in a browser:

```text
index.html
```

For a more realistic local development setup, serve the directory with any
static HTTP server:

```bash
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000/
```

Plotly is loaded from:

```text
https://cdn.plot.ly/plotly-2.35.2.min.js
```

That means plotting requires network access unless Plotly is vendored locally
and the script tag in `index.html` is changed.

## Typical Workflow

1. Open the app in a browser.
2. Drop `.fcs` files on the drop zone, or click the drop zone to choose files.
3. Wait for metadata loading to finish.
4. Review and edit the sample annotations in the table.
5. Use table filters or sorting if needed.
6. Confirm the DNA-content area channel selection.
7. Check the rows that should be included in the plot.
8. Click `Start Analysis`.
9. Review the overlaid density plot.
10. Check or uncheck rows to add or remove plotted samples.

## Development Notes

- The app currently stores all state in memory. Reloading the page clears loaded
  files, annotations, selections, filters, and plots.
- No files are sent to a backend by this code.
- There is no package manager configuration or bundler in the repository.
- The JavaScript is plain browser JavaScript, so changes can be tested by
  refreshing the page.
- `main.js` currently includes `applyDebugChannelDefaults`, which automatically
  selects `GFP/FITC-A` when that channel exists. The inline comment marks this
  as a debug helper to remove for production.
