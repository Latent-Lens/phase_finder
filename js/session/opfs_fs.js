// Low-level OPFS filesystem wrapper. This module provides thin helpers over the
// browser's Origin Private File System for feature detection, directory creation,
// path splitting, file reads, deletes, persistent-storage requests, and quota
// estimates. PhaseFinder keeps app-private working copies of loaded FCS files
// here so saved sessions can auto-restore files on reload without asking the user
// to reselect them. Reads run on the main thread because getFile() is cheap, while
// large writes are delegated to js/session/copy_worker.js through
// js/session/file_cache.js. No OS paths are stored, only app-private OPFS paths.

/*

Purpose:
	Feature-detects OPFS support (used to decide whether automatic file caching
	and reload are available, or whether to fall back to manual reconnect).

Input:
	(none)

Output:
	supported [boolean]: true when navigator.storage.getDirectory exists

*/
export function supports_opfs() {
  return !!(navigator.storage && typeof navigator.storage.getDirectory === 'function');
}

/*

Purpose:
	Returns the OPFS root directory handle.

Input:
	(none)

Output:
	root [Promise<FileSystemDirectoryHandle>]: the OPFS root

*/
export async function get_opfs_root() {
  if (!supports_opfs()) {
    throw new Error('OPFS is not supported in this browser.');
  }
  return navigator.storage.getDirectory();
}

/*

Purpose:
	Walks/creates a directory chain under a root handle.

Input:
	root [FileSystemDirectoryHandle]: starting directory
	parts [Array<string>]: successive child directory names
	create [boolean]: create missing directories when true (default true)

Output:
	dir [Promise<FileSystemDirectoryHandle>]: the deepest directory handle

*/
export async function ensure_directory(root, parts, create = true) {
  let dir = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create });
  }
  return dir;
}

/*

Purpose:
	Splits an OPFS path like "sessions/<id>/files/<id>.fcs" into its directory
	parts and final file name.

Input:
	opfs_path [string]: a slash-separated OPFS path

Output:
	parts [Object]: { dir_parts: Array<string>, file_name: string }

*/
export function split_opfs_path(opfs_path) {
  const parts = String(opfs_path).split('/').filter(Boolean);
  const file_name = parts.pop();
  return { dir_parts: parts, file_name };
}

/*

Purpose:
	Reads a cached working copy back out of OPFS as a File. Throws if the path
	does not exist, so callers can treat a rejection as "missing".

Input:
	opfs_path [string]: the OPFS path written when the file was cached

Output:
	file [Promise<File>]: the cached file

*/
export async function read_file_from_opfs(opfs_path) {
  const root = await get_opfs_root();
  const { dir_parts, file_name } = split_opfs_path(opfs_path);
  const dir = await ensure_directory(root, dir_parts, false);
  const handle = await dir.getFileHandle(file_name);
  return handle.getFile();
}

/*

Purpose:
	Removes a cached working copy from OPFS. Best-effort; never throws.

Input:
	opfs_path [string]: the OPFS path to remove

Output:
	removed [Promise<boolean>]: true when a file was removed

*/
export async function delete_opfs_path(opfs_path) {
  try {
    const root = await get_opfs_root();
    const { dir_parts, file_name } = split_opfs_path(opfs_path);
    const dir = await ensure_directory(root, dir_parts, false);
    await dir.removeEntry(file_name);
    return true;
  } catch (_) {
    return false;
  }
}

/*

Purpose:
	Asks the browser to persist site storage so OPFS copies are less likely to be
	evicted. Best-effort; safe to call repeatedly.

Input:
	(none)

Output:
	persisted [Promise<boolean>]: true when storage is persistent

*/
export async function request_persistent_storage() {
  try {
    if (navigator.storage && typeof navigator.storage.persisted === 'function' && await navigator.storage.persisted()) {
      return true;
    }
    if (navigator.storage && typeof navigator.storage.persist === 'function') {
      return await navigator.storage.persist();
    }
  } catch (_) { /* storage API unavailable — non-fatal */ }
  return false;
}

/*

Purpose:
	Returns a storage-usage estimate for surfacing in settings/debug UI.

Input:
	(none)

Output:
	estimate [Promise<StorageEstimate|null>]: { usage, quota } or null

*/
export async function get_storage_estimate() {
  try {
    if (navigator.storage && typeof navigator.storage.estimate === 'function') {
      return await navigator.storage.estimate();
    }
  } catch (_) { /* non-fatal */ }
  return null;
}
