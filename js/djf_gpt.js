// Corrected Dean-Jett-Fox-style modeling and optional event preprocessing.
// This file owns the model used by plotting.js; the original histogram renderer
// stays separate so raw plotting remains simple.

(function () {
  const S_NODES = 64;
  const SQRT_2PI = Math.sqrt(2 * Math.PI);
  const EPS = 1e-9;

  function finiteNumber(value) {
    return Number.isFinite(value);
  }

  function positiveNumber(value) {
    return Number.isFinite(value) && value > 0;
  }

  function sortedFinite(values, positiveOnly = false) {
    const out = [];
    for (let i = 0; i < values.length; i += 1) {
      const value = values[i];
      if (Number.isFinite(value) && (!positiveOnly || value > 0)) {
        out.push(value);
      }
    }
    out.sort((a, b) => a - b);
    return out;
  }

  function quantileSorted(sorted, p) {
    if (!sorted.length) return NaN;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
    return sorted[index];
  }

  function medianSorted(sorted) {
    return quantileSorted(sorted, 0.5);
  }

  function robustSigma(values) {
    const sorted = sortedFinite(values);
    if (sorted.length < 8) return NaN;
    const median = medianSorted(sorted);
    const deviations = sorted.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
    return 1.4826 * (medianSorted(deviations) || EPS);
  }

  function buildHistogram(values, bins = 256, range = null) {
    const sorted = sortedFinite(values, true);
    if (!sorted.length) return [];

    let lo = range ? range[0] : quantileSorted(sorted, 0.002);
    let hi = range ? range[1] : quantileSorted(sorted, 0.998);
    if (!(hi > lo)) {
      lo = sorted[0];
      hi = sorted[sorted.length - 1];
    }
    if (!(hi > lo)) hi = lo + 1;

    const width = (hi - lo) / bins;
    const counts = new Float64Array(bins);
    for (let i = 0; i < values.length; i += 1) {
      const value = values[i];
      if (!positiveNumber(value) || value < lo || value > hi) continue;
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

  function detectPeaks(points, threshold = null) {
    if (!points.length) return [];
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const maxY = ys.reduce((max, value) => Math.max(max, value), 0) || 1;
    const cutoff = threshold != null ? threshold : 0.05 * maxY;

    if (typeof window.gsd === "function") {
      try {
        const minMaxRatio = Math.min(0.99, Math.max(1e-4, cutoff / maxY));
        const found = window.gsd({ x: xs, y: ys }, { minMaxRatio, smoothY: true, realTopDetection: true });
        const peaks = (found || [])
          .map((peak) => ({ x: peak.x, y: peak.y != null ? peak.y : peak.height }))
          .filter((peak) => finiteNumber(peak.x) && finiteNumber(peak.y) && peak.y >= cutoff);
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
      let isMax = true;
      for (let j = Math.max(0, i - win); j <= Math.min(points.length - 1, i + win); j += 1) {
        if (ys[j] > ys[i]) {
          isMax = false;
          break;
        }
      }
      if (isMax) {
        peaks.push({ x: xs[i], y: ys[i] });
        i += win;
      }
    }
    return peaks;
  }

  function bestG1G2Pair(peaks) {
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < peaks.length; i += 1) {
      for (let j = 0; j < peaks.length; j += 1) {
        if (i === j || peaks[j].x <= peaks[i].x) continue;
        const ratio = peaks[j].x / peaks[i].x;
        if (ratio < 1.7 || ratio > 2.3) continue;
        const ratioPenalty = Math.abs(Math.log(ratio / 2)) * 0.25 * (peaks[i].y + peaks[j].y);
        const score = peaks[i].y + peaks[j].y - ratioPenalty;
        if (score > bestScore) {
          bestScore = score;
          best = { g1: peaks[i], g2: peaks[j] };
        }
      }
    }
    return best;
  }

  function nearestY(points, x) {
    let best = 0;
    let bestDist = Infinity;
    for (const point of points) {
      const dist = Math.abs(point.x - x);
      if (dist < bestDist) {
        bestDist = dist;
        best = point.y;
      }
    }
    return best;
  }

  function estimateSigmaFromPeak(points, peakX, peakY, fallback) {
    if (!points.length || !(peakY > 0)) return fallback;
    const half = peakY / 2;
    const index = points.reduce((best, point, i) => (
      Math.abs(point.x - peakX) < Math.abs(points[best].x - peakX) ? i : best
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

  function estimateG1FromPoints(points, threshold = null) {
    const peaks = detectPeaks(points, threshold);
    const pair = bestG1G2Pair(peaks);
    if (pair) return pair.g1.x;
    if (peaks.length) {
      return peaks.reduce((best, peak) => (peak.y > best.y ? peak : best), peaks[0]).x;
    }
    return null;
  }

  function debrisBounds(values) {
    const sorted = sortedFinite(values, true);
    if (sorted.length < 32) return null;

    const qLo = quantileSorted(sorted, 0.001);
    const qHi = quantileSorted(sorted, 0.999);
    const points = buildHistogram(sorted, 256, [quantileSorted(sorted, 0.002), quantileSorted(sorted, 0.998)]);
    const peaks = detectPeaks(points);
    const pair = bestG1G2Pair(peaks);
    let g1Peak = pair ? pair.g1 : null;
    let g2Peak = pair ? pair.g2 : null;

    if (!g1Peak && peaks.length) {
      g1Peak = peaks.reduce((best, peak) => (peak.y > best.y ? peak : best), peaks[0]);
    }
    if (!g1Peak || !(g1Peak.x > 0)) {
      return { lo: qLo, hi: qHi, available: false };
    }

    const sigma1 = estimateSigmaFromPeak(points, g1Peak.x, g1Peak.y, Math.max(g1Peak.x * 0.03, (qHi - qLo) * 0.015));
    if (!g2Peak) {
      g2Peak = { x: 2 * g1Peak.x, y: nearestY(points, 2 * g1Peak.x) };
    }
    const sigma2 = estimateSigmaFromPeak(points, g2Peak.x, g2Peak.y, Math.max(2 * sigma1, g1Peak.x * 0.06));

    const lower = Math.max(qLo, g1Peak.x - 4 * sigma1, 0.45 * g1Peak.x);
    const upper = Math.min(qHi, Math.max(g2Peak.x + 4 * sigma2, 2.65 * g1Peak.x));
    if (!(upper > lower)) return { lo: qLo, hi: qHi, available: false };
    return { lo: lower, hi: upper, available: true };
  }

  function combineMask(current, next) {
    if (!current) return next;
    const mask = new Array(current.length);
    for (let i = 0; i < current.length; i += 1) {
      mask[i] = Boolean(current[i] && next[i]);
    }
    return mask;
  }

  function compactByMask(values, mask) {
    if (!mask) return values;
    const out = [];
    for (let i = 0; i < values.length; i += 1) {
      if (mask[i]) out.push(values[i]);
    }
    return out;
  }

  function robustRatioMask(dnaA, other, baseMask, mode) {
    if (!other || other.length !== dnaA.length) {
      return { mask: null, available: false, removed: 0, total: dnaA.length };
    }

    const ratios = [];
    for (let i = 0; i < dnaA.length; i += 1) {
      if (baseMask && !baseMask[i]) continue;
      const a = dnaA[i];
      const b = other[i];
      if (!positiveNumber(a) || !positiveNumber(b)) continue;
      ratios.push(mode === "width" ? Math.log(b) : Math.log(a) - Math.log(b));
    }
    if (ratios.length < 64) {
      return { mask: null, available: false, removed: 0, total: dnaA.length };
    }

    const sorted = sortedFinite(ratios);
    const median = medianSorted(sorted);
    const sigma = robustSigma(ratios);
    if (!(sigma > 0)) {
      return { mask: null, available: false, removed: 0, total: dnaA.length };
    }

    const lower = median - 4 * sigma;
    const upper = median + 4 * sigma;
    const mask = new Array(dnaA.length);
    let kept = 0;
    let eligible = 0;
    for (let i = 0; i < dnaA.length; i += 1) {
      if (baseMask && !baseMask[i]) {
        mask[i] = false;
        continue;
      }
      const a = dnaA[i];
      const b = other[i];
      if (!positiveNumber(a) || !positiveNumber(b)) {
        mask[i] = false;
        continue;
      }
      eligible += 1;
      const ratio = mode === "width" ? Math.log(b) : Math.log(a) - Math.log(b);
      mask[i] = ratio >= lower && ratio <= upper;
      if (mask[i]) kept += 1;
    }

    const keepFraction = eligible ? kept / eligible : 0;
    if (keepFraction < 0.35) {
      return { mask: null, available: false, removed: 0, total: dnaA.length };
    }
    return { mask, available: true, removed: eligible - kept, total: eligible };
  }

  function applyAggregateMask(rowData, currentMask) {
    const dnaA = rowData.dnaA || [];
    const heightGate = robustRatioMask(dnaA, rowData.dnaH, currentMask, "height");
    const widthGate = robustRatioMask(dnaA, rowData.dnaW, currentMask, "width");

    let mask = null;
    let available = false;
    let removed = 0;
    if (heightGate.available) {
      mask = combineMask(mask, heightGate.mask);
      available = true;
      removed += heightGate.removed;
    }
    if (widthGate.available) {
      mask = combineMask(mask, widthGate.mask);
      available = true;
      removed += widthGate.removed;
    }

    if (!available) {
      return { mask: null, available: false, removed: 0 };
    }
    return { mask, available: true, removed };
  }

  function prepareRow(row, corrections) {
    const dnaA = row.data && row.data.dnaA ? row.data.dnaA : [];
    let mask = null;
    const stats = {
      raw: dnaA.length,
      plotted: dnaA.length,
      debrisRemoved: 0,
      doubletsRemoved: 0,
      debrisAvailable: false,
      doubletAvailable: false,
    };

    if (corrections.removeDebris) {
      const bounds = debrisBounds(dnaA);
      const debrisMask = new Array(dnaA.length);
      let kept = 0;
      for (let i = 0; i < dnaA.length; i += 1) {
        const value = dnaA[i];
        debrisMask[i] = positiveNumber(value)
          && (!bounds || (value >= bounds.lo && value <= bounds.hi));
        if (debrisMask[i]) kept += 1;
      }
      mask = combineMask(mask, debrisMask);
      stats.debrisAvailable = Boolean(bounds && bounds.available);
      stats.debrisRemoved = dnaA.length - kept;
    }

    if (corrections.removeDoublets) {
      const aggregateGate = applyAggregateMask(row.data || {}, mask);
      if (aggregateGate.available) {
        mask = combineMask(mask, aggregateGate.mask);
        stats.doubletAvailable = true;
        stats.doubletsRemoved = aggregateGate.removed;
      }
    }

    const values = compactByMask(dnaA, mask);
    stats.plotted = values.length;
    return { values, stats };
  }

  function gaussian(distance, sigma) {
    if (!(sigma > EPS)) return 0;
    return Math.exp(-(distance * distance) / (2 * sigma * sigma)) / (sigma * SQRT_2PI);
  }

  function sPhaseHeight(pos, b0, b1, b2) {
    const inv = 1 - pos;
    return b0 * inv * inv + 2 * b1 * pos * inv + b2 * pos * pos;
  }

  function components(value, p) {
    const [m1, sigma1, aG1, m2, sigma2, aG2, b0, b1, b2] = p;
    const g1 = aG1 * gaussian(value - m1, sigma1);
    const g2 = aG2 * gaussian(value - m2, sigma2);
    let s = 0;
    const span = m2 - m1;
    if (span > EPS) {
      const du = span / S_NODES;
      for (let k = 0; k < S_NODES; k += 1) {
        const pos = (k + 0.5) / S_NODES;
        const u = m1 + pos * span;
        const sigmaU = sigma1 + (sigma2 - sigma1) * pos;
        s += sPhaseHeight(pos, b0, b1, b2) * gaussian(value - u, sigmaU) * du;
      }
    }
    return { g1, s, g2 };
  }

  function model(value, p) {
    const c = components(value, p);
    return c.g1 + c.s + c.g2;
  }

  function seedFit(points, range, threshold, g1Hint) {
    const peaks = detectPeaks(points, threshold);
    const pair = bestG1G2Pair(peaks);
    const globalMax = points.reduce((max, point) => Math.max(max, point.y), 1);
    const span = range[1] - range[0];

    let m1;
    let m2;
    let g1Y;
    let g2Y;

    if (pair) {
      m1 = pair.g1.x;
      m2 = pair.g2.x;
      g1Y = pair.g1.y;
      g2Y = pair.g2.y;
    } else if (g1Hint != null) {
      m1 = g1Hint;
      m2 = 2 * g1Hint;
      g1Y = nearestY(points, m1);
      g2Y = nearestY(points, m2);
    } else if (peaks.length) {
      const tallest = peaks.reduce((best, peak) => (peak.y > best.y ? peak : best), peaks[0]);
      const halfMate = peaks.find((peak) => Math.abs(peak.x - tallest.x / 2) < 0.2 * tallest.x);
      if (halfMate) {
        m1 = halfMate.x;
        m2 = tallest.x;
        g1Y = halfMate.y;
        g2Y = tallest.y;
      } else {
        m1 = tallest.x;
        m2 = 2 * tallest.x;
        g1Y = tallest.y;
        g2Y = nearestY(points, m2);
      }
    } else {
      m1 = range[0] + 0.3 * span;
      m2 = 2 * m1;
      g1Y = globalMax;
      g2Y = 0.3 * globalMax;
    }

    const sigma1Fallback = Math.max(span * 0.015, m1 * 0.03);
    const sigma1 = estimateSigmaFromPeak(points, m1, Math.max(g1Y, EPS), sigma1Fallback);
    const sigma2Fallback = Math.max(span * 0.025, m2 * 0.03, 1.5 * sigma1);
    const sigma2 = estimateSigmaFromPeak(points, m2, Math.max(g2Y, EPS), sigma2Fallback);
    const aG1 = Math.max(g1Y, EPS) * sigma1 * SQRT_2PI;
    const aG2 = Math.max(g2Y, EPS) * sigma2 * SQRT_2PI;
    const sSeed = Math.max(globalMax * 0.06, EPS);

    return [m1, sigma1, aG1, m2, sigma2, aG2, sSeed, sSeed, sSeed];
  }

  function estimateRunG1(series, threshold = null) {
    const positions = [];
    for (const item of series) {
      const peaks = detectPeaks(item.points, threshold);
      const pair = bestG1G2Pair(peaks);
      if (pair) positions.push(pair.g1.x);
    }
    if (!positions.length) return null;
    positions.sort((a, b) => a - b);
    return positions[Math.floor((positions.length - 1) / 2)];
  }

  function fit(points, range, threshold, g1Hint) {
    const LM = window.levenbergMarquardt;
    if (!LM || !points.length) return null;

    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    if (ys.reduce((sum, value) => sum + value, 0) <= 0) return null;
    const initial = seedFit(points, range, threshold, g1Hint);
    const [m1Initial] = initial;
    const span = range[1] - range[0];
    const maxY = Math.max(...ys, 1);
    const bigA = maxY * span * 10 + 10;
    const bigS = maxY * 10 + 10;

    const minSigma = Math.max(span * 0.002, EPS);
    const maxSigma = Math.max(span * 0.22, minSigma * 2);
    const m1Lo = g1Hint != null ? g1Hint * 0.9 : Math.max(range[0], m1Initial * 0.75);
    const m1Hi = Math.max(
      m1Lo + minSigma,
      g1Hint != null ? g1Hint * 1.1 : Math.min(range[1], m1Initial * 1.25),
    );
    const m2Lo = Math.max(range[0], m1Initial * 1.65, m1Hi + minSigma);
    const m2Hi = Math.max(m2Lo + minSigma, Math.min(range[1] + 0.1 * span, m1Initial * 2.35));

    try {
      const result = LM(
        { x: xs, y: ys },
        (p) => (x) => model(x, p),
        {
          initialValues: initial,
          minValues: [m1Lo, minSigma, 0, m2Lo, minSigma, 0, 0, 0, 0],
          maxValues: [m1Hi, maxSigma, bigA, m2Hi, maxSigma, bigA, bigS, bigS, bigS],
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

  function phaseStats(points, p) {
    const stats = {
      g1: { phase: "G1", weight: 0, sum: 0, sumSq: 0 },
      s: { phase: "S", weight: 0, sum: 0, sumSq: 0 },
      g2: { phase: "G2", weight: 0, sum: 0, sumSq: 0 },
    };

    for (const point of points) {
      const c = components(point.x, p);
      for (const key of ["g1", "s", "g2"]) {
        const weight = c[key];
        if (!(weight > 0)) continue;
        stats[key].weight += weight;
        stats[key].sum += weight * point.x;
        stats[key].sumSq += weight * point.x * point.x;
      }
    }

    const total = stats.g1.weight + stats.s.weight + stats.g2.weight || 1;
    for (const key of ["g1", "s", "g2"]) {
      const item = stats[key];
      item.percent = (item.weight / total) * 100;
      item.mean = item.weight > 0 ? item.sum / item.weight : NaN;
      const variance = item.weight > 0 ? item.sumSq / item.weight - item.mean * item.mean : NaN;
      item.stdev = Number.isFinite(variance) ? Math.sqrt(Math.max(0, variance)) : NaN;
    }
    return stats;
  }

  function fractions(points, p) {
    const stats = phaseStats(points, p);
    return {
      g1: stats.g1.percent,
      s: stats.s.percent,
      g2: stats.g2.percent,
    };
  }

  function correctionSummary(preparedRows, corrections) {
    if (!corrections.removeDebris && !corrections.removeDoublets) return "";
    const totals = preparedRows.reduce((acc, row) => {
      acc.raw += row.prepared.stats.raw;
      acc.plotted += row.prepared.stats.plotted;
      acc.debrisRemoved += row.prepared.stats.debrisRemoved;
      acc.doubletsRemoved += row.prepared.stats.doubletsRemoved;
      acc.debrisAvailable = acc.debrisAvailable || row.prepared.stats.debrisAvailable;
      acc.doubletAvailable = acc.doubletAvailable || row.prepared.stats.doubletAvailable;
      return acc;
    }, {
      raw: 0,
      plotted: 0,
      debrisRemoved: 0,
      doubletsRemoved: 0,
      debrisAvailable: false,
      doubletAvailable: false,
    });

    const parts = [];
    if (corrections.removeDebris) {
      parts.push(`debris/background removed ${totals.debrisRemoved.toLocaleString()}`);
    }
    if (corrections.removeDoublets) {
      parts.push(totals.doubletAvailable
        ? `aggregates/doublets removed ${totals.doubletsRemoved.toLocaleString()}`
        : "aggregate/doublet channels unavailable");
    }
    parts.push(`${totals.plotted.toLocaleString()} of ${totals.raw.toLocaleString()} events plotted`);
    return parts.join("\n");
  }

  function normalizeName(value) {
    return String(value || "")
      .toUpperCase()
      .replace(/AREA|HEIGHT|WIDTH/g, (token) => ({ AREA: " A ", HEIGHT: " H ", WIDTH: " W " }[token]))
      .replace(/[^A-Z0-9]+/g, " ")
      .trim();
  }

  function measurementKind(value) {
    const normalized = normalizeName(value);
    const last = normalized.split(" ").pop();
    if (last === "A") return "area";
    if (last === "H") return "height";
    if (last === "W") return "width";
    return null;
  }

  function measurementBase(value) {
    const normalized = normalizeName(value);
    const tokens = normalized.split(" ").filter(Boolean);
    const last = tokens[tokens.length - 1];
    if (last === "A" || last === "H" || last === "W") tokens.pop();
    return tokens.join(" ");
  }

  function paramFields(param) {
    return [param.label, param.name, param.desc].filter(Boolean);
  }

  function findLinkedParam(params, selectedParam, targetKind) {
    const selectedFields = paramFields(selectedParam);
    const selectedBases = selectedFields.map(measurementBase).filter(Boolean);
    const uniqueBases = [...new Set(selectedBases)];

    for (const candidate of params) {
      if (candidate.index === selectedParam.index) continue;
      const fields = paramFields(candidate);
      const hasKind = fields.some((field) => measurementKind(field) === targetKind);
      if (!hasKind) continue;
      const bases = fields.map(measurementBase).filter(Boolean);
      if (bases.some((base) => uniqueBases.includes(base))) {
        return candidate;
      }
    }
    return null;
  }

  function findAuxiliaryIndexes(summary, selectedLabel) {
    const params = summary.columns.map((label, index) => ({
      index: index + 1,
      label,
      name: summary.metadata[`P${index + 1}N`] || "",
      desc: summary.metadata[`P${index + 1}S`] || "",
    }));
    const selectedParam = params.find((param) =>
      param.label === selectedLabel || param.name === selectedLabel || param.desc === selectedLabel
    );
    if (!selectedParam) return {};

    const height = findLinkedParam(params, selectedParam, "height");
    const width = findLinkedParam(params, selectedParam, "width");
    return {
      dnaH: height ? height.index : null,
      dnaW: width ? width.index : null,
      dnaHeightLabel: height ? height.label : "",
      dnaWidthLabel: width ? width.label : "",
    };
  }

  window.PhaseFinderDJF = {
    prepareRow,
    estimateRunG1,
    fit,
    components,
    fractions,
    phaseStats,
    correctionSummary,
    findAuxiliaryIndexes,
  };
}());
