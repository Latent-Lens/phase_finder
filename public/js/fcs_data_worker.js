importScripts("./fcs-parser.js");

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
