const fileInput = document.querySelector("#fileInput");
const dropZone = document.querySelector("#dropZone");
const collapsedUploadTarget = document.querySelector("#collapsedUploadTarget");
const dropZoneTitle = document.querySelector("#dropZoneTitle");
const dropZoneHint = document.querySelector("#dropZoneHint");
const statusEl = document.querySelector("#status");
const statusBar = document.querySelector("#statusBar");
const statusBarMessage = document.querySelector("#statusBarMessage");
const dnaAreaSelect = document.querySelector("#dnaAreaSelect");
const collapsedDnaAreaSelect = document.querySelector("#collapsedDnaAreaSelect");
const fileTable = document.querySelector("#fileTable");
const startAnalysisButton = document.querySelector("#startAnalysisButton");
const collapsedPlotButton = document.querySelector("#collapsedPlotButton");
const progressOverlay = document.querySelector("#progressOverlay");
const progressFill = document.querySelector("#progressFill");
const progressLabel = document.querySelector("#progressLabel");
const progressPercent = document.querySelector("#progressPercent");
const progressDetail = document.querySelector("#progressDetail");
const appShell = document.querySelector(".app");
const sidebar = document.querySelector("#sidebar");
const sidebarContent = document.querySelector("#sidebarContent");
const sidebarToggle = document.querySelector("#sidebarToggle");
const sidebarToggleIcon = document.querySelector("#sidebarToggleIcon");

const SIDEBAR_CLOSE_ICON = "./assets/img/sidepanel_close.svg";
const SIDEBAR_OPEN_ICON = "./assets/img/sidepanel_open.svg";
const SIDEBAR_TRANSITION_MS = 220;

let parsedFiles = [];

/*

Purpose:
	Reads only an FCS file's HEADER and TEXT segments to build a loaded-file
	entry (id, name, file, summary, guessed annotations) without loading event
	data.

Input:
	file [File]: the FCS File object

Output:
	entry [Promise<Object>]: resolves to a loaded-file entry

*/
async function readFcsHeader(file) {
  const headerBuffer = await file.slice(0, 58).arrayBuffer();
  const header = window.FCSParser.parseHeader(headerBuffer);

  if (header.textEnd < header.textBegin) {
    throw new Error("FCS header has an invalid TEXT segment range.");
  }

  const textBuffer = await file.slice(header.textBegin, header.textEnd + 1).arrayBuffer();
  const summary = window.FCSParser.parseFCSHeaderFromSegments(headerBuffer, textBuffer);

  return {
    id: createId(),
    name: file.name,
    file,
    summary,
    annotations: guessAnnotationsFromFilename(file.name),
  };
}

/*

Purpose:
	Loads metadata for dropped/selected FCS files: reads each file's header,
	skips duplicates, records failures, sorts and re-renders, and reports the
	outcome through the status/progress UI. Newly loaded files are checked by
	default until plotting has started; after that, they start unchecked.

Input:
	files [FileList|Array<File>]: the files to load

Output:
	(none) [Promise<void>]: loads metadata and updates the UI

*/
function hasInitializedPlot() {
  return typeof plotChannels !== "undefined" && Boolean(plotChannels);
}

async function refreshDownstreamAfterFileLoad() {
  if (typeof refreshAnalysisAfterMetadataChange !== "function") {
    return { refreshed: false, loadedRows: 0 };
  }
  return refreshAnalysisAfterMetadataChange();
}

async function loadFiles(files) {
  const selectedFiles = Array.from(files || []);
  if (!selectedFiles.length) {
    return;
  }

  let loaded = 0;
  const loadedEntries = [];
  const failures = [];
  const duplicates = [];
  const existingNames = new Set(parsedFiles.map((entry) => entry.name));
  const queuedNames = new Set();
  showProgress("Loading FCS Metadata");
  updateProgress(0, "Loading FCS Metadata", `Preparing ${selectedFiles.length} file(s)...`);
  await nextFrame();

  for (const [index, file] of selectedFiles.entries()) {
    const current = index + 1;
    const startPercent = (index / selectedFiles.length) * 100;
    setStatusBar("Working: Loading FCS Metadata");
    updateProgress(startPercent, "Loading FCS Metadata", `Reading metadata for file ${current} of ${selectedFiles.length}`, file.name);
    await nextFrame();

    if (existingNames.has(file.name) || queuedNames.has(file.name)) {
      duplicates.push(file.name);
      updateProgress((current / selectedFiles.length) * 100, "Loading FCS Metadata", `Skipped duplicate file ${current} of ${selectedFiles.length}`, file.name);
      await nextFrame();
      continue;
    }

    try {
      const entry = await readFcsHeader(file);
      parsedFiles.push(entry);
      if (!hasInitializedPlot()) {
        selectedFileIds.add(entry.id);
      }
      queuedNames.add(file.name);
      loadedEntries.push(entry);
      loaded += 1;
    } catch (error) {
      failures.push(`${file.name}: ${error.message}`);
    }

    updateProgress((current / selectedFiles.length) * 100, "Loading FCS Metadata", `Finished file ${current} of ${selectedFiles.length}`, file.name);
    await nextFrame();
  }

  sortParsedFiles();
  updateViews();
  updateDropZoneText();

  let downstreamRefresh = { refreshed: false, loadedRows: 0 };
  if (loaded) {
    try {
      downstreamRefresh = await refreshDownstreamAfterFileLoad();
    } catch (error) {
      setStatus(`Read metadata from ${loaded} file(s), but the existing plot could not be updated: ${error.message}`, true);
      setStatusBar("Existing plot refresh failed.", true);
      updateProgress(100, "Loading Added FCS Data", error.message);
      hideProgress(1400);
      return;
    }
  }

  const finalProgressLabel = downstreamRefresh.refreshed ? "Loading Added FCS Data" : "Loading FCS Metadata";
  const downstreamMessage = downstreamRefresh.refreshed
    ? ` Existing plot updated${downstreamRefresh.loadedRows ? ` with ${downstreamRefresh.loadedRows} added file(s)` : ""}.`
    : "";

  const duplicateMessage = duplicates.length
    ? ` Rejected duplicate file${duplicates.length === 1 ? "" : "s"}: ${duplicates.join(", ")}.`
    : "";

  if (loaded && (failures.length || duplicates.length)) {
    const failureMessage = failures.length ? ` ${failures.join(" ")}` : "";
    setStatus(`Read metadata from ${loaded} file(s).${downstreamMessage}${duplicateMessage}${failureMessage}`, true);
    setStatusBar(`Finished with ${failures.length + duplicates.length} issue(s).`, true);
    updateProgress(100, finalProgressLabel, downstreamRefresh.refreshed ? "Existing plot updated, with file-load issue(s)." : `Finished with ${failures.length + duplicates.length} issue(s).`);
    hideProgress(900);
  } else if (loaded) {
    setStatus(`Read metadata from ${loaded} file(s).${downstreamMessage} Verify extracted strain, timepoint, and replicate data before plotting.`);
    setStatusBar(downstreamRefresh.refreshed ? "Existing plot updated with added FCS data." : `Finished reading metadata from ${loaded} file(s).`);
    updateProgress(100, finalProgressLabel, downstreamRefresh.refreshed ? "Existing plot updated with added FCS data." : `Finished reading metadata from ${loaded} file(s).`);
    hideProgress(600);
  } else if (duplicates.length) {
    setStatus(`No new files loaded.${duplicateMessage}`, true);
    setStatusBar("Duplicate FCS file rejected.", true);
    updateProgress(100, "Loading FCS Metadata", "Duplicate FCS file rejected.");
    hideProgress(1200);
  } else {
    setStatus(failures.join(" "), true);
    setStatusBar("No metadata could be read.", true);
    updateProgress(100, "Loading FCS Metadata", "No metadata could be read.");
    hideProgress(1200);
  }

  if (loadedEntries.length && hasInitializedPlot() && typeof preloadAnalysisRowsInBackground === "function") {
    preloadAnalysisRowsInBackground(loadedEntries).catch((error) => {
      setStatusBar(`Background FCS data load failed: ${error.message}`, true);
    });
  }
}

/*

Purpose:
	Writes an edited annotation input back to its file entry and resizes the
	input to fit. Ignores events from non-annotation inputs.

Input:
	event [Event]: an input event from the file table

Output:
	(none) [void]: updates the file's annotation in place

*/
function updateAnnotation(event) {
  const input = event.target.closest("input[data-file-id][data-field]");
  if (!input) {
    return;
  }

  const entry = parsedFiles.find((file) => file.id === input.dataset.fileId);
  if (!entry) {
    return;
  }

  entry.annotations[input.dataset.field] = input.value;
  input.size = annotationInputSize(input.value);
}

/*

Purpose:
	Escapes HTML-special characters in a value so it can be safely interpolated
	into table/markup strings.

Input:
	value [any]: the value to escape (coerced to a string)

Output:
	escaped [string]: the HTML-escaped string

*/
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

window.PhaseFinderTooltips.applyStatic();

function notifyChannelChanged() {
  document.dispatchEvent(new CustomEvent("fcs-channel-change"));
}

fileInput.addEventListener("change", () => loadFiles(fileInput.files));
sidebarToggle.addEventListener("click", toggleSidebar);
dnaAreaSelect.addEventListener("change", () => {
  collapsedDnaAreaSelect.value = dnaAreaSelect.value;
  updateStartButtonState();
  notifyChannelChanged();
});

collapsedDnaAreaSelect.addEventListener("change", () => {
  dnaAreaSelect.value = collapsedDnaAreaSelect.value;
  updateStartButtonState();
  notifyChannelChanged();
});
const uploadTargets = [dropZone, collapsedUploadTarget].filter(Boolean);

function openFileBrowser() {
  fileInput.click();
}

function setUploadTargetDragging(target, isDragging) {
  target.classList.toggle("dragging", isDragging);
}

uploadTargets.forEach((target) => {
  target.addEventListener("click", openFileBrowser);

  ["dragenter", "dragover"].forEach((eventName) => {
    target.addEventListener(eventName, (event) => {
      event.preventDefault();
      setUploadTargetDragging(target, true);
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    target.addEventListener(eventName, (event) => {
      event.preventDefault();
      setUploadTargetDragging(target, false);
    });
  });

  target.addEventListener("drop", (event) => {
    loadFiles(event.dataTransfer.files);
  });
});

// Restart button and the logo both reload the page, clearing all in-memory
// state (loaded files, selections, plot, fits) for a clean start.
document.querySelector("#restartButton").addEventListener("click", () => window.location.reload());
document.querySelector("#siteLogo").addEventListener("click", () => window.location.reload());
fileTable.addEventListener("input", updateAnnotation);
fileTable.addEventListener("change", handleTableChange);
fileTable.addEventListener("click", handleTableClick);
document.addEventListener("click", handleDocumentClick);

/*

Purpose:
	Returns the currently selected analysis channels (the DNA-content area
	channel chosen in the sidebar).

Input:
	(none)

Output:
	channels [Object]: { dnaArea }

*/
function getSelectedChannels() {
  return {
    dnaArea: dnaAreaSelect.value,
  };
}

window.PhaseFinderApp = {
  getParsedFiles: () => parsedFiles,
  getSelectedFiles: () => parsedFiles.filter((entry) => selectedFileIds.has(entry.id)),
  getSelectedChannels,
  setStatus,
  setStatusBar,
  showProgress,
  updateProgress,
  hideProgress,
  nextFrame,
};

clearChannelControls();
renderFileTable();
updateDropZoneText();
setStatus("No files loaded.");
setStatusBar("Ready: Load FCS files by dragging them to the drop zone or using the file selector above.");
 
