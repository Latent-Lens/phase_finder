const fileInput = document.querySelector("#fileInput");
const dropZone = document.querySelector("#dropZone");
const dropZoneTitle = document.querySelector("#dropZoneTitle");
const dropZoneHint = document.querySelector("#dropZoneHint");
const statusEl = document.querySelector("#status");
const statusBar = document.querySelector("#statusBar");
const statusBarMessage = document.querySelector("#statusBarMessage");
const dnaAreaSelect = document.querySelector("#dnaAreaSelect");
const fileTable = document.querySelector("#fileTable");
const startAnalysisButton = document.querySelector("#startAnalysisButton");
const progressOverlay = document.querySelector("#progressOverlay");
const progressFill = document.querySelector("#progressFill");
const progressLabel = document.querySelector("#progressLabel");
const progressPercent = document.querySelector("#progressPercent");
const progressDetail = document.querySelector("#progressDetail");

let parsedFiles = [];

// Metadata table columns. `name` is the read-only filename; the rest are the
// editable annotation fields. All are sortable; filterable columns get a
// per-header dropdown of their unique values.
const TABLE_COLUMNS = [
  { field: "name", label: "Filename", editable: false, filterable: false },
  { field: "strain", label: "Strain", editable: true, filterable: true },
  { field: "replicate", label: "Replicate", editable: true, filterable: true },
  { field: "nocodazoleArrest", label: "Nocodazole Arrest", editable: true, filterable: true },
  { field: "timepoint", label: "Timepoint", editable: true, filterable: true },
];

// IDs of files whose row checkbox is ticked. Persists across re-renders so
// sorting/filtering don't drop the selection.
const selectedFileIds = new Set();
// field -> Set of values ticked in that column's filter dropdown. A row passes
// the column when the set is empty (no filter) or contains the row's value.
const columnFilters = {};
let sortState = { field: null, direction: "asc" };
// Field whose filter dropdown is currently open, or null. Kept in state so the
// menu stays open across table re-renders triggered by ticking its checkboxes.
let openFilterField = null;

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
  statusBarMessage.textContent = message;
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
  dnaAreaSelect.innerHTML = "";
  dnaAreaSelect.add(new Option("", "", true, true));
  dnaAreaSelect.disabled = true;

  selectedFileIds.clear();
  Object.keys(columnFilters).forEach((field) => delete columnFilters[field]);
  sortState = { field: null, direction: "asc" };
  openFilterField = null;
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

function columnValue(entry, field) {
  return field === "name" ? entry.name : entry.annotations[field];
}

// Unique, sorted, non-blank values for a column across all loaded files.
// Used to build the header filter dropdowns.
function uniqueColumnValues(field) {
  const seen = new Set();
  const values = [];

  parsedFiles.forEach((entry) => {
    const value = columnValue(entry, field).trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      values.push(value);
    }
  });

  values.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  return values;
}

function populateSingleSelect(select, columns, placeholder, suggestedValue = "") {
  select.innerHTML = "";
  select.disabled = columns.length === 0;
  select.add(new Option(placeholder, "", true, true));

  columns.forEach((column) => {
    select.add(new Option(column, column, column === suggestedValue, column === suggestedValue));
  });
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

function updateStartButtonState() {
  startAnalysisButton.disabled = !dnaAreaSelect.value || selectedFileIds.size === 0;
}

// Tell the plot (plotting.js) that the checked-sample set changed so it can
// add/remove curves live. Custom name avoids the native "selectionchange".
function notifySelectionChanged() {
  document.dispatchEvent(new CustomEvent("fcs-selection-change"));
}

// DEBUG: force a known DNA-content area channel after FCS metadata has been read
// so the analysis flow can be exercised without manual clicking. Remove for
// production.
function applyDebugChannelDefaults() {
  selectIfOptionExists(dnaAreaSelect, "GFP/FITC-A");
}


// Files shown in the table: those matching every active column filter,
// ordered by the current sort. Used for both rendering and "select all".
function displayedFiles() {
  const filtered = parsedFiles.filter((entry) =>
    TABLE_COLUMNS.every((column) => {
      const selected = columnFilters[column.field];
      return !selected || selected.size === 0 || selected.has(columnValue(entry, column.field).trim());
    }),
  );

  if (!sortState.field) {
    return filtered;
  }

  const { field, direction } = sortState;
  const factor = direction === "desc" ? -1 : 1;
  return [...filtered].sort((a, b) => {
    let comparison;
    if (field === "timepoint") {
      comparison = timepointSortValue(columnValue(a, field)) - timepointSortValue(columnValue(b, field));
      if (Number.isNaN(comparison)) {
        comparison = 0;
      }
    } else {
      comparison = columnValue(a, field).localeCompare(columnValue(b, field), undefined, {
        numeric: true,
        sensitivity: "base",
      });
    }
    return comparison * factor;
  });
}

function sortIndicator(field) {
  const active = sortState.field === field;
  const ascClass = active && sortState.direction === "asc" ? "sort-arrow active" : "sort-arrow";
  const descClass = active && sortState.direction === "desc" ? "sort-arrow active" : "sort-arrow";
  return `<span class="sort-indicator"><span class="${ascClass}">▲</span><span class="${descClass}">▼</span></span>`;
}

function filterControl(column) {
  const selected = columnFilters[column.field] || new Set();
  const summary = [...selected].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  );
  const isOpen = openFilterField === column.field;

  const options = uniqueColumnValues(column.field)
    .map(
      (value) => `
            <label class="checkbox-option">
              <input type="checkbox" class="th-filter-option" data-filter-field="${column.field}" value="${escapeHtml(value)}"${selected.has(value) ? " checked" : ""} />
              <span title="${escapeHtml(value)}">${escapeHtml(value)}</span>
            </label>`,
    )
    .join("");

  return `
          <div class="th-filter multi-select">
            <button type="button" class="th-filter-toggle multi-select-toggle" data-filter-field="${column.field}" aria-expanded="${isOpen}" title="Filter by ${escapeHtml(column.label)}">${escapeHtml(summary.join(", "))}</button>
            <div class="multi-select-menu" data-filter-menu="${column.field}"${isOpen ? "" : " hidden"}>${options}</div>
          </div>`;
}

function headerCell(column) {
  const filter = column.filterable ? filterControl(column) : "";

  return `
        <th>
          <div class="th-inner">
            <button type="button" class="th-sort" data-sort-field="${column.field}">${escapeHtml(column.label)}${sortIndicator(column.field)}</button>
            ${filter}
          </div>
        </th>`;
}

// Filename shown to the user, without the .fcs extension (entry.name keeps it
// for dedup/matching).
function displayName(name) {
  return name.replace(/\.fcs$/i, "");
}

function renderFileTable() {
  if (!parsedFiles.length) {
    fileTable.innerHTML = '<p class="empty-note">Upload FCS files to initialize the table.</p>';
    return;
  }

  const cell = (entry, field) => {
    const value = entry.annotations[field];
    return `<td><input data-file-id="${entry.id}" data-field="${field}" type="text" size="${annotationInputSize(value)}" value="${escapeHtml(value)}" /></td>`;
  };

  const visibleFiles = displayedFiles();

  // A row filtered out of the display is automatically deselected, so only
  // files that are both visible and checked stay selected (and get analyzed).
  const visibleIds = new Set(visibleFiles.map((entry) => entry.id));
  let prunedSelection = false;
  selectedFileIds.forEach((id) => {
    if (!visibleIds.has(id)) {
      selectedFileIds.delete(id);
      prunedSelection = true;
    }
  });
  if (prunedSelection) {
    notifySelectionChanged();
  }

  const headers = TABLE_COLUMNS.map(headerCell).join("");

  const body = visibleFiles.length
    ? visibleFiles
        .map(
          (entry) => `
        <tr>
          <td class="checkbox-col"><input type="checkbox" class="row-select" data-file-id="${entry.id}"${selectedFileIds.has(entry.id) ? " checked" : ""} /></td>
          <td class="filename-cell" title="${escapeHtml(entry.name)}">${escapeHtml(displayName(entry.name))}</td>
          ${cell(entry, "strain")}
          ${cell(entry, "replicate")}
          ${cell(entry, "nocodazoleArrest")}
          ${cell(entry, "timepoint")}
        </tr>
      `,
        )
        .join("")
    : `<tr><td class="empty-note" colspan="${TABLE_COLUMNS.length + 1}">No files match the current filters.</td></tr>`;

  fileTable.innerHTML = `
    <table class="file-table">
      <thead>
        <tr>
          <th class="checkbox-col"><input type="checkbox" id="selectAllFiles" title="Select all displayed files" /></th>
          ${headers}
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  `;

  updateSelectAllCheckbox();
  updateStartButtonState();
}

// Reflect how many displayed files are selected: checked when all are,
// indeterminate when only some are. The checked attribute can't express the
// indeterminate state in HTML, so it's set here after each render.
function updateSelectAllCheckbox() {
  const checkbox = document.querySelector("#selectAllFiles");
  if (!checkbox) {
    return;
  }

  const displayed = displayedFiles();
  const selectedCount = displayed.reduce(
    (count, entry) => count + (selectedFileIds.has(entry.id) ? 1 : 0),
    0,
  );
  checkbox.checked = displayed.length > 0 && selectedCount === displayed.length;
  checkbox.indeterminate = selectedCount > 0 && selectedCount < displayed.length;
}

function handleTableChange(event) {
  const target = event.target;

  if (target.classList.contains("th-filter-option")) {
    const field = target.dataset.filterField;
    const selected = columnFilters[field] || (columnFilters[field] = new Set());
    if (target.checked) {
      selected.add(target.value);
    } else {
      selected.delete(target.value);
    }
    renderFileTable();
    return;
  }

  if (target.id === "selectAllFiles") {
    displayedFiles().forEach((entry) => {
      if (target.checked) {
        selectedFileIds.add(entry.id);
      } else {
        selectedFileIds.delete(entry.id);
      }
    });
    renderFileTable();
    updateStartButtonState();
    notifySelectionChanged();
    return;
  }

  if (target.classList.contains("row-select")) {
    const fileId = target.dataset.fileId;
    if (target.checked) {
      selectedFileIds.add(fileId);
    } else {
      selectedFileIds.delete(fileId);
    }
    updateSelectAllCheckbox();
    updateStartButtonState();
    notifySelectionChanged();
  }
}

function handleTableClick(event) {
  const filterToggle = event.target.closest(".th-filter-toggle");
  if (filterToggle) {
    const field = filterToggle.dataset.filterField;
    openFilterField = openFilterField === field ? null : field;
    renderFileTable();
    return;
  }

  const sortButton = event.target.closest(".th-sort");
  if (!sortButton) {
    return;
  }

  const field = sortButton.dataset.sortField;
  if (sortState.field === field) {
    sortState.direction = sortState.direction === "asc" ? "desc" : "asc";
  } else {
    sortState = { field, direction: "asc" };
  }
  renderFileTable();
}

// Close an open filter dropdown when clicking anywhere outside a filter control.
function handleDocumentClick(event) {
  if (openFilterField === null || event.target.closest(".th-filter")) {
    return;
  }
  openFilterField = null;
  renderFileTable();
}

// Width (in characters) for an annotation input so each column hugs its
// content; clamped so empty cells stay clickable and long values stay readable.
function annotationInputSize(value) {
  return Math.min(28, Math.max(4, String(value).length + 1));
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
    replicate: "",
    nocodazoleArrest: "",
    timepoint: "",
  };

  // Sample token, e.g. "76aN t55": strain digits + replicate letter +
  // nocodazole-arrest letter, then "t" + time since release.
  const coreMatch = basename.match(/(?:^|[_\s-])(\d+)([A-Za-z])([A-Za-z])\s+t(\d+)(?:[_\s.-]|$)/i);
  if (coreMatch) {
    guess.strain = coreMatch[1];
    guess.replicate = coreMatch[2];
    guess.nocodazoleArrest = coreMatch[3];
    guess.timepoint = coreMatch[4];
    return guess;
  }

  // Fallbacks for filenames that don't follow the strain/replicate/arrest token.
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

    const replicateCompare = a.annotations.replicate.localeCompare(b.annotations.replicate, undefined, {
      numeric: true,
      sensitivity: "base",
    });
    if (replicateCompare !== 0) {
      return replicateCompare;
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
      selectedFileIds.add(entry.id);
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
  input.size = annotationInputSize(input.value);
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
dnaAreaSelect.addEventListener("change", updateStartButtonState);
dropZone.addEventListener("click", () => fileInput.click());
fileTable.addEventListener("input", updateAnnotation);
fileTable.addEventListener("change", handleTableChange);
fileTable.addEventListener("click", handleTableClick);
document.addEventListener("click", handleDocumentClick);

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
  };
}

window.FlowPlotterApp = {
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
setStatus("No file(s) loaded.");
setStatusBar("Ready: Load FCS files by dragging them to the drop zone or using the file selector above.");
 
