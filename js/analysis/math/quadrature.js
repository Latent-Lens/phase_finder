// Fixed-node Gauss-Legendre quadrature, independent of histogram resolution
// (plan §5.3): the Dean-Jett/Dean-Jett-Fox S-phase integral is evaluated on
// its own latent z-in-[0,1] grid via this module, never on histogram bin
// centers -- the archive's convolvedSPhase() used the bin centers themselves
// as the latent integration grid, which the plan explicitly calls out to
// replace, since it ties the S-phase integral's accuracy to the bin count.

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

/**
 * Nodes and weights for `n`-point Gauss-Legendre quadrature on [-1, 1],
 * found by Newton's method on the Legendre polynomial roots from a standard
 * asymptotic initial guess -- the textbook algorithm, not tied to any
 * particular integrand.
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

/** Cached `{ nodes, weights }` for `n`-point Gauss-Legendre quadrature on [-1, 1]. */
export function gaussLegendre(n) {
  let entry = cache.get(n);
  if (!entry) {
    entry = computeGaussLegendre(n);
    cache.set(n, entry);
  }
  return entry;
}

/**
 * Integrates `fn` over `[a, b]` with fixed `n`-point Gauss-Legendre
 * quadrature (default 64 nodes per plan §5.3), via the standard affine
 * change of variables from [-1, 1].
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
