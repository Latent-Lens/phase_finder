#!/usr/bin/env python3
"""End-to-end driver for Flow Plotter.

Launches the static app in headless Chromium (via Playwright), loads real FCS
files, runs analysis, and exercises the plot + Dean-Jett-Fox modeling — the
things unit tests can't cover because they need a browser and real data.

Setup (no browser/node is assumed to exist in the dev env):

    python3 -m venv /tmp/flowvenv
    /tmp/flowvenv/bin/pip install playwright
    /tmp/flowvenv/bin/python -m playwright install chromium

Serve the app (no-cache so edits aren't stale), then run this:

    python3 -m http.server 8731            # from the repo root
    /tmp/flowvenv/bin/python tests/e2e/drive_flow.py

Useful flags: --files N, --data DIR, --url URL, --screenshot PATH, --headed.
Exits non-zero if any structural check fails.
"""

import argparse
import glob
import os
import sys
import time
from datetime import datetime

from playwright.sync_api import sync_playwright

DEFAULT_DATA = "/fast/mike/latentlens/projects/flow_plotter/flow_data"
DEFAULT_URL = "http://localhost:8731/index.html"
# Generated artifacts (screenshots, etc.) go here, next to this script.
RESULTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results")

failures = []


def check(label, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {label}{(' — ' + detail) if detail else ''}", flush=True)
    if not ok:
        failures.append(label)


def density_curve_count(page):
    return page.eval_on_selector_all(
        "#plotArea svg path",
        "els => els.filter(p => (p.getAttribute('stroke')||'').startsWith('hsl')).length",
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--data", default=DEFAULT_DATA)
    ap.add_argument("--files", type=int, default=3, help="number of FCS files to load")
    ap.add_argument("--screenshot", default=None,
                    help="screenshot path (default: results/flow_e2e_<timestamp>.png)")
    ap.add_argument("--headed", action="store_true")
    args = ap.parse_args()

    if args.screenshot is None:
        os.makedirs(RESULTS_DIR, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        args.screenshot = os.path.join(RESULTS_DIR, f"flow_e2e_{stamp}.png")
    elif args.screenshot:
        os.makedirs(os.path.dirname(os.path.abspath(args.screenshot)), exist_ok=True)

    files = sorted(glob.glob(f"{args.data}/*.fcs"))[: args.files]
    if not files:
        print(f"No .fcs files under {args.data}", file=sys.stderr)
        return 2

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed)
        # 1920x1080 viewport; the screenshot captures it directly (not full-page)
        # for a 1920x1080 image with the plot panel fully shown.
        page = browser.new_page(viewport={"width": 1920, "height": 1080})
        page_errors = []
        page.on("pageerror", lambda e: page_errors.append(str(e)))

        page.goto(args.url)
        page.wait_for_function("() => typeof window.d3 !== 'undefined'", timeout=20000)
        for lib in ("levenbergMarquardt", "gsd"):
            try:
                page.wait_for_function(f"() => typeof window.{lib} === 'function'", timeout=20000)
                check(f"library {lib} loaded", True)
            except Exception:
                check(f"library {lib} loaded", False, page.evaluate(f"typeof window.{lib}"))

        # Load + analyze
        page.set_input_files("#fileInput", files)
        page.wait_for_selector(".file-table tbody tr", timeout=60000)
        page.click("#startAnalysisButton")
        page.wait_for_selector("#plotArea svg path", timeout=120000)

        title = page.eval_on_selector("#plotTitle", "e => e.textContent")
        check("title is 'Histogram of Events: n Samples, m Events'",
              title.startswith(f"Histogram of Events: {len(files)} Samples,"), repr(title))
        check("y-axis label 'Number of Events'",
              page.eval_on_selector_all("#plotArea svg text", "els => els.some(t => t.textContent === 'Number of Events')"))
        check("one curve per checked sample", density_curve_count(page) == len(files),
              f"{density_curve_count(page)} of {len(files)}")

        # Uncheck a row: curve + title update, data preserved
        page.query_selector_all(".file-table tbody .row-select")[0].uncheck()
        time.sleep(0.3)
        check("uncheck removes a curve", density_curve_count(page) == len(files) - 1)
        check("uncheck updates title count",
              page.eval_on_selector("#plotTitle", "e => e.textContent").startswith(f"Histogram of Events: {len(files) - 1} Samples,"))
        check("unchecked row keeps its loaded data",
              page.evaluate("window.FlowPlotterApp.getParsedFiles().filter(r => r.data).length") == len(files))
        page.query_selector_all(".file-table tbody .row-select")[0].check()
        time.sleep(0.3)
        check("re-check restores the curve", density_curve_count(page) == len(files))

        # Controls don't error and keep the curves
        for sel, val in (("#plotColorBy", "strain"), ("#plotXScale", "log"), ("#plotXScale", "linear")):
            page.select_option(sel, val); time.sleep(0.2)
        page.fill("#plotBins", "64"); page.dispatch_event("#plotBins", "change"); time.sleep(0.2)
        check("controls (color/log/bins) keep curves", density_curve_count(page) == len(files))
        # Reset to the default bin count so the DJF checks below reflect normal use.
        page.fill("#plotBins", "256"); page.dispatch_event("#plotBins", "change"); time.sleep(0.2)

        # DJF fit for each sample: readout present, fractions finite and ~100%
        for name in page.eval_on_selector_all("#plotModelSample option", "els => els.map(o => o.value).filter(Boolean)"):
            page.select_option("#plotModelSample", name)
            page.wait_for_function("() => /G1/.test(document.querySelector('#djfReadout').textContent)", timeout=30000)
            text = page.eval_on_selector("#djfReadout", "e => e.textContent")
            print(f"       DJF {text}", flush=True)
            import re
            nums = [float(x) for x in re.findall(r"([\d.]+)%", text)]
            check(f"DJF fractions sum ~100% ({name[:28]})", len(nums) == 3 and abs(sum(nums) - 100) < 0.5, str(nums))

        # Threshold line: hidden until the checkbox is ticked, then draggable.
        threshold_sel = "#plotArea svg .threshold-line, #plotArea svg .threshold-fill"
        check("threshold line hidden by default", page.query_selector(threshold_sel) is None)
        page.check("#plotThresholdToggle"); time.sleep(0.3)
        check("threshold line shows when checked", page.query_selector(threshold_sel) is not None)
        page.uncheck("#plotThresholdToggle"); time.sleep(0.3)
        check("threshold line hides when unchecked", page.query_selector(threshold_sel) is None)
        page.check("#plotThresholdToggle"); time.sleep(0.3)

        if args.screenshot:
            page.screenshot(path=args.screenshot)  # viewport-size (1920x1080)
            print(f"       screenshot -> {args.screenshot}", flush=True)
        check("no page errors", not page_errors, str(page_errors))
        browser.close()

    print(f"\n{'ALL CHECKS PASSED' if not failures else 'FAILURES: ' + ', '.join(failures)}")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
