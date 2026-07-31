#!/usr/bin/env python3
"""PhaseFinder end-to-end + unit test runner.

This script is the single entry point. It:
  1. Runs all e2e tests against a headed or headless browser, with a full-session
     WebM recorded via Playwright and per-test clips trimmed by ffmpeg. Local runs
     always use the same bundled Chromium instance as before; GitHub Actions may
     select a configured browser with --browser.
  2. Runs JavaScript unit tests via a second Playwright page pointed at
     tests/unit/test_harness.html.
  3. Writes one self-contained combined HTML report to tests/.

Usage:
  /tmp/flowvenv/bin/python tests/e2e/driving_code/drive_flow.py [--headed] [--files N] [--extra-files N]
"""

import argparse
import os
import sys
import time
from pathlib import Path

# Put this directory on sys.path so sibling helpers/test modules are importable
_HERE = Path(__file__).resolve().parent
_TESTS_ROOT = _HERE.parents[1]
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

# Also put the unit test directory on sys.path
_UNIT = _TESTS_ROOT / "unit" / "driving_code"
if str(_UNIT) not in sys.path:
    sys.path.insert(0, str(_UNIT))

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError, sync_playwright

from helpers import (
    DEFAULT_DATA,
    TestContext,
    extract_video_clips,
    fcs_files,
    make_drag_drop_fixtures,
    make_synthetic_fcs_pool,
    prepare_results_dir,
    prepare_test_data_dir,
    results_asset_dirs,
    write_combined_report,
)
from test_server import start_test_server
from run_artifacts import publish_latest
from phase_status import PhaseFailure, PhaseTracker
from compatibility_evidence import write_compatibility_evidence
from tests_io import test_file_loading, test_libraries
from tests_filtering import test_table_filtering_sorting
from tests_plotting import test_plotting, test_plot_toolbar
from tests_pipeline import test_pipeline, test_time_qc_methods
from tests_modeling import test_modeling
from tests_sidebar import test_responsive_reachability, test_sidebar_icons, test_sidebar_modeling_mode
from tests_stats import test_summary_statistics
from tests_metadata_wizard import test_metadata_wizard
from tests_metadata_table import test_metadata_table_actions
from tests_reset import test_reset

RESULTS_DIR = _TESTS_ROOT / "e2e" / "results"
TEST_DATA_DIR = _TESTS_ROOT / "e2e" / "e2e_test_data"
GITHUB_ACTIONS = os.environ.get("GITHUB_ACTIONS", "").lower() == "true"


def launch_browser(playwright, browser_name, headed=False):
    """Launch the requested CI browser while preserving local Chromium runs.

    GitHub Actions sets GITHUB_ACTIONS=true for every workflow job. Outside
    that environment, browser_name is deliberately ignored so the existing
    local command continues to use Playwright's bundled Chromium.

    WebKit is engine compatibility coverage, not the native Safari application.
    Brave is driven through its installed executable, supplied by the workflow
    as BRAVE_PATH.
    """
    launch_options = {"headless": not headed}

    if not GITHUB_ACTIONS:
        print("Browser: Playwright Chromium (local default)", flush=True)
        return playwright.chromium.launch(**launch_options)

    print(f"Browser: {browser_name} (GitHub Actions)", flush=True)
    if browser_name == "chromium":
        return playwright.chromium.launch(**launch_options)
    if browser_name == "firefox":
        return playwright.firefox.launch(**launch_options)
    if browser_name == "webkit":
        return playwright.webkit.launch(**launch_options)
    if browser_name == "edge":
        return playwright.chromium.launch(channel="msedge", **launch_options)
    if browser_name == "brave":
        brave_path = os.environ.get("BRAVE_PATH")
        if not brave_path:
            raise RuntimeError(
                "BRAVE_PATH must point to the Brave executable in GitHub Actions."
            )
        return playwright.chromium.launch(
            executable_path=brave_path,
            **launch_options,
        )

    raise ValueError(f"Unsupported GitHub Actions browser: {browser_name}")


def run(args):
    print("\n--- PhaseFinder Test Runner ---", flush=True)
    run_id = f"{time.strftime('%Y%m%d-%H%M%S')}-{os.getpid()}"
    results_dir = RESULTS_DIR / run_id
    test_data_root = TEST_DATA_DIR / run_id
    if args.keep:
        print("Runs are isolated; older output is always retained.", flush=True)
        img_dir, vid_dir = results_asset_dirs(results_dir)
        for asset_dir in (img_dir, vid_dir):
            asset_dir.mkdir(parents=True, exist_ok=True)
    else:
        print("Preparing isolated test output:", flush=True)
        _, vid_dir = prepare_results_dir(results_dir)
    phases = PhaseTracker(results_dir / "phase-status.json")
    
    test_data_dir = prepare_test_data_dir(test_data_root)
    print(f"Run directory: {results_dir}\n", flush=True)

    stamp = time.strftime("%Y%m%d-%H%M%S")
    report_stem = f"flow_e2e_{stamp}"

    if args.files < 2:
        raise RuntimeError("--files must be at least 2")

    drag_count = min(2, args.files - 1)
    browser_count = args.files - drag_count
    drag_drop_files = make_drag_drop_fixtures(test_data_dir, report_stem, count=drag_count)
    needed_files = max(args.files + args.extra_files + 7, 9)
    if args.data:
        real_files = fcs_files(args.data, needed_files)
    else:
        real_files = make_synthetic_fcs_pool(test_data_dir, report_stem, count=needed_files)
    file_browser_files = real_files[:browser_count]
    additional_files = real_files[browser_count: browser_count + args.extra_files]
    reset_files = file_browser_files[:1] or drag_drop_files[:1]

    e2e_ctx = None
    unit_ctx = None

    with sync_playwright() as p:
        # ----------------------------------------------------------------
        # E2E phase — recorded to WebM
        # ----------------------------------------------------------------
        def setup_e2e():
            browser = launch_browser(p, args.browser, args.headed)
            context = browser.new_context(
                viewport={"width": 1920, "height": 1080},
                record_video_dir=str(vid_dir),
                record_video_size={"width": 1920, "height": 1080},
            )
            video_record_start = time.monotonic()
            page = context.new_page()
            context_results = TestContext(
                page=page,
                results_dir=results_dir,
                report_stem=report_stem,
                all_media=not args.limited_media,
            )
            context_results.video_record_start = video_record_start
            context_results._last_test_end = video_record_start
            page.on("pageerror", lambda err: context_results.page_errors.append(str(err)))
            page.goto(args.url)
            page.wait_for_load_state("domcontentloaded")
            return browser, context, page, context_results

        browser, e2e_context, e2e_page, e2e_ctx = phases.run("e2e_setup", setup_e2e)
        browser_version = browser.version

        def run_e2e_group(name, operation):
            before = len(e2e_ctx.results)
            try:
                operation()
            except Exception as error:
                e2e_ctx.check(
                    "Runner / Phases",
                    f"{name} phase completed",
                    False,
                    f"{type(error).__name__}: {error}",
                    screenshot=False,
                )
            new_results = e2e_ctx.results[before:]
            failures = [result for result in new_results if result.status == "FAIL"]
            phases.record(
                f"e2e:{name}",
                "failed" if failures else "passed",
                f"{len(failures)} failed check(s)" if failures else "",
            )

        groups = (
            ("libraries", lambda: test_libraries(e2e_ctx)),
            ("file_loading", lambda: test_file_loading(e2e_ctx, drag_drop_files, file_browser_files, additional_files)),
            ("table_filtering_sorting", lambda: test_table_filtering_sorting(e2e_ctx)),
            ("plotting", lambda: test_plotting(e2e_ctx, args.channel)),
            ("plot_toolbar", lambda: test_plot_toolbar(e2e_ctx)),
            ("pipeline", lambda: test_pipeline(e2e_ctx)),
            ("time_qc_methods", lambda: test_time_qc_methods(e2e_ctx)),
            ("modeling", lambda: test_modeling(e2e_ctx)),
            ("sidebar_icons", lambda: test_sidebar_icons(e2e_ctx)),
            ("sidebar_modeling_mode", lambda: test_sidebar_modeling_mode(e2e_ctx)),
            ("responsive_reachability", lambda: test_responsive_reachability(e2e_ctx)),
            ("summary_statistics", lambda: test_summary_statistics(e2e_ctx)),
            ("metadata_wizard", lambda: test_metadata_wizard(e2e_ctx)),
            ("metadata_table_actions", lambda: test_metadata_table_actions(e2e_ctx)),
            ("reset", lambda: test_reset(e2e_ctx, reset_files)),
        )
        if args.skip_modeling:
            groups = tuple(group for group in groups if group[0] != "modeling")
            phases.skip("e2e:modeling", "excluded from the non-scientific audit/compatibility gate")
        for group_name, group_operation in groups:
            run_e2e_group(group_name, group_operation)
        # Filter out expected channel-not-found errors (arise from channel change tests
        # when some loaded FCS files lack data for the selected secondary channel)
        unexpected_errors = [
            e for e in e2e_ctx.page_errors
            if "Could not find selected channel" not in e
        ]
        if unexpected_errors:
            e2e_ctx.check("Input/Output", "No uncaught page errors", False,
                          str(unexpected_errors), screenshot=False)
        elif e2e_ctx.page_errors:
            e2e_ctx.warn("Input/Output", "No uncaught page errors",
                         f"Expected channel-not-found errors: {e2e_ctx.page_errors}", screenshot=False)
        else:
            e2e_ctx.check("Input/Output", "No uncaught page errors", True, screenshot=False)
        phases.record(
            "e2e:page_errors",
            "failed" if unexpected_errors else "passed",
            str(unexpected_errors) if unexpected_errors else "",
        )

        # ----------------------------------------------------------------
        # Unit test phase — use a new tab in the same context so browser state
        # stays consistent while the module-level harness remains isolated.
        # ----------------------------------------------------------------
        unit_page = e2e_context.new_page()
        unit_ctx = TestContext(
            page=unit_page,
            results_dir=results_dir,
            report_stem=report_stem,
            number_offset=len(e2e_ctx.results),
            all_media=not args.limited_media,
            capture_media=False,
        )

        from run_unit_tests import execute_unit_tests, setup_unit_harness
        try:
            phases.run("unit_setup", lambda: setup_unit_harness(unit_ctx, args.url))
        except PhaseFailure as unit_err:
            phases.skip("unit_execution", "unit setup failed")
            unit_ctx.check(
                "Unit / Infrastructure",
                "Unit phase completed with the expected minimum result count",
                False,
                str(unit_err),
                screenshot=False,
            )
        else:
            try:
                phases.run("unit_execution", lambda: execute_unit_tests(unit_ctx))
            except PhaseFailure as unit_err:
                unit_ctx.check(
                    "Unit / Infrastructure",
                    "Unit phase completed with the expected minimum result count",
                    False,
                    str(unit_err),
                    screenshot=False,
                )

        def cleanup_browser():
            try:
                # Closing the context finalises the video file.
                e2e_context.close()
                try:
                    if e2e_page.video:
                        full_video = e2e_page.video.path()
                        if full_video and Path(full_video).exists():
                            extract_video_clips(e2e_ctx, full_video, results_dir, report_stem)
                except Exception as video_error:
                    print(f"[WARN] Video clip extraction failed: {video_error}", flush=True)
            finally:
                browser.close()

        try:
            phases.run("cleanup", cleanup_browser)
        except PhaseFailure as cleanup_error:
            e2e_ctx.check(
                "Runner / Phases",
                "Browser cleanup completed",
                False,
                str(cleanup_error),
                screenshot=False,
            )

    # ----------------------------------------------------------------
    # Combined report
    # ----------------------------------------------------------------
    html_path = phases.run(
        "report_generation",
        lambda: write_combined_report(e2e_ctx, unit_ctx, results_dir, report_stem),
    )

    all_results = e2e_ctx.results + (unit_ctx.results if unit_ctx else [])
    total_tests = len(all_results)
    failed = [r for r in all_results if r.status == "FAIL"]
    write_compatibility_evidence(
        results_dir / "compatibility.json",
        args.browser,
        browser_version,
        "failed" if failed or phases.failed else "passed",
    )
    publish_latest(RESULTS_DIR, results_dir, html_path)

    print(f"\nTest summary: {total_tests - len(failed)}/{total_tests} passed, {len(failed)} FAILED")
    print("Test Execution Results (failures first):")
    for r in sorted(all_results, key=lambda result: result.status != "FAIL"):
        color = "\033[92m" if r.status == "PASS" else "\033[93m" if r.status == "WARN" else "\033[91m"
        reset = "\033[0m"
        detail_str = f" — {r.detail}" if r.detail else ""
        print(f"[{color}{r.status}{reset}] {r.number}|{total_tests}. {r.name}{detail_str}")

    print(f"Report html      → {html_path}", flush=True)

    return 1 if failed or phases.failed else 0


def main():
    parser = argparse.ArgumentParser(description="PhaseFinder E2E + unit test runner")
    parser.add_argument("--url", default=None, help="App URL. If omitted, uses the first open port from 8000 through 9000.")
    parser.add_argument("--data", default=None,
                        help=f"FCS directory to test with; omitted uses synthetic fixtures. Legacy default was {DEFAULT_DATA}")
    parser.add_argument("--files", type=int, default=4, help="initial FCS files to load")
    parser.add_argument("--extra-files", type=int, default=2, help="additional unique FCS files to append")
    parser.add_argument("--channel", default="GFP/FITC-A")
    parser.add_argument(
        "--browser",
        choices=["chromium", "firefox", "webkit", "brave", "edge"],
        default="chromium",
        help=(
            "browser for GitHub Actions jobs; local runs always use Playwright "
            "Chromium regardless of this value"
        ),
    )
    parser.add_argument("--headed", action="store_true")
    parser.add_argument(
        "--skip-modeling",
        action="store_true",
        help="run the audit regression outside the scientific modeling UI group",
    )
    parser.add_argument(
        "--limited-media",
        dest="limited_media",
        action="store_true",
        default=True,
        help="keep one representative image/video per group instead of media for every eligible check",
    )
    parser.add_argument(
        "--all-media",
        dest="limited_media",
        action="store_false",
        help="capture media for every eligible check",
    )
    parser.add_argument("--keep", action="store_true", help="keep older E2E/unit reports instead of deleting them before the run")
    args = parser.parse_args()

    httpd = None
    if not args.url:
        repo_root = _TESTS_ROOT.parent
        print(f"Starting up a new local server process to serve the app...", flush=True)
        port, httpd = start_test_server(str(repo_root))
        args.url = f"http://127.0.0.1:{port}/index.html"
        print(f"Server successfully started at {args.url}", flush=True)
    try:
        ret = run(args)
    except PlaywrightTimeoutError as err:
        print(f"Playwright timed out: {err}", file=sys.stderr)
        ret = 1
    except Exception as err:
        print(f"Test runner failed: {err}", file=sys.stderr)
        ret = 1
    finally:
        if httpd:
            print(f"\nShutting down local test server process...", flush=True)
            httpd.shutdown()
            httpd.server_close()
            print("Server shutdown complete.", flush=True)

    return ret


if __name__ == "__main__":
    sys.exit(main())
