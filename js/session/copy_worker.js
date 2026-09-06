// OPFS copy worker for background FCS file caching. This module worker writes a
// loaded FCS File into the browser's Origin Private File System so large cache
// writes do not block the main UI thread. js/session/file_cache.js drives one
// request at a time and reports cache progress through the status bar. Messages
// include a request id, file, and OPFS path on input, then return success or
// error with the same request id. It inlines the small directory and path helpers
// it needs so it stays a tiny self-contained worker.

import { digest_file_chunks } from './file_digest.js';

const cancelled_requests = new Set();

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

async function write_file_to_opfs(file, opfs_path, request_id) {
  const root = await navigator.storage.getDirectory();
  const { dir_parts, file_name } = split_opfs_path(opfs_path);
  const dir = await ensure_directory(root, dir_parts);
  const handle = await dir.getFileHandle(file_name, { create: true });

  // createWritable streams the whole File straight to disk. A sync access handle
  // (createSyncAccessHandle) would be faster but is a later optimization.
  const writable = await handle.createWritable();
  try {
    const identity = await digest_file_chunks(file, {
      signal: { get aborted() { return cancelled_requests.has(request_id); } },
      consume_chunk: (buffer) => writable.write(buffer),
      on_progress: (progress) => self.postMessage({ request_id, progress }),
    });
    if (cancelled_requests.has(request_id)) throw new Error("Cache copy cancelled.");
    await writable.close();
    return identity;
  } catch (error) {
    try { await writable.abort(); } catch (_) { /* best effort */ }
    try { await dir.removeEntry(file_name); } catch (_) { /* partial path may not exist */ }
    throw error;
  }
}

self.addEventListener('message', async (event) => {
  if (event.data?.cancel) {
    cancelled_requests.add(event.data.request_id);
    return;
  }
  const { request_id, file, opfs_path } = event.data || {};
  try {
    const identity = await write_file_to_opfs(file, opfs_path, request_id);
    self.postMessage({ request_id, ok: true, ...identity });
  } catch (error) {
    self.postMessage({ request_id, ok: false, error: error.message || String(error) });
  } finally {
    cancelled_requests.delete(request_id);
  }
});
