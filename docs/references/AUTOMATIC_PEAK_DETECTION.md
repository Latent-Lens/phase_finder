# Hardened automatic G1/G2 peak detection and pair scoring

This module proposes the initial G1 and G2/M peak regions shown in the UI. It does **not** make irreversible biological assignments. The user may move the proposed left/right handles before fitting. Once fitting begins, the accepted handles remain fixed and constrain the corresponding fitted center.

Current implementation: [`peak_detection.js`](../../js/analysis/cell_cycle/peak_detection.js) and [`peak_regions.js`](../../js/analysis/cell_cycle/peak_regions.js). The specification below retains some illustrative names; the linked production modules are authoritative.

## 1. Inputs and outputs

Input:

```js
{
  edges: number[],  // n + 1 increasing DNA-bin edges
  counts: number[]  // n nonnegative raw histogram counts
}
```

Primary output:

```js
{
  candidates: PeakCandidate[],
  pairs: PeakPairScore[],
  detection: {
    status: 'detected' | 'low_confidence' | 'inferred_g2',
    confidence: number,
    g1Index: number,
    g2Index: number,
    g1Candidate?: PeakCandidate,
    g2Candidate?: PeakCandidate,
    selectedPair?: PeakPairScore,
    alternatives: PeakPairScore[],
    reasons: string[]
  },
  configuration: {
    smoothingScales: number[],
    primaryScale: number,
    expectedRatio: number,
    ratioRange: [number, number],
    pairWeights: Record<string, number>,
    minPairScore: number,
    minPairConfidence: number
  },
  autoPeakRegions: {
    g1: { left: number, right: number, source: 'detected' | 'inferred' },
    g2: { left: number, right: number, source: 'detected' | 'inferred' }
  }
}
```

The confidence value is a heuristic ranking confidence, **not** a calibrated probability that the biological labels are correct.

## 2. Multi-scale Gaussian smoothing

For smoothing scale \(\sigma_s\) measured in histogram bins:

\[
H_{\sigma_s}(i)=\sum_k H(i-k)K_{\sigma_s}(k),
\qquad
K_{\sigma_s}(k)=
\frac{\exp[-k^2/(2\sigma_s^2)]}
{\sum_r\exp[-r^2/(2\sigma_s^2)]}.
\]

The default scales are:

\[
\mathcal S=\{1,2,4\}\text{ bins}
\]

when the primary smoothing scale is two bins. Detecting the same feature at several scales is more robust than trusting one arbitrarily chosen smoothing width. This is an engineering adaptation of scale-space feature detection rather than a literal implementation of Lindeberg's scale-normalized derivative detectors [Lindeberg1998].

The raw counts remain unchanged and are used later for likelihood fitting. Smoothed arrays are used only for candidate detection, initialization, and display.

## 3. Peak candidates at each scale

A bin \(i\) is a local maximum when:

\[
H_{\sigma_s}(i)\ge H_{\sigma_s}(i-1),
\qquad
H_{\sigma_s}(i)\ge H_{\sigma_s}(i+1).
\]

Candidates must also pass minimum height, minimum separation, and an adaptive prominence threshold.

### 3.1 Prominence

Within a search window around candidate \(i\), let \(m_L\) and \(m_R\) be the lowest values on the left and right. The local reference level is:

\[
b_i=\max(m_L,m_R).
\]

Prominence is:

\[
P_i=H_{\sigma_s}(i)-b_i.
\]

The implementation follows the ordinary topographic idea of peak prominence used by common signal-processing libraries, but keeps a compact dependency-free implementation [SciPyFindPeaks; SciPyPeakProminences].

### 3.2 Adaptive prominence floor

A peak is retained only when:

\[
P_i\ge
\max\left(
\eta_P\max_j H_{\sigma_s}(j),
\kappa\max(\widehat\sigma_{noise},\sqrt{H_{\sigma_s}(i)})
\right),
\]

where:

- \(\eta_P\) is a small global prominence fraction;
- \(\kappa\) is a noise multiplier;
- \(\widehat\sigma_{noise}\) is estimated robustly from adjacent raw-count differences;
- \(\sqrt{H(i)}\) supplies a Poisson-like local noise scale.

These are initializer heuristics, not a hypothesis test.

## 4. Peak width and area evidence

At half prominence, the crossing level is:

\[
h_i=H_{\sigma_s}(i)-\frac{1}{2}P_i.
\]

Linear interpolation between neighboring bins gives left and right crossings \(l_i\) and \(r_i\). The measured width is:

\[
W_i=r_i-l_i.
\]

For a Gaussian-like peak, the corresponding scale-dependent standard deviation is:

\[
\widehat\sigma_{i,s}=\frac{W_i}{2\sqrt{2\log 2}}.
\]

Approximate local area evidence is calculated above the local prominence baseline:

\[
A_i=\sum_{k=L_i}^{R_i}\max\left(0,H_{\sigma_s}(k)-b_i\right).
\]

This area is used only to rank candidates and seed model parameters. Final phase areas come from the fitted DJ, DJF, or Watson components.

## 5. Persistence across smoothing scales

Candidate observations at different scales are clustered when their locations differ by no more than a configured bin tolerance. For merged candidate \(i\):

\[
p_i=\frac{\#\{s\in\mathcal S:\text{candidate }i\text{ detected at }s\}}
{|\mathcal S|}
\]

is its persistence.

Location stability is:

\[
q_i^{loc}=
\exp\left[-\frac{1}{2}
\left(\frac{SD(i_s)}{\tau_i}\right)^2\right],
\]

where \(i_s\) is the candidate location at scale \(s\), and \(\tau_i\) is the scale-matching tolerance.

## 6. One-bin impulse rejection using intrinsic width

Gaussian smoothing adds variances approximately:

\[
\sigma_{observed,s}^2\approx\sigma_{intrinsic}^2+\sigma_s^2.
\]

Therefore, each scale supplies a deconvolved width estimate:

\[
\widehat\sigma_{intrinsic,s}=
\sqrt{\max\left(0,
\widehat\sigma_{observed,s}^2-\sigma_s^2
\right)}.
\]

The candidate's intrinsic width is the median across scales:

\[
\widehat\sigma_{intrinsic}=
\operatorname{median}_{s\in\mathcal S}
\widehat\sigma_{intrinsic,s}.
\]

A one-bin impulse broadens almost exactly with the smoothing kernel and consequently has near-zero deconvolved width. Its support factor is:

\[
q_i^{impulse}=1-
\exp\left(-\frac{\widehat\sigma_{intrinsic}}{\tau_{impulse}}\right).
\]

This factor downweights narrow electronic/spike-like artifacts without imposing a brittle hard minimum peak width.

## 7. Candidate quality

Prominence, area, and height are log-normalized relative to the strongest candidate:

\[
q_i^P=\frac{\log(1+P_i)}{\log(1+P_{max})},
\qquad
q_i^A=\frac{\log(1+A_i)}{\log(1+A_{max})},
\qquad
q_i^H=\frac{\log(1+H_i)}{\log(1+H_{max})}.
\]

The implementation combines these with persistence and stability, then multiplies by the impulse-support factor. Candidate quality is used for fallback selection and confidence, not as the final G1/G2 decision by itself.

## 8. Pair features

Every ordered pair \((i,j)\), \(x_i<x_j\), is considered when its observed ratio is inside the configured range:

\[
R_{min}\le R_{ij}=\frac{x_j}{x_i}\le R_{max}.
\]

The default broad detection range is \([1.60,2.35]\). The subsequent model fit may use a tighter assay-specific constraint.

### 8.1 Ratio agreement

\[
q_R(i,j)=
\exp\left[-\frac{1}{2}
\left(\frac{\log(R_{ij}/R_0)}{\tau_R}\right)^2\right],
\]

where \(R_0\) defaults to two but should be configurable by assay/instrument. Fox explicitly noted that the observed G2:G1 ratio may differ from exactly two [Fox1980].

### 8.2 Prominence, area, and persistence

For feature score \(q\), pair support uses the geometric mean:

\[
q_{pair}=\sqrt{q_iq_j}.
\]

This prevents one excellent peak from completely hiding a very poor partner.

### 8.3 Width/CV compatibility

For each peak:

\[
\widehat{CV}_i=
\frac{\widehat\sigma_i\Delta x}{x_i},
\]

where \(\Delta x\) is bin width. Compatibility is:

\[
q_W(i,j)=
\exp\left[-\frac{1}{2}
\left(
\frac{\log(\widehat{CV}_j/\widehat{CV}_i)}{\tau_W}
\right)^2\right].
\]

This is a soft preference, not a requirement that the two fitted CVs be identical.

### 8.4 Separation

Let \(d_{ij}=j-i\) and \(\overline W=(W_i+W_j)/2\). Then:

\[
q_D(i,j)=
\operatorname{clip}\left(
\frac{d_{ij}-\overline W}{\max(1,\overline W)},0,1
\right).
\]

Overlapping or barely separated candidates are penalized.

### 8.5 S-phase bridge evidence

Between the inner half-prominence shoulders, calculate:

\[
m_{ij}=\frac{\sum_{k\in B_{ij}}H_{\sigma}(k)}
{\sum_k H(k)}
\]

and the fraction \(c_{ij}\) of bridge bins above a small activity threshold. Then:

\[
q_B(i,j)=
\sqrt{
\left[1-\exp(-m_{ij}/\tau_B)\right]c_{ij}
}.
\]

This helps reject a sub-G1/G1 pair when a better G1/G2 pair is connected by a continuous S-phase distribution. Its weight remains limited because some real samples contain very few S-phase cells.

### 8.6 Edge support

Candidates too close to histogram boundaries relative to their measured widths are softly penalized because their shoulders and areas are truncated.

## 9. Total pair score

The default score is a weighted sum, with larger values better:

\[
Q(i,j)=
0.28q_R+0.14q_P+0.09q_A+0.09q_W+
0.14q_{persist}+0.08q_D+0.12q_B+0.06q_E.
\]

The weights are software defaults, not constants established by the historical DJ/DJF papers. They must remain configurable and should be validated against representative assay data.

JavaScript:

```js
import { detectCellCyclePeakPair } from './src/index.js';

const result = detectCellCyclePeakPair(edges, counts, {
  smoothingScales: [1, 2, 4],
  expectedRatio: 2.0,
  ratioRange: [1.60, 2.35],
  minPairScore: 0.52,
  minPairConfidence: 0.65
});

console.log(result.detection.status);
console.log(result.detection.confidence);
console.log(result.detection.selectedPair?.components);
console.log(result.autoPeakRegions);
```

## 10. Ambiguity confidence

For ranked scores \(Q_1\ge Q_2\ge\cdots\), define the score margin:

\[
\Delta Q=Q_1-Q_2.
\]

Margin evidence is:

\[
q_{margin}=1-\exp(-\Delta Q/\tau_M).
\]

A softmax share measures how concentrated the ranking is:

\[
q_{softmax}=
\frac{\exp(Q_1/T)}{\sum_r\exp(Q_r/T)}.
\]

The reported heuristic confidence is:

\[
C=
0.45Q_1+0.25q_{margin}+0.20q_{softmax}
+0.10\min(q_{G1},q_{G2}).
\]

Default states:

- `detected`: \(Q_1\ge0.52\) and \(C\ge0.65\);
- `low_confidence`: a plausible pair exists but evidence is weak or competing pairs are nearly tied;
- `inferred_g2`: no plausible pair exists, so G2/M is proposed near \(R_0\widehat\mu_{G1}\).

A three-peak pattern at approximately \(x,2x,4x\) often yields two plausible doubling pairs. The detector intentionally reports this as ambiguous rather than quietly pretending the labels are certain.

## 11. Automatic handle placement

For a detected G1 peak, use its cleaner **left** shoulder width; for G2/M use its cleaner **right** shoulder width. With multiplier \(k_h=2.75\):

\[
G1_{auto}=
[\widehat\mu_1-k_h\widehat\sigma_{1,left},
 \widehat\mu_1+k_h\widehat\sigma_{1,left}],
\]

\[
G2_{auto}=
[\widehat\mu_2-k_h\widehat\sigma_{2,right},
 \widehat\mu_2+k_h\widehat\sigma_{2,right}].
\]

Regions are clipped to the histogram domain and split at the midpoint if they overlap. They are displayed as editable proposals. After the user accepts or edits them, fitting follows the immutable semantic-region rules in [`PEAK_REGION_HANDLES.md`](PEAK_REGION_HANDLES.md).

## 12. Recommended UI behavior

- `detected`: show ordinary proposed handles and the confidence details in an expandable panel.
- `low_confidence`: highlight both selected and alternative pairs; require visible review before final reporting.
- `inferred_g2`: use a dashed G2/M region and label it **inferred from expected ratio**.
- always provide **Reset to automatic detection**;
- never move accepted handles during DJ/DJF/Watson optimization;
- export all candidate features, ranked pair scores, selected status, confidence, alternatives, smoothing scales, and final user edits.

## 13. Failure boundaries

No single-histogram peak detector can always distinguish among:

- a true G1/G2 pair;
- sub-G1 plus G1;
- overlapping ploidy populations;
- a synchronized S-phase wave resembling another peak;
- a late-S population hiding G2/M.

The hardened detector reduces fragile guesses and exposes ambiguity. It does not eliminate the need for user review, experimental metadata, residual diagnostics, or orthogonal markers.
