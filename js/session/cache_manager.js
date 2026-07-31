import {
  read_cache_index,
  logical_session_id,
  release_session_cache,
  release_orphaned_cache,
  clear_all_local_records,
  human_size,
  automatic_cache_enabled,
  set_automatic_cache_enabled,
} from './file_cache.js';
import {
  delete_opfs_path,
  delete_opfs_session_directory,
  get_storage_estimate,
  list_opfs_session_directories,
} from './opfs_fs.js';
import { suppress_next_unload_warning } from './unload_guard.js';

function button(id) { return document.getElementById(id); }

async function cache_snapshot() {
  const entries = Object.values(read_cache_index().entries);
  const directories = await list_opfs_session_directories();
  const catalogued = new Set(entries.map((entry) => String(entry.path).split('/')[1]).filter(Boolean));
  return {
    entries,
    legacy_directories: directories.filter((name) => !catalogued.has(name)),
    estimate: await get_storage_estimate(),
  };
}

async function render_cache_manager() {
  const list = document.getElementById('cache_manager_list');
  const summary = document.getElementById('cache_manager_summary');
  if (!list || !summary) return;
  const { entries, legacy_directories, estimate } = await cache_snapshot();
  const indexedBytes = entries.reduce((total, entry) => total + (Number(entry.size) || 0), 0);
  summary.textContent = estimate
    ? `${human_size(estimate.usage)} used of ${human_size(estimate.quota)} browser storage; ${human_size(indexedBytes)} catalogued for PhaseFinder.`
    : `${human_size(indexedBytes)} catalogued for PhaseFinder. Browser quota information is unavailable.`;
  list.replaceChildren();
  for (const entry of entries) {
    const item = document.createElement('li');
    const owners = entry.owners || [];
    const mine = owners.includes(logical_session_id);
    item.textContent = `${human_size(entry.size)} · ${mine ? 'this session' : owners.length ? `${owners.length} other session owner(s)` : 'orphan candidate'} · ${entry.path}`;
    list.append(item);
  }
  for (const name of legacy_directories) {
    const item = document.createElement('li');
    item.textContent = `Legacy uncatalogued cache directory · sessions/${name}`;
    list.append(item);
  }
  if (!entries.length && !legacy_directories.length) {
    const item = document.createElement('li');
    item.textContent = 'No PhaseFinder cache entries found.';
    list.append(item);
  }
  button('cache_manager_clear_session').disabled = !entries.some((entry) => entry.owners?.includes(logical_session_id));
  button('cache_manager_clear_orphans').disabled = !entries.some((entry) => !entry.owners?.length) && !legacy_directories.length;
}

async function clear_orphans() {
  await release_orphaned_cache(delete_opfs_path);
  const { legacy_directories } = await cache_snapshot();
  for (const name of legacy_directories) await delete_opfs_session_directory(name);
  await render_cache_manager();
}

export function init_cache_manager() {
  const modal = document.getElementById('cache_manager_modal');
  if (!modal) return;
  const automatic = document.getElementById('cache_manager_automatic');
  if (automatic) {
    automatic.checked = automatic_cache_enabled();
    automatic.addEventListener('change', () => set_automatic_cache_enabled(automatic.checked));
  }
  button('cache_manager_button')?.addEventListener('click', async () => {
    modal.hidden = false;
    await render_cache_manager();
    button('cache_manager_close')?.focus();
  });
  button('cache_manager_close')?.addEventListener('click', () => { modal.hidden = true; });
  button('cache_manager_clear_session')?.addEventListener('click', async () => {
    if (!window.confirm('Clear cached FCS copies owned only by this session? Shared copies will be kept.')) return;
    await release_session_cache(logical_session_id, delete_opfs_path);
    await render_cache_manager();
  });
  button('cache_manager_clear_orphans')?.addEventListener('click', async () => {
    if (!window.confirm('Clear orphaned and uncatalogued legacy PhaseFinder cache entries?')) return;
    await clear_orphans();
  });
  button('cache_manager_clear_all')?.addEventListener('click', async () => {
    if (!window.confirm('Clear all PhaseFinder local data, including cached FCS copies and remembered directory access?')) return;
    const directories = await list_opfs_session_directories();
    for (const name of directories) await delete_opfs_session_directory(name);
    await clear_all_local_records();
    modal.hidden = true;
    suppress_next_unload_warning();
    window.location.reload();
  });
}
