// Stage 2 scatter-gate editor. The fitted FSC-A × SSC-A ellipse can be moved
// and its coverage resized interactively; committing either edit delegates to
// the pipeline so the raw-index mask becomes authoritative downstream.

import * as d3 from "d3";
import {
  djf_scatter_modal,
  djf_scatter_modal_close,
  djf_scatter_reset,
  djf_scatter_coverage,
  djf_scatter_coverage_value,
  djf_scatter_plot,
  djf_scatter_caption,
} from "../ui/dom.js";
import { createScatterGateMask } from "./scatter_gmm_gate.js";
import { eigenDecomposition2D } from "./math/linalg2d.js";

const MAX_SCATTER_POINTS = 10000;
let listeners_initialized = false;
let active_context = null;

function clone_component(component) {
  return {
    ...component,
    mean: Array.from(component?.mean ?? []),
    covariance: Array.from(
      component?.covariance ?? [],
      row => Array.from(row ?? []),
    ),
  };
}

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

function count_retained(mask) {
  let retained = 0;
  for (const value of mask ?? []) retained += value ? 1 : 0;
  return retained;
}

function clamp_to_domain(value, domain) {
  const minimum = Math.min(domain[0], domain[1]);
  const maximum = Math.max(domain[0], domain[1]);
  return Math.max(minimum, Math.min(maximum, value));
}

function coverage_for_threshold(threshold) {
  return 1 - Math.exp(-Number(threshold) / 2);
}

function threshold_for_coverage(coverage) {
  return -2 * Math.log1p(-coverage);
}

function set_coverage_display(coverage) {
  const percent = 100 * coverage;
  if (djf_scatter_coverage) djf_scatter_coverage.value = percent.toFixed(1);
  if (djf_scatter_coverage_value) {
    djf_scatter_coverage_value.value = `${percent.toFixed(1)}%`;
    djf_scatter_coverage_value.textContent = `${percent.toFixed(1)}%`;
  }
}

function gate_for_component(row, result, component, threshold) {
  return createScatterGateMask(
    row.data.eventCount,
    result.scatterPoints,
    component,
    threshold,
  );
}

function set_caption({
  row,
  result,
  points,
  sampled,
  mask,
  component,
  threshold,
  preview = false,
}) {
  if (!djf_scatter_caption) return;
  const retained = count_retained(mask);
  const weights = (result.components || [])
    .map((candidate, index) => `component ${index + 1}: ${(100 * candidate.weight).toFixed(1)}%`)
    .join(" · ");
  const source = preview
    ? "Preview — release to apply"
    : result.manualOverride
      ? "Manual gate applied"
      : "Fitted gate";
  djf_scatter_caption.textContent = [
    row?.name || "Sample",
    source,
    `${retained.toLocaleString()} of ${points.length.toLocaleString()} eligible events retained`,
    `center (${component.mean[0].toFixed(2)}, ${component.mean[1].toFixed(2)})`,
    `coverage ${(100 * coverage_for_threshold(threshold)).toFixed(1)}%`,
    `Mahalanobis d² ≤ ${Number(threshold).toFixed(3)}`,
    `GMM ${result.converged ? "converged" : "did not converge"}`,
    weights,
    sampled.length < points.length ? `displayed ${sampled.length.toLocaleString()} downsampled points` : "",
  ].filter(Boolean).join(" · ");
}

function commit_active_gate(edit, { restoreFocus = false } = {}) {
  if (!active_context?.onGateChange) return null;
  const output = active_context.onGateChange(edit);
  const updated_result = output?.result ?? output ?? active_context.result;
  active_context.result = updated_result;
  render_scatter_gate(active_context.row, updated_result, {
    onGateChange: active_context.onGateChange,
  });
  if (restoreFocus) {
    window.requestAnimationFrame(() =>
      djf_scatter_plot?.querySelector(".djf_scatter_gate_handle")?.focus(),
    );
  }
  return output;
}

export function render_scatter_gate(
  row,
  result,
  { onGateChange = active_context?.onGateChange ?? null } = {},
) {
  if (!djf_scatter_plot) return;
  active_context = { row, result, onGateChange };
  djf_scatter_plot.innerHTML = "";
  if (djf_scatter_reset) djf_scatter_reset.disabled = !result?.manualOverride;
  if (result?.threshold > 0) set_coverage_display(coverage_for_threshold(result.threshold));

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
    .attr("aria-label", `${row?.name || "Sample"} interactive FSC-A by SSC-A cell gate`);

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

  const circles = svg.append("g")
    .selectAll("circle")
    .data(sampled)
    .join("circle")
    .attr("cx", (entry) => x(entry.point[0]))
    .attr("cy", (entry) => y(entry.point[1]))
    .attr("r", 1.35);

  const line = d3.line().x((point) => x(point[0])).y((point) => y(point[1]));
  (result.components || []).forEach((component, index) => {
    const selected = index === result.mainComponentIndex || component === result.mainComponent;
    if (selected) return;
    const ellipse = ellipse_points(component, result.threshold);
    if (!ellipse.length) return;
    svg.append("path")
      .attr("d", line(ellipse))
      .attr("fill", "none")
      .attr("stroke", "#647086")
      .attr("stroke-width", 1.2)
      .attr("stroke-dasharray", "5 4")
      .attr("opacity", 0.55);
  });

  let selected_component = clone_component(result.mainComponent);
  let selected_threshold = Number(result.threshold);
  let preview_gate = {
    mask: result.scatterMask || result.mask,
    mahalanobisDistanceSquared: result.mahalanobisDistanceSquared,
  };
  let drag_offset = [0, 0];
  let drag_changed = false;

  const visible_gate = svg.append("path")
    .attr("class", "djf_scatter_gate_visible")
    .attr("fill", "none")
    .attr("stroke", "#017f87")
    .attr("stroke-width", 2.4);
  const gate_handle = svg.append("path")
    .attr("class", "djf_scatter_gate_handle")
    .attr("fill", "none")
    .attr("stroke", "transparent")
    .attr("stroke-width", 18)
    .attr("pointer-events", "stroke")
    .attr("tabindex", 0)
    .attr("role", "button")
    .attr("aria-label", "Move Stage 2 cell gate. Use arrow keys for small movements and Shift plus arrow for larger movements.");
  const center_handle = svg.append("circle")
    .attr("class", "djf_scatter_gate_center")
    .attr("r", 5.5)
    .attr("aria-hidden", "true");

  const update_preview = (
    mean,
    threshold = selected_threshold,
    preview = true,
  ) => {
    selected_component = { ...selected_component, mean: [...mean] };
    selected_threshold = threshold;
    preview_gate = gate_for_component(row, result, selected_component, selected_threshold);
    const path = line(ellipse_points(selected_component, selected_threshold));
    visible_gate.attr("d", path);
    gate_handle.attr("d", path)
      .attr("aria-valuetext", `FSC-A ${mean[0].toFixed(2)}, SSC-A ${mean[1].toFixed(2)}`);
    center_handle.attr("cx", x(mean[0])).attr("cy", y(mean[1]));
    circles
      .attr("fill", (entry) => preview_gate.mask[entry.eventIndex] ? "#01a5af" : "#9ca3af")
      .attr("fill-opacity", (entry) => preview_gate.mask[entry.eventIndex] ? 0.5 : 0.22);
    set_caption({
      row,
      result,
      points,
      sampled,
      mask: preview_gate.mask,
      component: selected_component,
      threshold: selected_threshold,
      preview,
    });
  };

  active_context.previewCoverage = (coverage) => {
    const threshold = threshold_for_coverage(coverage);
    set_coverage_display(coverage);
    update_preview(selected_component.mean, threshold, true);
  };

  const pointer_data = (event) => {
    const [pixel_x, pixel_y] = d3.pointer(event.sourceEvent ?? event, svg.node());
    return [x.invert(pixel_x), y.invert(pixel_y)];
  };
  const drag = d3.drag()
    .on("start", (event) => {
      const pointer = pointer_data(event);
      drag_offset = [
        selected_component.mean[0] - pointer[0],
        selected_component.mean[1] - pointer[1],
      ];
      drag_changed = false;
      gate_handle.classed("djf_scatter_gate_dragging", true);
      center_handle.classed("djf_scatter_gate_dragging", true);
    })
    .on("drag", (event) => {
      const pointer = pointer_data(event);
      const mean = [
        clamp_to_domain(pointer[0] + drag_offset[0], x.domain()),
        clamp_to_domain(pointer[1] + drag_offset[1], y.domain()),
      ];
      drag_changed = drag_changed
        || Math.abs(mean[0] - selected_component.mean[0]) > Number.EPSILON
        || Math.abs(mean[1] - selected_component.mean[1]) > Number.EPSILON;
      update_preview(mean, selected_threshold, true);
    })
    .on("end", () => {
      gate_handle.classed("djf_scatter_gate_dragging", false);
      center_handle.classed("djf_scatter_gate_dragging", false);
      if (drag_changed) {
        commit_active_gate({
          mean: [...selected_component.mean],
          coverage: coverage_for_threshold(selected_threshold),
        });
      }
    });

  gate_handle.call(drag);
  center_handle.call(drag);
  gate_handle
    .on("focus", () => visible_gate.classed("djf_scatter_gate_focus", true))
    .on("blur", () => visible_gate.classed("djf_scatter_gate_focus", false))
    .on("keydown", (event) => {
      const movement = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowDown: [0, -1],
        ArrowUp: [0, 1],
      }[event.key];
      if (!movement) return;
      event.preventDefault();
      const scale = event.shiftKey ? 0.05 : 0.01;
      const x_span = Math.abs(x.domain()[1] - x.domain()[0]);
      const y_span = Math.abs(y.domain()[1] - y.domain()[0]);
      const mean = [
        clamp_to_domain(selected_component.mean[0] + movement[0] * scale * x_span, x.domain()),
        clamp_to_domain(selected_component.mean[1] + movement[1] * scale * y_span, y.domain()),
      ];
      update_preview(mean, selected_threshold, true);
      commit_active_gate({
        mean,
        coverage: coverage_for_threshold(selected_threshold),
      }, { restoreFocus: true });
    });

  update_preview(selected_component.mean, selected_threshold, false);
}

export function open_scatter_modal(row, result, options = {}) {
  if (!djf_scatter_modal) return;
  active_context = { row, result, onGateChange: options.onGateChange ?? null };
  render_scatter_gate(row, result, options);
  djf_scatter_modal.hidden = false;
  djf_scatter_modal_close?.focus();
}

export function close_scatter_modal() {
  if (djf_scatter_modal) djf_scatter_modal.hidden = true;
  active_context = null;
}

export function init_scatter_modal() {
  if (!djf_scatter_modal || listeners_initialized) return;
  listeners_initialized = true;
  djf_scatter_modal_close?.addEventListener("click", close_scatter_modal);
  djf_scatter_reset?.addEventListener("click", () =>
    commit_active_gate({ reset: true }, { restoreFocus: true }),
  );
  djf_scatter_coverage?.addEventListener("input", () => {
    const coverage = Number(djf_scatter_coverage.value) / 100;
    if (coverage > 0 && coverage < 1) active_context?.previewCoverage?.(coverage);
  });
  djf_scatter_coverage?.addEventListener("change", () => {
    const coverage = Number(djf_scatter_coverage.value) / 100;
    if (coverage > 0 && coverage < 1) commit_active_gate({ coverage });
  });
  djf_scatter_modal.querySelector(".stats_modal_backdrop")?.addEventListener("click", close_scatter_modal);
  djf_scatter_modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close_scatter_modal();
  });
}

export { ellipse_points };
