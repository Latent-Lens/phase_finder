# PhaseFinder — Architectural Onboarding Map (current snapshot, post-reorg)

Scope of this map: every file under `js/` (31 files) plus `index.html`'s script/library wiring. All claims below are grounded in the files actually opened (full list at the end). CSS and the `docs/*` files were not inspected in depth and are not relied on for any claim here.

---

## 1. Entry points & load order

`index.html` loads two external libraries in `<head>` and then 31 app scripts as plain `<script src>` tags at the bottom of `<body>`, in this exact order:

```
<head> (blocking):
  d3@7 (CDN, blocking classic script)                         -> window.d3
  <script type="module"> dynamic-imports ml-levenberg-marquardt -> window.levenbergMarquardt (async, best-effort)
                          and ml-gsd                            -> window.gsd (async, best-effort)

<body> tail (classic scripts, executed in this order):
 1. js/fcs/parser.js
 2. js/fcs/metadata_processing.js
 3. js/ui/hover_text.js
 4. js/data_structs/metadata_frame.js
 5. js/data_structs/table_state.js
 6. js/data_structs/metadata_columns.js
 7. js/data_structs/channel_cache.js
 8. js/ui/status_channels.js
 9. js/io/metadata_io.js
10. js/ui/metadata_wizard.js
11. js/ui/table_support.js
12. js/ui/table_render.js
13. js/main.js
14. js/analysis/djf.js
15. js/plotting/data.js
16. js/plotting/modeling.js
17. js/plotting/render.js
18. js/plotting/axis_modal.js
19. js/ui/panels.js
20. js/io/cache.js
21. js/fcs/channel_cleaning.js
22. js/io/channel_loading.js
23. js/analysis/start.js
24. js/analysis/stats.js
25. js/ui/panel_resize.js
26. js/session/store.js
27. js/session/toml_io.js
28. js/session/opfs.js
29. js/session/reconnect.js
30. js/session/core.js
```

There are no ES-module scripts among the app code (only the two dynamic-import shims in `<head>` are modules) — everything else is classic `<script>`, so all top-level `const`/`let`/`function` declarations share one global (script) scope. This is why ordering matters at all: **most cross-file references are safe regardless of order because they only resolve inside function bodies invoked later, after every script has finished loading.** The only *real* ordering constraints are places where a script executes code immediately at parse time (top-level statements, not inside a function) that reads a name defined in another file. These are the genuine parse-time dependencies found:

| Constraint | Why |
|---|---|
| `js/ui/hover_text.js` before `js/main.js` | `main.js` line 127 calls `window.PhaseFinderTooltips.apply_static()` immediately (not inside a handler) — `PhaseFinderTooltips` must already exist. |
| `js/ui/status_channels.js` and `js/ui/table_render.js` before `js/main.js` | `main.js`'s trailing lines (363–367) call `clear_channel_controls()`, `render_file_table()`, `update_drop_zone_text()`, `set_status(...)`, `set_status_bar(...)` immediately at load time, not from an event handler. All five are defined in those two earlier files. |
| `js/plotting/render.js` before `js/plotting/axis_modal.js` | `axis_modal.js` lines 96–107 immediately does `el.addEventListener("change", render_density_plot)` for several plot controls — the *value* of `render_density_plot` (defined in `render.js`) is captured at that statement's execution time. |
| `js/ui/panels.js` before `js/analysis/start.js` | `start.js` lines 213–216 immediately calls `metadata_panel_toggle.addEventListener(...)`, `analysis_start_button.addEventListener("click", start_analysis)`, etc. Those DOM-reference consts (`analysis_start_button`, `metadata_panel_toggle`, `cell_cycle_modeling_button`, …) are declared in `panels.js`. |
| `d3` (head) before any `js/plotting/*` file | `render.js` reads `window.d3` synchronously the first time `render_density_plot()` runs; since d3 is a blocking classic script in `<head>`, it is guaranteed ready before body scripts even parse. |

Everything else — e.g. `io/metadata_io.js`'s `load_files()` calling `sync_file_annotations()` (defined in `data_structs/table_state.js`) or `analysis/djf.js` reading `window.levenbergMarquardt`/`window.gsd` (populated asynchronously by the `<head>` dynamic imports, not guaranteed ready even after all scripts parse) — is safe only because those references live inside function bodies that first run in response to user interaction, well after the whole script list has executed. The Levenberg-Marquardt/gsd libraries are a soft dependency: if the dynamic import hasn't resolved yet when a fit is attempted, `js/analysis/djf.js`'s `fit()` (line 462-463) and `detect_peaks()` (line 90) simply check `typeof window.gsd === "function"` / `!LM` and fall back to a local peak scan or return `null` — this is a documented, intentional soft-load design (see the inline comment in `index.html` lines 10-12).

The broad grouping logic behind the order is: **parsers/low-level data → shared data structures/state → status & DOM-utility helpers → IO/import-export → wizard & table UI → main bootstrap (defines `window.PhaseFinderApp` and wires top-level events) → analysis math (DJF) → plotting state/rendering/modal → panel-collapse shell → channel-loading IO → analysis orchestration & stats → panel-resize → session (OPFS store → TOML → OPFS cache/registry → reconnect → session core, which wires Save/Load/Reset and starts autoload)**.

---

## 2. Per-file inventory

### `js/main.js`
Central browser bootstrap. Captures DOM references for upload/table/progress/sidebar controls, owns `file_map` (Map of non-tabular loaded-file entries) and `file_table_frame` (the tabular `PhaseFinderFrame`), defines `update_annotation`, `escape_html`, wires drag/drop + file-input + channel-select + table + metadata-wizard + hard-restart listeners, and exposes `window.PhaseFinderApp` (the cross-module API surface: file/channel getters, status/progress helpers, and the session save/restore API: `get_session_table_state`, `apply_session_state`, `save_metadata_template`).

### `js/fcs/` — FCS parsing and per-file cleanup
- **`parser.js`** — Low-level FCS binary parser (`globalThis.FCSParser`): fixed-HEADER reader, TEXT-segment key/value parser, byte-order/data-type handling, full-row parser (`parse_fcs`), header-only summary parser (`parse_fcs_header`, `parse_fcs_header_from_segments`), and the selected-column-only reader `parse_selected_columns` used to avoid loading unused channels.
- **`metadata_processing.js`** — `read_fcs_header(file)`: reads only a file's HEADER+TEXT bytes (not DATA) to build a loaded-file entry `{id, name, file, summary}` via `window.FCSParser`.
- **`channel_cleaning.js`** — Normalizes FCS parameter names (`normalize_measurement_name`, `measurement_kind`, `measurement_base`) so area/height/width companion channels (e.g. `DAPI-A`/`DAPI-H`) can be matched across naming conventions; `find_auxiliary_indexes_for_file` finds a file's H/W companions for a chosen area channel; `filter_selected_channel_values` filters loaded columns to finite-positive DNA-area events and applies the same keep-mask to H/W arrays.
- **`data_worker.js`** — Web Worker body. `importScripts("./parser.js")`, listens for `{request_id, file, summary, selected_indexes}`, slices the DATA segment, calls `FCSParser.parse_selected_columns`, converts to `Float64Array`, and transfers the buffers back.

### `js/data_structs/` — shared tabular/cache primitives
- **`metadata_frame.js`** — `class PhaseFinderFrame` (column-oriented store: `_data`, `_cols`, `.col()`, `.setCol()`, `.length`, `.columns`), plus `make_frame(rows)`, `concat_frames(frame1, frame2)` (null-fills missing columns), and `build_metadata_frame_from_records(records, columns, loaded_rows, options)` which matches imported/session rows back to loaded FCS files by normalized filename.
- **`table_state.js`** — Owns cross-render-persistent globals: `TABLE_COLUMNS`, `selected_file_ids` (Set), `column_filters` (Object of Sets), `sort_state`, `open_filter_field`, `pending_header_focus_field`. Provides `metadata_row_is_linked`, `loaded_file_count`, `metadata_unlinked_row_id`, `table_base_field_set`, `table_stat_columns`, `set_metadata_table_columns`, and `sync_file_annotations` (writes frame values back onto `file_map` entries' `.annotations`).
- **`metadata_columns.js`** — Column-naming utilities: `metadata_field_from_label` (label→stable field name, with known aliases e.g. "nocodazole"→`nocodazoleArrest`), `unique_metadata_label`, `normalize_metadata_columns`, `current_metadata_columns`, `rebuild_table_with_metadata_columns`, `add_manual_metadata_column` (the blank-column toolbar action).
- **`channel_cache.js`** — Per-row, per-channel event-array cache: `analysis_data_key`, `cached_analysis_data`, `store_analysis_data` (writes into `row.analysis_data_by_channel` Map and optionally activates `row.data`), `is_analysis_data_loaded`, `activate_analysis_data`.

### `js/io/` — FCS DATA loading and metadata table import/export
- **`cache.js`** — `parameter_map(summary)` (builds `{index, label, name, desc}` per FCS parameter), `find_param_index`, `unique_indexes`. (Despite the filename, this is not the event-data cache — that's `data_structs/channel_cache.js`.)
- **`channel_loading.js`** — Orchestrates selected-channel DATA loading: creates/reuses the shared `fcs_data_worker`, falls back to main-thread parsing on worker failure, `load_analysis_row` (loads+cleans+caches one row for one channel), `load_analysis_batch`/`load_analysis_data` (batched with progress UI), `refresh_analysis_after_metadata_change` and `preload_analysis_rows_in_background` (used when new files arrive after a plot already exists).
- **`metadata_io.js`** — `load_files(files)` — the core file-drop/select handler: reads each file's header via `read_fcs_header`, rejects duplicates, extends `file_table_frame` (via `make_frame`/`concat_frames`), auto-applies the saved filename-metadata template, dispatches `pf-files-loaded`, registers files for OPFS caching, sorts/re-renders, and triggers downstream plot refresh/preload. Also owns delimited-metadata import (`parse_delimited_metadata`, `import_metadata_records`, `handle_metadata_import_file`) and TSV export (`metadata_table_tsv`, `save_blob`, `handle_metadata_table_export`).

### `js/ui/` — DOM/table/tooltip/panel plumbing
- **`hover_text.js`** — `window.PhaseFinderHoverText` (frozen tooltip-text registry) and `window.PhaseFinderTooltips` (`text`, `set_quick_tooltip`, `set_native_title`, `apply_static`); a self-executing IIFE builds one shared positioned tooltip element and wires mouse/focus/scroll listeners.
- **`status_channels.js`** — `create_id`, `set_status`/`set_status_bar`, `update_loaded_files_list`, `update_drop_zone_text`, `show_progress`/`update_progress`/`hide_progress`/`next_frame` (the progress-overlay + rAF-yield helpers used throughout loading code), `clear_channel_controls`, `unique_columns`/`unique_column_values`, `populate_single_select`/`suggest_column`/`populate_channel_controls` (DNA-area channel auto-suggestion), `frame_to_rows`, `update_start_button_state` (enables/disables the plot/stats/metadata toolbar buttons).
- **`metadata_wizard.js`** — Filename→metadata-column wizard: delimiter/fixed-width/regex split steps, live preview table, localStorage-persisted template (`METADATA_TEMPLATE_STORAGE_KEY`), `apply_filename_metadata_columns`, `apply_current_filename_metadata_template` (auto-apply on later file loads when the template still matches), `schedule_metadata_wizard_after_file_load` (auto-opens 750ms after first file load if no columns exist yet).
- **`table_support.js`** — `notify_selection_changed` (dispatches `fcs-selection-change`), sidebar collapse (`set_sidebar_collapsed`, `toggle_sidebar`), `displayed_files` (filter+sort pipeline over `file_table_frame`), header-control builders (`sort_indicator`, `filter_control`, `header_label_control`, `header_cell`, `header_label_cell`, `header_filter_cell`), `display_name`, `annotation_input_size`, `update_views`, `guess_annotations_from_filename` (regex-based strain/replicate/arrest/timepoint guesser), `timepoint_sort_value`, `sort_file_table`.
- **`table_render.js`** — `link_existing_metadata_row_to_loaded_entry` (links an unlinked imported/session row to a newly loaded file by filename match), `render_file_table` (builds the full `<table>` markup, including the two-row grouped stats header), `update_select_all_checkbox`, `handle_metadata_header_input`/`finalize_metadata_header_input` (editable column headers), `handle_table_change`/`handle_table_click`/`handle_document_click` (delegated event handlers for filters, sort, row/select-all checkboxes).
- **`panels.js`** — Declares the DOM refs for analysis/modeling buttons and the plot/metadata panel shells (`analysis_start_button`, `cell_cycle_modeling_button`, `plot_panel`, `metadata_panel`, etc.), and `set_metadata_panel_collapsed`/`toggle_metadata_panel`, `set_plot_panel_collapsed`/`toggle_plot_panel`.
- **`panel_resize.js`** — Self-contained IIFE for drag-resizing the sidebar (horizontal) and the plot/metadata panel split (vertical), with `MutationObserver`-driven resizer enable/disable and `resize` event dispatch after drags.

### `js/analysis/` — cell-cycle math and user-facing orchestration
- **`djf.js`** — `window.PhaseFinderDJF` (IIFE). Numeric core: histogram building, peak detection (`window.gsd` if available, else local-maxima scan), G1/G2 pairing, debris-bounds estimation, aggregate/doublet ratio-masking, the DJF `model`/`components` function (Gaussian G1/G2 + trapezoidal S-phase), `seed_fit`, `fit` (wraps `window.levenbergMarquardt`), `phase_stats`/`fractions`, `correction_summary`, and `find_auxiliary_indexes` (a DJF-local duplicate of the H/W-companion-finding logic also present in `fcs/channel_cleaning.js`, using slightly different string tokens — see the ambiguity note in §3).
- **`start.js`** — User-facing orchestration: `set_plot_action_controls_disabled`, `enter_plotting_mode`/`enter_modeling_mode` (swap the Plot button between "Plot Channel Events" and "Start Modeling (DJF)"), `prepare_selected_channel_for_plotting` (channel-change handler), `start_analysis` (the Plot/Start-Modeling button click handler), and the listener wiring for `fcs-selection-change`/`fcs-channel-change`/cell-cycle-modeling-button clicks.
- **`stats.js`** — IIFE for the "Calculate Statistics" modal: tracks a `stats_session` Map (channel→metric Set) so newly loaded files auto-get the same stats, `compute_column_stats` (mean/stddev/median/min/max over a typed array), modal open/close and checkbox-state logic, the calculate-button handler (loads data, computes stats, writes `"CHANNEL:metric"` columns into `file_table_frame`), and `window.PhaseFinderSummaryStats` (used by session restore and file-load refresh).

### `js/plotting/` — D3 rendering pipeline
- **`data.js`** — Shared plot DOM refs, layout/color constants, and plot state (`plot_channels`, `last_range`, `last_series`, `series_by_name`, `histograms_by_name`, `axis_range_override`, `peak_threshold`, `modeling_started`, `shown_fits`). Pure-ish helpers: `plot_bin_count`, `plot_display_mode`, `correction_state`, `plottable_rows` (checked+loaded rows via `window.PhaseFinderApp`), `build_color_assigner`, `shared_range`/`shared_range_for_values`, `axis_opts`, `histogram_curve`, `build_histogram_summary`.
- **`modeling.js`** — `update_plot_title`, `render_fit_results_table` (the per-sample DJF phase-stats table overlay), `reset_modeling_state`, `init_plot` (stores selected channel, triggers first render), `start_modeling` (shows the first plottable sample's fit), `toggle_fit` (legend-checkbox handler).
- **`render.js`** — `render_density_plot()`, the single large D3 render pass: gathers plottable rows, applies `PhaseFinderDJF.prepare_row` (debris/doublet corrections), builds per-sample histograms, computes shared axis domains (respecting `axis_range_override`), draws curves/bins/legend/axis-hit-areas, and — when modeling is active — fits each shown sample via `PhaseFinderDJF.fit`, draws filled G1/S/G2 components + total curve, the draggable peak-threshold line, and the fit-results table.
- **`axis_modal.js`** — `open_axis_range_modal`/`close_axis_range_modal`/`apply_axis_range_modal` (the manual X/Y range modal, draggable via mousedown/mousemove), wires plot-control `change` listeners to `render_density_plot`, wires window `resize`/`ResizeObserver` to redraw, and exposes `window.PhaseFinderPlot` (`series`, `get_series`, `series_names`, `get_histogram`, `histogram_names`) for other modules/tests to introspect the current/cached plot state.

### `js/session/` — OPFS-backed session persistence
- **`store.js`** — `window.PhaseFinderOPFS`: `supports_opfs`, `get_opfs_root`, `ensure_directory`, `split_opfs_path`, `read_file_from_opfs`, `delete_opfs_path`, `request_persistent_storage`, `get_storage_estimate`. Low-level OPFS wrapper only; no session-specific logic.
- **`toml_io.js`** — `serialize_session(s)` / `parse_session_toml(text)` — a hand-rolled TOML subset (sections, `[[array-of-table]]`, inline tables, string/number/bool/array values) covering files, metadata columns/rows, table filters/sort, plot settings, UI layout, filename template, and stats plan.
- **`opfs.js`** — Higher-level file-caching orchestration (despite the name overlap with `store.js`'s OPFS wrapper): IndexedDB-backed directory-handle cache (`idb_get`/`idb_put`) for the Chromium native picker path, `pick_dir_chromium`/`pick_dir_fallback` (webkitdirectory input for Firefox/Safari), `fetch_files_from_url` (dev-mode HTTP autoload), `auto_load_session_files`, the `file_records` Map + `make_file_record`/`set_records_from_session`/`build_file_records_for`, the OPFS copy-worker driver (`get_opfs_copy_worker`, `copy_file_to_opfs`), a background cache queue (`enqueue_opfs_cache`/`run_cache_queue`), and `register_loaded_files` (called by `main.js`'s `load_files` via `window.PhaseFinderSessionFiles`).
- **`copy_worker.js`** — Worker body for background OPFS writes; inlines its own tiny `ensure_directory`/`split_opfs_path` (cannot use `window.PhaseFinderOPFS` inside a worker), `write_file_to_opfs` via `createWritable()`.
- **`reconnect.js`** — `try_load_from_opfs` (reads cached copies back as Files, buckets found/missing/mismatch), filename+size+lastModified matching (`index_selected_files`, `match_record_to_selected_file`, `is_acceptable_match`), the reconnect-modal rendering/open/close, and `apply_reconnected_files`/`reconnect_from_directory`/`reconnect_from_files`.
- **`core.js`** — Top-level session orchestration: `restore_session_files` (tries OPFS cache, then dev HTTP fetch, then opens the reconnect modal for anything still missing), `collect_session`/`apply_session` (state ↔ plain-object session translation covering plot/table/UI/stats-plan), `apply_table_session`, TOML file I/O (`write_session_file`/`read_session_file` via File System Access API with download/prompt fallbacks), the Save/Load/Reset button handlers, reconnect-modal button wiring, `window.PhaseFinderSessionFiles`/`window.PhaseFinderReconnect` public APIs, and `try_autoload` (fetches an optional untracked `phasefinder_local.json` to auto-load a session on startup, deferred via `setTimeout(..., 0)`).

---

## 3. Globals & cross-file contracts

Since none of this is ES modules, "exports" are just assignments to `window.*` or bare top-level `const`/`function` declarations shared across all classic scripts. Key namespaces:

| Global | Defined in | Consumed by |
|---|---|---|
| `window.FCSParser` | `fcs/parser.js` | `fcs/metadata_processing.js`, `fcs/data_worker.js` (via `importScripts`, independent of HTML order), `io/channel_loading.js` |
| `window.PhaseFinderHoverText` / `window.PhaseFinderTooltips` | `ui/hover_text.js` | `main.js` (immediate call), `ui/table_support.js`, `ui/table_render.js`, `ui/panels.js`, `analysis/start.js` |
| `window.PhaseFinderApp` | `main.js` (assigned near end of file) | `io/channel_loading.js`, `io/metadata_io.js`, `analysis/start.js`, `analysis/stats.js`, `plotting/data.js`, `session/*` — universally, as the sanctioned cross-module accessor for `file_map`/`file_table_frame`/status/progress |
| `window.PhaseFinderDJF` | `analysis/djf.js` | `plotting/render.js` |
| `window.PhaseFinderPlot` | `plotting/axis_modal.js` | external test harnesses (not seen used by other app files) |
| `window.PhaseFinderSummaryStats` | `analysis/stats.js` | `io/metadata_io.js` (`clear_stats_plan`), `session/core.js` (`get_stats_plan`/`restore_stats_plan`) |
| `window.PhaseFinderOPFS` | `session/store.js` | `session/opfs.js`, `session/reconnect.js`, `session/core.js` |
| `window.PhaseFinderSessionFiles` | `session/core.js` (assigned) | `io/metadata_io.js`'s `load_files` (`register_loaded_files`) |
| `window.PhaseFinderReconnect` | `session/core.js` | not consumed elsewhere in `js/` — appears to be a test/automation hook |
| `window.d3` | CDN script in `<head>` | `plotting/render.js`, `plotting/axis_modal.js` |
| `window.levenbergMarquardt`, `window.gsd` | dynamic `import()` shims in `<head>` (async, not guaranteed ready even after all scripts parse) | `analysis/djf.js` only, with `typeof`/truthiness guards at every call site |

Bare top-level (non-namespaced) globals shared via the classic-script scope, with their defining file and the layer(s) that depend on them:

- `file_map`, `file_table_frame` — `main.js` — read/written almost everywhere (`data_structs/*`, `io/*`, `ui/*`, `analysis/*`, `plotting/data.js`, `session/core.js`).
- `TABLE_COLUMNS`, `selected_file_ids`, `column_filters`, `sort_state`, `open_filter_field` — `data_structs/table_state.js` — consumed by `ui/table_support.js`, `ui/table_render.js`, `data_structs/metadata_columns.js`, `io/metadata_io.js`.
- `PhaseFinderFrame` (class), `make_frame`, `concat_frames`, `build_metadata_frame_from_records` — `data_structs/metadata_frame.js` — consumed by `main.js`, `io/metadata_io.js`, `ui/metadata_wizard.js`, `ui/table_support.js`.
- `plot_channels`, `modeling_started`, `shown_fits`, `peak_threshold`, `last_series`, `series_by_name`, `histograms_by_name`, `axis_range_override` — `plotting/data.js` — consumed by `plotting/modeling.js`, `plotting/render.js`, `plotting/axis_modal.js`, and read by `io/channel_loading.js` (`plot_channels`, `init_plot`) and `analysis/start.js`.
- `analysis_start_button`, `cell_cycle_modeling_button`, `plot_panel`, `metadata_panel`, etc. — `ui/panels.js` — consumed immediately by `analysis/start.js`'s top-level listener wiring (a hard load-order requirement, see §1).
- `ANALYSIS_FILE_CONCURRENCY`, `load_analysis_row`, `load_analysis_batch`, `load_analysis_data`, `refresh_analysis_after_metadata_change`, `preload_analysis_rows_in_background` — `io/channel_loading.js` — consumed by `analysis/start.js`, `analysis/stats.js`, `io/metadata_io.js`.
- `file_records`, `OPFS()`, `is_test_mode`, `esc`, `human_size`, `is_resolved`, `copy_file_to_opfs`, `idb_get`/`idb_put`, `pick_dir_fallback` — `session/opfs.js` — consumed by `session/reconnect.js` and `session/core.js`.

**Ambiguity worth flagging:** `js/session/reconnect.js` line 154 calls `getFileHandleByRelativePath(dir_handle, record.relative_path)`, but this function is not defined anywhere under `js/` (confirmed via repo-wide grep). It is wrapped in a `try { … } catch { … }` that falls back to `dir_handle.getFileHandle(record.original_name)`, so the failure mode is silently absorbed at runtime (a `ReferenceError` is caught, and the code falls through to the simpler by-name lookup) — but this is a genuine dangling reference in the reorganized code, not something inferred as intentional.

Also worth flagging as a duplicated-logic seam rather than a true bug: **`fcs/channel_cleaning.js`** (`normalize_measurement_name`/`measurement_kind`/`measurement_base`/`find_linked_measurement_param`/`find_auxiliary_indexes_for_file`) and **`analysis/djf.js`**'s internal `normalize_name`/`measurement_kind`/`measurement_base`/`find_linked_param`/`find_auxiliary_indexes` (lines 579–646) implement the same area/height/width-companion-matching idea twice, with slightly different normalization (hyphen-joined lowercase tokens vs. space-joined uppercase tokens). It was not verified whether their outputs are guaranteed identical for all inputs — worth noting as separate parallel implementations, not confirmed equivalent.

---

## 4. Event flow traces

### A. FCS file drop/select → parsing → table population

1. User drops files on `#drop_zone` or `#collapsed_upload_target`, or picks via `#file_input`. Handlers registered in `js/main.js:133,173-175` (`file_input.addEventListener("change", () => load_files(file_input.files))`; drop listener calls `load_files(event.dataTransfer.files)`).
2. `load_files(files)` in `js/io/metadata_io.js:36-172` is the orchestrator: shows the progress overlay (`show_progress`/`update_progress` from `js/ui/status_channels.js`), then for each file calls `read_fcs_header(file)`.
3. `read_fcs_header` in `js/fcs/metadata_processing.js:22-39` slices only the file's first 58 bytes + the TEXT segment, calls `window.FCSParser.parse_header` and `parse_fcs_header_from_segments` (`js/fcs/parser.js:59-80, 533-538`), and returns `{id: create_id(), name, file, summary}` — event DATA is *not* read at this stage.
4. Back in `load_files` (`metadata_io.js:69-84`): the entry is stored in `file_map`, linked to an existing unlinked metadata row if one matches by filename (`link_existing_metadata_row_to_loaded_entry`, `js/ui/table_render.js:10-28`), otherwise queued as a new tabular row.
5. After the loop, `metadata_io.js:93-105` builds a new frame via `make_frame`/`concat_frames` (`js/data_structs/metadata_frame.js`) and merges it into `file_table_frame`; if a filename-metadata template is compatible it's auto-applied (`apply_current_filename_metadata_template`, `js/ui/metadata_wizard.js:396-402`), else `sync_file_annotations()` (`js/data_structs/table_state.js:187-202`).
6. `metadata_io.js:106-114` dispatches `pf-files-loaded` (consumed by `js/analysis/stats.js:129-132` to auto-recompute tracked stats for new files) and calls `window.PhaseFinderSessionFiles.register_loaded_files(loaded_entries)` (`js/session/opfs.js:313-324`) to queue background OPFS caching.
7. `metadata_io.js:115-120` sorts the table (`sort_file_table`, `js/ui/table_support.js:398-410`) and calls `update_views()` (`js/ui/table_support.js:310-315`), which calls `render_file_table()` (`js/ui/table_render.js:45-177` — builds the `<table>` markup with checkboxes, editable annotation `<input>`s, and any grouped stats columns) and `populate_channel_controls()` (`js/ui/status_channels.js:348-358`, fills the DNA-area channel `<select>`).
8. If a plot already exists, `refresh_downstream_after_file_load` (`metadata_io.js:14-19`) calls `refresh_analysis_after_metadata_change` (`js/io/channel_loading.js:366-413`), which loads event data only for newly-added, currently-selected rows and calls `init_plot` (`js/plotting/modeling.js:143-146`) to redraw.

### B. "Cell Cycle Modeling" click → DJF fit → plot render

1. Precondition: a channel plot must already exist. Clicking "Plot Channel Events" / the collapsed plot icon invokes `start_analysis()` (`js/analysis/start.js:193-211`, wired at line 215-216), which calls `load_analysis_data()` (`js/io/channel_loading.js:316-350`) to load the checked rows' DNA-area (and optional H/W) channel data via the worker (`load_selected_fcs_columns_in_worker` → `js/fcs/data_worker.js`) or main-thread fallback, then `init_plot(selected)` and `enter_modeling_mode()` (flips the button to "Start Modeling (DJF)").
2. Clicking "Cell Cycle Modeling" (`#cell_cycle_modeling_button`/collapsed variant) calls `start_modeling()` directly (wired in `analysis/start.js:239-243`), defined in `js/plotting/modeling.js:162-169`: sets `modeling_started = true`, seeds `shown_fits` with the first plottable row's name, and calls `render_density_plot()`.
3. `render_density_plot()` (`js/plotting/render.js:25-405`) is the single render pass. It gathers `plottable_rows()` (`js/plotting/data.js:268-272`), runs `PhaseFinderDJF.prepare_row(row, corrections)` (`js/analysis/djf.js:322-361` — applies debris/doublet masks if the corresponding checkboxes are checked), bins each sample via `histogram_curve` (`plotting/data.js:414-431`), and computes a shared x-range (`shared_range_for_values`, `plotting/data.js:353-375`).
4. Because `modeling_started` is true (`render.js:98`), for each sample in `shown_fits` it calls `djf.fit(points, range, threshold, run_g1)` (`analysis/djf.js:461-507`) — seeds initial G1/S/G2 parameters via `seed_fit` (peak detection through `window.gsd` if loaded, else a local-maxima scan) and refines them with `window.levenbergMarquardt` (loaded async from `<head>`; `fit()` returns `null` if that library isn't ready or the fit is degenerate).
5. Fitted parameters feed `djf.components`/`djf.phase_stats` to build the G1/S/G2 area curves and the phase percent/mean/stdev table; `render.js:296-312` draws the filled component paths + solid total curve with D3, and `js/plotting/modeling.js:45-104` (`render_fit_results_table`) renders the numeric summary table overlay.
6. The draggable peak-threshold line (`render.js:314-358`) lets the user drag a new event-count cutoff; on drag `end` it sets the module-level `peak_threshold` (`plotting/data.js:112`) and calls `render_density_plot()` again, re-running the whole fit pipeline with the new threshold.
7. Checking/unchecking a sample's legend checkbox calls `toggle_fit(name)` (`plotting/modeling.js:184-191`), which updates `shown_fits` and re-renders — so only samples explicitly toggled on get fitted.

### C. Session save / load (brief trace)

- **Save**: clicking `#save_session_button` → `handle_save()` (`js/session/core.js:272-284`) → `collect_session()` (`core.js:70-138`, reads `window.PhaseFinderApp.get_session_table_state()`/`get_file_table()`, plot-control values, panel sizes, and `window.PhaseFinderSummaryStats.get_stats_plan()`) → `serialize_session()` (`js/session/toml_io.js:21-130`) → `write_session_file()` (File System Access API save picker, or a filename-`prompt()` + anchor-download fallback).
- **Load**: `handle_load()` (`core.js:286-301`) reads the TOML text, `parse_session_toml()` (`toml_io.js:189-245`), `apply_session(session)` (`core.js:183-203`, restores plot controls/UI width/stats plan and calls `apply_table_session` → `window.PhaseFinderApp.apply_session_state(...)` defined in `main.js:281-355`), then `restore_session_files(session)` (`core.js:12-66`): tries `try_load_from_opfs` (`js/session/reconnect.js:13-36`) for each file record, calls `load_files()` for any recovered files, and — for anything still missing — opens the reconnect modal (`open_reconnect_modal`, `reconnect.js:92-97`) driven by `#reconnect_choose_folder`/`#reconnect_select_files` buttons wired in `core.js:326-334`.
- **Reset**: `handle_reset()` (`core.js:303-311`) deletes the current runtime session's OPFS directory and reloads the page.

---

## 5. Data flow — core data structures

Two parallel per-file representations exist and must stay in sync:

1. **`file_map`** (a `Map<id, entry>`, owned by `main.js`) — the non-tabular, "heavy" per-file object:
   `{ id, name, file (File), summary (from FCSParser: header/metadata/columns/event_count/parameter_count/data_begin/data_end), annotations (plain object synced from the table), data (active-channel payload: channel_key, channel, dna_a/dna_h/dna_w Float64Arrays, keep_mask, indexes, removed_invalid_count, total_count), analysis_data_by_channel (Map<channel_key, data> cache, from data_structs/channel_cache.js), analysis_data_promises_by_channel (in-flight load dedup, from io/channel_loading.js) }`.

2. **`file_table_frame`** (a `PhaseFinderFrame`, also owned by `main.js`) — the tabular, "light" view: columns `id`, `name`, one column per user/filename/import metadata field (defined by `TABLE_COLUMNS` in `data_structs/table_state.js`), plus computed `"CHANNEL:metric"` stat columns added by `analysis/stats.js`. This is the single source of truth for annotation edits, filters, sort, and export — `data_structs/table_state.js`'s `sync_file_annotations()` is the one-way bridge that copies frame values back onto each `file_map` entry's `.annotations` (used later by the plot legend/fit-table metadata display in `plotting/modeling.js:63-69`).

Layer dependencies on these structures:
- **`fcs/`** produces `summary`/raw column arrays; it does not know about `file_map` or the frame.
- **`io/`** is the bridge: `metadata_io.js` populates both `file_map` and `file_table_frame` from parsed FCS headers or imported metadata files; `channel_loading.js` fills each row's `.data`/`.analysis_data_by_channel` from `fcs/parser.js` + `fcs/channel_cleaning.js` output, keyed through `data_structs/channel_cache.js`.
- **`analysis/`** (`djf.js`) consumes `row.data.dna_a/dna_h/dna_w` (from `file_map` entries) and never touches `file_table_frame` directly; `stats.js` reads channel arrays the same way but writes results back as new columns into `file_table_frame`.
- **`plotting/`** (`data.js`/`render.js`) reads `window.PhaseFinderApp.get_selected_files()` (which internally calls `sync_file_annotations()` then filters `file_table_frame`'s `id` column by `selected_file_ids`, `main.js:235-242`) to get the actual `file_map` row objects to plot — so the plot layer touches both structures, but only through the sanctioned `PhaseFinderApp` accessor, not by reading `file_map`/`file_table_frame` globals directly.
- **`ui/`** (`table_render.js`, `table_support.js`) reads/writes `file_table_frame` directly (it owns rendering the table) and reads `file_map` only to check `metadata_row_is_linked`/existence, never mutates FCS event data.
- **`session/`** serializes a third, independent shape (the TOML session object: `files.records`, `metadata.columns`/`rows`, `table.*`, `plot.*`, `ui.*`, `stats_plan.entries`) built from `file_table_frame`/`file_map` via `collect_session()`, and on load reconstitutes `file_table_frame` (via `PhaseFinderApp.apply_session_state`) independently of re-parsing FCS files — the actual FCS bytes are restored separately through OPFS-cached copies (`session/opfs.js`, `session/reconnect.js`) which get fed back through the *same* `load_files()` path as a fresh user drop, meaning session-restored files go through the identical FCS→`file_map`→`file_table_frame` pipeline as flow A above.

---

## Files inspected (all, full paths)

```
index.html
js/main.js
js/fcs/parser.js
js/fcs/metadata_processing.js
js/fcs/channel_cleaning.js
js/fcs/data_worker.js
js/data_structs/metadata_frame.js
js/data_structs/table_state.js
js/data_structs/metadata_columns.js
js/data_structs/channel_cache.js
js/io/cache.js
js/io/channel_loading.js
js/io/metadata_io.js
js/ui/hover_text.js
js/ui/status_channels.js
js/ui/metadata_wizard.js
js/ui/table_support.js
js/ui/table_render.js
js/ui/panels.js
js/ui/panel_resize.js
js/analysis/djf.js
js/analysis/start.js
js/analysis/stats.js
js/plotting/data.js
js/plotting/modeling.js
js/plotting/render.js
js/plotting/axis_modal.js
js/session/store.js
js/session/toml_io.js
js/session/opfs.js
js/session/reconnect.js
js/session/core.js
js/session/copy_worker.js
```

**Not inspected** (out of scope for this pass): `css/*.css`, `docs/*.md`, `docs/js-functionality-summary.html`, `tests/*`, `README.md`, `phasefinder_local.json.disabled`. No claim above relies on those files.
</content>
