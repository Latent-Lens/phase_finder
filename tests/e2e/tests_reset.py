#!/usr/bin/env python3
"""Reset tests: clicking the site logo wipes all app state and reloads a clean page.

(There is no separate "restart" button in the current UI — the logo is the
only reset control, wired to a full `window.location.reload()`.)
"""

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

    # --- Reset from a populated, already-plotted/modeled session (state left
    #     over from earlier test modules) ---
    page.click("#site_logo")
    page.wait_for_selector("#file_table .empty_note", timeout=30000)

    bar = status_bar_text(page)
    channel_val = page.eval_on_selector("#channel_select", "e => e.value")
    ctx.check(group, "Clicking site logo resets app state",
              table_row_count(page) == 0
              and page.locator("#plot_panel").is_hidden()
              and "Ready:" in bar,
              bar)
    ctx.check(group, "Clicking site logo clears channel selection",
              channel_val == "" or channel_val == "none",
              f"channel value={channel_val!r}")

    # --- Reset again after a fresh, minimal load, to confirm it isn't
    #     dependent on how much state had accumulated beforehand ---
    set_files_via_file_browser(page, "#drop_zone", initial_files[:1])
    wait_for_rows(page, 1)

    page.click("#site_logo")
    page.wait_for_selector("#file_table .empty_note", timeout=30000)

    bar2 = status_bar_text(page)
    ctx.check(group, "Clicking site logo resets app state after a fresh single-file load",
              table_row_count(page) == 0
              and page.locator("#plot_panel").is_hidden()
              and "Ready:" in bar2,
              bar2)
