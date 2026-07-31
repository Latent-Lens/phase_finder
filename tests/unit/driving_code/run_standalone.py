#!/usr/bin/env python3
"""Standalone JavaScript unit test runner.

Runs only tests/unit/test_harness.html's unit suites against a headless
Chromium page -- independent of the full e2e regression driver
(tests/e2e/driving_code/drive_flow.py). Use this when you want a fast correctness check on
the numeric/state modules without waiting on (or being blocked by) the full
browser-driven e2e flow, or when an e2e failure/hang would otherwise prevent
the unit suites from running at all.

Usage:
  /tmp/flowvenv/bin/python tests/unit/driving_code/run_standalone.py [--url URL] [--headed]

By default it clears older report output first; pass --keep to retain it.
"""

import argparse
import os
import sys
import time
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_TESTS_ROOT = _HERE.parents[1]
_E2E = _TESTS_ROOT / "e2e" / "driving_code"
for _p in (_HERE, _E2E):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError, sync_playwright

from helpers import TestContext, prepare_results_dir, results_asset_dirs, write_combined_report
from run_unit_tests import run_unit_tests
from test_server import start_test_server
from run_artifacts import publish_latest

RESULTS_DIR = _TESTS_ROOT / "e2e" / "results"


def run(args) -> int:
    run_id = f"{time.strftime('%Y%m%d-%H%M%S')}-{os.getpid()}"
    results_dir = RESULTS_DIR / run_id
    if args.keep:
        for asset_dir in results_asset_dirs(results_dir):
            asset_dir.mkdir(parents=True, exist_ok=True)
    else:
        prepare_results_dir(results_dir)

    stamp = time.strftime("%Y%m%d-%H%M%S")
    report_stem = f"unit_only_{stamp}"

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed)
        page = browser.new_page()
        # Doubles as the (empty) e2e context write_combined_report expects --
        # no e2e phase runs here, so its summary section is simply empty.
        e2e_ctx = TestContext(page=page, results_dir=results_dir, report_stem=report_stem,
                              all_media=not args.limited_media)
        unit_ctx = TestContext(page=page, results_dir=results_dir, report_stem=report_stem,
                               all_media=not args.limited_media, capture_media=False)

        try:
            run_unit_tests(unit_ctx, args.url)
        except Exception as error:
            from unit_phase import unit_phase_failure
            failure = unit_phase_failure("unit_execution", error)
            unit_ctx.check(
                "Unit / Infrastructure",
                "Unit phase completed with the expected minimum result count",
                False,
                str(failure),
                screenshot=False,
            )
        browser.close()

    html_path = write_combined_report(e2e_ctx, unit_ctx, results_dir, report_stem)
    publish_latest(RESULTS_DIR, results_dir, html_path)

    total = len(unit_ctx.results)
    failed = [r for r in unit_ctx.results if r.status == "FAIL"]
    print(f"\nUnit summary: {total - len(failed)}/{total} passed, {len(failed)} FAILED")
    print("Unit Test Results (failures first):")
    for r in sorted(unit_ctx.results, key=lambda result: result.status != "FAIL"):
        color = "\033[92m" if r.status == "PASS" else "\033[93m" if r.status == "WARN" else "\033[91m"
        reset = "\033[0m"
        detail_str = f" — {r.detail}" if r.detail else ""
        print(f"[{color}{r.status}{reset}] {r.number}|{total}. {r.name}{detail_str}")

    print(f"Report html      → {html_path}", flush=True)

    passed = total - len(failed)
    print(f"\n{passed}/{total} unit checks passed" + (f", {len(failed)} FAILED" if failed else ""))
    return 1 if failed or not total else 0


def main():
    parser = argparse.ArgumentParser(description="PhaseFinder standalone unit test runner")
    parser.add_argument("--url", default=None, help="App URL. If omitted, uses the first open port from 8000 through 9000.")
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--limited-media", dest="limited_media", action="store_true", default=True,
                        help="keep one representative image per unit group instead of one per eligible check")
    parser.add_argument("--all-media", dest="limited_media", action="store_false",
                        help="capture media for every eligible check")
    parser.add_argument("--keep", action="store_true", help="keep older standalone unit reports instead of deleting them before the run")
    args = parser.parse_args()

    httpd = None
    if not args.url:
        repo_root = _TESTS_ROOT.parent
        print("Starting up a new local server process to serve the app...", flush=True)
        port, httpd = start_test_server(str(repo_root))
        args.url = f"http://127.0.0.1:{port}/index.html"
        print(f"Server successfully started at {args.url}", flush=True)

    try:
        ret = run(args)
    except PlaywrightTimeoutError as err:
        print(f"Playwright timed out: {err}", file=sys.stderr)
        ret = 1
    except Exception as err:
        print(f"Unit test runner failed: {err}", file=sys.stderr)
        ret = 1
    finally:
        if httpd:
            print("\nShutting down local test server process...", flush=True)
            httpd.shutdown()
            httpd.server_close()
            print("Server shutdown complete.", flush=True)

    return ret


if __name__ == "__main__":
    sys.exit(main())
