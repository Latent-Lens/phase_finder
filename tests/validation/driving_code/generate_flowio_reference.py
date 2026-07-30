#!/usr/bin/env python3
"""Generate/check first-event parser references with independent FlowIO."""

from __future__ import annotations

import argparse
import hashlib
import json
import warnings
from pathlib import Path

from flowio import FlowData


ROOT = Path(__file__).resolve().parents[3]
CORPUS = ROOT / "tests/validation/validation_test_data/synthetic_fcs"
OUTPUT = CORPUS / "independent_reader_reference.json"


def build_reference() -> dict:
    matrix = json.loads((ROOT / "docs/fcs-compatibility.json").read_text())
    manifest = json.loads((CORPUS / "manifest.json").read_text())
    cases = {case["id"]: case for case in manifest["cases"]}
    fixture_ids = sorted({
        fixture
        for cell in matrix["cells"] if cell["status"] == "supported" or cell["feature"] in {"scaling", "compensation"}
        for fixture in cell["fixtures"]
    })
    fixtures = []
    for fixture_id in fixture_ids:
        case = cases[fixture_id]
        expected = case["parser_expectation"].get("first_row")
        if not expected:
            continue
        path = CORPUS / case["file"]
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            flow = FlowData(str(path))
        if flow.events is None:
            continue
        labels = [flow.text.get(f"p{index}n") or f"P{index}" for index in range(1, flow.channel_count + 1)]
        first = list(flow.events[:flow.channel_count])
        fixtures.append({
            "id": fixture_id,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "firstEvent": {label: first[index] for index, label in enumerate(labels) if label in expected},
        })
    return {"schemaVersion": 1, "reader": "FlowIO 1.4.0", "fixtures": fixtures}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    reference = build_reference()
    text = json.dumps(reference, indent=2, sort_keys=True) + "\n"
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_text() != text:
            print(f"FlowIO reference is stale: {OUTPUT}")
            return 1
        print(f"FlowIO reference matches {len(reference['fixtures'])} fixtures.")
        return 0
    OUTPUT.write_text(text)
    print(f"Wrote {len(reference['fixtures'])} FlowIO references to {OUTPUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
