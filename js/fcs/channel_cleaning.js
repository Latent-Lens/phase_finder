// Selected-channel cleanup and companion-channel detection for FCS data. This
// file normalizes FCS parameter labels so related area, height, width, and time
// measurements can be compared reliably across naming conventions. It detects
// optional matching height and width channels for a selected area channel when
// those companion columns actually exist. It also identifies the FSC-A, SSC-A,
// and acquisition-time parameters needed by the staged DJF pipeline and builds
// raw, index-aligned typed arrays. Structural filtering is deliberately deferred
// to Stage 0 so every mask continues to refer to the original FCS event order.

/*

Purpose:
	Normalizes channel names so related area/height/width parameters can be
	matched across labels like "DAPI-A", "DAPI-H", "DAPI Area", and "DAPI Width".

Input:
	value [string]: a parameter label/name/description

Output:
	name [string]: lowercase hyphenated channel name

*/
export function normalize_measurement_name(value) {
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
export function measurement_kind(value) {
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
export function measurement_base(value) {
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
export function parameter_fields(param) {
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
export function find_linked_measurement_param(params, selected_param, target_kind) {
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
export function find_auxiliary_indexes_for_file(params, selected_label) {
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
	Finds the optional scatter-area and acquisition-time parameters used by the
	staged DJF pipeline. Matching considers each parameter's label, $PnN, and
	$PnS fields so common spellings such as FSC-A, Forward Scatter Area, Time,
	and HDR-T are accepted.

Input:
	params [Array<Object>]: parameter_map entries for one FCS file

Output:
	indexes [Object]: { fsc_a, ssc_a, time }, each a 1-based index or null

*/
export function find_pipeline_channel_indexes(params) {
  const scatter_match = (param, short_name, long_name) => parameter_fields(param).some((field) => {
    if (measurement_kind(field) !== "area") return false;
    const base = measurement_base(field);
    return base === short_name
      || base.startsWith(`${short_name}-`)
      || base === long_name
      || base.startsWith(`${long_name}-`);
  });

  const time_score = (param) => {
    let score = 0;
    for (const field of parameter_fields(param)) {
      const normalized = normalize_measurement_name(field);
      if (normalized === "time" || normalized === "hdr-t" || normalized === "hdr-time") {
        score = Math.max(score, 4);
      } else if (normalized === "acquisition-time" || normalized === "event-time") {
        score = Math.max(score, 3);
      } else if (/(^|-)(time)($|-)/.test(normalized)) {
        score = Math.max(score, 2);
      } else if (/(^|-)hdr-t($|-)/.test(normalized)) {
        score = Math.max(score, 1);
      }
    }
    return score;
  };

  const fsc = params.find((param) => scatter_match(param, "fsc", "forward-scatter"));
  const ssc = params.find((param) => scatter_match(param, "ssc", "side-scatter"));
  const time = params
    .map((param) => ({ param, score: time_score(param) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.param.index - right.param.index)[0]?.param;

  return {
    fsc_a: fsc ? fsc.index : null,
    ssc_a: ssc ? ssc.index : null,
    time: time ? time.index : null,
  };
}

function finite_metadata_number(metadata, key) {
  const value = Number(metadata && metadata[key]);
  return Number.isFinite(value) ? value : null;
}

function raw_channel(columns, index, event_count, channel_name) {
  if (!Number.isInteger(index)) return null;
  const values = columns[index];
  if (!values) {
    throw new Error(`FCS parser did not return the requested ${channel_name} column (P${index}).`);
  }
  if (values.length !== event_count) {
    throw new Error(
      `${channel_name} event count mismatch: expected ${event_count}, received ${values.length}.`,
    );
  }
  return Float64Array.from(values, (value) => Number(value));
}

/*

Purpose:
	Builds the staged pipeline's full-fidelity channel bundle from selected FCS
	columns. Arrays are never compacted: every typed-array index is the original
	event index. It also captures the acquisition metadata required for boundary
	QC and later diagnostics.

Input:
	columns [Object]: loaded arrays keyed by 1-based FCS parameter index
	indexes [Object]: resolved DNA/scatter/time indexes
	metadata [Object]: normalized FCS TEXT metadata
	event_count [number]: expected $TOT for every selected column

Output:
	result [Object]: { channels, pnr, parameterMetadata }

*/
export function build_raw_analysis_channels(columns, indexes, metadata, event_count) {
  const count = Number(event_count);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`Invalid FCS event count: ${event_count}`);
  }

  const specs = {
    DNA_A: indexes.dna_a,
    DNA_H: indexes.dna_h,
    DNA_W: indexes.dna_w,
    FSC_A: indexes.fsc_a,
    SSC_A: indexes.ssc_a,
    Time: indexes.time,
  };
  const channels = {};
  const pnr = {};
  const parameterMetadata = {};

  for (const [name, index] of Object.entries(specs)) {
    channels[name] = raw_channel(columns, index, count, name);
    const range = Number.isInteger(index)
      ? finite_metadata_number(metadata, `P${index}R`)
      : null;
    pnr[name] = range > 0 ? range : null;
    parameterMetadata[name] = Number.isInteger(index) ? {
      index,
      datatype: (metadata && metadata.DATATYPE) || "",
      bits: finite_metadata_number(metadata, `P${index}B`),
      range: pnr[name],
      amplification: (metadata && metadata[`P${index}E`]) || "",
      name: (metadata && metadata[`P${index}N`]) || "",
      stain: (metadata && metadata[`P${index}S`]) || "",
    } : null;
  }

  return { channels, pnr, parameterMetadata };
}
