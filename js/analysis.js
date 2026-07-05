const analysis_start_button = document.querySelector("#start_analysis_button");
const analysis_collapsed_plot_button = document.querySelector("#collapsed_plot_button");
const cell_cycle_modeling_button = document.querySelector("#cell_cycle_modeling_button");
const collapsed_cell_cycle_modeling_button = document.querySelector("#collapsed_cell_cycle_modeling_button");
const plot_panel = document.querySelector("#plot_panel");
const metadata_panel = document.querySelector("#metadata_panel");
const metadata_panel_body = document.querySelector("#metadata_panel_body");
const metadata_panel_toggle = document.querySelector("#metadata_panel_toggle");
const metadata_panel_toggle_icon = document.querySelector("#metadata_panel_toggle_icon");
const plot_panel_toggle = document.querySelector("#plot_panel_toggle");
const plot_panel_toggle_icon = document.querySelector("#plot_panel_toggle_icon");
const plot_panel_body = document.querySelector("#plot_panel_body");
const TABLE_MINIMIZE_ICON = "./assets/img/table_minimize.svg";
const TABLE_RESTORE_ICON = "./assets/img/table_restore.svg";
const TABLE_PANEL_TRANSITION_MS = 220;

const ANALYSIS_FILE_CONCURRENCY = 4;
const FCS_DATA_WORKER_URL = "./js/fcs_data_worker.js";


let fcs_data_worker = null;
let fcs_data_worker_request_id = 0;
let fcs_data_worker_unavailable = false;
const fcs_data_worker_requests = new Map();

/*

Purpose:
	Collapses or expands the metadata (Loaded FCS Samples) panel, updating its
	CSS class, body accessibility state, aria-expanded state, and toggle icon.

Input:
	is_collapsed [boolean]: true to collapse the panel, false to expand it

Output:
	(none) [void]: updates the metadata panel DOM

*/
function set_metadata_panel_collapsed(is_collapsed) {
  if (metadata_panel.classList.contains("is_collapsed") === is_collapsed) {
    return;
  }

  metadata_panel.classList.toggle("is_collapsed", is_collapsed);
  metadata_panel_body.setAttribute("aria-hidden", String(is_collapsed));
  if ("inert" in metadata_panel_body) metadata_panel_body.inert = is_collapsed;

  const table_tooltip_key = is_collapsed ? "tableExpand" : "tableCollapse";
  metadata_panel_toggle.setAttribute("aria-expanded", String(!is_collapsed));
  window.PhaseFinderTooltips.set_quick_tooltip(metadata_panel_toggle, table_tooltip_key);
  metadata_panel_toggle.setAttribute("aria-label", window.PhaseFinderTooltips.text(table_tooltip_key));
  metadata_panel_toggle_icon.src = is_collapsed ? TABLE_RESTORE_ICON : TABLE_MINIMIZE_ICON;

  const notify_layout_changed = () => window.dispatchEvent(new Event("resize"));
  window.requestAnimationFrame(notify_layout_changed);
  window.setTimeout(notify_layout_changed, TABLE_PANEL_TRANSITION_MS);
}

/*

Purpose:
	Convenience wrapper that collapses the metadata panel.

Input:
	(none)

Output:
	(none) [void]: collapses the metadata panel

*/
function collapse_metadata_panel() {
  set_metadata_panel_collapsed(true);
}

/*

Purpose:
	Toggles the metadata panel between its collapsed and expanded states.

Input:
	(none)

Output:
	(none) [void]: toggles the metadata panel

*/
function toggle_metadata_panel() {
  set_metadata_panel_collapsed(!metadata_panel.classList.contains("is_collapsed"));
}

/*

Purpose:
	Collapses or expands the plot panel, updating its CSS class, body
	accessibility state, aria-expanded state, and toggle icon.

Input:
	is_collapsed [boolean]: true to collapse the panel, false to expand it

Output:
	(none) [void]: updates the plot panel DOM

*/
function set_plot_panel_collapsed(is_collapsed) {
  if (plot_panel.classList.contains("is_collapsed") === is_collapsed) {
    return;
  }

  plot_panel.classList.toggle("is_collapsed", is_collapsed);
  plot_panel_body.setAttribute("aria-hidden", String(is_collapsed));
  if ("inert" in plot_panel_body) plot_panel_body.inert = is_collapsed;

  const plot_tooltip_key = is_collapsed ? "plotExpand" : "plotCollapse";
  plot_panel_toggle.setAttribute("aria-expanded", String(!is_collapsed));
  window.PhaseFinderTooltips.set_quick_tooltip(plot_panel_toggle, plot_tooltip_key);
  plot_panel_toggle.setAttribute("aria-label", window.PhaseFinderTooltips.text(plot_tooltip_key));
  plot_panel_toggle_icon.src = is_collapsed ? TABLE_RESTORE_ICON : TABLE_MINIMIZE_ICON;

  const notify_layout_changed = () => window.dispatchEvent(new Event("resize"));
  window.requestAnimationFrame(notify_layout_changed);
  window.setTimeout(notify_layout_changed, TABLE_PANEL_TRANSITION_MS);
}

function toggle_plot_panel() {
  set_plot_panel_collapsed(!plot_panel.classList.contains("is_collapsed"));
}

/*

Purpose:
	Builds a lookup of a file's FCS parameters, pairing each column with its
	1-based index and its $PnN / $PnS metadata names.

Input:
	summary [Object]: parsed FCS header/metadata for one file

Output:
	params [Array<Object>]: { index, label, name, desc } per parameter

*/
function parameter_map(summary) {
  return summary.columns.map((label, index) => ({
    index: index + 1,
    label,
    name: summary.metadata[`P${index + 1}N`] || "",
    desc: summary.metadata[`P${index + 1}S`] || "",
  }));
}

/*

Purpose:
	Finds the 1-based parameter index whose label, name, or description matches
	the selected channel. Throws if no parameter matches.

Input:
	params [Array<Object>]:   parameter map from parameter_map()
	selected_label [string]:  the chosen channel label/name

Output:
	index [number]: the 1-based FCS parameter index

*/
function find_param_index(params, selected_label) {
  const hit = params.find((param) =>
    param.label === selected_label || param.name === selected_label || param.desc === selected_label
  );

  if (!hit) {
    throw new Error(`Could not find selected channel: ${selected_label}`);
  }

  return hit.index;
}

/*

Purpose:
	De-duplicates a list of parameter indexes, keeping only integers, so a
	column isn't read twice from the FCS data.

Input:
	indexes [Array<number>]: candidate parameter indexes (may include non-integers)

Output:
	unique [Array<number>]: the distinct integer indexes

*/
function unique_indexes(indexes) {
  return Array.from(new Set(indexes.filter((index) => Number.isInteger(index))));
}

/*

Purpose:
	Builds a stable cache key for analysis data loaded for a selected channel.

Input:
	selected [Object]: the selected channels, e.g. { dna_area }

Output:
	key [string]: the cache key for this analysis channel

*/
function analysis_data_key(selected) {
  return selected && selected.dna_area ? selected.dna_area : "";
}

/*

Purpose:
	Returns cached analysis data for a row/channel, if that channel was already
	loaded.

Input:
	row [Object]:      loaded sample row
	selected [Object]: selected channels

Output:
	data [Object|null]: cached row data for the selected channel

*/
function cached_analysis_data(row, selected) {
  const key = analysis_data_key(selected);
  return row.analysis_data_by_channel ? row.analysis_data_by_channel.get(key) || null : null;
}

/*

Purpose:
	Stores analysis data in the row's per-channel cache and optionally activates
	it as row.data for plotting.

Input:
	row [Object]:       loaded sample row
	selected [Object]:  selected channels
	data [Object]:      loaded channel data
	activate [boolean]: true to set row.data for plotting

Output:
	data [Object]: the stored row data

*/
function store_analysis_data(row, selected, data, activate = true) {
  if (!row.analysis_data_by_channel) {
    row.analysis_data_by_channel = new Map();
  }
  row.analysis_data_by_channel.set(analysis_data_key(selected), data);
  if (activate) {
    row.data = data;
  }
  return data;
}

/*

Purpose:
	Checks whether a row already has the selected channel loaded in cache.

Input:
	row [Object]:      loaded sample row
	selected [Object]: selected channels

Output:
	loaded [boolean]: true when cached data exists for the selected channel

*/
function is_analysis_data_loaded(row, selected) {
  const data = cached_analysis_data(row, selected);
  return Boolean(data && data.dna_a);
}

/*

Purpose:
	Activates cached data for the selected channel as row.data so plot code reads
	the intended column.

Input:
	row [Object]:      loaded sample row
	selected [Object]: selected channels

Output:
	activated [boolean]: true if cached data was activated

*/
function activate_analysis_data(row, selected) {
  const data = cached_analysis_data(row, selected);
  if (!data) {
    return false;
  }
  row.data = data;
  return true;
}

/*

Purpose:
	Returns the shared FCS data worker, creating it on first use. If worker
	creation fails, future selected-column loads fall back to the main thread.

Input:
	(none)

Output:
	worker [Worker|null]: active worker, or null when unavailable

*/
function get_fcs_data_worker() {
  if (fcs_data_worker_unavailable || typeof Worker === "undefined") {
    return null;
  }

  if (fcs_data_worker) {
    return fcs_data_worker;
  }

  try {
    fcs_data_worker = new Worker(FCS_DATA_WORKER_URL);
    fcs_data_worker.addEventListener("message", (event) => {
      const { request_id, ok, columns, error } = event.data || {};
      const request = fcs_data_worker_requests.get(request_id);
      if (!request) {
        return;
      }

      fcs_data_worker_requests.delete(request_id);
      if (ok) {
        request.resolve(columns);
      } else {
        request.reject(new Error(error || "FCS worker failed to load selected columns."));
      }
    });
    fcs_data_worker.addEventListener("error", () => {
      fcs_data_worker_unavailable = true;
      fcs_data_worker_requests.forEach((request) => {
        request.reject(new Error("FCS data worker failed. Falling back on future loads."));
      });
      fcs_data_worker_requests.clear();
      if (fcs_data_worker) {
        fcs_data_worker.terminate();
        fcs_data_worker = null;
      }
    });
  } catch (error) {
    fcs_data_worker_unavailable = true;
    fcs_data_worker = null;
  }

  return fcs_data_worker;
}

/*

Purpose:
	Reads requested parameter columns in the FCS data worker.

Input:
	file [File]:                       the FCS File object
	summary [Object]:                  parsed header/metadata (data_begin/data_end/metadata)
	selected_indexes [Array<number>]:  1-based parameter indexes to read

Output:
	columns [Promise<Object>|null]: selected parameter arrays keyed by index

*/
function load_selected_fcs_columns_in_worker(file, summary, selected_indexes) {
  const worker = get_fcs_data_worker();
  if (!worker) {
    return null;
  }

  const request_id = ++fcs_data_worker_request_id;
  const request = new Promise((resolve, reject) => {
    fcs_data_worker_requests.set(request_id, { resolve, reject });
  });

  try {
    worker.postMessage({ request_id, file, summary, selected_indexes });
  } catch (error) {
    fcs_data_worker_requests.delete(request_id);
    return null;
  }

  return request;
}

/*

Purpose:
	Reads only the requested parameter columns from one FCS file's DATA segment,
	preferring the worker path so large data parsing does not block the UI thread.

Input:
	file [File]:                       the FCS File object
	summary [Object]:                  parsed header/metadata (data_begin/data_end/metadata)
	selected_indexes [Array<number>]:  1-based parameter indexes to read

Output:
	columns [Promise<Object>]: resolves to the parsed columns keyed by index

*/
async function load_selected_fcs_columns(file, summary, selected_indexes, options = {}) {
  const { allow_main_thread_fallback = true } = options;

  const worker_request = load_selected_fcs_columns_in_worker(file, summary, selected_indexes);
  if (worker_request) {
    try {
      return await worker_request;
    } catch (error) {
      if (!fcs_data_worker_unavailable || !allow_main_thread_fallback) {
        throw error;
      }
    }
  } else if (!allow_main_thread_fallback) {
    throw new Error("Background worker unavailable; added FCS data will load when selected.");
  }

  const data_buffer = await file.slice(summary.data_begin, summary.data_end + 1).arrayBuffer();
  return window.FCSParser.parse_selected_columns(data_buffer, summary.metadata, selected_indexes);
}

/*

Purpose:
	Resolves the selected DNA-content area channel to its parameter index for
	one file.

Input:
	summary [Object]:  parsed header/metadata for the file
	selected [Object]: the selected channels, e.g. { dna_area }

Output:
	indexes [Object]: { dna_a } parameter index for the file

*/
function selected_indexes_for_file(summary, selected) {
  const params = parameter_map(summary);
  const dna_a = find_param_index(params, selected.dna_area);
  const aux = window.PhaseFinderDJF && typeof window.PhaseFinderDJF.find_auxiliary_indexes === "function"
    ? window.PhaseFinderDJF.find_auxiliary_indexes(summary, selected.dna_area)
    : {};

  return {
    dna_a,
    dna_h: aux.dna_h || null,
    dna_w: aux.dna_w || null,
    dna_height_label: aux.dna_height_label || "",
    dna_width_label: aux.dna_width_label || "",
  };
}

/*

Purpose:
	Loads the selected DNA-content column for one sample and stores it on
	row.data so the plot can read it.

Input:
	row [Object]:      a loaded sample (has .file and .summary)
	selected [Object]: the selected channels

Output:
	(none) [Promise<void>]: sets row.data = { dna_a, indexes }

*/
async function load_analysis_row(row, selected, options = {}) {
  const { activate = true } = options;
  const key = analysis_data_key(selected);
  const cached = cached_analysis_data(row, selected);

  if (cached && cached.dna_a) {
    if (activate) {
      row.data = cached;
    }
    return cached;
  }

  if (!row.analysis_data_promises_by_channel) {
    row.analysis_data_promises_by_channel = new Map();
  }

  const pending = row.analysis_data_promises_by_channel.get(key);
  if (pending) {
    try {
      const data = await pending;
      if (activate) {
        row.data = data;
      }
      return data;
    } catch (error) {
      if (options.allow_main_thread_fallback === false || !fcs_data_worker_unavailable) {
        throw error;
      }
      row.analysis_data_promises_by_channel.delete(key);
    }
  }

  const promise = (async () => {
    const indexes = selected_indexes_for_file(row.summary, selected);
    const columns = await load_selected_fcs_columns(row.file, row.summary, unique_indexes([indexes.dna_a, indexes.dna_h, indexes.dna_w]), options);
    const data = {
      channel_key: key,
      channel: selected.dna_area,
      dna_a: columns[indexes.dna_a],
      dna_h: indexes.dna_h ? columns[indexes.dna_h] : null,
      dna_w: indexes.dna_w ? columns[indexes.dna_w] : null,
      indexes,
    };
    return store_analysis_data(row, selected, data, activate);
  })();

  row.analysis_data_promises_by_channel.set(key, promise);

  try {
    const data = await promise;
    if (activate) {
      row.data = data;
    }
    return data;
  } finally {
    row.analysis_data_promises_by_channel.delete(key);
  }
}

/*

Purpose:
	Loads a batch of samples concurrently while reporting per-file progress
	through the app's progress UI.

Input:
  batch [Array<Object>]: { row, index } entries to load
  selected [Object]:     the selected channels
  app [Object]:          window.PhaseFinderApp (progress/status helpers)
  completed [Object]:    shared { count } progress counter (mutated)
  total [number]:        total number of files being loaded

Output:
	(none) [Promise<void>]: loads each row's data and advances progress

*/
async function load_analysis_batch(
  batch,
  selected,
  app,
  completed,
  total,
  label = "Loading Selected FCS Data",
  options = {},
) {
  const {
    use_overlay = true,
    detail_prefix = "Loading selected data",
    allow_main_thread_fallback = true,
    activate = true,
    display_total = total,
    display_suffix = "",
  } = options;
  const tasks = batch.map(({ row }) => load_analysis_row(row, selected, { allow_main_thread_fallback, activate }));

  for (const { row, index } of batch) {
    completed.count += 1;
    const percent = (completed.count / total) * 100;
    const detail = `${detail_prefix} for file ${index + 1} of ${display_total}${display_suffix}`;

    if (use_overlay) {
      app.update_progress(percent, label, detail, row.name);
    } else {
      app.set_status_bar(`${detail}: ${row.name}`);
    }
    await app.next_frame();
  }

  await Promise.all(tasks);
}

/*

Purpose:
	Orchestrates analysis: gathers the checked samples and the selected channel,
	loads their data in batches with progress feedback, then reveals the plot
	via init_plot. Bails with a status message if nothing is selected.

Input:
	(none)

Output:
	(none) [Promise<void>]: loads the selected data and initializes the plot

*/
async function load_analysis_data() {
  const app = window.PhaseFinderApp;
  const rows = app.get_parsed_files();
  const selected = app.get_selected_channels();
  const completed = { count: 0 };

  if (!rows.length) {
    app.set_status("Load at least one FCS file before starting analysis.", true);
    app.set_status_bar("No files loaded for analysis.", true);
    return;
  }

  app.show_progress("Loading FCS Data");
  app.set_status_bar("Working: Loading FCS Data");
  app.update_progress(0, "Loading FCS Data", `Preparing ${rows.length} file(s)...`);
  await app.next_frame();

  for (let start = 0; start < rows.length; start += ANALYSIS_FILE_CONCURRENCY) {
    const batch = rows.slice(start, start + ANALYSIS_FILE_CONCURRENCY).map((row, offset) => ({
      row,
      index: start + offset,
    }));
    await load_analysis_batch(batch, selected, app, completed, rows.length, "Loading FCS Data", {
      detail_prefix: "Loading data",
    });
  }

  app.set_status("Data loaded for all files. Curves shown for checked rows.");
  app.set_status_bar(`Loaded event data for all ${rows.length} file(s).`);
  app.update_progress(100, "Loading FCS Data", `Finished loading data for ${rows.length} file(s).`);

  init_plot(selected);

  app.hide_progress(700);
}

/*

Purpose:
	Refreshes downstream analysis after new metadata files are added. If a plot
	already exists, loads event data only for selected rows missing data and
	redraws the existing plot/modeling view.

Input:
	(none)

Output:
	result [Promise<Object>]: { refreshed, loaded_rows }

*/
async function refresh_analysis_after_metadata_change({ redraw_if_no_missing = true } = {}) {
  if (typeof plot_channels === "undefined" || !plot_channels || typeof init_plot !== "function") {
    return { refreshed: false, loaded_rows: 0 };
  }

  const app = window.PhaseFinderApp;
  const selected = app.get_selected_channels();
  const rows = app.get_parsed_files();
  const should_activate_plot = !plot_channels || selected.dna_area === plot_channels.dna_area;
  const missing_rows = rows.filter((row) => !is_analysis_data_loaded(row, selected));

  if (!missing_rows.length) {
    if (redraw_if_no_missing && should_activate_plot) {
      rows.forEach((row) => activate_analysis_data(row, selected));
      init_plot(selected);
    }
    return { refreshed: redraw_if_no_missing && should_activate_plot, loaded_rows: 0 };
  }

  const completed = { count: 0 };
  const label = "Loading Added FCS Data";
  app.show_progress(label);
  app.set_status_bar(`Working: ${label}`);
  app.update_progress(0, label, `Preparing ${missing_rows.length} added file(s)...`);
  await app.next_frame();

  try {
    for (let start = 0; start < missing_rows.length; start += ANALYSIS_FILE_CONCURRENCY) {
      const batch = missing_rows.slice(start, start + ANALYSIS_FILE_CONCURRENCY).map((row, offset) => ({
        row,
        index: start + offset,
      }));
      await load_analysis_batch(batch, selected, app, completed, missing_rows.length, label, {
        activate: should_activate_plot,
      });
    }
  } catch (error) {
    if (typeof render_density_plot === "function") {
      render_density_plot();
    }
    throw error;
  }

  if (should_activate_plot) {
    init_plot(selected);
  }
  return { refreshed: should_activate_plot, loaded_rows: missing_rows.length };
}

/*

Purpose:
	Preloads event data for newly added files after a plot already exists. Rows
	remain unchecked, so their traces are not added unless the user selects them.
	Progress is reported only in the footer status bar.

Input:
	rows [Array<Object>]: newly added loaded-file entries

Output:
	result [Promise<Object>]: { preloaded, loaded_rows }

*/
async function preload_analysis_rows_in_background(rows) {
  if (typeof plot_channels === "undefined" || !plot_channels || !rows || !rows.length) {
    return { preloaded: false, loaded_rows: 0 };
  }

  const app = window.PhaseFinderApp;
  const selected = app.get_selected_channels();
  const targets = rows.filter((row) => !is_analysis_data_loaded(row, selected));

  if (!targets.length) {
    return { preloaded: false, loaded_rows: 0 };
  }

  if (!get_fcs_data_worker()) {
    app.set_status_bar("Background worker unavailable; added FCS data will load when selected.");
    return { preloaded: false, loaded_rows: 0 };
  }

  const completed = { count: 0 };
  const label = "Loading Added FCS Data";
  const all_rows = typeof app.get_parsed_files === "function" ? app.get_parsed_files() : targets;
  const overall_index_by_row = new Map(all_rows.map((row, index) => [row, index]));
  app.set_status_bar(`Preparing ${targets.length} added FCS file(s) for background loading...`);

  try {
    for (let start = 0; start < targets.length; start += ANALYSIS_FILE_CONCURRENCY) {
      const batch = targets.slice(start, start + ANALYSIS_FILE_CONCURRENCY).map((row) => ({
        row,
        index: overall_index_by_row.get(row) ?? 0,
      }));
      await load_analysis_batch(batch, selected, app, completed, targets.length, label, {
        use_overlay: false,
        detail_prefix: "Loading selected data",
        allow_main_thread_fallback: false,
        activate: false,
        display_total: all_rows.length,
        display_suffix: " FCS files",
      });
    }
  } catch (error) {
    app.set_status_bar(`Background FCS data load failed: ${error.message}`, true);
    return { preloaded: false, loaded_rows: completed.count };
  }

  app.set_status_bar(`Background loaded event data for ${targets.length} added file(s).`);
  return { preloaded: true, loaded_rows: targets.length };
}

// Whether analysis has run; once true the button drives DJF modeling instead.
let modeling_mode = false;
let channel_change_load_id = 0;

/*

Purpose:
	Forces the plot action controls disabled/enabled while modal channel-data
	loading is in progress.

Input:
	is_disabled [boolean]: true to disable plot controls

Output:
	(none) [void]: updates the plot action buttons

*/
function set_plot_action_controls_disabled(is_disabled) {
  [analysis_start_button, analysis_collapsed_plot_button].forEach((button) => {
    if (button) {
      button.disabled = is_disabled;
    }
  });
}

/*

Purpose:
	Restores the Plot Channel Events button state after the selected channel
	changes, replacing Start Modeling (DJF) until the new channel is plotted.

Input:
	(none)

Output:
	(none) [void]: updates button text, class, and tooltip

*/
function enter_plotting_mode() {
  modeling_mode = false;
  if (analysis_start_button) analysis_start_button.classList.remove("modeling");
  if (typeof reset_modeling_state === "function") {
    reset_modeling_state();
  }
  [cell_cycle_modeling_button, collapsed_cell_cycle_modeling_button].forEach((btn) => {
    if (!btn) return;
    btn.disabled = true;
    btn.setAttribute("aria-label", window.PhaseFinderTooltips.text("cellCycleModelingDisabled"));
    window.PhaseFinderTooltips.set_quick_tooltip(btn, "cellCycleModelingDisabled");
  });
}

/*

Purpose:
	After a plot exists and the selected channel changes, load missing data for
	the new channel with the modal progress UI, then switch the visible plot
	over to it once loading finishes (or immediately, if its data was already
	cached from an earlier plot).

Input:
	(none)

Output:
	(none) [Promise<void>]: loads selected-row data for the newly selected channel

*/
async function prepare_selected_channel_for_plotting() {
  const app = window.PhaseFinderApp;
  const selected = app.get_selected_channels();

  if (typeof plot_channels === "undefined" || !plot_channels) {
    return;
  }

  const request_id = ++channel_change_load_id;
  const rows = app.get_parsed_files();

  enter_plotting_mode();

  if (typeof update_start_button_state === "function") {
    update_start_button_state();
  }

  if (!selected.dna_area || !rows.length) {
    app.set_status_bar("Load files and select a channel before plotting.", true);
    return;
  }

  const missing_rows = rows.filter((row) => !is_analysis_data_loaded(row, selected));
  if (!missing_rows.length) {
    // Data for this channel is already cached (e.g. switching back to a
    // previously-plotted channel) — activate it as row.data and switch the
    // visible plot over now.
    rows.forEach((row) => activate_analysis_data(row, selected));
    if (typeof init_plot === "function") {
      init_plot(selected);
    }
    app.set_status_bar(`Channel ${selected.dna_area} data ready.`);
    return;
  }

  const completed = { count: 0 };
  const label = `Loading ${selected.dna_area} Channel FCS Data`;
  set_plot_action_controls_disabled(true);
  app.show_progress(label);
  app.set_status_bar(`Working: ${label}`);
  app.update_progress(0, label, `Preparing ${missing_rows.length} file(s)...`);
  await app.next_frame();

  try {
    for (let start = 0; start < missing_rows.length; start += ANALYSIS_FILE_CONCURRENCY) {
      const batch = missing_rows.slice(start, start + ANALYSIS_FILE_CONCURRENCY).map((row, offset) => ({
        row,
        index: start + offset,
      }));
      await load_analysis_batch(batch, selected, app, completed, missing_rows.length, label, {
        activate: false,
        detail_prefix: "Loading data",
      });
    }

    if (request_id === channel_change_load_id) {
      // Now that the new channel's data has actually finished loading,
      // activate it for every row (it was loaded with activate: false to
      // avoid disturbing the still-visible old plot mid-load) and switch
      // the visible plot over to it.
      rows.forEach((row) => activate_analysis_data(row, selected));
      if (typeof init_plot === "function") {
        init_plot(selected);
      }
      app.set_status_bar(`Channel ${selected.dna_area} data ready — pre-loaded ${missing_rows.length} file(s).`);
      app.update_progress(100, label, `Finished loading data for ${missing_rows.length} file(s).`);
    }
  } finally {
    if (request_id === channel_change_load_id) {
      app.hide_progress(700);
      if (typeof update_start_button_state === "function") {
        update_start_button_state();
      } else {
        set_plot_action_controls_disabled(false);
      }
    }
  }
}

/*

Purpose:
	Turns the Plot Channel Events button into the blue "Start Modeling (DJF)" button
	after analysis has run, so clicking it next starts cell-cycle modeling.

Input:
	(none)

Output:
	(none) [void]: updates the button text/style and the modeling flag

*/
function enter_modeling_mode() {
  modeling_mode = true;
  if (analysis_start_button) analysis_start_button.classList.add("modeling");
  [cell_cycle_modeling_button, collapsed_cell_cycle_modeling_button].forEach((btn) => {
    if (!btn) return;
    btn.disabled = false;
    btn.setAttribute("aria-label", window.PhaseFinderTooltips.text("cellCycleModeling"));
    window.PhaseFinderTooltips.set_quick_tooltip(btn, "cellCycleModeling");
  });
}

/*

Purpose:
	Click handler for plot controls. Before analysis it loads the selected
	data and reveals the plot (then flips the button to modeling mode); after
	that it starts DJF modeling (plotting.js start_modeling).

Input:
	(none)

Output:
	(none) [Promise<void>]: runs analysis or starts modeling

*/
async function start_analysis() {
  plot_panel.hidden = false;
  document.dispatchEvent(new CustomEvent("pf-plot-started", {
    detail: { channel: window.PhaseFinderApp.get_selected_channels().dna_area },
  }));

  try {
    await load_analysis_data();
    enter_modeling_mode();
    document.dispatchEvent(new CustomEvent("pf-plot-complete", {
      detail: { channel: window.PhaseFinderApp.get_selected_channels().dna_area },
    }));
  } catch (error) {
    window.PhaseFinderApp.set_status(error.message, true);
    window.PhaseFinderApp.set_status_bar("Selected data loading failed.", true);
    window.PhaseFinderApp.update_progress(100, "Loading Selected FCS Data", error.message);
    window.PhaseFinderApp.hide_progress(1400);
  }
}

metadata_panel_toggle.addEventListener("click", toggle_metadata_panel);
plot_panel_toggle.addEventListener("click", toggle_plot_panel);
analysis_start_button.addEventListener("click", start_analysis);
analysis_collapsed_plot_button.addEventListener("click", start_analysis);
document.addEventListener("fcs-selection-change", () => {
  refresh_analysis_after_metadata_change({ redraw_if_no_missing: false }).catch((error) => {
    window.PhaseFinderApp.set_status(error.message, true);
    window.PhaseFinderApp.set_status_bar("Selected data loading failed.", true);
    window.PhaseFinderApp.update_progress(100, "Loading Added FCS Data", error.message);
    window.PhaseFinderApp.hide_progress(1400);
  });
});

document.addEventListener("fcs-channel-change", () => {
  prepare_selected_channel_for_plotting().catch((error) => {
    window.PhaseFinderApp.set_status(error.message, true);
    window.PhaseFinderApp.set_status_bar("Selected channel data loading failed.", true);
    window.PhaseFinderApp.update_progress(100, "Loading Selected FCS Data", error.message);
    window.PhaseFinderApp.hide_progress(1400);
    if (typeof update_start_button_state === "function") {
      update_start_button_state();
    }
  });
});

// Cell Cycle Modeling buttons — call start_modeling directly (defined in plotting.js).
[cell_cycle_modeling_button, collapsed_cell_cycle_modeling_button].forEach((btn) => {
  if (btn) btn.addEventListener("click", () => {
    if (typeof start_modeling === "function") start_modeling();
  });
});
