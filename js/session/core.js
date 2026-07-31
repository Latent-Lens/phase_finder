// Session restore orchestration, state collection/application, and file IO.
// This module collects the current PhaseFinder state into a session object and
// applies parsed session state back into plot controls, metadata tables, UI
// layout, stats plans, and loaded files. It reads and writes TOML session files
// through browser file-picker APIs or download fallbacks while delegating TOML
// syntax to js/session/toml_io.js. It coordinates OPFS-backed file restore,
// manual reconnect, startup autoload, reset, and the session button handlers,
// which the entry bootstrap installs once via init_session().
//
// collect_session() and collect_session_toml() serialize state; apply_session()
// and its apply_* helpers restore it; restore_session_files() and the reconnect
// flow reload the FCS files; run_modeling_restore() and
// maybe_start_modeling_restore() drive the recompute-on-reload;
// handle_save()/handle_load()/handle_reset() are the button handlers;
// try_autoload() runs the startup auto-load; init_session() wires everything once.

import { serialize_session, parse_session_toml } from "./toml_io.js";
import { timestamped_filename } from "../util/names.js";
import { supports_opfs, get_opfs_root, ensure_directory, delete_opfs_path } from "./opfs_fs.js";
import {
  fetch_files_from_url,
  auto_load_session_files,
  file_records,
  is_resolved,
  build_file_records_for,
  set_records_from_session,
  copy_file_to_opfs,
  runtime_session_id,
  logical_session_id,
  set_active_logical_session_id,
  create_imported_logical_session_id,
  release_session_cache,
  catalogue_cached_record,
  wait_for_cache_idle,
  is_test_mode,
} from "./file_cache.js";
import {
  try_load_from_opfs,
  open_reconnect_modal,
  close_reconnect_modal,
  reconnect_from_directory,
  reconnect_from_files,
  get_reconnect_records,
} from "./reconnect.js";
import { load_files } from "../io/metadata_io.js";
import { set_status_bar } from "../ui/status_channels.js";
import { save_filename_metadata_template } from "../ui/metadata_wizard.js";
import { get_stats_plan, restore_stats_plan } from "../analysis/stats.js";
import { get_file_table, get_file_map } from "../state/app_state.js";
import { get_parsed_files } from "../state/files.js";
import { plot_bin_count, set_plot_bins, axis_range_override, analysis_domain_override } from "../plotting/data.js";
import { get_session_table_state, apply_session_state } from "./table_session.js";
import { get_modeling_session_state, apply_modeling_session } from "./modeling_session.js";
import {
  get_time_qc_session_config,
  apply_time_qc_session_config,
} from "../analysis/time_qc_settings.js";
import {
  get_structural_qc_session_config,
  apply_structural_qc_session_config,
} from "../analysis/structural_qc_settings.js";
import { start_analysis } from "../analysis/start.js";
import { apply_saved_qc_filters } from "../analysis/pipeline_ui.js";
import { show_progress, update_progress, hide_progress } from "../ui/status_channels.js";
import { render_density_plot } from "../plotting/render.js";
import { suppress_next_unload_warning } from "./unload_guard.js";
import { init_cache_manager } from "./cache_manager.js";
import { validate_session_draft } from './session_schema.js';
import { run_restore_stages } from './session_transaction.js';
import { PHASEFINDER_SOURCE_COMMIT, PHASEFINDER_VERSION } from '../util/build_info.js';

// ── Session-file restore orchestration ───────────────────────────────────────

/*

Purpose:
	Restores a session's FCS files: reloads them from the local OPFS cache, fetches
	still-missing ones over HTTP when a data directory is given, and opens the
	reconnect modal for any that remain. Falls back to the names-only flow for legacy
	sessions without file records.

Input:
	session [object]: the parsed session
	options [object]: { data_directory } optional HTTP source

Output:
	(none) [Promise<void>]: loads files and updates the status bar

*/
async function restore_session_files(session, options = {}, preflight = null) {
  const records = session.files?.records;
  const names = session.files?.names || [];
  const summary = { matched_files: 0, missing_files: names.length, mismatched_files: 0, legacy_unverified_files: 0 };

  // Legacy sessions without records: keep the original names-only flow.
  if (!records || !records.length) {
    if (!names.length) { set_status_bar('Session loaded.'); return summary; }
    if (options.data_directory) {
      const { files, missing } = await fetch_files_from_url(options.data_directory, names);
      if (files.length) {
        await load_files(files);
        summary.matched_files = files.length;
        summary.missing_files = missing.length;
        set_status_bar(missing.length
          ? `Loaded ${files.length} file(s). Not found: ${missing.join(', ')}`
          : `Session loaded with ${files.length} file(s).`, missing.length > 0);
      } else {
        set_status_bar(`No FCS files found in "${options.data_directory}". Re-drag or reload the FCS files.`, true);
      }
      return summary;
    }
    set_status_bar(`Session loaded. Opening folder picker for ${names.length} FCS file${names.length === 1 ? '' : 's'}…`);
    await auto_load_session_files(names, load_files);
    return summary;
  }

  const owner = set_active_logical_session_id(
    session.session?.logical_id || create_imported_logical_session_id());
  set_records_from_session(records, owner, { catalogue: false });
  const all = [...file_records.values()];

  if (supports_opfs()) {
    set_status_bar(`Session loaded. Restoring ${all.length} file${all.length === 1 ? '' : 's'} from local cache…`);
    const resolution = preflight || await try_load_from_opfs(all);
    for (const record of all) {
      const resolved = resolution.records?.find((candidate) => candidate.opfs_path === record.opfs_path);
      if (resolved) record.status = resolved.status;
    }
    const { found } = resolution;
    if (found.length) await load_files(found.map((f) => f.file));
    summary.matched_files = found.length;
    summary.missing_files = resolution.missing.length;
    summary.mismatched_files = resolution.mismatch.length;
    summary.legacy_unverified_files = resolution.unverified.length;
  }

  // Dev convenience: fetch any still-missing files over HTTP and re-cache them.
  if (options.data_directory && all.some((r) => !is_resolved(r))) {
    const still = all.filter((r) => !is_resolved(r));
    const { files } = await fetch_files_from_url(options.data_directory, still.map((r) => r.original_name));
    for (const file of files) {
      const rec = file_records.get(file.name);
      if (rec) {
        try {
          const identity = await copy_file_to_opfs(file, rec.opfs_path);
          Object.assign(rec, identity);
          rec.status = 'available';
          catalogue_cached_record(rec);
        } catch (_) { rec.status = 'uncached'; }
      }
    }
    if (files.length) await load_files(files);
    summary.matched_files += files.length;
    summary.missing_files = all.filter((record) => !is_resolved(record)).length;
  }

  if (all.some((r) => !is_resolved(r))) {
    if (!supports_opfs()) {
      set_status_bar('Automatic reload is unavailable in this browser. Reconnect the session\'s FCS files manually.', true);
    }
    open_reconnect_modal(all);
  } else {
    const loaded = all.filter(is_resolved).length;
    set_status_bar(`Session restored with ${loaded} file${loaded === 1 ? '' : 's'}.`);
  }
  all.forEach((record) => catalogue_cached_record(record, owner));
  return summary;
}

async function resolve_session_file_identity(session) {
  const records = (session.files?.records || []).map((record) => ({ ...record, status: 'missing' }));
  if (!records.length || !supports_opfs()) {
    return { records, found: [], missing: records, mismatch: [], unverified: [] };
  }
  const resolution = await try_load_from_opfs(records);
  return { records, ...resolution };
}

// ── State collection ─────────────────────────────────────────────────────────

/*

Purpose:
	Collects the entire current app state into a plain, serializable session object:
	files, stats plan, Time QC config, modeling config, metadata table, plot
	controls, and UI layout.

Input:
	(none)

Output:
	session [object]: the session object ready for serialization

*/
function collect_session() {
  const ts    = get_session_table_state();
  const frame = get_file_table();

  const names     = get_parsed_files().map((entry) => entry.name);
  const user_cols = ts.table_columns.filter((c) => c.field !== 'name');
  const table_names = frame ? [...frame.col('name')] : [];

  const meta_rows = table_names.map((name, idx) => {
    const row = { name };
    user_cols.forEach((c) => { row[c.field] = frame.col(c.field)[idx] ?? ''; });
    return row;
  });

  const app_shell  = document.querySelector('.app');
  const sidebar_w  = parseFloat(getComputedStyle(app_shell).getPropertyValue('--sidebar_width')) || 320;
  const plot_panel = document.getElementById('plot_panel');
  const meta_panel = document.getElementById('metadata_panel');
  const plot_h     = plot_panel ? Math.round(plot_panel.getBoundingClientRect().height) : 400;
  const meta_h     = meta_panel ? Math.round(meta_panel.getBoundingClientRect().height) : 300;

  const ch_sel     = document.getElementById('channel_select');
  const color_by   = document.getElementById('plot_color_by');
  const display_el = document.getElementById('plot_display_mode');
  const bins_el    = document.getElementById('plot_bins');

  return {
    session: {
      created: new Date().toISOString(),
      logical_id: logical_session_id,
      schema_version: 1,
      application: 'PhaseFinder',
      application_version: PHASEFINDER_VERSION,
      source_commit: PHASEFINDER_SOURCE_COMMIT,
    },
    files:   { names, records: build_file_records_for(names) },
    stats_plan: get_stats_plan(),
    // Structural QC's DNA saturation-ceiling overrides (structural_qc_settings.js)
    // -- a disabled/overridden ceiling changes which events Structural QC keeps,
    // so it has to round-trip the same way Time QC's method/settings do.
    structural_qc: get_structural_qc_session_config(),
    // Which Time QC method (and settings) the QC selection was produced with.
    // The two methods do not return the same mask, so restoring the filter list
    // without the method would silently reproduce a different filtering.
    time_qc: get_time_qc_session_config(),
    // Cell-cycle modeling config (recompute-on-reload): QC selection + each
    // plotted sample's accepted peak regions and model/settings. No fit results.
    modeling: get_modeling_session_state(),
    metadata: {
      columns: user_cols.map((c) => ({
        field: c.field,
        label: c.label,
        headerEditable: Boolean(c.headerEditable),
        source: c.source || '',
      })),
      rows:    meta_rows,
    },
    metadata_template: ts.template,
    table: {
      selected_files: ts.selected_names,
      sort_field:     ts.sort.field || '',
      sort_direction: ts.sort.direction || 'asc',
      filters:        ts.filters,
    },
    plot: {
      channel:             ch_sel?.value || '',
      color_by:            color_by?.value || 'file',
      display_mode:        display_el?.value || 'curve',
      // Store the actual bin count, not the slider's raw index -- the Bins
      // control is a slider over BIN_STOPS (plotting/data.js) whose value is an
      // index; plot_bin_count() maps it back to a real bin count.
      bins:                plot_bin_count(),
      // Manual axis-range overrides (double-click an axis). null = auto-scaled;
      // only the set ones are serialized (see toml_io.js). Preserves a user's
      // pinned zoom/range across reload.
      axis_x_min:          axis_range_override.x_min,
      axis_x_max:          axis_range_override.x_max,
      axis_y_min:          axis_range_override.y_min,
      axis_y_max:          axis_range_override.y_max,
      analysis_x_min:      analysis_domain_override.x_min,
      analysis_x_max:      analysis_domain_override.x_max,
      // Retained as false for backward-compatible session schemas; the DJF
      // pipeline controls now own cleaning and peak inspection.
      remove_debris:       false,
      remove_doublets:     false,
      show_peak_threshold: false,
    },
    ui: {
      sidebar_collapsed:        Boolean(app_shell?.classList.contains('sidebar_collapsed')),
      sidebar_width_px:         Math.round(sidebar_w),
      plot_panel_collapsed:     Boolean(plot_panel?.classList.contains('is_collapsed')),
      plot_panel_height_px:     plot_h,
      metadata_panel_collapsed: Boolean(meta_panel?.classList.contains('is_collapsed')),
      metadata_panel_height_px: meta_h,
    },
  };
}

// ── State application ────────────────────────────────────────────────────────

let pending_session = null;
// Saved modeling config awaiting the recompute-on-reload flow: once files
// reconnect and the saved channel is available we auto-plot, then the one-shot
// pf-plot-complete handler re-applies QC and re-fits from this config.
let pending_modeling_restore = null;
let modeling_restore_started = false;

/*

Purpose:
	Applies a session's saved plot controls (color-by, display mode, bins, manual
	axis-range overrides, and channel) to the live controls.

Input:
	plot [object]: the session's plot section

Output:
	(none) [void]

*/
function apply_plot_settings(plot) {
  if (!plot) return;
  const color_by   = document.getElementById('plot_color_by');
  const display_el = document.getElementById('plot_display_mode');
  const bins_el    = document.getElementById('plot_bins');
  const ch_sel     = document.getElementById('channel_select');
  const col_ch_sel = document.getElementById('collapsed_channel_select');

  if (color_by && plot.color_by)     color_by.value   = plot.color_by;
  if (display_el && plot.display_mode) display_el.value = plot.display_mode;
  if (bins_el && plot.bins > 0)      set_plot_bins(plot.bins);

  // Restore manual axis-range overrides; a missing/non-numeric value means
  // that bound stays auto-scaled (null). Read by render_density_plot on draw.
  axis_range_override.x_min = Number.isFinite(plot.axis_x_min) ? plot.axis_x_min : null;
  axis_range_override.x_max = Number.isFinite(plot.axis_x_max) ? plot.axis_x_max : null;
  axis_range_override.y_min = Number.isFinite(plot.axis_y_min) ? plot.axis_y_min : null;
  axis_range_override.y_max = Number.isFinite(plot.axis_y_max) ? plot.axis_y_max : null;
  analysis_domain_override.x_min = Number.isFinite(plot.analysis_x_min) ? plot.analysis_x_min : null;
  analysis_domain_override.x_max = Number.isFinite(plot.analysis_x_max) ? plot.analysis_x_max : null;
  if (ch_sel && plot.channel) {
    const opt = [...ch_sel.options].find((o) => o.value === plot.channel);
    if (opt) {
      ch_sel.value = plot.channel;
      if (col_ch_sel) col_ch_sel.value = plot.channel;
    }
  }
}

/*

Purpose:
	Whether every metadata-table row is linked to a real loaded-file id (no
	placeholder "metadata-unlinked-*" rows left waiting on a reconnect).

Input:
	(none)

Output:
	linked [boolean]: true when all rows are linked

*/
function all_rows_linked() {
  const frame = get_file_table();
  if (!frame || !frame.length) return false;
  const file_map = get_file_map();
  return [...frame.col("id")].every((id) => file_map.has(id));
}

/*

Purpose:
	Restores the metadata table from a session: template, columns, annotations,
	sort, filters, and (optionally) the selected files.

Input:
	session [object]: the parsed session
	options [object]: { restore_selection } whether to restore the selection

Output:
	(none) [void]

*/
function apply_table_session(session, { restore_selection = true } = {}) {
  apply_session_state({
    template:       session.metadata_template || null,
    columns:        session.metadata?.columns || [],
    annotations:    session.metadata?.rows || [],
    sort:           { field: session.table?.sort_field || null, direction: session.table?.sort_direction || 'asc' },
    filters:        session.table?.filters || {},
    ...(restore_selection ? { selected_names: session.table?.selected_files || [] } : {}),
  });
}

/*

Purpose:
	Once files are reconnected and the saved channel is set, auto-plots so the
	pf-plot-complete handler can recompute the saved modeling. Fires only when there
	is saved modeling to restore, so sessions without modeling keep the existing
	"reconnect, then plot yourself" behavior.

Input:
	(none)

Output:
	(none) [void]

*/
function maybe_start_modeling_restore() {
  if (!pending_modeling_restore || modeling_restore_started) return;
  if (!all_rows_linked()) return;
  if (!document.getElementById('channel_select')?.value) return;
  modeling_restore_started = true;
  start_analysis();
}

/*

Purpose:
	One-shot recompute after the auto-plot: re-applies the saved QC gates (rebuilding
	each histogram), then restores regions/model and re-fits each saved sample,
	reporting how many were restored.

Input:
	config [object]: the saved modeling section

Output:
	(none) [Promise<void>]

*/
async function run_modeling_restore(config) {
  try {
    if (config.qc_filters?.length) {
      // apply_saved_qc_filters runs its own progress overlay.
      await apply_saved_qc_filters(config.qc_filters);
    }
    show_progress('Restoring modeling');
    const result = await apply_modeling_session(config, {
      onProgress: (index, total, name) =>
        update_progress(total ? (100 * index) / total : 0, 'Restoring modeling', name),
    });
    document.dispatchEvent(new CustomEvent('cell-cycle-fit-changed'));
    if (last_restore_summary?.status === 'restored') {
      last_restore_summary = {
        ...last_restore_summary,
        recomputed_models: result.restored,
        degraded_qc: last_restore_summary.degraded_qc + result.failed,
      };
    }
    render_density_plot();
    set_status_bar(
      `Restored modeling for ${result.restored} sample${result.restored === 1 ? '' : 's'}` +
        `${result.failed ? `, ${result.failed} failed` : ''}.`,
      result.failed > 0 && result.restored === 0,
    );
    hide_progress(300);
  } catch (error) {
    set_status_bar(`Modeling restore failed: ${error.message}`, true);
    hide_progress(800);
  }
}

/*

Purpose:
	Applies a parsed session to the live app: restores the Time QC config first,
	stashes the modeling config for the recompute-on-reload flow, then applies plot
	settings, stats plan, sidebar width, and (when files/metadata exist) the table.

Input:
	session [object]: the parsed session

Output:
	(none) [void]

*/
function apply_session_configuration(session) {
  pending_session = session;
  // Restore Structural QC's saturation-ceiling overrides and the Time QC
  // method before the QC filters are re-applied, so the recompute runs with
  // the same settings the session was saved with.
  apply_structural_qc_session_config(session.structural_qc);
  apply_time_qc_session_config(session.time_qc);
  // Stash modeling config for the recompute-on-reload flow (only when the saved
  // session actually has modeled samples or an applied QC selection).
  pending_modeling_restore =
    session.modeling && (session.modeling.samples?.length || session.modeling.scatter_gates?.length || session.modeling.qc_filters?.length)
      ? session.modeling
      : null;
  modeling_restore_started = false;
}

function apply_session_view(session) {
  apply_plot_settings(session.plot);

  const plan = session.stats_plan?.entries;
  if (plan?.length) {
    restore_stats_plan(plan);
  }

  const app_shell = document.querySelector('.app');
  if (app_shell && session.ui?.sidebar_width_px > 0) {
    app_shell.style.setProperty('--sidebar_width', `${session.ui.sidebar_width_px}px`);
  }
}

function apply_session_table_state(session) {
  const has_files = Boolean(get_file_table()?.length);
  if (has_files || session.metadata?.rows?.length) {
    apply_table_session(session);
    // "Color by" only offers options for the table's current metadata
    // columns, which apply_table_session (via render_file_table) just
    // populated -- the first apply_plot_settings call above ran before they
    // existed, so a saved custom color-by column would have silently missed
    // and fallen back to "File". Re-apply now that the option exists.
    apply_plot_settings(session.plot);
  } else if (session.metadata_template) {
    save_filename_metadata_template(session.metadata_template);
  }
}

let last_restore_summary = null;

export function get_restore_summary() {
  return last_restore_summary ? { ...last_restore_summary } : null;
}

export function prepare_session_draft(parsed) {
  const migrated_fields = [];
  if ((parsed.session?.schema_version ?? 0) < 1) {
    parsed.session.schema_version = 1;
    migrated_fields.push('session.schema_version');
  }
  if (!parsed.session?.logical_id) {
    parsed.session.logical_id = create_imported_logical_session_id();
    migrated_fields.push('session.logical_id');
  }
  return { draft: validate_session_draft(parsed), migrated_fields };
}

async function restore_session_transaction(parsed, options = {}) {
  const { draft, migrated_fields } = prepare_session_draft(parsed);
  const previous_logical_session_id = logical_session_id;
  let file_resolution;
  let file_summary;
  const stages = [
    { name: 'file_identity', run: async () => { file_resolution = await resolve_session_file_identity(draft); } },
    { name: 'configuration', run: () => apply_session_configuration(draft) },
    { name: 'view', run: () => apply_session_view(draft) },
    { name: 'table', run: () => apply_session_table_state(draft) },
    { name: 'files', run: async () => { file_summary = await restore_session_files(draft, options, file_resolution); } },
  ];
  await run_restore_stages(stages, ({ stage }) => {
    pending_session = null;
    pending_modeling_restore = null;
    modeling_restore_started = false;
    set_active_logical_session_id(previous_logical_session_id);
    last_restore_summary = { status: 'failed', failed_stage: stage };
    suppress_next_unload_warning();
    window.location.reload();
  });
  last_restore_summary = {
    status: 'restored',
    schema_version: draft.session.schema_version,
    migrated_fields,
    ...file_summary,
    degraded_qc: (draft.modeling?.samples || []).filter((sample) => {
      try { return Object.keys(JSON.parse(sample.qc_waivers || '{}')).length > 0; }
      catch (_) { return false; }
    }).length,
    recomputed_models: 0,
  };
  return last_restore_summary;
}

// ── Session file I/O ─────────────────────────────────────────────────────────

/*

Purpose:
	Writes the session TOML to disk: via the File System Access save picker when
	available, otherwise a prompt-named download fallback.

Input:
	content [string]: the TOML text
	suggested_name [string]: the default filename

Output:
	(none) [Promise<void>]

*/
async function write_session_file(content, suggested_name) {
  if (typeof window.showSaveFilePicker === 'function' && !is_test_mode()) {
    let handle;
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: suggested_name,
        types: [{ description: 'TOML session file', accept: { 'text/plain': ['.toml'] } }],
      });
    } catch (err) {
      if (err.name === 'AbortError') return;
      throw err;
    }
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
  } else {
    // Firefox / Safari: no save-as API, but we can at least let the user
    // choose a filename before the browser downloads it to its default folder.
    const input = window.prompt('Save session as:', suggested_name);
    if (input === null) return; // cancelled
    const filename = input.trim() || suggested_name;
    const blob = new Blob([content], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename.endsWith('.toml') ? filename : filename + '.toml';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

/*

Purpose:
	Reads a session TOML from disk: via the File System Access open picker when
	available, otherwise a hidden file input.

Input:
	(none)

Output:
	text [Promise<string|null>]: the file text, or null when cancelled

*/
async function read_session_file() {
  if (typeof window.showOpenFilePicker === 'function' && !is_test_mode()) {
    let handles;
    try {
      handles = await window.showOpenFilePicker({
        types: [{ description: 'TOML session file', accept: { 'text/plain': ['.toml'] } }],
        multiple: false,
      });
    } catch (err) {
      if (err.name === 'AbortError') return null;
      throw err;
    }
    return (await handles[0].getFile()).text();
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type   = 'file';
    input.accept = '.toml,.txt';
    input.onchange = async () => resolve(input.files?.[0] ? await input.files[0].text() : null);
    input.click();
  });
}

/*

Purpose:
	The exact TOML text Save would write for the current state, without writing a
	file. Surfaced on window.PhaseFinder.session so the E2E suite can assert what
	actually gets persisted rather than inferring it from live state.

Input:
	(none)

Output:
	toml [string]: the serialized session TOML

*/
export function collect_session_toml() {
  return serialize_session(collect_session());
}

// ── Button handlers ──────────────────────────────────────────────────────────

/*

Purpose:
	Save button handler: collects the session, serializes it, and writes the file.

Input:
	(none)

Output:
	(none) [Promise<void>]

*/
async function handle_save() {
  try {
    await wait_for_cache_idle();
    const session = collect_session();
    const toml    = serialize_session(session);
    await write_session_file(toml, timestamped_filename('phasefinder_session', 'toml'));
    set_status_bar('Session saved.');
  } catch (err) {
    set_status_bar(`Failed to save session: ${err.message}`, true);
  }
}

/*

Purpose:
	Load button handler: reads and parses a session file, validates it, applies it,
	and restores its files.

Input:
	(none)

Output:
	(none) [Promise<void>]

*/
async function handle_load() {
  try {
    const text = await read_session_file();
    if (!text) return;
    await restore_session_transaction(parse_session_toml(text));
  } catch (err) {
    set_status_bar(`Failed to load session: ${err.message}`, true);
  }
}

/*

Purpose:
	Reset button handler: after confirmation, deletes this session's cached files
	from OPFS and reloads the app.

Input:
	(none)

Output:
	(none) [Promise<void>]

*/
async function handle_reset() {
  if (!window.confirm('Reset session? This deletes this session\'s cached files and cannot be undone.')) return;
  await release_session_cache(logical_session_id, delete_opfs_path);
  try {
    const root = await get_opfs_root();
    const sessions_dir = await ensure_directory(root, ['sessions'], false);
    await sessions_dir.removeEntry(runtime_session_id, { recursive: true });
  } catch (_) { /* nothing cached yet, or OPFS unavailable — non-fatal */ }
  set_active_logical_session_id(null);
  // The reload below is a real navigation, which would otherwise also trip
  // the beforeunload guard right after the confirm() above already asked.
  suppress_next_unload_warning();
  window.location.reload();
}

/*

Purpose:
	Closes the reconnect modal and reports how many files remain missing.

Input:
	(none)

Output:
	(none) [void]

*/
function finish_reconnect() {
  const records = get_reconnect_records();
  const remaining = records ? records.filter((r) => !is_resolved(r)).length : 0;
  close_reconnect_modal();
  set_status_bar(
    remaining ? `Continuing without ${remaining} missing file${remaining === 1 ? '' : 's'}.` : 'All session files reconnected.');
}

// ── Startup auto-load (sessions/phasefinder_local.json) ──────────────────────
// If a phasefinder_local.json file exists in sessions/, the app fetches it
// on startup and auto-loads the specified session file plus any stored FCS
// directory handle. The active JSON file is ignored and removed from Git;
// only the synthetic phasefinder_local.example.json template is public.
//
// Minimal example:
//   { "autoload_session": "sessions/my_experiment.toml" }
//
// The session path (like every other path in the config) is relative to the
// app root (where index.html lives), not to sessions/ itself.

/*

Purpose:
	Startup auto-load: if sessions/phasefinder_local.json names an autoload session,
	fetches and applies that session (and its optional data directory). Silent when
	the config file is absent.

Input:
	(none)

Output:
	(none) [Promise<void>]

*/
async function try_autoload() {
  let config;
  try {
    const resp = await fetch('./sessions/phasefinder_local.json', { cache: 'no-store' });
    if (!resp.ok) return; // file absent — normal, nothing to do
    config = await resp.json();
  } catch (_) {
    return; // fetch or parse failed — silent
  }

  const session_path = config?.autoload_session;
  if (!session_path) return;

  try {
    const resp = await fetch(session_path, { cache: 'no-store' });
    if (!resp.ok) {
      set_status_bar(`Auto-load: could not fetch session file "${session_path}".`, true);
      return;
    }
    const text    = await resp.text();
    await restore_session_transaction(parse_session_toml(text), { data_directory: config.data_directory });
  } catch (err) {
    set_status_bar(`Auto-load failed: ${err.message}`, true);
  }
}

/*

Purpose:
	Wires the Save/Load/Reset session buttons, the reconnect-modal buttons, the
	pending-session apply on file load, and the startup auto-load. Called once by
	the entry bootstrap.

Input:
	(none)

Output:
	(none) [void]: installs session listeners and defers auto-load

*/
export function init_session() {
  init_cache_manager();
  document.getElementById('save_session_button')?.addEventListener('click', handle_save);
  document.getElementById('load_session_button')?.addEventListener('click', handle_load);
  document.getElementById('reset_session_button')?.addEventListener('click', handle_reset);

  // Apply saved annotations whenever new files are loaded (covers both the
  // auto-load path and the manual drag-and-drop path). Selection is excluded
  // here: load_files() already auto-checks each newly loaded/reconnected row
  // (when no plot has started yet), and replaying the session's originally
  // saved checkbox state on top of that would silently undo it — e.g. a
  // session saved with nothing checked would leave every reconnected file
  // unplottable even after picking a channel.
  //
  // pending_session is retired the moment every row is linked to a loaded
  // file: once reconnect is finished, the app should behave exactly like a
  // freshly-built session, with Save just serializing live state (collect_session)
  // and no further TOML replay on later, unrelated file loads.
  document.addEventListener('pf-files-loaded', () => {
    if (pending_session) {
      apply_table_session(pending_session, { restore_selection: false });
      if (all_rows_linked()) pending_session = null;
    }
    // Once every row is reconnected, kick off the modeling recompute (auto-plot
    // -> QC -> refit). Runs at most once per restored session.
    maybe_start_modeling_restore();
  });

  // The recompute-on-reload second half: when the auto-plot completes, restore
  // the saved modeling exactly once, then release the pending config so later
  // user-initiated plots don't re-trigger it.
  document.addEventListener('pf-plot-complete', () => {
    if (!pending_modeling_restore) return;
    const config = pending_modeling_restore;
    pending_modeling_restore = null;
    run_modeling_restore(config);
  });

  document.getElementById('reconnect_choose_folder')?.addEventListener('click', () => {
    reconnect_from_directory().catch((err) =>
      set_status_bar(`Folder reconnect failed: ${err.message}`, true));
  });
  document.getElementById('reconnect_select_files')?.addEventListener('click', reconnect_from_files);
  document.getElementById('reconnect_continue')?.addEventListener('click', finish_reconnect);
  document.getElementById('reconnect_cancel')?.addEventListener('click', close_reconnect_modal);
  document.getElementById('reconnect_close')?.addEventListener('click', close_reconnect_modal);
  document.querySelector('#reconnect_modal .stats_modal_backdrop')?.addEventListener('click', close_reconnect_modal);

  // Defer until after the rest of the bootstrap has finished initialising.
  setTimeout(try_autoload, 0);
}
