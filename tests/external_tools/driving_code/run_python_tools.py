#!/usr/bin/env python3
"""Fit the DNA channel of the FlowJo reference samples with INDEPENDENT Python
tools, so PhaseFinder's peak placement can be checked against something that is
neither PhaseFinder nor FlowJo.

What this can and cannot establish
----------------------------------
None of the mainstream open-source flow packages implement Dean-Jett-Fox or
Watson; they are I/O, transform, gating and calibration frameworks. So this does
NOT compare cell-cycle models. What it does compare is the thing our own
measurements point at as the fault: WHERE THE PEAKS ARE.

A two-component Gaussian mixture on the DNA channel is model-agnostic -- it has
no S-phase term and makes no cell-cycle assumption -- but it does locate the two
dominant DNA populations. If an independent mixture puts G1 near FlowJo's value
and PhaseFinder does not, peak placement is confirmed as the defect. If all
three agree on the peaks, the disagreement lives in the S-phase model instead.

A mixture fit therefore yields G1/G2 MEANS and CVs, not %S. Do not read its
component weights as phase fractions: everything between the peaks is forced
into one Gaussian or the other, so its "fractions" are not cell-cycle fractions.

Usage:
  run_python_tools.py [--limit N] [--out results/python_tools.json]
"""

from __future__ import annotations

import argparse
import json
import sys
import warnings
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
DATA = ROOT.parent / "test_flow_data" / "Asynchronous_UsedAsFloJoDFJSampleDataset"
REF = ROOT / "tests/validation/validation_test_data/external_fcs/datasets/flowjo_async_djf/flowjo_djf_reference.json"

# The DNA channel the FlowJo reference set is pinned to (SYTOX Green).
DNA_CHANNEL_PATTERN = ("GFP", "FITC", "FL7")


def load_dna(path):
    """Read the DNA channel with FlowKit, falling back to fcsparser.

    Two readers rather than one so a parse quirk in either cannot silently
    become a 'tool disagreement' in the report.
    """
    try:
        import flowkit as fk
        sample = fk.Sample(str(path), ignore_offset_error=True)
        names = list(sample.pnn_labels)
        idx = next((i for i, n in enumerate(names)
                    if any(tag.lower() in n.lower() for tag in DNA_CHANNEL_PATTERN)), None)
        if idx is None:
            return None, f"no DNA channel in {names[:8]}"
        events = sample.as_dataframe(source="raw").to_numpy()[:, idx]
        return np.asarray(events, dtype=float), f"flowkit:{names[idx]}"
    except Exception as flowkit_error:
        try:
            import fcsparser
            _, frame = fcsparser.parse(str(path), reformat_meta=False)
            col = next((c for c in frame.columns
                        if any(tag.lower() in str(c).lower() for tag in DNA_CHANNEL_PATTERN)), None)
            if col is None:
                return None, f"no DNA channel in {list(frame.columns)[:8]}"
            return frame[col].to_numpy(dtype=float), f"fcsparser:{col}"
        except Exception as parser_error:
            return None, f"flowkit: {flowkit_error} | fcsparser: {parser_error}"


def gaussian_mixture_peaks(values, n_components=2, seed=0):
    """Two-component 1D Gaussian mixture on the DNA channel.

    scikit-learn's GaussianMixture is the same EM routine CytoFlow's
    GaussianMixtureOp wraps, applied directly so the comparison does not depend
    on CytoFlow's Experiment/metadata scaffolding.

    Events at or below zero are dropped: they are not DNA content, and a
    Gaussian mixture has no debris term to absorb them.
    """
    from sklearn.mixture import GaussianMixture

    finite = values[np.isfinite(values) & (values > 0)]
    if finite.size < 500:
        return {"error": f"only {finite.size} usable events"}

    # Trim the extreme upper tail so aggregates/doublets cannot capture a whole
    # component; the two DNA peaks are well inside this.
    upper = np.percentile(finite, 99.5)
    trimmed = finite[finite <= upper].reshape(-1, 1)

    model = GaussianMixture(n_components=n_components, random_state=seed,
                            covariance_type="full", n_init=5, max_iter=500)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        model.fit(trimmed)

    means = model.means_.ravel()
    sigmas = np.sqrt(model.covariances_.ravel())
    weights = model.weights_.ravel()
    order = np.argsort(means)
    means, sigmas, weights = means[order], sigmas[order], weights[order]
    return {
        "g1_mean": float(means[0]),
        "g2_mean": float(means[-1]),
        "g1_cv": float(sigmas[0] / means[0]) if means[0] else None,
        "g2_cv": float(sigmas[-1] / means[-1]) if means[-1] else None,
        "g2_g1_ratio": float(means[-1] / means[0]) if means[0] else None,
        # Explicitly NOT phase fractions -- a mixture has no S-phase component,
        # so everything between the peaks is forced into one of the two.
        "component_weights": [float(w) for w in weights],
        "converged": bool(model.converged_),
        "n_events": int(trimmed.size),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int)
    ap.add_argument("--out", default=str(ROOT / "tests/external_tools/results/python_tools.json"))
    args = ap.parse_args()

    reference = json.loads(REF.read_text())
    by_file = {s["fcs"]["filename"]: s for s in reference["samples"]}

    files = sorted(DATA.glob("*.fcs"))
    if args.limit:
        files = files[: args.limit]

    rows = []
    for index, path in enumerate(files, 1):
        meta = by_file.get(path.name, {})
        record = {
            "file": path.name,
            "strain": meta.get("strain", "?"),
            "flowjo": (meta.get("references") or {}).get("flowjo_djf", {}),
        }
        values, source = load_dna(path)
        record["reader"] = source
        if values is None:
            record["error"] = source
        else:
            record["gmm"] = gaussian_mixture_peaks(values)
        rows.append(record)
        summary = record.get("gmm", {})
        print(f"[{index}/{len(files)}] {record['strain']:>7} "
              f"{'ERR ' + str(record.get('error'))[:60] if record.get('error') else
                 f'''G1 {summary.get('g1_mean', float('nan')):.0f}  G2 {summary.get('g2_mean', float('nan')):.0f}'''}",
              flush=True)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rows, indent=1))
    print(f"\nwrote {out}")


if __name__ == "__main__":
    main()
