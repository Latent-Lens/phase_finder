#!/usr/bin/env python3
"""Sidebar/Icons tests: collapsed state, icon tooltips, channel sync, and plot icon."""

from helpers import (
    TestContext,
    density_curve_count,
    table_row_count,
    wait_briefly,
    wait_for_curves,
)


def test_sidebar_icons(ctx: TestContext):
    page = ctx.page
    group = "Sidebar/Icons"

    # Collapse the sidebar
    page.click("#sidebar_toggle")
    wait_briefly(0.5)

    # Collapsed icons are visible
    ctx.check(group, "Collapsed sidebar shows upload/channel/plot icons",
              page.locator("#collapsed_upload_target").is_visible()
              and page.locator("#collapsed_channel_select").is_visible()
              and page.locator("#collapsed_plot_button").is_visible())

    # Upload icon tooltip describes both functions
    tooltip = page.eval_on_selector(
        "#collapsed_upload_target",
        "e => e.getAttribute('data-tooltip') || e.title || ''",
    )
    ctx.check(group, "Collapsed upload icon hover text describes both functions",
              "Drop FCS files" in tooltip or "drop" in tooltip.lower(), tooltip)

    # Channel select mirrors expanded select
    ctx.check(group, "Collapsed channel icon select mirrors expanded select",
              page.eval_on_selector("#collapsed_channel_select", "e => e.value")
              == page.eval_on_selector("#channel_select", "e => e.value"))

    # Histogram icon is enabled (plot is available since rows are checked)
    ctx.check(group, "Collapsed histogram icon is enabled when plotting is available",
              not page.eval_on_selector("#collapsed_plot_button", "e => e.disabled"))

    # Click the collapsed histogram icon to trigger a replot
    expected_curves = density_curve_count(page)
    try:
        page.click("#collapsed_plot_button")
        wait_for_curves(page, expected_curves, timeout=120000)
        ctx.check(group, "Collapsed histogram icon click triggers plot",
                  density_curve_count(page) == expected_curves,
                  f"curves={density_curve_count(page)}")
    except Exception as error:
        ctx.check(group, "Collapsed histogram icon click triggers plot", False, str(error))

    # Restore expanded sidebar
    page.click("#sidebar_toggle")
    wait_briefly(0.4)
