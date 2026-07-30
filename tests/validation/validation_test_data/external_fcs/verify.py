#!/usr/bin/env python3
"""Verify hashes and frozen summaries for the non-synthetic test corpus."""

from __future__ import annotations

import csv
import gzip
import hashlib
import json
from collections import Counter
from pathlib import Path


HERE = Path(__file__).resolve().parent


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_text_segment(text: str) -> dict[str, str]:
    delimiter = text[0]
    fields: list[str] = []
    field = ""
    index = 1
    while index < len(text):
        char = text[index]
        if char != delimiter:
            field += char
            index += 1
        elif index + 1 < len(text) and text[index + 1] == delimiter:
            field += delimiter
            index += 2
        else:
            fields.append(field)
            field = ""
            index += 1
    if field:
        fields.append(field)
    return {
        fields[index].lstrip("$").upper(): fields[index + 1]
        for index in range(0, len(fields) - 1, 2)
    }


def inspect_fcs(path: Path) -> dict[str, object]:
    with path.open("rb") as stream:
        header = stream.read(58)
        assert len(header) == 58 and header.startswith(b"FCS"), f"invalid FCS header: {path}"
        offsets = [int(header[start : start + 8].strip() or b"0") for start in range(10, 58, 8)]
        text_start, text_stop, data_start, data_stop, analysis_start, analysis_stop = offsets
        stream.seek(text_start)
        metadata = parse_text_segment(stream.read(text_stop - text_start + 1).decode("latin-1"))
    parameters = int(metadata["PAR"])
    markers = {
        metadata.get(f"P{index}S") or metadata.get(f"P{index}N")
        for index in range(1, parameters + 1)
    }
    return {
        "version": header[:6].decode("ascii").strip(),
        "events": int(metadata["TOT"]),
        "parameters": parameters,
        "datatype": metadata["DATATYPE"],
        "byte_order": metadata["BYTEORD"],
        "mode": metadata["MODE"],
        "text_start": text_start,
        "text_stop": text_stop,
        "data_start": data_start,
        "data_stop": data_stop,
        "analysis_start": analysis_start,
        "analysis_stop": analysis_stop,
        "first_parameter": metadata.get("P1N") or metadata.get("P1S"),
        "last_parameter": metadata.get(f"P{parameters}N") or metadata.get(f"P{parameters}S"),
        "markers": markers,
    }


def verify_file(record: dict[str, object]) -> Path:
    path = HERE / str(record["path"])
    assert path.is_file(), f"missing artifact: {path.relative_to(HERE)}"
    assert path.stat().st_size == record["byte_size"], f"size mismatch: {path.relative_to(HERE)}"
    assert sha256(path) == record["sha256"], f"hash mismatch: {path.relative_to(HERE)}"
    return path


def verify_fcs(path: Path, expected: dict[str, object], oracle: dict[str, object] | None = None) -> None:
    observed = inspect_fcs(path)
    for key, observed_key in (
        ("fcs_version", "version"),
        ("datatype", "datatype"),
        ("byte_order", "byte_order"),
        ("events", "events"),
        ("parameters", "parameters"),
    ):
        assert observed[observed_key] == expected[key], f"{path.name}: {key} mismatch"
    missing = set(expected.get("required_markers", [])) - observed["markers"]
    assert not missing, f"{path.name}: missing markers {sorted(missing)}"
    if oracle:
        summary = oracle["expected_summary"]
        for key, value in summary.items():
            if key in observed:
                assert observed[key] == value, f"{path.name}: oracle {key} mismatch"


def verify_csv(path: Path, expected: dict[str, object]) -> None:
    opener = gzip.open if path.suffix == ".gz" else open
    counts: Counter[str] = Counter()
    unique: set[str] = set()
    rows = 0
    value_check = expected.get("value_counts")
    unique_check = expected.get("unique")
    with opener(path, "rt", newline="", encoding="utf-8-sig") as stream:
        for row in csv.DictReader(stream):
            rows += 1
            if value_check:
                counts[row[value_check["field"]]] += 1
            if unique_check:
                unique.add(row[unique_check["field"]])
    assert rows == expected["rows"], f"{path.name}: row count mismatch"
    if value_check:
        assert counts == Counter(value_check["counts"]), f"{path.name}: value counts mismatch"
    if unique_check:
        assert len(unique) == unique_check["count"], f"{path.name}: unique count mismatch"


def verify_reference_results(dataset: dict[str, object]) -> None:
    for result in dataset.get("reference_results", []):
        phase_keys = [key for key in ("g1_percent", "g0_g1_percent", "s_percent", "g2_m_percent", "g2_percent", "m_percent", "unclassified_percent") if key in result]
        if phase_keys:
            total = sum(float(result[key]) for key in phase_keys)
            assert abs(total - 100) <= 0.02, f"{dataset['id']}: published fractions total {total}"


def main() -> None:
    manifest = json.loads((HERE / "manifest.json").read_text())
    checked = 0
    for fixture in manifest["fixtures"]:
        path = verify_file(fixture)
        verify_fcs(path, fixture["format"], fixture.get("oracle"))
        checked += 1
    for dataset in manifest["published_datasets"]:
        verify_reference_results(dataset)
        for artifact in dataset["artifacts"]:
            path = verify_file(artifact)
            if artifact["kind"] == "fcs":
                verify_fcs(path, artifact["format"], artifact.get("oracle"))
            elif artifact["kind"] == "gzip_csv":
                verify_csv(path, artifact["csv_check"])
            checked += 1
    print(f"PASS: {checked} non-synthetic artifacts verified")


if __name__ == "__main__":
    main()
