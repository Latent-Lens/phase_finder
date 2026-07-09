// File-selection queries over the shared app state. These small accessors read
// the loaded-file map and the metadata frame (from app_state) together with the
// table selection (from table_state) so plotting, IO, analysis, and stats code
// can get the file entries it needs without reaching through a global. They are
// the internal, direct-import replacements for the old window.PhaseFinderApp
// file getters (which are still surfaced on the window.PhaseFinder.app debug hook
// by main.js).

import { get_file_map, get_file_table } from "./app_state.js";
import { selected_file_ids, sync_file_annotations } from "../data_structs/table_state.js";

/*

Purpose:
	Returns the non-tabular loaded-file entry for an id (file, summary, event
	cache), or undefined when no such file is loaded.

Input:
	id [string]: the loaded-file id

Output:
	entry [Object|undefined]: the file_map entry

*/
export function get_file_by_id(id) {
  return get_file_map().get(id);
}

/*

Purpose:
	Returns every loaded-file entry. Used by channel loading, stats, and plotting
	for background preload and full-set histograms.

Input:
	(none)

Output:
	entries [Array<Object>]: all file_map entries

*/
export function get_parsed_files() {
  return [...get_file_map().values()];
}

/*

Purpose:
	Returns the checked, loaded file entries (as full file_map objects so callers
	can read and mutate file/summary/event-cache fields). Syncs annotations back
	onto the entries first so plot legends/fit tables see current metadata.

Input:
	(none)

Output:
	entries [Array<Object>]: selected loaded-file entries

*/
export function get_selected_files() {
  const frame = get_file_table();
  if (!frame) return [];
  sync_file_annotations();
  const file_map = get_file_map();
  return [...frame.col("id")]
    .filter((id) => selected_file_ids.has(id))
    .map((id) => file_map.get(id))
    .filter(Boolean);
}
