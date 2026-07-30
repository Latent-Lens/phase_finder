// OPFS working-copy cache, file records, and directory-handle loading. This
// module manages the session file registry, app-private OPFS paths, background
// copy requests (via a module copy worker), directory-handle persistence, and
// local-data autoload fallbacks. It registers loaded FCS files so saved sessions
// can later restore them without storing OS paths. It can also fetch expected
// files from a configured data URL or ask the user for a directory when OPFS
// copies are unavailable. Reconnect and core session modules build on these
// records and helpers.

import { supports_opfs, request_persistent_storage } from "./opfs_fs.js";
import { set_status_bar } from "../ui/status_channels.js";
import { load_files } from "../io/metadata_io.js";

// ── IndexedDB directory handle cache (Chromium — persists across page loads) ─

const IDB_NAME  = 'phasefinder';
const IDB_STORE = 'handles';
const IDB_KEY   = 'fcs_directory';
const CACHE_INDEX_KEY = 'phasefinder_cache_index_v1';
const ACTIVE_LOGICAL_SESSION_KEY = 'phasefinder_active_logical_session_v1';
const AUTO_CACHE_KEY = 'phasefinder_auto_cache_v1';
export const CACHE_INDEX_SCHEMA_VERSION = 1;

function new_session_id(prefix = 'session') {
  return `${prefix}_${new Date().toISOString().slice(0, 10)}_${Math.random().toString(36).slice(2, 10)}`;
}

function storage_get(key) {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}

function storage_set(key, value) {
  try { localStorage.setItem(key, value); return true; } catch (_) { return false; }
}

function storage_remove(key) {
  try { localStorage.removeItem(key); } catch (_) { /* storage unavailable */ }
}

function empty_cache_index() {
  return { schema_version: CACHE_INDEX_SCHEMA_VERSION, entries: {} };
}

export function read_cache_index() {
  try {
    const parsed = JSON.parse(storage_get(CACHE_INDEX_KEY) || 'null');
    if (parsed?.schema_version === CACHE_INDEX_SCHEMA_VERSION && parsed.entries && typeof parsed.entries === 'object') {
      return parsed;
    }
  } catch (_) { /* corrupt/blocked local storage: start with a safe empty index */ }
  return empty_cache_index();
}

function write_cache_index(index) {
  return storage_set(CACHE_INDEX_KEY, JSON.stringify(index));
}

export let logical_session_id = storage_get(ACTIVE_LOGICAL_SESSION_KEY) || new_session_id('logical');
storage_set(ACTIVE_LOGICAL_SESSION_KEY, logical_session_id);

export function set_active_logical_session_id(value) {
  logical_session_id = String(value || new_session_id('logical'));
  storage_set(ACTIVE_LOGICAL_SESSION_KEY, logical_session_id);
  return logical_session_id;
}

export function create_imported_logical_session_id() {
  return new_session_id('imported');
}

export function automatic_cache_enabled() {
  return storage_get(AUTO_CACHE_KEY) !== 'off';
}

export function set_automatic_cache_enabled(enabled) {
  storage_set(AUTO_CACHE_KEY, enabled ? 'on' : 'off');
  return Boolean(enabled);
}

export function catalogue_cached_record(record, owner = logical_session_id) {
  if (!record?.opfs_path) return;
  const index = read_cache_index();
  const now = new Date().toISOString();
  const existing = index.entries[record.opfs_path] || {};
  const owners = new Set(Array.isArray(existing.owners) ? existing.owners : []);
  owners.add(owner);
  index.entries[record.opfs_path] = {
    cache_id: existing.cache_id || record.cache_id || new_session_id('cache'),
    owners: [...owners],
    file_id: record.id,
    path: record.opfs_path,
    size: record.size,
    digest_algorithm: record.digest_algorithm || existing.digest_algorithm || null,
    digest: record.digest || existing.digest || null,
    created_at: existing.created_at || now,
    last_used_at: now,
    schema_version: CACHE_INDEX_SCHEMA_VERSION,
  };
  write_cache_index(index);
}

export function cache_entries_for_session(owner = logical_session_id) {
  return Object.values(read_cache_index().entries)
    .filter((entry) => Array.isArray(entry.owners) && entry.owners.includes(owner));
}

function open_idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

export async function idb_put(value) {
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

export async function idb_get() {
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

export async function idb_clear() {
  try {
    const db = await open_idb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch (_) { return false; }
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
export function pick_dir_fallback(names) {
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

// Same picker, but returns every file in the folder (unfiltered) plus the
// folder's own name — used by the reconnect modal's scan-progress UI, which
// needs the full listing to report "N of the folder's FCS files scanned".
export function pick_dir_fallback_all() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.onchange = () => {
      const files = [...input.files];
      const dir_name = files[0]?.webkitRelativePath?.split('/')[0] || '';
      resolve({ dir_name, files });
    };
    input.click();
  });
}

// Fetch FCS files directly from an HTTP base URL — no picker required.
export async function fetch_files_from_url(base_url, names) {
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
export async function auto_load_session_files(names) {
  if (!names?.length) return;

  set_status_bar('Select the folder containing your FCS files…');

  let files;
  try {
    files = typeof window.showDirectoryPicker === 'function'
      ? await pick_dir_chromium(names)
      : await pick_dir_fallback(names);
  } catch (err) {
    set_status_bar(`Could not open FCS directory: ${err.message}`, true);
    return;
  }

  if (files === null) {
    // User cancelled the directory picker.
    set_status_bar('Directory selection cancelled. Drop FCS files manually to restore event data.');
    return;
  }

  if (!files.length) {
    set_status_bar('None of the session\'s FCS files were found in the selected folder.', true);
    return;
  }

  const missing = names.filter((n) => !files.some((f) => f.name === n));
  await load_files(files);

  if (missing.length) {
    set_status_bar(
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

export function is_test_mode() {
  try { return new URLSearchParams(location.search).has('test'); }
  catch (_) { return false; }
}

export function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

export function human_size(bytes) {
  if (bytes == null) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${i === 0 ? n : n.toFixed(n >= 10 ? 0 : 1)} ${units[i]}`;
}

// Stable per-page-load id used for the OPFS paths of newly imported files.
export const runtime_session_id = new_session_id();

// original_name → record. Pre-populated from a loaded session, appended on import.
export const file_records = new Map();
let persistent_requested = false;
export const is_resolved = (r) => r.status === 'available' || r.status === 'uncached';

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

export function build_file_records_for(names) {
  return names.map((name) => file_records.get(name)).filter(Boolean);
}

export function fresh_reconnect_opfs_path(record) {
  const safe_id = String(record?.id || new_session_id('file')).replace(/[^A-Za-z0-9._-]/g, '_');
  return `sessions/${runtime_session_id}/files/${safe_id}.fcs`;
}

// Replace the registry with records parsed from a loaded session file. Status is
// reset to "missing" — it is re-derived by verifying each OPFS copy on reload.
export function set_records_from_session(records, owner = logical_session_id, { catalogue = true } = {}) {
  file_records.clear();
  (records || []).forEach((r) => {
    if (r && r.original_name) {
      file_records.set(r.original_name, { ...r, status: 'missing' });
      if (catalogue) catalogue_cached_record(r, owner);
    }
  });
}

export async function release_session_cache(owner, delete_path) {
  const index = read_cache_index();
  const results = [];
  for (const [path, entry] of Object.entries(index.entries)) {
    if (!Array.isArray(entry.owners) || !entry.owners.includes(owner)) continue;
    const remaining = entry.owners.filter((id) => id !== owner);
    let removed = false;
    if (!remaining.length) removed = await delete_path(path);
    if (remaining.length) entry.owners = remaining;
    else if (removed) delete index.entries[path];
    else {
      entry.owners = [];
      entry.cleanup_failed_at = new Date().toISOString();
    }
    results.push({ path, shared: remaining.length > 0, removed });
  }
  write_cache_index(index);
  return results;
}

export async function release_cache_path(path, owner, delete_path) {
  const index = read_cache_index();
  const entry = index.entries[path];
  if (!entry || !entry.owners?.includes(owner)) return { path, shared: false, removed: false };
  const remaining = entry.owners.filter((id) => id !== owner);
  const removed = remaining.length ? false : await delete_path(path);
  if (remaining.length) entry.owners = remaining;
  else if (removed) delete index.entries[path];
  else {
    entry.owners = [];
    entry.cleanup_failed_at = new Date().toISOString();
  }
  write_cache_index(index);
  return { path, shared: remaining.length > 0, removed };
}

export async function release_orphaned_cache(delete_path) {
  const index = read_cache_index();
  const results = [];
  for (const [path, entry] of Object.entries(index.entries)) {
    if (Array.isArray(entry.owners) && entry.owners.length) continue;
    const removed = await delete_path(path);
    if (removed) delete index.entries[path];
    results.push({ path, removed });
  }
  write_cache_index(index);
  return results;
}

export async function clear_all_local_records() {
  await idb_clear();
  storage_remove(CACHE_INDEX_KEY);
  storage_remove(ACTIVE_LOGICAL_SESSION_KEY);
  storage_remove(AUTO_CACHE_KEY);
  return set_active_logical_session_id(null);
}

// ── OPFS copy worker driver (background, off the main thread) ────────────────

let opfs_copy_worker = null;
let opfs_copy_worker_request_id = 0;
let opfs_copy_worker_unavailable = false;
const opfs_copy_worker_requests = new Map();

function get_opfs_copy_worker() {
  if (opfs_copy_worker_unavailable || typeof Worker === 'undefined') return null;
  if (opfs_copy_worker) return opfs_copy_worker;
  try {
    // Inline `new URL(...)` -- see fit_client.js: a hoisted constant is not
    // recognised as a worker entry point by the bundler.
    opfs_copy_worker = new Worker(new URL('./copy_worker.js', import.meta.url), { type: 'module' });
    opfs_copy_worker.addEventListener('message', (event) => {
      const { request_id, ok, error, progress, digest_algorithm, digest } = event.data || {};
      const req = opfs_copy_worker_requests.get(request_id);
      if (!req) return;
      if (progress) { req.on_progress?.(progress); return; }
      opfs_copy_worker_requests.delete(request_id);
      req.cleanup?.();
      if (ok) req.resolve({ digest_algorithm, digest }); else req.reject(new Error(error || 'OPFS copy failed'));
    });
    opfs_copy_worker.addEventListener('error', () => {
      opfs_copy_worker_unavailable = true;
      opfs_copy_worker_requests.forEach((req) => {
        req.cleanup?.();
        req.reject(new Error('OPFS copy worker error'));
      });
      opfs_copy_worker_requests.clear();
      if (opfs_copy_worker) { opfs_copy_worker.terminate(); opfs_copy_worker = null; }
    });
  } catch (_) {
    opfs_copy_worker_unavailable = true;
    opfs_copy_worker = null;
  }
  return opfs_copy_worker;
}

export function copy_file_to_opfs(file, opfs_path, options = {}) {
  return new Promise((resolve, reject) => {
    const worker = get_opfs_copy_worker();
    if (!worker) { reject(new Error('OPFS copy worker unavailable')); return; }
    const request_id = ++opfs_copy_worker_request_id;
    const abort = () => worker.postMessage({ request_id, cancel: true });
    if (options.signal?.aborted) { reject(new DOMException('File copy was cancelled.', 'AbortError')); return; }
    options.signal?.addEventListener('abort', abort, { once: true });
    opfs_copy_worker_requests.set(request_id, {
      resolve, reject, on_progress: options.on_progress,
      cleanup: () => options.signal?.removeEventListener('abort', abort),
    });
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
let cache_failed = 0;
const cache_idle_waiters = [];

export function wait_for_cache_idle() {
  if (!cache_running && !cache_queue.length) return Promise.resolve();
  return new Promise((resolve) => cache_idle_waiters.push(resolve));
}

function enqueue_opfs_cache(items) {
  if (!persistent_requested) {
    persistent_requested = true;
    request_persistent_storage();
  }
  cache_queue.push(...items);
  cache_total += items.length;
  if (!cache_running) run_cache_queue();
}

async function run_cache_queue() {
  cache_running = true;
  while (cache_queue.length) {
    const { record, file } = cache_queue.shift();
    const pct = Math.round((cache_done / cache_total) * 100);
    set_status_bar(`Caching file ${cache_done + 1} of ${cache_total} (${pct}%) for fast reload: ${file.name}`);
    try {
      const identity = await copy_file_to_opfs(file, record.opfs_path, {
        on_progress: ({ bytes_done, bytes_total }) => {
          const within = bytes_total ? bytes_done / bytes_total : 1;
          const pct = Math.round(((cache_done + within) / cache_total) * 100);
          set_status_bar(`Caching file ${cache_done + 1} of ${cache_total} (${pct}%) for fast reload: ${file.name}`);
        },
      });
      Object.assign(record, identity);
      record.status = 'available';
      catalogue_cached_record(record);
    } catch (_) {
      record.status = 'error';
      cache_failed += 1;
    }
    cache_done += 1;
  }
  set_status_bar(cache_failed
    ? `Could not cache ${cache_failed} of ${cache_done} file${cache_done === 1 ? '' : 's'} (storage may be full or unavailable). Analysis remains available; review Storage settings.`
    : `Cached ${cache_done} file${cache_done === 1 ? '' : 's'} for fast reload.`, cache_failed > 0);
  cache_running = false;
  cache_total = 0;
  cache_done = 0;
  cache_failed = 0;
  cache_idle_waiters.splice(0).forEach((resolve) => resolve());
}

// Called by metadata_io's load_files after files load: builds records for
// genuinely new files and queues their background OPFS copy. Files already in the
// registry (restored from a session or just reconnected) are skipped — they are
// already cached.
export function register_loaded_files(entries) {
  const fresh = [];
  for (const entry of entries || []) {
    if (!entry || !entry.file) continue;
    if (file_records.has(entry.file.name)) continue;
    const record = make_file_record(entry);
    record.status = supports_opfs() && automatic_cache_enabled() ? 'copying' : 'uncached';
    file_records.set(entry.file.name, record);
    if (record.status === 'copying') fresh.push({ record, file: entry.file });
  }
  if (fresh.length) enqueue_opfs_cache(fresh);
}
