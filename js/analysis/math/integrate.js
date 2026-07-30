// Shared numerical integration helpers for cell-cycle reporting. Currently a
// single primitive, integrateTrapezoidal, which the reporting code uses to turn
// sampled component curves into areas (phase totals). Kept dependency-free and
// validation-light so it stays useful in isolation; range/value validation is
// the caller's responsibility.

/*

Purpose:
	Integrates sampled (x, y) points with the trapezoidal rule. Mismatched
	inputs, or fewer than two samples, integrate to zero rather than throwing,
	so the reporting code can call it without pre-checking every series.

Input:
	x [array|TypedArray]: sample abscissae (bin centers/edges)
	y [array|TypedArray]: sample values at each x (same length as x)

Output:
	area [number]: the trapezoidal area, or 0 for invalid/degenerate input

*/
function integrateTrapezoidal(x, y) {
  if (
    x == null ||
    y == null ||
    typeof x.length !== "number" ||
    typeof y.length !== "number" ||
    x.length !== y.length ||
    x.length < 2
  ) {
    return 0;
  }

  let area = 0;

  for (let i = 1; i < x.length; i += 1) {
    const binWidth = x[i] - x[i - 1];
    area += 0.5 * (y[i - 1] + y[i]) * binWidth;
  }

  return area;
}

export { integrateTrapezoidal };
