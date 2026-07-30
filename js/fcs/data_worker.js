// Worker-side selected-column FCS data reader. This module runs in a Web Worker
// scope and imports the shared FCS parser without depending on any browser UI
// globals. It receives a File, parsed FCS summary, and selected 1-based
// parameter indexes from the main thread. It slices the DATA segment, parses
// only those requested columns, converts them to Float64Array instances, and
// transfers the buffers back to avoid extra copies. Errors are posted back with
// the same request id so the main thread can reject the matching promise. It is
// instantiated as a module worker so it can import the shared parser directly.

import { FCSParser } from "./parser.js";

const active = new Map();

self.addEventListener("message", async (event) => {
  const { type = "parse", request_id, file, summary, selected_indexes } = event.data || {};
  if (type === "cancel") {
    active.get(request_id)?.abort();
    return;
  }

  const controller = new AbortController();
  active.set(request_id, controller);

  try {
    const { columns, metrics } = await FCSParser.parse_selected_columns_from_blob(
      file.slice(summary.data_begin, summary.data_end + 1),
      summary.metadata,
      selected_indexes,
      { signal: controller.signal },
    );
    self.postMessage(
      { request_id, ok: true, columns, metrics },
      Object.values(columns).map((values) => values.buffer),
    );
  } catch (error) {
    self.postMessage({ request_id, ok: false, code: error.code, error: error.message || String(error) });
  } finally {
    active.delete(request_id);
  }
});
