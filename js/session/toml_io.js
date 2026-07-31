// PhaseFinder session TOML serializer and parser. This module converts the
// in-memory session object into a human-readable TOML document and parses that
// document back into plain JavaScript data. It handles the section structure
// used for files, metadata columns, metadata rows, table filters, plot settings,
// UI layout, filename templates, and stats plans. It implements only the TOML
// subset the app writes, including arrays, inline tables, booleans, numbers,
// strings, and nested section paths. File restoration, OPFS caching, reconnect
// behavior, and UI application live in the other session modules.

// ── TOML serializer ─────────────────────────────────────────────────────────

function toml_str(v) {
  return '"' + String(v)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t') + '"';
}

export function serialize_session(s) {
  const L = [];
  const p = (...x) => L.push(...x);

  p('# PhaseFinder Session File', `# Created: ${s.session.created}`, '');

  p('[session]', `created = ${toml_str(s.session.created)}`);
  if (s.session.logical_id) p(`logical_id = ${toml_str(s.session.logical_id)}`);
  if (s.session.schema_version != null) p(`schema_version = ${Number(s.session.schema_version)}`);
  if (s.session.application) p(`application = ${toml_str(s.session.application)}`);
  if (s.session.application_version) p(`application_version = ${toml_str(s.session.application_version)}`);
  if (s.session.source_commit) p(`source_commit = ${toml_str(s.session.source_commit)}`);
  p('');

  p('[files]', '# Re-drop or auto-load these files to restore event data and plotted curves.');
  p(`names = [${s.files.names.map(toml_str).join(', ')}]`, '');

  // Per-file records: metadata + OPFS working-copy paths used to auto-restore
  // files on reload (see the OPFS section below). No absolute OS paths.
  (s.files.records || []).forEach((r) => {
    p('[[files.records]]',
      `id = ${toml_str(r.id)}`,
      `original_name = ${toml_str(r.original_name)}`,
      `relative_path = ${toml_str(r.relative_path)}`,
      `size = ${r.size}`,
      `last_modified = ${r.last_modified}`,
      `mime_type = ${toml_str(r.mime_type || 'application/octet-stream')}`,
      `opfs_path = ${toml_str(r.opfs_path)}`,
      `status = ${toml_str(r.status || 'available')}`);
    if (r.digest_algorithm) p(`digest_algorithm = ${toml_str(r.digest_algorithm)}`);
    if (r.digest) p(`digest = ${toml_str(r.digest)}`);
    p('');
  });

  p('[metadata]');
  if (s.metadata.columns.length) {
    p('columns = [');
    s.metadata.columns.forEach((c, i) => {
      const comma = i < s.metadata.columns.length - 1 ? ',' : '';
      const extras = [];
      if (c.headerEditable != null) extras.push(`header_editable = ${Boolean(c.headerEditable)}`);
      if (c.source) extras.push(`source = ${toml_str(c.source)}`);
      p(`  {field = ${toml_str(c.field)}, label = ${toml_str(c.label)}${extras.length ? ', ' + extras.join(', ') : ''}}${comma}`);
    });
    p(']');
  } else {
    p('columns = []');
  }
  p('');
  s.metadata.rows.forEach((row) => {
    p('[[metadata.rows]]', `name = ${toml_str(row.name)}`);
    s.metadata.columns.forEach((c) => { p(`${c.field} = ${toml_str(row[c.field] ?? '')}`); });
    p('');
  });

  if (s.metadata_template?.steps?.length) {
    s.metadata_template.steps.forEach((step) => {
      p('[[metadata_template.steps]]', `type = ${toml_str(step.type)}`);
      if (step.type === 'delimiter') p(`delimiter = ${toml_str(step.delimiter ?? '_')}`);
      if (step.type === 'fixed')     p(`breaks = [${(step.breaks || []).join(', ')}]`);
      if (step.type === 'regex')     p(`pattern = ${toml_str(step.pattern ?? '')}`);
      if (step.label != null)        p(`label = ${toml_str(step.label)}`);
      if (step.hide != null)         p(`hide = ${Boolean(step.hide)}`);
      p('');
    });
  }
  if (s.metadata_template?.columns?.length) {
    s.metadata_template.columns.forEach((c) => {
      p('[[metadata_template.columns]]',
        `field = ${toml_str(c.field)}`,
        `label = ${toml_str(c.label)}`,
        `source_index = ${c.source_index}`,
        '');
    });
  }

  p('[table]');
  p(`selected_files = [${s.table.selected_files.map(toml_str).join(', ')}]`);
  p(`sort_field = ${toml_str(s.table.sort_field || '')}`);
  p(`sort_direction = ${toml_str(s.table.sort_direction || 'asc')}`);
  p('');

  p('[table.filters]');
  for (const [field, values] of Object.entries(s.table.filters)) {
    p(`${field} = [${values.map(toml_str).join(', ')}]`);
  }
  p('');

  p('[plot]',
    `channel = ${toml_str(s.plot.channel)}`,
    `color_by = ${toml_str(s.plot.color_by)}`,
    `display_mode = ${toml_str(s.plot.display_mode || 'curve')}`,
    `bins = ${s.plot.bins}`);
  // TOML has no null: emit a manual axis override only when it is actually set,
  // so a missing key parses back to "auto" for that bound.
  for (const key of ['axis_x_min', 'axis_x_max', 'axis_y_min', 'axis_y_max', 'analysis_x_min', 'analysis_x_max']) {
    if (Number.isFinite(s.plot[key])) p(`${key} = ${s.plot[key]}`);
  }
  p(`remove_debris = ${s.plot.remove_debris}`,
    `remove_doublets = ${s.plot.remove_doublets}`,
    `show_peak_threshold = ${s.plot.show_peak_threshold}`,
    '');

  p('[ui]',
    `sidebar_collapsed = ${s.ui.sidebar_collapsed}`,
    `sidebar_width_px = ${s.ui.sidebar_width_px}`,
    `plot_panel_collapsed = ${s.ui.plot_panel_collapsed}`,
    `plot_panel_height_px = ${s.ui.plot_panel_height_px}`,
    `metadata_panel_collapsed = ${s.ui.metadata_panel_collapsed}`,
    `metadata_panel_height_px = ${s.ui.metadata_panel_height_px}`);

  if (s.stats_plan?.length) {
    p('');
    s.stats_plan.forEach((entry) => {
      p('[[stats_plan.entries]]',
        `channel = ${toml_str(entry.channel)}`,
        `metrics = [${entry.metrics.map(toml_str).join(', ')}]`,
        '');
    });
  }

  // Structural QC's per-DNA-channel saturation-ceiling overrides, so a
  // disabled/replaced ceiling survives a reload instead of silently reverting
  // to each file's own (possibly wrong) $PnR. Same flat-key convention as
  // [time_qc] below -- an override of null is omitted by
  // get_structural_qc_session_config(), never written as a literal null.
  if (s.structural_qc) {
    p('', '[structural_qc]');
    Object.entries(s.structural_qc).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      if (Array.isArray(value)) p(`${key} = [${value.map(toml_str).join(', ')}]`);
      else if (typeof value === 'string') p(`${key} = ${toml_str(value)}`);
      else p(`${key} = ${value}`);
    });
    p('');
  }

  // Which Time QC method ran and with what settings, so a QC result can be
  // reproduced (the two methods do not return the same mask). Written as flat
  // keys; every value is a string, number or boolean.
  if (s.time_qc) {
    p('', '[time_qc]');
    Object.entries(s.time_qc).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      if (Array.isArray(value)) p(`${key} = [${value.map(toml_str).join(', ')}]`);
      else if (typeof value === 'string') p(`${key} = ${toml_str(value)}`);
      else p(`${key} = ${value}`);
    });
    p('');
  }

  // Cell-cycle modeling config: applied QC filters + one flat record per plotted
  // sample with accepted peak regions (recompute-on-reload; no fit results).
  if (s.modeling) {
    p('', '[modeling]', `qc_filters = [${(s.modeling.qc_filters || []).join(', ')}]`, '');
    (s.modeling.scatter_gates || []).forEach((gate) => {
      p('[[modeling.scatter_gates]]',
        `name = ${toml_str(gate.name)}`,
        `mean_x = ${gate.mean_x}`,
        `mean_y = ${gate.mean_y}`,
        `coverage = ${gate.coverage}`,
        `rotation = ${gate.rotation ?? 0}`,
        '');
    });
    (s.modeling.singlet_gates || []).forEach((gate) => {
      p('[[modeling.singlet_gates]]',
        `name = ${toml_str(gate.name)}`,
        `geometry_mode = ${toml_str(gate.geometry_mode)}`,
        `transform_method = ${toml_str(gate.transform_method)}`,
        `area_center = ${gate.area_center}`,
        `secondary_center = ${gate.secondary_center}`,
        `area_scale = ${gate.area_scale}`,
        `secondary_scale = ${gate.secondary_scale}`,
        `identification_ratio = ${gate.identification_ratio}`,
        `review_required = ${Boolean(gate.review_required)}`,
        '');
    });
    (s.modeling.samples || []).forEach((sample) => {
      p('[[modeling.samples]]',
        `name = ${toml_str(sample.name)}`,
        `model = ${toml_str(sample.model)}`,
        `reviewed = ${Boolean(sample.reviewed)}`,
        `g1_left = ${sample.g1_left}`,
        `g1_right = ${sample.g1_right}`,
        `g1_source = ${toml_str(sample.g1_source || '')}`,
        `g2_left = ${sample.g2_left}`,
        `g2_right = ${sample.g2_right}`,
        `g2_source = ${toml_str(sample.g2_source || '')}`,
        `ratio_mode = ${toml_str(sample.ratio_mode || 'bounded')}`,
        `ratio_min = ${sample.ratio_min}`,
        `ratio_max = ${sample.ratio_max}`,
        `locked_ratio = ${sample.locked_ratio}`,
        `cv_mode = ${toml_str(sample.cv_mode || 'free')}`,
        `ploidy_count = ${sample.ploidy_count}`,
        `contaminant_debris = ${toml_str(sample.contaminant_debris || 'off')}`,
        `contaminant_aggregate = ${toml_str(sample.contaminant_aggregate || 'off')}`,
        `contaminant_subg1 = ${toml_str(sample.contaminant_subg1 || 'off')}`,
        `channel_eligibility = ${toml_str(sample.channel_eligibility || 'unknown')}`,
        `channel_transform = ${toml_str(sample.channel_transform || 'unknown')}`,
        `channel_compensation = ${toml_str(sample.channel_compensation || 'unknown')}`,
        `transform_application_count = ${sample.transform_application_count ?? 0}`,
        `compensation_application_count = ${sample.compensation_application_count ?? 0}`,
        `qc_waivers = ${toml_str(sample.qc_waivers || '{}')}`,
        '');
    });
  }

  return L.join('\n');
}

// ── TOML parser ──────────────────────────────────────────────────────────────

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_SESSION_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_LINES = 50000;
const MAX_PATH_DEPTH = 8;
const MAX_ARRAY_ITEMS = 10000;
const MAX_VALUE_DEPTH = 16;
const MAX_STRING_LENGTH = 256 * 1024;
const MAX_TOTAL_KEYS = 100000;

function safe_object() { return Object.create(null); }
function validate_key(key) {
  const raw = String(key).trim();
  const parts = raw.split('.').map((part) => {
    const trimmed = part.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      try { return JSON.parse(trimmed); } catch (_) { throw new Error(`Invalid quoted session key: ${trimmed}`); }
    }
    return trimmed;
  });
  for (const part of parts) {
    if (!part || FORBIDDEN_KEYS.has(part)) throw new Error(`Unsafe session key: ${part || '(empty)'}`);
  }
  return parts.length === 1 ? parts[0] : raw;
}
function validate_path(path) {
  if (!path.length || path.length > MAX_PATH_DEPTH) throw new Error('Session section nesting is invalid or too deep.');
  path.forEach(validate_key);
  return path;
}

// Split comma-separated list, respecting quoted strings and {}/[] nesting.
function split_csv(str) {
  const items = [];
  let depth = 0, in_str = false, start = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '"' && str[i - 1] !== '\\') in_str = !in_str;
    if (!in_str) {
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
      else if (ch === ',' && depth === 0) {
        items.push(str.slice(start, i).trim());
        start = i + 1;
      }
    }
  }
  const last = str.slice(start).trim().replace(/,$/, '');
  if (last) items.push(last);
  return items.filter(Boolean);
}

function parse_toml_value(str, depth = 0, budget = null) {
  if (depth > MAX_VALUE_DEPTH) throw new Error('Session value nesting is too deep.');
  str = str.trim().replace(/\s*#[^"]*$/, '');
  if (str.startsWith('"')) {
    let value;
    try { value = JSON.parse(str); } catch (_) { throw new Error('Invalid quoted session string.'); }
    if (value.length > MAX_STRING_LENGTH) throw new Error('Session string is too long.');
    return value;
  }
  if (str === 'true')  return true;
  if (str === 'false') return false;
  if (str.startsWith('[') && str.endsWith(']')) {
    const inner = str.slice(1, -1).trim();
    if (!inner) return [];
    const items = split_csv(inner);
    if (items.length > MAX_ARRAY_ITEMS) throw new Error('Session array is too large.');
    return items.map((item) => {
      const t = item.trim();
      return t.startsWith('{') ? parse_inline_table(t, depth + 1, budget) : parse_toml_value(t, depth + 1, budget);
    });
  }
  const n = Number(str);
  return (!isNaN(n) && str !== '') ? n : str;
}

function parse_inline_table(str, depth = 0, budget = null) {
  if (depth > MAX_VALUE_DEPTH) throw new Error('Session inline-table nesting is too deep.');
  const inner = str.slice(1, -1).trim();
  const obj = safe_object();
  for (const pair of split_csv(inner)) {
    const eq = pair.indexOf(' = ');
    if (eq < 0) continue;
    if (budget && ++budget.keys > MAX_TOTAL_KEYS) throw new Error('Session contains too many keys.');
    obj[validate_key(pair.slice(0, eq).trim())] = parse_toml_value(pair.slice(eq + 3), depth + 1, budget);
  }
  return obj;
}

function get_path(obj, path) {
  let node = obj;
  for (const p of path) {
    if (!Object.hasOwn(node, p)) return null;
    node = node[p];
  }
  return node;
}

export function parse_session_toml(text) {
  text = String(text ?? '');
  if (new Blob([text]).size > MAX_SESSION_BYTES) throw new Error('Session file is too large.');
  const result = safe_object();
  let section_path = [];
  let arr_obj = null;
  const budget = { keys: 0 };
  const lines = text.split('\n');
  if (lines.length > MAX_SESSION_LINES) throw new Error('Session file has too many lines.');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i++].trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('[[') && line.endsWith(']]')) {
      const path = validate_path(line.slice(2, -2).trim().split('.'));
      section_path = [];
      if (++budget.keys > MAX_TOTAL_KEYS) throw new Error('Session contains too many keys.');
      arr_obj = safe_object();
      let node = result;
      for (let j = 0; j < path.length - 1; j++) {
        if (!Object.hasOwn(node, path[j])) node[path[j]] = safe_object();
        node = node[path[j]];
      }
      const last = path[path.length - 1];
      if (!Array.isArray(node[last])) node[last] = [];
      if (node[last].length >= MAX_ARRAY_ITEMS) throw new Error(`Session array is too large: ${last}`);
      node[last].push(arr_obj);
      continue;
    }

    if (line.startsWith('[') && line.endsWith(']')) {
      section_path = validate_path(line.slice(1, -1).trim().split('.'));
      arr_obj = null;
      let node = result;
      for (const p of section_path) {
        if (!Object.hasOwn(node, p)) node[p] = safe_object();
        node = node[p];
      }
      continue;
    }

    const eq = line.indexOf(' = ');
    if (eq < 0) continue;
    if (++budget.keys > MAX_TOTAL_KEYS) throw new Error('Session contains too many keys.');
    const key = validate_key(line.slice(0, eq).trim());
    let val_str = line.slice(eq + 3).trim();

    // Collect multi-line arrays.
    if (val_str.startsWith('[') && !val_str.endsWith(']')) {
      let depth = 0;
      const parts = [val_str];
      for (const ch of val_str) depth += (ch === '[') - (ch === ']');
      while (depth > 0 && i < lines.length) {
        const next = lines[i++].trim();
        if (!next || next.startsWith('#')) continue;
        parts.push(next);
        for (const ch of next) depth += (ch === '[') - (ch === ']');
      }
      val_str = parts.join(' ');
    }

    const target = arr_obj || get_path(result, section_path);
    if (target) target[key] = parse_toml_value(val_str, 0, budget);
  }
  return result;
}
