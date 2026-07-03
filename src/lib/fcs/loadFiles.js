import { FCSParser } from "./parser.js";

export function createId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `file-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function readFCSHeader(file, { makeId = createId } = {}) {
  const headerBuffer = await file.slice(0, 58).arrayBuffer();
  const header = FCSParser.parse_header(headerBuffer);

  if (header.text_end < header.text_begin) {
    throw new Error("FCS header has an invalid TEXT segment range.");
  }

  const textBuffer = await file.slice(header.text_begin, header.text_end + 1).arrayBuffer();
  const summary = FCSParser.parse_fcs_header_from_segments(headerBuffer, textBuffer);

  return {
    id: makeId(),
    name: file.name,
    file,
    summary,
  };
}

export async function loadFCSHeaders(files, options = {}) {
  const selectedFiles = Array.from(files || []);
  const existingNames = options.existingNames || new Set();
  const queuedNames = new Set();
  const entries = [];
  const rows = [];
  const failures = [];
  const duplicates = [];
  const onProgress = options.onProgress || (() => {});

  for (const [index, file] of selectedFiles.entries()) {
    const current = index + 1;
    onProgress({
      index,
      current,
      total: selectedFiles.length,
      file,
      phase: "start",
    });

    if (existingNames.has(file.name) || queuedNames.has(file.name)) {
      duplicates.push(file.name);
      onProgress({
        index,
        current,
        total: selectedFiles.length,
        file,
        phase: "duplicate",
      });
      continue;
    }

    try {
      const entry = await readFCSHeader(file, { makeId: options.makeId || createId });
      entries.push(entry);
      rows.push({ id: entry.id, name: entry.name });
      queuedNames.add(entry.name);
      onProgress({
        index,
        current,
        total: selectedFiles.length,
        file,
        phase: "loaded",
        entry,
      });
    } catch (error) {
      failures.push(`${file.name}: ${error.message}`);
      onProgress({
        index,
        current,
        total: selectedFiles.length,
        file,
        phase: "failed",
        error,
      });
    }
  }

  return {
    entries,
    rows,
    failures,
    duplicates,
  };
}
