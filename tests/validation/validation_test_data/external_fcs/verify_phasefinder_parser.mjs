#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";


const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../..");
const parserSource = await readFile(path.join(root, "js/fcs/parser.js"), "utf8");
const { FCSParser } = await import(`data:text/javascript;base64,${Buffer.from(parserSource).toString("base64")}`);
const manifest = JSON.parse(await readFile(path.join(here, "manifest.json"), "utf8"));

const records = [
  ...manifest.fixtures,
  ...manifest.published_datasets.flatMap(dataset => dataset.artifacts.filter(artifact => artifact.kind === "fcs")),
];

for (const record of records) {
  const file = await readFile(path.join(here, record.path));
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  const summary = FCSParser.parse_fcs_header(buffer);
  const expected = record.format;
  if (summary.header.version !== expected.fcs_version ||
      summary.event_count !== expected.events ||
      summary.parameter_count !== expected.parameters ||
      summary.metadata.DATATYPE !== expected.datatype ||
      summary.metadata.BYTEORD !== expected.byte_order) {
    throw new Error(`${record.path}: PhaseFinder header summary mismatch`);
  }

  const required = expected.required_markers || [summary.columns[0], summary.columns.at(-1)];
  const indexes = required.map(marker => {
    const index = summary.columns.indexOf(marker);
    if (index < 0) throw new Error(`${record.path}: missing required marker ${marker}`);
    return index + 1;
  });
  const data = buffer.slice(summary.data_begin, summary.data_end + 1);
  const selected = FCSParser.parse_selected_columns(data, summary.metadata, indexes);
  for (const index of indexes) {
    if (selected[index].length !== expected.events || !selected[index].every(Number.isFinite)) {
      throw new Error(`${record.path}: selected channel ${index} did not decode cleanly`);
    }
  }
}

console.log(`PASS: PhaseFinder parsed ${records.length} non-synthetic FCS files`);
