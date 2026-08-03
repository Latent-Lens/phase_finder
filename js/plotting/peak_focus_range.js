// Computes a DISPLAY x-range that frames the G1 / S / G2/M region of a DNA
// histogram, so the plot is not dominated by empty high-DNA axis and low-DNA
// debris.
//
// DOMAIN-01, and the reason this module exists separately: this produces a
// VIEWPORT range only. It is written to axis_range_override, never to
// analysis_domain_override, so framing the plot cannot change a histogram, a
// result key, or a reported fraction. Trimming what you LOOK at and trimming
// what you FIT are different operations and PhaseFinder keeps them apart.
//
// The right edge follows G2/M's own tail. The left edge follows G1's tail but is
// additionally floored so it never reaches down into the sub-G1 debris: debris
// sits at very low DNA content and, being tall and narrow, would otherwise
// dominate the y-scale and squash the peaks the user is actually reading.

// How many sigma beyond each fitted peak centre to show. 4 sigma covers
// ~99.99% of a Gaussian peak, so the visible tail is genuinely complete rather
// than clipped mid-slope.
export const PEAK_TAIL_SIGMA = 4;

// A little extra breathing room beyond the tails, as a fraction of the framed
// G1-to-G2 span, so the peaks do not sit flush against the axis.
export const FRAME_MARGIN_FRACTION = 0.05;

// The debris floor search stops here: debris lies below G1, and anything above
// this fraction of the G1 centre is G1's own left flank rather than debris.
const DEBRIS_SEARCH_CEILING = 0.75;

/*

Purpose:
	Finds the valley between the sub-G1 debris and the G1 peak -- the lowest
	point of the histogram below G1 -- so the view can start just above it.

	Without this, framing purely on "G1 centre minus 4 sigma" can reach into the
	debris spike on samples where debris sits close to G1, and the debris then
	sets the y-scale for the whole plot.

Input:
	centers [array]: histogram bin centres, ascending
	counts [array]: per-bin counts
	g1Mean [number]: the fitted G1 centre

Output:
	floor [number|null]: the x position of the debris/G1 valley, or null when no
	                     debris shoulder is present below G1

*/
export function debris_valley(centers, counts, g1Mean) {
  if (!centers?.length || centers.length !== counts?.length || !(g1Mean > 0)) return null;
  const ceiling = g1Mean * DEBRIS_SEARCH_CEILING;

  // Highest bin strictly below the ceiling -- the debris peak, if there is one.
  let debrisIndex = -1;
  let debrisHeight = 0;
  for (let i = 0; i < centers.length && centers[i] < ceiling; i += 1) {
    if (counts[i] > debrisHeight) { debrisHeight = counts[i]; debrisIndex = i; }
  }
  if (debrisIndex < 0) return null;

  // The G1 peak's own bin, so the valley is searched between the two.
  let g1Index = debrisIndex;
  let g1Height = 0;
  for (let i = debrisIndex; i < centers.length; i += 1) {
    if (centers[i] > g1Mean * 1.25) break;
    if (counts[i] > g1Height) { g1Height = counts[i]; g1Index = i; }
  }
  if (g1Index <= debrisIndex) return null;

  // A debris shoulder only counts as one if it is a real separate feature: it
  // must be meaningfully shorter than G1 (otherwise we found G1 twice) and
  // separated from it by a genuine trough.
  let valleyIndex = debrisIndex;
  let valleyHeight = Infinity;
  for (let i = debrisIndex; i <= g1Index; i += 1) {
    if (counts[i] < valleyHeight) { valleyHeight = counts[i]; valleyIndex = i; }
  }
  const trough = valleyHeight <= 0.5 * Math.min(debrisHeight, g1Height);
  return trough ? centers[valleyIndex] : null;
}

/*

Purpose:
	The display x-range that frames G1 through G2/M for one fitted sample.

Input:
	spec [object]: {
	  g1Mean, g1Sigma, g2Mean, g2Sigma [number]: the fitted peaks,
	  centers, counts [array]: the histogram, used only to avoid the debris,
	  tailSigma [number]: how many sigma of tail to include,
	  marginFraction [number]: extra breathing room }

Output:
	range [object|null]: { min, max, debrisFloor } in data units, or null when the
	                     peaks are unusable

*/
export function peak_focus_range({
  g1Mean, g1Sigma, g2Mean, g2Sigma,
  centers = null, counts = null,
  tailSigma = PEAK_TAIL_SIGMA,
  marginFraction = FRAME_MARGIN_FRACTION,
} = {}) {
  if (![g1Mean, g2Mean].every((v) => Number.isFinite(v) && v > 0)) return null;
  if (!(g2Mean > g1Mean)) return null;
  const s1 = Number.isFinite(g1Sigma) && g1Sigma > 0 ? g1Sigma : 0.05 * g1Mean;
  const s2 = Number.isFinite(g2Sigma) && g2Sigma > 0 ? g2Sigma : 0.05 * g2Mean;

  let min = g1Mean - tailSigma * s1;
  const max = g2Mean + tailSigma * s2;

  // Never show below the debris/G1 valley, and never below zero.
  const floor = centers && counts ? debris_valley(centers, counts, g1Mean) : null;
  if (floor != null && floor > min) min = floor;
  if (min < 0) min = 0;

  const margin = marginFraction * Math.max(max - min, 1e-9);
  const framedMin = Math.max(0, min - margin);
  const framedMax = max + margin;
  if (!(framedMax > framedMin)) return null;
  return { min: framedMin, max: framedMax, debrisFloor: floor };
}

/*

Purpose:
	The display range that frames every supplied fit at once, so an overlay of
	several samples stays comparable instead of each being framed differently.

Input:
	fits [array]: [{ g1Mean, g1Sigma, g2Mean, g2Sigma, centers, counts }]
	options [object]: forwarded to peak_focus_range

Output:
	range [object|null]: the union { min, max } across the fits, or null

*/
export function shared_peak_focus_range(fits, options = {}) {
  const ranges = (fits ?? []).map((fit) => peak_focus_range({ ...fit, ...options })).filter(Boolean);
  if (!ranges.length) return null;
  return {
    min: Math.min(...ranges.map((r) => r.min)),
    max: Math.max(...ranges.map((r) => r.max)),
  };
}
