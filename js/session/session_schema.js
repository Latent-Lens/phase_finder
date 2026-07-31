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
  if (parsed.ui) object(parsed.ui, 'ui');
  if (parsed.stats_plan) object(parsed.stats_plan, 'stats_plan');
  if (parsed.structural_qc) object(parsed.structural_qc, 'structural_qc');
  if (parsed.time_qc) object(parsed.time_qc, 'time_qc');
  if (parsed.modeling) {
    const modeling = object(parsed.modeling, 'modeling');
    for (const key of ['qc_filters', 'scatter_gates', 'singlet_gates', 'samples']) {
      if (modeling[key] != null) array(modeling[key], `modeling.${key}`);
    }
  }

  return clone_and_freeze(parsed);
}
