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

/*

Purpose:
	Parses a header offset field into an integer, returning 0 when it is not a
	valid number.

Input:
	value [string|number]: a raw header offset field

Output:
	offset [number]: the parsed integer, or 0 if invalid

*/
function parse_offset(value) {
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(parsed) ? parsed : 0;
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
    throw new Error("FCS file is too small to contain a valid header.");
  }

  const header = read_ascii(buffer, 0, 57);
  const version = header.slice(0, 6).trim();

  if (!version.startsWith("FCS")) {
    throw new Error("Selected file does not look like an FCS file.");
  }

  return {
    version,
    text_begin: parse_offset(header.slice(10, 18)),
    text_end: parse_offset(header.slice(18, 26)),
    data_begin: parse_offset(header.slice(26, 34)),
    data_end: parse_offset(header.slice(34, 42)),
    analysis_begin: parse_offset(header.slice(42, 50)),
    analysis_end: parse_offset(header.slice(50, 58)),
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
  return byte_order === "1,2,3,4" || byte_order === "1,2";
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
  const parameter_count = Number.parseInt(keyword(metadata, "$PAR", keyword(metadata, "PAR", "0")), 10);
  const event_count = Number.parseInt(keyword(metadata, "$TOT", keyword(metadata, "TOT", "0")), 10);
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
      const bits = Number.parseInt(keyword(metadata, `$P${index + 1}B`, "32"), 10);
      return Math.ceil(bits / 8);
    });
  }

  throw new Error(`Unsupported FCS $DATATYPE: ${data_type}`);
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
function parse_selected_columns(data_buffer, metadata, selected_indexes) {
  const parameter_count = Number.parseInt(keyword(metadata, "$PAR", keyword(metadata, "PAR", "0")), 10);
  const event_count = Number.parseInt(keyword(metadata, "$TOT", keyword(metadata, "TOT", "0")), 10);
  const data_type = keyword(metadata, "$DATATYPE", keyword(metadata, "DATATYPE", "F")).toUpperCase();
  const little_endian = is_little_endian(metadata);
  const byte_widths = parameter_byte_widths(metadata, parameter_count, data_type);
  const columns = {};
  const view = new DataView(data_buffer);
  const parameter_offsets = [];
  let event_byte_width = 0;

  byte_widths.forEach((byte_width) => {
    parameter_offsets.push(event_byte_width);
    event_byte_width += byte_width;
  });

  const selected_parameters = selected_indexes.map((index) => {
    if (index < 1 || index > parameter_count) {
      throw new Error(`Selected parameter index is out of range: ${index}`);
    }

    columns[index] = new Array(event_count);
    return {
      index,
      byte_offset: parameter_offsets[index - 1],
      byte_width: byte_widths[index - 1],
    };
  });

  for (let event_index = 0; event_index < event_count; event_index += 1) {
    const event_offset = event_index * event_byte_width;

    selected_parameters.forEach((parameter) => {
      columns[parameter.index][event_index] = read_data_value(
        view,
        event_offset + parameter.byte_offset,
        parameter.byte_width,
        data_type,
        little_endian,
      );
    });
  }

  return columns;
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
  const text = read_ascii(buffer, header.text_begin, header.text_end);
  const metadata = parse_text_segment(text);
  const data_begin = parse_offset(keyword(metadata, "$BEGINDATA", header.data_begin));
  const data_end = parse_offset(keyword(metadata, "$ENDDATA", header.data_end));
  const parsed_data = parse_data(buffer, metadata, data_begin, data_end);

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
function summarize_fcs_header(header, metadata) {
  const parameter_count = Number.parseInt(keyword(metadata, "$PAR", keyword(metadata, "PAR", "0")), 10);
  const event_count = Number.parseInt(keyword(metadata, "$TOT", keyword(metadata, "TOT", "0")), 10);
  const columns = parameter_columns(metadata, parameter_count || 0);
  const data_begin = parse_offset(keyword(metadata, "$BEGINDATA", header.data_begin));
  const data_end = parse_offset(keyword(metadata, "$ENDDATA", header.data_end));

  return {
    header,
    metadata,
    columns,
    event_count,
    parameter_count,
    data_begin,
    data_end,
  };
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
  const text = read_ascii(buffer, header.text_begin, header.text_end);
  const metadata = parse_text_segment(text);
  return summarize_fcs_header(header, metadata);
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
function parse_fcs_header_from_segments(header_buffer, text_buffer) {
  const header = parse_header(header_buffer);
  const text = read_ascii(text_buffer, 0, text_buffer.byteLength - 1);
  const metadata = parse_text_segment(text);
  return summarize_fcs_header(header, metadata);
}

export const FCSParser = {
  parse_fcs,
  parse_fcs_header,
  parse_fcs_header_from_segments,
  parse_header,
  parse_selected_columns,
};
