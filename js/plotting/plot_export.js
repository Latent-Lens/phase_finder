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
} from "./data.js";
import { svg_to_pdf_blob } from "./svg_to_pdf.js";

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

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
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
function rasterize(svg_clone, format, scale) {
  const width = Number(svg_clone.getAttribute("width")) || 0;
  const height = Number(svg_clone.getAttribute("height")) || 0;
  if (!(width > 0) || !(height > 0)) return Promise.reject(new Error("The plot has no drawable size."));

  const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialize(svg_clone))}`;
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const context = canvas.getContext("2d");
      if (format === "jpeg") {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.drawImage(image, 0, 0, width, height);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("The browser could not encode the image."))),
        format === "jpeg" ? "image/jpeg" : "image/png",
        format === "jpeg" ? 0.92 : undefined,
      );
    };
    image.onerror = () => reject(new Error("The plot image could not be rendered for export."));
    image.src = source;
  });
}

/*

Purpose:
	Exports the plot currently on screen in one of the four supported formats
	and triggers the download.

Input:
	format [string]: "svg", "pdf", "png" or "jpeg"
	scale [number]: pixel scale for the raster formats (ignored for svg/pdf)

Output:
	(none) [Promise<void>]: resolves once the download has been started;
	                        rejects with a user-presentable Error

*/
export async function export_plot_image(format, scale = 2) {
  const svg = current_plot_svg();
  if (!svg) throw new Error("There is no plot to export yet.");
  const clone = inline_styled_clone(svg);
  const name = `phasefinder_plot_${timestamp()}`;

  if (format === "svg") {
    const text = `<?xml version="1.0" encoding="UTF-8"?>\n${serialize(clone)}`;
    download_blob(new Blob([text], { type: "image/svg+xml;charset=utf-8" }), `${name}.svg`);
    return;
  }
  if (format === "pdf") {
    // Converted from the live SVG (not the clone): the converter reads computed
    // styles itself, which only resolve for nodes that are in the document.
    download_blob(svg_to_pdf_blob(svg), `${name}.pdf`);
    return;
  }
  if (format === "png" || format === "jpeg") {
    const blob = await rasterize(clone, format, Number(scale) > 0 ? Number(scale) : 1);
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
  if (!plot_export_modal) return;
  const selected = plot_export_modal.querySelector("input[name='plot_export_format']:checked");
  const format = selected ? selected.value : "svg";
  const scale = plot_export_scale_select ? Number(plot_export_scale_select.value) : 2;
  try {
    await export_plot_image(format, scale);
    close_plot_export_modal();
  } catch (error) {
    console.error("Plot export failed:", error);
    if (plot_export_error) {
      plot_export_error.textContent = error && error.message ? error.message : "The export failed.";
      plot_export_error.hidden = false;
    }
  }
}
