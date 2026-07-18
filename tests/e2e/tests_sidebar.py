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


def test_sidebar_modeling_mode(ctx: TestContext):
    """Cell Cycle Modeling switches the sidebar to the relocated QC/DJF controls
    and Back restores the file/channel controls without losing state."""
    page = ctx.page
    group = "Sidebar/Modeling"

    try:
        title_before = page.eval_on_selector(".sidebar_title_row h2", "e => e.textContent.trim()")
        files_before = page.eval_on_selector("#loaded_files_list", "e => e.value")
        channel_before = page.eval_on_selector("#channel_select", "e => e.value")

        ctx.check(group, "Cell Cycle Modeling button is enabled after plotting",
                  not page.eval_on_selector("#cell_cycle_modeling_button", "e => e.disabled"))

        # Enter modeling mode
        page.click("#cell_cycle_modeling_button")
        page.wait_for_selector("#sidebar_modeling_section", state="visible", timeout=5000)
        wait_briefly(0.4)

        ctx.check(group, "Entering modeling mode reveals QC + DJF controls and Back",
                  page.eval_on_selector(".app", "e => e.classList.contains('sidebar_modeling_mode')")
                  and page.is_visible("#qc_stage_all")
                  and page.is_visible("#djf_run_all")
                  and page.is_visible("#sidebar_back_button"))
        ctx.check(group, "Modeling mode hides the file/channel controls and title reads 'Cell Cycle Modeling'",
                  not page.is_visible("#file_upload_section")
                  and not page.is_visible("#channel_select")
                  and not page.is_visible("#start_analysis_button")
                  and page.eval_on_selector(".sidebar_title_row h2", "e => e.textContent.trim()") == "Cell Cycle Modeling")
        ctx.check(group, "QC and DJF controls no longer occupy the plot panel (plot reclaims the height)",
                  page.eval_on_selector_all("#plot_panel .premodel_qc_group", "els => els.length") == 0
                  and page.eval_on_selector_all("#plot_panel .djf_pipeline_controls", "els => els.length") == 0)

        # Back
        page.click("#sidebar_back_button")
        page.wait_for_selector("#sidebar_modeling_section", state="hidden", timeout=5000)
        wait_briefly(0.4)

        ctx.check(group, "Back restores the file/channel controls and title",
                  not page.eval_on_selector(".app", "e => e.classList.contains('sidebar_modeling_mode')")
                  and page.is_visible("#file_upload_section")
                  and page.is_visible("#channel_select")
                  and page.is_visible("#start_analysis_button")
                  and not page.is_visible("#sidebar_back_button")
                  and page.eval_on_selector(".sidebar_title_row h2", "e => e.textContent.trim()") == title_before)
        ctx.check(group, "Enter/Back is lossless — loaded files and selected channel are preserved",
                  page.eval_on_selector("#loaded_files_list", "e => e.value") == files_before
                  and page.eval_on_selector("#channel_select", "e => e.value") == channel_before,
                  f"files_equal={page.eval_on_selector('#loaded_files_list', 'e => e.value') == files_before}, "
                  f"channel={page.eval_on_selector('#channel_select', 'e => e.value')!r} vs {channel_before!r}")
    except Exception as error:
        ctx.check(group, "Sidebar Cell Cycle Modeling enter/Back flow", False, str(error))
        # Best-effort: leave the sidebar in file mode for later tests.
        try:
            if page.eval_on_selector(".app", "e => e.classList.contains('sidebar_modeling_mode')"):
                page.click("#sidebar_back_button")
                page.wait_for_selector("#sidebar_modeling_section", state="hidden", timeout=5000)
        except Exception:
            pass
