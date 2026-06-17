importScripts("./fcs-parser.js");

self.addEventListener("message", async (event) => {
  const { requestId, file, summary, selectedIndexes } = event.data || {};

  try {
    const dataBuffer = await file.slice(summary.dataBegin, summary.dataEnd + 1).arrayBuffer();
    const parsed = globalThis.FCSParser.parseSelectedColumns(dataBuffer, summary.metadata, selectedIndexes);
    const columns = {};
    const transfers = [];

    Object.entries(parsed).forEach(([index, values]) => {
      const typed = Float64Array.from(values);
      columns[index] = typed;
      transfers.push(typed.buffer);
    });

    self.postMessage({ requestId, ok: true, columns }, transfers);
  } catch (error) {
    self.postMessage({ requestId, ok: false, error: error.message || String(error) });
  }
});
