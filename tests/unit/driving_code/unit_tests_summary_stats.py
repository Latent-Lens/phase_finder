#!/usr/bin/env python3

from helpers import TestContext


def run_summary_stats_tests(ctx: TestContext):
    result = ctx.page.evaluate("""async () => {
      const { compute_column_stats, map_with_concurrency } = window.TableSummaryStats;
      const stats = compute_column_stats(
        Float64Array.from([1, 2, 3, 4, 0, -1, NaN, Infinity]),
        ['mean', 'stddev', 'median', 'min', 'max'],
      );
      let active = 0, peak = 0;
      const mapped = await map_with_concurrency([1, 2, 3, 4, 5], async (value) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active -= 1;
        return value * 2;
      }, 2);
      const controller = new AbortController();
      controller.abort();
      let cancelled = false;
      try { await map_with_concurrency([1], async value => value, 1, controller.signal); }
      catch (error) { cancelled = error.name === 'AbortError'; }
      const largeInput = Float64Array.from({ length: 1000000 }, (_, index) => index % 10);
      const largeStarted = performance.now();
      const large = compute_column_stats(
        largeInput,
        ['mean', 'stddev', 'min', 'max'],
      );
      const largeElapsedMs = performance.now() - largeStarted;
      const partial = await map_with_concurrency([1, 2, 3], async value =>
        value === 2 ? { value: null, error: 'synthetic load failure' } : { value, error: null }, 2);
      return { stats, mapped, peak, cancelled, large, largeElapsedMs, partial };
    }""")
    stats = result["stats"]
    ctx.check(
        "Summary statistics",
        "PERF-UI-03: one bounded aggregation preserves numeric results and cancellation",
        stats["n"] == 5
        and stats["mean"] == 2
        and abs(stats["stddev"] - 2 ** 0.5) < 1e-12
        and stats["median"] == 2
        and stats["min"] == 0
        and stats["max"] == 4
        and result["mapped"] == [2, 4, 6, 8, 10]
        and result["peak"] == 2
        and result["cancelled"]
        and result["large"]["n"] == 1000000
        and result["large"]["mean"] == 4.5
        and abs(result["large"]["stddev"] - 8.25 ** 0.5) < 1e-12
        and result["large"]["min"] == 0
        and result["large"]["max"] == 9
        and result["largeElapsedMs"] < 1000
        and result["partial"] == [
            {"value": 1, "error": None},
            {"value": None, "error": "synthetic load failure"},
            {"value": 3, "error": None},
        ],
        str(result),
        screenshot=False,
    )
