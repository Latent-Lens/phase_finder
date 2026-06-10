/* Interactive QC / gating view: DNA-area before/after histogram + DNA-A vs
 * DNA-H singlet density plot, driven by four synced slider/number gates. */
(function () {
  const HIST_BINS = 70;
  const DENSITY_BINS = 100;
  const DENSITY_SAMPLE_CAP = 150000; // downsample only the 2D density trace

  const qcView = document.querySelector("#qcView");
  const appMain = document.querySelector("main.app");
  const scopeSelect = document.querySelector("#qcScopeSelect");
  const histPlot = document.querySelector("#dnaHistPlot");
  const singletPlot = document.querySelector("#singletPlot");
  const resetButton = document.querySelector("#qcResetButton");
  const backButton = document.querySelector("#qcBackButton");
  const runDjfButton = document.querySelector("#qcRunDjfButton");
  const histTitle = document.querySelector("#dnaHistTitle");
  const singletTitle = document.querySelector("#singletTitle");

  const stat = {
    total: document.querySelector("#statTotal"),
    retained: document.querySelector("#statRetained"),
    retainedPct: document.querySelector("#statRetainedPct"),
    saturated: document.querySelector("#statSaturated"),
    low: document.querySelector("#statLow"),
  };

  const controls = {
    dnaMin: pair("dnaMin"),
    dnaMax: pair("dnaMax"),
    ratioLow: pair("ratioLow"),
    ratioHigh: pair("ratioHigh"),
  };

  function pair(key) {
    return {
      range: document.querySelector(`#${key}Range`),
      number: document.querySelector(`#${key}Number`),
    };
  }

  // Per-file decoded arrays captured on entry.
  let files = [];
  let labels = { area: "DNA-A", height: "DNA-H" };

  // Active scope arrays + derived constants.
  let A = [];
  let H = [];
  let allHist = null;
  let centers = [];
  let bounds = { aMin: 0, aMax: 1, ratioMin: 0, ratioMax: 1 };
  let gate = { dnaMin: 0, dnaMax: 1, ratioLow: 0, ratioHigh: 1 };

  let suppressRelayout = false;
  let rafPending = false;
  let pendingFromShape = false;

  function formatInt(value) {
    return Math.round(value).toLocaleString();
  }

  function percentile(sorted, p) {
    if (!sorted.length) {
      return 0;
    }
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
    return sorted[idx];
  }

  // ----- scope / bounds -----------------------------------------------------

  function setScope(scopeId) {
    if (scopeId === "all") {
      A = [].concat(...files.map((f) => f.dnaA));
      H = [].concat(...files.map((f) => f.dnaH));
    } else {
      const file = files[Number(scopeId)];
      A = file.dnaA;
      H = file.dnaH;
    }
    computeBounds();
    allHist = computeAllHist();
  }

  function computeBounds() {
    let aMin = Infinity;
    let aMax = -Infinity;
    const ratios = [];

    for (let i = 0; i < A.length; i += 1) {
      const a = A[i];
      if (a < aMin) aMin = a;
      if (a > aMax) aMax = a;
      if (a > 0) {
        ratios.push(H[i] / a);
      }
    }

    if (!Number.isFinite(aMin)) {
      aMin = 0;
      aMax = 1;
    }
    if (aMin === aMax) {
      aMax = aMin + 1;
    }

    ratios.sort((x, y) => x - y);
    // Clamp ratio slider range to the central bulk so a few divide-by-near-zero
    // outliers don't blow the scale out to infinity.
    const ratioMin = percentile(ratios, 0.5);
    let ratioMax = percentile(ratios, 99.5);
    if (!(ratioMax > ratioMin)) {
      ratioMax = ratioMin + 1;
    }

    bounds = { aMin, aMax, ratioMin, ratioMax };

    const span = (aMax - aMin) / HIST_BINS;
    centers = Array.from({ length: HIST_BINS }, (_, i) => aMin + (i + 0.5) * span);
  }

  function binIndex(value) {
    const span = bounds.aMax - bounds.aMin || 1;
    let b = Math.floor(((value - bounds.aMin) / span) * HIST_BINS);
    if (b < 0) b = 0;
    else if (b >= HIST_BINS) b = HIST_BINS - 1;
    return b;
  }

  function computeAllHist() {
    const all = new Float64Array(HIST_BINS);
    for (let i = 0; i < A.length; i += 1) {
      all[binIndex(A[i])] += 1;
    }
    return all;
  }

  function computeStatsAndHist() {
    const after = new Float64Array(HIST_BINS);
    const total = A.length;
    let retained = 0;
    let saturated = 0;
    let low = 0;

    for (let i = 0; i < total; i += 1) {
      const a = A[i];
      const h = H[i];
      let keep = true;

      if (a > gate.dnaMax) {
        saturated += 1;
        keep = false;
      } else if (a < gate.dnaMin) {
        low += 1;
        keep = false;
      }

      if (keep && a > 0) {
        const ratio = h / a;
        if (ratio < gate.ratioLow || ratio > gate.ratioHigh) {
          keep = false;
        }
      }

      if (keep) {
        retained += 1;
        after[binIndex(a)] += 1;
      }
    }

    return { total, retained, saturated, low, after };
  }

  // ----- gate state ---------------------------------------------------------

  function resetGate() {
    gate = {
      dnaMin: bounds.aMin,
      dnaMax: bounds.aMax,
      ratioLow: bounds.ratioMin,
      ratioHigh: bounds.ratioMax,
    };
  }

  function clampGate() {
    gate.dnaMin = clamp(gate.dnaMin, bounds.aMin, bounds.aMax);
    gate.dnaMax = clamp(gate.dnaMax, bounds.aMin, bounds.aMax);
    if (gate.dnaMin > gate.dnaMax) {
      gate.dnaMin = gate.dnaMax;
    }
    gate.ratioLow = clamp(gate.ratioLow, bounds.ratioMin, bounds.ratioMax);
    gate.ratioHigh = clamp(gate.ratioHigh, bounds.ratioMin, bounds.ratioMax);
    if (gate.ratioLow > gate.ratioHigh) {
      gate.ratioLow = gate.ratioHigh;
    }
  }

  function clamp(value, lo, hi) {
    if (Number.isNaN(value)) return lo;
    return Math.min(hi, Math.max(lo, value));
  }

  function applyGate(partial, fromShape) {
    Object.assign(gate, partial);
    clampGate();
    syncControls();
    scheduleRefresh(fromShape);
  }

  function scheduleRefresh(fromShape) {
    pendingFromShape = pendingFromShape || Boolean(fromShape);
    if (rafPending) {
      return;
    }
    rafPending = true;
    window.requestAnimationFrame(() => {
      rafPending = false;
      const fromShapeNow = pendingFromShape;
      pendingFromShape = false;
      refresh(fromShapeNow);
    });
  }

  // ----- controls (slider + number) -----------------------------------------

  function configureControl(ctrl, lo, hi, value) {
    const step = (hi - lo) / 500 || 0.0001;
    [ctrl.range, ctrl.number].forEach((el) => {
      el.min = lo;
      el.max = hi;
      el.step = step;
      el.value = value;
    });
  }

  function syncControls() {
    setControlValue(controls.dnaMin, gate.dnaMin);
    setControlValue(controls.dnaMax, gate.dnaMax);
    setControlValue(controls.ratioLow, gate.ratioLow);
    setControlValue(controls.ratioHigh, gate.ratioHigh);
  }

  function setControlValue(ctrl, value) {
    ctrl.range.value = value;
    ctrl.number.value = roundForInput(value);
  }

  function roundForInput(value) {
    if (Math.abs(value) >= 100) return Math.round(value);
    return Math.round(value * 1000) / 1000;
  }

  function wireControl(ctrl, key) {
    const handler = (event) => applyGate({ [key]: Number(event.target.value) }, false);
    ctrl.range.addEventListener("input", handler);
    ctrl.number.addEventListener("input", handler);
  }

  // ----- plots --------------------------------------------------------------

  function plotConfig() {
    return { displayModeBar: false, responsive: true, edits: { shapePosition: true } };
  }

  function histShapes() {
    const line = (x, color) => ({
      type: "line",
      x0: x,
      x1: x,
      yref: "paper",
      y0: 0,
      y1: 1,
      line: { color, width: 2 },
    });
    return [line(gate.dnaMin, "#ef4444"), line(gate.dnaMax, "#f59e0b")];
  }

  function buildHistPlot(stats) {
    const before = {
      type: "bar",
      x: centers,
      y: Array.from(allHist),
      name: "All events",
      marker: { color: "rgba(148,163,184,0.55)" },
      hoverinfo: "skip",
    };
    const after = {
      type: "bar",
      x: centers,
      y: Array.from(stats.after),
      name: "Retained",
      marker: { color: "#059669" },
    };
    const layout = {
      barmode: "overlay",
      bargap: 0.02,
      margin: { l: 56, r: 16, t: 8, b: 44 },
      xaxis: { title: labels.area },
      yaxis: { title: "Events" },
      shapes: histShapes(),
      showlegend: true,
      legend: { orientation: "h", x: 0, y: 1.12 },
    };
    window.Plotly.newPlot(histPlot, [before, after], layout, plotConfig());
    histPlot.removeAllListeners?.("plotly_relayout");
    histPlot.on("plotly_relayout", onHistRelayout);
  }

  function bandShapes() {
    const xMax = bounds.aMax;
    const band = (ratio, color) => ({
      type: "line",
      x0: 0,
      y0: 0,
      x1: xMax,
      y1: ratio * xMax,
      line: { color, width: 2, dash: "dash" },
    });
    return [band(gate.ratioLow, "#ef4444"), band(gate.ratioHigh, "#ef4444")];
  }

  function buildSingletPlot() {
    const sampled = sampleXY(A, H, DENSITY_SAMPLE_CAP);
    const density = {
      type: "histogram2d",
      x: sampled.x,
      y: sampled.y,
      nbinsx: DENSITY_BINS,
      nbinsy: DENSITY_BINS,
      colorscale: "YlGnBu",
      showscale: false,
    };
    const layout = {
      margin: { l: 56, r: 16, t: 8, b: 44 },
      xaxis: { title: labels.area },
      yaxis: { title: labels.height },
      shapes: bandShapes(),
    };
    window.Plotly.newPlot(singletPlot, [density], layout, { displayModeBar: false, responsive: true });
  }

  function sampleXY(x, y, cap) {
    if (x.length <= cap) {
      return { x, y };
    }
    const stride = Math.ceil(x.length / cap);
    const sx = [];
    const sy = [];
    for (let i = 0; i < x.length; i += stride) {
      sx.push(x[i]);
      sy.push(y[i]);
    }
    return { x: sx, y: sy };
  }

  function updateHistShapes() {
    suppressRelayout = true;
    window.Plotly.relayout(histPlot, {
      "shapes[0].x0": gate.dnaMin,
      "shapes[0].x1": gate.dnaMin,
      "shapes[1].x0": gate.dnaMax,
      "shapes[1].x1": gate.dnaMax,
    }).then(() => {
      suppressRelayout = false;
    });
  }

  function updateBands() {
    const xMax = bounds.aMax;
    window.Plotly.relayout(singletPlot, {
      "shapes[0].y1": gate.ratioLow * xMax,
      "shapes[1].y1": gate.ratioHigh * xMax,
    });
  }

  function onHistRelayout(ev) {
    if (suppressRelayout) {
      return;
    }
    const partial = {};
    if (ev["shapes[0].x0"] !== undefined) partial.dnaMin = ev["shapes[0].x0"];
    if (ev["shapes[1].x0"] !== undefined) partial.dnaMax = ev["shapes[1].x0"];
    if (Object.keys(partial).length) {
      applyGate(partial, true);
    }
  }

  function refresh(fromShape) {
    const stats = computeStatsAndHist();
    window.Plotly.restyle(histPlot, { y: [Array.from(stats.after)] }, [1]);
    if (!fromShape) {
      updateHistShapes();
    }
    updateBands();
    updateSummary(stats);
  }

  function updateSummary(stats) {
    const pct = stats.total ? (stats.retained / stats.total) * 100 : 0;
    stat.total.textContent = formatInt(stats.total);
    stat.retained.textContent = formatInt(stats.retained);
    stat.retainedPct.textContent = `${pct.toFixed(1)}%`;
    stat.saturated.textContent = formatInt(stats.saturated);
    stat.low.textContent = formatInt(stats.low);
  }

  // ----- scope select / actions ---------------------------------------------

  function populateScopeSelect() {
    scopeSelect.innerHTML = "";
    scopeSelect.add(new Option(`All files (pooled, ${files.length})`, "all"));
    files.forEach((file, index) => {
      scopeSelect.add(new Option(file.name, String(index)));
    });
    scopeSelect.value = "all";
  }

  function configureAllControls() {
    configureControl(controls.dnaMin, bounds.aMin, bounds.aMax, gate.dnaMin);
    configureControl(controls.dnaMax, bounds.aMin, bounds.aMax, gate.dnaMax);
    configureControl(controls.ratioLow, bounds.ratioMin, bounds.ratioMax, gate.ratioLow);
    configureControl(controls.ratioHigh, bounds.ratioMin, bounds.ratioMax, gate.ratioHigh);
  }

  function buildAllPlots() {
    const stats = computeStatsAndHist();
    buildHistPlot(stats);
    buildSingletPlot();
    updateSummary(stats);
  }

  function onScopeChange() {
    setScope(scopeSelect.value);
    resetGate();
    configureAllControls();
    buildAllPlots();
  }

  function onReset() {
    resetGate();
    configureAllControls();
    refresh(false);
  }

  function showView() {
    appMain.hidden = true;
    qcView.hidden = false;
    runDjfButton.disabled = false;
    // Plotly needs a resize once the container is actually visible.
    window.requestAnimationFrame(() => {
      window.Plotly.Plots.resize(histPlot);
      window.Plotly.Plots.resize(singletPlot);
    });
  }

  function exitView() {
    qcView.hidden = true;
    appMain.hidden = false;
  }

  // ----- entry --------------------------------------------------------------

  function enter() {
    const rows = window.FlowPlotterApp.getParsedFiles().filter((row) => row.data);
    if (!rows.length) {
      return;
    }

    files = rows.map((row) => ({
      name: row.name,
      dnaA: row.data.dnaA,
      dnaH: row.data.dnaH,
    }));

    const selected = window.FlowPlotterApp.getSelectedChannels();
    labels = { area: selected.dnaArea || "DNA-A", height: selected.dnaHeight || "DNA-H" };
    histTitle.textContent = `${labels.area} — Before vs After Gate`;
    singletTitle.textContent = `${labels.area} vs ${labels.height} — Singlet Gate`;

    populateScopeSelect();
    setScope("all");
    resetGate();
    configureAllControls();
    buildAllPlots();
    showView();
  }

  scopeSelect.addEventListener("change", onScopeChange);
  resetButton.addEventListener("click", onReset);
  backButton.addEventListener("click", exitView);
  runDjfButton.addEventListener("click", () => {
    window.FlowPlotterApp.setStatusBar("Run DJF is not implemented yet (QC gates are ready).");
  });

  wireControl(controls.dnaMin, "dnaMin");
  wireControl(controls.dnaMax, "dnaMax");
  wireControl(controls.ratioLow, "ratioLow");
  wireControl(controls.ratioHigh, "ratioHigh");

  window.FlowPlotterQC = { enter };
})();
