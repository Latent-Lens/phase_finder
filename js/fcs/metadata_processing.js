// FCS metadata-entry creation from HEADER and TEXT segments. This file reads
// just enough of a dropped or selected FCS file to build the app's loaded-file
// entry without touching the event DATA segment. It parses the fixed header,
// validates the TEXT segment offsets, reads the TEXT bytes, and delegates the
// metadata summary to the FCS parser. It returns the generated id, original
// filename, File object, and parsed summary consumed by metadata IO and channel
// loading. Event arrays are intentionally loaded later by js/io/channel_loading.js.

import { FCSParser } from "./parser.js";
import { create_id } from "../ui/status_channels.js";

/*

Purpose:
	Reads only an FCS file's HEADER and TEXT segments to build a loaded-file
	entry (id, name, file, summary) without loading event data.

Input:
	file [File]: the FCS File object

Output:
	entry [Promise<Object>]: resolves to a loaded-file entry

*/
export async function read_fcs_header(file) {
  const header_buffer = await file.slice(0, 58).arrayBuffer();
  const header = FCSParser.parse_header(header_buffer);

  if (header.text_end < header.text_begin) {
    throw new Error("FCS header has an invalid TEXT segment range.");
  }

  const text_buffer = await file.slice(header.text_begin, header.text_end + 1).arrayBuffer();
  const summary = FCSParser.parse_fcs_header_from_segments(header_buffer, text_buffer);

  return {
    id: create_id(),
    name: file.name,
    file,
    summary,
  };
}
