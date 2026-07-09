// Core shared application state: the loaded-file map and the metadata frame.
// This module owns the two per-file representations that almost every other
// module reads or updates, and exposes them only through accessors so the rest
// of the app never touches a mutable global directly. It imports nothing, so it
// sits at the base of the dependency graph.
//
//   file_map          — Map<id, entry> of non-tabular "heavy" per-file objects
//                       (File object, FCS summary, cached event arrays). The Map
//                       instance is stable for the page lifetime; callers mutate
//                       it via .set()/.get()/.delete() through get_file_map().
//   file_table_frame  — the tabular PhaseFinderFrame (single source of truth for
//                       annotations, filters, sort, stats, export). It is
//                       reassigned wholesale by several modules, so writes go
//                       through set_file_table().

// Non-tabular per-file data (File object, FCS header, cached event arrays).
// Analysis code holds references to these entries and mutates them (e.g. row.data).
const file_map = new Map();

// Tabular view of loaded files. Columns: id, name, user-defined filename
// metadata columns, plus stats columns added by js/analysis/stats.js
// in the form "CHANNEL:metric" (e.g. "DAPI-A:mean"). Single source of truth
// for annotation edits and all stats.
let file_table_frame = null;

/*

Purpose:
	Returns the shared loaded-file map. The Map instance never changes, so it is
	safe to hold and mutate directly (set/get/delete).

Input:
	(none)

Output:
	file_map [Map<string, Object>]: the loaded-file entries keyed by id

*/
export function get_file_map() {
  return file_map;
}

/*

Purpose:
	Returns the current metadata frame (or null before any files are loaded).

Input:
	(none)

Output:
	frame [PhaseFinderFrame|null]: the current tabular frame

*/
export function get_file_table() {
  return file_table_frame;
}

/*

Purpose:
	Replaces the current metadata frame. Used whenever a module rebuilds the
	frame (file load, metadata import, wizard apply, session restore, sort).

Input:
	frame [PhaseFinderFrame|null]: the new frame

Output:
	(none) [void]: updates the shared frame reference

*/
export function set_file_table(frame) {
  file_table_frame = frame;
}
