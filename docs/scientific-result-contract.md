# Scientific result contract

A fitted curve is not, by itself, an authoritative scientific result. Every
per-sample fit routed through `fit_cell_cycle_model()` receives the following
independent fields from `result_contract.js`:

- `computed`: numerical work completed rather than being cancelled.
- `optimizerConverged`: `true`/`false` for optimized models and `null` when no
  optimizer exists (Watson's closed-form decomposition).
- `scientificallyValid`: expected counts and phase fractions are finite and
  coherent, and an optimizer (when present) converged.
- `validForReporting`: both the input preflight and output validation passed.
- `cancelled`: the caller cancelled the operation.
- `invalid`: the logical inverse of an acceptable input/result combination.
- `validityReasons`: structured `{code, message, detail}` evidence.

Only a result with `validForReporting === true` may become
`modeling.activeResultKey`. Failed and nonconverged results remain in
`resultsByKey` under `lastDiagnosticResultKey` for diagnosis, but the canonical
result accessor refuses them. Plot overlays, table summaries, and derived
phase-fraction columns use that accessor.

The result key includes the model/version, canonical applied configuration,
DNA-content digest, row and channel identity, all QC masks, histogram
edges/counts, peak-region revision/review state, and fit domain. Changing a
stored model setting deactivates the current result immediately; the exact
configuration sent to the model is retained as `appliedConfiguration`.

## Input preflight and QC provenance

The shared preflight binds a fit to the histogram fingerprint and peak-region
revision, requires reviewed/non-stale regions and eligible finite DNA data,
checks retained event sufficiency, and records structural, time, scatter, and
singlet QC as one of `not_run`, `unavailable`, `failed`, `waived`, or `passed`.
A waiver must be supplied explicitly and is retained verbatim in the result's
preflight provenance; it never turns a failed QC outcome into a pass.

Model configuration must be an object. Model-specific constraint validation
continues to be performed by each registered model before numerical fitting;
moving those validators behind the common preflight is still outstanding.

## Session and API behavior

UI fits, bulk fits, bin-change refits, ridge edits, and session restoration all
call `fit_cell_cycle_model()`, so they share the same checks. Calling a model
module's low-level `fit()` function directly produces a raw diagnostic object,
not an authoritative result, and cannot populate application state.
