// OPFS restore, manual reconnect matching, and reconnect modal behavior. This
// module attempts to recover saved-session FCS files from cached OPFS copies and
// marks each record as available, missing, or mismatched. When cached files are
// unavailable, it matches manually selected files to expected session records by
// filename, size, and last-modified metadata. It renders the reconnect modal and
// handles file-by-file or folder-style reconnect flows. Session core calls this
// during restore and after users pick replacement files.

import { supports_opfs, read_file_from_opfs } from "./opfs_fs.js";
import {
  is_resolved,
  human_size,
  esc,
  is_test_mode,
  idb_get,
  idb_put,
  pick_dir_fallback_all,
  copy_file_to_opfs,
} from "./file_cache.js";
import { set_status_bar, next_frame } from "../ui/status_channels.js";
import { load_files } from "../io/metadata_io.js";

// ── OPFS restore + reconnect matching ────────────────────────────────────────

// Reads each record's OPFS copy, rewrapping it as a File with the original name
// and metadata (OPFS stores it under an id-based filename). Buckets results.
export async function try_load_from_opfs(records) {
  const found = [], missing = [], mismatch = [];
  if (!supports_opfs()) return { found, missing: records.slice(), mismatch };
  for (const record of records) {
    try {
      const raw = await read_file_from_opfs(record.opfs_path);
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

// ── Folder scan progress panel ───────────────────────────────────────────────
// Slides open below the file list while "Choose folder" walks the selected
// directory, expanding the modal in place. Browsers never expose a folder's
// full OS path to a page (Chromium's showDirectoryPicker and the
// webkitdirectory fallback both withhold it), so only the folder's own name
// is shown here.

function open_scan_panel(dir_name, total, missing_total) {
  const panel      = document.getElementById('reconnect_scan_panel');
  const dirname_el = document.getElementById('reconnect_scan_dirname');
  if (dirname_el) dirname_el.textContent = dir_name || '(selected folder)';
  update_scan_progress(0, total, 0, missing_total);
  if (panel) panel.classList.add('is_open');
  set_picker_buttons_disabled(true);
}

function update_scan_progress(checked, total, found_count, missing_total, done = false) {
  const status_el = document.getElementById('reconnect_scan_status');
  const fill_el    = document.getElementById('reconnect_scan_fill');
  const tally_el   = document.getElementById('reconnect_scan_tally');
  if (status_el) {
    status_el.textContent = done
      ? `Scan complete — checked ${total} FCS file${total === 1 ? '' : 's'} in the selected folder.`
      : `Scanning the selected folder containing ${total} FCS file${total === 1 ? '' : 's'} ` +
        `for the ${missing_total} missing file${missing_total === 1 ? '' : 's'}`;
  }
  if (fill_el) fill_el.style.width = `${total ? (checked / total) * 100 : 0}%`;
  if (tally_el) {
    tally_el.textContent = `Found ${found_count} of ${missing_total} missing file${missing_total === 1 ? '' : 's'}`;
  }
}

function close_scan_panel() {
  const panel = document.getElementById('reconnect_scan_panel');
  if (panel) panel.classList.remove('is_open');
  set_picker_buttons_disabled(false);
}

// Re-enables the picker buttons but leaves the panel itself open, showing its
// final status/tally line, whether the scan found everything, some, or none
// of the missing files. It only collapses away when the whole reconnect
// modal closes (see close_reconnect_modal), so the user can actually read
// the result instead of it vanishing the instant the scan finishes.
function finish_scan_panel(checked_total, found_count, missing_total) {
  update_scan_progress(checked_total, checked_total, found_count, missing_total, true);
  set_picker_buttons_disabled(false);
}

// Disabled for the duration of a scan so "Choose folder" / "Select files"
// can't be double-triggered while one is already walking a directory.
function set_picker_buttons_disabled(disabled) {
  const choose_btn = document.getElementById('reconnect_choose_folder');
  const select_btn = document.getElementById('reconnect_select_files');
  if (choose_btn) choose_btn.disabled = disabled;
  if (select_btn) select_btn.disabled = disabled;
}

// Drives the scan-progress panel over a folder's file listing and returns
// the File objects that match a still-missing record. `entries` is an array
// of { name, getFile() } — getFile() may be sync or async — so the same loop
// serves both the Chromium FileSystemDirectoryHandle path and the
// webkitdirectory fallback's already-resolved FileList.
async function scan_entries_for_missing(entries, missing_records, dir_name) {
  const fcs_entries    = entries.filter((e) => /\.fcs$/i.test(e.name));
  const missing_by_name = new Map(missing_records.map((r) => [r.original_name, r]));
  const missing_total  = missing_records.length;

  open_scan_panel(dir_name, fcs_entries.length, missing_total);

  const found = [];
  try {
    let checked = 0;
    for (const entry of fcs_entries) {
      checked += 1;
      const record = missing_by_name.get(entry.name);
      if (record) {
        try {
          const file = await entry.getFile();
          if (is_acceptable_match(record, file)) {
            found.push(file);
            missing_by_name.delete(entry.name);
          }
        } catch (_) { /* unreadable — leave it missing */ }
      }
      update_scan_progress(checked, fcs_entries.length, found.length, missing_total);
      await next_frame();
      // Every missing file is accounted for — no need to keep walking the
      // rest of a potentially much larger folder.
      if (missing_by_name.size === 0) break;
    }
  } finally {
    finish_scan_panel(fcs_entries.length, found.length, missing_total);
  }
  return found;
}

// ── Reconnect modal ──────────────────────────────────────────────────────────

let reconnect_ctx = null;

// Exposed so session/core can read outstanding-file counts for its status/close
// wiring without touching this module's private state.
export function get_reconnect_records() {
  return reconnect_ctx ? reconnect_ctx.records : null;
}

// User-facing label for a record's status pill. "available" and "uncached"
// both mean the file loaded successfully for this session -- "uncached" only
// means its background OPFS copy failed, so it won't auto-restore next time
// without going through reconnect again. That's not something the user needs
// to parse from the pill itself (both are styled identically already); the
// console.warn in apply_reconnected_files is where that detail actually
// matters, for debugging a stubborn OPFS failure.
const STATUS_LABELS = {
  available: 'Found',
  uncached: 'Found',
  missing: 'Missing',
  mismatch: 'Mismatch',
  copying: 'Copying…',
};

function render_reconnect_list() {
  const list = document.getElementById('reconnect_file_list');
  if (!list || !reconnect_ctx) return;
  list.innerHTML = reconnect_ctx.records.map((r) => {
    const status = r.status || 'missing';
    const label = STATUS_LABELS[status] || status;
    const when = r.last_modified ? new Date(r.last_modified).toLocaleDateString() : '';
    const meta = [human_size(r.size), when].filter(Boolean).join(' · ');
    return `<li class="reconnect_row reconnect_row__${esc(status)}">
      <span class="reconnect_status_pill">${esc(label)}</span>
      <span class="reconnect_row_main">
        <span class="reconnect_row_name">${esc(r.relative_path || r.original_name)}</span>
        <span class="reconnect_row_meta">${esc(meta)}</span>
      </span></li>`;
  }).join('');

  const outstanding = reconnect_ctx.records.filter((r) => !is_resolved(r)).length;
  const intro = document.getElementById('reconnect_intro');
  if (intro) {
    if (outstanding) {
      // Uses innerHTML so the emphasis and line break render (the only
      // interpolated value is a count, so this is safe). Kept short and split
      // across source lines for readability.
      const plural = outstanding === 1 ? '' : 's';
      const them = outstanding === 1 ? 'it' : 'them';
      const are_not = outstanding === 1 ? 'is not' : 'are not';
      intro.innerHTML =
        `This session needs ${outstanding} file${plural} that ${are_not} loaded yet. ` +
        `Choose the folder that contains ${them}, or pick the missing file${plural} manually.` +
        `<br><br>` +
        `<strong>Your files never leave your computer.</strong> ` +
        `PhaseFinder does not upload anything, the browser only reads them locally ` +
        `so it can work with them. It may still warn about "uploading" the folder; that is just ` +
        `its standard wording for granting read access. Any files in the folder that are ` +
        `not part of this session are ignored.`;
    } else {
      intro.textContent = 'All session files are reconnected.';
    }
  }

  const continue_btn = document.getElementById('reconnect_continue');
  if (continue_btn) {
    continue_btn.textContent = outstanding
      ? `Continue: skipping ${outstanding} missing file${outstanding === 1 ? '' : 's'}`
      : 'Continue: all files found';
  }
}

export function open_reconnect_modal(records) {
  reconnect_ctx = { records };
  render_reconnect_list();
  const modal = document.getElementById('reconnect_modal');
  if (modal) modal.hidden = false;
}

export function close_reconnect_modal() {
  const modal = document.getElementById('reconnect_modal');
  if (modal) modal.hidden = true;
  reconnect_ctx = null;
  // The scan panel itself stays open after a scan finishes (see
  // finish_scan_panel) so its result is readable; reset it here so the next
  // reconnect doesn't open with a stale panel already showing.
  close_scan_panel();
}

// Matches provided files against still-missing records, caches + loads matches.
export async function apply_reconnected_files(files) {
  if (!reconnect_ctx) return;
  const indexes = index_selected_files(Array.from(files || []));
  const matches = [];
  for (const record of reconnect_ctx.records) {
    if (is_resolved(record)) continue;
    const file = match_record_to_selected_file(record, indexes);
    if (file) matches.push({ record, file });
  }

  // Copies run sequentially, not in parallel: concurrent createWritable()
  // streams into the same freshly-created OPFS directory were observed to
  // fail (every file coming back "uncached" instead of "available") in
  // real-browser testing, and it wasn't reproducible enough to safely chase
  // down and fix here, so this stays on the proven-correct path.
  for (const { record, file } of matches) {
    try { await copy_file_to_opfs(file, record.opfs_path); record.status = 'available'; }
    catch (err) { record.status = 'uncached'; console.warn('OPFS copy failed for', record.opfs_path, err); }
  }

  // Rows can flip to "available" as soon as the copies land, rather than
  // waiting on the separate (and slower) metadata-loading pass below too.
  render_reconnect_list();

  const to_load = matches.map((m) => m.file);
  if (to_load.length) await load_files(to_load);
  render_reconnect_list();
  const remaining = reconnect_ctx.records.filter((r) => !is_resolved(r)).length;
  set_status_bar(
    to_load.length
      ? `Reconnected ${to_load.length} file${to_load.length === 1 ? '' : 's'}.${remaining ? ` ${remaining} still missing.` : ''}`
      : 'No matching files found in your selection.',
    !to_load.length,
  );
}

// Folder reconnect. Native directory picker is Chromium-only and can't be
// automated, so test mode (and non-Chromium browsers) use a webkitdirectory input.
export async function reconnect_from_directory() {
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
    const entries = [];
    for await (const handle of dir_handle.values()) {
      if (handle.kind === 'file') entries.push({ name: handle.name, getFile: () => handle.getFile() });
    }
    const found = await scan_entries_for_missing(entries, missing, dir_handle.name);
    await apply_reconnected_files(found);
  } else {
    const picked = await pick_dir_fallback_all();
    if (picked === null) return; // cancelled
    const entries = picked.files.map((f) => ({ name: f.name, getFile: () => f }));
    const found = await scan_entries_for_missing(entries, missing, picked.dir_name);
    await apply_reconnected_files(found);
  }
}

export function reconnect_from_files() {
  const input = document.getElementById('reconnect_file_input');
  if (!input) return;
  input.value = '';
  input.onchange = async () => {
    const files = Array.from(input.files || []);
    if (files.length) await apply_reconnected_files(files);
  };
  input.click();
}
