// Worker-side selected-column FCS data reader. This file runs in a Web Worker
// scope and imports the shared FCS parser without depending on any browser UI
// globals. It receives a File, parsed FCS summary, and selected 1-based
// parameter indexes from the main thread. It slices the DATA segment, parses
// only those requested columns, converts them to Float64Array instances, and
// transfers the buffers back to avoid extra copies. Errors are posted back with
// the same request id so the main thread can reject the matching promise.

importScripts("./parser.js");

self.addEventListener("message", async (event) => {
  const { request_id, file, summary, selected_indexes } = event.data || {};

  try {
    const data_buffer = await file.slice(summary.data_begin, summary.data_end + 1).arrayBuffer();
    const parsed = globalThis.FCSParser.parse_selected_columns(data_buffer, summary.metadata, selected_indexes);
    const columns = {};
    const transfers = [];

    Object.entries(parsed).forEach(([index, values]) => {
      const typed = Float64Array.from(values);
      columns[index] = typed;
      transfers.push(typed.buffer);
    });

    self.postMessage({ request_id, ok: true, columns }, transfers);
  } catch (error) {
    self.postMessage({ request_id, ok: false, error: error.message || String(error) });
  }
});
