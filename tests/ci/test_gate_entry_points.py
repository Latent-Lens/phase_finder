"""GATE-01: every UI, worker, session-restore, debug API, and direct model
entry point must route a per-sample fit through the same
model_preflight()/apply_result_contract() pair. fit_cell_cycle_model()
(modeling_state.js) is meant to be the ONLY place that finalizes a result --
these tests statically enumerate every place that could bypass it and prove
none do, so a future call site that skips the contract fails CI instead of
silently shipping an uncontracted result."""

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
JS = ROOT / "js"

# The only file allowed to call apply_result_contract()/model_preflight() to
# produce a result treated as finished. qc_review_ui.js also calls
# model_preflight() (QC-01: it re-derives the acknowledgement bundle for
# review), which is a read of the preflight halfway point, not a second
# finalizer -- it never calls apply_result_contract().
FIT_FINALIZER = "js/analysis/cell_cycle/modeling_state.js"
PREFLIGHT_READERS = {FIT_FINALIZER, "js/analysis/cell_cycle/qc_review_ui.js"}

# Raw entry.fit()/get_model(id).fit() is only legitimate inside the finalizer
# (main-thread fallback) and the fit worker (fit_client.js's pool runs this
# off-thread, but the worker's output is piped straight back into the SAME
# apply_result_contract() call in modeling_state.js -- never treated as final
# where it lands).
RAW_FIT_CALLERS = {FIT_FINALIZER, "js/analysis/cell_cycle/fit_worker.js"}

# The five consumer-facing places that must reach a fit through
# fit_cell_cycle_model() -- the UI (fit-current, bulk run-all, and a
# post-review/setting-change re-fit), the bin-count-change auto-recompute,
# session restore, and the ridge-review region-commit re-fit (AUDIT-008 split
# ridge_review.js out of render.js; this call site moved with it).
EXPECTED_FIT_CALL_SITES = {
    "js/analysis/cell_cycle/modeling_ui.js",
    "js/analysis/cell_cycle/bin_settings_sync.js",
    "js/session/modeling_session.js",
    "js/plotting/ridge_review.js",
}

# window.PhaseFinder is the one documented debug/automation/test hook
# (js/main.js). None of its surfaces may expose a way to fit or contract a
# result outside fit_cell_cycle_model().
DEBUG_HOOK_FILE = "js/main.js"
FORBIDDEN_DEBUG_HOOK_NAMES = (
    "get_model", "fit_cell_cycle_model", "model_preflight",
    "apply_result_contract", "register_default_models",
)


def _read(relative):
    return (ROOT / relative).read_text(encoding="utf-8")


def _call_sites(text, function_name):
    """Line numbers where function_name(...) is actually invoked (not just
    named in a comment or string)."""
    sites = []
    for number, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if stripped.startswith("//") or stripped.startswith("*"):
            continue
        if re.search(rf"\b{re.escape(function_name)}\s*\(", line):
            sites.append(number)
    return sites


class GateEntryPointTests(unittest.TestCase):
    def test_apply_result_contract_has_exactly_one_caller(self):
        callers = set()
        for path in JS.rglob("*.js"):
            relative = path.relative_to(ROOT).as_posix()
            if relative == "js/analysis/cell_cycle/result_contract.js":
                continue  # the definition itself
            if _call_sites(_read(relative), "apply_result_contract"):
                callers.add(relative)
        self.assertEqual(
            {FIT_FINALIZER}, callers,
            "apply_result_contract() must be called from exactly "
            f"{FIT_FINALIZER}; found callers: {sorted(callers)}",
        )

    def test_model_preflight_is_only_read_by_the_finalizer_and_the_qc_review_panel(self):
        callers = set()
        for path in JS.rglob("*.js"):
            relative = path.relative_to(ROOT).as_posix()
            if relative == "js/analysis/cell_cycle/result_contract.js":
                continue
            if _call_sites(_read(relative), "model_preflight"):
                callers.add(relative)
        self.assertEqual(
            PREFLIGHT_READERS, callers,
            f"model_preflight() callers changed: {sorted(callers)}. "
            "If this is a new legitimate reader, add it to PREFLIGHT_READERS "
            "after confirming it never treats the bundle as a finished, "
            "reportable result.",
        )

    def test_raw_entry_fit_is_only_called_inside_the_finalizer_and_the_worker(self):
        callers = set()
        for path in JS.rglob("*.js"):
            relative = path.relative_to(ROOT).as_posix()
            text = _read(relative)
            for number, line in enumerate(text.splitlines(), 1):
                stripped = line.strip()
                if stripped.startswith("//") or stripped.startswith("*"):
                    continue
                if re.search(r"\bentry\.fit\s*\(", line):
                    callers.add(relative)
        self.assertEqual(
            RAW_FIT_CALLERS, callers,
            f"entry.fit() callers changed: {sorted(callers)}. A new caller "
            "would run a model without ever routing its output through "
            "apply_result_contract().",
        )

    def test_every_ui_worker_session_restore_and_render_fit_call_goes_through_fit_cell_cycle_model(self):
        found = set()
        for path in JS.rglob("*.js"):
            relative = path.relative_to(ROOT).as_posix()
            if relative == FIT_FINALIZER:
                continue  # the definition
            if _call_sites(_read(relative), "fit_cell_cycle_model"):
                found.add(relative)
        missing = EXPECTED_FIT_CALL_SITES - found
        unexpected = found - EXPECTED_FIT_CALL_SITES
        self.assertEqual(set(), missing, f"expected fit_cell_cycle_model() callers went missing: {sorted(missing)}")
        self.assertEqual(
            set(), unexpected,
            f"new fit_cell_cycle_model() caller(s) found: {sorted(unexpected)}. "
            "If legitimate, add to EXPECTED_FIT_CALL_SITES; if it should instead "
            "route through an existing caller, fix the call site.",
        )

    def test_cloccs_joint_series_fits_are_refused_by_the_single_entry_point(self):
        # CLOCCS is the one direct-model entry point that never reaches
        # apply_result_contract() -- fit_cell_cycle_model() must refuse to
        # run any fitScope: "joint_series" model itself, so that refusal
        # (not a silent bypass) is what a caller gets if it ever tries.
        text = _read(FIT_FINALIZER)
        self.assertIn('entry.fitScope === "joint_series"', text)
        self.assertRegex(text, r'entry\.fitScope === "joint_series"[\s\S]{0,400}throw new Error')

    def test_debug_hook_exposes_no_direct_fit_or_contract_bypass(self):
        text = _read(DEBUG_HOOK_FILE)
        start = text.index("window.PhaseFinder = {")
        end = text.index("\n};", start)
        hook_body = text[start:end]
        leaks = [name for name in FORBIDDEN_DEBUG_HOOK_NAMES if re.search(rf"\b{name}\b", hook_body)]
        self.assertEqual(
            [], leaks,
            f"window.PhaseFinder exposes {leaks} -- a debug-console caller "
            "could fit or contract a result outside fit_cell_cycle_model().",
        )

    def test_pipeline_debug_hook_module_exports_no_modeling_or_registry_symbols(self):
        # window.PhaseFinder.pipeline is cell_cycle_pipeline.js's whole
        # module namespace (js/main.js: `get djf() { return get_pipeline(); }`).
        # It must stay QC/histogram-only -- no re-export of the model
        # registry or the fit entry point.
        text = _read("js/analysis/pipeline/cell_cycle_pipeline.js")
        export_block_starts = [m.start() for m in re.finditer(r"^export\s", text, re.MULTILINE)]
        exported_names = set()
        for match in re.finditer(r"^export\s*\{([^}]+)\}", text, re.MULTILINE):
            for name in match.group(1).split(","):
                name = name.strip().split(" as ")[-1].strip()
                if name:
                    exported_names.add(name)
        for match in re.finditer(r"^export\s+(?:async\s+)?function\s+(\w+)", text, re.MULTILINE):
            exported_names.add(match.group(1))
        for match in re.finditer(r"^export\s+const\s+(\w+)", text, re.MULTILINE):
            exported_names.add(match.group(1))
        forbidden = {"get_model", "fit_cell_cycle_model", "apply_result_contract", "model_preflight"}
        leaks = exported_names & forbidden
        self.assertEqual([], sorted(leaks), f"cell_cycle_pipeline.js re-exports {leaks}")
        self.assertTrue(export_block_starts, "sanity: the module should export something")


if __name__ == "__main__":
    unittest.main()
