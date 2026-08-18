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

## G2:G1 mean ratio — do not tune toward the FlowJo reference (MODEL-01)

`g2_mean` sits below the 30-sample FlowJo reference on every sample (median
−3.2%). Decomposing the error shows it is **two independent components**, and
only one of them is a defect in this codebase:

```
reference g2:g1 ratio   median 2.0088   (quartiles 1.9941 .. 2.0296)
our fitted ratio        median 1.974            -> ratio deficit  -1.73%
observed g2_mean error  -3.2%
        g1_mean error   -1.5%
        ratio error     -1.73%
              sum       -3.23%    <- matches observed
```

The ratio component (our 1.974 vs. reference ~2.0088) is **not treated as
error and must not be tuned away**. Chromatin condenses during G2/M, which
restricts intercalating-dye accessibility, so G2/M DNA content genuinely
fluoresces at slightly less than twice the G1 signal — a documented,
biologically real cause of a true peak ratio below 2.0 (Darzynkiewicz et al.,
<https://pmc.ncbi.nlm.nih.gov/articles/PMC2967208/>). Our free (unconstrained)
fit lands almost exactly where that mechanism predicts. FlowJo's reference
values cluster tightly around 2.0 (not hard-locked: the observed range is
1.94-2.29) because FlowJo's cell-cycle platform supports *constraining* the
mean-peak ratio during fitting
(<https://docs.flowjo.com/flowjo/experiment-based-platforms/cell-cycle-univariate/>)
and every stored reference mean is an integer, adding its own quantization
(~0.29% on G1).

In other words: the reference values look like they came from a
ratio-constrained fit against integer-rounded peak channels, and our
unconstrained fit reproduces the underlying biology instead of that
convention. Pulling `g2_mean` toward the reference would trade a correct,
mechanistically-grounded free fit for agreement with a different, more
constrained fitting convention — it would not make the estimate more
accurate. **If a future maintainer sees this as a fit-quality gap, the fix
is not to bias `g2_mean` toward 2x G1.** The clearly-ours remainder of the
G2 error is the separate G1 offset tracked as MODEL-02 (a −1.5% G1 bias
that propagates unchanged into `g2_mean`); that is the component worth
diagnosing and fixing. See `docs/audits/master_checklist.md` (MODEL-01,
MODEL-02) for the live investigation and status.
