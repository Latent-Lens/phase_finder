#!/usr/bin/env python3
"""Unit tests for the session TOML serializer/parser in js/session/toml_io.js.

Builds a representative session object (the shape js/session/core.js's
collect_session produces), serializes it to TOML, parses it back, and asserts
that the fields the app relies on survive the round-trip: files, plot controls,
table sort/filters, metadata columns and rows, the filename template, UI layout,
and the stats plan. Guards session save/load reliability without any DOM or app
state.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext

GROUP = "Unit / Session TOML"

_FULL_SUITE = r"""() => {
  const results = [];
  const push = (name, pass, detail) => results.push({ name, pass: Boolean(pass), detail: detail ?? '' });

  const session = {
    session: { created: '2026-07-09T00:00:00.000Z', logical_id: 'logical-test', schema_version: 1 },
    files: { names: ['A.fcs', 'B.fcs'], records: [{
      id: 'file-a', original_name: 'A.fcs', relative_path: 'A.fcs', size: 4,
      last_modified: 1234, mime_type: 'application/octet-stream',
      opfs_path: 'sessions/cache-a/files/file-a.fcs', status: 'available',
      digest_algorithm: 'SHA-256-CHUNKED-1M-v1', digest: 'a'.repeat(64),
    }] },
    stats_plan: [{ channel: 'DAPI-A', metrics: ['mean', 'median'] }],
    modeling: {
      qc_filters: [0, 1, 3],
      scatter_gates: [{
        name: 'A.fcs', mean_x: 123.5, mean_y: 87.25,
        coverage: 0.975, rotation: 0.125,
      }],
      singlet_gates: [{
        name: 'A.fcs', geometry_mode: 'DNA_A_vs_DNA_H', transform_method: 'robust_zscore',
        area_center: 100, secondary_center: 75, area_scale: 12.5, secondary_scale: 8.25,
        identification_ratio: 18.5, review_required: false,
      }],
      samples: [{
        name: 'A.fcs', model: 'watson_pragmatic', reviewed: true,
        g1_left: 55.5, g1_right: 84.25, g1_source: 'detected',
        g2_left: 115, g2_right: 165, g2_source: 'inferred',
        ratio_mode: 'bounded', ratio_min: 1.65, ratio_max: 2.25,
        locked_ratio: 2, cv_mode: 'free', ploidy_count: 1,
        contaminant_debris: 'off', contaminant_aggregate: 'off', contaminant_subg1: 'off',
      }],
    },
    metadata: {
      columns: [
        { field: 'strain', label: 'Strain', headerEditable: false, source: 'filename' },
        { field: 'timepoint', label: 'Timepoint', headerEditable: true, source: 'filename' },
      ],
      rows: [
        { name: 'A.fcs', strain: '76', timepoint: '0' },
        { name: 'B.fcs', strain: '77', timepoint: '30' },
      ],
    },
    metadata_template: {
      steps: [{ type: 'delimiter', delimiter: '_' }],
      columns: [{ field: 'strain', label: 'Strain', source_index: 0 }],
    },
    table: {
      selected_files: ['A.fcs'],
      sort_field: 'strain',
      sort_direction: 'desc',
      filters: { strain: ['76', '77'] },
    },
    plot: {
      channel: 'DAPI-A', color_by: 'strain', display_mode: 'curve_bins', bins: 384,
      // x range pinned, y left auto (null) -- only the set bounds serialize.
      axis_x_min: 1200, axis_x_max: 9800, axis_y_min: null, axis_y_max: null,
      analysis_x_min: 1500, analysis_x_max: 9000,
      remove_debris: true, remove_doublets: false, show_peak_threshold: true,
    },
    ui: {
      sidebar_collapsed: false, sidebar_width_px: 340,
      plot_panel_collapsed: false, plot_panel_height_px: 420,
      metadata_panel_collapsed: true, metadata_panel_height_px: 260,
    },
  };

  let text, parsed;
  try {
    text = serialize_session(session);
    parsed = parse_session_toml(text);
  } catch (err) {
    push('serialize_session/parse_session_toml: round-trip runs without error', false, String(err));
    return results;
  }
  push('serialize_session: produces a non-empty TOML document with a [session] header',
       typeof text === 'string' && text.includes('[session]') && text.length > 100,
       'length=' + (text ? text.length : 0));

  push('round-trip: session.created is preserved',
       parsed.session && parsed.session.created === session.session.created,
       parsed.session && parsed.session.created);
  push('SES-01: logical session identity and schema version survive the session round-trip',
       parsed.session.logical_id === 'logical-test' && parsed.session.schema_version === 1,
       JSON.stringify(parsed.session));
  push('round-trip: files.names is preserved in order',
       JSON.stringify(parsed.files && parsed.files.names) === JSON.stringify(['A.fcs', 'B.fcs']),
       JSON.stringify(parsed.files && parsed.files.names));
  push('SES-02: file digest algorithm and value survive the TOML round-trip',
       parsed.files.records[0].digest_algorithm === 'SHA-256-CHUNKED-1M-v1'
       && parsed.files.records[0].digest === 'a'.repeat(64),
       JSON.stringify(parsed.files.records[0]));
  push('SES-03: session output excludes transient request IDs and stale fit results',
       !text.includes('request_id') && !text.includes('worker_id')
       && !text.includes('fit_result') && !text.includes('fitted_counts'));

  push('round-trip: plot controls (channel, display_mode, bins) survive with types',
       parsed.plot.channel === 'DAPI-A' && parsed.plot.display_mode === 'curve_bins'
       && parsed.plot.bins === 384,
       JSON.stringify(parsed.plot));
  push('round-trip: set axis-range overrides survive; unset bounds are omitted (auto)',
       parsed.plot.axis_x_min === 1200 && parsed.plot.axis_x_max === 9800
       && parsed.plot.axis_y_min === undefined && parsed.plot.axis_y_max === undefined,
       JSON.stringify({x_min: parsed.plot.axis_x_min, x_max: parsed.plot.axis_x_max,
                       y_min: parsed.plot.axis_y_min, y_max: parsed.plot.axis_y_max}));
  push('round-trip: scientific analysis domain is distinct from display axis limits',
       parsed.plot.analysis_x_min === 1500 && parsed.plot.analysis_x_max === 9000
       && parsed.plot.analysis_x_min !== parsed.plot.axis_x_min,
       JSON.stringify({ analysis: [parsed.plot.analysis_x_min, parsed.plot.analysis_x_max],
                        display: [parsed.plot.axis_x_min, parsed.plot.axis_x_max] }));
  push('round-trip: plot boolean toggles survive as booleans',
       parsed.plot.remove_debris === true && parsed.plot.remove_doublets === false
       && parsed.plot.show_peak_threshold === true,
       JSON.stringify({ d: parsed.plot.remove_debris, db: parsed.plot.remove_doublets, t: parsed.plot.show_peak_threshold }));

  push('round-trip: modeling QC stages survive as a numeric array',
       JSON.stringify(parsed.modeling.qc_filters) === JSON.stringify([0, 1, 3]),
       JSON.stringify(parsed.modeling.qc_filters));
  push('round-trip: reviewed manual Cell Gate provenance survives',
       parsed.modeling.scatter_gates.length === 1
       && parsed.modeling.scatter_gates[0].name === 'A.fcs'
       && parsed.modeling.scatter_gates[0].mean_x === 123.5
       && parsed.modeling.scatter_gates[0].coverage === 0.975
       && parsed.modeling.scatter_gates[0].rotation === 0.125,
       JSON.stringify(parsed.modeling.scatter_gates));
  push('round-trip: pulse-geometry transform provenance survives',
       parsed.modeling.singlet_gates.length === 1
       && parsed.modeling.singlet_gates[0].transform_method === 'robust_zscore'
       && parsed.modeling.singlet_gates[0].area_scale === 12.5
       && parsed.modeling.singlet_gates[0].identification_ratio === 18.5
       && parsed.modeling.singlet_gates[0].review_required === false,
       JSON.stringify(parsed.modeling.singlet_gates));
  push('round-trip: modeling per-sample config (regions, model, settings) survives',
       parsed.modeling.samples.length === 1
       && parsed.modeling.samples[0].name === 'A.fcs'
       && parsed.modeling.samples[0].model === 'watson_pragmatic'
       && parsed.modeling.samples[0].reviewed === true
       && parsed.modeling.samples[0].g1_left === 55.5
       && parsed.modeling.samples[0].g2_right === 165
       && parsed.modeling.samples[0].g1_source === 'detected'
       && parsed.modeling.samples[0].ratio_min === 1.65
       && parsed.modeling.samples[0].ploidy_count === 1,
       JSON.stringify(parsed.modeling.samples[0]));

  push('round-trip: table sort field and direction survive',
       parsed.table.sort_field === 'strain' && parsed.table.sort_direction === 'desc',
       JSON.stringify({ f: parsed.table.sort_field, d: parsed.table.sort_direction }));
  push('round-trip: table selection and column filters survive as arrays',
       JSON.stringify(parsed.table.selected_files) === JSON.stringify(['A.fcs'])
       && JSON.stringify(parsed.table.filters.strain) === JSON.stringify(['76', '77']),
       JSON.stringify({ sel: parsed.table.selected_files, filt: parsed.table.filters }));

  push('round-trip: metadata columns preserve field, label, and header_editable',
       parsed.metadata.columns.length === 2
       && parsed.metadata.columns[0].field === 'strain' && parsed.metadata.columns[0].label === 'Strain'
       && parsed.metadata.columns[1].header_editable === true,
       JSON.stringify(parsed.metadata.columns));
  push('round-trip: metadata rows preserve per-column values keyed by filename',
       parsed.metadata.rows.length === 2
       && parsed.metadata.rows[0].name === 'A.fcs' && parsed.metadata.rows[0].strain === '76'
       && parsed.metadata.rows[1].timepoint === '30',
       JSON.stringify(parsed.metadata.rows));

  push('round-trip: filename metadata template steps and columns survive',
       parsed.metadata_template.steps[0].type === 'delimiter'
       && parsed.metadata_template.steps[0].delimiter === '_'
       && parsed.metadata_template.columns[0].source_index === 0,
       JSON.stringify(parsed.metadata_template));

  push('round-trip: UI layout numbers and collapsed flags survive',
       parsed.ui.sidebar_width_px === 340 && parsed.ui.metadata_panel_collapsed === true
       && parsed.ui.plot_panel_height_px === 420,
       JSON.stringify(parsed.ui));

  push('round-trip: stats plan entries survive with their metric lists',
       parsed.stats_plan && parsed.stats_plan.entries
       && parsed.stats_plan.entries[0].channel === 'DAPI-A'
       && JSON.stringify(parsed.stats_plan.entries[0].metrics) === JSON.stringify(['mean', 'median']),
       JSON.stringify(parsed.stats_plan));

  delete Object.prototype.pfPolluted;
  let maliciousRejected = false;
  try { parse_session_toml('[__proto__]\npfPolluted = "yes"'); } catch (_) { maliciousRejected = true; }
  push('parser: rejects prototype-polluting section paths',
       maliciousRejected && Object.prototype.pfPolluted === undefined,
       'rejected=' + maliciousRejected + ', polluted=' + Object.prototype.pfPolluted);

  let inlineRejected = false;
  try { parse_session_toml('[metadata]\ncolumns = [{constructor = "bad"}]'); } catch (_) { inlineRejected = true; }
  push('parser: rejects dangerous inline-table keys', inlineRejected, 'rejected=' + inlineRejected);

  let quotedRejected = false;
  try { parse_session_toml('["__proto__"]\nvalue = 1'); } catch (_) { quotedRejected = true; }
  let dottedRejected = false;
  try { parse_session_toml('[metadata]\nsafe.constructor = "bad"'); } catch (_) { dottedRejected = true; }
  push('SEC-01: quoted and dotted prototype-key syntaxes are rejected',
       quotedRejected && dottedRejected,
       JSON.stringify({ quotedRejected, dottedRejected }));

  let depthRejected = false;
  try { parse_session_toml('[files]\nnames = ' + '['.repeat(18) + '"x"' + ']'.repeat(18)); }
  catch (_) { depthRejected = true; }
  let stringRejected = false;
  try { parse_session_toml('[session]\ncreated = "' + 'x'.repeat(256 * 1024 + 1) + '"'); }
  catch (_) { stringRejected = true; }
  push('SEC-01: nested values and individual strings have explicit resource limits',
       depthRejected && stringRejected,
       JSON.stringify({ depthRejected, stringRejected }));

  const hostileTomlValue = '<script>window.__xss=1</script>\\"&';
  const hostileInput = structuredClone(session);
  hostileInput.metadata.columns = [{ field: 'annotation', label: 'Annotation' }];
  hostileInput.metadata.rows = [{ name: hostileTomlValue, annotation: hostileTomlValue }];
  hostileInput.modeling.samples = [{ ...session.modeling.samples[0], name: hostileTomlValue, model: hostileTomlValue }];
  const hostileSession = parse_session_toml(serialize_session(hostileInput));
  push('SEC-03: HTML/script-like TOML strings round-trip as inert data',
       hostileSession.metadata.rows[0].name === hostileTomlValue
       && hostileSession.metadata.rows[0].annotation === hostileTomlValue
       && hostileSession.modeling.samples[0].model === hostileTomlValue,
       JSON.stringify(hostileSession));

  return results;
}"""


def run_session_tests(ctx: TestContext):
    page = ctx.page
    try:
        all_results = page.evaluate(_FULL_SUITE)
    except Exception as err:
        ctx.check(GROUP, "Session TOML suite setup", False, str(err), screenshot=False)
        return

    for item in all_results:
        ctx.check(GROUP, item["name"], item["pass"], item.get("detail", ""), screenshot=False)

    cache_results = page.evaluate(r"""async () => {
      const cache = await import('/js/session/file_cache.js');
      const opfs = await import('/js/session/opfs_fs.js');
      const digests = await import('/js/session/file_digest.js');
      const schema = await import('/js/session/session_schema.js');
      const transaction = await import('/js/session/session_transaction.js');
      const sessionCore = await import('/js/session/core.js');
      const results = [];
      const push = (name, pass, detail = '') => results.push({ name, pass: Boolean(pass), detail });
      const indexKey = 'phasefinder_cache_index_v1';
      const activeKey = 'phasefinder_active_logical_session_v1';
      const autoKey = 'phasefinder_auto_cache_v1';
      const savedIndex = localStorage.getItem(indexKey);
      const savedActive = localStorage.getItem(activeKey);
      const savedAuto = localStorage.getItem(autoKey);
      try {
        localStorage.removeItem(indexKey);
        const record = {
          id: 'file-1', original_name: 'A.fcs', size: 4,
          opfs_path: 'sessions/cache-a/files/file-1.fcs',
          digest_algorithm: 'SHA-256', digest: 'abcd',
        };
        cache.set_active_logical_session_id('owner-a');
        cache.set_records_from_session([record], 'owner-a');
        cache.set_records_from_session([record], 'owner-b');
        let entry = cache.read_cache_index().entries[record.opfs_path];
        push('SES-01: persistent cache index records schema, identity, digest, timestamps, and both owners',
          entry.schema_version === 1 && entry.cache_id && entry.file_id === 'file-1'
          && entry.size === 4 && entry.digest === 'abcd' && entry.created_at && entry.last_used_at
          && entry.owners.includes('owner-a') && entry.owners.includes('owner-b'),
          JSON.stringify(entry));

        let deleteCalls = 0;
        await cache.release_session_cache('owner-a', async () => { deleteCalls += 1; return true; });
        entry = cache.read_cache_index().entries[record.opfs_path];
        push('SES-01: clearing one owner preserves a cache shared by another session',
          deleteCalls === 0 && entry.owners.length === 1 && entry.owners[0] === 'owner-b',
          JSON.stringify({ deleteCalls, entry }));

        await cache.release_session_cache('owner-b', async () => { deleteCalls += 1; return false; });
        entry = cache.read_cache_index().entries[record.opfs_path];
        push('SES-01: deletion failure is retained as an orphan candidate but leaves no active owner',
          deleteCalls === 1 && entry.owners.length === 0 && Boolean(entry.cleanup_failed_at)
          && cache.cache_entries_for_session('owner-b').length === 0,
          JSON.stringify({ deleteCalls, entry }));

        let unsafeRejected = false;
        try { opfs.split_opfs_path('../foreign/private.fcs'); } catch (_) { unsafeRejected = true; }
        push('SEC-01: OPFS cache paths are restricted to the PhaseFinder sessions namespace',
          unsafeRejected && opfs.split_opfs_path('sessions/cache-a/files/file-1.fcs').file_name === 'file-1.fcs');

        const validLegacy = {
          session: { created: '2026-01-01T00:00:00Z' },
          files: { names: ['A.fcs'], records: [{
            original_name: 'A.fcs', size: 4,
            opfs_path: 'sessions/cache-a/files/file-1.fcs',
          }] },
        };
        const draft0 = schema.validate_session_draft(validLegacy);
        const draft1 = schema.validate_session_draft({
          ...validLegacy, session: { ...validLegacy.session, schema_version: 1, logical_id: 'logical-a' },
        });
        push('SEC-01: versioned schema accepts supported legacy/current sessions as immutable drafts',
          Object.isFrozen(draft0) && Object.isFrozen(draft0.files.records[0])
          && draft1.session.schema_version === 1);

        let unknownRejected = false;
        try { schema.validate_session_draft({ ...validLegacy, executable: {} }); } catch (_) { unknownRejected = true; }
        let typeRejected = false;
        try { schema.validate_session_draft({ ...validLegacy, files: { names: 'A.fcs', records: [] } }); }
        catch (_) { typeRejected = true; }
        let pathRejected = false;
        try {
          schema.validate_session_draft({
            ...validLegacy,
            files: { ...validLegacy.files, records: [{ ...validLegacy.files.records[0], opfs_path: 'foreign/private.fcs' }] },
          });
        } catch (_) { pathRejected = true; }
        push('SEC-01: schema rejects unknown critical sections, type mismatches, and machine/foreign paths before apply',
          unknownRejected && typeRejected && pathRejected,
          JSON.stringify({ unknownRejected, typeRejected, pathRejected }));

        const migrated = sessionCore.prepare_session_draft({
          session: { created: '2026-01-01T00:00:00Z', schema_version: 0 },
          files: { names: [], records: [] },
        });
        push('SES-03: legacy migration is resolved in the immutable draft before application',
          migrated.draft.session.schema_version === 1
          && Boolean(migrated.draft.session.logical_id)
          && migrated.migrated_fields.includes('session.schema_version')
          && Object.isFrozen(migrated.draft));

        const restoreStages = ['file_identity', 'configuration', 'view', 'table', 'files'];
        const faultResults = [];
        for (const failedStage of restoreStages) {
          let live = [];
          let rolledBack = false;
          try {
            await transaction.run_restore_stages(
              restoreStages.map((name) => ({
                name,
                run: () => {
                  if (name === failedStage) throw new Error('injected');
                  live.push(name);
                },
              })),
              () => { live = []; rolledBack = true; },
            );
          } catch (error) {
            faultResults.push(rolledBack && live.length === 0 && error.restore_stage === failedStage);
          }
        }
        push('SES-03: fault injection at every restore stage invokes rollback with no partial state',
          faultResults.length === restoreStages.length && faultResults.every(Boolean),
          JSON.stringify(faultResults));

        cache.set_automatic_cache_enabled(false);
        const disabled = !cache.automatic_cache_enabled();
        cache.set_automatic_cache_enabled(true);
        push('SES-04: automatic FCS caching can be disabled before files are loaded',
          disabled && cache.automatic_cache_enabled());

        const unavailableStorage = !opfs.supports_opfs(null)
          && await opfs.get_storage_estimate(null) === null
          && await opfs.request_persistent_storage(null) === false;
        const deniedStorage = await opfs.request_persistent_storage({
          persisted: async () => false,
          persist: async () => false,
        }) === false;
        const privateEstimate = await opfs.get_storage_estimate({
          estimate: async () => ({ usage: 0, quota: 0 }),
        });
        push('SES-04: unavailable, denied/private, and zero-quota storage degrade without throwing',
          unavailableStorage && deniedStorage && privateEstimate.usage === 0 && privateEstimate.quota === 0,
          JSON.stringify({ unavailableStorage, deniedStorage, privateEstimate }));

        const original = new File([new Uint8Array([1, 2, 3, 4])], 'original.fcs');
        const renamed = new File([new Uint8Array([1, 2, 3, 4])], 'renamed.fcs');
        const changed = new File([new Uint8Array([1, 2, 3, 5])], 'original.fcs');
        const [a, b, c] = await Promise.all([
          digests.digest_file(original), digests.digest_file(renamed), digests.digest_file(changed),
        ]);
        push('SES-02: content identity accepts renamed identical bytes and rejects same-size changed bytes',
          a.digest_algorithm === 'SHA-256-CHUNKED-1M-v1' && a.digest === b.digest && a.digest !== c.digest,
          JSON.stringify({ a, b, c }));

        const controller = new AbortController();
        controller.abort();
        let cancelled = false;
        try { await digests.digest_file(original, { signal: controller.signal }); }
        catch (error) { cancelled = error.name === 'AbortError'; }
        push('SES-02: digest calculation supports cancellation', cancelled);

        const path = `sessions/unit-${Date.now()}/files/digest.fcs`;
        const partialPath = `sessions/unit-${Date.now()}/files/partial.fcs`;
        try {
          const copied = await cache.copy_file_to_opfs(original, path);
          const strictRecord = {
            ...record, original_name: 'expected.fcs', opfs_path: path,
            digest_algorithm: copied.digest_algorithm, digest: copied.digest,
          };
          let restored = await (await import('/js/session/reconnect.js')).try_load_from_opfs([strictRecord]);
          push('SES-02: streamed OPFS copy returns a digest and strict restore verifies it',
            copied.digest === a.digest && restored.found.length === 1 && restored.mismatch.length === 0,
            JSON.stringify({ copied, found: restored.found.length, mismatch: restored.mismatch.length }));

          await cache.copy_file_to_opfs(changed, path);
          restored = await (await import('/js/session/reconnect.js')).try_load_from_opfs([strictRecord]);
          push('SES-02: corrupted same-size OPFS content is rejected before restore',
            restored.found.length === 0 && restored.mismatch.length === 1 && strictRecord.status === 'mismatch',
            JSON.stringify({ found: restored.found.length, mismatch: restored.mismatch.length }));

          const legacyRecord = { ...strictRecord, digest_algorithm: undefined, digest: undefined };
          restored = await (await import('/js/session/reconnect.js')).try_load_from_opfs([legacyRecord]);
          push('SES-02: a legacy no-digest session requires explicit manual verification',
            restored.found.length === 0 && restored.unverified.length === 1 && legacyRecord.status === 'unverified');

          await cache.copy_file_to_opfs(original, path);
          const savedRecord = {
            ...strictRecord, original_name: 'saved.fcs',
            digest_algorithm: copied.digest_algorithm, digest: copied.digest,
          };
          cache.catalogue_cached_record(savedRecord, 'saved-owner');
          cache.set_records_from_session([savedRecord], 'saved-owner');
          const savedRestore = await (await import('/js/session/reconnect.js')).try_load_from_opfs([savedRecord]);
          push('SES-01: a saved session reload restores its catalogued OPFS copy before reconnect',
            savedRestore.found.length === 1
            && cache.cache_entries_for_session('saved-owner').some((entry) => entry.path === path));

          await cache.copy_file_to_opfs(original, partialPath);
          const presentRecord = { ...strictRecord, original_name: 'present.fcs', opfs_path: partialPath };
          const absentRecord = { ...strictRecord, original_name: 'absent.fcs', opfs_path: `${partialPath}.missing` };
          const partialRestore = await (await import('/js/session/reconnect.js')).try_load_from_opfs([presentRecord, absentRecord]);
          push('SES-01: partial cache loss restores intact files and reports missing files independently',
            partialRestore.found.length === 1 && partialRestore.missing.length === 1,
            JSON.stringify({ found: partialRestore.found.length, missing: partialRestore.missing.length }));

          const legacyImport = cache.create_imported_logical_session_id();
          cache.set_records_from_session([legacyRecord], legacyImport);
          push('SES-01: imported legacy sessions receive isolated ownership without stealing existing owners',
            cache.cache_entries_for_session(legacyImport).length === 1
            && cache.cache_entries_for_session('saved-owner').length === 1);

          await cache.release_session_cache(legacyImport, opfs.delete_opfs_path);
          await cache.release_session_cache('saved-owner', opfs.delete_opfs_path);
          push('SES-01: Reset-style release removes every sole-owned entry and tolerates already-missing files',
            cache.cache_entries_for_session(legacyImport).length === 0
            && cache.cache_entries_for_session('saved-owner').length === 0);
        } finally {
          await opfs.delete_opfs_path(path);
          await opfs.delete_opfs_path(partialPath);
        }
      } finally {
        if (savedIndex === null) localStorage.removeItem(indexKey); else localStorage.setItem(indexKey, savedIndex);
        if (savedActive === null) localStorage.removeItem(activeKey); else localStorage.setItem(activeKey, savedActive);
        if (savedAuto === null) localStorage.removeItem(autoKey); else localStorage.setItem(autoKey, savedAuto);
      }
      return results;
    }""")
    for item in cache_results:
        ctx.check(GROUP, item["name"], item["pass"], item.get("detail", ""), screenshot=False)
