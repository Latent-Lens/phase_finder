// Shared filename helpers. These are pure string utilities used by core data
// structures (metadata frame, table state) as well as the UI and IO layers, so
// they live in a leaf module that imports nothing. Keeping them here keeps the
// core modules from having to reach up into the UI/IO layers just for a filename
// transform.

/*

Purpose:
	Returns the filename shown to the user, without the .fcs extension. The full
	entry.name is kept for dedup/matching.

Input:
	name [string]: a sample filename

Output:
	label [string]: the filename without a trailing ".fcs"

*/
export function display_name(name) {
  return String(name ?? "").replace(/\.fcs$/i, "");
}

/*

Purpose:
	Builds a normalized key for matching an imported/session filename to a loaded
	FCS file: strips any directory path and the .fcs extension, then lowercases.

Input:
	value [string]: a raw filename or path

Output:
	key [string]: the normalized match key

*/
export function metadata_filename_key(value) {
  const basename = String(value || "").trim().split(/[\\/]/).pop();
  return display_name(basename).trim().toLowerCase();
}
