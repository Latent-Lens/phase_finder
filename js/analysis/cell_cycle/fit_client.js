// Main-thread wrapper around fit_worker.js. Mirrors the lazy-singleton,
// graceful-fallback worker pattern established by
// js/io/channel_loading.js's get_fcs_data_worker() -- same philosophy, this
// time for model fitting instead of FCS column reads.

const FIT_WORKER_URL = new URL("./fit_worker.js", import.meta.url);

let fit_worker = null;
let fit_worker_request_id = 0;
let fit_worker_unavailable = false;
const fit_worker_requests = new Map();

/**
 * Returns the shared fit worker, creating it on first use. If worker
 * creation fails, run_fit_in_worker() returns null and callers should fall
 * back to fitting on the main thread.
 */
function get_fit_worker() {
  if (fit_worker_unavailable || typeof Worker === "undefined") {
    return null;
  }
  if (fit_worker) {
    return fit_worker;
  }

  try {
    fit_worker = new Worker(FIT_WORKER_URL, { type: "module" });
    fit_worker.addEventListener("message", (event) => {
      const message = event.data || {};
      const request = fit_worker_requests.get(message.request_id);
      if (!request) return;

      if (message.type === "progress") {
        request.onProgress?.({
          iteration: message.iteration,
          maxIterations: message.maxIterations,
          sse: message.sse,
        });
        return;
      }
      if (message.type === "result") {
        fit_worker_requests.delete(message.request_id);
        if (message.ok) {
          request.resolve(message.result);
        } else {
          request.reject(new Error(message.error || "Fit worker failed."));
        }
      }
    });
    fit_worker.addEventListener("error", () => {
      fit_worker_unavailable = true;
      fit_worker_requests.forEach((request) => {
        request.reject(new Error("Fit worker failed. Falling back on future fits."));
      });
      fit_worker_requests.clear();
      if (fit_worker) {
        fit_worker.terminate();
        fit_worker = null;
      }
    });
  } catch (error) {
    fit_worker_unavailable = true;
    fit_worker = null;
  }

  return fit_worker;
}

/**
 * Runs modelId's fit() in the worker for the given histogram/config.
 *
 * Input:
 *   modelId [string]: a registered model id (e.g. "legacy_bridge_v1")
 *   histogram [object]: a Stage 4-shaped histogram (x/y required)
 *   config [object]: model-specific fit config
 *   onProgress [function]: optional, called with {iteration, maxIterations, sse}
 *   peakRegions [object]: optional, { g1: {left,right}, g2: {left,right} } --
 *     required by Dean-Jett/Dean-Jett-Fox/Watson/auto_dj_djf, unused by
 *     legacy_bridge_v1
 *
 * Output:
 *   { promise, cancel } | null: null when no worker is available (caller
 *   should fall back to fitting on the main thread); otherwise a promise
 *   resolving to the model's normalized result, and a cancel() function.
 *
 * IMPORTANT cancellation caveat: a worker has one message queue processed
 * one message to completion at a time. runLevenbergMarquardt()'s iteration
 * loop is fully synchronous with no yield points, so the "fit" message
 * handler runs start-to-finish before the worker even looks at a queued
 * "cancel" message -- cancel() cannot interrupt a fit already in progress.
 * It only takes effect for a *model* that itself cooperates by checking
 * options.shouldCancel() at a real yield point (e.g. an async model with its
 * own await between iterations). None of today's registered models
 * (legacy_bridge_v1) do this, and a legacy_bridge_v1 fit typically completes
 * in single-digit milliseconds regardless. Making the LM solver
 * periodically yield so cancel() can interrupt an in-flight fit is real,
 * separate future work, not implied by this function existing.
 */
export function run_fit_in_worker(modelId, histogram, config, { onProgress, peakRegions } = {}) {
  const worker = get_fit_worker();
  if (!worker) return null;

  const request_id = ++fit_worker_request_id;
  const promise = new Promise((resolve, reject) => {
    fit_worker_requests.set(request_id, { resolve, reject, onProgress });
  });

  try {
    worker.postMessage({ type: "fit", request_id, modelId, histogram, peakRegions, config });
  } catch (error) {
    fit_worker_requests.delete(request_id);
    return null;
  }

  const cancel = () => {
    try {
      worker.postMessage({ type: "cancel", request_id });
    } catch (_) {
      // Worker already gone; nothing to cancel.
    }
  };

  return { promise, cancel };
}
