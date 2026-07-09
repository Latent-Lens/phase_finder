#!/usr/bin/env python3
"""Unit test orchestrator.

Called from drive_flow.py after the e2e phase. Navigates a separate Playwright
page to the test harness, waits for CDN libraries, then runs all unit test
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
LIBS_READY_TIMEOUT = 60000  # ms to wait for CDN libraries


def run_unit_tests(ctx: TestContext, app_url: str):
    """Navigate ctx.page to the test harness and run all unit test suites."""
    page = ctx.page

    # Derive harness URL from the app URL (same host:port, different path)
    from urllib.parse import urlparse, urlunparse
    parsed = urlparse(app_url)
    harness_url = urlunparse(parsed._replace(path=HARNESS_PATH, query="", fragment=""))

    page.goto(harness_url)
    page.wait_for_load_state("domcontentloaded")

    # The harness module imports the app's ES modules (parser, metadata frame,
    # DJF, etc.) and its vendored ml-* stack, then exposes them on window. Waiting
    # for that assignment covers every unit suite, including DJF.
    try:
        page.wait_for_function(
            "() => !!(window.FCSParser && window.PhaseFinderFrame "
            "   && window.PhaseFinder && window.PhaseFinder.djf)",
            timeout=15000,
        )
    except Exception as err:
        ctx.warn("Unit / Setup", "Core JS modules did not load", str(err), screenshot=False)
        return

    from unit_tests_parser import run_parser_tests
    run_parser_tests(ctx)

    from unit_tests_table import run_table_tests
    run_table_tests(ctx)

    from unit_tests_io import run_io_tests
    run_io_tests(ctx)

    from unit_tests_session import run_session_tests
    run_session_tests(ctx)

    from unit_tests_djf import run_djf_tests
    run_djf_tests(ctx)
