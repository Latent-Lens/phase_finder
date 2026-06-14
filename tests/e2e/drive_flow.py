#!/usr/bin/env python3
"""End-to-end driver for PhaseFinder.

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
        check("title is 'Histogram of Events:  n Samples  |  m Events'",
              title.startswith(f"Histogram of Events:  {len(files)} Samples  |  "), repr(title))
        check("y-axis label 'Number of Events'",
              page.eval_on_selector_all("#plotArea svg text", "els => els.some(t => t.textContent === 'Number of Events')"))
        check("one curve per checked sample", density_curve_count(page) == len(files),
              f"{density_curve_count(page)} of {len(files)}")

        # Uncheck a row: curve + title update, data preserved
        page.query_selector_all(".file-table tbody .row-select")[0].uncheck()
        time.sleep(0.3)
        check("uncheck removes a curve", density_curve_count(page) == len(files) - 1)
        check("uncheck updates title count",
              page.eval_on_selector("#plotTitle", "e => e.textContent").startswith(f"Histogram of Events:  {len(files) - 1} Samples  |  "))
        check("unchecked row keeps its loaded data",
              page.evaluate("window.PhaseFinderApp.getParsedFiles().filter(r => r.data).length") == len(files))
        page.query_selector_all(".file-table tbody .row-select")[0].check()
        time.sleep(0.3)
        check("re-check restores the curve", density_curve_count(page) == len(files))

        # Controls don't error and keep the curves
        page.select_option("#plotColorBy", "strain"); time.sleep(0.2)
        page.fill("#plotBins", "64"); page.dispatch_event("#plotBins", "change"); time.sleep(0.2)
        check("controls (color/bins) keep curves", density_curve_count(page) == len(files))
        check("X-axis selector removed", page.query_selector("#plotXScale") is None)
        # Reset to the default bin count so the DJF checks below reflect normal use.
        page.fill("#plotBins", "512"); page.dispatch_event("#plotBins", "change"); time.sleep(0.2)

        # After analysis the button becomes "Start Modeling (DJF)" (blue).
        check("button switched to Start Modeling (DJF)",
              page.eval_on_selector("#startAnalysisButton", "e => e.textContent.trim()") == "Start Modeling (DJF)"
              and page.eval_on_selector("#startAnalysisButton", "e => e.classList.contains('modeling')"))
        check("Model (DJF) dropdown removed", page.query_selector("#plotModelSample") is None)
        plot_height_before_fit_table = page.eval_on_selector("#plotArea", "e => e.clientHeight")

        # Start modeling: fits the first plotted sample; readout shows its fractions.
        import re
        fit_totals = "() => [...document.querySelectorAll('#plotArea svg path')].filter(p => p.getAttribute('stroke') === '#111827' && p.getAttribute('stroke-width') === '2').length"
        page.click("#startAnalysisButton")
        page.wait_for_function("() => /G1/.test(document.querySelector('#djfReadout').textContent)", timeout=30000)
        time.sleep(0.3)
        check("one fit shown after Start Modeling", page.evaluate(fit_totals) == 1, str(page.evaluate(fit_totals)))
        text = page.eval_on_selector("#djfReadout", "e => e.textContent")
        print(f"       DJF {text}", flush=True)
        nums = [float(x) for x in re.findall(r"([\d.]+)%", text)]
        check("DJF fractions sum ~100%", len(nums) == 3 and abs(sum(nums) - 100) < 0.5, str(nums))
        page.wait_for_selector("#djfFitTable:not([hidden]) tbody tr", timeout=10000)
        phase_rows = page.eval_on_selector_all("#djfFitTable .djf-fit-phase-row", "rows => rows.length")
        title_rows = page.eval_on_selector_all("#djfFitTable .djf-fit-title-row", "rows => rows.length")
        fit_headers = page.eval_on_selector_all("#djfFitTable .djf-fit-column-row th", "ths => ths.map(th => th.textContent.trim())")
        title_text = page.eval_on_selector("#djfFitTable .djf-fit-title-row", "row => row.textContent")
        check("DJF fit table has title row above one row per phase", title_rows == 1 and phase_rows == 3,
              f"titles={title_rows}, phases={phase_rows}")
        check("DJF fit table has phase/stat columns below title",
              all(h in fit_headers for h in ["Phase", "Percent", "Mean", "Std Dev"]), str(fit_headers))
        check("DJF fit table title row includes metadata",
              all(token in title_text for token in ["Strain:", "Replicate:", "Nocodazole Arrest:", "Timepoint:"]),
              title_text)
        fit_table_box = page.evaluate("""() => {
            const plot = document.querySelector('#plotArea').getBoundingClientRect();
            const table = document.querySelector('#djfFitTable').getBoundingClientRect();
            return {
                plotWidth: plot.width,
                width: table.width,
                leftFromPlot: table.left - plot.left,
                topFromPlot: table.top - plot.top,
                rightGap: plot.right - table.right,
            };
        }""")
        check("DJF fit table is compact in the legend margin",
              fit_table_box["width"] <= 250
              and fit_table_box["leftFromPlot"] >= fit_table_box["plotWidth"] - 260
              and fit_table_box["topFromPlot"] >= 100
              and fit_table_box["rightGap"] >= 0,
              str(fit_table_box))
        plot_height_after_fit_table = page.eval_on_selector("#plotArea", "e => e.clientHeight")
        check("DJF fit table does not shrink plot area",
              abs(plot_height_after_fit_table - plot_height_before_fit_table) <= 1,
              f"before={plot_height_before_fit_table}, after={plot_height_after_fit_table}")

        # A second sample's legend checkbox adds its fit; clicking again removes it.
        second = next(f.split("/")[-1][:-4] for f in files if "t105" in f)
        click_legend = """(name) => { const t=[...document.querySelectorAll('#plotArea svg text')].find(t=>t.textContent===name); if(t) t.parentNode.dispatchEvent(new MouseEvent('click',{bubbles:true})); }"""
        page.evaluate(click_legend, second); time.sleep(0.3)
        check("legend checkbox adds a 2nd fit", page.evaluate(fit_totals) == 2, str(page.evaluate(fit_totals)))
        check("DJF fit table expands for 2 fits",
              page.eval_on_selector_all("#djfFitTable .djf-fit-title-row", "rows => rows.length") == 2
              and page.eval_on_selector_all("#djfFitTable .djf-fit-phase-row", "rows => rows.length") == 6)
        page.evaluate(click_legend, second); time.sleep(0.3)
        check("legend checkbox removes the fit", page.evaluate(fit_totals) == 1, str(page.evaluate(fit_totals)))
        check("DJF fit table returns to 1 fit",
              page.eval_on_selector_all("#djfFitTable .djf-fit-title-row", "rows => rows.length") == 1
              and page.eval_on_selector_all("#djfFitTable .djf-fit-phase-row", "rows => rows.length") == 3)
        check("data curves untouched by fit toggling", density_curve_count(page) == len(files))

        # Correction toggles refilter the plotted events and recompute visible DJF fits.
        page.check("#plotDebrisCorrection"); time.sleep(0.4)
        corrected_text = page.eval_on_selector("#djfReadout", "e => e.textContent")
        check("debris/background correction updates readout",
              "events plotted" in corrected_text and "debris/background removed" in corrected_text, corrected_text)
        page.check("#plotDoubletCorrection"); time.sleep(0.4)
        corrected_text = page.eval_on_selector("#djfReadout", "e => e.textContent")
        check("aggregate/doublet correction updates readout",
              "aggregates/doublets removed" in corrected_text or "aggregate/doublet channels unavailable" in corrected_text,
              corrected_text)
        check("correction counts are stacked on separate lines", corrected_text.count("\n") >= 2, repr(corrected_text))
        debris_tip = page.eval_on_selector("#plotDebrisCorrection ~ .info-icon", "e => e.getAttribute('data-tooltip')")
        doublet_tip = page.eval_on_selector("#plotDoubletCorrection ~ .info-icon", "e => e.getAttribute('data-tooltip')")
        tip_speed = page.eval_on_selector("#plotDebrisCorrection ~ .info-icon",
                                          "e => getComputedStyle(e, '::after').transitionDuration")
        check("correction help text includes the math method",
              "Method:" in debris_tip and "FWHM" in debris_tip
              and "Method:" in doublet_tip and "MAD" in doublet_tip,
              f"debris={debris_tip}; doublet={doublet_tip}")
        tip_durations = [part.strip() for part in tip_speed.split(",")]
        check("correction help popup is quick",
              tip_durations and all(part in ("0.07s", "70ms") for part in tip_durations),
              tip_speed)
        check("corrections keep sample curves", density_curve_count(page) == len(files))
        page.uncheck("#plotDebrisCorrection"); page.uncheck("#plotDoubletCorrection"); time.sleep(0.4)

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
