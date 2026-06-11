/*

Purpose:
	Decodes a byte range of an ArrayBuffer as ASCII text.

Input:
	buffer [ArrayBuffer]:  the file bytes
	begin [number]:        start byte offset (inclusive)
	endInclusive [number]: end byte offset (inclusive)

Output:
	text [string]: the decoded ASCII string

*/
function readAscii(buffer, begin, endInclusive) {
  return new TextDecoder("ascii").decode(buffer.slice(begin, endInclusive + 1));
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
function parseOffset(value) {
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
	header [Object]: { version, textBegin, textEnd, dataBegin, dataEnd, analysisBegin, analysisEnd }

*/
function parseHeader(buffer) {
  if (buffer.byteLength < 58) {
    throw new Error("FCS file is too small to contain a valid header.");
  }

  const header = readAscii(buffer, 0, 57);
  const version = header.slice(0, 6).trim();

  if (!version.startsWith("FCS")) {
    throw new Error("Selected file does not look like an FCS file.");
  }

  return {
    version,
    textBegin: parseOffset(header.slice(10, 18)),
    textEnd: parseOffset(header.slice(18, 26)),
    dataBegin: parseOffset(header.slice(26, 34)),
    dataEnd: parseOffset(header.slice(34, 42)),
    analysisBegin: parseOffset(header.slice(42, 50)),
    analysisEnd: parseOffset(header.slice(50, 58)),
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
function parseTextSegment(text) {
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
    const key = normalizeKeyword(values[index]);
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
function normalizeKeyword(key) {
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
  return metadata[normalizeKeyword(name)] ?? fallback;
}

/*

Purpose:
	Determines the data byte order from $BYTEORD, defaulting to little-endian.

Input:
	metadata [Object]: normalized metadata map

Output:
	littleEndian [boolean]: true if the data is little-endian

*/
function isLittleEndian(metadata) {
  const byteOrder = keyword(metadata, "$BYTEORD", keyword(metadata, "BYTEORD", "1,2,3,4"));
  return byteOrder === "1,2,3,4" || byteOrder === "1,2";
}

/*

Purpose:
	Builds the display label for each parameter, preferring $PnS, then $PnN,
	then a generated "P<n>" fallback.

Input:
	metadata [Object]:       normalized metadata map
	parameterCount [number]: number of parameters ($PAR)

Output:
	columns [Array<string>]: one label per parameter

*/
function parameterColumns(metadata, parameterCount) {
  return Array.from({ length: parameterCount }, (_, index) => {
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
	view [DataView]:        the data view over the DATA segment
	byteOffset [number]:    where to read from
	byteWidth [number]:     integer width in bytes
	littleEndian [boolean]: byte order

Output:
	value [number]: the unsigned integer value

*/
function integerReader(view, byteOffset, byteWidth, littleEndian) {
  if (byteWidth === 1) {
    return view.getUint8(byteOffset);
  }
  if (byteWidth === 2) {
    return view.getUint16(byteOffset, littleEndian);
  }
  if (byteWidth === 4) {
    return view.getUint32(byteOffset, littleEndian);
  }

  let value = 0;
  if (littleEndian) {
    for (let index = byteWidth - 1; index >= 0; index -= 1) {
      value = value * 256 + view.getUint8(byteOffset + index);
    }
  } else {
    for (let index = 0; index < byteWidth; index += 1) {
      value = value * 256 + view.getUint8(byteOffset + index);
    }
  }
  return value;
}

/*

Purpose:
	Reads the full list-mode DATA segment into per-event rows, supporting the
	F/D/I data types. Throws on missing $PAR/$TOT or an unsupported $DATATYPE.

Input:
	buffer [ArrayBuffer]: the FCS file bytes
	metadata [Object]:    normalized metadata map
	dataBegin [number]:   DATA segment start offset
	dataEnd [number]:     DATA segment end offset (inclusive)

Output:
	result [Object]: { rows [Array<Object>], columns [Array<string>] }

*/
function parseData(buffer, metadata, dataBegin, dataEnd) {
  const parameterCount = Number.parseInt(keyword(metadata, "$PAR", keyword(metadata, "PAR", "0")), 10);
  const eventCount = Number.parseInt(keyword(metadata, "$TOT", keyword(metadata, "TOT", "0")), 10);
  const dataType = keyword(metadata, "$DATATYPE", keyword(metadata, "DATATYPE", "F")).toUpperCase();
  const littleEndian = isLittleEndian(metadata);
  const columns = parameterColumns(metadata, parameterCount);
  const view = new DataView(buffer, dataBegin, dataEnd - dataBegin + 1);

  if (!parameterCount || !eventCount) {
    throw new Error("FCS metadata is missing $PAR or $TOT.");
  }

  let offset = 0;
  const rows = [];

  for (let eventIndex = 0; eventIndex < eventCount; eventIndex += 1) {
    const row = {};

    for (let parameterIndex = 0; parameterIndex < parameterCount; parameterIndex += 1) {
      const column = columns[parameterIndex];
      let value;

      if (dataType === "F") {
        value = view.getFloat32(offset, littleEndian);
        offset += 4;
      } else if (dataType === "D") {
        value = view.getFloat64(offset, littleEndian);
        offset += 8;
      } else if (dataType === "I") {
        const bits = Number.parseInt(keyword(metadata, `$P${parameterIndex + 1}B`, "32"), 10);
        const byteWidth = Math.ceil(bits / 8);
        value = integerReader(view, offset, byteWidth, littleEndian);
        offset += byteWidth;
      } else {
        throw new Error(`Unsupported FCS $DATATYPE: ${dataType}`);
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
	metadata [Object]:       normalized metadata map
	parameterCount [number]: number of parameters
	dataType [string]:       "F", "D", or "I"

Output:
	widths [Array<number>]: byte width per parameter

*/
function parameterByteWidths(metadata, parameterCount, dataType) {
  if (dataType === "F") {
    return Array.from({ length: parameterCount }, () => 4);
  }
  if (dataType === "D") {
    return Array.from({ length: parameterCount }, () => 8);
  }
  if (dataType === "I") {
    return Array.from({ length: parameterCount }, (_, index) => {
      const bits = Number.parseInt(keyword(metadata, `$P${index + 1}B`, "32"), 10);
      return Math.ceil(bits / 8);
    });
  }

  throw new Error(`Unsupported FCS $DATATYPE: ${dataType}`);
}

/*

Purpose:
	Reads a single parameter value from the DATA view for the given data type.
	Throws on unsupported types.

Input:
	view [DataView]:        the data view
	offset [number]:        byte offset to read from
	byteWidth [number]:     width in bytes (for integer types)
	dataType [string]:      "F", "D", or "I"
	littleEndian [boolean]: byte order

Output:
	value [number]: the parameter value

*/
function readDataValue(view, offset, byteWidth, dataType, littleEndian) {
  if (dataType === "F") {
    return view.getFloat32(offset, littleEndian);
  }
  if (dataType === "D") {
    return view.getFloat64(offset, littleEndian);
  }
  if (dataType === "I") {
    return integerReader(view, offset, byteWidth, littleEndian);
  }

  throw new Error(`Unsupported FCS $DATATYPE: ${dataType}`);
}

/*

Purpose:
	Reads only the requested parameter columns from a DATA-segment buffer,
	walking each event's fixed-width stride and pulling just the selected
	offsets. Used during analysis to avoid loading unused channels.

Input:
	dataBuffer [ArrayBuffer]:        the DATA segment bytes
	metadata [Object]:               normalized metadata map
	selectedIndexes [Array<number>]: 1-based parameter indexes to read

Output:
	columns [Object]: parameter index -> Array of per-event values

*/
function parseSelectedColumns(dataBuffer, metadata, selectedIndexes) {
  const parameterCount = Number.parseInt(keyword(metadata, "$PAR", keyword(metadata, "PAR", "0")), 10);
  const eventCount = Number.parseInt(keyword(metadata, "$TOT", keyword(metadata, "TOT", "0")), 10);
  const dataType = keyword(metadata, "$DATATYPE", keyword(metadata, "DATATYPE", "F")).toUpperCase();
  const littleEndian = isLittleEndian(metadata);
  const byteWidths = parameterByteWidths(metadata, parameterCount, dataType);
  const columns = {};
  const view = new DataView(dataBuffer);
  const parameterOffsets = [];
  let eventByteWidth = 0;

  byteWidths.forEach((byteWidth) => {
    parameterOffsets.push(eventByteWidth);
    eventByteWidth += byteWidth;
  });

  const selectedParameters = selectedIndexes.map((index) => {
    if (index < 1 || index > parameterCount) {
      throw new Error(`Selected parameter index is out of range: ${index}`);
    }

    columns[index] = new Array(eventCount);
    return {
      index,
      byteOffset: parameterOffsets[index - 1],
      byteWidth: byteWidths[index - 1],
    };
  });

  for (let eventIndex = 0; eventIndex < eventCount; eventIndex += 1) {
    const eventOffset = eventIndex * eventByteWidth;

    selectedParameters.forEach((parameter) => {
      columns[parameter.index][eventIndex] = readDataValue(
        view,
        eventOffset + parameter.byteOffset,
        parameter.byteWidth,
        dataType,
        littleEndian,
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
function parseFCS(buffer) {
  const header = parseHeader(buffer);
  const text = readAscii(buffer, header.textBegin, header.textEnd);
  const metadata = parseTextSegment(text);
  const dataBegin = parseOffset(keyword(metadata, "$BEGINDATA", header.dataBegin));
  const dataEnd = parseOffset(keyword(metadata, "$ENDDATA", header.dataEnd));
  const parsedData = parseData(buffer, metadata, dataBegin, dataEnd);

  return {
    header,
    metadata,
    rows: parsedData.rows,
    columns: parsedData.columns,
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
	summary [Object]: { header, metadata, columns, eventCount, parameterCount, dataBegin, dataEnd }

*/
function summarizeFCSHeader(header, metadata) {
  const parameterCount = Number.parseInt(keyword(metadata, "$PAR", keyword(metadata, "PAR", "0")), 10);
  const eventCount = Number.parseInt(keyword(metadata, "$TOT", keyword(metadata, "TOT", "0")), 10);
  const columns = parameterColumns(metadata, parameterCount || 0);
  const dataBegin = parseOffset(keyword(metadata, "$BEGINDATA", header.dataBegin));
  const dataEnd = parseOffset(keyword(metadata, "$ENDDATA", header.dataEnd));

  return {
    header,
    metadata,
    columns,
    eventCount,
    parameterCount,
    dataBegin,
    dataEnd,
  };
}

/*

Purpose:
	Parses just the header and TEXT metadata of an FCS buffer and returns the
	lightweight summary (no event data).

Input:
	buffer [ArrayBuffer]: the FCS file bytes

Output:
	summary [Object]: the metadata summary from summarizeFCSHeader

*/
function parseFCSHeader(buffer) {
  const header = parseHeader(buffer);
  const text = readAscii(buffer, header.textBegin, header.textEnd);
  const metadata = parseTextSegment(text);
  return summarizeFCSHeader(header, metadata);
}

/*

Purpose:
	Builds the metadata summary from separately sliced HEADER and TEXT buffers,
	so only those small segments need to be read from disk (fast loading).

Input:
	headerBuffer [ArrayBuffer]: the 58-byte HEADER bytes
	textBuffer [ArrayBuffer]:   the TEXT segment bytes

Output:
	summary [Object]: the metadata summary from summarizeFCSHeader

*/
function parseFCSHeaderFromSegments(headerBuffer, textBuffer) {
  const header = parseHeader(headerBuffer);
  const text = readAscii(textBuffer, 0, textBuffer.byteLength - 1);
  const metadata = parseTextSegment(text);
  return summarizeFCSHeader(header, metadata);
}

window.FCSParser = {
  parseFCS,
  parseFCSHeader,
  parseFCSHeaderFromSegments,
  parseHeader,
  parseSelectedColumns,
};
