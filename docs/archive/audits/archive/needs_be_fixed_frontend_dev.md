> Archived 2026-09-05 from docs/audits/archive/needs_be_fixed_frontend_dev.md. Historical findings are reconciled in the master checklist; unchecked boxes here are not an active work queue. [Current register](../../../audits/master_checklist.md).

# PhaseFinder frontend engineering remediation audit

Audit date: 2026-07-17

## Executive summary

PhaseFinder has a strong local-first foundation, a substantial functional test suite, and well-separated source directories, but it is not ready for a production release in its current state. The most urgent problems are:

1. A tracked developer autoload session changes every visitor's startup behavior and publishes experiment metadata.
2. The only release workflow calls a file that does not exist, and its deployment command would publish the entire repository rather than an explicit public artifact.
3. Imported session files can cause prototype pollution and stored DOM XSS.
4. Companion-channel choices are not part of the pipeline result identity, so masks and cell-cycle results can be reused for the wrong H/W/FSC/SSC configuration.
5. The documented regression gate is red: 296 of 302 checks pass, one warns, and five fail. Most failures are stale tests, but one also exposes a missing readout and widespread UI/documentation drift.

The next tier is dominated by scientific-data correctness, main-thread performance on large FCS files, mobile reflow, keyboard/screen-reader access, and local-cache lifecycle problems. These should be addressed before broad user testing.

## Scope and method

The requested file `/local_data/engineering-frontend-developer.md` does not exist on this machine. I found and read the matching document at:

`/home/mike/.local/share/com.zerologic.agency-agents-app/corpus/engineering/engineering-frontend-developer.md`

That guidance emphasizes responsive/mobile-first design, WCAG 2.1 AA, keyboard and screen-reader access, Core Web Vitals, maintainable component boundaries, defensive error handling, cross-browser validation, automated tests, and a safe delivery pipeline. I used those criteria for this audit.

The review covered the complete tracked project inventory (155 tracked files at audit time), including 63 JavaScript files, 21 Python files, 9 HTML files, 8 CSS files, GitHub Actions, the Git hook, sessions, documentation, and asset metadata. Text source and configuration were inspected directly. Binary PNG/PDF/ZIP files were inspected by type, dimensions, size, and usage rather than treated as text. `.git/` internals and ignored generated browser-test artifacts were not treated as application source.

No application source was changed by this audit. This file is the only deliverable.

## Validation snapshot

The documented full regression command was run:

```bash
/tmp/flowvenv/bin/python tests/e2e/driving_code/drive_flow.py
```

Result:

| Result | Count |
|---|---:|
| Total checks | 302 |
| Pass | 296 |
| Warn | 1 |
| Fail | 5 |

All 202 unit checks passed. The five failures are in the browser suite and are analyzed in FE-008. The run reported no uncaught page errors. Static inspection also found no duplicate IDs in the principal HTML pages, no missing `alt` attributes on their images, and no `_blank` links lacking `rel="noopener"`.

Severity meanings used below:

- **Critical**: release blocker, exploitable code execution, exposure of private project data, or credible risk of reporting a scientifically wrong result as current.
- **High**: a core workflow can fail, become unusable, or produce severe latency; WCAG failure blocks an important user journey.
- **Medium**: important robustness, scalability, security-hardening, or secondary accessibility defect.
- **Low**: maintenance or polish issue with limited immediate user impact.

## Release blockers and scientific-correctness defects

### FE-001 — Tracked developer session is autoloaded for every visitor

**Severity: Critical**

**Evidence**

- `sessions/phasefinder_local.json:2-3` points at `sessions/phasefinder_session_20260705.toml` and `../flow_data`.
- Both files are tracked even though `js/session/core.js:349-358` says the local JSON is never committed.
- `js/session/core.js:360-388` fetches and applies this configuration during startup.
- `sessions/phasefinder_session_20260705.toml:7-76` contains six experiment filenames, file sizes/timestamps, identifiers, OPFS paths, and strain/replicate/arrest/timepoint metadata.
- `.gitignore:1-17` does not ignore the active local configuration or local session files.

**Impact**

Production starts in a developer-specific state, attempts to restore an unrelated experiment, and exposes experiment metadata to anyone who can fetch the deployed repository. Raw event data is not in the TOML, but it could also become reachable if the configured sibling data directory is ever published by the host.

**Required fix**

- Remove the active local JSON and developer session from version control and purge sensitive history if the metadata must not remain public.
- Ignore `sessions/phasefinder_local.json` and local session exports; retain only a sanitized `.example.json`.
- Make development autoload an explicit local development feature that cannot be enabled in the production artifact.
- Add a deployment test that fails if an active autoload configuration or non-fixture session is present.

**Acceptance criteria**

A clean production load starts empty; fetching the public site cannot retrieve developer session metadata; an optional local override still works when created by a developer outside version control.

### FE-002 — Release workflow cannot run and publishes an unsafe directory

**Severity: Critical**

**Evidence**

- `.github/workflows/deploy-release.yml:30,40` calls `scripts/update-release-notes.sh`.
- The only matching file is `.github/scripts/update_release_notes.sh`; there is no repository `scripts/` directory.
- `.github/workflows/deploy-release.yml:50` runs `pages deploy .`, which selects the repository root rather than a curated public directory.
- The root contains sessions, tests, internal docs, a ZIP handoff, a paper PDF, development reports, and a release preview in addition to the app.

**Impact**

The release job fails before deployment. If the path is fixed without changing the deploy target, internal/development artifacts and the session files from FE-001 are candidates for public deployment.

**Required fix**

- Correct the script path and naming.
- Assemble a clean `dist/` directory from an allowlist of runtime HTML, CSS, JavaScript, manifest, and required images; deploy only `dist/`.
- Add a pre-deploy assertion for expected entry files and forbidden content such as `sessions/`, `tests/`, `.git*`, local reports, ZIP/PDF handoffs, and source-only docs.
- Give the deploy job only the permissions it actually needs and run tests before deployment.

**Acceptance criteria**

Both release and manual dry-run paths succeed in CI, the artifact contains only public runtime files, and a manifest of deployed paths is retained for review.

### FE-003 — Imported TOML can pollute JavaScript prototypes

**Severity: High security; critical to session-data integrity**

**Evidence**

- `js/session/toml_io.js:189-218` builds ordinary objects and traverses section names through inherited properties.
- `get_path()` at `js/session/toml_io.js:183-186` also follows inherited properties.
- `js/session/toml_io.js:241-242` assigns unrestricted keys.
- The parser is reached by manual session load at `js/session/core.js:312-322` and startup autoload at `js/session/core.js:373-388`.

An isolated verification showed that this session fragment changes `Object.prototype`:

```toml
[__proto__]
pfPolluted = "yes"
```

`constructor.prototype` is another dangerous path.

**Impact**

A crafted session can corrupt assumptions across the entire page, alter unrelated object lookups, cause denial of service, and potentially participate in a larger exploit chain.

**Required fix**

- Parse into `Object.create(null)` containers.
- Reject `__proto__`, `prototype`, and `constructor` at every nesting level and for inline-table keys.
- Traverse only own properties with `Object.hasOwn()`.
- Validate the final object against an explicit, size-bounded PhaseFinder session schema before applying it.
- Add malicious-section, deep-nesting, oversized-array, and unexpected-type tests.

**Acceptance criteria**

No imported text can create or mutate inherited properties; invalid sessions are rejected with a useful error before any UI or storage state changes.

### FE-004 — Session metadata fields enable stored DOM XSS

**Severity: High**

**Evidence**

- `js/data_structs/metadata_columns.js:100-110` preserves any nonempty, nonduplicate `column.field` verbatim.
- Session columns reach that code through `js/session/table_session.js:93-108`.
- The field is interpolated without attribute escaping in `js/ui/table_support.js:191,199-200,223` and `js/ui/table_render.js:125-128`.
- `js/ui/table_render.js:310-315` installs the resulting string with `innerHTML`.

A field such as `x" onclick="alert(document.domain)` creates an inline event-handler attribute on generated table controls. Ordinary CSV/TSV headers are normalized and are not the direct path; crafted session/template fields are.

**Impact**

Opening a shared malicious session can execute script in the PhaseFinder origin. That script can read current application state and make network requests, so the local-first nature of the app does not neutralize this issue.

**Required fix**

- Normalize all supplied field identifiers to a strict grammar such as `^[A-Za-z][A-Za-z0-9_]*$`, including session and filename-template fields.
- Prefer DOM construction and `dataset`/`setAttribute` over HTML-string interpolation for dynamic controls.
- Escape every remaining attribute interpolation consistently.
- Add a restrictive Content Security Policy that disallows inline script as defense in depth.
- Add an end-to-end malicious-session fixture proving that no attribute or element injection occurs.

**Acceptance criteria**

Untrusted fields are either converted to safe stable identifiers or rejected; the malicious fixture renders as inert text and cannot create handlers or new markup.

### FE-005 — Pipeline results can be reused for the wrong companion channels

**Severity: Critical scientific correctness**

**Evidence**

- `js/data_structs/channel_cache.js:21-33` collapses `undefined` (auto-detect) and `""` (explicit None) into the same cache-key component.
- `js/io/channel_loading.js:204-214` gives those values different meanings.
- `js/io/channel_loading.js:243-260` stores `channel_key` as only the DNA-area label.
- `js/analysis/pipeline_state.js:25-59` decides whether masks/fits are current from that bare channel key, event count, and row ID.
- The H/W/FSC/SSC selectors in `js/ui/dom.js:45-49` have no change listeners; `js/main.js:204-217` wires only the two DNA selectors.

**Impact**

Changing DNA height, width, forward scatter, or side scatter can display masks, QC outcomes, histograms, or model fractions calculated under a different channel configuration. This is especially dangerous because the result looks valid rather than failing visibly.

**Required fix**

- Define one canonical analysis identity containing DNA area plus resolved H/W/FSC/SSC/time indices and explicit `auto` versus `none` sentinels.
- Store that identity on each loaded-data object and every pipeline result.
- Invalidate masks, histograms, fits, report columns, and completion badges when any identity component changes.
- Wire all companion selectors to a coordinated reload/invalidation path and show the resolved per-file channel mapping.
- Add tests that switch each companion among auto, None, and an explicit label and prove stale state is never rendered.

**Acceptance criteria**

Every visible result can be traced to the exact resolved channel configuration; changing any component makes old results unavailable until recomputed.

### FE-006 — QC controls can say “active” while displayed data is ungated

**Severity: High scientific correctness**

**Evidence**

- QC pressed state is global DOM state in `js/analysis/pipeline_ui.js:409-427`.
- `apply_qc_selection()` applies gates only to the rows currently returned by `plottable_rows()` (`js/analysis/pipeline_ui.js:467-516`).
- Selection changes redraw through `js/plotting/axis_modal.js:133-137`, but no listener applies the currently pressed QC configuration to newly selected rows.
- Channel/file transitions clear some modeling completion styles in `js/analysis/start.js:83-93`, but not the QC pressed state and not every affected row's derived data.

**Impact**

New files, newly selected rows, or a new channel can be plotted raw while the Structural/Time/Cell Gate/Singlet controls still appear enabled. The visual control state is therefore not a reliable statement about the plotted cohort.

**Required fix**

Represent QC choices as versioned application state keyed by the analysis identity and cohort. On file, selection, or channel change, either apply the active gates before rendering or visibly reset the controls and remove derived columns/results. Surface per-sample skipped/failed status rather than a single global pressed state.

**Acceptance criteria**

For every plotted sample, pressed QC controls correspond to stored current masks, and any skipped gate is explicitly visible.

### FE-007 — QC and model runs can mutate the same state concurrently

**Severity: High scientific correctness and reliability**

**Evidence**

- Manual modeling uses `pipeline_busy` (`js/analysis/pipeline_ui.js:33-34,220-368`).
- QC uses a separate `qc_busy` lock (`js/analysis/pipeline_ui.js:409-422,467-527`).
- Both paths reset/write masks, histograms, pipeline state, table columns, progress UI, and the plot.
- File, selection, and channel controls remain usable during important parts of these operations.

**Impact**

A user can start QC while a model stage is running, or change the cohort/configuration mid-run. Completion from the older operation can overwrite newer state or make results appear to belong to the wrong selection.

**Required fix**

Use one analysis-operation coordinator with immutable input snapshots, monotonically increasing run IDs, cancellation, and stale-result rejection. Disable or version all controls that can change inputs while a non-cancellable commit is in progress. Give progress/status channels the same operation ID.

**Acceptance criteria**

Only the latest valid operation can commit masks, fits, table values, plot state, or progress completion; automated rapid-click/channel-switch tests cannot reproduce mixed state.

### FE-008 — Regression suite and the current UI no longer describe the same product

**Severity: High delivery risk**

**Evidence**

The full run produced five failures:

1. `tests/e2e/driving_code/tests_pipeline.py:176-182` expects the pipeline still to be unloaded, but `js/analysis/pipeline_ui.js:550-557` intentionally preloads Stage 0/1 after plotting.
2. `tests/e2e/driving_code/tests_pipeline.py:18-33,184-191` waits for `#djf_stage0`, but current HTML exposes QC toggles for Stages 0-3, auto-generates Stage 4, and has manual buttons only for Stages 5-8 (`index.html:123-145`).
3. `tests/e2e/driving_code/tests_modeling.py:90-107` expects the Modeling “Run all” action to retain all nine checkpoints, while `js/analysis/pipeline_ui.js:27-32,371-400` intentionally runs only `[5,6,7,8]` over the current QC state.
4. `tests/e2e/driving_code/tests_modeling.py:110` and `tests/e2e/driving_code/tests_pipeline.py:191` require `#djf_readout`. The element is absent, although `js/plotting/data.js:22` and `js/analysis/pipeline_ui.js:229,311,318-320,357` still write to it conditionally.
5. `tests/e2e/driving_code/tests_metadata_table.py:43-58` selects only direct child buttons, but metadata actions are now nested in labeled groups.

The stale contract also remains in user documentation: `help.html:243,341`, `README.md:350`, several diagram sources, and `js/analysis/pipeline_ui.js:579` still describe a complete/all-nine-stages Run All.

**Impact**

The advertised regression gate cannot pass and cannot distinguish a real product regression from an intentional redesign. The missing readout silently discards detailed per-sample outcome/error text, while users receive contradictory instructions.

**Required fix**

- Decide and document the canonical workflow: QC 0-3, automatic histogram 4, modeling 5-8 is what the current code implements.
- Restore an accessible per-sample readout or remove the dead contract and route every important message to a persistent equivalent.
- Update button tooltips, help, README, diagrams, and tests together.
- Test behavior and accessible names instead of brittle direct-child structure where DOM nesting is not the requirement.

**Acceptance criteria**

The full 302-check suite passes, documentation matches visible controls, no code queries nonexistent result elements, and both QC-only and modeling-only Run All semantics are unambiguous.

## Performance, memory, and local-data lifecycle

### FE-009 — Numerical pipeline work labeled “background” still blocks the main thread

**Severity: High**

**Evidence**

- `js/analysis/pipeline_ui.js:268-281` yields once per sample but calls each numerical stage synchronously on the UI thread.
- `js/analysis/pipeline_ui.js:550-557` starts best-effort precomputation via a Promise, but Promise scheduling does not move computation off-thread.
- GMM iteration in `js/analysis/scatter_gmm_gate.js:156-307` and pulse-geometry work in `js/analysis/pulse_geometry_gate.js:20-133` are CPU-heavy loops.

**Impact**

Large samples can create long tasks, frozen controls, delayed paint, and browser “page unresponsive” warnings despite a visible progress overlay.

**Required fix**

Move GMM, ridge, histogram, and fitting stages into a cancellable worker pool. Transfer typed-array buffers or use carefully managed copies, report stage/sample progress, and impose time/event/iteration budgets with useful failure messages.

**Acceptance criteria**

Representative large studies keep input and animation responsive, long tasks stay within an agreed performance budget, and cancellation prevents old workers from committing results.

### FE-010 — Scatter-gate preview reallocates and scans the full sample on every pointer event

**Severity: High**

**Evidence**

- Every drag/coverage preview calls `gate_for_component()` from `js/analysis/scatter_modal.js:265-333,387-394`.
- `js/analysis/scatter_gmm_gate.js:343-364` allocates an event-sized `Uint8Array`, an event-sized `Float64Array`, and recomputes Mahalanobis distance for all scatter points.
- Drag events can fire many times per animation frame.

**Impact**

Dragging the gate over a large sample can produce severe jank, memory churn, and delayed or dropped input.

**Required fix**

Throttle visual previews with `requestAnimationFrame`, calculate preview membership only for the rendered/downsampled points, and compute the authoritative full mask once on drag end or committed input change, preferably in a worker.

**Acceptance criteria**

Gate dragging remains smooth on the largest supported sample, creates no event-sized allocation per pointer event, and the committed mask still uses all events.

### FE-011 — FCS loading makes redundant full copies and trusts unbounded metadata sizes

**Severity: High**

**Evidence**

- `js/fcs/parser.js:392-435` allocates a normal JavaScript array per selected channel using `$TOT`.
- `js/fcs/data_worker.js:16-27` copies each array into `Float64Array` before transfer.
- `js/fcs/channel_cleaning.js:222-234` copies it again on the main thread.
- `$TOT`, `$PAR`, DATA offsets, byte-width products, and resulting allocation sizes are not comprehensively checked against file length and configured limits before allocation.
- `js/io/channel_loading.js:540-567` initially loads event data for every parsed file, not only checked rows.

**Impact**

Memory can approach several times the selected channel data, large studies parse more files than the user requested, and malformed metadata can force excessive allocation or out-of-bounds reads.

**Required fix**

Allocate final typed arrays directly in the worker, retain transferred arrays without recopying, validate all counts/offsets/products against the actual file and explicit quotas, and load selected files first. Make bounded background prefetch optional and cancellable.

**Acceptance criteria**

One selected channel has at most one authoritative typed array per cache entry, malformed/oversized metadata fails before allocation, and initial analysis cost scales with selected files.

### FE-012 — Plot redraw does full hidden-sample work and rebuilds the entire SVG

**Severity: High**

**Evidence**

- `js/plotting/render.js:208-317` recompacts events and calculates histograms on every redraw.
- `js/plotting/render.js:299-317` computes histograms for every loaded-but-unchecked file solely to populate the debugging API.
- `js/plotting/render.js:213` clears the full plot; bins mode can create hundreds of rectangles per sample at `js/plotting/render.js:451-490`.
- ResizeObserver and window-resize paths trigger redraws at `js/plotting/axis_modal.js:191-207`.
- `js/ui/table_render.js:273-315` similarly rebuilds all visible table rows without paging or virtualization.

**Impact**

Resize, checkbox, filter, or display-control changes can perform O(all loaded events) work and create thousands of DOM nodes. Hidden files can be more expensive than visible ones.

**Required fix**

Cache compacted values and histograms by row revision, analysis identity, mask revision, range, and bin count. Compute debug histograms lazily. Update stable SVG layers rather than clearing everything, use canvas for dense bars/large cohorts, and virtualize or page very large tables.

**Acceptance criteria**

Unchecking a sample removes its redraw cost; resizing does not rescan events; large cohorts meet documented render and interaction budgets.

### FE-013 — Mixed staged/unstaged plots can silently clip live sample values

**Severity: High scientific correctness**

**Evidence**

`js/plotting/render.js:250-282` derives the shared range only from stored staged histograms whenever at least one staged histogram exists. A visible unstaged sample is then binned into that range even if its live data extends beyond it.

**Impact**

Events outside the staged sample's stored range disappear from an unstaged sample's displayed histogram. The overlay can therefore underrepresent a sample without warning.

**Required fix**

Either require all visible samples to use one versioned histogram snapshot/range, or union staged ranges with live-data extents and explicitly invalidate/refit affected staged curves. Display clipping counts when a manual or frozen range excludes events.

**Acceptance criteria**

Every visible sample's in-range and clipped counts are known and shown; adding an unstaged sample cannot silently discard its extrema.

### FE-014 — OPFS persistence has no complete retention or deletion model

**Severity: High privacy/storage reliability**

**Evidence**

- Every page load creates a random cache directory ID (`js/session/file_cache.js:206-228`).
- Every newly loaded FCS file is copied to persistent OPFS in the background (`js/session/file_cache.js:292-343`).
- Reset deletes only the current page's random directory (`js/session/core.js:328-334`), not necessarily the directories referenced by a loaded session.
- There is no manifest-driven orphan cleanup or “clear all local data” UI. The existing `get_storage_estimate()` at `js/session/opfs_fs.js:157-175` is not surfaced.
- The tracked example session alone references roughly 203 MB of raw files, illustrating the scale.

**Impact**

Restored and orphaned scientific files can remain indefinitely, reset can claim deletion without deleting the relevant cache, and repeated sessions can consume browser quota with no discoverable inventory.

**Required fix**

Make persistence explicit, maintain a cache manifest with ownership/last-use/size, delete every path referenced by the current session on reset, offer “clear this session” and “clear all PhaseFinder local data,” clear stored directory handles when requested, and implement quota/expiration/orphan cleanup.

**Acceptance criteria**

The UI reports local usage and retention, deletion is verifiably complete for the chosen scope, and automated tests prove no referenced or orphaned OPFS directory survives “clear all.”

### FE-015 — OPFS failures and file identity are reported too optimistically

**Severity: Medium**

**Evidence**

- `js/session/file_cache.js:309-343` skips a filename already in the registry regardless of failed status and ends with “Cached N files” even when individual writes failed.
- Reconnect matching relies on name and size/last-modified heuristics (`js/session/reconnect.js:52-75`) rather than content identity.

**Impact**

Users can believe reload safety is established when copies failed, and a same-name/same-size replacement can be associated with the wrong scientific record.

**Required fix**

Track and display per-file outcomes, retry failed/uncached records, and store/verify a content digest (for example SHA-256) for saved-session file identity.

**Acceptance criteria**

Success counts include only successful writes, failures remain actionable, and reconnect refuses a file whose digest does not match unless the user explicitly replaces it.

## Responsive design and accessibility

### FE-016 — Mobile and zoomed layouts clip the workspace behind the footer

**Severity: High**

**Evidence**

- `body` cannot scroll (`css/base.css:62-65`).
- `.app` subtracts hard-coded 60 px header and 40 px footer values from `100vh` (`css/layout.css:148-165`).
- At the mobile breakpoint the header becomes multi-row without updating that calculation (`css/responsive.css:3-25`).
- The mobile rule changes columns but does not define safe stacked row sizing or a new scroll owner.

**Impact**

Phone users and users at 200% zoom can lose the workspace, table actions, or modal content below/behind the footer.

**Required fix**

Use a page shell with `grid-template-rows: auto minmax(0, 1fr) auto`, `100dvh` with fallback, content-driven header/footer height, and explicit scrolling in the main region. Define stacked rows and wrapping/compact metadata actions at narrow widths.

**Acceptance criteria**

No content is clipped at 320, 390, 768, or 820 CSS px, landscape phone sizes, or 200% zoom; all core actions remain reachable without two-dimensional page scrolling.

### FE-017 — Primary upload and reload actions are not keyboard accessible

**Severity: High**

**Evidence**

- The expanded drop target is a plain `div` (`index.html:87-92`) with only click/drag listeners (`js/main.js:219-239`).
- The visually clipped file input has no label (`index.html:186`, `css/base.css:126-136`).
- The logo is an image with a click-only reset handler (`index.html:37`, `js/main.js:241`).

**Impact**

Keyboard, switch, and voice-control users cannot reliably perform the app's first required action. An unlabeled hidden file input can also become an unexplained tab stop.

**Required fix**

Use a styled `<label for="file_input">` or a real named button for upload, retain drag/drop as an enhancement, and make reset a separately named button rather than an implicit image action.

**Acceptance criteria**

A keyboard-only user can load files and reset/restart with visible focus and announced purpose.

### FE-018 — Modal dialogs do not behave modally for focus

**Severity: High**

**Evidence**

- Five containers declare `aria-modal="true"` at `index.html:306,335,371,405,450`.
- Open/close code does not consistently trap Tab, make the background inert, or restore the opener (`js/ui/metadata_wizard.js:299-312`, `js/analysis/stats.js:172-196`, `js/plotting/axis_modal.js:45-76`, `js/analysis/scatter_modal.js:367-378`).
- Reconnect does not assign initial focus (`js/session/reconnect.js:247-261`).

**Impact**

Focus can move behind a visible modal and is lost on close, making keyboard and screen-reader workflows unpredictable.

**Required fix**

Create one dialog controller or use native `<dialog>.showModal()`: record/restore the opener, choose meaningful initial focus, contain Tab/Shift+Tab, support Escape, and make the background inert on every path, including asynchronous close.

**Acceptance criteria**

Automated tests open and close every dialog by keyboard and verify initial focus, containment, Escape, backdrop behavior, and opener restoration.

### FE-019 — The primary scientific plot is pointer-only and largely absent from the accessibility tree

**Severity: High**

**Evidence**

- The generated SVG has no role, title, or description (`js/plotting/render.js:365`).
- Sample identification is explicitly hover-only and the legend was removed (`js/plotting/render.js:193-200,559-561`).
- Bars and curve hit paths use pointer and double-click handlers without keyboard equivalents (`js/plotting/render.js:451-490,532-557`).
- Axis editing is discoverable only through invisible double-click hit areas (`js/plotting/render.js:382-415`).
- Table color isolation is a small span activated by double-click (`js/ui/table_render.js:281-284,435-439`).

**Impact**

Blind users cannot inspect the chart; keyboard and many touch users cannot identify/isolate a series or edit axes. Color is the only persistent series distinction.

**Required fix**

Add an accessible plot name/description and equivalent summary/data table, restore a persistent text legend, and provide visible Axis Range and Series Focus controls. Keep hover/double-click only as shortcuts.

**Acceptance criteria**

The complete plot workflow is usable with keyboard, touch, and screen reader without relying on hover, color alone, or double-click.

### FE-020 — Text, plot colors, and focus indicators fail contrast requirements

**Severity: High**

**Evidence**

- White on `--logo_teal: #01a5af` is approximately 3.00:1 and white on `--success: #059669` is approximately 3.77:1 (`css/base.css:19,24`), below 4.5:1 for normal text. These tokens are used on normal-size buttons in `css/layout.css:102-123,705-765`, `css/feedback.css:309-317`, and `css/help.css:91-104`.
- DJF G1/S/G2 fills against white are approximately 1.92:1, 1.24:1, and 2.40:1 (`css/base.css:46-48`), and the same colors are used for fill/outline.
- Generated yellow/cyan sample hues from `js/plotting/data.js:281-310` can fall well below the 3:1 graphical-object threshold.
- Several translucent focus rings composite to less than 3:1 (`css/base.css:29-31` and component focus rules).

**Impact**

Button text, chart components, series, and keyboard focus are difficult to distinguish for low-vision and color-deficient users.

**Required fix**

Use tested semantic color tokens, darken text-bearing actions to at least 4.5:1, ensure chart boundaries/lines reach 3:1, add patterns/line styles/labels, and define one solid high-contrast global `:focus-visible` treatment.

**Acceptance criteria**

Automated token checks and manual forced-colors/color-deficiency review pass WCAG AA for text, non-text graphics, and focus appearance.

### FE-021 — Essential tooltip formulas and status/error updates are not announced

**Severity: High**

**Evidence**

- The tooltip is permanently `aria-hidden="true"` (`js/ui/hover_text.js:91-96`); show/hide never changes that state or connects the anchor with `aria-describedby` (`js/ui/hover_text.js:101-158`).
- Detailed QC formulas exist only in those tooltips (`js/ui/hover_text.js:41-45`) while visible button labels are short (`index.html:128-133`).
- Sidebar and footer status elements have no live-region role (`index.html:100,488-490`) despite frequent mutation (`js/ui/status_channels.js:184-205`).
- Statistics progress lacks `role="progressbar"` and value attributes.
- Footer messages are visually ellipsized (`css/feedback.css:32-39`).

**Impact**

Screen-reader users miss mathematical method details, disabled reasons, progress, completion, and actionable failures; sighted users can lose the full error text.

**Required fix**

Back tooltips with stable description elements and `aria-describedby`; add a polite status channel and deliberate alert channel; expose progress values; preserve a full error log/details view instead of relying on a truncated footer.

**Acceptance criteria**

Screen-reader tests hear control descriptions, progress, completion, and errors once at appropriate priority, and all full messages remain retrievable.

### FE-022 — Metadata table controls and header relationships are not accessible

**Severity: High**

**Evidence**

- Annotation inputs have no accessible name (`js/ui/table_render.js:123-128`).
- Per-row and select-all checkboxes have no proper labels; select-all relies on `title` (`js/ui/table_render.js:232,300-303`).
- Filenames are ordinary data cells rather than row headers (`js/ui/table_render.js:277-285`).
- Complex group/metric headers lack `scope`, IDs, and `headers` relationships (`js/ui/table_render.js:207-260`).
- Filter, sort, and select-all paths rebuild the table and generally lose focus; active sorting is not exposed with `aria-sort`.

**Impact**

Screen-reader users cannot reliably determine the sample/column associated with an edit, checkbox, or derived statistic. Keyboard users are ejected from filters after selection.

**Required fix**

Label controls with sample and column names, use row headers and correct col/colgroup relationships, add a caption, expose `aria-sort`, and preserve focus using stable control identities or update controls in place.

**Acceptance criteria**

NVDA/VoiceOver table navigation announces correct row and column context, and keyboard focus remains on the logical control after sort/filter/select updates.

### FE-023 — Secondary interactive widgets remain mouse-only or have conflicting ARIA

**Severity: Medium**

**Evidence**

- Column-removal mode makes table cells clickable without roles, tab stops, keyboard handlers, or selected state (`js/ui/column_remove.js:95-132`).
- Both panel resizers are `aria-hidden` divs (`index.html:207,244`) driven only by mouse events (`js/ui/panel_resize.js:28-62,106-149`).
- The scatter SVG is `role="img"` while it contains a focusable descendant button, and that button receives unsupported `aria-valuetext` (`js/analysis/scatter_modal.js:189-192,251-276`).
- The app has no `<h1>` and panel titles are spans rather than a useful heading/landmark hierarchy (`index.html:213,249`).

**Required fix**

Use actual selectable controls in removal mode; implement resizers as keyboard-operable separators with orientation/value attributes and reset actions; model the scatter control with compatible interactive semantics or separate numeric controls; add an H1 and named panel landmarks.

**Acceptance criteria**

Every documented secondary action has a keyboard path and an accurate accessibility-tree representation.

### FE-024 — Reduced-motion coverage is incomplete

**Severity: Medium**

**Evidence**

Only sidebar transitions are disabled in `css/sidebar.css:490-496`. Other transitions and the infinite column-removal marching-ants animation remain in `css/layout.css`, `css/feedback.css`, `css/plot.css`, and `css/table.css:542-547`. Help also uses smooth scrolling.

**Required fix**

Add a global `prefers-reduced-motion: reduce` policy that disables nonessential animation/transition and restores `scroll-behavior: auto` while preserving state changes without animation.

**Acceptance criteria**

Reduced-motion emulation removes persistent/spatial motion across the app and help page.

## Error handling, security hardening, and architecture

### FE-025 — Statistics work is redundant, unbounded, and not exception-safe

**Severity: Medium**

**Evidence**

- `js/analysis/stats.js:267-274` loads all files concurrently with an unbounded `Promise.all`.
- `js/analysis/stats.js:283-300` rescans the same full array once for each selected metric; median sorts independently.
- The click handler at `js/analysis/stats.js:386-388` does not await/catch the returned promise, and the calculation lacks a top-level `try/finally` to guarantee button restoration.

**Impact**

Many large files can spike I/O/memory; selecting multiple metrics repeats work; an unexpected exception can leave Calculate disabled and create an unhandled rejection.

**Required fix**

Use bounded concurrency, one aggregation/sort per file, worker execution for large arrays, cancellation, and `try/catch/finally` around the full UI operation.

**Acceptance criteria**

Peak concurrency is configured, each file is scanned at most once per calculation plan (plus one required sort/selection operation), and all error/cancel paths restore controls.

### FE-026 — Several asynchronous UI paths can report or commit the wrong outcome

**Severity: Medium**

**Evidence**

- `show_progress()` does not cancel/version prior hide timers, so an older `hide_progress()` can hide a newer operation (`js/ui/status_channels.js:279-327`).
- Session-save cancellation returns the same value as success, so `handle_save()` always announces “Session saved” (`js/session/core.js:241-306`).
- Reconnect uses mutable global context across asynchronous work; closing can null it before later dereferences (`js/session/reconnect.js:247-299,336-344`).
- Companion loading stores one `row.companions_promise`, which rapid configuration changes can overwrite (`js/io/channel_loading.js:340-346,425-435`).

**Required fix**

Version progress and async contexts, return explicit success/cancel/failure results, use `AbortController` where possible, key companion promises by canonical analysis identity, and restore UI in `finally` blocks.

**Acceptance criteria**

Cancel is never reported as success, an old timer/run cannot hide or overwrite a new one, and rapid open/close/channel-change tests produce no rejection or stale commit.

### FE-027 — Invalid scientific/user input often fails silently

**Severity: Medium**

**Evidence**

- Invalid metadata regular expressions are caught and converted to unchanged preview output without an error (`js/ui/metadata_wizard.js:163-175`).
- Invalid axis numbers cause an early return without feedback (`js/plotting/axis_modal.js:93-105`).
- Reversed ranges are silently replaced by auto bounds later in `js/plotting/render.js:330-357`.

**Impact**

Users can reasonably believe a regex or numerical range was applied when it was ignored.

**Required fix**

Provide inline validation, `aria-invalid`, associated error text, range-order checks, and explicit Apply disabling. Keep focus in the invalid field and do not mutate/close until valid.

**Acceptance criteria**

Every invalid entry produces a visible and announced explanation and leaves the prior valid state unchanged.

### FE-028 — TSV exports permit spreadsheet-formula injection

**Severity: Medium**

**Evidence**

`js/io/metadata_io.js:405-410` escapes TSV syntax but leaves values beginning with `=`, `+`, `-`, or `@` unchanged. All headers and values pass through this helper at `js/io/metadata_io.js:460-466`.

**Impact**

Imported or edited metadata can become a formula when a recipient opens the TSV in Excel, LibreOffice, or similar software, potentially triggering calculation or network access.

**Required fix**

Define an export policy and neutralize formula-like text (including leading whitespace before a formula prefix), for example by prefixing an apostrophe in spreadsheet-safe mode. Document the behavior and test each dangerous prefix.

**Acceptance criteria**

Untrusted metadata opens as literal text in supported spreadsheet applications unless a user explicitly chooses a raw export.

### FE-029 — Repository does not define production security headers

**Severity: Medium defense in depth**

**Evidence**

There is no tracked Cloudflare `_headers` file or equivalent production header configuration. The current release command also deploys the root (FE-002), and the session XSS sink currently has no CSP barrier.

**Required fix**

Add and production-verify a CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, an appropriate `Permissions-Policy`, frame protection through `frame-ancestors`, and caching rules that do not cache local autoload configuration. Start CSP in report-only mode if necessary, remove inline dependencies, then enforce it.

**Acceptance criteria**

An automated deployment smoke test asserts the headers from the public origin and the CSP blocks a test inline-handler payload.

### FE-030 — Module cycles and worker request handling make initialization fragile

**Severity: Medium architecture**

**Evidence**

Static imports contain at least these cycles:

- `render.js -> modeling.js -> render.js`
- `render.js -> axis_modal.js -> render.js`
- `metadata_columns.js -> metadata_frame.js -> metadata_columns.js`
- `table_render.js -> metadata_columns.js -> table_render.js`
- `table_render.js -> column_remove.js -> table_render.js`
- `table_render.js -> table_support.js -> table_render.js`
- `metadata_io.js -> file_cache.js -> metadata_io.js`

Worker request maps in `js/io/channel_loading.js:58-99` and `js/session/file_cache.js:252-289` lack complete timeout/message-error/restart handling.

**Impact**

ES module cycles currently happen to initialize, but they increase temporal-dead-zone/refactor risk. A hung worker can leave a request and progress UI unresolved indefinitely.

**Required fix**

Extract state, pure render helpers, and event/controller contracts into acyclic modules. Give worker calls timeouts, `messageerror` handling, abort/termination cleanup, and a controlled restart/fallback policy.

**Acceptance criteria**

The import graph is acyclic at controller level, a graph check runs in CI, and killed/hung/malformed workers resolve every pending request with a useful error.

## Delivery, PWA, documentation, and asset quality

### FE-031 — There is no automated pull-request quality gate

**Severity: Medium**

**Evidence**

- The only workflow is the release deployment; no push/PR workflow runs unit/E2E tests, syntax checks, accessibility, link checks, or deployment validation.
- Tests run only in Chromium at a fixed 1920x1080 viewport (`tests/e2e/driving_code/drive_flow.py:94-104`).
- There is no accessibility/axe, narrow-viewport, zoom/reflow, forced-colors, reduced-motion, or performance-budget suite.
- README says the pre-commit hook blocks dirty/untracked trees (`README.md:270-279`; `tests/e2e/README.md:48-67`), but the relevant exits are commented out (`.githooks/pre-commit:11-40`).
- There is no package manifest, lockfile, lint/type configuration, or automated dependency/provenance check for the vendored D3 file. A build system is not mandatory for a static app, but repeatable checks are.

**Required fix**

Add a PR workflow with fast unit/syntax/static checks and a browser matrix appropriate to risk; run the full scientific E2E suite on merge/release. Add axe, keyboard, 320/390/768/820 px, 200% zoom, reduced-motion, and deployment-artifact checks. Make hook behavior and docs agree.

**Acceptance criteria**

Protected branches require green checks; the same documented commands work locally and in CI; intentional UI changes cannot merge with stale tests/docs.

### FE-032 — Manifest paths are broken and PWA behavior is incomplete

**Severity: Medium**

**Evidence**

- `index.html:29-32` uses root-absolute favicon/manifest URLs, which break under subpath previews/deployments.
- `assets/img/favicon/site.webmanifest:1` points to `/android-chrome-192x192.png` and `/android-chrome-512x512.png`, but those files are nested under `assets/img/favicon/`.
- The manifest advertises `display: "standalone"` without `start_url`, `id`, description, or an offline/service-worker strategy.

**Required fix**

Use deployment-safe paths, validate manifest/icon requests, supply complete manifest metadata, and either implement a versioned offline shell with a clear update policy or stop implying offline/installable behavior beyond what is supported.

**Acceptance criteria**

Browser manifest inspection reports no missing icons, root and subpath previews both work, and install/offline expectations are documented and tested.

### FE-033 — Help/release documentation is stale and image delivery is wasteful

**Severity: Medium**

**Evidence**

- Help describes complete Stage 0-8 manual controls and Run All even though the UI has QC 0-3, automatic 4, and modeling 5-8 (`help.html:243,341`; `index.html:123-145`).
- Help says Help is in the header, but it is in the footer (`help.html:73,93`; `index.html:488-492`).
- The plot screenshot `alt` text says a legend exists (`help.html:219`), while `js/plotting/render.js:559-561` explicitly removes it.
- `release-notes-preview.html:25` links to a deleted `/tmp/*.css` file and has an empty document language at line 2. `.github/scripts/update_release_notes.sh:108-115` passes a temporary CSS path to Pandoc and then deletes it.
- The 1593x331 logo is about 409 KB and is rendered much smaller. Eight help screenshots load eagerly without intrinsic dimensions, responsive sources, or `loading="lazy"`; screenshots plus logo are about 1.4 MB.

**Required fix**

Update copy/screenshots/alt text as part of the UI contract, generate release previews with embedded or copied CSS and a language, and serve right-sized WebP/AVIF images with `width`/`height`, `srcset`, and lazy loading below the fold.

**Acceptance criteria**

All named controls exist where help says they do, preview links are self-contained, a link/reference check passes, and help avoids layout shift and unnecessary below-fold transfer.

### FE-034 — Saved sessions do not preserve the analysis needed to reproduce model results

**Severity: High scientific reproducibility and user-data loss**

**Evidence**

- `js/session/core.js:99-164` saves file records, metadata/table state, a stats plan, basic plot settings, and layout only.
- The session does not store resolved companion channels, QC choices, QC/manual-gate parameters, axis overrides, histogram identity/range, peak choices, model settings, fits, diagnostics, warnings, or reports.
- `docs/function-call-and-user-decision-graphs.md:16,335` explicitly records that pipeline results are runtime-only.
- Help tells users to save before closing so they can “resume work later” (`help.html:287-303`) but does not clearly warn that QC and all model progress will be lost.

**Impact**

A user can spend substantial time selecting channels, adjusting gates, detecting peaks, and fitting samples, then reasonably expect Save session to preserve that work. Reload instead loses the model state; rerunning can use different auto-detected companion channels or parameters and produce different results.

**Required fix**

Version the session schema and persist the complete reproducible analysis configuration: resolved channel identity, QC switches/parameters, manual gates, histogram/range/bin identity, peak proposals and overrides, selected model/options, and axis/display settings. Persist compact reports/diagnostics with input-file digests and algorithm/schema versions. Either recompute event masks/fits on reconnect from that configuration and verify the result, or serialize validated compact state where safe. Until implemented, rename/copy the action and help text so it explicitly says “Save workspace settings” and warn that model progress is not included.

**Acceptance criteria**

Saving, closing, and reopening a modeled cohort restores or deterministically recomputes the same gates, peak constraints, fit parameters, warnings, and reported fractions from verified input files; schema migration and round-trip tests cover older sessions.

### FE-035 — Planned multi-model workflow is not implemented in the current frontend

**Severity: Product gap; schedule separately from defects above**

**Evidence**

- The visible modeling UI is hardcoded to Dean-Jett-Fox stage controls (`index.html:123-145`).
- There is no modeling-method selector for Dean-Jett, Dean-Jett-Fox, Watson, or future methods.
- Peak detection is an automatic Stage 5 action; there is no visible control for manually setting/locking peak limits.
- `js/analysis/background_model.js:1-2` is intentionally a TODO until a background model is selected.
- `docs/cell_cycle_modeling_plan.md` records the intended broader workflow, so this is known incomplete work rather than an accidental regression.

**Required implementation direction**

Build a model selector around a shared histogram/QC input contract, separate peak proposal from editable peak constraints, preserve per-sample settings/results, expose validation and fit diagnostics consistently, and keep time-series methods such as CLOCCS in a distinct workflow requiring timepoint/replicate metadata.

**Acceptance criteria**

At minimum, the selector clearly distinguishes implemented and unavailable methods; peak proposals can be reviewed and manually constrained per sample; model-specific parameters/results have versioned state and tests before additional methods are advertised as available.

## Recommended implementation order

1. **Stop unsafe delivery:** FE-001 and FE-002.
2. **Secure untrusted files:** FE-003, FE-004, FE-028, and FE-029.
3. **Protect scientific correctness:** FE-005 through FE-008, FE-013, and FE-034.
4. **Make large datasets safe and responsive:** FE-009 through FE-015 and FE-025 through FE-026.
5. **Restore core inclusive access:** FE-016 through FE-024.
6. **Make quality repeatable:** FE-030 through FE-033.
7. **Implement the broader modeling roadmap:** FE-035 after the shared identity/state/test foundations are reliable.

## Definition of done for the remediation program

The project should not be considered frontend-ready until all of the following are true:

- Production loads empty and deploys only a reviewed public artifact.
- Session parsing is schema-validated and cannot alter prototypes or inject markup.
- Every mask, histogram, fit, and report is tied to an exact versioned sample/channel/QC/model identity.
- Concurrent or cancelled work cannot commit stale results.
- The full functional suite passes in CI and covers current UI semantics.
- Large-file operations meet agreed memory, long-task, render, and interaction budgets.
- Core file loading, modeling, plotting, tables, dialogs, and errors are usable by keyboard and screen reader at narrow widths and zoom.
- WCAG AA contrast and reduced-motion requirements are enforced by tokens/tests.
- Local FCS persistence is visible, bounded, verifiable, and completely clearable.
- Help, diagrams, release previews, and runtime controls describe the same product.
