// Session restore orchestration, state collection/application, and file IO.
// This module collects the current PhaseFinder state into a session object and
// applies parsed session state back into plot controls, metadata tables, UI
// layout, stats plans, and loaded files. It reads and writes TOML session files
// through browser file-picker APIs or download fallbacks while delegating TOML
// syntax to js/session/toml_io.js. It coordinates OPFS-backed file restore,
// manual reconnect, startup autoload, reset, and the session button handlers,
// which the entry bootstrap installs once via init_session().

import { serialize_session, parse_session_toml } from "./toml_io.js";
import { supports_opfs, get_opfs_root, ensure_directory } from "./opfs_fs.js";
import {
  fetch_files_from_url,
  auto_load_session_files,
  file_records,
  is_resolved,
  build_file_records_for,
  set_records_from_session,
  copy_file_to_opfs,
  runtime_session_id,
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
import { get_session_table_state, apply_session_state } from "./table_session.js";

// ── Session-file restore orchestration ───────────────────────────────────────

async function restore_session_files(session, options = {}) {
  const records = session.files?.records;
  const names = session.files?.names || [];

  // Legacy sessions without records: keep the original names-only flow.
  if (!records || !records.length) {
    if (!names.length) { set_status_bar('Session loaded.'); return; }
    if (options.data_directory) {
      const { files, missing } = await fetch_files_from_url(options.data_directory, names);
      if (files.length) {
        await load_files(files);
        set_status_bar(missing.length
          ? `Loaded ${files.length} file(s). Not found: ${missing.join(', ')}`
          : `Session loaded with ${files.length} file(s).`, missing.length > 0);
      } else {
        set_status_bar(`No FCS files found in "${options.data_directory}". Re-drag or reload the FCS files.`, true);
      }
      return;
    }
    set_status_bar(`Session loaded. Opening folder picker for ${names.length} FCS file${names.length === 1 ? '' : 's'}…`);
    await auto_load_session_files(names);
    return;
  }

  set_records_from_session(records);
  const all = [...file_records.values()];

  if (supports_opfs()) {
    set_status_bar(`Session loaded. Restoring ${all.length} file${all.length === 1 ? '' : 's'} from local cache…`);
    const { found } = await try_load_from_opfs(all);
    if (found.length) await load_files(found.map((f) => f.file));
  }

  // Dev convenience: fetch any still-missing files over HTTP and re-cache them.
  if (options.data_directory && all.some((r) => !is_resolved(r))) {
    const still = all.filter((r) => !is_resolved(r));
    const { files } = await fetch_files_from_url(options.data_directory, still.map((r) => r.original_name));
    for (const file of files) {
      const rec = file_records.get(file.name);
      if (rec) { try { await copy_file_to_opfs(file, rec.opfs_path); rec.status = 'available'; } catch (_) { rec.status = 'uncached'; } }
    }
    if (files.length) await load_files(files);
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
}

// ── State collection ─────────────────────────────────────────────────────────

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
    session: { created: new Date().toISOString() },
    files:   { names, records: build_file_records_for(names) },
    stats_plan: get_stats_plan(),
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
      bins:                parseInt(bins_el?.value || '512', 10),
      // Retained as false for backward-compatible session schemas; staged DJF
      // controls now own cleaning and peak inspection.
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

function apply_plot_settings(plot) {
  if (!plot) return;
  const color_by   = document.getElementById('plot_color_by');
  const display_el = document.getElementById('plot_display_mode');
  const bins_el    = document.getElementById('plot_bins');
  const ch_sel     = document.getElementById('channel_select');
  const col_ch_sel = document.getElementById('collapsed_channel_select');

  if (color_by && plot.color_by)     color_by.value   = plot.color_by;
  if (display_el && plot.display_mode) display_el.value = plot.display_mode;
  if (bins_el && plot.bins > 0)      bins_el.value    = plot.bins;
  if (ch_sel && plot.channel) {
    const opt = [...ch_sel.options].find((o) => o.value === plot.channel);
    if (opt) {
      ch_sel.value = plot.channel;
      if (col_ch_sel) col_ch_sel.value = plot.channel;
    }
  }
}

// True once every metadata-table row has a real loaded-file id (no
// placeholder "metadata-unlinked-*" rows left waiting on a reconnect).
function all_rows_linked() {
  const frame = get_file_table();
  if (!frame || !frame.length) return false;
  const file_map = get_file_map();
  return [...frame.col("id")].every((id) => file_map.has(id));
}

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

function apply_session(session) {
  pending_session = session;
  apply_plot_settings(session.plot);

  const plan = session.stats_plan?.entries;
  if (plan?.length) {
    restore_stats_plan(plan);
  }

  const app_shell = document.querySelector('.app');
  if (app_shell && session.ui?.sidebar_width_px > 0) {
    app_shell.style.setProperty('--sidebar_width', `${session.ui.sidebar_width_px}px`);
  }

  const has_files = Boolean(get_file_table()?.length);
  if (has_files || session.metadata?.rows?.length) {
    apply_table_session(session);
  } else if (session.metadata_template) {
    save_filename_metadata_template(session.metadata_template);
  }
}

// ── Session file I/O ─────────────────────────────────────────────────────────

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

// ── Button handlers ──────────────────────────────────────────────────────────

async function handle_save() {
  try {
    const session = collect_session();
    const toml    = serialize_session(session);
    const now     = new Date();
    const date    = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    await write_session_file(toml, `phasefinder_session_${date}.toml`);
    set_status_bar('Session saved.');
  } catch (err) {
    set_status_bar(`Failed to save session: ${err.message}`, true);
  }
}

async function handle_load() {
  try {
    const text = await read_session_file();
    if (!text) return;
    const session = parse_session_toml(text);
    if (!session.session?.created) {
      set_status_bar('File does not appear to be a valid PhaseFinder session.', true);
      return;
    }
    apply_session(session);
    await restore_session_files(session);
  } catch (err) {
    set_status_bar(`Failed to load session: ${err.message}`, true);
  }
}

async function handle_reset() {
  if (!window.confirm('Reset session? This deletes this session\'s cached files and cannot be undone.')) return;
  try {
    const root = await get_opfs_root();
    const sessions_dir = await ensure_directory(root, ['sessions'], false);
    await sessions_dir.removeEntry(runtime_session_id, { recursive: true });
  } catch (_) { /* nothing cached yet, or OPFS unavailable — non-fatal */ }
  window.location.reload();
}

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
// directory handle.  The JSON file is never committed — it is personal/local.
//
// Minimal example:
//   { "autoload_session": "sessions/my_experiment.toml" }
//
// The session path (like every other path in the config) is relative to the
// app root (where index.html lives), not to sessions/ itself.

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
    const session = parse_session_toml(text);
    if (!session.session?.created) {
      set_status_bar(`Auto-load: "${session_path}" is not a valid PhaseFinder session.`, true);
      return;
    }

    apply_session(session);

    await restore_session_files(session, { data_directory: config.data_directory });
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
    if (!pending_session) return;
    apply_table_session(pending_session, { restore_selection: false });
    if (all_rows_linked()) pending_session = null;
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
