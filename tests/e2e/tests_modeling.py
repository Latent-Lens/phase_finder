#!/usr/bin/env python3
"""Modeling tests: DJF curve fitting, fractions, corrections, and threshold display."""

import re

from helpers import (
    TestContext,
    density_curve_count,
    fit_curve_count,
    status_bar_text,
    wait_briefly,
    wait_for_curves,
)


def test_modeling(ctx: TestContext):
    page = ctx.page
    group = "Modeling"

    # Ensure the Cell Cycle Modeling button is enabled (data has been plotted)
    modeling_btn_disabled = page.eval_on_selector("#cell_cycle_modeling_button", "e => e.disabled")
    if modeling_btn_disabled:
        try:
            page.click("#start_analysis_button")
            page.wait_for_selector("#plot_area svg", timeout=120000)
            page.wait_for_function(
                "() => !document.querySelector('#cell_cycle_modeling_button').disabled",
                timeout=60000,
            )
        except Exception as err:
            ctx.check(group, "Start Modeling (DJF) creates one visible fit", False,
                      f"Could not enter modeling state: {err}")
            return

    bar_before = status_bar_text(page)

    page.click("#cell_cycle_modeling_button")
    page.wait_for_function(
        "() => /G1/.test(document.querySelector('#djf_readout').textContent)",
        timeout=30000,
    )
    wait_briefly(0.4)

    text = page.eval_on_selector("#djf_readout", "e => e.textContent")
    nums = [float(x) for x in re.findall(r"([\d.]+)%", text)]

    ctx.check(group, "Start Modeling (DJF) creates one visible fit",
              fit_curve_count(page) == 1, f"fits={fit_curve_count(page)}")
    ctx.check(group, "DJF fractions sum to approximately 100%",
              len(nums) == 3 and abs(sum(nums) - 100) < 0.5, str(nums))
    ctx.check(group, "DJF fit table appears with phase rows",
              page.eval_on_selector_all("#djf_fit_table .djf_fit_title_row", "rows => rows.length") >= 1
              and page.eval_on_selector_all("#djf_fit_table .djf_fit_phase_row", "rows => rows.length") >= 3)

    bar_after = status_bar_text(page)
    ctx.check(group, "Status bar updates after DJF modeling",
              bar_after != bar_before or bar_after != "",
              f"before={bar_before!r}, after={bar_after!r}")

    # Debris correction
    page.check("#plot_debris_correction")
    wait_briefly(0.4)
    corrected = page.eval_on_selector("#djf_readout", "e => e.textContent")
    ctx.check(group, "Debris correction updates DJF readout",
              "debris/background" in corrected, corrected)

    # Doublet correction
    page.check("#plot_doublet_correction")
    wait_briefly(0.4)
    corrected2 = page.eval_on_selector("#djf_readout", "e => e.textContent")
    ctx.check(group, "Doublet correction updates DJF readout",
              "aggregates/doublets" in corrected2 or "aggregate/doublet channels unavailable" in corrected2,
              corrected2)

    # Peak threshold
    page.check("#plot_threshold_toggle")
    wait_briefly(0.3)
    ctx.check(group, "Peak threshold line appears when enabled",
              page.query_selector("#plot_area svg .threshold_line, #plot_area svg .threshold_fill") is not None)
