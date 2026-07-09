// FCS parameter/index helpers used by selected-channel loading. This module maps a
// parsed FCS summary into parameter records with labels, names, descriptions,
// and 1-based FCS indexes. It finds the selected channel in that parameter map
// and throws a clear error if the selected label cannot be resolved for a file.
// It also de-duplicates requested parameter indexes before a worker or parser
// call reads DATA bytes. It deliberately does not store loaded event arrays; the
// reusable data cache is in js/data_structs/channel_cache.js.

/*

Purpose:
	Builds a lookup of a file's FCS parameters, pairing each column with its
	1-based index and its $PnN / $PnS metadata names.

Input:
	summary [Object]: parsed FCS header/metadata for one file

Output:
	params [Array<Object>]: { index, label, name, desc } per parameter

*/
export function parameter_map(summary) {
  return summary.columns.map((label, index) => ({
    index: index + 1,
    label,
    name: summary.metadata[`P${index + 1}N`] || "",
    desc: summary.metadata[`P${index + 1}S`] || "",
  }));
}

/*

Purpose:
	Finds the 1-based parameter index whose label, name, or description matches
	the selected channel. Throws if no parameter matches.

Input:
	params [Array<Object>]:   parameter map from parameter_map()
	selected_label [string]:  the chosen channel label/name

Output:
	index [number]: the 1-based FCS parameter index

*/
export function find_param_index(params, selected_label) {
  const hit = params.find((param) =>
    param.label === selected_label || param.name === selected_label || param.desc === selected_label
  );

  if (!hit) {
    throw new Error(`Could not find selected channel: ${selected_label}`);
  }

  return hit.index;
}

/*

Purpose:
	De-duplicates a list of parameter indexes, keeping only integers, so a
	column isn't read twice from the FCS data.

Input:
	indexes [Array<number>]: candidate parameter indexes (may include non-integers)

Output:
	unique [Array<number>]: the distinct integer indexes

*/
export function unique_indexes(indexes) {
  return Array.from(new Set(indexes.filter((index) => Number.isInteger(index))));
}
