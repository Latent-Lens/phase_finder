// Ridge view: stacked per-sample small-multiples for multi-sample review, plus
// the "blow one sample up for manual peak-region review" workflow (the
// draggable G1/G2 boundary editor drawn directly on a ridge row, its numeric
// fallback form, and the "Under manual review" header bar shown when a row is
// blown up). Split out of render.js (AUDIT-008) as the self-contained ridge
// feature the overlay renderer (render.js) neither needs nor touches.
//
// Blowing a row up, and committing an edited region, both trigger a full plot
// redraw. That redraw is the overlay renderer's render_density_plot(), which
// this module reaches via plot_viewport.js's get_plot_renderer() rather than
// importing render.js directly: render.js already imports render_ridge_plot
// from this module for the ridge-view branch, and importing back would create
// a cycle (config/import-cycle-allowlist.json has none permitted). See
// get_plot_renderer()'s doc comment in plot_viewport.js.

import * as d3 from "d3";
import {
  plot_area,
  plot_color_by_select,
  plot_bin_count,
  plot_display_mode,
  plottable_rows,
  set_ridge_focus_name,
  axis_opts,
  build_color_assigner,
  axis_range_override,
  set_last_series,
  set_row_colors,
  PLOT_FALLBACK_WIDTH,
  AXIS_LINE_WIDTH,
  AXIS_LABEL_COLOR,
  SAMPLE_LINE_WIDTH,
  SAMPLE_BIN_OPACITY_WITH_CURVE,
  SAMPLE_BIN_OPACITY_ONLY,
  SAMPLE_BIN_WIDTH_RATIO,
  DJF_G1_COLOR,
  DJF_S_COLOR,
  DJF_G2_COLOR,
  DJF_TOTAL_COLOR,
  DJF_FILL_OPACITY,
  DJF_COMPONENT_LINE_WIDTH,
} from "./data.js";
import { set_focused_file_id } from "../data_structs/table_state.js";
import { update_plot_title } from "./modeling.js";
import { get_state as get_pipeline_state, get_active_model_result } from "../analysis/pipeline/pipeline_state.js";
import { update_peak_regions, fit_cell_cycle_model } from "../analysis/cell_cycle/modeling_state.js";
import { get_plot_renderer } from "./plot_viewport.js";
import { set_status_bar } from "../ui/status_channels.js";
import {
  SAMPLE_LINE_STYLES,
  prepare_row,
  prepared_histogram,
  prune_plot_compute_cache,
  replace_plot_caches,
  clipping_stats,
  pipeline_fit_for_series,
  visible_histogram_range,
  strip_fcs_ext,
  plot_controls_offset,
} from "./histogram_prep.js";
import { make_plot_accessible, render_plot_accessibility_summary, render_plot_clipping_warning } from "./plot_accessibility.js";

// Ridge rows get their own axes, but at ~118px tall they cannot carry the
// overlay plot's tick density or type size -- these are sized so each small
// multiple stays readable without the labels colliding.
const RIDGE_AXIS_FONT_SIZE = 9;
const RIDGE_X_AXIS_TICKS = 6;
const RIDGE_Y_AXIS_TICKS = 3;

// Ridge "Review" -> blow one sample up to the full single-sample plot for manual
// region editing. Focusing the row makes it the Identify Peaks panel's active
// sample (so its draggable region handles + inputs target it); render then falls
// through to the overlay path (filtered to this one sample) because
// ridge_focus_name is set.
function enter_ridge_review(row) {
  set_ridge_focus_name(row.name);
  set_focused_file_id(row.id);
  document.dispatchEvent(new CustomEvent("cell-cycle-focus-change"));
  get_plot_renderer()();
}

// Accept -> leave the blow-up and return to the ridge (badge back to Ready).
function exit_ridge_review() {
  set_ridge_focus_name(null);
  get_plot_renderer()();
}

// Draggable G1/G2 peak-region boundaries drawn directly on a ridge row, so the
// user can resize/move each region without blowing the sample up. Mirrors
// peak_region_overlay.js's ordering rule (G1.left < G1.right <= G2.left <
// G2.right) live during the drag, and commits + refits that one sample on
// release (commit_ridge_regions).
const RIDGE_G1_COLOR = "#2563eb";
const RIDGE_G2_COLOR = "#b42318";
const RIDGE_BOUNDARIES = [
  { key: "g1_left", region: "g1", side: "left", color: RIDGE_G1_COLOR },
  { key: "g1_right", region: "g1", side: "right", color: RIDGE_G1_COLOR },
  { key: "g2_left", region: "g2", side: "left", color: RIDGE_G2_COLOR },
  { key: "g2_right", region: "g2", side: "right", color: RIDGE_G2_COLOR },
];
const ridge_boundary_value = (live, key) => live[key.startsWith("g1") ? "g1" : "g2"][key.endsWith("left") ? "left" : "right"];
const set_ridge_boundary = (live, key, value) => { live[key.startsWith("g1") ? "g1" : "g2"][key.endsWith("left") ? "left" : "right"] = value; };

const ridge_pending_samples = new Set();

function ridge_status(entry, fit) {
  const modeling = entry.pipelineState?.modeling;
  if (ridge_pending_samples.has(entry.name)) return { key: "fitting", label: "Fitting", reason: "Region edit saved; model fit is running." };
  if (!modeling?.peakSelection?.regions) return { key: "empty", label: "No regions", reason: "Detect G1/G2 regions before fitting." };
  if (modeling.peakSelection.stale) return { key: "stale", label: "Stale", reason: modeling.lastInvalidationReason || "Histogram inputs changed; detect peaks again." };
  if (fit) {
    if (fit.warnings?.length) return { key: "warning", label: "Fit warning", reason: fit.warnings.map((warning) => warning.message || String(warning)).join("; ") };
    if (!get_active_model_result(entry.pipelineState)?.converged) return { key: "nonconverged", label: "Not converged", reason: get_active_model_result(entry.pipelineState)?.convergenceReason || "The fit produced a result but did not converge." };
    return { key: "converged", label: "Converged", reason: `Model fit revision ${modeling.revision}.` };
  }
  const diagnostic = modeling.lastDiagnosticResultKey ? modeling.resultsByKey?.[modeling.lastDiagnosticResultKey] : null;
  if (diagnostic?.cancelled) return { key: "cancelled", label: "Cancelled", reason: diagnostic.convergenceReason || "Fit cancelled." };
  if (diagnostic?.computed && !diagnostic.converged) return { key: "nonconverged", label: "Not converged", reason: diagnostic.convergenceReason || "The fit was computed but did not converge." };
  if (diagnostic) return { key: "failed", label: "Invalid result", reason: diagnostic.validityReasons?.map((reason) => reason.message || reason.code).join("; ") || "The result is not valid for reporting." };
  if (modeling.lastBulkFitOutcome?.status === "cancelled") return { key: "cancelled", label: "Cancelled", reason: modeling.lastBulkFitOutcome.reason };
  if (modeling.lastFitError) return { key: "failed", label: "Fit failed", reason: modeling.lastFitError.message || String(modeling.lastFitError) };
  return { key: "ready", label: "Ready", reason: `Regions ready at revision ${modeling.revision}.` };
}

// Commit a ridge row's edited regions and re-fit just that sample with its
// model, then re-render the ridge so its fit + box reflect the edit.
async function commit_ridge_regions(row, live) {
  if (ridge_pending_samples.has(row.name)) return;
  ridge_pending_samples.add(row.name);
  get_plot_renderer()();
  try {
    update_peak_regions(row, {
      g1: { left: live.g1.left, right: live.g1.right },
      g2: { left: live.g2.left, right: live.g2.right },
    }, { source: "manual", minimumGap: -0.01 });
    const modelId = get_pipeline_state(row.name)?.modeling?.settings?.modelId;
    if (modelId) {
      const result = await fit_cell_cycle_model(row, modelId);
      const modeling = get_pipeline_state(row.name)?.modeling;
      if (modeling) modeling.lastFitError = result.validForReporting ? null : {
        code: "invalid_for_reporting",
        message: result.validityReasons?.map((reason) => reason.message || reason.code).join("; ") || "The result is not valid for reporting.",
      };
    }
  } catch (error) {
    const modeling = get_pipeline_state(row.name)?.modeling;
    if (modeling) modeling.lastFitError = { code: error?.code || "ridge_fit_failed", message: error?.message || String(error) };
    set_status_bar(`Ridge fit failed for ${row.name}: ${error.message}`, true, null, null, error);
  } finally {
    ridge_pending_samples.delete(row.name);
    document.dispatchEvent(new CustomEvent("cell-cycle-fit-changed"));
    get_plot_renderer()();
  }
}

function draw_ridge_region_editor(svg, row, x_scale, top, bottom) {
  const regions = get_pipeline_state(row.name)?.modeling?.peakSelection?.regions;
  if (!regions?.g1 || !regions?.g2) return;
  const [domain_min, domain_max] = x_scale.domain();
  const live = { g1: { ...regions.g1 }, g2: { ...regions.g2 } };

  const group = svg.append("g").attr("class", "ridge_region_editor");
  const bands = {
    g1: group.append("rect").attr("class", "ridge_region_band").attr("fill", RIDGE_G1_COLOR).attr("fill-opacity", 0.1),
    g2: group.append("rect").attr("class", "ridge_region_band").attr("fill", RIDGE_G2_COLOR).attr("fill-opacity", 0.1),
  };
  // Mirrors peak_region_overlay.js's label pills, sized for a much shorter row:
  // "G1"/"G2/M" over each band so the auto-detected peaks are identifiable at a
  // glance, not just a colored region with no name attached.
  const RIDGE_REGION_LABEL_TEXT = { g1: "G1", g2: "G2/M" };
  const label_group = group.append("g").attr("class", "ridge_region_label_group");
  const region_labels = {
    g1: {
      pill: label_group.append("rect").attr("class", "peak_region_label_pill").attr("fill", RIDGE_G1_COLOR),
      text: label_group.append("text").attr("class", "peak_region_label_text").attr("text-anchor", "middle").text(RIDGE_REGION_LABEL_TEXT.g1),
    },
    g2: {
      pill: label_group.append("rect").attr("class", "peak_region_label_pill").attr("fill", RIDGE_G2_COLOR),
      text: label_group.append("text").attr("class", "peak_region_label_text").attr("text-anchor", "middle").text(RIDGE_REGION_LABEL_TEXT.g2),
    },
  };
  const edges = {};

  const redraw = () => {
    ["g1", "g2"].forEach((region) => {
      const x0 = x_scale(live[region].left);
      const x1 = x_scale(live[region].right);
      const band_x = Math.min(x0, x1);
      const band_width = Math.max(0, Math.abs(x1 - x0));
      bands[region].attr("x", band_x).attr("y", top).attr("width", band_width).attr("height", Math.max(0, bottom - top));

      const label_center = band_x + band_width / 2;
      const { pill, text } = region_labels[region];
      text.attr("x", label_center).attr("y", top + 12);
      // getBBox() can throw on some engines (notably Firefox) if the SVG isn't
      // in a fully laid-out state yet; fall back to a fixed-size pill rather
      // than letting that abort the rest of this render pass.
      let text_box;
      try {
        text_box = text.node().getBBox();
      } catch (_) {
        text_box = { x: label_center - 12, y: top + 3, width: 24, height: 10 };
      }
      pill
        .attr("x", text_box.x - 4)
        .attr("y", text_box.y - 2)
        .attr("width", text_box.width + 8)
        .attr("height", text_box.height + 4);
    });
    RIDGE_BOUNDARIES.forEach(({ key }) => {
      const px = x_scale(ridge_boundary_value(live, key));
      edges[key].line.attr("x1", px).attr("x2", px).attr("y1", top).attr("y2", bottom);
      edges[key].hit.attr("x", px - 5).attr("y", top).attr("width", 10).attr("height", Math.max(0, bottom - top));
    });
  };

  const boundary_limits = (key) => {
    switch (key) {
      case "g1_left": return [domain_min, live.g1.right];
      case "g1_right": return [live.g1.left, live.g2.left];
      case "g2_left": return [live.g1.right, live.g2.right];
      case "g2_right": return [live.g2.left, domain_max];
      default: return [domain_min, domain_max];
    }
  };

  RIDGE_BOUNDARIES.forEach(({ key, color }) => {
    const line = group.append("line").attr("class", "ridge_region_edge").attr("stroke", color).attr("stroke-width", 1.5).attr("stroke-dasharray", "3 2");
    const hit = group.append("rect").attr("class", "ridge_region_hit").attr("fill", "transparent").style("cursor", "ew-resize");
    edges[key] = { line, hit };
    hit.call(d3.drag()
      .on("drag", (event) => {
        const [lo, hi] = boundary_limits(key);
        set_ridge_boundary(live, key, Math.max(lo, Math.min(hi, x_scale.invert(event.x))));
        redraw();
      })
      .on("end", () => commit_ridge_regions(row, live)));
  });

  // Band body drag -> move the whole region (both edges) within its neighbours.
  const px_per_data = (x_scale.range()[1] - x_scale.range()[0]) / (domain_max - domain_min || 1);
  ["g1", "g2"].forEach((region) => {
    bands[region].style("cursor", "grab").call(d3.drag()
      .on("drag", (event) => {
        const width = live[region].right - live[region].left;
        const lower = region === "g1" ? domain_min : live.g1.right;
        const upper = region === "g1" ? live.g2.left : domain_max;
        let left = live[region].left + event.dx / px_per_data;
        left = Math.max(lower, Math.min(upper - width, left));
        live[region].left = left;
        live[region].right = left + width;
        redraw();
      })
      .on("end", () => commit_ridge_regions(row, live)));
  });

  redraw();
}

function ridge_region_form(row, domain_min, domain_max) {
  const regions = get_pipeline_state(row.name)?.modeling?.peakSelection?.regions;
  if (!regions?.g1 || !regions?.g2) return null;
  const details = document.createElement("details");
  details.className = "ridge_region_numeric";
  const summary = document.createElement("summary");
  summary.textContent = "Edit peak boundaries numerically";
  const form = document.createElement("form");
  const fields = [
    ["g1_left", "G1 left", regions.g1.left],
    ["g1_right", "G1 right", regions.g1.right],
    ["g2_left", "G2/M left", regions.g2.left],
    ["g2_right", "G2/M right", regions.g2.right],
  ];
  const inputs = new Map();
  fields.forEach(([name, label_text, value]) => {
    const label = document.createElement("label");
    label.textContent = label_text;
    const input = document.createElement("input");
    input.type = "number";
    input.name = name;
    input.min = String(domain_min);
    input.max = String(domain_max);
    input.step = "any";
    input.value = String(value);
    label.appendChild(input);
    form.appendChild(label);
    inputs.set(name, input);
  });
  const error = document.createElement("span");
  error.className = "ridge_region_numeric_error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  const apply = document.createElement("button");
  apply.type = "submit";
  apply.textContent = "Apply boundaries";
  form.append(error, apply);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = Object.fromEntries([...inputs].map(([name, input]) => [name, Number(input.value)]));
    const valid = Object.values(values).every(Number.isFinite)
      && values.g1_left >= domain_min && values.g2_right <= domain_max
      && values.g1_left < values.g1_right
      && values.g1_right <= values.g2_left
      && values.g2_left < values.g2_right;
    error.hidden = valid;
    error.textContent = valid ? "" : "Enter ordered boundaries within the visible X range: G1 left < G1 right ≤ G2/M left < G2/M right.";
    if (!valid) return inputs.get("g1_left").focus();
    commit_ridge_regions(row, {
      g1: { left: values.g1_left, right: values.g1_right },
      g2: { left: values.g2_left, right: values.g2_right },
    });
  });
  details.append(summary, form);
  return details;
}

// Ridge view: each plotted sample rendered as its own small histogram (with its
// fit overlay) stacked vertically for side-by-side multi-sample review. All
// rows share one x-scale so peaks line up. Each row shows its current modeling
// status and reason. Keeps the shared
// plot maps in sync (debug API + table swatches) exactly like the overlay path.
export function render_ridge_plot() {
  const rows = plottable_rows();
  prune_plot_compute_cache(rows);
  plot_area.innerHTML = "";
  if (!rows.length) return;

  const bins = plot_bin_count();
  const is_log = false;
  // Honour the Display control here too, exactly as the overlay renderer does:
  // "Curve", "Curve + bins" and "Bins" all apply in the ridge view.
  const display_mode = typeof plot_display_mode === "function" ? plot_display_mode() : "curve";
  const show_bins = display_mode === "bins" || display_mode === "curve_bins";
  const show_curves = display_mode !== "bins";
  const prepared_rows = rows.map((row) => ({ row, prepared: prepare_row(row) }));

  const range = visible_histogram_range(prepared_rows, is_log);
  const opts = axis_opts(range, is_log, bins);
  let x_domain = [
    axis_range_override.x_min != null ? axis_range_override.x_min : range[0],
    axis_range_override.x_max != null ? axis_range_override.x_max : range[1],
  ];
  if (!(x_domain[1] > x_domain[0])) x_domain = range;

  const assign = build_color_assigner(rows, plot_color_by_select ? plot_color_by_select.value : "file");
  const entries = prepared_rows.map(({ row, prepared }, index) => {
    const { color, group } = assign(row, index);
    const { points, histogram } = prepared_histogram(row.name, prepared, opts);
    const entry = { row, name: row.name, color, group, lineStyle: SAMPLE_LINE_STYLES[index % SAMPLE_LINE_STYLES.length], values: prepared.values, stats: { ...prepared.stats, ...clipping_stats(prepared.values, histogram) }, points, histogram, pipelineState: prepared.pipelineState };
    return { entry, color, fit: pipeline_fit_for_series(entry) };
  });

  set_last_series(entries.map((item) => item.entry));
  set_row_colors(entries.map((item) => ({ id: item.entry.row.id, color: item.color, group: item.entry.group })));
  replace_plot_caches(entries.map((item) => item.entry));
  update_plot_title(rows, entries.reduce((sum, item) => sum + item.entry.values.length, 0));

  const total_width = plot_area.clientWidth || PLOT_FALLBACK_WIDTH;
  // Every row carries its own labelled x and y axis, so each small multiple can
  // be read on its own terms (a row's counts are only comparable to its
  // neighbours' if you can see both scales). The margins are the room those
  // ticks need; the row is taller to pay for the bottom axis without squeezing
  // the curve.
  const row_height = 118;
  const margin = { top: 8, right: 14, bottom: 24, left: 48 };
  const x_scale = d3.scaleLinear().domain(x_domain).range([margin.left, total_width - margin.right]);

  const container = document.createElement("div");
  container.className = "ridge_container";
  // Clear the floating controls so the first row's header isn't hidden.
  container.style.paddingTop = `${plot_controls_offset()}px`;

  entries.forEach(({ entry, color, fit }) => {
    const row_el = document.createElement("div");
    row_el.className = "ridge_row";
    row_el.dataset.sampleName = entry.name;

    const header = document.createElement("div");
    header.className = "ridge_row_header";
    const name_el = document.createElement("span");
    name_el.className = "ridge_row_name";
    name_el.textContent = strip_fcs_ext(entry.name);
    name_el.title = entry.name;
    const badge_state = ridge_status(entry, fit);
    const badge = document.createElement("span");
    badge.className = `ridge_badge ridge_badge_${badge_state.key}`;
    badge.textContent = badge_state.label;
    badge.title = badge_state.reason;
    const review_btn = document.createElement("button");
    review_btn.type = "button";
    review_btn.className = "ridge_review_button";
    review_btn.textContent = "Manual Review";
    review_btn.disabled = badge_state.key === "fitting";
    review_btn.title = `Blow up ${strip_fcs_ext(entry.name)} for manual peak-region review`;
    review_btn.addEventListener("click", () => enter_ridge_review(entry.row));
    header.append(name_el, badge, review_btn);
    row_el.appendChild(header);
    const numeric_editor = ridge_region_form(entry.row, x_domain[0], x_domain[1]);
    if (numeric_editor) row_el.appendChild(numeric_editor);

    const svg = d3.select(document.createElementNS("http://www.w3.org/2000/svg", "svg"))
      .attr("class", "ridge_svg")
      .attr("width", total_width)
      .attr("height", row_height);
    const y_max = Math.max(
      d3.max(entry.points, (point) => point.y) || 0,
      fit ? (d3.max(fit.total, (point) => point.y) || 0) : 0,
    ) || 1;
    const y_scale = d3.scaleLinear().domain([0, y_max]).range([row_height - margin.bottom, margin.top]);
    const line = d3.line().x((point) => x_scale(point.x)).y((point) => y_scale(point.y));

    // Per-row axes, drawn first so the curve and fit sit on top of them. Tick
    // counts and type are deliberately smaller than the overlay plot's: a row
    // this short has no room for a full set of labels, and the job here is
    // orientation -- letting each small multiple be read on its own scale --
    // not precise reading.
    const style_ridge_axis = (group) => {
      group.style("font-size", `${RIDGE_AXIS_FONT_SIZE}px`);
      group.selectAll(".domain, .tick line").attr("stroke-width", AXIS_LINE_WIDTH);
      group.selectAll("text").attr("fill", AXIS_LABEL_COLOR);
      return group;
    };
    style_ridge_axis(svg.append("g")
      .attr("class", "ridge_x_axis")
      .attr("transform", `translate(0,${row_height - margin.bottom})`)
      .call(d3.axisBottom(x_scale).ticks(RIDGE_X_AXIS_TICKS)));
    style_ridge_axis(svg.append("g")
      .attr("class", "ridge_y_axis")
      .attr("transform", `translate(${margin.left},0)`)
      .call(d3.axisLeft(y_scale).ticks(RIDGE_Y_AXIS_TICKS, "~s")));

    if (fit) {
      const area = d3.area().x((point) => x_scale(point.x)).y0(y_scale(0)).y1((point) => y_scale(point.y));
      const component = (data, fill, line_style) => {
        if (!data) return;
        svg.append("path").attr("fill", fill).attr("fill-opacity", DJF_FILL_OPACITY).attr("stroke", "none").attr("d", area(data));
        svg.append("path").attr("fill", "none").attr("stroke", AXIS_LABEL_COLOR).attr("stroke-width", DJF_COMPONENT_LINE_WIDTH).attr("stroke-dasharray", line_style).attr("d", line(data));
      };
      component(fit.g1, DJF_G1_COLOR, null);
      component(fit.s, DJF_S_COLOR, "7 3");
      component(fit.g2, DJF_G2_COLOR, "2 2");
    }
    // Histogram bars when the Display mode calls for them (bins-only or
    // curve+bins), using this row's own bin edges -- the same drawing the
    // overlay uses, at the row's own y-scale.
    if (show_bins) {
      const edges = entry.histogram && entry.histogram.binEdges;
      const bar_opacity = show_curves ? SAMPLE_BIN_OPACITY_WITH_CURVE : SAMPLE_BIN_OPACITY_ONLY;
      const bar_base_y = y_scale(0);
      svg.append("g")
        .attr("fill", color || "#5b6472")
        .attr("fill-opacity", bar_opacity)
        .selectAll("rect")
        .data(entry.points.map((point, index) => ({ point, index })))
        .join("rect")
        .attr("x", ({ point, index }) => {
          if (edges && edges[index] != null && edges[index + 1] != null) {
            const x0 = x_scale(edges[index]);
            const x1 = x_scale(edges[index + 1]);
            const width_px = Math.abs(x1 - x0) * SAMPLE_BIN_WIDTH_RATIO;
            return Math.min(x0, x1) + (Math.abs(x1 - x0) - width_px) / 2;
          }
          return x_scale(point.x) - 1;
        })
        .attr("y", ({ point }) => Math.min(y_scale(point.y), bar_base_y))
        .attr("width", ({ index }) => {
          if (edges && edges[index] != null && edges[index + 1] != null) {
            return Math.max(1, Math.abs(x_scale(edges[index + 1]) - x_scale(edges[index])) * SAMPLE_BIN_WIDTH_RATIO);
          }
          return 2;
        })
        .attr("height", ({ point }) => Math.abs(bar_base_y - y_scale(point.y)));
    }
    if (show_curves) {
      svg.append("path").attr("fill", "none").attr("stroke", color || "#5b6472").attr("stroke-width", SAMPLE_LINE_WIDTH).attr("stroke-dasharray", entry.lineStyle).attr("d", line(entry.points));
    }
    if (fit) {
      svg.append("path").attr("fill", "none").attr("stroke", DJF_TOTAL_COLOR).attr("stroke-width", 1.4).attr("d", line(fit.total));
    }
    // Draggable G1/G2 region boundaries so peaks can be edited in place.
    draw_ridge_region_editor(svg, entry.row, x_scale, margin.top, row_height - margin.bottom);
    make_plot_accessible(svg, {
      mode: "Ridge",
      entries: [entry],
      fits: fit ? [fit] : [],
      x_domain,
      y_domain: [0, y_max],
    });
    row_el.appendChild(svg.node());
    container.appendChild(row_el);
  });

  plot_area.appendChild(container);
  render_plot_accessibility_summary(
    entries.map((item) => item.entry),
    entries.map((item) => item.fit).filter(Boolean),
    x_domain,
    [0, d3.max(entries, (item) => d3.max(item.entry.points, (point) => point.y)) || 1],
  );
  render_plot_clipping_warning(entries.map((item) => item.entry));
  document.dispatchEvent(new CustomEvent("pf-plot-rendered"));
}

// The overlay bar shown while a ridge row is blown up for manual review.
// Removes any manual-review bar. Called on every render so the bar only exists
// while a sample is actually blown up for review.
export function remove_ridge_review_bar() {
  plot_area?.parentElement?.querySelector(":scope > .ridge_review_bar")?.remove();
}

export function render_ridge_review_header(name) {
  remove_ridge_review_bar();
  const bar = document.createElement("div");
  bar.className = "ridge_review_bar";
  const label = document.createElement("span");
  label.className = "ridge_review_name";
  label.textContent = strip_fcs_ext(name);
  label.title = name;
  const badge = document.createElement("span");
  badge.className = "ridge_badge ridge_badge_review";
  badge.textContent = "Under manual review";
  const accept = document.createElement("button");
  accept.type = "button";
  accept.className = "ridge_review_accept";
  accept.textContent = "Accept & back to ridge";
  accept.addEventListener("click", exit_ridge_review);
  bar.append(label, badge, accept);
  // Inserted above #plot_area (in normal flow), so the bar sits outside the
  // plot canvas rather than floating over it.
  const inner = plot_area.parentElement;
  inner.insertBefore(bar, plot_area);
}
