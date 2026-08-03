#!/usr/bin/env python3
"""Build the three-way peak-position comparison report.

PhaseFinder vs FlowJo (Dean-Jett-Fox) vs an INDEPENDENT open-source measurement.

Why peak position and not phase fractions: none of the mainstream open-source
flow packages (flowCore, openCyto, flowWorkspace, CytoExploreR, FlowCal,
FlowKit, CytoFlow, muon) implement Dean-Jett-Fox or Watson -- they are I/O,
transform, gating and calibration frameworks. So a model-vs-model comparison is
not available from them. What IS available, and what our own measurements point
at as the fault, is where the two DNA populations sit. A two-component Gaussian
mixture is model-agnostic -- no S-phase term, no cell-cycle assumption -- but it
locates the peaks, which is exactly the disputed quantity.

Reads results/python_tools.json (+ results/flowploidy.json when present) and the
PhaseFinder fitted values, and writes results/tool_comparison.html.
"""

from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
RESULTS = ROOT / "tests/external_tools/results"

# Agreement band used throughout: FlowJo reports peak means to 3 significant
# figures, so 5% is comfortably outside its own reporting precision while still
# tight enough that a period-doubled call (~1.6x) can never pass.
AGREEMENT = 0.05
DOUBLED = 1.35


def load(path, default=None):
    p = Path(path)
    if not p.exists():
        return default
    try:
        return json.loads(p.read_text())
    except Exception:
        return default


def collect(phasefinder_path):
    gmm_rows = load(RESULTS / "python_tools.json", []) or []
    ploidy_rows = load(RESULTS / "flowploidy.json", []) or []
    pf_rows = [r for r in (load(phasefinder_path, []) or []) if not r.get("error")]

    ploidy_by_file = {r.get("file"): r for r in ploidy_rows if isinstance(r, dict)}
    pf_by_strain = {r["strain"]: r for r in pf_rows}

    merged = []
    for row in gmm_rows:
        strain = row.get("strain")
        flowjo = row.get("flowjo") or {}
        gmm = row.get("gmm") or {}
        pf = pf_by_strain.get(strain) or {}
        ploidy = ploidy_by_file.get(row.get("file")) or {}
        merged.append({
            "strain": strain,
            "file": row.get("file"),
            "reader": row.get("reader"),
            "flowjo_g1": flowjo.get("g1_mean"),
            "flowjo_g2": flowjo.get("g2_mean"),
            "flowjo_ratio": flowjo.get("g2_g1_ratio"),
            "gmm_g1": gmm.get("g1_mean"),
            "gmm_g2": gmm.get("g2_mean"),
            "gmm_ratio": gmm.get("g2_g1_ratio"),
            "gmm_converged": gmm.get("converged"),
            "pf_g1": (pf.get("fitted") or {}).get("g1Mean"),
            "pf_g2": (pf.get("fitted") or {}).get("g2Mean"),
            "pf_detection": (pf.get("detectionStatus")),
            "ploidy_error": ploidy.get("error"),
            "error": row.get("error") or gmm.get("error"),
        })
    return merged


def ratio(value, reference):
    if not value or not reference:
        return None
    return value / reference


def summarise(rows, key):
    values = [ratio(r[key], r["flowjo_g1"]) for r in rows]
    values = [v for v in values if v]
    if not values:
        return None
    within = sum(1 for v in values if abs(v - 1) <= AGREEMENT)
    return {
        "n": len(values),
        "median": statistics.median(values),
        "mean": statistics.fmean(values),
        "within": within,
        "doubled": sum(1 for v in values if v > DOUBLED),
    }


def cell(value, reference, fmt="{:.0f}"):
    if value is None:
        return "<td class='na'>—</td>"
    if not reference:
        return f"<td>{fmt.format(value)}</td>"
    r = value / reference
    cls = "good" if abs(r - 1) <= AGREEMENT else ("bad" if r > DOUBLED else "warn")
    return f"<td class='{cls}'>{fmt.format(value)}<span class='r'>{r:.2f}×</span></td>"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--phasefinder", required=True,
                    help="JSON of PhaseFinder fitted values (from the drift probe)")
    ap.add_argument("--out", default=str(RESULTS / "tool_comparison.html"))
    args = ap.parse_args()

    rows = collect(args.phasefinder)
    rows.sort(key=lambda r: r["strain"] or "")
    gmm_stats = summarise(rows, "gmm_g1")
    pf_stats = summarise(rows, "pf_g1")

    have_ploidy = any(r.get("ploidy_error") is None and r.get("ploidy_error") != "" for r in rows) \
        and (RESULTS / "flowploidy.json").exists()

    body = []
    for r in rows:
        body.append(
            "<tr>"
            f"<td class='strain'>{r['strain']}</td>"
            f"<td class='ref'>{r['flowjo_g1']:.0f}</td>" if r["flowjo_g1"] else "<td class='na'>—</td>"
        )
        body[-1] += (
            cell(r["gmm_g1"], r["flowjo_g1"])
            + cell(r["pf_g1"], r["flowjo_g1"])
            + (f"<td class='ref'>{r['flowjo_g2']:.0f}</td>" if r["flowjo_g2"] else "<td class='na'>—</td>")
            + cell(r["gmm_g2"], r["flowjo_g2"])
            + cell(r["pf_g2"], r["flowjo_g2"])
            + f"<td class='det'>{r['pf_detection'] or '—'}</td>"
            + "</tr>"
        )

    def stat_block(name, s, note=""):
        if not s:
            return f"<div class='stat'><h3>{name}</h3><p class='na'>no data</p></div>"
        cls = "good" if abs(s["median"] - 1) <= AGREEMENT else "bad"
        return (f"<div class='stat'><h3>{name}</h3>"
                f"<p class='big {cls}'>{s['within']}/{s['n']}</p>"
                f"<p>within ±5% of FlowJo</p>"
                f"<p class='sub'>median {s['median']:.3f}× &middot; mean {s['mean']:.3f}× "
                f"&middot; {s['doubled']} above {DOUBLED}×</p>"
                f"{f'<p class=sub>{note}</p>' if note else ''}</div>")

    html = f"""<!doctype html><meta charset='utf-8'><title>Peak-position comparison</title>
<style>
 body{{font:13px/1.5 system-ui,sans-serif;margin:0;padding:26px;background:#f9fafb;color:#111827;max-width:1150px}}
 h1{{margin:0 0 4px}} .sub{{color:#6b7280;font-size:12px}}
 .panel{{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px 18px;margin:16px 0}}
 .stats{{display:flex;gap:16px;flex-wrap:wrap}}
 .stat{{flex:1;min-width:210px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px}}
 .stat h3{{margin:0 0 6px;font-size:13px}} .big{{font-size:26px;font-weight:600;margin:2px 0}}
 table{{border-collapse:collapse;width:100%;font-size:12px;margin-top:8px}}
 th,td{{padding:4px 7px;text-align:right;border-bottom:1px solid #f3f4f6}}
 th{{background:#f9fafb;font-weight:600;text-align:right;position:sticky;top:0}}
 td.strain,th.strain{{text-align:left;font-weight:600}}
 td.det{{text-align:left;color:#6b7280;font-size:11px}}
 .ref{{background:#f9fafb;font-weight:600}}
 .good{{background:#dcfce7;color:#14532d}} .warn{{background:#fef3c7;color:#78350f}}
 .bad{{background:#fee2e2;color:#7f1d1d}} .na{{color:#9ca3af}}
 .r{{display:block;font-size:10px;opacity:.75}}
 .key span{{display:inline-block;margin-right:14px}}
 .swatch{{display:inline-block;width:11px;height:11px;border-radius:2px;vertical-align:-1px;margin-right:4px}}
 code{{background:#f3f4f6;padding:1px 4px;border-radius:3px}}
</style>
<h1>G1/G2 peak position: PhaseFinder vs FlowJo vs independent</h1>
<div class='sub'>30 asynchronous budding-yeast samples &middot; DNA channel GFP/FITC-A (SYTOX Green) &middot; FlowJo Dean–Jett–Fox is the reference column</div>

<div class='panel'>
<b>What this compares, and what it does not.</b>
None of the requested open-source packages (flowCore, openCyto, flowWorkspace, CytoExploreR,
FlowCal, CytoFlow, FlowKit, scverse/muon) implement Dean–Jett–Fox or Watson — they are I/O,
transform, gating and calibration frameworks — so a model-vs-model comparison is not available
from them. The independent column is a <b>two-component Gaussian mixture</b> on the DNA channel:
model-agnostic, no S-phase term, no cell-cycle assumption, but it does locate the two dominant
DNA populations. Its component weights are <b>not</b> phase fractions and are deliberately not
shown — a mixture forces the inter-peak S cells into one Gaussian or the other.
{"" if have_ploidy else "<br><br><b>flowPloidy</b> (Bioconductor) is the one open-source package that genuinely models a DNA histogram, and it is the right model-vs-model comparison. Its install did not complete here (several R build dependencies failed to compile), so it is absent from this report."}
</div>

<div class='stats'>
{stat_block("Independent Gaussian mixture", gmm_stats, "sklearn GaussianMixture — the same EM routine CytoFlow's GaussianMixtureOp wraps")}
{stat_block("PhaseFinder Dean–Jett–Fox", pf_stats, "auto-detected regions, no manual review")}
</div>

<div class='panel'>
<div class='key'>
 <span><i class='swatch' style='background:#dcfce7'></i>within ±5% of FlowJo</span>
 <span><i class='swatch' style='background:#fef3c7'></i>outside ±5%</span>
 <span><i class='swatch' style='background:#fee2e2'></i>above {DOUBLED}× — period-doubled</span>
</div>
<table>
<thead><tr>
 <th class='strain'>strain</th>
 <th>FlowJo G1</th><th>mixture G1</th><th>PhaseFinder G1</th>
 <th>FlowJo G2</th><th>mixture G2</th><th>PhaseFinder G2</th>
 <th style='text-align:left'>PF detection</th>
</tr></thead>
<tbody>{''.join(body)}</tbody>
</table>
</div>
"""
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    print(f"wrote {out}")
    for name, s in (("mixture", gmm_stats), ("PhaseFinder", pf_stats)):
        if s:
            print(f"  {name:<12} within ±5% of FlowJo: {s['within']}/{s['n']}  "
                  f"median {s['median']:.3f}×  doubled {s['doubled']}")


if __name__ == "__main__":
    main()
