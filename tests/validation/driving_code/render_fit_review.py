#!/usr/bin/env python3
"""Render a self-contained HTML review page for a set of FCS fits.

Each sample gets: the observed DNA histogram, the auto-detected G1/G2 peak
REGIONS as shaded bands, and the fitted G1 / S / G2 / total curves in the app's
own component colours -- so a reader can see directly whether a bad number came
from the region proposal or from the fit inside it.

Colours are taken from js/plotting/data.js so the page matches the application:
  G1 #95c1dc   S #d5eec8   G2 #ef8b8d   total #111827

Usage:
  fit_report.py <fcs-dir> [--limit N] [--pattern GLOB] [--out FILE]
"""

import argparse
import base64
import json
import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path("/fast/Desktop/mike/latentlens/projects/flow_plotter/PhaseFinder")
PORT = 8131

# js/plotting/data.js
G1_COLOR, S_COLOR, G2_COLOR, TOTAL_COLOR = "#95c1dc", "#d5eec8", "#ef8b8d", "#111827"

FIT_ONE = r"""async ([fileName, base64]) => {
  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  let parsed;
  try { parsed = window.FCSParser.parse_fcs(bytes.buffer); }
  catch (error) { return { error: `parse: ${error.message}` }; }

  const columnLabels = parsed.columns.map(String);
  const dnaIndex = columnLabels.findIndex((n) => /GFP|FITC|FL7/i.test(n));
  if (dnaIndex < 0) return { error: 'no DNA channel', columnLabels };
  const label = columnLabels[dnaIndex];
  const dna = Float64Array.from(parsed.rows, (row) => Number(row[label]));

  const pipeline = window.PhaseFinder.pipeline;
  const modelingState = window.CellCycleModelingState;
  const registry = window.CellCycleModelRegistry;
  const row = {
    id: fileName, name: fileName,
    data: { eventCount: dna.length, channel_key: 'DNA_A', dna_a: dna,
            channels: { DNA_A: dna }, pnr: {} },
  };
  pipeline.clear_state(fileName);
  pipeline.apply_structural_qc(row);
  pipeline.apply_dna_histogram(row, { binCount: 256 });

  const state = pipeline.get_state(fileName);
  const histogram = state.histogram;
  const detection = modelingState.detect_peak_regions(row);
  const proposed = state.modeling?.peakSelection?.automaticRegions;

  const out = {
    file: fileName,
    events: dna.length,
    histogram: { x: Array.from(histogram.x ?? []), y: Array.from(histogram.counts ?? histogram.y ?? []) },
    detection: {
      status: detection?.status ?? null,
      confidence: detection?.confidence ?? null,
      reasons: detection?.reasons ?? [],
      // Every candidate peak the detector found, so a missed/extra peak is visible.
      candidates: (detection?.candidates ?? []).map((c) => ({ x: c.x, prominence: c.prominence ?? null })),
      pairCount: (detection?.pairs ?? []).length,
    },
    regions: proposed ? { g1: { ...proposed.g1 }, g2: { ...proposed.g2 } } : null,
  };
  if (!proposed) { out.error = 'no regions proposed'; return out; }

  modelingState.update_peak_regions(row, {
    g1: { left: proposed.g1.left, right: proposed.g1.right },
    g2: { left: proposed.g2.left, right: proposed.g2.right },
  });

  try {
    const fit = await modelingState.fit_cell_cycle_model(row, 'dean_jett_fox');
    const component = (id) => fit.components.find((c) => c.id === id)?.counts ?? [];
    out.fit = {
      g1: Array.from(component('g1')),
      s: Array.from(component('s')),
      g2: Array.from(component('g2')),
      total: Array.from(fit.expectedCounts ?? []),
      fractions: fit.phaseFractions,
      parameters: fit.parameters,
      bounds: fit.bounds,
      mode: fit.populationMode,
      selection: fit.populationSelection,
      converged: fit.converged,
      reportable: fit.validForReporting,
      reducedDeviance: fit.diagnostics?.reducedDeviance ?? null,
      // The STAT-01 audit: which constraints were ACTIVE at the optimum. This is
      // how a "the bound placed the peak, not the data" case shows itself.
      activeConstraints: (fit.constraintAudit?.active ?? []).map((e) => ({
        what: e.parameter ?? e.constraint, side: e.activeSide ?? null, value: e.value,
      })),
      warnings: (fit.warnings ?? []).map((w) => ({ code: w.code, message: w.message })),
    };
  } catch (error) {
    out.error = `${error.code ?? error.name}: ${error.message}`;
  }
  return out;
}"""


def svg_for(sample, width=560, height=210, pad=34):
    hist = sample.get("histogram", {})
    xs, ys = hist.get("x", []), hist.get("y", [])
    if not xs:
        return "<p class='err'>no histogram</p>"
    fit = sample.get("fit") or {}
    series = [ys, fit.get("total", []), fit.get("g1", []), fit.get("s", []), fit.get("g2", [])]
    ymax = max((max(s) for s in series if s), default=1) or 1
    xmin, xmax = min(xs), max(xs)
    span = (xmax - xmin) or 1

    def px(x):
        return pad + (width - 2 * pad) * (x - xmin) / span

    def py(y):
        return height - pad - (height - 2 * pad) * (y / ymax)

    def path(values, color, w, fill=False):
        if not values or len(values) != len(xs):
            return ""
        pts = " ".join(f"{px(x):.1f},{py(v):.1f}" for x, v in zip(xs, values))
        if fill:
            return (f"<polygon points='{px(xs[0]):.1f},{py(0):.1f} {pts} {px(xs[-1]):.1f},{py(0):.1f}' "
                    f"fill='{color}' fill-opacity='0.45' stroke='{color}' stroke-width='{w}'/>")
        return f"<polyline points='{pts}' fill='none' stroke='{color}' stroke-width='{w}'/>"

    parts = [f"<svg viewBox='0 0 {width} {height}' class='plot'>"]
    # Peak REGIONS first, underneath everything, so it is obvious what the fit was
    # allowed to search.
    regions = sample.get("regions")
    if regions:
        for key, color in (("g1", G1_COLOR), ("g2", G2_COLOR)):
            r = regions[key]
            parts.append(
                f"<rect x='{px(r['left']):.1f}' y='{pad}' width='{max(px(r['right']) - px(r['left']), 1):.1f}' "
                f"height='{height - 2 * pad}' fill='{color}' fill-opacity='0.16'/>"
                f"<line x1='{px(r['left']):.1f}' y1='{pad}' x2='{px(r['left']):.1f}' y2='{height - pad}' "
                f"stroke='{color}' stroke-width='1.2' stroke-dasharray='3 2'/>"
                f"<line x1='{px(r['right']):.1f}' y1='{pad}' x2='{px(r['right']):.1f}' y2='{height - pad}' "
                f"stroke='{color}' stroke-width='1.2' stroke-dasharray='3 2'/>")
    # Observed histogram as a grey step, then the fitted components.
    parts.append(path(ys, "#9ca3af", 1))
    parts.append(path(fit.get("g1", []), G1_COLOR, 1.5, fill=True))
    parts.append(path(fit.get("s", []), S_COLOR, 1.5, fill=True))
    parts.append(path(fit.get("g2", []), G2_COLOR, 1.5, fill=True))
    parts.append(path(fit.get("total", []), TOTAL_COLOR, 2))
    # Detected candidate peaks as ticks, so a detector miss is visible.
    for c in sample.get("detection", {}).get("candidates", [])[:12]:
        parts.append(f"<line x1='{px(c['x']):.1f}' y1='{height - pad}' x2='{px(c['x']):.1f}' "
                     f"y2='{height - pad + 6}' stroke='#111827' stroke-width='1'/>")
    parts.append(f"<line x1='{pad}' y1='{height - pad}' x2='{width - pad}' y2='{height - pad}' "
                 f"stroke='#374151' stroke-width='1'/>")
    parts.append(f"<text x='{pad}' y='{height - 8}' class='ax'>{xmin:.0f}</text>")
    parts.append(f"<text x='{width - pad}' y='{height - 8}' class='ax' text-anchor='end'>{xmax:.0f}</text>")
    parts.append("</svg>")
    return "".join(parts)


def card(sample):
    fit = sample.get("fit") or {}
    det = sample.get("detection", {})
    fr = fit.get("fractions") or {}
    p = fit.get("parameters") or {}
    sel = fit.get("selection") or {}
    guards = sel.get("guards") or {}

    def pct(v):
        return f"{100 * v:.1f}%" if isinstance(v, (int, float)) else "—"

    flags = []
    if sample.get("error"):
        flags.append(f"<span class='bad'>ERROR {sample['error']}</span>")
    if isinstance(fr.get("s"), (int, float)) and fr["s"] < 0.01:
        flags.append("<span class='bad'>S COLLAPSED</span>")
    if fit.get("converged") is False:
        flags.append("<span class='warn'>not converged</span>")
    if det.get("status") and det["status"] != "detected":
        flags.append(f"<span class='warn'>detection: {det['status']}</span>")
    active = fit.get("activeConstraints") or []
    for a in active:
        flags.append(f"<span class='warn'>active bound: {a['what']}"
                     f"{' (' + a['side'] + ')' if a.get('side') else ''}</span>")

    guard_html = " ".join(
        f"<span class='{'ok' if v else 'no'}'>{k}</span>" for k, v in guards.items()) or "—"

    return f"""
<section class='card'>
  <h3>{sample['file']}</h3>
  <div class='flags'>{' '.join(flags) or "<span class='ok'>clean</span>"}</div>
  {svg_for(sample)}
  <table class='kv'>
    <tr><td>fractions</td><td><b>G1 {pct(fr.get('g1'))} &middot; S {pct(fr.get('s'))} &middot; G2 {pct(fr.get('g2'))}</b></td></tr>
    <tr><td>detection</td><td>{det.get('status')} (confidence {det.get('confidence')}) &middot;
        {len(det.get('candidates', []))} candidate peaks &middot; {det.get('pairCount')} pairs</td></tr>
    <tr><td>regions</td><td>{json.dumps(sample.get('regions'))}</td></tr>
    <tr><td>peaks</td><td>G1 mean {p.get('g1Mean', float('nan')):.1f} CV {p.get('g1CV', float('nan')):.3f} &middot;
        G2 mean {p.get('g2Mean', float('nan')):.1f} CV {p.get('g2CV', float('nan')):.3f} &middot;
        ratio {(p.get('g2Mean', 0) / p.get('g1Mean', 1)) if p.get('g1Mean') else float('nan'):.3f}</td></tr>
    <tr><td>population</td><td>{fit.get('mode')} &middot; &Delta;BIC {sel.get('deltaBic')} &middot;
        cohort {pct(sel.get('cohortFraction'))}</td></tr>
    <tr><td>guards</td><td class='guards'>{guard_html}</td></tr>
    <tr><td>quality</td><td>reduced deviance {fit.get('reducedDeviance')} &middot;
        reportable {fit.get('reportable')}</td></tr>
  </table>
</section>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("directory")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--pattern", default="*.fcs")
    ap.add_argument("--out", default="fit_review.html")
    args = ap.parse_args()

    files = sorted(Path(args.directory).glob(args.pattern))
    if args.limit:
        files = files[:args.limit]
    if not files:
        sys.exit(f"no files matched {args.pattern} in {args.directory}")

    srv = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "-d", str(ROOT)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(80):
        try:
            socket.create_connection(("127.0.0.1", PORT), 0.2).close()
            break
        except OSError:
            time.sleep(0.1)

    samples = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page()
            page.goto(f"http://127.0.0.1:{PORT}/tests/unit/test_harness.html")
            page.wait_for_function("() => window.__libsReady === true", timeout=60000)
            for i, path in enumerate(files):
                payload = base64.b64encode(path.read_bytes()).decode()
                try:
                    out = page.evaluate(FIT_ONE, [path.name, payload])
                except Exception as err:
                    out = {"file": path.name, "error": str(err)[:160]}
                samples.append(out)
                s = (out.get("fit") or {}).get("fractions", {}).get("s")
                print(f"[{i + 1}/{len(files)}] {path.name} "
                      f"{'ERR' if out.get('error') else f'S={100 * s:.1f}%' if s is not None else '?'}", flush=True)
            browser.close()
    finally:
        srv.terminate()

    collapsed = sum(1 for s in samples
                    if isinstance((s.get("fit") or {}).get("fractions", {}).get("s"), float)
                    and s["fit"]["fractions"]["s"] < 0.01)
    detected = sum(1 for s in samples if s.get("detection", {}).get("status") == "detected")
    sync = sum(1 for s in samples if (s.get("fit") or {}).get("mode") == "synchronous")

    html = f"""<!doctype html><meta charset='utf-8'><title>PhaseFinder fit review</title>
<style>
 body{{font:13px/1.45 system-ui,sans-serif;margin:0;padding:24px;background:#f9fafb;color:#111827}}
 h1{{margin:0 0 4px}} .sub{{color:#6b7280;margin-bottom:18px}}
 .summary{{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;margin-bottom:18px}}
 .grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(600px,1fr));gap:16px}}
 .card{{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px}}
 .card h3{{margin:0 0 6px;font-size:13px;font-weight:600;word-break:break-all}}
 .plot{{width:100%;height:auto;display:block;background:#fff}}
 .ax{{font-size:9px;fill:#6b7280}}
 table.kv{{width:100%;border-collapse:collapse;margin-top:8px;font-size:12px}}
 table.kv td{{padding:2px 4px;vertical-align:top;border-top:1px solid #f3f4f6}}
 table.kv td:first-child{{color:#6b7280;width:88px}}
 .flags span{{display:inline-block;padding:1px 6px;border-radius:4px;font-size:11px;margin:0 4px 4px 0}}
 .bad{{background:#fee2e2;color:#991b1b}} .warn{{background:#fef3c7;color:#92400e}}
 .ok{{background:#dcfce7;color:#166534}} .no{{background:#fee2e2;color:#991b1b}}
 .guards span{{display:inline-block;padding:1px 5px;border-radius:3px;margin-right:4px;font-size:11px}}
 .legend span{{display:inline-block;margin-right:14px}}
 .swatch{{display:inline-block;width:11px;height:11px;border-radius:2px;vertical-align:-1px;margin-right:4px}}
</style>
<h1>PhaseFinder fit review</h1>
<div class='sub'>{args.directory}</div>
<div class='summary'>
 <b>{len(samples)}</b> samples &middot;
 peak detection reported <b>detected</b> for <b>{detected}</b> &middot;
 <b>{collapsed}</b> with %S collapsed below 1% &middot;
 <b>{sync}</b> classified synchronous
 <div class='legend' style='margin-top:8px'>
  <span><i class='swatch' style='background:{G1_COLOR}'></i>G1</span>
  <span><i class='swatch' style='background:{S_COLOR}'></i>S</span>
  <span><i class='swatch' style='background:{G2_COLOR}'></i>G2</span>
  <span><i class='swatch' style='background:{TOTAL_COLOR}'></i>fitted total</span>
  <span><i class='swatch' style='background:#9ca3af'></i>observed</span>
  <span>shaded band = accepted peak region &middot; ticks = detector candidates</span>
 </div>
</div>
<div class='grid'>{''.join(card(s) for s in samples)}</div>"""

    out_path = Path(args.out)
    out_path.write_text(html, encoding="utf-8")
    Path(str(out_path) + ".json").write_text(json.dumps(samples, indent=1))
    print(f"\nwrote {out_path}  ({detected}/{len(samples)} detected, {collapsed} S-collapsed, {sync} synchronous)")


if __name__ == "__main__":
    main()
