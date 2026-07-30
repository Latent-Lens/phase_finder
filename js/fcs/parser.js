// Low-level FCS parser used by both the main thread and the data worker. This
// file knows how to parse fixed FCS headers, TEXT key/value segments, byte order,
// parameter metadata, and DATA values for supported numeric data types. It can
// parse full event rows when needed, but PhaseFinder mainly uses the
// selected-column reader so only requested channels are loaded into memory. It
// exports the FCSParser API as a plain ES module; the module data worker imports
// the same file. Higher-level file loading and cleanup live outside this parser.

/*

Purpose:
	Decodes a byte range of an ArrayBuffer as ASCII text.

Input:
	buffer [ArrayBuffer]:    the file bytes
	begin [number]:          start byte offset (inclusive)
	end_inclusive [number]:  end byte offset (inclusive)

Output:
	text [string]: the decoded ASCII string

*/
function read_ascii(buffer, begin, end_inclusive) {
  return new TextDecoder("ascii").decode(buffer.slice(begin, end_inclusive + 1));
}

function parser_error(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Public, intentionally mutable limits let deployments tighten the parser for
// constrained browsers without changing the decoding code.
export const FCS_LIMITS = Object.seal({
  maxParameters: 1024,
  maxEvents: 100_000_000,
  maxTextBytes: 16 * 1024 * 1024,
  maxDataBytes: 2 * 1024 * 1024 * 1024,
  maxTextKeywords: 100_000,
  maxKeywordLength: 1024 * 1024,
  maxWorkingBytes: 2 * 1024 * 1024 * 1024,
  dataChunkBytes: 8 * 1024 * 1024,
});

/*

Purpose:
	Parses a header offset field into an integer, returning 0 when it is not a
	valid number.

Input:
	value [string|number]: a raw header offset field

Output:
	offset [number]: the parsed integer, or 0 if invalid

*/
function parse_offset(value, name = "offset") {
  const raw = String(value ?? "").trim();
  if (raw === "") return 0;
  if (!/^\d+$/.test(raw)) {
    throw parser_error("FCS_OFFSET_INVALID", `Invalid FCS ${name} offset.`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw parser_error("FCS_OFFSET_INVALID", `FCS ${name} offset exceeds JavaScript's safe integer range.`);
  }
  return parsed;
}

/*

Purpose:
	Reads the fixed 58-byte FCS HEADER and extracts the TEXT/DATA/ANALYSIS
	segment offsets. Throws if the buffer is too small or is not an FCS file.

Input:
	buffer [ArrayBuffer]: the FCS file bytes

Output:
	header [Object]: { version, text_begin, text_end, data_begin, data_end, analysis_begin, analysis_end }

*/
function parse_header(buffer) {
  if (buffer.byteLength < 58) {
    throw parser_error("FCS_HEADER_TRUNCATED", "FCS file is too small to contain a valid header.");
  }

  const header = read_ascii(buffer, 0, 57);
  const version = header.slice(0, 6).trim();

  if (!version.startsWith("FCS")) {
    throw new Error("Selected file does not look like an FCS file.");
  }

  return {
    version,
    text_begin: parse_offset(header.slice(10, 18), "HEADER TEXT begin"),
    text_end: parse_offset(header.slice(18, 26), "HEADER TEXT end"),
    data_begin: parse_offset(header.slice(26, 34), "HEADER DATA begin"),
    data_end: parse_offset(header.slice(34, 42), "HEADER DATA end"),
    analysis_begin: parse_offset(header.slice(42, 50), "HEADER ANALYSIS begin"),
    analysis_end: parse_offset(header.slice(50, 58), "HEADER ANALYSIS end"),
  };
}

/*

Purpose:
	Parses an FCS TEXT segment (delimiter-separated key/value pairs, where the
	delimiter is escaped by doubling) into a normalized metadata object.

Input:
	text [string]: the raw TEXT segment, with the delimiter as its first char

Output:
	metadata [Object]: normalized keyword -> value pairs

*/
function parse_text_segment(text) {
  if (!text.length || text.length > FCS_LIMITS.maxTextBytes) {
    throw parser_error("FCS_TEXT_LIMIT_EXCEEDED", `FCS TEXT segment exceeds the ${FCS_LIMITS.maxTextBytes}-byte limit.`);
  }
  const delimiter = text[0];
  const values = [];
  let current = "";

  for (let index = 1; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === delimiter && next === delimiter) {
      current += delimiter;
      index += 1;
    } else if (char === delimiter) {
      values.push(current);
      if (values.length > FCS_LIMITS.maxTextKeywords * 2) {
        throw parser_error("FCS_TEXT_LIMIT_EXCEEDED", `FCS TEXT contains more than ${FCS_LIMITS.maxTextKeywords} keywords.`);
      }
      current = "";
    } else {
      current += char;
    }
  }

  if (current !== "") {
    values.push(current);
  }

  const metadata = {};
  for (let index = 0; index < values.length; index += 2) {
    if (values[index].length > FCS_LIMITS.maxKeywordLength || (values[index + 1]?.length ?? 0) > FCS_LIMITS.maxKeywordLength) {
      throw parser_error("FCS_TEXT_LIMIT_EXCEEDED", `FCS TEXT keyword ${index / 2 + 1} exceeds the length limit.`);
    }
    const key = normalize_keyword(values[index]);
    if (key) {
      metadata[key] = values[index + 1] ?? "";
    }
  }

  return metadata;
}

/*

Purpose:
	Normalizes an FCS keyword to a canonical form: trimmed, leading "$" removed,
	spaces converted to underscores, and uppercased.

Input:
	key [string]: a raw FCS keyword

Output:
	normalized [string]: the canonical keyword (e.g. "PAR", "P1N")

*/
function normalize_keyword(key) {
  return String(key || "")
    .trim()
    .replace(/^\$/, "")
    .replaceAll(" ", "_")
    .toUpperCase();
}

/*

Purpose:
	Looks up a metadata value by keyword (normalizing the name first), returning
	a fallback when the keyword is absent.

Input:
	metadata [Object]: normalized metadata map
	name [string]:     the keyword to look up
	fallback [string]: value returned when the keyword is missing (default "")

Output:
	value [string]: the metadata value, or the fallback

*/
function keyword(metadata, name, fallback = "") {
  return metadata[normalize_keyword(name)] ?? fallback;
}

export const SUPPORTED_FCS_VERSIONS = Object.freeze(["FCS2.0", "FCS3.0", "FCS3.1"]);
export const CHANNEL_ELIGIBILITY_STATES = Object.freeze({
  transform: ["linear", "transformed_supported", "transformed_unsupported", "unknown"],
  compensation: ["compensated", "uncompensated", "not_applicable", "unknown"],
});

function numeric_keyword(metadata, name, fallback = null) {
  const raw = keyword(metadata, name, "");
  if (String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function spillover_channels(metadata) {
  const raw = keyword(metadata, "SPILLOVER") || keyword(metadata, "SPILL") || keyword(metadata, "COMP");
  if (!raw) return { present: false, channels: [], raw: "" };
  const fields = raw.split(",").map((value) => value.trim());
  const count = Number.parseInt(fields[0], 10);
  return {
    present: true,
    channels: Number.isInteger(count) && count > 0 ? fields.slice(1, 1 + count) : [],
    raw,
  };
}

export function channel_eligibility(summary, parameter_index) {
  const metadata = summary?.metadata ?? {};
  const index = Number(parameter_index);
  const version = String(summary?.header?.version ?? "").toUpperCase();
  const mode = String(keyword(metadata, "MODE", "")).trim().toUpperCase();
  const nextData = numeric_keyword(metadata, "NEXTDATA", 0);
  const datatype = String(keyword(metadata, "DATATYPE", "")).trim().toUpperCase();
  const range = numeric_keyword(metadata, `P${index}R`);
  const exponentRaw = String(keyword(metadata, `P${index}E`, "0,0")).trim();
  const exponent = exponentRaw.split(",").map(Number);
  const gain = numeric_keyword(metadata, `P${index}G`, 1);
  const parameterName = keyword(metadata, `P${index}N`);
  const parameterStain = keyword(metadata, `P${index}S`);
  const spillover = spillover_channels(metadata);
  const parameterKnown = Number.isInteger(index) && index >= 1 && index <= (summary?.parameter_count ?? 0);
  const isSpilloverChannel = spillover.channels.some((name) =>
    name === parameterName || name === parameterStain || name === summary?.columns?.[index - 1]);

  let code = null;
  let message = "Linear, uncompensated channel supported for DNA modeling.";
  if (!parameterKnown) {
    code = "FCS_DNA_CHANNEL_UNKNOWN";
    message = "Selected DNA channel metadata is unavailable.";
  } else if (!SUPPORTED_FCS_VERSIONS.includes(version)) {
    code = "FCS_VERSION_UNSUPPORTED";
    message = `FCS version ${version || "unknown"} is not supported for event analysis.`;
  } else if (mode !== "L") {
    code = "FCS_MODE_UNSUPPORTED";
    message = `FCS $MODE must be list mode (L), not ${mode || "missing"}.`;
  } else if (nextData !== 0) {
    code = "FCS_MULTIPLE_DATASETS_UNSUPPORTED";
    message = "Chained FCS datasets ($NEXTDATA) are not supported.";
  } else if (!Number.isFinite(range) || range <= 0) {
    code = "FCS_DNA_RANGE_INVALID";
    message = `Selected DNA channel has invalid $P${index}R metadata.`;
  } else if (exponent.length !== 2 || exponent.some((value) => !Number.isFinite(value)) || exponent[0] !== 0) {
    code = "FCS_DNA_TRANSFORM_UNSUPPORTED";
    message = `Selected DNA channel uses unsupported $P${index}E amplification (${exponentRaw || "missing"}).`;
  } else if (!Number.isFinite(gain) || gain !== 1) {
    code = "FCS_DNA_TRANSFORM_UNSUPPORTED";
    message = `Selected DNA channel uses unsupported $P${index}G gain (${gain}).`;
  } else if (isSpilloverChannel) {
    code = "FCS_COMPENSATION_REQUIRED";
    message = "Selected DNA channel participates in a spillover matrix; PhaseFinder does not apply compensation.";
  }

  const transformStatus = !parameterKnown || exponent.some((value) => !Number.isFinite(value)) || !Number.isFinite(gain)
    ? "unknown"
    : exponent[0] === 0 && gain === 1
      ? "linear"
      : "transformed_unsupported";
  const compensationStatus = isSpilloverChannel
    ? "uncompensated"
    : spillover.present ? "not_applicable" : "unknown";
  return {
    eligible: code == null,
    status: code == null ? "linear" : code,
    code,
    message,
    version,
    mode,
    datatype,
    range,
    transform: {
      status: transformStatus,
      representation: transformStatus,
      amplification: exponentRaw,
      gain,
      applied: false,
      applicationCount: 0,
    },
    compensation: {
      status: compensationStatus,
      keywordPresent: spillover.present,
      applied: false,
      applicationCount: 0,
    },
    nextData,
  };
}

/*

Purpose:
	Determines the data byte order from $BYTEORD, defaulting to little-endian.

Input:
	metadata [Object]: normalized metadata map

Output:
	little_endian [boolean]: true if the data is little-endian

*/
function is_little_endian(metadata) {
  const byte_order = keyword(metadata, "$BYTEORD", keyword(metadata, "BYTEORD", "1,2,3,4"));
  if (byte_order === "1,2,3,4" || byte_order === "1,2") return true;
  if (byte_order === "4,3,2,1" || byte_order === "2,1") return false;
  throw parser_error("FCS_BYTE_ORDER_INVALID", `Unsupported FCS $BYTEORD: ${byte_order}`);
}

/*

Purpose:
	Builds the display label for each parameter, preferring $PnS, then $PnN,
	then a generated "P<n>" fallback.

Input:
	metadata [Object]:         normalized metadata map
	parameter_count [number]:  number of parameters ($PAR)

Output:
	columns [Array<string>]: one label per parameter

*/
function parameter_columns(metadata, parameter_count) {
  return Array.from({ length: parameter_count }, (_, index) => {
    const number = index + 1;
    return (
      keyword(metadata, `$P${number}S`) ||
      keyword(metadata, `$P${number}N`) ||
      `P${number}`
    );
  });
}

/*

Purpose:
	Reads an unsigned integer of a given byte width from a DataView, honoring
	endianness. Has fast paths for 1/2/4-byte widths and a loop for others.

Input:
	view [DataView]:          the data view over the DATA segment
	byte_offset [number]:     where to read from
	byte_width [number]:      integer width in bytes
	little_endian [boolean]:  byte order

Output:
	value [number]: the unsigned integer value

*/
function integer_reader(view, byte_offset, byte_width, little_endian) {
  if (byte_width === 1) {
    return view.getUint8(byte_offset);
  }
  if (byte_width === 2) {
    return view.getUint16(byte_offset, little_endian);
  }
  if (byte_width === 4) {
    return view.getUint32(byte_offset, little_endian);
  }

  let value = 0;
  if (little_endian) {
    for (let index = byte_width - 1; index >= 0; index -= 1) {
      value = value * 256 + view.getUint8(byte_offset + index);
    }
  } else {
    for (let index = 0; index < byte_width; index += 1) {
      value = value * 256 + view.getUint8(byte_offset + index);
    }
  }
  return value;
}

/*

Purpose:
	Reads the full list-mode DATA segment into per-event rows, supporting the
	F/D/I data types. Throws on missing $PAR/$TOT or an unsupported $DATATYPE.

Input:
	buffer [ArrayBuffer]:  the FCS file bytes
	metadata [Object]:     normalized metadata map
	data_begin [number]:   DATA segment start offset
	data_end [number]:     DATA segment end offset (inclusive)

Output:
	result [Object]: { rows [Array<Object>], columns [Array<string>] }

*/
function parse_data(buffer, metadata, data_begin, data_end) {
  const parameter_count = Number(keyword(metadata, "$PAR", keyword(metadata, "PAR", "0")));
  const event_count = Number(keyword(metadata, "$TOT", keyword(metadata, "TOT", "0")));
  const data_type = keyword(metadata, "$DATATYPE", keyword(metadata, "DATATYPE", "F")).toUpperCase();
  const little_endian = is_little_endian(metadata);
  const columns = parameter_columns(metadata, parameter_count);
  const view = new DataView(buffer, data_begin, data_end - data_begin + 1);

  if (!parameter_count || !event_count) {
    throw new Error("FCS metadata is missing $PAR or $TOT.");
  }

  let offset = 0;
  const rows = [];

  for (let event_index = 0; event_index < event_count; event_index += 1) {
    const row = {};

    for (let parameter_index = 0; parameter_index < parameter_count; parameter_index += 1) {
      const column = columns[parameter_index];
      let value;

      if (data_type === "F") {
        value = view.getFloat32(offset, little_endian);
        offset += 4;
      } else if (data_type === "D") {
        value = view.getFloat64(offset, little_endian);
        offset += 8;
      } else if (data_type === "I") {
        const bits = Number.parseInt(keyword(metadata, `$P${parameter_index + 1}B`, "32"), 10);
        const byte_width = Math.ceil(bits / 8);
        value = integer_reader(view, offset, byte_width, little_endian);
        offset += byte_width;
      } else {
        throw new Error(`Unsupported FCS $DATATYPE: ${data_type}`);
      }

      row[column] = value;
    }

    rows.push(row);
  }

  return { rows, columns };
}

/*

Purpose:
	Computes the byte width of each parameter for the given data type: 4 for F,
	8 for D, ceil($PnB/8) for I. Throws on unsupported types.

Input:
	metadata [Object]:         normalized metadata map
	parameter_count [number]:  number of parameters
	data_type [string]:        "F", "D", or "I"

Output:
	widths [Array<number>]: byte width per parameter

*/
function parameter_byte_widths(metadata, parameter_count, data_type) {
  if (data_type === "F") {
    return Array.from({ length: parameter_count }, () => 4);
  }
  if (data_type === "D") {
    return Array.from({ length: parameter_count }, () => 8);
  }
  if (data_type === "I") {
    return Array.from({ length: parameter_count }, (_, index) => {
      const bits = Number(keyword(metadata, `$P${index + 1}B`, "32"));
      if (!Number.isInteger(bits) || bits < 1) {
        throw parser_error("FCS_INTEGER_WIDTH_INVALID", `Invalid FCS $P${index + 1}B: ${bits}`);
      }
      if (bits % 8 !== 0) {
        throw parser_error(
          "FCS_PACKED_INTEGER_UNSUPPORTED",
          `Packed ${bits}-bit FCS integers are not supported.`,
        );
      }
      if (bits > 53) {
        throw parser_error(
          "FCS_INTEGER_PRECISION_UNSUPPORTED",
          `${bits}-bit FCS integers exceed JavaScript's exact integer range.`,
        );
      }
      return Math.ceil(bits / 8);
    });
  }

  throw parser_error("FCS_DATATYPE_UNSUPPORTED", `Unsupported FCS $DATATYPE: ${data_type}`);
}

function validate_offset_pair(begin, end, name, file_size = null, { required = false } = {}) {
  const absent = begin === 0 && end === 0;
  if (absent && !required) return;
  if (
    !Number.isSafeInteger(begin)
    || !Number.isSafeInteger(end)
    || begin < 0
    || end < begin
    || (required && absent)
    || (Number.isFinite(file_size) && end >= file_size)
  ) {
    throw parser_error("FCS_SEGMENT_RANGE_INVALID", `FCS ${name} segment range is invalid.`);
  }
}

function validate_text_range(header, file_size = null, text_length = null) {
  validate_offset_pair(header.text_begin, header.text_end, "TEXT", file_size, { required: true });
  const expected_length = header.text_end - header.text_begin + 1;
  if (
    header.text_begin < 58
    || expected_length > FCS_LIMITS.maxTextBytes
    || (Number.isFinite(text_length) && text_length !== expected_length)
  ) {
    throw parser_error("FCS_SEGMENT_RANGE_INVALID", "FCS TEXT segment range is invalid.");
  }
}

function validate_fcs_summary(summary, file_size = null) {
  const { metadata, parameter_count, event_count, data_begin, data_end, analysis_begin, analysis_end } = summary;
  const data_type = keyword(metadata, "$DATATYPE", keyword(metadata, "DATATYPE", "F")).toUpperCase();
  if (!Number.isInteger(parameter_count) || parameter_count < 1 || !Number.isInteger(event_count) || event_count < 0) {
    throw parser_error("FCS_METADATA_INVALID", "FCS metadata has an invalid $PAR or $TOT value.");
  }
  if (parameter_count > FCS_LIMITS.maxParameters) {
    throw parser_error("FCS_PARAMETER_LIMIT_EXCEEDED", `FCS $PAR exceeds the ${FCS_LIMITS.maxParameters}-parameter limit.`);
  }
  if (event_count > FCS_LIMITS.maxEvents) {
    throw parser_error("FCS_EVENT_LIMIT_EXCEEDED", `FCS $TOT exceeds the ${FCS_LIMITS.maxEvents}-event limit.`);
  }
  is_little_endian(metadata);
  const event_byte_width = parameter_byte_widths(metadata, parameter_count, data_type)
    .reduce((total, width) => total + width, 0);
  const expected_length = event_count * event_byte_width;
  if (!Number.isSafeInteger(expected_length)) {
    throw parser_error("FCS_DATA_LENGTH_MISMATCH", "Declared FCS DATA size exceeds the safe allocation range.");
  }
  validate_offset_pair(data_begin, data_end, "DATA", null, { required: true });
  validate_offset_pair(analysis_begin, analysis_end, "ANALYSIS", file_size);
  if (analysis_begin > 0 && data_end >= analysis_begin) {
    throw parser_error("FCS_SEGMENT_OVERLAP", "FCS DATA segment overlaps the ANALYSIS segment.");
  }
  if (expected_length > FCS_LIMITS.maxDataBytes) {
    throw parser_error("FCS_DATA_LIMIT_EXCEEDED", `FCS DATA exceeds the ${FCS_LIMITS.maxDataBytes}-byte limit.`);
  }
  if (Number.isFinite(file_size) && data_begin >= file_size) {
    throw parser_error("FCS_SEGMENT_RANGE_INVALID", "FCS DATA segment range is invalid.");
  }
  if (Number.isFinite(file_size) && data_end >= file_size) {
    const declared_length = data_end - data_begin + 1;
    const available_length = file_size - data_begin;
    if (declared_length === expected_length && available_length < expected_length) {
      throw parser_error(
        "FCS_DATA_TRUNCATED",
        `FCS DATA has ${available_length} available bytes; ${expected_length} are required.`,
      );
    }
    throw parser_error("FCS_SEGMENT_RANGE_INVALID", "FCS DATA segment range is invalid.");
  }
  const actual_length = data_end - data_begin + 1;
  if (actual_length < expected_length) {
    const code = expected_length - actual_length <= event_byte_width
      ? "FCS_DATA_TRUNCATED"
      : "FCS_DATA_LENGTH_MISMATCH";
    throw parser_error(code, `FCS DATA has ${actual_length} bytes; ${expected_length} are required.`);
  }
  // Some cytometers include up to one alignment word of trailing DATA padding.
  if (actual_length - expected_length > 8) {
    throw parser_error(
      "FCS_DATA_LENGTH_MISMATCH",
      `FCS DATA has ${actual_length} bytes; metadata declares ${expected_length}.`,
    );
  }
  return summary;
}

/*

Purpose:
	Reads a single parameter value from the DATA view for the given data type.
	Throws on unsupported types.

Input:
	view [DataView]:          the data view
	offset [number]:          byte offset to read from
	byte_width [number]:      width in bytes (for integer types)
	data_type [string]:       "F", "D", or "I"
	little_endian [boolean]:  byte order

Output:
	value [number]: the parameter value

*/
function read_data_value(view, offset, byte_width, data_type, little_endian) {
  if (data_type === "F") {
    return view.getFloat32(offset, little_endian);
  }
  if (data_type === "D") {
    return view.getFloat64(offset, little_endian);
  }
  if (data_type === "I") {
    return integer_reader(view, offset, byte_width, little_endian);
  }

  throw new Error(`Unsupported FCS $DATATYPE: ${data_type}`);
}

/*

Purpose:
	Reads only the requested parameter columns from a DATA-segment buffer,
	walking each event's fixed-width stride and pulling just the selected
	offsets. Used during analysis to avoid loading unused channels.

Input:
	data_buffer [ArrayBuffer]:         the DATA segment bytes
	metadata [Object]:                 normalized metadata map
	selected_indexes [Array<number>]:  1-based parameter indexes to read

Output:
	columns [Object]: parameter index -> Array of per-event values

*/
function selected_column_plan(metadata, selected_indexes) {
  const parameter_count = Number(keyword(metadata, "$PAR", keyword(metadata, "PAR", "0")));
  const event_count = Number(keyword(metadata, "$TOT", keyword(metadata, "TOT", "0")));
  const data_type = keyword(metadata, "$DATATYPE", keyword(metadata, "DATATYPE", "F")).toUpperCase();
  if (!Number.isInteger(parameter_count) || parameter_count < 1 || parameter_count > FCS_LIMITS.maxParameters) {
    throw parser_error("FCS_METADATA_INVALID", "FCS metadata has an invalid $PAR value.");
  }
  if (!Number.isInteger(event_count) || event_count < 0 || event_count > FCS_LIMITS.maxEvents) {
    throw parser_error("FCS_METADATA_INVALID", "FCS metadata has an invalid $TOT value.");
  }
  const little_endian = is_little_endian(metadata);
  const byte_widths = parameter_byte_widths(metadata, parameter_count, data_type);
  const parameter_offsets = [];
  let event_byte_width = 0;

  byte_widths.forEach((byte_width) => {
    parameter_offsets.push(event_byte_width);
    event_byte_width += byte_width;
  });

  const required_bytes = event_count * event_byte_width;
  if (!Number.isSafeInteger(required_bytes)) {
    throw parser_error("FCS_DATA_LENGTH_MISMATCH", "Declared FCS DATA size exceeds the safe allocation range.");
  }
  const output_bytes = event_count * selected_indexes.length * Float64Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(output_bytes) || output_bytes > FCS_LIMITS.maxWorkingBytes) {
    throw parser_error(
      "FCS_MEMORY_LIMIT_EXCEEDED",
      "Selected FCS columns exceed the working-memory limit. Load fewer files at once or choose fewer companion channels.",
    );
  }

  const seen = new Set();
  const selected_parameters = selected_indexes.map((index) => {
    if (!Number.isInteger(index) || index < 1 || index > parameter_count) {
      throw parser_error("FCS_PARAMETER_SELECTION_INVALID", `Selected parameter index is out of range: ${index}`);
    }
    if (seen.has(index)) {
      throw parser_error("FCS_PARAMETER_SELECTION_INVALID", `Selected parameter index is duplicated: ${index}`);
    }
    seen.add(index);
    return {
      index,
      byte_offset: parameter_offsets[index - 1],
      byte_width: byte_widths[index - 1],
    };
  });

  return {
    data_type,
    little_endian,
    event_count,
    event_byte_width,
    required_bytes,
    output_bytes,
    selected_parameters,
  };
}

function decode_selected_chunk(data_buffer, plan, columns, output_offset, chunk_event_count) {
  const required_bytes = chunk_event_count * plan.event_byte_width;
  if (data_buffer.byteLength < required_bytes) {
    throw parser_error(
      "FCS_DATA_TRUNCATED",
      `FCS DATA chunk has ${data_buffer.byteLength} available bytes; ${required_bytes} are required.`,
    );
  }
  const view = new DataView(data_buffer, 0, required_bytes);

  for (let event_index = 0; event_index < chunk_event_count; event_index += 1) {
    const event_offset = event_index * plan.event_byte_width;

    plan.selected_parameters.forEach((parameter) => {
      columns[parameter.index][output_offset + event_index] = read_data_value(
        view,
        event_offset + parameter.byte_offset,
        parameter.byte_width,
        plan.data_type,
        plan.little_endian,
      );
    });
  }
}

function allocate_selected_columns(plan) {
  return Object.fromEntries(
    plan.selected_parameters.map(({ index }) => [index, new Float64Array(plan.event_count)]),
  );
}

function parse_selected_columns(data_buffer, metadata, selected_indexes) {
  const plan = selected_column_plan(metadata, selected_indexes);
  if (data_buffer.byteLength < plan.required_bytes) {
    throw parser_error(
      "FCS_DATA_TRUNCATED",
      `FCS DATA has ${data_buffer.byteLength} available bytes; ${plan.required_bytes} are required.`,
    );
  }
  const columns = allocate_selected_columns(plan);
  decode_selected_chunk(data_buffer, plan, columns, 0, plan.event_count);

  return columns;
}

export async function parse_selected_columns_from_blob(data_blob, metadata, selected_indexes, options = {}) {
  const plan = selected_column_plan(metadata, selected_indexes);
  if (!data_blob || data_blob.size < plan.required_bytes) {
    throw parser_error(
      "FCS_DATA_TRUNCATED",
      `FCS DATA has ${data_blob?.size ?? 0} available bytes; ${plan.required_bytes} are required.`,
    );
  }
  const chunk_bytes = Number.isFinite(options.chunkBytes) && options.chunkBytes > 0
    ? Math.floor(options.chunkBytes)
    : FCS_LIMITS.dataChunkBytes;
  const chunk_events = Math.max(1, Math.floor(chunk_bytes / plan.event_byte_width));
  const columns = allocate_selected_columns(plan);
  const started = globalThis.performance?.now?.() ?? Date.now();
  let chunks = 0;
  let peak_input_bytes = 0;

  for (let start = 0; start < plan.event_count; start += chunk_events) {
    if (options.signal?.aborted) {
      throw parser_error("FCS_LOAD_CANCELLED", "FCS data loading was cancelled; partial buffers were released.");
    }
    const count = Math.min(chunk_events, plan.event_count - start);
    const begin_byte = start * plan.event_byte_width;
    const end_byte = begin_byte + count * plan.event_byte_width;
    const buffer = await data_blob.slice(begin_byte, end_byte).arrayBuffer();
    peak_input_bytes = Math.max(peak_input_bytes, buffer.byteLength);
    decode_selected_chunk(buffer, plan, columns, start, count);
    chunks += 1;
  }

  return {
    columns,
    metrics: {
      chunks,
      sourceBytesRead: plan.required_bytes,
      peakInputBytes: peak_input_bytes,
      transferredBytes: plan.output_bytes,
      retainedBytes: plan.output_bytes,
      parseMilliseconds: (globalThis.performance?.now?.() ?? Date.now()) - started,
    },
  };
}

/*

Purpose:
	Full parse of an FCS file: header, TEXT metadata, and all event data.

Input:
	buffer [ArrayBuffer]: the FCS file bytes

Output:
	result [Object]: { header, metadata, rows, columns }

*/
function parse_fcs(buffer) {
  const header = parse_header(buffer);
  validate_text_range(header, buffer.byteLength);
  const text = read_ascii(buffer, header.text_begin, header.text_end);
  const metadata = parse_text_segment(text);
  const summary = summarize_fcs_header(header, metadata, buffer.byteLength);
  const parsed_data = parse_data(buffer, metadata, summary.data_begin, summary.data_end);

  return {
    header,
    metadata,
    rows: parsed_data.rows,
    columns: parsed_data.columns,
  };
}

/*

Purpose:
	Builds a lightweight summary (no event data) from a parsed header and
	metadata — columns, counts, and DATA offsets — used for fast initial loading.

Input:
	header [Object]:   parsed FCS header
	metadata [Object]: normalized metadata map

Output:
	summary [Object]: { header, metadata, columns, event_count, parameter_count, data_begin, data_end }

*/
function summarize_fcs_header(header, metadata, file_size = null) {
  const parameter_count = Number(keyword(metadata, "$PAR", keyword(metadata, "PAR", "0")));
  const event_count = Number(keyword(metadata, "$TOT", keyword(metadata, "TOT", "0")));
  const columns = parameter_columns(metadata, parameter_count || 0);
  const metadata_data_begin = parse_offset(keyword(metadata, "$BEGINDATA", ""), "$BEGINDATA");
  const metadata_data_end = parse_offset(keyword(metadata, "$ENDDATA", ""), "$ENDDATA");
  const metadata_analysis_begin = parse_offset(keyword(metadata, "$BEGINANALYSIS", ""), "$BEGINANALYSIS");
  const metadata_analysis_end = parse_offset(keyword(metadata, "$ENDANALYSIS", ""), "$ENDANALYSIS");
  const metadata_text_begin = parse_offset(keyword(metadata, "$BEGINTEXT", ""), "$BEGINTEXT");
  const metadata_text_end = parse_offset(keyword(metadata, "$ENDTEXT", ""), "$ENDTEXT");
  const supplemental_text_begin = parse_offset(keyword(metadata, "$BEGINSTEXT", ""), "$BEGINSTEXT");
  const supplemental_text_end = parse_offset(keyword(metadata, "$ENDSTEXT", ""), "$ENDSTEXT");
  if (supplemental_text_begin !== 0 || supplemental_text_end !== 0) {
    validate_offset_pair(supplemental_text_begin, supplemental_text_end, "supplemental TEXT", file_size, { required: true });
    throw parser_error(
      "FCS_SUPPLEMENTAL_TEXT_UNSUPPORTED",
      "Supplemental FCS TEXT is not supported. Export the file with all required keywords in the primary TEXT segment.",
    );
  }
  const reconcile = (name, header_begin, header_end, metadata_begin, metadata_end) => {
    const header_present = header_begin !== 0 || header_end !== 0;
    const metadata_present = metadata_begin !== 0 || metadata_end !== 0;
    if (header_present && metadata_present && (header_begin !== metadata_begin || header_end !== metadata_end)) {
      throw parser_error("FCS_OFFSET_CONFLICT", `FCS HEADER and TEXT ${name} offsets disagree.`);
    }
    return metadata_present ? [metadata_begin, metadata_end] : [header_begin, header_end];
  };
  reconcile("TEXT", header.text_begin, header.text_end, metadata_text_begin, metadata_text_end);
  const [data_begin, data_end] = reconcile(
    "DATA", header.data_begin, header.data_end, metadata_data_begin, metadata_data_end,
  );
  const [analysis_begin, analysis_end] = reconcile(
    "ANALYSIS", header.analysis_begin, header.analysis_end, metadata_analysis_begin, metadata_analysis_end,
  );

  return validate_fcs_summary({
    header,
    metadata,
    columns,
    event_count,
    parameter_count,
    data_begin,
    data_end,
    analysis_begin,
    analysis_end,
  }, file_size);
}

/*

Purpose:
	Parses just the header and TEXT metadata of an FCS buffer and returns the
	lightweight summary (no event data).

Input:
	buffer [ArrayBuffer]: the FCS file bytes

Output:
	summary [Object]: the metadata summary from summarize_fcs_header

*/
function parse_fcs_header(buffer) {
  const header = parse_header(buffer);
  validate_text_range(header, buffer.byteLength);
  const text = read_ascii(buffer, header.text_begin, header.text_end);
  const metadata = parse_text_segment(text);
  return summarize_fcs_header(header, metadata, buffer.byteLength);
}

/*

Purpose:
	Builds the metadata summary from separately sliced HEADER and TEXT buffers,
	so only those small segments need to be read from disk (fast loading).

Input:
	header_buffer [ArrayBuffer]: the 58-byte HEADER bytes
	text_buffer [ArrayBuffer]:   the TEXT segment bytes

Output:
	summary [Object]: the metadata summary from summarize_fcs_header

*/
function parse_fcs_header_from_segments(header_buffer, text_buffer, file_size = null) {
  const header = parse_header(header_buffer);
  validate_text_range(header, file_size, text_buffer.byteLength);
  const text = read_ascii(text_buffer, 0, text_buffer.byteLength - 1);
  const metadata = parse_text_segment(text);
  return summarize_fcs_header(header, metadata, file_size);
}

export const FCSParser = {
  parse_fcs,
  parse_fcs_header,
  parse_fcs_header_from_segments,
  parse_header,
  parse_selected_columns,
  parse_selected_columns_from_blob,
  channel_eligibility,
  supported_versions: SUPPORTED_FCS_VERSIONS,
  eligibility_states: CHANNEL_ELIGIBILITY_STATES,
  limits: FCS_LIMITS,
};
