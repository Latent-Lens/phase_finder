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
    page.click("#sidebarToggle")
    wait_briefly(0.5)

    # Collapsed icons are visible
    ctx.check(group, "Collapsed sidebar shows upload/channel/plot icons",
              page.locator("#collapsedUploadTarget").is_visible()
              and page.locator("#collapsedDnaAreaSelect").is_visible()
              and page.locator("#collapsedPlotButton").is_visible())

    # Upload icon tooltip describes both functions
    tooltip = page.eval_on_selector(
        "#collapsedUploadTarget",
        "e => e.getAttribute('data-tooltip') || e.title || ''",
    )
    ctx.check(group, "Collapsed upload icon hover text describes both functions",
              "Drop FCS files" in tooltip or "drop" in tooltip.lower(), tooltip)

    # Channel select mirrors expanded select
    ctx.check(group, "Collapsed channel icon select mirrors expanded select",
              page.eval_on_selector("#collapsedDnaAreaSelect", "e => e.value")
              == page.eval_on_selector("#dnaAreaSelect", "e => e.value"))

    # Histogram icon is enabled (plot is available since rows are checked)
    ctx.check(group, "Collapsed histogram icon is enabled when plotting is available",
              not page.eval_on_selector("#collapsedPlotButton", "e => e.disabled"))

    # Click the collapsed histogram icon to trigger a replot
    expected_curves = density_curve_count(page)
    try:
        page.click("#collapsedPlotButton")
        wait_for_curves(page, expected_curves, timeout=120000)
        ctx.check(group, "Collapsed histogram icon click triggers plot",
                  density_curve_count(page) == expected_curves,
                  f"curves={density_curve_count(page)}")
    except Exception as error:
        ctx.check(group, "Collapsed histogram icon click triggers plot", False, str(error))

    # Restore expanded sidebar
    page.click("#sidebarToggle")
    wait_briefly(0.4)
