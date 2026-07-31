#!/usr/bin/env python3
"""Generate PhaseFinder's deterministic synthetic FCS audit corpus.

The scientific event generator is intentionally independent of PhaseFinder's
JavaScript equations.  It creates exact phase labels first, then simulates
instrument channels conditionally.  Truth remains in sidecars, never in FCS
parameters, so the application cannot leak labels into a fit.

Usage:
  python3 tests/validation/validation_test_data/synthetic_fcs/generate_fixtures.py
  python3 tests/validation/validation_test_data/synthetic_fcs/generate_fixtures.py --check
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import struct
import sys
import tempfile
from pathlib import Path
from statistics import NormalDist
from typing import Any, Sequence


from fcs_factory import Parameter, build_fcs, sha256_file


GENERATOR_NAME = "phasefinder-synthetic-fcs"
GENERATOR_VERSION = "1.0.0"
SCHEMA_VERSION = 1
DEFAULT_OUTPUT = Path(__file__).resolve().parent
NORMAL = NormalDist()

CHANNELS = ("DNA-A", "DNA-H", "DNA-W", "FSC-A", "SSC-A", "Time")
MODEL_IDS = ("dean_jett", "dean_jett_fox", "watson_pragmatic", "watson_classic")
PHASE_CODE = {"G1": "1", "S": "S", "G2M": "2", None: "."}
CLASS_CODE = {
    "biological_singlet": "B",
    "sub_g1": "D",
    "post_g2": "P",
    "aggregate": "A",
    "high_fsc_artifact": "H",
    "structural_invalid": "X",
}


def _stream_rng(seed: int, stream: str) -> random.Random:
    """Independent deterministic RNG stream derived from seed and name."""

    digest = hashlib.sha256(f"{GENERATOR_VERSION}:{seed}:{stream}".encode()).digest()
    return random.Random(int.from_bytes(digest[:16], "big"))


def _float32(value: float) -> float:
    return struct.unpack("<f", struct.pack("<f", float(value)))[0]


def _channel_hash(rows: Sequence[Sequence[float]], index: int) -> str:
    digest = hashlib.sha256()
    for row in rows:
        digest.update(struct.pack("<f", row[index]))
    return digest.hexdigest()


def _s_progress_hash(records: Sequence[dict[str, Any]]) -> str:
    """Hash event-aligned S progress, using one canonical quiet NaN elsewhere."""

    digest = hashlib.sha256()
    for record in records:
        value = record.get("s_progress")
        bits = 0x7FC00000 if value is None else struct.unpack("<I", struct.pack("<f", value))[0]
        digest.update(struct.pack("<I", bits))
    return digest.hexdigest()


def _exact_phase_counts(total: int, fractions: Sequence[float]) -> tuple[int, int, int]:
    if total <= 0:
        raise ValueError("The biological event count must be positive.")
    if (
        len(fractions) != 3
        or not all(math.isfinite(value) and value >= 0 for value in fractions)
        or not math.isclose(sum(fractions), 1.0, abs_tol=1e-12)
    ):
        raise ValueError("Phase fractions must contain G1/S/G2 values summing to one.")
    g1 = int(round(total * fractions[0]))
    s = int(round(total * fractions[1]))
    g2 = total - g1 - s
    if min(g1, s, g2) < 0:
        raise ValueError("Phase counts may not be negative.")
    return g1, s, g2


def _quadratic_profile_cdf(z: float, b: float, c: float) -> float:
    a = 1.0 - b / 2.0 - c / 3.0
    return a * z + 0.5 * b * z * z + (c / 3.0) * z * z * z


def _sample_quadratic_progress(rng: random.Random, b: float, c: float) -> float:
    """Invert an independently implemented normalized quadratic CDF."""

    target = rng.random()
    low, high = 0.0, 1.0
    for _ in range(60):
        middle = (low + high) / 2.0
        if _quadratic_profile_cdf(middle, b, c) < target:
            low = middle
        else:
            high = middle
    return (low + high) / 2.0


def _validate_quadratic_profile(b: float, c: float) -> None:
    """Require the normalized quadratic density to stay nonnegative on [0, 1]."""

    if not math.isfinite(b) or not math.isfinite(c):
        raise ValueError("Quadratic S-profile coefficients must be finite.")
    a = 1.0 - b / 2.0 - c / 3.0
    candidates = [0.0, 1.0]
    if c != 0:
        vertex = -b / (2.0 * c)
        if 0.0 < vertex < 1.0:
            candidates.append(vertex)
    if min(a + b * z + c * z * z for z in candidates) < -1e-12:
        raise ValueError("The quadratic S-profile density must be nonnegative on [0, 1].")


def _validate_fox(fox: tuple[float, float, float] | None) -> None:
    if fox is None:
        return
    weight, mean, sigma = fox
    if not all(math.isfinite(value) for value in fox):
        raise ValueError("Fox parameters must be finite.")
    if not 0.0 <= weight <= 1.0:
        raise ValueError("Fox wave weight must lie in [0, 1].")
    if not 0.0 <= mean <= 1.0:
        raise ValueError("Fox wave mean must lie in [0, 1].")
    if sigma <= 0.0:
        raise ValueError("Fox wave sigma must be positive.")


def _sample_truncated_normal_progress(
    rng: random.Random,
    mean: float,
    sigma: float,
) -> float:
    lower = NORMAL.cdf((0.0 - mean) / sigma)
    upper = NORMAL.cdf((1.0 - mean) / sigma)
    probability = lower + rng.random() * (upper - lower)
    probability = min(1.0 - 1e-15, max(1e-15, probability))
    return min(1.0, max(0.0, mean + sigma * NORMAL.inv_cdf(probability)))


def _phase_summary(records: Sequence[dict[str, Any]], oracle_only: bool) -> dict[str, Any]:
    selected = [
        record for record in records
        if record["phase"] is not None and (not oracle_only or record["oracle_good"])
    ]
    counts = {
        "g1": sum(record["phase"] == "G1" for record in selected),
        "s": sum(record["phase"] == "S" for record in selected),
        "g2": sum(record["phase"] == "G2M" for record in selected),
    }
    denominator = sum(counts.values())
    fractions = {
        key: (value / denominator if denominator else 0.0)
        for key, value in counts.items()
    }
    return {"counts": counts, "fractions": fractions, "denominator": denominator}


def _make_scientific_events(
    *,
    fixture_id: str,
    seed: int,
    biological_events: int,
    fractions: tuple[float, float, float],
    g1_mean: float = 64_000.0,
    g2_ratio: float = 2.0,
    g1_cv: float = 0.05,
    g2_cv: float = 0.055,
    s_profile: tuple[float, float] = (0.0, 0.0),
    fox: tuple[float, float, float] | None = None,
    contaminants: dict[str, int] | None = None,
    dna_scale: float = 1.0,
    dna_h_scale: float = 1.0,
    anomaly: str | None = None,
) -> tuple[list[list[float]], list[dict[str, Any]], dict[str, Any]]:
    """Create ordered channel rows plus event truth.

    Phase counts are exact.  The event labels are generated before any
    fluorescence/scatter values and are shuffled with a dedicated RNG stream.
    """

    allowed_anomalies = {None, "gain_drift", "peak_disappearance", "rate_drop", "structural_invalid"}
    if anomaly not in allowed_anomalies:
        raise ValueError(f"Unknown anomaly: {anomaly}")
    g1_count, s_count, g2_count = _exact_phase_counts(biological_events, fractions)
    if not all(math.isfinite(value) and value > 0 for value in (g1_mean, g2_ratio, g1_cv, g2_cv, dna_scale, dna_h_scale)):
        raise ValueError("Means, ratios, CVs, and scale factors must be finite and positive.")
    _validate_quadratic_profile(*s_profile)
    _validate_fox(fox)
    records: list[dict[str, Any]] = (
        [{"phase": "G1", "event_class": "biological_singlet", "s_component": None} for _ in range(g1_count)]
        + [{"phase": "S", "event_class": "biological_singlet", "s_component": "base"} for _ in range(s_count)]
        + [{"phase": "G2M", "event_class": "biological_singlet", "s_component": None} for _ in range(g2_count)]
    )

    if fox and s_count:
        wave_count = int(round(fox[0] * s_count))
        s_records = [record for record in records if record["phase"] == "S"]
        wave_rng = _stream_rng(seed, "wave-membership")
        wave_rng.shuffle(s_records)
        for record in s_records[:wave_count]:
            record["s_component"] = "wave"

    for event_class, count in sorted((contaminants or {}).items()):
        if event_class not in CLASS_CODE or event_class in {"biological_singlet", "structural_invalid"}:
            raise ValueError(f"Unknown contaminant class: {event_class}")
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            raise ValueError(f"Contaminant count for {event_class} must be a nonnegative integer.")
        records.extend({"phase": None, "event_class": event_class, "s_component": None} for _ in range(count))

    order_rng = _stream_rng(seed, "event-order")
    order_rng.shuffle(records)

    progress_rng = _stream_rng(seed, "s-progress")
    dna_rng = _stream_rng(seed, "dna-noise")
    width_rng = _stream_rng(seed, "pulse-width")
    height_rng = _stream_rng(seed, "pulse-height")
    scatter_rng = _stream_rng(seed, "scatter")

    g2_mean = g1_mean * g2_ratio
    b, c = s_profile
    rows: list[list[float]] = []
    current_time = 0.0
    anomaly_start = int(0.40 * len(records))
    anomaly_end = int(0.60 * len(records))

    for event_index, record in enumerate(records):
        phase = record["phase"]
        event_class = record["event_class"]
        s_progress = None

        if phase == "G1":
            latent = g1_mean
            cv = g1_cv
        elif phase == "G2M":
            latent = g2_mean
            cv = g2_cv
        elif phase == "S":
            if record["s_component"] == "wave" and fox:
                s_progress = _sample_truncated_normal_progress(progress_rng, fox[1], fox[2])
            else:
                s_progress = _sample_quadratic_progress(progress_rng, b, c)
            latent = g1_mean + s_progress * (g2_mean - g1_mean)
            cv = g1_cv
        elif event_class == "sub_g1":
            latent, cv = 0.55 * g1_mean, 0.10
        elif event_class == "post_g2":
            latent, cv = 2.65 * g1_mean, 0.07
        elif event_class == "aggregate":
            latent, cv = 2.35 * g1_mean, 0.08
        elif event_class == "high_fsc_artifact":
            latent, cv = 0.85 * g1_mean, 0.16
        else:
            raise AssertionError(event_class)

        dna_area = latent + dna_rng.gauss(0.0, cv * latent)
        in_anomaly = anomaly_start <= event_index < anomaly_end
        if anomaly == "gain_drift" and in_anomaly:
            dna_area *= 1.16
        elif anomaly == "peak_disappearance" and in_anomaly and phase == "G2M":
            dna_area = g1_mean + dna_rng.gauss(0.0, g1_cv * g1_mean)

        width = 2.0 * math.exp(0.04 * width_rng.gauss(0.0, 1.0))
        if event_class == "aggregate":
            width *= 1.75
        height = (dna_area / width) * math.exp(0.012 * height_rng.gauss(0.0, 1.0))

        z1 = scatter_rng.gauss(0.0, 1.0)
        z2 = scatter_rng.gauss(0.0, 1.0)
        correlated = 0.65 * z1 + math.sqrt(1.0 - 0.65**2) * z2
        if event_class in {"sub_g1"}:
            fsc = 23_000.0 + 3_500.0 * z1
            ssc = 14_000.0 + 2_500.0 * correlated
        elif event_class in {"aggregate", "high_fsc_artifact", "post_g2"}:
            fsc = 165_000.0 + 8_000.0 * z1
            ssc = 82_000.0 + 6_000.0 * correlated
        else:
            fsc = 95_000.0 + 9_000.0 * z1
            ssc = 56_000.0 + 6_000.0 * correlated

        record["s_progress"] = s_progress
        record["structural_good"] = True
        record["time_anomaly"] = in_anomaly and anomaly in {"gain_drift", "peak_disappearance", "rate_drop"}
        record["measurement_affected"] = bool(
            record["time_anomaly"]
            and (anomaly != "peak_disappearance" or phase == "G2M")
        )
        record["time_good"] = not record["time_anomaly"]
        record["scatter_good"] = event_class == "biological_singlet"
        record["pulse_good"] = event_class != "aggregate"
        record["oracle_good"] = event_class == "biological_singlet" and record["time_good"]

        row = [
            dna_area * dna_scale,
            height * dna_scale * dna_h_scale,
            width,
            max(100.0, fsc),
            max(100.0, ssc),
            current_time,
        ]
        rows.append([_float32(value) for value in row])

        increment = 0.01
        if anomaly == "rate_drop" and in_anomaly:
            increment *= 5.0
        current_time += increment

    if anomaly == "structural_invalid" and rows:
        mutations = {
            3: float("nan"),
            7: float("inf"),
            11: float("-inf"),
            15: -1.0,
            19: 262_144.0 * dna_scale,
        }
        for index, value in mutations.items():
            if index >= len(rows):
                continue
            rows[index][0] = _float32(value)
            records[index]["event_class"] = "structural_invalid"
            records[index]["structural_good"] = False
            records[index]["time_good"] = True
            records[index]["time_anomaly"] = False
            records[index]["measurement_affected"] = False
            records[index]["scatter_good"] = False
            records[index]["pulse_good"] = False
            records[index]["oracle_good"] = False

    metadata = {
        "fixture_id": fixture_id,
        "seed": seed,
        "biological_events": biological_events,
        "g1_mean": g1_mean * dna_scale,
        "g2_mean": g2_mean * dna_scale,
        "g2_g1_ratio": g2_ratio,
        "g1_cv": g1_cv,
        "g2_cv": g2_cv,
        "s_profile": {"b": b, "c": c},
        "fox": ({"w": fox[0], "mean": fox[1], "sigma": fox[2]} if fox else None),
        "anomaly": anomaly,
        "anomaly_range": (
            [anomaly_start, anomaly_end]
            if anomaly in {"gain_drift", "peak_disappearance", "rate_drop"}
            else None
        ),
        "structural_invalid_indexes": (
            [index for index, record in enumerate(records) if not record["structural_good"]]
            if anomaly == "structural_invalid"
            else []
        ),
        "contaminants": contaminants or {},
    }
    return rows, records, metadata


def _scientific_parameters(*, dna_scale: float = 1.0, dna_h_scale: float = 1.0) -> list[Parameter]:
    dna_range = max(262_144, int(math.ceil(262_144 * dna_scale)))
    return [
        Parameter("DNA-A", bits=32, range=dna_range, exponent="0,0", gain="1"),
        Parameter("DNA-H", bits=32, range=max(dna_range, int(dna_range * dna_h_scale)), exponent="0,0", gain="1"),
        Parameter("DNA-W", bits=32, range=64, exponent="0,0", gain="1"),
        Parameter("FSC-A", stain="Forward Scatter Area", bits=32, range=262_144),
        Parameter("SSC-A", stain="Side Scatter Area", bits=32, range=262_144),
        Parameter("Time", stain="Time", bits=32, range=1_048_576, unit="s"),
    ]


def _write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")


def _write_scientific_case(
    output: Path,
    spec: dict[str, Any],
) -> dict[str, Any]:
    fixture_id = spec["id"]
    rows, records, generation = _make_scientific_events(
        fixture_id=fixture_id,
        seed=spec["seed"],
        biological_events=spec["biological_events"],
        fractions=tuple(spec["fractions"]),
        g1_mean=spec.get("g1_mean", 64_000.0),
        g2_ratio=spec.get("g2_ratio", 2.0),
        g1_cv=spec.get("g1_cv", 0.05),
        g2_cv=spec.get("g2_cv", 0.055),
        s_profile=tuple(spec.get("s_profile", (0.0, 0.0))),
        fox=tuple(spec["fox"]) if spec.get("fox") else None,
        contaminants=spec.get("contaminants"),
        dna_scale=spec.get("dna_scale", 1.0),
        dna_h_scale=spec.get("dna_h_scale", 1.0),
        anomaly=spec.get("anomaly"),
    )

    selected_channels = tuple(spec.get("channels", CHANNELS))
    if len(selected_channels) != len(set(selected_channels)):
        raise ValueError(f"Duplicate selected channels for {fixture_id}: {selected_channels}")
    selected_indexes = [CHANNELS.index(channel) for channel in selected_channels]
    selected_rows = [[row[index] for index in selected_indexes] for row in rows]
    all_parameters = _scientific_parameters(
        dna_scale=spec.get("dna_scale", 1.0),
        dna_h_scale=spec.get("dna_h_scale", 1.0),
    )
    selected_parameters = [all_parameters[index] for index in selected_indexes]

    fcs_relative = Path("files") / f"{fixture_id}.fcs"
    truth_relative = Path("files") / f"{fixture_id}.truth.json"
    fcs_path = output / fcs_relative
    truth_path = output / truth_relative
    build = build_fcs(
        selected_rows,
        selected_parameters,
        datatype="F",
        little_endian=True,
        mode="L",
        nextdata=0,
        timestep="1",
        extra_keywords=[
            ("$FIL", fcs_relative.name),
            ("$SRC", "100% synthetic; no human or instrument data"),
            ("$CYT", "PhaseFinder deterministic benchmark generator"),
        ],
    )
    fcs_path.write_bytes(build.data)

    all_biological = _phase_summary(records, oracle_only=False)
    oracle = _phase_summary(records, oracle_only=True)
    truth = {
        "schema_version": SCHEMA_VERSION,
        "fixture_id": fixture_id,
        "contains_real_data": False,
        "generator": {"name": GENERATOR_NAME, "version": GENERATOR_VERSION},
        "seed": spec["seed"],
        "fcs_file": fcs_relative.name,
        "fcs_sha256": build.sha256,
        "event_count": len(records),
        "phase_codebook": {"1": "G1", "S": "S", "2": "G2/M", ".": "not biological phase"},
        "class_codebook": {value: key for key, value in CLASS_CODE.items()},
        "phase_codes": "".join(PHASE_CODE[record["phase"]] for record in records),
        "class_codes": "".join(CLASS_CODE[record["event_class"]] for record in records),
        "s_component_codebook": {"W": "Fox-like wave", "B": "base S profile", ".": "not S phase"},
        "s_component_codes": "".join(
            "W" if record["s_component"] == "wave"
            else "B" if record["s_component"] == "base"
            else "."
            for record in records
        ),
        "s_progress_sha256_float32_le": _s_progress_hash(records),
        "structural_good_mask": "".join("1" if record["structural_good"] else "0" for record in records),
        "scatter_good_mask": "".join("1" if record["scatter_good"] else "0" for record in records),
        "pulse_good_mask": "".join("1" if record["pulse_good"] else "0" for record in records),
        "time_anomaly_mask": "".join("1" if record["time_anomaly"] else "0" for record in records),
        "measurement_affected_mask": "".join("1" if record["measurement_affected"] else "0" for record in records),
        "recommended_time_exclusion_mask": "".join("1" if record["time_anomaly"] else "0" for record in records),
        "time_good_mask": "".join("1" if record["time_good"] else "0" for record in records),
        "oracle_final_good_mask": "".join("1" if record["oracle_good"] else "0" for record in records),
        "truth_all_biological": all_biological,
        "truth_after_oracle_qc": oracle,
        "generation": generation,
        "channel_sha256_float32_le": {
            channel: _channel_hash(rows, CHANNELS.index(channel))
            for channel in selected_channels
        },
    }
    _write_json(truth_path, truth)

    peak_scale = spec.get("dna_scale", 1.0)
    g1_mean = spec.get("g1_mean", 64_000.0) * peak_scale
    g2_mean = g1_mean * spec.get("g2_ratio", 2.0)
    g1_cv = spec.get("g1_cv", 0.05)
    g2_cv = spec.get("g2_cv", 0.055)
    regions = spec.get("peak_regions") or {
        "g1": {"left": round(g1_mean * (1 - 3.2 * g1_cv), 6), "right": round(g1_mean * (1 + 3.2 * g1_cv), 6)},
        "g2": {"left": round(g2_mean * (1 - 3.2 * g2_cv), 6), "right": round(g2_mean * (1 + 3.2 * g2_cv), 6)},
    }
    default_contract = "recovery" if spec["category"] == "known_phase_truth" else "diagnostic"
    expected_by_model = {
        model_id: {"kind": default_contract}
        for model_id in MODEL_IDS
    }
    for model_id, contract in spec.get("expected_by_model", {}).items():
        if model_id not in MODEL_IDS:
            raise ValueError(f"Unknown model contract for {fixture_id}: {model_id}")
        expected_by_model[model_id] = dict(contract)

    entry = {
        "id": fixture_id,
        "category": spec["category"],
        "description": spec["description"],
        "audit_findings": spec.get("audit_findings", []),
        "tags": spec.get("tags", []),
        "file": fcs_relative.as_posix(),
        "truth_file": truth_relative.as_posix(),
        "fcs": {
            "sha256": build.sha256,
            "bytes": len(build.data),
            "events": len(rows),
            "encoding": "FCS3.1/F32/little-endian/list/single-dataset",
            "channels": list(selected_channels),
        },
        "truth_sha256": sha256_file(truth_path),
        "truth": {
            "all_biological": all_biological,
            "after_oracle_qc": oracle,
            "contaminants": generation["contaminants"],
        },
        "parser_expectation": {"outcome": "LOAD_OK", "phase": "data_load"},
        "analysis": {
            "benchmark_models": bool(spec.get("benchmark_models", True)),
            "dna_channel": "DNA-A",
            "bin_count": spec.get("bin_count", 384),
            "histogram_range": spec.get("histogram_range"),
            "peak_regions": regions,
            "views": spec.get("views", ["raw"]),
            "tolerance_percentage_points": spec.get("tolerance_pp", 3.0),
            "expected_by_model": expected_by_model,
        },
        "qc": spec.get("qc"),
    }
    return entry


def _parser_base_rows() -> list[list[float]]:
    return [
        [1_000.25, 0.0],
        [2_000.5, 0.01],
        [4_000.75, 0.02],
        [8_000.0, 0.03],
    ]


def _write_parser_case(output: Path, spec: dict[str, Any]) -> dict[str, Any]:
    fixture_id = spec["id"]
    path = output / "files" / f"{fixture_id}.fcs"
    path.parent.mkdir(parents=True, exist_ok=True)

    if spec.get("raw_bytes") is not None:
        data = spec["raw_bytes"]
        path.write_bytes(data)
        build_sha = hashlib.sha256(data).hexdigest()
    else:
        datatype = spec.get("datatype", "F")
        bits = spec.get("bits", 32 if datatype == "F" else 64 if datatype == "D" else 16)
        default_range = (1 << bits) if datatype == "I" else 262_144
        parameters = spec.get("parameters") or [
            Parameter("DNA-A", bits=bits, range=spec.get("range", default_range)),
            Parameter("Time", bits=bits, range=spec.get("range", default_range)),
        ]
        rows = spec.get("rows", _parser_base_rows())
        build = build_fcs(
            rows,
            parameters,
            datatype=datatype,
            version=spec.get("version", "FCS3.1"),
            little_endian=spec.get("little_endian", True),
            mode=spec.get("mode", "L"),
            nextdata=spec.get("nextdata", 0),
            delimiter=spec.get("delimiter", "|"),
            extra_keywords=spec.get("extra_keywords", ()),
            supplemental_keywords=spec.get("supplemental_keywords", ()),
            packed_integers=spec.get("packed_integers", False),
            header_data_offsets_zero=spec.get("header_data_offsets_zero", False),
            metadata_data_offsets=spec.get("metadata_data_offsets"),
            truncate_data_bytes=spec.get("truncate_data_bytes", 0),
        )
        data = build.data
        for old, new in spec.get("same_length_replacements", ()):
            if len(old) != len(new) or data.count(old) != 1:
                raise ValueError(f"Unsafe parser-fixture replacement for {fixture_id}: {old!r}")
            data = data.replace(old, new)
        append_at = spec.get("append_second_dataset_at")
        if append_at is not None:
            if not isinstance(append_at, int) or append_at < len(data):
                raise ValueError(f"Invalid second-dataset offset for {fixture_id}: {append_at!r}")
            second = build_fcs(
                _parser_base_rows(),
                [Parameter("DNA-A", bits=32), Parameter("Time", bits=32)],
                datatype="F",
                little_endian=True,
                mode="L",
                nextdata=0,
            ).data
            data = data + bytes(append_at - len(data)) + second
        path.write_bytes(data)
        build_sha = hashlib.sha256(data).hexdigest()

    expectation = dict(spec["expectation"])
    expectation.setdefault(
        "phase",
        "header_import" if expectation["outcome"] == "IMPORT_REJECT"
        else "science_validation" if expectation["outcome"] == "ANALYSIS_BLOCK"
        else "data_load",
    )
    return {
        "id": fixture_id,
        "category": "parser_conformance",
        "description": spec["description"],
        "audit_findings": spec.get("audit_findings", ["DATA-02"]),
        "tags": spec.get("tags", []),
        "file": f"files/{fixture_id}.fcs",
        "truth_file": None,
        "fcs": {
            "sha256": build_sha,
            "bytes": len(data),
            "events": spec.get("declared_events", len(spec.get("rows", _parser_base_rows()))),
            "encoding": spec.get("encoding", "parser conformance variant"),
            "channels": [parameter.name for parameter in parameters] if spec.get("raw_bytes") is None else [],
        },
        "parser_expectation": expectation,
        "analysis": {"benchmark_models": False},
    }


SCIENTIFIC_CASES: list[dict[str, Any]] = [
    {
        "id": "truth_clean_70_20_10", "seed": 1001, "biological_events": 12_000,
        "fractions": (0.70, 0.20, 0.10), "category": "known_phase_truth",
        "description": "Clean G1-dominant diploid sample with exact 70/20/10 phase counts.",
        "tags": ["clean", "diploid", "known-truth"], "tolerance_pp": 3.0,
    },
    {
        "id": "truth_clean_50_30_20", "seed": 1002, "biological_events": 12_000,
        "fractions": (0.50, 0.30, 0.20), "category": "known_phase_truth",
        "description": "Clean balanced diploid sample with exact 50/30/20 phase counts.",
        "tags": ["clean", "diploid", "known-truth"], "tolerance_pp": 3.0,
    },
    {
        "id": "truth_s_rich_25_55_20", "seed": 1003, "biological_events": 12_000,
        "fractions": (0.25, 0.55, 0.20), "category": "known_phase_truth",
        "description": "Clean S-rich sample with exact 25/55/20 phase counts.",
        "tags": ["clean", "s-rich", "known-truth"], "tolerance_pp": 3.0,
    },
    {
        "id": "truth_g2_rich_20_20_60", "seed": 1004, "biological_events": 12_000,
        "fractions": (0.20, 0.20, 0.60), "category": "known_phase_truth",
        "description": "Clean G2/M-rich sample with exact 20/20/60 phase counts.",
        "tags": ["clean", "g2-rich", "known-truth"], "tolerance_pp": 3.5,
    },
    {
        "id": "truth_low_s_48_04_48", "seed": 1005, "biological_events": 12_000,
        "fractions": (0.48, 0.04, 0.48), "category": "known_phase_truth",
        "description": "Low-S stress case with exact 48/4/48 phase counts.",
        "tags": ["low-s", "known-truth"], "tolerance_pp": 3.0,
    },
    {
        "id": "truth_dj_early_40_40_20", "seed": 1006, "biological_events": 12_000,
        "fractions": (0.40, 0.40, 0.20), "s_profile": (0.0, -0.6),
        "category": "known_phase_truth",
        "description": "Early-S-enriched quadratic residence profile with exact 40/40/20 phases.",
        "tags": ["dean-jett", "shaped-s", "known-truth"], "tolerance_pp": 3.0,
    },
    {
        "id": "truth_djf_early_wave_45_40_15", "seed": 1010, "biological_events": 50_000,
        "fractions": (0.45, 0.40, 0.15), "s_profile": (0.0, 0.0),
        "fox": (0.30, 0.40, 0.05), "category": "known_phase_truth",
        "description": "Strong early-S Fox-like wave while retaining exact 45/40/15 phase truth.",
        "tags": ["dean-jett-fox", "wave", "known-truth"], "tolerance_pp": 3.5,
        "expected_by_model": {
            "dean_jett": {"kind": "diagnostic"},
            "watson_pragmatic": {"kind": "diagnostic"},
            "dean_jett_fox": {"kind": "recovery", "minimum_wave_weight": 0.10},
        },
    },
    {
        "id": "truth_djf_late_wave_45_40_15", "seed": 1007, "biological_events": 12_000,
        "fractions": (0.45, 0.40, 0.15), "s_profile": (0.0, 0.0),
        "fox": (0.30, 0.75, 0.08), "category": "known_phase_truth",
        "description": "Strong late-S Fox-like wave while retaining exact 45/40/15 phase truth.",
        "tags": ["dean-jett-fox", "wave", "known-truth"], "tolerance_pp": 3.5,
        "expected_by_model": {
            "dean_jett": {"kind": "diagnostic"},
            "watson_pragmatic": {"kind": "diagnostic"},
            "dean_jett_fox": {"kind": "recovery", "minimum_wave_weight": 0.10},
        },
    },
    {
        "id": "truth_high_cv_overlap_35_45_20", "seed": 1008, "biological_events": 12_000,
        "fractions": (0.35, 0.45, 0.20), "g1_cv": 0.10, "g2_cv": 0.11,
        "peak_regions": {
            "g1": {"left": 44_800, "right": 89_600},
            "g2": {"left": 102_400, "right": 179_200},
        },
        "category": "known_phase_truth",
        "description": "Broad, overlapping peaks challenge identifiability without changing exact truth.",
        "tags": ["overlap", "high-cv", "known-truth", "conditioning"], "tolerance_pp": 6.0,
    },
    {
        "id": "truth_low_count_55_30_15", "seed": 1009, "biological_events": 2_000,
        "fractions": (0.55, 0.30, 0.15), "category": "known_phase_truth",
        "description": "Low-count clean sample for precision and convergence behavior.",
        "tags": ["low-count", "known-truth", "convergence"], "tolerance_pp": 6.0,
    },
    {
        "id": "watson_subg1_contamination", "seed": 2001, "biological_events": 8_000,
        "fractions": (0.50, 0.30, 0.20), "contaminants": {"sub_g1": 2_000},
        "category": "scientific_adversarial",
        "description": "Known 50/30/20 biology plus 2,000 sub-G1 debris events; exposes residual-S leakage.",
        "audit_findings": ["SCI-01"], "tags": ["watson", "sub-g1", "contamination"],
        "views": ["raw", "oracle_qc"], "tolerance_pp": 5.0,
    },
    {
        "id": "watson_postg2_contamination", "seed": 2002, "biological_events": 8_000,
        "fractions": (0.50, 0.30, 0.20), "contaminants": {"post_g2": 2_000},
        "category": "scientific_adversarial",
        "description": "Known 50/30/20 biology plus 2,000 post-G2 events; exposes residual-S leakage.",
        "audit_findings": ["SCI-01"], "tags": ["watson", "post-g2", "contamination"],
        "views": ["raw", "oracle_qc"], "tolerance_pp": 5.0,
    },
    {
        "id": "watson_mixed_contamination", "seed": 2003, "biological_events": 8_000,
        "fractions": (0.50, 0.30, 0.20),
        "contaminants": {"sub_g1": 1_000, "post_g2": 1_000, "aggregate": 1_000},
        "category": "scientific_adversarial",
        "description": "Sub-G1, post-G2, and aggregate mixture with known biological denominator.",
        "audit_findings": ["SCI-01", "SCI-09"], "tags": ["watson", "mixed-contamination"],
        "views": ["raw", "oracle_qc"], "tolerance_pp": 6.0,
    },
    {
        "id": "ratio_nondiploid_1p50", "seed": 2004, "biological_events": 8_000,
        "fractions": (0.50, 0.30, 0.20), "g2_ratio": 1.50,
        "category": "scientific_adversarial",
        "description": "Peak ratio 1.50 lies outside the default bounded diploid interval.",
        "audit_findings": ["SCI-02"], "tags": ["ratio", "aneuploid", "constraint"],
        "tolerance_pp": 8.0,
    },
    {
        "id": "arrest_g1_95_04_01", "seed": 2008, "biological_events": 12_000,
        "fractions": (0.95, 0.04, 0.01),
        "category": "scientific_adversarial",
        "description": "Deep diploid G1 arrest at a true 2.0 peak ratio: G2/M exists but is far too small for the detector to resolve as a peak, so detection falls back to an inferred G2.",
        "audit_findings": [], "tags": ["arrest", "g1-arrest", "diploid", "low-g2", "inferred-g2"],
        "tolerance_pp": 8.0,
    },
    {
        "id": "ratio_projector_regions_1_10_18_20", "seed": 2007, "biological_events": 8_000,
        "fractions": (0.50, 0.30, 0.20), "g1_mean": 2.0, "g2_ratio": 9.0,
        "g1_cv": 0.03, "g2_cv": 0.03,
        "peak_regions": {"g1": {"left": 1.0, "right": 10.0}, "g2": {"left": 18.0, "right": 20.0}},
        "histogram_range": [0.0, 22.0],
        "category": "scientific_adversarial",
        "description": "Exact audit counterexample: feasible ratio bounds exist in the regions, but the observed peaks start near 2 and 18.",
        "audit_findings": ["SCI-02"], "tags": ["ratio", "projection", "exact-counterexample"],
        "tolerance_pp": 20.0,
    },
    {
        "id": "tail_mass_clipped_domain", "seed": 2005, "biological_events": 8_000,
        "fractions": (0.50, 0.30, 0.20), "g1_cv": 0.10, "g2_cv": 0.10,
        "histogram_range": [57_600, 134_400],
        "peak_regions": {"g1": {"left": 57_600, "right": 76_800}, "g2": {"left": 108_800, "right": 134_400}},
        "category": "scientific_adversarial",
        "description": "Explicitly clipped histogram leaves fitted component tails outside the visible domain.",
        "audit_findings": ["SCI-05"], "tags": ["tail-mass", "visible-domain", "reporting"],
        "tolerance_pp": 8.0,
    },
    {
        "id": "bulk_scale_reference", "seed": 2006, "biological_events": 6_000,
        "fractions": (0.50, 0.30, 0.20), "category": "scientific_adversarial",
        "description": "Reference calibration for the cross-scale bulk-region pair.",
        "audit_findings": ["SCI-06"], "tags": ["bulk-fit", "scale-pair"], "tolerance_pp": 4.0,
    },
    {
        "id": "bulk_scale_x10", "seed": 2006, "biological_events": 6_000,
        "fractions": (0.50, 0.30, 0.20), "dna_scale": 10.0,
        "category": "scientific_adversarial",
        "description": "Same latent events as bulk_scale_reference but DNA channels are scaled by 10.",
        "audit_findings": ["SCI-06", "SCI-07"], "tags": ["bulk-fit", "scale-pair", "conditioning"],
        "tolerance_pp": 5.0,
    },
    {
        "id": "qc_scatter_high_fsc_artifact", "seed": 3001, "biological_events": 8_000,
        "fractions": (0.55, 0.30, 0.15), "contaminants": {"high_fsc_artifact": 1_500},
        "category": "qc_adversarial",
        "description": "Compact high-FSC artifact minority challenges the greatest-FSC cloud heuristic.",
        "audit_findings": ["SCI-09"], "tags": ["scatter", "gmm", "review-required"],
        "qc": {"kind": "scatter", "minimum_good_retention": 0.90, "minimum_bad_rejection": 0.90, "require_review_for_adversary": True},
        "views": ["raw", "oracle_qc"], "benchmark_models": False,
    },
    {
        "id": "qc_pulse_h_scale_reference", "seed": 3002, "biological_events": 6_000,
        "fractions": (0.55, 0.30, 0.15), "category": "qc_adversarial",
        "description": "Reference A/H pulse geometry for the independent-axis scale pair.",
        "audit_findings": ["SCI-09"], "tags": ["pulse", "scale-pair"], "benchmark_models": False,
        "qc": {"kind": "pulse", "minimum_good_retention": 0.98, "metamorphic_pair": "qc_pulse_h_scale_x100"},
    },
    {
        "id": "qc_pulse_h_scale_x100", "seed": 3002, "biological_events": 6_000,
        "fractions": (0.55, 0.30, 0.15), "dna_h_scale": 100.0,
        "category": "qc_adversarial",
        "description": "Same A values/truth as the pulse reference with only DNA-H scaled by 100.",
        "audit_findings": ["SCI-09"], "tags": ["pulse", "scale-pair", "raw-units"],
        "benchmark_models": False,
        "qc": {"kind": "pulse", "minimum_good_retention": 0.98, "metamorphic_pair": "qc_pulse_h_scale_reference"},
    },
    {
        "id": "qc_pulse_doublets", "seed": 3008, "biological_events": 8_000,
        "fractions": (0.55, 0.30, 0.15), "contaminants": {"aggregate": 1_000},
        "category": "qc_adversarial",
        "description": "Known singlets plus 1,000 wider aggregate/doublet-like pulse events.",
        "audit_findings": ["SCI-09"], "tags": ["pulse", "doublet", "oracle-mask"],
        "benchmark_models": False,
        "qc": {"kind": "pulse", "minimum_good_retention": 0.98, "minimum_bad_rejection": 0.90},
    },
    {
        "id": "qc_time_rate_drop", "seed": 3003, "biological_events": 6_000,
        "fractions": (0.55, 0.30, 0.15), "anomaly": "rate_drop",
        "category": "qc_adversarial",
        "description": "Middle 20% has fivefold slower event arrival with otherwise stable biology.",
        "audit_findings": ["SCI-09", "SCI-12"], "tags": ["time-qc", "rate-drop"], "benchmark_models": False,
        "qc": {"kind": "time_robust", "minimum_good_retention": 0.95, "minimum_bad_rejection": 0.80},
    },
    {
        "id": "qc_time_gain_drift", "seed": 3004, "biological_events": 6_000,
        "fractions": (0.55, 0.30, 0.15), "anomaly": "gain_drift",
        "category": "qc_adversarial",
        "description": "Middle 20% has a planted 16% DNA gain shift.",
        "audit_findings": ["SCI-09"], "tags": ["time-qc", "gain-drift"], "benchmark_models": False,
        "qc": {"kind": "time_peak_tracking", "minimum_good_retention": 0.90, "minimum_bad_rejection": 0.70},
    },
    {
        "id": "qc_time_peak_disappearance", "seed": 3005, "biological_events": 6_000,
        "fractions": (0.55, 0.30, 0.15), "anomaly": "peak_disappearance",
        "category": "qc_adversarial",
        "description": "G2 measurements collapse onto G1 in the middle 20%, removing one observed mode.",
        "audit_findings": ["SCI-09"], "tags": ["time-qc", "missing-mode", "peak-tracking"],
        "benchmark_models": False,
        "qc": {"kind": "time_peak_tracking", "minimum_good_retention": 0.90, "minimum_bad_rejection": 0.70},
    },
    {
        "id": "qc_structural_nonfinite_negative", "seed": 3006, "biological_events": 200,
        "fractions": (0.55, 0.30, 0.15), "anomaly": "structural_invalid",
        "category": "qc_adversarial",
        "description": "Known NaN, infinities, negative DNA, and PnR-boundary event indexes.",
        "audit_findings": ["DATA-02"], "tags": ["stage-0", "nonfinite", "bounds"],
        "benchmark_models": False,
        "qc": {"kind": "structural_exact"},
    },
    {
        "id": "qc_missing_companion_channels", "seed": 3007, "biological_events": 2_000,
        "fractions": (0.55, 0.30, 0.15), "channels": ("DNA-A",),
        "category": "qc_adversarial",
        "description": "Valid DNA-A with no Time, scatter, height, or width companions.",
        "audit_findings": [], "tags": ["missing-companions", "optional-skip"],
        "benchmark_models": False,
        "qc": {"kind": "missing_companions"},
    },
]


PARSER_CASES: list[dict[str, Any]] = [
    {
        "id": "parser_fcs20_linear", "version": "FCS2.0",
        "description": "Valid FCS 2.0 linear float32 list-mode data.",
        "encoding": "FCS2.0/F32/little-endian/list",
        "expectation": {"outcome": "LOAD_OK", "first_row": {"DNA-A": 1000.25}},
    },
    {
        "id": "parser_fcs30_linear", "version": "FCS3.0",
        "description": "Valid FCS 3.0 linear float32 list-mode data.",
        "encoding": "FCS3.0/F32/little-endian/list",
        "expectation": {"outcome": "LOAD_OK", "first_row": {"DNA-A": 1000.25}},
    },
    {
        "id": "parser_fcs10_unsupported", "version": "FCS1.0",
        "description": "FCS 1.0 is outside the supported event-analysis contract.",
        "encoding": "FCS1.0/F32/little-endian/list",
        "expectation": {"outcome": "ANALYSIS_BLOCK", "code": "FCS_VERSION_UNSUPPORTED"},
        "audit_findings": ["DATA-01", "DATA-06"],
    },
    {
        "id": "parser_f32_little_endian",
        "description": "Valid little-endian IEEE float32 list-mode data.",
        "encoding": "FCS3.1/F32/little-endian/list",
        "expectation": {"outcome": "LOAD_OK", "first_row": {"DNA-A": 1000.25}},
    },
    {
        "id": "parser_f64_big_endian", "datatype": "D", "bits": 64, "little_endian": False,
        "description": "Valid big-endian IEEE float64 list-mode data.",
        "encoding": "FCS3.1/F64/big-endian/list",
        "expectation": {"outcome": "LOAD_OK", "first_row": {"DNA-A": 1000.25, "Time": 0.0}},
    },
    {
        "id": "parser_f32_big_endian", "datatype": "F", "bits": 32, "little_endian": False,
        "description": "Valid big-endian IEEE float32 list-mode data.",
        "encoding": "FCS3.1/F32/big-endian/list",
        "expectation": {"outcome": "LOAD_OK", "first_row": {"DNA-A": 1000.25, "Time": 0.0}},
    },
    {
        "id": "parser_i16_big_endian", "datatype": "I", "bits": 16, "little_endian": False,
        "rows": [[0, 65535], [1, 65534], [4095, 32768], [65535, 0]],
        "description": "Valid big-endian unsigned 16-bit integer data.",
        "encoding": "FCS3.1/I16/big-endian/list",
        "expectation": {"outcome": "LOAD_OK", "first_row": {"DNA-A": 0, "Time": 65535}},
    },
    {
        "id": "parser_i12_packed", "datatype": "I", "bits": 12, "little_endian": True,
        "rows": [[0xABC, 0x123], [0xFFF, 0], [1, 0x800], [0x321, 0xFED]],
        "packed_integers": True,
        "description": "Continuously packed 12-bit integer fields; must decode exactly or reject explicitly.",
        "encoding": "FCS3.1/I12/packed/little-endian",
        "expectation": {"outcome": "IMPORT_REJECT", "code": "FCS_PACKED_INTEGER_UNSUPPORTED"},
    },
    {
        "id": "parser_i64_unsafe", "datatype": "I", "bits": 64, "little_endian": True,
        "range": 2**64,
        "rows": [[2**60 + 3, 2**60 + 5], [2**53 + 1, 2**53 + 3]],
        "description": "Unsigned 64-bit values above JavaScript's exact integer range.",
        "encoding": "FCS3.1/I64/little-endian",
        "expectation": {"outcome": "IMPORT_REJECT", "code": "FCS_INTEGER_PRECISION_UNSUPPORTED"},
    },
    {
        "id": "parser_truncated_data", "truncate_data_bytes": 1,
        "description": "DATA segment is one byte shorter than $TOT times event stride.",
        "expectation": {"outcome": "IMPORT_REJECT", "code": "FCS_DATA_TRUNCATED"},
    },
    {
        "id": "parser_data_offset_oob", "metadata_data_offsets": (999_999, 1_000_030),
        "description": "TEXT DATA offsets point beyond end-of-file and conflict with HEADER offsets.",
        "expectation": {"outcome": "IMPORT_REJECT", "code": "FCS_OFFSET_CONFLICT"},
    },
    {
        "id": "parser_tot_allocation_mismatch", "extra_keywords": [("$TOT", "100000")],
        "declared_events": 100_000,
        "description": "Tiny DATA segment declares 100,000 events to test preallocation/length bounds.",
        "expectation": {"outcome": "IMPORT_REJECT", "code": "FCS_DATA_LENGTH_MISMATCH"},
    },
    {
        "id": "parser_escaped_text_delimiter", "extra_keywords": [("$SAMPLEID", "alpha|beta")],
        "description": "TEXT value contains an escaped literal delimiter.",
        "expectation": {"outcome": "LOAD_OK", "metadata": {"SAMPLEID": "alpha|beta"}},
    },
    {
        "id": "parser_supplemental_text", "supplemental_keywords": [("$SAMPLEID", "from-supplemental-text")],
        "description": "Supplemental TEXT is rejected explicitly rather than silently ignored.",
        "expectation": {"outcome": "IMPORT_REJECT", "code": "FCS_SUPPLEMENTAL_TEXT_UNSUPPORTED"},
    },
    {
        "id": "parser_header_zero_data_offsets", "header_data_offsets_zero": True,
        "description": "HEADER DATA offsets are zero and valid extended offsets live in TEXT.",
        "expectation": {"outcome": "LOAD_OK", "first_row": {"DNA-A": 1000.25}},
    },
    {
        "id": "parser_log_amplified_dna", "parameters": [
            Parameter("DNA-A", bits=32, range=1024, exponent="4,1"),
            Parameter("Time", bits=32, range=262144),
        ],
        "description": "Selected DNA parameter declares logarithmic amplification metadata.",
        "expectation": {"outcome": "ANALYSIS_BLOCK", "code": "FCS_DNA_TRANSFORM_UNSUPPORTED"},
        "audit_findings": ["DATA-01"],
    },
    {
        "id": "parser_nonunit_gain_dna", "parameters": [
            Parameter("DNA-A", bits=32, range=262144, gain="10"),
            Parameter("Time", bits=32, range=262144),
        ],
        "description": "Selected DNA parameter declares non-unit gain.",
        "expectation": {"outcome": "ANALYSIS_BLOCK", "code": "FCS_DNA_TRANSFORM_UNSUPPORTED"},
        "audit_findings": ["DATA-01"],
    },
    {
        "id": "parser_spillover_dna",
        "parameters": [
            Parameter("DNA-A", bits=32, range=262144),
            Parameter("FSC-A", bits=32, range=262144),
            Parameter("Time", bits=32, range=262144),
        ],
        "rows": [
            [1_000.25, 90_000.0, 0.0],
            [2_000.5, 95_000.0, 0.01],
            [4_000.75, 100_000.0, 0.02],
            [8_000.0, 105_000.0, 0.03],
        ],
        "extra_keywords": [("$SPILLOVER", "2,DNA-A,FSC-A,1,0.1,0.2,1")],
        "description": "Spillover matrix includes the selected DNA channel.",
        "expectation": {"outcome": "ANALYSIS_BLOCK", "code": "FCS_COMPENSATION_REQUIRED"},
        "audit_findings": ["DATA-01"],
    },
    {
        "id": "parser_spillover_other",
        "parameters": [Parameter("DNA-A"), Parameter("FSC-A"), Parameter("SSC-A")],
        "rows": [[1000.25, 90000.0, 80000.0], [2000.5, 95000.0, 85000.0]],
        "extra_keywords": [("$SPILLOVER", "2,FSC-A,SSC-A,1,0.1,0.2,1")],
        "description": "A spillover matrix that excludes DNA-A does not block the DNA channel.",
        "expectation": {"outcome": "LOAD_OK", "first_row": {"DNA-A": 1000.25}},
        "audit_findings": ["DATA-01"],
    },
    {
        "id": "parser_non_list_mode", "mode": "C",
        "description": "Correlated/non-list MODE must not enter list-mode analysis.",
        "expectation": {"outcome": "ANALYSIS_BLOCK", "code": "FCS_MODE_UNSUPPORTED"},
        "audit_findings": ["DATA-01"],
    },
    {
        "id": "parser_nextdata_nonzero", "nextdata": 4096,
        "append_second_dataset_at": 4096,
        "description": "Nonzero $NEXTDATA points to a second FCS HEADER at byte 4096; chained datasets are unsupported.",
        "expectation": {"outcome": "ANALYSIS_BLOCK", "code": "FCS_MULTIPLE_DATASETS_UNSUPPORTED"},
        "audit_findings": ["DATA-01"],
    },
    {
        "id": "parser_unknown_byte_order", "extra_keywords": [("$BYTEORD", "9,9,9,9")],
        "description": "Unknown byte-order declaration must not silently fall back to big endian.",
        "expectation": {"outcome": "IMPORT_REJECT", "code": "FCS_BYTE_ORDER_INVALID"},
        "audit_findings": ["DATA-02"],
    },
    {
        "id": "parser_invalid_dna_range", "parameters": [
            Parameter("DNA-A", bits=32, range=0), Parameter("Time", bits=32, range=262144),
        ],
        "description": "Selected DNA channel has an invalid zero $PnR.",
        "expectation": {"outcome": "ANALYSIS_BLOCK", "code": "FCS_DNA_RANGE_INVALID"},
        "audit_findings": ["DATA-01", "DATA-02"],
    },
    {
        "id": "parser_unsupported_ascii", "description": "ASCII $DATATYPE is outside PhaseFinder's supported numeric contract.",
        "same_length_replacements": [(b"|$DATATYPE|F|", b"|$DATATYPE|A|")],
        "expectation": {"outcome": "IMPORT_REJECT", "code": "FCS_DATATYPE_UNSUPPORTED"},
        "audit_findings": ["DATA-02"],
    },
    {
        "id": "parser_short_header", "description": "A 17-byte pseudo-FCS file cannot contain a fixed HEADER.",
        "raw_bytes": b"FCS3.1 short file",
        "declared_events": 0,
        "expectation": {"outcome": "IMPORT_REJECT", "code": "FCS_HEADER_TRUNCATED"},
        "audit_findings": ["DATA-02"],
    },
    {
        "id": "parser_huge_par", "extra_keywords": [("$PAR", "1025")],
        "description": "A parameter count above the configured limit is rejected before allocation.",
        "expectation": {"outcome": "IMPORT_REJECT", "code": "FCS_PARAMETER_LIMIT_EXCEEDED"},
        "audit_findings": ["DATA-02"],
    },
]

PARSER_CASES.extend({
    "id": f"parser_i{bits}_little_endian",
    "datatype": "I",
    "bits": bits,
    "little_endian": True,
    "rows": [[1, 2], [min((1 << bits) - 1, 1_000_003), 7]],
    "description": f"Valid little-endian unsigned {bits}-bit byte-aligned integer data.",
    "encoding": f"FCS3.1/I{bits}/little-endian/list",
    "expectation": {"outcome": "LOAD_OK", "first_row": {"DNA-A": 1, "Time": 2}},
} for bits in (8, 16, 24, 32, 40, 48))


def _coverage() -> dict[str, Any]:
    return {
        "fcs_triggerable": {
            "SCI-01": ["watson_subg1_contamination", "watson_postg2_contamination", "watson_mixed_contamination"],
            "SCI-02": ["ratio_nondiploid_1p50", "ratio_projector_regions_1_10_18_20"],
            "SCI-07": ["truth_high_cv_overlap_35_45_20", "bulk_scale_x10"],
            "SCI-09": ["qc_scatter_high_fsc_artifact", "qc_pulse_h_scale_reference", "qc_pulse_h_scale_x100", "qc_pulse_doublets", "qc_time_rate_drop", "qc_time_gain_drift", "qc_time_peak_disappearance"],
            "SCI-12": ["qc_time_rate_drop"],
            "DATA-01": ["parser_log_amplified_dna", "parser_nonunit_gain_dna", "parser_spillover_dna", "parser_non_list_mode", "parser_nextdata_nonzero"],
            "DATA-02": ["parser_f64_big_endian", "parser_f32_big_endian", "parser_i16_big_endian", "parser_i12_packed", "parser_i64_unsafe", "parser_truncated_data", "parser_data_offset_oob", "parser_tot_allocation_mismatch", "parser_supplemental_text", "parser_unknown_byte_order"],
        },
        "hybrid_fcs_plus_non_fcs_assertion": {
            "SCI-03": {"fixtures": ["truth_low_count_55_30_15", "truth_high_cv_overlap_35_45_20", "bulk_scale_x10"], "also_requires": "Direct solver termination-reason/gradient/step assertions."},
            "SCI-04": {"fixtures": ["truth_low_count_55_30_15", "truth_djf_late_wave_45_40_15"], "also_requires": "Forced candidate convergence states or hand-built candidate results."},
            "SCI-05": {"fixtures": ["tail_mass_clipped_domain"], "also_requires": "Render/table/sidebar/export consumer comparison."},
            "SCI-06": {"fixtures": ["bulk_scale_reference", "bulk_scale_x10"], "also_requires": "Auto-Fit-All UI/orchestration driver."},
            "SCI-08": {"fixtures": ["truth_dj_early_40_40_20", "truth_djf_early_wave_45_40_15", "truth_djf_late_wave_45_40_15"], "also_requires": "Direct invalid-profile projection assertions."},
        },
        "requires_non_fcs_tests": {
            "REL-01/02/03": "Build artifacts, workflows, and dependency/runtime tests.",
            "UI-01/02/03/04/05": "DOM, modal-state, viewport, accessibility, and injected-error tests.",
            "SES-01/02 and SEC-01": "OPFS/session identity, cleanup, and malicious TOML tests.",
            "CI-01/02": "Workflow execution and runner-exit-code tests.",
            "DATA-03": "Instrumented File.slice/worker transfer and heap tests, not committed large FCS bytes.",
            "DATA-04": "Injected companion-worker/OPFS/read failure under a user-required gate; the DNA-only fixture verifies only legitimate optional-skip behavior.",
            "DATA-05 and SEC-02": "CSV/TSV import/export fixtures.",
            "SCI-03/04/08/10": "Direct solver, candidate-selection, profile-projection, and information-metric reference tests; FCS stress alone cannot establish these implementation contracts.",
        },
    }


def _build_corpus(output: Path) -> Path:
    output.mkdir(parents=True, exist_ok=True)
    files_dir = output / "files"
    files_dir.mkdir(parents=True, exist_ok=True)

    entries = [_write_scientific_case(output, spec) for spec in SCIENTIFIC_CASES]
    entries.extend(_write_parser_case(output, spec) for spec in PARSER_CASES)
    entries.sort(key=lambda entry: entry["id"])

    manifest = {
        "schema_version": SCHEMA_VERSION,
        "name": "PhaseFinder deterministic synthetic FCS audit corpus",
        "case_count": len(entries),
        "contains_real_data": False,
        "license": "PolyForm-Noncommercial-1.0.0 (same as repository)",
        "generator": {
            "name": GENERATOR_NAME,
            "version": GENERATOR_VERSION,
            "command": "python3 tests/validation/validation_test_data/synthetic_fcs/generate_fixtures.py",
            "randomness": "Named SHA-256-derived Python Random streams; committed artifacts are hash-pinned.",
        },
        "phase_fraction_definition": (
            "Underlying truth uses exact empirical G1+S+G2/M labels; phase-less contaminants are excluded. "
            "Post-oracle truth additionally removes planted structural-invalid, time-excluded, and non-biological events."
        ),
        "cases": entries,
        "coverage": _coverage(),
    }
    manifest_path = output / "manifest.json"
    _write_json(manifest_path, manifest)
    return manifest_path


def _owned_generated_paths(output: Path) -> set[Path]:
    """Return only paths claimed by a prior manifest from this generator."""

    manifest_path = output / "manifest.json"
    if not manifest_path.is_file():
        return set()
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return set()
    if manifest.get("generator", {}).get("name") != GENERATOR_NAME:
        return set()
    owned = {Path("manifest.json")}
    for case in manifest.get("cases", []):
        for key in ("file", "truth_file"):
            value = case.get(key)
            if not value:
                continue
            relative = Path(value)
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError(f"Unsafe path in prior synthetic-FCS manifest: {value}")
            if not relative.parts or relative.parts[0] != "files" or not (
                relative.suffix == ".fcs" or relative.name.endswith(".truth.json")
            ):
                raise ValueError(f"Non-corpus path in prior synthetic-FCS manifest: {value}")
            owned.add(relative)
    return owned


def generate(output: Path) -> Path:
    """Build in a sibling staging directory and publish only owned artifacts."""

    output.parent.mkdir(parents=True, exist_ok=True)
    previous = _owned_generated_paths(output)
    with tempfile.TemporaryDirectory(prefix=".phasefinder-fcs-stage-", dir=output.parent) as temp_name:
        staged = Path(temp_name)
        staged_manifest = _build_corpus(staged)
        generated = _relative_generated_files(staged)
        output.mkdir(parents=True, exist_ok=True)
        (output / "files").mkdir(parents=True, exist_ok=True)

        collisions = [
            relative for relative in generated
            if (output / relative).exists() and relative not in previous
        ]
        if collisions:
            joined = ", ".join(map(str, collisions))
            raise FileExistsError(
                "Refusing to overwrite files not owned by a prior synthetic-FCS manifest: "
                f"{joined}"
            )

        # Publish data and truth first, then the manifest as the commit marker.
        for relative in generated:
            if relative == Path("manifest.json"):
                continue
            destination = output / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            (staged / relative).replace(destination)
        staged_manifest.replace(output / "manifest.json")

        for relative in sorted(previous - set(generated)):
            stale = output / relative
            if stale.is_file():
                stale.unlink()
    return output / "manifest.json"


def _relative_generated_files(root: Path) -> list[Path]:
    paths = [Path("manifest.json")]
    paths.extend(path.relative_to(root) for path in sorted((root / "files").iterdir()) if path.is_file())
    return paths


def check(canonical: Path) -> int:
    with tempfile.TemporaryDirectory(prefix="phasefinder-fcs-check-") as temp_name:
        generated = Path(temp_name)
        generate(generated)
        expected_paths = _relative_generated_files(generated)
        canonical_paths = _relative_generated_files(canonical) if (canonical / "manifest.json").exists() else []
        if expected_paths != canonical_paths:
            print("Generated file list differs from the committed corpus.", file=sys.stderr)
            print("expected:", *map(str, expected_paths), sep="\n  ", file=sys.stderr)
            print("committed:", *map(str, canonical_paths), sep="\n  ", file=sys.stderr)
            return 1
        mismatches = [
            relative for relative in expected_paths
            if (generated / relative).read_bytes() != (canonical / relative).read_bytes()
        ]
        if mismatches:
            print("Regeneration mismatch:", *map(str, mismatches), sep="\n  ", file=sys.stderr)
            return 1
    print(f"Synthetic FCS corpus is reproducible ({len(expected_paths)} files checked).")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--check", action="store_true", help="Regenerate in a temporary directory and byte-compare.")
    args = parser.parse_args()
    output = args.output.resolve()
    if args.check:
        return check(output)
    manifest = generate(output)
    case_count = len(json.loads(manifest.read_text(encoding="utf-8"))["cases"])
    print(f"Generated {case_count} synthetic FCS cases at {output}")
    print(f"Manifest: {manifest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
