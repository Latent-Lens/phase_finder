// Per-row, per-channel loaded-data cache helpers. This module owns the small data
// cache that lets parsed FCS event arrays be reused when users redraw a plot,
// switch channels, or load additional files. It creates stable cache keys from
// the selected channel object and stores each channel's cleaned arrays on the
// loaded file row. It also activates cached data onto row.data so plotting code
// reads the intended channel without knowing about the cache map. It contains no
// FCS parser or worker logic; those responsibilities stay in js/io.

/*

Purpose:
	Builds a stable cache key for analysis data loaded for a selected channel.

Input:
	selected [Object]: the selected channels, e.g. { dna_area }

Output:
	key [string]: the cache key for this analysis channel

*/
export function analysis_data_key(selected) {
  return selected && selected.dna_area ? selected.dna_area : "";
}

/*

Purpose:
	Returns cached analysis data for a row/channel, if that channel was already
	loaded.

Input:
	row [Object]:      loaded sample row
	selected [Object]: selected channels

Output:
	data [Object|null]: cached row data for the selected channel

*/
export function cached_analysis_data(row, selected) {
  const key = analysis_data_key(selected);
  return row.analysis_data_by_channel ? row.analysis_data_by_channel.get(key) || null : null;
}

/*

Purpose:
	Stores analysis data in the row's per-channel cache and optionally activates
	it as row.data for plotting.

Input:
	row [Object]:       loaded sample row
	selected [Object]:  selected channels
	data [Object]:      loaded channel data
	activate [boolean]: true to set row.data for plotting

Output:
	data [Object]: the stored row data

*/
export function store_analysis_data(row, selected, data, activate = true) {
  if (!row.analysis_data_by_channel) {
    row.analysis_data_by_channel = new Map();
  }
  row.analysis_data_by_channel.set(analysis_data_key(selected), data);
  if (activate) {
    row.data = data;
  }
  return data;
}

/*

Purpose:
	Checks whether a row already has the selected channel loaded in cache.

Input:
	row [Object]:      loaded sample row
	selected [Object]: selected channels

Output:
	loaded [boolean]: true when cached data exists for the selected channel

*/
export function is_analysis_data_loaded(row, selected) {
  const data = cached_analysis_data(row, selected);
  return Boolean(data && data.dna_a);
}

/*

Purpose:
	Activates cached data for the selected channel as row.data so plot code reads
	the intended column.

Input:
	row [Object]:      loaded sample row
	selected [Object]: selected channels

Output:
	activated [boolean]: true if cached data was activated

*/
export function activate_analysis_data(row, selected) {
  const data = cached_analysis_data(row, selected);
  if (!data) {
    return false;
  }
  row.data = data;
  return true;
}
