# PhaseFinder Code Flow Diagrams

These diagrams document the current ES-module browser application on the
`djf-pipeline` branch. They separate module topology, state ownership, FCS data
loading, the staged Dean–Jett–Fox pipeline, rendering, and session restore so
each diagram remains useful at a readable scale.

Key architectural facts:

- `index.html` loads one module entry, `js/main.js`; imports define runtime
  ordering after the explicit `init_*()` bootstrap.
- D3 is the only vendored third-party module. Peak detection and nonlinear
  fitting are repository-native modules under `js/analysis/djf/`.
- `pipeline_loader.js` lazy-loads `djf/index.js` on the first stage action.
  Pipeline UI, state-aware rendering, and the Stage 2 scatter viewer are part of
  the eager application shell.
- Loaded event channels remain full-length and aligned to original FCS event
  indexes. Stage 0–3 masks are composed without compacting those arrays.
- Pipeline state is per sample and guarded by row id, channel key, and event
  count. Re-running an upstream stage invalidates every downstream product.
- `render_density_plot()` reads stored pipeline outputs; it never fits a model.

## 1. Runtime module topology

Solid arrows are ordinary ES imports. Dashed arrows identify a dynamic import
or a module worker boundary. The diagram shows responsibility regions rather
than claiming a strictly acyclic import graph—plot rendering and initialization
contain a few intentional ES-module cycles.

```mermaid
flowchart LR
  subgraph entry["Entry"]
    HTML["index.html<br/>import map: d3"] --> MAIN["js/main.js<br/>ordered bootstrap"]
  end

  subgraph shell["Eager application shell"]
    UI["ui/*<br/>table · wizard · status · panels"]
    START["analysis/start.js<br/>channel + plot orchestration"]
    STATS["analysis/stats.js"]
    PLOT["plotting/*<br/>data · render · modeling · axis"]
    PUI["analysis/djf/pipeline_ui.js<br/>stage controls"]
    PLOAD["analysis/djf/pipeline_loader.js"]
    PST["analysis/djf/pipeline_state.js"]
    SCATTER["analysis/djf/scatter_modal.js<br/>Stage 2 inspection"]
    SESSION["session/core.js<br/>save · load · restore"]
  end

  subgraph stateio["State and IO"]
    APPSTATE["state/* + data_structs/*<br/>files · frame · selection · caches"]
    METAIO["io/metadata_io.js"]
    CHANNELIO["io/channel_loading.js"]
    FCSMETA["fcs/metadata_processing.js"]
    CLEAN["fcs/channel_cleaning.js<br/>channel discovery + aligned arrays"]
    PARSER["fcs/parser.js"]
    FILECACHE["session/file_cache.js + reconnect.js"]
  end

  subgraph lazy["Lazy DJF orchestrator and stages"]
    PIPE["analysis/djf/index.js<br/>stage orchestrator"]
    STAGES["stage0 … stage8<br/>+ background stub"]
  end

  subgraph sharedmath["Shared DJF numeric modules"]
    MATH["math/* + djf_components.js"]
  end

  subgraph adapters["Browser adapters"]
    FWORKER["fcs/data_worker.js"]
    CWORKER["session/copy_worker.js"]
    OPFS["session/opfs_fs.js"]
    D3["vendor/d3.min.js"]
  end

  MAIN --> UI
  MAIN --> START
  MAIN --> STATS
  MAIN --> PLOT
  MAIN --> PUI
  MAIN --> PLOAD
  MAIN --> SESSION
  UI --> APPSTATE
  START --> CHANNELIO
  START --> PLOT
  STATS --> CHANNELIO
  PLOT --> APPSTATE
  PLOT --> PST
  PLOT --> D3
  PUI --> PLOAD
  PUI --> PLOT
  PUI --> SCATTER
  SCATTER --> D3
  SCATTER --> MATH
  PLOAD -. "import() once" .-> PIPE
  PIPE --> STAGES
  PIPE --> PST
  PIPE --> PLOT
  STAGES --> MATH
  METAIO --> FCSMETA
  METAIO --> APPSTATE
  METAIO --> FILECACHE
  FCSMETA --> PARSER
  CHANNELIO --> CLEAN
  CHANNELIO --> APPSTATE
  CHANNELIO -. "module worker" .-> FWORKER
  FWORKER --> PARSER
  FILECACHE --> OPFS
  FILECACHE -. "module worker" .-> CWORKER
```

## 2. Ordered startup bootstrap

Module evaluation resolves imports first. The explicit bootstrap then installs
listeners in a deliberate order and finally publishes the debug/automation
hook. Both `pipeline` and the compatibility alias `djf` are null until the
pipeline core has actually loaded.

```mermaid
flowchart LR
  H["index.html<br/>script type=module"] --> M["evaluate main.js imports"]
  M --> I1["init_tooltips()"]
  I1 --> I2["init_app_bootstrap()"]
  I2 --> I3["init_plot_listeners()"]
  I3 --> I4["init_analysis_listeners()"]
  I4 --> I5["init_pipeline_ui()"]
  I5 --> I6["init_stats()"]
  I6 --> I7["init_panel_resize()"]
  I7 --> I8["init_session()"]
  I8 --> HOOK["window.PhaseFinder<br/>{ app, get pipeline(), get djf(), plot }"]
  I8 -. "setTimeout(..., 0)" .-> AUTO["session/core.try_autoload()"]
  I5 -. "first Stage / Run all click" .-> LAZY["pipeline_loader.load_pipeline()<br/>dynamic import djf/index.js"]
```

## 3. State ownership and runtime contracts

Direct imports handle most communication. Custom events are used where one user
action has multiple downstream consumers. Pipeline masks/results are runtime
state and are intentionally not part of session serialization.

```mermaid
flowchart TB
  subgraph owners["State owners"]
    A["state/app_state.js<br/>file_map + metadata frame"]
    T["data_structs/table_state.js<br/>selection · filters · sort"]
    C["data_structs/channel_cache.js<br/>per-row/per-channel Map<br/>active row.data"]
    P["plotting/data.js<br/>active channel · series · histograms · axes"]
    D["djf/pipeline_state.js<br/>Map keyed by filename<br/>row.data.masks"]
    F["session/file_cache.js<br/>OPFS file records"]
  end

  subgraph events["Document events"]
    E1["pf-files-loaded"]
    E2["fcs-selection-change"]
    E3["fcs-channel-change"]
    E4["pf-plot-started / pf-plot-complete"]
    E5["pf-stats-complete"]
  end

  META["metadata_io.load_files()"] --> A
  META --> E1
  META --> F
  E1 --> STAUTO["stats: compute saved metrics for new files"]
  E1 --> SESS["session: replay pending table state"]
  TABLE["table_support.notify_selection_changed()"] --> T
  TABLE --> E2
  E2 --> REFRESH["analysis/start: load added rows"]
  E2 --> REDRAW["axis_modal: redraw checked rows"]
  CHANNEL["main.notify_channel_changed()"] --> E3
  E3 --> PRELOAD["analysis/start: preload/activate channel<br/>plot switch stays explicit"]
  START["analysis/start.start_analysis()"] --> E4
  STATS["analysis/stats"] --> E5
  E5 --> STATS
  PRELOAD --> C
  START --> C
  REDRAW --> P
  PIPE["djf/index.js run_stageN()"] --> D
  D --> REDRAW
  HOOK["window.PhaseFinder"] -. "read-only debug access" .-> A
  HOOK -.-> P
  HOOK -. "after lazy load" .-> D
```

## 4. Two-phase FCS loading

Initial file load reads only HEADER/TEXT metadata. Event DATA is loaded later,
in batches, when a DNA-area channel is plotted. All pipeline companion channels
are loaded together and retained as original-index `Float64Array` values.

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant MAIN as main.js
  participant META as io/metadata_io
  participant MH as fcs/metadata_processing
  participant PARSER as fcs/parser
  participant STATE as app_state + metadata frame
  participant CACHE as session/file_cache
  participant COPY as copy_worker / OPFS

  U->>MAIN: drop or choose FCS files
  MAIN->>META: load_files(files)
  loop each new file
    META->>MH: read_fcs_header(file)
    MH->>PARSER: parse HEADER + TEXT only
    PARSER-->>META: summary, columns, Pn metadata, DATA offsets
    META->>STATE: file_map.set + make/concat frame
  end
  META->>META: link imported rows + apply filename template
  META-->>MAIN: dispatch pf-files-loaded
  META->>CACHE: register_loaded_files(entries)
  CACHE-->>COPY: cache copies in background
  META->>STATE: sort/update/render table + channel controls
```

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant START as analysis/start
  participant IO as io/channel_loading
  participant MAP as parameter_map + channel_cleaning
  participant WORKER as fcs/data_worker
  participant PARSER as FCSParser
  participant CACHE as channel_cache
  participant MODEL as plotting/modeling
  participant RENDER as plotting/render

  U->>START: click Plot Channel Events
  START->>IO: load_analysis_data()
  loop all loaded rows, batches of 4
    IO->>MAP: resolve DNA-A/H/W, FSC-A, SSC-A, Time
    IO->>WORKER: parse selected parameter columns
    WORKER->>PARSER: parse_selected_columns(DATA slice)
    PARSER-->>IO: requested raw columns
    IO->>MAP: build_raw_analysis_channels()
    Note over IO,MAP: Full-length aligned Float64Arrays<br/>PnR + parameter metadata + empty masks
    IO->>CACHE: store per-channel data and activate row.data
  end
  IO->>MODEL: init_plot(selected channel)
  MODEL->>RENDER: render_density_plot()
  RENDER-->>U: checked samples drawn with D3
  START-->>U: enable Run DJF Pipeline shortcut
```

## 5. Staged DJF dataflow

Stages 1–3 are optional. When their required channels are unavailable, their
mask slot remains null and prior masks still apply. Stage 5 records peak-pair
diagnostics, but Stage 6 initializes and fits independently from the Stage 4
histogram; a `found:false` Stage 5 result does not stop Run all.

```mermaid
flowchart LR
  RAW["Raw original-index channels<br/>DNA-A/H/W · FSC-A · SSC-A · Time"] --> S0["Stage 0<br/>Structural QC<br/>structural mask"]
  S0 --> S1["Stage 1 optional<br/>Time QC<br/>time mask or null"]
  S1 --> S2["Stage 2 optional<br/>FSC/SSC GMM<br/>scatter mask or null"]
  S2 --> S3["Stage 3 optional<br/>pulse-geometry ridge<br/>singlet mask or null"]
  S3 --> FINAL["Final mask<br/>AND all non-null masks"]
  FINAL --> S4["Stage 4<br/>shared-range DNA histogram"]
  S4 --> S5["Stage 5<br/>near-2:1 peak diagnostics"]
  S4 --> S6["Stage 6<br/>constrained base DJF fit"]
  S5 -. "diagnostic only" .-> REPORTING["state.peaks"]
  S6 --> S7["Stage 7 optional<br/>debris/aggregate candidates<br/>conservative model selection"]
  S6 --> CHOOSE["baseFit"]
  S7 --> CHOOSE["extendedFit when selected"]
  CHOOSE --> S8["Stage 8<br/>1C/S/2C fractions<br/>contamination + GoF<br/>residual diagnostics + warnings"]
  S8 --> BG["General background<br/>explicitly unspecified stub"]
```

## 6. Manual-stage orchestration and invalidation

The UI runs one selected stage across all currently plottable samples. Run all
loops through the same UI path from Stage 0 to Stage 8. Every stage redraws, so
rerunning upstream work immediately removes stale downstream visuals.

```mermaid
flowchart TD
  USER["Stage N button<br/>or Run all"] --> ROWS{"Any plottable rows?"}
  ROWS -- "no" --> ERR["readout + status error"]
  ROWS -- "yes" --> LOCK["lock pipeline controls<br/>show progress"]
  LOCK --> LOAD["load_pipeline()<br/>singleton dynamic import"]
  LOAD --> OPT{"Stage 4?"}
  OPT -- "yes" --> RANGE["shared_histogram_range(rows)"]
  OPT -- "no" --> EACH
  RANGE --> EACH["for each row: run_stage(N, row, options)"]
  EACH --> GUARD["get_or_create_state()<br/>guard rowId/channelKey/eventCount"]
  GUARD --> PURE["run pure Stage N function"]
  PURE --> STORE["store product and mask/null"]
  STORE --> MASK["recompute final mask"]
  MASK --> INVALID["invalidate_after()<br/>clear all downstream products/masks"]
  INVALID --> DRAW["render_density_plot()"]
  DRAW --> MODAL{"Direct successful Stage 2?"}
  MODAL -- "yes" --> SCATTER["open scatter/GMM modal"]
  MODAL -- "no" --> DONE
  SCATTER --> DONE["update readout/status<br/>unlock controls"]
  RUNALL["Run all"] -. "repeat N = 0…8<br/>suppress Stage 2 modal" .-> EACH
```

## 7. State-aware render path

The render pass chooses the newest valid stored checkpoint for each active row.
It does not call any numerical stage function.

```mermaid
flowchart TD
  R0["render_density_plot()"] --> R1["plottable_rows()<br/>checked + active channel"]
  R1 --> R2{"Matching pipeline state?<br/>same channelKey"}
  R2 -- "no" --> RAW["build raw display histogram"]
  R2 -- "yes" --> H{"Stage 4 histogram exists?"}
  H -- "no" --> RAW
  H -- "yes" --> HIST["use stored histogram<br/>and final-mask values"]
  RAW --> SERIES["sample series + plot caches"]
  HIST --> SERIES
  SERIES --> FIT{"baseFit or extendedFit?"}
  FIT -- "yes" --> CURVES["convert stored G1/S/G2/total<br/>+ selected debris/aggregate curves"]
  FIT -- "no" --> D3["D3 draw samples, axes, legend"]
  CURVES --> D3
  D3 --> REP{"Stage 8 report?"}
  REP -- "yes" --> TABLE["render_fit_results_table()<br/>fractions · contamination<br/>GoF · warnings"]
  REP -- "no" --> END["update title and inspection API"]
  TABLE --> END
```

## 8. Session save, load, and reconnect

Sessions serialize metadata, table state, channel/plot settings, statistics
plans, file records, and layout. DJF masks, fits, and reports are runtime-only;
legacy correction flags are written as false for compatibility.

```mermaid
flowchart TD
  subgraph save["Save"]
    SV0["#save_session_button<br/>handle_save()"] --> SV1["collect_session()<br/>table · metadata · stats plan<br/>file records · plot · layout"]
    SV1 --> SV2["serialize_session()"]
    SV2 --> SV3["write_session_file()<br/>picker or download fallback"]
    SV1 -. "excluded" .-> RUNTIME["pipeline masks / fits / report"]
  end

  subgraph load["Load / autoload"]
    LD0["#load_session_button<br/>or try_autoload()"] --> LD1["read + parse_session_toml()"]
    LD1 --> LD2["apply_session()<br/>plot · table · stats · layout"]
    LD2 --> LD3["restore_session_files()"]
  end

  LD3 --> OPFS{"Valid OPFS copies?"}
  OPFS -- "yes" --> RECOVER["try_load_from_opfs()<br/>load_files(recovered)"]
  OPFS -- "no" --> DEV{"Configured dev URL?"}
  RECOVER --> DEV
  DEV -- "yes" --> FETCH["fetch_files_from_url()"]
  DEV -- "no" --> MISS{"Files still missing?"}
  FETCH --> MISS
  MISS -- "yes" --> MODAL["reconnect modal<br/>folder/files match by metadata"]
  MODAL --> COPY["copy_file_to_opfs()<br/>load_files()"]
  MISS -- "no" --> READY["session restored"]
  COPY --> READY
```
