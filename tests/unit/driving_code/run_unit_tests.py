#!/usr/bin/env python3
"""Unit test orchestrator.

Called from drive_flow.py after the e2e phase. Navigates a separate Playwright
page to the test harness, waits for the ES modules, then runs all unit test
modules and records results into the provided TestContext.
"""

import sys
from pathlib import Path

# Ensure E2E helpers and unit test modules are importable.
_E2E = Path(__file__).resolve().parents[2] / "e2e" / "driving_code"
_UNIT = Path(__file__).resolve().parent
for _p in (_E2E, _UNIT):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

from helpers import TestContext
from unit_phase import require_unit_result_count, unit_phase_failure

HARNESS_PATH = "/tests/unit/test_harness.html"
LIBS_READY_TIMEOUT = 60000  # ms to wait for harness ES modules


def setup_unit_harness(ctx: TestContext, app_url: str):
    """Navigate to the harness and wait until its modules are ready."""
    page = ctx.page
    load_diagnostics = []

    page.on("pageerror", lambda error: load_diagnostics.append(
        f"page error: {error}"
    ))
    page.on("console", lambda message: load_diagnostics.append(
        f"console {message.type}: {message.text}"
    ) if message.type == "error" else None)
    page.on("requestfailed", lambda request: load_diagnostics.append(
        f"request failed: {request.url}: {request.failure}"
    ))
    page.on("response", lambda response: load_diagnostics.append(
        f"HTTP {response.status}: {response.url}"
    ) if response.status >= 400 else None)

    # Derive harness URL from the app URL (same host:port, different path)
    from urllib.parse import urlparse, urlunparse
    parsed = urlparse(app_url)
    harness_url = urlunparse(parsed._replace(path=HARNESS_PATH, query="", fragment=""))

    page.goto(harness_url)
    page.wait_for_load_state("domcontentloaded")

    # The harness imports the app's ES modules and exposes them on window.
    # Waiting for that assignment covers every suite, including all DJF stages.
    try:
        page.wait_for_function(
            "() => !!(window.FCSParser && window.PhaseFinderFrame "
            "   && window.PhaseFinder && window.PhaseFinder.pipeline "
            "   && window.PhaseFinder.pipeline.fitReport)",
            timeout=LIBS_READY_TIMEOUT,
        )
    except Exception as err:
        detail = " | ".join([str(err), *load_diagnostics])
        raise unit_phase_failure("unit_setup", RuntimeError(detail)) from err


def execute_unit_tests(ctx: TestContext):
    """Run every browser-hosted unit suite and enforce the result floor."""
    before = len(ctx.results)

    from unit_tests_parser import run_parser_tests
    run_parser_tests(ctx)

    from unit_tests_table import run_table_tests
    run_table_tests(ctx)

    from unit_tests_summary_stats import run_summary_stats_tests
    run_summary_stats_tests(ctx)

    from unit_tests_scatter_preview import run_scatter_preview_tests
    run_scatter_preview_tests(ctx)

    from unit_tests_io import run_io_tests
    run_io_tests(ctx)

    from unit_tests_session import run_session_tests
    run_session_tests(ctx)

    from unit_tests_djf_pipeline import run_djf_pipeline_tests
    run_djf_pipeline_tests(ctx)

    from unit_tests_djf_shared import run_djf_shared_tests
    run_djf_shared_tests(ctx)

    from unit_tests_djf_edges import run_djf_edge_tests
    run_djf_edge_tests(ctx)

    from unit_tests_cell_cycle_registry import run_cell_cycle_registry_tests
    run_cell_cycle_registry_tests(ctx)

    from unit_tests_cell_cycle_worker import run_cell_cycle_worker_tests
    run_cell_cycle_worker_tests(ctx)

    from unit_tests_cell_cycle_peak_detection import run_cell_cycle_peak_detection_tests
    run_cell_cycle_peak_detection_tests(ctx)

    from unit_tests_cell_cycle_modeling_state import run_cell_cycle_modeling_state_tests
    run_cell_cycle_modeling_state_tests(ctx)

    from unit_tests_cell_cycle_math import run_cell_cycle_math_tests
    run_cell_cycle_math_tests(ctx)

    from unit_tests_cell_cycle_model_shared import run_cell_cycle_model_shared_tests
    run_cell_cycle_model_shared_tests(ctx)

    from unit_tests_cell_cycle_dean_jett import run_cell_cycle_dean_jett_tests
    run_cell_cycle_dean_jett_tests(ctx)

    from unit_tests_cell_cycle_dean_jett_fox import run_cell_cycle_dean_jett_fox_tests
    run_cell_cycle_dean_jett_fox_tests(ctx)

    from unit_tests_cell_cycle_watson_pragmatic import run_cell_cycle_watson_pragmatic_tests
    run_cell_cycle_watson_pragmatic_tests(ctx)

    from unit_tests_cell_cycle_watson_classic import run_cell_cycle_watson_classic_tests
    run_cell_cycle_watson_classic_tests(ctx)

    from unit_tests_cell_cycle_fit_orchestration import run_cell_cycle_fit_orchestration_tests
    run_cell_cycle_fit_orchestration_tests(ctx)

    from unit_tests_stat_constraints import run_stat_constraint_tests
    run_stat_constraint_tests(ctx)

    from unit_tests_legacy_quarantine import run_legacy_quarantine_tests
    run_legacy_quarantine_tests(ctx)

    from unit_tests_gate_contract import run_gate_contract_tests
    run_gate_contract_tests(ctx)

    from unit_tests_domain_sensitivity import run_domain_sensitivity_tests
    run_domain_sensitivity_tests(ctx)

    from unit_tests_state_reproducibility import run_state_reproducibility_tests
    run_state_reproducibility_tests(ctx)

    from unit_tests_peak_focus_range import run_peak_focus_range_tests
    run_peak_focus_range_tests(ctx)

    from unit_tests_time_qc_peak_tracking import run_time_qc_peak_tracking_tests
    run_time_qc_peak_tracking_tests(ctx)

    from unit_tests_time_qc_diagnostic_plot import run_time_qc_diagnostic_plot_tests
    run_time_qc_diagnostic_plot_tests(ctx)

    from unit_tests_cloccs import run_cloccs_tests
    run_cloccs_tests(ctx)

    return require_unit_result_count(len(ctx.results) - before)


def run_unit_tests(ctx: TestContext, app_url: str):
    """Compatibility entry point used by standalone callers."""
    setup_unit_harness(ctx, app_url)
    return execute_unit_tests(ctx)
