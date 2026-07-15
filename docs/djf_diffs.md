# Dean–Jett–Fox: legacy vs. staged implementation

> Audit date: 2026-07-14
>
> Legacy baseline: `7b5bed9c7cd9f9dfef18424c6b5233dbda9811d5`
>
> Staged audit base: current working tree based on
> `70e52f4783572ba52617702ab067ba5ab4815f7a`
>
> Fox primary source: [`fox_1980_djf_model.pdf`, equations on PDF page 2](../assets/misc/fox_1980_djf_model.pdf#page=2)

## Bottom line

**Scientific-fidelity verdict:** the primary Fox paper strengthens the original
conclusion: the legacy implementation is substantially closer to both
Dean–Jett and Fox. It approximates Fox equations (1)–(4)—Gaussian G1/G2 peaks
plus a quadratic latent S distribution broadened with a position-dependent
normal kernel—although its kernel-width rule becomes noncanonical when the
fitted peak CVs differ. The staged implementation retains equivalent Gaussian
peaks but replaces Fox equations (2) and (4) with a direct, compact-support
tapered quartic.

Neither implementation is a complete synchronous Fox model. Neither contains
the latent synchronous-S Gaussian defined by Fox equation (5) and subsequently
broadened by equation (2). The most accurate labels are therefore:

- legacy: **Dean–Jett/Fox-backbone**, with noncanonical constraints and
  broadening-width rule, but missing Fox equation (5);
- staged: **DJF-inspired Gaussian/bridge model**, not the published
  Dean–Jett S-phase equation; and
- neither: a complete implementation of Fox's synchronous-population model.

The staged pipeline is **not** a mechanical decomposition of the legacy
Dean–Jett–Fox (DJF) fitter. It deliberately replaces the old numerical model and
changes several behaviors that can materially affect fitted phase fractions:

- the S-phase equation;
- the G2/G1 center constraint and run-wide G1 anchor;
- whether the visible peak-detection stage controls the fit;
- the shared histogram range;
- singlet, debris, and aggregate handling; and
- the solver and reporting semantics.

The staged implementation also adds substantial capabilities that the legacy
path did not have: structural, time, scatter, and pulse-geometry QC; explicit
mask provenance and downstream invalidation; per-stage diagnostics; optional
contamination models; fit-quality statistics; residual warnings; and per-sample
failure isolation.

The highest-priority parity question is the S-phase basis. The legacy model
Gaussian-broadens a quadratic S-phase density at 64 integration nodes. The
staged model instead evaluates a direct Bernstein bridge that is exactly zero
outside the G1/G2 means. Those functions can fit very similar total curves while
assigning different area to G1, S, and G2.

## Published model and fidelity test

### Dean–Jett (1974)

The open primary paper describes the histogram as two normal peaks plus a
second-degree S-phase polynomial. The unbroadened polynomial exists only
between the G1 and G2 peak centers. Its elemental channels are then replaced by
normal curves having the same coefficient of variation (CV) as G1. In modern
notation, the construction is:

\[
H(x) = A_1\,\phi(x;X_1,\sigma_1)
     + A_2\,\phi(x;X_2,\sigma_2)
     + \int_{X_1}^{X_2} P_2(u)\,
       \phi\!\left(x;u,\frac{\sigma_1}{X_1}u\right)\,du,
\]

where \(P_2(u)=a+bu+cu^2\), \(\phi\) is a normalized Gaussian, and
\(\sigma_1/X_1\) is the G1 CV. Dean and Jett say that in practice all nine
parameters were allowed to vary. Their fitting criterion also uses
count-statistics weighting, whereas both repository versions default to
ordinary unweighted residuals.

This equation makes Gaussian convolution a model-defining feature, not merely
an implementation detail. It produces S-component shoulders beyond the latent
\(X_1..X_2\) interval even though the unbroadened S density itself is confined
to that interval.

### Fox (1980)

The attached primary paper gives the complete model on article page 72
([PDF page 2](../assets/misc/fox_1980_djf_model.pdf#page=2)). Fox retains the
three-component total

\[
F(x)=F_1(x)+F_s(x)+F_2(x).
\]

**Equation (1), G1:**

\[
F_1(x)=
\frac{N_1}{\sqrt{2\pi}\,\sigma_1}
\exp\!\left[-\frac{(x-x_1)^2}{2\sigma_1^2}\right].
\]

**Equation (2), broadened S phase:**

\[
F_s(x)=
\sum_{j=x_1}^{x_2} f(x_j)
\frac{1}{\sqrt{2\pi}\,\sigma_1(x_j/x_1)}
\exp\!\left[
  -\frac{(x-x_j)^2}
  {2\left[\sigma_1(x_j/x_1)\right]^2}
\right].
\]

**Equation (3), G2 + M:**

\[
F_2(x)=
\frac{N_2}{\sqrt{2\pi}\,\sigma_2}
\exp\!\left[-\frac{(x-x_2)^2}{2\sigma_2^2}\right].
\]

For asynchronous populations, Fox uses the same latent quadratic as
Dean–Jett:

\[
f(x_j)=A+Bx_j+Cx_j^2.
\qquad\text{(Fox equation 4)}
\]

For a complex S distribution, such as most synchronous populations, Fox adds
a floating normal curve to that **latent S-compartment density**:

\[
f(x_j)=A+Bx_j+Cx_j^2+
\frac{N_s}{\sqrt{2\pi}\,\sigma_s}
\exp\!\left[-\frac{(x_j-x_s)^2}{2\sigma_s^2}\right].
\qquad\text{(Fox equation 5)}
\]

The order of operations matters. Equation (5)'s Gaussian is not added directly
to the final observed histogram. It is added to \(f(x_j)\), after which the
entire polynomial-plus-Gaussian is passed through equation (2)'s
channel-specific broadening. The broadening width is
\(\sigma_1x_j/x_1\), which gives every S channel the G1 CV. By contrast, Fox
states that the intrinsic Gaussian's own CV, \(\sigma_s/x_s\), has no
relationship to the G1 CV.

The asynchronous form has nine fitted parameters. The synchronous form has 12:
\(N_1,\sigma_1,x_1,N_2,\sigma_2,x_2,A,B,C,N_s,\sigma_s,x_s\).
Fox normally fits the G2 center and width independently. When late S obscures
G2, the paper allows both to be tied to G1, including equal CVs and a
system-calibrated center ratio; Fox reports about 1.9 for his instrument rather
than assuming exactly 2.0.

Therefore, a complete code-level implementation of Fox's synchronous mode
requires equation (5)'s three latent parameters **and** equation (2)'s
subsequent G1-CV broadening. Aggregate or debris terms, and a bare Gaussian
added after broadening, do not satisfy that test.

### Side-by-side fidelity matrix

| Published feature | Legacy (`7b5bed9`) | Staged | More faithful |
|---|---|---|---|
| G1 and G2 normal distributions | Yes; normalized/area parameterization | Yes; peak-height parameterization | Tie; these are equivalent parameterizations |
| Quadratic latent S density | Yes; quadratic Bernstein basis | No; multiplies that basis by `4t(1-t)`, making a quartic | **Legacy** |
| Fox equation (2): S density Gaussian-broadened across G1–G2 | Yes; 64-node continuous midpoint analogue | No; direct evaluation only | **Legacy, decisively** |
| Equation (2) broadening uses constant G1 CV | Approximate: linearly interpolates `sigma1..sigma2`; exact only when peak CVs are equal | Absent because S is not broadened | **Legacy**, with a material caveat |
| G2 center and width | Independently fitted within bounds, matching Fox's normal mode | `mu2 = R * mu1`; `R = 2` fixed by default, but CV2 is not tied to CV1 | **Legacy** for Fox's normal mode; neither implements Fox's conditional center-and-CV tie exactly |
| Fox parameter count | Nine DJ-style parameters | Eight free base parameters by default because `R` is fixed; Stage 7's extra parameters have different meanings | **Legacy** for asynchronous equation (4); **neither** has the 12-parameter synchronous model |
| Count-statistics-weighted fit | No | Optional, but off by default | Neither by default; staged has the capability |
| Fox equation (5): latent synchronous-S Gaussian, then equation (2) broadening | No `Ns`, `sigmaS`, or `xS` | No equivalent parameters or operation | **Neither** |

Fox prints equation (2) as a discrete channel sum. The legacy 64-node integral
is a continuous quadrature analogue, not a literal transcription. Also,
although Fox calls the operation a convolution, its kernel width changes with
\(x_j\); mathematically it is a heteroscedastic Gaussian mixture rather than a
stationary convolution.

The decisive difference is the S-phase equation. The legacy Bernstein form

\[
q(t)=b_0(1-t)^2+2b_1t(1-t)+b_2t^2
\]

is exactly a quadratic after the affine substitution
\(t=(u-X_1)/(X_2-X_1)\). The staged form is instead

\[
s_{\mathrm{staged}}(x)=4t(1-t)q(t),
\]

which is generally degree four, is exactly zero at and outside both peak
centers, and is never convolved with measurement broadening. Fox normally lets
G2 float; his conditional tied mode combines equal peak CVs with an
instrument-calibrated center ratio (about 1.9 in his system). The staged fixed
ratio of 2 without an equal-CV tie therefore does not reproduce that mode.
Adding Stage 7 contamination terms does not compensate for the S-model
mismatch.

This is a fidelity judgment, not a claim about which optimizer is more robust
or which curve will have the lower SSE on a particular sample. A
noncanonical model can fit some histograms better; that does not make it the
published named model.

## Provenance

`7b5bed9` is the last clean snapshot before the staged work began, not the first
commit that ever introduced DJF. It is the direct parent of the staged scaffold:

| Commit | Role |
|---|---|
| `7b5bed9` — “Finishing restructure” | Last pre-staged snapshot; active implementation is `js/analysis/djf.js`. |
| `67b649a` — “Scaffold staged DJF pipeline” | First staged-pipeline commit; direct child of `7b5bed9`. |
| `ac4243e` — “Add DJF fit extensions and reporting” | Last commit before the application switch. The legacy file still has the same Git blob as at `7b5bed9` (`20dde40b…`). |
| `22a8130` — “Wire staged DJF pipeline into the application” | Switches the application to the staged implementation and deletes `js/analysis/djf.js`. |
| `70e52f4` | Committed staged numeric baseline used by this audit. |

At audit time the numeric stage modules matched `70e52f4`. The current UI work
also separates the pre-model QC controls (Stages 0–3) from modeling Run All
(Stages 4–8); that orchestration detail is reflected below.

The historical source can be inspected without changing the working tree:

```bash
git show 7b5bed9:js/analysis/djf.js
git diff 7b5bed9..HEAD -- js/analysis/djf.js js/analysis/djf/
```

The legacy numeric core first appeared under earlier names (`js/djf_gpt.js`,
then `js/analysis/djf.js`), but its relevant model equation remained essentially
unchanged through the pre-staged baseline. This comparison therefore uses the
last version that users actually ran before the staged switch.

## Executive comparison

| Area | Legacy behavior | Staged behavior | Potential impact |
|---|---|---|---|
| S phase | 64-node Gaussian-convolved quadratic Bernstein density | Direct tapered Bernstein bridge | **High** — different component basis and tail allocation |
| G1/G2 amplitudes | Normalized Gaussians; amplitudes are area-like | Peak-height Gaussians | **High** for parameter interpretation |
| G2/G1 centers | Centers optimized independently within broad, initialization-relative bounds | `G2 = 2 × G1` by default; ratio can be unlocked programmatically | **High** on non-ideal ratios |
| Cross-sample G1 | If valid pairs exist, their median G1 constrains each shown fit to ±10% | Samples fit independently | **Medium–high** for consistency and difficult samples |
| Peak workflow | Shared/manual threshold feeds both run anchor and fit | Stage 5 result is stored but not passed to Stage 6 | **High** workflow/initialization difference |
| Histogram range | Shared linear `[0, sampled p99.5]` | Stage 4 snapshots shared full retained min/max | **Medium–high** outlier sensitivity |
| Singlet gate | Log A/H band plus log W band; intersects both when available | Robust PCA ridge on raw A/H, falling back to raw A/W | **High** event-population difference |
| Debris/aggregates | Optional event removal before histogramming | Separate Stages 0–3 can gate events; Stage 7 may additionally model contamination | **High**, but not a one-for-one replacement |
| Fractions | Discrete component sums; G1/S/G2 only | Trapezoidal areas; biological and contamination denominators reported separately | Mostly a reporting improvement; model differences dominate |
| Solver | Third-party bounded LM; exceptions/invalid results become `null` | In-repository projected LM with diagnostics | **Medium**, numerical effect not yet benchmarked broadly |
| QC/reporting | Minimal correction summary and phase moments | Mask provenance, GoF, residual structure, warnings, contamination | Clear staged expansion |

The side-by-side snippets below are focused excerpts. Guards, returned metadata,
and unchanged setup are occasionally elided; the linked/current files and Git
references are authoritative.

## 1. S-phase model and peak parameterization

This is the largest mathematical difference.

<table>
<thead>
<tr>
<th width="50%">Legacy — <code>7b5bed9:js/analysis/djf.js</code></th>
<th width="50%">Staged — <a href="../js/analysis/djf/djf_components.js"><code>djf_components.js</code></a></th>
</tr>
</thead>
<tbody>
<tr>
<td valign="top"><pre><code class="language-js">const S_NODES = 64;

function gaussian(distance, sigma) {
  return Math.exp(
    -(distance * distance) / (2 * sigma * sigma)
  ) / (sigma * SQRT_2PI);
}

const du = span / S_NODES;
for (let k = 0; k &lt; S_NODES; k += 1) {
  const pos = (k + 0.5) / S_NODES;
  const u = m1 + pos * span;
  const sigma_u =
    sigma1 + (sigma2 - sigma1) * pos;
  s += s_phase_height(pos, b0, b1, b2)
    * gaussian(value - u, sigma_u) * du;
}</code></pre></td>
<td valign="top"><pre><code class="language-js">export function gaussianPeak(
  xValue, mu, sigma, amplitude
) {
  const z = (xValue - mu) / sigma;
  return amplitude * Math.exp(-0.5 * z * z);
}

export function evaluateSBridge(
  xValue, mu1, mu2, s0, s1, s2
) {
  if (xValue &lt;= mu1 || xValue &gt;= mu2) return 0;
  const t = (xValue - mu1) / (mu2 - mu1);
  const u = 1 - t;
  const polynomial =
    s0 * u * u + 2 * s1 * t * u + s2 * t * t;
  return 4 * t * u * polynomial;
}</code></pre></td>
</tr>
</tbody>
</table>

Sources: legacy lines 16 and 366–391; current
[`djf_components.js`](../js/analysis/djf/djf_components.js), especially
`gaussianPeak`, `evaluateSBridge`, and `evaluateBaseAt`.

Consequences:

- The legacy S component is a numerical convolution. It has shoulders/tails
  outside `m1..m2`, and its local broadening interpolates from `sigma1` to
  `sigma2`.
- The staged S component is a direct curve. It is identically zero at and
  outside `mu1..mu2`.
- The legacy peak Gaussian is normalized, so `a_g1` and `a_g2` are area-like.
  The staged `A1` and `A2` are peak heights. Peak parameters cannot be compared
  directly between implementations even when their plotted curves look alike.
- The current theoretical prose still describes a broadened S integral in
  [`dean_jett_fox_implementation.md`](dean_jett_fox_implementation.md), while
  the shipped code uses the direct bridge. The implementation plan explicitly
  acknowledges that the staged phase model differs from and replaces the old
  one in [`djf_impl_plan.md`](djf_impl_plan.md).
- Despite the DJF product/module name, the legacy code has no `Ns`, `sigmaS`, or
  `xS` corresponding to Fox equation (5). The staged base model has no such
  parameters either. Stage 7's aggregate and debris parameters model different
  functions and cannot substitute for them.

Against the published equations, the legacy S-phase core is more faithful to
both Dean–Jett and the backbone of Fox's model: it approximates Fox equations
(2) and (4). It is not a complete synchronous Fox model because it omits
equation (5), and this fidelity result does not establish that legacy will
produce better biological estimates on every data set.

## 2. Peak centers, run-wide anchoring, and solver constraints

<table>
<thead>
<tr>
<th width="50%">Legacy</th>
<th width="50%">Staged</th>
</tr>
</thead>
<tbody>
<tr>
<td valign="top"><pre><code class="language-js">const run_g1 = djf.estimate_run_g1(
  series, threshold_value
);

for (const s of shown_series) {
  const params = djf.fit(
    s.points, range, threshold_value, run_g1
  );
}

const m1_lo = g1_hint != null
  ? g1_hint * 0.9 : /* local bound */;
const m1_hi = g1_hint != null
  ? g1_hint * 1.1 : /* local bound */;

const m2_lo = Math.max(
  range[0], m1_initial * 1.65, m1_hi + min_sigma
);
const m2_hi = Math.max(
  m2_lo + min_sigma,
  Math.min(range[1] + 0.1 * span, m1_initial * 2.35)
);</code></pre></td>
<td valign="top"><pre><code class="language-js">export const DEFAULT_OPTIONS = Object.freeze({
  cvMin: 0.01,
  cvMax: 0.20,
  ratioTarget: 2,
  ratioMin: 1.70,
  ratioMax: 2.30,
  unlockRatio: false,
});

const ratio = options.unlockRatio
  ? clamp(
      projected[PARAMETER_INDEX.R],
      options.ratioMin,
      options.ratioMax,
    )
  : options.ratioTarget;

const mu2 = ratio * mu1;</code></pre></td>
</tr>
</tbody>
</table>

Sources: legacy `estimate_run_g1`, `fit`, and the historical
`js/plotting/render.js`; current
[`stage6_fit.js`](../js/analysis/djf/stage6_fit.js) and
[`djf_components.js`](../js/analysis/djf/djf_components.js).

When at least one plotted series supplied a valid detected G1/G2 pair, the
legacy application estimated the median of those G1 positions and constrained
each **shown fit** to ±10% of that anchor. If no pair was found, `g1_hint` was
`null` and the fit instead used local bounds of 0.75–1.25× its initializer. G2
was an independent fit parameter with broad bounds relative to the **initial**
G1. The staged application has no run-wide anchor: each sample initializes and
fits independently. In the normal UI path, Stage 6 receives default options,
fixing G2 at exactly twice G1. `unlockRatio: true` is supported by the API, but
the UI does not currently expose it.

The solver also changed from `ml-levenberg-marquardt` (160-iteration cap,
bounded parameter arrays, exceptions converted to `null`) to the local projected
LM solver (150-iteration default plus convergence diagnostics). The solver's
independent numerical effect has not yet been isolated from the model and
constraint changes.

## 3. Stage 5 does not seed or constrain Stage 6

The old visible threshold and peak workflow directly affected fitting. In the
staged orchestrator, Stage 5 is diagnostic-only with respect to Stage 6.

<table>
<thead>
<tr>
<th width="50%">Legacy application flow</th>
<th width="50%">Staged application flow</th>
</tr>
</thead>
<tbody>
<tr>
<td valign="top"><pre><code class="language-js">if (peak_threshold == null) {
  set_peak_threshold(0.05 * shown_max);
}
const threshold_value = peak_threshold;

const run_g1 = djf.estimate_run_g1(
  series, threshold_value
);

const params = djf.fit(
  s.points, range, threshold_value, run_g1
);</code></pre></td>
<td valign="top"><pre><code class="language-js">export function run_stage5(row, options = {}) {
  const histogram = require_histogram(state, 5);
  const result = stage5.detectDNAContentPeaks(
    histogram.y,
    {
      histogramMin: histogram.min,
      binWidth: histogram.binWidth,
      ...options,
    },
  );
  state.peaks = result;
}

export function run_stage6(row, options = {}) {
  const histogram = require_histogram(state, 6);
  const result = stage6.fitCellCycleHistogram(
    histogram.x, histogram.y, options
  );
  state.baseFit = result;
}</code></pre></td>
</tr>
</tbody>
</table>

Source: current [`index.js`](../js/analysis/djf/index.js), `run_stage5` and
`run_stage6`.

Stage 6 detects its own candidates inside `initializeParameters()` and never
reads `state.peaks`. The two current detectors also use different defaults:
Stage 5 accepts ratios from 1.8–2.1, whereas Stage 6 considers candidate pairs
from 1.45–2.55 before applying its own scoring/fallback and final ratio
constraint. A normal Stage 5 result with `found: false` does not prevent Run All
from proceeding to Stage 6.

This is best described as a workflow disconnect, not dead code: Stage 5 still
provides inspection/reporting information. The UI should either label it as
diagnostic, pass its automatically selected peaks forward as Stage 6 hints or
constraints, or add a separate manual-selection path if that is desired.

## 4. Shared histogram range

Both applications use one range across the selected samples, but they choose
that range differently.

<table>
<thead>
<tr>
<th width="50%">Legacy render-time range</th>
<th width="50%">Staged Stage 4 snapshot</th>
</tr>
</thead>
<tbody>
<tr>
<td valign="top"><pre><code class="language-js">const stride = Math.max(
  1, Math.floor(total / 50000)
);
// collect sampled finite values, then sort

let lo = at(0.005);
let hi = at(0.995);

if (!positive_only) {
  lo = 0;
  if (!(hi &gt; lo)) hi = 1;
}
return [lo, hi];</code></pre></td>
<td valign="top"><pre><code class="language-js">for (const row of targets) {
  const data = require_row_data(row);
  const mask = recompute_final_mask(row);
  for (
    let i = 0;
    i &lt; data.channels.DNA_A.length;
    i += 1
  ) {
    if (!mask[i]) continue;
    const value = data.channels.DNA_A[i];
    if (!Number.isFinite(value)) continue;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
}
return [minimum, maximum];</code></pre></td>
</tr>
</tbody>
</table>

Sources: legacy `7b5bed9:js/plotting/data.js`,
`shared_range_for_values`; current
[`index.js`](../js/analysis/djf/index.js), `shared_histogram_range`.

On the normal legacy linear DNA axis, the effective range was
`[0, sampled p99.5]`, recomputed with the histogram during rendering. In the
normal staged multi-sample UI path, Stage 4 snapshots one shared full finite
min/max **after whichever QC masks are currently active** and stores the bins.
Changing the bin control or QC later does not silently re-bin that fit; Stage 4
must be rerun. One surviving extreme can therefore widen every selected
sample's frozen bins. The current modeling Run All executes Stages 4–8 and does
not itself run the separate pre-model QC controls, so this protection depends on
which filters the user has applied.

The direct `run_stage4(row)` API is a qualification: without an explicitly
supplied range it derives min/max from that one row. The exported programmatic
`run_all(row)` has the same behavior unless Stage 4 receives a range option. The
shared-extrema behavior comes from the multi-row UI/batch path, which passes
`shared_histogram_range(rows)` into every Stage 4 call.

The private legacy helper in `djf.js` also used p0.2–p99.8 for an internal
histogram. That was not the final live-fit range and should not be confused with
the plotting layer's `[0, p99.5]` behavior above.

## 5. Singlet gating

The gates use different coordinate systems and combine companion channels
differently.

<table>
<thead>
<tr>
<th width="50%">Legacy optional doublet gate</th>
<th width="50%">Staged Stage 3 singlet gate</th>
</tr>
</thead>
<tbody>
<tr>
<td valign="top"><pre><code class="language-js">const ratio = mode === "width"
  ? Math.log(b)
  : Math.log(a) - Math.log(b);

const lower = median - 4 * sigma;
const upper = median + 4 * sigma;

const height_gate = robust_ratio_mask(
  dna_a, dna_h, current_mask, "height"
);
const width_gate = robust_ratio_mask(
  dna_a, dna_w, current_mask, "width"
);

if (height_gate.available) {
  mask = combine_mask(mask, height_gate.mask);
}
if (width_gate.available) {
  mask = combine_mask(mask, width_gate.mask);
}</code></pre></td>
<td valign="top"><pre><code class="language-js">// Prefer DNA-A/Height, fall back to DNA-A/Width.
if (dnaH &amp;&amp; dnaH.length === eventCount) {
  return { areaChannel: dnaA,
           secondaryChannel: dnaH };
}
if (dnaW &amp;&amp; dnaW.length === eventCount) {
  return { areaChannel: dnaA,
           secondaryChannel: dnaW };
}

const points = indexedPoints.map(item =&gt; item.point);
const ridge = fitRobustRidge2D(points, ridgeOptions);
const threshold = kMAD * ridge.distanceMAD;
// defaults: kMAD = 5, minimumPoints = 20</code></pre></td>
</tr>
</tbody>
</table>

Sources: legacy `robust_ratio_mask` and `apply_aggregate_mask`; current
[`stage3_singlet_gate.js`](../js/analysis/djf/stage3_singlet_gate.js).

Precisely, the legacy code used a log A/H band and a log-width band. When both
companions were usable, both masks were intersected. It required at least 64
eligible ratios and used a median ±4 robust-sigma band. The staged code fits an
iteratively reweighted PCA ridge in raw `[DNA_A, DNA_H]` space, falling back to
raw `[DNA_A, DNA_W]`; it does not use both at once. Its defaults are 5 MAD and a
20-point minimum. These gates are not geometrically equivalent and may retain
different event populations.

## 6. Debris and aggregate semantics

The legacy correction deletes events before histogramming. Stage 7 retains the
histogram and may allocate modeled area to contamination after the base fit.

<table>
<thead>
<tr>
<th width="50%">Legacy preprocessing</th>
<th width="50%">Staged Stage 7 model</th>
</tr>
</thead>
<tbody>
<tr>
<td valign="top"><pre><code class="language-js">const lower = Math.max(
  q_lo, g1_peak.x - 4 * sigma1, 0.45 * g1_peak.x
);
const upper = Math.min(
  q_hi,
  Math.max(g2_peak.x + 4 * sigma2,
           2.65 * g1_peak.x)
);

debris_mask[i] = positive_number(value)
  &amp;&amp; (!bounds
      || (value &gt;= bounds.lo &amp;&amp; value &lt;= bounds.hi));

const values = compact_by_mask(dna_a, mask);</code></pre></td>
<td valign="top"><pre><code class="language-js">function evaluateAggregateAt(xValue, parameters) {
  const p = parameters[INDEX.P_AGGREGATE];
  return 0.5 * p
    * evaluateBaseAt(xValue / 2, parameters).total;
}

function evaluateDebrisAt(xValue, xMinimum, parameters) {
  const amplitude = parameters[INDEX.DEBRIS_AMPLITUDE];
  const tau = parameters[INDEX.DEBRIS_TAU];
  const mu1 = parameters[INDEX.MU1];
  const sigma1 = parameters[INDEX.SIGMA1];
  const decay = Math.exp(
    -Math.max(0, xValue - xMinimum) / tau
  );
  const cutoffCenter = mu1 - sigma1;
  const cutoffWidth = Math.max(0.25 * sigma1, 1e-12);
  const leftWindow = logistic(
    (cutoffCenter - xValue) / cutoffWidth
  );
  return amplitude * decay * leftWindow;
}</code></pre></td>
</tr>
</tbody>
</table>

Sources: legacy `debris_bounds` and `prepare_row`; current
[`stage7_extend.js`](../js/analysis/djf/stage7_extend.js).

The staged code also provides four event-removing pre-model QC stages:

1. structural validity and saturation;
2. time/acquisition stability;
3. FSC/SSC main biological-cloud gating; and
4. pulse-geometry singlet gating.

In the current UI these are separate controls, not automatic steps inside the
modeling Run All (Stages 4–8). Stage 7 therefore sees whichever gated event
population the user has chosen to apply before histogramming.

Stage 3 exclusion and Stage 7 aggregate modeling can both occur, so Stage 7 is
not a direct replacement for the old doublet mask. Stage 7 only adds candidates
when residual templates suggest them and uses conservative selection defaults:
at least 2% relative SSE improvement, BIC improvement of 6, and 20% targeted
residual improvement.

The shipped aggregate term is the simple `0.5 * p * F(x/2)` curve and the debris
term is a left-windowed exponential. They are not the self-convolution/Bagwell
forms discussed elsewhere in the design prose. A general background component
also remains explicitly unimplemented; the Stage 8 orchestration result records
“General background model has not yet been specified.”

## 7. Fractions, diagnostics, and failure behavior

<table>
<thead>
<tr>
<th width="50%">Legacy reporting</th>
<th width="50%">Staged Stage 8 reporting</th>
</tr>
</thead>
<tbody>
<tr>
<td valign="top"><pre><code class="language-js">stats[key].weight += weight;
stats[key].sum += weight * point.x;
stats[key].sum_sq += weight * point.x * point.x;

const total =
  stats.g1.weight + stats.s.weight + stats.g2.weight;

item.percent = item.weight / total * 100;
item.mean = item.sum / item.weight;
item.stdev = Math.sqrt(variance);</code></pre></td>
<td valign="top"><pre><code class="language-js">const areas = {
  g1: integrateTrapezoidal(x, g1),
  s: integrateTrapezoidal(x, s),
  g2: integrateTrapezoidal(x, g2),
  aggregate: integrateTrapezoidal(x, aggregate),
  debris: integrateTrapezoidal(x, debris),
};

const biologicalSingletTotal =
  areas.g1 + areas.s + areas.g2;

const totalModeledArea = biologicalSingletTotal
  + areas.aggregate + areas.debris;</code></pre></td>
</tr>
</tbody>
</table>

Source: legacy `phase_stats`; current
[`stage8_report.js`](../js/analysis/djf/stage8_report.js).

The current biological G1/S/G2 fractions deliberately exclude aggregate and
debris from their denominator. Contamination fractions are reported separately
against all modeled area. Stage 8 also calculates SSE, MSE, RMSE, MAE, R²,
adjusted R², Pearson chi-square, AIC/BIC, boundary checks, peak checks, residual
autocorrelation/local bias, pulse-geometry checks, and user-facing warnings.

The legacy sum omits a common bin-width multiplier, but its live histograms are
uniformly spaced, so that omission mostly cancels in normalized phase fractions.
The more important fraction differences are the fitted component shapes,
constraints, histogram range, and input events—not sum versus trapezoid alone.

Legacy solver exceptions and invalid parameter results became `null`, after
which rendering silently skipped the sample. The staged code validates array
lengths and values, preserves solver diagnostics, tracks stage provenance, invalidates
dependent products when an upstream gate changes, and lets the UI report sample
failures without discarding successful samples.

## 8. Reproduced smoke comparison

This is a targeted numerical check, not a scientific validation set. Both
fitters received the same already-binned `x/y` arrays, so it isolates
model/fitting/reporting differences rather than event QC or histogram building.

### Repository deterministic histogram

The fixture is
[`tests/unit/test_harness.html`](../tests/unit/test_harness.html)'s 256-bin
histogram over 20,000–200,000:

```js
const g1 = Math.exp(-0.5 * Math.pow((x - 64000) / 4500, 2)) * 800;
const g2 = Math.exp(-0.5 * Math.pow((x - 128000) / 6000, 2)) * 400;
const s = Math.max(0, 60 - Math.abs(x - 96000) / 1500);
const y = g1 + s + g2;
```

The audit served the historical snapshot and current application separately and
used these calls. In the legacy call, the two `null` arguments mean the default
5%-of-maximum peak threshold and no run-wide G1 hint:

```js
// Legacy page at 7b5bed9
const points = TestUtils.buildBimodalHistogram(256);
const p = PhaseFinder.djf.fit(points, [20000, 200000], null, null);
const legacyFractions = PhaseFinder.djf.fractions(points, p);

let legacySse = 0;
for (const point of points) {
  const c = PhaseFinder.djf.components(point.x, p);
  const fitted = c.g1 + c.s + c.g2;
  legacySse += (fitted - point.y) ** 2;
}
```

```js
// Current staged page, Stage 6 defaults; Stage 7 is not run
const { x, y } = TestUtils.buildDJFHistogram(256);
const fit = PhaseFinder.pipeline.stage6.fitCellCycleHistogram(x, y);
const report = PhaseFinder.pipeline.stage8.summarizeCellCycleFit(
  fit,
  { pulseGeometryAvailable: true },
);
const stagedFractions = report.fractions.biologicalSinglets;
const stagedSse = fit.diagnostics.sse;
```

`pulseGeometryAvailable: true` only avoids an unrelated warning; it does not
change fitted curves or fractions. Both SSE values are unweighted sums of
`(fitted - observed)²` at the same 256 bin centers.

| Result | Legacy | Staged | Staged − legacy |
|---|---:|---:|---:|
| G1 | 50.2055% | 51.1561% | +0.9506 pp |
| S | 13.6351% | 11.7391% | −1.8960 pp |
| G2 | 36.1593% | 37.1048% | +0.9455 pp |
| SSE | 51,051.58 | 36,954.91 | −14,096.67 |

On this simple exact-2:1 fixture, the staged model has the lower total-curve SSE
and differs by less than two percentage points in each phase. That does not test
the fixed-ratio behavior on samples whose G2 is not exactly 2×G1.

### Required model-mismatch regression

A durable follow-up should generate noiseless curves from both S-phase bases and
fit each curve with both implementations. It should preserve the full parameter
vector, grid, options, fitted curves, component areas, and residual diagnostics.
That test is important because a high total-curve R² does not guarantee that two
different bases assign the same G1/S/G2 fractions. No unpublished ad hoc numbers
are used as evidence here.

Limitations:

- only one simple synthetic curve was reproduced;
- no real FCS validation set or external ground truth was used;
- the check bypasses event QC and histogram-range construction;
- the legacy call has no run-wide anchor, and the staged call bypasses Stage 5
  and Stage 7;
- the fixture's exact 2:1 peaks understate the fixed-ratio change;
- SSE measures total-curve fit, not component identifiability; and
- the reproduction should be promoted into a checked-in regression test
  before these exact values are treated as durable acceptance thresholds.

## 9. Recommended decisions and regression coverage

1. **Align the equation with the product name.** If the product is intended to
   implement Dean–Jett or Fox's asynchronous mode, implement equations (2) and
   (4) with the G1-CV width rule. If it is intended to implement Fox's
   synchronous mode, add `Ns`, `sigmaS`, and `xS` to the latent equation (5)
   and pass the resulting polynomial-plus-Gaussian through equation (2).
   Otherwise rename the staged model so that code, theory documentation, UI
   labels, and tests do not claim the published model.
2. **Define the role of Stage 5.** Either pass its automatically selected peaks
   into Stage 6 or label it clearly as an independent diagnostic whose result
   does not control the fit. Add a manual-selection path separately if wanted.
3. **Confirm center defaults.** Fox normally floats the G2 center and width. His
   fallback for an obscured G2 ties both the center ratio and CV to G1, using a
   separately calibrated ratio (about 1.9 in his system). Decide whether exact
   `G2 = 2 × G1`, independent peak CVs, no run-wide anchor, and no UI ratio
   control are intentional departures for the expected data.
4. **Make the shared range robust.** Restore a pooled upper quantile, add
   explicit outlier handling, or make a full retained range an intentional,
   visible choice.
5. **Add old-versus-new golden tests.** On representative real FCS files and
   difficult synthetic cases, record at least:
   - retained event counts and removal reasons per gate;
   - shared range, bin width, and histogram counts;
   - detected peaks and any manual hints;
   - fitted means, CVs, ratio, and convergence state;
   - G1/S/G2 and contamination fractions;
   - SSE/R² plus residual warnings; and
   - behavior on weak G2, G2-dominant, off-2:1, debris-heavy, and aggregate-heavy
     samples.
6. **Keep the staged engineering improvements.** Mask provenance, invalidation,
   input validation, optional-channel skips, per-sample isolation, diagnostics,
   and reporting remain useful regardless of which model equation is selected.

## Interpretation

“High impact” means that a difference can plausibly alter fitted outputs; it is
not a claim that every real sample will change materially. Likewise, lower SSE
or higher R² does not by itself prove more accurate biological fractions when
the component bases differ. Some changes—especially expanded QC and diagnostics—
are intentional capabilities rather than parity defects.

This document is an audit only. It does not restore or remove either
implementation.

## External sources

1. Phillip N. Dean and James H. Jett, “Mathematical Analysis of DNA
   Distributions Derived from Flow Microfluorometry,” *Journal of Cell Biology*
   60(2), 523–527 (1974):
   [open full text](https://pmc.ncbi.nlm.nih.gov/articles/PMC2109170/) and
   [DOI 10.1083/jcb.60.2.523](https://doi.org/10.1083/jcb.60.2.523).
2. Michael H. Fox, “A Model for the Computer Analysis of Synchronous DNA
   Distributions Obtained by Flow Cytometry,” *Cytometry* 1(1), 71–77 (1980):
   [attached primary paper, equations on article page 72 / PDF page 2](../assets/misc/fox_1980_djf_model.pdf#page=2),
   [indexed record](https://europepmc.org/article/MED/7023881), and
   [DOI 10.1002/cyto.990010114](https://doi.org/10.1002/cyto.990010114).
3. FlowJo, “Cell Cycle: Univariate”:
   [public DJ/DJF model description](https://docs.flowjo.com/flowjo/experiment-based-platforms/cell-cycle-univariate/).

The equations and fitting details above are transcribed from the two primary
papers. Fox equations (1)–(5) were visually checked against article page 72 in
the attached PDF; the weighted-fitting discussion continues on pages 72–73.
FlowJo is retained only as a modern corroborating description, not as the source
of the Fox equations.
