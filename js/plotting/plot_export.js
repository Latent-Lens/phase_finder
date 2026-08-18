// "Download plot image" for the plot toolbar's camera button: exports the plot
// exactly as it is currently drawn as vector SVG/PDF or rasterized PNG/JPEG.
//
// Every format starts from a style-inlined clone of the live SVG. The plot is
// styled by external stylesheets, and neither a standalone .svg file nor an
// <img> loaded from a data URL (the only way to rasterize an SVG through a
// canvas) can see those stylesheets -- so the computed value of every paint and
// font property has to be baked onto the clone first.

import {
  plot_area,
  plot_export_modal,
  plot_export_scale_select,
  plot_export_error,
  plottable_rows,
  plot_view_mode_select,
  plot_display_mode_select,
  plot_channels,
  plot_bin_count,
  axis_range_override,
  analysis_domain_override,
  plot_viewport,
} from "./data.js";
import { svg_to_pdf_blob } from "./svg_to_pdf.js";
import { filename_timestamp } from "../util/names.js";
import { get_file_table } from "../state/app_state.js";
import { get_state } from "../analysis/pipeline/pipeline_state.js";
import { escape_html } from "../util/html.js";
import { result_reporting_summary, fraction_trust_reason } from "../analysis/cell_cycle/result_contract.js";
import { build_fit_export, build_fit_csv } from "../analysis/cell_cycle/export.js";
import {
  PHASEFINDER_SOURCE_COMMIT,
  PHASEFINDER_VERSION,
  phasefinder_provenance,
} from "../util/build_info.js";

// Presentation properties that must survive the trip out of the document.
const INLINED_STYLE_PROPERTIES = [
  "fill", "fill-opacity", "fill-rule",
  "stroke", "stroke-opacity", "stroke-width", "stroke-dasharray",
  "stroke-linecap", "stroke-linejoin",
  "opacity", "font-family", "font-size", "font-style", "font-weight",
  "text-anchor", "dominant-baseline", "letter-spacing", "display", "visibility",
];

// Interaction-only layers: invisible on screen and meaningless in a file.
const EXPORT_ONLY_REMOVED = ".plot_interaction_surface, .plot_zoom_band";
const SVG_NS = "http://www.w3.org/2000/svg";
const RIDGE_HEADER_HEIGHT = 28;
const RIDGE_ROW_GAP = 12;
const PROVENANCE_HEADER_HEIGHT = 58;
const PROVENANCE_ROW_HEIGHT = 17;
const MAX_VECTOR_EXPORT_HEIGHT = 16384;
const MAX_RASTER_DIMENSION = 16384;
const MAX_RASTER_PIXELS = 64_000_000;
let export_controller = null;

function analysis_export_provenance() {
  const samples = plottable_rows().map((row) => {
    const state = get_state(row.name);
    const modeling = state?.modeling;
    const resultKey = modeling?.activeResultKey || modeling?.lastDiagnosticResultKey || null;
    const result = resultKey ? modeling?.resultsByKey?.[resultKey] : null;
    const qc = {};
    for (const [name, value] of Object.entries({
      structural: state?.structuralQC,
      time: state?.timeQC,
      scatter: state?.scatterGate,
      singlet: state?.singletResult,
    })) {
      if (value) qc[name] = value.algorithmVersion || value.version || value.status || "present";
    }
    return {
      sample: row.name,
      modelId: result?.modelId || null,
      modelVersion: result?.modelVersion || result?.version || null,
      resultKey,
      histogramFingerprint: modeling?.histogramFingerprint || null,
      qc,
    };
  });
  return phasefinder_provenance("analysis-export", {
    channel: plot_channels?.dna_area || null,
    view: plot_view_mode_select?.value === "ridge" ? "ridge" : "overlay",
    displayMode: plot_display_mode_select?.value || null,
    bins: plot_bin_count(),
    displayRange: { ...axis_range_override, viewport: plot_viewport },
    analysisRange: { ...analysis_domain_override },
    samples,
  });
}

function append_export_provenance(svg) {
  const provenance = analysis_export_provenance();
  const width = Number(svg.getAttribute("width")) || svg.viewBox?.baseVal?.width || 0;
  const oldHeight = Number(svg.getAttribute("height")) || svg.viewBox?.baseVal?.height || 0;
  if (!(width > 0) || !(oldHeight > 0)) return svg;
  const footerHeight = PROVENANCE_HEADER_HEIGHT + provenance.samples.length * PROVENANCE_ROW_HEIGHT;
  if (oldHeight + footerHeight > MAX_VECTOR_EXPORT_HEIGHT) {
    throw new Error("The complete plot plus provenance is too tall. Use the paginated HTML report.");
  }
  svg.setAttribute("height", oldHeight + footerHeight);
  svg.setAttribute("viewBox", `0 0 ${width} ${oldHeight + footerHeight}`);

  const metadata = document.createElementNS(SVG_NS, "metadata");
  metadata.setAttribute("id", "phasefinder-analysis-provenance");
  metadata.textContent = JSON.stringify(provenance);
  svg.insertBefore(metadata, svg.firstChild);

  const group = document.createElementNS(SVG_NS, "g");
  group.setAttribute("class", "phasefinder_export_provenance");
  group.setAttribute("transform", `translate(0 ${oldHeight})`);
  const background = document.createElementNS(SVG_NS, "rect");
  background.setAttribute("width", width);
  background.setAttribute("height", footerHeight);
  background.setAttribute("fill", "#ffffff");
  background.setAttribute("stroke", "#94a3b8");
  group.appendChild(background);
  const line = (text, y, weight = "400") => {
    const node = document.createElementNS(SVG_NS, "text");
    node.setAttribute("x", "8");
    node.setAttribute("y", y);
    node.setAttribute("fill", "#172033");
    node.setAttribute("font-family", "Arial, sans-serif");
    node.setAttribute("font-size", "11");
    node.setAttribute("font-weight", weight);
    node.textContent = text;
    group.appendChild(node);
  };
  line(`PhaseFinder ${PHASEFINDER_VERSION} • source ${PHASEFINDER_SOURCE_COMMIT.slice(0, 12)}`, 17, "700");
  line(`View ${provenance.view} • channel ${provenance.channel || "unspecified"} • ${provenance.bins} bins • generated ${provenance.generatedAt}`, 35);
  line(`Analysis range ${JSON.stringify(provenance.analysisRange)} • display range ${JSON.stringify(provenance.displayRange)}`, 51);
  provenance.samples.forEach((sample, index) => {
    const qc = Object.entries(sample.qc).map(([name, value]) => `${name}:${value}`).join(",") || "none";
    line(`${sample.sample} • model ${sample.modelId || "none"} • QC ${qc}`, PROVENANCE_HEADER_HEIGHT + index * PROVENANCE_ROW_HEIGHT + 12);
  });
  svg.appendChild(group);
  return svg;
}

function export_filename_stem() {
  const view = plot_view_mode_select?.value === "ridge" ? "ridge" : "overlay";
  const models = new Set(plottable_rows().map((row) => {
    const modeling = get_state(row.name)?.modeling;
    const result = modeling?.activeResultKey ? modeling.resultsByKey?.[modeling.activeResultKey] : null;
    return result?.modelId;
  }).filter(Boolean));
  const model = models.size === 1 ? [...models][0] : models.size ? "mixed-models" : "events";
  const safe_model = model.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "events";
  return `phasefinder_${view}_${safe_model}_${filename_timestamp()}`;
}

function throw_if_cancelled(signal) {
  if (signal?.aborted) throw new DOMException("Plot export was cancelled.", "AbortError");
}

/*

Purpose:
	Returns the plot SVG currently on screen, or null when nothing is plotted.

Input:
	(none)

Output:
	svg [SVGElement|null]: the live #plot_area SVG

*/
export function current_plot_svg() {
  return plot_area ? plot_area.querySelector("svg") : null;
}

/*

Purpose:
	Clones the live plot SVG with every computed presentation style written
	onto the clone as inline styles, so the result renders identically outside
	the document (standalone file, or an <img> for canvas rasterization).

Input:
	svg [SVGElement]: the live plot SVG

Output:
	clone [SVGElement]: a detached, self-contained copy

*/
function inline_styled_clone(svg) {
  const clone = svg.cloneNode(true);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  clone.setAttribute("version", "1.1");

  const source_nodes = [svg, ...svg.querySelectorAll("*")];
  const clone_nodes = [clone, ...clone.querySelectorAll("*")];
  source_nodes.forEach((source, index) => {
    const target = clone_nodes[index];
    if (!target || !target.style) return;
    const computed = window.getComputedStyle(source);
    for (const property of INLINED_STYLE_PROPERTIES) {
      const value = computed.getPropertyValue(property);
      if (value) target.style.setProperty(property, value);
    }
    // Pointer affordances mean nothing in a file and only bloat it.
    target.style.removeProperty("cursor");
    target.removeAttribute("pointer-events");
  });

  clone.querySelectorAll(EXPORT_ONLY_REMOVED).forEach((node) => node.remove());
  return clone;
}

export function exportable_plot_svg() {
  const ridge_rows = plot_area ? [...plot_area.querySelectorAll(".ridge_row")] : [];
  if (!ridge_rows.length) {
    const svg = current_plot_svg();
    return svg ? append_export_provenance(inline_styled_clone(svg)) : null;
  }

  const entries = ridge_rows.map((row) => {
    const svg = row.querySelector("svg");
    return {
      svg,
      width: Number(svg?.getAttribute("width")) || svg?.clientWidth || 0,
      height: Number(svg?.getAttribute("height")) || svg?.clientHeight || 0,
      label: row.querySelector(".ridge_row_name")?.textContent?.trim() || row.dataset.sampleName || "Sample",
      badge: row.querySelector(".ridge_badge")?.textContent?.trim() || "",
    };
  }).filter((entry) => entry.svg && entry.width > 0 && entry.height > 0);
  if (!entries.length) return null;

  const width = Math.max(...entries.map((entry) => entry.width));
  const height = entries.reduce((sum, entry) => sum + RIDGE_HEADER_HEIGHT + entry.height + RIDGE_ROW_GAP, 0) - RIDGE_ROW_GAP;
  if (height > MAX_VECTOR_EXPORT_HEIGHT) {
    throw new Error(`The complete ridge export is ${height}px tall. Use the paginated HTML report for this many samples.`);
  }

  const composite = document.createElementNS(SVG_NS, "svg");
  composite.setAttribute("xmlns", SVG_NS);
  composite.setAttribute("width", width);
  composite.setAttribute("height", height);
  composite.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const title = document.createElementNS(SVG_NS, "title");
  title.textContent = `PhaseFinder ridge plot with ${entries.length} samples`;
  composite.appendChild(title);

  let y = 0;
  entries.forEach((entry) => {
    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute("transform", `translate(0 ${y})`);
    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", "8");
    label.setAttribute("y", "19");
    label.setAttribute("fill", "#072c67");
    label.setAttribute("font-family", "Arial, sans-serif");
    label.setAttribute("font-size", "14");
    label.setAttribute("font-weight", "700");
    label.textContent = entry.badge ? `${entry.label} — ${entry.badge}` : entry.label;
    group.appendChild(label);

    const plot_group = document.createElementNS(SVG_NS, "g");
    plot_group.setAttribute("transform", `translate(0 ${RIDGE_HEADER_HEIGHT})`);
    const clone = inline_styled_clone(entry.svg);
    while (clone.firstChild) plot_group.appendChild(clone.firstChild);
    group.appendChild(plot_group);
    composite.appendChild(group);
    y += RIDGE_HEADER_HEIGHT + entry.height + RIDGE_ROW_GAP;
  });
  return append_export_provenance(composite);
}

function serialize(svg_clone) {
  return new XMLSerializer().serializeToString(svg_clone);
}

function download_blob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on a later task so the click has definitely been handled.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function report_table_html() {
  const frame = get_file_table();
  if (!frame?.length) return '<p class="empty">No metadata rows were available.</p>';
  const columns = frame.columns.filter((column) => column !== "id");
  const cells = (tag, values) => `<tr>${values.map((value) => `<${tag}>${escape_html(value ?? "")}</${tag}>`).join("")}</tr>`;
  const rows = Array.from({ length: frame.length }, (_, index) =>
    cells("td", columns.map((column) => frame.col(column)[index]))).join("");
  return `<div class="table-wrap"><table><thead>${cells("th", columns)}</thead><tbody>${rows}</tbody></table></div>`;
}

// A compact per-sample summary of the two things the report is really about:
// the SELECTED G1/G2 starting regions (what the user reviewed) and the MODELED
// phase fractions (what the fit produced). Pulled out of the wide metadata table
// so they read at a glance. Samples with neither a region nor a fit are skipped.
function report_fit_summary_html() {
  const fmt = (value) => (Number.isFinite(value) ? Number(value.toFixed(2)) : "—");
  // UI-01: this report is the surface most likely to be pasted into a paper,
  // a slide, or sent to a collaborator, so an unvalidated percentage cannot
  // read as clean here even though `status`/`reason` are already shown in
  // their own columns -- a reader scanning the numbers can miss a separate
  // column, and a copied/pasted number loses it entirely. The marker has to
  // be fused into the cell's own text (not a CSS ::before) so it survives
  // copy/paste and PDF rendering. Precedence mirrors
  // fraction_trust_reason() from the DOM-free result contract -- the same
  // helper js/ui/cell_cycle_columns.js and js/plotting/render.js use, so the
  // report cannot silently drift from the on-screen surfaces. It previously
  // duplicated the precedence inline because the only copy lived in js/ui/
  // and js/plotting/ must not depend on js/ui/; the helper has since been
  // extracted so all three layers share one implementation.
  const pct = (value, result) => {
    if (!Number.isFinite(value)) return "—";
    const text = `${(value * 100).toFixed(1)}%`;
    return fraction_trust_reason(result) ? `${text} ⚠` : text;
  };
  const region = (r) => (r && Number.isFinite(r.left) && Number.isFinite(r.right) ? `${fmt(r.left)} – ${fmt(r.right)}` : "—");

  const rows = [];
  for (const row of plottable_rows()) {
    const modeling = get_state(row.name)?.modeling;
    if (!modeling) continue;
    const regions = modeling.peakSelection?.regions;
    const active = modeling.activeResultKey ? modeling.resultsByKey?.[modeling.activeResultKey] : null;
    const diagnostic = modeling.lastDiagnosticResultKey
      ? modeling.resultsByKey?.[modeling.lastDiagnosticResultKey]
      : null;
    const result = active ?? diagnostic;
    if (!regions && !result) continue;
    const model = result ? escape_html(result.modelLabel ?? result.modelId ?? "—") : "—";
    const converged = result ? (result.converged ? "yes" : "no") : "—";
    const reporting = result_reporting_summary(result);
    const status = result ? escape_html(reporting.status) : "—";
    const reason = result ? escape_html(reporting.reason) : "—";
    const pf = reporting.phaseFractions;
    const eligibility = result?.channelEligibility ?? get_state(row.name)?.channelEligibility;
    const transform = escape_html(eligibility?.transform?.status ?? "unknown");
    const compensation = escape_html(eligibility?.compensation?.status ?? "unknown");
    rows.push(
      `<tr><td>${escape_html(row.name)}</td><td>${model}</td><td>${converged}</td><td>${status}</td><td>${reason}</td>` +
        `<td>${transform}</td><td>${compensation}</td>` +
        `<td>${region(regions?.g1)}</td><td>${region(regions?.g2)}</td>` +
        `<td>${pct(pf?.g1, result)}</td><td>${pct(pf?.s, result)}</td><td>${pct(pf?.g2, result)}</td></tr>`,
    );
  }
  if (!rows.length) return "";
  return (
    `<div class="table-wrap"><table><thead><tr>` +
    `<th>Sample</th><th>Model</th><th>Converged</th><th>Status</th><th>Reason</th><th>DNA transform</th><th>Compensation</th><th>G1 region</th><th>G2/M region</th>` +
    `<th>%G1</th><th>%S</th><th>%G2/M</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`
  );
}

function report_plot_html() {
  if (!plot_area?.querySelector("svg")) throw new Error("There is no plot to include in the report yet.");
  const clone = plot_area.cloneNode(true);
  const sources = [...plot_area.querySelectorAll("svg")];
  const targets = [...clone.querySelectorAll("svg")];
  sources.forEach((source, index) => targets[index]?.replaceWith(inline_styled_clone(source)));
  clone.querySelectorAll("button, .plot_interaction_surface, .plot_zoom_band").forEach((node) => node.remove());
  return clone.innerHTML;
}

export function build_analysis_report_html() {
  const generated = new Date().toLocaleString();
  const provenance = analysis_export_provenance();
  const provenance_json = JSON.stringify(provenance).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PhaseFinder analysis report</title><style>
body{margin:32px;color:#172033;background:#fff;font:14px/1.45 Arial,sans-serif}h1,h2{color:#072c67}h1{margin-bottom:4px}.generated{color:#5b6472;margin-top:0}.plot{margin:18px 0 30px}.plot svg{max-width:100%;height:auto}.ridge_row{break-inside:avoid;margin:0 0 16px}.ridge_row_header{font-weight:700;margin-bottom:4px}.ridge_badge{margin-left:10px;color:#087f86}.provenance{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px}.provenance dt{font-weight:700}.provenance dd{margin:0}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #cbd5e1;padding:6px 8px;text-align:left;vertical-align:top}th{background:#e7f3f5;color:#072c67}.empty{color:#5b6472}@media print{body{margin:12mm}.table-wrap{overflow:visible}tr,.plot svg{break-inside:avoid}}
</style></head><body><h1>PhaseFinder analysis report</h1><p class="generated">Generated ${escape_html(generated)}</p>
<h2>Analysis provenance</h2><dl class="provenance"><dt>Application</dt><dd>PhaseFinder ${escape_html(provenance.applicationVersion)}</dd><dt>Source</dt><dd>${escape_html(provenance.sourceCommit)}</dd><dt>View/channel</dt><dd>${escape_html(provenance.view)} / ${escape_html(provenance.channel || "unspecified")}</dd><dt>Bins</dt><dd>${provenance.bins}</dd></dl>
<script type="application/json" id="phasefinder-analysis-provenance">${provenance_json}</script>
<h2>Plots and modeled areas</h2><div class="plot">${report_plot_html()}</div>
${(() => { const summary = report_fit_summary_html(); return summary ? `<h2>Selected regions and modeled fractions</h2>${summary}` : ""; })()}
<h2>Metadata and results</h2>${report_table_html()}</body></html>`;
}

function export_analysis_report() {
  const html = build_analysis_report_html();
  download_blob(new Blob([html], { type: "text/html;charset=utf-8" }), `${export_filename_stem()}_report.html`);
}

// FEAT-02: the machine-readable fit export. build_fit_export()/build_fit_csv()
// (js/analysis/cell_cycle/export.js) are pure and take one (row, result) pair;
// this is the DOM-facing half that picks each plotted row's active result,
// serializes every row into one download, and triggers it.
function active_result_for_row(row) {
  const modeling = get_state(row.name)?.modeling;
  const key = modeling?.activeResultKey || modeling?.lastDiagnosticResultKey || null;
  return key ? modeling?.resultsByKey?.[key] : null;
}

function fittable_rows() {
  return plottable_rows()
    .map((row) => ({ row, result: active_result_for_row(row) }))
    .filter((entry) => entry.result);
}

function export_fit_json() {
  const entries = fittable_rows();
  if (!entries.length) throw new Error("No fit results are available to export yet.");
  const exports = entries.map(({ row, result }) => build_fit_export(row, result));
  const text = JSON.stringify(exports.length === 1 ? exports[0] : exports, null, 2);
  download_blob(new Blob([text], { type: "application/json;charset=utf-8" }), `${export_filename_stem()}_fit.json`);
}

function export_fit_csv() {
  const entries = fittable_rows();
  if (!entries.length) throw new Error("No fit results are available to export yet.");
  let header = null;
  const body = [];
  for (const { row, result } of entries) {
    const [head, ...rows] = build_fit_csv(row, result).split("\n");
    header = header ?? head;
    body.push(...rows);
  }
  download_blob(new Blob([[header, ...body].join("\n")], { type: "text/csv;charset=utf-8" }), `${export_filename_stem()}_fit.csv`);
}

/*

Purpose:
	Rasterizes the plot through a canvas at a chosen pixel scale. JPEG gets an
	opaque white backdrop (the format has no alpha channel, so an unpainted
	background would otherwise come out black).

Input:
	svg_clone [SVGElement]: style-inlined clone
	format [string]: "png" or "jpeg"
	scale [number]: device-pixel multiplier (1, 2, 4)

Output:
	blob [Promise<Blob>]: the encoded raster image

*/
function rasterize(svg_clone, format, scale, signal = null) {
  const width = Number(svg_clone.getAttribute("width")) || 0;
  const height = Number(svg_clone.getAttribute("height")) || 0;
  if (!(width > 0) || !(height > 0)) return Promise.reject(new Error("The plot has no drawable size."));
  const pixel_width = Math.round(width * scale);
  const pixel_height = Math.round(height * scale);
  if (pixel_width > MAX_RASTER_DIMENSION || pixel_height > MAX_RASTER_DIMENSION || pixel_width * pixel_height > MAX_RASTER_PIXELS) {
    return Promise.reject(new Error(`The ${pixel_width}×${pixel_height} export is too large. Choose a lower scale or the paginated HTML report.`));
  }

  const source = URL.createObjectURL(new Blob([serialize(svg_clone)], { type: "image/svg+xml;charset=utf-8" }));
  return new Promise((resolve, reject) => {
    const image = new Image();
    let canvas = null;
    let settled = false;
    const cleanup = () => {
      URL.revokeObjectURL(source);
      signal?.removeEventListener("abort", abort);
      if (canvas) { canvas.width = 0; canvas.height = 0; }
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const abort = () => {
      image.src = "";
      finish(reject, new DOMException("Plot export was cancelled.", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    image.onload = () => {
      if (signal?.aborted) {
        abort();
        return;
      }
      canvas = document.createElement("canvas");
      canvas.width = pixel_width;
      canvas.height = pixel_height;
      const context = canvas.getContext("2d");
      if (format === "jpeg") {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.drawImage(image, 0, 0, width, height);
      canvas.toBlob(
        (blob) => (blob ? finish(resolve, blob) : finish(reject, new Error("The browser could not encode the image."))),
        format === "jpeg" ? "image/jpeg" : "image/png",
        format === "jpeg" ? 0.92 : undefined,
      );
    };
    image.onerror = () => finish(reject, new Error("The plot image could not be rendered for export."));
    image.src = source;
  });
}

/*

Purpose:
	Exports the plot (or, for "json"/"csv", the modeled fit data) currently on
	screen in one of the supported formats and triggers the download.

Input:
	format [string]: "svg", "pdf", "png", "jpeg", "html", "json", or "csv"
	scale [number]: pixel scale for the raster formats (ignored otherwise)

Output:
	(none) [Promise<void>]: resolves once the download has been started;
	                        rejects with a user-presentable Error

*/
export async function export_plot_image(format, scale = 2, signal = null) {
  throw_if_cancelled(signal);
  if (format === "html") {
    export_analysis_report();
    return;
  }
  if (format === "json") {
    export_fit_json();
    return;
  }
  if (format === "csv") {
    export_fit_csv();
    return;
  }
  const clone = exportable_plot_svg();
  if (!clone) throw new Error("There is no plot to export yet.");
  const name = export_filename_stem();
  throw_if_cancelled(signal);

  if (format === "svg") {
    const text = `<?xml version="1.0" encoding="UTF-8"?>\n${serialize(clone)}`;
    download_blob(new Blob([text], { type: "image/svg+xml;charset=utf-8" }), `${name}.svg`);
    return;
  }
  if (format === "pdf") {
    // The vector converter reads computed styles. Keep the export clone in the
    // document just long enough for those values to resolve.
    clone.style.position = "fixed";
    clone.style.left = "-100000px";
    document.body.append(clone);
    try {
      download_blob(svg_to_pdf_blob(clone), `${name}.pdf`);
    } finally {
      clone.remove();
    }
    return;
  }
  if (format === "png" || format === "jpeg") {
    const blob = await rasterize(clone, format, Number(scale) > 0 ? Number(scale) : 1, signal);
    throw_if_cancelled(signal);
    download_blob(blob, `${name}.${format === "jpeg" ? "jpg" : "png"}`);
    return;
  }
  throw new Error(`Unsupported export format: ${format}`);
}

/*

Purpose:
	Opens the format picker, resetting any error from a previous attempt.

Input:
	(none)

Output:
	(none) [void]: shows #plot_export_modal

*/
export function open_plot_export_modal() {
  if (!plot_export_modal) return;
  if (plot_export_error) {
    plot_export_error.hidden = true;
    plot_export_error.textContent = "";
  }
  plot_export_modal.hidden = false;
  const checked = plot_export_modal.querySelector("input[name='plot_export_format']:checked");
  if (checked) checked.focus();
}

/*

Purpose:
	Hides the format picker without exporting.

Input:
	(none)

Output:
	(none) [void]: hides #plot_export_modal

*/
export function close_plot_export_modal() {
  export_controller?.abort();
  export_controller = null;
  if (plot_export_modal) plot_export_modal.hidden = true;
}

/*

Purpose:
	Runs the export for whichever format is selected in the modal, closing it on
	success and showing the failure in place (rather than a bare console error)
	if the browser refuses to encode the image.

Input:
	(none)

Output:
	(none) [Promise<void>]: downloads the file or reports the failure

*/
export async function submit_plot_export() {
  if (!plot_export_modal || export_controller) return;
  const selected = plot_export_modal.querySelector("input[name='plot_export_format']:checked");
  const format = selected ? selected.value : "svg";
  const scale = plot_export_scale_select ? Number(plot_export_scale_select.value) : 2;
  const download = plot_export_modal.querySelector("#plot_export_download");
  export_controller = new AbortController();
  if (download) { download.disabled = true; download.textContent = "Preparing…"; }
  try {
    await export_plot_image(format, scale, export_controller.signal);
    export_controller = null;
    close_plot_export_modal();
  } catch (error) {
    console.error("Plot export failed:", error);
    if (plot_export_error) {
      plot_export_error.textContent = error && error.message ? error.message : "The export failed.";
      plot_export_error.hidden = false;
    }
  } finally {
    export_controller = null;
    if (download) { download.disabled = false; download.textContent = "Download"; }
  }
}
