# Manual peak-region handles

## Purpose

The hardened detector first proposes left/right G1 and G2/M regions. The user may accept those proposals or move the handles when the automatic assignment is wrong or uncertain. After acceptance, the user identifies the visible **G1 peak** and **G2/M peak** by the left and right handle around each peak:

```text
        G1 region                              G2/M region
      L1          R1                         L2          R2
      |-----------|                          |-----------|
          /\                                      /\
         /  \                                    /  \
--------/----\---------------S phase------------/----\--------
```

Whether accepted from automatic detection or manually edited, these regions are **semantic peak constraints**. They tell the model which visible peak is G1 and which visible peak is G2/M.

They are not:

- final G1/S/G2 phase gates;
- integration limits for the Gaussian components;
- boundaries that the optimizer may silently move;
- proof that every event inside a region belongs to that phase.

Final phase percentages still come from the fitted G1, S, and G2/M component areas.

## Required fitting behavior

Let the user-selected regions be:

\[
G1=[L_1,R_1],\qquad G2=[L_2,R_2].
\]

Require:

\[
L_1<R_1\leq L_2<R_2.
\]

The fitted peak centers must satisfy:

\[
L_1\leq\mu_1\leq R_1,
\qquad
L_2\leq\mu_2\leq R_2,
\qquad
\mu_1<\mu_2.
\]

The handles remain fixed during fitting. Only the fitted means and widths change.

Gaussian tails may extend beyond the selected regions. The regions identify the peak and constrain its center; they do not truncate the fitted Gaussian.

## Ratio modes

### Bounded ratio

For a biologically expected near-doubling relationship:

\[
R_{min}\leq\frac{\mu_2}{\mu_1}\leq R_{max}.
\]

The reference implementation fits \(\mu_1\) and \(\mu_2\) independently inside their user regions and rejects parameter combinations outside the allowed ratio range.

Before fitting, verify that the selected regions can produce at least one allowed ratio. The achievable range is:

\[
\left[\frac{L_2}{R_1},\frac{R_2}{L_1}\right].
\]

If this interval does not overlap the requested ratio range, stop and ask the user to review the regions or ratio constraint.

### Locked ratio

For a locked ratio \(R\):

\[
\mu_2=R\mu_1.
\]

The feasible interval for \(\mu_1\) becomes:

\[
\mu_1\in
\left[
\max\left(L_1,\frac{L_2}{R}\right),
\min\left(R_1,\frac{R_2}{R}\right)
\right].
\]

If this interval is empty, the lock conflicts with the selected peak regions and fitting must not proceed.

### Free ratio

The centers remain confined to their assigned regions and ordered, but no near-doubling ratio is enforced. Report the fitted ratio and warn when it is biologically unexpected.

## Initialization inside each region

For each selected region:

1. lightly smooth a copy of the histogram for peak finding only;
2. locate the highest local value inside the region;
3. use that location as the initial peak mean;
4. estimate width from the cleaner outer shoulder when possible:
   - left shoulder for G1;
   - right shoulder for G2/M;
5. use a baseline-subtracted second moment as a fallback;
6. use the region span only as a final fallback.

When the user explicitly indicates that the handles mark full width at half maximum:

\[
\sigma\approx\frac{R-L}{2\sqrt{2\ln2}}
=\frac{R-L}{2.35482}.
\]

Do not assume ordinary peak-window handles are FWHM boundaries unless the UI says so.

## Boundary behavior

If a fitted center reaches or approaches a selected region edge, do not expand or move the region automatically. Keep the fit result but display a warning such as:

> G2/M fitted center reached the right edge of its selected peak region. Review or explicitly expand that region before refitting.

The user must take an explicit action to change a handle.

## UI behavior

Recommended interaction:

1. Auto-detect and draw four handles: G1-left, G1-right, G2-left, G2-right.
2. Let the user drag any handle before fitting.
3. Draw an initial peak-center marker inside each region.
4. Run the model only after the user presses **Fit** or **Refit**.
5. Keep the four handles exactly where the user placed them.
6. Draw fitted center markers separately from the handles.
7. Show center movement numerically, for example `70.5 → 71.2`, rather than implying the region moved.
8. Show residuals and any boundary warnings.
9. Derive optional post-fit classification boundaries from component intersections or posterior probabilities; do not reuse the peak-region handles as phase gates.

Moving a handle invalidates the prior fit result until refitting. Percentages should not update merely because a handle was dragged.

## Public state contract

```js
{
  peakRegions: {
    g1: {
      left: 60,
      right: 82,
      boundaryMeaning: 'peak-window'
    },
    g2: {
      left: 128,
      right: 152,
      boundaryMeaning: 'peak-window'
    }
  },
  ratioMode: 'free' | 'bounded' | 'locked',
  ratioRange: [1.8, 2.2],
  lockedRatio: 2
}
```

## JavaScript entry points

`src/peakRegions.js` provides:

- `validatePeakRegions()`;
- `estimatePeakFromRegion()`;
- `applyPeakRegionsToInitialization()`;
- `buildPeakMeanParameterization()`;
- `peakRegionBoundaryWarnings()`;
- `summarizePeakRegionMigration()`.

Example:

```js
import { fitAutoCellCycle } from './src/index.js';

const result = fitAutoCellCycle({
  edges,
  counts,
  peakRegions: {
    g1: { left: 60, right: 82 },
    g2: { left: 128, right: 152 }
  },
  constraints: {
    ratioMode: 'bounded',
    ratioRange: [1.8, 2.2],
    equalPeakCVs: true
  }
});
```

The fit result records:

```js
result.selected.provenance.peakRegionHandlesMovedDuringFit === false;
result.selected.peakRegionMigration.g1;
result.selected.peakRegionMigration.g2;
```

Each migration summary contains the initial fitted-center guess, final fitted center, absolute shift, shift as a fraction of the selected region width, the original region, and `handlesMoved: false`.

## Acceptance tests

The implementation must verify that:

- overlapping G1 and G2/M regions are rejected;
- initial centers are inside their assigned regions;
- fitted centers never leave their assigned regions;
- G1 and G2/M identity never swaps;
- locked-ratio conflicts are reported before fitting;
- the exported regions equal the user-selected regions exactly;
- fitted Gaussian tails are allowed outside the regions;
- boundary hits produce visible warnings;
- dragging a handle does not update phase percentages until refitting.
