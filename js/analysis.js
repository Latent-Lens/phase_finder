const analysisStartButton = document.querySelector("#startAnalysisButton");
const plotPanel = document.querySelector("#plotPanel");
const metadataPanel = document.querySelector("#metadataPanel");
const metadataPanelBody = document.querySelector("#metadataPanelBody");
const metadataPanelToggle = document.querySelector("#metadataPanelToggle");
const metadataPanelChevron = document.querySelector("#metadataPanelChevron");

const ANALYSIS_FILE_CONCURRENCY = 4;

/*

Purpose:
	Collapses or expands the metadata (Loaded FCS Samples) panel, updating its
	CSS class, body visibility, aria-expanded state, and chevron icon.

Input:
	isCollapsed [boolean]: true to collapse the panel, false to expand it

Output:
	(none) [void]: updates the metadata panel DOM

*/
function setMetadataPanelCollapsed(isCollapsed) {
  metadataPanel.classList.toggle("is-collapsed", isCollapsed);
  metadataPanelBody.hidden = isCollapsed;
  metadataPanelToggle.setAttribute("aria-expanded", String(!isCollapsed));
  metadataPanelChevron.src = isCollapsed
    ? "./assets/img/chevron-right-icon.svg"
    : "./assets/img/chevron-down-icon.svg";
}

/*

Purpose:
	Convenience wrapper that collapses the metadata panel.

Input:
	(none)

Output:
	(none) [void]: collapses the metadata panel

*/
function collapseMetadataPanel() {
  setMetadataPanelCollapsed(true);
}

/*

Purpose:
	Toggles the metadata panel between its collapsed and expanded states.

Input:
	(none)

Output:
	(none) [void]: toggles the metadata panel

*/
function toggleMetadataPanel() {
  setMetadataPanelCollapsed(!metadataPanel.classList.contains("is-collapsed"));
}

/*

Purpose:
	Builds a lookup of a file's FCS parameters, pairing each column with its
	1-based index and its $PnN / $PnS metadata names.

Input:
	summary [Object]: parsed FCS header/metadata for one file

Output:
	params [Array<Object>]: { index, label, name, desc } per parameter

*/
function parameterMap(summary) {
  return summary.columns.map((label, index) => ({
    index: index + 1,
    label,
    name: summary.metadata[`P${index + 1}N`] || "",
    desc: summary.metadata[`P${index + 1}S`] || "",
  }));
}

/*

Purpose:
	Finds the 1-based parameter index whose label, name, or description matches
	the selected channel. Throws if no parameter matches.

Input:
	params [Array<Object>]: parameter map from parameterMap()
	selectedLabel [string]: the chosen channel label/name

Output:
	index [number]: the 1-based FCS parameter index

*/
function findParamIndex(params, selectedLabel) {
  const hit = params.find((param) =>
    param.label === selectedLabel || param.name === selectedLabel || param.desc === selectedLabel
  );

  if (!hit) {
    throw new Error(`Could not find selected channel: ${selectedLabel}`);
  }

  return hit.index;
}

/*

Purpose:
	De-duplicates a list of parameter indexes, keeping only integers, so a
	column isn't read twice from the FCS data.

Input:
	indexes [Array<number>]: candidate parameter indexes (may include non-integers)

Output:
	unique [Array<number>]: the distinct integer indexes

*/
function uniqueIndexes(indexes) {
  return Array.from(new Set(indexes.filter((index) => Number.isInteger(index))));
}

/*

Purpose:
	Reads only the requested parameter columns from one FCS file's DATA segment
	via window.FCSParser, avoiding loading unused channels.

Input:
	file [File]:                     the FCS File object
	summary [Object]:                parsed header/metadata (dataBegin/dataEnd/metadata)
	selectedIndexes [Array<number>]: 1-based parameter indexes to read

Output:
	columns [Promise<Object>]: resolves to the parsed columns keyed by index

*/
async function loadSelectedFcsColumns(file, summary, selectedIndexes) {
  const dataBuffer = await file.slice(summary.dataBegin, summary.dataEnd + 1).arrayBuffer();
  return window.FCSParser.parseSelectedColumns(dataBuffer, summary.metadata, selectedIndexes);
}

/*

Purpose:
	Resolves the selected DNA-content area channel to its parameter index for
	one file.

Input:
	summary [Object]:  parsed header/metadata for the file
	selected [Object]: the selected channels, e.g. { dnaArea }

Output:
	indexes [Object]: { dnaA } parameter index for the file

*/
function selectedIndexesForFile(summary, selected) {
  const params = parameterMap(summary);
  return {
    dnaA: findParamIndex(params, selected.dnaArea),
  };
}

/*

Purpose:
	Loads the selected DNA-content column for one sample and stores it on
	row.data so the plot can read it.

Input:
	row [Object]:      a loaded sample (has .file and .summary)
	selected [Object]: the selected channels

Output:
	(none) [Promise<void>]: sets row.data = { dnaA, indexes }

*/
async function loadAnalysisRow(row, selected) {
  const indexes = selectedIndexesForFile(row.summary, selected);
  const columns = await loadSelectedFcsColumns(row.file, row.summary, uniqueIndexes(Object.values(indexes)));

  row.data = {
    dnaA: columns[indexes.dnaA],
    indexes,
  };
}

/*

Purpose:
	Loads a batch of samples concurrently while reporting per-file progress
	through the app's progress UI.

Input:
	batch [Array<Object>]: { row, index } entries to load
	selected [Object]:     the selected channels
	app [Object]:          window.FlowPlotterApp (progress/status helpers)
	completed [Object]:    shared { count } progress counter (mutated)
	total [number]:        total number of files being loaded

Output:
	(none) [Promise<void>]: loads each row's data and advances progress

*/
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

/*

Purpose:
	Orchestrates analysis: gathers the checked samples and the selected channel,
	loads their data in batches with progress feedback, then reveals the plot
	via initPlot. Bails with a status message if nothing is selected.

Input:
	(none)

Output:
	(none) [Promise<void>]: loads the selected data and initializes the plot

*/
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

  // The loaded-sample / event counts now live in the plot title (see
  // updatePlotTitle in plotting.js), so the sidebar just confirms completion.
  app.setStatus("Analysis complete.");
  app.setStatusBar(`Finished loading selected data for ${rows.length} file(s).`);
  app.updateProgress(100, "Loading Selected FCS Data", `Finished loading selected data for ${rows.length} file(s).`);

  initPlot(selected);

  app.hideProgress(700);
}

/*

Purpose:
	Entry point for the Start Analysis button: reveals the plot panel and runs
	loadAnalysisData, surfacing any error to the status UI.

Input:
	(none)

Output:
	(none) [Promise<void>]: runs the analysis workflow

*/
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
