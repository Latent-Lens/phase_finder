#!/usr/bin/env python3
"""Unit test orchestrator.

Called from drive_flow.py after the e2e phase. Navigates a separate Playwright
page to the test harness, waits for third-party libraries, then runs all unit test
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
LIBS_READY_TIMEOUT = 60000  # ms to wait for third-party libraries


def run_unit_tests(ctx: TestContext, app_url: str):
    """Navigate ctx.page to the test harness and run all unit test suites."""
    page = ctx.page

    # Derive harness URL from the app URL (same host:port, different path)
    from urllib.parse import urlparse, urlunparse
    parsed = urlparse(app_url)
    harness_url = urlunparse(parsed._replace(path=HARNESS_PATH, query="", fragment=""))

    page.goto(harness_url)
    page.wait_for_load_state("domcontentloaded")

    # Wait for static JS files (FCSParser, PhaseFinderFrame, PhaseFinderDJF) — always fast
    try:
        page.wait_for_function(
            "() => typeof window.FCSParser !== 'undefined' "
            "   && typeof PhaseFinderFrame !== 'undefined' "
            "   && typeof window.PhaseFinderDJF !== 'undefined'",
            timeout=15000,
        )
    except Exception as err:
        ctx.warn("Unit / Setup", "Core JS files did not load", str(err), screenshot=False)
        return

    from unit_tests_parser import run_parser_tests
    run_parser_tests(ctx)

    from unit_tests_table import run_table_tests
    run_table_tests(ctx)

    # Wait for Vite module imports (levenbergMarquardt, gsd).
    try:
        page.wait_for_function(
            "() => typeof window.levenbergMarquardt === 'function' "
            "   && typeof window.gsd === 'function'"
            "   || !!window.__libsError",
            timeout=LIBS_READY_TIMEOUT,
        )
    except Exception as err:
        ctx.warn("Unit / Setup", "Third-party libraries did not load in time",
                 f"levenbergMarquardt/gsd unavailable — DJF unit tests skipped: {err!s:.120}",
                 screenshot=False)
        return

    libs_err = page.evaluate("() => window.__libsError || null")
    if libs_err:
        ctx.warn("Unit / Setup", "Third-party library import failed",
                 f"{libs_err!s:.200} — DJF unit tests skipped", screenshot=False)
        return

    from unit_tests_djf import run_djf_tests
    run_djf_tests(ctx)
