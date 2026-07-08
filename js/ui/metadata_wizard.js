// Filename-splitting metadata wizard and template persistence. This file lets
// users derive structured metadata columns from FCS filenames using delimiter,
// fixed-width, or regular-expression split steps. It renders the split-step
// editor, column editor, live preview, and modal buttons used to apply or reset
// filename-derived metadata. It stores the current template in localStorage and
// can auto-apply it to later loaded files when compatible. It rebuilds the
// shared metadata frame through js/data_structs helpers and relies on table
// rendering for the final visible update.

const METADATA_TEMPLATE_STORAGE_KEY = "phasefinder_filename_metadata_template";
let metadata_wizard_seen_this_session = false;
let filename_metadata_template = load_filename_metadata_template();

function load_filename_metadata_template() {
  try {
    const raw = window.localStorage?.getItem(METADATA_TEMPLATE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.columns)) return null;
    return normalize_filename_metadata_template(parsed);
  } catch (_error) {
    return null;
  }
}

function normalize_filename_metadata_template(template) {
  if (!template) return null;
  if (Array.isArray(template.steps)) return template;
  const step = template.mode === "fixed"
    ? { type: "fixed", breaks: template.breaks || [] }
    : { type: "delimiter", delimiter: template.delimiter || "_" };
  return { ...template, steps: [step] };
}

function save_filename_metadata_template(template) {
  filename_metadata_template = normalize_filename_metadata_template(template);
  try {
    window.localStorage?.setItem(METADATA_TEMPLATE_STORAGE_KEY, JSON.stringify(filename_metadata_template));
  } catch (_error) {
    // localStorage can be unavailable in private/sandboxed contexts.
  }
}

function default_metadata_split_steps() {
  return [{ type: "delimiter", delimiter: "_" }];
}

function parse_fixed_breaks(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((candidate) => Number.parseInt(candidate, 10))
    .filter((candidate) => Number.isFinite(candidate) && candidate > 0)
    .sort((a, b) => a - b)
    .filter((candidate, index, arr) => index === 0 || candidate !== arr[index - 1]);
}

function collect_metadata_split_steps() {
  if (!metadata_split_steps) return default_metadata_split_steps();
  const steps = [...metadata_split_steps.querySelectorAll(".metadata_split_step")].map((row) => {
    const type = row.querySelector(".metadata_split_type")?.value || "delimiter";
    const label = row.querySelector(".metadata_step_column_name")?.value || "";
    const hide = row.querySelector(".metadata_step_hide")?.checked || false;
    if (type === "fixed") {
      return {
        type,
        breaks: parse_fixed_breaks(row.querySelector(".metadata_step_breaks")?.value || ""),
        label,
        hide,
      };
    }
    if (type === "regex") {
      return {
        type,
        pattern: row.querySelector(".metadata_step_regex")?.value || "",
        label,
        hide,
      };
    }
    return {
      type: "delimiter",
      delimiter: row.querySelector(".metadata_step_delimiter")?.value || "",
      label,
      hide,
    };
  });
  return steps.length ? steps : default_metadata_split_steps();
}

function current_metadata_wizard_spec() {
  return { steps: collect_metadata_split_steps() };
}

function metadata_split_step_controls(step) {
  if (step.type === "fixed") {
    return `
      <div class="metadata_split_step_controls">
        <input class="metadata_step_breaks" type="text" value="${escape_html((step.breaks || []).join(", "))}" placeholder="Break position">
        <input class="metadata_step_width" type="number" min="1" step="1" placeholder="Width">
        <button class="metadata_step_set_width" type="button">Set</button>
      </div>`;
  }
  if (step.type === "regex") {
    return `
      <div class="metadata_split_step_controls">
        <input class="metadata_step_regex metadata_regex_input" type="text" value="${escape_html(step.pattern || "")}" placeholder="Regex separator or capture, e.g. (\\d{2,3})aN">
      </div>`;
  }
  return `
    <div class="metadata_split_step_controls">
      <input class="metadata_step_delimiter metadata_full_step_input" type="text" value="${escape_html(step.delimiter ?? "_")}" placeholder="Delimiter, e.g. _">
    </div>`;
}

function render_metadata_split_steps(steps = default_metadata_split_steps()) {
  if (!metadata_split_steps) return;
  const saved_columns = filename_metadata_template?.columns || [];
  const saved_by_source = new Map(saved_columns.map((column) => [column.source_index, column]));
  const saved_leaves = filename_metadata_template?.leaves || [];
  metadata_split_steps.innerHTML = steps.map((step, index) => {
    const has_step_label = Object.prototype.hasOwnProperty.call(step, "label");
    const has_step_hide = Object.prototype.hasOwnProperty.call(step, "hide");
    const column_label = has_step_label
      ? step.label
      : saved_leaves[index]?.label || saved_by_source.get(index)?.label || `Column ${index + 1}`;
    const is_hidden = has_step_hide ? step.hide : saved_leaves[index]?.include === false;
    return `
    <div class="metadata_split_step" data-step-index="${index}">
      <span class="metadata_split_step_label">Split ${index + 1}</span>
      <select class="metadata_split_type" aria-label="Split step ${index + 1} type">
        <option value="delimiter"${step.type === "delimiter" ? " selected" : ""}>Delimiter</option>
        <option value="fixed"${step.type === "fixed" ? " selected" : ""}>Fixed width</option>
        <option value="regex"${step.type === "regex" ? " selected" : ""}>Regex</option>
      </select>
      ${metadata_split_step_controls(step)}
      <div class="metadata_branch_leaf">
        <input class="metadata_step_column_name" type="text" value="${escape_html(column_label)}" placeholder="Column header">
        <label class="metadata_leaf_hide">
          <input class="metadata_step_hide" type="checkbox" ${is_hidden ? "checked" : ""}>
          Hide
        </label>
      </div>
      <button class="metadata_split_step_remove" type="button" ${steps.length === 1 ? "disabled" : ""}>Remove</button>
    </div>`;
  }).join("");
}

function split_text_binary_step(text, step) {
  if (step.type === "fixed") {
    const split_at = (step.breaks || []).find((value) => value > 0 && value < text.length);
    if (!split_at) return { left: text, right: "" };
    return { left: text.slice(0, split_at), right: text.slice(split_at) };
  }
  if (step.type === "regex") {
    if (!step.pattern) return { left: text, right: "" };
    try {
      const match = new RegExp(step.pattern).exec(text);
      if (!match) return { left: text, right: "" };
      const capture = match.slice(1).find((value) => value !== undefined);
      return {
        left: capture !== undefined ? capture : text.slice(0, match.index),
        right: text.slice(match.index + match[0].length),
      };
    } catch (_error) {
      return { left: text, right: "" };
    }
  }
  if (!step.delimiter) return { left: text, right: "" };
  const index = text.indexOf(step.delimiter);
  if (index < 0) return { left: text, right: "" };
  return {
    left: text.slice(0, index),
    right: text.slice(index + step.delimiter.length),
  };
}

function split_filename_metadata(name, spec) {
  const base = display_name(name);
  const template = normalize_filename_metadata_template(spec) || { steps: default_metadata_split_steps() };
  const parts = [];
  let remainder = base;
  template.steps.forEach((step) => {
    const split = split_text_binary_step(remainder, step);
    parts.push(split.left);
    remainder = split.right;
  });
  parts.push(remainder);
  return parts;
}

function metadata_part_count(spec) {
  const template = normalize_filename_metadata_template(spec) || { steps: default_metadata_split_steps() };
  return Math.max(1, template.steps.length + 1);
}

function current_column_editor_state() {
  const step_states = metadata_split_steps
    ? [...metadata_split_steps.querySelectorAll(".metadata_split_step")].map((row) => ({
        include: !(row.querySelector(".metadata_step_hide")?.checked ?? false),
        label: row.querySelector(".metadata_step_column_name")?.value || "",
      }))
    : [];
  const remainder_row = metadata_column_editor?.querySelector(".metadata_column_row");
  const remainder_state = remainder_row ? [{
    include: !(remainder_row.querySelector(".metadata_leaf_hide input")?.checked ?? false),
    label: remainder_row.querySelector(".metadata_column_name")?.value || "",
  }] : [];
  return [...step_states, ...remainder_state];
}

function render_metadata_column_editor(part_count) {
  if (!metadata_column_editor) return;
  const existing = current_column_editor_state();
  const saved_columns = filename_metadata_template?.columns || [];
  const saved_by_source = new Map(saved_columns.map((column) => [column.source_index, column]));
  const saved_leaves = filename_metadata_template?.leaves || [];
  const has_saved_columns = saved_columns.length > 0;
  const index = Math.max(0, part_count - 1);
  const previous = existing[index] || saved_leaves[index] || saved_by_source.get(index) || {};
  const include = existing[index] ? previous.include !== false : (saved_leaves[index] ? saved_leaves[index].include !== false : (has_saved_columns ? saved_by_source.has(index) : true));
  const label = previous.label || "Remaining text";
  metadata_column_editor.innerHTML = `
    <div class="metadata_column_row metadata_remainder_leaf" data-column-index="${index}">
      <span class="metadata_remainder_label">Remainder</span>
      <input class="metadata_column_name" type="text" value="${escape_html(label)}" placeholder="Column header">
      <label class="metadata_leaf_hide">
        <input type="checkbox" ${include ? "" : "checked"}>
        Hide
      </label>
    </div>`;
}

function metadata_wizard_columns_from_editor() {
  const used = new Set(["id", "name"]);
  return current_column_editor_state()
    .map((column, index) => ({ ...column, source_index: index }))
    .filter((column) => column.include)
    .map((column, index) => {
      const label = column.label.trim() || `Column ${index + 1}`;
      return {
        source_index: column.source_index,
        label,
        field: metadata_field_from_label(label, used),
        editable: true,
        filterable: true,
      };
    });
}

function render_metadata_wizard_preview() {
  if (!metadata_preview || !file_table_frame) return;
  const spec = current_metadata_wizard_spec();
  const part_count = metadata_part_count(spec);
  const remainder_row = metadata_column_editor?.querySelector(".metadata_column_row");
  const remainder_index = Number.parseInt(remainder_row?.dataset.columnIndex || "", 10);
  if (!remainder_row || remainder_index !== part_count - 1) render_metadata_column_editor(part_count);
  const columns = metadata_wizard_columns_from_editor();
  const names = file_table_frame.col("name").slice(0, 20);

  const header = ["Filename", ...columns.map((column) => column.label)]
    .map((label) => `<th>${escape_html(label)}</th>`)
    .join("");
  const body = names.map((name) => {
    const parts = split_filename_metadata(name, spec);
    return `
      <tr>
        <td>${escape_html(display_name(name))}</td>
        ${columns.map((column) => `<td>${escape_html(parts[column.source_index] ?? "")}</td>`).join("")}
      </tr>`;
  }).join("");

  metadata_preview.innerHTML = `
    <table class="metadata_preview_table">
      <thead><tr>${header}</tr></thead>
      <tbody>${body || `<tr><td colspan="${columns.length + 1}">No files loaded.</td></tr>`}</tbody>
    </table>`;
}

function fill_metadata_wizard_from_template() {
  const template = normalize_filename_metadata_template(filename_metadata_template);
  render_metadata_split_steps(template?.steps?.length ? template.steps : default_metadata_split_steps());
}

function add_metadata_split_step() {
  render_metadata_split_steps([...collect_metadata_split_steps(), { type: "delimiter", delimiter: "_" }]);
  render_metadata_wizard_preview();
}

function open_metadata_wizard() {
  if (!metadata_wizard_modal || !file_table_frame || file_table_frame.length === 0) return;
  metadata_wizard_seen_this_session = true;
  if (metadata_column_editor) metadata_column_editor.innerHTML = "";
  fill_metadata_wizard_from_template();
  render_metadata_wizard_preview();
  metadata_wizard_modal.hidden = false;
  metadata_wizard_apply?.focus();
}

function close_metadata_wizard() {
  if (metadata_wizard_modal) metadata_wizard_modal.hidden = true;
}

function set_fixed_width_breaks_from_width(row) {
  const width = Number.parseInt(row?.querySelector(".metadata_step_width")?.value || "", 10);
  if (!Number.isFinite(width) || width <= 0) return;
  const breaks_input = row?.querySelector(".metadata_step_breaks");
  if (breaks_input) breaks_input.value = String(width);
  render_metadata_wizard_preview();
}

function handle_metadata_split_step_input(event) {
  const row = event.target.closest(".metadata_split_step");
  if (!row) return;
  if (event.target.classList.contains("metadata_split_type")) {
    const steps = collect_metadata_split_steps();
    const index = Number(row.dataset.stepIndex);
    const previous = steps[index] || {};
    steps[index] = {
      type: event.target.value,
      delimiter: "_",
      breaks: [],
      pattern: "",
      label: previous.label || "",
      hide: previous.hide || false,
    };
    render_metadata_split_steps(steps);
  }
  render_metadata_wizard_preview();
}

function handle_metadata_split_step_click(event) {
  const remove_button = event.target.closest(".metadata_split_step_remove");
  if (remove_button) {
    const row = remove_button.closest(".metadata_split_step");
    const index = Number(row.dataset.stepIndex);
    const steps = collect_metadata_split_steps();
    if (steps.length > 1) {
      steps.splice(index, 1);
      render_metadata_split_steps(steps);
      render_metadata_wizard_preview();
    }
    return;
  }

  const width_button = event.target.closest(".metadata_step_set_width");
  if (width_button) {
    set_fixed_width_breaks_from_width(width_button.closest(".metadata_split_step"));
  }
}

function apply_filename_metadata_columns(spec, columns, { render = true, preserve_existing = false } = {}) {
  if (!file_table_frame) return;

  const normalized_columns = columns.map((column) => ({
    field: column.field,
    label: column.label,
    source_index: column.source_index,
    editable: true,
    filterable: true,
    headerEditable: false,
    source: "filename",
  }));

  set_metadata_table_columns(normalized_columns);

  const rows = frame_to_rows(file_table_frame);
  const stat_columns = file_table_frame.columns.filter((field) => field.includes(":"));
  const col_data = {
    id: rows.map((row) => row.id),
    name: rows.map((row) => row.name),
  };

  normalized_columns.forEach((column) => {
    col_data[column.field] = rows.map((row) => {
      const existing = row[column.field];
      if (preserve_existing && existing != null && String(existing) !== "") return existing;
      return split_filename_metadata(row.name, spec)[column.source_index] ?? "";
    });
  });
  stat_columns.forEach((field) => {
    col_data[field] = rows.map((row) => row[field] ?? null);
  });

  file_table_frame = new PhaseFinderFrame(col_data, ["id", "name", ...normalized_columns.map((column) => column.field), ...stat_columns]);
  sync_file_annotations();
  if (render) render_file_table();
}

function can_auto_apply_filename_metadata_template() {
  if (!filename_metadata_template?.columns?.length || !file_table_frame) return false;
  const current = current_metadata_columns();
  if (current.length === 0) return true;
  if (current.length !== filename_metadata_template.columns.length) return false;
  return current.every((column, index) => column.field === filename_metadata_template.columns[index].field);
}

function apply_current_filename_metadata_template({ render = true, preserve_existing = true } = {}) {
  if (!filename_metadata_template?.columns?.length || !file_table_frame) {
    sync_file_annotations();
    return;
  }
  apply_filename_metadata_columns(filename_metadata_template, filename_metadata_template.columns, { render, preserve_existing });
}

function apply_metadata_wizard() {
  if (!file_table_frame) return;
  const spec = current_metadata_wizard_spec();
  const columns = metadata_wizard_columns_from_editor();
  const template = { ...spec, columns, leaves: current_column_editor_state() };
  save_filename_metadata_template(template);
  apply_filename_metadata_columns(spec, columns);
  close_metadata_wizard();
  set_status_bar(`Filename metadata columns applied (${columns.length} column${columns.length === 1 ? "" : "s"}).`);
}

function reset_filename_metadata_columns() {
  if (!file_table_frame) return;
  save_filename_metadata_template({ steps: default_metadata_split_steps(), columns: [] });
  set_metadata_table_columns([]);
  const rows = frame_to_rows(file_table_frame);
  const stat_columns = file_table_frame.columns.filter((field) => field.includes(":"));
  const col_data = {
    id: rows.map((row) => row.id),
    name: rows.map((row) => row.name),
  };
  stat_columns.forEach((field) => {
    col_data[field] = rows.map((row) => row[field] ?? null);
  });
  file_table_frame = new PhaseFinderFrame(col_data, ["id", "name", ...stat_columns]);
  sync_file_annotations();
  render_file_table();
  close_metadata_wizard();
  set_status_bar("Metadata table reset to Filename only.");
}

function schedule_metadata_wizard_after_file_load() {
  if (metadata_wizard_seen_this_session || TABLE_COLUMNS.length > 1) return;
  window.setTimeout(() => open_metadata_wizard(), 750);
}
