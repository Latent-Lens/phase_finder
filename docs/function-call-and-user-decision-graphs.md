# PhaseFinder Function Calls And User Decisions

These graphs map user-facing controls to concrete module functions in the
current staged-pipeline application. They intentionally separate setup,
channel/plot loading, DJF orchestration, numerical stages, state invalidation,
and session/statistics flows so function names remain readable.

Important distinctions reflected below:

- The UI **Run all** path loops through `pipeline_ui.run_manual_stage()`; it does
  not call the programmatic `index.run_all(row)` helper.
- Stage 1–3 skip paths store null optional masks, preserving upstream masks.
- Stage 5 peak detection is diagnostic. Stage 6 consumes the Stage 4 histogram
  directly and can continue after `found: false`.
- Every stage rerun invalidates downstream products before the plot redraws.
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
  C3 --> C4["enter_plotting_mode()<br/>clear stage badges<br/>disable Run DJF shortcut"]
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

## 3. Manual DJF pipeline UI calls

```mermaid
flowchart TD
  M0["#djf_stage0 … #djf_stage8"] --> M1["pipeline_ui.run_manual_stage(stage, button)"]
  A0["#djf_run_all"] --> A1["pipeline_ui.run_manual_all()"]
  A2["Sidebar Run DJF Pipeline"] --> A3["click #djf_run_all"]
  A3 --> A1

  M1 --> Q0{"Any plottable rows?"}
  Q0 -- "no" --> Q1["readout + error status"]
  Q0 -- "yes" --> L0["pipeline_loader.load_pipeline()"]
  L0 --> L1["dynamic import djf/index.js"]
  L1 --> M2["disable controls + show progress"]
  M2 --> M3["Stage 4 only:<br/>shared_histogram_range(rows)"]
  M2 --> M4["for each row:<br/>pipeline.run_stage(stage, row, options)"]
  M3 --> M4
  M4 --> M5["format_stage_result()"]
  M5 --> M6["render_density_plot()"]
  M6 --> M7{"Direct Stage 2<br/>and not skipped?"}
  M7 -- "yes" --> M8["scatter_modal.open_scatter_modal()"]
  M7 -- "no" --> M9["update readout/status"]
  M8 --> M9
  M9 --> M10["mark complete<br/>re-enable controls"]

  A1 --> A4["lock all controls"]
  A4 --> A5["for stage 0 through 8"]
  A5 --> A6["run_manual_stage()<br/>managedByRunAll: true<br/>openScatter: false"]
  A6 --> A7{"Stage returned outputs?"}
  A7 -- "yes" --> A8{"Stage 8 finished?"}
  A8 -- "no" --> A5
  A8 -- "yes" --> A9["All nine stages complete"]
  A7 -- "no / caught error" --> A10["stop loop"]
  A9 --> A11["unlock controls"]
  A10 --> A11

  D0["Programmatic API"] --> D1["pipeline.run_stage_all()<br/>pipeline.run_all(row)"]
```

## 4. Stage-by-stage numerical calls

```mermaid
flowchart TD
  S0["index.run_stage0()"] --> S0A["stage0.runStructuralQC()<br/>createStructuralValidityMask()"]
  S0A --> S0B["set_stage_mask(0, structuralMask)"]

  S0B --> S1Q{"Time channel present?"}
  S1Q -- "no" --> S1S["Stage 1 skipped<br/>timeQC mask = null"]
  S1Q -- "yes" --> S1A["stage1.runTimeQC()<br/>prepareTimeQCBins()<br/>summarize + robust-score bins<br/>createTimeQCMask()"]
  S1S --> S2Q
  S1A --> S2Q

  S2Q{"FSC-A and SSC-A present?"}
  S2Q -- "no" --> S2S["Stage 2 skipped<br/>scatter mask = null"]
  S2Q -- "yes" --> S2A["stage2.gateMainBiologicalCloud()<br/>buildScatterPoints() → fitGMM2D()<br/>chooseMainBiologicalComponent()<br/>createScatterGateMask()"]
  S2S --> S3Q
  S2A --> S3Q

  S3Q{"DNA-H or DNA-W<br/>and enough usable events?"}
  S3Q -- "no" --> S3S["Stage 3 skipped<br/>singlet mask = null"]
  S3Q -- "yes" --> S3A["stage3.gateByPulseGeometry()<br/>select/build geometry points<br/>fitRobustRidge2D()<br/>createSingletMaskFromRidge()"]
  S3S --> S4
  S3A --> S4

  S4["index.run_stage4()<br/>recompute_final_mask()<br/>stage4.generateHistogram()"] --> S5
  S5["index.run_stage5()<br/>detectDNAContentPeaks()<br/>smooth + prominence + ratio score"] --> S5Q{"Valid pair found?"}
  S5Q -- "no" --> S5N["store found:false<br/>Run all may continue"]
  S5Q -- "yes" --> S5Y["store peak diagnostics"]
  S5N --> S6
  S5Y --> S6

  S6["index.run_stage6()<br/>fitCellCycleHistogram()<br/>initializeParameters()<br/>runLevenbergMarquardt()"] --> S7
  S7["index.run_stage7()<br/>extendCellCycleFit()<br/>inspectResidualStructure()"] --> S7Q{"Contamination signal?"}
  S7Q -- "none / weak improvement" --> S7B["chooseModel(): base"]
  S7Q -- "detected" --> S7E["fitCandidateModel()<br/>debris / aggregate / both<br/>compare SSE + BIC + targeted residuals"]
  S7B --> S8
  S7E --> S8
  S8["index.run_stage8()<br/>summarizeCellCycleFit()<br/>integrate components<br/>fractions + contamination + GoF<br/>residual checks + warnings<br/>createDisplaySummary()"]
```

## 5. Pipeline state, masks, and invalidation calls

```mermaid
flowchart LR
  T0["Any run_stageN(row)"] --> T1["pipeline_state.get_or_create_state(row)"]
  T1 --> T2{"Same rowId,<br/>channelKey, eventCount?"}
  T2 -- "no" --> T3["empty_state(row)<br/>replace filename-keyed Map entry"]
  T2 -- "yes" --> T4["reuse current state"]
  T3 --> T5["write Stage N product"]
  T4 --> T5

  T5 --> T6{"Stage 0–3?"}
  T6 -- "yes" --> T7["set_stage_mask(row, N, mask or null)"]
  T7 --> T8["recompute_final_mask()<br/>AND every non-null mask"]
  T6 -- "no" --> T9["retain current final mask"]
  T8 --> T10["invalidate_after(row, state, N)"]
  T9 --> T10

  T10 --> T11["clear state products N+1 … 8"]
  T10 --> T12["clear downstream masks when applicable"]
  T12 --> T8
  T10 --> T13["state.lastStageRun = N"]
  T13 --> T14["render_density_plot()"]

  C0["Different row.data.channel_key"] --> C1["enter_plotting_mode()<br/>clear completion badges"]
  C1 --> C2["render.active_pipeline_state()<br/>reject mismatched old state"]
  C2 --> T1

  T14 --> V0["Stage 4 histogram replaces display bins"]
  T14 --> V1["Stage 6/7 overlays stored curves"]
  T14 --> V2["Stage 8 populates report table"]
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
    SS2 -. "not serialized" .-> SS4["DJF pipeline state/results"]

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

  A1 -- "run DJF" --> A3{"Run all or one stage?"}
  A3 -- "run all" --> A4["Stages 0 → 8<br/>for every plottable sample"]
  A4 --> A5["Missing Time/FSC-SSC/pulse geometry<br/>skips optional gates"]
  A5 --> A9["Fit overlays + report table"]

  A3 -- "one stage" --> A6["Choose Stage 0–8"]
  A6 --> A7{"Required upstream product exists?"}
  A7 -- "no" --> A8["Readout/status error"]
  A7 -- "yes" --> A10["Run exactly that stage<br/>for all plottable samples"]
  A10 --> A11["Clear downstream results and redraw"]
  A11 --> A12{"Direct successful Stage 2?"}
  A12 -- "yes" --> A13["Inspect scatter/GMM modal"]
  A12 -- "no" --> A9
  A13 --> A9
  A8 --> A3

  A1 -- "calculate statistics" --> B0["Choose channel + metrics"]
  B0 --> B1["Add CHANNEL:metric columns"]
  B1 --> A1

  A1 -- "save session" --> C0["Save metadata, table, stats plan,<br/>file records, plot and layout"]
  C0 --> C1["DJF results remain runtime-only"]

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

Staged DJF pipeline:

- `js/analysis/djf/pipeline_loader.js`, `pipeline_ui.js`, `pipeline_state.js`,
  `index.js`, `scatter_modal.js` — lazy loading, manual controls, state/masks,
  orchestration, and Stage 2 inspection.
- `stage0_structural.js` through `stage8_report.js` — the nine checkpoints;
  `stage_background.js` — explicit unspecified-background stub.
- `djf_components.js` and `math/{stats,gaussian,linalg2d,lm_solver,integrate}.js`
  — shared numerical implementation.

Rendering, analysis, and persistence:

- `js/plotting/data.js`, `render.js`, `modeling.js`, `axis_modal.js` — D3 plot
  state/rendering, staged fit/report presentation, and axis/inspection API.
- `js/analysis/start.js`, `stats.js` — channel/plot workflow and summary stats.
- `js/session/core.js`, `table_session.js`, `file_cache.js`, `reconnect.js`,
  `opfs_fs.js`, `copy_worker.js`, `toml_io.js` — session serialization, OPFS
  caching, and reconnect orchestration.
