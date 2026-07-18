#!/usr/bin/env python3
"""Standalone JavaScript unit test runner.

Runs only tests/unit/test_harness.html's unit suites against a headless
Chromium page -- independent of the full e2e regression driver
(tests/e2e/drive_flow.py). Use this when you want a fast correctness check on
the numeric/state modules without waiting on (or being blocked by) the full
browser-driven e2e flow, or when an e2e failure/hang would otherwise prevent
the unit suites from running at all.

Usage:
  /tmp/flowvenv/bin/python tests/unit/run_standalone.py [--url URL] [--headed]

Unlike drive_flow.py, this does not clear tests/e2e/results/ -- it only adds
its own timestamped report there, so it's safe to run alongside (or between)
full regression runs without discarding their reports/videos.
"""

import argparse
import sys
import time
import http.server
import socketserver
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_E2E = _HERE.parent / "e2e"
for _p in (_HERE, _E2E):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError, sync_playwright

from helpers import TestContext, results_asset_dirs, write_combined_report
from run_unit_tests import run_unit_tests

RESULTS_DIR = _E2E / "results"


def start_test_server(directory: str) -> tuple:
    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, format, *args):
            pass  # Suppress HTTP access logs
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=directory, **kwargs)

    httpd = socketserver.TCPServer(("127.0.0.1", 0), Handler)
    port = httpd.server_address[1]
    import threading
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return port, httpd


def run(args) -> int:
    img_dir, _vid_dir = results_asset_dirs(RESULTS_DIR)
    img_dir.mkdir(parents=True, exist_ok=True)

    stamp = time.strftime("%Y%m%d-%H%M%S")
    report_stem = f"unit_only_{stamp}"

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed)
        page = browser.new_page()
        # Doubles as the (empty) e2e context write_combined_report expects --
        # no e2e phase runs here, so its summary section is simply empty.
        e2e_ctx = TestContext(page=page, results_dir=RESULTS_DIR, report_stem=report_stem)
        unit_ctx = TestContext(page=page, results_dir=RESULTS_DIR, report_stem=report_stem)

        run_unit_tests(unit_ctx, args.url)
        browser.close()

    md_path, html_path = write_combined_report(e2e_ctx, unit_ctx, RESULTS_DIR, report_stem)

    total = len(unit_ctx.results)
    print("\nUnit Test Results:")
    for idx, r in enumerate(unit_ctx.results, 1):
        color = "\033[92m" if r.status == "PASS" else "\033[93m" if r.status == "WARN" else "\033[91m"
        reset = "\033[0m"
        detail_str = f" — {r.detail}" if r.detail else ""
        print(f"[{color}{r.status}{reset}] {idx}|{total}. {r.name}{detail_str}")

    print(f"\nReport markdown  → {md_path}", flush=True)
    print(f"Report html      → {html_path}", flush=True)

    failed = [r for r in unit_ctx.results if r.status == "FAIL"]
    passed = total - len(failed)
    print(f"\n{passed}/{total} unit checks passed" + (f", {len(failed)} FAILED" if failed else ""))
    return 1 if failed or not total else 0


def main():
    parser = argparse.ArgumentParser(description="PhaseFinder standalone unit test runner")
    parser.add_argument("--url", default=None, help="App URL. If omitted, starts a local server on a random port.")
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()

    httpd = None
    if not args.url:
        repo_root = _HERE.parents[1]
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
