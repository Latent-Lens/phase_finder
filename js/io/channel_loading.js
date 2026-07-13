// Selected-channel FCS DATA loading and worker orchestration. This module creates
// the shared FCS data worker (a module worker), falls back to main-thread parsing
// when appropriate, and loads only the requested parameter columns for each file.
// It resolves the selected DNA-area channel plus height/width, scatter, and Time
// companions, then stores raw original-index arrays, acquisition metadata, empty
// pipeline masks, and parameter indexes through the channel cache. It also handles
// batch progress, plot refresh after new files arrive, and background preload.

import { FCSParser } from "../fcs/parser.js";
import {
  build_raw_analysis_channels,
  find_auxiliary_indexes_for_file,
  find_pipeline_channel_indexes,
} from "../fcs/channel_cleaning.js";
import { parameter_map, find_param_index, unique_indexes } from "./parameter_map.js";
import {
  analysis_data_key,
  cached_analysis_data,
  store_analysis_data,
  is_analysis_data_loaded,
  activate_analysis_data,
} from "../data_structs/channel_cache.js";
import { get_parsed_files } from "../state/files.js";
import {
  get_selected_channels,
  set_status,
  set_status_bar,
  show_progress,
  update_progress,
  hide_progress,
  next_frame,
} from "../ui/status_channels.js";
import { plot_channels } from "../plotting/data.js";
import { init_plot } from "../plotting/modeling.js";
import { render_density_plot } from "../plotting/render.js";

export const ANALYSIS_FILE_CONCURRENCY = 4;
const FCS_DATA_WORKER_URL = new URL("../fcs/data_worker.js", import.meta.url);

let fcs_data_worker = null;
let fcs_data_worker_request_id = 0;
let fcs_data_worker_unavailable = false;
const fcs_data_worker_requests = new Map();

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
    fcs_data_worker = new Worker(FCS_DATA_WORKER_URL, { type: "module" });
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
  return FCSParser.parse_selected_columns(data_buffer, summary.metadata, selected_indexes);
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
/*

Purpose:
	Resolves one companion channel for a file. An override label chosen in the
	sidebar panel wins over auto-detection; if that label is absent from this
	particular file it degrades to "not found" rather than throwing (session files
	may differ). `undefined` means no override — use the auto-detected result.

Input:
	params [Array]:          parameter_map entries for the file
	override_label [string]: chosen label, "" for None, or undefined for auto
	auto_index [number]:     auto-detected 1-based index (or null)
	auto_label [string]:     auto-detected label

Output:
	result [Object]: { index, label }

*/
function resolve_companion(params, override_label, auto_index, auto_label) {
  if (override_label === undefined) {
    return { index: Number.isInteger(auto_index) ? auto_index : null, label: auto_label || "" };
  }
  if (!override_label) {
    return { index: null, label: "" };
  }
  const hit = params.find((param) =>
    param.label === override_label || param.name === override_label || param.desc === override_label,
  );
  return hit ? { index: hit.index, label: override_label } : { index: null, label: "" };
}

export function selected_indexes_for_file(summary, selected) {
  const params = parameter_map(summary);
  const dna_a = find_param_index(params, selected.dna_area);
  const aux = find_auxiliary_indexes_for_file(params, selected.dna_area);
  const pipeline = find_pipeline_channel_indexes(params);
  const label_for = (index) =>
    Number.isInteger(index) ? (params.find((param) => param.index === index)?.label ?? "") : "";

  const height = resolve_companion(params, selected.dna_height_label, aux.dna_h, aux.dna_height_label);
  const width = resolve_companion(params, selected.dna_width_label, aux.dna_w, aux.dna_width_label);
  const fsc = resolve_companion(params, selected.fsc_label, pipeline.fsc_a, label_for(pipeline.fsc_a));
  const ssc = resolve_companion(params, selected.ssc_label, pipeline.ssc_a, label_for(pipeline.ssc_a));

  return {
    dna_a,
    dna_h: height.index,
    dna_w: width.index,
    dna_height_label: height.label,
    dna_width_label: width.label,
    fsc_a: fsc.index,
    ssc_a: ssc.index,
    time: pipeline.time,
  };
}

// Shape the stored analysis-data object from a built channel bundle.
function make_analysis_data(row, selected, raw, indexes, companions_pending) {
  return {
    // Bare DNA-area label: the active-channel identifier the plot layer and DJF
    // pipeline match on. The companion-aware composite key is used only as the
    // analysis-data cache map key (store/cached_analysis_data).
    channel_key: selected.dna_area,
    channel: selected.dna_area,
    eventCount: row.summary.event_count,
    channels: raw.channels,
    pnr: raw.pnr,
    parameterMetadata: raw.parameterMetadata,
    masks: { structural: null, timeQC: null, scatter: null, singlet: null, final: null },
    indexes,
    // Compatibility aliases remain until the legacy DJF path is retired.
    dna_a: raw.channels.DNA_A,
    dna_h: raw.channels.DNA_H,
    dna_w: raw.channels.DNA_W,
    companionsPending: companions_pending,
  };
}

/*

Purpose:
	Background phase-2 load: reads the companion columns (Height/Width/FSC-A/
	SSC-A/Time) and merges them into an already-stored main-channel data object,
	so the plot can render from DNA-A first while these stream in behind it.

Input:
	row [Object]:      loaded sample row
	selected [Object]: selected channels
	data [Object]:     the stored main-only data object (mutated in place)

Output:
	data [Object]: the same object, with companion channels filled in

*/
async function load_companion_channels(row, selected, data, options = {}) {
  const { indexes } = data;
  const companion_indexes = unique_indexes([
    indexes.dna_h,
    indexes.dna_w,
    indexes.fsc_a,
    indexes.ssc_a,
    indexes.time,
  ]);
  if (companion_indexes.length === 0) {
    data.companionsPending = false;
    return data;
  }

  const columns = await load_selected_fcs_columns(
    row.file,
    row.summary,
    companion_indexes,
    { ...options, activate: false },
  );
  const companion_only = {
    dna_a: null,
    dna_h: indexes.dna_h,
    dna_w: indexes.dna_w,
    fsc_a: indexes.fsc_a,
    ssc_a: indexes.ssc_a,
    time: indexes.time,
  };
  const raw = build_raw_analysis_channels(
    columns,
    companion_only,
    row.summary.metadata,
    row.summary.event_count,
  );
  for (const name of ["DNA_H", "DNA_W", "FSC_A", "SSC_A", "Time"]) {
    data.channels[name] = raw.channels[name];
    data.pnr[name] = raw.pnr[name];
    data.parameterMetadata[name] = raw.parameterMetadata[name];
  }
  data.dna_h = raw.channels.DNA_H;
  data.dna_w = raw.channels.DNA_W;
  data.companionsPending = false;
  return data;
}

/*

Purpose:
	Awaits any in-flight background companion loads for the given rows. The DJF
	pipeline calls this so its scatter/singlet/time stages always see the
	Height/Width/FSC/SSC/Time channels even when the plot rendered from DNA-A
	first. Rows loaded without deferral (no companions_promise) resolve at once.

Input:
	rows [Array<Object>]: loaded sample rows

Output:
	(none) [Promise<void>]

*/
export async function ensure_companions_loaded(rows) {
  await Promise.all(
    (rows || [])
      .map((row) => row && row.companions_promise)
      .filter(Boolean),
  );
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
export async function load_analysis_row(row, selected, options = {}) {
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

    if (options.defer_companions) {
      // Phase 1: load only the main DNA channel so the plot can paint now.
      const columns = await load_selected_fcs_columns(
        row.file,
        row.summary,
        unique_indexes([indexes.dna_a]),
        options,
      );
      const main_indexes = {
        ...indexes,
        dna_h: null,
        dna_w: null,
        fsc_a: null,
        ssc_a: null,
        time: null,
      };
      const raw = build_raw_analysis_channels(
        columns,
        main_indexes,
        row.summary.metadata,
        row.summary.event_count,
      );
      const stored = store_analysis_data(
        row,
        selected,
        make_analysis_data(row, selected, raw, indexes, true),
        activate,
      );
      // Phase 2: companions in the background. Keep the promise so the pipeline
      // can await it; a failure leaves companions null (stages skip) rather than
      // blocking.
      row.companions_promise = load_companion_channels(row, selected, stored, options)
        .catch((error) => {
          stored.companionsPending = false;
          set_status_bar(`Companion channels failed to load for ${row.name}: ${error.message}`, true);
          return stored;
        });
      stored.companionsPromise = row.companions_promise;
      return stored;
    }

    // Default: load the main channel and all companions in one request.
    const requested_indexes = unique_indexes([
      indexes.dna_a,
      indexes.dna_h,
      indexes.dna_w,
      indexes.fsc_a,
      indexes.ssc_a,
      indexes.time,
    ]);
    const columns = await load_selected_fcs_columns(row.file, row.summary, requested_indexes, options);
    const raw = build_raw_analysis_channels(
      columns,
      indexes,
      row.summary.metadata,
      row.summary.event_count,
    );
    return store_analysis_data(
      row,
      selected,
      make_analysis_data(row, selected, raw, indexes, false),
      activate,
    );
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
	through the progress UI.

Input:
	batch [Array<Object>]: { row, index } entries to load
	selected [Object]:     the selected channels
	completed [Object]:    shared { count } progress counter (mutated)
	total [number]:        total number of files being loaded

Output:
	(none) [Promise<void>]: loads each row's data and advances progress

*/
export async function load_analysis_batch(
  batch,
  selected,
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
    defer_companions = false,
    display_total = total,
    display_suffix = "",
  } = options;
  const tasks = batch.map(({ row }) =>
    load_analysis_row(row, selected, { allow_main_thread_fallback, activate, defer_companions }).then(async () => {
      completed.count += 1;
      const percent = (completed.count / total) * 100;
      const detail = `${detail_prefix} for file ${completed.count} of ${display_total}${display_suffix}`;

      if (use_overlay) {
        update_progress(percent, label, detail, row.name);
      } else {
        set_status_bar(`${detail}: ${row.name}`);
      }
      await next_frame();
    }),
  );

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
export async function load_analysis_data() {
  const rows = get_parsed_files();
  const selected = get_selected_channels();
  const completed = { count: 0 };

  if (!rows.length) {
    set_status("Load at least one FCS file before starting analysis.", true);
    set_status_bar("No files loaded for analysis.", true);
    return;
  }

  show_progress("Loading FCS Data");
  set_status_bar("Working: Loading FCS Data");
  update_progress(0, "Loading FCS Data", `Preparing ${rows.length} file(s)...`);
  await next_frame();

  for (let start = 0; start < rows.length; start += ANALYSIS_FILE_CONCURRENCY) {
    const batch = rows.slice(start, start + ANALYSIS_FILE_CONCURRENCY).map((row, offset) => ({
      row,
      index: start + offset,
    }));
    await load_analysis_batch(batch, selected, completed, rows.length, "Loading FCS Data", {
      detail_prefix: "Loading data",
      // Load only the DNA channel now so the plot paints fast; the companion
      // channels (Height/Width/FSC/SSC/Time) stream in behind it and the DJF
      // pipeline awaits them via ensure_companions_loaded().
      defer_companions: true,
    });
  }

  set_status("Data loaded for all files. Curves shown for checked rows.");
  set_status_bar(`Loaded event data for all ${rows.length} file(s).`);
  update_progress(100, "Loading FCS Data", `Finished loading data for ${rows.length} file(s).`);

  init_plot(selected);

  hide_progress(700);
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
export async function refresh_analysis_after_metadata_change({ redraw_if_no_missing = true } = {}) {
  if (!plot_channels) {
    return { refreshed: false, loaded_rows: 0 };
  }

  const selected = get_selected_channels();
  const rows = get_parsed_files();
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
  show_progress(label);
  set_status_bar(`Working: ${label}`);
  update_progress(0, label, `Preparing ${missing_rows.length} added file(s)...`);
  await next_frame();

  try {
    for (let start = 0; start < missing_rows.length; start += ANALYSIS_FILE_CONCURRENCY) {
      const batch = missing_rows.slice(start, start + ANALYSIS_FILE_CONCURRENCY).map((row, offset) => ({
        row,
        index: start + offset,
      }));
      await load_analysis_batch(batch, selected, completed, missing_rows.length, label, {
        activate: should_activate_plot,
      });
    }
  } catch (error) {
    render_density_plot();
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
export async function preload_analysis_rows_in_background(rows) {
  if (!plot_channels || !rows || !rows.length) {
    return { preloaded: false, loaded_rows: 0 };
  }

  const selected = get_selected_channels();
  const targets = rows.filter((row) => !is_analysis_data_loaded(row, selected));

  if (!targets.length) {
    return { preloaded: false, loaded_rows: 0 };
  }

  if (!get_fcs_data_worker()) {
    set_status_bar("Background worker unavailable; added FCS data will load when selected.");
    return { preloaded: false, loaded_rows: 0 };
  }

  const completed = { count: 0 };
  const label = "Loading Added FCS Data";
  const all_rows = get_parsed_files();
  const overall_index_by_row = new Map(all_rows.map((row, index) => [row, index]));
  set_status_bar(`Preparing ${targets.length} added FCS file(s) for background loading...`);

  try {
    for (let start = 0; start < targets.length; start += ANALYSIS_FILE_CONCURRENCY) {
      const batch = targets.slice(start, start + ANALYSIS_FILE_CONCURRENCY).map((row) => ({
        row,
        index: overall_index_by_row.get(row) ?? 0,
      }));
      await load_analysis_batch(batch, selected, completed, targets.length, label, {
        use_overlay: false,
        detail_prefix: "Loading selected data",
        allow_main_thread_fallback: false,
        activate: false,
        display_total: all_rows.length,
        display_suffix: " FCS files",
      });
    }
  } catch (error) {
    set_status_bar(`Background FCS data load failed: ${error.message}`, true);
    return { preloaded: false, loaded_rows: completed.count };
  }

  set_status_bar(`Background loaded event data for ${targets.length} added file(s).`);
  return { preloaded: true, loaded_rows: targets.length };
}
