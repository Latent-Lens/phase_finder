# PhaseFinder Function Calls And User Decisions

These graphs map user-facing controls to concrete module functions in the
current application. They intentionally separate setup, channel/plot loading,
QC orchestration, numerical gates, state invalidation, and session/statistics
flows so function names remain readable.

Important distinctions reflected below:

- QC is applied as a set, not stage by stage: `pipeline_ui.apply_qc_selection()`
  resets each row's gates and then runs every *checked* filter in order. There is
  no index-based dispatcher and no stage-number buttons.
- Filter 1–3 skip paths store null optional masks, preserving upstream masks.
- Peak detection proposes G1/G2 regions; the user accepts or edits them. Regions
  are an input to fitting, and the optimizer may never move them.
- Re-applying QC invalidates downstream products before the plot redraws.
- Pipeline results are runtime-only and are not serialized in session files.

## 1. Bootstrap, file load, and metadata calls

```mermaid
flowchart LR
  subgraph boot["Bootstrap"]
    B0["index.html<br/>script type=module"] --> B1["main.js"]
    B1 --> B2["init_tooltips()"]
    B1 --> B3["init_app_bootstrap()"]
    B1 --> B4["init_plot_listeners()"]
    B1 --> B5["init_analysis_listeners()"]
    B1 --> B6["init_pipeline_ui()"]
    B1 --> B7["init_stats()"]
    B1 --> B8["init_panel_resize()"]
    B1 --> B9["init_session()"]
    B1 --> B10["window.PhaseFinder<br/>{ app, pipeline, djf, plot }"]
    B9 -.-> B11["setTimeout(try_autoload, 0)"]
  end

  subgraph fileload["FCS metadata load"]
    F0["#file_input change<br/>drop-zone drop"] --> F1["metadata_io.load_files()"]
    F1 --> F2["metadata_processing.read_fcs_header()<br/>FCSParser HEADER/TEXT parsing"]
    F1 --> F3["file_map.set()<br/>make_frame()/concat_frames()<br/>set_file_table()"]
    F1 --> F4["link_existing_metadata_row_to_loaded_entry()<br/>apply_current_filename_metadata_template()"]
    F1 --> F5["dispatch pf-files-loaded"]
    F1 --> F6["file_cache.register_loaded_files()<br/>copy_worker → OPFS"]
    F1 --> F7["sort_file_table()/update_views()<br/>render_file_table()<br/>populate_channel_controls()"]
    F1 --> F8["refresh_analysis_after_metadata_change()<br/>preload_analysis_rows_in_background()"]
  end

  subgraph metadata["Metadata table"]
    M0["#file_table input"] --> M1["main.update_annotation()<br/>sync_file_annotations()"]
    M2["selection/filter changes"] --> M3["table_render.handle_table_change()<br/>notify_selection_changed()"]
    M3 --> M4["dispatch fcs-selection-change"]
    M5["sort/filter click"] --> M6["handle_table_click()<br/>render_file_table()"]
    M7["filename wizard"] --> M8["open_metadata_wizard()<br/>apply_metadata_wizard()"]
    M9["metadata import"] --> M10["parse_delimited_metadata()<br/>import_metadata_records()"]
    M11["metadata export"] --> M12["metadata_table_tsv()<br/>save_blob()"]
  end

  F5 --> B7
  F5 --> B9
  M4 --> B4
  M4 --> B5
```

## 2. Channel selection, event loading, and plotting calls

Changing a channel preloads/activates its cache but intentionally leaves the
plot switch explicit. Clicking Plot Channel Events loads every file so unchecked
samples can be added later without another DATA read; only checked rows render.

```mermaid
flowchart TD
  C0["#channel_select change"] --> C1["main.notify_channel_changed()"]
  C1 --> C2["dispatch fcs-channel-change"]
  C2 --> C3["start.prepare_selected_channel_for_plotting()"]
  C3 --> C4["enter_plotting_mode()<br/>clear QC gate badges"]
  C3 --> C5{"Channel data cached?"}
  C5 -- "yes" --> C6["channel_cache.activate_analysis_data()"]
  C5 -- "no" --> C7["channel_loading.load_analysis_batch()<br/>activate: false"]
  C7 --> C8["load_analysis_row()"]
  C8 --> C9["selected_indexes_for_file()<br/>DNA-A/H/W + FSC-A + SSC-A + Time"]
  C9 --> C10["data_worker.parse_selected_columns()<br/>main-thread fallback when allowed"]
  C10 --> C11["channel_cleaning.build_raw_analysis_channels()"]
  C11 --> C12["channel_cache.store_analysis_data()"]
  C12 --> C6
  C6 --> C13["render_density_plot()<br/>new channel remains explicit-to-plot"]

  P0["#start_analysis_button<br/>#collapsed_plot_button"] --> P1["start.start_analysis()"]
  P1 --> P2["dispatch pf-plot-started"]
  P1 --> P3["channel_loading.load_analysis_data()"]
  P3 --> P4["load_analysis_batch() → load_analysis_row()<br/>for all loaded files"]
  P4 --> P5["modeling.init_plot()"]
  P5 --> P6["render.render_density_plot()"]
  P1 --> P7["enable_pipeline_action()"]
  P1 --> P8["dispatch pf-plot-complete"]

  P6 --> R0["plotting/data.plottable_rows()"]
  R0 --> R1["read matching pipeline_state"]
  R1 --> R2["use Stage 4 histogram/final mask when present"]
  R2 --> R3["draw samples + stored G1/S/G2 fit<br/>optional debris/aggregate"]
  R3 --> R4["modeling.render_fit_results_table()<br/>fractions · GoF · warnings"]

  U0["Color / bins / display change"] --> P6
  U1["table selection change"] --> P6
  U2["axis double-click"] --> U3["open_axis_range_modal()"]
  U3 --> U4["apply/reset range"]
  U4 --> P6
  U5["window or panel resize"] --> P6
```

## 3. Pre-model QC filter UI calls

The four QC gates are independent **toggles**, not a sequential stage runner.
Toggling any of them recomposes the whole filter selection.

```mermaid
flowchart TD
  M0["#qc_structural / #qc_time<br/>#qc_cellgate / #qc_singlet"] --> M1["set_qc_active(button)"]
  A0["#qc_filter_all 'Run All'"] --> A1{"All already on?"}
  A1 -- "no" --> A2["open_time_qc_method_modal()"]
  A1 -- "yes" --> A3["clear every filter"]
  A2 --> A4["turn every filter on"]
  M1 --> QS["apply_qc_selection()"]
  A3 --> QS
  A4 --> QS

  QS --> Q0{"Already busy,<br/>or no plottable rows?"}
  Q0 -- "yes" --> Q1["return / error status"]
  Q0 -- "no" --> L0["pipeline_loader.load_pipeline()"]
  L0 --> L1["dynamic import pipeline/cell_cycle_pipeline.js"]
  L1 --> M2["disable controls + show progress"]
  M2 --> M3["for each row:<br/>pipeline.reset_qc_gates(row)"]
  M3 --> M4["per checked filter index:<br/>apply_structural_qc_fast / apply_time_qc_fast<br/>apply_cell_gate_fast / apply_singlet_gate_fast"]
  M4 --> M5{"Threw?"}
  M5 -- "yes" --> M6["pipeline.record_qc_failure(row, index, error)"]
  M5 -- "no" --> M7["pipeline.get_state(row.name)"]
  M6 --> M7
  M7 --> M8["render_density_plot()"]
  M8 --> M9["qc_completion_message()<br/>re-enable controls"]

  BG0["Channel finishes plotting"] --> BG1["schedule_qc_precompute()"]
  BG1 --> BG2["load_pipeline_silently()"]
  BG2 --> BG3["precompute_prefilter_qc(rows)"]
  BG3 --> BG4["shared_histogram_range(rows)<br/>clamp_range_to_analysis_domain()"]
  BG4 --> BG5["per row:<br/>ensure_histogram_current(row, {binCount, range})"]
  BG5 --> M8
```

## 4. QC gate and modeling numerical calls

```mermaid
flowchart TD
  S0["pipeline.apply_structural_qc_fast(row)"] --> S0A["structural_qc.runStructuralQC()<br/>createStructuralValidityMask()"]
  S0A --> S0B["set_filter_mask(row, 0, structuralMask)"]

  S0B --> S1Q{"Time QC checked and<br/>Time channel present?"}
  S1Q -- "no" --> S1S["filter 1 skipped<br/>time mask = null"]
  S1Q -- "yes" --> S1A["pipeline.apply_time_qc_fast(row, method options)<br/>acquisition_time_qc.prepareTimeQCBins()<br/>summarizeTimeQCBins() + scoreTimeQCBins()<br/>or peak_tracking_time_qc"]
  S1S --> S2Q
  S1A --> S2Q

  S2Q{"Cell Gate checked and<br/>FSC-A + SSC-A present?"}
  S2Q -- "no" --> S2S["filter 2 skipped<br/>scatter mask = null"]
  S2Q -- "yes" --> S2A["pipeline.apply_cell_gate_fast(row)<br/>scatter_gmm_gate.buildScatterPoints() → fitGMM2D()<br/>scoreScatterComponents()<br/>createScatterGateMask()"]
  S2S --> S3Q
  S2A --> S3Q

  S3Q{"Singlet Gate checked and<br/>DNA-H or DNA-W usable?"}
  S3Q -- "no" --> S3S["filter 3 skipped<br/>singlet mask = null"]
  S3Q -- "yes" --> S3A["pipeline.apply_singlet_gate_fast(row)<br/>pulse_geometry_gate.gateByPulseGeometry()<br/>selectPulseGeometry() → fitRobustRidge2D()<br/>createSingletMaskFromRidge()"]
  S3S --> S4
  S3A --> S4

  S4["pipeline_ui.regenerate_histograms(rows, pipeline)<br/>shared_histogram_range(rows)<br/>pipeline.apply_dna_histogram(row, {binCount, range})<br/>dna_histogram.generateHistogram()"] --> DET

  DET["modeling_state.detect_peak_regions(row)<br/>peak_detection.detectCellCyclePeakPair()<br/>scoreCellCyclePeakPairs()<br/>proposeAutomaticPeakRegions()"] --> DETQ{"Review required?"}
  DETQ -- "yes" --> REV["peak_review_ui / ridge drag handles<br/>update_peak_regions() → accept_peak_regions()"]
  DETQ -- "no" --> REG
  REV --> REG["modeling.peakSelection.regions"]

  REG --> FITQ{"Model chosen in the dropdown?"}
  FITQ -- "no" --> NOFIT["Fit buttons stay disabled"]
  FITQ -- "per-sample model" --> FIT["modeling_state.fit_cell_cycle_model(row, modelId)<br/>resolve_model_configuration() → model_preflight()<br/>fit_client.run_fit_in_worker()<br/>entry.fit() + normalizeResult()"]
  FITQ -- "cloccs (joint_series)" --> CJ["modeling_ui.run_cloccs_joint_fit(rows)<br/>derive_cloccs_timepoints()<br/>cloccs_client → cloccs_worker fitSeries()"]

  FIT --> CON["result_contract.apply_result_contract()<br/>validForReporting · fractions · GoF · warnings"]
  CJ --> CON
  CON --> OUT["modeling.resultsByKey<br/>render_fit_results_table()"]
```

## 5. Pipeline state, masks, and invalidation calls

```mermaid
flowchart LR
  T0["Any apply_*(row) entry point"] --> T1["pipeline_state.get_or_create_state(row)"]
  T1 --> T2{"Same rowId,<br/>channelKey, eventCount?"}
  T2 -- "no" --> T3["empty_state(row)<br/>replace filename-keyed Map entry"]
  T2 -- "yes" --> T4["reuse current state"]
  T3 --> T5["write filter N product"]
  T4 --> T5

  T5 --> T6{"QC filter 0–3?"}
  T6 -- "yes" --> T7["set_filter_mask(row, N, mask or null)"]
  T7 --> T8["recompute_final_mask()<br/>AND every non-null mask"]
  T6 -- "no" --> T9["retain current final mask"]
  T8 --> T10["invalidate_after(row, state, N)"]
  T9 --> T10

  T10 --> T11["clear downstream QC products"]
  T10 --> T12["invalidate_histogram_dependents()<br/>invalidate_model_results()"]
  T12 --> T8
  T12 --> T14["render_density_plot()"]

  C0["Different row.data.channel_key"] --> C1["enter_plotting_mode()<br/>clear completion badges"]
  C1 --> C2["render.active_pipeline_state()<br/>reject mismatched old state"]
  C2 --> T1

  T14 --> V0["histogram replaces display bins"]
  T14 --> V1["get_active_model_result() overlays component curves"]
  T14 --> V2["render_fit_results_table() populates the report table"]
```

## 6. Statistics, sessions, reconnect, and layout calls

```mermaid
flowchart TD
  subgraph stats["Statistics"]
    ST0["#calculate_stats_button"] --> ST1["stats.open_stats_modal()"]
    ST2["#stats_calculate_button"] --> ST3["run_stats_calculation()"]
    ST3 --> ST4["load_analysis_row(channel, activate: false)"]
    ST4 --> ST5["compute_column_stats()<br/>finite nonnegative values only"]
    ST5 --> ST6["frame.setCol('CHANNEL:metric')"]
    ST6 --> ST7["render_file_table()<br/>dispatch pf-stats-complete"]
    ST7 --> ST8["record_stats()"]
    PF["pf-files-loaded"] --> ST9["rebuild_session_from_frame()"]
    ST9 --> ST10["compute_stats_for_new_files()"]
    ST10 --> ST4
  end

  subgraph session["Session"]
    SS0["#save_session_button"] --> SS1["handle_save()"]
    SS1 --> SS2["collect_session()<br/>table + metadata + stats plan<br/>file records + plot + layout"]
    SS2 --> SS3["serialize_session()<br/>write_session_file()"]
    SS2 -. "not serialized" .-> SS4["QC masks + model results"]

    SL0["#load_session_button"] --> SL1["handle_load()"]
    SL1 --> SL2["read_session_file()<br/>parse_session_toml()"]
    SL2 --> SL3["apply_session()<br/>apply_plot_settings()<br/>restore_stats_plan()"]
    SL3 --> SL4["restore_session_files()"]
    PF --> SL5["apply pending table session<br/>until all rows link"]
  end

  subgraph reconnect["Restore / reconnect"]
    SL4 --> RC0["try_load_from_opfs()"]
    SL4 --> RC1["optional fetch_files_from_url()"]
    SL4 --> RC2{"Files still missing?"}
    RC2 -- "yes" --> RC3["open_reconnect_modal()"]
    RC3 --> RC4["reconnect_from_directory()<br/>or reconnect_from_files()"]
    RC4 --> RC5["copy_file_to_opfs()<br/>load_files()"]
    RC3 --> RC6["finish_reconnect()<br/>continue without missing"]
  end

  subgraph layout["Layout"]
    L0["#sidebar_toggle"] --> L1["table_support.toggle_sidebar()"]
    L2["panel toggle buttons"] --> L3["panels.toggle_*_panel()"]
    L4["resizer drag"] --> L5["panel_resize handlers"]
    L1 --> L6["dispatch resize"]
    L3 --> L6
    L5 --> L6
    L6 --> L7["axis_modal.schedule_plot_resize()<br/>render_density_plot()"]
    L8["#site_logo"] --> L9["hard_restart()<br/>location.reload()"]
  end
```

## 7. User decision tree — setup

```mermaid
flowchart TD
  U0["Open PhaseFinder"] --> U1{"Restore a session?"}
  U1 -- "yes" --> U2["Load TOML session"]
  U2 --> U3{"All FCS files restored?"}
  U3 -- "no" --> U4["Reconnect folder/files<br/>or continue without missing"]
  U3 -- "yes" --> U5["Files available"]
  U4 --> U5
  U1 -- "no" --> U6["Drop/select FCS files"]
  U6 --> U5

  U5 --> U7{"Configure metadata?"}
  U7 -- "filename wizard" --> U8["Split filenames / apply template"]
  U7 -- "manual column" --> U9["Add metadata column"]
  U7 -- "import" --> U10["Import CSV/TSV metadata"]
  U7 -- "edit/filter/sort/select" --> U11["Use metadata table"]
  U7 -- "no" --> U11
  U8 --> U11
  U9 --> U11
  U10 --> U11

  U11 --> U12{"DNA-area channel selected?"}
  U12 -- "no" --> U13["Select channel"]
  U13 --> U14{"Plot channel events?"}
  U12 -- "yes" --> U14
  U14 -- "yes" --> U15["Load raw aligned channels<br/>and render checked samples"]
  U14 -- "no" --> U11
```

## 8. User decision tree — analysis

```mermaid
flowchart TD
  A0["Channel plot visible"] --> A1{"Next action?"}

  A1 -- "adjust plot" --> A2["Color, bins, display mode,<br/>selection, or axis range"]
  A2 --> A1

  A1 -- "apply QC" --> A3["Check the wanted gates<br/>Structural · Time · Cell · Singlet"]
  A3 --> A4["Apply / Run All<br/>for every plottable sample"]
  A4 --> A5["Missing Time/FSC-SSC/pulse geometry<br/>skips optional gates"]
  A5 --> A11["Rebuild every histogram<br/>clear downstream results and redraw"]
  A11 --> A12{"Inspect the Cell Gate?"}
  A12 -- "yes" --> A13["Open the scatter/GMM modal"]
  A12 -- "no" --> A14
  A13 --> A14

  A1 -- "model the cell cycle" --> A14{"Peak regions accepted?"}
  A14 -- "no" --> A15["Identify Peaks: detect,<br/>then accept or drag the handles"]
  A15 --> A14
  A14 -- "yes" --> A16{"Model chosen?"}
  A16 -- "no" --> A17["Fit buttons stay disabled"]
  A17 --> A16
  A16 -- "yes" --> A18{"Per-sample or joint series?"}
  A18 -- "per sample" --> A19["Fit Current / Fit All Samples"]
  A18 -- "cloccs" --> A20["Fit All Samples<br/>map strain + timepoint columns"]
  A19 --> A9
  A20 --> A9
  A9["Fit overlays + report table"] --> A1

  A1 -- "calculate statistics" --> B0["Choose channel + metrics"]
  B0 --> B1["Add CHANNEL:metric columns"]
  B1 --> A1

  A1 -- "save session" --> C0["Save metadata, table, stats plan,<br/>file records, plot and layout"]
  C0 --> C1["QC masks and model results remain runtime-only"]

  A1 -- "adjust layout" --> D0["Collapse or resize panels/sidebar"]
  D0 --> A1
  A1 -- "restart" --> D1["Reload application"]
```

## Source inventory

Entry and shared state:

- `js/main.js` — ES-module entry, listener bootstrap, and
  `window.PhaseFinder = { app, pipeline, djf, plot }`.
- `js/state/app_state.js`, `js/state/files.js` — loaded-file/frame ownership and
  selection queries.
- `js/data_structs/metadata_frame.js`, `metadata_columns.js`, `table_state.js`,
  `channel_cache.js` — table model, metadata state, and per-channel DATA caches.

FCS and IO:

- `js/fcs/parser.js` — FCS HEADER/TEXT/DATA parsing;
  `js/fcs/metadata_processing.js` — metadata-only header reads;
  `js/fcs/data_worker.js` — selected-column module worker.
- `js/fcs/channel_cleaning.js` — A/H/W/scatter/Time discovery and construction
  of aligned raw arrays, PnR values, and parameter metadata.
- `js/io/metadata_io.js`, `js/io/channel_loading.js`, `js/io/parameter_map.js` —
  file/table IO and selected-channel loading.

Cell-cycle QC pipeline:

- `js/analysis/pipeline/pipeline_loader.js`, `pipeline_ui.js`, `pipeline_state.js`,
  `cell_cycle_pipeline.js`, and `js/analysis/gating/scatter_modal.js` — lazy
  loading, QC filter controls, state/masks, stage orchestration, and Cell Gate
  inspection.
- `qc/structural_qc.js`, `qc/acquisition_time_qc.js`,
  `gating/scatter_gmm_gate.js`, `gating/pulse_geometry_gate.js`, and
  `pipeline/dna_histogram.js` — the canonical Stage 0–4 checkpoints;
  `cell_cycle/peak_detection.js`, `cell_cycle/peak_regions.js`,
  `cell_cycle/model_registry.js`, `cell_cycle/models/*.js`,
  `cell_cycle/fit_client.js`/`fit_worker.js`, and
  `cell_cycle/result_contract.js` — detection, model registration, off-thread
  fitting, and the reportability gate.
- `math/{stats,gaussian,gaussian_bin_mass,poisson,linalg2d,lm_solver,nelder_mead,integrate,quadrature}.js`
  — shared numerical implementation.

Rendering, analysis, and persistence:

- `js/plotting/data.js`, `render.js`, `modeling.js`, `axis_modal.js` — D3 plot
  state/rendering, staged fit/report presentation, and axis/inspection API.
- `js/analysis/pipeline/start.js`, `stats.js` — channel/plot workflow and summary stats.
- `js/session/core.js`, `table_session.js`, `file_cache.js`, `reconnect.js`,
  `opfs_fs.js`, `copy_worker.js`, `toml_io.js` — session serialization, OPFS
  caching, and reconnect orchestration.
