// Main-thread wrapper around fit_worker.js: it runs cell-cycle model fits off
// the main thread across a small POOL of workers, so a bulk fit of several
// samples runs several fits in parallel instead of one at a time. run_fit_in_worker()
// dispatches one fit to the least-loaded worker and returns a { promise, cancel }
// handle; the pool is created lazily and falls back gracefully (returns null, so
// the caller fits on the main thread) when workers are unavailable.
//
// Each fit is independent and mutates only its own sample's state, so routing
// different samples to different workers is safe. Pool size scales with the
// machine: a fraction of the logical cores (see POOL_FRACTION), always leaving at
// least one core for the UI thread. The pool grows lazily and never exceeds the
// number of samples actually being fit, so a big machine only spins up as many
// workers as there is work.

// Fraction of the machine's logical cores to devote to parallel fits. Kept below
// 1 so the main/UI thread (and other tabs/apps) keep headroom. Tune here: 0.5
// (default) is conservative and leaves half the cores free, 0.75 uses most of
// them, closer to 1 is aggressive.
const POOL_FRACTION = 0.5;

// When navigator.hardwareConcurrency is unavailable, assume a modest 4-core
// machine rather than guessing high.
const ASSUMED_CORES = 4;

/*

Purpose:
	Pure worker-pool sizing policy: how many parallel fit workers to allow for a
	given logical-core count. Uses POOL_FRACTION of the cores, always leaves at
	least one core for the main/UI thread, and always allows at least one worker.
	An invalid/missing core count falls back to ASSUMED_CORES. Exported so the
	policy can be unit-tested deterministically without a real navigator.

Input:
	logicalCores [number|undefined]: navigator.hardwareConcurrency, or undefined
	fraction [number]: the core fraction to use (defaults to POOL_FRACTION)

Output:
	size [number]: the pool size (integer >= 1)

*/
export function compute_pool_size(logicalCores, fraction = POOL_FRACTION) {
  const cores = Number.isFinite(logicalCores) && logicalCores >= 1
    ? Math.floor(logicalCores)
    : ASSUMED_CORES;
  const leaveOneForUI = Math.max(1, cores - 1);
  return Math.max(1, Math.min(leaveOneForUI, Math.round(cores * fraction)));
}

const POOL_SIZE = compute_pool_size(
  typeof navigator !== "undefined" && navigator.hardwareConcurrency
    ? navigator.hardwareConcurrency
    : undefined,
);

let pool = null; // array of { worker, inFlight } entries, or null before creation
let pool_unavailable = false;
let fit_worker_request_id = 0;
// request_id -> { resolve, reject, onProgress, entry }. Shared across the pool;
// each worker's message handler looks the request up here by id.
const fit_worker_requests = new Map();

/*

Purpose:
	The number of fits that can run in parallel (the worker-pool size), so a bulk
	caller can bound its concurrent dispatch to match.

Output:
	size [number]: the pool size (>= 1)

*/
export function fit_pool_size() {
  return POOL_SIZE;
}

// Rejects and clears every in-flight request belonging to one worker entry
// (used when that worker errors out).
function fail_entry_requests(entry, message) {
  for (const [id, request] of [...fit_worker_requests]) {
    if (request.entry === entry) {
      fit_worker_requests.delete(id);
      request.reject(new Error(message));
    }
  }
}

function make_worker_entry() {
  // The `new URL(...)` MUST stay inline (a bundler only recognises this exact
  // literal form as a worker entry point) -- same rule as the FCS data worker.
  const worker = new Worker(new URL("./fit_worker.js", import.meta.url), { type: "module" });
  const entry = { worker, inFlight: 0 };

  worker.addEventListener("message", (event) => {
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
      entry.inFlight = Math.max(0, entry.inFlight - 1);
      if (message.ok) {
        request.resolve(message.result);
      } else {
        request.reject(new Error(message.error || "Fit worker failed."));
      }
    }
  });

  worker.addEventListener("error", () => {
    // This worker died: reject its in-flight fits and drop it from the pool. The
    // remaining workers keep serving; if the pool empties, mark it unavailable so
    // callers fall back to the main thread.
    fail_entry_requests(entry, "Fit worker failed.");
    try {
      worker.terminate();
    } catch (_) {
      /* already gone */
    }
    if (pool) pool = pool.filter((candidate) => candidate !== entry);
    if (pool && pool.length === 0) {
      pool_unavailable = true;
      pool = null;
    }
  });

  return entry;
}

// The worker currently handling the fewest fits -- balances a bulk batch across
// the pool even when fits finish at different times.
function least_loaded(entries) {
  let best = entries[0];
  for (const entry of entries) if (entry.inFlight < best.inFlight) best = entry;
  return best;
}

// Picks a worker for the next fit, growing the pool lazily: reuse an idle worker
// when one exists; otherwise spawn a new worker up to POOL_SIZE (so a single fit
// only ever creates one worker, and a bulk batch grows the pool on demand); once
// at the cap, hand the fit to the least-loaded worker. Returns null when no
// worker can be created (caller falls back to the main thread).
function acquire_worker() {
  if (pool_unavailable || typeof Worker === "undefined") return null;
  if (!pool) pool = [];

  const idle = pool.find((entry) => entry.inFlight === 0);
  if (idle) return idle;

  if (pool.length < POOL_SIZE) {
    try {
      const entry = make_worker_entry();
      pool.push(entry);
      return entry;
    } catch (_) {
      if (pool.length === 0) {
        pool_unavailable = true;
        pool = null;
      }
      // Fall through to reuse an existing worker if we have one.
    }
  }
  return pool && pool.length ? least_loaded(pool) : null;
}

/*

Purpose:
	Runs a model's fit() in the worker pool for a given histogram and config.

	Cancellation caveat: a worker processes its message queue one message to
	completion at a time, and the Levenberg-Marquardt loop is fully synchronous
	with no yield points, so the "fit" handler runs start-to-finish before the
	worker reads a queued "cancel". cancel() therefore only takes effect for a
	model that itself checks options.shouldCancel() at a real yield point.

Input:
	modelId [string]: a registered model id (e.g. "legacy_bridge_v1")
	histogram [object]: a masked histogram (x/y required)
	config [object]: model-specific fit config
	options [object]: optional { onProgress(iteration,maxIterations,sse),
	                  peakRegions: { g1:{left,right}, g2:{left,right} } }

Output:
	handle [object|null]: { promise, cancel } -- promise resolves to the model's
	                      normalized result -- or null when no worker is
	                      available (caller should fit on the main thread)

*/
export function run_fit_in_worker(modelId, histogram, config, { onProgress, peakRegions } = {}) {
  const entry = acquire_worker();
  if (!entry) return null;

  const request_id = ++fit_worker_request_id;
  const promise = new Promise((resolve, reject) => {
    fit_worker_requests.set(request_id, { resolve, reject, onProgress, entry });
  });

  try {
    entry.inFlight += 1;
    entry.worker.postMessage({ type: "fit", request_id, modelId, histogram, peakRegions, config });
  } catch (_) {
    fit_worker_requests.delete(request_id);
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    return null;
  }

  const cancel = () => {
    try {
      entry.worker.postMessage({ type: "cancel", request_id });
    } catch (_) {
      // Worker already gone; nothing to cancel.
    }
  };

  return { promise, cancel };
}
