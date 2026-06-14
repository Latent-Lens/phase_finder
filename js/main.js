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
const appShell = document.querySelector(".app");
const sidebar = document.querySelector("#sidebar");
const sidebarContent = document.querySelector("#sidebarContent");
const sidebarToggle = document.querySelector("#sidebarToggle");
const sidebarToggleIcon = document.querySelector("#sidebarToggleIcon");

const SIDEBAR_CLOSE_ICON = "./assets/img/panel-left-close.svg";
const SIDEBAR_OPEN_ICON = "./assets/img/panel-left-open.svg";
const SIDEBAR_TRANSITION_MS = 220;

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

/*

Purpose:
	Generates a unique id for a loaded file, using crypto.randomUUID when
	available and a timestamp+random fallback otherwise.

Input:
	(none)

Output:
	id [string]: a unique file identifier

*/
function createId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `file-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/*

Purpose:
	Sets the sidebar status text and toggles its error styling.

Input:
	message [string]:  the status text
	isError [boolean]: true to apply error styling (default false)

Output:
	(none) [void]: updates the #status element

*/
function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

/*

Purpose:
	Sets the footer status-bar text and toggles its error styling.

Input:
	message [string]:  the status-bar text
	isError [boolean]: true to apply error styling (default false)

Output:
	(none) [void]: updates the status bar

*/
function setStatusBar(message, isError = false) {
  statusBarMessage.textContent = message;
  statusBar.classList.toggle("error", isError);
}

/*

Purpose:
	Updates the drop zone's title and hint to reflect how many files are loaded.

Input:
	(none)

Output:
	(none) [void]: updates the drop zone text

*/
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

/*

Purpose:
	Reveals the progress overlay and resets it to 0%.

Input:
	label [string]: the heading shown in the overlay (default "Loading FCS Metadata")

Output:
	(none) [void]: shows the progress overlay

*/
function showProgress(label = "Loading FCS Metadata") {
  progressOverlay.hidden = false;
  progressOverlay.setAttribute("aria-busy", "true");
  updateProgress(0, label, "Preparing files...");
}

/*

Purpose:
	Updates the progress overlay's bar width, percentage, heading, and detail
	line (optionally with a bold filename).

Input:
	percent [number]:  completion from 0 to 100 (clamped)
	label [string]:    the heading (default "Loading FCS Metadata")
	detail [string]:   the detail line (default "")
	filename [string]: optional filename shown in bold (default "")

Output:
	(none) [void]: updates the progress overlay

*/
function updateProgress(percent, label = "Loading FCS Metadata", detail = "", filename = "") {
  const boundedPercent = Math.max(0, Math.min(100, percent));
  progressFill.style.width = `${boundedPercent}%`;
  progressLabel.textContent = label;
  progressPercent.textContent = `${Math.round(boundedPercent)}%`;
  progressDetail.innerHTML = filename
    ? `${escapeHtml(detail)}<br><strong>${escapeHtml(filename)}</strong>`
    : escapeHtml(detail);
}

/*

Purpose:
	Hides the progress overlay after a short delay.

Input:
	delay [number]: milliseconds to wait before hiding (default 500)

Output:
	(none) [void]: hides the progress overlay after the delay

*/
function hideProgress(delay = 500) {
  window.setTimeout(() => {
    progressOverlay.hidden = true;
    progressOverlay.setAttribute("aria-busy", "false");
  }, delay);
}

/*

Purpose:
	Returns a Promise that resolves on the next animation frame, used to yield
	so the progress UI can paint between steps.

Input:
	(none)

Output:
	frame [Promise<void>]: resolves on the next animation frame

*/
function nextFrame() {
  return new Promise((resolve) => window.requestAnimationFrame(resolve));
}

/*

Purpose:
	Resets the channel selector and all table state (selection, filters, sort,
	open filter menu) back to their empty defaults.

Input:
	(none)

Output:
	(none) [void]: clears the channel selector and table state

*/
function clearChannelControls() {
  dnaAreaSelect.innerHTML = "";
  dnaAreaSelect.add(new Option("", "", true, true));
  dnaAreaSelect.disabled = true;

  selectedFileIds.clear();
  Object.keys(columnFilters).forEach((field) => delete columnFilters[field]);
  sortState = { field: null, direction: "asc" };
  openFilterField = null;
}

/*

Purpose:
	Collects the distinct FCS parameter labels across all loaded files
	(first-seen order) to populate the channel selector.

Input:
	(none)

Output:
	columns [Array<string>]: the distinct parameter labels

*/
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

/*

Purpose:
	Returns a table cell's value for a file: the filename for the "name" column,
	otherwise the matching editable annotation.

Input:
	entry [Object]: a loaded file
	field [string]: the column field key

Output:
	value [string]: the cell value

*/
function columnValue(entry, field) {
  return field === "name" ? entry.name : entry.annotations[field];
}

/*

Purpose:
	Returns the distinct, sorted, non-blank values of a column across all loaded
	files. Used to build the header filter dropdowns.

Input:
	field [string]: the column field key

Output:
	values [Array<string>]: the sorted distinct values

*/
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

/*

Purpose:
	Fills a <select> with a placeholder option plus one option per column,
	optionally pre-selecting a suggested value.

Input:
	select [HTMLSelectElement]: the select to populate
	columns [Array<string>]:    the option values/labels
	placeholder [string]:       the leading empty option's label
	suggestedValue [string]:    value to pre-select, if present (default "")

Output:
	(none) [void]: replaces the select's options

*/
function populateSingleSelect(select, columns, placeholder, suggestedValue = "") {
  select.innerHTML = "";
  select.disabled = columns.length === 0;
  select.add(new Option(placeholder, "", true, true));

  columns.forEach((column) => {
    select.add(new Option(column, column, column === suggestedValue, column === suggestedValue));
  });
}

/*

Purpose:
	Picks the first column whose normalized name contains any of the given
	patterns — used to guess a default DNA-content channel.

Input:
	columns [Array<string>]:  the candidate column labels
	patterns [Array<string>]: substrings to look for (case-insensitive)

Output:
	match [string]: the first matching column, or "" if none match

*/
function suggestColumn(columns, patterns) {
  const upperPatterns = patterns.map((pattern) => pattern.toUpperCase());
  return columns.find((column) => {
    const normalized = column.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    return upperPatterns.some((pattern) => normalized.includes(pattern));
  }) || "";
}

/*

Purpose:
	Populates the DNA-content area channel selector from the loaded files'
	parameters, suggesting a likely DNA/area channel.

Input:
	(none)

Output:
	(none) [void]: fills the channel selector

*/
function populateChannelControls() {
  const columns = uniqueColumns();

  populateSingleSelect(
    dnaAreaSelect,
    columns,
    "Choose DNA-content area channel",
    suggestColumn(columns, ["DAPI_A", "DNA_A", "AREA", "_A"]),
  );
}

/*

Purpose:
	Selects a value in a <select> only if a matching option exists, and reports
	whether it did.

Input:
	select [HTMLSelectElement]: the select element
	value [string]:             the value to select

Output:
	selected [boolean]: true if the value existed and was selected

*/
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

/*

Purpose:
	Enables the Start Analysis button only when a DNA channel is chosen and at
	least one row is checked.

Input:
	(none)

Output:
	(none) [void]: sets the button's disabled state

*/
function updateStartButtonState() {
  startAnalysisButton.disabled = !dnaAreaSelect.value || selectedFileIds.size === 0;
}

/*

Purpose:
	Dispatches the custom "fcs-selection-change" event so the plot (plotting.js)
	can add/remove curves when the checked set changes. A custom name avoids the
	native "selectionchange".

Input:
	(none)

Output:
	(none) [void]: dispatches a document event

*/
function notifySelectionChanged() {
  document.dispatchEvent(new CustomEvent("fcs-selection-change"));
}

/*

Purpose:
	Collapses or expands the left sidebar and asks plot code to recalculate after
	the grid column transition changes the workspace width.

Input:
	isCollapsed [boolean]: true to collapse the sidebar, false to expand it

Output:
	(none) [void]: updates sidebar state and layout-dependent controls

*/
function setSidebarCollapsed(isCollapsed) {
  appShell.classList.toggle("sidebar-collapsed", isCollapsed);
  sidebar.classList.toggle("is-collapsed", isCollapsed);
  sidebarContent.setAttribute("aria-hidden", String(isCollapsed));
  if ("inert" in sidebarContent) sidebarContent.inert = isCollapsed;

  sidebarToggle.setAttribute("aria-expanded", String(!isCollapsed));
  sidebarToggle.title = isCollapsed ? "Expand sidebar" : "Collapse sidebar";
  sidebarToggle.setAttribute("aria-label", isCollapsed ? "Expand sidebar" : "Collapse sidebar");
  sidebarToggleIcon.src = isCollapsed ? SIDEBAR_OPEN_ICON : SIDEBAR_CLOSE_ICON;

  const notifyLayoutChanged = () => window.dispatchEvent(new Event("resize"));
  window.requestAnimationFrame(notifyLayoutChanged);
  window.setTimeout(notifyLayoutChanged, SIDEBAR_TRANSITION_MS);
}

/*

Purpose:
	Click handler for the sidebar edge button.

Input:
	(none)

Output:
	(none) [void]: toggles the sidebar collapsed state

*/
function toggleSidebar() {
  setSidebarCollapsed(!appShell.classList.contains("sidebar-collapsed"));
}

/*

Purpose:
	DEBUG helper — auto-selects the "GFP/FITC-A" channel when present so the
	analysis flow can be exercised without manual clicking. Remove for production.

Input:
	(none)

Output:
	(none) [void]: may select a default channel

*/
function applyDebugChannelDefaults() {
  selectIfOptionExists(dnaAreaSelect, "GFP/FITC-A");
}


/*

Purpose:
	Returns the files shown in the table: those passing every active column
	filter, ordered by the current sort. Used for both rendering and "select all".

Input:
	(none)

Output:
	files [Array<Object>]: the filtered and sorted loaded files

*/
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

/*

Purpose:
	Builds the up/down sort-arrow HTML for a column header, highlighting the
	active sort direction.

Input:
	field [string]: the column field key

Output:
	html [string]: the sort-indicator markup

*/
function sortIndicator(field) {
  const active = sortState.field === field;
  const ascClass = active && sortState.direction === "asc" ? "sort-arrow active" : "sort-arrow";
  const descClass = active && sortState.direction === "desc" ? "sort-arrow active" : "sort-arrow";
  return `<span class="sort-indicator"><span class="${ascClass}" data-sort-dir="asc" title="Sort ascending">▲</span><span class="${descClass}" data-sort-dir="desc" title="Sort descending">▼</span></span>`;
}

/*

Purpose:
	Builds the per-column filter dropdown markup — a toggle button plus a
	checkbox menu of the column's unique values — reflecting the current
	selections and open/closed state.

Input:
	column [Object]: a TABLE_COLUMNS entry

Output:
	html [string]: the filter control markup

*/
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

/*

Purpose:
	Builds one <th> for a column: a sortable label and, for filterable columns,
	the filter dropdown.

Input:
	column [Object]: a TABLE_COLUMNS entry

Output:
	html [string]: the header cell markup

*/
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

/*

Purpose:
	Returns the filename shown to the user, without the .fcs extension. The full
	entry.name is kept for dedup/matching.

Input:
	name [string]: a sample filename

Output:
	label [string]: the filename without a trailing ".fcs"

*/
function displayName(name) {
  return name.replace(/\.fcs$/i, "");
}

/*

Purpose:
	Renders the metadata table from the loaded files: header cells with
	sort/filter controls and one row per displayed file with a select checkbox
	and editable annotation inputs. Also prunes any selection that is no longer
	visible and refreshes the select-all and Start button state.

Input:
	(none)

Output:
	(none) [void]: rebuilds the #fileTable markup

*/
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

/*

Purpose:
	Sets the header "select all" checkbox to checked when every displayed row is
	selected and indeterminate when only some are. The indeterminate state can't
	be expressed in HTML, so it's set here after each render.

Input:
	(none)

Output:
	(none) [void]: updates the select-all checkbox state

*/
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

/*

Purpose:
	Delegated change handler for the table: applies filter-checkbox toggles, the
	select-all checkbox, and per-row selection, re-rendering and notifying the
	plot as needed.

Input:
	event [Event]: a change event from the file table

Output:
	(none) [void]: updates selection/filter state and re-renders

*/
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

/*

Purpose:
	Delegated click handler for the table: opens/closes a column's filter
	dropdown, or toggles the sort column and direction.

Input:
	event [Event]: a click event from the file table

Output:
	(none) [void]: updates sort/filter state and re-renders

*/
function handleTableClick(event) {
  const filterToggle = event.target.closest(".th-filter-toggle");
  if (filterToggle) {
    const field = filterToggle.dataset.filterField;
    openFilterField = openFilterField === field ? null : field;
    renderFileTable();
    return;
  }

  // Clicking a specific arrow sorts that column in that direction (up = asc,
  // down = desc).
  const sortArrow = event.target.closest(".sort-arrow");
  if (sortArrow) {
    const arrowButton = sortArrow.closest(".th-sort");
    if (arrowButton) {
      sortState = { field: arrowButton.dataset.sortField, direction: sortArrow.dataset.sortDir };
      renderFileTable();
    }
    return;
  }

  // Clicking the label (not an arrow) toggles the direction.
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

/*

Purpose:
	Closes an open filter dropdown when the user clicks anywhere outside a filter
	control.

Input:
	event [Event]: a document click event

Output:
	(none) [void]: may close the open filter menu and re-render

*/
function handleDocumentClick(event) {
  if (openFilterField === null || event.target.closest(".th-filter")) {
    return;
  }
  openFilterField = null;
  renderFileTable();
}

/*

Purpose:
	Computes the character width for an annotation input so each cell hugs its
	content, clamped so empty cells stay clickable and long values stay readable.

Input:
	value [string]: the cell's current value

Output:
	size [number]: the input's size attribute (4–28)

*/
function annotationInputSize(value) {
  return Math.min(28, Math.max(4, String(value).length + 1));
}


/*

Purpose:
	Re-renders the table, refreshes the channel selector, applies debug defaults,
	and updates the Start button. Run after files load.

Input:
	(none)

Output:
	(none) [void]: refreshes the table and channel controls

*/
function updateViews() {
  renderFileTable();
  populateChannelControls();
  applyDebugChannelDefaults();
  updateStartButtonState();
}

/*

Purpose:
	Guesses initial strain/replicate/nocodazole/timepoint annotations by
	pattern-matching the filename, with fallbacks for names that don't follow
	the main strain/replicate/arrest token format.

Input:
	filename [string]: the FCS file name

Output:
	guess [Object]: { strain, replicate, nocodazoleArrest, timepoint }

*/
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

/*

Purpose:
	Converts a timepoint annotation to a number for sorting; non-numeric values
	sort last.

Input:
	value [string]: the timepoint annotation

Output:
	sortValue [number]: the numeric value, or +Infinity if not numeric

*/
function timepointSortValue(value) {
  const numeric = Number.parseFloat(value);
  return Number.isFinite(numeric) ? numeric : Number.POSITIVE_INFINITY;
}

/*

Purpose:
	Sorts the loaded files in place by strain, then replicate, then timepoint,
	then filename (natural, case-insensitive).

Input:
	(none)

Output:
	(none) [void]: sorts parsedFiles in place

*/
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
	default.

Input:
	files [FileList|Array<File>]: the files to load

Output:
	(none) [Promise<void>]: loads metadata and updates the UI

*/
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

fileInput.addEventListener("change", () => loadFiles(fileInput.files));
sidebarToggle.addEventListener("click", toggleSidebar);
dnaAreaSelect.addEventListener("change", updateStartButtonState);
dropZone.addEventListener("click", () => fileInput.click());

// Restart button and the logo both reload the page, clearing all in-memory
// state (loaded files, selections, plot, fits) for a clean start.
document.querySelector("#restartButton").addEventListener("click", () => window.location.reload());
document.querySelector("#siteLogo").addEventListener("click", () => window.location.reload());
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
setStatus("No file(s) loaded.");
setStatusBar("Ready: Load FCS files by dragging them to the drop zone or using the file selector above.");
 
