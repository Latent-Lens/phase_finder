#!/usr/bin/env python3
"""Reset tests: both the site logo and the header's "Reset" session-control
button wipe all app state and reload a clean page, each behind its own
window.confirm() prompt. Playwright auto-dismisses (cancels) any confirm()
dialog it has no handler for, so this module registers a dialog handler that
accepts every dialog -- matching a real user clicking "OK" -- before
triggering any reset. Without that handler the reload never fires and the
wait for the empty-table state below hangs until it times out.
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

    seen_dialog_messages = []
    page.on("dialog", lambda dialog: (seen_dialog_messages.append(dialog.message), dialog.accept()))

    # --- Reset from a populated, already-plotted/modeled session (state left
    #     over from earlier test modules), via the site logo ---
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

    # --- The header's "Reset" session-control button is a second, separate
    #     reset control (session/core.js: handle_reset) with its own confirm
    #     message; it also deletes the session's OPFS-cached files ---
    set_files_via_file_browser(page, "#drop_zone", initial_files[:1])
    wait_for_rows(page, 1)
    seen_dialog_messages.clear()

    page.click("#reset_session_button")
    page.wait_for_selector("#file_table .empty_note", timeout=30000)

    bar3 = status_bar_text(page)
    ctx.check(group, "Reset Session button shows its own cached-files warning before resetting",
              any("cannot be undone" in message for message in seen_dialog_messages),
              str(seen_dialog_messages))
    ctx.check(group, "Reset Session button resets app state",
              table_row_count(page) == 0
              and page.locator("#plot_panel").is_hidden()
              and "Ready:" in bar3,
              bar3)
