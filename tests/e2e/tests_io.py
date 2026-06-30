#!/usr/bin/env python3
"""Input/Output tests: library loading and FCS file loading via all input methods."""

from helpers import (
    TestContext,
    set_files_via_drag_drop,
    set_files_via_file_browser,
    status_bar_text,
    table_row_count,
    table_values,
    try_catch_progress,
    wait_briefly,
    wait_for_overlay_hidden,
    wait_for_rows,
    write_synthetic_fcs,
)
from pathlib import Path


def _unloaded_fcs_files(candidate_dir, loaded_paths, limit=1):
    return [
        str(path)
        for path in sorted(Path(candidate_dir).glob("*.fcs"))
        if str(path.resolve()) not in loaded_paths
    ][:limit]


def _synthetic_extra_file(ctx: TestContext, seed, strain, timepoint):
    fixture_dir = ctx.results_dir / f"{ctx.report_stem}_extra_fixtures"
    fixture_dir.mkdir(parents=True, exist_ok=True)
    return write_synthetic_fcs(fixture_dir, seed=seed, strain=strain, timepoint=timepoint)


def test_libraries(ctx: TestContext):
    group = "Input/Output"
    for lib, expected_type in [("d3", "object"), ("levenbergMarquardt", "function"), ("gsd", "function")]:
        try:
            ctx.page.wait_for_function(
                f"() => typeof window.{lib} === '{expected_type}'", timeout=20000
            )
            ctx.check(group, f"Library loaded [{lib}]", True, screenshot=False)
        except Exception:
            ctx.check(group, f"Library loaded [{lib}]", False,
                      ctx.page.evaluate(f"typeof window.{lib}"))


def test_file_loading(ctx: TestContext, drag_drop_files, file_browser_files, additional_files):
    page = ctx.page
    group = "Input/Output"

    # --- drag-and-drop into expanded sidebar ---
    set_files_via_drag_drop(page, "#drop_zone", drag_drop_files)
    after_drag = len(drag_drop_files)
    wait_for_rows(page, after_drag)
    ctx.check(group, "File loading [Sidebar expanded, drag and drop]",
              table_row_count(page) == after_drag, f"rows={table_row_count(page)}")

    bar_text = status_bar_text(page)
    ctx.check(group, "Status bar updates after drag-and-drop load",
              "Finished reading metadata" in bar_text or "Loaded" in bar_text or bar_text != "",
              bar_text)

    # --- file browser via expanded sidebar click ---
    set_files_via_file_browser(page, "#drop_zone", file_browser_files)
    after_browser = after_drag + len(file_browser_files)

    # Try to catch the progress overlay while real files are loading
    progress_seen = try_catch_progress(page, timeout_ms=8000)
    wait_for_rows(page, after_browser)
    # Wait for overlay animation to finish before next check or action
    wait_for_overlay_hidden(page)

    ctx.check(group, "File loading [Sidebar expanded, via file browser]",
              table_row_count(page) == after_browser, f"rows={table_row_count(page)}")
    ctx.check(group, "Progress overlay appears during file loading",
              progress_seen, "overlay caught" if progress_seen else "loaded too fast to observe")
    overlay_is_hidden = page.eval_on_selector("#progress_overlay", "e => e.hidden")
    ctx.check(group, "Progress overlay hides after file load completes",
              overlay_is_hidden, "hidden" if overlay_is_hidden else "still visible")

    # --- duplicate file warning ---
    before_dup = table_row_count(page)
    duplicate_file = (file_browser_files or drag_drop_files)[0]
    # Use drag/drop for the duplicate check. Re-selecting the exact same file in
    # the same file input can be suppressed by the browser before the app sees a
    # change event, leaving the previous status text in place.
    set_files_via_drag_drop(page, "#drop_zone", [duplicate_file])
    try:
        page.wait_for_function(
            """() => {
              const bar = document.querySelector('#status_bar_message')?.textContent || '';
              const status = document.querySelector('#status')?.textContent || '';
              return /Duplicate|duplicate|No new files loaded/.test(`${bar} ${status}`);
            }""",
            timeout=10000,
        )
    except Exception:
        pass
    # Wait for any brief progress overlay to appear and settle
    try:
        page.wait_for_selector("#progress_overlay", state="visible", timeout=5000)
    except Exception:
        pass  # May complete too fast to observe
    wait_for_overlay_hidden(page)
    wait_briefly(0.3)
    dup_row_count = table_row_count(page)
    dup_status = status_bar_text(page)
    sidebar_status = page.eval_on_selector("#status", "e => e.textContent.trim()")
    row_unchanged = dup_row_count == before_dup
    has_dup_msg = ("Duplicate" in dup_status or "duplicate" in sidebar_status
                   or "No new files loaded" in sidebar_status)
    detail = f"rows: {before_dup}→{dup_row_count}, bar={dup_status!r}"
    ctx.check(group, "Duplicate FCS file warning", row_unchanged and has_dup_msg, detail)

    # --- add genuinely new files ---
    set_files_via_file_browser(page, "#drop_zone", additional_files)
    after_additional = after_browser + len(additional_files)
    wait_for_rows(page, after_additional)
    wait_for_overlay_hidden(page)
    ctx.check(group, "Additional different FCS files append to table",
              table_row_count(page) == after_additional, f"rows={table_row_count(page)}")

    replicates = set(table_values(page, 4))
    arrests = set(table_values(page, 5))
    timepoints = table_values(page, 6)
    ctx.check(group, "Synthetic filename annotations populate replicate/arrest/timepoint columns",
              {"a", "b", "c"}.issubset(replicates)
              and {"N", "Y"}.issubset(arrests)
              and all(value.isdigit() for value in timepoints),
              f"replicates={sorted(replicates)}, arrests={sorted(arrests)}, timepoints={timepoints[:4]}")

    # --- collapse sidebar and verify collapsed icons ---
    page.click("#sidebar_toggle")
    wait_briefly(0.5)
    ctx.check(group, "Sidebar collapsed icon controls are visible",
              page.locator("#collapsed_upload_target").is_visible()
              and page.locator("#collapsed_dna_area_select").is_visible()
              and page.locator("#collapsed_plot_button").is_visible())

    # --- file loading via collapsed upload icon (file browser) ---
    loaded_paths = {str(Path(p).resolve()) for p in file_browser_files + additional_files + drag_drop_files}
    candidate_dir = str(Path((additional_files or file_browser_files)[-1]).parent)
    extra_pool = _unloaded_fcs_files(candidate_dir, loaded_paths, limit=1)

    if not extra_pool:
        extra_pool = [_synthetic_extra_file(ctx, seed=7001, strain=970, timepoint=70)]

    before_collapsed = table_row_count(page)
    set_files_via_file_browser(page, "#collapsed_upload_target", extra_pool)
    wait_for_rows(page, before_collapsed + 1)
    wait_for_overlay_hidden(page)
    ctx.check(group, "File loading [Sidebar collapsed, via file browser icon]",
              table_row_count(page) == before_collapsed + 1, f"rows={table_row_count(page)}")

    # --- drag-and-drop onto collapsed upload target ---
    before_ddcoll = table_row_count(page)
    all_loaded = loaded_paths | {str(Path(p).resolve()) for p in extra_pool}
    dd_pool = _unloaded_fcs_files(candidate_dir, all_loaded, limit=1)

    if not dd_pool:
        dd_pool = [_synthetic_extra_file(ctx, seed=7002, strain=971, timepoint=75)]

    set_files_via_drag_drop(page, "#collapsed_upload_target", dd_pool)
    wait_for_rows(page, before_ddcoll + 1)
    wait_for_overlay_hidden(page)
    ctx.check(group, "File loading [Sidebar collapsed, drag-and-drop]",
              table_row_count(page) == before_ddcoll + 1, f"rows={table_row_count(page)}")

    # Restore expanded sidebar
    page.click("#sidebar_toggle")
    wait_briefly(0.4)
