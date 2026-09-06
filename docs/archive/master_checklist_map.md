> Archived 2026-09-05 from docs/master_checklist_map.md. Historical findings are reconciled in the master checklist; unchecked boxes here are not an active work queue. [Current register](../audits/master_checklist.md).

# Master Checklist Map

A working map for `docs/audits/master_checklist.md`. The checklist is the **register**
(what must be true); this file is the **route** (what order to do it in, what is already
done, and where the traps are).

---

## HOW TO USE THIS — read before touching code

You are **one agent working solo**. Do not spawn a team. A six-teammate split of this
checklist was attempted on 2026-08-18: it ran ~2 hours, produced 8 lines of code, and
consumed a weekly usage quota, because every agent starts cold and re-derives the same
context before it can do anything. Solo is both cheaper and faster here.

### Tick boxes as you go — this is the single most important habit

`docs/audits/master_checklist.md` is the source of truth for status. **Update it as you
complete work, not in a batch at the end.** The register is currently known to
under-record reality (see the reconciliation table below) precisely because previous
sessions did the work and never went back to tick it. Do not repeat that.

Status legend used by the register:

| Mark | Meaning |
|---|---|
| `[ ]` | open |
| `[x]` | done — implementation **and** test **and** acceptance criterion all satisfied |
| `[~]` | partial — say in-line what is missing |
| `[?]` | needs evidence — believed true, not yet proven |

Rules for ticking, taken from the register's own preamble:

1. **Do not tick an item because the symptom disappeared.** Tick when there is an
   implementation, a regression test that fails on the old behaviour and passes on the
   new, and the stated acceptance criterion is met.
2. Individual sub-boxes within an item are ticked independently. An item's heading is
   only "done" when every sub-box under it is.
3. If an item is blocked on data or access the project does not have, mark it `[~]` or
   leave it `[ ]` and **write down exactly what is missing**. That is a valid, valuable
   outcome — it is not failure, and it is much better than a fabricated tick.
4. Keep the issue ID in commit messages: `fix(MODEL-02): deconvolve the smoothing
   kernel`. One testable issue per commit.

### Report cadence

After each item, state (a) what you ticked, and (b) which boxes under that same item
remain unchecked and why. The user has asked for this explicitly.

### Verify before you build

Roughly a dozen items in the register are **already implemented but not ticked**. Check
the reconciliation table below *first*. For those items your job is to verify and record
an evidence pointer (`file:line`, test name), not to rebuild something that exists.
Rebuilding already-working code is the main way to waste this checklist's budget.

### Gate commands

```
npm run check        # full gate: preflight -> lint:js -> check:dom -> check:docs ->
                     # check:imports -> check:privacy -> test:ci + test:unit ->
                     # build -> check:dist -> check:privacy
npm run lint:js      # fast
npm run check:dom    # fast, and the one most likely to bite you (see traps)
npm run check:docs   # fast; validates every HTML/MD link
npm run check:imports# fast; proves 0 import cycles
npm run check:privacy# fast; no private biological data may be tracked
npm run test:unit    # several minutes -- run on a batch of changes, not per edit
```

Run the cheap checks continuously; run `npm run check` before declaring anything done.
Release-facing items require the production `dist/` tests too, not just the source tree.

### Verified baseline — any regression from these is a failure

Measured at `fd74f10`, `npm run check` exit 0:

| Metric | Value |
|---|---|
| Unit tests | **735 / 735** |
| Import graph | 110 modules, 369 edges, **0 cycles** |
| DOM bindings | 226 static IDs + 4 generated |
| Docs | 14 HTML + 15 Markdown (this file makes 16) |
| Privacy | 505 tracked paths |
| `dist/` | 45 files |

> The checklist header claims **756/756**. That number is **stale** — it predates the DJF
> pipeline deletion in `5ac4956`. The real count is 735. Several other numbers in the
> register (dist 43/44, imports 137/428, privacy 527, docs 17 MD) are stale for the same
> reason. Correct them when you touch the surrounding text.

### Traps that will cost you a build

- **`scripts/check-dom-bindings.mjs`.** Every `querySelector("#id")` / `getElementById("id")`
  in `js/` must match a static `id="..."` in `index.html` or appear in the hardcoded
  `dynamicIds` allowlist (`select_all_files`, `file_table_status`, `djf_fit_table`,
  `pf_tooltip`). **Add the markup in the same change as the code that references it**,
  or `check:dom` hard-fails.
- **`js/plotting/data.js` runs `document.querySelector` at module top level.** It cannot be
  imported by anything that must run in a worker. Numeric/domain modules stay leaves;
  the presentation layer imports *from* them, never the reverse.
- **`js/analysis/cell_cycle/result_contract.js` is the most cross-cutting file in the repo.**
  Changing its exported API ripples into UI, export, session, and QC. Check consumers first.
- **Private data lives outside the repo** at `../test_flow_data/` and must stay there.
  `npm run check:privacy` enforces this.
- **The `.venv` symlink has no `flowio`**, so
  `tests/validation/driving_code/generate_flowio_reference.py` fails under it. Nothing in
  `npm run check` needs flowio.
- **Do not commit or push unless asked.** Leave work in the working tree for review.

### Hot files — change deliberately

`index.html` · `js/ui/dom.js` · `js/main.js` · `scripts/check-dom-bindings.mjs` ·
`docs/audits/master_checklist.md`

These are needed by many items at once. `js/fcs/**`, `js/io/**`, and `js/data_structs/**`
are not covered by any checklist item — touch them only with a reason.

### Where the detail lives

The register's Appendix B maps each area to its deep-dive document. Two you will need early:

- `docs/audits/cell_cycle_model_investigation_handoff.md` §5 — **read before changing any
  model code.** Five model changes were measured; **four made results worse.** Do not
  re-attempt them blind.
- `docs/plans/cell_cycle_modeling_plan.md` §5.6 — the CLOCCS spec of record.
  (`CLOCCS_modeling.md` does not exist anywhere in the repo.)

---

## RECONCILIATION — the register under-records reality

Verified against the tree at `fd74f10`.

### Recorded open, but already IMPLEMENTED (verify + evidence pointer, do NOT rebuild)

| Item | Evidence |
|---|---|
| MODEL-03 | `peak_regions.js:36-43` `UNRESOLVED_SIGMA_BINS` + `deconvolveSmoothing()`; applied `:269`; kernel assertion `:240-243` |
| MODEL-04 | `peak_regions.js:183` `parabolicPeakOffset()`; clean-side guard `:261-263` |
| UI-01 (part) | `index.html:247` `role="status" aria-live="polite"`; warning marker in `js/ui/cell_cycle_columns.js` |
| UI-02 (part) | `modeling_ui.js:539-557` suppresses zero-valued terms; `:579-580` distinct `CANCEL_REASON_DETECTION` / `CANCEL_REASON_FITTING` |
| UI-03 | `css/base.css:24` `--border: #7386aa` (meets 3:1 non-text contrast) |
| UI-04 | `forced-colors` blocks: base 1, feedback 4, help 1, layout 2, plot 4, sidebar 2, table 2; `focus-visible`: table 6, feedback 4 |
| UI-06 | the `setTimeout(open_metadata_wizard, 750)` auto-open is gone; only a historical comment at `js/ui/metadata_wizard.js:454` |
| UI-07 | `index.html:338` `#plot_tool_axes` exists in `#plot_toolbar` |
| UI-11 | `css/table.css:136-144` checkbox target raised 17px -> 24px with a rationale comment |
| QC-02 (part) | `pipeline_ui.js:314-337` writes `data-gate-state` per gate plus an aggregate |
| REL-02, REL-03, DOC-03, FEAT-02, LEGACY-01 | reported done in `docs/audits/master_checklist_status.html` — confirm, don't rebuild |

### Confirmed GENUINELY OPEN (no implementation present)

| Item | Evidence of absence |
|---|---|
| MODEL-06 | `refine_local_area()` has no `baseline` parameter (`watson_pragmatic.js:117`) |
| QC-01 | **nothing anywhere supplies `qcAcknowledgements`** — `result_contract.js:293-298` blocks reporting forever. The gate is a dead end, not a safeguard |
| UI-05 | `css/responsive.css` has exactly one `@media (max-width: 820px)` |
| UI-12 | zero `prefers-color-scheme` / `data-theme` anywhere in `css/` or `js/`; `css/base.css:6` is `color-scheme: light` |
| UI-13 | zero `residual` references in `js/plotting/` |
| UNC-01 | no uncertainty machinery exists at all |
| PERF-01 | `fit_client.js:6,134,163,208` documents a silent main-thread fallback |
| CLEAN-02 | three `docs/X.html` vs `docs/audits/X.html` pairs remain: `color_use`, `user_controlled_vars`, `djf_diffs` |
| CLEAN-04 | `help/djf-model-validation.html`, `help/result_validation.html`, `help/tool_validation.html` are absent from `help/index.html` — they ship unreachable |

### Possibly moot — verify before doing any work

- **UI-10** refers to a `run_all` control that was **deleted in `5ac4956`**. If it is moot,
  record it as obsolete with the evidence rather than inventing work.
- **MODEL-05** was measured **inert**. Either build a fixture where subtracting the pedestal
  provably moves the crossing bin, or close it as not-a-defect with a written justification.
  Do not land an inert change.

---

## PHASES

Grouped for **subsystem cohesion**, not equal size — phase 5 has 16 items, phase 3 has 7.
Within a phase, do the cheap verifications first, then the genuinely open work.

### Phase 1 — Estimator core, model math, uncertainty
**Items:** MODEL-03(verify), MODEL-04(verify), MODEL-05, MODEL-06, MODEL-07, MODEL-08,
MODEL-09, SCI-08, UNC-01
**Files:** `js/analysis/cell_cycle/peak_regions.js`, `peak_detection.js`, `models/**`,
`fit_engine.js`, `js/analysis/math/**`, `js/analysis/pipeline/dna_histogram.js`,
NEW `js/analysis/cell_cycle/uncertainty.js`
**Tests:** `unit_tests_cell_cycle_{math,model_shared,watson_pragmatic,watson_classic,dean_jett,dean_jett_fox,peak_detection}.py`, `unit_tests_cloccs.py`

UNC-01 is the largest single item in the register and nothing exists yet. Land it in
priority order — (1) Jacobian/Hessian rank, condition number, parameter correlation;
(2) bootstrap intervals; (3) weak-identifiability flags; (4) persisted method/seed/replicates;
(5) coverage validation — rather than attempting all of it at once.

### Phase 2 — Scientific diagnosis, validation, fixture governance
**Items:** MODEL-01, MODEL-02, SCI-07, VALID-01, PEAK-01, TEST-02, TEST-03, DOC-01, FEAT-04
**Files:** `tests/validation/**`, `docs/audits/cell_cycle_model_investigation_handoff.md`,
`docs/scientific-result-contract.md`, `docs/audits/baselines/**`,
`docs/plans/cell_cycle_modeling_plan.md`, `docs/fcs-analysis-compatibility.md`,
`docs/references/**`

This phase **diagnoses**; the fixes land in Phase 1. **MODEL-02 is on the critical path** —
it blocks MODEL-06 and MODEL-07 (see D1). Do it early.

Data available locally, outside the repo:
- `../test_flow_data/Asynchronous_UsedAsFloJoDFJSampleDataset/` — 30 async FCS samples, the
  FlowJo reference set, plus reference spreadsheets. This is "the 30-sample validation".
- `../test_flow_data/AlphaFactorSynchronizedHaplodis_.../` — 121 synchronized files with
  **no reference values** (FEAT-04). A previous partial run classified 115/116 as
  asynchronous **using a misconfigured probe** — re-run before concluding anything.
- `tests/validation/validation_test_data/external_fcs/datasets/li_2026_cloccs/` — 32 FCS
  files (2 replicates × 16 timepoints), gitignored but tracked in `external_fcs/manifest.json`
  **with real published CLOCCS reference parameters** (FEAT-04). Already wired via
  `discover_cloccs_series()`/`execute_cloccs()` in `validation_tests.py` — run it with
  `--files cloccs`. This one *does* have reference values (unlike AlphaFactor above), so don't
  repeat "no reference dataset exists" for FEAT-04 without checking this first.
- Three more externally-sourced, **genuinely redistributable** datasets are already wired
  via `discover_external()` in `validation_tests.py` (VALID-01 box 3): the Miltenyi PBS fixture
  (`external_fcs/files/fcsparser_miltenyi_pbs_fcs31.fcs`, MIT, MACSQuant, FCS3.1, parser-conformance
  only), Rodighiero et al. 2024 (`external_fcs/datasets/rodighiero_2024/`, CC0-1.0 via Dryad, FCS3.0,
  Kasumi-1/MDA-MB-231, includes negative-control/contaminant files and 2 FCS files with real
  published phase percentages), and Amouzgar et al. 2025
  (`external_fcs/datasets/amouzgar_2025/`, CC-BY-4.0 via Zenodo, FCS3.0, mass cytometry/CyTOF,
  diagnostic-only). **License/instrument/format facts for the latter two live per-artifact inside
  `manifest.json`'s `artifacts[]` array, not at the dataset's top level** — a top-level dump of
  `license`/`format` returns empty for these two; don't conclude "no license recorded" from that
  alone. This closed a second stale claim in VALID-01 (box 3), the same shape as the FEAT-04 fix
  below.

### Phase 3 — QC subsystem and pipeline
**Items:** QC-01, QC-02, QC-03, QC-04, QC-06, QC-CAL-01, AMBIG-01
**Files:** `js/analysis/qc/**`, `js/analysis/gating/**`, `js/analysis/pipeline/**`
(except `dna_histogram.js`), `docs/plans/peak_tracking_time_qc_implementation_spec.md`
**Tests:** `unit_tests_time_qc_*.py`, `unit_tests_djf_*.py`, `unit_tests_gate_contract.py`, `unit_tests_scatter_preview.py`

**QC-01 is P0 and the highest-value open item in the register.** The acknowledgement flow
must invalidate a prior acknowledgement when the QC config or the file bytes change —
an acknowledgement that survives a config change silently re-authorizes a different
analysis. That property needs its own test.

**QC-CAL-01 gates QC-03, QC-04, QC-06 and STAT-01's threshold item**, and the labelled
data it requires **does not exist in this project**. Do not fake it. Deliver the study
protocol, determine honestly whether synthetic injected disturbances can calibrate
anything, and state precisely which thresholds remain uncalibratable.
**2026-08-21 update:** done — see the changelog row below. Real acquisitions still don't
exist; a synthetic, honestly-labelled corpus does now, verified against the real
detectors, and it surfaced two genuine (not fixture-artifact) calibration findings. The
acceptable-rate policy call and real-instrument data remain the two things only the user
can supply.

**AMBIG-01:** do **not** attempt another local heuristic for the (1C,2C) vs (2C,4C)
ambiguity — two were tried and both provably failed. The work is *marking* the guess
(`inferred_g2` currently always assumes the lone peak is G1, silently wrong on a
G2-arrested sample), not replacing it.

### Phase 4 — Result contract, provenance, session, orchestration
**Items:** GATE-01, STATE-01, DOMAIN-01, SCI-03, SCI-05, STAT-01, LEGACY-01, MAINT-02,
PERF-01, FEAT-02(verify)
**Files:** `js/analysis/cell_cycle/{result_contract,constraint_audit,diagnostics,domain_sensitivity,export,modeling_state,model_registry,fit_client,fit_worker,cloccs_client,cloccs_worker,bin_settings_sync}.js`,
`js/session/**`, `js/state/**`, `js/util/worker_protocol.js`, `docs/model-result-contract.md`
**Tests:** `unit_tests_cell_cycle_{fit_orchestration,modeling_state,registry,worker,export}.py`,
`unit_tests_{domain_sensitivity,state_reproducibility,session,stat_constraints}.py`

GATE-01's real work is **enforcement coverage**, not existence. The contract exists; prove
every reporting surface consults it and that a non-reportable result cannot leak through.

### Phase 5 — UI, accessibility, theming, plot rendering
**Items:** UI-01, UI-02, UI-05, UI-06, UI-07, UI-08, UI-09, UI-10, UI-11, UI-12,
UI-13/FEAT-01, UI-14, PERF-02
**Files:** `css/**`, `js/ui/**` (except `dom.js`), `js/plotting/**`,
`js/analysis/cell_cycle/modeling_ui.js`, `peak_review_ui.js`, `js/util/{html,names,clone}.js`
**Tests:** `tests/ci/test_contrast_tokens.py`, `unit_tests_{table,summary_stats,peak_focus_range,io}.py`

Five of these are verify-only (UI-03, UI-04, UI-06, UI-07, UI-11) and one may be obsolete
(UI-10). Do that sweep first — it is cheap and it shrinks the phase substantially.

For UI-12, every colour token needs a definition on **bare `:root`**, with dark redefined
under both `@media (prefers-color-scheme: dark)` guarded as `:root:not([data-theme="light"])`
**and** `:root[data-theme="dark"]`, so an explicit toggle wins in both directions. Extend
`test_contrast_tokens.py` to the dark palette; light-mode contrast must not regress.
Accessibility claims need **measured numbers** (contrast ratio, zoom width, target px).

### Phase 6 — Docs, help, build, cleanup, release
**Items:** DOC-02, DOC-03, CLEAN-01, CLEAN-02, CLEAN-03, CLEAN-04, REL-01, REL-02, REL-03,
REL-04, TEST-01, MAINT-01, Section 11 audit
**Files:** `README.md`, `help.html`, `help/**`, `docs/**`, `scripts/**` (except
`check-dom-bindings.mjs`), `vite.config.js`, `public/**`, `.github/**`, `.githooks/**`,
`eslint.config.mjs`, `tests/e2e/**`, `tests/ci/**`, `LICENSES/**`,
`THIRD_PARTY_NOTICES.md`, `package.json`

Before deleting anything, read it and check inbound links; prefer `git mv` into
`docs/archive/audits/archive/` over `rm` for anything with historical value. `help/djf-model-validation.html`
likely describes the DJF pipeline deleted in `5ac4956` — archive rather than link.

TEST-01 includes a real hygiene defect: the top-level `tests/unit/*.py` files are
**untracked stale duplicates**; only `tests/unit/driving_code/*` is tracked.

**Section 11 runs last** — it audits everything else.

---

## DEPENDENCIES

| # | Dependency | Why it matters |
|---|---|---|
| D1 | MODEL-06 and MODEL-07 land **after** MODEL-02 is diagnosed and MODEL-03 validated | with G2 correctly placed the overlap shrinks and the correct size of the fix changes; landing early may over-correct and starve G2 |
| D2 | MODEL-09 canonical bin constant | ✅ done — `DEFAULT_BIN_COUNT` in `dna_histogram.js`, re-exported by `plotting/data.js` |
| D3 | UNC-01 fields must reach the result contract and export | define the payload shape before building the machinery |
| D4 | QC-01 acknowledgement panel needs an anchor id in `index.html` | markup + code in one change (`check:dom`) |
| D5 | UI-12 theme control needs markup + a `dom.js` export | markup + code in one change |
| D6 | UI-13 residual strip needs container ids | markup + code in one change |
| D7 | SCI-05 spans sidebar / table / TSV / legend | write the cross-surface test, then fix whichever surface disagrees |
| D8 | Section 11 audit needs every other outcome | runs last |
| D9 | AMBIG-01 ambiguous flag must be honoured by the contract | ✅ done — `model_preflight()` carries `peakDetectionStatus`, `apply_result_contract()` qualifies `inferred_g2` fits with `RESULT_REASON.REGIONS_AMBIGUOUS_SINGLE_PEAK` (refuse already existed via `REGIONS_UNREVIEWED`) |

---

## COVERAGE

**67 tracked IDs.** 63 appear in the phases above. The remaining four are deliberately absent:

| Item | Why not in a phase |
|---|---|
| ENV-01 | **Resolved** 2026-08-15 — Node pin moved to 24.x; every box already ticked |
| ENV-02 | **Resolved** 2026-08-15 — `scripts/python.sh` + `.venv`; every box already ticked |
| FEAT-03 | P3, explicitly deferred behind VALID-01 |
| FUTURE-01 | P3, explicitly "correctly deferred" pending VALID-01 |

---

## PROGRESS LOG

Append here as you go, and tick the register itself.

| Date | Item | State | Evidence |
|---|---|---|---|
| 2026-08-18 | MODEL-08 | implemented, **test pending** | `watson_pragmatic.js:243` `counts.map(...)` -> `Array.from(counts, ...)`; `.map()` on a typed array returns the same typed array type and would silently truncate the Gaussian-residual arithmetic to integers |
| 2026-08-18 | MODEL-09 | implemented, **test pending** | `DEFAULT_BIN_COUNT` unified to **256** in `dna_histogram.js` (pure leaf, worker-safe); `plotting/data.js` re-exports it as `DEFAULT_BINS`. Verified every production caller passes an explicit `binCount`, so the old 512 fallback was unreachable and no fit result changes |
| 2026-08-18 | MODEL-08 | ✅ **done, ticked** | 3 tests appended to `unit_tests_cell_cycle_watson_pragmatic.py`. One proves the hazard is real (`Int32Array.prototype.map` truncates this exact arithmetic) so the other two can't pass vacuously; one feeds an `Int32Array` histogram and asserts fractional residual S counts (206 nonzero / 206 fractional); one asserts typed and plain inputs give identical fits. Grep box closed: `lm_solver.js:192` and `peak_regions.js:277,280,281` map over structurally-plain arrays, so no further edits. **Premise correction recorded in the register** — the `.map()` sat behind *two* guards, not one: `fit()` at `:226` already does `Array.from(histogram.counts ?? histogram.y)` on entry |
| 2026-08-18 | MODEL-09 | ✅ **done, ticked** | New suite `unit_tests_bin_settings.py` (4 tests), registered in `run_unit_tests.py`. Pins the *relationship* — identity between the two constants, membership in `BIN_STOPS`, non-finite fallback index, stop round-trip — rather than the number 256. Stale docstring at `plotting/data.js:280` ("default 512") corrected in the same change |
| 2026-08-18 | gates | ✅ green | `npm run test:unit` **742/742** (was 735; +7 new). Import graph regenerated for the new `plotting/data.js -> dna_histogram.js` edge: 110 modules / 370 edges / 0 cycles |
| 2026-08-18 | MODEL-03, MODEL-04, QC-02, UI-03, UI-04, UI-06, UI-07, UI-11, REL-02, REL-03, FEAT-02 | ✅ **ticked** | Implementations were already in the tree and unrecorded; each box ticked against a `file:line` rather than re-implemented. FEAT-02 was briefly mis-reported as unwired — a `grep -v "export.js:"` filter also excluded `plot_export.js`; it does import and use both export builders (`plot_export.js:30,408,419`) |
| 2026-08-18 | QC-01 (flow) | ✅ **done, ticked** | The gate was a dead end: the contract blocked on `qcAcknowledgements` and nothing wrote it. Now `qc_review_ui.js` (inline `#qc_critical_review` panel) writes records, `modeling_state.js` threads them, and the session round-trips them. **Step 4 is enforced by identity, not revocation**: `qc_acknowledgement_key()` binds a record to the stage's `configHash` + evaluated/rejected/retained counts, so a config or file change moves the key and the record silently stops authorizing. 17 tests in `unit_tests_qc_acknowledgement.py`, weighted to the negatives |
| 2026-08-18 | QC-01 (matrix) | ✅ **done, ticked** | New pure module `js/analysis/pipeline/qc_matrix.js`: every **loaded** sample × all four stages, plus final-mask provenance. Exposed as a QC-matrix TSV in the download modal and as a section of the HTML analysis report. `final_mask_provenance()` **recomposes** the stage masks and compares against the stored `masks.final` rather than listing which stages ran, so a stale mask is caught. 20 tests in `unit_tests_qc_matrix.py` |
| 2026-08-18 | gates | ✅ green | Full `npm run check` exit 0. `test:unit` **779/779** (was 742; +37). Import graph 112 modules / 379 edges / 0 cycles. `check:dom` 231 static IDs. `check:dist` 44 files. `check:privacy` 505 tracked paths |
| 2026-08-18 | MODEL-05 | ✅ **done, ticked** | The register's "measured inert" finding was recorded *before* MODEL-03 landed. MODEL-03 made the flank crossing linearly **interpolated**, so the threshold's absolute value now feeds straight into sigma. Re-measured: σ error grows linearly with the pedestal (+1.54% at 2%, +23.18% at 30%), and above a 10%-of-peak pedestal the crossing **bin** moves too — the fixture the checklist asked for exists. 4 tests appended to `unit_tests_cell_cycle_peak_detection.py:399` |
| 2026-08-18 | MODEL-05 | ⚠️ **first fix rejected** | Reading the pedestal at the **region edge** — the obvious estimate, and the one the register's own code sketch implies — breaks a stronger invariant this repo already tests: *a region bounds the mean and nothing else*. It moved %S by 8.93pp and `g1CV` by 0.0249 across tight/default/wide regions (tolerances 1.5pp / 0.005), because a tightly drawn box has its edges on the peak's own flanks. Landed version samples at **3σ from the centre**, a distance set by the peak, and subtracts nothing when the region does not reach that far |
| 2026-08-18 | gates | ✅ green | `npm run test:unit` **783/783** (was 779; +4) |
| 2026-08-19 | MODEL-04 | ✅ **done, ticked** | The last box was a *validation* box, so it needed a paired run, not code. Baseline = detached worktree at `fd74f10` with `subBinOffset` forced to 0; 358 paired rows (30 samples × 8 QC configs, 4 shards). The gate — G1 improves, G2 does not regress — clears with room: `g1_mean` within-tolerance 220→226, `g2_mean` 90→103, `ratio` 157→175, and **zero rows lost a pass** on any of the three. `all_pass` 43→51. The asymmetry is the mechanism: a sub-bin error at G1 propagates to ~2× at G2 and full-strength into the ratio, so the fix is worth ~2× more at G2 than at G1 |
| 2026-08-19 | SCI-08 | ✅ **done, ticked** | Also a comparison box; the Bernstein change itself landed in `8164285`. Measured what the item is named for: the old `projectQuadraticProfile()` ray-shrink fired on **6.22%** of DJF profile evaluations across **all 28** fixtures (worst `q(z)` = −52.71), i.e. the model was routinely being evaluated at a point the optimizer had not chosen. Removing it took DJF convergence 25/28 → **28/28** and mean error 10.118 → 9.993 pp, *despite* the Bernstein basis being a strictly smaller function class (non-negative by construction) — a slightly worse deviance was the expected price and was not paid. Cost recorded rather than hidden: softmax saturation zeroes the shape Jacobian columns, so singular condition estimates went 18/28 → 28/28 DJF. That is precisely the condition UNC-01 exists to surface |
| 2026-08-19 | UNC-01 | 🟡 **2 of 7 boxes ticked** | New `js/analysis/cell_cycle/uncertainty.js` (~520 lines) + 35 checks in `unit_tests_uncertainty.py`. Boxes 1 (rank/condition/correlations) and 5 (qualified/nonreportable flagging) are closed; the remaining five all need a **resampling** layer that does not exist yet — see the row below. Covariance is `(J'J)^-1` with **no dispersion factor**: the objective is Poisson *deviance*, so `sum(r²) = −2logL + C` and dispersion is known = 1. Wired into both `dean_jett` and `dean_jett_fox`; warnings fold into `result.warnings` |
| 2026-08-19 | UNC-01 | ⚠️ **design defect the tests caught** | The shipped thresholds made one warning **unreachable**. Forming `J'J` *squares* the condition number, so `RANK_TOLERANCE = 1e-10` on eigenvalue ratios corresponds to a Jacobian condition of only `1e5` — far below `CONDITION_WARNING_THRESHOLD = 1e8`. Every ill-conditioned fit was therefore classified rank-*deficient* first and `ill_conditioned` was dead code; a noiseless 9-parameter Dean–Jett fit reported rank **6/9**. Fixed to `1e-14` / `1e6`, and an invariant test now asserts `CONDITION_WARNING_THRESHOLD < 1/sqrt(RANK_TOLERANCE)` so the band cannot be closed again. **Any future threshold pair on these two quantities has to be read in this squared relationship** |
| 2026-08-19 | gates | ✅ green | `npm run test:unit` **818/818** (was 783; +35) |
| 2026-08-19 | MODEL-02 | 🟡 **diagnosed — both investigation boxes ticked, the fix box re-scoped** | Ran all 30 samples of `flowjo_async_djf` through the *app's own* modules hosted in node (validated first against the browser path: `1468f` reproduces the recorded −0.70% to within 0.02pp). Box 1's stage table shows no step change anywhere — the offset is in the histogram before the model touches it. Box 2 refutes the register's own leading hypothesis: holding **bin width** fixed while growing the range 1000→1500 moves `g1Mean` by **0.014 channels**, so the `$PnR` ceiling is not the cause. The real answer is neither branch of that either/or — the **fit-free mode** of the gated histogram already carries the whole offset (−1.66% vs the fitted −1.61%), so it is not an estimator defect either |
| 2026-08-19 | MODEL-02 | 🔬 **the mechanism, confirmed by pinning it** | What differs from FlowJo is **width**, not location: their G1 CV is 1.47× ours (9.17 vs 6.20) and our G1 peaks are right-skewed 1.321:1 at half max, so a wider Gaussian is pulled up the heavy side. Refit each G1 peak with σ **pinned** — free amplitude, free mean, our CV then FlowJo's, nothing else changed: median error −0.97% → **−0.09%**, closing **74%** of the gap on width alone. The two samples where our fit already sits *above* reference (`1468i`, `1693i`) are exactly the two peaks that are not right-skewed. Third box re-scoped accordingly: **do not widen σ to match** — that is the MODEL-01 mistake one step earlier in the chain. Which σ is right is now the open question |
| 2026-08-19 | MODEL-01 | 🟡 **2 more boxes ticked (2 of 4 now)** | The offset box closes via MODEL-02. The decomposition box needed a post-MODEL-03 re-run and now has one: g1 −1.61% + ratio −1.55% = −3.15% against an observed g2 −3.19% — the identity still holds, slightly tighter than the 2026-08-14 figures. Our free ratio is still ~1.977. The strongest new support for *not* tuning `g2_mean`: the same ratio deficit (−1.48%) shows up in the fit-free histogram **modes**, so it survives removing every fitting step. Remaining 2 boxes are documentation |
| 2026-08-19 | MODEL-06 | ✅ **done — the register's own patch was measured and rejected** | The defect is real: `refine_local_area()` divides summed counts by summed template mass, so background inside the window is scaled up into peak area (N_G2 +0.07% → **+63.64%** as background goes 0 → 8/bin). But the fix written into the register — read the pedestal at the **contaminated** window edge — is catastrophically wrong: `contaminatedWindowSigmas` is 1, where a Gaussian is still at **61% of peak height**, giving **−61% to −74%** area error on every background. Reusing MODEL-05's `pedestalUnderPeak()` was the second candidate and also fails: its "outside the region → 0" gate, routed into the *area*, breaks the region invariant (%S spread **8.28pp** against a 1.5pp tolerance). What landed reads the **clean** window edge — MODEL-05's rule without MODEL-05's gate, clamped to the histogram not the region |
| 2026-08-19 | MODEL-06 | 🔬 **the refinement measurement forced** | Reading the *raw* floor at the clean edge is a third wrong answer: 3σ out a Gaussian is still at 1.11% of peak (~2 counts/bin), so it subtracts the peak's own tail and biases a **background-free** histogram low — enough to push the SCI-01 bridge-free S-leakage from 45.5 to 72.1 events against a 66-event bound. So the tail is discounted first, sized by the **un-subtracted** area, which is background-inflated — the pedestal therefore errs **low** by construction. Result: N_G2 drift 63.6pp → **8.8pp** (7.2×), inert at zero background (pedestal exactly 0, bit-for-bit the old estimator), and region invariance *improves* 2.020pp → **1.173pp**, moving a pre-existing breach back inside tolerance |
| 2026-08-19 | MODEL-05 | 📝 **limitation recorded (not a reopen)** | Found while measuring MODEL-06: the out-of-region fallback is **anti-correlated with need** — a taller pedestal inflates the bootstrap σ, pushing the 3σ sample point out of the region and disabling the correction exactly when it matters most. At a ±3σ region the fitted G2 σ drifts 20.95 → 24.30 across 0 → 800/bin background; at ±3.5σ it is flat at ~21.07. Left as-is: the failure mode is "reverts to pre-MODEL-05", and every alternative re-introduces the region dependence MODEL-05 exists to prevent. Recorded as a region-drawing guideline instead |
| 2026-08-19 | gates | ✅ green | `npm run test:unit` **825/825** (was 818; +7 MODEL-06) |
| 2026-08-19 | MODEL-07 | 🚧 **re-measured — stays blocked, and the reason got sharper** | Did not assume the D1 unblock. Reproduced the removed async/sync BIC comparison and re-ran it: the clean-flank peaks improved **7.7× in deviance** since removal (1289.6 → 167.9) and the selection is **still wrong** (ΔBIC −13.1, picks synchronous on wave-free data). Worse, it now fails *silently* — `w` no longer pins to its 0.95 ceiling (0.5877) and the synchronous fit now **converges**, so both tells that made the old failure recognisable are gone. Three of the register's four guards (ΔBIC > 10, bumpFraction ≥ 2%, cohort-inside-S) **pass on the wrong answer**; only restart stability discriminates, by 75× (deviance spread 30.18 vs 0.40 at true peaks) |
| 2026-08-19 | MODEL-07 | 🔬 **what is actually left, quantified** | The residual is `g2Mean` 137.69 for a true 140 (**−1.65%**) — literally MODEL-01/MODEL-02's offset, the box deliberately left open. Correcting **either** half is enough: true widths → ΔBIC +4.8, true means → +5.6, both correctly asynchronous and both *below* the 10-point threshold, so the selection abstains rather than guesses. Landed no feature; landed 2 tests that pin the blocker (**the BIC test failing is the signal to re-land**) and replaced the stale numbers in `dean_jett_fox.js`, which claimed a ceiling and a non-converging fit that are both now false |
| 2026-08-19 | gates | ✅ green | `npm run test:unit` **827/827** (was 825; +2 MODEL-07) |
| 2026-08-19 | shared math | ♻️ **relocated, not rewritten** | `makeRng` (mulberry32) and Acklam's `inverseStandardNormalCdf` were private to `cloccs_synthetic.js` and about to be copy-pasted into the resampling layer. Moved to `math/stats.js` and `math/gaussian_bin_mass.js` respectively, bodies unchanged; `cloccs_synthetic.js` now imports them. Verified first that no other consumer existed anywhere in `js/` or `tests/`, so this is a move rather than a fork. Its local `standardNormalCdf` was deliberately left alone — out of scope |
| 2026-08-19 | UNC-01 | 🟡 **1 more box ticked, 4 moved to `[~]` (was 2 of 7, now 3 done / 4 partial)** | New `js/analysis/cell_cycle/resampling.js` (~825 lines) + 30 checks in `unit_tests_resampling.py`. Event bootstrap, peak-region jitter, bin/domain re-draw, percentile and Efron-BC intervals, selection frequency, and the full `{method, seed, replicates, failures, definition}` provenance all exist and are measured. **They are `[~]` not `[x]` because nothing calls the module** — same status as `analyzeDomainSensitivity` under DOMAIN-01, and the same house rule applied: a library the app never invokes does not tick a reporting box |
| 2026-08-19 | UNC-01 | ⚖️ **design decision the events made free** | The first sketch took `{edges, counts}` and reconstructed pseudo-events uniformly within bins to support re-binning — a stated approximation. `domain_sensitivity.js` already takes the retained `values` and re-bins via `generateHistogram`, so the resampling layer takes events too and the bootstrap is **exact**: every consumer downstream sees only bin counts, so resampling the retained events with replacement is the exact nonparametric bootstrap and no within-bin position is invented. The Poisson-counts path survives only as an explicitly labelled fallback that records `event_bootstrap` and `bin_domain` as skipped |
| 2026-08-19 | UNC-01 | ● **real bug found by prototyping, before it shipped** | The overlap repair in `perturbPeakRegions` moved the two **inner** edges to their midpoint, which could drag an inner edge past its own **outer** edge when regions started close together — **448 of 5000** draws emitted `left ≥ right` at `jitterFraction: 0.9`. Fixed by restoring each region's original width from the repaired inner edge. The regression test runs 3000 draws through the **real** `validatePeakRegions` (0 rejected, 0 inverted) rather than a restated copy of its rules |
| 2026-08-19 | UNC-01 | ● **ordering dependence found by writing the tests** | Selection picked `rankable[0].comparisonGroup` as *the* group, so a set spanning two non-null groups would have been silently ranked by whichever came first in the array. Replaced with `rankableOutcomes()`, which refuses a mixed set and reports `selection_group_ambiguous`. This is also where plan §5.5 stops being a declaration: a null `comparisonGroup` is dropped before ranking, and the unit fixture gives the null-group model `bic: -99999` so an unenforced rule would be unmistakable |
| 2026-08-19 | UNC-01 | 🔬 **λ ≈ 1200 is where the textbook Poisson sampler deletes your data** | `Math.exp(-1200) === 0` exactly in double precision, and λ ≈ 1200 is an ordinary G1 bin of a 300 k-event file. Knuth's product form compares a running product against that 0 and returns 0 events for every such bin — the peak vanishes from every replicate. The log-form exponential inter-arrival sampler is not a style choice; a unit check asserts both the underflow and that no bin comes back empty at λ = 1200 |
| 2026-08-19 | UNC-01 | ✅ **coverage box closed — and the headline is a negative result** | 12 runs × 60 known-truth datasets × 80 replicates. `watson_classic` holds nominal 95% or better on clean / low-count / boundary / weak-S; `dean_jett` under-covers where the peak is hard (S 73.3% at weak-S), which is MODEL-01/02's offset surfacing as interval failure. **Contaminated collapses to 0–13%**: mean bias −7.5 pp on G1, and no width rescues a biased estimator — doubling the intervals with the full perturbation set lifted S from 78% to 92% but left G1 at 13%. **Resampling intervals quantify variance, not misspecification.** The nonreportable guard partly covers it (`dean_jett` blocked on 50/60), but `watson_classic` blocks only 7/60 and reports tight, confident, wrong answers |
| 2026-08-19 | gates | ✅ green | `npm run test:unit` **857/857** (was 827; +30 UNC-01 resampling). Import graph regenerated: 114 modules / 388 edges / 0 cycles |
| 2026-08-19 | SCI-07 (fixtures) | ✅ **done, ticked** | No "before" commit exists for the dimensionless transform (present since DJF's introduction, `261e4d2`), so `fitPoissonModel`'s own built-in identity-transform fallback (`fit_engine.js:~92-97`) is the naive baseline instead of a detached worktree. Two new stress fixtures added to close the remaining axes (high event count, near-bound wave params): `truth_high_event_count_50_30_20` (300k events), `truth_djf_near_bound_wave_45_40_15` (wave params pinned near DJF's own optimizer bounds). Corpus 60→62 cases, seeds 1011/1012, `_coverage().fcs_triggerable["SCI-07"]` updated. `generate_fixtures.py --check` reproducible (93 files); `run_benchmark.py validate_corpus()` passes |
| 2026-08-19 | SCI-07 (benchmark) | ✅ **done, ticked** | Node-headless A/B (`js/fcs/parser.js` is a pure zero-import module, no Playwright needed) of `dean_jett_fox.js` vs. a patched copy with `make_parameter_transform()` forced to `null` (`fit_engine.js`'s identity fallback), across all 30 modelable fixtures. Convergence **30/30 vs 16/30**; naive routinely hits the 200-iteration cap (mean 126.7 vs 74.1 iterations); restart-converged fraction 57.2% vs 23.3%; deviance as-good-or-better in 27/30 fixtures. On the two new stress fixtures specifically: naive fails to converge at all on the high-event-count case (0% restart-converged) and converges to a 22.8% worse deviance on the near-bound-wave case (756.1 vs 584.0) with restart-converged fraction collapsing 58.3%→8.3% — the dimensionless coordinates are not cosmetic, they are why the optimizer converges at all on roughly half the corpus |
| 2026-08-19 | gates | ✅ green | `npm run test:unit` **857/857**, unchanged — `generate_fixtures.py` + 2 new fixture files introduced no regression |
| 2026-08-19 | VALID-01 (box 1, traceability) | ✅ **done, ticked** | `docs/plans/cell_cycle_modeling_plan.md` §5.3-5.5 had the equations and citations but zero `file:line` links into the implementation (`grep -c "\.js:"` was 0). Added new §5.5a: a symbol-by-symbol table mapping every equation in §5.2-5.5 to `file:line`, with units and the dimensionless-vs-channel-unit distinction spelled out per parameter |
| 2026-08-19 | VALID-01 (box 2, component grid) | ✅ **done, ticked** | Existing tests compared only the **combined** `expectedCounts()` curve, at two single fixed parameter points. Added 3 grid tests to `unit_tests_cell_cycle_dean_jett_fox.py` calling `shared.js`'s already-public `peakComponents`/`convolvedSPhase`/`convolvedSPhaseWithProfile`/`sPhaseProfile` directly (same functions DJ/DJF's own `expected_counts_from_parameters()` call — no new test-only export) across a 24-point `(shape1, shape2, g1CV, g2Mean)` grid: S-only curve nests exactly at w=0 across the whole grid (not just one point); `g1+S+g2` reconstructs each model's own public `expectedCounts()` exactly; at w>0 only the S component moves (min divergence 14.06 across the grid) while G1/G2 stay byte-identical. `npm run test:unit` **860/860** (was 857; +3, 0 regressions) |
| 2026-08-19 | VALID-01 (box 7, identifiability) | ✅ **done, ticked — already implemented, not previously credited** | `uncertainty.js`'s `multistartAgreement()` (`:417-472`) and `identifiabilityWarnings()` (`:500-628`) read the optimizer's own per-restart audit trail (`fit.attempts`) and translate rank/condition/interval/multistart evidence into a tagged warning vocabulary (`multimodal_optimum`, `restart_dispersion`, `rank_deficient`, `ill_conditioned`, ...), each carrying `nonreportable`. Wired into production at `dean_jett.js:427,435` and `dean_jett_fox.js:774,782`. Watson (`watson_pragmatic.js`, `watson_classic.js`) confirmed to have zero hits for any uncertainty/multistart/`attempts` terms — structurally exempt (no multi-start optimizer to audit, §5.5 is a local asymmetric-window fit), not a gap |
| 2026-08-19 | VALID-01 (box 8, documentation) | ✅ **done, ticked** | Added a "Validated scope, unsupported inputs, and remaining differences" section to `docs/scientific-result-contract.md` — an index (not a restatement) linking to the FlowJo-agreement scope, SCI-07's optimizer benchmark, VALID-01 box 2's component-grid checks, UNC-01's coverage-collapse-under-contamination finding, and explicitly listing what has NOT been checked (multi-instrument datasets, bootstrap/profile-likelihood intervals, domain-expert review, CLOCCS/Watson's exclusion from cross-model claims) |
| 2026-08-19 | VALID-01 | 🟡 status | 4/9 boxes closed this session (1, 2, 7, 8); boxes 4/5/6 remain `[~]` partial (unchanged); boxes 3 and 9 (redistributable multi-instrument datasets, domain-expert review) explicitly recorded as blocked on resources this session cannot source or fake — same "do not fake it" boundary as QC-CAL-01 |
| 2026-08-19 | PEAK-01 (box 1, presentation half) | ✅ **done, ticked (half)** | `peak_review_ui.js`'s `status_text()` formatted the heuristic `confidence` (`peak_detection.js:507`, a weighted score never calibrated against annotated data) as `"N% confidence"` — reads as a calibrated probability. Now `"heuristic score N/100, uncalibrated"`. `npm run test:unit` 860/860, no regression (no test asserted the old string) |
| 2026-08-19 | PEAK-01 (box 1, calibration half) | ⛔ **blocked, recorded not faked** | Calibrating detection thresholds needs independently annotated (human/orthogonal-instrument) correct/incorrect peak-pair labels this project does not have; the only "truth" available is the synthetic generator's own parameters or the FlowJo fitted-mean set, either of which would calibrate the detector against itself or a non-equivalent target. Same boundary as QC-CAL-01 — not attempted |
| 2026-08-19 | PEAK-01 (box 2, fixtures) | ✅ **done, ticked** | All 7 named categories (sub-G1 distractor, missing/weak G2, impulse, broad peak/inflated sigma, aneuploid, weak S, x/2x/4x ambiguity + width fallback) already have coverage — unit tests in `unit_tests_cell_cycle_peak_detection.py` (including two already tagged `PEAK-01` from a prior session) and/or tagged synthetic-corpus fixtures (`watson_subg1_contamination`, `arrest_g1_95_04_01`, `ratio_nondiploid_1p50`, `truth_low_s_48_04_48`). Nothing new needed authoring |
| 2026-08-19 | PEAK-01 (box 3, sensitivity/specificity/ambiguity/review rate) | ✅ **done, ticked** | Headless measurement (`peak_detection.js` has zero DOM deps, same as SCI-07's `parser.js`) against 29 `LOAD_OK` corpus fixtures with `peak_regions.g1`+`.g2` (1 excluded: `ratio_projector_regions_1_10_18_20`, an SCI-02 counterexample whose own description says its region does not bracket the real peaks). Ground truth = region midpoint, proven `== g1_mean`/`g2_mean` by `generate_fixtures.py:488`'s own construction. **Results:** status detected=9/low_confidence=10/inferred_g2=10; review rate 69.0%; sensitivity 9/9=100% within `detected`; 0 false pairs on 3 distractor-tagged cases; ambiguous (margin<0.05) 12/29=41.4%. All 3 misses land in `inferred_g2`, never `detected` — the label is reliable in-sample. One miss has an identified mechanism: `inferred_g2`'s fallback seeds G2 from `expectedRatio*g1` (default 2.0), so a genuine ratio-1.50 aneuploid sample misses by 18% by design — a documented limitation, not silently patched (AMBIG-01 forbids guessing the true ratio locally) |
| 2026-08-19 | PEAK-01 | 🟡 status | 2/3 boxes fully closed (2, 3) this session; box 1 half-closed (presentation fixed, calibration blocked on the same missing-dataset boundary as QC-CAL-01) |
| 2026-08-19 | TEST-02 (box 1, golden corpus + independent reader) | ✅ **done, ticked — already existed, uncredited** | `tests/validation/validation_test_data/external_fcs/manifest.json` already carries a real, licensed, non-synthetic golden corpus (MIT `fcsparser` instrument file + CC0 Rodighiero 2024 eLife FUCCI/EdU dataset with manual-gate reference percentages) with per-fixture `sha256` and a FlowIO 1.4.0 `oracle.expected_summary`. Not a new build — just previously uncited against this box |
| 2026-08-19 | TEST-02 (box 2, separation) | ✅ **done, ticked** | `external_fcs/` (independent, git-ignored payloads) vs `synthetic_fcs/` (self-generated, tracked, `contains_real_data: false`) are already separate directory trees/manifests; no code change, cross-referenced from the new `docs/release-and-privacy.md` section |
| 2026-08-19 | TEST-02 (box 3, outside-repo + reviewed ingestion process) | ✅ **done, ticked** | `check:privacy` already enforces outside-repo. Added a new "Ingesting non-synthetic validation data (TEST-02 box 3)" section to `docs/release-and-privacy.md` writing down, as an explicit process, the 4 steps the two existing `external_fcs` entries already followed (upstream provenance, license+redistribution basis, written privacy review, hash+independent-reader oracle); states plainly this is human-reviewed, not automated, and any new entry needs the same write-up. `check:docs` passes |
| 2026-08-19 | TEST-02 (box 4, CI hash verification) | ✅ **done, ticked — real fix** | Wired two existing-but-orphaned scripts in: `package.json` gets `"check:fixtures"` (`generate_fixtures.py --check`, folded into the aggregate `check` chain) and `.github/workflows/security.yml` gets two new steps (`generate_fixtures.py --check`, `generate_flowio_reference.py --check`) running on every PR/push to main. All three pre-verified passing locally (`generate_flowio_reference.py --check` via a scratch venv with `flowio==1.4.0`, already pinned in `requirements-dev.txt`). `external_fcs/`'s corpus can't be CI-hash-checked the same way since its payloads are git-ignored by design (box 3) — `verify.py`/`verify_phasefinder_parser.mjs` stay the local re-verification path, documented as such |
| 2026-08-19 | TEST-02 (box 5, per-fixture metadata) | ✅ **done, ticked — already existed** | Synthetic: manifest `license`/`generator`/`contains_real_data`, per-case `fcs.encoding`/`fcs.sha256`/`truth`, plus a `$SRC` TEXT keyword baked into every generated file (`generate_fixtures.py:435`). External: per-fixture `upstream`/`license`/`format`/`oracle`. Instrument/transform assumptions cross-referenced to `docs/fcs-compatibility.json` + `docs/fcs-analysis-compatibility.md`. No new work needed beyond the box-3 doc addition |
| 2026-08-19 | TEST-02 (box 6, CI/quality tracking) | 🟡 **partial, honestly recorded** | Artifact size already tracked (`report-artifact-delta.cjs`/`report:size`, wired into `security.yml` PRs). CI duration, flake rate, browser-specific failures, and benchmark drift have **no existing tracking** anywhere in the repo (grepped workflows/scripts/docs) — recorded as a genuine unimplemented gap, not fakeable from data this project doesn't have |
| 2026-08-19 | TEST-02 | 🟡 status | 5/6 boxes fully closed this session (1, 2, 3, 4, 5) — mostly by discovering and crediting a real golden corpus (`external_fcs/`) that already existed and wiring two orphaned CI scripts; box 6 is `[~]`, 1/5 sub-items done, 4/5 a genuine gap. `npm run test:unit` re-run after all `package.json`/workflow edits: **860/860**, no regressions |
| 2026-08-19 | TEST-03 (box 1, generator independence) | ✅ **done, ticked** | `generate_fixtures.py`'s own docstring already states independence as a design constraint; verified it structurally — no import of any `js/` module, no `subprocess`/`node` call, and the per-event sampling math (truncated-normal G1/G2, quadratic-CDF S-phase progress) is a different functional form from the DJ/DJF wave-convolution and Watson window equations it's tested against |
| 2026-08-19 | TEST-03 (box 2, matrix duration/cost review) | ✅ **done, ticked — found and fixed a real, currently-broken CI workflow** | Pulled actual run history with `gh run list`/`gh api .../logs` instead of reading the YAML in the abstract. **Both `security.yml` and `browser-compatibility.yml` have failed on every single run since 2026-07-30** (plain pushes to `main` included) — `actions/setup-python`'s `cache: pip` has no `cache-dependency-path`, and its default glob (`**/requirements.txt`, `**/pyproject.toml`) doesn't match this repo's `requirements-dev.txt`, so every run dies at the setup step before any test runs. This means this session's own new `security.yml` steps (TEST-02 box 4) had only ever been verified locally, never by real CI, until now. Fixed all 3 occurrences (`security.yml:26`, `browser-compatibility.yml:28,64`) by adding `cache-dependency-path: requirements-dev.txt`; `actionlint` clean on both files. The matrix's own cost design (cheap 3-browser Linux job on every PR, expensive Windows/exotic-browser job gated off PRs) was already sound once it can actually run — no further change made without post-fix duration evidence |
| 2026-08-19 | TEST-03 | ✅ status | Both boxes closed. Net effect of box 2 extends past TEST-03 itself: `security.yml` and `browser-compatibility.yml` should now actually execute on the next push/PR, which is also the first real CI validation of this session's TEST-02 box 4 additions |
| 2026-08-19 | DOC-01 (box 1, equation numbers) | 🟡 **partial, access-blocked, honestly recorded** | Tried to source Dean & Jett 1974's original equation numbers from three hosts — `rupress.org` (403), ResearchGate (403), PMC PDF (download interstitial via `WebFetch`, a Google reCAPTCHA challenge page via direct `curl`). Did not attempt to circumvent any of these. Fox 1980/Watson 1987 (Wiley) not attempted — same paywall class, near-certain to fail identically. This project's own citations (full bibliographic + DOI, `REFERENCES.md`) and its own equation-to-code table (§5.5a) are unaffected; only cross-referencing to the *original papers'* internal equation numbers is blocked |
| 2026-08-19 | DOC-01 (box 2, parameter/units/bounds/transform/equation) | ✅ **done, ticked** | §5.5a (added for VALID-01 box 1) already covers units/equation/code-location per symbol. Added: transform is always constrained-form-in-storage (e.g. `SHAPE1`/`SHAPE2` logits, not raw `b`/`c`); bounds are inherently per-fit dynamic (domain-dependent), not static constants, so the actual bounds are published on every result (`dean_jett.js:601-647`, `dean_jett_fox.js:1003-1066`) rather than tabulated once |
| 2026-08-19 | DOC-01 (box 3, phase-fraction/tail/contamination/convergence/validity/no-Auto) | ✅ **done, ticked** | All six sub-requirements were already documented, just scattered: phase-fraction formula/tail-mass/contamination in `cell_cycle_modeling_plan.md` §5.1; convergence rules across §5's numerical spec + the `converged`/`convergenceReason` result fields; model validity in `scientific-result-contract.md`'s `scientificallyValid`/`validForReporting` fields and its VALID-01-box-8 "validated scope" section; the no-Auto-model policy already has its own explicit paragraph in `phasefinder_design.md` with the ΔBIC evidence that killed it and a pointer to MODEL-07 |
| 2026-08-19 | DOC-01 (box 4, QC heuristics/failure modes/review/provenance) | ✅ **done, ticked** | Each of the 5 QC/gate modules already documents its own heuristic and failure mode in its header docstring; review requirement and provenance-field states (`not_run`/`unavailable`/`failed`/`waived`/`passed`, waiver persistence) are centrally documented in `scientific-result-contract.md`'s preflight section, with QC-01's acknowledgement flow as the concrete review mechanism. Distributed across 5 files + 1 contract doc, not consolidated into one QC reference page — recorded as such |
| 2026-08-19 | DOC-01 (box 5, canonical vs. legacy bridge) | ✅ **done, ticked — moot, and fixed the residue while there** | No bridge remains to distinguish from (`5ac4956`, LEGACY-01). The only real work was DOC-03 box 1's already-identified stale docs: `model-result-contract.md` and `phasefinder_design.md` both still described the deleted bridge as live. Rewrote both in past tense with citations; closes DOC-03 box 1 too. `npm run check:docs` passes |
| 2026-08-19 | DOC-03 | ✅ status | Both boxes now closed (diagrams were already done; box 1's last two stale files fixed as a side effect of DOC-01 box 5) |
| 2026-08-19 | DOC-01 | 🟡 status | 4/5 boxes closed this session by crediting and cross-referencing documentation that already existed (the TEST-02 pattern) plus one small real fix (stale legacy-bridge prose in two docs); box 1 is a genuine, good-faith access-blocked partial — three independent hosts blocked automated retrieval of the original papers' equation numbers, and no circumvention was attempted |
| 2026-08-21 | DOC-01 (box 1, equation numbers) — resolved | ✅ **done, ticked** | User supplied all three primary papers directly (`docs/tmp/dean_jett_1974.pdf`, `Fox_1980.pdf`, `watson_1987.pdf`), closing the access blocker above. Read all three in full. Findings, not uniform across papers: **Dean & Jett 1974 has no numbered equations anywhere in the paper** (one unnumbered displayed complete-distribution function, one unnumbered inline S-phase polynomial) — a fact about the source, not a residual access gap. **Fox 1980 numbers 5 equations**, two of which map exactly onto this codebase: eq. (4) (stated in Fox's own text as "identical to the Dean and Jett model") is `sPhaseProfile()`'s quadratic S-phase polynomial; eq. (5) (polynomial + floating Gaussian) is `dean_jett_fox.js`'s blended `combined_profile()`. Eq. (1)/(2)/(3) map to the G1/G2 Gaussian peak integrals and the broadened-S convolution. **Watson 1987 numbers 4 equations, but they describe an algorithm this codebase does not implement** — its iterative ERF-based `kG1`/`kG2` window solve and bias-corrected mean/variance recomputation (eq. 2-4) are not what `watson_pragmatic.js` does (it uses a fixed-sigma-multiple window plus a background-pedestal floor); only eq. (1)'s general windowed-S-phase-probability concept is a fair citation. All three findings, including the two negative ones, written into `master_checklist.md`'s DOC-01 box 1, `docs/references/REFERENCES.md`, and `docs/plans/cell_cycle_modeling_plan.md` §5.5a. DOC-01 is now `[x]` in full — the "where possible" qualifier in the box's own wording is satisfied by confirming, rather than assuming, where equation numbers do and don't exist or apply |
| 2026-08-19 | FEAT-04 (box 2, `CLOCCS_modeling.md`) | ✅ **done, ticked** | Re-confirmed the file doesn't exist anywhere in the repo; `docs/archive/audits/archive/current_status_of_project.md:234` already reached the same conclusion — spec of record is `cell_cycle_modeling_plan.md` §5.6, no action needed beyond citing precedent |
| 2026-08-19 | FEAT-04 (box 1, validate against real synchronized data) | ✅ **done, ticked — diagnostic evidence only, no reference values exist** | The prior 115/116-asynchronous result (`cell_cycle_model_investigation_handoff.md` §5.6) came from a probe that set `pnr: {}`, silently disabling Structural QC's `$PnR` saturation ceiling — that failure belongs to the probe. Wrote `tests/validation/driving_code/run_alphafactor_cloccs.py`: starts a loopback-only test server rooted at the repo's *parent* dir (so `/PhaseFinder/...` and `/test_flow_data/...` are same-origin for the run's lifetime only — dataset is never copied/symlinked into the repo, consistent with the privacy boundary), then calls the same `CLOCCS.fitCloccsForStrainAsync` browser-side code `execute_cloccs` uses, per strain series grouped from filenames (9 strains, times parsed via regex from `_t{N}__`). Found and fixed one real bug along the way: the PI detector is spectrally multiplexed, so `$PnS` is `PI/LSS-mKate/PerCP-A` on every file (verified via the real `FCSParser`, not guessed) — exact-match `indexOf("PI")` silently threw; fixed to a leading-token match.
  **Full 9-strain/121-file run completed** (~78 min total). Result: **all 9 series `NOT CONVERGED`** (hit the multi-start iteration budget). Objective values agree tightly across each strain's 3 starts (CV 0.03–0.4%), but `lambda` (cycle length) disperses widely across starts at matching objective for most strains (CV 0.37–1.40, e.g. `1693o` 4.2–1841.6 min) — a flat-ridge signature, i.e. `lambda` is not well identified by this dataset even where the optimizer agrees with itself. Phase fractions stay largely flat across most strains' time courses rather than showing the expected G1→S→G2/M synchronization wave. Recorded as diagnostic evidence of weak identifiability/non-convergence, explicitly not pass/fail validation (no reference values exist) and not read as either "CLOCCS works" or "is broken." Report at `docs/audits/evidence/alphafactor_cloccs_report.json` (aggregate diagnostics only, no raw FCS content) |
| 2026-08-19 | FEAT-04 (box 3, meet the M8 gate) | ⬜ **assessed, left open** | Read the M8 CLOCCS joint-series adapter spec and its 8-point exit gate (`cell_cycle_modeling_plan.md:1406-1439`) in full. This is new UI feature surface (dropdown entry, series selector, time/replicate/unit metadata input, sidebar joint-series controls, session round-trip persistence, an independent-oracle small-fixture check) — not a doc fix or a one-file change, and P3 priority doesn't justify a half-built partial. Also structurally blocked regardless of implementation effort: the exit gate requires synchronized reference data to pass the *scientific validation gate*, and this dataset has no reference values to validate against — box 1's re-run is diagnostic evidence at best, never a gate-passing validation. Left unchecked with this reasoning recorded rather than attempted |
| 2026-08-20 | FEAT-04 — corrected claim: a reference-bearing CLOCCS dataset does exist and is already wired in | ⚠️ **self-correction, box 1 enriched, box 3 unaffected** | User pointed to `README.md`'s `#li-macalpine--hartemink-cloccs-series-local-only` anchor after I told them (incorrectly, based only on the Orlando et al. 2009 paper and its dead software-download page) that no independently-sourced CLOCCS validation dataset with known-true parameters exists. It does: the Li, MacAlpine & Hartemink 2026 dataset (`github.com/HarteminkLab/cell-cycle-deconv@6d3b06a`, 32 FCS files, 2 replicates) was already documented in `README.md`, already present on disk, already tracked with real published posterior parameters in `external_fcs/manifest.json`, and already consumed by `discover_cloccs_series()`/`execute_cloccs()` in `validation_tests.py` (registered in `main()`, not dead code) — none of this was checked before the earlier answer was given. Ran it this session (`--files cloccs`): `replicate_1` CONVERGED with order-of-magnitude-correct-but-not-tight agreement (S-phase entry 16.9 vs 24.0 min) and a real synchronization wave in the fitted trajectory; `replicate_2` NOT CONVERGED with several parameters off by an order of magnitude. Full numbers moved into `master_checklist.md`'s FEAT-04 box 1 rather than duplicated here. This closes the "no reference dataset" gap in the earlier answer, but does not flip box 3: the result is a genuine 1-of-2 failure against the scientific validation gate, not a pass, so box 3 stays open for the same reason as before plus this new evidence |
| 2026-08-21 | VALID-01 (box 3) — corrected claim: three redistributable, differently-instrumented/encoded datasets already exist and are already wired in | ⚠️ **self-correction, box 3 flipped `[~]` → `[x]`** | User pasted the project's own `README.md` (test-running instructions, the 47-fixture synthetic benchmark, and the "Non-synthetic FCS and published validation data" section) and asked whether any of it could close outstanding checklist gaps. Box 3's text described only `flowjo_async_djf` (single instrument/encoding, local-only, **not** redistributable — no upstream license) and claimed sourcing more was "outside what this session can source or fabricate." That claim was stale: three more datasets were already in `external_fcs/manifest.json` and already run through `discover_external()` in `validation_tests.py` (called unconditionally from `main()`), each with a real, checked SPDX license — Miltenyi PBS fixture (MIT, MACSQuant, FCS3.1, parser-conformance only), Rodighiero et al. 2024 (CC0-1.0 via Dryad, FCS3.0, Kasumi-1/MDA-MB-231 with 2 published-percentage FCS files and 2 negative-control/contaminant files), and Amouzgar et al. 2025 (CC-BY-4.0 via Zenodo, FCS3.0, mass cytometry/CyTOF, diagnostic-only). Verified at the **artifact level** (`dataset["artifacts"]`), not the dataset top level — a top-level dump of `license`/`format` returns empty (`None`/`{}`) for Rodighiero and Amouzgar specifically, which could otherwise look like "no license recorded" and cause the same staleness to recur. Full facts moved into `master_checklist.md`'s VALID-01 box 3 rather than duplicated here. Separately checked and answered (not a checklist edit): none of these three, nor the Li 2026 CLOCCS series, nor the synthetic benchmark, can help QC-CAL-01 (and its QC-03/QC-04/QC-06 dependents) — that item needs datasets labelled with acquisition-time anomalies (clogs, dropouts, timer rollover, backward time jumps) or pulse-geometry doublet/debris ground truth, a different category of "labelled data" than any biological/cell-cycle-truth or parser-conformance dataset provides; that gap remains genuinely open |
| 2026-08-19 | AMBIG-01 (box 1, surface single-peak case as ambiguous) | ✅ **done, ticked** | Read `modeling_state.js:53-63` (`peak_detection_requires_review()`) and its bulk-flow call sites `modeling_ui.js:687,733` — the "Run All" auto-fit flow already withholds auto-acceptance from any `inferred_g2` row. Then read `peak_review_ui.js`'s single-sample panel: `accept_peak_regions()` is called from exactly one place, `on_accept_click()` (line 492-495), wired only to an explicit Accept-button click — the single-sample flow never auto-accepts anything regardless of status. So "requiring review" was already structurally true everywhere; what was missing was that the guess itself was unmarked in words. Fixed with a one-line addition to `status_text()` (`peak_review_ui.js:260-271`): the `inferred_g2` status line now explicitly states the single peak was assumed to be G1 and that it could be G2 instead, telling the reviewer *why* to check rather than just showing a generic "G2/M inferred" label plus raw reason-code strings. Text-only change, no new detection heuristic (box 2's constraint, unaffected). |
| 2026-08-19 | AMBIG-01 (box 1, D9 dependency — contract must refuse or qualify) | ✅ **done** | The UI-text fix above only addressed the review-time surfacing; it left the D9 gap open — reviewing and accepting an `inferred_g2` selection satisfied `model_preflight()`'s pre-existing `REGIONS_UNREVIEWED` block, but nothing downstream (export, table, session, plot) retained any trace that the acceptance was of an ambiguous single-peak guess. Closed the qualify half of D9 (refuse already existed): `model_preflight()` (`result_contract.js`) now returns `peakDetectionStatus` in its bundle; added a new frozen `RESULT_REASON.REGIONS_AMBIGUOUS_SINGLE_PEAK` code; `apply_result_contract()` pushes a non-blocking warning carrying that code whenever `preflight.peakDetectionStatus === "inferred_g2"`. Result stays `validForReporting: true` — qualified, not refused, since a reviewed single-peak sample may be a deliberate G2-arrest. New test: `unit_tests_gate_contract.py`, `'AMBIG-01/D9: an inferred_g2 (single-peak) selection is preflighted through and qualified with a warning, not silently accepted'`, asserting the warning fires for `inferred_g2` and not for `detected`. 861/861 unit tests pass (860 pre-existing + 1 new). D9 (`master_checklist_map.md:289`) is now satisfied |
| 2026-08-19 | GATE-01 (enforcement coverage — enumerate entry points, prove each routes through the contract) | ✅ **done, ticked** | Full static enumeration, not narrative claim. `apply_result_contract()` has exactly one caller (`modeling_state.js:549`, inside `fit_cell_cycle_model()`); `model_preflight()` is read only there and by `qc_review_ui.js` (re-derives the acknowledgement bundle for review, never finalizes); raw `entry.fit()` is only called inside `fit_cell_cycle_model()`'s main-thread fallback and inside `fit_worker.js` (whose normalized-but-uncontracted output is piped straight back into the same `apply_result_contract()` call via `fit_client.js` -> `modeling_state.js:535`, never treated as final where it lands). The five consumer-facing call sites of `fit_cell_cycle_model()` — `modeling_ui.js` (fit-current, run-all, post-review re-fit), `bin_settings_sync.js` (bin-count recompute), `modeling_session.js` (session restore), `render.js` (on-demand plot fit) — are exactly the expected set, no more, no fewer. CLOCCS's `fitScope: "joint_series"` models are refused at the entry point itself (`modeling_state.js:496-499`, throws before preflight) rather than silently bypassing the contract; its own render path (`modeling_ui.js:865-895`) synthesizes an explicit `{ validForReporting: false, converged }` wrapper so its phase-fraction output still routes through the same `format_fraction_cell()`/`render_fraction_value()` helper and carries the same ⚠ marker as a contracted result. `window.PhaseFinder` (`main.js:313-337`), the one documented debug/automation hook, exposes no direct `get_model`/`fit_cell_cycle_model`/`model_preflight`/`apply_result_contract`/`register_default_models` surface; `.pipeline` resolves to `cell_cycle_pipeline.js`'s module namespace, confirmed QC/histogram-export-only by its full export list (no modeling or registry symbols). This narrative proof is now a durable, automatically-enforced static CI suite: `tests/ci/test_gate_entry_points.py`, 7 tests (source-grep pattern precedented by `tests/ci/test_progress_ownership.py`), all passing on first run — a future call site that skips the contract now fails CI instead of shipping an uncontracted result silently. `npm run test:ci`: **41/41** (34 pre-existing + 7 new) |
| 2026-08-20 | DOMAIN-01 (persist provenance + thresholds vs. wire the sensitivity sweep into a real gate) | 🟡 **2 of 4 boxes ticked, 2 correctly left open — same "uncalled library" pattern as `resampling.js`/UNC-01** | Boxes 1-2 (persist domain/bin/underflow/overflow/tail-coverage provenance; define warning/invalid thresholds) are done and reachable in production, not just implemented: `fit_cell_cycle_model()` builds `result.histogramProvenance` on every fit (`modeling_state.js:~549-570`) and calls `domainCoverageAudit()` (`modeling_state.js:18,581`) — the only production caller of that function — which applies `EXCLUDED_OBSERVED_WARNING_FRACTION`/`_INVALID_FRACTION` (0.5%/5%) and `MODELLED_TAIL_WARNING_FRACTION`/`_INVALID_FRACTION` (2%/10%) from `domain_sensitivity.js` and sets `result.validForReporting = false` on an invalid verdict — a real block, verified end-to-end (not mocked) by a pre-existing test file, `tests/unit/driving_code/unit_tests_domain_sensitivity.py` (14 tests, already registered in `run_unit_tests.py` and already part of the passing suite — not authored this session, only now confirmed and cited as the box's evidence), including one that runs an actual `fit_cell_cycle_model()` call and inspects the resulting provenance for exact bin-edge/funnel-conservation/tail-coverage correctness. Boxes 3-4 (the sensitivity sweep; blocking/qualifying on its verdict) are a genuine, documented gap, not an oversight: `analyzeDomainSensitivity()` in the same file is fully implemented (refits across `[64,128,256]` bins × 4 domain trims, computes `maxShiftPercentagePoints`/`modelChoiceStable`, classifies against `FRACTION_SENSITIVITY_WARNING_PP`/`_INVALID_PP`) and is correct by test (6 more cases in the same file: zero-shift stable answer, drift past the invalid threshold, a between-tolerances warn-not-block case, unstable model choice across the grid, genuine re-binning/re-domaining, and a throwing variant recorded rather than dropped) — but `grep -rn "analyzeDomainSensitivity" js/` shows it has no caller anywhere outside its own definition; `modeling_state.js` imports `domainCoverageAudit` alone. Since nothing in the running app ever executes the sweep, nothing can act on its verdict either, so box 4 (which follows directly from box 3 in the checklist's own wording) is equally unmet. This is the identical shape to the UNC-01/`resampling.js` finding logged above (2026-08-19) and the same house rule was applied rather than re-litigated: a correct, tested, but never-invoked module does not tick a box that implies the app uses it. `npm run test:unit`: **861/861** (unchanged — the DOMAIN-01 test file already existed in this count; this entry documents and cites it, adds no new tests) |
| 2026-08-20 | STATE-01 (reviewed-state fidelity on restore; version-drift labelling; reproducibility test coverage) | ✅ **done, all 3 boxes ticked** | Boxes 1-2 were already correctly implemented in production, not net-new: `modeling_session.js:210` restores the exact saved `reviewed` boolean rather than defaulting it true, and `modeling_session.js:236-242` gates the post-restore refit itself on `saved.reviewed === true`, so an unreviewed sample's regions load but are never silently accepted or recomputed into an authoritative result; `modeling_session.js:244-263` compares `saved.model_version` to the live model's current version and stamps `result.reproduction.status` as `recomputed_new` (vs `reproduced`/`unknown_saved_version`) plus a `model_version_drift` warning naming both versions on a mismatch. What was actually missing was end-to-end proof these paths work through the real save/restore UI, not just at the unit level: the e2e suite's Watson Pragmatic re-fit-after-reset step was silently blocking three downstream checks behind a generic 30s timeout (GATE-01's `REGIONS_UNREVIEWED` preflight gate — the test reset peak regions via `#peak_regions_reset_button` without the required follow-up `#peak_regions_accept_button` click, so every fit after it threw before reaching the worker). Root-caused via a diagnostic wrapper capturing `#cell_cycle_fit_status`'s text (`fitStatusText: 'Review and accept the peak regions before fitting.'`), fixed by adding the missing accept-click + reviewed-wait, mirroring the established pattern already used earlier in the same file. That one fix unblocked all three: `"Saved modeling config re-applies (recompute-on-reload) and restores the fit"`, `"STATE-01: restoring an unreviewed saved sample leaves it unreviewed and does not refit"` (`reviewedAfter: False, resultCount: 0`), and `"STATE-01: restoring a version-drifted saved model labels the result recomputed_new, carrying a warning"` (`reproduction.status: 'recomputed_new'`, `warningCodes` includes `model_version_drift`) — all now PASS. Box 3's test coverage was already satisfied by the pre-existing `tests/unit/driving_code/unit_tests_state_reproducibility.py` (group `"Unit / STATE-01 Settings & Reproducibility"`, 11 assertions covering config-hash-changes-with-effective-settings, applied-vs-not-applied settings staying in/out of the hash, unknown-key rejection, no-cache-reuse-on-changed-bytes, and the unreviewed-blocks-fit case) — this session's e2e fix supplies the missing save/restore round-trip evidence that suite couldn't reach on its own. In fixing the e2e blocker, also fixed a genuine production bug found along the way in `on_fit_all_click()`'s bulk-fit Phase 2a (`modeling_ui.js`): non-shared samples whose peak detection required review were never having their regions accepted before being queued to fit, contradicting the function's own "accept every sample's regions" comment and hitting the same `REGIONS_UNREVIEWED` gate — fixed by calling `accept_peak_regions(row)` unconditionally, consistent with AMBIG-01's warning-not-refusal design (a low-confidence detection still surfaces via `REGIONS_AMBIGUOUS_SINGLE_PEAK` on the result, it doesn't get silently skipped). `npm run test:unit`: 861/861 unchanged (no unit tests added); e2e: the 3 previously-blocked STATE-01/recompute checks now pass. |
| 2026-08-20 | SCI-03 (nonconvergence surfaced honestly; stricter-criteria benchmark) | 🟡 **1 of 2 boxes ticked** | Box 1 ("show nonconvergence prominently... disable authoritative phase reporting unless explicitly reviewed") is closed by UI-01, which explicitly names itself as closing it (`master_checklist.md:906`) — ticked here per that cross-reference. Noted honestly rather than glossed over: the box's "disable authoritative reporting" clause is superseded by a later, deliberate design choice — `apply_result_contract()` (`result_contract.js:503-513`) always surfaces the computed fractions with a warning rather than withholding them on nonconvergence (documented FlowJo-style rationale in its own comment), so nonconvergence is shown prominently but not used to suppress the number. Box 2 (benchmark stricter convergence criteria against known-good fits) is left open on purpose, not from lack of trying: `js/analysis/math/lm_solver.js:11`'s `tolerance: 1e-7` is the only convergence-tolerance constant in the codebase and no "stricter" candidate value or alternate criterion is proposed anywhere in the repo or docs to benchmark against. Confirmed real reference data exists locally for this (`tests/validation/validation_test_data/external_fcs/` — 38 real FCS files, including the 30-sample FlowJo/FlowReader `flowjo_async_djf` set), so this is unlike QC-CAL-01's total-absence gate; what's missing is someone defining what "stricter" means and what false-nonconvergence rate is acceptable, which is a product/scientific judgment call this item doesn't make on its own. |

| 2026-08-20 | SCI-05 (one canonical phase-fraction result everywhere; D7) | ✅ **done, both boxes ticked** | D7's instruction was "write the cross-surface test, then fix whichever surface disagrees" — traced the architecture first rather than guessing: table/sidebar/TSV all call `format_fraction_cell()` (`cell_cycle_columns.js:109-113`) off `active_result()` (`get_active_model_result(get_state(name))`, the strict `validForReporting===true` gate); the plot's SVG `<desc>`/"analysis summary" text is built separately by `analysis_text()` (`render.js:129-138`, necessarily independent since an SVG description can't carry a CSS class or a table cell's `⚠` styling) but is fed via `pipeline_fit_for_series()` → `get_active_model_result()` (`render.js:427-437`) — the *same* gate function, not a parallel one. Confirmed by grep that every current model (`dean_jett.js`, `dean_jett_fox.js`, `watson_classic.js`, `watson_pragmatic.js`) always emits a complete `phaseFractions` object (real ratios or an explicit all-zero fallback), so `build_fit_series_entry()`'s per-key moments-based fallback (`render.js:376-383`) is unreachable for anything that clears the shared gate — meaning the "fix whichever surface disagrees" branch of D7 was never triggered because nothing disagreed. Wrote the cross-surface test to prove this rather than trust the comments: `tests/unit/driving_code/unit_tests_sci05_cross_surface.py` (registered in `run_unit_tests.py`), 4 checks — clean converged fit shows byte-identical percentages table vs. plot; nonconverged-but-reportable fit shows the same numbers *and* the same `⚠`/`(fit did not converge)` caveat on both; a cancelled/unreportable fit is refused by the identical gate on both surfaces (neither ever shows a number the other withholds); a `JSON.parse(JSON.stringify(...))` round-trip (stand-in for the session save/restore boundary) reproduces byte-identical output on both surfaces before and after — closing box 2. Required one harness change to expose `cell_cycle_columns.js` to the browser test environment (`tests/unit/test_harness.html`, it wasn't previously imported there). `npm run test:unit`: **865/865** (861 pre-existing + 4 new), all passing. |

| 2026-08-20 | e2e regression: check 154 "Fit All Samples writes each fitted sample's fractions into its own table row" | ✅ **fixed — test-assertion bug, not a production bug** | Investigated a `filledAfterManualCall: 0` mystery surfaced while debugging the earlier `window.PhaseFinder.get_file_table` namespace fix (which itself had been masking this check under a generic outer-`try/except` failure). Ruled out, in order, with a diagnostic added to `tests_modeling.py`'s probe each time: (1) the bulk-fitted sample being unplotted/deselected at check time — `plottableNames`/`selectedNames` both included it; (2) `active_result()`/`get_active_model_result()` refusing the result — added a direct call to the same gate (`pipeline_state.js`) and got `gatedReportable: true`, `contractVersion: 1`; (3) actually reading the DOM cell text directly (`rawCellTexts`) — the cell **was** correctly populated (`"7.1% ⚠"`, `"91.7% ⚠"`, `"1.2% ⚠"`), just with the `⚠` trust-caveat suffix `format_fraction_cell()`/`fraction_trust_reason()` append for a reportable-but-nonconverged fit (UI-01/SCI-05's own by-design behavior — show the number, flag it, don't withhold it). The test's own selector, `td.textContent.trim().endsWith('%')`, doesn't match `"...% ⚠"`, so it silently miscounted a correctly-rendered warned cell as unfilled. Fixed by changing the check (both the primary `wait_for_function` and the diagnostic fallback) from `.endsWith('%')` to `.includes('%')`, which matches both the plain and `⚠`-suffixed forms without weakening the check (a blank cell is still `"—"`, never containing `%`). Confirmed via e2e re-run: check 154 now `PASS` (`{'filled': 1}`), and the fix reduced the suite from 9 to 8 failures — the remaining 8 (checks 4, 11, 21, 22, 23, 24, 50, 219) are the pre-existing, unrelated failures already on record and still un-investigated. |

| 2026-08-21 | QC-CAL-01 (box 1, assemble labelled acquisitions) — synthetic corpus built, box left `[~]` not `[x]` | 🟡 **partial, deliberately not claimed as done** | This item's own note above says "do not fake it... determine honestly whether synthetic injected disturbances can calibrate anything." Confirmed first, not assumed: re-checked every dataset already wired into the test suites (Li 2026 CLOCCS series, Miltenyi/Rodighiero/Amouzgar external sets, the 47-fixture synthetic benchmark) — none carry acquisition-time-anomaly or pulse-geometry doublet/debris ground truth, so the "real labelled acquisitions" gap this item names is still genuinely empty, exactly as VALID-01's 2026-08-21 entry above already concluded. Built the honest substitute: `tests/validation/validation_test_data/synthetic_fcs/generate_qc_calibration_fixtures.py` generates 7 reproducible (`--check`-verified, SHA-256-seeded) synthetic FCS fixtures — stable, clog, dropout, timer rollover, backward time jump, doublet-heavy, debris-dominant — each with injected, exactly-known ground truth in `qc_calibration/manifest.json`, whose own disclaimer states plainly these are synthetic, not real acquisitions. `verify_qc_calibration_fixtures.mjs` runs them through the REAL production detectors (`runTimeQC`, `gateByPulseGeometry`, `gateMainBiologicalCloud` — not reimplementations, via a recursive `data:` URL import shim that sidesteps the `package.json` CommonJS/ESM mismatch that otherwise breaks named exports on real `file://` imports): all 7 pass. Two real (not fixture-tuning) findings came out of this: (1) `gateByPulseGeometry`'s recall stays ~1.0 up to ~8-10% doublets then degrades progressively (0.62 at 10%, 0.55 at 12%, 0.49 at 15%, ~0.09-0.12 by 35%) — consistent with `fitRobustRidge2D`'s own documented minority-population assumption, and only visible once an unrealistic flat-Width singlet-pulse modeling artifact was found and fixed (it was flipping the gate's channel-selection heuristic to a worse-discriminating channel); (2) `gateMainBiologicalCloud`'s `selectionScore = quality.weight + 1e-6*mean[0]` (`scatter_gmm_gate.js`) picks the numerically-largest 2-GMM component as "main" with scatter position only a negligible tie-break, so past 50% debris it inverts and selects the debris cluster as "main," rejecting live cells instead — confirmed by source inspection, not treated as a fixture bug, and locked in with a regression assertion (`recall < 0.5`, `falsePositiveRate > 0.5`) so a future change to that selection rule shows up here. Both findings are documented in the fixtures' own `expected_behavior` text. What this does NOT close: real-instrument acquisition data (the literal ask) and the acceptable-rate policy call (QC-CAL-01 box 2) are both still open and are both things only the user can supply — see `master_checklist.md`'s QC-CAL-01/QC-03/QC-06 boxes for the precise per-box partial-credit breakdown. `node verify_qc_calibration_fixtures.mjs`: **PASS, all 7 fixtures** |

MODEL-08 and MODEL-09 are ticked in the register with evidence pointers, as are the items in the rows below them.

**Two traps found while writing these tests, recorded so the next session doesn't re-hit them:**

1. `plot_bin_count()` takes **no arguments** — it reads `#plot_bins` from the DOM, which does
   not exist in the unit harness, so it always returns `DEFAULT_BINS` there. An initial draft
   of the MODEL-09 fallback test asserted against `plot_bin_count(index)`: it would have passed
   vacuously, and the round-trip test would have failed outright. `slider_index_for_bins(bins)`
   is the DOM-independent entry point and is what the suite uses.
2. `slider_index_for_bins(null)` does **not** take the fallback branch — `Number(null)` is `0`,
   which is finite, so it legitimately snaps to the nearest stop (128). Only genuinely
   non-finite inputs (`NaN`, `undefined`, `Infinity`, non-numeric strings) hit the default.

**One behaviour change to know about before touching QC:** a bare-truthy `qcAcknowledgements[stage]`
used to open the critical-removal gate. It no longer does — an acknowledgement must carry the key of
the outcome it acknowledged. `unit_tests_djf_edges.py:533` asserted the old behaviour and was updated
to assert the new one; if any other caller ever writes `{ stage: true }`, it will now fail closed,
which is the intended direction.

**A trap in the QC matrix work:** `combine_masks()` throws on a mask length mismatch.
`final_mask_provenance()` catches it and reports `verified: false` instead of propagating — a batch
report that aborts on one malformed sample tells the user nothing about the rest of the batch.

**A trap in MODEL-05, and the reason it took two attempts:** anything derived from the peak-region
*edges* leaks region width into the fit. `unit_tests_cell_cycle_dean_jett_fox.py:269,282` guard this
and they are the tests that caught it. Before adding any region-edge-derived quantity to
`peak_regions.js`, check it against those two — the failure is silent on clean synthetic data with
generous regions and only appears when the box is drawn tight. Peak-relative distances (n×σ) are safe;
region-relative ones are not. Note `edgeBaseline`, used for `height`/`area`, is *already* region-edge
derived and pre-dates this — it was left alone rather than widened into scope.
