// Selected-channel cleanup and companion-channel detection for FCS data. This
// file normalizes FCS parameter labels so related area, height, width, and time
// measurements can be compared reliably across naming conventions. It detects
// optional matching height and width channels for a selected area channel when
// those companion columns actually exist. It filters the selected primary values
// to finite positive events and applies the same keep mask to auxiliary arrays.
// The returned cleaned arrays and keep_mask are stored in the channel cache for
// plotting, statistics, and model preprocessing.

/*

Purpose:
	Normalizes channel names so related area/height/width parameters can be
	matched across labels like "DAPI-A", "DAPI-H", "DAPI Area", and "DAPI Width".

Input:
	value [string]: a parameter label/name/description

Output:
	name [string]: lowercase hyphenated channel name

*/
function normalize_measurement_name(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\barea\b/g, "a")
    .replace(/\bheight\b/g, "h")
    .replace(/\bwidth\b/g, "w")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/*

Purpose:
	Returns whether a parameter name represents area, height, or width based on
	its final normalized token.

Input:
	value [string]: a parameter label/name/description

Output:
	kind [string|null]: "area", "height", "width", or null

*/
function measurement_kind(value) {
  const normalized = normalize_measurement_name(value);
  const last = normalized.split("-").pop();
  if (last === "a") return "area";
  if (last === "h") return "height";
  if (last === "w") return "width";
  return null;
}

/*

Purpose:
	Returns the base channel name without a trailing area/height/width token.

Input:
	value [string]: a parameter label/name/description

Output:
	base [string]: normalized channel base name

*/
function measurement_base(value) {
  const tokens = normalize_measurement_name(value).split("-").filter(Boolean);
  const last = tokens[tokens.length - 1];
  if (last === "a" || last === "h" || last === "w") {
    tokens.pop();
  }
  return tokens.join("-");
}

/*

Purpose:
	Returns the usable label/name/description strings for one FCS parameter.

Input:
	param [Object]: parameter_map entry

Output:
	fields [Array<string>]: non-empty parameter names

*/
function parameter_fields(param) {
  return [param.label, param.name, param.desc].filter(Boolean);
}

/*

Purpose:
	Finds a same-base height or width parameter for the selected area channel.
	Returns null when the file does not actually contain that linked channel.

Input:
	params [Array<Object>]: all file parameters
	selected_param [Object]: the selected area parameter
	target_kind [string]: "height" or "width"

Output:
	param [Object|null]: matching linked parameter, if present

*/
function find_linked_measurement_param(params, selected_param, target_kind) {
  const selected_bases = parameter_fields(selected_param).map(measurement_base).filter(Boolean);
  const base_set = new Set(selected_bases);

  for (const candidate of params) {
    if (candidate.index === selected_param.index) continue;

    const fields = parameter_fields(candidate);
    if (!fields.some((field) => measurement_kind(field) === target_kind)) continue;

    const has_same_base = fields
      .map(measurement_base)
      .filter(Boolean)
      .some((base) => base_set.has(base));
    if (has_same_base) {
      return candidate;
    }
  }

  return null;
}

/*

Purpose:
	Finds optional height/width channels that correspond to the selected area
	channel for this specific file.

Input:
	params [Array<Object>]: all file parameters
	selected_label [string]: selected DNA-content area channel label

Output:
	aux [Object]: optional dna_h/dna_w indexes and labels

*/
function find_auxiliary_indexes_for_file(params, selected_label) {
  const selected_param = params.find((param) =>
    param.label === selected_label || param.name === selected_label || param.desc === selected_label
  );
  if (!selected_param) {
    return {};
  }

  const height = find_linked_measurement_param(params, selected_param, "height");
  const width = find_linked_measurement_param(params, selected_param, "width");
  return {
    dna_h: height ? height.index : null,
    dna_w: width ? width.index : null,
    dna_height_label: height ? height.label : "",
    dna_width_label: width ? width.label : "",
  };
}

/*

Purpose:
	Filters invalid selected-channel values after the FCS data columns are loaded.
	The DNA-area column defines the keep mask; optional height/width columns are
	filtered with the same mask so event rows stay aligned.

Input:
	columns [Object]: loaded parameter arrays keyed by 1-based parameter index
	indexes [Object]: selected dna_a plus optional dna_h/dna_w indexes

Output:
	result [Object]: filtered arrays plus removed/total event counts

*/
function filter_selected_channel_values(columns, indexes) {
  const dna_a = columns[indexes.dna_a] || [];
  const dna_h = indexes.dna_h ? columns[indexes.dna_h] || null : null;
  const dna_w = indexes.dna_w ? columns[indexes.dna_w] || null : null;
  const keep_mask = new Uint8Array(dna_a.length);
  const filtered_a = [];
  const filtered_h = dna_h ? [] : null;
  const filtered_w = dna_w ? [] : null;
  let removed_count = 0;

  for (let index = 0; index < dna_a.length; index += 1) {
    const value = Number(dna_a[index]);
    if (Number.isFinite(value) && value > 0) {
      keep_mask[index] = 1;
      filtered_a.push(value);
      if (filtered_h) filtered_h.push(dna_h[index]);
      if (filtered_w) filtered_w.push(dna_w[index]);
    } else {
      removed_count += 1;
    }
  }

  return {
    dna_a: Float64Array.from(filtered_a),
    dna_h: filtered_h ? Float64Array.from(filtered_h) : null,
    dna_w: filtered_w ? Float64Array.from(filtered_w) : null,
    keep_mask,
    removed_count,
    total_count: dna_a.length,
  };
}
