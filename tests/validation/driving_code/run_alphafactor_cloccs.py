#!/usr/bin/env python3
"""Diagnostic CLOCCS run against the private alpha-factor synchronized dataset (FEAT-04 box 1).

This is NOT a validation harness extension: the dataset lives outside the repo
at ../../../../test_flow_data/AlphaFactorSynchronizedHaplodis_NotPartOfExampleFlowJo_DJFData/
and has no reference values, so there is nothing to score against. This script
reports what the real CLOCCS code path does on real synchronized data, replacing
the earlier ad-hoc probe (docs/audits/cell_cycle_model_investigation_handoff.md
S5.6) that built rows with pnr: {} and silently disabled the Structural QC
saturation ceiling.

The dataset is never copied, symlinked, or read into the repo tree. To let the
browser fetch the files without moving them, this script starts a loopback-only
HTTP server rooted at the repo's PARENT directory (so both /PhaseFinder/... and
/test_flow_data/... are reachable from the same origin for the lifetime of the
run) rather than reusing REPO_ROOT as the served root the way validation_tests.py
does. The CLOCCS browser-side glue is the same code as
validation_tests.py's _CLOCCS_VALIDATION, with only the import/fetch path
prefixes adjusted for the different served root.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
SERVE_ROOT = REPO_ROOT.parent
DATA_DIR = SERVE_ROOT / "test_flow_data" / "AlphaFactorSynchronizedHaplodis_NotPartOfExampleFlowJo_DJFData"

E2E_HELPERS = REPO_ROOT / "tests" / "e2e" / "driving_code"
sys.path.insert(0, str(E2E_HELPERS))
from test_server import start_test_server  # noqa: E402

FILENAME_RE = re.compile(
    r"^EDS\d{4}-\d{2}-\d{2}_(?:alphasync|alphafac_sync)_(\w+?)_t(\d+)__(\w+)\.\d+\.fcs$"
)

# The instrument's detector for PI is spectrally shared with other dyes, so
# every file's $PnS label is a compound string like "PI/LSS-mKate/PerCP-A"
# rather than plain "PI" (confirmed via the real parser against all 9 strains'
# March-26 and April-2 naming conventions). Match on the leading token.
DNA_CHANNEL = "PI"

_CLOCCS_VALIDATION = r"""async input => {
  const [{ FCSParser }, { generateHistogram }, CLOCCS, bins] = await Promise.all([
    import('/PhaseFinder/js/fcs/parser.js'),
    import('/PhaseFinder/js/analysis/pipeline/dna_histogram.js'),
    import('/PhaseFinder/js/analysis/cell_cycle/models/cloccs.js'),
    import('/PhaseFinder/js/analysis/cell_cycle/bin_settings_sync.js'),
  ]);
  const samples = [];
  const binCounts = [];
  for (const file of input.files) {
    const response = await fetch(new URL(file.url, location.origin));
    if (!response.ok) throw new Error(`${file.url}: HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const summary = FCSParser.parse_fcs_header(buffer);
    const columnIndex = summary.columns.findIndex(
      label => label === input.channel || label.startsWith(input.channel + '/')
    );
    if (columnIndex < 0) throw new Error(`${file.url}: missing ${input.channel} (columns: ${summary.columns.join(', ')})`);
    const matchedLabel = summary.columns[columnIndex];
    const data = buffer.slice(summary.data_begin, summary.data_end + 1);
    const values = FCSParser.parse_selected_columns(data, summary.metadata, [columnIndex + 1])[columnIndex + 1];
    const binCount = bins.recommended_bin_count(values.length);
    const histogram = generateHistogram(values, null, { binCount, dnaChannel: matchedLabel });
    const limit = Math.max(1, Math.floor(histogram.x.length * 0.6));
    let peak = 0;
    for (let i = 1; i < limit; i += 1) if (histogram.y[i] > histogram.y[peak]) peak = i;
    const alpha1 = Math.max(histogram.binWidth, histogram.x[peak]);
    samples.push({
      sampleId: file.name,
      timeMinutes: file.time_minutes,
      histogram: CLOCCS.histogramFromEdgesCounts(histogram.edges, histogram.y),
      fluorescenceInit: { alpha1, alpha2: alpha1, tau: Math.max(histogram.binWidth, 0.05 * alpha1) },
    });
    binCounts.push(binCount);
  }
  const series = {
    strain: input.series_id,
    samples,
    uniqueTimepoints: samples.map(sample => sample.timeMinutes),
  };
  const fit = await CLOCCS.fitCloccsForStrainAsync(series, {
    starts: 3,
    coordinateRounds: 6,
    biologicalMaxIterations: 200,
    sampleMaxIterations: 100,
  });
  return {
    theta: fit.theta,
    timepointResults: fit.timepointResults,
    diagnostics: fit.diagnostics,
    binCounts,
  };
}"""


def discover_series():
    if not DATA_DIR.is_dir():
        raise SystemExit(f"Dataset directory not found: {DATA_DIR}")
    groups = {}
    unmatched = []
    for path in sorted(DATA_DIR.iterdir()):
        if not path.is_file():
            continue
        m = FILENAME_RE.match(path.name)
        if not m:
            unmatched.append(path.name)
            continue
        strain, minutes, _well = m.groups()
        groups.setdefault(strain, []).append((int(minutes), path))
    if unmatched:
        raise SystemExit(f"Unmatched filenames, refusing to guess: {unmatched}")
    series = []
    for strain in sorted(groups):
        items = sorted(groups[strain])
        series.append({
            "series_id": strain,
            "files": [
                {
                    "url": "/test_flow_data/" + DATA_DIR.name + "/" + path.name,
                    "name": path.name,
                    "time_minutes": minutes,
                }
                for minutes, path in items
            ],
        })
    return series


def parse_args():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--strains", help="comma-separated strain ids to run; default all 9")
    p.add_argument("--headed", action="store_true")
    p.add_argument("--report", default=str(HERE / "alphafactor_cloccs_report.json"))
    return p.parse_args()


def main():
    args = parse_args()
    all_series = discover_series()
    if args.strains:
        wanted = set(args.strains.split(","))
        all_series = [s for s in all_series if s["series_id"] in wanted]
    if not all_series:
        raise SystemExit("No matching series to run.")

    total_files = sum(len(s["files"]) for s in all_series)
    print(f"Serving {SERVE_ROOT} (loopback only) for this run.")
    print(f"Series: {[s['series_id'] for s in all_series]}, total files: {total_files}")

    port, server = start_test_server(SERVE_ROOT)
    url = f"http://127.0.0.1:{port}/PhaseFinder/index.html"
    results = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=not args.headed)
            page = browser.new_page(viewport={"width": 1200, "height": 900})
            page.goto(url, wait_until="domcontentloaded")
            for i, record in enumerate(all_series, 1):
                started = time.time()
                print(f"[{i}/{len(all_series)}] CLOCCS fit: {record['series_id']} "
                      f"({len(record['files'])} files)...", flush=True)
                try:
                    result = page.evaluate(_CLOCCS_VALIDATION, {
                        "series_id": record["series_id"],
                        "channel": DNA_CHANNEL,
                        "files": record["files"],
                    })
                    status = "CONVERGED" if result["diagnostics"].get("converged") else "NOT CONVERGED"
                    entry = {"series_id": record["series_id"], "status": status,
                             "n_files": len(record["files"]), **result}
                except Exception as error:  # noqa: BLE001
                    entry = {"series_id": record["series_id"], "status": "ERROR",
                             "n_files": len(record["files"]), "error": str(error)}
                elapsed = time.time() - started
                entry["elapsed_seconds"] = round(elapsed, 1)
                print(f"    -> {entry['status']} in {elapsed:.1f}s", flush=True)
                results.append(entry)
            browser.close()
    finally:
        server.shutdown()

    Path(args.report).write_text(json.dumps(results, indent=2, default=str))
    print(f"Wrote {args.report}")


if __name__ == "__main__":
    main()
