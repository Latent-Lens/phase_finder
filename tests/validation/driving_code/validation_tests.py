#!/usr/bin/env python3
"""Browser validation of PhaseFinder against synthetic and published FCS data.

This is deliberately separate from drive_flow.py: it produces scientific
comparison evidence, not E2E/unit regression results.  Every run starts from
the app's Reset Session button and every image is embedded in one HTML file.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import html
import json
import os
import sys
import time
from datetime import datetime
from decimal import Decimal
from pathlib import Path

from playwright.sync_api import sync_playwright


HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
E2E_HELPERS = REPO_ROOT / "tests" / "e2e" / "driving_code"
sys.path.insert(0, str(E2E_HELPERS))

from helpers import (  # noqa: E402
    click_plot_events,
    confirm_time_qc_method,
    dismiss_metadata_wizard_if_open,
    enter_modeling_mode,
    select_channel,
    set_files_via_file_browser,
    wait_for_overlay_hidden,
    wait_for_render,
    wait_for_rows,
)
from test_server import start_test_server  # noqa: E402


SYNTHETIC_ROOT = REPO_ROOT / "tests" / "validation" / "validation_test_data" / "synthetic_fcs"
EXTERNAL_ROOT = REPO_ROOT / "tests" / "validation" / "validation_test_data" / "external_fcs"
RESULTS_ROOT = REPO_ROOT / "tests"

MODELS = {
    "dean_jett": "Dean–Jett",
    "dean_jett_fox": "Dean–Jett–Fox",
    "watson_pragmatic": "Watson Pragmatic",
}
QC_RUNS = [
    ("Structural QC", ("qc_structural",), None),
    ("Time QC — Robust summary", ("qc_time",), "robust-summary"),
    ("Time QC — Peak-tracking", ("qc_time",), "peak-tracking"),
    ("Cell Gate QC", ("qc_cellgate",), None),
    ("Singlet QC", ("qc_singlet",), None),
    ("All QC — Robust summary Time QC", ("qc_structural", "qc_time", "qc_cellgate", "qc_singlet"), "robust-summary"),
    ("All QC — Peak-tracking Time QC", ("qc_structural", "qc_time", "qc_cellgate", "qc_singlet"), "peak-tracking"),
]
BOUNDARIES = (
    ("Left G1 position", "g1", "left"),
    ("Left G2 position", "g2", "left"),
    ("Right G1 position", "g1", "right"),
    ("Right G2 position", "g2", "right"),
)


def _fractions(block):
    values = (block or {}).get("fractions")
    return dict(values) if values else None


def discover_synthetic():
    manifest = json.loads((SYNTHETIC_ROOT / "manifest.json").read_text())
    records = []
    for case in manifest["cases"]:
        analysis = case.get("analysis") or {}
        expectation = case.get("parser_expectation") or {}
        truth = case.get("truth") or {}
        category = case.get("category")
        tolerance = analysis.get("tolerance_percentage_points")
        if category == "known_phase_truth":
            comparison_rule = f"Match planted truth for recovery models (±{tolerance:.1f} percentage points)."
        elif category == "qc_adversarial":
            comparison_rule = (f'Diagnostic: deliberate QC artifact — {case["description"]} '
                               "An exact phase match is not required.")
        elif category == "scientific_adversarial":
            comparison_rule = "Diagnostic: contains a deliberate scientific/modeling challenge; an exact match is not required."
        else:
            comparison_rule = f'Parser test: expected {expectation.get("outcome", "LOAD_OK")}.'
        records.append({
            "kind": "Synthetic",
            "id": case["id"],
            "path": SYNTHETIC_ROOT / case["file"],
            "channel_candidates": [analysis.get("dna_channel"), "DNA-A"],
            "expected_regions": analysis.get("peak_regions"),
            "expected_baseline": _fractions(truth.get("all_biological")),
            "expected_qc": _fractions(truth.get("after_oracle_qc")),
            "import_outcome": expectation.get("outcome", "LOAD_OK"),
            "category": category,
            "tolerance_pp": tolerance,
            "expected_by_model": analysis.get("expected_by_model") or {},
            "comparison_rule": comparison_rule,
            # QC-adversarial fixtures deliberately opt out of the older model
            # benchmark, but they still contain planted phase truth and are
            # exactly the files this all-model/QC validation matrix must run.
            "model_capable": bool(truth and expectation.get("outcome") == "LOAD_OK"),
            "note": case.get("description", "Deterministic synthetic fixture."),
            "citation": "PhaseFinder deterministic synthetic validation corpus (manifest.json).",
        })
    return records


def discover_external():
    manifest = json.loads((EXTERNAL_ROOT / "manifest.json").read_text())
    records = []
    for fixture in manifest["fixtures"]:
        records.append({
            "kind": "External", "id": fixture["id"],
            "path": EXTERNAL_ROOT / fixture["path"],
            "channel_candidates": [], "expected_regions": None,
            "expected_baseline": None, "expected_qc": None,
            "import_outcome": "LOAD_OK", "model_capable": False,
            "note": "Real parser fixture; no cell-cycle biological truth or suitable DNA-content endpoint is claimed.",
            "citation": fixture["upstream"]["repository_url"],
        })

    for dataset in manifest["published_datasets"]:
        paper = dataset.get("paper")
        if not paper:
            # Local-only comparison sets (e.g. flowjo_async_djf) carry no paper
            # citation and are handled separately by discover_flowjo_watson().
            continue
        citation = f'{paper["citation"]} https://doi.org/{paper["doi"]}'
        refs = dataset.get("reference_results", [])
        for artifact in dataset["artifacts"]:
            if artifact.get("kind") != "fcs":
                continue
            name = Path(artifact["path"]).name
            expected = None
            note = dataset["interpretation"].get("note", "")
            if name == "kasumi1_edu_fucci.fcs":
                ref = next(r for r in refs if r.get("source") == "Figure 4A")
                expected = {"g1": ref["g1_percent"] / 100, "s": ref["s_percent"] / 100,
                            "g2": ref["g2_m_percent"] / 100}
                note = ("Published values are manual EdU-versus-DAPI gates, not cell-cycle model fits; "
                        "PhaseFinder values are expected to differ. Values do not include the published "
                        f'{ref["unclassified_percent"]}% unclassified population.')
            elif name == "mda_mb_231_edu_fucci.fcs":
                ref = next(r for r in refs if r.get("source") == "Figure 4—figure supplement 1A")
                expected = {"g1": ref["g1_percent"] / 100, "s": ref["s_percent"] / 100,
                            "g2": ref["g2_m_percent"] / 100}
                note = ("Published values are manual EdU-versus-DAPI gates, not cell-cycle model fits; "
                        "PhaseFinder values are expected to differ. Values do not include the published "
                        f'{ref["unclassified_percent"]}% unclassified population.')
            elif dataset["id"] == "amouzgar_2025_mass_cytometry":
                note += " The published percentages aggregate all samples and are not truth for this donor file."

            required = (artifact.get("format") or {}).get("required_markers", [])
            records.append({
                "kind": "External", "id": f'{dataset["id"]}:{name}',
                "path": EXTERNAL_ROOT / artifact["path"],
                "channel_candidates": [x for x in ("DAPI", "DNA1", "DNA2") if x in required],
                "expected_regions": None,
                "expected_baseline": expected, "expected_qc": expected,
                "import_outcome": "LOAD_OK", "model_capable": bool(required),
                "note": note, "citation": citation,
            })
    return records


def discover_cloccs_series():
    manifest = json.loads((EXTERNAL_ROOT / "manifest.json").read_text())
    dataset = next(d for d in manifest["published_datasets"] if d["id"] == "li_2026_cloccs")
    references = {item["series_id"]: item for item in dataset["reference_results"]}
    citation = f'{dataset["paper"]["citation"]} https://doi.org/{dataset["paper"]["doi"]}'
    return [{
        "kind": "External",
        "id": f'{dataset["id"]}:{series["id"]}',
        "series_id": series["id"],
        "files": [{**item, "path": EXTERNAL_ROOT / item["path"]} for item in series["files"]],
        "channel": dataset["format"]["dna_channel"],
        "reference": references[series["id"]],
        "note": dataset["interpretation"]["note"],
        "citation": citation,
    } for series in dataset["series"]]


def choose_channel(page, candidates):
    options = page.eval_on_selector_all(
        "#channel_select option", "els => els.map(e => ({value:e.value, text:e.textContent.trim()})).filter(x => x.value)"
    )
    for wanted in filter(None, candidates):
        for option in options:
            if wanted.casefold() in (option["value"].casefold(), option["text"].casefold()):
                return option["value"]
    dna = [o for o in options if any(token in (o["value"] + " " + o["text"]).casefold()
                                      for token in ("dna", "dapi"))]
    if dna:
        return dna[0]["value"]
    raise RuntimeError("No DNA/DAPI channel is available")


def reset_session(page):
    for modal, close in (
        ("#structural_qc_modal", "#structural_qc_cancel"),
        ("#time_qc_method_modal", "#time_qc_method_cancel"),
        ("#djf_scatter_modal", "#djf_scatter_modal_close"),
    ):
        if page.locator(modal).is_visible():
            page.eval_on_selector(close, "el => el.click()")
            page.wait_for_selector(modal, state="hidden", timeout=10000)
    # A prior operation (e.g. a heavy fit) can leave the busy progress overlay up;
    # it intercepts the Reset click. Wait it out, then dispatch the click via JS so
    # a transient overlay cannot block it (matters when reusing one page across the
    # QC matrix's many sequential runs).
    wait_for_overlay_hidden(page, timeout_ms=120000)
    page.once("dialog", lambda dialog: dialog.accept())
    page.eval_on_selector("#reset_session_button", "el => el.click()")
    page.wait_for_selector("#file_table .empty_note", timeout=30000)


def use_recommended_bins(page):
    tick = page.locator("#plot_bins_ticks .plot_bins_tick_recommended")
    tick.wait_for(state="attached", timeout=10000)
    index = tick.get_attribute("data-index")
    bins = int(tick.inner_text())
    if page.input_value("#plot_bins") != index:
        page.eval_on_selector(
            "#plot_bins",
            "(slider, value) => { slider.value = value; slider.dispatchEvent(new Event('input', "
            "{ bubbles: true })); slider.dispatchEvent(new Event('change', { bubbles: true })); }",
            index,
        )
        wait_for_render(page)
        wait_for_overlay_hidden(page, timeout_ms=30000)
    return bins


def load_and_plot(page, record):
    reset_session(page)
    set_files_via_file_browser(page, "#drop_zone", [str(record["path"])])
    try:
        wait_for_rows(page, 1, timeout=15000)
    except Exception as error:
        status = page.locator("#status_bar").inner_text() if page.locator("#status_bar").count() else ""
        raise RuntimeError(f"FCS import did not produce a row: {status or error}") from error
    dismiss_metadata_wizard_if_open(page)
    channel = choose_channel(page, record["channel_candidates"])
    select_channel(page, channel)
    click_plot_events(page)
    sample_name = page.evaluate("() => window.PhaseFinder?.plot?.series?.[0]?.name")
    if not sample_name:
        raise RuntimeError("The plot did not expose an active sample")
    bins = use_recommended_bins(page)
    enter_modeling_mode(page)
    return sample_name, channel, bins


def apply_qc(page, qc_ids, time_method=None):
    for qc_id in qc_ids:
        selector = f"#{qc_id}"
        page.click(selector)
        if qc_id == "qc_structural":
            page.wait_for_selector("#structural_qc_modal", state="visible", timeout=10000)
            page.click("#structural_qc_apply")
            page.wait_for_selector("#structural_qc_modal", state="hidden", timeout=10000)
        elif qc_id == "qc_time":
            confirm_time_qc_method(page, time_method)
        page.wait_for_function("sel => !document.querySelector(sel)?.disabled", arg=selector, timeout=60000)
        wait_for_overlay_hidden(page, timeout_ms=60000)
        if page.locator("#djf_scatter_modal").is_visible():
            page.click("#djf_scatter_modal_close")
            page.wait_for_selector("#djf_scatter_modal", state="hidden", timeout=10000)


def waive_structural_qc(page, sample_name):
    """Record an on-the-record structural-QC waiver for a raw-data run.

    model_preflight fails closed: a required stage counts only when it applied
    cleanly or was deliberately waived, and a waiver counts only when it carries
    a reason. Validation model runs fit unfiltered events on purpose, so waive
    the stage rather than applying it, which would change what the "raw" view
    means. Without this the fit throws, no result is stored, and the caller's
    wait on activeResultKey never resolves.
    """
    page.evaluate(
        """name => {
          const state = window.PhaseFinder.pipeline.get_state(name);
          state.qcWaivers = { ...(state.qcWaivers ?? {}), structural: {
            reason: "Validation run fits raw events by design.",
            approvedAt: new Date().toISOString(),
          } };
        }""",
        sample_name,
    )


def image_data(page):
    page.wait_for_function(
        """() => [...document.querySelectorAll('[role="dialog"]')].every((modal) => {
          const style = getComputedStyle(modal);
          return modal.hidden || style.display === 'none' || style.visibility === 'hidden';
        })""",
        timeout=30000,
    )
    wait_for_overlay_hidden(page, timeout_ms=30000)
    raw = page.locator("#plot_area").screenshot(type="png")
    return "data:image/png;base64," + base64.b64encode(raw).decode("ascii")


def detect_peaks(page, sample_name):
    page.wait_for_function(
        "name => Boolean(window.PhaseFinder?.pipeline?.get_state?.(name)?.histogram)",
        arg=sample_name, timeout=30000,
    )
    page.click("#detect_peaks_button")
    page.wait_for_function(
        "name => Boolean(window.PhaseFinder.pipeline.get_state(name)?.modeling?.peakSelection?.regions)",
        arg=sample_name, timeout=60000,
    )
    state = page.evaluate(
        "name => window.PhaseFinder.pipeline.get_state(name).modeling.peakSelection", sample_name
    )
    regions = state["regions"]
    shot = image_data(page)
    page.click("#peak_regions_accept_button")
    page.wait_for_function(
        "name => window.PhaseFinder.pipeline.get_state(name)?.modeling?.peakSelection?.reviewed === true",
        arg=sample_name, timeout=10000,
    )
    return regions, shot, state.get("source"), state.get("confidence")


def fit_model(page, sample_name, model_id):
    page.select_option("#cell_cycle_model_select", model_id)
    page.wait_for_function("() => !document.querySelector('#cell_cycle_fit_current_button').disabled", timeout=10000)
    old_key = page.evaluate(
        "name => window.PhaseFinder.pipeline.get_state(name).modeling.activeResultKey", sample_name
    )
    page.click("#cell_cycle_fit_current_button")
    page.wait_for_function(
        "([name, oldKey]) => { const m=window.PhaseFinder.pipeline.get_state(name)?.modeling; "
        "return Boolean(m?.activeResultKey && m.activeResultKey !== oldKey && m.resultsByKey[m.activeResultKey]); }",
        arg=[sample_name, old_key], timeout=180000,
    )
    result = page.evaluate(
        "name => { const m=window.PhaseFinder.pipeline.get_state(name).modeling; "
        "return m.resultsByKey[m.activeResultKey]; }", sample_name,
    )
    wait_for_overlay_hidden(page, timeout_ms=10000)
    return result, image_data(page)


def failure_result(label, model_id=None, qc=(), error=""):
    return {"label": label, "model_id": model_id, "qc": list(qc), "status": "ERROR",
            "error": str(error), "regions": None, "fractions": None,
            "peak_image": None, "fit_image": None}


def one_run(page, record, label, model_id=None, qc=(), time_method=None):
    result = failure_result(label, model_id, qc)
    try:
        sample_name, channel, bins = load_and_plot(page, record)
        if qc:
            apply_qc(page, qc, time_method)
            bins = use_recommended_bins(page)
        if "qc_structural" not in qc:
            waive_structural_qc(page, sample_name)
        regions, peak_image, source, confidence = detect_peaks(page, sample_name)
        result.update({"status": "PASS", "error": "", "regions": regions,
                       "peak_image": peak_image, "channel": channel,
                       "bin_count": bins,
                       "peak_source": source, "peak_confidence": confidence})
        if model_id:
            fit, fit_image = fit_model(page, sample_name, model_id)
            result.update({"fractions": fit.get("phaseFractions"), "fit_image": fit_image,
                           "converged": fit.get("converged"), "warnings": fit.get("warnings", []),
                           "selected_model": (fit.get("modelComparison") or {}).get("selectedModelId")})
    except Exception as error:
        result["status"] = "ERROR"
        result["error"] = str(error)
    return result


def probe_import(page, record):
    result = failure_result("Import only")
    try:
        reset_session(page)
        set_files_via_file_browser(page, "#drop_zone", [str(record["path"])])
        expected_reject = record["import_outcome"] == "IMPORT_REJECT"
        try:
            wait_for_rows(page, 1, timeout=5000)
            loaded = True
        except Exception:
            loaded = False
        correct = not loaded if expected_reject else loaded
        if record["import_outcome"] == "ANALYSIS_BLOCK":
            note = (f'Expected LOAD_OK at import followed by ANALYSIS_BLOCK; observed '
                    f'{"LOAD_OK" if loaded else "IMPORT_REJECT"} at import.')
        else:
            note = f'Expected {record["import_outcome"]}; observed {"LOAD_OK" if loaded else "IMPORT_REJECT"}.'
        result.update({"status": "PASS" if correct else "ERROR", "error": "",
                       "import_loaded": loaded,
                       "note": note})
        if not correct:
            result["error"] = result["note"]
    except Exception as error:
        result["error"] = str(error)
    return result


def execute(page, records, selected_models, include_qc):
    for index, record in enumerate(records, 1):
        print(f'[{index}/{len(records)}] {record["kind"]}: {record["path"].name}', flush=True)
        if not record["model_capable"] or record["import_outcome"] != "LOAD_OK":
            record["runs"] = [probe_import(page, record)]
            continue
        runs = [one_run(page, record, "Auto-peak identification")]
        for model_id in selected_models:
            runs.append(one_run(page, record, MODELS[model_id], model_id))
        if include_qc and "dean_jett_fox" in selected_models:
            for qc_label, qc_ids, time_method in QC_RUNS:
                runs.append(one_run(page, record, f"Dean–Jett–Fox + {qc_label}", "dean_jett_fox", qc_ids, time_method))
        record["runs"] = runs


_CLOCCS_VALIDATION = r"""async input => {
  const [{ FCSParser }, { generateHistogram }, CLOCCS, bins] = await Promise.all([
    import('/js/fcs/parser.js'),
    import('/js/analysis/pipeline/dna_histogram.js'),
    import('/js/analysis/cell_cycle/models/cloccs.js'),
    import('/js/analysis/cell_cycle/bin_settings_sync.js'),
  ]);
  const samples = [];
  const binCounts = [];
  for (const file of input.files) {
    const response = await fetch(new URL(file.url, location.origin));
    if (!response.ok) throw new Error(`${file.url}: HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const summary = FCSParser.parse_fcs_header(buffer);
    const columnIndex = summary.columns.indexOf(input.channel);
    if (columnIndex < 0) throw new Error(`${file.url}: missing ${input.channel}`);
    const data = buffer.slice(summary.data_begin, summary.data_end + 1);
    const values = FCSParser.parse_selected_columns(data, summary.metadata, [columnIndex + 1])[columnIndex + 1];
    const binCount = bins.recommended_bin_count(values.length);
    const histogram = generateHistogram(values, null, { binCount, dnaChannel: input.channel });
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


def execute_cloccs(page, series_records):
    for index, record in enumerate(series_records, 1):
        print(f'[{index}/{len(series_records)}] External CLOCCS: {record["series_id"]}', flush=True)
        missing = [item["path"] for item in record["files"] if not item["path"].is_file()]
        if missing:
            record["result"] = {
                "status": "SKIPPED",
                "error": f'{len(missing)} local-only FCS files are absent; see the manifest and README for sources.',
            }
            continue
        bad = []
        for item in record["files"]:
            payload = item["path"].read_bytes()
            if len(payload) != item["byte_size"] or hashlib.sha256(payload).hexdigest() != item["sha256"]:
                bad.append(item["path"].name)
        if bad:
            record["result"] = {"status": "ERROR", "error": f'Integrity check failed: {", ".join(bad)}'}
            continue
        try:
            result = page.evaluate(_CLOCCS_VALIDATION, {
                "series_id": record["series_id"],
                "channel": record["channel"],
                "files": [{
                    "url": "/" + item["path"].relative_to(REPO_ROOT).as_posix(),
                    "name": item["path"].name,
                    "time_minutes": item["time_minutes"],
                } for item in record["files"]],
            })
            # The badge describes optimizer completion only; agreement is
            # reported parameter-by-parameter below.
            status = "CONVERGED" if result["diagnostics"].get("converged") else "NOT CONVERGED"
            record["result"] = {"status": status, "error": "", **result}
        except Exception as error:
            record["result"] = {"status": "ERROR", "error": str(error)}


def esc(value):
    return html.escape(str(value), quote=True)


def fmt_number(value, signed=False):
    if value is None:
        return "N/A"
    number = Decimal(str(value))
    if number == 0:
        number = Decimal(0)
    return f"{number:+,.1f}" if signed else f"{number:,.1f}"


def fmt_percent(value):
    return "N/A" if value is None else f"{100 * value:.1f}%"


def boundary(regions, phase, edge):
    try:
        return float(regions[phase][edge])
    except (TypeError, KeyError, ValueError):
        return None


def expected_for(record, run):
    return record["expected_qc"] if run.get("qc") else record["expected_baseline"]


def difference_cell(ours, theirs, percent=False):
    if ours is None or theirs is None:
        return "N/A"
    difference = ours - theirs
    if percent:
        pp = difference * 100
        return f"{pp:+.1f} pp ({pp / 100:+.1f})"
    return fmt_number(difference, signed=True)


def sample_hover(record):
    parts = [record["note"]]
    rule = record.get("comparison_rule")
    if rule and rule != record["note"]:
        parts.append(rule)
    baseline = record.get("expected_baseline")
    if baseline:
        label = "Planted baseline" if record["kind"] == "Synthetic" else "Published reference"
        parts.append(f'{label}: G1 {fmt_percent(baseline.get("g1"))}, '
                     f'S {fmt_percent(baseline.get("s"))}, G2/M {fmt_percent(baseline.get("g2"))}.')
    after_qc = record.get("expected_qc")
    if after_qc and after_qc != baseline:
        parts.append(f'After intended QC: G1 {fmt_percent(after_qc.get("g1"))}, '
                     f'S {fmt_percent(after_qc.get("s"))}, G2/M {fmt_percent(after_qc.get("g2"))}.')
    return " ".join(parts)


def top_table(records):
    tested = [r for r in records if r.get("runs")]
    synthetic = [r for r in tested if r["kind"] == "Synthetic"]
    external = [r for r in tested if r["kind"] == "External"]
    ordered = synthetic + external
    rows = []
    filter_groups = []

    def add(group, metric, values, rowspan=1, show_group=True, filter_group=None, row_class=None):
        if filter_group and filter_group not in filter_groups:
            filter_groups.append(filter_group)
        group_cell = (f'<th class="group" rowspan="{rowspan}">{esc(group)}</th>'
                      if show_group else "")
        row_attr = f' data-result-group="{esc(filter_group)}"' if filter_group is not None else ""
        class_attr = f' class="{esc(row_class)}"' if row_class else ""
        rows.append(f'<tr{class_attr}{row_attr}>{group_cell}<th>{esc(metric)}</th>' +
                    "".join(
                        (f'<td class="expected-success" title="Expected N/A: PhaseFinder correctly '
                         f'rejected this malformed FCS file.">{esc(value)}</td>')
                        if value == "N/A" and record["import_outcome"] == "IMPORT_REJECT"
                        and record.get("runs") and record["runs"][0]["status"] == "PASS"
                        else f"<td>{esc(value)}</td>"
                        for record, value in zip(ordered, values)
                    ) + "</tr>")

    add("Fixture interpretation", "Comparison rule",
        [r.get("comparison_rule", r["note"]) for r in ordered], row_class="fixture-interpretation")

    for group, value_kind in (("Auto-peak identify (ours)", "ours"),
                              ("Auto-peak identify (theirs)", "theirs"),
                              ("Auto-peak identify (differential)", "difference")):
        for index, (metric, phase, edge) in enumerate(BOUNDARIES):
            ours = [boundary((r.get("runs") or [{}])[0].get("regions"), phase, edge) for r in ordered]
            theirs = [boundary(r.get("expected_regions"), phase, edge) for r in ordered]
            if value_kind == "ours":
                values = [fmt_number(x) for x in ours]
            elif value_kind == "theirs":
                values = [fmt_number(x) for x in theirs]
            else:
                values = [difference_cell(a, b) for a, b in zip(ours, theirs)]
            add(group, metric, values, rowspan=len(BOUNDARIES), show_group=index == 0,
                filter_group="Auto-peak identification")

    run_labels = []
    for record in ordered:
        for run in record.get("runs", []):
            if run.get("model_id") and run["label"] not in run_labels:
                run_labels.append(run["label"])
    for label in run_labels:
        phase_rows = (("g1", "G1%"), ("s", "S%"), ("g2", "G2/M%"))
        values_by_phase = {}
        for phase, _phase_label in phase_rows:
            ours, theirs = [], []
            for record in ordered:
                run = next((x for x in record.get("runs", []) if x["label"] == label), None)
                ours.append((run.get("fractions") or {}).get(phase) if run else None)
                theirs.append((expected_for(record, run) or {}).get(phase) if run else None)
            values_by_phase[phase] = (ours, theirs)
        for group_prefix, value_kind in (("Our cell-cycle percentages", "ours"),
                                         ("Their cell-cycle percentages", "theirs"),
                                         ("Differential cell-cycle percentages", "difference")):
            for index, (phase, phase_label) in enumerate(phase_rows):
                ours, theirs = values_by_phase[phase]
                if value_kind == "ours":
                    values = [fmt_percent(x) for x in ours]
                elif value_kind == "theirs":
                    values = [fmt_percent(x) for x in theirs]
                else:
                    values = [difference_cell(a, b, percent=True) for a, b in zip(ours, theirs)]
                add(f"{group_prefix} — {label}", phase_label, values,
                    rowspan=len(phase_rows), show_group=index == 0, filter_group=label)

    options = '<option value="">All result groups</option>' + "".join(
        f'<option value="{esc(group)}">{esc(group)}</option>' for group in filter_groups
    )
    first = (f'<tr><th rowspan="2"><label for="result-group-filter">Result group</label><br>'
             f'<select id="result-group-filter">{options}</select></th><th rowspan="2">Metric</th>')
    if synthetic:
        first += f'<th class="sample-group synthetic" colspan="{len(synthetic)}">Synthetic</th>'
    if external:
        first += f'<th class="sample-group external" colspan="{len(external)}">External</th>'
    first += "</tr>"
    second = "<tr>" + "".join(
        f'<th class="filename {r["kind"].lower()}" tabindex="0" title="{esc(sample_hover(r))}" '
        f'aria-label="{esc(r["path"].name)}. {esc(sample_hover(r))}">{esc(r["path"].name)}</th>'
        for r in ordered
    ) + "</tr>"
    return '<div class="table-wrap"><table id="comparison-table"><thead>' + first + second + '</thead><tbody>' + "".join(rows) + '</tbody></table></div>'


def expected_card(record, run):
    regions = record.get("expected_regions")
    fractions = expected_for(record, run)
    parts = ["<h4>Expected / published</h4>"]
    if regions:
        parts.append("<dl>" + "".join(
            f"<dt>{esc(label)}</dt><dd>{fmt_number(boundary(regions, phase, edge))}</dd>"
            for label, phase, edge in BOUNDARIES) + "</dl>")
    else:
        parts.append("<p>Peak boundaries: N/A — the source does not report PhaseFinder-style regions.</p>")
    if fractions and run.get("model_id"):
        parts.append("<dl>" + "".join(
            f"<dt>{label}</dt><dd>{fmt_percent(fractions.get(phase))}</dd>"
            for phase, label in (("g1", "G1"), ("s", "S"), ("g2", "G2/M"))) + "</dl>")
    elif run.get("model_id"):
        parts.append("<p>Cell-cycle percentages: N/A — no specimen-specific published truth.</p>")
    return "".join(parts)


def fixture_interpretation(record, run):
    rule = record.get("comparison_rule")
    parts = [rule] if rule and record["note"] in rule else [record["note"]]
    if rule and rule != record["note"] and rule not in parts:
        parts.append(rule)
    model_expectation = (record.get("expected_by_model", {}).get(run.get("model_id")) or {}).get("kind")
    if model_expectation == "recovery":
        parts.append(f'This model is a recovery check with ±{record["tolerance_pp"]:.1f} percentage-point tolerance.')
    elif model_expectation == "diagnostic":
        parts.append("This model comparison is diagnostic; an exact match is not required.")
    return " ".join(dict.fromkeys(parts))


def observed_card(run):
    parts = [f'<h4>PhaseFinder <span class="status {run["status"].lower()}">{esc(run["status"])}</span></h4>']
    if run.get("bin_count"):
        parts.append(f'<p>Histogram bins: {esc(run["bin_count"])} (recommended for retained events).</p>')
    if run.get("error"):
        parts.append(f'<p class="error">{esc(run["error"])}</p>')
    if run.get("note"):
        parts.append(f'<p>{esc(run["note"])}</p>')
    if run.get("regions"):
        parts.append("<dl>" + "".join(
            f"<dt>{esc(label)}</dt><dd>{fmt_number(boundary(run['regions'], phase, edge))}</dd>"
            for label, phase, edge in BOUNDARIES) + "</dl>")
    if run.get("fractions"):
        parts.append("<dl>" + "".join(
            f"<dt>{label}</dt><dd>{fmt_percent(run['fractions'].get(phase))}</dd>"
            for phase, label in (("g1", "G1"), ("s", "S"), ("g2", "G2/M"))) + "</dl>")
        parts.append(f'<p>Converged: {esc(run.get("converged"))}. Warnings: {esc(len(run.get("warnings", [])))}</p>')
    return "".join(parts)


def cloccs_report_html(series_records):
    sections = []
    for record in series_records:
        result = record.get("result") or {"status": "SKIPPED", "error": "Not run."}
        status = result["status"]
        if status in ("ERROR", "SKIPPED"):
            body = f'<p class="error">{esc(result.get("error", "Not run."))}</p>'
        else:
            theta = result["theta"]
            reference = record["reference"]
            theirs = reference["parameters"]
            ours = {
                "Recovery delay (min)": theta["mu0"],
                "S-phase entry (min)": theta["mu0"] + theta["gamma1"] * theta["lambda"],
                "Cycle length λ (min)": theta["lambda"],
                "Daughter delay δ (min)": theta["delta"],
                "Initial spread σ0 (min)": theta["sigma0"],
                "Velocity spread σV": theta["sigmaV"],
                "S start γ1 (% cycle)": 100 * theta["gamma1"],
                "S end γ2 (% cycle)": 100 * theta["gamma2"],
                "Halted cells (%)": None,
            }
            published = {
                "Recovery delay (min)": -theirs["mu0"],
                "S-phase entry (min)": reference["s_phase_entry_minutes_reported_in_paper"],
                "Cycle length λ (min)": theirs["lambda"],
                "Daughter delay δ (min)": theirs["delta"],
                "Initial spread σ0 (min)": theirs["sigma0"],
                "Velocity spread σV": theirs["sigmaV"],
                "S start γ1 (% cycle)": 100 * theirs["gamma1"],
                "S end γ2 (% cycle)": 100 * theirs["gamma2"],
                "Halted cells (%)": 100 * theirs["halted"],
            }
            parameter_rows = "".join(
                f'<tr><th>{esc(metric)}</th><td>{fmt_number(ours[metric])}</td>'
                f'<td>{fmt_number(published[metric])}</td>'
                f'<td>{difference_cell(ours[metric], published[metric])}</td></tr>'
                for metric in ours
            )
            phase_rows = "".join(
                f'<tr><td>{fmt_number(item["timeMinutes"])}</td>'
                f'<td>{fmt_percent(item["phaseFractions"].get("g1"))}</td>'
                f'<td>{fmt_percent(item["phaseFractions"].get("s"))}</td>'
                f'<td>{fmt_percent(item["phaseFractions"].get("g2"))}</td></tr>'
                for item in result["timepointResults"]
            )
            bins = sorted(set(result["binCounts"]))
            body = (
                f'<p>All {len(record["files"])} FCS files passed size/SHA-256 checks and were parsed through '
                f'PhaseFinder using <strong>{esc(", ".join(map(str, bins)))}</strong> recommended histogram bins.</p>'
                f'<p>Optimizer converged: <strong>{esc(result["diagnostics"].get("converged"))}</strong>; '
                f'{esc(result["diagnostics"].get("starts"))} starts. PASS/WARN describes execution and '
                'convergence, not agreement with the published parameter values.</p>'
                '<table><thead><tr><th>Parameter</th><th>PhaseFinder</th><th>Published CLOCCS</th>'
                f'<th>Difference</th></tr></thead><tbody>{parameter_rows}</tbody></table>'
                '<p class="note">The published repository does not archive numeric phase percentages per timepoint; '
                'the table below records PhaseFinder’s fitted trajectory without inventing a reference differential.</p>'
                '<table><thead><tr><th>Time (min)</th><th>G1</th><th>S</th><th>G2/M</th>'
                f'</tr></thead><tbody>{phase_rows}</tbody></table>'
            )
        sections.append(
            f'<details class="file-results" open><summary><h2>External CLOCCS: {esc(record["series_id"])}</h2>'
            f'</summary><p><strong>Status:</strong> <span class="status {status.lower()}">{esc(status)}</span></p>'
            f'<p><strong>Fixture interpretation:</strong> {esc(record["note"])}</p>'
            f'<p><strong>Citation:</strong> {esc(record["citation"])}</p>{body}</details>'
        )
    return "".join(sections)


def report_html(records, cloccs_series, started, port):
    sections = []
    for record in records:
        runs = []
        for run in record.get("runs", []):
            images = []
            if run.get("peak_image"):
                images.append(f'<figure><img src="{run["peak_image"]}" alt="Auto-detected G1 and G2 peak regions"><figcaption>Auto-detected peak density curve before modeling</figcaption></figure>')
            if run.get("fit_image"):
                images.append(f'<figure><img src="{run["fit_image"]}" alt="Fitted G1, S, and G2 model components"><figcaption>Fitted G1, S, and G2/M components</figcaption></figure>')
            runs.append(
                f'<h3>{esc(run["label"])}</h3>'
                f'<p class="fixture-run-interpretation"><strong>Fixture interpretation:</strong> '
                f'{esc(fixture_interpretation(record, run))}</p>'
                f'<div class="comparison"><section>{observed_card(run)}</section>'
                f'<section>{expected_card(record, run)}</section></div>' + "".join(images) + "<hr>"
            )
        sections.append(
            f'<details class="file-results" open><summary><h2>{record["kind"]}: '
            f'{esc(record["path"].name)}</h2></summary><p><strong>Citation:</strong> '
            f'{esc(record["citation"])}</p>' + "".join(runs) + "</details>"
        )

    failures = (sum(run["status"] == "ERROR" for record in records for run in record.get("runs", []))
                + sum(record.get("result", {}).get("status") == "ERROR" for record in cloccs_series))
    file_count = len(records) + sum(len(record["files"]) for record in cloccs_series)
    return f'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PhaseFinder FCS validation</title><style>
:root{{--logo_teal:#01a5af;--logo_blue:#072c67;--focus_success:rgba(5,150,105,.28)}}body{{font:15px/1.45 system-ui,sans-serif;color:#17212b;margin:2rem;background:#f7f9fb}}main{{max-width:1500px;margin:auto;background:white;padding:2rem;border-radius:12px}}h2{{margin-top:4rem;border-bottom:3px solid #294d69;padding-bottom:.4rem}}h3{{margin-top:2rem}}h4{{margin-top:0}}.summary{{background:#eef5fa;padding:1rem;border-radius:8px}}.table-wrap{{overflow:auto;max-height:75vh;border:1px solid #ccd7df}}.table-wrap.filtered{{max-height:none}}table{{border-collapse:collapse;font-size:12px}}th,td{{border:1px solid #ccd7df;padding:.35rem .5rem;text-align:right;white-space:nowrap}}#comparison-table td{{width:1%;background:white;color:#17212b}}#comparison-table .sample-group.synthetic,#comparison-table th.filename.synthetic{{background:var(--logo_teal);color:#071b1d}}#comparison-table .sample-group.external,#comparison-table th.filename.external{{background:var(--logo_blue);color:white}}#comparison-table .sample-group{{text-align:left}}#comparison-table td.expected-success{{background:var(--focus_success)}}#comparison-table .fixture-interpretation td{{white-space:normal;min-width:5.5rem;max-width:7rem;text-align:left;overflow-wrap:anywhere}}thead th{{position:sticky;top:0;background:#294d69;color:white;z-index:2}}thead select{{font:inherit;max-width:210px}}th.group{{text-align:left;background:#eaf0f4;position:sticky;left:0;z-index:1;white-space:normal;max-width:170px}}th.filename{{writing-mode:vertical-rl;max-height:220px}}.comparison{{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}}.comparison section{{border:1px solid #ccd7df;padding:1rem;border-radius:8px;background:#fbfcfd}}dl{{display:grid;grid-template-columns:1fr auto;gap:.25rem 1rem}}dt,dd{{margin:0}}img{{max-width:100%;height:auto;border:1px solid #ccd7df}}figure{{margin:1rem 0}}figcaption{{color:#52616d}}hr{{border:0;border-top:2px solid #d7e0e6;margin:2.5rem 0}}.status{{font-size:.75em;padding:.15rem .4rem;border-radius:4px}}.pass,.converged{{background:#d8f3df}}.error{{background:#ffe2e2;color:#842029;padding:.5rem}}p.error{{background:#ffe2e2}}.note{{color:#52616d}}.file-results{{margin-top:4rem}}.file-results>summary{{cursor:pointer}}.file-results>summary h2{{display:inline-block;margin:0;width:calc(100% - 2rem)}}.fixture-run-interpretation{{background:#eef5fa;border-left:4px solid var(--logo_teal);padding:.65rem .8rem}}@media(max-width:800px){{.comparison{{grid-template-columns:1fr}}}}
</style></head><body><main><h1>PhaseFinder synthetic and external FCS validation</h1>
<div class="summary"><p>Started {esc(started)}; local app server port {port}. Files: {file_count}. Recorded errors: {failures}.</p><p>Each ordinary run reset the session, reloaded one FCS, plotted its DNA channel, and independently detected peaks. Model runs then fit the selected model. QC runs applied the stated pre-filter(s) before peak detection and Dean–Jett–Fox fitting. CLOCCS validation jointly fits all 16 timepoints in each replicate. “pp” is percentage points; the parenthesized differential is pp ÷ 100, as requested.</p></div>
{f'<h2>Cross-file comparison</h2>{top_table(records)}' if records else ''}{cloccs_report_html(cloccs_series)}{''.join(sections)}</main><script>
document.getElementById("result-group-filter")?.addEventListener("change", event => {{
  document.querySelector(".table-wrap").classList.toggle("filtered", Boolean(event.target.value));
  document.querySelectorAll("#comparison-table tbody tr[data-result-group]").forEach(row => {{
    row.hidden = Boolean(event.target.value && row.dataset.resultGroup !== event.target.value);
  }});
}});
</script></body></html>'''


# ---------------------------------------------------------------------------
# FlowJo DJF (30) + Flowreader Watson (15) external comparison (VALID-01).
# Special/private local-only dataset: the FCS live outside the served repo root
# and the compiled reference VALUES are gitignored, so this discovers from the
# local reference JSON, loads each FCS through the file browser (fetch can't
# reach files outside REPO_ROOT), fits PhaseFinder's DJF (all 30) and Watson
# Classic (the 15 with a Watson reference), and scores each against the
# manifest's predefined acceptance tolerances. Output is written into the
# gitignored dataset directory so no reference value ever reaches git.
# ---------------------------------------------------------------------------

def discover_flowjo_watson():
    manifest = json.loads((EXTERNAL_ROOT / "manifest.json").read_text())
    dataset = next((d for d in manifest["published_datasets"] if d["id"] == "flowjo_async_djf"), None)
    if not dataset:
        return None
    local = dataset["local_data"]
    ref_path = EXTERNAL_ROOT / local["reference_json"]
    if not ref_path.is_file():
        return None  # local-only: the reference JSON is gitignored; regenerate it first
    reference = json.loads(ref_path.read_text())
    fcs_dir = (REPO_ROOT / local["repo_root_relative_fcs_directory"]).resolve()
    fmt = dataset["format"]
    records = []
    for sample in reference["samples"]:
        fcs = sample.get("fcs")
        if not fcs:
            continue
        records.append({
            "strain": sample["strain"],
            "path": fcs_dir / fcs["filename"],
            "channel_candidates": [fmt["dna_channel_pns"], fmt["dna_channel_pnn"], "DNA-A"],
            "references": sample["references"],
        })
    return {"records": records, "tolerances": dataset["acceptance_tolerances"], "format": fmt}


# PhaseFinder's full pre-model QC: Structural, Time QC, Cell Gate, Singlet Gate.
# Applied before fitting so PhaseFinder starts from a gated population comparable
# to the debris/singlet/live-cell gating FlowJo and Flowreader applied before
# their own DJF/Watson fits -- otherwise a raw-vs-gated comparison is unfair.
FLOWJO_QC_IDS = ("qc_structural", "qc_time", "qc_cellgate", "qc_singlet")
FLOWJO_TIME_METHOD = "robust-summary"

# The full pre-model QC matrix, mirroring QC_RUNS: fit with no QC, then each gate
# alone (Time QC with both of its methods), up to all four gates (again with both
# Time-QC methods). Every configuration is fit and compared to the reference, so
# we can see which gating PhaseFinder needs to best match FlowJo/Flowreader.
FLOWJO_QC_MATRIX = (
    ("No QC", (), None),
    ("Structural", ("qc_structural",), None),
    ("Time QC — robust-summary", ("qc_time",), "robust-summary"),
    ("Time QC — peak-tracking", ("qc_time",), "peak-tracking"),
    ("Cell Gate", ("qc_cellgate",), None),
    ("Singlet", ("qc_singlet",), None),
    ("All QC — robust-summary", ("qc_structural", "qc_time", "qc_cellgate", "qc_singlet"), "robust-summary"),
    ("All QC — peak-tracking", ("qc_structural", "qc_time", "qc_cellgate", "qc_singlet"), "peak-tracking"),
)


def apply_qc_flowjo(page, qc_ids, time_method):
    # Robust variant of apply_qc() for the heavy real FCS: waits for any overlay
    # to clear BEFORE each click (companion-channel loading of 460k-event files
    # leaves a full-viewport progress overlay that intercepts pointer events) and
    # dispatches clicks via JS so a transient overlay can't block the click. Also
    # dismisses the scatter inspector, which a review-required Cell Gate (QC-05)
    # can open. Longer timeouts than apply_qc() for the same reason.
    for qc_id in qc_ids:
        wait_for_overlay_hidden(page, timeout_ms=120000)
        page.eval_on_selector(f"#{qc_id}", "el => el.click()")
        if qc_id == "qc_structural":
            page.wait_for_selector("#structural_qc_modal", state="visible", timeout=15000)
            page.eval_on_selector("#structural_qc_apply", "el => el.click()")
            page.wait_for_selector("#structural_qc_modal", state="hidden", timeout=15000)
        elif qc_id == "qc_time":
            confirm_time_qc_method(page, time_method)
        page.wait_for_function("sel => !document.querySelector(sel)?.disabled", arg=f"#{qc_id}", timeout=120000)
        wait_for_overlay_hidden(page, timeout_ms=120000)
        if page.locator("#djf_scatter_modal").is_visible():
            page.eval_on_selector("#djf_scatter_modal_close", "el => el.click()")
            page.wait_for_selector("#djf_scatter_modal", state="hidden", timeout=15000)


def detect_peaks_flowjo(page, sample_name):
    # Overlay-robust peak detect+accept for the heavy real FCS (JS-dispatch clicks
    # + overlay waits; no screenshots, which the comparison does not need).
    page.wait_for_function(
        "name => Boolean(window.PhaseFinder?.pipeline?.get_state?.(name)?.histogram)",
        arg=sample_name, timeout=60000)
    wait_for_overlay_hidden(page, timeout_ms=120000)
    page.eval_on_selector("#detect_peaks_button", "el => el.click()")
    page.wait_for_function(
        "name => Boolean(window.PhaseFinder.pipeline.get_state(name)?.modeling?.peakSelection?.regions)",
        arg=sample_name, timeout=120000)
    regions = page.evaluate(
        "name => window.PhaseFinder.pipeline.get_state(name).modeling.peakSelection.regions", sample_name)
    wait_for_overlay_hidden(page, timeout_ms=60000)
    page.eval_on_selector("#peak_regions_accept_button", "el => el.click()")
    page.wait_for_function(
        "name => window.PhaseFinder.pipeline.get_state(name)?.modeling?.peakSelection?.reviewed === true",
        arg=sample_name, timeout=30000)
    return regions


def fit_model_flowjo(page, sample_name, model_id):
    # Overlay-robust model fit for the heavy real FCS. A review-required Cell/
    # Singlet gate (QC-05/QC-06) makes the required-QC preflight pop a confirm()
    # asking to proceed with a degraded analysis; auto-accept it (scoped to the
    # fit so it never collides with reset_session's own dialog handler) so the
    # fit runs anyway -- for validation we deliberately fit and compare even when
    # PhaseFinder flags the gate as degraded.
    #
    # A fit that PhaseFinder judges not-valid-for-reporting (e.g. a boundary-
    # degenerate peak, contract fix #2) becomes a DIAGNOSTIC PREVIEW with
    # activeResultKey=null, so we wait for ANY new result key (active or
    # diagnostic) and read it, recording validForReporting/limitedReliability
    # rather than treating an unauthoritative fit as authoritative.
    page.select_option("#cell_cycle_model_select", model_id)
    page.wait_for_function("() => !document.querySelector('#cell_cycle_fit_current_button').disabled", timeout=15000)
    old_keys = page.evaluate(
        "name => Object.keys(window.PhaseFinder.pipeline.get_state(name).modeling.resultsByKey)", sample_name)
    wait_for_overlay_hidden(page, timeout_ms=60000)
    accept = lambda dialog: dialog.accept()
    page.on("dialog", accept)
    try:
        page.eval_on_selector("#cell_cycle_fit_current_button", "el => el.click()")
        page.wait_for_function(
            "([name, oldKeys]) => { const m=window.PhaseFinder.pipeline.get_state(name)?.modeling; "
            "return Boolean(m && Object.keys(m.resultsByKey).some((k) => !oldKeys.includes(k))); }",
            arg=[sample_name, old_keys], timeout=180000)
    finally:
        page.remove_listener("dialog", accept)
    return page.evaluate(
        "([name, oldKeys]) => { const m=window.PhaseFinder.pipeline.get_state(name).modeling; "
        "const k = Object.keys(m.resultsByKey).find((x) => !oldKeys.includes(x)); return m.resultsByKey[k]; }",
        [sample_name, old_keys])


def run_flowjo_sample(page, record, qc_ids=FLOWJO_QC_IDS, time_method=FLOWJO_TIME_METHOD):
    out = {"strain": record["strain"], "status": "ERROR", "error": "", "models": {}}
    if not record["path"].is_file():
        out["error"] = "local-only FCS absent"
        out["status"] = "SKIPPED"
        return out
    try:
        sample_name, channel, bins = load_and_plot(page, record)
        if qc_ids:
            # Run the full pre-model QC gating, then re-take the recommended bins
            # since gating changes the retained-event histogram.
            apply_qc_flowjo(page, qc_ids, time_method)
            bins = use_recommended_bins(page)
        regions = detect_peaks_flowjo(page, sample_name)
        # The validation deliberately fits and compares on the gated population
        # under each QC config, regardless of whether PhaseFinder deems the QC
        # QUALITY sufficient to report. The gates for this config are already
        # applied (their masks are installed), so clearing the required-QC set only
        # removes the quality-based fit *block* -- which otherwise refuses:
        #   * the No-QC config (preflight defaults to requiring structural QC), and
        #   * any degraded-gate config (e.g. peak-tracking Time QC flags limited
        #     reliability, which approve_degraded_qc does not prompt to waive, so
        #     the preflight throws and no result is produced).
        # The fit's own validForReporting/limitedReliability still reflects FIT
        # quality, and the applied QC config is recorded in the report.
        page.evaluate(
            "name => { const s = window.PhaseFinder.pipeline.get_state(name); if (s) s.requiredQc = []; }",
            sample_name)
        out.update({"channel": channel, "bins": bins, "regions": regions,
                    "qc_applied": list(qc_ids), "time_method": time_method if qc_ids else None})
        model_ids = ["dean_jett_fox"]
        if record["references"].get("flowreader_watson"):
            model_ids.append("watson_classic")
        for model_id in model_ids:
            fit = fit_model_flowjo(page, sample_name, model_id)
            out["models"][model_id] = {
                "phaseFractions": fit.get("phaseFractions"),
                "parameters": fit.get("parameters"),
                "converged": fit.get("converged"),
                "validForReporting": fit.get("validForReporting"),
                "limitedReliability": fit.get("limitedReliability"),
            }
        out["status"] = "PASS"
    except Exception as error:
        out["error"] = str(error)
    return out


def _rel(ours, theirs):
    return abs(ours - theirs) / max(abs(theirs), 1e-9)


def score_djf(fitted, ref, tol):
    frac = fitted["phaseFractions"] or {}
    params = fitted["parameters"] or {}
    pp = tol["phase_fraction_abs_pp"]
    phases = {}
    for phase in ("g1", "s", "g2"):
        delta_pp = (frac.get(phase, float("nan")) - ref[f"{phase}_fraction"]) * 100
        phases[phase] = {"ours": frac.get(phase), "ref": ref[f"{phase}_fraction"],
                         "delta_pp": delta_pp, "pass": abs(delta_pp) <= pp[phase]}
    g1_mean_rel = _rel(params.get("g1Mean", float("nan")), ref["g1_mean"])
    g2_mean_rel = _rel(params.get("g2Mean", float("nan")), ref["g2_mean"])
    ratio = params.get("g2Mean", float("nan")) / params.get("g1Mean", float("nan")) if params.get("g1Mean") else float("nan")
    ratio_delta = abs(ratio - ref["g2_g1_ratio"])
    checks = {
        "g1_mean": {"ours": params.get("g1Mean"), "ref": ref["g1_mean"], "rel": g1_mean_rel, "pass": g1_mean_rel <= tol["peak_mean_rel"]},
        "g2_mean": {"ours": params.get("g2Mean"), "ref": ref["g2_mean"], "rel": g2_mean_rel, "pass": g2_mean_rel <= tol["peak_mean_rel"]},
        "g2_g1_ratio": {"ours": ratio, "ref": ref["g2_g1_ratio"], "delta": ratio_delta, "pass": ratio_delta <= tol["g2_g1_ratio_abs"]},
    }
    all_pass = all(p["pass"] for p in phases.values()) and all(c["pass"] for c in checks.values())
    return {"model": "dean_jett_fox", "converged": fitted.get("converged"), "phases": phases, "checks": checks, "all_pass": all_pass}


def score_watson(fitted, ref, tol):
    frac = fitted["phaseFractions"] or {}
    pp = tol["phase_fraction_abs_pp"]
    phases = {}
    for phase in ("g1", "s", "g2"):
        delta_pp = (frac.get(phase, float("nan")) - ref[f"{phase}_fraction"]) * 100
        phases[phase] = {"ours": frac.get(phase), "ref": ref[f"{phase}_fraction"],
                         "delta_pp": delta_pp, "pass": abs(delta_pp) <= pp[phase]}
    # Directional expectation: PhaseFinder Watson Pragmatic-style S restriction
    # means our %S should sit at or below Flowreader's classic Watson %S.
    directional_ok = (frac.get("s", float("inf")) <= ref["s_fraction"] + 1e-6)
    all_pass = all(p["pass"] for p in phases.values())
    return {"model": "watson_classic", "converged": fitted.get("converged"), "phases": phases,
            "directional_s_ok": directional_ok, "all_pass": all_pass}


def score_run(run, record, tol):
    scored = {"status": run["status"], "error": run["error"],
              "qc_applied": run.get("qc_applied"), "time_method": run.get("time_method"),
              "converged": {}, "scores": {}}
    if run["status"] != "PASS":
        return scored
    djf = run["models"].get("dean_jett_fox")
    if djf:
        s = score_djf(djf, record["references"]["flowjo_djf"], tol["flowjo_djf"])
        s["validForReporting"] = djf.get("validForReporting")
        s["limitedReliability"] = djf.get("limitedReliability")
        scored["scores"]["dean_jett_fox"] = s
        scored["converged"]["dean_jett_fox"] = djf.get("converged")
    watson = run["models"].get("watson_classic")
    if watson and record["references"].get("flowreader_watson"):
        s = score_watson(watson, record["references"]["flowreader_watson"], tol["flowreader_watson"])
        s["validForReporting"] = watson.get("validForReporting")
        s["limitedReliability"] = watson.get("limitedReliability")
        scored["scores"]["watson_classic"] = s
        scored["converged"]["watson_classic"] = watson.get("converged")
    return scored


def execute_flowjo_watson(page, bundle, limit=None, qc_matrix=FLOWJO_QC_MATRIX):
    records = bundle["records"]
    if limit is not None:
        records = records[:limit]
    tol = bundle["tolerances"]
    results = []
    for index, record in enumerate(records, 1):
        sample = {"strain": record["strain"], "configs": []}
        for label, qc_ids, time_method in qc_matrix:
            print(f'[{index}/{len(records)}] {record["strain"]} — {label}', flush=True)
            run = run_flowjo_sample(page, record, qc_ids, time_method)
            scored = score_run(run, record, tol)
            scored["label"] = label
            sample["configs"].append(scored)
        results.append(sample)
    return results


def write_flowjo_watson_report(results, started):
    # Output lands in the gitignored dataset dir so no private reference value
    # reaches git.
    out_dir = EXTERNAL_ROOT / "datasets" / "flowjo_async_djf"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    # pid in the name keeps parallel --shard processes from overwriting each other.
    (out_dir / f"comparison_{stamp}_{os.getpid()}.json").write_text(json.dumps({"started": started, "results": results}, indent=2))

    # All (config, model) score cells across every sample.
    def cells(model_id):
        return [(sample["strain"], cfg["label"], cfg["scores"][model_id])
                for sample in results for cfg in sample["configs"] if model_id in cfg["scores"]]

    lines = [f"# PhaseFinder vs FlowJo DJF / Flowreader Watson — {started}", ""]
    lines.append("Each sample is fit under the full pre-model QC matrix (no QC; each gate alone, Time QC "
                 "with both methods; up to all four gates with both Time-QC methods) and every fit is "
                 "compared to the reference, so we can see which gating best reproduces FlowJo/Flowreader.")
    lines.append("")

    # ---- per-QC-config summary: which gating matches best ----
    config_labels = [label for label, _, _ in FLOWJO_QC_MATRIX]
    lines.append("## Within-tolerance pass rate by QC configuration")
    lines.append("")
    lines.append("| QC config | DJF vs FlowJo | Watson vs Flowreader |")
    lines.append("|---|---|---|")
    for label in config_labels:
        def rate(model_id):
            cs = [c for (_s, lab, c) in cells(model_id) if lab == label]
            passed = sum(1 for c in cs if c["all_pass"])
            return f"{passed}/{len(cs)}" if cs else "—"
        lines.append(f"| {label} | {rate('dean_jett_fox')} | {rate('watson_classic')} |")
    lines.append("")

    # ---- full per-sample x per-config x per-model table ----
    lines.append("## Per-sample detail")
    lines.append("")
    lines.append("| strain | QC config | model | %G1 ours/ref (Δpp) | %S ours/ref (Δpp) | %G2 ours/ref (Δpp) | tol | reliability |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for sample in results:
        for cfg in sample["configs"]:
            if cfg["status"] != "PASS":
                lines.append(f'| {sample["strain"]} | {cfg["label"]} | — | {cfg["status"]}: {cfg["error"]} | | | | |')
                continue
            for model_id, score in cfg["scores"].items():
                ph = score["phases"]
                def cell(p):
                    o = ph[p]["ours"]; ref = ph[p]["ref"]; d = ph[p]["delta_pp"]
                    mark = "✓" if ph[p]["pass"] else "✗"
                    return f'{o*100:.1f}/{ref*100:.1f} ({d:+.1f}{mark})'
                reliability = ("limited-reliability" if score.get("limitedReliability")
                               else "authoritative" if score.get("validForReporting")
                               else "not-reportable")
                lines.append(f'| {sample["strain"]} | {cfg["label"]} | {model_id} | {cell("g1")} | {cell("s")} '
                             f'| {cell("g2")} | {"PASS" if score["all_pass"] else "review"} | {reliability} |')
    report_path = out_dir / f"comparison_{stamp}.md"
    report_path.write_text("\n".join(lines) + "\n")

    djf_best = max(((sum(1 for (_s, lab, c) in cells("dean_jett_fox") if lab == label and c["all_pass"]), label)
                    for label in config_labels), default=(0, "—"))
    print(f"FlowJo/Watson comparison ({len(results)} samples x {len(config_labels)} QC configs): {report_path}")
    print(f"  best DJF config: {djf_best[1]} ({djf_best[0]} within tolerance)")
    return report_path


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kind", choices=("all", "synthetic", "external"), default="all")
    parser.add_argument("--files", nargs="*", help="Case IDs, filenames, or substrings to run")
    parser.add_argument("--models", nargs="+", choices=tuple(MODELS), default=list(MODELS))
    parser.add_argument("--skip-qc-matrix", action="store_true", help="Skip the seven extra DJF QC runs")
    parser.add_argument("--max-files", type=int, help="Limit selected files (smoke tests only)")
    parser.add_argument("--skip-flowjo", action="store_true",
                        help="Skip the local-only FlowJo DJF / Flowreader Watson external comparison")
    parser.add_argument("--flowjo-limit", type=int,
                        help="Run only the first N FlowJo/Watson samples (the FCS are large; each sample "
                             "is fit under the full QC matrix, so this is the main runtime knob)")
    parser.add_argument("--flowjo-no-qc", action="store_true",
                        help="Fit the FlowJo/Watson comparison under the No-QC configuration only, instead "
                             "of the full pre-model QC matrix (default)")
    parser.add_argument("--flowjo-only", action="store_true",
                        help="Run ONLY the FlowJo DJF / Flowreader Watson comparison (skip synthetic/external/CLOCCS)")
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--keep", action="store_true", help="Keep older validation reports in the output directory")
    parser.add_argument("--shard", help="Run only shard i of n (format 'i/n', i 0-indexed). Partitions "
                                        "all work (synthetic/external/CLOCCS/FlowJo samples) round-robin so "
                                        "N processes can run the suite in parallel. Implies --keep and a "
                                        "shard-specific report, and prints a 'SHARD_SUMMARY {json}' line.")
    return parser.parse_args()


def _parse_shard(spec):
    """'i/n' -> (i, n) with 0 <= i < n; raises SystemExit on a bad spec."""
    try:
        i_str, n_str = spec.split("/", 1)
        i, n = int(i_str), int(n_str)
    except (ValueError, AttributeError):
        raise SystemExit(f"--shard must look like 'i/n', got {spec!r}")
    if n < 1 or not (0 <= i < n):
        raise SystemExit(f"--shard 'i/n' needs 0 <= i < n (n >= 1), got {spec!r}")
    return i, n


def main():
    args = parse_args()
    # Local-only FlowJo DJF / Flowreader Watson bundle (None when its gitignored
    # reference JSON is absent). Discovered up front so it can gate the
    # "no files matched" check and run even in --flowjo-only mode.
    flowjo_bundle = None if args.skip_flowjo else discover_flowjo_watson()
    flowjo_will_run = bool(flowjo_bundle and flowjo_bundle["records"] and args.kind in ("all", "external"))

    records = [] if args.flowjo_only else discover_synthetic() + discover_external()
    cloccs_series = [] if args.flowjo_only else discover_cloccs_series()
    if args.kind != "all":
        records = [r for r in records if r["kind"].casefold() == args.kind]
        if args.kind == "synthetic":
            cloccs_series = []
    if args.files:
        needles = [x.casefold() for x in args.files]
        records = [r for r in records if any(n in (r["id"] + " " + r["path"].name).casefold() for n in needles)]
        cloccs_series = [r for r in cloccs_series if any(
            n in (r["id"] + " " + " ".join(item["path"].name for item in r["files"])).casefold()
            for n in needles
        )]
    if args.max_files is not None:
        records = records[:args.max_files]
        cloccs_series = cloccs_series[:max(0, args.max_files - len(records))]

    # Round-robin sharding: keep only this shard's slice of every work list so N
    # processes running --shard 0/N .. (N-1)/N together cover the whole suite in
    # parallel. Round-robin (stride) rather than contiguous chunks so each shard
    # gets a balanced mix of light (synthetic) and heavy (FlowJo) items.
    shard = _parse_shard(args.shard) if args.shard else None
    if shard:
        i, n = shard
        records = records[i::n]
        cloccs_series = cloccs_series[i::n]
        if flowjo_bundle and flowjo_bundle.get("records"):
            flowjo_bundle["records"] = flowjo_bundle["records"][i::n]
        flowjo_will_run = bool(flowjo_bundle and flowjo_bundle["records"] and args.kind in ("all", "external"))

    if not records and not cloccs_series and not flowjo_will_run:
        if shard:
            print(f"SHARD_SUMMARY {json.dumps({'shard': args.shard, 'empty': True, 'errors': False, 'counts': {}})}", flush=True)
            return 0
        raise SystemExit("No validation files matched the selection")

    started = datetime.now().astimezone().isoformat(timespec="seconds")
    RESULTS_ROOT.mkdir(parents=True, exist_ok=True)
    if shard:
        report = args.report or RESULTS_ROOT / f"validation_shard_{shard[0]}_of_{shard[1]}.html"
    else:
        report = args.report or RESULTS_ROOT / f'validation_tests_{datetime.now().strftime("%Y%m%d_%H%M%S")}.html'
    report = report.resolve()
    report.parent.mkdir(parents=True, exist_ok=True)
    # Sharded runs share the output directory, so they must not delete each
    # other's reports (--shard implies --keep).
    if not args.keep and not shard:
        for old_report in report.parent.glob("validation_tests_*.html"):
            old_report.unlink()

    port, server = start_test_server(REPO_ROOT)
    url = f"http://127.0.0.1:{port}/index.html"
    try:
        with sync_playwright() as playwright:
            print(f"Serving {url} on the first open port ({port})", flush=True)
            browser = playwright.chromium.launch(headless=not args.headed)
            page = browser.new_page(viewport={"width": 1500, "height": 1050})
            page.set_default_timeout(30000)
            page.goto(url, wait_until="domcontentloaded")
            page.wait_for_selector("#drop_zone")
            execute(page, records, args.models, not args.skip_qc_matrix)
            execute_cloccs(page, cloccs_series)
            # Local-only FlowJo DJF / Flowreader Watson external comparison. Only
            # runs when the (gitignored) reference JSON and FCS are present.
            flowjo_results = None
            if flowjo_will_run:
                qc_matrix = (("No QC", (), None),) if args.flowjo_no_qc else FLOWJO_QC_MATRIX
                flowjo_results = execute_flowjo_watson(page, flowjo_bundle, args.flowjo_limit, qc_matrix)
            elif not args.skip_flowjo and flowjo_bundle is None:
                print("FlowJo/Watson comparison skipped: local reference JSON absent "
                      "(regenerate with generate_flowjo_djf_reference.py).", flush=True)
            browser.close()
    finally:
        server.shutdown()
        server.server_close()

    report.write_text(report_html(records, cloccs_series, started, port), encoding="utf-8")
    print(f"Validation report: {report}")
    if flowjo_results:
        write_flowjo_watson_report(flowjo_results, started)
    from collections import Counter
    counts = Counter()
    for record in records:
        for run in record.get("runs", []):
            counts[run["status"]] += 1
    for record in cloccs_series:
        counts[f"cloccs:{record.get('result', {}).get('status', 'NONE')}"] += 1
    for sample in (flowjo_results or []):
        for cfg in sample["configs"]:
            counts[f"flowjo:{cfg['status']}"] += 1
    errors = any(run["status"] == "ERROR" for record in records for run in record.get("runs", []))
    errors = errors or any(record.get("result", {}).get("status") == "ERROR" for record in cloccs_series)
    errors = errors or any(cfg["status"] == "ERROR"
                           for sample in (flowjo_results or []) for cfg in sample["configs"])
    if shard:
        print(f"SHARD_SUMMARY {json.dumps({'shard': args.shard, 'empty': False, 'errors': errors, 'counts': dict(counts)})}", flush=True)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
