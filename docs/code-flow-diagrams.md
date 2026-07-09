# PhaseFinder Code Flow Diagrams

These diagrams document the browser app (everything under `js/`) after the
conversion to native ES modules. Rather than one giant map, the structure is
split into several focused diagrams so each stays readable: the module
dependency layers, the ordered startup bootstrap, the cross-module contracts
(the single debug hook + custom events), and the three main runtime flows (file
load, plotting/modeling, and session save/load).

Key facts that shape every diagram:

- The app loads as a **single ES-module entry** (`index.html` →
  `<script type="module" src="./js/main.js">`). There is no hand-maintained
  script order; the dependency graph is the `import` statements.
- Internal wiring is 100% ES imports. The **only** global is the deliberate debug
  hook `window.PhaseFinder = { app, djf, plot }`.
- The **DJF numeric stack** (`analysis/djf.js` + `ml-levenberg-marquardt` +
  `ml-gsd`) is **lazy-loaded** via `plotting/djf_loader.js` on the first
  correction/modeling action, so it stays off the initial load path.
- d3 and the ml-\* libraries are **vendored ESM** (`js/vendor/`) mapped via the
  import map. Two **module workers** (`fcs/data_worker.js`,
  `session/copy_worker.js`) import local files directly.

## 1. Module dependency layers

Imports point from outer layers to inner ones only (an importer → what it
imports). The dashed edge is the lazy `import()` of the DJF stack; the dotted
edges are the two module workers.

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 55, "rankSpacing": 80, "curve": "basis"}, "themeVariables": {"fontSize": "15px"}}}%%
flowchart TD
  subgraph entry["entry"]
    MAIN["main.js<br/>init_*() bootstrap + window.PhaseFinder hook"]
  end

  subgraph ui["ui / plotting / analysis / session-orchestration (DOM + side effects)"]
    direction LR
    UISTATUS["ui/status_channels"]
    UITABLE["ui/table_render<br/>ui/table_support"]
    UIWIZ["ui/metadata_wizard"]
    UIPANELS["ui/panels · ui/panel_resize · ui/hover_text"]
    PRENDER["plotting/render"]
    PMODEL["plotting/modeling"]
    PAXIS["plotting/axis_modal"]
    ASTART["analysis/start"]
    ASTATS["analysis/stats"]
    SCORE["session/core"]
    STABLE["session/table_session"]
  end

  subgraph io["io / adapters (browser APIs, workers)"]
    direction LR
    FMETA["fcs/metadata_processing"]
    IOMETA["io/metadata_io"]
    IOCHAN["io/channel_loading"]
    SOPFS["session/opfs_fs"]
    SCACHE["session/file_cache"]
    SRECON["session/reconnect"]
    PLOADER["plotting/djf_loader"]
    FWORKER["fcs/data_worker (module worker)"]
    CWORKER["session/copy_worker (module worker)"]
  end

  subgraph state["state (owned mutable state + queries + DOM refs)"]
    direction LR
    APPSTATE["state/app_state"]
    FILES["state/files"]
    TSTATE["data_structs/table_state"]
    CCACHE["data_structs/channel_cache"]
    PDATA["plotting/data"]
    DOM["ui/dom"]
  end

  subgraph core["core / domain (pure, no DOM)"]
    direction LR
    PARSER["fcs/parser"]
    CLEAN["fcs/channel_cleaning"]
    PMAP["io/parameter_map"]
    MFRAME["data_structs/metadata_frame"]
    MCOLS["data_structs/metadata_columns"]
    TOML["session/toml_io"]
    DJF["analysis/djf (lazy)"]
    UHTML["util/html"]
    UNAMES["util/names"]
  end

  subgraph vendor["vendor (ESM via import map)"]
    D3["d3"]
    MLLM["ml-levenberg-marquardt"]
    MLGSD["ml-gsd"]
  end

  MAIN --> ui
  ui --> io
  io --> state
  state --> core
  PRENDER --> D3
  PAXIS --> D3
  PLOADER -. "dynamic import()" .-> DJF
  DJF --> MLLM
  DJF --> MLGSD
  IOCHAN -. "new Worker(type:module)" .-> FWORKER
  SCACHE -. "new Worker(type:module)" .-> CWORKER
  FWORKER --> PARSER
```

## 2. Startup bootstrap (replaces the old script order)

`main.js` imports the whole graph, then runs the `init_*()` functions in
dependency order and finally assigns the debug hook. `init_session()` defers
`try_autoload()` to a macrotask so the rest of the bootstrap finishes first.

```mermaid
flowchart TD
  ENTRY["index.html: &lt;script type=module src=./js/main.js&gt;<br/>(deferred: runs after DOM parse)"]
  ENTRY --> B0["module graph evaluates<br/>ui/dom + plotting/data capture DOM refs (querySelector)"]
  B0 --> B1["init_tooltips()<br/>install shared tooltip element + listeners"]
  B1 --> B2["init_app_bootstrap()<br/>Tooltips.apply_static() · wire file/drag/channel/table/wizard events<br/>clear_channel_controls() · render_file_table() · set_status()"]
  B2 --> B3["init_plot_listeners()<br/>plot controls · corrections · fcs-selection-change · axis modal · resize"]
  B3 --> B4["init_analysis_listeners()<br/>plot buttons · panel toggles · fcs-channel-change · modeling buttons"]
  B4 --> B5["init_stats()<br/>stats modal · pf-files-loaded auto-compute"]
  B5 --> B6["init_panel_resize()<br/>sidebar + workspace drag handlers"]
  B6 --> B7["init_session()<br/>save/load/reset + reconnect wiring · setTimeout(try_autoload, 0)"]
  B7 --> HOOK["window.PhaseFinder = { app, get djf(), plot }"]
  B7 -. "macrotask" .-> AUTO["try_autoload(): fetch phasefinder_local.json → apply_session → restore_session_files"]
```

## 3. Cross-module contract: the single hook + custom events

The former per-namespace globals collapse into one hook (`window.PhaseFinder`);
`djf` is a getter over the lazily loaded module (null until first modeling).
Modules coordinate at runtime through a handful of `document` custom events.

```mermaid
flowchart LR
  subgraph hook["window.PhaseFinder (debug/automation seam)"]
    APP["app<br/>get_file_by_id · get_parsed_files · get_selected_files<br/>get_file_table · get_selected_channels · status/progress helpers<br/>get_session_table_state · apply_session_state · metadata_table_tsv · get_table_columns"]
    HDJF["djf (getter)<br/>null → analysis/djf.js module after first modeling/correction"]
    HPLOT["plot<br/>series · get_series · series_names · get_histogram · histogram_names"]
  end

  subgraph events["document custom events"]
    E1["pf-files-loaded"]
    E2["fcs-selection-change"]
    E3["fcs-channel-change"]
    E4["pf-plot-started / pf-plot-complete"]
    E5["pf-stats-complete"]
  end

  IO["io/metadata_io: load_files()"] -->|dispatch| E1
  E1 --> ASTATS["analysis/stats: auto-compute stats"]
  E1 --> SCORE["session/core: apply pending session annotations"]
  E1 --> SCACHE["session/file_cache: register_loaded_files (OPFS cache)"]

  TABLE["ui/table_render: row/select changes"] -->|dispatch| E2
  E2 --> ASTART["analysis/start: refresh_analysis_after_metadata_change"]
  E2 --> PAXIS["plotting/axis_modal: render_density_plot"]

  MAINCH["main.js: channel change"] -->|dispatch| E3
  E3 --> ASTART2["analysis/start: prepare_selected_channel_for_plotting"]

  ASTATS2["analysis/stats: calculate"] -->|dispatch| E5
  E5 --> ASTATS
```

## 4. Flow A — FCS file load → metadata table

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant MAIN as main.js (event wiring)
  participant IO as io/metadata_io.load_files
  participant FMP as fcs/metadata_processing
  participant PARSER as fcs/parser (FCSParser)
  participant STATE as state/app_state (file_map + frame)
  participant WIZ as ui/metadata_wizard
  participant REND as ui/table_render
  participant FC as session/file_cache
  participant CW as copy_worker (OPFS)

  U->>MAIN: drop / pick FCS files
  MAIN->>IO: load_files(files)
  loop each file
    IO->>FMP: read_fcs_header(file)
    FMP->>PARSER: parse_header + parse_fcs_header_from_segments
    PARSER-->>FMP: summary (no DATA read)
    FMP-->>IO: { id, name, file, summary }
    IO->>STATE: file_map.set(id, entry)
  end
  IO->>STATE: set_file_table(concat_frames(frame, make_frame(new rows)))
  IO->>WIZ: apply_current_filename_metadata_template() (if compatible)
  IO->>MAIN: dispatch pf-files-loaded
  IO->>FC: register_loaded_files(entries)
  FC->>CW: copy_file_to_opfs (background, "Caching file x of y")
  IO->>REND: sort_file_table() → update_views() → render_file_table()
  IO->>IO: refresh_analysis / preload (only if a plot already exists)
```

## 5. Flow B — Plot channel events → lazy DJF → modeling

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant ST as analysis/start
  participant CL as io/channel_loading
  participant W as fcs/data_worker (module worker)
  participant MOD as plotting/modeling
  participant LOADER as plotting/djf_loader
  participant DJF as analysis/djf (+ ml-*)
  participant REND as plotting/render (d3)

  U->>ST: click "Plot Channel Events"
  ST->>CL: load_analysis_data()
  loop selected rows (batched)
    CL->>W: postMessage(file, summary, selected_indexes)
    W->>W: FCSParser.parse_selected_columns (DATA slice)
    W-->>CL: Float64Array columns (transferred)
    CL->>CL: filter_selected_channel_values → channel_cache
  end
  CL->>MOD: init_plot(selected) → render_density_plot()
  REND-->>U: histograms drawn with d3 (no DJF yet)
  U->>MOD: click "Start Modeling (DJF)"
  MOD->>LOADER: await load_djf()
  LOADER-->>DJF: dynamic import("../analysis/djf.js") (progress overlay, once)
  MOD->>REND: set_modeling_started(true) → render_density_plot()
  REND->>DJF: get_djf().fit / components / phase_stats (per shown sample)
  REND-->>U: filled G1/S/G2 curves + fit-results table + %G1/%S/%G2 readout
```

Note: enabling **debris/doublet corrections** takes the same lazy path — the
render pass sees `needs_djf` and triggers `load_djf()`, drawing the raw
histogram immediately and redrawing corrected once the module resolves.

## 6. Session save / load / restore

```mermaid
flowchart TD
  subgraph save["Save"]
    SV0["#save_session_button → session/core.handle_save"]
    SV1["collect_session()<br/>get_session_table_state (session/table_session) · get_stats_plan (analysis/stats)<br/>build_file_records_for (session/file_cache)"]
    SV2["serialize_session() (session/toml_io)"]
    SV3["write_session_file() — File System Access API or download fallback"]
    SV0 --> SV1 --> SV2 --> SV3
  end

  subgraph load["Load / autoload"]
    LD0["#load_session_button → handle_load<br/>(or try_autoload from phasefinder_local.json)"]
    LD1["read_session_file() → parse_session_toml() (session/toml_io)"]
    LD2["apply_session()<br/>apply_plot_settings · apply_table_session → apply_session_state (session/table_session)<br/>restore_stats_plan (analysis/stats)"]
    LD3["restore_session_files()"]
    LD0 --> LD1 --> LD2 --> LD3
  end

  subgraph restore["restore_session_files decision"]
    R0{"OPFS copies present?"}
    R1["try_load_from_opfs (session/reconnect)<br/>→ load_files(recovered)"]
    R2{"dev data_directory set<br/>and files still missing?"}
    R3["fetch_files_from_url → load_files"]
    R4{"anything still missing?"}
    R5["open_reconnect_modal (session/reconnect)<br/>folder picker / file picker → match by name+size+mtime<br/>→ copy_file_to_opfs → load_files"]
    R6["Session restored"]
    R0 -- yes --> R1 --> R2
    R0 -- no --> R2
    R2 -- yes --> R3 --> R4
    R2 -- no --> R4
    R4 -- yes --> R5 --> R6
    R4 -- no --> R6
  end

  LD3 --> R0
```
