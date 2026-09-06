# Run with .venv/bin/python; serves only the repository on loopback.
import json
from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT / "tests/e2e/driving_code"))
from test_server import start_test_server
port, server=start_test_server(ROOT)
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 page=browser.new_page()
 page.goto(f'http://127.0.0.1:{port}/tests/unit/test_harness.html')
 page.wait_for_function('window.CellCycleModelingState && window.CellCycleExport')
 result=page.evaluate('''async () => {
 const pipeline=window.PhaseFinder.pipeline, modeling=window.CellCycleModelingState;
 const dna=Float64Array.from({length:4000},(_,i)=>i<2400?70+4*Math.sin(i)*Math.sqrt(-2*Math.log((i%2399+1)/2400)):i<3000?70+70*(i-2400)/600:140+6*Math.sin(i)*Math.sqrt(-2*Math.log((i%999+1)/1000)));
 const row={id:'review-export',name:'review-export.fcs',data:{eventCount:dna.length,channel_key:'DNA_A',dna_a:dna,channels:{DNA_A:dna},pnr:{}}};
 pipeline.apply_structural_qc(row);pipeline.apply_dna_histogram(row,{binCount:128,range:[0,220]});modeling.detect_peak_regions(row);modeling.update_peak_regions(row,{g1:{left:55,right:85},g2:{left:120,right:160}});
 const fit=await modeling.fit_cell_cycle_model(row,'dean_jett');
 const out=window.CellCycleExport.build_fit_export(row,fit);
 let csv;try{csv=window.CellCycleExport.build_fit_csv(row,fit)}catch(e){csv=e.message}
 const contract=window.CellCycleResultContract;
 const flagged=contract.apply_result_contract({kind:'generative',converged:true,expectedCounts:[2,3,4],phaseFractions:{g1:.5,s:.3,g2:.2},diagnostics:{deviance:1},uncertainty:{warnings:[{id:'rank_deficient',severity:'critical',nonreportable:true}]},warnings:[{id:'rank_deficient',severity:'critical',message:'rank deficient'}]},{passed:true,reasons:[]});
 const schema=await import('/js/session/session_schema.js');
 let invalidSessionAccepted;try{schema.validate_session_draft({session:{created:'2026-09-05'},files:{names:[],records:[]},modeling:{samples:[null]}});invalidSessionAccepted=true}catch(e){invalidSessionAccepted=false}
 return {export:{converged:fit.converged,resultKeys:Object.keys(fit),model:out.model,domain:out.domain,peakRegions:out.peakRegions,curves:out.curves,csv},trust:{validForReporting:flagged.validForReporting,scientificallyValid:flagged.scientificallyValid,fractionTrustReason:contract.fraction_trust_reason(flagged)},invalidSessionAccepted};
}''')
 print(json.dumps(result,indent=2))
 browser.close()

server.shutdown()
server.server_close()
