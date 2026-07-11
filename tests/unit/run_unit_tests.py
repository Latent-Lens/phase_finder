#!/usr/bin/env python3
"""Unit test orchestrator.

Called from drive_flow.py after the e2e phase. Navigates a separate Playwright
page to the test harness, waits for the ES modules, then runs all unit test
modules and records results into the provided TestContext.
"""

import sys
from pathlib import Path

# Ensure helpers (in tests/e2e/) and unit test modules are importable
_E2E = Path(__file__).resolve().parent.parent / "e2e"
_UNIT = Path(__file__).resolve().parent
for _p in (_E2E, _UNIT):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

from helpers import TestContext

HARNESS_PATH = "/tests/unit/test_harness.html"
LIBS_READY_TIMEOUT = 60000  # ms to wait for harness ES modules


def run_unit_tests(ctx: TestContext, app_url: str):
    """Navigate ctx.page to the test harness and run all unit test suites."""
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
            "   && window.PhaseFinder.pipeline.stage8)",
            timeout=LIBS_READY_TIMEOUT,
        )
    except Exception as err:
        detail = " | ".join([str(err), *load_diagnostics])
        ctx.warn("Unit / Setup", "Core JS modules did not load", detail, screenshot=False)
        return

    from unit_tests_parser import run_parser_tests
    run_parser_tests(ctx)

    from unit_tests_table import run_table_tests
    run_table_tests(ctx)

    from unit_tests_io import run_io_tests
    run_io_tests(ctx)

    from unit_tests_session import run_session_tests
    run_session_tests(ctx)

    from unit_tests_djf_pipeline import run_djf_pipeline_tests
    run_djf_pipeline_tests(ctx)
