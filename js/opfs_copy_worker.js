// ---------------------------------------------------------------------------
// OPFS copy worker
//
// Writes a loaded FCS File into OPFS off the main thread so caching large files
// (tens of MB) never blocks the UI. session.js drives this worker one file at a
// time and reports "Caching file x of y" to the status bar.
//
// Message in:  { request_id, file, opfs_path }
// Message out: { request_id, ok, error }
//
// Runs in a Worker scope, so it cannot use window.PhaseFinderOPFS — the small
// amount of directory/handle logic it needs is inlined here.
// ---------------------------------------------------------------------------

async function ensure_directory(root, parts) {
  let dir = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  return dir;
}

function split_opfs_path(opfs_path) {
  const parts = String(opfs_path).split('/').filter(Boolean);
  const file_name = parts.pop();
  return { dir_parts: parts, file_name };
}

async function write_file_to_opfs(file, opfs_path) {
  const root = await navigator.storage.getDirectory();
  const { dir_parts, file_name } = split_opfs_path(opfs_path);
  const dir = await ensure_directory(root, dir_parts);
  const handle = await dir.getFileHandle(file_name, { create: true });

  // createWritable streams the whole File straight to disk. A sync access handle
  // (createSyncAccessHandle) would be faster but is a later optimization.
  const writable = await handle.createWritable();
  try {
    await writable.write(file);
  } finally {
    await writable.close();
  }
}

self.addEventListener('message', async (event) => {
  const { request_id, file, opfs_path } = event.data || {};
  try {
    await write_file_to_opfs(file, opfs_path);
    self.postMessage({ request_id, ok: true });
  } catch (error) {
    self.postMessage({ request_id, ok: false, error: error.message || String(error) });
  }
});
