// Stage 2 scatter-gate diagnostics modal. The gate has already been stored when
// this view opens; this is an inspection-only FSC-A × SSC-A rendering.

import * as d3 from "d3";
import {
  djf_scatter_modal,
  djf_scatter_modal_close,
  djf_scatter_plot,
  djf_scatter_caption,
} from "../../ui/dom.js";
import { eigenDecomposition2D } from "./math/linalg2d.js";

const MAX_SCATTER_POINTS = 10000;
let listeners_initialized = false;

function ellipse_points(component, threshold, count = 120) {
  if (!component || !component.mean || !component.covariance) return [];
  const decomposition = eigenDecomposition2D(component.covariance);
  const [major_value, minor_value] = decomposition.values;
  if (!(major_value > 0) || !(minor_value > 0) || !(threshold > 0)) return [];

  const [major_vector, minor_vector] = decomposition.vectors;
  const major_radius = Math.sqrt(major_value * threshold);
  const minor_radius = Math.sqrt(minor_value * threshold);
  const points = [];
  for (let index = 0; index <= count; index += 1) {
    const angle = (2 * Math.PI * index) / count;
    const major_offset = major_radius * Math.cos(angle);
    const minor_offset = minor_radius * Math.sin(angle);
    points.push([
      component.mean[0] + major_vector[0] * major_offset + minor_vector[0] * minor_offset,
      component.mean[1] + major_vector[1] * major_offset + minor_vector[1] * minor_offset,
    ]);
  }
  return points;
}

function padded_extent(values) {
  let [minimum, maximum] = d3.extent(values);
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return [0, 1];
  if (!(maximum > minimum)) maximum = minimum + 1;
  const padding = 0.04 * (maximum - minimum);
  return [minimum - padding, maximum + padding];
}

export function render_scatter_gate(row, result) {
  if (!djf_scatter_plot) return;
  djf_scatter_plot.innerHTML = "";

  if (!result || result.skipped || !Array.isArray(result.scatterPoints) || !result.scatterPoints.length) {
    const note = document.createElement("p");
    note.className = "djf_scatter_empty";
    note.textContent = result?.reason || "No FSC-A/SSC-A scatter diagnostics are available.";
    djf_scatter_plot.appendChild(note);
    if (djf_scatter_caption) djf_scatter_caption.textContent = "";
    return;
  }

  const points = result.scatterPoints.filter((entry) =>
    entry && Array.isArray(entry.point)
      && Number.isFinite(entry.point[0])
      && Number.isFinite(entry.point[1])
  );
  const stride = Math.max(1, Math.ceil(points.length / MAX_SCATTER_POINTS));
  const sampled = points.filter((_, index) => index % stride === 0);
  const mask = result.scatterMask || result.mask;
  const width = Math.max(620, djf_scatter_plot.clientWidth || 800);
  const height = 390;
  const margin = { top: 14, right: 24, bottom: 48, left: 66 };
  const x = d3.scaleLinear()
    .domain(padded_extent(points.map((entry) => entry.point[0])))
    .nice()
    .range([margin.left, width - margin.right]);
  const y = d3.scaleLinear()
    .domain(padded_extent(points.map((entry) => entry.point[1])))
    .nice()
    .range([height - margin.bottom, margin.top]);

  const svg = d3.select(djf_scatter_plot).append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("role", "img")
    .attr("aria-label", `${row?.name || "Sample"} FSC-A by SSC-A cell gate`);

  svg.append("g")
    .attr("transform", `translate(0,${height - margin.bottom})`)
    .call(d3.axisBottom(x).ticks(6));
  svg.append("g")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(6));
  svg.append("text")
    .attr("x", (margin.left + width - margin.right) / 2)
    .attr("y", height - 9)
    .attr("text-anchor", "middle")
    .attr("font-size", 12)
    .text("FSC-A");
  svg.append("text")
    .attr("transform", "rotate(-90)")
    .attr("x", -(margin.top + height - margin.bottom) / 2)
    .attr("y", 16)
    .attr("text-anchor", "middle")
    .attr("font-size", 12)
    .text("SSC-A");

  svg.append("g")
    .selectAll("circle")
    .data(sampled)
    .join("circle")
    .attr("cx", (entry) => x(entry.point[0]))
    .attr("cy", (entry) => y(entry.point[1]))
    .attr("r", 1.35)
    .attr("fill", (entry) => mask && mask[entry.eventIndex] ? "#01a5af" : "#9ca3af")
    .attr("fill-opacity", (entry) => mask && mask[entry.eventIndex] ? 0.5 : 0.22);

  const line = d3.line().x((point) => x(point[0])).y((point) => y(point[1]));
  (result.components || []).forEach((component, index) => {
    const selected = index === result.mainComponentIndex || component === result.mainComponent;
    const ellipse = ellipse_points(component, result.threshold);
    if (!ellipse.length) return;
    svg.append("path")
      .attr("d", line(ellipse))
      .attr("fill", "none")
      .attr("stroke", selected ? "#017f87" : "#647086")
      .attr("stroke-width", selected ? 2.4 : 1.2)
      .attr("stroke-dasharray", selected ? null : "5 4")
      .attr("opacity", selected ? 1 : 0.55);
  });

  const retained = mask ? Array.from(mask).reduce((sum, value) => sum + (value ? 1 : 0), 0) : 0;
  const weights = (result.components || [])
    .map((component, index) => `component ${index + 1}: ${(100 * component.weight).toFixed(1)}%`)
    .join(" · ");
  if (djf_scatter_caption) {
    djf_scatter_caption.textContent = [
      row?.name || "Sample",
      `${retained.toLocaleString()} of ${points.length.toLocaleString()} eligible events retained`,
      `Mahalanobis d² ≤ ${Number(result.threshold).toFixed(3)}`,
      `GMM ${result.converged ? "converged" : "did not converge"}`,
      weights,
      sampled.length < points.length ? `displayed ${sampled.length.toLocaleString()} downsampled points` : "",
    ].filter(Boolean).join(" · ");
  }
}

export function open_scatter_modal(row, result) {
  if (!djf_scatter_modal) return;
  render_scatter_gate(row, result);
  djf_scatter_modal.hidden = false;
  djf_scatter_modal_close?.focus();
}

export function close_scatter_modal() {
  if (djf_scatter_modal) djf_scatter_modal.hidden = true;
}

export function init_scatter_modal() {
  if (!djf_scatter_modal || listeners_initialized) return;
  listeners_initialized = true;
  djf_scatter_modal_close?.addEventListener("click", close_scatter_modal);
  djf_scatter_modal.querySelector(".stats_modal_backdrop")?.addEventListener("click", close_scatter_modal);
  djf_scatter_modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close_scatter_modal();
  });
}
