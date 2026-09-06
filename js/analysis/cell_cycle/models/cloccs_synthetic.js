// Synthetic data generator for the CLOCCS model (models/cloccs.js).
//
// It samples DNA-content events directly from the CLOCCS forward model at each
// timepoint: pick a cohort by its weight, draw a latent lifeline position from
// that cohort's truncated-normal distribution, map the position to expected DNA
// fluorescence, and add Gaussian measurement noise. Because the data is drawn
// from exactly the process CLOCCS assumes, fitting it back is a genuine
// round-trip test of the whole implementation (forward model + likelihood +
// optimiser), and is what unit_tests_cloccs.py uses to check parameter recovery.
//
// A seeded PRNG makes every generated dataset deterministic, so tests are stable;
// it and the probit both live in the shared math layer (stats.js,
// gaussian_bin_mass.js) because the resampling layer needs the same primitives.

import {
  enumerateCohorts,
  computeCohortWeights,
  cohortPositionParameters,
  expectedDnaFromPosition,
  histogramFromEdgesCounts,
} from "./cloccs.js";
import { makeRng } from "../../math/stats.js";
import { inverseStandardNormalCdf } from "../../math/gaussian_bin_mass.js";

// Standard-normal CDF via error function (kept local so the generator has no
// cross-dependency on the model's internals beyond the exported forward-model
// pieces it samples from).
function standardNormalCdf(z) {
  // Abramowitz & Stegun 7.1.26 erf approximation.
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  const cdf = 0.5 * (1 + (z >= 0 ? y : -y));
  return Math.min(1, Math.max(0, cdf));
}

/*
Purpose: draws one sample from a normal truncated to [lower, ∞) by inverse-CDF,
	so it is correct even when the (untruncated) mean lies well below the bound.
*/
export function sampleTruncatedNormalLower(rng, mean, sd, lower) {
  const s = Math.max(Math.abs(sd), 1e-9);
  const lowerCdf = lower === -Infinity ? 0 : standardNormalCdf((lower - mean) / s);
  const u = lowerCdf + rng() * (1 - lowerCdf);
  return mean + s * inverseStandardNormalCdf(Math.min(1 - 1e-12, Math.max(1e-12, u)));
}

// Picks a cohort index from cumulative weights by a uniform draw.
function sampleCohortIndex(rng, weights) {
  const u = rng();
  let cumulative = 0;
  for (let i = 0; i < weights.length; i += 1) {
    cumulative += weights[i].weight;
    if (u <= cumulative) return i;
  }
  return weights.length - 1;
}

/*
Purpose: generates `eventCount` synthetic DNA-content values at one timepoint by
	sampling cohort -> position -> expected DNA -> measurement noise.

Input:
	{ time, theta, sampleParameters, maxR, eventCount, rng }

Output:
	values [array]: the synthetic DNA-content event values
*/
export function generateCloccsEvents({ time, theta, sampleParameters, maxR, eventCount, rng }) {
  const weights = computeCohortWeights(time, theta, maxR);
  const cohortList = enumerateCohorts(maxR);
  const positionParams = cohortList.map((cohort) => cohortPositionParameters(cohort, time, theta));

  const values = new Array(eventCount);
  for (let i = 0; i < eventCount; i += 1) {
    const cohortIndex = sampleCohortIndex(rng, weights);
    const params = positionParams[cohortIndex];
    const position = sampleTruncatedNormalLower(rng, params.mean, params.sd, params.lowerBound);
    const expectedDna = expectedDnaFromPosition(position, theta, sampleParameters);
    // Gaussian measurement noise (Box-Muller).
    const u1 = Math.max(1e-12, rng());
    const u2 = rng();
    const gauss = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    values[i] = expectedDna + sampleParameters.tau * gauss;
  }
  return values;
}

// Bins values into a histogram over [min, max] with the given bin count.
function binValues(values, min, max, binCount) {
  const edges = new Array(binCount + 1);
  const width = (max - min) / binCount;
  for (let i = 0; i <= binCount; i += 1) edges[i] = min + i * width;
  const counts = new Array(binCount).fill(0);
  for (const value of values) {
    if (value < min || value >= max) continue;
    const bin = Math.min(binCount - 1, Math.floor((value - min) / width));
    counts[bin] += 1;
  }
  return { edges, counts };
}

/*
Purpose: builds a complete synthetic CLOCCS strain series ready for
	fitCloccsForStrain: one sample per timepoint, each with an event-value array,
	a histogram, and a fluorescenceInit seeded at the true fluorescence parameters
	(as an accurate DJF initialisation would produce).

Input:
	spec [object]: {
	  theta          -- true biological parameters
	  timepoints     -- array of times (minutes)
	  sampleParameters -- shared { alpha1, alpha2, tau } (or per-timepoint via
	                      sampleParametersAt(time))
	  maxR, eventCount, seed, binCount, dnaRange:[min,max]
	}

Output:
	series [object]: { strain, samples:[...], uniqueTimepoints, truth }
*/
export function generateCloccsSeries(spec) {
  const {
    theta,
    timepoints,
    sampleParameters,
    sampleParametersAt = null,
    maxR = 5,
    eventCount = 4000,
    seed = 12345,
    binCount = 128,
    dnaRange = null,
  } = spec;

  const rng = makeRng(seed);
  const paramsFor = (time) => (sampleParametersAt ? sampleParametersAt(time) : sampleParameters);

  // A default DNA axis wide enough to hold 1C..2C plus measurement spread.
  const anyParams = paramsFor(timepoints[0]);
  const defaultMax = (anyParams.alpha1 + anyParams.alpha2) * 1.6 + 6 * anyParams.tau;
  const [rangeMin, rangeMax] = dnaRange ?? [0, defaultMax];

  const samples = timepoints.map((time, index) => {
    const params = paramsFor(time);
    const values = generateCloccsEvents({ time, theta, sampleParameters: params, maxR, eventCount, rng });
    const { edges, counts } = binValues(values, rangeMin, rangeMax, binCount);
    return {
      sampleId: `t${index}`,
      timeMinutes: time,
      transformedDna: values,
      histogram: histogramFromEdgesCounts(edges, counts),
      fluorescenceInit: { alpha1: params.alpha1, alpha2: params.alpha2, tau: params.tau },
    };
  });

  return {
    strain: "synthetic",
    samples,
    uniqueTimepoints: [...new Set(timepoints)],
    truth: { theta, sampleParameters },
  };
}
