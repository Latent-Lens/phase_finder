#!/usr/bin/env python3
"""Reset tests: Restart button and site logo both wipe all app state."""

from helpers import (
    TestContext,
    set_files_via_file_browser,
    status_bar_text,
    table_row_count,
    wait_for_rows,
)


def test_reset(ctx: TestContext, initial_files):
    page = ctx.page
    group = "Reset"

    # --- Restart button ---
    page.click("#restart_button")
    page.wait_for_selector("#file_table .empty_note", timeout=30000)

    bar = status_bar_text(page)
    channel_val = page.eval_on_selector("#dna_area_select", "e => e.value")
    ctx.check(group, "Restart button resets app state",
              table_row_count(page) == 0
              and page.locator("#plot_panel").is_hidden()
              and "Ready:" in bar,
              bar)
    ctx.check(group, "Restart button clears channel selection",
              channel_val == "" or channel_val == "none",
              f"channel value={channel_val!r}")

    # --- Site logo ---
    set_files_via_file_browser(page, "#drop_zone", initial_files[:1])
    wait_for_rows(page, 1)

    page.click("#site_logo")
    page.wait_for_selector("#file_table .empty_note", timeout=30000)

    bar2 = status_bar_text(page)
    ctx.check(group, "Clicking site logo resets app state",
              table_row_count(page) == 0
              and page.locator("#plot_panel").is_hidden()
              and "Ready:" in bar2,
              bar2)
