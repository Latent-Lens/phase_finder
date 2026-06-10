function readAscii(buffer, begin, endInclusive) {
  return new TextDecoder("ascii").decode(buffer.slice(begin, endInclusive + 1));
}

function parseOffset(value) {
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

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

function normalizeKeyword(key) {
  return String(key || "")
    .trim()
    .replace(/^\$/, "")
    .replaceAll(" ", "_")
    .toUpperCase();
}

function keyword(metadata, name, fallback = "") {
  return metadata[normalizeKeyword(name)] ?? fallback;
}

function isLittleEndian(metadata) {
  const byteOrder = keyword(metadata, "$BYTEORD", keyword(metadata, "BYTEORD", "1,2,3,4"));
  return byteOrder === "1,2,3,4" || byteOrder === "1,2";
}

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

function parseFCSHeader(buffer) {
  const header = parseHeader(buffer);
  const text = readAscii(buffer, header.textBegin, header.textEnd);
  const metadata = parseTextSegment(text);
  return summarizeFCSHeader(header, metadata);
}

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
