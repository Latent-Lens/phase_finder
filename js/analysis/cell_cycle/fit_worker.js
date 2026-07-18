// Worker-side cell-cycle model fitting. Runs a registered model's fit()
// off the main thread so a slow fit (many LM iterations, future canonical
// models with more parameters/quadrature nodes) never blocks the UI. Mirrors
// the request_id-keyed message protocol established by js/fcs/data_worker.js.
//
// Message protocol:
//   in:  { type: "fit", request_id, modelId, histogram, config }
//        { type: "cancel", request_id }
//   out: { type: "progress", request_id, iteration, maxIterations, sse }
//        { type: "result", request_id, ok: true, result }
//        { type: "result", request_id, ok: false, error }

import { register_default_models, get_model } from "./model_registry.js";

register_default_models();

const cancelled_requests = new Set();

self.addEventListener("message", (event) => {
  const message = event.data || {};

  if (message.type === "cancel") {
    cancelled_requests.add(message.request_id);
    return;
  }

  if (message.type !== "fit") return;
  const { request_id, modelId, histogram, config } = message;

  try {
    const entry = get_model(modelId);
    if (!entry) {
      throw new Error(`Unknown model "${modelId}".`);
    }

    const rawResult = entry.fit({
      histogram,
      config: {
        ...config,
        onProgress: ({ iteration, maxIterations, sse }) => {
          self.postMessage({ type: "progress", request_id, iteration, maxIterations, sse });
        },
        shouldCancel: () => cancelled_requests.has(request_id),
      },
    });
    cancelled_requests.delete(request_id);

    // Some fit implementations (e.g. legacy_bridge_fit.js) record the exact
    // options object used into their diagnostics for audit purposes. That
    // object now carries the onProgress/shouldCancel closures above, which
    // postMessage's structured clone cannot serialize -- strip them from the
    // copy we send back. The full options (functions included) remain
    // available synchronously to any main-thread caller of entry.fit().
    if (rawResult?.diagnostics?.options) {
      delete rawResult.diagnostics.options.onProgress;
      delete rawResult.diagnostics.options.shouldCancel;
    }

    const result = entry.normalizeResult(rawResult);
    self.postMessage({ type: "result", request_id, ok: true, result });
  } catch (error) {
    cancelled_requests.delete(request_id);
    self.postMessage({
      type: "result",
      request_id,
      ok: false,
      error: error.message || String(error),
    });
  }
});
