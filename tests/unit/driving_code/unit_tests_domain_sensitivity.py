#!/usr/bin/env python3
"""DOMAIN-01 regression coverage: the analysis domain and bin grid are treated as
scientific inputs.

Covers the two halves of js/analysis/cell_cycle/domain_sensitivity.js -- the
cheap per-fit coverage audit (how much of the sample and of the fitted model the
domain excluded, against documented thresholds) and the opt-in sensitivity sweep
(how far the answer moves under re-binning and bounded domain trims) -- plus the
provenance the fit entry point now stores so a reviewer can reconstruct the exact
grid a number was computed on."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "e2e"))

from helpers import TestContext


GROUP = "Unit / DOMAIN-01 Analysis Domain"


_DOMAIN_TESTS = r"""async () => {
  const domain = window.CellCycleDomainSensitivity;
  const contract = window.CellCycleResultContract;

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

  // ---- coverage audit: excluded observed events -------------------------

  const provenance = (underflow, overflow, retained) => ({
    underflow, overflow, retained, retainedCount: retained,
    binnedCount: retained - underflow - overflow,
  });

  await run('DOMAIN-01: a domain that excludes nothing is clean', () => {
    const audit = domain.domainCoverageAudit({
      histogramProvenance: provenance(0, 0, 10000),
      components: [{ id: 'g1', totalArea: 5000, observedDomainArea: 5000 }],
    });
    return {
      pass: audit.excludedObserved.fraction === 0
        && audit.excludedObserved.status === 'ok'
        && audit.status === 'ok'
        && audit.warnings.length === 0,
      detail: JSON.stringify(audit.excludedObserved),
    };
  });

  await run('DOMAIN-01: excluded observed events above the warning threshold warn with exact counts', () => {
    // 1% excluded: above the 0.5% warning floor, below the 5% block level.
    const audit = domain.domainCoverageAudit({
      histogramProvenance: provenance(60, 40, 10000),
      components: [{ id: 'g1', totalArea: 5000, observedDomainArea: 5000 }],
    });
    const warning = audit.warnings.find((entry) => entry.code === 'domain_excludes_some_observed_events');
    return {
      pass: audit.excludedObserved.count === 100
        && Math.abs(audit.excludedObserved.fraction - 0.01) < 1e-12
        && audit.excludedObserved.status === 'warning'
        && audit.status === 'warning'
        && !!warning && warning.severity === 'warning'
        && /100 of 10000/.test(warning.message),
      detail: JSON.stringify({ excluded: audit.excludedObserved, warning }),
    };
  });

  await run('DOMAIN-01: excluded observed events above the invalid threshold are an error', () => {
    const audit = domain.domainCoverageAudit({
      histogramProvenance: provenance(500, 300, 10000),
      components: [{ id: 'g1', totalArea: 5000, observedDomainArea: 5000 }],
    });
    return {
      pass: audit.excludedObserved.status === 'invalid'
        && audit.status === 'invalid'
        && audit.warnings.some((entry) => entry.code === 'domain_excludes_observed_events' && entry.severity === 'error'),
      detail: JSON.stringify(audit.excludedObserved),
    };
  });

  await run('DOMAIN-01: the documented thresholds travel with the audit', () => {
    const audit = domain.domainCoverageAudit({ histogramProvenance: provenance(0, 0, 100), components: [] });
    return {
      pass: audit.thresholds.excludedObservedWarning === domain.EXCLUDED_OBSERVED_WARNING_FRACTION
        && audit.thresholds.excludedObservedInvalid === domain.EXCLUDED_OBSERVED_INVALID_FRACTION
        && audit.thresholds.modelledTailWarning === domain.MODELLED_TAIL_WARNING_FRACTION
        && audit.thresholds.modelledTailInvalid === domain.MODELLED_TAIL_INVALID_FRACTION,
      detail: JSON.stringify(audit.thresholds),
    };
  });

  // ---- coverage audit: modelled mass outside the domain -----------------

  await run('DOMAIN-01: per-component tail coverage is recorded for every component', () => {
    const audit = domain.domainCoverageAudit({
      histogramProvenance: provenance(0, 0, 10000),
      components: [
        { id: 'g1', totalArea: 5000, observedDomainArea: 5000 },
        { id: 's', totalArea: 2000, observedDomainArea: 1960 },
        { id: 'g2', totalArea: 3000, observedDomainArea: 2850 },
      ],
    });
    return {
      pass: audit.componentTailCoverage.g1 === 1
        && Math.abs(audit.componentTailCoverage.s - 0.98) < 1e-12
        && Math.abs(audit.componentTailCoverage.g2 - 0.95) < 1e-12
        && audit.modelledTail.byComponent.g2.status === 'warning'
        && audit.modelledTail.byComponent.g1.status === 'ok',
      detail: JSON.stringify(audit.componentTailCoverage),
    };
  });

  await run('DOMAIN-01: a component with most of its mass outside the domain is invalid', () => {
    const audit = domain.domainCoverageAudit({
      histogramProvenance: provenance(0, 0, 10000),
      components: [
        { id: 'g1', totalArea: 5000, observedDomainArea: 5000 },
        { id: 'g2', totalArea: 3000, observedDomainArea: 2400 }, // 20% outside
      ],
    });
    return {
      pass: audit.modelledTail.status === 'invalid'
        && audit.status === 'invalid'
        && audit.warnings.some((entry) => entry.code === 'modelled_mass_outside_domain' && entry.severity === 'error'),
      detail: JSON.stringify(audit.modelledTail),
    };
  });

  // ---- sensitivity sweep -------------------------------------------------

  const syntheticValues = () => {
    let seed = 424242;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const normal = () => Math.sqrt(-2 * Math.log(Math.max(random(), 1e-9))) * Math.cos(2 * Math.PI * random());
    const values = [];
    for (let i = 0; i < 6000; i += 1) values.push(100 + 5 * normal());
    for (let i = 0; i < 1500; i += 1) values.push(100 + 100 * random());
    for (let i = 0; i < 2500; i += 1) values.push(200 + 8 * normal());
    return values;
  };

  await run('DOMAIN-01: a stable answer passes the sensitivity sweep', () => {
    // A fitFn whose fractions do not depend on the grid at all: the sweep must
    // report zero movement and an ok status, so a nonzero result later is
    // attributable to the fit, not to the harness.
    const analysis = domain.analyzeDomainSensitivity({
      values: syntheticValues(),
      domain: { min: 0, max: 400 },
      fitFn: () => ({ phaseFractions: { g1: 0.6, s: 0.15, g2: 0.25 }, modelId: 'dean_jett' }),
    });
    return {
      pass: analysis.maxShiftPercentagePoints === 0
        && analysis.status === 'ok'
        && analysis.modelChoiceStable === true
        && analysis.warnings.length === 0
        && analysis.variants.length === 12,
      detail: JSON.stringify({ shift: analysis.maxShiftPercentagePoints, variants: analysis.variants.length }),
    };
  });

  await run('DOMAIN-01: a grid-dependent answer is flagged against the documented tolerance', () => {
    // %S drifts with bin count -- exactly the failure the sweep exists to catch.
    const analysis = domain.analyzeDomainSensitivity({
      values: syntheticValues(),
      domain: { min: 0, max: 400 },
      fitFn: (histogram) => {
        const drift = histogram.binCount === 64 ? 0 : histogram.binCount === 128 ? 0.03 : 0.07;
        return { phaseFractions: { g1: 0.6 - drift, s: 0.15 + drift, g2: 0.25 }, modelId: 'dean_jett' };
      },
    });
    return {
      pass: analysis.status === 'invalid'
        && analysis.maxShiftPercentagePoints > domain.FRACTION_SENSITIVITY_INVALID_PP
        && analysis.byPhase.s > analysis.byPhase.g2
        && analysis.warnings.some((entry) => entry.code === 'domain_sensitivity_excessive'),
      detail: JSON.stringify({ shift: analysis.maxShiftPercentagePoints, byPhase: analysis.byPhase }),
    };
  });

  await run('DOMAIN-01: a movement between the two tolerances warns rather than blocks', () => {
    const analysis = domain.analyzeDomainSensitivity({
      values: syntheticValues(),
      domain: { min: 0, max: 400 },
      fitFn: (histogram) => {
        const drift = histogram.binCount === 256 ? 0.03 : 0;
        return { phaseFractions: { g1: 0.6 - drift, s: 0.15 + drift, g2: 0.25 }, modelId: 'dean_jett' };
      },
    });
    return {
      pass: analysis.status === 'warning'
        && analysis.maxShiftPercentagePoints >= domain.FRACTION_SENSITIVITY_WARNING_PP
        && analysis.maxShiftPercentagePoints < domain.FRACTION_SENSITIVITY_INVALID_PP
        && analysis.warnings.some((entry) => entry.code === 'domain_sensitivity_material'),
      detail: JSON.stringify({ shift: analysis.maxShiftPercentagePoints, status: analysis.status }),
    };
  });

  await run('DOMAIN-01: unstable automatic model choice across the sweep is reported', () => {
    const analysis = domain.analyzeDomainSensitivity({
      values: syntheticValues(),
      domain: { min: 0, max: 400 },
      fitFn: (histogram) => ({
        phaseFractions: { g1: 0.6, s: 0.15, g2: 0.25 },
        modelId: histogram.binCount === 256 ? 'dean_jett_fox' : 'dean_jett',
      }),
    });
    return {
      pass: analysis.modelChoiceStable === false
        && analysis.modelChoices.length === 2
        && analysis.status === 'warning'
        && analysis.warnings.some((entry) => entry.code === 'domain_sensitivity_model_choice'),
      detail: JSON.stringify(analysis.modelChoices),
    };
  });

  await run('DOMAIN-01: the sweep really re-bins (variants differ in bin count and domain)', () => {
    const seen = [];
    domain.analyzeDomainSensitivity({
      values: syntheticValues(),
      domain: { min: 0, max: 400 },
      fitFn: (histogram) => {
        seen.push({ bins: histogram.counts.length, min: histogram.min, max: histogram.max });
        return { phaseFractions: { g1: 0.6, s: 0.15, g2: 0.25 }, modelId: 'dean_jett' };
      },
    });
    const binCounts = [...new Set(seen.map((entry) => entry.bins))].sort((a, b) => a - b);
    const domains = [...new Set(seen.map((entry) => `${entry.min}:${entry.max}`))];
    return {
      pass: JSON.stringify(binCounts) === JSON.stringify([64, 128, 256]) && domains.length === 4,
      detail: JSON.stringify({ binCounts, domains }),
    };
  });

  await run('DOMAIN-01: a variant that throws is recorded, not silently dropped from the verdict', () => {
    const analysis = domain.analyzeDomainSensitivity({
      values: syntheticValues(),
      domain: { min: 0, max: 400 },
      fitFn: (histogram) => {
        if (histogram.counts.length === 256) throw new Error('no valid model at 256 bins');
        return { phaseFractions: { g1: 0.6, s: 0.15, g2: 0.25 }, modelId: 'dean_jett' };
      },
    });
    const failed = analysis.variants.filter((variant) => variant.error);
    return {
      pass: failed.length === 4 && failed.every((variant) => /no valid model/.test(variant.error)),
      detail: JSON.stringify(failed.map((variant) => variant.label)),
    };
  });

  // ---- provenance stored by the real fit entry point ---------------------

  await run('DOMAIN-01: a real fit stores its exact domain, bin grid, and exclusion counts', () => {
    const pipeline = window.PhaseFinder.pipeline;
    const modelingState = window.CellCycleModelingState;
    const count = 4000;
    const dna = new Float64Array(count);
    let seed = 20260731;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const normal = () => Math.sqrt(-2 * Math.log(Math.max(random(), 1e-9))) * Math.cos(2 * Math.PI * random());
    for (let i = 0; i < count; i += 1) {
      dna[i] = i < 2400 ? 70 + 4 * normal() : i < 3000 ? 70 + (70 * (i - 2400)) / 600 : 140 + 6 * normal();
    }
    const row = {
      id: 'domain-01-row', name: 'domain-01.fcs',
      data: { eventCount: count, channel_key: 'DNA_A', dna_a: dna, channels: { DNA_A: dna }, pnr: {} },
    };
    pipeline.clear_state(row.name);
    pipeline.apply_structural_qc(row);
    pipeline.apply_dna_histogram(row, { binCount: 128, range: [0, 220] });
    modelingState.detect_peak_regions(row);
    modelingState.update_peak_regions(row, { g1: { left: 55, right: 85 }, g2: { left: 120, right: 160 } });

    return modelingState.fit_cell_cycle_model(row, 'dean_jett').then((result) => {
      const p = result.histogramProvenance;
      return {
        pass: !!p
          && p.domain.min === 0 && p.domain.max === 220 && p.domain.binCount === 128
          && p.binEdges.length === 129
          && Number.isFinite(p.underflow) && Number.isFinite(p.overflow)
          && p.underflow + p.binnedCount + p.overflow === p.retainedCount
          && p.componentTailCoverage !== null
          && ['g1', 's', 'g2'].every((id) => Number.isFinite(p.componentTailCoverage[id]))
          && !!result.domainCoverage
          && result.domainCoverage.thresholds.excludedObservedInvalid === domain.EXCLUDED_OBSERVED_INVALID_FRACTION,
        detail: JSON.stringify({
          domain: p?.domain, edges: p?.binEdges.length,
          funnel: [p?.underflow, p?.binnedCount, p?.overflow, p?.retainedCount],
          coverage: p?.componentTailCoverage,
        }),
      };
    });
  });

  await run('DOMAIN-01: an invalid coverage verdict withholds the result from reporting', () => {
    // Applied directly to a contracted result, so the assertion is about the
    // qualification rule and not about coaxing a real fit into a bad domain.
    const applied = contract.apply_result_contract({
      kind: 'generative', modelId: 'dean_jett', converged: true, cancelled: false,
      expectedCounts: [4, 5, 6], phaseFractions: { g1: 0.5, s: 0.3, g2: 0.2 },
      diagnostics: { deviance: 10 },
    }, { passed: true, reasons: [] });
    const audit = domain.domainCoverageAudit({
      histogramProvenance: provenance(900, 200, 10000),
      components: [{ id: 'g1', totalArea: 5000, observedDomainArea: 5000 }],
    });
    return {
      pass: applied.validForReporting === true && audit.status === 'invalid' && audit.warnings.length > 0,
      detail: JSON.stringify({ contractOnly: applied.validForReporting, coverage: audit.status }),
    };
  });

  return results;
}"""


def run_domain_sensitivity_tests(ctx: TestContext):
    """Run the DOMAIN-01 coverage and sensitivity assertions."""

    try:
        all_results = ctx.page.evaluate(_DOMAIN_TESTS)
    except Exception as err:
        ctx.check(GROUP, "DOMAIN-01 suite setup", False, str(err), screenshot=False)
        return

    for item in all_results:
        ctx.check(GROUP, item["name"], item["pass"], item.get("detail", ""), screenshot=False)
