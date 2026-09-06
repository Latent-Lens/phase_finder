import { split_opfs_path } from './opfs_fs.js';
import { FILE_DIGEST_ALGORITHM } from './file_digest.js';

const ALLOWED_SECTIONS = new Set([
  'session', 'files', 'metadata', 'metadata_template', 'table', 'plot', 'ui',
  'stats_plan', 'structural_qc', 'time_qc', 'modeling',
]);

function fail(path, expectation) {
  throw new Error(`Invalid session field "${path}": expected ${expectation}.`);
}

function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'an object');
  return value;
}

function array(value, path) {
  if (!Array.isArray(value)) fail(path, 'an array');
  return value;
}

function strings(value, path) {
  array(value, path).forEach((item, index) => {
    if (typeof item !== 'string') fail(`${path}[${index}]`, 'a string');
  });
}

function optional_boolean(value, path) {
  if (value != null && typeof value !== 'boolean') fail(path, 'a boolean');
}

function optional_layout_number(value, path, minimum) {
  if (value != null && (!Number.isFinite(value) || value < minimum || value > 100000)) {
    fail(path, `a finite number from ${minimum} to 100000`);
  }
}

function finite(value, path) {
  if (!Number.isFinite(value)) fail(path, 'a finite number');
}

function choice(value, path, choices) {
  if (value != null && !choices.includes(value)) fail(path, choices.join(', '));
}

function modeling_records(modeling) {
  for (const [index, stage] of (modeling.qc_filters ?? []).entries()) {
    if (!Number.isInteger(stage) || stage < 0 || stage > 3) fail(`modeling.qc_filters[${index}]`, 'a QC stage from 0 to 3');
  }
  for (const collection of ['samples', 'scatter_gates', 'singlet_gates']) {
    const names = new Set();
    (modeling[collection] ?? []).forEach((record, index) => {
      const path = `modeling.${collection}[${index}]`;
      object(record, path);
      if (typeof record.name !== 'string' || !record.name || names.has(record.name)) fail(`${path}.name`, 'a unique nonempty sample name');
      names.add(record.name);
      if (collection === 'scatter_gates') {
        for (const key of ['mean_x', 'mean_y', 'coverage']) finite(record[key], `${path}.${key}`);
        if (record.rotation != null) finite(record.rotation, `${path}.rotation`);
        if (record.coverage <= 0 || record.coverage >= 1) fail(`${path}.coverage`, 'a value between 0 and 1');
      } else if (collection === 'singlet_gates') {
        for (const key of ['area_center', 'secondary_center', 'area_scale', 'secondary_scale', 'identification_ratio']) finite(record[key], `${path}.${key}`);
        if (record.area_scale <= 0 || record.secondary_scale <= 0) fail(path, 'positive geometry scales');
        for (const key of ['geometry_mode', 'transform_method']) {
          if (typeof record[key] !== 'string') fail(`${path}.${key}`, 'a string');
        }
        optional_boolean(record.review_required, `${path}.review_required`);
      } else {
        if (typeof record.model !== 'string' || !record.model) fail(`${path}.model`, 'a model identifier');
        for (const key of ['g1_left', 'g1_right', 'g2_left', 'g2_right']) finite(record[key], `${path}.${key}`);
        if (record.g1_left >= record.g1_right || record.g2_left >= record.g2_right
            || record.g1_left >= record.g2_left) fail(path, 'ordered, positive-width G1/G2 regions');
        optional_boolean(record.reviewed, `${path}.reviewed`);
        for (const key of ['model_version', 'peak_detection_status', 'g1_source', 'g2_source']) {
          if (record[key] != null && typeof record[key] !== 'string') fail(`${path}.${key}`, 'a string');
        }
        choice(record.ratio_mode, `${path}.ratio_mode`, ['bounded', 'locked', 'free']);
        choice(record.cv_mode, `${path}.cv_mode`, ['free', 'equal']);
        for (const key of ['contaminant_debris', 'contaminant_aggregate', 'contaminant_subg1']) choice(record[key], `${path}.${key}`, ['off', 'fit']);
        for (const key of ['ratio_min', 'ratio_max', 'locked_ratio', 'ploidy_count', 'transform_application_count', 'compensation_application_count']) {
          if (record[key] != null) finite(record[key], `${path}.${key}`);
        }
        if (record.ratio_min != null && record.ratio_max != null && record.ratio_min > record.ratio_max) fail(path, 'ordered ratio limits');
        for (const key of ['qc_waivers', 'qc_acknowledgements']) {
          if (record[key] == null) continue;
          if (typeof record[key] !== 'string') fail(`${path}.${key}`, 'a JSON string');
          let entries;
          try { entries = JSON.parse(record[key]); } catch (_) { fail(`${path}.${key}`, 'a JSON object'); }
          object(entries, `${path}.${key}`);
          for (const [stage, entry] of Object.entries(entries)) {
            const location = `${path}.${key}.${stage}`;
            if (!['structural', 'time', 'scatter', 'singlet'].includes(stage)) fail(location, 'a supported QC stage');
            object(entry, location);
            const required = key === 'qc_waivers' ? ['reason'] : ['key', 'acknowledgedAt'];
            for (const field of required) {
              if (typeof entry[field] !== 'string' || !entry[field].trim()) fail(`${location}.${field}`, 'a nonempty string');
            }
          }
        }
      }
    });
  }
}

function clone_and_freeze(value) {
  if (!value || typeof value !== 'object') return value;
  const copy = Array.isArray(value) ? [] : Object.create(null);
  for (const [key, item] of Object.entries(value)) copy[key] = clone_and_freeze(item);
  return Object.freeze(copy);
}

export function validate_session_draft(parsed) {
  object(parsed, 'root');
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_SECTIONS.has(key)) throw new Error(`Unknown critical session section: "${key}".`);
  }

  const session = object(parsed.session, 'session');
  if (typeof session.created !== 'string' || !session.created) fail('session.created', 'a nonempty string');
  const version = session.schema_version ?? 0;
  if (!Number.isInteger(version) || version < 0 || version > 1) fail('session.schema_version', 'supported version 0 or 1');
  if (session.logical_id != null && typeof session.logical_id !== 'string') fail('session.logical_id', 'a string');
  for (const field of ['application', 'application_version', 'source_commit']) {
    if (session[field] != null && typeof session[field] !== 'string') fail(`session.${field}`, 'a string');
  }

  const files = object(parsed.files, 'files');
  strings(files.names || [], 'files.names');
  array(files.records || [], 'files.records').forEach((record, index) => {
    const path = `files.records[${index}]`;
    object(record, path);
    if (typeof record.original_name !== 'string' || !record.original_name) fail(`${path}.original_name`, 'a nonempty string');
    if (record.size != null && (!Number.isFinite(record.size) || record.size < 0)) fail(`${path}.size`, 'a nonnegative number');
    if (typeof record.opfs_path !== 'string') fail(`${path}.opfs_path`, 'a PhaseFinder cache path');
    try { split_opfs_path(record.opfs_path); } catch (_) { fail(`${path}.opfs_path`, 'a path inside sessions/<id>/files'); }
    if (Boolean(record.digest) !== Boolean(record.digest_algorithm)) fail(`${path}.digest`, 'both digest algorithm and value, or neither');
    if (record.digest_algorithm && record.digest_algorithm !== FILE_DIGEST_ALGORITHM) fail(`${path}.digest_algorithm`, FILE_DIGEST_ALGORITHM);
    if (record.digest && !/^[0-9a-f]{64}$/.test(record.digest)) fail(`${path}.digest`, '64 lowercase hexadecimal characters');
  });

  if (parsed.metadata) {
    const metadata = object(parsed.metadata, 'metadata');
    array(metadata.columns || [], 'metadata.columns');
    array(metadata.rows || [], 'metadata.rows');
  }
  if (parsed.metadata_template) {
    const template = object(parsed.metadata_template, 'metadata_template');
    array(template.steps || [], 'metadata_template.steps');
    array(template.columns || [], 'metadata_template.columns');
  }
  if (parsed.table) {
    const table = object(parsed.table, 'table');
    strings(table.selected_files || [], 'table.selected_files');
    if (table.filters != null) {
      object(table.filters, 'table.filters');
      Object.entries(table.filters).forEach(([key, values]) => strings(values, `table.filters.${key}`));
    }
  }
  if (parsed.plot) object(parsed.plot, 'plot');
  if (parsed.ui) {
    const ui = object(parsed.ui, 'ui');
    optional_boolean(ui.sidebar_collapsed, 'ui.sidebar_collapsed');
    optional_boolean(ui.plot_panel_collapsed, 'ui.plot_panel_collapsed');
    optional_boolean(ui.metadata_panel_collapsed, 'ui.metadata_panel_collapsed');
    optional_layout_number(ui.sidebar_width_px, 'ui.sidebar_width_px', 150);
    optional_layout_number(ui.plot_panel_height_px, 'ui.plot_panel_height_px', 50);
    optional_layout_number(ui.metadata_panel_height_px, 'ui.metadata_panel_height_px', 50);
  }
  if (parsed.stats_plan) object(parsed.stats_plan, 'stats_plan');
  if (parsed.structural_qc) object(parsed.structural_qc, 'structural_qc');
  if (parsed.time_qc) object(parsed.time_qc, 'time_qc');
  if (parsed.modeling) {
    const modeling = object(parsed.modeling, 'modeling');
    for (const key of ['qc_filters', 'scatter_gates', 'singlet_gates', 'samples']) {
      if (modeling[key] != null) array(modeling[key], `modeling.${key}`);
    }
    modeling_records(modeling);
  }

  return clone_and_freeze(parsed);
}
