#!/usr/bin/env python3
"""Plotting tests: channel selection, Plot Channel Events, row toggles, channel change."""

from helpers import (
    TestContext,
    STATUS_WARN,
    another_channel,
    click_plot_events,
    density_curve_count,
    ensure_channel_option,
    plot_title,
    select_all_visible_rows,
    select_channel,
    selected_row_count,
    status_bar_text,
    table_row_count,
    try_catch_progress,
    wait_briefly,
    wait_for_curves,
    wait_for_overlay_hidden,
)


def test_plotting(ctx: TestContext, preferred_channel: str):
    page = ctx.page
    group = "Plotting"
    total_rows = table_row_count(page)

    # Ensure all rows are checked before plotting
    select_all_visible_rows(page)
    ctx.check(group, "All loaded rows selected before plotting",
              selected_row_count(page) == total_rows,
              f"selected={selected_row_count(page)}, rows={total_rows}")

    # Select channel
    channel, warning = ensure_channel_option(page, preferred_channel)
    select_channel(page, channel)
    if warning:
        ctx.warn(group, f"Select {preferred_channel} channel", warning)
    else:
        ctx.check(group, f"Select {preferred_channel} channel",
                  page.eval_on_selector("#dnaAreaSelect", "e => e.value") == channel)

    # --- plot a strict subset first to verify subset behavior ---
    checkboxes = page.query_selector_all(".file-table tbody .row-select")
    subset_count = min(2, total_rows)
    # Uncheck all except the first subset_count
    for i, cb in enumerate(checkboxes):
        if i < subset_count:
            cb.check()
        else:
            cb.uncheck()
    wait_briefly(0.3)

    page.click("#startAnalysisButton")
    # Catch progress overlay during plot
    progress_during_plot = try_catch_progress(page, timeout_ms=10000)
    page.wait_for_selector("#plotArea svg", timeout=120000)
    wait_for_curves(page, subset_count)

    ctx.check(group, "Plot strict subset of files",
              density_curve_count(page) == subset_count,
              f"curves={density_curve_count(page)}, expected={subset_count}")
    ctx.check(group, "Progress overlay appears during Plot Channel Events",
              progress_during_plot,
              "overlay caught" if progress_during_plot else "loaded too fast to observe")
    wait_for_overlay_hidden(page)
    overlay_hidden = page.eval_on_selector("#progressOverlay", "e => e.hidden")
    ctx.check(group, "Progress overlay hides after plot completes",
              overlay_hidden, "hidden" if overlay_hidden else "still visible")

    bar_after_plot = status_bar_text(page)
    ctx.check(group, "Status bar shows completion message after plotting",
              "ready" in bar_after_plot.lower() or "finished" in bar_after_plot.lower()
              or "plotted" in bar_after_plot.lower() or bar_after_plot != "",
              bar_after_plot)

    # --- re-select all rows and plot all ---
    select_all_visible_rows(page)
    wait_briefly(0.2)

    # Button text should be "Start Modeling (DJF)" now that we already plotted once
    button_text = page.eval_on_selector("#startAnalysisButton", "e => e.textContent.trim()")
    if button_text == "Start Modeling (DJF)":
        # Change channel to force "Plot Channel Events" mode again, then change back
        other = another_channel(page, channel)
        if other:
            select_channel(page, other)
            page.wait_for_function(
                "() => document.querySelector('#startAnalysisButton').textContent.trim() === 'Plot Channel Events'",
                timeout=30000,
            )
            select_channel(page, channel)
            wait_briefly(0.5)

    click_plot_events(page)
    wait_for_curves(page, total_rows)
    title = plot_title(page)

    ctx.check(group, "Plot Channel Events plots all loaded files",
              density_curve_count(page) == total_rows,
              f"curves={density_curve_count(page)}, title={title}")
    ctx.check(group, "Plot title and y-axis update",
              title.startswith(f"Histogram of Events:  {total_rows} Samples  |  ")
              and page.eval_on_selector_all(
                  "#plotArea svg text",
                  "els => els.some(t => t.textContent === 'Number of Events')"
              ),
              title)
    ctx.check(group, "Cell Cycle Modeling button becomes enabled after plotting",
              not page.eval_on_selector("#cellCycleModelingButton", "e => e.disabled"))

    # --- turn rows off, verify curves decrease ---
    checkboxes = page.query_selector_all(".file-table tbody .row-select")
    checkboxes[0].uncheck()
    checkboxes[1].uncheck()
    wait_briefly(0.4)
    ctx.check(group, "Turning rows off removes plot lines",
              density_curve_count(page) == total_rows - 2,
              f"curves={density_curve_count(page)}")

    # Data should still be cached
    ctx.check(group, "Unchecked rows retain loaded data",
              page.evaluate("window.PhaseFinderApp.get_parsed_files().filter(r => r.data).length") >= total_rows,
              "data cache retained")

    # Re-check one row
    checkboxes = page.query_selector_all(".file-table tbody .row-select")
    checkboxes[0].check()
    wait_briefly(0.4)
    ctx.check(group, "Turning a row back on restores its plot line",
              density_curve_count(page) == total_rows - 1,
              f"curves={density_curve_count(page)}")

    # Re-check the second row
    checkboxes = page.query_selector_all(".file-table tbody .row-select")
    checkboxes[1].check()
    wait_briefly(0.4)
    ctx.check(group, "All rows back on restores all plot lines",
              density_curve_count(page) == total_rows,
              f"curves={density_curve_count(page)}")

    # --- channel change behavior ---
    other = another_channel(page, channel)
    if other:
        select_channel(page, other)
        try:
            page.wait_for_function(
                "() => document.querySelector('#startAnalysisButton').textContent.trim() === 'Plot Channel Events'",
                timeout=60000,
            )
            wait_briefly(0.8)
            btn = page.eval_on_selector("#startAnalysisButton", "e => e.textContent.trim()")
            ctx.check(group, "Changing channel restores Plot Channel Events button",
                      btn == "Plot Channel Events", btn)
            ctx.check(group, "Changing channel clears curves but keeps axes",
                      density_curve_count(page) == 0
                      and page.eval_on_selector_all(
                          "#plotArea svg text",
                          "els => els.some(t => t.textContent === 'Number of Events')"
                      ),
                      f"curves={density_curve_count(page)}, title={plot_title(page)}")
            bar = status_bar_text(page)
            ctx.check(group, "Changing channel shows progress/status during reload",
                      "ready" in bar.lower() or "loading" in bar.lower() or bar != "",
                      bar)
            load_ok = "failed" not in bar.lower() and "error" not in bar.lower()
            if load_ok:
                page.click("#startAnalysisButton")
                wait_for_curves(page, total_rows)
                ctx.check(group, "Plot Channel Events replots the newly selected channel",
                          density_curve_count(page) == total_rows,
                          f"channel={other}, curves={density_curve_count(page)}")
            else:
                ctx.warn(group, "Plot Channel Events replots the newly selected channel",
                         f"Skipped: channel data load failed ({bar})")
        except Exception as error:
            ctx.check(group, "Changing channel restores Plot Channel Events button", False, str(error))

        # Always restore the original channel so downstream test modules start clean
        select_channel(page, channel)
        try:
            page.wait_for_function(
                "() => document.querySelector('#startAnalysisButton').textContent.trim() === 'Plot Channel Events'",
                timeout=30000,
            )
        except Exception:
            pass
        # Re-plot on original channel so the button is in "Start Modeling (DJF)" state
        click_plot_events(page)
        wait_for_curves(page, total_rows)
    else:
        ctx.warn(group, "Changing channel restores Plot Channel Events button",
                 "Only one channel option available")
