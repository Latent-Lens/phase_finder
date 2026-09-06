"""Focused browser checks: real downloads, malformed import, OPFS commit failure/retry.
Run directly between full regression batches. Uses synthetic data only.
"""
import csv
import io
import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests/e2e/driving_code'))
from test_server import start_test_server

SETUP = r'''async () => {
  const app = await import('/js/state/app_state.js');
  const table = await import('/js/data_structs/table_state.js');
  const {PhaseFinderFrame} = await import('/js/data_structs/metadata_frame.js');
  const plot = await import('/js/plotting/data.js');
  const pipeline = await (await import('/js/analysis/pipeline/pipeline_loader.js')).load_pipeline_silently();
  const modeling = await import('/js/analysis/cell_cycle/modeling_state.js');
  const registry = await import('/js/analysis/cell_cycle/model_registry.js');
  registry.register_default_models();
  let seed = 20260731;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const normal = () => Math.sqrt(-2 * Math.log(Math.max(random(), 1e-9))) * Math.cos(2 * Math.PI * random());
  const dna = Float64Array.from({length:4000}, (_, i) => i < 2400 ? 70 + 4 * normal() : i < 3000 ? 70 + 70 * (i - 2400) / 600 : 140 + 6 * normal());
  const row = {id:'batch', name:'E2E_batch.fcs', data:{eventCount:4000, channel_key:'DNA_A', dna_a:dna, channels:{DNA_A:dna}, pnr:{}}};
  app.get_file_map().set(row.id,row);
  app.set_file_table(new PhaseFinderFrame({id:[row.id],name:[row.name]},['id','name']));
  table.selected_file_ids.add(row.id);
  plot.set_plot_channels({dna_area:'DNA_A'});
  plot.set_plot_bins(128);
  plot.set_analysis_domain_override(0,220);
  pipeline.apply_structural_qc(row);
  pipeline.apply_dna_histogram(row,{binCount:128,range:[0,220]});
  modeling.update_peak_regions(row,{g1:{left:55,right:85},g2:{left:120,right:160}});
  pipeline.get_state(row.name).modeling.peakDetection = {status:'inferred_g2'};
  modeling.set_model_settings(row,{modelId:'dean_jett'});
  const result = await modeling.fit_cell_cycle_model(row,'dean_jett');
  await (await import("/js/plotting/render.js")).render_density_plot();
  window.batchRow = row;
  return result;
}'''

# Fail only the first commit, inside the real module worker and real OPFS API.
QUOTA = r'''
const originalDirectory = navigator.storage.getDirectory.bind(navigator.storage);
let failCommit = true;
function wrapDirectory(dir) {
  return {
    getDirectoryHandle: async (...args) => wrapDirectory(await dir.getDirectoryHandle(...args)),
    removeEntry: (...args) => dir.removeEntry(...args),
    getFileHandle: async (...args) => {
      const handle = await dir.getFileHandle(...args);
      return {createWritable: async () => {
        const stream = await handle.createWritable();
        return {write: (...args) => stream.write(...args), abort: () => stream.abort(), close: async () => {
          if (failCommit) { failCommit = false; throw new DOMException('Injected quota commit failure','QuotaExceededError'); }
          return stream.close();
        }};
      }};
    },
  };
}
Object.defineProperty(navigator.storage,'getDirectory',{value:async () => wrapDirectory(await originalDirectory())});
'''


def main():
    port, server = start_test_server(str(ROOT))
    try:
        with TemporaryDirectory() as directory, sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page()
            page.goto(f'http://127.0.0.1:{port}/?test=1', wait_until='networkidle')
            result = page.evaluate(SETUP)
            assert result['converged'] and result['validForReporting']
            first_exports = None
            for epoch in ('initial', 'restored'):
                if epoch == 'restored':
                    summary = page.evaluate('''async () => {
                      const core = await import('/js/session/core.js');
                      const toml = await import('/js/session/toml_io.js');
                      const session = await import('/js/session/modeling_session.js');
                      const pipeline = await (await import('/js/analysis/pipeline/pipeline_loader.js')).load_pipeline_silently();
                      const saved = toml.parse_session_toml(core.collect_session_toml());
                      pipeline.clear_state(window.batchRow.name);
                      pipeline.apply_structural_qc(window.batchRow);
                      const summary = await session.apply_modeling_session(saved.modeling);
                      await (await import('/js/plotting/render.js')).render_density_plot();
                      return summary;
                    }''')
                    assert summary['restored'] == 1 and summary['failed'] == 0, summary
                exports = {}
                for kind, extension in [('json','json'),('csv','csv'),('html','html'),('svg','svg')]:
                    with page.expect_download() as download:
                        page.evaluate('(kind) => import("/js/plotting/plot_export.js").then(m => m.export_plot_image(kind))', kind)
                    path = Path(directory) / ('fit.' + extension)
                    download.value.save_as(path)
                    exports[extension] = path.read_text()
                data = json.loads(exports['json'])
                assert data['model']['settings'] == result['appliedConfiguration']
                assert data['peakRegions'] == result['peakRegions']
                assert data['histogramProvenance'] == result['histogramProvenance']
                assert data['fit']['warnings'] == result['warnings']
                rows = list(csv.DictReader(io.StringIO(exports['csv'])))
                assert len(rows) == result['histogramProvenance']['binCount']
                for i, row in enumerate(rows):
                    assert float(row['fitted']) == result['expectedCounts'][i]
                    assert float(row['residual']) == result['histogramProvenance']['counts'][i] - result['expectedCounts'][i]
                    assert row['qualification'] and json.loads(row['warnings']) == result['warnings']
                    for phase in ('g1','s','g2'):
                        assert float(row[phase]) == next(c['counts'][i] for c in result['components'] if c['id'] == phase)
                for value in result['phaseFractions'].values():
                    assert f'{value * 100:.1f}% ⚠' in exports['html']
                    assert f'{value * 100:.1f}%' in exports['svg']
                data.pop('exportedAt')
                comparable = {'json': data, 'csv': exports['csv']}
                if first_exports is None:
                    first_exports = comparable
                else:
                    assert comparable == first_exports, 'Restored downloads differ from the original fit'
            # Reject malformed nested records via the real Load button before UI/config mutation.
            before = page.evaluate('() => import("/js/session/core.js").then(m=>m.collect_session_toml())')
            malformed = '[session]\ncreated = "2026-09-05"\n[files]\nnames = []\n[plot]\nbins = 1024\n[modeling]\nsamples = [1]\n'
            with page.expect_file_chooser() as chooser:
                page.click('#load_session_button')
            chooser.value.set_files({'name':'bad.toml','mimeType':'text/plain','buffer':malformed.encode()})
            expect(page.locator('#status_bar_message')).to_contain_text('modeling.samples[0]')
            after = page.evaluate('() => import("/js/session/core.js").then(m=>m.collect_session_toml())')
            # Created timestamps naturally change while all persisted state must stay unchanged.
            strip_created = lambda text: '\n'.join(line for line in text.splitlines() if not line.startswith(('# Created:', 'created =')))
            assert strip_created(before) == strip_created(after)
            # Worker commit failure must never catalogue a successful cached file; retry succeeds.
            page.route('**/js/session/copy_worker.js', lambda route: route.fulfill(
                status=200, content_type='text/javascript', body=QUOTA + (ROOT/'js/session/copy_worker.js').read_text()))
            failed = page.evaluate('''async () => {
              const cache=await import('/js/session/file_cache.js');
              const entry={id:'quota',file:new File(['synthetic bytes'],'E2E_quota.fcs')};
              window.quotaEntry=entry;
              cache.register_loaded_files([entry]); await cache.wait_for_cache_idle();
              const record=cache.file_records.get(entry.file.name);
              return {status:record.status,catalogued:Boolean(cache.read_cache_index().entries[record.opfs_path]),retained:entry.file.size};
            }''')
            assert failed == {'status':'error','catalogued':False,'retained':15}, failed
            expect(page.locator('#status_bar_message')).to_contain_text('Analysis remains available')
            recovered = page.evaluate('''async () => {
              const cache=await import('/js/session/file_cache.js');
              cache.file_records.delete(window.quotaEntry.file.name);
              cache.register_loaded_files([window.quotaEntry]); await cache.wait_for_cache_idle();
              const record=cache.file_records.get(window.quotaEntry.file.name);
              return {status:record.status,catalogued:Boolean(cache.read_cache_index().entries[record.opfs_path])};
            }''')
            assert recovered == {'status':'available','catalogued':True}, recovered
            # A browser-enforced quota, with no worker/API mocks, exercises the
            # actual storage failure and the same recovery message/retry path.
            quota_page = browser.new_page()
            origin = f'http://127.0.0.1:{port}'
            quota_page.goto(origin + '/?test=1', wait_until='networkidle')
            cdp = quota_page.context.new_cdp_session(quota_page)
            cdp.send('Storage.overrideQuotaForOrigin', {'origin': origin, 'quotaSize': 1024})
            try:
                actual_failure = quota_page.evaluate('''async () => {
                  const cache=await import('/js/session/file_cache.js');
                  window.realQuotaEntry={id:'real-quota',file:new File([new Uint8Array(1024*1024)],'E2E_real_quota.fcs')};
                  cache.register_loaded_files([window.realQuotaEntry]); await cache.wait_for_cache_idle();
                  const record=cache.file_records.get(window.realQuotaEntry.file.name);
                  return {status:record.status,catalogued:Boolean(cache.read_cache_index().entries[record.opfs_path])};
                }''')
                assert actual_failure == {'status':'error','catalogued':False}, actual_failure
                expect(quota_page.locator('#status_bar_message')).to_contain_text('Analysis remains available')
            finally:
                cdp.send('Storage.overrideQuotaForOrigin', {'origin': origin})
            actual_recovery = quota_page.evaluate('''async () => {
              const cache=await import('/js/session/file_cache.js');
              cache.file_records.delete(window.realQuotaEntry.file.name);
              cache.register_loaded_files([window.realQuotaEntry]); await cache.wait_for_cache_idle();
              const record=cache.file_records.get(window.realQuotaEntry.file.name);
              return {status:record.status,catalogued:Boolean(cache.read_cache_index().entries[record.opfs_path])};
            }''')
            assert actual_recovery == {'status':'available','catalogued':True}, actual_recovery
            browser.close()
            print('Focused batch checks passed: JSON/CSV/HTML/SVG downloads before/after restore, atomic malformed import, injected commit failure, browser-enforced quota failure and recovery.')
    finally:
        server.shutdown()
        server.server_close()

if __name__ == '__main__':
    main()
