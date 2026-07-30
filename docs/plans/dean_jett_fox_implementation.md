<style>
body {
  font-size: 16px;
  line-height: 1.6;
}

/* Normal math outside tables */
mjx-container,
.katex {
  font-size: 125%;
}

/* Math inside tables */
table mjx-container,
table .katex {
  font-size: 100%;
}

/* Optional: table text size */
table {
  font-size: 16px;
}
</style>



## Dean-Jett-Fox (DJF) JavaScript Implementation 

$$
\hat{y}(x_j) = B(x_j) + D(x_j) + A(x_j) + \sum_{k=1}^{K} \left[ G_{1,k}(x_j) + S_k(x_j) + G_{2,k}(x_j) \right]
$$


| Term | Meaning |
|---|---|
| $B(x)$ | General background |
| $D(x)$ | Debris component |
| $A(x)$ | Aggregate or multiplet component |
| $K$ | Number of independently cycling populations |
| $G_{1,k}(x)$ | Lower-DNA Gaussian peak for population k |
| $S_k(x)$ | S-phase model, often DJF-like |
| $G_{2,k}(x)$ | Upper-DNA Gaussian peak for population k |


<h3> Simplifications </h3>
An initial simplification we will be taken is to treat the number of independently cycling populations as one. This can be expanded in the future, but this simpliciation should hold true for our initial testing.
<br /><br />

This simplifies the DJF formula to:

$$
\hat{y}(x_j) = B(x_j) + D(x_j) + A(x_j) +  G_{1}(x_j) + S(x_j) + G_{2}(x_j)
$$

<br /><br />

### Cleaning options
As part of this initial implementation, the "cleaning" will be optional, meaning the user can check a box and we will the code will run to handle that specific cleaning process. 


#### General background removal


#### Debris removal


#### Aggregate or multiplet removal


$$
G_{1,k}(x) =
a_{1,k}
\exp\left[
-\frac{(x-\mu_{1,k})^2}{2\sigma_{1,k}^2}
\right]
$$

$$
G_{2,k}(x) =
a_{2,k}
\exp\left[
-\frac{(x-\mu_{2,k})^2}{2\sigma_{2,k}^2}
\right]
$$

with a DNA-content constraint such as:

$$
\mu_{2,k} \approx 2\mu_{1,k}
$$




## Order of implementation
"Stages are from **Claude** research report
<br />"Steps" are from ***ChatGPT*** report
  
### Stage 0 | Step 1 and 2: Load FCS files and remove invalid / boundary / maxed-out events
Remove events that are unusable because they are non-finite, clipped against acquisition boundaries, or saturated at instrument limits.

<u>Checklist</u>
- [x] Load FCS files
  - [ ] Extract metadata from FCS:
      - $DATATYPE:	Type of data in DATA segment (ASCII, integer, floating point).
      - PnB: Number of bits reserved for parameter number n.
      - PnR: Maximum value for that data value.
      - $PnE:	Amplification type for parameter n.
      - $PnN:	Short name for parameter n.
      - $PnS:	Optional descriptive stain/display name.
      <br />
- [ ] User select DNA channel column **DNA_A**
  - [ ] Automaticaly identify helper columns:
      - DNA_H
      - DNA_W
      - FSC_A
      - SSC_A
      - Time (HDR-T)
    <br />
  - [ ] Filter our any events outside of acceptable range and create mask
        We want to filter out any values that are not finite, or are outside the accceptable range for that variable. We will add the event index to the mask, so even if the value for another variable is OK we will still remove it because it the event value was off for one of our other columns.
      <br />
      **Non-time-based** variables:
      <u>Discard</u>
      * NaN, Infinity, -Infinity 
      * < 0 
      * === 0 → discard as lower-margin event
      * === 1000 → discard as upper-margin/saturated event
      * \> 1000
      
      <u>Keep</u>
      * 0 < value < 1000
      <br />

      We will have a separate step for time-based acquisition QC, so for now ignore the PnR as the max value
      <br />
      **Time-based** variables:
      <u>Discard</u>
      * NaN, Infinity, -Infinity 
      * < 0 
      
      <u>Keep</u>
      * 0 =< value < Inf


<u>Pseudocode</u>
```text
read file
import metadata
Load values for QC columns waiting for user to select a channel (FSC_A, SSC_A, HDR-T)
Load values for DNA channel A, W, and H once user selects them
Create filtering mask and filter data
```


<u>Sample JS code</u>
```js
function createStructuralValidityMask(events) {
  return events.map(event => {
    const boundedChannels = [
      "DNA_A",
      "DNA_H",
      "DNA_W",
      "FSC_A",
      "SSC_A"
    ];

    const signalsValid = boundedChannels.every(channel => {
      const value = event[channel];

      return (
        Number.isFinite(value) &&
        value > 0 &&
        value < 1000
      );
    });

    const time = event.Time;
    const timeValid =
      Number.isFinite(time) &&
      time >= 0;

    return signalsValid && timeValid;
  });
}

// Run
const mask = createStructuralValidityMask(events);

// Keep original events indexes as well for auditing 
const filteredEvents = events.filter((_, index) => mask[index]);
```


### Stage 1 | Step 3: Time-based acquisition QC (lightweight PeacoQC-inspired)
Split the retained events into contiguous time bins, summarize each bin by robust per-channel statistics, detect abnormal bins, and either remove or flag the affected intervals. (inspired by PeacoQC/flowCut but intentionally narrower than a full package port)
      
**Acquisition-QC concept**: 
“time bins" → median/IQR per channel → detect outlier bins → remove flagged time intervals

<u>Checklist</u>
- [ ] Identify discontinuities/wrappig back around of time values 
- [ ] Split events into contiguous bins by time or target events per bin
  * We will target each bin to contain ~ 500 events, and then use that and total events to calculate the total number of bins, but make sure the contininuities are fixed in bins.
- [ ] Calculate wrapped time values while also keeping raw time values    
- [ ] Calculate summary statistics for events in each bin
    * Calculate Median for:
      * DNA_A
      * FSC_A
      * SSC_A
    * Calculate event rate 
$$
r_b = \frac{n_b}{t_{\mathrm{last},b} - t_{\mathrm{first},b}}
$$


        | Term | Meaning |
        |---|---|
        | $r_b$ | Event rate for bin b |
        | $n_b$ | Total number of events in bin b |
        | $t_{\mathrm{last},b}$ | Last event's time value for bin $b$ |
        | $t_{\mathrm{first},b}$ | First event's time value for bin $b$ |

    * Calculate IQRs
      * DNA_A
      * FSC_A
      * SSC_A
- [ ] Compare each of 7 metrics (DNA_A median, DNA_A IQR, FSC_A median, FSC_A IQR, SSC_A median, SSC_A IQR, event rate) across all bins


$$
z_{b,c}
=
\frac{
x_{b,c} - \operatorname{median}(x_c)
}{
1.4826\,\operatorname{MAD}(x_c)
}
$$

| Term | Meaning |
|---|---|
| $z_{b,c}$ | Robust z-score for bin $b$ and summary metric $c$ |
| $b$ | Index of the time bin |
| $c$ | Summary metric, such as median DNA-A, IQR FSC-A, or event rate |
| $x_{b,c}$ | Value of metric $c$ calculated for bin $b$ |
| $x_c$ | Values of metric $c$ across all time bins |
| $\operatorname{median}(x_c)$ | Median value of metric $c$ across all bins |
| $\operatorname{MAD}(x_c)$ | Median absolute deviation of metric $c$ across all bins |
| $1.4826$ | Scaling constant that makes MAD comparable to standard deviation for normally distributed values |

The MAD is calculated as:

$$
\operatorname{MAD}(x_c)
=
\operatorname{median}_b
\left(
\left|
x_{b,c} - \operatorname{median}(x_c)
\right|
\right)
$$

- [ ] Flag all bins where even 1 metric has a |z| > 4.
- [ ] Create time QCmask for all events that fall in one of the flagged bins

<u>Pseudocode</u>
```text
Time channel is identified in **Stage 0**

Target bin size (in events) = 500
Total number of bins = Total events / Target bin size
Split events into contiguous bins by time or target events per bin
Split the bins in such a way that any remaider is spread evenly across all bins instead of just having 1 much, much smaller bin.

for each bin:
    compute median DNA_A
    compute median FSC_A if available
    compute median SSC_A if available
    compute event rate
    compute IQRs

    collect results for further calculations:
    { 
      medianDNA_A, iqrDNA_A, medianFSC_A, iqrFSC_A,
      medianSSC_A, iqrSSC_A, eventRate
    }

for each summary metric:
    compute across-bin median and MAD
    compute robust z-score per bin

flag bins with |z| for any metrc above 4.
Masked all events in a flagged bin
```


<u>Sample JS code</u>
```js
/**
 * Prepare HDR-T for time-based acquisition QC.
 *
 * Handles:
 * 1. Preserve original FCS event order.
 * 2. Validate HDR-T values.
 * 3. Detect genuine timer wraps.
 * 4. Detect non-wrap backward jumps and create acquisition segments.
 * 5. Create an unwrapped time value for every valid event.
 * 6. Build approximately equal-sized bins within each segment.
 */
function prepareTimeQCBins(
  rawTime,
  {
    timerRange = 32.6824,
    targetBinSize = 500,
    wrapHighFraction = 0.8,
    wrapLowFraction = 0.2,
    backwardTolerance = 1e-6
  } = {}
) {
  const eventCount = rawTime.length;

  const validTimeMask = new Uint8Array(eventCount);
  const unwrappedTime = new Float64Array(eventCount);
  const segmentId = new Int32Array(eventCount);

  unwrappedTime.fill(NaN);
  segmentId.fill(-1);

  let currentSegment = -1;
  let previousRawTime = null;
  let previousUnwrappedTime = null;
  let offset = 0;

  for (let i = 0; i < eventCount; i++) {
    const currentRawTime = rawTime[i];

    // Step 2: Validate HDR-T.
    if (!Number.isFinite(currentRawTime) || currentRawTime < 0) {
      validTimeMask[i] = 0;

      // Do not calculate time intervals across an invalid event.
      previousRawTime = null;
      previousUnwrappedTime = null;
      offset = 0;

      continue;
    }

    validTimeMask[i] = 1;

    // Start the first segment, or a new segment after invalid time data.
    if (previousRawTime === null) {
      currentSegment++;
      offset = 0;

      segmentId[i] = currentSegment;
      unwrappedTime[i] = currentRawTime;

      previousRawTime = currentRawTime;
      previousUnwrappedTime = currentRawTime;

      continue;
    }

    const movedBackward =
      currentRawTime < previousRawTime - backwardTolerance;

    if (movedBackward) {
      const likelyWrap =
        previousRawTime > wrapHighFraction * timerRange &&
        currentRawTime < wrapLowFraction * timerRange;

      if (likelyWrap) {
        // Step 3: Genuine timer wrap.
        offset += timerRange;
      } else {
        // Step 4: Non-wrap backward jump.
        // Begin a new acquisition segment.
        currentSegment++;
        offset = 0;
      }
    }

    let currentUnwrappedTime = currentRawTime + offset;

    /*
     * Ignore tiny floating-point backward movements that fall within
     * backwardTolerance by treating them as the same timestamp.
     */
    if (
      segmentId[i - 1] === currentSegment &&
      currentUnwrappedTime < previousUnwrappedTime
    ) {
      currentUnwrappedTime = previousUnwrappedTime;
    }

    segmentId[i] = currentSegment;
    unwrappedTime[i] = currentUnwrappedTime;

    previousRawTime = currentRawTime;
    previousUnwrappedTime = currentUnwrappedTime;
  }

  // Collect original event indexes by acquisition segment.
  const indexesBySegment = new Map();

  for (let i = 0; i < eventCount; i++) {
    const id = segmentId[i];

    if (id < 0) continue;

    if (!indexesBySegment.has(id)) {
      indexesBySegment.set(id, []);
    }

    indexesBySegment.get(id).push(i);
  }

  // Step 6: Build approximately 500-event bins inside each segment.
  const bins = [];

  for (const [id, indexes] of indexesBySegment) {
    const binCount = Math.max(
      1,
      Math.round(indexes.length / targetBinSize)
    );

    for (let binNumber = 0; binNumber < binCount; binNumber++) {
      const start = Math.floor(
        (binNumber * indexes.length) / binCount
      );

      const end = Math.floor(
        ((binNumber + 1) * indexes.length) / binCount
      );

      const binIndexes = indexes.slice(start, end);

      bins.push({
        segmentId: id,
        binNumber,
        indexes: binIndexes,
        size: binIndexes.length,
        firstEventIndex: binIndexes[0],
        lastEventIndex: binIndexes[binIndexes.length - 1],
        limitedReliability: binIndexes.length < targetBinSize / 2
      });
    }
  }

  return {
    validTimeMask,
    unwrappedTime,
    segmentId,
    bins,
    segmentCount: indexesBySegment.size
  };
}

const timeQC = prepareTimeQCBins(dataset.channels.Time, {
  timerRange: 32.6824,
  targetBinSize: 500
});

console.log("Segments:", timeQC.segmentCount);
console.log("Bins:", timeQC.bins.length);


function calculateBinEventRate(bin, unwrappedTime) {
  if (bin.indexes.length < 2) return NaN;

  const firstIndex = bin.indexes[0];
  const lastIndex = bin.indexes[bin.indexes.length - 1];

  const duration =
    unwrappedTime[lastIndex] - unwrappedTime[firstIndex];

  return duration > 0
    ? bin.indexes.length / duration
    : NaN;
}

function quantileSorted(sortedValues, probability) {
  const n = sortedValues.length;

  if (n === 0) return NaN;
  if (n === 1) return sortedValues[0];

  const position = (n - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const fraction = position - lowerIndex;

  return (
    sortedValues[lowerIndex] +
    fraction *
      (sortedValues[upperIndex] - sortedValues[lowerIndex])
  );
}

function summarizeChannel(channelValues, eventIndexes) {
  const values = [];

  for (const eventIndex of eventIndexes) {
    const value = channelValues[eventIndex];

    if (Number.isFinite(value)) {
      values.push(value);
    }
  }

  if (values.length === 0) {
    return {
      median: NaN,
      q1: NaN,
      q3: NaN,
      iqr: NaN,
      n: 0
    };
  }

  values.sort((a, b) => a - b);

  const q1 = quantileSorted(values, 0.25);
  const median = quantileSorted(values, 0.5);
  const q3 = quantileSorted(values, 0.75);

  return {
    median,
    q1,
    q3,
    iqr: q3 - q1,
    n: values.length
  };
}

function summarizeTimeQCBins(bins, channels) {
  return bins.map((bin, index) => ({
    binIndex: index,
    segmentId: bin.segmentId,
    binNumber: bin.binNumber,
    eventCount: bin.indexes.length,

    DNA_A: summarizeChannel(
      channels.DNA_A,
      bin.indexes
    ),

    FSC_A: summarizeChannel(
      channels.FSC_A,
      bin.indexes
    ),

    SSC_A: summarizeChannel(
      channels.SSC_A,
      bin.indexes
    )
  }));
}

const binSummaries = summarizeTimeQCBins(
  timeQC.bins,
  dataset.channels
);

console.log(binSummaries[0]);


// Now looking at each metric across all bins:
function median(values) {
  if (values.length === 0) return NaN;

  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mad(values, center = median(values)) {
  if (!Number.isFinite(center)) return NaN;

  return median(
    values.map(value => Math.abs(value - center))
  );
}

const TIME_QC_METRICS = {
  medianDNA_A: summary => summary.DNA_A.median,
  iqrDNA_A: summary => summary.DNA_A.iqr,

  medianFSC_A: summary => summary.FSC_A.median,
  iqrFSC_A: summary => summary.FSC_A.iqr,

  medianSSC_A: summary => summary.SSC_A.median,
  iqrSSC_A: summary => summary.SSC_A.iqr,

  eventRate: summary => summary.eventRate
};

function calculateMetricBaselines(binSummaries) {
  const baselines = {};

  for (const [metricName, getValue] of Object.entries(TIME_QC_METRICS)) {
    const values = binSummaries
      .map(getValue)
      .filter(Number.isFinite);

    const center = median(values);
    const metricMAD = mad(values, center);

    baselines[metricName] = {
      median: center,
      mad: metricMAD,
      robustScale: 1.4826 * metricMAD,
      validBinCount: values.length
    };
  }

  return baselines;
}

function calculateRobustZ(value, baseline, epsilon = 1e-12) {
  if (!Number.isFinite(value)) return NaN;

  const difference = value - baseline.median;

  if (baseline.robustScale > epsilon) {
    return difference / baseline.robustScale;
  }

  /*
   * If MAD is zero, nearly every bin had the same value.
   * An identical value gets z = 0; a different value is treated
   * as an extreme deviation.
   */
  if (Math.abs(difference) <= epsilon) {
    return 0;
  }

  return difference > 0 ? Infinity : -Infinity;
}

function scoreTimeQCBins(binSummaries, threshold = 4) {
  const baselines = calculateMetricBaselines(binSummaries);

  const scoredBins = binSummaries.map(summary => {
    const zScores = {};
    const reasons = [];
    let maximumAbsoluteZ = 0;

    for (const [metricName, getValue] of Object.entries(TIME_QC_METRICS)) {
      const value = getValue(summary);

      if (!Number.isFinite(value)) {
        zScores[metricName] = NaN;
        reasons.push(`${metricName}: invalid value`);
        continue;
      }

      const z = calculateRobustZ(
        value,
        baselines[metricName]
      );

      zScores[metricName] = z;

      const absoluteZ = Math.abs(z);
      maximumAbsoluteZ = Math.max(maximumAbsoluteZ, absoluteZ);

      if (absoluteZ > threshold) {
        reasons.push(metricName);
      }
    }

    return {
      ...summary,
      zScores,
      score: maximumAbsoluteZ,
      flagged: reasons.length > 0,
      reasons
    };
  });

  return {
    baselines,
    scoredBins
  };
}

function calculateBinEventRate(bin, unwrappedTime) {
  if (bin.indexes.length < 2) return NaN;

  const firstIndex = bin.indexes[0];
  const lastIndex = bin.indexes[bin.indexes.length - 1];

  const duration =
    unwrappedTime[lastIndex] -
    unwrappedTime[firstIndex];

  return duration > 0
    ? bin.indexes.length / duration
    : NaN;
}

const binSummaries = timeQC.bins.map((bin, binIndex) => ({
  binIndex,
  segmentId: bin.segmentId,
  binNumber: bin.binNumber,
  eventCount: bin.indexes.length,

  DNA_A: summarizeChannel(
    dataset.channels.DNA_A,
    bin.indexes
  ),

  FSC_A: summarizeChannel(
    dataset.channels.FSC_A,
    bin.indexes
  ),

  SSC_A: summarizeChannel(
    dataset.channels.SSC_A,
    bin.indexes
  ),

  eventRate: calculateBinEventRate(
    bin,
    timeQC.unwrappedTime
  )
}));

const {
  baselines,
  scoredBins
} = scoreTimeQCBins(binSummaries, 4);

function mergeFlaggedBins(scoredBins, bins) {
  const flagged = scoredBins
    .filter(result => result.flagged)
    .sort((a, b) =>
      a.segmentId - b.segmentId ||
      a.binNumber - b.binNumber
    );

  const intervals = [];

  for (const result of flagged) {
    const bin = bins[result.binIndex];
    const previousInterval = intervals.at(-1);

    const isAdjacent =
      previousInterval &&
      previousInterval.segmentId === result.segmentId &&
      result.binNumber === previousInterval.lastBinNumber + 1;

    if (isAdjacent) {
      previousInterval.lastBinNumber = result.binNumber;
      previousInterval.lastEventIndex = bin.lastEventIndex;
      previousInterval.binIndexes.push(result.binIndex);
      previousInterval.reasons.push(...result.reasons);
    } else {
      intervals.push({
        segmentId: result.segmentId,
        firstBinNumber: result.binNumber,
        lastBinNumber: result.binNumber,
        firstEventIndex: bin.firstEventIndex,
        lastEventIndex: bin.lastEventIndex,
        binIndexes: [result.binIndex],
        reasons: [...result.reasons]
      });
    }
  }

  // Remove duplicate reason names.
  for (const interval of intervals) {
    interval.reasons = [...new Set(interval.reasons)];
  }

  return intervals;
}

function createTimeQCMask(eventCount, scoredBins, bins) {
  const mask = new Uint8Array(eventCount);
  mask.fill(1);

  for (const result of scoredBins) {
    if (!result.flagged) continue;

    for (const eventIndex of bins[result.binIndex].indexes) {
      mask[eventIndex] = 0;
    }
  }

  return mask;
}

const flaggedIntervals = mergeFlaggedBins(
  scoredBins,
  timeQC.bins
);

const timeQCMask = createTimeQCMask(
  dataset.eventCount,
  scoredBins,
  timeQC.bins
);
```



### Stage 2 | Step 4: Cell gating (main FSC/SSC population)
Isolate the main biological cloud before singlet discrimination. 

* If FSC-A and SSC-A are available: perform a robust two-dimensional gate in scatter space. 

* Removes sub-cellular debris and coarse junk by size/granularity before the finer singlet step. 

* This is standard practice and matches the two-component-GMM cell-gating approach documented for FlowGateNIST and similar tools (a two-component GMM on forward/side scatter, keeping events within two SD of the tighter component’s mean).

<u>Checklist</u>
- [ ] Build the set of scatterpoins (FSC_A vs SSC_A)
- [ ] Fit two-component GMM
- [ ] Identify the main biological component 
- [ ] Calculate Mahalanobis distance
- [ ] Apply the ellipse threshold
- [ ] Create the scatter-gate mask

<u>Pseudocode</u>
```text
estimate robust center and covariance of main scatter cloud
compute Mahalanobis distance for each event
keep events inside ellipse threshold
```


<u>Sample JS code</u>
```js
/**
 * Two-component FSC-A / SSC-A biological-cloud gate.
 *
 * Expected dataset structure:
 *
 * dataset = {
 *   eventCount: 65691,
 *   channels: {
 *     FSC_A: Float32Array(...),
 *     SSC_A: Float32Array(...)
 *   }
 * };
 *
 * Mask convention:
 *   1 = event passed
 *   0 = event failed
 */


/* ============================================================
 * STEP 1 — Build the FSC-A / SSC-A scatter-point matrix
 * ============================================================
 *
 * Only events that passed structural QC and time QC are included.
 * Each point retains its original event index.
 */

function buildScatterPoints(
  dataset,
  structuralMask,
  timeQCMask
) {
  const fsc = dataset.channels.FSC_A;
  const ssc = dataset.channels.SSC_A;

  if (!fsc || !ssc) {
    throw new Error("FSC_A and SSC_A channels are required.");
  }

  if (fsc.length !== ssc.length) {
    throw new Error("FSC_A and SSC_A lengths do not match.");
  }

  const eventCount = dataset.eventCount ?? fsc.length;
  const scatterPoints = [];

  for (let eventIndex = 0; eventIndex < eventCount; eventIndex++) {
    if (structuralMask && structuralMask[eventIndex] === 0) {
      continue;
    }

    if (timeQCMask && timeQCMask[eventIndex] === 0) {
      continue;
    }

    const fscValue = fsc[eventIndex];
    const sscValue = ssc[eventIndex];

    if (
      !Number.isFinite(fscValue) ||
      !Number.isFinite(sscValue)
    ) {
      continue;
    }

    scatterPoints.push({
      eventIndex,
      point: [fscValue, sscValue]
    });
  }

  if (scatterPoints.length < 10) {
    throw new Error(
      "Too few valid FSC-A/SSC-A events remain for GMM fitting."
    );
  }

  return scatterPoints;
}


/* ============================================================
 * STEP 2 — Fit a deterministic two-component 2D GMM
 * ============================================================
 *
 * This uses expectation maximization with:
 *
 * - deterministic initial means
 * - full 2 × 2 covariance matrices
 * - covariance regularization
 * - log-domain probability calculations
 * - convergence checking
 */

function median(values) {
  if (values.length === 0) return NaN;

  const sorted = Array.from(values).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mad(values, center = median(values)) {
  if (!Number.isFinite(center)) return NaN;

  return median(
    Array.from(values, value => Math.abs(value - center))
  );
}

function variance(values) {
  if (values.length < 2) return 0;

  const mean =
    values.reduce((sum, value) => sum + value, 0) /
    values.length;

  return (
    values.reduce(
      (sum, value) => sum + (value - mean) ** 2,
      0
    ) / values.length
  );
}

function deterministicInitialMeans(points, componentCount) {
  const fscValues = points.map(point => point[0]);
  const sscValues = points.map(point => point[1]);

  const medianFSC = median(fscValues);
  const medianSSC = median(sscValues);

  const robustScaleFSC = 1.4826 * mad(fscValues, medianFSC);
  const robustScaleSSC = 1.4826 * mad(sscValues, medianSSC);

  const scaleFSC =
    Number.isFinite(robustScaleFSC) && robustScaleFSC > 0
      ? robustScaleFSC
      : Math.sqrt(variance(fscValues)) || 1;

  const scaleSSC =
    Number.isFinite(robustScaleSSC) && robustScaleSSC > 0
      ? robustScaleSSC
      : Math.sqrt(variance(sscValues)) || 1;

  /*
   * Rank events along a combined standardized FSC/SSC axis.
   * For K = 2, the initial means come from approximately the
   * 25th and 75th percentiles of that ranking.
   */
  const ranked = points
    .map(point => ({
      point,
      score:
        (point[0] - medianFSC) / scaleFSC +
        (point[1] - medianSSC) / scaleSSC
    }))
    .sort((a, b) => a.score - b.score);

  const means = [];

  for (let k = 0; k < componentCount; k++) {
    const probability = (k + 0.5) / componentCount;

    const index = Math.min(
      ranked.length - 1,
      Math.floor(probability * ranked.length)
    );

    means.push(ranked[index].point.slice());
  }

  return means;
}

function calculateGlobalCovariance(points) {
  const n = points.length;

  let meanX = 0;
  let meanY = 0;

  for (const [x, y] of points) {
    meanX += x;
    meanY += y;
  }

  meanX /= n;
  meanY /= n;

  let varianceX = 0;
  let varianceY = 0;
  let covarianceXY = 0;

  for (const [x, y] of points) {
    const dx = x - meanX;
    const dy = y - meanY;

    varianceX += dx * dx;
    varianceY += dy * dy;
    covarianceXY += dx * dy;
  }

  varianceX /= n;
  varianceY /= n;
  covarianceXY /= n;

  return [
    [varianceX, covarianceXY],
    [covarianceXY, varianceY]
  ];
}

function regularizeCovariance(
  covariance,
  regularizationFraction = 1e-6
) {
  const averageVariance = Math.max(
    1,
    (covariance[0][0] + covariance[1][1]) / 2
  );

  const regularization =
    regularizationFraction * averageVariance;

  return [
    [
      covariance[0][0] + regularization,
      covariance[0][1]
    ],
    [
      covariance[1][0],
      covariance[1][1] + regularization
    ]
  ];
}

function invertCovariance2D(covariance) {
  const a = covariance[0][0];
  const b = covariance[0][1];
  const c = covariance[1][0];
  const d = covariance[1][1];

  const determinant = a * d - b * c;

  if (
    !Number.isFinite(determinant) ||
    determinant <= 0
  ) {
    return null;
  }

  return {
    determinant,

    inverse: [
      [d / determinant, -b / determinant],
      [-c / determinant, a / determinant]
    ]
  };
}

function logGaussian2D(point, component) {
  const matrixInfo = invertCovariance2D(
    component.covariance
  );

  if (!matrixInfo) return -Infinity;

  const [x, y] = point;
  const [meanX, meanY] = component.mean;

  const dx = x - meanX;
  const dy = y - meanY;

  const inverse = matrixInfo.inverse;

  const mahalanobis =
    dx * (inverse[0][0] * dx + inverse[0][1] * dy) +
    dy * (inverse[1][0] * dx + inverse[1][1] * dy);

  return (
    -Math.log(2 * Math.PI) -
    0.5 * Math.log(matrixInfo.determinant) -
    0.5 * mahalanobis
  );
}

function logSumExp(logValues) {
  const maximum = Math.max(...logValues);

  if (!Number.isFinite(maximum)) {
    return -Infinity;
  }

  let sum = 0;

  for (const value of logValues) {
    sum += Math.exp(value - maximum);
  }

  return maximum + Math.log(sum);
}

function calculateGMMLogLikelihood(points, components) {
  let logLikelihood = 0;

  for (const point of points) {
    const logWeights = components.map(component =>
      Math.log(Math.max(component.weight, 1e-300)) +
      logGaussian2D(point, component)
    );

    logLikelihood += logSumExp(logWeights);
  }

  return logLikelihood;
}

function fitGMM2D(
  points,
  {
    componentCount = 2,
    maxIterations = 100,
    tolerance = 1e-6,
    regularizationFraction = 1e-6,
    minimumComponentFraction = 1e-4
  } = {}
) {
  if (points.length < componentCount * 2) {
    throw new Error(
      "Too few points to fit the requested GMM."
    );
  }

  const n = points.length;

  const initialMeans = deterministicInitialMeans(
    points,
    componentCount
  );

  const globalCovariance = regularizeCovariance(
    calculateGlobalCovariance(points),
    regularizationFraction
  );

  let components = initialMeans.map(mean => ({
    weight: 1 / componentCount,
    mean: mean.slice(),
    covariance: [
      globalCovariance[0].slice(),
      globalCovariance[1].slice()
    ]
  }));

  const responsibilities = Array.from(
    { length: n },
    () => new Float64Array(componentCount)
  );

  let previousLogLikelihood = -Infinity;
  let converged = false;
  let iterationsCompleted = 0;

  for (
    let iteration = 0;
    iteration < maxIterations;
    iteration++
  ) {
    iterationsCompleted = iteration + 1;

    /*
     * Expectation step:
     * calculate each event's responsibility for each component.
     */
    let logLikelihood = 0;

    for (let i = 0; i < n; i++) {
      const logWeights = components.map(component =>
        Math.log(Math.max(component.weight, 1e-300)) +
        logGaussian2D(points[i], component)
      );

      const normalization = logSumExp(logWeights);
      logLikelihood += normalization;

      for (let k = 0; k < componentCount; k++) {
        responsibilities[i][k] = Math.exp(
          logWeights[k] - normalization
        );
      }
    }

    if (
      iteration > 0 &&
      Math.abs(logLikelihood - previousLogLikelihood) <=
        tolerance *
          (1 + Math.abs(previousLogLikelihood))
    ) {
      converged = true;
      break;
    }

    previousLogLikelihood = logLikelihood;

    /*
     * Maximization step:
     * update component weights, means, and covariance matrices.
     */
    const updatedComponents = [];

    for (let k = 0; k < componentCount; k++) {
      let effectiveCount = 0;

      for (let i = 0; i < n; i++) {
        effectiveCount += responsibilities[i][k];
      }

      const minimumEffectiveCount =
        minimumComponentFraction * n;

      /*
       * Reinitialize a collapsed component rather than allowing
       * a singular covariance matrix.
       */
      if (effectiveCount < minimumEffectiveCount) {
        updatedComponents.push({
          weight: minimumComponentFraction,
          mean: initialMeans[k].slice(),
          covariance: [
            globalCovariance[0].slice(),
            globalCovariance[1].slice()
          ]
        });

        continue;
      }

      let meanX = 0;
      let meanY = 0;

      for (let i = 0; i < n; i++) {
        const responsibility = responsibilities[i][k];

        meanX += responsibility * points[i][0];
        meanY += responsibility * points[i][1];
      }

      meanX /= effectiveCount;
      meanY /= effectiveCount;

      let varianceX = 0;
      let varianceY = 0;
      let covarianceXY = 0;

      for (let i = 0; i < n; i++) {
        const responsibility = responsibilities[i][k];

        const dx = points[i][0] - meanX;
        const dy = points[i][1] - meanY;

        varianceX += responsibility * dx * dx;
        varianceY += responsibility * dy * dy;
        covarianceXY += responsibility * dx * dy;
      }

      varianceX /= effectiveCount;
      varianceY /= effectiveCount;
      covarianceXY /= effectiveCount;

      const covariance = regularizeCovariance(
        [
          [varianceX, covarianceXY],
          [covarianceXY, varianceY]
        ],
        regularizationFraction
      );

      updatedComponents.push({
        weight: effectiveCount / n,
        mean: [meanX, meanY],
        covariance
      });
    }

    /*
     * Renormalize weights in case a collapsed component was reset.
     */
    const totalWeight = updatedComponents.reduce(
      (sum, component) => sum + component.weight,
      0
    );

    for (const component of updatedComponents) {
      component.weight /= totalWeight;
    }

    components = updatedComponents;
  }

  return {
    components,
    converged,
    iterations: iterationsCompleted,
    logLikelihood: calculateGMMLogLikelihood(
      points,
      components
    )
  };
}


/* ============================================================
 * STEP 3 — Identify the main biological component
 * ============================================================
 *
 * Exclude very small components when possible, then select the
 * substantial component with the higher mean FSC-A.
 *
 * SSC-A is used as a tiebreaker.
 */

function chooseMainBiologicalComponent(
  components,
  {
    minimumWeight = 0.1
  } = {}
) {
  const indexedComponents = components.map(
    (component, componentIndex) => ({
      component,
      componentIndex
    })
  );

  const substantialComponents = indexedComponents.filter(
    item => item.component.weight >= minimumWeight
  );

  const candidates =
    substantialComponents.length > 0
      ? substantialComponents
      : indexedComponents;

  return candidates.reduce((best, current) => {
    const bestFSC = best.component.mean[0];
    const currentFSC = current.component.mean[0];

    if (currentFSC > bestFSC) {
      return current;
    }

    if (
      currentFSC === bestFSC &&
      current.component.mean[1] >
        best.component.mean[1]
    ) {
      return current;
    }

    return best;
  });
}


/* ============================================================
 * STEP 4 — Calculate Mahalanobis distance from the main cloud
 * ============================================================
 */

function mahalanobisSquared(point, component) {
  const matrixInfo = invertCovariance2D(
    component.covariance
  );

  if (!matrixInfo) return Infinity;

  const [x, y] = point;
  const [meanX, meanY] = component.mean;

  const dx = x - meanX;
  const dy = y - meanY;

  const inverse = matrixInfo.inverse;

  return (
    dx * (inverse[0][0] * dx + inverse[0][1] * dy) +
    dy * (inverse[1][0] * dx + inverse[1][1] * dy)
  );
}


/* ============================================================
 * STEP 5 — Apply the two-dimensional ellipse threshold
 * ============================================================
 *
 * A squared Mahalanobis threshold of 5.991 corresponds to the
 * approximately 95% probability ellipse for two dimensions.
 *
 * Use 4.0 instead if you specifically want a Mahalanobis
 * radius of 2:
 *
 *     d <= 2  <=>  d² <= 4
 */

const DEFAULT_SCATTER_THRESHOLD = 5.991;


/* ============================================================
 * STEP 6 — Create the event-level scatter-gate mask
 * ============================================================
 *
 * Mask convention:
 *   1 = event lies inside the selected biological cloud
 *   0 = event lies outside, or never entered this gating step
 */

function createScatterGateMask(
  eventCount,
  scatterPoints,
  mainComponent,
  threshold = DEFAULT_SCATTER_THRESHOLD
) {
  const mask = new Uint8Array(eventCount);

  const mahalanobisDistanceSquared =
    new Float64Array(eventCount);

  mahalanobisDistanceSquared.fill(NaN);

  for (const { eventIndex, point } of scatterPoints) {
    const distanceSquared = mahalanobisSquared(
      point,
      mainComponent
    );

    mahalanobisDistanceSquared[eventIndex] =
      distanceSquared;

    if (
      Number.isFinite(distanceSquared) &&
      distanceSquared <= threshold
    ) {
      mask[eventIndex] = 1;
    }
  }

  return {
    mask,
    mahalanobisDistanceSquared
  };
}


/* ============================================================
 * COMPLETE PIPELINE — Run Steps 1 through 6
 * ============================================================
 */

function gateMainBiologicalCloud(
  dataset,
  structuralMask,
  timeQCMask,
  {
    threshold = DEFAULT_SCATTER_THRESHOLD,
    minimumMainComponentWeight = 0.1,
    gmmOptions = {}
  } = {}
) {
  // Step 1
  const scatterPoints = buildScatterPoints(
    dataset,
    structuralMask,
    timeQCMask
  );

  const points = scatterPoints.map(
    item => item.point
  );

  // Step 2
  const gmmResult = fitGMM2D(points, {
    componentCount: 2,
    ...gmmOptions
  });

  // Step 3
  const selected = chooseMainBiologicalComponent(
    gmmResult.components,
    {
      minimumWeight: minimumMainComponentWeight
    }
  );

  const mainComponent = selected.component;

  // Steps 4, 5, and 6
  const {
    mask,
    mahalanobisDistanceSquared
  } = createScatterGateMask(
    dataset.eventCount,
    scatterPoints,
    mainComponent,
    threshold
  );

  return {
    scatterMask: mask,
    mahalanobisDistanceSquared,
    scatterPoints,
    components: gmmResult.components,
    mainComponent,
    mainComponentIndex: selected.componentIndex,
    threshold,
    converged: gmmResult.converged,
    iterations: gmmResult.iterations,
    logLikelihood: gmmResult.logLikelihood
  };
}


/* ============================================================
 * USAGE
 * ============================================================
 */

const scatterGateResult = gateMainBiologicalCloud(
  dataset,
  structuralMask,
  timeQCMask,
  {
    threshold: 5.991,

    minimumMainComponentWeight: 0.1,

    gmmOptions: {
      maxIterations: 100,
      tolerance: 1e-6,
      regularizationFraction: 1e-6
    }
  }
);

const scatterMask = scatterGateResult.scatterMask;

console.log(
  "GMM converged:",
  scatterGateResult.converged
);

console.log(
  "Iterations:",
  scatterGateResult.iterations
);

console.log(
  "Selected component:",
  scatterGateResult.mainComponent
);


/* ============================================================
 * COMBINE WITH PREVIOUS MASKS
 * ============================================================
 */

const finalMask = new Uint8Array(dataset.eventCount);

for (let eventIndex = 0;
  eventIndex < dataset.eventCount;
  eventIndex++
) {
  finalMask[eventIndex] =
    structuralMask[eventIndex] &&
    timeQCMask[eventIndex] &&
    scatterMask[eventIndex]
      ? 1
      : 0;
}
```

### Stage 3 | Step 5: Gate singlets by pulse geometry (Area vs Height/Width)
Use DNA pulse geometry to remove doublets and aggregates before histogram construction whenever area/height or area/width channels exist.

<u>Checklist</u>
- [ ] Calculate basic robust statistics
- [ ] Calculate the principal ridge direction
- [ ] Calculate a weighted center
- [ ] Calculate a weighted covariance matrix
- [ ] Calculate signed orthogonal distance to the ridge
- [ ] Fit the robust singlet ridge
- [ ] Copy the previous mask when gating must be skipped
- [ ] Select DNA-A/H or DNA-A/W pulse geometry
- [ ] Build the pulse-geometry point matrix
- [ ] Apply the k-MAD singlet threshold
- [ ] Run the complete pulse-geometry singlet gate
- [ ] Combine previous QC and gating masks
- [ ] Run the singlet gate
- [ ] Create the final event mask
- [ ] Report diagnostics

<u>Pseudocode</u>
```text
if DNA-A and DNA-H exist:
    fit robust singlet ridge in A-H space
    compute orthogonal distances to ridge
    keep events within k MAD of ridge

else if DNA-A and DNA-W exist:
    fit robust singlet ridge in A-W space
    keep events within k MAD

else:
    skip event-level singlet gate
    mark file as "no pulse geometry"
    allow optional aggregate term in model
```


<u>Sample JS code</u>
```js
/**
 * Robust pulse-geometry singlet gate.
 *
 * Decision order:
 *
 * 1. Use DNA_A versus DNA_H when both exist.
 * 2. Otherwise use DNA_A versus DNA_W when both exist.
 * 3. Otherwise skip event-level singlet gating and recommend
 *    enabling the optional aggregate term in the histogram model.
 *
 * Mask convention:
 *
 *   1 = retain event
 *   0 = exclude event
 */


/* ============================================================
 * STEP 1 — Calculate basic robust statistics
 * ============================================================
 */

function median(values) {
  if (values.length === 0) return NaN;

  const sorted = Array.from(values).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mad(values, center = median(values)) {
  if (!Number.isFinite(center)) {
    return NaN;
  }

  const deviations = Array.from(
    values,
    value => Math.abs(value - center)
  );

  return median(deviations);
}


/* ============================================================
 * STEP 2 — Calculate the principal ridge direction
 * ============================================================
 *
 * For a 2 × 2 covariance matrix:
 *
 *     [ varianceX      covarianceXY ]
 *     [ covarianceXY   varianceY   ]
 *
 * the major eigenvector defines the ridge direction.
 */

function principalDirection2D(covariance) {
  const varianceX = covariance[0][0];
  const covarianceXY = covariance[0][1];
  const varianceY = covariance[1][1];

  const angle = 0.5 * Math.atan2(
    2 * covarianceXY,
    varianceX - varianceY
  );

  return [
    Math.cos(angle),
    Math.sin(angle)
  ];
}


/* ============================================================
 * STEP 3 — Calculate a weighted center
 * ============================================================
 */

function calculateWeightedCenter(points, weights) {
  let totalWeight = 0;
  let weightedX = 0;
  let weightedY = 0;

  for (let i = 0; i < points.length; i++) {
    const weight = weights[i];

    totalWeight += weight;
    weightedX += weight * points[i][0];
    weightedY += weight * points[i][1];
  }

  if (!(totalWeight > 0)) {
    throw new Error(
      "Cannot calculate ridge center: total weight is zero."
    );
  }

  return [
    weightedX / totalWeight,
    weightedY / totalWeight
  ];
}


/* ============================================================
 * STEP 4 — Calculate a weighted covariance matrix
 * ============================================================
 */

function calculateWeightedCovariance(
  points,
  weights,
  center,
  regularization = 1e-9
) {
  let totalWeight = 0;
  let varianceX = 0;
  let varianceY = 0;
  let covarianceXY = 0;

  for (let i = 0; i < points.length; i++) {
    const weight = weights[i];

    const dx = points[i][0] - center[0];
    const dy = points[i][1] - center[1];

    totalWeight += weight;

    varianceX += weight * dx * dx;
    varianceY += weight * dy * dy;
    covarianceXY += weight * dx * dy;
  }

  if (!(totalWeight > 0)) {
    throw new Error(
      "Cannot calculate ridge covariance: total weight is zero."
    );
  }

  return [
    [
      varianceX / totalWeight + regularization,
      covarianceXY / totalWeight
    ],
    [
      covarianceXY / totalWeight,
      varianceY / totalWeight + regularization
    ]
  ];
}


/* ============================================================
 * STEP 5 — Calculate signed orthogonal distance to the ridge
 * ============================================================
 *
 * If the ridge direction is:
 *
 *     [directionX, directionY]
 *
 * then a perpendicular unit vector is:
 *
 *     [-directionY, directionX]
 */

function signedOrthogonalDistance(
  point,
  center,
  direction
) {
  const normalX = -direction[1];
  const normalY = direction[0];

  return (
    (point[0] - center[0]) * normalX +
    (point[1] - center[1]) * normalY
  );
}


/* ============================================================
 * STEP 6 — Fit the robust singlet ridge
 * ============================================================
 *
 * This uses iterative Huber weighting:
 *
 * 1. Estimate the ridge.
 * 2. Calculate orthogonal distances.
 * 3. Down-weight events far from the ridge.
 * 4. Refit until stable.
 */

function fitRobustRidge2D(
  points,
  {
    maxIterations = 50,
    convergenceTolerance = 1e-7,
    huberConstant = 1.345,
    covarianceRegularization = 1e-9
  } = {}
) {
  if (points.length < 3) {
    throw new Error(
      "At least three points are required to fit a ridge."
    );
  }

  /*
   * Initial center uses coordinate-wise medians so that distant
   * outliers have less influence than they would on a mean.
   */
  let center = [
    median(points.map(point => point[0])),
    median(points.map(point => point[1]))
  ];

  const weights = new Float64Array(points.length);
  weights.fill(1);

  let covariance = calculateWeightedCovariance(
    points,
    weights,
    center,
    covarianceRegularization
  );

  let direction = principalDirection2D(covariance);

  let converged = false;
  let iterationsCompleted = 0;

  for (
    let iteration = 0;
    iteration < maxIterations;
    iteration++
  ) {
    iterationsCompleted = iteration + 1;

    /*
     * Calculate signed orthogonal distances from the current ridge.
     */
    const distances = points.map(point =>
      signedOrthogonalDistance(
        point,
        center,
        direction
      )
    );

    const distanceMedian = median(distances);
    const distanceMAD = mad(
      distances,
      distanceMedian
    );

    /*
     * Convert MAD into a robust scale comparable to standard
     * deviation. This is used only to calculate Huber weights.
     */
    const robustScale = 1.4826 * distanceMAD;

    if (
      !Number.isFinite(robustScale) ||
      robustScale <= Number.EPSILON
    ) {
      converged = true;
      break;
    }

    /*
     * Assign Huber weights.
     *
     * Near-ridge events retain weight 1.
     * Distant events receive progressively smaller weights.
     */
    for (let i = 0; i < distances.length; i++) {
      const standardizedDistance =
        Math.abs(distances[i] - distanceMedian) /
        robustScale;

      weights[i] =
        standardizedDistance <= huberConstant
          ? 1
          : huberConstant / standardizedDistance;
    }

    /*
     * Recalculate the center, covariance, and ridge direction.
     */
    const newCenter = calculateWeightedCenter(
      points,
      weights
    );

    const newCovariance =
      calculateWeightedCovariance(
        points,
        weights,
        newCenter,
        covarianceRegularization
      );

    const newDirection =
      principalDirection2D(newCovariance);

    /*
     * A direction vector and its negative represent the same line.
     * Align the signs before measuring convergence.
     */
    const directionDotProduct =
      direction[0] * newDirection[0] +
      direction[1] * newDirection[1];

    if (directionDotProduct < 0) {
      newDirection[0] *= -1;
      newDirection[1] *= -1;
    }

    const centerMovement = Math.hypot(
      newCenter[0] - center[0],
      newCenter[1] - center[1]
    );

    const directionMovement = Math.hypot(
      newDirection[0] - direction[0],
      newDirection[1] - direction[1]
    );

    center = newCenter;
    covariance = newCovariance;
    direction = newDirection;

    if (
      centerMovement <= convergenceTolerance &&
      directionMovement <= convergenceTolerance
    ) {
      converged = true;
      break;
    }
  }

  /*
   * Calculate final distances using the final ridge.
   */
  const distances = points.map(point =>
    signedOrthogonalDistance(
      point,
      center,
      direction
    )
  );

  const distanceMedian = median(distances);
  const distanceMAD = mad(
    distances,
    distanceMedian
  );

  return {
    center,
    direction,
    covariance,
    distances,
    distanceMedian,
    distanceMAD,
    weights,
    converged,
    iterations: iterationsCompleted
  };
}


/* ============================================================
 * STEP 7 — Copy the previous mask when gating must be skipped
 * ============================================================
 */

function copyInputMask(eventCount, inputMask) {
  const copiedMask = new Uint8Array(eventCount);

  for (let eventIndex = 0;
    eventIndex < eventCount;
    eventIndex++
  ) {
    copiedMask[eventIndex] =
      !inputMask || inputMask[eventIndex] === 1
        ? 1
        : 0;
  }

  return copiedMask;
}


/* ============================================================
 * STEP 8 — Select DNA-A/H or DNA-A/W pulse geometry
 * ============================================================
 */

function selectPulseGeometry(dataset) {
  const dnaA = dataset.channels.DNA_A;
  const dnaH = dataset.channels.DNA_H;
  const dnaW = dataset.channels.DNA_W;

  const eventCount =
    dataset.eventCount ??
    dnaA?.length ??
    0;

  if (!dnaA || dnaA.length !== eventCount) {
    throw new Error(
      "DNA_A is missing or has an invalid length."
    );
  }

  /*
   * Preferred geometry: DNA-A versus DNA-H.
   */
  if (dnaH && dnaH.length === eventCount) {
    return {
      areaChannel: dnaA,
      secondaryChannel: dnaH,
      geometryMode: "DNA_A_vs_DNA_H",
      secondaryChannelName: "DNA_H"
    };
  }

  /*
   * Fallback geometry: DNA-A versus DNA-W.
   */
  if (dnaW && dnaW.length === eventCount) {
    return {
      areaChannel: dnaA,
      secondaryChannel: dnaW,
      geometryMode: "DNA_A_vs_DNA_W",
      secondaryChannelName: "DNA_W"
    };
  }

  /*
   * Neither usable pulse-geometry pair exists.
   */
  return null;
}


/* ============================================================
 * STEP 9 — Build the pulse-geometry point matrix
 * ============================================================
 *
 * Only events retained by previous masks enter the ridge fit.
 * Original event indexes are preserved.
 */

function buildPulseGeometryPoints(
  areaChannel,
  secondaryChannel,
  inputMask
) {
  const indexedPoints = [];

  for (
    let eventIndex = 0;
    eventIndex < areaChannel.length;
    eventIndex++
  ) {
    if (
      inputMask &&
      inputMask[eventIndex] === 0
    ) {
      continue;
    }

    const area = areaChannel[eventIndex];
    const secondary = secondaryChannel[eventIndex];

    if (
      !Number.isFinite(area) ||
      !Number.isFinite(secondary)
    ) {
      continue;
    }

    indexedPoints.push({
      eventIndex,
      point: [area, secondary]
    });
  }

  return indexedPoints;
}


/* ============================================================
 * STEP 10 — Apply the k-MAD singlet threshold
 * ============================================================
 *
 * Retain an event when:
 *
 * |distance - median distance| <= k × MAD
 */

function createSingletMaskFromRidge(
  eventCount,
  indexedPoints,
  ridge,
  kMAD
) {
  const singletMask = new Uint8Array(eventCount);

  const orthogonalDistance =
    new Float64Array(eventCount);

  orthogonalDistance.fill(NaN);

  const distanceDeviation =
    new Float64Array(eventCount);

  distanceDeviation.fill(NaN);

  const threshold =
    kMAD * ridge.distanceMAD;

  let retainedSingletCount = 0;

  for (let pointIndex = 0;
    pointIndex < indexedPoints.length;
    pointIndex++
  ) {
    const eventIndex =
      indexedPoints[pointIndex].eventIndex;

    const distance =
      ridge.distances[pointIndex];

    const deviation = Math.abs(
      distance - ridge.distanceMedian
    );

    orthogonalDistance[eventIndex] = distance;
    distanceDeviation[eventIndex] = deviation;

    const retained =
      ridge.distanceMAD === 0
        ? deviation === 0
        : deviation <= threshold;

    if (Number.isFinite(deviation) && retained) {
      singletMask[eventIndex] = 1;
      retainedSingletCount++;
    }
  }

  return {
    singletMask,
    orthogonalDistance,
    distanceDeviation,
    threshold,
    retainedSingletCount
  };
}


/* ============================================================
 * STEP 11 — Run the complete pulse-geometry singlet gate
 * ============================================================
 */

function gateByPulseGeometry(
  dataset,
  inputMask,
  {
    kMAD = 5,
    minimumPoints = 20,
    ridgeOptions = {}
  } = {}
) {
  const eventCount =
    dataset.eventCount ??
    dataset.channels.DNA_A?.length ??
    0;

  /*
   * Select DNA-A/H when possible, otherwise DNA-A/W.
   */
  const geometry = selectPulseGeometry(dataset);

  /*
   * ----------------------------------------------------------
   * ELSE BRANCH — No pulse geometry exists
   * ----------------------------------------------------------
   *
   * Skip event-level singlet gating.
   * Preserve events that passed previous masks.
   * Recommend the optional aggregate model term.
   */
  if (!geometry) {
    return {
      singletMask: copyInputMask(
        eventCount,
        inputMask
      ),

      skipped: true,
      status: "no pulse geometry",
      geometryMode: null,
      secondaryChannelName: null,

      optionalAggregateTermRecommended: true,

      reason:
        "Neither DNA_H nor DNA_W was available."
    };
  }

  /*
   * Build the A-H or A-W point matrix.
   */
  const indexedPoints = buildPulseGeometryPoints(
    geometry.areaChannel,
    geometry.secondaryChannel,
    inputMask
  );

  /*
   * Skip fitting when too few usable events remain.
   */
  if (indexedPoints.length < minimumPoints) {
    return {
      singletMask: copyInputMask(
        eventCount,
        inputMask
      ),

      skipped: true,
      status: "insufficient pulse-geometry events",

      geometryMode: geometry.geometryMode,
      secondaryChannelName:
        geometry.secondaryChannelName,

      fittedEventCount: indexedPoints.length,

      optionalAggregateTermRecommended: true,

      reason:
        `Only ${indexedPoints.length} usable events were available.`
    };
  }

  /*
   * Fit the robust singlet ridge.
   */
  const points = indexedPoints.map(
    item => item.point
  );

  const ridge = fitRobustRidge2D(
    points,
    ridgeOptions
  );

  /*
   * Calculate orthogonal distances and create the mask.
   */
  const gateResult =
    createSingletMaskFromRidge(
      eventCount,
      indexedPoints,
      ridge,
      kMAD
    );

  return {
    singletMask: gateResult.singletMask,
    orthogonalDistance:
      gateResult.orthogonalDistance,
    distanceDeviation:
      gateResult.distanceDeviation,

    skipped: false,
    status: "singlet ridge fitted",

    geometryMode: geometry.geometryMode,
    secondaryChannelName:
      geometry.secondaryChannelName,

    ridgeCenter: ridge.center,
    ridgeDirection: ridge.direction,
    ridgeCovariance: ridge.covariance,

    distanceMedian: ridge.distanceMedian,
    distanceMAD: ridge.distanceMAD,

    kMAD,
    threshold: gateResult.threshold,

    fittedEventCount: indexedPoints.length,
    retainedSingletCount:
      gateResult.retainedSingletCount,

    converged: ridge.converged,
    iterations: ridge.iterations,

    optionalAggregateTermRecommended: false
  };
}


/* ============================================================
 * STEP 12 — Combine previous QC and gating masks
 * ============================================================
 *
 * Events must pass:
 *
 * 1. Structural QC
 * 2. Time QC
 * 3. FSC-A / SSC-A biological-cloud gate
 */

function combineMasks(...masks) {
  const validMasks = masks.filter(Boolean);

  if (validMasks.length === 0) {
    throw new Error(
      "At least one mask is required."
    );
  }

  const eventCount = validMasks[0].length;
  const combinedMask = new Uint8Array(eventCount);

  for (
    let eventIndex = 0;
    eventIndex < eventCount;
    eventIndex++
  ) {
    let retained = true;

    for (const mask of validMasks) {
      if (
        mask.length !== eventCount ||
        mask[eventIndex] === 0
      ) {
        retained = false;
        break;
      }
    }

    combinedMask[eventIndex] =
      retained ? 1 : 0;
  }

  return combinedMask;
}


/* ============================================================
 * STEP 13 — Run the singlet gate
 * ============================================================
 */

const preSingletMask = combineMasks(
  structuralMask,
  timeQCMask,
  scatterMask
);

const singletResult = gateByPulseGeometry(
  dataset,
  preSingletMask,
  {
    kMAD: 5,

    minimumPoints: 20,

    ridgeOptions: {
      maxIterations: 50,
      convergenceTolerance: 1e-7,
      huberConstant: 1.345,
      covarianceRegularization: 1e-9
    }
  }
);

const singletMask =
  singletResult.singletMask;


/* ============================================================
 * STEP 14 — Create the final event mask
 * ============================================================
 */

const finalMask = combineMasks(
  preSingletMask,
  singletMask
);


/* ============================================================
 * STEP 15 — Report diagnostics
 * ============================================================
 */

console.log(
  "Pulse geometry mode:",
  singletResult.geometryMode
);

console.log(
  "Singlet-gate status:",
  singletResult.status
);

console.log(
  "Ridge converged:",
  singletResult.converged
);

console.log(
  "Events used to fit ridge:",
  singletResult.fittedEventCount
);

console.log(
  "Events retained as singlets:",
  singletResult.retainedSingletCount
);

console.log(
  "Aggregate model term recommended:",
  singletResult.optionalAggregateTermRecommended
);
```

### Stage 4 | Step 6 Part  Build the 1D DNA-content histogram
Construct an evenly binned one-dimensional histogram from the cleaned singlet DNA values using a shared range across the experiment and a linear x-axis.

<u>Checklist</u>
- [ ] Create histogram using specified number of bins (256, 512, 1024)
- [ ] The y-axis for the entire plot should be specified as 0 to a max of the maximum value across the entire plot (across all bins)


<u>Sample JS code</u>
```js
function generateHistogram(
  events,
  channel = "DNA_A",
  binCount = 512,
  min = 0,
  max = 1000
) {
  const counts = new Uint32Array(binCount);
  const binWidth = (max - min) / binCount;

  for (const event of events) {
    const value = event[channel];

    if (!Number.isFinite(value) || value < min || value >= max) {
      continue;
    }

    const binIndex = Math.floor((value - min) / binWidth);
    counts[binIndex]++;
  }

  return {
    counts,
    min,
    max,
    binWidth,
    binCount
  };
}
```
### Stage 5 | Step 6  Part: Peak detection for G1 / G2M initial guesses (1C, 2C)
Then smooth lightly, detect prominent local maxima, and choose the lower/upper peak pair whose positions are closest to a 2:1 ratio.

**WARNING:** The tallest peak is not necessarily "G1" in synchronized yeast data, where a 2C-dominant sample is entirely plausible.

$$
\widetilde{H}(i)
=
\sum_j H(i-j)\,w_j,
\qquad
w_j \propto
e^{-j^2/(2\sigma_s^2)},
\qquad
i^*
\text{ such that }
\widetilde{H}(i^*)
\ge
\widetilde{H}(i^* \pm 1)
$$

| Term | Meaning |
|---|---|
| $\widetilde{H}(i)$ | Smoothed histogram value at bin $i$ |
| $H(i-j)$ | Original histogram value at the neighboring bin indexed by $i-j$ |
| $w_j$ | Gaussian smoothing weight applied at offset $j$ |
| $j$ | Offset from the current histogram bin |
| $\sigma_s$ | Gaussian smoothing bandwidth, measured in histogram bins |
| $i$ | Current histogram-bin index |
| $i^*$ | Bin index of a detected local maximum |
| $\mu_1$ | Initial estimate of the G1 peak mean |
| $R$ | Expected G2-to-G1 peak-position ratio, approximately $1.97$ |
| $R\mu_1$ | Expected G2/M peak position |
| $[1.8\mu_1,\,2.1\mu_1]$ | Search interval used to refine the G2/M peak estimate |

<u>Checklist</u>
- [ ] smooth lightly
- [ ] find local maxima
- [ ] remove peaks with small prominence
- [ ] score all lower/upper pairs with ratio near 2 and choose best pair 
* use lower peak as initial 1C mean
* use  upper peak as initial 2C mean


<u>Pseudocode</u>
```text
smooth lightly
find local maxima
remove peaks with small prominence
score all lower/upper pairs with ratio near 2
choose best pair
use lower peak as initial 1C mean
use upper peak as initial 2C mean
```


<u>Sample JS code</u>
```js
/**
 * Detect initial 1C and 2C DNA peak estimates from a 1D histogram.
 *
 * Assumptions:
 * - The histogram uses a linear DNA axis.
 * - The same histogram range is used across related samples.
 * - The expected 2C/1C ratio is approximately 2.
 *
 * Returns both:
 * - Peak bin indexes
 * - Peak positions in DNA-channel units
 */
function detectDNAContentPeaks(
  histogram,
  {
    sigma = 2,

    // Histogram-axis definition.
    histogramMin = 0,
    binWidth = 1,

    // Peak filtering.
    minProminence = null,
    minProminenceFraction = 0.02,

    // Expected 2C/1C relationship.
    targetRatio = 2.0,
    minimumRatio = 1.8,
    maximumRatio = 2.1,
    ratioSigma = 0.08
  } = {}
) {
  if (!histogram || histogram.length < 3) {
    throw new Error(
      "Histogram must contain at least three bins."
    );
  }

  if (!(sigma > 0)) {
    throw new Error(
      "Gaussian smoothing sigma must be greater than zero."
    );
  }

  if (!(binWidth > 0)) {
    throw new Error(
      "Histogram bin width must be greater than zero."
    );
  }

  const binCount = histogram.length;


  /* ============================================================
   * STEP 1 — Smooth the histogram lightly
   * ============================================================
   *
   * Construct a Gaussian kernel extending approximately
   * three standard deviations in each direction.
   */

  const kernelRadius = Math.ceil(3 * sigma);
  const kernel = [];

  for (
    let offset = -kernelRadius;
    offset <= kernelRadius;
    offset++
  ) {
    kernel.push(
      Math.exp(
        -(offset * offset) /
        (2 * sigma * sigma)
      )
    );
  }

  const smoothedHistogram =
    new Float64Array(binCount);

  for (let bin = 0; bin < binCount; bin++) {
    let weightedSum = 0;
    let localWeightSum = 0;

    for (
      let offset = -kernelRadius;
      offset <= kernelRadius;
      offset++
    ) {
      const neighboringBin = bin + offset;

      if (
        neighboringBin < 0 ||
        neighboringBin >= binCount
      ) {
        continue;
      }

      const weight =
        kernel[offset + kernelRadius];

      weightedSum +=
        histogram[neighboringBin] * weight;

      localWeightSum += weight;
    }

    smoothedHistogram[bin] =
      localWeightSum > 0
        ? weightedSum / localWeightSum
        : 0;
  }


  /* ============================================================
   * STEP 2 — Find local maxima
   * ============================================================
   *
   * Flat-topped peaks are collapsed into one peak positioned at
   * the center of the plateau.
   */

  const localMaxima = [];
  let bin = 1;

  while (bin < binCount - 1) {
    const current = smoothedHistogram[bin];
    const previous = smoothedHistogram[bin - 1];

    if (current <= previous) {
      bin++;
      continue;
    }

    let plateauEnd = bin;

    while (
      plateauEnd + 1 < binCount &&
      smoothedHistogram[plateauEnd + 1] === current
    ) {
      plateauEnd++;
    }

    const nextValue =
      plateauEnd + 1 < binCount
        ? smoothedHistogram[plateauEnd + 1]
        : -Infinity;

    if (current > nextValue) {
      const peakBin = Math.floor(
        (bin + plateauEnd) / 2
      );

      localMaxima.push({
        bin: peakBin,
        height: smoothedHistogram[peakBin]
      });
    }

    bin = plateauEnd + 1;
  }


  /* ============================================================
   * STEP 3 — Calculate each peak's prominence
   * ============================================================
   *
   * Prominence measures how far the peak rises above its
   * surrounding valleys.
   */

  function calculatePeakProminence(
    values,
    peakBin
  ) {
    const peakHeight = values[peakBin];

    let leftMinimum = peakHeight;

    for (
      let left = peakBin - 1;
      left >= 0;
      left--
    ) {
      leftMinimum = Math.min(
        leftMinimum,
        values[left]
      );

      /*
       * Stop once a higher peak or shoulder has been reached.
       */
      if (values[left] > peakHeight) {
        break;
      }
    }

    let rightMinimum = peakHeight;

    for (
      let right = peakBin + 1;
      right < values.length;
      right++
    ) {
      rightMinimum = Math.min(
        rightMinimum,
        values[right]
      );

      if (values[right] > peakHeight) {
        break;
      }
    }

    const referenceHeight = Math.max(
      leftMinimum,
      rightMinimum
    );

    return Math.max(
      0,
      peakHeight - referenceHeight
    );
  }

  const peaksWithProminence =
    localMaxima.map(peak => ({
      ...peak,

      prominence: calculatePeakProminence(
        smoothedHistogram,
        peak.bin
      )
    }));


  /* ============================================================
   * STEP 4 — Remove peaks with small prominence
   * ============================================================
   *
   * By default, require prominence of at least 2% of the tallest
   * smoothed histogram bin.
   */

  let maximumSmoothedHeight = 0;

  for (const value of smoothedHistogram) {
    maximumSmoothedHeight = Math.max(
      maximumSmoothedHeight,
      value
    );
  }

  const prominenceThreshold =
    Number.isFinite(minProminence)
      ? minProminence
      : minProminenceFraction *
        maximumSmoothedHeight;

  const retainedPeaks =
    peaksWithProminence.filter(
      peak =>
        peak.prominence >= prominenceThreshold
    );

  if (retainedPeaks.length < 2) {
    return {
      found: false,
      status:
        "Fewer than two sufficiently prominent peaks were found.",

      smoothedHistogram,
      allPeaks: peaksWithProminence,
      retainedPeaks,
      prominenceThreshold
    };
  }


  /* ============================================================
   * STEP 5 — Score all lower/upper peak pairs with ratio near 2
   * ============================================================
   *
   * Peak positions use bin centers:
   *
   * position = histogramMin + (bin + 0.5) × binWidth
   *
   * Pair scores favor:
   * - Two strong, prominent peaks
   * - A 2C/1C ratio close to targetRatio
   */

  function binCenter(binIndex) {
    return (
      histogramMin +
      (binIndex + 0.5) * binWidth
    );
  }

  const candidatePairs = [];

  for (
    let lowerIndex = 0;
    lowerIndex < retainedPeaks.length;
    lowerIndex++
  ) {
    const lowerPeak =
      retainedPeaks[lowerIndex];

    const lowerPosition =
      binCenter(lowerPeak.bin);

    if (!(lowerPosition > 0)) {
      continue;
    }

    for (
      let upperIndex = 0;
      upperIndex < retainedPeaks.length;
      upperIndex++
    ) {
      const upperPeak =
        retainedPeaks[upperIndex];

      if (upperPeak.bin <= lowerPeak.bin) {
        continue;
      }

      const upperPosition =
        binCenter(upperPeak.bin);

      const ratio =
        upperPosition / lowerPosition;

      if (
        ratio < minimumRatio ||
        ratio > maximumRatio
      ) {
        continue;
      }

      /*
       * Gaussian penalty for departure from the expected ratio.
       */
      const ratioDeviation =
        (ratio - targetRatio) / ratioSigma;

      const ratioWeight = Math.exp(
        -0.5 *
        ratioDeviation *
        ratioDeviation
      );

      /*
       * Include some peak height while placing more emphasis on
       * prominence. The geometric mean prevents one very strong
       * peak from completely compensating for one weak peak.
       */
      const lowerStrength =
        lowerPeak.prominence +
        0.25 * lowerPeak.height;

      const upperStrength =
        upperPeak.prominence +
        0.25 * upperPeak.height;

      const pairStrength = Math.sqrt(
        lowerStrength * upperStrength
      );

      const score =
        pairStrength * ratioWeight;

      candidatePairs.push({
        lowerPeak,
        upperPeak,
        lowerPosition,
        upperPosition,
        ratio,
        ratioWeight,
        score
      });
    }
  }

  if (candidatePairs.length === 0) {
    return {
      found: false,
      status:
        "No sufficiently prominent peak pair had an acceptable 2C/1C ratio.",

      smoothedHistogram,
      allPeaks: peaksWithProminence,
      retainedPeaks,
      prominenceThreshold,
      candidatePairs
    };
  }


  /* ============================================================
   * STEP 6 — Choose the best peak pair
   * ============================================================
   */

  candidatePairs.sort(
    (a, b) => b.score - a.score
  );

  const bestPair = candidatePairs[0];


  /* ============================================================
   * STEP 7 — Use the lower and upper peaks as initial means
   * ============================================================
   *
   * mu1 is the initial 1C/G1 mean.
   * mu2 is the initial 2C/G2-M mean.
   */

  return {
    found: true,
    status: "DNA peak pair found",

    mu1: bestPair.lowerPosition,
    mu2: bestPair.upperPosition,

    mu1Bin: bestPair.lowerPeak.bin,
    mu2Bin: bestPair.upperPeak.bin,

    ratio: bestPair.ratio,
    score: bestPair.score,

    lowerPeak: bestPair.lowerPeak,
    upperPeak: bestPair.upperPeak,

    smoothedHistogram,
    allPeaks: peaksWithProminence,
    retainedPeaks,
    candidatePairs,

    prominenceThreshold,

    settings: {
      sigma,
      histogramMin,
      binWidth,
      targetRatio,
      minimumRatio,
      maximumRatio
    }
  };
}


/* ============================================================
 * USAGE
 * ============================================================
 */

const peakResult = detectDNAContentPeaks(
  histogram.counts,
  {
    sigma: 2,

    histogramMin: histogram.min,
    binWidth: histogram.binWidth,

    minProminenceFraction: 0.02,

    targetRatio: 2.0,
    minimumRatio: 1.8,
    maximumRatio: 2.1
  }
);

if (peakResult.found) {
  console.log(
    "Initial 1C mean:",
    peakResult.mu1
  );

  console.log(
    "Initial 2C mean:",
    peakResult.mu2
  );

  console.log(
    "Observed 2C/1C ratio:",
    peakResult.ratio
  );
} else {
  console.warn(peakResult.status);
}
```



### Stage 6 | Step 7: Fit a transparent single-cycle DJF model
Fit the cleaned histogram with a single-cycle Dean-Jett-Fox model consisting of a 1C Gaussian, an S-phase component, and a 2C Gaussian.

$$
H_{\mathrm{cc}}(x)
=
G_1(x)
+
S(x)
+
G_2(x)
$$

The G1 and G2/M components are Gaussian peaks:

$$
G_1(x)
=
a_1
\exp\left[
-\frac{(x-\mu_1)^2}{2\sigma_1^2}
\right]
, 
G_2(x)
=
a_2
\exp\left[
-\frac{(x-\mu_2)^2}{2\sigma_2^2}
\right]
$$

The G2/M mean is constrained relative to the G1 mean:

$$
\mu_2 = R\mu_1
$$

The coefficient of variation is:

$$
\mathrm{CV}
=
100\frac{\sigma}{\mu}
$$

A common constraint is equal coefficients of variation for the two peaks:

$$
\mathrm{CV}_1
=
\mathrm{CV}_2
$$

The intrinsic S-phase rate function is represented by a second-order polynomial:

$$
s(x')
=
a + bx' + cx'^2
$$

The broadened S-phase distribution is:

$$
S(x)
=
\int_{\mu_1}^{\mu_2}
\left(
a + bx' + cx'^2
\right)
\frac{1}
{\sqrt{2\pi}\,\sigma(x')}
\exp\left[
-\frac{(x-x')^2}
{2\sigma(x')^2}
\right]
\,dx'
$$

The position-dependent broadening standard deviation is:

$$
\sigma(x')
=
\frac{\mathrm{CV}}{100}x'
$$

The Fox synchronous-S modification adds a Gaussian component to the S-phase polynomial:

$$
s_{\mathrm{Fox}}(x')
=
a + bx' + cx'^2
+
a_g
\exp\left[
-\frac{(x'-\mu_g)^2}
{2\sigma_g^2}
\right]
$$

For a first-order S-phase model:

$$
c = 0
$$

For a zero-order S-phase model:

$$
b = c = 0
$$

| Term | Meaning |
|---|---|
| $x$ | Continuous DNA-channel value at which the model is evaluated |
| $x'$ | Latent or intrinsic DNA-content value integrated over the S-phase interval |
| $H_{\mathrm{cc}}(x)$ | Complete modeled cell-cycle DNA distribution |
| $G_1(x)$ | Modeled G1 or 1C Gaussian component |
| $S(x)$ | Broadened S-phase component |
| $G_2(x)$ | Modeled G2/M or 2C Gaussian component |
| $a_1$ | Amplitude of the G1 peak |
| $a_2$ | Amplitude of the G2/M peak |
| $\mu_1$ | Mean DNA content of the G1 or 1C peak |
| $\mu_2$ | Mean DNA content of the G2/M or 2C peak |
| $\sigma_1$ | Standard deviation of the G1 peak |
| $\sigma_2$ | Standard deviation of the G2/M peak |
| $R$ | G2/M-to-G1 mean ratio, usually approximately $1.97$ |
| $\mathrm{CV}$ | Coefficient of variation, expressed as a percentage |
| $\mathrm{CV}_1$ | Coefficient of variation of the G1 peak |
| $\mathrm{CV}_2$ | Coefficient of variation of the G2/M peak |
| $s(x')$ | Intrinsic S-phase rate or density of cells synthesizing DNA at content $x'$ |
| $a$ | Constant coefficient of the S-phase polynomial |
| $b$ | Linear coefficient of the S-phase polynomial |
| $c$ | Quadratic coefficient of the S-phase polynomial |
| $\sigma(x')$ | Position-dependent broadening standard deviation at DNA content $x'$ |
| $a_g$ | Amplitude of the Fox synchronous-S Gaussian |
| $\mu_g$ | Mean of the Fox synchronous-S Gaussian |
| $\sigma_g$ | Standard deviation of the Fox synchronous-S Gaussian |


These values are starting guesses for the optimizer, calculated from the cleaned `DNA_A` histogram.

<u>Checklist</u>
- [ ] mu_1: The initial G1 mean is calculated from the center of the selected lower histogram bin.

$$ \mu_1 = x_{\min} + \left(i_1+\frac{1}{2}\right)\Delta x $$

- [ ] mu_2: The initial G2/M mean is calculated from the center of the selected upper histogram bin.

$$ \mu_2 = x_{\min} + \left(i_2+\frac{1}{2}\right)\Delta x $$

- [ ] R: The initial ratio is calculated directly from the detected peak positions.

$$ R = \frac{\mu_2}{\mu_1} $$

| Term | Meaning |
|---|---|
| $\mu_1$ | Initial mean DNA content of the G1 or 1C peak |
| $\mu_2$ | Initial mean DNA content of the G2/M or 2C peak |
| $x_{\min}$ | Lower bound of the DNA histogram |
| $i_1$ | Histogram-bin index of the selected G1 peak |
| $i_2$ | Histogram-bin index of the selected G2/M peak |
| $\Delta x$ | Width of one DNA histogram bin |
  
    
- [ ] sigma_1: Initial standard deviation of the G1 peak. Since its Gaussian standard deviation can be estimated from full width at half the max height

$$ \sigma_1 \approx \frac{\mathrm{FWHM}_1}{2\sqrt{2\ln 2}} $$


- [ ] sigma_2: Initial standard deviation of the G2 peak

$$ \sigma_2 \approx \frac{\mathrm{FWHM}_2}{2\sqrt{2\ln 2}} $$


- [ ] Initialize amplitudes from peak areas
  * When the Gaussian is parameterized by total area:

$$ G(x) = \frac{A}{\sigma\sqrt{2\pi}}\exp\left[-\frac{(x-\mu)^2}{2\sigma^2}\right] $$
- [ ] A_1: Initial amplitude for G1 from peak area

$$ A_1^{(0)} = \sum_{j\in W_1}\max\left(0,H_j-B_j\right) $$


- [ ] A_2: Initial amplitude for G2/M from peak area

$$ A_2^{(0)} = \sum_{j\in W_2}\max\left(0,H_j-B_j\right) $$

When the Gaussian is parameterized by total area:

$$ G(x) = a\exp\left[-\frac{(x-\mu)^2}{2\sigma^2}\right] $$

$$ a^{(0)} = H(\mu)-B(\mu) $$

- [ ] initialize S polynomial to nonnegative broad bridge
$$ s(x') = s_0+s_1x'+s_2x'^2 $$

$$ s_0^{(0)} = \max\left(\varepsilon,\frac{A_S^{(0)}}{\mu_2-\mu_1}\right) $$

$$ s_1^{(0)} = 0 $$

$$ s_2^{(0)} = 0 $$

- [ ] Initial S-phase residual

$$ r_j = \max\left(0,H_j-G_1(x_j)-G_2(x_j)\right) $$

$$ A_S^{(0)} = \sum_{\mu_1<x_j<\mu_2}r_j $$

| Initial value | Source |
|---|---|
| $\mu_1$ | DNA-axis position of the selected lower peak |
| $\mu_2$ | DNA-axis position of the selected upper peak |
| $R$ | Calculated as $\mu_2/\mu_1$ |
| $\sigma_1$ | Local G1 peak width, commonly $\mathrm{FWHM}_1/2.35482$ |
| $\sigma_2$ | Local G2/M peak width, commonly $\mathrm{FWHM}_2/2.35482$ |
| $\mathrm{CV}_{\mathrm{init}}$ | Average of the initial G1 and G2/M coefficients of variation |
| $A_1^{(0)}$ | Baseline-subtracted area around the G1 peak |
| $A_2^{(0)}$ | Baseline-subtracted area around the G2/M peak |
| $A_S^{(0)}$ | Nonnegative residual area between the two peaks |
| $s_0^{(0)}$ | Average residual density between $\mu_1$ and $\mu_2$ |
| $s_1^{(0)}$ | Initially set to $0$ |
| $s_2^{(0)}$ | Initially set to $0$ |



<u>Pseudocode</u>
```text
initialize mu1 and mu2 from peak detection
initialize R = mu2 / mu1
initialize sigma from local peak width
initialize amplitudes from peak areas
initialize S polynomial to nonnegative broad bridge

repeat until convergence:
    evaluate G1, S, G2 on histogram bins
    compute residuals
    update parameters with constrained nonlinear least squares
    enforce:
        amplitudes >= 0
        sigmas > 0
        sensible CV range
        mu2 = R * mu1
        R near 2 unless user unlocked it

return fitted parameters and fitted curve
```


<u>Sample JS code</u>
```js
"use strict";

/* ========================================================================== *
 * 1. DEFAULT FITTING OPTIONS
 * ========================================================================== */

const DEFAULT_OPTIONS = {
  // Peak detection uses a lightly smoothed copy of the histogram.
  smoothSigmaBins: 2,

  // Nonlinear least-squares settings.
  maxIterations: 150,
  tolerance: 1e-7,
  stepTolerance: 1e-6,
  initialLambda: 1e-2,
  finiteDifferenceStep: 1e-4,

  // Gaussian width constraints, expressed as coefficient of variation.
  cvMin: 0.01,
  cvMax: 0.20,

  // G2/G1 DNA-content ratio constraints.
  ratioTarget: 2.0,
  ratioMin: 1.70,
  ratioMax: 2.30,

  // false: R is fixed at ratioTarget.
  // true:  R is fitted between ratioMin and ratioMax.
  unlockRatio: false,

  // false: ordinary least squares.
  // true: approximately Poisson-weighted least squares.
  weightedResiduals: false,
};

/* ========================================================================== *
 * 2. PARAMETER ARRAY POSITIONS
 *
 * Parameter vector:
 *
 * [
 *   mu1,
 *   R,
 *   sigma1,
 *   sigma2,
 *   a1,
 *   a2,
 *   s0,
 *   s1,
 *   s2
 * ]
 *
 * mu2 is not stored independently:
 *
 *     mu2 = R * mu1
 * ========================================================================== */

const PARAMETER_INDEX = Object.freeze({
  MU1: 0,
  R: 1,
  SIGMA1: 2,
  SIGMA2: 3,
  A1: 4,
  A2: 5,
  S0: 6,
  S1: 7,
  S2: 8,
});

/* ========================================================================== *
 * 3. GENERAL NUMERICAL UTILITIES
 * ========================================================================== */

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function median(values) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return 0.5 * (sorted[middle - 1] + sorted[middle]);
  }

  return sorted[middle];
}

function maximumValue(values) {
  let maximum = -Infinity;

  for (const value of values) {
    if (value > maximum) {
      maximum = value;
    }
  }

  return maximum;
}

function sumSquares(values) {
  let total = 0;

  for (const value of values) {
    total += value * value;
  }

  return total;
}

function nearestIndex(x, target) {
  let bestIndex = 0;
  let bestDistance = Infinity;

  for (let i = 0; i < x.length; i += 1) {
    const distance = Math.abs(x[i] - target);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }

  return bestIndex;
}

/* ========================================================================== *
 * 4. GAUSSIAN HISTOGRAM SMOOTHING
 *
 * This is used only for initialization and peak detection.
 * The nonlinear fit itself still uses the original histogram.
 * ========================================================================== */

function gaussianSmooth(values, sigmaBins) {
  if (!(sigmaBins > 0)) {
    return [...values];
  }

  const radius = Math.max(1, Math.ceil(4 * sigmaBins));

  const kernel = [];
  let kernelSum = 0;

  for (let offset = -radius; offset <= radius; offset += 1) {
    const weight = Math.exp(
      -0.5 * (offset / sigmaBins) ** 2
    );

    kernel.push(weight);
    kernelSum += weight;
  }

  for (let i = 0; i < kernel.length; i += 1) {
    kernel[i] /= kernelSum;
  }

  const smoothed = new Array(values.length).fill(0);

  for (let i = 0; i < values.length; i += 1) {
    let weightedSum = 0;
    let usedWeight = 0;

    for (let offset = -radius; offset <= radius; offset += 1) {
      const sourceIndex = i + offset;

      if (
        sourceIndex < 0 ||
        sourceIndex >= values.length
      ) {
        continue;
      }

      const weight = kernel[offset + radius];

      weightedSum += values[sourceIndex] * weight;
      usedWeight += weight;
    }

    smoothed[i] =
      usedWeight > 0
        ? weightedSum / usedWeight
        : values[i];
  }

  return smoothed;
}

/* ========================================================================== *
 * 5. INITIALIZE mu1 AND mu2 FROM PEAK DETECTION
 * ========================================================================== */

function detectCandidatePeaks(x, y) {
  const maximum = maximumValue(y);

  // Ignore very small local maxima.
  const minimumHeight = maximum * 0.03;

  const peaks = [];

  for (let i = 1; i < y.length - 1; i += 1) {
    const isLocalMaximum =
      y[i] >= y[i - 1] &&
      y[i] > y[i + 1];

    if (
      isLocalMaximum &&
      y[i] >= minimumHeight
    ) {
      peaks.push({
        index: i,
        x: x[i],
        height: y[i],
      });
    }
  }

  // Fallback if no ordinary local maximum was found.
  if (peaks.length === 0) {
    let tallestIndex = 0;

    for (let i = 1; i < y.length; i += 1) {
      if (y[i] > y[tallestIndex]) {
        tallestIndex = i;
      }
    }

    peaks.push({
      index: tallestIndex,
      x: x[tallestIndex],
      height: y[tallestIndex],
    });
  }

  return peaks;
}

function chooseG1G2Peaks(x, y, options) {
  const peaks = detectCandidatePeaks(x, y);

  let bestPair = null;
  let bestScore = -Infinity;

  /*
   * Examine peak pairs whose DNA-content ratio is plausibly near 2.
   */
  for (const first of peaks) {
    if (!(first.x > 0)) {
      continue;
    }

    for (const second of peaks) {
      if (second.x <= first.x) {
        continue;
      }

      const ratio = second.x / first.x;

      if (ratio < 1.45 || ratio > 2.55) {
        continue;
      }

      /*
       * Prefer:
       *
       * 1. Two relatively prominent peaks.
       * 2. A ratio close to the expected G2/G1 ratio.
       */
      const ratioPenalty =
        6 * (ratio - options.ratioTarget) ** 2;

      const score =
        Math.log1p(first.height) +
        Math.log1p(second.height) -
        ratioPenalty;

      if (score > bestScore) {
        bestScore = score;

        bestPair = {
          first,
          second,
          detectedRatio: ratio,
        };
      }
    }
  }

  if (bestPair !== null) {
    return bestPair;
  }

  /*
   * Fallback:
   *
   * Use the tallest detected peak as G1, then search for the
   * tallest histogram value near 2 * mu1.
   */
  let first = peaks[0];

  for (const peak of peaks) {
    if (peak.height > first.height) {
      first = peak;
    }
  }

  const expectedG2 =
    options.ratioTarget * first.x;

  const lowerSearchBound =
    expectedG2 * 0.85;

  const upperSearchBound =
    expectedG2 * 1.15;

  let secondIndex =
    nearestIndex(x, expectedG2);

  let secondHeight =
    y[secondIndex];

  for (let i = 0; i < x.length; i += 1) {
    const insideSearchRange =
      x[i] >= lowerSearchBound &&
      x[i] <= upperSearchBound;

    if (
      insideSearchRange &&
      y[i] > secondHeight
    ) {
      secondIndex = i;
      secondHeight = y[i];
    }
  }

  const second = {
    index: secondIndex,
    x: x[secondIndex],
    height: y[secondIndex],
  };

  return {
    first,
    second,
    detectedRatio: second.x / first.x,
  };
}

/* ========================================================================== *
 * 6. INITIALIZE sigma FROM LOCAL PEAK WIDTH
 *
 * For a Gaussian:
 *
 *     sigma = FWHM / 2.35482
 * ========================================================================== */

function estimateSigmaFromPeakWidth(x, y, peakIndex) {
  const peakHeight = y[peakIndex];
  const halfHeight = 0.5 * peakHeight;

  let leftIndex = peakIndex;

  while (
    leftIndex > 0 &&
    y[leftIndex] > halfHeight
  ) {
    leftIndex -= 1;
  }

  let rightIndex = peakIndex;

  while (
    rightIndex < y.length - 1 &&
    y[rightIndex] > halfHeight
  ) {
    rightIndex += 1;
  }

  const measuredFwhm =
    Math.abs(x[rightIndex] - x[leftIndex]);

  /*
   * Make sure the initial width is not exactly zero if the peak is
   * narrower than one or two histogram bins.
   */
  const nearbyLeft =
    Math.max(0, peakIndex - 1);

  const nearbyRight =
    Math.min(x.length - 1, peakIndex + 1);

  const minimumFwhm =
    Math.abs(x[nearbyRight] - x[nearbyLeft]);

  const fwhm =
    Math.max(measuredFwhm, minimumFwhm);

  return fwhm / 2.354820045;
}

/* ========================================================================== *
 * 7. INITIALIZE AMPLITUDES FROM LOCAL PEAK AREAS
 * ========================================================================== */

function estimatePeakArea(x, y, mu, sigma) {
  const lowerBound = mu - 2.5 * sigma;
  const upperBound = mu + 2.5 * sigma;

  const selectedIndices = [];

  for (let i = 0; i < x.length; i += 1) {
    if (
      x[i] >= lowerBound &&
      x[i] <= upperBound
    ) {
      selectedIndices.push(i);
    }
  }

  /*
   * Fallback for a very narrow region.
   */
  if (selectedIndices.length < 2) {
    const peakIndex = nearestIndex(x, mu);

    return (
      y[peakIndex] *
      sigma *
      Math.sqrt(2 * Math.PI)
    );
  }

  /*
   * Estimate a local baseline from the edges of the peak window.
   */
  const edgeValues = [
    y[selectedIndices[0]],
    y[selectedIndices[Math.min(1, selectedIndices.length - 1)]],
    y[selectedIndices[Math.max(0, selectedIndices.length - 2)]],
    y[selectedIndices[selectedIndices.length - 1]],
  ];

  const baseline =
    Math.max(0, median(edgeValues));

  /*
   * Trapezoidal integration after removing the local baseline.
   */
  let area = 0;

  for (
    let selectedPosition = 1;
    selectedPosition < selectedIndices.length;
    selectedPosition += 1
  ) {
    const previousIndex =
      selectedIndices[selectedPosition - 1];

    const currentIndex =
      selectedIndices[selectedPosition];

    const previousHeight =
      Math.max(0, y[previousIndex] - baseline);

    const currentHeight =
      Math.max(0, y[currentIndex] - baseline);

    const binWidth =
      x[currentIndex] - x[previousIndex];

    area +=
      0.5 *
      (previousHeight + currentHeight) *
      binWidth;
  }

  return Math.max(area, 0);
}

/* ========================================================================== *
 * 8. GAUSSIAN G1 AND G2 PEAK FUNCTION
 *
 * amplitude is the peak height, not the integrated area.
 * ========================================================================== */

function gaussianPeakHeight(
  xValue,
  mu,
  sigma,
  amplitude
) {
  const z =
    (xValue - mu) / sigma;

  return (
    amplitude *
    Math.exp(-0.5 * z * z)
  );
}

/* ========================================================================== *
 * 9. INITIALIZE THE NONNEGATIVE S-PHASE BRIDGE
 * ========================================================================== */

function initializeSBridge(
  x,
  y,
  parameters
) {
  const mu1 =
    parameters[PARAMETER_INDEX.MU1];

  const ratio =
    parameters[PARAMETER_INDEX.R];

  const sigma1 =
    parameters[PARAMETER_INDEX.SIGMA1];

  const sigma2 =
    parameters[PARAMETER_INDEX.SIGMA2];

  const a1 =
    parameters[PARAMETER_INDEX.A1];

  const a2 =
    parameters[PARAMETER_INDEX.A2];

  const mu2 =
    ratio * mu1;

  const leftValues = [];
  const middleValues = [];
  const rightValues = [];

  for (let i = 0; i < x.length; i += 1) {
    if (
      x[i] <= mu1 ||
      x[i] >= mu2
    ) {
      continue;
    }

    const t =
      (x[i] - mu1) /
      (mu2 - mu1);

    const estimatedG1 =
      gaussianPeakHeight(
        x[i],
        mu1,
        sigma1,
        a1
      );

    const estimatedG2 =
      gaussianPeakHeight(
        x[i],
        mu2,
        sigma2,
        a2
      );

    const remainingHeight =
      Math.max(
        0,
        y[i] - estimatedG1 - estimatedG2
      );

    if (t < 1 / 3) {
      leftValues.push(remainingHeight);
    } else if (t < 2 / 3) {
      middleValues.push(remainingHeight);
    } else {
      rightValues.push(remainingHeight);
    }
  }

  const broadLevel = Math.max(
    0,
    median([
      ...leftValues,
      ...middleValues,
      ...rightValues,
    ])
  );

  /*
   * Initialize a broad bridge rather than three isolated spikes.
   */
  const s0 = Math.max(
    median(leftValues),
    0.5 * broadLevel
  );

  const s1 = Math.max(
    median(middleValues),
    broadLevel
  );

  const s2 = Math.max(
    median(rightValues),
    0.5 * broadLevel
  );

  return [s0, s1, s2];
}

/* ========================================================================== *
 * 10. COMPLETE PARAMETER INITIALIZATION
 * ========================================================================== */

function initializeParameters(
  x,
  y,
  options
) {
  const smoothedHistogram =
    gaussianSmooth(
      y,
      options.smoothSigmaBins
    );

  const {
    first,
    second,
    detectedRatio,
  } = chooseG1G2Peaks(
    x,
    smoothedHistogram,
    options
  );

  /*
   * Initialize mu1 and mu2 from detected peaks.
   */
  const mu1 =
    first.x;

  let ratio =
    detectedRatio;

  let mu2 =
    second.x;

  /*
   * Lock the ratio at 2 unless the user explicitly unlocks it.
   */
  if (!options.unlockRatio) {
    ratio =
      options.ratioTarget;

    mu2 =
      ratio * mu1;
  }

  /*
   * Initialize sigmas from local peak widths.
   */
  let sigma1 =
    estimateSigmaFromPeakWidth(
      x,
      smoothedHistogram,
      first.index
    );

  let sigma2 =
    estimateSigmaFromPeakWidth(
      x,
      smoothedHistogram,
      second.index
    );

  /*
   * Enforce sensible initial coefficients of variation.
   */
  sigma1 = clamp(
    sigma1,
    options.cvMin * mu1,
    options.cvMax * mu1
  );

  sigma2 = clamp(
    sigma2,
    options.cvMin * mu2,
    options.cvMax * mu2
  );

  /*
   * Estimate Gaussian areas, then convert areas into peak heights:
   *
   *     area = amplitude * sigma * sqrt(2*pi)
   */
  const area1 =
    estimatePeakArea(
      x,
      smoothedHistogram,
      mu1,
      sigma1
    );

  const area2 =
    estimatePeakArea(
      x,
      smoothedHistogram,
      mu2,
      sigma2
    );

  const normalization1 =
    sigma1 * Math.sqrt(2 * Math.PI);

  const normalization2 =
    sigma2 * Math.sqrt(2 * Math.PI);

  const areaDerivedA1 =
    area1 / normalization1;

  const areaDerivedA2 =
    area2 / normalization2;

  /*
   * Use the larger of:
   *
   * 1. The detected local peak height.
   * 2. The height derived from the integrated peak area.
   */
  const a1 = Math.max(
    first.height,
    areaDerivedA1,
    0
  );

  const a2 = Math.max(
    second.height,
    areaDerivedA2,
    0
  );

  const parameters = [
    mu1,
    ratio,
    sigma1,
    sigma2,
    a1,
    a2,
    0,
    0,
    0,
  ];

  /*
   * Initialize the S-phase polynomial as a nonnegative broad bridge.
   */
  const [s0, s1, s2] =
    initializeSBridge(
      x,
      smoothedHistogram,
      parameters
    );

  parameters[PARAMETER_INDEX.S0] = s0;
  parameters[PARAMETER_INDEX.S1] = s1;
  parameters[PARAMETER_INDEX.S2] = s2;

  return {
    parameters,

    detectedPeaks: {
      g1Index: first.index,
      g2Index: second.index,
      detectedMu1: first.x,
      detectedMu2: second.x,
      detectedRatio,
    },

    smoothedHistogram,
  };
}

/* ========================================================================== *
 * 11. NONNEGATIVE S-PHASE POLYNOMIAL
 *
 * Let:
 *
 *     t = (x - mu1) / (mu2 - mu1)
 *
 * The central polynomial is a quadratic Bernstein polynomial:
 *
 *     P(t) =
 *         s0(1-t)^2
 *       + 2s1t(1-t)
 *       + s2t^2
 *
 * If s0, s1, and s2 are nonnegative, P(t) is nonnegative.
 *
 * The factor:
 *
 *     4t(1-t)
 *
 * smoothly forces the S component to zero at mu1 and mu2.
 * ========================================================================== */

function evaluateSBridge(
  xValue,
  mu1,
  mu2,
  s0,
  s1,
  s2
) {
  if (
    xValue <= mu1 ||
    xValue >= mu2
  ) {
    return 0;
  }

  const t =
    (xValue - mu1) /
    (mu2 - mu1);

  const oneMinusT =
    1 - t;

  const positivePolynomial =
    s0 * oneMinusT * oneMinusT +
    2 * s1 * t * oneMinusT +
    s2 * t * t;

  const bridgeWindow =
    4 * t * oneMinusT;

  return (
    bridgeWindow *
    positivePolynomial
  );
}

/* ========================================================================== *
 * 12. EVALUATE G1, S, AND G2 ON EVERY HISTOGRAM BIN
 * ========================================================================== */

function evaluateModel(
  x,
  parameters
) {
  const mu1 =
    parameters[PARAMETER_INDEX.MU1];

  const ratio =
    parameters[PARAMETER_INDEX.R];

  const sigma1 =
    parameters[PARAMETER_INDEX.SIGMA1];

  const sigma2 =
    parameters[PARAMETER_INDEX.SIGMA2];

  const a1 =
    parameters[PARAMETER_INDEX.A1];

  const a2 =
    parameters[PARAMETER_INDEX.A2];

  const s0 =
    parameters[PARAMETER_INDEX.S0];

  const s1 =
    parameters[PARAMETER_INDEX.S1];

  const s2 =
    parameters[PARAMETER_INDEX.S2];

  /*
   * Enforce the dependent-mean relationship.
   */
  const mu2 =
    ratio * mu1;

  const g1 = new Array(x.length);
  const s = new Array(x.length);
  const g2 = new Array(x.length);
  const fitted = new Array(x.length);

  for (let i = 0; i < x.length; i += 1) {
    g1[i] =
      gaussianPeakHeight(
        x[i],
        mu1,
        sigma1,
        a1
      );

    s[i] =
      evaluateSBridge(
        x[i],
        mu1,
        mu2,
        s0,
        s1,
        s2
      );

    g2[i] =
      gaussianPeakHeight(
        x[i],
        mu2,
        sigma2,
        a2
      );

    fitted[i] =
      g1[i] +
      s[i] +
      g2[i];
  }

  return {
    g1,
    s,
    g2,
    fitted,
  };
}

/* ========================================================================== *
 * 13. ENFORCE PARAMETER CONSTRAINTS
 *
 * Enforces:
 *
 *     amplitudes >= 0
 *     sigmas > 0
 *     cvMin <= sigma / mu <= cvMax
 *     mu2 = R * mu1
 *     R = 2 when locked
 *     ratioMin <= R <= ratioMax when unlocked
 *     S coefficients >= 0
 * ========================================================================== */

function projectParameters(
  parameters,
  x,
  options
) {
  const projected =
    [...parameters];

  const xMinimum =
    x[0];

  const xMaximum =
    x[x.length - 1];

  const xSpan =
    Math.max(
      xMaximum - xMinimum,
      Number.EPSILON
    );

  /*
   * Lock R at ratioTarget unless explicitly unlocked.
   */
  const ratio =
    options.unlockRatio
      ? clamp(
          projected[PARAMETER_INDEX.R],
          options.ratioMin,
          options.ratioMax
        )
      : options.ratioTarget;

  /*
   * mu1 must remain inside the histogram, and mu2 = R * mu1
   * must also remain inside the histogram.
   */
  const minimumMu1 = Math.max(
    xMinimum + 1e-6 * xSpan,
    Number.EPSILON
  );

  const maximumMu1 = Math.max(
    minimumMu1,
    (xMaximum - 1e-6 * xSpan) / ratio
  );

  const mu1 = clamp(
    projected[PARAMETER_INDEX.MU1],
    minimumMu1,
    maximumMu1
  );

  const mu2 =
    ratio * mu1;

  projected[PARAMETER_INDEX.MU1] =
    mu1;

  projected[PARAMETER_INDEX.R] =
    ratio;

  /*
   * Keep sigma positive and inside the requested CV range.
   */
  projected[PARAMETER_INDEX.SIGMA1] =
    clamp(
      Math.abs(
        projected[PARAMETER_INDEX.SIGMA1]
      ),
      options.cvMin * mu1,
      options.cvMax * mu1
    );

  projected[PARAMETER_INDEX.SIGMA2] =
    clamp(
      Math.abs(
        projected[PARAMETER_INDEX.SIGMA2]
      ),
      options.cvMin * mu2,
      options.cvMax * mu2
    );

  /*
   * Enforce nonnegative Gaussian amplitudes and S coefficients.
   */
  const nonnegativeIndices = [
    PARAMETER_INDEX.A1,
    PARAMETER_INDEX.A2,
    PARAMETER_INDEX.S0,
    PARAMETER_INDEX.S1,
    PARAMETER_INDEX.S2,
  ];

  for (const index of nonnegativeIndices) {
    projected[index] =
      Math.max(0, projected[index]);
  }

  return projected;
}

/* ========================================================================== *
 * 14. COMPUTE RESIDUALS
 *
 * Residual convention:
 *
 *     residual = fitted - observed
 * ========================================================================== */

function computeResiduals(
  x,
  y,
  parameters,
  options
) {
  const model =
    evaluateModel(
      x,
      parameters
    );

  const residuals =
    new Array(y.length);

  for (let i = 0; i < y.length; i += 1) {
    const rawResidual =
      model.fitted[i] - y[i];

    residuals[i] =
      options.weightedResiduals
        ? rawResidual /
          Math.sqrt(Math.max(y[i], 1))
        : rawResidual;
  }

  return {
    residuals,
    model,
  };
}

/* ========================================================================== *
 * 15. FINITE-DIFFERENCE JACOBIAN
 *
 * J[row][column] approximates:
 *
 *     d residual[row] / d parameter[column]
 * ========================================================================== */

function buildJacobian(
  x,
  y,
  parameters,
  baseResiduals,
  freeParameterIndices,
  options
) {
  const jacobian =
    Array.from(
      { length: y.length },
      () =>
        new Array(
          freeParameterIndices.length
        ).fill(0)
    );

  for (
    let column = 0;
    column < freeParameterIndices.length;
    column += 1
  ) {
    const parameterIndex =
      freeParameterIndices[column];

    const currentValue =
      parameters[parameterIndex];

    const requestedStep =
      options.finiteDifferenceStep *
      Math.max(
        Math.abs(currentValue),
        1
      );

    const perturbedParameters =
      [...parameters];

    perturbedParameters[parameterIndex] +=
      requestedStep;

    /*
     * Projection ensures that finite-difference evaluations also
     * obey the model constraints.
     */
    const projectedPerturbation =
      projectParameters(
        perturbedParameters,
        x,
        options
      );

    const actualStep =
      projectedPerturbation[parameterIndex] -
      parameters[parameterIndex];

    /*
     * A projected parameter may be stuck against a constraint.
     */
    if (
      Math.abs(actualStep) <
      Number.EPSILON
    ) {
      continue;
    }

    const {
      residuals: perturbedResiduals,
    } = computeResiduals(
      x,
      y,
      projectedPerturbation,
      options
    );

    for (
      let row = 0;
      row < y.length;
      row += 1
    ) {
      jacobian[row][column] =
        (
          perturbedResiduals[row] -
          baseResiduals[row]
        ) /
        actualStep;
    }
  }

  return jacobian;
}

/* ========================================================================== *
 * 16. BUILD LEVENBERG-MARQUARDT NORMAL EQUATIONS
 *
 * Solve:
 *
 *     (J'J + lambda D) delta = -J'r
 * ========================================================================== */

function buildNormalEquations(
  jacobian,
  residuals,
  lambda
) {
  const parameterCount =
    jacobian[0].length;

  const jtj =
    Array.from(
      { length: parameterCount },
      () =>
        new Array(parameterCount).fill(0)
    );

  const jtr =
    new Array(parameterCount).fill(0);

  for (
    let row = 0;
    row < jacobian.length;
    row += 1
  ) {
    for (
      let j = 0;
      j < parameterCount;
      j += 1
    ) {
      const derivativeJ =
        jacobian[row][j];

      jtr[j] +=
        derivativeJ * residuals[row];

      for (
        let k = j;
        k < parameterCount;
        k += 1
      ) {
        jtj[j][k] +=
          derivativeJ *
          jacobian[row][k];
      }
    }
  }

  /*
   * Copy the upper triangle into the lower triangle.
   */
  for (
    let j = 0;
    j < parameterCount;
    j += 1
  ) {
    for (
      let k = 0;
      k < j;
      k += 1
    ) {
      jtj[j][k] =
        jtj[k][j];
    }

    /*
     * Marquardt damping scaled by local curvature.
     */
    jtj[j][j] +=
      lambda *
      Math.max(jtj[j][j], 1);
  }

  return {
    matrix: jtj,

    rightHandSide:
      jtr.map(
        (value) => -value
      ),
  };
}

/* ========================================================================== *
 * 17. SOLVE A SMALL DENSE LINEAR SYSTEM
 *
 * Gaussian elimination with partial pivoting.
 * ========================================================================== */

function solveLinearSystem(
  matrix,
  vector
) {
  const size =
    vector.length;

  const augmented =
    matrix.map(
      (row, rowIndex) => [
        ...row,
        vector[rowIndex],
      ]
    );

  for (
    let pivot = 0;
    pivot < size;
    pivot += 1
  ) {
    /*
     * Find the strongest available pivot.
     */
    let largestRow =
      pivot;

    for (
      let row = pivot + 1;
      row < size;
      row += 1
    ) {
      if (
        Math.abs(augmented[row][pivot]) >
        Math.abs(augmented[largestRow][pivot])
      ) {
        largestRow = row;
      }
    }

    if (
      Math.abs(
        augmented[largestRow][pivot]
      ) < 1e-14
    ) {
      throw new Error(
        "The optimizer produced a singular normal-equation matrix."
      );
    }

    /*
     * Move the strongest pivot into the current row.
     */
    [
      augmented[pivot],
      augmented[largestRow],
    ] = [
      augmented[largestRow],
      augmented[pivot],
    ];

    /*
     * Normalize the pivot row.
     */
    const pivotValue =
      augmented[pivot][pivot];

    for (
      let column = pivot;
      column <= size;
      column += 1
    ) {
      augmented[pivot][column] /=
        pivotValue;
    }

    /*
     * Eliminate this column from every other row.
     */
    for (
      let row = 0;
      row < size;
      row += 1
    ) {
      if (row === pivot) {
        continue;
      }

      const factor =
        augmented[row][pivot];

      for (
        let column = pivot;
        column <= size;
        column += 1
      ) {
        augmented[row][column] -=
          factor *
          augmented[pivot][column];
      }
    }
  }

  return augmented.map(
    (row) => row[size]
  );
}

/* ========================================================================== *
 * 18. CONSTRAINED NONLINEAR LEAST-SQUARES LOOP
 *
 * repeat until convergence:
 *
 *     evaluate G1, S, G2
 *     compute residuals
 *     calculate parameter update
 *     project parameters onto constraints
 *     accept or reject the update
 * ========================================================================== */

function fitWithLevenbergMarquardt(
  x,
  y,
  initialParameters,
  options
) {
  let parameters =
    projectParameters(
      initialParameters,
      x,
      options
    );

  let lambda =
    options.initialLambda;

  let converged =
    false;

  let iteration =
    0;

  /*
   * R is omitted from the free parameters when it is locked.
   */
  const freeParameterIndices = [
    PARAMETER_INDEX.MU1,

    ...(
      options.unlockRatio
        ? [PARAMETER_INDEX.R]
        : []
    ),

    PARAMETER_INDEX.SIGMA1,
    PARAMETER_INDEX.SIGMA2,
    PARAMETER_INDEX.A1,
    PARAMETER_INDEX.A2,
    PARAMETER_INDEX.S0,
    PARAMETER_INDEX.S1,
    PARAMETER_INDEX.S2,
  ];

  let current =
    computeResiduals(
      x,
      y,
      parameters,
      options
    );

  let currentSse =
    sumSquares(
      current.residuals
    );

  for (
    iteration = 1;
    iteration <= options.maxIterations;
    iteration += 1
  ) {
    /*
     * Evaluate the local slope of the residuals with respect
     * to each free parameter.
     */
    const jacobian =
      buildJacobian(
        x,
        y,
        parameters,
        current.residuals,
        freeParameterIndices,
        options
      );

    const {
      matrix,
      rightHandSide,
    } = buildNormalEquations(
      jacobian,
      current.residuals,
      lambda
    );

    let delta;

    try {
      delta =
        solveLinearSystem(
          matrix,
          rightHandSide
        );
    } catch {
      /*
       * A singular step generally means that more damping is needed.
       */
      lambda =
        Math.min(
          lambda * 10,
          1e12
        );

      continue;
    }

    /*
     * Apply the proposed LM parameter update.
     */
    const trialParameters =
      [...parameters];

    for (
      let j = 0;
      j < freeParameterIndices.length;
      j += 1
    ) {
      const parameterIndex =
        freeParameterIndices[j];

      trialParameters[parameterIndex] +=
        delta[j];
    }

    /*
     * Enforce all constraints before evaluating the trial.
     */
    const projectedTrial =
      projectParameters(
        trialParameters,
        x,
        options
      );

    const trial =
      computeResiduals(
        x,
        y,
        projectedTrial,
        options
      );

    const trialSse =
      sumSquares(
        trial.residuals
      );

    /*
     * Accept only steps that improve the least-squares objective.
     */
    if (
      Number.isFinite(trialSse) &&
      trialSse < currentSse
    ) {
      const relativeImprovement =
        (
          currentSse -
          trialSse
        ) /
        Math.max(currentSse, 1);

      let relativeStep =
        0;

      for (
        const parameterIndex
        of freeParameterIndices
      ) {
        const stepSize =
          Math.abs(
            projectedTrial[parameterIndex] -
            parameters[parameterIndex]
          ) /
          Math.max(
            Math.abs(parameters[parameterIndex]),
            1
          );

        relativeStep =
          Math.max(
            relativeStep,
            stepSize
          );
      }

      parameters =
        projectedTrial;

      current =
        trial;

      currentSse =
        trialSse;

      /*
       * Successful step: use less damping.
       */
      lambda =
        Math.max(
          lambda / 3,
          1e-12
        );

      /*
       * Stop when either:
       *
       * 1. The SSE barely improves.
       * 2. The parameter vector barely changes.
       */
      if (
        relativeImprovement <
          options.tolerance ||
        relativeStep <
          options.stepTolerance
      ) {
        converged = true;
        break;
      }
    } else {
      /*
       * Rejected step: use more damping.
       */
      lambda =
        Math.min(
          lambda * 10,
          1e12
        );
    }
  }

  return {
    parameters,
    model: current.model,
    residuals: current.residuals,
    sse: currentSse,
    iterations: iteration,
    converged,
    finalLambda: lambda,
  };
}

/* ========================================================================== *
 * 19. VALIDATE USER INPUT
 * ========================================================================== */

function validateHistogramInput(
  x,
  y
) {
  if (
    !Array.isArray(x) ||
    !Array.isArray(y)
  ) {
    throw new TypeError(
      "x and y must both be arrays."
    );
  }

  if (
    x.length !== y.length ||
    x.length < 10
  ) {
    throw new RangeError(
      "x and y must have the same length and contain at least 10 bins."
    );
  }

  for (
    let i = 0;
    i < x.length;
    i += 1
  ) {
    if (
      !Number.isFinite(x[i])
    ) {
      throw new RangeError(
        `x[${i}] is not finite.`
      );
    }

    if (
      !Number.isFinite(y[i]) ||
      y[i] < 0
    ) {
      throw new RangeError(
        `y[${i}] must be finite and nonnegative.`
      );
    }

    if (
      i > 0 &&
      x[i] <= x[i - 1]
    ) {
      throw new RangeError(
        "x must be strictly increasing."
      );
    }
  }
}

/* ========================================================================== *
 * 20. PUBLIC CELL-CYCLE FITTING FUNCTION
 * ========================================================================== */

function fitCellCycleHistogram(
  x,
  y,
  userOptions = {}
) {
  validateHistogramInput(
    x,
    y
  );

  const options = {
    ...DEFAULT_OPTIONS,
    ...userOptions,
  };

  if (
    !(options.cvMin > 0) ||
    !(options.cvMax >= options.cvMin)
  ) {
    throw new RangeError(
      "cvMin must be positive and cvMax must be greater than or equal to cvMin."
    );
  }

  if (
    !(options.ratioTarget > 1) ||
    !(options.ratioMin > 1) ||
    !(options.ratioMax >= options.ratioMin)
  ) {
    throw new RangeError(
      "The G2/G1 ratio settings are invalid."
    );
  }

  /*
   * Initialize:
   *
   *     mu1 and mu2 from peak detection
   *     R = mu2 / mu1
   *     sigmas from local widths
   *     amplitudes from peak areas
   *     S as a nonnegative broad bridge
   */
  const initialization =
    initializeParameters(
      x,
      y,
      options
    );

  /*
   * Run constrained nonlinear least squares.
   */
  const fit =
    fitWithLevenbergMarquardt(
      x,
      y,
      initialization.parameters,
      options
    );

  const parameters =
    fit.parameters;

  const mu1 =
    parameters[PARAMETER_INDEX.MU1];

  const ratio =
    parameters[PARAMETER_INDEX.R];

  const mu2 =
    ratio * mu1;

  const sigma1 =
    parameters[PARAMETER_INDEX.SIGMA1];

  const sigma2 =
    parameters[PARAMETER_INDEX.SIGMA2];

  return {
    parameters: {
      mu1,
      mu2,
      R: ratio,

      sigma1,
      sigma2,

      cv1:
        sigma1 / mu1,

      cv2:
        sigma2 / mu2,

      a1:
        parameters[PARAMETER_INDEX.A1],

      a2:
        parameters[PARAMETER_INDEX.A2],

      s0:
        parameters[PARAMETER_INDEX.S0],

      s1:
        parameters[PARAMETER_INDEX.S1],

      s2:
        parameters[PARAMETER_INDEX.S2],
    },

    curves: {
      x: [...x],
      observed: [...y],

      g1:
        fit.model.g1,

      s:
        fit.model.s,

      g2:
        fit.model.g2,

      fitted:
        fit.model.fitted,

      residuals:
        fit.residuals,
    },

    diagnostics: {
      converged:
        fit.converged,

      iterations:
        fit.iterations,

      sse:
        fit.sse,

      finalLambda:
        fit.finalLambda,

      detectedPeaks:
        initialization.detectedPeaks,

      ratioWasUnlocked:
        options.unlockRatio,

      options,
    },
  };
}

/* ========================================================================== *
 * 21. ES-MODULE EXPORT
 * ========================================================================== */

export {
  fitCellCycleHistogram,
};

/* ========================================================================== *
 * 22. EXAMPLE USAGE
 * ========================================================================== */

/*
import {
  fitCellCycleHistogram,
} from "./djf-histogram-fitter.js";

const result =
  fitCellCycleHistogram(
    histogramBinCenters,
    histogramCounts,
    {
      // Keep G2 at exactly twice the G1 mean.
      unlockRatio: false,

      // Allowed Gaussian coefficients of variation.
      cvMin: 0.01,
      cvMax: 0.20,

      maxIterations: 150,

      // Set true if variance grows roughly with histogram counts.
      weightedResiduals: false,
    }
  );

console.log(
  result.parameters
);

console.log(
  result.diagnostics
);

// Arrays available for plotting:
//
// result.curves.x
// result.curves.observed
// result.curves.g1
// result.curves.s
// result.curves.g2
// result.curves.fitted
// result.curves.residuals
*/
```


### Stage 7 | Step 8: If the single-cycle fit leaves systematic residuals consistent with aggregates, near-zero debris, or both, refit using transparent additive contamination terms. 

The FULL model adds debris and aggregate terms:

$H(i)=G_1(i)+S(i)+G_2(i)+\mathrm{Debris}(i)+\mathrm{Aggregates}(i)$

<br />

#### 7a. Aggregates by self-convolution

Let $Y$ be the current non-aggregated distribution (cell cycle only). Then

$D(i)=p\,(Y*Y)(i)=p\sum_{j+\ell=i}Y(j)Y(\ell)$

$T(i)=2p^2(D*Y)(i)$

$Q(i)=4p^3(D*D)(i)+6p^3(T*Y)(i)$

$\mathrm{Aggregates}(i)=D(i)+T(i)+Q(i)$

<br />

#### 7b. Debris by sliced-nucleus model (Bagwell 1991)

Debris extends only leftward ($x<y$). A cube approximation gives a flat kernel $K(x\mid y)=\mathrm{const}$; the sphere/ellipsoid (Bagwell) model gives a random planar cut of a sphere of radius $R$ producing cap volume

$V_{\mathrm{cap}}=\frac{\pi}{3}h^2(3R-h)$

yielding a concave fragment distribution skewed to smaller fragments, with cut probability proportional to nuclear radius $\propto (\mathrm{DNA})^{1/3}$. The single-cut (SC) discrete kernel is

$\mathrm{Debris}_{\mathrm{SC}}(x)=\mathrm{SCaP}\sum_{j>x}j^{1/3}Y(j)P_s(j,x)$

$P_s(j,x)=\frac{2}{\pi j\sqrt{(x/j)(1-x/j)}}$

and the multiple-cut (MC) kernel is

$\mathrm{Debris}_{\mathrm{MC}}(x)=\mathrm{MCaP}\,e^{-\lambda x}\sum_{j>x}Y(j)$

An optional trailing exponential $Ae^{-\lambda x}$ absorbs degradation debris.

## Variables

| Variable | Meaning |
|---|---|
| $H(i)$ | Total modeled histogram count at channel $i$ |
| $G_1(i)$ | G1 component at channel $i$ |
| $S(i)$ | S-phase component at channel $i$ |
| $G_2(i)$ | G2 component at channel $i$ |
| $\mathrm{Debris}(i)$ | Debris contribution at channel $i$ |
| $\mathrm{Aggregates}(i)$ | Aggregate contribution at channel $i$ |
| $Y$ | Current non-aggregated (cell-cycle) distribution |
| $*$ | Discrete convolution |
| $p$ | Pairwise adhesion probability (single free parameter for aggregation) |
| $D(i)$ | Doublet distribution |
| $T(i)$ | Triplet distribution |
| $Q(i)$ | Quadruplet distribution |
| $i$ | Histogram channel index |
| $j,\ell$ | Source-channel indices used in convolution |
| $Y(j)$ | Counts at source channel $j$ |
| $\mathrm{SCaP}$ | Single-cut amplitude parameter |
| $\mathrm{MCaP}$ | Multiple-cut amplitude parameter |
| $\lambda$ | Exponential decay rate |
| $P_s(j,x)$ | Single-cut fragment-size probability (arcsine/U-shape) |
| $j^{1/3}$ | Cube-root size weight (radius $\propto \mathrm{DNA}^{1/3}$) |
| $R$ | Sphere radius |
| $h$ | Cap height |
| $V_{\mathrm{cap}}$ | Cap volume |
| $A$ | Trailing-exponential amplitude |
| $x$ | Debris-fragment channel |
| $y$ | Original nucleus channel, with $x<y$ |
| $K(x\mid y)$ | Debris kernel for fragment channel $x$ given original channel $y$ |
| $\mathrm{DNA}$ | DNA content |

<br />
<u>Checklist</u>

- [ ] Inspect residuals after DJF fit from Stage 6
- [ ] Consider aggregate correction: if residuals show excess near 2C multiples **add aggregate term with parameter p**
- [ ] Consider debris correction: if residuals show excess near zero and left shoulder **add debris term**
- [ ] If we are adding components refit all parameters jointly
- [ ] Compare fit quality and residual structure
- [ ] Keep simpler model unless extending it materially imrpoves it.

<br />

<u>Pseudocode</u>
```text
fit single-cycle DJF
inspect residuals

if residuals show excess near 2C multiples:
    add aggregate term with parameter p

if residuals show excess near zero and left shoulder:
    add debris term

refit all parameters jointly
compare fit quality and residual structure
keep simpler model unless extension materially improves fit
```


<u>Sample JS code</u>
```js
"use strict";

/* ========================================================================== *
 * 1. DEFAULT OPTIONS
 * ========================================================================== */

const DEFAULT_EXTENSION_OPTIONS = {
  // Keep these consistent with the original fitter.
  cvMin: 0.01,
  cvMax: 0.20,

  ratioTarget: 2.0,
  ratioMin: 1.70,
  ratioMax: 2.30,
  unlockRatio: false,

  // Residual-pattern detection thresholds.
  aggregateDetectionZ: 2.5,
  debrisDetectionZ: 2.5,
  minimumTemplateCorrelation: 0.20,

  // Joint nonlinear least-squares settings.
  maxIterations: 150,
  tolerance: 1e-7,
  stepTolerance: 1e-6,
  initialLambda: 1e-2,
  finiteDifferenceStep: 1e-4,

  // false: ordinary least squares.
  // true: approximate Poisson-weighted least squares.
  weightedResiduals: false,

  // Maximum allowed aggregate fraction.
  aggregateMaxFraction: 1.0,

  // Debris decay-length constraints relative to mu1.
  debrisTauMinFraction: 0.02,
  debrisTauMaxFraction: 0.75,

  // Conservative model-selection thresholds.
  minRelativeSseImprovement: 0.02,
  minBicImprovement: 6.0,
  minTargetResidualImprovement: 0.20,
};

/* ========================================================================== *
 * 2. PARAMETER POSITIONS
 *
 * Full parameter vector:
 *
 * [
 *   mu1,
 *   R,
 *   sigma1,
 *   sigma2,
 *   a1,
 *   a2,
 *   s0,
 *   s1,
 *   s2,
 *   pAggregate,
 *   debrisAmplitude,
 *   debrisTau
 * ]
 *
 * mu2 is always derived:
 *
 *     mu2 = R * mu1
 * ========================================================================== */

const INDEX = Object.freeze({
  MU1: 0,
  R: 1,

  SIGMA1: 2,
  SIGMA2: 3,

  A1: 4,
  A2: 5,

  S0: 6,
  S1: 7,
  S2: 8,

  P_AGGREGATE: 9,

  DEBRIS_AMPLITUDE: 10,
  DEBRIS_TAU: 11,
});

/* ========================================================================== *
 * 3. CANDIDATE MODEL DEFINITIONS
 * ========================================================================== */

const MODEL_FLAGS = Object.freeze({
  BASE: Object.freeze({
    aggregate: false,
    debris: false,
  }),

  AGGREGATE: Object.freeze({
    aggregate: true,
    debris: false,
  }),

  DEBRIS: Object.freeze({
    aggregate: false,
    debris: true,
  }),

  BOTH: Object.freeze({
    aggregate: true,
    debris: true,
  }),
});

/* ========================================================================== *
 * 4. GENERAL NUMERICAL UTILITIES
 * ========================================================================== */

function clamp(value, minimum, maximum) {
  return Math.min(
    maximum,
    Math.max(minimum, value)
  );
}

function sumSquares(values) {
  let total = 0;

  for (const value of values) {
    total += value * value;
  }

  return total;
}

function median(values) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort(
    (a, b) => a - b
  );

  const middle = Math.floor(
    sorted.length / 2
  );

  if (sorted.length % 2 === 0) {
    return (
      0.5 *
      (
        sorted[middle - 1] +
        sorted[middle]
      )
    );
  }

  return sorted[middle];
}

/* ========================================================================== *
 * 5. ROBUST RESIDUAL SCALE
 *
 * Uses the median absolute deviation:
 *
 *     residualScale = 1.4826 * MAD
 * ========================================================================== */

function robustResidualScale(residuals) {
  const center = median(residuals);

  const absoluteDeviations =
    residuals.map(
      (value) =>
        Math.abs(value - center)
    );

  const mad =
    median(absoluteDeviations);

  return Math.max(
    1.4826 * mad,
    1e-12
  );
}

/* ========================================================================== *
 * 6. POSITIVE TEMPLATE CORRELATION
 *
 * This measures whether unexplained observed excess follows the shape of
 * an aggregate or debris template.
 * ========================================================================== */

function normalizedPositiveCorrelation(
  values,
  template
) {
  let dot = 0;
  let valueNorm = 0;
  let templateNorm = 0;

  for (
    let i = 0;
    i < values.length;
    i += 1
  ) {
    const positiveValue =
      Math.max(0, values[i]);

    const positiveTemplate =
      Math.max(0, template[i]);

    dot +=
      positiveValue *
      positiveTemplate;

    valueNorm +=
      positiveValue *
      positiveValue;

    templateNorm +=
      positiveTemplate *
      positiveTemplate;
  }

  if (
    valueNorm === 0 ||
    templateNorm === 0
  ) {
    return 0;
  }

  return (
    dot /
    Math.sqrt(
      valueNorm *
      templateNorm
    )
  );
}

/* ========================================================================== *
 * 7. GAUSSIAN G1 AND G2 PEAKS
 * ========================================================================== */

function gaussianPeak(
  xValue,
  mu,
  sigma,
  amplitude
) {
  const z =
    (xValue - mu) / sigma;

  return (
    amplitude *
    Math.exp(-0.5 * z * z)
  );
}

/* ========================================================================== *
 * 8. NONNEGATIVE S-PHASE BRIDGE
 * ========================================================================== */

function evaluateSBridge(
  xValue,
  mu1,
  mu2,
  s0,
  s1,
  s2
) {
  if (
    xValue <= mu1 ||
    xValue >= mu2
  ) {
    return 0;
  }

  const t =
    (xValue - mu1) /
    (mu2 - mu1);

  const oneMinusT =
    1 - t;

  const nonnegativePolynomial =
    s0 *
      oneMinusT *
      oneMinusT +
    2 *
      s1 *
      t *
      oneMinusT +
    s2 *
      t *
      t;

  const bridgeWindow =
    4 *
    t *
    oneMinusT;

  return (
    bridgeWindow *
    nonnegativePolynomial
  );
}

/* ========================================================================== *
 * 9. EVALUATE THE BASE G1 + S + G2 MODEL AT ONE x VALUE
 * ========================================================================== */

function evaluateBaseAt(
  xValue,
  parameters
) {
  const mu1 =
    parameters[INDEX.MU1];

  const ratio =
    parameters[INDEX.R];

  const mu2 =
    ratio * mu1;

  const g1 =
    gaussianPeak(
      xValue,
      mu1,
      parameters[INDEX.SIGMA1],
      parameters[INDEX.A1]
    );

  const s =
    evaluateSBridge(
      xValue,
      mu1,
      mu2,
      parameters[INDEX.S0],
      parameters[INDEX.S1],
      parameters[INDEX.S2]
    );

  const g2 =
    gaussianPeak(
      xValue,
      mu2,
      parameters[INDEX.SIGMA2],
      parameters[INDEX.A2]
    );

  return {
    g1,
    s,
    g2,
    total:
      g1 +
      s +
      g2,
  };
}

/* ========================================================================== *
 * 10. AGGREGATE TERM
 *
 * The aggregate curve is a DNA-doubled copy of the current singlet model:
 *
 *     A(x) = p * 0.5 * F(x / 2)
 *
 * where:
 *
 *     p = fitted aggregate fraction
 *     F = fitted G1 + S + G2 singlet curve
 *
 * The factor 0.5 corrects the density after doubling the x-axis.
 * ========================================================================== */

function evaluateAggregateAt(
  xValue,
  parameters
) {
  const p =
    parameters[
      INDEX.P_AGGREGATE
    ];

  if (!(p > 0)) {
    return 0;
  }

  const doubledSource =
    evaluateBaseAt(
      xValue / 2,
      parameters
    ).total;

  return (
    0.5 *
    p *
    doubledSource
  );
}

/* ========================================================================== *
 * 11. STABLE LOGISTIC FUNCTION
 * ========================================================================== */

function logistic(value) {
  if (value >= 0) {
    const expNegative =
      Math.exp(-value);

    return (
      1 /
      (1 + expNegative)
    );
  }

  const expPositive =
    Math.exp(value);

  return (
    expPositive /
    (1 + expPositive)
  );
}

/* ========================================================================== *
 * 12. DEBRIS TERM
 *
 * Debris is represented by an exponentially decreasing left-edge component:
 *
 *     D(x)
 *       =
 *       d
 *       exp(-(x - xmin) / tau)
 *       L(x)
 *
 * where:
 *
 *     d   = debris amplitude
 *     tau = debris decay length
 *     L   = smooth cutoff before G1
 * ========================================================================== */

function evaluateDebrisAt(
  xValue,
  xMinimum,
  parameters
) {
  const amplitude =
    parameters[
      INDEX.DEBRIS_AMPLITUDE
    ];

  const tau =
    parameters[
      INDEX.DEBRIS_TAU
    ];

  if (
    !(amplitude > 0) ||
    !(tau > 0)
  ) {
    return 0;
  }

  const mu1 =
    parameters[INDEX.MU1];

  const sigma1 =
    parameters[INDEX.SIGMA1];

  const distanceFromLeft =
    Math.max(
      0,
      xValue - xMinimum
    );

  const decay =
    Math.exp(
      -distanceFromLeft /
      tau
    );

  /*
   * Keep the debris term on the low-DNA side and prevent it from
   * absorbing the G1 peak.
   */
  const cutoffCenter =
    mu1 - sigma1;

  const cutoffWidth =
    Math.max(
      0.25 * sigma1,
      1e-12
    );

  const leftWindow =
    logistic(
      (
        cutoffCenter -
        xValue
      ) /
      cutoffWidth
    );

  return (
    amplitude *
    decay *
    leftWindow
  );
}

/* ========================================================================== *
 * 13. EVALUATE AN ENTIRE CANDIDATE MODEL
 * ========================================================================== */

function evaluateCandidateModel(
  x,
  parameters,
  flags
) {
  const xMinimum =
    x[0];

  const g1 =
    new Array(x.length);

  const s =
    new Array(x.length);

  const g2 =
    new Array(x.length);

  const aggregate =
    new Array(x.length).fill(0);

  const debris =
    new Array(x.length).fill(0);

  const fitted =
    new Array(x.length);

  for (
    let i = 0;
    i < x.length;
    i += 1
  ) {
    const base =
      evaluateBaseAt(
        x[i],
        parameters
      );

    g1[i] =
      base.g1;

    s[i] =
      base.s;

    g2[i] =
      base.g2;

    if (flags.aggregate) {
      aggregate[i] =
        evaluateAggregateAt(
          x[i],
          parameters
        );
    }

    if (flags.debris) {
      debris[i] =
        evaluateDebrisAt(
          x[i],
          xMinimum,
          parameters
        );
    }

    fitted[i] =
      g1[i] +
      s[i] +
      g2[i] +
      aggregate[i] +
      debris[i];
  }

  return {
    g1,
    s,
    g2,
    aggregate,
    debris,
    fitted,
  };
}

/* ========================================================================== *
 * 14. CONVERT THE PREVIOUS FIT INTO AN INITIAL PARAMETER VECTOR
 * ========================================================================== */

function parametersFromPreviousFit(
  previousFit,
  x,
  y
) {
  const source =
    previousFit.parameters;

  if (!source) {
    throw new TypeError(
      "previousFit.parameters is required."
    );
  }

  const mu1 =
    source.mu1;

  const ratio =
    source.R ??
    (
      source.mu2 /
      source.mu1
    );

  if (
    !Number.isFinite(mu1) ||
    !Number.isFinite(ratio)
  ) {
    throw new RangeError(
      "The previous fit does not contain valid mu1 and R values."
    );
  }

  const residuals =
    previousFit
      .curves
      ?.residuals;

  let initialDebrisAmplitude =
    0;

  /*
   * Because residual = fitted - observed, negative residuals indicate
   * unexplained observed signal.
   */
  if (
    Array.isArray(residuals)
  ) {
    for (
      let i = 0;
      i < x.length;
      i += 1
    ) {
      const insideDebrisRegion =
        x[i] <
        mu1 -
        2 * source.sigma1;

      if (insideDebrisRegion) {
        initialDebrisAmplitude =
          Math.max(
            initialDebrisAmplitude,
            Math.max(
              0,
              -residuals[i]
            )
          );
      }
    }
  } else {
    let maximumCount = 0;

    for (const count of y) {
      maximumCount =
        Math.max(
          maximumCount,
          count
        );
    }

    initialDebrisAmplitude =
      0.01 *
      maximumCount;
  }

  return [
    source.mu1,
    ratio,

    source.sigma1,
    source.sigma2,

    source.a1,
    source.a2,

    source.s0,
    source.s1,
    source.s2,

    // Initial aggregate fraction.
    0.05,

    // Initial debris amplitude.
    initialDebrisAmplitude,

    // Initial debris decay length.
    0.20 * mu1,
  ];
}

/* ========================================================================== *
 * 15. ENFORCE PARAMETER CONSTRAINTS
 * ========================================================================== */

function projectParameters(
  parameters,
  x,
  options,
  flags
) {
  const projected =
    [...parameters];

  const xMinimum =
    x[0];

  const xMaximum =
    x[x.length - 1];

  const xSpan =
    Math.max(
      xMaximum - xMinimum,
      Number.EPSILON
    );

  /*
   * Keep R fixed near 2 unless explicitly unlocked.
   */
  const ratio =
    options.unlockRatio
      ? clamp(
          projected[INDEX.R],
          options.ratioMin,
          options.ratioMax
        )
      : options.ratioTarget;

  /*
   * Ensure both mu1 and mu2 remain inside the histogram range.
   */
  const minimumMu1 =
    Math.max(
      xMinimum +
        1e-6 * xSpan,
      Number.EPSILON
    );

  const maximumMu1 =
    Math.max(
      minimumMu1,
      (
        xMaximum -
        1e-6 * xSpan
      ) /
      ratio
    );

  const mu1 =
    clamp(
      projected[INDEX.MU1],
      minimumMu1,
      maximumMu1
    );

  const mu2 =
    ratio * mu1;

  projected[INDEX.MU1] =
    mu1;

  projected[INDEX.R] =
    ratio;

  /*
   * Enforce positive Gaussian widths and sensible CV ranges.
   */
  projected[INDEX.SIGMA1] =
    clamp(
      Math.abs(
        projected[
          INDEX.SIGMA1
        ]
      ),
      options.cvMin * mu1,
      options.cvMax * mu1
    );

  projected[INDEX.SIGMA2] =
    clamp(
      Math.abs(
        projected[
          INDEX.SIGMA2
        ]
      ),
      options.cvMin * mu2,
      options.cvMax * mu2
    );

  /*
   * Enforce nonnegative amplitudes and S-phase coefficients.
   */
  const nonnegativeIndices = [
    INDEX.A1,
    INDEX.A2,
    INDEX.S0,
    INDEX.S1,
    INDEX.S2,
  ];

  for (
    const index
    of nonnegativeIndices
  ) {
    projected[index] =
      Math.max(
        0,
        projected[index]
      );
  }

  /*
   * Enable or disable the aggregate parameter.
   */
  projected[
    INDEX.P_AGGREGATE
  ] =
    flags.aggregate
      ? clamp(
          projected[
            INDEX.P_AGGREGATE
          ],
          0,
          options
            .aggregateMaxFraction
        )
      : 0;

  /*
   * Enable or disable the debris parameters.
   */
  projected[
    INDEX.DEBRIS_AMPLITUDE
  ] =
    flags.debris
      ? Math.max(
          0,
          projected[
            INDEX.DEBRIS_AMPLITUDE
          ]
        )
      : 0;

  projected[
    INDEX.DEBRIS_TAU
  ] =
    flags.debris
      ? clamp(
          Math.abs(
            projected[
              INDEX.DEBRIS_TAU
            ]
          ),
          options
            .debrisTauMinFraction *
            mu1,
          options
            .debrisTauMaxFraction *
            mu1
        )
      : 0.20 * mu1;

  return projected;
}

/* ========================================================================== *
 * 16. COMPUTE RESIDUALS
 *
 * Residual convention:
 *
 *     residual = fitted - observed
 * ========================================================================== */

function computeResiduals(
  x,
  y,
  parameters,
  options,
  flags
) {
  const model =
    evaluateCandidateModel(
      x,
      parameters,
      flags
    );

  const rawResiduals =
    new Array(y.length);

  const objectiveResiduals =
    new Array(y.length);

  for (
    let i = 0;
    i < y.length;
    i += 1
  ) {
    const raw =
      model.fitted[i] -
      y[i];

    rawResiduals[i] =
      raw;

    objectiveResiduals[i] =
      options.weightedResiduals
        ? raw /
          Math.sqrt(
            Math.max(y[i], 1)
          )
        : raw;
  }

  return {
    model,
    rawResiduals,
    objectiveResiduals,
  };
}

/* ========================================================================== *
 * 17. INSPECT RESIDUALS FOR AGGREGATE AND DEBRIS PATTERNS
 * ========================================================================== */

function inspectResidualStructure(
  x,
  y,
  previousFit,
  options
) {
  const residuals =
    previousFit
      .curves
      ?.residuals;

  const parameters =
    parametersFromPreviousFit(
      previousFit,
      x,
      y
    );

  if (
    !Array.isArray(residuals) ||
    residuals.length !== x.length
  ) {
    throw new RangeError(
      "previousFit.curves.residuals must exist and match the histogram length."
    );
  }

  const residualScale =
    robustResidualScale(
      residuals
    );

  /*
   * Convert negative residuals into positive unexplained observed excess.
   */
  const observedExcess =
    residuals.map(
      (value) =>
        Math.max(
          0,
          -value
        )
    );

  /*
   * Aggregate detection template:
   *
   *     0.5 * F(x / 2)
   */
  const aggregateTemplate =
    x.map(
      (xValue) =>
        0.5 *
        evaluateBaseAt(
          xValue / 2,
          parameters
        ).total
    );

  const mu1 =
    parameters[INDEX.MU1];

  const sigma1 =
    parameters[INDEX.SIGMA1];

  /*
   * Debris detection template:
   *
   * Exponential signal concentrated below the G1 left shoulder.
   */
  const debrisTemplate =
    x.map(
      (xValue) => {
        if (
          xValue >=
          mu1 - sigma1
        ) {
          return 0;
        }

        return Math.exp(
          -Math.max(
            0,
            xValue - x[0]
          ) /
          (0.20 * mu1)
        );
      }
    );

  const aggregateCorrelation =
    normalizedPositiveCorrelation(
      observedExcess,
      aggregateTemplate
    );

  const debrisCorrelation =
    normalizedPositiveCorrelation(
      observedExcess,
      debrisTemplate
    );

  let aggregateWeightedExcess =
    0;

  let aggregateWeight =
    0;

  let debrisWeightedExcess =
    0;

  let debrisWeight =
    0;

  for (
    let i = 0;
    i < x.length;
    i += 1
  ) {
    const aggregateWeightAtBin =
      aggregateTemplate[i];

    const debrisWeightAtBin =
      debrisTemplate[i];

    aggregateWeightedExcess +=
      observedExcess[i] *
      aggregateWeightAtBin;

    aggregateWeight +=
      aggregateWeightAtBin;

    debrisWeightedExcess +=
      observedExcess[i] *
      debrisWeightAtBin;

    debrisWeight +=
      debrisWeightAtBin;
  }

  const aggregateExcessZ =
    aggregateWeight > 0
      ? (
          aggregateWeightedExcess /
          aggregateWeight /
          residualScale
        )
      : 0;

  const debrisExcessZ =
    debrisWeight > 0
      ? (
          debrisWeightedExcess /
          debrisWeight /
          residualScale
        )
      : 0;

  const aggregateDetected =
    aggregateExcessZ >=
      options.aggregateDetectionZ &&
    aggregateCorrelation >=
      options.minimumTemplateCorrelation;

  const debrisDetected =
    debrisExcessZ >=
      options.debrisDetectionZ &&
    debrisCorrelation >=
      options.minimumTemplateCorrelation;

  return {
    aggregateDetected,
    debrisDetected,

    residualScale,

    aggregateExcessZ,
    debrisExcessZ,

    aggregateCorrelation,
    debrisCorrelation,

    templates: {
      aggregate:
        aggregateTemplate,

      debris:
        debrisTemplate,
    },
  };
}

/* ========================================================================== *
 * 18. DETERMINE WHICH PARAMETERS ARE FREE
 * ========================================================================== */

function getFreeParameterIndices(
  options,
  flags
) {
  const indices = [
    INDEX.MU1,
  ];

  if (options.unlockRatio) {
    indices.push(
      INDEX.R
    );
  }

  indices.push(
    INDEX.SIGMA1,
    INDEX.SIGMA2,

    INDEX.A1,
    INDEX.A2,

    INDEX.S0,
    INDEX.S1,
    INDEX.S2
  );

  if (flags.aggregate) {
    indices.push(
      INDEX.P_AGGREGATE
    );
  }

  if (flags.debris) {
    indices.push(
      INDEX.DEBRIS_AMPLITUDE,
      INDEX.DEBRIS_TAU
    );
  }

  return indices;
}

/* ========================================================================== *
 * 19. FINITE-DIFFERENCE JACOBIAN
 * ========================================================================== */

function buildJacobian(
  x,
  y,
  parameters,
  baseResiduals,
  freeParameterIndices,
  options,
  flags
) {
  const jacobian =
    Array.from(
      {
        length: y.length,
      },
      () =>
        new Array(
          freeParameterIndices.length
        ).fill(0)
    );

  for (
    let column = 0;
    column <
      freeParameterIndices.length;
    column += 1
  ) {
    const parameterIndex =
      freeParameterIndices[
        column
      ];

    const currentValue =
      parameters[
        parameterIndex
      ];

    const requestedStep =
      options
        .finiteDifferenceStep *
      Math.max(
        Math.abs(currentValue),
        1
      );

    const perturbed =
      [...parameters];

    perturbed[
      parameterIndex
    ] += requestedStep;

    const projected =
      projectParameters(
        perturbed,
        x,
        options,
        flags
      );

    const actualStep =
      projected[
        parameterIndex
      ] -
      parameters[
        parameterIndex
      ];

    /*
     * A parameter may be stuck against a constraint.
     */
    if (
      Math.abs(actualStep) <
      Number.EPSILON
    ) {
      continue;
    }

    const trialResiduals =
      computeResiduals(
        x,
        y,
        projected,
        options,
        flags
      ).objectiveResiduals;

    for (
      let row = 0;
      row < y.length;
      row += 1
    ) {
      jacobian[row][column] =
        (
          trialResiduals[row] -
          baseResiduals[row]
        ) /
        actualStep;
    }
  }

  return jacobian;
}

/* ========================================================================== *
 * 20. BUILD LEVENBERG-MARQUARDT NORMAL EQUATIONS
 *
 * Solve:
 *
 *     (J'J + lambda D) delta = -J'r
 * ========================================================================== */

function buildNormalEquations(
  jacobian,
  residuals,
  lambda
) {
  const parameterCount =
    jacobian[0].length;

  const matrix =
    Array.from(
      {
        length:
          parameterCount,
      },
      () =>
        new Array(
          parameterCount
        ).fill(0)
    );

  const gradient =
    new Array(
      parameterCount
    ).fill(0);

  for (
    let row = 0;
    row < jacobian.length;
    row += 1
  ) {
    for (
      let j = 0;
      j < parameterCount;
      j += 1
    ) {
      gradient[j] +=
        jacobian[row][j] *
        residuals[row];

      for (
        let k = j;
        k < parameterCount;
        k += 1
      ) {
        matrix[j][k] +=
          jacobian[row][j] *
          jacobian[row][k];
      }
    }
  }

  /*
   * Fill the lower triangle and add LM damping.
   */
  for (
    let j = 0;
    j < parameterCount;
    j += 1
  ) {
    for (
      let k = 0;
      k < j;
      k += 1
    ) {
      matrix[j][k] =
        matrix[k][j];
    }

    matrix[j][j] +=
      lambda *
      Math.max(
        matrix[j][j],
        1
      );
  }

  return {
    matrix,

    rightHandSide:
      gradient.map(
        (value) => -value
      ),
  };
}

/* ========================================================================== *
 * 21. SOLVE A SMALL DENSE LINEAR SYSTEM
 *
 * Gaussian elimination with partial pivoting.
 * ========================================================================== */

function solveLinearSystem(
  matrix,
  vector
) {
  const size =
    vector.length;

  const augmented =
    matrix.map(
      (row, index) => [
        ...row,
        vector[index],
      ]
    );

  for (
    let pivot = 0;
    pivot < size;
    pivot += 1
  ) {
    let strongestRow =
      pivot;

    for (
      let row = pivot + 1;
      row < size;
      row += 1
    ) {
      if (
        Math.abs(
          augmented[row][pivot]
        ) >
        Math.abs(
          augmented[
            strongestRow
          ][pivot]
        )
      ) {
        strongestRow =
          row;
      }
    }

    if (
      Math.abs(
        augmented[
          strongestRow
        ][pivot]
      ) <
      1e-14
    ) {
      throw new Error(
        "Singular normal-equation matrix."
      );
    }

    [
      augmented[pivot],
      augmented[
        strongestRow
      ],
    ] = [
      augmented[
        strongestRow
      ],
      augmented[pivot],
    ];

    const pivotValue =
      augmented[pivot][pivot];

    for (
      let column = pivot;
      column <= size;
      column += 1
    ) {
      augmented[pivot][column] /=
        pivotValue;
    }

    for (
      let row = 0;
      row < size;
      row += 1
    ) {
      if (row === pivot) {
        continue;
      }

      const factor =
        augmented[row][pivot];

      for (
        let column = pivot;
        column <= size;
        column += 1
      ) {
        augmented[row][column] -=
          factor *
          augmented[pivot][column];
      }
    }
  }

  return augmented.map(
    (row) => row[size]
  );
}

/* ========================================================================== *
 * 22. JOINTLY REFIT ALL BASE AND EXTENSION PARAMETERS
 * ========================================================================== */

function fitCandidateModel(
  x,
  y,
  initialParameters,
  options,
  flags
) {
  let parameters =
    projectParameters(
      initialParameters,
      x,
      options,
      flags
    );

  let lambda =
    options.initialLambda;

  let converged =
    false;

  let iteration =
    0;

  const freeParameterIndices =
    getFreeParameterIndices(
      options,
      flags
    );

  let current =
    computeResiduals(
      x,
      y,
      parameters,
      options,
      flags
    );

  let currentSse =
    sumSquares(
      current
        .objectiveResiduals
    );

  for (
    iteration = 1;
    iteration <=
      options.maxIterations;
    iteration += 1
  ) {
    /*
     * Recalculate derivatives for all currently active parameters.
     */
    const jacobian =
      buildJacobian(
        x,
        y,
        parameters,
        current
          .objectiveResiduals,
        freeParameterIndices,
        options,
        flags
      );

    const {
      matrix,
      rightHandSide,
    } =
      buildNormalEquations(
        jacobian,
        current
          .objectiveResiduals,
        lambda
      );

    let delta;

    try {
      delta =
        solveLinearSystem(
          matrix,
          rightHandSide
        );
    } catch {
      /*
       * More damping may resolve a singular or unstable step.
       */
      lambda =
        Math.min(
          lambda * 10,
          1e12
        );

      continue;
    }

    const trialParameters =
      [...parameters];

    for (
      let j = 0;
      j <
        freeParameterIndices.length;
      j += 1
    ) {
      const parameterIndex =
        freeParameterIndices[j];

      trialParameters[
        parameterIndex
      ] += delta[j];
    }

    /*
     * Enforce constraints before evaluating the proposed fit.
     */
    const projectedTrial =
      projectParameters(
        trialParameters,
        x,
        options,
        flags
      );

    const trial =
      computeResiduals(
        x,
        y,
        projectedTrial,
        options,
        flags
      );

    const trialSse =
      sumSquares(
        trial
          .objectiveResiduals
      );

    /*
     * Accept only improvements.
     */
    if (
      Number.isFinite(
        trialSse
      ) &&
      trialSse <
        currentSse
    ) {
      const relativeImprovement =
        (
          currentSse -
          trialSse
        ) /
        Math.max(
          currentSse,
          1
        );

      let relativeStep =
        0;

      for (
        const parameterIndex
        of freeParameterIndices
      ) {
        const step =
          Math.abs(
            projectedTrial[
              parameterIndex
            ] -
            parameters[
              parameterIndex
            ]
          ) /
          Math.max(
            Math.abs(
              parameters[
                parameterIndex
              ]
            ),
            1
          );

        relativeStep =
          Math.max(
            relativeStep,
            step
          );
      }

      parameters =
        projectedTrial;

      current =
        trial;

      currentSse =
        trialSse;

      /*
       * Successful step: reduce damping.
       */
      lambda =
        Math.max(
          lambda / 3,
          1e-12
        );

      if (
        relativeImprovement <
          options.tolerance ||
        relativeStep <
          options.stepTolerance
      ) {
        converged = true;
        break;
      }
    } else {
      /*
       * Failed step: increase damping.
       */
      lambda =
        Math.min(
          lambda * 10,
          1e12
        );
    }
  }

  return {
    flags,
    parameters,

    model:
      current.model,

    rawResiduals:
      current.rawResiduals,

    objectiveResiduals:
      current
        .objectiveResiduals,

    sse:
      currentSse,

    parameterCount:
      freeParameterIndices.length,

    iterations:
      iteration,

    converged,

    finalLambda:
      lambda,
  };
}

/* ========================================================================== *
 * 23. BAYESIAN INFORMATION CRITERION
 *
 * Lower BIC is better:
 *
 *     BIC = n ln(SSE / n) + k ln(n)
 *
 * where:
 *
 *     n = number of histogram bins
 *     k = number of fitted parameters
 * ========================================================================== */

function calculateBic(
  sse,
  observationCount,
  parameterCount
) {
  const safeSse =
    Math.max(
      sse,
      1e-12
    );

  return (
    observationCount *
      Math.log(
        safeSse /
        observationCount
      ) +
    parameterCount *
      Math.log(
        observationCount
      )
  );
}

/* ========================================================================== *
 * 24. MEASURE TARGETED RESIDUAL STRUCTURE
 *
 * This measures remaining negative residual energy specifically where the
 * aggregate or debris component should appear.
 * ========================================================================== */

function targetedResidualEnergy(
  x,
  residuals,
  parameters,
  target
) {
  let energy =
    0;

  const mu1 =
    parameters[INDEX.MU1];

  const sigma1 =
    parameters[INDEX.SIGMA1];

  for (
    let i = 0;
    i < x.length;
    i += 1
  ) {
    const observedExcess =
      Math.max(
        0,
        -residuals[i]
      );

    let weight =
      0;

    if (
      target ===
      "aggregate"
    ) {
      weight =
        0.5 *
        evaluateBaseAt(
          x[i] / 2,
          parameters
        ).total;
    }

    if (
      target === "debris" &&
      x[i] <
        mu1 - sigma1
    ) {
      weight =
        Math.exp(
          -Math.max(
            0,
            x[i] - x[0]
          ) /
          (0.20 * mu1)
        );
    }

    energy +=
      weight *
      observedExcess *
      observedExcess;
  }

  return energy;
}

/* ========================================================================== *
 * 25. SUMMARIZE A FITTED CANDIDATE
 * ========================================================================== */

function summarizeCandidate(
  x,
  y,
  candidate
) {
  const bic =
    calculateBic(
      candidate.sse,
      y.length,
      candidate
        .parameterCount
    );

  return {
    ...candidate,

    bic,

    aggregateResidualEnergy:
      targetedResidualEnergy(
        x,
        candidate
          .rawResiduals,
        candidate
          .parameters,
        "aggregate"
      ),

    debrisResidualEnergy:
      targetedResidualEnergy(
        x,
        candidate
          .rawResiduals,
        candidate
          .parameters,
        "debris"
      ),
  };
}

/* ========================================================================== *
 * 26. COMPARE AN EXTENDED MODEL WITH THE BASE MODEL
 *
 * The extension is retained only when it passes all three tests:
 *
 * 1. Meaningful reduction in SSE.
 * 2. Meaningful improvement in BIC.
 * 3. Meaningful reduction in the targeted residual pattern.
 * ========================================================================== */

function compareWithBase(
  base,
  candidate,
  options
) {
  const relativeSseImprovement =
    (
      base.sse -
      candidate.sse
    ) /
    Math.max(
      base.sse,
      1e-12
    );

  const bicImprovement =
    base.bic -
    candidate.bic;

  const targetImprovements =
    [];

  if (
    candidate
      .flags
      .aggregate
  ) {
    const aggregateImprovement =
      (
        base
          .aggregateResidualEnergy -
        candidate
          .aggregateResidualEnergy
      ) /
      Math.max(
        base
          .aggregateResidualEnergy,
        1e-12
      );

    targetImprovements.push(
      aggregateImprovement
    );
  }

  if (
    candidate
      .flags
      .debris
  ) {
    const debrisImprovement =
      (
        base
          .debrisResidualEnergy -
        candidate
          .debrisResidualEnergy
      ) /
      Math.max(
        base
          .debrisResidualEnergy,
        1e-12
      );

    targetImprovements.push(
      debrisImprovement
    );
  }

  /*
   * For a model containing both extensions, require both residual
   * patterns to improve.
   */
  const targetResidualImprovement =
    targetImprovements.length > 0
      ? Math.min(
          ...targetImprovements
        )
      : 0;

  const materiallyImproved =
    relativeSseImprovement >=
      options
        .minRelativeSseImprovement &&
    bicImprovement >=
      options
        .minBicImprovement &&
    targetResidualImprovement >=
      options
        .minTargetResidualImprovement;

  return {
    relativeSseImprovement,
    bicImprovement,
    targetResidualImprovement,
    materiallyImproved,
  };
}

/* ========================================================================== *
 * 27. CONSERVATIVE MODEL SELECTION
 *
 * The base model wins by default.
 *
 * Extended models must first pass the material-improvement tests. Among
 * eligible models, the simpler model is retained unless a more complex model
 * improves BIC by at least minBicImprovement.
 * ========================================================================== */

function chooseModel(
  candidates,
  options
) {
  const base =
    candidates.find(
      (candidate) =>
        !candidate
          .flags
          .aggregate &&
        !candidate
          .flags
          .debris
    );

  const comparisons =
    [];

  const eligible = [
    base,
  ];

  for (
    const candidate
    of candidates
  ) {
    if (
      candidate === base
    ) {
      continue;
    }

    const comparison =
      compareWithBase(
        base,
        candidate,
        options
      );

    comparisons.push({
      candidate,
      comparison,
    });

    if (
      comparison
        .materiallyImproved
    ) {
      eligible.push(
        candidate
      );
    }
  }

  /*
   * Begin with the simplest eligible model.
   */
  eligible.sort(
    (
      first,
      second
    ) => {
      if (
        first.parameterCount !==
        second.parameterCount
      ) {
        return (
          first.parameterCount -
          second.parameterCount
        );
      }

      return (
        first.bic -
        second.bic
      );
    }
  );

  let selected =
    eligible[0];

  /*
   * Move to a more complex model only when its BIC improvement is large
   * enough to justify the added parameters.
   */
  for (
    const candidate
    of eligible.slice(1)
  ) {
    const additionalBicImprovement =
      selected.bic -
      candidate.bic;

    if (
      additionalBicImprovement >=
      options.minBicImprovement
    ) {
      selected =
        candidate;
    }
  }

  return {
    selected,
    comparisons,
  };
}

/* ========================================================================== *
 * 28. VALIDATE INPUT
 * ========================================================================== */

function validateInput(
  x,
  y,
  previousFit
) {
  if (
    !Array.isArray(x) ||
    !Array.isArray(y)
  ) {
    throw new TypeError(
      "x and y must both be arrays."
    );
  }

  if (
    x.length !== y.length ||
    x.length < 10
  ) {
    throw new RangeError(
      "x and y must have equal lengths and contain at least 10 bins."
    );
  }

  for (
    let i = 0;
    i < x.length;
    i += 1
  ) {
    if (
      !Number.isFinite(x[i])
    ) {
      throw new RangeError(
        `x[${i}] is not finite.`
      );
    }

    if (
      !Number.isFinite(y[i]) ||
      y[i] < 0
    ) {
      throw new RangeError(
        `y[${i}] must be finite and nonnegative.`
      );
    }

    if (
      i > 0 &&
      x[i] <= x[i - 1]
    ) {
      throw new RangeError(
        "x must be strictly increasing."
      );
    }
  }

  if (
    !previousFit?.parameters ||
    !previousFit?.curves
  ) {
    throw new TypeError(
      "previousFit must be the result returned by fitCellCycleHistogram()."
    );
  }
}

/* ========================================================================== *
 * 29. PUBLIC MODEL-EXTENSION FUNCTION
 *
 * Workflow:
 *
 * 1. Inspect residuals from the previous fit.
 * 2. Add aggregate and/or debris candidates when patterns are detected.
 * 3. Refit every active parameter jointly.
 * 4. Compare SSE, BIC, and targeted residual structure.
 * 5. Retain the simpler model unless an extension materially improves fit.
 * ========================================================================== */

function extendCellCycleFit(
  x,
  y,
  previousFit,
  userOptions = {}
) {
  validateInput(
    x,
    y,
    previousFit
  );

  const options = {
    ...DEFAULT_EXTENSION_OPTIONS,
    ...userOptions,
  };

  /*
   * Inspect the residuals returned by the original G1 + S + G2 fit.
   */
  const inspection =
    inspectResidualStructure(
      x,
      y,
      previousFit,
      options
    );

  const initialParameters =
    parametersFromPreviousFit(
      previousFit,
      x,
      y
    );

  /*
   * Always refit the base model so every candidate is compared using
   * the same optimizer and objective function.
   */
  const candidateDefinitions = [
    {
      name:
        "base",

      flags:
        MODEL_FLAGS.BASE,
    },
  ];

  /*
   * Add only extensions supported by the residual inspection.
   */
  if (
    inspection
      .aggregateDetected
  ) {
    candidateDefinitions.push({
      name:
        "base+aggregate",

      flags:
        MODEL_FLAGS.AGGREGATE,
    });
  }

  if (
    inspection
      .debrisDetected
  ) {
    candidateDefinitions.push({
      name:
        "base+debris",

      flags:
        MODEL_FLAGS.DEBRIS,
    });
  }

  if (
    inspection
      .aggregateDetected &&
    inspection
      .debrisDetected
  ) {
    candidateDefinitions.push({
      name:
        "base+aggregate+debris",

      flags:
        MODEL_FLAGS.BOTH,
    });
  }

  /*
   * Jointly refit all active parameters for every candidate.
   */
  const candidates =
    candidateDefinitions.map(
      ({
        name,
        flags,
      }) => {
        const fitted =
          fitCandidateModel(
            x,
            y,
            initialParameters,
            options,
            flags
          );

        return {
          name,

          ...summarizeCandidate(
            x,
            y,
            fitted
          ),
        };
      }
    );

  /*
   * Retain the simplest adequate model.
   */
  const {
    selected,
    comparisons,
  } =
    chooseModel(
      candidates,
      options
    );

  const parameters =
    selected.parameters;

  const mu1 =
    parameters[INDEX.MU1];

  const ratio =
    parameters[INDEX.R];

  const mu2 =
    ratio * mu1;

  return {
    selectedModel:
      selected.name,

    parameters: {
      mu1,
      mu2,
      R:
        ratio,

      sigma1:
        parameters[
          INDEX.SIGMA1
        ],

      sigma2:
        parameters[
          INDEX.SIGMA2
        ],

      cv1:
        parameters[
          INDEX.SIGMA1
        ] /
        mu1,

      cv2:
        parameters[
          INDEX.SIGMA2
        ] /
        mu2,

      a1:
        parameters[
          INDEX.A1
        ],

      a2:
        parameters[
          INDEX.A2
        ],

      s0:
        parameters[
          INDEX.S0
        ],

      s1:
        parameters[
          INDEX.S1
        ],

      s2:
        parameters[
          INDEX.S2
        ],

      pAggregate:
        selected
          .flags
          .aggregate
          ? parameters[
              INDEX.P_AGGREGATE
            ]
          : 0,

      debrisAmplitude:
        selected
          .flags
          .debris
          ? parameters[
              INDEX.DEBRIS_AMPLITUDE
            ]
          : 0,

      debrisTau:
        selected
          .flags
          .debris
          ? parameters[
              INDEX.DEBRIS_TAU
            ]
          : 0,
    },

    curves: {
      x:
        [...x],

      observed:
        [...y],

      g1:
        selected
          .model
          .g1,

      s:
        selected
          .model
          .s,

      g2:
        selected
          .model
          .g2,

      aggregate:
        selected
          .model
          .aggregate,

      debris:
        selected
          .model
          .debris,

      fitted:
        selected
          .model
          .fitted,

      residuals:
        selected
          .rawResiduals,
    },

    inspection,

    diagnostics: {
      converged:
        selected.converged,

      iterations:
        selected.iterations,

      sse:
        selected.sse,

      bic:
        selected.bic,

      finalLambda:
        selected.finalLambda,

      candidateFits:
        candidates.map(
          (candidate) => ({
            name:
              candidate.name,

            converged:
              candidate.converged,

            iterations:
              candidate.iterations,

            parameterCount:
              candidate
                .parameterCount,

            sse:
              candidate.sse,

            bic:
              candidate.bic,
          })
        ),

      comparisons:
        comparisons.map(
          ({
            candidate,
            comparison,
          }) => ({
            candidate:
              candidate.name,

            ...comparison,
          })
        ),

      options,
    },
  };
}

/* ========================================================================== *
 * 30. ES-MODULE EXPORT
 * ========================================================================== */

export {
  extendCellCycleFit,
};

/* ========================================================================== *
 * 31. EXAMPLE USAGE
 * ========================================================================== */

/*
import {
  fitCellCycleHistogram,
} from "./djf-histogram-fitter.js";

import {
  extendCellCycleFit,
} from "./cell-cycle-model-extension.js";

const baseFit =
  fitCellCycleHistogram(
    histogramBinCenters,
    histogramCounts,
    {
      unlockRatio: false,
      cvMin: 0.01,
      cvMax: 0.20,
    }
  );

const finalFit =
  extendCellCycleFit(
    histogramBinCenters,
    histogramCounts,
    baseFit,
    {
      // An extension must reduce SSE by at least 2%.
      minRelativeSseImprovement: 0.02,

      // A BIC improvement of 6 is considered strong evidence.
      minBicImprovement: 6,

      // The targeted residual structure must improve by at least 20%.
      minTargetResidualImprovement: 0.20,
    }
  );

console.log(
  finalFit.selectedModel
);

console.log(
  finalFit.parameters
);

console.log(
  finalFit.inspection
);

console.log(
  finalFit.diagnostics.candidateFits
);

// Plotting arrays:
//
// finalFit.curves.g1
// finalFit.curves.s
// finalFit.curves.g2
// finalFit.curves.aggregate
// finalFit.curves.debris
// finalFit.curves.fitted
// finalFit.curves.residuals
*/
```

### Stage 8 | Step 9: 
Fit everything via Levenberg-Marquardt; report %G1/%S/%G2M + diagnostics

<u>Checklist</u>

- [ ] Integrate each fitted component
- [ ] Compute 1C, S, 2C fractions over biological singlet total
- [ ] Compute contamination fractions separately if modeled
- [ ] Compute goodness-of-fit metrics
- [ ] Emit warnings for:
	- [ ] No pulse-geometry channels
	- [ ] Only one visible peak
	- [ ] Ratio far from expected
	- [ ] Parameter at constraint boundary
	- [ ] Poor residual structure


<u>Pseudocode</u>
```text
integrate each fitted component
compute 1C, S, 2C fractions over biological singlet total
compute contamination fractions separately if modeled
compute goodness-of-fit metrics
emit warnings for:
    no pulse-geometry channels
    only one visible peak
    ratio far from expected
    parameter at constraint boundary
    poor residual structure
```


<u>Sample JS code</u>
```js
"use strict";

/* ========================================================================== *
 * 1. DEFAULT REPORTING OPTIONS
 * ========================================================================== */

const DEFAULT_REPORT_OPTIONS = {
  /*
   * Expected G2/G1 DNA-content ratio:
   *
   *     R = mu2 / mu1
   */
  expectedRatio: 2.0,

  /*
   * Warn when:
   *
   *     |R - expectedRatio| > ratioWarningTolerance
   */
  ratioWarningTolerance: 0.15,

  /*
   * Minimum component size required for a peak to count as visible.
   */
  minimumPeakHeightFraction: 0.05,
  minimumPeakAreaFraction: 0.01,

  /*
   * A parameter is considered near a finite constraint boundary when it is
   * within this fraction of the allowed parameter range.
   */
  boundaryToleranceFraction: 0.02,

  /*
   * Absolute tolerance used for nonnegative parameters whose lower bound is 0.
   */
  nonnegativeBoundaryToleranceFraction: 1e-4,

  /*
   * Residual-structure warning thresholds.
   */
  residualAutocorrelationThreshold: 0.35,
  residualWindowZThreshold: 2.5,
  residualWindowBins: 11,

  /*
   * Channel metadata used to check whether pulse-geometry channels exist.
   *
   * Example:
   *
   *     channelNames: [
   *       "FSC-A",
   *       "FSC-H",
   *       "FSC-W",
   *       "FITC-A",
   *       "FITC-H",
   *       "FITC-W"
   *     ]
   *
   * Set pulseGeometryAvailable explicitly to true or false when the answer
   * is already known.
   */
  channelNames: [],
  pulseGeometryAvailable: null,

  /*
   * Optional explicit number of fitted parameters.
   *
   * When null, the code attempts to infer it from the fit result.
   */
  parameterCount: null,
};

/* ========================================================================== *
 * 2. GENERAL NUMERICAL UTILITIES
 * ========================================================================== */

function clamp(value, minimum, maximum) {
  return Math.min(
    maximum,
    Math.max(minimum, value)
  );
}

function sum(values) {
  let total = 0;

  for (const value of values) {
    total += value;
  }

  return total;
}

function mean(values) {
  if (values.length === 0) {
    return 0;
  }

  return sum(values) / values.length;
}

function median(values) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort(
    (a, b) => a - b
  );

  const middle = Math.floor(
    sorted.length / 2
  );

  if (sorted.length % 2 === 0) {
    return (
      sorted[middle - 1] +
      sorted[middle]
    ) / 2;
  }

  return sorted[middle];
}

function maximum(values) {
  if (values.length === 0) {
    return 0;
  }

  let result = -Infinity;

  for (const value of values) {
    result = Math.max(result, value);
  }

  return result;
}

function sumSquares(values) {
  let total = 0;

  for (const value of values) {
    total += value * value;
  }

  return total;
}

function safeFraction(
  numerator,
  denominator
) {
  if (!(denominator > 0)) {
    return 0;
  }

  return numerator / denominator;
}

/* ========================================================================== *
 * 3. TRAPEZOIDAL NUMERICAL INTEGRATION
 *
 * For adjacent bins i - 1 and i:
 *
 *     area_i =
 *         0.5
 *         [y(i - 1) + y(i)]
 *         [x(i) - x(i - 1)]
 * ========================================================================== */

function integrateTrapezoidal(
  x,
  y
) {
  if (
    x.length !== y.length ||
    x.length < 2
  ) {
    return 0;
  }

  let area = 0;

  for (
    let i = 1;
    i < x.length;
    i += 1
  ) {
    const binWidth =
      x[i] - x[i - 1];

    area +=
      0.5 *
      (
        y[i - 1] +
        y[i]
      ) *
      binWidth;
  }

  return area;
}

/* ========================================================================== *
 * 4. VALIDATE THE FIT RESULT
 * ========================================================================== */

function validateFitResult(
  fitResult
) {
  if (!fitResult?.curves) {
    throw new TypeError(
      "fitResult.curves is required."
    );
  }

  const {
    x,
    observed,
    g1,
    s,
    g2,
    fitted,
    residuals,
  } = fitResult.curves;

  const requiredCurves = {
    x,
    observed,
    g1,
    s,
    g2,
    fitted,
    residuals,
  };

  for (
    const [
      curveName,
      curve,
    ] of Object.entries(
      requiredCurves
    )
  ) {
    if (!Array.isArray(curve)) {
      throw new TypeError(
        `fitResult.curves.${curveName} must be an array.`
      );
    }
  }

  const expectedLength =
    x.length;

  if (expectedLength < 2) {
    throw new RangeError(
      "The fitted histogram must contain at least two bins."
    );
  }

  for (
    const [
      curveName,
      curve,
    ] of Object.entries(
      requiredCurves
    )
  ) {
    if (
      curve.length !==
      expectedLength
    ) {
      throw new RangeError(
        `fitResult.curves.${curveName} does not match the x-array length.`
      );
    }
  }

  for (
    let i = 0;
    i < expectedLength;
    i += 1
  ) {
    if (
      !Number.isFinite(x[i])
    ) {
      throw new RangeError(
        `x[${i}] is not finite.`
      );
    }

    if (
      i > 0 &&
      x[i] <= x[i - 1]
    ) {
      throw new RangeError(
        "The x values must be strictly increasing."
      );
    }

    for (
      const [
        curveName,
        curve,
      ] of Object.entries(
        requiredCurves
      )
    ) {
      if (
        curveName !== "x" &&
        !Number.isFinite(curve[i])
      ) {
        throw new RangeError(
          `${curveName}[${i}] is not finite.`
        );
      }
    }
  }
}

/* ========================================================================== *
 * 5. OBTAIN OPTIONAL CONTAMINATION CURVES
 *
 * The base model may not contain aggregate or debris arrays. Missing arrays
 * are replaced with zeros.
 * ========================================================================== */

function getOptionalCurve(
  fitResult,
  curveName
) {
  const x =
    fitResult.curves.x;

  const curve =
    fitResult
      .curves
      [curveName];

  if (
    Array.isArray(curve) &&
    curve.length === x.length
  ) {
    return curve;
  }

  return new Array(
    x.length
  ).fill(0);
}

/* ========================================================================== *
 * 6. INTEGRATE EACH FITTED COMPONENT
 * ========================================================================== */

function integrateFittedComponents(
  fitResult
) {
  const {
    x,
    g1,
    s,
    g2,
    fitted,
    observed,
  } = fitResult.curves;

  const aggregate =
    getOptionalCurve(
      fitResult,
      "aggregate"
    );

  const debris =
    getOptionalCurve(
      fitResult,
      "debris"
    );

  return {
    g1:
      integrateTrapezoidal(
        x,
        g1
      ),

    s:
      integrateTrapezoidal(
        x,
        s
      ),

    g2:
      integrateTrapezoidal(
        x,
        g2
      ),

    aggregate:
      integrateTrapezoidal(
        x,
        aggregate
      ),

    debris:
      integrateTrapezoidal(
        x,
        debris
      ),

    fitted:
      integrateTrapezoidal(
        x,
        fitted
      ),

    observed:
      integrateTrapezoidal(
        x,
        observed
      ),
  };
}

/* ========================================================================== *
 * 7. COMPUTE BIOLOGICAL SINGLET FRACTIONS
 *
 * Biological singlet total:
 *
 *     T_singlet = Area(G1) + Area(S) + Area(G2)
 *
 * Fractions:
 *
 *     f_1C = Area(G1) / T_singlet
 *
 *     f_S  = Area(S) / T_singlet
 *
 *     f_2C = Area(G2) / T_singlet
 *
 * Aggregate and debris are intentionally excluded from this denominator.
 * ========================================================================== */

function computeSingletFractions(
  componentAreas
) {
  const biologicalSingletTotal =
    componentAreas.g1 +
    componentAreas.s +
    componentAreas.g2;

  return {
    biologicalSingletTotal,

    oneC:
      safeFraction(
        componentAreas.g1,
        biologicalSingletTotal
      ),

    sPhase:
      safeFraction(
        componentAreas.s,
        biologicalSingletTotal
      ),

    twoC:
      safeFraction(
        componentAreas.g2,
        biologicalSingletTotal
      ),
  };
}

/* ========================================================================== *
 * 8. COMPUTE CONTAMINATION FRACTIONS SEPARATELY
 *
 * Total modeled area:
 *
 *     T_modeled =
 *         G1 + S + G2 + aggregate + debris
 *
 * Contamination fractions:
 *
 *     f_aggregate = Area(aggregate) / T_modeled
 *
 *     f_debris = Area(debris) / T_modeled
 *
 * The combined contamination fraction is:
 *
 *     f_contamination =
 *         [Area(aggregate) + Area(debris)] / T_modeled
 * ========================================================================== */

function computeContaminationFractions(
  componentAreas
) {
  const totalModeledArea =
    componentAreas.g1 +
    componentAreas.s +
    componentAreas.g2 +
    componentAreas.aggregate +
    componentAreas.debris;

  const contaminationArea =
    componentAreas.aggregate +
    componentAreas.debris;

  return {
    totalModeledArea,

    contaminationArea,

    aggregate:
      safeFraction(
        componentAreas.aggregate,
        totalModeledArea
      ),

    debris:
      safeFraction(
        componentAreas.debris,
        totalModeledArea
      ),

    combined:
      safeFraction(
        contaminationArea,
        totalModeledArea
      ),

    aggregateWasModeled:
      componentAreas.aggregate > 0,

    debrisWasModeled:
      componentAreas.debris > 0,
  };
}

/* ========================================================================== *
 * 9. INFER THE NUMBER OF FITTED PARAMETERS
 * ========================================================================== */

function inferParameterCount(
  fitResult,
  options
) {
  if (
    Number.isInteger(
      options.parameterCount
    ) &&
    options.parameterCount > 0
  ) {
    return options.parameterCount;
  }

  /*
   * The extended fitter records the fitted candidate's parameter count.
   */
  const candidateFits =
    fitResult
      .diagnostics
      ?.candidateFits;

  if (
    Array.isArray(candidateFits) &&
    fitResult.selectedModel
  ) {
    const selectedCandidate =
      candidateFits.find(
        (candidate) =>
          candidate.name ===
          fitResult.selectedModel
      );

    if (
      Number.isInteger(
        selectedCandidate
          ?.parameterCount
      )
    ) {
      return selectedCandidate
        .parameterCount;
    }
  }

  /*
   * Base model:
   *
   *     mu1
   *     sigma1
   *     sigma2
   *     a1
   *     a2
   *     s0
   *     s1
   *     s2
   *
   * R adds one parameter when unlocked.
   */
  let parameterCount = 8;

  if (
    fitResult
      .diagnostics
      ?.ratioWasUnlocked ||
    fitResult
      .diagnostics
      ?.options
      ?.unlockRatio
  ) {
    parameterCount += 1;
  }

  if (
    fitResult
      .selectedModel
      ?.includes("aggregate")
  ) {
    parameterCount += 1;
  }

  if (
    fitResult
      .selectedModel
      ?.includes("debris")
  ) {
    parameterCount += 2;
  }

  return parameterCount;
}

/* ========================================================================== *
 * 10. COMPUTE GOODNESS-OF-FIT METRICS
 *
 * Metrics returned:
 *
 *     SSE
 *     MSE
 *     RMSE
 *     MAE
 *     R-squared
 *     adjusted R-squared
 *     Pearson chi-square
 *     reduced Pearson chi-square
 *     AIC
 *     BIC
 * ========================================================================== */

function computeGoodnessOfFit(
  fitResult,
  options
) {
  const {
    observed,
    fitted,
  } = fitResult.curves;

  /*
   * Recalculate residuals from the displayed curves so the report does not
   * depend on whether a previous optimizer used weighted residuals.
   *
   * Residual convention:
   *
   *     residual = fitted - observed
   */
  const residuals =
    observed.map(
      (
        observedValue,
        index
      ) =>
        fitted[index] -
        observedValue
    );

  const observationCount =
    observed.length;

  const parameterCount =
    inferParameterCount(
      fitResult,
      options
    );

  const degreesOfFreedom =
    Math.max(
      1,
      observationCount -
      parameterCount
    );

  const sse =
    sumSquares(
      residuals
    );

  const mse =
    sse /
    observationCount;

  const rmse =
    Math.sqrt(mse);

  let absoluteErrorTotal = 0;

  for (const residual of residuals) {
    absoluteErrorTotal +=
      Math.abs(residual);
  }

  const mae =
    absoluteErrorTotal /
    observationCount;

  const observedMean =
    mean(observed);

  let totalSumOfSquares = 0;

  for (
    const value
    of observed
  ) {
    totalSumOfSquares +=
      (
        value -
        observedMean
      ) ** 2;
  }

  const rSquared =
    totalSumOfSquares > 0
      ? 1 -
        sse /
        totalSumOfSquares
      : null;

  const adjustedRSquared =
    rSquared === null ||
    observationCount <=
      parameterCount + 1
      ? null
      : 1 -
        (
          1 -
          rSquared
        ) *
        (
          observationCount - 1
        ) /
        (
          observationCount -
          parameterCount -
          1
        );

  /*
   * Pearson statistic:
   *
   *     chiSquare =
   *         sum[(observed - fitted)^2 / fitted]
   */
  let pearsonChiSquare = 0;

  for (
    let i = 0;
    i < observationCount;
    i += 1
  ) {
    pearsonChiSquare +=
      residuals[i] ** 2 /
      Math.max(
        fitted[i],
        1
      );
  }

  const reducedPearsonChiSquare =
    pearsonChiSquare /
    degreesOfFreedom;

  /*
   * Gaussian-error information criteria:
   *
   *     AIC =
   *         n ln(SSE / n) + 2k
   *
   *     BIC =
   *         n ln(SSE / n) + k ln(n)
   */
  const safeSse =
    Math.max(
      sse,
      1e-12
    );

  const aic =
    observationCount *
      Math.log(
        safeSse /
        observationCount
      ) +
    2 *
      parameterCount;

  const bic =
    observationCount *
      Math.log(
        safeSse /
        observationCount
      ) +
    parameterCount *
      Math.log(
        observationCount
      );

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

/* ========================================================================== *
 * 11. ROBUST RESIDUAL SCALE
 *
 * Median absolute deviation:
 *
 *     scale = 1.4826 * median(|r - median(r)|)
 * ========================================================================== */

function robustResidualScale(
  residuals
) {
  const residualMedian =
    median(residuals);

  const absoluteDeviations =
    residuals.map(
      (residual) =>
        Math.abs(
          residual -
          residualMedian
        )
    );

  return Math.max(
    1.4826 *
      median(
        absoluteDeviations
      ),
    1e-12
  );
}

/* ========================================================================== *
 * 12. LAG-1 RESIDUAL AUTOCORRELATION
 *
 * Structured residuals commonly appear as long neighboring runs with similar
 * signs. Lag-1 autocorrelation measures that behavior.
 * ========================================================================== */

function calculateLagOneAutocorrelation(
  residuals
) {
  if (residuals.length < 2) {
    return 0;
  }

  const residualMean =
    mean(residuals);

  let numerator = 0;
  let denominator = 0;

  for (
    let i = 0;
    i < residuals.length;
    i += 1
  ) {
    const centered =
      residuals[i] -
      residualMean;

    denominator +=
      centered *
      centered;

    if (i > 0) {
      numerator +=
        centered *
        (
          residuals[i - 1] -
          residualMean
        );
    }
  }

  if (denominator === 0) {
    return 0;
  }

  return numerator / denominator;
}

/* ========================================================================== *
 * 13. DURBIN-WATSON RESIDUAL STATISTIC
 *
 *     DW =
 *         sum[(r_i - r_(i-1))^2]
 *         /
 *         sum[r_i^2]
 *
 * Values near 2 indicate little lag-1 residual correlation.
 * ========================================================================== */

function calculateDurbinWatson(
  residuals
) {
  if (residuals.length < 2) {
    return 2;
  }

  let numerator = 0;

  for (
    let i = 1;
    i < residuals.length;
    i += 1
  ) {
    numerator +=
      (
        residuals[i] -
        residuals[i - 1]
      ) ** 2;
  }

  const denominator =
    sumSquares(
      residuals
    );

  if (denominator === 0) {
    return 2;
  }

  return numerator / denominator;
}

/* ========================================================================== *
 * 14. MAXIMUM LOCAL RESIDUAL BIAS
 *
 * This searches a moving window for a persistent positive or negative residual
 * region.
 *
 *     localBiasZ =
 *         |mean(window residuals)|
 *         /
 *         robust residual scale
 * ========================================================================== */

function calculateMaximumLocalBias(
  residuals,
  requestedWindowBins
) {
  if (residuals.length === 0) {
    return {
      maximumAbsoluteZ: 0,
      startIndex: null,
      endIndex: null,
      meanResidual: 0,
    };
  }

  const residualScale =
    robustResidualScale(
      residuals
    );

  const windowBins =
    clamp(
      Math.round(
        requestedWindowBins
      ),
      3,
      residuals.length
    );

  let maximumAbsoluteZ = 0;
  let bestStart = 0;
  let bestMean = 0;

  let runningSum = 0;

  for (
    let i = 0;
    i < windowBins;
    i += 1
  ) {
    runningSum +=
      residuals[i];
  }

  for (
    let start = 0;
    start <=
      residuals.length -
      windowBins;
    start += 1
  ) {
    if (start > 0) {
      runningSum -=
        residuals[start - 1];

      runningSum +=
        residuals[
          start +
          windowBins -
          1
        ];
    }

    const windowMean =
      runningSum /
      windowBins;

    const absoluteZ =
      Math.abs(
        windowMean
      ) /
      residualScale;

    if (
      absoluteZ >
      maximumAbsoluteZ
    ) {
      maximumAbsoluteZ =
        absoluteZ;

      bestStart =
        start;

      bestMean =
        windowMean;
    }
  }

  return {
    maximumAbsoluteZ,

    startIndex:
      bestStart,

    endIndex:
      bestStart +
      windowBins -
      1,

    meanResidual:
      bestMean,
  };
}

/* ========================================================================== *
 * 15. SUMMARIZE RESIDUAL STRUCTURE
 * ========================================================================== */

function analyzeResidualStructure(
  residuals,
  options
) {
  const lagOneAutocorrelation =
    calculateLagOneAutocorrelation(
      residuals
    );

  const durbinWatson =
    calculateDurbinWatson(
      residuals
    );

  const localBias =
    calculateMaximumLocalBias(
      residuals,
      options.residualWindowBins
    );

  return {
    meanResidual:
      mean(residuals),

    medianResidual:
      median(residuals),

    robustScale:
      robustResidualScale(
        residuals
      ),

    lagOneAutocorrelation,

    durbinWatson,

    maximumLocalBiasZ:
      localBias
        .maximumAbsoluteZ,

    localBiasStartIndex:
      localBias
        .startIndex,

    localBiasEndIndex:
      localBias
        .endIndex,

    localBiasMeanResidual:
      localBias
        .meanResidual,
  };
}

/* ========================================================================== *
 * 16. CHECK FOR PULSE-GEOMETRY CHANNELS
 *
 * Pulse geometry generally requires at least two measurements of the same
 * signal, such as:
 *
 *     FITC-A and FITC-H
 *     FITC-A and FITC-W
 *     FSC-A and FSC-H
 *
 * Area-only channels are not sufficient for pulse-geometry gating.
 * ========================================================================== */

function normalizeGeometryName(
  geometry
) {
  const upper =
    geometry.toUpperCase();

  if (
    upper === "A" ||
    upper === "AREA"
  ) {
    return "A";
  }

  if (
    upper === "H" ||
    upper === "HEIGHT"
  ) {
    return "H";
  }

  if (
    upper === "W" ||
    upper === "WIDTH"
  ) {
    return "W";
  }

  return null;
}

function parsePulseGeometryChannel(
  channelName
) {
  if (
    typeof channelName !==
    "string"
  ) {
    return null;
  }

  const trimmed =
    channelName.trim();

  /*
   * Examples matched:
   *
   *     FITC-A
   *     FITC_H
   *     FITC.W
   *     FITC Area
   *     FSC Height
   */
  const match =
    trimmed.match(
      /^(.*?)[\s._-]*(AREA|HEIGHT|WIDTH|A|H|W)$/i
    );

  if (!match) {
    return null;
  }

  const base =
    match[1]
      .trim()
      .toUpperCase();

  const geometry =
    normalizeGeometryName(
      match[2]
    );

  if (
    !base ||
    !geometry
  ) {
    return null;
  }

  return {
    base,
    geometry,
  };
}

function detectPulseGeometry(
  options
) {
  if (
    typeof options
      .pulseGeometryAvailable ===
    "boolean"
  ) {
    return {
      available:
        options
          .pulseGeometryAvailable,

      source:
        "explicit-option",

      matchedFamilies: [],
    };
  }

  const families =
    new Map();

  for (
    const channelName
    of options.channelNames
  ) {
    const parsed =
      parsePulseGeometryChannel(
        channelName
      );

    if (!parsed) {
      continue;
    }

    if (
      !families.has(
        parsed.base
      )
    ) {
      families.set(
        parsed.base,
        new Set()
      );
    }

    families
      .get(parsed.base)
      .add(parsed.geometry);
  }

  const matchedFamilies = [];

  for (
    const [
      base,
      geometries,
    ] of families
  ) {
    const hasArea =
      geometries.has("A");

    const hasHeightOrWidth =
      geometries.has("H") ||
      geometries.has("W");

    if (
      hasArea &&
      hasHeightOrWidth
    ) {
      matchedFamilies.push({
        base,
        geometries:
          [...geometries],
      });
    }
  }

  return {
    available:
      matchedFamilies.length > 0,

    source:
      "channel-names",

    matchedFamilies,
  };
}

/* ========================================================================== *
 * 17. CHECK WHETHER TWO PEAKS ARE VISIBLY SUPPORTED
 * ========================================================================== */

function inspectPeakVisibility(
  fitResult,
  componentAreas,
  singletFractions,
  options
) {
  const {
    observed,
    g1,
    g2,
  } = fitResult.curves;

  const observedMaximum =
    Math.max(
      maximum(observed),
      1e-12
    );

  const g1PeakHeight =
    maximum(g1);

  const g2PeakHeight =
    maximum(g2);

  const g1HeightFraction =
    g1PeakHeight /
    observedMaximum;

  const g2HeightFraction =
    g2PeakHeight /
    observedMaximum;

  const g1Visible =
    g1HeightFraction >=
      options
        .minimumPeakHeightFraction &&
    singletFractions.oneC >=
      options
        .minimumPeakAreaFraction;

  const g2Visible =
    g2HeightFraction >=
      options
        .minimumPeakHeightFraction &&
    singletFractions.twoC >=
      options
        .minimumPeakAreaFraction;

  return {
    visiblePeakCount:
      Number(g1Visible) +
      Number(g2Visible),

    g1Visible,
    g2Visible,

    g1PeakHeight,
    g2PeakHeight,

    g1HeightFraction,
    g2HeightFraction,

    g1Area:
      componentAreas.g1,

    g2Area:
      componentAreas.g2,
  };
}

/* ========================================================================== *
 * 18. GET FITTING CONSTRAINTS FROM THE FIT RESULT
 * ========================================================================== */

function getFitConstraints(
  fitResult
) {
  const fittedOptions =
    fitResult
      .diagnostics
      ?.options ??
    {};

  return {
    cvMin:
      fittedOptions.cvMin ??
      0.01,

    cvMax:
      fittedOptions.cvMax ??
      0.20,

    ratioMin:
      fittedOptions.ratioMin ??
      1.70,

    ratioMax:
      fittedOptions.ratioMax ??
      2.30,

    ratioTarget:
      fittedOptions.ratioTarget ??
      2.0,

    unlockRatio:
      fittedOptions.unlockRatio ??
      fitResult
        .diagnostics
        ?.ratioWasUnlocked ??
      false,

    aggregateMaxFraction:
      fittedOptions
        .aggregateMaxFraction ??
      1.0,

    debrisTauMinFraction:
      fittedOptions
        .debrisTauMinFraction ??
      0.02,

    debrisTauMaxFraction:
      fittedOptions
        .debrisTauMaxFraction ??
      0.75,
  };
}

/* ========================================================================== *
 * 19. TEST WHETHER A VALUE IS NEAR A FINITE BOUNDARY
 * ========================================================================== */

function isNearFiniteBoundary(
  value,
  minimum,
  maximum,
  toleranceFraction
) {
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(minimum) ||
    !Number.isFinite(maximum) ||
    maximum <= minimum
  ) {
    return {
      nearMinimum: false,
      nearMaximum: false,
    };
  }

  const tolerance =
    toleranceFraction *
    (
      maximum -
      minimum
    );

  return {
    nearMinimum:
      value <=
      minimum +
      tolerance,

    nearMaximum:
      value >=
      maximum -
      tolerance,
  };
}

/* ========================================================================== *
 * 20. FIND PARAMETERS AT CONSTRAINT BOUNDARIES
 * ========================================================================== */

function findBoundaryParameters(
  fitResult,
  options
) {
  const parameters =
    fitResult.parameters ??
    {};

  const constraints =
    getFitConstraints(
      fitResult
    );

  const boundaryParameters = [];

  /*
   * CV boundaries.
   */
  for (
    const [
      name,
      value,
    ] of [
      [
        "cv1",
        parameters.cv1,
      ],
      [
        "cv2",
        parameters.cv2,
      ],
    ]
  ) {
    const result =
      isNearFiniteBoundary(
        value,
        constraints.cvMin,
        constraints.cvMax,
        options
          .boundaryToleranceFraction
      );

    if (result.nearMinimum) {
      boundaryParameters.push({
        parameter: name,
        boundary: "minimum",
        value,
        limit:
          constraints.cvMin,
      });
    }

    if (result.nearMaximum) {
      boundaryParameters.push({
        parameter: name,
        boundary: "maximum",
        value,
        limit:
          constraints.cvMax,
      });
    }
  }

  /*
   * Ratio boundaries matter only when R was fitted rather than locked.
   */
  if (
    constraints.unlockRatio &&
    Number.isFinite(parameters.R)
  ) {
    const result =
      isNearFiniteBoundary(
        parameters.R,
        constraints.ratioMin,
        constraints.ratioMax,
        options
          .boundaryToleranceFraction
      );

    if (result.nearMinimum) {
      boundaryParameters.push({
        parameter: "R",
        boundary: "minimum",
        value:
          parameters.R,
        limit:
          constraints.ratioMin,
      });
    }

    if (result.nearMaximum) {
      boundaryParameters.push({
        parameter: "R",
        boundary: "maximum",
        value:
          parameters.R,
        limit:
          constraints.ratioMax,
      });
    }
  }

  /*
   * Aggregate-fraction boundaries.
   */
  if (
    fitResult
      .selectedModel
      ?.includes("aggregate") &&
    Number.isFinite(
      parameters.pAggregate
    )
  ) {
    const result =
      isNearFiniteBoundary(
        parameters.pAggregate,
        0,
        constraints
          .aggregateMaxFraction,
        options
          .boundaryToleranceFraction
      );

    if (result.nearMinimum) {
      boundaryParameters.push({
        parameter:
          "pAggregate",
        boundary:
          "minimum",
        value:
          parameters
            .pAggregate,
        limit: 0,
      });
    }

    if (result.nearMaximum) {
      boundaryParameters.push({
        parameter:
          "pAggregate",
        boundary:
          "maximum",
        value:
          parameters
            .pAggregate,
        limit:
          constraints
            .aggregateMaxFraction,
      });
    }
  }

  /*
   * Debris decay-length boundaries.
   */
  if (
    fitResult
      .selectedModel
      ?.includes("debris") &&
    Number.isFinite(
      parameters.debrisTau
    ) &&
    Number.isFinite(
      parameters.mu1
    )
  ) {
    const minimumTau =
      constraints
        .debrisTauMinFraction *
      parameters.mu1;

    const maximumTau =
      constraints
        .debrisTauMaxFraction *
      parameters.mu1;

    const result =
      isNearFiniteBoundary(
        parameters.debrisTau,
        minimumTau,
        maximumTau,
        options
          .boundaryToleranceFraction
      );

    if (result.nearMinimum) {
      boundaryParameters.push({
        parameter:
          "debrisTau",
        boundary:
          "minimum",
        value:
          parameters.debrisTau,
        limit:
          minimumTau,
      });
    }

    if (result.nearMaximum) {
      boundaryParameters.push({
        parameter:
          "debrisTau",
        boundary:
          "maximum",
        value:
          parameters.debrisTau,
        limit:
          maximumTau,
      });
    }
  }

  /*
   * Nonnegative model parameters.
   */
  const observedMaximum =
    Math.max(
      maximum(
        fitResult.curves.observed
      ),
      1
    );

  const zeroTolerance =
    options
      .nonnegativeBoundaryToleranceFraction *
    observedMaximum;

  const nonnegativeParameters = [
    "a1",
    "a2",
    "s0",
    "s1",
    "s2",
  ];

  if (
    fitResult
      .selectedModel
      ?.includes("debris")
  ) {
    nonnegativeParameters.push(
      "debrisAmplitude"
    );
  }

  for (
    const parameterName
    of nonnegativeParameters
  ) {
    const value =
      parameters[
        parameterName
      ];

    if (
      Number.isFinite(value) &&
      value <= zeroTolerance
    ) {
      boundaryParameters.push({
        parameter:
          parameterName,
        boundary:
          "minimum",
        value,
        limit: 0,
      });
    }
  }

  return boundaryParameters;
}

/* ========================================================================== *
 * 21. WARNING OBJECT HELPER
 * ========================================================================== */

function createWarning(
  code,
  severity,
  message,
  details = {}
) {
  return {
    code,
    severity,
    message,
    details,
  };
}

/* ========================================================================== *
 * 22. EMIT FIT WARNINGS
 * ========================================================================== */

function generateWarnings({
  fitResult,
  options,
  pulseGeometry,
  peakVisibility,
  residualStructure,
  boundaryParameters,
}) {
  const warnings = [];

  /*
   * Warning: no pulse-geometry channels.
   */
  if (!pulseGeometry.available) {
    warnings.push(
      createWarning(
        "NO_PULSE_GEOMETRY_CHANNELS",
        "warning",
        "No usable pulse area/height or area/width channel pair was found. Doublet and aggregate exclusion may be unreliable.",
        {
          channelNames:
            options.channelNames,
        }
      )
    );
  }

  /*
   * Warning: only one visible peak.
   */
  if (
    peakVisibility
      .visiblePeakCount < 2
  ) {
    warnings.push(
      createWarning(
        "ONLY_ONE_VISIBLE_PEAK",
        "warning",
        "The fitted histogram does not contain two clearly supported 1C and 2C peaks.",
        {
          visiblePeakCount:
            peakVisibility
              .visiblePeakCount,

          g1Visible:
            peakVisibility
              .g1Visible,

          g2Visible:
            peakVisibility
              .g2Visible,

          g1HeightFraction:
            peakVisibility
              .g1HeightFraction,

          g2HeightFraction:
            peakVisibility
              .g2HeightFraction,
        }
      )
    );
  }

  /*
   * Warning: G2/G1 ratio far from expected.
   */
  const ratio =
    fitResult
      .parameters
      ?.R;

  if (
    Number.isFinite(ratio) &&
    Math.abs(
      ratio -
      options.expectedRatio
    ) >
      options
        .ratioWarningTolerance
  ) {
    warnings.push(
      createWarning(
        "RATIO_FAR_FROM_EXPECTED",
        "warning",
        `The fitted G2/G1 ratio is ${ratio.toFixed(3)}, which is far from the expected ratio of ${options.expectedRatio.toFixed(3)}.`,
        {
          fittedRatio:
            ratio,

          expectedRatio:
            options.expectedRatio,

          absoluteDifference:
            Math.abs(
              ratio -
              options.expectedRatio
            ),

          tolerance:
            options
              .ratioWarningTolerance,
        }
      )
    );
  }

  /*
   * Warning: parameter at a constraint boundary.
   */
  if (
    boundaryParameters.length > 0
  ) {
    warnings.push(
      createWarning(
        "PARAMETER_AT_CONSTRAINT_BOUNDARY",
        "warning",
        "One or more fitted parameters are at or near an imposed constraint boundary.",
        {
          parameters:
            boundaryParameters,
        }
      )
    );
  }

  /*
   * Warning: poor residual structure.
   */
  const excessiveAutocorrelation =
    Math.abs(
      residualStructure
        .lagOneAutocorrelation
    ) >
    options
      .residualAutocorrelationThreshold;

  const excessiveLocalBias =
    residualStructure
      .maximumLocalBiasZ >
    options
      .residualWindowZThreshold;

  if (
    excessiveAutocorrelation ||
    excessiveLocalBias
  ) {
    warnings.push(
      createWarning(
        "POOR_RESIDUAL_STRUCTURE",
        "warning",
        "The residuals contain systematic structure rather than behaving like uncorrelated noise.",
        {
          lagOneAutocorrelation:
            residualStructure
              .lagOneAutocorrelation,

          autocorrelationThreshold:
            options
              .residualAutocorrelationThreshold,

          maximumLocalBiasZ:
            residualStructure
              .maximumLocalBiasZ,

          localBiasThreshold:
            options
              .residualWindowZThreshold,

          localBiasStartIndex:
            residualStructure
              .localBiasStartIndex,

          localBiasEndIndex:
            residualStructure
              .localBiasEndIndex,

          localBiasMeanResidual:
            residualStructure
              .localBiasMeanResidual,
        }
      )
    );
  }

  return warnings;
}

/* ========================================================================== *
 * 23. PUBLIC REPORTING FUNCTION
 *
 * Workflow:
 *
 *     integrate each fitted component
 *     compute 1C, S, and 2C fractions over biological singlet total
 *     compute contamination fractions separately
 *     compute goodness-of-fit metrics
 *     inspect warning conditions
 *     return a structured report
 * ========================================================================== */

function summarizeCellCycleFit(
  fitResult,
  userOptions = {}
) {
  validateFitResult(
    fitResult
  );

  const options = {
    ...DEFAULT_REPORT_OPTIONS,
    ...userOptions,
  };

  if (
    !Array.isArray(
      options.channelNames
    )
  ) {
    throw new TypeError(
      "options.channelNames must be an array."
    );
  }

  /*
   * Integrate all fitted components.
   */
  const componentAreas =
    integrateFittedComponents(
      fitResult
    );

  /*
   * Calculate biological singlet fractions.
   */
  const singletFractions =
    computeSingletFractions(
      componentAreas
    );

  /*
   * Calculate aggregate and debris contamination separately.
   */
  const contaminationFractions =
    computeContaminationFractions(
      componentAreas
    );

  /*
   * Calculate fit-quality statistics.
   */
  const goodnessOfFit =
    computeGoodnessOfFit(
      fitResult,
      options
    );

  /*
   * Inspect residual structure.
   */
  const residualStructure =
    analyzeResidualStructure(
      goodnessOfFit.residuals,
      options
    );

  /*
   * Determine whether pulse-geometry measurements are available.
   */
  const pulseGeometry =
    detectPulseGeometry(
      options
    );

  /*
   * Determine whether both biological peaks are visibly supported.
   */
  const peakVisibility =
    inspectPeakVisibility(
      fitResult,
      componentAreas,
      singletFractions,
      options
    );

  /*
   * Detect parameters at constraint boundaries.
   */
  const boundaryParameters =
    findBoundaryParameters(
      fitResult,
      options
    );

  /*
   * Generate warnings.
   */
  const warnings =
    generateWarnings({
      fitResult,
      options,
      pulseGeometry,
      peakVisibility,
      residualStructure,
      boundaryParameters,
    });

  return {
    model:
      fitResult.selectedModel ??
      "base",

    areas: {
      oneC:
        componentAreas.g1,

      sPhase:
        componentAreas.s,

      twoC:
        componentAreas.g2,

      biologicalSingletTotal:
        singletFractions
          .biologicalSingletTotal,

      aggregate:
        componentAreas.aggregate,

      debris:
        componentAreas.debris,

      contaminationTotal:
        contaminationFractions
          .contaminationArea,

      totalModeled:
        contaminationFractions
          .totalModeledArea,

      totalObserved:
        componentAreas.observed,

      fittedCurveArea:
        componentAreas.fitted,
    },

    fractions: {
      biologicalSinglets: {
        oneC:
          singletFractions.oneC,

        sPhase:
          singletFractions.sPhase,

        twoC:
          singletFractions.twoC,
      },

      contamination: {
        aggregate:
          contaminationFractions
            .aggregate,

        debris:
          contaminationFractions
            .debris,

        combined:
          contaminationFractions
            .combined,

        aggregateWasModeled:
          contaminationFractions
            .aggregateWasModeled,

        debrisWasModeled:
          contaminationFractions
            .debrisWasModeled,
      },
    },

    goodnessOfFit: {
      observationCount:
        goodnessOfFit
          .observationCount,

      parameterCount:
        goodnessOfFit
          .parameterCount,

      degreesOfFreedom:
        goodnessOfFit
          .degreesOfFreedom,

      sse:
        goodnessOfFit.sse,

      mse:
        goodnessOfFit.mse,

      rmse:
        goodnessOfFit.rmse,

      mae:
        goodnessOfFit.mae,

      rSquared:
        goodnessOfFit.rSquared,

      adjustedRSquared:
        goodnessOfFit
          .adjustedRSquared,

      pearsonChiSquare:
        goodnessOfFit
          .pearsonChiSquare,

      reducedPearsonChiSquare:
        goodnessOfFit
          .reducedPearsonChiSquare,

      aic:
        goodnessOfFit.aic,

      bic:
        goodnessOfFit.bic,
    },

    residualStructure,

    qualityChecks: {
      pulseGeometry,
      peakVisibility,
      boundaryParameters,

      warningCount:
        warnings.length,

      passed:
        warnings.length === 0,
    },

    warnings,

    options,
  };
}

/* ========================================================================== *
 * 24. OPTIONAL PERCENT-FORMATTING HELPER
 * ========================================================================== */

function fractionToPercent(
  fraction,
  decimalPlaces = 1
) {
  if (!Number.isFinite(fraction)) {
    return null;
  }

  return (
    100 *
    fraction
  ).toFixed(
    decimalPlaces
  );
}

/* ========================================================================== *
 * 25. CREATE A DISPLAY-FRIENDLY SUMMARY
 * ========================================================================== */

function createDisplaySummary(
  report,
  decimalPlaces = 1
) {
  return {
    cellCycle: {
      oneC:
        `${fractionToPercent(
          report
            .fractions
            .biologicalSinglets
            .oneC,
          decimalPlaces
        )}%`,

      sPhase:
        `${fractionToPercent(
          report
            .fractions
            .biologicalSinglets
            .sPhase,
          decimalPlaces
        )}%`,

      twoC:
        `${fractionToPercent(
          report
            .fractions
            .biologicalSinglets
            .twoC,
          decimalPlaces
        )}%`,
    },

    contamination: {
      aggregate:
        `${fractionToPercent(
          report
            .fractions
            .contamination
            .aggregate,
          decimalPlaces
        )}%`,

      debris:
        `${fractionToPercent(
          report
            .fractions
            .contamination
            .debris,
          decimalPlaces
        )}%`,

      combined:
        `${fractionToPercent(
          report
            .fractions
            .contamination
            .combined,
          decimalPlaces
        )}%`,
    },

    goodnessOfFit: {
      rmse:
        report
          .goodnessOfFit
          .rmse,

      rSquared:
        report
          .goodnessOfFit
          .rSquared,

      reducedPearsonChiSquare:
        report
          .goodnessOfFit
          .reducedPearsonChiSquare,

      aic:
        report
          .goodnessOfFit
          .aic,

      bic:
        report
          .goodnessOfFit
          .bic,
    },

    warnings:
      report.warnings.map(
        (warning) =>
          warning.message
      ),
  };
}

/* ========================================================================== *
 * 26. ES-MODULE EXPORTS
 * ========================================================================== */

export {
  summarizeCellCycleFit,
  createDisplaySummary,
  integrateTrapezoidal,
};

/* ========================================================================== *
 * 27. EXAMPLE USAGE
 * ========================================================================== */

/*
import {
  extendCellCycleFit,
} from "./cell-cycle-model-extension.js";

import {
  summarizeCellCycleFit,
  createDisplaySummary,
} from "./cell-cycle-fit-report.js";

const finalFit =
  extendCellCycleFit(
    histogramBinCenters,
    histogramCounts,
    baseFit
  );

const report =
  summarizeCellCycleFit(
    finalFit,
    {
      channelNames: [
        "FSC-A",
        "FSC-H",
        "FSC-W",
        "SSC-A",
        "SSC-H",
        "FITC-A",
        "FITC-H",
        "FITC-W",
      ],

      expectedRatio: 2.0,
      ratioWarningTolerance: 0.15,

      residualAutocorrelationThreshold: 0.35,
      residualWindowZThreshold: 2.5,
      residualWindowBins: 11,
    }
  );

console.log(
  report.areas
);

console.log(
  report.fractions
);

console.log(
  report.goodnessOfFit
);

console.log(
  report.residualStructure
);

console.log(
  report.warnings
);

const displaySummary =
  createDisplaySummary(
    report
  );

console.log(
  displaySummary
);
*/
```