// OPFS working-copy cache, file records, and directory-handle loading. This file
// manages the session file registry, app-private OPFS paths, background copy
// requests, directory-handle persistence, and local-data autoload fallbacks. It
// registers loaded FCS files so saved sessions can later restore them without
// storing OS paths. It can also fetch expected files from a configured data URL
// or ask the user for a directory when OPFS copies are unavailable. Reconnect
// and core session modules build on these records and helpers.

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

const OPFS_COPY_WORKER_URL = './js/session/copy_worker.js';
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
