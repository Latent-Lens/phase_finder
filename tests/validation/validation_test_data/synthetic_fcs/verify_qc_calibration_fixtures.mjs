#!/usr/bin/env node
// Runs the REAL production QC/gating detectors -- runTimeQC(), gateByPulseGeometry(),
// and gateMainBiologicalCloud() -- against the synthetic, labelled QC-CAL-01
// calibration fixtures in qc_calibration/, and checks each fixture's own targeted
// disturbance is actually detected (and that the negative-control/off-target
// fixtures do not false-positive above a sensible bar).
//
// The three gates are run INDEPENDENTLY against each dataset (no upstream mask
// chaining) so a fixture's own injected signal is evaluated without confounding
// from another gate's masking decisions. This is a calibration check on the
// fixtures/detectors, not a reproduction of the production pipeline's gate order.
//
// These fixtures are SYNTHETIC with injected known truth (see manifest.json's
// "disclaimer"), not real instrument acquisitions -- this script measures
// detection behavior against that known truth, not against biological reality.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../..");

// acquisition_time_qc.js/pulse_geometry_gate.js/scatter_gmm_gate.js import
// sibling modules by relative specifier ("../math/stats.js" etc.). A data:
// URL module has no base path, so it can't resolve those on its own -- and
// pointing them at real file:// URLs doesn't work either, since package.json
// declares "type": "commonjs" and Node then refuses to treat plain .js files
// as ESM (named exports come back as undefined). So the whole dependency
// graph is walked and each file is re-encoded as its own data: URL, which
// Node always treats as ESM regardless of package.json.
const moduleUrlCache = new Map();

async function loadAsDataUrl(absolutePath) {
  if (moduleUrlCache.has(absolutePath)) return moduleUrlCache.get(absolutePath);
  const source = await readFile(absolutePath, "utf8");
  const specifiers = [...source.matchAll(/from\s+["'](\.[^"']+)["']/g)].map(([, specifier]) => specifier);
  const dependencyUrls = await Promise.all(
    specifiers.map(specifier => loadAsDataUrl(path.join(path.dirname(absolutePath), specifier))));
  let index = 0;
  const rewritten = source.replace(/from\s+["'](\.[^"']+)["']/g, () => `from "${dependencyUrls[index++]}"`);
  const url = `data:text/javascript;base64,${Buffer.from(rewritten).toString("base64")}`;
  moduleUrlCache.set(absolutePath, url);
  return url;
}

async function importAppModule(relativePath) {
  return import(await loadAsDataUrl(path.join(root, relativePath)));
}

const { FCSParser } = await importAppModule("js/fcs/parser.js");
const { runTimeQC } = await importAppModule("js/analysis/qc/acquisition_time_qc.js");
const { gateByPulseGeometry } = await importAppModule("js/analysis/gating/pulse_geometry_gate.js");
const { gateMainBiologicalCloud } = await importAppModule("js/analysis/gating/scatter_gmm_gate.js");

const CHANNEL_KEY_MAPPING = { "DNA-A": "DNA_A", "DNA-H": "DNA_H", "DNA-W": "DNA_W", "FSC-A": "FSC_A", "SSC-A": "SSC_A", Time: "Time" };
const TIME_PARAMETER_INDEX = 6; // fixed parameter order the generator writes: DNA-A,DNA-H,DNA-W,FSC-A,SSC-A,Time

function buildDataset(rows, metadata) {
  const channels = {};
  for (const [rawName, key] of Object.entries(CHANNEL_KEY_MAPPING)) {
    channels[key] = rows.map(row => row[rawName]);
  }
  const pnrTime = Number(metadata[`P${TIME_PARAMETER_INDEX}R`]);
  return { channels, eventCount: rows.length, pnr: { Time: pnrTime } };
}

function confusionRates(mask, positiveIndices) {
  const positiveSet = new Set(positiveIndices);
  let truePositive = 0, falseNegative = 0, falsePositive = 0, trueNegative = 0;
  for (let index = 0; index < mask.length; index++) {
    const flaggedAsPositive = mask[index] === 0; // rejected by the gate
    const actuallyPositive = positiveSet.has(index);
    if (actuallyPositive && flaggedAsPositive) truePositive++;
    else if (actuallyPositive && !flaggedAsPositive) falseNegative++;
    else if (!actuallyPositive && flaggedAsPositive) falsePositive++;
    else trueNegative++;
  }
  const recall = truePositive + falseNegative > 0 ? truePositive / (truePositive + falseNegative) : NaN;
  const falsePositiveRate = falsePositive + trueNegative > 0 ? falsePositive / (falsePositive + trueNegative) : NaN;
  return { truePositive, falseNegative, falsePositive, trueNegative, recall, falsePositiveRate };
}

function intervalsOverlapRange(flaggedIntervals, range) {
  const [start, end] = range;
  if (!flaggedIntervals?.length) return false;
  // firstEventIndex/lastEventIndex are original event indexes (mergeFlaggedBins);
  // our fixtures keep acquisition order == original index order, so a direct
  // range overlap check against the injected disturbance window is valid.
  return flaggedIntervals.some(interval =>
    interval.firstEventIndex < end && interval.lastEventIndex >= start);
}

const manifestPath = path.join(here, "qc_calibration", "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

let failures = 0;
const rows_report = [];

for (const [name, truth] of Object.entries(manifest.fixtures)) {
  const fcsPath = path.join(here, "qc_calibration", truth.path);
  const buffer = (await readFile(fcsPath)).buffer;
  const { rows, metadata } = FCSParser.parse_fcs(buffer);
  const dataset = buildDataset(rows, metadata);

  const timeQC = runTimeQC(dataset);
  const pulseGate = gateByPulseGeometry(dataset);
  const scatterGate = gateMainBiologicalCloud(dataset);

  const doubletStats = confusionRates(pulseGate.singletMask ?? pulseGate.mask, truth.doublet_event_indices);
  const debrisStats = confusionRates(scatterGate.mask, truth.debris_event_indices);

  const report = {
    fixture: name,
    category: truth.category,
    timeQC: {
      status: timeQC.status,
      segmentCount: timeQC.segmentCount,
      flaggedIntervalCount: timeQC.flaggedIntervals?.length ?? 0,
      limitedReliability: timeQC.limitedReliability,
    },
    pulseGeometry: {
      status: pulseGate.status,
      recall: doubletStats.recall,
      falsePositiveRate: doubletStats.falsePositiveRate,
    },
    scatterGate: {
      status: scatterGate.status,
      recall: debrisStats.recall,
      falsePositiveRate: debrisStats.falsePositiveRate,
    },
  };
  rows_report.push(report);

  const assertTrue = (condition, message) => {
    if (!condition) {
      failures++;
      console.error(`FAIL [${name}]: ${message}`);
    }
  };

  if (truth.category === "stable") {
    assertTrue((timeQC.flaggedIntervals?.length ?? 0) === 0,
      "expected no flagged Time QC intervals on the stable baseline");
    assertTrue(timeQC.segmentCount === 1, `expected a single acquisition segment, got ${timeQC.segmentCount}`);
    assertTrue(!(doubletStats.falsePositiveRate > 0.15), `pulse-geometry false-positive rate too high at baseline (${doubletStats.falsePositiveRate})`);
    assertTrue(!(debrisStats.falsePositiveRate > 0.15), `scatter-gate false-positive rate too high at baseline (${debrisStats.falsePositiveRate})`);
  } else if (truth.category === "clog" || truth.category === "dropout") {
    const range = truth.injected_disturbance.affected_event_index_range
      ?? [truth.injected_disturbance.gap_inserted_before_event_index - 1, truth.injected_disturbance.gap_inserted_before_event_index + 1];
    assertTrue(intervalsOverlapRange(timeQC.flaggedIntervals, range),
      `expected a flagged Time QC interval overlapping ${JSON.stringify(range)}`);
  } else if (truth.category === "timer_rollover") {
    assertTrue(timeQC.segmentCount === truth.expected_segment_count,
      `expected segmentCount ${truth.expected_segment_count}, got ${timeQC.segmentCount}`);
    assertTrue((timeQC.flaggedIntervals?.length ?? 0) === 0,
      "expected no false-positive flags purely from timer wraps");
  } else if (truth.category === "backward_time_jump") {
    assertTrue(timeQC.segmentCount === truth.expected_segment_count,
      `expected segmentCount ${truth.expected_segment_count}, got ${timeQC.segmentCount}`);
    assertTrue(timeQC.limitedReliability === true,
      "expected limitedReliability from segmentCount > 1");
  } else if (truth.category === "doublet_heavy") {
    assertTrue(doubletStats.recall > 0.5, `expected pulse-geometry recall > 0.5 on doublet-heavy, got ${doubletStats.recall}`);
  } else if (truth.category === "debris_dominant") {
    // Confirmed calibration finding, not a hedge: gateMainBiologicalCloud picks
    // its "main" component purely by population weight, so once debris is a
    // genuine majority it selects the debris cluster as "main" and rejects the
    // live cells instead -- recall collapses and the false-positive rate
    // approaches 1. This asserts that documented inversion keeps happening, so
    // a future fix to the selection rule (or a regression that makes it worse)
    // shows up here rather than silently passing.
    assertTrue(!scatterGate.skipped, "expected the scatter gate to run (not skip) on the debris-dominant fixture");
    assertTrue(debrisStats.recall < 0.5,
      `expected the weight-based main-component selection to invert (recall < 0.5) with debris as the majority, got ${debrisStats.recall}`);
    assertTrue(debrisStats.falsePositiveRate > 0.5,
      `expected most live-cell events to be misflagged (false-positive rate > 0.5) under the same inversion, got ${debrisStats.falsePositiveRate}`);
  }
}

console.log(JSON.stringify(rows_report, null, 2));
if (failures > 0) {
  console.error(`\n${failures} calibration expectation(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS: all ${rows_report.length} QC-calibration fixtures matched their expected detector behavior.`);
