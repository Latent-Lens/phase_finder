// OPFS restore, manual reconnect matching, and reconnect modal behavior. This
// file attempts to recover saved-session FCS files from cached OPFS copies and
// marks each record as available, missing, or mismatched. When cached files are
// unavailable, it matches manually selected files to expected session records by
// filename, size, and last-modified metadata. It renders the reconnect modal and
// handles file-by-file or folder-style reconnect flows. Session core calls this
// during restore and after users pick replacement files.

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
