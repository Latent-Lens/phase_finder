// ---------------------------------------------------------------------------
// Session save / load — serializes and restores app state to/from a TOML file.
// ---------------------------------------------------------------------------

(function () {
  'use strict';

  // ── TOML serializer ─────────────────────────────────────────────────────────

  function toml_str(v) {
    return '"' + String(v)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t') + '"';
  }

  function serialize_session(s) {
    const L = [];
    const p = (...x) => L.push(...x);

    p('# PhaseFinder Session File', `# Created: ${s.session.created}`, '');

    p('[session]', `created = ${toml_str(s.session.created)}`, '');

    p('[files]', '# Re-drop or auto-load these files to restore event data and plotted curves.');
    p(`names = [${s.files.names.map(toml_str).join(', ')}]`, '');

    // Per-file records: metadata + OPFS working-copy paths used to auto-restore
    // files on reload (see the OPFS section below). No absolute OS paths.
    (s.files.records || []).forEach((r) => {
      p('[[files.records]]',
        `id = ${toml_str(r.id)}`,
        `original_name = ${toml_str(r.original_name)}`,
        `relative_path = ${toml_str(r.relative_path)}`,
        `size = ${r.size}`,
        `last_modified = ${r.last_modified}`,
        `mime_type = ${toml_str(r.mime_type || 'application/octet-stream')}`,
        `opfs_path = ${toml_str(r.opfs_path)}`,
        `status = ${toml_str(r.status || 'available')}`,
        '');
    });

    p('[metadata]');
    if (s.metadata.columns.length) {
      p('columns = [');
      s.metadata.columns.forEach((c, i) => {
        const comma = i < s.metadata.columns.length - 1 ? ',' : '';
        const extras = [];
        if (c.headerEditable != null) extras.push(`header_editable = ${Boolean(c.headerEditable)}`);
        if (c.source) extras.push(`source = ${toml_str(c.source)}`);
        p(`  {field = ${toml_str(c.field)}, label = ${toml_str(c.label)}${extras.length ? ', ' + extras.join(', ') : ''}}${comma}`);
      });
      p(']');
    } else {
      p('columns = []');
    }
    p('');
    s.metadata.rows.forEach((row) => {
      p('[[metadata.rows]]', `name = ${toml_str(row.name)}`);
      s.metadata.columns.forEach((c) => { p(`${c.field} = ${toml_str(row[c.field] ?? '')}`); });
      p('');
    });

    if (s.metadata_template?.steps?.length) {
      s.metadata_template.steps.forEach((step) => {
        p('[[metadata_template.steps]]', `type = ${toml_str(step.type)}`);
        if (step.type === 'delimiter') p(`delimiter = ${toml_str(step.delimiter ?? '_')}`);
        if (step.type === 'fixed')     p(`breaks = [${(step.breaks || []).join(', ')}]`);
        if (step.type === 'regex')     p(`pattern = ${toml_str(step.pattern ?? '')}`);
        if (step.label != null)        p(`label = ${toml_str(step.label)}`);
        if (step.hide != null)         p(`hide = ${Boolean(step.hide)}`);
        p('');
      });
    }
    if (s.metadata_template?.columns?.length) {
      s.metadata_template.columns.forEach((c) => {
        p('[[metadata_template.columns]]',
          `field = ${toml_str(c.field)}`,
          `label = ${toml_str(c.label)}`,
          `source_index = ${c.source_index}`,
          '');
      });
    }

    p('[table]');
    p(`selected_files = [${s.table.selected_files.map(toml_str).join(', ')}]`);
    p(`sort_field = ${toml_str(s.table.sort_field || '')}`);
    p(`sort_direction = ${toml_str(s.table.sort_direction || 'asc')}`);
    p('');

    p('[table.filters]');
    for (const [field, values] of Object.entries(s.table.filters)) {
      p(`${field} = [${values.map(toml_str).join(', ')}]`);
    }
    p('');

    p('[plot]',
      `channel = ${toml_str(s.plot.channel)}`,
      `color_by = ${toml_str(s.plot.color_by)}`,
      `bins = ${s.plot.bins}`,
      `remove_debris = ${s.plot.remove_debris}`,
      `remove_doublets = ${s.plot.remove_doublets}`,
      `show_peak_threshold = ${s.plot.show_peak_threshold}`,
      '');

    p('[ui]',
      `sidebar_collapsed = ${s.ui.sidebar_collapsed}`,
      `sidebar_width_px = ${s.ui.sidebar_width_px}`,
      `plot_panel_collapsed = ${s.ui.plot_panel_collapsed}`,
      `plot_panel_height_px = ${s.ui.plot_panel_height_px}`,
      `metadata_panel_collapsed = ${s.ui.metadata_panel_collapsed}`,
      `metadata_panel_height_px = ${s.ui.metadata_panel_height_px}`);

    if (s.stats_plan?.length) {
      p('');
      s.stats_plan.forEach((entry) => {
        p('[[stats_plan.entries]]',
          `channel = ${toml_str(entry.channel)}`,
          `metrics = [${entry.metrics.map(toml_str).join(', ')}]`,
          '');
      });
    }

    return L.join('\n');
  }

  // ── TOML parser ──────────────────────────────────────────────────────────────

  // Split comma-separated list, respecting quoted strings and {}/[] nesting.
  function split_csv(str) {
    const items = [];
    let depth = 0, in_str = false, start = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === '"' && str[i - 1] !== '\\') in_str = !in_str;
      if (!in_str) {
        if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') depth--;
        else if (ch === ',' && depth === 0) {
          items.push(str.slice(start, i).trim());
          start = i + 1;
        }
      }
    }
    const last = str.slice(start).trim().replace(/,$/, '');
    if (last) items.push(last);
    return items.filter(Boolean);
  }

  function parse_toml_value(str) {
    str = str.trim().replace(/\s*#[^"]*$/, '');
    if (str.startsWith('"')) { try { return JSON.parse(str); } catch (_) { return str; } }
    if (str === 'true')  return true;
    if (str === 'false') return false;
    if (str.startsWith('[') && str.endsWith(']')) {
      const inner = str.slice(1, -1).trim();
      if (!inner) return [];
      return split_csv(inner).map((item) => {
        const t = item.trim();
        return t.startsWith('{') ? parse_inline_table(t) : parse_toml_value(t);
      });
    }
    const n = Number(str);
    return (!isNaN(n) && str !== '') ? n : str;
  }

  function parse_inline_table(str) {
    const inner = str.slice(1, -1).trim();
    const obj = {};
    for (const pair of split_csv(inner)) {
      const eq = pair.indexOf(' = ');
      if (eq < 0) continue;
      obj[pair.slice(0, eq).trim()] = parse_toml_value(pair.slice(eq + 3));
    }
    return obj;
  }

  function get_path(obj, path) {
    let node = obj;
    for (const p of path) { if (!node[p]) return null; node = node[p]; }
    return node;
  }

  function parse_session_toml(text) {
    const result = {};
    let section_path = [];
    let arr_obj = null;
    const lines = text.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i++].trim();
      if (!line || line.startsWith('#')) continue;

      if (line.startsWith('[[') && line.endsWith(']]')) {
        const path = line.slice(2, -2).trim().split('.');
        section_path = [];
        arr_obj = {};
        let node = result;
        for (let j = 0; j < path.length - 1; j++) {
          if (!node[path[j]]) node[path[j]] = {};
          node = node[path[j]];
        }
        const last = path[path.length - 1];
        if (!Array.isArray(node[last])) node[last] = [];
        node[last].push(arr_obj);
        continue;
      }

      if (line.startsWith('[') && line.endsWith(']')) {
        section_path = line.slice(1, -1).trim().split('.');
        arr_obj = null;
        let node = result;
        for (const p of section_path) { if (!node[p]) node[p] = {}; node = node[p]; }
        continue;
      }

      const eq = line.indexOf(' = ');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val_str = line.slice(eq + 3).trim();

      // Collect multi-line arrays.
      if (val_str.startsWith('[') && !val_str.endsWith(']')) {
        let depth = 0;
        const parts = [val_str];
        for (const ch of val_str) depth += (ch === '[') - (ch === ']');
        while (depth > 0 && i < lines.length) {
          const next = lines[i++].trim();
          if (!next || next.startsWith('#')) continue;
          parts.push(next);
          for (const ch of next) depth += (ch === '[') - (ch === ']');
        }
        val_str = parts.join(' ');
      }

      const target = arr_obj || get_path(result, section_path);
      if (target) target[key] = parse_toml_value(val_str);
    }
    return result;
  }

  // ── IndexedDB directory handle cache (Chromium — persists across page loads) ─

  const IDB_NAME  = 'phasefinder';
  const IDB_STORE = 'handles';
  const IDB_KEY   = 'fcs_directory';

  function open_idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  async function idb_put(value) {
    try {
      const db = await open_idb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(value, IDB_KEY);
        tx.oncomplete = resolve;
        tx.onerror    = () => reject(tx.error);
      });
    } catch (_) { /* storage unavailable — non-fatal */ }
  }

  async function idb_get() {
    try {
      const db = await open_idb();
      return await new Promise((resolve, reject) => {
        const tx  = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror   = () => reject(req.error);
      });
    } catch (_) { return null; }
  }

  // ── FCS file loading from a directory handle ─────────────────────────────────

  // Reads named files from a FileSystemDirectoryHandle, skipping any not found.
  async function files_from_dir_handle(dir_handle, names) {
    const found = [];
    for (const name of names) {
      try {
        const fh   = await dir_handle.getFileHandle(name);
        const file = await fh.getFile();
        found.push(file);
      } catch (_) { /* file absent in this directory */ }
    }
    return found;
  }

  // Chromium: try the stored handle first (just needs a permission re-grant),
  // then fall back to showDirectoryPicker and store the new handle.
  async function pick_dir_chromium(names) {
    const stored = await idb_get();
    if (stored) {
      let perm = await stored.queryPermission({ mode: 'read' });
      if (perm === 'prompt') perm = await stored.requestPermission({ mode: 'read' });
      if (perm === 'granted') return files_from_dir_handle(stored, names);
    }

    let handle;
    try {
      handle = await window.showDirectoryPicker({ mode: 'read' });
    } catch (err) {
      if (err.name === 'AbortError') return null;
      throw err;
    }
    await idb_put(handle);
    return files_from_dir_handle(handle, names);
  }

  // Firefox / Safari: <input webkitdirectory> gives a native directory picker
  // in both browsers; filter results by expected filenames.
  function pick_dir_fallback(names) {
    const name_set = new Set(names);
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.webkitdirectory = true;
      // oncancel fires in modern browsers when the dialog is dismissed.
      input.addEventListener('cancel', () => resolve(null), { once: true });
      input.onchange = () => {
        resolve([...input.files].filter((f) => name_set.has(f.name)));
      };
      input.click();
    });
  }

  // Fetch FCS files directly from an HTTP base URL — no picker required.
  async function fetch_files_from_url(base_url, names) {
    const base = base_url.replace(/\/$/, '');
    const results = await Promise.allSettled(
      names.map(async (name) => {
        const resp = await fetch(`${base}/${encodeURIComponent(name)}`, { cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        return new File([blob], name, { type: blob.type || 'application/octet-stream' });
      })
    );
    const files = [], missing = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') files.push(r.value);
      else missing.push(names[i]);
    });
    return { files, missing };
  }

  // Entry point: route to the right picker, then pass found files to load_files.
  async function auto_load_session_files(names) {
    if (!names?.length) return;
    const app = window.PhaseFinderApp;

    app.set_status_bar?.('Select the folder containing your FCS files…');

    let files;
    try {
      files = typeof window.showDirectoryPicker === 'function'
        ? await pick_dir_chromium(names)
        : await pick_dir_fallback(names);
    } catch (err) {
      app.set_status_bar?.(`Could not open FCS directory: ${err.message}`, true);
      return;
    }

    if (files === null) {
      // User cancelled the directory picker.
      app.set_status_bar?.('Directory selection cancelled. Drop FCS files manually to restore event data.');
      return;
    }

    if (!files.length) {
      app.set_status_bar?.('None of the session\'s FCS files were found in the selected folder.', true);
      return;
    }

    const missing = names.filter((n) => !files.some((f) => f.name === n));
    await load_files(files);

    if (missing.length) {
      app.set_status_bar?.(
        `Loaded ${files.length} file${files.length === 1 ? '' : 's'}. ` +
        `Not found in folder: ${missing.join(', ')}`,
        true,
      );
    }
  }

  // ── OPFS working-copy cache + per-file records ───────────────────────────────
  // Loaded FCS files are copied into OPFS in the background so a saved session can
  // auto-restore them on reload without a picker. Each record carries the metadata
  // needed to reconnect a file manually if its OPFS copy is ever missing.

  const OPFS = () => window.PhaseFinderOPFS;

  function is_test_mode() {
    try { return new URLSearchParams(location.search).has('test'); }
    catch (_) { return false; }
  }

  function esc(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  function human_size(bytes) {
    if (bytes == null) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let n = bytes, i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${i === 0 ? n : n.toFixed(n >= 10 ? 0 : 1)} ${units[i]}`;
  }

  // Stable per-page-load id used for the OPFS paths of newly imported files.
  const runtime_session_id =
    `session_${new Date().toISOString().slice(0, 10)}_${Math.random().toString(36).slice(2, 8)}`;

  // original_name → record. Pre-populated from a loaded session, appended on import.
  const file_records = new Map();
  let persistent_requested = false;
  let is_resolved = (r) => r.status === 'available' || r.status === 'uncached';

  function make_file_record(entry) {
    const file = entry.file;
    const relative_path = (file.webkitRelativePath && file.webkitRelativePath.length)
      ? file.webkitRelativePath : file.name;
    return {
      id: entry.id,
      original_name: file.name,
      relative_path,
      size: file.size,
      last_modified: file.lastModified,
      mime_type: file.type || 'application/octet-stream',
      opfs_path: `sessions/${runtime_session_id}/files/${entry.id}.fcs`,
      status: 'available',
    };
  }

  function build_file_records_for(names) {
    return names.map((name) => file_records.get(name)).filter(Boolean);
  }

  // Replace the registry with records parsed from a loaded session file. Status is
  // reset to "missing" — it is re-derived by verifying each OPFS copy on reload.
  function set_records_from_session(records) {
    file_records.clear();
    (records || []).forEach((r) => {
      if (r && r.original_name) file_records.set(r.original_name, { ...r, status: 'missing' });
    });
  }

  // ── OPFS copy worker driver (background, off the main thread) ────────────────

  const OPFS_COPY_WORKER_URL = './js/opfs_copy_worker.js';
  let opfs_copy_worker = null;
  let opfs_copy_worker_request_id = 0;
  let opfs_copy_worker_unavailable = false;
  const opfs_copy_worker_requests = new Map();

  function get_opfs_copy_worker() {
    if (opfs_copy_worker_unavailable || typeof Worker === 'undefined') return null;
    if (opfs_copy_worker) return opfs_copy_worker;
    try {
      opfs_copy_worker = new Worker(OPFS_COPY_WORKER_URL);
      opfs_copy_worker.addEventListener('message', (event) => {
        const { request_id, ok, error } = event.data || {};
        const req = opfs_copy_worker_requests.get(request_id);
        if (!req) return;
        opfs_copy_worker_requests.delete(request_id);
        if (ok) req.resolve(); else req.reject(new Error(error || 'OPFS copy failed'));
      });
      opfs_copy_worker.addEventListener('error', () => {
        opfs_copy_worker_unavailable = true;
        opfs_copy_worker_requests.forEach((req) => req.reject(new Error('OPFS copy worker error')));
        opfs_copy_worker_requests.clear();
        if (opfs_copy_worker) { opfs_copy_worker.terminate(); opfs_copy_worker = null; }
      });
    } catch (_) {
      opfs_copy_worker_unavailable = true;
      opfs_copy_worker = null;
    }
    return opfs_copy_worker;
  }

  function copy_file_to_opfs(file, opfs_path) {
    return new Promise((resolve, reject) => {
      const worker = get_opfs_copy_worker();
      if (!worker) { reject(new Error('OPFS copy worker unavailable')); return; }
      const request_id = ++opfs_copy_worker_request_id;
      opfs_copy_worker_requests.set(request_id, { resolve, reject });
      try {
        worker.postMessage({ request_id, file, opfs_path });
      } catch (err) {
        opfs_copy_worker_requests.delete(request_id);
        reject(err);
      }
    });
  }

  // ── Background cache queue (status-bar "Caching file x of y") ─────────────────

  const cache_queue = [];
  let cache_running = false;
  let cache_total = 0;
  let cache_done = 0;

  function enqueue_opfs_cache(items) {
    if (!persistent_requested) {
      persistent_requested = true;
      OPFS()?.request_persistent_storage?.();
    }
    cache_queue.push(...items);
    cache_total += items.length;
    if (!cache_running) run_cache_queue();
  }

  async function run_cache_queue() {
    cache_running = true;
    const app = window.PhaseFinderApp;
    while (cache_queue.length) {
      const { record, file } = cache_queue.shift();
      const pct = Math.round((cache_done / cache_total) * 100);
      app.set_status_bar?.(`Caching file ${cache_done + 1} of ${cache_total} (${pct}%) for fast reload: ${file.name}`);
      try {
        await copy_file_to_opfs(file, record.opfs_path);
        record.status = 'available';
      } catch (_) {
        record.status = 'error';
      }
      cache_done += 1;
    }
    app.set_status_bar?.(`Cached ${cache_done} file${cache_done === 1 ? '' : 's'} for fast reload.`);
    cache_running = false;
    cache_total = 0;
    cache_done = 0;
  }

  // Called by main.js after files load: builds records for genuinely new files and
  // queues their background OPFS copy. Files already in the registry (restored from
  // a session or just reconnected) are skipped — they are already cached.
  function register_loaded_files(entries) {
    const fresh = [];
    for (const entry of entries || []) {
      if (!entry || !entry.file) continue;
      if (file_records.has(entry.file.name)) continue;
      const record = make_file_record(entry);
      record.status = OPFS()?.supports_opfs() ? 'copying' : 'uncached';
      file_records.set(entry.file.name, record);
      if (record.status === 'copying') fresh.push({ record, file: entry.file });
    }
    if (fresh.length) enqueue_opfs_cache(fresh);
  }

  // ── OPFS restore + reconnect matching ────────────────────────────────────────

  // Reads each record's OPFS copy, rewrapping it as a File with the original name
  // and metadata (OPFS stores it under an id-based filename). Buckets results.
  async function try_load_from_opfs(records) {
    const found = [], missing = [], mismatch = [];
    if (!OPFS()?.supports_opfs()) return { found, missing: records.slice(), mismatch };
    for (const record of records) {
      try {
        const raw = await OPFS().read_file_from_opfs(record.opfs_path);
        const file = new File([raw], record.original_name, {
          type: record.mime_type || 'application/octet-stream',
          lastModified: record.last_modified,
        });
        if (record.size != null && file.size !== record.size) {
          record.status = 'mismatch';
          mismatch.push({ record, file });
        } else {
          record.status = 'available';
          found.push({ record, file });
        }
      } catch (_) {
        record.status = 'missing';
        missing.push(record);
      }
    }
    return { found, missing, mismatch };
  }

  function index_selected_files(files) {
    const by_name_size_lastmod = new Map();
    const by_name_size = new Map();
    for (const file of files) {
      by_name_size_lastmod.set(`${file.name}::${file.size}::${file.lastModified}`, file);
      const key = `${file.name}::${file.size}`;
      if (!by_name_size.has(key)) by_name_size.set(key, []);
      by_name_size.get(key).push(file);
    }
    return { by_name_size_lastmod, by_name_size };
  }

  function match_record_to_selected_file(record, indexes) {
    const exact = indexes.by_name_size_lastmod.get(
      `${record.original_name}::${record.size}::${record.last_modified}`);
    if (exact) return exact;
    const candidates = indexes.by_name_size.get(`${record.original_name}::${record.size}`) || [];
    return candidates.length === 1 ? candidates[0] : null;
  }

  function is_acceptable_match(record, file) {
    if (record.size != null && file.size !== record.size) return false;
    return file.name === record.original_name
      || Boolean(record.relative_path && record.relative_path.endsWith(file.name));
  }

  // ── Reconnect modal ──────────────────────────────────────────────────────────

  let reconnect_ctx = null;

  function render_reconnect_list() {
    const list = document.getElementById('reconnect_file_list');
    if (!list || !reconnect_ctx) return;
    list.innerHTML = reconnect_ctx.records.map((r) => {
      const status = r.status || 'missing';
      const when = r.last_modified ? new Date(r.last_modified).toLocaleDateString() : '';
      const meta = [human_size(r.size), when].filter(Boolean).join(' · ');
      return `<li class="reconnect_row reconnect_row__${esc(status)}">
        <span class="reconnect_status_pill">${esc(status)}</span>
        <span class="reconnect_row_main">
          <span class="reconnect_row_name">${esc(r.relative_path || r.original_name)}</span>
          <span class="reconnect_row_meta">${esc(meta)}</span>
        </span></li>`;
    }).join('');

    const outstanding = reconnect_ctx.records.filter((r) => !is_resolved(r)).length;
    const intro = document.getElementById('reconnect_intro');
    if (intro) {
      intro.textContent = outstanding
        ? `This session needs ${outstanding} file${outstanding === 1 ? '' : 's'}. Choose the folder that contains them, or select the missing files manually.`
        : 'All session files are reconnected.';
    }
  }

  function open_reconnect_modal(records) {
    reconnect_ctx = { records };
    render_reconnect_list();
    const modal = document.getElementById('reconnect_modal');
    if (modal) modal.hidden = false;
  }

  function close_reconnect_modal() {
    const modal = document.getElementById('reconnect_modal');
    if (modal) modal.hidden = true;
    reconnect_ctx = null;
  }

  // Matches provided files against still-missing records, caches + loads matches.
  async function apply_reconnected_files(files) {
    if (!reconnect_ctx) return;
    const app = window.PhaseFinderApp;
    const indexes = index_selected_files(Array.from(files || []));
    const to_load = [];
    for (const record of reconnect_ctx.records) {
      if (is_resolved(record)) continue;
      const file = match_record_to_selected_file(record, indexes);
      if (!file) continue;
      try { await copy_file_to_opfs(file, record.opfs_path); record.status = 'available'; }
      catch (_) { record.status = 'uncached'; } // usable now, just not cached
      to_load.push(file);
    }
    if (to_load.length) await load_files(to_load);
    render_reconnect_list();
    const remaining = reconnect_ctx.records.filter((r) => !is_resolved(r)).length;
    app.set_status_bar?.(
      to_load.length
        ? `Reconnected ${to_load.length} file${to_load.length === 1 ? '' : 's'}.${remaining ? ` ${remaining} still missing.` : ''}`
        : 'No matching files found in your selection.',
      !to_load.length,
    );
  }

  // Folder reconnect. Native directory picker is Chromium-only and can't be
  // automated, so test mode (and non-Chromium browsers) use a webkitdirectory input.
  async function reconnect_from_directory() {
    if (!reconnect_ctx) return;
    const missing = reconnect_ctx.records.filter((r) => !is_resolved(r));
    if (!missing.length) return;

    if (typeof window.showDirectoryPicker === 'function' && !is_test_mode()) {
      let dir_handle;
      const stored = await idb_get();
      if (stored) {
        let perm = await stored.queryPermission({ mode: 'read' });
        if (perm === 'prompt') perm = await stored.requestPermission({ mode: 'read' });
        if (perm === 'granted') dir_handle = stored;
      }
      if (!dir_handle) {
        try { dir_handle = await window.showDirectoryPicker({ mode: 'read' }); }
        catch (err) { if (err.name === 'AbortError') return; throw err; }
        await idb_put(dir_handle);
      }
      const found = [];
      for (const record of missing) {
        let file = null;
        try {
          file = await (await getFileHandleByRelativePath(dir_handle, record.relative_path)).getFile();
        } catch (_) {
          try { file = await (await dir_handle.getFileHandle(record.original_name)).getFile(); }
          catch (_) { file = null; }
        }
        if (file && is_acceptable_match(record, file)) found.push(file);
      }
      await apply_reconnected_files(found);
    } else {
      const files = await pick_dir_fallback(reconnect_ctx.records.map((r) => r.original_name));
      if (files === null) return; // cancelled
      await apply_reconnected_files(files);
    }
  }

  function reconnect_from_files() {
    const input = document.getElementById('reconnect_file_input');
    if (!input) return;
    input.value = '';
    input.onchange = async () => {
      const files = Array.from(input.files || []);
      if (files.length) await apply_reconnected_files(files);
    };
    input.click();
  }

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
    const bins_el    = document.getElementById('plot_bins');
    const debris_el  = document.getElementById('plot_debris_correction');
    const doublet_el = document.getElementById('plot_doublet_correction');
    const thresh_el  = document.getElementById('plot_threshold_toggle');
    const ch_sel     = document.getElementById('channel_select');
    const col_ch_sel = document.getElementById('collapsed_channel_select');

    if (color_by && plot.color_by)     color_by.value   = plot.color_by;
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
})();
