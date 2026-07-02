#!/usr/bin/env python3
"""Filtering tests: table column sort (all columns) and per-column filter apply/verify/clear."""

from helpers import (
    TestContext,
    close_filter,
    open_filter,
    set_filter_option,
    table_row_count,
    table_values,
    wait_briefly,
)


# (data-sort-field, header label, column index for table_values)
_SORT_FIELDS = [
    ("name", "Filename", 2),
    ("strain", "Strain", 3),
    ("replicate", "Replicate", 4),
    ("timepoint", "Timepoint", 6),
]

# (data-filter-field, header label, column index)
_FILTER_FIELDS = [
    ("strain", "Strain", 3),
    ("replicate", "Replicate", 4),
    ("nocodazoleArrest", "Nocodazole Arrest", 5),
    ("timepoint", "Timepoint", 6),
]


def _read_col(page, field, col_index):
    if field == "name":
        return page.eval_on_selector_all(".filename_cell", "els => els.map(e => e.textContent.trim())")
    return table_values(page, col_index)


def _sort_test(ctx: TestContext, field: str, label: str, col_index: int):
    """Verify sort toggles by clicking three times: 1→2→3 where order[3]==order[1]."""
    group = "Filtering"
    page = ctx.page

    # Strain/Replicate/Nocodazole Arrest/Timepoint only exist once the filename
    # metadata wizard has been applied (see configure_default_metadata_wizard_columns
    # in tests_io.py); guard against that not having happened rather than hanging
    # on a locator that will never resolve.
    if page.locator(f".th_sort[data-sort-field='{field}']").count() == 0:
        ctx.warn(group, f"{label} column sort toggles ascending/descending",
                 f"Column {field!r} not present in the table (metadata wizard may not have applied)")
        return

    # Click the label part of the sort button (left edge) to avoid accidentally
    # hitting the sort-direction arrows on the right, which set rather than toggle.
    btn = page.locator(f".th_sort[data-sort-field='{field}']").first
    btn.click(position={"x": 4, "y": 8})
    wait_briefly(0.25)
    first = _read_col(page, field, col_index)

    btn.click(position={"x": 4, "y": 8})
    wait_briefly(0.25)
    second = _read_col(page, field, col_index)

    btn.click(position={"x": 4, "y": 8})
    wait_briefly(0.25)
    third = _read_col(page, field, col_index)

    # Sort toggles: first click gave one order, second click reversed it,
    # third click cycled back to match first.
    changed = first != second
    cycled = third == first
    if not changed and len(set(first)) <= 1:
        # All rows have the same value — sort cannot change the visible order; that's fine
        sample = repr(first[0]) if first else ""
        ctx.warn(group, f"{label} column sort toggles ascending/descending",
                 f"All {len(first)} rows share the same value ({sample}); no order change possible")
    else:
        ctx.check(group, f"{label} column sort toggles ascending/descending",
                  changed and cycled,
                  f"changed={changed}, cycled={cycled}, first={first[:3]}, second={second[:3]}")


def _filter_test(ctx: TestContext, field: str, label: str, col_index: int):
    """Open filter, select one value, verify visible row count, then clear and restore."""
    group = "Filtering"
    page = ctx.page
    visible_before = table_row_count(page)

    try:
        open_filter(page, label)
        wait_briefly(0.2)
        options = page.query_selector_all(f".th_filter_option[data-filter-field='{field}']")

        if not options:
            close_filter(page)
            ctx.warn(group, f"{label} filter: apply, verify, clear",
                     f"No filter options available for {field!r}")
            return

        first_value = options[0].get_attribute("value")
        set_filter_option(page, field, first_value, True)
        wait_briefly(0.3)

        visible_filtered = table_row_count(page)

        if visible_filtered < visible_before:
            ctx.check(group, f"{label} filter: apply, verify, clear",
                      True,
                      f"value={first_value!r}, {visible_before}→{visible_filtered} rows")
        else:
            # All rows matched this value — filter is valid but non-discriminating
            ctx.warn(group, f"{label} filter: apply, verify, clear",
                     f"value={first_value!r}: all {visible_before} rows match (no rows hidden)")

        # Clear the filter and verify row count restores
        set_filter_option(page, field, first_value, False)
        wait_briefly(0.3)
        ctx.check(group, f"Clearing {label} filter restores rows",
                  table_row_count(page) == visible_before,
                  f"rows={table_row_count(page)}")

    except Exception as error:
        ctx.check(group, f"{label} filter: apply, verify, clear", False, str(error))

    close_filter(page)


def test_table_filtering_sorting(ctx: TestContext):
    group = "Filtering"
    page = ctx.page

    # Sort tests for all sortable columns
    for field, label, col_index in _SORT_FIELDS:
        _sort_test(ctx, field, label, col_index)

    # Select-all / deselect-all checkbox
    if page.query_selector("#select_all_files") is not None:
        total = table_row_count(page)
        # Ensure none are checked, then select-all
        page.eval_on_selector("#select_all_files",
                               "e => { e.checked = false; e.dispatchEvent(new Event('change', { bubbles: true })); }")
        wait_briefly(0.2)
        page.click("#select_all_files")
        wait_briefly(0.3)
        all_selected = page.eval_on_selector_all(".file_table tbody .row_select",
                                                  "els => els.every(e => e.checked)")
        ctx.check(group, "Select-all checkbox selects all rows", all_selected, f"total={total}")

        page.click("#select_all_files")
        wait_briefly(0.2)
        none_selected = page.eval_on_selector_all(".file_table tbody .row_select",
                                                   "els => els.every(e => !e.checked)")
        ctx.check(group, "Deselect-all checkbox clears all rows", none_selected)
    else:
        ctx.warn(group, "Select-all checkbox selects all rows", "Select-all checkbox not found")

    # Full filter cycle for each filterable column
    for field, label, col_index in _FILTER_FIELDS:
        _filter_test(ctx, field, label, col_index)
