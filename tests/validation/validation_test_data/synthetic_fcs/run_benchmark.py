#!/usr/bin/env python3
"""Run the synthetic FCS benchmark in a real browser with one command.

The default tolerates declared defense exposures and model recovery deviations,
while still failing valid-input contract failures and infrastructure errors.
Use ``--strict`` to make the declared exposures and deviations a remediation/CI
gate too.

The runner starts its own HTTP server on the first available localhost port from
8000 through 9000, launches the requested browser, writes the reports, and shuts
the server down. ``--mode`` selects check types. ``--groups`` selects fixture
categories. ``--cases`` selects exact fixture IDs. Group and case filters are
combined by intersection.

Examples:
  /tmp/flowvenv/bin/python tests/validation/validation_test_data/synthetic_fcs/run_benchmark.py
  /tmp/flowvenv/bin/python tests/validation/validation_test_data/synthetic_fcs/run_benchmark.py --groups known_phase_truth
  /tmp/flowvenv/bin/python tests/validation/validation_test_data/synthetic_fcs/run_benchmark.py --mode models --groups scientific_adversarial --models dean_jett,watson_pragmatic
  /tmp/flowvenv/bin/python tests/validation/validation_test_data/synthetic_fcs/run_benchmark.py --mode qc --groups qc_adversarial
  /tmp/flowvenv/bin/python tests/validation/validation_test_data/synthetic_fcs/run_benchmark.py --mode parser --strict
"""

from __future__ import annotations

import argparse
import hashlib
import http.server
import json
import socketserver
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlencode


HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[3]
MANIFEST_PATH = HERE / "manifest.json"
DEFAULT_RESULTS = HERE.parents[1] / "results"
SERVER_HOST = "127.0.0.1"
SERVER_PORT_MIN = 8000
SERVER_PORT_MAX = 9000
KNOWN_GROUPS = (
    "known_phase_truth",
    "scientific_adversarial",
    "qc_adversarial",
    "parser_conformance",
)
KNOWN_MODELS = (
    "dean_jett",
    "dean_jett_fox",
    "watson_pragmatic",
    "auto_dj_djf",
)
PARSER_PHASE_BY_OUTCOME = {
    "LOAD_OK": "data_load",
    "IMPORT_REJECT": "header_import",
    "ANALYSIS_BLOCK": "science_validation",
}


def start_server() -> tuple[str, socketserver.TCPServer]:
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(REPO_ROOT), **kwargs)

        def log_message(self, format, *args):
            pass

    class Server(socketserver.TCPServer):
        allow_reuse_address = True

    failures = []
    for port in range(SERVER_PORT_MIN, SERVER_PORT_MAX + 1):
        try:
            server = Server((SERVER_HOST, port), Handler)
        except OSError as error:
            failures.append(f"{port}: {error}")
            continue
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        return f"http://{SERVER_HOST}:{port}", server

    detail = "; ".join(failures)
    raise RuntimeError(
        f"Could not start the benchmark HTTP server: no available localhost port "
        f"in {SERVER_PORT_MIN}-{SERVER_PORT_MAX}. {detail}"
    )


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _manifest_path(value, label: str, problems: list[str]) -> Path | None:
    if not isinstance(value, str) or not value.strip():
        problems.append(f"{label} must be a non-empty relative path")
        return None
    candidate = (HERE / value).resolve()
    try:
        candidate.relative_to(HERE)
    except ValueError:
        problems.append(f"{label} escapes the fixture directory: {value!r}")
        return None
    return candidate


def _validate_code_string(
    truth: dict,
    field: str,
    codebook_field: str,
    event_count: int,
    label: str,
    problems: list[str],
) -> None:
    codes = truth.get(field)
    codebook = truth.get(codebook_field)
    if not isinstance(codes, str):
        problems.append(f"{label}: {field} must be a string")
        return
    if len(codes) != event_count:
        problems.append(
            f"{label}: {field} length {len(codes)} does not match event_count {event_count}"
        )
    if not isinstance(codebook, dict) or not codebook:
        problems.append(f"{label}: {codebook_field} must be a non-empty object")
        return
    malformed_keys = sorted(
        repr(key) for key in codebook if not isinstance(key, str) or len(key) != 1
    )
    if malformed_keys:
        problems.append(
            f"{label}: {codebook_field} keys must be single characters: {malformed_keys}"
        )
    invalid = sorted(set(codes) - set(codebook))
    if invalid:
        problems.append(
            f"{label}: {field} contains codes absent from {codebook_field}: {invalid}"
        )


def _validate_truth(
    case: dict,
    truth: dict,
    actual_fcs_hash: str,
    truth_label: str,
    problems: list[str],
) -> None:
    case_id = case.get("id")
    event_count = truth.get("event_count")
    expected_events = case.get("fcs", {}).get("events")

    if truth.get("fixture_id") != case_id:
        problems.append(
            f"{truth_label}: fixture_id {truth.get('fixture_id')!r} does not match {case_id!r}"
        )
    if truth.get("fcs_sha256") != actual_fcs_hash:
        problems.append(f"{truth_label}: fcs_sha256 does not match its FCS file")
    if truth.get("fcs_file") != Path(str(case.get("file", ""))).name:
        problems.append(f"{truth_label}: fcs_file does not name {case.get('file')!r}")
    if not isinstance(event_count, int) or isinstance(event_count, bool) or event_count < 0:
        problems.append(f"{truth_label}: event_count must be a non-negative integer")
        return
    if event_count != expected_events:
        problems.append(
            f"{truth_label}: event_count {event_count} does not match manifest {expected_events!r}"
        )
    _validate_code_string(
        truth, "phase_codes", "phase_codebook", event_count, truth_label, problems
    )
    _validate_code_string(
        truth, "class_codes", "class_codebook", event_count, truth_label, problems
    )
    _validate_code_string(
        truth,
        "s_component_codes",
        "s_component_codebook",
        event_count,
        truth_label,
        problems,
    )
    for field in (
        "structural_good_mask",
        "scatter_good_mask",
        "pulse_good_mask",
        "time_anomaly_mask",
        "measurement_affected_mask",
        "recommended_time_exclusion_mask",
        "time_good_mask",
        "oracle_final_good_mask",
    ):
        mask = truth.get(field)
        if not isinstance(mask, str):
            problems.append(f"{truth_label}: {field} must be a string")
            continue
        if len(mask) != event_count:
            problems.append(
                f"{truth_label}: {field} length {len(mask)} does not match event_count {event_count}"
            )
        invalid = sorted(set(mask) - {"0", "1"})
        if invalid:
            problems.append(f"{truth_label}: {field} contains non-binary values: {invalid}")

    phase_codes = truth.get("phase_codes", "")
    oracle_mask = truth.get("oracle_final_good_mask", "")
    if len(phase_codes) == event_count and len(oracle_mask) == event_count:
        def phase_summary(mask: str | None) -> dict:
            selected = [
                code for index, code in enumerate(phase_codes)
                if mask is None or mask[index] == "1"
            ]
            counts = {
                "g1": selected.count("1"),
                "s": selected.count("S"),
                "g2": selected.count("2"),
            }
            denominator = sum(counts.values())
            return {
                "counts": counts,
                "fractions": {
                    key: value / denominator if denominator else 0.0
                    for key, value in counts.items()
                },
                "denominator": denominator,
            }

        summaries = {
            "truth_all_biological": phase_summary(None),
            "truth_after_oracle_qc": phase_summary(oracle_mask),
        }
        manifest_truth = case.get("truth", {})
        manifest_keys = {
            "truth_all_biological": "all_biological",
            "truth_after_oracle_qc": "after_oracle_qc",
        }
        for sidecar_key, expected_summary in summaries.items():
            if truth.get(sidecar_key) != expected_summary:
                problems.append(f"{truth_label}: {sidecar_key} disagrees with event labels")
            if manifest_truth.get(manifest_keys[sidecar_key]) != expected_summary:
                problems.append(
                    f"{truth_label}: manifest {manifest_keys[sidecar_key]} summary disagrees with event labels"
                )

    channel_hashes = truth.get("channel_sha256_float32_le")
    declared_channels = case.get("fcs", {}).get("channels", [])
    hex_digits = set("0123456789abcdef")
    if not isinstance(channel_hashes, dict) or set(channel_hashes) != set(declared_channels):
        problems.append(f"{truth_label}: channel hash keys do not match declared FCS channels")
    elif any(
        not isinstance(value, str)
        or len(value) != 64
        or not set(value) <= hex_digits
        for value in channel_hashes.values()
    ):
        problems.append(f"{truth_label}: channel hashes must be lowercase SHA-256 strings")


def validate_corpus(manifest: dict) -> None:
    problems: list[str] = []
    if not isinstance(manifest, dict):
        raise RuntimeError("Corpus integrity check failed:\n  manifest root must be an object")
    cases = manifest.get("cases")
    if not isinstance(cases, list) or not cases:
        raise RuntimeError("Corpus integrity check failed:\n  cases must be a non-empty array")
    if manifest.get("case_count") != len(cases):
        problems.append(
            f"case_count {manifest.get('case_count')!r} does not match {len(cases)} cases"
        )

    cases_by_id: dict[str, dict] = {}
    for index, case in enumerate(cases):
        if not isinstance(case, dict):
            problems.append(f"cases[{index}] must be an object")
            continue
        case_id = case.get("id")
        label = f"cases[{index}]" if not isinstance(case_id, str) or not case_id else case_id
        if not isinstance(case_id, str) or not case_id.strip():
            problems.append(f"cases[{index}].id must be a non-empty string")
        elif case_id in cases_by_id:
            problems.append(f"duplicate fixture id: {case_id}")
        else:
            cases_by_id[case_id] = case

        category = case.get("category")
        if category not in KNOWN_GROUPS:
            problems.append(
                f"{label}: category must be one of {list(KNOWN_GROUPS)}, got {category!r}"
            )

        expectation = case.get("parser_expectation")
        if not isinstance(expectation, dict):
            problems.append(f"{label}: parser_expectation must be an object")
        else:
            outcome = expectation.get("outcome")
            expected_phase = PARSER_PHASE_BY_OUTCOME.get(outcome)
            if expected_phase is None:
                problems.append(f"{label}: unknown parser outcome {outcome!r}")
            elif expectation.get("phase") != expected_phase:
                problems.append(
                    f"{label}: {outcome} must declare phase {expected_phase!r}, "
                    f"got {expectation.get('phase')!r}"
                )
            if outcome in {"IMPORT_REJECT", "ANALYSIS_BLOCK"}:
                code = expectation.get("code")
                if not isinstance(code, str) or not code.strip():
                    problems.append(f"{label}: {outcome} must declare a non-empty code")

        fcs = case.get("fcs")
        if not isinstance(fcs, dict):
            problems.append(f"{label}: fcs must be an object")
            fcs = {}
        declared_events = fcs.get("events")
        if (
            not isinstance(declared_events, int)
            or isinstance(declared_events, bool)
            or declared_events < 0
        ):
            problems.append(f"{label}: fcs.events must be a non-negative integer")
        channels = fcs.get("channels")
        if not isinstance(channels, list) or any(
            not isinstance(channel, str) or not channel for channel in channels
        ) or len(channels) != len(set(channels)):
            problems.append(f"{label}: fcs.channels must be a unique string array")

        analysis = case.get("analysis")
        if not isinstance(analysis, dict):
            problems.append(f"{label}: analysis must be an object")
        elif analysis.get("benchmark_models"):
            contracts = analysis.get("expected_by_model")
            if not isinstance(contracts, dict) or set(contracts) != set(KNOWN_MODELS):
                problems.append(
                    f"{label}: expected_by_model must declare exactly {list(KNOWN_MODELS)}"
                )
            else:
                for model_id, contract in contracts.items():
                    if not isinstance(contract, dict) or contract.get("kind") not in {
                        "recovery",
                        "diagnostic",
                    }:
                        problems.append(
                            f"{label}: invalid contract for {model_id}: {contract!r}"
                        )
            views = analysis.get("views")
            if not isinstance(views, list) or not views or any(
                view not in {"raw", "oracle_qc"} for view in views
            ):
                problems.append(f"{label}: analysis.views must use raw/oracle_qc")
        fcs_path = _manifest_path(case.get("file"), f"{label}.file", problems)
        actual_fcs_hash = None
        if fcs_path is not None:
            if not fcs_path.is_file():
                problems.append(f"missing {case.get('file')}")
            else:
                declared_bytes = fcs.get("bytes")
                actual_bytes = fcs_path.stat().st_size
                if (
                    not isinstance(declared_bytes, int)
                    or isinstance(declared_bytes, bool)
                    or declared_bytes != actual_bytes
                ):
                    problems.append(
                        f"FCS byte-size mismatch: {case.get('file')} "
                        f"(manifest {declared_bytes!r}, actual {actual_bytes})"
                    )
                actual_fcs_hash = file_sha256(fcs_path)
                if actual_fcs_hash != fcs.get("sha256"):
                    problems.append(f"FCS hash mismatch: {case.get('file')}")

        truth_name = case.get("truth_file")
        if truth_name is not None:
            truth_path = _manifest_path(truth_name, f"{label}.truth_file", problems)
            if truth_path is not None:
                if not truth_path.is_file():
                    problems.append(f"missing {truth_name}")
                else:
                    actual_truth_hash = file_sha256(truth_path)
                    if actual_truth_hash != case.get("truth_sha256"):
                        problems.append(f"truth hash mismatch: {truth_name}")
                    try:
                        truth = json.loads(truth_path.read_text(encoding="utf-8"))
                    except (OSError, UnicodeError, json.JSONDecodeError) as error:
                        problems.append(f"invalid truth JSON {truth_name}: {error}")
                    else:
                        if not isinstance(truth, dict):
                            problems.append(f"{truth_name}: root must be an object")
                        elif actual_fcs_hash is not None:
                            _validate_truth(
                                case, truth, actual_fcs_hash, truth_name, problems
                            )
        elif case.get("truth_sha256") is not None:
            problems.append(f"{label}: truth_sha256 is set without truth_file")

    for case_id, case in cases_by_id.items():
        qc = case.get("qc")
        if not isinstance(qc, dict) or not qc.get("metamorphic_pair"):
            continue
        partner_id = qc["metamorphic_pair"]
        if not isinstance(partner_id, str) or not partner_id:
            problems.append(f"{case_id}: qc.metamorphic_pair must be a non-empty fixture id")
            continue
        if partner_id == case_id:
            problems.append(f"{case_id}: metamorphic pair cannot reference itself")
            continue
        partner = cases_by_id.get(partner_id)
        if partner is None:
            problems.append(f"{case_id}: unknown metamorphic pair {partner_id!r}")
            continue
        partner_qc = partner.get("qc")
        reverse = partner_qc.get("metamorphic_pair") if isinstance(partner_qc, dict) else None
        if reverse != case_id:
            problems.append(
                f"{case_id}: metamorphic pair {partner_id!r} is not symmetric (reverse={reverse!r})"
            )
        if isinstance(partner_qc, dict) and partner_qc.get("kind") != qc.get("kind"):
            problems.append(
                f"{case_id}: metamorphic pair kind {qc.get('kind')!r} does not match "
                f"{partner_id} kind {partner_qc.get('kind')!r}"
            )

    if problems:
        raise RuntimeError("Corpus integrity check failed:\n  " + "\n  ".join(problems))


def _csv_option(value: str | None, option: str, *, allow_none: bool = False) -> list[str] | None:
    if value is None and allow_none:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{option} must select at least one value")
    raw_values = value.split(",")
    values = [item.strip() for item in raw_values]
    if any(not item for item in values):
        raise ValueError(f"{option} contains an empty comma-separated value")
    if len(values) != len(set(values)):
        raise ValueError(f"{option} contains duplicate values")
    return values


def validate_selection(args, manifest: dict) -> int:
    case_ids = _csv_option(args.cases, "--cases", allow_none=True)
    group_ids = _csv_option(args.groups, "--groups", allow_none=True)
    model_ids = _csv_option(args.models, "--models")
    assert model_ids is not None

    unknown_groups = sorted(set(group_ids or ()) - set(KNOWN_GROUPS))
    if unknown_groups:
        raise ValueError(
            f"unknown --groups value(s): {', '.join(unknown_groups)}; "
            f"known groups: {', '.join(KNOWN_GROUPS)}"
        )
    unknown_models = sorted(set(model_ids) - set(KNOWN_MODELS))
    if unknown_models:
        raise ValueError(
            f"unknown --models value(s): {', '.join(unknown_models)}; "
            f"known models: {', '.join(KNOWN_MODELS)}"
        )
    known_cases = {case["id"] for case in manifest["cases"]}
    if case_ids is not None:
        unknown_cases = sorted(set(case_ids) - known_cases)
        if unknown_cases:
            raise ValueError(f"unknown --cases value(s): {', '.join(unknown_cases)}")

    selected = list(manifest["cases"])
    if group_ids is not None:
        selected_groups = set(group_ids)
        selected = [case for case in selected if case.get("category") in selected_groups]
    if case_ids is not None:
        selected_ids = set(case_ids)
        selected = [case for case in selected if case["id"] in selected_ids]

    parser_count = len(selected) if args.mode in {"all", "parser"} else 0
    qc_cases = [case for case in selected if case.get("qc")]
    qc_count = len(qc_cases) if args.mode in {"all", "qc"} else 0
    pair_count = 0
    if qc_count:
        selected_qc_ids = {case["id"] for case in qc_cases}
        pairs = {
            tuple(sorted((case["id"], case["qc"]["metamorphic_pair"])))
            for case in qc_cases
            if case["qc"].get("metamorphic_pair") in selected_qc_ids
        }
        pair_count = len(pairs)
    model_count = 0
    if args.mode in {"all", "models"}:
        model_count = sum(
            len(case.get("analysis", {}).get("views", [])) * len(model_ids)
            for case in selected
            if case.get("analysis", {}).get("benchmark_models")
        )
    expected_checks = parser_count + qc_count + pair_count + model_count
    if expected_checks == 0:
        raise ValueError(
            "selection schedules zero benchmark checks; choose groups/cases applicable "
            "to the selected mode (group and case filters are intersected)"
        )

    args.models = ",".join(model_ids)
    args.groups = ",".join(group_ids) if group_ids is not None else None
    args.cases = (
        ",".join(case["id"] for case in selected)
        if group_ids is not None or case_ids is not None
        else None
    )
    return expected_checks


def fmt_percent(value) -> str:
    return "—" if not isinstance(value, (int, float)) else f"{100 * value:.2f}"


def fmt_number(value) -> str:
    return "—" if not isinstance(value, (int, float)) else f"{value:.2f}"


def markdown_report(result: dict) -> str:
    summary = result["summary"]
    lines = [
        "# PhaseFinder synthetic FCS benchmark",
        "",
        "This corpus is entirely synthetic. `EXPOSED` denotes a deliberately malformed or "
        "unsupported FCS input that was accepted instead of being rejected/blocked. "
        "`DEVIATION` denotes a model result outside the fixture's predeclared percentage-point tolerance.",
        "",
        "## Summary",
        "",
        f"- Parser: {summary.get('parserPass', 0)} pass, {summary.get('parserExposed', 0)} exposed, {summary.get('parserFail', 0)} failures, {summary.get('parserError', 0)} errors",
        f"- QC: {summary.get('qcPass', 0)} pass, {summary.get('qcExposed', 0)} exposed, {summary.get('qcError', 0)} errors",
        f"- Models: {summary.get('modelPass', 0)} pass, {summary.get('modelDeviation', 0)} deviations, {summary.get('modelDiagnostic', 0)} diagnostics, {summary.get('modelError', 0)} errors",
        f"- Manifest SHA-256: `{result.get('manifestSha256', '')}`",
        f"- Browser: `{result.get('browser', '')}`",
        "",
    ]
    if result["parser"]:
        lines.extend([
            "## Parser and scientific-input contract",
            "",
            "| Fixture | Expected | Observed | Status | Detail |",
            "|---|---|---|---|---|",
        ])
        for row in result["parser"]:
            detail = str(row.get("detail", "")).replace("|", "\\|").replace("\n", " ")
            lines.append(
                f"| `{row['id']}` | {row['expected']} | {row['observed']} | **{row['status']}** | {detail} |"
            )
        lines.append("")
    if result.get("qc"):
        lines.extend([
            "## QC truth and metamorphic checks",
            "",
            "| Fixture | Check | Good retained | Bad rejected | Status | Detail |",
            "|---|---|---:|---:|---|---|",
        ])
        for row in result["qc"]:
            detail = str(row.get("detail", "")).replace("|", "\\|").replace("\n", " ")
            good = fmt_percent(row.get("goodRetention")) if row.get("goodRetention") is not None else "—"
            bad = fmt_percent(row.get("badRejection")) if row.get("badRejection") is not None else "—"
            lines.append(
                f"| `{row['id']}` | `{row['kind']}` | {good} | {bad} | **{row['status']}** | {detail} |"
            )
        lines.append("")
    if result["models"]:
        lines.extend([
            "## Known phase-fraction recovery",
            "",
            "All phase triplets are `G1 / S / G2/M` percentages; error is maximum absolute percentage points.",
            "",
            "| Fixture | View | Model | Truth % | Fit % | Max error pp | Converged | Status |",
            "|---|---|---|---:|---:|---:|---|---|",
        ])
        for row in result["models"]:
            truth = row.get("truth") or {}
            fitted = row.get("fitted") or {}
            truth_text = " / ".join(fmt_percent(truth.get(key)) for key in ("g1", "s", "g2"))
            fit_text = " / ".join(fmt_percent(fitted.get(key)) for key in ("g1", "s", "g2")) if fitted else "—"
            converged = row.get("converged")
            converged_text = "—" if converged is None else "yes" if converged else "no"
            lines.append(
                f"| `{row['id']}` | {row['view']} | `{row['modelId']}` | {truth_text} | {fit_text} | "
                f"{fmt_number(row.get('maxAbsoluteErrorPercentagePoints'))} | {converged_text} | **{row['status']}** |"
            )
        lines.extend(["", "## Model details", ""])
        for row in result["models"]:
            detail = str(row.get("detail", "")).replace("\n", " ")
            lines.append(f"- `{row['id']}` / `{row['view']}` / `{row['modelId']}`: {detail}")
        lines.append("")
    return "\n".join(lines)


def run(args) -> tuple[dict, Path, Path]:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as error:
        raise RuntimeError(
            "Python Playwright is required for the CLI runner. Use the existing test venv "
            "(/tmp/flowvenv/bin/python) or install playwright, or open benchmark.html through a local server."
        ) from error

    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    validate_corpus(manifest)
    expected_checks = validate_selection(args, manifest)
    base_url, server = start_server()
    params = {
        "autorun": "1",
        "mode": args.mode,
        "models": args.models,
    }
    if args.cases:
        params["cases"] = args.cases
    url = f"{base_url}/tests/validation/validation_test_data/synthetic_fcs/benchmark.html?{urlencode(params)}"
    print(f"Serving the synthetic FCS benchmark at {url}", flush=True)

    try:
        with sync_playwright() as playwright:
            browser_type = getattr(playwright, args.browser)
            browser = browser_type.launch(headless=not args.headed)
            page = browser.new_page()
            page.goto(url, wait_until="domcontentloaded")
            deadline = time.monotonic() + args.timeout_seconds
            last_progress = None
            while time.monotonic() < deadline:
                if page.evaluate("() => window.__benchmarkDone === true"):
                    break
                progress = page.locator("#progress").get_attribute("aria-valuetext")
                if progress and progress != last_progress:
                    print(progress, flush=True)
                    last_progress = progress
                time.sleep(0.5)
            else:
                raise TimeoutError(f"Benchmark did not finish in {args.timeout_seconds} seconds.")

            browser_error = page.evaluate("() => window.__benchmarkError || null")
            if browser_error:
                raise RuntimeError(f"Browser benchmark failed: {browser_error}")
            result = page.evaluate("() => window.__benchmarkResult")
            browser.close()
    finally:
        server.shutdown()
        server.server_close()

    if not isinstance(result, dict) or not isinstance(result.get("summary"), dict):
        raise RuntimeError("Browser benchmark returned no structured result summary")
    observed_checks = result["summary"].get("totalChecks")
    if observed_checks != expected_checks:
        raise RuntimeError(
            f"Browser ran {observed_checks!r} checks; CLI selection scheduled {expected_checks}"
        )

    output_dir = args.output.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    unique_suffix = time.time_ns()
    stem = f"synthetic_fcs_benchmark_{args.browser}_{args.mode}_{stamp}_{unique_suffix}"
    json_path = output_dir / f"{stem}.json"
    markdown_path = output_dir / f"{stem}.md"
    json_path.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    markdown_path.write_text(markdown_report(result), encoding="utf-8")
    return result, json_path, markdown_path


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--mode",
        choices=("all", "parser", "qc", "models"),
        default="all",
        help="Check type to run (default: all).",
    )
    parser.add_argument(
        "--models",
        default="dean_jett,dean_jett_fox,watson_pragmatic,auto_dj_djf",
        help="Comma-separated model IDs.",
    )
    parser.add_argument(
        "--groups",
        "--categories",
        dest="groups",
        default=None,
        metavar="GROUP[,GROUP...]",
        help=(
            "Optional comma-separated fixture groups: "
            + ", ".join(KNOWN_GROUPS)
            + ". Intersects with --cases."
        ),
    )
    parser.add_argument(
        "--cases",
        default=None,
        metavar="ID[,ID...]",
        help="Optional comma-separated fixture IDs. Intersects with --groups.",
    )
    parser.add_argument("--browser", choices=("chromium", "firefox", "webkit"), default="chromium")
    parser.add_argument("--headed", action="store_true")
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Also return nonzero for exposed parser/QC behavior or model deviations.",
    )
    parser.add_argument("--timeout-seconds", type=int, default=900)
    parser.add_argument("--output", type=Path, default=DEFAULT_RESULTS)
    args = parser.parse_args()

    try:
        result, json_path, markdown_path = run(args)
    except Exception as error:
        print(f"Benchmark failed: {error}", file=sys.stderr)
        return 2

    summary = result["summary"]
    print(
        "\nSynthetic FCS benchmark complete:\n"
        f"  parser: {summary.get('parserPass', 0)} pass, {summary.get('parserExposed', 0)} exposed, {summary.get('parserFail', 0)} fail, {summary.get('parserError', 0)} error\n"
        f"  QC: {summary.get('qcPass', 0)} pass, {summary.get('qcExposed', 0)} exposed, {summary.get('qcError', 0)} error\n"
        f"  models: {summary.get('modelPass', 0)} pass, {summary.get('modelDeviation', 0)} deviation, {summary.get('modelDiagnostic', 0)} diagnostic, {summary.get('modelError', 0)} error\n"
        f"  JSON: {json_path}\n"
        f"  Markdown: {markdown_path}"
    )
    fatal = (
        summary.get("parserFail", 0)
        + summary.get("parserError", 0)
        + summary.get("qcError", 0)
        + summary.get("modelError", 0)
    )
    strict_concerns = (
        summary.get("parserExposed", 0)
        + summary.get("qcExposed", 0)
        + summary.get("modelDeviation", 0)
    )
    return 1 if fatal or (args.strict and strict_concerns) else 0


if __name__ == "__main__":
    raise SystemExit(main())
