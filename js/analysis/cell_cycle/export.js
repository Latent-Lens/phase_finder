// FEAT-02: versioned, machine-readable fit export. Everything a consumer needs
// to (a) re-run the fit and (b) independently check the arithmetic has to be
// present here -- and per docs/scientific-result-contract.md, a percentage
// without its provenance and trust state is not a reportable scientific
// result, so this module always carries convergence, goodness-of-fit,
// warnings, and validForReporting alongside the phase fractions. A CSV of
// bare percentages is exactly the failure mode WS-2 is fixing in the UI
// (UI-01); this export must not reintroduce it in file form.
//
// AD-5: this module is pure -- no DOM access, no imports from js/ui/ (not
// even transitively) -- so it loads and runs unmodified in the headless unit
// harness. All UI wiring (the download button, filenames, blob creation)
// lives in js/plotting/plot_export.js, which owns the DOM.

import { PHASEFINDER_VERSION, PHASEFINDER_SOURCE_COMMIT } from "../../util/build_info.js";

import { fraction_trust_reason } from "./result_contract.js";

export const EXPORT_FORMAT_VERSION = "1.1.0";

function export_curves(result) {
  const histogram = result?.histogramProvenance;
  if (!histogram) return result?.curves ?? null;
  const edges = histogram.binEdges;
  const fitted = result.expectedCounts;
  if (!edges?.length || edges.length !== fitted?.length + 1
      || histogram.counts?.length !== fitted.length) throw new Error("Fit histogram and curve lengths do not match.");
  const curves = {
    x: Array.from(fitted, (_, i) => (edges[i] + edges[i + 1]) / 2),
    observed: Array.from(histogram.counts), fitted: Array.from(fitted),
    residuals: Array.from(fitted, (value, i) => histogram.counts[i] - value),
  };
  for (const id of ["g1", "s", "g2"]) {
    const counts = result.components?.find(component => component.id === id)?.counts;
    if (counts?.length !== fitted.length) throw new Error(`Missing or mismatched ${id} component counts.`);
    curves[id] = Array.from(counts);
  }
  return curves;
}

/*

Purpose:
	Builds the versioned JSON export object for one sample's fit: enough to
	re-run the fit (model id/version/settings, domain, peak regions, QC) and
	enough to judge whether the numbers should be trusted (convergence,
	goodness-of-fit, warnings, validForReporting) alongside the phase
	fractions themselves.

Input:
	row [object]: the file-table row being exported (row.name, row.data)
	result [object]: a contracted model result (see result_contract.js);
	                  throws if absent
	options [object]: { includeCurves = true }: whether to embed the fitted
	                   curve arrays (can be large; omit for a compact export)

Output:
	export [object]: the versioned, JSON-serializable export payload

*/
export function build_fit_export(row, result, { includeCurves = true } = {}) {
  if (!result) throw new Error("No fit result to export.");
  return {
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    // Both the version and the source commit are recorded -- the commit is
    // what actually makes an export reproducible, since a version number
    // alone cannot identify which build produced it.
    application: { name: "PhaseFinder", version: PHASEFINDER_VERSION, sourceCommit: PHASEFINDER_SOURCE_COMMIT },
    sample: {
      name: row?.name ?? null,
      eventCount: row?.data?.eventCount ?? null,
      channel: row?.data?.channel_key ?? null,
    },
    model: {
      id: result.modelId ?? null,
      version: result.modelVersion ?? null,
      settings: result.appliedConfiguration ?? result.settings ?? null,
      settingsApplicability: result.settingsApplicability ?? null,
      configHash: result.configHash ?? null,
    },
    domain: {
      range: result.histogramProvenance ? [result.histogramProvenance.domain.min, result.histogramProvenance.domain.max] : result.analysisDomain ?? null,
      binCount: result.histogramProvenance?.binCount ?? result.binCount ?? null,
      underflow: result.histogramProvenance?.underflow ?? result.domainCoverage?.underflow ?? null,
      overflow: result.histogramProvenance?.overflow ?? result.domainCoverage?.overflow ?? null,
      componentTailCoverage: result.componentTailCoverage ?? result.domainCoverage?.componentTailCoverage ?? null,
    },
    histogramProvenance: result.histogramProvenance ?? null,
    peakRegions: result.peakRegions ?? null,
    qc: result.preflight?.qc ?? null,
    bulkRegionProvenance: result.bulkRegionProvenance ?? null,
    fit: {
      parameters: result.parameters ?? null,
      phaseFractions: result.phaseFractions ?? null,
      converged: result.converged ?? null,
      convergenceReason: result.convergenceReason ?? result.terminationReason ?? null,
      validForReporting: result.validForReporting ?? null,
      scientificallyValid: result.scientificallyValid ?? null,
      limitedReliability: result.limitedReliability ?? null,
      validityReasons: result.validityReasons ?? [],
      warnings: result.warnings ?? [],
      goodnessOfFit: result.goodnessOfFit ?? null,
      optimizerDiagnostics: result.diagnostics ?? result.optimizerDiagnostics ?? null,
      contractVersion: result.contractVersion ?? null,
    },
    curves: includeCurves ? export_curves(result) : null,
  };
}

// FE-028's fix, reused rather than reimplemented independently: a leading
// =, +, -, @, tab, or CR is how a spreadsheet decides a cell is a formula, so
// any of those first characters must be neutralized before the cell can be
// trusted to stay inert text when the CSV is opened in a spreadsheet. This
// mirrors js/io/metadata_io.js's tsv_cell() defense against the same bug
// class (FE-028). It is not imported directly: metadata_io.js transitively
// imports several js/ui/* modules that touch the DOM at module load, which
// AD-5 forbids in this file so it stays loadable in the headless unit
// harness. If that DOM coupling is ever broken up, this should import the
// shared primitive instead of re-declaring it.
function csvCell(value) {
  const text = String(value ?? "");
  return /^[=+\-@\t\r]/.test(text) ? `"'${text.replace(/"/g, '""')}"` : `"${text.replace(/"/g, '""')}"`;
}

/*

Purpose:
	Builds a long-form CSV (one row per histogram bin) of one sample's fit
	curves, suitable for independently recomputing the residuals. The column
	set is fixed regardless of bin count, so files from different samples or
	bin settings stay comparable.

Input:
	row [object]: the file-table row being exported (row.name)
	result [object]: a contracted model result whose result.curves carries
	                  parallel x/observed/fitted/g1/s/g2/residuals arrays;
	                  throws if curves are absent

Output:
	csv [string]: CSV text with a header row, "\n"-joined

*/
export function build_fit_csv(row, result) {
  const c = export_curves(result);
  if (!c?.x?.length) throw new Error("This fit has no curves to export.");
  const lines = [["sample", "model", "bin_center", "observed", "fitted", "g1", "s", "g2", "residual", "qualification", "warnings"].join(",")];
  for (let i = 0; i < c.x.length; i += 1) {
    lines.push([
      csvCell(row?.name),
      csvCell(result.modelId),
      c.x[i], c.observed[i], c.fitted[i], c.g1[i], c.s[i], c.g2[i], c.residuals[i],
      csvCell(fraction_trust_reason(result)), csvCell(JSON.stringify(result.warnings ?? [])),
    ].join(","));
  }
  return lines.join("\n");
}
