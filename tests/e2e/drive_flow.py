#!/usr/bin/env python3
"""PhaseFinder end-to-end + unit test runner.

This script is the single entry point. It:
  1. Runs all e2e tests against a headed or headless Chromium instance, with a
     full-session WebM recorded via Playwright and per-test clips trimmed by ffmpeg.
  2. Runs JavaScript unit tests via a second Playwright page pointed at
     tests/unit/test_harness.html.
  3. Writes a combined HTML + Markdown report to tests/e2e/results/.

Usage:
  /tmp/flowvenv/bin/python tests/e2e/drive_flow.py [--headed] [--files N] [--extra-files N]
"""

import argparse
import sys
import time
import threading
import http.server
import socketserver
import socket
import subprocess
import urllib.request
from contextlib import nullcontext
from pathlib import Path

# Put this directory on sys.path so sibling helpers/test modules are importable
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

# Also put the unit test directory on sys.path
_UNIT = _HERE.parent / "unit"
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
    suspended_local_autoload_config,
    write_combined_report,
)
from tests_io import test_file_loading, test_libraries
from tests_filtering import test_table_filtering_sorting
from tests_plotting import test_plotting
from tests_modeling import test_modeling
from tests_sidebar import test_sidebar_icons
from tests_stats import test_summary_statistics
from tests_metadata_wizard import test_metadata_wizard
from tests_reset import test_reset

RESULTS_DIR = Path(__file__).resolve().parent / "results"
TEST_DATA_DIR = Path(__file__).resolve().parents[1] / "test_data"


def run(args):
    print("\n--- PhaseFinder Test Runner ---", flush=True)
    print("Performing pre-test cleanup:", flush=True)
    print(f"  1. Cleaning results directory ({RESULTS_DIR}) - removing old HTML reports, images, and videos...", flush=True)
    _, vid_dir = prepare_results_dir(RESULTS_DIR)
    
    print(f"  2. Cleaning test data directory ({TEST_DATA_DIR}) - removing old synthetic FCS files...", flush=True)
    test_data_dir = prepare_test_data_dir(TEST_DATA_DIR)
    print("Cleanup complete!\n", flush=True)

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
        browser = p.chromium.launch(headless=not args.headed)

        # ----------------------------------------------------------------
        # E2E phase — recorded to WebM
        # ----------------------------------------------------------------
        e2e_context = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            record_video_dir=str(vid_dir),
            record_video_size={"width": 1920, "height": 1080},
        )
        e2e_page = e2e_context.new_page()
        e2e_ctx = TestContext(
            page=e2e_page,
            results_dir=RESULTS_DIR,
            report_stem=report_stem,
        )
        e2e_ctx.video_record_start = time.monotonic()
        e2e_ctx._last_test_end = e2e_ctx.video_record_start

        e2e_page.on("pageerror", lambda err: e2e_ctx.page_errors.append(str(err)))
        e2e_page.goto(args.url)
        e2e_page.wait_for_load_state("domcontentloaded")

        test_libraries(e2e_ctx)
        test_file_loading(e2e_ctx, drag_drop_files, file_browser_files, additional_files)
        test_table_filtering_sorting(e2e_ctx)
        test_plotting(e2e_ctx, args.channel)
        test_modeling(e2e_ctx)
        test_sidebar_icons(e2e_ctx)
        test_summary_statistics(e2e_ctx)
        test_metadata_wizard(e2e_ctx)
        test_reset(e2e_ctx, reset_files)
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

        # ----------------------------------------------------------------
        # Unit test phase — new tab in the SAME context so CDN cache is shared
        # (levenbergMarquardt / gsd from esm.sh are already cached from the
        # e2e page; a new context would have to re-fetch them cold and often
        # hits rate-limits or timeout on slow connections)
        # ----------------------------------------------------------------
        unit_page = e2e_context.new_page()
        unit_ctx = TestContext(
            page=unit_page,
            results_dir=RESULTS_DIR,
            report_stem=report_stem,
            number_offset=len(e2e_ctx.results),
        )

        try:
            from run_unit_tests import run_unit_tests
            run_unit_tests(unit_ctx, args.url)
        except Exception as unit_err:
            print(f"[WARN] Unit tests failed to run: {unit_err}", flush=True)

        # Close context to finalise the video file (after unit tests)
        e2e_context.close()

        # Extract per-test WebM clips with ffmpeg
        try:
            if e2e_page.video:
                full_video = e2e_page.video.path()
                if full_video and Path(full_video).exists():
                    extract_video_clips(e2e_ctx, full_video, RESULTS_DIR, report_stem)
        except Exception as vid_err:
            print(f"[WARN] Video clip extraction failed: {vid_err}", flush=True)

        browser.close()

    # ----------------------------------------------------------------
    # Combined report
    # ----------------------------------------------------------------
    md_path, html_path = write_combined_report(e2e_ctx, unit_ctx, RESULTS_DIR, report_stem)

    all_results = e2e_ctx.results + (unit_ctx.results if unit_ctx else [])
    total_tests = len(all_results)

    print("\nTest Execution Results:")
    for idx, r in enumerate(all_results, 1):
        color = "\033[92m" if r.status == "PASS" else "\033[93m" if r.status == "WARN" else "\033[91m"
        reset = "\033[0m"
        detail_str = f" — {r.detail}" if r.detail else ""
        print(f"[{color}{r.status}{reset}] {idx}|{total_tests}. {r.name}{detail_str}")

    print(f"\nReport markdown  → {md_path}", flush=True)
    print(f"Report html      → {html_path}", flush=True)

    failed = [r for r in all_results if r.status == "FAIL"]
    return 1 if failed else 0


def start_test_server(directory: str) -> tuple:
    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, format, *args):
            pass  # Suppress HTTP access logs
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=directory, **kwargs)

    httpd = socketserver.TCPServer(("127.0.0.1", 0), Handler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return port, httpd


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def start_vite_server(repo_root: Path) -> tuple:
    vite_bin = repo_root / "node_modules" / ".bin" / "vite"
    if not vite_bin.exists():
        raise RuntimeError(
            "Vite dependencies are not installed. Install the package manager/toolchain, "
            "run the project dependency install, then retry the test runner."
        )

    port = find_free_port()
    proc = subprocess.Popen(
        [str(vite_bin), "--host", "127.0.0.1", "--port", str(port), "--strictPort"],
        cwd=str(repo_root),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
    )
    url = f"http://127.0.0.1:{port}/index.html"

    deadline = time.monotonic() + 20
    last_error = None
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"Vite dev server exited early with status {proc.returncode}")
        try:
            with urllib.request.urlopen(url, timeout=1) as resp:
                if resp.status < 500:
                    return url, proc
        except Exception as err:
            last_error = err
            time.sleep(0.25)

    proc.terminate()
    raise RuntimeError(f"Timed out waiting for Vite dev server at {url}: {last_error}")


def main():
    parser = argparse.ArgumentParser(description="PhaseFinder E2E + unit test runner")
    parser.add_argument("--url", default=None, help="App URL. If omitted, starts Vite or a local static server on a random port.")
    parser.add_argument("--data", default=None,
                        help=f"FCS directory to test with; omitted uses synthetic fixtures. Legacy default was {DEFAULT_DATA}")
    parser.add_argument("--files", type=int, default=4, help="initial FCS files to load")
    parser.add_argument("--extra-files", type=int, default=2, help="additional unique FCS files to append")
    parser.add_argument("--channel", default="GFP/FITC-A")
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()

    httpd = None
    vite_proc = None
    local_autoload_guard = nullcontext()

    if not args.url:
        repo_root = Path(_HERE.parents[1])
        if (repo_root / "package.json").exists():
            print("Starting a local Vite dev server to serve the app...", flush=True)
            args.url, vite_proc = start_vite_server(repo_root)
            print(f"Vite server successfully started at {args.url}", flush=True)
            local_autoload_guard = suspended_local_autoload_config(repo_root / "public")
        else:
            print(f"Starting up a new local server process to serve the app...", flush=True)
            port, httpd = start_test_server(str(repo_root))
            args.url = f"http://127.0.0.1:{port}/index.html"
            print(f"Server successfully started at {args.url}", flush=True)
            # A personal, uncommitted phasefinder_local.json in the repo root
            # would otherwise get served to the app under test and silently
            # auto-load unrelated files, desyncing every row-count assertion.
            local_autoload_guard = suspended_local_autoload_config(repo_root)

    with local_autoload_guard:
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
            if vite_proc:
                print(f"\nShutting down local Vite server process...", flush=True)
                vite_proc.terminate()
                try:
                    vite_proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    vite_proc.kill()
                    vite_proc.wait(timeout=5)
                print("Vite server shutdown complete.", flush=True)

    return ret


if __name__ == "__main__":
    sys.exit(main())
