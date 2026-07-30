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

/*

Purpose:
	A local-time "YYYYMMDD-HHMMSS" stamp for tagging downloaded filenames, so
	every export the app produces is uniquely and chronologically named without
	overwriting a previous one.

Input:
	date [Date]: optional; defaults to now

Output:
	stamp [string]: e.g. "20260725-141530"

*/
export function filename_timestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/*

Purpose:
	Appends the datetime stamp to a base name, before the extension:
	timestamped_filename("phasefinder_plot", "svg") -> "phasefinder_plot_20260725-141530.svg".

Input:
	base [string]: filename without extension
	ext [string]: extension without the leading dot (omit for none)

Output:
	name [string]: the datetime-tagged filename

*/
export function timestamped_filename(base, ext = "") {
  const stamp = filename_timestamp();
  return ext ? `${base}_${stamp}.${ext}` : `${base}_${stamp}`;
}
