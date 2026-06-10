const analysisStartButton = document.querySelector("#startAnalysisButton");
const plotPanel = document.querySelector("#plotPanel");
const plotArea = document.querySelector("#plotArea");
const metadataPanel = document.querySelector("#metadataPanel");
const metadataPanelBody = document.querySelector("#metadataPanelBody");
const metadataPanelToggle = document.querySelector("#metadataPanelToggle");
const metadataPanelChevron = document.querySelector("#metadataPanelChevron");

const ANALYSIS_FILE_CONCURRENCY = 4;
const DENSITY_BINS = 256;

function setMetadataPanelCollapsed(isCollapsed) {
  metadataPanel.classList.toggle("is-collapsed", isCollapsed);
  metadataPanelBody.hidden = isCollapsed;
  metadataPanelToggle.setAttribute("aria-expanded", String(!isCollapsed));
  metadataPanelChevron.src = isCollapsed
    ? "./assets/img/chevron-right-icon.svg"
    : "./assets/img/chevron-down-icon.svg";
}

function collapseMetadataPanel() {
  setMetadataPanelCollapsed(true);
}

function toggleMetadataPanel() {
  setMetadataPanelCollapsed(!metadataPanel.classList.contains("is-collapsed"));
}

function parameterMap(summary) {
  return summary.columns.map((label, index) => ({
    index: index + 1,
    label,
    name: summary.metadata[`P${index + 1}N`] || "",
    desc: summary.metadata[`P${index + 1}S`] || "",
  }));
}

function findParamIndex(params, selectedLabel) {
  const hit = params.find((param) =>
    param.label === selectedLabel || param.name === selectedLabel || param.desc === selectedLabel
  );

  if (!hit) {
    throw new Error(`Could not find selected channel: ${selectedLabel}`);
  }

  return hit.index;
}

function uniqueIndexes(indexes) {
  return Array.from(new Set(indexes.filter((index) => Number.isInteger(index))));
}

async function loadSelectedFcsColumns(file, summary, selectedIndexes) {
  const dataBuffer = await file.slice(summary.dataBegin, summary.dataEnd + 1).arrayBuffer();
  return window.FCSParser.parseSelectedColumns(dataBuffer, summary.metadata, selectedIndexes);
}

function selectedIndexesForFile(summary, selected) {
  const params = parameterMap(summary);
  return {
    dnaA: findParamIndex(params, selected.dnaArea),
  };
}

async function loadAnalysisRow(row, selected) {
  const indexes = selectedIndexesForFile(row.summary, selected);
  const columns = await loadSelectedFcsColumns(row.file, row.summary, uniqueIndexes(Object.values(indexes)));

  row.data = {
    dnaA: columns[indexes.dnaA],
    indexes,
  };
}

async function loadAnalysisBatch(batch, selected, app, completed, total) {
  const tasks = batch.map(({ row }) => loadAnalysisRow(row, selected));

  for (const { row, index } of batch) {
    completed.count += 1;
    app.updateProgress(
      (completed.count / total) * 100,
      "Loading Selected FCS Data",
      `Loading selected data for file ${index + 1} of ${total}`,
      row.name,
    );
    await app.nextFrame();
  }

  await Promise.all(tasks);
}

async function loadAnalysisData() {
  const app = window.FlowPlotterApp;
  const rows = app.getSelectedFiles();
  const selected = app.getSelectedChannels();
  const completed = { count: 0 };

  if (!rows.length) {
    app.setStatus("Select at least one file (check its row) before starting analysis.", true);
    app.setStatusBar("No files selected for analysis.", true);
    return;
  }

  app.showProgress("Loading Selected FCS Data");
  app.setStatusBar("Working: Loading Selected FCS Data");
  app.updateProgress(0, "Loading Selected FCS Data", `Preparing ${rows.length} file(s)...`);
  await app.nextFrame();

  for (let start = 0; start < rows.length; start += ANALYSIS_FILE_CONCURRENCY) {
    const batch = rows.slice(start, start + ANALYSIS_FILE_CONCURRENCY).map((row, offset) => ({
      row,
      index: start + offset,
    }));
    await loadAnalysisBatch(batch, selected, app, completed, rows.length);
  }

  const totalEvents = rows.reduce((sum, row) => sum + (row.data ? row.data.dnaA.length : 0), 0);

  app.setStatus(
    `Loaded ${rows.length} file(s) · ${totalEvents.toLocaleString()} events.`,
  );
  app.setStatusBar(`Finished loading selected data for ${rows.length} file(s).`);
  app.updateProgress(100, "Loading Selected FCS Data", `Finished loading selected data for ${rows.length} file(s).`);

  renderDensityPlot(rows, selected);

  app.hideProgress(700);
}

// Evenly spaced, distinct hue per sample so many overlaid curves stay readable.
function sampleColor(index, total) {
  const hue = total > 1 ? Math.round((index * 360) / total) % 360 : 210;
  return `hsl(${hue}, 70%, 45%)`;
}

// Shared x-range from the 0.5th–99.5th percentiles of a downsample of all
// selected events, so a few extreme outliers don't squash the curves.
function sharedRange(rows) {
  const total = rows.reduce((sum, row) => sum + row.data.dnaA.length, 0);
  const stride = Math.max(1, Math.floor(total / 50000));
  const sample = [];
  for (const row of rows) {
    const values = row.data.dnaA;
    for (let i = 0; i < values.length; i += stride) {
      sample.push(values[i]);
    }
  }
  if (!sample.length) {
    return [0, 1];
  }
  sample.sort((a, b) => a - b);
  const at = (p) => sample[Math.min(sample.length - 1, Math.max(0, Math.round(p * (sample.length - 1))))];
  let lo = at(0.005);
  let hi = at(0.995);
  if (!(hi > lo)) {
    lo = sample[0];
    hi = sample[sample.length - 1];
  }
  if (!(hi > lo)) {
    hi = lo + 1;
  }
  return [lo, hi];
}

// One normalized-histogram density curve (area sums to 1) for a sample.
function densityTrace(values, name, color, range) {
  const [lo, hi] = range;
  const width = (hi - lo) / DENSITY_BINS;
  const counts = new Float64Array(DENSITY_BINS);
  let kept = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value < lo || value > hi) {
      continue;
    }
    let bin = Math.floor((value - lo) / width);
    if (bin >= DENSITY_BINS) bin = DENSITY_BINS - 1;
    else if (bin < 0) bin = 0;
    counts[bin]++;
    kept++;
  }

  const denom = kept * width || 1;
  const x = new Array(DENSITY_BINS);
  const y = new Array(DENSITY_BINS);
  for (let i = 0; i < DENSITY_BINS; i++) {
    x[i] = lo + (i + 0.5) * width;
    y[i] = counts[i] / denom;
  }

  return {
    x,
    y,
    type: "scatter",
    mode: "lines",
    name,
    line: { color, width: 1.5, shape: "spline" },
    hovertemplate: `${name}<br>%{x:.0f}: %{y:.3g}<extra></extra>`,
  };
}

function renderDensityPlot(rows, selected) {
  if (!window.Plotly || !plotArea) {
    return;
  }

  const range = sharedRange(rows);
  const traces = rows.map((row, index) =>
    densityTrace(row.data.dnaA, row.name, sampleColor(index, rows.length), range),
  );

  const layout = {
    autosize: true,
    margin: { l: 64, r: 16, t: 12, b: 48 },
    xaxis: { title: selected.dnaArea || "DNA-content area", range },
    yaxis: { title: "Density", rangemode: "tozero" },
    legend: { font: { size: 11 } },
    hovermode: "closest",
  };

  window.Plotly.newPlot(plotArea, traces, layout, { responsive: true, displaylogo: false });
}

async function startAnalysis() {
  plotPanel.hidden = false;

  try {
    await loadAnalysisData();
  } catch (error) {
    window.FlowPlotterApp.setStatus(error.message, true);
    window.FlowPlotterApp.setStatusBar("Selected data loading failed.", true);
    window.FlowPlotterApp.updateProgress(100, "Loading Selected FCS Data", error.message);
    window.FlowPlotterApp.hideProgress(1400);
  }
}

metadataPanelToggle.addEventListener("click", toggleMetadataPanel);
analysisStartButton.addEventListener("click", startAnalysis);
