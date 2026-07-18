// Shared numerical integration helpers for cell-cycle reporting.

/**
 * Integrate samples with the trapezoidal rule.
 *
 * Arrays and typed arrays are both supported.  As in the source DJF
 * implementation, mismatched inputs (or fewer than two samples) have zero
 * area; value/range validation belongs to the reporting stage so this helper
 * remains useful in isolation.
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
