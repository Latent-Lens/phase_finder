# Add a PeacoQC-Style Peak-Tracking Option to Time QC

## Purpose

Add a second Time QC method to the existing pre-modeling QC workflow without creating a fifth top-level QC test.

The application currently exposes:

1. Structural
2. Time
3. Cell Gate
4. Singlet Gate

The new method belongs inside **2. Time** because it detects acquisition instability over event order. It does not replace structural filtering, cell gating, singlet gating, or cell-cycle modeling.

The existing Time QC method should remain available as the default or legacy option.

---

## User-facing terminology

Use the following labels:

- **Robust summary QC**
- **Peak-tracking QC**

Avoid labeling the new method simply as **PeacoQC** unless the implementation intentionally reproduces the published PeacoQC algorithm and the project is prepared to handle any licensing and attribution implications.

Recommended UI text:

> **Peak-tracking QC** follows major distribution peaks across acquisition and removes time regions where those peaks shift abnormally.

---

## Recommended UI placement

Keep the existing four-button layout unchanged.

When the user opens **2. Time**, show a method selector near the top of the Time QC panel.

```text
Time QC method

(•) Robust summary QC
    Tracks event rate, medians, and IQRs in acquisition bins.

( ) Peak-tracking QC
    Tracks major density-peak positions across overlapping bins.
```

A compact dropdown is also acceptable:

```text
Time QC method: [ Robust summary QC ▼ ]
```

Options:

```text
Robust summary QC
Peak-tracking QC
```

The method selector should affect only the Time QC stage.

---

## Suggested controls

### Shared controls

These can appear for either Time QC method:

```text
Channels to evaluate
[✓] DNA-A
[✓] FSC-A
[✓] SSC-A
[ ] Other transformed channels...

[✓] Include event-rate checks
[✓] Preview flagged acquisition regions
```

### Robust summary QC controls

```text
Target events per bin: 500
Robust z-score threshold: 4
Statistics:
[✓] Median
[✓] IQR
[✓] Event rate
```

### Peak-tracking QC controls

```text
Minimum events per bin: 150
Maximum number of bins: 500
Bin overlap: 50%
Minimum relative peak height: 0.33
Isolation-tree gain threshold: 0.60
MAD multiplier: 6
Minimum surviving run: 5 bins
```

For the first release, these advanced controls may be hidden behind:

```text
▶ Advanced settings
```

The normal user should be able to select the method and run it without changing parameters.

---

## Recommended defaults

```javascript
const DEFAULT_PEAK_TRACKING_OPTIONS = {
  minimumEventsPerBin: 150,
  maximumBins: 500,
  binSizeRounding: 500,
  overlapFraction: 0.5,
  minimumRelativePeakHeight: 1 / 3,
  minimumPeakClusterPrevalence: 0.5,
  isolationTreeEnabled: true,
  isolationTreeMinimumBins: 150,
  isolationTreeGainThreshold: 0.6,
  isolationTreeMaximumDepth: null,
  madMultiplier: 6,
  minimumGoodRunBins: 5,
  removeZeroValues: false,
  includeEventRateCheck: true,
};
```

These should be treated as implementation defaults, not immutable scientific constants.

---

## High-level processing order

The full pre-modeling workflow should remain:

```text
1. Structural QC
2. Time QC
   ├── Robust summary QC
   └── Peak-tracking QC
3. Cell Gate
4. Singlet Gate
5. Histogram construction
6. Cell-cycle model fitting
```

Structural QC must run before Time QC so invalid and nonfinite values do not corrupt density estimation.

Time QC must run before the Cell Gate and Singlet Gate because it removes acquisition intervals affected by unstable flow or instrument behavior.

---

# Peak-tracking QC algorithm

## Inputs

```text
events
    Acquisition-ordered event records.

timeChannel
    Channel representing acquisition time.

selectedChannels
    Transformed channels whose distributions should remain stable.

options
    Peak-tracking settings.

structuralGoodMask
    Boolean mask produced by Structural QC.
```

Recommended default channels:

```text
DNA-A
FSC-A
SSC-A
```

Additional fluorescence channels may be selectable, but adding many unstable biological markers can make the QC overly aggressive.

---

## Outputs

```text
goodEventMask
badEventMask

goodBinMask
badBinMask

binDefinitions
peakMatrix
channelPeakMetadata

rejectionReasonsByBin
percentEventsRemoved

warnings
diagnosticSeries
```

Each rejected bin should record why it was rejected:

```text
isolation-tree outlier
MAD peak-position outlier
short surviving region
event-rate anomaly
```

---

## Step 1: Prepare acquisition-ordered events

```text
function prepareTimeQCInput(events, timeChannel, structuralGoodMask):

    filteredEvents =
        events where structuralGoodMask is true

    preserve original event index for every filtered event

    if time values contain rollover:
        unwrap timer rollover

    split acquisition into segments when:
        time jumps backward unexpectedly
        time is missing
        discontinuity exceeds configured tolerance

    return ordered acquisition segments
```

Do not sort events by marker value.

Do not globally reorder events by time when a backward jump likely represents a new acquisition segment. Preserve acquisition sequence and analyze each segment separately.

---

## Step 2: Choose bin size

The goal is to retain enough events for density estimation while avoiding an excessive number of bins.

```text
function chooseAdaptiveBinSize(eventCount, options):

    approximateBinSize =
        ceil((2 * eventCount) / options.maximumBins)

    roundedBinSize =
        roundUp(
            approximateBinSize,
            options.binSizeRounding
        )

    return max(
        options.minimumEventsPerBin,
        roundedBinSize
    )
```

The factor of two accounts for approximately 50% overlap.

Example:

```text
100,000 events
maximumBins = 500

approximateBinSize = ceil((2 × 100,000) / 500)
                   = 400

rounded upward to nearest 500
binSize = 500
```

---

## Step 3: Build overlapping bins

```text
function createOverlappingBins(segment, binSize, overlapFraction):

    stepSize =
        max(
            1,
            round(binSize * (1 - overlapFraction))
        )

    bins = empty list

    start = 0

    while start < segment.length:

        end =
            min(
                start + binSize,
                segment.length
            )

        if end - start < minimum allowed final-bin size:
            merge remainder into previous bin
            break

        bins.append({
            startEventOffset: start,
            endEventOffsetExclusive: end,
            originalEventIndices:
                segment.originalEventIndices[start:end]
        })

        start = start + stepSize

    return bins
```

With 50% overlap:

```text
Bin 1: events    0–499
Bin 2: events  250–749
Bin 3: events  500–999
```

---

## Step 4: Estimate density in every channel and bin

```text
function estimateChannelDensity(values, options):

    validValues =
        finite values only

    if options.removeZeroValues:
        validValues =
            validValues where value != 0

    if validValues.length is too small:
        return invalid density result

    bandwidth =
        choose robust KDE bandwidth

    densityCurve =
        oneDimensionalKernelDensityEstimate(
            validValues,
            bandwidth
        )

    return densityCurve
```

Use transformed channel values.

The density estimator should return:

```text
x coordinates
density values
bandwidth
valid event count
```

---

## Step 5: Detect major density peaks

A peak is a local maximum whose density height exceeds a fraction of the tallest peak in that bin.

```text
function detectMajorDensityPeaks(densityCurve, relativeHeightThreshold):

    maximumDensity =
        max(densityCurve.y)

    candidatePeaks =
        empty list

    for i from 1 to densityCurve.length - 2:

        isLocalMaximum =
            densityCurve.y[i] > densityCurve.y[i - 1]
            and
            densityCurve.y[i] >= densityCurve.y[i + 1]

        isHighEnough =
            densityCurve.y[i]
            >=
            relativeHeightThreshold * maximumDensity

        if isLocalMaximum and isHighEnough:

            candidatePeaks.append({
                position: densityCurve.x[i],
                height: densityCurve.y[i]
            })

    if candidatePeaks is empty:

        i =
            index of maximum density

        candidatePeaks.append({
            position: densityCurve.x[i],
            height: densityCurve.y[i],
            fallback: true
        })

    return candidatePeaks
```

Optional hardening:

```text
merge peaks separated by less than one density-grid interval
reject peaks with negligible prominence
cap maximum peaks per channel and bin
```

---

## Step 6: Determine persistent peak tracks

Different bins may contain different numbers of detected peaks. The implementation must identify recurring peak locations and align peaks across bins.

```text
function buildPersistentPeakTracks(peaksByBin, options):

    observedPeakCounts =
        number of peaks in each bin

    commonPeakCount =
        choose most frequently observed nonzero peak count

    initialReferencePositions =
        estimate typical ordered peak positions
        from bins having commonPeakCount peaks

    assignments =
        empty assignment matrix

    for each bin:

        detectedPeaks =
            peaksByBin[bin]

        assign every detected peak
        to nearest reference position

        if multiple peaks map to one reference:
            retain the closest peak
            mark extras as unmatched

    for each reference peak track:

        prevalence =
            bins containing an assigned peak
            /
            total bins

        if prevalence
           < options.minimumPeakClusterPrevalence:

            discard that track

    for each retained track:

        trackMedian =
            median of observed assigned positions

        for bins missing that track:
            store trackMedian as imputed position
            mark value as imputed

    return alignedPeakTracks
```

The resulting matrix should have:

```text
Rows:
    acquisition bins

Columns:
    tracked peak positions for each selected channel
```

Example:

```text
Bin    FSC peak 1    SSC peak 1    DNA peak 1    DNA peak 2
1          52            39            42            83
2          51            38            43            84
3          73            60            61           103
4          52            39            42            82
```

---

## Step 7: Build the peak matrix

```text
function constructPeakMatrix(events, bins, selectedChannels, options):

    matrixColumns = empty list
    metadata = empty list

    for each channel in selectedChannels:

        peaksByBin = empty list

        for each bin:

            values =
                channel values for events in bin

            density =
                estimateChannelDensity(values, options)

            peaks =
                detectMajorDensityPeaks(
                    density,
                    options.minimumRelativePeakHeight
                )

            peaksByBin.append(peaks)

        tracks =
            buildPersistentPeakTracks(
                peaksByBin,
                options
            )

        append every retained track
        as one peak-matrix column

        record channel and track identity
        in metadata

    return {
        peakMatrix,
        metadata
    }
```

---

## Step 8: Detect broad multichannel instability with a deterministic isolation tree

The isolation-tree stage separates bins based on peak-position patterns.

```text
function computeSplitGain(values, leftIndices, rightIndices):

    parentSpread =
        standardDeviation(values)

    if parentSpread is zero:
        return 0

    childSpread =
        mean(
            standardDeviation(values[leftIndices]),
            standardDeviation(values[rightIndices])
        )

    return
        (parentSpread - childSpread)
        /
        parentSpread
```

```text
function findBestIsolationSplit(peakMatrix, rowIndices, options):

    bestSplit = null
    bestGain =
        options.isolationTreeGainThreshold

    for each column in peakMatrix:

        columnValues =
            peakMatrix[rowIndices, column]

        candidateThresholds =
            midpoints between sorted unique values

        for each threshold in candidateThresholds:

            leftIndices =
                rows where value <= threshold

            rightIndices =
                rows where value > threshold

            if either child is empty:
                continue

            gain =
                computeSplitGain(
                    columnValues,
                    leftIndices,
                    rightIndices
                )

            if gain > bestGain:

                bestGain = gain

                bestSplit = {
                    column,
                    threshold,
                    gain,
                    leftIndices,
                    rightIndices
                }

    return bestSplit
```

```text
function buildDeterministicIsolationTree(
    peakMatrix,
    options
):

    root =
        node containing every bin row

    queue = [root]
    terminalNodes = empty list

    while queue is not empty:

        node =
            remove first node from queue

        if maximum depth reached:
            terminalNodes.append(node)
            continue

        split =
            findBestIsolationSplit(
                peakMatrix,
                node.rowIndices,
                options
            )

        if split is null:
            terminalNodes.append(node)
            continue

        leftNode =
            child containing split.leftIndices

        rightNode =
            child containing split.rightIndices

        queue.append(leftNode)
        queue.append(rightNode)

    stableNode =
        terminal node containing
        the largest number of bins

    goodBinMask =
        bins belonging to stableNode

    return {
        goodBinMask,
        tree,
        stableNode
    }
```

Run this stage only when enough bins exist:

```text
if binCount >= isolationTreeMinimumBins:
    run isolation tree
else:
    skip isolation tree
    warn that only MAD filtering was used
```

---

## Step 9: Detect subtler peak shifts using MAD limits

Apply this stage to bins still considered good after the isolation tree.

```text
function detectMADPeakOutliers(
    peakMatrix,
    candidateGoodBins,
    options
):

    badBins =
        empty set

    for each peak column:

        x =
            acquisition bin indices
            restricted to candidateGoodBins

        y =
            peak positions
            restricted to candidateGoodBins

        smoothed =
            smoothingSpline(x, y)

        center =
            median(smoothed)

        spread =
            medianAbsoluteDeviation(smoothed)

        if spread is effectively zero:

            for each candidate bin:

                if smoothed[bin] differs from center
                   beyond numerical tolerance:

                    badBins.add(bin)

            continue

        lower =
            center
            -
            options.madMultiplier * spread

        upper =
            center
            +
            options.madMultiplier * spread

        for each candidate bin:

            if smoothed[bin] < lower
               or
               smoothed[bin] > upper:

                badBins.add(bin)

    return badBins
```

A bin is rejected when any retained peak track is outside its allowed range.

---

## Step 10: Remove short surviving good regions

A small island of good bins inside a disturbed region should not be retained.

```text
function removeShortGoodRuns(
    goodBinMask,
    minimumGoodRunBins
):

    runs =
        runLengthEncode(goodBinMask)

    for each run in runs:

        if run.value is GOOD
           and
           run.length < minimumGoodRunBins:

            set every bin in run to BAD

    return expanded Boolean mask
```

Example:

```text
Before:
BAD BAD BAD GOOD GOOD BAD BAD

After minimumGoodRunBins = 5:
BAD BAD BAD BAD BAD BAD BAD
```

Do not automatically remove short good runs at the very beginning or end unless that behavior is explicitly intended and documented. Edge handling should be tested separately.

---

## Step 11: Optional event-rate anomaly detection

Peak tracking detects distribution shifts but can miss a pure rate disturbance that leaves marker peaks unchanged.

The existing event-rate logic can therefore be retained as a supplementary check.

```text
function detectEventRateOutliers(events, bins, options):

    eventRates =
        events per clock-time duration for every bin

    center =
        median(eventRates)

    spread =
        medianAbsoluteDeviation(eventRates)

    if spread is effectively zero:

        reject bins whose rate
        differs from center
        beyond numerical tolerance

    else:

        robustZ =
            (eventRate - center)
            /
            (1.4826 * spread)

        reject bins where:
            absoluteValue(robustZ)
            >
            configured threshold

    return badRateBins
```

The UI should clearly indicate whether event-rate checking is included.

---

## Step 12: Convert rejected bins into rejected events

Because bins overlap, an event may belong to more than one bin.

Use a conservative union rule:

```text
function convertBadBinsToBadEvents(
    bins,
    badBinMask,
    totalEventCount
):

    badEventMask =
        Boolean array of false
        with length totalEventCount

    for each bin where badBinMask is true:

        for each originalEventIndex
            in bin.originalEventIndices:

            badEventMask[originalEventIndex] =
                true

    return badEventMask
```

An event is rejected if it belongs to at least one rejected bin.

---

# Complete top-level pseudocode

```text
function runPeakTrackingTimeQC(
    events,
    timeChannel,
    selectedChannels,
    structuralGoodMask,
    options
):

    validate inputs

    acquisitionSegments =
        prepareTimeQCInput(
            events,
            timeChannel,
            structuralGoodMask
        )

    globalBadEventMask =
        Boolean array of false
        with length events.length

    allSegmentResults =
        empty list

    for each segment in acquisitionSegments:

        binSize =
            chooseAdaptiveBinSize(
                segment.length,
                options
            )

        bins =
            createOverlappingBins(
                segment,
                binSize,
                options.overlapFraction
            )

        {
            peakMatrix,
            metadata
        } =
            constructPeakMatrix(
                segment.events,
                bins,
                selectedChannels,
                options
            )

        initialGoodBinMask =
            all true

        rejectionReasons =
            empty reason set for every bin

        if options.isolationTreeEnabled
           and
           bins.length
           >=
           options.isolationTreeMinimumBins:

            treeResult =
                buildDeterministicIsolationTree(
                    peakMatrix,
                    options
                )

            initialGoodBinMask =
                treeResult.goodBinMask

            for each rejected bin:
                add "isolation-tree outlier"

        else:

            add warning:
                "Too few bins for isolation-tree filtering;
                 MAD filtering was used alone."

        madBadBins =
            detectMADPeakOutliers(
                peakMatrix,
                initialGoodBinMask,
                options
            )

        mark madBadBins as bad

        for each madBadBin:
            add "MAD peak-position outlier"

        combinedGoodBinMask =
            initialGoodBinMask
            minus madBadBins

        if options.includeEventRateCheck:

            rateBadBins =
                detectEventRateOutliers(
                    segment.events,
                    bins,
                    options
                )

            mark rateBadBins as bad

            for each rateBadBin:
                add "event-rate anomaly"

        cleanedGoodBinMask =
            removeShortGoodRuns(
                combinedGoodBinMask,
                options.minimumGoodRunBins
            )

        for every newly rejected short-run bin:
            add "short surviving region"

        segmentBadEventMask =
            convertBadBinsToBadEvents(
                bins,
                NOT cleanedGoodBinMask,
                events.length
            )

        globalBadEventMask =
            globalBadEventMask
            OR
            segmentBadEventMask

        allSegmentResults.append({
            bins,
            binSize,
            peakMatrix,
            metadata,
            goodBinMask:
                cleanedGoodBinMask,
            rejectionReasons
        })

    goodEventMask =
        structuralGoodMask
        AND
        NOT globalBadEventMask

    return {
        method: "peak-tracking",
        goodEventMask,
        badEventMask:
            structuralGoodMask
            AND
            globalBadEventMask,
        percentRemoved:
            rejected structurally valid events
            /
            structurally valid events
            *
            100,
        segmentResults:
            allSegmentResults,
        warnings,
        optionsUsed:
            options
    }
```

---

# Integration with the current Time QC interface

## Proposed state model

```javascript
const timeQCState = {
  method: "robust-summary",

  selectedChannels: [
    "DNA-A",
    "FSC-A",
    "SSC-A",
  ],

  robustSummaryOptions: {
    targetEventsPerBin: 500,
    zThreshold: 4,
    useMedian: true,
    useIQR: true,
    useEventRate: true,
  },

  peakTrackingOptions: {
    minimumEventsPerBin: 150,
    maximumBins: 500,
    overlapFraction: 0.5,
    minimumRelativePeakHeight: 1 / 3,
    minimumPeakClusterPrevalence: 0.5,
    isolationTreeEnabled: true,
    isolationTreeMinimumBins: 150,
    isolationTreeGainThreshold: 0.6,
    madMultiplier: 6,
    minimumGoodRunBins: 5,
    includeEventRateCheck: true,
  },
};
```

---

## Method dispatch

```text
function runSelectedTimeQC(
    events,
    structuralResult,
    timeQCState
):

    switch timeQCState.method:

        case "robust-summary":

            return runRobustSummaryTimeQC(
                events,
                structuralResult.goodEventMask,
                timeQCState.selectedChannels,
                timeQCState.robustSummaryOptions
            )

        case "peak-tracking":

            return runPeakTrackingTimeQC(
                events,
                timeChannel,
                timeQCState.selectedChannels,
                structuralResult.goodEventMask,
                timeQCState.peakTrackingOptions
            )

        default:

            throw unsupported method error
```

---

## HTML structure example

```html
<section id="time-qc-panel">
  <fieldset>
    <legend>Time QC method</legend>

    <label>
      <input
        type="radio"
        name="time-qc-method"
        value="robust-summary"
        checked
      >
      Robust summary QC
    </label>

    <p>
      Tracks event rate, medians, and IQRs in acquisition bins.
    </p>

    <label>
      <input
        type="radio"
        name="time-qc-method"
        value="peak-tracking"
      >
      Peak-tracking QC
    </label>

    <p>
      Tracks major density peaks across overlapping acquisition bins.
    </p>
  </fieldset>

  <div id="robust-summary-settings">
    <!-- Existing Time QC controls -->
  </div>

  <div
    id="peak-tracking-settings"
    hidden
  >
    <!-- New controls -->
  </div>

  <button id="run-time-qc">
    Run Time QC
  </button>
</section>
```

---

## UI switching pseudocode

```text
on Time QC method change:

    selectedMethod =
        value of checked method input

    state.timeQC.method =
        selectedMethod

    show robust-summary settings only when:
        selectedMethod == "robust-summary"

    show peak-tracking settings only when:
        selectedMethod == "peak-tracking"

    update description text

    clear stale preview results
    or mark them as requiring rerun
```

---

## Result summary

After running, show:

```text
Time QC method:
Peak-tracking QC

Events evaluated:
65,102

Events removed:
2,841 (4.36%)

Acquisition regions removed:
3

Reasons:
Isolation-tree outlier: 1 region
MAD peak shift: 2 regions
Event-rate anomaly: 1 overlapping region
```

Do not double-count overlapping reasons when reporting the final removed-event total.

---

## Diagnostic plot

The Time QC result should provide an acquisition-order plot.

Recommended layers:

```text
x-axis:
    acquisition time or event index

y-axis:
    selected channel value or bin summary

show:
    individual events with low opacity
    tracked peak positions
    rejected-bin shading
    acquisition segment boundaries
```

Suggested controls:

```text
Channel: [DNA-A ▼]

[✓] Show tracked peaks
[✓] Shade rejected regions
[ ] Show density curves
```

For peak-tracking mode, tracked peaks are more informative than median-only traces.

---

## Tooltip text

Suggested tooltip for the **Time** button:

> **Time QC:** Detects unstable acquisition periods. Robust summary QC monitors event rate, medians, and IQRs. Peak-tracking QC follows major distribution peaks across overlapping acquisition bins and removes regions with abnormal shifts.

Suggested tooltip for the method selector:

> Peak-tracking QC is more sensitive to population shifts that may not strongly change the overall median. It may take longer and can be overly aggressive when selected biological channels genuinely change during acquisition.

---

# Warnings and guardrails

## Too few events

```text
if segment event count
   < 2 × minimumEventsPerBin:

    skip peak-tracking QC for that segment

    warn:
        "Too few events for reliable peak-tracking Time QC."
```

---

## Too few bins for isolation tree

```text
if bin count < isolationTreeMinimumBins:

    skip isolation-tree stage

    continue with MAD filtering

    show nonfatal warning
```

---

## No reliable density peaks

```text
if a channel repeatedly produces
   invalid density estimates
   or only fallback maxima:

    exclude that channel from peak tracking

    warn user
```

If every selected channel fails, stop and return an error rather than silently accepting all events.

---

## Biological drift versus technical drift

Some channels may genuinely shift during acquisition because of biology, sample mixing, stimulation, or sequential sample contamination.

Therefore:

```text
default to DNA-A, FSC-A, and SSC-A

do not automatically select every fluorescence channel

show a warning when the user adds many channels
```

Suggested warning:

> A selected channel may change for biological reasons. Peak-tracking QC treats major acquisition-ordered shifts as potential technical artifacts.

---

## Excessive removal

```text
if removed fraction > 20%:

    show strong warning

if removed fraction > 50%:

    do not silently continue to modeling

    require user review or explicit confirmation
```

Suggested message:

> Time QC removed an unusually large fraction of events. Review the diagnostic plot before continuing.

---

## No events removed

This is not an error.

```text
Time QC found no acquisition regions exceeding the selected thresholds.
```

---

# Persistence and reproducibility

Store the method and parameters with the analysis session.

```javascript
const savedTimeQCConfiguration = {
  method: timeQCState.method,
  selectedChannels: [...timeQCState.selectedChannels],
  options:
    timeQCState.method === "peak-tracking"
      ? {...timeQCState.peakTrackingOptions}
      : {...timeQCState.robustSummaryOptions},
  algorithmVersion: "peak-tracking-v1",
};
```

Export these settings in reports so results can be reproduced.

Recommended report fields:

```text
Time QC method
Selected channels
Bin size
Overlap
Peak-height threshold
Isolation-tree threshold
MAD multiplier
Minimum good-run length
Event-rate check enabled
Number and percentage of rejected events
Algorithm version
```

---

# Testing requirements

## Unit tests

Test at least:

```text
adaptive bin-size calculation
overlapping-bin boundaries
timer rollover handling
local peak detection
fallback peak behavior
peak-to-track assignment
track prevalence filtering
zero-MAD behavior
isolation split gain
largest terminal-node selection
short-good-run removal
bad-bin to bad-event conversion
```

---

## Synthetic acquisition scenarios

Create synthetic data containing:

```text
stable single population
stable bimodal population
temporary global channel shift
temporary shift in only one channel
gradual monotonic drift
short clog-like event-rate drop
timer rollover
backward time jump creating a new segment
missing peak in a subset of bins
new transient peak in a subset of bins
noisy low-event-count sample
```

Expected behavior should be defined before implementation.

---

## Regression tests against the existing method

For representative files, record:

```text
events removed by robust summary QC
events removed by peak-tracking QC
overlap between rejected events
differences in downstream G1/S/G2 estimates
```

The two Time QC methods are not expected to return identical masks.

---

# Acceptance criteria

The feature is complete when:

```text
1. The four top-level QC buttons remain unchanged.

2. The Time panel lets the user select:
   - Robust summary QC
   - Peak-tracking QC

3. Only settings for the selected method are shown.

4. Peak-tracking QC:
   - preserves acquisition order
   - supports timer segmentation
   - creates overlapping bins
   - detects density peaks
   - aligns persistent peak tracks
   - applies isolation-tree filtering when enough bins exist
   - applies MAD filtering
   - removes short surviving good regions
   - optionally includes event-rate filtering
   - converts rejected bins into an event mask

5. The result includes diagnostic data and rejection reasons.

6. The method and parameters are stored in the session and report.

7. The UI warns about excessive removal and insufficient data.

8. Downstream Cell Gate, Singlet Gate, and modeling use the selected Time QC mask.
```

---

# Implementation note

The easiest safe rollout is:

```text
Phase 1:
    Add the method selector and peak-tracking algorithm.
    Keep advanced parameters hidden.
    Use DNA-A, FSC-A, and SSC-A by default.
    Retain event-rate filtering.

Phase 2:
    Add detailed diagnostic plots and advanced controls.
```

This avoids redesigning the QC panel while still making the new method available as a real alternative to the current median/IQR-based Time QC.
