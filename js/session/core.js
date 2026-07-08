// Session restore orchestration, state collection/application, and file IO.
// This file collects the current PhaseFinder state into a session object and
// applies parsed session state back into plot controls, metadata tables, UI
// layout, stats plans, and loaded files. It reads and writes TOML session files
// through browser file-picker APIs or download fallbacks while delegating TOML
// syntax to js/session/toml_io.js. It coordinates OPFS-backed file restore,
// manual reconnect, startup autoload, reset, and session button handlers. It
// must load after the TOML, OPFS, and reconnect helpers.

// ── Session-file restore orchestration ───────────────────────────────────────

async function restore_session_files(session, options = {}) {
  const app = window.PhaseFinderApp;
  const records = session.files?.records;
  const names = session.files?.names || [];

  // Legacy sessions without records: keep the original names-only flow.
  if (!records || !records.length) {
    if (!names.length) { app.set_status_bar?.('Session loaded.'); return; }
    if (options.data_directory) {
      const { files, missing } = await fetch_files_from_url(options.data_directory, names);
      if (files.length) {
        await load_files(files);
        app.set_status_bar?.(missing.length
          ? `Loaded ${files.length} file(s). Not found: ${missing.join(', ')}`
          : `Session loaded with ${files.length} file(s).`, missing.length > 0);
      } else {
        app.set_status_bar?.(`No FCS files found in "${options.data_directory}". Re-drag or reload the FCS files.`, true);
      }
      return;
    }
    app.set_status_bar?.(`Session loaded. Opening folder picker for ${names.length} FCS file${names.length === 1 ? '' : 's'}…`);
    await auto_load_session_files(names);
    return;
  }

  set_records_from_session(records);
  const all = [...file_records.values()];

  if (OPFS()?.supports_opfs()) {
    app.set_status_bar?.(`Session loaded. Restoring ${all.length} file${all.length === 1 ? '' : 's'} from local cache…`);
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
    if (!OPFS()?.supports_opfs()) {
      app.set_status_bar?.('Automatic reload is unavailable in this browser. Reconnect the session\'s FCS files manually.', true);
    }
    open_reconnect_modal(all);
  } else {
    const loaded = all.filter(is_resolved).length;
    app.set_status_bar?.(`Session restored with ${loaded} file${loaded === 1 ? '' : 's'}.`);
  }
}

// ── State collection ─────────────────────────────────────────────────────────

function collect_session() {
  const app   = window.PhaseFinderApp;
  const ts    = app.get_session_table_state();
  const frame = app.get_file_table();

  const names     = app.get_parsed_files?.().map((entry) => entry.name) || [];
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
  const debris_el  = document.getElementById('plot_debris_correction');
  const doublet_el = document.getElementById('plot_doublet_correction');
  const thresh_el  = document.getElementById('plot_threshold_toggle');

  return {
    session: { created: new Date().toISOString() },
    files:   { names, records: build_file_records_for(names) },
    stats_plan: window.PhaseFinderSummaryStats?.get_stats_plan?.() ?? [],
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
      remove_debris:       debris_el?.checked || false,
      remove_doublets:     doublet_el?.checked || false,
      show_peak_threshold: thresh_el?.checked || false,
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
  const debris_el  = document.getElementById('plot_debris_correction');
  const doublet_el = document.getElementById('plot_doublet_correction');
  const thresh_el  = document.getElementById('plot_threshold_toggle');
  const ch_sel     = document.getElementById('channel_select');
  const col_ch_sel = document.getElementById('collapsed_channel_select');

  if (color_by && plot.color_by)     color_by.value   = plot.color_by;
  if (display_el && plot.display_mode) display_el.value = plot.display_mode;
  if (bins_el && plot.bins > 0)      bins_el.value    = plot.bins;
  if (debris_el)  debris_el.checked  = Boolean(plot.remove_debris);
  if (doublet_el) doublet_el.checked = Boolean(plot.remove_doublets);
  if (thresh_el)  thresh_el.checked  = Boolean(plot.show_peak_threshold);
  if (ch_sel && plot.channel) {
    const opt = [...ch_sel.options].find((o) => o.value === plot.channel);
    if (opt) {
      ch_sel.value = plot.channel;
      if (col_ch_sel) col_ch_sel.value = plot.channel;
    }
  }
}

function apply_table_session(session) {
  const app = window.PhaseFinderApp;
  if (!app.apply_session_state) return;
  app.apply_session_state({
    template:       session.metadata_template || null,
    columns:        session.metadata?.columns || [],
    annotations:    session.metadata?.rows || [],
    sort:           { field: session.table?.sort_field || null, direction: session.table?.sort_direction || 'asc' },
    filters:        session.table?.filters || {},
    selected_names: session.table?.selected_files || [],
  });
}

function apply_session(session) {
  pending_session = session;
  apply_plot_settings(session.plot);

  const plan = session.stats_plan?.entries;
  if (plan?.length) {
    window.PhaseFinderSummaryStats?.restore_stats_plan?.(plan);
  }

  const app_shell = document.querySelector('.app');
  if (app_shell && session.ui?.sidebar_width_px > 0) {
    app_shell.style.setProperty('--sidebar_width', `${session.ui.sidebar_width_px}px`);
  }

  const has_files = Boolean(window.PhaseFinderApp.get_file_table()?.length);
  if (has_files || session.metadata?.rows?.length) {
    apply_table_session(session);
  } else if (session.metadata_template && window.PhaseFinderApp.save_metadata_template) {
    window.PhaseFinderApp.save_metadata_template(session.metadata_template);
  }
}

// Apply saved annotations whenever new files are loaded (covers both the
// auto-load path and the manual drag-and-drop path).
document.addEventListener('pf-files-loaded', () => {
  if (!pending_session) return;
  apply_table_session(pending_session);
});

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
  const app = window.PhaseFinderApp;
  try {
    const session = collect_session();
    const toml    = serialize_session(session);
    const now     = new Date();
    const date    = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    await write_session_file(toml, `phasefinder_session_${date}.toml`);
    app.set_status_bar?.('Session saved.');
  } catch (err) {
    app.set_status_bar?.(`Failed to save session: ${err.message}`, true);
  }
}

async function handle_load() {
  const app = window.PhaseFinderApp;
  try {
    const text = await read_session_file();
    if (!text) return;
    const session = parse_session_toml(text);
    if (!session.session?.created) {
      app.set_status_bar?.('File does not appear to be a valid PhaseFinder session.', true);
      return;
    }
    apply_session(session);
    await restore_session_files(session);
  } catch (err) {
    app.set_status_bar?.(`Failed to load session: ${err.message}`, true);
  }
}

async function handle_reset() {
  if (!window.confirm('Reset session? This deletes this session\'s cached files and cannot be undone.')) return;
  try {
    const root = await OPFS().get_opfs_root();
    const sessions_dir = await OPFS().ensure_directory(root, ['sessions'], false);
    await sessions_dir.removeEntry(runtime_session_id, { recursive: true });
  } catch (_) { /* nothing cached yet, or OPFS unavailable — non-fatal */ }
  window.location.reload();
}

document.getElementById('save_session_button')?.addEventListener('click', handle_save);
document.getElementById('load_session_button')?.addEventListener('click', handle_load);
document.getElementById('reset_session_button')?.addEventListener('click', handle_reset);

// ── Reconnect modal wiring ───────────────────────────────────────────────────

function finish_reconnect() {
  const remaining = reconnect_ctx?.records.filter((r) => !is_resolved(r)).length || 0;
  close_reconnect_modal();
  window.PhaseFinderApp.set_status_bar?.(
    remaining ? `Continuing without ${remaining} missing file${remaining === 1 ? '' : 's'}.` : 'All session files reconnected.');
}

document.getElementById('reconnect_choose_folder')?.addEventListener('click', () => {
  reconnect_from_directory().catch((err) =>
    window.PhaseFinderApp.set_status_bar?.(`Folder reconnect failed: ${err.message}`, true));
});
document.getElementById('reconnect_select_files')?.addEventListener('click', reconnect_from_files);
document.getElementById('reconnect_continue')?.addEventListener('click', finish_reconnect);
document.getElementById('reconnect_cancel')?.addEventListener('click', close_reconnect_modal);
document.getElementById('reconnect_close')?.addEventListener('click', close_reconnect_modal);
document.querySelector('#reconnect_modal .stats_modal_backdrop')?.addEventListener('click', close_reconnect_modal);

// ── Public APIs ──────────────────────────────────────────────────────────────

// Called by main.js's load_files to cache newly imported files into OPFS.
window.PhaseFinderSessionFiles = { register_loaded_files };

// Exposed so cross-browser e2e tests can drive reconnect without native pickers.
window.PhaseFinderReconnect = {
  is_test_mode,
  get_records: () => [...file_records.values()],
  is_open: () => Boolean(reconnect_ctx),
  reconnect_with_files: (files) => apply_reconnected_files(files),
  open: () => open_reconnect_modal([...file_records.values()]),
  close: close_reconnect_modal,
};

// ── Startup auto-load (phasefinder_local.json) ───────────────────────────────
// If a phasefinder_local.json file exists in the app root, the app fetches it
// on startup and auto-loads the specified session file plus any stored FCS
// directory handle.  The JSON file is never committed — it is personal/local.
//
// Minimal example:
//   { "autoload_session": "sessions/my_experiment.toml" }
//
// The session path is relative to the app root (where index.html lives).

async function try_autoload() {
  let config;
  try {
    const resp = await fetch('./phasefinder_local.json', { cache: 'no-store' });
    if (!resp.ok) return; // file absent — normal, nothing to do
    config = await resp.json();
  } catch (_) {
    return; // fetch or parse failed — silent
  }

  const session_path = config?.autoload_session;
  if (!session_path) return;

  const app = window.PhaseFinderApp;
  try {
    const resp = await fetch(session_path, { cache: 'no-store' });
    if (!resp.ok) {
      app.set_status_bar?.(`Auto-load: could not fetch session file "${session_path}".`, true);
      return;
    }
    const text    = await resp.text();
    const session = parse_session_toml(text);
    if (!session.session?.created) {
      app.set_status_bar?.(`Auto-load: "${session_path}" is not a valid PhaseFinder session.`, true);
      return;
    }

    apply_session(session);

    await restore_session_files(session, { data_directory: config.data_directory });
  } catch (err) {
    app.set_status_bar?.(`Auto-load failed: ${err.message}`, true);
  }
}

// Defer until after the rest of the page scripts have finished initialising.
setTimeout(try_autoload, 0);
