// Shared filename helpers. This leaf module holds the two pure string transforms
// used to display and match FCS filenames: stripping the ".fcs" extension for
// display, and building a normalized key (path- and extension-stripped,
// lowercased) for matching imported/session rows to loaded files. They are used
// by core data structures (metadata frame, table state) as well as the UI and IO
// layers, so keeping them in a module that imports nothing avoids forcing the
// core modules to reach up into the UI/IO layers just for a filename transform.
// The full entry.name is kept elsewhere for dedup, so these only shape the
// display/match forms.

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
