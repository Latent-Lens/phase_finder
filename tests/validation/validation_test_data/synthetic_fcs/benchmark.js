import { FCSParser } from "/js/fcs/parser.js";
import { generateHistogram } from "/js/analysis/pipeline/dna_histogram.js";
import {
  get_model,
  register_default_models,
} from "/js/analysis/cell_cycle/model_registry.js";
import { runStructuralQC } from "/js/analysis/qc/structural_qc.js";
import { runTimeQC } from "/js/analysis/qc/acquisition_time_qc.js";
import { runPeakTrackingTimeQC } from "/js/analysis/qc/peak_tracking_time_qc.js";
import { gateMainBiologicalCloud } from "/js/analysis/gating/scatter_gmm_gate.js";
import { gateByPulseGeometry } from "/js/analysis/gating/pulse_geometry_gate.js";

const DEFAULT_MODELS = [
  "dean_jett",
  "dean_jett_fox",
  "watson_pragmatic",
  "watson_classic",
];

const state = {
  manifest: null,
  manifestSha256: null,
  running: false,
  result: null,
};

const elements = {
  status: document.querySelector("#status"),
  progress: document.querySelector("#progress"),
  parserBody: document.querySelector("#parser-results tbody"),
  qcBody: document.querySelector("#qc-results tbody"),
  modelBody: document.querySelector("#model-results tbody"),
  runAll: document.querySelector("#run-all"),
  runQc: document.querySelector("#run-qc"),
  runModels: document.querySelector("#run-models"),
  runParser: document.querySelector("#run-parser"),
  download: document.querySelector("#download-results"),
  modelChoices: document.querySelector("#model-choices"),
};

function setStatus(message, kind = "") {
  elements.status.textContent = message;
  elements.status.dataset.kind = kind;
}

function setProgress(done, total, label = "") {
  elements.progress.max = Math.max(1, total);
  elements.progress.value = done;
  elements.progress.setAttribute("aria-valuetext", `${done} of ${total}: ${label}`);
}

function pauseForPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function percent(value) {
  return Number.isFinite(value) ? (100 * value).toFixed(2) : "—";
}

function number(value, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : "—";
}

function appendCell(row, value, className = "") {
  const cell = document.createElement("td");
  cell.textContent = String(value ?? "");
  if (className) cell.className = className;
  row.append(cell);
}

function statusClass(status) {
  if (status === "PASS") return "pass";
  if (status === "EXPOSED" || status === "DEVIATION") return "exposed";
  if (status === "SKIP" || status === "DIAGNOSTIC") return "skip";
  return "fail";
}

function renderParserResult(result) {
  const row = document.createElement("tr");
  appendCell(row, result.id);
  appendCell(row, result.expected);
  appendCell(row, result.observed);
  appendCell(row, result.status, statusClass(result.status));
  appendCell(row, result.detail);
  elements.parserBody.append(row);
}

function renderModelResult(result) {
  const row = document.createElement("tr");
  appendCell(row, result.id);
  appendCell(row, result.view);
  appendCell(row, result.modelId);
  appendCell(row, `${percent(result.truth.g1)} / ${percent(result.truth.s)} / ${percent(result.truth.g2)}`);
  appendCell(row, result.fitted ? `${percent(result.fitted.g1)} / ${percent(result.fitted.s)} / ${percent(result.fitted.g2)}` : "—");
  appendCell(row, Number.isFinite(result.maxAbsoluteErrorPercentagePoints) ? number(result.maxAbsoluteErrorPercentagePoints) : "—");
  appendCell(row, result.converged == null ? "—" : result.converged ? "yes" : "no");
  appendCell(row, result.status, statusClass(result.status));
  appendCell(row, result.detail);
  elements.modelBody.append(row);
}

function renderQcResult(result) {
  const row = document.createElement("tr");
  appendCell(row, result.id);
  appendCell(row, result.kind);
  appendCell(row, result.goodRetention == null ? "—" : percent(result.goodRetention));
  appendCell(row, result.badRejection == null ? "—" : percent(result.badRejection));
  appendCell(row, result.status, statusClass(result.status));
  appendCell(row, result.detail);
  elements.qcBody.append(row);
}

async function fetchArrayBuffer(relativePath) {
  const response = await fetch(new URL(relativePath, window.location.href));
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${relativePath}`);
  return response.arrayBuffer();
}

function approximatelyEqual(actual, expected) {
  const scale = Math.max(1, Math.abs(expected));
  return Math.abs(actual - expected) <= 1e-7 * scale;
}

function sameDecodedValue(left, right) {
  return (Number.isNaN(left) && Number.isNaN(right)) || Object.is(left, right);
}

function errorCode(error) {
  return typeof error?.code === "string" ? error.code : null;
}

function describeError(error) {
  const code = errorCode(error);
  return `${code ? `${code} / ` : "untyped / "}${error?.name ?? "Error"}: ${error?.message ?? String(error)}`;
}

function rejectionResult(entry, error, observedPhase) {
  const expectation = entry.parser_expectation;
  const phaseMatches = observedPhase === expectation.phase;
  const codeMatches = errorCode(error) === expectation.code;
  return {
    id: entry.id,
    expected: `${expectation.outcome} @ ${expectation.phase} (${expectation.code})`,
    observed: `rejected @ ${observedPhase} (${errorCode(error) ?? "untyped"})`,
    expectedPhase: expectation.phase,
    expectedCode: expectation.code,
    observedPhase,
    observedCode: errorCode(error),
    status: phaseMatches && codeMatches ? "PASS" : "EXPOSED",
    detail: `${describeError(error)}${phaseMatches ? "" : `; expected phase ${expectation.phase}`}${codeMatches ? "" : `; expected code ${expectation.code}`}`,
  };
}

async function sha256Float32(values) {
  const bytes = new ArrayBuffer(values.length * 4);
  const view = new DataView(bytes);
  for (let index = 0; index < values.length; index += 1) {
    if (Number.isNaN(values[index])) {
      view.setUint32(index * 4, 0x7fc00000, true);
    } else {
      view.setFloat32(index * 4, values[index], true);
    }
  }
  return sha256ArrayBuffer(bytes);
}

async function sha256ArrayBuffer(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function requireFixtureHash(entry, buffer) {
  const actual = await sha256ArrayBuffer(buffer);
  if (actual !== entry.fcs?.sha256) {
    throw new Error(`FCS SHA-256 ${actual}, expected ${entry.fcs?.sha256 ?? "missing"}`);
  }
}

async function fetchVerifiedTruth(entry) {
  if (!entry.truth_file || !entry.truth_sha256) {
    throw new Error(`Fixture ${entry.id} has no hash-pinned truth sidecar.`);
  }
  const bytes = await fetchArrayBuffer(entry.truth_file);
  const actual = await sha256ArrayBuffer(bytes);
  if (actual !== entry.truth_sha256) {
    throw new Error(`Truth SHA-256 ${actual}, expected ${entry.truth_sha256}`);
  }
  return JSON.parse(new TextDecoder("utf-8").decode(bytes));
}

async function validateLoadedParserCase(entry, buffer, summary, parsed) {
  const problems = [];
  const expectedEvents = entry.fcs?.events;
  if (Number.isInteger(expectedEvents)) {
    if (summary.event_count !== expectedEvents) {
      problems.push(`header event_count=${summary.event_count}, expected ${expectedEvents}`);
    }
    if (parsed.rows.length !== expectedEvents) {
      problems.push(`decoded rows=${parsed.rows.length}, expected ${expectedEvents}`);
    }
  }
  if (summary.parameter_count !== parsed.columns.length) {
    problems.push(`header parameters=${summary.parameter_count}, decoded columns=${parsed.columns.length}`);
  }

  const declaredChannels = entry.fcs?.channels ?? [];
  if (declaredChannels.length) {
    const observedChannels = Array.from(
      { length: summary.parameter_count },
      (_, index) => summary.metadata[`P${index + 1}N`] ?? null,
    );
    if (JSON.stringify(observedChannels) !== JSON.stringify(declaredChannels)) {
      problems.push(`PnN channels=${JSON.stringify(observedChannels)}, expected ${JSON.stringify(declaredChannels)}`);
    }
  }

  const metadataChecks = entry.parser_expectation?.metadata ?? {};
  for (const [key, expectedValue] of Object.entries(metadataChecks)) {
    if (parsed.metadata[key] !== expectedValue) {
      problems.push(`metadata ${key}=${JSON.stringify(parsed.metadata[key])}, expected ${JSON.stringify(expectedValue)}`);
    }
  }
  const firstRowChecks = entry.parser_expectation?.first_row ?? {};
  for (const [key, expectedValue] of Object.entries(firstRowChecks)) {
    const actual = parsed.rows[0]?.[key];
    if (!Number.isFinite(actual) || !approximatelyEqual(actual, expectedValue)) {
      problems.push(`row[0].${key}=${actual}, expected ${expectedValue}`);
    }
  }

  const dataBuffer = buffer.slice(summary.data_begin, summary.data_end + 1);
  const indexes = Array.from({ length: summary.parameter_count }, (_, index) => index + 1);
  const selected = FCSParser.parse_selected_columns(dataBuffer, summary.metadata, indexes);
  for (let parameterIndex = 0; parameterIndex < parsed.columns.length; parameterIndex += 1) {
    const column = parsed.columns[parameterIndex];
    const selectedValues = selected[parameterIndex + 1];
    if (!selectedValues || selectedValues.length !== parsed.rows.length) {
      problems.push(`selected-column ${parameterIndex + 1} length mismatch`);
      continue;
    }
    const mismatch = selectedValues.findIndex(
      (value, eventIndex) => !sameDecodedValue(value, parsed.rows[eventIndex][column]),
    );
    if (mismatch !== -1) {
      problems.push(`full/selected decode mismatch at event ${mismatch}, parameter ${parameterIndex + 1}`);
    }
  }

  if (entry.truth_file) {
    const truth = await fetchVerifiedTruth(entry);
    if (truth.event_count !== parsed.rows.length || truth.phase_codes?.length !== parsed.rows.length) {
      problems.push(`truth alignment mismatch (${truth.event_count}/${truth.phase_codes?.length}/${parsed.rows.length})`);
    }
    for (const [parameterIndex, channel] of declaredChannels.entries()) {
      const expectedHash = truth.channel_sha256_float32_le?.[channel];
      if (!expectedHash) continue;
      const column = parsed.columns[parameterIndex];
      const actualHash = await sha256Float32(parsed.rows.map((row) => row[column]));
      if (actualHash !== expectedHash) {
        problems.push(`${channel} decoded SHA-256 ${actualHash}, expected ${expectedHash}`);
      }
    }
  }
  return problems;
}

async function probeParser(entry) {
  const expectation = entry.parser_expectation ?? { outcome: "LOAD_OK", phase: "data_load" };
  let buffer;
  try {
    buffer = await fetchArrayBuffer(entry.file);
  } catch (caught) {
    return {
      id: entry.id,
      expected: expectation.outcome,
      observed: "fixture fetch failed",
      status: "ERROR",
      detail: describeError(caught),
    };
  }
  const actualFcsHash = await sha256ArrayBuffer(buffer);
  if (actualFcsHash !== entry.fcs?.sha256) {
    return {
      id: entry.id,
      expected: expectation.outcome,
      observed: "fixture integrity failure",
      status: "ERROR",
      detail: `FCS SHA-256 ${actualFcsHash}, expected ${entry.fcs?.sha256 ?? "missing"}`,
    };
  }

  let summary;
  try {
    summary = FCSParser.parse_fcs_header(buffer);
  } catch (error) {
    if (expectation.outcome === "LOAD_OK") {
      return {
        id: entry.id,
        expected: `${expectation.outcome} @ ${expectation.phase}`,
        observed: "rejected @ header_import",
        status: "FAIL",
        detail: describeError(error),
      };
    }
    return rejectionResult(entry, error, "header_import");
  }

  let parsed;
  try {
    parsed = FCSParser.parse_fcs(buffer);
  } catch (error) {
    if (expectation.outcome === "LOAD_OK") {
      return {
        id: entry.id,
        expected: `${expectation.outcome} @ ${expectation.phase}`,
        observed: "rejected @ data_load",
        status: "FAIL",
        detail: describeError(error),
      };
    }
    return rejectionResult(entry, error, "data_load");
  }

  if (expectation.outcome === "IMPORT_REJECT") {
    return {
      id: entry.id,
      expected: `${expectation.outcome} @ ${expectation.phase} (${expectation.code})`,
      observed: "loaded",
      status: "EXPOSED",
      detail: `Expected ${expectation.code}; HEADER and DATA parsing both accepted the file.`,
    };
  }

  if (expectation.outcome === "ANALYSIS_BLOCK") {
    const dnaIndex = summary.columns.findIndex((label) => /DNA.*-A/i.test(label)) + 1;
    const eligibility = FCSParser.channel_eligibility(summary, dnaIndex);
    const matched = !eligibility.eligible && eligibility.code === expectation.code;
    return {
      id: entry.id,
      expected: `${expectation.outcome} @ ${expectation.phase} (${expectation.code})`,
      observed: matched ? `blocked @ analysis_preflight (${eligibility.code})` : "loaded; analysis preflight did not match",
      status: matched ? "PASS" : "EXPOSED",
      detail: eligibility.message,
    };
  }

  const problems = await validateLoadedParserCase(entry, buffer, summary, parsed);

  return {
    id: entry.id,
    expected: `${expectation.outcome} @ ${expectation.phase}`,
    observed: "loaded",
    status: problems.length ? "FAIL" : "PASS",
    detail: problems.join("; ") || `${parsed.rows.length} events, ${parsed.columns.length} parameters; full/selected parity verified${entry.truth_file ? "; channel hashes verified" : ""}`,
  };
}

function decodeTruth(truth, view) {
  const useOracle = view === "oracle_qc";
  const maskString = useOracle ? truth.oracle_final_good_mask : null;
  const mask = maskString
    ? Uint8Array.from(maskString, (value) => value === "1" ? 1 : 0)
    : null;
  const counts = { g1: 0, s: 0, g2: 0 };
  for (let index = 0; index < truth.phase_codes.length; index += 1) {
    if (mask && mask[index] !== 1) continue;
    const code = truth.phase_codes[index];
    if (code === "1") counts.g1 += 1;
    else if (code === "S") counts.s += 1;
    else if (code === "2") counts.g2 += 1;
  }
  const denominator = counts.g1 + counts.s + counts.g2;
  return {
    mask,
    counts,
    fractions: {
      g1: denominator ? counts.g1 / denominator : 0,
      s: denominator ? counts.s / denominator : 0,
      g2: denominator ? counts.g2 / denominator : 0,
    },
  };
}

function parsedDataset(parsed) {
  const labelToName = {
    "DNA-A": "DNA_A",
    "DNA-H": "DNA_H",
    "DNA-W": "DNA_W",
    "FSC-A": "FSC_A",
    "Forward Scatter Area": "FSC_A",
    "SSC-A": "SSC_A",
    "Side Scatter Area": "SSC_A",
    "Time": "Time",
  };
  const channels = {};
  const pnr = {};
  for (const [columnIndex, label] of parsed.columns.entries()) {
    const name = labelToName[label];
    if (!name) continue;
    channels[name] = parsed.rows.map((row) => row[label]);
    const range = Number(parsed.metadata[`P${columnIndex + 1}R`]);
    if (Number.isFinite(range)) pnr[name] = range;
  }
  return {
    channels,
    pnr,
    eventCount: parsed.rows.length,
    masks: {},
  };
}

function maskFromString(value) {
  return Uint8Array.from(value, (character) => character === "1" ? 1 : 0);
}

function maskMetrics(predicted, expectedGood) {
  if (!predicted || predicted.length !== expectedGood.length) {
    throw new Error("Predicted and expected QC masks are missing or have different lengths.");
  }
  let good = 0;
  let bad = 0;
  let goodRetained = 0;
  let badRejected = 0;
  for (let index = 0; index < predicted.length; index += 1) {
    if (expectedGood[index] === 1) {
      good += 1;
      if (predicted[index] === 1) goodRetained += 1;
    } else {
      bad += 1;
      if (predicted[index] === 0) badRejected += 1;
    }
  }
  return {
    good,
    bad,
    goodRetained,
    badRejected,
    goodRetention: good ? goodRetained / good : 1,
    badRejection: bad ? badRejected / bad : null,
  };
}

function maskEquals(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function thresholdStatus(metrics, expectation) {
  if (expectation.minimum_bad_rejection != null && metrics.bad === 0) {
    return "ERROR";
  }
  const goodPass = metrics.goodRetention >= (expectation.minimum_good_retention ?? 0);
  const badPass = metrics.badRejection == null || metrics.badRejection >= (expectation.minimum_bad_rejection ?? 0);
  return goodPass && badPass ? "PASS" : "EXPOSED";
}

async function runQcOne(entry) {
  const [buffer, truth] = await Promise.all([
    fetchArrayBuffer(entry.file),
    fetchVerifiedTruth(entry),
  ]);
  await requireFixtureHash(entry, buffer);
  const parsed = FCSParser.parse_fcs(buffer);
  const dataset = parsedDataset(parsed);
  const expectation = entry.qc;
  const structural = runStructuralQC(dataset);
  let predicted = null;
  let expected = null;
  let observedStatus = "";
  let extraProblem = "";

  if (expectation.kind === "structural_exact") {
    predicted = structural.structuralMask;
    expected = maskFromString(truth.structural_good_mask);
    observedStatus = structural.status ?? "structural QC complete";
  } else if (expectation.kind === "missing_companions") {
    const time = runTimeQC(dataset, structural.structuralMask);
    const scatter = gateMainBiologicalCloud(dataset, structural.structuralMask);
    const pulse = gateByPulseGeometry(dataset, structural.structuralMask);
    const copied = maskEquals(pulse.singletMask, structural.structuralMask);
    const passes = time.skipped && scatter.skipped && pulse.skipped && copied;
    return {
      publicResult: {
        id: entry.id,
        kind: expectation.kind,
        status: passes ? "PASS" : "EXPOSED",
        goodRetention: null,
        badRejection: null,
        detail: `Time skipped=${time.skipped}; scatter skipped=${scatter.skipped}; pulse skipped=${pulse.skipped}; upstream mask copied=${copied}. ` +
          "This confirms optional-skip behavior; required-gate fail-closed policy needs a UI/orchestration test.",
      },
      mask: pulse.singletMask,
    };
  } else if (expectation.kind === "scatter") {
    const result = gateMainBiologicalCloud(dataset, structural.structuralMask);
    if (expectation.require_review_for_adversary && result.status === "review_required") {
      const noAuthoritativeMask = result.scatterMask == null && result.mask == null;
      return {
        publicResult: {
          id: entry.id,
          kind: expectation.kind,
          status: noAuthoritativeMask ? "PASS" : "EXPOSED",
          goodRetention: null,
          badRejection: null,
          detail: noAuthoritativeMask
            ? "Adversarial cloud requires review and no authoritative Stage-2 mask was committed."
            : "Review was requested, but an authoritative Stage-2 mask was also committed.",
        },
        mask: null,
      };
    }
    predicted = result.scatterMask;
    expected = maskFromString(truth.scatter_good_mask);
    observedStatus = result.status;
    if (expectation.require_review_for_adversary && result.status !== "review_required") {
      extraProblem = "The high-FSC adversary received an authoritative fitted mask instead of review_required.";
    }
  } else if (expectation.kind === "pulse") {
    const result = gateByPulseGeometry(dataset, structural.structuralMask);
    predicted = result.singletMask;
    expected = maskFromString(truth.pulse_good_mask);
    observedStatus = `${result.status}; converged=${result.converged}`;
  } else if (expectation.kind === "time_robust") {
    const result = runTimeQC(dataset, structural.structuralMask, {
      targetBinSize: 200,
      threshold: 4,
      timerRange: dataset.pnr.Time,
    });
    predicted = result.timeQCMask;
    expected = maskFromString(truth.time_good_mask);
    observedStatus = `${result.status}; flagged intervals=${result.flaggedIntervals?.length ?? 0}`;
    const rateEstimatorMismatches = (result.binSummaries ?? []).filter((summary, index) => {
      const bin = result.bins?.[index];
      if (!bin || bin.indexes.length < 2) return false;
      const first = bin.indexes[0];
      const last = bin.indexes.at(-1);
      const duration = result.unwrappedTime[last] - result.unwrappedTime[first];
      const expectedRate = duration > 0 ? (bin.indexes.length - 1) / duration : NaN;
      return Number.isFinite(expectedRate) && !approximatelyEqual(summary.eventRate, expectedRate);
    }).length;
    if (rateEstimatorMismatches) {
      extraProblem = `${rateEstimatorMismatches} bins use n/duration instead of the interval-correct (n-1)/duration event rate.`;
    }
  } else if (expectation.kind === "time_peak_tracking") {
    const result = runPeakTrackingTimeQC(dataset, structural.structuralMask, {
      minimumEventsPerBin: 500,
      maximumBins: 100,
      overlapFraction: 0.5,
      includeEventRateCheck: true,
      timerRange: dataset.pnr.Time,
    });
    predicted = result.timeQCMask;
    expected = maskFromString(truth.time_good_mask);
    observedStatus = `${result.status}; rejected bins=${result.rejectedBinCount ?? 0}; ${result.warnings?.join(" | ") ?? ""}`;
  } else {
    throw new Error(`Unknown QC benchmark kind: ${expectation.kind}`);
  }

  const metrics = maskMetrics(predicted, expected);
  let status = thresholdStatus(metrics, expectation);
  if (expectation.kind === "structural_exact" && !maskEquals(predicted, expected)) status = "EXPOSED";
  if (extraProblem) status = "EXPOSED";
  return {
    publicResult: {
      id: entry.id,
      kind: expectation.kind,
      status,
      goodRetention: metrics.goodRetention,
      badRejection: metrics.badRejection,
      counts: metrics,
      detail: [
        observedStatus,
        `good retained ${metrics.goodRetained}/${metrics.good}`,
        metrics.bad ? `bad rejected ${metrics.badRejected}/${metrics.bad}` : "no planted bad events",
        extraProblem,
      ].filter(Boolean).join("; "),
    },
    mask: predicted,
  };
}

function visibleDomainFractions(result) {
  const areas = {};
  let total = 0;
  for (const component of result.components ?? []) {
    if (!component.includeInBiologicalDenominator) continue;
    areas[component.id] = component.observedDomainArea;
    total += component.observedDomainArea;
  }
  return {
    g1: total ? (areas.g1 ?? 0) / total : 0,
    s: total ? (areas.s ?? 0) / total : 0,
    g2: total ? (areas.g2 ?? 0) / total : 0,
  };
}

function warningText(warning) {
  if (typeof warning === "string") return warning;
  return warning?.message ?? warning?.detail ?? warning?.code ?? JSON.stringify(warning);
}

async function fitOne(entry, view, modelId) {
  const [buffer, truth] = await Promise.all([
    fetchArrayBuffer(entry.file),
    fetchVerifiedTruth(entry),
  ]);
  await requireFixtureHash(entry, buffer);
  const parsed = FCSParser.parse_fcs(buffer);
  if (parsed.rows.length !== truth.event_count || truth.phase_codes.length !== truth.event_count) {
    throw new Error(`FCS/truth event count mismatch (${parsed.rows.length}/${truth.event_count}).`);
  }
  const dnaChannel = entry.analysis.dna_channel;
  if (!parsed.columns.includes(dnaChannel)) {
    throw new Error(`DNA channel ${dnaChannel} is absent (${parsed.columns.join(", ")}).`);
  }
  const dna = parsed.rows.map((row) => row[dnaChannel]);
  const decoded = decodeTruth(truth, view);
  const histogramOptions = {
    binCount: entry.analysis.bin_count,
    dnaChannel,
  };
  if (entry.analysis.histogram_range) {
    histogramOptions.range = entry.analysis.histogram_range;
  }
  const histogram = generateHistogram(dna, decoded.mask, histogramOptions);
  const model = get_model(modelId);
  if (!model) throw new Error(`Model ${modelId} is not registered.`);

  const raw = model.fit({
    histogram,
    peakRegions: entry.analysis.peak_regions,
    config: {},
  });
  const fitted = model.normalizeResult(raw);
  const phaseFractions = fitted.phaseFractions;
  const fractionValues = [phaseFractions?.g1, phaseFractions?.s, phaseFractions?.g2];
  const fractionSum = fractionValues.reduce((sum, value) => sum + value, 0);
  if (
    typeof fitted.converged !== "boolean"
    || fractionValues.some((value) => !Number.isFinite(value) || value < 0 || value > 1)
    || Math.abs(fractionSum - 1) > 1e-6
  ) {
    throw new Error(
      `Model ${modelId} returned an invalid normalized result: converged=${fitted.converged}, `
      + `fractions=${JSON.stringify(phaseFractions)}, sum=${fractionSum}`,
    );
  }
  const errors = {
    g1: 100 * (phaseFractions.g1 - decoded.fractions.g1),
    s: 100 * (phaseFractions.s - decoded.fractions.s),
    g2: 100 * (phaseFractions.g2 - decoded.fractions.g2),
  };
  const maxError = Math.max(...Object.values(errors).map(Math.abs));
  const visible = visibleDomainFractions(fitted);
  const canonicalVisibleDelta = Math.max(
    Math.abs(phaseFractions.g1 - visible.g1),
    Math.abs(phaseFractions.s - visible.s),
    Math.abs(phaseFractions.g2 - visible.g2),
  ) * 100;
  const tolerance = entry.analysis.tolerance_percentage_points;
  const converged = fitted.converged === true;
  const fittedPeakRatio = Number.isFinite(fitted.parameters?.g2Mean) && Number.isFinite(fitted.parameters?.g1Mean)
    ? fitted.parameters.g2Mean / fitted.parameters.g1Mean
    : null;
  const boundedModel = ["dean_jett", "dean_jett_fox", "watson_classic"].includes(modelId);
  const ratioConstraintViolation = boundedModel && Number.isFinite(fittedPeakRatio)
    && (fittedPeakRatio < 1.65 - 1e-8 || fittedPeakRatio > 2.25 + 1e-8);
  const selected = fitted.modelComparison?.selectedModelId;
  const contract = entry.analysis.expected_by_model?.[modelId] ?? { kind: "diagnostic" };
  const fractionWithinTolerance = maxError <= tolerance;
  const recoveryProblems = [];
  if (!converged) recoveryProblems.push("fit did not converge");
  if (!fractionWithinTolerance) recoveryProblems.push(`fraction error exceeded ${tolerance} pp`);
  if (ratioConstraintViolation) recoveryProblems.push("default bounded-ratio constraint was violated");
  if (contract.expected_selected_model && selected !== contract.expected_selected_model) {
    recoveryProblems.push(`Auto selected ${selected ?? "no model"}; expected ${contract.expected_selected_model}`);
  }
  const fittedWaveWeight = Number.isFinite(fitted.parameters?.w) ? fitted.parameters.w : null;
  if (contract.minimum_wave_weight != null && !(fittedWaveWeight >= contract.minimum_wave_weight)) {
    recoveryProblems.push(`wave weight ${number(fittedWaveWeight, 4)} is below ${contract.minimum_wave_weight}`);
  }
  const status = contract.kind === "recovery"
    ? recoveryProblems.length ? "DEVIATION" : "PASS"
    : "DIAGNOSTIC";
  const detailParts = [
    `contract ${contract.kind}`,
    `errors pp: G1 ${number(errors.g1)}, S ${number(errors.s)}, G2 ${number(errors.g2)}`,
    `canonical-visible max delta ${number(canonicalVisibleDelta)} pp`,
    `histogram under/overflow ${histogram.underflow}/${histogram.overflow}`,
  ];
  if (selected) detailParts.push(`Auto selected ${selected}`);
  if (Number.isFinite(fittedWaveWeight)) detailParts.push(`fitted wave weight ${number(fittedWaveWeight, 4)}`);
  if (Number.isFinite(fittedPeakRatio)) detailParts.push(`fitted G2:G1 ratio ${number(fittedPeakRatio, 4)}`);
  if (ratioConstraintViolation) detailParts.push("default bounded-ratio constraint violated");
  if (fitted.convergenceReason) detailParts.push(`termination ${fitted.convergenceReason}`);
  if (fitted.warnings?.length) detailParts.push(`warnings: ${fitted.warnings.map(warningText).join(" | ")}`);
  if (recoveryProblems.length && contract.kind === "recovery") detailParts.push(`recovery failures: ${recoveryProblems.join(" | ")}`);

  return {
    id: entry.id,
    view,
    modelId,
    status,
    contractKind: contract.kind,
    contract,
    tolerancePercentagePoints: tolerance,
    truth: decoded.fractions,
    truthCounts: decoded.counts,
    fitted: phaseFractions,
    errorPercentagePoints: errors,
    maxAbsoluteErrorPercentagePoints: maxError,
    fractionWithinTolerance,
    visibleDomainFractions: visible,
    canonicalVisibleMaxDeltaPercentagePoints: canonicalVisibleDelta,
    converged: fitted.converged,
    convergenceReason: fitted.convergenceReason,
    selectedModelId: selected ?? null,
    fittedPeakRatio,
    fittedWaveWeight,
    ratioConstraintViolation,
    warnings: (fitted.warnings ?? []).map(warningText),
    histogram: {
      retainedCount: histogram.retainedCount,
      binnedCount: histogram.binnedCount,
      underflow: histogram.underflow,
      overflow: histogram.overflow,
      min: histogram.min,
      max: histogram.max,
      binCount: histogram.binCount,
    },
    detail: detailParts.join("; "),
  };
}

function selectedModels() {
  return [...elements.modelChoices.querySelectorAll("input:checked")].map((input) => input.value);
}

function queryOptions() {
  const query = new URLSearchParams(window.location.search);
  const models = query.get("models")?.split(",").filter(Boolean) ?? selectedModels();
  const caseIds = query.get("cases")?.split(",").filter(Boolean) ?? null;
  return {
    mode: query.get("mode") ?? "all",
    models,
    caseIds,
    autorun: query.get("autorun") === "1",
  };
}

async function runBenchmark({ mode = "all", models = selectedModels(), caseIds = null } = {}) {
  if (state.running) return state.result;
  if (!["all", "parser", "qc", "models"].includes(mode)) {
    throw new Error(`Unknown benchmark mode: ${mode}`);
  }
  const knownCaseIds = new Set(state.manifest.cases.map((entry) => entry.id));
  const unknownCases = (caseIds ?? []).filter((id) => !knownCaseIds.has(id));
  const unknownModels = models.filter((id) => !DEFAULT_MODELS.includes(id));
  if (unknownCases.length) throw new Error(`Unknown fixture IDs: ${unknownCases.join(", ")}`);
  if (unknownModels.length) throw new Error(`Unknown model IDs: ${unknownModels.join(", ")}`);
  if ((mode === "all" || mode === "models") && models.length === 0) {
    throw new Error("At least one model must be selected for model benchmarks.");
  }
  state.running = true;
  window.__benchmarkDone = false;
  elements.runAll.disabled = true;
  elements.runQc.disabled = true;
  elements.runModels.disabled = true;
  elements.runParser.disabled = true;
  elements.download.disabled = true;
  elements.parserBody.replaceChildren();
  elements.qcBody.replaceChildren();
  elements.modelBody.replaceChildren();

  const runParser = mode === "all" || mode === "parser";
  const runQc = mode === "all" || mode === "qc";
  const runModels = mode === "all" || mode === "models";
  const selectedCases = state.manifest.cases.filter((entry) => !caseIds || caseIds.includes(entry.id));
  const parserCases = runParser ? selectedCases : [];
  const qcCases = runQc ? selectedCases.filter((entry) => entry.qc) : [];
  const qcCaseIds = new Set(qcCases.map((entry) => entry.id));
  const pairKeys = new Set();
  for (const entry of qcCases) {
    if (!entry.qc.metamorphic_pair || !qcCaseIds.has(entry.qc.metamorphic_pair)) continue;
    pairKeys.add([entry.id, entry.qc.metamorphic_pair].sort().join("::"));
  }
  const modelJobs = runModels
    ? selectedCases
        .filter((entry) => entry.analysis?.benchmark_models)
        .flatMap((entry) => entry.analysis.views.flatMap((view) => models.map((modelId) => ({ entry, view, modelId }))))
    : [];
  const total = parserCases.length + qcCases.length + pairKeys.size + modelJobs.length;
  if (total === 0) {
    state.running = false;
    elements.runAll.disabled = false;
    elements.runQc.disabled = false;
    elements.runModels.disabled = false;
    elements.runParser.disabled = false;
    throw new Error("The selected mode/cases/models produced zero benchmark checks.");
  }
  let done = 0;
  const result = {
    schemaVersion: 1,
    corpusGenerator: state.manifest.generator,
    manifestSha256: state.manifestSha256,
    browser: navigator.userAgent,
    options: { mode, models, caseIds },
    parser: [],
    qc: [],
    models: [],
    summary: {},
  };

  try {
    setStatus(`Running ${total} checks…`);
    setProgress(0, total, "starting");
    for (const entry of parserCases) {
      const parserResult = await probeParser(entry);
      result.parser.push(parserResult);
      renderParserResult(parserResult);
      done += 1;
      setProgress(done, total, `parser: ${entry.id}`);
      await pauseForPaint();
    }
    const qcExecutions = new Map();
    for (const entry of qcCases) {
      let qcResult;
      try {
        const executed = await runQcOne(entry);
        qcResult = executed.publicResult;
        qcExecutions.set(entry.id, { mask: executed.mask, status: qcResult.status });
      } catch (error) {
        qcResult = {
          id: entry.id,
          kind: entry.qc.kind,
          status: "ERROR",
          goodRetention: null,
          badRejection: null,
          detail: `${error.name}: ${error.message}`,
        };
        qcExecutions.set(entry.id, { mask: null, status: "ERROR" });
      }
      result.qc.push(qcResult);
      renderQcResult(qcResult);
      done += 1;
      setProgress(done, total, `QC: ${entry.id}`);
      await pauseForPaint();
    }
    for (const key of pairKeys) {
      const [leftId, rightId] = key.split("::");
      const left = qcExecutions.get(leftId);
      const right = qcExecutions.get(rightId);
      const memberError = !left || !right || left.status === "ERROR" || right.status === "ERROR";
      const equal = !memberError && maskEquals(left.mask, right.mask);
      const pairResult = {
        id: `${leftId} ↔ ${rightId}`,
        kind: "metamorphic_mask_equality",
        status: memberError ? "ERROR" : equal ? "PASS" : "EXPOSED",
        goodRetention: null,
        badRejection: null,
        detail: memberError
          ? "A pair member did not produce a comparable mask."
          : equal
          ? "QC membership is exactly invariant under the planted independent-axis scale change."
          : "QC membership changed when only one instrument axis was rescaled.",
      };
      result.qc.push(pairResult);
      renderQcResult(pairResult);
      done += 1;
      setProgress(done, total, `QC pair: ${leftId}/${rightId}`);
      await pauseForPaint();
    }
    for (const job of modelJobs) {
      let modelResult;
      try {
        modelResult = await fitOne(job.entry, job.view, job.modelId);
      } catch (error) {
        modelResult = {
          id: job.entry.id,
          view: job.view,
          modelId: job.modelId,
          status: "ERROR",
          truth: job.view === "oracle_qc"
            ? job.entry.truth.after_oracle_qc.fractions
            : job.entry.truth.all_biological.fractions,
          fitted: null,
          maxAbsoluteErrorPercentagePoints: null,
          converged: null,
          detail: `${error.name}: ${error.message}`,
        };
      }
      result.models.push(modelResult);
      renderModelResult(modelResult);
      done += 1;
      setProgress(done, total, `${job.entry.id}/${job.view}/${job.modelId}`);
      await pauseForPaint();
    }
    result.summary = {
      totalChecks: done,
      parserPass: result.parser.filter((item) => item.status === "PASS").length,
      parserExposed: result.parser.filter((item) => item.status === "EXPOSED").length,
      parserFail: result.parser.filter((item) => item.status === "FAIL").length,
      parserError: result.parser.filter((item) => item.status === "ERROR").length,
      qcPass: result.qc.filter((item) => item.status === "PASS").length,
      qcExposed: result.qc.filter((item) => item.status === "EXPOSED").length,
      qcError: result.qc.filter((item) => item.status === "ERROR").length,
      modelPass: result.models.filter((item) => item.status === "PASS").length,
      modelDeviation: result.models.filter((item) => item.status === "DEVIATION").length,
      modelDiagnostic: result.models.filter((item) => item.status === "DIAGNOSTIC").length,
      modelError: result.models.filter((item) => item.status === "ERROR").length,
    };
    const concernCount = result.summary.parserExposed + result.summary.parserFail + result.summary.parserError + result.summary.qcExposed + result.summary.qcError + result.summary.modelDeviation + result.summary.modelError;
    setStatus(
      `Finished ${done} checks: ${concernCount} exposed deviations/errors.`,
      concernCount ? "warning" : "pass",
    );
  } finally {
    state.running = false;
    state.result = result;
    window.__benchmarkResult = result;
    window.__benchmarkDone = true;
    elements.runAll.disabled = false;
    elements.runQc.disabled = false;
    elements.runModels.disabled = false;
    elements.runParser.disabled = false;
    elements.download.disabled = false;
  }
  return result;
}

function downloadResults() {
  if (!state.result) return;
  const blob = new Blob([JSON.stringify(state.result, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "phasefinder-synthetic-fcs-benchmark.json";
  anchor.click();
  URL.revokeObjectURL(url);
}

async function initialize() {
  const manifestBytes = await fetchArrayBuffer("manifest.json");
  state.manifestSha256 = await sha256ArrayBuffer(manifestBytes);
  state.manifest = JSON.parse(new TextDecoder("utf-8").decode(manifestBytes));
  register_default_models();
  for (const modelId of DEFAULT_MODELS) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = modelId;
    input.checked = true;
    label.append(input, ` ${modelId}`);
    elements.modelChoices.append(label);
  }
  setStatus(`${state.manifest.cases.length} deterministic fixtures ready.`);
  elements.runAll.addEventListener("click", () => runBenchmark({ mode: "all" }));
  elements.runQc.addEventListener("click", () => runBenchmark({ mode: "qc" }));
  elements.runModels.addEventListener("click", () => runBenchmark({ mode: "models" }));
  elements.runParser.addEventListener("click", () => runBenchmark({ mode: "parser" }));
  elements.download.addEventListener("click", downloadResults);

  const options = queryOptions();
  if (options.autorun) await runBenchmark(options);
}

window.PhaseFinderSyntheticBenchmark = {
  runBenchmark,
  get manifest() { return state.manifest; },
  get result() { return state.result; },
};

initialize().catch((error) => {
  setStatus(`${error.name}: ${error.message}`, "error");
  window.__benchmarkError = `${error.name}: ${error.message}`;
  window.__benchmarkDone = true;
});
