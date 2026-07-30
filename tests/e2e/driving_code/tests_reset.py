#!/usr/bin/env python3
"""Keyboard/pointer reset confirmation tests for the semantic Reset button."""

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
    dialog_action = {"accept": True}

    def handle_dialog(dialog):
        seen_dialog_messages.append(dialog.message)
        dialog.accept() if dialog_action["accept"] else dialog.dismiss()

    page.on("dialog", handle_dialog)

    # Every Playwright browser context is storage-isolated (the equivalent of a
    # fresh/private profile). The controls must remain usable whether this
    # engine exposes OPFS/quota APIs or falls back to uncached analysis.
    page.click("#cache_manager_button")
    page.wait_for_selector("#cache_manager_modal:not([hidden])", timeout=10000)
    storage_state = page.evaluate(
        """() => ({
          summary: document.querySelector('#cache_manager_summary')?.textContent.trim(),
          opfs: Boolean(navigator.storage?.getDirectory),
          automatic: document.querySelector('#cache_manager_automatic')?.checked,
        })"""
    )
    page.uncheck("#cache_manager_automatic")
    page.check("#cache_manager_automatic")
    page.click("#cache_manager_close")
    ctx.check(
        group,
        "SES-04: storage controls work in an isolated/private browser profile with or without OPFS",
        bool(storage_state["summary"]) and storage_state["automatic"] is True,
        str(storage_state),
    )

    if table_row_count(page) == 0:
        set_files_via_file_browser(page, "#drop_zone", initial_files[:1])
        wait_for_rows(page, 1)

    # Cancel via keyboard: state must remain intact.
    before_cancel = table_row_count(page)
    dialog_action["accept"] = False
    page.focus("#reset_session_button")
    page.press("#reset_session_button", "Enter")
    page.wait_for_timeout(100)
    ctx.check(group, "UI-05A: keyboard Reset cancellation preserves app state",
              table_row_count(page) == before_cancel and page.locator("#reset_session_button").evaluate("element => element === document.activeElement"))

    # Confirm via Space: the same semantic button and confirmation path reset.
    dialog_action["accept"] = True
    seen_dialog_messages.clear()
    page.press("#reset_session_button", "Space")
    page.wait_for_selector("#file_table .empty_note", timeout=30000)

    bar3 = status_bar_text(page)
    ctx.check(group, "Reset Session button shows its own cached-files warning before resetting",
              any("cannot be undone" in message for message in seen_dialog_messages),
              str(seen_dialog_messages))
    ctx.check(group, "UI-05A: Space activates Reset and clears app state",
              table_row_count(page) == 0
              and page.locator("#plot_panel").is_hidden()
              and "Ready:" in bar3,
              bar3)

    # Both native button activation keys open the associated multi-file picker.
    with page.expect_file_chooser() as chooser_info:
        page.focus("#drop_zone")
        page.press("#drop_zone", "Space")
    chooser_info.value.set_files([])
    focus_style = page.eval_on_selector("#drop_zone", "e => getComputedStyle(e).outlineStyle")
    with page.expect_file_chooser() as chooser_info:
        page.press("#drop_zone", "Enter")
    chooser_info.value.set_files(initial_files[:1])
    wait_for_rows(page, 1)
    ctx.check(group, "UI-05A: upload supports Space/Enter with visible focus",
              focus_style != "none" and page.get_attribute("#file_input", "multiple") is not None,
              f"outline={focus_style}")

    # Pointer activation uses the identical Reset confirmation behavior.
    seen_dialog_messages.clear()
    page.click("#reset_session_button")
    page.wait_for_selector("#file_table .empty_note", timeout=30000)
    ctx.check(group, "UI-05A: pointer Reset uses the same confirmation",
              any("cannot be undone" in message for message in seen_dialog_messages))
