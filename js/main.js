const fileInput = document.querySelector("#fileInput");
const dropZone = document.querySelector("#dropZone");
const dropZoneTitle = document.querySelector("#dropZoneTitle");
const dropZoneHint = document.querySelector("#dropZoneHint");
const statusEl = document.querySelector("#status");
const statusBar = document.querySelector("#statusBar");
const dnaAreaSelect = document.querySelector("#dnaAreaSelect");
const heightSelect = document.querySelector("#heightSelect");
const widthSelect = document.querySelector("#widthSelect");
const debrisMultiSelect = document.querySelector("#debrisMultiSelect");
const debrisToggle = document.querySelector("#debrisToggle");
const debrisChannels = document.querySelector("#debrisChannels");
const timeQcSelect = document.querySelector("#timeQcSelect");
const fileTable = document.querySelector("#fileTable");
const startAnalysisButton = document.querySelector("#startAnalysisButton");
const progressOverlay = document.querySelector("#progressOverlay");
const progressFill = document.querySelector("#progressFill");
const progressLabel = document.querySelector("#progressLabel");
const progressPercent = document.querySelector("#progressPercent");
const progressDetail = document.querySelector("#progressDetail");

let parsedFiles = [];

function createId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `file-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function setStatusBar(message, isError = false) {
  statusBar.textContent = message;
  statusBar.classList.toggle("error", isError);
}

function updateDropZoneText() {
  const count = parsedFiles.length;
  if (!count) {
    dropZoneTitle.textContent = "Drop FCS files here";
    dropZoneHint.textContent = "or choose files from disk";
    return;
  }

  dropZoneTitle.textContent = `${count.toLocaleString()} FCS file${count === 1 ? "" : "s"} loaded`;
  dropZoneHint.textContent = "Drop or click to add more files";
}

function showProgress(label = "Loading FCS Metadata") {
  progressOverlay.hidden = false;
  progressOverlay.setAttribute("aria-busy", "true");
  updateProgress(0, label, "Preparing files...");
}

function updateProgress(percent, label = "Loading FCS Metadata", detail = "", filename = "") {
  const boundedPercent = Math.max(0, Math.min(100, percent));
  progressFill.style.width = `${boundedPercent}%`;
  progressLabel.textContent = label;
  progressPercent.textContent = `${Math.round(boundedPercent)}%`;
  progressDetail.innerHTML = filename
    ? `${escapeHtml(detail)}<br><strong>${escapeHtml(filename)}</strong>`
    : escapeHtml(detail);
}

function hideProgress(delay = 500) {
  window.setTimeout(() => {
    progressOverlay.hidden = true;
    progressOverlay.setAttribute("aria-busy", "false");
  }, delay);
}

function nextFrame() {
  return new Promise((resolve) => window.requestAnimationFrame(resolve));
}

function clearChannelControls() {
  [dnaAreaSelect, heightSelect, widthSelect, timeQcSelect].forEach((select) => {
    select.innerHTML = "";
    select.add(new Option("", "", true, true));
    select.disabled = true;
  });
  debrisChannels.innerHTML = "";
  debrisChannels.hidden = true;
  debrisToggle.disabled = true;
  debrisToggle.setAttribute("aria-expanded", "false");
  debrisToggle.textContent = "";
}

function uniqueColumns() {
  const seen = new Set();
  const columns = [];

  parsedFiles.forEach((entry) => {
    entry.summary.columns.forEach((column) => {
      if (!seen.has(column)) {
        seen.add(column);
        columns.push(column);
      }
    });
  });

  return columns;
}

function populateSingleSelect(select, columns, placeholder, suggestedValue = "") {
  select.innerHTML = "";
  select.disabled = columns.length === 0;
  select.add(new Option(placeholder, "", true, true));

  columns.forEach((column) => {
    select.add(new Option(column, column, column === suggestedValue, column === suggestedValue));
  });
}

function populateDebrisChannels(columns) {
  debrisChannels.innerHTML = "";
  debrisToggle.disabled = columns.length === 0;
  debrisToggle.textContent = "";
  debrisToggle.setAttribute("aria-expanded", "false");
  debrisChannels.hidden = true;

  if (!columns.length) {
    return;
  }

  columns.forEach((column) => {
    const id = `debris-${column.replace(/[^a-z0-9_-]+/gi, "-")}`;
    const label = document.createElement("label");
    label.className = "checkbox-option";
    label.htmlFor = id;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = id;
    checkbox.value = column;

    const text = document.createElement("span");
    text.textContent = column;

    label.append(checkbox, text);
    debrisChannels.append(label);
  });
}

function selectedDebrisChannels() {
  return Array.from(debrisChannels.querySelectorAll('input[type="checkbox"]:checked')).map(
    (input) => input.value,
  );
}

function updateDebrisToggleLabel() {
  const selected = selectedDebrisChannels();
  debrisToggle.textContent = selected.join(", ");
  debrisToggle.title = selected.join(", ");
}

function toggleDebrisMenu() {
  if (debrisToggle.disabled) {
    return;
  }

  const willOpen = debrisChannels.hidden;
  debrisChannels.hidden = !willOpen;
  debrisToggle.setAttribute("aria-expanded", String(willOpen));
}

function closeDebrisMenu(event) {
  if (debrisMultiSelect.contains(event.target)) {
    return;
  }

  debrisChannels.hidden = true;
  debrisToggle.setAttribute("aria-expanded", "false");
}

function suggestColumn(columns, patterns) {
  const upperPatterns = patterns.map((pattern) => pattern.toUpperCase());
  return columns.find((column) => {
    const normalized = column.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    return upperPatterns.some((pattern) => normalized.includes(pattern));
  }) || "";
}

function populateChannelControls() {
  const columns = uniqueColumns();

  populateSingleSelect(
    dnaAreaSelect,
    columns,
    "Choose DNA-content area channel",
    suggestColumn(columns, ["DAPI_A", "DNA_A", "AREA", "_A"]),
  );
  populateSingleSelect(
    heightSelect,
    columns,
    "Choose matching height channel",
    suggestColumn(columns, ["DAPI_H", "DNA_H", "HEIGHT", "_H"]),
  );
  populateSingleSelect(
    widthSelect,
    columns,
    "Choose matching width channel",
    suggestColumn(columns, ["DAPI_W", "DNA_W", "WIDTH", "_W"]),
  );
  populateSingleSelect(
    timeQcSelect,
    columns,
    "None selected",
    suggestColumn(columns, ["TIME", "QC"]),
  );
  populateDebrisChannels(columns);
}

function channelVariants(areaChannel) {
  if (!areaChannel) {
    return { height: "", width: "" };
  }

  const suffixPatterns = [/-A$/i, /_A$/i, / Area$/i, / AREA$/i];
  for (const pattern of suffixPatterns) {
    if (pattern.test(areaChannel)) {
      return {
        height: areaChannel.replace(pattern, (match) => match.replace(/A/i, "H")),
        width: areaChannel.replace(pattern, (match) => match.replace(/A/i, "W")),
      };
    }
  }

  return {
    height: `${areaChannel}-H`,
    width: `${areaChannel}-W`,
  };
}

function selectIfOptionExists(select, value) {
  if (!value) {
    return false;
  }

  const option = Array.from(select.options).find((candidate) => candidate.value === value);
  if (!option) {
    return false;
  }

  select.value = value;
  return true;
}

function autoSetMatchingHeightWidth() {
  const variants = channelVariants(dnaAreaSelect.value);
  selectIfOptionExists(heightSelect, variants.height);
  selectIfOptionExists(widthSelect, variants.width);
  updateStartButtonState();
}

function updateStartButtonState() {
  const ready = Boolean(dnaAreaSelect.value && heightSelect.value && widthSelect.value);
  startAnalysisButton.disabled = !ready;
}

// DEBUG: force a known channel selection after FCS metadata has been read so the
// analysis flow can be exercised without manual clicking. Remove for production.
function applyDebugChannelDefaults() {
  selectIfOptionExists(dnaAreaSelect, "GFP/FITC-A");
  selectIfOptionExists(heightSelect, "GFP/FITC-H");
  selectIfOptionExists(widthSelect, "GFP/FITC-W");
  selectIfOptionExists(timeQcSelect, "HDR-T");

  ["FSC-A", "SSC-A"].forEach((channel) => {
    const checkbox = debrisChannels.querySelector(
      `input[type="checkbox"][value="${CSS.escape(channel)}"]`,
    );
    if (checkbox) {
      checkbox.checked = true;
    }
  });
  updateDebrisToggleLabel();
}


function renderFileTable() {
  if (!parsedFiles.length) {
    fileTable.innerHTML = '<p class="empty-note">Upload FCS files to initialize the table.</p>';
    return;
  }

  const rows = parsedFiles
    .map(
      (entry) => `
        <tr>
          <td title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</td>
          <td><input data-file-id="${entry.id}" data-field="strain" type="text" value="${escapeHtml(entry.annotations.strain)}" /></td>
          <td><input data-file-id="${entry.id}" data-field="timepoint" type="text" value="${escapeHtml(entry.annotations.timepoint)}" /></td>
          <td><input data-file-id="${entry.id}" data-field="replicate" type="text" value="${escapeHtml(entry.annotations.replicate)}" /></td>
        </tr>
      `,
    )
    .join("");

  fileTable.innerHTML = `
    <table class="file-table">
      <thead>
        <tr>
          <th>Filename</th>
          <th>Strain</th>
          <th>Timepoint</th>
          <th>Replicate</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}


function updateViews() {
  renderFileTable();
  populateChannelControls();
  applyDebugChannelDefaults();
  updateStartButtonState();
}

function guessAnnotationsFromFilename(filename) {
  const basename = filename.replace(/\.[^.]+$/, "");
  const guess = {
    strain: "",
    timepoint: "",
    replicate: "",
  };

  const strainTimepointMatch = basename.match(/(?:^|[_\s-])([^_\s-]+)\s+t(\d+)(?:[_\s-]|$)/i);
  if (strainTimepointMatch) {
    guess.strain = strainTimepointMatch[1];
    guess.timepoint = strainTimepointMatch[2];
  }

  const replicateMatch = basename.match(/__([A-Za-z]+\d+)(?:\.|_|\s|-|$)/) || basename.match(/(?:^|[_\s-])([A-Za-z]+\d+)(?:\.|_|\s|-|$)/);
  if (replicateMatch) {
    guess.replicate = replicateMatch[1];
  }

  return guess;
}

function timepointSortValue(value) {
  const numeric = Number.parseFloat(value);
  return Number.isFinite(numeric) ? numeric : Number.POSITIVE_INFINITY;
}

function sortParsedFiles() {
  parsedFiles.sort((a, b) => {
    const strainCompare = a.annotations.strain.localeCompare(b.annotations.strain, undefined, {
      numeric: true,
      sensitivity: "base",
    });
    if (strainCompare !== 0) {
      return strainCompare;
    }

    const timepointCompare = timepointSortValue(a.annotations.timepoint) - timepointSortValue(b.annotations.timepoint);
    if (timepointCompare !== 0) {
      return timepointCompare;
    }

    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

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

async function loadFiles(files) {
  const selectedFiles = Array.from(files || []);
  if (!selectedFiles.length) {
    return;
  }

  let loaded = 0;
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
      queuedNames.add(file.name);
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

  const duplicateMessage = duplicates.length
    ? ` Rejected duplicate file${duplicates.length === 1 ? "" : "s"}: ${duplicates.join(", ")}.`
    : "";

  if (loaded && (failures.length || duplicates.length)) {
    const failureMessage = failures.length ? ` ${failures.join(" ")}` : "";
    setStatus(`Read metadata from ${loaded} file(s).${duplicateMessage}${failureMessage}`, true);
    setStatusBar(`Finished with ${failures.length + duplicates.length} issue(s).`, true);
    updateProgress(100, "Loading FCS Metadata", `Finished with ${failures.length + duplicates.length} issue(s).`);
    hideProgress(900);
  } else if (loaded) {
    setStatus(`Read metadata from ${loaded} file(s). Fill in strain, timepoint, and replicate data.`);
    setStatusBar(`Finished reading metadata from ${loaded} file(s).`);
    updateProgress(100, "Loading FCS Metadata", `Finished reading metadata from ${loaded} file(s).`);
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
}

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
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

fileInput.addEventListener("change", () => loadFiles(fileInput.files));
dnaAreaSelect.addEventListener("change", autoSetMatchingHeightWidth);
heightSelect.addEventListener("change", updateStartButtonState);
widthSelect.addEventListener("change", updateStartButtonState);
dropZone.addEventListener("click", () => fileInput.click());
fileTable.addEventListener("input", updateAnnotation);
debrisToggle.addEventListener("click", toggleDebrisMenu);
debrisChannels.addEventListener("change", updateDebrisToggleLabel);
document.addEventListener("click", closeDebrisMenu);

["dragenter", "dragover"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
  });
});

dropZone.addEventListener("drop", (event) => {
  loadFiles(event.dataTransfer.files);
});

function getSelectedChannels() {
  return {
    dnaArea: dnaAreaSelect.value,
    dnaHeight: heightSelect.value,
    dnaWidth: widthSelect.value,
    timeChannel: timeQcSelect.value,
    debris: selectedDebrisChannels(),
  };
}

window.FlowPlotterApp = {
  getParsedFiles: () => parsedFiles,
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
setStatus("No file loaded.");
setStatusBar("Ready: Load FCS files by dragging them to the drop zone or using the file selector above.");
 
