# PhaseFinder Code Flow Diagrams

These diagrams document the current ES-module browser application. They
separate module topology, state ownership, FCS data
loading, the QC and cell-cycle modeling pipeline, rendering, and session restore
so each diagram remains useful at a readable scale.

Key architectural facts:

- `index.html` loads one module entry, `js/main.js`; imports define runtime
  ordering after the explicit `init_*()` bootstrap.
- D3 is the only vendored third-party module. Peak detection and nonlinear
  fitting are repository-native modules under `js/analysis/cell_cycle/`.
- `pipeline_loader.js` lazy-loads `pipeline/cell_cycle_pipeline.js` on the first QC/modeling action.
  Pipeline UI, state-aware rendering, and the Stage 2 scatter viewer are part of
  the eager application shell.
- Loaded event channels remain full-length and aligned to original FCS event
  indexes. Stage 0–3 masks are composed without compacting those arrays.
- Pipeline state is per sample and guarded by row id, channel key, and event
  count. Re-running an upstream stage invalidates every downstream product.
- The `render_density_plot()` pass reads stored pipeline outputs; it never fits
  a model. (The peak-region drag handler installed by that pass does refit the
  one edited sample, but only on commit, after the pass has returned.)

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
    START["analysis/pipeline/start.js<br/>channel + plot orchestration"]
    STATS["ui/table_summary_stats.js"]
    PLOT["plotting/*<br/>data · render · modeling · axis"]
    PUI["analysis/pipeline/pipeline_ui.js<br/>stage controls"]
    PLOAD["analysis/pipeline/pipeline_loader.js"]
    PST["analysis/pipeline/pipeline_state.js"]
    SCATTER["analysis/gating/scatter_modal.js<br/>Stage 2 inspection"]
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

  subgraph lazy["Lazy QC/modeling orchestrator"]
    PIPE["analysis/pipeline/cell_cycle_pipeline.js<br/>QC + histogram orchestrator"]
    STAGES["qc · gating · cell_cycle<br/>gate, detection, and model modules"]
  end

  subgraph sharedmath["Shared numeric modules"]
    MATH["analysis/math/*"]
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
  I5 -. "first QC Apply / Run All click" .-> LAZY["pipeline_loader.load_pipeline()<br/>dynamic import pipeline/cell_cycle_pipeline.js"]
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
    D["pipeline/pipeline_state.js<br/>Map keyed by filename<br/>row.data.masks"]
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
  STATS["ui/table_summary_stats"] --> E5
  E5 --> STATS
  PRELOAD --> C
  START --> C
  REDRAW --> P
  PIPE["pipeline/cell_cycle_pipeline.js apply_*_fast()<br/>apply_dna_histogram()"] --> D
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
  START-->>U: enable the QC gate controls
```

## 5. QC and cell-cycle modeling dataflow

Stages 1–3 are optional. When their required channels are unavailable, their
mask slot remains null and prior masks still apply. Everything downstream of the
Stage 4 histogram is model-neutral: peak detection proposes G1/G2 regions, the
user accepts or edits them, and whichever registered model the user picked reads
the histogram plus those regions. Peak regions identify peaks — they are not
phase gates, and the optimizer may never move them.

```mermaid
flowchart LR
  RAW["Raw original-index channels<br/>DNA-A/H/W · FSC-A · SSC-A · Time"] --> S0["Stage 0<br/>Structural QC<br/>structural mask"]
  S0 --> S1["Stage 1 optional<br/>Time QC<br/>time mask or null"]
  S1 --> S2["Stage 2 optional<br/>FSC/SSC GMM<br/>scatter mask or null"]
  S2 --> S3["Stage 3 optional<br/>pulse-geometry ridge<br/>singlet mask or null"]
  S3 --> FINAL["Final mask<br/>AND all non-null masks"]
  FINAL --> S4["Stage 4<br/>shared-range DNA histogram"]
  S4 --> DETECT["modeling_state.detect_peak_regions()<br/>multi-scale G1/G2 pair detection"]
  DETECT --> REGIONS["modeling.peakSelection.regions<br/>accepted or manually edited"]
  S4 --> FIT["modeling_state.fit_cell_cycle_model(row, modelId)<br/>registry lookup · preflight · worker fit"]
  REGIONS --> FIT
  FIT --> CONTRACT["result_contract.apply_result_contract()<br/>validForReporting · fractions · GoF · warnings"]
  CONTRACT --> STORE["modeling.resultsByKey"]
  JOINT["CLOCCS · fitScope joint_series<br/>run_cloccs_joint_fit() over a strain's timepoints"] -.-> STORE
```

## 6. QC application and fit orchestration

There are no stage-number buttons. The QC panel applies whichever gates are
checked across all plottable samples in one pass, then rebuilds every histogram
so the modeling panel always reads fresh, correctly filtered bins. Fitting is a
separate, explicitly chosen action: the model dropdown opens on a placeholder,
so both Fit buttons stay disabled until the user picks a model.

```mermaid
flowchart TD
  USER["Apply / Run All<br/>(checked QC gates)"] --> ROWS{"Any plottable rows?"}
  ROWS -- "no" --> ERR["status-bar error"]
  ROWS -- "yes" --> LOCK["set_qc_controls_disabled(true)<br/>mark checked gates running<br/>show progress"]
  LOCK --> LOAD["load_pipeline()<br/>singleton dynamic import"]
  LOAD --> COMP["ensure_companions_loaded(rows)<br/>when any gate ≥ Time QC is checked"]
  COMP --> EACH["for each row: reset_qc_gates(row)<br/>then each checked gate in order"]
  EACH --> FAST["apply_structural_qc_fast()<br/>apply_time_qc_fast(method options)<br/>apply_cell_gate_fast()<br/>apply_singlet_gate_fast()"]
  FAST -- "throws" --> FAIL["record_qc_failure(row, filterIndex)<br/>stop this row's chain"]
  FAST --> HIST["regenerate_histograms(rows, pipeline)<br/>shared_histogram_range + apply_dna_histogram"]
  FAIL --> HIST
  HIST --> REQ["state.requiredQc = checked gate names"]
  REQ --> COLS["compute_gate_state_matrix()<br/>update_qc_columns / gate buttons<br/>render_time_qc_summary()"]
  COLS --> DRAW["render_density_plot()"]
  DRAW --> DONE["qc_completion_message()<br/>unlock controls"]

  FITBTN["Fit Current / Fit All Samples"] --> MODEL{"Model chosen?"}
  MODEL -- "no" --> FITERR["buttons stay disabled"]
  MODEL -- "yes" --> WAIVER["approve_degraded_qc(rows)"]
  WAIVER --> DISPATCH["fit_cell_cycle_model(row, modelId)<br/>bulk: run_with_limit() over the worker pool"]
  DISPATCH --> REFRESH["refresh_panel() + render_density_plot()<br/>dispatch cell-cycle-fit-changed"]
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
  SERIES --> FIT{"pipeline_fit_for_series():<br/>active model result with<br/>components + expectedCounts?"}
  FIT -- "yes" --> CURVES["build_fit_series_entry()<br/>stored G1/S/G2/total component curves"]
  FIT -- "no" --> D3["D3 draw samples, axes, legend"]
  CURVES --> D3
  D3 --> REP{"Any fit collected?"}
  REP -- "yes" --> TABLE["render_fit_results_table()<br/>fractions · contamination<br/>GoF · warnings"]
  REP -- "no" --> END["update title and inspection API"]
  TABLE --> END
```

## 8. Session save, load, and reconnect

Sessions serialize metadata, table state, channel/plot settings, statistics
plans, file records, and layout. QC masks, fits, and reports are runtime-only;
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

## 9. Production build and deployment

The reviewed Vite artifact is the deployment unit. Release jobs do not rebuild
after inspection: checksums, manifest, SBOM, build metadata, and deployed files
all describe the same `dist/` tree.

```mermaid
flowchart LR
  SRC["Source + package-lock<br/>pinned Node/npm"] --> CI["npm ci + npm check"]
  CI --> VITE["vite build<br/>root/base-path pages + workers"]
  VITE --> PROV["generate-provenance.cjs<br/>metadata · SBOM · manifest · SHA256SUMS"]
  PROV --> VERIFY["verify-dist.cjs<br/>crawl links · hashes · privacy · budgets"]
  VERIFY --> SMOKE["dist_smoke.py<br/>serve only dist with production headers"]
  SMOKE --> ARTIFACT["immutable reviewed artifact"]
  ARTIFACT --> APPROVE{"protected production<br/>environment approved?"}
  APPROVE -- no --> HOLD["artifact retained; no deployment"]
  APPROVE -- yes --> CF["Cloudflare Pages<br/>deploy exact artifact"]
```

## 10. Time QC variants and effective settings

Both Time QC methods use one validated settings contract, but retain independent
drafts and algorithm identities. Apply commits atomically; Cancel never changes
live settings or masks.

```mermaid
flowchart TD
  OPEN["time_qc_modal.open()"] --> CLONE["clone live settings into modal draft"]
  CLONE --> METHOD{"selected method"}
  METHOD --> ROBUST["robustSummaryOptions<br/>robust-summary-v2"]
  METHOD --> PEAK["peakTrackingOptions<br/>peak-tracking-v2"]
  ROBUST --> VALIDATE["validate_time_qc_settings()"]
  PEAK --> VALIDATE
  VALIDATE -- invalid --> FIELD["field error + focus<br/>live state unchanged"]
  VALIDATE -- Cancel --> DISCARD["discard draft"]
  VALIDATE -- Apply --> COMMIT["atomic effective settings commit"]
  COMMIT --> HASH["method + algorithm + channels + options identity"]
  HASH --> RUN["cell_cycle_pipeline.run_time_qc()"]
  RUN --> MASK["typed outcome + time mask + provenance"]
```

## 11. Canonical model state and worker boundary

Per-sample modeling state owns reviewed regions, settings, histogram identity,
revision, and versioned results. A fit worker returns calculation output only;
the shared state entry point rejects cancelled, superseded, or stale input
before mutating active/cached results.

```mermaid
flowchart LR
  INPUTS["row bytes/channel + final mask<br/>histogram/domain/bins<br/>reviewed regions + settings"] --> KEY["fingerprint + modeling revision<br/>fitRequestId"]
  KEY --> PREFLIGHT["canonical preflight/result contract"]
  PREFLIGHT --> POOL["fit_worker pool<br/>module worker"]
  POOL --> RESULT["typed candidate result"]
  RESULT --> CURRENT{"same request, revision,<br/>histogram, and signal?"}
  CURRENT -- no --> DROP["FIT_INPUTS_CHANGED / cancelled<br/>no state mutation"]
  CURRENT -- yes --> STORE["resultsByKey + activeResultKey<br/>reporting contract"]
  STORE --> CONSUMERS["plot · ridge badges · table<br/>session recompute · exports"]
```

## 12. OPFS index and cache lifecycle

The cache index is versioned and atomically written. Each logical session owns
references to content-verified files; Reset/release removes only objects no
longer referenced by another session.

```mermaid
flowchart TD
  LOAD["load_files()"] --> RECORD["file_cache record<br/>id · metadata · digest"]
  RECORD --> COPY["copy_worker.js<br/>stream into sessions/&lt;id&gt;/files"]
  COPY --> INDEX["versioned OPFS cache index<br/>atomic replace"]
  SAVE["collect_session()"] --> REFS["logical session + file records<br/>digest algorithm/value"]
  REFS --> INDEX
  RESTORE["session restore"] --> LOOKUP["index lookup + OPFS read"]
  LOOKUP --> VERIFY["size + content digest verification"]
  VERIFY -- valid --> INGEST["same load_files() path as fresh input"]
  VERIFY -- missing/mismatch --> RECONNECT["explicit local reconnect"]
  RESET["Reset / cache manager release"] --> OWNERS{"other session references?"}
  OWNERS -- yes --> KEEP["keep shared cached object"]
  OWNERS -- no --> DELETE["delete owned file/index entry"]
```
