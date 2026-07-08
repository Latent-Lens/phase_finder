// Dean-Jett-Fox-style cell-cycle modeling and optional event preprocessing.
// This file provides window.PhaseFinderDJF, which plot rendering calls to clean
// events, estimate peaks, fit model components, and compute phase statistics.
// It contains the numeric helpers, robust peak selection, debris correction, and
// aggregate/doublet masking used before fitting. It wraps the external
// Levenberg-Marquardt and peak-detection libraries when those libraries are
// available. It intentionally does not draw anything; the plotting modules turn
// these model outputs into curves, filled components, legends, and readouts.

(function () {
  const S_NODES = 64;
  const SQRT_2PI = Math.sqrt(2 * Math.PI);
  const EPS = 1e-9;

  function finite_number(value) {
    return Number.isFinite(value);
  }

  function positive_number(value) {
    return Number.isFinite(value) && value > 0;
  }

  function sorted_finite(values, positive_only = false) {
    const out = [];
    for (let i = 0; i < values.length; i += 1) {
      const value = values[i];
      if (Number.isFinite(value) && (!positive_only || value > 0)) {
        out.push(value);
      }
    }
    out.sort((a, b) => a - b);
    return out;
  }

  function quantile_sorted(sorted, p) {
    if (!sorted.length) return NaN;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
    return sorted[index];
  }

  function median_sorted(sorted) {
    return quantile_sorted(sorted, 0.5);
  }

  function robust_sigma(values) {
    const sorted = sorted_finite(values);
    if (sorted.length < 8) return NaN;
    const median = median_sorted(sorted);
    const deviations = sorted.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
    return 1.4826 * (median_sorted(deviations) || EPS);
  }

  function build_histogram(values, bins = 256, range = null) {
    const sorted = sorted_finite(values, true);
    if (!sorted.length) return [];

    let lo = range ? range[0] : quantile_sorted(sorted, 0.002);
    let hi = range ? range[1] : quantile_sorted(sorted, 0.998);
    if (!(hi > lo)) {
      lo = sorted[0];
      hi = sorted[sorted.length - 1];
    }
    if (!(hi > lo)) hi = lo + 1;

    const width = (hi - lo) / bins;
    const counts = new Float64Array(bins);
    for (let i = 0; i < values.length; i += 1) {
      const value = values[i];
      if (!positive_number(value) || value < lo || value > hi) continue;
      let bin = Math.floor((value - lo) / width);
      if (bin >= bins) bin = bins - 1;
      else if (bin < 0) bin = 0;
      counts[bin] += 1;
    }

    const points = new Array(bins);
    for (let i = 0; i < bins; i += 1) {
      points[i] = { x: lo + (i + 0.5) * width, y: counts[i] };
    }
    return points;
  }

  function detect_peaks(points, threshold = null) {
    if (!points.length) return [];
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const max_y = ys.reduce((max, value) => Math.max(max, value), 0) || 1;
    const cutoff = threshold != null ? threshold : 0.05 * max_y;

    if (typeof window.gsd === "function") {
      try {
        const min_max_ratio = Math.min(0.99, Math.max(1e-4, cutoff / max_y));
        const found = window.gsd({ x: xs, y: ys }, { minMaxRatio: min_max_ratio, smoothY: true, realTopDetection: true });
        const peaks = (found || [])
          .map((peak) => ({ x: peak.x, y: peak.y != null ? peak.y : peak.height }))
          .filter((peak) => finite_number(peak.x) && finite_number(peak.y) && peak.y >= cutoff);
        if (peaks.length) {
          peaks.sort((a, b) => a.x - b.x);
          return peaks;
        }
      } catch (error) {
        // Fall through to the deterministic local-maxima scan.
      }
    }

    const win = Math.max(2, Math.floor(points.length / 48));
    const peaks = [];
    for (let i = 0; i < points.length; i += 1) {
      if (ys[i] < cutoff) continue;
      let is_max = true;
      for (let j = Math.max(0, i - win); j <= Math.min(points.length - 1, i + win); j += 1) {
        if (ys[j] > ys[i]) {
          is_max = false;
          break;
        }
      }
      if (is_max) {
        peaks.push({ x: xs[i], y: ys[i] });
        i += win;
      }
    }
    return peaks;
  }

  function best_g1g2_pair(peaks) {
    let best = null;
    let best_score = -Infinity;
    for (let i = 0; i < peaks.length; i += 1) {
      for (let j = 0; j < peaks.length; j += 1) {
        if (i === j || peaks[j].x <= peaks[i].x) continue;
        const ratio = peaks[j].x / peaks[i].x;
        if (ratio < 1.7 || ratio > 2.3) continue;
        const ratio_penalty = Math.abs(Math.log(ratio / 2)) * 0.25 * (peaks[i].y + peaks[j].y);
        const score = peaks[i].y + peaks[j].y - ratio_penalty;
        if (score > best_score) {
          best_score = score;
          best = { g1: peaks[i], g2: peaks[j] };
        }
      }
    }
    return best;
  }

  function nearest_y(points, x) {
    let best = 0;
    let best_dist = Infinity;
    for (const point of points) {
      const dist = Math.abs(point.x - x);
      if (dist < best_dist) {
        best_dist = dist;
        best = point.y;
      }
    }
    return best;
  }

  function estimate_sigma_from_peak(points, peak_x, peak_y, fallback) {
    if (!points.length || !(peak_y > 0)) return fallback;
    const half = peak_y / 2;
    const index = points.reduce((best, point, i) => (
      Math.abs(point.x - peak_x) < Math.abs(points[best].x - peak_x) ? i : best
    ), 0);

    let left = null;
    for (let i = index; i >= 0; i -= 1) {
      if (points[i].y <= half) {
        left = points[i].x;
        break;
      }
    }
    let right = null;
    for (let i = index; i < points.length; i += 1) {
      if (points[i].y <= half) {
        right = points[i].x;
        break;
      }
    }

    if (left != null && right != null && right > left) {
      return Math.max((right - left) / 2.355, fallback * 0.5);
    }
    return fallback;
  }

  function estimate_g1_from_points(points, threshold = null) {
    const peaks = detect_peaks(points, threshold);
    const pair = best_g1g2_pair(peaks);
    if (pair) return pair.g1.x;
    if (peaks.length) {
      return peaks.reduce((best, peak) => (peak.y > best.y ? peak : best), peaks[0]).x;
    }
    return null;
  }

  function debris_bounds(values) {
    const sorted = sorted_finite(values, true);
    if (sorted.length < 32) return null;

    const q_lo = quantile_sorted(sorted, 0.001);
    const q_hi = quantile_sorted(sorted, 0.999);
    const points = build_histogram(sorted, 256, [quantile_sorted(sorted, 0.002), quantile_sorted(sorted, 0.998)]);
    const peaks = detect_peaks(points);
    const pair = best_g1g2_pair(peaks);
    let g1_peak = pair ? pair.g1 : null;
    let g2_peak = pair ? pair.g2 : null;

    if (!g1_peak && peaks.length) {
      g1_peak = peaks.reduce((best, peak) => (peak.y > best.y ? peak : best), peaks[0]);
    }
    if (!g1_peak || !(g1_peak.x > 0)) {
      return { lo: q_lo, hi: q_hi, available: false };
    }

    const sigma1 = estimate_sigma_from_peak(points, g1_peak.x, g1_peak.y, Math.max(g1_peak.x * 0.03, (q_hi - q_lo) * 0.015));
    if (!g2_peak) {
      g2_peak = { x: 2 * g1_peak.x, y: nearest_y(points, 2 * g1_peak.x) };
    }
    const sigma2 = estimate_sigma_from_peak(points, g2_peak.x, g2_peak.y, Math.max(2 * sigma1, g1_peak.x * 0.06));

    const lower = Math.max(q_lo, g1_peak.x - 4 * sigma1, 0.45 * g1_peak.x);
    const upper = Math.min(q_hi, Math.max(g2_peak.x + 4 * sigma2, 2.65 * g1_peak.x));
    if (!(upper > lower)) return { lo: q_lo, hi: q_hi, available: false };
    return { lo: lower, hi: upper, available: true };
  }

  function combine_mask(current, next) {
    if (!current) return next;
    const mask = new Array(current.length);
    for (let i = 0; i < current.length; i += 1) {
      mask[i] = Boolean(current[i] && next[i]);
    }
    return mask;
  }

  function compact_by_mask(values, mask) {
    if (!mask) return values;
    const out = [];
    for (let i = 0; i < values.length; i += 1) {
      if (mask[i]) out.push(values[i]);
    }
    return out;
  }

  function robust_ratio_mask(dna_a, other, base_mask, mode) {
    if (!other || other.length !== dna_a.length) {
      return { mask: null, available: false, removed: 0, total: dna_a.length };
    }

    const ratios = [];
    for (let i = 0; i < dna_a.length; i += 1) {
      if (base_mask && !base_mask[i]) continue;
      const a = dna_a[i];
      const b = other[i];
      if (!positive_number(a) || !positive_number(b)) continue;
      ratios.push(mode === "width" ? Math.log(b) : Math.log(a) - Math.log(b));
    }
    if (ratios.length < 64) {
      return { mask: null, available: false, removed: 0, total: dna_a.length };
    }

    const sorted = sorted_finite(ratios);
    const median = median_sorted(sorted);
    const sigma = robust_sigma(ratios);
    if (!(sigma > 0)) {
      return { mask: null, available: false, removed: 0, total: dna_a.length };
    }

    const lower = median - 4 * sigma;
    const upper = median + 4 * sigma;
    const mask = new Array(dna_a.length);
    let kept = 0;
    let eligible = 0;
    for (let i = 0; i < dna_a.length; i += 1) {
      if (base_mask && !base_mask[i]) {
        mask[i] = false;
        continue;
      }
      const a = dna_a[i];
      const b = other[i];
      if (!positive_number(a) || !positive_number(b)) {
        mask[i] = false;
        continue;
      }
      eligible += 1;
      const ratio = mode === "width" ? Math.log(b) : Math.log(a) - Math.log(b);
      mask[i] = ratio >= lower && ratio <= upper;
      if (mask[i]) kept += 1;
    }

    const keep_fraction = eligible ? kept / eligible : 0;
    if (keep_fraction < 0.35) {
      return { mask: null, available: false, removed: 0, total: dna_a.length };
    }
    return { mask, available: true, removed: eligible - kept, total: eligible };
  }

  function apply_aggregate_mask(row_data, current_mask) {
    const dna_a = row_data.dna_a || [];
    const height_gate = robust_ratio_mask(dna_a, row_data.dna_h, current_mask, "height");
    const width_gate = robust_ratio_mask(dna_a, row_data.dna_w, current_mask, "width");

    let mask = null;
    let available = false;
    let removed = 0;
    if (height_gate.available) {
      mask = combine_mask(mask, height_gate.mask);
      available = true;
      removed += height_gate.removed;
    }
    if (width_gate.available) {
      mask = combine_mask(mask, width_gate.mask);
      available = true;
      removed += width_gate.removed;
    }

    if (!available) {
      return { mask: null, available: false, removed: 0 };
    }
    return { mask, available: true, removed };
  }

  function prepare_row(row, corrections) {
    const dna_a = row.data && row.data.dna_a ? row.data.dna_a : [];
    let mask = null;
    const stats = {
      raw: dna_a.length,
      plotted: dna_a.length,
      debris_removed: 0,
      doublets_removed: 0,
      debris_available: false,
      doublet_available: false,
    };

    if (corrections.remove_debris) {
      const bounds = debris_bounds(dna_a);
      const debris_mask = new Array(dna_a.length);
      let kept = 0;
      for (let i = 0; i < dna_a.length; i += 1) {
        const value = dna_a[i];
        debris_mask[i] = positive_number(value)
          && (!bounds || (value >= bounds.lo && value <= bounds.hi));
        if (debris_mask[i]) kept += 1;
      }
      mask = combine_mask(mask, debris_mask);
      stats.debris_available = Boolean(bounds && bounds.available);
      stats.debris_removed = dna_a.length - kept;
    }

    if (corrections.remove_doublets) {
      const aggregate_gate = apply_aggregate_mask(row.data || {}, mask);
      if (aggregate_gate.available) {
        mask = combine_mask(mask, aggregate_gate.mask);
        stats.doublet_available = true;
        stats.doublets_removed = aggregate_gate.removed;
      }
    }

    const values = compact_by_mask(dna_a, mask);
    stats.plotted = values.length;
    return { values, stats };
  }

  function gaussian(distance, sigma) {
    if (!(sigma > EPS)) return 0;
    return Math.exp(-(distance * distance) / (2 * sigma * sigma)) / (sigma * SQRT_2PI);
  }

  function s_phase_height(pos, b0, b1, b2) {
    const inv = 1 - pos;
    return b0 * inv * inv + 2 * b1 * pos * inv + b2 * pos * pos;
  }

  function components(value, p) {
    const [m1, sigma1, a_g1, m2, sigma2, a_g2, b0, b1, b2] = p;
    const g1 = a_g1 * gaussian(value - m1, sigma1);
    const g2 = a_g2 * gaussian(value - m2, sigma2);
    let s = 0;
    const span = m2 - m1;
    if (span > EPS) {
      const du = span / S_NODES;
      for (let k = 0; k < S_NODES; k += 1) {
        const pos = (k + 0.5) / S_NODES;
        const u = m1 + pos * span;
        const sigma_u = sigma1 + (sigma2 - sigma1) * pos;
        s += s_phase_height(pos, b0, b1, b2) * gaussian(value - u, sigma_u) * du;
      }
    }
    return { g1, s, g2 };
  }

  function model(value, p) {
    const c = components(value, p);
    return c.g1 + c.s + c.g2;
  }

  function seed_fit(points, range, threshold, g1_hint) {
    const peaks = detect_peaks(points, threshold);
    const pair = best_g1g2_pair(peaks);
    const global_max = points.reduce((max, point) => Math.max(max, point.y), 1);
    const span = range[1] - range[0];

    let m1;
    let m2;
    let g1_y;
    let g2_y;

    if (pair) {
      m1 = pair.g1.x;
      m2 = pair.g2.x;
      g1_y = pair.g1.y;
      g2_y = pair.g2.y;
    } else if (g1_hint != null) {
      m1 = g1_hint;
      m2 = 2 * g1_hint;
      g1_y = nearest_y(points, m1);
      g2_y = nearest_y(points, m2);
    } else if (peaks.length) {
      const tallest = peaks.reduce((best, peak) => (peak.y > best.y ? peak : best), peaks[0]);
      const half_mate = peaks.find((peak) => Math.abs(peak.x - tallest.x / 2) < 0.2 * tallest.x);
      if (half_mate) {
        m1 = half_mate.x;
        m2 = tallest.x;
        g1_y = half_mate.y;
        g2_y = tallest.y;
      } else {
        m1 = tallest.x;
        m2 = 2 * tallest.x;
        g1_y = tallest.y;
        g2_y = nearest_y(points, m2);
      }
    } else {
      m1 = range[0] + 0.3 * span;
      m2 = 2 * m1;
      g1_y = global_max;
      g2_y = 0.3 * global_max;
    }

    const sigma1_fallback = Math.max(span * 0.015, m1 * 0.03);
    const sigma1 = estimate_sigma_from_peak(points, m1, Math.max(g1_y, EPS), sigma1_fallback);
    const sigma2_fallback = Math.max(span * 0.025, m2 * 0.03, 1.5 * sigma1);
    const sigma2 = estimate_sigma_from_peak(points, m2, Math.max(g2_y, EPS), sigma2_fallback);
    const a_g1 = Math.max(g1_y, EPS) * sigma1 * SQRT_2PI;
    const a_g2 = Math.max(g2_y, EPS) * sigma2 * SQRT_2PI;
    const s_seed = Math.max(global_max * 0.06, EPS);

    return [m1, sigma1, a_g1, m2, sigma2, a_g2, s_seed, s_seed, s_seed];
  }

  function estimate_run_g1(series, threshold = null) {
    const positions = [];
    for (const item of series) {
      const peaks = detect_peaks(item.points, threshold);
      const pair = best_g1g2_pair(peaks);
      if (pair) positions.push(pair.g1.x);
    }
    if (!positions.length) return null;
    positions.sort((a, b) => a - b);
    return positions[Math.floor((positions.length - 1) / 2)];
  }

  function fit(points, range, threshold, g1_hint) {
    const LM = window.levenbergMarquardt;
    if (!LM || !points.length) return null;

    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    if (ys.reduce((sum, value) => sum + value, 0) <= 0) return null;
    const initial = seed_fit(points, range, threshold, g1_hint);
    const [m1_initial] = initial;
    const span = range[1] - range[0];
    const max_y = Math.max(...ys, 1);
    const big_a = max_y * span * 10 + 10;
    const big_s = max_y * 10 + 10;

    const min_sigma = Math.max(span * 0.002, EPS);
    const max_sigma = Math.max(span * 0.22, min_sigma * 2);
    const m1_lo = g1_hint != null ? g1_hint * 0.9 : Math.max(range[0], m1_initial * 0.75);
    const m1_hi = Math.max(
      m1_lo + min_sigma,
      g1_hint != null ? g1_hint * 1.1 : Math.min(range[1], m1_initial * 1.25),
    );
    const m2_lo = Math.max(range[0], m1_initial * 1.65, m1_hi + min_sigma);
    const m2_hi = Math.max(m2_lo + min_sigma, Math.min(range[1] + 0.1 * span, m1_initial * 2.35));

    try {
      const result = LM(
        { x: xs, y: ys },
        (p) => (x) => model(x, p),
        {
          initialValues: initial,
          minValues: [m1_lo, min_sigma, 0, m2_lo, min_sigma, 0, 0, 0, 0],
          maxValues: [m1_hi, max_sigma, big_a, m2_hi, max_sigma, big_a, big_s, big_s, big_s],
          damping: 1e-2,
          gradientDifference: 1e-4,
          maxIterations: 160,
          errorTolerance: 1e-9,
        },
      );
      const params = result.parameterValues;
      if (!params || params[3] <= params[0] || params[1] <= 0 || params[4] <= 0) {
        return null;
      }
      return params;
    } catch (error) {
      return null;
    }
  }

  function phase_stats(points, p) {
    const stats = {
      g1: { phase: "G1", weight: 0, sum: 0, sum_sq: 0 },
      s: { phase: "S", weight: 0, sum: 0, sum_sq: 0 },
      g2: { phase: "G2", weight: 0, sum: 0, sum_sq: 0 },
    };

    for (const point of points) {
      const c = components(point.x, p);
      for (const key of ["g1", "s", "g2"]) {
        const weight = c[key];
        if (!(weight > 0)) continue;
        stats[key].weight += weight;
        stats[key].sum += weight * point.x;
        stats[key].sum_sq += weight * point.x * point.x;
      }
    }

    const total = stats.g1.weight + stats.s.weight + stats.g2.weight || 1;
    for (const key of ["g1", "s", "g2"]) {
      const item = stats[key];
      item.percent = (item.weight / total) * 100;
      item.mean = item.weight > 0 ? item.sum / item.weight : NaN;
      const variance = item.weight > 0 ? item.sum_sq / item.weight - item.mean * item.mean : NaN;
      item.stdev = Number.isFinite(variance) ? Math.sqrt(Math.max(0, variance)) : NaN;
    }
    return stats;
  }

  function fractions(points, p) {
    const stats = phase_stats(points, p);
    return {
      g1: stats.g1.percent,
      s: stats.s.percent,
      g2: stats.g2.percent,
    };
  }

  function correction_summary(prepared_rows, corrections) {
    if (!corrections.remove_debris && !corrections.remove_doublets) return "";
    const totals = prepared_rows.reduce((acc, row) => {
      acc.raw += row.prepared.stats.raw;
      acc.plotted += row.prepared.stats.plotted;
      acc.debris_removed += row.prepared.stats.debris_removed;
      acc.doublets_removed += row.prepared.stats.doublets_removed;
      acc.debris_available = acc.debris_available || row.prepared.stats.debris_available;
      acc.doublet_available = acc.doublet_available || row.prepared.stats.doublet_available;
      return acc;
    }, {
      raw: 0,
      plotted: 0,
      debris_removed: 0,
      doublets_removed: 0,
      debris_available: false,
      doublet_available: false,
    });

    const parts = [];
    if (corrections.remove_debris) {
      parts.push(`debris/background removed ${totals.debris_removed.toLocaleString()}`);
    }
    if (corrections.remove_doublets) {
      parts.push(totals.doublet_available
        ? `aggregates/doublets removed ${totals.doublets_removed.toLocaleString()}`
        : "aggregate/doublet channels unavailable");
    }
    parts.push(`${totals.plotted.toLocaleString()} of ${totals.raw.toLocaleString()} events plotted`);
    return parts.join("\n");
  }

  function normalize_name(value) {
    return String(value || "")
      .toUpperCase()
      .replace(/AREA|HEIGHT|WIDTH/g, (token) => ({ AREA: " A ", HEIGHT: " H ", WIDTH: " W " }[token]))
      .replace(/[^A-Z0-9]+/g, " ")
      .trim();
  }

  function measurement_kind(value) {
    const normalized = normalize_name(value);
    const last = normalized.split(" ").pop();
    if (last === "A") return "area";
    if (last === "H") return "height";
    if (last === "W") return "width";
    return null;
  }

  function measurement_base(value) {
    const normalized = normalize_name(value);
    const tokens = normalized.split(" ").filter(Boolean);
    const last = tokens[tokens.length - 1];
    if (last === "A" || last === "H" || last === "W") tokens.pop();
    return tokens.join(" ");
  }

  function param_fields(param) {
    return [param.label, param.name, param.desc].filter(Boolean);
  }

  function find_linked_param(params, selected_param, target_kind) {
    const selected_fields = param_fields(selected_param);
    const selected_bases = selected_fields.map(measurement_base).filter(Boolean);
    const unique_bases = [...new Set(selected_bases)];

    for (const candidate of params) {
      if (candidate.index === selected_param.index) continue;
      const fields = param_fields(candidate);
      const has_kind = fields.some((field) => measurement_kind(field) === target_kind);
      if (!has_kind) continue;
      const bases = fields.map(measurement_base).filter(Boolean);
      if (bases.some((base) => unique_bases.includes(base))) {
        return candidate;
      }
    }
    return null;
  }

  function find_auxiliary_indexes(summary, selected_label) {
    const params = summary.columns.map((label, index) => ({
      index: index + 1,
      label,
      name: summary.metadata[`P${index + 1}N`] || "",
      desc: summary.metadata[`P${index + 1}S`] || "",
    }));
    const selected_param = params.find((param) =>
      param.label === selected_label || param.name === selected_label || param.desc === selected_label
    );
    if (!selected_param) return {};

    const height = find_linked_param(params, selected_param, "height");
    const width = find_linked_param(params, selected_param, "width");
    return {
      dna_h: height ? height.index : null,
      dna_w: width ? width.index : null,
      dna_height_label: height ? height.label : "",
      dna_width_label: width ? width.label : "",
    };
  }

  window.PhaseFinderDJF = {
    prepare_row,
    estimate_run_g1,
    fit,
    components,
    fractions,
    phase_stats,
    correction_summary,
    find_auxiliary_indexes,
  };
}());
