const analysisStartButton = document.querySelector("#startAnalysisButton");
const analysisCollapsedPlotButton = document.querySelector("#collapsedPlotButton");
const plotPanel = document.querySelector("#plotPanel");
const metadataPanel = document.querySelector("#metadataPanel");
const metadataPanelBody = document.querySelector("#metadataPanelBody");
const metadataPanelToggle = document.querySelector("#metadataPanelToggle");
const metadataPanelToggleIcon = document.querySelector("#metadataPanelToggleIcon");

const TABLE_MINIMIZE_ICON = "./assets/img/table_minimize.svg";
const TABLE_RESTORE_ICON = "./assets/img/table_restore.svg";
const TABLE_PANEL_TRANSITION_MS = 220;

const ANALYSIS_FILE_CONCURRENCY = 4;
const FCS_DATA_WORKER_URL = "./js/fcs_data_worker.js";

let fcsDataWorker = null;
let fcsDataWorkerRequestId = 0;
let fcsDataWorkerUnavailable = false;
const fcsDataWorkerRequests = new Map();

/*

Purpose:
	Collapses or expands the metadata (Loaded FCS Samples) panel, updating its
	CSS class, body accessibility state, aria-expanded state, and toggle icon.

Input:
	isCollapsed [boolean]: true to collapse the panel, false to expand it

Output:
	(none) [void]: updates the metadata panel DOM

*/
function setMetadataPanelCollapsed(isCollapsed) {
  if (metadataPanel.classList.contains("is-collapsed") === isCollapsed) {
    return;
  }

  metadataPanel.classList.toggle("is-collapsed", isCollapsed);
  metadataPanelBody.setAttribute("aria-hidden", String(isCollapsed));
  if ("inert" in metadataPanelBody) metadataPanelBody.inert = isCollapsed;

  const tableTooltipKey = isCollapsed ? "tableExpand" : "tableCollapse";
  metadataPanelToggle.setAttribute("aria-expanded", String(!isCollapsed));
  window.PhaseFinderTooltips.setQuickTooltip(metadataPanelToggle, tableTooltipKey);
  metadataPanelToggle.setAttribute("aria-label", window.PhaseFinderTooltips.text(tableTooltipKey));
  metadataPanelToggleIcon.src = isCollapsed ? TABLE_RESTORE_ICON : TABLE_MINIMIZE_ICON;

  const notifyLayoutChanged = () => window.dispatchEvent(new Event("resize"));
  window.requestAnimationFrame(notifyLayoutChanged);
  window.setTimeout(notifyLayoutChanged, TABLE_PANEL_TRANSITION_MS);
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
	Builds a stable cache key for analysis data loaded for a selected channel.

Input:
	selected [Object]: the selected channels, e.g. { dnaArea }

Output:
	key [string]: the cache key for this analysis channel

*/
function analysisDataKey(selected) {
  return selected && selected.dnaArea ? selected.dnaArea : "";
}

/*

Purpose:
	Returns cached analysis data for a row/channel, if that channel was already
	loaded.

Input:
	row [Object]:      loaded sample row
	selected [Object]: selected channels

Output:
	data [Object|null]: cached row data for the selected channel

*/
function cachedAnalysisData(row, selected) {
  const key = analysisDataKey(selected);
  return row.analysisDataByChannel ? row.analysisDataByChannel.get(key) || null : null;
}

/*

Purpose:
	Stores analysis data in the row's per-channel cache and optionally activates
	it as row.data for plotting.

Input:
	row [Object]:       loaded sample row
	selected [Object]:  selected channels
	data [Object]:      loaded channel data
	activate [boolean]: true to set row.data for plotting

Output:
	data [Object]: the stored row data

*/
function storeAnalysisData(row, selected, data, activate = true) {
  if (!row.analysisDataByChannel) {
    row.analysisDataByChannel = new Map();
  }
  row.analysisDataByChannel.set(analysisDataKey(selected), data);
  if (activate) {
    row.data = data;
  }
  return data;
}

/*

Purpose:
	Checks whether a row already has the selected channel loaded in cache.

Input:
	row [Object]:      loaded sample row
	selected [Object]: selected channels

Output:
	loaded [boolean]: true when cached data exists for the selected channel

*/
function isAnalysisDataLoaded(row, selected) {
  const data = cachedAnalysisData(row, selected);
  return Boolean(data && data.dnaA);
}

/*

Purpose:
	Activates cached data for the selected channel as row.data so plot code reads
	the intended column.

Input:
	row [Object]:      loaded sample row
	selected [Object]: selected channels

Output:
	activated [boolean]: true if cached data was activated

*/
function activateAnalysisData(row, selected) {
  const data = cachedAnalysisData(row, selected);
  if (!data) {
    return false;
  }
  row.data = data;
  return true;
}

/*

Purpose:
	Returns the shared FCS data worker, creating it on first use. If worker
	creation fails, future selected-column loads fall back to the main thread.

Input:
	(none)

Output:
	worker [Worker|null]: active worker, or null when unavailable

*/
function getFcsDataWorker() {
  if (fcsDataWorkerUnavailable || typeof Worker === "undefined") {
    return null;
  }

  if (fcsDataWorker) {
    return fcsDataWorker;
  }

  try {
    fcsDataWorker = new Worker(FCS_DATA_WORKER_URL);
    fcsDataWorker.addEventListener("message", (event) => {
      const { requestId, ok, columns, error } = event.data || {};
      const request = fcsDataWorkerRequests.get(requestId);
      if (!request) {
        return;
      }

      fcsDataWorkerRequests.delete(requestId);
      if (ok) {
        request.resolve(columns);
      } else {
        request.reject(new Error(error || "FCS worker failed to load selected columns."));
      }
    });
    fcsDataWorker.addEventListener("error", () => {
      fcsDataWorkerUnavailable = true;
      fcsDataWorkerRequests.forEach((request) => {
        request.reject(new Error("FCS data worker failed. Falling back on future loads."));
      });
      fcsDataWorkerRequests.clear();
      if (fcsDataWorker) {
        fcsDataWorker.terminate();
        fcsDataWorker = null;
      }
    });
  } catch (error) {
    fcsDataWorkerUnavailable = true;
    fcsDataWorker = null;
  }

  return fcsDataWorker;
}

/*

Purpose:
	Reads requested parameter columns in the FCS data worker.

Input:
	file [File]:                     the FCS File object
	summary [Object]:                parsed header/metadata (dataBegin/dataEnd/metadata)
	selectedIndexes [Array<number>]: 1-based parameter indexes to read

Output:
	columns [Promise<Object>|null]: selected parameter arrays keyed by index

*/
function loadSelectedFcsColumnsInWorker(file, summary, selectedIndexes) {
  const worker = getFcsDataWorker();
  if (!worker) {
    return null;
  }

  const requestId = ++fcsDataWorkerRequestId;
  const request = new Promise((resolve, reject) => {
    fcsDataWorkerRequests.set(requestId, { resolve, reject });
  });

  try {
    worker.postMessage({ requestId, file, summary, selectedIndexes });
  } catch (error) {
    fcsDataWorkerRequests.delete(requestId);
    return null;
  }

  return request;
}

/*

Purpose:
	Reads only the requested parameter columns from one FCS file's DATA segment,
	preferring the worker path so large data parsing does not block the UI thread.

Input:
	file [File]:                     the FCS File object
	summary [Object]:                parsed header/metadata (dataBegin/dataEnd/metadata)
	selectedIndexes [Array<number>]: 1-based parameter indexes to read

Output:
	columns [Promise<Object>]: resolves to the parsed columns keyed by index

*/
async function loadSelectedFcsColumns(file, summary, selectedIndexes, options = {}) {
  const { allowMainThreadFallback = true } = options;
  const workerRequest = loadSelectedFcsColumnsInWorker(file, summary, selectedIndexes);
  if (workerRequest) {
    try {
      return await workerRequest;
    } catch (error) {
      if (!fcsDataWorkerUnavailable || !allowMainThreadFallback) {
        throw error;
      }
    }
  } else if (!allowMainThreadFallback) {
    throw new Error("Background worker unavailable; added FCS data will load when selected.");
  }

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
  const dnaA = findParamIndex(params, selected.dnaArea);
  const aux = window.PhaseFinderDJF && typeof window.PhaseFinderDJF.findAuxiliaryIndexes === "function"
    ? window.PhaseFinderDJF.findAuxiliaryIndexes(summary, selected.dnaArea)
    : {};

  return {
    dnaA,
    dnaH: aux.dnaH || null,
    dnaW: aux.dnaW || null,
    dnaHeightLabel: aux.dnaHeightLabel || "",
    dnaWidthLabel: aux.dnaWidthLabel || "",
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
async function loadAnalysisRow(row, selected, options = {}) {
  const { activate = true } = options;
  const key = analysisDataKey(selected);
  const cached = cachedAnalysisData(row, selected);

  if (cached && cached.dnaA) {
    if (activate) {
      row.data = cached;
    }
    return cached;
  }

  if (!row.analysisDataPromisesByChannel) {
    row.analysisDataPromisesByChannel = new Map();
  }

  const pending = row.analysisDataPromisesByChannel.get(key);
  if (pending) {
    try {
      const data = await pending;
      if (activate) {
        row.data = data;
      }
      return data;
    } catch (error) {
      if (options.allowMainThreadFallback === false || !fcsDataWorkerUnavailable) {
        throw error;
      }
      row.analysisDataPromisesByChannel.delete(key);
    }
  }

  const promise = (async () => {
    const indexes = selectedIndexesForFile(row.summary, selected);
    const columns = await loadSelectedFcsColumns(row.file, row.summary, uniqueIndexes([indexes.dnaA, indexes.dnaH, indexes.dnaW]), options);
    const data = {
      channelKey: key,
      channel: selected.dnaArea,
      dnaA: columns[indexes.dnaA],
      dnaH: indexes.dnaH ? columns[indexes.dnaH] : null,
      dnaW: indexes.dnaW ? columns[indexes.dnaW] : null,
      indexes,
    };
    return storeAnalysisData(row, selected, data, activate);
  })();

  row.analysisDataPromisesByChannel.set(key, promise);

  try {
    const data = await promise;
    if (activate) {
      row.data = data;
    }
    return data;
  } finally {
    row.analysisDataPromisesByChannel.delete(key);
  }
}

/*

Purpose:
	Loads a batch of samples concurrently while reporting per-file progress
	through the app's progress UI.

Input:
  batch [Array<Object>]: { row, index } entries to load
  selected [Object]:     the selected channels
  app [Object]:          window.PhaseFinderApp (progress/status helpers)
  completed [Object]:    shared { count } progress counter (mutated)
  total [number]:        total number of files being loaded

Output:
	(none) [Promise<void>]: loads each row's data and advances progress

*/
async function loadAnalysisBatch(
  batch,
  selected,
  app,
  completed,
  total,
  label = "Loading Selected FCS Data",
  options = {},
) {
  const {
    useOverlay = true,
    detailPrefix = "Loading selected data",
    allowMainThreadFallback = true,
    activate = true,
    displayTotal = total,
    displaySuffix = "",
  } = options;
  const tasks = batch.map(({ row }) => loadAnalysisRow(row, selected, { allowMainThreadFallback, activate }));

  for (const { row, index } of batch) {
    completed.count += 1;
    const percent = (completed.count / total) * 100;
    const detail = `${detailPrefix} for file ${index + 1} of ${displayTotal}${displaySuffix}`;

    if (useOverlay) {
      app.updateProgress(percent, label, detail, row.name);
    } else {
      app.setStatusBar(`${detail}: ${row.name}`);
    }
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
  const app = window.PhaseFinderApp;
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
	Refreshes downstream analysis after new metadata files are added. If a plot
	already exists, loads event data only for selected rows missing data and
	redraws the existing plot/modeling view.

Input:
	(none)

Output:
	result [Promise<Object>]: { refreshed, loadedRows }

*/
async function refreshAnalysisAfterMetadataChange({ redrawIfNoMissing = true } = {}) {
  if (typeof plotChannels === "undefined" || !plotChannels || typeof initPlot !== "function") {
    return { refreshed: false, loadedRows: 0 };
  }

  const app = window.PhaseFinderApp;
  const selected = app.getSelectedChannels();
  const rows = app.getSelectedFiles();
  const shouldActivatePlot = !plotChannels || selected.dnaArea === plotChannels.dnaArea;
  const missingRows = rows.filter((row) => !isAnalysisDataLoaded(row, selected));

  if (!missingRows.length) {
    if (redrawIfNoMissing && shouldActivatePlot) {
      rows.forEach((row) => activateAnalysisData(row, selected));
      initPlot(selected);
    }
    return { refreshed: redrawIfNoMissing && shouldActivatePlot, loadedRows: 0 };
  }

  const completed = { count: 0 };
  const label = "Loading Added FCS Data";
  app.showProgress(label);
  app.setStatusBar(`Working: ${label}`);
  app.updateProgress(0, label, `Preparing ${missingRows.length} added file(s)...`);
  await app.nextFrame();

  try {
    for (let start = 0; start < missingRows.length; start += ANALYSIS_FILE_CONCURRENCY) {
      const batch = missingRows.slice(start, start + ANALYSIS_FILE_CONCURRENCY).map((row, offset) => ({
        row,
        index: start + offset,
      }));
      await loadAnalysisBatch(batch, selected, app, completed, missingRows.length, label, {
        activate: shouldActivatePlot,
      });
    }
  } catch (error) {
    if (typeof renderDensityPlot === "function") {
      renderDensityPlot();
    }
    throw error;
  }

  if (shouldActivatePlot) {
    initPlot(selected);
  }
  return { refreshed: shouldActivatePlot, loadedRows: missingRows.length };
}

/*

Purpose:
	Preloads event data for newly added files after a plot already exists. Rows
	remain unchecked, so their traces are not added unless the user selects them.
	Progress is reported only in the footer status bar.

Input:
	rows [Array<Object>]: newly added loaded-file entries

Output:
	result [Promise<Object>]: { preloaded, loadedRows }

*/
async function preloadAnalysisRowsInBackground(rows) {
  if (typeof plotChannels === "undefined" || !plotChannels || !rows || !rows.length) {
    return { preloaded: false, loadedRows: 0 };
  }

  const app = window.PhaseFinderApp;
  const selected = app.getSelectedChannels();
  const targets = rows.filter((row) => !isAnalysisDataLoaded(row, selected));

  if (!targets.length) {
    return { preloaded: false, loadedRows: 0 };
  }

  if (!getFcsDataWorker()) {
    app.setStatusBar("Background worker unavailable; added FCS data will load when selected.");
    return { preloaded: false, loadedRows: 0 };
  }

  const completed = { count: 0 };
  const label = "Loading Added FCS Data";
  const allRows = typeof app.getParsedFiles === "function" ? app.getParsedFiles() : targets;
  const overallIndexByRow = new Map(allRows.map((row, index) => [row, index]));
  app.setStatusBar(`Preparing ${targets.length} added FCS file(s) for background loading...`);

  try {
    for (let start = 0; start < targets.length; start += ANALYSIS_FILE_CONCURRENCY) {
      const batch = targets.slice(start, start + ANALYSIS_FILE_CONCURRENCY).map((row) => ({
        row,
        index: overallIndexByRow.get(row) ?? 0,
      }));
      await loadAnalysisBatch(batch, selected, app, completed, targets.length, label, {
        useOverlay: false,
        detailPrefix: "Loading selected data",
        allowMainThreadFallback: false,
        activate: false,
        displayTotal: allRows.length,
        displaySuffix: " FCS files",
      });
    }
  } catch (error) {
    app.setStatusBar(`Background FCS data load failed: ${error.message}`, true);
    return { preloaded: false, loadedRows: completed.count };
  }

  app.setStatusBar(`Background loaded event data for ${targets.length} added file(s).`);
  return { preloaded: true, loadedRows: targets.length };
}

// Whether analysis has run; once true the button drives DJF modeling instead.
let modelingMode = false;
let channelChangeLoadId = 0;

/*

Purpose:
	Forces the plot action controls disabled/enabled while modal channel-data
	loading is in progress.

Input:
	isDisabled [boolean]: true to disable plot controls

Output:
	(none) [void]: updates the plot action buttons

*/
function setPlotActionControlsDisabled(isDisabled) {
  [analysisStartButton, analysisCollapsedPlotButton].forEach((button) => {
    if (button) {
      button.disabled = isDisabled;
    }
  });
}

/*

Purpose:
	Restores the Plot Channel Events button state after the selected channel
	changes, replacing Start Modeling (DJF) until the new channel is plotted.

Input:
	(none)

Output:
	(none) [void]: updates button text, class, and tooltip

*/
function enterPlottingMode() {
  modelingMode = false;
  if (typeof resetModelingState === "function") {
    resetModelingState();
  }
  analysisStartButton.textContent = "Plot Channel Events";
  analysisStartButton.classList.remove("modeling");
  window.PhaseFinderTooltips.setQuickTooltip(analysisStartButton, "plotChannelEvents");
  window.PhaseFinderTooltips.setQuickTooltip(analysisCollapsedPlotButton, "plotChannelEvents");
  analysisCollapsedPlotButton.setAttribute("aria-label", window.PhaseFinderTooltips.text("plotChannelEvents"));
}

/*

Purpose:
	After a plot exists and the selected channel changes, load missing data for
	the new channel with the modal progress UI, but do not activate it in the
	visible plot until the user clicks Plot Channel Events.

Input:
	(none)

Output:
	(none) [Promise<void>]: loads selected-row data for the newly selected channel

*/
async function prepareSelectedChannelForPlotting() {
  if (typeof plotChannels === "undefined" || !plotChannels) {
    return;
  }

  const requestId = ++channelChangeLoadId;
  const app = window.PhaseFinderApp;
  const selected = app.getSelectedChannels();
  const rows = app.getSelectedFiles();

  enterPlottingMode();

  if (typeof updateStartButtonState === "function") {
    updateStartButtonState();
  }

  if (typeof initPlot === "function") {
    initPlot(selected);
  }

  if (!selected.dnaArea || !rows.length) {
    app.setStatusBar("Select a channel and at least one file row before plotting.", true);
    return;
  }

  const missingRows = rows.filter((row) => !isAnalysisDataLoaded(row, selected));
  if (!missingRows.length) {
    app.setStatusBar(`Selected channel ${selected.dnaArea} is ready to plot.`);
    return;
  }

  const completed = { count: 0 };
  const label = "Loading Selected FCS Data";
  setPlotActionControlsDisabled(true);
  app.showProgress(label);
  app.setStatusBar(`Working: ${label}`);
  app.updateProgress(0, label, `Preparing ${missingRows.length} file(s)...`);
  await app.nextFrame();

  try {
    for (let start = 0; start < missingRows.length; start += ANALYSIS_FILE_CONCURRENCY) {
      const batch = missingRows.slice(start, start + ANALYSIS_FILE_CONCURRENCY).map((row, offset) => ({
        row,
        index: start + offset,
      }));
      await loadAnalysisBatch(batch, selected, app, completed, missingRows.length, label, {
        activate: false,
      });
    }

    if (requestId === channelChangeLoadId) {
      app.setStatusBar(`Selected channel ${selected.dnaArea} is ready to plot.`);
      app.updateProgress(100, label, `Finished loading selected data for ${missingRows.length} file(s).`);
    }
  } finally {
    if (requestId === channelChangeLoadId) {
      app.hideProgress(700);
      if (typeof updateStartButtonState === "function") {
        updateStartButtonState();
      } else {
        setPlotActionControlsDisabled(false);
      }
    }
  }
}

/*

Purpose:
	Turns the Plot Channel Events button into the blue "Start Modeling (DJF)" button
	after analysis has run, so clicking it next starts cell-cycle modeling.

Input:
	(none)

Output:
	(none) [void]: updates the button text/style and the modeling flag

*/
function enterModelingMode() {
  modelingMode = true;
  analysisStartButton.textContent = "Start Modeling (DJF)";
  analysisStartButton.classList.add("modeling");
  window.PhaseFinderTooltips.setQuickTooltip(analysisStartButton, "modeling");
  window.PhaseFinderTooltips.setQuickTooltip(analysisCollapsedPlotButton, "modeling");
  analysisCollapsedPlotButton.setAttribute("aria-label", window.PhaseFinderTooltips.text("modeling"));
}

/*

Purpose:
	Click handler for plot controls. Before analysis it loads the selected
	data and reveals the plot (then flips the button to modeling mode); after
	that it starts DJF modeling (plotting.js startModeling).

Input:
	(none)

Output:
	(none) [Promise<void>]: runs analysis or starts modeling

*/
async function startAnalysis() {
  if (modelingMode) {
    startModeling();
    return;
  }

  plotPanel.hidden = false;

  try {
    await loadAnalysisData();
    enterModelingMode();
  } catch (error) {
    window.PhaseFinderApp.setStatus(error.message, true);
    window.PhaseFinderApp.setStatusBar("Selected data loading failed.", true);
    window.PhaseFinderApp.updateProgress(100, "Loading Selected FCS Data", error.message);
    window.PhaseFinderApp.hideProgress(1400);
  }
}

metadataPanelToggle.addEventListener("click", toggleMetadataPanel);
analysisStartButton.addEventListener("click", startAnalysis);
analysisCollapsedPlotButton.addEventListener("click", startAnalysis);
document.addEventListener("fcs-selection-change", () => {
  refreshAnalysisAfterMetadataChange({ redrawIfNoMissing: false }).catch((error) => {
    window.PhaseFinderApp.setStatus(error.message, true);
    window.PhaseFinderApp.setStatusBar("Selected data loading failed.", true);
    window.PhaseFinderApp.updateProgress(100, "Loading Added FCS Data", error.message);
    window.PhaseFinderApp.hideProgress(1400);
  });
});

document.addEventListener("fcs-channel-change", () => {
  prepareSelectedChannelForPlotting().catch((error) => {
    window.PhaseFinderApp.setStatus(error.message, true);
    window.PhaseFinderApp.setStatusBar("Selected channel data loading failed.", true);
    window.PhaseFinderApp.updateProgress(100, "Loading Selected FCS Data", error.message);
    window.PhaseFinderApp.hideProgress(1400);
    if (typeof updateStartButtonState === "function") {
      updateStartButtonState();
    }
  });
});
