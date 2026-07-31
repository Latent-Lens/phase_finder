// Web Worker that runs the CLOCCS joint fit off the main thread, so the (heavy,
// unverified) MAP optimisation never freezes the UI. It uses the cooperative
// async fit (models/cloccs.js fitCloccsForStrainAsync), which yields to the
// event loop between coordinate rounds -- that yield is what lets this worker
// receive and honour a "cancel" message mid-fit, giving real cancellation at
// round boundaries rather than only after the whole fit completes.
//
// Protocol (message.request_id ties replies to requests):
//   in:  { type:"fit", request_id, series, config }
//        { type:"cancel", request_id }
//   out: { type:"progress", request_id, progress }
//        { type:"result", request_id, ok:true, result }        (result.sampleParameters is a plain object)
//        { type:"cancelled", request_id }
//        { type:"error", request_id, ok:false, message }

import { fitCloccsForStrainAsync } from "./models/cloccs.js";
import { is_worker_message, worker_message } from "../../util/worker_protocol.js";

// request_id -> true while a cancel has been requested for that fit.
const cancelled = new Set();

// Maps are structured-cloneable, but a plain object is friendlier for the UI and
// for session/report serialisation, so flatten sampleParameters before posting.
function serializeResult(result) {
  return { ...result, sampleParameters: Object.fromEntries(result.sampleParameters) };
}

self.onmessage = async (event) => {
  const message = event.data || {};
  const { type, request_id } = message;

  if (!is_worker_message(message, ["fit", "cancel"])) {
    self.postMessage(worker_message("error", Number.isInteger(request_id) ? request_id : -1, {
      ok: false,
      code: "WORKER_PROTOCOL_MISMATCH",
      message: "Unsupported CLOCCS-worker message protocol.",
    }));
    return;
  }

  if (type === "cancel") {
    cancelled.add(request_id);
    return;
  }
  if (type !== "fit") return;

  cancelled.delete(request_id);
  try {
    const result = await fitCloccsForStrainAsync(message.series, message.config, {
      onProgress: (progress) => self.postMessage(worker_message("progress", request_id, { progress })),
      shouldCancel: () => cancelled.has(request_id),
    });
    if (result && result.cancelled) {
      self.postMessage(worker_message("cancelled", request_id));
    } else {
      self.postMessage(worker_message("result", request_id, { ok: true, result: serializeResult(result) }));
    }
  } catch (error) {
    self.postMessage(worker_message("error", request_id, { ok: false, code: error.code || "CLOCCS_WORKER_FAILED", message: error.message }));
  } finally {
    cancelled.delete(request_id);
  }
};
