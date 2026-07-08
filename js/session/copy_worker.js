// OPFS copy worker for background FCS file caching. This worker writes a loaded
// FCS File into the browser's Origin Private File System so large cache writes
// do not block the main UI thread. js/session/opfs.js drives one request at a
// time and reports cache progress through the status bar. Messages include a
// request id, file, and OPFS path on input, then return success or error with
// the same request id. Because workers cannot use window.PhaseFinderOPFS, this
// file inlines the small directory and path helpers it needs.

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
