// Fixed-node Gauss-Legendre quadrature, independent of histogram resolution:
// the Dean-Jett / Dean-Jett-Fox S-phase integral is evaluated on its own latent
// z-in-[0,1] grid via this module, never on histogram bin centers (which would
// tie the integral's accuracy to the bin count). Exposes gaussLegendre (cached
// nodes/weights for n points on [-1, 1]) and integrateGaussLegendre (integrate
// a function over an arbitrary [a, b]); computeGaussLegendre and
// legendrePolynomialAndDerivative are the internal root-finder behind them.

const MAX_NEWTON_ITERATIONS = 100;
const NEWTON_TOLERANCE = 1e-15;

// Legendre polynomial P_n(x) and its derivative P_n'(x), via the standard
// three-term recurrence (n * P_n = (2n-1) x P_{n-1} - (n-1) P_{n-2}).
function legendrePolynomialAndDerivative(n, x) {
  let p0 = 1;
  let p1 = x;
  for (let k = 2; k <= n; k += 1) {
    const p2 = ((2 * k - 1) * x * p1 - (k - 1) * p0) / k;
    p0 = p1;
    p1 = p2;
  }
  // P_n'(x) = n(x P_n(x) - P_{n-1}(x)) / (x^2 - 1), except at x = ±1.
  const derivative = n * (x * p1 - p0) / (x * x - 1);
  return { value: p1, derivative };
}

/*

Purpose:
	Computes the nodes and weights for n-point Gauss-Legendre quadrature on
	[-1, 1] by Newton's method on the Legendre-polynomial roots (the textbook
	algorithm, from a standard asymptotic initial guess).

Input:
	n [number]: the number of quadrature nodes (positive integer)

Output:
	result [object]: { nodes, weights } arrays of length n (throws for n < 1)

*/
function computeGaussLegendre(n) {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError("Gauss-Legendre quadrature requires a positive integer node count.");
  }
  const nodes = new Array(n);
  const weights = new Array(n);
  const half = Math.ceil(n / 2);

  for (let i = 0; i < half; i += 1) {
    let x = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5));
    let iterations = 0;
    let delta = Infinity;
    while (Math.abs(delta) > NEWTON_TOLERANCE && iterations < MAX_NEWTON_ITERATIONS) {
      const { value, derivative } = legendrePolynomialAndDerivative(n, x);
      delta = value / derivative;
      x -= delta;
      iterations += 1;
    }
    const { derivative } = legendrePolynomialAndDerivative(n, x);
    const weight = 2 / ((1 - x * x) * derivative * derivative);
    nodes[i] = -x;
    nodes[n - 1 - i] = x;
    weights[i] = weight;
    weights[n - 1 - i] = weight;
  }
  return { nodes, weights };
}

const cache = new Map();

/*

Purpose:
	Returns the nodes and weights for n-point Gauss-Legendre quadrature on
	[-1, 1], memoized so repeated fits at the same node count are free.

Input:
	n [number]: the number of quadrature nodes

Output:
	result [object]: the cached { nodes, weights }

*/
export function gaussLegendre(n) {
  let entry = cache.get(n);
  if (!entry) {
    entry = computeGaussLegendre(n);
    cache.set(n, entry);
  }
  return entry;
}

/*

Purpose:
	Integrates a function over [a, b] with fixed n-point Gauss-Legendre
	quadrature, via the standard affine change of variables from [-1, 1].

Input:
	fn [function]: the integrand, called with a single number
	a [number]: lower limit
	b [number]: upper limit
	n [number]: node count (default 64)

Output:
	integral [number]: the approximate integral, or 0 when b <= a

*/
export function integrateGaussLegendre(fn, a, b, n = 64) {
  if (!(b > a)) return 0;
  const { nodes, weights } = gaussLegendre(n);
  const half = 0.5 * (b - a);
  const mid = 0.5 * (a + b);
  let total = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    total += weights[i] * fn(mid + half * nodes[i]);
  }
  return half * total;
}
