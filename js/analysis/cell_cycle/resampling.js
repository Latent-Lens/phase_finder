// UNC-01, second layer: resampling-based uncertainty.
//
// uncertainty.js reports what the OPTIMIZER knows -- the curvature of one
// deviance basin at one solution, on one histogram, under one set of peak
// regions. That is a real quantity and it is not the one a reader needs. It
// answers "how sharply is this optimum determined?" while the question behind a
// published percentage is "how much would this number have moved if the
// experiment, the gate, the bin grid, or the hand-drawn region had come out
// slightly differently?" The register states the gap directly: "not
// optimizer-only uncertainty".
//
// This module answers the second question by re-running the caller's own fit
// over perturbed inputs and reading the spread of the answers. Four sources of
// arbitrariness are perturbed, and each one is a choice a different competent
// analyst could plausibly have made differently:
//
//   events      resample the retained DNA events with replacement. This is the
//               ordinary nonparametric bootstrap, and because the model only
//               ever sees bin counts it is exact rather than approximate -- no
//               within-bin position is invented anywhere.
//   peak region jitter each region edge by a fraction of the region's own width.
//               For a model that obeys the region invariant (a region bounds the
//               mean and nothing else) this contributes almost nothing, and that
//               is a *result*, not a wasted perturbation: it is the invariant
//               being measured rather than asserted.
//   bin/domain  re-bin at a neighbouring supported bin count and at a bounded
//               domain trim, reusing domain_sensitivity.js's declared sweep so
//               UNC-01 and DOMAIN-01 cannot disagree about what "supported"
//               means.
//   QC          swap in an alternative retained-event set. QC gating happens
//               upstream of this layer, so the variants must be SUPPLIED; when
//               they are not, the bundle records that the QC perturbation was
//               skipped rather than quietly reporting an interval that excludes
//               it. An interval that hides which perturbations it omits is worse
//               than no interval.
//
// What this buys over the delta method, concretely: a percentile interval is
// transformation-respecting and cannot leave [0, 1], so the boundary-pinned and
// weak-S fits where the normal interval reports "-3% S phase" (and sets
// `clipped`) get an interval that is inside the simplex by construction. That is
// the "suited to bounded nonlinear parameters and phase fractions" the register
// asks for.
//
// What it does NOT buy:
//
//   * It is not free. One replicate costs one full fit per model. Dean-Jett-Fox
//     measures ~3.2 s per fit on a 300-bin histogram in node, so 200 replicates
//     across a 3-model comparison group is tens of minutes. Every entry point
//     here is cancellable and reports progress, and callers are expected to run
//     this deliberately (an export, a validation run, a reviewer's request), not
//     on every parameter tweak.
//   * It cannot repair a biased estimator. A bootstrap measures spread around
//     whatever the estimator converges to; if the fit is systematically off --
//     as MODEL-01/MODEL-02's peak offset makes it -- the interval will be
//     narrow, stable, and centred in the wrong place. Coverage against KNOWN
//     truth is the only thing that catches that, which is why the coverage study
//     recorded in the register is part of this item rather than optional extra.
//   * The bin/domain perturbation deliberately mixes distributions rather than
//     sampling one. The resulting interval covers "what would this number have
//     been under any of the supported bin grids", which is wider than, and a
//     different object from, a sampling interval at a fixed grid. The bundle's
//     `definition` string says so in words, because a reader who assumes the
//     narrow meaning will over-interpret the width.

import { generateHistogram } from "../pipeline/dna_histogram.js";
import { makeRng, quantileSorted, clamp, mean } from "../math/stats.js";
import { inverseStandardNormalCdf, normalCdf } from "../math/gaussian_bin_mass.js";
import { DEFAULT_SENSITIVITY_BIN_COUNTS, DEFAULT_DOMAIN_PERTURBATIONS } from "./domain_sensitivity.js";

// ---------------------------------------------------------------------------
// Declared defaults. Each is policy with a stated reason, in the same spirit as
// domain_sensitivity.js's thresholds: a reviewer should be able to disagree with
// a number rather than have to reverse-engineer an implicit one.
// ---------------------------------------------------------------------------

// 200 replicates. Percentile endpoints are order statistics, so the Monte Carlo
// error at the 2.5%/97.5% points falls off as 1/sqrt(B) and 200 puts roughly 5
// replicates outside each tail -- enough for a stable endpoint, few enough that
// a Dean-Jett-Fox bundle finishes in minutes rather than hours. Below ~40 the
// endpoints are being set by two or three individual replicates and the interval
// is noise; MINIMUM_USABLE_REPLICATES enforces that floor.
export const DEFAULT_REPLICATES = 200;
export const MINIMUM_USABLE_REPLICATES = 40;

// A fixed default seed, not Date.now(). Two runs of the same analysis on the
// same inputs must produce the same interval, or the number is not a
// measurement. The seed is published on the bundle so a different one is a
// deliberate, recorded choice.
export const DEFAULT_SEED = 20260819;

export const DEFAULT_INTERVAL_LEVEL = 0.95;

// Peak-region edge jitter, as a fraction of that region's width. 10% is about
// how far apart two analysts' hand-drawn regions land on the same peak; it is
// small enough that the region still contains the peak (so no fit is being
// perturbed into a different problem) and large enough that a model whose answer
// depends on the drag distance will show it.
export const DEFAULT_REGION_JITTER_FRACTION = 0.10;

// Bin counts are drawn from domain_sensitivity.js's supported ladder, restricted
// to entries within a factor of 2 of the baseline. Sampling the whole ladder
// would treat a 4x re-bin as equally plausible as the grid the analyst chose,
// which overstates the arbitrariness; one step in either direction is the honest
// amount of "this could have been set differently".
export const BIN_COUNT_NEIGHBOURHOOD_FACTOR = 2;

// Selection is called unstable when the winning model takes less than 80% of the
// replicates. At 200 replicates the standard error on a frequency near 0.8 is
// ~2.8pp, so the threshold is comfortably outside Monte Carlo noise. The number
// is a reporting policy, not an inference: a 79%/21% split is a genuinely
// ambiguous comparison and should be reported as one.
export const SELECTION_STABILITY_THRESHOLD = 0.8;

// Replicate failures. A few percent is normal -- some perturbed histograms are
// genuinely harder and the optimizer stops short. Past 20% the surviving
// replicates are a biased subsample (the easy ones), and the interval is
// measuring the easy cases, not the sample.
export const FAILURE_RATE_WARNING = 0.05;
export const FAILURE_RATE_CRITICAL = 0.20;

// Keeps the bundle small enough to structured-clone out of the fit worker while
// still showing a reader what went wrong.
const MAX_RECORDED_FAILURES = 20;

export const INTERVAL_METHOD = Object.freeze({
  PERCENTILE: "percentile",
  BIAS_CORRECTED: "bias_corrected_percentile",
});

export const RESAMPLE_METHOD = Object.freeze({
  EVENT_BOOTSTRAP: "nonparametric_event_bootstrap",
  POISSON_COUNTS: "poisson_count_bootstrap",
});

/*

Purpose:
	Draws a nonparametric bootstrap sample of the retained DNA events: n draws
	with replacement from n events. Because every downstream consumer sees only
	binned counts, this is the exact event bootstrap rather than an
	approximation to it -- nothing about within-bin position is reconstructed.

Input:
	values [array|TypedArray]: the retained DNA values
	rng [function]: () -> uniform in [0, 1)

Output:
	resampled [array]: a new array of the same length

*/
export function resampleEvents(values, rng) {
  const n = values?.length ?? 0;
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) {
    // rng() is in [0, 1) but the clamp costs nothing and makes an
    // out-of-contract generator a wrong number rather than an undefined read.
    out[i] = values[Math.min(n - 1, Math.floor(rng() * n))];
  }
  return out;
}

/*

Purpose:
	Parametric bootstrap of a histogram in count space: each bin is redrawn from
	Poisson(observed count), independently. This is the fallback for a caller
	that holds a histogram but not the events behind it.

	It is a DIFFERENT object from the event bootstrap above and the bundle labels
	it as such. The event bootstrap conditions on the total N; the Poisson one
	does not, so it also carries the sampling variability of how many events were
	collected. That happens to be the variability the fit's own Poisson deviance
	objective assumes, which is why it is coherent rather than merely convenient
	-- but it cannot express any perturbation that requires re-binning, so a
	caller on this path gets a narrower set of perturbations and is told so.

	Sampling is by exponential inter-arrivals (the log-space form of Knuth's
	method), which is exact and, unlike exp(-lambda), does not underflow for the
	lambda ~ 1e3 that a peak bin reaches. Cost is O(lambda) per bin, hence O(N)
	over the histogram -- the same order as drawing N events.

Input:
	counts [array]: observed per-bin counts
	rng [function]: () -> uniform in [0, 1)

Output:
	resampled [array]: new per-bin counts

*/
export function poissonResampleCounts(counts, rng) {
  return Array.from(counts ?? [], (lambda) => {
    if (!Number.isFinite(lambda) || lambda <= 0) return 0;
    let k = 0;
    let accumulated = 0;
    // A bin cannot plausibly draw more than lambda + 10*sqrt(lambda) + 20
    // events; the cap only exists so a malformed rng cannot spin forever.
    const cap = Math.ceil(lambda + 10 * Math.sqrt(lambda) + 20);
    while (k <= cap) {
      const u = rng();
      accumulated -= Math.log(u > 0 ? u : Number.EPSILON);
      if (accumulated > lambda) return k;
      k += 1;
    }
    return k;
  });
}

/*

Purpose:
	Jitters each peak region's edges by a fraction of that region's own width,
	preserving the ordering the models require (left < right within a region, and
	G1 entirely left of G2/M). Scaling the jitter to the region's width rather
	than to an absolute channel count keeps the perturbation meaningful across
	instruments and scales.

	The ordering repair is a clamp rather than a rejection: a rejected draw would
	silently correlate the perturbation with the region geometry, so a
	narrow-gap sample would get a systematically different perturbation than a
	wide-gap one.

Input:
	peakRegions [object]: { g1: { left, right, ... }, g2: { left, right, ... } }
	rng [function]: () -> uniform in [0, 1)
	options [object]: { jitterFraction: fraction of region width, uniform +/- }

Output:
	perturbed [object]: a new regions object with the same extra keys preserved

*/
export function perturbPeakRegions(peakRegions, rng, { jitterFraction = DEFAULT_REGION_JITTER_FRACTION } = {}) {
  if (!peakRegions || !(jitterFraction > 0)) return peakRegions;
  const shift = (region) => {
    const left = Number(region?.left);
    const right = Number(region?.right);
    if (!Number.isFinite(left) || !Number.isFinite(right) || !(right > left)) return { ...region };
    const amplitude = (right - left) * jitterFraction;
    const nextLeft = left + amplitude * (2 * rng() - 1);
    const nextRight = right + amplitude * (2 * rng() - 1);
    // A degenerate draw (both edges crossing) collapses to the original width
    // around the perturbed centre rather than inverting the region.
    if (!(nextRight > nextLeft)) {
      const centre = 0.5 * (nextLeft + nextRight);
      return { ...region, left: centre - 0.5 * (right - left), right: centre + 0.5 * (right - left) };
    }
    return { ...region, left: nextLeft, right: nextRight };
  };
  const g1 = shift(peakRegions.g1);
  const g2 = shift(peakRegions.g2);
  if (Number.isFinite(g1.right) && Number.isFinite(g2.left) && g1.right >= g2.left) {
    const midpoint = 0.5 * (g1.right + g2.left);
    // Split the overlap evenly and leave a hair of separation, so
    // validatePeakRegions' strict ordering test passes.
    const separation = Math.max(1e-9, 1e-6 * Math.abs(midpoint));
    g1.right = midpoint - separation;
    g2.left = midpoint + separation;
    // Pulling the inner edges apart can drag one past its own outer edge when
    // the regions started close together and the jitter is large. Restoring the
    // ORIGINAL width from the repaired inner edge keeps every region a real
    // interval; using the perturbed width instead would let a draw that had
    // already collapsed stay collapsed.
    const width = (region) => Math.abs(Number(region?.right) - Number(region?.left)) || 0;
    if (!(g1.left < g1.right)) g1.left = g1.right - width(peakRegions.g1);
    if (!(g2.right > g2.left)) g2.right = g2.left + width(peakRegions.g2);
  }
  return { ...peakRegions, g1, g2 };
}

/*

Purpose:
	Percentile bootstrap interval, optionally bias-corrected.

	The plain percentile interval is [q(alpha/2), q(1 - alpha/2)] of the replicate
	values. Its virtue here is that it is equivariant under any monotone
	reparameterization and therefore cannot leave the range the quantity lives in
	-- a phase fraction's interval is inside [0, 1] because every replicate's
	fraction is, with no clipping step and no `clipped` flag to qualify it.

	The bias correction (Efron's BC) addresses the one systematic way the plain
	interval is wrong: if the bootstrap distribution is not centred on the point
	estimate -- the median of the replicates sits at, say, the 60th percentile
	rather than the 50th -- the plain interval inherits that shift. BC measures
	the offset as z0 = probit(fraction of replicates below the point estimate) and
	moves both endpoints by it. It needs no jackknife, so it costs one comparison
	per replicate.

	It is BC and not BCa: the acceleration term would need a leave-one-out
	jackknife over the events, i.e. n more fits, which is not affordable at ~3 s
	per fit. The omission matters when the estimator's variance changes fast with
	its own value; the coverage study in the register is what says whether it
	does here.

	A saturated z0 (every replicate on one side of the point estimate) makes the
	corrected endpoints degenerate, so that case falls back to the plain interval
	and says so via `biasCorrectionApplied`.

Input:
	samples [array]: replicate values (unsorted is fine)
	options [object]: {
	  level [number]: coverage, default 0.95
	  pointEstimate [number|null]: needed for the bias correction
	  method [string]: INTERVAL_METHOD.* }

Output:
	interval [object]: { value, lower, upper, median, standardError, replicates,
	                     method, biasCorrectionApplied, z0 }

*/
export function percentileInterval(samples, {
  level = DEFAULT_INTERVAL_LEVEL,
  pointEstimate = null,
  method = INTERVAL_METHOD.BIAS_CORRECTED,
} = {}) {
  const finite = (samples ?? []).filter((value) => Number.isFinite(value));
  const empty = {
    value: pointEstimate, lower: NaN, upper: NaN, median: NaN, standardError: NaN,
    replicates: finite.length, method, biasCorrectionApplied: false, z0: NaN,
  };
  if (finite.length < 2) return empty;

  const sorted = [...finite].sort((a, b) => a - b);
  const centre = mean(sorted);
  const spread = Math.sqrt(sorted.reduce((sum, v) => sum + (v - centre) ** 2, 0) / (sorted.length - 1));
  const alpha = clamp(1 - level, 1e-6, 0.5);

  let lowerProbability = alpha / 2;
  let upperProbability = 1 - alpha / 2;
  let z0 = 0;
  let biasCorrectionApplied = false;
  if (method === INTERVAL_METHOD.BIAS_CORRECTED && Number.isFinite(pointEstimate)) {
    const below = sorted.filter((value) => value < pointEstimate).length;
    const proportion = below / sorted.length;
    if (proportion > 0 && proportion < 1) {
      z0 = inverseStandardNormalCdf(proportion);
      const zLow = inverseStandardNormalCdf(alpha / 2);
      const zHigh = inverseStandardNormalCdf(1 - alpha / 2);
      lowerProbability = normalCdf(2 * z0 + zLow);
      upperProbability = normalCdf(2 * z0 + zHigh);
      biasCorrectionApplied = true;
    }
  }

  return {
    value: Number.isFinite(pointEstimate) ? pointEstimate : quantileSorted(sorted, 0.5),
    lower: quantileSorted(sorted, lowerProbability),
    upper: quantileSorted(sorted, upperProbability),
    median: quantileSorted(sorted, 0.5),
    standardError: spread,
    replicates: sorted.length,
    method,
    biasCorrectionApplied,
    z0,
  };
}

// Bin counts within one ladder step of the baseline -- see
// BIN_COUNT_NEIGHBOURHOOD_FACTOR.
function binCountNeighbourhood(baselineBinCount, ladder) {
  const supported = [...new Set([...ladder, baselineBinCount])]
    .filter((count) => Number.isInteger(count) && count > 1)
    .sort((a, b) => a - b);
  const near = supported.filter((count) =>
    count <= baselineBinCount * BIN_COUNT_NEIGHBOURHOOD_FACTOR
    && count * BIN_COUNT_NEIGHBOURHOOD_FACTOR >= baselineBinCount);
  return near.length ? near : [baselineBinCount];
}

function pick(list, rng) {
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
}

function fractionsUsable(fractions) {
  if (!fractions) return false;
  return ["g1", "s", "g2"].every((key) => Number.isFinite(fractions[key]));
}

// Outcomes that may be BIC-ranked against each other: converged, with a finite
// BIC, and carrying a non-null comparisonGroup. A null group is the contract a
// decomposition model declares (watson_pragmatic: "never AIC/BIC-ranked against
// DJ/DJF"), and dropping those entries here is where that rule is enforced
// rather than merely declared.
//
// Ranking across two DIFFERENT non-null groups would be just as wrong, and
// picking whichever group happened to come first in the array would hide it, so
// a mixed set returns null and the caller reports selection as unavailable.
function rankableOutcomes(outcomes) {
  const eligible = (outcomes ?? []).filter((outcome) =>
    outcome?.comparisonGroup && outcome.converged !== false && Number.isFinite(outcome.bic));
  const groups = [...new Set(eligible.map((outcome) => outcome.comparisonGroup))];
  if (groups.length !== 1) return { group: null, contenders: [], ambiguous: groups.length > 1, groups };
  return { group: groups[0], contenders: eligible, ambiguous: false, groups };
}

/*

Purpose:
	Runs the resampling layer: refits the caller's models over `replicates`
	perturbed copies of one sample and reports percentile intervals, model-
	selection frequency, and the full provenance the register requires (method,
	seed, replicate counts, failures, and a plain-English definition of what the
	interval covers).

	Model-agnostic by construction. It never imports the registry and never reads
	a model's equations; the caller supplies a fitFn and this module only compares
	what comes back. Ranking is restricted to a single non-null comparisonGroup,
	which is where plan section 5.5's rule ("never AIC/BIC-rank a decomposition
	against a generative model") is actually enforced rather than merely declared
	on the model entries.

	Cancellation is checked between replicates and reported on the bundle. A
	cancelled run still returns whatever it completed: a 60-replicate interval
	labelled as such is more useful to a reader than nothing, and
	MINIMUM_USABLE_REPLICATES is what decides whether it may be reported.

Input:
	spec [object]: {
	  fitFn [function]: ({ histogram, peakRegions, replicate, label }) -> array of
	    { modelId, comparisonGroup, phaseFractions: {g1,s,g2}, bic, converged,
	      parameters } -- one entry per model,
	  peakRegions [object]: the baseline regions,
	  values [array|null]: the retained DNA events; enables the event bootstrap
	    and every re-binning perturbation,
	  histogram [object|null]: the baseline histogram; required when values is
	    absent, in which case the Poisson count bootstrap is used instead,
	  domain [object|null]: { min, max } for re-binning; defaults to the
	    baseline histogram's own range,
	  binCount [number|null]: baseline bin count; defaults to the histogram's,
	  replicates, seed, intervalLevel, intervalMethod,
	  perturbations [object]: { events, peakRegionJitter, binning, domain,
	    qcVariants } -- see the module header,
	  shouldCancel [function], onProgress [function] }

Output:
	bundle [object]: { method, intervalMethod, intervalLevel, definition, seed,
	                   replicatesRequested/Succeeded/Failed, failures, cancelled,
	                   perturbations, models, selection, warnings }

*/
export function resampleUncertainty({
  fitFn,
  peakRegions,
  values = null,
  histogram = null,
  domain = null,
  binCount = null,
  replicates = DEFAULT_REPLICATES,
  seed = DEFAULT_SEED,
  intervalLevel = DEFAULT_INTERVAL_LEVEL,
  intervalMethod = INTERVAL_METHOD.BIAS_CORRECTED,
  perturbations = {},
  shouldCancel = null,
  onProgress = null,
} = {}) {
  if (typeof fitFn !== "function") throw new TypeError("resampleUncertainty requires a fitFn.");
  const haveEvents = Array.isArray(values) ? values.length > 0 : (values?.length ?? 0) > 0;
  if (!haveEvents && !histogram) {
    throw new TypeError("resampleUncertainty requires either the retained events (values) or a baseline histogram.");
  }
  const requested = {
    events: perturbations.events ?? true,
    peakRegionJitter: perturbations.peakRegionJitter ?? DEFAULT_REGION_JITTER_FRACTION,
    binning: perturbations.binning ?? true,
    domain: perturbations.domain ?? true,
    qcVariants: perturbations.qcVariants ?? null,
  };

  // Every perturbation that was asked for but cannot run is recorded with its
  // reason. A consumer that reads only the interval width must still be able to
  // find out that, say, QC was never varied.
  const skipped = [];
  const applied = {
    events: requested.events
      ? (haveEvents ? RESAMPLE_METHOD.EVENT_BOOTSTRAP : RESAMPLE_METHOD.POISSON_COUNTS)
      : null,
    peakRegionJitter: requested.peakRegionJitter > 0 && peakRegions ? requested.peakRegionJitter : null,
    binning: false,
    domain: false,
    qcVariants: 0,
  };
  if (requested.events && !haveEvents) {
    skipped.push({
      name: "event_bootstrap",
      reason: "the retained events were not supplied, so replicates were drawn from the per-bin Poisson "
        + "distribution instead; the interval carries count noise but not the event-resampling variability.",
    });
  }
  if (requested.peakRegionJitter > 0 && !peakRegions) {
    skipped.push({ name: "peak_region", reason: "no peak regions were supplied." });
  }
  if ((requested.binning || requested.domain) && !haveEvents) {
    skipped.push({
      name: "bin_domain",
      reason: "re-binning needs the retained events, which were not supplied; the reported interval is "
        + "conditional on this exact bin grid and domain.",
    });
  }

  const qcVariants = Array.isArray(requested.qcVariants) ? requested.qcVariants.filter((v) => v?.values?.length) : [];
  if (!qcVariants.length) {
    skipped.push({
      name: "qc",
      reason: "no alternative QC-gated event sets were supplied; QC gating happens upstream of this layer and "
        + "cannot be perturbed from here, so the interval is conditional on the QC configuration that was used.",
    });
  } else {
    applied.qcVariants = qcVariants.length;
  }

  // Baseline geometry for re-binning. When events are present the caller's
  // histogram is only used for its grid, which is why it stays optional.
  const baselineBinCount = binCount ?? histogram?.binCount
    ?? (Array.isArray(histogram?.counts) ? histogram.counts.length : null);
  const baselineMin = Number(domain?.min ?? histogram?.min);
  const baselineMax = Number(domain?.max ?? histogram?.max);
  const canRebin = haveEvents
    && Number.isInteger(baselineBinCount) && baselineBinCount > 1
    && Number.isFinite(baselineMin) && Number.isFinite(baselineMax) && baselineMax > baselineMin;
  const ladder = canRebin ? binCountNeighbourhood(baselineBinCount, DEFAULT_SENSITIVITY_BIN_COUNTS) : [];
  applied.binning = canRebin && requested.binning && ladder.length > 1 ? ladder : false;
  applied.domain = canRebin && requested.domain ? DEFAULT_DOMAIN_PERTURBATIONS.length : false;
  if (haveEvents && !canRebin) {
    // Refused rather than worked around. The alternative -- letting
    // generateHistogram resolve the range from each bootstrap sample -- would
    // move the analysis domain between replicates, and DOMAIN-01 is explicit
    // that the domain is a scientific input rather than a display convenience.
    // Every replicate would also throw one at a time, so a run that costs
    // seconds per fit would spend its whole budget before saying anything.
    throw new TypeError(
      "resampleUncertainty needs a bin count and an analysis domain to bin the resampled events onto. "
      + "Supply domain as { min, max } and binCount, or a baseline histogram carrying min/max/binCount.",
    );
  }

  const baselineHistogram = histogram ?? (canRebin
    ? generateHistogram(values, null, { binCount: baselineBinCount, range: [baselineMin, baselineMax] })
    : null);

  const buildVariant = (rng, replicate) => {
    if (!haveEvents) {
      const counts = poissonResampleCounts(baselineHistogram.counts ?? baselineHistogram.y, rng);
      return {
        histogram: { ...baselineHistogram, counts, y: counts },
        peakRegions: applied.peakRegionJitter
          ? perturbPeakRegions(peakRegions, rng, { jitterFraction: applied.peakRegionJitter })
          : peakRegions,
        replicate,
      };
    }
    // QC first (it decides which events exist), then the event bootstrap of
    // that set, then the grid those events are binned onto. Any other order
    // would bootstrap events that the chosen QC variant had removed.
    const source = qcVariants.length ? pick(qcVariants, rng) : null;
    const pool = source ? source.values : values;
    const drawn = requested.events ? resampleEvents(pool, rng) : pool;
    let variantBinCount = baselineBinCount;
    let variantMin = baselineMin;
    let variantMax = baselineMax;
    if (applied.binning) variantBinCount = pick(applied.binning, rng);
    if (applied.domain) {
      const trim = pick(DEFAULT_DOMAIN_PERTURBATIONS, rng);
      const width = baselineMax - baselineMin;
      variantMin = baselineMin + width * (trim.left ?? 0);
      variantMax = baselineMax - width * (trim.right ?? 0);
    }
    return {
      histogram: generateHistogram(drawn, null, { binCount: variantBinCount, range: [variantMin, variantMax] }),
      peakRegions: applied.peakRegionJitter
        ? perturbPeakRegions(peakRegions, rng, { jitterFraction: applied.peakRegionJitter })
        : peakRegions,
      replicate,
      qcVariant: source?.label ?? null,
      binCount: variantBinCount,
    };
  };

  // The unperturbed fit supplies the point estimates the intervals are centred
  // on and the selection winner the frequencies are compared against.
  const baselineOutcomes = fitFn({
    histogram: baselineHistogram, peakRegions, replicate: -1, label: "baseline",
  }) ?? [];

  const rng = makeRng(seed);
  const samples = new Map();      // modelId -> { fractions: {g1:[],s:[],g2:[]}, parameters: Map, converged, attempted }
  const selectionTally = new Map();
  const failures = [];
  let failureCount = 0;
  let succeeded = 0;
  let selectionReplicates = 0;
  let selectionAmbiguous = false;
  let cancelled = false;

  const ensure = (modelId) => {
    if (!samples.has(modelId)) {
      samples.set(modelId, {
        fractions: { g1: [], s: [], g2: [] },
        parameters: new Map(),
        converged: 0,
        attempted: 0,
      });
    }
    return samples.get(modelId);
  };

  for (let replicate = 0; replicate < replicates; replicate += 1) {
    if (typeof shouldCancel === "function" && shouldCancel()) { cancelled = true; break; }
    let outcomes = null;
    try {
      outcomes = fitFn(buildVariant(rng, replicate)) ?? [];
    } catch (thrown) {
      failureCount += 1;
      if (failures.length < MAX_RECORDED_FAILURES) {
        failures.push({ replicate, modelId: null, reason: thrown?.message ?? String(thrown) });
      }
      continue;
    }
    succeeded += 1;

    let usableInReplicate = 0;
    for (const outcome of outcomes) {
      if (!outcome?.modelId) continue;
      const bucket = ensure(outcome.modelId);
      bucket.attempted += 1;
      if (outcome.converged === false || !fractionsUsable(outcome.phaseFractions)) {
        if (failures.length < MAX_RECORDED_FAILURES) {
          failures.push({
            replicate,
            modelId: outcome.modelId,
            reason: outcome.converged === false ? "did not converge" : "phase fractions were not finite",
          });
        }
        continue;
      }
      bucket.converged += 1;
      usableInReplicate += 1;
      for (const phase of ["g1", "s", "g2"]) bucket.fractions[phase].push(outcome.phaseFractions[phase]);
      for (const [name, value] of Object.entries(outcome.parameters ?? {})) {
        if (!Number.isFinite(value)) continue;
        if (!bucket.parameters.has(name)) bucket.parameters.set(name, []);
        bucket.parameters.get(name).push(value);
      }
    }
    if (!usableInReplicate) failureCount += 1;

    // Model selection: lowest BIC inside one non-null comparison group.
    const { group, contenders, ambiguous } = rankableOutcomes(outcomes);
    if (ambiguous) selectionAmbiguous = true;
    if (group && contenders.length) {
      const winner = contenders.reduce((best, outcome) => (outcome.bic < best.bic ? outcome : best));
      selectionTally.set(winner.modelId, (selectionTally.get(winner.modelId) ?? 0) + 1);
      selectionReplicates += 1;
    }

    if (typeof onProgress === "function") {
      onProgress({ completed: replicate + 1, total: replicates, succeeded, failed: failureCount });
    }
  }

  // ------------------------------------------------------------------ output
  const baselineById = new Map((baselineOutcomes ?? []).map((outcome) => [outcome?.modelId, outcome]));
  const models = {};
  for (const [modelId, bucket] of samples) {
    const point = baselineById.get(modelId);
    const intervalFor = (sampleValues, pointValue) => percentileInterval(sampleValues, {
      level: intervalLevel, pointEstimate: pointValue, method: intervalMethod,
    });
    const parameterIntervals = {};
    for (const [name, list] of bucket.parameters) {
      parameterIntervals[name] = intervalFor(list, point?.parameters?.[name] ?? null);
    }
    models[modelId] = {
      pointEstimate: point ? { phaseFractions: point.phaseFractions ?? null, bic: point.bic ?? null } : null,
      phaseFractions: {
        g1: intervalFor(bucket.fractions.g1, point?.phaseFractions?.g1 ?? null),
        s: intervalFor(bucket.fractions.s, point?.phaseFractions?.s ?? null),
        g2: intervalFor(bucket.fractions.g2, point?.phaseFractions?.g2 ?? null),
      },
      parameters: parameterIntervals,
      replicatesUsed: bucket.converged,
      replicatesAttempted: bucket.attempted,
      convergenceRate: bucket.attempted ? bucket.converged / bucket.attempted : NaN,
    };
  }

  const {
    group: baselineGroup, contenders: baselineContenders, ambiguous: baselineAmbiguous, groups: baselineGroups,
  } = rankableOutcomes(baselineOutcomes);
  if (baselineAmbiguous) selectionAmbiguous = true;
  const pointEstimateWinner = baselineContenders.length
    ? baselineContenders.reduce((best, outcome) => (outcome.bic < best.bic ? outcome : best)).modelId
    : null;
  const frequency = {};
  for (const [modelId, count] of selectionTally) frequency[modelId] = count / Math.max(1, selectionReplicates);
  const winnerFrequency = pointEstimateWinner ? (frequency[pointEstimateWinner] ?? 0) : NaN;

  const bundle = {
    method: applied.events ?? "none",
    intervalMethod,
    intervalLevel,
    definition: buildDefinition(applied, skipped, intervalLevel, intervalMethod),
    seed,
    replicatesRequested: replicates,
    replicatesSucceeded: succeeded,
    replicatesFailed: failureCount,
    failures,
    cancelled,
    perturbations: { requested, applied, skipped },
    models,
    selection: {
      comparisonGroup: baselineGroup,
      ambiguousGroups: selectionAmbiguous ? baselineGroups : null,
      pointEstimateWinner,
      frequency,
      winnerFrequency,
      replicates: selectionReplicates,
      instability: Number.isFinite(winnerFrequency) ? 1 - winnerFrequency : NaN,
      stable: Number.isFinite(winnerFrequency) && winnerFrequency >= SELECTION_STABILITY_THRESHOLD,
    },
    warnings: [],
  };
  bundle.warnings = resamplingWarnings(bundle);
  return bundle;
}

// The sentence a reader needs in order to know what the number means. Built from
// what actually ran, not from what was configured, so it cannot claim a
// perturbation the run skipped.
function buildDefinition(applied, skipped, level, intervalMethod) {
  const sources = [];
  if (applied.events === RESAMPLE_METHOD.EVENT_BOOTSTRAP) sources.push("resampling the retained events with replacement");
  if (applied.events === RESAMPLE_METHOD.POISSON_COUNTS) sources.push("redrawing each bin from Poisson(observed count)");
  if (applied.peakRegionJitter) sources.push(`jittering each peak-region edge by up to ${(100 * applied.peakRegionJitter).toFixed(0)}% of the region's width`);
  if (applied.binning) sources.push(`re-binning at ${applied.binning.join("/")} bins`);
  if (applied.domain) sources.push("applying the supported bounded domain trims");
  if (applied.qcVariants) sources.push(`drawing among ${applied.qcVariants} alternative QC-gated event sets`);
  const name = intervalMethod === INTERVAL_METHOD.BIAS_CORRECTED
    ? "bias-corrected percentile" : "percentile";
  const covered = sources.length ? sources.join(", ") : "no perturbation (the run applied none)";
  const omitted = skipped.length ? ` It does NOT include: ${skipped.map((entry) => entry.name).join(", ")}.` : "";
  return `A ${(100 * level).toFixed(0)}% ${name} interval over replicate refits, where each replicate differs `
    + `from the reported fit by ${covered}. It describes how far the value would move under those choices, `
    + `not how accurate it is: a systematically biased fit produces a narrow interval in the wrong place.${omitted}`;
}

/*

Purpose:
	Turns a resampling bundle into the same warning vocabulary
	identifiabilityWarnings() emits ({ id, severity, nonreportable, message }), so
	a consumer -- GATE-01's contract in particular -- reads one list and does not
	need to learn a second shape. Ids are shared with the asymptotic layer
	wherever the meaning is the same (`fraction_too_uncertain`), and new only
	where the condition genuinely does not exist there.

Input:
	bundle [object]: a resampleUncertainty() result
	options [object]: { fractionUncertaintyThreshold: half-width in fraction
	                    units above which a phase fraction is unreportable }

Output:
	warnings [array]: { id, severity, nonreportable, message }

*/
export function resamplingWarnings(bundle, { fractionUncertaintyThreshold = 0.1 } = {}) {
  const warnings = [];
  if (!bundle) return warnings;

  const usable = bundle.replicatesSucceeded ?? 0;
  if (usable < MINIMUM_USABLE_REPLICATES) {
    warnings.push({
      id: "resample_insufficient_replicates",
      severity: "critical",
      nonreportable: true,
      message: `Only ${usable} of ${bundle.replicatesRequested} replicates completed`
        + `${bundle.cancelled ? " (the run was cancelled)" : ""}, below the ${MINIMUM_USABLE_REPLICATES} needed for `
        + "a percentile endpoint that is not set by two or three individual replicates.",
    });
  }

  const attempted = (bundle.replicatesSucceeded ?? 0) + (bundle.replicatesFailed ?? 0);
  const failureRate = attempted > 0 ? (bundle.replicatesFailed ?? 0) / attempted : 0;
  if (failureRate >= FAILURE_RATE_WARNING) {
    const critical = failureRate >= FAILURE_RATE_CRITICAL;
    warnings.push({
      id: "resample_failure_rate",
      severity: critical ? "critical" : "warning",
      nonreportable: critical,
      message: `${(100 * failureRate).toFixed(0)}% of replicates failed to produce a usable fit. `
        + (critical
          ? "The replicates that survived are the ones the optimizer found easy, so the interval describes those, not the sample."
          : "The interval is computed from the replicates that succeeded, which biases it slightly toward the easier perturbations."),
    });
  }

  if (bundle.perturbations?.skipped?.length) {
    warnings.push({
      id: "perturbations_incomplete",
      severity: "warning",
      nonreportable: false,
      message: "The interval omits " + bundle.perturbations.skipped.map((entry) => entry.name).join(", ")
        + ", so it understates how much the answer depends on choices made outside the fit. "
        + bundle.perturbations.skipped.map((entry) => `${entry.name}: ${entry.reason}`).join(" "),
    });
  }

  const selection = bundle.selection;
  if (selection?.ambiguousGroups?.length) {
    warnings.push({
      id: "selection_group_ambiguous",
      severity: "warning",
      nonreportable: false,
      message: `The models supplied span more than one comparison group (${selection.ambiguousGroups.join(", ")}), `
        + "so no BIC ranking was performed. A BIC comparison is only meaningful between models fit to the same data "
        + "under the same likelihood.",
    });
  }
  if (selection?.comparisonGroup && Number.isFinite(selection.winnerFrequency) && !selection.stable) {
    const runnersUp = Object.entries(selection.frequency ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([modelId, share]) => `${modelId} ${(100 * share).toFixed(0)}%`)
      .join(", ");
    warnings.push({
      id: "model_selection_unstable",
      severity: "warning",
      nonreportable: false,
      message: `Automatic model selection picked ${selection.pointEstimateWinner} on the reported fit, but only `
        + `${(100 * selection.winnerFrequency).toFixed(0)}% of replicates agree (${runnersUp}). The model choice is `
        + "partly an artifact of this particular sample and binning, so it should be stated as a choice rather than a finding.",
    });
  }

  for (const [modelId, entry] of Object.entries(bundle.models ?? {})) {
    for (const [phase, interval] of Object.entries(entry.phaseFractions ?? {})) {
      if (!Number.isFinite(interval.lower) || !Number.isFinite(interval.upper)) {
        warnings.push({
          id: "fraction_interval_undefined",
          severity: "critical",
          nonreportable: true,
          message: `No resampling interval could be computed for the ${phase.toUpperCase()} fraction of ${modelId}.`,
        });
        continue;
      }
      const halfWidth = 0.5 * (interval.upper - interval.lower);
      if (halfWidth > fractionUncertaintyThreshold) {
        warnings.push({
          id: "fraction_too_uncertain",
          severity: "critical",
          nonreportable: true,
          message: `${modelId}: the ${phase.toUpperCase()} fraction spans `
            + `${(100 * interval.lower).toFixed(1)}%-${(100 * interval.upper).toFixed(1)}% across replicates `
            + `(+/-${(100 * halfWidth).toFixed(1)} pp, past the ${(100 * fractionUncertaintyThreshold).toFixed(0)} pp `
            + "reportability limit).",
        });
      }
    }
  }

  return warnings;
}
