# PhaseFinder — JavaScript Restructuring to ES Modules (self-contained execution plan)

> **For the implementing agent:** This document is a complete, standalone spec.
> Every decision below is final — do not re-ask the user. Read `onboarding.md`
> (the architectural map of `js/`) alongside this file; it grounds every claim
> here (load order, cross-file contracts, event-flow traces, the two flagged
> defects). Work on branch `esm-restructure`, commit at the breakpoints in the
> Migration Order, and do **not** push or open a PR.

## Context

PhaseFinder's `js/` layer is 31 files loaded as plain, ordered `<script src>`
tags (`index.html:421–450`). As classic scripts they share one global scope, so
correctness depends on a fragile hand-maintained load order plus a web of
implicit globals (`file_map`, `file_table_frame`, plot/table state, panel DOM
refs) and `window.PhaseFinder*` namespaces. `onboarding.md` documents the exact
ordering constraints and cross-file contracts and flags this coupling as the main
structural risk (including a dangling `getFileHandleByRelativePath` reference and
H/W-companion logic duplicated between `fcs/channel_cleaning.js` and
`analysis/djf.js`).

**Goal:** convert to native ES modules with an explicit dependency graph,
module-scoped state behind accessors, and a single ordered bootstrap — **with no
build step** (native ESM needs no bundler, preserving the "no build pipeline"
ethos). The domain-oriented folder layout (`fcs/ data_structs/ io/ ui/ analysis/
plotting/ session/`) is kept.

## Locked decisions

1. **Require an HTTP server.** ESM cannot load over `file://` (CORS). Direct
   file:// open is dropped; README updated to require `python3 -m http.server`.
2. **Import map + vendored libs.** d3, ml-levenberg-marquardt, ml-gsd become real
   `import`s via an HTML import map pointing at **locally vendored** ESM builds in
   `js/vendor/` (offline, deterministic, no runtime CDN dependency). The async
   soft-load race is removed; the ml-* "fit falls back if not loaded yet" guards
   become dead code and are deleted.
3. **State owned in modules with accessors.** Each cluster of shared mutable
   globals moves into a dedicated module exporting getters/setters. Consumers
   import accessors instead of touching globals.
4. **Global API = one deliberate debug hook.** Internal wiring is 100% ES imports.
   Expose a single documented namespace `window.PhaseFinder = { app, djf, plot }`
   as an intentional test/automation/debug seam — nothing else on `window`.
   Rewrite the handful of test accessors to use it.
5. **Single entry file.** `main.js` is repurposed as the `<script type="module">`
   target and owns the ordered `init_*()` bootstrap. **No separate `app.js`.**
   Shared state lives in state modules that `main.js` imports.
6. **Rename all flagged-misleading files** (see rename table).
7. **Include both cleanups** (dangling ref + H/W dedup).
8. **Module workers** for both `data_worker.js` and `copy_worker.js`.
9. **Git:** work on branch `esm-restructure`, commit at the migration breakpoints,
   **do not push** or open a PR.
10. **Verify:** run the Playwright suite via `/tmp/flowvenv` if present; otherwise
    fall back to manual http.server smoke checks. Report which path was used.
11. **Lazy-load the DJF + ml-* stack (core scope).** `analysis/djf.js` and the two
    ml-* libraries load via dynamic `import()` on the first modeling action, not at
    startup — the heaviest optional dependencies stay off the initial load path.

---

## Target architecture

One-directional dependency graph enforced by imports — inner layers must not
import outer ones:

```
core/domain (pure, no DOM)   fcs/parser, fcs/channel_cleaning, analysis/djf,
                             data_structs/metadata_frame, data_structs/metadata_columns,
                             session/toml_io
      ▲
state (owned mutable state)  state/app_state (file_map + file_table_frame),
                             data_structs/table_state, data_structs/channel_cache,
                             plotting/data (plot state), ui/panels (DOM refs)
      ▲
io/adapters (browser APIs)   fcs/metadata_processing, io/metadata_io,
                             io/channel_loading, io/parameter_map, session/opfs_fs,
                             session/file_cache, session/reconnect, + module workers
      ▲
ui (DOM)                     ui/*, plotting/render, plotting/modeling,
                             plotting/axis_modal, analysis/start, analysis/stats
      ▲
entry                        js/main.js  (state wiring + init_*() bootstrap +
                                          window.PhaseFinder debug hook)
```

- **Pure modules** (`export function …`) have no module-eval side effects; safe to
  import anywhere.
- **Side-effecting wiring** (listener registration, IIFEs, `main.js`'s trailing
  bootstrap) is refactored into exported `init_*()` functions, invoked in one
  place by `main.js` in explicit dependency order — replacing the `<script>`
  ordering contract.

## File renames

| From | To | Why (per onboarding.md) |
|---|---|---|
| `js/io/cache.js` | `js/io/parameter_map.js` | "Despite the filename, this is not the event-data cache" — it holds `parameter_map`/`find_param_index`/`unique_indexes`. |
| `js/session/store.js` | `js/session/opfs_fs.js` | Low-level OPFS filesystem wrapper (`window.PhaseFinderOPFS`); name collided conceptually with `opfs.js`. |
| `js/session/opfs.js` | `js/session/file_cache.js` | Higher-level file-caching/reconnect orchestration, not the OPFS primitive. |

Update all import paths and the `index.html` reference accordingly.

---

## Conversion mechanics

### 1. `index.html` — entry + import map

Replace the 31 `<script src>` tags **and** the two head shims with:

```html
<script type="importmap">
{ "imports": {
    "d3": "./js/vendor/d3.min.js",
    "ml-levenberg-marquardt": "./js/vendor/ml-levenberg-marquardt.js",
    "ml-gsd": "./js/vendor/ml-gsd.js"
} }
</script>
<script type="module" src="./js/main.js"></script>
```

- Vendor step: download the ESM builds into `js/vendor/`
  (d3@7 `+esm`, ml-levenberg-marquardt@4, ml-gsd@13). Keep the d3 classic CDN
  `<script>` removed.
- `type="module"` is deferred → runs after HTML parse, so the top-level
  `document.querySelector` DOM-ref captures in `main.js`, `panels.js`,
  `plotting/data.js` keep working unchanged.
- Add `<link rel="modulepreload" href="./js/main.js">` (and optionally for the
  heaviest leaf modules) to flatten the module-fetch waterfall — see Performance.

### 2. Pure/domain modules — exports only

Drop IIFE / `window.X = {…}` wrappers; use named `export`s; import at call sites.
- `analysis/djf.js`: `export` the numeric API (`prepare_row`, `fit`, `components`,
  `phase_stats`, …). **Lazily** import `LevenbergMarquardt` from
  `"ml-levenberg-marquardt"` and `gsd` from `"ml-gsd"` — see §8 (djf.js itself is
  loaded on demand, so its ml-* imports come with it). **Delete** the
  `typeof window.gsd` / `!LM` fallback guards (the loader in §8 guarantees the
  stack is present before any fit runs). Import the H/W-companion helpers from
  `fcs/channel_cleaning.js` and delete the private duplicate (cleanup #2).
- `fcs/parser.js`: `export` the `FCSParser` API (consumed by the module worker).
- `data_structs/metadata_frame.js`, `data_structs/metadata_columns.js`,
  `session/toml_io.js`, `fcs/channel_cleaning.js`, `io/parameter_map.js`: named exports.
- `plotting/render.js`, `plotting/modeling.js`, `plotting/axis_modal.js`,
  `plotting/data.js`: `import * as d3 from "d3"` instead of reading `window.d3`.

### 3. State modules with accessors (core coupling fix)

| Owning module | State moved in | Accessors |
|---|---|---|
| `js/state/app_state.js` (new) | `file_map`, `file_table_frame` (from `main.js`) | `get_file_map`, `get_file_table`, `set_file_table`, mutation helpers |
| `data_structs/table_state.js` | `TABLE_COLUMNS`, `selected_file_ids`, `column_filters`, `sort_state`, `open_filter_field` (+ existing fns) | export each + existing helpers |
| `plotting/data.js` | `plot_channels`, `modeling_started`, `shown_fits`, `peak_threshold`, `last_series`, `series_by_name`, `histograms_by_name`, `axis_range_override` | getters + **setters** (e.g. `set_peak_threshold`) |
| `ui/panels.js` | `analysis_start_button`, `plot_panel`, … DOM refs | `export const` each (parse-time querySelector stays, module-scoped) |
| `session/file_cache.js` | `file_records`, `esc`, `human_size`, `copy_file_to_opfs`, `idb_get/put`, … | named exports (consumed by `reconnect.js`, `main.js`) |

Use **setter functions** for anything reassigned across modules (importers get
read-only live bindings) — e.g. `peak_threshold = null` in `axis_modal.js`
becomes `set_peak_threshold(null)`. Read-only shared bindings can stay exported
`const`/`let`.

### 4. `main.js` — entry, state wiring, debug hook

- Sources data from `state/app_state.js` instead of local globals. Internal
  callers import functions directly (drop the `window.PhaseFinderApp.*`
  indirection on hot paths).
- Wrap trailing bootstrap lines (`main.js:363–367`) in `export`ed init and call
  from the bootstrap sequence.
- At the end of the bootstrap, assign the **single** debug hook:
  ```js
  window.PhaseFinder = { app: app_api, djf: DJF, plot: plot_api };
  ```
  Remove all other `window.PhaseFinder*` assignments across the codebase.
- Bootstrap sequence (order from onboarding.md's real data dependencies, not file
  position):
  ```js
  init_tooltips();            // ui/hover_text.js IIFE → init
  init_app_bootstrap();       // main.js trailing lines
  init_plot_listeners();      // plotting/axis_modal.js listener block
  init_analysis_listeners();  // analysis/start.js listener block
  init_stats();               // analysis/stats.js IIFE
  init_panel_resize();        // ui/panel_resize.js IIFE
  init_session();             // session/core.js wiring + try_autoload
  ```

### 5. Module workers

- `fcs/data_worker.js`: module worker. Replace `importScripts("./parser.js")`
  with `import { FCSParser } from "./parser.js"`. Instantiate with
  `new Worker(FCS_DATA_WORKER_URL, { type: "module" })` at `io/channel_loading.js:41`.
- `session/copy_worker.js`: also a module worker (`{ type: "module" }` at
  `session/file_cache.js` ~line 236), for uniformity.
- Import maps don't apply inside workers, but both only import local files — fine.

### 6. Side-effecting UI files → `init_*()`

`ui/hover_text.js`, `ui/panel_resize.js`, `analysis/start.js` (listener block
~213–243), `plotting/axis_modal.js` (listener block ~96–107),
`analysis/stats.js`, `session/core.js` (button wiring + `try_autoload`): each
side-effect block becomes an exported `init_*()` called from `main.js`.

### 7. Cleanups (in scope)

- **Dangling ref:** `session/reconnect.js:154` `getFileHandleByRelativePath` is
  undefined (silently caught today). Under ESM it surfaces as an unresolved
  import — either implement it or delete the dead try-branch (keep the
  `getFileHandle(record.original_name)` fallback).
- **Dedup — decided:** keep `fcs/channel_cleaning.js`'s implementation
  (`normalize_measurement_name`, `measurement_kind`, `measurement_base`,
  `find_linked_measurement_param`, `find_auxiliary_indexes_for_file`) as the one
  surviving implementation. **Delete** `analysis/djf.js`'s private copy
  (`normalize_name`, `measurement_kind`, `measurement_base`, `find_linked_param`,
  `find_auxiliary_indexes`, lines ~579–646) entirely — no behavior-preserving
  wrapper duplicating the tokenizer, just an import.

  **Why `channel_cleaning.js`'s version wins, not just "pick one":** a
  side-by-side comparison (written to `for_review.js` at the repo root during
  planning; safe to delete once this step is done) found the two tokenizers are
  **not** equivalent. `channel_cleaning.js` replaces `area`/`height`/`width`
  with `\b`-anchored word-boundary regexes (`/\bwidth\b/g`), so the substring
  inside a longer word is left alone. `djf.js` replaces `AREA|HEIGHT|WIDTH`
  with **no** word-boundary anchor, so it matches and splits on those letters
  anywhere they occur — e.g. a channel literally named `"Bandwidth-A"` would
  have "width" carved out of the middle of "Bandwidth" by djf.js's version but
  not by channel_cleaning.js's. The `\b`-anchored version is the more correct
  one (it only reacts to the words as actual words), so it is the one to keep.
  This is a deliberate, intentional behavior narrowing for that edge case, not
  a pure refactor — call it out in the commit message for this step.

  **Signature mismatch to reconcile:** `find_auxiliary_indexes_for_file(params,
  selected_label)` (survivor) takes an already-built `params` array (the shape
  `io/parameter_map.js`'s `parameter_map(summary)` produces). `djf.js`'s deleted
  `find_auxiliary_indexes(summary, selected_label)` took a raw FCS `summary` and
  built its own params array inline — a third, separate duplicate of
  `parameter_map()`'s logic (also being deleted here). Its only caller is
  `tests/unit/unit_tests_djf.py` (`DJF.find_auxiliary_indexes(summary, label)`);
  nothing in `js/` app code calls it. Reconcile by giving `djf.js` a **thin
  one-line adapter**, not a reimplementation, so external callers keep passing a
  `summary`:
  ```js
  import { parameter_map } from "../io/parameter_map.js";
  import { find_auxiliary_indexes_for_file } from "../fcs/channel_cleaning.js";

  export function find_auxiliary_indexes(summary, selected_label) {
    return find_auxiliary_indexes_for_file(parameter_map(summary), selected_label);
  }
  ```
  Export this adapter from `djf.js` (surfaced via `window.PhaseFinder.djf` per
  §4) so the test keeps its existing call shape; update the test only for the
  `window.PhaseFinder.djf` accessor rename (§4/§8), not for this signature.

### 8. Lazy-load the DJF + ml-* stack (core scope)

The DJF numeric stack (`analysis/djf.js` + `ml-levenberg-marquardt` + `ml-gsd`) is
only needed once the user starts modeling, so keep it off the initial load path.

- Do **not** statically `import` `analysis/djf.js` from `plotting/render.js` or
  `plotting/modeling.js`. Instead load it on demand via dynamic `import()`.
- Add a small memoized loader, e.g. in `plotting/modeling.js` or a
  `plotting/djf_loader.js`:
  ```js
  let djf_promise = null;
  export function load_djf() {
    return (djf_promise ??= import("../analysis/djf.js"));
  }
  ```
  Because `djf.js` statically imports the two ml-* libraries at its own top level,
  a single dynamic import of `djf.js` pulls the whole stack in one shot.
- **Await it before the first fit.** The modeling entry points that currently call
  into DJF synchronously — `start_modeling()` (`plotting/modeling.js:162`) and the
  fit loop in `render_density_plot()` (`plotting/render.js:98`) — become
  async-aware: `const DJF = await load_djf();` before fitting. Guard the render
  pass so the histogram still draws immediately and only the fit portion awaits.
- Show the existing progress overlay (`show_progress`/`hide_progress` from
  `ui/status_channels.js`) during the first load so the one-time fetch is visible.
- The `window.PhaseFinder.djf` debug hook is populated on first load (or exposes
  `load_djf()`), not at startup — document this in the hook's comment.

---

## Migration order (branch `esm-restructure`, commit at each step)

1. **Vendor libs** into `js/vendor/`; add import map (app still on classic scripts — verify no regression).
2. **Leaf/pure modules**: `fcs/parser.js`, `data_structs/metadata_frame.js`,
   `metadata_columns.js`, `analysis/djf.js`, `session/toml_io.js`,
   `io/parameter_map.js` (renamed), `fcs/channel_cleaning.js` — add exports.
3. **State modules**: `state/app_state.js`, `table_state.js`, `channel_cache.js`,
   `plotting/data.js`, `ui/panels.js`.
4. **io/adapters + module workers** (incl. `session/opfs_fs.js`,
   `session/file_cache.js` renames).
5. **UI + plotting + analysis** modules; refactor side effects into `init_*()`;
   add the memoized `load_djf()` dynamic-import loader and make the fit paths
   async-aware (§8).
6. **`main.js`** entry/state/debug-hook; wire the bootstrap sequence.
7. **`index.html`**: single `<script type="module">`, remove 31 tags + head shims,
   add `modulepreload`.
8. **Cleanups** (dangling ref + dedup) + rewrite test accessors to
   `window.PhaseFinder.*` + update **README** ("static server required").

Steps 2–6 aren't independently runnable in-browser (all-or-nothing load), so do
them as one focused pass, committing at these breakpoints, then verify the whole.

## Files modified (representative)

- `index.html`, **new** `js/main.js` role (entry), **new** `js/state/app_state.js`,
  **new** `js/vendor/*`.
- Every file under `js/` gets `export`/`import` (pattern repeats). Highest churn:
  `js/main.js`, `js/analysis/start.js`, `js/plotting/axis_modal.js`,
  `js/plotting/data.js`, `js/session/core.js`, `js/session/file_cache.js`.
- Renames: `io/cache.js`→`io/parameter_map.js`, `session/store.js`→`session/opfs_fs.js`,
  `session/opfs.js`→`session/file_cache.js`.
- Workers: `js/fcs/data_worker.js`, `js/session/copy_worker.js`.
- `README.md` (server now required), test files under `tests/` that read
  `window.PhaseFinder*` (repoint to `window.PhaseFinder.app/djf/plot`).
- **Delete** `for_review.js` (repo root) once the §7 dedup step is committed —
  it's a scratch comparison file used to decide the dedup, not part of the app.

---

## Expected performance impact

**Runtime hot paths (FCS parse, DJF fit, D3 render): no meaningful change.** Same
algorithms, same worker offloading, same DOM work. Module scope vs global scope
has no measurable execution cost; if anything, replacing `window.PhaseFinderApp.x`
property lookups with direct module bindings is a microscopic (unobservable) win.

**Cold startup: roughly neutral, slightly better on real deployments.**
- *Win:* vendoring removes two third-party origins (DNS+TLS+fetch to jsdelivr and
  esm.sh). On any non-localhost load that's the single biggest latency saver and
  also makes the app work offline.
- *Risk:* a deep static-import graph can waterfall on HTTP/1.1
  (`python3 -m http.server` is HTTP/1.1, no multiplexing). Mitigated by
  `<link rel="modulepreload">` on the entry (and heavy leaves) and by the fact
  that localhost RTT is sub-millisecond. On an HTTP/2 host it's a non-issue.
- Request count is comparable (~31 modules either way; vendored libs replace 2 CDN
  requests with ~3 local ones).

**Included startup win (core scope, §8):** the DJF + ml-* stack — the single
heaviest optional dependency — is lazy-loaded via dynamic `import()` on the first
modeling action instead of at startup. This is a genuine time-to-interactive
improvement for the common case where a user loads/reviews files without ever
fitting. (Today the ml-* libraries load async in the background at startup; lazy
import is strictly better and removes them from the initial critical path.)

**Bottom line:** treat this primarily as a maintainability/correctness refactor.
The one real, user-visible perf win is the lazy DJF load (faster initial
interactivity when not modeling); the other honest wins are offline capability, a
killed CDN dependency, and an explicit dependency graph. No hot-path speedup.

---

## Verification (end-to-end)

1. **Serve + smoke:** `python3 -m http.server 8080`, open
   `http://localhost:8080/index.html`. Require **zero console errors** (no
   ReferenceErrors, no import-map/module resolution failures, no MIME/nosniff
   errors on `.js`, no worker load errors).
2. **Flow A** (onboarding §4): drop FCS files → header parse → table populates;
   sort/filter/annotate work.
3. **Flow B**: select channel → Plot → Start Modeling (DJF) → fit curves +
   phase-stats table render. Exercises the module worker, `d3` import, and the
   lazy DJF/ml-* import (§8).
4. **Workers:** confirm `data_worker` and `copy_worker` load as modules without
   error (devtools → Sources/Workers).
5. **Session round-trip:** Save → reload → Load → reconnect restores files+state.
6. **Debug hook:** console shows `window.PhaseFinder.app/djf/plot` defined and
   returning data; confirm no stray `window.PhaseFinder*` names remain.
7. **Playwright:** run `tests/e2e/drive_flow.py` via `/tmp/flowvenv` if the venv +
   Chromium exist (it starts its own http server); else do the manual checks
   above. Report which path ran and triage only failures caused by the
   `window.PhaseFinder.*` accessor change.
