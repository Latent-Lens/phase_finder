#!/usr/bin/env python3

from helpers import TestContext


def run_scatter_preview_tests(ctx: TestContext):
    result = ctx.page.evaluate("""() => {
      const points = Array.from({ length: 100 }, (_, index) => ({
        eventIndex: index * 10000,
        point: [index, index * 2],
      }));
      const component = { mean: [50, 100], covariance: [[100, 0], [0, 400]] };
      const mask = window.ScatterModal.preview_mask_for_points(points, component, 5.991);
      return {
        length: mask.length,
        retained: mask.filter(Boolean).length,
        extentX: window.ScatterModal.padded_point_extent(points, 0),
        extentY: window.ScatterModal.padded_point_extent(points, 1),
      };
    }""")
    ctx.check(
        "Scatter preview",
        "PERF-UI-02: preview membership is bounded by displayed points, not event indexes",
        result["length"] == 100
        and 0 < result["retained"] < 100
        and result["extentX"][0] < 0
        and result["extentX"][1] > 99
        and result["extentY"][1] > 198,
        str(result),
        screenshot=False,
    )

    benchmark = ctx.page.evaluate("""() => {
      const points = Array.from({ length: 10000 }, (_, index) => ({
        eventIndex: index * 10000,
        point: [index % 1000, Math.floor(index / 1000)],
      }));
      const component = { mean: [500, 5], covariance: [[40000, 0], [0, 4]] };
      const started = performance.now();
      let mask;
      for (let pass = 0; pass < 30; pass += 1) {
        mask = window.ScatterModal.preview_mask_for_points(points, component, 5.991);
      }
      return {
        elapsed: performance.now() - started,
        maskLength: mask.length,
        retained: mask.filter(Boolean).length,
        largestEventIndex: points.at(-1).eventIndex,
      };
    }""")
    ctx.check(
        "Scatter preview",
        "PERF-UI-02: maximum 10,000-point preview stays bounded for a 100-million-event index domain",
        benchmark["maskLength"] == 10_000
        and benchmark["largestEventIndex"] == 99_990_000
        and 0 < benchmark["retained"] < 10_000
        and benchmark["elapsed"] < 1_000,
        str(benchmark),
        screenshot=False,
    )
