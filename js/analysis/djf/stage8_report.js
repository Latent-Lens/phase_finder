// Stage 8: phase fractions, contamination accounting, and fit diagnostics.

import {
  clamp,
  mean,
  median,
  maximumValue,
  sumSquares,
  robustResidualScale,
  safeFraction,
} from "./math/stats.js";
import { integrateTrapezoidal } from "./math/integrate.js";

const DEFAULT_REPORT_OPTIONS = Object.freeze({
  expectedRatio: 2.0,
  ratioWarningTolerance: 0.15,
  minimumPeakHeightFraction: 0.05,
  minimumPeakAreaFraction: 0.01,
  boundaryToleranceFraction: 0.02,
  nonnegativeBoundaryToleranceFraction: 1e-4,
  residualAutocorrelationThreshold: 0.35,
  residualWindowZThreshold: 2.5,
  residualWindowBins: 11,
  channelNames: Object.freeze([]),
  pulseGeometryAvailable: null,
  parameterCount: null,
});

function isArrayLikeSequence(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Number.isSafeInteger(value.length) &&
    value.length >= 0
  );
}

function sum(values) {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function validateFitResult(fitResult) {
  if (!fitResult?.curves) {
    throw new TypeError("fitResult.curves is required.");
  }

  const { x, observed, g1, s, g2, fitted, residuals } = fitResult.curves;
  const requiredCurves = { x, observed, g1, s, g2, fitted, residuals };

  for (const [curveName, curve] of Object.entries(requiredCurves)) {
    if (!isArrayLikeSequence(curve)) {
      throw new TypeError(
        `fitResult.curves.${curveName} must be an array or typed array.`,
      );
    }
  }

  const expectedLength = x.length;
  if (expectedLength < 2) {
    throw new RangeError("The fitted histogram must contain at least two bins.");
  }

  for (const [curveName, curve] of Object.entries(requiredCurves)) {
    if (curve.length !== expectedLength) {
      throw new RangeError(
        `fitResult.curves.${curveName} does not match the x-array length.`,
      );
    }
  }

  for (let i = 0; i < expectedLength; i += 1) {
    if (!Number.isFinite(x[i])) {
      throw new RangeError(`x[${i}] is not finite.`);
    }
    if (i > 0 && x[i] <= x[i - 1]) {
      throw new RangeError("The x values must be strictly increasing.");
    }

    for (const [curveName, curve] of Object.entries(requiredCurves)) {
      if (curveName !== "x" && !Number.isFinite(curve[i])) {
        throw new RangeError(`${curveName}[${i}] is not finite.`);
      }
    }
  }
}

function getOptionalCurve(fitResult, curveName) {
  const x = fitResult.curves.x;
  const curve = fitResult.curves[curveName];
  if (isArrayLikeSequence(curve) && curve.length === x.length) return curve;
  return new Float64Array(x.length);
}

function integrateFittedComponents(fitResult) {
  const { x, g1, s, g2, fitted, observed } = fitResult.curves;
  const aggregate = getOptionalCurve(fitResult, "aggregate");
  const debris = getOptionalCurve(fitResult, "debris");

  return {
    g1: integrateTrapezoidal(x, g1),
    s: integrateTrapezoidal(x, s),
    g2: integrateTrapezoidal(x, g2),
    aggregate: integrateTrapezoidal(x, aggregate),
    debris: integrateTrapezoidal(x, debris),
    fitted: integrateTrapezoidal(x, fitted),
    observed: integrateTrapezoidal(x, observed),
  };
}

function computeSingletFractions(componentAreas) {
  // Contamination is deliberately excluded from this denominator.
  const biologicalSingletTotal =
    componentAreas.g1 + componentAreas.s + componentAreas.g2;

  return {
    biologicalSingletTotal,
    oneC: safeFraction(componentAreas.g1, biologicalSingletTotal),
    sPhase: safeFraction(componentAreas.s, biologicalSingletTotal),
    twoC: safeFraction(componentAreas.g2, biologicalSingletTotal),
  };
}

function computeContaminationFractions(componentAreas) {
  const totalModeledArea =
    componentAreas.g1 +
    componentAreas.s +
    componentAreas.g2 +
    componentAreas.aggregate +
    componentAreas.debris;
  const contaminationArea = componentAreas.aggregate + componentAreas.debris;

  return {
    totalModeledArea,
    contaminationArea,
    aggregate: safeFraction(componentAreas.aggregate, totalModeledArea),
    debris: safeFraction(componentAreas.debris, totalModeledArea),
    combined: safeFraction(contaminationArea, totalModeledArea),
    aggregateWasModeled: componentAreas.aggregate > 0,
    debrisWasModeled: componentAreas.debris > 0,
  };
}

function inferParameterCount(fitResult, options) {
  if (Number.isInteger(options.parameterCount) && options.parameterCount > 0) {
    return options.parameterCount;
  }

  const candidateFits = fitResult.diagnostics?.candidateFits;
  if (Array.isArray(candidateFits) && fitResult.selectedModel) {
    const selectedCandidate = candidateFits.find(
      (candidate) => candidate.name === fitResult.selectedModel,
    );
    if (Number.isInteger(selectedCandidate?.parameterCount)) {
      return selectedCandidate.parameterCount;
    }
  }

  // Eight base parameters; R is a ninth only when it was unlocked.
  let parameterCount = 8;
  if (
    fitResult.diagnostics?.ratioWasUnlocked ||
    fitResult.diagnostics?.options?.unlockRatio
  ) {
    parameterCount += 1;
  }
  if (fitResult.selectedModel?.includes("aggregate")) parameterCount += 1;
  if (fitResult.selectedModel?.includes("debris")) parameterCount += 2;
  return parameterCount;
}

function computeGoodnessOfFit(fitResult, options) {
  const { observed, fitted } = fitResult.curves;
  const residuals = new Array(observed.length);
  for (let i = 0; i < observed.length; i += 1) {
    residuals[i] = fitted[i] - observed[i];
  }

  const observationCount = observed.length;
  const parameterCount = inferParameterCount(fitResult, options);
  const degreesOfFreedom = Math.max(1, observationCount - parameterCount);
  const sse = sumSquares(residuals);
  const mse = sse / observationCount;
  const rmse = Math.sqrt(mse);

  let absoluteErrorTotal = 0;
  for (const residual of residuals) absoluteErrorTotal += Math.abs(residual);
  const mae = absoluteErrorTotal / observationCount;

  const observedMean = mean(observed);
  let totalSumOfSquares = 0;
  for (const value of observed) totalSumOfSquares += (value - observedMean) ** 2;

  const rSquared =
    totalSumOfSquares > 0 ? 1 - sse / totalSumOfSquares : null;
  const adjustedRSquared =
    rSquared === null || observationCount <= parameterCount + 1
      ? null
      : 1 -
        ((1 - rSquared) * (observationCount - 1)) /
          (observationCount - parameterCount - 1);

  let pearsonChiSquare = 0;
  for (let i = 0; i < observationCount; i += 1) {
    pearsonChiSquare += residuals[i] ** 2 / Math.max(fitted[i], 1);
  }
  const reducedPearsonChiSquare = pearsonChiSquare / degreesOfFreedom;

  const safeSse = Math.max(sse, 1e-12);
  const logVariance = observationCount * Math.log(safeSse / observationCount);
  const aic = logVariance + 2 * parameterCount;
  const bic = logVariance + parameterCount * Math.log(observationCount);

  return {
    observationCount,
    parameterCount,
    degreesOfFreedom,
    sse,
    mse,
    rmse,
    mae,
    rSquared,
    adjustedRSquared,
    pearsonChiSquare,
    reducedPearsonChiSquare,
    aic,
    bic,
    residuals,
  };
}

function calculateLagOneAutocorrelation(residuals) {
  if (residuals.length < 2) return 0;
  const residualMean = mean(residuals);
  let numerator = 0;
  let denominator = 0;

  for (let i = 0; i < residuals.length; i += 1) {
    const centered = residuals[i] - residualMean;
    denominator += centered * centered;
    if (i > 0) numerator += centered * (residuals[i - 1] - residualMean);
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

function calculateDurbinWatson(residuals) {
  if (residuals.length < 2) return 2;
  let numerator = 0;
  for (let i = 1; i < residuals.length; i += 1) {
    numerator += (residuals[i] - residuals[i - 1]) ** 2;
  }
  const denominator = sumSquares(residuals);
  return denominator === 0 ? 2 : numerator / denominator;
}

function calculateMaximumLocalBias(residuals, requestedWindowBins) {
  if (residuals.length === 0) {
    return {
      maximumAbsoluteZ: 0,
      startIndex: null,
      endIndex: null,
      meanResidual: 0,
    };
  }

  const residualScale = robustResidualScale(residuals);
  const windowBins = clamp(Math.round(requestedWindowBins), 3, residuals.length);
  let maximumAbsoluteZ = 0;
  let bestStart = 0;
  let bestMean = 0;
  let runningSum = 0;

  for (let i = 0; i < windowBins; i += 1) runningSum += residuals[i];
  for (let start = 0; start <= residuals.length - windowBins; start += 1) {
    if (start > 0) {
      runningSum -= residuals[start - 1];
      runningSum += residuals[start + windowBins - 1];
    }
    const windowMean = runningSum / windowBins;
    const absoluteZ = Math.abs(windowMean) / residualScale;
    if (absoluteZ > maximumAbsoluteZ) {
      maximumAbsoluteZ = absoluteZ;
      bestStart = start;
      bestMean = windowMean;
    }
  }

  return {
    maximumAbsoluteZ,
    startIndex: bestStart,
    endIndex: bestStart + windowBins - 1,
    meanResidual: bestMean,
  };
}

function analyzeResidualStructure(residuals, options) {
  const localBias = calculateMaximumLocalBias(
    residuals,
    options.residualWindowBins,
  );
  return {
    meanResidual: mean(residuals),
    medianResidual: median(residuals),
    robustScale: robustResidualScale(residuals),
    lagOneAutocorrelation: calculateLagOneAutocorrelation(residuals),
    durbinWatson: calculateDurbinWatson(residuals),
    maximumLocalBiasZ: localBias.maximumAbsoluteZ,
    localBiasStartIndex: localBias.startIndex,
    localBiasEndIndex: localBias.endIndex,
    localBiasMeanResidual: localBias.meanResidual,
  };
}

function normalizeGeometryName(geometry) {
  const upper = geometry.toUpperCase();
  if (upper === "A" || upper === "AREA") return "A";
  if (upper === "H" || upper === "HEIGHT") return "H";
  if (upper === "W" || upper === "WIDTH") return "W";
  return null;
}

function parsePulseGeometryChannel(channelName) {
  if (typeof channelName !== "string") return null;
  const match = channelName
    .trim()
    .match(/^(.*?)[\s._-]*(AREA|HEIGHT|WIDTH|A|H|W)$/i);
  if (!match) return null;
  const base = match[1].trim().toUpperCase();
  const geometry = normalizeGeometryName(match[2]);
  return base && geometry ? { base, geometry } : null;
}

function detectPulseGeometry(options) {
  if (typeof options.pulseGeometryAvailable === "boolean") {
    return {
      available: options.pulseGeometryAvailable,
      source: "explicit-option",
      matchedFamilies: [],
    };
  }

  const families = new Map();
  for (const channelName of options.channelNames) {
    const parsed = parsePulseGeometryChannel(channelName);
    if (!parsed) continue;
    if (!families.has(parsed.base)) families.set(parsed.base, new Set());
    families.get(parsed.base).add(parsed.geometry);
  }

  const matchedFamilies = [];
  for (const [base, geometries] of families) {
    if (geometries.has("A") && (geometries.has("H") || geometries.has("W"))) {
      matchedFamilies.push({ base, geometries: [...geometries] });
    }
  }
  return {
    available: matchedFamilies.length > 0,
    source: "channel-names",
    matchedFamilies,
  };
}

function inspectPeakVisibility(
  fitResult,
  componentAreas,
  singletFractions,
  options,
) {
  const { observed, g1, g2 } = fitResult.curves;
  const observedMaximum = Math.max(maximumValue(observed), 1e-12);
  const g1PeakHeight = maximumValue(g1);
  const g2PeakHeight = maximumValue(g2);
  const g1HeightFraction = g1PeakHeight / observedMaximum;
  const g2HeightFraction = g2PeakHeight / observedMaximum;
  const g1Visible =
    g1HeightFraction >= options.minimumPeakHeightFraction &&
    singletFractions.oneC >= options.minimumPeakAreaFraction;
  const g2Visible =
    g2HeightFraction >= options.minimumPeakHeightFraction &&
    singletFractions.twoC >= options.minimumPeakAreaFraction;

  return {
    visiblePeakCount: Number(g1Visible) + Number(g2Visible),
    g1Visible,
    g2Visible,
    g1PeakHeight,
    g2PeakHeight,
    g1HeightFraction,
    g2HeightFraction,
    g1Area: componentAreas.g1,
    g2Area: componentAreas.g2,
  };
}

function getFitConstraints(fitResult) {
  const fittedOptions = fitResult.diagnostics?.options ?? {};
  return {
    cvMin: fittedOptions.cvMin ?? 0.01,
    cvMax: fittedOptions.cvMax ?? 0.2,
    ratioMin: fittedOptions.ratioMin ?? 1.7,
    ratioMax: fittedOptions.ratioMax ?? 2.3,
    ratioTarget: fittedOptions.ratioTarget ?? 2.0,
    unlockRatio:
      fittedOptions.unlockRatio ??
      fitResult.diagnostics?.ratioWasUnlocked ??
      false,
    aggregateMaxFraction: fittedOptions.aggregateMaxFraction ?? 1.0,
    debrisTauMinFraction: fittedOptions.debrisTauMinFraction ?? 0.02,
    debrisTauMaxFraction: fittedOptions.debrisTauMaxFraction ?? 0.75,
  };
}

function isNearFiniteBoundary(
  value,
  minimum,
  maximum,
  toleranceFraction,
) {
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(minimum) ||
    !Number.isFinite(maximum) ||
    maximum <= minimum
  ) {
    return { nearMinimum: false, nearMaximum: false };
  }
  const tolerance = toleranceFraction * (maximum - minimum);
  return {
    nearMinimum: value <= minimum + tolerance,
    nearMaximum: value >= maximum - tolerance,
  };
}

function findBoundaryParameters(fitResult, options) {
  const parameters = fitResult.parameters ?? {};
  const constraints = getFitConstraints(fitResult);
  const boundaryParameters = [];

  for (const [name, value] of [
    ["cv1", parameters.cv1],
    ["cv2", parameters.cv2],
  ]) {
    const result = isNearFiniteBoundary(
      value,
      constraints.cvMin,
      constraints.cvMax,
      options.boundaryToleranceFraction,
    );
    if (result.nearMinimum) {
      boundaryParameters.push({
        parameter: name,
        boundary: "minimum",
        value,
        limit: constraints.cvMin,
      });
    }
    if (result.nearMaximum) {
      boundaryParameters.push({
        parameter: name,
        boundary: "maximum",
        value,
        limit: constraints.cvMax,
      });
    }
  }

  if (constraints.unlockRatio && Number.isFinite(parameters.R)) {
    const result = isNearFiniteBoundary(
      parameters.R,
      constraints.ratioMin,
      constraints.ratioMax,
      options.boundaryToleranceFraction,
    );
    if (result.nearMinimum) {
      boundaryParameters.push({
        parameter: "R",
        boundary: "minimum",
        value: parameters.R,
        limit: constraints.ratioMin,
      });
    }
    if (result.nearMaximum) {
      boundaryParameters.push({
        parameter: "R",
        boundary: "maximum",
        value: parameters.R,
        limit: constraints.ratioMax,
      });
    }
  }

  if (
    fitResult.selectedModel?.includes("aggregate") &&
    Number.isFinite(parameters.pAggregate)
  ) {
    const result = isNearFiniteBoundary(
      parameters.pAggregate,
      0,
      constraints.aggregateMaxFraction,
      options.boundaryToleranceFraction,
    );
    if (result.nearMinimum) {
      boundaryParameters.push({
        parameter: "pAggregate",
        boundary: "minimum",
        value: parameters.pAggregate,
        limit: 0,
      });
    }
    if (result.nearMaximum) {
      boundaryParameters.push({
        parameter: "pAggregate",
        boundary: "maximum",
        value: parameters.pAggregate,
        limit: constraints.aggregateMaxFraction,
      });
    }
  }

  if (
    fitResult.selectedModel?.includes("debris") &&
    Number.isFinite(parameters.debrisTau) &&
    Number.isFinite(parameters.mu1)
  ) {
    const minimumTau = constraints.debrisTauMinFraction * parameters.mu1;
    const maximumTau = constraints.debrisTauMaxFraction * parameters.mu1;
    const result = isNearFiniteBoundary(
      parameters.debrisTau,
      minimumTau,
      maximumTau,
      options.boundaryToleranceFraction,
    );
    if (result.nearMinimum) {
      boundaryParameters.push({
        parameter: "debrisTau",
        boundary: "minimum",
        value: parameters.debrisTau,
        limit: minimumTau,
      });
    }
    if (result.nearMaximum) {
      boundaryParameters.push({
        parameter: "debrisTau",
        boundary: "maximum",
        value: parameters.debrisTau,
        limit: maximumTau,
      });
    }
  }

  const observedMaximum = Math.max(maximumValue(fitResult.curves.observed), 1);
  const zeroTolerance =
    options.nonnegativeBoundaryToleranceFraction * observedMaximum;
  const nonnegativeParameters = ["a1", "a2", "s0", "s1", "s2"];
  if (fitResult.selectedModel?.includes("debris")) {
    nonnegativeParameters.push("debrisAmplitude");
  }
  for (const parameterName of nonnegativeParameters) {
    const value = parameters[parameterName];
    if (Number.isFinite(value) && value <= zeroTolerance) {
      boundaryParameters.push({
        parameter: parameterName,
        boundary: "minimum",
        value,
        limit: 0,
      });
    }
  }
  return boundaryParameters;
}

function createWarning(code, severity, message, details = {}) {
  return { code, severity, message, details };
}

function generateWarnings({
  fitResult,
  options,
  pulseGeometry,
  peakVisibility,
  residualStructure,
  boundaryParameters,
}) {
  const warnings = [];

  if (!pulseGeometry.available) {
    warnings.push(
      createWarning(
        "NO_PULSE_GEOMETRY_CHANNELS",
        "warning",
        "No usable pulse area/height or area/width channel pair was found. Doublet and aggregate exclusion may be unreliable.",
        { channelNames: options.channelNames },
      ),
    );
  }

  if (peakVisibility.visiblePeakCount < 2) {
    warnings.push(
      createWarning(
        "ONLY_ONE_VISIBLE_PEAK",
        "warning",
        "The fitted histogram does not contain two clearly supported 1C and 2C peaks.",
        {
          visiblePeakCount: peakVisibility.visiblePeakCount,
          g1Visible: peakVisibility.g1Visible,
          g2Visible: peakVisibility.g2Visible,
          g1HeightFraction: peakVisibility.g1HeightFraction,
          g2HeightFraction: peakVisibility.g2HeightFraction,
        },
      ),
    );
  }

  const ratio = fitResult.parameters?.R;
  if (
    Number.isFinite(ratio) &&
    Math.abs(ratio - options.expectedRatio) > options.ratioWarningTolerance
  ) {
    warnings.push(
      createWarning(
        "RATIO_FAR_FROM_EXPECTED",
        "warning",
        `The fitted G2/G1 ratio is ${ratio.toFixed(3)}, which is far from the expected ratio of ${options.expectedRatio.toFixed(3)}.`,
        {
          fittedRatio: ratio,
          expectedRatio: options.expectedRatio,
          absoluteDifference: Math.abs(ratio - options.expectedRatio),
          tolerance: options.ratioWarningTolerance,
        },
      ),
    );
  }

  if (boundaryParameters.length > 0) {
    warnings.push(
      createWarning(
        "PARAMETER_AT_CONSTRAINT_BOUNDARY",
        "warning",
        "One or more fitted parameters are at or near an imposed constraint boundary.",
        { parameters: boundaryParameters },
      ),
    );
  }

  const excessiveAutocorrelation =
    Math.abs(residualStructure.lagOneAutocorrelation) >
    options.residualAutocorrelationThreshold;
  const excessiveLocalBias =
    residualStructure.maximumLocalBiasZ > options.residualWindowZThreshold;
  if (excessiveAutocorrelation || excessiveLocalBias) {
    warnings.push(
      createWarning(
        "POOR_RESIDUAL_STRUCTURE",
        "warning",
        "The residuals contain systematic structure rather than behaving like uncorrelated noise.",
        {
          lagOneAutocorrelation: residualStructure.lagOneAutocorrelation,
          autocorrelationThreshold: options.residualAutocorrelationThreshold,
          maximumLocalBiasZ: residualStructure.maximumLocalBiasZ,
          localBiasThreshold: options.residualWindowZThreshold,
          localBiasStartIndex: residualStructure.localBiasStartIndex,
          localBiasEndIndex: residualStructure.localBiasEndIndex,
          localBiasMeanResidual: residualStructure.localBiasMeanResidual,
        },
      ),
    );
  }
  return warnings;
}

function summarizeCellCycleFit(fitResult, userOptions = {}) {
  validateFitResult(fitResult);

  const channelNames =
    userOptions?.channelNames ?? DEFAULT_REPORT_OPTIONS.channelNames;
  if (!isArrayLikeSequence(channelNames)) {
    throw new TypeError("options.channelNames must be an array or typed array.");
  }
  const options = {
    ...DEFAULT_REPORT_OPTIONS,
    ...(userOptions ?? {}),
    channelNames: Array.from(channelNames),
  };

  const componentAreas = integrateFittedComponents(fitResult);
  const singletFractions = computeSingletFractions(componentAreas);
  const contaminationFractions = computeContaminationFractions(componentAreas);
  const goodnessOfFit = computeGoodnessOfFit(fitResult, options);
  const residualStructure = analyzeResidualStructure(
    goodnessOfFit.residuals,
    options,
  );
  const pulseGeometry = detectPulseGeometry(options);
  const peakVisibility = inspectPeakVisibility(
    fitResult,
    componentAreas,
    singletFractions,
    options,
  );
  const boundaryParameters = findBoundaryParameters(fitResult, options);
  const warnings = generateWarnings({
    fitResult,
    options,
    pulseGeometry,
    peakVisibility,
    residualStructure,
    boundaryParameters,
  });

  return {
    model: fitResult.selectedModel ?? "base",
    areas: {
      oneC: componentAreas.g1,
      sPhase: componentAreas.s,
      twoC: componentAreas.g2,
      biologicalSingletTotal: singletFractions.biologicalSingletTotal,
      aggregate: componentAreas.aggregate,
      debris: componentAreas.debris,
      contaminationTotal: contaminationFractions.contaminationArea,
      totalModeled: contaminationFractions.totalModeledArea,
      totalObserved: componentAreas.observed,
      fittedCurveArea: componentAreas.fitted,
    },
    fractions: {
      biologicalSinglets: {
        oneC: singletFractions.oneC,
        sPhase: singletFractions.sPhase,
        twoC: singletFractions.twoC,
      },
      contamination: {
        aggregate: contaminationFractions.aggregate,
        debris: contaminationFractions.debris,
        combined: contaminationFractions.combined,
        aggregateWasModeled: contaminationFractions.aggregateWasModeled,
        debrisWasModeled: contaminationFractions.debrisWasModeled,
      },
    },
    goodnessOfFit: {
      observationCount: goodnessOfFit.observationCount,
      parameterCount: goodnessOfFit.parameterCount,
      degreesOfFreedom: goodnessOfFit.degreesOfFreedom,
      sse: goodnessOfFit.sse,
      mse: goodnessOfFit.mse,
      rmse: goodnessOfFit.rmse,
      mae: goodnessOfFit.mae,
      rSquared: goodnessOfFit.rSquared,
      adjustedRSquared: goodnessOfFit.adjustedRSquared,
      pearsonChiSquare: goodnessOfFit.pearsonChiSquare,
      reducedPearsonChiSquare: goodnessOfFit.reducedPearsonChiSquare,
      aic: goodnessOfFit.aic,
      bic: goodnessOfFit.bic,
    },
    residualStructure,
    qualityChecks: {
      pulseGeometry,
      peakVisibility,
      boundaryParameters,
      warningCount: warnings.length,
      passed: warnings.length === 0,
    },
    warnings,
    options,
  };
}

function fractionToPercent(fraction, decimalPlaces = 1) {
  if (!Number.isFinite(fraction)) return null;
  return (100 * fraction).toFixed(decimalPlaces);
}

function createDisplaySummary(report, decimalPlaces = 1) {
  return {
    cellCycle: {
      oneC: `${fractionToPercent(
        report.fractions.biologicalSinglets.oneC,
        decimalPlaces,
      )}%`,
      sPhase: `${fractionToPercent(
        report.fractions.biologicalSinglets.sPhase,
        decimalPlaces,
      )}%`,
      twoC: `${fractionToPercent(
        report.fractions.biologicalSinglets.twoC,
        decimalPlaces,
      )}%`,
    },
    contamination: {
      aggregate: `${fractionToPercent(
        report.fractions.contamination.aggregate,
        decimalPlaces,
      )}%`,
      debris: `${fractionToPercent(
        report.fractions.contamination.debris,
        decimalPlaces,
      )}%`,
      combined: `${fractionToPercent(
        report.fractions.contamination.combined,
        decimalPlaces,
      )}%`,
    },
    goodnessOfFit: {
      rmse: report.goodnessOfFit.rmse,
      rSquared: report.goodnessOfFit.rSquared,
      reducedPearsonChiSquare:
        report.goodnessOfFit.reducedPearsonChiSquare,
      aic: report.goodnessOfFit.aic,
      bic: report.goodnessOfFit.bic,
    },
    warnings: report.warnings.map((warning) => warning.message),
  };
}

export {
  DEFAULT_REPORT_OPTIONS,
  isArrayLikeSequence,
  sum,
  validateFitResult,
  getOptionalCurve,
  integrateFittedComponents,
  computeSingletFractions,
  computeContaminationFractions,
  inferParameterCount,
  computeGoodnessOfFit,
  calculateLagOneAutocorrelation,
  calculateDurbinWatson,
  calculateMaximumLocalBias,
  analyzeResidualStructure,
  normalizeGeometryName,
  parsePulseGeometryChannel,
  detectPulseGeometry,
  inspectPeakVisibility,
  getFitConstraints,
  isNearFiniteBoundary,
  findBoundaryParameters,
  createWarning,
  generateWarnings,
  summarizeCellCycleFit,
  fractionToPercent,
  createDisplaySummary,
  integrateTrapezoidal,
  // Source helper names retained after moving their implementations to stats.
  clamp,
  mean,
  median,
  maximumValue as maximum,
  sumSquares,
  robustResidualScale,
  safeFraction,
};
