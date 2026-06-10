const analysisStartButton = document.querySelector("#startAnalysisButton");
const metadataPanel = document.querySelector("#metadataPanel");
const metadataPanelBody = document.querySelector("#metadataPanelBody");
const metadataPanelToggle = document.querySelector("#metadataPanelToggle");
const metadataPanelChevron = document.querySelector("#metadataPanelChevron");

const ANALYSIS_FILE_CONCURRENCY = 4;

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
  const indexes = {
    dnaA: findParamIndex(params, selected.dnaArea),
    dnaH: findParamIndex(params, selected.dnaHeight),
    dnaW: findParamIndex(params, selected.dnaWidth),
    fscA: findParamIndex(params, "FSC-A"),
    sscA: findParamIndex(params, "SSC-A"),
  };

  if (selected.timeChannel) {
    indexes.time = findParamIndex(params, selected.timeChannel);
  }

  selected.debris.forEach((channel) => {
    findParamIndex(params, channel);
  });

  return indexes;
}

async function loadAnalysisRow(row, selected) {
  const indexes = selectedIndexesForFile(row.summary, selected);
  const columns = await loadSelectedFcsColumns(row.file, row.summary, uniqueIndexes(Object.values(indexes)));

  row.data = {
    dnaA: columns[indexes.dnaA],
    dnaH: columns[indexes.dnaH],
    dnaW: columns[indexes.dnaW],
    fscA: columns[indexes.fscA],
    sscA: columns[indexes.sscA],
    time: indexes.time ? columns[indexes.time] : null,
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
  const rows = app.getParsedFiles();
  const selected = app.getSelectedChannels();
  const completed = { count: 0 };

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
  app.hideProgress(700);
}

async function startAnalysis() {
  collapseMetadataPanel();

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
