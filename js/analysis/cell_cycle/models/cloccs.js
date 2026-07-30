// ============================================================================
// CLOCCS joint time-series cell-cycle model (docs/plans/CLOCCS_modeling.md).
//
// UNVERIFIED. This is a faithful code representation of the CLOCCS
// arrest-and-release branching-process model in the design doc, but it has NOT
// yet been validated against external software or annotated biological data.
// The model selector labels it "CLOCCS (Unverified)" for exactly that reason.
// What IS established here (by unit_tests_cloccs.py) is internal soundness: each
// mathematical operation matches the spec, densities normalise, and parameters
// are recovered from data the model itself generated (models/cloccs_synthetic.js).
//
// Unlike Dean-Jett / Dean-Jett-Fox / Watson (each a single-histogram fit), CLOCCS
// is fitScope "joint_series": it fits ONE set of shared biological timing
// parameters across a strain's whole timepoint series, with per-sample
// fluorescence/noise parameters. Cohorts are indexed by generation g and
// reproductive instance r (§10); cohort mass (§11) and a truncated-normal
// lifeline-position distribution per cohort (§12) give a mixture position
// density; a piecewise position→DNA map (§13) plus a Gaussian measurement model
// give the predicted DNA density (§14); the binned Poisson-multinomial
// log-likelihood (§15) plus priors (§17) form the joint strain log-posterior
// (§18), maximised (MAP) by the optimiser (§19).
//
// Section numbers below refer to CLOCCS_modeling.md.
// ============================================================================

import { normalCdf, normalPdf } from "../../math/gaussian_bin_mass.js";
import { median } from "../../math/stats.js";
import { minimizeNelderMead } from "../../math/nelder_mead.js";

const EPS = 1e-12;

export const DEFAULT_CONFIG = Object.freeze({
  maxReproductiveInstance: 5, // §1 maxR: how many reproductive instances to enumerate
  likelihoodMode: "binned",   // "binned" (fast, §15) or "event" (§16)
  gridSize: 400,              // latent-position integration grid (spec §14 uses 600)
  coordinateRounds: 10,       // block-coordinate MAP rounds per start
  biologicalMaxIterations: 320,
  sampleMaxIterations: 160,
  objectiveTolerance: 1e-5,
  starts: 1,                  // multi-start count; >1 also yields dispersion diagnostics
  startSeed: 1,               // deterministic seed for dispersed starting points
  // Optional MCMC posterior stage (§19 runPosteriorSampling).
  posteriorDraws: 600,
  posteriorBurnIn: 200,
  posteriorStepSize: 0.05,
  posteriorSeed: 20260726,
});

// A small deterministic PRNG (mulberry32) for dispersed starts and MCMC, so the
// fit and its diagnostics are reproducible.
function makeLocalRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── §9 helpers: unconstrained <-> constrained transforms ─────────────────────
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}
function logit(p) {
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  return Math.log(q / (1 - q));
}
const standardNormalCdf = (z) => normalCdf(z, 0, 1);

function positiveModulo(value, modulus) {
  return ((value % modulus) + modulus) % modulus;
}

// Numerically stable n-choose-k for the small integers CLOCCS uses (§11).
function binomialCoefficient(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 0; i < kk; i += 1) result = (result * (n - i)) / (i + 1);
  return result;
}

// Truncated-normal density on [lower, upper]; 0 outside. Infinite bounds are
// handled explicitly so no Infinity*0 ever produces a NaN.
function truncatedNormalPdf({ x, mean, sd, lower, upper }) {
  if (x < lower || x > upper) return 0;
  const s = Math.max(Math.abs(sd), EPS);
  const phi = normalPdf(x, mean, s);
  const cdfUpper = upper === Infinity ? 1 : normalCdf(upper, mean, s);
  const cdfLower = lower === -Infinity ? 0 : normalCdf(lower, mean, s);
  const denom = cdfUpper - cdfLower;
  return denom > EPS ? phi / denom : 0;
}

// ── §9 parameter transforms ──────────────────────────────────────────────────

/*
Purpose: §9. Decodes unconstrained raw biological parameters into valid
	biological values. gamma1 is squashed to (0,1); gamma2 is built as
	gamma1 + (1-gamma1)*sigmoid(gap) so gamma2 > gamma1 and gamma2 < 1 always.
Input: raw [object]: { logMu0, logSigma0, logSigmaV, logLambda, logDelta,
	gamma1Raw, gamma2GapRaw }
Output: theta [object]: { mu0, sigma0, sigmaV, lambda, delta, gamma1, gamma2 }
*/
export function decodeBiologicalParameters(raw) {
  const gamma1 = sigmoid(raw.gamma1Raw);
  const gamma2 = gamma1 + (1 - gamma1) * sigmoid(raw.gamma2GapRaw);
  return {
    mu0: Math.exp(raw.logMu0),
    sigma0: Math.exp(raw.logSigma0),
    sigmaV: Math.exp(raw.logSigmaV),
    lambda: Math.exp(raw.logLambda),
    delta: Math.exp(raw.logDelta),
    gamma1,
    gamma2,
  };
}

/*
Purpose: inverse of decodeBiologicalParameters, for seeding the optimiser and
	for round-trip tests.
*/
export function encodeBiologicalParameters(theta) {
  const gap = (theta.gamma2 - theta.gamma1) / (1 - theta.gamma1);
  return {
    logMu0: Math.log(theta.mu0),
    logSigma0: Math.log(theta.sigma0),
    logSigmaV: Math.log(theta.sigmaV),
    logLambda: Math.log(theta.lambda),
    logDelta: Math.log(theta.delta),
    gamma1Raw: logit(theta.gamma1),
    gamma2GapRaw: logit(gap),
  };
}

/* §9 sample transforms. */
export function decodeSampleParameters(raw) {
  return { alpha1: Math.exp(raw.logAlpha1), alpha2: Math.exp(raw.logAlpha2), tau: Math.exp(raw.logTau) };
}
export function encodeSampleParameters(sampleParameters) {
  return {
    logAlpha1: Math.log(sampleParameters.alpha1),
    logAlpha2: Math.log(sampleParameters.alpha2),
    logTau: Math.log(sampleParameters.tau),
  };
}

// Flat-array views used by the optimiser, in a fixed canonical order.
const BIO_ORDER = ["logMu0", "logSigma0", "logSigmaV", "logLambda", "logDelta", "gamma1Raw", "gamma2GapRaw"];
const SAMPLE_ORDER = ["logAlpha1", "logAlpha2", "logTau"];
const bioArrayToNamed = (arr) => Object.fromEntries(BIO_ORDER.map((key, i) => [key, arr[i]]));
const bioNamedToArray = (named) => BIO_ORDER.map((key) => named[key]);
const sampleArrayToNamed = (arr) => Object.fromEntries(SAMPLE_ORDER.map((key, i) => [key, arr[i]]));
const sampleNamedToArray = (named) => SAMPLE_ORDER.map((key) => named[key]);

// ── §10 cohorts ──────────────────────────────────────────────────────────────

/*
Purpose: §10. Enumerates branching-process cohorts. {0,0} is the original
	synchronized population; later cohorts have g daughter stages and reproductive
	instance r, with 1 <= g <= r <= maxR.
*/
export function enumerateCohorts(maxR) {
  const cohorts = [{ g: 0, r: 0 }];
  for (let r = 1; r <= maxR; r += 1) {
    for (let g = 1; g <= r; g += 1) cohorts.push({ g, r });
  }
  return cohorts;
}

// ── §11 cohort mass and weights ──────────────────────────────────────────────

/*
Purpose: §11. Unnormalized mass M(g,r,t) of a cohort at time t.
*/
export function cohortMass(cohort, time, theta) {
  const { g, r } = cohort;
  if (g === 0 && r === 0) return 1;
  if (g < 1 || r < g) return 0;
  const positionSd = Math.sqrt(theta.sigma0 ** 2 + time ** 2 * theta.sigmaV ** 2);
  const thresholdZ = (theta.mu0 - time + r * theta.lambda + (g - 1) * theta.delta) / Math.max(positionSd, EPS);
  const lineageMultiplicity = binomialCoefficient(r - 1, g - 1);
  return (1 - standardNormalCdf(thresholdZ)) * lineageMultiplicity;
}

/*
Purpose: §11. Normalized cohort weights (sum to 1) at time t.
*/
export function computeCohortWeights(time, theta, maxR) {
  const cohorts = enumerateCohorts(maxR);
  const masses = cohorts.map((cohort) => ({ cohort, mass: cohortMass(cohort, time, theta) }));
  const totalMass = masses.reduce((sum, item) => sum + item.mass, 0);
  if (!(totalMass > 0)) throw new Error("CLOCCS cohort mass collapsed to zero.");
  return masses.map((item) => ({ ...item.cohort, weight: item.mass / totalMass }));
}

// ── §12 cohort position distribution ─────────────────────────────────────────

/*
Purpose: §12. Mean, sd and lower truncation bound of one cohort's latent
	lifeline-position distribution at time t.
*/
export function cohortPositionParameters(cohort, time, theta) {
  const mean = -theta.mu0 + time - cohort.r * theta.lambda - cohort.g * theta.delta;
  const sd = Math.sqrt(theta.sigma0 ** 2 + time ** 2 * theta.sigmaV ** 2);
  const lowerBound = cohort.g === 0 && cohort.r === 0 ? -Infinity : -theta.delta;
  return { mean, sd, lowerBound };
}

export function cohortPositionDensity(position, cohort, time, theta) {
  const p = cohortPositionParameters(cohort, time, theta);
  if (position < p.lowerBound) return 0;
  return truncatedNormalPdf({ x: position, mean: p.mean, sd: p.sd, lower: p.lowerBound, upper: Infinity });
}

/*
Purpose: §12. The full mixture position density: weighted sum over cohorts.
	Because the weights sum to 1 and each cohort density integrates to 1 over its
	support, this integrates to 1 over the whole position axis.
*/
export function cloccsPositionDensity(position, time, theta, maxR) {
  const weights = computeCohortWeights(time, theta, maxR);
  let density = 0;
  for (const cohort of weights) density += cohort.weight * cohortPositionDensity(position, cohort, time, theta);
  return density;
}

// ── §13 lifeline position -> expected DNA fluorescence ───────────────────────

/*
Purpose: §13. Expected DNA fluorescence for a cell at a given lifeline position.
	Negative positions (recovery / daughter delay) are 1C (G1). Within the cycle,
	G1 = 1C, S ramps linearly 1C->2C, G2/M = 2C.
*/
export function expectedDnaFromPosition(position, theta, sampleParameters) {
  if (position < 0) return sampleParameters.alpha1;
  const positionWithinCycle = positiveModulo(position, theta.lambda);
  const phaseFraction = positionWithinCycle / theta.lambda;
  if (phaseFraction < theta.gamma1) return sampleParameters.alpha1;
  if (phaseFraction < theta.gamma2) {
    const sProgress = (phaseFraction - theta.gamma1) / (theta.gamma2 - theta.gamma1);
    return sampleParameters.alpha1 + sampleParameters.alpha2 * sProgress;
  }
  return sampleParameters.alpha1 + sampleParameters.alpha2;
}

/*
Purpose: §21. Which cell-cycle phase a lifeline position belongs to.
*/
export function phaseFromPosition(position, theta) {
  if (position < 0) return "G1";
  const fraction = positiveModulo(position, theta.lambda) / theta.lambda;
  if (fraction < theta.gamma1) return "G1";
  if (fraction < theta.gamma2) return "S";
  return "G2M";
}

// ── §14 predicted DNA density ────────────────────────────────────────────────

function linspace(min, max, count) {
  if (count < 2) return [min];
  const grid = new Array(count);
  const step = (max - min) / (count - 1);
  for (let i = 0; i < count; i += 1) grid[i] = min + i * step;
  return grid;
}

function trapezoidIntegral(grid, integrand) {
  let total = 0;
  for (let i = 1; i < grid.length; i += 1) {
    total += 0.5 * (integrand[i] + integrand[i - 1]) * (grid[i] - grid[i - 1]);
  }
  return total;
}

/*
Purpose: chooses a latent-position integration window that covers every cohort's
	mass at time t (each cohort's [lowerBound or mean-6sd, mean+6sd]), plus a
	margin below 0 so the recovery/G1 region is always included.
*/
export function choosePositionIntegrationRange(time, theta, maxR) {
  const cohorts = enumerateCohorts(maxR);
  let min = Infinity;
  let max = -Infinity;
  for (const cohort of cohorts) {
    const p = cohortPositionParameters(cohort, time, theta);
    const low = p.lowerBound === -Infinity ? p.mean - 6 * p.sd : p.lowerBound;
    const high = p.mean + 6 * p.sd;
    if (low < min) min = low;
    if (high > max) max = high;
  }
  min = Math.min(min, -2 * Math.max(theta.delta, theta.sigma0), -1);
  if (!(max > min)) max = min + 1;
  return { min, max };
}

/*
Purpose: §14. p(DNA | time) = integral over latent position of
	p(DNA | position) p(position | time). Matches the spec's per-value form; the
	histogram likelihood shares one grid across bins for speed (same maths).
*/
export function predictDnaDensityAtValue({ dnaValue, time, theta, sampleParameters, maxR, gridSize = DEFAULT_CONFIG.gridSize }) {
  const range = choosePositionIntegrationRange(time, theta, maxR);
  const grid = linspace(range.min, range.max, gridSize);
  const integrand = grid.map((position) => {
    const positionProbability = cloccsPositionDensity(position, time, theta, maxR);
    const expectedDna = expectedDnaFromPosition(position, theta, sampleParameters);
    return normalPdf(dnaValue, expectedDna, sampleParameters.tau) * positionProbability;
  });
  return trapezoidIntegral(grid, integrand);
}

// ── §15 binned likelihood ────────────────────────────────────────────────────

/*
Purpose: §15. Predicted per-bin probabilities for a sample's DNA histogram.
	Builds the shared position grid, cohort position density and expected-DNA map
	ONCE, then integrates the Gaussian measurement kernel per bin -- mathematically
	identical to calling predictDnaDensityAtValue per bin, but far cheaper.
*/
export function predictHistogramProbabilities({ sample, theta, sampleParameters, maxR, gridSize = DEFAULT_CONFIG.gridSize }) {
  const time = sample.timeMinutes;
  const range = choosePositionIntegrationRange(time, theta, maxR);
  const grid = linspace(range.min, range.max, gridSize);
  const positionDensity = grid.map((position) => cloccsPositionDensity(position, time, theta, maxR));
  const expectedDna = grid.map((position) => expectedDnaFromPosition(position, theta, sampleParameters));
  const tau = sampleParameters.tau;

  const binMasses = sample.histogram.binCenters.map((dnaValue) => {
    let integral = 0;
    let previous = normalPdf(dnaValue, expectedDna[0], tau) * positionDensity[0];
    for (let i = 1; i < grid.length; i += 1) {
      const current = normalPdf(dnaValue, expectedDna[i], tau) * positionDensity[i];
      integral += 0.5 * (current + previous) * (grid[i] - grid[i - 1]);
      previous = current;
    }
    return integral * sample.histogram.binWidth;
  });

  const totalMass = binMasses.reduce((sum, mass) => sum + mass, 0);
  if (!(totalMass > 0)) return binMasses.map(() => 1e-15);
  return binMasses.map((mass) => Math.max(mass / totalMass, 1e-15));
}

/*
Purpose: §15. Multinomial log-likelihood of a sample's histogram counts under
	the predicted per-bin probabilities.
*/
export function sampleHistogramLogLikelihood({ sample, theta, sampleParameters, maxR, gridSize }) {
  const probabilities = predictHistogramProbabilities({ sample, theta, sampleParameters, maxR, gridSize });
  let logLikelihood = 0;
  const counts = sample.histogram.counts;
  for (let i = 0; i < counts.length; i += 1) logLikelihood += counts[i] * Math.log(probabilities[i]);
  return logLikelihood;
}

/*
Purpose: §16. Optional event-level log-likelihood (slower; every event evaluated).
*/
export function sampleEventLogLikelihood({ sample, theta, sampleParameters, maxR, gridSize }) {
  let logLikelihood = 0;
  for (const dnaValue of sample.transformedDna ?? []) {
    const probability = predictDnaDensityAtValue({ dnaValue, time: sample.timeMinutes, theta, sampleParameters, maxR, gridSize });
    logLikelihood += Math.log(Math.max(probability, 1e-300));
  }
  return logLikelihood;
}

function sampleLogLikelihood(sample, theta, sampleParameters, config) {
  const shared = { sample, theta, sampleParameters, maxR: config.maxReproductiveInstance, gridSize: config.gridSize };
  return config.likelihoodMode === "event" ? sampleEventLogLikelihood(shared) : sampleHistogramLogLikelihood(shared);
}

// ── §17 priors (MAP regularisers: log-density kernels up to constants) ────────

function logNormalPrior(value, { logMean, logSd }) {
  if (!(value > 0)) return -Infinity;
  const z = (Math.log(value) - logMean) / logSd;
  return -0.5 * z * z;
}
function halfNormalPrior(value, sd) {
  if (value < 0) return -Infinity;
  const z = value / sd;
  return -0.5 * z * z;
}
function normalPrior(value, mean, sd) {
  const z = (value - mean) / Math.max(Math.abs(sd), EPS);
  return -0.5 * z * z;
}
function betaPrior(value, { a, b }) {
  if (!(value > 0) || !(value < 1)) return -Infinity;
  return (a - 1) * Math.log(value) + (b - 1) * Math.log(1 - value);
}

export function biologicalLogPrior(theta, priorConfig) {
  return (
    logNormalPrior(theta.lambda, priorConfig.lambda) +
    halfNormalPrior(theta.mu0, priorConfig.mu0Sd) +
    halfNormalPrior(theta.sigma0, priorConfig.sigma0Sd) +
    halfNormalPrior(theta.sigmaV, priorConfig.sigmaVSd) +
    halfNormalPrior(theta.delta, priorConfig.deltaSd) +
    betaPrior(theta.gamma1, priorConfig.gamma1) +
    betaPrior(theta.gamma2, priorConfig.gamma2)
  );
}

export function sampleParameterLogPrior(sampleParameters, initialization) {
  return (
    normalPrior(sampleParameters.alpha1, initialization.alpha1, Math.max(initialization.alpha1 * 0.15, EPS)) +
    normalPrior(sampleParameters.alpha2, initialization.alpha2, Math.max(initialization.alpha2 * 0.15, EPS)) +
    halfNormalPrior(sampleParameters.tau, Math.max(initialization.tau * 3, EPS))
  );
}

function estimateCycleLengthFromSeries(series) {
  const times = (series.uniqueTimepoints ?? []).filter(Number.isFinite);
  if (times.length < 2) return null;
  const span = Math.max(...times) - Math.min(...times);
  return Math.min(200, Math.max(40, span));
}

export function createDefaultCloccsPriors(series) {
  const lambdaGuess = estimateCycleLengthFromSeries(series) ?? 80;
  return {
    lambda: { logMean: Math.log(lambdaGuess), logSd: 0.5 },
    mu0Sd: 40,
    sigma0Sd: 25,
    sigmaVSd: 0.25,
    deltaSd: 40,
    gamma1: { a: 2, b: 6 }, // prior mean ~0.25 (S phase starts ~1/4 into the cycle)
    gamma2: { a: 4, b: 4 }, // prior mean ~0.50
  };
}

export function createInitialBiologicalParameters(series) {
  return {
    mu0: 10,
    sigma0: 5,
    sigmaV: 0.08,
    lambda: estimateCycleLengthFromSeries(series) ?? 80,
    delta: 15,
    gamma1: 0.2,
    gamma2: 0.5,
  };
}

// ── §18 joint strain log-posterior ───────────────────────────────────────────

/*
Purpose: §18. The joint log-posterior for one strain: the biological prior plus,
	over every sample, that sample's histogram/event log-likelihood and its
	fluorescence-parameter prior. `sampleParametersById` maps sampleId -> decoded
	{ alpha1, alpha2, tau }.
*/
export function strainLogPosterior({ theta, sampleParametersById, series, config, priorConfig }) {
  let result = biologicalLogPrior(theta, priorConfig);
  if (!Number.isFinite(result)) return -Infinity;
  for (const sample of series.samples) {
    const sampleParameters = sampleParametersById.get(sample.sampleId);
    result += sampleLogLikelihood(sample, theta, sampleParameters, config);
    result += sampleParameterLogPrior(sampleParameters, sample.fluorescenceInit);
  }
  return result;
}

// ── §19 fit one strain (block-coordinate MAP) ────────────────────────────────

/*
Purpose: §19/§21/§22. Fits one strain's shared biological parameters and every
	sample's fluorescence parameters by MAP. Because, given theta, each sample's
	likelihood + prior is independent of the others, this uses block-coordinate
	optimisation: optimise the 7 biological raw parameters (all samples fixed),
	then optimise each sample's 3 raw parameters independently (theta fixed),
	repeating until the joint objective stops improving. Each block is <=7-D, where
	Nelder-Mead is reliable.

Input:
	series [object]: { strain, samples: [{ sampleId, timeMinutes, histogram:
		{ binCenters, binWidth, counts }, transformedDna?, fluorescenceInit:
		{ alpha1, alpha2, tau } }], uniqueTimepoints }
	config [object]: DEFAULT_CONFIG overrides

Output:
	result [object]: { strain, status, theta, sampleParameters (Map),
		timepointResults, diagnostics }
*/
// Deterministic dispersed starting points for multi-start MAP. The first start
// is the default initialization; the rest jitter the biological seed within
// plausible ranges so agreement across starts becomes an identifiability signal.
function buildDispersedStarts(series, count, seed) {
  const baseBio = createInitialBiologicalParameters(series);
  const baseSampleRaw = new Map();
  for (const sample of series.samples) {
    baseSampleRaw.set(sample.sampleId, sampleNamedToArray(encodeSampleParameters(sample.fluorescenceInit)));
  }

  const starts = [{ bioRaw: bioNamedToArray(encodeBiologicalParameters(baseBio)), sampleRawById: baseSampleRaw }];
  const rng = makeLocalRng(seed);
  for (let s = 1; s < count; s += 1) {
    const jittered = {
      mu0: baseBio.mu0 * (0.5 + 1.5 * rng()),
      sigma0: baseBio.sigma0 * (0.6 + 0.8 * rng()),
      sigmaV: baseBio.sigmaV * (0.5 + 1.5 * rng()),
      lambda: baseBio.lambda * (0.7 + 0.6 * rng()),
      delta: baseBio.delta * (0.5 + 1.5 * rng()),
      gamma1: 0.1 + 0.3 * rng(),
      gamma2: 0.5 + 0.4 * rng(),
    };
    if (!(jittered.gamma2 > jittered.gamma1)) jittered.gamma2 = jittered.gamma1 + 0.1;
    starts.push({ bioRaw: bioNamedToArray(encodeBiologicalParameters(jittered)), sampleRawById: baseSampleRaw });
  }
  return starts;
}

/*
Purpose: §19 core. A generator that runs ONE start's block-coordinate MAP fit,
	yielding { round, objective } after each coordinate round and returning the
	fitted raw parameters. Driving it to completion synchronously gives the plain
	fit (tests); driving it with an await between yields lets a worker return to
	its event loop and process a cancel message between rounds (real cancellation).
*/
function* fitSingleStartSteps(series, config, priorConfig, bioRawInit, sampleRawInit) {
  let bioRaw = bioRawInit.slice();
  const sampleRawById = new Map();
  for (const [id, raw] of sampleRawInit) sampleRawById.set(id, raw.slice());

  const decodedSamples = () => {
    const map = new Map();
    for (const sample of series.samples) map.set(sample.sampleId, decodeSampleParameters(sampleArrayToNamed(sampleRawById.get(sample.sampleId))));
    return map;
  };
  const jointNeg = () => -strainLogPosterior({ theta: decodeBiologicalParameters(bioArrayToNamed(bioRaw)), sampleParametersById: decodedSamples(), series, config, priorConfig });
  const negBiologicalOf = (raw7) => -strainLogPosterior({ theta: decodeBiologicalParameters(bioArrayToNamed(raw7)), sampleParametersById: decodedSamples(), series, config, priorConfig });
  const negSampleOf = (sample, theta) => (raw3) => {
    const sp = decodeSampleParameters(sampleArrayToNamed(raw3));
    return -(sampleLogLikelihood(sample, theta, sp, config) + sampleParameterLogPrior(sp, sample.fluorescenceInit));
  };

  let previousObjective = jointNeg();
  let converged = false;
  let iterations = 0;
  for (let round = 0; round < config.coordinateRounds; round += 1) {
    const bioResult = minimizeNelderMead(negBiologicalOf, bioRaw, { maxIterations: config.biologicalMaxIterations });
    bioRaw = bioResult.point;
    iterations += bioResult.iterations;

    const theta = decodeBiologicalParameters(bioArrayToNamed(bioRaw));
    for (const sample of series.samples) {
      const sampleResult = minimizeNelderMead(negSampleOf(sample, theta), sampleRawById.get(sample.sampleId), { maxIterations: config.sampleMaxIterations });
      sampleRawById.set(sample.sampleId, sampleResult.point);
      iterations += sampleResult.iterations;
    }

    const objective = jointNeg();
    const done = Math.abs(previousObjective - objective) <= config.objectiveTolerance * (Math.abs(previousObjective) + 1);
    previousObjective = objective;
    yield { round, objective };
    if (done) {
      converged = true;
      break;
    }
  }
  return { bioRaw, sampleRawById, objective: previousObjective, converged, iterations };
}

function meanSdStat(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sd = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
  return { min, max, mean, cv: mean !== 0 ? sd / Math.abs(mean) : 0 };
}

// Multi-start dispersion: how much the fitted key parameters and objective vary
// across dispersed starts. Tight dispersion (small cv, high agreementFraction)
// => well-identified; wide => weakly identified / multimodal, so the point
// estimate should be treated with caution.
function summarizeStartDispersion(startOutcomes) {
  const thetas = startOutcomes.map((outcome) => decodeBiologicalParameters(bioArrayToNamed(outcome.bioRaw)));
  const objectives = startOutcomes.map((outcome) => outcome.objective);
  const bestObjective = Math.min(...objectives);
  const near = objectives.filter((objective) => objective <= bestObjective + 0.01 * (Math.abs(bestObjective) + 1)).length;
  return {
    starts: startOutcomes.length,
    lambda: meanSdStat(thetas.map((theta) => theta.lambda)),
    gamma1: meanSdStat(thetas.map((theta) => theta.gamma1)),
    gamma2: meanSdStat(thetas.map((theta) => theta.gamma2)),
    objective: meanSdStat(objectives),
    agreementFraction: near / objectives.length,
  };
}

function assembleCloccsResult(series, config, startOutcomes) {
  let best = startOutcomes[0];
  for (const outcome of startOutcomes) if (outcome.objective < best.objective) best = outcome;

  const theta = decodeBiologicalParameters(bioArrayToNamed(best.bioRaw));
  const sampleParameters = new Map();
  for (const sample of series.samples) {
    sampleParameters.set(sample.sampleId, decodeSampleParameters(sampleArrayToNamed(best.sampleRawById.get(sample.sampleId))));
  }

  const timepoints = series.uniqueTimepoints ?? [...new Set(series.samples.map((sample) => sample.timeMinutes))];
  const timepointResults = timepoints.map((time) => ({
    timeMinutes: time,
    phaseFractions: calculatePhaseFractions({ time, theta, maxR: config.maxReproductiveInstance }),
    cohortWeights: computeCohortWeights(time, theta, config.maxReproductiveInstance),
  }));

  return {
    strain: series.strain,
    status: "success",
    theta,
    sampleParameters,
    timepointResults,
    diagnostics: {
      converged: best.converged,
      objectiveValue: best.objective,
      iterations: startOutcomes.reduce((sum, outcome) => sum + outcome.iterations, 0),
      starts: startOutcomes.length,
      dispersion: summarizeStartDispersion(startOutcomes),
    },
  };
}

/*
Purpose: §19/§21/§22. Fits one strain by MAP over `config.starts` dispersed
	starts (block-coordinate within each), returning the best fit plus multi-start
	dispersion diagnostics. Synchronous -- used by tests and any caller that wants
	a blocking fit. Because, given theta, each sample's likelihood is independent,
	each start optimises the 7 biological parameters, then each sample's 3, and
	repeats; every block is <=7-D, where Nelder-Mead is reliable.

Input:
	series [object]: { strain, samples: [{ sampleId, timeMinutes, histogram:
		{ binCenters, binWidth, counts }, fluorescenceInit }], uniqueTimepoints }
	config [object]: DEFAULT_CONFIG overrides (incl. starts)

Output:
	result [object]: { strain, status, theta, sampleParameters, timepointResults,
		diagnostics: { converged, objectiveValue, iterations, starts, dispersion } }
*/
export function fitCloccsForStrain(series, userConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  const priorConfig = createDefaultCloccsPriors(series);
  const startInits = buildDispersedStarts(series, Math.max(1, config.starts ?? 1), config.startSeed ?? 1);
  const startOutcomes = startInits.map((init) => {
    const generator = fitSingleStartSteps(series, config, priorConfig, init.bioRaw, init.sampleRawById);
    let step = generator.next();
    while (!step.done) step = generator.next();
    return step.value;
  });
  return assembleCloccsResult(series, config, startOutcomes);
}

/*
Purpose: cooperative async variant of fitCloccsForStrain for a worker. Awaits a
	macrotask between coordinate rounds so the worker returns to its event loop
	and can process a posted cancel message; checks shouldCancel() at each round
	boundary. Reports progress via onProgress. Returns { cancelled: true } if
	cancelled, else the same result shape as fitCloccsForStrain.
*/
export async function fitCloccsForStrainAsync(series, userConfig = {}, { onProgress, shouldCancel } = {}) {
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  const priorConfig = createDefaultCloccsPriors(series);
  const startInits = buildDispersedStarts(series, Math.max(1, config.starts ?? 1), config.startSeed ?? 1);
  const startOutcomes = [];
  for (let s = 0; s < startInits.length; s += 1) {
    const generator = fitSingleStartSteps(series, config, priorConfig, startInits[s].bioRaw, startInits[s].sampleRawById);
    let step = generator.next();
    while (!step.done) {
      if (onProgress) onProgress({ phase: "fit", start: s, starts: startInits.length, round: step.value.round, objective: step.value.objective });
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (shouldCancel && shouldCancel()) return { cancelled: true, strain: series.strain };
      step = generator.next();
    }
    startOutcomes.push(step.value);
  }
  return assembleCloccsResult(series, config, startOutcomes);
}

/*
Purpose: §19 optional posterior stage. Random-walk Metropolis over the 7
	biological parameters (in unconstrained space), starting from the MAP, with
	the per-sample fluorescence parameters held at their MAP values. Returns
	2.5/50/97.5 credible intervals per biological parameter plus the acceptance
	rate. Deterministic given the seed. This is an exploratory uncertainty
	estimate for an unverified model, not a calibrated posterior.

Input:
	series [object]: the strain series
	config [object]: DEFAULT_CONFIG overrides (posteriorDraws/BurnIn/StepSize/Seed)
	mapResult [object]: the output of fitCloccsForStrain (for the MAP start + fixed
		sample parameters)

Output:
	posterior [object]: { draws, acceptanceRate, intervals: { lambda, mu0, delta,
		gamma1, gamma2, sigmaV: { p2_5, p50, p97_5 } } }
*/
export function sampleCloccsPosterior(series, userConfig, mapResult) {
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  const priorConfig = createDefaultCloccsPriors(series);
  const draws = config.posteriorDraws;
  const burnIn = config.posteriorBurnIn;
  const stepSize = config.posteriorStepSize;
  const rng = makeLocalRng(config.posteriorSeed);
  const gaussian = () => {
    const u1 = Math.max(1e-12, rng());
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };

  const sampleParametersById = mapResult.sampleParameters;
  const logPost = (bioRaw) => strainLogPosterior({
    theta: decodeBiologicalParameters(bioArrayToNamed(bioRaw)),
    sampleParametersById,
    series,
    config,
    priorConfig,
  });

  let current = bioNamedToArray(encodeBiologicalParameters(mapResult.theta));
  let currentLp = logPost(current);
  const kept = [];
  let acceptedAfterBurnIn = 0;
  const total = burnIn + draws;
  // The likelihood sums over thousands of events, so the posterior is sharp and
  // a fixed step size gives ~0% acceptance. Adapt a scalar step during burn-in
  // toward ~0.25 acceptance (multiplicative Robbins-Monro-style tuning); freeze
  // it afterwards so the retained draws come from a fixed-kernel chain.
  const targetAcceptance = 0.25;
  const adaptGain = 0.05;
  let adaptiveStep = stepSize;
  for (let i = 0; i < total; i += 1) {
    const proposal = current.map((value) => value + adaptiveStep * gaussian());
    const lp = logPost(proposal);
    const accept = Number.isFinite(lp) && Math.log(Math.max(1e-300, rng())) < lp - currentLp;
    if (accept) {
      current = proposal;
      currentLp = lp;
    }
    if (i < burnIn) {
      adaptiveStep *= Math.exp(adaptGain * ((accept ? 1 : 0) - targetAcceptance));
      adaptiveStep = Math.min(1, Math.max(1e-6, adaptiveStep));
    } else {
      if (accept) acceptedAfterBurnIn += 1;
      kept.push(decodeBiologicalParameters(bioArrayToNamed(current)));
    }
  }

  const interval = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const quantile = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
    return { p2_5: quantile(0.025), p50: quantile(0.5), p97_5: quantile(0.975) };
  };
  return {
    draws: kept.length,
    acceptanceRate: draws > 0 ? acceptedAfterBurnIn / draws : 0,
    stepSize: adaptiveStep,
    intervals: {
      lambda: interval(kept.map((theta) => theta.lambda)),
      mu0: interval(kept.map((theta) => theta.mu0)),
      delta: interval(kept.map((theta) => theta.delta)),
      gamma1: interval(kept.map((theta) => theta.gamma1)),
      gamma2: interval(kept.map((theta) => theta.gamma2)),
      sigmaV: interval(kept.map((theta) => theta.sigmaV)),
    },
  };
}

// ── §21 phase fractions from the fitted lifeline distribution ────────────────

/*
Purpose: §21. Phase fractions at time t by integrating the mixture position
	density over the lifeline axis and classifying each grid cell by phase.
*/
export function calculatePhaseFractions({ time, theta, maxR, gridSize = 1200 }) {
  const range = choosePositionIntegrationRange(time, theta, maxR);
  const grid = linspace(range.min, range.max, gridSize);
  let g1Mass = 0;
  let sMass = 0;
  let g2Mass = 0;
  for (let i = 1; i < grid.length; i += 1) {
    const midpoint = 0.5 * (grid[i - 1] + grid[i]);
    const width = grid[i] - grid[i - 1];
    const mass = cloccsPositionDensity(midpoint, time, theta, maxR) * width;
    const phase = phaseFromPosition(midpoint, theta);
    if (phase === "G1") g1Mass += mass;
    else if (phase === "S") sMass += mass;
    else g2Mass += mass;
  }
  const total = g1Mass + sMass + g2Mass;
  if (!(total > 0)) return { g1: 0, s: 0, g2: 0 };
  return { g1: g1Mass / total, s: sMass / total, g2: g2Mass / total };
}

// ── model-registry entry ─────────────────────────────────────────────────────

/*
Purpose: builds a CLOCCS histogram object from bin edges and counts (the shape
	fitCloccsForStrain expects for each sample).
*/
export function histogramFromEdgesCounts(edges, counts) {
  const binCenters = new Array(counts.length);
  for (let i = 0; i < counts.length; i += 1) binCenters[i] = 0.5 * (edges[i] + edges[i + 1]);
  return { edges, counts: Array.from(counts), binCenters, binWidth: edges[1] - edges[0] };
}

export const cloccs = {
  id: "cloccs",
  version: "0.1.0-unverified",
  label: "CLOCCS (Unverified)",
  kind: "generative_series",
  fitScope: "joint_series",
  comparisonGroup: null, // never AIC/BIC-ranked against the per-sample models
  requiredInputs: ["sample_series"],
  capabilities: { contaminants: false, multiplePloidy: false, autoComparison: false, unverified: true },
  defaultConfig: { ...DEFAULT_CONFIG },

  // fitScope is joint_series: CLOCCS is fit over a whole strain's timepoints via
  // fitSeries(), not per single sample. The per-sample fit(context) exists only
  // to satisfy the registry contract and fails loudly if the per-sample flow
  // ever routes here by mistake.
  fit() {
    throw new Error(
      "CLOCCS (Unverified) is a joint time-series model: it fits a whole strain's timepoints together, " +
        "not a single sample. Use the joint CLOCCS fit over the plotted samples.",
    );
  },

  fitSeries(series, config) {
    return fitCloccsForStrain(series, config);
  },

  // A joint result is already in its display shape; pass through unchanged.
  normalizeResult(result) {
    return result;
  },
};
