// PhaseFinder session TOML serializer and parser. This file converts the
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

function serialize_session(s) {
  const L = [];
  const p = (...x) => L.push(...x);

  p('# PhaseFinder Session File', `# Created: ${s.session.created}`, '');

  p('[session]', `created = ${toml_str(s.session.created)}`, '');

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
      `status = ${toml_str(r.status || 'available')}`,
      '');
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
    `bins = ${s.plot.bins}`,
    `remove_debris = ${s.plot.remove_debris}`,
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

  return L.join('\n');
}

// ── TOML parser ──────────────────────────────────────────────────────────────

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

function parse_toml_value(str) {
  str = str.trim().replace(/\s*#[^"]*$/, '');
  if (str.startsWith('"')) { try { return JSON.parse(str); } catch (_) { return str; } }
  if (str === 'true')  return true;
  if (str === 'false') return false;
  if (str.startsWith('[') && str.endsWith(']')) {
    const inner = str.slice(1, -1).trim();
    if (!inner) return [];
    return split_csv(inner).map((item) => {
      const t = item.trim();
      return t.startsWith('{') ? parse_inline_table(t) : parse_toml_value(t);
    });
  }
  const n = Number(str);
  return (!isNaN(n) && str !== '') ? n : str;
}

function parse_inline_table(str) {
  const inner = str.slice(1, -1).trim();
  const obj = {};
  for (const pair of split_csv(inner)) {
    const eq = pair.indexOf(' = ');
    if (eq < 0) continue;
    obj[pair.slice(0, eq).trim()] = parse_toml_value(pair.slice(eq + 3));
  }
  return obj;
}

function get_path(obj, path) {
  let node = obj;
  for (const p of path) { if (!node[p]) return null; node = node[p]; }
  return node;
}

function parse_session_toml(text) {
  const result = {};
  let section_path = [];
  let arr_obj = null;
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i++].trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('[[') && line.endsWith(']]')) {
      const path = line.slice(2, -2).trim().split('.');
      section_path = [];
      arr_obj = {};
      let node = result;
      for (let j = 0; j < path.length - 1; j++) {
        if (!node[path[j]]) node[path[j]] = {};
        node = node[path[j]];
      }
      const last = path[path.length - 1];
      if (!Array.isArray(node[last])) node[last] = [];
      node[last].push(arr_obj);
      continue;
    }

    if (line.startsWith('[') && line.endsWith(']')) {
      section_path = line.slice(1, -1).trim().split('.');
      arr_obj = null;
      let node = result;
      for (const p of section_path) { if (!node[p]) node[p] = {}; node = node[p]; }
      continue;
    }

    const eq = line.indexOf(' = ');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
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
    if (target) target[key] = parse_toml_value(val_str);
  }
  return result;
}
