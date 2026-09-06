#!/usr/bin/env python3
"""STATE-01 regression coverage: model settings are effective, immutable, and
reproducible.

Four properties, one per audit box:
  * every EFFECTIVE setting changes the result key's config hash AND changes what
    the model actually does (a setting that only changes the hash is a serialized
    control that does nothing);
  * an UNKNOWN setting is rejected rather than silently ignored;
  * an UNREVIEWED saved sample stays unreviewed and is not refit on restore;
  * changed file bytes cannot reuse a cached result."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / STATE-01 Settings & Reproducibility"


_STATE_TESTS = r"""async () => {
  const pipeline = window.PhaseFinder.pipeline;
  const modelingState = window.CellCycleModelingState;
  const registry = window.CellCycleModelRegistry;

  const results = [];
  const push = (name, pass, detail = '') => results.push({
    name, pass: Boolean(pass), detail: String(detail ?? ''),
  });
  const run = async (name, test) => {
    try {
      const outcome = await test();
      push(name, outcome.pass, outcome.detail);
    } catch (error) {
      push(name, false, `${error.name}: ${error.message}`);
    }
  };
  const capture = async (callback) => {
    try { await callback(); return null; } catch (error) { return error; }
  };

  registry.clear_registry();
  registry.register_default_models();

  // A bimodal DNA sample with a real S bridge, so ratio/CV settings have
  // something to bite on.
  const buildRow = (name, scale = 1) => {
    const count = 4000;
    const dna = new Float64Array(count);
    let seed = 20260731;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const normal = () => Math.sqrt(-2 * Math.log(Math.max(random(), 1e-9))) * Math.cos(2 * Math.PI * random());
    for (let i = 0; i < count; i += 1) {
      const value = i < 2400 ? 70 + 4 * normal()
        : i < 3000 ? 70 + (70 * (i - 2400)) / 600
        : 140 + 6 * normal();
      dna[i] = value * scale;
    }
    return {
      id: `${name}-id`, name,
      data: { eventCount: count, channel_key: 'DNA_A', dna_a: dna, channels: { DNA_A: dna }, pnr: {} },
    };
  };

  const prepare = (row, binCount = 128) => {
    pipeline.clear_state(row.name);
    pipeline.apply_structural_qc(row);
    pipeline.apply_dna_histogram(row, { binCount, range: [0, 220] });
    modelingState.detect_peak_regions(row);
    modelingState.update_peak_regions(row, { g1: { left: 55, right: 85 }, g2: { left: 120, right: 160 } });
    return pipeline.get_state(row.name);
  };

  const configHashOf = (state) => {
    const key = state.modeling.activeResultKey ?? state.modeling.lastDiagnosticResultKey;
    return String(key ?? '').split('|').find((part) => part.startsWith('config=')) ?? null;
  };

  // ---- every effective setting changes the hash AND the behaviour --------

  // Each entry: a settings patch that is genuinely supported by dean_jett_fox,
  // plus the fitted parameter it is expected to move.
  // Targeted at dean_jett: it optimizes the peak means/widths jointly, so these
  // settings genuinely constrain its fit. (Dean-Jett-Fox fixes its peaks from
  // their clean flanks and therefore cannot consume them -- covered separately
  // below, where the requirement is that it says so rather than pretending.)
  const EFFECTIVE_SETTINGS = [
    ['locked G2:G1 ratio', { ratioMode: 'locked', lockedRatio: 2 }],
    ['narrowed bounded ratio band', { ratioMode: 'bounded', ratioRange: [1.90, 1.95] }],
    ['equal-CV mode', { cvMode: 'equal' }],
  ];

  await run('STATE-01: a baseline fit records a config hash in its result key', async () => {
    const row = buildRow('state-01-baseline.fcs');
    const state = prepare(row);
    modelingState.set_model_settings(row, { modelId: 'dean_jett' });
    await modelingState.fit_cell_cycle_model(row, 'dean_jett');
    const hash = configHashOf(state);
    return { pass: /^config=[0-9a-f]{8}$/.test(hash ?? ''), detail: String(hash) };
  });

  for (const [label, patch] of EFFECTIVE_SETTINGS) {
    await run(`STATE-01: "${label}" changes both the config hash and the applied model behaviour`, async () => {
      const baseRow = buildRow('state-01-a.fcs');
      const baseState = prepare(baseRow);
      modelingState.set_model_settings(baseRow, { modelId: 'dean_jett' });
      const base = await modelingState.fit_cell_cycle_model(baseRow, 'dean_jett');
      const baseHash = configHashOf(baseState);

      const row = buildRow('state-01-b.fcs');
      const state = prepare(row);
      modelingState.set_model_settings(row, { modelId: 'dean_jett', ...patch });
      const changed = await modelingState.fit_cell_cycle_model(row, 'dean_jett');
      const hash = configHashOf(state);

      // Behaviour: the APPLIED configuration must record the setting, and the
      // fit must actually differ somewhere in its parameters. A hash change with
      // identical parameters would mean the control is inert.
      const appliedDiffers = JSON.stringify(base.appliedConfiguration) !== JSON.stringify(changed.appliedConfiguration);
      const parametersDiffer = ['g1Mean', 'g2Mean', 'g1CV', 'g2CV', 'sArea', 'g1Area', 'g2Area']
        .some((key) => Math.abs((base.parameters?.[key] ?? 0) - (changed.parameters?.[key] ?? 0)) > 1e-9);
      return {
        pass: baseHash !== hash && appliedDiffers && parametersDiffer,
        detail: JSON.stringify({ baseHash, hash, appliedDiffers, parametersDiffer }),
      };
    });
  }

  // ---- unknown settings fail loudly -------------------------------------

  await run('STATE-01: an unknown model configuration key is rejected, not ignored', async () => {
    const row = buildRow('state-01-unknown.fcs');
    prepare(row);
    modelingState.set_model_settings(row, { modelId: 'dean_jett_fox' });
    const error = await capture(() =>
      modelingState.fit_cell_cycle_model(row, 'dean_jett_fox', { notARealSetting: 3 }));
    return { pass: /Unsupported model configuration|notARealSetting/i.test(error?.message ?? ''), detail: error?.message ?? 'no throw' };
  });

  await run('STATE-01: a setting a model cannot apply is recorded as not-applied, not silently dropped', async () => {
    const row = buildRow('state-01-unsupported.fcs');
    prepare(row);
    // Watson Pragmatic is a closed-form decomposition: it optimizes nothing, so
    // a ratio constraint on peak means cannot bite. It must still RESTORE (an
    // old session may carry the value), but must say the value was not applied.
    modelingState.set_model_settings(row, { modelId: 'watson_pragmatic', ratioMode: 'locked', lockedRatio: 2 });
    const result = await modelingState.fit_cell_cycle_model(row, 'watson_pragmatic');
    const applicability = result.settingsApplicability;
    return {
      pass: applicability.applied.length === 0
        && applicability.notApplied.includes('ratioMode')
        && /cannot affect its fit/i.test(applicability.reason ?? '')
        && result.warnings.some((warning) => warning.code === 'model_settings_not_applied'),
      detail: JSON.stringify(applicability),
    };
  });

  await run('STATE-01: DJF records ratio/CV as NOT applied, and keeps them out of its config hash', async () => {
    // Dean-Jett-Fox measures both peaks from their clean flanks and holds them
    // fixed, optimizing only the S phase. A ratio band or an equal-CV rule
    // constrains peak means and widths -- parameters the optimizer never moves --
    // so it cannot change the fit. Folding it into the config hash anyway would
    // make the result key claim a difference the numbers do not have, and would
    // make a restored session imply a constraint that was never applied.
    //
    // The setting must still ROUND-TRIP (an old session may carry it) and must
    // say plainly that it was not applied. The fitted G2:G1 ratio is still
    // reported as a diagnostic by constraint_audit.js.
    const plain = buildRow('state-01-djf-plain.fcs');
    const plainState = prepare(plain);
    modelingState.set_model_settings(plain, { modelId: 'dean_jett_fox' });
    const base = await modelingState.fit_cell_cycle_model(plain, 'dean_jett_fox');
    const plainHash = configHashOf(plainState);

    const locked = buildRow('state-01-djf-locked.fcs');
    const lockedState = prepare(locked);
    modelingState.set_model_settings(locked, { modelId: 'dean_jett_fox', ratioMode: 'locked', lockedRatio: 2 });
    const result = await modelingState.fit_cell_cycle_model(locked, 'dean_jett_fox');
    const lockedHash = configHashOf(lockedState);

    // Inert means inert: identical parameters, and the same config hash.
    const parametersMatch = ['g1Mean', 'g2Mean', 'g1CV', 'g2CV', 'sArea', 'g1Area', 'g2Area']
      .every((key) => Math.abs((base.parameters?.[key] ?? 0) - (result.parameters?.[key] ?? 0)) <= 1e-9);
    const applicability = result.settingsApplicability;
    return {
      pass: plainHash === lockedHash
        && parametersMatch
        && applicability.applied.length === 0
        && applicability.notApplied.includes('ratioMode')
        && /cannot affect its fit/i.test(applicability.reason ?? '')
        && result.warnings.some((warning) => warning.code === 'model_settings_not_applied'),
      detail: JSON.stringify({ plainHash, lockedHash, parametersMatch, applicability }),
    };
  });

  await run('STATE-01: Dean-Jett DOES apply ratio/CV, so they stay in its config hash', async () => {
    const plain = buildRow('state-01-dj-plain.fcs');
    const plainState = prepare(plain);
    modelingState.set_model_settings(plain, { modelId: 'dean_jett' });
    const base = await modelingState.fit_cell_cycle_model(plain, 'dean_jett');
    const plainHash = configHashOf(plainState);

    const locked = buildRow('state-01-dj-locked.fcs');
    const lockedState = prepare(locked);
    modelingState.set_model_settings(locked, { modelId: 'dean_jett', ratioMode: 'locked', lockedRatio: 2 });
    const result = await modelingState.fit_cell_cycle_model(locked, 'dean_jett');
    const lockedHash = configHashOf(lockedState);

    const parametersDiffer = ['g1Mean', 'g2Mean', 'g1CV', 'g2CV', 'sArea']
      .some((key) => Math.abs((base.parameters?.[key] ?? 0) - (result.parameters?.[key] ?? 0)) > 1e-9);
    return {
      pass: plainHash !== lockedHash
        && result.settingsApplicability.notApplied.length === 0
        && result.settingsApplicability.applied.includes('ratioMode')
        && parametersDiffer,
      detail: JSON.stringify({ plainHash, lockedHash, parametersDiffer }),
    };
  });

  await run('STATE-01: contaminant/ploidy settings no model implements are rejected', async () => {
    const row = buildRow('state-01-contaminants.fcs');
    prepare(row);
    modelingState.set_model_settings(row, {
      modelId: 'dean_jett_fox', contaminants: { debris: 'fit', aggregate: 'off', subG1: 'off' },
    });
    const error = await capture(() => modelingState.fit_cell_cycle_model(row, 'dean_jett_fox'));
    return { pass: /does not support/i.test(error?.message ?? ''), detail: error?.message ?? 'no throw' };
  });

  // ---- changed file bytes cannot reuse a cached result -------------------

  await run('STATE-01: changed DNA content produces a different result key (no cache reuse)', async () => {
    const row = buildRow('state-01-content.fcs');
    const state = prepare(row);
    modelingState.set_model_settings(row, { modelId: 'dean_jett' });
    await modelingState.fit_cell_cycle_model(row, 'dean_jett');
    const firstKey = state.modeling.activeResultKey;
    const firstContent = String(firstKey).split('|').find((part) => part.startsWith('content='));

    // Same row identity and same channel; different bytes.
    const rescaled = buildRow('state-01-content.fcs', 1.0001);
    const rescaledState = prepare(rescaled);
    modelingState.set_model_settings(rescaled, { modelId: 'dean_jett' });
    await modelingState.fit_cell_cycle_model(rescaled, 'dean_jett');
    const secondKey = rescaledState.modeling.activeResultKey;
    const secondContent = String(secondKey).split('|').find((part) => part.startsWith('content='));

    return {
      pass: firstContent !== secondContent && firstKey !== secondKey,
      detail: JSON.stringify({ firstContent, secondContent }),
    };
  });

  await run('STATE-01: the result key pins model version, config, bins, regions, masks, and domain', () => {
    const row = buildRow('state-01-key.fcs');
    const state = prepare(row);
    return modelingState.fit_cell_cycle_model(row, 'dean_jett').then(() => {
      const parts = String(state.modeling.activeResultKey).split('|');
      const required = ['config=', 'content=', 'channel=', 'masks=', 'hist=', 'bins=', 'regions=', 'domain='];
      const missing = required.filter((prefix) => !parts.some((part) => part.startsWith(prefix)));
      return {
        pass: missing.length === 0 && /^dean_jett@\d+\.\d+\.\d+$/.test(parts[0]),
        detail: JSON.stringify({ head: parts[0], missing }),
      };
    });
  });

  // ---- unreviewed regions stay unreviewed --------------------------------

  await run('STATE-01: an unreviewed peak selection blocks the fit rather than being auto-accepted', async () => {
    const row = buildRow('state-01-unreviewed.fcs');
    pipeline.clear_state(row.name);
    pipeline.apply_structural_qc(row);
    pipeline.apply_dna_histogram(row, { binCount: 128, range: [0, 220] });
    // detect_peak_regions proposes; it does not review/accept.
    modelingState.detect_peak_regions(row);
    const state = pipeline.get_state(row.name);
    const wasUnreviewed = state.modeling.peakSelection.reviewed !== true;
    const error = await capture(() => modelingState.fit_cell_cycle_model(row, 'dean_jett'));
    return {
      pass: wasUnreviewed
        && error?.code === window.CellCycleResultContract.RESULT_REASON.REGIONS_UNREVIEWED
        && state.modeling.peakSelection.reviewed !== true,
      detail: JSON.stringify({ wasUnreviewed, code: error?.code, stillUnreviewed: state.modeling.peakSelection.reviewed !== true }),
    };
  });

  await run('STATE-02/SCI-05: actual TOML restore recomputes fractions and preserves inferred-G2 warnings and model version', async () => {
    const app = await import('/js/state/app_state.js');
    const table = await import('/js/data_structs/table_state.js');
    const session = await import('/js/session/modeling_session.js');
    // The unit harness has no progress-overlay DOM; preload the same pipeline.
    await (await import('/js/analysis/pipeline/pipeline_loader.js')).load_pipeline_silently();
    const toml = await import('/js/session/toml_io.js');
    const plot = window.PlotData;
    const row = buildRow('state-02-roundtrip.fcs');
    const oldFrame = app.get_file_table();
    const oldSelected = [...table.selected_file_ids];
    const oldChannels = plot.plot_channels;
    const oldBins = plot.plot_bin_count();
    const oldDomain = { ...plot.analysis_domain_override };
    try {
      app.get_file_map().set(row.id, row);
      app.set_file_table(new PhaseFinderFrame({ id: [row.id], name: [row.name] }, ['id', 'name']));
      table.selected_file_ids.clear();
      table.selected_file_ids.add(row.id);
      plot.set_plot_channels({ dna_area: 'DNA_A' });
      plot.set_plot_bins(128);
      plot.set_analysis_domain_override(0, 220);
      const state = prepare(row, plot.plot_bin_count());
      state.modeling.peakDetection = { status: 'inferred_g2' };
      modelingState.set_model_settings(row, { modelId: 'dean_jett' });
      const before = await modelingState.fit_cell_cycle_model(row, 'dean_jett');
      const exportModule = window.CellCycleExport;
      const exportSnapshot = result => {
        const json = exportModule.build_fit_export(row, result);
        delete json.exportedAt;
        return { json, csv: exportModule.build_fit_csv(row, result) };
      };
      const exportedBefore = exportSnapshot(before);
      const curves = exportedBefore.json.curves;
      const arithmetic = curves.x.length === before.histogramProvenance.binCount
        && curves.residuals.every((value, i) => value === before.histogramProvenance.counts[i] - before.expectedCounts[i])
        && ['g1', 's', 'g2'].every(id => JSON.stringify(curves[id]) === JSON.stringify(before.components.find(c => c.id === id).counts));
      const saved = session.get_modeling_session_state();
      const text = toml.serialize_session({
        session: { created: '2026-09-05' }, files: { names: [row.name] },
        metadata: { columns: [], rows: [] }, table: { selected_files: [row.name], filters: {} },
        plot: { channel: 'DNA_A', color_by: '', bins: 128, remove_debris: false, remove_doublets: false, show_peak_threshold: false },
        ui: { sidebar_collapsed: false, sidebar_width_px: 300, plot_panel_collapsed: false,
          plot_panel_height_px: 400, metadata_panel_collapsed: false, metadata_panel_height_px: 200 },
        modeling: saved,
      });
      const parsed = toml.parse_session_toml(text).modeling;
      pipeline.clear_state(row.name);
      pipeline.apply_structural_qc(row);
      const summary = await session.apply_modeling_session(parsed);
      const restored = pipeline.get_state(row.name);
      const after = restored.modeling.resultsByKey[restored.modeling.activeResultKey];
      const display = (result, state) => ({
        cells: ['g1', 's', 'g2'].map(key => window.CellCycleColumns.format_fraction_cell(result, result.phaseFractions[key])),
        plot: window.PlotRender.analysis_text(row, window.PlotRender.build_fit_series_entry(row, state, result)),
      });
      const same = JSON.stringify(display(before, state)) === JSON.stringify(display(after, restored));
      const warningsMatch = JSON.stringify(before.warnings) === JSON.stringify(after.warnings);
      const exportsMatch = JSON.stringify(exportedBefore) === JSON.stringify(exportSnapshot(after));
      const snapshotsMatch = JSON.stringify(after.peakRegions) === JSON.stringify(restored.modeling.peakSelection.regions)
        && JSON.stringify(exportedBefore.json.model.settings) === JSON.stringify(before.appliedConfiguration)
        && exportedBefore.json.model.configHash === before.configHash;
      // Mutating the live region must not rewrite the fit's accepted-input snapshot.
      restored.modeling.peakSelection.regions.g1.left += 1;
      const immutableRegion = after.peakRegions.g1.left !== restored.modeling.peakSelection.regions.g1.left;
      restored.modeling.peakSelection.regions.g1.left -= 1;
      const version = registry.get_model('dean_jett').version;
      const reproduced = after.reproduction.status;
      parsed.samples[0].model_version = '0.0.0';
      const drift = await session.apply_modeling_session(parsed);
      const driftResult = restored.modeling.resultsByKey[restored.modeling.activeResultKey];
      return {
        pass: summary.restored === 1 && summary.failed === 0 && before !== after && same && warningsMatch && exportsMatch && arithmetic && snapshotsMatch && immutableRegion
          && parsed.samples[0].peak_detection_status === 'inferred_g2'
          && restored.modeling.peakDetection.status === 'inferred_g2'
          && after.warnings.some(w => /single|inferred/i.test(w.message))
          && saved.samples[0].model_version === version && reproduced === 'reproduced'
          && drift.drifted.length === 1 && driftResult.reproduction.status === 'recomputed_new',
        detail: JSON.stringify({ summary, same, warningsMatch, exportsMatch, arithmetic, snapshotsMatch, immutableRegion, reproduced, drift, before: before.phaseFractions, after: after.phaseFractions }),
      };
    } finally {
      pipeline.clear_state(row.name);
      app.get_file_map().delete(row.id);
      app.set_file_table(oldFrame);
      table.selected_file_ids.clear();
      oldSelected.forEach(id => table.selected_file_ids.add(id));
      plot.set_plot_channels(oldChannels);
      plot.set_plot_bins(oldBins);
      plot.set_analysis_domain_override(oldDomain.x_min, oldDomain.x_max);
    }
  });

  await run('STATE-02 box 3: a saved-session source-commit mismatch on restore is flagged as implementation drift, distinct from a model_version bump', async () => {
    const app = await import('/js/state/app_state.js');
    const table = await import('/js/data_structs/table_state.js');
    const session = await import('/js/session/modeling_session.js');
    await (await import('/js/analysis/pipeline/pipeline_loader.js')).load_pipeline_silently();
    const toml = await import('/js/session/toml_io.js');
    const plot = window.PlotData;
    const row = buildRow('state-02-commit-drift.fcs');
    const oldFrame = app.get_file_table();
    const oldSelected = [...table.selected_file_ids];
    const oldChannels = plot.plot_channels;
    const oldBins = plot.plot_bin_count();
    const oldDomain = { ...plot.analysis_domain_override };
    try {
      app.get_file_map().set(row.id, row);
      app.set_file_table(new PhaseFinderFrame({ id: [row.id], name: [row.name] }, ['id', 'name']));
      table.selected_file_ids.clear();
      table.selected_file_ids.add(row.id);
      plot.set_plot_channels({ dna_area: 'DNA_A' });
      plot.set_plot_bins(128);
      plot.set_analysis_domain_override(0, 220);
      prepare(row, plot.plot_bin_count());
      modelingState.set_model_settings(row, { modelId: 'dean_jett' });
      await modelingState.fit_cell_cycle_model(row, 'dean_jett');

      // A real round trip through the actual TOML serializer/parser: the
      // session envelope's source_commit (core.js:230, toml_io.js:32) is what
      // a restore compares against, so serialize/parse it exactly as a saved
      // session file would carry it rather than hand-building the option.
      const savedModeling = session.get_modeling_session_state();
      const text = toml.serialize_session({
        session: { created: '2026-09-06', source_commit: 'deadbeef0000' },
        files: { names: [row.name] },
        metadata: { columns: [], rows: [] }, table: { selected_files: [row.name], filters: {} },
        plot: { channel: 'DNA_A', color_by: '', bins: 128, remove_debris: false, remove_doublets: false, show_peak_threshold: false },
        ui: { sidebar_collapsed: false, sidebar_width_px: 300, plot_panel_collapsed: false,
          plot_panel_height_px: 400, metadata_panel_collapsed: false, metadata_panel_height_px: 200 },
        modeling: savedModeling,
      });
      const parsed = toml.parse_session_toml(text);
      const savedSourceCommit = parsed.session.source_commit;
      // Same model version as when it was saved -- only the recorded commit
      // differs -- so a version-only check would find nothing to report here.
      const versionUnchanged = parsed.modeling.samples[0].model_version === registry.get_model('dean_jett').version;

      const restoreSummary = await session.apply_modeling_session(parsed.modeling, { savedSourceCommit });
      const afterState = pipeline.get_state(row.name);
      const after = afterState.modeling.resultsByKey[afterState.modeling.activeResultKey];
      const implementationWarning = after?.warnings.find(w => w.code === 'implementation_drift');

      return {
        pass: versionUnchanged
          && savedSourceCommit === 'deadbeef0000'
          && restoreSummary.restored === 1
          && after?.reproduction?.status === 'recomputed_new'
          && after?.reproduction?.versionDrifted === false
          && after?.reproduction?.implementationDrifted === true
          && after?.reproduction?.savedSourceCommit === 'deadbeef0000'
          && Boolean(implementationWarning) && /analysis code has changed/i.test(implementationWarning?.message ?? '')
          && !/model_version/i.test(implementationWarning?.message ?? '')
          && restoreSummary.drifted.length === 1
          && restoreSummary.drifted[0].versionDrifted === false
          && restoreSummary.drifted[0].implementationDrifted === true,
        detail: JSON.stringify({ versionUnchanged, savedSourceCommit, reproduction: after?.reproduction, implementationWarning, drift: restoreSummary.drifted }),
      };
    } finally {
      pipeline.clear_state(row.name);
      app.get_file_map().delete(row.id);
      app.set_file_table(oldFrame);
      table.selected_file_ids.clear();
      oldSelected.forEach(id => table.selected_file_ids.add(id));
      plot.set_plot_channels(oldChannels);
      plot.set_plot_bins(oldBins);
      plot.set_analysis_domain_override(oldDomain.x_min, oldDomain.x_max);
    }
  });

  return results;
}"""


def run_state_reproducibility_tests(ctx: TestContext):
    """Run the STATE-01 settings and reproducibility assertions."""

    try:
        all_results = ctx.page.evaluate(_STATE_TESTS)
    except Exception as err:
        ctx.check(GROUP, "STATE-01 suite setup", False, str(err), screenshot=False)
        return

    for item in all_results:
        ctx.check(GROUP, item["name"], item["pass"], item.get("detail", ""), screenshot=False)
